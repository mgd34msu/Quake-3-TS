// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { compareIpxAddress, compareIpxBaseAddress, ipxAddressToSocket, ipxAddressToString, ipxSocketToAddress, isLocalIpxAddress, parseIpxSocketAddress } from "../src/platform/ipx-address.ts";
import type { IpxAddress } from "../src/platform/ipx-address.ts";

function address(text: string): IpxAddress {
  const socket = parseIpxSocketAddress(text);
  if (socket === null) throw new Error("Expected IPX fixture");
  return ipxSocketToAddress(socket);
}

describe("source IPX address algorithms", () => {
  test("literal byte layout, case, leading zeros and network-order port", () => {
    const lower = address("01234567.89abcdef0001");
    expect(lower).toEqual({ kind: "ipx", network: [1, 35, 69, 103], node: [137, 171, 205, 239, 0, 1], port: [0, 0] });
    expect(address("01234567.89ABCDEF0001")).toEqual(lower);
    expect(ipxAddressToString(lower)).toBe("01234567.89abcdef0001:0");
    expect(ipxAddressToString({ ...lower, port: [0x6d, 0x38] })).toBe("01234567.89abcdef0001:27960");
    expect(ipxAddressToString({ ...lower, port: [255, 255] })).toBe("01234567.89abcdef0001:65535");
    expect(ipxAddressToString(address("12121212.121212121212"))).toBe("12121212.121212121212:0");
  });

  test("strlen stops at NUL and only exact length/dot selects IPX", () => {
    expect(address("12121212.121212121212\0ignored")).toEqual(address("12121212.121212121212"));
    for (const text of ["", "12121212.12121212121", "12121212.1212121212120", "12121212-121212121212", "12121212.121212121212:27960", "12121212.12\0remaining"]) {
      expect(parseIpxSocketAddress(text)).toBeNull();
    }
  });

  test("scanf partial conversions and later failures retain val", () => {
    expect(address("1gzz 2-f.+a0xggff??09")).toEqual({ kind: "ipx", network: [1, 1, 2, 241], node: [10, 0, 0, 255, 255, 9], port: [0, 0] });
    expect(() => address("zz121212.121212121212")).toThrow("uninitialized");
    expect(() => address("\u01001234567.89abcdef0001")).toThrow("single-byte");
  });

  test("mapping owns copied fields and broadcast uses source zero/ff destination", () => {
    const a = address("01234567.89abcdef0001");
    const socket = ipxAddressToSocket({ ...a, port: [0x12, 0x34] });
    expect(ipxSocketToAddress(socket)).toEqual({ ...a, port: [0x12, 0x34] });
    expect(socket.network).not.toBe(a.network);
    expect(ipxSocketToAddress(socket).node).not.toBe(socket.node);
    const broadcast: IpxAddress = { ...a, kind: "ipx-broadcast", port: [0x12, 0x34] };
    expect(ipxAddressToSocket(broadcast)).toEqual({ family: "ipx", network: [0, 0, 0, 0], node: [255, 255, 255, 255, 255, 255], port: [0x12, 0x34] });
    expect(ipxSocketToAddress(ipxAddressToSocket(broadcast)).kind).toBe("ipx");
    expect(ipxAddressToString(broadcast)).toBe("01234567.89abcdef0001:4660");
  });

  test("full versus base comparison and source broadcast diagnostics", () => {
    const a = address("01234567.89abcdef0001");
    const logs: string[] = [];
    const print = (text: string): undefined => { logs.push(text); };
    expect(compareIpxAddress(a, { ...a }, print)).toBe(true);
    expect(compareIpxAddress(a, { ...a, port: [1, 0] }, print)).toBe(false);
    expect(compareIpxBaseAddress(a, { ...a, port: [1, 0] }, print)).toBe(true);
    for (const other of [address("11234567.89abcdef0001"), address("01234567.89abcdef0002")]) {
      expect(compareIpxAddress(a, other, print)).toBe(false);
      expect(compareIpxBaseAddress(a, other, print)).toBe(false);
    }
    const broadcast: IpxAddress = { ...a, kind: "ipx-broadcast" };
    expect(compareIpxAddress(a, broadcast, print)).toBe(false);
    expect(logs).toEqual([]);
    expect(compareIpxAddress(broadcast, broadcast, print)).toBe(false);
    expect(compareIpxBaseAddress(broadcast, broadcast, print)).toBe(false);
    expect(logs).toEqual(["NET_CompareAdr: bad address type\n", "NET_CompareBaseAdr: bad address type\n"]);
    expect(isLocalIpxAddress(a)).toBe(false);
    expect(isLocalIpxAddress(broadcast)).toBe(false);
    expect(isLocalIpxAddress(address("00000000.000000000000"))).toBe(false);
  });

  test("typed socket boundary rejects non-byte fields", () => {
    const a = address("01234567.89abcdef0001");
    expect(() => ipxAddressToSocket({ ...a, port: [256, 0] })).toThrow(RangeError);
    expect(() => ipxAddressToString({ ...a, network: [-1, 0, 0, 0] })).toThrow(RangeError);
  });
});
