import { describe, expect, test } from "bun:test";
import { BinaryError } from "../src/core/binary.ts";
import type { EntityShared } from "../src/shared/entity-shared.ts";
import { QVM_SHARED_ENTITY_BYTES, borrowQvmSharedEntity } from "../src/vm/shared-entity-record.ts";

// g_public.h declaration-order bytes from linked through ownerNum.
function sharedTail(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(`
    01000000 feffffff 20040000 03000000 00000000
    000080bf 000000c0 000040c0 00008040 0000a040 0000c040 ffffffff
    0000e0c0 000000c1 000010c1 00002041 00003041 00004041
    00005041 00006041 00007041 00008041 00008841 00009041 13000000
  `.trim().split(/\s+/).flatMap(word => [
    Number.parseInt(word.slice(0, 2), 16), Number.parseInt(word.slice(2, 4), 16),
    Number.parseInt(word.slice(4, 6), 16), Number.parseInt(word.slice(6, 8), 16),
  ]));
}

function expectedSharedFields(): EntityShared {
  return {
    linked: true, linkcount: -2, svFlags: 0x420, singleClient: 3,
    mins: { x: -1, y: -2, z: -3 }, maxs: { x: 4, y: 5, z: 6 }, contents: -1,
    absmin: { x: -7, y: -8, z: -9 }, absmax: { x: 10, y: 11, z: 12 },
    currentOrigin: { x: 13, y: 14, z: 15 }, currentAngles: { x: 16, y: 17, z: 18 },
    ownerNum: 19, model: { kind: "capsule" },
  };
}

describe("QVM borrowed sharedEntity_t ABI", () => {
  test("reads the pinned 516-byte layout and preserves its unused embedded state", () => {
    expect(QVM_SHARED_ENTITY_BYTES).toBe(516);
    expect(sharedTail().byteLength).toBe(100);
    const bytes = new Uint8Array(530).fill(0xa5);
    const view = new DataView(bytes.buffer, 7, 516);
    bytes.set(sharedTail(), 7 + 416);
    view.setInt32(0, 42, true);
    // Invalid unused and unread trajectory words cannot stop shared-field access.
    const before = bytes.slice();
    const entity = borrowQvmSharedEntity(view);
    expect(entity.s.number).toBe(42);
    expect({ ...entity.r }).toEqual(expectedSharedFields());
    expect(bytes).toEqual(before);
  });

  test("writes exact shared words without touching outer state, embedded state or adjacent bytes", () => {
    const bytes = new Uint8Array(530).fill(0xa5);
    const view = new DataView(bytes.buffer, 7, 516);
    const entity = borrowQvmSharedEntity(view);
    entity.r.linked = true;
    entity.r.linkcount = -2;
    entity.r.svFlags = 0x20;
    entity.r.singleClient = 3;
    entity.r.model = { kind: "capsule" };
    entity.r.mins = { x: -1, y: -2, z: -3 };
    entity.r.maxs = { x: 4, y: 5, z: 6 };
    entity.r.contents = -1;
    entity.r.absmin = { x: -7, y: -8, z: -9 };
    entity.r.absmax = { x: 10, y: 11, z: 12 };
    entity.r.currentOrigin = { x: 13, y: 14, z: 15 };
    entity.r.currentAngles = { x: 16, y: 17, z: 18 };
    entity.r.ownerNum = 19;
    expect(bytes.slice(7 + 416, 7 + 516)).toEqual(sharedTail());
    expect(bytes.slice(0, 7 + 416)).toEqual(new Uint8Array(7 + 416).fill(0xa5));
    expect(bytes.slice(7 + 516)).toEqual(new Uint8Array(7).fill(0xa5));
  });

  test("multiple facades observe current bytes and keep vector samples detached", () => {
    const bytes = new Uint8Array(516);
    const view = new DataView(bytes.buffer);
    const first = borrowQvmSharedEntity(view);
    const second = borrowQvmSharedEntity(view);
    first.r.currentOrigin = { x: 1 / 3, y: -0, z: Infinity };
    const sampled = first.r.currentOrigin;
    expect(second.r.currentOrigin).toEqual({ x: Math.fround(1 / 3), y: -0, z: Infinity });
    view.setFloat32(488, 25, true);
    view.setInt32(416, -1, true);
    view.setInt32(420, 0x7fffffff, true);
    expect(first.r.currentOrigin.x).toBe(25);
    expect(sampled.x).toBe(Math.fround(1 / 3));
    expect(first.r.linked).toBe(true);
    second.r.linked = false;
    second.r.linkcount++;
    expect(view.getInt32(416, true)).toBe(0);
    expect(first.r.linkcount).toBe(-0x80000000);
    first.s.number = 3;
    expect(second.s.number).toBe(3);
  });

  test("collision selection follows live bmodel, outer modelindex and capsule flag precedence", () => {
    const view = new DataView(new ArrayBuffer(516));
    const entity = borrowQvmSharedEntity(view);
    view.setInt32(424, 0x80000420, true);
    expect(borrowQvmSharedEntity(view).r.model).toEqual({ kind: "capsule" });
    entity.r.model = { kind: "inline", index: 12 };
    expect(view.getInt32(160, true)).toBe(12);
    expect(view.getInt32(432, true)).toBe(1);
    expect(view.getUint32(424, true)).toBe(0x80000420);
    view.setInt32(160, 27, true);
    view.setInt32(432, -8, true);
    expect(entity.r.model).toEqual({ kind: "inline", index: 27 });
    view.setInt32(432, 0, true);
    expect(borrowQvmSharedEntity(view).r.model).toEqual({ kind: "capsule" });
    entity.r.model = { kind: "box" };
    expect(view.getUint32(424, true)).toBe(0x80000020);
    expect(view.getInt32(160, true)).toBe(27);
    expect(entity.r.model).toEqual({ kind: "box" });
    entity.r.model = { kind: "capsule" };
    expect(view.getUint32(424, true)).toBe(0x80000420);
    expect(view.getInt32(432, true)).toBe(0);
    expect(view.getInt32(160, true)).toBe(27);
  });

  test("rejects every short view before any write despite a larger backing buffer", () => {
    const bytes = new Uint8Array(530).fill(0xa5);
    const before = bytes.slice();
    for (let length = 0; length < 516; length++) {
      expect(() => borrowQvmSharedEntity(new DataView(bytes.buffer, 7, length))).toThrow(BinaryError);
    }
    expect(bytes).toEqual(before);
  });
});
