// clientActive_t, CL_ClearState and client getters from id Software client.h,
// cl_main.c, cl_parse.c and cl_cgame.c. Copyright (C) 1999-2005 Id Software, Inc.
// GPL-2.0-or-later.
import { ClientCommandHistory } from "../cgame/prediction.ts";
import { SnapshotHistory } from "../cgame/snapshot-history.ts";
import { HistorySnapshotSource } from "../cgame/snapshots.ts";
import type { CommandBuffer } from "../core/commands.ts";
import { CommonError } from "../core/common-error.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { infoValueForKey } from "../core/info-string.ts";
import { vec3 } from "../core/math.ts";
import { MAX_PARSE_ENTITIES, SourceParseEntities } from "../protocol/parse-entities.ts";
import { EntityStateRecord } from "../shared/entity-state.ts";
import type { UserCommand } from "../shared/player-state.ts";
import type { ClientConnectionState, ClientStaticState } from "./client-state.ts";
import type { ClientMoveSample } from "./client-session.ts";
import { ClientGameStateStorage } from "./game-state.ts";

class ActiveCommands {
  private history = new ClientCommandHistory();
  private offset = 0;
  get currentNumber(): number { return (this.offset + this.history.currentNumber) | 0; }
  read(number: number): UserCommand | null { return this.history.read(number - this.offset); }
  append(command: UserCommand): number { this.history.append(command); return this.currentNumber; }
  restart(): void { this.offset = this.currentNumber; this.history = new ClientCommandHistory(); }
  reset(): void { this.offset = 0; this.history = new ClientCommandHistory(); }
}

/** Engine-lived allocation; sessions borrow it and CL_ClearState clears it in place. */
export class ClientActiveState {
  readonly gameState = new ClientGameStateStorage(message => { throw new Error(message); });
  readonly parseEntities = new SourceParseEntities();
  readonly history = new SnapshotHistory(this.parseEntities);
  readonly snapshots: HistorySnapshotSource;
  readonly commands = new ActiveCommands();
  readonly baselines = Array.from({ length: 1024 }, () => new EntityStateRecord<number>(0));
  readonly snapshotPings: ({ readonly messageNumber: number; readonly ping: number } | null)[] = Array.from({ length: 32 }, () => null);
  readonly outPackets = Array.from({ length: 32 }, () => ({ commandNumber: 0, serverTime: 0, realTime: 0 }));
  get parseEntitiesNumber(): number { return this.parseEntities.number; }
  set parseEntitiesNumber(number: number) { this.parseEntities.number = number; }
  userCmdValue = 0;
  sensitivity = 0;
  serverId = 0;
  time = 0;
  oldServerTime = 0;
  oldFrameServerTime = 0;
  serverTimeDelta = 0;
  extrapolatedSnapshot = false;
  newSnapshots = false;

  constructor(readonly developerPrint: (text: string) => void) {
    this.snapshots = new HistorySnapshotSource(this.history, () => this.parseEntitiesNumber, developerPrint);
  }

  clear(): void {
    this.gameState.clear(); this.history.clear(); this.commands.reset(); this.parseEntities.clear();
    const zero = new EntityStateRecord<number>(0);
    for (const baseline of this.baselines) baseline.copyFrom(zero);
    this.snapshotPings.fill(null);
    for (const packet of this.outPackets) { packet.commandNumber = 0; packet.serverTime = 0; packet.realTime = 0; }
    this.userCmdValue = 0; this.sensitivity = 0; this.serverId = 0;
    this.time = 0; this.oldServerTime = 0; this.oldFrameServerTime = 0; this.serverTimeDelta = 0;
    this.extrapolatedSnapshot = false; this.newSnapshots = false;
  }

  getSourceGameState() { return this.gameState.copySourceRecord(); }
  getParseEntityState(number: number): EntityStateRecord<number> | null {
    int32(number, "Parse entity number");
    if (number >= this.parseEntitiesNumber) {
      throw new CommonError("drop", `CL_GetParseEntityState: ${number} >= ${this.parseEntitiesNumber}`);
    }
    if (number <= this.parseEntitiesNumber - MAX_PARSE_ENTITIES) return null;
    return this.parseEntities.at(number).copy();
  }
  getGameState(): readonly string[] { return this.gameState.copyStrings(); }
  getConfigString(index: number): string | null {
    return Number.isInteger(index) && index >= 0 && index < 1024 ? this.gameState.get(index) : null;
  }
  readSnapshotClientNumber(): number { return this.history.readCurrentPlayerState()?.clientNum ?? 0; }
  snapshotPing(messageNumber: number): number | null {
    int32(messageNumber, "Snapshot message number");
    const entry = this.snapshotPings[messageNumber & 31];
    if (entry === undefined) throw new RangeError("Missing client snapshot ping slot");
    return this.history.readSlot(messageNumber)?.status === "valid" && entry?.messageNumber === messageNumber ? entry.ping : null;
  }
  setUserCmdValue(value: number, sensitivity: number): void {
    int32(value, "Cgame user command value");
    this.userCmdValue = value; this.sensitivity = Math.fround(sensitivity);
  }
  createUserCommand(input: ClientMoveSample): number {
    int32(input.serverTime, "Command server time"); int32(input.buttons, "Command buttons");
    for (const move of [input.forwardmove, input.rightmove, input.upmove]) {
      if (!Number.isInteger(move) || move < -128 || move > 127) throw new RangeError("Processed movement must be in -128..127");
    }
    for (const angle of [input.viewAngles.x, input.viewAngles.y, input.viewAngles.z]) {
      if (!Number.isFinite(angle)) throw new RangeError("Command view angles must be finite");
    }
    return this.commands.append({ serverTime: input.serverTime, buttons: input.buttons, weapon: this.userCmdValue & 255,
      forwardmove: input.forwardmove, rightmove: input.rightmove, upmove: input.upmove,
      angles: vec3(shortAngle(input.viewAngles.x), shortAngle(input.viewAngles.y), shortAngle(input.viewAngles.z)) });
  }
}

function shortAngle(value: number): number {
  const scaled = Math.fround(Math.fround(Math.fround(value) * 65536) / 360);
  if (!Number.isFinite(scaled) || scaled < -2147483648 || scaled >= 2147483648) {
    throw new RangeError("Undefined native angle float-to-int conversion");
  }
  return Math.trunc(scaled) & 65535;
}

export interface ClientSystemInfoServices {
  readonly cvars: CvarRegistry;
  assertCurrentOperation(): void;
  applyServerPackages(info: string): Promise<void>;
}

export interface ClientServerCommandServices extends ClientSystemInfoServices {
  readonly consoleCommands: CommandBuffer;
  emitEvent(event: { readonly kind: "clear-notify" } | { readonly kind: "close-console" }
    | { readonly kind: "append-console-command"; readonly text: string }): void;
  fail(kind: "drop" | "server-disconnect", message: string): never;
}

function int32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new RangeError(`${label} must be int32`);
}
function atoi(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed | 0;
}
function arg(argv: readonly string[], index: number): string { return argv[index] ?? ""; }

export async function applyClientSystemInfo(active: ClientActiveState, connection: ClientConnectionState,
  services: ClientSystemInfoServices): Promise<void> {
  const info = active.gameState.get(1) ?? "";
  active.serverId = atoi(infoValueForKey(info, "sv_serverid"));
  if (connection.demoPlaying) return;
  if (atoi(infoValueForKey(info, "sv_cheats")) === 0) services.cvars.setCheatsEnabled(false);
  await services.applyServerPackages(info); services.assertCurrentOperation();
  let cursor = info.startsWith("\\") ? 1 : 0, gameSet = false;
  while (cursor < info.length) {
    const separator = info.indexOf("\\", cursor);
    const key = separator < 0 ? info.slice(cursor) : info.slice(cursor, separator);
    if (key === "") break;
    const next = separator < 0 ? -1 : info.indexOf("\\", separator + 1);
    const text = separator < 0 ? "" : info.slice(separator + 1, next < 0 ? info.length : next);
    if (key.toLowerCase() === "fs_game") gameSet = true;
    services.cvars.set(key, text, true);
    if (next < 0) break;
    cursor = next + 1;
  }
  if (!gameSet && (services.cvars.get("fs_game")?.value ?? "") !== "") services.cvars.set("fs_game", "", true);
  connection.connectedToPureServer = (services.cvars.get("sv_pure")?.integerValue ?? 0) !== 0;
  // A missing sv_cheats pair preserves the actual cvar's prior value.
  services.cvars.setCheatsEnabled((services.cvars.get("sv_cheats")?.integerValue ?? 1) !== 0);
}

/** CL_GetServerCommand has no transport requirement, including after CL_Disconnect. */
export async function getClientServerCommand(sequence: number, active: ClientActiveState,
  connection: ClientConnectionState, clientStatic: ClientStaticState,
  services: ClientServerCommandServices): Promise<readonly string[] | null> {
  services.assertCurrentOperation(); int32(sequence, "Server command number");
  if (sequence <= connection.serverCommandSequence - 64) {
    if (connection.demoPlaying) return null;
    services.fail("drop", "CL_GetServerCommand: a reliable command was cycled out");
  }
  if (sequence > connection.serverCommandSequence) services.fail("drop", "CL_GetServerCommand: requested a command not received");
  connection.lastExecutedServerCommand = sequence;
  let text = connection.serverCommands[sequence & 63];
  if (text === undefined) throw new RangeError("Missing incoming server command slot");
  active.developerPrint(`serverCommand: ${sequence} : ${text}\n`);
  text = connection.serverCommands[sequence & 63];
  if (text === undefined) throw new RangeError("Missing incoming server command slot");
  let argv = services.consoleCommands.tokenize(text), name = arg(argv, 0);
  if (name === "disconnect") services.fail("server-disconnect", argv.length >= 2 ? `Server Disconnected - ${arg(argv, 1)}` : "Server disconnected\n");
  if (name === "bcs0") {
    clientStatic.bigConfigString = `cs ${arg(argv, 1)} "${arg(argv, 2)}`.slice(0, 8191);
    return null;
  }
  if (name === "bcs1" || name === "bcs2") {
    const suffix = arg(argv, 2), last = name === "bcs2";
    if (clientStatic.bigConfigString.length + suffix.length + (last ? 1 : 0) >= 8192) services.fail("drop", "bcs exceeded BIG_INFO_STRING");
    clientStatic.bigConfigString += suffix;
    if (!last) return null;
    clientStatic.bigConfigString += '"'; text = clientStatic.bigConfigString;
    argv = services.consoleCommands.tokenize(text); name = arg(argv, 0);
  }
  if (name === "cs") {
    const index = atoi(arg(argv, 1)), value = argv.slice(2).join(" ");
    if (index < 0 || index >= 1024) services.fail("drop", "configstring > MAX_CONFIGSTRINGS");
    let modified: boolean;
    try { modified = active.gameState.modify(index, value); }
    catch (error) {
      if (error instanceof Error) services.fail("drop", error.message);
      throw error;
    }
    if (modified && index === 1) await applyClientSystemInfo(active, connection, services);
    argv = services.consoleCommands.tokenize(text);
  } else if (name === "map_restart") {
    services.emitEvent({ kind: "clear-notify" }); active.commands.restart();
  } else if (name === "clientLevelShot") {
    if ((services.cvars.get("sv_running")?.integerValue ?? 0) === 0) return null;
    services.emitEvent({ kind: "close-console" });
    services.emitEvent({ kind: "append-console-command", text: "wait ; wait ; wait ; wait ; screenshot levelshot\n" });
  }
  return argv;
}
