import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import { DeathRuntime } from "../src/game/death.ts";
import { EntityPool, initGameEntity } from "../src/game/entities.ts";
import { MatchRuntime, MatchState } from "../src/game/match.ts";
import type { MatchHost } from "../src/game/match.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { ConnectionState, SpectatorState } from "../src/game/state.ts";
import type { GameEntity } from "../src/game/state.ts";
import { TeamRuntime } from "../src/game/team.ts";
import { ServerWorld } from "../src/server/world.ts";
import { EntityType, GameType, MoveType, PersistentIndex, Team, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ServerEntityFlags } from "../src/shared/entity-shared.ts";
import { PlayerStateSlots } from "../src/shared/player-state.ts";

class FixtureLevel extends MatchState { spawning = true; numSpawnVars = 13; }
function fixture(product: Product = "baseq3", gameType: GameType = GameType.GT_FFA, maxClients = 8) {
  const state = new FixtureLevel(); state.time = 1000;
  const calls: string[] = [], config = new Map<number, string>();
  const pool = new EntityPool({ print: text => { calls.push(text); }, product, maxClients, mapStartTime: 0, time: () => state.time,
    link: entity => { calls.push(`link:${entity.slot}`); }, unlink: entity => { calls.push(`unlink:${entity.slot}`); } });
  const teamScores = new PlayerStateSlots(4), random = new GameRandom(1);
  const settings = { gameType, timeLimit: 0, fragLimit: 0, captureLimit: 0, warmupSeconds: 20,
    warmupModificationCount: 0, password: "", passwordModificationCount: 0 };
  const variant = { singlePlayer: false };
  const fallback = pool.spawn(); fallback.classname = "info_player_deathmatch";
  const common = { state, pool, teamScores, random, settings: () => settings,
    spawn: {
      selectSpawnPoint: () => { calls.push("select-spawn"); return { entity: fallback, origin: vec3(10, 20, 39), angles: vec3(0, 90, 0) }; },
      respawn: (entity: GameEntity): void => { calls.push(`respawn:${entity.slot}`); entity.health = 100; },
    },
    setTeam: (entity: GameEntity, team: "f" | "s"): void => {
      calls.push(`team:${entity.slot}:${team}`);
      if (entity.client === null) throw new Error("Fixture SetTeam requires a client");
      entity.client.sess.sessionTeam = team === "f" ? Team.TEAM_FREE : Team.TEAM_SPECTATOR;
      match.calculateRanks();
    },
    stopFollowing: (entity: GameEntity): void => {
      calls.push(`stop-follow:${entity.slot}`);
      if (entity.client === null) throw new Error("Fixture follow operation requires a client");
      entity.client.sess.spectatorState = SpectatorState.FREE;
    },
    sendScoreboard: (entity: GameEntity): void => { calls.push(`scoreboard:${entity.slot}`); },
    clientUserinfoChanged: (index: number): void => { calls.push(`userinfo:${index}`); },
    writeSessionData: (): void => { calls.push(`sessions:${pool.clientAt(0).pers.connected}:${pool.clientAt(0).ps.persistant.get(PersistentIndex.PERS_SCORE)}`); },
    appendConsoleCommand: (text: string): void => { calls.push(`console:${text}`); },
    sendServerCommand: (index: number, text: string): void => { calls.push(`send:${index}:${text}`); },
    setConfigstring: (index: number, text: string): void => { calls.push(`config:${index}:${text}`); config.set(index, text); },
    setCvar: (name: string, value: string): void => { calls.push(`cvar:${name}:${value}`); },
    log: (text: string): void => { calls.push(`log:${text}`); }, warn: (text: string): void => { calls.push(`warn:${text}`); },
    botInterbreedEndMatch: (): void => { calls.push("bot-end-match"); },
    updateTournamentInfo: (): void => { calls.push("tournament-info"); },
  };
  const host: MatchHost = product === "baseq3" ? { ...common, product, spawnModelsOnVictoryPads: () => { calls.push("victory-models"); } }
    : { ...common, product, singlePlayer: () => variant.singlePlayer };
  const match = new MatchRuntime(host);
  function player(index: number, score = 0, team = Team.TEAM_FREE, connection = ConnectionState.CONNECTED): GameEntity {
    const entity = pool.at(index), client = pool.clientAt(index); initGameEntity(entity); entity.health = 100;
    client.pers.connected = connection; client.pers.netname = `player${index}`; client.sess.sessionTeam = team;
    client.ps.clientNum = index; client.ps.persistant.set(PersistentIndex.PERS_SCORE, score); return entity;
  }
  const rank = (index: number): number => pool.clientAt(index).ps.persistant.get(PersistentIndex.PERS_RANK);
  return { state, pool, teamScores, settings, variant, calls, config, match, player, rank };
}

describe("rank calculation and shared state", () => {
  test("real DeathRuntime and TeamRuntime scoring use the exact slots consumed by ranks", () => {
    const f = fixture("baseq3", GameType.GT_TEAM), origin = vec3(0, 0, 0);
    const bounds = { min: vec3(-1000, -1000, -1000), max: vec3(1000, 1000, 1000) };
    const map: BspMap = { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
      leaves: [{ bounds, cluster: 0, area: 0, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
      models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }], leafSurfaces: [], leafBrushes: [],
      brushes: [], brushSides: [], vertices: [], surfaces: [], indices: [], fogs: [], lightmaps: [], lightGrid: [], visibility: null };
    const worldPrints: string[] = [];
    const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" }), world = new ServerWorld(collision, bounds, index => f.pool.get(index), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
    const reject = (): never => { throw new Error("Unexpected source service during score-only fixture"); };
    const death = new DeathRuntime({ product: "baseq3", pool: f.pool, world, random: new GameRandom(1), teamScores: f.teamScores,
      missiles: { hookFree: reject }, items: { touchItem: reject, droppedFlagThink: reject, checkDroppedTeamItem: reject },
      frame: () => ({ time: f.state.time, gameType: f.settings.gameType, warmupTime: f.state.warmupTime, intermissionTime: f.state.intermissionTime, blood: true }),
      calculateRanks: () => { f.match.calculateRanks(); }, sendScoreboard: reject, log: reject, teamFragBonuses: reject, returnFlag: reject });
    const team = new TeamRuntime({ product: "baseq3", pool: f.pool, world, gameType: GameType.GT_TEAM, time: f.state.time,
      sortedClients: f.state.sortedClients,
      teamScores: f.teamScores, locationHead: null, sendServerCommand: reject, setConfigstring: reject, warn: reject,
      addScore: (entity, position, score) => { death.addScore(entity, position, score); }, calculateRanks: () => { f.match.calculateRanks(); },
      respawnItem: reject, inPVS: reject });
    const red = f.player(0, 0, Team.TEAM_RED); f.player(1, 0, Team.TEAM_BLUE);
    f.pool.clientAt(0).ps.persistant.set(PersistentIndex.PERS_TEAM, Team.TEAM_RED);
    death.addScore(red, origin, 5); expect(f.teamScores.get(Team.TEAM_RED)).toBe(5); expect(f.rank(0)).toBe(0); expect(f.config.get(6)).toBe("5");
    team.addTeamScore(origin, Team.TEAM_BLUE, 7); f.match.calculateRanks(); expect(f.rank(0)).toBe(1); expect(f.config.get(7)).toBe("7");
    expect(death.host.teamScores).toBe(team.host.teamScores); expect(team.host.teamScores).toBe(f.match.host.teamScores);
  });
  test("source zero construction and empty ranks preserve unrelated spawn fields", () => {
    const zero = new MatchState(); expect(zero.time).toBe(0); expect(zero.follow1).toBe(0); expect(zero.sortedClients).toHaveLength(64);
    const f = fixture(); f.state.numTeamVotingClients[0] = 7; f.state.numTeamVotingClients[1] = 9; f.match.calculateRanks();
    expect(f.state.follow1).toBe(-1); expect(f.state.follow2).toBe(-1); expect(f.state.numTeamVotingClients).toEqual([0, 0]);
    expect(f.state.spawning).toBe(true); expect(f.state.numSpawnVars).toBe(13);
    expect(f.config.get(6)).toBe("-9999"); expect(f.config.get(7)).toBe("-9999");
  });
  test("scores/ties, connected counts, bots, connecting clients and spectators follow source precedence", () => {
    const f = fixture(); f.player(0, 10); f.player(1, 20); f.player(2, 20).r.svFlags = ServerEntityFlags.BOT;
    f.player(3, 999, Team.TEAM_SPECTATOR); f.pool.clientAt(3).sess.spectatorTime = 30;
    f.player(4, 999, Team.TEAM_FREE, ConnectionState.CONNECTING);
    f.player(5, 999, Team.TEAM_SPECTATOR); f.pool.clientAt(5).sess.spectatorTime = 10;
    f.player(6, 1000, Team.TEAM_SPECTATOR); f.pool.clientAt(6).sess.spectatorState = SpectatorState.SCOREBOARD;
    f.match.calculateRanks();
    expect(f.state.sortedClients.slice(0, 7)).toEqual([1, 2, 0, 5, 3, 4, 6]);
    expect([f.state.numConnectedClients, f.state.numNonSpectatorClients, f.state.numPlayingClients, f.state.numVotingClients]).toEqual([7, 4, 3, 2]);
    expect([f.state.follow1, f.state.follow2]).toEqual([0, 1]); expect([f.rank(0), f.rank(1), f.rank(2)]).toEqual([2, 0x4000, 0x4000]);
    expect(f.config.get(6)).toBe("20"); expect(f.config.get(7)).toBe("20");
  });
  test("all team gametypes rank spectators and connecting clients by shared team score, not own team", () => {
    for (const mode of [GameType.GT_TEAM, GameType.GT_CTF, GameType.GT_1FCTF, GameType.GT_OBELISK, GameType.GT_HARVESTER]) {
      const f = fixture("missionpack", mode); f.player(0, 5, Team.TEAM_RED); f.player(1, 10, Team.TEAM_BLUE);
      f.player(2, 99, Team.TEAM_SPECTATOR, ConnectionState.CONNECTING);
      f.teamScores.set(Team.TEAM_RED, 3); f.teamScores.set(Team.TEAM_BLUE, 1); f.match.calculateRanks();
      expect([f.rank(0), f.rank(1), f.rank(2)]).toEqual([0, 0, 0]); expect(f.state.numTeamVotingClients).toEqual([1, 1]);
      expect(f.config.get(6)).toBe("3"); f.teamScores.set(Team.TEAM_BLUE, 3); f.match.calculateRanks(); expect(f.rank(1)).toBe(2);
      f.teamScores.set(Team.TEAM_BLUE, 4); f.match.calculateRanks(); expect(f.rank(0)).toBe(1);
    }
  });
  test("single-player solitary rank is tied and lone spectator score remains published", () => {
    const f = fixture("baseq3", GameType.GT_SINGLE_PLAYER); f.player(0, 3); f.match.calculateRanks(); expect(f.rank(0)).toBe(0x4000);
    const g = fixture(); g.player(0, 77, Team.TEAM_SPECTATOR); g.match.calculateRanks();
    expect(g.state.numPlayingClients).toBe(0); expect(g.config.get(6)).toBe("77"); expect(g.config.get(7)).toBe("-9999");
  });
  test("score configstrings retain the game formatter's signed-minimum bytes for both products", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const f = fixture(product); f.player(0, -2147483648); f.match.calculateRanks();
      expect(f.config.get(6)).toBe("-./,),(-*,("); expect(f.config.get(7)).toBe("-9999");
      f.player(1, -1); f.match.calculateRanks();
      expect(f.config.get(6)).toBe("-1"); expect(f.config.get(7)).toBe("-./,),(-*,(");
      const g = fixture(product, GameType.GT_TEAM); g.player(0, 0, Team.TEAM_RED); g.player(1, 0, Team.TEAM_BLUE);
      g.teamScores.set(Team.TEAM_RED, -2147483648); g.teamScores.set(Team.TEAM_BLUE, -1); g.match.calculateRanks();
      expect(g.config.get(6)).toBe("-./,),(-*,("); expect(g.config.get(7)).toBe("-1");
      g.teamScores.set(Team.TEAM_RED, -1); g.teamScores.set(Team.TEAM_BLUE, -2147483648); g.match.calculateRanks();
      expect(g.config.get(6)).toBe("-1"); expect(g.config.get(7)).toBe("-./,),(-*,(");
    }
  });
  test("native original g_main plus bg_lib qsort preserves special-client ordering and pivot paths", () => {
    // Unmodified g_main.c + bg_lib.c + q_shared.c + q_math.c, GCC i386
    // -DC_ONLY -DMISSIONPACK -O0 -ffloat-store; this is native reference execution.
    const cases = [
      { count: 0, order: [], playing: 0 }, { count: 1, order: [0], playing: 1 },
      { count: 6, order: [1, 2, 4, 5, 3, 0], playing: 4 },
      { count: 7, order: [1, 2, 4, 5, 3, 6, 0], playing: 5 },
      { count: 8, order: [1, 2, 7, 4, 5, 3, 6, 0], playing: 6 },
      { count: 41, order: [22, 29, 1, 23, 2, 37, 17, 38, 31, 11, 19, 26, 13, 34, 14, 7, 32, 28, 16, 8, 4, 20, 40, 5, 35, 25, 10, 39, 3, 36, 6, 33, 9, 21, 30, 12, 15, 27, 18, 24, 0], playing: 30 },
      { count: 64, order: [22, 29, 43, 1, 23, 58, 2, 37, 17, 59, 38, 31, 53, 46, 11, 19, 47, 26, 61, 41, 34, 13, 62, 7, 14, 49, 56, 52, 44, 32, 28, 16, 8, 4, 55, 20, 40, 50, 25, 5, 35, 10, 63, 36, 3, 33, 60, 6, 9, 57, 30, 0, 54, 42, 15, 51, 39, 18, 48, 27, 21, 45, 24, 12], playing: 48 },
    ];
    for (const row of cases) {
      const f = fixture("missionpack", GameType.GT_FFA, 64);
      for (let index = 0; index < row.count; index++) {
        f.player(index, (index * 13) % 7); const client = f.pool.clientAt(index);
        if (index % 3 === 0) client.sess.spectatorState = SpectatorState.SCOREBOARD;
        else if (index % 5 === 0) client.pers.connected = ConnectionState.CONNECTING;
        else if (index % 4 === 0) { client.sess.sessionTeam = Team.TEAM_SPECTATOR; client.sess.spectatorTime = 100 - index; }
      }
      f.match.calculateRanks(); expect(f.state.sortedClients.slice(0, row.count)).toEqual(row.order);
      expect(f.state.numPlayingClients).toBe(row.playing);
      if (row.count === 64) expect(Array.from({ length: 64 }, (_, index) => f.rank(index))).toEqual([
        0, 16384, 16388, 44, 33, 39, 47, 16407, 32, 0, 41, 16396, 0, 16403, 16407, 0,
        31, 16392, 0, 16399, 16418, 0, 16384, 16388, 0, 38, 16399, 0, 30, 16384, 0, 16392,
        29, 45, 16403, 40, 43, 16388, 16392, 0, 36, 16403, 0, 16384, 28, 0, 16396, 16399,
        0, 16407, 37, 0, 27, 16396, 0, 16418, 16407, 0, 16388, 16392, 46, 16399, 16403, 42,
      ]);
    }
  });
});

describe("tournament and warmup", () => {
  test("oldest eligible spectator is promoted, counts refresh reentrantly and warmup restarts strictly after deadline", () => {
    const f = fixture("baseq3", GameType.GT_TOURNAMENT); f.player(0, 10);
    f.player(1, 0, Team.TEAM_SPECTATOR); f.pool.clientAt(1).sess.spectatorTime = 100;
    f.player(2, 0, Team.TEAM_SPECTATOR); f.pool.clientAt(2).sess.spectatorTime = 50;
    f.player(3, 0, Team.TEAM_SPECTATOR); f.pool.clientAt(3).sess.spectatorTime = 0; f.pool.clientAt(3).sess.spectatorClient = -1;
    f.match.calculateRanks(); f.match.checkTournament(); expect(f.calls).toContain("team:2:f"); expect(f.state.numPlayingClients).toBe(2);
    expect(f.state.warmupTime).toBe(20000); f.state.time = 20000; f.match.checkTournament(); expect(f.state.restarted).toBe(false);
    f.state.time++; f.match.checkTournament(); expect(f.state.restarted).toBe(true); expect(f.state.warmupTime).toBe(30000);
    expect(f.calls.slice(-2)).toEqual(["cvar:g_restarted:1", "console:map_restart 0\n"]);
  });
  test("missing players wait; live warmup modifications reset countdown and zero players do nothing", () => {
    const f = fixture(); f.state.warmupTime = 5000; f.match.checkTournament(); expect(f.state.warmupTime).toBe(5000);
    f.player(0); f.match.calculateRanks(); f.match.checkTournament(); expect(f.state.warmupTime).toBe(-1);
    expect(f.calls.slice(-2)).toEqual(["config:5:-1", "log:Warmup:\n"]);
    f.player(1); f.match.calculateRanks(); f.match.checkTournament(); expect(f.state.warmupTime).toBe(20000);
    f.settings.warmupModificationCount = 1; f.settings.warmupSeconds = 5; f.state.time = 2000; f.match.checkTournament(); expect(f.state.warmupTime).toBe(6000);
  });
  test("wrapped warmup configstrings use source integer formatting in tournament and ordinary modes", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      for (const mode of [GameType.GT_TOURNAMENT, GameType.GT_FFA, GameType.GT_CTF]) {
        const f = fixture(product, mode);
        f.player(0, 1, mode === GameType.GT_CTF ? Team.TEAM_RED : Team.TEAM_FREE);
        f.player(1, 0, mode === GameType.GT_CTF ? Team.TEAM_BLUE : Team.TEAM_FREE);
        f.match.calculateRanks(); f.state.time = 2147482648; f.state.warmupTime = -1; f.settings.warmupSeconds = 2;
        f.match.checkTournament();
        expect(f.state.warmupTime).toBe(-2147483648);
        expect(f.config.get(5)).toBe("-./,),(-*,(");
      }
    }
  });
  test("objective modes count connecting team members; TDM requires only two players", () => {
    for (const mode of [GameType.GT_CTF, GameType.GT_1FCTF, GameType.GT_OBELISK, GameType.GT_HARVESTER]) {
      const f = fixture("missionpack", mode); f.state.warmupTime = 100; f.player(0, 0, Team.TEAM_RED); f.match.calculateRanks(); f.match.checkTournament();
      expect(f.state.warmupTime).toBe(-1); f.player(1, 0, Team.TEAM_BLUE, ConnectionState.CONNECTING); f.match.calculateRanks(); f.match.checkTournament();
      expect(f.state.warmupTime).toBe(20000);
    }
    const f = fixture("baseq3", GameType.GT_TEAM); f.player(0, 0, Team.TEAM_RED); f.player(1, 0, Team.TEAM_RED);
    f.state.warmupTime = -1; f.match.calculateRanks(); f.match.checkTournament(); expect(f.state.warmupTime).toBe(20000);
  });
  test("duel winners/losers update sessions and removal requires exactly two active players", () => {
    const f = fixture("baseq3", GameType.GT_TOURNAMENT); f.player(0, 2); f.player(1, 4); f.match.calculateRanks();
    f.pool.clientAt(1).sess.wins = 2147483647; f.match.adjustTournamentScores();
    expect(f.pool.clientAt(1).sess.wins).toBe(-2147483648); expect(f.pool.clientAt(0).sess.losses).toBe(1);
    expect(f.calls.slice(-2)).toEqual(["userinfo:1", "userinfo:0"]);
    f.match.removeTournamentWinner(); expect(f.pool.clientAt(1).sess.sessionTeam).toBe(Team.TEAM_SPECTATOR);
    f.match.removeTournamentLoser(); expect(f.pool.clientAt(0).sess.sessionTeam).toBe(Team.TEAM_FREE);
  });
});

describe("intermission and exits", () => {
  test("intermission spot targets, dead respawn/follow order, exact client clearing and scoreboard", () => {
    const f = fixture(), entity = f.player(0), client = f.pool.clientAt(0); entity.health = 0;
    client.sess.spectatorState = SpectatorState.FOLLOW; client.ps.powerups.set(1, 9999); client.ps.eFlags = entity.s.eFlags = 31;
    entity.r.currentOrigin = vec3(7, 8, 9); entity.s.eType = EntityType.ET_PLAYER; entity.s.modelindex = entity.s.loopSound = entity.s.event = entity.r.contents = 7;
    const point = f.pool.spawn(); point.classname = "info_player_intermission"; point.s.origin = vec3(100, 200, 300); point.target = "look";
    const target = f.pool.spawn(); target.targetname = "look"; target.s.origin = vec3(100, 300, 300);
    f.match.beginIntermission(); expect(f.state.intermissionTime).toBe(1000);
    expect(client.ps.origin).toEqual(vec3(100, 200, 300)); expect(client.ps.viewangles).toEqual(vec3(-0, 90, 0));
    expect(client.ps.pmType).toBe(MoveType.PM_INTERMISSION); expect(client.ps.powerups.get(1)).toBe(0);
    expect(entity.r.currentOrigin).toEqual(vec3(7, 8, 9)); expect([entity.s.eFlags, entity.s.modelindex, entity.s.loopSound, entity.s.event, entity.r.contents]).toEqual([0, 0, 0, 0, 0]);
    expect(f.calls).toEqual(["respawn:0", "stop-follow:0", "scoreboard:0"]);
    f.match.beginIntermission(); expect(f.calls).toHaveLength(3);
  });
  test("base single-player victory services and Team Arena single-player intermission services stay distinct", () => {
    const f = fixture("baseq3", GameType.GT_SINGLE_PLAYER); f.player(0); f.match.beginIntermission();
    expect(f.calls).toEqual(["select-spawn", "tournament-info", "victory-models", "scoreboard:0"]);
    const g = fixture("missionpack", GameType.GT_CTF); g.variant.singlePlayer = true; g.player(0); g.match.beginIntermission();
    expect(g.calls).toEqual(["select-spawn", "cvar:ui_singlePlayerActive:0", "tournament-info", "scoreboard:0"]);
  });
  test("ready masks include spectator readiness, exclude bots, enforce 5s minimum and 10s timeout", () => {
    const f = fixture(); f.player(0); f.player(1, 0, Team.TEAM_SPECTATOR); f.player(2).r.svFlags = ServerEntityFlags.BOT;
    f.state.intermissionTime = 1000; f.pool.clientAt(0).readyToExit = true; f.state.time = 5999; f.match.checkIntermissionExit();
    expect(f.pool.clientAt(1).ps.stats.get(statSchema("baseq3").clientsReady)).toBe(1); expect(f.state.readyToExit).toBe(false);
    f.state.time = 6000; f.match.checkIntermissionExit(); expect(f.state.readyToExit).toBe(true); expect(f.state.exitTime).toBe(6000);
    f.state.time = 15999; f.match.checkIntermissionExit(); expect(f.state.intermissionTime).toBe(1000);
    f.state.time++; f.match.checkIntermissionExit(); expect(f.state.intermissionTime).toBe(0);
    expect(f.calls).toContain("console:vstr nextmap\n");
  });
  test("all-ready exits immediately after minimum; no-ready clears timer; base SP never exits automatically", () => {
    const f = fixture(); f.player(0); f.state.intermissionTime = 1000; f.state.time = 6000; f.state.readyToExit = true;
    f.match.checkIntermissionExit(); expect(f.state.readyToExit).toBe(false); f.pool.clientAt(0).readyToExit = true;
    f.match.checkIntermissionExit(); expect(f.state.intermissionTime).toBe(0);
    const g = fixture("baseq3", GameType.GT_SINGLE_PLAYER); g.player(0); g.pool.clientAt(0).readyToExit = true; g.state.intermissionTime = 1; g.state.time = 100000;
    g.match.checkIntermissionExit(); expect(g.state.intermissionTime).toBe(1); expect(g.calls).toEqual([]);
  });
  test("normal map exit resets shared scores then persists sessions before connecting transition", () => {
    const f = fixture(); f.player(0, 20); f.player(1, 99, Team.TEAM_FREE, ConnectionState.CONNECTING);
    f.teamScores.set(Team.TEAM_RED, 5); f.teamScores.set(Team.TEAM_BLUE, 7); f.teamScores.set(Team.TEAM_FREE, 11);
    f.match.exitLevel(); expect(f.calls).toEqual(["bot-end-match", "console:vstr nextmap\n", "sessions:2:0"]);
    expect(f.pool.clientAt(0).pers.connected).toBe(ConnectionState.CONNECTING); expect(f.pool.clientAt(1).ps.persistant.get(PersistentIndex.PERS_SCORE)).toBe(99);
    expect([...f.teamScores.copy()]).toEqual([11, 0, 0, 0]);
  });
  test("tournament exit demotes loser and queues one restart without score reset", () => {
    const f = fixture("baseq3", GameType.GT_TOURNAMENT); f.player(0, 9); f.player(1, 2); f.match.calculateRanks(); f.calls.length = 0;
    f.state.intermissionTime = 1000; f.match.exitLevel(); expect(f.pool.clientAt(1).sess.sessionTeam).toBe(Team.TEAM_SPECTATOR);
    expect(f.state.restarted).toBe(true); expect(f.pool.clientAt(0).ps.persistant.get(PersistentIndex.PERS_SCORE)).toBe(9);
    f.match.exitLevel(); expect(f.calls.filter(call => call === "console:map_restart 0\n")).toHaveLength(1);
    expect(f.calls.filter(call => call === "bot-end-match")).toHaveLength(2);
  });
  test("sudden death precedes limits, warmup suppresses time only, queued intermission preserves delay", () => {
    const f = fixture(); f.player(0, 5); f.player(1, 5); f.match.calculateRanks(); f.settings.fragLimit = 5; f.settings.timeLimit = 1; f.state.time = 60000;
    f.match.checkExitRules(); expect(f.state.intermissionQueued).toBe(0);
    f.pool.clientAt(0).ps.persistant.set(PersistentIndex.PERS_SCORE, 6); f.state.warmupTime = -1; f.match.calculateRanks();
    expect(f.state.intermissionQueued).toBe(60000); expect(f.calls).toContain("log:Exit: Fraglimit hit.\n");
    f.state.time = 60999; f.match.checkExitRules(); expect(f.state.intermissionTime).toBe(0);
    f.state.time++; f.match.checkExitRules(); expect(f.state.intermissionQueued).toBe(0); expect(f.state.intermissionTime).toBe(61000);
  });
  test("time limit permits fewer than two players and objective capture limits cover all modes", () => {
    const f = fixture(); f.player(0); f.match.calculateRanks(); f.settings.timeLimit = 1; f.state.time = 60000; f.match.checkExitRules();
    expect(f.state.intermissionQueued).toBe(60000); expect(f.calls).toContain('send:-1:print "Timelimit hit.\n"');
    for (const mode of [GameType.GT_CTF, GameType.GT_1FCTF, GameType.GT_OBELISK, GameType.GT_HARVESTER]) {
      const g = fixture("missionpack", mode); g.player(0, 100, Team.TEAM_RED); g.player(1, 200, Team.TEAM_BLUE);
      g.settings.fragLimit = 1; g.settings.captureLimit = 5; g.teamScores.set(Team.TEAM_BLUE, 5); g.match.calculateRanks();
      expect(g.state.intermissionQueued).toBe(1000); expect(g.calls).toContain('send:-1:print "Blue hit the capturelimit.\n"');
    }
  });
  test("Team Arena single-player victory/log loss and five-second queued delay", () => {
    const f = fixture("missionpack", GameType.GT_TOURNAMENT); f.variant.singlePlayer = true; f.player(0, 1); f.player(1, 2).r.svFlags = ServerEntityFlags.BOT;
    f.match.calculateRanks(); f.match.logExit("test"); expect(f.calls).toContain("console:spLose\n");
    f.state.time = 5999; f.match.checkExitRules(); expect(f.state.intermissionTime).toBe(0);
    f.state.time++; f.match.checkExitRules(); expect(f.state.intermissionTime).toBe(6000);
    const g = fixture("missionpack", GameType.GT_CTF); g.variant.singlePlayer = true; g.teamScores.set(Team.TEAM_RED, 2); g.match.logExit("won");
    expect(g.calls.at(-1)).toBe("console:spWin\n"); g.teamScores.set(Team.TEAM_BLUE, 2); g.match.logExit("tied"); expect(g.calls.at(-1)).toBe("console:spLose\n");
  });
});

describe("votes, leaders and password cvars", () => {
  test("native original CheckVote fixtures preserve publication order and signed deadline wrap", () => {
    // Same unmodified native i386 g_main.c oracle as the rank corpus above.
    const expected = [[0, 0, 202, 8], [1, 0], [0, 4000, 201, 8], [0, 0, 202, 8],
      [0, 4000, 100, 201, 8], [0, -2147480650, 201, 8]];
    for (const [index, native] of expected.entries()) {
      const f = fixture(); f.state.numVotingClients = index === 0 ? 1 : 3;
      Object.assign(f.state.vote, { time: 1, yes: index === 0 ? 0 : index === 1 ? 1 : 2, no: index === 2 ? 1 : 0 });
      if (index === 3) f.state.time = 30001;
      if (index === 4) f.state.vote.executeTime = 999;
      if (index === 5) f.state.vote.time = f.state.time = 2147483646;
      f.match.checkVote();
      const events = f.calls.map(call => {
        if (call.startsWith("console:")) return 100;
        if (call.startsWith("send:")) return call.includes("passed") ? 201 : 202;
        if (call === "config:8:") return 8;
        throw new Error(`Unexpected reference vote effect ${call}`);
      });
      expect([f.state.vote.time, f.state.vote.executeTime, ...events]).toEqual(native);
    }
  });
  test("integer-majority vote threshold, delayed strict execution and timeout-before-majority ordering", () => {
    const f = fixture(); f.state.numVotingClients = 3; Object.assign(f.state.vote, { time: 1, yes: 1, no: 0, string: "map q3dm1" });
    f.match.checkVote(); expect(f.state.vote.time).toBe(1);
    f.state.vote.no = 1; f.match.checkVote(); expect(f.state.vote.time).toBe(0); expect(f.calls).toContain('send:-1:print "Vote failed.\n"');
    f.calls.length = 0; Object.assign(f.state.vote, { time: 1000, yes: 2, no: 0 }); f.match.checkVote(); expect(f.state.vote.executeTime).toBe(4000);
    f.state.time = 4000; f.match.checkVote(); expect(f.calls.some(call => call.startsWith("console:"))).toBe(false);
    f.state.time++; f.match.checkVote(); expect(f.calls.at(-1)).toBe("console:map q3dm1\n");
    Object.assign(f.state.vote, { time: 1, yes: 3 }); f.state.time = 30001; f.match.checkVote();
    expect(f.calls.slice(-2)).toEqual(['send:-1:print "Vote failed.\n"', "config:8:"]);
  });
  test("one-voter zero-yes vote fails immediately and scheduled command executes before current vote", () => {
    const f = fixture(); f.state.numVotingClients = 1; Object.assign(f.state.vote, { time: 1, executeTime: 999, string: "g_gametype 3" });
    f.match.checkVote(); expect(f.calls).toEqual(["console:g_gametype 3\n", 'send:-1:print "Vote failed.\n"', "config:8:"]);
  });
  test("team vote passes globally, dispatches leader immediately and clears correct config slot", () => {
    const f = fixture(); f.player(0, 0, Team.TEAM_RED); f.player(1, 0, Team.TEAM_RED); f.pool.clientAt(0).sess.teamLeader = true;
    f.state.numTeamVotingClients[0] = 2; Object.assign(f.state.teamVotes[0], { time: 1, yes: 2, string: "leader 1" });
    f.match.checkTeamVote(Team.TEAM_RED); expect(f.pool.clientAt(0).sess.teamLeader).toBe(false); expect(f.pool.clientAt(1).sess.teamLeader).toBe(true);
    expect(f.calls.slice(0, 3)).toEqual(['send:-1:print "Team vote passed.\n"', "userinfo:0", "userinfo:1"]);
    expect(f.calls.at(-1)).toBe("config:12:");
    f.state.numTeamVotingClients[1] = 2; Object.assign(f.state.teamVotes[1], { time: 1, yes: 2, string: "say blue" });
    f.match.checkTeamVote(Team.TEAM_BLUE); expect(f.calls.slice(-2)).toEqual(["console:say blue\n", "config:13:"]);
    f.calls.length = 0; f.match.checkTeamVote(Team.TEAM_FREE); expect(f.calls).toEqual([]);
  });
  test("team vote waiting, no threshold and timeout branches do not execute a rejected command", () => {
    const f = fixture(); f.state.numTeamVotingClients[1] = 5; Object.assign(f.state.teamVotes[1], { time: 1, yes: 2, no: 1, string: "say no" });
    f.match.checkTeamVote(Team.TEAM_BLUE); expect(f.calls).toEqual([]);
    f.state.teamVotes[1].no = 2; f.match.checkTeamVote(Team.TEAM_BLUE); expect(f.calls).toEqual(['send:-1:print "Team vote failed.\n"', "config:13:"]);
    f.calls.length = 0; Object.assign(f.state.teamVotes[1], { time: 1, yes: 5, no: 0 }); f.state.time = 30001;
    f.match.checkTeamVote(Team.TEAM_BLUE); expect(f.calls).toEqual(['send:-1:print "Team vote failed.\n"', "config:13:"]);
  });
  test("source leader fallback can select both bot and human and does not refresh userinfo", () => {
    const f = fixture(); f.player(0, 0, Team.TEAM_RED).r.svFlags = ServerEntityFlags.BOT; f.player(1, 0, Team.TEAM_RED);
    f.match.checkTeamLeader(Team.TEAM_RED); expect(f.pool.clientAt(0).sess.teamLeader).toBe(true); expect(f.pool.clientAt(1).sess.teamLeader).toBe(true);
    expect(f.calls).toEqual([]);
    f.pool.clientAt(1).pers.connected = ConnectionState.DISCONNECTED; f.match.setLeader(Team.TEAM_RED, 1);
    expect(f.calls).toEqual(['send:0:print "player1 is not connected\n"', 'send:1:print "player1 is not connected\n"']);
  });
  test("password modification tracking is per runtime and case-insensitive none disables needpass", () => {
    const f = fixture(); f.match.checkCvars(); f.match.checkCvars(); expect(f.calls).toEqual(["cvar:g_needpass:0"]);
    f.settings.password = "secret"; f.match.checkCvars(); expect(f.calls).toHaveLength(1);
    f.settings.passwordModificationCount++; f.match.checkCvars(); expect(f.calls.at(-1)).toBe("cvar:g_needpass:1");
    f.settings.password = "NoNe"; f.settings.passwordModificationCount++; f.match.checkCvars(); expect(f.calls.at(-1)).toBe("cvar:g_needpass:0");
    const g = fixture(); g.match.checkCvars(); expect(g.calls).toEqual(["cvar:g_needpass:0"]);
  });
});
