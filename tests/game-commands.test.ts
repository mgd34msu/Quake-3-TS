import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { vec3 } from "../src/core/math.ts";
import { tokenizeCommand } from "../src/core/text.ts";
import { concatCommandArgs, GameCommandError, GameCommandRuntime } from "../src/game/commands.ts";
import type { GameCommandHost } from "../src/game/commands.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { EntityPool, initGameEntity } from "../src/game/entities.ts";
import { ItemRegistry } from "../src/game/item-lifecycle.ts";
import type { ItemLifecycleContext } from "../src/game/item-lifecycle.ts";
import { MatchState } from "../src/game/match.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { GameRuntime } from "../src/game/runtime.ts";
import type { GameRuntimeOwner } from "../src/game/runtime.ts";
import { ConnectionState, GameFlags, SpectatorState } from "../src/game/state.ts";
import { ServerWorld } from "../src/server/world.ts";
import { EntityEvent, GameType, PersistentIndex, Team, Weapon, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ServerEntityFlags } from "../src/shared/entity-shared.ts";
import { MoveFlags, PlayerStateSlots } from "../src/shared/player-state.ts";

function liveCommands(product: Product, gameType = GameType.GT_FFA) {
  const bounds = { min: vec3(-4096, -4096, -512), max: vec3(4096, 4096, 1024) };
  const planes = [{ normal: vec3(1, 0, 0), distance: 4096 }, { normal: vec3(-1, 0, 0), distance: 4096 },
    { normal: vec3(0, 1, 0), distance: 4096 }, { normal: vec3(0, -1, 0), distance: 4096 },
    { normal: vec3(0, 0, 1), distance: 0 }, { normal: vec3(0, 0, -1), distance: 512 }];
  const map: BspMap = { ...emptyMap(), entities: `{ "classname" "worldspawn" }
    { "classname" "info_player_deathmatch" "origin" "-300 0 24" }
    { "classname" "info_player_deathmatch" "origin" "300 0 24" }
    { "classname" "info_player_intermission" "origin" "0 0 300" }`,
    shaders: [{ name: "floor", surfaceFlags: 0, contentFlags: 1 }], planes,
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    leafBrushes: [0], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_, plane) => ({ plane, shader: 0 })) };
  const cvars = new CvarRegistry(), users = new Map<number, string>(), configs = new Map<number, string>();
  const sends: { client: number; text: string }[] = [], console: string[] = [];
  for (const [name, value] of [["sv_maxclients", "4"], ["g_gametype", String(gameType)], ["sv_cheats", "1"],
    ["g_log", ""], ["bot_enable", "0"], ["g_teamAutoJoin", "1"], ["g_doWarmup", "0"]] satisfies readonly (readonly [string, string])[]) cvars.set(name, value, true);
  for (let slot = 0; slot < 4; slot++) users.set(slot, `\\name\\Live${slot}\\ip\\localhost\\handicap\\100\\model\\sarge/default`);
  const owner: GameRuntimeOwner = { game: null };
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const worldPrints: string[] = [];
  const world = new ServerWorld(collision, collision.modelBounds(0), number => owner.game?.data.entity(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  const runtime = GameRuntime.create({ product, map, collision, world, cvars, levelTime: 1000, randomSeed: 42,
    restart: false, buildDate: "Sep  5 2026", configstrings: { get: index => configs.get(index) ?? "", set: (index, value) => { configs.set(index, value); } },
    botFactory: { kind: "unavailable", reason: "Command tests disable bots" },
    engine: { milliseconds: () => 0, print: () => {}, sendServerCommand: (client, text) => { sends.push({ client, text }); },
      dropClient: () => { throw new Error("Unexpected drop"); },
      getUserinfo: slot => { const value = users.get(slot); if (value === undefined) throw new Error("Missing userinfo"); return value; },
      setUserinfo: (slot, value) => { users.set(slot, value); },
      getUserCommand: () => ({ serverTime: 1000, angles: vec3(0, 0, 0), buttons: 0, weapon: Weapon.WP_MACHINEGUN, forwardmove: 0, rightmove: 0, upmove: 0 }),
      appendConsoleCommand: text => { console.push(text); }, insertConsoleCommand: text => { console.unshift(text); }, executeConsoleNow: () => {},
      openLog: () => { throw new Error("Logging disabled"); } } }, owner);
  function join(slot: number) { expect(runtime.clientConnect(slot, true, false)).toBeNull(); runtime.clientBegin(slot); return runtime.pool.at(slot); }
  return { runtime, configs, sends, console, join, run: (line: string, slot = 0) => runtime.clientCommand(slot, tokenizeCommand(line)) };
}

interface OracleEvent { readonly kind: string; readonly slot: number; readonly text: string }

function emptyMap(): BspMap {
  const bounds = { min: vec3(-10000, -10000, -10000), max: vec3(10000, 10000, 10000) };
  return { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}

function setup(product: Product = "baseq3", maxClients = 4) {
  const state = new MatchState(); state.time = 120000; state.numConnectedClients = maxClients; state.numNonSpectatorClients = maxClients;
  const settings = { gameType: GameType.GT_FFA, cheats: true, teamForceBalance: false, maxGameClients: 0, dedicated: false, allowVote: true };
  const sends: { client: number; text: string }[] = [], configs = new Map<number, string>(), console: string[] = [], logs: string[] = [], prints: string[] = [], calls: string[] = [];
  const events: OracleEvent[] = [];
  const cvars = new Map<string, string>(), userinfo = new Map<number, string>();
  const pool = new EntityPool({ print: text => { prints.push(text); }, product, maxClients, mapStartTime: 0, time: () => state.time,
    link: entity => { world.link(entity); }, unlink: entity => { world.unlink(entity.slot); } });
  const worldPrints: string[] = [];
  const collision = new CollisionWorld(emptyMap(), { kind: "unaccounted" }, { kind: "disabled" }), world = new ServerWorld(collision, collision.modelBounds(0), slot => pool.get(slot), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  const teamScores = new PlayerStateSlots(4), random = new GameRandom();
  const combatServices = { entities: pool, world, get time() { return state.time; }, intermissionQueued: 0,
    get gameType() { return settings.gameType; }, friendlyFire: false, knockback: 1000, debugDamage: null,
    checkHurtCarrier: () => { calls.push("hurtCarrier"); }, logAccuracyHit: () => false };
  const combat: CombatContext = product === "baseq3" ? { ...combatServices, product } : { ...combatServices, product,
    checkObeliskAttack: () => false, invulnerabilityEffect: () => { throw new Error("Unexpected invulnerability effect"); } };
  const items: ItemLifecycleContext = { entities: pool, world, product, get gameType() { return settings.gameType; },
    weaponRespawnSeconds: 5, teamWeaponRespawnSeconds: 30, handicapForClient: () => "100", teamPickup: () => { throw new Error("Unexpected team pickup"); },
    useTargets: () => { calls.push("itemTargets"); }, soundIndex: () => 1, random, registry: new ItemRegistry(product),
    log: text => { logs.push(text); }, warn: text => { prints.push(text); } };
  const local: { location: string | null } = { location: null };
  const host: GameCommandHost = { pool, state, teamScores, settings, items, teleport: { combat, world },
    imports: {
      sendServerCommand: (client, text) => { sends.push({ client, text }); events.push({ kind: "send", slot: client, text }); },
      setConfigstring: (index, text) => { configs.set(index, text); events.push({ kind: "config", slot: index, text }); },
      appendConsoleCommand: text => { console.push(text); events.push({ kind: "console", slot: 2, text }); }, getCvar: name => cvars.get(name) ?? "", getUserinfo: slot => userinfo.get(slot) ?? "",
      setUserinfo: (slot, text) => { userinfo.set(slot, text); }, log: text => { logs.push(text); events.push({ kind: "log", slot: 0, text }); }, print: text => { prints.push(text); },
    },
    team: { getLocationMessage: () => local.location },
    death: { playerDie: (entity, inflictor, attacker, damage, method) => {
      calls.push(`death:${entity.slot}:${inflictor?.slot}:${attacker?.slot}:${damage}:${method}:${entity.health}:${pool.clientAt(entity.slot).sess.sessionTeam}`);
    } },
    spawn: { copyToBodyQueue: entity => { calls.push(`body:${entity.slot}`); return null; } },
    admission: { begin: slot => { calls.push(`begin:${slot}`); }, userinfoChanged: slot => { calls.push(`userinfo:${slot}`); } },
    match: { beginIntermission: () => { calls.push("intermission"); }, setLeader: (team, slot) => { calls.push(`leader:${team}:${slot}`); },
      checkTeamLeader: team => { calls.push(`checkLeader:${team}`); } },
  };
  const commands = new GameCommandRuntime(host);
  for (let slot = 0; slot < maxClients; slot++) {
    const entity = pool.at(slot), client = pool.clientAt(slot); initGameEntity(entity);
    entity.health = 100; client.pers.connected = ConnectionState.CONNECTED; client.pers.netname = `player${slot}`;
    client.ps.clientNum = slot; client.ps.stats.set(statSchema(product).health, 100); client.ps.stats.set(statSchema(product).maxHealth, 100);
    client.lastKilledClient = -1;
    state.sortedClients[slot] = slot;
    userinfo.set(slot, `\\name\\player${slot}\\handicap\\100`);
  }
  const entity = pool.at(0), client = pool.clientAt(0);
  return { product, state, settings, pool, world, host, commands, sends, configs, console, logs, prints, calls, cvars, userinfo, teamScores, local, entity, client, events,
    run: (line: string, slot = 0) => commands.dispatch(slot, tokenizeCommand(line)) };
}

describe("game command argument and scoreboard source rules", () => {
  test("ConcatArgs preserves bounded argument copies and overflow's preceding space", () => {
    expect(concatCommandArgs(["say", "a", "b"], 1)).toBe("a b");
    expect(concatCommandArgs(["say", "a".repeat(1022), "b"], 1)).toBe("a".repeat(1022) + " ");
    expect(concatCommandArgs(["say", "a".repeat(1023)], 1)).toBe("");
    expect(concatCommandArgs(["say", "hi\0ignored", "there"], 1)).toBe("hi there");
    expect(() => concatCommandArgs(["say", "snowman ☃"], 1)).toThrow(GameCommandError);
  });

  test("scoreboard publishes sorted fourteen-field rows and caps connecting/ping values", () => {
    const f = setup(); f.state.numConnectedClients = 2; f.state.sortedClients[0] = 1; f.state.sortedClients[1] = 0;
    const other = f.pool.clientAt(1); other.pers.connected = ConnectionState.CONNECTING; other.pers.enterTime = 1;
    other.ps.persistant.set(PersistentIndex.PERS_SCORE, 9); other.ps.persistant.set(PersistentIndex.PERS_RANK, 1);
    f.client.ps.ping = 1024; f.client.accuracyHits = 2; f.client.accuracyShots = 3; f.client.pers.enterTime = 30000;
    f.client.ps.persistant.set(PersistentIndex.PERS_CAPTURES, 5); f.entity.s.powerups = 32;
    f.teamScores.set(Team.TEAM_RED, 12); f.teamScores.set(Team.TEAM_BLUE, -3);
    f.run("score");
    expect(f.sends).toEqual([{ client: 0, text: "scores 2 12 -3 1 9 -1 1 0 0 0 0 0 0 0 0 0 0 0 0 999 1 0 32 66 0 0 0 0 0 1 5" }]);
  });

  test("scoreboard stops before exceeding its 1024-byte row payload", () => {
    const f = setup("baseq3", 64);
    for (let slot = 0; slot < 64; slot++) for (let index = 0; index < 16; index++) f.pool.clientAt(slot).ps.persistant.set(index, 2147483647);
    f.run("score");
    const text = f.sends[0]?.text;
    if (text === undefined) throw new Error("Missing scoreboard");
    expect(text.startsWith("scores 11 0 0 ")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(1040);
  });

  test("numeric client names use atoi prefix; name lookup recognizes ESC rather than caret colors", () => {
    const f = setup(); f.pool.clientAt(1).pers.netname = "\x1b1MiXeD\t";
    expect(f.commands.clientNumberFromString(f.entity, "1tail")).toBe(1);
    expect(f.commands.clientNumberFromString(f.entity, "mixed")).toBe(1);
    f.pool.clientAt(1).pers.netname = "^1Mixed";
    expect(f.commands.clientNumberFromString(f.entity, "mixed")).toBeNull();
    expect(f.commands.clientNumberFromString(f.entity, "^1mixed")).toBe(1);
    expect(() => f.commands.clientNumberFromString(f.entity, "bad\x1b")).toThrow("terminating NUL");
  });
});

// Rebuilds unchanged g_cmds.c/bg_misc.c/q_math.c/q_shared.c for each product and
// executes them in the original 1.32b QVM interpreter with recording trap imports.
// Q3_COMMAND_ORACLE=/tmp/quake3-commands-reference-DZPcJd/build-run.sh bun test tests/game-commands.test.ts
const oraclePath = Bun.env["Q3_COMMAND_ORACLE"];
for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  test.skipIf(oraclePath === undefined)(`${product} live original QVM command output agrees byte-for-byte`, () => {
    if (oraclePath === undefined) throw new Error("Q3_COMMAND_ORACLE is required");
    const reference = Bun.spawnSync(["bash", oraclePath, product], { stdout: "pipe", stderr: "pipe" });
    expect(reference.exitCode).toBe(0);
    const output = reference.stdout.toString() + reference.stderr.toString();
    expect(output).toContain("COMMAND QVM DONE");
    const recorded = new Map<string, OracleEvent[]>();
    for (const line of output.split("\n")) {
      if (!line.startsWith("CMD_ORACLE ")) continue;
      const [, scenario, kind, slot, hex] = line.split(" ");
      if (scenario === undefined || kind === undefined || slot === undefined || hex === undefined) throw new Error("Malformed QVM oracle row");
      const events = recorded.get(scenario) ?? [];
      events.push({ kind, slot: Number(slot), text: Buffer.from(hex, "hex").toString("latin1") });
      recorded.set(scenario, events);
    }
    expect(recorded.size).toBe(8);
    function compare(scenario: string, f: ReturnType<typeof setup>): void {
      const expected = recorded.get(scenario);
      if (expected === undefined) throw new Error(`QVM oracle omitted ${scenario}`);
      expect(f.events).toEqual(expected);
    }
    const score = setup(product); score.state.numConnectedClients = 2; score.state.sortedClients[0] = 1; score.state.sortedClients[1] = 0;
    const other = score.pool.clientAt(1); other.pers.connected = ConnectionState.CONNECTING; other.pers.enterTime = 1;
    other.ps.persistant.set(PersistentIndex.PERS_SCORE, 9); other.ps.persistant.set(PersistentIndex.PERS_RANK, 1);
    score.client.ps.ping = 1024; score.client.accuracyHits = 2; score.client.accuracyShots = 3; score.client.pers.enterTime = 30000;
    score.client.ps.persistant.set(PersistentIndex.PERS_CAPTURES, 5); score.entity.s.powerups = 32;
    score.teamScores.set(Team.TEAM_RED, 12); score.teamScores.set(Team.TEAM_BLUE, -3); score.run("score"); compare("scoreboard", score);
    const vote = setup(product); vote.run("callvote fraglimit 10"); vote.run("vote Y", 1); vote.run("vote 1", 2); vote.run("vote xY", 3);
    vote.events.push({ kind: "state", slot: 0, text: `${vote.state.vote.yes} ${vote.state.vote.no} ${vote.client.pers.voteCount}` }); compare("vote", vote);
    const map = setup(product); map.cvars.set("nextmap", "map q3dm2"); map.run("callvote map q3dm1"); compare("map", map);
    const chat = setup(product); chat.commands.dispatch(0, ["say", 'hello "quoted"']); compare("chat", chat);
    const team = setup(product); team.settings.gameType = GameType.GT_CTF; team.client.sess.sessionTeam = Team.TEAM_RED;
    team.pool.clientAt(1).sess.sessionTeam = Team.TEAM_RED; team.pool.clientAt(2).sess.sessionTeam = Team.TEAM_BLUE; team.local.location = "^1Red Base^7";
    team.run("say_team defend"); team.run("tell 1 hello"); compare("teamchat", team);
    const voice = setup(product); voice.pool.clientAt(1).pers.connected = ConnectionState.CONNECTING;
    voice.run("vosay defend"); voice.run("votell 1 defend"); compare("voice", voice);
    const name = setup(product); name.pool.clientAt(1).pers.netname = "\x1b1MiXeD\t";
    name.events.push({ kind: "slot", slot: 0, text: String(name.commands.clientNumberFromString(name.entity, "mixed") ?? -1) });
    name.pool.clientAt(1).pers.netname = "^1Mixed";
    name.events.push({ kind: "slot", slot: 0, text: String(name.commands.clientNumberFromString(name.entity, "mixed") ?? -1) }); compare("name", name);
    const give = setup(product), schema = statSchema(product); give.entity.health = 20; give.client.ps.stats.set(schema.health, 20); give.run("give all");
    give.events.push({ kind: "state", slot: 0, text: [give.entity.health, give.client.ps.stats.get(schema.health), give.client.ps.stats.get(schema.weapons),
      give.client.ps.stats.get(schema.armor), give.client.ps.ammo.get(0), give.client.ps.ammo.get(15)].join(" ") }); compare("give", give);
  });
}

describe("chat, voice and dispatch", () => {
  test("chat preserves raw quotes, control delimiters and the 149-byte payload", () => {
    const f = setup(); f.commands.dispatch(0, ["say", 'hello "quoted"', "x".repeat(200)]);
    const text = 'hello "quoted" ' + "x".repeat(134);
    expect(f.sends).toEqual([0, 1, 2, 3].map(client => ({ client, text: `chat "player0^7\x19: ^2${text}"` })));
    expect(f.logs[0]).toBe('say: player0: hello "quoted" ' + "x".repeat(200) + "\n");
  });

  test("team messages include location and filter teams, while tell echoes to sender", () => {
    const f = setup(); f.settings.gameType = GameType.GT_CTF; f.local.location = "^1Red Base^7";
    f.client.sess.sessionTeam = Team.TEAM_RED; f.pool.clientAt(1).sess.sessionTeam = Team.TEAM_RED; f.pool.clientAt(2).sess.sessionTeam = Team.TEAM_BLUE;
    f.run("say_team defend");
    expect(f.sends).toEqual([0, 1].map(client => ({ client, text: 'tchat "\x19(player0^7\x19) (^1Red Base^7)\x19: ^5defend"' })));
    f.sends.length = 0; f.run("tell 1 hello");
    expect(f.sends).toEqual([1, 0].map(client => ({ client, text: 'chat "\x19[player0^7\x19] (^1Red Base^7)\x19: ^6hello"' })));
    f.sends.length = 0; f.entity.r.svFlags |= ServerEntityFlags.BOT; f.run("tell 1 hello");
    expect(f.sends.map(send => send.client)).toEqual([1]);
  });

  test("tournament spectator text reaches only spectators; all tournament voice is suppressed", () => {
    const f = setup(); f.settings.gameType = GameType.GT_TOURNAMENT; f.client.sess.sessionTeam = Team.TEAM_SPECTATOR;
    f.run("say hello"); expect(f.sends.map(send => send.client)).toEqual([0]);
    f.sends.length = 0; f.run("vsay taunt"); expect(f.sends).toEqual([]);
  });

  test("voice sends ASCII color numbers and includes connecting clients as in source", () => {
    const f = setup(); f.pool.clientAt(1).pers.connected = ConnectionState.CONNECTING;
    f.run("vosay defend");
    expect(f.sends).toEqual([0, 1, 2, 3].map(client => ({ client, text: "vchat 1 0 50 defend" })));
    f.sends.length = 0; f.run("votell 1 defend");
    expect(f.sends).toEqual([1, 0].map(client => ({ client, text: "vtell 1 0 54 defend" })));
  });

  test("voice taunt prioritizes killer, kill reward and teammate praise", () => {
    const f = setup(), enemy = f.pool.at(1); f.entity.enemy = enemy; f.pool.clientAt(1).lastKilledClient = 0;
    f.run("vtaunt"); expect(f.entity.enemy).toBeNull(); expect(f.sends.map(send => send.text)).toEqual(["vtell 0 0 54 death_insult", "vtell 0 0 54 death_insult"]);
    f.sends.length = 0; f.client.lastKilledClient = 1; f.pool.clientAt(1).lastHurtMod = 2;
    f.run("vtaunt"); expect(f.client.lastKilledClient).toBe(-1); expect(f.sends[0]?.text).toBe("vtell 0 0 54 kill_gauntlet");
    f.sends.length = 0; f.settings.gameType = GameType.GT_TEAM; f.pool.clientAt(1).rewardTime = f.state.time + 1;
    f.run("vtaunt"); expect(f.sends[0]?.text).toBe("vtell 0 0 54 praise");
  });

  test("intermission converts non-chat/score commands to chat and stats remains source-empty", () => {
    const f = setup(); f.run("stats"); expect(f.sends).toEqual([]);
    f.state.intermissionTime = 1; f.run("god");
    expect(f.entity.flags & GameFlags.GODMODE).toBe(0); expect(f.sends[0]?.text).toBe('chat "player0^7\x19: ^2god"');
    f.state.intermissionTime = 0; f.sends.length = 0; f.run("unknown"); expect(f.sends[0]?.text).toBe('print "unknown cmd unknown\n"');
    expect(() => f.run("gc 1 7")).toThrow("beyond the source order table");
  });
});

describe("source vote mutation", () => {
  test("map votes preserve map rotation, reset voter flags, and do not increment source voteCount", () => {
    const f = setup(); f.cvars.set("nextmap", "map q3dm2"); f.pool.clientAt(1).ps.eFlags = 0x4000 | 4;
    f.run("callvote map q3dm1 ignored");
    expect(f.state.vote.string).toBe('map q3dm1; set nextmap "map q3dm2"');
    expect(f.state.vote).toEqual({ time: 120000, yes: 1, no: 0, string: 'map q3dm1; set nextmap "map q3dm2"', displayString: 'map q3dm1; set nextmap "map q3dm2"', executeTime: 0 });
    expect(f.client.pers.voteCount).toBe(0); expect(f.client.ps.eFlags & 0x4000).toBe(0x4000); expect(f.pool.clientAt(1).ps.eFlags).toBe(4);
    expect([...f.configs]).toEqual([[8, "120000"], [9, 'map q3dm1; set nextmap "map q3dm2"'], [10, "1"], [11, "0"]]);
  });

  test("pending votes execute before checking new gametype and semicolon rejection precedes execution", () => {
    const f = setup(); f.state.vote.executeTime = 130000; f.state.vote.string = "map_restart 0";
    f.run('callvote map "q3dm1;quit"'); expect(f.console).toEqual([]);
    f.run("callvote g_gametype 2"); expect(f.console).toEqual(["map_restart 0\n"]); expect(f.state.vote.executeTime).toBe(0); expect(f.state.vote.time).toBe(0);
    f.run("callvote g_gametype 7"); expect(f.state.vote.displayString).toBe("g_gametype Harvester");
  });

  test("votes reproduce the source's second-character uppercase/digit checks", () => {
    const f = setup(); f.run("callvote fraglimit 10");
    f.run("vote Y", 1); f.run("vote 1", 2); f.run("vote xY", 3);
    expect([f.state.vote.yes, f.state.vote.no]).toEqual([2, 2]);
    f.run("vote yes", 1); expect(f.sends.at(-1)?.text).toBe('print "Vote already cast.\n"');
  });

  test("team votes retain separate shared state and clean player colors for name matching", () => {
    const f = setup(); f.settings.gameType = GameType.GT_TEAM; f.client.sess.sessionTeam = Team.TEAM_RED;
    f.pool.clientAt(1).sess.sessionTeam = Team.TEAM_RED; f.pool.clientAt(1).pers.netname = "^1Two Words";
    f.pool.clientAt(2).sess.sessionTeam = Team.TEAM_BLUE; f.pool.clientAt(3).sess.sessionTeam = Team.TEAM_BLUE;
    f.run("callteamvote leader Two Words"); f.run("teamvote x1", 1);
    f.run("callteamvote leader 3", 2); f.run("teamvote N", 3);
    expect(f.state.teamVotes).toEqual([{ time: 120000, yes: 2, no: 0, string: "leader 1" }, { time: 120000, yes: 1, no: 1, string: "leader 3" }]);
    expect(f.configs.get(14)).toBe("leader 1"); expect(f.configs.get(15)).toBe("leader 3");
    expect(f.client.pers.teamVoteCount).toBe(0);
  });
});

describe("cheats and team/follow service boundaries", () => {
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) test(`${product} give uses product slots, 16 ammo slots and distinct health write semantics`, () => {
    const f = setup(product), schema = statSchema(product); f.entity.health = 20; f.client.ps.stats.set(schema.health, 20);
    f.run("give all"); expect(f.entity.health).toBe(100); expect(f.client.ps.stats.get(schema.health)).toBe(20);
    expect(f.client.ps.stats.get(schema.armor)).toBe(200); expect(f.client.ps.stats.get(schema.weapons)).toBe(product === "baseq3" ? 1022 : 15358);
    expect(f.client.ps.ammo.copy()).toEqual(new Int32Array(16).fill(999));
    f.run("give excellent"); expect(f.client.ps.persistant.get(PersistentIndex.PERS_EXCELLENT_COUNT)).toBe(1);
    f.run("god"); expect(f.entity.flags & GameFlags.GODMODE).toBe(GameFlags.GODMODE); f.run("noclip"); expect(f.client.noclip).toBe(true);
    f.settings.cheats = false; f.run("notarget"); expect(f.sends.at(-1)?.text).toBe('print "Cheats are not enabled on this server.\n"');
  });

  test("kill strips godmode and calls actual death contract after both health fields change", () => {
    const f = setup(); f.entity.flags |= GameFlags.GODMODE; f.run("kill");
    expect(f.entity.health).toBe(-999); expect(f.client.ps.stats.get(statSchema(f.product).health)).toBe(-999);
    expect(f.calls).toEqual(["death:0:0:0:100000:20:-999:0"]); expect(f.entity.flags & GameFlags.GODMODE).toBe(0);
  });

  test("team changes preserve body/death/session/leader/admission ordering and five-second gate", () => {
    const f = setup(); f.settings.gameType = GameType.GT_TEAM; f.client.sess.sessionTeam = Team.TEAM_RED;
    f.client.ps.stats.set(statSchema(f.product).health, 0); f.run("team blue");
    expect(f.calls).toEqual(["body:0", "death:0:0:0:100000:20:0:1", "leader:2:0", "checkLeader:1", "userinfo:0", "begin:0"]);
    expect(Number(f.client.sess.sessionTeam)).toBe(Team.TEAM_BLUE); expect(f.client.switchTeamTime).toBe(125000);
    f.run("team red"); expect(f.sends.at(-1)?.text).toBe('print "May not switch teams more than once per 5 seconds.\n"');
  });

  test("force-balance refuses the change before death but still sets command cooldown", () => {
    const f = setup(); f.settings.gameType = GameType.GT_TEAM; f.settings.teamForceBalance = true; f.client.sess.sessionTeam = Team.TEAM_SPECTATOR;
    f.pool.clientAt(1).sess.sessionTeam = Team.TEAM_RED; f.pool.clientAt(2).sess.sessionTeam = Team.TEAM_RED;
    f.run("team red"); expect(f.calls).toEqual([]); expect(f.client.sess.sessionTeam).toBe(Team.TEAM_SPECTATOR); expect(f.client.switchTeamTime).toBe(125000);
    expect(f.sends).toEqual([{ client: 0, text: 'cp "Red team has too many players.\n"' }]);
  });

  test("disconnected former team leaders do not prevent appointing the arriving player", () => {
    const f = setup(); f.settings.gameType = GameType.GT_TEAM; f.client.sess.sessionTeam = Team.TEAM_RED;
    const departed = f.pool.clientAt(1); departed.pers.connected = ConnectionState.DISCONNECTED;
    departed.sess.sessionTeam = Team.TEAM_BLUE; departed.sess.teamLeader = true;
    f.run("team blue"); expect(f.calls).toContain("leader:2:0");
  });

  test("follow cycling wraps slots, stops following restores identity, and sentinel hangs reject explicitly", () => {
    const f = setup(); f.client.sess.sessionTeam = Team.TEAM_SPECTATOR; f.client.sess.spectatorState = SpectatorState.FREE;
    f.client.sess.spectatorClient = 3; f.run("follownext"); expect(f.client.sess.spectatorClient).toBe(1);
    f.client.ps.pmFlags |= MoveFlags.FOLLOW; f.client.ps.clientNum = 1; f.entity.r.svFlags |= ServerEntityFlags.BOT; f.run("follow");
    expect(f.client.ps.clientNum).toBe(0); expect(f.client.ps.pmFlags & MoveFlags.FOLLOW).toBe(0); expect(f.entity.r.svFlags & ServerEntityFlags.BOT).toBe(0);
    for (let slot = 0; slot < 4; slot++) f.pool.clientAt(slot).sess.sessionTeam = Team.TEAM_SPECTATOR;
    f.client.sess.spectatorClient = -1; expect(() => f.run("follownext")).toThrow("cannot terminate");
  });

  test("teamtask updates engine userinfo and where truncates stored entity origin", () => {
    const f = setup(); f.run("teamtask 3tail"); expect(f.userinfo.get(0)).toBe("\\teamtask\\3\\name\\player0\\handicap\\100"); expect(f.calls).toEqual(["userinfo:0"]);
    f.entity.s.origin = vec3(1.9, -2.9, 3); f.run("where"); expect(f.sends.at(-1)?.text).toBe('print "(1 -2 3)\n"');
  });

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product} teamtask counts high-byte userinfo as source bytes`, () => {
      const f = setup(product), userinfo = `\\name\\${"\xff".repeat(600)}`;
      f.userinfo.set(0, userinfo);
      f.run("teamtask 3");
      expect(f.userinfo.get(0)).toBe(`\\teamtask\\3${userinfo}`);
      expect(f.prints).toEqual([]);
      expect(f.calls).toEqual(["userinfo:0"]);
    });

    test(`${product} teamtask overflow removes the old task and continues userinfo publication`, () => {
      const f = setup(product), remaining = `\\name\\${"x".repeat(1000)}`, events: string[] = [];
      f.userinfo.set(0, `\\teamtask\\1${remaining}`);
      f.host.imports.print = text => { events.push(`print:${text}`); };
      f.host.imports.setUserinfo = (slot, text) => { events.push(`set:${slot}`); f.userinfo.set(slot, text); };
      f.host.admission.userinfoChanged = slot => { events.push(`changed:${slot}:${f.userinfo.get(slot)}`); };
      f.run("teamtask 2147483647");
      expect(f.userinfo.get(0)).toBe(remaining);
      expect(events).toEqual(["print:Info string length exceeded\n", "set:0", `changed:0:${remaining}`]);
      expect(f.sends).toEqual([]);
    });
  }
});

describe("commands through the authoritative game runtime", () => {
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product} named give performs actual item spawn, pickup, event and free`, () => {
      const f = liveCommands(product), player = f.join(0), client = f.runtime.pool.clientAt(0), schema = statSchema(product);
      expect(client.ps.stats.get(schema.weapons) & (1 << Weapon.WP_ROCKET_LAUNCHER)).toBe(0);
      f.run('give "Rocket Launcher"');
      expect(client.ps.stats.get(schema.weapons) & (1 << Weapon.WP_ROCKET_LAUNCHER)).not.toBe(0);
      expect(client.ps.ammo.get(Weapon.WP_ROCKET_LAUNCHER)).toBe(10);
      expect(client.ps.externalEvent & 255).toBe(EntityEvent.EV_ITEM_PICKUP);
      expect(Array.from({ length: f.runtime.pool.numEntities }, (_, slot) => f.runtime.pool.at(slot))
        .filter(entity => entity.inuse && entity.classname === "weapon_rocketlauncher")).toEqual([]);
      player.health = 50; client.ps.stats.set(schema.health, 50); f.run('give "25 Health"');
      expect(player.health).toBe(75);
      f.runtime.shutdown(false);
    });

    test(`${product} setviewpos uses real teleport, killbox, death and rank services`, () => {
      const f = liveCommands(product), player = f.join(0), victim = f.join(1), client = f.runtime.pool.clientAt(0);
      const destination = { ...f.runtime.pool.clientAt(1).ps.origin }, flags = client.ps.eFlags;
      f.run(`setviewpos ${destination.x} ${destination.y} ${destination.z - 1} 90`);
      expect(client.ps.origin).toEqual(destination);
      expect(client.ps.velocity.y).toBeCloseTo(400); expect(client.ps.pmTime).toBe(160);
      expect((client.ps.eFlags ^ flags) & 4).toBe(4); expect(victim.health).toBeLessThanOrEqual(0);
      expect(client.ps.persistant.get(PersistentIndex.PERS_SCORE)).toBe(1);
      expect(f.runtime.level.sortedClients[0]).toBe(player.slot);
      f.run("kill"); expect(player.health).toBeLessThanOrEqual(0);
      expect(client.ps.persistant.get(PersistentIndex.PERS_SCORE)).toBe(0);
      f.runtime.shutdown(false);
    });

    test(`${product} team and follow update actual admission, leaders, ranks and configstrings`, () => {
      const f = liveCommands(product, GameType.GT_TEAM), player = f.join(0); f.join(1);
      const client = f.runtime.pool.clientAt(0), other = f.runtime.pool.clientAt(1), target = other.sess.sessionTeam;
      f.run(`team ${target === Team.TEAM_RED ? "red" : "blue"}`);
      expect(client.sess.sessionTeam).toBe(target); expect(player.health).toBe(125);
      expect(f.runtime.level.numPlayingClients).toBe(2); expect(client.switchTeamTime).toBe(6000);
      expect(f.configs.get(544)).toContain(`\\t\\${target}`);
      f.runtime.commands.setTeam(player, "spectator");
      expect(client.sess.sessionTeam).toBe(Team.TEAM_SPECTATOR); expect(f.runtime.level.numPlayingClients).toBe(1);
      f.run("follow 1"); expect(client.sess.spectatorState).toBe(SpectatorState.FOLLOW); expect(client.sess.spectatorClient).toBe(1);
      f.run("follow"); expect(client.sess.spectatorState).toBe(SpectatorState.FREE); expect(client.ps.clientNum).toBe(0);
      f.runtime.shutdown(false);
    });

    test(`${product} levelshot enters the real intermission before notifying its caller`, () => {
      const f = liveCommands(product); f.join(0); f.run("levelshot");
      expect(f.runtime.level.intermissionTime).toBe(1000);
      expect(f.runtime.pool.clientAt(0).ps.origin).toEqual(vec3(0, 0, 300));
      expect(f.sends.at(-1)).toEqual({ client: 0, text: "clientLevelShot" });
      f.runtime.shutdown(false);
    });

    test(`${product} command votes are resolved by the same live match state`, () => {
      const f = liveCommands(product, GameType.GT_TEAM), player = f.join(0); f.join(1);
      f.runtime.commands.setTeam(player, f.runtime.pool.clientAt(1).sess.sessionTeam === Team.TEAM_RED ? "red" : "blue");
      f.run("callvote fraglimit 7"); f.run("vote yes", 1);
      f.run("callteamvote leader 0"); f.run("teamvote yes", 1);
      f.runtime.runFrame(1100);
      expect(f.runtime.level.vote.time).toBe(0); expect(f.runtime.level.vote.executeTime).toBe(4100);
      expect(f.runtime.pool.clientAt(0).sess.teamLeader).toBe(true); expect(f.runtime.pool.clientAt(1).sess.teamLeader).toBe(false);
      expect(f.runtime.level.teamVotes.every(vote => vote.time === 0)).toBe(true);
      f.runtime.runFrame(4101); expect(f.console).toEqual(['fraglimit "7"\n']);
      f.runtime.shutdown(false);
    });
  }
});
