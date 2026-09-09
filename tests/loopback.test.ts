// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { LoopbackTransport, MAX_LOOPBACK_PACKETS } from "../src/protocol/loopback.ts";
import { MAX_PACKET_LENGTH, Netchannel } from "../src/protocol/netchan.ts";

describe("source loopback queues", () => {
  test("routes both directions and distinguishes empty datagrams from empty queues", () => {
    const loop = new LoopbackTransport();
    loop.send("client", Uint8Array.of(1, 2));
    loop.send("server", new Uint8Array());
    expect(loop.poll("server")).toEqual({ from: { kind: "loopback" }, payload: Uint8Array.of(1, 2) });
    expect(loop.poll("client")).toEqual({ from: { kind: "loopback" }, payload: new Uint8Array() });
    expect(loop.poll("server")).toBeNull();
    expect(loop.poll("client")).toBeNull();
  });

  test("retains the last sixteen packets on overflow exactly as NET_GetLoopPacket", () => {
    const loop = new LoopbackTransport();
    for (let index = 0; index < 35; index++) loop.send("client", Uint8Array.of(index));
    for (let expected = 19; expected < 35; expected++) expect(loop.poll("server")?.payload).toEqual(Uint8Array.of(expected));
    expect(MAX_LOOPBACK_PACKETS).toBe(16);
    expect(loop.poll("server")).toBeNull();
  });

  test("wraps repeated mixed send/read operations without losing pending packets", () => {
    const loop = new LoopbackTransport();
    for (let cycle = 0; cycle < 100; cycle++) {
      for (let offset = 0; offset < 16; offset++) loop.send("server", Uint8Array.of(cycle, offset));
      for (let offset = 0; offset < 8; offset++) expect(loop.poll("client")?.payload).toEqual(Uint8Array.of(cycle, offset));
      for (let offset = 16; offset < 25; offset++) loop.send("server", Uint8Array.of(cycle, offset));
      for (let offset = 9; offset < 25; offset++) expect(loop.poll("client")?.payload).toEqual(Uint8Array.of(cycle, offset));
      expect(loop.poll("client")).toBeNull();
    }
  });

  test("owns input copies and never reuses returned storage", () => {
    const loop = new LoopbackTransport();
    const bytes = Buffer.from([99, 11, 22, 99]);
    loop.send("client", bytes.subarray(1, 3));
    bytes.fill(0);
    const packet = loop.poll("server");
    if (packet === null) throw new Error("Missing loopback packet");
    expect(packet.payload).toEqual(Uint8Array.of(11, 22));
    for (let index = 0; index < 32; index++) loop.send("client", Uint8Array.of(index));
    expect(packet.payload).toEqual(Uint8Array.of(11, 22));
    packet.payload.fill(0);
    expect(loop.poll("server")?.payload).toEqual(Uint8Array.of(16));
  });

  test("bounds packet storage and keeps instances and directions independent", () => {
    const first = new LoopbackTransport();
    const second = new LoopbackTransport();
    expect(() => first.send("client", new Uint8Array(MAX_PACKET_LENGTH + 1))).toThrow("MAX_PACKETLEN");
    first.send("client", new Uint8Array(MAX_PACKET_LENGTH));
    first.send("server", Uint8Array.of(3));
    for (let index = 0; index < 17; index++) first.send("client", Uint8Array.of(index));
    expect(first.poll("client")?.payload).toEqual(Uint8Array.of(3));
    expect(first.poll("server")?.payload).toEqual(Uint8Array.of(1));
    expect(second.poll("client")).toBeNull();
    expect(second.poll("server")).toBeNull();
  });

  test("holds and reassembles a complete MAX_MSGLEN gamestate", () => {
    const loop = new LoopbackTransport();
    const sender = new Netchannel("server");
    const receiver = new Netchannel("client");
    const payload = Uint8Array.from({ length: 16384 }, (_, index) => index & 255);
    for (const packet of sender.transmit(payload)) loop.send("server", packet);
    let completed = false;
    for (let packet = loop.poll("client"); packet !== null; packet = loop.poll("client")) {
      const result = receiver.receive(packet.payload);
      if (result.kind === "rejected") throw new Error(result.reason);
      if (result.kind === "accepted") { expect(result.payload).toEqual(payload); completed = true; }
    }
    expect(completed).toBe(true);
  });
});
