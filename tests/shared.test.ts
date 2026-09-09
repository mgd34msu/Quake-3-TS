import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { vec3 } from "../src/core/math.ts";
import { CommonError } from "../src/core/common-error.ts";
import type { Vec3 } from "../src/core/math.ts";
import {
  BaseStatIndex, EntityEvent, EntityType, GameType, Holdable, ItemType,
  MissionpackStatIndex, MoveType, PersistentIndex, Powerup, Team, Weapon, WeaponState,
  statSchema, weaponAvailable, weaponCount,
} from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import {
  canItemBeGrabbed, findItem, findItemForHoldable, findItemForPowerup,
  findItemForWeapon, itemAt, itemList, playerTouchesItem,
} from "../src/shared/items.ts";
import type { PickupEntity, PlayerInventory } from "../src/shared/items.ts";
import { evaluateTrajectory, evaluateTrajectoryDelta, TrajectoryType } from "../src/shared/trajectory.ts";
import type { Trajectory } from "../src/shared/trajectory.ts";
import { EntityState, EntityStateRecord } from "../src/shared/entity-state.ts";
import type { EntityStateFields, SourceEntityState } from "../src/shared/entity-state.ts";
import { PlayerState, PlayerStateRecord, PlayerStateSlots } from "../src/shared/player-state.ts";
import type { PlayerStateFields, SourcePlayerState } from "../src/shared/player-state.ts";

describe("source state storage", () => {
  test("player copies preserve numeric extensions, every source field, and contiguous array reads", () => {
    const slotReads: number[] = [];
    class SourceSlots extends PlayerStateSlots {
      constructor(length: number, private readonly offset: number) {
        super(length);
        for (let index = 0; index < length; index++) this.set(index, offset + 4 * index);
      }

      override get(index: number): number {
        slotReads.push(this.offset + 4 * index);
        return super.get(index);
      }
    }

    const origin = { x: 20, y: 24, z: 28 };
    const source: PlayerStateFields = {
      product: "missionpack", commandTime: -1, pmType: -2147483648, bobCycle: 8,
      pmFlags: 12, pmTime: 16, origin, velocity: vec3(32, 36, 40), weaponTime: 44,
      gravity: 48, speed: 52, deltaAngles: { x: 2147483647, y: -2147483648, z: -1 },
      groundEntityNum: 68, legsTimer: 72, legsAnim: 76, torsoTimer: 80, torsoAnim: 84,
      movementDir: 88, grapplePoint: vec3(92, 96, 100), eFlags: 104, eventSequence: 108,
      events: new SourceSlots(2, 112), eventParms: new SourceSlots(2, 120),
      externalEvent: 128, externalEventParm: 132, externalEventTime: -136, clientNum: 140,
      weapon: 2147483647, weaponState: -123456789, viewangles: vec3(152, 156, 160),
      viewheight: 164, damageEvent: 168, damageYaw: 172, damagePitch: 176, damageCount: 180,
      stats: new SourceSlots(16, 184), persistant: new SourceSlots(16, 248),
      powerups: new SourceSlots(16, 312), ammo: new SourceSlots(16, 376),
      generic1: 440, loopSound: 444, jumppadEnt: 448, ping: -452,
      pmoveFramecount: 456, jumppadFrame: -460, entityEventSequence: 464,
    };
    const state = new PlayerStateRecord<number, number, number>("baseq3", 0, 0, 0);
    state.copyFrom(source);
    expect(slotReads).toEqual([
      112, 116, 120, 124,
      ...Array.from({ length: 64 }, (_, index) => 184 + 4 * index),
    ]);
    for (const key of [
      "product", "commandTime", "pmType", "bobCycle", "pmFlags", "pmTime", "origin", "velocity",
      "weaponTime", "gravity", "speed", "deltaAngles", "groundEntityNum", "legsTimer", "legsAnim",
      "torsoTimer", "torsoAnim", "movementDir", "grapplePoint", "eFlags", "eventSequence",
      "externalEvent", "externalEventParm", "externalEventTime", "clientNum", "weapon", "weaponState",
      "viewangles", "viewheight", "damageEvent", "damageYaw", "damagePitch", "damageCount",
      "generic1", "loopSound", "jumppadEnt", "ping", "pmoveFramecount", "jumppadFrame", "entityEventSequence",
    ] satisfies readonly (keyof PlayerStateFields)[]) expect(state[key]).toEqual(source[key]);
    for (const key of [
      "events", "eventParms", "stats", "persistant", "powerups", "ammo",
    ] satisfies readonly (keyof Pick<PlayerStateFields, "events" | "eventParms" | "stats" | "persistant" | "powerups" | "ammo">)[]) {
      expect(state[key].copy()).toEqual(source[key].copy());
      expect(state[key]).not.toBe(source[key]);
    }

    const copy: SourcePlayerState = state.copy();
    expect(copy).toEqual(state);
    origin.x = -20;
    source.stats.set(15, -244);
    state.weapon = -2147483648;
    state.events.set(0, -112);
    expect(state.origin.x).toBe(20);
    expect(state.stats.get(15)).toBe(244);
    expect(copy.weapon).toBe(2147483647);
    expect(copy.events.get(0)).toBe(112);
  });

  test("entity copies sample getter-backed trajectories and vectors without rounding integer words", () => {
    class BorrowedVector implements Vec3 {
      constructor(private readonly values: readonly [number, number, number]) {}
      get x(): number { return this.values[0]; }
      get y(): number { return this.values[1]; }
      get z(): number { return this.values[2]; }
    }
    class BorrowedTrajectory implements Trajectory<number> {
      get type(): number { return -2147483648; }
      get time(): number { return 2147483647; }
      get duration(): number { return -1; }
      get base(): Vec3 { return new BorrowedVector([1, -2, 3]); }
      get delta(): Vec3 { return new BorrowedVector([-4, 5, -6]); }
    }
    const source: EntityStateFields = {
      number: 0, eType: -1, eFlags: 8, pos: new BorrowedTrajectory(),
      apos: { type: 2147483647, time: -52, duration: 56, base: vec3(60, 64, 68), delta: vec3(72, 76, 80) },
      time: 84, time2: 88, origin: new BorrowedVector([92, 96, 100]), origin2: vec3(104, 108, 112),
      angles: vec3(116, 120, 124), angles2: vec3(128, 132, 136), otherEntityNum: 140,
      otherEntityNum2: 144, groundEntityNum: 148, constantLight: 152, loopSound: 156,
      modelindex: 160, modelindex2: 164, clientNum: 168, frame: 172, solid: 176, event: 180,
      eventParm: 184, powerups: 188, weapon: -192, legsAnim: 196, torsoAnim: 200, generic1: 204,
    };
    const state = new EntityStateRecord<number>(0);
    state.copyFrom(source);
    expect(state.pos).toEqual({ type: -2147483648, time: 2147483647, duration: -1,
      base: { x: 1, y: -2, z: 3 }, delta: { x: -4, y: 5, z: -6 } });
    expect(state.origin).toEqual({ x: 92, y: 96, z: 100 });
    for (const key of [
      "number", "eType", "eFlags", "apos", "time", "time2", "origin2", "angles", "angles2",
      "otherEntityNum", "otherEntityNum2", "groundEntityNum", "constantLight", "loopSound", "modelindex",
      "modelindex2", "clientNum", "frame", "solid", "event", "eventParm", "powerups", "weapon",
      "legsAnim", "torsoAnim", "generic1",
    ] satisfies readonly (keyof EntityStateFields)[]) expect(state[key]).toEqual(source[key]);
    const copy: SourceEntityState = state.copy();
    expect(copy).toEqual(state);
    expect(copy.pos).not.toBe(state.pos);
    expect(copy.pos.base).not.toBe(state.pos.base);
    expect(copy.apos).not.toBe(state.apos);
    expect(copy.origin).not.toBe(state.origin);
    state.apos = { type: -17, time: 0, duration: 0, base: vec3(0, 0, 0), delta: vec3(0, 0, 0) };
    expect(copy.apos.type).toBe(2147483647);

    const player = new PlayerStateRecord<number, number, number>("baseq3", 0, 0, 0);
    player.deltaAngles = new BorrowedVector([2147483647, -2147483648, -1]);
    expect(player.copy().deltaAngles).toEqual({ x: 2147483647, y: -2147483648, z: -1 });
  });

  test("retail constructors and copies retain retail types, defaults and event behavior", () => {
    const player = new PlayerState("missionpack");
    expect([player.pmType, player.weapon, player.weaponState]).toEqual([0, 0, 0]);
    player.pmType = MoveType.PM_SPECTATOR;
    player.weapon = Weapon.WP_CHAINGUN;
    player.weaponState = WeaponState.WEAPON_FIRING;
    player.health = 75;
    player.eventSequence = 2147483647;
    expect(player.addEvent(23, 9)).toEqual({ sequence: 2147483647, event: 23, parameter: 9 });
    const playerCopy: PlayerState = player.copy();
    expect(playerCopy).toBeInstanceOf(PlayerState);
    expect(playerCopy).toEqual(player);
    expect(playerCopy.health).toBe(75);
    expect(playerCopy.eventSequence).toBe(-2147483648);
    expect(playerCopy.events.get(1)).toBe(23);
    expect(playerCopy.eventParms.get(1)).toBe(9);

    const entity = new EntityState();
    expect(entity.pos.type).toBe(TrajectoryType.TR_STATIONARY);
    expect(entity.apos.type).toBe(TrajectoryType.TR_STATIONARY);
    const entityCopy: EntityState = entity.copy();
    expect(entityCopy).toBeInstanceOf(EntityState);
    expect(entityCopy).toEqual(entity);
    expect(entityCopy.pos).not.toBe(entity.pos);
    expect(entityCopy.pos.base).not.toBe(entity.pos.base);
  });
});

function inventory(product: Product = "baseq3"): PlayerInventory {
  const common = { health: 100, armor: 0, maxHealth: 100, holdableItem: 0, team: Team.TEAM_RED,
    ammo: (_weapon: Weapon): number => 0, powerup: (_powerup: Powerup): number => 0 };
  return product === "baseq3" ? { ...common, product } : { ...common, product, persistentPowerupIndex: 0 };
}

function entity(index: number, modelIndex2 = 0, generic1 = 0): PickupEntity {
  return { modelIndex: index, modelIndex2, generic1 };
}

describe("product numeric definitions", () => {
  test("definition and trajectory enums retain every pinned source ordinal", () => {
    // bg_public.h and q_shared.h, dbe4ddb. Expected names and order do not use port constants.
    const mappings = [
      [GameType, "GT_FFA GT_TOURNAMENT GT_SINGLE_PLAYER GT_TEAM GT_CTF GT_1FCTF GT_OBELISK GT_HARVESTER GT_MAX_GAME_TYPE"],
      [MoveType, "PM_NORMAL PM_NOCLIP PM_SPECTATOR PM_DEAD PM_FREEZE PM_INTERMISSION PM_SPINTERMISSION"],
      [WeaponState, "WEAPON_READY WEAPON_RAISING WEAPON_DROPPING WEAPON_FIRING"],
      [Powerup, "PW_NONE PW_QUAD PW_BATTLESUIT PW_HASTE PW_INVIS PW_REGEN PW_FLIGHT PW_REDFLAG PW_BLUEFLAG " +
        "PW_NEUTRALFLAG PW_SCOUT PW_GUARD PW_DOUBLER PW_AMMOREGEN PW_INVULNERABILITY PW_NUM_POWERUPS"],
      [Holdable, "HI_NONE HI_TELEPORTER HI_MEDKIT HI_KAMIKAZE HI_PORTAL HI_INVULNERABILITY HI_NUM_HOLDABLE"],
      [Weapon, "WP_NONE WP_GAUNTLET WP_MACHINEGUN WP_SHOTGUN WP_GRENADE_LAUNCHER WP_ROCKET_LAUNCHER " +
        "WP_LIGHTNING WP_RAILGUN WP_PLASMAGUN WP_BFG WP_GRAPPLING_HOOK WP_NAILGUN WP_PROX_LAUNCHER WP_CHAINGUN"],
      [EntityEvent, "EV_NONE EV_FOOTSTEP EV_FOOTSTEP_METAL EV_FOOTSPLASH EV_FOOTWADE EV_SWIM " +
        "EV_STEP_4 EV_STEP_8 EV_STEP_12 EV_STEP_16 EV_FALL_SHORT EV_FALL_MEDIUM EV_FALL_FAR EV_JUMP_PAD EV_JUMP " +
        "EV_WATER_TOUCH EV_WATER_LEAVE EV_WATER_UNDER EV_WATER_CLEAR EV_ITEM_PICKUP EV_GLOBAL_ITEM_PICKUP " +
        "EV_NOAMMO EV_CHANGE_WEAPON EV_FIRE_WEAPON EV_USE_ITEM0 EV_USE_ITEM1 EV_USE_ITEM2 EV_USE_ITEM3 " +
        "EV_USE_ITEM4 EV_USE_ITEM5 EV_USE_ITEM6 EV_USE_ITEM7 EV_USE_ITEM8 EV_USE_ITEM9 EV_USE_ITEM10 EV_USE_ITEM11 " +
        "EV_USE_ITEM12 EV_USE_ITEM13 EV_USE_ITEM14 EV_USE_ITEM15 EV_ITEM_RESPAWN EV_ITEM_POP " +
        "EV_PLAYER_TELEPORT_IN EV_PLAYER_TELEPORT_OUT EV_GRENADE_BOUNCE EV_GENERAL_SOUND EV_GLOBAL_SOUND " +
        "EV_GLOBAL_TEAM_SOUND EV_BULLET_HIT_FLESH EV_BULLET_HIT_WALL EV_MISSILE_HIT EV_MISSILE_MISS " +
        "EV_MISSILE_MISS_METAL EV_RAILTRAIL EV_SHOTGUN EV_BULLET EV_PAIN EV_DEATH1 EV_DEATH2 EV_DEATH3 " +
        "EV_OBITUARY EV_POWERUP_QUAD EV_POWERUP_BATTLESUIT EV_POWERUP_REGEN EV_GIB_PLAYER EV_SCOREPLUM " +
        "EV_PROXIMITY_MINE_STICK EV_PROXIMITY_MINE_TRIGGER EV_KAMIKAZE EV_OBELISKEXPLODE EV_OBELISKPAIN " +
        "EV_INVUL_IMPACT EV_JUICED EV_LIGHTNINGBOLT EV_DEBUG_LINE EV_STOPLOOPINGSOUND EV_TAUNT " +
        "EV_TAUNT_YES EV_TAUNT_NO EV_TAUNT_FOLLOWME EV_TAUNT_GETFLAG EV_TAUNT_GUARDBASE EV_TAUNT_PATROL"],
      [Team, "TEAM_FREE TEAM_RED TEAM_BLUE TEAM_SPECTATOR TEAM_NUM_TEAMS"],
      [ItemType, "IT_BAD IT_WEAPON IT_AMMO IT_ARMOR IT_HEALTH IT_POWERUP IT_HOLDABLE IT_PERSISTANT_POWERUP IT_TEAM"],
      [EntityType, "ET_GENERAL ET_PLAYER ET_ITEM ET_MISSILE ET_MOVER ET_BEAM ET_PORTAL ET_SPEAKER " +
        "ET_PUSH_TRIGGER ET_TELEPORT_TRIGGER ET_INVISIBLE ET_GRAPPLE ET_TEAM ET_EVENTS"],
      [PersistentIndex, "PERS_SCORE PERS_HITS PERS_RANK PERS_TEAM PERS_SPAWN_COUNT PERS_PLAYEREVENTS PERS_ATTACKER " +
        "PERS_ATTACKEE_ARMOR PERS_KILLED PERS_IMPRESSIVE_COUNT PERS_EXCELLENT_COUNT PERS_DEFEND_COUNT " +
        "PERS_ASSIST_COUNT PERS_GAUNTLET_FRAG_COUNT PERS_CAPTURES"],
      [BaseStatIndex, "STAT_HEALTH STAT_HOLDABLE_ITEM STAT_WEAPONS STAT_ARMOR STAT_DEAD_YAW STAT_CLIENTS_READY STAT_MAX_HEALTH"],
      [MissionpackStatIndex, "STAT_HEALTH STAT_HOLDABLE_ITEM STAT_PERSISTANT_POWERUP STAT_WEAPONS STAT_ARMOR " +
        "STAT_DEAD_YAW STAT_CLIENTS_READY STAT_MAX_HEALTH"],
      [TrajectoryType, "TR_STATIONARY TR_INTERPOLATE TR_LINEAR TR_LINEAR_STOP TR_SINE TR_GRAVITY"],
    ] satisfies readonly (readonly [Readonly<Record<string, string | number>>, string])[];
    for (const [values, names] of mappings) {
      const actual = Object.entries<string | number>(values).filter(([, value]) => typeof value === "number");
      expect(actual).toEqual(names.split(" ").map((name, ordinal) => [name, ordinal]));
    }
    for (const weapon of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] satisfies readonly Weapon[]) {
      expect(weaponAvailable("baseq3", weapon)).toBe(weapon >= 1 && weapon <= 10);
      expect(weaponAvailable("missionpack", weapon)).toBe(weapon >= 1 && weapon <= 13);
    }
  });

  test("stat insertion shifts every subsequent missionpack slot", () => {
    expect([BaseStatIndex.STAT_HEALTH, BaseStatIndex.STAT_HOLDABLE_ITEM, BaseStatIndex.STAT_WEAPONS,
      BaseStatIndex.STAT_ARMOR, BaseStatIndex.STAT_DEAD_YAW, BaseStatIndex.STAT_CLIENTS_READY,
      BaseStatIndex.STAT_MAX_HEALTH]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([MissionpackStatIndex.STAT_HEALTH, MissionpackStatIndex.STAT_HOLDABLE_ITEM,
      MissionpackStatIndex.STAT_PERSISTANT_POWERUP, MissionpackStatIndex.STAT_WEAPONS,
      MissionpackStatIndex.STAT_ARMOR, MissionpackStatIndex.STAT_DEAD_YAW,
      MissionpackStatIndex.STAT_CLIENTS_READY, MissionpackStatIndex.STAT_MAX_HEALTH]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(statSchema("baseq3")).toEqual({ product: "baseq3", health: 0, holdableItem: 1,
      weapons: 2, armor: 3, deadYaw: 4, clientsReady: 5, maxHealth: 6 });
    expect(statSchema("missionpack")).toEqual({ product: "missionpack", health: 0, holdableItem: 1,
      persistentPowerup: 2, weapons: 3, armor: 4, deadYaw: 5, clientsReady: 6, maxHealth: 7 });
  });

  test("wire values include missionpack events in both products", () => {
    expect([Weapon.WP_GAUNTLET, Weapon.WP_GRAPPLING_HOOK, Weapon.WP_NAILGUN, Weapon.WP_CHAINGUN]).toEqual([1, 10, 11, 13]);
    expect([weaponCount("baseq3"), weaponCount("missionpack")]).toEqual([11, 14]);
    expect(weaponAvailable("baseq3", Weapon.WP_NAILGUN)).toBe(false);
    expect(weaponAvailable("missionpack", Weapon.WP_NAILGUN)).toBe(true);
    expect([GameType.GT_CTF, GameType.GT_1FCTF, GameType.GT_HARVESTER]).toEqual([4, 5, 7]);
    expect([Powerup.PW_REDFLAG, Powerup.PW_SCOUT, Powerup.PW_INVULNERABILITY]).toEqual([7, 10, 14]);
    expect([Holdable.HI_TELEPORTER, Holdable.HI_INVULNERABILITY, EntityType.ET_EVENTS]).toEqual([1, 5, 13]);
    expect([EntityEvent.EV_FIRE_WEAPON, EntityEvent.EV_USE_ITEM0, EntityEvent.EV_PROXIMITY_MINE_STICK,
      EntityEvent.EV_TAUNT_PATROL]).toEqual([23, 24, 66, 82]);
  });
});

describe("ordered item tables and lookup", () => {
  test("missing holdables and weapons retain source drop codes and diagnostics", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const cases = [
        { lookup: () => findItemForHoldable(product, Holdable.HI_NONE), message: "HoldableItem not found" },
        { lookup: () => findItemForWeapon(product, Weapon.WP_NONE), message: "Couldn't find item for weapon 0" },
      ];
      if (product === "baseq3") {
        cases.push(
          { lookup: () => findItemForHoldable(product, Holdable.HI_KAMIKAZE), message: "HoldableItem not found" },
          { lookup: () => findItemForWeapon(product, Weapon.WP_NAILGUN), message: "Couldn't find item for weapon 11" },
        );
      }
      for (const { lookup, message } of cases) {
        let caught: unknown;
        try { lookup(); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(CommonError);
        if (!(caught instanceof CommonError)) throw new Error("Expected source item lookup drop");
        expect(caught.code).toBe("drop");
        expect(caught.message).toBe(message);
      }
    }
  });

  test("reserved slot and exact product extension positions", () => {
    expect(itemList("baseq3")).toHaveLength(36);
    expect(itemList("missionpack")).toHaveLength(52);
    expect(itemAt("baseq3", 0).className).toBeNull();
    expect(itemAt("baseq3", 35).className).toBe("team_CTF_blueflag");
    expect(itemAt("missionpack", 36).className).toBe("holdable_kamikaze");
    expect(itemAt("missionpack", 42).className).toBe("item_scout");
    expect(itemAt("missionpack", 46).className).toBe("team_CTF_neutralflag");
    expect(itemAt("missionpack", 49).className).toBe("weapon_nailgun");
    expect(itemAt("missionpack", 51).quantity).toBe(80);
    expect(itemList("missionpack").slice(0, 36)).toEqual([...itemList("baseq3")]);
    expect(() => itemAt("baseq3", 36)).toThrow();
    expect(() => itemAt("missionpack", 52)).toThrow();
    expect(() => itemAt("baseq3", 1.5)).toThrow();
    expect(Object.isFrozen(itemAt("baseq3", 1).worldModels)).toBe(true);
  });

  test("lookups preserve source missing-item behavior and exact assets", () => {
    expect(findItem("baseq3", "rOcKeT lAuNcHeR")).toBe(itemAt("baseq3", 12));
    expect(findItem("baseq3", "unknown")).toBeNull();
    expect(findItem("baseq3", "MedKit")).toBeNull();
    expect(findItemForPowerup("baseq3", Powerup.PW_SCOUT)).toBeNull();
    expect(findItemForPowerup("missionpack", Powerup.PW_SCOUT)).toBe(itemAt("missionpack", 42));
    expect(findItemForPowerup("missionpack", Powerup.PW_NONE)?.className).toBe("item_redcube");
    expect(findItemForHoldable("baseq3", Holdable.HI_MEDKIT).worldModels).toEqual([
      "models/powerups/holdable/medkit.md3", "models/powerups/holdable/medkit_sphere.md3", null, null,
    ]);
    expect(findItemForWeapon("missionpack", Weapon.WP_PROX_LAUNCHER).sounds).toBe(
      "sound/weapons/proxmine/wstbtick.wav sound/weapons/proxmine/wstbactv.wav sound/weapons/proxmine/wstbimpl.wav " +
      "sound/weapons/proxmine/wstbimpm.wav sound/weapons/proxmine/wstbimpd.wav sound/weapons/proxmine/wstbactv.wav");
    expect(() => findItemForWeapon("baseq3", Weapon.WP_NAILGUN)).toThrow();
    expect(() => findItemForHoldable("baseq3", Holdable.HI_KAMIKAZE)).toThrow();
  });
});

describe("BG_CanItemBeGrabbed", () => {
  test("reads the raw persistent index only in reached armor and health branches", () => {
    for (const persistentPowerupIndex of [-1, 999]) {
      const state: PlayerInventory = { ...inventory(), product: "missionpack", team: 4, persistentPowerupIndex };
      for (const index of [10, 19, 26, 28]) {
        expect(canItemBeGrabbed(GameType.GT_FFA, entity(index), state)).toBe(true);
      }
      expect(canItemBeGrabbed(GameType.GT_TEAM, entity(42), state)).toBe(false);
      expect(canItemBeGrabbed(GameType.GT_CTF, entity(34), state)).toBe(false);
      for (const index of [1, 4]) {
        expect(() => canItemBeGrabbed(GameType.GT_FFA, entity(index), state)).toThrow(`Item index out of range: ${persistentPowerupIndex}`);
      }
    }
  });

  test("compares source tags for zero and nonpersistent inventory item indexes", () => {
    // bg_misc.c compares giTag directly: grapple 17 aliases scout 10, nailgun 49 aliases guard 11.
    const ordinary: PlayerInventory = { ...inventory(), product: "missionpack", persistentPowerupIndex: 0, armor: 100 };
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(1), ordinary)).toBe(true);
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(4), ordinary)).toBe(true);
    const scout: PlayerInventory = { ...ordinary, persistentPowerupIndex: 17 };
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(1), scout)).toBe(false);
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(4), scout)).toBe(true);
    const guard: PlayerInventory = { ...ordinary, persistentPowerupIndex: 49 };
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(1), guard)).toBe(false);
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(4), guard)).toBe(false);
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(1), { ...guard, armor: 99 })).toBe(true);
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(4), { ...guard, health: 99 })).toBe(true);
    for (const persistentPowerupIndex of [17, 49]) {
      expect(canItemBeGrabbed(GameType.GT_TEAM, entity(42), { ...ordinary, persistentPowerupIndex })).toBe(false);
    }
    expect(canItemBeGrabbed(GameType.GT_TEAM, entity(42), { ...ordinary, team: 4 })).toBe(true);
    expect(canItemBeGrabbed(GameType.GT_TEAM, entity(42, 0, 2), { ...ordinary, team: 4 })).toBe(false);
    expect(canItemBeGrabbed(GameType.GT_TEAM, entity(42, 0, 4), { ...ordinary, team: 4 })).toBe(false);
  });

  test("source index bounds drop before inventory reads and leave managed guards separate", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const state = inventory(product);
      const unread: PlayerInventory = {
        ...state,
        get armor(): number { throw new Error("Inventory read before item index check"); },
        ammo: () => { throw new Error("Ammo read before item index check"); },
        powerup: () => { throw new Error("Powerup read before item index check"); },
      };
      const count = itemList(product).length;
      for (const index of [-1, 0, count, count + 1]) {
        let caught: unknown;
        try { canItemBeGrabbed(GameType.GT_CTF, entity(index), unread); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(CommonError);
        if (!(caught instanceof CommonError)) throw new Error("Expected source item index drop");
        expect(caught.code).toBe("drop");
        expect(caught.message).toBe("BG_CanItemBeGrabbed: index out of range");
      }
      expect(canItemBeGrabbed(GameType.GT_CTF, entity(1), state)).toBe(true);
      expect(canItemBeGrabbed(GameType.GT_CTF, entity(count - 1), state)).toBe(true);
      expect(() => itemAt(product, count)).toThrow(RangeError);
      expect(() => itemAt(product, count)).toThrow(`Item index out of range: ${count}`);
      expect(() => canItemBeGrabbed(GameType.GT_CTF, entity(1.5), state)).toThrow(RangeError);
    }
  });

  test("every product item matches the source inventory eligibility matrix", () => {
    const weaponsAndPowerups = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 28, 29, 30, 31, 32, 33];
    const ordinary = [1, 2, 3, 4, 7, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, ...weaponsAndPowerups];
    const missionWeapons = [49, 50, 51];
    const missionInventory = [36, 37, 38, 39, 40, 41, 42, 43, 44, 45, ...missionWeapons];
    const cases: readonly { readonly state: PlayerInventory; readonly expected: readonly number[] }[] = [
      { state: inventory(), expected: ordinary },
      { state: { ...inventory(), health: 99 }, expected: [...ordinary, 5, 6] },
      { state: { ...inventory(), health: 200, armor: 200, holdableItem: 27, ammo: () => 200 }, expected: weaponsAndPowerups },
      { state: inventory("missionpack"), expected: [...ordinary, ...missionInventory] },
      { state: { ...inventory("missionpack"), health: 99 }, expected: [...ordinary, 5, 6, ...missionInventory] },
      { state: { ...inventory("missionpack"), health: 200, armor: 200, holdableItem: 27, ammo: () => 200 },
        expected: [...weaponsAndPowerups, 42, 43, 44, 45, ...missionWeapons] },
    ];
    for (const { state, expected } of cases) {
      const allowed = new Set(expected);
      for (let index = 1; index < itemList(state.product).length; index++) {
        expect({ product: state.product, index, allowed: canItemBeGrabbed(GameType.GT_FFA, entity(index), state) })
          .toEqual({ product: state.product, index, allowed: allowed.has(index) });
      }
    }
    for (const [persistentPowerupIndex, replenishment] of [
      [42, [4, 7]], [43, []], [44, [1, 2, 3, 4, 7]], [45, [1, 2, 3, 4, 7]],
    ] satisfies readonly (readonly [number, readonly number[]])[]) {
      const state: PlayerInventory = { ...inventory(), product: "missionpack", persistentPowerupIndex,
        health: 100, armor: 100, holdableItem: 27, ammo: () => 200 };
      const allowed = new Set([...weaponsAndPowerups, ...missionWeapons, ...replenishment]);
      for (let index = 1; index < itemList(state.product).length; index++) {
        expect({ persistentPowerupIndex, index, allowed: canItemBeGrabbed(GameType.GT_FFA, entity(index), state) })
          .toEqual({ persistentPowerupIndex, index, allowed: allowed.has(index) });
      }
    }
  });

  test("health and armor caps honor handicap and overhealth quantities", () => {
    const ps = inventory();
    for (const index of [4, 7]) {
      expect(canItemBeGrabbed(GameType.GT_FFA, entity(index), ps)).toBe(true);
      expect(canItemBeGrabbed(GameType.GT_FFA, entity(index), { ...ps, health: 199 })).toBe(true);
      expect(canItemBeGrabbed(GameType.GT_FFA, entity(index), { ...ps, health: 200 })).toBe(false);
    }
    for (const index of [5, 6]) {
      expect(canItemBeGrabbed(GameType.GT_FFA, entity(index), ps)).toBe(false);
      expect(canItemBeGrabbed(GameType.GT_FFA, entity(index), { ...ps, health: 99 })).toBe(true);
    }
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(3), { ...ps, maxHealth: 50, armor: 99 })).toBe(true);
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(3), { ...ps, maxHealth: 50, armor: 100 })).toBe(false);
  });

  test("scout refuses armor and guard caps all health and armor at maxHealth", () => {
    const scout: PlayerInventory = { ...inventory(), product: "missionpack", persistentPowerupIndex: 42 };
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(1), scout)).toBe(false);
    const guard: PlayerInventory = { ...inventory(), product: "missionpack", persistentPowerupIndex: 43 };
    for (const index of [4, 5, 6, 7]) {
      expect(canItemBeGrabbed(GameType.GT_FFA, entity(index), guard)).toBe(false);
      expect(canItemBeGrabbed(GameType.GT_FFA, entity(index), { ...guard, health: 99 })).toBe(true);
    }
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(1), { ...guard, armor: 100 })).toBe(false);
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(1), { ...guard, armor: 99 })).toBe(true);
  });

  test("weapons and timed powerups always qualify; ammo and holdables are capped", () => {
    const ps = inventory();
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(10), { ...ps, ammo: () => 200 })).toBe(true);
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(28), { ...ps, powerup: () => 12345 })).toBe(true);
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(19), { ...ps, ammo: () => 199 })).toBe(true);
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(19), { ...ps, ammo: () => 200 })).toBe(false);
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(26), ps)).toBe(true);
    expect(canItemBeGrabbed(GameType.GT_FFA, entity(26), { ...ps, holdableItem: 27 })).toBe(false);
    for (const index of [-1, 0, 36, 1.5, NaN]) expect(() => canItemBeGrabbed(GameType.GT_FFA, entity(index), ps)).toThrow();
  });

  test("persistent powerups are single-slot and team restricted", () => {
    const ps = inventory("missionpack");
    expect(canItemBeGrabbed(GameType.GT_TEAM, entity(42), ps)).toBe(true);
    expect(canItemBeGrabbed(GameType.GT_TEAM, entity(42, 0, 2), ps)).toBe(true);
    expect(canItemBeGrabbed(GameType.GT_TEAM, entity(42, 0, 4), ps)).toBe(false);
    expect(canItemBeGrabbed(GameType.GT_TEAM, entity(42, 0, 6), ps)).toBe(false);
    expect(canItemBeGrabbed(GameType.GT_TEAM, entity(42, 0, 4), { ...ps, team: Team.TEAM_BLUE })).toBe(true);
    const carrying: PlayerInventory = { ...ps, product: "missionpack", persistentPowerupIndex: 44 };
    expect(canItemBeGrabbed(GameType.GT_TEAM, entity(42), carrying)).toBe(false);
  });

  test("CTF enemy pickup, own dropped return, own-base capture and spectator rejection", () => {
    const cases = [
      { team: Team.TEAM_RED, own: 34, enemy: 35, enemyPowerup: Powerup.PW_BLUEFLAG },
      { team: Team.TEAM_BLUE, own: 35, enemy: 34, enemyPowerup: Powerup.PW_REDFLAG },
    ];
    for (const c of cases) {
      const ps = { ...inventory(), team: c.team };
      expect(canItemBeGrabbed(GameType.GT_CTF, entity(c.enemy), ps)).toBe(true);
      expect(canItemBeGrabbed(GameType.GT_CTF, entity(c.own), ps)).toBe(false);
      expect(canItemBeGrabbed(GameType.GT_CTF, entity(c.own, 1), ps)).toBe(true);
      expect(canItemBeGrabbed(GameType.GT_CTF, entity(c.own), {
        ...ps, powerup: powerup => powerup === c.enemyPowerup ? 1 : 0,
      })).toBe(true);
      expect(canItemBeGrabbed(GameType.GT_FFA, entity(c.enemy), ps)).toBe(false);
    }
    expect(canItemBeGrabbed(GameType.GT_CTF, entity(34, 1), { ...inventory(), team: Team.TEAM_SPECTATOR })).toBe(false);
  });

  test("one-flag objectives and harvester are missionpack branches", () => {
    const ps = inventory("missionpack");
    expect(canItemBeGrabbed(GameType.GT_1FCTF, entity(46), ps)).toBe(true);
    expect(canItemBeGrabbed(GameType.GT_1FCTF, entity(35), ps)).toBe(false);
    const carrying = { ...ps, powerup: (powerup: Powerup) => powerup === Powerup.PW_NEUTRALFLAG ? 1 : 0 };
    expect(canItemBeGrabbed(GameType.GT_1FCTF, entity(35), carrying)).toBe(true);
    expect(canItemBeGrabbed(GameType.GT_1FCTF, entity(34), carrying)).toBe(false);
    expect(canItemBeGrabbed(GameType.GT_1FCTF, entity(34), { ...carrying, team: Team.TEAM_BLUE })).toBe(true);
    expect(canItemBeGrabbed(GameType.GT_HARVESTER, entity(47), ps)).toBe(true);
    expect(canItemBeGrabbed(GameType.GT_HARVESTER, entity(48), ps)).toBe(true);
    expect(canItemBeGrabbed(GameType.GT_HARVESTER, entity(34), inventory())).toBe(false);
  });
});

function trajectory(type: TrajectoryType): Trajectory {
  return { type, time: 1000, duration: 2000, base: vec3(1, 2, 3), delta: vec3(10, 20, 100) };
}

describe("BG trajectory evaluation and pickup volume", () => {
  test("stationary and interpolated trajectories copy origin and report zero velocity", () => {
    for (const type of [TrajectoryType.TR_STATIONARY, TrajectoryType.TR_INTERPOLATE]) {
      const tr = trajectory(type);
      expect(evaluateTrajectory(tr, 5000)).toEqual(tr.base);
      expect(evaluateTrajectoryDelta(tr, 5000)).toEqual(vec3(0, 0, 0));
    }
  });

  test("linear positions extrapolate before start and gravity uses 800 units", () => {
    expect(evaluateTrajectory(trajectory(TrajectoryType.TR_LINEAR), 1500)).toEqual(vec3(6, 12, 53));
    expect(evaluateTrajectory(trajectory(TrajectoryType.TR_LINEAR), 500)).toEqual(vec3(-4, -8, -47));
    const tr = trajectory(TrajectoryType.TR_GRAVITY);
    expect(evaluateTrajectory(tr, 1500)).toEqual(vec3(6, 12, -47));
    expect(evaluateTrajectoryDelta(tr, 1500)).toEqual(vec3(10, 20, -300));
    expect(evaluateTrajectory(tr, 2000)).toEqual(vec3(11, 22, -297));
  });

  test("linear stop clamps position, but velocity persists before start and at exact end", () => {
    const tr = trajectory(TrajectoryType.TR_LINEAR_STOP);
    expect(evaluateTrajectory(tr, 0)).toEqual(tr.base);
    expect(evaluateTrajectory(tr, 4000)).toEqual(vec3(21, 42, 203));
    expect(evaluateTrajectoryDelta(tr, 0)).toEqual(tr.delta);
    expect(evaluateTrajectoryDelta(tr, 3000)).toEqual(tr.delta);
    expect(evaluateTrajectoryDelta(tr, 3001)).toEqual(vec3(0, 0, 0));
  });

  test("sine uses duration for phase and source's half-amplitude cosine for delta", () => {
    const tr = trajectory(TrajectoryType.TR_SINE);
    expect(evaluateTrajectory(tr, 1500)).toEqual(vec3(11, 22, 103));
    expect(evaluateTrajectory(tr, 2500)).toEqual(vec3(-9, -18, -97));
    expect(evaluateTrajectoryDelta(tr, 1000)).toEqual(vec3(5, 10, 50));
    expect(evaluateTrajectoryDelta(tr, 2000)).toEqual(vec3(-5, -10, -50));
    expect(evaluateTrajectoryDelta({ ...tr, duration: 4000 }, 1000)).toEqual(vec3(5, 10, 50));
    expect(Number.isNaN(evaluateTrajectory({ ...tr, duration: 0 }, 1000).x)).toBe(true);
  });

  test("pickup box keeps asymmetric x bounds and includes exact boundaries", () => {
    const tr = { ...trajectory(TrajectoryType.TR_STATIONARY), base: vec3(0, 0, 0) };
    expect(playerTouchesItem(vec3(44, 36, 36), tr, 1000)).toBe(true);
    expect(playerTouchesItem(vec3(-50, -36, -36), tr, 1000)).toBe(true);
    expect(playerTouchesItem(vec3(45, 0, 0), tr, 1000)).toBe(false);
    expect(playerTouchesItem(vec3(-51, 0, 0), tr, 1000)).toBe(false);
    expect(playerTouchesItem(vec3(0, 37, 0), tr, 1000)).toBe(false);
    expect(playerTouchesItem(vec3(0, 0, -37), tr, 1000)).toBe(false);
    expect(playerTouchesItem(vec3(54, 0, 0), { ...tr, type: TrajectoryType.TR_LINEAR, delta: vec3(10, 0, 0) }, 2000)).toBe(true);
  });
});

type Initializer = string | number | null | readonly Initializer[];

function parseItemInitializers(source: string): readonly Initializer[] {
  const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/^\s*#.*$/gm, "");
  const body = cleaned.slice(cleaned.indexOf("bg_itemlist[]"));
  const initializer = body.slice(body.indexOf("{"), body.indexOf("};") + 1);
  const tokens = initializer.match(/"[^"]*"|[A-Z][A-Z_0-9]*|-?\d+|[{},]/g);
  if (tokens === null) throw new Error("Source item initializer missing");
  const constants = new Map<string, number>();
  for (const values of [Weapon, Holdable, Powerup, ItemType]) {
    for (const [key, value] of Object.entries<string | number>(values)) if (typeof value === "number") constants.set(key, value);
  }
  let cursor = 0;
  function value(): Initializer {
    const token = tokens?.[cursor++];
    if (token === undefined) throw new Error("Truncated source initializer");
    if (token === "{") {
      const values: Initializer[] = [];
      while (tokens?.[cursor] !== "}") {
        values.push(value());
        if (tokens?.[cursor] === ",") cursor++;
      }
      cursor++;
      return values;
    }
    if (token.startsWith('"')) {
      let text = token.slice(1, -1);
      while (tokens?.[cursor]?.startsWith('"')) {
        const continuation = tokens[cursor++];
        if (continuation === undefined) throw new Error("Missing string continuation");
        text += continuation.slice(1, -1);
      }
      return text;
    }
    if (token === "NULL") return null;
    if (/^-?\d+$/.test(token)) return Number(token);
    const constant = constants.get(token);
    if (constant === undefined) throw new Error(`Unknown source constant ${token}`);
    return constant;
  }
  const parsed = value();
  if (parsed === null || typeof parsed !== "object") throw new Error("Expected initializer array");
  return parsed;
}

const sourceRoot = process.env["QUAKE3_SOURCE"] ?? "/home/buzzkill/Projects/qsrc/quake-iii-arena";
const sourceFile = `${sourceRoot}/code/game/bg_misc.c`;
test.skipIf(!existsSync(sourceFile))("every item field equals the grounded source initializer for both products", () => {
  const original = parseItemInitializers(readFileSync(sourceFile, "utf8"));
  expect(original).toHaveLength(53);
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    for (const [index, item] of itemList(product).entries()) {
      const actual: readonly Initializer[] = [
        item.className, item.pickupSound, item.worldModels.map(model => model ?? 0),
        item.icon, item.pickupName, item.quantity, item.type, item.tag, item.precaches, item.sounds,
      ];
      const expected = index === 0
        ? [null, null, [0, 0, 0, 0], null, null, 0, 0, 0, "", ""]
        : original[index];
      if (expected === null || typeof expected !== "object") throw new Error(`Missing source item ${index}`);
      expect(actual).toEqual(expected);
    }
  }
});
