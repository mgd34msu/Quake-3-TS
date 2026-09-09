import { describe, expect, test } from "bun:test";
import { BinaryError } from "../src/core/binary.ts";
import { MoveType, Weapon, WeaponState, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { PlayerState } from "../src/shared/player-state.ts";
import { QVM_PLAYER_STATE_BYTES, readQvmPlayerState, writeQvmPlayerState } from "../src/vm/player-record.ts";

// Hand-counted q_shared.h:1148-1215 offsets for the 32-bit QVM C record.
// No network field table or production writer supplies these fixture bytes.
function sourceFixture(product: Product): { bytes: Uint8Array<ArrayBuffer>; state: PlayerState } {
  const bytes = new Uint8Array(468);
  const view = new DataView(bytes.buffer);
  const integers: readonly (readonly [number, number])[] = [
    [0, -2147483648], [4, 2], [8, 0x01020304], [12, -2000000001], [16, -90000],
    [44, -70000], [48, 800], [52, 320],
    [56, 16777217], [60, -2147483648], [64, 2147483647],
    [68, 1023], [72, 70001], [76, 130], [80, 90001], [84, 140], [88, 7],
    [104, -2020202020], [108, 65538], [112, 257], [116, -258],
    [120, 123456789], [124, -123456789],
    [128, 70003], [132, -70004], [136, -70005], [140, 63],
    [144, product === "baseq3" ? 10 : 13], [148, 3],
    [164, -240], [168, 260], [172, 261], [176, 262], [180, 263],
    [440, -440], [444, 444], [448, 448], [452, -452],
    [456, 456], [460, -460], [464, 2147483647],
  ];
  for (const [offset, value] of integers) view.setInt32(offset, value, true);
  const floats: readonly (readonly [number, number])[] = [
    [20, 1.25], [24, -2.5], [28, 3.75],
    [32, -4.125], [36, 5.25], [40, -6.5],
    [92, 7.75], [96, -8.875], [100, 9.125],
    [152, -10.25], [156, 11.5], [160, -12.75],
  ];
  for (const [offset, value] of floats) view.setFloat32(offset, value, true);
  for (let slot = 0; slot < 16; slot++) {
    view.setInt32(184 + 4 * slot, -100000 - slot, true);
    view.setInt32(248 + 4 * slot, 200000 + slot, true);
    view.setInt32(312 + 4 * slot, -300000 - slot, true);
    view.setInt32(376 + 4 * slot, 400000 + slot, true);
  }
  const state = new PlayerState(product);
  Object.assign(state, {
    commandTime: -2147483648, pmType: MoveType.PM_SPECTATOR,
    bobCycle: 0x01020304, pmFlags: -2000000001, pmTime: -90000,
    origin: { x: 1.25, y: -2.5, z: 3.75 },
    velocity: { x: -4.125, y: 5.25, z: -6.5 },
    weaponTime: -70000, gravity: 800, speed: 320,
    deltaAngles: { x: 16777217, y: -2147483648, z: 2147483647 },
    groundEntityNum: 1023, legsTimer: 70001, legsAnim: 130,
    torsoTimer: 90001, torsoAnim: 140, movementDir: 7,
    grapplePoint: { x: 7.75, y: -8.875, z: 9.125 },
    eFlags: -2020202020, eventSequence: 65538,
    externalEvent: 70003, externalEventParm: -70004, externalEventTime: -70005,
    clientNum: 63, weapon: product === "baseq3" ? Weapon.WP_GRAPPLING_HOOK : Weapon.WP_CHAINGUN,
    weaponState: WeaponState.WEAPON_FIRING,
    viewangles: { x: -10.25, y: 11.5, z: -12.75 },
    viewheight: -240, damageEvent: 260, damageYaw: 261, damagePitch: 262, damageCount: 263,
    generic1: -440, loopSound: 444, jumppadEnt: 448,
    ping: -452, pmoveFramecount: 456, jumppadFrame: -460, entityEventSequence: 2147483647,
  } satisfies Partial<PlayerState>);
  state.events.set(0, 257);
  state.events.set(1, -258);
  state.eventParms.set(0, 123456789);
  state.eventParms.set(1, -123456789);
  for (let slot = 0; slot < 16; slot++) {
    state.stats.set(slot, -100000 - slot);
    state.persistant.set(slot, 200000 + slot);
    state.powerups.set(slot, -300000 - slot);
    state.ammo.set(slot, 400000 + slot);
  }
  return { bytes, state };
}

const PRODUCTS: readonly Product[] = ["baseq3", "missionpack"];

describe("32-bit QVM playerState_t", () => {
  test("has the full source C size", () => {
    expect(QVM_PLAYER_STATE_BYTES).toBe(468);
  });

  for (const product of PRODUCTS) {
    test(`${product}: source offsets decode every field and fixed slot`, () => {
      const fixture = sourceFixture(product);
      const state = readQvmPlayerState(new DataView(fixture.bytes.buffer), product);
      expect(state).toEqual(fixture.state);
      expect(state.stats.get(statSchema(product).weapons)).toBe(product === "baseq3" ? -100002 : -100003);
      expect(state.deltaAngles.x).toBe(16777217);
      expect(state.ammo.get(15)).toBe(400015);
    });

    test(`${product}: writes independent source bytes and preserves surrounding memory`, () => {
      const fixture = sourceFixture(product);
      const memory = new Uint8Array(501).fill(0xa5);
      // Deliberately unaligned, nonzero byteOffset; the view also includes a tail.
      writeQvmPlayerState(new DataView(memory.buffer, 7, 481), fixture.state);
      expect(memory.slice(0, 7)).toEqual(new Uint8Array(7).fill(0xa5));
      expect(memory.slice(7, 475)).toEqual(fixture.bytes);
      expect(memory.slice(475)).toEqual(new Uint8Array(26).fill(0xa5));
      expect(readQvmPlayerState(new DataView(memory.buffer, 7, 468), product)).toEqual(fixture.state);
    });

    test(`${product}: decoded vectors and slots own their data`, () => {
      const fixture = sourceFixture(product);
      const view = new DataView(fixture.bytes.buffer);
      const first = readQvmPlayerState(view, product);
      const second = readQvmPlayerState(view, product);
      fixture.bytes.fill(0);
      expect(first).toEqual(fixture.state);
      first.origin = { x: 0, y: 0, z: 0 };
      first.events.set(1, 0);
      first.stats.set(15, 0);
      expect(second).toEqual(fixture.state);
      first.ammo.set(15, 17);
      expect(view.getInt32(436, true)).toBe(0);
    });

    test(`${product}: roundtrips the whole record`, () => {
      const fixture = sourceFixture(product);
      const state = readQvmPlayerState(new DataView(fixture.bytes.buffer), product);
      const bytes = new Uint8Array(468);
      writeQvmPlayerState(new DataView(bytes.buffer), state);
      expect(bytes).toEqual(fixture.bytes);
    });

    test(`${product}: every truncated record rejects before any write`, () => {
      const state = sourceFixture(product).state;
      for (let length = 0; length < 468; length++) {
        const bytes = new Uint8Array(480).fill(0xa5);
        const before = bytes.slice();
        const view = new DataView(bytes.buffer, 3, length);
        expect(() => readQvmPlayerState(view, product)).toThrow(BinaryError);
        expect(() => writeQvmPlayerState(view, state)).toThrow(BinaryError);
        expect(bytes).toEqual(before);
      }
    });
  }

  test("transports every declared enum member without restricting known weapons by product", () => {
    for (const product of PRODUCTS) {
      const view = new DataView(new ArrayBuffer(468));
      for (let movement = 0; movement <= 6; movement++) {
        view.setInt32(4, movement, true);
        expect(readQvmPlayerState(view, product).pmType).toBe(movement);
      }
      for (let weapon = 0; weapon <= 13; weapon++) {
        view.setInt32(144, weapon, true);
        expect(readQvmPlayerState(view, product).weapon).toBe(weapon);
      }
      for (let weaponState = 0; weaponState <= 3; weaponState++) {
        view.setInt32(148, weaponState, true);
        expect(readQvmPlayerState(view, product).weaponState).toBe(weaponState);
      }
    }
  });

  test("copies custom enum words at their source offsets without network quantization", () => {
    const fields: readonly (readonly [number, "pmType" | "weapon" | "weaponState", number])[] = [
      [4, "pmType", 7], [144, "weapon", 14], [148, "weaponState", 4],
    ];
    for (const product of PRODUCTS) {
      for (const [offset, field, pastEnd] of fields) {
        for (const value of [-2147483648, -1, pastEnd, 2147483647]) {
          const bytes = sourceFixture(product).bytes;
          const view = new DataView(bytes.buffer);
          view.setInt32(offset, value, true);
          const state = readQvmPlayerState(view, product);
          expect(state[field]).toBe(value);
          const copy = state.copy();
          expect(copy[field]).toBe(value);
          const output = new Uint8Array(468);
          writeQvmPlayerState(new DataView(output.buffer), copy);
          expect(output).toEqual(bytes);
        }
      }
    }
  });

  test("stores float32 fields separately from wrapping int32 fields", () => {
    const state = new PlayerState("baseq3");
    state.origin = { x: 1 / 3, y: -0, z: Infinity };
    state.velocity = { x: -Infinity, y: Number.NaN, z: Number.MIN_VALUE };
    state.deltaAngles = { x: 4294967297, y: -4294967297, z: 16777217 };
    const view = new DataView(new ArrayBuffer(468));
    writeQvmPlayerState(view, state);
    const decoded = readQvmPlayerState(view, "baseq3");
    expect(decoded.origin.x).toBe(Math.fround(1 / 3));
    expect(Object.is(decoded.origin.y, -0)).toBe(true);
    expect(decoded.origin.z).toBe(Infinity);
    expect(decoded.velocity.x).toBe(-Infinity);
    expect(decoded.velocity.y).toBeNaN();
    expect(decoded.velocity.z).toBe(0);
    expect(decoded.deltaAngles).toEqual({ x: 1, y: -1, z: 16777217 });
    expect(view.getUint32(24, true)).toBe(0x80000000);
  });
});
