import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CommandBuffer } from "../src/core/commands.ts";
import { CommonError } from "../src/core/common-error.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { infoValueForKey } from "../src/core/info-string.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { ClientAdmission } from "../src/engine/client-admission.ts";
import { ClientAuthorization } from "../src/engine/client-authorization.ts";
import { CommonCdKeyState } from "../src/engine/cd-key.ts";
import { ClientConnectionState, ClientStaticState } from "../src/engine/client-state.ts";
import type { ClientPacketAddress } from "../src/engine/client-state.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { ServerBrowser, ServerBrowserSource } from "../src/engine/server-browser.ts";
import { ServerEngine } from "../src/engine/server-engine.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import type { Ipv4Address } from "../src/platform/network.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { decodeConnectionless, encodeConnectionlessText } from "../src/protocol/connectionless.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) { try { await close(); } catch (error) { errors.push(error); } }
  if (errors.length > 0) throw new AggregateError(errors, "Browser test cleanup");
});

async function network(): Promise<UnixIo> {
  const stdin = new PassThrough(), cvars = new CvarRegistry();
  cvars.register("net_ip", "127.0.0.1"); cvars.register("net_port", "0");
  const io = new UnixIo(() => undefined, new UnixSystemClock(), { stdin, signals: "none" });
  cleanup.push(() => { try { io.close(); } finally { stdin.destroy(); } });
  await io.initializeNetwork(cvars);
  return io;
}
function udp(io: UnixIo) {
  const socket = io.udp;
  if (socket === null) throw new Error("Missing actual UDP socket");
  return socket;
}
function textAddress(address: Ipv4Address): string { return `${address.host.join(".")}:${address.port}`; }
async function packet(io: UnixIo) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    io.pollPacketEvent();
    const event = io.takeQueuedEvent();
    if (event !== null) {
      if (event.kind !== "packet") throw new Error("Expected actual UDP packet event");
      return event;
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for localhost UDP packet");
}
async function fixture(onPrint: (text: string) => void = () => undefined) {
  const io = await network(), cvars = new CvarRegistry(), cls = new ClientStaticState(), clc = new ClientConnectionState();
  const loopback = new LoopbackTransport(), prints: string[] = [];
  let current = true;
  const assertCurrentOperation = () => { if (!current) throw new Error("Browser fixture operation ended"); };
  const print = (text: string) => { prints.push(text); onPrint(text); };
  cvars.register("developer", "0"); cvars.register("showpackets", "0"); cvars.register("cl_maxPing", "800");
  cvars.register("cl_serverStatusResendTime", "750");
  let statusTime = 0, statusClockReads = 0;
  const statusClock = new CommonEvents({ getEvent: () => { statusClockReads++; return { kind: "none", time: statusTime }; } }, () => undefined);
  const browser = new ServerBrowser({ io, cvars, clientStatic: cls, loopback, assertCurrentOperation, print });
  const authorization = new ClientAuthorization({ cvars, cdKey: new CommonCdKeyState(cvars, "client"), io, print });
  const admission = new ClientAdmission({ io, cvars, clientStatic: cls, clientConnection: clc, loopback, authorization, assertCurrentOperation, print });
  const commands = new CommandBuffer();
  commands.register("localservers", () => { browser.localServers(); });
  commands.registerAsync("globalservers", context => browser.globalServersCommand(context));
  commands.registerAsync("ping", context => browser.pingCommand(context));
  commands.registerAsync("serverstatus", context => browser.serverStatusCommand(context, clc));
  const command = async (text: string) => { commands.append(`${text}\n`); await commands.executeAsync(); };
  const receive = (from: ClientPacketAddress, bytes: Uint8Array) => {
    const result = admission.packetEvent(from, bytes);
    if (result.kind !== "connectionless") throw new Error("Expected admission's actual unhandled packet");
    if (result.packet.command.toLowerCase() === "statusresponse") {
      browser.serverStatusResponse(from, result.packet.payload, statusClock); return true;
    }
    return browser.handleConnectionless(from, result.packet, bytes);
  };
  return { io, cvars, cls, clc, loopback, browser, prints, command, receive, statusClock,
    setStatusTime(value: number): void { statusTime = value; }, statusReads: () => statusClockReads,
    close: () => { current = false; } };
}

function infoPacket(info: string, extra = ""): Uint8Array {
  return new Uint8Array([...encodeConnectionlessText("infoResponse\n"), ...Buffer.from(info, "latin1"), 0, ...Buffer.from(extra, "latin1")]);
}

test("LAN comparison reads raw reached bytes and numeric fields without decoding cached addresses", async () => {
  const f = await fixture(), disk = await cacheFiles(f), source = ServerBrowserSource.Global;
  f.browser.saveServersToCache(disk.common.files);
  const bytes = readFileSync(disk.path), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Count stays zero: LAN_GetServerPtr is capacity-bounded. Unsupported addresses stay opaque.
  view.setInt32(16, 5, true); view.setInt32(168, 5, true);
  bytes.fill(65, 36, 68); bytes.fill(66, 188, 220);
  bytes[68] = 120; bytes[69] = 0; bytes[220] = 89; bytes[221] = 0;
  for (const [offset, left, right] of [[124, -2, 3], [120, 7, 4], [140, 0, -1]]) {
    if (offset === undefined || left === undefined || right === undefined) throw new Error("Missing comparison fixture field");
    view.setInt32(16 + offset, left, true); view.setInt32(168 + offset, right, true);
  }
  writeFileSync(disk.path, bytes); f.browser.loadCachedServers(disk.common.files);
  expect(f.browser.compareServers(source, 0, 0, 0, 1)).toBe(-1);
  expect(f.browser.compareServers(source, 1, 0, 0, 1)).toBe(-1);
  expect(f.browser.compareServers(source, 2, 0, 0, 1)).toBe(-1);
  expect(f.browser.compareServers(source, 3, 0, 0, 1)).toBe(1);
  expect(f.browser.compareServers(source, 4, 2, 0, 1)).toBe(-1);
  expect(f.browser.compareServers(source, 99, 0, 0, 1)).toBe(0);
  expect(f.browser.compareServers(source, 0, 0, -1, 1)).toBe(0);
  expect(f.browser.compareServers(source, 0, 0, 4096, 1)).toBe(0);
  const unknownSource: number = 99;
  expect(f.browser.compareServers(unknownSource, 0, 0, 0, 1)).toBe(0);
  bytes[36] = 0xff; bytes[188] = 65;
  writeFileSync(disk.path, bytes); f.browser.loadCachedServers(disk.common.files);
  expect(f.browser.compareServers(source, 0, 0, 0, 1)).toBe(-1);
  bytes.fill(65, 36, 168); bytes.fill(65, 188, 320);
  writeFileSync(disk.path, bytes); f.browser.loadCachedServers(disk.common.files);
  expect(() => f.browser.compareServers(source, 0, 0, 0, 1)).toThrow();
});
function masterPacket(addresses: readonly Ipv4Address[]): Uint8Array {
  const bytes = [...encodeConnectionlessText("getserversResponse")];
  for (const address of addresses) bytes.push(92, ...address.host, address.port >>> 8, address.port & 255);
  bytes.push(92, 69, 79, 84);
  return new Uint8Array(bytes);
}
async function masterQuery(f: Awaited<ReturnType<typeof fixture>>, destination: UnixIo, command = "globalservers 0 68 empty full") {
  const resolve = f.io.resolveAddress.bind(f.io), socket = udp(f.io), send = socket.send.bind(socket);
  f.io.resolveAddress = async (host, port) => {
    expect(host).toBe("master.quake3arena.com"); expect(port).toBe(27950);
    return udp(destination).address; // Test-only DNS boundary; every emitted byte still crosses actual localhost UDP.
  };
  socket.send = (to, bytes) => {
    expect(to).toEqual({ ...udp(destination).address, port: 27950 });
    return send(udp(destination).address, bytes);
  };
  try { await f.command(command); }
  finally { f.io.resolveAddress = resolve; socket.send = send; }
  return packet(destination);
}

test("source capacity records and retained tail survive add, duplicate, remove and reset", async () => {
  const f = await fixture(), address = udp(f.io).address, source = ServerBrowserSource.Favorites;
  expect(f.browser.getServerCount(source)).toBe(0);
  expect(f.browser.getServerAddressString(source, 127, 64)).toBe("bot");
  expect(f.browser.getServerAddressString(source, 128, 64)).toBe("");
  expect(f.browser.getServerPing(source, 127)).toBe(0); expect(f.browser.getServerPing(source, 128)).toBe(-1);
  expect(await f.browser.addServer(source, "x".repeat(40), textAddress(address))).toBe(1);
  expect(await f.browser.addServer(source, "Duplicate", textAddress(address))).toBe(0);
  expect(infoValueForKey(f.browser.getServerInfo(source, 0, 1024), "hostname")).toBe("x".repeat(31));
  expect(f.browser.serverIsVisible(source, 0)).toBe(true);
  const next = { ...address, port: address.port === 65535 ? 65534 : address.port + 1 };
  expect(await f.browser.addServer(source, "Second", textAddress(next))).toBe(1);
  await f.browser.removeServer(source, textAddress(address));
  expect(f.browser.getServerCount(source)).toBe(1);
  expect(f.browser.getServerAddressString(source, 0, 64)).toBe(textAddress(next));
  expect(f.browser.getServerInfo(source, 1, 1024)).toBe(f.browser.getServerInfo(source, 0, 1024));
  f.browser.resetPings(source); expect(f.browser.getServerPing(source, 127)).toBe(-1);
  f.browser.markServerVisible(source, -1, true); expect(f.browser.serverIsVisible(source, 127)).toBe(true);
  f.browser.markServerVisible(source, 0, false); expect(f.browser.serverIsVisible(source, 0)).toBe(false);
  expect(f.browser.getServerAddressString(source, 0, 4)).toBe("127");
  await expect(f.browser.addServer(source, "Bad", "999.1.1.1")).rejects.toThrow("undefined native address");
});

test("128-row list rejects an addition before duplicate lookup or address resolution when full", async () => {
  const f = await fixture();
  for (let index = 0; index < 128; index++) {
    expect(await f.browser.addServer(ServerBrowserSource.Favorites, String(index), `127.0.0.1:${10000 + index}`)).toBe(1);
  }
  expect(f.browser.getServerCount(ServerBrowserSource.Favorites)).toBe(128);
  expect(await f.browser.addServer(ServerBrowserSource.Favorites, "Duplicate", "127.0.0.1:10000")).toBe(-1);
  expect(await f.browser.addServer(ServerBrowserSource.Favorites, "Not resolved", "999.1.1.1")).toBe(-1);
  expect(f.browser.getServerAddressString(ServerBrowserSource.Favorites, 127, 64)).toBe("127.0.0.1:10127");
});

test("local scan emits both passes on four source ports, preserves visibility and consumes actual infoResponse", async () => {
  const f = await fixture(), destination = await network(), socket = udp(f.io), send = socket.send.bind(socket);
  const addresses: Ipv4Address[] = [];
  f.browser.markServerVisible(ServerBrowserSource.Local, -1, true);
  f.cvars.set("showpackets", "1");
  socket.send = (to, bytes) => {
    addresses.push(to);
    expect(decodeConnectionless(bytes, "server").line).toBe("getinfo xxx");
    return send(udp(destination).address, bytes); // Observe broadcast intent; never broadcast onto an actual LAN in tests.
  };
  try { await f.command("localservers"); }
  finally { socket.send = send; }
  expect(addresses.map(address => address.port)).toEqual([27960, 27961, 27962, 27963, 27960, 27961, 27962, 27963]);
  expect(addresses.every(address => address.host.every(octet => octet === 255))).toBe(true);
  expect(f.prints.filter(text => text === "send packet   15\n")).toHaveLength(16); // Includes unopened Unix IPX sends.
  for (let count = 0; count < 8; count++) expect((await packet(destination)).payload).toEqual(encodeConnectionlessText("getinfo xxx"));
  expect(f.browser.getServerCount(ServerBrowserSource.Local)).toBe(0);
  expect(f.browser.serverIsVisible(ServerBrowserSource.Local, 127)).toBe(true);
  const from = udp(destination).address;
  f.cls.realtime = 73;
  expect(f.receive(from, infoPacket("\\protocol\\68\\hostname\\Not copied yet", "greeting %\xff"))).toBe(true);
  expect(f.clc.lastPacketTime).toBe(73);
  expect(f.browser.getServerCount(ServerBrowserSource.Local)).toBe(1);
  const info = f.browser.getServerInfo(ServerBrowserSource.Local, 0, 1024);
  expect(infoValueForKey(info, "hostname")).toBe(""); expect(infoValueForKey(info, "nettype")).toBe("4");
  expect(infoValueForKey(info, "ping")).toBe("-1");
  expect(f.prints.at(-1)).toBe(`${textAddress(from)}: greeting ..\n`);
  f.receive(from, infoPacket("\\protocol\\68"));
  expect(f.browser.getServerCount(ServerBrowserSource.Local)).toBe(1);
});

test("source ping time has +1, getPing applies nettype later, and all lists share address updates", async () => {
  const f = await fixture(), destination = await network(), address = udp(destination).address;
  for (const source of [ServerBrowserSource.Local, ServerBrowserSource.Mplayer, ServerBrowserSource.Global, ServerBrowserSource.Favorites]) {
    await f.browser.addServer(source, "Before", textAddress(address));
  }
  f.cls.realtime = 100; await f.command(`ping ${textAddress(address)}`);
  const request = await packet(destination);
  expect(decodeConnectionless(request.payload, "server").line).toBe("getinfo xxx");
  expect(f.browser.getPingQueueCount()).toBe(1);
  f.cls.realtime = 106;
  udp(destination).send(request.from, infoPacket("\\protocol\\68\\hostname\\A %\xff\\mapname\\q3dm1\\clients\\3\\sv_maxclients\\8\\gametype\\4\\minping\\12\\maxping\\90\\punkbuster\\1"));
  const reply = await packet(f.io); f.receive(reply.from, reply.payload);
  expect(f.browser.getServerPing(ServerBrowserSource.Favorites, 0)).toBe(7);
  expect(infoValueForKey(f.browser.getServerInfo(ServerBrowserSource.Favorites, 0, 1024), "nettype")).toBe("0");
  expect(f.browser.getPing(0, 64)).toEqual({ address: textAddress(address), time: 7 });
  for (const source of [ServerBrowserSource.Local, ServerBrowserSource.Mplayer, ServerBrowserSource.Global, ServerBrowserSource.Favorites]) {
    const info = f.browser.getServerInfo(source, 0, 1024);
    expect(infoValueForKey(info, "hostname")).toBe("A ..");
    expect(infoValueForKey(info, "nettype")).toBe("1"); expect(infoValueForKey(info, "clients")).toBe("3");
    expect(infoValueForKey(info, "punkbuster")).toBe("1");
  }
  expect(infoValueForKey(f.browser.getPingInfo(0, 1024), "nettype")).toBe("1");
});

test("timeout floor, port-only clear and stale info survive source slot reuse", async () => {
  const f = await fixture(), first = await network(), second = await network();
  f.cvars.set("cl_maxPing", "1"); f.cls.realtime = 100;
  await f.command(`ping ${textAddress(udp(first).address)}`); await packet(first);
  f.cls.realtime = 105; f.receive(udp(first).address, infoPacket("\\protocol\\68\\hostname\\Old Info"));
  f.browser.clearPing(0); expect(f.browser.getPingQueueCount()).toBe(0);
  expect(f.browser.getPing(0, 64)).toEqual({ address: "", time: 0 }); expect(f.browser.getPingInfo(0, 0)).toBe("");
  await f.browser.addServer(ServerBrowserSource.Favorites, "New Name", textAddress(udp(second).address));
  f.cls.realtime = 200; await f.command(`ping ${textAddress(udp(second).address)}`); await packet(second);
  expect(infoValueForKey(f.browser.getPingInfo(0, 1024), "hostname")).toBe("Old Info");
  f.cls.realtime = 299; expect(f.browser.getPing(0, 64).time).toBe(0);
  f.cls.realtime = 300; expect(f.browser.getPing(0, 64).time).toBe(100);
  expect(f.browser.getServerPing(ServerBrowserSource.Favorites, 0)).toBe(0);
  expect(infoValueForKey(f.browser.getServerInfo(ServerBrowserSource.Favorites, 0, 1024), "hostname")).toBe("Old Info");
  f.browser.clearPing(-1); f.browser.clearPing(32); expect(f.browser.getPingQueueCount()).toBe(1);
  expect(() => f.browser.getPing(-1, 64)).toThrow(RangeError);
});

test("32 slots use oldest replacement and the separate 500ms allocation policy", async () => {
  const f = await fixture(), destination = await network(), address = textAddress(udp(destination).address);
  f.cvars.set("cl_maxPing", "100");
  for (let index = 0; index < 32; index++) { f.cls.realtime = index; await f.command(`ping ${address}`); await packet(destination); }
  expect(f.browser.getPingQueueCount()).toBe(32);
  f.cls.realtime = 32; await f.command(`ping ${address}`); await packet(destination);
  f.cls.realtime = 132;
  expect(f.browser.getPing(0, 64).time).toBe(100); expect(f.browser.getPing(1, 64).time).toBe(131);
  f.receive(udp(destination).address, infoPacket("\\protocol\\68")); // First matching slot completes with time101, and is retained below500.
  f.cls.realtime = 501; await f.command(`ping ${address}`); await packet(destination);
  f.cls.realtime = 601;
  expect(f.browser.getPing(0, 64).time).toBe(101); expect(f.browser.getPing(1, 64).time).toBe(100);
});

test("global query source clocks/list wait state and binary response retain duplicate and byte ordering", async () => {
  const f = await fixture(), destination = await network();
  f.cvars.register("fs_restrict", "1");
  const request = await masterQuery(f, destination);
  expect(decodeConnectionless(request.payload, "server").line).toBe("getservers 68 empty full demo");
  expect(f.browser.getServerCount(ServerBrowserSource.Global)).toBe(-1);
  const address = udp(destination).address;
  const raw = masterPacket([address, address, { kind: "ipv4", host: [10, 0, 128, 255], port: 0x1234 }]);
  expect(f.receive(address, raw)).toBe(true);
  expect(f.browser.getServerCount(ServerBrowserSource.Global)).toBe(3);
  expect(f.browser.getServerAddressString(ServerBrowserSource.Global, 1, 64)).toBe(textAddress(address));
  expect(f.browser.getServerAddressString(ServerBrowserSource.Global, 2, 64)).toBe("10.0.128.255:4660");
  expect(f.browser.getServerPing(ServerBrowserSource.Global, 0)).toBe(-1);
  expect(f.prints.at(-1)).toBe("3 servers parsed (total 3)\n");
  const status = encodeConnectionlessText("statusResponse\nunfinished");
  expect(f.browser.handleConnectionless(address, decodeConnectionless(status, "client"), status)).toBe(false);
  const second = await masterQuery(f, destination, "globalservers 2 68 %%");
  expect(decodeConnectionless(second.payload, "server").line).toBe("getservers 68 . demo"); // Decoder sanitizes the sent percent.
  expect(Buffer.from(second.payload.subarray(4)).toString("latin1")).toBe("getservers 68 % demo");
  f.receive(address, masterPacket([address]));
  expect(f.browser.getServerCount(ServerBrowserSource.Global)).toBe(0);
  expect(f.browser.getServerCount(ServerBrowserSource.Mplayer)).toBe(1); // masterNum !=0, although command2 reset the global list.
});

test("master packet cap, malformed tails, fixed capacities and global overflow replacement", async () => {
  const f = await fixture(), destination = await network(), address = udp(destination).address;
  const many = Array.from({ length: 257 }, () => address);
  const raw = masterPacket(many);
  f.receive(address, raw);
  expect(f.browser.getServerCount(ServerBrowserSource.Global)).toBe(256);
  for (let batch = 1; batch < 16; batch++) f.receive(address, raw);
  expect(f.browser.getServerCount(ServerBrowserSource.Global)).toBe(4096);
  const extra = { ...address, port: address.port === 65535 ? 65534 : address.port + 1 };
  f.receive(address, masterPacket([address, extra]));
  expect(f.prints.at(-1)).toBe("2 servers parsed (total 4098)\n");
  f.cls.realtime = 100; await f.command(`ping ${textAddress(address)}`); await packet(destination);
  f.cls.realtime = 105; f.receive(address, infoPacket("\\protocol\\68\\punkbuster\\9"));
  f.browser.clearPing(0); await f.command(`ping ${textAddress(address)}`); await packet(destination);
  f.browser.markServerVisible(ServerBrowserSource.Global, 0, true);
  expect(f.browser.updateVisiblePings(ServerBrowserSource.Global)).toBe(true);
  expect(f.browser.getServerAddressString(ServerBrowserSource.Global, 0, 64)).toBe(textAddress(extra));
  expect(f.browser.serverIsVisible(ServerBrowserSource.Global, 0)).toBe(true);
  expect(infoValueForKey(f.browser.getServerInfo(ServerBrowserSource.Global, 0, 1024), "punkbuster")).toBe("9");
  expect(f.browser.getServerPing(ServerBrowserSource.Global, 0)).toBe(-1);
  const g = await fixture();
  for (let size = 22; size < 29; size++) g.receive(address, masterPacket([address]).slice(0, size));
  expect(g.browser.getServerCount(ServerBrowserSource.Global)).toBe(0);
  const broken = masterPacket([address]); broken[29] = 33;
  g.receive(address, broken); expect(g.browser.getServerCount(ServerBrowserSource.Global)).toBe(0);
  for (const size of [30, 31, 32]) {
    expect(() => g.receive(address, masterPacket([address]).slice(0, size))).toThrow(RangeError);
    expect(g.browser.getServerCount(ServerBrowserSource.Global)).toBe(0);
  }
});

test("visible pings queue each address once, time out to zero and clear the source slot", async () => {
  const f = await fixture(), destination = await network(), address = udp(destination).address;
  await f.browser.addServer(ServerBrowserSource.Favorites, "Visible", textAddress(address));
  f.browser.resetPings(ServerBrowserSource.Favorites); f.cls.realtime = 50;
  expect(f.browser.updateVisiblePings(ServerBrowserSource.Favorites)).toBe(true);
  expect(decodeConnectionless((await packet(destination)).payload, "server").line).toBe("getinfo xxx");
  expect(f.browser.getPingQueueCount()).toBe(1);
  expect(f.browser.updateVisiblePings(ServerBrowserSource.Favorites)).toBe(true);
  expect(f.browser.getPingQueueCount()).toBe(1);
  f.cls.realtime = 850;
  expect(f.browser.updateVisiblePings(ServerBrowserSource.Favorites)).toBe(true);
  expect(f.browser.getPingQueueCount()).toBe(0);
  expect(f.browser.getServerPing(ServerBrowserSource.Favorites, 0)).toBe(0);
  expect(f.browser.updateVisiblePings(ServerBrowserSource.Favorites)).toBe(false);
});

test("overflow-address overrun rejects at the reached source bound and a full overflow list ignores further addresses", async () => {
  const f = await fixture(), address = udp(f.io).address, full = masterPacket(Array.from({ length: 256 }, () => address));
  for (let batch = 0; batch < 31; batch++) f.receive(address, full); // 4096 main records plus3840 overflow rows.
  f.receive(address, masterPacket(Array.from({ length: 255 }, () => address)));
  expect(f.prints.at(-1)).toBe("255 servers parsed (total 8191)\n");
  expect(() => f.receive(address, masterPacket([address, address]))).toThrow("overrun its source overflow-address array");
  expect(f.browser.getServerCount(ServerBrowserSource.Global)).toBe(4096);
  f.receive(address, masterPacket([address]));
  expect(f.prints.at(-1)).toBe("1 servers parsed (total 8192)\n");
});

test("source localhost ping sends real loopback but its port-zero slot stays inactive", async () => {
  const f = await fixture();
  await f.command("ping localhost");
  const request = f.loopback.poll("server");
  if (request === null) throw new Error("Missing actual loopback ping");
  expect(decodeConnectionless(request.payload, "server").line).toBe("getinfo xxx");
  expect(f.browser.getPingQueueCount()).toBe(0); expect(f.browser.getPing(0, 64)).toEqual({ address: "", time: 0 });
  f.loopback.send("server", infoPacket("\\protocol\\68\\hostname\\Local"));
  const response = f.loopback.poll("client");
  if (response === null) throw new Error("Missing actual loopback response");
  f.receive(response.from, response.payload);
  expect(f.browser.getServerCount(ServerBrowserSource.Local)).toBe(1);
  expect(f.browser.getServerAddressString(ServerBrowserSource.Local, 0, 64)).toBe("loopback");
  expect(f.browser.getServerPing(ServerBrowserSource.Local, 0)).toBe(-1);
});

test("wrong protocol and unsolicited nonlocal replies do not publish lists", async () => {
  const f = await fixture(), destination = await network(), address = udp(destination).address;
  f.cvars.set("developer", "1");
  f.receive(address, infoPacket("\\protocol\\67\\hostname\\Wrong"));
  expect(f.browser.getServerCount(ServerBrowserSource.Local)).toBe(0);
  expect(f.prints.at(-1)).toContain("Different protocol info packet:");
  await masterQuery(f, destination);
  f.receive(address, infoPacket("\\protocol\\68\\hostname\\Not Local"));
  expect(f.browser.getServerCount(ServerBrowserSource.Local)).toBe(0);
  await f.command("ping 999.1.1.1"); expect(f.browser.getPingQueueCount()).toBe(0);
  await f.command("ping"); expect(f.prints.at(-1)).toBe("usage: ping [server]\n");
});

test("source print and asynchronous resolution cancellation preserve reached state and stop later effects", async () => {
  const failure = new CommonError("drop", "browser print abort");
  const f = await fixture(text => { if (text.startsWith("Scanning")) throw failure; });
  f.receive(udp(f.io).address, infoPacket("\\protocol\\68"));
  await expect(f.command("localservers")).rejects.toBe(failure);
  expect(f.browser.getServerCount(ServerBrowserSource.Local)).toBe(1);
  const g = await fixture(text => { if (text.startsWith("ping time")) throw failure; }), destination = await network();
  g.cls.realtime = 10; await g.command(`ping ${textAddress(udp(destination).address)}`); await packet(destination);
  g.cvars.set("developer", "1"); g.cls.realtime = 20;
  expect(() => g.receive(udp(destination).address, infoPacket("\\protocol\\68\\hostname\\Not saved"))).toThrow(failure);
  expect(g.browser.getPing(0, 64).time).toBe(11); expect(g.browser.getPingInfo(0, 1024)).toBe("");
  const h = await fixture(), originalResolve = h.io.resolveAddress.bind(h.io);
  h.io.resolveAddress = async () => { h.close(); return udp(destination).address; };
  try { await expect(h.command("globalservers 1 68")).rejects.toThrow("operation ended"); }
  finally { h.io.resolveAddress = originalResolve; }
  expect(h.prints).toEqual(["Requesting servers from the master...\n"]);
});

test("throwing actual send retains pending ping state, while a false enqueue returns normally", async () => {
  const f = await fixture(), destination = await network(), socket = udp(f.io), send = socket.send.bind(socket);
  const failure = new CommonError("drop", "outgoing ping aborted");
  f.cls.realtime = 500;
  socket.send = () => { throw failure; };
  try { await expect(f.command(`ping ${textAddress(udp(destination).address)}`)).rejects.toBe(failure); }
  finally { socket.send = send; }
  expect(f.browser.getPingQueueCount()).toBe(1); expect(f.browser.getPing(0, 64).time).toBe(0);
  socket.send = () => false;
  try { await f.command(`ping ${textAddress(udp(destination).address)}`); }
  finally { socket.send = send; }
  expect(f.browser.getPingQueueCount()).toBe(2);
});

test("source Q_strncpyz fatal and announcement overflow occur at their reached copy sites", async () => {
  const f = await fixture(), address = udp(f.io).address;
  expect(() => f.browser.getServerAddressString(ServerBrowserSource.Local, 0, 0)).toThrow(new CommonError("fatal", "Q_strncpyz: destsize < 1"));
  expect(f.browser.getPingInfo(0, 0)).toBe(""); // Empty slot never reaches Q_strncpyz.
  expect(() => f.receive(address, infoPacket("\\protocol\\68", "x".repeat(1023)))).toThrow("overflow its source announcement buffer");
  expect(f.browser.getServerCount(ServerBrowserSource.Local)).toBe(1);
  expect(f.browser.getServerAddressString(ServerBrowserSource.Local, 0, 64)).toBe(textAddress(address));
  expect(f.prints).toEqual([]);
  const next = { ...address, port: address.port === 65535 ? 65534 : address.port + 1 };
  f.receive(next, infoPacket("\\protocol\\68", `${"x".repeat(1022)}\n`));
  expect(f.prints.at(-1)).toBe(`${textAddress(next)}: ${"x".repeat(1022)}\n`);
});

test("actual zero-port send error preserves source command continuation and inactive ping rows", async () => {
  const f = await fixture(), destination = await network(), socket = udp(f.io), send = socket.send.bind(socket);
  const addresses: Ipv4Address[] = [];
  socket.send = (to, bytes) => { addresses.push(to); return send(to, bytes); };
  try { await f.command(`ping 127.0.0.1:0\nping ${textAddress(udp(destination).address)}`); }
  finally { socket.send = send; }
  expect(addresses.map(address => address.port)).toEqual([0, udp(destination).address.port]);
  expect(f.prints).toEqual(["NET_SendPacket ERROR: Invalid argument to 127.0.0.1:0\n"]);
  expect(decodeConnectionless((await packet(destination)).payload, "server").line).toBe("getinfo xxx");
  expect(f.browser.getPingQueueCount()).toBe(1);
  expect(f.browser.getPing(0, 64).address).toBe(textAddress(udp(destination).address));
  f.browser.clearPing(0);
  f.receive(udp(destination).address, masterPacket([{ kind: "ipv4", host: [127, 0, 0, 1], port: 0 }]));
  f.browser.markServerVisible(ServerBrowserSource.Global, 0, true);
  expect(f.browser.updateVisiblePings(ServerBrowserSource.Global)).toBe(true);
  expect(f.browser.getPingQueueCount()).toBe(0);
  expect(f.browser.getServerAddressString(ServerBrowserSource.Global, 0, 64)).toBe("127.0.0.1:0");
  expect(f.browser.getServerPing(ServerBrowserSource.Global, 0)).toBe(-1);
  expect(f.prints.at(-1)).toBe("NET_SendPacket ERROR: Invalid argument to 127.0.0.1:0\n");
});

async function serverFor(f: Awaited<ReturnType<typeof fixture>>) {
  const io = await network(), homePath = mkdtempSync(join(tmpdir(), "q3-server-browser-"));
  cleanup.push(() => { rmSync(homePath, { recursive: true }); });
  const random = new LinuxNativeRandom(1);
  let owner: ServerEngine | null = null;
  const common = await CommonConsole.open({
    roots: { product: "baseq3", dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/.local/share/Steam/steamapps/common/Quake 3 Arena", homePath, cdPath: null },
    random, startup: new StartupCommands(""), build: { kind: "dedicated" }, platformPrint: () => undefined,
    resolveCommand: () => ({ kind: "sync", handler: context => { owner?.gameConsoleCommand(context); } }),
    assertCommandEntry: () => { owner?.assertCommandEntry(); }, assertOwnerEntry: () => { owner?.assertCommandEntry(); },
  }, value => { cleanup.push(() => { value.close(); }); return undefined; });
  common.cvars.register("showpackets", "0");
  common.cvars.set("sv_pure", "0", true); common.cvars.set("sv_maxclients", "2", true);
  common.cvars.set("dedicated", "1", true); common.cvars.set("bot_enable", "0", true);
  common.commands.append("exec default.cfg\nexec q3config.cfg\nexec autoexec.cfg\n"); await common.commands.executeAsync();
  common.registerRuntimeCvars("server-browser-test", async () => undefined);
  const clock = { comFrameTime: 1000, wallTime: 2000, milliseconds(): number { return ++this.wallTime; } };
  const server = ServerEngine.create({ common, clock, random, buildDate: "server-browser-test",
    network: { loopback: f.loopback, udp: io.udp, lan: io.lan,
      resolveAddress: async () => { throw new Error("Browser fixture must not query external DNS"); },
      sleep: async milliseconds => { await Bun.sleep(milliseconds); } },
    bots: { kind: "unavailable", reason: "Human server browser does not require game bot AI" },
    clientLifecycle: { kind: "absent" } });
  owner = server; cleanup.push(async () => { await server.disposeResources(); });
  common.cvars.clearModified("dedicated"); common.cvars.set("r_uiFullScreen", "1", true); common.cvars.set("ui_singlePlayerActive", "0", true);
  common.markInitialized(); server.commands.append("map q3dm1\n"); await server.commands.executeAsync();
  return { io, server };
}

async function cacheFiles(f: Awaited<ReturnType<typeof fixture>>) {
  const root = mkdtempSync(join(tmpdir(), "q3-browser-cache-")), dataPath = join(root, "data"), homePath = join(root, "home");
  const cdPath = join(root, "cd"); mkdirSync(cdPath);
  cleanup.push(() => rmSync(root, { recursive: true }));
  mkdirSync(join(dataPath, "baseq3"), { recursive: true });
  writeFileSync(join(dataPath, "baseq3", "default.cfg"), "set cache_fixture 1\n");
  writeFileSync(join(dataPath, "baseq3", "productid.txt"), SOURCE_PRODUCT_ID);
  const entry = (): undefined => { f.browser.getServerCount(ServerBrowserSource.Global); };
  const common = await CommonConsole.open({ roots: { dataPath, homePath, cdPath, product: "baseq3" },
    random: new LinuxNativeRandom(1), startup: new StartupCommands(""), build: { kind: "dedicated" },
    platformPrint: text => { f.prints.push(text); }, resolveCommand: () => undefined,
    assertCommandEntry: entry, assertOwnerEntry: entry,
  }, owner => { cleanup.push(() => owner.close()); });
  return { common, path: join(homePath, "servercache.dat"), dataPath, homePath, cdPath };
}

test("server cache uses source header and 152-byte arrays through the real server-relative filesystem", async () => {
  const f = await fixture(), disk = await cacheFiles(f), source = ServerBrowserSource.Favorites;
  await f.browser.addServer(source, "First", "127.0.0.1:27961");
  await f.browser.addServer(ServerBrowserSource.Mplayer, "Mplayer", "127.0.0.2:27962");
  f.browser.resetPings(source);
  disk.common.cvars.set("fs_debug", "1"); disk.common.cvars.set("developer", "1"); f.prints.length = 0;
  f.browser.saveServersToCache(disk.common.files);
  const bytes = readFileSync(disk.path), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(bytes.length).toBe(661520);
  expect([0, 4, 8, 12].map(offset => view.getInt32(offset, true))).toEqual([0, 1, 1, 661504]);
  const favorite = 16 + (4096 + 128) * 152, mplayer = 16 + 4096 * 152;
  expect([...bytes.subarray(favorite, favorite + 20)]).toEqual([4, 0, 0, 0, 127, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 109, 57]);
  expect([...bytes.subarray(favorite + 20, favorite + 52)]).toEqual([...Buffer.from("First"), ...new Uint8Array(27)]);
  expect(view.getInt32(favorite + 140, true)).toBe(-1);
  expect(view.getInt32(favorite + 144, true)).toBe(1);
  expect(bytes.subarray(mplayer + 20, mplayer + 27).toString("latin1")).toBe("Mplayer");
  expect(existsSync(join(disk.homePath, "baseq3", "servercache.dat"))).toBe(false);
  expect(existsSync(join(disk.dataPath, "servercache.dat"))).toBe(false);
  expect(f.prints).toEqual([`FS_SV_FOpenFileWrite: ${disk.path}\n`, `writing to: ${disk.path}\n`]);
  const originalNames = Buffer.from("Retained cached hostname bytes!\0");
  expect(originalNames.length).toBe(32);
  bytes.set(originalNames, 16 + 20); view.setInt32(16, 4, true); bytes.set([127, 1, 2, 3], 20);
  bytes.set([0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9], 24);
  view.setUint16(16 + 18, 27960, false); view.setInt32(16 + 144, 7, true);
  view.setInt32(0, 1, true);
  bytes.fill(0xa5, 16 + 152 + 4, 16 + 152 + 20);
  writeFileSync(disk.path, bytes);
  f.browser.loadCachedServers(disk.common.files);
  expect(f.browser.getServerCount(ServerBrowserSource.Global)).toBe(1);
  expect(f.browser.getServerAddressString(ServerBrowserSource.Global, 0, 64)).toBe("127.1.2.3:27960");
  expect(f.browser.getServerAddressString(ServerBrowserSource.Global, 1, 64)).toBe("bot");
  expect(f.browser.serverIsVisible(ServerBrowserSource.Global, 0)).toBe(true);
  f.browser.saveServersToCache(disk.common.files);
  expect(readFileSync(disk.path)).toEqual(bytes);
  const destination = await network();
  await masterQuery(f, destination); // Reset count, then CL_InitServerInfo reuses row zero.
  f.receive(udp(destination).address, masterPacket([{ kind: "ipv4", host: [127, 5, 6, 7], port: 27963 }]));
  f.browser.saveServersToCache(disk.common.files);
  const refreshed = readFileSync(disk.path);
  expect(refreshed[16 + 20]).toBe(0);
  expect(refreshed.subarray(16 + 21, 16 + 52)).toEqual(bytes.subarray(16 + 21, 16 + 52));
  expect(refreshed.subarray(24, 34)).toEqual(bytes.subarray(24, 34));
  expect(new DataView(refreshed.buffer, refreshed.byteOffset).getInt32(16 + 144, true)).toBe(7);
});

test("server-relative cache writes retain shared handles and protected-home containment", async () => {
  const f = await fixture(), disk = await cacheFiles(f);
  const first = disk.common.files.current.openRead("default.cfg");
  if (first === undefined) throw new Error("Expected actual default file");
  const writer = disk.common.files.server.openWrite("nested/cache.dat");
  if (writer === null) throw new Error("Expected actual server-relative writer");
  const third = disk.common.files.current.openRead("default.cfg");
  if (third === undefined) throw new Error("Expected second actual default file");
  expect(first.file.slot).toBe(1); expect(third.file.slot).toBe(3);
  expect(writer.writeBytes(Uint8Array.of(1, 2, 3))).toBe(3); writer.close();
  disk.common.files.current.closeFile(first.file); disk.common.files.current.closeFile(third.file);
  expect(readFileSync(join(disk.homePath, "nested", "cache.dat"))).toEqual(Buffer.from([1, 2, 3]));
  expect(existsSync(join(disk.homePath, "baseq3", "nested"))).toBe(false);
  const outside = join(disk.dataPath, "preserved.dat"); writeFileSync(outside, "preserved");
  symlinkSync(outside, disk.path);
  expect(() => f.browser.saveServersToCache(disk.common.files)).toThrow("symbolic link");
  symlinkSync(disk.dataPath, join(disk.homePath, "linked"));
  expect(() => disk.common.files.server.openWrite("linked/preserved.dat")).toThrow("symbolic link");
  expect(() => disk.common.files.server.openWrite("../data/preserved.dat")).toThrow();
  expect(readFileSync(outside, "utf8")).toBe("preserved");
});

test("failed cache write closes the actual retained source zero-row descriptor once", async () => {
  const f = await fixture(), disk = await cacheFiles(f), retained = join(disk.cdPath, "retained.dat");
  writeFileSync(retained, "retained");
  const retainedDescriptors = (): string[] => readdirSync("/proc/self/fd").filter(name => {
    try { return readlinkSync(`/proc/self/fd/${name}`) === retained; }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  });
  expect(disk.common.files.server.openRead("retained.dat")).toBeNull();
  expect(retainedDescriptors()).toHaveLength(1);
  mkdirSync(disk.path);
  f.browser.saveServersToCache(disk.common.files);
  expect(retainedDescriptors()).toHaveLength(0);
  const opened = disk.common.files.current.openRead("default.cfg");
  if (opened === undefined) throw new Error("Expected real file after zero-row close");
  f.browser.saveServersToCache(disk.common.files);
  expect(disk.common.files.current.readInto(opened.file, new Uint8Array(1))).toBe(1);
  disk.common.files.current.closeFile(opened.file);
});

test("cached rows preserve raw tails on memcpy, partial reads and rejected header size", async () => {
  const f = await fixture(), disk = await cacheFiles(f), source = ServerBrowserSource.Favorites;
  await f.browser.addServer(source, "First", "127.0.0.1:27961");
  await f.browser.addServer(source, "Second", "127.0.0.2:27962");
  f.browser.saveServersToCache(disk.common.files);
  const bytes = readFileSync(disk.path), favorite = 16 + (4096 + 128) * 152;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes[favorite + 152 + 10] = 0xa5; view.setInt32(favorite + 152 + 144, 9, true);
  writeFileSync(disk.path, bytes); f.browser.loadCachedServers(disk.common.files);
  await f.browser.removeServer(source, "127.0.0.1:27961");
  f.browser.saveServersToCache(disk.common.files);
  const shifted = readFileSync(disk.path);
  expect(shifted.subarray(favorite, favorite + 152)).toEqual(bytes.subarray(favorite + 152, favorite + 304));
  expect(shifted.subarray(favorite + 152, favorite + 304)).toEqual(bytes.subarray(favorite + 152, favorite + 304));
  const short = Buffer.from(shifted.subarray(0, 16 + 6));
  short[16] = 4; short[20] = 127; short[21] = 42;
  writeFileSync(disk.path, short); f.browser.loadCachedServers(disk.common.files);
  f.browser.saveServersToCache(disk.common.files);
  const afterShort = readFileSync(disk.path);
  expect(afterShort.subarray(16, 22)).toEqual(short.subarray(16, 22));
  expect(afterShort.subarray(22)).toEqual(shifted.subarray(22));
  const wrongSize = Buffer.from(shifted.subarray(0, 16)); wrongSize.writeInt32LE(1, 12);
  writeFileSync(disk.path, wrongSize); f.browser.loadCachedServers(disk.common.files);
  expect(f.browser.getServerCount(source)).toBe(0);
  expect(f.browser.getServerAddressString(source, 0, 64)).toBe("127.0.0.2:27962");
  writeFileSync(disk.path, Uint8Array.of(3));
  expect(() => f.browser.loadCachedServers(disk.common.files)).toThrow("local size uninitialized");
  expect(f.browser.getServerCount(ServerBrowserSource.Global)).toBe(3);
  expect(f.browser.getServerCount(source)).toBe(0);
});

test("cache retains unsupported bytes without pretending they are an IPv4 address or terminated text", async () => {
  const f = await fixture(), disk = await cacheFiles(f), bytes = new Uint8Array(661520), view = new DataView(bytes.buffer);
  view.setInt32(0, 1, true); view.setInt32(12, 661504, true); view.setInt32(16, 5, true);
  bytes.fill(65, 16 + 20, 16 + 52);
  writeFileSync(disk.path, bytes); f.browser.loadCachedServers(disk.common.files);
  expect(() => f.browser.getServerAddressString(ServerBrowserSource.Global, 0, 64)).toThrow("type 5 is unsupported");
  f.browser.saveServersToCache(disk.common.files); expect(readFileSync(disk.path)).toEqual(Buffer.from(bytes));
  view.setInt32(16, 4, true); writeFileSync(disk.path, bytes); f.browser.loadCachedServers(disk.common.files);
  expect(() => f.browser.getServerInfo(ServerBrowserSource.Global, 0, 1024)).toThrow("not terminated");
  f.browser.saveServersToCache(disk.common.files); expect(readFileSync(disk.path)).toEqual(Buffer.from(bytes));
});

test("IPv4 ping and list comparisons leave unrelated cached address types opaque", async () => {
  const f = await fixture(), disk = await cacheFiles(f), destination = await network(), address = udp(destination).address;
  const source = ServerBrowserSource.Favorites;
  await f.browser.addServer(source, "Before", textAddress(address));
  f.browser.saveServersToCache(disk.common.files);
  const bytes = readFileSync(disk.path), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setInt32(16, 5, true); // Unused global row still participates in CL_SetServerInfoByAddress.
  view.setInt32(16 + 4096 * 152, 5, true); view.setInt32(4, 1, true);
  writeFileSync(disk.path, bytes); f.browser.loadCachedServers(disk.common.files);
  f.cls.realtime = 100; await f.command(`ping ${textAddress(address)}`);
  const request = await packet(destination);
  expect(decodeConnectionless(request.payload, "server").line).toBe("getinfo xxx");
  f.cls.realtime = 106;
  udp(destination).send(request.from, infoPacket("\\protocol\\68\\hostname\\Supported\\clients\\3"));
  const reply = await packet(f.io); f.receive(reply.from, reply.payload);
  expect(f.browser.getServerPing(source, 0)).toBe(7);
  expect(f.browser.getPing(0, 64)).toEqual({ address: textAddress(address), time: 7 });
  expect(infoValueForKey(f.browser.getServerInfo(source, 0, 1024), "hostname")).toBe("Supported");
  expect(await f.browser.addServer(ServerBrowserSource.Mplayer, "Added", textAddress(address))).toBe(1);
  await f.browser.removeServer(ServerBrowserSource.Mplayer, textAddress(address));
  expect(f.browser.getServerCount(ServerBrowserSource.Mplayer)).toBe(1);
  expect(() => f.browser.getServerAddressString(ServerBrowserSource.Mplayer, 0, 64)).toThrow("type 5 is unsupported");
  f.browser.saveServersToCache(disk.common.files);
  const saved = readFileSync(disk.path);
  expect(saved.subarray(16, 16 + 152)).toEqual(bytes.subarray(16, 16 + 152));
  expect(saved.subarray(16 + 4096 * 152, 16 + 4097 * 152)).toEqual(bytes.subarray(16 + 4096 * 152, 16 + 4097 * 152));
});

test("cache save continues after a real partial write and read keeps the source empty-file handle", async () => {
  const f = await fixture(), disk = await cacheFiles(f), openWrite = disk.common.files.server.openWrite.bind(disk.common.files.server);
  const lengths: number[] = [];
  disk.common.files.server.openWrite = name => {
    const file = openWrite(name);
    if (file === null) throw new Error("Expected actual cache file");
    const write = file.writeBytes.bind(file);
    file.writeBytes = bytes => {
      lengths.push(bytes.length);
      if (lengths.length === 1) { write(bytes.subarray(0, 2)); return 0; }
      return write(bytes);
    };
    return file;
  };
  try { f.browser.saveServersToCache(disk.common.files); }
  finally { disk.common.files.server.openWrite = openWrite; }
  expect(lengths).toEqual([4, 4, 4, 4, 622592, 19456, 19456]);
  expect(readFileSync(disk.path)).toHaveLength(661518);
  writeFileSync(disk.path, new Uint8Array()); f.browser.loadCachedServers(disk.common.files);
  const opened = disk.common.files.current.openRead("default.cfg");
  if (opened === undefined) throw new Error("Expected actual default file");
  expect(opened.file.slot).toBe(2);
  disk.common.files.current.closeFile(opened.file);
});

test("real running server getinfo crosses UnixIo, admission and browser into ArenaServers ping getters", async () => {
  const f = await fixture(), host = await serverFor(f), address = udp(host.io).address;
  await f.browser.addServer(ServerBrowserSource.Favorites, "Unqueried", textAddress(address));
  f.cls.realtime = 1000;
  await f.command(`ping ${textAddress(address)}`);
  const request = await packet(host.io);
  await host.server.packetEvent(request.from, request.payload);
  f.cls.realtime = 1012;
  const response = await packet(f.io); expect(f.receive(response.from, response.payload)).toBe(true);
  expect(f.browser.getPing(0, 64)).toEqual({ address: textAddress(address), time: 13 });
  const info = f.browser.getPingInfo(0, 1024);
  expect(infoValueForKey(info, "protocol")).toBe("68"); expect(infoValueForKey(info, "challenge")).toBe("xxx");
  expect(infoValueForKey(info, "mapname")).toBe("q3dm1"); expect(infoValueForKey(info, "nettype")).toBe("1");
  expect(infoValueForKey(info, "clients")).toBe("0"); expect(infoValueForKey(info, "sv_maxclients")).toBe("2");
  expect(f.browser.getServerPing(ServerBrowserSource.Favorites, 0)).toBe(13);
  f.browser.clearPing(0); expect(f.browser.getPingQueueCount()).toBe(0);
}, 20000);

test("server status reset, exact resend boundary and retrieval use common time and real loopback", async () => {
  const f = await fixture();
  expect(await f.browser.serverStatus("localhost", 8192, f.statusClock)).toBeNull();
  expect(f.loopback.poll("server")).toBeNull(); // Initial unretrieved slots cannot start a UI request.
  await f.browser.serverStatus(null, null, f.statusClock);
  f.cls.realtime = 900000; f.setStatusTime(100);
  expect(await f.browser.serverStatus("localhost", 8192, f.statusClock)).toBeNull();
  expect(f.loopback.poll("server")?.payload).toEqual(encodeConnectionlessText("getstatus"));
  expect(f.statusReads()).toBe(1);
  f.setStatusTime(850);
  expect(await f.browser.serverStatus("localhost", 8192, f.statusClock)).toBeNull();
  expect(f.loopback.poll("server")).toBeNull(); expect(f.statusReads()).toBe(2);
  f.setStatusTime(851);
  expect(await f.browser.serverStatus("localhost", 8192, f.statusClock)).toBeNull();
  expect(f.loopback.poll("server")?.payload).toEqual(encodeConnectionlessText("getstatus"));
  expect(f.statusReads()).toBe(4); // Expired path samples separately for comparison and assignment.
  f.loopback.send("server", encodeConnectionlessText('statusResponse\n\\name\\A%\xff\r\n12 34 "One%\xff"\n'));
  const response = f.loopback.poll("client");
  if (response === null) throw new Error("Missing loopback status response");
  f.receive(response.from, response.payload);
  expect(f.statusReads()).toBe(5);
  expect(await f.browser.serverStatus("localhost", 5, f.statusClock)).toBe("\\nam");
  expect(await f.browser.serverStatus("localhost", 8192, f.statusClock)).toBe('\\name\\A.\xff\r\\\\12 34 "One.\xff"\\');
  expect(f.statusReads()).toBe(5); expect(f.loopback.poll("server")).toBeNull();
  await expect(f.browser.serverStatus("localhost", 0, f.statusClock)).rejects.toThrow("Q_strncpyz: destsize < 1");
  await f.browser.serverStatus(null, null, f.statusClock);
  // Reset only clears ports; NET_CompareAdr still matches a loopback address.
  expect(await f.browser.serverStatus("localhost", 8192, f.statusClock)).toBe('\\name\\A.\xff\r\\\\12 34 "One.\xff"\\');
});

test("16 status slots retain pending requests and console reuses the oldest slot", async () => {
  const f = await fixture(), destination = await network(), socket = udp(f.io), send = socket.send.bind(socket);
  const addresses: Ipv4Address[] = [];
  socket.send = (to, bytes) => { addresses.push(to); return send(udp(destination).address, bytes); };
  try {
    await f.browser.serverStatus(null, null, f.statusClock);
    for (let index = 0; index < 16; index++) {
      f.setStatusTime(100 + index);
      await f.browser.serverStatus(`127.0.0.1:${20000 + index}`, 8192, f.statusClock);
      expect((await packet(destination)).payload).toEqual(encodeConnectionlessText("getstatus"));
    }
    await f.browser.serverStatus("127.0.0.1:21000", 8192, f.statusClock);
    expect(addresses).toHaveLength(16);
    await f.command("serverstatus 127.0.0.1:21000"); await packet(destination);
    expect(addresses).toHaveLength(17);
    const before = f.statusReads();
    f.receive({ kind: "ipv4", host: [127, 0, 0, 1], port: 20000 }, encodeConnectionlessText("statusResponse\n\\name\\Evicted\n"));
    expect(f.statusReads()).toBe(before); expect(f.prints).toEqual([]);
    f.receive({ kind: "ipv4", host: [127, 0, 0, 1], port: 21000 }, encodeConnectionlessText('statusResponse\n\\name\\Replacement\n3 40 "Bot"\ninvalid\n'));
    expect(f.prints).toEqual(["Server settings:\n", "name                    ", "Replacement\n", "\nPlayers:\n",
      "num: score: ping: name:\n", '0    3      40    "Bot"\n', "1    0      0     unknown\n"]);
    await f.browser.serverStatus("127.0.0.1:22000", 8192, f.statusClock); await packet(destination);
    expect(addresses).toHaveLength(18); // Printed response marks that exact row retrieved.
    await f.browser.serverStatus("127.0.0.1:20001", null, f.statusClock);
    await f.browser.serverStatus("127.0.0.1:22001", 8192, f.statusClock); await packet(destination);
    expect(addresses).toHaveLength(19);
  } finally { socket.send = send; }
});

test("status response stops at source line boundaries and truncates its accumulated 8192-byte string", async () => {
  const f = await fixture();
  await f.browser.serverStatus(null, null, f.statusClock);
  await f.browser.serverStatus("localhost", 8192, f.statusClock); f.loopback.poll("server");
  f.receive({ kind: "loopback" }, encodeConnectionlessText(`statusResponse\n${"x".repeat(1023)}\n1 2 ignored\n`));
  expect(await f.browser.serverStatus("localhost", 8192, f.statusClock)).toBe(`${"x".repeat(1023)}\\\\`);
  const rows = Array.from({ length: 9 }, (_, index) => `${index} 2 ${"x".repeat(996)}`).join("\n");
  f.receive({ kind: "loopback" }, encodeConnectionlessText(`statusResponse\n\\name\\Server\n${rows}\n`));
  const result = await f.browser.serverStatus("localhost", 9000, f.statusClock);
  expect(result).toHaveLength(8191);
  expect(result?.startsWith("\\name\\Server\\\\0 2 ")).toBe(true);
  expect(f.prints).toContain("Com_sprintf: overflow of 1 in 1\n");
});

test("status command source selection, default port and send-before-allocation ordering", async () => {
  const f = await fixture(), destination = await network(), socket = udp(f.io), send = socket.send.bind(socket);
  await f.command("serverstatus");
  expect(f.prints).toEqual(["Not connected to a server.\n", "Usage: serverstatus [server]\n"]);
  f.prints.length = 0; f.cls.phase = "active"; f.cls.servername = textAddress(udp(destination).address);
  f.clc.serverAddress = { kind: "ipv4", host: [127, 0, 0, 1], port: 1 };
  await f.command("serverstatus ignored extra");
  expect((await packet(destination)).payload).toEqual(encodeConnectionlessText("getstatus"));
  const destinations: Ipv4Address[] = [];
  socket.send = (to, bytes) => { destinations.push(to); return send(udp(destination).address, bytes); };
  try {
    await f.command("serverstatus 127.0.0.1"); await packet(destination);
    await f.command("serverstatus 127.0.0.1:0"); await packet(destination);
  } finally { socket.send = send; }
  expect(destinations.map(value => value.port)).toEqual([27960, 0]);
  const failure = new CommonError("drop", "status send aborted");
  socket.send = () => { throw failure; };
  try { await expect(f.command("serverstatus 127.0.0.1:29000")).rejects.toBe(failure); }
  finally { socket.send = send; }
  const before = f.statusReads();
  f.receive({ kind: "ipv4", host: [127, 0, 0, 1], port: 29000 }, encodeConnectionlessText("statusResponse\n\\name\\Unallocated\n"));
  expect(f.statusReads()).toBe(before);
  f.clc.demoPlaying = true;
  await f.command("serverstatus");
  expect(f.prints).toEqual(["Not connected to a server.\n", "Usage: serverstatus [server]\n"]);
});

test("real running server getstatus crosses UDP and loopback into retained retrieval and console output", async () => {
  const f = await fixture(), host = await serverFor(f), address = textAddress(udp(host.io).address);
  await f.browser.serverStatus(null, null, f.statusClock);
  await f.browser.serverStatus(address, 8192, f.statusClock);
  const request = await packet(host.io);
  await host.server.packetEvent(request.from, request.payload);
  const response = await packet(f.io); f.receive(response.from, response.payload);
  const result = await f.browser.serverStatus(address, 8192, f.statusClock);
  expect(result).not.toBeNull();
  if (result === null) throw new Error("Actual server status was not retrieved");
  expect(infoValueForKey(result, "mapname")).toBe("q3dm1");
  expect(infoValueForKey(result, "sv_maxclients")).toBe("2");
  expect(result.endsWith("\\\\")).toBe(true);
  await f.command("serverstatus localhost");
  const localRequest = f.loopback.poll("server");
  if (localRequest === null) throw new Error("Missing real loopback status request");
  await host.server.packetEvent(localRequest.from, localRequest.payload);
  const localResponse = f.loopback.poll("client");
  if (localResponse === null) throw new Error("Missing real server loopback status response");
  f.receive(localResponse.from, localResponse.payload);
  expect(f.prints).toContain("Server settings:\n");
  expect(f.prints).toContain("mapname                 ");
  expect(f.prints).toContain("q3dm1\n");
  expect(f.prints).toContain("num: score: ping: name:\n");
}, 20000);
