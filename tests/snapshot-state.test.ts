import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/core/math.ts";
import { EntityEvent, EntityType, MoveType, Weapon, WeaponState } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { EntityState } from "../src/shared/entity-state.ts";
import { PlayerState } from "../src/shared/player-state.ts";
import { playerStateToEntityState, playerStateToEntityStateExtraPolate } from "../src/shared/snapshot-state.ts";
import { evaluateTrajectory, TrajectoryType } from "../src/shared/trajectory.ts";

const products: readonly Product[] = ["baseq3", "missionpack"];

function populatedPlayer(product: Product): PlayerState {
  const ps = new PlayerState(product);
  ps.commandTime = 1;
  ps.pmType = MoveType.PM_NOCLIP;
  ps.bobCycle = 3;
  ps.pmFlags = 4;
  ps.pmTime = 5;
  ps.origin = vec3(6.25, 7.5, -8.75);
  ps.velocity = vec3(9.25, -10.5, 11.75);
  ps.weaponTime = 12;
  ps.gravity = 13;
  ps.speed = 14;
  ps.deltaAngles = { x: 2147483647, y: -2147483647, z: 17 };
  ps.groundEntityNum = 18;
  ps.legsTimer = 19;
  ps.legsAnim = 20;
  ps.torsoTimer = 21;
  ps.torsoAnim = 22;
  ps.movementDir = 23;
  ps.grapplePoint = vec3(24, 25, 26);
  ps.eFlags = 27;
  ps.eventSequence = 28;
  ps.externalEvent = 29;
  ps.externalEventParm = 30;
  ps.externalEventTime = 31;
  ps.clientNum = 32;
  ps.weapon = Weapon.WP_RAILGUN;
  ps.weaponState = WeaponState.WEAPON_DROPPING;
  ps.viewangles = vec3(35.25, 36.5, 37.75);
  ps.viewheight = 38;
  ps.damageEvent = 39;
  ps.damageYaw = 40;
  ps.damagePitch = 41;
  ps.damageCount = 42;
  ps.generic1 = 43;
  ps.loopSound = 44;
  ps.jumppadEnt = 45;
  ps.ping = 46;
  ps.pmoveFramecount = 47;
  ps.jumppadFrame = 48;
  ps.entityEventSequence = 49;
  for (const [storeIndex, store] of [ps.events, ps.eventParms, ps.stats, ps.persistant, ps.powerups, ps.ammo].entries()) {
    for (let index = 0; index < store.length; index++) store.set(index, (storeIndex + 1) * 100 + index);
  }
  return ps;
}

describe("owned player state copies", () => {
  for (const product of products) test(`copies every player field and independently owns all six slot stores: ${product}`, () => {
    const original = populatedPlayer(product);
    const snapshot = original.copy();
    expect(snapshot).toEqual(original);
    expect(snapshot).not.toBe(original);
    expect(snapshot.product).toBe(product);
    expect(snapshot.deltaAngles).toEqual({ x: 2147483647, y: -2147483647, z: 17 });
    const pairs = [
      [original.origin, snapshot.origin], [original.velocity, snapshot.velocity],
      [original.deltaAngles, snapshot.deltaAngles], [original.grapplePoint, snapshot.grapplePoint],
      [original.viewangles, snapshot.viewangles],
    ];
    for (const [source, target] of pairs) expect(target).not.toBe(source);
    const originalStores = [original.events, original.eventParms, original.stats, original.persistant, original.powerups, original.ammo];
    const copyStores = [snapshot.events, snapshot.eventParms, snapshot.stats, snapshot.persistant, snapshot.powerups, snapshot.ammo];
    for (const [storeIndex, source] of originalStores.entries()) {
      const target = copyStores[storeIndex];
      if (target === undefined) throw new Error("Missing copied store");
      expect(target).not.toBe(source);
      for (let index = 0; index < source.length; index++) {
        source.set(index, -999);
        expect(target.get(index)).toBe((storeIndex + 1) * 100 + index);
        target.set(index, -888);
        expect(source.get(index)).toBe(-999);
      }
    }
    original.commandTime = 1000;
    original.ping = 2000;
    original.entityEventSequence = 3000;
    expect([snapshot.commandTime, snapshot.ping, snapshot.entityEventSequence]).toEqual([1, 46, 49]);
  });
});

function referencePlayer(product: Product): PlayerState {
  const ps = new PlayerState(product);
  ps.clientNum = 17;
  ps.health = 125;
  ps.origin = vec3(12.75, -45.875, -0.5);
  ps.velocity = vec3(-1.25, 2.5, 333.75);
  ps.viewangles = vec3(-12.5, 359.875, 0.75);
  ps.movementDir = 7;
  ps.legsAnim = 142;
  ps.torsoAnim = 139;
  ps.eFlags = 0x205;
  ps.eventSequence = 7;
  ps.entityEventSequence = 1;
  ps.events.set(0, EntityEvent.EV_FIRE_WEAPON);
  ps.events.set(1, EntityEvent.EV_JUMP);
  ps.eventParms.set(0, 91);
  ps.eventParms.set(1, 92);
  ps.weapon = Weapon.WP_ROCKET_LAUNCHER;
  ps.groundEntityNum = 1023;
  ps.powerups.set(0, -1);
  ps.powerups.set(7, 999);
  ps.powerups.set(15, 1);
  ps.loopSound = 23;
  ps.generic1 = 19;
  return ps;
}

function referenceDestination(): EntityState {
  const s = new EntityState();
  s.pos = { ...s.pos, time: 111, duration: 222 };
  s.apos = { ...s.apos, time: 333, duration: 444, delta: vec3(4, 5, 6) };
  s.angles2 = vec3(81, 82, 83);
  return s;
}

describe("player-to-entity conversion native source goldens", () => {
  // Captured from untouched bg_misc.c at dbe4ddb10315479fc00086f08e25d968b4b43c49.
  // gcc -O0 -ffunction-sections -fdata-sections, --gc-sections, with and without MISSIONPACK.
  for (const product of products) for (const extrapolate of [false, true]) for (const snap of [false, true]) {
    test(`${product}, extrapolate=${extrapolate}, snap=${snap}`, () => {
      const ps = referencePlayer(product);
      const savedPlayer = ps.copy();
      const s = referenceDestination();
      if (extrapolate) playerStateToEntityStateExtraPolate(ps, s, 123456, snap);
      else playerStateToEntityState(ps, s, snap);
      expect([s.pos.type, s.pos.time, s.pos.duration]).toEqual(extrapolate ? [3, 123456, 50] : [1, 111, 222]);
      expect(s.pos.base).toEqual(snap ? vec3(12, -45, 0) : vec3(12.75, -45.875, -0.5));
      expect(s.pos.delta).toEqual(vec3(-1.25, 2.5, 333.75));
      expect([s.apos.type, s.apos.time, s.apos.duration]).toEqual([1, 333, 444]);
      expect(s.apos.base).toEqual(snap ? vec3(-12, 359, 0) : vec3(-12.5, 359.875, 0.75));
      expect(s.apos.delta).toEqual(vec3(4, 5, 6));
      expect(s.angles2).toEqual(vec3(81, 7, 83));
      expect([s.number, s.eType, s.eFlags, s.legsAnim, s.torsoAnim, s.clientNum,
        s.event, s.eventParm, s.weapon, s.groundEntityNum, s.powerups, s.loopSound, s.generic1, ps.entityEventSequence])
        .toEqual([17, 1, 516, 142, 139, 17, 270, 92, 5, 1023, 32897, 23, 19, 6]);
      savedPlayer.entityEventSequence = 6;
      expect(ps).toEqual(savedPlayer);
      expect(s.pos.base).not.toBe(ps.origin);
      expect(s.pos.delta).not.toBe(ps.velocity);
      expect(s.apos.base).not.toBe(ps.viewangles);
    });
  }
});

describe("snapshot conversion source edge cases", () => {
  test("native x86 float-to-int snapping handles conversion limits and signed zero", () => {
    const ps = new PlayerState("baseq3");
    const s = new EntityState();
    ps.origin = vec3(2147483648, -2147483648, NaN);
    ps.viewangles = vec3(Infinity, -Infinity, -0);
    playerStateToEntityState(ps, s, true);
    expect(s.pos.base).toEqual(vec3(-2147483648, -2147483648, -2147483648));
    expect(s.apos.base).toEqual(vec3(-2147483648, -2147483648, 0));
    expect(Object.is(s.apos.base.z, -0)).toBe(false);
  });

  test("gib, spectator, and intermission visibility differs from dead and SP intermission", () => {
    const cases = [
      { mode: MoveType.PM_NORMAL, health: -40, type: EntityType.ET_INVISIBLE, dead: 1 },
      { mode: MoveType.PM_NORMAL, health: -39, type: EntityType.ET_PLAYER, dead: 1 },
      { mode: MoveType.PM_DEAD, health: 0, type: EntityType.ET_PLAYER, dead: 1 },
      { mode: MoveType.PM_SPECTATOR, health: 100, type: EntityType.ET_INVISIBLE, dead: 0 },
      { mode: MoveType.PM_INTERMISSION, health: 100, type: EntityType.ET_INVISIBLE, dead: 0 },
      { mode: MoveType.PM_SPINTERMISSION, health: 100, type: EntityType.ET_PLAYER, dead: 0 },
    ];
    for (const product of products) for (const c of cases) {
      const ps = new PlayerState(product);
      ps.pmType = c.mode;
      ps.health = c.health;
      ps.eFlags = 0x105;
      for (const extrapolate of [false, true]) {
        const s = new EntityState();
        if (extrapolate) playerStateToEntityStateExtraPolate(ps, s, 0, false);
        else playerStateToEntityState(ps, s, false);
        expect(s.eType).toBe(c.type);
        expect(s.eFlags).toBe(0x104 | c.dead);
        expect(ps.eFlags).toBe(0x105);
      }
    }
  });

  test("external events take priority without draining the predictable event queue", () => {
    const ps = referencePlayer("missionpack");
    const s = new EntityState();
    ps.externalEvent = 0x378;
    ps.externalEventParm = 71;
    playerStateToEntityState(ps, s, false);
    expect([s.event, s.eventParm, ps.entityEventSequence]).toEqual([0x378, 71, 1]);
    ps.externalEvent = 0;
    playerStateToEntityState(ps, s, false);
    expect([s.event, s.eventParm, ps.entityEventSequence]).toEqual([270, 92, 6]);
    playerStateToEntityState(ps, s, false);
    expect([s.event, s.eventParm, ps.entityEventSequence]).toEqual([535, 91, 7]);
    playerStateToEntityState(ps, s, false);
    expect([s.event, s.eventParm, ps.entityEventSequence]).toEqual([535, 91, 7]);
  });

  test("identical events carry two sequence bits, including wrap from three to zero", () => {
    const ps = new PlayerState("baseq3");
    const s = new EntityState();
    for (let sequence = 0; sequence < 6; sequence++) {
      ps.addEvent(EntityEvent.EV_FIRE_WEAPON, 900 + sequence);
      playerStateToEntityStateExtraPolate(ps, s, 10, false);
      expect(s.event).toBe(23 | ((sequence & 3) << 8));
      expect(s.eventParm).toBe(900 + sequence);
      expect(ps.entityEventSequence).toBe(sequence + 1);
    }
  });

  test("signed sequence comparison after wrap does not fabricate queued events", () => {
    const ps = new PlayerState("baseq3");
    const s = new EntityState();
    s.event = 77;
    s.eventParm = 88;
    ps.eventSequence = -2147483648;
    ps.entityEventSequence = 2147483647;
    playerStateToEntityState(ps, s, false);
    expect([s.event, s.eventParm, ps.entityEventSequence]).toEqual([77, 88, 2147483647]);
  });

  test("untouched destination fields survive and powerup mask is rebuilt", () => {
    const ps = new PlayerState("baseq3");
    const s = referenceDestination();
    s.time = 1;
    s.time2 = 2;
    s.origin = vec3(3, 4, 5);
    s.origin2 = vec3(6, 7, 8);
    s.angles = vec3(9, 10, 11);
    s.otherEntityNum = 12;
    s.otherEntityNum2 = 13;
    s.constantLight = 14;
    s.modelindex = 15;
    s.modelindex2 = 16;
    s.frame = 17;
    s.solid = 18;
    s.event = 19;
    s.eventParm = 20;
    s.powerups = 65535;
    playerStateToEntityState(ps, s, false);
    expect([s.time, s.time2, s.otherEntityNum, s.otherEntityNum2, s.constantLight,
      s.modelindex, s.modelindex2, s.frame, s.solid, s.event, s.eventParm, s.powerups])
      .toEqual([1, 2, 12, 13, 14, 15, 16, 17, 18, 19, 20, 0]);
    expect(s.origin).toEqual(vec3(3, 4, 5));
    expect(s.origin2).toEqual(vec3(6, 7, 8));
    expect(s.angles).toEqual(vec3(9, 10, 11));
  });

  test("extrapolation starts from snapped origin and stops at exactly 50ms", () => {
    const ps = new PlayerState("baseq3");
    ps.origin = vec3(12.75, -45.875, -0.5);
    ps.velocity = vec3(100, -200, 0);
    const s = new EntityState();
    playerStateToEntityStateExtraPolate(ps, s, 1000, true);
    expect(s.pos.type).toBe(TrajectoryType.TR_LINEAR_STOP);
    expect(evaluateTrajectory(s.pos, 1000)).toEqual(vec3(12, -45, 0));
    expect(evaluateTrajectory(s.pos, 1050)).toEqual(vec3(17, -55, 0));
    expect(evaluateTrajectory(s.pos, 1200)).toEqual(vec3(17, -55, 0));
    expect(ps.origin).toEqual(vec3(12.75, -45.875, -0.5));
  });
});
