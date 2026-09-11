/*
 * Authoritative game composition and frame dispatch translated from
 * id Software's game/g_main.c and server/sv_game.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { BspMap } from "../assets/bsp.ts";
import type { CollisionWorld } from "../collision/world.ts";
import { CvarFlag, CvarRegistry } from "../core/cvar.ts";
import { CommonError } from "../core/common-error.ts";
import { CommonParseState } from "../core/common-parse.ts";
import type { CvarSnapshot } from "../core/cvar.ts";
import { nativeAtoi } from "../core/native-numeric.ts";
import type { Vec3 } from "../core/math.ts";
import type { ServerWorld } from "../server/world.ts";
import { directGameCalls } from "../server/game.ts";
import type { ServerGame, ServerGameData } from "../server/game.ts";
import { EntityEvent, EntityType, GameType, Team } from "../shared/definitions.ts";
import type { Product } from "../shared/definitions.ts";
import { findItem } from "../shared/items.ts";
import { MovementDiagnostics } from "../shared/movement.ts";
import { PlayerStateSlots } from "../shared/player-state.ts";
import type { UserCommand } from "../shared/player-state.ts";
import type { VmRegistration } from "../vm/registry.ts";
import { ArenaRuntime } from "./arenas.ts";
import { ClientAdmissionRuntime, clientInfoValue } from "./client-admission.ts";
import type { ClientBotServices } from "./client-admission.ts";
import { clientEndFrame } from "./client-effects.ts";
import type { ClientEffectsContext } from "./client-effects.ts";
import { clientEvents } from "./client-events.ts";
import { clientInactivityTimer, clientIntermissionThink, spectatorClientEndFrame, spectatorThink } from "./client-policy.ts";
import type { ClientPolicyContext } from "./client-policy.ts";
import { ClientSpawnRuntime, ClientSpawnState, spawnDeathmatchPoint, spawnPlayerStart } from "./client-spawn.ts";
import { ClientThinkRuntime } from "./client-think.ts";
import { GameCommandRuntime } from "./commands.ts";
import type { CombatContext, DamageDiagnostic } from "./combat.ts";
import { DeathRuntime } from "./death.ts";
import { EntityPool, runThink } from "./entities.ts";
import { gameFormat } from "./format.ts";
import { ItemRegistry, respawnItem, spawnItem, touchItem } from "./item-lifecycle.ts";
import type { ItemLifecycleContext } from "./item-lifecycle.ts";
import { runItem } from "./item-motion.ts";
import type { DropItemContext } from "./item-motion.ts";
import { MatchModuleState, MatchRuntime, MatchState } from "./match.ts";
import { GameMemory } from "./memory.ts";
import { killBox } from "./misc.ts";
import { miscSpawnHandlers } from "./misc-spawn.ts";
import { MissileRuntime } from "./missile.ts";
import { MoverRuntime } from "./mover.ts";
import { MoverSpawnRuntime } from "./mover-spawn.ts";
import { gameAtoi, GameRandom } from "./numeric.ts";
import { PersonalPortalRuntime } from "./personal-portal.ts";
import { GameSessionManager } from "./session.ts";
import { GameServerCommandRuntime, GameServerCommandState } from "./server-commands.ts";
import type { SessionWorldState } from "./session.ts";
import { ShaderRemapRegistry } from "./shader-remaps.ts";
import { spawnEntities } from "./spawn.ts";
import type { SpawnHandler, SpawnReport } from "./spawn.ts";
import { GameFlags, MAX_CLIENTS, MAX_GENTITIES } from "./state.ts";
import type { GameEntity } from "./state.ts";
import { TargetLocationState, targetSpawnHandlers } from "./targets.ts";
import { spawnTeamPoint, TeamRuntime } from "./team.ts";
import { triggerSpawnHandlers } from "./triggers.ts";
import { ConfigStringRegistry, findEntity, useTargets } from "./utilities.ts";
import type { ConfigStringStore, TargetUseContext } from "./utilities.ts";
import { invulnerabilityEffect, logAccuracyHit, WeaponRuntime } from "./weapon.ts";

interface CvarDefinition {
  readonly name: string;
  readonly value: string;
  readonly flags: number;
  readonly track: boolean;
  readonly teamShader: boolean;
}
const A = CvarFlag.Archive, S = CvarFlag.ServerInfo, U = CvarFlag.UserInfo;
const L = CvarFlag.Latch, R = CvarFlag.ReadOnly, N = CvarFlag.NoRestart, Y = CvarFlag.SystemInfo;
function cvar(name: string, value: string, flags = 0, track = false, teamShader = false): CvarDefinition {
  return { name, value, flags, track, teamShader };
}
const commonCvars = [
  cvar("sv_cheats", ""), cvar("g_restarted", "0", R), cvar("g_gametype", "0", S | U | L),
  cvar("sv_maxclients", "8", S | L | A), cvar("g_maxGameClients", "0", S | L | A),
  cvar("dmflags", "0", S | A, true), cvar("fraglimit", "20", S | A | N, true),
  cvar("timelimit", "0", S | A | N, true), cvar("capturelimit", "8", S | A | N, true),
  cvar("g_synchronousClients", "0", Y), cvar("g_friendlyFire", "0", A, true),
  cvar("g_teamAutoJoin", "0", A), cvar("g_teamForceBalance", "0", A),
  cvar("g_warmup", "20", A, true), cvar("g_doWarmup", "0", 0, true), cvar("g_log", "games.log", A),
  cvar("g_logSync", "0", A), cvar("g_password", "", U), cvar("g_banIPs", "", A),
  cvar("g_filterBan", "1", A), cvar("g_needpass", "0", S | R), cvar("dedicated", "0"),
  cvar("g_speed", "320", 0, true), cvar("g_gravity", "800", 0, true), cvar("g_knockback", "1000", 0, true),
  cvar("g_quadfactor", "3", 0, true), cvar("g_weaponrespawn", "5", 0, true),
  cvar("g_weaponTeamRespawn", "30", 0, true), cvar("g_forcerespawn", "20", 0, true),
  cvar("g_inactivity", "0", 0, true), cvar("g_debugMove", "0"), cvar("g_debugDamage", "0"),
  cvar("g_debugAlloc", "0"), cvar("g_motd", ""), cvar("com_blood", "1"),
  cvar("g_podiumDist", "80"), cvar("g_podiumDrop", "70"), cvar("g_allowVote", "1", A), cvar("g_listEntity", "0"),
];
const missionpackCvars = [
  cvar("g_obeliskHealth", "2500"), cvar("g_obeliskRegenPeriod", "1"), cvar("g_obeliskRegenAmount", "15"),
  cvar("g_obeliskRespawnDelay", "10", S), cvar("g_cubeTimeout", "30"),
  cvar("g_redteam", "Stroggs", A | S | U, true, true), cvar("g_blueteam", "Pagans", A | S | U, true, true),
  cvar("ui_singlePlayerActive", ""), cvar("g_enableDust", "0", S, true), cvar("g_enableBreath", "0", S, true),
  cvar("g_proxMineTimeout", "20000"),
];
const finalCvars = [cvar("g_smoothClients", "1"), cvar("pmove_fixed", "0", Y), cvar("pmove_msec", "8", Y), cvar("g_rankings", "0")];

/** Loaded-module level record. G_InitGame clears its fields in place. */
export class GameLevel extends MatchState {
  frameNum = 0;
  previousTime = 0;
  newSession = false;
  frySound = 0;
  readonly teamScores = new PlayerStateSlots(4);

  clear(): void {
    const fresh = new GameLevel();
    const { teamScores, numTeamVotingClients, sortedClients, vote, teamVotes } = this;
    for (let index = 0; index < teamScores.length; index++) teamScores.set(index, 0);
    numTeamVotingClients.fill(0); sortedClients.fill(0);
    Object.assign(vote, fresh.vote);
    Object.assign(teamVotes[0], fresh.teamVotes[0]); Object.assign(teamVotes[1], fresh.teamVotes[1]);
    Object.assign(this, fresh, { teamScores, numTeamVotingClients, sortedClients, vote, teamVotes });
  }
}

export interface GameLog { write(text: string): void; close(): void }
export interface GameEngineImports {
  milliseconds(): number;
  print(text: string): void;
  sendServerCommand(clientNum: number, text: string): void;
  dropClient(clientNum: number, reason: string): void;
  getUserinfo(clientNum: number): string;
  setUserinfo(clientNum: number, value: string): void;
  getUserCommand(clientNum: number): UserCommand;
  appendConsoleCommand(text: string): void;
  insertConsoleCommand(text: string): void;
  executeConsoleNow(text: string): void;
  openLog(path: string, synchronous: boolean): GameLog | null;
}
export type GameBotServices = ClientBotServices & (
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "available"; initialize(restart: boolean): void; loadMap(restart: boolean): void;
    initializeBots(restart: boolean): void; shutdown(restart: boolean): void; interbreedEndMatch(): void;
    consoleCommand(argv: readonly string[]): void; frame(time: number): void; testAas(origin: Vec3): void }
);
export type GameBotFactory =
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "source"; attach(game: GameRuntime): Extract<GameBotServices, { kind: "available" }> };
export interface GameRuntimeOptions {
  readonly sourceDebug?: boolean;
  readonly product: Product;
  readonly map: Pick<BspMap, "entities">;
  readonly collision: CollisionWorld;
  readonly world: ServerWorld;
  readonly levelTime: number;
  readonly randomSeed: number;
  readonly restart: boolean;
  readonly buildDate: string;
  /** Engine-owned registries survive a game shutdown/map restart. */
  readonly cvars: CvarRegistry;
  readonly configstrings: ConfigStringStore;
  readonly engine: GameEngineImports;
  readonly botFactory: GameBotFactory;
}

/** The server's current game slot, also used by its spatial entity resolver. */
export interface GameRuntimeOwner { game: ServerGame | null }

class GameModuleState {
  readonly serverCommands = new GameServerCommandState();
  readonly match = new MatchModuleState();
  readonly random = new GameRandom();
  readonly movementDiagnostics = new MovementDiagnostics(text => { this.engine.print(text); });
  readonly remaps = new ShaderRemapRegistry(text => { this.engine.print(text); });
  readonly level = new GameLevel();
  readonly vmCvars = new Map<string, CvarSnapshot>();
  readonly locations = new TargetLocationState();
  readonly clientSpawns = new ClientSpawnState();
  readonly registeredItems: ItemRegistry;
  readonly pool: EntityPool;
  readonly memory = new GameMemory(() => {
    const value = this.vmCvars.get("g_debugalloc");
    if (value === undefined) throw new Error("Unregistered game cvar g_debugAlloc");
    return value.integerValue;
  }, text => { this.engine.print(text); });
  logFile: GameLog | null = null;
  readonly retiredLogs = new Set<GameLog>();
  engine: GameEngineImports;
  world: ServerWorld;

  constructor(options: GameRuntimeOptions) {
    this.engine = options.engine; this.world = options.world;
    this.registeredItems = new ItemRegistry(options.product);
    const maxClients = options.cvars.get("sv_maxclients"), module = this;
    this.pool = new EntityPool({ product: options.product,
      ...(options.sourceDebug ? { eventDebug: { kind: "source-debug", module: "game",
        showEvents: () => options.cvars.get("showevents")?.value ?? "",
        print: (text: string) => { this.engine.print(text); } } } : {}),
      maxClients: nativeAtoi(maxClients?.latchedValue ?? maxClients?.value ?? "8"),
      get mapStartTime() { return module.level.startTime; },
      time: () => this.level.time, print: text => { this.engine.print(text); },
      link: entity => { this.world.link(entity); }, unlink: entity => { this.world.unlinkEntity(entity); } });
    this.pool.clearLevel(); this.pool.clearEntities();
  }
}

interface GameDependencies {
  readonly bots: GameBotServices;
  readonly admission: ClientAdmissionRuntime;
  readonly commands: GameCommandRuntime;
  readonly serverCommands: GameServerCommandRuntime;
}
type GameRuntimePhase =
  | { readonly kind: "core-constructing" | "core-complete" | "published" }
  | { readonly kind: "attached"; readonly bots: GameBotServices }
  | { readonly kind: "dependencies-ready" | "initializing" | "running" | "releasing"; readonly dependencies: GameDependencies }
  | { readonly kind: "closed" };

function sourceTime(value: number): number {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new RangeError("Game time must be a signed 32-bit millisecond value");
  return value;
}
// game/g_public.h gameExport_t, dispatched by game/g_main.c vmMain.
enum GameVmCall {
  Init = 0, Shutdown = 1, ClientConnect = 2, ClientBegin = 3,
  ClientUserinfoChanged = 4, ClientDisconnect = 5, ClientCommand = 6,
  ClientThink = 7, RunFrame = 8, ConsoleCommand = 9, BotFrame = 10,
}
/** Inert core allocation precedes publication and source startup callbacks. */
export class GameRuntime implements ServerGame {
  private static readonly registeredOwners = new WeakMap<VmRegistration, GameRuntime>();
  readonly calls = directGameCalls({
    clientConnect: (number, firstTime, isBot) => { this.markVmCall(GameVmCall.ClientConnect); return this.clientConnect(number, firstTime, isBot); },
    clientBegin: number => { this.markVmCall(GameVmCall.ClientBegin); this.clientBegin(number); },
    clientDisconnect: number => { this.markVmCall(GameVmCall.ClientDisconnect); this.clientDisconnect(number); },
    clientUserinfoChanged: number => { this.markVmCall(GameVmCall.ClientUserinfoChanged); this.clientUserinfoChanged(number); },
    clientCommand: (number, argv) => { this.markVmCall(GameVmCall.ClientCommand); this.clientCommand(number, argv); },
    clientThink: (number, command) => { this.markVmCall(GameVmCall.ClientThink); this.clientThink(number, command); },
    runFrame: time => { this.markVmCall(GameVmCall.RunFrame); this.runFrame(time); },
    botFrame: time => { this.markVmCall(GameVmCall.BotFrame); this.botFrame(time); },
    consoleCommand: argv => { this.markVmCall(GameVmCall.ConsoleCommand); return this.consoleCommand(argv); },
    shutdown: restart => { this.markVmCall(GameVmCall.Shutdown); this.shutdown(restart); },
  });
  readonly data: ServerGameData;
  get product(): Product { return this.options.product; }
  readonly level: GameLevel;
  readonly parser = new CommonParseState();
  readonly pool: EntityPool;
  readonly memory: GameMemory;
  readonly world: ServerWorld;
  readonly random: GameRandom;
  readonly movementDiagnostics: MovementDiagnostics;
  private readonly moduleState: GameModuleState;
  readonly config: ConfigStringRegistry;
  readonly registeredItems: ItemRegistry;
  readonly remaps: ShaderRemapRegistry;
  readonly locations: TargetLocationState;
  readonly combat: CombatContext;
  readonly missiles: MissileRuntime;
  readonly weapons: WeaponRuntime;
  readonly team: TeamRuntime;
  readonly death: DeathRuntime;
  readonly think: ClientThinkRuntime;
  readonly spawns: ClientSpawnRuntime;
  readonly match: MatchRuntime;
  readonly arenas: ArenaRuntime;
  readonly session: GameSessionManager;
  readonly movers: MoverRuntime;
  readonly moverSpawns: MoverSpawnRuntime;
  readonly itemLifecycle: ItemLifecycleContext;
  readonly drops: DropItemContext;
  readonly personalPortal: PersonalPortalRuntime | null;
  private readonly definitions: readonly CvarDefinition[];
  private readonly vmCvars: Map<string, CvarSnapshot>;
  private moduleTransferred = false;
  private get logFile(): GameLog | null { return this.moduleState.logFile; }
  private set logFile(file: GameLog | null) { this.moduleState.logFile = file; }
  private phase: GameRuntimePhase = { kind: "core-constructing" };
  private botsStarted = false;
  private mapReport: SpawnReport | null = null;

  static registered(registration: VmRegistration): GameRuntime | null {
    return registration.binding.kind === "typescript" ? GameRuntime.registeredOwners.get(registration) ?? null : null;
  }

  static reinitialize(options: GameRuntimeOptions, owner: GameRuntimeOwner, registration: VmRegistration): GameRuntime {
    const previous = GameRuntime.registered(registration);
    if (previous === null || owner.game !== previous) throw new Error("Registered game initialization requires its current owner");
    GameRuntime.registeredOwners.delete(registration);
    owner.game = null;
    try { return GameRuntime.createInitialized(options, owner, registration, previous); }
    finally { previous.disposeResources(); }
  }

  static create(options: GameRuntimeOptions, owner: GameRuntimeOwner, registration: VmRegistration | null = null): GameRuntime {
    return GameRuntime.createInitialized(options, owner, registration, null);
  }

  private static createInitialized(options: GameRuntimeOptions, owner: GameRuntimeOwner,
    registration: VmRegistration | null, previous: GameRuntime | null): GameRuntime {
    sourceTime(options.levelTime);
    if (owner.game !== null) throw new Error("Shut down the current game before creating its replacement");
    if (registration?.binding.kind === "initializing") registration.bindTypeScript();
    registration?.called();
    registration?.printCall(GameVmCall.Init);
    const engine = options.engine;
    const runtime = new GameRuntime({ ...options, engine: {
      milliseconds: engine.milliseconds.bind(engine),
      print: engine.print.bind(engine), sendServerCommand: engine.sendServerCommand.bind(engine), dropClient: engine.dropClient.bind(engine),
      getUserinfo: engine.getUserinfo.bind(engine), setUserinfo: engine.setUserinfo.bind(engine), getUserCommand: engine.getUserCommand.bind(engine),
      appendConsoleCommand: engine.appendConsoleCommand.bind(engine), insertConsoleCommand: engine.insertConsoleCommand.bind(engine),
      executeConsoleNow: engine.executeConsoleNow.bind(engine), openLog: engine.openLog.bind(engine),
    } }, owner, registration, previous);
    if (previous !== null) previous.moduleTransferred = true;
    if (registration !== null) GameRuntime.registeredOwners.set(registration, runtime);
    owner.game = runtime;
    runtime.phase = { kind: "published" };
    try { runtime.attach(); }
    catch (error) {
      runtime.phase = { kind: "closed" };
      if (owner.game === runtime) owner.game = null;
      throw error;
    }
    const dependencies = runtime.dependencies();
    runtime.phase = { kind: "initializing", dependencies };
    try { runtime.initialize(); }
    catch (error) {
      if (error instanceof CommonError) throw error;
      try { runtime.releaseResources(options.restart); }
      catch (cleanupError) {
        if (cleanupError instanceof CommonError) throw cleanupError;
        throw new AggregateError([error, cleanupError], "Game initialization and cleanup failed");
      }
      throw error;
    }
    runtime.phase = { kind: "running", dependencies };
    return runtime;
  }

  private constructor(readonly options: GameRuntimeOptions, private readonly owner: GameRuntimeOwner,
    private readonly registration: VmRegistration | null, previous: GameRuntime | null) {
    const runtime = this;
    this.moduleState = previous?.moduleState ?? new GameModuleState(options);
    this.moduleState.engine = options.engine;
    this.moduleState.world = options.world;
    this.level = this.moduleState.level;
    this.locations = this.moduleState.locations;
    this.vmCvars = this.moduleState.vmCvars;
    this.movementDiagnostics = this.moduleState.movementDiagnostics;
    this.remaps = this.moduleState.remaps;
    this.random = this.moduleState.random;
    this.definitions = [...commonCvars, ...(options.product === "missionpack" ? missionpackCvars : []), ...finalCvars];
    for (const definition of this.definitions) {
      if (previous === null) this.vmCvars.set(definition.name.toLowerCase(), {
        name: definition.name, value: "", resetValue: "", latchedValue: undefined, flags: 0,
        modified: false, modificationCount: 0, numericValue: 0, integerValue: 0,
      });
    }
    this.memory = this.moduleState.memory;
    this.pool = this.moduleState.pool;
    this.data = {
      get numEntities() { return runtime.pool.numEntities; },
      entity: number => this.pool.at(number),
      copyPlayerState: client => this.pool.clientAt(client).ps.copy(),
      setPlayerPing: (client, ping) => { this.pool.clientAt(client).ps.ping = ping; },
    };
    this.world = options.world;
    this.config = new ConfigStringRegistry(options.configstrings);
    this.registeredItems = this.moduleState.registeredItems;
    this.combat = this.createCombat();
    const combat = this.combat;
    this.missiles = new MissileRuntime(combat.product === "baseq3"
      ? { combat, world: this.world, get previousTime() { return runtime.level.previousTime; }, missionpack: null }
      : { combat, world: this.world, get previousTime() { return runtime.level.previousTime; }, missionpack: {
        get proxMineTimeout() { return runtime.integer("g_proxMineTimeout"); }, random: this.random,
        soundIndex: path => this.config.soundIndex(path), invulnerabilityImpact: (target, direction, point) => invulnerabilityEffect(this.pool, target, direction, point) } });
    this.weapons = new WeaponRuntime({ missiles: this.missiles, random: this.random, get quadFactor() { return runtime.number("g_quadfactor"); } });
    this.itemLifecycle = { entities: this.pool, world: this.world, product: options.product,
      get gameType() { return runtime.gameType; }, get weaponRespawnSeconds() { return runtime.integer("g_weaponrespawn"); },
      get teamWeaponRespawnSeconds() { return runtime.integer("g_weaponTeamRespawn"); }, handicapForClient: number => this.userinfo(number, "handicap"),
      teamPickup: (item, player) => this.team.pickupTeam(item, player), useTargets: (item, player) => useTargets(this.targets(), item, player),
      soundIndex: path => this.config.soundIndex(path), random: this.random, registry: this.registeredItems,
      log: text => this.log(text), warn: options.engine.print };
    this.drops = { entities: this.pool, product: options.product, get gameType() { return runtime.gameType; }, get time() { return runtime.level.time; },
      touchItem: (entity, other, trace) => touchItem(entity, other, trace, this.itemLifecycle),
      droppedFlagThink: entity => this.team.droppedFlagThink(entity), checkDroppedTeamItem: entity => this.team.checkDroppedItem(entity), random: () => this.random.random() };
    this.team = this.createTeam();
    this.death = this.createDeath();
    this.think = new ClientThinkRuntime({ pool: this.pool, world: this.world, movementDiagnostics: this.movementDiagnostics,
      effects: { combat: this.combat }, frame: () => this.level,
      settings: () => ({ synchronousClients: this.integer("g_synchronousClients") !== 0, pmoveFixed: this.integer("pmove_fixed") !== 0,
        debugMove: this.integer("g_debugMove"),
        pmoveMsec: this.integer("pmove_msec"), gravity: this.number("g_gravity"), speed: this.number("g_speed"), dmflags: this.integer("dmflags"),
        smoothClients: this.integer("g_smoothClients") !== 0, forceRespawnSeconds: this.integer("g_forcerespawn"), singlePlayer: this.singlePlayerActive() }),
      setPmoveMsec: value => this.setCvar("pmove_msec", String(value)), intermissionThink: clientIntermissionThink,
      spectatorThink: (entity, command) => spectatorThink(this.policy(), entity, command), checkInactivity: client => clientInactivityTimer(this.policy(), client),
      freeHook: hook => this.missiles.hookFree(hook), checkGauntletAttack: entity => this.weapons.checkGauntletAttack(entity),
      clientEvents: (entity, oldSequence) => this.runClientEvents(entity, oldSequence), respawn: entity => this.spawns.respawn(entity),
      appendConsoleCommand: options.engine.appendConsoleCommand, isDoorTrigger: entity => this.moverSpawns.isDoorTrigger(entity),
      botTestAas: origin => {
        const bots = this.dependencies().bots;
        if (bots.kind === "available") bots.testAas(origin);
      } });
    this.spawns = new ClientSpawnRuntime({ pool: this.pool, world: this.world, random: this.random, think: this.think,
      frame: () => ({ time: this.level.time, gameType: this.gameType, inactivitySeconds: this.integer("g_inactivity"), intermissionTime: this.level.intermissionTime }),
      userCommand: options.engine.getUserCommand, handicap: number => this.userinfo(number, "handicap"),
      findIntermissionPoint: () => this.match.findIntermissionPoint(), moveToIntermission: entity => this.match.moveClientToIntermission(entity),
      killBox: entity => killBox(this.combat, entity), playerDie: this.death.playerDie, bodyDie: this.death.bodyDie,
      effects: () => this.effects(), targets: () => this.targets() }, this.moduleState.clientSpawns);
    this.session = new GameSessionManager(this.sessionState(), { cvars: { get: name => this.engineCvar(name), set: (name, value) => this.setCvar(name, value) },
      print: options.engine.print, broadcastTeamChange: (number, oldTeam) => this.commands.broadcastTeamChange(number, oldTeam) });
    this.match = this.createMatch();
    this.arenas = new ArenaRuntime({ match: this.match, world: this.world, cvars: options.cvars, config: this.config });
    this.movers = new MoverRuntime(combat.product === "baseq3"
      ? { combat, ...this.moverServices(), get previousTime() { return runtime.level.previousTime; }, missionpack: null }
      : { combat, ...this.moverServices(), get previousTime() { return runtime.level.previousTime; }, missionpack: { explodeMissile: entity => this.missiles.explode(entity) } });
    this.moverSpawns = new MoverSpawnRuntime({ movers: this.movers, gravity: () => this.number("g_gravity"),
      setBrushModel: (entity, name) => this.setBrushModel(entity, name),
      remapShader: (oldName, newName, time) => this.remapShader(oldName, newName, time), warn: options.engine.print });
    this.personalPortal = this.createPersonalPortal();
    this.phase = { kind: "core-complete" };
  }

  private attach(): void {
    if (this.phase.kind !== "published") throw new Error("Game attachment requires its published core");
    const factory = this.options.botFactory;
    const bots = factory.kind === "unavailable" ? factory : factory.attach(this);
    this.phase = { kind: "attached", bots };
    const admission = this.createAdmission(bots);
    const commands = this.createCommands(admission);
    const serverCommands = new GameServerCommandRuntime(this.pool, this.options.cvars, {
      readVmCvar: name => this.snapshot(name),
      print: this.options.engine.print, sendServerCommand: this.options.engine.sendServerCommand, executeConsoleNow: this.options.engine.executeConsoleNow,
      setTeam: (entity, request) => commands.setTeam(entity, request),
      bots: bots.kind === "unavailable" ? bots : { kind: "available", run: argv => bots.consoleCommand(argv) },
      memory: { kind: "available", run: () => this.memory.status() },
      podium: { kind: "available", run: () => this.arenas.abortPodium() },
    }, this.moduleState.serverCommands);
    this.phase = { kind: "dependencies-ready", dependencies: { bots, admission, commands, serverCommands } };
  }

  private dependencies(): GameDependencies {
    const phase = this.phase;
    if (phase.kind === "dependencies-ready" || phase.kind === "initializing" || phase.kind === "running" || phase.kind === "releasing") {
      return phase.dependencies;
    }
    throw new Error(`Game dependencies are unavailable during ${phase.kind}`);
  }
  get admission(): ClientAdmissionRuntime { return this.dependencies().admission; }
  get commands(): GameCommandRuntime { return this.dependencies().commands; }
  get serverCommands(): GameServerCommandRuntime { return this.dependencies().serverCommands; }

  /** The VM retains the registered integer until G_UpdateCvars, including out-of-range modes. */
  get gameType(): number { return this.integer("g_gametype"); }
  get spawnReport(): SpawnReport {
    if (this.mapReport === null) throw new Error("Game map has not finished spawning");
    return this.mapReport;
  }
  private snapshot(name: string): CvarSnapshot {
    const value = this.vmCvars.get(name.toLowerCase());
    if (value === undefined) throw new Error(`Unregistered game cvar ${name}`);
    return value;
  }
  private integer(name: string): number { return this.snapshot(name).integerValue; }
  private number(name: string): number { return Math.fround(this.snapshot(name).numericValue); }
  private string(name: string): string { return this.snapshot(name).value; }
  private engineCvar(name: string): string { return this.options.cvars.get(name)?.value ?? ""; }
  private setCvar(name: string, value: string): void { this.options.cvars.set(name, value, true); }
  private userinfo(clientNum: number, key: string): string { return clientInfoValue(this.options.engine.getUserinfo(clientNum), key); }
  private singlePlayerActive(): boolean { return this.options.product === "missionpack" && this.integer("ui_singlePlayerActive") !== 0; }
  private requireOpen(): void { if (this.phase.kind === "closed") throw new Error("Game runtime is shut down"); }
  private markVmCall(call: GameVmCall): void {
    this.requireOpen();
    this.registration?.called();
    this.registration?.printCall(call);
  }

  private createCombat(): CombatContext {
    const runtime = this;
    const services = { entities: this.pool, world: this.world,
      checkHurtCarrier: (target: GameEntity, attacker: GameEntity) => this.team.checkHurtCarrier(target, attacker),
      logAccuracyHit: (target: GameEntity, attacker: GameEntity) => logAccuracyHit(this.gameType, target, attacker) };
    const debugDamage = (diagnostic: DamageDiagnostic): void => {
      this.options.engine.print(gameFormat("%i: client:%i health:%i damage:%i armor:%i\n", [diagnostic.time, diagnostic.entityNum,
        diagnostic.health, diagnostic.damage, diagnostic.armor]));
    };
    return this.options.product === "baseq3" ? { ...services, product: "baseq3",
      get time() { return runtime.level.time; }, get intermissionQueued() { return runtime.level.intermissionQueued; },
      get gameType() { return runtime.gameType; }, get friendlyFire() { return runtime.integer("g_friendlyFire") !== 0; },
      get knockback() { return runtime.number("g_knockback"); }, get debugDamage() { return runtime.integer("g_debugDamage") !== 0 ? debugDamage : null; } }
      : { ...services, product: "missionpack",
        get time() { return runtime.level.time; }, get intermissionQueued() { return runtime.level.intermissionQueued; },
        get gameType() { return runtime.gameType; }, get friendlyFire() { return runtime.integer("g_friendlyFire") !== 0; },
        get knockback() { return runtime.number("g_knockback"); }, get debugDamage() { return runtime.integer("g_debugDamage") !== 0 ? debugDamage : null; },
        checkObeliskAttack: (target, attacker) => this.team.checkObeliskAttack(target, attacker),
        invulnerabilityEffect: (target, direction, point) => { invulnerabilityEffect(this.pool, target, direction, point); } };
  }

  private createTeam(): TeamRuntime {
    const runtime = this;
    const services = { pool: this.pool, world: this.world, teamScores: this.level.teamScores,
      sortedClients: this.level.sortedClients,
      sendServerCommand: this.options.engine.sendServerCommand, setConfigstring: (index: number, value: string) => this.options.configstrings.set(index, value),
      warn: this.options.engine.print, addScore: (entity: GameEntity, origin: Vec3, score: number) => this.death.addScore(entity, origin, score),
      calculateRanks: () => this.match.calculateRanks(), respawnItem: (item: GameEntity) => respawnItem(item, this.itemLifecycle),
      inPVS: (first: Vec3, second: Vec3) => this.inPVS(first, second) };
    return new TeamRuntime(this.options.product === "baseq3" ? { ...services, product: "baseq3",
      get time() { return runtime.level.time; }, get gameType() { return runtime.gameType; }, get locationHead() { return runtime.locations.head; } }
      : { ...services, product: "missionpack", get time() { return runtime.level.time; }, get gameType() { return runtime.gameType; },
        get locationHead() { return runtime.locations.head; }, obelisk: {
          get health() { return runtime.integer("g_obeliskHealth"); }, get regenPeriodSeconds() { return runtime.integer("g_obeliskRegenPeriod"); },
          get regenAmount() { return runtime.integer("g_obeliskRegenAmount"); }, get respawnDelaySeconds() { return runtime.integer("g_obeliskRespawnDelay"); } } });
  }

  private createDeath(): DeathRuntime {
    const services = { pool: this.pool, world: this.world, random: this.random, teamScores: this.level.teamScores, missiles: this.missiles, items: this.drops,
      frame: () => ({ time: this.level.time, gameType: this.gameType, warmupTime: this.level.warmupTime,
        intermissionTime: this.level.intermissionTime, blood: this.integer("com_blood") !== 0 }),
      calculateRanks: () => this.match.calculateRanks(), sendScoreboard: (entity: GameEntity) => this.commands.scoreboard(entity),
      log: (text: string) => this.log(text), teamFragBonuses: (victim: GameEntity, inflictor: GameEntity | null, attacker: GameEntity | null) => this.team.fragBonuses(victim, inflictor, attacker),
      returnFlag: (team: Team) => this.team.returnFlag(team) };
    return new DeathRuntime(this.options.product === "baseq3" ? { ...services, product: "baseq3" }
      : { ...services, product: "missionpack", neutralObelisk: () => this.team.neutralObelisk,
        cubeTimeoutSeconds: () => this.integer("g_cubeTimeout"), startKamikaze: timer => { this.weapons.startKamikaze(timer); } });
  }

  private createMatch(): MatchRuntime {
    const services = { state: this.level, pool: this.pool, teamScores: this.level.teamScores, random: this.random, spawn: this.spawns,
      settings: () => ({ gameType: this.gameType, timeLimit: this.integer("timelimit"), fragLimit: this.integer("fraglimit"), captureLimit: this.integer("capturelimit"),
        warmupSeconds: this.integer("g_warmup"), warmupModificationCount: this.snapshot("g_warmup").modificationCount,
        password: this.string("g_password"), passwordModificationCount: this.snapshot("g_password").modificationCount }),
      setTeam: (entity: GameEntity, team: "f" | "s") => this.commands.setTeam(entity, team), stopFollowing: (entity: GameEntity) => this.commands.stopFollowing(entity),
      sendScoreboard: (entity: GameEntity) => this.commands.scoreboard(entity), clientUserinfoChanged: (number: number) => this.admission.userinfoChanged(number),
      writeSessionData: () => this.session.writeWorld(), appendConsoleCommand: this.options.engine.appendConsoleCommand,
      sendServerCommand: this.options.engine.sendServerCommand, setConfigstring: (index: number, value: string) => this.options.configstrings.set(index, value),
      setCvar: (name: string, value: string) => this.setCvar(name, value), log: (text: string) => this.log(text), warn: this.options.engine.print,
      botInterbreedEndMatch: () => { if (this.botsStarted) this.requireBots().interbreedEndMatch(); },
      updateTournamentInfo: () => this.arenas.updateTournamentInfo() };
    return new MatchRuntime(this.options.product === "baseq3" ? { ...services, product: "baseq3", spawnModelsOnVictoryPads: () => this.arenas.spawnModelsOnVictoryPads() }
      : { ...services, product: "missionpack", singlePlayer: () => this.singlePlayerActive() }, this.moduleState.match);
  }

  private sessionState(): SessionWorldState {
    const runtime = this;
    return { clients: this.pool.clients, get maxClients() { return runtime.pool.maxClients; }, teamScores: this.level.teamScores,
      get gameType() { return runtime.gameType; }, get teamAutoJoin() { return runtime.integer("g_teamAutoJoin") !== 0; },
      get maxGameClients() { return runtime.integer("g_maxGameClients"); }, get time() { return runtime.level.time; },
      get numNonSpectatorClients() { return runtime.level.numNonSpectatorClients; },
      get newSession() { return runtime.level.newSession; }, set newSession(value) { runtime.level.newSession = value; } };
  }

  private policy(): ClientPolicyContext {
    return { pool: this.pool, world: this.world, time: this.level.time, inactivitySeconds: this.integer("g_inactivity"),
      movementDiagnostics: this.movementDiagnostics,
      follow1: this.level.follow1, follow2: this.level.follow2, touchTriggers: entity => this.think.touchTriggers(entity),
      followCycle: (entity, direction) => this.commands.followCycle(entity, direction), clientBegin: number => this.admission.begin(number),
      dropClient: this.options.engine.dropClient, sendServerCommand: this.options.engine.sendServerCommand };
  }
  private effects(): ClientEffectsContext {
    return { combat: this.combat, intermissionTime: this.level.intermissionTime, smoothClients: this.integer("g_smoothClients") !== 0,
      frySound: this.level.frySound, randomInt: () => this.random.rand(), soundIndex: path => this.config.soundIndex(path),
      sound: (entity, _channel, sound) => { this.pool.tempEntity(entity.r.currentOrigin, EntityEvent.EV_GENERAL_SOUND).s.eventParm = sound; },
      spectatorEndFrame: entity => spectatorClientEndFrame(this.policy(), entity) };
  }
  private moverServices() {
    return { world: this.world, config: this.config, useTargets: (entity: GameEntity, activator: GameEntity) => useTargets(this.targets(), entity, activator),
      adjustAreaPortalState: (entity: GameEntity, open: boolean) => this.world.adjustAreaPortalState(entity, open),
      returnDroppedFlag: (entity: GameEntity) => this.team.freeEntity(entity) };
  }
  private inPVS(first: Vec3, second: Vec3): boolean {
    const collision = this.options.collision, a = collision.pointLeafnum(first), b = collision.pointLeafnum(second);
    return collision.clusterVisible(collision.leafCluster(a), collision.leafCluster(b)) && collision.areasConnected(collision.leafArea(a), collision.leafArea(b));
  }
  private setBrushModel(entity: GameEntity, name: string | null): void {
    if (name === null || !name.startsWith("*")) throw new Error(`SV_SetBrushModel: ${name} is not a brush model`);
    const index = gameAtoi(name.slice(1));
    entity.s.modelindex = index;
    const bounds = this.options.collision.modelBounds(index);
    entity.r.mins = { ...bounds.min }; entity.r.maxs = { ...bounds.max };
    entity.r.model = { kind: "inline", index }; entity.r.contents = -1;
    this.world.link(entity);
  }
  private createPersonalPortal(): PersonalPortalRuntime | null {
    const combat = this.combat;
    return combat.product === "baseq3" ? null : new PersonalPortalRuntime({ combat, world: this.world, models: this.config, random: this.random, items: this.drops });
  }
  private runClientEvents(entity: GameEntity, oldSequence: number): void {
    const combat = this.combat, runtime = this;
    const services = { world: this.world, weapons: this.weapons, spawns: this.spawns, drops: this.drops, get dmflags() { return runtime.integer("dmflags"); } };
    if (combat.product === "baseq3") clientEvents({ ...services, product: "baseq3", combat }, entity, oldSequence);
    else {
      const personalPortal = this.personalPortal;
      if (personalPortal === null) throw new Error("Missionpack portal runtime is missing");
      clientEvents({ ...services, product: "missionpack", combat, personalPortal }, entity, oldSequence);
    }
  }
  private createCommands(admission: ClientAdmissionRuntime): GameCommandRuntime {
    const runtime = this;
    return new GameCommandRuntime({ pool: this.pool, state: this.level, teamScores: this.level.teamScores,
      get settings() { return { gameType: runtime.gameType, cheats: runtime.integer("sv_cheats") !== 0,
        teamForceBalance: runtime.integer("g_teamForceBalance") !== 0, maxGameClients: runtime.integer("g_maxGameClients"),
        dedicated: runtime.integer("dedicated") !== 0, allowVote: runtime.integer("g_allowVote") !== 0 }; },
      imports: { sendServerCommand: this.options.engine.sendServerCommand, setConfigstring: (index, text) => this.options.configstrings.set(index, text),
        appendConsoleCommand: this.options.engine.appendConsoleCommand, getCvar: name => this.engineCvar(name),
        getUserinfo: this.options.engine.getUserinfo, setUserinfo: this.options.engine.setUserinfo, log: text => this.log(text), print: this.options.engine.print },
      team: this.team, death: this.death, spawn: this.spawns, admission, match: this.match, items: this.itemLifecycle,
      teleport: { combat: this.combat, world: this.world } });
  }
  private createAdmission(bots: GameBotServices): ClientAdmissionRuntime {
    return new ClientAdmissionRuntime({ product: this.options.product, pool: this.pool, world: this.world, state: this.level,
      teamScores: this.level.teamScores, session: this.session, spawn: this.spawns, death: this.death, match: this.match,
      commands: { broadcastTeamChange: (number, oldTeam) => this.commands.broadcastTeamChange(number, oldTeam), stopFollowing: entity => this.commands.stopFollowing(entity) },
      bots, settings: () => ({ gameType: this.gameType, password: this.string("g_password") }),
      getUserinfo: this.options.engine.getUserinfo, setConfigstring: (index, value) => this.options.configstrings.set(index, value),
      sendServerCommand: this.options.engine.sendServerCommand, log: text => this.log(text), filterPacket: address => this.serverCommands.filterPacket(address) });
  }

  private spawnHandlers(): ReadonlyMap<string, SpawnHandler> {
    const shared = { entities: this.pool, world: this.world, random: this.random, combat: () => this.combat,
      gravity: () => this.number("g_gravity"), soundIndex: (path: string) => this.config.soundIndex(path),
      remapShader: (oldName: string, newName: string, time: number) => this.remapShader(oldName, newName, time), warn: this.options.engine.print };
    const handlers = new Map<string, SpawnHandler>([
      ["info_player_start", spawnPlayerStart], ["info_player_deathmatch", spawnDeathmatchPoint],
      // SP_info_player_intermission and SP_item_botroam have empty source bodies.
      ["info_player_intermission", () => {}], ["item_botroam", () => {}],
      ["team_CTF_redplayer", spawnTeamPoint], ["team_CTF_blueplayer", spawnTeamPoint],
      ["team_CTF_redspawn", spawnTeamPoint], ["team_CTF_bluespawn", spawnTeamPoint],
      ...miscSpawnHandlers({ missiles: this.missiles, itemRegistry: this.registeredItems, random: this.random, warn: this.options.engine.print }),
      ...this.moverSpawns.handlers(),
      ...triggerSpawnHandlers({ ...shared, setBrushModel: (entity, name) => this.setBrushModel(entity, name) }),
      ...targetSpawnHandlers({ ...shared, itemLifecycle: this.itemLifecycle, locations: this.locations,
        addScore: (entity, origin, score) => this.death.addScore(entity, origin, score), returnFlag: team => this.team.returnFlag(team),
        sendServerCommand: this.options.engine.sendServerCommand, setConfigstring: (index, value) => this.options.configstrings.set(index, value) }),
    ]);
    const remove = handlers.get("info_null");
    if (remove === undefined) throw new Error("Source info_null handler is unavailable");
    handlers.set("func_group", remove);
    if (this.options.product === "missionpack") {
      handlers.set("team_redobelisk", entity => this.team.spawnTeamObelisk(entity, Team.TEAM_RED));
      handlers.set("team_blueobelisk", entity => this.team.spawnTeamObelisk(entity, Team.TEAM_BLUE));
      handlers.set("team_neutralobelisk", entity => this.team.spawnNeutralObelisk(entity));
    }
    return handlers;
  }

  private initialize(): void {
    const engine = this.options.engine;
    engine.print("------- Game Initialization -------\n");
    engine.print("gamename: baseq3\n");
    engine.print(`gamedate: ${this.options.buildDate}\n`);
    this.random.reset(this.options.randomSeed);
    for (const definition of this.definitions) {
      if (definition.name === "g_restarted") {
        this.options.cvars.register("gamename", "baseq3", S | R);
        this.options.cvars.register("gamedate", this.options.buildDate, R);
      }
      if (definition.name === "g_gametype") this.options.cvars.register("sv_mapname", "", S | R);
      this.vmCvars.set(definition.name.toLowerCase(), this.options.cvars.register(definition.name, definition.value, definition.flags));
    }
    this.remapTeams();
    const type = this.integer("g_gametype");
    if (type < 0 || type >= GameType.GT_MAX_GAME_TYPE) {
      engine.print(gameFormat("g_gametype %i is out of range, defaulting to 0\n", [type]));
      this.setCvar("g_gametype", "0");
    }
    this.level.warmupModificationCount = this.snapshot("g_warmup").modificationCount;
    this.serverCommands.processIPBans();
    this.memory.initialize();
    this.level.clear(); this.pool.clearLevel(); this.locations.reset();
    this.moduleState.clientSpawns.bodyQueue = null;
    if (this.logFile !== null) this.moduleState.retiredLogs.add(this.logFile);
    this.logFile = null;
    this.level.time = this.options.levelTime; this.level.startTime = this.options.levelTime;
    this.level.frySound = this.config.soundIndex("sound/player/fry.wav");
    if (this.gameType !== GameType.GT_SINGLE_PLAYER && this.string("g_log") !== "") {
      this.logFile = engine.openLog(this.string("g_log"), this.integer("g_logSync") !== 0);
      if (this.logFile === null) engine.print(`WARNING: Couldn't open logfile: ${this.string("g_log")}\n`);
      else { this.log("------------------------------------------------------------\n"); this.log(`InitGame: ${this.options.cvars.infoString(S)}\n`); }
    } else engine.print("Not logging to disk.\n");
    this.session.initializeWorld();
    this.pool.clearEntities();
    this.pool.initializeClients(this.integer("sv_maxclients"));
    this.spawns.initBodyQueue(); this.registeredItems.clear(this.gameType);
    const runtime = this;
    this.mapReport = spawnEntities(this.options.map.entities, { pool: this.pool, memory: this.memory, product: this.options.product, gameType: this.gameType,
      handlers: this.spawnHandlers(), spawnItem: (entity, item, variables) => spawnItem(entity, item, variables,
        () => gameAtoi(this.engineCvar(`disable_${item.className}`)) !== 0, this.itemLifecycle), warn: engine.print,
      world: { pool: this.pool, startTime: this.level.startTime, motd: this.string("g_motd"), restarted: this.integer("g_restarted"), doWarmup: this.integer("g_doWarmup"),
        get warmupTime() { return runtime.level.warmupTime; }, set warmupTime(value) { runtime.level.warmupTime = value; },
        setConfigstring: (index, value) => this.options.configstrings.set(index, value), setCvar: (name, value) => this.setCvar(name, value), log: text => this.log(text) } });
    this.findTeams();
    if (this.gameType >= GameType.GT_TEAM) this.checkTeamItems();
    this.registeredItems.save((index, value) => this.options.configstrings.set(index, value), engine.print);
    engine.print("-----------------------------------\n");
    if (this.gameType === GameType.GT_SINGLE_PLAYER || gameAtoi(this.engineCvar("com_buildScript")) !== 0) {
      this.config.modelIndex("models/mapobjects/podium/podium4.md3");
      this.config.soundIndex("sound/player/gurp1.wav"); this.config.soundIndex("sound/player/gurp2.wav");
    }
    if (gameAtoi(this.engineCvar("bot_enable")) !== 0) {
      const bots = this.requireBots(); this.botsStarted = true; bots.initialize(this.options.restart);
      bots.loadMap(this.options.restart); bots.initializeBots(this.options.restart);
    }
    this.remapTeams();
  }

  private remapTeams(levelTime = this.level.time): void {
    if (this.options.product !== "missionpack") return;
    const time = Math.fround(Math.fround(levelTime) * Math.fround(0.001));
    for (const suffix of ["01", "02"]) this.remaps.add(`textures/ctf2/redteam${suffix}`, `team_icon/${this.string("g_redteam")}_red`, time);
    for (const suffix of ["01", "02"]) this.remaps.add(`textures/ctf2/blueteam${suffix}`, `team_icon/${this.string("g_blueteam")}_blue`, time);
    this.options.configstrings.set(24, this.remaps.buildShaderStateConfig());
  }
  private updateCvars(): void {
    let remapped = false;
    for (const definition of this.definitions) {
      const previous = this.snapshot(definition.name), current = this.options.cvars.get(definition.name);
      if (current === undefined) throw new Error(`Game cvar ${definition.name} disappeared`);
      this.vmCvars.set(definition.name.toLowerCase(), current);
      if (previous.modificationCount === current.modificationCount) continue;
      if (definition.track) this.options.engine.sendServerCommand(-1, gameFormat('print "Server: %s changed to %s\n"', [definition.name, current.value]));
      if (definition.teamShader) remapped = true;
    }
    if (remapped) this.remapTeams();
  }
  private findTeams(): void {
    let count = 0, members = 0;
    for (let index = 1; index < this.pool.numEntities; index++) {
      const master = this.pool.at(index);
      if (!master.inuse || master.team === null || (master.flags & GameFlags.TEAMSLAVE) !== 0) continue;
      master.teammaster = master; count++; members++;
      for (let next = index + 1; next < this.pool.numEntities; next++) {
        const entity = this.pool.at(next);
        if (!entity.inuse || entity.team === null || (entity.flags & GameFlags.TEAMSLAVE) !== 0 || entity.team !== master.team) continue;
        members++; entity.teamchain = master.teamchain; master.teamchain = entity;
        entity.teammaster = master; entity.flags |= GameFlags.TEAMSLAVE;
        if (entity.targetname !== null) { master.targetname = entity.targetname; entity.targetname = null; }
      }
    }
    this.options.engine.print(gameFormat("%i teams with %i entities\n", [count, members]));
  }
  private checkTeamItems(): void {
    this.team.initGame();
    const flags = this.gameType === GameType.GT_CTF ? ["Red", "Blue"]
      : this.options.product === "missionpack" && this.gameType === GameType.GT_1FCTF ? ["Red", "Blue", "Neutral"] : [];
    for (const name of flags) {
      const item = findItem(this.options.product, `${name} Flag`);
      if (item === null || !this.registeredItems.isRegistered(item)) this.options.engine.print(`^3WARNING: No team_CTF_${name.toLowerCase()}flag in map`);
    }
    const obelisks = this.options.product !== "missionpack" ? [] : this.gameType === GameType.GT_OBELISK ? ["team_redobelisk", "team_blueobelisk"]
      : this.gameType === GameType.GT_HARVESTER ? ["team_redobelisk", "team_blueobelisk", "team_neutralobelisk"] : [];
    for (const name of obelisks) if (findEntity(this.pool, null, "classname", name) === null) this.options.engine.print(`^3WARNING: No ${name} in map`);
  }

  runFrame(time: number): void {
    this.requireOpen(); sourceTime(time);
    if (this.level.restarted) return;
    this.level.frameNum = (this.level.frameNum + 1) | 0; this.level.previousTime = this.level.time; this.level.time = time;
    this.updateCvars();
    this.options.engine.milliseconds();
    for (let index = 0; index < this.pool.numEntities; index++) {
      const entity = this.pool.at(index);
      if (this.pool.expireEvents(entity) !== "active") continue;
      if (entity.neverFree && this.world.linkState(entity.slot)?.linked !== true) continue;
      if (entity.s.eType === EntityType.ET_MISSILE) this.missiles.run(entity);
      else if (entity.s.eType === EntityType.ET_ITEM || entity.physicsObject) runItem(entity, { entities: this.pool, world: this.world,
        time: this.level.time, previousTime: this.level.previousTime, freeTeamEntity: item => this.team.freeEntity(item) });
      else if (entity.s.eType === EntityType.ET_MOVER) this.movers.run(entity);
      else if (index < MAX_CLIENTS) this.think.runClient(entity);
      else runThink(entity, this.level.time);
    }
    this.options.engine.milliseconds();
    this.options.engine.milliseconds();
    for (let index = 0; index < this.pool.maxClients; index++) {
      const entity = this.pool.at(index); if (entity.inuse) clientEndFrame(this.effects(), entity);
    }
    this.options.engine.milliseconds();
    this.match.checkTournament(); this.match.checkExitRules(); this.team.checkTeamStatus(); this.match.checkVote();
    this.match.checkTeamVote(Team.TEAM_RED); this.match.checkTeamVote(Team.TEAM_BLUE); this.match.checkCvars();
    if (this.integer("g_listEntity") !== 0) {
      for (let index = 0; index < MAX_GENTITIES; index++) this.options.engine.print(gameFormat("%4i: %s\n", [index, this.pool.at(index).classname]));
      this.setCvar("g_listEntity", "0");
    }
  }
  clientConnect(number: number, firstTime: boolean, isBot: boolean): string | null {
    this.requireOpen(); if (isBot) this.requireBots();
    return this.admission.connect(number, firstTime, isBot);
  }
  clientBegin(number: number): void { this.requireOpen(); this.admission.begin(number); }
  clientThink(number: number, command: UserCommand): void { this.requireOpen(); this.think.clientThink(number, command); }
  clientUserinfoChanged(number: number): void { this.requireOpen(); this.admission.userinfoChanged(number); }
  clientDisconnect(number: number): void { this.requireOpen(); this.admission.disconnect(number); }
  clientCommand(number: number, argv: readonly string[]): void { this.requireOpen(); this.commands.dispatch(number, argv); }
  consoleCommand(argv: readonly string[]): boolean { this.requireOpen(); return this.serverCommands.consoleCommand(argv); }
  botFrame(time: number): void { this.requireOpen(); sourceTime(time); this.requireBots().frame(time); }
  shutdown(restart: boolean): void {
    if (this.phase.kind === "closed") return;
    try {
      this.options.engine.print("==== ShutdownGame ====\n");
      if (this.logFile !== null) {
        this.log("ShutdownGame:\n"); this.log("------------------------------------------------------------\n"); this.closeLog();
      }
      this.session.writeWorld();
    } catch (error) {
      if (error instanceof CommonError) throw error;
      this.releaseResources(restart);
      throw error;
    }
    this.releaseResources(restart);
  }
  /** Managed teardown of this game's private resources; supplied bot services are borrowed. */
  disposeResources(): void {
    if (this.phase.kind === "closed") {
      try { if (!this.moduleTransferred) this.disposeLogs(); }
      finally { this.releaseRegistration(); }
      return;
    }
    this.phase = { kind: "closed" };
    this.botsStarted = false;
    try { if (!this.moduleTransferred) this.disposeLogs(); }
    finally {
      if (this.owner.game === this) this.owner.game = null;
      this.releaseRegistration();
    }
  }
  private releaseRegistration(): void {
    const registration = this.registration;
    if (registration === null || GameRuntime.registeredOwners.get(registration) !== this) return;
    GameRuntime.registeredOwners.delete(registration);
    registration.free();
  }
  private closeLog(): void {
    const file = this.logFile;
    this.logFile = null;
    file?.close();
  }
  private disposeLogs(): void {
    const files = [...this.moduleState.retiredLogs];
    this.moduleState.retiredLogs.clear();
    if (this.logFile !== null) files.push(this.logFile);
    this.logFile = null;
    let failure: { kind: "none" } | { kind: "thrown"; value: unknown } = { kind: "none" };
    for (const file of files) {
      try { file.close(); } catch (value) { failure = { kind: "thrown", value }; }
    }
    if (failure.kind === "thrown") throw failure.value;
  }
  private releaseResources(restart: boolean): void {
    this.phase = { kind: "releasing", dependencies: this.dependencies() };
    let failure: { kind: "none" } | { kind: "ordinary"; error: unknown } = { kind: "none" };
    try { this.closeLog(); }
    catch (error) {
      if (error instanceof CommonError) throw error;
      failure = { kind: "ordinary", error };
    }
    if (this.botsStarted) {
      this.botsStarted = false;
      try {
        this.requireBots().shutdown(restart);
      } catch (error) {
        if (error instanceof CommonError) throw error;
        failure = { kind: "ordinary", error };
      }
    }
    this.phase = { kind: "closed" };
    if (this.owner.game === this) this.owner.game = null;
    if (failure.kind === "ordinary") throw failure.error;
  }
  private requireBots(): Extract<GameBotServices, { kind: "available" }> {
    const bots = this.dependencies().bots;
    if (bots.kind === "unavailable") throw new Error(`Game bot services unavailable: ${bots.reason}`);
    return bots;
  }

  private targets(): TargetUseContext {
    return { pool: this.pool, time: this.level.time, remapShader: (oldName, newName, time) => this.remapShader(oldName, newName, time), warn: this.options.engine.print };
  }
  private remapShader(oldName: string, newName: string, time: number): void {
    this.remaps.add(oldName, newName, time);
    this.options.configstrings.set(24, this.remaps.buildShaderStateConfig());
  }
  private log(text: string): void {
    let seconds = Math.trunc(this.level.time / 1000);
    const minutes = Math.trunc(seconds / 60);
    seconds -= minutes * 60;
    const tens = Math.trunc(seconds / 10); seconds -= tens * 10;
    if (this.integer("dedicated") !== 0) this.options.engine.print(text);
    this.logFile?.write(gameFormat("%3i:%i%i ", [minutes, tens, seconds]).slice(0, 7) + text);
  }
}
