// Controlled retail-map verification for authoritative team and tournament modes.
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { vec3 } from "../src/core/math.ts";
import { damage } from "../src/game/combat.ts";
import type { GameRuntime } from "../src/game/runtime.ts";
import { ConnectionState, GameFlags } from "../src/game/state.ts";
import type { GameEntity } from "../src/game/state.ts";
import { GameType, PersistentIndex, Powerup, Team, Weapon } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { CommandButtons } from "../src/shared/player-state.ts";
import type { UserCommand } from "../src/shared/player-state.ts";
import { createGameVerificationHarness } from "./game-verification-harness.ts";

export interface GameModeVerificationOptions {
  readonly dataPath: string;
  readonly missionMap?: string;
  readonly tournamentMap?: string;
  readonly teamMap?: string;
}

type VerifiedMode = "one-flag" | "overload" | "harvester" | "tournament" | "team-deathmatch";

interface ScenarioSpec {
  readonly product: Product;
  readonly mode: VerifiedMode;
  readonly gameType: GameType;
  readonly mapName: string;
}

interface VerificationCheckpoint {
  readonly name: string;
  readonly time: number;
  readonly frame: number;
  readonly teamScores: readonly number[];
  readonly clients: readonly {
    readonly slot: number;
    readonly connected: ConnectionState;
    readonly team: Team;
    readonly health: number;
    readonly score: number;
    readonly captures: number;
    readonly tokens: number;
    readonly ready: boolean;
  }[];
}

interface ScenarioResult {
  readonly product: Product;
  readonly mode: VerifiedMode;
  readonly mapName: string;
  readonly gates: Readonly<Record<string, boolean>>;
  readonly actions: readonly string[];
  readonly replaySha256: string;
  readonly checkpoints: readonly VerificationCheckpoint[];
  readonly entityCount: number;
  readonly spawnOutcomes: number;
  readonly messages: readonly { readonly client: number; readonly text: string }[];
  readonly consoleCommands: readonly string[];
  readonly configstrings: readonly (readonly [number, string])[];
  readonly prints: readonly string[];
}

function requireGate(condition: boolean, name: string): void {
  if (!condition) throw new Error(`Game-mode verification failed: ${name}`);
}

function bareMapName(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new RangeError("Use a bare BSP map name");
  return name;
}

function command(time: number, buttons = 0): UserCommand {
  return { serverTime: time, angles: vec3(0, 0, 0), buttons, weapon: Weapon.WP_MACHINEGUN,
    forwardmove: 0, rightmove: 0, upmove: 0 };
}

function otherTeam(team: Team): Team.TEAM_RED | Team.TEAM_BLUE {
  if (team === Team.TEAM_RED) return Team.TEAM_BLUE;
  if (team === Team.TEAM_BLUE) return Team.TEAM_RED;
  throw new Error(`Expected a playing team, got ${team}`);
}

function entityNamed(runtime: GameRuntime, classname: string): GameEntity {
  for (let index = 0; index < runtime.pool.numEntities; index++) {
    const entity = runtime.pool.at(index);
    if (entity.inuse && entity.classname === classname) return entity;
  }
  throw new Error(`Required retail entity missing: ${classname}`);
}

function spawnedObelisk(runtime: GameRuntime, team: Team.TEAM_RED | Team.TEAM_BLUE): GameEntity {
  const marker = team === Team.TEAM_RED ? "team_redobelisk" : "team_blueobelisk";
  for (let index = 0; index < runtime.pool.numEntities; index++) {
    const entity = runtime.pool.at(index), activator = entity.activator;
    if (entity.inuse && entity.spawnflags === team && activator !== null && activator.classname === marker) return entity;
  }
  throw new Error(`Required spawned obelisk missing: ${marker}`);
}

function droppedCube(runtime: GameRuntime, victimTeam: Team): GameEntity {
  const classname = victimTeam === Team.TEAM_RED ? "item_redcube" : victimTeam === Team.TEAM_BLUE ? "item_bluecube" : null;
  if (classname === null) throw new Error("Harvester victim must belong to a playing team");
  for (let index = 0; index < runtime.pool.numEntities; index++) {
    const entity = runtime.pool.at(index);
    if (entity.inuse && entity.classname === classname && (entity.flags & GameFlags.DROPPED_ITEM) !== 0) return entity;
  }
  const cubes = Array.from({ length: runtime.pool.numEntities }, (_, index) => runtime.pool.at(index))
    .filter(entity => entity.classname !== null && entity.classname.includes("cube"))
    .map(entity => `${entity.slot}:${entity.classname}:${entity.inuse}:${entity.flags}:${entity.spawnflags}`);
  throw new Error(`Real player death did not create ${classname}; cube entities: ${cubes.join(",")}`);
}

function runScenario(map: BspMap, spec: ScenarioSpec): ScenarioResult {
  const actions: string[] = [];
  const harness = createGameVerificationHarness({ product: spec.product, map, gameType: spec.gameType, levelTime: 1000,
    randomSeed: 42, buildDate: "Sep  5 2026", clientNamePrefix: "ModeVerifier",
    botsReason: "This human-client verifier does not integrate game bot AI",
    additionalCvars: [["g_friendlyFire", "0"]] });
  const { runtime, cvars, configstrings, consoleCommands, messages, prints } = harness;
  const gates: Record<string, boolean> = {};
  const replay = new Bun.CryptoHasher("sha256");
  const checkpoints: VerificationCheckpoint[] = [];

  function gate(name: string, passed: boolean): void {
    gates[name] = passed;
    requireGate(passed, `${spec.mode}: ${name}`);
  }
  function checkpoint(name: string): void {
    const clients = [0, 1].map(slot => {
      const entity = runtime.pool.at(slot), client = runtime.pool.clientAt(slot);
      return { slot, connected: client.pers.connected, team: client.sess.sessionTeam, health: entity.health,
        score: client.ps.persistant.get(PersistentIndex.PERS_SCORE),
        captures: client.ps.persistant.get(PersistentIndex.PERS_CAPTURES), tokens: client.ps.generic1,
        ready: client.readyToExit };
    });
    const teamScores = Array.from({ length: 4 }, (_, team) => runtime.level.teamScores.get(team));
    const snapshot = { name, time: runtime.level.time, frame: runtime.level.frameNum, teamScores, clients };
    checkpoints.push(snapshot);
    replay.update(JSON.stringify({ snapshot, random: runtime.random.seed,
      entities: Array.from({ length: runtime.pool.numEntities }, (_, index) => {
        const entity = runtime.pool.at(index);
        return { slot: index, inuse: entity.inuse, classname: entity.classname, flags: entity.flags,
          health: entity.health, state: entity.s, origin: entity.r.currentOrigin, nextthink: entity.nextthink,
          player: entity.client?.ps ?? null, session: entity.client?.sess ?? null };
      }), configstrings: [...configstrings].sort(([left], [right]) => left - right), messages, consoleCommands, actions }));
  }
  function send(slot: number, input: UserCommand): void {
    harness.setCommand(slot, input);
    runtime.clientThink(slot, input);
  }
  function contact(item: GameEntity, player: GameEntity): void {
    if (item.touch === null) throw new Error(`Installed contact callback absent: ${item.classname}`);
    actions.push(`contact:${item.classname}:${item.slot}->client:${player.slot}`);
    item.touch(item, player, runtime.world.trace({ start: item.r.currentOrigin, end: item.r.currentOrigin,
      shape: { kind: "point" }, passEntityNum: player.slot, mask: 1 }));
  }
  function teleportKill(attacker: GameEntity, victim: GameEntity): void {
    const target = runtime.pool.clientAt(victim.slot).ps.origin;
    actions.push(`command:setviewpos:client:${attacker.slot}->client:${victim.slot}`);
    runtime.clientCommand(attacker.slot, ["setviewpos", String(target.x), String(target.y), String(target.z), "0"]);
    gate("teleportUsesRealKillboxAndDeath", victim.health <= 0);
  }

  try {
    gate("allMapEntityClassesRecognized", runtime.spawnReport.outcomes.every(outcome => outcome.kind !== "unknown"));
    for (let time = 1100; time <= 1300; time += 100) runtime.runFrame(time);
    for (const slot of [0, 1]) {
      gate(`client${slot}Admitted`, runtime.clientConnect(slot, true, false) === null);
      runtime.clientBegin(slot);
      gate(`client${slot}Connected`, runtime.pool.clientAt(slot).pers.connected === ConnectionState.CONNECTED);
    }
    gate("twoPlayingClients", runtime.level.numPlayingClients === 2);
    const player = runtime.pool.at(0), opponent = runtime.pool.at(1);
    const playerClient = runtime.pool.clientAt(0), opponentClient = runtime.pool.clientAt(1);
    if (spec.gameType >= GameType.GT_TEAM) {
      gate("opposingPlayingTeams", (playerClient.sess.sessionTeam === Team.TEAM_RED || playerClient.sess.sessionTeam === Team.TEAM_BLUE)
        && opponentClient.sess.sessionTeam === otherTeam(playerClient.sess.sessionTeam));
    } else gate("tournamentPlayersUseFreeTeam", playerClient.sess.sessionTeam === Team.TEAM_FREE && opponentClient.sess.sessionTeam === Team.TEAM_FREE);
    checkpoint("admitted");

    switch (spec.mode) {
      case "one-flag": {
        const team = playerClient.sess.sessionTeam;
        const neutral = entityNamed(runtime, "team_CTF_neutralflag");
        contact(neutral, player);
        gate("neutralFlagPickupUsesInstalledItem", playerClient.ps.powerups.get(Powerup.PW_NEUTRALFLAG) === 2147483647);
        gate("neutralFlagStatusPublishesTakenTeam", configstrings.get(23) === (team === Team.TEAM_RED ? "2" : "3"));
        const enemyBase = entityNamed(runtime, team === Team.TEAM_RED ? "team_CTF_blueflag" : "team_CTF_redflag");
        contact(enemyBase, player);
        gate("opposingBaseCapturesNeutralFlag", playerClient.ps.powerups.get(Powerup.PW_NEUTRALFLAG) === 0
          && runtime.level.teamScores.get(team) === 1);
        break;
      }
      case "overload": {
        const team = playerClient.sess.sessionTeam, enemy = otherTeam(team), obelisk = spawnedObelisk(runtime, enemy);
        const model = obelisk.activator;
        if (model === null) throw new Error("Spawned Overload obelisk lost its map model");
        const startingHealth = obelisk.health;
        actions.push(`damage:client:${player.slot}->obelisk:${obelisk.slot}:${startingHealth}`);
        damage(runtime.combat, obelisk, player, player, null, obelisk.r.currentOrigin, startingHealth, 0, 3);
        gate("enemyObeliskDiesThroughCombat", !obelisk.takedamage && obelisk.health <= 0);
        gate("obeliskModelPublishesExplosion", model.s.frame === 2 && model.s.modelindex2 === 255);
        gate("obeliskDeathScoresCapture", runtime.level.teamScores.get(team) === 1
          && playerClient.ps.persistant.get(PersistentIndex.PERS_CAPTURES) === 1);
        break;
      }
      case "harvester": {
        const team = playerClient.sess.sessionTeam, victimTeam = opponentClient.sess.sessionTeam;
        // G_EntitiesFree requires reusable opened slots before TossClientCubes will launch a cube.
        // Two real suicide/death events are allowed to expire, then both humans respawn.
        actions.push("command:kill:client:1", "command:kill:client:0");
        runtime.clientCommand(1, ["kill"]);
        runtime.clientCommand(0, ["kill"]);
        gate("realDeathsCreateReusableEventSlots", player.health <= 0 && opponent.health <= 0);
        runtime.runFrame(3100);
        send(0, command(3101, CommandButtons.ATTACK));
        send(1, command(3101, CommandButtons.ATTACK));
        gate("humansRespawnThroughInput", player.health > 0 && opponent.health > 0);
        teleportKill(player, opponent);
        const cube = droppedCube(runtime, victimTeam);
        gate("realDeathCreatesEnemyCube", cube.spawnflags === victimTeam);
        contact(cube, player);
        gate("installedCubePickupGrantsToken", playerClient.ps.generic1 === 1 && !cube.inuse);
        const bank = spawnedObelisk(runtime, otherTeam(team));
        contact(bank, player);
        gate("enemyObeliskBanksRealToken", playerClient.ps.generic1 === 0 && runtime.level.teamScores.get(team) === 1
          && playerClient.ps.persistant.get(PersistentIndex.PERS_CAPTURES) === 1);
        break;
      }
      case "tournament":
      case "team-deathmatch": {
        teleportKill(player, opponent);
        if (spec.mode === "team-deathmatch") {
          gate("teamDeathScoresForAttackerTeam", runtime.level.teamScores.get(playerClient.sess.sessionTeam) === 1);
        } else gate("tournamentDeathScoresForAttacker", playerClient.ps.persistant.get(PersistentIndex.PERS_SCORE) === 1);
        break;
      }
      default: {
        const exhaustive: never = spec.mode;
        throw new Error(`Unknown verification mode: ${String(exhaustive)}`);
      }
    }
    checkpoint("objective-scored");

    cvars.set(spec.gameType >= GameType.GT_CTF ? "capturelimit" : "fraglimit", "1", true);
    const queueTime = (runtime.level.time + 100) | 0;
    runtime.runFrame(queueTime);
    gate("scoreLimitQueuesIntermission", runtime.level.intermissionQueued === queueTime);
    const intermissionTime = (queueTime + 1000) | 0;
    runtime.runFrame(intermissionTime);
    gate("intermissionStartsAfterSourceDelay", runtime.level.intermissionTime === intermissionTime);
    if (spec.mode === "tournament") {
      gate("tournamentAdjustsWinnerAndLoserSessions", playerClient.sess.wins === 1 && opponentClient.sess.losses === 1);
    }
    checkpoint("intermission");
    for (const slot of [0, 1]) {
      send(slot, command((intermissionTime + 100) | 0));
      send(slot, command((intermissionTime + 200) | 0, CommandButtons.ATTACK));
    }
    gate("bothClientsReadyThroughInput", playerClient.readyToExit && opponentClient.readyToExit);
    runtime.runFrame((intermissionTime + 5000) | 0);
    if (spec.mode === "tournament") {
      gate("tournamentQueuesMapRestart", consoleCommands.includes("map_restart 0\n") && !consoleCommands.includes("vstr nextmap\n"));
      gate("tournamentLoserMovesToSpectator", opponentClient.sess.sessionTeam === Team.TEAM_SPECTATOR
        && playerClient.sess.sessionTeam === Team.TEAM_FREE);
    } else {
      gate("nextMapRequestedAtEngineBoundary", consoleCommands.includes("vstr nextmap\n"));
      gate("clientsBecomeConnectingForMapChange", [0, 1].every(slot => runtime.pool.clientAt(slot).pers.connected === ConnectionState.CONNECTING));
    }
    checkpoint("exit-requested");
    return { product: spec.product, mode: spec.mode, mapName: spec.mapName, gates, actions,
      replaySha256: replay.digest("hex"), checkpoints, entityCount: runtime.pool.numEntities,
      spawnOutcomes: runtime.spawnReport.outcomes.length, messages, consoleCommands,
      configstrings: [...configstrings].sort(([left], [right]) => left - right), prints };
  } finally {
    runtime.shutdown(false);
  }
}

export async function verifyGameModes(options: GameModeVerificationOptions) {
  const missionMap = bareMapName(options.missionMap ?? "mpteam2");
  const tournamentMap = bareMapName(options.tournamentMap ?? "q3tourney1");
  const teamMap = bareMapName(options.teamMap ?? "q3dm1");
  const specs: readonly ScenarioSpec[] = [
    { product: "missionpack", mode: "one-flag", gameType: GameType.GT_1FCTF, mapName: missionMap },
    { product: "missionpack", mode: "overload", gameType: GameType.GT_OBELISK, mapName: missionMap },
    { product: "missionpack", mode: "harvester", gameType: GameType.GT_HARVESTER, mapName: missionMap },
    { product: "baseq3", mode: "tournament", gameType: GameType.GT_TOURNAMENT, mapName: tournamentMap },
    { product: "baseq3", mode: "team-deathmatch", gameType: GameType.GT_TEAM, mapName: teamMap },
  ];
  const baseq3 = await VirtualFileSystem.openInspection({ dataPath: options.dataPath, homePath: options.dataPath, cdPath: null, product: "baseq3" });
  try {
    const missionpack = await VirtualFileSystem.openInspection({ dataPath: options.dataPath, homePath: options.dataPath, cdPath: null, product: "missionpack" });
    try {
      const assets = { baseq3, missionpack };
      const results: (ScenarioResult & { readonly mapSha256: string; readonly independentSeededReplay: boolean })[] = [];
      for (const spec of specs) {
        const bytes = await assets[spec.product].read(`maps/${spec.mapName}.bsp`);
        const first = runScenario(parseBsp(bytes, spec.mapName), spec);
        const second = runScenario(parseBsp(bytes, spec.mapName), spec);
        requireGate(JSON.stringify(first) === JSON.stringify(second), `${spec.mode}: independent seeded replay`);
        results.push({ ...first, mapSha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), independentSeededReplay: true });
      }
      return { scope: "controlled-headless-retail-game-modes", randomSeed: 42,
        controlledActions: ["human admission and commands through GameRuntime",
          "deliberate teleport overlap through the real cheat command and killbox",
          "direct contact with installed item and objective callbacks using real world traces",
          "lethal target damage through the real combat and obelisk callbacks",
          "Harvester reusable slots through real kill commands, event expiry, and attack-input respawn"],
        excluded: ["network admission, protocol transport, and snapshot delivery", "rendered client presentation",
          "game bots and single-player campaign", "execution of queued next-map or map-restart commands",
          "original-engine full-match equivalence"], results };
    } finally {
      missionpack.close();
    }
  } finally {
    baseq3.close();
  }
}

async function main(): Promise<void> {
  let dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  let output = ".artifacts/game-mode-verification.json";
  let missionMap: string | undefined, tournamentMap: string | undefined, teamMap: string | undefined;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === "--data") dataPath = value;
    else if (flag === "--output") output = value;
    else if (flag === "--mission-map") missionMap = value;
    else if (flag === "--tournament-map") tournamentMap = value;
    else if (flag === "--team-map") teamMap = value;
    else throw new Error(`Unknown argument ${flag}`);
  }
  const report = await verifyGameModes({ dataPath,
    ...(missionMap === undefined ? {} : { missionMap }),
    ...(tournamentMap === undefined ? {} : { tournamentMap }),
    ...(teamMap === undefined ? {} : { teamMap }) });
  const path = resolve(output);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ scope: report.scope, modes: report.results.map(result => ({
    product: result.product, mode: result.mode, map: result.mapName, gates: Object.keys(result.gates).length,
    replaySha256: result.replaySha256, independentSeededReplay: result.independentSeededReplay })), report: path }, null, 2)}\n`);
}

if (import.meta.main) await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
