// Port of id Software's sv_init.c/sv_ccmds.c server lifetime and cmd.c file commands.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { AsyncLocalStorage } from "node:async_hooks";
import { finishCalls, runCalls, waitForCall } from "../core/call-steps.ts";
import type { CallSteps } from "../core/call-steps.ts";
import type { BspMap } from "../assets/bsp.ts";
import { parseQvmRestart, QvmHeaderError } from "../assets/qvm.ts";
import type { TrackedVirtualFileSystem } from "../assets/vfs.ts";
import type { WritableFileSystem } from "../assets/writable-files.ts";
import type { CollisionWorld } from "../collision/world.ts";
import type { CommandBuffer } from "../core/commands.ts";
import type { CommandContext } from "../core/commands.ts";
import type { ConsoleOutput } from "../core/console-output.ts";
import { CvarFlag } from "../core/cvar.ts";
import { CommonParseCursor, CommonParseState } from "../core/common-parse.ts";
import type { CvarSnapshot } from "../core/cvar.ts";
import { printInfo } from "../core/info-string.ts";
import { nativeAtoi } from "../core/native-numeric.ts";
import type { LinuxNativeRandom } from "../core/native-random.ts";
import { isPrereleaseDemo } from "../core/product-profile.ts";
import { GameRuntime } from "../game/runtime.ts";
import type { LanAddresses } from "../platform/lan.ts";
import { UnixSystemClock } from "../platform/system-clock.ts";
import type { Ipv4Address, UdpTransport } from "../platform/network.ts";
import type { LoopbackTransport } from "../protocol/loopback.ts";
import { ServerClientCommandRuntime } from "../server/client-commands.ts";
import { ServerBotAdapter } from "../server/bot-adapter.ts";
import { ServerClientLifecycleRuntime } from "../server/client-lifecycle.ts";
import { registerServerCvars } from "../server/config.ts";
import { ServerConnectionlessRuntime } from "../server/connectionless.ts";
import { ServerDownloadRuntime } from "../server/downloads.ts";
import { ServerFrameRuntime } from "../server/frame.ts";
import type { ServerGame } from "../server/game.ts";
import { ServerNetChannelRuntime } from "../server/net-channel.ts";
import type { ServerPacketAddress } from "../server/net-channel.ts";
import { ServerNetworkControlState } from "../server/network-control.ts";
import { ServerPureRuntime } from "../server/pure.ts";
import { ServerRconRuntime } from "../server/rcon.ts";
import { ServerSnapshotSendRuntime } from "../server/snapshot-send.ts";
import { ServerSnapshotRuntime } from "../server/snapshots.ts";
import { ServerClient, ServerClientPhase, ServerStaticState, ServerWorldState } from "../server/state.ts";
import { ServerWorld, ServerWorldSectors } from "../server/world.ts";
import { GameType, PersistentIndex } from "../shared/definitions.ts";
import type { CommonConsole } from "./common-console.ts";
import { CommonError } from "../core/common-error.ts";
import { registerSourceBotCvars, SourceBots } from "./source-bots.ts";
import type { BotScriptSources } from "../botlib/script-sources.ts";
import type { DebugPolygonDraw } from "../server/bot-debug.ts";
import type { ServerBotConfiguration } from "./source-bots.ts";
import { QvmGame } from "./qvm-game.ts";
import { acquireGameModule } from "./client-modules.ts";
import type { QvmSyscall } from "../vm/interpreter.ts";
import type { VmRegistration } from "../vm/registry.ts";
import { QvmMemory } from "../vm/memory.ts";
import { qvmCommonSyscall } from "../vm/common-syscalls.ts";
import { qvmFilesystemSyscall } from "../vm/filesystem-syscalls.ts";
import { qvmRealTimeSyscall } from "../vm/real-time-syscalls.ts";
import { qvmServerGameSyscall } from "../vm/server-game-syscalls.ts";
import { qvmBotLibrarySyscall } from "../vm/bot-library-syscalls.ts";
import { qvmAasSyscall } from "../vm/aas-syscalls.ts";
import { qvmBotActionSyscall } from "../vm/bot-action-syscalls.ts";
import { qvmBotCharacterSyscall } from "../vm/bot-character-syscalls.ts";
import { qvmBotChatSyscall } from "../vm/bot-chat-syscalls.ts";
import { qvmBotGoalSyscall } from "../vm/bot-goal-syscalls.ts";
import { qvmBotMovementSyscall } from "../vm/bot-movement-syscalls.ts";
import { qvmBotWeaponSyscall } from "../vm/bot-weapon-syscalls.ts";
import { qvmBotGeneticSyscall } from "../vm/bot-genetic-syscalls.ts";
import { qvmServerBotSyscall } from "../vm/server-bot-syscalls.ts";
import { qvmScriptSyscall } from "../vm/script-syscalls.ts";
import { BotDebugPolygons } from "../server/bot-debug.ts";

export type ServerBotCapability = ServerBotConfiguration;

export type ServerShutdownRequest =
  | { readonly kind: "normal"; readonly reason: string }
  | { readonly kind: "common-error"; readonly reason: string };

export type ServerClientLifecycleCapability =
  | { readonly kind: "absent" }
  | {
      readonly kind: "available";
      mapLoading(): Promise<void>;
      shutdownAllForServerMap(): Promise<void>;
      disconnectAfterServerShutdown(): Promise<void>;
    };

export interface ServerEngineOptions {
  readonly common: CommonConsole;
  readonly buildDate: string;
  readonly clock: { milliseconds(): number; readonly comFrameTime: number };
  readonly random: LinuxNativeRandom;
  readonly network: {
    readonly loopback: LoopbackTransport;
    readonly udp: UdpTransport | null;
    readonly lan: LanAddresses;
    resolveAddress(hostname: string, port: number): Promise<Ipv4Address | null>;
    sleep(milliseconds: number): Promise<void>;
  };
  readonly bots: ServerBotCapability;
  readonly clientLifecycle: ServerClientLifecycleCapability;
}

export type ServerEngineState =
  | { readonly kind: "stopped" }
  | { readonly kind: "disposed" }
  | { readonly kind: "initializing"; readonly statics: ServerStaticState }
  | { readonly kind: "running"; readonly statics: ServerStaticState; readonly world: ServerWorldState };

interface ServerMap {
  readonly map: Pick<BspMap, "entities">;
  readonly collision: CollisionWorld;
  readonly spatial: ServerWorld;
  readonly world: ServerWorldState;
  readonly statics: ServerStaticState;
  readonly downloads: ServerDownloadRuntime;
  readonly channel: ServerNetChannelRuntime;
  readonly snapshots: ServerSnapshotRuntime;
  readonly sender: ServerSnapshotSendRuntime;
  readonly lifecycle: ServerClientLifecycleRuntime;
  readonly clientCommands: ServerClientCommandRuntime;
  readonly frame: ServerFrameRuntime;
  readonly botsEnabled: boolean;
  gameRegistration: VmRegistration | null;
  externalGame: ExternalGameContext | null;
}

interface ExternalGameContext {
  readonly game: QvmGame;
  readonly bots: ServerBotAdapter;
  readonly debugPolygons: BotDebugPolygons;
  entityCursor: CommonParseCursor;
}

interface Operation {
  readonly kind: "packet" | "frame" | "command" | "shutdown" | "dispose";
  readonly parent: Operation | undefined;
  mapTransition: boolean;
  closed: boolean;
}

interface GameSyscallScope { readonly operation: Operation; closed: boolean }

function signedTime(value: number): number {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new RangeError("Server clock requires signed-int milliseconds");
  return value;
}
function argument(context: CommandContext, index: number): string { return context.argv[index] ?? ""; }
function asciiLower(text: string): string { return text.replace(/[A-Z]/g, character => character.toLowerCase()); }

/** Server composition. The common loop owns transport polling and awaits each entry. */
export class ServerEngine {
  readonly commands: CommandBuffer;
  readonly output: ConsoleOutput;
  readonly networkControl = new ServerNetworkControlState();
  readonly writable: WritableFileSystem;
  readonly profile = { timeGame: 0 };
  private readonly worldSectors = new ServerWorldSectors();
  private readonly entityParser = new CommonParseState();
  private readonly calendar = new UnixSystemClock();
  private readonly botDebugPolygons: BotDebugPolygons;
  private phase: ServerEngineState = { kind: "stopped" };
  private currentMap: ServerMap | null = null;
  private ownedBots: SourceBots | null;
  private botEnabled = false;
  private readonly connectionless: ServerConnectionlessRuntime;
  private readonly rcon: ServerRconRuntime;
  private readonly operationContext = new AsyncLocalStorage<Operation>();
  private readonly gameSyscallContext = new AsyncLocalStorage<GameSyscallScope>();
  private activeOperation: Operation | undefined;

  static create(options: ServerEngineOptions): ServerEngine { return new ServerEngine(options); }

  private constructor(readonly options: ServerEngineOptions) {
    const common = options.common;
    this.output = common.output; this.commands = common.commands;
    this.writable = common.files.writable;
    const cvars = common.cvars;
    if (this.cvar("sv_running").integerValue !== 0 || this.cvar("cl_running").integerValue !== 0) throw new Error("Server construction requires stopped common running-state cvars");
    common.validateGameDirectory();
    this.registerCommands();
    registerServerCvars(cvars);
    registerSourceBotCvars(cvars);
    this.ownedBots = options.bots.kind === "source"
      ? new SourceBots(common, options.random, (common.cvars.get("com_botDebug")?.integerValue ?? 0) !== 0) : null;
    this.botDebugPolygons = this.ownedBots?.debugPolygons ?? new BotDebugPolygons();
    if (this.ownedBots === null) this.botDebugPolygons.initialize(this.cvar("bot_maxdebugpolys").integerValue);
    this.rcon = new ServerRconRuntime(this.networkControl, { cvars, commands: this.commands, output: this.output,
      milliseconds: () => this.milliseconds(), sendPacket: (to, bytes) => { this.sendPacket(to, bytes); } });
    this.connectionless = new ServerConnectionlessRuntime(this.networkControl, { cvars, random: options.random,
      currentLifecycle: () => this.map().lifecycle, sendPacket: (to, bytes) => { this.sendPacket(to, bytes); },
      isLanAddress: address => options.network.lan.isLanAddress(address),
      resolveAddress: (hostname, port) => options.network.resolveAddress(hostname, port),
      remoteCommand: (from, bytes, decoded) => this.rcon.handle(from, bytes, decoded),
      print: text => { this.output.print(text); }, debugPrint: text => { this.debugPrint(text); } });
    common.hunk.attachServer({
      shutdownGameProgs: () => this.shutdownHunkGame(),
      clearVm: () => {
        const level = this.currentMap;
        if (level !== null) this.retireGame(level);
      },
    });
  }

  private async shutdownHunkGame(): Promise<void> {
    const level = this.currentMap;
    if (level === null || level.world.game === null) return;
    if (this.operationContext.getStore() === undefined) {
      await this.operation("command", async () => { await runCalls(this.shutdownGame(level, false)); });
    } else {
      this.assertCurrentOperation();
      await runCalls(this.shutdownGame(level, false));
    }
  }

  get state(): ServerEngineState { return this.phase; }
  get running(): boolean { return this.phase.kind === "initializing" || this.phase.kind === "running"; }
  get files(): TrackedVirtualFileSystem { return this.options.common.files.current; }

  drawBotDebugPolygons(drawPoly: DebugPolygonDraw, value: number): undefined {
    const bots = this.ownedBots;
    if (bots === null) return;
    bots.drawDebugPolygons(drawPoly, value, {
      botEnabled: () => this.botEnabled,
      clientCommandButtons: () => this.client(this.map(), 0).lastUsercmd.buttons,
      clientEntity: () => {
        const level = this.map(), entity = level.world.gameEntity(this.client(level, 0));
        if (entity === null) throw new Error("BotDrawDebugPolygons: source client 0 has no game entity");
        return entity.r;
      },
    });
  }

  private milliseconds(): number { return signedTime(this.options.clock.milliseconds()); }
  private cvar(name: string): CvarSnapshot {
    const value = this.options.common.cvars.get(name);
    if (value === undefined) throw new Error(`Server engine requires registered cvar ${name}`);
    return value;
  }
  private map(): ServerMap {
    if (this.currentMap === null) throw new Error("Server has no current map");
    return this.currentMap;
  }
  private game(level: ServerMap): ServerGame {
    if (level.world.game === null) throw new Error("Server map has no current game");
    return level.world.game;
  }
  private client(level: ServerMap, slot: number): ServerClient {
    const client = level.statics.clients[slot];
    if (!Number.isInteger(slot) || slot < 0 || client === undefined) throw new RangeError(`Invalid server client slot ${slot}`);
    return client;
  }
  private debugPrint(text: string): void { if (this.cvar("developer").integerValue !== 0) this.output.print(text); }
  private sendPacket(to: ServerPacketAddress, bytes: Uint8Array): undefined {
    if (to.kind === "loopback") { this.options.network.loopback.send("server", bytes); return; }
    const udp = this.options.network.udp;
    if (udp === null) throw new Error("IPv4 packet requested without a server UDP transport");
    if (!udp.send(to, bytes)) this.debugPrint("Sys_SendPacket: UDP socket could not queue packet\n");
  }

  assertCommandEntry(): void {
    const inherited = this.operationContext.getStore();
    this.requireOpenOperation(inherited);
    if (this.activeOperation !== undefined && (inherited !== this.activeOperation
      || !this.commandReentry(inherited))) throw new Error("Server operations must be awaited in source order");
  }
  private commandReentry(operation: Operation): boolean {
    const call = this.gameSyscallContext.getStore();
    return (operation.kind === "packet" && this.networkControl.inCurrentRconOperation)
      || (call !== undefined && !call.closed && call.operation === operation);
  }
  private requireOpenOperation(operation: Operation | undefined): void {
    for (let current = operation; current !== undefined; current = current.parent) {
      if (current.closed) throw new Error("Cannot reuse a closed server operation");
    }
  }
  private assertCurrentOperation(): Operation {
    const current = this.operationContext.getStore();
    this.requireOpenOperation(current);
    if (current === undefined || current !== this.activeOperation) throw new Error("Nested server operations must be awaited before their caller continues");
    return current;
  }
  private markMapTransition(): void {
    for (let operation: Operation | undefined = this.assertCurrentOperation(); operation !== undefined; operation = operation.parent) {
      operation.mapTransition = true;
    }
  }
  private operation(kind: "dispose", task: () => Promise<void>): Promise<void>;
  private operation<T>(kind: Exclude<Operation["kind"], "dispose">, task: () => Promise<T>): Promise<T>;
  private async operation<T>(kind: Operation["kind"], task: () => Promise<T>): Promise<T | undefined> {
    const parent = this.operationContext.getStore();
    this.requireOpenOperation(parent);
    if (parent !== this.activeOperation) throw new Error("Server operations must be awaited in source order");
    if (parent !== undefined && !(kind === "command" && this.commandReentry(parent))) {
      throw new Error("Server operations must be awaited in source order");
    }
    if (this.phase.kind === "disposed") {
      if (kind === "dispose") return;
      throw new Error("Server resources have been disposed");
    }
    const operation: Operation = { kind, parent, mapTransition: false, closed: false };
    this.activeOperation = operation;
    return await this.operationContext.run(operation, async () => {
      try { const result = await task(); this.assertCurrentOperation(); return result; }
      catch (error) {
        if (error instanceof CommonError) throw error;
        if (operation.mapTransition && this.phase.kind !== "stopped") {
          try { await runCalls(this.releaseSession()); }
          catch (cleanupError) {
            if (cleanupError instanceof CommonError) throw cleanupError;
            throw new AggregateError([error, cleanupError], "Server operation and map cleanup failed");
          }
        }
        throw error;
      } finally {
        operation.closed = true;
        if (this.activeOperation === operation) {
          this.activeOperation = parent;
          while (this.activeOperation?.closed) this.activeOperation = this.activeOperation.parent;
        }
      }
    });
  }

  private *commandCalls<T>(body: () => CallSteps<T>): CallSteps<T> {
    this.assertCommandEntry(); this.requireSourceResources();
    if (this.currentMap?.world.game instanceof QvmGame) {
      return yield* waitForCall(() => this.operation("command", async () => await runCalls(body())));
    }
    return yield* body();
  }

  async packetEvent(from: ServerPacketAddress, bytes: Uint8Array): Promise<void> {
    await this.operation("packet", async () => {
      if (this.phase.kind === "stopped") return;
      await this.map().channel.packetEvent(from, bytes);
    });
  }
  async frame(milliseconds: number): Promise<void> {
    await this.operation("frame", async () => {
      signedTime(milliseconds);
      // SV_Frame consumes the menu request even when no server map is running.
      if (await this.consumeKillServerRequest()) return;
      if (this.phase.kind === "stopped") return;
      await this.map().frame.frame(milliseconds);
    });
  }
  private async consumeKillServerRequest(): Promise<boolean> {
    if (this.cvar("sv_killserver").integerValue === 0) return false;
    await this.shutdownSession({ kind: "normal", reason: "Server was killed.\n" });
    this.assertCurrentOperation(); this.options.common.cvars.set("sv_killserver", "0", true);
    return true;
  }
  async shutdown(request: ServerShutdownRequest): Promise<void> { await this.operation("shutdown", () => this.shutdownSession(request)); }
  /** Managed terminal release; never replay SV_Shutdown or game/session shutdown callbacks. */
  async disposeResources(): Promise<void> {
    await this.operation("dispose", async () => {
      const level = this.currentMap, bots = this.ownedBots;
      this.currentMap = null; this.ownedBots = null; this.phase = { kind: "disposed" };
      const errors: unknown[] = [];
      const release = (task: () => void): void => { try { task(); } catch (error) { errors.push(error); } };
      release(() => { if (level !== null) this.retireGame(level); });
      release(() => { level?.downloads.disposeResources(); });
      release(() => { bots?.disposeResources(); });
      if (level !== null) {
        for (const client of level.statics.clients) client.gameEntity = null;
        level.world.state = "dead"; level.world.restarting = false;
      }
      release(() => { this.networkControl.resetServerSession(); });
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Server resource disposal failed");
    });
  }
  async shutdownFromCommand(reason: string): Promise<void> {
    await this.operation("command", () => this.shutdownSession({ kind: "normal", reason }));
  }

  private registerCommands(): void {
    this.commands.register("heartbeat", () => {
      this.assertCommandEntry(); this.requireSourceResources();
      if (this.phase.kind === "initializing" || this.phase.kind === "running") this.phase.statics.nextHeartbeatTime = -9999999;
    });
    this.commands.registerCalls("kick", context => this.commandCalls(() => this.kick(context)));
    this.commands.registerAsync("banUser", context => this.operation("command", () => this.ban(context, "name")));
    this.commands.registerAsync("banClient", context => this.operation("command", () => this.ban(context, "number")));
    this.commands.registerCalls("clientkick", context => this.commandCalls(() => this.kickNum(context)));
    this.commands.register("status", () => { this.assertCommandEntry(); this.requireSourceResources(); this.status(); });
    this.commands.register("serverinfo", () => { this.assertCommandEntry(); this.requireSourceResources(); this.serverInfo(false); });
    this.commands.register("systeminfo", () => { this.assertCommandEntry(); this.requireSourceResources(); this.serverInfo(true); });
    this.commands.register("dumpuser", context => { this.assertCommandEntry(); this.requireSourceResources(); this.dumpUser(context); });
    this.commands.registerAsync("map_restart", context => this.operation("command", () => this.restartMap(context)));
    this.commands.register("sectorlist", () => {
      this.assertCommandEntry(); this.requireSourceResources();
      this.worldSectors.sectorCounts().forEach((count, slot) => { this.output.print(`sector ${slot}: ${count} entities\n`); });
    });
    const mapCommands = isPrereleaseDemo(this.options.common.productProfile) ? ["map"] : ["map", "devmap", "spmap", "spdevmap"];
    for (const name of mapCommands) {
      this.commands.registerAsync(name, context => this.operation("command", () => this.mapCommand(context)));
    }
    this.commands.registerAsync("killserver", () => this.operation("command", () => this.shutdownSession({ kind: "normal", reason: "killserver" })));
    if (this.cvar("dedicated").integerValue !== 0) {
      this.commands.registerCalls("say", context => this.commandCalls(() => this.consoleSay(context)));
    }
  }
  private requireSourceResources(): void {
    if (this.phase.kind === "disposed") throw new Error("Server resources have been disposed");
  }
  private serverInfo(system: boolean): void {
    this.output.print(system ? "System info settings:\n" : "Server info settings:\n");
    printInfo(this.options.common.cvars.infoString(system ? CvarFlag.SystemInfo : CvarFlag.ServerInfo), text => { this.output.print(text); });
  }
  private dumpUser(context: CommandContext): void {
    if (!this.running) { this.output.print("Server is not running.\n"); return; }
    if (context.argv.length !== 2) { this.output.print("Usage: info <userid>\n"); return; }
    const client = this.playerByName(context);
    if (client === null) return;
    this.output.print("userinfo\n"); this.output.print("--------\n");
    printInfo(client.userinfo, text => { this.output.print(text); });
  }
  private *consoleSay(context: CommandContext): CallSteps {
    if (!this.running) { this.output.print("Server is not running.\n"); return; }
    if (context.argv.length < 2) return;
    let args = context.args.join(" ");
    if (args.length >= 1024) throw new RangeError("Cmd_Args would overflow its source buffer");
    if (args.startsWith('"')) args = args.slice(1, -1);
    const text = `console: ${args}`;
    if (text.length >= 1024) throw new RangeError("SV_ConSay_f would overflow its source text buffer");
    yield* this.map().lifecycle.sendServerCommand(-1, `chat "${text}\n"`);
  }
  private playerByName(context: CommandContext): ServerClient | null {
    if (!this.running) return null;
    if (context.argv.length < 2) { this.output.print("No player specified.\n"); return null; }
    const name = argument(context, 1), wanted = asciiLower(name);
    for (const client of this.map().statics.clients) {
      if (client.phase === ServerClientPhase.Free) continue;
      if (asciiLower(client.name) === wanted) return client;
      const source = client.name.slice(0, 63);
      let clean = "";
      for (let index = 0; index < source.length; index++) {
        const character = source.charAt(index), next = source.charAt(index + 1);
        if (character === "^" && next !== "" && next !== "^") index++;
        else if (character >= " " && character <= "~") clean += character;
      }
      if (asciiLower(clean) === wanted) return client;
    }
    this.output.print(`Player ${name} is not on the server\n`);
    return null;
  }
  private playerByNum(context: CommandContext): ServerClient | null {
    if (!this.running) return null;
    if (context.argv.length < 2) { this.output.print("No player specified.\n"); return null; }
    const text = argument(context, 1);
    if (/[^0-9]/.test(text)) { this.output.print(`Bad slot number: ${text}\n`); return null; }
    const slot = nativeAtoi(text);
    if (slot < 0 || slot >= this.cvar("sv_maxclients").integerValue) {
      this.output.print(`Bad client slot: ${slot}\n`); return null;
    }
    const client = this.client(this.map(), slot);
    if (client.phase === ServerClientPhase.Free) { this.output.print(`Client ${slot} is not active\n`); return null; }
    return client;
  }
  private *kick(context: CommandContext): CallSteps {
    if (!this.running) { this.output.print("Server is not running.\n"); return; }
    if (context.argv.length !== 2) {
      this.output.print("Usage: kick <player name>\nkick all = kick everyone\nkick allbots = kick all bots\n"); return;
    }
    const level = this.map(), client = this.playerByName(context);
    if (client === null) {
      const group = asciiLower(argument(context, 1));
      if (group !== "all" && group !== "allbots") return;
      for (const target of level.statics.clients) {
        if (target.phase === ServerClientPhase.Free) continue;
        const connection = target.connection;
        if (group === "all" ? connection.address.kind === "loopback" : connection.address.kind !== "bot") continue;
        yield* level.lifecycle.dropClient(target, "was kicked"); target.lastPacketTime = level.statics.time;
      }
      return;
    }
    if (client.connection.address.kind === "loopback") {
      yield* level.lifecycle.sendServerCommand(-1, 'print "Cannot kick host player\n"'); return;
    }
    yield* level.lifecycle.dropClient(client, "was kicked"); client.lastPacketTime = level.statics.time;
  }
  private *kickNum(context: CommandContext): CallSteps {
    if (!this.running) { this.output.print("Server is not running.\n"); return; }
    if (context.argv.length !== 2) { this.output.print("Usage: kicknum <client number>\n"); return; }
    const client = this.playerByNum(context);
    if (client === null) return;
    const level = this.map();
    if (client.connection.address.kind === "loopback") {
      yield* level.lifecycle.sendServerCommand(-1, 'print "Cannot kick host player\n"'); return;
    }
    yield* level.lifecycle.dropClient(client, "was kicked"); client.lastPacketTime = level.statics.time;
  }
  private async ban(context: CommandContext, lookup: "name" | "number"): Promise<void> {
    if (!this.running) { this.output.print("Server is not running.\n"); return; }
    if (context.argv.length !== 2) {
      this.output.print(lookup === "name" ? "Usage: banUser <player name>\n" : "Usage: banClient <client number>\n"); return;
    }
    const client = lookup === "name" ? this.playerByName(context) : this.playerByNum(context);
    if (client === null) return;
    if (client.connection.address.kind === "loopback") {
      await runCalls(this.map().lifecycle.sendServerCommand(-1, 'print "Cannot kick host player\n"')); return;
    }
    await this.connectionless.banUser(client);
  }
  gameConsoleCommand(context: CommandContext): CallSteps<boolean> {
    const owner = this;
    return this.commandCalls(function* (): CallSteps<boolean> {
      const level = owner.currentMap;
      return level !== null && level.world.state === "game" && (yield* owner.game(level).calls.consoleCommand(context.argv));
    });
  }
  private async restartFiles(checksumFeed: number): Promise<void> {
    this.options.common.validateGameDirectory();
    await this.options.common.files.restart({ checksumFeed,
      random: () => Math.fround((this.options.random.next() & 0x7fff) / 32767) }, () => { this.assertCurrentOperation(); });
  }

  private async mapCommand(context: CommandContext): Promise<void> {
    const map = argument(context, 1), expanded = `maps/${map}.bsp`;
    if (expanded.length >= 64) this.output.print(`Com_sprintf: overflow of ${expanded.length} in 64\n`);
    const path = expanded.slice(0, 63);
    const length = this.files.readFileLength(path);
    this.assertCurrentOperation();
    if (length === -1) { this.output.print(`Can't find map ${path}\n`); return; }
    // Consume the previous session's menu request before a new map unloads the UI.
    await this.consumeKillServerRequest(); this.assertCurrentOperation();
    const cvars = this.options.common.cvars;
    cvars.register("g_gametype", "0", CvarFlag.ServerInfo | CvarFlag.UserInfo | CvarFlag.Latch);
    const command = argument(context, 0).toLowerCase(), singlePlayer = command.startsWith("sp");
    const cheats = !singlePlayer && command === "devmap", killBots = singlePlayer || cheats;
    if (singlePlayer) {
      cvars.set("g_gametype", String(GameType.GT_SINGLE_PLAYER), true); cvars.set("g_doWarmup", "0", true); cvars.set("sv_maxclients", "8");
    } else if (this.cvar("g_gametype").integerValue === GameType.GT_SINGLE_PLAYER) cvars.set("g_gametype", String(GameType.GT_FFA), true);
    await this.spawnMap(map.slice(0, 63), killBots);
    this.assertCurrentOperation();
    cvars.set("sv_cheats", cheats ? "1" : "0", true);
  }
  private boundMaxClients(minimum: number): number {
    const cvars = this.options.common.cvars;
    cvars.register("sv_maxclients", "8"); cvars.clearModified("sv_maxclients");
    const count = this.cvar("sv_maxclients").integerValue;
    if (count < minimum) cvars.set("sv_maxclients", String(minimum), true);
    else if (count > 64) cvars.set("sv_maxclients", "64", true);
    return this.cvar("sv_maxclients").integerValue;
  }
  private session(): ServerStaticState {
    if (this.phase.kind === "disposed") throw new Error("Server resources have been disposed");
    if (this.phase.kind === "stopped") {
      const statics = new ServerStaticState({ product: this.options.common.roots.product, maxClients: this.boundMaxClients(1),
        dedicated: this.cvar("dedicated").integerValue !== 0 });
      statics.initialized = true; this.options.common.cvars.set("sv_running", "1", true);
      return statics;
    }
    const statics = this.phase.statics;
    if (this.cvar("sv_maxclients").modified) {
      const occupied = statics.clients.reduce((count, client) => client.phase >= ServerClientPhase.Connected ? client.slot + 1 : count, 1);
      const count = this.boundMaxClients(occupied);
      if (count !== statics.clients.length) {
        const old = statics.clients;
        for (const client of old) if (client.phase < ServerClientPhase.Connected) this.map().downloads.close(client);
        statics.clients = Array.from({ length: count }, (_, slot) => {
          const previous = old[slot];
          return previous !== undefined && previous.phase >= ServerClientPhase.Connected ? previous : new ServerClient(this.options.common.roots.product, slot);
        });
      }
      statics.resizeSnapshotEntities(this.cvar("dedicated").integerValue !== 0);
    }
    return statics;
  }
  private async spawnMap(name: string, killBots: boolean): Promise<void> {
    this.markMapTransition();
    try {
      if (this.currentMap !== null) await runCalls(this.shutdownGame(this.currentMap, false));
      this.output.print("------ Server Initialization ------\n"); this.output.print(`Server: ${name}\n`);
      if (this.options.clientLifecycle.kind === "available") {
        await this.options.clientLifecycle.mapLoading(); this.assertCurrentOperation();
        await this.options.clientLifecycle.shutdownAllForServerMap(); this.assertCurrentOperation();
      }
      await this.options.common.hunk.clear();
      this.assertCurrentOperation();
      this.options.common.collision.clear();
      const statics = this.session();
      this.phase = { kind: "initializing", statics };
      this.files.pakReferences.clear(0);
      statics.resetSnapshotEntities({ kind: "source-hunk", accounting: this.options.common.hunk.accounting });
      statics.snapFlagServerBit ^= 4;
      const cvars = this.options.common.cvars;
      cvars.set("nextmap", "map_restart 0", true);
      this.worldSectors.clearServer();
      cvars.set("cl_paused", "0", true);
      this.options.random.seed(this.milliseconds() >>> 0);
      const checksumFeed = ((this.options.random.next() << 16) ^ this.options.random.next()) ^ this.milliseconds();
      await this.restartFiles(checksumFeed);
      this.assertCurrentOperation();
      const { map, world: collision, checksum } = this.options.common.collision.load(`maps/${name}.bsp`, false);
      this.assertCurrentOperation();
      cvars.set("mapname", name, true); cvars.set("sv_mapChecksum", String(checksum), true);
      const serverId = signedTime(this.options.clock.comFrameTime);
      cvars.set("sv_serverid", String(serverId), true);
      const level = this.buildMap(statics, map, collision, checksumFeed, serverId);
      this.currentMap = level;
      level.world.state = "loading";
      await this.initializeGame(level, false); cvars.clearModified("g_gametype");
      for (let index = 0; index < 3; index++) await runCalls(this.settle(level, true));
      level.snapshots.createBaselines();
      const game = this.game(level);
      for (const client of statics.clients) {
        if (client.phase < ServerClientPhase.Connected) continue;
        const connection = client.connection;
        if (connection.kind !== "initialized") throw new Error("Connected client has no channel");
        const isBot = connection.address.kind === "bot";
        if (isBot && killBots) { await runCalls(level.lifecycle.dropClient(client, "")); continue; }
        const denied = await runCalls(game.calls.clientConnect(client.slot, false, isBot));
        if (denied !== null) { await runCalls(level.lifecycle.dropClient(client, denied)); continue; }
        if (!isBot) connection.phase = ServerClientPhase.Connected;
        else {
          connection.phase = ServerClientPhase.Active; game.data.entity(client.slot).s.number = client.slot;
          client.gameEntity = game.data.entity(client.slot); client.deltaMessage = -1; client.nextSnapshotTime = statics.time;
          await runCalls(game.calls.clientBegin(client.slot));
        }
      }
      await runCalls(this.settle(level, true));
      if (this.cvar("sv_pure").integerValue !== 0) {
        const checksums = this.files.pakReferences.loadedPakChecksums(); cvars.set("sv_paks", checksums, true);
        if (checksums.length === 0) this.output.print("WARNING: sv_pure set but no PK3 files loaded\n");
        cvars.set("sv_pakNames", this.files.pakReferences.loadedPakNames(), true);
        if (this.cvar("dedicated").integerValue !== 0) this.files.fileLength("vm/cgame.qvm");
      } else { cvars.set("sv_paks", "", true); cvars.set("sv_pakNames", "", true); }
      cvars.set("sv_referencedPaks", this.files.pakReferences.referencedPakChecksums(), true);
      cvars.set("sv_referencedPakNames", this.files.pakReferences.referencedPakNames(), true);
      const systemInfo = cvars.infoString(CvarFlag.SystemInfo, 8192);
      cvars.clearModifiedFlags(CvarFlag.SystemInfo); await runCalls(level.world.configstrings.setCalls(1, systemInfo));
      await runCalls(level.world.configstrings.setCalls(0, cvars.infoString(CvarFlag.ServerInfo))); cvars.clearModifiedFlags(CvarFlag.ServerInfo);
      level.world.state = "game"; statics.nextHeartbeatTime = -9999999;
      this.phase = { kind: "running", statics, world: level.world };
      this.options.common.hunk.setMark();
      this.output.print("-----------------------------------\n");
    } catch (error) {
      if (error instanceof CommonError) throw error;
      try { await runCalls(this.releaseSession()); }
      catch (cleanupError) {
        if (cleanupError instanceof CommonError) throw cleanupError;
        throw new AggregateError([error, cleanupError], "Server map load and cleanup failed");
      }
      throw error;
    }
  }

  private buildMap(statics: ServerStaticState, map: Pick<BspMap, "entities">, collision: CollisionWorld, checksumFeed: number, serverId: number): ServerMap {
    const engine = this, cvars = this.options.common.cvars;
    const print = (text: string): undefined => { this.output.print(text); }, debugPrint = (text: string): undefined => { this.debugPrint(text); };
    const world: ServerWorldState = new ServerWorldState(statics, { print, dropClient: (client, reason): CallSteps => lifecycle.dropClient(client, reason) });
    world.checksumFeed = checksumFeed; world.serverId = serverId; world.restartedServerId = serverId; world.checksumFeedServerId = serverId;
    const spatial = new ServerWorld(collision, collision.modelBounds(0), number => world.game?.data.entity(number), {
      print, developerPrint: debugPrint, get loading() { return world.state === "loading"; },
    }, this.worldSectors);
    const channel = new ServerNetChannelRuntime(statics, { print, debugPrint, sendPacket: (to, bytes) => this.sendPacket(to, bytes),
      tracePacket: text => { if (this.cvar("showpackets").integerValue !== 0) this.output.print(text); },
      connectionless: (from, bytes) => this.connectionless.process(from, bytes), executeClientMessage: (client, reader) => clientCommands.executeClientMessage(client, reader) }, {
      get showPackets() { return engine.cvar("showpackets").integerValue !== 0; },
      get showDrop() { return engine.cvar("showdrop").integerValue !== 0; },
      print: text => { this.output.print(text); },
    }, this.options.common.sourceState);
    const downloads: ServerDownloadRuntime = new ServerDownloadRuntime(statics, { files: this.options.common.files.server, cvars, print, debugPrint,
      dropClient: (client, reason) => lifecycle.dropClient(client, reason), sendClientGameState: client => { lifecycle.sendClientGameState(client); } });
    const snapshots = new ServerSnapshotRuntime(world, statics, { collision, spatial, debugPrint });
    const sender = new ServerSnapshotSendRuntime(snapshots, channel, { cvars, downloads, print,
      isLanAddress: address => this.options.network.lan.isLanAddress(address) });
    const lifecycle: ServerClientLifecycleRuntime = new ServerClientLifecycleRuntime(world, statics, { cvars, downloads, sender, print, debugPrint,
      sendPacket: (to, bytes) => { this.sendPacket(to, bytes); }, isLanAddress: address => this.options.network.lan.isLanAddress(address) });
    const tokenize = (text: string): readonly string[] => this.commands.tokenize(text);
    const pure = new ServerPureRuntime(lifecycle, { cvars, get files() { return engine.files; }, debugPrint, tokenize });
    const clientCommands = new ServerClientCommandRuntime(world, statics, { debugBuild: this.cvar("com_serverDebug").integerValue !== 0,
      get pure() { return engine.cvar("sv_pure").integerValue !== 0; },
      get clientRunning() { return engine.cvar("cl_running").integerValue !== 0; },
      get floodProtect() { return engine.cvar("sv_floodProtect").integerValue !== 0; }, print, debugPrint, tokenize,
      dropClient: (client, reason) => lifecycle.dropClient(client, reason), sendClientGameState: client => { lifecycle.sendClientGameState(client); },
      userinfoChanged: client => { lifecycle.userinfoChanged(client); }, verifyPaks: (client, argv) => pure.verifyPaks(client, argv),
      beginDownload: (client, argv) => { downloads.begin(client, argv); }, nextDownload: (client, argv) => downloads.next(client, argv),
      stopDownload: client => { downloads.stop(client); }, doneDownload: client => { downloads.done(client); } });
    const frame = new ServerFrameRuntime(sender, { cvars, lifecycle, commands: this.commands, profile: this.profile,
      botFrame: time => this.botFrame(level, time), heartbeat: () => this.connectionless.masterHeartbeat(),
      shutdown: reason => this.shutdownSession({ kind: "normal", reason }), sleep: milliseconds => this.options.network.sleep(milliseconds),
      milliseconds: () => this.milliseconds(), debugPrint });
    const botsEnabled = cvars.register("bot_enable", "1", CvarFlag.Latch).integerValue !== 0;
    const level: ServerMap = { map, collision, spatial, statics, world, downloads, channel, snapshots, sender, lifecycle, clientCommands, frame, botsEnabled,
      gameRegistration: null, externalGame: null };
    return level;
  }
  private async initializeGame(level: ServerMap, restart: boolean): Promise<void> {
    if (!restart) this.botEnabled = level.botsEnabled;
    const previous = level.externalGame;
    if (restart && previous !== null) {
      this.output.print("VM_Restart()\n");
      this.output.print("Loading vm file vm/qagame.qvm.\n");
      const file = this.files.readFileRetainedSync("vm/qagame.qvm");
      if (file === undefined) throw new CommonError("drop", "VM_Restart failed.\n");
      try { previous.game.restart(parseQvmRestart(file.bytes, "vm/qagame.qvm")); }
      catch (error) {
        if (error instanceof QvmHeaderError) {
          level.gameRegistration?.free();
          throw new CommonError("fatal", error.message);
        }
        throw error;
      }
      this.files.freeFile(file);
      previous.entityCursor = new CommonParseCursor(level.map.entities);
      for (const client of level.statics.clients) client.gameEntity = null;
      await previous.game.initialize(level.statics.time, this.milliseconds(), true);
      return;
    }
    const retained = level.gameRegistration;
    if (restart && retained?.binding.kind === "typescript") {
      this.initializeRetailGame(level, true, retained);
      return;
    }
    const module = acquireGameModule({ files: this.files, product: level.world.product, registry: this.options.common.vm,
      print: text => { this.output.print(text); }, hunk: { kind: "source-hunk", accounting: this.options.common.hunk.accounting } });
    if (module === null) throw new CommonError("fatal", "VM_Create on game failed");
    level.gameRegistration = module.registration;
    if (module.mode === "bytecode") {
      const game: QvmGame = new QvmGame(module.image, module.product,
        call => this.gameSystemCall(level, context, call), () => { this.assertCurrentOperation(); },
        { kind: "source-hunk", accounting: this.options.common.hunk.accounting }, module.registration);
      module.releaseImage();
      game.loadSymbols({ developer: this.cvar("developer").integerValue, files: this.files, print: text => { this.output.print(text); } });
      module.completeLoading();
      const adapter = new ServerBotAdapter(level, this.options.common.cvars, text => { this.output.print(text); });
      const context: ExternalGameContext = { game, bots: adapter,
        debugPolygons: this.botDebugPolygons, entityCursor: new CommonParseCursor(level.map.entities) };
      level.externalGame = context;
      level.world.game = game;
      this.ownedBots?.attachExternal(game, adapter);
      for (const client of level.statics.clients) client.gameEntity = null;
      await game.initialize(level.statics.time, this.milliseconds(), restart);
      return;
    }
    if (module.mode === "registered") {
      const game = QvmGame.registered(module.registration) ?? GameRuntime.registered(module.registration);
      if (game === null) throw new CommonError("fatal", "VM_Create on game failed");
      level.world.game = game;
      for (const client of level.statics.clients) client.gameEntity = null;
      if (game instanceof QvmGame) {
        if (previous?.game !== game) throw new CommonError("fatal", "Registered game VM has no server context");
        previous.entityCursor = new CommonParseCursor(level.map.entities);
        await game.initialize(level.statics.time, this.milliseconds(), restart);
      } else this.initializeRetailGame(level, restart, module.registration, true);
      return;
    }
    module.registration.bindTypeScript();
    this.initializeRetailGame(level, restart, module.registration);
  }
  private initializeRetailGame(level: ServerMap, restart: boolean, registration: VmRegistration, registered = false): void {
    for (const client of level.statics.clients) client.gameEntity = null;
    const bots = this.options.bots;
    const botFactory = bots.kind === "unavailable" ? bots : this.sourceBots().forMap(level);
    const create = registered ? GameRuntime.reinitialize : GameRuntime.create;
    create({ product: this.options.common.roots.product, map: level.map, collision: level.collision, world: level.spatial,
      sourceDebug: (this.options.common.cvars.get("com_gameDebug")?.integerValue ?? 0) !== 0,
      levelTime: level.statics.time, randomSeed: this.milliseconds(), restart, buildDate: this.options.buildDate,
      cvars: this.options.common.cvars, configstrings: level.world.configstrings,
      botFactory,
      engine: { print: text => { this.output.print(text); }, sendServerCommand: (slot, text) => { finishCalls(level.lifecycle.sendServerCommand(slot, text)); },
        milliseconds: () => this.milliseconds(),
        dropClient: (slot, reason) => { finishCalls(level.lifecycle.dropClient(this.client(level, slot), reason)); },
        getUserinfo: slot => this.client(level, slot).userinfo, setUserinfo: (slot, value) => { level.lifecycle.setUserinfo(slot, value); },
        getUserCommand: slot => { const command = this.client(level, slot).lastUsercmd; return { ...command, angles: { ...command.angles } }; },
        appendConsoleCommand: text => { this.commands.append(text); }, insertConsoleCommand: text => { this.commands.insert(text); },
        executeConsoleNow: text => { this.commands.executeNow(text); },
        openLog: (path, synchronous) => this.writable.openAppend(path, synchronous) } }, level.world, registration);
  }
  private *shutdownGame(level: ServerMap, restart: boolean): CallSteps {
    const game = level.world.game;
    if (game === null) return;
    yield* game.calls.shutdown(restart);
    if (!restart) this.retireGame(level, game);
  }
  private retireGame(level: ServerMap, game: ServerGame | null = level.world.game): void {
    const registration = level.gameRegistration;
    const owner = game ?? (registration === null ? null : QvmGame.registered(registration) ?? GameRuntime.registered(registration));
    try { owner?.disposeResources(); }
    finally {
      if (registration !== null && registration.binding.kind !== "freed") registration.free();
      if (level.gameRegistration === registration) level.gameRegistration = null;
      if (level.world.game === owner) level.world.game = null;
      if (level.externalGame?.game === owner) level.externalGame = null;
    }
  }
  private gameSystemCall(level: ServerMap, game: ExternalGameContext, call: QvmSyscall): number | Promise<number> {
    const scope: GameSyscallScope = { operation: this.assertCurrentOperation(), closed: false };
    let result: number | Promise<number>;
    try {
      result = this.gameSyscallContext.run(scope, () => this.dispatchGameSystemCall(level, game, call));
    } catch (error) { scope.closed = true; throw error; }
    if (result instanceof Promise) return result.finally(() => { scope.closed = true; });
    scope.closed = true;
    return result;
  }

  private dispatchGameSystemCall(level: ServerMap, game: ExternalGameContext, call: QvmSyscall): number | Promise<number> {
    const { words } = call, memory = new QvmMemory(call.memory), trap = words.getInt32(0, true);
    const common = this.options.common;
    const result = qvmCommonSyscall("game", words, memory, {
      commands: this.commands, output: this.output, clock: this.options.clock, cvars: common.cvars,
    }) ?? qvmFilesystemSyscall("game", words, memory, common.files)
      ?? qvmRealTimeSyscall("game", words, memory, this.calendar)
      ?? qvmServerGameSyscall("game", words, memory, {
        data: game.game.data, world: level.world, staticState: level.statics, spatial: level.spatial,
        collision: level.collision, lifecycle: level.lifecycle, cvars: common.cvars,
        bots: game.bots, debugPolygons: game.debugPolygons,
        entityToken: () => {
          const token = this.entityParser.parse(game.entityCursor);
          return { token, ended: game.entityCursor.offset === null };
        },
      }) ?? qvmServerBotSyscall("game", words, memory, game.bots);
    if (result !== null) return result;
    if (trap < 200) throw new CommonError("drop", `Bad game system trap: ${trap}`);
    const library = this.sourceBots().library;
    const bot = qvmBotLibrarySyscall("game", words, memory, library, {
      enabled: () => this.botEnabled, mapInput: name => ({ name, bsp: level.map, spatialHost: game.bots }),
    }) ?? qvmScriptSyscall("game", words, memory, library.sources)
      ?? qvmBotCharacterSyscall("game", words, memory, library.characters)
      ?? qvmBotChatSyscall("game", words, memory, library.chat)
      ?? qvmBotGoalSyscall("game", words, memory, library.goals)
      ?? qvmBotMovementSyscall("game", words, memory, library.moveStates, () => library.movement, () => library.movementRouting)
      ?? qvmBotWeaponSyscall("game", words, memory, library.weapons)
      ?? qvmBotGeneticSyscall("game", words, memory, library);
    if (bot !== null) return bot;
    if (trap >= 400 && trap <= 423) {
      const action = qvmBotActionSyscall("game", words, memory, library.actions);
      if (action !== null) return action;
    }
    if ((trap >= 300 && trap <= 318) || (trap >= 575 && trap <= 577)) {
      const aas = qvmAasSyscall("game", words, memory, library.aas, point => game.bots.pointContents(point));
      if (aas !== null) return aas;
    }
    throw new CommonError("drop", `Bad game system trap: ${trap}`);
  }
  private *botFrame(level: ServerMap, time: number): CallSteps {
    if (!this.botEnabled || level.world.game === null) return;
    yield* level.world.game.calls.botFrame(time);
  }
  private sourceBots(): SourceBots {
    if (this.ownedBots === null) throw new Error("Server source bot resources are unavailable");
    return this.ownedBots;
  }
  scriptSources(): BotScriptSources { return this.sourceBots().library.sources; }
  private *settle(level: ServerMap, bots: boolean): CallSteps {
    yield* this.game(level).calls.runFrame(level.statics.time); if (bots) yield* this.botFrame(level, level.statics.time);
    level.statics.time = (level.statics.time + 100) | 0;
  }
  private async restartMap(context: CommandContext): Promise<void> {
    const current = this.currentMap;
    if (current !== null && signedTime(this.options.clock.comFrameTime) === current.world.serverId) return;
    if (!this.running || current === null) { this.output.print("Server is not running.\n"); return; }
    if (current.world.restartTime !== 0) return;
    const delay = context.argv.length > 1 ? nativeAtoi(argument(context, 1)) : 5;
    const warmup = this.options.common.cvars.get("g_doWarmup");
    if (delay !== 0 && (warmup === undefined || warmup.numericValue === 0)) {
      current.world.restartTime = (current.statics.time + Math.imul(delay, 1000)) | 0;
      await runCalls(current.world.configstrings.setCalls(5, String(current.world.restartTime))); return;
    }
    if (this.cvar("sv_maxclients").modified || this.cvar("g_gametype").modified) {
      this.output.print("variable change -- restarting.\n"); await this.spawnMap(this.cvar("mapname").value.slice(0, 63), false); return;
    }
    this.markMapTransition();
    try {
      current.statics.snapFlagServerBit ^= 4; current.world.serverId = signedTime(this.options.clock.comFrameTime);
      this.options.common.cvars.set("sv_serverid", String(current.world.serverId), true);
      current.world.state = "loading"; current.world.restarting = true;
      this.phase = { kind: "initializing", statics: current.statics };
      await runCalls(this.shutdownGame(current, true)); await this.initializeGame(current, true);
      for (let index = 0; index < 3; index++) await runCalls(this.settle(current, false));
      current.world.state = "game"; current.world.restarting = false;
      const game = this.game(current);
      for (const client of current.statics.clients) {
        if (client.phase < ServerClientPhase.Connected) continue;
        if (client.connection.kind !== "initialized") throw new Error("Connected client has no channel");
        const isBot = client.connection.address.kind === "bot";
        await runCalls(current.lifecycle.sendServerCommand(client.slot, "map_restart\n"));
        const denied = await runCalls(game.calls.clientConnect(client.slot, false, isBot));
        if (denied !== null) {
          await runCalls(current.lifecycle.dropClient(client, denied));
          this.output.print(`SV_MapRestart_f(${delay}): dropped client ${client.slot} - denied!\n`);
        } else {
          client.connection.phase = ServerClientPhase.Active;
          await runCalls(current.clientCommands.clientEnterWorld(client, client.lastUsercmd));
        }
      }
      await runCalls(this.settle(current, false));
      this.phase = { kind: "running", statics: current.statics, world: current.world };
    } catch (error) {
      if (error instanceof CommonError) throw error;
      try { await runCalls(this.releaseSession()); }
      catch (cleanupError) {
        if (cleanupError instanceof CommonError) throw cleanupError;
        throw new AggregateError([error, cleanupError], "Server restart and cleanup failed");
      }
      throw error;
    }
  }

  private async shutdownSession(request: ServerShutdownRequest): Promise<void> {
    if (this.phase.kind === "stopped") return;
    const level = this.map();
    const errors: unknown[] = [];
    try {
      this.output.print("----- Server Shutdown -----\n");
      if (request.kind === "normal") {
        for (let pass = 0; pass < 2; pass++) {
          for (const client of level.statics.clients) {
            if (client.phase < ServerClientPhase.Connected) continue;
            if (client.connection.kind !== "initialized") throw new Error("Connected client has no channel");
            if (client.connection.address.kind !== "loopback") {
              await runCalls(level.lifecycle.sendServerCommand(client.slot, `print "${request.reason}"`));
              await runCalls(level.lifecycle.sendServerCommand(client.slot, "disconnect"));
            }
            client.nextSnapshotTime = -1; level.sender.sendClientSnapshot(client);
          }
        }
      }
      for (let pass = 0; pass < 2; pass++) {
        level.statics.nextHeartbeatTime = -9999; await this.connectionless.masterHeartbeat(); this.assertCurrentOperation();
      }
    } catch (error) { if (error instanceof CommonError) throw error; errors.push(error); }
    try { await runCalls(this.releaseSession()); } catch (error) { if (error instanceof CommonError) throw error; errors.push(error); }
    try { this.output.print("---------------------------\n"); } catch (error) { if (error instanceof CommonError) throw error; errors.push(error); }
    if (this.options.clientLifecycle.kind === "available") {
      try { await this.options.clientLifecycle.disconnectAfterServerShutdown(); this.assertCurrentOperation(); }
      catch (error) { if (error instanceof CommonError) throw error; errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Server shutdown and cleanup failed", { cause: errors[0] });
  }
  private *releaseSession(): CallSteps {
    const errors: unknown[] = [], level = this.currentMap;
    try { if (level !== null) yield* this.shutdownGame(level, false); }
    catch (error) { if (error instanceof CommonError) throw error; errors.push(error); }
    try { if (level !== null) this.retireGame(level); }
    catch (error) { if (error instanceof CommonError) throw error; errors.push(error); }
    try { this.ownedBots?.releaseSession(); } catch (error) { if (error instanceof CommonError) throw error; errors.push(error); }
    this.worldSectors.clearServer();
    if (level !== null) {
      for (const client of level.statics.clients) {
        client.gameEntity = null;
        try { level.downloads.close(client); } catch (error) { if (error instanceof CommonError) throw error; errors.push(error); }
      }
      level.world.state = "dead"; level.world.restarting = false;
    }
    this.currentMap = null; this.phase = { kind: "stopped" };
    this.options.common.cvars.set("sv_running", "0", true); this.options.common.cvars.set("ui_singlePlayerActive", "0", true);
    this.networkControl.resetServerSession();
    if (errors.length !== 0) throw new AggregateError(errors, "Server resource cleanup failed");
  }
  private status(): void {
    if (!this.running) { this.output.print("Server is not running.\n"); return; }
    const level = this.map(), print = (text: string): void => { this.output.print(text); };
    print(`map: ${this.cvar("mapname").value}\n`);
    print("num score ping name            lastmsg address               qport rate\n");
    print("--- ----- ---- --------------- ------- --------------------- ----- -----\n");
    for (const client of level.statics.clients) {
      if (client.phase === ServerClientPhase.Free) continue;
      const connection = client.connection;
      const score = this.game(level).data.copyPlayerState(client.slot).persistant.get(PersistentIndex.PERS_SCORE);
      print(`${String(client.slot).padStart(3)} `); print(`${String(score).padStart(5)} `);
      print(client.phase === ServerClientPhase.Connected ? "CNCT " : client.phase === ServerClientPhase.Zombie ? "ZMBI " : `${String(Math.min(client.ping, 9999)).padStart(4)} `);
      print(client.name); print("^7"); for (let index = client.name.length; index < 16; index++) print(" ");
      print(`${String((level.statics.time - client.lastPacketTime) | 0).padStart(7)} `);
      const address = connection.address.kind === "ipv4" ? `${connection.address.host.join(".")}:${connection.address.port}` : connection.address.kind;
      print(address); for (let index = address.length; index < 22; index++) print(" ");
      const qport = connection.kind === "initialized" ? connection.netchan.qport : 0;
      print(String(qport).padStart(5)); print(` ${String(client.rate).padStart(5)}`); print("\n");
    }
    print("\n");
  }
}
