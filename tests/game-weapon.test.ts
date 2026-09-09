import { expect, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { float32ToBits } from "../src/core/numeric.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { EntityPool, initGameEntity, runThink, setOrigin } from "../src/game/entities.ts";
import { MissileRuntime } from "../src/game/missile.ts";
import type { MissileHost } from "../src/game/missile.ts";
import { GameRandom } from "../src/game/numeric.ts";
import type { GameEntity } from "../src/game/state.ts";
import { WeaponRuntime, invulnerabilityEffect, logAccuracyHit, raySphereIntersections } from "../src/game/weapon.ts";
import { ServerWorld } from "../src/server/world.ts";
import type { ServerTraceQuery, ServerTraceResult } from "../src/server/world.ts";
import { EntityEvent, EntityType, GameType, PersistentIndex, Powerup, Team, Weapon, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { itemList } from "../src/shared/items.ts";
import { ServerEntityFlags } from "../src/shared/entity-shared.ts";
import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from "../src/shared/player-state.ts";

// QVM goldens: untouched dbe4ddb g_weapon/g_combat/g_missile/g_utils + shared sources.
// Reproduce with /tmp/quake3-weapon-reference-5X4CdV/{build-vm.sh,run-vm.sh}; vm_game=1.

function emptyMap(): BspMap {
  const bounds = { min: vec3(-4096, -4096, -4096), max: vec3(4096, 4096, 4096) };
  return { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}

function wallMap(flags = 0): BspMap {
  const map = emptyMap(), leaf = map.leaves[0], model = map.models[0];
  if (leaf === undefined || model === undefined) throw new Error("Fixture missing leaf/model");
  const planes = [{ normal: vec3(1, 0, 0), distance: 110 }, { normal: vec3(-1, 0, 0), distance: -100 },
    { normal: vec3(0, 1, 0), distance: 1000 }, { normal: vec3(0, -1, 0), distance: 1000 },
    { normal: vec3(0, 0, 1), distance: 1000 }, { normal: vec3(0, 0, -1), distance: 1000 }];
  return { ...map, planes, shaders: [{ name: "wall", surfaceFlags: flags, contentFlags: 1 }],
    leaves: [{ ...leaf, brushCount: 1 }], leafBrushes: [0], models: [{ ...model, brushCount: 1 }],
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_, plane) => ({ plane, shader: 0 })) };
}

class ObservedWorld extends ServerWorld {
  readonly traces: { readonly start: Vec3; readonly end: Vec3; readonly pass: number }[] = [];
  override trace(query: ServerTraceQuery): ServerTraceResult {
    this.traces.push({ start: { ...query.start }, end: { ...query.end }, pass: query.passEntityNum });
    return super.trace(query);
  }
}

function fixture(product: Product = "baseq3", map = emptyMap()) {
  const settings = { time: 1000, quad: 3, gameType: GameType.GT_FFA }, random = new GameRandom(1);
  const calls: string[] = [];
  const pool = new EntityPool({ print: text => { worldPrints.push(text); }, product, maxClients: 8, mapStartTime: 0, time: () => settings.time,
    link: entity => { world.link(entity); }, unlink: entity => { world.unlink(entity.slot); } });
  const worldPrints: string[] = [];
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" }), world = new ObservedWorld(collision, collision.modelBounds(0), number => pool.get(number), {
    loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); },
  });
  pool.at(ENTITYNUM_WORLD).s.number = ENTITYNUM_WORLD;
  const services = { get time() { return settings.time; }, get gameType() { return settings.gameType; }, intermissionQueued: 0,
    friendlyFire: false, knockback: 1000, entities: pool, world, debugDamage: null,
    checkHurtCarrier: () => { calls.push("carrier"); },
    logAccuracyHit: (target: GameEntity, attacker: GameEntity): boolean => logAccuracyHit(settings.gameType, target, attacker) };
  const combat: CombatContext = product === "baseq3" ? { ...services, product,
    get time() { return settings.time; }, get gameType() { return settings.gameType; } } : { ...services, product,
    get time() { return settings.time; }, get gameType() { return settings.gameType; },
    checkObeliskAttack: () => false,
    invulnerabilityEffect: (target, direction, point) => { invulnerabilityEffect(pool, target, direction, point); } };
  const host: MissileHost = combat.product === "baseq3" ? { combat, world, previousTime: 900, missionpack: null } :
    { combat, world, previousTime: 900, missionpack: { random, proxMineTimeout: 30000, soundIndex: () => 1,
      invulnerabilityImpact: (target, direction, point) => invulnerabilityEffect(pool, target, direction, point) } };
  const missiles = new MissileRuntime(host), weapons = new WeaponRuntime({ missiles, random, get quadFactor() { return settings.quad; } });
  function player(number: number, origin: Vec3): GameEntity {
    const entity = pool.at(number), client = pool.clientAt(number); initGameEntity(entity); entity.s.eType = EntityType.ET_PLAYER;
    entity.health = client.ps.health = 100; entity.takedamage = true; client.ps.clientNum = entity.s.clientNum = number;
    client.ps.stats.set(statSchema(product).maxHealth, 100); client.ps.viewheight = 26;
    client.ps.origin = { ...origin }; client.ps.groundEntityNum = ENTITYNUM_NONE;
    client.sess.sessionTeam = number === 0 ? Team.TEAM_RED : Team.TEAM_BLUE;
    entity.r.mins = vec3(-10, -10, -24); entity.r.maxs = vec3(10, 10, 32); entity.r.contents = 0x2000000;
    setOrigin(entity, origin); world.link(entity);
    entity.pain = (_self, _attacker, amount) => { calls.push(`pain:${number}:${amount}`); };
    entity.die = (_self, _source, _attacker, amount, mod) => { calls.push(`die:${number}:${amount}:${mod}`); };
    return entity;
  }
  const owner = player(0, vec3(0, 0, 0));
  function events(event: EntityEvent): GameEntity[] {
    const result: GameEntity[] = [];
    for (let number = 64; number < pool.numEntities; number++) {
      const entity = pool.at(number);
      if (entity.inuse && entity.s.eType === EntityType.ET_EVENTS + event) result.push(entity);
    }
    return result;
  }
  function fire(weapon: Weapon): void { owner.s.weapon = weapon; weapons.fire(owner); }
  return { pool, world, settings, random, combat, missiles, weapons, calls, owner, player, events, fire };
}

test("ray-sphere keeps source root order, behind-ray hits, tangent/zero-direction behavior and caller normalization", () => {
  const direction = { x: 2, y: 0, z: 0 };
  expect(raySphereIntersections(vec3(0, 0, 0), 42, vec3(100, 0, 0), direction)).toEqual([vec3(42, 0, 0), vec3(-42, 0, 0)]);
  expect(direction).toEqual(vec3(1, 0, 0));
  expect(raySphereIntersections(vec3(0, 0, 0), 42, vec3(0, 42, 0), { x: 1, y: 0, z: 0 })).toEqual([vec3(0, 42, 0)]);
  expect(raySphereIntersections(vec3(0, 0, 0), 42, vec3(0, 43, 0), { x: 1, y: 0, z: 0 })).toEqual([]);
  expect(raySphereIntersections(vec3(0, 0, 0), 42, vec3(0, 0, 0), { x: 0, y: 0, z: 0 })).toEqual([vec3(0, 0, 0), vec3(0, 0, 0)]);
});

test("actual invulnerability helper publishes source orientation and leaves caller direction unchanged", () => {
  const f = fixture("missionpack"), target = f.player(1, vec3(100, 0, 0)), direction = vec3(2, 0, 0);
  const effect = invulnerabilityEffect(f.pool, target, direction, vec3(90, 0, 0));
  expect(effect).toEqual({ kind: "hit", impactPoint: vec3(58, 0, 0), bounceDirection: vec3(-1, 0, 0) });
  expect(direction).toEqual(vec3(2, 0, 0));
  const event = f.events(EntityEvent.EV_INVUL_IMPACT)[0];
  if (event === undefined) throw new Error("Missing impact event");
  expect(event.s.angles).toEqual(vec3(90, 180, 0)); expect(event.r.currentOrigin).toEqual(vec3(100, 0, 0));
  expect(invulnerabilityEffect(f.pool, f.pool.at(ENTITYNUM_WORLD), direction, vec3(0, 0, 0))).toEqual({ kind: "miss" });
});

test("sphere intersections and shield event match original QVM nonaxis float bits", () => {
  const origin = vec3(5, 6, 7), point = vec3(50, 10, -2), direction = { x: -3, y: Math.fround(0.7), z: Math.fround(0.1) };
  const bits = (value: Vec3): number[] => [value.x, value.y, value.z].map(component => float32ToBits(component) | 0);
  const roots = raySphereIntersections(origin, 42, point, direction);
  expect(bits(direction)).toEqual([-1082577906,1047039877,1023730764]);
  expect(roots.map(bits)).toEqual([[-1041333596,1105525850,1059656676],[1110900903,1093655874,-1074930032]]);
  const f = fixture("missionpack"), target = f.player(1, origin);
  const impact = invulnerabilityEffect(f.pool, target, vec3(3, -0.7, -0.1), point);
  if (impact.kind !== "hit") throw new Error("Expected source shield intersection");
  expect(bits(impact.impactPoint)).toEqual([-1041333596,1105525850,1059656676]);
  expect(bits(impact.bounceDirection)).toEqual([-1085001017,1057613016,-1105555354]);
  const event = f.events(EntityEvent.EV_INVUL_IMPACT)[0]; if (event === undefined) throw new Error("Missing impact event");
  expect(bits(event.s.angles)).toEqual([-1014847291,1125317527,0]);
});

test("weapon factories use snapped entity muzzle, live quad/doubler scaling and source grenade elevation", () => {
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const f = fixture(product), client = f.pool.clientAt(0);
    client.oldOrigin = vec3(999, 999, 999); client.ps.origin = vec3(555, 555, 555); setOrigin(f.owner, vec3(1.8, -2.8, 3.8));
    client.ps.powerups.set(Powerup.PW_QUAD, 1);
    f.fire(Weapon.WP_ROCKET_LAUNCHER); const rocket = f.pool.at(64);
    expect(rocket.s.pos.base).toEqual(vec3(15, -2, 29)); expect(rocket.damage).toBe(300); expect(rocket.splashDamage).toBe(300);
    f.settings.quad = 2.5; f.fire(Weapon.WP_PLASMAGUN); expect(f.pool.at(65).damage).toBe(50); expect(f.pool.at(65).splashDamage).toBe(37);
    f.fire(Weapon.WP_GRENADE_LAUNCHER); expect(f.pool.at(66).s.pos.delta).toEqual(vec3(686, 0, 137));
    expect(client.accuracyShots).toBe(3);
    if (product === "missionpack") {
      const powerup = f.pool.spawn(); powerup.item = itemList(product).find(item => item.tag === Powerup.PW_DOUBLER && item.className === "item_doubler") ?? null;
      if (powerup.item === null) throw new Error("Missing source doubler item");
      client.persistantPowerup = powerup; f.fire(Weapon.WP_BFG); expect(f.pool.at(68).damage).toBe(500);
      f.fire(Weapon.WP_PROX_LAUNCHER); expect(f.pool.at(69).splashDamage).toBe(500);
    }
  }
});

test("gauntlet contact owns damage and quad event while FireWeapon gauntlet remains source-empty", () => {
  const f = fixture(), client = f.pool.clientAt(0), target = f.player(1, vec3(40, 0, 0));
  f.fire(Weapon.WP_GAUNTLET); expect(target.health).toBe(100); expect(client.accuracyShots).toBe(0);
  expect(f.weapons.checkGauntletAttack(f.owner)).toBe(true); expect(target.health).toBe(50);
  client.ps.powerups.set(Powerup.PW_QUAD, 1); f.weapons.checkGauntletAttack(f.owner);
  expect(target.health).toBe(-100); expect(f.owner.s.event).toBe(0); expect(client.ps.externalEvent & 255).toBe(EntityEvent.EV_POWERUP_QUAD);
  expect(f.events(EntityEvent.EV_MISSILE_HIT)).toHaveLength(2); expect(client.accuracyHits).toBe(0);
  const miss = fixture(); expect(miss.weapons.checkGauntletAttack(miss.owner)).toBe(false);
});

test("machinegun team damage applies only to GT_TEAM; hits and sky events preserve source ordering", () => {
  for (const [mode, expected] of [[GameType.GT_FFA, 93], [GameType.GT_TEAM, 95], [GameType.GT_CTF, 93]] satisfies readonly (readonly [GameType, number])[]) {
    const f = fixture(), target = f.player(1, vec3(50, 0, 0)); f.settings.gameType = mode; f.fire(Weapon.WP_MACHINEGUN);
    expect(target.health).toBe(expected); expect(f.pool.clientAt(0).accuracyHits).toBe(1);
    const event = f.events(EntityEvent.EV_BULLET_HIT_FLESH)[0];
    if (event === undefined) throw new Error("Missing bullet event");
    expect(event.s.eventParm).toBe(1); expect(event.s.otherEntityNum).toBe(0);
  }
  const sky = fixture("baseq3", wallMap(0x10)); sky.fire(Weapon.WP_MACHINEGUN);
  expect(sky.pool.numEntities).toBe(64); expect(sky.pool.clientAt(0).accuracyShots).toBe(1);
});

test("shotgun publishes one deterministic seed event, fires eleven pellets, and scores accuracy after damage", () => {
  const f = fixture(), target = f.player(1, vec3(50, 0, 0)); target.health = f.pool.clientAt(1).ps.health = 1000;
  f.fire(Weapon.WP_SHOTGUN); expect(target.health).toBe(890); expect(f.pool.clientAt(0).accuracyHits).toBe(1);
  const event = f.events(EntityEvent.EV_SHOTGUN)[0];
  if (event === undefined) throw new Error("Missing shotgun event");
  expect(event.s.eventParm).toBe(206); expect(event.s.origin2).toEqual(vec3(4096, 0, 0)); expect(event.s.pos.base).toEqual(vec3(14, 0, 26));
  expect(f.calls.filter(call => call.startsWith("pain:"))).toHaveLength(11);
  const lethal = fixture(), victim = lethal.player(1, vec3(50, 0, 0)); victim.health = lethal.pool.clientAt(1).ps.health = 10;
  lethal.fire(Weapon.WP_SHOTGUN); expect(lethal.pool.clientAt(0).accuracyHits).toBe(0);
});

test("nonaxis hitscan endpoints match untouched FireWeapon executed in the original QVM", () => {
  // Original g_weapon/g_combat/g_missile/g_utils, lcc/q3asm + vm_game=1, seed1.
  const fixtures: readonly (readonly [Weapon, readonly (readonly [number, number, number])[]])[] = [
    [Weapon.WP_MACHINEGUN, [[1204536774,1199956911,-954448601]]],
    [Weapon.WP_SHOTGUN, [[1203794901,1200615921,-952725104],[1204693716,1199257834,-953376298],
      [1204007630,1200292714,-952740836],[1205337770,1199613287,-958939060],[1205095958,1199593258,-956221568],
      [1204597214,1199410443,-953118565],[1204896785,1199462497,-954855584],[1204750059,1199938182,-955552299],
      [1204350849,1200513693,-955412220],[1204696952,1200509006,-958289038],[1203988613,1200204415,-952321769]]],
    [Weapon.WP_LIGHTNING, [[1142766878,1137311936,-1018721635]]],
    [Weapon.WP_RAILGUN, [[1171110269,1166374357,-988536386]]],
    [Weapon.WP_CHAINGUN, [[1204330841,1200028513,-953573894]]],
  ];
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) for (const [weapon, endpoints] of fixtures) {
    if (weapon === Weapon.WP_CHAINGUN && product === "baseq3") continue;
    const f = fixture(product); setOrigin(f.owner, vec3(1.8, -2.8, 3.8));
    f.pool.clientAt(0).ps.viewangles = vec3(17, 33, 11); f.pool.clientAt(0).ps.powerups.set(Powerup.PW_QUAD, 1); f.settings.quad = 2.5;
    f.fire(weapon); expect(f.world.traces).toHaveLength(endpoints.length);
    f.world.traces.forEach((trace, index) => {
      const expected = endpoints[index]; if (expected === undefined) throw new Error("Missing oracle endpoint");
      expect([trace.start.x, trace.start.y, trace.start.z].map(value => float32ToBits(value) | 0)).toEqual([1095761920,1082130432,1103626240]);
      expect([trace.end.x, trace.end.y, trace.end.z].map(value => float32ToBits(value) | 0)).toEqual([...expected]);
    });
  }
});

test("lightning traces preserve QVM angle bits at the native-constant regression angles", () => {
  // Unchanged g_weapon.c/q_math.c, original q3lcc + vm_game=1, both products.
  // /tmp/quake3-game-angle-migration-HHP9ie/weapon-run.sh captures VECTOR600/601.
  const cases: readonly { readonly angles: Vec3; readonly start: readonly number[]; readonly end: readonly number[] }[] = [
    { angles: vec3(0, 8.26171875, 0), start: [1097859072, 0, 1105723392], end: [1145160166, 1121761071, 1105723392] },
    { angles: vec3(23, -47, 81), start: [1092616192, -1052770304, 1103101952], end: [1140199824, -1006353960, -1014363537] },
  ];
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) for (const value of cases) {
    const f = fixture(product); setOrigin(f.owner, vec3(1.8, -2.8, 3.8));
    f.pool.clientAt(0).ps.viewangles = value.angles; f.fire(Weapon.WP_LIGHTNING);
    expect(f.world.traces).toHaveLength(1);
    const trace = f.world.traces[0]; if (trace === undefined) throw new Error("Lightning trace absent");
    expect([trace.start.x, trace.start.y, trace.start.z].map(value => float32ToBits(value) | 0)).toEqual([...value.start]);
    expect([trace.end.x, trace.end.y, trace.end.z].map(value => float32ToBits(value) | 0)).toEqual([...value.end]);
  }
});

test("rail penetrates four bodies, relinks in order and grants only one impressive award per shot", () => {
  const f = fixture(), targets = [1, 2, 3, 4, 5].map(index => f.player(index, vec3(100 * index, 0, 0)));
  const before = targets.map(entity => f.world.linkState(entity.slot)?.linkcount);
  f.pool.clientAt(0).ps.eFlags = 0x20848; f.fire(Weapon.WP_RAILGUN);
  expect(targets.map(entity => entity.health)).toEqual([0, 0, 0, 0, 100]);
  expect(f.pool.clientAt(0).accuracyHits).toBe(1); expect(f.pool.clientAt(0).accurateCount).toBe(2);
  expect(f.pool.clientAt(0).ps.persistant.get(PersistentIndex.PERS_IMPRESSIVE_COUNT)).toBe(1);
  expect(f.pool.clientAt(0).rewardTime).toBe(3000); expect(f.pool.clientAt(0).ps.eFlags).toBe(0x8000);
  targets.forEach((entity, index) => {
    const previous = before[index]; if (previous === undefined) throw new Error("Target was not linked before firing");
    expect(f.world.linkState(entity.slot)?.linkcount).toBe(index < 4 ? previous + 1 : previous);
  });
  expect(f.events(EntityEvent.EV_RAILTRAIL)).toHaveLength(1);
});

test("rail and lightning preserve their different sky and lethal accuracy behavior", () => {
  const sky = fixture("baseq3", wallMap(0x10)); sky.fire(Weapon.WP_RAILGUN);
  expect(sky.events(EntityEvent.EV_RAILTRAIL)[0]?.s.eventParm).toBe(255);
  sky.fire(Weapon.WP_LIGHTNING); expect(sky.events(EntityEvent.EV_MISSILE_MISS)).toHaveLength(0);
  const f = fixture(), target = f.player(1, vec3(100, 0, 0)); target.health = f.pool.clientAt(1).ps.health = 8;
  f.fire(Weapon.WP_LIGHTNING); expect(target.health).toBe(0); expect(f.pool.clientAt(0).accuracyHits).toBe(0);
  expect(f.events(EntityEvent.EV_MISSILE_HIT)).toHaveLength(1);
});

test("rail stops at solid damageable entities and relinks the current slot lifetime after a death callback reuses it", () => {
  // Source temporary box hulls always report CONTENTS_BODY; stopping needs an actual solid inline brush.
  const wall = wallMap(), empty = emptyMap(), bounds = { min: vec3(100, -1000, -1000), max: vec3(110, 1000, 1000) };
  const solid = fixture("baseq3", { ...wall, leaves: empty.leaves, leafBrushes: [], models: [...empty.models,
    { bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }] });
  const target = solid.pool.spawn(), behind = solid.player(2, vec3(200, 0, 0));
  target.s.eType = EntityType.ET_GENERAL; target.takedamage = true; target.health = 100;
  target.s.modelindex = 1;
  target.r.model = { kind: "inline", index: 1 }; target.r.mins = bounds.min; target.r.maxs = bounds.max;
  target.die = () => { solid.calls.push("solid die"); };
  target.r.contents = 1; solid.world.link(target); const links = solid.world.linkState(target.slot)?.linkcount;
  solid.fire(Weapon.WP_RAILGUN); expect(target.health).toBe(0); expect(behind.health).toBe(100);
  expect(solid.world.linkState(target.slot)?.linkcount).toBe(links);
  const f = fixture(), destructible = f.pool.spawn(); destructible.s.eType = EntityType.ET_GENERAL; destructible.takedamage = true; destructible.health = 50;
  destructible.r.contents = 0x2000000; destructible.r.mins = vec3(-10, -10, -10); destructible.r.maxs = vec3(10, 10, 10);
  setOrigin(destructible, vec3(100, 0, 26)); f.world.link(destructible);
  destructible.die = self => {
    f.pool.free(self); const replacement = f.pool.spawn(); expect(replacement).toBe(self);
    replacement.classname = "replacement"; replacement.r.contents = 0x2000000;
    replacement.r.mins = vec3(-1, -1, -1); replacement.r.maxs = vec3(1, 1, 1); setOrigin(replacement, vec3(0, 500, 0));
  };
  f.pool.clientAt(0).accurateCount = 1; f.fire(Weapon.WP_RAILGUN);
  expect(destructible.classname).toBe("replacement"); expect(f.world.linkState(destructible.slot)?.linkcount).toBe(1);
  expect(f.world.linkState(destructible.slot)?.linked).toBe(true); expect(f.pool.clientAt(0).accurateCount).toBe(0);
});

test("grapple fire-held gating uses real missile hook lifecycle without accuracy tracking", () => {
  const f = fixture(), client = f.pool.clientAt(0); f.fire(Weapon.WP_GRAPPLING_HOOK);
  const hook = client.hook; if (hook === null) throw new Error("Missing hook");
  f.fire(Weapon.WP_GRAPPLING_HOOK); expect(f.pool.numEntities).toBe(65); expect(client.fireHeld).toBe(true); expect(client.accuracyShots).toBe(0);
  f.missiles.hookFree(hook); f.fire(Weapon.WP_GRAPPLING_HOOK); expect(client.hook).toBeNull();
  client.fireHeld = false; f.fire(Weapon.WP_GRAPPLING_HOOK); expect(client.hook).not.toBeNull();
});

test("missionpack nails emit fifteen missiles and share the exact source RNG stream; base ignores TA-only dispatch", () => {
  const f = fixture("missionpack"); f.fire(Weapon.WP_NAILGUN);
  expect(f.pool.numEntities).toBe(79); expect(f.pool.clientAt(0).accuracyShots).toBe(15);
  expect([64, 65, 66, 67].map(number => f.pool.at(number).s.pos.delta)).toEqual([vec3(700, 4, -25), vec3(1911, 38, -20), vec3(981, -9, -6), vec3(1003, 3, -37)]);
  const base = fixture(); base.fire(Weapon.WP_NAILGUN); expect(base.pool.numEntities).toBe(64); expect(base.pool.clientAt(0).accuracyShots).toBe(1);
});

test("missionpack bullets, rail and lightning reflect from real invulnerability spheres and can strike their owner", () => {
  for (const weapon of [Weapon.WP_MACHINEGUN, Weapon.WP_RAILGUN, Weapon.WP_LIGHTNING]) {
    const f = fixture("missionpack"), shield = f.player(1, vec3(100, 0, 26)); f.pool.clientAt(1).invulnerabilityTime = 5000;
    f.fire(weapon); expect(shield.health).toBe(100); expect(f.owner.health).toBeLessThan(100);
    expect(f.events(EntityEvent.EV_INVUL_IMPACT)).toHaveLength(1);
    if (weapon === Weapon.WP_LIGHTNING) expect(f.events(EntityEvent.EV_LIGHTNINGBOLT)).toHaveLength(1);
    if (weapon === Weapon.WP_RAILGUN) expect(f.events(EntityEvent.EV_RAILTRAIL)).toHaveLength(2);
  }
});

test("invulnerability misses pass through oversized client bounds and lightning stops after ten reflections", () => {
  const f = fixture("missionpack"), shield = f.player(1, vec3(100, 0, 0));
  shield.r.mins = vec3(-10, -100, -24); shield.r.maxs = vec3(10, 100, 32); f.world.link(shield);
  f.pool.clientAt(1).invulnerabilityTime = 5000;
  setOrigin(f.owner, vec3(0, 80, 0)); f.pool.clientAt(0).ps.origin = vec3(0, 80, 0); f.world.link(f.owner);
  const victim = f.player(2, vec3(150, 80, 0)); f.fire(Weapon.WP_MACHINEGUN);
  expect(shield.health).toBe(100); expect(victim.health).toBe(93); expect(f.pool.clientAt(0).accuracyHits).toBe(2);
  expect(f.events(EntityEvent.EV_INVUL_IMPACT)).toHaveLength(0); expect(f.world.traces.map(trace => trace.pass)).toEqual([0, 1]);
  const reflected = fixture("missionpack"); reflected.player(1, vec3(100, 0, 0));
  reflected.pool.clientAt(0).ps.viewheight = 0;
  reflected.pool.clientAt(0).invulnerabilityTime = reflected.pool.clientAt(1).invulnerabilityTime = 5000;
  reflected.fire(Weapon.WP_LIGHTNING);
  expect(reflected.world.traces).toHaveLength(10); expect(reflected.events(EntityEvent.EV_INVUL_IMPACT)).toHaveLength(10);
  expect(reflected.events(EntityEvent.EV_LIGHTNINGBOLT)).toHaveLength(9);
  expect(reflected.owner.health).toBe(100); expect(reflected.pool.at(1).health).toBe(100);
});

test("rail retains the already-snapped impact when a solid invulnerable client stops a reflected beam", () => {
  // Original QVM two-impact engine fixture emits rail x bits 1118961664,1093664768,1093664768.
  const wall = wallMap(), empty = emptyMap(), bounds = { min: vec3(-10, -1000, -1000), max: vec3(10, 1000, 1000) };
  const planes = wall.planes.map((plane, index) => index < 2 ? { ...plane, distance: 10 } : plane);
  const f = fixture("missionpack", { ...wall, planes, leaves: empty.leaves, leafBrushes: [], models: [...empty.models,
    { bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }] });
  f.owner.s.modelindex = 1;
  f.owner.r.model = { kind: "inline", index: 1 }; f.owner.r.mins = bounds.min; f.owner.r.maxs = bounds.max;
  f.owner.r.contents = 1; f.world.link(f.owner); f.player(1, vec3(100, 0, 26));
  f.pool.clientAt(0).invulnerabilityTime = f.pool.clientAt(1).invulnerabilityTime = 5000;
  f.fire(Weapon.WP_RAILGUN);
  expect(f.events(EntityEvent.EV_RAILTRAIL).map(event => event.s.pos.base.x)).toEqual([89, 11, 11]);
});

test("gauntlet misses do not read quad cvars and sky contact produces no hit event", () => {
  const f = fixture(), client = f.pool.clientAt(0); let reads = 0;
  client.ps.powerups.set(Powerup.PW_QUAD, 1);
  const weapons = new WeaponRuntime({ ...f.weapons.host, get quadFactor() { reads++; return 3; } });
  expect(weapons.checkGauntletAttack(f.owner)).toBe(false); expect(reads).toBe(0);
  const sky = fixture("baseq3", wallMap(0x10)); setOrigin(sky.owner, vec3(60, 0, 0)); sky.world.link(sky.owner);
  expect(sky.weapons.checkGauntletAttack(sky.owner)).toBe(false); expect(sky.pool.numEntities).toBe(64);
});

test("kamikaze starts at a snapped origin, kills its user and emits a broadcast team sound", () => {
  const f = fixture("missionpack"); f.owner.s.eFlags |= 0x200;
  const explosion = f.weapons.startKamikaze(f.owner);
  expect(f.owner.health).toBe(-999); expect(f.owner.s.eFlags & 0x200).toBe(0);
  expect(explosion.classname).toBe("kamikaze"); expect(explosion.activator).toBe(f.owner); expect(explosion.nextthink).toBe(1100);
  expect(explosion.s.eType).toBe(EntityType.ET_EVENTS + EntityEvent.EV_KAMIKAZE); expect(explosion.freeAfterEvent).toBe(false);
  const sound = f.events(EntityEvent.EV_GLOBAL_TEAM_SOUND)[0]; if (sound === undefined) throw new Error("Missing global sound");
  expect(sound.s.eventParm).toBe(13); expect(sound.r.svFlags & ServerEntityFlags.BROADCAST).not.toBe(0);
});

test("kamikaze timer uses corpse owner, damages through walls, and skips already shocked entities", () => {
  const f = fixture("missionpack", wallMap()); f.world.unlink(0);
  const body = f.pool.spawn(); body.classname = "bodyque"; body.r.ownerNum = 0; setOrigin(body, vec3(0, 0, 0));
  const timer = f.pool.spawn(); timer.activator = body;
  const explosion = f.weapons.startKamikaze(timer), target = f.player(1, vec3(150, 0, 0));
  expect(explosion.activator).toBe(f.owner); expect(f.owner.health).toBe(100);
  f.settings.time = 1100; runThink(explosion, 1100); expect(target.health).toBe(100);
  f.settings.time = 1200; runThink(explosion, 1200); expect(target.health).toBe(100);
  f.settings.time = 1300; runThink(explosion, 1300); expect(target.health).toBe(75); expect(target.kamikazeShockTime).toBe(4300);
  expect(f.pool.clientAt(1).ps.velocity).toEqual(vec3(400, 0, 100));
  f.settings.time = 1400; runThink(explosion, 1400); expect(target.health).toBe(75);
  for (let time = 1500; time <= 3000; time += 100) { f.settings.time = time; runThink(explosion, time); }
  expect(target.health).toBe(-325); expect(explosion.inuse).toBe(false);
});

test("kamikaze earthquake reproduces original QVM RNG, angle shorts and twenty think transitions", () => {
  const f = fixture("missionpack"), client = f.pool.clientAt(0); f.world.unlink(0);
  client.ps.groundEntityNum = ENTITYNUM_WORLD; client.ps.velocity = vec3(1, 2, 3); client.ps.deltaAngles = { x: 5, y: -6, z: 7 };
  const timer = f.pool.spawn(); timer.activator = f.owner; const explosion = f.weapons.startKamikaze(timer);
  const angles: readonly (readonly [number, number])[] = [[65256,65189],[65295,65407],[65744,130875],[130895,131163],
    [131371,196609],[196720,262118],[262215,327652],[327620,327936],[327711,393178],[327915,393320],
    [393426,458584],[458476,458597],[458733,459082],[524122,524344],[524346,589822],[524442,655288],
    [589954,655443],[655065,720886],[655498,720887],[655498,720887]];
  const velocities: readonly (readonly [number, number, number])[] = [[-1050277137,-1027267854,1106808497],
    [1111101036,-1042545196,1110416679],[-1045048832,-1026609275,1109213642]];
  for (let frame = 0; frame < 20; frame++) {
    const expected = angles[frame]; if (expected === undefined) throw new Error("Missing quake fixture");
    f.settings.time = 1100 + frame * 100; runThink(explosion, f.settings.time);
    expect(client.ps.deltaAngles).toEqual({ x: expected[0], y: expected[1], z: 7 });
    expect(explosion.count).toBe(frame === 19 ? 0 : 100 + frame * 100);
    expect(explosion.nextthink).toBe(frame === 19 ? 0 : 1200 + frame * 100); expect(explosion.inuse).toBe(frame !== 19);
    const velocity = velocities[frame];
    if (velocity !== undefined) expect([client.ps.velocity.x, client.ps.velocity.y, client.ps.velocity.z].map(value => float32ToBits(value) | 0)).toEqual([...velocity]);
  }
  expect([client.ps.velocity.x, client.ps.velocity.y, client.ps.velocity.z].map(value => float32ToBits(value) | 0)).toEqual([1135674713,-1043818208,1112615346]);
});

test("accuracy helper excludes dead clients, self, nonclients and teammates in team modes", () => {
  const f = fixture(), target = f.player(1, vec3(100, 0, 0));
  expect(logAccuracyHit(GameType.GT_FFA, target, f.owner)).toBe(true);
  expect(logAccuracyHit(GameType.GT_FFA, f.owner, f.owner)).toBe(false);
  expect(logAccuracyHit(GameType.GT_FFA, f.pool.at(ENTITYNUM_WORLD), f.owner)).toBe(false);
  f.pool.clientAt(1).sess.sessionTeam = Team.TEAM_RED;
  expect(logAccuracyHit(GameType.GT_CTF, target, f.owner)).toBe(false); expect(logAccuracyHit(GameType.GT_FFA, target, f.owner)).toBe(true);
  f.pool.clientAt(1).ps.health = 0; expect(logAccuracyHit(GameType.GT_FFA, target, f.owner)).toBe(false);
});

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retail = await Bun.file(`${dataPath}/baseq3/pak0.pk3`).exists();
test.skipIf(!retail)("hitscan firing reaches the actual retail q3dm1 floor through the server world for both products", async () => {
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    const map = parseBsp(await vfs.read("maps/q3dm1.bsp")), f = fixture(product, map);
    const origin = map.entityRecords.find(entity => entity.get("classname") === "info_player_deathmatch")?.get("origin");
    if (origin === undefined) throw new Error("Missing retail spawn");
    const [x, y, z] = origin.split(/\s+/).map(Number);
    if (x === undefined || y === undefined || z === undefined) throw new Error("Malformed retail spawn");
    setOrigin(f.owner, vec3(x, y, z + 60)); f.pool.clientAt(0).ps.viewangles = vec3(90, 0, 0); f.world.link(f.owner);
    f.fire(Weapon.WP_RAILGUN); expect(f.events(EntityEvent.EV_RAILTRAIL)).toHaveLength(1);
    expect(f.events(EntityEvent.EV_RAILTRAIL)[0]?.s.eventParm).toBe(5);
  }
});
