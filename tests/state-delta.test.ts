import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { vec3 } from "../src/core/math.ts";
import { EntityState, EntityStateRecord } from "../src/shared/entity-state.ts";
import type { EntityStateFields, SourceEntityState } from "../src/shared/entity-state.ts";
import { MoveType, Weapon, WeaponState, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { PlayerState, PlayerStateRecord } from "../src/shared/player-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";
import { MessageReader, MessageWriter, SourceMessageState } from "../src/protocol/message.ts";
import { readDeltaEntity, readDeltaPlayerState, stateDeltaFields, writeDeltaEntity, writeDeltaPlayerState } from "../src/protocol/state-delta.ts";
import type { DeltaMessageDiagnostics } from "../src/protocol/state-delta.ts";

// Recorded from untouched msg.c dbe4ddb. Each scalar i was initialized to i+1;
// float i cycles i+0.25, -i, 4096+i. Enum/signed overrides and arrays are below.
const ENTITY_HEX = "d1bcfc56f7cbb7f4455d593e8f972fa52fea1aff79b97c9fbfa845ce969fdc9e33ab091db9907ee8dd3dff755ce823ab475cbba03be50be08b7a3d7dc89ffcfffd34d708fe3ce2d24b459dff36e2e6d529a9b3a6de9ea9a82b6bfc55c49d978a9abe3a89b84ba9a82b94ffbbfa6501";
const PLAYER_HEX = "a75bed97b7f4450d8d9797d217b5c67f2e97074baedd41b3e593f89073cc6ac5127efcbb7311e7c806b231afe2b1bddee83f49fd3e4d22f7e29dbf0db9f994b2b6adacf1ab889d978a5a63f95f3c39f92a80c49acc97448dcc956c947c9124b945ca36d40821fe26c94bc20cf2a99c28f69298983e92c1590b65f4c83c932449228db0ba30472c76e7c8aee290b7cddab0ac19a7499262c0f6ec6a5b18687b0de0edf31a5b4ae36c4beb6f0bc86f1b2db86dfc30b6389ad9ae1cfcf6637dcb51b86519f8f6c0c02d";

function richEntity(): EntityState {
  const e = new EntityState();
  e.number = 37;
  e.pos = { type: TrajectoryType.TR_LINEAR, time: 1, duration: 23, base: vec3(-1, 4098, 4101), delta: vec3(3.25, -4, -7) };
  e.apos = { type: TrajectoryType.TR_GRAVITY, time: 40, duration: 41, base: vec3(4104, 6.25, 4137), delta: vec3(42.25, -43, 4140) };
  e.event = 10;
  e.angles2 = vec3(4143, -10, 48.25);
  e.eType = 12;
  e.torsoAnim = 13;
  e.eventParm = 14;
  e.legsAnim = 15;
  e.groundEntityNum = 16;
  e.eFlags = 18;
  e.otherEntityNum = 19;
  e.weapon = 20;
  e.clientNum = 21;
  e.angles = vec3(-37, 21.25, -46);
  e.origin = vec3(24.25, -25, 4122);
  e.solid = 28;
  e.powerups = 29;
  e.modelindex = 30;
  e.otherEntityNum2 = 31;
  e.loopSound = 32;
  e.generic1 = 33;
  e.origin2 = vec3(-34, 4131, 33.25);
  e.modelindex2 = 37;
  e.time = 39;
  e.time2 = 46;
  e.constantLight = 50;
  e.frame = 51;
  return e;
}

function richPlayer(product: Product): PlayerState {
  const p = new PlayerState(product);
  p.commandTime = 1;
  p.origin = vec3(-1, 4098, 9.25);
  p.bobCycle = 4;
  p.velocity = vec3(-4, 4101, -10);
  p.viewangles = vec3(-7, 6.25, 42.25);
  p.weaponTime = -17;
  p.legsTimer = 12;
  p.pmTime = -33;
  p.eventSequence = 14;
  p.torsoAnim = 15;
  p.movementDir = 5;
  p.events.set(0, 17);
  p.legsAnim = 18;
  p.events.set(1, 19);
  p.pmFlags = 20;
  p.groundEntityNum = 21;
  p.weaponState = WeaponState.WEAPON_FIRING;
  p.eFlags = 23;
  p.externalEvent = 24;
  p.gravity = 25;
  p.speed = 26;
  p.deltaAngles = vec3(36, 27, 37);
  p.externalEventParm = 28;
  p.viewheight = -12;
  p.damageEvent = 30;
  p.damageYaw = 31;
  p.damagePitch = 32;
  p.damageCount = 33;
  p.generic1 = 34;
  p.pmType = MoveType.PM_NOCLIP;
  p.torsoTimer = 38;
  p.eventParms.set(0, 39);
  p.eventParms.set(1, 40);
  p.clientNum = 41;
  p.weapon = Weapon.WP_CHAINGUN;
  p.grapplePoint = vec3(-43, 4140, 45.25);
  p.jumppadEnt = 47;
  p.loopSound = 48;
  for (let i = 0; i < 16; i++) {
    p.stats.set(i, i - 8);
    p.persistant.set(i, 100 + i);
    p.ammo.set(i, i * 3 - 1);
    p.powerups.set(i, 100000 + i * 1000);
  }
  return p;
}

function decodeEntity(bytes: Uint8Array, from: Readonly<EntityStateFields> = new EntityState()): SourceEntityState {
  const reader = new MessageReader(bytes);
  return readDeltaEntity(reader, from, reader.readBits(10));
}

describe("entity delta", () => {
  test("source oldsize includes field-table and zero-float adjustments", () => {
    const messages: string[] = [], state = new SourceMessageState(text => { messages.push(text); });
    const from = new EntityState(), to = new EntityState();
    from.pos = { ...from.pos, base: vec3(1, 0, 0) };
    const writer = new MessageWriter("bitstream", 16384, state);
    writeDeltaEntity(writer, from, to);
    const index = stateDeltaFields("entity").findIndex(field => field.name === "pos.trBase[0]");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(state.oldsize).toBe(10 + 1 + 1 + 8 + 51 + index + 2 + 13);
    expect(messages).toEqual([]);
  });
  test("every source scalar matches independent C fixture", () => {
    const entity = richEntity();
    const writer = new MessageWriter();
    writeDeltaEntity(writer, new EntityState(), entity);
    expect(writer.bitPosition).toBe(881);
    expect(Buffer.from(writer.toBytes()).toString("hex")).toBe(ENTITY_HEX);
    expect(decodeEntity(Buffer.from(ENTITY_HEX, "hex"))).toEqual(entity);
  });

  test("remove and forced no-change match independent C fixtures", () => {
    const entity = richEntity();
    const removal = new MessageWriter();
    writeDeltaEntity(removal, entity, null);
    expect(Buffer.from(removal.toBytes()).toString("hex")).toBe("d102");
    const removed = new EntityState();
    removed.number = 1023;
    expect(decodeEntity(removal.toBytes(), entity)).toEqual(removed);
    const force = new MessageWriter();
    writeDeltaEntity(force, entity, entity, true);
    expect(Buffer.from(force.toBytes()).toString("hex")).toBe("d100");
    expect(decodeEntity(force.toBytes(), entity)).toEqual(entity);
    const omitted = new MessageWriter();
    writeDeltaEntity(omitted, entity, entity);
    writeDeltaEntity(omitted, null, null);
    expect(omitted.byteLength).toBe(0);
  });

  test("late field changes preserve previous state and independent ownership", () => {
    const baseline = richEntity();
    const changed = baseline.copy();
    changed.frame = 250;
    const writer = new MessageWriter();
    writeDeltaEntity(writer, baseline, changed);
    const decoded = decodeEntity(writer.toBytes(), baseline);
    expect(decoded).toEqual(changed);
    expect(decoded.pos).not.toBe(baseline.pos);
    expect(decoded.pos.base).not.toBe(baseline.pos.base);
    expect(decoded.origin).not.toBe(baseline.origin);
    baseline.pos = { ...baseline.pos, time: 900 };
    expect(decoded.pos.time).toBe(1);
  });

  test("13-bit float boundaries, full floats and zero encodings", () => {
    for (const value of [-4097, -4096, 4095, 4096, 0.125, Infinity, -Infinity]) {
      const changed = new EntityState();
      changed.number = 1;
      changed.origin = vec3(value, 0, 0);
      const writer = new MessageWriter();
      writeDeltaEntity(writer, null, changed);
      expect(decodeEntity(writer.toBytes()).origin.x).toBe(value);
    }
    const old = new EntityState();
    old.origin = vec3(5, 0, 0);
    old.frame = 2;
    const zero = old.copy();
    zero.origin = vec3(0, 0, 0);
    zero.frame = 0;
    const writer = new MessageWriter();
    writeDeltaEntity(writer, old, zero);
    expect(decodeEntity(writer.toBytes(), old)).toEqual(zero);
    const negativeZero = new EntityState();
    negativeZero.origin = vec3(-0, 0, 0);
    const negative = new MessageWriter();
    writeDeltaEntity(negative, new EntityState(), negativeZero);
    expect(negative.byteLength).toBeGreaterThan(0);
    expect(Object.is(decodeEntity(negative.toBytes()).origin.x, -0)).toBe(false);
  });

  test("change detection compares stored float32 bits", () => {
    const previous = new EntityState();
    previous.origin = { x: 1, y: 0, z: 0 };
    const next = previous.copy();
    next.origin = { x: 1 + Number.EPSILON, y: 0, z: 0 };
    const writer = new MessageWriter();
    writeDeltaEntity(writer, previous, next);
    expect(writer.byteLength).toBe(0);
  });

  test("valid sentinel and boundary indices, invalid lastchanged and truncation", () => {
    for (const number of [0, 1022, 1023]) {
      const entity = new EntityState();
      entity.number = number;
      const writer = new MessageWriter();
      writeDeltaEntity(writer, null, entity, true);
      expect(decodeEntity(writer.toBytes()).number).toBe(number);
    }
    for (const number of [-1, 1024, 1.5]) {
      expect(() => readDeltaEntity(new MessageReader(new Uint8Array()), new EntityState(), number)).toThrow("number");
      const entity = new EntityState(); entity.number = number;
      expect(() => writeDeltaEntity(new MessageWriter(), null, entity)).toThrow("number");
    }
    const malformed = new MessageWriter();
    malformed.writeBits(0, 1); malformed.writeBits(1, 1); malformed.writeByte(52);
    expect(() => readDeltaEntity(new MessageReader(malformed.toBytes()), new EntityState(), 0)).toThrow("last field");
    expect(() => decodeEntity(Buffer.from(ENTITY_HEX.slice(0, -2), "hex"))).toThrow();
  });

  test("trajectory types pass through the source eight-bit fields without retail enum checks", () => {
    const cases: readonly [number, "pos" | "apos"][] = [[16, "pos"], [23, "apos"]];
    for (const [field, key] of cases) for (const value of [6, 127, 255]) {
      const wire = new MessageWriter();
      wire.writeBits(0, 1); wire.writeBits(1, 1); wire.writeByte(field + 1);
      for (let i = 0; i < field; i++) wire.writeBits(0, 1);
      wire.writeBits(1, 1); wire.writeBits(1, 1); wire.writeByte(value);
      const decoded = readDeltaEntity(new MessageReader(wire.toBytes()), new EntityState(), 0);
      expect(decoded[key].type).toBe(value);
    }
  });

  test("raw trajectory baselines retain signed words while changed fields use their source wire width", () => {
    const baseline = new EntityStateRecord<number>(0);
    baseline.number = 7;
    baseline.pos = { ...baseline.pos, type: -1 };
    baseline.apos = { ...baseline.apos, type: 0x123456fd };
    const changed = baseline.copy(); changed.frame = 99;
    const delta = new MessageWriter();
    writeDeltaEntity(delta, baseline, changed);
    const decoded = decodeEntity(delta.toBytes(), baseline);
    expect([decoded.pos.type, decoded.apos.type, decoded.frame]).toEqual([-1, 0x123456fd, 99]);
    expect(decoded.pos).not.toBe(baseline.pos);
    const full = new MessageWriter();
    writeDeltaEntity(full, null, baseline);
    const masked = decodeEntity(full.toBytes());
    expect([masked.pos.type, masked.apos.type]).toEqual([255, 253]);
  });
});

describe("player state delta", () => {
  test("source oldsize includes unchanged player fields and all four absent arrays", () => {
    const messages: string[] = [], state = new SourceMessageState(text => { messages.push(text); });
    const player = new PlayerState("baseq3");
    writeDeltaPlayerState(new MessageWriter("bitstream", 16384, state), player, player);
    expect(state.oldsize).toBe(8 + 48 + 1 + 4);
    expect(messages).toEqual([]);
  });
  test("all48 scalars and all64 array slots match independent C fixture for both products", () => {
    const products: readonly Product[] = ["baseq3", "missionpack"];
    for (const product of products) {
      const player = richPlayer(product);
      const writer = new MessageWriter();
      writeDeltaPlayerState(writer, null, player);
      expect(writer.bitPosition).toBe(1598);
      expect(Buffer.from(writer.toBytes()).toString("hex")).toBe(PLAYER_HEX);
      expect(readDeltaPlayerState(new MessageReader(Buffer.from(PLAYER_HEX, "hex")), null, product)).toEqual(player);
    }
  });

  test("array masks include bit15, shorts sign extend, powerups retain32 bits", () => {
    const p = new PlayerState("baseq3");
    p.stats.set(15, 65535);
    p.persistant.set(15, -32768);
    p.ammo.set(15, -1);
    p.powerups.set(15, 0x12345678);
    const writer = new MessageWriter();
    writeDeltaPlayerState(writer, null, p);
    const decoded = readDeltaPlayerState(new MessageReader(writer.toBytes()), null, "baseq3");
    expect(decoded.stats.get(15)).toBe(-1);
    expect(decoded.persistant.get(15)).toBe(-32768);
    expect(decoded.ammo.get(15)).toBe(-1);
    expect(decoded.powerups.get(15)).toBe(0x12345678);
    expect(decoded.stats.get(0)).toBe(0);
  });

  test("unchanged baseline copies non-wire fields and owns every array and vector", () => {
    const baseline = richPlayer("missionpack");
    baseline.externalEventTime = 100;
    baseline.ping = 42;
    baseline.pmoveFramecount = 33;
    baseline.jumppadFrame = 32;
    baseline.entityEventSequence = 7;
    const writer = new MessageWriter();
    writeDeltaPlayerState(writer, baseline, baseline);
    expect(writer.toBytes()).toEqual(Uint8Array.of(2));
    const decoded = readDeltaPlayerState(new MessageReader(writer.toBytes()), baseline, "missionpack");
    expect(decoded).toEqual(baseline);
    expect(decoded.origin).not.toBe(baseline.origin);
    expect(decoded.deltaAngles).not.toBe(baseline.deltaAngles);
    expect(decoded.stats).not.toBe(baseline.stats);
    expect(decoded.events).not.toBe(baseline.events);
    baseline.stats.set(0, 999);
    baseline.events.set(0, 999);
    expect(decoded.stats.get(0)).toBe(-8);
    expect(decoded.events.get(0)).toBe(17);
  });

  test("product stat slots stay in source order and cross-product baselines reject", () => {
    const base = new PlayerState("baseq3");
    const team = new PlayerState("missionpack");
    base.stats.set(statSchema("baseq3").armor, 25);
    team.stats.set(statSchema("missionpack").armor, 25);
    const a = new MessageWriter(); const b = new MessageWriter();
    writeDeltaPlayerState(a, null, base); writeDeltaPlayerState(b, null, team);
    expect(a.toBytes()).not.toEqual(b.toBytes());
    expect(readDeltaPlayerState(new MessageReader(a.toBytes()), null, "baseq3").stats.get(statSchema("baseq3").armor)).toBe(25);
    expect(readDeltaPlayerState(new MessageReader(b.toBytes()), null, "missionpack").stats.get(statSchema("missionpack").armor)).toBe(25);
    expect(() => writeDeltaPlayerState(new MessageWriter(), base, team)).toThrow("products");
    expect(() => readDeltaPlayerState(new MessageReader(a.toBytes()), base, "missionpack")).toThrow("products");
  });

  test("rejects oversized field counts and truncated arrays", () => {
    const malformed = new MessageWriter(); malformed.writeByte(49);
    expect(() => readDeltaPlayerState(new MessageReader(malformed.toBytes()), null, "baseq3")).toThrow("last field");
    expect(() => readDeltaPlayerState(new MessageReader(Buffer.from(PLAYER_HEX.slice(0, -2), "hex")), null, "baseq3")).toThrow();
    const missingArray = new MessageWriter();
    missingArray.writeByte(0); missingArray.writeBits(1, 1); missingArray.writeBits(1, 1); missingArray.writeShort(0x8000);
    expect(() => readDeltaPlayerState(new MessageReader(missingArray.toBytes()), null, "baseq3")).toThrow();
  });

  test("movement, weapon-state and weapon values pass through their source wire widths for both products", () => {
    const cases: readonly [number, number, number, "pmType" | "weaponState" | "weapon"][] = [[34, 8, 255, "pmType"], [21, 4, 15, "weaponState"], [41, 5, 31, "weapon"]];
    const products: readonly Product[] = ["baseq3", "missionpack"];
    for (const product of products) for (const [field, bits, value, key] of cases) {
      const wire = new MessageWriter();
      wire.writeByte(field + 1);
      for (let i = 0; i < field; i++) wire.writeBits(0, 1);
      wire.writeBits(1, 1); wire.writeBits(value, bits); wire.writeBits(0, 1);
      expect(readDeltaPlayerState(new MessageReader(wire.toBytes()), null, product)[key]).toBe(value);
    }
  });

  test("raw player baselines retain signed enum and tail words while changed fields use wire masks", () => {
    const products: readonly Product[] = ["baseq3", "missionpack"];
    for (const product of products) {
      const baseline = new PlayerStateRecord<number, number, number>(product, -0x76543210, 0x7fffffff, -123456789);
      baseline.externalEventTime = -1; baseline.ping = -2; baseline.pmoveFramecount = -3;
      baseline.jumppadFrame = -4; baseline.entityEventSequence = -5;
      const changed = baseline.copy(); changed.commandTime = -2147483648;
      const delta = new MessageWriter();
      writeDeltaPlayerState(delta, baseline, changed);
      const decoded = readDeltaPlayerState(new MessageReader(delta.toBytes()), baseline, product);
      expect([decoded.pmType, decoded.weapon, decoded.weaponState, decoded.commandTime]).toEqual([-0x76543210, 0x7fffffff, -123456789, -2147483648]);
      expect([decoded.externalEventTime, decoded.ping, decoded.pmoveFramecount, decoded.jumppadFrame, decoded.entityEventSequence]).toEqual([-1, -2, -3, -4, -5]);
      const full = new MessageWriter();
      writeDeltaPlayerState(full, null, baseline);
      const masked = readDeltaPlayerState(new MessageReader(full.toBytes()), null, product);
      expect([masked.pmType, masked.weapon, masked.weaponState]).toEqual([240, 31, 11]);
      expect([masked.externalEventTime, masked.ping, masked.pmoveFramecount, masked.jumppadFrame, masked.entityEventSequence]).toEqual([0, 0, 0, 0, 0]);
    }
  });
});

describe("source delta diagnostics", () => {
  // Source field order: signed trTime, compact x, full y, zero origin.x/frame.
  // Huffman positions are number=9, header=20, first field=46, end=129.
  const entityBytes = Buffer.from("d1bc3c4992e47af92a5100001000008000", "hex");
  // commandTime=-1, origin.x=-3, origin.y=0.125, weaponTime=-17; end=86.
  const playerBytes = Buffer.from("b4244992f5f22a51305812", "hex");
  function baseline(): EntityState {
    const state = new EntityState(); state.number = 51; state.origin = vec3(5, 0, 0); state.frame = 2;
    return state;
  }
  function log(mode: number, offset = 0) {
    const messages: string[] = [];
    const diagnostics: DeltaMessageDiagnostics = { shownet: () => mode, offset, print: message => { messages.push(message); } };
    return { messages, diagnostics };
  }

  test("entity modes print the retained number, signed and float values, and literal source bit totals", () => {
    for (const mode of [-2, -1, 0, 1, 2, 3]) for (const offset of [0, 4]) {
      const reader = new MessageReader(entityBytes), destination = new EntityState(), output = log(mode, offset);
      destination.number = 91;
      const result = readDeltaEntity(reader, baseline(), reader.readBits(10), output.diagnostics, destination);
      expect(result).toBe(destination); expect(result.number).toBe(37); expect(result.origin.x).toBe(0); expect(result.frame).toBe(0);
      // (16*8+129-10) - (1*8+9-10) = 240, not 129-9.
      expect(output.messages).toEqual(mode >= 2 || mode === -1
        ? [`${String(3 + offset).padStart(3)}: #91  `, "pos.trTime:-1 ", "pos.trBase[0]:-3 ", "pos.trBase[1]:0.125000 ", " (240 bits)\n"] : []);
    }
  });

  test("entity remove clears the retained target before sampling shownet and forced no-change stays silent", () => {
    for (const mode of [-2, -1, 0, 1, 2, 3]) {
      const reader = new MessageReader(Buffer.from("d102", "hex")), target = richEntity(), messages: string[] = [];
      let samples = 0;
      const result = readDeltaEntity(reader, baseline(), reader.readBits(10), {
        offset: 4, shownet: () => {
          samples++; expect(target.number).toBe(1023); expect(target.pos.time).toBe(0); return mode;
        }, print: message => { messages.push(message); }
      }, target);
      expect(result).toBe(target); expect(samples).toBe(mode >= 2 ? 1 : 2);
      expect(messages).toEqual(mode >= 2 || mode === -1 ? ["  6: #37  remove\n"] : []);
      const unchanged = new MessageReader(Buffer.from("d100", "hex"));
      readDeltaEntity(unchanged, baseline(), unchanged.readBits(10), {
        offset: 0, shownet: () => { throw new Error("No-delta must not read shownet"); },
        print: () => { throw new Error("No-delta must not print"); }
      }, target);
      expect(target.number).toBe(37); expect(target.origin.x).toBe(5); expect(target.frame).toBe(2);
    }
  });

  test("entity field prints observe source-order writes and retain the header's print decision", () => {
    const reader = new MessageReader(entityBytes), from = baseline(), target = new EntityState();
    target.number = 91; target.pos = { ...target.pos, time: 777, base: vec3(9, 8, 7) }; target.eFlags = 99;
    const observed: { readonly text: string; readonly number: number; readonly time: number; readonly x: number; readonly y: number; readonly flags: number }[] = [];
    let mode = -1, samples = 0;
    readDeltaEntity(reader, from, reader.readBits(10), {
      offset: 0, shownet: () => { samples++; return mode; }, print: text => {
        observed.push({ text, number: target.number, time: target.pos.time, x: target.pos.base.x, y: target.pos.base.y, flags: target.eFlags });
        mode = 0; from.eFlags = 64;
      }
    }, target);
    expect(samples).toBe(2);
    expect(observed).toEqual([
      { text: "  3: #91  ", number: 91, time: 777, x: 9, y: 8, flags: 99 },
      { text: "pos.trTime:-1 ", number: 37, time: -1, x: 9, y: 8, flags: 99 },
      { text: "pos.trBase[0]:-3 ", number: 37, time: -1, x: -3, y: 8, flags: 99 },
      { text: "pos.trBase[1]:0.125000 ", number: 37, time: -1, x: -3, y: 0.125, flags: 99 },
      { text: " (240 bits)\n", number: 37, time: -1, x: -3, y: 0.125, flags: 64 },
    ]);
  });

  test("entity header and field print failures leave the exact reached target and cursor", () => {
    for (const stop of ["header", "field"]) {
      const reader = new MessageReader(entityBytes), target = richEntity(), failure = new RangeError("print stopped");
      target.number = 91;
      const number = reader.readBits(10);
      expect(() => readDeltaEntity(reader, baseline(), number, {
        offset: 0, shownet: () => 2, print: text => {
          if (stop === "header" || text === "pos.trTime:-1 ") throw failure;
        }
      }, target)).toThrow(failure);
      expect(target.number).toBe(stop === "header" ? 91 : 37);
      expect(target.pos.time).toBe(stop === "header" ? 1 : -1);
      expect(target.pos.base).toEqual(vec3(-1, 4098, 4101)); expect(target.frame).toBe(51);
      expect(reader.bitPosition).toBe(stop === "header" ? 20 : 46);
    }
  });

  test("player modes include negative two and print signed fields before the array-inclusive total", () => {
    for (const product of ["baseq3", "missionpack"]) {
      if (product !== "baseq3" && product !== "missionpack") throw new Error("Invalid test product");
      for (const mode of [-2, -1, 0, 1, 2, 3]) {
        const output = log(mode), result = readDeltaPlayerState(new MessageReader(playerBytes), null, product, output.diagnostics);
        expect(result.commandTime).toBe(-1); expect(result.weaponTime).toBe(-17);
        expect(output.messages).toEqual(mode >= 2 || mode === -2
          ? ["  0: playerstate ", "commandTime:-1 ", "origin[0]:-3 ", "origin[1]:0.125000 ", "weaponTime:-17 ", " (166 bits)\n"] : []);
      }
      const arrays = log(-2);
      readDeltaPlayerState(new MessageReader(Buffer.from(PLAYER_HEX, "hex")), null, product, arrays.diagnostics);
      // All arrays contribute to (199*8+1598-10)-(-10), without field print calls.
      expect(arrays.messages.at(-1)).toBe(" (3190 bits)\n"); expect(arrays.messages).toHaveLength(50);
    }
  });

  test("unchanged players still print their header and total with the source offset arithmetic", () => {
    for (const offset of [0, 4]) {
      const output = log(2, offset);
      readDeltaPlayerState(new MessageReader(Uint8Array.of(2)), null, "baseq3", output.diagnostics);
      expect(output.messages).toEqual([`${String(offset).padStart(3)}: playerstate `, ` (${offset === 0 ? 3 : 11} bits)\n`]);
    }
  });

  test("shownet four prints array tags at the reached mask reads and resamples between arrays", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const state = new PlayerState(product), writer = new MessageWriter();
      state.stats.set(0, 11); state.persistant.set(0, 22); state.ammo.set(0, 33); state.powerups.set(0, 44);
      writeDeltaPlayerState(writer, null, state);
      const reader = new MessageReader(writer.toBytes()), tags: string[] = [];
      let mode = 4;
      const decoded = readDeltaPlayerState(reader, null, product, {
        offset: 0, shownet: () => mode, print: text => {
          if (!text.startsWith("PS_")) return;
          tags.push(text);
          const maskReader = reader.copy();
          expect(maskReader.readShort()).toBe(1);
          if (text === "PS_AMMO ") mode = 0;
        },
      });
      expect(tags).toEqual(["PS_STATS ", "PS_PERSISTANT ", "PS_AMMO "]);
      expect([decoded.stats.get(0), decoded.persistant.get(0), decoded.ammo.get(0), decoded.powerups.get(0)]).toEqual([11, 22, 33, 44]);
      const output = log(4);
      readDeltaPlayerState(new MessageReader(writer.toBytes()), null, product, output.diagnostics);
      expect(output.messages.filter(text => text.startsWith("PS_"))).toEqual(["PS_STATS ", "PS_PERSISTANT ", "PS_AMMO ", "PS_POWERUPS "]);
    }
  });

  test("player header prints before reading fields and samples shownet only at entry", () => {
    const reader = new MessageReader(playerBytes), baseline = new PlayerState("baseq3"), messages: string[] = [];
    baseline.ping = 7;
    let mode = -2, samples = 0;
    const result = readDeltaPlayerState(reader, baseline, "baseq3", {
      offset: 4, shownet: () => { samples++; return mode; }, print: text => {
        if (messages.length === 0) { expect(reader.bitPosition).toBe(0); baseline.gravity = 99; baseline.ping = 8; }
        mode = 0; messages.push(text);
      }
    });
    expect(samples).toBe(2); expect(result.gravity).toBe(99); expect(result.ping).toBe(7);
    expect(messages[0]).toBe("  4: playerstate "); expect(messages.at(-1)).toBe(" (174 bits)\n");
    const stopped = new MessageReader(playerBytes), failure = new Error("header stopped");
    expect(() => readDeltaPlayerState(stopped, null, "baseq3", {
      offset: 0, shownet: () => 2, print: () => { throw failure; }
    })).toThrow(failure);
    expect(stopped.bitPosition).toBe(0);
  });

  test("full float prints use exact binary32 C decimal rounding, large fixed values and signed special values", () => {
    const cases: readonly [number, string][] = [
      [0x3c000000, "0.007812"], [0x3cc00000, "0.023438"], [0xbc000000, "-0.007812"],
      [0x67800000, "1208925819614629174706176.000000"],
      [0x7f7fffff, "340282346638528859811704183484516925440.000000"],
      [0x80000000, "-0.000000"], [0x80000001, "-0.000000"],
      [0x7f800000, "inf"], [0xff800000, "-inf"], [0x7fc00000, "nan"], [0xffc00000, "-nan"],
    ];
    for (const [bits, expected] of cases) {
      const writer = new MessageWriter();
      writer.writeByte(2); writer.writeBits(0, 1); writer.writeBits(1, 1); writer.writeBits(1, 1); writer.writeBits(bits, 32); writer.writeBits(0, 1);
      const output = log(2);
      readDeltaPlayerState(new MessageReader(writer.toBytes()), null, "baseq3", output.diagnostics);
      expect(output.messages[1]).toBe(`origin[0]:${expected} `);
    }
  });
});

const referencePath = `${process.env["Q3_SOURCE"] ?? "/home/buzzkill/Projects/qsrc/quake-iii-arena"}/code/qcommon/msg.c`;
test.skipIf(!existsSync(referencePath))("field metadata names, widths and ordering match untouched upstream tables", async () => {
  const source = Bun.file(referencePath);
  const code = await source.text();
  for (const kind of ["entity", "player"]) {
    if (kind !== "entity" && kind !== "player") throw new Error("Invalid test kind");
    const table = code.match(new RegExp(`netField_t\\s+${kind}StateFields\\[\\]\\s*=\\s*\\{([\\s\\S]*?)\\};`));
    const body = table?.[1];
    if (body === undefined) throw new Error("Missing source table");
    const fields = [...body.matchAll(/\{\s*(?:NETF|PSF)\(([^)]+)\),\s*(GENTITYNUM_BITS|-?\d+)\s*\}/g)].map((match) => {
      const name = match[1]; const bits = match[2];
      if (name === undefined || bits === undefined) throw new Error("Invalid source field");
      return { name, bits: bits === "GENTITYNUM_BITS" ? 10 : Number(bits) };
    });
    expect(stateDeltaFields(kind)).toEqual(fields);
    expect(fields.length).toBe(kind === "entity" ? 51 : 48);
  }
});
