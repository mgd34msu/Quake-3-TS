// CL_RequestMotd and CL_MotdPacket from id Software's code/client/cl_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CvarRegistry } from "../core/cvar.ts";
import { infoSetValueForKey, infoValueForKey } from "../core/info-string.ts";
import type { LinuxNativeRandom } from "../core/native-random.ts";
import type { Ipv4Address } from "../platform/network.ts";
import type { UnixIo } from "../platform/unix-io.ts";
import { encodeConnectionlessText } from "../protocol/connectionless.ts";
import type { ConnectionlessPacket } from "../protocol/connectionless.ts";
import type { ClientPacketAddress, ClientStaticState } from "./client-state.ts";

export interface ClientMotdOptions {
  readonly clientStatic: ClientStaticState;
  readonly cvars: CvarRegistry;
  readonly io: UnixIo;
  readonly random: LinuxNativeRandom;
  milliseconds(): number;
  rendererString(): string;
  print(text: string): void;
}

/** Update address and challenge have client-static lifetime, including disconnects. */
export class ClientMotd {
  private address: Ipv4Address | null = null;
  private challenge = "";

  constructor(private readonly options: ClientMotdOptions) {}

  async request(assertCurrentOperation: () => void): Promise<void> {
    assertCurrentOperation();
    const { cvars, io, random } = this.options;
    const enabled = cvars.get("cl_motd");
    if (enabled === undefined) throw new Error("CL_RequestMotd requires registered cl_motd");
    if (enabled.integerValue === 0) return;
    const print = (text: string): void => { this.options.print(text); assertCurrentOperation(); };
    print("Resolving update.quake3arena.com\n");
    const resolved = await io.resolveAddress("update.quake3arena.com", 27951);
    assertCurrentOperation();
    this.address = resolved;
    if (resolved === null) { print("Couldn't resolve address\n"); return; }
    print(`update.quake3arena.com resolved to ${resolved.host.join(".")}:${resolved.port}\n`);

    const challenge = ((random.next() << 16) ^ random.next()) ^ this.options.milliseconds();
    assertCurrentOperation();
    this.challenge = String(challenge);
    let info = infoSetValueForKey("", "challenge", this.challenge, print);
    info = infoSetValueForKey(info, "renderer", this.options.rendererString(), print);
    const version = cvars.get("version");
    if (version === undefined) throw new Error("CL_RequestMotd requires registered version");
    info = infoSetValueForKey(info, "version", version.value, print);
    assertCurrentOperation();
    const udp = io.udp;
    if (udp !== null && !udp.send(resolved, encodeConnectionlessText(`getmotd "${info}"\n`))) {
      const developer = cvars.get("developer");
      if (developer !== undefined && developer.integerValue !== 0) print("Sys_SendPacket: UDP socket could not queue packet\n");
    }
    assertCurrentOperation();
  }

  packet(from: ClientPacketAddress, packet: ConnectionlessPacket): void {
    const address = this.address;
    if (address === null || from.kind !== "ipv4" || from.port !== address.port
      || !from.host.every((octet, index) => octet === address.host[index])) return;
    const info = packet.arguments[0] ?? "";
    if (infoValueForKey(info, "challenge") !== this.challenge) return;
    const motd = infoValueForKey(info, "motd");
    this.options.clientStatic.updateInfoString = info.slice(0, 1023);
    this.options.cvars.set("cl_motdString", motd, true);
  }
}
