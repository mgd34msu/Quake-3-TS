import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

import { SourceFileHandles } from "../src/assets/file-handles.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { BotMemory, type BotMemoryAllocation } from "../src/botlib/memory.ts";
import { BotScriptSources } from "../src/botlib/script-sources.ts";
import { ZoneArena } from "../src/core/zone.ts";
import { TeamArenaUiMemory } from "../src/ui/team-arena/memory.ts";
import { ScriptLanguageError, type ScriptDiagnostic } from "../src/script/lexer.ts";
import type { ScriptMemory } from "../src/script/memory.ts";
import { ScriptGlobalDefines, type IncludeRequest, type ScriptSource } from "../src/script/preprocessor.ts";
import {
  MAX_HUD_MENU_SET_BYTES,
  MAX_UI_COLOR_RANGES,
  MAX_UI_LIST_COLUMNS,
  MAX_UI_MENU_ITEMS,
  MAX_UI_MENUS,
  MAX_UI_MULTI_CHOICES,
  MAX_UI_SCRIPT_BYTES,
  UiItemTypeCode,
  UiWindowFlag,
  UiMenuSourceParser,
  UiMenuTokenCursor,
  defaultHudMenuPlan,
  defaultUiMenuPlan,
  loadMenuDefinitions,
  type UiItemDefinition,
  type UiMenuDefinition,
  type UiMenuResolver,
  type UiMenuAssetPublication,
  type UiMenuMemoryOwnership,
  type UiMultiDefinition,
} from "../src/ui/menu.ts";

class MemoryResolver implements UiMenuResolver {
  readonly sources = new Map<string, string>();

  constructor(entries: readonly (readonly [string, string])[]) {
    for (const [path, source] of entries) this.sources.set(path, source);
  }

  resolveRoot(path: string): ScriptSource | undefined {
    return this.source(path);
  }

  resolve(request: IncludeRequest): ScriptSource | undefined {
    const relative = posix.join(posix.dirname(request.fromPath), request.requestedPath);
    const resolved = this.source(relative);
    return resolved ?? this.source(request.requestedPath);
  }

  private source(path: string): ScriptSource | undefined {
    const text = this.sources.get(path);
    return text === undefined ? undefined : { path, text };
  }
}

test("asset destinations publish each reached source assignment before later failure", async () => {
  const resolver = new MemoryResolver([["ui/set.txt", 'loadMenu { "ui/test.menu" }'],
    ["ui/test.menu", 'assetGlobalDef { font "normal" 16 fadeClamp .7 shadowColor .1 .2 .3 .4 cursor "pending" }']]);
  const events: (UiMenuAssetPublication | string)[] = [];
  const failure = new Error("registration interrupted");
  await expect(loadMenuDefinitions({ resolver, random }, { kind: "ui", setPaths: ["ui/set.txt"] }, {}, {
    registrationSink: { async register(event) {
      events.push(`register:${event.kind}:${event.reference.path}`);
      if (event.reference.path === "pending") throw failure;
    } }, assetSink: { publish(event) { events.push(event); } },
  })).rejects.toThrow(failure);
  expect(events.map(event => typeof event === "string" ? event : event.field)).toEqual([
    "register:font:normal", "textFont", "fontRegistered", "fadeClamp", "shadowColorComponent", "shadowColorComponent",
    "shadowColorComponent", "shadowColorComponent", "shadowFadeClamp", "cursorStr", "register:picture:pending",
  ]);
  const cursor = events.find(event => typeof event !== "string" && event.field === "cursorStr");
  expect(typeof cursor !== "string" && cursor?.field === "cursorStr" ? cursor.value?.read() : undefined).toBe("pending");
  expect(events).toContainEqual({ field: "shadowFadeClamp", value: Math.fround(.4) });

  const partial: UiMenuAssetPublication[] = [];
  resolver.sources.set("ui/test.menu", "assetGlobalDef { shadowColor .6 .8 invalid }");
  const stopped = await loadMenuDefinitions({ resolver, random }, { kind: "ui", setPaths: ["ui/set.txt"] }, {}, {
    assetSink: { publish(event) { partial.push(event); } },
  });
  expect(stopped.diagnostics.map(diagnostic => diagnostic.message)).toEqual(["expected float but found invalid"]);
  expect(partial).toEqual([{ field: "shadowColorComponent", component: "x", value: Math.fround(.6) },
    { field: "shadowColorComponent", component: "y", value: Math.fround(.8) }]);
});

class RetailResolver implements UiMenuResolver {
  constructor(private readonly vfs: VirtualFileSystem, private readonly synthetic = new Map<string, string>()) {}

  resolveRoot(path: string): ScriptSource | undefined {
    return this.source(path);
  }

  resolve(request: IncludeRequest): ScriptSource | undefined {
    const relative = posix.join(posix.dirname(request.fromPath), request.requestedPath);
    const resolved = this.source(relative);
    return resolved ?? this.source(request.requestedPath);
  }

  private source(path: string): ScriptSource | undefined {
    const provided = this.synthetic.get(path);
    if (provided !== undefined) return { path, text: provided };
    if (!this.vfs.has(path)) return undefined;
    return { path, text: new TextDecoder().decode(this.vfs.readSync(path)) };
  }
}

const random = Object.freeze({ nextInt: (): number => 725 });

test("text and includes are consumed synchronously before awaited media registration", async () => {
  const events: string[] = [];
  let release: (() => void) | undefined;
  const media = new Promise<void>(resolve => { release = resolve; });
  const sources = new Map([
    ["ui/set.txt", 'loadMenu { "ui/test.menu" }'],
    ["ui/test.menu", '#include "header.h"\nassetGlobalDef { cursor CURSOR }\nmenuDef { name "test" }'],
  ]);
  const resolver: UiMenuResolver = {
    resolveRoot(path) {
      events.push(`read:${path}`);
      const text = sources.get(path);
      return text === undefined ? undefined : { path, text };
    },
    resolve(request) {
      events.push(`include:${request.requestedPath}`);
      return { path: "ui/header.h", text: '#define CURSOR "ui/cursor"' };
    },
  };
  let completed = false;
  const operation = loadMenuDefinitions({ resolver, random }, { kind: "ui", setPaths: ["ui/set.txt"] }, {}, {
    registrationSink: { async register(event) { events.push(`register:${event.kind}`); await media; } },
  }).then(definitions => { completed = true; return definitions; });
  expect(events).toEqual(["read:ui/set.txt", "read:ui/test.menu", "include:header.h", "register:picture"]);
  expect(completed).toBe(false);
  if (release === undefined) throw new Error("media fixture did not initialize");
  release();
  const definitions = await operation;
  expect(completed).toBe(true);
  expect(definitions.menus[0]?.window.name).toBe("test");
  expect(definitions.registration.kind).toBe("completed");
});

async function parseMenu(source: string, memory: UiMenuMemoryOwnership = { kind: "unaccounted" }) {
  const resolver = new MemoryResolver([
    ["ui/set.txt", `{ loadMenu { "ui/test.menu" } }`],
    ["ui/test.menu", source],
  ]);
  return loadMenuDefinitions({ resolver, random }, { kind: "ui", setPaths: ["ui/set.txt"] }, {}, { memory });
}

test("menu names and executable script text retain source string-pool pointers across String_Init", async () => {
  const memory = new TeamArenaUiMemory("qvm32", () => {});
  const definitions = await parseMenu("menuDef { name AAAA onOpen { exec original } }", { kind: "qvm32", memory });
  const menu = definitions.menus[0], script = menu?.onOpen;
  if (menu === undefined || script === undefined) throw new Error("Expected parsed menu script");
  expect(menu.window.name).toBe("AAAA");
  expect(script.text).toContain("original");
  memory.initializeStrings();
  memory.stringAllocReference("ZZZZ");
  expect(menu.window.name).toBe("ZZZZ");
  memory.stringAllocReference("exec replacement");
  expect(script.text).toBe("exec replacement");
});

function multiRecord(item: UiItemDefinition | undefined): UiMultiDefinition {
  if (item?.behavior.kind !== "multi" || item.behavior.multi === undefined) throw new Error("missing multi data");
  return item.behavior.multi;
}

function multiChoices(item: UiItemDefinition) {
  const multi = multiRecord(item);
  return { stringDefinition: multi.stringDefinition, choices: Array.from({ length: multi.count }, (_, index) => ({
    label: multi.label(index), value: multi.stringDefinition ? multi.stringValue(index) : multi.numberValue(index),
  })) };
}

test("cvar before multi choices preserves the labels later written into active slots", async () => {
  const parsed = await parseMenu(`menuDef {
    itemDef { type 12 cvar strings cvarStrList { First alpha Second beta } }
    itemDef { type 12 cvar numbers cvarFloatList { First .25 Second 2 } }
    itemDef { type 12 cvarStrList { } cvar empty }
  }`);
  expect(parsed.diagnostics).toEqual([]);
  const menu = onlyMenu(parsed.menus);
  expect(menu.items.map(item => item.cvar)).toEqual(["strings", "numbers", "empty"]);
  expect(multiChoices(itemAt(menu, 0))).toEqual({ stringDefinition: true,
    choices: [{ label: "First", value: "alpha" }, { label: "Second", value: "beta" }] });
  expect(multiChoices(itemAt(menu, 1))).toEqual({ stringDefinition: false,
    choices: [{ label: "First", value: .25 }, { label: "Second", value: 2 }] });
  expect(multiChoices(itemAt(menu, 2))).toEqual({ stringDefinition: true, choices: [] });
  const overwritten = await parseMenu("menuDef { itemDef { type 12 cvarStrList { First alpha } cvar late } }");
  const overwrittenMulti = multiRecord(overwritten.menus[0]?.items[0]);
  expect(overwrittenMulti.stringValue(0)).toBe("alpha");
  expect(() => overwrittenMulti.label(0)).toThrow("non-pointer bytes");
  expect(overwrittenMulti.count).toBe(1);
});

test("numeric multi records borrow all retained values and count from their actual QVM32 allocation", async () => {
  const memory = new TeamArenaUiMemory("qvm32", () => {});
  const definitions = await parseMenu(`menuDef { itemDef { type 12
    cvarFloatList { First 3.25 Second -2 Third .1 }
    cvarStrList { Text text } cvarFloatList { }
  } }`, { kind: "qvm32", memory });
  const multi = multiRecord(definitions.menus[0]?.items[0]);
  const record = memory.borrow(544, 392);
  expect([multi.count, multi.stringDefinition]).toEqual([0, false]);
  expect([record.getInt32(384), record.getInt32(388)]).toEqual([0, 0]);
  expect([multi.numberValue(0), multi.numberValue(1), multi.numberValue(2)]).toEqual([3.25, -2, Math.fround(.1)]);
  expect([record.getFloat32(256), record.getFloat32(260), record.getFloat32(264)]).toEqual([3.25, -2, Math.fround(.1)]);
  record.setFloat32(260, 7.5);
  record.setInt32(384, 2);
  expect([multi.count, multi.numberValue(1)]).toEqual([2, 7.5]);
  memory.initializeMemory();
  const reloaded = await parseMenu("menuDef { itemDef { type 12 cvarFloatList { } } }", { kind: "qvm32", memory });
  const current = multiRecord(reloaded.menus[0]?.items[0]);
  expect([current.count, current.numberValue(0), current.numberValue(1)]).toEqual([0, 3.25, 7.5]);
  expect(multi.count).toBe(0);
  memory.initializeStrings();
  const afterStrings = await parseMenu("menuDef { itemDef { type 12 } }", { kind: "qvm32", memory });
  expect(multiRecord(afterStrings.menus[0]?.items[0]).numberValue(0)).toBe(3.25);
  memory.initializeStrings();
  await parseMenu("menuDef { itemDef { } itemDef { } }", { kind: "qvm32", memory });
  expect(current.numberValue(0)).toBe(0);
});

test("multi list parsing retains reached mode, label, numeric slot and count writes before failure", async () => {
  const cases = [
    { tail: "cvarFloatList wrong", count: 0, strings: 0, label: "Kept", value: 3.25 },
    { tail: "cvarStrList wrong", count: 0, strings: 1, label: "Kept", value: 3.25 },
    { tail: "cvarFloatList { Partial invalid }", count: 0, strings: 0, label: "Partial", value: 3.25 },
    { tail: "cvarFloatList { Partial -2 Later invalid }", count: 1, strings: 0, label: "Partial", value: -2 },
  ];
  for (const example of cases) {
    const memory = new TeamArenaUiMemory("qvm32", () => {});
    const definitions = await parseMenu(`menuDef { itemDef { type 12 cvarFloatList { Kept 3.25 } ${example.tail} } }`,
      { kind: "qvm32", memory });
    const record = memory.borrow(544, 392);
    expect(definitions.diagnostics.some(diagnostic => diagnostic.severity === "error")).toBe(true);
    expect([record.getInt32(384), record.getInt32(388), record.getString(0), record.getFloat32(256)])
      .toEqual([example.count, example.strings, example.label, example.value]);
    if (example.count === 1) expect(record.getString(4)).toBe("Later");
  }
});

test("edit records read every scalar and write paint offsets through their actual QVM32 allocation", async () => {
  const memory = new TeamArenaUiMemory("qvm32", () => {});
  const parsed = await parseMenu("menuDef { itemDef { type 4 cvarFloat value .1 -2 3.25 maxChars 18 maxPaintChars 7 } }",
    { kind: "qvm32", memory });
  const behavior = parsed.menus[0]?.items[0]?.behavior;
  if (behavior?.kind !== "edit-field") throw new Error("missing edit data");
  const edit = behavior.edit, record = memory.borrow(544, 28);
  expect([record.getFloat32(0), record.getFloat32(4), record.getFloat32(8), record.getFloat32(12),
    record.getInt32(16), record.getInt32(20), record.getInt32(24)])
    .toEqual([-2, 3.25, Math.fround(.1), 0, 18, 7, 0]);
  record.setFloat32(0, -4.5); record.setFloat32(4, 9.5); record.setFloat32(8, .3); record.setFloat32(12, 14);
  record.setInt32(16, 32); record.setInt32(20, 12); record.setInt32(24, 8);
  expect([edit.minimum, edit.maximum, edit.defaultValue, edit.range, edit.maxChars, edit.maxPaintChars, edit.paintOffset])
    .toEqual([-4.5, 9.5, Math.fround(.3), 14, 32, 12, 8]);
  edit.paintOffset = 0xffff_ffff;
  expect([edit.paintOffset, record.getInt32(24)]).toEqual([-1, -1]);
  memory.initializeMemory();
  await parseMenu("menuDef { itemDef { type 9 } }", { kind: "qvm32", memory });
  expect([edit.minimum, edit.maximum, edit.defaultValue, edit.range, edit.maxChars, edit.maxPaintChars, edit.paintOffset])
    .toEqual([0, 0, 0, 0, 0, 0, 0]);
});

test("list records retain numeric fields, column count and column cells in their actual QVM32 allocation", async () => {
  const memory = new TeamArenaUiMemory("qvm32", () => {});
  const parsed = await parseMenu(`menuDef { itemDef { type 6 elementWidth .1 elementHeight 7.5 elementType 1
    columns 2 10 20 30 40 50 60 notSelectable } }`, { kind: "qvm32", memory });
  const behavior = parsed.menus[0]?.items[0]?.behavior;
  if (behavior?.kind !== "list-box") throw new Error("missing list data");
  const list = behavior.list, record = memory.borrow(544, 232), firstColumn = list.columns[0];
  if (firstColumn === undefined) throw new Error("missing first column");
  expect([record.getFloat32(16), record.getFloat32(20), record.getInt32(24), record.getInt32(28), record.getInt32(228)])
    .toEqual([Math.fround(.1), 7.5, 1, 2, 1]);
  expect([record.getInt32(32), record.getInt32(36), record.getInt32(40),
    record.getInt32(44), record.getInt32(48), record.getInt32(52)])
    .toEqual([10, 20, 30, 40, 50, 60]);
  record.setInt32(0, 2); record.setInt32(4, 8); record.setInt32(8, 3); record.setInt32(12, 5);
  record.setFloat32(16, 32.25); record.setFloat32(20, 16.5); record.setInt32(24, 0); record.setInt32(228, 0);
  record.setInt32(32, -2); record.setInt32(36, 120); record.setInt32(40, 80); record.setInt32(28, 1);
  expect([list.startPosition, list.endPosition, list.drawPadding, list.cursorPosition,
    list.elementWidth, list.elementHeight, list.elementStyle, list.notSelectable])
    .toEqual([2, 8, 3, 5, 32.25, 16.5, 0, false]);
  expect(list.columns).toEqual([{ position: -2, width: 120, maxChars: 80 }]);
  expect(firstColumn).toEqual({ position: -2, width: 120, maxChars: 80 });
  list.startPosition = 6; list.endPosition = 11; list.drawPadding = 3.75; list.cursorPosition = 9;
  expect([record.getInt32(0), record.getInt32(4), record.getInt32(8), record.getInt32(12)])
    .toEqual([6, 11, 3, 9]);
  record.setInt32(28, 16); record.setInt32(212, 160); record.setInt32(216, 24); record.setInt32(220, 3);
  expect(list.columns[15]).toEqual({ position: 160, width: 24, maxChars: 3 });
  memory.initializeMemory();
  await parseMenu("menuDef { itemDef { type 6 } }", { kind: "qvm32", memory });
  expect([list.startPosition, list.endPosition, list.drawPadding, list.cursorPosition, list.columns.length]).toEqual([0, 0, 0, 0, 0]);
  expect(firstColumn).toEqual({ position: 0, width: 0, maxChars: 0 });
});

test("list column parsing publishes count and each completed triple before failure without clearing inactive cells", async () => {
  const memory = new TeamArenaUiMemory("qvm32", () => {});
  const parsed = await parseMenu(`menuDef { itemDef { type 6 columns 2 10 20 30 40 50 60
    columns 2 1 2 3 4 invalid } }`, { kind: "qvm32", memory });
  const record = memory.borrow(544, 232);
  expect(parsed.diagnostics.some(diagnostic => diagnostic.severity === "error")).toBe(true);
  expect([record.getInt32(28), record.getInt32(32), record.getInt32(36), record.getInt32(40),
    record.getInt32(44), record.getInt32(48), record.getInt32(52)])
    .toEqual([2, 1, 2, 3, 40, 50, 60]);
  memory.initializeMemory();
  const negative = await parseMenu("menuDef { itemDef { type 6 columns 1 8 9 10 columns -2 } }", { kind: "qvm32", memory });
  const behavior = negative.menus[0]?.items[0]?.behavior;
  if (behavior?.kind !== "list-box") throw new Error("missing list data");
  expect(negative.diagnostics).toEqual([]);
  expect(behavior.list.columns).toEqual([]);
  expect([record.getInt32(28), record.getInt32(32), record.getInt32(36), record.getInt32(40)])
    .toEqual([-2, 8, 9, 10]);
});

test("successful list item parsing initializes retained control positions while preserving draw padding", async () => {
  for (const fail of [false, true]) {
    const memory = new TeamArenaUiMemory("qvm32", () => {}), record = memory.borrow(544, 232);
    const parser = new UiMenuSourceParser({ resolver: new MemoryResolver([]), random }, {}, {
      memory: { kind: "qvm32", memory },
      registrationSink: { async register() {
        record.setInt32(0, 5); record.setInt32(4, 6); record.setInt32(8, 7); record.setInt32(12, 8);
      } },
    });
    await parser.parseSource({ path: "list.menu", text:
      `menuDef { itemDef { type 6 asset_shader shader ${fail ? "elementHeight invalid" : ""} } }` });
    expect([record.getInt32(0), record.getInt32(4), record.getInt32(8), record.getInt32(12)])
      .toEqual(fail ? [5, 6, 7, 8] : [0, 0, 7, 0]);
  }
});

test("model records preserve reused bytes and expose live scalar and origin views without clearing their allocation", async () => {
  const memory = new TeamArenaUiMemory("qvm32", () => {}), record = memory.borrow(544, 32);
  record.setInt32(0, 123); record.setFloat32(4, .1); record.setFloat32(8, -2); record.setFloat32(12, 3.25);
  record.setFloat32(16, 64); record.setFloat32(20, 48); record.setInt32(24, 9); record.setInt32(28, 77);
  const parsed = await parseMenu("menuDef { itemDef { type 7 } }", { kind: "qvm32", memory });
  const behavior = parsed.menus[0]?.items[0]?.behavior;
  if (behavior?.kind !== "model" || behavior.model === undefined) throw new Error("missing model data");
  const model = behavior.model, origin = model.origin;
  expect(model).toEqual({ angle: 123, origin: { x: Math.fround(.1), y: -2, z: 3.25 },
    fieldOfViewX: 64, fieldOfViewY: 48, rotationSpeed: 9 });
  model.angle = 0xffff_ffff;
  expect(record.getInt32(0)).toBe(-1);
  record.setInt32(0, 45); record.setFloat32(4, 7.5); record.setFloat32(8, 8.5); record.setFloat32(12, 9.5);
  record.setFloat32(16, 90); record.setFloat32(20, 60); record.setInt32(24, 20);
  expect([model.angle, model.fieldOfViewX, model.fieldOfViewY, model.rotationSpeed]).toEqual([45, 90, 60, 20]);
  expect(origin).toEqual({ x: 7.5, y: 8.5, z: 9.5 });
  memory.initializeMemory();
  await parseMenu("menuDef { itemDef { type 7 model_fovx 75 } }", { kind: "qvm32", memory });
  expect(model).toEqual({ angle: 45, origin: { x: 7.5, y: 8.5, z: 9.5 }, fieldOfViewX: 75, fieldOfViewY: 60, rotationSpeed: 20 });
  expect(record.getInt32(28)).toBe(77);
  memory.initializeMemory();
  await parseMenu("menuDef { itemDef { } itemDef { } }", { kind: "qvm32", memory });
  expect(model).toEqual({ angle: 0, origin: { x: 0, y: 0, z: 0 }, fieldOfViewX: 0, fieldOfViewY: 0, rotationSpeed: 0 });
});

test("model origin parsing retains each reached float32 component before failure", async () => {
  const memory = new TeamArenaUiMemory("qvm32", () => {}), record = memory.borrow(544, 28);
  record.setInt32(0, 17); record.setFloat32(4, 1); record.setFloat32(8, 2); record.setFloat32(12, 3);
  const parsed = await parseMenu("menuDef { itemDef { type 7 model_origin .1 -4.5 invalid } }", { kind: "qvm32", memory });
  expect(parsed.diagnostics.some(diagnostic => diagnostic.severity === "error")).toBe(true);
  expect([record.getInt32(0), record.getFloat32(4), record.getFloat32(8), record.getFloat32(12)])
    .toEqual([17, Math.fround(.1), -4.5, 3]);
});

test("source item and edit or list initialization clear reused bytes without clearing allocation padding", async () => {
  for (const [type, size] of [[4, 28], [6, 232]]) {
    if (type === undefined || size === undefined) throw new Error("missing type allocation");
    const memory = new TeamArenaUiMemory("qvm32", () => {});
    const item = memory.borrow(0, 544), data = memory.borrow(544, (size + 15) & ~15);
    item.setFloat32(256, 3.25); item.setFloat32(540, 7.5);
    data.setFloat32(0, -2); data.setString(4, "old"); data.setFloat32(size, 9.5);
    await parseMenu(`menuDef { itemDef { type ${type} } }`, { kind: "qvm32", memory });
    expect([item.getFloat32(256), item.getFloat32(540), data.getFloat32(0), data.getString(4), data.getFloat32(size)])
      .toEqual([0, 7.5, 0, undefined, 9.5]);
    if (type === 4) expect(data.getInt32(20)).toBe(256);
  }
});

test("window, item and static menu fields read and write their actual QVM32 record words", async () => {
  const memory = new TeamArenaUiMemory("qvm32", () => {});
  const parsed = await parseMenu(`assetGlobalDef { fadeAmount .125 fadeClamp .75 fadeCycle 90 }
    menuDef { rect 10 20 300 200 border 1 borderSize 2
      itemDef { type 4 rect 3 4 50 60 border 1 borderSize 1.5 addColorRange 2 9 .1 .2 .3 .4 }
    } menuDef { }`, { kind: "qvm32", memory });
  const menu = parsed.menus[0], next = parsed.menus[1], item = menu?.itemAt(0);
  if (menu === undefined || next === undefined || item?.allocationOffset === undefined) throw new Error("missing retained records");
  const record = memory.borrow(item.allocationOffset, 540), menuRecord = memory.menuRecord(0);
  expect([menu.sourceIndex, next.sourceIndex, memory.menuRecord(1).offset, memory.allocatedBytes]).toEqual([0, 1, 644, 576]);
  expect([menuRecord.getInt32(44), menuRecord.getFloat32(64), menuRecord.getInt32(188), menuRecord.getInt32(192),
    menuRecord.getInt32(196), menuRecord.getInt32(200), menuRecord.getFloat32(204), menuRecord.getFloat32(208)])
    .toEqual([-1, 2, 1, 0, -1, 90, .75, .125]);
  expect([record.getFloat32(0), record.getFloat32(4), record.getFloat32(8), record.getFloat32(12),
    record.getFloat32(180), record.getFloat32(184), record.getFloat32(188), record.getFloat32(192), record.getFloat32(216)])
    .toEqual([16.5, 27.5, 50, 60, 0, 0, 0, 0, Math.fround(.55)]);
  expect(record.getMenu(228)?.sourceIndex).toBe(0);
  expect(menuRecord.getItem(260)).toBe(item);
  expect(record.getAllocationPointer(536)?.offset).toBe(544);
  const numeric: readonly (readonly [number, () => number])[] = [
    [44, () => item.window.cinematicHandle], [48, () => item.window.style], [52, () => item.window.border],
    [56, () => item.window.ownerDraw], [60, () => item.window.ownerDrawFlags], [68, () => item.window.flags],
    [104, () => item.window.offsetTime], [108, () => item.window.nextTime], [196, () => item.type],
    [200, () => item.alignment], [204, () => item.textAlignment], [220, () => item.textStyle],
    [276, () => item.cvarFlags], [532, () => item.cursorPosition],
  ];
  for (const [offset, read] of numeric) { record.setInt32(offset, offset + 7); expect(read()).toBe(offset + 7); }
  const floating: readonly (readonly [number, () => number])[] = [
    [0, () => item.window.rect.x], [4, () => item.window.rect.y], [8, () => item.window.rect.width], [12, () => item.window.rect.height],
    [16, () => item.window.clientRect.x], [20, () => item.window.clientRect.y], [24, () => item.window.clientRect.width], [28, () => item.window.clientRect.height],
    [64, () => item.window.borderSize], [72, () => item.window.rectEffects.x], [76, () => item.window.rectEffects.y],
    [80, () => item.window.rectEffects.width], [84, () => item.window.rectEffects.height],
    [88, () => item.window.rectEffects2.x], [92, () => item.window.rectEffects2.y], [96, () => item.window.rectEffects2.width], [100, () => item.window.rectEffects2.height],
    [112, () => item.window.foreColor.x], [116, () => item.window.foreColor.y], [120, () => item.window.foreColor.z], [124, () => item.window.foreColor.w],
    [128, () => item.window.backColor.x], [132, () => item.window.backColor.y], [136, () => item.window.backColor.z], [140, () => item.window.backColor.w],
    [144, () => item.window.borderColor.x], [148, () => item.window.borderColor.y], [152, () => item.window.borderColor.z], [156, () => item.window.borderColor.w],
    [160, () => item.window.outlineColor.x], [164, () => item.window.outlineColor.y], [168, () => item.window.outlineColor.z], [172, () => item.window.outlineColor.w],
    [180, () => item.textRect.x], [184, () => item.textRect.y], [188, () => item.textRect.width], [192, () => item.textRect.height],
    [208, () => item.textAlignX], [212, () => item.textAlignY], [216, () => item.textScale], [528, () => item.special],
  ];
  for (const [offset, read] of floating) { record.setFloat32(offset, offset + .5); expect(read()).toBe(offset + .5); }
  record.setInt32(196, 7);
  expect(item.behavior.kind).toBe("model");
  record.setInt32(196, 4);
  expect(item.behavior.kind).toBe("edit-field");
  item.window.rectEffects.x = -4; item.window.foreColor.w = .375; item.textRect.width = 45;
  item.cursorPosition = 0x80000001; item.special = .3; item.window.cinematicHandle = 6;
  expect([record.getFloat32(72), record.getFloat32(124), record.getFloat32(188), record.getInt32(532),
    record.getFloat32(528), record.getInt32(44)]).toEqual([-4, .375, 45, -2147483647, Math.fround(.3), 6]);
  const range = item.colorRanges[0];
  if (range === undefined) throw new Error("missing retained color range");
  record.setFloat32(288, .5); record.setFloat32(304, -9); record.setFloat32(308, 14);
  expect([range.color.x, range.low, range.high]).toEqual([.5, -9, 14]);
  record.setInt32(284, 0);
  expect(item.colorRanges).toHaveLength(0);
  record.setMenu(228, next);
  expect(item.parent?.sourceIndex).toBe(1);
  menu.cursorItem = 0x80000000;
  menuRecord.setFloat32(228, .25); menuRecord.setFloat32(244, .5); menuRecord.setInt32(192, 9);
  expect([menuRecord.getInt32(196), menu.focusColor.x, menu.disableColor.x, menu.fontIndex]).toEqual([-2147483648, .25, .5, 9]);
  menuRecord.setInt32(188, 0);
  expect(menu.items).toHaveLength(0);
  expect(menu.itemAt(0)).toBe(item);
});

test("static menus retain bytes across allocator resets and Menu_Init clears only its selected slot before parsing", async () => {
  const memory = new TeamArenaUiMemory("qvm32", () => {});
  const definitions = await parseMenu("menuDef { name old rect 1 2 3 4 } menuDef { name untouched }", { kind: "qvm32", memory });
  const old = definitions.menus[0], untouched = definitions.menus[1];
  if (old === undefined || untouched === undefined) throw new Error("missing static menu definitions");
  const record = memory.menuRecord(0);
  record.setInt32(640, 77); record.setFloat32(80, 18); old.window.flags = UiWindowFlag.HasFocus;
  memory.initializeMemory();
  expect([old.window.name, record.getInt32(640), old.window.rectEffects.width]).toEqual(["old", 77, 18]);
  memory.initializeStrings();
  expect([old.window.name, record.getInt32(640), old.window.flags]).toEqual(["old", 77, UiWindowFlag.HasFocus]);
  const failed = await parseMenu("assetGlobalDef { fadeAmount .25 fadeClamp .5 fadeCycle 23 } menuDef invalid", { kind: "qvm32", memory });
  expect(failed.menus).toHaveLength(0);
  expect([old.window.name, old.window.rect.x, old.window.rectEffects.width, old.window.flags, old.window.cinematicHandle,
    old.window.borderSize, old.window.foreColor.w, old.cursorItem, old.fadeCycle, old.fadeClamp, old.fadeAmount, record.getInt32(640)])
    .toEqual([undefined, 0, 0, 0, -1, 1, 1, -1, 23, .5, .25, 0]);
  expect(untouched.window.name).toBe("untouched");
  expect(memory.allocatedBytes).toBe(0);
});

test("partial menu and item rectangles and colors retain only reached component writes", async () => {
  for (const [keyword, itemField, offset] of [
    ["rect", false, 0], ["foreColor", false, 112], ["focusColor", false, 228],
    ["rect", true, 16], ["foreColor", true, 112],
  ] satisfies readonly (readonly [string, boolean, number])[]) {
    const memory = new TeamArenaUiMemory("qvm32", () => {});
    const source = itemField ? `menuDef { itemDef { ${keyword} 2 3 4 5 ${keyword} 9 8 invalid } }`
      : `menuDef { ${keyword} 2 3 4 5 ${keyword} 9 8 invalid }`;
    const parsed = await parseMenu(source, { kind: "qvm32", memory });
    const record = itemField ? memory.borrow(0, 540) : memory.menuRecord(0);
    expect(parsed.menus).toHaveLength(0);
    expect([record.getFloat32(offset), record.getFloat32(offset + 4), record.getFloat32(offset + 8), record.getFloat32(offset + 12)])
      .toEqual([9, 8, 4, 5]);
    if (keyword === "foreColor") expect(record.getInt32(68) & UiWindowFlag.ForeColorSet).toBe(UiWindowFlag.ForeColorSet);
    if (itemField) expect(memory.menuRecord(0).getItem(260)?.parent).toBeUndefined();
  }
  const memory = new TeamArenaUiMemory("qvm32", () => {});
  await parseMenu("menuDef { foreColor .2 .3 invalid }", { kind: "qvm32", memory });
  expect(memory.menuRecord(0).getInt32(68) & UiWindowFlag.ForeColorSet).toBe(UiWindowFlag.ForeColorSet);
  await parseMenu("menuDef { itemDef { foreColor .2 .3 invalid } }", { kind: "qvm32", memory });
  expect(memory.menuRecord(0).getItem(260)?.window.flags).toBe(UiWindowFlag.ForeColorSet);
  await parseMenu("menuDef { foreColor invalid }", { kind: "qvm32", memory });
  expect(memory.menuRecord(0).getInt32(68) & UiWindowFlag.ForeColorSet).toBe(0);
});

test("media registration observes the published item pointer and prior resource until the reached return assignment", async () => {
  const memory = new TeamArenaUiMemory("qvm32", () => {}), record = memory.menuRecord(0);
  const failure = new Error("model registration aborted");
  const observed: (readonly [string | null, number, UiMenuDefinition | undefined, number | undefined,
    string | null | undefined, number | undefined, number, number])[] = [];
  const parser = new UiMenuSourceParser({ resolver: new MemoryResolver([]), random }, {}, {
    memory: { kind: "qvm32", memory }, registrationSink: { async register(event) {
      const item = record.getItem(260);
      if (item?.allocationOffset === undefined) throw new Error("item pointer must be published before registration");
      observed.push([event.reference.path, record.getInt32(188), item.parent, item.assetHandle, item.asset?.path,
        item.modelData()?.angle, item.window.rect.width, item.window.clientRect.width]);
      if (event.reference.path === "new") throw failure;
      return { handle: 41 };
    } },
  });
  await expect(parser.parseSource({ path: "ui/abort.menu", text:
    "menuDef { itemDef { type 7 rect 1 2 30 40 asset_model old special .25 asset_model new } }" })).rejects.toThrow(failure);
  expect(observed).toEqual([["old", 0, undefined, 0, undefined, 0, 0, 30], ["new", 0, undefined, 41, "old", 5, 0, 30]]);
  const item = record.getItem(260);
  expect([record.getInt32(188), item?.parent, item?.assetHandle, item?.asset?.path, item?.modelData()?.angle, item?.special])
    .toEqual([0, undefined, 41, "old", 5, .25]);
});

test("completed item publication rereads the retained member and postparse preserves text rectangle origins", async () => {
  const memory = new TeamArenaUiMemory("qvm32", () => {}), menus: UiMenuDefinition[] = [];
  const parser = new UiMenuSourceParser({ resolver: new MemoryResolver([]), random }, {}, {
    memory: { kind: "qvm32", memory }, menuSink: { menuCount() { return menus.length; }, async publish(menu) { menus.push(menu); } },
    registrationSink: { async register() {
      const menu = memory.menuRecord(0), first = menu.getItem(260), second = menu.getItem(264);
      if (first === undefined || second?.allocationOffset === undefined) throw new Error("missing reached menu members");
      expect([menu.getInt32(188), first.parent?.sourceIndex, second.parent]).toEqual([1, 0, undefined]);
      memory.borrow(second.allocationOffset, 540).setFloat32(180, 77);
      second.textRect.y = 88; second.textRect.width = 99; second.textRect.height = 111;
      menu.setItem(264, first);
      return { handle: 52 };
    } },
  });
  await parser.parseSource({ path: "ui/members.menu", text:
    "menuDef { rect 10 20 200 100 itemDef { rect 1 2 30 40 } itemDef { rect 3 4 50 60 background image } }" });
  const menu = menus[0], first = menu?.itemAt(0), second = memory.borrow(544, 540);
  if (menu === undefined || first === undefined) throw new Error("missing completed menu");
  expect([menu.itemCount, menu.itemAt(1), first.parent?.sourceIndex]).toEqual([2, first, 0]);
  expect(first.window.rect).toEqual({ x: 11, y: 22, width: 30, height: 40 });
  expect([second.getResourceHandle(176), second.getMenu(228), second.getFloat32(0), second.getFloat32(180),
    second.getFloat32(184), second.getFloat32(188), second.getFloat32(192)]).toEqual([52, undefined, 0, 77, 88, 99, 111]);
  memory.initializeStrings();
  const positions = new UiMenuSourceParser({ resolver: new MemoryResolver([]), random }, {}, {
    memory: { kind: "qvm32", memory }, registrationSink: { async register() {
      const item = memory.menuRecord(0).getItem(260);
      if (item === undefined) throw new Error("missing positioning item");
      item.textRect = { x: 77, y: 88, width: 99, height: 111 };
      return { handle: 1 };
    } },
  });
  await positions.parseSource({ path: "ui/positions.menu", text: "menuDef { itemDef { background image } }" });
  expect(memory.menuRecord(0).getItem(260)?.textRect).toEqual({ x: 77, y: 88, width: 0, height: 0 });
});

test("reentrant Menu_New parsing resumes through the same static record after its nested initialization", async () => {
  const memory = new TeamArenaUiMemory("qvm32", () => {}), menus: UiMenuDefinition[] = [];
  const menuSink = { menuCount() { return menus.length; }, async publish(menu: UiMenuDefinition) { menus.push(menu); } };
  const nested = new UiMenuSourceParser({ resolver: new MemoryResolver([]), random }, {}, {
    memory: { kind: "qvm32", memory }, menuSink,
  });
  const outer = new UiMenuSourceParser({ resolver: new MemoryResolver([]), random }, {}, {
    memory: { kind: "qvm32", memory }, menuSink, registrationSink: { async register() {
      expect(memory.menuRecord(0).getString(32)).toBe("outer");
      await nested.parseSource({ path: "ui/inner.menu", text: "menuDef { name inner rect 1 2 3 4 itemDef { rect 5 6 7 8 } }" });
      expect(menus[0]?.window.rect).toEqual({ x: 1, y: 2, width: 3, height: 4 });
      return { handle: 64 };
    } },
  });
  await outer.parseSource({ path: "ui/outer.menu", text:
    "menuDef { name outer background image rect 10 20 30 40 itemDef { rect 9 8 7 6 } }" });
  const inner = menus[0], resumed = menus[1];
  if (inner === undefined || resumed === undefined) throw new Error("missing reentrant menu publications");
  expect([inner.sourceIndex, resumed.sourceIndex, inner.window.name, resumed.window.name, inner.itemCount, resumed.itemCount])
    .toEqual([0, 1, "inner", undefined, 2, 0]);
  expect([inner.window.backgroundHandle, resumed.window.backgroundHandle]).toEqual([64, 0]);
  expect(inner.itemAt(0)?.window.rect).toEqual({ x: 15, y: 26, width: 7, height: 8 });
  expect(inner.itemAt(1)?.window.rect).toEqual({ x: 19, y: 28, width: 7, height: 6 });
  expect(memory.menuRecord(1).getInt32(44)).toBe(0);
});

test("type validation tests retained pointer nullness without decoding an unreached pointee", async () => {
  for (const pointer of ["string", "numeric"]) {
    const memory = new TeamArenaUiMemory("qvm32", () => {});
    const parser = new UiMenuSourceParser({ resolver: new MemoryResolver([]), random }, {}, {
      memory: { kind: "qvm32", memory }, registrationSink: { async register() {
        const record = memory.borrow(0, 540);
        if (pointer === "string") record.setString(536, "retained");
        else record.setInt32(536, 17);
        return { handle: 1 };
      } },
    });
    await parser.parseSource({ path: "ui/pointer.menu", text: "menuDef { itemDef { background image type 99 notselectable } }" });
    const record = memory.menuRecord(0), item = record.getItem(260);
    expect([record.getInt32(188), item?.type, memory.borrow(0, 540).isNullPointer(536)]).toEqual([1, 99, false]);
    expect(() => item?.editData()).toThrow(pointer === "string" ? "different typed pointer" : "non-pointer bytes");
  }
});

test("parser charges QVM32 item and type data once, retaining its real string pool across loads", async () => {
  const pool = new TeamArenaUiMemory("qvm32", () => {});
  const allocations: number[] = [];
  const memory: UiMenuMemoryOwnership = { kind: "qvm32", memory: {
    allocate(size) { allocations.push(size); return pool.allocate(size); },
    borrow(offset, size) { return pool.borrow(offset, size); },
    menuRecord(index) { return pool.menuRecord(index); },
    stringAlloc(text) { return pool.stringAlloc(text); },
    stringAllocReference(text) { return pool.stringAllocReference(text); },
  } };
  await parseMenu("menuDef {}", memory);
  expect(pool.allocatedBytes).toBe(0);
  const source = `menuDef { name root
    itemDef { name a type 0 type 4 cvar a }
    itemDef { type 6 } itemDef { type 7 }
    itemDef { type 12 cvarStrList { A alpha B beta } }
  }`;
  const definitions = await parseMenu(source, memory);
  expect(definitions.memory).toBe(memory);
  expect(allocations).toEqual([540, 28, 540, 232, 540, 28, 540, 392]);
  expect(pool.allocatedBytes).toBe(2976);
  expect(pool.stringBytes).toBe(22);
  await parseMenu(source, memory);
  expect(pool.allocatedBytes).toBe(5856);
  expect(pool.stringBytes).toBe(22);
});

test("failed parses retain reached item, label and whole-script allocations", async () => {
  for (const [source, allocated, strings] of [
    ["menuDef { itemDef wrong }", 544, 0],
    ["assetGlobalDef { font pending invalid }", 16, 8],
    ["menuDef { itemDef { type 12 cvarStrList { orphan } } }", 960, 7],
    ["menuDef { itemDef { type 12 cvarFloatList { label invalid } } }", 960, 6],
    ["menuDef { itemDef { action { setcvar x y", 544, 0],
  ] satisfies readonly (readonly [string, number, number])[]) {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    const definitions = await parseMenu(source, { kind: "qvm32", memory: pool });
    expect(definitions.menus).toHaveLength(source.includes("orphan") ? 1 : 0);
    expect(pool.allocatedBytes).toBe(allocated);
    expect(pool.stringBytes).toBe(strings);
  }
});

test("successful NULL strings and uninitialized NULL model/multi destinations are distinct from parse failure", async () => {
  const pool = new TeamArenaUiMemory("qvm32", () => {});
  pool.stringAlloc("x".repeat(384 * 1024 - 2));
  const definitions = await parseMenu(`menuDef { name absent itemDef { name missing text missing
    onFocus { setcvar x y } cvarTest condition showCvar { yes } type 12 cvarStrList { label value }
  } }`, { kind: "qvm32", memory: pool });
  const item = definitions.menus[0]?.items[0];
  expect(definitions.menus[0]?.window.name).toBeUndefined();
  expect(item?.text).toBeUndefined();
  expect(item?.onFocus).toBeUndefined();
  expect(item?.cvarRule?.script).toBeUndefined();
  const multi = multiRecord(item);
  expect([multi.count, multi.stringDefinition, multi.label(0), multi.stringValue(0)]).toEqual([1, true, undefined, undefined]);
  for (const type of [7, 12]) {
    const allocationPool = new TeamArenaUiMemory("qvm32", () => {});
    allocationPool.allocate(1024 * 1024 - 544);
    const parsed = await parseMenu(`menuDef { itemDef { type ${type} } }`, { kind: "qvm32", memory: allocationPool });
    const behavior = parsed.menus[0]?.items[0]?.behavior;
    if (behavior?.kind === "model") expect(behavior.model).toBeUndefined();
    else if (behavior?.kind === "multi") expect(behavior.multi).toBeUndefined();
    else throw new Error("expected nullable type data");
    expect(allocationPool.outOfMemory).toBe(true);
  }
  for (const type of [4, 6]) {
    const allocationPool = new TeamArenaUiMemory("qvm32", () => {});
    allocationPool.allocate(1024 * 1024 - 544);
    await expect(parseMenu(`menuDef { itemDef { type ${type} } }`, { kind: "qvm32", memory: allocationPool }))
      .rejects.toThrow("memset");
  }
});

async function parseHud(source: string) {
  const resolver = new MemoryResolver([
    ["ui/hud.txt", `{ loadMenu { "ui/test.menu" } }`],
    ["ui/test.menu", source],
  ]);
  return loadMenuDefinitions({ resolver, random }, { kind: "hud", setPath: "ui/hud.txt" });
}

test("incremental menu publication retains completed menus and reached assets before a later parse failure", async () => {
  const memory = new TeamArenaUiMemory("qvm32", () => {}), menus: UiMenuDefinition[] = [], publications: UiMenuAssetPublication[] = [];
  const registrations: (string | null)[] = [], diagnostics: ScriptDiagnostic[] = [];
  const parser = new UiMenuSourceParser({ resolver: new MemoryResolver([]), random }, {}, {
    memory: { kind: "qvm32", memory },
    reportDiagnostic(diagnostic) { diagnostics.push(diagnostic); },
    registrationSink: { async register(event) { registrations.push(event.reference.path); } },
    assetSink: { publish(event) { publications.push(event); } },
    menuSink: { menuCount: () => menus.length, async publish(menu) { menus.push(menu); } },
  });
  await parser.parseSource({ path: "first.menu", text: "assetGlobalDef { fadeClamp .3 } menuDef { name first itemDef { text first } }" });
  await parser.parseSource({ path: "second.menu", text:
    "assetGlobalDef { gradientbar white fadeClamp .7 } menuDef { name second } menuDef { rect invalid }" });
  expect(menus.map(menu => menu.window.name)).toEqual(["first", "second"]);
  expect(menus.map(menu => menu.fadeClamp)).toEqual([Math.fround(.3), Math.fround(.7)]);
  expect(registrations).toEqual(["white"]);
  expect(publications).toContainEqual({ field: "fadeClamp", value: Math.fround(.7) });
  expect(diagnostics.map(diagnostic => diagnostic.message)).toEqual(["expected float but found invalid", "couldn't parse menu keyword rect"]);
  expect(memory.allocatedBytes).toBeGreaterThan(544);
});

test("reached lexical and preprocessor failures retain completed menu and asset publication", async () => {
  for (const suffix of ['"unterminated', "#error stopped", '#include "missing.h"']) {
    const events: string[] = [], menus: UiMenuDefinition[] = [];
    const parser = new UiMenuSourceParser({ resolver: new MemoryResolver([]), random }, {
      report: diagnostic => { events.push(`preprocessor:${diagnostic.message}`); },
    }, {
      registrationSink: { async register(event) {
        events.push(`register:${event.reference.path}`);
        await Promise.resolve();
        events.push("registered");
      } },
      assetSink: { publish(event) { events.push(`asset:${event.field}`); } },
      menuSink: { menuCount: () => menus.length, async publish(menu) { menus.push(menu); events.push("menu"); } },
      reportDiagnostic: diagnostic => { events.push(`diagnostic:${diagnostic.message}`); },
    });
    await parser.parseSource({ path: "late.menu", text:
      `assetGlobalDef { gradientbar white fadeClamp .7 } menuDef { name ready }\n${suffix}` });
    expect(menus.map(menu => menu.window.name)).toEqual(["ready"]);
    expect(events.slice(0, 5)).toEqual(["register:white", "registered", "asset:gradientBar", "asset:fadeClamp", "menu"]);
    expect(events).toHaveLength(7);
    expect(events[5]?.startsWith("preprocessor:")).toBe(true);
    expect(events[6]).toBe(events[5]?.replace("preprocessor:", "diagnostic:"));
  }
});

test("later includes resolve only after awaited registration and completed menu publication", async () => {
  const events: string[] = [], menus: UiMenuDefinition[] = [];
  let release: (() => void) | undefined;
  const registered = new Promise<void>(resolve => { release = resolve; });
  const resolver: UiMenuResolver = {
    resolveRoot: () => undefined,
    resolve(request) {
      events.push(`include:${request.requestedPath}`);
      return { path: request.requestedPath, text: "menuDef { name included }" };
    },
  };
  const parser = new UiMenuSourceParser({ resolver, random }, {}, {
    registrationSink: { async register() { events.push("register"); await registered; events.push("registered"); } },
    menuSink: { menuCount: () => menus.length, async publish(menu) { menus.push(menu); events.push(`menu:${menu.window.name}`); } },
  });
  const operation = parser.parseSource({ path: "late.menu", text:
    'assetGlobalDef { cursor pending } menuDef { name first }\n#include "later.h"' });
  expect(events).toEqual(["register"]);
  if (release === undefined) throw new Error("registration fixture did not initialize");
  release();
  await operation;
  expect(events).toEqual(["register", "registered", "menu:first", "include:later.h", "menu:included"]);
});

test("PC menu sources close at reached EOF, read failure and early brace without scanning trailing input", async () => {
  for (const suffix of ["", '\n"unterminated', '\n}\n#error unreached\n#include "unreached.h"', '\n#include "early.h"\n#error unreached']) {
    const zone = new ZoneArena(65536), owner = new BotMemory(undefined, zone);
    const allocated: BotMemoryAllocation[] = [], freed: BotMemoryAllocation[] = [];
    const memory: ScriptMemory = {
      allocate(size, kind, clear) { const allocation = owner.allocate(size, kind, clear); allocated.push(allocation); return allocation; },
      free(allocation) { freed.push(allocation); owner.free(allocation); },
    };
    const resolver = new MemoryResolver([
      ["ui/set.txt", 'loadMenu { "ui/first.menu" }'],
      ["ui/first.menu", `menuDef { name first }${suffix}`],
      ["ui/early.h", "#if 1\n}\n#error unreached"],
    ]);
    try {
      const result = await loadMenuDefinitions({ resolver, random }, { kind: "ui", setPaths: ["ui/set.txt"] }, { memory });
      expect(result.menus.map(menu => menu.window.name)).toEqual(["first"]);
      expect(result.diagnostics.map(diagnostic => diagnostic.message)).toEqual(suffix.includes("unterminated") ? ["missing trailing quote"] : []);
      expect(allocated.length).toBeGreaterThan(0);
      expect(new Set(freed)).toEqual(new Set(allocated));
      expect(freed).toHaveLength(allocated.length);
      for (const allocation of allocated) expect(() => allocation.bytes).toThrow("freed");
      zone.checkHeap();
    } finally { zone.dispose(); }
  }
});

test("aborted source callbacks preserve original errors and leave menu sources allocated", async () => {
  const diagnostic: ScriptDiagnostic = { severity: "error", message: "callback aborted", location: { path: "callback", line: 1, column: 1 } };
  for (const callback of ["preprocessor", "diagnostic", "include", "registration", "asset", "menu"]) {
    for (const failure of [new Error("callback aborted"), new ScriptLanguageError(diagnostic, [diagnostic])]) {
      const zone = new ZoneArena(65536), owner = new BotMemory(undefined, zone);
      const allocated: BotMemoryAllocation[] = [], freed: BotMemoryAllocation[] = [];
      const active = new Set<BotMemoryAllocation>();
      let aborted: { readonly live: ReadonlySet<BotMemoryAllocation>; readonly freed: number } | undefined;
      const abort = (): never => { aborted = { live: new Set(active), freed: freed.length }; throw failure; };
      const memory: ScriptMemory = {
        allocate(size, kind, clear) { const allocation = owner.allocate(size, kind, clear); allocated.push(allocation); active.add(allocation); return allocation; },
        free(allocation) { freed.push(allocation); owner.free(allocation); active.delete(allocation); },
      };
      const parser = new UiMenuSourceParser({ random, resolver: {
        resolveRoot: () => undefined,
        resolve: () => abort(),
      } }, {
        memory,
        report: () => { if (callback === "preprocessor") abort(); },
      }, {
        reportDiagnostic: () => { if (callback === "diagnostic") abort(); },
        registrationSink: { async register() { if (callback === "registration") abort(); } },
        assetSink: { publish() { if (callback === "asset") abort(); } },
        menuSink: { menuCount: () => 0, async publish() { if (callback === "menu") abort(); } },
      });
      const source = callback === "preprocessor" || callback === "diagnostic" ? "#if 1\nmenuDef { name first }"
        : callback === "include" ? 'menuDef { name first }\n#include "later.h"'
        : "assetGlobalDef { cursor pending } menuDef { name first }";
      try {
        await expect(parser.parseSource({ path: "aborted.menu", text: source })).rejects.toBe(failure);
        expect(allocated.length).toBeGreaterThan(0);
        if (aborted === undefined) throw new Error("source callback did not capture its live allocations");
        expect(freed.length).toBe(aborted.freed);
        expect(active.size).toBe(aborted.live.size);
        for (const allocation of aborted.live) {
          expect(active.has(allocation)).toBe(true);
          expect(allocation.bytes.length).toBeGreaterThan(0);
        }
        zone.checkHeap();
      } finally { zone.dispose(); }
    }
  }
});

test("Menu_New resumes at the actual failed parser position without publishing the unfinished menu", async () => {
  const result = await parseMenu(`menuDef { name first } menuDef { itemDef { rect invalid
    menuDef { name recovered } } menuDef { name unreached }`);
  expect(result.menus.map(menu => menu.window.name)).toEqual(["first", "recovered"]);
  expect(result.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
    "expected float but found invalid", "couldn't parse menu item keyword rect", "couldn't parse menu keyword itemDef",
  ]);
});

test("menu set read failures occur after reached child menus and retain the next set load", async () => {
  const resolver = new MemoryResolver([
    ["ui/first.txt", 'loadMenu { "ui/missing.menu" } loadMenu { "ui/first.menu" }\n#error stopped'],
    ["ui/second.txt", 'loadMenu { "ui/second.menu" }'],
    ["ui/first.menu", "menuDef { name first }"],
    ["ui/second.menu", "menuDef { name second }"],
  ]);
  const result = await loadMenuDefinitions({ resolver, random }, { kind: "ui", setPaths: ["ui/first.txt", "ui/second.txt"] });
  expect(result.menus.map(menu => menu.window.name)).toEqual(["first", "second"]);
  expect(result.diagnostics.map(diagnostic => diagnostic.message)).toEqual(["#error directive: stopped"]);
});

test("production menu readers share PC handles, globals, root includes and the actual zone allocator", async () => {
  const root = await mkdtemp(join(tmpdir(), "quake3-menu-handles-")), files = new SourceFileHandles();
  const zone = new ZoneArena(1024 * 1024), owner = new BotMemory(undefined, zone);
  const active = new Set<BotMemoryAllocation>(), opened: string[] = [], printed: string[] = [];
  const globalActive = new Set<BotMemoryAllocation>();
  const memory: ScriptMemory = {
    allocate(size, kind, clear) { const allocation = owner.allocate(size, kind, clear); active.add(allocation); return allocation; },
    free(allocation) { owner.free(allocation); active.delete(allocation); },
  };
  const globalMemory: ScriptMemory = {
    allocate(size, kind, clear) { const allocation = owner.allocate(size, kind, clear); active.add(allocation); globalActive.add(allocation); return allocation; },
    free(allocation) { owner.free(allocation); active.delete(allocation); globalActive.delete(allocation); },
  };
  const sources = new Map([
    ["external.pc", "CURRENT"],
    ["ui/set.txt", 'loadMenu { "ui/first.menu" } loadMenu { "ui/second.menu" }'],
    ["ui/first.menu", '#include "header.h"\nassetGlobalDef { cursor CURSOR }\nmenuDef { name CURRENT }\n#error stopped'],
    ["ui/second.menu", "menuDef { name CURRENT }"],
    ["header.h", "#define CURSOR shared_cursor"],
    ["ui/header.h", "#error invented_relative_include"],
    ["botfiles/header.h", "#error stale_base_folder"],
    ["ui/invalid.menu", '#include "invalid.h"'],
    ["invalid.h", "\n\nmenuDef { rect invalid }"],
  ]);
  let handles: BotScriptSources | undefined;
  try {
    for (const [path, text] of sources) {
      const target = join(root, "baseq3", path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text);
    }
    const vfs = await VirtualFileSystem.openTracked({ dataPath: root, homePath: root, cdPath: null, product: "baseq3",
      handles: files, references: { checksumFeed: 0, random: () => 0 } });
    const globals = new ScriptGlobalDefines(undefined, globalMemory);
    const sourceOwner = new BotScriptSources({
      openRead(path) { opened.push(path); return vfs.openRead(path); },
      readInto: (file, bytes) => vfs.readInto(file, bytes),
      closeFile: file => vfs.closeFile(file),
    }, globals, (severity, text) => { printed.push(`${severity}:${text}`); return undefined; }, text => { printed.push(text); return undefined; }, memory);
    handles = sourceOwner;
    const current = (): undefined => undefined;
    globals.add("CURRENT inherited");
    expect(sourceOwner.loadSourceHandle("external.pc")).toBe(1);
    globals.clear();
    globals.add("CURRENT first");
    sourceOwner.setBaseFolder("botfiles");
    opened.length = 0;
    const retained = new Set([...active].filter(allocation => !globalActive.has(allocation))), menus: string[] = [], diagnostics: ScriptDiagnostic[] = [];
    let release: (() => void) | undefined;
    const registration = new Promise<void>(resolve => { release = resolve; });
    const parser = new UiMenuSourceParser({ random, scriptSources: () => sourceOwner, assertCurrentOperation: current }, {}, {
      registrationSink: { async register(event) {
        expect(event.reference.path).toBe("shared_cursor");
        await registration;
      } },
      menuSink: { menuCount: () => menus.length, async publish(menu) {
        if (menu.window.name === undefined) throw new Error("expected the source menu name");
        menus.push(menu.window.name);
      } },
      reportDiagnostic: diagnostic => { diagnostics.push(diagnostic); },
    });
    const loading = parser.load({ kind: "ui", setPaths: ["ui/set.txt"] });
    expect(opened).toEqual(["ui/set.txt", "ui/first.menu", "header.h"]);
    expect(sourceOwner.sourceFileAndLine(1)?.filename).toBe("external.pc");
    expect(sourceOwner.sourceFileAndLine(2)?.filename).toBe("ui/set.txt");
    expect(sourceOwner.sourceFileAndLine(3)?.filename).toBe("ui/first.menu");
    expect(active.size).toBeGreaterThan(retained.size);
    globals.clear();
    globals.add("CURRENT second");
    if (release === undefined) throw new Error("source registration fixture did not initialize");
    release();
    await loading;
    expect(menus).toEqual(["first", "second"]);
    expect(printed).toEqual(["3:file ui/first.menu, line 4: #error directive: stopped\n"]);
    expect(diagnostics).toEqual([]);
    expect(sourceOwner.sourceFileAndLine(2)).toBeUndefined();
    expect(sourceOwner.sourceFileAndLine(3)).toBeUndefined();
    expect(active.size).toBe(retained.size + globalActive.size);
    for (const allocation of retained) expect(active.has(allocation)).toBe(true);
    for (const allocation of active) expect(retained.has(allocation) || globalActive.has(allocation)).toBe(true);
    expect(sourceOwner.readTokenHandle(1)?.token.text).toBe("inherited");
    globals.clear();
    expect(sourceOwner.freeSourceHandle(1)).toBe(true);
    expect(active.size).toBe(0);

    const invalid = UiMenuTokenCursor.openHandle("ui/invalid.menu", () => sourceOwner, current);
    if (invalid === undefined) throw new Error("expected the source invalid-menu handle");
    await parser.parseSource(invalid);
    expect(diagnostics.map(diagnostic => [diagnostic.location.path, diagnostic.location.line, diagnostic.message])).toEqual([
      ["ui/invalid.menu", 2, "expected float but found invalid"], ["ui/invalid.menu", 2, "couldn't parse menu keyword rect"],
    ]);
    expect(active.size).toBe(0);
    for (let handle = 1; handle < 64; handle++) expect(sourceOwner.loadSourceHandle("external.pc")).toBe(handle);
    const before = opened.length;
    expect(UiMenuTokenCursor.openHandle("must-not-read.pc", () => sourceOwner, current)).toBeUndefined();
    expect(opened).toHaveLength(before);
    sourceOwner.disposeResources();
    expect(active.size).toBe(0);
    zone.checkHeap();
  } finally {
    handles?.disposeResources();
    files.close();
    zone.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("production menu handle callbacks preserve exact failures and retain live sources after retirement", async () => {
  const root = await mkdtemp(join(tmpdir(), "quake3-menu-handle-aborts-")), files = new SourceFileHandles();
  const zone = new ZoneArena(65536), memory = new BotMemory(undefined, zone);
  let handles: BotScriptSources | undefined;
  try {
    await mkdir(join(root, "baseq3", "ui"), { recursive: true });
    await writeFile(join(root, "baseq3", "ui", "aborted.menu"), "menuDef { name reached }\n#error stopped");
    await writeFile(join(root, "baseq3", "ui", "registration.menu"), "assetGlobalDef { cursor pending } menuDef { name unreached }");
    await writeFile(join(root, "baseq3", "ui", "invalid.menu"), "menuDef { rect invalid }");
    const vfs = await VirtualFileSystem.openTracked({ dataPath: root, homePath: root, cdPath: null, product: "baseq3",
      handles: files, references: { checksumFeed: 0, random: () => 0 } });
    let profile = "print", callbackFailure: Error | null = null, retired: Error | null = null;
    const sourceOwner = new BotScriptSources(vfs, new ScriptGlobalDefines(), () => {
      if (profile === "print") throw callbackFailure;
      if (profile === "retire") retired = callbackFailure;
      return undefined;
    }, (_text: string): undefined => undefined, memory);
    handles = sourceOwner;
    const current = (): undefined => { if (retired !== null) throw retired; };
    const diagnostic: ScriptDiagnostic = { severity: "error", message: "callback aborted", location: { path: "callback", line: 1, column: 1 } };
    for (const callback of ["print", "retire", "registration", "parser"]) {
      for (const failure of [new Error("callback aborted"), new ScriptLanguageError(diagnostic, [diagnostic])]) {
        profile = callback; callbackFailure = failure; retired = null;
        const parser = new UiMenuSourceParser({ random, scriptSources: () => sourceOwner, assertCurrentOperation: current }, {}, {
          registrationSink: { async register() { if (profile === "registration") throw failure; } },
          reportDiagnostic: () => { if (profile === "parser") throw failure; },
        });
        const path = profile === "registration" ? "ui/registration.menu" : profile === "parser" ? "ui/invalid.menu" : "ui/aborted.menu";
        const cursor = UiMenuTokenCursor.openHandle(path, () => sourceOwner, current);
        if (cursor === undefined) throw new Error("expected the aborted source handle");
        await expect(parser.parseSource(cursor)).rejects.toBe(failure);
        expect(sourceOwner.sourceFileAndLine(1)?.filename).toBe(path);
        expect(sourceOwner.freeSourceHandle(1)).toBe(true);
        zone.checkHeap();
      }
    }
  } finally {
    handles?.disposeResources();
    files.close();
    zone.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

function onlyMenu(menus: readonly UiMenuDefinition[]): UiMenuDefinition {
  const menu = menus[0];
  if (menu === undefined || menus.length !== 1) throw new Error(`expected one menu, found ${menus.length}`);
  return menu;
}

function itemAt(menu: UiMenuDefinition, index: number): UiItemDefinition {
  const item = menu.items[index];
  if (item === undefined) throw new Error(`missing item ${index}`);
  return item;
}

function diagnosticMessages(diagnostics: readonly ScriptDiagnostic[]): readonly string[] {
  return diagnostics.map((diagnostic) => `${diagnostic.severity}:${diagnostic.message}`);
}

const ALL_KEYWORDS = `
assetGlobalDef {
  font "fonts/main" 16 smallFont "fonts/small" 12 bigFont "fonts/big" 20
  gradientbar "ui/gradient" menuEnterSound "sound/enter"
  menuExitSound "sound/exit" itemFocusSound "sound/focus" menuBuzzSound "sound/buzz"
  cursor "ui/cursor" fadeClamp .8 fadeCycle 125 fadeAmount .1
  shadowX 2 shadowY 3 shadowColor .1 .2 .3 .4
}
menuDef {
  font "fonts/menu" name "source_menu" fullscreen 0 rect 10 20 300 200 style 1
  visible 1 visible 0 onOpen { open first ; } onClose { close } onESC { escape }
  border 1 borderSize 2 backcolor .1 .2 .3 .4 forecolor .4 .5 .6 .7
  bordercolor .2 .3 .4 .5 focuscolor 1 .5 .25 1 disablecolor .1 .1 .1 .5
  outlinecolor .9 .8 .7 .6 background "ui/menu" ownerdraw 7 ownerdrawFlag 1
  ownerdrawFlag 4 outOfBoundsClick soundLoop "sound/loop" cinematic "video/intro.roq"
  popup fadeClamp .7 fadeCycle 250 fadeAmount .2
  itemDef {
    type 0 name "text_item" text "hello" group "group" asset_shader "ui/icon"
    rect 1 2 30 40 style 2 decoration wrapped autowrapped horizontalscroll
    border 1 borderSize 3 visible 1 visible 0 align 2 textalign 1 textalignx 4.5
    textaligny 5.5 textscale .55 textstyle 3 backcolor .1 .2 .3 .4
    forecolor .2 .3 .4 .5 bordercolor .3 .4 .5 .6 outlinecolor .4 .5 .6 .7
    background "ui/background" onFocus { focus ; } leaveFocus { leave }
    mouseEnter { enter } mouseExit { exit } mouseEnterText { textEnter }
    mouseExitText { textExit } action { cmd "two words" ; } special 3.5
    cvar "ui_first" maxChars 12 maxPaintChars 9 focusSound "sound/item"
    cvarFloat "ui_value" 4 1 8
    addColorRange 0 2 1 0 0 1 ownerdrawFlag 2 ownerdrawFlag 8
    enableCvar { one } disableCvar { two } showCvar { three } hideCvar { four }
    cvarTest "ui_test" cinematic "video/item.roq"
  }
  itemDef {
    type 6 name "list" notselectable elementwidth 64 elementheight 16 feeder 5.5
    elementtype 1 columns 2 0 100 12 100 80 8 doubleclick { choose ; }
  }
  itemDef {
    type 7 name "model" asset_model "models/player.md3" model_origin 1 2 3
    model_fovx 60 model_fovy 70 model_rotation 9 model_angle 45
  }
  itemDef { type 12 name "strings" cvarStrList { "Off" , "0" , "On" , "1" } }
  itemDef { type 12 name "numbers" cvarFloatList { "Low" .25 ; "High" 2 } }
  itemDef { ownerdraw 99 name "owner" }
  itemDef { type 1 } itemDef { type 2 } itemDef { type 3 } itemDef { type 4 }
  itemDef { type 5 } itemDef { type 9 } itemDef { type 10 } itemDef { type 11 }
  itemDef { type 13 }
}
`;

describe("Team Arena menu source parsing", () => {
  test("parses every global, menu, item and type-specific keyword into owned typed data", async () => {
    const parsed = await parseMenu(ALL_KEYWORDS);
    const menu = onlyMenu(parsed.menus);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.loadedFiles).toEqual(["ui/set.txt", "ui/test.menu"]);
    expect(parsed.assets).toEqual({
      textFont: { kind: "font", path: "fonts/main", pointSize: 16 },
      smallFont: { kind: "font", path: "fonts/small", pointSize: 12 },
      bigFont: { kind: "font", path: "fonts/big", pointSize: 20 },
      cursor: { kind: "shader", path: "ui/cursor" }, gradientBar: { kind: "shader", path: "ui/gradient" },
      menuEnterSound: { kind: "sound", path: "sound/enter" }, menuExitSound: { kind: "sound", path: "sound/exit" },
      menuBuzzSound: { kind: "sound", path: "sound/buzz" }, itemFocusSound: { kind: "sound", path: "sound/focus" },
      fadeClamp: Math.fround(.8), fadeCycle: 125, fadeAmount: Math.fround(.1), shadowX: 2, shadowY: 3,
      shadowColor: { x: Math.fround(.1), y: Math.fround(.2), z: Math.fround(.3), w: Math.fround(.4) },
      shadowFadeClamp: Math.fround(.4),
    });
    expect(menu.window.name).toBe("source_menu");
    expect(menu.window.rect).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    expect(menu.window.ownerDrawFlags).toBe(5);
    expect(menu.window.flags).toBe(UiWindowFlag.Visible | UiWindowFlag.ForeColorSet | UiWindowFlag.OutOfBoundsClick | UiWindowFlag.Popup);
    expect(menu.fadeClamp).toBe(Math.fround(.7));
    expect(menu.fadeCycle).toBe(250);
    expect(menu.fadeAmount).toBe(Math.fround(.2));
    expect(menu.items).toHaveLength(15);

    const text = itemAt(menu, 0);
    expect(text.window.rect).toEqual({ x: 16, y: 27, width: 30, height: 40 });
    expect(text.window.flags).toBe(UiWindowFlag.Decoration | UiWindowFlag.Wrapped | UiWindowFlag.AutoWrapped |
      UiWindowFlag.Horizontal | UiWindowFlag.Visible | UiWindowFlag.ForeColorSet);
    expect(text.asset).toEqual({ kind: "shader", path: "ui/icon" });
    expect(text.action).toEqual({ text: "\"cmd\" \"two words\" ; ", tokens: [
      { text: "cmd", location: { path: "ui/test.menu", line: 25, column: 41 } },
      { text: "two words", location: { path: "ui/test.menu", line: 25, column: 45 } },
      { text: ";", location: { path: "ui/test.menu", line: 25, column: 57 } },
    ], truncated: false });
    expect(text.cvar).toBe("ui_value");
    expect(text.cvarRule?.kind).toBe("hide");
    expect(text.window.ownerDrawFlags).toBe(10);
    expect(text.colorRanges).toEqual([{ low: 0, high: 2, color: { x: 1, y: 0, z: 0, w: 1 } }]);
    expect(text.behavior).toEqual({ kind: "text", type: UiItemTypeCode.Text,
      edit: { minimum: 1, maximum: 8, defaultValue: 4, range: 0, maxChars: 12, maxPaintChars: 9, paintOffset: 0 } });

    const list = itemAt(menu, 1);
    expect(list.behavior).toEqual({ kind: "list-box", type: UiItemTypeCode.ListBox, list: {
      startPosition: 0, endPosition: 0, drawPadding: 0, cursorPosition: 0,
      elementWidth: 64, elementHeight: 16, elementStyle: 1,
      columns: [{ position: 0, width: 100, maxChars: 12 }, { position: 100, width: 80, maxChars: 8 }],
      doubleClick: { text: "\"choose\" ; ", tokens: [
        { text: "choose", location: { path: "ui/test.menu", line: 34, column: 61 } },
        { text: ";", location: { path: "ui/test.menu", line: 34, column: 68 } },
      ], truncated: false }, notSelectable: true,
    } });
    const modeled = itemAt(menu, 2);
    expect(modeled.asset).toEqual({ kind: "model", path: "models/player.md3" });
    expect(modeled.behavior).toEqual({ kind: "model", type: UiItemTypeCode.Model,
      model: { angle: 45, origin: { x: 1, y: 2, z: 3 }, fieldOfViewX: 60, fieldOfViewY: 70, rotationSpeed: 9 } });
    expect(multiChoices(itemAt(menu, 3))).toEqual({ stringDefinition: true,
      choices: [{ label: "Off", value: "0" }, { label: "On", value: "1" }] });
    expect(multiChoices(itemAt(menu, 4))).toEqual({ stringDefinition: false,
      choices: [{ label: "Low", value: Math.fround(.25) }, { label: "High", value: 2 }] });
    expect(menu.items.map((item) => item.behavior.type)).toEqual([0, 6, 7, 12, 12, 8, 1, 2, 3, 4, 5, 9, 10, 11, 13]);
  });

  test("matches PC integer, float, defaults, repeated flags and layout behavior", async () => {
    const parsed = await parseMenu(`menuDef {
      font custom fullscreen 1.9 rect 8.5 9.5 1 1 border 1 borderSize 1.5 visible 1 visible 0
      ownerdrawFlag 1 ownerdrawFlag 4 fadeCycle 4294967295
      itemDef { type 4 rect 1 2 3 4 border 1 borderSize 2 visible 1 visible 0 cvar sample }
      itemDef { type 7 asset_model m }
    }`);
    const menu = onlyMenu(parsed.menus);
    expect(menu.fullScreen).toBe(1);
    expect(menu.window.rect).toEqual({ x: 0, y: 0, width: 640, height: 480 });
    expect(menu.window.flags & UiWindowFlag.Visible).toBe(UiWindowFlag.Visible);
    expect(menu.window.ownerDrawFlags).toBe(5);
    expect(menu.fadeCycle).toBe(-1);
    expect(parsed.assets.textFont).toEqual({ kind: "font", path: "custom", pointSize: 48 });
    expect(itemAt(menu, 0).window.rect).toEqual({ x: 4.5, y: 5.5, width: 3, height: 4 });
    expect(itemAt(menu, 0).behavior).toEqual({ kind: "edit-field", type: 4,
      edit: { minimum: -1, maximum: -1, defaultValue: -1, range: 0, maxChars: 0, maxPaintChars: 256, paintOffset: 0 } });
    const modelItem = itemAt(menu, 1);
    if (modelItem.behavior.kind !== "model") throw new Error("expected model item");
    if (modelItem.behavior.model === undefined) throw new Error("Expected allocated model data");
    expect(modelItem.behavior.model.angle).toBe(5);
  });

  test("preserves bounded list, multi, color and script source quirks", async () => {
    const columns = Array.from({ length: MAX_UI_LIST_COLUMNS }, (_, index) => `${index} 8 3`).join(" ");
    const colors = Array.from({ length: MAX_UI_COLOR_RANGES + 2 }, (_, index) => `addColorRange ${index} ${index + 1} 1 1 1 1`).join(" ");
    const strings = Array.from({ length: MAX_UI_MULTI_CHOICES }, (_, index) => `L${index} V${index}`).join(" ");
    const parsed = await parseMenu(`menuDef { itemDef { type 6 columns 20 ${columns} } itemDef {
      type 12 cvarStrList { ${strings} dangling } ${colors} action { x y }
    } }`);
    const menu = onlyMenu(parsed.menus);
    const list = itemAt(menu, 0);
    if (list.behavior.kind !== "list-box") throw new Error("expected list box");
    expect(list.behavior.list.columns).toHaveLength(MAX_UI_LIST_COLUMNS);
    const multi = itemAt(menu, 1);
    expect(multiRecord(multi).stringDefinition).toBe(true);
    expect(multiRecord(multi).count).toBe(MAX_UI_MULTI_CHOICES);
    expect(multi.colorRanges).toHaveLength(MAX_UI_COLOR_RANGES);
    expect(multi.action?.text).toBe("x y ");
  });

  test("preserves zero defaults, allocation ordering, repeated multi data and empty script tokens", async () => {
    const parsed = await parseMenu(`menuDef {
      itemDef { }
      itemDef { maxChars 15 type 4 }
      itemDef { type 4 }
      itemDef { type 12 cvarStrList { A , 1 } cvarStrList { ";ignored" B , 2 C } action { "" ; } }
      itemDef { type 99 }
    }`);
    const menu = onlyMenu(parsed.menus);
    expect(menu.cursorItem).toBe(-1);
    expect(menu.fadeAmount).toBe(0);
    expect(menu.window.borderSize).toBe(1);
    expect(menu.window.foreColor).toEqual({ x: 1, y: 1, z: 1, w: 1 });
    expect(itemAt(menu, 0).behavior).toEqual({ kind: "text", type: 0, edit: undefined });
    expect(itemAt(menu, 0).textScale).toBe(Math.fround(.55));
    expect(itemAt(menu, 1).behavior).toEqual({ kind: "edit-field", type: 4,
      edit: { minimum: 0, maximum: 0, defaultValue: 0, range: 0, maxChars: 15, maxPaintChars: 0, paintOffset: 0 } });
    expect(itemAt(menu, 2).behavior).toEqual({ kind: "edit-field", type: 4,
      edit: { minimum: 0, maximum: 0, defaultValue: 0, range: 0, maxChars: 0, maxPaintChars: 256, paintOffset: 0 } });
    const multi = itemAt(menu, 3);
    expect(multiChoices(multi)).toEqual({ stringDefinition: true, choices: [{ label: "B", value: "2" }] });
    expect(multi.action?.text).toBe(" ; ");
    expect(multi.action?.tokens.map((token) => token.text)).toEqual(["", ";"]);
    expect(itemAt(menu, 4).behavior).toEqual({ kind: "unknown", type: 99 });
    expect(parsed.diagnostics).toEqual([]);
  });

  test("preserves the distinct UI and cgame fontRegistered paths", async () => {
    const source = `assetGlobalDef { font global 16 } menuDef { font local } menuDef { font later }`;
    const ui = await parseMenu(source);
    const hud = await parseHud(source);
    expect(ui.assets.textFont).toEqual({ kind: "font", path: "global", pointSize: 16 });
    expect(hud.assets.textFont).toEqual({ kind: "font", path: "local", pointSize: 48 });
  });

  test("reports source unknown keywords but keeps parsing the containing definition", async () => {
    const parsed = await parseMenu(`assetGlobalDef { bogus } menuDef { name m unknownMenu
      itemDef { name i unknownItem text ok } }`);
    expect(onlyMenu(parsed.menus).items[0]?.text).toBe("ok");
    expect(diagnosticMessages(parsed.diagnostics)).toEqual([
      "warning:unknown asset keyword bogus",
      "error:unknown menu keyword unknownMenu",
      "error:unknown menu item keyword unknownItem",
    ]);
  });
});

describe("menu parser safety boundaries", () => {
  test("source type changes and type-specific keywords reinterpret retained data without detached kind guards", async () => {
    const parsed = await parseMenu(`menuDef {
      itemDef { elementwidth 1 }
      itemDef { model_fovx 2 }
      itemDef { type 6 elementwidth 3 type 7 }
      itemDef { asset_shader icon type 7 }
      itemDef { type 7 asset_shader other }
      itemDef { type 6 cvar value }
      itemDef { type 7 cvar value }
    }`);
    const menu = onlyMenu(parsed.menus);
    expect(parsed.diagnostics).toEqual([]);
    expect(itemAt(menu, 0).editData()?.maxChars).toBe(1065353216);
    expect(itemAt(menu, 1).editData()?.maxChars).toBe(1073741824);
    expect(itemAt(menu, 2).modelData()?.fieldOfViewX).toBe(3);
    expect([itemAt(menu, 3).type, itemAt(menu, 3).asset, itemAt(menu, 4).type, itemAt(menu, 4).asset]).toEqual([
      7, { kind: "shader", path: "icon" }, 7, { kind: "shader", path: "other" },
    ]);
    const list = itemAt(menu, 5).listData(), model = itemAt(menu, 6).modelData();
    expect([list?.startPosition, list?.endPosition, list?.drawPadding]).toEqual([0, 0, -1082130432]);
    expect([model?.angle, model?.origin.x, model?.origin.y]).toEqual([-1082130432, -1, -1]);
  });

  test("source-failing 32nd completed multi choices leave the containing menu unpublished", async () => {
    for (const keyword of ["cvarStrList", "cvarFloatList"]) {
      const choices = Array.from({ length: MAX_UI_MULTI_CHOICES + 1 }, (_, index) => `L${index} ${index}`).join(" ");
      const definitions = await parseMenu(`menuDef { itemDef { type 12 ${keyword} { ${choices} } } }`);
      expect(definitions.menus).toEqual([]);
      expect(definitions.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
        `couldn't parse menu item keyword ${keyword}`, "couldn't parse menu keyword itemDef",
      ]);
    }
  });

  test("retains the source item cap parser position and rejects detached menu 65 before allocation", async () => {
    const items = Array.from({ length: MAX_UI_MENU_ITEMS + 1 }, () => "itemDef { }").join(" ");
    const memory = new TeamArenaUiMemory("qvm32", () => {});
    const parsed = await parseMenu(`menuDef { ${items} visible 1 }`, { kind: "qvm32", memory });
    const menu = onlyMenu(parsed.menus);
    expect(menu.items).toHaveLength(MAX_UI_MENU_ITEMS);
    expect(menu.window.flags & UiWindowFlag.Visible).toBe(0);
    expect(memory.allocatedBytes).toBe(MAX_UI_MENU_ITEMS * 544);
    expect(diagnosticMessages(parsed.diagnostics)).toEqual(["error:unknown menu keyword {"]);
    const menus = Array.from({ length: MAX_UI_MENUS + 1 }, () => "menuDef { }").join(" ");
    await expect(parseMenu(menus)).rejects.toThrow(`more than ${MAX_UI_MENUS} menus`);
  });

  test("bounds stored script text and tokens and reports the explicit port diagnostic", async () => {
    const words = Array.from({ length: 600 }, () => "longword").join(" ");
    const parsed = await parseMenu(`menuDef { onOpen { ${words} } }`);
    const script = onlyMenu(parsed.menus).onOpen;
    if (script === undefined) throw new Error("missing onOpen script");
    expect(new TextEncoder().encode(script.text).length).toBe(MAX_UI_SCRIPT_BYTES);
    expect(script.truncated).toBe(true);
    expect(script.tokens.length).toBeLessThan(600);
    expect(diagnosticMessages(parsed.diagnostics)).toEqual([`warning:script truncated to ${MAX_UI_SCRIPT_BYTES} bytes`]);
  });

  test("uses the HUD set byte boundary before allocating tokens", async () => {
    const resolver = new MemoryResolver([["ui/hud.txt", " ".repeat(MAX_HUD_MENU_SET_BYTES + 1)]]);
    await expect(loadMenuDefinitions({ resolver, random }, defaultHudMenuPlan())).rejects.toThrow("menu file too large");
    resolver.sources.set("ui/hud.txt", "\xe9".repeat(MAX_HUD_MENU_SET_BYTES));
    const definitions = await loadMenuDefinitions({ resolver, random }, defaultHudMenuPlan());
    expect(definitions.menus).toEqual([]);
  });

  test("validates the injected 15-bit UI rand boundary", async () => {
    const resolver = new MemoryResolver([
      ["ui/set.txt", `{ loadMenu { "ui/model.menu" } }`],
      ["ui/model.menu", `menuDef { itemDef { type 7 asset_model player } }`],
    ]);
    const invalidRandom = Object.freeze({ nextInt: (): number => 32_768 });
    await expect(loadMenuDefinitions({ resolver, random: invalidRandom }, { kind: "ui", setPaths: ["ui/set.txt"] }))
      .rejects.toThrow("integer in [0, 32767]");
  });
});

const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retailAvailable = existsSync(`${retailRoot}/missionpack/pak0.pk3`);

test.skipIf(!retailAvailable)("parses the actual Team Arena UI and HUD load sets", async () => {
  const baseVfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product: "baseq3" });
  expect(baseVfs.list("ui/").filter((path) => path.endsWith(".menu"))).toEqual([]);
  const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product: "missionpack" });
  const resolver = new RetailResolver(vfs);
  const memory = new TeamArenaUiMemory("qvm32", () => {});
  const ui = await loadMenuDefinitions({ resolver, random }, defaultUiMenuPlan(), {}, { memory: { kind: "qvm32", memory } });
  const hud = await loadMenuDefinitions({ resolver, random }, defaultHudMenuPlan());
  expect(ui.menus).toHaveLength(45);
  expect(ui.menus.reduce((count, menu) => count + menu.items.length, 0)).toBe(1462);
  expect(memory.allocatedBytes).toBeGreaterThan(1462 * 544);
  expect(memory.allocatedBytes).toBeLessThanOrEqual(1024 * 1024);
  expect(memory.stringBytes).toBeGreaterThan(0);
  expect(hud.menus).toHaveLength(13);
  expect(hud.menus.reduce((count, menu) => count + menu.items.length, 0)).toBe(130);
  expect(ui.diagnostics).toEqual([]);
  expect(hud.diagnostics).toEqual([]);
  expect(ui.menus.map((menu) => menu.window.name)).toContain("main");
  expect(hud.menus.map((menu) => menu.window.name)).toContain("statusbar");
});

test.skipIf(!retailAvailable)("parses every shipped Team Arena menu file, including the oversized skirmish source", async () => {
  const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product: "missionpack" });
  const paths = vfs.list("ui/").filter((path) => path.endsWith(".menu"));
  expect(paths).toHaveLength(49);
  let menuCount = 0;
  let itemCount = 0;
  for (const path of paths) {
    const setPath = `test/${path.slice(3)}.txt`;
    const resolver = new RetailResolver(vfs, new Map([[setPath, `{ loadMenu { "${path}" } }`]]));
    const parsed = await loadMenuDefinitions({ resolver, random }, { kind: "ui", setPaths: [setPath] });
    expect(parsed.diagnostics, path).toEqual([]);
    menuCount += parsed.menus.length;
    itemCount += parsed.menus.reduce((count, menu) => count + menu.items.length, 0);
  }
  expect(menuCount).toBe(68);
  expect(itemCount).toBe(1640);
  const skirmish = await vfs.read("ui/skirmish.menu");
  expect(skirmish.length).toBeGreaterThan(32_768);
});
