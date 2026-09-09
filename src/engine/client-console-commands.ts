// Client forwarding and independent console commands from id Software cl_main.c.
// Copyright (C) 1999-2005 Id Software, Inc.
// GPL-2.0-or-later.
import { CommonError } from "../core/common-error.ts";
import type { CommandContext } from "../core/commands.ts";
import { CvarFlag } from "../core/cvar.ts";
import { printInfo } from "../core/info-string.ts";
import { nativeAtoi } from "../core/native-numeric.ts";
import { sourceCommandText } from "../core/text.ts";
import type { UnixIo } from "../platform/unix-io.ts";
import type { LoopbackTransport } from "../protocol/loopback.ts";
import { ReliableOverflowError } from "../protocol/reliable.ts";
import type { CommonConsole } from "./common-console.ts";
import type { EngineClientSession } from "./client-session.ts";
import type { ClientConnectionPhase, ClientConnectionState, ClientPacketAddress, ClientStaticState } from "./client-state.ts";

export interface ClientConsoleCommandsOptions {
  readonly common: CommonConsole;
  readonly clientStatic: ClientStaticState;
  readonly io: UnixIo;
  readonly loopback: LoopbackTransport;
  readConnection(): ClientConnectionState;
  readSession(): EngineClientSession | null;
  readRemoteAddress(): ClientPacketAddress | null;
  assertCurrentOperation(): void;
}

// CA_AUTHORIZING occupies source value 2 despite having no live client phase.
const PHASE_NUMBER: Readonly<Record<ClientConnectionPhase, number>> = {
  uninitialized: 0, disconnected: 1, connecting: 3, challenging: 4,
  connected: 5, loading: 6, primed: 7, active: 8, cinematic: 9,
};

/** The client registers these methods at their individual CL_Init command sites. */
export class ClientConsoleCommands {
  constructor(private readonly options: ClientConsoleCommandsOptions) {}

  private enter(context: CommandContext): void { context.assertActive(); this.options.assertCurrentOperation(); }
  private print(text: string): void { this.options.common.output.print(text); this.options.assertCurrentOperation(); }
  private addReliable(text: string): undefined {
    try { this.options.readConnection().reliable.add(text); }
    catch (error) {
      if (error instanceof ReliableOverflowError) throw new CommonError("drop", error.message);
      throw error;
    }
  }

  forwardCommand(context: CommandContext): undefined {
    this.enter(context);
    const command = context.argv[0] ?? "";
    if (command.startsWith("-")) return;
    if (this.options.readConnection().demoPlaying || PHASE_NUMBER[this.options.clientStatic.phase] < 5 || command.startsWith("+")) {
      this.print(`Unknown command "${command}"\n`); return;
    }
    this.addReliable(context.argv.length > 1 ? context.raw : command);
  }

  forwardToServer(context: CommandContext): undefined {
    this.enter(context);
    if (this.options.clientStatic.phase !== "active" || this.options.readConnection().demoPlaying) {
      this.print("Not connected to a server.\n"); return;
    }
    if (context.argv.length > 1) {
      const args = context.args.join(" ");
      if (args.length >= 1024) throw new RangeError("Cmd_Args would overflow its source buffer");
      this.addReliable(args);
    }
  }

  configstrings(context: CommandContext): undefined {
    this.enter(context);
    if (this.options.clientStatic.phase !== "active") { this.print("Not connected to a server.\n"); return; }
    const session = this.options.readSession();
    if (session === null) throw new Error("Active configstrings command requires the actual client session");
    for (let index = 0; index < 1024; index++) {
      const text = session.getConfigString(index);
      if (text !== null) this.print(`${String(index).padStart(4, " ")}: ${text}\n`);
    }
  }

  clientinfo(context: CommandContext): undefined {
    this.enter(context);
    this.print("--------- Client Information ---------\n");
    this.print(`state: ${PHASE_NUMBER[this.options.clientStatic.phase]}\n`);
    this.print(`Server: ${this.options.clientStatic.servername}\n`);
    this.print("User info settings:\n");
    printInfo(this.options.common.cvars.infoString(CvarFlag.UserInfo), text => { this.print(text); });
    this.print("--------------------------------------\n");
  }

  setModel(context: CommandContext): undefined {
    this.enter(context);
    const model = context.argv[1] ?? "", cvars = this.options.common.cvars;
    if (model !== "") { cvars.set("model", model, true); cvars.set("headmodel", model, true); }
    else this.print(`model is set to ${(cvars.get("model")?.value ?? "").slice(0, 255)}\n`);
  }

  setenv(context: CommandContext): undefined {
    this.enter(context);
    const name = context.argv[1] ?? "";
    if (context.argv.length > 2) {
      const assignment = `${name}=${context.argv.slice(2).map(value => `${value} `).join("")}`;
      if (assignment.length >= 1024) throw new RangeError("CL_Setenv_f would overflow its source buffer");
      const separator = assignment.indexOf("="), variable = assignment.slice(0, separator);
      if (variable === "") throw new RangeError("CL_Setenv_f requires a nonempty process environment name");
      process.env[variable] = assignment.slice(separator + 1);
    } else if (context.argv.length === 2) {
      const value = process.env[name];
      this.print(value === undefined ? `${name} undefined\n` : `${name}=${value}\n`);
    }
  }

  async rcon(context: CommandContext): Promise<void> {
    this.enter(context);
    const password = this.options.common.cvars.get("rconPassword");
    if (password === undefined) throw new Error("Rcon requires its CL_Init password cvar");
    if (context.raw.length < 5) throw new RangeError("CL_Rcon_f would read beyond its source command terminator");
    // The original checks the cvar string pointer, not whether its text is empty.
    const text = sourceCommandText(`rcon ${password.value} ${context.raw.slice(5)}`);
    if (text.length + 5 > 1024) throw new RangeError("CL_Rcon_f would overflow its source buffer");
    let to: ClientPacketAddress;
    if (PHASE_NUMBER[this.options.clientStatic.phase] >= 5) {
      const remote = this.options.readRemoteAddress();
      if (remote === null) throw new Error("Connected rcon requires the actual netchannel remote address");
      to = remote;
    } else {
      const address = this.options.common.cvars.get("rconAddress");
      if (address === undefined) throw new Error("Rcon requires its CL_Init address cvar");
      if (address.value === "") {
        this.print("You must either be connected,\nor set the 'rconAddress' cvar\nto issue rcon commands\n"); return;
      }
      to = await this.resolveAddress(address.value);
      this.enter(context);
    }
    const bytes = new Uint8Array(text.length + 5);
    bytes.fill(255, 0, 4);
    for (let index = 0; index < text.length; index++) bytes[index + 4] = text.charCodeAt(index);
    if (to.kind === "loopback") this.options.loopback.send("client", bytes);
    else {
      const udp = this.options.io.udp;
      const developer = this.options.common.cvars.get("developer");
      if (udp !== null && !udp.send(to, bytes) && developer !== undefined && developer.integerValue !== 0)
        this.print("Sys_SendPacket: UDP socket could not queue packet\n");
    }
    this.enter(context);
  }

  private async resolveAddress(input: string): Promise<ClientPacketAddress> {
    const text = sourceCommandText(input);
    if (text === "localhost") return { kind: "loopback" };
    const base = text.slice(0, 1023), separator = base.indexOf(":");
    const host = separator < 0 ? base : base.slice(0, separator);
    const port = separator < 0 ? 27960 : nativeAtoi(base.slice(separator + 1)) & 65535;
    const address = await this.options.io.resolveAddress(host, port === 0 ? 27960 : port);
    this.options.assertCurrentOperation();
    if (address === null || address.host.every(octet => octet === 255)) throw new Error("CL_Rcon_f cannot send to the source NA_BAD address");
    return address;
  }

  openedPakList(context: CommandContext): undefined {
    this.enter(context); this.print(`Opened PK3 Names: ${this.options.common.files.current.pakReferences.loadedPakNames()}\n`);
  }
  referencedPakList(context: CommandContext): undefined {
    this.enter(context); this.print(`Referenced PK3 Names: ${this.options.common.files.current.pakReferences.referencedPakNames()}\n`);
  }
}
