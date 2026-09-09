import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { damage } from "../src/game/combat.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { DeathRuntime } from "../src/game/death.ts";
import type { DeathHost } from "../src/game/death.ts";
import { EntityPool, initGameEntity, runThink, setOrigin } from "../src/game/entities.ts";
import { MissileRuntime } from "../src/game/missile.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { ConnectionState, GameFlags } from "../src/game/state.ts";
import type { GameClient, GameEntity } from "../src/game/state.ts";
import { FlagStatus, TeamRuntime } from "../src/game/team.ts";
import type { TeamHost } from "../src/game/team.ts";
import { ServerWorld } from "../src/server/world.ts";
import { EntityEvent, EntityType, GameType, MissionpackStatIndex, MoveType, PersistentIndex, Powerup, Team, Weapon, WeaponState, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ServerEntityFlags } from "../src/shared/entity-shared.ts";
import { findItemForWeapon } from "../src/shared/items.ts";
import { ENTITYNUM_WORLD, MoveFlags, PlayerStateSlots } from "../src/shared/player-state.ts";

function emptyMap(contents = 0): BspMap {
  const bounds = { min: vec3(-10000, -10000, -10000), max: vec3(10000, 10000, 10000) };
  const planes = [
    { normal: vec3(1, 0, 0), distance: 10000 }, { normal: vec3(-1, 0, 0), distance: 10000 },
    { normal: vec3(0, 1, 0), distance: 10000 }, { normal: vec3(0, -1, 0), distance: 10000 },
    { normal: vec3(0, 0, 1), distance: 10000 }, { normal: vec3(0, 0, -1), distance: 10000 },
  ];
  return { entities: "", entityRecords: [], shaders: [{ name: "fixture", surfaceFlags: 0, contentFlags: contents }], planes, nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    leafSurfaces: [], leafBrushes: [0], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_, plane) => ({ plane, shader: 0 })),
    vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}

function clientOf(entity: GameEntity): GameClient {
  if (entity.client === null) throw new Error("Fixture requires client");
  return entity.client;
}

function setup(product: Product = "baseq3", map = emptyMap()) {
  const frame = { time: 10000, gameType: GameType.GT_FFA, warmupTime: 0, intermissionTime: 0, blood: true };
  const calls: string[] = [], logs: string[] = [], returns: Team[] = [], scoreboard: number[] = [];
  const pool = new EntityPool({ print: text => { worldPrints.push(text); }, product, maxClients: 4, mapStartTime: 0, time: () => frame.time,
    link: entity => { calls.push(`link:${entity.slot}`); world.link(entity); }, unlink: entity => { calls.push(`unlink:${entity.slot}`); world.unlink(entity.slot); } });
  const worldPrints: string[] = [];
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" }), world = new ServerWorld(collision, collision.modelBounds(0), number => pool.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  const random = new GameRandom(), teamScores = new PlayerStateSlots(4);
  const services = { get time() { return frame.time; }, intermissionQueued: 0, get gameType() { return frame.gameType; },
    friendlyFire: true, knockback: 1000, entities: pool, world, debugDamage: null,
    checkHurtCarrier: () => { calls.push("hurtCarrier"); }, logAccuracyHit: () => true };
  const combat: CombatContext = product === "baseq3" ? { ...services, product } : { ...services, product,
    checkObeliskAttack: () => false, invulnerabilityEffect: () => { throw new Error("Unexpected invulnerability"); } };
  const missiles = combat.product === "baseq3" ? new MissileRuntime({ combat, world, previousTime: 9900, missionpack: null }) :
    new MissileRuntime({ combat, world, previousTime: 9900, missionpack: { random, proxMineTimeout: 30000,
      soundIndex: () => 1, invulnerabilityImpact: () => ({ kind: "miss" }) } });
  const state: { obelisk: GameEntity | null; cubeTimeout: number } = { obelisk: null, cubeTimeout: 30 };
  const common = { pool, world, random, teamScores, missiles, frame: () => frame,
    items: { touchItem: () => { throw new Error("Unexpected pickup during death"); }, droppedFlagThink: () => { calls.push("flagExpire"); },
      checkDroppedTeamItem: (entity: GameEntity) => { calls.push(`checkFlag:${entity.slot}`); } },
    calculateRanks: () => { calls.push("ranks"); }, sendScoreboard: (entity: GameEntity) => { scoreboard.push(entity.slot); calls.push(`scoreboard:${entity.slot}`); },
    log: (message: string) => { logs.push(message); calls.push("log"); },
    teamFragBonuses: () => { calls.push("bonuses"); }, returnFlag: (team: Team) => { returns.push(team); calls.push(`return:${team}`); } };
  const host: DeathHost = product === "baseq3" ? { ...common, product } : { ...common, product,
    neutralObelisk: () => state.obelisk, cubeTimeoutSeconds: () => state.cubeTimeout,
    startKamikaze: entity => { calls.push(`kamikaze:${entity.slot}:${entity.activator?.slot}`); } };
  const runtime = new DeathRuntime(host);
  for (let index = 0; index < 4; index++) {
    const entity = pool.at(index), client = clientOf(entity); initGameEntity(entity);
    entity.classname = "player"; entity.health = 100; entity.takedamage = true; entity.die = runtime.playerDie;
    client.pers.connected = ConnectionState.CONNECTED; client.pers.netname = `p${index}`;
    client.pers.maxHealth = 100; client.ps.stats.set(statSchema(product).maxHealth, 100);
    client.ps.clientNum = index; client.sess.sessionTeam = index === 0 ? Team.TEAM_RED : Team.TEAM_BLUE;
    client.ps.persistant.set(PersistentIndex.PERS_TEAM, client.sess.sessionTeam);
  }
  const victim = pool.at(0), attacker = pool.at(1), client = clientOf(victim), killer = clientOf(attacker);
  clientOf(pool.at(2)).sess.sessionTeam = Team.TEAM_SPECTATOR;
  clientOf(pool.at(2)).sess.spectatorClient = 0;
  clientOf(pool.at(3)).sess.sessionTeam = Team.TEAM_SPECTATOR;
  clientOf(pool.at(3)).pers.connected = ConnectionState.CONNECTING;
  victim.health = -10; victim.s.weapon = Weapon.WP_ROCKET_LAUNCHER; client.ps.ammo.set(Weapon.WP_ROCKET_LAUNCHER, 3);
  client.ps.powerups.set(Powerup.PW_QUAD, 12499); client.ps.powerups.set(Powerup.PW_REGEN, 10001);
  setOrigin(victim, vec3(10, 20, 30)); victim.s.angles = vec3(20, 123.75, 40);
  victim.r.mins = vec3(-15, -15, -24); victim.r.maxs = vec3(15, 15, 32);
  setOrigin(attacker, vec3(10, 120, 30));
  function drops(): GameEntity[] { return Array.from({ length: pool.numEntities - 64 }, (_, index) => pool.at(index + 64)).filter(entity => entity.item !== null); }
  return { product, frame, calls, logs, returns, scoreboard, pool, world, random, teamScores, combat, missiles, state, host, runtime, victim, attacker, client, killer, drops };
}

describe("native player_die reference", () => {
  // Unchanged g_combat.c at dbe4ddb10315479fc00086f08e25d968b4b43c49,
  // recording engine/team/drop services. Native ordinary angle inputs agree with QVM.
  // bash /tmp/quake3-death-reference-pvQnN3/run-native.sh
  // The ffa row and drop ordering also match full unchanged g_combat.c executing
  // in the original QVM interpreter for both products: run-qvm.sh baseq3|missionpack.
  const goldens: readonly (readonly [string, readonly number[]])[] = [
    ["ffa", [3,-10,1,0,1,64,1,0,12000,10000,2,90,11700,128,57,0,67108864,1,0]],
    ["team", [3,-10,1,0,-1,0,0,0,0,0,0,90,11700,128,57,0,67108864,1,0]],
    ["excellent", [3,-10,1,0,1,8,1,1,12000,10000,2,90,11700,128,57,0,67108864,1,0]],
    ["boundary", [3,-10,1,0,1,64,1,0,12000,10000,2,90,11700,128,57,0,67108864,1,0]],
    ["bloodless", [3,-39,1,0,1,64,1,0,12000,10000,2,90,11700,128,57,0,67108864,1,0]],
    ["nodrop", [3,-39,1,0,1,64,1,0,12000,10000,2,90,11700,128,57,0,67108864,1,4]],
    ["suicide", [3,-10,1,-1,0,0,0,0,0,0,0,123,11700,0,64,10,0,0,4]],
    ["world", [3,-10,1,-1,0,0,0,0,0,0,0,123,11700,128,57,0,67108864,1,0]],
    ["grapple", [3,-10,1,0,1,0,0,0,0,10000,0,90,11700,128,57,0,67108864,1,0]],
    ["warmup", [3,-10,1,0,0,64,1,0,12000,10000,2,90,11700,128,57,0,67108864,1,0]],
  ];
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    for (const [mode, expected] of goldens) test(`${product} ${mode} state, drops and scoreboard`, () => {
      const f = setup(product, emptyMap(mode === "nodrop" || mode === "suicide" ? 0x80000000 : 0));
      let attacker: GameEntity | null = f.attacker, method = 2;
      if (mode === "team") { f.frame.gameType = GameType.GT_TEAM; f.killer.sess.sessionTeam = Team.TEAM_RED; f.killer.ps.persistant.set(PersistentIndex.PERS_TEAM, Team.TEAM_RED); }
      if (mode === "excellent") f.killer.lastKillTime = 7001;
      if (mode === "boundary") f.killer.lastKillTime = 7000;
      if (mode === "bloodless") { f.frame.blood = false; f.victim.health = -50; }
      if (mode === "nodrop") { f.victim.health = -50; f.client.ps.powerups.set(Powerup.PW_BLUEFLAG, 99999); }
      if (mode === "suicide") { attacker = f.victim; method = 20; f.frame.blood = false; f.client.ps.powerups.set(Powerup.PW_BLUEFLAG, 99999); }
      if (mode === "world") { attacker = null; method = -1; }
      if (mode === "grapple") method = product === "baseq3" ? 23 : 28;
      if (mode === "warmup") f.frame.warmupTime = 1;
      f.runtime.playerDie(f.victim, attacker, attacker, 50, method);
      const persistent = f.client.ps.persistant, killer = f.killer.ps.persistant;
      expect([f.client.ps.pmType, f.victim.health, persistent.get(PersistentIndex.PERS_KILLED), persistent.get(PersistentIndex.PERS_SCORE),
        killer.get(PersistentIndex.PERS_SCORE), f.killer.ps.eFlags, killer.get(PersistentIndex.PERS_GAUNTLET_FRAG_COUNT), killer.get(PersistentIndex.PERS_EXCELLENT_COUNT),
        f.killer.rewardTime, f.killer.lastKillTime, persistent.get(PersistentIndex.PERS_PLAYEREVENTS), f.client.ps.stats.get(statSchema(product).deadYaw),
        f.client.respawnTime, f.client.ps.legsAnim, f.client.ps.externalEvent & ~0x300, f.victim.s.eType, f.victim.r.contents, Number(f.victim.takedamage),
        f.returns.reduce((mask, team) => mask | (1 << team), 0)]).toEqual([...expected]);
      const dropNames = f.drops().map(entity => [entity.classname, entity.count]);
      expect(dropNames).toEqual(mode === "suicide" || mode === "nodrop" ? [] : mode === "team" ? [["weapon_rocketlauncher",0]] :
        [["weapon_rocketlauncher",0],["item_quad",2],["item_regen",1]]);
      expect(f.scoreboard).toEqual([0,2]); expect(f.world.linkState(0)?.linked).toBe(true);
      expect(f.client.ps.viewangles).toEqual(vec3(0,123.75,0)); expect(f.victim.r.maxs.z).toBe(-8);
      expect(f.client.ps.powerups.copy()).toEqual(new Int32Array(16));
      expect(f.teamScores.get(Team.TEAM_RED)).toBe(mode === "team" ? -1 : 0);
      expect(f.calls.filter(call => call === "ranks").length).toBe(mode === "warmup" ? 0 : 1);
      const obituary = f.pool.at(64);
      expect(obituary.s.eType).toBe(EntityType.ET_EVENTS + EntityEvent.EV_OBITUARY);
      expect(obituary.r.svFlags).toBe(ServerEntityFlags.BROADCAST); expect(obituary.s.eventParm).toBe(method);
      expect(obituary.s.otherEntityNum2).toBe(mode === "world" ? ENTITYNUM_WORLD : mode === "suicide" ? 0 : 1);
      if (mode === "world") expect(f.logs).toEqual(["Kill: 1022 0 -1: <world> killed p0 by <bad obituary>\n"]);
      if (mode === "grapple") expect(f.logs).toEqual([`Kill: 1 0 ${method}: p1 killed p0 by MOD_GRAPPLE\n`]);
    });
  }
});

describe("death boundary and scoring", () => {
  test("source phase order exposes old weapon and powerups until scoreboards finish", () => {
    const f = setup(), phases: string[] = [];
    f.host.log = () => {
      phases.push("log"); expect(f.client.ps.pmType).toBe(MoveType.PM_DEAD);
      expect(f.client.ps.persistant.get(PersistentIndex.PERS_KILLED)).toBe(0);
    };
    f.host.calculateRanks = () => {
      phases.push("ranks"); expect(f.client.ps.persistant.get(PersistentIndex.PERS_KILLED)).toBe(1);
      expect(f.killer.ps.persistant.get(PersistentIndex.PERS_SCORE)).toBe(1);
      expect(f.killer.ps.eFlags).toBe(0);
    };
    f.host.teamFragBonuses = (self, inflictor, attacker) => {
      phases.push("bonuses"); expect(self).toBe(f.victim); expect(inflictor).toBe(f.attacker); expect(attacker).toBe(f.attacker);
      expect(f.killer.ps.eFlags).toBe(0x40); expect(f.drops()).toHaveLength(0);
    };
    f.host.sendScoreboard = entity => {
      phases.push(`scoreboard:${entity.slot}`); expect(f.drops()).toHaveLength(3);
      expect(f.victim.s.weapon).toBe(Weapon.WP_ROCKET_LAUNCHER);
      expect(f.client.ps.powerups.get(Powerup.PW_QUAD)).toBe(12499);
      expect(f.victim.r.maxs.z).toBe(32);
    };
    f.runtime.playerDie(f.victim, f.attacker, f.attacker, 1, 2);
    expect(phases).toEqual(["log", "ranks", "bonuses", "scoreboard:0", "scoreboard:2"]);
    expect(f.victim.s.weapon).toBe(Weapon.WP_NONE); expect(f.client.ps.powerups.get(Powerup.PW_QUAD)).toBe(0);
  });

  test("actual QVM LookAtKiller yaw fixtures and nullable fallback leave view angles unchanged", () => {
    // Full original g_combat.c in vm_game=1, /tmp/quake3-death-reference-pvQnN3/qvm-*.log.
    const inputs = [vec3(1,2,3), vec3(-1,2,3), vec3(0,0,0), vec3(1,-0.00001,3), vec3(12345,67890,0)];
    const expected = [63,116,0,359,79];
    for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
      const f = setup(product); setOrigin(f.victim, vec3(0,0,0));
      for (const [index, input] of inputs.entries()) {
        const yaw = expected[index]; if (yaw === undefined) throw new Error("Missing QVM yaw fixture");
        setOrigin(f.attacker, input); f.runtime.lookAtKiller(f.victim, null, f.attacker);
        expect(f.client.ps.stats.get(statSchema(product).deadYaw)).toBe(yaw);
        expect(f.victim.s.angles).toEqual(vec3(20,123.75,40));
      }
      f.runtime.lookAtKiller(f.victim, f.attacker, f.victim);
      expect(f.client.ps.stats.get(statSchema(product).deadYaw)).toBe(79);
      f.runtime.lookAtKiller(f.victim, null, null);
      expect(f.client.ps.stats.get(statSchema(product).deadYaw)).toBe(123);
      f.victim.s.angles = vec3(0,1e20,0); f.runtime.lookAtKiller(f.victim,null,null);
      expect(f.client.ps.stats.get(statSchema(product).deadYaw)).toBe(-2147483648);
    }
  });

  test("early exits do not score, unlink hooks, emit events or change animation sequence", () => {
    const f = setup(); f.frame.intermissionTime = 1;
    f.runtime.playerDie(f.victim, null, null, 1, 0); expect(f.calls).toEqual([]);
    f.frame.intermissionTime = 0; f.client.ps.pmType = MoveType.PM_DEAD;
    f.runtime.playerDie(f.victim, null, null, 1, 0); expect(f.calls).toEqual([]);
    f.client.ps.pmType = MoveType.PM_NORMAL; f.runtime.playerDie(f.victim, null, null, 1, 0);
    expect(f.client.ps.externalEvent & ~0x300).toBe(EntityEvent.EV_DEATH1);
  });

  test("score plums target one client, signed totals wrap, warmup and nonclients do nothing", () => {
    const f = setup(); f.frame.gameType = GameType.GT_TEAM;
    f.client.ps.persistant.set(PersistentIndex.PERS_SCORE, 2147483647); f.teamScores.set(Team.TEAM_RED, 2147483647);
    f.runtime.addScore(f.victim, vec3(1.9,-2.9,3.9),1);
    expect(f.client.ps.persistant.get(PersistentIndex.PERS_SCORE)).toBe(-2147483648);
    expect(f.teamScores.get(Team.TEAM_RED)).toBe(-2147483648);
    const plum = f.pool.at(64); expect(plum.s.origin).toEqual(vec3(0,0,0)); expect(plum.s.pos.base).toEqual(vec3(1,-2,3));
    expect(plum.r.singleClient).toBe(0); expect(plum.r.svFlags).toBe(ServerEntityFlags.SINGLECLIENT);
    expect(plum.s.otherEntityNum).toBe(0); expect(plum.s.time).toBe(1);
    f.frame.warmupTime = -1; f.runtime.addScore(f.victim,vec3(0,0,0),3);
    f.frame.warmupTime = 0; f.runtime.addScore(f.pool.at(ENTITYNUM_WORLD),vec3(0,0,0),3);
    expect(f.pool.numEntities).toBe(65); expect(f.calls.filter(call => call === "ranks")).toHaveLength(1);
    expect(() => new DeathRuntime({ ...f.host, teamScores: new PlayerStateSlots(3) })).toThrow("four");
  });

  test("normal animations cycle per instance; gib deaths do not advance and corpse damage follows blood setting", () => {
    const f = setup();
    for (const expected of [57,58,59,57]) {
      f.client.ps.pmType = MoveType.PM_NORMAL; f.victim.health = -1;
      f.runtime.playerDie(f.victim,null,null,1,0);
      expect(f.client.ps.externalEvent & ~0x300).toBe(expected); expect(f.victim.die).toBe(f.runtime.bodyDie);
      f.victim.health = -40; f.frame.blood = false; f.runtime.bodyDie(f.victim,f.attacker,f.attacker,1,0);
      expect(f.victim.health).toBe(-39); expect(f.victim.takedamage).toBe(true);
      f.victim.health = -40; f.frame.blood = true; f.runtime.bodyDie(f.victim,f.attacker,f.attacker,1,0);
      expect(f.victim.s.eType).toBe(EntityType.ET_INVISIBLE); expect(f.victim.takedamage).toBe(false);
    }
    const other = setup(); other.runtime.playerDie(other.victim,null,null,1,0);
    expect(other.client.ps.externalEvent & ~0x300).toBe(57);
  });

  test("actual G_Damage dispatches through bound playerDie and actual missile hook cleanup", () => {
    const f = setup(); f.victim.health = 20; f.victim.s.eType = EntityType.ET_PLAYER;
    const hook = f.pool.spawn(); hook.parent = f.victim; f.client.hook = hook; f.client.ps.pmFlags |= MoveFlags.GRAPPLE_PULL;
    damage(f.combat,f.victim,f.attacker,f.attacker,null,null,30,0,3);
    expect(f.client.ps.pmType).toBe(MoveType.PM_DEAD); expect(f.client.hook).toBeNull(); expect(hook.inuse).toBe(false);
    expect(f.client.ps.pmFlags & MoveFlags.GRAPPLE_PULL).toBe(0);
    expect(f.killer.ps.persistant.get(PersistentIndex.PERS_SCORE)).toBe(1);
    expect(f.calls.indexOf(`unlink:${hook.slot}`)).toBeLessThan(f.calls.indexOf("log"));
  });
});

describe("source item and missionpack death rules", () => {
  test("actual TeamRuntime carrier bonus and dropped-flag services compose with the same death score storage", () => {
    for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
      const f = setup(product); f.frame.gameType = GameType.GT_CTF;
      const services = { pool: f.pool, world: f.world, gameType: f.frame.gameType, time: f.frame.time,
        teamScores: f.teamScores, locationHead: null,
        sendServerCommand: (_client: number, text: string) => { f.calls.push(text); },
        setConfigstring: (_index: number, text: string) => { f.calls.push(`flags:${text}`); },
        warn: (text: string) => { f.calls.push(text); },
        addScore: (entity: GameEntity, origin: Vec3, score: number) => { death.addScore(entity,origin,score); },
        calculateRanks: () => { f.calls.push("ranks"); },
        respawnItem: () => { throw new Error("No flag base in this carrier-drop fixture"); }, inPVS: () => true };
      const teamHost: TeamHost = product === "baseq3" ? { ...services, product,
        get sortedClients(): readonly number[] { throw new Error("No team overlay ranking in this carrier-drop fixture"); } } : { ...services, product,
        get sortedClients(): readonly number[] { throw new Error("No team overlay ranking in this carrier-drop fixture"); },
        obelisk: { health: 2500, regenPeriodSeconds: 1, regenAmount: 15, respawnDelaySeconds: 10 } };
      const team = new TeamRuntime(teamHost);
      const death = new DeathRuntime({ ...f.host,
        teamFragBonuses: (target,inflictor,attacker) => { team.fragBonuses(target,inflictor,attacker); },
        returnFlag: flag => { team.returnFlag(flag); }, items: { touchItem: f.host.items.touchItem,
          droppedFlagThink: entity => { team.droppedFlagThink(entity); },
          checkDroppedTeamItem: entity => { team.checkDroppedItem(entity); } } });
      team.initGame(); f.client.ps.powerups.set(Powerup.PW_BLUEFLAG,99999);
      death.playerDie(f.victim,f.attacker,f.attacker,1,3);
      expect(f.killer.ps.persistant.get(PersistentIndex.PERS_SCORE)).toBe(product === "baseq3" ? 3 : 21);
      expect(f.killer.pers.teamState.fragCarrier).toBe(1);
      expect(team.state.blueStatus).toBe(FlagStatus.DROPPED);
      expect(f.drops().find(entity => entity.classname === "team_CTF_blueflag")?.count).toBe(89);
      expect(team.host.teamScores).toBe(death.host.teamScores);
      expect(f.teamScores.copy()).toEqual(new Int32Array(4)); // CTF frags change player score, not captures.
    }
  });

  test("dropping weapon switch, ownership and ammo checks preserve the source machinegun special case", () => {
    for (const weapon of [Weapon.WP_MACHINEGUN,Weapon.WP_GRAPPLING_HOOK,Weapon.WP_GAUNTLET]) {
      const f = setup(); f.victim.s.weapon = weapon; f.client.ps.powerups.set(Powerup.PW_QUAD,0); f.client.ps.powerups.set(Powerup.PW_REGEN,0);
      f.client.ps.weaponState = WeaponState.WEAPON_DROPPING; f.client.pers.cmd.weapon = Weapon.WP_ROCKET_LAUNCHER;
      f.client.ps.stats.set(statSchema(f.product).weapons,1 << Weapon.WP_ROCKET_LAUNCHER);
      f.runtime.tossClientItems(f.victim); expect(f.drops()).toHaveLength(weapon === Weapon.WP_GAUNTLET ? 0 : 1);
    }
    const f = setup(); f.frame.gameType = GameType.GT_TEAM; f.victim.s.weapon = Weapon.WP_MACHINEGUN;
    f.client.ps.weaponState = WeaponState.WEAPON_DROPPING; f.client.pers.cmd.weapon = Weapon.WP_ROCKET_LAUNCHER;
    f.runtime.tossClientItems(f.victim); expect(f.drops()).toHaveLength(0);
    f.victim.s.weapon = Weapon.WP_ROCKET_LAUNCHER; f.client.ps.ammo.set(Weapon.WP_ROCKET_LAUNCHER,0);
    f.runtime.tossClientItems(f.victim); expect(f.drops()).toHaveLength(0);
    f.client.ps.ammo.set(Weapon.WP_ROCKET_LAUNCHER,-1); f.runtime.tossClientItems(f.victim);
    expect(f.drops()[0]?.item).toBe(findItemForWeapon("baseq3",Weapon.WP_ROCKET_LAUNCHER));
  });

  test("almost capture skips dropped and hidden bases, uses strict 200 units, and preserves source null fault", () => {
    for (const distance of [199,200]) {
      const f = setup(); f.frame.gameType = GameType.GT_CTF;
      f.client.ps.origin = vec3(distance,0,0); f.client.ps.powerups.set(Powerup.PW_BLUEFLAG,99999);
      const dropped = f.pool.spawn(); dropped.classname = "team_CTF_redflag"; dropped.flags = GameFlags.DROPPED_ITEM;
      const base = f.pool.spawn(); base.classname = "team_CTF_redflag";
      f.runtime.playerDie(f.victim,f.attacker,f.attacker,1,3);
      expect(f.client.ps.persistant.get(PersistentIndex.PERS_PLAYEREVENTS)).toBe(distance < 200 ? 4 : 0);
      expect(f.killer.ps.persistant.get(PersistentIndex.PERS_PLAYEREVENTS)).toBe(distance < 200 ? 4 : 0);
    }
    const f = setup(); f.client.ps.powerups.set(Powerup.PW_NEUTRALFLAG,99999);
    const base = f.pool.spawn(); base.classname = "team_CTF_blueflag";
    expect(() => f.runtime.playerDie(f.victim,null,null,1,0)).toThrow("null attacker");
    expect(f.client.ps.persistant.get(PersistentIndex.PERS_PLAYEREVENTS)).toBe(4);
    const hidden = setup(); hidden.client.ps.powerups.set(Powerup.PW_NEUTRALFLAG,99999);
    const hiddenBase = hidden.pool.spawn(); hiddenBase.classname = "team_CTF_blueflag"; hiddenBase.r.svFlags = ServerEntityFlags.NOCLIENT;
    hidden.runtime.playerDie(hidden.victim,null,null,1,3);
    expect(hidden.client.ps.persistant.get(PersistentIndex.PERS_PLAYEREVENTS)).toBe(0);
  });

  test("almost cube score runs in both source products and self-kill toggles the same reward twice", () => {
    for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
      const f = setup(product); f.client.ps.generic1 = 3;
      const goal = f.pool.spawn(); goal.classname = "team_blueobelisk";
      f.runtime.playerDie(f.victim,f.attacker,f.attacker,1,3);
      expect(f.client.ps.persistant.get(PersistentIndex.PERS_PLAYEREVENTS)).toBe(4);
      expect(f.killer.ps.persistant.get(PersistentIndex.PERS_PLAYEREVENTS)).toBe(4);
      const suicide = setup(product); suicide.client.ps.generic1 = 3;
      const suicideGoal = suicide.pool.spawn(); suicideGoal.classname = "team_blueobelisk";
      suicide.runtime.playerDie(suicide.victim,suicide.victim,suicide.victim,1,20);
      expect(suicide.client.ps.persistant.get(PersistentIndex.PERS_PLAYEREVENTS)).toBe(0);
    }
  });

  test("persistent powerups return even in NODROP; proximity timer and kamikaze ordering remain live", () => {
    const f = setup("missionpack",emptyMap(0x80000000));
    const powerup = f.pool.spawn(); powerup.r.svFlags = ServerEntityFlags.NOCLIENT; powerup.s.eFlags = 0x80;
    f.client.persistantPowerup = powerup; f.client.ps.stats.set(MissionpackStatIndex.STAT_PERSISTANT_POWERUP,32);
    const mine = f.pool.spawn(); f.victim.activator = mine; f.client.ps.eFlags = 2; f.victim.s.eFlags = 0x200;
    f.runtime.playerDie(f.victim,f.attacker,f.attacker,1,3);
    expect(f.client.persistantPowerup).toBeNull(); expect(powerup.r.contents).toBe(0x40000000);
    expect(powerup.r.svFlags).toBe(0); expect(powerup.s.eFlags).toBe(0); expect(f.world.linkState(powerup.slot)?.linked).toBe(true);
    expect(f.client.ps.eFlags & 2).toBe(0); expect(mine.nextthink).toBe(10000);
    runThink(mine,10000); expect(mine.inuse).toBe(false);
    const timer = Array.from({ length: f.pool.numEntities }, (_, index) => f.pool.at(index)).find(entity => entity.classname === "kamikaze timer");
    if (timer === undefined) throw new Error("Missing kamikaze timer");
    expect(timer.activator).toBe(f.victim); expect(timer.nextthink).toBe(15000); expect(timer.r.svFlags).toBe(ServerEntityFlags.NOCLIENT);
    expect(timer.r.currentOrigin).toEqual(vec3(0,0,0)); expect(timer.s.pos.base).toEqual(f.victim.s.pos.base);
    f.frame.time = 15000; runThink(timer,15000);
    expect(f.calls).toContain(`kamikaze:${timer.slot}:0`); expect(timer.inuse).toBe(false);
  });

  test("gib removes only the first matching kamikaze timer, even in baseq3", () => {
    const f = setup(); f.victim.s.eFlags = 0x200;
    const first = f.pool.spawn(), second = f.pool.spawn();
    for (const timer of [first,second]) { timer.classname = "kamikaze timer"; timer.activator = f.victim; }
    f.runtime.gibEntity(f.victim,7); expect(first.inuse).toBe(false); expect(second.inuse).toBe(true);
    expect(f.client.ps.externalEventParm).toBe(7);
  });

  test("Harvester clears carried cubes before free-slot test, launches one cube with inclusive RNG lift", () => {
    const f = setup("missionpack"); f.client.ps.generic1 = 99;
    f.runtime.tossClientCubes(f.victim); expect(f.client.ps.generic1).toBe(0); expect(f.drops()).toHaveLength(0);
    const released = f.pool.spawn(); f.pool.free(released); f.frame.time = 10800; f.random.reset(12790);
    const obelisk = f.pool.spawn(); setOrigin(obelisk,vec3(4,5,6)); f.state.obelisk = obelisk;
    const spare = f.pool.spawn(); f.pool.free(spare);
    f.runtime.tossClientCubes(f.victim);
    const cube = f.drops()[0]; if (cube === undefined) throw new Error("Missing cube");
    expect(cube.classname).toBe("item_redcube"); expect(cube.s.pos.base).toEqual(vec3(4,5,50));
    // Actual QVM TossClientCubes bit halves are [17174,0], [0,0], [17274,0].
    expect(cube.s.pos.delta).toEqual(vec3(150,0,250)); expect(cube.spawnflags).toBe(Team.TEAM_RED);
    expect(cube.nextthink).toBe(40800); runThink(cube,40800); expect(cube.inuse).toBe(false);
  });
});

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
  test.skipIf(!existsSync(`${dataPath}/${product}/pak0.pk3`))(`${product} real damage and death link a corpse and dropped items in retail BSP`, async () => {
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    const map = parseBsp(await vfs.read("maps/q3dm1.bsp"));
    const f = setup(product,map); setOrigin(f.victim,vec3(0,-128,48)); f.victim.health = 20;
    damage(f.combat,f.victim,f.attacker,f.attacker,null,null,30,0,3);
    expect(f.client.ps.pmType).toBe(MoveType.PM_DEAD); expect(f.world.linkState(0)?.linked).toBe(true);
    for (const dropped of f.drops()) expect(f.world.linkState(dropped.slot)?.linked).toBe(true);
    expect(f.drops()).toHaveLength(3);
  });
}
