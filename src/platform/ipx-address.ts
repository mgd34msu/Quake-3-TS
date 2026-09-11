// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 1999-2005 Id Software, Inc.
// Port of code/win32/win_net.c address conversion and code/qcommon/net_chan.c
// IPX comparison/formatting. This module does not provide an IPX transport.

export type IpxNetwork = readonly [number, number, number, number];
export type IpxNode = readonly [number, number, number, number, number, number];
/** Bytes in network order, independent of the host's short representation. */
export type IpxPort = readonly [number, number];
export interface IpxAddress {
  readonly kind: "ipx" | "ipx-broadcast";
  readonly network: IpxNetwork;
  readonly node: IpxNode;
  readonly port: IpxPort;
}
export interface IpxSocketAddress {
  readonly family: "ipx";
  readonly network: IpxNetwork;
  readonly node: IpxNode;
  readonly port: IpxPort;
}

function checkBytes(bytes: readonly number[]): void {
  if (bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new RangeError("IPX fields must contain bytes in 0..255");
  }
}

function copyFields(address: IpxSocketAddress | IpxAddress): {
  network: IpxNetwork; node: IpxNode; port: IpxPort;
} {
  checkBytes(address.network); checkBytes(address.node); checkBytes(address.port);
  const network: IpxNetwork = [...address.network];
  const node: IpxNode = [...address.node];
  const port: IpxPort = [...address.port];
  return { network, node, port };
}

export function ipxAddressToSocket(address: IpxAddress): IpxSocketAddress {
  const fields = copyFields(address);
  if (address.kind === "ipx-broadcast") {
    return { family: "ipx", network: [0, 0, 0, 0], node: [255, 255, 255, 255, 255, 255], port: fields.port };
  }
  return { family: "ipx", ...fields };
}

export function ipxSocketToAddress(address: IpxSocketAddress): IpxAddress {
  return { kind: "ipx", ...copyFields(address) };
}

/** Null means the source would take its separate IPv4/DNS branch. */
export function parseIpxSocketAddress(input: string): IpxSocketAddress | null {
  const nul = input.indexOf("\0");
  const text = nul < 0 ? input : input.slice(0, nul);
  if (text.length !== 21 || text[8] !== ".") return null;
  if ([...text].some(character => character.charCodeAt(0) > 255)) {
    throw new RangeError("IPX parser requires single-byte source text");
  }
  let previous: number | undefined;
  function pair(offset: number): number {
    // DO uses one retained int val and ignores sscanf's return value. Its
    // two-byte input permits whitespace, signs and partial hex conversion.
    const match = /^[\t\n\v\f\r ]*[+-]?[0-9a-fA-F]+/.exec(text.slice(offset, offset + 2));
    if (match !== null) previous = Number.parseInt(match[0].trim(), 16);
    if (previous === undefined) {
      throw new RangeError("IPX first pair leaves the source conversion value uninitialized");
    }
    return previous & 255;
  }
  const network: IpxNetwork = [pair(0), pair(2), pair(4), pair(6)];
  const node: IpxNode = [pair(9), pair(11), pair(13), pair(15), pair(17), pair(19)];
  return { family: "ipx", network, node, port: [0, 0] };
}

function sameBytes(a: IpxAddress, b: IpxAddress): boolean {
  return a.network.every((byte, index) => byte === b.network[index])
    && a.node.every((byte, index) => byte === b.node[index]);
}

export function compareIpxBaseAddress(a: IpxAddress, b: IpxAddress, print: (text: string) => undefined): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "ipx") return sameBytes(a, b);
  print("NET_CompareBaseAdr: bad address type\n");
  return false;
}

export function compareIpxAddress(a: IpxAddress, b: IpxAddress, print: (text: string) => undefined): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "ipx") return sameBytes(a, b) && a.port[0] === b.port[0] && a.port[1] === b.port[1];
  print("NET_CompareAdr: bad address type\n");
  return false;
}

export function ipxAddressToString(address: IpxAddress): string {
  checkBytes(address.network); checkBytes(address.node); checkBytes(address.port);
  const hex = (byte: number): string => byte.toString(16).padStart(2, "0");
  return `${address.network.map(hex).join("")}.${address.node.map(hex).join("")}:${address.port[0] * 256 + address.port[1]}`;
}

export function isLocalIpxAddress(address: IpxAddress): boolean {
  // NET_IsLocalAddress accepts only NA_LOOPBACK, including for zero IPX bytes.
  switch (address.kind) {
    case "ipx":
    case "ipx-broadcast": return false;
  }
}
