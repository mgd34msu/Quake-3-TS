import { expect, test } from "bun:test";
import { CvarRegistry } from "../src/core/cvar.ts";
import { createProtocolClientSession } from "../tools/client-protocol-fixture.ts";
import { decodeClientMessage } from "../src/protocol/client-message.ts";
import { DemoReader } from "../src/protocol/demo.ts";
import { Netchannel, xorClientMessage } from "../src/protocol/netchan.ts";
import type { ClientPacketDelivery } from "../src/engine/client-session.ts";
import type { Product } from "../src/shared/definitions.ts";

function fixture(product: Product) {
  const session = createProtocolClientSession({ product, cvars: new CvarRegistry(),
    mode: { kind: "network", challenge: 1234, qport: 2345 } });
  session.lifecycle.clientStatic.realtime = 123;
  session.cvars.set("cl_packetdup", "0", true);
  session.cvars.set("cl_nodelta", "1", true);
  return session;
}

for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  test(`${product}: packet delivery observes the source send clock before each transport effect`, () => {
    const session = fixture(product), events: string[] = [];
    session.transmit( {
      send: bytes => {
        expect(session.lifecycle.clientConnection.lastPacketSentTime).toBe(123);
        expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)).toBe(1);
        events.push("send");
      },
      print: () => { throw new Error("Unexpected packet diagnostic"); },
      trace: message => { expect(message).toContain("client send"); events.push("trace"); },
    });
    expect(events).toEqual(["send", "trace"]);
  });

  test(`${product}: a failed first fragment stops delivery without committing fragment progress`, () => {
    const session = fixture(product), failure = new Error("transport unavailable");
    for (let i = 0; i < 10; i++) session.addReliableCommand(`say ${i} ${"abcdefghijklmnopqrstuvwxyz".repeat(30)}`);
    let sent = 0, traced = 0;
    const delivery: ClientPacketDelivery = {
      send: bytes => {
        sent++;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        expect(view.getUint32(0, true)).toBe(0x80000001);
        expect(view.getUint16(6, true)).toBe(0);
        expect(session.lifecycle.clientConnection.lastPacketSentTime).toBe(123);
        throw failure;
      },
      print: () => { throw new Error("Unexpected packet diagnostic"); },
      trace: () => { traced++; },
    };
    expect(() => session.transmit( delivery)).toThrow(failure);
    expect(sent).toBe(1); expect(traced).toBe(0);
    expect(() => session.transmit( delivery)).toThrow("Finish pending fragments");
    expect(sent).toBe(1);
  });

  test(`${product}: every fragment sends and traces in order before the next message sequence`, () => {
    const session = fixture(product), peer = new Netchannel("server", 2345);
    const commands = Array.from({ length: 10 }, (_, index) => `say ${index} ${"abcdefghijklmnopqrstuvwxyz".repeat(30)}`);
    for (const text of commands) session.addReliableCommand(text);
    const order: string[] = [], offsets: number[] = [];
    let complete = 0;
    session.transmit( {
      send: bytes => {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        expect(view.getUint32(0, true)).toBe(0x80000001);
        offsets.push(view.getUint16(6, true));
        order.push("send");
        const packet = peer.receive(bytes);
        if (packet.kind === "accepted") {
          complete++;
          const message = decodeClientMessage(xorClientMessage(packet.payload, 1234, () => ""), {
            checksumFeed: 0, serverCommand: () => "", reliableSequence: 0, lastClientCommand: 0, lastUserCommandTime: 0,
          });
          expect(message.kind).toBe("accepted");
          expect(message.commands.map(command => command.text)).toEqual(commands);
        } else expect(packet.kind).toBe("fragment");
      },
      print: () => { throw new Error("Unexpected packet diagnostic"); },
      trace: text => { expect(text).toContain("fragment="); order.push("trace"); },
    });
    expect(complete).toBe(1); expect(offsets.length).toBeGreaterThan(2);
    expect(offsets).toEqual(offsets.map((_, index) => index * 1300));
    expect(order).toEqual(offsets.flatMap(() => ["send", "trace"]));
    session.transmit( {
      send: bytes => { expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)).toBe(0x80000002); },
      print: () => { throw new Error("Unexpected packet diagnostic"); },
      trace: text => { expect(text).toContain("s=2"); },
    });
  });

  test(`${product}: normal send failure retains source sequence advancement and exact thrown value`, () => {
    for (const failure of [null, undefined, new Error("send failed")]) {
      const session = fixture(product);
      let caught = false, sent = 0;
      try {
        session.transmit( {
          send: () => { sent++; throw failure; },
          print: () => { throw new Error("Unexpected packet diagnostic"); },
          trace: () => { throw new Error("Must not trace failed send"); },
        });
      } catch (error: unknown) { caught = true; expect(error).toBe(failure); }
      expect(caught).toBe(true); expect(sent).toBe(1);
      expect(session.lifecycle.clientConnection.lastPacketSentTime).toBe(123);
      session.lifecycle.clientStatic.realtime = 456;
      session.transmit( {
        send: bytes => {
          expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)).toBe(2);
          expect(session.lifecycle.clientConnection.lastPacketSentTime).toBe(456);
        },
        print: () => { throw new Error("Unexpected packet diagnostic"); },
        trace: text => { expect(text).toContain("s=2"); },
      });
    }
  });

  test(`${product}: trace failure and operation retirement cannot send later fragments`, () => {
    for (const retire of [false, true]) {
      const session = fixture(product), failure = new Error("trace failed");
      for (let i = 0; i < 10; i++) session.addReliableCommand(`say ${i} ${"abcdefghijklmnopqrstuvwxyz".repeat(30)}`);
      let sent = 0, traced = 0;
      const originalAssert = session.lifecycle.assertCurrentOperation.bind(session.lifecycle);
      let current = true;
      session.lifecycle.assertCurrentOperation = () => { originalAssert(); if (!current) throw failure; };
      expect(() => session.transmit( {
        send: () => { sent++; if (retire) current = false; },
        print: () => { throw new Error("Unexpected packet diagnostic"); },
        trace: () => { traced++; throw failure; },
      })).toThrow(failure);
      expect(sent).toBe(1); expect(traced).toBe(retire ? 0 : 1);
    }
  });

  test(`${product}: demo and cinematic branches leave send state and transport untouched`, () => {
    const sessions = [fixture(product), fixture(product), createProtocolClientSession({ product, cvars: new CvarRegistry(),
      mode: { kind: "demo", reader: new DemoReader(new Uint8Array(), "empty delivery fixture") } })];
    const cinematic = sessions[0], demo = sessions[1];
    if (cinematic === undefined || demo === undefined) throw new Error("Missing delivery fixture");
    cinematic.lifecycle.clientStatic.phase = "cinematic";
    demo.lifecycle.clientConnection.demoPlaying = true;
    for (const session of sessions) {
      session.lifecycle.clientStatic.realtime = 789;
      session.transmit( {
        send: () => { throw new Error("Inactive source branch sent a packet"); },
        print: () => { throw new Error("Unexpected packet diagnostic"); },
        trace: () => { throw new Error("Inactive source branch traced a packet"); },
      });
      expect(session.lifecycle.clientConnection.lastPacketSentTime).toBe(0);
    }
  });
}
