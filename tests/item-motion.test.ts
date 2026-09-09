import { describe, expect, test } from "bun:test";
import type { BspMap, BspPlane } from "../src/assets/bsp.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import type { Bounds } from "../src/core/math.ts";
import { EntityPool, runThink } from "../src/game/entities.ts";
import { bounceItem, dropItem, launchItem, runItem } from "../src/game/item-motion.ts";
import type { DropItemContext, LaunchItemContext } from "../src/game/item-motion.ts";
import type { EntityThink, EntityTouch } from "../src/game/state.ts";
import { GameEntity, GameFlags } from "../src/game/state.ts";
import { ServerWorld } from "../src/server/world.ts";
import type { ServerTraceResult } from "../src/server/world.ts";
import { EntityType, GameType, Powerup, Weapon } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { findItemForPowerup, findItemForWeapon } from "../src/shared/items.ts";
import type { ItemDefinition } from "../src/shared/items.ts";
import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from "../src/shared/player-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";

const SOLID = 1;
const NODROP = 0x80000000;
const worldBounds: Bounds = { min: vec3(-1024, -1024, -1024), max: vec3(1024, 1024, 1024) };

function floorMap(contents = SOLID): BspMap {
  const floorBounds: Bounds = { min: vec3(-512, -512, -512), max: vec3(512, 512, 0) };
  const volumeBounds: Bounds = { min: vec3(-512, -512, 0), max: vec3(512, 512, 512) };
  const planesFor = (bounds: Bounds): readonly BspPlane[] => [
    { normal: vec3(1, 0, 0), distance: bounds.max.x },
    { normal: vec3(-1, 0, 0), distance: -bounds.min.x },
    { normal: vec3(0, 1, 0), distance: bounds.max.y },
    { normal: vec3(0, -1, 0), distance: -bounds.min.y },
    { normal: vec3(0, 0, 1), distance: bounds.max.z },
    { normal: vec3(0, 0, -1), distance: -bounds.min.z },
  ];
  const hasNoDrop = (contents & NODROP) !== 0;
  const floorPlanes = planesFor(floorBounds);
  const planes = hasNoDrop ? [...floorPlanes, ...planesFor(volumeBounds)] : [...floorPlanes];
  const shaders = hasNoDrop
    ? [{ name: "floor", surfaceFlags: 0, contentFlags: SOLID }, { name: "nodrop", surfaceFlags: 0, contentFlags: NODROP }]
    : [{ name: "floor", surfaceFlags: 0, contentFlags: SOLID }];
  const brushes = hasNoDrop
    ? [{ firstSide: 0, sideCount: floorPlanes.length, shader: 0 }, { firstSide: floorPlanes.length, sideCount: 6, shader: 1 }]
    : [{ firstSide: 0, sideCount: floorPlanes.length, shader: 0 }];
  return {
    entities: "", entityRecords: [], shaders, planes, nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds: worldBounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: brushes.length }],
    leafSurfaces: [], leafBrushes: brushes.map((_brush, index) => index),
    models: [{ bounds: worldBounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: brushes.length }],
    brushes,
    brushSides: planes.map((_plane, index) => ({ plane: index, shader: index < floorPlanes.length ? 0 : 1 })),
    vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null,
  };
}

function fixture(product: Product = "baseq3", contents = SOLID) {
  const clock = { now: 0 };
  let activeWorld: ServerWorld | null = null;
  const currentWorld = (): ServerWorld => {
    if (activeWorld === null) throw new Error("Fixture world is not initialized");
    return activeWorld;
  };
  const pool = new EntityPool({ print: text => { worldPrints.push(text); }, product, maxClients: 1, mapStartTime: 0, time: () => clock.now,
    link: entity => { currentWorld().link(entity); }, unlink: entity => { currentWorld().unlink(entity.slot); } });
  const worldPrints: string[] = [];
  activeWorld = new ServerWorld(new CollisionWorld(floorMap(contents), { kind: "unaccounted" }, { kind: "disabled" }), worldBounds, number => pool.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  pool.at(ENTITYNUM_WORLD).s.number = ENTITYNUM_WORLD;
  return { clock, pool, world: currentWorld() };
}

function trace(fraction: number, end = vec3(0, 0, 0), normal = vec3(0, 0, 1), entityNum = ENTITYNUM_WORLD): ServerTraceResult {
  return { fraction, end, solidity: "clear", contact: { kind: "plane", plane: { normal, distance: 0 } },
    contents: SOLID, surfaceFlags: 0, entityNum };
}

function requiredPowerup(product: Product, powerup: Powerup): ItemDefinition {
  const item = findItemForPowerup(product, powerup);
  if (item === null) throw new Error(`Fixture powerup ${powerup} is unavailable`);
  return item;
}

function launchContext(product: Product, gameType: GameType, time = 1_000) {
  const setup = fixture(product);
  setup.clock.now = time;
  const checked: GameEntity[] = [];
  const expired: GameEntity[] = [];
  const touched: GameEntity[] = [];
  const touchItem: EntityTouch = self => { touched.push(self); };
  const droppedFlagThink: EntityThink = self => { expired.push(self); };
  const context: LaunchItemContext = { entities: setup.pool, product, gameType, time, touchItem, droppedFlagThink,
    checkDroppedTeamItem: self => { checked.push(self); } };
  return { ...setup, context, checked, expired, touched, touchItem, droppedFlagThink };
}

describe("G_BounceItem", () => {
  test("converts rounded hit time before a linear-stop trajectory comparison", () => {
    const entity = new GameEntity(64);
    entity.physicsBounce = 0.5;
    entity.s.pos = { type: TrajectoryType.TR_LINEAR_STOP, time: 2_147_483_000, duration: 0,
      base: vec3(0, 0, 0), delta: vec3(100, 20, 10) };
    bounceItem(entity, trace(1, vec3(0, 0, 0), vec3(-1, 0, 0)), {
      previousTime: 2_147_483_646, time: 2_147_483_647,
    });
    expect(entity.s.pos.delta).toEqual(vec3(-50, 10, 5));
  });

  test("settling uses SnapVector's QVM conversion for out-of-range coordinates", () => {
    const entity = new GameEntity(64);
    entity.physicsBounce = 0.5;
    entity.s.pos = { type: TrajectoryType.TR_LINEAR, time: 0, duration: 0,
      base: vec3(0, 0, 0), delta: vec3(0, 0, -10) };
    bounceItem(entity, trace(1, vec3(4_294_967_296, -4_294_967_296, 10.25)), { previousTime: 0, time: 100 });
    expect(entity.s.pos.base).toEqual(vec3(-2_147_483_648, -2_147_483_648, 11));
  });

  test("uses the interpolated impact time for a gravity floor bounce", () => {
    const entity = new GameEntity(64);
    entity.physicsBounce = 0.5;
    entity.r.currentOrigin = vec3(5, 0, 20);
    entity.s.pos = { type: TrajectoryType.TR_GRAVITY, time: 1_000, duration: 0,
      base: vec3(0, 0, 0), delta: vec3(20, 0, -100) };
    bounceItem(entity, trace(0.25, vec3(5, 0, 20)), { previousTime: 1_000, time: 1_200 });
    expect(entity.s.pos.delta).toEqual(vec3(10, 0, 70));
    expect(entity.r.currentOrigin).toEqual(vec3(5, 0, 21));
    expect(entity.s.pos.base).toEqual(vec3(5, 0, 21));
    expect(entity.s.pos.time).toBe(1_200);
  });

  test("reflects from a wall and settles low floor bounces at a snapped raised origin", () => {
    const wall = new GameEntity(64);
    wall.physicsBounce = 0.5;
    wall.r.currentOrigin = vec3(10, 2, 3);
    wall.s.pos = { type: TrajectoryType.TR_LINEAR, time: 0, duration: 0,
      base: vec3(0, 0, 0), delta: vec3(100, 20, 10) };
    bounceItem(wall, trace(0.5, wall.r.currentOrigin, vec3(-1, 0, 0), 7), { previousTime: 100, time: 200 });
    expect(wall.s.pos.delta).toEqual(vec3(-50, 10, 5));
    expect(wall.r.currentOrigin).toEqual(vec3(9, 2, 3));
    expect(wall.s.groundEntityNum).toBe(0);

    const floor = new GameEntity(65);
    floor.physicsBounce = 0.5;
    floor.s.pos = { type: TrajectoryType.TR_LINEAR, time: 0, duration: 0,
      base: vec3(0, 0, 0), delta: vec3(12, 4, -60) };
    bounceItem(floor, trace(1, vec3(3.9, -2.9, 10.2), vec3(0, 0, 1), 23), { previousTime: 0, time: 100 });
    expect(floor.s.pos.type).toBe(TrajectoryType.TR_STATIONARY);
    expect(floor.s.pos.base).toEqual(vec3(3, -2, 11));
    expect(floor.r.currentOrigin).toEqual(vec3(3, -2, 11));
    expect(floor.s.groundEntityNum).toBe(23);
  });
});

describe("LaunchItem and Drop_Item", () => {
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product} launches an actual table item and frees it after exactly 30 seconds`, () => {
      const setup = launchContext(product, GameType.GT_FFA);
      const item = findItemForWeapon(product, Weapon.WP_ROCKET_LAUNCHER);
      const dropped = launchItem(setup.context, item, vec3(10, 20, 40), vec3(100, 0, 200));
      expect(dropped.s.eType).toBe(EntityType.ET_ITEM);
      expect(dropped.s.modelindex).toBeGreaterThan(0);
      expect(dropped.s.modelindex2).toBe(1);
      expect(dropped.classname).toBe(item.className);
      expect(dropped.item).toBe(item);
      expect(dropped.r.mins).toEqual(vec3(-15, -15, -15));
      expect(dropped.r.maxs).toEqual(vec3(15, 15, 15));
      expect(dropped.r.contents).toBe(0x40000000);
      expect(dropped.touch).toBe(setup.touchItem);
      expect(dropped.s.pos).toEqual({ type: TrajectoryType.TR_GRAVITY, time: 1_000, duration: 0,
        base: vec3(10, 20, 40), delta: vec3(100, 0, 200) });
      expect(dropped.s.eFlags & 0x20).toBe(0x20);
      expect(dropped.physicsBounce).toBe(0);
      expect(dropped.flags).toBe(GameFlags.DROPPED_ITEM);
      expect(dropped.nextthink).toBe(31_000);
      expect(setup.world.linkState(dropped.slot)?.linked).toBe(true);
      runThink(dropped, 30_999);
      expect(dropped.inuse).toBe(true);
      setup.clock.now = 31_000;
      runThink(dropped, 31_000);
      expect(dropped.inuse).toBe(false);
      expect(setup.world.linkState(dropped.slot)?.linked).toBe(false);
    });
  }

  test("base CTF and missionpack one-flag drops use explicit team lifecycle callbacks", () => {
    const cases = [
      { product: "baseq3", gameType: GameType.GT_CTF, powerup: Powerup.PW_REDFLAG },
      { product: "missionpack", gameType: GameType.GT_1FCTF, powerup: Powerup.PW_NEUTRALFLAG },
    ] satisfies readonly { product: Product; gameType: GameType; powerup: Powerup }[];
    for (const scenario of cases) {
      const setup = launchContext(scenario.product, scenario.gameType);
      const dropped = launchItem(setup.context, requiredPowerup(scenario.product, scenario.powerup), vec3(0, 0, 40), vec3(0, 0, 0));
      expect(setup.checked).toEqual([dropped]);
      expect(dropped.think).toBe(setup.droppedFlagThink);
      runThink(dropped, 31_000);
      expect(setup.expired).toEqual([dropped]);
      expect(dropped.inuse).toBe(true);
    }
  });

  test("Drop_Item applies yaw offset, zero pitch, speed 150 and Q_crandom lift", () => {
    const setup = launchContext("baseq3", GameType.GT_FFA, 2_000);
    const owner = setup.pool.at(0);
    owner.s.apos = { ...owner.s.apos, base: vec3(37, 45, 29) };
    owner.s.pos = { ...owner.s.pos, base: vec3(8, 9, 10) };
    const context: DropItemContext = { ...setup.context, random: () => 0.75 };
    const dropped = dropItem(context, owner, findItemForWeapon("baseq3", Weapon.WP_SHOTGUN), 45);
    expect(dropped.s.pos.base).toEqual(vec3(8, 9, 10));
    expect(dropped.s.pos.delta.x).toBeCloseTo(0, 4);
    expect(dropped.s.pos.delta.y).toBe(150);
    expect(dropped.s.pos.delta.z).toBe(225);
  });
});

describe("G_RunItem", () => {
  test("falls through a real ServerWorld trace, links, and settles at the floor", () => {
    const setup = launchContext("baseq3", GameType.GT_FFA, 0);
    const dropped = launchItem(setup.context, findItemForWeapon("baseq3", Weapon.WP_SHOTGUN), vec3(0, 0, 40), vec3(0, 0, 0));
    setup.clock.now = 300;
    runItem(dropped, { entities: setup.pool, world: setup.world, previousTime: 0, time: 300,
      freeTeamEntity: () => { throw new Error("Unexpected team return"); } });
    expect(dropped.s.pos.type).toBe(TrajectoryType.TR_STATIONARY);
    expect(dropped.r.currentOrigin).toEqual(vec3(0, 0, 16));
    expect(dropped.s.groundEntityNum).toBe(ENTITYNUM_WORLD);
    expect(setup.world.linkState(dropped.slot)?.linkcount).toBe(2);
  });

  test("restores gravity when pushed from ground and runs stationary think at the exact frame", () => {
    const setup = fixture();
    const moving = setup.pool.spawn();
    moving.s.groundEntityNum = -1;
    moving.s.pos = { type: TrajectoryType.TR_LINEAR, time: 10, duration: 0,
      base: vec3(0, 0, 100), delta: vec3(0, 0, 0) };
    moving.r.currentOrigin = vec3(0, 0, 100);
    moving.r.ownerNum = ENTITYNUM_NONE;
    runItem(moving, { entities: setup.pool, world: setup.world, previousTime: 90, time: 100,
      freeTeamEntity: () => { throw new Error("Unexpected team return"); } });
    expect(moving.s.pos.type).toBe(TrajectoryType.TR_GRAVITY);
    expect(moving.s.pos.time).toBe(100);

    const stationary = setup.pool.spawn();
    let thinks = 0;
    stationary.nextthink = 250;
    stationary.think = () => { thinks++; };
    runItem(stationary, { entities: setup.pool, world: setup.world, previousTime: 100, time: 249,
      freeTeamEntity: () => { throw new Error("Unexpected team return"); } });
    expect(thinks).toBe(0);
    runItem(stationary, { entities: setup.pool, world: setup.world, previousTime: 249, time: 250,
      freeTeamEntity: () => { throw new Error("Unexpected team return"); } });
    expect(thinks).toBe(1);
  });

  test("unlinks ordinary NODROP items and delegates team-item return", () => {
    const ordinaryWorld = fixture("baseq3", SOLID | NODROP);
    const item = findItemForWeapon("baseq3", Weapon.WP_SHOTGUN);
    const normalContext: LaunchItemContext = { entities: ordinaryWorld.pool, product: "baseq3", gameType: GameType.GT_FFA, time: 0,
      touchItem: () => {}, droppedFlagThink: () => {}, checkDroppedTeamItem: () => {} };
    const dropped = launchItem(normalContext, item, vec3(0, 0, 40), vec3(0, 0, 0));
    ordinaryWorld.clock.now = 300;
    runItem(dropped, { entities: ordinaryWorld.pool, world: ordinaryWorld.world, previousTime: 0, time: 300,
      freeTeamEntity: () => { throw new Error("Unexpected team return"); } });
    expect(dropped.inuse).toBe(false);
    expect(ordinaryWorld.world.linkState(dropped.slot)?.linked).toBe(false);

    const team = fixture("baseq3", SOLID | NODROP);
    team.clock.now = 0;
    const returns: GameEntity[] = [];
    const teamContext: LaunchItemContext = { entities: team.pool, product: "baseq3", gameType: GameType.GT_CTF, time: 0,
      touchItem: () => {}, droppedFlagThink: () => {}, checkDroppedTeamItem: () => {} };
    const flag = launchItem(teamContext, requiredPowerup("baseq3", Powerup.PW_REDFLAG), vec3(0, 0, 40), vec3(0, 0, 0));
    team.clock.now = 300;
    runItem(flag, { entities: team.pool, world: team.world, previousTime: 0, time: 300,
      freeTeamEntity: self => { returns.push(self); team.pool.free(self); } });
    expect(returns).toEqual([flag]);
    expect(flag.inuse).toBe(false);
  });
});

test("public item-motion boundaries reject invalid clocks, table mismatches, and invalid RNG output", () => {
  const base = launchContext("baseq3", GameType.GT_FFA);
  const baseItem = findItemForWeapon("baseq3", Weapon.WP_SHOTGUN);
  expect(() => launchItem({ ...base.context, time: Number.NaN }, baseItem, vec3(0, 0, 0), vec3(0, 0, 0))).toThrow(RangeError);
  const missionOnly = findItemForWeapon("missionpack", Weapon.WP_CHAINGUN);
  expect(() => launchItem(base.context, missionOnly, vec3(0, 0, 0), vec3(0, 0, 0))).toThrow("selected product table");
  const mission = launchContext("missionpack", GameType.GT_FFA);
  expect(() => launchItem({ ...mission.context, product: "baseq3" }, baseItem, vec3(0, 0, 0), vec3(0, 0, 0))).toThrow("does not match");
  const endpoint = dropItem({ ...base.context, random: () => 1 }, base.pool.at(0), baseItem, 0);
  expect(endpoint.s.pos.delta.z).toBe(250);
  expect(() => dropItem({ ...base.context, random: () => 1.0001 }, base.pool.at(0), baseItem, 0)).toThrow(RangeError);
  expect(() => bounceItem(new GameEntity(64), trace(1), { previousTime: 0, time: Infinity })).toThrow(RangeError);
  expect(() => runItem(new GameEntity(64), { entities: base.pool, world: base.world, previousTime: 0, time: 1_000,
    freeTeamEntity: () => {} })).toThrow("does not belong");
  expect(() => dropItem({ ...base.context, random: () => 0.5 }, new GameEntity(0), baseItem, 0)).toThrow("does not belong");
});
