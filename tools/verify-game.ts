// Controlled headless gameplay verification; not a networked or rendered game session.
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { vec3 } from "../src/core/math.ts";
import { GameRuntime } from "../src/game/runtime.ts";
import { ConnectionState } from "../src/game/state.ts";
import type { GameEntity } from "../src/game/state.ts";
import { GameType, PersistentIndex, Powerup, Team, Weapon, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { CommandButtons } from "../src/shared/player-state.ts";
import type { UserCommand } from "../src/shared/player-state.ts";
import { createGameVerificationHarness } from "./game-verification-harness.ts";

export interface GameVerificationOptions {
  readonly dataPath: string;
  readonly product: Product;
  readonly deathmatchMap?: string;
  readonly captureMap?: string;
}

function requireGate(condition: boolean, name: string): void {
  if (!condition) throw new Error(`Game verification failed: ${name}`);
}

function command(time: number, buttons = 0, forwardmove = 0): UserCommand {
  return { serverTime: time, angles: vec3(0, 0, 0), buttons, weapon: Weapon.WP_MACHINEGUN,
    forwardmove, rightmove: 0, upmove: 0 };
}

function entityNamed(runtime: GameRuntime, classname: string): GameEntity {
  for (let index = 0; index < runtime.pool.numEntities; index++) {
    const entity = runtime.pool.at(index);
    if (entity.inuse && entity.classname === classname) return entity;
  }
  throw new Error(`Required retail entity missing: ${classname}`);
}

function runScenario(map: BspMap, product: Product, type: GameType.GT_FFA | GameType.GT_CTF) {
  const harness = createGameVerificationHarness({ product, map, gameType: type, levelTime: 1000, randomSeed: 42,
    buildDate: "Sep  5 2026", clientNamePrefix: "Verifier",
    botsReason: "This human-client verifier does not integrate game bot AI",
  });
  const { runtime, cvars, configstrings, consoleCommands, messages, prints } = harness;
  const gates: Record<string, boolean> = {};
  const replay = new Bun.CryptoHasher("sha256");
  const checkpoints: { readonly name: string; readonly time: number; readonly frame: number;
    readonly clients: readonly { readonly slot: number; readonly health: number; readonly score: number;
      readonly team: Team; readonly origin: { readonly x: number; readonly y: number; readonly z: number }; readonly eventSequence: number }[] }[] = [];
  function gate(name: string, passed: boolean): void { gates[name] = passed; requireGate(passed, name); }
  function checkpoint(name: string): void {
    const clients = [0, 1].map(slot => {
      const entity = runtime.pool.at(slot), client = runtime.pool.clientAt(slot);
      return { slot, health: entity.health, score: client.ps.persistant.get(PersistentIndex.PERS_SCORE),
        team: client.sess.sessionTeam, origin: { ...client.ps.origin }, eventSequence: client.ps.eventSequence };
    });
    checkpoints.push({ name, time: runtime.level.time, frame: runtime.level.frameNum, clients });
    replay.update(JSON.stringify({ name, time: runtime.level.time, random: runtime.random.seed,
      entities: Array.from({ length: runtime.pool.numEntities }, (_, index) => {
        const entity = runtime.pool.at(index);
        return { slot: index, inuse: entity.inuse, classname: entity.classname, health: entity.health,
          state: entity.s, origin: entity.r.currentOrigin, nextthink: entity.nextthink,
          player: entity.client?.ps ?? null, session: entity.client?.sess ?? null };
      }), configstrings: [...configstrings].sort(([a], [b]) => a - b), messages, consoleCommands }));
  }
  function send(slot: number, input: UserCommand): void {
    harness.setCommand(slot, input); runtime.clientThink(slot, input);
  }
  function contact(item: GameEntity, player: GameEntity): void {
    if (item.touch === null) throw new Error(`Installed item callback absent: ${item.classname}`);
    item.touch(item, player, runtime.world.trace({ start: item.r.currentOrigin, end: item.r.currentOrigin,
      shape: { kind: "point" }, passEntityNum: player.slot, mask: 1 }));
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
    checkpoint("admitted");
    const initialOrigin = { ...runtime.pool.clientAt(0).ps.origin };
    const initialAmmo = runtime.pool.clientAt(0).ps.ammo.get(Weapon.WP_MACHINEGUN);
    for (let time = 1350; time <= 2500; time += 50) {
      send(0, command(time, time >= 1800 ? CommandButtons.ATTACK : 0, time < 1800 ? 50 : 0));
      send(1, command(time)); runtime.runFrame(time); checkpoint(`input-${time}`);
    }
    const player = runtime.pool.at(0), victim = runtime.pool.at(1), client = runtime.pool.clientAt(0);
    gate("movementThroughRetailCollision", Math.hypot(client.ps.origin.x - initialOrigin.x, client.ps.origin.y - initialOrigin.y) > 1);
    gate("weaponCommandsConsumeAmmo", client.ps.ammo.get(Weapon.WP_MACHINEGUN) < initialAmmo);
    gate("clientsLinkedToWorld", runtime.world.linkState(0)?.linked === true && runtime.world.linkState(1)?.linked === true);
    runtime.clientCommand(0, ["give", "Railgun"]);
    gate("namedGiveUsesActualItemPickup", (client.ps.stats.get(statSchema(product).weapons) & (1 << Weapon.WP_RAILGUN)) !== 0);
    runtime.clientCommand(0, ["say", "headless-verification"]);
    gate("chatUsesGameCommandDispatch", messages.some(message => message.text.includes("headless-verification")));
    const target = { ...runtime.pool.clientAt(1).ps.origin };
    const beforeScore = client.ps.persistant.get(PersistentIndex.PERS_SCORE);
    runtime.clientCommand(0, ["setviewpos", String(target.x), String(target.y), String(target.z), "0"]);
    gate("teleportKillboxCallsRealDeath", victim.health <= 0);
    const afterScore = client.ps.persistant.get(PersistentIndex.PERS_SCORE);
    gate("deathUpdatesScoreAndRank", (type === GameType.GT_FFA ? afterScore === beforeScore + 1 : afterScore > beforeScore)
      && runtime.level.sortedClients[0] === 0);
    checkpoint("telefrag");
    runtime.runFrame(5000); send(1, command(5000, CommandButtons.ATTACK));
    gate("attackRespawnsDeadClient", victim.health > 0);
    checkpoint("respawned");
    if (type === GameType.GT_CTF) {
      const ownTeam = client.sess.sessionTeam;
      gate("opposingTeams", (ownTeam === Team.TEAM_RED || ownTeam === Team.TEAM_BLUE) && ownTeam !== runtime.pool.clientAt(1).sess.sessionTeam);
      const enemyFlag = entityNamed(runtime, ownTeam === Team.TEAM_RED ? "team_CTF_blueflag" : "team_CTF_redflag");
      const ownFlag = entityNamed(runtime, ownTeam === Team.TEAM_RED ? "team_CTF_redflag" : "team_CTF_blueflag");
      contact(enemyFlag, player);
      gate("installedFlagTouchGrantsEnemyFlag", client.ps.powerups.get(ownTeam === Team.TEAM_RED ? Powerup.PW_BLUEFLAG : Powerup.PW_REDFLAG) > 0);
      contact(ownFlag, player);
      gate("installedFlagTouchCaptures", runtime.level.teamScores.get(ownTeam) === 1);
      cvars.set("capturelimit", "1", true);
    } else cvars.set("fraglimit", "1", true);
    runtime.runFrame(5100);
    gate("scoreLimitQueuesIntermission", runtime.level.intermissionQueued === 5100);
    runtime.runFrame(6100);
    gate("intermissionStartsAfterSourceDelay", runtime.level.intermissionTime === 6100);
    checkpoint("intermission");
    for (const slot of [0, 1]) {
      send(slot, command(6200)); send(slot, command(6300, CommandButtons.ATTACK));
      gate(`client${slot}ReadyThroughInput`, runtime.pool.clientAt(slot).readyToExit);
    }
    runtime.pool.clientAt(0).sess.wins = 7;
    runtime.runFrame(11200);
    gate("nextMapRequestedAtEngineBoundary", consoleCommands.includes("vstr nextmap\n"));
    gate("clientsBecomeConnectingForMapChange", [0, 1].every(slot => runtime.pool.clientAt(slot).pers.connected === ConnectionState.CONNECTING));
    checkpoint("nextmap-requested");
    runtime.shutdown(true);
    gate("shutdownPersistsSession", cvars.get("session0")?.value !== undefined);
    const restarted = GameRuntime.create({ ...runtime.options, levelTime: 12000, restart: true }, harness.owner);
    try {
      gate("restartReadsSavedSession", restarted.clientConnect(0, false, false) === null && restarted.pool.clientAt(0).sess.wins === 7);
      restarted.clientBegin(0);
      gate("restartClientBegins", restarted.pool.clientAt(0).pers.connected === ConnectionState.CONNECTED);
    } finally { restarted.shutdown(false); }
    return { mode: type === GameType.GT_CTF ? "ctf" : "ffa", gates, replaySha256: replay.digest("hex"), checkpoints,
      entityCount: runtime.pool.numEntities, spawnOutcomes: runtime.spawnReport.outcomes.length,
      messages, consoleCommands, configstrings: [...configstrings].sort(([a], [b]) => a - b), prints };
  } finally { runtime.shutdown(false); }
}

export async function verifyGame(options: GameVerificationOptions) {
  const maps: readonly (readonly [string, GameType.GT_FFA | GameType.GT_CTF])[] = [
    [options.deathmatchMap ?? "q3dm1", GameType.GT_FFA],
    [options.captureMap ?? (options.product === "baseq3" ? "q3ctf1" : "mpteam1"), GameType.GT_CTF],
  ];
  for (const [name] of maps) if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new RangeError("Use a bare BSP map name");
  const assets = await VirtualFileSystem.openInspection({ dataPath: options.dataPath, homePath: options.dataPath, cdPath: null, product: options.product });
  try {
    const results: (ReturnType<typeof runScenario> & {
      readonly mapName: string; readonly mapSha256: string; readonly independentSeededReplay: boolean;
    })[] = [];
    for (const [name, type] of maps) {
      const bytes = await assets.read(`maps/${name}.bsp`);
      const first = runScenario(parseBsp(bytes), options.product, type);
      const second = runScenario(parseBsp(bytes), options.product, type);
      requireGate(JSON.stringify(first) === JSON.stringify(second), `${name} independent seeded replay`);
      results.push({ mapName: name, mapSha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        independentSeededReplay: true, ...first });
    }
    return { scope: "controlled-headless-retail-game-runtime", product: options.product, randomSeed: 42,
      controlledActions: ["scripted human user commands", "source give and teleport cheat commands",
        "installed flag touch callbacks invoked with real world traces", "session wins set to 7 to test restart persistence"],
      excluded: ["network admission and snapshot transport", "rendered client presentation", "game bots",
        "single-player campaign", "execution of the queued next-map engine command", "original-engine full-match equivalence"], results };
  } finally {
    assets.close();
  }
}

async function main(): Promise<void> {
  let dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  let product: Product = "baseq3";
  let output = ".artifacts/game-verification.json";
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === "--data") dataPath = value;
    else if (flag === "--product") {
      if (value !== "baseq3" && value !== "missionpack") throw new Error("Product must be baseq3 or missionpack");
      product = value;
    } else if (flag === "--output") output = value;
    else throw new Error(`Unknown argument ${flag}`);
  }
  const report = await verifyGame({ dataPath, product });
  const path = resolve(output);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ scope: report.scope, product, maps: report.results.map(result => ({
    map: result.mapName, gates: Object.keys(result.gates).length, replaySha256: result.replaySha256,
    independentSeededReplay: result.independentSeededReplay })), report: path }, null, 2)}\n`);
}

if (import.meta.main) await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1;
});
