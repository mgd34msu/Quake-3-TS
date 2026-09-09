import { expect, test } from "bun:test";
import { ReadFileMemory } from "../src/assets/read-file-memory.ts";
import { HunkArena, initializeHunk } from "../src/core/hunk.ts";
import { ZoneArena, ZoneTag } from "../src/core/zone.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("FS retained files block hunk initialization until their pre-hunk buffers are freed", () => {
  let arena: HunkArena | null = null;
  const zone = new ZoneArena(256);
  const memory = new ReadFileMemory(() => arena, () => zone);
  const file = memory.read(3, bytes => {
    expect(memory.loadStack).toBe(1);
    expect([...bytes]).toEqual([0, 0, 0]);
    bytes.set([65, 0, 66]);
  });
  expect([...file.bytes]).toEqual([65, 0, 66]);
  expect([...file.terminatedBytes]).toEqual([65, 0, 66, 0]);
  expect(zone.memoryRemaining()).toBe(228);
  const initialize = (): HunkArena => initializeHunk({ megs: 1, dedicated: true, filesystemLoadStack: memory.loadStack },
    () => undefined, { kind: "dedicated", shutdownGameProgs() {}, clearVm() {} });
  expect(initialize).toThrow("File system load stack not zero");
  memory.freeFile(file);
  expect(zone.memoryRemaining()).toBe(256);
  expect(() => file.bytes).toThrow("no longer valid");
  arena = initialize();
  const hunkFile = memory.read(3, bytes => bytes.set([7, 8, 9]));
  expect(arena.snapshot().high.temp).toBe(12);
  expect([...hunkFile.terminatedBytes]).toEqual([7, 8, 9, 0]);
  memory.freeFile(hunkFile);
  expect(arena.snapshot().high.temp).toBe(0);
  expect(memory.loadCount).toBe(2);
  zone.dispose();
});

test("pre-hunk files use actual zeroed TAG_GENERAL storage and source Z_Free poisoning", () => {
  const zone = new ZoneArena(256);
  const dirty = zone.allocate(4, ZoneTag.General);
  const cached = dirty.bytes;
  cached.fill(91);
  zone.free(dirty);
  const memory = new ReadFileMemory(() => null, () => zone);
  const file = memory.read(3, bytes => {
    expect(bytes.buffer).toBe(cached.buffer);
    expect(bytes.byteOffset).toBe(cached.byteOffset);
    expect([...bytes]).toEqual([0, 0, 0]);
    bytes.set([65, 0, 66]);
  });
  const allocation = file.terminatedBytes;
  const view = new DataView(allocation.buffer);
  expect(view.getInt32(allocation.byteOffset - 16, true)).toBe(ZoneTag.General);
  expect(view.getInt32(allocation.byteOffset - 8, true)).toBe(8);
  expect(view.getInt32(allocation.byteOffset - 4, true)).toBe(0x1d4a11);
  expect([...allocation]).toEqual([65, 0, 66, 0]);
  expect(zone.memoryRemaining()).toBe(228);
  memory.freeFile(file);
  expect([...allocation]).toEqual([0xaa, 0xaa, 0xaa, 0xaa]);
  expect(zone.memoryRemaining()).toBe(256);
  expect(() => file.bytes).toThrow("no longer valid");
  zone.checkHeap();
  zone.dispose();
});

test("pre-hunk zone allocation and read failures retain source counter positions and allocated bytes", () => {
  for (const origin of ["filesystem", "journal"] satisfies readonly ("filesystem" | "journal")[]) {
    const zone = new ZoneArena(256);
    const memory = new ReadFileMemory(() => null, () => zone);
    const observation: { written: Uint8Array | null } = { written: null };
    expect(() => memory.read(3, bytes => {
      observation.written = bytes;
      bytes[0] = 12;
      expect(memory.loadStack).toBe(origin === "filesystem" ? 1 : 0);
      throw new Error("read failed");
    }, origin)).toThrow("read failed");
    expect(memory.loadCount).toBe(origin === "filesystem" ? 1 : 0);
    expect(zone.memoryRemaining()).toBe(228);
    expect(observation.written).toEqual(new Uint8Array([12, 0, 0]));
    memory.disposeResources();
    expect(zone.memoryRemaining()).toBe(228);
    expect(memory.loadStack).toBe(origin === "filesystem" ? 1 : 0);
    zone.dispose();

    const tinyZone = new ZoneArena(64);
    const exhausted = new ReadFileMemory(() => null, () => tinyZone);
    expect(() => exhausted.read(32, () => undefined, origin)).toThrow("Z_Malloc: failed on allocation of 60 bytes from the main zone");
    expect(exhausted.loadStack).toBe(origin === "filesystem" ? 1 : 0);
    expect(exhausted.loadCount).toBe(origin === "filesystem" ? 1 : 0);
    expect(tinyZone.memoryRemaining()).toBe(64);
    tinyZone.dispose();
  }
});

test("freeing a pre-hunk zone file after hunk availability changes retains the fatal source residue", () => {
  const zone = new ZoneArena(256);
  let arena: HunkArena | null = null;
  const memory = new ReadFileMemory(() => arena, () => zone);
  const file = memory.read(3, bytes => bytes.set([7, 8, 9]));
  arena = new HunkArena(128, () => undefined);
  const temporary = arena.allocateTemp(4);
  temporary.bytes.fill(71);
  expect(() => memory.freeFile(file)).toThrow("Hunk_FreeTempMemory: bad magic");
  expect(memory.loadStack).toBe(0);
  expect(memory.loadCount).toBe(1);
  expect(zone.memoryRemaining()).toBe(228);
  expect([...file.terminatedBytes]).toEqual([7, 8, 9, 0]);
  expect(arena.snapshot().high.temp).toBe(12);
  expect(temporary.bytes[0]).toBe(71);
  memory.disposeResources();
  expect(() => file.bytes).toThrow("no longer valid");
  expect(zone.memoryRemaining()).toBe(228);
  zone.dispose();
});

test("failed zone frees decrement the file stack before validation without retiring the source buffer", () => {
  const zone = new ZoneArena(256);
  const memory = new ReadFileMemory(() => null, () => zone);
  const file = memory.read(3, bytes => bytes.fill(17));
  const bytes = file.terminatedBytes;
  const view = new DataView(bytes.buffer);
  view.setInt32(bytes.byteOffset + 4, 0, true);
  expect(() => memory.freeFile(file)).toThrow("Z_Free: memory block wrote past end");
  expect(memory.loadStack).toBe(0);
  expect(zone.memoryRemaining()).toBe(228);
  expect([...file.terminatedBytes]).toEqual([17, 17, 17, 0]);
  memory.disposeResources();
  expect(() => file.bytes).toThrow("no longer valid");
  expect(zone.memoryRemaining()).toBe(228);
  zone.dispose();
});

test("FS frees actual shared hunk storage in source order and clears temp only at zero", () => {
  const printed: string[] = [];
  const arena = new HunkArena(128, text => { printed.push(text); });
  const memory = new ReadFileMemory(() => arena);
  const first = memory.read(3, bytes => bytes.fill(17));
  const second = memory.read(3, bytes => bytes.fill(29));
  const temporary = arena.allocateTemp(4);
  temporary.bytes.fill(71);
  expect(first.bytes.buffer).toBe(second.bytes.buffer);
  expect(second.bytes.buffer).toBe(temporary.bytes.buffer);
  expect(arena.snapshot().high.temp).toBe(36);
  memory.freeFile(first);
  expect(memory.loadStack).toBe(1);
  expect(arena.snapshot().high.temp).toBe(36);
  expect(temporary.bytes[0]).toBe(71);
  memory.freeFile(second);
  expect(memory.loadStack).toBe(0);
  expect(arena.snapshot().high.temp).toBe(0);
  expect(arena.snapshot().high.tempHighwater).toBe(36);
  expect(printed).toEqual(["Hunk_FreeTempMemory: not the final block\n", "Hunk_FreeTempMemory: not the final block\n"]);
  expect(() => temporary.bytes).toThrow("no longer valid");
  expect(() => memory.freeFile(second)).toThrow("invalid or freed buffer");
});

test("normal and journal FS failures retain their different source counter positions", () => {
  for (const origin of ["filesystem", "journal"] satisfies readonly ("filesystem" | "journal")[]) {
    const arena = new HunkArena(128, () => undefined);
    const memory = new ReadFileMemory(() => arena);
    expect(() => memory.read(2, bytes => {
      bytes[0] = 12;
      expect(memory.loadStack).toBe(origin === "filesystem" ? 1 : 0);
      throw new Error("read failed");
    }, origin)).toThrow("read failed");
    expect(memory.loadCount).toBe(origin === "filesystem" ? 1 : 0);
    expect(arena.snapshot().high.temp).toBe(12);
  }
  const tinyArena = new HunkArena(32, () => undefined);
  const memory = new ReadFileMemory(() => tinyArena);
  expect(() => memory.read(32, () => undefined)).toThrow("Hunk_AllocateTempMemory");
  expect(memory.loadStack).toBe(1);
});

test("mounted FS reads expose their actual hunk allocation and keep detached adapters separate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "q3-read-file-memory-"));
  const arena = new HunkArena(128, () => undefined), memory = new ReadFileMemory(() => arena);
  mkdirSync(join(directory, "baseq3"));
  writeFileSync(join(directory, "baseq3", "sample.cfg"), new Uint8Array([65, 0, 66]));
  const files = await VirtualFileSystem.openTracked({ dataPath: directory, homePath: directory, cdPath: null,
    product: "baseq3", references: { checksumFeed: 0, random: () => 0 }, fileMemory: memory });
  try {
    expect(files.readFileLength("sample.cfg")).toBe(3);
    expect(files.readFileRetainedSync("missing.cfg")).toBeUndefined();
    expect(memory.loadStack).toBe(0);
    const retained = files.readFileRetainedSync("sample.cfg");
    if (retained === undefined) throw new Error("Fixture file missing");
    expect([...retained.terminatedBytes]).toEqual([65, 0, 66, 0]);
    expect(arena.snapshot().high.temp).toBe(12);
    const detached = files.readFileOptionalSync("sample.cfg");
    expect(detached).toEqual(retained.bytes);
    expect(detached?.buffer).not.toBe(retained.bytes.buffer);
    expect(memory.loadStack).toBe(1);
    files.freeFile(retained);
    expect(arena.snapshot().high.temp).toBe(0);
    const abandoned = files.readFileRetainedSync("sample.cfg");
    if (abandoned === undefined) throw new Error("Fixture file missing");
    const beforeDisposal = arena.snapshot();
    files.close();
    expect(memory.loadStack).toBe(1);
    expect(abandoned.bytes[0]).toBe(65);
    memory.disposeResources();
    expect(memory.loadStack).toBe(1);
    expect(arena.snapshot()).toEqual(beforeDisposal);
    expect(() => abandoned.bytes).toThrow("no longer valid");
  } finally {
    files.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
