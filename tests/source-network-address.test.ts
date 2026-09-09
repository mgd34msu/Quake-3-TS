// unix_net.c Sys_StringToSockaddr uses the selected glibc inet_addr profile.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { expect, test } from "bun:test";
import { UnixIo } from "../src/platform/unix-io.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import type { Ipv4Host } from "../src/platform/network.ts";

function resolver() {
  return new UnixIo(() => undefined, new UnixSystemClock(), { signals: "none" });
}

test("numeric source hosts accept abbreviated widths and C integer bases without DNS", async () => {
  const io = resolver();
  const fixtures: readonly (readonly [string, Ipv4Host])[] = [
    ["0", [0, 0, 0, 0]], ["1", [0, 0, 0, 1]], ["127.1", [127, 0, 0, 1]],
    ["127.0.1", [127, 0, 0, 1]], ["127.0.0.1", [127, 0, 0, 1]],
    ["2130706433", [127, 0, 0, 1]], ["0x7f000001", [127, 0, 0, 1]],
    ["0X7F000001", [127, 0, 0, 1]], ["017700000001", [127, 0, 0, 1]],
    ["0177.0.0.01", [127, 0, 0, 1]], ["0x7f.01", [127, 0, 0, 1]],
    ["010.0.0.1", [8, 0, 0, 1]], ["00000000000000000000000001", [0, 0, 0, 1]],
    ["1.16777215", [1, 255, 255, 255]], ["1.2.65535", [1, 2, 255, 255]],
    ["1.2.3.255", [1, 2, 3, 255]], ["4294967295", [255, 255, 255, 255]],
    ["037777777777", [255, 255, 255, 255]], ["0xffffffff", [255, 255, 255, 255]],
  ];
  try {
    for (const [text, host] of fixtures) {
      expect(await io.resolveAddress(text, 27960)).toEqual({ kind: "ipv4", host, port: 27960 });
    }
  } finally { io.close(); }
});

test("invalid digit-leading source hosts preserve inet_addr's INADDR_NONE result", async () => {
  const io = resolver();
  try {
    for (const text of ["999.0.0.1", "256.1", "1.256.1", "1.2.256.1", "1.16777216", "1.2.65536",
      "1.2.3.256", "4294967296", "0x100000000", "040000000000", "9".repeat(400),
      "08.0.0.1", "0b1111111.1", "0x", "0Xg", "1..2", "1.", "1.2.3.4.5", "1.-2", "1.+2",
      "1. 2", "1.example.invalid", "1x", "127.1\x01", "127.1\xa0"]) {
      expect(await io.resolveAddress(text, 7)).toEqual({ kind: "ipv4", host: [255, 255, 255, 255], port: 7 });
    }
  } finally { io.close(); }
});

test("source numeric conversion stops at ASCII whitespace or the C string terminator", async () => {
  const io = resolver();
  try {
    for (const separator of [" ", "\t", "\n", "\r", "\v", "\f", "\0"]) {
      expect(await io.resolveAddress(`127.1${separator}ignored.invalid`, 1))
        .toEqual({ kind: "ipv4", host: [127, 0, 0, 1], port: 1 });
    }
    expect(await io.resolveAddress("127 .0.0.1", 1)).toEqual({ kind: "ipv4", host: [0, 0, 0, 127], port: 1 });
    expect(await io.resolveAddress("1.\n2", 1)).toEqual({ kind: "ipv4", host: [255, 255, 255, 255], port: 1 });
    expect(await io.resolveAddress("", 1)).toBeNull();
    expect(await io.resolveAddress("\0ignored.invalid", 1)).toBeNull();
  } finally { io.close(); }
});

test("numeric resolution preserves owned immutable results and existing boundary failures", async () => {
  const io = resolver();
  try {
    const first = await io.resolveAddress("127.1", 65535);
    const second = await io.resolveAddress("127.2", 1);
    expect(first).toEqual({ kind: "ipv4", host: [127, 0, 0, 1], port: 65535 });
    expect(second).toEqual({ kind: "ipv4", host: [127, 0, 0, 2], port: 1 });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.host)).toBe(true);
    await expect(io.resolveAddress("127.1\u0100", 1)).rejects.toThrow("source bytes");
    for (const port of [0, -1, 65536, 1.5, NaN]) await expect(io.resolveAddress("127.1", port)).rejects.toThrow("port");
    io.close();
    await expect(io.resolveAddress("127.1", 1)).rejects.toThrow("closed");
  } finally { io.close(); }
});
