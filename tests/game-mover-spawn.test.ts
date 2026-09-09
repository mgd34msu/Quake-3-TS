import { describe, expect, test } from "bun:test";
import { GameMemory } from "../src/game/memory.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { Pk3Archive } from "../src/assets/pk3.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { EntityPool, initGameEntity, runThink } from "../src/game/entities.ts";
import { MoverRuntime } from "../src/game/mover.ts";
import type { MoverHost } from "../src/game/mover.ts";
import { createMoverSpawnHandlers } from "../src/game/mover-spawn.ts";
import { gameAtoi } from "../src/game/numeric.ts";
import { spawnEntity, SpawnVariables } from "../src/game/spawn.ts";
import type { SpawnPair } from "../src/game/spawn.ts";
import { GameFlags, MoverState } from "../src/game/state.ts";
import type { GameEntity } from "../src/game/state.ts";
import { ConfigStringRegistry, useTargets } from "../src/game/utilities.ts";
import { EntityType, GameType, MoveType, Team } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from "../src/shared/player-state.ts";
import { evaluateTrajectory, TrajectoryType } from "../src/shared/trajectory.ts";
import { ServerWorld } from "../src/server/world.ts";

function brushMap(pendulumLength = 201): BspMap {
  const bounds = { min: vec3(-4096, -4096, -4096), max: vec3(4096, 4096, 4096) };
  const boxes = [
    { min: vec3(-8, -32, -32), max: vec3(8, 32, 32) },
    { min: vec3(-64, -64, -8), max: vec3(64, 64, 8) },
    { min: vec3(-10, -10, -10), max: vec3(10, 10, 10) },
    { min: vec3(-3, -3, 1 - pendulumLength), max: vec3(3, 3, 8) },
  ];
  const planes = boxes.flatMap(box => [
    { normal: vec3(-1, 0, 0), distance: -box.min.x }, { normal: vec3(1, 0, 0), distance: box.max.x },
    { normal: vec3(0, -1, 0), distance: -box.min.y }, { normal: vec3(0, 1, 0), distance: box.max.y },
    { normal: vec3(0, 0, -1), distance: -box.min.z }, { normal: vec3(0, 0, 1), distance: box.max.z },
  ]);
  return { entities: "", entityRecords: [], shaders: [{ name: "solid", contentFlags: 1, surfaceFlags: 0 }], planes, nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 },
      ...boxes.map((bounds, firstBrush) => ({ bounds, firstSurface: 0, surfaceCount: 0, firstBrush, brushCount: 1 }))],
    brushes: boxes.map((_, index) => ({ firstSide: index * 6, sideCount: 6, shader: 0 })),
    brushSides: planes.map((_, plane) => ({ plane, shader: 0 })), surfaces: [], vertices: [], indices: [],
    fogs: [], lightmaps: [], lightGrid: [], visibility: null };
}

function fixture(product: Product = "baseq3", map = brushMap()) {
  const clock = { time: 1000, previousTime: 900 }, settings = { gravity: 800 }, effects: string[] = [];
  const memory = new GameMemory(() => 0, text => { effects.push(text); });
  const pool = new EntityPool({ print: text => { effects.push(text); }, product, maxClients: 2, mapStartTime: 0, time: () => clock.time,
    link: entity => { world.link(entity); }, unlink: entity => { world.unlink(entity.slot); } });
  const worldPrints: string[] = [];
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" }), world = new ServerWorld(collision, collision.modelBounds(0), index => pool.get(index), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  pool.at(ENTITYNUM_WORLD).s.number = ENTITYNUM_WORLD;
  const configs = new Map<number, string>(), config = new ConfigStringRegistry({ get: index => configs.get(index) ?? "",
    set: (index, value) => { configs.set(index, value); } });
  const targets = { pool, get time() { return clock.time; }, warn: (message: string): void => { effects.push(message); },
    remapShader: (oldName: string, newName: string, time: number): void => { effects.push(`remap:${oldName}:${newName}:${time}`); } };
  const common = { intermissionQueued: 0, gameType: GameType.GT_FFA, friendlyFire: false, knockback: 1000,
    entities: pool, world, debugDamage: null, checkHurtCarrier: () => {}, logAccuracyHit: () => false };
  const base: Extract<CombatContext, { product: "baseq3" }> = { ...common, product: "baseq3", get time() { return clock.time; } };
  const mission: Extract<CombatContext, { product: "missionpack" }> = { ...common, product: "missionpack", get time() { return clock.time; },
    checkObeliskAttack: () => false, invulnerabilityEffect: () => {} };
  const services = { world, config, useTargets: (entity: GameEntity, activator: GameEntity): void => { useTargets(targets, entity, activator); },
    adjustAreaPortalState: (entity: GameEntity, open: boolean): void => { effects.push(`portal:${entity.slot}:${open}`); },
    returnDroppedFlag: (): void => { throw new Error("Unexpected dropped flag in mover spawn fixture"); } };
  const host: MoverHost = product === "baseq3" ? { ...services, combat: base, get previousTime() { return clock.previousTime; }, missionpack: null }
    : { ...services, combat: mission, get previousTime() { return clock.previousTime; }, missionpack: {
      explodeMissile: (): void => { throw new Error("Unexpected missile in mover spawn fixture"); },
    } };
  const movers = new MoverRuntime(host);
  const handlers = createMoverSpawnHandlers({ movers, gravity: () => settings.gravity, warn: targets.warn, remapShader: targets.remapShader,
    setBrushModel: (entity, name) => {
      if (name === null || !name.startsWith("*")) throw new Error("SV_SetBrushModel requires an inline model");
      const index = gameAtoi(name.slice(1)), bounds = collision.modelBounds(index);
      entity.s.modelindex = index; entity.r.mins = bounds.min; entity.r.maxs = bounds.max;
      entity.r.model = { kind: "inline", index }; entity.r.contents = -1; world.link(entity);
    } });
  function spawn(classname: string, pairs: readonly SpawnPair[] = []): GameEntity {
    const result = spawnEntity(new SpawnVariables([{ key: "classname", value: classname }, ...pairs]), {
      pool, memory, product, gameType: GameType.GT_FFA, handlers, spawnItem: () => { throw new Error("Unexpected item spawn"); }, warn: targets.warn,
    });
    if (result.kind !== "dispatched") throw new Error(`Fixture did not dispatch ${classname}`);
    return result.entity;
  }
  function frame(time: number): void {
    clock.previousTime = clock.time; clock.time = time;
    for (let index = 0; index < pool.numEntities; index++) {
      const entity = pool.at(index); if (!entity.inuse) continue;
      if (entity.s.eType === EntityType.ET_MOVER) movers.run(entity); else runThink(entity, time);
    }
  }
  function player(origin: Vec3, team = Team.TEAM_FREE): GameEntity {
    const entity = pool.at(0), client = pool.clientAt(0); initGameEntity(entity);
    entity.s.eType = EntityType.ET_PLAYER; entity.s.origin = origin; entity.s.pos = { ...entity.s.pos, base: origin };
    entity.r.currentOrigin = origin; entity.r.mins = vec3(-1, -1, -1); entity.r.maxs = vec3(1, 1, 1);
    entity.r.contents = 0x2000000; client.ps.origin = origin; client.ps.health = 100; client.sess.sessionTeam = team;
    client.ps.pmType = team === Team.TEAM_SPECTATOR ? MoveType.PM_SPECTATOR : MoveType.PM_NORMAL;
    entity.s.groundEntityNum = ENTITYNUM_NONE; world.link(entity); return entity;
  }
  function child(classname: string): GameEntity {
    for (let index = 0; index < pool.numEntities; index++) {
      const entity = pool.at(index); if (entity.inuse && entity.classname === classname) return entity;
    }
    throw new Error(`Missing spawned ${classname}`);
  }
  function touch(entity: GameEntity, other: GameEntity): void {
    if (entity.touch === null) throw new Error("Fixture entity has no touch handler");
    entity.touch(entity, other, { fraction: 1, end: other.r.currentOrigin, solidity: "clear", contact: { kind: "none" },
      contents: 0, surfaceFlags: 0, entityNum: ENTITYNUM_NONE });
  }
  return { clock, settings, effects, pool, world, collision, movers, handlers, configs, spawn, frame, player, child, touch };
}

describe("door, plat and button spawn handlers", () => {
  test("registry contains the exact nine source classes and rejects invalid brush bindings", () => {
    const f = fixture(); expect([...f.handlers.keys()]).toEqual([
      "func_door", "func_plat", "func_button", "func_train", "path_corner", "func_static", "func_rotating", "func_bobbing", "func_pendulum",
    ]);
    expect(() => f.spawn("func_door")).toThrow("SV_SetBrushModel");
    expect(() => f.spawn("func_static", [{ key: "model", value: "*99" }])).toThrow();
  });
  test("door defaults, deferred trigger, broadphase padding, touch and real brush motion", () => {
    const f = fixture(), door = f.spawn("func_door", [{ key: "model", value: "*1" }]);
    expect(door.speed).toBe(400); expect(door.wait).toBe(2000); expect(door.damage).toBe(2);
    expect(door.pos1).toEqual(vec3(0, 0, 0)); expect(door.pos2).toEqual(vec3(10, 0, 0));
    expect(door.s.pos.duration).toBe(25); expect(door.nextthink).toBe(1100); expect(door.takedamage).toBe(false);
    expect([...f.configs.values()]).toEqual(["sound/movers/doors/dr1_strt.wav", "sound/movers/doors/dr1_end.wav"]);
    f.frame(1100); const trigger = f.child("door_trigger");
    expect(trigger.count).toBe(0); expect(trigger.r.mins).toEqual(vec3(-130, -34, -34)); expect(trigger.r.maxs).toEqual(vec3(130, 34, 34));
    expect(trigger.parent).toBe(door); expect(trigger.r.contents).toBe(0x40000000); expect(door.takedamage).toBe(true);
    const player = f.player(vec3(100, 0, 0)); f.touch(trigger, player);
    expect(door.moverState).toBe(MoverState.ONE_TO_TWO); expect(door.s.pos.time).toBe(1150);
    f.frame(1175); expect(door.r.currentOrigin).toEqual(vec3(10, 0, 0)); expect(door.moverState).toBe(MoverState.POS2);
    expect(f.world.entityContact({ min: vec3(9, -1, -1), max: vec3(11, 1, 1) }, door)).toBe(true);
    expect(door.nextthink).toBe(3175);
  });
  test("start-open direction, negative wait, shootable and team trigger startup ordering", () => {
    const f = fixture(), master = f.spawn("func_door", [{ key: "model", value: "*1" }, { key: "spawnflags", value: "1" },
      { key: "angle", value: "-1" }, { key: "wait", value: "-1" }]);
    const slave = f.spawn("func_door", [{ key: "model", value: "*1" }, { key: "origin", value: "0 100 0" }]);
    master.teamchain = slave; slave.teammaster = master; slave.flags |= GameFlags.TEAMSLAVE;
    expect(master.pos1).toEqual(vec3(0, 0, 58)); expect(master.pos2).toEqual(vec3(0, 0, 0)); expect(master.wait).toBe(-1000);
    expect(master.s.angles).toEqual(vec3(0, 0, 0)); f.frame(1100);
    const trigger = f.child("door_trigger"); expect(trigger.r.maxs.y).toBe(134); expect(slave.takedamage).toBe(true);
    expect(slave.s.pos.time).toBe(1100); expect(slave.nextthink).toBe(1100);
    const g = fixture(), shootable = g.spawn("func_door", [{ key: "model", value: "*1" }, { key: "health", value: "20" }]);
    g.frame(1100); expect(shootable.takedamage).toBe(true); expect(() => g.child("door_trigger")).toThrow();
  });
  test("spectator traverses the closed door through actual teleport, but never opens it", () => {
    const f = fixture(), door = f.spawn("func_door", [{ key: "model", value: "*1" }]); f.frame(1100);
    const trigger = f.child("door_trigger"), player = f.player(vec3(100, 0, 0), Team.TEAM_SPECTATOR);
    f.touch(trigger, player); expect(f.pool.clientAt(0).ps.origin).toEqual(vec3(-141, 0, 1));
    expect(f.pool.clientAt(0).ps.viewangles.y).toBe(180); expect(door.moverState).toBe(MoverState.POS1);
    expect(f.world.linkState(player.slot)?.linked).toBe(false);
    f.movers.setState(door, MoverState.POS2, 1100); f.touch(trigger, player);
    expect(f.pool.clientAt(0).ps.origin).toEqual(vec3(-141, 0, 1));
  });
  test("plat ignores wait key, creates low trigger and living riders delay descent", () => {
    const f = fixture(), plat = f.spawn("func_plat", [{ key: "model", value: "*2" }, { key: "height", value: "100" },
      { key: "origin", value: "0 0 200" }, { key: "wait", value: "9" }, { key: "angles", value: "10 20 30" }]);
    expect(plat.pos1).toEqual(vec3(0, 0, 100)); expect(plat.pos2).toEqual(vec3(0, 0, 200)); expect(plat.wait).toBe(1000);
    expect(plat.speed).toBe(200); expect(plat.s.pos.duration).toBe(500); expect(plat.s.angles).toEqual(vec3(0, 0, 0));
    const trigger = f.child("plat_trigger"); expect(trigger.r.mins).toEqual(vec3(-32, -32, 91)); expect(trigger.r.maxs).toEqual(vec3(32, 32, 117));
    const player = f.player(vec3(0, 0, 112)); f.touch(trigger, player); expect(plat.moverState).toBe(MoverState.ONE_TO_TWO);
    f.movers.setState(plat, MoverState.POS2, 1000); plat.nextthink = 1234; f.touch(plat, player); expect(plat.nextthink).toBe(2000);
    f.pool.clientAt(0).ps.health = 0; plat.nextthink = 1234; f.touch(plat, player); expect(plat.nextthink).toBe(1234);
    const g = fixture(), small = g.spawn("func_plat", [{ key: "model", value: "*3" }]);
    expect(small.pos1.z).toBe(-14); expect(g.child("plat_trigger").r.mins.x).toBe(0); expect(g.child("plat_trigger").r.maxs.x).toBe(1);
  });
  test("buttons set direction/lip and only health-free buttons accept touch", () => {
    const f = fixture(), button = f.spawn("func_button", [{ key: "model", value: "*1" }, { key: "angle", value: "-2" }]);
    expect(button.speed).toBe(40); expect(button.wait).toBe(1000); expect(button.pos2).toEqual(vec3(0, 0, -62));
    const player = f.player(vec3(100, 100, 100)); f.touch(button, player); expect(button.activator).toBe(player);
    expect(button.moverState).toBe(MoverState.ONE_TO_TWO);
    const shot = f.spawn("func_button", [{ key: "model", value: "*1" }, { key: "health", value: "1" }]);
    expect(shot.takedamage).toBe(true); expect(shot.touch).toBeNull(); expect(shot.use).not.toBeNull();
  });
});

describe("source train paths", () => {
  test("deferred target linking skips non-corners, fires null-activator targets, waits and takes corner speed", () => {
    const f = fixture(), train = f.spawn("func_train", [{ key: "model", value: "*3" }, { key: "target", value: "a" }]);
    const a = f.spawn("path_corner", [{ key: "targetname", value: "a" }, { key: "target", value: "b" },
      { key: "origin", value: "100 0 0" }, { key: "wait", value: "0.25" }, { key: "speed", value: "50" }]);
    const action = f.pool.spawn(); action.targetname = "b"; const activators: (GameEntity | null)[] = [];
    action.use = (_self, other, activator) => { expect(other).toBe(a); activators.push(activator); };
    const b = f.spawn("path_corner", [{ key: "targetname", value: "b" }, { key: "target", value: "a" }, { key: "origin", value: "200 0 0" }]);
    a.soundLoop = 13;
    expect(train.nextTrain).toBeNull(); expect(train.damage).toBe(2); expect(train.speed).toBe(100);
    expect(f.world.linkState(a.slot)).toBeUndefined(); f.frame(1100);
    expect(a.nextTrain).toBe(b); expect(b.nextTrain).toBe(a); expect(train.nextTrain).toBe(b); expect(activators).toEqual([null]);
    expect(train.pos1.x).toBe(100); expect(train.pos2.x).toBe(200); expect(train.s.pos.duration).toBe(2000);
    expect(train.s.pos.type).toBe(TrajectoryType.TR_STATIONARY); expect(train.s.loopSound).toBe(13); expect(train.nextthink).toBe(1350);
    f.frame(1350); expect(train.s.pos.time).toBe(1350); expect(train.s.pos.type).toBe(TrajectoryType.TR_LINEAR_STOP);
    f.frame(2350); expect(train.r.currentOrigin.x).toBe(150);
    f.frame(3350); expect(train.nextTrain).toBe(a); expect(train.s.pos.duration).toBe(1000); expect(train.s.loopSound).toBe(0);
    expect(train.pos1.x).toBe(200); expect(train.pos2.x).toBe(100);
  });
  test("source inactive START_ON/TOGGLE flags, BLOCK_STOPS damage, malformed warnings and stable slot reuse", () => {
    const f = fixture(), train = f.spawn("func_train", [{ key: "model", value: "*3" }, { key: "target", value: "missing" }, { key: "spawnflags", value: "7" }]);
    expect(train.damage).toBe(0); expect(train.blocked).toBeNull(); f.frame(1100);
    expect(train.inuse).toBe(true); expect(train.nextTrain).toBeNull(); expect(f.effects.at(-1)).toContain("with an unfound target");
    const corner = f.spawn("path_corner", [{ key: "origin", value: "1 2 3" }]); const slot = corner.slot;
    expect(corner.inuse).toBe(false); expect(f.effects.at(-1)).toBe("path_corner with no targetname at (1 2 3)\n");
    const reused = f.spawn("func_train", []); expect(reused).toBe(corner); expect(reused.slot).toBe(slot); expect(reused.inuse).toBe(false);
    expect(f.effects.at(-1)).toBe("func_train without a target at (0 0 0)\n");
    const g = fixture(), bad = g.spawn("func_train", [{ key: "model", value: "*3" }, { key: "target", value: "a" }]);
    g.spawn("path_corner", [{ key: "targetname", value: "a" }]); g.frame(1100);
    expect(g.effects.at(-1)).toContain("without a target\n"); expect(bad.nextTrain).not.toBeNull();
  });
  test("non-returning path cycle fails explicitly and keeps source links established before failure", () => {
    const f = fixture(); f.spawn("func_train", [{ key: "model", value: "*3" }, { key: "target", value: "a" }]);
    const a = f.spawn("path_corner", [{ key: "targetname", value: "a" }, { key: "target", value: "b" }]);
    const b = f.spawn("path_corner", [{ key: "targetname", value: "b" }, { key: "target", value: "b" }]);
    expect(() => f.frame(1100)).toThrow("cycle does not return"); expect(a.nextTrain).toBe(b); expect(b.nextTrain).toBe(b);
  });
  test("missing corner targets stop setup; missing next links leave reached state untouched", () => {
    const f = fixture(), train = f.spawn("func_train", [{ key: "model", value: "*3" }, { key: "target", value: "a" }]);
    const a = f.spawn("path_corner", [{ key: "targetname", value: "a" }, { key: "target", value: "only_action" }]);
    const action = f.pool.spawn(); action.targetname = "only_action"; action.classname = "target_print";
    f.frame(1100); expect(f.effects.at(-1)).toBe("Train corner at (0 0 0) without a target path_corner\n");
    expect(train.nextTrain).toBe(a); expect(a.nextTrain).toBeNull();
    const trajectory = train.s.pos;
    if (train.reached === null) throw new Error("Train reached callback missing");
    train.reached(train); expect(train.s.pos).toBe(trajectory); train.nextTrain = null;
    train.reached(train); expect(train.s.pos).toBe(trajectory);
  });
  test("train warnings read the retained shared bounds without requiring a world link", () => {
    const f = fixture(), train = f.pool.spawn();
    train.r.absmin = vec3(12, -34, 56);
    const spawnTrain = f.handlers.get("func_train");
    if (spawnTrain === undefined) throw new Error("Train spawn callback missing");
    expect(f.world.linkState(train.slot)).toBeUndefined();
    spawnTrain(train, new SpawnVariables([]));
    expect(f.effects.at(-1)).toBe("func_train without a target at (12 -34 56)\n");
    expect(train.inuse).toBe(false);
    f.spawn("path_corner", [{ key: "origin", value: "5000000000 -5000000000 0" }]);
    expect(f.effects.at(-1)).toBe("path_corner with no targetname at (-./,),(-*,( -./,),(-*,( 0)\n");
    f.spawn("path_corner", [{ key: "origin", value: "1000000000 1000000000 1000000000" }]);
    expect(f.effects.slice(-2)).toEqual([
      "Com_sprintf: overflow of 34 in 32\n",
      "path_corner with no targetname at (1000000000 1000000000 10000000\n",
    ]);
  });
  test("corner target callbacks update the train destination and wait before trajectory setup", () => {
    const f = fixture(), train = f.spawn("func_train", [{ key: "model", value: "*3" }, { key: "target", value: "a" }]);
    const a = f.spawn("path_corner", [{ key: "targetname", value: "a" }, { key: "target", value: "b" },
      { key: "origin", value: "100 0 0" }]);
    const action = f.pool.spawn(); action.targetname = "b";
    const b = f.spawn("path_corner", [{ key: "targetname", value: "b" }, { key: "target", value: "a" },
      { key: "origin", value: "200 0 0" }]);
    const c = f.spawn("path_corner", [{ key: "targetname", value: "c" }, { key: "origin", value: "250 0 0" }]);
    action.use = () => { a.nextTrain = c; a.wait = 0.5; a.speed = 50; a.soundLoop = 17; };
    f.frame(1100);
    expect(b.nextTrain).toBe(a);
    expect(train.nextTrain).toBe(c);
    expect(train.pos1).toEqual(vec3(100, 0, 0));
    expect(train.pos2).toEqual(vec3(250, 0, 0));
    expect(train.s.pos.duration).toBe(3000);
    expect(train.s.pos.type).toBe(TrajectoryType.TR_STATIONARY);
    expect(train.s.loopSound).toBe(17);
    expect(train.nextthink).toBe(1600);
    f.frame(1600);
    expect(train.s.pos.time).toBe(1600);
    expect(train.s.pos.type).toBe(TrajectoryType.TR_LINEAR_STOP);
  });
});

describe("continuous and static brush classes", () => {
  test("actual original QVM spawn/trajectory integer-bit fixtures", () => {
    // Unmodified g_mover.c, bg_misc.c and q_math.c compiled by original q3lcc/q3asm
    // with -DQ3_VM -D__LCC__ -DMISSIONPACK; executed in original linuxq3ded vm_game=1.
    // Host fixture supplies CM-style bounds and spawn strings; no native-float oracle.
    function bits(value: number): number {
      const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getInt32(0, true);
    }
    function snapshot(entity: GameEntity): number[] {
      const pos = evaluateTrajectory(entity.s.pos, 1100), angles = evaluateTrajectory(entity.s.apos, 1100);
      return [entity.s.pos.duration, entity.s.pos.time, entity.s.apos.duration, entity.s.apos.time,
        bits(pos.x), bits(pos.y), bits(pos.z), bits(angles.x), bits(angles.y), bits(angles.z)];
    }
    const cases: readonly (readonly [number, readonly number[]])[] = [
      [1, [1, 0, 1088, 272, 1120403456, 1128792064, 1133903872, 1095761920, 1108606976, -1034701244]],
      [8, [1, 0, 1088, 272, 1120403456, 1128792064, 1133903872, 1095761920, 1108606976, -1034701244]],
      [32, [1, 0, 2176, 544, 1120403456, 1128792064, 1133903872, 1095761920, 1108606976, 1088384120]],
      [201, [1, 0, 5454, 1363, 1120403456, 1128792064, 1133903872, 1095761920, 1108606976, -1040213028]],
      [10000, [1, 0, 38476, 9619, 1120403456, 1128792064, 1133903872, 1095761920, 1108606976, -1034808908]],
      [0.125, [1, 0, 1088, 272, 1120403456, 1128792064, 1133903872, 1095761920, 1108606976, -1034701244]],
    ];
    const originAngles = [{ key: "origin", value: "100 200 300" }, { key: "angles", value: "13 37 -23" }];
    for (const [length, expected] of cases) {
      const f = fixture("missionpack", brushMap(length));
      const entity = f.spawn("func_pendulum", [{ key: "model", value: "*4" }, ...originAngles, { key: "phase", value: "0.25" }]);
      expect(snapshot(entity)).toEqual([...expected]);
    }
    const f = fixture(); f.settings.gravity = Math.fround(123.456);
    const custom = f.spawn("func_pendulum", [{ key: "model", value: "*4" }, ...originAngles,
      { key: "speed", value: "37.125" }, { key: "phase", value: "0.37" }]);
    expect(snapshot(custom)).toEqual([1, 0, 13886, 5137, 1120403456, 1128792064, 1133903872, 1095761920, 1108606976, -1033131458]);
    const bob = f.spawn("func_bobbing", [{ key: "model", value: "*4" }, ...originAngles, { key: "speed", value: "3.333" },
      { key: "phase", value: "0.37" }, { key: "height", value: "27.125" }]);
    expect(snapshot(bob)).toEqual([3333, 1233, 0, 0, 1120403456, 1128792064, 1133683348, 0, 0, 0]);
    const door = f.spawn("func_door", [{ key: "model", value: "*1" }, ...originAngles, { key: "speed", value: "77.125" }, { key: "wait", value: "0.37" }]);
    expect(snapshot(door)).toEqual([772, 0, 0, 0, 1120403456, 1128792064, 1133903872, 0, 0, 0]);
    const button = f.spawn("func_button", [{ key: "model", value: "*1" }, ...originAngles, { key: "speed", value: "77.125" }, { key: "wait", value: "0.37" }]);
    expect(snapshot(button)).toEqual([824, 0, 0, 0, 1120403456, 1128792064, 1133903872, 0, 0, 0]);
    const plat = f.spawn("func_plat", [{ key: "model", value: "*1" }, ...originAngles]);
    expect(snapshot(plat)).toEqual([290, 0, 0, 0, 1120403456, 1128792064, 1131544576, 0, 0, 0]);
    const train = f.spawn("func_train", [{ key: "model", value: "*4" }, ...originAngles,
      { key: "target", value: "a" }, { key: "speed", value: "77.125" }]);
    const a = f.spawn("path_corner", [{ key: "targetname", value: "a" }, { key: "origin", value: "1.25 -2.5 3.75" },
      { key: "speed", value: "33.3" }, { key: "wait", value: "0.37" }]);
    const b = f.spawn("path_corner", [{ key: "targetname", value: "b" }, { key: "origin", value: "101.125 11.625 -7.5" }]);
    train.nextTrain = a; a.nextTrain = b; a.soundLoop = 13;
    if (train.reached === null) throw new Error("Train has no reached callback"); train.reached(train);
    expect(snapshot(train)).toEqual([3047, 1000, 0, 0, 1067450368, -1071644672, 1081081856, 0, 0, 0]);
    expect(train.nextthink).toBe(1370); expect(train.s.loopSound).toBe(13);
  });
  test("rotating axis precedence and START_ON flag do not change unconditional linear rotation", () => {
    const cases: readonly (readonly [number, Vec3])[] = [[0, vec3(0, 100, 0)], [1, vec3(0, 100, 0)],
      [4, vec3(0, 0, 100)], [8, vec3(100, 0, 0)], [12, vec3(0, 0, 100)]];
    for (const [flags, expected] of cases) {
      const f = fixture(), rotor = f.spawn("func_rotating", [{ key: "model", value: "*3" }, { key: "spawnflags", value: String(flags) },
        { key: "origin", value: "100 0 0" }, { key: "angles", value: "10 20 30" }]);
      expect(rotor.s.apos.type).toBe(TrajectoryType.TR_LINEAR); expect(rotor.s.apos.delta).toEqual(expected);
      expect(rotor.r.currentAngles).toEqual(vec3(0, 0, 0)); expect(rotor.r.currentOrigin).toEqual(vec3(100, 0, 0));
      expect(rotor.damage).toBe(2); f.frame(1100); expect(rotor.r.currentAngles).not.toEqual(vec3(0, 0, 0));
    }
  });
  test("bobbing phase is absolute, axis flags prefer X and speed zero inherits InitMover default", () => {
    const f = fixture(), bob = f.spawn("func_bobbing", [{ key: "model", value: "*3" }, { key: "origin", value: "100 0 0" },
      { key: "spawnflags", value: "3" }, { key: "phase", value: "0.25" }]);
    expect(bob.s.pos.duration).toBe(4000); expect(bob.s.pos.time).toBe(1000); expect(bob.s.pos.delta).toEqual(vec3(32, 0, 0));
    expect(bob.r.currentOrigin.x).toBe(100); expect(f.world.linkState(bob.slot)?.absbounds.min.x).toBe(-12);
    f.frame(2000); expect(bob.r.currentOrigin.x).toBe(132);
    const zero = f.spawn("func_bobbing", [{ key: "model", value: "*3" }, { key: "speed", value: "0" }]);
    expect(zero.speed).toBe(100); expect(zero.s.pos.duration).toBe(100000);
  });
  test("pendulum preserves network angles and source stale link before first frame; static never relinks", () => {
    const f = fixture(), pendulum = f.spawn("func_pendulum", [{ key: "model", value: "*4" }, { key: "origin", value: "100 0 0" },
      { key: "angles", value: "10 20 30" }, { key: "phase", value: "0.25" }]);
    expect(pendulum.s.apos.base).toEqual(vec3(10, 20, 30)); expect(pendulum.s.apos.delta).toEqual(vec3(0, 0, 30));
    expect(pendulum.s.apos.type).toBe(TrajectoryType.TR_SINE); expect(pendulum.s.pos.duration).toBe(1);
    expect(pendulum.r.currentAngles).toEqual(vec3(0, 0, 0)); expect(pendulum.s.apos.duration).toBeGreaterThan(5000);
    f.frame(1100); expect(pendulum.r.currentAngles.x).toBe(10); expect(pendulum.r.currentAngles.y).toBe(20);
    const fixed = f.spawn("func_static", [{ key: "model", value: "*3" }, { key: "origin", value: "100 200 300" }]);
    expect(fixed.r.currentOrigin).toEqual(vec3(100, 200, 300)); expect(fixed.s.pos.base).toEqual(vec3(100, 200, 300));
    expect(f.world.linkState(fixed.slot)?.absbounds.min).toEqual(vec3(-12, -12, -12));
    f.frame(1200); expect(f.world.linkState(fixed.slot)?.absbounds.min).toEqual(vec3(-12, -12, -12));
  });
  test("common registry runs unchanged under Team Arena", () => {
    const f = fixture("missionpack"), door = f.spawn("func_door", [{ key: "model", value: "*1" }]);
    f.frame(1100); f.touch(f.child("door_trigger"), f.player(vec3(100, 0, 0)));
    f.frame(1175); expect(door.moverState).toBe(MoverState.POS2);
  });
});

test("retail q3dm0 rotating class spawns from entity keys and runs real inline collision frames", async () => {
  const root = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", path = `${root}/baseq3/pak0.pk3`;
  if (!(await Bun.file(path).exists())) return;
  using archive = await Pk3Archive.open(path);
  const map = parseBsp(await archive.read("maps/q3dm0.bsp")), f = fixture("baseq3", map);
  const record = map.entityRecords.find(entity => entity.get("classname") === "func_rotating");
  if (record === undefined) throw new Error("Retail rotating fixture is absent");
  const entity = f.spawn("func_rotating", [...record].filter(([key]) => key !== "classname").map(([key, value]) => ({ key, value })));
  expect(entity.r.model).toEqual({ kind: "inline", index: 10 }); expect(entity.speed).toBe(25);
  expect([...f.configs.values()]).toContain("models/mapobjects/bitch/fembotbig.md3");
  f.frame(1100); expect(entity.r.currentAngles.y).toBe(27.5); expect(entity.r.currentOrigin).toEqual(vec3(-1465, -1596, 22));
  expect(f.world.linkState(entity.slot)?.linked).toBe(true);
  const bounds = f.collision.modelBounds(10);
  expect(f.world.entityContact({ min: vec3(-1466, -1597, 22 + bounds.min.z + 2), max: vec3(-1464, -1595, 24 + bounds.min.z) }, entity)).toBe(true);
});

test("retail door, button, bobbing, pendulum and static entity records run through the spawn registry", async () => {
  const root = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", path = `${root}/baseq3/pak0.pk3`;
  if (!(await Bun.file(path).exists())) return;
  using archive = await Pk3Archive.open(path);
  const cases = [{ map: "q3ctf1", classname: "func_door" }, { map: "q3ctf2", classname: "func_static" },
    { map: "q3ctf4", classname: "func_bobbing" }, { map: "q3dm11", classname: "func_button" }, { map: "q3dm15", classname: "func_pendulum" }];
  for (const row of cases) {
    const map = parseBsp(await archive.read(`maps/${row.map}.bsp`)), f = fixture("baseq3", map);
    const record = map.entityRecords.find(entity => entity.get("classname") === row.classname);
    if (record === undefined) throw new Error(`Missing retail ${row.classname}`);
    const entity = f.spawn(row.classname, [...record].filter(([key]) => key !== "classname").map(([key, value]) => ({ key, value })));
    expect(entity.r.model.kind).toBe("inline"); expect(entity.r.contents).toBe(-1); expect(entity.s.eType).toBe(EntityType.ET_MOVER);
    f.frame(1100);
    if (row.classname === "func_door" || row.classname === "func_button") f.movers.useBinary(entity, null, null);
    f.frame(1200); f.frame(1500);
    expect(entity.r.currentOrigin).toEqual(evaluateTrajectory(entity.s.pos, 1500));
    expect(entity.r.currentAngles).toEqual(evaluateTrajectory(entity.s.apos, 1500));
    expect(f.world.linkState(entity.slot)?.linked).toBe(true);
  }
});
