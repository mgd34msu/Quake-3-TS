import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SourceFileHandles } from "../src/assets/file-handles.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { AasDebugLines } from "../src/botlib/aas-debug.ts";
import { BotLibrary } from "../src/botlib/library.ts";
import { BotScriptSources } from "../src/botlib/script-sources.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { ScriptLanguageError } from "../src/script/lexer.ts";
import { ScriptGlobalDefines, ScriptSourceReader } from "../src/script/preprocessor.ts";
import { BotDebugPolygons } from "../src/server/bot-debug.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { qvmScriptSyscall } from "../src/vm/script-syscalls.ts";

const temporary: { readonly root: string; readonly handles: SourceFileHandles }[] = [];

afterEach(async () => {
  for (const fixture of temporary.splice(0)) {
    try { fixture.handles.close(); }
    finally { await rm(fixture.root, { recursive: true, force: true }); }
  }
});

async function mount(files: ReadonlyMap<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "quake3-pc-handles-"));
  const handles = new SourceFileHandles();
  temporary.push({ root, handles });
  for (const [path, content] of files) {
    const target = join(root, "baseq3", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const vfs = await VirtualFileSystem.openTracked({
    dataPath: root, homePath: root, cdPath: null, product: "baseq3", handles,
    references: { checksumFeed: 0, random: () => 0 },
  });
  return { root, vfs, handles };
}

function sourceOwner(vfs: VirtualFileSystem) {
  const events: string[] = [];
  const output: { readonly severity: 2 | 3; readonly text: string }[] = [];
  const globals = new ScriptGlobalDefines();
  const sources = new BotScriptSources({
    openRead(path) { events.push(`open:${path}`); return vfs.openRead(path); },
    readInto(file, bytes) { events.push(`read:${file.slot}`); return vfs.readInto(file, bytes); },
    closeFile(file) { events.push(`close:${file.slot}`); vfs.closeFile(file); },
  }, globals, (severity, text) => { output.push({ severity, text }); return undefined; }, (_text: string): undefined => undefined);
  return { sources, globals, events, output };
}

test("PC handles allocate slots 1 through 63 before filename, filesystem or base-folder effects", async () => {
  const { vfs } = await mount(new Map([["root.pc", "token"], ["botfiles/header.h", "bot_header"]]));
  const { sources, events, output } = sourceOwner(vfs);
  expect(events).toEqual([]);
  for (let handle = 1; handle <= 63; handle++) expect(sources.loadSourceHandle("root.pc")).toBe(handle);
  sources.setBaseFolder("botfiles");
  events.length = 0;
  expect(sources.loadSourceHandle("€")).toBe(0);
  expect(sources.loadSourceHandle(() => { throw new Error("Full table must not read a VM filename"); })).toBe(0);
  expect(events).toEqual([]);
  expect(output).toEqual([]);
  expect(sources.resolve({ kind: "system", fromPath: "root.pc", requestedPath: "header.h" })?.text).toBe("bot_header");
  expect(events[0]).toBe("open:botfiles/header.h");
  events.length = 0;
  for (const invalid of [-1, 0, 64, 65, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(sources.freeSourceHandle(invalid)).toBe(false);
    expect(sources.readTokenHandle(invalid)).toBeUndefined();
    expect(sources.sourceFileAndLine(invalid)).toBeUndefined();
  }
  expect(events).toEqual([]);
  expect(sources.freeSourceHandle(23)).toBe(true);
  expect(sources.freeSourceHandle(23)).toBe(false);
  expect(sources.loadSourceHandle("root.pc")).toBe(23);
  expect(sources.freeSourceHandle(1)).toBe(true);
  expect(sources.loadSourceHandle("missing.pc")).toBe(0);
  expect(sources.loadSourceHandle(() => "root.pc")).toBe(1);
});

test("PC load reads the root once and defers include reads until the token request reaches them", async () => {
  const { root, vfs } = await mount(new Map([
    ["root.pc", 'first\n#include "header.h"\nlast'], ["header.h", "old_header"],
  ]));
  const { sources, events } = sourceOwner(vfs);
  const handle = sources.loadSourceHandle("root.pc");
  expect(handle).toBe(1);
  expect(sources.sourceFileAndLine(handle)).toEqual({ filename: "root.pc", line: 1 });
  expect(events).toEqual(["open:root.pc", "read:1", "close:1"]);
  expect(sources.readTokenHandle(handle)?.token.text).toBe("first");
  expect(events).toHaveLength(3);
  writeFileSync(join(root, "baseq3", "root.pc"), "replacement_root");
  writeFileSync(join(root, "baseq3", "header.h"), "new_header");
  expect(sources.readTokenHandle(handle)?.token.text).toBe("new_header");
  expect(events).toEqual(["open:root.pc", "read:1", "close:1", "open:header.h", "read:1", "close:1"]);
  expect(sources.sourceFileAndLine(handle)).toEqual({ filename: "root.pc", line: 1 });
  expect(sources.readTokenHandle(handle)?.token.text).toBe("last");
  expect(sources.readTokenHandle(handle)).toBeUndefined();
  expect(sources.sourceFileAndLine(handle)).toEqual({ filename: "root.pc", line: 3 });
  expect(sources.readTokenHandle(handle)).toBeUndefined();
});

test("source positions retain 64 root filename bytes and the active include's current line", async () => {
  const filename = "r".repeat(80);
  const { vfs } = await mount(new Map([
    [filename.slice(0, 63), '#include "header.h"\nlast'], ["header.h", "one\ntwo\nthree"],
  ]));
  const { sources, output } = sourceOwner(vfs);
  const handle = sources.loadSourceHandle(filename);
  expect(sources.sourceFileAndLine(handle)).toEqual({ filename: filename.slice(0, 64), line: 1 });
  expect(sources.readTokenHandle(handle)?.token.text).toBe("one");
  expect(sources.readTokenHandle(handle)?.token.text).toBe("two");
  expect(sources.sourceFileAndLine(handle)).toEqual({ filename: filename.slice(0, 64), line: 2 });
  sources.checkOpenSourceHandles();
  expect(output).toEqual([{ severity: 3, text: "file header.h still open in precompiler\n" }]);
  expect(sources.readTokenHandle(handle)?.token.text).toBe("three");
  expect(sources.readTokenHandle(handle)?.token.text).toBe("last");
  expect(sources.readTokenHandle(handle)).toBeUndefined();
  expect(sources.sourceFileAndLine(handle)).toEqual({ filename: filename.slice(0, 64), line: 2 });
  sources.checkOpenSourceHandles();
  expect(output[1]).toEqual({ severity: 3, text: `file ${filename} still open in precompiler\n` });
  expect(sources.freeSourceHandle(handle)).toBe(true);
  expect(sources.sourceFileAndLine(handle)).toBeUndefined();
});

test("global defines snapshot after the root close and stay independent of later additions and clear", async () => {
  const { vfs } = await mount(new Map([["root.pc", "VALUE"]]));
  const globals = new ScriptGlobalDefines();
  const output: string[] = [];
  let replaceGlobals = true;
  const sources = new BotScriptSources({
    openRead: path => vfs.openRead(path),
    readInto: (file, bytes) => vfs.readInto(file, bytes),
    closeFile(file) {
      vfs.closeFile(file);
      if (replaceGlobals) { globals.clear(); globals.add("VALUE 10"); replaceGlobals = false; }
    },
  }, globals, (_severity, text) => { output.push(text); return undefined; }, text => { output.push(text); return undefined; });
  globals.add("VALUE 5");
  const old = sources.loadSourceHandle("root.pc");
  globals.clear(); globals.add("VALUE 20");
  const fresh = sources.loadSourceHandle("root.pc");
  globals.clear();
  const cleared = sources.loadSourceHandle("root.pc");
  expect(sources.readTokenHandle(old)?.token.text).toBe("10");
  expect(sources.readTokenHandle(fresh)?.token.text).toBe("20");
  expect(sources.readTokenHandle(cleared)?.token.text).toBe("VALUE");
  expect(output).toEqual([]);
});

test("bot root loads and later VM includes observe the same mutable base folder", async () => {
  const { vfs } = await mount(new Map([
    ["root.pc", 'first\n#include "header.h"\nmiddle\n#include "header.h"\nlast'],
    ["header.h", "vm_header"], ["botfiles/header.h", "bot_header"], ["botfiles/root.c", "bot_root"],
  ]));
  const { sources, events } = sourceOwner(vfs);
  const handle = sources.loadSourceHandle("root.pc");
  expect(sources.readTokenHandle(handle)?.token.text).toBe("first");
  expect(sources.resolveRoot("root.c")?.text).toBe("bot_root");
  expect(sources.readTokenHandle(handle)?.token.text).toBe("bot_header");
  expect(sources.readTokenHandle(handle)?.token.text).toBe("middle");
  expect(sources.loadSourceHandle("missing.pc")).toBe(0);
  expect(sources.readTokenHandle(handle)?.token.text).toBe("vm_header");
  expect(sources.readTokenHandle(handle)?.token.text).toBe("last");
  expect(events.filter(event => event.startsWith("open:"))).toEqual([
    "open:root.pc", "open:botfiles/root.c", "open:botfiles/header.h", "open:missing.pc", "open:header.h",
  ]);
});

test("COM_Compress runs after file close and changes file line counts without changing memory sources", async () => {
  const raw = "one\n\n\n two /* removed\n\n */\n\nthree";
  const { vfs } = await mount(new Map([["lines.pc", raw], ["botfiles/lines.pc", raw]]));
  const { sources, events } = sourceOwner(vfs);
  expect(sources.resolveRoot("lines.pc")?.text).toBe("one\ntwo\nthree");
  const handle = sources.loadSourceHandle("lines.pc");
  expect(sources.readTokenHandle(handle)?.token.text).toBe("one");
  expect(sources.readTokenHandle(handle)?.token.location.line).toBe(2);
  expect(sources.sourceFileAndLine(handle)).toEqual({ filename: "lines.pc", line: 2 });
  const memory = ScriptSourceReader.open({ path: "memory.pc", text: raw }, sources);
  expect(memory.next()?.token.text).toBe("one");
  expect(memory.next()?.token.location.line).toBe(4);
  expect(events).toHaveLength(6);
});

test("source base-folder formatting and pathname bounds retain their distinct source buffers", async () => {
  const folder = "f".repeat(80);
  const { vfs } = await mount(new Map([[folder.slice(0, 63), "truncated"], ["percent%folder/header.h", "percent"]]));
  const { sources, events } = sourceOwner(vfs);
  sources.setBaseFolder(folder);
  expect(sources.resolve({ kind: "system", fromPath: "root.pc", requestedPath: "header.h" })?.text).toBe("truncated");
  sources.setBaseFolder("percent%%folder\0ignored");
  expect(sources.resolve({ kind: "system", fromPath: "root.pc", requestedPath: "header.h" })?.text).toBe("percent");
  expect(() => sources.setBaseFolder("missing-%s-argument")).toThrow("absent source arguments");
  expect(sources.resolve({ kind: "system", fromPath: "root.pc", requestedPath: "header.h" })?.text).toBe("percent");
  expect(events.filter(event => event.startsWith("open:"))).toEqual([
    `open:${folder.slice(0, 63)}`, "open:percent%folder/header.h", "open:percent%folder/header.h",
  ]);
});

test("undefined source filename copies and quoted retries reject at the reached copy", async () => {
  const filename = "r".repeat(1024);
  const { vfs, handles } = await mount(new Map([[filename.slice(0, 63), "present"]]));
  const { sources, events } = sourceOwner(vfs);
  expect(() => sources.loadSourceHandle(filename)).toThrow("1024-byte source allocation");
  expect(handles.readCount).toBe(0);
  expect(vfs.openRead(filename.slice(0, 63))?.file.slot).toBe(2);
  const quoted = "missing".repeat(10);
  expect(() => sources.resolve({ kind: "quoted", fromPath: "root.pc", requestedPath: quoted }))
    .toThrow("quoted retry exceeds its 64-byte source path");
  expect(events.filter(event => event.startsWith("open:"))).toEqual([
    `open:${filename.slice(0, 63)}`, `open:${quoted.slice(0, 63)}`,
  ]);
  const readCount = events.length;
  expect(() => sources.resolve({ kind: "system", fromPath: "root.pc", requestedPath: "/".repeat(64) + "header.h" }))
    .toThrow("system filename exceeds its 64-byte source path");
  expect(events).toHaveLength(readCount);
});

test("late include errors report at read time and return source false with the handle still live", async () => {
  const { vfs } = await mount(new Map([["bad.pc", 'valid\n#include "missing.h"\nafter']]));
  const { sources, events, output } = sourceOwner(vfs);
  const handle = sources.loadSourceHandle("bad.pc");
  expect(output).toEqual([]);
  expect(sources.readTokenHandle(handle)?.token.text).toBe("valid");
  expect(sources.readTokenHandle(handle)).toBeUndefined();
  expect(sources.sourceFileAndLine(handle)?.filename).toBe("bad.pc");
  expect(output.length).toBeGreaterThan(0);
  expect(output[0]?.severity).toBe(3);
  expect(output[0]?.text).toContain("missing.h");
  expect(events.filter(event => event.startsWith("open:"))).toEqual([
    "open:bad.pc", "open:missing.h", "open:missing.h",
  ]);
  expect(sources.readTokenHandle(handle)?.token.text).toBe("after");
  expect(sources.freeSourceHandle(handle)).toBe(true);
});

test("PC handle string lookahead preserves report and filesystem callback error identity", async () => {
  for (const phase of ["report", "read"]) {
    const { vfs } = await mount(new Map([
      ["root.pc", '"kept"\n#include "child.h"\n;'], ["child.h", "#error stop"],
    ]));
    const failure = new ScriptLanguageError({
      severity: "error", message: `${phase} callback aborted`, location: { path: "callback", line: 1, column: 1 },
    }, []);
    let reads = 0;
    const sources = new BotScriptSources({
      openRead: path => vfs.openRead(path),
      readInto(file, bytes) {
        reads++;
        if (phase === "read" && reads === 2) throw failure;
        return vfs.readInto(file, bytes);
      },
      closeFile: file => vfs.closeFile(file),
    }, new ScriptGlobalDefines(), () => { throw failure; }, (_text: string): undefined => undefined);
    const handle = sources.loadSourceHandle("root.pc");
    let caught: unknown;
    try { sources.readTokenHandle(handle); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(sources.sourceFileAndLine(handle)?.filename).toBe("root.pc");
    expect(sources.freeSourceHandle(handle)).toBe(true);
  }
});

function unexpectedService(): never { throw new Error("Unexpected service in authored botlib fixture"); }

test("BotLibShutdown clears globals then diagnoses live readers, while final disposal releases them silently", async () => {
  const { vfs } = await mount(new Map([
    ["live.pc", "VALUE next"],
    ["botfiles/weapons.c", '/* authored\nconfiguration */\n\nprojectileinfo { name "bolt" damage VALUE }\nweaponinfo { number 1 name "Bolt" projectile "bolt" }'],
    ["botfiles/items.c", 'iteminfo "item_health" { name "Health" index 1 }'],
    ["botfiles/syn.c", '1 { [("one", 1), ("two", 1)] }'], ["botfiles/rnd.c", 'greeting = { "hello"; }'],
    ["botfiles/match.c", '1 { "hello", 0 = (1, 0); }'], ["botfiles/rchat.c", '["hello"] = 1 { "hello"; }'],
  ]));
  const output: { readonly severity: number; readonly text: string }[] = [];
  const polygons = new BotDebugPolygons();
  const lines = new AasDebugLines(polygons, unexpectedService);
  const library = new BotLibrary({ assets: () => vfs, random: new LinuxNativeRandom(1),
    print: (severity, text) => {
      output.push({ severity, text });
      if (text.endsWith("still open in precompiler\n")) {
        expect(library.isSetup).toBe(false);
        expect(library.globals.snapshot().definitions).toHaveLength(0);
      }
      return undefined;
    },
    commonPrint: (_text: string): undefined => undefined,
    openLog: unexpectedService, openWrite: unexpectedService, milliseconds: () => 0,
    movementDebug: lines.movement, permanentLine: unexpectedService, clientCommand: unexpectedService,
  });
  try {
    expect(library.globals.add("VALUE 7")).toBe(true);
    const old = library.sources.loadSourceHandle("live.pc");
    expect(library.shutdown()).toBe(1);
    expect(library.globals.snapshot().definitions).toHaveLength(1);
    expect(output.some(entry => entry.text.endsWith("still open in precompiler\n"))).toBe(false);
    expect(library.setup()).toBe(0);
    expect(library.weapons.config?.definedWeaponCount).toBe(1);
    expect(library.weapons.config?.weapons[1]?.projectileInfo.damage).toBe(7);
    expect(library.goals.itemConfig?.items[0]?.name).toBe("Health");
    expect(library.chat.configurationCounts).toEqual({ synonyms: 1, randomLists: 1, matches: 1, replies: 1 });
    expect(library.shutdown()).toBe(0);
    expect(output.at(-1)).toEqual({ severity: 3, text: "file live.pc still open in precompiler\n" });
    expect(library.sources.readTokenHandle(old)?.token.text).toBe("7");
    const fresh = library.sources.loadSourceHandle("live.pc");
    expect(fresh).toBe(2);
    expect(library.sources.readTokenHandle(fresh)?.token.text).toBe("VALUE");
    const prints = output.length;
    library.disposeResources(); library.disposeResources();
    expect(output).toHaveLength(prints);
    expect(() => library.sources.readTokenHandle(old)).toThrow("disposed");
    expect(() => library.sources.freeSourceHandle(fresh)).toThrow("disposed");
    const borrowedFile = vfs.openRead("live.pc");
    expect(borrowedFile).toBeDefined();
    if (borrowedFile !== undefined) vfs.closeFile(borrowedFile.file);
  } finally { library.disposeResources(); }
});

test("final disposal during a leak diagnostic stops the old traversal without closing borrowed files", async () => {
  const { vfs } = await mount(new Map([["root.pc", "token"]]));
  const output: string[] = [];
  const sources = new BotScriptSources(vfs, new ScriptGlobalDefines(), (_severity, text) => {
    output.push(text);
    sources.disposeResources();
    return undefined;
  }, text => { output.push(text); return undefined; });
  expect(sources.loadSourceHandle("root.pc")).toBe(1);
  expect(sources.loadSourceHandle("root.pc")).toBe(2);
  const borrowedFile = vfs.openRead("root.pc");
  if (borrowedFile === undefined) throw new Error("Authored source fixture is absent");
  expect(() => sources.checkOpenSourceHandles()).toThrow("disposed");
  expect(output).toEqual(["file root.pc still open in precompiler\n"]);
  const bytes = new Uint8Array(borrowedFile.length);
  expect(vfs.readInto(borrowedFile.file, bytes)).toBe(5);
  expect(new TextDecoder().decode(bytes)).toBe("token");
  vfs.closeFile(borrowedFile.file);
});

function scriptWords(...args: number[]): DataView {
  const view = new DataView(new ArrayBuffer(args.length * 4));
  for (const [index, value] of args.entries()) view.setInt32(index * 4, value, true);
  return view;
}

test("VM roles share actual PC handles and globals, including source token bytes and clean EOF writes", async () => {
  const { vfs } = await mount(new Map([["vm.pc", 'VALUE "one" "two"\n'] ]));
  const { sources } = sourceOwner(vfs), memory = new QvmMemory(new Uint8Array(4096));
  const call = (role: "game" | "cgame" | "ui", ...args: number[]) => qvmScriptSyscall(role, scriptWords(...args), memory, sources);
  memory.writeString(64, "VALUE 42", 64);
  expect(call("game", 204, 64)).toBe(1);
  memory.writeString(128, "vm.pc", 64);
  const handle = call("cgame", 65, 128);
  if (handle === null) throw new Error("Expected PC load handler");
  expect(handle).toBe(1);
  memory.writeString(64, "VALUE 99", 64);
  expect(call("ui", 57, 64)).toBe(1);
  expect(call("ui", 60, handle, 1024)).toBe(1);
  expect(memory.view(1024, 1040).getInt32(0, true)).toBe(3);
  expect(memory.view(1024, 1040).getInt32(8, true)).toBe(42);
  expect(call("game", 580, handle, 1024)).toBe(1);
  expect(memory.readString(1040)).toBe("onetwo");
  expect(memory.view(1024, 1040).getInt32(4, true)).toBe(8);
  memory.span(1024, 1040).fill(0xa5);
  expect(call("cgame", 67, handle, 1024)).toBe(0);
  expect(memory.span(1024, 17).every(byte => byte === 0)).toBe(true);
  expect(memory.span(1041, 1023).every(byte => byte === 0xa5)).toBe(true);
  expect(call("game", 579, handle)).toBe(1);
  expect(call("ui", 60, handle, 0)).toBe(0);
  expect(call("cgame", 68, handle, 0, 0)).toBe(0);
  for (const role of ["game", "cgame", "ui"] satisfies readonly ("game" | "cgame" | "ui")[])
    expect(call(role, 999)).toBeNull();
});

test("VM source capacity precedes filename access and positions publish filename before line", async () => {
  const filename = "n".repeat(80);
  const { vfs } = await mount(new Map([[filename.slice(0, 63), "first\nsecond\nthird"]]));
  const { sources, events } = sourceOwner(vfs), memory = new QvmMemory(new Uint8Array(4096));
  const call = (...args: number[]) => qvmScriptSyscall("game", scriptWords(...args), memory, sources);
  memory.writeString(64, filename, 128);
  for (let index = 1; index <= 63; index++) expect(call(578, 64)).toBe(index);
  events.length = 0;
  expect(call(578, 0)).toBe(0);
  expect(events).toEqual([]);
  expect(call(581, 1, 256, 384)).toBe(1);
  expect(memory.readString(256)).toBe(filename.slice(0, 64));
  expect(memory.view(384, 4).getInt32(0, true)).toBe(1);
  memory.span(256, 80).fill(0xa5);
  expect(() => call(581, 1, 256, 4095)).toThrow("exceeds allocation");
  expect(memory.readString(256)).toBe(filename.slice(0, 64));
  expect(memory.span(321, 15).every(byte => byte === 0xa5)).toBe(true);
  expect(() => call(580, 1, 0)).toThrow("nonnull");
  expect(call(580, 1, 1024)).toBe(1);
  expect(memory.readString(1040)).toBe("second");
  expect(call(581, 1, 256, 384)).toBe(1);
  expect(memory.view(384, 4).getInt32(0, true)).toBe(2);
  expect(call(579, 23)).toBe(1);
  expect(() => call(578, 0)).toThrow("nonnull");
});
