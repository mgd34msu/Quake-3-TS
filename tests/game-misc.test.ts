import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import type { Bounds } from "../src/core/math.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { EntityPool, initGameEntity, runThink } from "../src/game/entities.ts";
import { killBox, locateCamera, spawnPortalCamera, spawnPortalSurface, teleportPlayer } from "../src/game/misc.ts";
import type { PortalContext } from "../src/game/misc.ts";
import { GameFlags } from "../src/game/state.ts";
import type { GameClient, GameEntity } from "../src/game/state.ts";
import { ServerWorld } from "../src/server/world.ts";
import type { LinkState } from "../src/server/world.ts";
import { EntityEvent, EntityType, GameType, MoveType, Powerup, Team, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import type { SharedEntity } from "../src/shared/entity-shared.ts";
import { MoveFlags } from "../src/shared/player-state.ts";

const products: readonly Product[] = ["baseq3", "missionpack"];
const bounds: Bounds = { min: vec3(-2048, -2048, -2048), max: vec3(2048, 2048, 2048) };
function emptyMap(): BspMap {
  return { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}
function clientOf(entity: GameEntity): GameClient {
  if (entity.client === null) throw new Error("Fixture requires client");
  return entity.client;
}
class ObservedWorld extends ServerWorld {
  readonly calls: string[] = [];
  override link(entity: SharedEntity): LinkState {
    this.calls.push(`link:${entity.s.number}:${entity.s.eType}:${entity.r.svFlags}`);
    return super.link(entity);
  }
  override unlink(number: number): void {
    this.calls.push(`unlink:${number}`);
    super.unlink(number);
  }
}
function setup(product: Product, map = emptyMap()) {
  const frame = { time: 1000 };
  const pool = new EntityPool({ print: text => { worldPrints.push(text); }, product, maxClients: 3, mapStartTime: 0, time: () => frame.time,
    link: entity => { world.link(entity); }, unlink: entity => world.unlink(entity.slot) });
  const model = map.models[0];
  if (model === undefined) throw new Error("Fixture requires world model");
  const worldPrints: string[] = [];
  const world = new ObservedWorld(new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" }), model.bounds, number => pool.get(number), {
    loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); },
  });
  const deaths: number[] = [];
  const player = pool.at(0), victim = pool.at(1), second = pool.at(2);
  for (const entity of [player, victim, second]) {
    initGameEntity(entity);
    entity.health = 100;
    entity.takedamage = true;
    entity.s.eType = EntityType.ET_PLAYER;
    entity.s.clientNum = entity.slot;
    entity.r.mins = vec3(-15, -15, -24);
    entity.r.maxs = vec3(15, 15, 32);
    entity.r.contents = 0x2000000;
    const client = clientOf(entity);
    client.ps.clientNum = entity.slot;
    client.ps.health = 100;
    client.ps.stats.set(statSchema(product).maxHealth, 100);
    client.sess.sessionTeam = Team.TEAM_RED;
    entity.die = (self, inflictor, attacker, amount, method) => {
      expect(inflictor).toBe(player);
      expect(attacker).toBe(player);
      expect(amount).toBeGreaterThan(0);
      expect(method).toBe(18);
      deaths.push(self.slot);
      world.calls.push(`die:${self.slot}:${world.linkState(player.slot)?.linked}:${clientOf(player).ps.pmTime}:${player.s.pos.base.x}`);
    };
  }
  const services = { get time() { return frame.time; }, intermissionQueued: 0, gameType: GameType.GT_TEAM,
    friendlyFire: false, knockback: 1000, entities: pool, world, debugDamage: null,
    checkHurtCarrier: () => { world.calls.push("carrier"); }, logAccuracyHit: () => { throw new Error("No radius accuracy service expected"); } };
  const combat: CombatContext = product === "baseq3" ? { ...services, get time() { return frame.time; }, product } : { ...services, get time() { return frame.time; }, product,
    checkObeliskAttack: () => { throw new Error("Not an obelisk match"); },
    invulnerabilityEffect: () => { throw new Error("Directionless telefrag has no invulnerability effect"); } };
  const portal: PortalContext = { pool, world, get time() { return frame.time; }, randomInt: () => 0,
    warn: text => world.calls.push(`warn:${text}`) };
  return { frame, pool, world, combat, portal, player, victim, second, deaths };
}

describe("killbox source contacts and damage", () => {
  for (const product of products) test(`${product} kills all linked client contacts, including nondamageable and protected contacts`, () => {
    const { combat, player, victim, second, pool, world, deaths } = setup(product);
    clientOf(player).ps.origin = vec3(100, 0, 0);
    player.r.currentOrigin = vec3(-100, 0, 0);
    victim.r.currentOrigin = vec3(100, 0, 0);
    second.r.currentOrigin = vec3(131, 0, 0);
    victim.flags |= GameFlags.GODMODE;
    clientOf(victim).ps.powerups.set(Powerup.PW_BATTLESUIT, 2000);
    clientOf(victim).ps.stats.set(statSchema(product).armor, 200);
    for (const entity of [victim, second]) world.link(entity);
    const nonclient = pool.spawn();
    nonclient.takedamage = true; nonclient.health = 100; nonclient.r.currentOrigin = vec3(100, 0, 0);
    nonclient.die = () => { throw new Error("Source skips non-client contacts"); };
    world.link(nonclient);
    expect(killBox(combat, player)).toBeUndefined();
    expect(deaths).toEqual([2, 1]);
    expect(victim.health).toBe(-999);
    expect(clientOf(victim).ps.health).toBe(-49700);
    expect(clientOf(victim).ps.stats.get(statSchema(product).armor)).toBe(0);
    expect(nonclient.health).toBe(100);
    expect(player.health).toBe(100);
  });
  test("source does not add a self exclusion, and missionpack invulnerability still blocks NO_PROTECTION", () => {
    const { combat, player, victim, second, world, deaths } = setup("missionpack");
    clientOf(victim).invulnerabilityTime = 1001;
    second.takedamage = false;
    for (const entity of [player, victim, second]) world.link(entity);
    killBox(combat, player);
    expect(deaths).toEqual([0]);
    expect(victim.health).toBe(100);
    expect(second.health).toBe(100);
  });
});

describe("teleport source ordering and publication", () => {
  // Native g_misc/g_utils/g_combat/g_client/bg_misc/q_math source fixture:
  // /tmp/quake3-misc-reference-RjcHar, source dbe4ddb10315479fc00086f08e25d968b4b43c49.
  for (const product of products) test(`${product} events precede unlink, telefrag precedes snapshot, precise origin relinks`, () => {
    const { combat, player, victim, world, pool } = setup(product);
    const client = clientOf(player);
    client.ps.origin = vec3(-10.75, 20.5, -30.25);
    client.ps.pmFlags = MoveFlags.RESPAWNED;
    client.pers.cmd.angles = { x: 12, y: 34, z: 56 };
    client.ps.addEvent(EntityEvent.EV_JUMP, 7);
    player.s.pos = { ...player.s.pos, base: vec3(-77, 0, 0) };
    player.r.currentOrigin = client.ps.origin;
    victim.r.currentOrigin = vec3(100.75, -200.5, 301.25);
    world.link(player); world.link(victim); world.calls.length = 0;
    teleportPlayer({ combat, world }, player, vec3(100.75, -200.5, 300.25), vec3(0, 0, 0));
    expect(world.calls).toEqual(["link:64:56:0", "unlink:64", "link:65:55:0", "unlink:65", "unlink:0",
      "die:1:false:160:-77", "link:0:1:0", "unlink:0"]);
    expect(pool.at(64).s.pos.base).toEqual(vec3(-10, 20, -30));
    expect(pool.at(65).s.pos.base).toEqual(vec3(100, -200, 300));
    expect(pool.at(64).s.clientNum).toBe(0);
    expect(pool.at(65).freeAfterEvent).toBe(true);
    expect(client.ps.origin).toEqual(vec3(100.75, -200.5, 301.25));
    expect(client.ps.velocity).toEqual(vec3(400, 0, -0));
    expect(client.ps.pmTime).toBe(160);
    expect(client.ps.pmFlags).toBe(MoveFlags.RESPAWNED | MoveFlags.TIME_KNOCKBACK);
    expect(client.ps.eFlags).toBe(4);
    expect(client.ps.deltaAngles).toEqual({ x: -12, y: -34, z: -56 });
    expect(player.s.pos.base).toEqual(vec3(100, -200, 301));
    expect(player.r.currentOrigin).toEqual(client.ps.origin);
    expect(player.r.currentOrigin).not.toBe(client.ps.origin);
    expect(client.ps.entityEventSequence).toBe(1);
    expect(world.linkState(0)?.linked).toBe(true);
    teleportPlayer({ combat, world }, player, vec3(-100, 0, 0), vec3(0, 0, 0));
    expect(client.ps.eFlags).toBe(0);
  });
  for (const product of products) test(`${product} spectators change velocity and angles without events, kills or relink`, () => {
    const { combat, world, player, victim, pool } = setup(product);
    const client = clientOf(player);
    client.sess.sessionTeam = Team.TEAM_SPECTATOR;
    client.ps.pmType = MoveType.PM_SPECTATOR;
    world.link(player); world.link(victim); world.calls.length = 0;
    teleportPlayer({ combat, world }, player, vec3(0.25, 0.5, -1.75), vec3(0, 90, 0));
    expect(world.calls).toEqual(["unlink:0"]);
    expect(pool.numEntities).toBe(64);
    expect(victim.health).toBe(100);
    expect(client.ps.origin.z).toBe(-0.75);
    expect(client.ps.velocity.y).toBe(400);
    // q3lcc bytecode evaluated by the reference engine with vm_game 1.
    expect(new DataView(new Float32Array([client.ps.velocity.x]).buffer).getUint32(0, true)).toBe(46994 * 65536 + 43980);
    expect(new DataView(new Float32Array([client.ps.velocity.z]).buffer).getUint32(0, true)).toBe(0x80000000);
    expect(player.s.eType).toBe(EntityType.ET_INVISIBLE);
    expect(player.s.angles).toEqual(vec3(0, 90, 0));
    expect(client.ps.deltaAngles.y).toBe(16384);
    expect(world.linkState(0)?.linked).toBe(false);
  });
});

describe("portal surface and camera source handlers", () => {
  for (const product of products) test(`${product} camera roll matches QVM float32 and signed truncation fixtures`, () => {
    const { pool, world } = setup(product);
    const camera = pool.spawn();
    const cases = [[-90, -64], [0, 0], [90, 64], [359.99, 255], [720, 512], [123456.78, 87791], [-1e20, -2147483648], [1e20, -2147483648]];
    for (const entry of cases) {
      const [roll, expected] = entry;
      if (roll === undefined || expected === undefined) throw new Error("Fixture requires roll and packed value");
      spawnPortalCamera(world, camera, roll);
      expect(camera.s.clientNum).toBe(expected);
    }
  });
  for (const product of products) test(`${product} mirror links before setting portal flags and copies independent origin`, () => {
    const { portal, pool, world } = setup(product);
    const surface = pool.spawn();
    surface.s.origin = vec3(2, 3, 4); surface.r.svFlags = 8;
    spawnPortalSurface(portal, surface);
    expect(world.calls).toEqual(["link:64:0:8", "unlink:64"]);
    expect(surface.r.svFlags).toBe(64);
    expect(surface.s.eType).toBe(EntityType.ET_PORTAL);
    expect(surface.s.origin2).toEqual(surface.s.origin);
    expect(surface.s.origin2).not.toBe(surface.s.origin);
    expect(surface.think).toBeNull();
  });
  test("deferred target resolution uses live time, rotation precedence, target direction and packed roll", () => {
    const { portal, pool, world, frame } = setup("missionpack");
    const surface = pool.spawn(), camera = pool.spawn(), aim = pool.spawn();
    surface.target = "camera"; camera.targetname = "camera"; camera.target = "aim"; aim.targetname = "aim";
    camera.s.origin = vec3(5, 6, 7); aim.s.origin = vec3(5, 6, 17);
    camera.spawnflags = 7;
    spawnPortalCamera(world, camera, -90);
    expect(camera.s.clientNum).toBe(-64);
    frame.time = 1500;
    spawnPortalSurface(portal, surface);
    expect(surface.nextthink).toBe(1600);
    runThink(surface, 1599);
    expect(surface.r.ownerNum).not.toBe(camera.slot);
    runThink(surface, 1600);
    expect([surface.r.ownerNum, surface.s.frame, surface.s.powerups, surface.s.clientNum, surface.s.eventParm]).toEqual([65, 25, 0, -64, 5]);
    expect(surface.s.origin2).toEqual(vec3(5, 6, 7));
    expect(surface.nextthink).toBe(0);
    camera.spawnflags = 2; locateCamera(portal, surface);
    expect([surface.s.frame, surface.s.powerups]).toEqual([75, 1]);
  });
  test("no camera target uses source movedir and clears its angles; missing owner frees the surface", () => {
    const { portal, pool, world } = setup("baseq3");
    const surface = pool.spawn(), camera = pool.spawn();
    surface.target = "camera"; camera.targetname = "camera"; camera.s.angles = vec3(0, -2, 0);
    surface.s.frame = 91;
    locateCamera(portal, surface);
    expect(camera.s.angles).toEqual(vec3(0, 0, 0));
    expect(surface.s.eventParm).toBe(84);
    expect(surface.s.frame).toBe(91);
    expect(world.calls).toContain("warn:G_PickTarget called with NULL targetname\n");
    surface.target = "missing";
    locateCamera(portal, surface);
    expect(surface.inuse).toBe(false);
    expect(surface.classname).toBe("freed");
    expect(world.calls).toContain("warn:Couldn't find target for misc_partal_surface\n");
  });
});

const dataPath = Bun.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
for (const product of products) test.skipIf(!existsSync(join(dataPath, product, "pak0.pk3")))(`${product} teleport and telefrag publish inside retail BSP collision world`, async () => {
  const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
  const mapName = product === "baseq3" ? "q3dm1" : "mpteam1";
  const map = parseBsp(await vfs.read(`maps/${mapName}.bsp`));
  const spawn = map.entityRecords.find(record => record.get("classname") === "info_player_deathmatch");
  const originText = spawn?.get("origin");
  if (originText === undefined) throw new Error("Retail fixture requires deathmatch spawn");
  const values = originText.split(/\s+/).map(Number);
  const [x, y, z] = values;
  if (x === undefined || y === undefined || z === undefined) throw new Error("Retail spawn origin must contain three numbers");
  const { combat, world, player, victim } = setup(product, map);
  victim.r.currentOrigin = vec3(x, y, z + 1);
  world.link(victim);
  teleportPlayer({ combat, world }, player, vec3(x, y, z), vec3(0, 0, 0));
  expect(victim.health).toBe(-999);
  expect(world.linkState(0)?.linked).toBe(true);
  expect(world.linkState(0)?.clusters.length).toBeGreaterThan(0);
  expect(world.areaEntities({ min: vec3(x - 1, y - 1, z), max: vec3(x + 1, y + 1, z + 2) })).toContain(0);
});
