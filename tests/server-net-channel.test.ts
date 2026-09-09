import { describe, expect, test } from "bun:test";
import { CommonError } from "../src/core/common-error.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import type { Product } from "../src/shared/definitions.ts";
import { UdpTransport } from "../src/platform/network.ts";
import type { Ipv4Address } from "../src/platform/network.ts";
import { encodeClientMessage } from "../src/protocol/client-message.ts";
import { decodeConnectionless, encodeConnectionlessText } from "../src/protocol/connectionless.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { MessageReader, MessageWriter } from "../src/protocol/message.ts";
import { FRAGMENT_SIZE, Netchannel, xorClientMessage, xorServerMessage } from "../src/protocol/netchan.ts";
import { ServerOpcode, decodeServerMessage, encodeServerMessage } from "../src/protocol/server-message.ts";
import type { ServerMessageContext } from "../src/protocol/server-message.ts";
import { ServerNetChannelRuntime } from "../src/server/net-channel.ts";
import type { ServerNetChannelHost, ServerPacketAddress } from "../src/server/net-channel.ts";
import { ServerClient, ServerClientPhase, ServerStaticState } from "../src/server/state.ts";

function firstPacket(channel: Netchannel, payload: Uint8Array): Uint8Array {
  const packets: Uint8Array[] = [], traces: string[] = [];
  channel.beginTransmit(payload, { send: packet => { packets.push(packet); }, trace: text => { traces.push(text); } });
  const packet = packets[0];
  if (packet === undefined || packets.length !== 1 || traces.length !== 1) throw new Error("Expected one delivered datagram and trace");
  return packet;
}

test("server host keeps the actual sender and trace synchronously typed", () => {
  const asyncSendAccepted: ((to: ServerPacketAddress, payload: Uint8Array) => Promise<void>) extends ServerNetChannelHost["sendPacket"] ? true : false = false;
  const asyncTraceAccepted: ((message: string) => Promise<void>) extends ServerNetChannelHost["tracePacket"] ? true : false = false;
  const asyncDebugAccepted: ((text: string) => Promise<void>) extends ServerNetChannelHost["debugPrint"] ? true : false = false;
  expect(asyncSendAccepted).toBe(false); expect(asyncTraceAccepted).toBe(false); expect(asyncDebugAccepted).toBe(false);
});

function slot<T>(items: readonly T[], index: number): T { const item = items[index]; if (item === undefined) throw new Error(`Missing fixture slot ${index}`); return item; }
function address(port = 27960, lastOctet = 1): Ipv4Address { return { kind: "ipv4", host: [127, 0, 0, lastOctet], port }; }
function context(messageNumber = 1): ServerMessageContext {
  return { product: "baseq3", messageNumber, reliableSequence: 100, serverCommandSequence: 0, parseEntitiesNumber: 0, baseline: () => null, history: () => null };
}
function smallMessage(text = "print hello"): Uint8Array { return encodeServerMessage(0, [{ kind: "command", sequence: 1, text }], context()); }
function largeMessage(): Uint8Array {
  const value = Array.from({ length: 7000 }, (_, i) => String.fromCharCode(33 + ((i * 53) % 90))).join("");
  const payload = encodeServerMessage(0, [{ kind: "gamestate", commandSequence: 0, clientNumber: 0, checksumFeed: 123,
    entries: [{ kind: "configstring", index: 0, value }] }], context());
  expect(payload.length).toBeGreaterThan(4 * FRAGMENT_SIZE); return payload;
}
function fixture(count = 2) {
  const state = new ServerStaticState({ product: "baseq3", maxClients: count, dedicated: true }); state.time = 5000;
  const packets: { to: ServerPacketAddress; payload: Uint8Array }[] = [], executed: string[] = [], prints: string[] = [], debug: string[] = [], oob: string[] = [];
  const host: ServerNetChannelHost = {
    debugPrint: text => { debug.push(text); },
    tracePacket: message => { expect(message).toMatch(/^server send /); },
    sendPacket: (to, payload) => { packets.push({ to, payload: new Uint8Array(payload) }); },
    connectionless: async (_from, payload) => { oob.push(decodeConnectionless(payload, "server").command); },
    *executeClientMessage(client, reader): CallSteps {
      expect(client.lastPacketTime).toBe(state.time);
      const header = reader.readHeader(); executed.push(`header:${client.slot}:${header.serverId}:${header.reliableAcknowledge}`);
      while (true) { const part = reader.next(); if (part.kind !== "command") break; executed.push(part.command.text); }
    }, print: text => { prints.push(text); },
  };
  const runtime = new ServerNetChannelRuntime(state, host);
  const client = slot(state.clients, 0); client.challenge = 0x12345678;
  client.connection = { kind: "initialized", phase: ServerClientPhase.Active, address: address(), netchan: new Netchannel("server", 2222) };
  return { state, runtime, host, client, packets, executed, prints, debug, oob, channel: client.connection.netchan };
}
function clientPayload(client: ServerClient, text = "say hello", acknowledge = 0): Uint8Array {
  const message = encodeClientMessage({ header: { serverId: 123, messageAcknowledge: 0, reliableAcknowledge: acknowledge },
    commands: [{ sequence: 1, text }], movement: null }, { checksumFeed: 0, serverCommand: sequence => client.reliable.lookupMasked(sequence) });
  return xorClientMessage(message, client.challenge, sequence => client.reliable.lookupMasked(sequence));
}
function finish(runtime: ServerNetChannelRuntime, client: ServerClient): void {
  const connection = client.connection; if (connection.kind !== "initialized") throw new Error("Missing channel");
  while (connection.netchan.hasUnsentFragments) runtime.transmitNextFragment(client);
}

test("receive diagnostics follow NAT fix-up, then read the live matched address at each drop print", async () => {
  const f = fixture(), peer = new Netchannel("client", 2222), settings = { packets: true, drop: true };
  firstPacket(peer, clientPayload(f.client)); firstPacket(peer, clientPayload(f.client));
  const packet = firstPacket(peer, clientPayload(f.client));
  const runtime = new ServerNetChannelRuntime(f.state, f.host, {
    get showPackets() { return settings.packets; }, get showDrop() { return settings.drop; },
    print: text => {
      f.prints.push(text);
      if (text.startsWith("server recv")) {
        settings.packets = false;
        if (f.client.connection.kind !== "initialized") throw new Error("Missing actual routed connection");
        f.client.connection.address = address(28002);
      }
    },
  });
  await runtime.packetEvent(address(27962), packet);
  expect(f.prints).toEqual(["SV_PacketEvent: fixing up a translated port\n",
    `server recv ${String(packet.length).padStart(4)} : s=3\n`, "127.0.0.1:28002:Dropped 2 packets at 3\n"]);
  expect(f.channel.incomingSequence).toBe(3); expect(f.executed).toContain("say hello");
  await runtime.packetEvent(address(28002), packet);
  expect(f.prints.at(-1)).toBe("127.0.0.1:28002:Out of order packet 3 at 3\n");
  settings.drop = false;
  const count = f.prints.length;
  await runtime.packetEvent(address(28002), packet);
  expect(f.prints).toHaveLength(count);
});

for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  test(`${product}: throwing actual delivery retains the complete first fragment and retries through loopback`, () => {
    const state = new ServerStaticState({ product, maxClients: 1, dedicated: true });
    const client = slot(state.clients, 0), channel = new Netchannel("server", 12), loop = new LoopbackTransport(), traces: string[] = [];
    client.connection = { kind: "initialized", phase: ServerClientPhase.Active, address: { kind: "loopback" }, netchan: channel };
    const failure = new CommonError("drop", "controlled delivery abort");
    let observedRemaining = -1, caught: unknown;
    const host: ServerNetChannelHost = {
      sendPacket: () => { observedRemaining = channel.remainingUnsentBytes; throw failure; },
      tracePacket: text => { traces.push(text); },
      debugPrint: () => { throw new Error("Unexpected queue diagnostic"); },
      connectionless: async () => { throw new Error("Unexpected connectionless work"); },
      executeClientMessage: () => { throw new Error("Unexpected client command work"); },
      print: () => { throw new Error("Unexpected routing diagnostic"); },
    };
    const runtime = new ServerNetChannelRuntime(state, host);
    try { runtime.transmit(client, { kind: "complete", payload: new Uint8Array(FRAGMENT_SIZE + 1) }); }
    catch (error) { caught = error; }
    expect(caught).toBe(failure); expect(channel.outgoingSequence).toBe(1); expect(channel.hasUnsentFragments).toBe(true);
    expect(observedRemaining).toBe(1301); expect(channel.remainingUnsentBytes).toBe(1301); expect(traces).toEqual([]);
    host.sendPacket = (_to, packet) => { loop.send("server", packet); };
    runtime.transmitNextFragment(client);
    const received = loop.poll("client"); if (received === null) throw new Error("Missing actual retry datagram");
    expect(new Netchannel("client", 12).receive(received.payload).kind).toBe("fragment");
    expect(traces).toEqual(["server send 1308 : s=1 fragment=0,1300\n"]);
  });
}

test("failed final-fragment trace keeps queued identity; failed queued normal send commits sequence without shifting queue", () => {
  const f = fixture(), traces: string[] = [], failure = new CommonError("drop", "trace abort");
  f.runtime.transmit(f.client, { kind: "complete", payload: new Uint8Array(1301) });
  f.host.tracePacket = text => { traces.push(text); throw failure; };
  const queued = smallMessage();
  expect(() => f.runtime.transmit(f.client, { kind: "complete", payload: queued })).toThrow(failure);
  const retained = slot(f.client.queuedMessages, 0);
  expect(retained).toEqual(queued); expect(f.channel.remainingUnsentBytes).toBe(1); expect(f.channel.outgoingSequence).toBe(1);
  f.host.tracePacket = text => { traces.push(text); };
  f.host.sendPacket = (_to, packet) => {
    expect(f.client.queuedMessages[0]).toBe(retained);
    if ((new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(0, true) & 0x80000000) === 0) throw failure;
    f.packets.push({ to: address(), payload: packet });
  };
  expect(() => f.runtime.transmitNextFragment(f.client)).toThrow(failure);
  expect(f.channel.hasUnsentFragments).toBe(false); expect(f.channel.outgoingSequence).toBe(3);
  expect(f.client.queuedMessages).toHaveLength(1); expect(f.client.queuedMessages[0]).toBe(retained);
  expect(traces).toEqual(["server send    9 : s=1 fragment=1300,1\n", "server send    9 : s=1 fragment=1300,1\n"]);
});

test("a reused human channel drains retained fragments and queued text into the bot packet sink", () => {
  const f = fixture(), traces: string[] = [];
  f.host.tracePacket = text => { traces.push(text); };
  f.runtime.transmit(f.client, { kind: "complete", payload: new Uint8Array(FRAGMENT_SIZE * 2) });
  f.runtime.transmit(f.client, { kind: "complete", payload: smallMessage() });
  expect(f.packets).toHaveLength(2); expect(f.channel.hasUnsentFragments).toBe(true);
  expect(f.channel.remainingUnsentBytes).toBe(0); expect(f.client.queuedMessages).toHaveLength(1);
  const connection = f.client.connection;
  if (connection.kind !== "initialized") throw new Error("Missing retained human channel");
  connection.phase = ServerClientPhase.Free;
  connection.address = { kind: "bot" };
  connection.phase = ServerClientPhase.Active;
  f.runtime.transmitNextFragment(f.client);
  expect(connection.netchan).toBe(f.channel); expect(f.channel.hasUnsentFragments).toBe(false);
  expect(f.channel.outgoingSequence).toBe(3); expect(f.client.queuedMessages).toHaveLength(0);
  expect(f.packets).toHaveLength(2);
  expect(traces[2]).toBe("server send    8 : s=1 fragment=2600,0\n");
  expect(traces[3]).toMatch(/server send .* : s=2 ack=0\n/);
});

test("a source-zero bot channel retains its client role while discarded sends advance its sequence", () => {
  const f = fixture(), traces: string[] = [], channel = Netchannel.sourceZero();
  f.host.tracePacket = text => { traces.push(text); };
  f.client.connection = { kind: "initialized", phase: ServerClientPhase.Active, address: { kind: "bot" }, netchan: channel };
  f.runtime.transmit(f.client, { kind: "complete", payload: smallMessage() });
  expect(channel.role).toBe("client"); expect(channel.outgoingSequence).toBe(1);
  expect(f.packets).toHaveLength(0); expect(traces).toHaveLength(1);
  expect(traces[0]).toMatch(/client send .* : s=0 ack=0\n/);
});
function decodePackets(packets: readonly { payload: Uint8Array }[], challenge: number, command: string): Uint8Array[] {
  const receiver = new Netchannel("client"), payloads: Uint8Array[] = [];
  for (const packet of packets) { const result = receiver.receive(packet.payload); if (result.kind === "rejected") throw new Error(result.reason);
    if (result.kind === "accepted") payloads.push(xorServerMessage(result.payload, challenge, result.sequence, command)); }
  return payloads;
}

describe("source server transmission queue", () => {
  test("complete datagram hashes and one-message dequeue match untouched native server channel", () => {
    const f = fixture(), text = Array.from({ length: 800 }, (_, i) => String.fromCharCode(33 + (i * 53) % 90)).join("");
    const initial = new MessageWriter(); initial.writeLong(0);
    for (let i = 1; i <= 9; i++) { initial.writeByte(ServerOpcode.Command); initial.writeLong(i); initial.writeString(text); }
    f.client.lastClientCommandString = "initial";
    f.runtime.transmit(f.client, { kind: "writer", message: initial });
    f.runtime.transmit(f.client, { kind: "complete", payload: smallMessage("print queued") });
    f.runtime.transmit(f.client, { kind: "complete", payload: smallMessage("second queued") });
    f.client.lastClientCommandString = "later%\x80"; finish(f.runtime, f.client);
    const rows = f.packets.map(({ payload }) => {
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength), sequence = view.getUint32(0, true), fragmented = (sequence & 0x80000000) !== 0;
      let hash = 2166136261; for (const byte of payload) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
      return [sequence, fragmented ? view.getUint16(4, true) : -1, fragmented ? view.getUint16(6, true) : payload.length - 4, hash];
    });
    // /tmp/q3-protocol-reference-J7zdNO/server-channel-oracle.c includes untouched
    // msg.c/huffman.c/net_chan.c/sv_net_chan.c at dbe4ddb; Sys_SendPacket captures FNV-1a.
    expect(rows).toEqual([[2147483649, 0, 1300, 4205137867], [2147483649, 1300, 1300, 926864719],
      [2147483649, 2600, 1300, 1309690734], [2147483649, 3900, 1300, 1547797558], [2147483649, 5200, 1300, 2801377319],
      [2147483649, 6500, 1300, 1836255441], [2147483649, 7800, 203, 4232100941], [2, -1, 16, 2690355276]]);
    expect(f.client.queuedMessages.length).toBe(1); expect(f.channel.outgoingSequence).toBe(3);
  });

  test("both explicit EOF owners produce identical bytes and add exactly one terminal opcode", () => {
    const writer = new MessageWriter(); writer.writeLong(0); writer.writeByte(ServerOpcode.Command); writer.writeLong(1); writer.writeString("print hello");
    const a = fixture(), b = fixture();
    a.runtime.transmit(a.client, { kind: "writer", message: writer });
    b.runtime.transmit(b.client, { kind: "complete", payload: smallMessage() });
    expect(a.packets).toEqual(b.packets); expect(writer.toBytes()).toEqual(smallMessage());
    const decoded = slot(decodePackets(a.packets, a.client.challenge, ""), 0);
    expect(decodeServerMessage(decoded, context()).operations).toEqual([{ kind: "command", sequence: 1, text: "print hello" }]);
    const reader = new MessageReader(decoded); reader.readLong(); reader.readByte(); reader.readLong(); reader.readString();
    expect(reader.readByte()).toBe(ServerOpcode.Eof); expect(() => reader.readByte()).toThrow();
    expect(a.client.queuedMessages).toEqual([]);
    expect(a.debug).toEqual([]); expect(b.debug).toEqual([]);
  });

  test("actual transmit sequence and high/percent command bytes match the native XOR fixture", () => {
    const f = fixture(); for (let i = 0; i < 36; i++) firstPacket(f.channel, new Uint8Array());
    f.client.lastClientCommandString = "a%\x80";
    f.runtime.transmit(f.client, { kind: "complete", payload: Buffer.from("116a1eece80276743f82e5e5f13c85dd853ce198b33c9704", "hex") });
    // Untouched CL_Netchan_Decode/SV_Netchan_Encode fixture, challenge 0x12345678, sequence37.
    expect(Buffer.from(slot(f.packets, 0).payload).toString("hex")).toBe("25000000116a1eecd46238f89d7c7a261c138480b95caf1411c208c7");
  });

  test("queued plaintext is owned and encoded at later transmit time with the live command string", () => {
    const f = fixture(), large = largeMessage(), queued = smallMessage("print queued");
    const queueLengths: number[] = [], sequences: number[] = [];
    f.host.debugPrint = text => { f.debug.push(text); queueLengths.push(f.client.queuedMessages.length); sequences.push(f.channel.outgoingSequence); };
    const frame = slot(f.client.frames, 0); frame.messageSent = 101; frame.messageSize = 202;
    f.client.nextSnapshotTime = 303; f.client.reliableSent = 404; f.client.lastMessageNum = 505;
    f.client.lastClientCommandString = "initial"; f.runtime.transmit(f.client, { kind: "complete", payload: large });
    f.runtime.transmit(f.client, { kind: "complete", payload: queued });
    expect(f.client.queuedMessages).toEqual([queued]); queued.fill(0);
    f.client.lastClientCommandString = "later%\x80"; finish(f.runtime, f.client);
    expect(f.client.queuedMessages).toEqual([]); expect(f.channel.outgoingSequence).toBe(3);
    expect(f.debug).toEqual(["#462 SV_Netchan_Transmit: unsent fragments, stacked\n",
      "#462 Netchan_TransmitNextFragment: popping a queued message for transmit\n", "#462 Netchan_TransmitNextFragment: emptied queue\n"]);
    expect(queueLengths).toEqual([0, 1, 0]); expect(sequences).toEqual([1, 2, 3]);
    const receiver = new Netchannel("client"); let delivered = 0;
    for (const packet of f.packets) { const result = receiver.receive(packet.payload); if (result.kind !== "accepted") continue;
      const decoded = xorServerMessage(result.payload, f.client.challenge, result.sequence, result.sequence === 1 ? "initial" : "later%\x80");
      expect(decoded).toEqual(result.sequence === 1 ? large : smallMessage("print queued")); delivered++;
    }
    expect(delivered).toBe(2);
    expect([frame.messageSent, frame.messageSize, f.client.nextSnapshotTime, f.client.reliableSent, f.client.lastMessageNum]).toEqual([101, 202, 303, 404, 505]);
  });

  test("TransmitNextFragment pops one queued message, not the whole plaintext queue", () => {
    const f = fixture(); f.runtime.transmit(f.client, { kind: "complete", payload: largeMessage() });
    f.runtime.transmit(f.client, { kind: "complete", payload: smallMessage("first") });
    f.runtime.transmit(f.client, { kind: "complete", payload: smallMessage("second") });
    expect(f.client.queuedMessages.length).toBe(2); finish(f.runtime, f.client);
    expect(f.client.queuedMessages).toEqual([smallMessage("second")]); expect(f.channel.outgoingSequence).toBe(3);
    expect(f.debug).toEqual(["#462 SV_Netchan_Transmit: unsent fragments, stacked\n", "#462 SV_Netchan_Transmit: unsent fragments, stacked\n",
      "#462 Netchan_TransmitNextFragment: popping a queued message for transmit\n", "#462 Netchan_TransmitNextFragment: remaining queued message\n"]);
    expect(() => f.runtime.transmitNextFragment(f.client)).toThrow("No pending");
  });

  test("Transmit sending the final fragment leaves its new queue entry and exact-length terminator intact", () => {
    const f = fixture(), payload = new Uint8Array(FRAGMENT_SIZE);
    f.runtime.transmit(f.client, { kind: "complete", payload });
    expect(f.channel.hasUnsentFragments).toBe(true);
    f.runtime.transmit(f.client, { kind: "complete", payload: smallMessage() });
    expect(f.channel.hasUnsentFragments).toBe(false); expect(f.channel.outgoingSequence).toBe(2);
    expect(f.client.queuedMessages).toEqual([smallMessage()]); expect(f.packets.length).toBe(2);
    expect(Buffer.from(slot(f.packets, 1).payload).toString("hex")).toBe("0100008014050000");
    expect(() => f.runtime.transmitNextFragment(f.client)).toThrow("No pending");
    // Source's direct nonfragment path does not drain the leftover queue either.
    f.runtime.transmit(f.client, { kind: "complete", payload: smallMessage("new direct") });
    expect(f.client.queuedMessages).toEqual([smallMessage()]); expect(f.channel.outgoingSequence).toBe(3);
    expect(f.debug).toEqual(["#462 SV_Netchan_Transmit: unsent fragments, stacked\n"]);
  });

  test("source valid gamestate fragment loss/reordering is rejected until retransmitted in order", () => {
    const f = fixture(), plaintext = largeMessage(); f.runtime.transmit(f.client, { kind: "complete", payload: plaintext }); finish(f.runtime, f.client);
    const receiver = new Netchannel("client"); expect(receiver.receive(slot(f.packets, 0).payload).kind).toBe("fragment");
    expect(receiver.receive(slot(f.packets, 2).payload)).toEqual({ kind: "rejected", reason: "fragment-order" });
    let final: Uint8Array | null = null;
    for (const packet of f.packets.slice(1)) { const result = receiver.receive(packet.payload); if (result.kind === "accepted") final = xorServerMessage(result.payload, f.client.challenge, result.sequence, ""); }
    expect(final).toEqual(plaintext); if (final === null) throw new Error("Missing gamestate");
    expect(decodeServerMessage(final, context()).operations[0]?.kind).toBe("gamestate");
  });

  test("source EOF-only overflow retains the unfinished bytes and still transmits", () => {
    const f = fixture(), writer = new MessageWriter("bitstream", 4); writer.writeLong(0);
    const before = writer.toBytes(); expect(writer.overflowed).toBe(false);
    f.runtime.transmit(f.client, { kind: "writer", message: writer });
    expect(writer.overflowed).toBe(true); expect(writer.toBytes()).toEqual(before);
    expect(slot(decodePackets(f.packets, f.client.challenge, ""), 0)).toEqual(before);
    expect(f.channel.outgoingSequence).toBe(2);
  });

  test("foreign/uninitialized/wrong-role clients and oversized completed payloads fail before queue/send mutation", () => {
    const f = fixture(); expect(() => f.runtime.transmit(new ServerClient("baseq3", 0), { kind: "complete", payload: smallMessage() })).toThrow("does not belong");
    const other = slot(f.state.clients, 1); expect(() => f.runtime.transmit(other, { kind: "complete", payload: smallMessage() })).toThrow("uninitialized");
    other.connection = { kind: "initialized", phase: ServerClientPhase.Active, address: address(), netchan: new Netchannel("client") };
    expect(() => f.runtime.transmit(other, { kind: "complete", payload: smallMessage() })).toThrow("server netchannel");
    expect(() => f.runtime.transmit(f.client, { kind: "complete", payload: new Uint8Array(16385) })).toThrow("MAX_MSGLEN");
    expect(() => f.runtime.transmit(f.client, { kind: "writer", message: new MessageWriter("oob") })).toThrow("bitstream");
    expect(f.packets).toEqual([]); expect(f.client.queuedMessages).toEqual([]); expect(f.channel.outgoingSequence).toBe(1);
  });
});

describe("source SV_PacketEvent routing", () => {
  test("packet completion waits for sequenced execution and preserves admitted state on rejection", async () => {
    for (const reject of [false, true]) {
      const f = fixture(), gate = Promise.withResolvers<undefined>(), original = f.host.executeClientMessage;
      const failure = new Error("Sequenced game call rejected");
      f.host.executeClientMessage = function* (client, reader): CallSteps {
        f.executed.push("game:entered");
        yield () => gate.promise;
        yield* original(client, reader);
      };
      const pending = f.runtime.packetEvent(address(28000), firstPacket(new Netchannel("client", 2222), clientPayload(f.client)));
      expect(f.executed).toEqual(["game:entered"]);
      expect(f.client.lastPacketTime).toBe(5000); expect(f.channel.incomingSequence).toBe(1);
      expect(f.client.connection.kind === "initialized" && f.client.connection.address).toEqual(address(28000));
      if (reject) {
        gate.reject(failure); await expect(pending).rejects.toBe(failure);
        expect(f.executed).toEqual(["game:entered"]);
      } else {
        gate.resolve(undefined); await pending;
        expect(f.executed).toEqual(["game:entered", "header:0:123:0", "say hello"]);
      }
      expect(f.packets).toEqual([]);
    }
  });

  test("sequenced commands remain synchronous inside the awaited packet entry and thrown execution rejects", async () => {
    const f = fixture(), packet = firstPacket(new Netchannel("client", 2222), clientPayload(f.client));
    const pending = f.runtime.packetEvent(address(), packet);
    expect(f.executed).toEqual(["header:0:123:0", "say hello"]);
    expect(f.client.lastPacketTime).toBe(5000); await pending;
    const failed = fixture(), error = new Error("Client command failed");
    failed.host.executeClientMessage = () => { throw error; };
    await expect(failed.runtime.packetEvent(address(), firstPacket(new Netchannel("client", 2222), clientPayload(failed.client)))).rejects.toBe(error);
    expect(failed.client.lastPacketTime).toBe(5000); expect(failed.channel.incomingSequence).toBe(1);
  });

  test("connectionless routing occurs first and unknown qports receive exact OOB disconnect bytes", async () => {
    const f = fixture(); await f.runtime.packetEvent(address(1234), encodeConnectionlessText("getchallenge"));
    expect(f.oob).toEqual(["getchallenge"]); expect(f.client.lastPacketTime).toBe(0); expect(f.channel.incomingSequence).toBe(0);
    const unknown = firstPacket(new Netchannel("client", 2223), clientPayload(f.client)); await f.runtime.packetEvent(address(1234), unknown);
    expect(f.packets).toEqual([{ to: address(1234), payload: Buffer.from("ffffffff646973636f6e6e656374", "hex") }]);
    expect(f.executed).toEqual([]);
  });

  test("matching uses base address plus qport and updates NAT port before duplicate/invalid validation", async () => {
    const f = fixture(), sender = new Netchannel("client", 2222), packet = firstPacket(sender, clientPayload(f.client));
    await f.runtime.packetEvent(address(1000), packet); expect(f.executed).toEqual(["header:0:123:0", "say hello"]); expect(f.client.lastPacketTime).toBe(5000);
    f.state.time = 6000; await f.runtime.packetEvent(address(1001), packet);
    expect(f.client.connection.kind === "initialized" && f.client.connection.address).toEqual(address(1001));
    expect(f.client.lastPacketTime).toBe(5000); expect(f.executed.length).toBe(2); expect(f.channel.incomingSequence).toBe(1);
    const malformed = packet.slice(0, 6); new DataView(malformed.buffer).setUint32(0, 0x80000002, true); await f.runtime.packetEvent(address(1002), malformed);
    expect(f.client.connection.kind === "initialized" && f.client.connection.address).toEqual(address(1002)); expect(f.client.lastPacketTime).toBe(5000);
    expect(f.prints).toEqual(Array.from({ length: 3 }, () => "SV_PacketEvent: fixing up a translated port\n"));
    await f.runtime.packetEvent(address(1002, 2), packet); expect(f.packets.length).toBe(1);
  });

  test("first matching slot includes zombies, consumes channel, and does not execute or refresh time", async () => {
    const f = fixture(); if (f.client.connection.kind !== "initialized") throw new Error("Missing channel"); f.client.connection.phase = ServerClientPhase.Zombie;
    const second = slot(f.state.clients, 1); second.connection = { kind: "initialized", phase: ServerClientPhase.Active, address: address(), netchan: new Netchannel("server", 2222) };
    const sender = new Netchannel("client", 2222); await f.runtime.packetEvent(address(1000), firstPacket(sender, clientPayload(f.client)));
    expect(f.channel.incomingSequence).toBe(1); expect(f.client.lastPacketTime).toBe(0); expect(f.executed).toEqual([]); expect(second.connection.netchan.incomingSequence).toBe(0);
    f.client.connection.phase = ServerClientPhase.Free; await f.runtime.packetEvent(address(), firstPacket(sender, clientPayload(second)));
    expect(second.connection.netchan.incomingSequence).toBe(2); expect(f.executed).toEqual(["header:1:123:0", "say hello"]);
  });

  test("fragmented client payloads are executed only after reassembly, with loss and duplicate suppression", async () => {
    const f = fixture(), writer = new MessageWriter(); writer.writeLong(123); writer.writeLong(0); writer.writeLong(0);
    for (let i = 1; i < 10; i++) { writer.writeByte(4); writer.writeLong(i); writer.writeString(`say ${"text".repeat(200)}`); }
    writer.writeByte(5); const encoded = xorClientMessage(writer.toBytes(), f.client.challenge, () => ""), sender = new Netchannel("client", 2222), packets = sender.transmit(encoded);
    expect(packets.length).toBeGreaterThan(2); await f.runtime.packetEvent(address(), slot(packets, 0)); expect(f.executed).toEqual([]);
    await f.runtime.packetEvent(address(), slot(packets, 2)); expect(f.executed).toEqual([]); expect(f.client.lastPacketTime).toBe(0);
    for (const packet of packets.slice(1)) await f.runtime.packetEvent(address(), packet);
    expect(f.executed.length).toBe(10); expect(f.client.lastPacketTime).toBe(5000);
    f.state.time = 7000; for (const packet of packets) await f.runtime.packetEvent(address(), packet);
    expect(f.executed.length).toBe(10); expect(f.client.lastPacketTime).toBe(5000);
  });

  test("XOR uses raw signed/future reliable ring slots before client admission", async () => {
    for (const acknowledge of [-1, 127]) {
      const f = fixture(); for (let i = 1; i <= 64; i++) f.client.reliable.add(`server command ${i}`);
      const writer = new MessageWriter(); writer.writeLong(123); writer.writeLong(10); writer.writeLong(acknowledge); writer.writeByte(4); writer.writeLong(1); writer.writeString("say masked"); writer.writeByte(5);
      const payload = xorClientMessage(writer.toBytes(), f.client.challenge, sequence => f.client.reliable.lookupMasked(sequence));
      await f.runtime.packetEvent(address(), firstPacket(new Netchannel("client", 2222), payload));
      expect(f.executed).toEqual([`header:0:123:${acknowledge}`, "say masked"]); expect(f.client.reliable.acknowledge).toBe(0);
    }
  });

  test("truncated qport reproduces the source masked -1 lookup without reading outside packet", async () => {
    const f = fixture(); f.client.connection = { kind: "initialized", phase: ServerClientPhase.Active, address: address(), netchan: new Netchannel("server", 65535) };
    await f.runtime.packetEvent(address(3333), Uint8Array.of(1, 0, 0, 0, 4));
    expect(f.client.connection.address).toEqual(address(3333)); expect(f.packets).toEqual([]); expect(f.executed).toEqual([]);
  });

  test("actual loopback transport carries source server messages and incoming client commands", async () => {
    const f = fixture(), loop = new LoopbackTransport(); f.client.connection = { kind: "initialized", phase: ServerClientPhase.Active, address: { kind: "loopback" }, netchan: new Netchannel("server", 2222) };
    const runtime = new ServerNetChannelRuntime(f.state, { ...f.host, sendPacket: (to, payload) => { expect(to.kind).toBe("loopback"); loop.send("server", payload); } });
    runtime.transmit(f.client, { kind: "complete", payload: smallMessage() });
    const outbound = loop.poll("client"); if (outbound === null) throw new Error("Missing loopback server packet");
    expect(slot(decodePackets([outbound], f.client.challenge, ""), 0)).toEqual(smallMessage());
    loop.send("client", firstPacket(new Netchannel("client", 2222), clientPayload(f.client))); const inbound = loop.poll("server");
    if (inbound === null) throw new Error("Missing loopback client packet"); await runtime.packetEvent(inbound.from, inbound.payload);
    expect(f.executed).toEqual(["header:0:123:0", "say hello"]);
  });

  test("actual localhost UDP adapters route connectionless and sequenced packets", async () => {
    const server = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 }), client = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    try {
      const f = fixture(); if (f.client.connection.kind !== "initialized") throw new Error("Missing channel"); f.client.connection.address = client.address;
      const runtime = new ServerNetChannelRuntime(f.state, { ...f.host, sendPacket: (to, payload) => { if (to.kind !== "ipv4") throw new Error("Unexpected loopback destination"); server.send(to, payload); } });
      client.send(server.address, encodeConnectionlessText("getinfo probe"));
      client.send(server.address, firstPacket(new Netchannel("client", 2222), clientPayload(f.client)));
      const deadline = performance.now() + 2000;
      while ((f.oob.length === 0 || f.executed.length === 0) && performance.now() < deadline) {
        const event = server.poll(); if (event?.kind === "error") throw event.error;
        if (event?.kind === "packet") await runtime.packetEvent(event.from, event.payload); else await Bun.sleep(2);
      }
      expect(f.oob).toEqual(["getinfo"]); expect(f.executed).toEqual(["header:0:123:0", "say hello"]);
      runtime.transmit(f.client, { kind: "complete", payload: smallMessage() });
      let received = false;
      while (!received && performance.now() < deadline) { const event = client.poll(); if (event?.kind === "error") throw event.error;
        if (event?.kind === "packet") { expect(slot(decodePackets([event], f.client.challenge, ""), 0)).toEqual(smallMessage()); received = true; } else await Bun.sleep(2); }
      expect(received).toBe(true);
    } finally { client.close(); server.close(); }
  });
});
