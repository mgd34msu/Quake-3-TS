import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import type { Bounds, Vec3 } from "../src/core/math.ts";
import { bitsToFloat32, float32ToBits } from "../src/core/numeric.ts";
import { canDamage, checkArmor, damage, DamageFlags, radiusDamage } from "../src/game/combat.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { EntityPool, initGameEntity } from "../src/game/entities.ts";
import { GameFlags, MoverState } from "../src/game/state.ts";
import type { GameClient, GameEntity } from "../src/game/state.ts";
import { ServerWorld } from "../src/server/world.ts";
import { EntityEvent, EntityType, GameType, PersistentIndex, Powerup, Team, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ENTITYNUM_NONE, ENTITYNUM_WORLD, MoveFlags } from "../src/shared/player-state.ts";

function clientOf(entity: GameEntity): GameClient {
  if (entity.client === null) throw new Error("Fixture requires client");
  return entity.client;
}

function setup(product: Product = "baseq3") {
  const bounds: Bounds = { min: vec3(-2048, -2048, -2048), max: vec3(2048, 2048, 2048) };
  const inlineBounds = [
    { min: vec3(-1, -100, -100), max: vec3(1, 100, 100) },
    { min: vec3(-1, -2, -100), max: vec3(1, 2, 100) },
    { min: vec3(-20, -20, -20), max: vec3(20, 20, 20) },
  ];
  const planes = inlineBounds.flatMap(box => [
    { normal: vec3(1, 0, 0), distance: box.max.x }, { normal: vec3(-1, 0, 0), distance: -box.min.x },
    { normal: vec3(0, 1, 0), distance: box.max.y }, { normal: vec3(0, -1, 0), distance: -box.min.y },
    { normal: vec3(0, 0, 1), distance: box.max.z }, { normal: vec3(0, 0, -1), distance: -box.min.z },
  ]);
  const map: BspMap = {
    entities: "", entityRecords: [], shaders: [{ name: "solid", surfaceFlags: 0, contentFlags: 1 }], planes, nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 },
      ...inlineBounds.map((box, index) => ({ bounds: box, firstSurface: 0, surfaceCount: 0, firstBrush: index, brushCount: 1 }))],
    brushes: inlineBounds.map((_box, index) => ({ firstSide: index * 6, sideCount: 6, shader: 0 })),
    brushSides: planes.map((_plane, index) => ({ plane: index, shader: 0 })),
    vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null,
  };
  const pool = new EntityPool({ print: text => { worldPrints.push(text); }, product, maxClients: 2, mapStartTime: 0, time: () => 1000, link: () => {}, unlink: () => {} });
  const worldPrints: string[] = [];
  const world = new ServerWorld(new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" }), bounds, number => pool.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  pool.at(ENTITYNUM_WORLD).s.number = ENTITYNUM_WORLD;
  const target = pool.at(0), attacker = pool.at(1);
  const calls: string[] = [];
  for (const entity of [target, attacker]) {
    initGameEntity(entity);
    entity.s.eType = EntityType.ET_PLAYER;
    entity.health = 100;
    entity.takedamage = true;
    entity.r.mins = vec3(-10, -10, -10);
    entity.r.maxs = vec3(10, 10, 10);
    entity.r.contents = 0x2000000;
    entity.r.ownerNum = ENTITYNUM_NONE;
    const client = clientOf(entity);
    client.ps.health = 100;
    client.ps.stats.set(statSchema(product).maxHealth, 100);
    client.sess.sessionTeam = entity === target ? Team.TEAM_RED : Team.TEAM_BLUE;
    entity.die = (self, source, owner, amount, mod) => calls.push(`die:${self.health}:${client.ps.health}:${source.s.number}:${owner.s.number}:${amount}:${mod}`);
    entity.pain = (_self, _owner, amount) => calls.push(`pain:${amount}`);
  }
  clientOf(target).ps.stats.set(statSchema(product).armor, 50);
  const services = {
    time: 1000, intermissionQueued: 0, gameType: GameType.GT_FFA, friendlyFire: false, knockback: 1000,
    entities: pool, world, debugDamage: null,
    checkHurtCarrier: (self: GameEntity, _owner: GameEntity) => calls.push(`carrier:${self.health}`),
    logAccuracyHit: (self: GameEntity, owner: GameEntity): boolean => {
      calls.push(`accuracy:${self.s.number}:${self.health}`);
      return self.client !== null && owner.client !== null && self !== owner && self.client.ps.health > 0;
    },
  };
  const context: CombatContext = product === "baseq3" ? { ...services, product } : {
    ...services, product, checkObeliskAttack: () => false,
    invulnerabilityEffect: (_target: GameEntity, direction: Vec3, _point: Vec3) => calls.push(`invulnerability:${direction.x}`),
  };
  return { context, target, attacker, calls, pool, world };
}

test("G_Damage mutates its caller direction at the original QVM normalization boundary", () => {
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const { context, target, attacker } = setup(product);
    // Untouched g_combat/q_math via original lcc/q3asm + vm_game=1, VECTOR102.
    const direction = { x: bitsToFloat32(1060804499), y: bitsToFloat32(1048241157), z: bitsToFloat32(-1088181894) };
    damage(context, target, attacker, attacker, direction, vec3(0, 0, 0), 1, 0, 3);
    expect([direction.x, direction.y, direction.z].map(value => float32ToBits(value) | 0)).toEqual([1060804500, 1048241159, -1088181893]);
    const before = clientOf(target).damageFrom.x; direction.x = 0;
    expect(clientOf(target).damageFrom.x).toBe(before);
  }
});

test("damage early returns precede caller normalization but later godmode rejection does not", () => {
  for (const mode of ["nondamageable", "intermission", "noclip", "mover", "invulnerability", "godmode"]) {
    const { context, target, attacker } = setup("missionpack"), direction = { x: 3, y: 4, z: 0 };
    if (mode === "nondamageable") target.takedamage = false;
    if (mode === "noclip") clientOf(target).noclip = true;
    if (mode === "mover") target.s.eType = EntityType.ET_MOVER;
    if (mode === "invulnerability") clientOf(target).invulnerabilityTime = 2000;
    if (mode === "godmode") target.flags = GameFlags.GODMODE;
    damage({ ...context, intermissionQueued: mode === "intermission" ? 1 : 0 }, target, attacker, attacker, direction, vec3(0, 0, 0), 1, 0, 3);
    expect(direction).toEqual(mode === "godmode" ? vec3(0.6, 0.8, 0) : vec3(3, 4, 0));
  }
});

describe("direct damage captured from upstream C", () => {
  // Untouched g_combat.c, bg_misc.c, q_math.c; gcc -O0 --gc-sections.
  // Source dbe4ddb10315479fc00086f08e25d968b4b43c49, native harness in the verification record.
  const expected = [
    [90, 90, 29, 93, 124, 62, 21, 10, 31, 1, 25650, 1, 0, 0, 10, 0],
    [95, 95, 40, 93, 124, 62, 10, 5, 31, 0, 0, 0, 0, 0, 5, 0],
    [100, 100, 50, 93, 124, 62, 0, 0, 0, 0, 0, 0, 16, 0, 0, 0],
    [95, 95, 40, 93, 124, 62, 10, 5, 31, 1, 25650, 1, 16, 0, 5, 62],
    [100, 100, 50, 93, 124, 62, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [-999, -4900, 50, 600, 800, 200, 0, 5000, 200, 1, 25650, 1, 2048, 5000, 0, 0],
    [100, 100, 49, 3, 4, 50, 1, 0, 1, 1, 25650, 1, 0, 0, 0, 0],
    [93, 93, 34, 69, 92, 50, 16, 7, 23, 1, 25650, 1, 0, 0, 7, 0],
    [100, 100, 50, 93, 124, 62, 0, 0, 0, 0, 0, 0, 0, 0, 0, 62],
  ];
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  for (const [scenario, golden] of expected.entries()) test(`${product} native scenario ${scenario}`, () => {
    const { context, target, attacker } = setup(product);
    let ctx = context, owner = attacker, amount = 31, flags = 0, died = 0, pain = 0;
    target.die = (_self, _source, _owner, take) => { died = take; };
    target.pain = (_self, _owner, take) => { pain = take; };
    if (scenario === 1) owner = target;
    if (scenario === 2) target.flags = GameFlags.GODMODE;
    if (scenario === 3) {
      target.flags = GameFlags.GODMODE;
      flags = DamageFlags.NO_PROTECTION;
      clientOf(target).ps.powerups.set(Powerup.PW_BATTLESUIT, 1);
    }
    if (scenario === 4) { ctx = { ...context, gameType: GameType.GT_TEAM }; clientOf(attacker).sess.sessionTeam = Team.TEAM_RED; }
    if (scenario === 5) { amount = 5000; flags = DamageFlags.NO_ARMOR; }
    if (scenario === 6) amount = 1;
    if (scenario === 7) clientOf(attacker).ps.stats.set(statSchema(product).maxHealth, 75);
    if (scenario === 8) { flags = DamageFlags.RADIUS; clientOf(target).ps.powerups.set(Powerup.PW_BATTLESUIT, 1); }
    damage(ctx, target, null, owner, vec3(3, 4, 0), vec3(1, 2, 3), amount, flags, 6);
    const client = clientOf(target), ownerClient = clientOf(owner);
    expect([target.health, client.ps.health, client.ps.stats.get(statSchema(product).armor),
      client.ps.velocity.x, client.ps.velocity.y, client.ps.pmTime, client.damageArmor, client.damageBlood, client.damageKnockback,
      ownerClient.ps.persistant.get(PersistentIndex.PERS_HITS), ownerClient.ps.persistant.get(PersistentIndex.PERS_ATTACKEE_ARMOR),
      client.lastHurtClient, target.flags, died, pain, client.ps.externalEvent & 255]).toEqual(golden);
  });
  }
});

describe("armor, protections and callback ordering", () => {
  test("armor rounds up, caps at inventory, and only NO_ARMOR bypasses it", () => {
    const { target } = setup();
    expect(checkArmor(target, 1, 0)).toBe(1);
    expect(checkArmor(target, 3, DamageFlags.NO_PROTECTION)).toBe(2);
    expect(checkArmor(target, 1000, 0)).toBe(47);
    expect(checkArmor(target, 1000, 0)).toBe(0);
    clientOf(target).ps.stats.set(statSchema("baseq3").armor, 10);
    expect(checkArmor(target, 5, DamageFlags.NO_ARMOR)).toBe(0);
    expect(checkArmor(target, 0, 0)).toBe(0);
  });

  test("queued intermission, noclip, and nondamageable entities cause no feedback", () => {
    for (const kind of ["intermission", "noclip", "nondamageable"]) {
      const { context, target, attacker, calls } = setup();
      clientOf(target).noclip = kind === "noclip";
      target.takedamage = kind !== "nondamageable";
      damage({ ...context, intermissionQueued: kind === "intermission" ? 1 : 0 }, target, null, attacker, vec3(1, 0, 0), null, 100, 0, 6);
      expect(target.health).toBe(100);
      expect(clientOf(target).ps.velocity).toEqual(vec3(0, 0, 0));
      expect(calls).toEqual([]);
    }
  });

  test("environmental damage records world direction; feedback accumulates before pain", () => {
    const { context, target, calls } = setup();
    target.r.currentOrigin = vec3(5, 6, 7);
    const client = clientOf(target);
    client.ps.stats.set(statSchema("baseq3").armor, 0);
    target.pain = () => calls.push(`pain:${target.health}:${client.damageBlood}:${client.lastHurtClient}`);
    damage({ ...context, gameType: GameType.GT_CTF }, target, null, null, null, null, 11, 0, 16);
    damage({ ...context, gameType: GameType.GT_CTF }, target, null, null, null, null, 12, 0, 16);
    expect(calls).toEqual(["carrier:100", "pain:89:11:1022", "carrier:89", "pain:77:23:1022"]);
    expect(client.damageFrom).toEqual(vec3(5, 6, 7));
    expect(client.damageFromWorld).toBe(true);
    expect(client.damageKnockback).toBe(0);
    expect(client.ps.persistant.get(PersistentIndex.PERS_ATTACKER)).toBe(ENTITYNUM_WORLD);
    expect(client.lastHurtMod).toBe(16);
  });

  test("lethal callback sees pre-clamp player health and established enemy/no-knockback", () => {
    const { context, target, attacker } = setup();
    const seen: number[] = [];
    target.die = (self, source, owner, amount, mod) => seen.push(self.health, clientOf(self).ps.health,
      source.s.number, owner.s.number, amount, mod, self.enemy === owner ? 1 : 0, self.flags);
    damage(context, target, null, attacker, null, null, 5000, DamageFlags.NO_ARMOR, 6);
    expect(seen).toEqual([-999, -4900, ENTITYNUM_WORLD, 1, 5000, 6, 1, GameFlags.NO_KNOCKBACK]);
    const second = setup();
    second.target.die = null;
    expect(() => damage(second.context, second.target, null, null, null, null, 5000, 0, 6)).toThrow("no die callback");
  });

  test("movers invoke use only at POS1 and never pass through health damage", () => {
    const { context, target, attacker, calls } = setup();
    target.s.eType = EntityType.ET_MOVER;
    target.use = (_self, source, owner) => calls.push(`use:${source?.s.number}:${owner?.s.number}`);
    damage(context, target, null, attacker, null, null, 100, 0, 6);
    target.moverState = MoverState.ONE_TO_TWO;
    damage(context, target, null, attacker, null, null, 100, 0, 6);
    expect(calls).toEqual(["use:1022:1"]);
    expect(target.health).toBe(100);
  });

  test("existing movement timers survive impulses and knockback flags suppress impulses", () => {
    const { context, target, attacker } = setup();
    const ps = clientOf(target).ps;
    ps.pmTime = 777;
    damage(context, target, null, attacker, vec3(0, 0, 2), null, 5, 0, 6);
    expect(ps.pmTime).toBe(777);
    expect(ps.pmFlags & MoveFlags.TIME_KNOCKBACK).toBe(0);
    expect(ps.velocity).toEqual(vec3(0, 0, 25));
    damage(context, target, null, attacker, vec3(0, 0, 2), null, 5, DamageFlags.NO_KNOCKBACK, 6);
    target.flags |= GameFlags.NO_KNOCKBACK;
    damage(context, target, null, attacker, vec3(0, 0, 2), null, 5, 0, 6);
    expect(ps.velocity).toEqual(vec3(0, 0, 25));
  });

  test("friendly-fire hits decrement feedback; battlesuit blocks falling even without protection", () => {
    const { context, target, attacker } = setup();
    clientOf(attacker).sess.sessionTeam = Team.TEAM_RED;
    damage({ ...context, gameType: GameType.GT_TEAM, friendlyFire: true }, target, null, attacker, null, null, 10, 0, 6);
    expect(clientOf(attacker).ps.persistant.get(PersistentIndex.PERS_HITS)).toBe(-1);
    const health = target.health;
    clientOf(target).ps.powerups.set(Powerup.PW_BATTLESUIT, 1);
    damage(context, target, null, null, null, null, 100, DamageFlags.NO_PROTECTION, 19);
    expect(target.health).toBe(health);
    expect(clientOf(target).ps.externalEvent & 255).toBe(EntityEvent.EV_POWERUP_BATTLESUIT);
  });
});

describe("missionpack damage branches", () => {
  test("invulnerability precedes knockback and protection flags; JUICED alone bypasses it", () => {
    const { context, target, attacker, calls } = setup("missionpack");
    clientOf(target).invulnerabilityTime = 1001;
    damage(context, target, null, attacker, vec3(3, 4, 0), vec3(1, 2, 3), 100, DamageFlags.NO_PROTECTION, 6);
    expect(calls).toEqual(["invulnerability:3"]);
    expect(target.health).toBe(100);
    expect(clientOf(target).ps.velocity).toEqual(vec3(0, 0, 0));
    damage(context, target, null, attacker, null, null, 10, DamageFlags.NO_ARMOR, 27);
    expect(target.health).toBe(90);
    clientOf(target).invulnerabilityTime = 1000;
    damage(context, target, null, attacker, null, null, 10, DamageFlags.NO_ARMOR, 6);
    expect(target.health).toBe(80);
  });

  test("guard divides attacker handicap; doubler is already applied by weapon caller", () => {
    const { context, target, attacker } = setup("missionpack");
    const schema = statSchema("missionpack");
    if (schema.product !== "missionpack") throw new Error("Expected missionpack stats");
    const ps = clientOf(attacker).ps;
    ps.stats.set(schema.maxHealth, 151);
    ps.stats.set(schema.persistentPowerup, 43);
    damage(context, target, null, attacker, null, null, 20, DamageFlags.NO_ARMOR, 6);
    expect(target.health).toBe(85);
    ps.stats.set(schema.maxHealth, 100);
    ps.stats.set(schema.persistentPowerup, 44);
    damage(context, target, null, attacker, null, null, 20, DamageFlags.NO_ARMOR, 6);
    expect(target.health).toBe(65);
  });

  test("team-protection bypass applies only in missionpack; proximity parent teams remain protected", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const { context, target, attacker, pool } = setup(product);
      clientOf(attacker).sess.sessionTeam = Team.TEAM_RED;
      const ctx = { ...context, gameType: GameType.GT_TEAM };
      damage(ctx, target, null, attacker, null, null, 10, DamageFlags.NO_TEAM_PROTECTION | DamageFlags.NO_ARMOR, 6);
      expect(target.health).toBe(product === "baseq3" ? 100 : 90);
      const missile = pool.spawn();
      missile.parent = attacker;
      damage({ ...ctx, friendlyFire: true }, target, missile, attacker, vec3(1, 0, 0), null, 10, DamageFlags.NO_TEAM_PROTECTION, 25);
      expect(target.health).toBe(product === "baseq3" ? 97 : 90);
      if (product === "missionpack") {
        damage(ctx, target, missile, target, vec3(1, 0, 0), null, 10, DamageFlags.NO_TEAM_PROTECTION, 25);
        expect(target.health).toBe(90);
      }
    }
  });

  test("obelisk callback runs before handicap and one-flag carrier hook before health loss", () => {
    const { context, target, attacker, calls } = setup("missionpack");
    if (context.product !== "missionpack") throw new Error("Expected missionpack context");
    damage({ ...context, gameType: GameType.GT_OBELISK, checkObeliskAttack: () => { calls.push("obelisk"); return true; } },
      target, null, attacker, null, null, 100, 0, 6);
    expect(calls).toEqual(["obelisk"]);
    expect(target.health).toBe(100);
    damage({ ...context, gameType: GameType.GT_1FCTF }, target, null, attacker, null, null, 10, 0, 6);
    expect(calls).toEqual(["obelisk", "carrier:100", "pain:3"]);
  });
});

function wall(pool: EntityPool, world: ServerWorld, yExtent: number): GameEntity {
  const obstacle = pool.spawn();
  obstacle.r.currentOrigin = vec3(50, 0, 0);
  obstacle.r.mins = vec3(-1, -yExtent, -100);
  obstacle.r.maxs = vec3(1, yExtent, 100);
  obstacle.r.contents = 1;
  obstacle.s.modelindex = yExtent === 100 ? 1 : 2;
  obstacle.r.model = { kind: "inline", index: yExtent === 100 ? 1 : 2 };
  world.link(obstacle);
  return obstacle;
}

describe("real server collision visibility and splash", () => {
  test("missing spatial bounds reject; old bounds remain usable after unlink", () => {
    const { context, target, world } = setup();
    expect(() => canDamage(context, target, vec3(-50, 0, 0))).toThrow("absolute bounds");
    world.link(target);
    world.unlink(target.s.number);
    expect(canDamage(context, target, vec3(-50, 0, 0))).toBe(true);
  });

  test("a blocking slab triggers five probes in exact source order and fixed z", () => {
    const { context, target, world, pool } = setup();
    target.r.currentOrigin = vec3(100, 0, 0);
    world.link(target);
    wall(pool, world, 100);
    const ends: Vec3[] = [];
    const ctx: CombatContext = { ...context, world: {
      linkState: number => world.linkState(number), areaEntities: bounds => world.areaEntities(bounds),
      trace: query => { ends.push(query.end); expect(query.mask).toBe(1); expect(query.passEntityNum).toBe(ENTITYNUM_NONE); return world.trace(query); },
    } };
    expect(canDamage(ctx, target, vec3(0, 0, 0))).toBe(false);
    expect(ends).toEqual([vec3(100, 0, 0), vec3(115, 15, 0), vec3(115, -15, 0), vec3(85, 15, 0), vec3(85, -15, 0)]);
  });

  test("corner visibility bypasses narrow cover; only center probe accepts a target hit", () => {
    const { context, target, world, pool } = setup();
    target.r.currentOrigin = vec3(100, 0, 0);
    target.r.mins = vec3(-20, -20, -20);
    target.r.maxs = vec3(20, 20, 20);
    world.link(target);
    const cover = wall(pool, world, 2);
    expect(canDamage(context, target, vec3(0, 0, 0))).toBe(true);
    target.r.contents = 1;
    target.s.modelindex = 3;
    target.r.model = { kind: "inline", index: 3 };
    world.link(target);
    expect(canDamage(context, target, vec3(0, 0, 0))).toBe(false);
    world.unlink(cover.s.number);
    expect(canDamage(context, target, vec3(0, 0, 0))).toBe(true);
  });

  test("splash uses padded bbox edge distance, logs accuracy before damage, and raises direction z", () => {
    const { context, target, attacker, world, calls } = setup();
    target.r.currentOrigin = vec3(100, 0, 0);
    world.link(target);
    expect(radiusDamage(context, vec3(0, 0, 0), attacker, 100, 200, null, 7)).toBe(true);
    // Server link bounds begin at x=89: float32(100 * (1 - float32(89/200))) truncates to 55.
    expect(target.health).toBe(82);
    expect(clientOf(target).damageArmor).toBe(37);
    expect(clientOf(target).damageBlood).toBe(18);
    expect(clientOf(target).ps.velocity.z).toBeGreaterThan(0);
    expect(calls).toEqual(["accuracy:0:100", "pain:18"]);
  });

  test("splash ignores requested entity, occluded victims, and exact radius edge", () => {
    const { context, target, attacker, world, pool } = setup();
    target.r.currentOrigin = vec3(100, 0, 0);
    world.link(target);
    expect(radiusDamage(context, vec3(0, 0, 0), attacker, 100, 200, target, 7)).toBe(false);
    expect(radiusDamage(context, vec3(0, 0, 0), attacker, 100, 89, null, 7)).toBe(false);
    wall(pool, world, 100);
    expect(radiusDamage(context, vec3(0, 0, 0), attacker, 100, 200, null, 7)).toBe(false);
    expect(target.health).toBe(100);
  });

  test("splash rounds the falloff subtraction before multiplying damage in both products", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const { context, target, attacker, world } = setup(product);
      target.r.currentOrigin = vec3(80, 0, 0);
      clientOf(target).ps.stats.set(statSchema(product).armor, 0);
      world.link(target);
      // g_combat.c:1180 emits DIVF4, SUBF4, MULF4 in the pinned QVM compiler.
      // A grenade's 100 damage/radius 150 at distance 69 yields 53.999996185302734, then 53.
      expect(radiusDamage(context, vec3(0, 0, 0), attacker, 100, 150, null, 5)).toBe(true);
      expect(target.health).toBe(47);
      expect(clientOf(target).damageBlood).toBe(53);
      expect(clientOf(target).damageKnockback).toBe(53);
    }
  });

  test("radius clamps to one and accuracy still qualifies when battlesuit absorbs damage", () => {
    const { context, target, attacker, world } = setup();
    world.link(target);
    clientOf(target).ps.powerups.set(Powerup.PW_BATTLESUIT, 1);
    expect(radiusDamage(context, vec3(0, 0, 0), attacker, 100, 0, null, 7)).toBe(true);
    expect(target.health).toBe(100);
    expect(clientOf(target).ps.velocity).toEqual(vec3(0, 0, 500));
  });
});
