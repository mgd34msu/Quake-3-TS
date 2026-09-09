import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { clientEvents } from "../src/game/client-events.ts";
import type { ClientEventsContext } from "../src/game/client-events.ts";
import type { ClientEffectsContext } from "../src/game/client-effects.ts";
import { ClientSpawnRuntime } from "../src/game/client-spawn.ts";
import { ClientThinkRuntime } from "../src/game/client-think.ts";
import type { ClientThinkHost } from "../src/game/client-think.ts";
import { MovementDiagnostics } from "../src/shared/movement.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { DeathRuntime } from "../src/game/death.ts";
import { EntityPool, initGameEntity, runThink, setOrigin } from "../src/game/entities.ts";
import type { DropItemContext } from "../src/game/item-motion.ts";
import { killBox } from "../src/game/misc.ts";
import { MissileRuntime } from "../src/game/missile.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { PersonalPortalRuntime } from "../src/game/personal-portal.ts";
import { ConnectionState, GameFlags } from "../src/game/state.ts";
import type { GameEntity } from "../src/game/state.ts";
import { TeamRuntime } from "../src/game/team.ts";
import type { TeamHost } from "../src/game/team.ts";
import { ConfigStringRegistry } from "../src/game/utilities.ts";
import { invulnerabilityEffect, WeaponRuntime } from "../src/game/weapon.ts";
import { ServerWorld } from "../src/server/world.ts";
import { EntityEvent, EntityType, GameType, MoveType, Powerup, Team, Weapon, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { CommandButtons, ENTITYNUM_NONE, ENTITYNUM_WORLD, PlayerStateSlots } from "../src/shared/player-state.ts";

function emptyMap(): BspMap {
  const bounds = { min: vec3(-4096,-4096,-4096), max: vec3(4096,4096,4096) };
  return { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}

function setup(product: Product = "baseq3") {
  const settings = { time: 1000, gameType: GameType.GT_FFA, dmflags: 0 }, calls: string[] = [];
  const pool = new EntityPool({ print: text => { worldPrints.push(text); }, product, maxClients: 2, mapStartTime: 0, time: () => settings.time,
    link: entity => { world.link(entity); }, unlink: entity => { world.unlink(entity.slot); } });
  const worldPrints: string[] = [];
  const collision = new CollisionWorld(emptyMap(), { kind: "unaccounted" }, { kind: "disabled" }), world = new ServerWorld(collision, collision.modelBounds(0), number => pool.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  pool.at(ENTITYNUM_WORLD).s.number = ENTITYNUM_WORLD;
  const random = new GameRandom(), teamScores = new PlayerStateSlots(4);
  const combatServices = { get time() { return settings.time; }, get gameType() { return settings.gameType; },
    intermissionQueued: 0, friendlyFire: true, knockback: 1000, entities: pool, world, debugDamage: null,
    checkHurtCarrier: (target: GameEntity, attacker: GameEntity) => { team.checkHurtCarrier(target,attacker); }, logAccuracyHit: () => true };
  const combat: CombatContext = product === "baseq3" ? { ...combatServices, product,
    get time() { return settings.time; }, get gameType() { return settings.gameType; } } : { ...combatServices, product,
    get time() { return settings.time; }, get gameType() { return settings.gameType; }, checkObeliskAttack: () => false,
    invulnerabilityEffect: (target,direction,point) => { invulnerabilityEffect(pool,target,direction,point); } };
  const missiles = combat.product === "baseq3" ? new MissileRuntime({ combat, world, previousTime: 900, missionpack: null }) :
    new MissileRuntime({ combat, world, previousTime: 900, missionpack: { random, proxMineTimeout: 30000,
      soundIndex: () => 1, invulnerabilityImpact: (target,direction,point) => invulnerabilityEffect(pool,target,direction,point) } });
  const weapons = new WeaponRuntime({ missiles, random, quadFactor: 3 });
  const strings = Array.from({ length: 1024 }, () => "");
  const models = new ConfigStringRegistry({ get: index => { const value = strings[index]; if (value === undefined) throw new Error("Configstring index"); return value; },
    set: (index,value) => { strings[index] = value; } });
  const teamServices = { pool, world, teamScores, get gameType() { return settings.gameType; }, get time() { return settings.time; }, locationHead: null,
    sendServerCommand: (_client: number,text: string) => { calls.push(text); }, setConfigstring: models.store.set, warn: (text: string) => { calls.push(text); },
    addScore: (entity: GameEntity,origin: Vec3,score: number) => { death.addScore(entity,origin,score); }, calculateRanks: () => { calls.push("ranks"); },
    respawnItem: () => { throw new Error("No map-item respawn expected"); }, inPVS: () => true };
  const teamHost: TeamHost = product === "baseq3" ? { ...teamServices, product,
    get sortedClients(): readonly number[] { throw new Error("No team overlay ranking in this combat fixture"); },
    get gameType() { return settings.gameType; }, get time() { return settings.time; } } : { ...teamServices, product,
    get sortedClients(): readonly number[] { throw new Error("No team overlay ranking in this combat fixture"); },
    get gameType() { return settings.gameType; }, get time() { return settings.time; },
    obelisk: { health: 2500, regenPeriodSeconds: 1, regenAmount: 15, respawnDelaySeconds: 10 } };
  const team = new TeamRuntime(teamHost);
  const items = { touchItem: () => { throw new Error("Unexpected item pickup"); },
    droppedFlagThink: (entity: GameEntity) => { team.droppedFlagThink(entity); }, checkDroppedTeamItem: (entity: GameEntity) => { team.checkDroppedItem(entity); } };
  const drops: DropItemContext = { ...items, entities: pool, product, get time() { return settings.time; }, get gameType() { return settings.gameType; }, random: () => random.random() };
  const deathServices = { pool, world, random, missiles, items, teamScores,
    frame: () => ({ ...settings, warmupTime: 0, intermissionTime: 0, blood: true }), calculateRanks: teamServices.calculateRanks,
    sendScoreboard: (entity: GameEntity) => { calls.push(`scoreboard:${entity.slot}`); }, log: (text: string) => { calls.push(text); },
    teamFragBonuses: (target: GameEntity,inflictor: GameEntity | null,attacker: GameEntity | null) => { team.fragBonuses(target,inflictor,attacker); },
    returnFlag: (flag: Team) => { team.returnFlag(flag); } };
  const death = new DeathRuntime(product === "baseq3" ? { ...deathServices, product } : { ...deathServices, product,
    neutralObelisk: () => team.neutralObelisk, cubeTimeoutSeconds: () => 30, startKamikaze: entity => { weapons.startKamikaze(entity); } });
  const effects: ClientEffectsContext = { combat, intermissionTime: 0, smoothClients: false, frySound: 0,
    randomInt: () => random.rand(), soundIndex: path => models.soundIndex(path), sound: () => { calls.push("sound"); },
    spectatorEndFrame: () => { throw new Error("No spectator end frame expected"); } };
  const movementDiagnostics = new MovementDiagnostics(text => { calls.push(text); });
  const thinkHost: ClientThinkHost = { pool, world, movementDiagnostics, effects, frame: () => ({ ...settings, intermissionTime: 0, intermissionQueued: 0 }),
    settings: () => ({ synchronousClients: false, pmoveFixed: false, pmoveMsec: 8, debugMove: 0, gravity: 800, speed: 320, dmflags: settings.dmflags,
      smoothClients: false, forceRespawnSeconds: 0, singlePlayer: false }), setPmoveMsec: () => { throw new Error("Unexpected msec clamp"); },
    intermissionThink: () => { throw new Error("No intermission expected"); }, spectatorThink: () => { throw new Error("No spectator movement expected"); },
    checkInactivity: () => true, freeHook: entity => { missiles.hookFree(entity); }, checkGauntletAttack: entity => weapons.checkGauntletAttack(entity),
    clientEvents: (entity,old) => { clientEvents(context,entity,old); }, respawn: entity => { spawns.respawn(entity); },
    botTestAas: origin => { calls.push(`testAas:${origin.x},${origin.y},${origin.z}`); },
    appendConsoleCommand: () => { throw new Error("No console command expected"); }, isDoorTrigger: () => false };
  const think = new ClientThinkRuntime(thinkHost);
  const spawns = new ClientSpawnRuntime({ pool, world, think, random,
    frame: () => ({ ...settings, inactivitySeconds: 60, intermissionTime: 0 }), userCommand: () => pool.clientAt(0).pers.cmd,
    handicap: () => "80", findIntermissionPoint: () => { throw new Error("No intermission expected"); }, moveToIntermission: () => { throw new Error("No intermission expected"); },
    killBox: entity => { killBox(combat,entity); }, playerDie: death.playerDie, bodyDie: death.bodyDie, effects: () => effects,
    targets: () => ({ pool, time: settings.time, warn: text => { calls.push(text); }, remapShader: () => { throw new Error("No remap expected"); } }) });
  const common = { world, weapons, spawns, drops, get dmflags() { return settings.dmflags; } };
  const context: ClientEventsContext = combat.product === "baseq3" ? { ...common, product: "baseq3", combat,
    get dmflags() { return settings.dmflags; } } : { ...common, product: "missionpack", combat, get dmflags() { return settings.dmflags; },
    personalPortal: new PersonalPortalRuntime({ combat, world, models, random, items }) };
  function player(number: number, origin = vec3(0,0,0)): GameEntity {
    const entity = pool.at(number), client = pool.clientAt(number); initGameEntity(entity);
    entity.s.eType = EntityType.ET_PLAYER; entity.s.clientNum = client.ps.clientNum = number;
    entity.health = client.ps.health = 100; entity.takedamage = true; entity.die = death.playerDie;
    client.ps.stats.set(statSchema(product).maxHealth,80); client.pers.connected = ConnectionState.CONNECTED;
    client.ps.viewheight = 26; client.ps.groundEntityNum = ENTITYNUM_NONE; client.ps.origin = origin;
    client.sess.sessionTeam = number === 0 ? Team.TEAM_RED : Team.TEAM_BLUE;
    entity.r.mins = vec3(-15,-15,-24); entity.r.maxs = vec3(15,15,32); entity.r.contents = 0x2000000;
    setOrigin(entity,origin); world.link(entity); return entity;
  }
  const entity = player(0), client = pool.clientAt(0);
  function point(origin = vec3(100,0,100)): GameEntity { const point = pool.spawn(); point.classname = "info_player_deathmatch"; point.s.origin = origin; point.s.angles = vec3(0,90,0); return point; }
  function dispatch(...events: number[]): void { const old = client.ps.eventSequence; for (const event of events) client.ps.addEvent(event); clientEvents(context,entity,old); }
  function opened(): GameEntity[] { return Array.from({ length: pool.numEntities - 64 }, (_,index) => pool.at(index + 64)).filter(entity => entity.inuse); }
  return { settings, pool, world, random, models, weapons, missiles, death, team, think, spawns, context, entity, client, calls, player, point, dispatch, opened };
}

describe("ClientEvents source ring and damage", () => {
  test("actual falling damage honors entity type, dmflags, armor and pain debounce", () => {
    for (const product of ["baseq3","missionpack"] satisfies Product[]) {
      const f = setup(product); f.dispatch(EntityEvent.EV_FALL_MEDIUM,EntityEvent.EV_FALL_FAR);
      expect(f.entity.health).toBe(85); expect(f.client.ps.health).toBe(85); expect(f.entity.painDebounceTime).toBe(1200);
      expect(f.client.lastHurtMod).toBe(19); expect(f.client.damageFromWorld).toBe(true);
      f.settings.dmflags = 8; f.dispatch(EntityEvent.EV_FALL_FAR); expect(f.entity.health).toBe(85);
      f.settings.dmflags = 0; f.entity.s.eType = EntityType.ET_INVISIBLE; f.dispatch(EntityEvent.EV_FALL_FAR); expect(f.entity.health).toBe(85);
      f.entity.s.eType = EntityType.ET_PLAYER; f.client.ps.stats.set(statSchema(product).armor,20);
      f.dispatch(EntityEvent.EV_FALL_FAR); expect(f.entity.health).toBe(82); expect(f.client.ps.stats.get(statSchema(product).armor)).toBe(13);
    }
  });

  test("native/QVM ring clamp includes signed overflow and never masks raw event identifiers", () => {
    // Original ClientEvents from g_active.c:537–663; /tmp/quake3-clientevents-reference-QiR6oS.
    for (const [old,sequence,falls,fires] of [[0,4,1,1],[2147483647,-2147483648,0,0],[-2147483648,-2147483647,0,0],
      [-2147483648,-2147483646,1,1],[2147483645,2147483647,1,1]] satisfies [number,number,number,number][]) {
      const f = setup(); f.entity.s.weapon = Weapon.WP_ROCKET_LAUNCHER;
      f.client.ps.events.set(0,EntityEvent.EV_FALL_MEDIUM); f.client.ps.events.set(1,EntityEvent.EV_FIRE_WEAPON);
      f.client.ps.eventSequence = sequence; clientEvents(f.context,f.entity,old);
      expect(f.entity.health).toBe(100-falls*5); expect(f.opened().filter(entity => entity.classname === "rocket")).toHaveLength(fires);
      expect(f.client.ps.eventSequence).toBe(sequence);
    }
    const f = setup(); f.dispatch(EntityEvent.EV_USE_ITEM2 | 0x100,EntityEvent.EV_FALL_SHORT); expect(f.entity.health).toBe(100);
  });

  test("callbacks can grow the live sequence and alter dmflags before the next event", () => {
    const f = setup(); f.entity.pain = () => { f.client.ps.addEvent(EntityEvent.EV_USE_ITEM2); };
    f.dispatch(EntityEvent.EV_FALL_FAR); expect(f.entity.health).toBe(105); expect(f.client.ps.health).toBe(90);
    expect(f.client.ps.eventSequence).toBe(2);
    const live = setup(); live.entity.pain = () => { live.settings.dmflags = 8; live.settings.time = 9000; };
    live.dispatch(EntityEvent.EV_FALL_MEDIUM,EntityEvent.EV_FALL_FAR);
    expect(live.entity.health).toBe(95); expect(live.entity.painDebounceTime).toBe(1200);
  });

  test("medkit changes entity health only and does not require or consume inventory", () => {
    for (const product of ["baseq3","missionpack"] satisfies Product[]) {
      const f = setup(product); f.client.ps.stats.set(statSchema(product).holdableItem,0);
      f.dispatch(EntityEvent.EV_USE_ITEM2); expect(f.entity.health).toBe(105); expect(f.client.ps.health).toBe(100);
      expect(f.client.ps.events.get(0)).toBe(EntityEvent.EV_USE_ITEM2); expect(f.client.ps.eventSequence).toBe(1);
    }
  });
});

describe("real event gameplay dispatch", () => {
  test("FireWeapon executes actual projectiles and ClientThink Pmove reaches the same dispatcher", () => {
    const direct = setup(); direct.entity.s.weapon = Weapon.WP_ROCKET_LAUNCHER;
    direct.dispatch(EntityEvent.EV_FIRE_WEAPON); expect(direct.opened().filter(entity => entity.classname === "rocket")).toHaveLength(1);
    expect(direct.client.accuracyShots).toBe(1);
    const f = setup(); f.entity.s.weapon = f.client.ps.weapon = Weapon.WP_ROCKET_LAUNCHER;
    f.client.ps.ammo.set(Weapon.WP_ROCKET_LAUNCHER,3); f.client.ps.stats.set(statSchema("baseq3").weapons,1 << Weapon.WP_ROCKET_LAUNCHER);
    f.client.ps.commandTime = 900;
    f.think.clientThink(0,{ serverTime: 1000, angles: vec3(0,0,0), buttons: CommandButtons.ATTACK, weapon: Weapon.WP_ROCKET_LAUNCHER,
      forwardmove: 0, rightmove: 0, upmove: 0 });
    expect(f.opened().filter(entity => entity.classname === "rocket")).toHaveLength(1);
    expect(f.client.ps.ammo.get(Weapon.WP_ROCKET_LAUNCHER)).toBe(2);
  });

  test("teleporter drops the first flag before moving, computes seconds and ignores spawn restrictions", () => {
    for (const product of ["baseq3","missionpack"] satisfies Product[]) {
      const f = setup(product); f.settings.gameType = GameType.GT_CTF; const point = f.point(); point.flags = GameFlags.NO_HUMANS;
      f.client.ps.powerups.set(Powerup.PW_REDFLAG,5999); f.client.ps.powerups.set(Powerup.PW_BLUEFLAG,9999);
      f.dispatch(EntityEvent.EV_USE_ITEM1);
      const flag = f.opened().find(entity => entity.classname === "team_CTF_redflag"); if (flag === undefined) throw new Error("Missing flag drop");
      expect(flag.count).toBe(4); expect(flag.s.pos.base).toEqual(vec3(0,0,0));
      expect(f.client.ps.powerups.get(Powerup.PW_REDFLAG)).toBe(0); expect(f.client.ps.powerups.get(Powerup.PW_BLUEFLAG)).toBe(9999);
      expect(f.client.ps.origin).toEqual(vec3(100,0,110)); expect(f.client.ps.pmTime).toBe(160);
      expect(f.client.ps.velocity.y).toBe(400); expect(f.client.ps.eFlags & 4).toBe(4);
      expect(f.world.linkState(0)?.linked).toBe(true);
      const events = f.opened().filter(entity => entity.s.eType === EntityType.ET_EVENTS + EntityEvent.EV_PLAYER_TELEPORT_IN || entity.s.eType === EntityType.ET_EVENTS + EntityEvent.EV_PLAYER_TELEPORT_OUT);
      expect(events).toHaveLength(2);
      const first = events[0]; if (first === undefined) throw new Error("Missing teleport event");
      expect(flag.slot).toBeLessThan(first.slot);
    }
  });

  test("teleport preserves partial drop and flag removal if no spawnpoint exists", () => {
    const f = setup(); f.client.ps.powerups.set(Powerup.PW_BLUEFLAG,500);
    expect(() => f.dispatch(EntityEvent.EV_USE_ITEM1)).toThrow("Couldn't find");
    expect(f.client.ps.powerups.get(Powerup.PW_BLUEFLAG)).toBe(0);
    expect(f.opened().find(entity => entity.classname === "team_CTF_blueflag")?.count).toBe(1);
    expect(f.client.ps.origin).toEqual(vec3(0,0,0));
  });

  test("flag expiry and time remain live across the actual dropped-item callback", () => {
    const f = setup(); f.point(); f.settings.gameType = GameType.GT_CTF;
    f.client.ps.powerups.set(Powerup.PW_REDFLAG,5999);
    const context: ClientEventsContext = { ...f.context, drops: { ...f.context.drops,
      checkDroppedTeamItem: entity => {
        f.team.checkDroppedItem(entity);
        f.settings.time = 2000;
        f.client.ps.powerups.set(Powerup.PW_REDFLAG,9999);
      } } };
    f.client.ps.addEvent(EntityEvent.EV_USE_ITEM1); clientEvents(context,f.entity,0);
    const flag = f.opened().find(entity => entity.classname === "team_CTF_redflag");
    if (flag === undefined) throw new Error("Missing flag drop");
    expect(flag.count).toBe(7); expect(flag.s.pos.time).toBe(1000);
    expect(f.client.ps.powerups.get(Powerup.PW_REDFLAG)).toBe(0);
  });

  test("occupied-only spawn fallback reaches actual telefrag damage and player death", () => {
    for (const product of ["baseq3","missionpack"] satisfies Product[]) {
      const f = setup(product); f.point(); const victim = f.player(1,vec3(100,0,110));
      const victimClient = f.pool.clientAt(1); f.dispatch(EntityEvent.EV_USE_ITEM1);
      expect(victimClient.ps.pmType).toBe(MoveType.PM_DEAD);
      expect(victim.health).toBeLessThan(0); expect(victimClient.lastHurtMod).toBe(18);
      expect(f.client.ps.origin).toEqual(vec3(100,0,110));
    }
  });

  test("Harvester teleport drops every carried opposite-team cube while baseq3 leaves generic1 alone", () => {
    for (const product of ["baseq3","missionpack"] satisfies Product[]) for (const team of [Team.TEAM_RED,Team.TEAM_BLUE]) {
      const f = setup(product); f.point(); f.settings.gameType = GameType.GT_HARVESTER; f.client.sess.sessionTeam = team; f.client.ps.generic1 = 3;
      f.dispatch(EntityEvent.EV_USE_ITEM1);
      const cubes = f.opened().filter(entity => entity.classname === (team === Team.TEAM_RED ? "item_bluecube" : "item_redcube"));
      expect(cubes).toHaveLength(product === "missionpack" ? 3 : 0);
      for (const cube of cubes) expect(cube.spawnflags).toBe(team === Team.TEAM_RED ? Team.TEAM_BLUE : Team.TEAM_RED);
      expect(f.client.ps.generic1).toBe(product === "missionpack" ? 0 : 3);
    }
  });

  test("missionpack kamikaze clears invulnerability before actual lethal damage and base ignores it", () => {
    for (const product of ["baseq3","missionpack"] satisfies Product[]) {
      const f = setup(product); f.client.invulnerabilityTime = 99999; f.entity.s.eFlags |= 0x200;
      f.dispatch(EntityEvent.EV_USE_ITEM3);
      expect(f.client.invulnerabilityTime).toBe(product === "missionpack" ? 0 : 99999);
      expect(f.opened().filter(entity => entity.classname === "kamikaze")).toHaveLength(product === "missionpack" ? 1 : 0);
      expect(f.client.ps.pmType).toBe(product === "missionpack" ? MoveType.PM_DEAD : MoveType.PM_NORMAL);
    }
  });

  test("missionpack portalID dispatch creates both real portals and enables a working teleport", () => {
    const f = setup("missionpack"); setOrigin(f.entity,vec3(100,0,0)); f.client.ps.origin = vec3(100,0,0);
    f.dispatch(EntityEvent.EV_USE_ITEM4); expect(f.client.portalID).toBe(1);
    const destination = f.opened().find(entity => entity.classname === "hi_portal destination");
    if (destination === undefined) throw new Error("Missing portal destination");
    expect(destination.s.modelindex).toBe(1); expect(f.world.linkState(destination.slot)?.linked).toBe(true);
    setOrigin(f.entity,vec3(0,0,0)); f.client.ps.origin = vec3(0,0,0); f.dispatch(EntityEvent.EV_USE_ITEM4);
    expect(f.client.portalID).toBe(0);
    const source = f.opened().find(entity => entity.classname === "hi_portal source"); if (source === undefined) throw new Error("Missing portal source");
    expect(source.touch).toBeNull(); f.settings.time = 2000; runThink(source,2000);
    if (source.touch === null) throw new Error("Portal failed to enable");
    source.touch(source,f.entity,{ fraction: 0, end: vec3(0,0,0), solidity: "clear", contact: { kind: "none" }, contents: 0, surfaceFlags: 0, entityNum: 0 });
    expect(f.client.ps.origin).toEqual(vec3(100,0,1));
  });

  test("invulnerability uses current time, wraps signed milliseconds, and base extra item events are inert", () => {
    const f = setup("missionpack"); f.settings.time = 2147483640; f.dispatch(EntityEvent.EV_USE_ITEM5);
    expect(f.client.invulnerabilityTime).toBe(-2147473656);
    const live = setup("missionpack"); live.entity.pain = () => { live.settings.time = 9000; };
    live.dispatch(EntityEvent.EV_FALL_MEDIUM,EntityEvent.EV_USE_ITEM5);
    expect(live.client.invulnerabilityTime).toBe(19000);
    const base = setup(); base.dispatch(EntityEvent.EV_USE_ITEM4,EntityEvent.EV_USE_ITEM5);
    expect(base.client.portalID).toBe(0); expect(base.client.invulnerabilityTime).toBe(0); expect(base.opened()).toHaveLength(0);
  });
});
