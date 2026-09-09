import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { ClientMotd } from "../src/engine/client-motd.ts";
import { ClientStaticState } from "../src/engine/client-state.ts";
import type { ClientPacketAddress } from "../src/engine/client-state.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import type { CommonSystemEvent } from "../src/engine/common-events.ts";
import type { Ipv4Address } from "../src/platform/network.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { decodeConnectionless, encodeConnectionlessText } from "../src/protocol/connectionless.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

async function network(): Promise<UnixIo> {
  const cvars = new CvarRegistry(), stdin = new PassThrough();
  cvars.register("net_ip", "127.0.0.1"); cvars.register("net_port", "0");
  const io = new UnixIo(() => undefined, new UnixSystemClock(), { stdin, signals: "none" });
  cleanup.push(() => { try { io.close(); } finally { stdin.destroy(); } });
  await io.initializeNetwork(cvars);
  return io;
}

function socket(io: UnixIo) {
  const udp = io.udp;
  if (udp === null) throw new Error("Expected real local UDP socket");
  return udp;
}

async function receive(io: UnixIo) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    io.pollPacketEvent();
    const event = io.takeQueuedEvent();
    if (event !== null) {
      if (event.kind !== "packet") throw new Error("Expected UDP event");
      return event;
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for local MOTD datagram");
}

async function fixture() {
  const io = await network(), server = await network(), cvars = new CvarRegistry();
  const clientStatic = new ClientStaticState(), random = new LinuxNativeRandom(1);
  cvars.register("cl_motd", "1");
  cvars.register("cl_motdString", "previous", CvarFlag.ReadOnly);
  cvars.register("version", "Q3 1.32b linux-ts fixture", CvarFlag.ReadOnly);
  cvars.register("developer", "0");
  const prints: string[] = [], resolutions: (readonly [string, number])[] = [];
  const pendingEvents: CommonSystemEvent[] = [];
  const values = { renderer: "Controlled renderer", milliseconds: 1234, current: true, clockReads: 0 };
  const events = new CommonEvents({ getEvent: () => {
    values.clockReads++;
    return pendingEvents.shift() ?? { kind: "none", time: values.milliseconds };
  } }, () => undefined);
  io.resolveAddress = async (hostname, port) => {
    resolutions.push([hostname, port]);
    if (hostname !== "update.quake3arena.com" || port !== 27951) throw new Error("Unexpected DNS destination");
    return socket(server).address;
  };
  const options = { clientStatic, cvars, io, random, milliseconds: () => events.milliseconds(),
    rendererString: () => values.renderer, print: (text: string): void => { prints.push(text); } };
  const owner = new ClientMotd(options);
  const guard = (): void => { if (!values.current) throw new Error("Retired client operation"); };
  const reply = (info: string, from: ClientPacketAddress = socket(server).address): void => {
    owner.packet(from, decodeConnectionless(encodeConnectionlessText(`MoTd "${info}"\n`), "client"));
  };
  return { owner, options, guard, reply, io, server, cvars, clientStatic, random, values, events, pendingEvents, prints, resolutions };
}

test("request sends exact source field order, framing and signed native challenge with the common event clock", async () => {
  const f = await fixture();
  f.pendingEvents.push({ kind: "key", time: 7, key: 13, down: true });
  await f.owner.request(f.guard);
  const request = await receive(f.server);
  // Seed-one native vector: 1804289383, 846930886; signed shift/XOR with clock 1234.
  expect(request.payload).toEqual(encodeConnectionlessText(
    'getmotd "\\version\\Q3 1.32b linux-ts fixture\\renderer\\Controlled renderer\\challenge\\1998333716"\n'));
  expect(f.random.next()).toBe(1681692777);
  expect(f.events.getEvent()).toEqual({ kind: "key", time: 7, key: 13, down: true });
  expect(f.resolutions).toEqual([["update.quake3arena.com", 27951]]);
  expect(f.prints).toEqual(["Resolving update.quake3arena.com\n",
    `update.quake3arena.com resolved to 127.0.0.1:${socket(f.server).address.port}\n`]);
  const response = '\\challenge\\1998333716\\motd\\Welcome to Quake III';
  socket(f.server).send(request.from, encodeConnectionlessText(`motd "${response}"\n`));
  const received = await receive(f.io);
  f.owner.packet(received.from, decodeConnectionless(received.payload, "client"));
  expect(f.clientStatic.updateInfoString).toBe(response);
  expect(f.cvars.get("cl_motdString")?.value).toBe("Welcome to Quake III");
  expect(f.cvars.get("cl_motdString")?.flags).toBe(CvarFlag.ReadOnly);
});

test("disabled request has no DNS, print, clock, random or retained-state effects", async () => {
  const f = await fixture();
  f.cvars.set("cl_motd", "0"); f.clientStatic.updateInfoString = "retained";
  await f.owner.request(f.guard);
  expect(f.resolutions).toEqual([]); expect(f.prints).toEqual([]); expect(f.values.clockReads).toBe(0);
  expect(f.random.next()).toBe(1804289383); expect(f.clientStatic.updateInfoString).toBe("retained");
  expect(socket(f.server).poll()).toBeNull();
  f.reply('\\challenge\\\\motd\\unsolicited');
  expect(f.cvars.get("cl_motdString")?.value).toBe("previous");
});

test("responses require exact address and decimal challenge, retain duplicates, and ignore response-time cl_motd gating", async () => {
  const f = await fixture();
  await f.owner.request(f.guard); await receive(f.server);
  const address = socket(f.server).address;
  for (const from of [ { kind: "loopback" }, { ...address, port: address.port === 65535 ? 65534 : address.port + 1 },
    { ...address, host: [127, 0, 0, 2] } ] satisfies ClientPacketAddress[]) {
    f.reply('\\challenge\\1998333716\\motd\\forged', from);
  }
  for (const challenge of ["", "01998333716", "+1998333716", "1998333716junk", "-1998333716"]) {
    f.reply(`\\challenge\\${challenge}\\motd\\forged`);
  }
  expect(f.cvars.get("cl_motdString")?.value).toBe("previous"); expect(f.clientStatic.updateInfoString).toBe("");
  f.cvars.set("cl_motd", "0");
  f.reply('\\CHALLENGE\\1998333716\\MOTD\\first');
  expect(f.cvars.get("cl_motdString")?.value).toBe("first");
  f.clientStatic.phase = "disconnected";
  f.reply('\\challenge\\1998333716\\motd\\second');
  expect(f.cvars.get("cl_motdString")?.value).toBe("second");
  f.reply('\\challenge\\1998333716\\unused\\value');
  expect(f.cvars.get("cl_motdString")?.value).toBe("");
});

test("each enabled request resolves again and supersedes the prior challenge without clearing the MOTD", async () => {
  const f = await fixture();
  await f.owner.request(f.guard); await receive(f.server);
  f.reply('\\challenge\\1998333716\\motd\\retained');
  const retained = f.clientStatic.updateInfoString;
  await f.owner.request(f.guard);
  expect(decodeConnectionless((await receive(f.server)).payload, "server").arguments[0]).toBe(
    '\\version\\Q3 1.32b linux-ts fixture\\renderer\\Controlled renderer\\challenge\\-27636575');
  expect(f.resolutions).toHaveLength(2); expect(f.clientStatic.updateInfoString).toBe(retained);
  f.reply('\\challenge\\1998333716\\motd\\old');
  expect(f.cvars.get("cl_motdString")?.value).toBe("retained");
  f.reply('\\challenge\\-27636575\\motd\\new');
  expect(f.cvars.get("cl_motdString")?.value).toBe("new");
});

test("failed DNS invalidates the old address, preserves strings and random, and retries on the next request", async () => {
  const f = await fixture();
  await f.owner.request(f.guard); await receive(f.server);
  f.reply('\\challenge\\1998333716\\motd\\retained');
  const resolve = f.io.resolveAddress.bind(f.io);
  let failures = 0;
  f.io.resolveAddress = async () => { failures++; return null; };
  await f.owner.request(f.guard); await f.owner.request(f.guard);
  expect(failures).toBe(2); expect(f.prints.slice(-4)).toEqual([
    "Resolving update.quake3arena.com\n", "Couldn't resolve address\n",
    "Resolving update.quake3arena.com\n", "Couldn't resolve address\n"]);
  expect(f.values.clockReads).toBe(1);
  f.reply('\\challenge\\1998333716\\motd\\invalidated');
  expect(f.cvars.get("cl_motdString")?.value).toBe("retained");
  f.io.resolveAddress = resolve;
  await f.owner.request(f.guard); await receive(f.server);
  f.reply('\\challenge\\-27636575\\motd\\retried');
  expect(f.cvars.get("cl_motdString")?.value).toBe("retried");
});

test("renderer and version use source info filtering, omission and overflow diagnostics", async () => {
  const f = await fixture();
  f.values.renderer = "";
  await f.owner.request(f.guard);
  expect(decodeConnectionless((await receive(f.server)).payload, "server").arguments[0]).toBe(
    '\\version\\Q3 1.32b linux-ts fixture\\challenge\\1998333716');
  f.values.renderer = "bad;renderer";
  f.cvars.set("version", "v".repeat(1023), true);
  await f.owner.request(f.guard);
  expect(decodeConnectionless((await receive(f.server)).payload, "server").arguments[0]).toBe('\\challenge\\-27636575');
  expect(f.prints.slice(-3)).toEqual(["Can't use keys or values with a semicolon\n",
    "Com_sprintf: overflow of 1032 in 1024\n", "Info string length exceeded\n"]);
});

test("real packet decoding preserves source percent replacement, first duplicate keys and line truncation", async () => {
  const f = await fixture();
  await f.owner.request(f.guard); await receive(f.server);
  f.reply('\\challenge\\1998333716\\motd\\100%\u00e9\\motd\\ignored');
  expect(f.cvars.get("cl_motdString")?.value).toBe("100.é");
  const info = '\\challenge\\1998333716\\motd\\' + "x".repeat(2000);
  f.reply(info);
  // MSG_ReadStringLine retains 1023 bytes; the 'MoTd "' prefix uses six.
  expect(f.clientStatic.updateInfoString).toBe(info.slice(0, 1017));
  expect(f.cvars.get("cl_motdString")?.value).toBe("x".repeat(1017 - '\\challenge\\1998333716\\motd\\'.length));
});

test("new client-static owner rejects the previous response even though cvar state survives", async () => {
  const f = await fixture();
  await f.owner.request(f.guard); await receive(f.server);
  f.reply('\\challenge\\1998333716\\motd\\retained');
  const replacement = new ClientMotd(f.options);
  replacement.packet(socket(f.server).address,
    decodeConnectionless(encodeConnectionlessText('motd "\\challenge\\1998333716\\motd\\stale"\n'), "client"));
  expect(f.cvars.get("cl_motdString")?.value).toBe("retained");
});

test("retired DNS work cannot publish a new address or consume random and clock", async () => {
  const f = await fixture();
  const pending: { finish: ((value: Ipv4Address | null) => void) | null } = { finish: null };
  f.io.resolveAddress = () => new Promise(resolve => { pending.finish = resolve; });
  const request = f.owner.request(f.guard);
  const finish = pending.finish;
  if (finish === null) throw new Error("Missing pending controlled DNS lookup");
  f.values.current = false; finish(socket(f.server).address);
  await expect(request).rejects.toThrow("Retired client operation");
  expect(f.values.clockReads).toBe(0); expect(f.random.next()).toBe(1804289383);
  expect(socket(f.server).poll()).toBeNull();
  expect(f.prints).toEqual(["Resolving update.quake3arena.com\n"]);
  f.reply('\\challenge\\\\motd\\stale');
  expect(f.cvars.get("cl_motdString")?.value).toBe("previous");
});

test("disabled UDP still creates the challenge and permits a matching response", async () => {
  const f = await fixture();
  f.io.close();
  await f.owner.request(f.guard);
  f.reply('\\challenge\\1998333716\\motd\\valid');
  expect(f.cvars.get("cl_motdString")?.value).toBe("valid");
  expect(f.values.clockReads).toBe(1); expect(socket(f.server).poll()).toBeNull();
});
