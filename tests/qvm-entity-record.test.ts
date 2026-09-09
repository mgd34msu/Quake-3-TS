import { describe, expect, test } from "bun:test";
import { BinaryError } from "../src/core/binary.ts";
import { EntityState, EntityStateRecord } from "../src/shared/entity-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";
import { borrowQvmEntityState, QVM_ENTITY_STATE_BYTES, readQvmEntityState, writeQvmEntityState } from "../src/vm/entity-record.ts";

// Hand-authored little-endian words in q_shared.h:1285-1327 declaration order.
// Trajectories each contain three integer words followed by six binary32 words.
function fixture(): Uint8Array<ArrayBuffer> {
  const words = `
    78563412 ffffffff 00000080
    02000000 feffffff ffffff7f 0000803f 000000c0 00000080 00006040 00009040 0000a8c0
    05000000 03000000 04000000 0000d040 0000f8c0 00000041 000018c1 00002441 00003841
    05000000 faffffff
    00004041 000050c1 00006441
    00007841 00008641 000088c1
    00009041 00009ac1 0000a441
    0000aec1 0000b041 0000ba41
    07000000 f8ffffff ffffffff 112233ee 0b000000 0c000000 0d000000 0e000000
    0f000000 ffffff00 10010000 effeffff 01000080 13000000 14000000 15000000 16000000
  `;
  return new Uint8Array(words.trim().split(/\s+/).flatMap(word => [
    Number.parseInt(word.slice(0, 2), 16), Number.parseInt(word.slice(2, 4), 16),
    Number.parseInt(word.slice(4, 6), 16), Number.parseInt(word.slice(6, 8), 16),
  ]));
}

function expectedState(): EntityState {
  const state = new EntityState();
  state.number = 0x12345678;
  state.eType = -1;
  state.eFlags = -0x80000000;
  state.pos = {
    type: TrajectoryType.TR_LINEAR, time: -2, duration: 0x7fffffff,
    base: { x: 1, y: -2, z: -0 }, delta: { x: 3.5, y: 4.5, z: -5.25 },
  };
  state.apos = {
    type: TrajectoryType.TR_GRAVITY, time: 3, duration: 4,
    base: { x: 6.5, y: -7.75, z: 8 }, delta: { x: -9.5, y: 10.25, z: 11.5 },
  };
  state.time = 5;
  state.time2 = -6;
  state.origin = { x: 12, y: -13, z: 14.25 };
  state.origin2 = { x: 15.5, y: 16.75, z: -17 };
  state.angles = { x: 18, y: -19.25, z: 20.5 };
  state.angles2 = { x: -21.75, y: 22, z: 23.25 };
  state.otherEntityNum = 7;
  state.otherEntityNum2 = -8;
  state.groundEntityNum = -1;
  state.constantLight = 0xee332211 | 0;
  state.loopSound = 11;
  state.modelindex = 12;
  state.modelindex2 = 13;
  state.clientNum = 14;
  state.frame = 15;
  state.solid = 0x00ffffff;
  state.event = 272;
  state.eventParm = -273;
  state.powerups = -0x7fffffff;
  state.weapon = 19;
  state.legsAnim = 20;
  state.torsoAnim = 21;
  state.generic1 = 22;
  return state;
}

describe("QVM entityState_t ABI records", () => {
  test("borrowed fields observe byte mutations while copies and sampled vectors stay owned", () => {
    const bytes = fixture();
    const view = new DataView(bytes.buffer);
    const state = borrowQvmEntityState(view);
    const alias = borrowQvmEntityState(view);
    const copy = state.copy();
    const origin = state.origin;
    const pos = state.pos;
    expect(copy).toEqual(expectedState());
    expect(copy).toBeInstanceOf(EntityStateRecord);
    view.setInt32(0, -73, true);
    view.setFloat32(92, 25, true);
    view.setFloat32(24, 99, true);
    expect(state.number).toBe(-73);
    expect(state.origin.x).toBe(25);
    expect(state.pos.base.x).toBe(99);
    expect(origin.x).toBe(12);
    expect(pos.base.x).toBe(1);
    expect(copy).toEqual(expectedState());
    alias.number = 0x100000001;
    alias.origin = { x: 1 / 3, y: -0, z: Infinity };
    expect(state.number).toBe(1);
    expect(state.origin).toEqual({ x: Math.fround(1 / 3), y: -0, z: Infinity });
    state.pos = { ...pos, time: -100, base: { x: 2, y: 3, z: 4 } };
    expect(view.getInt32(16, true)).toBe(-100);
    expect(alias.pos.base).toEqual({ x: 2, y: 3, z: 4 });
  });

  test("borrowing rejects short views and samples raw trajectory words when read", () => {
    const bytes = fixture();
    const view = new DataView(bytes.buffer);
    for (let length = 0; length < 208; length++) {
      expect(() => borrowQvmEntityState(new DataView(bytes.buffer, 0, length))).toThrow(BinaryError);
    }
    view.setInt32(12, 99, true);
    const state = borrowQvmEntityState(view);
    expect(state.number).toBe(0x12345678);
    expect(state.apos.type).toBe(TrajectoryType.TR_GRAVITY);
    state.solid = 123;
    expect(view.getInt32(176, true)).toBe(123);
    expect(state.pos.type).toBe(99);
    state.pos = new EntityState().pos;
    expect(state.pos.type).toBe(TrajectoryType.TR_STATIONARY);
  });

  test("reads all source fields from independent little-endian bytes", () => {
    const bytes = fixture();
    expect(bytes.byteLength).toBe(208);
    expect(QVM_ENTITY_STATE_BYTES).toBe(208);
    const before = bytes.slice();
    const state = readQvmEntityState(new DataView(bytes.buffer));
    expect(state).toEqual(expectedState());
    expect(Object.is(state.pos.base.z, -0)).toBe(true);
    expect(bytes).toEqual(before);
  });

  test("writes every source field to the independent byte fixture", () => {
    const bytes = new Uint8Array(208).fill(0xa5);
    const state = expectedState();
    const before = state.copy();
    writeQvmEntityState(new DataView(bytes.buffer), state);
    expect(bytes).toEqual(fixture());
    expect(state).toEqual(before);
  });

  test("uses the supplied view start and leaves adjacent bytes untouched", () => {
    const bytes = new Uint8Array(229).fill(0xa5);
    const view = new DataView(bytes.buffer, 7, 215);
    writeQvmEntityState(view, expectedState());
    expect(bytes.slice(0, 7)).toEqual(new Uint8Array(7).fill(0xa5));
    expect(bytes.slice(7, 215)).toEqual(fixture());
    expect(bytes.slice(215)).toEqual(new Uint8Array(14).fill(0xa5));
    expect(readQvmEntityState(view)).toEqual(expectedState());
  });

  test("rejects every short extent before writing even with larger backing storage", () => {
    const bytes = new Uint8Array(220).fill(0xa5);
    const before = bytes.slice();
    for (let length = 0; length < 208; length++) {
      const view = new DataView(bytes.buffer, 3, length);
      expect(() => readQvmEntityState(view)).toThrow(BinaryError);
      expect(() => writeQvmEntityState(view, expectedState())).toThrow(BinaryError);
      expect(bytes).toEqual(before);
    }
  });

  test("accepts all six source trajectory enum members in each trajectory", () => {
    const bytes = fixture();
    const view = new DataView(bytes.buffer);
    for (let type = 0; type <= 5; type++) {
      view.setInt32(12, type, true);
      view.setInt32(48, type, true);
      const state = readQvmEntityState(view);
      expect(state.pos.type).toBe(type);
      expect(state.apos.type).toBe(type);
      const output = new Uint8Array(208);
      writeQvmEntityState(new DataView(output.buffer), state);
      expect(output).toEqual(bytes);
    }
  });

  test("copies custom signed trajectory words at either source offset", () => {
    for (const offset of [12, 48]) {
      for (const type of [-0x80000000, -1, 6, 255, 0x7fffffff]) {
        const bytes = fixture();
        const view = new DataView(bytes.buffer);
        view.setInt32(offset, type, true);
        const before = bytes.slice();
        const state = readQvmEntityState(view);
        expect(offset === 12 ? state.pos.type : state.apos.type).toBe(type);
        const copy = state.copy();
        const output = new Uint8Array(208);
        writeQvmEntityState(new DataView(output.buffer), copy);
        expect(output).toEqual(bytes);
        expect(bytes).toEqual(before);
      }
    }
  });

  test("borrowed copies read each source cell once in ABI order", () => {
    const reads: number[] = [];
    const bytes = fixture();
    const view = new DataView(bytes.buffer);
    const getInt32 = view.getInt32.bind(view), getFloat32 = view.getFloat32.bind(view);
    view.getInt32 = (offset, littleEndian) => {
      reads.push(offset);
      return getInt32(offset, littleEndian);
    };
    view.getFloat32 = (offset, littleEndian) => {
      reads.push(offset);
      return getFloat32(offset, littleEndian);
    };
    view.setInt32(12, -2147483648, true);
    view.setInt32(48, 2147483647, true);
    const copy = borrowQvmEntityState(view).copy();
    expect(reads).toEqual(Array.from({ length: 52 }, (_, index) => index * 4));
    expect(copy.pos.type).toBe(-2147483648);
    expect(copy.apos.type).toBe(2147483647);
  });

  test("borrowed copyFrom keeps completed ABI writes when a later source cell throws", () => {
    const bytes = new Uint8Array(208).fill(0xa5);
    const view = new DataView(bytes.buffer);
    const source = new EntityStateRecord<number>(0);
    source.number = 3;
    source.eType = -7;
    source.eFlags = 0x80000000;
    source.pos = {
      type: 99, time: -11, duration: 1234,
      base: {
        x: 6.25,
        get y(): number { throw new RangeError("stopped at trajectory base.y"); },
        z: 0,
      },
      delta: { x: 1, y: 2, z: 3 },
    };
    expect(() => borrowQvmEntityState(view).copyFrom(source)).toThrow("stopped at trajectory base.y");
    expect(view.getInt32(0, true)).toBe(3);
    expect(view.getInt32(4, true)).toBe(-7);
    expect(view.getInt32(8, true)).toBe(-2147483648);
    expect(view.getInt32(12, true)).toBe(99);
    expect(view.getInt32(16, true)).toBe(-11);
    expect(view.getInt32(20, true)).toBe(1234);
    expect(view.getFloat32(24, true)).toBe(6.25);
    expect(bytes.slice(28)).toEqual(new Uint8Array(180).fill(0xa5));
  });

  test("reads detached state and vector objects", () => {
    const bytes = fixture();
    const view = new DataView(bytes.buffer);
    const first = readQvmEntityState(view);
    const second = readQvmEntityState(view);
    expect(first).not.toBe(second);
    expect(first.pos).not.toBe(second.pos);
    expect(first.apos).not.toBe(second.apos);
    for (const [left, right] of [
      [first.pos.base, second.pos.base], [first.pos.delta, second.pos.delta],
      [first.apos.base, second.apos.base], [first.apos.delta, second.apos.delta],
      [first.origin, second.origin], [first.origin2, second.origin2],
      [first.angles, second.angles], [first.angles2, second.angles2],
    ]) expect(left).not.toBe(right);
    bytes.fill(0);
    expect(first).toEqual(expectedState());
    first.number = 1;
    first.origin = { x: 2, y: 3, z: 4 };
    expect(second).toEqual(expectedState());
    expect(readQvmEntityState(view)).toEqual(new EntityState());
  });

  test("stores integer words and binary32 values without network quantization", () => {
    const state = new EntityState();
    state.number = 0x100000001;
    state.eType = 0x80000000;
    state.weapon = 0x7fffffff;
    state.origin = { x: 1 / 3, y: Infinity, z: -Infinity };
    state.origin2 = { x: Number.MIN_VALUE, y: NaN, z: -0 };
    const bytes = new Uint8Array(208);
    writeQvmEntityState(new DataView(bytes.buffer), state);
    const result = readQvmEntityState(new DataView(bytes.buffer));
    expect(result.number).toBe(1);
    expect(result.eType).toBe(-0x80000000);
    expect(result.weapon).toBe(0x7fffffff);
    expect(result.origin).toEqual({ x: Math.fround(1 / 3), y: Infinity, z: -Infinity });
    expect(result.origin2.x).toBe(0);
    expect(Number.isNaN(result.origin2.y)).toBe(true);
    expect(Object.is(result.origin2.z, -0)).toBe(true);
  });
});
