import { expect, test } from "bun:test";
import { CommonError } from "../src/core/common-error.ts";
import type { CommonErrorCode } from "../src/core/common-error.ts";
import { ZoneArena, ZoneTag } from "../src/core/zone.ts";

function sourceError(run: () => void, code: CommonErrorCode, message: string): void {
  try { run(); throw new Error("Expected source allocation error"); }
  catch (error) {
    expect(error).toBeInstanceOf(CommonError);
    if (!(error instanceof CommonError)) throw error;
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
  }
}

test("release32 zone words, linked headers and trash marker occupy the actual allocation buffer", () => {
  const zone = new ZoneArena(256);
  expect(zone.memoryRemaining()).toBe(256);
  const allocation = zone.allocate(1, ZoneTag.Botlib);
  expect(allocation.bytes.byteOffset).toBe(52);
  expect(allocation.bytes.length).toBe(1);
  const view = new DataView(allocation.bytes.buffer);
  const words: number[] = [];
  for (let offset = 0; offset < 80; offset += 4) words.push(view.getInt32(offset, true));
  expect(words).toEqual([
    256, 28, 0, 1, 32, 60, 0, 60,
    28, 2, 60, 8, 0x1d4a11, 0, 0x1d4a11,
    196, 0, 8, 32, 0x1d4a11,
  ]);
  expect(zone.memoryRemaining()).toBe(228);
  zone.checkHeap();
});

test("source split threshold is strictly greater than 64 and tiny fragments are charged", () => {
  const exact = new ZoneArena(128);
  const exactAllocation = exact.allocate(8, ZoneTag.General);
  const exactView = new DataView(exactAllocation.bytes.buffer);
  expect(exactView.getInt32(32, true)).toBe(96);
  expect(exactView.getUint32(28, true)).toBe(8);
  expect(exactView.getInt32(124, true)).toBe(0x1d4a11);
  expect(exact.memoryRemaining()).toBe(32);
  const split = new ZoneArena(132);
  const splitAllocation = split.allocate(8, ZoneTag.General);
  const splitView = new DataView(splitAllocation.bytes.buffer);
  expect(splitView.getInt32(32, true)).toBe(32);
  expect(splitView.getInt32(64, true)).toBe(68);
  expect(splitView.getUint32(28, true)).toBe(64);
  expect(split.memoryRemaining()).toBe(100);
  exact.checkHeap();
  split.checkHeap();
});

test("free poisons padding and marker while no-clear reuse and exact payload clearing preserve those bytes", () => {
  const zone = new ZoneArena(256);
  const original = zone.allocate(5, ZoneTag.Botlib);
  const cached = original.bytes;
  const raw = new Uint8Array(cached.buffer);
  cached.fill(7);
  zone.free(original);
  expect([...raw.subarray(52, 64)]).toEqual(Array<number>(12).fill(0xaa));
  expect(() => original.bytes).toThrow("Zone allocation is no longer valid");
  const reused = zone.allocate(5, ZoneTag.Renderer);
  expect(reused.bytes.byteOffset).toBe(52);
  expect([...reused.bytes]).toEqual(Array<number>(5).fill(0xaa));
  sourceError(() => zone.free(original), "fatal", "Z_Free: freed a freed pointer");
  zone.free(reused);
  const cleared = zone.allocate(5, ZoneTag.General, true);
  expect([...cleared.bytes]).toEqual([0, 0, 0, 0, 0]);
  expect([...raw.subarray(57, 60)]).toEqual([0xaa, 0xaa, 0xaa]);
  expect(new DataView(raw.buffer).getInt32(60, true)).toBe(0x1d4a11);
});

test("free merges previous and next free blocks, retains detached header bytes and retires all handles", () => {
  const zone = new ZoneArena(512);
  const a = zone.allocate(16, ZoneTag.General);
  const b = zone.allocate(16, ZoneTag.Botlib);
  const c = zone.allocate(16, ZoneTag.Renderer);
  const d = zone.allocate(16, ZoneTag.General);
  const view = new DataView(a.bytes.buffer);
  zone.free(b);
  zone.free(d);
  zone.free(c);
  expect(view.getInt32(72, true)).toBe(440);
  expect(view.getUint32(28, true)).toBe(72);
  expect(view.getUint32(40, true)).toBe(72);
  expect(view.getUint32(20, true)).toBe(72);
  expect(view.getInt32(112, true)).toBe(40);
  expect(view.getInt32(116, true)).toBe(0);
  expect(zone.memoryRemaining()).toBe(472);
  zone.checkHeap();
  zone.free(a);
  expect(view.getInt32(32, true)).toBe(480);
  expect(view.getUint32(28, true)).toBe(32);
  expect(view.getUint32(16, true)).toBe(32);
  expect(view.getUint32(20, true)).toBe(32);
  expect(zone.memoryRemaining()).toBe(512);
  for (const allocation of [a, b, c, d]) expect(() => allocation.bytes).toThrow("no longer valid");
  zone.checkHeap();
});

test("rover first fit starts at the last freed block, wraps and fails despite separated free capacity", () => {
  const zone = new ZoneArena(512);
  const a = zone.allocate(16, ZoneTag.General);
  zone.allocate(16, ZoneTag.General);
  const c = zone.allocate(16, ZoneTag.General);
  zone.allocate(16, ZoneTag.General);
  zone.allocate(296, ZoneTag.General);
  const view = new DataView(a.bytes.buffer);
  zone.free(a);
  zone.free(c);
  expect(zone.memoryRemaining()).toBe(112);
  const before = new Uint8Array(view.buffer).slice();
  sourceError(() => zone.allocate(17, ZoneTag.General), "fatal", "Z_Malloc: failed on allocation of 44 bytes from the main zone");
  expect(new Uint8Array(view.buffer)).toEqual(before);
  expect(zone.allocate(16, ZoneTag.General).bytes.byteOffset).toBe(132);
  expect(zone.allocate(16, ZoneTag.General).bytes.byteOffset).toBe(52);
  expect(zone.memoryRemaining()).toBe(32);
  zone.checkHeap();
});

test("Z_FreeTags follows its mutating rover, coalesces matches and leaves the rover at the sentinel", () => {
  const zone = new ZoneArena(512);
  const a = zone.allocate(16, ZoneTag.General);
  const b = zone.allocate(16, ZoneTag.Botlib);
  const c = zone.allocate(16, ZoneTag.Botlib);
  const d = zone.allocate(16, ZoneTag.Renderer);
  const e = zone.allocate(16, ZoneTag.Botlib);
  const view = new DataView(a.bytes.buffer);
  zone.freeTags(ZoneTag.Botlib);
  expect(zone.memoryRemaining()).toBe(432);
  expect(view.getInt32(72, true)).toBe(80);
  expect(view.getInt32(192, true)).toBe(320);
  expect(view.getUint32(28, true)).toBe(8);
  for (const allocation of [b, c, e]) expect(() => allocation.bytes).toThrow("no longer valid");
  expect(a.bytes.length).toBe(16);
  expect(d.bytes.length).toBe(16);
  zone.freeTags(23);
  expect(view.getUint32(28, true)).toBe(8);
  zone.freeTags(ZoneTag.General);
  zone.freeTags(ZoneTag.Renderer);
  expect(zone.memoryRemaining()).toBe(512);
  zone.checkHeap();
  sourceError(() => zone.freeTags(ZoneTag.Free), "fatal", "Z_Free: freed a freed pointer");
});

test("Z_Free checks ID, free tag and marker in source order before changing the allocation", () => {
  const zone = new ZoneArena(256);
  const allocation = zone.allocate(8, ZoneTag.Botlib);
  const view = new DataView(allocation.bytes.buffer);
  view.setInt32(48, 0, true);
  view.setInt32(36, 0, true);
  view.setInt32(60, 0, true);
  sourceError(() => zone.free(allocation), "fatal", "Z_Free: freed a pointer without ZONEID");
  view.setInt32(48, 0x1d4a11, true);
  sourceError(() => zone.free(allocation), "fatal", "Z_Free: freed a freed pointer");
  view.setInt32(36, ZoneTag.Botlib, true);
  sourceError(() => zone.free(allocation), "fatal", "Z_Free: memory block wrote past end");
  expect(zone.memoryRemaining()).toBe(224);
  expect(allocation.bytes.length).toBe(8);
  view.setInt32(60, 0x1d4a11, true);
  zone.free(allocation);
  sourceError(() => zone.free(null), "drop", "Z_Free: NULL pointer");
  sourceError(() => zone.free({ bytes: new Uint8Array(1) }), "fatal", "Z_Free: freed a pointer without ZONEID");
  sourceError(() => zone.allocate(1, 0), "fatal", "Z_TagMalloc: tried to use a 0 tag");
});

test("Z_CheckHeap reports size, backlink and adjacent free corruption with the source messages", () => {
  const zone = new ZoneArena(256);
  const first = zone.allocate(8, ZoneTag.General);
  zone.allocate(8, ZoneTag.General);
  const view = new DataView(first.bytes.buffer);
  view.setInt32(32, 36, true);
  sourceError(() => zone.checkHeap(), "fatal", "Z_CheckHeap: block size does not touch the next block\n");
  view.setInt32(32, 32, true);
  view.setUint32(76, 8, true);
  sourceError(() => zone.checkHeap(), "fatal", "Z_CheckHeap: next block doesn't have proper back link\n");
  view.setUint32(76, 32, true);
  view.setInt32(36, 0, true);
  view.setInt32(68, 0, true);
  sourceError(() => zone.checkHeap(), "fatal", "Z_CheckHeap: two consecutive free blocks\n");
});

test("invalid pointer words, cyclic links and out-of-range extents reject without accessing external storage", () => {
  const zone = new ZoneArena(256);
  const allocation = zone.allocate(8, ZoneTag.General);
  const view = new DataView(allocation.bytes.buffer);
  view.setUint32(28, 0xffffffff, true);
  expect(() => zone.allocate(1, ZoneTag.General)).toThrow("invalid block pointer");
  view.setUint32(28, 64, true);
  view.setUint32(72, 64, true);
  expect(() => zone.allocate(1000, ZoneTag.General)).toThrow("corrupt block list");
  view.setUint32(72, 8, true);
  view.setInt32(32, 1000, true);
  expect(() => zone.free(allocation)).toThrow("invalid block size");
  expect(zone.memoryRemaining()).toBe(224);
});

test("zero-size, odd-capacity and small-zone allocations retain the source byte accounting", () => {
  const tiny = new ZoneArena(56, "small");
  const empty = tiny.allocate(0, ZoneTag.Small);
  expect(empty.bytes.length).toBe(0);
  expect(empty.bytes.byteOffset).toBe(52);
  expect(tiny.memoryRemaining()).toBe(32);
  sourceError(() => tiny.allocate(1, ZoneTag.Small), "fatal", "Z_Malloc: failed on allocation of 28 bytes from the small zone");
  tiny.freeTags(ZoneTag.Small);
  expect(tiny.memoryRemaining()).toBe(56);
  const odd = new ZoneArena(133);
  const first = odd.allocate(8, ZoneTag.General);
  const second = odd.allocate(1, ZoneTag.General);
  expect(new DataView(first.bytes.buffer).getInt32(129, true)).toBe(0x1d4a11);
  expect(odd.memoryRemaining()).toBe(32);
  odd.free(first);
  odd.free(second);
  expect(odd.memoryRemaining()).toBe(133);
  odd.checkHeap();
  expect(() => new ZoneArena(51)).toThrow(RangeError);
  expect(() => new ZoneArena(0x80000000)).toThrow(RangeError);
  expect(() => new ZoneArena(2 ** 32 + 256)).toThrow(RangeError);
  for (const size of [-1, 0.5, NaN, Infinity, 0x7fffffe5]) expect(() => odd.allocate(size, ZoneTag.General)).toThrow(RangeError);
  expect(() => odd.allocate(1, ZoneTag.Small)).toThrow(RangeError);
});

test("touch memory reads actual block headers and 256-byte strides while skipping freed blocks", () => {
  const zone = new ZoneArena(2048);
  expect(zone.touchMemory()).toBe(0);
  const first = zone.allocate(300, ZoneTag.General);
  const middle = zone.allocate(300, ZoneTag.Botlib);
  const last = zone.allocate(300, ZoneTag.Renderer);
  const view = new DataView(first.bytes.buffer);
  view.setInt32(first.bytes.byteOffset + 236, 7, true);
  view.setInt32(first.bytes.byteOffset, 99, true);
  view.setInt32(last.bytes.byteOffset + 236, 13, true);
  zone.free(middle);
  zone.checkHeap();
  expect(zone.touchMemory()).toBe(324 + 7 + 324 + 13);
  view.setInt32(last.bytes.byteOffset + 236, 0x7fffffff, true);
  expect(zone.touchMemory()).toBe((324 + 7 + 324 + 0x7fffffff) | 0);
});

test("arena disposal invalidates handles without clearing borrowed bytes and is idempotent", () => {
  const zone = new ZoneArena(128);
  const allocation = zone.allocate(8, ZoneTag.General);
  const cached = allocation.bytes;
  cached.fill(37);
  zone.dispose();
  zone.dispose();
  expect([...cached]).toEqual(Array<number>(8).fill(37));
  expect(() => allocation.bytes).toThrow("no longer valid");
  expect(() => zone.allocate(1, ZoneTag.General)).toThrow("zone has been disposed");
  expect(() => zone.memoryRemaining()).toThrow("zone has been disposed");
  expect(() => zone.checkHeap()).toThrow("zone has been disposed");
  expect(() => zone.freeTags(ZoneTag.General)).toThrow("zone has been disposed");
});
