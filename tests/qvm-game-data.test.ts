import { expect, test } from "bun:test";
import { QvmGameData } from "../src/vm/game-data.ts";
import { QvmMemory } from "../src/vm/memory.ts";

test("game table relocation retains actual previously borrowed entity pointers", () => {
  const memory = new QvmMemory(new Uint8Array(8192));
  const data = new QvmGameData(memory, "baseq3");
  data.locate(64, 2, 600, 4096, 512);
  const first = data.entity(0), second = data.entity(1);
  first.s.number = 0; second.s.number = 1;
  second.r.linked = true; second.r.linkcount = 9;
  expect(memory.view(664 + 416, 8).getInt32(4, true)).toBe(9);
  expect(data.entityFromPointer(664)).toBe(second);
  expect(data.numberFromPointer(664)).toBe(1);
  expect(data.numEntities).toBe(2);

  data.locate(2048, 1, 700, 6144, 600);
  const replacement = data.entity(0);
  expect(replacement).not.toBe(first);
  expect(replacement.r.linkcount).toBe(0);
  memory.view(664 + 420, 4).setInt32(0, 12, true);
  expect(second.r.linkcount).toBe(12);
  expect(data.entityFromPointer(664)).toBe(second);
  expect(data.numberFromPointer(664)).toBe(-1);
  expect(data.numEntities).toBe(1);
  // VM restart clears bytes without replacing retained entity addresses.
  memory.bytes.fill(0);
  expect(second.r.linked).toBe(false);
  expect(second.r.linkcount).toBe(0);
  data.locate(64, 2, 600, 4096, 512);
  expect(data.entity(1)).toBe(second);
});

test("game tables mask bases once and apply strides without remasking derived pointers", () => {
  const memory = new QvmMemory(new Uint8Array(2048));
  const data = new QvmGameData(memory, "missionpack");
  data.locate(2048, 0, 516, 1024, 468);
  data.entity(0).s.number = 21;
  expect(new DataView(memory.bytes.buffer).getInt32(0, true)).toBe(21);
  expect(data.entityFromPointer(-2048)).toBe(data.entity(0));
  // SV_GentityNum does not use num_entities as a bounds check.
  expect(data.entity(1).s.number).toBe(0);
  expect(() => data.entity(4)).toThrow("pointer arithmetic");
  data.locate(1900, 1, 516, 1024, 468);
  expect(() => data.entity(0)).toThrow("record exceeds");
  expect(() => data.entity(1)).toThrow("pointer arithmetic");
});

test("server player snapshots copy while ping writes only its reached source word", () => {
  const memory = new QvmMemory(new Uint8Array(4096));
  const data = new QvmGameData(memory, "missionpack");
  data.locate(64, 1, 516, 2048, 600);
  memory.view(2048 + 20, 4).setFloat32(0, 1.5, true);
  data.setPlayerPing(0, 99);
  const copy = data.copyPlayerState(0);
  expect(copy.product).toBe("missionpack");
  expect(copy.origin.x).toBe(1.5);
  expect(copy.ping).toBe(99);
  data.setPlayerPing(0, 37);
  expect(copy.ping).toBe(99);
  expect(data.copyPlayerState(0).ping).toBe(37);
  // SV_CalcPings writes one word; snapshots copy every mod-owned integer.
  memory.view(2048 + 4, 4).setInt32(0, 111, true);
  memory.view(2048 + 144, 4).setInt32(0, -2147483648, true);
  memory.view(2048 + 148, 4).setInt32(0, 2147483647, true);
  data.setPlayerPing(0, 42);
  expect(memory.view(2048 + 452, 4).getInt32(0, true)).toBe(42);
  const modCopy = data.copyPlayerState(0);
  expect(modCopy.pmType).toBe(111);
  expect(modCopy.weapon).toBe(-2147483648);
  expect(modCopy.weaponState).toBe(2147483647);
  expect(modCopy.origin.x).toBe(1.5);
  expect(modCopy.ping).toBe(42);
  data.locate(64, 1, 516, 4096 - 456, 600);
  data.setPlayerPing(0, 13);
  expect(memory.view(4092, 4).getInt32(0, true)).toBe(13);
});

test("unlocated, null and overflowing game-data accesses reject when reached", () => {
  const data = new QvmGameData(new QvmMemory(new Uint8Array(2048)), "baseq3");
  expect(data.numEntities).toBe(0);
  expect(() => data.entity(0)).toThrow("null source pointer");
  data.locate(0, 17, 0, 0, 0);
  expect(data.numEntities).toBe(17);
  expect(() => data.entityFromPointer(0)).toThrow("nonnull");
  data.locate(64, 1, 0, 1024, 0);
  expect(() => data.numberFromPointer(64)).toThrow("nonzero");
  data.locate(64, 1, 0x40000000, 1024, 468);
  expect(() => data.entity(2)).toThrow("signed 32-bit");
  expect(() => data.entity(0.5)).toThrow("signed 32-bit");
});
