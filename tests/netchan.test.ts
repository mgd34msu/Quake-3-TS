import { describe, expect, test } from "bun:test";
import { CommonError } from "../src/core/common-error.ts";
import { SourceMessageState } from "../src/protocol/message.ts";
import { FRAGMENT_SIZE, Netchannel, xorClientMessage, xorServerMessage } from "../src/protocol/netchan.ts";
import type { ChannelDelivery, ChannelDiagnostics, ChannelRole } from "../src/protocol/netchan.ts";

function firstPacket(channel: Netchannel, payload: Uint8Array): Uint8Array {
  const packets: Uint8Array[] = [], traces: string[] = [];
  channel.beginTransmit(payload, { send: packet => { packets.push(packet); }, trace: text => { traces.push(text); } });
  const packet = packets[0];
  if (packet === undefined || packets.length !== 1 || traces.length !== 1) throw new Error("Expected one delivered datagram and trace");
  return packet;
}

function nextPacket(channel: Netchannel): Uint8Array | null {
  const packets: Uint8Array[] = [], traces: string[] = [];
  const sent = channel.transmitNextFragment({ send: packet => { packets.push(packet); }, trace: text => { traces.push(text); } });
  if (!sent) { expect(packets).toEqual([]); expect(traces).toEqual([]); return null; }
  const packet = packets[0];
  if (packet === undefined || packets.length !== 1 || traces.length !== 1) throw new Error("Expected one delivered fragment and trace");
  return packet;
}

function packetAt(packets: readonly Uint8Array[], index: number): Uint8Array {
  const packet = packets[index];
  if (packet === undefined) throw new Error(`Missing test packet ${index}`);
  return packet;
}

describe("source synchronous packet delivery", () => {
  test("common message accounting includes each fragment header and byte before delivery", () => {
    const prints: string[] = [], state = new SourceMessageState(text => { prints.push(text); });
    const channel = new Netchannel("client", 42), packets: Uint8Array[] = [], traces: string[] = [];
    const delivery: ChannelDelivery = { sourceState: state,
      send: packet => { packets.push(packet); expect(state.oldsize).toBe(packets.reduce((sum, item) => sum + item.length * 8, 0)); },
      trace: text => { traces.push(text); } };
    channel.beginTransmit(new Uint8Array(FRAGMENT_SIZE), delivery);
    channel.transmitNextFragment(delivery);
    expect(packets.map(packet => packet.length)).toEqual([1310, 10]);
    expect(state.overflows).toBe(0);
    expect(prints).toEqual([]);
    expect(traces).toHaveLength(2);
  });
  test("delivery signatures reject Promise-returning send and trace functions", () => {
    const asyncSendAccepted: ((packet: Uint8Array) => Promise<void>) extends ChannelDelivery["send"] ? true : false = false;
    const asyncTraceAccepted: ((message: string) => Promise<void>) extends ChannelDelivery["trace"] ? true : false = false;
    const asyncPrintAccepted: ((message: string) => Promise<void>) extends ChannelDiagnostics["print"] ? true : false = false;
    expect(asyncSendAccepted).toBe(false); expect(asyncTraceAccepted).toBe(false); expect(asyncPrintAccepted).toBe(false);
  });
  for (const role of ["client", "server"] satisfies readonly ChannelRole[]) {
    for (const length of [1, 1301, 2601, 2600]) {
      test(`${role} ${length}: send and trace observe source progress before each fragment commit`, () => {
        const channel = new Netchannel(role, 123), peer = new Netchannel(role === "client" ? "server" : "client", 123);
        const payload = new Uint8Array(length).fill(17), events: string[] = [], lines: string[] = [];
        const accepted: Uint8Array[] = [];
        const delivery: ChannelDelivery = {
          send: packet => {
            events.push(`send:${channel.outgoingSequence}:${channel.remainingUnsentBytes}:${channel.hasUnsentFragments}`);
            const result = peer.receive(packet);
            if (result.kind === "accepted") accepted.push(result.payload);
            else expect(result.kind).toBe("fragment");
          },
          trace: line => { events.push(`trace:${channel.outgoingSequence}:${channel.remainingUnsentBytes}:${channel.hasUnsentFragments}`); lines.push(line); },
        };
        channel.beginTransmit(payload, delivery);
        while (channel.hasUnsentFragments) expect(channel.transmitNextFragment(delivery)).toBe(true);
        expect(accepted).toEqual([payload]); expect(channel.outgoingSequence).toBe(2);
        expect(channel.hasUnsentFragments).toBe(false);
        const remaining = length === 1 ? [0] : length === 1301 ? [1301, 1] : length === 2601 ? [2601, 1301, 1] : [2600, 1300, 0];
        expect(events).toEqual(remaining.flatMap(value => [`send:${length === 1 ? 2 : 1}:${value}:${length !== 1}`, `trace:${length === 1 ? 2 : 1}:${value}:${length !== 1}`]));
        const header = role === "client" ? 10 : 8;
        const fragments = length === 1301 ? [[0, 1300], [1300, 1]] : length === 2601 ? [[0, 1300], [1300, 1300], [2600, 1]] : [[0, 1300], [1300, 1300], [2600, 0]];
        expect(lines).toEqual(length === 1 ? [`${role} send ${String(role === "client" ? 7 : 5).padStart(4)} : s=1 ack=0\n`]
          : fragments.map(pair => { const start = pair[0], size = pair[1]; if (start === undefined || size === undefined) throw new Error("Incomplete expected fragment");
            return `${role} send ${String(header + size).padStart(4)} : s=1 fragment=${start},${size}\n`; }));
      });
    }
  }

  for (const phase of ["send", "trace"]) for (const length of [1, 1301, 2601, 2600]) {
    const count = length === 1 ? 1 : length === 1301 ? 2 : 3;
    for (let failingPacket = 0; failingPacket < count; failingPacket++) {
      test(`${phase} failure at ${length} packet ${failingPacket} preserves source partial state and exact error`, () => {
        for (const failure of [new CommonError("drop", "source stop"), new Error("managed delivery failure")]) {
          const channel = new Netchannel("server"), packets: Uint8Array[] = [], traces: string[] = [];
          let index = 0, caught: unknown, observed = -1;
          const delivery: ChannelDelivery = {
            send: packet => { observed = channel.remainingUnsentBytes; if (phase === "send" && index === failingPacket) throw failure; packets.push(packet); },
            trace: text => { if (phase === "trace" && index === failingPacket) throw failure; traces.push(text); index++; },
          };
          try { channel.beginTransmit(new Uint8Array(length), delivery); while (channel.hasUnsentFragments) channel.transmitNextFragment(delivery); }
          catch (error) { caught = error; }
          const remaining = length === 1 ? 0 : length - failingPacket * 1300;
          expect(caught).toBe(failure); expect(observed).toBe(remaining); expect(channel.remainingUnsentBytes).toBe(remaining);
          expect(channel.outgoingSequence).toBe(length === 1 ? 2 : 1); expect(channel.hasUnsentFragments).toBe(length !== 1);
          expect(packets.length).toBe(failingPacket + (phase === "trace" ? 1 : 0)); expect(traces.length).toBe(failingPacket);
          const retry: ChannelDelivery = { send: packet => { packets.push(packet); }, trace: text => { traces.push(text); } };
          if (length === 1) channel.beginTransmit(Uint8Array.of(5), retry);
          else while (channel.hasUnsentFragments) channel.transmitNextFragment(retry);
          expect(channel.outgoingSequence).toBe(length === 1 ? 3 : 2);
        }
      });
    }
  }

  test("delivery rejects only nested sends while actual receive and queries remain usable", () => {
    const channel = new Netchannel("server"), packets: Uint8Array[] = [], lines: string[] = [];
    const incoming = new Netchannel("client", 42).transmit(Uint8Array.of(5));
    const delivery: ChannelDelivery = {
      send: packet => {
        packets.push(packet); expect(channel.outgoingSequence).toBe(2);
        expect(channel.receive(packetAt(incoming, 0)).kind).toBe("accepted");
        expect(() => channel.beginTransmit(Uint8Array.of(9), delivery)).toThrow("reenter");
        expect(() => channel.transmitNextFragment(delivery)).toThrow("reenter");
        expect(() => channel.transmit(Uint8Array.of(9))).toThrow("reenter");
      }, trace: text => { lines.push(text); expect(() => channel.beginTransmit(Uint8Array.of(9), delivery)).toThrow("reenter"); },
    };
    channel.beginTransmit(Uint8Array.of(1), delivery);
    expect(packets.length).toBe(1); expect(lines).toEqual(["server send    5 : s=1 ack=1\n"]);
    expect(channel.transmit(Uint8Array.of(2))).toEqual([Uint8Array.of(2, 0, 0, 0, 2)]);
  });
});

describe("source netchannel receive diagnostics", () => {
  test("receive uses the event buffer limit for ordinary packets larger than the send buffer", () => {
    for (const role of ["client", "server"] satisfies readonly ChannelRole[]) for (const size of [1401, 16384]) {
      const receiver = new Netchannel(role, 42), packet = new Uint8Array(size).fill(17), lines: string[] = [];
      const header = role === "server" ? 6 : 4, view = new DataView(packet.buffer);
      view.setInt32(0, 3, true);
      if (role === "server") view.setUint16(4, 42, true);
      const diagnostics: ChannelDiagnostics = { showPackets: true, showDrop: false, remoteAddress: "loopback", print: text => { lines.push(text); } };
      const result = receiver.receive(packet, diagnostics);
      expect(result.kind).toBe("accepted");
      expect(result).toEqual({ kind: "accepted", sequence: 3,
        qport: role === "server" ? 42 : null, dropped: 2, payload: new Uint8Array(size - header).fill(17) });
      expect(receiver.incomingSequence).toBe(3);
      expect(receiver.receive(packet, diagnostics)).toEqual({ kind: "rejected", reason: "sequence" });
      expect(lines).toEqual([`${role} recv ${size} : s=3\n`, "loopback:Dropped 2 packets at 3\n",
        `${role} recv ${size} : s=3\n`, "loopback:Out of order packet 3 at 3\n"]);
    }
  });

  test("a fragment larger than the send buffer completes when its length is not FRAGMENT_SIZE", () => {
    for (const role of ["client", "server"] satisfies readonly ChannelRole[]) for (const size of [1401, 16384]) {
      const receiver = new Netchannel(role, 42), packet = new Uint8Array(size).fill(29), lines: string[] = [];
      const baseHeader = role === "server" ? 6 : 4, header = baseHeader + 4, view = new DataView(packet.buffer);
      const length = size - header;
      view.setUint32(0, 0x80000001, true);
      if (role === "server") view.setUint16(4, 42, true);
      view.setInt16(baseHeader, 0, true);
      view.setInt16(baseHeader + 2, length, true);
      const result = receiver.receive(packet, { showPackets: true, showDrop: false, remoteAddress: "loopback", print: text => { lines.push(text); } });
      expect(result.kind).toBe("accepted");
      expect(result).toEqual({ kind: "accepted", sequence: 1, qport: role === "server" ? 42 : null,
          dropped: 0, payload: new Uint8Array(length).fill(29) });
      expect(receiver.incomingSequence).toBe(1);
      expect(lines).toEqual([`${role} recv ${size} : s=1 fragment=0,${length}\n`]);
    }
  });

  test("nested receives during the drop print publish the retained drop count before the outer result", () => {
    for (const fragmented of [false, true]) for (const rejectedNested of [false, true]) {
      const receiver = new Netchannel("client"), lines: string[] = [];
      const packet = fragmented ? Uint8Array.of(3, 0, 0, 128, 0, 0, 1, 0, 17) : Uint8Array.of(3, 0, 0, 0, 17);
      const result = receiver.receive(packet, { showPackets: true, showDrop: false, remoteAddress: "loopback", print: text => {
        lines.push(text);
        if (text === "loopback:Dropped 2 packets at 3\n") {
          expect(receiver.incomingSequence).toBe(0);
          if (rejectedNested) {
            expect(receiver.receive(Uint8Array.of(5, 0, 0, 128, 1, 0, 0, 0)))
              .toEqual({ kind: "rejected", reason: "fragment-order" });
            expect(receiver.incomingSequence).toBe(0);
          } else {
            expect(receiver.receive(Uint8Array.of(1, 0, 0, 0, 29)))
              .toEqual({ kind: "accepted", sequence: 1, qport: null, dropped: 0, payload: Uint8Array.of(29) });
            expect(receiver.incomingSequence).toBe(1);
          }
        }
      } });
      expect(result).toEqual({ kind: "accepted", sequence: 3, qport: null,
        dropped: rejectedNested ? 4 : 0, payload: Uint8Array.of(17) });
      expect(receiver.incomingSequence).toBe(3);
      expect(lines).toEqual([fragmented ? "client recv    9 : s=3 fragment=0,1\n" : "client recv    5 : s=3\n",
        "loopback:Dropped 2 packets at 3\n"]);
    }
  });

  test("both roles show receives before independently gated sequence gaps and duplicates", () => {
    for (const role of ["client", "server"] satisfies readonly ChannelRole[]) {
      for (const showPackets of [false, true]) for (const showDrop of [false, true]) {
        const receiver = new Netchannel(role, 42), sender = new Netchannel(role === "client" ? "server" : "client", 42);
        const first = firstPacket(sender, Uint8Array.of(11)); firstPacket(sender, Uint8Array.of(22));
        const third = firstPacket(sender, Uint8Array.of(33)), lines: string[] = [];
        let addresses = 0;
        const diagnostics: ChannelDiagnostics = { showPackets, showDrop,
          get remoteAddress() { addresses++; return "127.0.0.1:27961"; }, print: text => { lines.push(text); } };
        expect(receiver.receive(first, diagnostics).kind).toBe("accepted");
        expect(receiver.receive(third, diagnostics)).toEqual({ kind: "accepted", sequence: 3,
          qport: role === "server" ? 42 : null, dropped: 1, payload: Uint8Array.of(33) });
        expect(receiver.receive(first, diagnostics)).toEqual({ kind: "rejected", reason: "sequence" });
        const size = role === "server" ? "   7" : "   5";
        expect(lines).toEqual([
          ...(showPackets ? [`${role} recv ${size} : s=1\n`, `${role} recv ${size} : s=3\n`] : []),
          ...(showDrop || showPackets ? ["127.0.0.1:27961:Dropped 1 packets at 3\n"] : []),
          ...(showPackets ? [`${role} recv ${size} : s=1\n`] : []),
          ...(showDrop || showPackets ? ["127.0.0.1:27961:Out of order packet 1 at 3\n"] : []),
        ]);
        expect(addresses).toBe(showDrop || showPackets ? 2 : 0);
      }
    }
  });

  test("every fragment reports its gap before fragment order or signed-length rejection", () => {
    const receiver = new Netchannel("client"), sender = new Netchannel("server"), lines: string[] = [];
    firstPacket(sender, Uint8Array.of(1));
    const fragments = sender.transmit(new Uint8Array(1301).fill(17));
    const first = packetAt(fragments, 0), last = packetAt(fragments, 1);
    const diagnostics: ChannelDiagnostics = { showPackets: true, showDrop: false, remoteAddress: "loopback", print: text => { lines.push(text); } };
    expect(receiver.receive(last, diagnostics)).toEqual({ kind: "rejected", reason: "fragment-order" });
    expect(receiver.receive(first, diagnostics)).toEqual({ kind: "fragment", sequence: 2, received: 1300 });
    expect(receiver.receive(Uint8Array.of(2, 0, 0, 128, 20, 5, 255, 255), diagnostics)).toEqual({ kind: "rejected", reason: "fragment-length" });
    expect(receiver.receive(last, diagnostics)).toEqual({ kind: "accepted", sequence: 2, qport: null, dropped: 1, payload: new Uint8Array(1301).fill(17) });
    expect(lines).toEqual([
      "client recv    9 : s=2 fragment=1300,1\n", "loopback:Dropped 1 packets at 2\n", "loopback:Dropped a message fragment\n",
      "client recv 1308 : s=2 fragment=0,1300\n", "loopback:Dropped 1 packets at 2\n",
      "client recv    8 : s=2 fragment=1300,-1\n", "loopback:Dropped 1 packets at 2\n", "loopback:illegal fragment length\n",
      "client recv    9 : s=2 fragment=1300,1\n", "loopback:Dropped 1 packets at 2\n",
    ]);
  });

  test("print effects precede live showdrop-or-showpackets reads and lazy address formatting", () => {
    const receiver = new Netchannel("client"), events: string[] = [];
    const values = { packets: true, drop: false, address: "before" };
    const diagnostics: ChannelDiagnostics = {
      get showPackets() { events.push("showpackets"); return values.packets; },
      get showDrop() { events.push("showdrop"); return values.drop; },
      get remoteAddress() { events.push("address"); return values.address; },
      print: text => {
        events.push(text);
        if (text.startsWith("client recv")) { values.packets = false; values.drop = true; values.address = "after"; }
      },
    };
    expect(receiver.receive(Uint8Array.of(2, 0, 0, 0, 17), diagnostics).kind).toBe("accepted");
    expect(events).toEqual(["showpackets", "client recv    5 : s=2\n", "showdrop", "address", "after:Dropped 1 packets at 2\n"]);
    events.length = 0; values.drop = false;
    expect(receiver.receive(Uint8Array.of(2, 0, 0, 0, 17), diagnostics).kind).toBe("rejected");
    expect(events).toEqual(["showpackets", "showdrop", "showpackets"]);
  });

  test("receive and drop print failures stop before sequence commit; reentry affects the later sequence check", () => {
    const packet = Uint8Array.of(3, 0, 0, 0, 17), failure = new CommonError("drop", "receive print stopped");
    for (const showPackets of [false, true]) {
      const receiver = new Netchannel("client");
      expect(() => receiver.receive(packet, { showPackets, showDrop: true, remoteAddress: "loopback", print: () => { throw failure; } })).toThrow(failure);
      expect(receiver.incomingSequence).toBe(0);
      expect(receiver.receive(packet)).toEqual({ kind: "accepted", sequence: 3, qport: null, dropped: 2, payload: Uint8Array.of(17) });
    }
    const receiver = new Netchannel("client"), lines: string[] = [];
    expect(receiver.receive(Uint8Array.of(1, 0, 0, 0, 11), {
      showPackets: true, showDrop: false, remoteAddress: "loopback", print: text => {
        lines.push(text);
        if (text.startsWith("client recv")) expect(receiver.receive(packet).kind).toBe("accepted");
      },
    })).toEqual({ kind: "rejected", reason: "sequence" });
    expect(lines).toEqual(["client recv    5 : s=1\n", "loopback:Out of order packet 1 at 3\n"]);
    expect(receiver.incomingSequence).toBe(3);
  });
});

describe("protocol 68 netchannel", () => {
  test("remaining source byte count keeps zero-length terminator distinct from idle", () => {
    const channel = new Netchannel("server");
    expect(channel.remainingUnsentBytes).toBe(0); expect(channel.hasUnsentFragments).toBe(false);
    firstPacket(channel, new Uint8Array(2600));
    expect(channel.remainingUnsentBytes).toBe(1300); expect(channel.hasUnsentFragments).toBe(true);
    nextPacket(channel); expect(channel.remainingUnsentBytes).toBe(0); expect(channel.hasUnsentFragments).toBe(true);
    nextPacket(channel); expect(channel.remainingUnsentBytes).toBe(0); expect(channel.hasUnsentFragments).toBe(false);
    firstPacket(channel, new Uint8Array(1301)); expect(channel.remainingUnsentBytes).toBe(1);
    nextPacket(channel); expect(channel.remainingUnsentBytes).toBe(0); expect(channel.hasUnsentFragments).toBe(false);
  });

  test("client sequence and qport header match little-endian source layout", () => {
    const client = new Netchannel("client", 0x1234);
    const packet = firstPacket(client, Uint8Array.of(0xde, 0xad));
    expect(packet).toEqual(Uint8Array.of(1, 0, 0, 0, 0x34, 0x12, 0xde, 0xad));
    expect(client.outgoingSequence).toBe(2);
    const server = new Netchannel("server", 0x1234);
    expect(server.receive(packet)).toEqual({ kind: "accepted", sequence: 1, qport: 0x1234, dropped: 0, payload: Uint8Array.of(0xde, 0xad) });
    expect(firstPacket(server, new Uint8Array())).toEqual(Uint8Array.of(1, 0, 0, 0));
  });

  test("every client fragment samples the live send qport while routing qport stays retained", () => {
    let port = 0x1234;
    const client = new Netchannel("client", 42, () => port);
    expect(firstPacket(client, new Uint8Array(1301)).subarray(4, 6)).toEqual(Uint8Array.of(0x34, 0x12));
    port = -1;
    const last = nextPacket(client);
    if (last === null) throw new Error("Missing fragment");
    expect(last.subarray(4, 6)).toEqual(Uint8Array.of(255, 255));
    port = 65536 + 73;
    expect(firstPacket(client, Uint8Array.of(1)).subarray(4, 6)).toEqual(Uint8Array.of(73, 0));
    expect(client.qport).toBe(42);
    const server = new Netchannel("server", 42, () => { throw new Error("Server must not sample qport"); });
    expect(firstPacket(server, new Uint8Array())).toEqual(Uint8Array.of(1, 0, 0, 0));
  });

  test("zero-length messages advance sequence and have no fragments", () => {
    const channel = new Netchannel("server");
    expect(channel.transmit(new Uint8Array())).toEqual([Uint8Array.of(1, 0, 0, 0)]);
    expect(channel.outgoingSequence).toBe(2);
    expect(channel.hasUnsentFragments).toBe(false);
    expect(nextPacket(channel)).toEqual(Uint8Array.of(2, 0, 0, 128, 0, 0, 0, 0));
    expect(channel.outgoingSequence).toBe(3);
  });

  test("1300-byte exact length requires a zero-length terminating fragment", () => {
    const sender = new Netchannel("client", 0x1234);
    const receiver = new Netchannel("server", 0x1234);
    const data = new Uint8Array(FRAGMENT_SIZE).fill(0x71);
    const first = firstPacket(sender, data);
    expect(first.slice(0, 10)).toEqual(Uint8Array.of(1, 0, 0, 128, 0x34, 0x12, 0, 0, 0x14, 5));
    expect(receiver.receive(first)).toEqual({ kind: "fragment", sequence: 1, received: 1300 });
    expect(sender.outgoingSequence).toBe(1);
    expect(receiver.incomingSequence).toBe(0);
    const last = nextPacket(sender);
    if (last === null) throw new Error("Missing terminating fragment");
    expect(last).toEqual(Uint8Array.of(1, 0, 0, 128, 0x34, 0x12, 0x14, 5, 0, 0));
    expect(receiver.receive(last)).toEqual({ kind: "accepted", sequence: 1, qport: 0x1234, dropped: 0, payload: data });
    expect(sender.outgoingSequence).toBe(2);
    expect(sender.hasUnsentFragments).toBe(false);
    expect(receiver.incomingSequence).toBe(1);
  });

  test("1299, 1301, 2600 and maximum-size messages reassemble", () => {
    for (const length of [1299, 1301, 2600, 16384]) {
      const sender = new Netchannel("server");
      const receiver = new Netchannel("client");
      const data = Uint8Array.from({ length }, (_, i) => (i * 71) & 255);
      const packets = sender.transmit(data);
      expect(packets.length).toBe(length < 1300 ? 1 : Math.floor(length / 1300) + 1);
      for (const [i, packet] of packets.entries()) {
        const result = receiver.receive(packet);
        if (i === packets.length - 1) expect(result).toEqual({ kind: "accepted", sequence: 1, qport: null, dropped: 0, payload: data });
        else expect(result.kind).toBe("fragment");
      }
    }
  });

  test("duplicates and older sequences reject, sequence gaps report drops", () => {
    const sender = new Netchannel("server");
    const receiver = new Netchannel("client");
    const first = firstPacket(sender, Uint8Array.of(1));
    firstPacket(sender, Uint8Array.of(2));
    const third = firstPacket(sender, Uint8Array.of(3));
    expect(receiver.receive(first).kind).toBe("accepted");
    expect(receiver.receive(first)).toEqual({ kind: "rejected", reason: "sequence" });
    expect(receiver.receive(third)).toEqual({ kind: "accepted", sequence: 3, qport: null, dropped: 1, payload: Uint8Array.of(3) });
    expect(receiver.receive(first)).toEqual({ kind: "rejected", reason: "sequence" });
  });

  test("out-of-order and duplicate fragments reject while contiguous prefix survives", () => {
    const sender = new Netchannel("server");
    const receiver = new Netchannel("client");
    const data = new Uint8Array(2601).fill(42);
    const packets = sender.transmit(data);
    expect(receiver.receive(packetAt(packets, 1))).toEqual({ kind: "rejected", reason: "fragment-order" });
    expect(receiver.receive(packetAt(packets, 0)).kind).toBe("fragment");
    expect(receiver.receive(packetAt(packets, 2))).toEqual({ kind: "rejected", reason: "fragment-order" });
    expect(receiver.receive(packetAt(packets, 0))).toEqual({ kind: "rejected", reason: "fragment-order" });
    expect(receiver.receive(packetAt(packets, 1)).kind).toBe("fragment");
    expect(receiver.receive(packetAt(packets, 2))).toEqual({ kind: "accepted", sequence: 1, qport: null, dropped: 0, payload: data });
    expect(receiver.receive(packetAt(packets, 2))).toEqual({ kind: "rejected", reason: "sequence" });
  });

  test("a new fragment sequence abandons the incomplete older message", () => {
    const sender = new Netchannel("server");
    const receiver = new Netchannel("client");
    const abandoned = sender.transmit(new Uint8Array(2601));
    receiver.receive(packetAt(abandoned, 0));
    const nextData = new Uint8Array(1301).fill(5);
    const next = sender.transmit(nextData);
    expect(receiver.receive(packetAt(next, 0))).toEqual({ kind: "fragment", sequence: 2, received: 1300 });
    expect(receiver.receive(packetAt(next, 1))).toEqual({ kind: "accepted", sequence: 2, qport: null, dropped: 1, payload: nextData });
  });

  test("malformed headers and negative or truncated fragment lengths reject", () => {
    const receiver = new Netchannel("client");
    for (const bytes of [[], [1], [1, 0, 0], [1, 0, 0, 128], [1, 0, 0, 128, 0, 0, 1]]) {
      expect(receiver.receive(Uint8Array.from(bytes))).toEqual({ kind: "rejected", reason: "malformed" });
    }
    expect(receiver.receive(new Uint8Array(16385))).toEqual({ kind: "rejected", reason: "malformed" });
    expect(receiver.receive(Uint8Array.of(1, 0, 0, 128, 0, 0, 255, 255))).toEqual({ kind: "rejected", reason: "fragment-length" });
    expect(receiver.receive(Uint8Array.of(1, 0, 0, 128, 0, 0, 1, 0))).toEqual({ kind: "rejected", reason: "fragment-length" });
    expect(receiver.receive(Uint8Array.of(1, 0, 0, 128, 255, 255, 0, 0))).toEqual({ kind: "rejected", reason: "fragment-order" });
    expect(() => new Netchannel("client", 65536)).toThrow("qport");
    expect(() => new Netchannel("server").transmit(new Uint8Array(16385))).toThrow("large");
  });

  test("reassembly rejects aggregate overflow and keeps the prefix for a fitting terminal fragment", () => {
    const receiver = new Netchannel("client"), lines: string[] = [];
    for (let i = 0; i < 13; i++) {
      const packet = new Uint8Array(1308).fill(42);
      const view = new DataView(packet.buffer);
      view.setUint32(0, 0x80000001, true);
      view.setUint16(4, i * 1300, true);
      view.setUint16(6, 1300, true);
      const result = receiver.receive(packet, i === 12
        ? { showPackets: true, showDrop: false, remoteAddress: "loopback", print: text => { lines.push(text); } } : null);
      if (i === 12) expect(result).toEqual({ kind: "rejected", reason: "fragment-length" });
      else expect(result.kind).toBe("fragment");
    }
    expect(receiver.incomingSequence).toBe(0);
    expect(lines).toEqual(["client recv 1308 : s=1 fragment=15600,1300\n", "loopback:illegal fragment length\n"]);
    const last = new Uint8Array(788).fill(29), view = new DataView(last.buffer);
    view.setUint32(0, 0x80000001, true);
    view.setUint16(4, 15600, true);
    view.setUint16(6, 780, true);
    const payload = new Uint8Array(16380).fill(42);
    payload.fill(29, 15600);
    expect(receiver.receive(last)).toEqual({ kind: "accepted", sequence: 1, qport: null, dropped: 0, payload });
    expect(receiver.incomingSequence).toBe(1);
  });

  test("a small overlapping send resets the cursor and preserves the owned pending payload", () => {
    const sender = new Netchannel("server");
    const data = new Uint8Array(1301).fill(42);
    firstPacket(sender, data);
    data.fill(0);
    expect(firstPacket(sender, Uint8Array.of(1))).toEqual(Uint8Array.of(1, 0, 0, 0, 1));
    expect(sender.remainingUnsentBytes).toBe(1301);
    expect(sender.hasUnsentFragments).toBe(true);
    const restarted = nextPacket(sender);
    if (restarted === null) throw new Error("Missing restarted fragment");
    expect(restarted.subarray(0, 8)).toEqual(Uint8Array.of(2, 0, 0, 128, 0, 0, 20, 5));
    expect(restarted.subarray(8)).toEqual(new Uint8Array(1300).fill(42));
    const last = nextPacket(sender);
    if (last === null) throw new Error("Missing fragment");
    expect(last.slice(8)).toEqual(Uint8Array.of(42));
    expect(firstPacket(sender, Uint8Array.of(3))).toEqual(Uint8Array.of(3, 0, 0, 0, 3));
    expect(sender.remainingUnsentBytes).toBe(1301);
    expect(sender.hasUnsentFragments).toBe(false);
  });

  test("a large overlapping send replaces pending storage without advancing its sequence", () => {
    const sender = new Netchannel("server");
    firstPacket(sender, new Uint8Array(2601).fill(17));
    const replacement = firstPacket(sender, new Uint8Array(1301).fill(29));
    expect(replacement.subarray(0, 8)).toEqual(Uint8Array.of(1, 0, 0, 128, 0, 0, 20, 5));
    expect(replacement.subarray(8)).toEqual(new Uint8Array(1300).fill(29));
    expect(sender.remainingUnsentBytes).toBe(1);
    expect(nextPacket(sender)).toEqual(Uint8Array.of(1, 0, 0, 128, 20, 5, 1, 0, 29));
    expect(sender.outgoingSequence).toBe(2);
    expect(nextPacket(sender)).toEqual(Uint8Array.of(2, 0, 0, 128, 21, 5, 0, 0));
    expect(sender.outgoingSequence).toBe(3);
  });

  test("Buffer subviews cannot mutate pending or accepted payloads", () => {
    const backing = Buffer.alloc(1400, 42);
    const data = backing.subarray(20, 1321);
    const sender = new Netchannel("server");
    firstPacket(sender, data);
    backing.fill(0);
    const last = nextPacket(sender);
    if (last === null) throw new Error("Missing fragment");
    expect(last.slice(8)).toEqual(Uint8Array.of(42));
    const packet = Buffer.from([99, 1, 0, 0, 0, 42, 99]);
    const result = new Netchannel("client").receive(packet.subarray(1, 6));
    packet.fill(0);
    if (result.kind !== "accepted") throw new Error("Expected accepted packet");
    expect(result.payload).toEqual(Uint8Array.of(42));
  });
});

describe("netchannel XOR source fixtures", () => {
  test("client payload matches original CL_Netchan_Encode, including command percent", () => {
    const plain = Buffer.from("6c158b1aa13ec644813164ef47b0bc3c9ea7b0bb90271c7396e7d25d083b7a0c63c8def9df1cca53eecec296b202", "hex");
    const expected = "6c158b1aa13ec644813164ef4ce791d35f92e4b3e29782199db0ffb2c90e2e0411784093d44be7bc2ffb969ec0b2";
    const command = (acknowledge: number): string => {
      expect(acknowledge).toBe(5);
      return "a%z";
    };
    const encoded = xorClientMessage(plain, 0x12345678, command);
    expect(Buffer.from(encoded).toString("hex")).toBe(expected);
    expect(xorClientMessage(encoded, 0x12345678, command)).toEqual(new Uint8Array(plain));
  });

  test("server payload matches original CL_Netchan_Decode, including high command bytes", () => {
    const plain = Buffer.from("116a1eece80276743f82e5e5f13c85dd853ce198b33c9704", "hex");
    const encoded = xorServerMessage(plain, 0x12345678, 37, "a%\x80");
    expect(Buffer.from(encoded).toString("hex")).toBe("116a1eecd46238f89d7c7a261c138480b95caf1411c208c7");
    expect(xorServerMessage(encoded, 0x12345678, 37, "a%\x80")).toEqual(new Uint8Array(plain));
  });

  test("empty commands preserve the challenge key and short payloads stay intact", () => {
    expect(xorServerMessage(Uint8Array.of(1, 2, 3, 4, 5, 6), 8, 1, "")).toEqual(Uint8Array.of(1, 2, 3, 4, 12, 15));
    expect(xorClientMessage(Uint8Array.of(1, 2), 8, () => { throw new Error("Unexpected command lookup"); })).toEqual(Uint8Array.of(1, 2));
  });

  test("XOR owns output and respects byte offsets of Buffer input", () => {
    const backing = Buffer.from([99, 1, 2, 3, 4, 5, 6, 99]);
    const output = xorServerMessage(backing.subarray(1, 7), 8, 1, "");
    expect(output).toEqual(Uint8Array.of(1, 2, 3, 4, 12, 15));
    expect([...backing]).toEqual([99, 1, 2, 3, 4, 5, 6, 99]);
  });
});
