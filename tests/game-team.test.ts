import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { EntityPool, initGameEntity, runThink } from "../src/game/entities.ts";
import { damage } from "../src/game/combat.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { ItemRegistry, respawnItem, touchItem } from "../src/game/item-lifecycle.ts";
import type { ItemLifecycleContext } from "../src/game/item-lifecycle.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { ConnectionState, GameFlags } from "../src/game/state.ts";
import type { GameClient, GameEntity } from "../src/game/state.ts";
import { FlagStatus, GlobalTeamSound, TeamRuntime, onSameTeam, otherTeam, spawnTeamPoint, teamColorString, teamName } from "../src/game/team.ts";
import type { TeamHost } from "../src/game/team.ts";
import { useTargets } from "../src/game/utilities.ts";
import { ServerWorld } from "../src/server/world.ts";
import { EntityType, GameType, PersistentIndex, Powerup, Team, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { findItem, itemList } from "../src/shared/items.ts";
import { PlayerStateSlots } from "../src/shared/player-state.ts";

const products: readonly Product[] = ["baseq3", "missionpack"];
function clientOf(entity: GameEntity): GameClient {
  if (entity.client === null) throw new Error("Fixture requires a client");
  return entity.client;
}
function setup(product: Product, gameType = GameType.GT_CTF, retailMap: BspMap | null = null) {
  const frame: { time: number; gameType: GameType; visible: boolean; locationHead: GameEntity | null } = { time: 20000, gameType, visible: true, locationHead: null };
  const obelisk = { health: 1000, regenPeriodSeconds: 1, regenAmount: 15, respawnDelaySeconds: 10 };
  const bounds = { min: vec3(-8192, -8192, -8192), max: vec3(8192, 8192, 8192) };
  const floorBounds = { min: vec3(-100, -100, -1), max: vec3(100, 100, 0) };
  const planes = [{ normal: vec3(1, 0, 0), distance: 100 }, { normal: vec3(-1, 0, 0), distance: 100 },
    { normal: vec3(0, 1, 0), distance: 100 }, { normal: vec3(0, -1, 0), distance: 100 },
    { normal: vec3(0, 0, 1), distance: 0 }, { normal: vec3(0, 0, -1), distance: 1 }];
  const map: BspMap = retailMap ?? { entities: "", entityRecords: [], shaders: [{ name: "floor", surfaceFlags: 0, contentFlags: 1 }], planes, nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 },
      { bounds: floorBounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_plane, index) => ({ plane: index, shader: 0 })),
    vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
  const pool = new EntityPool({ print: text => { calls.push(text); }, product, maxClients: 3, mapStartTime: 0, time: () => frame.time,
    link: entity => { world.link(entity); }, unlink: entity => world.unlink(entity.slot) });
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const worldModel = map.models[0];
  if (worldModel === undefined) throw new Error("Fixture requires world model");
  const worldPrints: string[] = [];
  const world = new ServerWorld(collision, worldModel.bounds, number => pool.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  const commands: string[] = [], configs: string[] = [], calls: string[] = [];
  const scores = new PlayerStateSlots(4);
  const itemContext: ItemLifecycleContext = { entities: pool, world, product, get gameType() { return frame.gameType; },
    weaponRespawnSeconds: 5, teamWeaponRespawnSeconds: 30, handicapForClient: () => "100",
    teamPickup: (item, player) => runtime.pickupTeam(item, player),
    useTargets: (entity, activator) => useTargets({ pool, get time() { return frame.time; },
      remapShader: () => { throw new Error("No shader remap in flag fixture"); }, warn: text => calls.push(text) }, entity, activator),
    soundIndex: () => { throw new Error("No flag respawn sound registration"); }, random: new GameRandom(1),
    registry: new ItemRegistry(product), log: text => calls.push(text), warn: text => calls.push(text) };
  const services = { pool, world, get gameType() { return frame.gameType; }, get time() { return frame.time; }, teamScores: scores,
    sortedClients: [0, 1, 2],
    get locationHead() { return frame.locationHead; },
    sendServerCommand: (number: number, text: string) => commands.push(`${number}:${text}`), setConfigstring: (number: number, value: string) => configs.push(`${number}:${value}`),
    warn: (text: string) => calls.push(text), addScore: (entity: GameEntity, _origin: Vec3, score: number) => {
      calls.push(`score:${entity.slot}:${score}`);
      const ps = clientOf(entity).ps;
      ps.persistant.set(PersistentIndex.PERS_SCORE, ps.persistant.get(PersistentIndex.PERS_SCORE) + score);
    }, calculateRanks: () => calls.push("ranks"), respawnItem: (entity: GameEntity) => { calls.push(`respawn:${entity.slot}`); respawnItem(entity, itemContext); },
    inPVS: (first: Vec3, second: Vec3) => frame.visible && collision.clusterVisible(collision.leafCluster(collision.pointLeafnum(first)), collision.leafCluster(collision.pointLeafnum(second))) };
  const host: TeamHost = product === "baseq3" ? { ...services, product, get gameType() { return frame.gameType; }, get time() { return frame.time; }, get locationHead() { return frame.locationHead; } }
    : { ...services, product, obelisk, get gameType() { return frame.gameType; }, get time() { return frame.time; }, get locationHead() { return frame.locationHead; } };
  const runtime = new TeamRuntime(host);
  const player = pool.at(0), ally = pool.at(1), enemy = pool.at(2);
  for (const entity of [player, ally, enemy]) {
    initGameEntity(entity); entity.health = 100;
    const client = clientOf(entity);
    client.ps.clientNum = entity.slot; client.ps.health = 100; client.ps.stats.set(statSchema(product).maxHealth, 100);
    client.sess.sessionTeam = entity === enemy ? Team.TEAM_BLUE : Team.TEAM_RED;
    client.ps.persistant.set(PersistentIndex.PERS_TEAM, client.sess.sessionTeam);
    client.pers.netname = String.fromCharCode(65 + entity.slot);
  }
  function flag(name: string): GameEntity {
    const item = findItem(product, name);
    if (item === null) throw new Error(`Missing fixture flag ${name}`);
    const entity = pool.spawn(); entity.item = item; entity.classname = item.className;
    entity.s.modelindex = itemList(product).indexOf(item); entity.s.eType = EntityType.ET_ITEM;
    entity.r.contents = 0x40000000;
    world.link(entity);
    return entity;
  }
  const red = flag("Red Flag"), blue = flag("Blue Flag");
  return { frame, obelisk, pool, world, host, runtime, player, ally, enemy, red, blue, commands, configs, calls, scores, itemContext, flag };
}

describe("native and QVM flag transitions", () => {
  for (const product of products) test(`${product} captured native pickup/capture sequence and independent scores`, () => {
    const { runtime, player, ally, enemy, red, blue, configs, calls, scores, world } = setup(product);
    runtime.initGame();
    expect(configs).toEqual(["23:0", "23:00"]);
    expect(runtime.pickupTeam(blue, player)).toBe(-1);
    expect(clientOf(player).ps.powerups.get(Powerup.PW_BLUEFLAG)).toBe(2147483647);
    expect(runtime.state.blueStatus).toBe(FlagStatus.TAKEN);
    clientOf(ally).pers.teamState.lastReturnedFlag = 15000;
    expect(runtime.pickupTeam(red, player)).toBe(0);
    const mission = product === "missionpack";
    expect([scores.get(Team.TEAM_RED), clientOf(player).ps.persistant.get(PersistentIndex.PERS_SCORE),
      clientOf(ally).ps.persistant.get(PersistentIndex.PERS_SCORE), clientOf(player).pers.teamState.assists,
      clientOf(ally).ps.persistant.get(PersistentIndex.PERS_ASSIST_COUNT), clientOf(enemy).pers.teamState.lastHurtCarrier])
      .toEqual([1, mission ? 110 : 5, mission ? 35 : 1, 1, 1, -5]);
    expect(clientOf(player).ps.powerups.get(Powerup.PW_BLUEFLAG)).toBe(0);
    expect(clientOf(player).ps.eFlags & 0x800).toBe(0x800);
    expect(clientOf(ally).ps.eFlags & 0x20000).toBe(0x20000);
    expect(player.flags & GameFlags.FORCE_GESTURE).toBe(GameFlags.FORCE_GESTURE);
    expect(calls.slice(-3)).toEqual([`respawn:${red.slot}`, `respawn:${blue.slot}`, "ranks"]);
    expect(world.linkState(red.slot)?.linked).toBe(true);
    expect(runtime.state.lastFlagCapture).toBe(20000);
  });
  test("actual Touch_Item hides picked base and capture resets both with the original lifecycle", () => {
    const { runtime, player, red, blue, itemContext, world } = setup("baseq3");
    runtime.initGame();
    const trace = world.trace({ start: vec3(0, 0, 0), end: vec3(0, 0, 0), shape: { kind: "point" }, passEntityNum: 0, mask: 1 });
    touchItem(blue, player, trace, itemContext);
    expect(blue.r.contents).toBe(0);
    expect(blue.s.eFlags & 0x80).toBe(0x80);
    touchItem(red, player, trace, itemContext);
    expect(blue.r.contents).toBe(0x40000000);
    expect(blue.s.eFlags & 0x80).toBe(0);
    expect(runtime.host.teamScores.get(Team.TEAM_RED)).toBe(1);
  });
  for (const product of products) test(`${product} return deletes all dropped copies and timeout omits announcement`, () => {
    const { runtime, player, flag, calls, commands, blue, enemy, frame } = setup(product);
    runtime.initGame();
    const dropped = flag("Red Flag"), duplicate = flag("Red Flag");
    dropped.flags = duplicate.flags = GameFlags.DROPPED_ITEM;
    runtime.checkDroppedItem(dropped);
    expect(runtime.state.redStatus).toBe(FlagStatus.DROPPED);
    expect(runtime.pickupTeam(dropped, player)).toBe(0);
    expect(dropped.inuse).toBe(false); expect(duplicate.inuse).toBe(false);
    expect(clientOf(player).pers.teamState.flagRecovery).toBe(1);
    expect(calls).toContain(`score:0:${product === "baseq3" ? 1 : 10}`);
    const timeout = flag("Blue Flag"); timeout.flags = GameFlags.DROPPED_ITEM;
    runtime.checkDroppedItem(timeout);
    const before = commands.length;
    runtime.droppedFlagThink(timeout);
    expect(commands.length).toBe(before); expect(timeout.inuse).toBe(false);
    runtime.returnFlag(Team.TEAM_BLUE);
    expect(commands.at(-1)).toBe('-1:print "The BLUE flag has returned!\n"');
    frame.time = 5000;
    runtime.touchEnemyFlag(blue, player, Team.TEAM_BLUE);
    clientOf(enemy).ps.powerups.set(Powerup.PW_REDFLAG, 1);
    runtime.pickupTeam(blue, enemy);
    expect(clientOf(enemy).pers.teamState.assists).toBe(1);
  });
  test("one flag must reach enemy base; cube pickup always removes the item", () => {
    const { runtime, player, red, blue, flag, frame, configs } = setup("missionpack", GameType.GT_1FCTF);
    const neutral = flag("Neutral Flag");
    runtime.initGame(); expect(configs).toEqual(["23:0"]);
    expect(runtime.pickupTeam(neutral, player)).toBe(-1);
    expect(runtime.state.flagStatus).toBe(FlagStatus.TAKEN_RED);
    expect(runtime.pickupTeam(red, player)).toBe(0);
    expect(clientOf(player).ps.powerups.get(Powerup.PW_NEUTRALFLAG)).not.toBe(0);
    runtime.pickupTeam(blue, player);
    expect(runtime.host.teamScores.get(Team.TEAM_RED)).toBe(1);
    expect(runtime.state.flagStatus).toBe(FlagStatus.AT_BASE);
    frame.gameType = GameType.GT_HARVESTER;
    const friendly = flag("Red Cube"), opposing = flag("Blue Cube");
    friendly.spawnflags = Team.TEAM_RED; opposing.spawnflags = Team.TEAM_BLUE;
    runtime.pickupTeam(friendly, player); runtime.pickupTeam(opposing, player);
    expect(clientOf(player).ps.generic1).toBe(1);
    expect(friendly.inuse || opposing.inuse).toBe(false);
    frame.gameType = GameType.GT_OBELISK;
    const unused = flag("Red Cube"); runtime.pickupTeam(unused, player);
    expect(unused.inuse).toBe(false); expect(clientOf(player).ps.generic1).toBe(1);
  });
});

describe("team scores, feedback and frag priorities", () => {
  for (const product of products) test(`${product} take-sound throttle uses the opposite status and strict deadline`, () => {
    const { runtime, pool, red, frame, configs } = setup(product);
    runtime.initGame();
    const state = runtime.state;
    runtime.setFlagStatus(Team.TEAM_BLUE, FlagStatus.TAKEN);
    const count = configs.length;
    runtime.setFlagStatus(Team.TEAM_BLUE, FlagStatus.TAKEN);
    expect(configs.length).toBe(count);
    const before = pool.numEntities;
    runtime.takeFlagSound(red, Team.TEAM_RED);
    expect(pool.numEntities).toBe(before + 1);
    expect(pool.at(before).s.eventParm).toBe(GlobalTeamSound.BLUE_TAKEN);
    frame.time = 29999; runtime.takeFlagSound(red, Team.TEAM_RED);
    expect(pool.numEntities).toBe(before + 1);
    frame.time = 30000; runtime.takeFlagSound(red, Team.TEAM_RED);
    expect(pool.numEntities).toBe(before + 2);
    runtime.initGame();
    expect(runtime.state).toBe(state);
    expect(state.redTakenTime).toBe(0);
    expect(state.blueTakenTime).toBe(0);
  });
  test("score feedback chooses tie, lead, score before mutating scores", () => {
    const { runtime, pool, scores } = setup("baseq3");
    scores.set(Team.TEAM_BLUE, 1);
    const start = pool.numEntities;
    runtime.addTeamScore(vec3(0, 0, 0), Team.TEAM_RED, 1);
    runtime.addTeamScore(vec3(0, 0, 0), Team.TEAM_RED, 1);
    runtime.addTeamScore(vec3(0, 0, 0), Team.TEAM_RED, 1);
    expect([pool.at(start).s.eventParm, pool.at(start + 1).s.eventParm, pool.at(start + 2).s.eventParm])
      .toEqual([GlobalTeamSound.TIED, GlobalTeamSound.RED_TOOK_LEAD, GlobalTeamSound.RED_SCORED]);
    expect(pool.at(start).r.svFlags & 32).toBe(32);
  });
  for (const product of products) test(`${product} carrier frag, danger protection and base defense priority`, () => {
    const { runtime, player, ally, enemy, calls, frame } = setup(product);
    const victim = clientOf(enemy), killer = clientOf(player);
    victim.ps.powerups.set(Powerup.PW_REDFLAG, 1);
    clientOf(ally).pers.teamState.lastHurtCarrier = 999;
    runtime.fragBonuses(enemy, player, player);
    expect(calls).toEqual([`score:0:${product === "baseq3" ? 2 : 20}`]);
    expect(killer.pers.teamState.fragCarrier).toBe(1);
    expect(clientOf(ally).pers.teamState.lastHurtCarrier).toBe(0);
    victim.ps.powerups.set(Powerup.PW_REDFLAG, 0);
    victim.pers.teamState.lastHurtCarrier = 19999;
    killer.ps.powerups.set(Powerup.PW_BLUEFLAG, 1);
    runtime.fragBonuses(enemy, player, player);
    expect(killer.pers.teamState.carrierDefense).toBe(1);
    expect(victim.pers.teamState.lastHurtCarrier).toBe(0);
    runtime.fragBonuses(enemy, player, player);
    expect(killer.pers.teamState.baseDefense).toBe(1);
    frame.visible = false;
    const count = calls.length;
    runtime.fragBonuses(enemy, player, player);
    expect(calls.length).toBe(count);
    runtime.fragBonuses(player, player, player);
    expect(calls.length).toBe(count);
  });
  test("hurt carrier deliberately ignores neutral flag but sees skulls without gametype restriction", () => {
    const { runtime, player, enemy } = setup("missionpack", GameType.GT_1FCTF);
    clientOf(player).ps.powerups.set(Powerup.PW_NEUTRALFLAG, 1);
    runtime.checkHurtCarrier(player, enemy);
    expect(clientOf(enemy).pers.teamState.lastHurtCarrier).toBe(0);
    clientOf(player).ps.generic1 = 1;
    runtime.checkHurtCarrier(player, enemy);
    expect(clientOf(enemy).pers.teamState.lastHurtCarrier).toBe(20000);
  });
  test("skull-carrier score is quadratic and source carrier-defense v1 overwrite is retained", () => {
    const { runtime, player, ally, enemy, frame, red, calls } = setup("missionpack", GameType.GT_HARVESTER);
    clientOf(enemy).ps.generic1 = 3;
    runtime.fragBonuses(enemy, player, player);
    expect(calls).toEqual(["score:0:180"]);
    clientOf(enemy).ps.generic1 = 0; frame.gameType = GameType.GT_CTF;
    red.r.currentOrigin = vec3(0, 0, 0);
    player.r.currentOrigin = vec3(5000, 0, 0); ally.r.currentOrigin = vec3(5010, 0, 0); enemy.r.currentOrigin = vec3(-5000, 0, 0);
    clientOf(ally).ps.powerups.set(Powerup.PW_BLUEFLAG, 1);
    runtime.fragBonuses(enemy, player, player);
    expect(clientOf(player).pers.teamState.carrierDefense).toBe(1);
    expect(calls.at(-1)).toBe("score:0:2");
  });
  test("team helper names and print sanitization preserve source outputs", () => {
    const { runtime, player, ally, commands } = setup("baseq3");
    expect(otherTeam(Team.TEAM_SPECTATOR)).toBe(Team.TEAM_SPECTATOR);
    expect(teamName(Team.TEAM_BLUE)).toBe("BLUE"); expect(teamColorString(Team.TEAM_SPECTATOR)).toBe("^3");
    expect(onSameTeam(GameType.GT_FFA, player, ally)).toBe(false);
    expect(onSameTeam(GameType.GT_TEAM, player, ally)).toBe(true);
    runtime.printMessage(player, 'hello "there"\0hidden');
    expect(commands).toEqual(['0:print "hello \'there\'"']);
    const snapshot = player.s.copy();
    spawnTeamPoint(player);
    expect(player.s).toEqual(snapshot);
    expect(player.inuse).toBe(true);
  });
});

describe("team locations and actual overlay output", () => {
  for (const product of products) test(`${product} ranked prepass retains client-number wire order and skips disabled overlay`, () => {
    const { runtime, host, player, ally, commands } = setup(product);
    const reads: number[] = [];
    for (const [index, clientNum] of [1, 2, 0].entries()) {
      Object.defineProperty(host.sortedClients, index, { get: () => { reads.push(clientNum); return clientNum; } });
    }
    runtime.teamplayInfoMessage(player);
    expect(reads).toEqual([]);
    expect(commands).toEqual([]);
    clientOf(player).pers.teamInfo = true;
    runtime.teamplayInfoMessage(player);
    expect(reads).toEqual([1, 1, 2, 0, 0]);
    expect(commands).toEqual(["0:tinfo 2  0 0 100 0 0 0 1 0 100 0 0 0"]);
    reads.length = 0;
    ally.inuse = false;
    runtime.teamplayInfoMessage(player);
    expect(reads).toEqual([1, 2, 0, 0]);
    expect(commands.at(-1)).toBe("0:tinfo 1  0 0 100 0 0 0");
  });
  for (const product of products) test(`${product} live location chain, distance ties, color mutation and strict update deadline`, () => {
    const { runtime, pool, frame, player, ally, enemy, commands } = setup(product);
    expect(runtime.getLocation(player)).toBeNull();
    const first = pool.spawn(), second = pool.spawn();
    first.message = "first"; first.health = 3; first.r.currentOrigin = vec3(10, 0, 0);
    second.message = "second"; second.health = 7; second.r.currentOrigin = vec3(-10, 0, 0);
    first.nextTrain = second; frame.locationHead = first;
    expect(runtime.getLocation(player)).toBe(second);
    second.count = -2;
    expect(runtime.getLocationMessage(player, 99)).toBe("^0second^7");
    expect(second.count).toBe(0);
    expect(runtime.getLocationMessage(player, 4)).toBe("sec");
    second.count = 99; expect(runtime.getLocationMessage(player, 99)).toBe("^7second^7");
    expect(second.count).toBe(7);
    clientOf(player).pers.connected = clientOf(ally).pers.connected = ConnectionState.CONNECTED;
    clientOf(player).pers.teamInfo = true;
    clientOf(ally).ps.health = -5; clientOf(ally).ps.stats.set(statSchema(product).armor, -3);
    ally.s.powerups = 16;
    clientOf(enemy).pers.connected = ConnectionState.DISCONNECTED;
    runtime.lastTeamLocationTime = 19000;
    runtime.checkTeamStatus(); expect(commands).toEqual([]);
    frame.time = 20001;
    runtime.checkTeamStatus();
    expect(clientOf(player).pers.teamState.location).toBe(7);
    expect(clientOf(enemy).pers.teamState.location).toBe(0);
    expect(commands).toEqual(["0:tinfo 2  0 7 100 0 0 0 1 7 0 0 0 16"]);
    frame.visible = false;
    expect(runtime.getLocationMessage(player, 99)).toBeNull();
    frame.time = 21002; runtime.checkTeamStatus();
    expect(clientOf(player).pers.teamState.location).toBe(0);
  });
});

describe("missionpack obelisk and Harvester lifecycle", () => {
  test("actual combat calls owned pain/death handlers, regen and respawn retain source ordering", () => {
    const { runtime, pool, world, player, frame, obelisk, calls, scores } = setup("missionpack", GameType.GT_OBELISK);
    const model = pool.spawn(); model.s.origin = vec3(100, 0, 20); model.spawnflags = 1;
    runtime.spawnTeamObelisk(model, Team.TEAM_BLUE);
    const physical = pool.at(model.slot + 1);
    expect(physical.die).toBe(runtime.obeliskDie);
    expect(physical.activator).toBe(model);
    expect(physical.r.currentOrigin).toEqual(vec3(100, 0, 20));
    expect(physical.health).toBe(1000);
    const combat: CombatContext = { product: "missionpack", entities: pool, world, get time() { return frame.time; },
      intermissionQueued: 0, gameType: GameType.GT_OBELISK, friendlyFire: false, knockback: 1000, debugDamage: null,
      checkHurtCarrier: (target, attacker) => runtime.checkHurtCarrier(target, attacker),
      checkObeliskAttack: (target, attacker) => runtime.checkObeliskAttack(target, attacker),
      logAccuracyHit: () => { throw new Error("No radius damage in fixture"); },
      invulnerabilityEffect: () => { throw new Error("No invulnerability effect in fixture"); } };
    damage(combat, physical, player, player, vec3(1, 0, 0), vec3(100, 0, 20), 100, 0, 6);
    expect([physical.health, model.s.modelindex2, model.s.frame]).toEqual([900, 229, 1]);
    expect(calls).toEqual(["score:0:10"]);
    expect(physical.s.event & 255).toBe(70);
    frame.time = 21000; runThink(physical, frame.time);
    expect([physical.health, model.s.modelindex2, model.s.frame, physical.nextthink]).toEqual([915, 233, 0, 22000]);
    obelisk.regenAmount = 1000;
    frame.time = 22000; runThink(physical, frame.time);
    expect(physical.health).toBe(1000);
    damage(combat, physical, player, player, null, null, 2000, 0, 6);
    expect(physical.takedamage).toBe(false);
    expect(physical.think).toBe(runtime.obeliskRespawn);
    expect([model.s.modelindex2, model.s.frame, model.s.event & 255]).toEqual([255, 2, 69]);
    expect(calls.slice(-2)).toEqual(["ranks", "score:0:100"]);
    expect(scores.get(Team.TEAM_RED)).toBe(1);
    expect(clientOf(player).ps.persistant.get(PersistentIndex.PERS_CAPTURES)).toBe(1);
    expect(runtime.state.blueObeliskAttackedTime).toBe(0);
    obelisk.health = 1200; obelisk.regenPeriodSeconds = 3;
    frame.time = 32000; runThink(physical, frame.time);
    expect([physical.health, physical.nextthink, model.s.frame, model.s.modelindex2]).toEqual([1200, 35000, 0, 255]);
    expect(physical.takedamage).toBe(true);
  });
  test("attack guard requires exact owned die callback and obeys strict twenty-second sound throttle", () => {
    const { runtime, pool, player, enemy, frame } = setup("missionpack", GameType.GT_OBELISK);
    const physical = runtime.spawnObelisk(vec3(0, 0, 0), Team.TEAM_BLUE, 1);
    const before = pool.numEntities;
    expect(runtime.checkObeliskAttack(physical, enemy)).toBe(true);
    expect(runtime.checkObeliskAttack(physical, player)).toBe(false);
    expect(pool.numEntities).toBe(before);
    frame.time = 20001;
    expect(runtime.checkObeliskAttack(physical, player)).toBe(false);
    expect(pool.at(before).s.eventParm).toBe(GlobalTeamSound.BLUE_OBELISK_ATTACKED);
    frame.time = 40001; runtime.checkObeliskAttack(physical, player);
    expect(pool.numEntities).toBe(before + 1);
    frame.time = 40002; runtime.checkObeliskAttack(physical, player);
    expect(pool.numEntities).toBe(before + 2);
    const impostor = pool.spawn(); impostor.spawnflags = Team.TEAM_RED;
    expect(runtime.checkObeliskAttack(impostor, player)).toBe(false);
    expect(runtime.checkObeliskAttack(physical, impostor)).toBe(false);
  });
  test("Harvester enemy receptacle consumes skulls, including source singular pluralization", () => {
    const { runtime, pool, player, world, calls, commands, scores } = setup("missionpack", GameType.GT_HARVESTER);
    const model = pool.spawn(); model.spawnflags = 1;
    runtime.spawnTeamObelisk(model, Team.TEAM_BLUE);
    const physical = pool.at(model.slot + 1);
    clientOf(player).ps.generic1 = 1;
    const trace = world.trace({ start: vec3(0, 0, 0), end: vec3(0, 0, 0), shape: { kind: "point" }, passEntityNum: 0, mask: 1 });
    if (physical.touch === null) throw new Error("Harvester receptacle requires touch");
    physical.touch(physical, player, trace);
    expect(clientOf(player).ps.generic1).toBe(0);
    expect(scores.get(Team.TEAM_RED)).toBe(1);
    expect(calls).toEqual(["score:0:100", "ranks"]);
    expect(commands).toEqual(['-1:print "A^7 brought in 1 skulls.\n"']);
    const neutralModel = pool.spawn(); neutralModel.spawnflags = 1;
    runtime.spawnNeutralObelisk(neutralModel);
    expect(runtime.neutralObelisk?.spawnflags).toBe(Team.TEAM_FREE);
    expect(runtime.neutralObelisk?.activator).toBeNull();
  });
  test("nonsuspended obelisk lands on a real linked floor and handles startsolid without freeing", () => {
    const { runtime, pool, world, calls } = setup("missionpack", GameType.GT_OBELISK);
    const floor = pool.spawn(); floor.r.contents = 1;
    floor.s.modelindex = 1;
    floor.r.model = { kind: "inline", index: 1 };
    floor.r.mins = vec3(-100, -100, -1); floor.r.maxs = vec3(100, 100, 0);
    world.link(floor);
    const dropped = runtime.spawnObelisk(vec3(0, 0, 100), Team.TEAM_RED, 0);
    expect(dropped.s.groundEntityNum).toBe(floor.slot);
    expect(dropped.r.currentOrigin.z).toBe(0.125);
    expect(dropped.s.origin.z).toBe(101);
    expect(world.linkState(dropped.slot)?.linked).toBe(true);
    const stuck = runtime.spawnObelisk(vec3(0, 0, -1.5), Team.TEAM_BLUE, 0);
    expect(stuck.inuse).toBe(true);
    expect(stuck.s.groundEntityNum).toBe(1023);
    expect(stuck.r.currentOrigin).toEqual(vec3(0, 0, -1.5));
    expect(calls).toContain("SpawnObelisk: noclass startsolid at (0 0 -1)\n");
  });
});

const dataPath = Bun.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
for (const product of products) test.skipIf(!existsSync(join(dataPath, product, "pak0.pk3")))(`${product} retail flag lifecycle and canonical remap sentinel`, async () => {
  const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
  const qvm = await vfs.read("vm/qagame.qvm");
  const predecessors: number[] = [];
  for (let index = 1; index < qvm.length - 4; index++) {
    if (qvm[index] !== 48 || qvm[index + 1] !== 49 || qvm[index + 2] !== 42 || qvm[index + 3] !== 42 || qvm[index + 4] !== 50) continue;
    const previous = qvm[index - 1];
    if (previous === undefined) throw new Error("Matched remap requires preceding byte");
    predecessors.push(previous);
  }
  expect(predecessors).toEqual([0]);
  const name = product === "baseq3" ? "q3ctf1" : "mpteam1";
  const map = parseBsp(await vfs.read(`maps/${name}.bsp`));
  const { runtime, red, blue, player, world, itemContext, scores } = setup(product, GameType.GT_CTF, map);
  for (const entity of [red, blue]) {
    const record = map.entityRecords.find(value => value.get("classname") === entity.classname);
    const text = record?.get("origin");
    if (text === undefined) throw new Error("Retail CTF map requires flag origin");
    const [x, y, z] = text.split(/\s+/).map(Number);
    if (x === undefined || y === undefined || z === undefined) throw new Error("Retail flag origin requires three components");
    entity.s.pos = { ...entity.s.pos, base: vec3(x, y, z) };
    entity.r.currentOrigin = vec3(x, y, z);
    world.link(entity);
    expect(world.linkState(entity.slot)?.linked).toBe(true);
  }
  runtime.initGame();
  const trace = world.trace({ start: blue.r.currentOrigin, end: blue.r.currentOrigin, shape: { kind: "point" }, passEntityNum: 0, mask: 1 });
  touchItem(blue, player, trace, itemContext);
  expect(clientOf(player).ps.powerups.get(Powerup.PW_BLUEFLAG)).toBe(2147483647);
  touchItem(red, player, trace, itemContext);
  expect(scores.get(Team.TEAM_RED)).toBe(1);
  expect(blue.r.contents).toBe(0x40000000);
  expect(world.linkState(blue.slot)?.linked).toBe(true);
});
