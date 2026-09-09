// CL_RequestAuthorization from id Software's client/cl_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import type { Ipv4Address } from "../platform/network.ts";
import type { UnixIo } from "../platform/unix-io.ts";
import { encodeConnectionlessText } from "../protocol/connectionless.ts";
import type { CommonCdKeyState } from "./cd-key.ts";

export interface ClientAuthorizationOptions {
  readonly cvars: CvarRegistry;
  readonly cdKey: CommonCdKeyState;
  readonly io: UnixIo;
  print(text: string): void;
}

/** Client-static address lifetime, retained across disconnects and map changes. */
export class ClientAuthorization {
  private address: Ipv4Address | null = null;

  constructor(private readonly options: ClientAuthorizationOptions) {}

  async request(assertCurrentOperation: () => void): Promise<void> {
    assertCurrentOperation();
    const print = (text: string): void => { this.options.print(text); assertCurrentOperation(); };
    if (this.address === null) {
      print("Resolving authorize.quake3arena.com\n");
      const resolved = await this.options.io.resolveAddress("authorize.quake3arena.com", 27952);
      assertCurrentOperation();
      if (resolved === null) {
        print("Couldn't resolve address\n");
        return;
      }
      this.address = resolved;
      print(`authorize.quake3arena.com resolved to ${resolved.host.join(".")}:${resolved.port}\n`);
    }

    const { cvars, cdKey, io } = this.options;
    const restrict = cvars.get("fs_restrict");
    let key = "";
    if (restrict !== undefined && Math.fround(restrict.numericValue) !== 0) key = "demota";
    else {
      const bytes = new Uint8Array(33);
      cdKey.readAuthorization(bytes);
      for (const byte of bytes.subarray(0, 32)) {
        if (byte === 0) break;
        if ((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)) {
          key += String.fromCharCode(byte);
        }
      }
    }
    const anonymous = cvars.register("cl_anonymous", "0", CvarFlag.Init | CvarFlag.SystemInfo);
    assertCurrentOperation();
    const udp = io.udp;
    if (udp !== null && !udp.send(this.address, encodeConnectionlessText(`getKeyAuthorize ${anonymous.integerValue} ${key}`))) {
      const developer = cvars.get("developer");
      if (developer !== undefined && developer.integerValue !== 0) print("Sys_SendPacket: UDP socket could not queue packet\n");
    }
    assertCurrentOperation();
  }
}
