import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CommonError } from "../src/core/common-error.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import type { CommandContext } from "../src/core/commands.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { infoValueForKey } from "../src/core/info-string.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { CommonCdKeyState } from "../src/engine/cd-key.ts";
import { ClientAdmission } from "../src/engine/client-admission.ts";
import { ClientAuthorization } from "../src/engine/client-authorization.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import type { ClientPacketAddress } from "../src/engine/client-state.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { ServerEngine } from "../src/engine/server-engine.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { decodeConnectionless, encodeConnectionlessText } from "../src/protocol/connectionless.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import type { ChannelDiagnostics } from "../src/protocol/netchan.ts";
import { ServerClientPhase } from "../src/server/state.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function network(): Promise<UnixIo> {
  const cvars = new CvarRegistry(), stdin = new PassThrough();
  cvars.register("net_ip", "127.0.0.1"); cvars.register("net_port", "0");
  const io = new UnixIo(() => undefined, new UnixSystemClock(), { stdin, signals: "none" });
  cleanup.push(() => { try { io.close(); } finally { stdin.destroy(); } });
  await io.initializeNetwork(cvars);
  return io;
}

async function client(onPrint: (text: string) => void = () => undefined) {
  const cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars), prints: string[] = [];
  const io = await network(), loopback = new LoopbackTransport();
  cleanup.push(() => { lifecycle.close(); });
  lifecycle.clientStatic.phase = "disconnected";
  cvars.register("net_qport", "123", CvarFlag.Init);
  cvars.register("developer", "0");
  cvars.register("showpackets", "0", CvarFlag.Temporary);
  cvars.register("showdrop", "0", CvarFlag.Temporary);
  cvars.register("name", "Admission Peer", CvarFlag.UserInfo | CvarFlag.Archive);
  cvars.register("rate", "25000", CvarFlag.UserInfo);
  cvars.register("snaps", "20", CvarFlag.UserInfo);
  const cdKey = new CommonCdKeyState(cvars, "client");
  const print = (text: string): void => { prints.push(text); onPrint(text); };
  const authorization = new ClientAuthorization({ cvars, cdKey, io, print });
  const admission = new ClientAdmission({ cvars, io, loopback, authorization,
    clientStatic: lifecycle.clientStatic, clientConnection: lifecycle.clientConnection,
    assertCurrentOperation: () => { lifecycle.assertCurrentOperation(); },
    print });
  return { admission, authorization, cdKey, cvars, lifecycle, cls: lifecycle.clientStatic, clc: lifecycle.clientConnection, prints, io, loopback };
}

function udpAddress(io: UnixIo) {
  const udp = io.udp;
  if (udp === null) throw new Error("Expected real localhost UDP socket");
  return udp.address;
}

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

function loopbackConnect(f: Awaited<ReturnType<typeof client>>) {
  const request = f.loopback.poll("server");
  if (request === null) throw new Error("Missing actual loopback connect packet");
  const decoded = decodeConnectionless(request.payload, "server");
  expect(decoded.command).toBe("connect"); expect(decoded.compression).toBe("adaptive");
  const info = decoded.arguments[0];
  if (info === undefined) throw new Error("Missing connect userinfo");
  return info;
}

test("resolved tail preserves pre-print mutations, source local distinction and default port", async () => {
  const f = await client();
  f.admission.beginResolved("localhost", { kind: "loopback" });
  expect(f.cls.servername).toBe("localhost"); expect(f.cls.phase).toBe("challenging");
  expect(f.cls.updateInfoString).toBe(""); expect(f.clc.serverMessage).toBe("");
  expect(f.prints).toEqual(["localhost resolved to 0.0.0.0:27960\n"]);
  expect(f.clc.connectTime).toBe(-99999); expect(f.clc.connectPacketCount).toBe(0);
  expect(f.cvars.get("cl_currentServerAddress")?.value).toBe("localhost");
  expect(f.cvars.get("cl_currentServerAddress")?.flags).toBe(CvarFlag.None);
  expect(() => f.admission.beginResolved("again", { kind: "loopback" })).toThrow("disconnected");
  const g = await client();
  g.admission.beginResolved("127.0.0.1", { kind: "ipv4", host: [127, 0, 0, 1], port: 0 });
  expect(g.cls.phase).toBe("connecting");
  expect(g.clc.serverAddress).toEqual({ kind: "ipv4", host: [127, 0, 0, 1], port: 27960 });
  const failure = new CommonError("drop", "resolved print cancelled");
  const h = await client(() => { throw failure; });
  expect(() => h.admission.beginResolved("localhost", { kind: "loopback" })).toThrow(failure);
  expect(h.cls.servername).toBe("localhost"); expect(h.clc.serverAddress).toEqual({ kind: "loopback" });
  expect(h.cls.phase).toBe("disconnected"); expect(h.clc.connectTime).toBe(0);
  expect(h.cvars.get("cl_currentServerAddress")).toBeUndefined();
});

test("resolved tail uses source forced Cvar_Set even with protected or latched current address", async () => {
  for (const flags of [CvarFlag.Init, CvarFlag.ReadOnly, CvarFlag.Latch]) {
    const f = await client();
    f.cvars.register("cl_currentServerAddress", "previous", flags);
    if (flags === CvarFlag.Latch) {
      f.cvars.set("cl_currentServerAddress", "latched");
      expect(f.cvars.get("cl_currentServerAddress")?.latchedValue).toBe("latched");
    }
    f.admission.beginResolved("localhost", { kind: "loopback" });
    expect(f.cvars.get("cl_currentServerAddress")?.value).toBe("localhost");
    expect(f.cvars.get("cl_currentServerAddress")?.flags).toBe(flags);
    expect(f.cvars.get("cl_currentServerAddress")?.latchedValue).toBeUndefined();
  }
});

test("resend uses exactly 3000ms, current compressed userinfo, float qport and post-send flag clearing", async () => {
  const f = await client();
  f.admission.beginResolved("localhost", { kind: "loopback" });
  f.cls.realtime = 100;
  f.cvars.set("net_qport", "16777219", true); // float32 rounds to 16777220.
  f.clc.challenge = -7;
  await f.admission.checkForResend();
  const first = loopbackConnect(f);
  expect(first.startsWith("\\challenge\\-7\\qport\\16777220\\protocol\\68")).toBe(true);
  expect(infoValueForKey(first, "name")).toBe("Admission Peer");
  expect(f.clc.connectTime).toBe(100); expect(f.clc.connectPacketCount).toBe(1);
  expect(f.cvars.modifiedFlags & CvarFlag.UserInfo).toBe(0);
  f.cvars.set("name", "Second Peer");
  f.cls.realtime = 3099; await f.admission.checkForResend();
  expect(f.loopback.poll("server")).toBeNull(); expect(f.clc.connectPacketCount).toBe(1);
  f.cls.realtime = 3100; await f.admission.checkForResend();
  expect(infoValueForKey(loopbackConnect(f), "name")).toBe("Second Peer");
  expect(f.clc.connectPacketCount).toBe(2);
  expect(f.cvars.modifiedFlags & CvarFlag.Archive).not.toBe(0);
  f.cls.realtime = 6100; f.clc.demoPlaying = true; await f.admission.checkForResend();
  expect(f.loopback.poll("server")).toBeNull(); expect(f.clc.connectTime).toBe(3100);
  f.clc.demoPlaying = false; f.cls.phase = "disconnected"; await f.admission.checkForResend();
  expect(f.loopback.poll("server")).toBeNull();
});

test("LAN challenge request retries over real UnixIo and proxy handoff resets the resend clock", async () => {
  const f = await client(), destination = await network();
  const address = udpAddress(destination);
  f.admission.beginResolved("127.0.0.1", address);
  f.cls.realtime = 50; await f.admission.checkForResend();
  expect(decodeConnectionless((await packet(destination)).payload, "server").line).toBe("getchallenge");
  f.cls.realtime = 3050; await f.admission.checkForResend();
  expect(decodeConnectionless((await packet(destination)).payload, "server").line).toBe("getchallenge");
  expect(f.clc.connectPacketCount).toBe(2);
  const proxy = { kind: "ipv4", host: [127, 0, 0, 2], port: address.port } satisfies ClientPacketAddress;
  f.admission.packetEvent(proxy, encodeConnectionlessText("CHALLENGERESPONSE -71junk"));
  expect(f.clc.challenge).toBe(-71); expect(f.cls.phase).toBe("challenging");
  expect(f.clc.serverAddress).toEqual(proxy); expect(f.clc.connectTime).toBe(-99999);
  expect(f.clc.connectPacketCount).toBe(0); expect(f.clc.lastPacketTime).toBe(3050);
  f.admission.packetEvent(address, encodeConnectionlessText("challengeResponse 19"));
  expect(f.clc.challenge).toBe(-71); expect(f.clc.serverAddress).toEqual(proxy);
  expect(f.prints.at(-1)).toBe("Unwanted challenge response received.  Ignored.\n");
  expect(f.cvars.get("cl_anonymous")).toBeUndefined();
});

async function authorizationClient() {
  const f = await client(), destination = await network(), authorize = await network();
  // Exercise the non-LAN branch with two controlled localhost UDP recipients.
  f.io.lan.isLanAddress = () => false;
  const resolutions: { readonly hostname: string; readonly port: number }[] = [];
  f.io.resolveAddress = async (hostname, port) => {
    resolutions.push({ hostname, port });
    return udpAddress(authorize);
  };
  f.admission.beginResolved("controlled-authorization-peer", udpAddress(destination));
  return { ...f, destination, authorize, resolutions };
}

function writeSyntheticKey(f: Awaited<ReturnType<typeof client>>, game: string, text: string): void {
  f.cvars.set("fs_game", game, true);
  const bytes = new Uint8Array(16).fill(32);
  for (let index = 0; index < Math.min(text.length, 16); index++) bytes[index] = text.charCodeAt(index);
  f.cdKey.writeUiForCompiledModule(() => 1, () => bytes);
}

test("authorization uses both common key slots, source ASCII filtering and anonymous cvar before challenge", async () => {
  const f = await authorizationClient(), udp = f.io.udp;
  if (udp === null) throw new Error("Missing UDP owner");
  writeSyntheticKey(f, "", "aZ0- !b/9\xffxy_12?");
  writeSyntheticKey(f, "missionpack", "M8. n!7+OP*qr@56");
  f.cvars.register("cl_anonymous", "-7");
  const sends: number[] = [], send = udp.send.bind(udp);
  udp.send = (to, bytes) => { sends.push(to.port); return send(to, bytes); };
  f.cls.realtime = 25;
  await f.admission.checkForResend();
  const request = (await packet(f.authorize)).payload;
  expect(request).toEqual(encodeConnectionlessText("getKeyAuthorize -7 aZ0b9xy12M8n7OPqr56"));
  expect(decodeConnectionless((await packet(f.destination)).payload, "server").line).toBe("getchallenge");
  expect(sends).toEqual([udpAddress(f.authorize).port, udpAddress(f.destination).port]);
  expect(f.resolutions).toEqual([{ hostname: "authorize.quake3arena.com", port: 27952 }]);
  expect(f.cvars.get("cl_anonymous")?.flags).toBe(CvarFlag.Init | CvarFlag.SystemInfo);
  expect(f.cvars.get("fs_game")?.value).toBe("missionpack");
  expect(f.cvars.get("cl_cdkey")).toBeUndefined();
  expect(f.clc.connectTime).toBe(25); expect(f.clc.connectPacketCount).toBe(1);
  expect(f.cls.phase).toBe("connecting");
  expect(f.prints.join("")).not.toContain("aZ0b9xy12");
});

test("authorization retries at 3000ms with cached address and live restricted/key state", async () => {
  const f = await authorizationClient();
  f.cls.realtime = 25;
  await f.admission.checkForResend();
  expect((await packet(f.authorize)).payload).toEqual(encodeConnectionlessText("getKeyAuthorize 0 "));
  await packet(f.destination);
  f.cvars.register("fs_restrict", "-0.5");
  f.cls.realtime = 3024; await f.admission.checkForResend();
  expect(f.clc.connectPacketCount).toBe(1); expect(f.authorize.udp?.poll()).toBeNull();
  f.cls.realtime = 3025; await f.admission.checkForResend();
  expect((await packet(f.authorize)).payload).toEqual(encodeConnectionlessText("getKeyAuthorize 0 demota"));
  await packet(f.destination);
  expect(f.resolutions).toHaveLength(1); expect(f.clc.connectPacketCount).toBe(2);
  f.cvars.set("fs_restrict", "0");
  writeSyntheticKey(f, "", "A-9\0UNREACHED");
  writeSyntheticKey(f, "missionpack", "UNREACHED");
  f.cls.realtime = 6025; await f.admission.checkForResend();
  expect((await packet(f.authorize)).payload).toEqual(encodeConnectionlessText("getKeyAuthorize 0 A9"));
  await packet(f.destination);
  f.cls.phase = "disconnected";
  const replacement = new ClientAdmission({ ...f.admission.options });
  replacement.beginResolved("next-controlled-peer", udpAddress(f.destination));
  await replacement.checkForResend();
  await packet(f.authorize); await packet(f.destination);
  expect(f.resolutions).toHaveLength(1);
  expect(f.prints.filter(text => text.startsWith("Resolving "))).toHaveLength(1);
});

test("failed authorization lookup still sends challenge and retries lookup on the next resend", async () => {
  const f = await authorizationClient();
  let lookups = 0;
  f.io.resolveAddress = async () => { lookups++; return null; };
  f.cls.realtime = 40;
  await f.admission.checkForResend();
  expect(decodeConnectionless((await packet(f.destination)).payload, "server").line).toBe("getchallenge");
  expect(f.prints.at(-1)).toBe("Couldn't resolve address\n");
  expect(f.cvars.get("cl_anonymous")).toBeUndefined();
  f.cls.realtime = 3039; await f.admission.checkForResend();
  expect(lookups).toBe(1);
  f.cls.realtime = 3040; await f.admission.checkForResend();
  await packet(f.destination);
  expect(lookups).toBe(2); expect(f.clc.connectPacketCount).toBe(2);
});

test("authorization lookup checks admission authority before cache publication and packet sending", async () => {
  const f = await authorizationClient();
  let current = true, lookups = 0;
  const pendingLookup: { finish: ((value: ReturnType<typeof udpAddress>) => void) | null } = { finish: null };
  f.io.resolveAddress = () => {
    lookups++;
    return new Promise(resolve => { pendingLookup.finish = resolve; });
  };
  const admission = new ClientAdmission({ ...f.admission.options,
    assertCurrentOperation: () => { if (!current) throw new Error("Retired admission"); } });
  f.cls.realtime = 77;
  const pending = admission.checkForResend();
  const release = pendingLookup.finish;
  if (release === null) throw new Error("Expected pending authorization lookup");
  current = false;
  release(udpAddress(f.authorize));
  await expect(pending).rejects.toThrow("Retired admission");
  expect(f.clc.connectTime).toBe(77); expect(f.clc.connectPacketCount).toBe(1);
  expect(f.cvars.get("cl_anonymous")).toBeUndefined();
  expect(f.authorize.udp?.poll()).toBeNull(); expect(f.destination.udp?.poll()).toBeNull();
  f.io.resolveAddress = async () => { lookups++; return udpAddress(f.authorize); };
  current = true; f.cls.realtime = 3077;
  await admission.checkForResend();
  await packet(f.authorize); await packet(f.destination);
  expect(lookups).toBe(2);
});

test("cancellation after authorization send leaves that packet sent and suppresses the challenge", async () => {
  const f = await authorizationClient(), udp = f.io.udp;
  if (udp === null) throw new Error("Missing UDP owner");
  const send = udp.send.bind(udp);
  udp.send = (to, bytes) => { const sent = send(to, bytes); f.lifecycle.close(); return sent; };
  await expect(f.admission.checkForResend()).rejects.toThrow("no longer current");
  expect((await packet(f.authorize)).payload).toEqual(encodeConnectionlessText("getKeyAuthorize 0 "));
  expect(f.destination.udp?.poll()).toBeNull();
});

test("connectResponse requires challenging and matching base, accepts changed port and captures current qport", async () => {
  const f = await client(), destination = await network(), address = udpAddress(destination);
  const response = encodeConnectionlessText("connectResponse");
  f.admission.packetEvent(address, response);
  expect(f.cls.phase).toBe("disconnected");
  expect(f.prints.at(-1)).toBe("connectResponse packet while not connecting.  Ignored.\n");
  f.admission.beginResolved("127.0.0.1", address);
  f.admission.packetEvent(address, encodeConnectionlessText("challengeResponse"));
  expect(f.clc.challenge).toBe(0);
  const other = { ...address, host: [127, 0, 0, 2] } satisfies ClientPacketAddress;
  f.admission.packetEvent(other, response);
  expect(f.cls.phase).toBe("challenging");
  expect(f.prints.at(-2)).toBe("connectResponse from a different address.  Ignored.\n");
  f.cvars.set("net_qport", "-12.9", true);
  const changedPort = { ...address, port: address.port === 65535 ? 65534 : address.port + 1 };
  const accepted = f.admission.packetEvent(changedPort, response);
  expect(accepted.kind).toBe("admitted");
  if (accepted.kind !== "admitted") throw new Error("Expected admitted connection");
  expect(accepted.connection).toEqual({ mode: { kind: "network", challenge: 0, qport: 65524 }, remoteAddress: changedPort });
  expect(f.clc.serverAddress).toEqual(address); expect(f.cls.phase).toBe("connected");
  expect(f.clc.lastPacketSentTime).toBe(-9999);
  f.admission.packetEvent(other, response);
  expect(f.prints.at(-1)).toBe("Dup connect received.  Ignored.\n");
  expect(f.admission.packetEvent(address, new Uint8Array([1, 0, 0, 0])).kind).toBe("handled");
  expect(f.admission.packetEvent(changedPort, new Uint8Array([1, 0, 0, 0])).kind).toBe("sequenced");
  f.admission.packetEvent(changedPort, new Uint8Array([1]));
  expect(f.prints.at(-1)).toBe(`127.0.0.1:${changedPort.port}: Runt packet\n`);
});

test("demo playback without an admitted channel ignores remaining sequenced network packets", async () => {
  const f = await client();
  f.cls.phase = "active"; f.clc.demoPlaying = true; f.cls.realtime = 2345;
  expect(f.admission.packetEvent({ kind: "loopback" }, new Uint8Array([1, 0, 0, 0])).kind).toBe("handled");
  expect(f.clc.lastPacketTime).toBe(2345);
});

test("packet arrival clock precedes parsing, print has source bytes and unimplemented commands remain visible", async () => {
  const f = await client(), from = { kind: "loopback" } satisfies ClientPacketAddress;
  f.cls.realtime = 1000;
  f.admission.packetEvent(from, new Uint8Array([1]));
  expect(f.clc.lastPacketTime).toBe(1000); expect(f.prints).toEqual([]);
  f.admission.packetEvent(from, encodeConnectionlessText("print\nFull % server\n\xff"));
  expect(f.clc.serverMessage).toBe("Full . server\n.");
  expect(f.prints.at(-1)).toBe(f.clc.serverMessage);
  f.admission.packetEvent(from, encodeConnectionlessText(`print\n${"x".repeat(1100)}`));
  expect(f.clc.serverMessage).toHaveLength(1023);
  expect(f.admission.packetEvent(from, encodeConnectionlessText("motd ignored")).kind).toBe("connectionless");
  expect(f.cls.updateInfoString).toBe("");
  f.cls.realtime = 2000;
  const oversized = new Uint8Array(16384); oversized.fill(255, 0, 4);
  expect(() => f.admission.packetEvent(from, oversized)).toThrow();
  expect(f.clc.lastPacketTime).toBe(2000);
});

test("send failure preserves retry state and userinfo flag; false enqueue returns and clears it", async () => {
  const f = await client();
  f.admission.beginResolved("localhost", { kind: "loopback" });
  f.cvars.set("name", "Pending Peer");
  const send = f.loopback.send.bind(f.loopback), failure = new CommonError("drop", "send aborted");
  f.loopback.send = () => { throw failure; };
  f.cls.realtime = 99;
  await expect(f.admission.checkForResend()).rejects.toThrow(failure);
  expect(f.clc.connectTime).toBe(99); expect(f.clc.connectPacketCount).toBe(1);
  expect(f.cvars.modifiedFlags & CvarFlag.UserInfo).not.toBe(0);
  f.loopback.send = send;
  const g = await client(), destination = await network();
  const address = udpAddress(destination), udp = g.io.udp;
  if (udp === null) throw new Error("Missing UDP owner");
  g.admission.beginResolved("127.0.0.1", address);
  g.admission.packetEvent(address, encodeConnectionlessText("challengeResponse 4"));
  g.cvars.set("name", "False Enqueue Peer");
  const originalSend = udp.send.bind(udp);
  udp.send = () => false;
  try { await g.admission.checkForResend(); }
  finally { udp.send = originalSend; }
  expect(g.cvars.modifiedFlags & CvarFlag.UserInfo).toBe(0);
  expect(g.clc.connectPacketCount).toBe(1);
});

test("diagnostic cancellation stops publication but preserves source mutations already reached", async () => {
  let cancel = false;
  const f = await client(() => { if (cancel) f.lifecycle.close(); });
  f.cvars.set("developer", "1");
  f.admission.beginResolved("127.0.0.1", udpAddress(f.io));
  cancel = true; f.cls.realtime = 47;
  expect(() => f.admission.packetEvent({ kind: "loopback" }, encodeConnectionlessText("challengeResponse 7"))).toThrow("no longer current");
  expect(f.clc.lastPacketTime).toBe(47); expect(f.cls.phase).toBe("connecting"); expect(f.clc.challenge).toBe(0);
  const failure = new CommonError("drop", "challenge diagnostic failed");
  const g = await client(text => { if (text.startsWith("challengeResponse:")) throw failure; });
  g.cvars.set("developer", "1");
  g.admission.beginResolved("127.0.0.1", udpAddress(g.io));
  expect(() => g.admission.packetEvent({ kind: "loopback" }, encodeConnectionlessText("challengeResponse 7"))).toThrow(failure);
  expect(g.cls.phase).toBe("challenging"); expect(g.clc.challenge).toBe(7);
  expect(g.clc.connectTime).toBe(-99999); expect(g.clc.serverAddress).toEqual({ kind: "loopback" });
});

test("unsupported native conversion and buffer overflow keep source retry mutations without sending", async () => {
  const f = await client();
  f.admission.beginResolved("localhost", { kind: "loopback" });
  f.cvars.set("net_qport", "2147483647", true); // Stored float becomes out-of-int-range 2147483648.
  f.cls.realtime = 32;
  await expect(f.admission.checkForResend()).rejects.toThrow("Undefined native net_qport float-to-int conversion");
  expect(f.clc.connectTime).toBe(32); expect(f.clc.connectPacketCount).toBe(1);
  expect(f.loopback.poll("server")).toBeNull();
  const g = await client();
  g.admission.beginResolved("localhost", { kind: "loopback" });
  g.cvars.set("name", "x".repeat(954));
  await expect(g.admission.checkForResend()).rejects.toThrow("Connectionless text exceeds 1013 source bytes");
  expect(g.clc.connectTime).toBe(0); expect(g.clc.connectPacketCount).toBe(1);
  expect(g.loopback.poll("server")).toBeNull();
  expect(g.cvars.modifiedFlags & CvarFlag.UserInfo).not.toBe(0);
});

test("managed cancellation after actual send leaves userinfo pending", async () => {
  const f = await client();
  f.admission.beginResolved("localhost", { kind: "loopback" });
  f.cvars.set("name", "Sent Before Cancellation");
  const send = f.loopback.send.bind(f.loopback);
  f.loopback.send = (endpoint, bytes) => { send(endpoint, bytes); f.lifecycle.close(); };
  await expect(f.admission.checkForResend()).rejects.toThrow("no longer current");
  expect(infoValueForKey(loopbackConnect(f), "name")).toBe("Sent Before Cancellation");
  expect(f.cvars.modifiedFlags & CvarFlag.UserInfo).not.toBe(0);
  expect(f.clc.connectPacketCount).toBe(1);
});

async function serverFor(f: Awaited<ReturnType<typeof client>>) {
  const io = await network(), homePath = mkdtempSync(join(tmpdir(), "q3-client-admission-"));
  cleanup.push(() => { rmSync(homePath, { recursive: true }); });
  const random = new LinuxNativeRandom(1);
  let owner: ServerEngine | null = null;
  const common = await CommonConsole.open({
    roots: { product: "baseq3", dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/.local/share/Steam/steamapps/common/Quake 3 Arena", homePath, cdPath: null },
    random, startup: new StartupCommands(""), build: { kind: "dedicated" }, platformPrint: () => undefined,
    resolveCommand: () => ({ kind: "calls", *handler(context: CommandContext): CallSteps { if (owner !== null) yield* owner.gameConsoleCommand(context); } }),
    assertCommandEntry: () => { owner?.assertCommandEntry(); }, assertOwnerEntry: () => undefined,
  }, value => { cleanup.push(() => { value.close(); }); return undefined; });
  const cvars = common.cvars;
  cvars.register("showpackets", "0", CvarFlag.Temporary);
  cvars.register("showdrop", "0", CvarFlag.Temporary);
  cvars.set("sv_pure", "0", true); cvars.set("sv_maxclients", "2", true);
  cvars.set("dedicated", "1", true); cvars.set("bot_enable", "0", true);
  common.commands.append("exec default.cfg\nexec q3config.cfg\nexec autoexec.cfg\n");
  await common.commands.executeAsync();
  common.registerRuntimeCvars("client-admission-test", async () => undefined);
  common.initVm();
  const clock = { comFrameTime: 1000, wallTime: 2000, milliseconds(): number { return ++this.wallTime; } };
  const server = ServerEngine.create({ common, clock, random, buildDate: "client-admission-test",
    network: { loopback: f.loopback, udp: io.udp, lan: io.lan,
      resolveAddress: async () => { throw new Error("LAN admission test must not request external DNS"); },
      sleep: async milliseconds => { await Bun.sleep(milliseconds); } },
    bots: { kind: "unavailable", reason: "Human admission does not require game bot AI" },
    clientLifecycle: { kind: "absent" } });
  owner = server;
  cleanup.push(async () => { await server.disposeResources(); });
  cvars.clearModified("dedicated"); cvars.set("r_uiFullScreen", "1", true); cvars.set("ui_singlePlayerActive", "0", true);
  common.markInitialized();
  server.commands.append("map q3dm1\n"); await server.commands.executeAsync();
  return { server, io };
}

for (const transport of ["loopback", "udp"]) {
  test(`${transport}: actual server admission hands the same connection into real gamestate processing`, async () => {
    const f = await client(), host = await serverFor(f);
    const address: ClientPacketAddress = transport === "loopback" ? { kind: "loopback" } : udpAddress(host.io);
    const nextServer = async () => {
      if (transport === "udp") return packet(host.io);
      const value = f.loopback.poll("server");
      if (value === null) throw new Error("Missing real server-bound loopback packet");
      return value;
    };
    const nextClient = async () => {
      if (transport === "udp") return packet(f.io);
      const value = f.loopback.poll("client");
      if (value === null) throw new Error("Missing real client-bound loopback packet");
      return value;
    };
    f.clc.reliable.add('userinfo "\\name\\Admitted Peer\\rate\\25000\\snaps\\20"');
    f.admission.beginResolved(transport === "loopback" ? "localhost" : "127.0.0.1", address);
    f.cls.realtime = 3000;
    await f.admission.checkForResend();
    if (transport === "udp") {
      const request = await nextServer();
      expect(decodeConnectionless(request.payload, "server").command).toBe("getchallenge");
      await host.server.packetEvent(request.from, request.payload);
      const response = await nextClient();
      f.admission.packetEvent(response.from, response.payload);
      expect(f.cls.phase).toBe("challenging");
      await f.admission.checkForResend();
    }
    const connect = await nextServer();
    expect(decodeConnectionless(connect.payload, "server").command).toBe("connect");
    await host.server.packetEvent(connect.from, connect.payload);
    const response = await nextClient();
    const admitted = f.admission.packetEvent(response.from, response.payload);
    expect(admitted.kind).toBe("admitted");
    if (admitted.kind !== "admitted") throw new Error("Real server did not admit connection");
    const session = new EngineClientSession({ product: "baseq3", mode: admitted.connection.mode, cvars: f.cvars, lifecycle: f.lifecycle });
    const diagnosticLines: string[] = [], diagnosticGenerations: number[] = [];
    const diagnosticCvar = (name: string): boolean => {
      const value = f.cvars.get(name); if (value === undefined) throw new Error(`Missing actual client diagnostic cvar ${name}`);
      return value.integerValue !== 0;
    };
    const diagnostics: ChannelDiagnostics = {
      get showPackets() { return diagnosticCvar("showpackets"); },
      get showDrop() { return diagnosticCvar("showdrop"); },
      get remoteAddress() {
        const remote = admitted.connection.remoteAddress;
        return remote.kind === "loopback" ? "loopback" : `${remote.host.join(".")}:${remote.port}`;
      },
      print: text => { diagnosticLines.push(text); diagnosticGenerations.push(session.gamestateGeneration); },
    };
    f.cvars.set("showpackets", "1", true);
    f.cvars.set("cl_packetdup", "0", true); f.cvars.set("cl_nodelta", "1", true);
    expect(session.lifecycle.clientConnection).toBe(f.clc);
    expect(session.lifecycle.clientStatic).toBe(f.cls);
    const send = async () => {
      let sent = 0;
      const traces: string[] = [];
      session.transmit({
        send: bytes => {
          if (admitted.connection.remoteAddress.kind === "loopback") f.loopback.send("client", bytes);
          else {
            const udp = f.io.udp;
            if (udp === null) throw new Error("Missing actual client UDP socket");
            udp.send(admitted.connection.remoteAddress, bytes);
          }
          sent++;
        },
        trace: text => { traces.push(text); },
        print: text => { f.prints.push(text); },
      });
      expect(traces).toHaveLength(sent);
      for (let i = 0; i < sent; i++) {
        const request = await nextServer(); await host.server.packetEvent(request.from, request.payload);
      }
    };
    await send();
    let finalPacket: { readonly from: ClientPacketAddress; readonly payload: Uint8Array } | null = null;
    for (let fragments = 0; fragments < 32 && session.gamestateGeneration === 0; fragments++) {
      const response = await nextClient(), routed = f.admission.packetEvent(response.from, response.payload);
      if (routed.kind !== "sequenced") throw new Error("Expected actual gamestate channel bytes");
      await session.receiveDatagram(routed.payload, diagnostics); finalPacket = response;
      if (session.gamestateGeneration === 0) await host.server.frame(50);
    }
    expect(session.gamestateGeneration).toBe(1); expect(f.lifecycle.gamestates).toEqual([1]);
    expect(diagnosticLines.length).toBeGreaterThan(0);
    expect(diagnosticLines.every(text => text.startsWith("client recv "))).toBe(true);
    expect(diagnosticGenerations.every(generation => generation === 0)).toBe(true);
    if (finalPacket === null) throw new Error("Missing actual final gamestate datagram");
    f.cvars.set("showpackets", "0", true); f.cvars.set("showdrop", "1", true);
    const duplicate = f.admission.packetEvent(finalPacket.from, finalPacket.payload);
    if (duplicate.kind !== "sequenced") throw new Error("Expected admitted duplicate packet");
    const printCount = diagnosticLines.length;
    expect(await session.receiveDatagram(duplicate.payload, diagnostics)).toEqual({ kind: "rejected", reason: "sequence" });
    expect(diagnosticLines.slice(printCount)).toEqual([
      `${diagnostics.remoteAddress}:Out of order packet ${session.serverMessageSequence} at ${session.serverMessageSequence}\n`,
    ]);
    expect(diagnosticGenerations.at(-1)).toBe(1);
    await send(); // Reliable userinfo is processed once the client has the matching serverId.
    const state = host.server.state;
    if (state.kind !== "running") throw new Error("Real server stopped during admission");
    expect(state.statics.clients[0]?.phase).toBe(ServerClientPhase.Primed);
    expect(state.statics.clients[0]?.name).toBe("Admitted Peer");
    // ProtocolClientLifecycle intentionally stops before CG_Init; no graphical lifecycle is claimed.
    expect(f.cls.phase).toBe("connected");
  }, 20000);
}
