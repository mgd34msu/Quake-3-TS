import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonError } from "../src/core/common-error.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { FileHandleExhaustionError, SourceFileHandles } from "../src/assets/file-handles.ts";
import { PakReferenceFlag } from "../src/assets/pak-references.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import type { OpenedRead, VfsTrackedSearchOptions } from "../src/assets/vfs.ts";
import { sourceZip } from "./pk3-source-fixture.ts";

const roots: string[] = [];
const tables: SourceFileHandles[] = [];
const views: VirtualFileSystem[] = [];
const encoder = new TextEncoder();

afterEach(() => {
  for (const view of views.splice(0)) view.close();
  for (const table of tables.splice(0)) table.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { readonly root: string; readonly directory: string; readonly handles: SourceFileHandles; readonly options: VfsTrackedSearchOptions } {
  const root = mkdtempSync(join(tmpdir(), "quake3-source-handles-"));
  roots.push(root);
  const directory = join(root, "baseq3");
  mkdirSync(directory);
  writeFileSync(join(directory, "test.arena"), "0123456");
  writeFileSync(join(directory, "test.game"), "game");
  writeFileSync(join(directory, "empty.dat"), "");
  const handles = new SourceFileHandles();
  tables.push(handles);
  return { root, directory, handles, options: { dataPath: root, homePath: root, cdPath: null, product: "baseq3", handles,
    references: { checksumFeed: 0, random: () => 0 } } };
}

async function mount(options: VfsTrackedSearchOptions): Promise<VirtualFileSystem> {
  const view = await VirtualFileSystem.openTracked(options);
  views.push(view);
  return view;
}

function opened(view: VirtualFileSystem, path: string): OpenedRead {
  const result = view.openRead(path);
  if (result === undefined) throw new Error(`Missing fixture: ${path}`);
  return result;
}

describe("source filesystem handles", () => {
  test("selects without reserving, exhausts before lookup, reuses slot17 identity and rejects foreign handles", async () => {
    const { options, handles } = fixture();
    const view = await mount(options);
    expect(handles.selectFree()).toBe(handles.selectFree());
    const retained = Array.from({ length: 63 }, () => opened(view, "test.arena"));
    expect(retained.map(entry => entry.file.slot)).toEqual(Array.from({ length: 63 }, (_, index) => index + 1));
    for (const path of ["test.arena", "missing.dat"]) {
      expect(() => view.openRead(path)).toThrow(FileHandleExhaustionError);
      expect(() => view.fileLength(path)).toThrow(FileHandleExhaustionError);
      expect(() => view.readSync(path)).toThrow(CommonError);
      await expect(view.read(path)).rejects.toThrow(FileHandleExhaustionError);
    }
    expect(view.has("test.arena")).toBe(true);
    expect(view.has("missing.dat")).toBe(false);
    const slot17 = retained[16];
    if (slot17 === undefined) throw new Error("Fixture needs slot17");
    view.closeFile(slot17.file);
    view.closeFile(slot17.file);
    const reused = opened(view, "test.game");
    expect(reused.file).toBe(slot17.file);
    const bytes = new Uint8Array(8).fill(0x7e);
    expect(view.readInto(slot17.file, bytes)).toBe(4);
    expect(new TextDecoder().decode(bytes)).toBe("game~~~~");
    const foreign = new SourceFileHandles();
    tables.push(foreign);
    expect(() => foreign.closeFile(reused.file)).toThrow("different filesystem");
    expect(() => foreign.readInto(reused.file, bytes)).toThrow("different filesystem");
  });

  test("opens a loose descriptor once, advances arena RNG once, and reads the original file after path replacement", async () => {
    const { options, directory, handles } = fixture();
    let randomCalls = 0;
    const random = new LinuxNativeRandom(1);
    const view = await mount({ ...options, references: { checksumFeed: 0, random: () => {
      randomCalls++;
      return Math.fround((random.next() & 0x7fff) / 32767);
    } } });
    expect(view.has("test.arena")).toBe(true);
    view.source("test.arena");
    view.list();
    expect(randomCalls).toBe(0);
    const arena = opened(view, "test.arena");
    expect(arena.length).toBe(7);
    expect(randomCalls).toBe(1);
    renameSync(join(directory, "test.arena"), join(directory, "original.arena"));
    writeFileSync(join(directory, "test.arena"), "replacement");
    const first = new Uint8Array(4).fill(0x7e);
    const second = new Uint8Array(8).fill(0x7e);
    expect(view.readInto(arena.file, first)).toBe(4);
    expect(view.readInto(arena.file, second)).toBe(3);
    expect(new TextDecoder().decode(first)).toBe("0123");
    expect(new TextDecoder().decode(second)).toBe("456~~~~~");
    expect(handles.readCount).toBe(12);
    expect(randomCalls).toBe(1);
    view.closeFile(arena.file);
    const game = opened(view, "test.game");
    expect(game.length).toBe(4);
    view.readInto(game.file, first);
    view.closeFile(game.file);
    expect(randomCalls).toBe(1);
    expect(random.next()).toBe(846_930_886);
  });

  test("retained loose cursors observe growth and shrink without clearing short tails", async () => {
    const { options, directory } = fixture();
    const view = await mount(options);
    const growing = opened(view, "test.arena");
    appendFileSync(join(directory, "test.arena"), "89");
    const bytes = new Uint8Array(12).fill(0x7e);
    expect(view.readInto(growing.file, bytes)).toBe(9);
    expect(growing.length).toBe(7);
    expect(new TextDecoder().decode(bytes)).toBe("012345689~~~");
    view.closeFile(growing.file);
    const shrinking = opened(view, "test.arena");
    truncateSync(join(directory, "test.arena"), 3);
    bytes.fill(0x7e);
    expect(view.readInto(shrinking.file, bytes)).toBe(3);
    expect(shrinking.length).toBe(9);
    expect(new TextDecoder().decode(bytes)).toBe("012~~~~~~~~~");
  });

  test("source restart closes positive ByMode rows and preserves empty/direct/write rows on the same owner", async () => {
    const { options, handles, directory } = fixture();
    const oldView = await mount(options);
    const positive = opened(oldView, "test.arena");
    const empty = opened(oldView, "empty.dat");
    const direct = handles.selectFree();
    handles.attachLooseRead(direct, openSync(join(directory, "test.game"), "r"));
    const write = handles.selectFree();
    const descriptor = openSync(join(directory, "log.txt"), "w");
    const lifetime = handles.attachWrite(write, descriptor, false, false);
    expect(handles.seekWrite(write, 3, "set")).toBe(0);
    handles.closeSizedFiles();
    oldView.retire();
    const next = await mount(options);
    expect(() => next.readInto(positive.file, new Uint8Array(1))).toThrow("not readable");
    expect(next.readInto(empty.file, new Uint8Array(4).fill(0x7e))).toBe(0);
    expect(next.readInto(direct, new Uint8Array(4))).toBe(4);
    expect(handles.writeDescriptor(write)).toBe(descriptor);
    expect(handles.tellWrite(write)).toBe(3);
    expect(fstatSync(descriptor).isFile()).toBe(true);
    expect(lifetime.closed).toBe(false);
    next.closeFile(write);
    expect(lifetime.closed).toBe(true);
    expect(() => fstatSync(descriptor)).toThrow();
    const replacement = opened(next, "test.game");
    expect(replacement.file).toBe(positive.file);
    handles.close();
    expect(handles.closed).toBe(true);
    expect(() => next.has("test.game")).toThrow("closed");
  });

  test("retired views reject every operation before mutating references", async () => {
    const { options, handles } = fixture();
    let randomCalls = 0;
    const view = await mount({ ...options, references: { checksumFeed: 0, random: () => { randomCalls++; return 0; } } });
    const empty = opened(view, "empty.dat");
    view.retire();
    expect(() => view.has("test.arena")).toThrow("retired");
    expect(() => view.source("test.arena")).toThrow("retired");
    expect(() => view.list()).toThrow("retired");
    expect(() => view.fileLength("test.arena")).toThrow("retired");
    expect(() => view.openRead("test.arena")).toThrow("retired");
    expect(() => view.readSync("test.arena")).toThrow("retired");
    await expect(view.read("test.arena")).rejects.toThrow("retired");
    expect(() => view.readInto(empty.file, new Uint8Array(1))).toThrow("retired");
    expect(() => view.closeFile(empty.file)).toThrow("retired");
    expect(randomCalls).toBe(0);
    handles.closeFile(empty.file);
  });

  test("rejects synthetic credential qpaths before lookup and excludes symlink ancestors", async () => {
    const { options, root, directory } = fixture();
    const view = await mount(options);
    for (const path of ["Q3KEY", "scripts/Quake3CDKey.cfg", "scripts/prefixq3key-suffix"]) {
      expect(view.has(path)).toBe(false);
      expect(view.source(path)).toBeUndefined();
      expect(view.openRead(path)).toBeUndefined();
      expect(view.fileLength(path)).toBe(-1);
      expect(() => view.readSync(path)).toThrow("Asset not found");
    }
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "ordinary.txt"), "outside");
    symlinkSync(outside, join(directory, "link"));
    expect(view.has("link/ordinary.txt")).toBe(false);
    expect(view.openRead("link/ordinary.txt")).toBeUndefined();
    expect(() => view.openRead("../outside/ordinary.txt")).toThrow(RangeError);
  });

  test("packed handles retain independent cursors and mark references before local-header failure", async () => {
    const { options, directory, handles } = fixture();
    const archivePath = join(directory, "pak0.pk3");
    writeFileSync(archivePath, sourceZip([
      { name: encoder.encode("vm/cgame.qvm"), data: encoder.encode("0123456"), method: 8, utf8: false },
      { name: encoder.encode("empty.bin"), data: new Uint8Array(), method: 0, utf8: false },
    ]));
    const view = await VirtualFileSystem.openTracked(options);
    views.push(view);
    const first = opened(view, "vm/cgame.qvm");
    const second = opened(view, "vm/cgame.qvm");
    const prefix = new Uint8Array(4);
    expect(view.readInto(first.file, prefix)).toBe(4);
    expect(new TextDecoder().decode(prefix)).toBe("0123");
    expect(view.readInto(second.file, prefix)).toBe(4);
    expect(new TextDecoder().decode(prefix)).toBe("0123");
    const tail = new Uint8Array(8).fill(0x7e);
    expect(view.readInto(first.file, tail)).toBe(3);
    expect(new TextDecoder().decode(tail)).toBe("456~~~~~");
    const empty = opened(view, "empty.bin");
    handles.closeSizedFiles();
    view.retire();
    const next = await mount(options);
    expect(next.readInto(empty.file, prefix)).toBe(0);
    next.closeFile(empty.file);
    const broken = sourceZip([{ name: encoder.encode("vm/ui.qvm"), data: encoder.encode("ui"), method: 0, utf8: false }]);
    broken[0] = 0;
    writeFileSync(archivePath, broken);
    const corrupt = await VirtualFileSystem.openTracked(options);
    views.push(corrupt);
    expect(() => corrupt.openRead("vm/ui.qvm")).toThrow();
    expect(corrupt.pakReferences.snapshot()[0]?.flags).toBe(PakReferenceFlag.General | PakReferenceFlag.Ui);
    expect(handles.selectFree().slot).toBe(1);
  });

  test("direct synchronous and Promise reads acquire, reference and close once per call", async () => {
    const { options, handles } = fixture();
    let randomCalls = 0;
    const view = await mount({ ...options, references: { checksumFeed: 0, random: () => { randomCalls++; return 0; } } });
    expect(view.fileLength("test.arena")).toBe(7);
    expect(randomCalls).toBe(1);
    expect(handles.selectFree().slot).toBe(1);
    expect(new TextDecoder().decode(view.readSync("test.arena"))).toBe("0123456");
    expect(randomCalls).toBe(2);
    const promise = view.read("test.arena");
    expect(randomCalls).toBe(3);
    expect(handles.selectFree().slot).toBe(1);
    expect(new TextDecoder().decode(await promise)).toBe("0123456");
    expect(handles.readCount).toBe(14);
  });

  test("failed acquisition releases only its opened slot and preserves the original source error", async () => {
    const { options, handles } = fixture();
    const failure = new CommonError("drop", "fixture acquisition failure");
    const view = await mount({ ...options, references: { checksumFeed: 0, random: () => { throw failure; } } });
    const surviving = opened(view, "test.game");
    expect(() => view.openRead("test.arena")).toThrow(failure);
    expect(handles.selectFree().slot).toBe(2);
    const bytes = new Uint8Array(4);
    expect(view.readInto(surviving.file, bytes)).toBe(4);
    expect(new TextDecoder().decode(bytes)).toBe("game");
  });

  test("empty packed whole-file reads validate CRC while retained zero-byte reads stay lazy", async () => {
    const methods: readonly (0 | 8)[] = [0, 8];
    for (const method of methods) {
      const { options, directory, handles } = fixture();
      const bytes = sourceZip([
        { name: encoder.encode("empty.bin"), data: new Uint8Array(), method, utf8: false },
      ]);
      const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const centralOffset = data.getUint32(bytes.byteLength - 6, true);
      data.setUint32(14, 1, true);
      data.setUint32(centralOffset + 16, 1, true);
      writeFileSync(join(directory, "pak0.pk3"), bytes);
      const view = await mount(options);
      const retained = opened(view, "empty.bin");
      expect(retained.length).toBe(0);
      expect(view.readInto(retained.file, new Uint8Array())).toBe(0);
      view.closeFile(retained.file);
      expect(view.fileLength("empty.bin")).toBe(0);
      expect(handles.readCount).toBe(0);
      expect(() => view.readSync("empty.bin")).toThrow("CRC");
      expect(handles.selectFree().slot).toBe(1);
      await expect(view.read("empty.bin")).rejects.toThrow("CRC");
      expect(handles.selectFree().slot).toBe(1);
      expect(handles.readCount).toBe(0);
    }
  });

  test.skipIf(process.platform !== "linux")("standalone close releases real descriptors while a borrowed table survives view close", async () => {
    const { options, directory, handles } = fixture();
    const targets = new Set([join(directory, "empty.dat"), join(directory, "test.arena"), join(directory, "pak0.pk3")]);
    function fixtureDescriptorCount(): number {
      let count = 0;
      for (const name of readdirSync("/proc/self/fd")) {
        try { if (targets.has(readlinkSync(`/proc/self/fd/${name}`))) count++; }
        catch (error) {
          if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
        }
      }
      return count;
    }
    writeFileSync(join(directory, "pak0.pk3"), sourceZip([
      { name: encoder.encode("packed.dat"), data: encoder.encode("packed"), method: 8, utf8: false },
    ]));
    const standalone = await VirtualFileSystem.openInspection(options);
    views.push(standalone);
    opened(standalone, "empty.dat");
    opened(standalone, "test.arena");
    standalone.readSync("packed.dat");
    expect(fixtureDescriptorCount()).toBe(3);
    standalone.close();
    standalone.close();
    expect(fixtureDescriptorCount()).toBe(0);
    const borrowed = await mount(options);
    const empty = opened(borrowed, "empty.dat");
    borrowed.close();
    expect(handles.closed).toBe(false);
    expect(fixtureDescriptorCount()).toBe(1);
    const next = await mount(options);
    expect(next.readInto(empty.file, new Uint8Array(1))).toBe(0);
    next.closeFile(empty.file);
    expect(fixtureDescriptorCount()).toBe(0);
  });
});
