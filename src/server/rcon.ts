// Port of id Software's sv_main.c SVC_RemoteCommand and SV_FlushRedirect.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CommandBuffer } from "../core/commands.ts";
import type { ConsoleOutput } from "../core/console-output.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { sourceCommandText } from "../core/text.ts";
import { encodeConnectionlessText } from "../protocol/connectionless.ts";
import type { ConnectionlessPacket } from "../protocol/connectionless.ts";
import type { ServerPacketAddress } from "./net-channel.ts";
import type { ServerNetworkControlState } from "./network-control.ts";

export interface ServerRconHost {
  readonly cvars: CvarRegistry;
  readonly commands: CommandBuffer;
  readonly output: ConsoleOutput;
  milliseconds(): number;
  sendPacket(address: ServerPacketAddress, packet: Uint8Array): void;
}

/** Shares the engine's output stream and function-static throttle across server/session replacements. */
export class ServerRconRuntime {
  constructor(readonly control: ServerNetworkControlState, readonly host: ServerRconHost) {}

  private password(): string {
    const password = this.host.cvars.get("rconPassword");
    if (password === undefined) throw new Error("Rcon requires registered rconPassword cvar");
    return sourceCommandText(password.value);
  }

  async handle(from: ServerPacketAddress, _rawPacket: Uint8Array, packet: ConnectionlessPacket): Promise<void> {
    await this.control.runRcon(async () => {
      const clock = this.host.milliseconds();
      if (!Number.isInteger(clock) || clock < -0x80000000 || clock > 0x7fffffff) throw new RangeError("Rcon clock must return source signed-int milliseconds");
      const time = clock >>> 0;
      // Source compares absolute unsigned timestamps, including the wrapped addition.
      if (time < ((this.control.rconLastTime + 500) >>> 0)) return;
      this.control.rconLastTime = time;
      const password = this.password(), supplied = packet.arguments[0];
      const valid = password.length !== 0 && password === (supplied === undefined ? "" : supplied);
      const address = from.kind === "loopback" ? "loopback" : `${from.host.join(".")}:${from.port}`;
      // Deliberate privacy deviation: Cmd_Argv(2) can contain credentials; never log command text.
      this.host.output.print(`${valid ? "Rcon" : "Bad rcon"} from ${address}:\n[command omitted]\n`);
      this.control.assertCurrentOperation();
      this.control.redirectAddress = from.kind === "loopback" ? { kind: "loopback" } : { kind: "ipv4", host: [...from.host], port: from.port };
      const redirectOwner = this.control.captureCurrentOperation();
      let commandReturned = false;
      await this.host.output.redirect(1008, text => {
        redirectOwner.assertOpen();
        if (commandReturned) redirectOwner.assertChildrenReturned();
        const target = this.control.redirectAddress;
        if (target.kind === "bot") return; // NET_SendPacket drops native zero-initialized NA_BOT destinations.
        this.host.sendPacket(target, encodeConnectionlessText(`print\n${text}`));
      }, async () => {
        try {
          if (this.password().length === 0) { this.host.output.print("No rconpassword set on the server.\n"); return; }
          if (!valid) { this.host.output.print("Bad rconpassword.\n"); return; }
          const line = sourceCommandText(packet.line);
          if (line.length < 4) throw new RangeError("Rcon command cursor exceeds source command string");
          let cursor = 4;
          while (line[cursor] === " ") cursor++;
          while (cursor < line.length && line[cursor] !== " ") cursor++;
          while (line[cursor] === " ") cursor++;
          const remaining = line.slice(cursor, cursor + 1023);
          // Cmd_ExecuteString("") does nothing; EXEC_NOW("") would instead drain the queued buffer.
          if (remaining.length !== 0) await this.host.commands.executeNowAsync(remaining);
        } finally { commandReturned = true; }
      });
    });
  }
}
