// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import type { udp } from "bun";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { MAX_DATAGRAM_LENGTH, UdpTransport } from "../src/platform/network.ts";
import type { Ipv4Address, Ipv4Host, UdpReceiveEvent } from "../src/platform/network.ts";
import { readSocksDatagram, socksDatagram } from "../src/platform/socks.ts";
import { UnixIo } from "../src/platform/unix-io.ts";

const localhost: Ipv4Host = [127, 0, 0, 1];
type ProxyMode = "noauth" | "auth" | "authfail" | "denied" | "badversion" | "badrelay" | "truncated" | "silent";

async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("Local SOCKS test timed out");
    await Bun.sleep(2);
  }
}

async function packet(transport: UdpTransport): Promise<Extract<UdpReceiveEvent, { readonly kind: "packet" }>> {
  await until(() => transport.statistics.pending > 0);
  const event = transport.poll();
  if (event?.kind !== "packet") throw new Error("Expected a UDP packet");
  return event;
}

/** Authored local TCP negotiation and UDP relay with a separate real echo peer. */
class LocalProxy {
  readonly greetings: Uint8Array[] = [];
  readonly credentials: Uint8Array[] = [];
  readonly associates: Uint8Array[] = [];
  readonly frames: Uint8Array[] = [];
  readonly sockets = new Set<Socket>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  private constructor(readonly tcp: Server, readonly relay: udp.Socket<"uint8array">,
    readonly destination: udp.Socket<"uint8array">, readonly port: number) {}

  static async open(mode: ProxyMode = "noauth"): Promise<LocalProxy> {
    let proxy: LocalProxy | null = null;
    let clientPort: number | null = null;
    const destination = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, binaryType: "uint8array",
      socket: { data(socket, bytes, port, host) { socket.send(bytes, port, host); } } });
    const relay = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, binaryType: "uint8array",
      socket: { data(socket, bytes, port) {
        if (port === destination.port) {
          if (clientPort !== null) socket.send(socksDatagram({ kind: "ipv4", host: localhost, port }, bytes), clientPort, "127.0.0.1");
          return;
        }
        proxy?.frames.push(new Uint8Array(bytes)); clientPort = port;
        const frame = readSocksDatagram(bytes);
        if (frame !== null && frame.from.host.join(".") === "127.0.0.1" && frame.from.port === destination.port) {
          socket.send(frame.payload, destination.port, "127.0.0.1");
        }
      } } });
    const tcp = createServer(socket => { proxy?.accept(socket, mode); });
    try {
      await new Promise<void>((resolve, reject) => { tcp.once("error", reject); tcp.listen(0, "127.0.0.1", resolve); });
      const address = tcp.address();
      if (address === null || typeof address === "string") throw new Error("Expected TCP port");
      proxy = new LocalProxy(tcp, relay, destination, address.port);
      return proxy;
    } catch (error) { tcp.close(); relay.close(); destination.close(); throw error; }
  }

  private reply(socket: Socket, bytes: Uint8Array): void {
    // Deliberately split each response across TCP callbacks.
    socket.write(bytes.subarray(0, 1));
    const timer = setTimeout(() => { this.timers.delete(timer); if (!socket.destroyed) socket.write(bytes.subarray(1)); }, 3);
    this.timers.add(timer);
  }

  private accept(socket: Socket, mode: ProxyMode): void {
    this.sockets.add(socket);
    socket.on("close", () => { this.sockets.delete(socket); });
    socket.on("error", () => { socket.destroy(); });
    let bytes = new Uint8Array(0), stage: "greeting" | "auth" | "associate" | "ready" = "greeting";
    socket.on("data", (chunk: Uint8Array) => {
      const joined = new Uint8Array(bytes.length + chunk.length);
      joined.set(bytes); joined.set(chunk, bytes.length); bytes = joined;
      if (stage === "greeting") {
        const count = bytes[1];
        if (count === undefined || bytes.length < 2 + count) return;
        this.greetings.push(bytes.slice(0, 2 + count)); bytes = bytes.slice(2 + count);
        if (mode === "silent") return;
        if (mode === "truncated") { socket.end(Uint8Array.of(5)); return; }
        if (mode === "denied" || mode === "badversion") { socket.end(Uint8Array.of(mode === "badversion" ? 4 : 5, 255)); return; }
        const auth = mode === "auth" || mode === "authfail";
        stage = auth ? "auth" : "associate";
        this.reply(socket, Uint8Array.of(5, auth ? 2 : 0));
      }
      if (stage === "auth") {
        const usernameLength = bytes[1];
        if (usernameLength === undefined) return;
        const passwordLength = bytes[2 + usernameLength];
        if (passwordLength === undefined || bytes.length < 3 + usernameLength + passwordLength) return;
        const length = 3 + usernameLength + passwordLength;
        this.credentials.push(bytes.slice(0, length)); bytes = bytes.slice(length);
        stage = "associate";
        this.reply(socket, Uint8Array.of(1, mode === "authfail" ? 1 : 0));
      }
      if (stage === "associate" && bytes.length >= 10) {
        this.associates.push(bytes.slice(0, 10)); bytes = bytes.slice(10); stage = "ready";
        this.reply(socket, Uint8Array.of(5, 0, 0, mode === "badrelay" ? 3 : 1, 127, 0, 0, 1, this.relay.port >>> 8, this.relay.port & 255));
      }
    });
  }

  get target(): Ipv4Address { return { kind: "ipv4", host: localhost, port: this.destination.port }; }
  get options(): { server: string; port: number; username: string; password: string } {
    return { server: "127.0.0.1", port: this.port, username: "", password: "" };
  }
  async close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    for (const socket of this.sockets) socket.destroy();
    this.relay.close(); this.destination.close();
    await new Promise<void>((resolve, reject) => { this.tcp.close(error => { if (error) reject(error); else resolve(); }); });
  }
}

test("SOCKS no-auth association forwards real UDP and preserves decoded sender, bytes and receive clock", async () => {
  const proxy = await LocalProxy.open();
  const transport = await UdpTransport.bind({ host: localhost, port: 0, now: () => 42, print: () => undefined });
  try {
    await transport.connectSocks(proxy.options);
    expect(proxy.greetings).toEqual([Uint8Array.of(5, 1, 0)]);
    expect(proxy.associates).toEqual([Uint8Array.of(5, 3, 0, 1, 0, 0, 0, 0, transport.address.port >>> 8, transport.address.port & 255)]);
    const bytes = Uint8Array.of(255, 255, 255, 255, 115, 116, 97, 116, 117, 115, 10);
    transport.send(proxy.target, bytes);
    const reply = await packet(transport);
    expect(reply.payload).toEqual(bytes); expect(reply.from).toEqual(proxy.target); expect(reply.receivedAt).toBe(42);
    expect(proxy.frames).toEqual([Uint8Array.of(0, 0, 0, 1, 127, 0, 0, 1, proxy.target.port >>> 8, proxy.target.port & 255, ...bytes)]);
    transport.close(); await until(() => proxy.sockets.size === 0);
  } finally { transport.close(); await proxy.close(); }
});

test("SOCKS repairs the authenticated greeting and exchanges exact source credential bytes", async () => {
  const proxy = await LocalProxy.open("auth");
  const transport = await UdpTransport.bind({ host: localhost, port: 0, print: () => undefined });
  try {
    await transport.connectSocks({ ...proxy.options, username: "user", password: "p\u00e4ss" });
    expect(proxy.greetings).toEqual([Uint8Array.of(5, 2, 0, 2)]);
    expect(proxy.credentials).toEqual([Uint8Array.of(1, 4, 117, 115, 101, 114, 4, 112, 228, 115, 115)]);
    transport.send(proxy.target, Uint8Array.of(7)); expect((await packet(transport)).payload).toEqual(Uint8Array.of(7));
  } finally { transport.close(); await proxy.close(); }
});

test("SOCKS malformed, truncated, denied and failed-auth handshakes close TCP and retain direct UDP", async () => {
  const modes: readonly ProxyMode[] = ["denied", "badversion", "badrelay", "truncated", "authfail"];
  for (const mode of modes) {
    const proxy = await LocalProxy.open(mode), logs: string[] = [];
    const transport = await UdpTransport.bind({ host: localhost, port: 0, print: text => { logs.push(text); } });
    try {
      await transport.connectSocks({ ...proxy.options, username: "private-user", password: "private-password" });
      await until(() => proxy.sockets.size === 0);
      transport.send(proxy.target, Uint8Array.of(8)); expect((await packet(transport)).payload).toEqual(Uint8Array.of(8));
      expect(proxy.frames).toHaveLength(0); expect(logs.join("")).toContain("NET_OpenSocks:");
      expect(logs.join("")).not.toContain("private-user"); expect(logs.join("")).not.toContain("private-password");
    } finally { transport.close(); await proxy.close(); }
  }
});

test("SOCKS preserves a source empty credential field and rejects unrepresentable lengths without disclosure", async () => {
  const proxy = await LocalProxy.open("auth"), logs: string[] = [];
  const transport = await UdpTransport.bind({ host: localhost, port: 0, print: text => { logs.push(text); } });
  try {
    await transport.connectSocks({ ...proxy.options, username: "", password: "p" });
    expect(proxy.credentials).toEqual([Uint8Array.of(1, 0, 1, 112)]);
    transport.send(proxy.target, Uint8Array.of(2)); expect((await packet(transport)).payload).toEqual(Uint8Array.of(2));
    await transport.connectSocks({ ...proxy.options, username: "x".repeat(256), password: "p" });
    await until(() => proxy.sockets.size === 0);
    expect(proxy.greetings).toHaveLength(1); expect(logs.join("")).not.toContain("x".repeat(256));
    transport.send(proxy.target, Uint8Array.of(3)); expect((await packet(transport)).payload).toEqual(Uint8Array.of(3));
    expect(proxy.frames).toHaveLength(1);
  } finally { transport.close(); await proxy.close(); }
});

test("closing the proxy control connection ends its association before further UDP sends", async () => {
  const proxy = await LocalProxy.open();
  const transport = await UdpTransport.bind({ host: localhost, port: 0, print: () => undefined });
  try {
    await transport.connectSocks(proxy.options);
    for (const socket of proxy.sockets) socket.end();
    await until(() => proxy.sockets.size === 0);
    transport.send(proxy.target, Uint8Array.of(6)); expect((await packet(transport)).payload).toEqual(Uint8Array.of(6));
    expect(proxy.frames).toHaveLength(0);
  } finally { transport.close(); await proxy.close(); }
});

test("SOCKS relay filters invalid framing and keeps direct senders unwrapped", async () => {
  const proxy = await LocalProxy.open(), logs: string[] = [];
  const transport = await UdpTransport.bind({ host: localhost, port: 0, print: text => { logs.push(text); } });
  const direct = await UdpTransport.bind({ host: localhost, port: 0, print: () => undefined });
  try {
    await transport.connectSocks(proxy.options);
    const valid = socksDatagram(proxy.target, Uint8Array.of(9));
    const malformed = [valid.slice(0, 9), Uint8Array.of(1, ...valid.subarray(1)), Uint8Array.of(0, 1, ...valid.subarray(2)),
      Uint8Array.of(0, 0, 1, ...valid.subarray(3)), Uint8Array.of(0, 0, 0, 3, ...valid.subarray(4))];
    for (const bytes of malformed) {
      proxy.relay.send(bytes, transport.address.port, "127.0.0.1"); await until(() => transport.statistics.pending > 0);
      expect(transport.poll()).toBeNull();
    }
    direct.send(transport.address, valid);
    const unwrapped = await packet(transport); expect(unwrapped.from).toEqual(direct.address); expect(unwrapped.payload).toEqual(valid);
    proxy.relay.send(socksDatagram(proxy.target, new Uint8Array(MAX_DATAGRAM_LENGTH - 10)), transport.address.port, "127.0.0.1");
    expect((await packet(transport)).payload.length).toBe(MAX_DATAGRAM_LENGTH - 10);
    proxy.relay.send(socksDatagram(proxy.target, new Uint8Array(MAX_DATAGRAM_LENGTH - 9)), transport.address.port, "127.0.0.1");
    await until(() => transport.statistics.pending > 0); expect(transport.poll()).toBeNull(); expect(transport.statistics.oversizeDropped).toBe(1);
    expect(logs.at(-1)).toBe(`Oversize packet from 127.0.0.1:${proxy.target.port}\n`);
  } finally { direct.close(); transport.close(); await proxy.close(); }
});

test("UnixIo SOCKS cvars latch through restart, retire old sockets and deliver real system packet events", async () => {
  const proxy = await LocalProxy.open(), cvars = new CvarRegistry();
  const io = new UnixIo(() => undefined, { milliseconds: () => 123 }, { signals: "none" });
  cvars.set("net_ip", "127.0.0.1"); cvars.set("net_port", "0"); cvars.set("net_socksServer", "127.0.0.1");
  cvars.set("net_socksPort", String(proxy.port)); cvars.set("net_socksEnabled", "1");
  try {
    await io.initializeNetwork(cvars);
    const first = io.udp;
    if (first === null) throw new Error("Missing initialized UDP");
    expect(cvars.get("net_socksPassword")?.flags).toBe(CvarFlag.Archive | CvarFlag.Latch);
    first.send(proxy.target, Uint8Array.of(3)); await until(() => first.statistics.pending > 0);
    io.pollPacketEvent(); expect(io.takeQueuedEvent()).toEqual({ kind: "packet", time: 123, from: proxy.target, payload: Uint8Array.of(3) });
    proxy.relay.send(Uint8Array.of(0, 0, 0, 1, 127, 0, 0, 1, 0, 0, 99), first.address.port, "127.0.0.1");
    await until(() => first.statistics.pending > 0);
    io.pollPacketEvent();
    expect(io.takeQueuedEvent()).toEqual({ kind: "packet", time: 123,
      from: { kind: "ipv4", host: localhost, port: 0 }, payload: Uint8Array.of(99) });
    cvars.set("net_socksEnabled", "0"); expect(cvars.get("net_socksEnabled")?.value).toBe("1");
    await io.restartNetwork(cvars); await until(() => proxy.sockets.size === 0);
    expect(() => first.send(proxy.target, new Uint8Array())).toThrow("closed");
    const second = io.udp; if (second === null) throw new Error("Missing restarted UDP");
    second.send(proxy.target, Uint8Array.of(4)); expect((await packet(second)).payload).toEqual(Uint8Array.of(4));
    expect(proxy.frames).toHaveLength(1);
    cvars.set("net_socksEnabled", "1"); await io.restartNetwork(cvars);
    expect(proxy.associates).toHaveLength(2); io.close(); await until(() => proxy.sockets.size === 0);
  } finally { io.close(); await proxy.close(); }
});

test("closing UnixIo cancels pending SOCKS negotiation without a late socket publication", async () => {
  const proxy = await LocalProxy.open("silent"), cvars = new CvarRegistry();
  const io = new UnixIo(() => undefined, { milliseconds: () => 0 }, { signals: "none" });
  cvars.set("net_ip", "127.0.0.1"); cvars.set("net_port", "0"); cvars.set("net_socksEnabled", "1");
  cvars.set("net_socksServer", "127.0.0.1"); cvars.set("net_socksPort", String(proxy.port));
  try {
    const initializing = io.initializeNetwork(cvars).then(() => null, (error: unknown) => error);
    await until(() => proxy.greetings.length === 1); io.close();
    const error = await initializing;
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) expect(error.message).toContain("closed");
    await until(() => proxy.sockets.size === 0); expect(io.udp).toBeNull();
  } finally { io.close(); await proxy.close(); }
});
