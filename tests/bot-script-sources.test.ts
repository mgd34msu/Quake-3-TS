import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { renameSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SourceFileHandles, FileHandleExhaustionError } from "../src/assets/file-handles.ts";
import { PakReferenceFlag } from "../src/assets/pak-references.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { BotMemory, type BotMemoryAllocation } from "../src/botlib/memory.ts";
import { BotScriptSources } from "../src/botlib/script-sources.ts";
import { ZoneArena } from "../src/core/zone.ts";
import { SourceScriptStorage, type ScriptMemory } from "../src/script/memory.ts";
import { ScriptGlobalDefines, ScriptPreprocessor, ScriptSourceReader } from "../src/script/preprocessor.ts";
import { sourceZip } from "./pk3-source-fixture.ts";

const temporary: { readonly root: string; readonly handles: SourceFileHandles }[] = [];

function unexpectedDiagnostic(_severity: 2 | 3, text: string): never {
  throw new Error(`Unexpected bot source diagnostic: ${text}`);
}

function unexpectedCommonPrint(text: string): never {
  throw new Error(`Unexpected common print: ${text}`);
}

afterEach(async () => {
  for (const fixture of temporary.splice(0)) {
    try { fixture.handles.close(); }
    finally { await rm(fixture.root, { recursive: true, force: true }); }
  }
});

async function mount(files: ReadonlyMap<string, string | Uint8Array>, random: () => number = () => 0) {
  const root = await mkdtemp(join(tmpdir(), "quake3-bot-sources-"));
  const handles = new SourceFileHandles();
  temporary.push({ root, handles });
  for (const [path, content] of files) {
    const target = join(root, "baseq3", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const vfs = await VirtualFileSystem.openTracked({
    dataPath: root, homePath: root, cdPath: null, product: "baseq3",
    handles, references: { checksumFeed: 0, random },
  });
  return { root, vfs, handles };
}

test("bot sources open once, preserve source filenames and snapshot globals after the root read", async () => {
  const events: string[] = [];
  let referenceOpens = 0;
  const { vfs } = await mount(new Map([
    ["botfiles/bots/root.c", '#include "header.h"\nMISSIONPACK'],
    ["botfiles/bots/header.h", "wrong"],
    ["botfiles/header.h", "right"],
    ["botfiles/botfiles/header.h", "explicit_prefix"],
  ]), () => { referenceOpens++; return 0; });
  const globals = new ScriptGlobalDefines();
  const sources = new BotScriptSources({
    openRead(path) { events.push(`open:${path}`); return vfs.openRead(path); },
    readInto(file, destination) {
      events.push(`read:${file.slot}`);
      globals.add(`MISSIONPACK ${referenceOpens}`);
      return vfs.readInto(file, destination);
    },
    closeFile(file) { events.push(`close:${file.slot}`); vfs.closeFile(file); },
  }, globals, unexpectedDiagnostic, unexpectedCommonPrint);
  const root = sources.resolveRoot("bots/root.c");
  if (root === undefined) throw new Error("fixture root missing");
  expect(root.path).toBe("bots/root.c");
  const stream = ScriptPreprocessor.create(root, sources, { globalDefines: globals.snapshot() });
  expect(stream.all().map(token => token.text)).toEqual(["right", "1"]);
  expect(events).toEqual(["open:botfiles/bots/root.c", "read:1", "close:1", "open:botfiles/header.h", "read:1", "close:1"]);
  expect(referenceOpens).toBe(2);
  expect(sources.resolveRoot("botfiles/header.h")?.text).toBe("explicit_prefix");
  events.length = 0;
  expect(sources.resolve({ kind: "quoted", fromPath: root.path, requestedPath: "missing.h" })).toBeUndefined();
  expect(events).toEqual(["open:botfiles/missing.h", "open:botfiles/missing.h"]);
  expect(referenceOpens).toBe(3);
  events.length = 0;
  expect(sources.resolve({ kind: "system", fromPath: root.path, requestedPath: "missing.h" })).toBeUndefined();
  expect(events).toEqual(["open:botfiles/missing.h"]);
});

test("bounded native pathname and Latin1 bytes remain distinct from requested filename", async () => {
  const filename = "a".repeat(80);
  const { vfs } = await mount(new Map([
    [`botfiles/${"a".repeat(54)}`, new Uint8Array([34, 233, 34])],
  ]));
  const paths: string[] = [];
  const diagnostics: string[] = [];
  const sources = new BotScriptSources({
    openRead(path) { paths.push(path); return vfs.openRead(path); },
    readInto: (file, bytes) => vfs.readInto(file, bytes),
    closeFile: file => vfs.closeFile(file),
  }, new ScriptGlobalDefines(), unexpectedDiagnostic, text => { diagnostics.push(text); });
  expect(sources.resolveRoot(filename)).toMatchObject({ path: filename, text: '"é"' });
  expect(paths).toEqual([`botfiles/${"a".repeat(54)}`]);
  expect(sources.resolveRoot(filename + "\0ignored")).toMatchObject({ path: filename, text: '"é"' });
  expect(() => sources.resolveRoot("€")).toThrow("source bytes");
  expect(paths).toHaveLength(2);
  expect(diagnostics).toEqual(["Com_sprintf: overflow of 89 in 64\n", "Com_sprintf: overflow of 89 in 64\n"]);
});

test("quoted include retries the failed open and converts source separators", async () => {
  const { root, vfs } = await mount(new Map([["botfiles/includes/existing.h", "existing"]]));
  const paths: string[] = [];
  const sources = new BotScriptSources({
    openRead(path) {
      paths.push(path);
      const opened = vfs.openRead(path);
      if (opened === undefined) writeFileSync(join(root, "baseq3", path), "appeared");
      return opened;
    },
    readInto: (file, bytes) => vfs.readInto(file, bytes),
    closeFile: file => vfs.closeFile(file),
  }, new ScriptGlobalDefines(), unexpectedDiagnostic, unexpectedCommonPrint);
  sources.setBaseFolder("botfiles");
  expect(sources.resolve({ kind: "quoted", fromPath: "bots/root.c", requestedPath: "new.h" }))
    .toMatchObject({ path: "new.h", text: "appeared" });
  expect(paths).toEqual(["botfiles/new.h", "botfiles/new.h"]);
  expect(sources.resolve({ kind: "quoted", fromPath: "bots/root.c", requestedPath: "includes\\\\//existing.h" }))
    .toMatchObject({ path: "includes/existing.h", text: "existing" });
  expect(paths.slice(2)).toEqual(["botfiles/includes/existing.h"]);
});

test("basefolder warnings count formatted source bytes and preserve defined percent formatting", async () => {
  const { vfs } = await mount(new Map<string, string>());
  const events: string[] = [];
  const sources = new BotScriptSources({
    openRead(path) { events.push(`open:${path}`); return vfs.openRead(path); },
    readInto: (file, bytes) => vfs.readInto(file, bytes),
    closeFile: file => vfs.closeFile(file),
  }, new ScriptGlobalDefines(), unexpectedDiagnostic, text => { events.push(text); });
  sources.setBaseFolder("é".repeat(62) + "%%\0%s");
  expect(events).toEqual([]);
  sources.setBaseFolder("é".repeat(63) + "%%\0%s");
  expect(events).toEqual(["Com_sprintf: overflow of 64 in 64\n"]);
  expect(() => sources.setBaseFolder("bad%s")).toThrow("absent source arguments");
  expect(() => sources.setBaseFolder("bad%")).toThrow("absent source arguments");
  expect(() => sources.setBaseFolder("€")).toThrow("source bytes");
  sources.resolve({ kind: "system", fromPath: "root", requestedPath: "x" });
  expect(events.slice(1)).toEqual(["Com_sprintf: overflow of 65 in 64\n", `open:${"é".repeat(63)}`]);
});

test("basefolder publication follows its warning and overwrites a nested successful assignment", async () => {
  const { vfs } = await mount(new Map<string, string>());
  const events: string[] = [];
  let inspect = true;
  const sources = new BotScriptSources({
    openRead(path) { events.push(`open:${path}`); return vfs.openRead(path); },
    readInto: (file, bytes) => vfs.readInto(file, bytes),
    closeFile: file => vfs.closeFile(file),
  }, new ScriptGlobalDefines(), unexpectedDiagnostic, text => {
    events.push(text);
    if (inspect) {
      inspect = false;
      sources.resolve({ kind: "system", fromPath: "root", requestedPath: "probe" });
      sources.setBaseFolder("nested");
    }
  });
  sources.setBaseFolder("old");
  sources.setBaseFolder("a".repeat(64));
  sources.resolve({ kind: "system", fromPath: "root", requestedPath: "probe" });
  expect(events).toEqual([
    "Com_sprintf: overflow of 64 in 64\n", "open:old/probe",
    "Com_sprintf: overflow of 69 in 64\n", `open:${"a".repeat(63)}`,
  ]);
});

test("aborted path warnings preserve the prior basefolder and prevent filesystem opens", async () => {
  const { vfs } = await mount(new Map<string, string>());
  const paths: string[] = [];
  const failure = new Error("common print aborted");
  const sources = new BotScriptSources({
    openRead(path) { paths.push(path); return vfs.openRead(path); },
    readInto: (file, bytes) => vfs.readInto(file, bytes),
    closeFile: file => vfs.closeFile(file),
  }, new ScriptGlobalDefines(), unexpectedDiagnostic, () => { throw failure; });
  sources.setBaseFolder("old");
  expect(() => sources.setBaseFolder("a".repeat(64))).toThrow(failure);
  sources.resolve({ kind: "system", fromPath: "root", requestedPath: "probe" });
  expect(paths).toEqual(["old/probe"]);
  expect(() => sources.resolve({ kind: "system", fromPath: "root", requestedPath: "a".repeat(60) })).toThrow(failure);
  expect(paths).toEqual(["old/probe"]);
});

test("pathname warnings precede open and keep the captured path across nested basefolder changes", async () => {
  const { vfs } = await mount(new Map<string, string>());
  const events: string[] = [];
  const sources = new BotScriptSources({
    openRead(path) { events.push(`open:${path}`); return vfs.openRead(path); },
    readInto: (file, bytes) => vfs.readInto(file, bytes),
    closeFile: file => vfs.closeFile(file),
  }, new ScriptGlobalDefines(), unexpectedDiagnostic, text => {
    events.push(text);
    sources.setBaseFolder("nested");
  });
  expect(sources.loadSourceHandle("a".repeat(63))).toBe(0);
  expect(events).toEqual([`open:${"a".repeat(63)}`]);
  events.length = 0;
  expect(sources.loadSourceHandle("a".repeat(64) + "\0ignored")).toBe(0);
  sources.resolve({ kind: "system", fromPath: "root", requestedPath: "probe" });
  expect(events).toEqual([
    "Com_sprintf: overflow of 64 in 64\n", `open:${"a".repeat(63)}`, "open:nested/probe",
  ]);
  events.length = 0;
  sources.setBaseFolder("old");
  sources.resolve({ kind: "system", fromPath: "root", requestedPath: "a".repeat(60) });
  expect(events).toEqual(["Com_sprintf: overflow of 64 in 64\n", `open:old/${"a".repeat(59)}`]);
});

test("disposing source resources during a path warning prevents the pending open", async () => {
  const { vfs } = await mount(new Map<string, string>());
  const paths: string[] = [];
  const sources = new BotScriptSources({
    openRead(path) { paths.push(path); return vfs.openRead(path); },
    readInto: (file, bytes) => vfs.readInto(file, bytes),
    closeFile: file => vfs.closeFile(file),
  }, new ScriptGlobalDefines(), unexpectedDiagnostic, () => { sources.disposeResources(); });
  expect(() => sources.loadSourceHandle("a".repeat(64))).toThrow("disposed");
  expect(paths).toEqual([]);
});

test("bot path formatting rejects the undefined scratch-buffer overflow before warning or open", async () => {
  const { vfs } = await mount(new Map<string, string>());
  const events: string[] = [];
  const sources = new BotScriptSources({
    openRead(path) { events.push(`open:${path}`); return vfs.openRead(path); },
    readInto: (file, bytes) => vfs.readInto(file, bytes),
    closeFile: file => vfs.closeFile(file),
  }, new ScriptGlobalDefines(), unexpectedDiagnostic, text => { events.push(text); });
  sources.setBaseFolder("a".repeat(31999));
  expect(events).toEqual(["Com_sprintf: overflow of 31999 in 64\n"]);
  events.length = 0;
  expect(() => sources.setBaseFolder("a".repeat(32000))).toThrow("32000-byte source buffer");
  expect(events).toEqual([]);
  expect(sources.loadSourceHandle("b".repeat(31999))).toBe(0);
  expect(events).toEqual(["Com_sprintf: overflow of 31999 in 64\n", `open:${"b".repeat(63)}`]);
  events.length = 0;
  expect(() => sources.loadSourceHandle("b".repeat(32000))).toThrow("32000-byte source buffer");
  expect(events).toEqual([]);
});

test("read uses the opened loose descriptor and captured size after pathname replacement", async () => {
  let referenceOpens = 0;
  const { root, vfs } = await mount(new Map([["botfiles/root.c", "old"]]), () => { referenceOpens++; return 0; });
  const filePath = join(root, "baseq3", "botfiles/root.c");
  const sources = new BotScriptSources({
    openRead(path) {
      const opened = vfs.openRead(path);
      renameSync(filePath, filePath + ".previous");
      writeFileSync(filePath, "replacement");
      return opened;
    },
    readInto(file, bytes) { expect(bytes.length).toBe(3); return vfs.readInto(file, bytes); },
    closeFile: file => vfs.closeFile(file),
  }, new ScriptGlobalDefines(), unexpectedDiagnostic, unexpectedCommonPrint);
  expect(sources.resolveRoot("root.c")?.text).toBe("old");
  expect(referenceOpens).toBe(1);
});

test("short reads terminate at the cleared buffer tail before compression", async () => {
  const { root, vfs } = await mount(new Map([["botfiles/root.c", "token suffix"]]));
  const events: string[] = [];
  const sources = new BotScriptSources({
    openRead(path) {
      const opened = vfs.openRead(path);
      truncateSync(join(root, "baseq3", path), 5);
      return opened;
    },
    readInto(file, bytes) {
      expect(bytes.length).toBe(12);
      const count = vfs.readInto(file, bytes);
      events.push(`read:${count}`);
      return count;
    },
    closeFile(file) { events.push("close"); vfs.closeFile(file); },
  }, new ScriptGlobalDefines(), unexpectedDiagnostic, unexpectedCommonPrint);
  const source = sources.resolveRoot("root.c");
  expect(source?.text).toBe("token");
  if (source === undefined) throw new Error("fixture source missing");
  expect(ScriptPreprocessor.create(source, sources).all().map(token => token.text)).toEqual(["token"]);
  expect(events).toEqual(["read:5", "close"]);
});

test("empty sources still perform the zero-length read and close", async () => {
  const { vfs } = await mount(new Map([["botfiles/empty.c", ""]]));
  const events: string[] = [];
  const sources = new BotScriptSources({
    openRead: path => vfs.openRead(path),
    readInto(file, bytes) { events.push(`read:${bytes.length}`); return vfs.readInto(file, bytes); },
    closeFile(file) { events.push("close"); vfs.closeFile(file); },
  }, new ScriptGlobalDefines(), unexpectedDiagnostic, unexpectedCommonPrint);
  expect(sources.resolveRoot("empty.c")).toMatchObject({ path: "empty.c", text: "" });
  expect(events).toEqual(["read:0", "close"]);
});

test("packed source references are recorded by the open and not repeated by its read", async () => {
  const pack = sourceZip([{ name: new TextEncoder().encode("botfiles/root.c"),
    data: new TextEncoder().encode("packed"), method: 8, utf8: false }]);
  const { vfs } = await mount(new Map([["pak0.pk3", pack]]));
  const sources = new BotScriptSources({
    openRead(path) {
      const opened = vfs.openRead(path);
      expect(vfs.pakReferences.snapshot().map(entry => entry.flags)).toEqual([PakReferenceFlag.General]);
      vfs.pakReferences.clear();
      return opened;
    },
    readInto: (file, bytes) => vfs.readInto(file, bytes),
    closeFile: file => vfs.closeFile(file),
  }, new ScriptGlobalDefines(), unexpectedDiagnostic, unexpectedCommonPrint);
  expect(sources.resolveRoot("root.c")?.text).toBe("packed");
  expect(vfs.pakReferences.snapshot().map(entry => entry.flags)).toEqual([0]);
});

test("a failed packed read preserves the source partial handle until owner cleanup", async () => {
  const pack = sourceZip([{ name: new TextEncoder().encode("botfiles/root.c"),
    data: new TextEncoder().encode("packed"), method: 8, utf8: false }]);
  pack[30 + "botfiles/root.c".length] = 7;
  const { vfs } = await mount(new Map([["pak0.pk3", pack]]));
  let closed = false;
  const sources = new BotScriptSources({
    openRead: path => vfs.openRead(path),
    readInto: (file, bytes) => vfs.readInto(file, bytes),
    closeFile(file) { closed = true; vfs.closeFile(file); },
  }, new ScriptGlobalDefines(), unexpectedDiagnostic, unexpectedCommonPrint);
  expect(() => sources.resolveRoot("root.c")).toThrow("deflate stream failed");
  expect(closed).toBe(false);
  const next = vfs.openRead("botfiles/root.c");
  expect(next?.file.slot).toBe(2);
});

test("large loose scripts reach source zone exhaustion before read and retain the partial handle", async () => {
  const { root, vfs, handles } = await mount(new Map([["botfiles/oversized.c", ""]]));
  truncateSync(join(root, "baseq3", "botfiles/oversized.c"), 128 * 1024 * 1024 + 1);
  const zone = new ZoneArena(32768);
  const owner = new BotMemory(undefined, zone);
  const sources = new BotScriptSources(vfs, new ScriptGlobalDefines(), unexpectedDiagnostic, unexpectedCommonPrint, owner);
  const available = zone.memoryRemaining();
  try {
    // LoadScriptFile requests script_t + length + NUL, then GetMemory adds its ID.
    // Z_TagMalloc includes its 20-byte block and four-byte sentinel, aligned to four.
    expect(() => sources.resolveRoot("oversized.c")).toThrow("Z_Malloc: failed on allocation of 134219908 bytes from the main zone");
    expect(handles.readCount).toBe(0);
    expect(vfs.openRead("botfiles/oversized.c")?.file.slot).toBe(2);
    expect(zone.memoryRemaining()).toBe(available);
    zone.checkHeap();
  } finally {
    sources.disposeResources();
    zone.dispose();
  }
});

test("shared handle exhaustion propagates as a drop rather than a missing include", async () => {
  const { vfs } = await mount(new Map([["botfiles/root.c", "token"]]));
  for (let index = 0; index < 63; index++) expect(vfs.openRead("botfiles/root.c")).toBeDefined();
  const sources = new BotScriptSources(vfs, new ScriptGlobalDefines(), unexpectedDiagnostic, unexpectedCommonPrint);
  expect(() => sources.resolveRoot("root.c")).toThrow(FileHandleExhaustionError);
  expect(() => sources.resolve({ kind: "quoted", fromPath: "root.c", requestedPath: "missing.h" }))
    .toThrow(FileHandleExhaustionError);
});

test("file reads and compression use the actual script allocation before token reads", async () => {
  const text = "one /* removed */ two";
  const { vfs } = await mount(new Map([["botfiles/root.c", text]]));
  const zone = new ZoneArena(16384);
  const owner = new BotMemory(undefined, zone);
  const allocations: BotMemoryAllocation[] = [];
  const events: string[] = [];
  const memory: ScriptMemory = {
    allocate(size, kind, clear) {
      events.push(`allocate:${size}:${clear}`);
      const allocation = owner.allocate(size, kind, clear);
      allocations.push(allocation);
      return allocation;
    },
    free(allocation) { events.push(`free:${allocations.indexOf(allocation)}`); owner.free(allocation); },
  };
  const sources = new BotScriptSources({
    openRead(path) { events.push("open"); return vfs.openRead(path); },
    readInto(file, bytes) {
      events.push("read");
      const allocation = allocations[0];
      if (allocation === undefined) throw new Error("script allocation must precede FS_Read");
      expect(bytes.buffer).toBe(allocation.bytes.buffer);
      expect(bytes.byteOffset).toBe(allocation.bytes.byteOffset + 2148);
      expect(bytes.byteLength).toBe(text.length);
      return vfs.readInto(file, bytes);
    },
    closeFile(file) {
      events.push("close");
      const allocation = allocations[0];
      if (allocation === undefined) throw new Error("script allocation missing at FS_FCloseFile");
      expect(new TextDecoder().decode(allocation.bytes.subarray(2148, 2148 + text.length))).toBe(text);
      vfs.closeFile(file);
    },
  }, new ScriptGlobalDefines(), unexpectedDiagnostic, unexpectedCommonPrint, memory);
  const source = sources.resolveRoot("root.c");
  if (!(source instanceof SourceScriptStorage)) throw new Error("file source must own its script allocation");
  expect(events).toEqual(["open", `allocate:${2148 + text.length + 1}:true`, "allocate:1024:false", "read", "close"]);
  expect(source.length).toBe(7);
  expect(source.buffer.length).toBe(text.length);
  expect(source.text).toBe("one two");
  const reader = ScriptSourceReader.open(source, sources);
  source.buffer[0] = 79;
  expect(reader.next()?.token.text).toBe("One");
  expect(reader.next()?.token.text).toBe("two");
  expect(reader.next()).toBeUndefined();
  expect(source.path).toBe("root.c");
  expect(events.slice(5)).toEqual(["allocate:3144:false", "allocate:4096:true"]);
  reader.dispose();
  expect(events.slice(7)).toEqual(["free:1", "free:0", "free:3", "free:2"]);
  expect(() => source.buffer).toThrow("freed");
  zone.checkHeap();
  zone.dispose();
});

test("a source read callback abort retains both script allocations and its open descriptor", async () => {
  const { vfs } = await mount(new Map([["botfiles/root.c", "value"]]));
  const zone = new ZoneArena(16384);
  const owner = new BotMemory(undefined, zone);
  const allocations: BotMemoryAllocation[] = [];
  const events: string[] = [];
  const memory: ScriptMemory = {
    allocate(size, kind, clear) {
      const allocation = owner.allocate(size, kind, clear);
      allocations.push(allocation);
      return allocation;
    },
    free(allocation) { events.push("free"); owner.free(allocation); },
  };
  const failure = new Error("read callback aborted");
  const sources = new BotScriptSources({
    openRead: path => vfs.openRead(path),
    readInto() { events.push("read"); throw failure; },
    closeFile(file) { events.push("close"); vfs.closeFile(file); },
  }, new ScriptGlobalDefines(), unexpectedDiagnostic, unexpectedCommonPrint, memory);
  expect(() => sources.resolveRoot("root.c")).toThrow(failure);
  expect(events).toEqual(["read"]);
  expect(allocations.map(allocation => allocation.bytes.length)).toEqual([2154, 1024]);
  expect(vfs.openRead("botfiles/root.c")?.file.slot).toBe(2);
  sources.disposeResources();
  expect(events).toEqual(["read"]);
  zone.checkHeap();
  zone.dispose();
});

test("source handles free popped includes and keep the root slot until FreeSource completes", async () => {
  const { vfs } = await mount(new Map([["root.pc", '#include "child.h"\nafter'], ["child.h", "inside"]]));
  const zone = new ZoneArena(32768);
  const owner = new BotMemory(undefined, zone);
  const allocations: BotMemoryAllocation[] = [];
  const freed: number[] = [];
  let inspectSlot = false;
  const memory: ScriptMemory = {
    allocate(size, kind, clear) {
      const allocation = owner.allocate(size, kind, clear);
      allocations.push(allocation);
      return allocation;
    },
    free(allocation) {
      if (inspectSlot) expect(() => sources.sourceFileAndLine(1)).toThrow("source script pointer");
      freed.push(allocations.indexOf(allocation));
      owner.free(allocation);
    },
  };
  const sources = new BotScriptSources(vfs, new ScriptGlobalDefines(), unexpectedDiagnostic, unexpectedCommonPrint, memory);
  const handle = sources.loadSourceHandle("root.pc");
  expect(handle).toBe(1);
  expect(sources.readTokenHandle(handle)?.token.text).toBe("inside");
  expect(freed).toEqual([]);
  expect(sources.readTokenHandle(handle)?.token.text).toBe("after");
  expect(freed).toEqual([5, 4]);
  expect(sources.readTokenHandle(handle)).toBeUndefined();
  expect(sources.sourceFileAndLine(handle)?.filename).toBe("root.pc");
  expect(freed).toEqual([5, 4]);
  inspectSlot = true;
  expect(sources.freeSourceHandle(handle)).toBe(true);
  inspectSlot = false;
  expect(freed).toEqual([5, 4, 1, 0, 3, 2]);
  expect(sources.sourceFileAndLine(handle)).toBeUndefined();
  expect(sources.freeSourceHandle(handle)).toBe(false);
  expect(sources.loadSourceHandle("root.pc")).toBe(1);
  sources.disposeResources();
  sources.disposeResources();
  expect(freed).toEqual([5, 4, 1, 0, 3, 2, 7, 6, 9, 8]);
  zone.checkHeap();
  zone.dispose();
});

test("include paths read the source record for system names and quoted fallback", async () => {
  const { vfs } = await mount(new Map([
    ["botfiles/root.c", '#include <system.h>\n#include "quoted.h"\n#include "primary.h"'],
    ["botfiles/defs/system.h", "system"], ["botfiles/alts/quoted.h", "quoted"],
    ["botfiles/primary.h", "primary"],
  ]));
  const zone = new ZoneArena(32768);
  const owner = new BotMemory(undefined, zone);
  const allocations: BotMemoryAllocation[] = [];
  const paths: string[] = [];
  const memory: ScriptMemory = {
    allocate(size, kind, clear) {
      const allocation = owner.allocate(size, kind, clear);
      allocations.push(allocation);
      return allocation;
    },
    free(allocation) { owner.free(allocation); },
  };
  const sources = new BotScriptSources({
    openRead(path) { paths.push(path); return vfs.openRead(path); },
    readInto: (file, bytes) => vfs.readInto(file, bytes),
    closeFile: file => vfs.closeFile(file),
  }, new ScriptGlobalDefines(), unexpectedDiagnostic, unexpectedCommonPrint, memory);
  const root = sources.resolveRoot("root.c");
  if (root === undefined) throw new Error("include-path source missing");
  const reader = ScriptSourceReader.open(root, sources);
  reader.setIncludePath("defs");
  const record = allocations[2];
  if (record === undefined) throw new Error("source record missing");
  expect(new TextDecoder().decode(record.bytes.subarray(1024, 1030))).toBe("defs/\0");
  expect(reader.next()?.token.text).toBe("system");
  record.bytes.set(new TextEncoder().encode("alts"), 1024);
  expect(reader.next()?.token.text).toBe("quoted");
  expect(reader.next()?.token.text).toBe("primary");
  expect(reader.next()).toBeUndefined();
  expect(paths).toEqual([
    "botfiles/root.c", "botfiles/defs/system.h", "botfiles/quoted.h", "botfiles/alts/quoted.h", "botfiles/primary.h",
  ]);
  reader.setIncludePath("");
  expect(Array.from(record.bytes.subarray(1024, 1026))).toEqual([47, 0]);
  reader.dispose();
  zone.checkHeap();
  zone.dispose();
});
