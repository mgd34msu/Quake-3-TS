import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { Pk3Archive } from "../src/assets/pk3.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { add3, vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { EntityPool, initGameEntity, setOrigin } from "../src/game/entities.ts";
import { MissileRuntime } from "../src/game/missile.ts";
import type { MissileHost } from "../src/game/missile.ts";
import { MoverRuntime } from "../src/game/mover.ts";
import type { MoverHost } from "../src/game/mover.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { SpawnVariables } from "../src/game/spawn.ts";
import { GameFlags, MoverState } from "../src/game/state.ts";
import type { GameEntity } from "../src/game/state.ts";
import { ServerWorld } from "../src/server/world.ts";
import { EntityEvent, EntityType, GameType, ItemType, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { itemList } from "../src/shared/items.ts";
import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from "../src/shared/player-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";

function mapFixture(): BspMap {
  const bounds = { min: vec3(-2048, -2048, -2048), max: vec3(2048, 2048, 2048) };
  const boxes = [{ min: vec3(-20, -20, -2), max: vec3(20, 20, 2) },
    { min: vec3(-20, -2, -1), max: vec3(20, 2, 1) }];
  const planes = boxes.flatMap(box => [
    { normal: vec3(-1, 0, 0), distance: -box.min.x }, { normal: vec3(1, 0, 0), distance: box.max.x },
    { normal: vec3(0, -1, 0), distance: -box.min.y }, { normal: vec3(0, 1, 0), distance: box.max.y },
    { normal: vec3(0, 0, -1), distance: -box.min.z }, { normal: vec3(0, 0, 1), distance: box.max.z },
  ]);
  return { entities: "", entityRecords: [], shaders: [{ name: "solid", contentFlags: 1, surfaceFlags: 0 }], planes, nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 },
      ...boxes.map((bounds, firstBrush) => ({ bounds, firstSurface: 0, surfaceCount: 0, firstBrush, brushCount: 1 }))],
    brushes: boxes.map((_, i) => ({ firstSide: i * 6, sideCount: 6, shader: 0 })), brushSides: planes.map((_, plane) => ({ plane, shader: 0 })),
    surfaces: [], vertices: [], indices: [], fogs: [], lightmaps: [], lightGrid: [], visibility: null };
}

function fixture(product: Product = "baseq3", map = mapFixture()) {
  const clock = { time: 1000, previousTime: 0 }, calls: string[] = [];
  const pool = new EntityPool({ print: text => { worldPrints.push(text); }, product, maxClients: 4, mapStartTime: 0, time: () => clock.time,
    link: entity => { world.link(entity); }, unlink: entity => { world.unlink(entity.slot); } });
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const worldPrints: string[] = [];
  const world = new ServerWorld(collision, collision.modelBounds(0), number => pool.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  pool.at(ENTITYNUM_WORLD).s.number = ENTITYNUM_WORLD;
  const common = { intermissionQueued: 0, gameType: GameType.GT_FFA, friendlyFire: false, knockback: 1000,
    entities: pool, world, debugDamage: null, checkHurtCarrier: () => {}, logAccuracyHit: () => false };
  const baseCombat: Extract<CombatContext, { product: "baseq3" }> = { ...common, product: "baseq3", get time() { return clock.time; } };
  const teamCombat: Extract<CombatContext, { product: "missionpack" }> = { ...common, product: "missionpack", get time() { return clock.time; },
    checkObeliskAttack: () => false, invulnerabilityEffect: () => {} };
  const missileHost: MissileHost = product === "baseq3" ? { combat: baseCombat, world, get previousTime() { return clock.previousTime; }, missionpack: null }
    : { combat: teamCombat, world, get previousTime() { return clock.previousTime; }, missionpack: {
      proxMineTimeout: 30000, random: new GameRandom(1), soundIndex: () => 1, invulnerabilityImpact: () => ({ kind: "miss" }),
    } };
  const missiles = new MissileRuntime(missileHost);
  const services = { world, get previousTime() { return clock.previousTime; },
    config: { modelIndex: (name: string | null): number => { calls.push(`model:${name}`); return 7; },
      soundIndex: (name: string | null): number => { calls.push(`sound:${name}`); return 11; } },
    useTargets: (entity: GameEntity, activator: GameEntity): void => { calls.push(`targets:${entity.slot}:${activator.slot}`); },
    adjustAreaPortalState: (entity: GameEntity, open: boolean): void => { calls.push(`portal:${entity.slot}:${open}`); },
    returnDroppedFlag: (entity: GameEntity): void => { calls.push(`flag:${entity.slot}`); } };
  const host: MoverHost = product === "baseq3" ? { ...services, get previousTime() { return clock.previousTime; }, combat: baseCombat, missionpack: null }
    : { ...services, get previousTime() { return clock.previousTime; }, combat: teamCombat, missionpack: {
      explodeMissile: entity => { calls.push(`explode:${entity.s.event & 255}`); missiles.explode(entity); },
    } };
  const movers = new MoverRuntime(host);
  function player(slot: number, origin: Vec3): GameEntity {
    const entity = pool.at(slot), client = pool.clientAt(slot); initGameEntity(entity); setOrigin(entity, origin);
    entity.s.eType = EntityType.ET_PLAYER; entity.health = client.ps.health = 100; entity.takedamage = true;
    entity.r.mins = vec3(-1, -1, -1); entity.r.maxs = vec3(1, 1, 1); entity.r.contents = 0x02000000;
    entity.s.groundEntityNum = ENTITYNUM_NONE; client.ps.origin = { ...origin };
    client.ps.stats.set(statSchema(product).maxHealth, 100);
    entity.die = (self, _source, _owner, amount, mod) => { calls.push(`die:${self.slot}:${amount}:${mod}`); };
    world.link(entity); return entity;
  }
  function inline(index = 1, origin = vec3(0, 0, 0)): GameEntity {
    const entity = pool.spawn(), bounds = collision.modelBounds(index);
    entity.s.modelindex = index;
    entity.r.model = { kind: "inline", index }; entity.r.mins = bounds.min; entity.r.maxs = bounds.max; entity.r.contents = 1;
    setOrigin(entity, origin); world.link(entity); return entity;
  }
  function mover(delta = vec3(10, 0, 0)): GameEntity {
    const entity = inline(); entity.s.eType = EntityType.ET_MOVER;
    entity.s.pos = { ...entity.s.pos, type: TrajectoryType.TR_LINEAR_STOP, time: 0, duration: 1000, delta };
    return entity;
  }
  return { pool, collision, world, clock, calls, movers, player, inline, mover };
}

describe("source mover push transactions through ServerWorld", () => {
  test("riders translate while side contacts clear only entity ground state", () => {
    const f = fixture(), mover = f.mover(), rider = f.player(0, vec3(0, 0, 4));
    rider.s.groundEntityNum = mover.s.number; f.pool.clientAt(0).ps.groundEntityNum = mover.s.number;
    const side = f.player(1, vec3(22, 0, 0)); side.s.groundEntityNum = 123; f.pool.clientAt(1).ps.groundEntityNum = 123;
    f.movers.run(mover);
    expect(mover.r.currentOrigin).toEqual(vec3(10, 0, 0));
    expect(f.pool.clientAt(0).ps.origin).toEqual(vec3(10, 0, 4));
    expect(rider.s.groundEntityNum).toBe(mover.s.number);
    expect(f.pool.clientAt(1).ps.origin).toEqual(vec3(32, 0, 0));
    expect(side.s.groundEntityNum).toBe(-1); expect(f.pool.clientAt(1).ps.groundEntityNum).toBe(123);
  });
  test("yaw rotation carries riders around the inline brush and changes integer delta yaw", () => {
    const f = fixture(), mover = f.mover(vec3(0, 0, 0)), rider = f.player(0, vec3(10, 0, 4));
    mover.s.apos = { ...mover.s.apos, type: TrajectoryType.TR_LINEAR, delta: vec3(0, 90, 0) };
    rider.s.groundEntityNum = mover.s.number; f.pool.clientAt(0).ps.deltaAngles = vec3(1, 7, 3);
    f.movers.run(mover);
    expect(f.pool.clientAt(0).ps.origin.x).toBeCloseTo(0, 5); expect(f.pool.clientAt(0).ps.origin.y).toBeCloseTo(10, 5);
    expect(f.pool.clientAt(0).ps.deltaAngles).toEqual(vec3(1, 16391, 3));
    expect(rider.s.apos.base).toEqual(vec3(0, 0, 0));
    expect(mover.r.currentAngles).toEqual(vec3(0, 90, 0));
  });
  test("blocked lift reverses pushed saves but retains source collision origin and ground quirks", () => {
    const f = fixture(), mover = f.mover(vec3(0, 0, 4));
    f.inline(2, vec3(0, 10, 10));
    const blocked = f.player(0, vec3(0, 10, 4)), free = f.player(1, vec3(0, 5, 4));
    for (const rider of [blocked, free]) rider.s.groundEntityNum = mover.s.number;
    const obstacles: GameEntity[] = [];
    mover.blocked = (_self, other) => { obstacles.push(other); f.calls.push("blocked"); };
    mover.nextthink = 1000; mover.think = () => { f.calls.push("think"); };
    f.movers.run(mover);
    expect(obstacles).toEqual([blocked]); expect(f.calls).toEqual(["blocked", "think"]);
    expect(mover.r.currentOrigin).toEqual(vec3(0, 0, 0)); expect(mover.s.pos.time).toBe(1000);
    expect(f.pool.clientAt(1).ps.origin).toEqual(vec3(0, 5, 4)); expect(free.s.pos.base).toEqual(vec3(0, 5, 4));
    expect(free.r.currentOrigin).toEqual(vec3(0, 5, 8));
    expect(f.world.linkState(free.slot)?.absbounds.min.z).toBe(6);
    expect(free.s.groundEntityNum).toBe(mover.s.number);
  });
  test("sliding rider fallback clears ground and leaves original collision position", () => {
    const f = fixture(), mover = f.mover(vec3(10, 0, 0)), rider = f.player(0, vec3(0, 0, 4));
    rider.s.groundEntityNum = mover.s.number;
    const wall = f.inline(2, vec3(10, 0, 4));
    wall.r.currentAngles = vec3(0, 90, 0); f.world.link(wall);
    f.movers.run(mover);
    expect(mover.r.currentOrigin.x).toBe(10);
    expect(f.pool.clientAt(0).ps.origin).toEqual(vec3(0, 0, 4));
    expect(rider.s.groundEntityNum).toBe(-1); expect(rider.r.currentOrigin).toEqual(vec3(0, 0, 4));
  });
  test("original C fallback retains yaw and three-axis rotation matches float32 output", () => {
    // Unmodified g_mover.c + q_math.c, i386 -O0 -ffloat-store. Native trace responses
    // select blocked/clear branches; this test reaches them through actual brushes.
    const f = fixture(), mover = f.mover(vec3(0, 0, 0)), rider = f.player(0, vec3(10, 0, 4));
    rider.s.groundEntityNum = mover.s.number; f.pool.clientAt(0).ps.deltaAngles = vec3(0, 7, 0);
    mover.s.apos = { ...mover.s.apos, type: TrajectoryType.TR_LINEAR, delta: vec3(0, 90, 0) };
    f.inline(2, vec3(0, 10, 4)); f.movers.run(mover);
    expect(f.pool.clientAt(0).ps.origin).toEqual(vec3(10, 0, 4));
    expect(f.pool.clientAt(0).ps.deltaAngles.y).toBe(16391); expect(rider.s.groundEntityNum).toBe(-1);
    const g = fixture(), rotating = g.mover(vec3(0, 0, 0)), carried = g.player(0, vec3(10, 0, 4));
    carried.s.groundEntityNum = rotating.s.number; g.pool.clientAt(0).ps.deltaAngles = vec3(0, 16391, 0);
    rotating.s.apos = { ...rotating.s.apos, type: TrajectoryType.TR_LINEAR, delta: vec3(13, 37, -23) };
    g.movers.run(rotating);
    expect(g.pool.clientAt(0).ps.origin).toEqual(vec3(7.50256348, 7.61057997, 1.33813906));
    expect(g.pool.clientAt(0).ps.deltaAngles.y).toBe(23126);
  });
  test("EF_MOVER_STOP blocks side contacts but carries riders", () => {
    const f = fixture(), mover = f.mover(), rider = f.player(0, vec3(0, 0, 4));
    mover.s.eFlags = 0x400; rider.s.groundEntityNum = mover.s.number;
    f.movers.run(mover); expect(f.pool.clientAt(0).ps.origin.x).toBe(10);
    const g = fixture(), stop = g.mover(), side = g.player(0, vec3(22, 0, 0)); stop.s.eFlags = 0x400;
    const blocked: GameEntity[] = []; stop.blocked = (_self, other) => { blocked.push(other); };
    g.movers.run(stop); expect(blocked).toEqual([side]); expect(stop.r.currentOrigin.x).toBe(0);
  });
  test("rotating lift rollback restores float-saved client yaw, including source precision loss", () => {
    const f = fixture(), mover = f.mover(vec3(0, 0, 4));
    mover.s.apos = { ...mover.s.apos, type: TrajectoryType.TR_LINEAR, delta: vec3(0, 90, 0) };
    const ceiling = f.inline(2, vec3(-10, 0, 10)); ceiling.r.currentAngles = vec3(0, 90, 0); f.world.link(ceiling);
    const blocked = f.player(0, vec3(0, 10, 4)), free = f.player(1, vec3(0, 5, 4));
    blocked.s.groundEntityNum = free.s.groundEntityNum = mover.s.number;
    f.pool.clientAt(0).ps.deltaAngles = vec3(1, 7, 3); f.pool.clientAt(1).ps.deltaAngles = { x: 1, y: 16777217, z: 3 };
    f.movers.run(mover);
    expect(mover.r.currentOrigin).toEqual(vec3(0, 0, 0)); expect(mover.r.currentAngles).toEqual(vec3(0, 0, 0));
    expect(f.pool.clientAt(0).ps.deltaAngles).toEqual(vec3(1, 7, 3));
    expect(f.pool.clientAt(1).ps.deltaAngles.y).toBe(16777216);
    expect(f.pool.clientAt(1).ps.origin).toEqual(vec3(0, 5, 4));
    expect(free.r.currentOrigin.x).toBe(-5); expect(free.r.currentOrigin.y).toBeCloseTo(0, 5); expect(free.r.currentOrigin.z).toBe(8);
  });
  test("team parts commit before reached callbacks and only the captain runs thinks", () => {
    const f = fixture(), master = f.mover(), slave = f.mover(vec3(0, 10, 0));
    slave.flags |= GameFlags.TEAMSLAVE; slave.teammaster = master; master.teamchain = slave;
    master.reached = () => { f.calls.push(`master:${slave.r.currentOrigin.y}`); };
    slave.reached = () => { f.calls.push("slave"); };
    master.think = () => { f.calls.push("think"); }; master.nextthink = 1000;
    slave.think = () => { f.calls.push("bad slave think"); }; slave.nextthink = 1000;
    f.movers.run(slave); expect(f.calls).toEqual([]);
    f.movers.run(master); expect(f.calls).toEqual(["master:10", "slave", "think"]);
  });
  test("a blocked later team part restores riders pushed by an earlier part", () => {
    const f = fixture(), master = f.mover(vec3(0, 0, 4)), slave = f.inline(1, vec3(100, 0, 0));
    slave.s.eType = EntityType.ET_MOVER; slave.flags = GameFlags.TEAMSLAVE; slave.teammaster = master; master.teamchain = slave;
    slave.s.pos = { ...slave.s.pos, type: TrajectoryType.TR_LINEAR_STOP, duration: 1000, delta: vec3(0, 0, 4) };
    const earlier = f.player(0, vec3(0, 0, 4)), later = f.player(1, vec3(100, 0, 4));
    earlier.s.groundEntityNum = master.s.number; later.s.groundEntityNum = slave.s.number;
    f.inline(2, vec3(100, 0, 10)); const obstacles: GameEntity[] = [];
    master.blocked = (_self, other) => { obstacles.push(other); }; f.movers.run(master);
    expect(obstacles).toEqual([later]); expect(master.s.pos.time).toBe(1000); expect(slave.s.pos.time).toBe(1000);
    expect(master.r.currentOrigin.z).toBe(0); expect(slave.r.currentOrigin).toEqual(vec3(100, 0, 0));
    expect(f.pool.clientAt(0).ps.origin).toEqual(vec3(0, 0, 4)); expect(earlier.r.currentOrigin.z).toBe(8);
  });
  test("sine movers apply real crushing damage and never roll back", () => {
    const f = fixture(), mover = f.mover(vec3(0, 0, 4));
    mover.s.pos = { ...mover.s.pos, type: TrajectoryType.TR_SINE, duration: 4000 };
    f.inline(2, vec3(0, 10, 10));
    const rider = f.player(0, vec3(0, 10, 4)); rider.s.groundEntityNum = mover.s.number;
    f.movers.run(mover);
    expect(mover.r.currentOrigin.z).toBe(4); expect(rider.health).toBeLessThan(0);
    expect(f.calls).toContain("die:0:99999:17");
  });
});

describe("binary mover state machine", () => {
  test("native adjusted-constant C binary snapshots include nonintegral wait and float32 large time", () => {
    const f = fixture(), entity = f.inline(), snapshots: number[][] = [];
    entity.pos1 = vec3(1.25, -2.5, 3.75); entity.pos2 = vec3(101.125, 11.625, -7.5);
    entity.s.pos = { ...entity.s.pos, duration: 777 }; entity.wait = Math.fround(321.75);
    entity.soundLoop = 3; entity.sound1to2 = 4; entity.sound2to1 = 5; entity.soundPos1 = 6; entity.soundPos2 = 7;
    function snapshot(): void {
      const p = entity.s.pos, origin = entity.r.currentOrigin;
      snapshots.push([entity.moverState, p.time, p.duration, origin.x, origin.y, origin.z,
        p.delta.x, p.delta.y, p.delta.z, entity.nextthink, entity.s.loopSound, entity.s.eventParm]);
    }
    f.movers.setState(entity, MoverState.POS1, 1000); snapshot(); f.movers.useBinary(entity, null, null); snapshot();
    f.clock.time = 1234; f.movers.useBinary(entity, null, null); snapshot();
    f.clock.time = 1300; f.movers.useBinary(entity, null, null); snapshot();
    f.clock.time = 1959; f.movers.reachedBinary(entity); snapshot();
    f.clock.time = 2280; f.movers.returnToPos1(entity); snapshot();
    f.clock.time = 3057; f.movers.reachedBinary(entity); snapshot();
    f.clock.time = 16777217; f.movers.setState(entity, MoverState.POS2, f.clock.time); f.movers.useBinary(entity, null, null); snapshot();
    // Native adjusted-constant oracle, not QVM execution: unmodified g_mover.c
    // + bg_misc.c, i386 -O0 -ffloat-store -fsingle-precision-constant.
    const native = [
      [0, 1000, 777, 1.25, -2.5, 3.75, 0, 0, 0, 0, 0, 0],
      [2, 1050, 777, 1.25, -2.5, 3.75, 128.539246, 18.1788921, -14.4787645, 0, 3, 4],
      [3, 641, 777, 24.9012222, 0.844916344, 1.08590794, -128.539246, -18.1788921, 14.4787645, 0, 3, 5],
      [2, 1182, 777, 16.4176331, -0.354890585, 2.04150581, 128.539246, 18.1788921, -14.4787645, 0, 3, 4],
      [1, 1959, 777, 101.125, 11.625, -7.5, 128.539246, 18.1788921, -14.4787645, 2280, 3, 7],
      [3, 2280, 777, 101.125, 11.625, -7.5, -128.539246, -18.1788921, 14.4787645, 2280, 3, 5],
      [0, 3057, 777, 1.25, -2.5, 3.75, -128.539246, -18.1788921, 14.4787645, 2280, 3, 6],
      [1, 16777217, 777, 101.125, 11.625, -7.5, -128.539246, -18.1788921, 14.4787645, 16777538, 3, 6],
    ];
    expect(snapshots).toEqual(native.map(row => row.map((value, index) => index >= 3 && index <= 8 ? Math.fround(value) : value)));
  });
  test("InitMover publishes model/sound/light, fixed position and unnormalized startup delta", () => {
    const f = fixture(), entity = f.inline(); entity.pos1 = vec3(0, 0, 0); entity.pos2 = vec3(100, 0, 0); entity.model2 = "models/test.md3";
    f.movers.initializeBinary(entity, new SpawnVariables([{ key: "noise", value: "sound/test.wav" }, { key: "color", value: "1 0.5 2" }, { key: "light", value: "200" }]));
    expect(entity.s.modelindex2).toBe(7); expect(entity.s.loopSound).toBe(11); expect(entity.s.constantLight).toBe(0x32ff7fff);
    expect(entity.s.pos.delta).toEqual(vec3(10000, 0, 0)); expect(entity.s.pos.duration).toBe(1000);
    expect(entity.speed).toBe(100); expect(entity.s.eType).toBe(EntityType.ET_MOVER);
    expect(f.calls).toEqual(["model:models/test.md3", "sound:sound/test.wav"]);
  });
  test("binary mover float stores keep source out-of-range duration, light and wait behavior", () => {
    const f = fixture(), entity = f.inline();
    entity.pos2 = vec3(500_000_000, 0, 0);
    f.movers.initializeBinary(entity, new SpawnVariables([
      { key: "color", value: "20000000 0 0" }, { key: "light", value: "0" },
    ]));
    expect(entity.s.pos.duration).toBe(1);
    expect(entity.s.constantLight).toBe(-2_147_483_648);
    entity.wait = 5_000_000_000;
    f.movers.setState(entity, MoverState.ONE_TO_TWO, f.clock.time);
    f.movers.reachedBinary(entity);
    expect(entity.nextthink).toBe(-2_147_483_648);
    f.movers.useBinary(entity, null, null);
    expect(entity.nextthink).toBe(-2_147_483_648);
  });
  test("binary use delays 50ms, reverses continuously, fires targets and closes portal", () => {
    const f = fixture(), entity = f.inline(); entity.pos2 = vec3(100, 0, 0); entity.wait = 500; entity.soundLoop = 3;
    entity.sound1to2 = 4; entity.sound2to1 = 5; entity.soundPos1 = 6; entity.soundPos2 = 7;
    f.movers.initializeBinary(entity, new SpawnVariables([]));
    f.movers.useBinary(entity, null, null);
    expect(entity.s.pos.time).toBe(1050); expect(entity.s.pos.delta.x).toBe(100); expect(entity.r.currentOrigin.x).toBe(0);
    expect(f.calls).toEqual([`portal:${entity.slot}:true`]);
    f.clock.time = 1250; f.movers.useBinary(entity, null, null);
    expect(entity.moverState).toBe(MoverState.TWO_TO_ONE); expect(entity.s.pos.time).toBe(450); expect(entity.r.currentOrigin.x).toBeCloseTo(20, 5);
    f.movers.useBinary(entity, null, null);
    expect(entity.moverState).toBe(MoverState.ONE_TO_TWO); expect(entity.s.pos.time).toBe(1050);
    f.clock.time = 2050; f.clock.previousTime = 1250; f.movers.run(entity);
    expect(entity.moverState).toBe(MoverState.POS2); expect(entity.nextthink).toBe(2550); expect(entity.s.loopSound).toBe(3);
    expect(f.calls).toContain(`targets:${entity.slot}:${entity.slot}`);
    f.clock.time = 2550; f.movers.run(entity); expect(entity.moverState).toBe(MoverState.TWO_TO_ONE);
    f.clock.time = 3550; f.clock.previousTime = 2550; f.movers.run(entity);
    expect(entity.moverState).toBe(MoverState.POS1); expect(entity.s.event & 255).toBe(EntityEvent.EV_GENERAL_SOUND);
    expect(entity.s.eventParm).toBe(6); expect(f.calls).toContain(`portal:${entity.slot}:false`);
  });
  test("slave use redirects to master and touches at pos2 extend wait", () => {
    const f = fixture(), master = f.inline(), slave = f.inline(); master.pos2 = vec3(100, 0, 0); slave.pos2 = vec3(0, 100, 0);
    master.wait = 1000; f.movers.initializeBinary(master, new SpawnVariables([])); f.movers.initializeBinary(slave, new SpawnVariables([]));
    master.teamchain = slave; slave.teammaster = master; slave.flags = GameFlags.TEAMSLAVE;
    f.movers.useBinary(slave, slave, slave);
    expect(master.activator).toBe(slave); expect(slave.s.pos.time).toBe(master.s.pos.time);
    f.movers.setState(master, MoverState.POS2, 1000); f.clock.time = 1100; f.movers.useBinary(master, null, null);
    expect(master.nextthink).toBe(2100);
  });
  test("blocked doors return flags, free nonclients by stable slot and damage/reverse players", () => {
    const f = fixture(), entity = f.inline(); entity.pos2 = vec3(100, 0, 0); f.movers.initializeBinary(entity, new SpawnVariables([]));
    f.movers.setState(entity, MoverState.ONE_TO_TWO, 500); entity.damage = 2;
    const player = f.player(0, vec3(1000, 0, 0)); f.movers.blockedDoor(entity, player);
    expect(player.health).toBe(98); expect(entity.moverState).toBe(MoverState.TWO_TO_ONE);
    entity.spawnflags = 4; f.movers.blockedDoor(entity, player); expect(player.health).toBe(96); expect(entity.moverState).toBe(MoverState.TWO_TO_ONE);
    const flag = f.pool.spawn(); flag.s.eType = EntityType.ET_ITEM; flag.item = itemList("baseq3").find(item => item.type === ItemType.IT_TEAM) ?? null;
    f.movers.blockedDoor(entity, flag); expect(f.calls).toContain(`flag:${flag.slot}`); expect(flag.inuse).toBe(true);
    const junk = f.inline(); const slot = junk.slot; f.movers.blockedDoor(entity, junk);
    expect(junk.inuse).toBe(false); expect(junk.s.number).toBe(0); expect(f.world.linkState(slot)?.linked).toBe(false);
    expect(f.pool.spawn()).toBe(junk);
  });
});

test("missionpack movers carry attached prox mines and explode crushed mines through MissileRuntime", () => {
  const f = fixture("missionpack"), mover = f.mover(vec3(0, 0, 4));
  const mine = f.pool.spawn(); mine.classname = "prox mine"; mine.s.eType = EntityType.ET_MISSILE; mine.enemy = mover;
  setOrigin(mine, vec3(0, 0, 2)); mine.movedir = vec3(0, 0, 1); f.world.link(mine);
  f.movers.run(mover); expect(mine.s.pos.base.z).toBe(6); expect(mine.r.currentOrigin.z).toBe(6); expect(f.calls).toEqual([]);
  const g = fixture("missionpack"), crusher = g.mover(vec3(0, 0, 2));
  const crushed = g.pool.spawn(), trigger = g.pool.spawn(); crushed.classname = "prox mine"; crushed.s.eType = EntityType.ET_MISSILE;
  crushed.activator = trigger; crushed.movedir = vec3(0, 0, 1); setOrigin(crushed, vec3(0, 0, 3)); g.world.link(crushed);
  g.movers.run(crusher);
  expect(g.calls).toContain(`explode:${EntityEvent.EV_PROXIMITY_MINE_TRIGGER}`); expect(crushed.freeAfterEvent).toBe(true);
  expect(crushed.activator).toBeNull(); expect(trigger.inuse).toBe(false);
  const h = fixture("missionpack"), rotor = h.mover(vec3(0, 0, 0)), attached = h.pool.spawn();
  rotor.s.apos = { ...rotor.s.apos, type: TrajectoryType.TR_LINEAR, delta: vec3(0, 90, 0) };
  attached.classname = "prox mine"; attached.s.eType = EntityType.ET_MISSILE; attached.enemy = rotor;
  attached.movedir = vec3(0, 0, 1); setOrigin(attached, vec3(10, 0, 2)); h.world.link(attached);
  h.movers.run(rotor);
  expect(attached.r.currentOrigin.x).toBeCloseTo(0, 5); expect(attached.r.currentOrigin.y).toBe(10);
  expect(attached.movedir).toEqual(vec3(0, 0, 1)); expect(h.calls).toEqual([]);
});

test("retail rotating inline brush moves a rider using actual BSP collision", async () => {
  const dataRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  const path = `${dataRoot}/baseq3/pak0.pk3`;
  if (!(await Bun.file(path).exists())) return;
  using archive = await Pk3Archive.open(path);
  const map = parseBsp(await archive.read("maps/q3dm0.bsp"));
  const f = fixture("baseq3", map);
  const record = map.entityRecords.find(entity => entity.get("classname") === "func_rotating");
  if (record === undefined) throw new Error("retail rotating mover fixture not found");
  const model = record.get("model");
  if (model === undefined || !model.startsWith("*")) throw new Error("retail rotating model missing");
  const index = Number(model.slice(1));
  const mover = f.inline(index, vec3(0, 0, 1500));
  mover.s.eType = EntityType.ET_MOVER;
  mover.s.apos = { ...mover.s.apos, type: TrajectoryType.TR_LINEAR, delta: vec3(0, 90, 0) };
  const rider = f.player(0, add3(mover.r.currentOrigin, vec3(10, 0, mover.r.maxs.z + 2)));
  rider.s.groundEntityNum = mover.s.number;
  f.movers.run(mover);
  expect(mover.r.currentAngles.y).toBe(90);
  expect(f.pool.clientAt(0).ps.origin.y).toBeCloseTo(10, 4);
  expect(f.pool.clientAt(0).ps.deltaAngles.y).toBe(16384);
  expect(f.movers.testEntityPosition(rider)).toBeNull();
});
