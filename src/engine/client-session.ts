// Client connection/active-state boundary from id Software's cl_parse.c,
// cl_cgame.c, cl_input.c:CL_FinishMove/CL_WritePacket and cl_net_chan.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CommandSource } from "../cgame/prediction.ts";
import type { SnapshotSource } from "../cgame/snapshots.ts";
import { CommonError } from "../core/common-error.ts";
import { CvarRegistry } from "../core/cvar.ts";
import type { CvarSnapshot } from "../core/cvar.ts";
import type { Vec3 } from "../core/math.ts";
import type { CommandBuffer } from "../core/commands.ts";
import type { LanAddresses } from "../platform/lan.ts";
import { beginClientMessage, finishClientMessage, MAX_PACKET_USER_COMMANDS, writeClientMovement } from "../protocol/client-message.ts";
import { MessageReader } from "../protocol/message.ts";
import type { SourceMessageState, WireUserCommand } from "../protocol/message.ts";
import { Netchannel, xorClientMessage, xorServerMessage } from "../protocol/netchan.ts";
import type { ChannelDelivery, ChannelDiagnostics, ChannelResult } from "../protocol/netchan.ts";
import { ReliableOverflowError } from "../protocol/reliable.ts";
import type { ClientReliableCommands, ReliableCommand } from "../protocol/reliable.ts";
import { ServerMessageCursor } from "../protocol/server-message.ts";
import type { Download, Gamestate, GamestateEntry, ServerMessage, ServerOperation } from "../protocol/server-message.ts";
import type { Product } from "../shared/definitions.ts";
import type { SourcePlayerState } from "../shared/player-state.ts";
import type { DemoEnd, DemoMessageReader } from "../protocol/demo.ts";
import type { ClientConnectionState, ClientPacketAddress, ClientStaticState } from "./client-state.ts";
import { applyClientSystemInfo, getClientServerCommand } from "./client-active.ts";
import type { ClientActiveState, ClientServerCommandServices } from "./client-active.ts";
import type { SourceGameStateRecord } from "./game-state.ts";

export interface DemoTimingReport {
  readonly frames: number;
  readonly elapsedMilliseconds: number;
}
export interface ClientSessionLifecycle {
  readonly sourceState: SourceMessageState;
  readonly consoleCommands: CommandBuffer;
  readonly clientActive: ClientActiveState;
  readonly clientStatic: ClientStaticState;
  readonly clientConnection: ClientConnectionState;
  assertCurrentOperation(): void;
  print(text: string): undefined;
  milliseconds(): number;
  applyServerPackages(systemInfo: string): Promise<void>;
  downloadSizeReceived(fileSize: number): number;
  downloadReceived(block: Download): Promise<void | "retired">;
  gamestateReceived(generation: number): Promise<void | "retired">;
  demoCompleted(end: DemoEnd, timing: DemoTimingReport | null): Promise<void>;
}

export type ClientSessionMode =
  | { readonly kind: "network"; readonly challenge: number; readonly qport: number }
  | { readonly kind: "demo"; readonly reader: DemoMessageReader };
export interface ClientSessionOptions {
  readonly product: Product;
  readonly mode: ClientSessionMode;
  readonly cvars: CvarRegistry;
  readonly lifecycle: ClientSessionLifecycle;
}
export interface ClientPacketDelivery extends ChannelDelivery {
  print(text: string): undefined;
}
export type ClientSessionEvent =
  | { readonly kind: "close-console" }
  | { readonly kind: "clear-notify" }
  | { readonly kind: "clear-active-state" }
  | { readonly kind: "append-console-command"; readonly text: string }
  | { readonly kind: "diagnostic"; readonly text: string }
  | { readonly kind: "register-cgame-command"; readonly name: string }
  | { readonly kind: "gamestate"; readonly generation: number }
  | { readonly kind: "disconnect"; readonly reason: string; readonly errorKind: ClientSessionError["kind"] };
export class ClientSessionError extends Error {
  constructor(readonly kind: "drop" | "server-disconnect" | "unsupported", message: string) {
    super(message); this.name = "ClientSessionError";
  }
}
export type ClientSessionPacket = Exclude<ChannelResult, { kind: "accepted" }>
  | { readonly kind: "retired" }
  | { readonly kind: "accepted"; readonly sequence: number; readonly dropped: number; readonly message: ServerMessage };

/** Already processed keyboard/mouse/joystick input; this is not CL_CreateCmd. */
export interface ClientMoveSample {
  readonly serverTime: number;
  readonly viewAngles: Vec3;
  readonly buttons: number;
  readonly forwardmove: number;
  readonly rightmove: number;
  readonly upmove: number;
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (!Number.isInteger(index) || value === undefined) throw new RangeError(`Client session index ${index} outside ${values.length}`);
  return value;
}
function int32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new RangeError(`${label} must be int32`);
}
function clockInt32(value: number, expression: string): number {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new RangeError(`Undefined native client clock arithmetic: ${expression}`);
  }
  return value;
}

/** One initialized connection; a new gamestate replaces active state, not its reliable channel. */
export class EngineClientSession {
  readonly product: Product;
  readonly cvars: CvarRegistry;
  readonly mode: ClientSessionMode;
  readonly lifecycle: ClientSessionLifecycle;
  readonly active: ClientActiveState;
  private readonly channel: Netchannel | null;
  private readonly reliable: ClientReliableCommands;
  get snapshots(): SnapshotSource { return this.active.snapshots; }
  get commands(): CommandSource { return this.active.commands; }
  private readonly events: ClientSessionEvent[] = [];
  private messageSequence = 0;
  private generation = 0;
  private client = 0;
  private checksum = 0;
  private firstDemoFrameSkipped = false;
  private timeDemoFrames = 0;
  private timeDemoStart = 0;
  private timeDemoBaseTime = 0;
  private failure: ClientSessionError | null = null;
  private writingDisconnect = false;

  constructor(options: ClientSessionOptions) {
    options.lifecycle.assertCurrentOperation();
    if (options.lifecycle.clientStatic.phase !== "connected") throw new Error("An initialized client session requires the admitted connected phase");
    this.product = options.product; this.cvars = options.cvars; this.mode = { ...options.mode };
    this.lifecycle = options.lifecycle;
    this.active = options.lifecycle.clientActive;
    this.lifecycle.clientConnection.demoPlaying = options.mode.kind === "demo";
    this.reliable = options.lifecycle.clientConnection.reliable;
    if (options.mode.kind === "network") int32(options.mode.challenge, "Client challenge");
    this.channel = options.mode.kind === "network" ? new Netchannel("client", options.mode.qport, () => this.clockCvar("net_qport").integerValue) : null;
  }
  get serverMessageSequence(): number { return this.messageSequence; }
  get serverTime(): number { return this.active.time; }
  get serverCommandSequence(): number { return this.lifecycle.clientConnection.serverCommandSequence; }
  get lastExecutedServerCommand(): number { return this.lifecycle.clientConnection.lastExecutedServerCommand; }
  get clientNumber(): number { return this.client; }
  get checksumFeed(): number { return this.checksum; }
  get serverId(): number { return this.active.serverId; }
  get gamestateGeneration(): number { return this.generation; }
  get userCmdSensitivity(): number { return this.active.sensitivity; }
  get dropped(): ClientSessionError | null { return this.failure; }
  get pendingEvents(): readonly ClientSessionEvent[] { return this.events.map(event => ({ ...event })); }
  takeEvents(): readonly ClientSessionEvent[] { return this.events.splice(0); }
  print(text: string): void { this.alive(); this.events.push({ kind: "diagnostic", text }); }
  appendConsoleCommand(text: string): void { this.alive(); this.events.push({ kind: "append-console-command", text }); }
  registerCgameCommand(name: string): void { this.alive(); this.events.push({ kind: "register-cgame-command", name }); }
  snapshotPing(messageNumber: number): number | null { return this.active.snapshotPing(messageNumber); }
  getGameState(): readonly string[] { this.alive(); return this.active.gameState.copyStrings(); }
  getSourceGameState(): SourceGameStateRecord { this.alive(); return this.active.gameState.copySourceRecord(); }
  /** CL_Record_f preserves allocated empty configstrings and skips zero-number baselines. */
  copyGamestate(): Gamestate {
    this.alive();
    const entries: GamestateEntry[] = [];
    for (let index = 0; index < 1024; index++) {
      const value = this.active.gameState.get(index);
      if (value !== null) entries.push({ kind: "configstring", index, value });
    }
    for (let number = 0; number < this.active.baselines.length; number++) {
      const entity = at(this.active.baselines, number);
      if (entity !== null && entity.number !== 0) entries.push({ kind: "baseline", number, entity: entity.copy() });
    }
    return { kind: "gamestate", commandSequence: this.lifecycle.clientConnection.serverCommandSequence, entries,
      clientNumber: this.client, checksumFeed: this.checksum };
  }
  /** cl_ui.c GetConfigString distinguishes offset zero from an allocated empty string. */
  getConfigString(index: number): string | null {
    this.alive();
    return Number.isInteger(index) && index >= 0 && index < 1024 ? this.active.gameState.get(index) : null;
  }
  /** CL_MapLoading clears cl.gameState while retaining the local connection. */
  clearGameStateForMapLoading(): void {
    this.alive();
    this.active.gameState.clear();
  }
  /** cl_ui.c:GetClientState reads cl.snap.ps.clientNum, independent of admission identity. */
  readSnapshotClientNumber(): number {
    return this.readCurrentPlayerState()?.clientNum ?? 0;
  }
  /** Engine input and console read cl.snap.ps independently of CL_GetSnapshot's entity window. */
  readCurrentPlayerState(): SourcePlayerState | null {
    this.alive();
    return this.active.history.readCurrentPlayerState();
  }

  /** Called only after the corresponding CG_Init has completed, like CL_InitCGame. */
  prime(generation: number): void {
    this.alive();
    if (generation === 0 || generation !== this.generation) throw new Error("Cannot prime an absent or stale gamestate");
    this.lifecycle.clientStatic.phase = "primed";
  }
  private alive(): void {
    this.lifecycle.assertCurrentOperation();
    if (this.failure !== null) throw this.failure;
  }
  private clockCvar(name: string): CvarSnapshot {
    const value = this.cvars.get(name);
    if (value === undefined) throw new Error(`Client clock requires registered cvar ${name}`);
    return value;
  }
  private latestSnapshot() {
    const snapshot = this.active.history.latest;
    if (snapshot === null) this.fail("drop", "CL_SetCGameTime: !cl.snap.valid");
    return snapshot;
  }
  /** CL_AdjustTimeDelta. The source's unused local resetTime does not change 500. */
  private adjustTimeDelta(): void {
    this.active.newSnapshots = false;
    if (this.mode.kind === "demo") return;
    const snapshot = this.latestSnapshot();
    const newDelta = clockInt32(snapshot.serverTime - this.lifecycle.clientStatic.realtime, "snap.serverTime - cls.realtime");
    const difference = clockInt32(newDelta - this.active.serverTimeDelta, "newDelta - serverTimeDelta");
    const deltaDelta = clockInt32(Math.abs(difference), "abs(newDelta - serverTimeDelta)");
    if (deltaDelta > 500) {
      this.active.serverTimeDelta = newDelta; this.active.oldServerTime = snapshot.serverTime; this.active.time = snapshot.serverTime;
      if (this.clockCvar("cl_showTimeDelta").integerValue !== 0) this.print("<RESET> ");
    } else if (deltaDelta > 100) {
      if (this.clockCvar("cl_showTimeDelta").integerValue !== 0) this.print("<FAST> ");
      this.active.serverTimeDelta = clockInt32(this.active.serverTimeDelta + newDelta, "serverTimeDelta + newDelta") >> 1;
    } else {
      const timescale = this.clockCvar("timescale").numericValue;
      if (timescale === 0 || timescale === 1) {
        if (this.active.extrapolatedSnapshot) {
          this.active.extrapolatedSnapshot = false;
          this.active.serverTimeDelta = clockInt32(this.active.serverTimeDelta - 2, "serverTimeDelta - 2");
        } else this.active.serverTimeDelta = clockInt32(this.active.serverTimeDelta + 1, "serverTimeDelta + 1");
      }
    }
    if (this.clockCvar("cl_showTimeDelta").integerValue !== 0) this.print(`${this.active.serverTimeDelta} `);
  }
  private firstSnapshot(): void {
    const snapshot = this.latestSnapshot();
    if ((snapshot.flags & 2) !== 0) return;
    this.lifecycle.clientStatic.phase = "active";
    this.active.serverTimeDelta = clockInt32(snapshot.serverTime - this.lifecycle.clientStatic.realtime, "first snap.serverTime - cls.realtime");
    this.active.oldServerTime = snapshot.serverTime;
    this.timeDemoBaseTime = snapshot.serverTime;
    const action = this.clockCvar("activeAction").value;
    if (action !== "") {
      this.appendConsoleCommand(action);
      this.cvars.set("activeAction", "", true);
    }
    // Sys_BeginProfiling is empty in the reference Unix and Win32 targets.
  }
  /** CL_SetCGameTime; the client frame calls this after CL_SendCmd, once per frame. */
  async setCGameTime(): Promise<void> {
    this.alive();
    const state = this.lifecycle.clientStatic;
    int32(state.realtime, "Client static real time");
    if (state.phase !== "active") {
      if (state.phase !== "primed") return;
      if (this.mode.kind === "demo") {
        if (!this.firstDemoFrameSkipped) { this.firstDemoFrameSkipped = true; return; }
        if (!await this.readDemoMessage()) return;
        this.alive();
      }
      if (this.active.newSnapshots) { this.active.newSnapshots = false; this.firstSnapshot(); }
      if (this.lifecycle.clientStatic.phase !== "active") return;
    }
    const snapshot = this.latestSnapshot();
    if (this.clockCvar("sv_paused").integerValue !== 0 && this.clockCvar("cl_paused").integerValue !== 0
      && this.clockCvar("sv_running").integerValue !== 0) return;
    if (snapshot.serverTime < this.active.oldFrameServerTime) this.fail("drop", "cl.snap.serverTime < cl.oldFrameServerTime");
    this.active.oldFrameServerTime = snapshot.serverTime;
    if (this.mode.kind !== "demo" || this.clockCvar("cl_freezeDemo").integerValue === 0) {
      const nudge = Math.max(-30, Math.min(30, this.clockCvar("cl_timeNudge").integerValue));
      this.active.time = clockInt32(clockInt32(state.realtime + this.active.serverTimeDelta, "cls.realtime + serverTimeDelta") - nudge,
        "cls.realtime + serverTimeDelta - timeNudge");
      if (this.active.time < this.active.oldServerTime) this.active.time = this.active.oldServerTime;
      this.active.oldServerTime = this.active.time;
      if (clockInt32(state.realtime + this.active.serverTimeDelta, "cls.realtime + serverTimeDelta")
        >= clockInt32(snapshot.serverTime - 5, "snap.serverTime - 5")) this.active.extrapolatedSnapshot = true;
    }
    if (this.active.newSnapshots) this.adjustTimeDelta();
    if (this.mode.kind !== "demo") return;
    if (this.clockCvar("timedemo").integerValue !== 0) {
      if (this.timeDemoStart === 0) this.timeDemoStart = clockInt32(this.lifecycle.milliseconds(), "Sys_Milliseconds()");
      this.timeDemoFrames = clockInt32(this.timeDemoFrames + 1, "timeDemoFrames++");
      this.active.time = clockInt32(this.timeDemoBaseTime + clockInt32(this.timeDemoFrames * 50, "timeDemoFrames * 50"),
        "timeDemoBaseTime + timeDemoFrames * 50");
    }
    while (this.active.time >= this.latestSnapshot().serverTime) {
      if (!await this.readDemoMessage()) return;
      this.alive();
      if (state.phase !== "active") return;
    }
  }
  private async readDemoMessage(): Promise<boolean> {
    this.alive();
    if (this.mode.kind !== "demo") throw new Error("Cannot read a demo from a network connection");
    const record = this.mode.reader.next(sequence => {
      this.alive(); int32(sequence, "Demo message sequence");
      this.messageSequence = sequence;
      return undefined;
    });
    if (record.kind === "end") {
      let timing: DemoTimingReport | null = null;
      if (this.clockCvar("timedemo").integerValue !== 0) {
        const elapsed = clockInt32(clockInt32(this.lifecycle.milliseconds(), "Sys_Milliseconds()") - this.timeDemoStart,
          "Sys_Milliseconds() - timeDemoStart");
        if (elapsed > 0) timing = { frames: this.timeDemoFrames, elapsedMilliseconds: elapsed };
      }
      await this.lifecycle.demoCompleted(record, timing);
      // Completion intentionally retires this connection. The frame owner
      // checks its current operation after this callback returns.
      return false;
    }
    this.lifecycle.clientConnection.lastPacketTime = clockInt32(this.lifecycle.clientStatic.realtime, "cls.realtime at demo message read");
    if (await this.receiveServerMessage(record.sequence, record.payload) === null) return false;
    this.alive();
    return true;
  }
  /** The read-until-primed portion of CL_PlayDemo_f, over an actual opened reader. */
  async readInitialDemoMessages(): Promise<void> {
    this.alive();
    if (this.mode.kind !== "demo") throw new Error("Network connection cannot prime demo playback");
    while (this.lifecycle.clientStatic.phase === "connected" || this.lifecycle.clientStatic.phase === "loading") {
      if (!await this.readDemoMessage()) return;
      this.alive();
    }
    this.firstDemoFrameSkipped = false;
  }
  private fail(kind: ClientSessionError["kind"], message: string): never {
    this.lifecycle.assertCurrentOperation();
    const error = new ClientSessionError(kind, message);
    this.failure = error;
    this.events.push({ kind: "disconnect", reason: message, errorKind: kind });
    throw error;
  }

  /** Plaintext after CL_Netchan_Decode, or one actual demo message payload. */
  async receiveServerMessage(sequence: number, bytes: Uint8Array): Promise<ServerMessage | null> {
    this.alive();
    int32(sequence, "Server message sequence");
    if (this.mode.kind === "network" && (sequence <= this.messageSequence || sequence < 1)) throw new RangeError("Server message sequence must advance");
    try {
      this.messageSequence = sequence;
      const cursor = new ServerMessageCursor(bytes, "<server-message>", {
        shownet: () => this.clockCvar("cl_shownet").integerValue,
        print: text => { this.alive(); this.lifecycle.print(text); this.alive(); },
      }, this.mode.kind === "network" ? 4 : 0, this.active.parseEntities, fileSize => {
        this.alive();
        const currentSize = this.lifecycle.downloadSizeReceived(fileSize);
        this.alive();
        return currentSize;
      });
      let acknowledge = 0, gamestateSequence = 0, gamestateClient = 0, gamestateChecksum = 0;
      let entries: GamestateEntry[] = [];
      const operations: ServerOperation[] = [];
      const client = this;
      while (true) {
        this.alive();
        // CL_DownloadsComplete can pump a nested message before initialization.
        // Unchanged-source fixtures prove the outer continuation uses live state.
        const step = cursor.next({ product: this.product,
          get messageNumber() { return client.messageSequence; },
          get reliableSequence() { return client.reliable.sequence; },
          get serverCommandSequence() { return client.lifecycle.clientConnection.serverCommandSequence; },
          get parseEntitiesNumber() { return client.active.parseEntitiesNumber; }, baseline: number => at(this.active.baselines, number),
          history: number => this.active.history.borrowSlot(number, this.product) });
        switch (step.kind) {
          case "acknowledge": acknowledge = step.sequence; this.reliable.assignAcknowledgement(step.sequence); break;
          case "gamestate-start": this.beginGamestate(); entries = []; break;
          case "gamestate-sequence":
            gamestateSequence = step.sequence; this.lifecycle.clientConnection.serverCommandSequence = step.sequence; this.active.gameState.beginEntries(); break;
          case "gamestate-entry":
            entries.push(step.entry);
            if (step.entry.kind === "configstring") this.active.gameState.append(step.entry.index, step.entry.value);
            else at(this.active.baselines, step.entry.number).copyFrom(step.entry.entity);
            break;
          case "gamestate-client": gamestateClient = step.number; this.client = step.number; break;
          case "gamestate-checksum": gamestateChecksum = step.checksum; this.checksum = step.checksum; break;
          case "snapshot-header":
            if (step.deltaNumber <= 0) this.lifecycle.clientConnection.demoWaiting = false;
            break;
          case "gamestate-end":
            operations.push({ kind: "gamestate", commandSequence: gamestateSequence, clientNumber: gamestateClient,
              checksumFeed: gamestateChecksum, entries });
            await this.systemInfoChanged(); this.alive();
            this.events.push({ kind: "gamestate", generation: this.generation });
            if (await this.lifecycle.gamestateReceived(this.generation) === "retired") {
              // The owning event pump checked its operation before reporting a
              // replaced connection. Do not resume parsing that old connection.
              this.cvars.set("cl_paused", "0", true);
              return null;
            }
            this.alive();
            this.cvars.set("cl_paused", "0", true);
            break;
          case "operation": {
            const operation = step.operation;
            operations.push(operation);
            switch (operation.kind) {
              case "nop": break;
              case "command":
                this.lifecycle.clientConnection.serverCommandSequence = operation.sequence;
                this.lifecycle.clientConnection.serverCommands[operation.sequence & 63] = operation.text.slice(0, 1023);
                break;
              case "snapshot":
                this.active.history.publish(operation);
                if (operation.validity.kind === "valid") {
                  let ping = 999;
                  for (let i = 0; i < 32; i++) {
                    const packet = at(this.active.outPackets, ((this.channel?.outgoingSequence ?? 1) - 1 - i) & 31);
                    if (operation.snapshot.playerState.commandTime >= packet.serverTime) {
                      ping = (this.lifecycle.clientStatic.realtime - packet.realTime) | 0; break;
                    }
                  }
                  this.active.snapshotPings[this.messageSequence & 31] = { messageNumber: this.messageSequence, ping };
                  if (this.clockCvar("cl_shownet").integerValue === 3) {
                    this.lifecycle.print(`   snapshot:${operation.snapshot.messageNumber}  delta:${operation.snapshot.deltaNumber}  ping:${ping}\n`);
                    this.alive();
                  }
                  this.active.newSnapshots = true;
                }
                break;
              case "download":
                if (await this.lifecycle.downloadReceived(operation.block) === "retired") return null;
                this.alive();
                break;
              default: { const exhaustive: never = operation; return exhaustive; }
              }
            break;
          }
          case "end": return { reliableAcknowledge: acknowledge, serverCommandSequence: this.lifecycle.clientConnection.serverCommandSequence,
            parseEntitiesNumber: this.active.parseEntitiesNumber, operations, terminal: step.terminal };
        }
      }
    } catch (error) {
      if (error instanceof ClientSessionError || error instanceof CommonError) throw error;
      if (error instanceof Error) this.fail("drop", error.message);
      throw error;
    }
  }

  /** Address/challenge admission occurs before constructing this initialized connection. */
  async receiveDatagram(packet: Uint8Array, diagnostics: ChannelDiagnostics | null = null): Promise<ClientSessionPacket> {
    this.alive();
    if (this.channel === null || this.mode.kind !== "network") throw new Error("Demo session cannot receive datagrams");
    const current: ChannelDiagnostics | null = diagnostics === null ? null : {
      get showPackets() { return diagnostics.showPackets; },
      get showDrop() { return diagnostics.showDrop; },
      get remoteAddress() { return diagnostics.remoteAddress; },
      print: text => { this.alive(); diagnostics.print(text); this.alive(); },
    };
    const result = this.channel.receive(packet, current);
    if (result.kind !== "accepted") return result;
    try {
      const ack = new MessageReader(result.payload).readLong();
      const plaintext = xorServerMessage(result.payload, this.mode.challenge, result.sequence, this.reliable.lookupMasked(ack));
      this.lifecycle.sourceState.addNewsize(plaintext.length + 4);
      const message = await this.receiveServerMessage(result.sequence, plaintext);
      if (message === null) return { kind: "retired" };
      this.lifecycle.clientConnection.demoRecording?.writeMessage(this, plaintext);
      return { kind: "accepted", sequence: result.sequence, dropped: result.dropped, message };
    } catch (error) {
      if (error instanceof ClientSessionError || error instanceof CommonError) throw error;
      if (error instanceof Error) this.fail("drop", error.message);
      throw error;
    }
  }

  private beginGamestate(): void {
    this.events.push({ kind: "close-console" });
    this.active.clear();
    this.events.push({ kind: "clear-active-state" });
    this.generation++;
  }

  private clientStateServices(): ClientServerCommandServices {
    return { cvars: this.cvars, consoleCommands: this.lifecycle.consoleCommands,
      assertCurrentOperation: () => this.alive(),
      applyServerPackages: info => this.lifecycle.applyServerPackages(info),
      emitEvent: event => { this.events.push(event); },
      fail: (kind, message) => this.fail(kind, message) };
  }
  private async systemInfoChanged(): Promise<void> {
    await applyClientSystemInfo(this.active, this.lifecycle.clientConnection, this.clientStateServices());
  }
  async getServerCommand(sequence: number): Promise<readonly string[] | null> {
    return getClientServerCommand(sequence, this.active, this.lifecycle.clientConnection,
      this.lifecycle.clientStatic, this.clientStateServices());
  }
  setUserCmdValue(value: number, sensitivity: number): void {
    this.alive(); this.active.setUserCmdValue(value, sensitivity);
  }
  createUserCommand(input: ClientMoveSample): number | null {
    this.alive();
    if (this.lifecycle.clientStatic.phase !== "primed" && this.lifecycle.clientStatic.phase !== "active"
      && this.lifecycle.clientStatic.phase !== "cinematic") return null;
    return this.active.createUserCommand(input);
  }
  addReliableCommand(text: string): ReliableCommand {
    this.alive();
    try { return this.reliable.add(text); }
    catch (error) {
      if (error instanceof ReliableOverflowError) this.fail("drop", error.message);
      throw error;
    }
  }

  /** CL_ReadyToSendPacket; the caller supplies the admitted netchannel address, not the challenge address. */
  readyToSendPacket(remoteAddress: ClientPacketAddress, lan: LanAddresses): boolean {
    this.alive();
    const cls = this.lifecycle.clientStatic, clc = this.lifecycle.clientConnection;
    if (this.mode.kind === "demo" || clc.demoPlaying || cls.phase === "cinematic") return false;
    const downloading = clc.downloadTempName !== "" && clc.downloadTempName.charCodeAt(0) !== 0;
    if (downloading && clockInt32(cls.realtime - clc.lastPacketSentTime, "download packet interval") < 50) return false;
    if (cls.phase !== "active" && cls.phase !== "primed" && !downloading
      && clockInt32(cls.realtime - clc.lastPacketSentTime, "connecting packet interval") < 1000) return false;
    if (remoteAddress.kind === "loopback" || lan.isLanAddress(remoteAddress)) return true;
    let maximum = this.clockCvar("cl_maxpackets").integerValue;
    if (maximum < 15) { this.cvars.set("cl_maxpackets", "15", true); maximum = this.clockCvar("cl_maxpackets").integerValue; }
    else if (maximum > 125) { this.cvars.set("cl_maxpackets", "125", true); maximum = this.clockCvar("cl_maxpackets").integerValue; }
    this.alive();
    if (this.channel === null) throw new Error("Network packet readiness requires a channel");
    const previous = at(this.active.outPackets, (this.channel.outgoingSequence - 1) & 31);
    const delta = clockInt32(cls.realtime - previous.realTime, "rate-limited packet interval");
    return delta >= Math.trunc(1000 / maximum);
  }

  /** CL_WritePacket; caller owns the frame's readiness decision and actual transport destination. */
  transmit(delivery: ClientPacketDelivery): undefined {
    this.alive();
    this.writePacket(delivery, () => this.alive());
  }

  /** CL_Disconnect still writes the real channel after an earlier parser drop. */
  disconnectPackets(delivery: ClientPacketDelivery): void {
    this.lifecycle.assertCurrentOperation();
    if (this.writingDisconnect) throw new Error("Client disconnect packet writing cannot reenter");
    const precedingFailure = this.failure;
    const guard = (): void => {
      this.lifecycle.assertCurrentOperation();
      if (this.failure !== null && this.failure !== precedingFailure) throw this.failure;
    };
    this.writingDisconnect = true;
    try {
      try { this.reliable.add("disconnect"); }
      catch (error) {
        if (error instanceof ReliableOverflowError) this.fail("drop", error.message);
        throw error;
      }
      for (let pass = 0; pass < 3; pass++) this.writePacket(delivery, guard);
    } finally { this.writingDisconnect = false; }
  }

  private writePacket(delivery: ClientPacketDelivery, guard: () => void): void {
    guard();
    if (this.channel === null || this.mode.kind !== "network" || this.lifecycle.clientConnection.demoPlaying
      || this.lifecycle.clientStatic.phase === "cinematic") return;
    const header = { serverId: this.active.serverId, messageAcknowledge: this.messageSequence, reliableAcknowledge: this.lifecycle.clientConnection.serverCommandSequence };
    const writer = beginClientMessage(header, this.reliable.pending(), this.lifecycle.sourceState);
    if (this.clockCvar("cl_packetdup").integerValue < 0) this.cvars.set("cl_packetdup", "0", true);
    else if (this.clockCvar("cl_packetdup").integerValue > 5) this.cvars.set("cl_packetdup", "5", true);
    guard();
    const duplicates = this.clockCvar("cl_packetdup").integerValue;
    const old = at(this.active.outPackets, (this.channel.outgoingSequence - 1 - duplicates) & 31);
    let count = this.active.commands.currentNumber - old.commandNumber;
    const print = (text: string): void => { guard(); delivery.print(text); guard(); };
    if (count > MAX_PACKET_USER_COMMANDS) {
      count = MAX_PACKET_USER_COMMANDS;
      print("MAX_PACKET_USERCMDS\n");
    }
    const commands: WireUserCommand[] = [];
    if (count >= 1) {
      if (this.clockCvar("cl_showSend").integerValue !== 0) print(`(${count})`);
      const latest = this.active.history.latest;
      const kind = this.clockCvar("cl_nodelta").integerValue !== 0 || latest === null
        || this.lifecycle.clientConnection.demoWaiting || latest.messageNumber !== this.messageSequence ? "move-no-delta" : "move";
      for (let i = 0; i < count; i++) {
        const command = this.active.commands.read(this.active.commands.currentNumber - count + i + 1);
        if (command === null) throw new Error("Outgoing user command was overwritten");
        commands.push({ ...command, angles: [command.angles.x, command.angles.y, command.angles.z] });
      }
      writeClientMovement(writer, { kind, commands },
        { serverId: this.active.serverId, messageAcknowledge: this.messageSequence, reliableAcknowledge: this.lifecycle.clientConnection.serverCommandSequence },
        { checksumFeed: this.checksum, serverCommand: sequence => at(this.lifecycle.clientConnection.serverCommands, sequence & 63) });
    }
    const realTime = this.lifecycle.clientStatic.realtime;
    int32(realTime, "Packet real time");
    this.active.outPackets[this.channel.outgoingSequence & 31] = { commandNumber: this.active.commands.currentNumber,
      serverTime: commands.length === 0 ? 0 : at(commands, commands.length - 1).serverTime, realTime };
    this.lifecycle.clientConnection.lastPacketSentTime = realTime;
    if (this.clockCvar("cl_showSend").integerValue !== 0) print(`${writer.byteLength} `);
    const bytes = finishClientMessage(writer);
    const current: ChannelDelivery = {
      sourceState: this.lifecycle.sourceState,
      send: datagram => { guard(); delivery.send(datagram); guard(); },
      trace: text => { guard(); delivery.trace(text); guard(); },
    };
    this.channel.beginTransmit(xorClientMessage(bytes, this.mode.challenge, sequence => at(this.lifecycle.clientConnection.serverCommands, sequence & 63)), current);
    while (this.channel.hasUnsentFragments) {
      if ((this.cvars.get("developer")?.integerValue ?? 0) !== 0) print("WARNING: #462 unsent fragments (not supposed to happen!)\n");
      this.channel.transmitNextFragment(current);
    }
  }
}
