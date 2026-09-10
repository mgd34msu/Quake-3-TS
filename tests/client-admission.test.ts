import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import { ClientAdmissionRuntime, ClientCapabilityError, cleanClientName, clientInfoValue } from "../src/game/client-admission.ts";
import type { ClientAdmissionHost, ClientBotServices } from "../src/game/client-admission.ts";
import { ClientSpawnRuntime } from "../src/game/client-spawn.ts";
import type { ClientSpawnHost } from "../src/game/client-spawn.ts";
import { ClientThinkRuntime } from "../src/game/client-think.ts";
import type { ClientThinkHost } from "../src/game/client-think.ts";
import { MovementDiagnostics } from "../src/shared/movement.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { EntityPool, initGameEntity } from "../src/game/entities.ts";
import { MatchState } from "../src/game/match.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { GameSessionManager } from "../src/game/session.ts";
import type { SessionCvarName, SessionCvarService, SessionWorldState } from "../src/game/session.ts";
import { ConnectionState, SpectatorState } from "../src/game/state.ts";
import { ServerWorld } from "../src/server/world.ts";
import { EntityEvent, EntityType, GameType, PersistentIndex, Powerup, Team, Weapon, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ServerEntityFlags } from "../src/shared/entity-shared.ts";
import { PlayerStateSlots } from "../src/shared/player-state.ts";
import type { UserCommand } from "../src/shared/player-state.ts";

function emptyMap(): BspMap {
  const bounds = { min: vec3(-1000, -1000, -1000), max: vec3(1000, 1000, 1000) };
  return { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}

class AdmissionLevel extends MatchState { newSession = false; }

interface FixtureOptions {
  readonly product?: Product;
  readonly gameType?: GameType;
  readonly password?: string;
  readonly bots?: ClientBotServices;
}

function fixture(options: FixtureOptions = {}) {
  const product = options.product ?? "baseq3", calls: string[] = [], userinfos = ["", "", "", ""];
  const settings = { gameType: options.gameType ?? GameType.GT_FFA, password: options.password ?? "" };
  const state = new AdmissionLevel(); state.time = 4000;
  const teamScores = new PlayerStateSlots(Team.TEAM_NUM_TEAMS);
  const pool = new EntityPool({ print: text => { worldPrints.push(text); }, product, maxClients: 4, mapStartTime: 0, time: () => state.time,
    link: entity => { world.link(entity); }, unlink: entity => { world.unlink(entity.slot); } });
  const collision = new CollisionWorld(emptyMap(), { kind: "unaccounted" }, { kind: "disabled" });
  const worldPrints: string[] = [];
  const world = new ServerWorld(collision, collision.modelBounds(0), number => pool.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  const bots = options.bots ?? { kind: "available",
    removeQueuedBegin(clientNum: number): void { calls.push(`bot-remove:${clientNum}`); },
    connect(clientNum: number, restart: boolean): boolean { calls.push(`bot-connect:${clientNum}:${restart}`); return true; },
    shutdownClient(clientNum: number, restart: boolean): void { calls.push(`bot-shutdown:${clientNum}:${restart}`); } };
  const host: ClientAdmissionHost = {
    product, pool, teamScores, world, state, bots, settings: () => settings,
    session: {
      initializeClient(clientNum, info): void { calls.push(`session-init:${clientNum}:${info.valueForKey("team")}`); },
      readClient(clientNum): void { calls.push(`session-read:${clientNum}`); },
    },
    spawn: { clientSpawn(entity): void {
      calls.push(`spawn:${entity.slot}`);
      const client = entity.client;
      if (client === null) throw new Error("spawn fixture lost its client");
      client.ps.origin = vec3(11, 22, 33); entity.s.clientNum = 19;
    } },
    death: {
      tossClientItems(entity): void { calls.push(`toss-items:${entity.slot}`); },
      tossClientPersistantPowerups(entity): void { calls.push(`toss-persistent:${entity.slot}`); },
      tossClientCubes(entity): void { calls.push(`toss-cubes:${entity.slot}`); },
    },
    match: { calculateRanks(): void { calls.push("ranks"); } },
    commands: {
      broadcastTeamChange(clientNum, oldTeam): void { calls.push(`broadcast:${clientNum}:${oldTeam}`); },
      stopFollowing(entity): void { calls.push(`stop-following:${entity.slot}`); },
    },
    getUserinfo(clientNum): string { return userinfos[clientNum] ?? ""; },
    setConfigstring(index, value): void { calls.push(`config:${index}:${value}`); },
    sendServerCommand(clientNum, value): void { calls.push(`command:${clientNum}:${value}`); },
    log(value): void { calls.push(`log:${value}`); },
    filterPacket(address): boolean { calls.push(`filter:${address}`); return address === "banned"; },
  };
  return { product, calls, userinfos, settings, state, teamScores, pool, world, host,
    runtime: new ClientAdmissionRuntime(host) };
}

describe("source client info helpers", () => {
  test("cleans byte names with source color, spacing and destination rules", () => {
    expect(cleanClientName("   ^1Alpha    Beta")).toBe("^1Alpha   Beta");
    expect(cleanClientName("^0black^8also-black^1red")).toBe("blackalso-black^1red");
    expect(cleanClientName("^1^2^")).toBe("UnnamedPlayer");
    expect(cleanClientName("a".repeat(40))).toBe("a".repeat(35));
    expect(cleanClientName("abc^")).toBe("abc");
    expect(() => cleanClientName("snowman ☃")).toThrow("byte characters");
  });

  test("finds the first key using source ASCII case folding and malformed-pair behavior", () => {
    const info = "\\NaMe\\First\\name\\Second\\IP\\localhost";
    expect(clientInfoValue(info, "name")).toBe("First");
    expect(clientInfoValue(info, "ip")).toBe("localhost");
    expect(clientInfoValue("name\\value", "name")).toBe("value");
    expect(clientInfoValue("\\dangling", "dangling")).toBe("");
  });
});

describe("ClientUserinfoChanged", () => {
  test("publishes exact human config, first duplicate key, rename, and sticky local state", () => {
    const f = fixture({ gameType: GameType.GT_CTF });
    const client = f.pool.clientAt(0);
    client.sess.sessionTeam = Team.TEAM_RED; client.sess.wins = 2; client.sess.losses = 3;
    client.sess.teamLeader = 1; client.pers.connected = ConnectionState.CONNECTED; client.pers.netname = "Old";
    f.userinfos[0] = "\\NaMe\\  ^1Alpha    Beta\\name\\ignored\\ip\\localhost\\cg_predictItems\\4294967297" +
      "\\handicap\\87\\team_model\\team/body\\team_headmodel\\team/head\\model\\wrong\\headmodel\\wrong" +
      "\\g_redteam\\Stroggs\\g_blueteam\\Pagans\\color1\\4\\color2\\5\\teamoverlay\\0\\teamtask\\2";
    f.runtime.userinfoChanged(0);
    expect(client.pers).toMatchObject({ netname: "^1Alpha   Beta", localClient: true,
      predictItemPickup: true, maxHealth: 87, teamInfo: false });
    const config = "n\\^1Alpha   Beta\\t\\1\\model\\team/body\\hmodel\\team/head\\g_redteam\\Stroggs" +
      "\\g_blueteam\\Pagans\\c1\\4\\c2\\5\\hc\\87\\w\\2\\l\\3\\tt\\2\\tl\\1";
    expect(f.calls).toContain(`command:-1:print \"Old^7 renamed to ^1Alpha   Beta\n\"`);
    expect(f.calls).toContain(`config:544:${config}`);
    expect(f.calls).toContain(`log:ClientUserinfoChanged: 0 ${config}\n`);
    f.userinfos[0] = "\\name\\Later\\cg_predictItems\\0";
    f.runtime.userinfoChanged(0);
    expect(client.pers.localClient).toBe(true);
    expect(client.pers.predictItemPickup).toBe(false);
  });

  test("publishes raw session leader integers for humans and bots in both products", () => {
    for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
      for (const leader of [9, -1]) {
        for (const bot of [false, true]) {
          const f = fixture({ product, gameType: GameType.GT_CTF });
          const client = f.pool.clientAt(0);
          client.sess.sessionTeam = Team.TEAM_RED; client.sess.teamLeader = leader;
          if (bot) f.pool.at(0).r.svFlags |= ServerEntityFlags.BOT;
          f.userinfos[0] = "\\name\\Leader";
          f.runtime.userinfoChanged(0);
          expect(f.calls.find(value => value.startsWith("config:544:"))).toEndWith(`\\tl\\${leader}`);
          expect(client.sess.teamLeader).toBe(leader);
        }
      }
    }
  });

  test("preserves invalid-info fallback and scoreboard naming for both products", () => {
    for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
      const f = fixture({ product }); const client = f.pool.clientAt(0);
      client.sess.sessionTeam = Team.TEAM_SPECTATOR; client.sess.spectatorState = SpectatorState.SCOREBOARD;
      f.userinfos[0] = "\\name\\injected;value\\handicap\\1";
      f.runtime.userinfoChanged(0);
      expect(client.pers.netname).toBe("scoreboard");
      expect(client.pers.maxHealth).toBe(100);
      expect(f.calls.find(value => value.startsWith("config:544:"))).toContain("model\\\\hmodel\\");
    }
  });

  test("uses product Guard/team-overlay rules and bot team selection without changing its session", () => {
    const base = fixture({ product: "baseq3", gameType: GameType.GT_CTF });
    const mission = fixture({ product: "missionpack", gameType: GameType.GT_CTF });
    for (const f of [base, mission]) {
      const client = f.pool.clientAt(0), entity = f.pool.at(0);
      entity.r.svFlags |= ServerEntityFlags.BOT; client.sess.sessionTeam = Team.TEAM_SPECTATOR;
      client.ps.powerups.set(Powerup.PW_GUARD, 1); f.teamScores.set(Team.TEAM_RED, 5); f.teamScores.set(Team.TEAM_BLUE, 5);
      f.userinfos[0] = "\\name\\Bot\\handicap\\50\\team_model\\m\\team_headmodel\\h\\teamoverlay\\0\\skill\\4";
      f.runtime.userinfoChanged(0);
      expect(client.sess.sessionTeam).toBe(Team.TEAM_SPECTATOR);
      expect(client.pers.maxHealth).toBe(f.product === "missionpack" ? 200 : 50);
      expect(client.pers.teamInfo).toBe(f.product === "missionpack");
      expect(f.calls.find(value => value.startsWith("config:544:"))).toContain("n\\Bot\\t\\2\\model\\m");
    }
    mission.userinfos[0] = "\\name\\Bot\\team\\R\\team_model\\m\\team_headmodel\\h";
    mission.runtime.userinfoChanged(0);
    expect(mission.calls.at(-2)).toContain("\\t\\1\\model");
  });
});

describe("ClientConnect and ClientBegin", () => {
  test("rejects filters/passwords before mutation and preserves source password bypasses", () => {
    const banned = fixture({ password: "Secret" }); banned.pool.clientAt(0).pers.netname = "kept";
    banned.userinfos[0] = "\\ip\\banned\\password\\Secret";
    expect(banned.runtime.connect(0, true, false)).toBe("You are banned from this server.");
    expect(banned.pool.clientAt(0).pers.netname).toBe("kept");
    expect(banned.calls).toEqual(["filter:banned"]);

    const remote = fixture({ password: "Secret" }); remote.userinfos[0] = "\\ip\\1.2.3.4:27960\\password\\secret";
    expect(remote.runtime.connect(0, true, false)).toBe("Invalid password");
    expect(remote.calls).toEqual(["filter:1.2.3.4:27960"]);
    const local = fixture({ password: "Secret" }); local.userinfos[0] = "\\ip\\localhost\\name\\Local";
    expect(local.runtime.connect(0, true, false)).toBeNull();
    const marked = fixture({ password: "Secret" }); marked.pool.at(0).r.svFlags |= ServerEntityFlags.BOT;
    marked.userinfos[0] = "\\ip\\remote\\name\\Marked";
    expect(marked.runtime.connect(0, true, false)).toBeNull();
  });

  test("resets a successful client in place, sequences session/userinfo/ranks, and surfaces bot capability", () => {
    const f = fixture({ gameType: GameType.GT_TEAM }); const client = f.pool.clientAt(0);
    const identities = { client, ps: client.ps, pers: client.pers, sess: client.sess, ammoTimes: client.ammoTimes,
      stats: client.ps.stats, origin: client.ps.origin, command: client.pers.cmd, angles: client.pers.cmd.angles,
      teamState: client.pers.teamState };
    client.accuracyHits = 99; client.ammoTimes.set(1, 72); client.ps.stats.set(2, 55);
    f.userinfos[0] = "\\ip\\remote\\name\\New\\team\\red\\handicap\\90";
    expect(f.runtime.connect(0, true, false)).toBeNull();
    expect(f.pool.clientAt(0)).toBe(identities.client); expect(client.ps).toBe(identities.ps);
    expect(client.pers).toBe(identities.pers); expect(client.sess).toBe(identities.sess);
    expect(client.ammoTimes).toBe(identities.ammoTimes); expect(client.ps.stats).toBe(identities.stats);
    expect(client.ps.origin).toBe(identities.origin); expect(client.pers.cmd).toBe(identities.command);
    expect(client.pers.cmd.angles).toBe(identities.angles); expect(client.pers.teamState).toBe(identities.teamState);
    expect(client.accuracyHits).toBe(0); expect(client.ammoTimes.get(1)).toBe(0);
    expect(f.calls.slice(0, 4)).toEqual(["filter:remote", "session-init:0:red", "session-read:0", "log:ClientConnect: 0\n"]);
    expect(f.calls.at(-2)).toBe("broadcast:0:-1"); expect(f.calls.at(-1)).toBe("ranks");

    const unavailable = fixture({ bots: { kind: "unavailable", reason: "Bot subsystem unavailable" } });
    unavailable.userinfos[0] = "\\ip\\localhost\\name\\Bot";
    expect(unavailable.runtime.connect(0, true, true)).toBe("Bot subsystem unavailable");
    expect(unavailable.pool.at(0).inuse).toBe(true);
    const rejected = fixture({ bots: { kind: "available", removeQueuedBegin(): void {},
      connect(): boolean { return false; }, shutdownClient(): void {} } });
    rejected.userinfos[0] = "\\ip\\localhost\\name\\Bot";
    expect(rejected.runtime.connect(0, false, true)).toBe("BotConnectfailed");
  });

  test("distinguishes carried sessions, new sessions, and bot restart connects", () => {
    const carried = fixture(); carried.userinfos[0] = "\\ip\\localhost\\name\\Carry";
    expect(carried.runtime.connect(0, false, false)).toBeNull();
    expect(carried.calls.some(value => value.startsWith("session-init"))).toBe(false);
    expect(carried.calls).toContain("session-read:0");

    const changed = fixture(); changed.state.newSession = true;
    changed.userinfos[0] = "\\ip\\localhost\\name\\Changed\\team\\s";
    expect(changed.runtime.connect(0, false, false)).toBeNull();
    expect(changed.calls).toContain("session-init:0:s");

    const bot = fixture(); bot.userinfos[0] = "\\ip\\localhost\\name\\Bot";
    expect(bot.runtime.connect(0, false, true)).toBeNull();
    expect(bot.calls).toContain("bot-connect:0:true");
  });

  test("begins spectator and active clients with exact retained flags and event/message branches", () => {
    const spectator = fixture(); const spectatorClient = spectator.pool.clientAt(0);
    spectatorClient.sess.sessionTeam = Team.TEAM_SPECTATOR; spectatorClient.ps.eFlags = 0x1234;
    spectator.runtime.begin(0);
    expect(spectatorClient.pers).toMatchObject({ connected: ConnectionState.CONNECTED, enterTime: 4000 });
    expect(spectator.calls).toEqual(["spawn:0", "log:ClientBegin: 0\n", "ranks"]);
    expect(spectatorClient.ps.eFlags).toBe(0x1234);

    const active = fixture(); const activeClient = active.pool.clientAt(0);
    activeClient.sess.sessionTeam = Team.TEAM_FREE; activeClient.pers.netname = "Player";
    initGameEntity(active.pool.at(0)); active.world.link(active.pool.at(0));
    expect(active.world.linkState(0)?.linked).toBe(true);
    active.runtime.begin(0);
    const temporary = active.pool.at(64);
    expect(temporary.s.eType).toBe(EntityType.ET_EVENTS + EntityEvent.EV_PLAYER_TELEPORT_IN);
    expect(temporary.s.clientNum).toBe(19);
    expect(active.world.linkState(0)?.linked).toBe(false);
    expect(active.calls).toContain("command:-1:print \"Player^7 entered the game\n\"");
    const tournament = fixture({ gameType: GameType.GT_TOURNAMENT });
    tournament.pool.clientAt(0).sess.sessionTeam = Team.TEAM_FREE; tournament.runtime.begin(0);
    expect(tournament.calls.some(value => value.includes("entered the game"))).toBe(false);
  });
});

describe("ClientDisconnect", () => {
  test("stops followers, drops product state, awards tournament winner, and clears the slot in source order", () => {
    const f = fixture({ product: "missionpack", gameType: GameType.GT_HARVESTER });
    const entity = f.pool.at(1), client = f.pool.clientAt(1); initGameEntity(entity);
    client.pers.connected = ConnectionState.CONNECTED; client.sess.sessionTeam = Team.TEAM_RED; client.ps.origin = vec3(3, 4, 5);
    const follower = f.pool.clientAt(2); follower.sess.sessionTeam = Team.TEAM_SPECTATOR;
    follower.sess.spectatorState = SpectatorState.FOLLOW; follower.sess.spectatorClient = 1;
    f.runtime.disconnect(1);
    expect(f.calls.slice(0, 5)).toEqual(["bot-remove:1", "stop-following:2", "toss-items:1", "toss-persistent:1", "toss-cubes:1"]);
    expect(f.pool.at(64).s.eType).toBe(EntityType.ET_EVENTS + EntityEvent.EV_PLAYER_TELEPORT_OUT);
    expect(entity).toMatchObject({ inuse: false, classname: "disconnected" });
    expect<ConnectionState>(client.pers.connected).toBe(ConnectionState.DISCONNECTED);
    expect<Team>(client.sess.sessionTeam).toBe(Team.TEAM_FREE);
    expect(client.ps.persistant.get(PersistentIndex.PERS_TEAM)).toBe(Team.TEAM_FREE);
    expect(f.calls).toContain("config:545:"); expect(f.calls.at(-1)).toBe("ranks");

    const tourney = fixture({ gameType: GameType.GT_TOURNAMENT });
    tourney.state.sortedClients[0] = 0; tourney.state.sortedClients[1] = 1;
    tourney.pool.clientAt(1).pers.connected = ConnectionState.CONNECTED;
    tourney.pool.clientAt(1).sess.sessionTeam = Team.TEAM_FREE;
    tourney.pool.clientAt(0).sess.wins = 7; tourney.userinfos[0] = "\\name\\Winner";
    tourney.runtime.disconnect(1);
    expect(tourney.pool.clientAt(0).sess.wins).toBe(8);
    expect(tourney.calls.some(value => value.startsWith("config:544:n\\Winner"))).toBe(true);
  });

  test("leaves spectator inventory untouched and rejects unserviceable bot teardown", () => {
    const human = fixture({ product: "missionpack", gameType: GameType.GT_HARVESTER,
      bots: { kind: "unavailable", reason: "No bot runtime" } });
    human.pool.clientAt(0).pers.connected = ConnectionState.CONNECTED;
    human.pool.clientAt(0).sess.sessionTeam = Team.TEAM_SPECTATOR;
    human.runtime.disconnect(0);
    expect(human.calls.some(value => value.startsWith("toss-"))).toBe(false);

    const bot = fixture({ bots: { kind: "unavailable", reason: "No bot runtime" } });
    bot.pool.at(0).r.svFlags |= ServerEntityFlags.BOT;
    expect(() => bot.runtime.disconnect(0)).toThrow(ClientCapabilityError);
    expect(bot.pool.clientAt(0).pers.connected).toBe(ConnectionState.DISCONNECTED);
  });

  test("removes queued begins before the null-client exit and shuts down available bots last", () => {
    const absent = fixture(); absent.pool.at(0).client = null;
    absent.runtime.disconnect(0);
    expect(absent.calls).toEqual(["bot-remove:0"]);

    const bot = fixture(); bot.pool.at(0).r.svFlags |= ServerEntityFlags.BOT;
    bot.pool.clientAt(0).pers.connected = ConnectionState.CONNECTING;
    bot.runtime.disconnect(0);
    expect(bot.calls[0]).toBe("bot-remove:0");
    expect(bot.calls.at(-1)).toBe("bot-shutdown:0:false");
    expect(bot.calls.some(value => value.startsWith("toss-"))).toBe(false);
  });
});

class MemoryCvars implements SessionCvarService {
  readonly values = new Map<SessionCvarName, string>();
  get(name: SessionCvarName): string { return this.values.get(name) ?? ""; }
  set(name: SessionCvarName, value: string): void { this.values.set(name, value); }
}

function realSpawn(product: Product, pool: EntityPool, world: ServerWorld, state: AdmissionLevel): ClientSpawnRuntime {
  const command: UserCommand = { serverTime: state.time, angles: vec3(0, 0, 0), buttons: 0,
    weapon: Weapon.WP_NONE, forwardmove: 0, rightmove: 0, upmove: 0 };
  const commonCombat = { time: state.time, intermissionQueued: 0, gameType: GameType.GT_FFA,
    friendlyFire: false, knockback: 1000, entities: pool, world, debugDamage: null,
    checkHurtCarrier(): void {}, logAccuracyHit(): boolean { return false; } };
  const combat: CombatContext = product === "baseq3" ? { ...commonCombat, product } : { ...commonCombat, product,
    checkObeliskAttack(): boolean { return false; }, invulnerabilityEffect(): void {} };
  const movementDiagnostics = new MovementDiagnostics(() => undefined);
  const thinkHost: ClientThinkHost = { pool, world, movementDiagnostics, effects: { combat },
    frame: () => ({ time: state.time, intermissionTime: 0, intermissionQueued: 0 }),
    settings: () => ({ synchronousClients: true, pmoveFixed: false, pmoveMsec: 8, debugMove: 0, gravity: 800,
      speed: 320, dmflags: 0, smoothClients: false, forceRespawnSeconds: 0, singlePlayer: false }),
    setPmoveMsec(): void {}, intermissionThink(): void {}, spectatorThink(): void {}, checkInactivity(): boolean { return true; },
    freeHook(): void {}, checkGauntletAttack(): boolean { return false; }, clientEvents(): void {}, respawn(): void {},
    botTestAas(): never { throw new Error("No regular movement in the spectator admission fixture"); },
    appendConsoleCommand(): void {}, isDoorTrigger(): boolean { return false; } };
  const think = new ClientThinkRuntime(thinkHost), random = new GameRandom();
  const spawnHost: ClientSpawnHost = { pool, world, think, random,
    frame: () => ({ time: state.time, gameType: GameType.GT_FFA, inactivitySeconds: 0, intermissionTime: 0 }),
    userCommand: () => command, handicap: () => "100",
    findIntermissionPoint: () => ({ origin: vec3(7, 8, 9), angles: vec3(0, 90, 0) }),
    moveToIntermission(): void {}, killBox(): void {}, playerDie(): void {}, bodyDie(): void {},
    effects: () => ({ combat, intermissionTime: 0, smoothClients: false, frySound: 0,
      randomInt: () => 0, soundIndex: () => 0, sound(): void {}, spectatorEndFrame(): void {} }),
    targets: () => ({ pool, time: state.time, warn(): void {}, remapShader(): void {} }) };
  return new ClientSpawnRuntime(spawnHost);
}

test("real Session and ClientSpawn runtimes carry a source spectator through connect and begin", () => {
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const f = fixture({ product }); f.userinfos[0] = "\\ip\\localhost\\name\\Integrated\\team\\s";
    const sessionWorld: SessionWorldState = { clients: f.pool.clients, maxClients: f.pool.maxClients,
      teamScores: f.teamScores, gameType: GameType.GT_FFA, teamAutoJoin: false, maxGameClients: 0,
      time: f.state.time, numNonSpectatorClients: 0, newSession: false };
    const cvars = new MemoryCvars();
    const session = new GameSessionManager(sessionWorld, { cvars, print(): void {}, broadcastTeamChange(): void {} });
    const spawn = realSpawn(product, f.pool, f.world, f.state);
    const host: ClientAdmissionHost = { ...f.host, session, spawn };
    const runtime = new ClientAdmissionRuntime(host);
    expect(runtime.connect(0, true, false)).toBeNull();
    expect(f.pool.clientAt(0).sess.sessionTeam).toBe(Team.TEAM_SPECTATOR);
    runtime.begin(0);
    expect(f.pool.clientAt(0).pers.connected).toBe(ConnectionState.CONNECTED);
    expect(f.pool.clientAt(0).ps.origin).toEqual(vec3(7, 8, 9));
    expect(f.world.linkState(0)?.linked).not.toBe(true);
    expect(f.pool.clientAt(0).ps.stats.get(statSchema(product).maxHealth)).toBe(100);
  }
});
