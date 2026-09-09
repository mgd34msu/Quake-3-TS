// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { MAX_DATAGRAM_LENGTH, MAX_QUEUED_DATAGRAMS, normalizeUdpError, UdpReceiveInvariantError, UdpTransport } from "../src/platform/network.ts";
import type { Ipv4Host, UdpReceiveEvent } from "../src/platform/network.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";

const localhost: Ipv4Host = [127, 0, 0, 1];

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for localhost UDP delivery");
    await Bun.sleep(2);
  }
}

async function receive(transport: UdpTransport): Promise<Extract<UdpReceiveEvent, { readonly kind: "packet" }>> {
  await waitUntil(() => transport.statistics.pending > 0);
  const event = transport.poll();
  if (event === null) throw new Error("Missing queued datagram");
  if (event.kind === "error") throw event.error;
  return event;
}

describe("Bun IPv4 datagram boundary", () => {
  test("readable subscriptions notify after enqueue, have independent lifetimes and wake once on close", async () => {
    const transport = await UdpTransport.bind({ host: localhost, port: 0 });
    const observed: number[] = [];
    let resolveFirst: (() => void) | null = null;
    const arrived = new Promise<void>(resolve => { resolveFirst = resolve; });
    const listener = (): undefined => { observed.push(transport.statistics.pending); resolveFirst?.(); };
    const first = transport.subscribeReadable(listener), second = transport.subscribeReadable(listener);
    try {
      expect(observed).toEqual([]);
      transport.send(transport.address, Uint8Array.of(1)); await arrived;
      expect(observed).toEqual([1, 1]); expect(transport.poll()?.kind).toBe("packet");
      first(); first(); transport.close(); transport.close();
      expect(observed).toEqual([1, 1, 0]); second();
      expect(() => transport.subscribeReadable(listener)).toThrow("closed");
    } finally { first(); second(); transport.close(); }
  });

  test("subscription does not consume existing input or invoke an unsubscribed callback", async () => {
    const transport = await UdpTransport.bind({ host: localhost, port: 0 });
    let removedCalls = 0, closeCalls = 0;
    try {
      const removed = transport.subscribeReadable(() => { removedCalls++; }); removed();
      transport.send(transport.address, Uint8Array.of(2)); await waitUntil(() => transport.statistics.pending === 1);
      const afterEnqueue = transport.subscribeReadable(() => { closeCalls++; });
      expect(removedCalls).toBe(0); expect(closeCalls).toBe(0);
      expect(transport.poll()?.kind).toBe("packet"); transport.close(); afterEnqueue();
      expect(closeCalls).toBe(1); expect(removedCalls).toBe(0);
    } finally { transport.close(); }
  });

  test("close wakes all listeners and releases the actual socket even when a listener throws", async () => {
    const transport = await UdpTransport.bind({ host: localhost, port: 0 }), address = transport.address;
    let laterCalls = 0;
    transport.subscribeReadable(() => { throw new Error("close listener failed"); });
    transport.subscribeReadable(() => { laterCalls++; });
    expect(() => transport.close()).toThrow(AggregateError); expect(laterCalls).toBe(1);
    expect(() => transport.close()).not.toThrow(); expect(() => transport.poll()).toThrow("closed");
    const rebound = await UdpTransport.bind({ host: address.host, port: address.port }); rebound.close();
  });

  test("narrows both runtime and declared native error callback shapes", () => {
    const error = new Error("UDP failure");
    expect(normalizeUdpError(error, undefined)).toBe(error);
    expect(normalizeUdpError({ port: 12345 }, error)).toBe(error);
    expect(normalizeUdpError(undefined, undefined).message).toBe("Bun UDP callback supplied no Error");
    expect(normalizeUdpError(undefined, undefined)).toBeInstanceOf(UdpReceiveInvariantError);
  });

  test("exposes an actual localhost connection-refused error and remains usable", async () => {
    const transport = await UdpTransport.bind({ host: localhost, port: 0 });
    const peer = await UdpTransport.bind({ host: localhost, port: 0 });
    const closedAddress = peer.address;
    peer.close();
    try {
      transport.send(closedAddress, Uint8Array.of(1));
      await waitUntil(() => transport.statistics.errors > 0);
      const event = transport.poll();
      if (event === null || event.kind !== "error") throw new Error("Missing native UDP error event");
      expect(event.error).toBeInstanceOf(Error);
      expect(event.error).not.toBeInstanceOf(UdpReceiveInvariantError);
      expect(event.error.message).toContain("ECONNREFUSED");
      transport.send(transport.address, Uint8Array.of(7));
      expect((await receive(transport)).payload).toEqual(Uint8Array.of(7));
    } finally { transport.close(); peer.close(); }
  });

  test("reports synchronous send errors after a localhost peer closes and keeps the socket usable", async () => {
    const output: string[] = [];
    const transport = await UdpTransport.bind({ host: localhost, port: 0, print: text => { output.push(text); } });
    const peer = await UdpTransport.bind({ host: localhost, port: 0 }), destination = peer.address;
    peer.close();
    try {
      let failed = 0;
      // Keep the receive callback from draining ICMP errors between sends.
      for (let packet = 0; packet < 32; packet++) {
        if (!transport.send(destination, Uint8Array.of(packet))) failed++;
      }
      expect(failed).toBeGreaterThan(0);
      expect(output).toHaveLength(failed);
      for (const line of output) {
        expect(line).toBe(`NET_SendPacket ERROR: ECONNREFUSED: connection refused, send to 127.0.0.1:${destination.port}\n`);
      }
      await Bun.sleep(10);
      while (transport.poll() !== null) {}
      expect(transport.send(transport.address, Uint8Array.of(7))).toBe(true);
      expect((await receive(transport)).payload).toEqual(Uint8Array.of(7));
    } finally { transport.close(); peer.close(); }
  });

  test("a send diagnostic failure propagates without entering the receive error queue", async () => {
    const failure = new Error("send diagnostic failed");
    const transport = await UdpTransport.bind({ host: localhost, port: 0, print: () => { throw failure; } });
    try {
      expect(() => transport.send({ kind: "ipv4", host: localhost, port: 0 }, new Uint8Array())).toThrow(failure);
      expect(transport.statistics.errors).toBe(0);
      expect(transport.poll()).toBeNull();
      expect(transport.send(transport.address, Uint8Array.of(7))).toBe(true);
      expect((await receive(transport)).payload).toEqual(Uint8Array.of(7));
    } finally { transport.close(); }
  });

  test("UnixIo routes native send diagnostics through its source print owner", async () => {
    const output: string[] = [];
    const input = new UnixIo(text => { output.push(text); }, new UnixSystemClock(), { signals: "none" });
    const cvars = new CvarRegistry();
    cvars.set("net_port", "0");
    try {
      await input.initializeNetwork(cvars);
      const transport = input.udp;
      if (transport === null) throw new Error("Missing initialized Unix UDP transport");
      expect(transport.send({ kind: "ipv4", host: localhost, port: 0 }, new Uint8Array())).toBe(false);
      expect(output.filter(line => line.startsWith("NET_SendPacket")))
        .toEqual(["NET_SendPacket ERROR: EINVAL: invalid argument, send to 127.0.0.1:0\n"]);
      expect(transport.statistics.errors).toBe(0);
    } finally { input.close(); }
  });

  test("binds ephemeral localhost sockets and sends both directions with owned views", async () => {
    let now = 100;
    const first = await UdpTransport.bind({ host: localhost, port: 0, now: () => now++ });
    const second = await UdpTransport.bind({ host: localhost, port: 0, now: () => now++ });
    try {
      expect(first.address.kind).toBe("ipv4");
      expect(first.address.host).toEqual(localhost);
      expect(first.address.port).toBeGreaterThan(0);
      expect(second.address.port).not.toBe(first.address.port);
      const bytes = Buffer.from([99, 1, 2, 3, 99]);
      expect(first.send(second.address, bytes.subarray(1, 4))).toBe(true);
      bytes.fill(0);
      expect(second.send(first.address, Uint8Array.of(8, 9))).toBe(true);
      const toSecond = await receive(second);
      const toFirst = await receive(first);
      expect(toSecond.payload).toEqual(Uint8Array.of(1, 2, 3));
      expect(toSecond.from).toEqual(first.address);
      expect(toFirst.payload).toEqual(Uint8Array.of(8, 9));
      expect(toFirst.from).toEqual(second.address);
      expect([toFirst.receivedAt, toSecond.receivedAt].sort()).toEqual([100, 101]);
      expect(first.poll()).toBeNull();
      expect(second.poll()).toBeNull();
      expect(first.statistics.received).toBe(1);
      expect(second.statistics.received).toBe(1);
    } finally { first.close(); second.close(); }
  });

  test("delivers native zero-length UDP packets", async () => {
    const first = await UdpTransport.bind({ host: localhost, port: 0 });
    const second = await UdpTransport.bind({ host: localhost, port: 0 });
    try {
      expect(first.send(second.address, new Uint8Array())).toBe(true);
      const packet = await receive(second);
      expect(packet.payload.length).toBe(0);
      expect(packet.from).toEqual(first.address);
      expect(second.poll()).toBeNull();
    } finally { first.close(); second.close(); }
  });

  test("accepts 1400 and 16383 bytes, rejects oversized sends and drops oversized native input", async () => {
    const transport = await UdpTransport.bind({ host: localhost, port: 0 });
    const peer = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      for (const size of [1400, MAX_DATAGRAM_LENGTH]) {
        const bytes = new Uint8Array(size).fill(size & 255);
        expect(peer.send(bytes, transport.address.port, "127.0.0.1")).toBe(true);
        expect((await receive(transport)).payload).toEqual(bytes);
      }
      expect(MAX_DATAGRAM_LENGTH).toBe(16383);
      expect(() => transport.send(transport.address, new Uint8Array(16384))).toThrow("source receive limit");
      for (const size of [16384, 16385, 65507]) {
        expect(peer.send(new Uint8Array(size), transport.address.port, "127.0.0.1")).toBe(true);
      }
      await waitUntil(() => transport.statistics.oversizeDropped === 3);
      expect(transport.statistics.received).toBe(2);
      expect(transport.poll()).toBeNull();
    } finally { transport.close(); peer.close(); }
  });

  test("UnixIo diagnoses each oversize receive only when polled, without consuming the next packet", async () => {
    const output: string[] = [];
    const input = new UnixIo(text => { output.push(text); }, new UnixSystemClock(), { signals: "none" });
    const cvars = new CvarRegistry();
    cvars.set("net_ip", "127.0.0.1"); cvars.set("net_port", "0");
    const peer = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      await input.initializeNetwork(cvars);
      const transport = input.udp;
      if (transport === null) throw new Error("Missing initialized Unix UDP transport");
      output.length = 0;
      const pending: number[] = [];
      const unsubscribe = transport.subscribeReadable(() => { pending.push(transport.statistics.pending); });
      try {
        for (const size of [16384, 16385, 65507]) {
          const dropped = transport.statistics.oversizeDropped;
          peer.send(new Uint8Array(size), transport.address.port, "127.0.0.1");
          await waitUntil(() => transport.statistics.oversizeDropped === dropped + 1);
        }
        await waitUntil(() => transport.statistics.oversizeDropped === 3);
        peer.send(Uint8Array.of(7), transport.address.port, "127.0.0.1");
        await waitUntil(() => transport.statistics.received === 1);
        expect(output).toEqual([]);
        for (let index = 0; index < 3; index++) {
          input.pollPacketEvent();
          expect(output).toEqual(Array.from({ length: index + 1 }, () => `Oversize packet from 127.0.0.1:${peer.port}\n`));
          expect(input.takeQueuedEvent()).toBeNull();
          expect(transport.statistics.pending).toBe(3 - index);
        }
        expect(pending).toEqual([1, 2, 3, 4]);
        input.pollPacketEvent();
        const event = input.takeQueuedEvent();
        if (event === null || event.kind !== "packet") throw new Error("Missing next system packet event");
        expect(event.payload).toEqual(Uint8Array.of(7));
        expect(event.from).toEqual({ kind: "ipv4", host: localhost, port: peer.port });
        expect(transport.statistics.pending).toBe(0);
        expect(output).toHaveLength(3);
      } finally { unsubscribe(); }
    } finally { input.close(); peer.close(); }
  });

  test("drops oldest packets when the dedicated 256-event queue overflows", async () => {
    const sender = await UdpTransport.bind({ host: localhost, port: 0 });
    const receiver = await UdpTransport.bind({ host: localhost, port: 0 });
    try {
      // This packet-only host queue deliberately adapts Sys_QueEvent's mixed queue.
      for (let base = 0; base < 280; base += 8) {
        for (let offset = 0; offset < 8; offset++) {
          const bytes = new Uint8Array(2);
          new DataView(bytes.buffer).setUint16(0, base + offset, true);
          expect(sender.send(receiver.address, bytes)).toBe(true);
        }
        await waitUntil(() => receiver.statistics.received === base + 8);
      }
      expect(MAX_QUEUED_DATAGRAMS).toBe(256);
      expect(receiver.statistics).toEqual({ received: 280, oversizeDropped: 0, overflowDropped: 24, errors: 0, pending: 256 });
      let previousTime = 0;
      for (let sequence = 24; sequence < 280; sequence++) {
        const packet = await receive(receiver);
        expect(new DataView(packet.payload.buffer, packet.payload.byteOffset, packet.payload.byteLength).getUint16(0, true)).toBe(sequence);
        expect(packet.receivedAt).toBeGreaterThanOrEqual(previousTime);
        previousTime = packet.receivedAt;
      }
      expect(receiver.poll()).toBeNull();
      expect(receiver.statistics.pending).toBe(0);
      expect(receiver.statistics.overflowDropped).toBe(24);
    } finally { sender.close(); receiver.close(); }
  });

  test("validates IPv4 octets, ports and ownership of supplied addresses", async () => {
    for (const host of [[127, 0, 0, 256], [127, 0, 0, -1], [127, 0, 0, 1.5], [127, 0, 0, NaN]] satisfies Ipv4Host[]) {
      await expect(UdpTransport.bind({ host, port: 0 })).rejects.toThrow("IPv4 host");
    }
    for (const port of [-1, 65536, 1.5, NaN, Infinity]) await expect(UdpTransport.bind({ host: localhost, port })).rejects.toThrow("port");
    const mutableHost: [number, number, number, number] = [127, 0, 0, 1];
    const output: string[] = [];
    const transport = await UdpTransport.bind({ host: mutableHost, port: 0, print: text => { output.push(text); } });
    mutableHost[3] = 9;
    try {
      expect(transport.address.host).toEqual(localhost);
      for (const port of [-1, 65536, NaN]) expect(() => transport.send({ kind: "ipv4", host: localhost, port }, new Uint8Array())).toThrow("port");
      expect(transport.send({ kind: "ipv4", host: localhost, port: 0 }, new Uint8Array())).toBe(false);
      expect(output).toEqual(["NET_SendPacket ERROR: EINVAL: invalid argument, send to 127.0.0.1:0\n"]);
      expect(() => transport.send({ kind: "ipv4", host: [300, 0, 0, 1], port: 12345 }, new Uint8Array())).toThrow("IPv4 host");
      expect(() => transport.send({ kind: "ipv4", host: [300, 0, 0, 1], port: 0 }, new Uint8Array())).toThrow("IPv4 host");
    } finally { transport.close(); }
    expect(() => transport.send({ kind: "ipv4", host: localhost, port: 0 }, new Uint8Array())).toThrow("closed");
  });

  test("preserves the first socket after bind failure and releases closed ports", async () => {
    const first = await UdpTransport.bind({ host: localhost, port: 0 });
    const address = first.address;
    try {
      await expect(UdpTransport.bind({ host: address.host, port: address.port })).rejects.toThrow();
      expect(first.send(first.address, Uint8Array.of(7))).toBe(true);
      expect((await receive(first)).payload).toEqual(Uint8Array.of(7));
    } finally { first.close(); first.close(); }
    const replacement = await UdpTransport.bind({ host: address.host, port: address.port });
    replacement.close();
    expect(() => first.send(address, new Uint8Array())).toThrow("closed");
    expect(() => first.poll()).toThrow("closed");
  });

  test("reports clock failures as typed events and keeps accepted receive times monotonic", async () => {
    let now = 10;
    const transport = await UdpTransport.bind({ host: localhost, port: 0, now: () => now });
    try {
      transport.send(transport.address, Uint8Array.of(1));
      expect((await receive(transport)).receivedAt).toBe(10);
      for (const badTime of [9, NaN, Infinity, -1]) {
        now = badTime;
        transport.send(transport.address, Uint8Array.of(2));
        await waitUntil(() => transport.statistics.pending === 1);
        const event = transport.poll();
        if (event === null || event.kind !== "error") throw new Error("Missing typed clock error");
        expect(event.error).toBeInstanceOf(UdpReceiveInvariantError);
        expect(event.error.message).toContain("monotonic");
      }
      now = 10;
      transport.send(transport.address, Uint8Array.of(3));
      expect((await receive(transport)).receivedAt).toBe(10);
      expect(transport.statistics.errors).toBe(4);
      expect(transport.statistics.received).toBe(2);
    } finally { transport.close(); }
  });

  test("close clears pending storage, retains counters and ignores late native callbacks", async () => {
    const sender = await UdpTransport.bind({ host: localhost, port: 0 });
    const receiver = await UdpTransport.bind({ host: localhost, port: 0 });
    try {
      sender.send(receiver.address, Uint8Array.of(1));
      await waitUntil(() => receiver.statistics.pending === 1);
      sender.send(receiver.address, Uint8Array.of(2));
      receiver.close(); receiver.close();
      const closedStatistics = receiver.statistics;
      expect(closedStatistics.received).toBe(1);
      expect(closedStatistics.pending).toBe(0);
      await Bun.sleep(10);
      expect(receiver.statistics).toEqual(closedStatistics);
      expect(() => receiver.poll()).toThrow("closed");
    } finally { sender.close(); receiver.close(); }
  });
});
