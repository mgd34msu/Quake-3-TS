// Sys_IsLANAddress and Sys_ShowIP from id Software's code/unix/unix_net.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { networkInterfaces } from "node:os";
import type { Ipv4Host } from "./network.ts";

export type LanAddress = { readonly kind: "ipv4"; readonly host: Ipv4Host }
  | { readonly kind: "loopback" } | { readonly kind: "bot" };

function copyHost(host: Ipv4Host): Ipv4Host {
  if (host.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    throw new RangeError("Local IPv4 addresses require octets in 0..255");
  }
  return [host[0], host[1], host[2], host[3]];
}

function parseHost(text: string): Ipv4Host {
  const parts = text.split(".");
  const [a, b, c, d] = parts;
  if (parts.length !== 4 || a === undefined || b === undefined || c === undefined || d === undefined
    || parts.some(part => !/^\d{1,3}$/.test(part))) throw new Error(`Invalid local IPv4 interface address ${text}`);
  return copyHost([Number(a), Number(b), Number(c), Number(d)]);
}

/** Captures local addresses at network initialization, as the source does. */
export class LanAddresses {
  private readonly hosts: readonly Ipv4Host[];

  constructor(hosts: readonly Ipv4Host[]) { this.hosts = hosts.map(copyHost); }

  /** Bun interface enumeration replaces the source hostname/ioctl list and retains Bun's order. */
  static current(): LanAddresses {
    const hosts: Ipv4Host[] = [];
    for (const interfaces of Object.values(networkInterfaces())) {
      if (interfaces === undefined) continue;
      for (const address of interfaces) if (address.family === "IPv4") hosts.push(parseHost(address.address));
    }
    return new LanAddresses(hosts);
  }

  showIp(print: (text: string) => undefined): void {
    for (const host of this.hosts) print(`IP: ${host[0]}.${host[1]}.${host[2]}.${host[3]}\n`);
  }

  isLanAddress(address: LanAddress): boolean {
    if (address.kind === "loopback") return true;
    if (address.kind !== "ipv4") return false;
    const ip = address.host;
    if ((ip[0] & 0x80) === 0) return this.hosts.some(local => ip[0] === local[0]);
    if ((ip[0] & 0xc0) === 0x80) {
      return this.hosts.some(local => (ip[0] === local[0] && ip[1] === local[1])
        || (ip[0] === 172 && local[0] === 172 && (ip[1] & 0xf0) === 16 && (local[1] & 0xf0) === 16));
    }
    return this.hosts.some(local => (ip[0] === local[0] && ip[1] === local[1] && ip[2] === local[2])
      || (ip[0] === 192 && local[0] === 192 && ip[1] === 168 && local[1] === 168));
  }
}
