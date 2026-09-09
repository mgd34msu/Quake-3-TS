import { expect, test } from "bun:test";
import type { FieldControls } from "../src/core/edit-field.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { BaseConfirmMenu } from "../src/ui/base/confirm.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { MenuField } from "../src/ui/base/field.ts";
import { mouseEvent, refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { BaseSpecifyServerMenu } from "../src/ui/base/specify-server.ts";
import { MenuEvent, MenuCommon } from "../src/ui/base/state.ts";
import type { BaseMenuItem, MenuFieldItem } from "../src/ui/base/state.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

const art: readonly [string, string, string, string, string, string] = ["menu/art/frame2_l", "menu/art/frame1_r", "menu/art/back_0", "menu/art/back_1", "menu/art/fight_0", "menu/art/fight_1"];
type Fixture = Awaited<ReturnType<typeof baseFixture>>;
function item(owner: BaseSpecifyServerMenu, index: number): BaseMenuItem {
  const value = owner.menu.items[index];
  if (value === undefined) throw new Error(`Missing source specify item ${index}`);
  return value;
}
function field(owner: BaseSpecifyServerMenu, index: number): MenuFieldItem {
  const value = item(owner, index);
  if (value.kind !== "field") throw new Error("Expected source menu field");
  return value;
}
async function event(owner: BaseSpecifyServerMenu, index = 5, kind = MenuEvent.Activated): Promise<void> {
  const value = item(owner, index), callback = value.common.callback;
  if (callback === null) throw new Error("Missing source specify callback");
  await callback(value, kind);
}
async function press(f: Fixture, key: number): Promise<void> {
  await f.keys.keyEvent(key, true, 10); await f.keys.keyEvent(key, false, 11);
}
function controls(read: () => Uint8Array | null): FieldControls {
  let overstrike = false;
  return { isDown: () => false, getOverstrike: () => overstrike, setOverstrike: value => { overstrike = value; },
    clipboard: { kind: "available", read } };
}

test("specify exact seven source items, six cache calls and domain focus", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseSpecifyServerMenu(f.state), menu = owner.menu;
    f.registrations.length = 0; await owner.show();
    expect(owner.menu).toBe(menu); expect(menu.itemCount).toBe(7);
    expect(f.registrations).toEqual(art.map(name => `shader:${name}`));
    expect(menu.items.map(value => [value.kind, value.common.name, value.common.id, value.common.x, value.common.y, value.common.flags])).toEqual([
      ["banner", null, 0, 320, 16, 0x4000], ["bitmap", art[0], 0, 0, 78, 0x4000], ["bitmap", art[1], 0, 376, 76, 0x4000],
      ["field", "Address:", 0, 206, 220, 0x102], ["field", "Port:", 0, 206, 250, 0x122],
      ["bitmap", art[4], 103, 640, 416, 0x110], ["bitmap", art[2], 102, 0, 416, 0x104],
    ]);
    expect(menu.items.every((value, index) => value.common.parent === menu && value.common.menuPosition === index)).toBe(true);
    expect(menu.items.map(value => value.common.callback !== null)).toEqual([false, false, false, false, false, true, true]);
    expect(menu.items.every(value => value.common.statusbar === null && value.common.ownerdraw === null)).toBe(true);
    expect(menu.items.slice(3).map(value => [value.common.left, value.common.top, value.common.right, value.common.bottom])).toEqual([
      [134, 220, 518, 236], [158, 250, 262, 266], [512, 416, 640, 480], [0, 416, 128, 480],
    ]);
    expect(menu.items.flatMap(value => value.kind === "bitmap" ? [[value.width, value.height, value.focuspic, value.shader, value.focusshader, value.errorpic, value.focuscolor]] : [])).toEqual([
      [256, 329, null, null, null, null, null], [256, 334, null, null, null, null, null],
      [128, 64, art[5], null, null, null, null], [128, 64, art[3], null, null, null, null],
    ]);
    const banner = item(owner, 0); if (banner.kind !== "banner") throw new Error("Missing source banner");
    expect([banner.text, banner.style, banner.color]).toEqual(["SPECIFY SERVER", 1, { x: 1, y: 1, z: 1, w: 1 }]);
    expect([menu.cursor, menu.cursorPrev, menu.wrapAround, menu.fullscreen, menu.showlogo, menu.draw, menu.key]).toEqual([3, 0, true, true, false, null, null]);
    expect([field(owner, 3).field.text, field(owner, 3).field.widthInChars, field(owner, 3).field.maxchars]).toEqual(["", 38, 80]);
    expect([field(owner, 4).field.text, field(owner, 4).field.widthInChars, field(owner, 4).field.maxchars,
      field(owner, 4).field.cursor, field(owner, 4).field.scroll]).toEqual(["27960", 6, 5, 0, 0]);
    expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui); expect(f.state.menuDepth).toBe(1);
  } finally { f.close(); }
});

test("specify resets stable source records before cache and defaults port after all additions before push", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseSpecifyServerMenu(f.state); await owner.show();
    const menu = owner.menu, items = [...menu.items], commons = items.map(value => value.common), domain = field(owner, 3).field, port = field(owner, 4).field;
    const set = port.setText.bind(port), setCatcher = f.keys.setCatcher.bind(f.keys), calls: string[] = [];
    port.setText = value => { calls.push(`port:${value}:${menu.itemCount}`); expect(menu.items).toEqual(items); set(value); };
    f.keys.setCatcher = value => { calls.push("push"); expect(port.text).toBe("27960"); return setCatcher(value); };
    domain.setText("z".repeat(100)); domain.cursor = 90; domain.scroll = 60; port.cursor = 4;
    menu.showlogo = true; menu.draw = async () => undefined; menu.key = async () => ({ kind: "none" });
    for (const value of items) { value.common.id = 999; value.common.flags = 999; value.common.name = "old"; value.common.statusbar = async () => undefined; }
    const gate = deferred(), entered = deferred(), register = f.resources.registerShaderNoMip.bind(f.resources);
    f.resources.registerShaderNoMip = async name => { entered.resolve(); await gate.promise; return await register(name); };
    const pending = owner.show(); await entered.promise;
    expect([menu.itemCount, menu.items.length, menu.cursor, menu.cursorPrev, menu.wrapAround, menu.fullscreen, menu.showlogo]).toEqual([0, 0, 0, 0, false, false, false]);
    expect(menu.draw).toBeNull(); expect(menu.key).toBeNull();
    for (const value of items) expect(value.common).toEqual(new MenuCommon());
    expect([domain.text, domain.cursor, domain.scroll, domain.widthInChars, domain.maxchars, port.text, port.widthInChars, port.maxchars]).toEqual(["", 0, 0, 0, 0, "", 0, 0]);
    expect(calls).toEqual([]); expect(f.state.activeMenu).toBe(menu);
    gate.resolve(); await pending;
    expect(calls).toEqual(["port:27960:7", "push"]); expect(f.state.menuDepth).toBe(1);
    for (const [index, value] of menu.items.entries()) {
      const prior = items[index], common = commons[index];
      if (prior === undefined || common === undefined) throw new Error("Missing retained source item");
      expect(value).toBe(prior); expect(value.common).toBe(common);
    }
    expect(field(owner, 3).field).toBe(domain); expect(field(owner, 4).field).toBe(port);
    for (let index = 0; index < 81; index++) await f.keys.charEvent(65);
    expect(domain.text).toBe("A".repeat(80)); expect(domain.cursor).toBe(79);
    const before = [...menu.items]; await owner.cache(); expect(menu.items).toEqual(before); expect(domain.text).toBe("A".repeat(80));
  } finally { f.close(); }
});

test("canonical reset erases source buffer tails while ordinary clear preserves them", () => {
  const value = new MenuField(), owner = value, input = controls(() => null);
  value.setText("abcdef"); value.widthInChars = 4; value.maxchars = 3; value.cursor = 2; value.scroll = 1;
  value.clear(); for (const character of "WXYZ") value.charEvent(character.charCodeAt(0), input);
  expect(value.text).toBe("WXZdef"); expect([value.widthInChars, value.maxchars]).toEqual([4, 3]);
  value.reset(); expect(value).toBe(owner); expect([value.text, value.cursor, value.scroll, value.widthInChars, value.maxchars]).toEqual(["", 0, 0, 0, 0]);
  value.widthInChars = 4; value.maxchars = 3;
  for (const character of "WXYZ") value.charEvent(character.charCodeAt(0), input);
  expect(value.text).toBe("WXZ");
});

test("reset during actual recursive paste preserves the managed depth limit and usable unwind", () => {
  const value = new MenuField(); let reads = 0, recover = false;
  const input = controls(() => { value.reset(); if (recover) return new Uint8Array([66]);
    if (++reads > 40) throw new Error("Test bound: reset lost recursion accounting"); return new Uint8Array([22]); });
  expect(() => value.charEvent(22, input)).toThrow("Recursive menu field paste exceeded 32 clipboard reads");
  expect(reads).toBe(32); recover = true; value.charEvent(22, input); expect(value.text).toBe("B");
});

test("reset during shallow branching paste preserves aggregate byte work and usable unwind", () => {
  const value = new MenuField(); let reads = 0, recover = false;
  const input = controls(() => { value.reset(); if (recover) return new Uint8Array([66]);
    reads++; if (reads > 4100) throw new Error("Test bound: reset lost byte accounting");
    return new Uint8Array(63).fill(reads === 1 || (reads - 2) % 64 === 0 ? 22 : 65); });
  expect(() => value.charEvent(22, input)).toThrow("Menu field paste exceeded 65536 byte operations");
  expect(reads).toBeGreaterThan(1000); expect(reads).toBeLessThan(1100);
  recover = true; value.charEvent(22, input); expect(value.text).toBe("B");
});

test("specify actual keys advance fields, retain source numeric punctuation and append without execution", async () => {
  const f = await baseFixture(); try {
    await cacheMenu(f.state); const owner = new BaseSpecifyServerMenu(f.state); await owner.show();
    let executions = 0; f.consoleCommands.register("connect", () => { executions++; });
    for (const character of "example.org") await f.keys.charEvent(character.charCodeAt(0));
    await press(f, KeyCode.Enter); expect(owner.menu.cursor).toBe(4); expect(f.consoleCommands.pendingText).toBe("");
    await f.keys.charEvent(3); for (const character of "123456") await f.keys.charEvent(character.charCodeAt(0));
    expect([field(owner, 4).field.text, field(owner, 4).field.cursor]).toEqual(["12346", 4]);
    await f.keys.charEvent(65); await f.keys.charEvent(122); expect(field(owner, 4).field.text).toBe("12346");
    expect(f.events.filter(value => value === "sound:sound/misc/menu4.wav:6")).toHaveLength(2);
    await f.keys.charEvent(3); for (const character of ":;-.") await f.keys.charEvent(character.charCodeAt(0));
    expect(field(owner, 4).field.text).toBe(":;-.");
    await press(f, KeyCode.KeypadEnter); expect(owner.menu.cursor).toBe(5);
    f.consoleCommands.append("wait\n"); await press(f, KeyCode.Enter);
    expect(f.consoleCommands.pendingText).toBe("wait\nconnect example.org::;-.\n"); expect(executions).toBe(0);
    expect(f.state.activeMenu).toBe(owner.menu); expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui);
    await f.consoleCommands.executeAsync(); expect(executions).toBe(0);
  } finally { f.close(); }
});

test("specify actual arrows, Tab, keypad and mouse traverse and activate real stack", async () => {
  const f = await baseFixture(); try {
    await cacheMenu(f.state); const parent = new BaseConfirmMenu(f.state), owner = new BaseSpecifyServerMenu(f.state);
    await parent.show("Parent", null, null); await owner.show();
    for (const [key, cursor] of [[KeyCode.Up, 6], [KeyCode.Tab, 3], [KeyCode.KeypadDown, 4], [KeyCode.Down, 5],
      [KeyCode.KeypadUp, 4], [KeyCode.KeypadEnter, 5], [KeyCode.Tab, 6], [KeyCode.Down, 3]] satisfies readonly (readonly [number, number])[]) {
      await press(f, key); expect(owner.menu.cursor).toBe(cursor);
    }
    field(owner, 3).field.setText("mouse"); await mouseEvent(f.state, 550, 450); expect(owner.menu.cursor).toBe(5);
    expect(item(owner, 5).common.flags & 0x200).toBe(0x200); await press(f, KeyCode.Mouse1);
    expect(f.consoleCommands.pendingText).toBe("connect mouse:27960\n"); expect(f.state.menuDepth).toBe(2);
    await mouseEvent(f.state, -500, 0); expect(owner.menu.cursor).toBe(6); await press(f, KeyCode.Mouse1);
    expect(f.state.activeMenu).toBe(parent.menu); expect(f.state.menuDepth).toBe(1);
    await owner.show(); await press(f, KeyCode.Escape); expect(f.state.activeMenu).toBe(parent.menu);
    await owner.show(); await event(owner, 6); expect(f.state.activeMenu).toBe(parent.menu);
  } finally { f.close(); }
});

test("specify byte strings preserve unquoted command syntax and NUL boundaries", async () => {
  const f = await baseFixture(); try {
    const printedBefore = f.prints.length;
    const owner = new BaseSpecifyServerMenu(f.state); await owner.show();
    const cases: readonly (readonly [string, string, string])[] = [
      ["localhost", "27960", "connect localhost:27960\n"], ["local host;quit", "", "connect local host;quit\n"],
      ["a:b", "12", "connect a:b:12\n"], ['"host"', '";x', 'connect "host":";x\n'],
      ["caf\u00e9\u00ff", "\u0080", "connect caf\u00e9\u00ff:\u0080\n"], ["before\0after", "12\0tail", "connect before:12\n"],
      ["", "27960", ""], ["\0ignored", "27960", ""], ["host", "\0ignored", "connect host\n"],
    ];
    let expected = "preceding\n"; f.consoleCommands.append(expected);
    for (const [domain, port, command] of cases) {
      field(owner, 3).field.setText(domain); field(owner, 4).field.setText(port); await event(owner); expected += command;
      expect(f.consoleCommands.pendingText).toBe(expected);
      expect(Array.from(f.consoleCommands.pendingText, character => character.charCodeAt(0))).toEqual(Array.from(expected, character => character.charCodeAt(0)));
    }
    const before = field(owner, 3).field.text; expect(() => field(owner, 3).field.setText("\u0100")).toThrow();
    expect(field(owner, 3).field.text).toBe(before); expect(() => field(owner, 3).field.setText("x".repeat(256))).toThrow("source buffer");
    expect(f.prints.slice(printedBefore)).toEqual([]);
  } finally { f.close(); }
});

test("specify empty domain never reads the port and unrelated callback events do nothing", async () => {
  const f = await baseFixture(); try {
    const printedBefore = f.prints.length;
    const owner = new BaseSpecifyServerMenu(f.state); await owner.show();
    Object.defineProperty(field(owner, 4).field, "text", { get: () => { throw new Error("Port read before nonempty domain"); } });
    await event(owner); for (const kind of [MenuEvent.GotFocus, MenuEvent.LostFocus]) { await event(owner, 5, kind); await event(owner, 6, kind); }
    item(owner, 5).common.id = 999; await event(owner);
    expect(f.consoleCommands.pendingText).toBe(""); expect(f.prints.slice(printedBefore)).toEqual([]); expect(f.state.menuDepth).toBe(1);
  } finally { f.close(); }
});

test("specify direct source buffers enforce padded destination bounds only when port is nonempty", async () => {
  const f = await baseFixture(); try {
    const printedBefore = f.prints.length;
    const owner = new BaseSpecifyServerMenu(f.state); await owner.show();
    field(owner, 3).field.setText("a".repeat(128)); field(owner, 4).field.setText("1"); await event(owner);
    const first = `connect ${"a".repeat(128)}:1\n`; expect(f.consoleCommands.pendingText).toBe(first);
    field(owner, 3).field.setText("b".repeat(129)); await expect(event(owner)).rejects.toThrow("destination write");
    expect(f.consoleCommands.pendingText).toBe(first); expect(f.prints.slice(printedBefore)).toEqual([]);
    field(owner, 3).field.setText("c".repeat(255)); field(owner, 4).field.setText(""); await event(owner);
    expect(f.consoleCommands.pendingText).toBe(`${first}connect ${"c".repeat(255)}\n`);
  } finally { f.close(); }
});

for (const length of [126, 127, 128, 255]) test(`specify port ${length} prints source overflow before truncation and append`, async () => {
  const f = await baseFixture(); try {
    const printedBefore = f.prints.length;
    const owner = new BaseSpecifyServerMenu(f.state); await owner.show();
    const domain = "d".repeat(128), port = "p".repeat(length); field(owner, 3).field.setText(domain); field(owner, 4).field.setText(port);
    const sink = f.state.services.print.bind(f.state.services), append = f.consoleCommands.append.bind(f.consoleCommands), calls: string[] = [];
    f.state.services.print = text => { calls.push(`print:${text}`); expect(f.consoleCommands.pendingText).toBe(""); sink(text);
      field(owner, 3).field.setText("mutated"); field(owner, 4).field.setText("changed"); };
    f.consoleCommands.append = text => { calls.push(`append:${text}`); append(text); };
    await event(owner); const command = `connect ${domain}:${"p".repeat(Math.min(length, 126))}\n`;
    expect(calls).toEqual(length === 126 ? [`append:${command}`] : [`print:Com_sprintf: overflow of ${length + 1} in 128\n`, `append:${command}`]);
    expect(f.consoleCommands.pendingText).toBe(command);
    expect(f.prints.slice(printedBefore)).toEqual(length === 126 ? [] : [`Com_sprintf: overflow of ${length + 1} in 128\n`]);
  } finally { f.close(); }
});

test("specify overflowing port prints before undefined destination guard", async () => {
  const f = await baseFixture(); try {
    const printedBefore = f.prints.length;
    const owner = new BaseSpecifyServerMenu(f.state); await owner.show();
    field(owner, 3).field.setText("d".repeat(129)); field(owner, 4).field.setText("p".repeat(127));
    await expect(event(owner)).rejects.toThrow("destination write");
    expect(f.prints.slice(printedBefore)).toEqual(["Com_sprintf: overflow of 128 in 128\n"]); expect(f.consoleCommands.pendingText).toBe("");
  } finally { f.close(); }
});

for (const outcome of ["throw", "retire", "capacity"]) test(`specify diagnostic ${outcome} preserves reached source command and move-sound effects`, async () => {
  const f = await baseFixture(); try {
    await cacheMenu(f.state); const owner = new BaseSpecifyServerMenu(f.state); await owner.show();
    field(owner, 3).field.setText("host"); field(owner, 4).field.setText("p".repeat(127)); await setCursorToItem(f.state, owner.menu, item(owner, 5));
    const sink = f.state.services.print.bind(f.state.services), failure = new Error("source print failure");
    f.state.services.print = text => { sink(text); if (outcome === "throw") throw failure; if (outcome === "retire") f.state.retire(); };
    if (outcome === "capacity") f.consoleCommands.append("x".repeat(16383));
    f.events.length = 0;
    const printedBefore = f.prints.length;
    if (outcome === "throw") await expect(press(f, KeyCode.Enter)).rejects.toBe(failure);
    else if (outcome === "retire") await expect(press(f, KeyCode.Enter)).rejects.toThrow("retired");
    else await press(f, KeyCode.Enter);
    expect(f.prints.slice(printedBefore)).toEqual(outcome === "capacity"
      ? ["Com_sprintf: overflow of 128 in 128\n", "Cbuf_AddText: overflow\n"] : ["Com_sprintf: overflow of 128 in 128\n"]);
    expect(f.events).toEqual(outcome === "capacity" ? ["sound:sound/misc/menu2.wav:6"] : []);
    expect(f.consoleCommands.pendingText).toBe(outcome === "capacity" ? "x".repeat(16383) : "");
    expect(f.state.activeMenu).toBe(owner.menu); expect(f.state.menuDepth).toBe(1);
  } finally { f.close(); }
});

test("specify cache failure leaves partial registration and reset records, retry repeats source order", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseSpecifyServerMenu(f.state), register = f.resources.registerShaderNoMip.bind(f.resources), calls: string[] = [], failure = new Error("cache failure");
    f.registrations.length = 0;
    f.resources.registerShaderNoMip = async name => { if (name === null) throw new Error("Authored menu cache requires a shader name"); calls.push(name); if (name === art[3]) throw failure; return await register(name); };
    await expect(owner.show()).rejects.toBe(failure); expect(calls).toEqual(art.slice(0, 4));
    expect(owner.menu.itemCount).toBe(0); expect(f.state.activeMenu).toBeNull(); expect(f.state.menuDepth).toBe(0);
    expect(f.registrations).toEqual(art.slice(0, 3).map(name => `shader:${name}`));
    f.resources.registerShaderNoMip = register; f.registrations.length = 0; await owner.show();
    expect(f.registrations).toEqual(art.map(name => `shader:${name}`)); expect(field(owner, 4).field.text).toBe("27960");
  } finally { f.close(); }
});

test("specify retired cache and entry paths stop registration, push, print and append", async () => {
  const f = await baseFixture(); try {
    const printedBefore = f.prints.length;
    const owner = new BaseSpecifyServerMenu(f.state); await owner.show();
    const go = item(owner, 5), callback = go.common.callback; if (callback === null) throw new Error("Missing callback");
    const register = f.resources.registerShaderNoMip.bind(f.resources), calls: string[] = [];
    f.resources.registerShaderNoMip = async name => { if (name === null) throw new Error("Authored menu cache requires a shader name"); calls.push(name); const value = await register(name); f.state.retire(); return value; };
    await expect(owner.show()).rejects.toThrow("retired"); expect(calls).toEqual([art[0]]); expect(owner.menu.itemCount).toBe(0);
    await expect(owner.cache()).rejects.toThrow("retired"); await expect(owner.show()).rejects.toThrow("retired");
    await expect(callback(go, MenuEvent.Activated)).rejects.toThrow("retired");
    expect(calls).toEqual([art[0]]); expect(f.prints.slice(printedBefore)).toEqual([]); expect(f.consoleCommands.pendingText).toBe("");
  } finally { f.close(); }
});

test("specify escaped actual command contexts cannot resume cache or print", async () => {
  const f = await baseFixture(); try {
    const printedBefore = f.prints.length;
    const owner = new BaseSpecifyServerMenu(f.state); await owner.show();
    field(owner, 3).field.setText("host"); field(owner, 4).field.setText("p".repeat(127));
    const gate = deferred(), register = f.resources.registerShaderNoMip.bind(f.resources);
    f.resources.registerShaderNoMip = async name => { await gate.promise; return await register(name); };
    let escaped: Promise<void> | null = null;
    f.consoleCommands.register("escape", () => { escaped = owner.show(); });
    await f.consoleCommands.executeNowAsync("escape"); gate.resolve();
    if (escaped === null) throw new Error("Missing escaped operation");
    await expect(escaped).rejects.toThrow("closed command execution context");
    expect(owner.menu.itemCount).toBe(0); expect(f.prints.slice(printedBefore)).toEqual([]); expect(f.consoleCommands.pendingText).toBe("");
    f.resources.registerShaderNoMip = register; await owner.show();
    const printGate = deferred(); let late: Promise<void> | null = null;
    f.consoleCommands.register("lateprint", () => { late = printGate.promise.then(() => { f.state.services.print("stale print"); }); });
    await f.consoleCommands.executeNowAsync("lateprint"); printGate.resolve();
    if (late === null) throw new Error("Missing escaped print");
    await expect(late).rejects.toThrow("closed command execution context"); expect(f.prints.slice(printedBefore)).toEqual([]);
  } finally { f.close(); }
});

test("specify retail CPU queue keeps source art order, geometry, field glyphs and changing focus pixels", async () => {
  const f = await baseFixture(320, 240); try {
    await cacheMenu(f.state); const owner = new BaseSpecifyServerMenu(f.state); await owner.show();
    field(owner, 3).field.setText("host"); await refresh(f.state, 75); f.commands.submit();
    const batches = f.recorder.trace().flatMap(view => view.batches);
    const bitmapBatches = batches.filter(batch => batch.texture.kind === "bind-image" && ["frame2_l", "frame1_r", "fight_0", "back_0"].some(name => batch.texture.kind === "bind-image" && batch.texture.image.name.includes(name)));
    expect(bitmapBatches.map(batch => batch.texture.kind === "bind-image" ? batch.texture.image.name.replace(/\.[^.]+$/, "") : "")).toEqual([art[0], art[1], art[4], art[2]]);
    const expected: readonly (readonly [number, number, number, number])[] = [[0, 78, 256, 407], [376, 76, 632, 410], [512, 416, 640, 480], [0, 416, 128, 480]];
    for (const [index, batch] of bitmapBatches.entries()) {
      const bounds = expected[index]; if (bounds === undefined) throw new Error("Missing source bitmap bounds");
      const vertices = [...new Set(batch.indices)].map(index => { const vertex = batch.vertices[index]; if (vertex === undefined) throw new Error("Missing queued vertex"); return vertex; });
      const xs = vertices.map(vertex => (vertex.position.x + 1) * 320), ys = vertices.map(vertex => (1 - vertex.position.y) * 240);
      expect(Math.min(...xs)).toBeCloseTo(bounds[0], 3); expect(Math.min(...ys)).toBeCloseTo(bounds[1], 3);
      expect(Math.max(...xs)).toBeCloseTo(bounds[2], 3); expect(Math.max(...ys)).toBeCloseTo(bounds[3], 3);
    }
    const glyphs = batches.filter(batch => batch.texture.kind === "bind-image" && batch.texture.image.name.includes("bigchars"));
    expect(glyphs.flatMap(batch => batch.vertices).some(vertex => Math.abs((vertex.position.x + 1) * 320 - 214) < .01 && Math.abs((1 - vertex.position.y) * 240 - 220) < .01)).toBe(true);
    const before = f.cpu.pixels.slice(); await setCursorToItem(f.state, owner.menu, item(owner, 5)); await refresh(f.state, 75); f.commands.submit();
    expect(f.recorder.trace().flatMap(view => view.batches).some(batch => batch.texture.kind === "bind-image" && batch.texture.image.name.includes("fight_1"))).toBe(true);
    let changed = 0; for (let index = 0; index < before.length; index++) if (before[index] !== f.cpu.pixels[index]) changed++;
    expect(changed).toBeGreaterThan(0); expect(f.state.firstDraw).toBe(false); expect(f.events).toContain("sound:sound/misc/menu1.wav:6");
  } finally { f.close(); }
});
