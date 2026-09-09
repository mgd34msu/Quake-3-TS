import { expect, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { normalize3, vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { damage } from "../src/game/combat.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { EntityPool, initGameEntity, runThink, setOrigin } from "../src/game/entities.ts";
import { MissileRuntime } from "../src/game/missile.ts";
import type { MissileDirection, MissileHost, MissionpackMissileServices } from "../src/game/missile.ts";
import { GameRandom } from "../src/game/numeric.ts";
import type { GameEntity } from "../src/game/state.ts";
import { ServerWorld } from "../src/server/world.ts";
import type { ServerTraceResult } from "../src/server/world.ts";
import { EntityEvent, EntityType, GameType, Team, Weapon, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ServerEntityFlags } from "../src/shared/entity-shared.ts";
import { ENTITYNUM_WORLD, MoveFlags } from "../src/shared/player-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";

function emptyMap(): BspMap {
  const bounds = { min: vec3(-4096, -4096, -4096), max: vec3(4096, 4096, 4096) };
  return { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}

function wallMap(surfaceFlags = 0): BspMap {
  const map = emptyMap(), leaf = map.leaves[0], model = map.models[0];
  if (leaf === undefined || model === undefined) throw new Error("Missing fixture model");
  const planes = [
    { normal: vec3(1, 0, 0), distance: 110 }, { normal: vec3(-1, 0, 0), distance: -100 },
    { normal: vec3(0, 1, 0), distance: 1000 }, { normal: vec3(0, -1, 0), distance: 1000 },
    { normal: vec3(0, 0, 1), distance: 1000 }, { normal: vec3(0, 0, -1), distance: 1000 },
  ];
  return { ...map, planes, shaders: [{ name: "wall", surfaceFlags, contentFlags: 1 }],
    leaves: [{ ...leaf, brushCount: 1 }], leafBrushes: [0], models: [{ ...model, brushCount: 1 }],
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_, plane) => ({ plane, shader: 0 })) };
}

function fixture(product: Product = "baseq3", map = emptyMap()) {
  const clock = { time: 1000, previousTime: 900 }, rules = { gameType: GameType.GT_FFA };
  const calls: string[] = [];
  const pool = new EntityPool({ print: text => { worldPrints.push(text); }, product, maxClients: 3, mapStartTime: 0, time: () => clock.time,
    link: entity => { world.link(entity); }, unlink: entity => { world.unlink(entity.slot); } });
  const worldPrints: string[] = [];
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" }), world = new ServerWorld(collision, collision.modelBounds(0), number => pool.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  pool.at(ENTITYNUM_WORLD).s.number = ENTITYNUM_WORLD;
  const common = { get time() { return clock.time; }, get gameType() { return rules.gameType; }, intermissionQueued: 0,
    friendlyFire: false, knockback: 1000, entities: pool, world, debugDamage: null,
    checkHurtCarrier: () => { calls.push("carrier"); },
    logAccuracyHit: (target: GameEntity, attacker: GameEntity): boolean => target.takedamage && target !== attacker &&
      target.client !== null && attacker.client !== null && target.client.ps.health > 0 &&
      (rules.gameType < GameType.GT_TEAM || target.client.sess.sessionTeam !== attacker.client.sess.sessionTeam) };
  const baseCombat: Extract<CombatContext, { product: "baseq3" }> = { ...common, product: "baseq3",
    get time() { return clock.time; }, get gameType() { return rules.gameType; } };
  const teamCombat: Extract<CombatContext, { product: "missionpack" }> = { ...common, product: "missionpack",
    get time() { return clock.time; }, get gameType() { return rules.gameType; },
    checkObeliskAttack: () => false, invulnerabilityEffect: () => { calls.push("combat invulnerability"); } };
  const effects: { bounce: Vec3 | null } = { bounce: vec3(-1, 0, 0) };
  const missionpack: MissionpackMissileServices = { proxMineTimeout: 30000, random: new GameRandom(1),
    soundIndex: path => { calls.push(path); return 7; },
    invulnerabilityImpact: () => { calls.push("missile invulnerability"); return effects.bounce === null ?
      { kind: "miss" } : { kind: "hit", bounceDirection: effects.bounce }; } };
  const host: MissileHost = product === "baseq3" ? { combat: baseCombat, world, get previousTime() { return clock.previousTime; }, missionpack: null } :
    { combat: teamCombat, world, get previousTime() { return clock.previousTime; }, missionpack };
  const missiles = new MissileRuntime(host);
  function player(number: number, origin: Vec3): GameEntity {
    const entity = pool.at(number), client = pool.clientAt(number); initGameEntity(entity);
    entity.s.eType = EntityType.ET_PLAYER; entity.health = client.ps.health = 100; entity.takedamage = true;
    client.ps.clientNum = number; client.ps.origin = { ...origin }; client.ps.stats.set(statSchema(product).maxHealth, 100);
    client.sess.sessionTeam = number === 0 ? Team.TEAM_RED : Team.TEAM_BLUE;
    entity.r.mins = vec3(-10, -10, -10); entity.r.maxs = vec3(10, 10, 10); entity.r.contents = 0x2000000;
    setOrigin(entity, origin); entity.pain = (_self, _owner, amount) => { calls.push(`pain:${amount}`); };
    entity.die = (self, _source, _owner, amount, mod) => { calls.push(`die:${self.slot}:${amount}:${mod}`); };
    world.link(entity); return entity;
  }
  const owner = player(0, vec3(-500, 0, 100));
  function advance(entity: GameEntity, time: number): void { clock.previousTime = clock.time; clock.time = time; missiles.run(entity); }
  return { clock, rules, calls, pool, world, host, effects, missiles, player, owner, advance };
}

function hit(entityNum = ENTITYNUM_WORLD, end = vec3(50.8, -2.8, 30.9), normal = vec3(-1, 0, 0), fraction = 0.5): ServerTraceResult {
  return { entityNum, end, fraction, contents: 1, surfaceFlags: 0, solidity: "clear", contact: { kind: "plane", plane: { normal, distance: 0 } } };
}

function armedMine(f: ReturnType<typeof fixture>, origin = vec3(0, 0, 0)) {
  const mine = f.missiles.fireProx(f.owner, vec3(origin.x, origin.y, origin.z + 100), { x: 0, y: 0, z: -1 });
  f.missiles.impact(mine, hit(ENTITYNUM_WORLD, origin, vec3(0, 0, 1)));
  f.clock.time = mine.nextthink;
  runThink(mine, f.clock.time);
  const trigger = mine.activator;
  if (trigger === null || trigger.touch === null) throw new Error("Actual proximity activation did not create its touch callback");
  return { mine, trigger, touch: trigger.touch };
}

test("actual armed proximity mines share the source touch function identity", () => {
  const f = fixture("missionpack"), first = armedMine(f), second = armedMine(f, vec3(400, 0, 0));
  expect(first.trigger).not.toBe(second.trigger);
  expect(first.trigger.parent).toBe(first.mine); expect(second.trigger.parent).toBe(second.mine);
  expect(f.world.linkState(first.trigger.slot)?.linked).toBe(true);
  expect(f.world.linkState(second.trigger.slot)?.linked).toBe(true);
  // g_missile.c assigns the same ProximityMine_Trigger pointer; ai_main.c compares that pointer.
  expect(first.touch).toBe(second.touch);
});

test("proximity identity reads the current callback, including aliases, replacement and stable slot reuse", () => {
  const f = fixture("missionpack"), armed = armedMine(f), alias = f.pool.spawn();
  expect(f.missiles.isProximityTrigger(armed.trigger)).toBe(true);
  expect(f.missiles.isProximityTrigger(armed.mine)).toBe(false);
  expect(f.missiles.isProximityTrigger(alias)).toBe(false);
  alias.classname = "not_a_proximity_trigger"; alias.r.contents = 0; alias.s.weapon = Weapon.WP_ROCKET_LAUNCHER;
  alias.touch = armed.touch; alias.inuse = false;
  // ai_main.c owns contents/inuse eligibility; its function-pointer comparison has no extra gates.
  expect(f.missiles.isProximityTrigger(alias)).toBe(true);
  alias.inuse = true;
  armed.trigger.touch = (self, other, trace) => { armed.touch(self, other, trace); };
  expect(f.missiles.isProximityTrigger(armed.trigger)).toBe(false);
  armed.trigger.touch = null;
  expect(f.missiles.isProximityTrigger(armed.trigger)).toBe(false);
  armed.trigger.touch = armed.touch;
  expect(f.missiles.isProximityTrigger(armed.trigger)).toBe(true);
  f.pool.free(armed.trigger);
  expect(armed.trigger.touch).toBeNull(); expect(f.missiles.isProximityTrigger(armed.trigger)).toBe(false);
  expect(f.world.linkState(armed.trigger.slot)?.linked).toBe(false);
  f.clock.time += 1000;
  const reused = f.pool.spawn();
  expect(reused).toBe(armed.trigger); expect(reused.inuse).toBe(true);
  expect(f.missiles.isProximityTrigger(reused)).toBe(false);
  reused.touch = armed.touch; expect(f.missiles.isProximityTrigger(reused)).toBe(true);
  f.pool.free(reused); expect(f.missiles.isProximityTrigger(reused)).toBe(false);
  expect(f.missiles.isProximityTrigger(alias)).toBe(true);
});

test("proximity identity is owner-bound and rejects foreign pools before comparing callbacks", () => {
  const first = fixture("missionpack"), second = fixture("missionpack"), a = armedMine(first), b = armedMine(second);
  expect(a.touch).not.toBe(b.touch);
  expect(first.missiles.isProximityTrigger(a.trigger)).toBe(true);
  expect(second.missiles.isProximityTrigger(b.trigger)).toBe(true);
  expect(() => first.missiles.isProximityTrigger(b.trigger)).toThrow("does not belong to this pool");
  expect(() => second.missiles.isProximityTrigger(a.trigger)).toThrow("does not belong to this pool");
  b.trigger.touch = a.touch;
  expect(second.missiles.isProximityTrigger(b.trigger)).toBe(false);
  expect(() => first.missiles.isProximityTrigger(b.trigger)).toThrow("does not belong to this pool");
  b.trigger.touch = b.touch;
  const alternate = new MissileRuntime(first.host), c = armedMine({ ...first, missiles: alternate });
  expect(c.touch).not.toBe(a.touch);
  expect(alternate.isProximityTrigger(c.trigger)).toBe(true);
  expect(first.missiles.isProximityTrigger(c.trigger)).toBe(false);
  expect(alternate.isProximityTrigger(a.trigger)).toBe(false);
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const own = fixture(product);
    expect(own.missiles.isProximityTrigger(own.owner)).toBe(false);
    expect(() => own.missiles.isProximityTrigger(a.trigger)).toThrow("does not belong to this pool");
  }
});

test("shared proximity touch retains team, radius, client and occlusion filters and independent mine scheduling", () => {
  const f = fixture("missionpack", wallMap()), first = armedMine(f, vec3(0, 0, 100)), second = armedMine(f, vec3(-400, 0, 100));
  f.rules.gameType = GameType.GT_TEAM;
  const victim = f.player(1, vec3(140, 0, 100));
  const timeout = first.mine.nextthink;
  first.touch(first.trigger, first.mine, hit());
  expect(first.trigger.inuse).toBe(true);
  setOrigin(f.owner, vec3(0, 0, 110)); f.world.link(f.owner);
  first.touch(first.trigger, f.owner, hit()); expect(first.trigger.inuse).toBe(true);
  setOrigin(victim, vec3(140, 140, 100)); f.world.link(victim);
  first.touch(first.trigger, victim, hit()); expect(first.trigger.inuse).toBe(true);
  setOrigin(victim, vec3(140, 0, 100)); f.world.link(victim);
  first.touch(first.trigger, victim, hit()); expect(first.trigger.inuse).toBe(true);
  expect(first.mine.nextthink).toBe(timeout); expect(first.mine.s.loopSound).toBe(7);
  setOrigin(victim, vec3(0, 0, 120)); f.world.link(victim);
  first.touch(first.trigger, victim, hit());
  expect(first.trigger.inuse).toBe(false); expect(f.missiles.isProximityTrigger(first.trigger)).toBe(false);
  expect(first.mine.nextthink).toBe(f.clock.time + 500); expect(first.mine.s.loopSound).toBe(0);
  expect(first.mine.s.event & 255).toBe(EntityEvent.EV_PROXIMITY_MINE_TRIGGER);
  expect(second.trigger.inuse).toBe(true); expect(f.missiles.isProximityTrigger(second.trigger)).toBe(true);
  expect(second.mine.nextthink).toBe(35000);
  f.clock.time = 5100; setOrigin(victim, vec3(-400, 0, 120)); f.world.link(victim);
  second.touch(second.trigger, victim, hit());
  expect(second.trigger.inuse).toBe(false); expect(second.mine.nextthink).toBe(5600);
  expect(first.mine.nextthink).toBe(5500);
});

test("separate proximity owners retain their own live clocks and entity pools when touched", () => {
  const first = fixture("missionpack"), second = fixture("missionpack"), a = armedMine(first), b = armedMine(second);
  const firstVictim = first.player(1, vec3(0, 0, 20)), secondVictim = second.player(1, vec3(0, 0, 20));
  first.clock.time = 7000; second.clock.time = 9000;
  a.touch(a.trigger, firstVictim, hit());
  expect(a.mine.nextthink).toBe(7500); expect(a.trigger.inuse).toBe(false);
  expect(b.mine.nextthink).toBe(33000); expect(b.trigger.inuse).toBe(true);
  b.touch(b.trigger, secondVictim, hit());
  expect(b.mine.nextthink).toBe(9500); expect(b.trigger.inuse).toBe(false);
  expect(first.world.linkState(a.trigger.slot)?.linked).toBe(false);
  expect(second.world.linkState(b.trigger.slot)?.linked).toBe(false);
});

test("projectile factories preserve source fields, prestep, normalized caller direction and product MOD_GRAPPLE", () => {
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const f = fixture(product), start = vec3(1.5, -2.5, 100);
    const cases: readonly [Weapon, string, number, number, number, number, number, number, (direction: MissileDirection) => GameEntity][] = [
      [Weapon.WP_PLASMAGUN, "plasma", 2000, 10000, 20, 15, 20, 8, dir => f.missiles.firePlasma(f.owner, start, dir)],
      [Weapon.WP_GRENADE_LAUNCHER, "grenade", 700, 2500, 100, 100, 150, 4, dir => f.missiles.fireGrenade(f.owner, start, dir)],
      [Weapon.WP_ROCKET_LAUNCHER, "rocket", 900, 15000, 100, 100, 120, 6, dir => f.missiles.fireRocket(f.owner, start, dir)],
      [Weapon.WP_BFG, "bfg", 2000, 10000, 100, 100, 120, 12, dir => f.missiles.fireBfg(f.owner, start, dir)],
      [Weapon.WP_GRAPPLING_HOOK, "hook", 800, 10000, 0, 0, 0, product === "baseq3" ? 23 : 28, dir => f.missiles.fireGrapple(f.owner, start, dir)],
    ];
    for (const [weapon, classname, speed, duration, direct, splash, radius, method, fire] of cases) {
      const direction = { x: 3, y: 4, z: 0 }, entity = fire(direction);
      expect(direction).toEqual(vec3(0.6, 0.8, 0)); expect(entity.s.weapon).toBe(weapon); expect(entity.classname).toBe(classname);
      expect(entity.s.eType).toBe(EntityType.ET_MISSILE); expect(entity.r.ownerNum).toBe(0); expect(entity.parent).toBe(f.owner);
      expect(entity.s.pos.time).toBe(950); expect(entity.s.pos.base).toEqual(start); expect(entity.s.pos.base).not.toBe(start);
      expect(entity.s.pos.delta).toEqual(vec3(Math.trunc(Math.fround(Math.fround(0.6) * speed)), Math.trunc(Math.fround(Math.fround(0.8) * speed)), 0));
      expect(entity.nextthink).toBe(1000 + duration); expect(entity.damage).toBe(direct); expect(entity.splashDamage).toBe(splash);
      expect(entity.splashRadius).toBe(radius); expect(entity.methodOfDeath).toBe(method); expect(entity.clipmask).toBe(0x6000001);
      expect(entity.r.svFlags).toBe(ServerEntityFlags.USE_CURRENT_ORIGIN); expect(f.world.linkState(entity.slot)).toBeUndefined();
    }
  }
});

test("run advances the 50ms prestep, ignores the owner, links and expires strict event lifetime", () => {
  const f = fixture(); const rocket = f.missiles.fireRocket(f.owner, f.owner.r.currentOrigin, { x: 1, y: 0, z: 0 });
  f.advance(rocket, 1000); expect(rocket.r.currentOrigin.x).toBe(-455); expect(rocket.s.eType).toBe(EntityType.ET_MISSILE);
  f.advance(rocket, 16000); expect(rocket.s.eType).toBe(EntityType.ET_GENERAL); expect(rocket.freeAfterEvent).toBe(true);
  expect(rocket.s.event & 255).toBe(EntityEvent.EV_MISSILE_MISS); expect(rocket.s.eventParm).toBe(5);
  expect(rocket.r.currentOrigin.x).toBe(13045); expect(rocket.nextthink).toBe(0);
  f.clock.time = 16300; expect(f.pool.expireEvents(rocket)).toBe("waiting");
  f.clock.time = 16301; expect(f.pool.expireEvents(rocket)).toBe("freed");
});

test("missile flight inherits the shared QVM trajectory's literal and multiply rounding", () => {
  const f = fixture();
  const grenade = f.missiles.fireGrenade(f.owner, vec3(1.5, -2.5, 100), { x: 0.1, y: 0.2, z: 0.3 });
  grenade.s.pos = { ...grenade.s.pos, time: 1000 };
  f.advance(grenade, 1029);
  const encoded = new DataView(new ArrayBuffer(12));
  encoded.setFloat32(0, grenade.r.currentOrigin.x); encoded.setFloat32(4, grenade.r.currentOrigin.y); encoded.setFloat32(8, grenade.r.currentOrigin.z);
  expect([encoded.getInt32(0), encoded.getInt32(4), encoded.getInt32(8)]).toEqual([1088260408, 1090881848, 1122491773]);
});

test("explosion snapping uses QVM float-to-int overflow rather than modulo wrapping", () => {
  const f = fixture();
  const rocket = f.missiles.fireRocket(f.owner, vec3(4294967296, -4294967296, 2147483648), { x: 1, y: 0, z: 0 });
  f.missiles.explode(rocket);
  // Untouched G_ExplodeMissile through vm_game=1 emits -822083584 float bits on every axis.
  expect(rocket.s.pos.base).toEqual(vec3(-2147483648, -2147483648, -2147483648));
});

test("bounce samples gravity at impact time, halves energy and settles only below source speed threshold", () => {
  const f = fixture(), grenade = f.missiles.fireGrenade(f.owner, vec3(0, 0, 100), { x: 1, y: 0, z: 0 });
  f.clock.time = 1100; f.clock.previousTime = 1000;
  grenade.r.currentOrigin = vec3(50, 0, 50);
  f.missiles.bounce(grenade, hit(ENTITYNUM_WORLD, grenade.r.currentOrigin, vec3(0, 0, 1)));
  // Untouched g_missile.c through original lcc/q3asm + vm_game1: .65 is binary32.
  // Native C instead produces455 here; QVM captured x bits are1138982911.
  expect(grenade.s.pos.delta).toEqual(vec3(454.9999694824219, 0, 52)); expect(grenade.r.currentOrigin).toEqual(vec3(50, 0, 51));
  expect(grenade.s.pos.time).toBe(1100);
  grenade.s.pos = { ...grenade.s.pos, type: TrajectoryType.TR_LINEAR, delta: vec3(20, 0, -20) };
  const floor = hit(ENTITYNUM_WORLD, vec3(1.8, -2.8, 3.8), vec3(0, 0, 1));
  f.missiles.impact(grenade, floor);
  expect(grenade.s.pos.type).toBe(TrajectoryType.TR_STATIONARY); expect(grenade.r.currentOrigin).toEqual(floor.end);
  expect(grenade.s.event & 255).toBe(EntityEvent.EV_GRENADE_BOUNCE); expect(grenade.freeAfterEvent).toBe(false);
});

test("real brush impacts snap toward launch, publish metal events and remove sky grapples without an explosion", () => {
  const f = fixture("baseq3", wallMap(0x1000));
  const rocket = f.missiles.fireRocket(f.owner, vec3(0, 0, 100), { x: 1, y: 0, z: 0 });
  f.advance(rocket, 1100); expect(rocket.r.currentOrigin).toEqual(vec3(99, 0, 100));
  expect(rocket.s.event & 255).toBe(EntityEvent.EV_MISSILE_MISS_METAL); expect(rocket.s.eType).toBe(EntityType.ET_GENERAL);
  const sky = fixture("baseq3", wallMap(0x10)), client = sky.pool.clientAt(0);
  const hook = sky.missiles.fireGrapple(sky.owner, vec3(0, 0, 100), { x: 1, y: 0, z: 0 });
  client.ps.pmFlags |= MoveFlags.GRAPPLE_PULL; sky.advance(hook, 1100);
  expect(hook.inuse).toBe(false); expect(client.hook).toBeNull(); expect(client.ps.pmFlags & MoveFlags.GRAPPLE_PULL).not.toBe(0);
  expect(sky.pool.numEntities).toBe(65); expect(sky.world.linkState(hook.slot)?.linked).toBe(false);
});

test("direct and splash damage use real combat and count one accuracy hit for the projectile", () => {
  const f = fixture(), direct = f.player(1, vec3(100, 0, 100)), splash = f.player(2, vec3(100, 50, 100));
  const rocket = f.missiles.fireRocket(f.owner, vec3(0, 0, 100), { x: 1, y: 0, z: 0 });
  f.advance(rocket, 1100);
  expect(direct.health).toBe(0); expect(splash.health).toBeLessThan(100);
  expect(f.pool.clientAt(0).accuracyHits).toBe(1); expect(rocket.s.otherEntityNum).toBe(1);
  expect(rocket.s.event & 255).toBe(EntityEvent.EV_MISSILE_HIT); expect(f.calls).toContain("die:1:100:6");
});

test("start-solid traces reacquire the entity and use the source zero plane instead of a fabricated reflection", () => {
  const f = fixture(), victim = f.player(1, vec3(0, 0, 100));
  const plasma = f.missiles.firePlasma(f.owner, victim.r.currentOrigin, { x: 1, y: 0, z: 0 });
  f.advance(plasma, 1000); expect(victim.health).toBe(80); expect(plasma.r.currentOrigin).toEqual(vec3(0, 0, 100));
  expect(plasma.s.eventParm).toBe(0); expect(plasma.s.otherEntityNum).toBe(1);
});

test("grapple impact creates a separate event, pulls the owner and tracks a moving enemy without rescheduling", () => {
  const f = fixture(), victim = f.player(1, vec3(100, 0, 100)), client = f.pool.clientAt(0);
  const hook = f.missiles.fireGrapple(f.owner, vec3(0, 0, 100), { x: 1, y: 0, z: 0 });
  f.advance(hook, 1100); expect(hook.s.eType).toBe(EntityType.ET_GRAPPLE); expect(hook.enemy).toBe(victim);
  expect(hook.r.currentOrigin).toEqual(vec3(100, 0, 100)); expect(client.ps.grapplePoint).toEqual(hook.r.currentOrigin);
  expect(client.ps.pmFlags & MoveFlags.GRAPPLE_PULL).not.toBe(0); expect(hook.nextthink).toBe(1200);
  const event = f.pool.at(hook.slot + 1); expect(event.freeAfterEvent).toBe(true); expect(event.s.eType).toBe(EntityType.ET_GENERAL);
  victim.r.currentOrigin = vec3(120.8, -2.8, 100); f.clock.time = 1200; runThink(hook, f.clock.time);
  expect(hook.r.currentOrigin).toEqual(vec3(120, -1, 100)); expect(hook.nextthink).toBe(0);
  expect(client.ps.grapplePoint).toEqual(hook.r.currentOrigin);
  f.missiles.hookFree(hook); expect(client.hook).toBeNull(); expect(client.ps.pmFlags & MoveFlags.GRAPPLE_PULL).toBe(0);
});

test("missionpack invulnerability returns without damage, preserves half-bounce flag and ignores that client next frame", () => {
  for (const bounce of [false, true]) {
    const f = fixture("missionpack"), victim = f.player(1, vec3(100, 0, 100));
    f.pool.clientAt(1).invulnerabilityTime = 2000; if (!bounce) f.effects.bounce = null;
    const rocket = f.missiles.fireRocket(f.owner, vec3(0, 0, 100), { x: 1, y: 0, z: 0 }); rocket.s.eFlags |= 0x20;
    f.advance(rocket, 1100); expect(rocket.targetEnt).toBe(victim); expect(victim.health).toBe(100);
    expect(rocket.s.eType).toBe(EntityType.ET_MISSILE); expect(rocket.s.eFlags & 0x20).toBe(0x20);
    expect(rocket.s.pos.delta.x).toBe(bounce ? -900 : 900); expect(f.calls).toEqual(["missile invulnerability"]);
    f.advance(rocket, 1200); expect(f.calls).toEqual(["missile invulnerability"]);
  }
});

test("proximity mine sticks, activates a spherical team-filtered trigger, then explodes after 500ms", () => {
  const f = fixture("missionpack"), victim = f.player(1, vec3(0, 0, 100)); f.rules.gameType = GameType.GT_TEAM;
  const mine = f.missiles.fireProx(f.owner, vec3(0, 0, 100), { x: 0, y: 0, z: -1 });
  f.missiles.impact(mine, hit(ENTITYNUM_WORLD, vec3(0, 0, 0), vec3(0, 0, 1)));
  expect(mine.s.pos.type).toBe(TrajectoryType.TR_STATIONARY); expect(mine.nextthink).toBe(3000);
  f.clock.time = 3000; runThink(mine, 3000); const trigger = mine.activator;
  if (trigger === null || trigger.touch === null) throw new Error("Mine did not create its trigger");
  expect(mine.health).toBe(1); expect(mine.takedamage).toBe(true); expect(mine.s.loopSound).toBe(7);
  expect(mine.nextthink).toBe(33000); expect(trigger.r.mins).toEqual(vec3(-150, -150, -150));
  setOrigin(f.owner, vec3(0, 0, 20)); trigger.touch(trigger, f.owner, hit()); expect(trigger.inuse).toBe(true);
  setOrigin(victim, vec3(140, 140, 0)); f.world.link(victim); trigger.touch(trigger, victim, hit()); expect(trigger.inuse).toBe(true);
  setOrigin(victim, vec3(0, 0, 100)); f.world.link(victim); trigger.touch(trigger, victim, hit());
  expect(trigger.inuse).toBe(false); expect(mine.nextthink).toBe(3500); expect(mine.s.loopSound).toBe(0);
  expect(mine.s.event & 255).toBe(EntityEvent.EV_PROXIMITY_MINE_TRIGGER);
  f.clock.time = 3500; runThink(mine, 3500); expect(mine.freeAfterEvent).toBe(true); expect(mine.activator).toBeNull();
});

test("proximity stick angles match original QVM atan2 and degree conversion on a sloped plane", () => {
  const f = fixture("missionpack");
  const mine = f.missiles.fireProx(f.owner, vec3(0, 0, 100), { x: 0, y: 0, z: -1 });
  f.missiles.impact(mine, hit(ENTITYNUM_WORLD, vec3(0, 0, 0), normalize3(vec3(-4, 0.37, 10))));
  // Original q_math.c via lcc/q3asm and vm_game=1, followed by source PITCH += 90.
  const encoded = new DataView(new ArrayBuffer(12));
  encoded.setFloat32(0, mine.s.angles.x); encoded.setFloat32(4, mine.s.angles.y); encoded.setFloat32(8, mine.s.angles.z);
  expect([encoded.getInt32(0), encoded.getInt32(4), encoded.getInt32(8)]).toEqual([1101993456, 1127134997, 0]);
});

test("attached proximity mines stack using entity ticking flags and preserve the source juiced-mine lifetime", () => {
  const f = fixture("missionpack"), victim = f.player(1, vec3(100, 0, 100)), client = f.pool.clientAt(1);
  client.invulnerabilityTime = 10000;
  const mine = f.missiles.fireProx(f.owner, vec3(0, 0, 100), { x: 1, y: 0, z: 0 });
  f.missiles.impact(mine, hit(1)); expect(mine.enemy).toBe(victim); expect(mine.nextthink).toBe(3000);
  expect(client.ps.eFlags & 2).toBe(2); expect(mine.s.eFlags & 0x80).toBe(0x80);
  victim.s.eFlags |= 2;
  const second = f.missiles.fireProx(f.owner, vec3(0, 0, 100), { x: 1, y: 0, z: 0 });
  f.missiles.impact(second, hit(1)); expect(mine.splashDamage).toBe(200); expect(mine.splashRadius).toBe(225);
  runThink(second, 1000); expect(second.inuse).toBe(false);
  f.clock.time = 3000; runThink(mine, 3000);
  expect(client.invulnerabilityTime).toBe(0); expect(client.ps.eFlags & 2).toBe(0); expect(victim.health).toBe(-900);
  expect(mine.inuse).toBe(true); expect(mine.freeAfterEvent).toBe(false); expect(mine.nextthink).toBe(0);
  expect(f.calls).toContain("die:1:1000:27");
});

test("proximity owner exclusion ends only after leaving the body, allowing attachment to the owner", () => {
  const f = fixture("missionpack");
  const mine = f.missiles.fireProx(f.owner, f.owner.r.currentOrigin, { x: 1, y: 0, z: 0 });
  mine.s.pos = { ...mine.s.pos, time: 1000, delta: vec3(0, 0, 0) };
  f.advance(mine, 1000); expect(mine.count).toBe(0); expect(mine.enemy).toBeNull();
  mine.s.pos = { ...mine.s.pos, delta: vec3(700, 0, 0) }; f.advance(mine, 1100);
  expect(mine.count).toBe(1); expect(mine.enemy).toBeNull();
  mine.s.pos = { ...mine.s.pos, time: 1100, base: { ...mine.r.currentOrigin }, delta: vec3(-700, 0, 0) };
  f.advance(mine, 1200); expect(mine.enemy).toBe(f.owner); expect(f.pool.clientAt(0).ps.eFlags & 2).toBe(2);
});

test("attached normal proximity explosion uses the player's current network position and restores event visibility", () => {
  const f = fixture("missionpack"), victim = f.player(1, vec3(100, 0, 100));
  const mine = f.missiles.fireProx(f.owner, vec3(0, 0, 100), { x: 1, y: 0, z: 0 });
  f.missiles.impact(mine, hit(1)); expect(mine.nextthink).toBe(11000);
  setOrigin(victim, vec3(200, 0, 100)); f.world.link(victim); f.clock.time = 11000; runThink(mine, 11000);
  expect(mine.r.currentOrigin).toEqual(vec3(200, 0, 100)); expect(mine.r.svFlags & ServerEntityFlags.NOCLIENT).toBe(0);
  expect(mine.freeAfterEvent).toBe(true); expect(victim.health).toBe(0); expect(f.pool.clientAt(1).ps.eFlags & 2).toBe(0);
});

test("armed mine triggers honor solid occlusion and shooting the mine schedules explosion one millisecond later", () => {
  const f = fixture("missionpack", wallMap()), victim = f.player(1, vec3(140, 0, 100));
  const mine = f.missiles.fireProx(f.owner, vec3(0, 0, 100), { x: 1, y: 0, z: 0 });
  f.missiles.impact(mine, hit(ENTITYNUM_WORLD, vec3(0, 0, 100), vec3(0, 0, 1)));
  f.clock.time = 3000; runThink(mine, 3000); const trigger = mine.activator;
  if (trigger === null || trigger.touch === null) throw new Error("Missing armed trigger");
  trigger.touch(trigger, victim, hit()); expect(trigger.inuse).toBe(true); expect(mine.nextthink).toBe(33000);
  damage(f.host.combat, mine, f.owner, f.owner, vec3(1, 0, 0), mine.r.currentOrigin, 1, 0, 3);
  expect(mine.nextthink).toBe(3001); expect(mine.freeAfterEvent).toBe(false);
  runThink(mine, 3000); expect(mine.freeAfterEvent).toBe(false);
  f.clock.time = 3001; runThink(mine, 3001); expect(mine.freeAfterEvent).toBe(true); expect(trigger.inuse).toBe(false);
});

test("missionpack nails match original QVM RNG fixtures with no prestep; base rejects Team Arena projectiles", () => {
  const f = fixture("missionpack");
  // Untouched g_missile.c/bg_lib.c, srand(1), original lcc/q3asm and vm_game1.
  for (const velocity of [vec3(700, 4, -25), vec3(1911, 38, -20), vec3(981, -9, -6), vec3(1003, 3, -37)]) {
    const nail = f.missiles.fireNail(f.owner, vec3(0, 0, 100), vec3(1, 0, 0), vec3(0, -1, 0), vec3(0, 0, 1));
    expect(nail.s.pos.time).toBe(1000); expect(nail.s.weapon).toBe(Weapon.WP_NAILGUN); expect(nail.splashDamage).toBe(0);
    expect(nail.s.pos.delta).toEqual(velocity); expect(nail.damage).toBe(20); expect(nail.nextthink).toBe(11000);
  }
  const base = fixture(); expect(() => base.missiles.fireProx(base.owner, vec3(0, 0, 0), { x: 1, y: 0, z: 0 })).toThrow("missionpack");
  expect(() => base.missiles.fireNail(base.owner, vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1))).toThrow("missionpack");
});

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retail = await Bun.file(`${dataPath}/baseq3/pak0.pk3`).exists();
test.skipIf(!retail)("rocket impacts the retail q3dm1 spawn-room floor through the real server world", async () => {
  const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "baseq3" });
  const map = parseBsp(await vfs.read("maps/q3dm1.bsp"));
  const spawn = map.entityRecords.find(entity => entity.get("classname") === "info_player_deathmatch");
  const origin = spawn?.get("origin"); if (origin === undefined) throw new Error("Missing retail spawn");
  const [x, y, z] = origin.split(/\s+/).map(Number);
  if (x === undefined || y === undefined || z === undefined) throw new Error("Malformed retail spawn");
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const f = fixture(product, map); const rocket = f.missiles.fireRocket(f.owner, vec3(x, y, z + 60), { x: 0, y: 0, z: -1 });
    f.advance(rocket, 1100); expect(rocket.s.eType).toBe(EntityType.ET_GENERAL); expect(rocket.s.event & 255).toBe(EntityEvent.EV_MISSILE_MISS);
    expect(rocket.r.currentOrigin.z).toBe(1); expect(rocket.s.eventParm).toBe(5); expect(f.world.linkState(rocket.slot)?.linked).toBe(true);
  }
}, 20000);
