import { expect, test } from "bun:test";
import { CommonError } from "../src/core/common-error.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { vec3 } from "../src/core/math.ts";
import { decodeClientMessage, encodeClientMessage } from "../src/protocol/client-message.ts";
import { MessageWriter } from "../src/protocol/message.ts";
import { Netchannel, xorClientMessage } from "../src/protocol/netchan.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { Product } from "../src/shared/definitions.ts";
import { PlayerState } from "../src/shared/player-state.ts";
import { createProtocolClientSession } from "../tools/client-protocol-fixture.ts";

function fixture(product: Product) {
  const cvars = new CvarRegistry();
  const session = createProtocolClientSession({ product, cvars, mode: { kind: "network", challenge: 12, qport: 34 } });
  cvars.set("cl_packetdup", "0", true); cvars.set("cl_showSend", "1", true);
  session.lifecycle.clientStatic.realtime = 123;
  return session;
}

async function movement(product: Product, count: number) {
  const session = fixture(product);
  await session.receiveServerMessage(1, encodeServerMessage(0, [
    { kind: "gamestate", commandSequence: 0, clientNumber: 0, checksumFeed: 19,
      entries: [{ kind: "configstring", index: 1, value: `\\sv_serverid\\100\\fs_game\\${product === "missionpack" ? "missionpack" : ""}` }] },
    { kind: "snapshot", validity: { kind: "valid" }, snapshot: { messageNumber: 1, serverTime: 1000, deltaNumber: -1,
      flags: 0, serverCommandNumber: 0, parseEntitiesNumber: 0, areaMask: new Uint8Array(), playerState: new PlayerState(product), entities: [] } },
  ], { product, messageNumber: 1, reliableSequence: 0, serverCommandSequence: 0, parseEntitiesNumber: 0,
    baseline: () => null, history: () => null }));
  session.prime(1);
  for (let i = 0; i < count; i++) session.createUserCommand({ serverTime: 1000 + i, viewAngles: vec3(0, 0, 0),
    buttons: 0, forwardmove: i, rightmove: 0, upmove: 0 });
  return session;
}

for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  test(`${product}: packet size print reads actual pre-EOF writer after bookkeeping`, () => {
    const session = fixture(product), order: string[] = [], writer = new MessageWriter();
    writer.writeLong(0); writer.writeLong(0); writer.writeLong(0);
    const expected = encodeClientMessage({ header: { serverId: 0, messageAcknowledge: 0, reliableAcknowledge: 0 },
      commands: [], movement: null }, { checksumFeed: 0, serverCommand: () => "" });
    session.transmit({
      print: text => {
        expect(text).toBe(`${writer.byteLength} `);
        expect(session.lifecycle.clientConnection.lastPacketSentTime).toBe(123);
        order.push("size");
      },
      send: bytes => {
        const packet = new Netchannel("server", 34).receive(bytes);
        if (packet.kind !== "accepted") throw new Error("Missing actual packet");
        expect(xorClientMessage(packet.payload, 12, () => "")).toEqual(expected); order.push("send");
      },
      trace: () => { order.push("trace"); },
    });
    expect(order).toEqual(["size", "send", "trace"]); expect(session.pendingEvents).toEqual([]);
  });

  test(`${product}: packet cvars and count prints run at source positions`, async () => {
    const session = await movement(product, 33), prints: string[] = [];
    session.cvars.set("cl_packetdup", "9", true);
    session.transmit({
      print: text => {
        prints.push(text); expect(session.cvars.get("cl_packetdup")?.value).toBe("5");
        expect(session.lifecycle.clientConnection.lastPacketSentTime).toBe(0);
        if (text === "(32)") {
          session.cvars.set("cl_nodelta", "1", true); session.cvars.set("cl_showSend", "0", true);
          session.lifecycle.clientStatic.realtime = 456;
        }
      },
      send: bytes => {
        expect(session.lifecycle.clientConnection.lastPacketSentTime).toBe(456);
        const packet = new Netchannel("server", 34).receive(bytes);
        if (packet.kind !== "accepted") throw new Error("Missing actual movement packet");
        const decoded = decodeClientMessage(xorClientMessage(packet.payload, 12, () => ""), {
          checksumFeed: 19, serverCommand: () => "", reliableSequence: 0, lastClientCommand: 0, lastUserCommandTime: 0 });
        if (decoded.kind !== "accepted") throw new Error("Rejected actual movement packet");
        expect(decoded.movement?.kind).toBe("move-no-delta"); expect(decoded.movement?.commands).toHaveLength(32);
        expect(decoded.movement?.commands[0]?.serverTime).toBe(1001);
      },
      trace: () => undefined,
    });
    expect(prints).toEqual(["MAX_PACKET_USERCMDS\n", "(32)"]);
  });

  test(`${product}: source print failure preserves only preceding packet state`, async () => {
    for (const count of [0, 1]) {
      const session = count === 0 ? fixture(product) : await movement(product, count), failure = new CommonError("drop", "packet print");
      session.cvars.set("cl_packetdup", "-1", true);
      expect(() => session.transmit({ print: () => { throw failure; },
        send: () => { throw new Error("Print failure must prevent delivery"); }, trace: () => undefined })).toThrow(failure);
      expect(session.cvars.get("cl_packetdup")?.value).toBe("0");
      expect(session.lifecycle.clientConnection.lastPacketSentTime).toBe(count === 0 ? 123 : 0);
      expect(session.dropped).toBeNull();
      session.cvars.set("cl_showSend", "0", true);
      session.transmit({ print: () => { throw new Error("Disabled print"); }, trace: () => undefined,
        send: bytes => { expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)).toBe(1); } });
    }
  });

  test(`${product}: actual connection demoWaiting selects no-delta with a matching snapshot`, async () => {
    for (const waiting of [false, true]) {
      const session = await movement(product, 1);
      expect(session.lifecycle.clientConnection.demoWaiting).toBe(false);
      session.lifecycle.clientConnection.demoWaiting = waiting;
      session.transmit({ print: () => undefined, trace: () => undefined,
        send: bytes => {
          const packet = new Netchannel("server", 34).receive(bytes);
          if (packet.kind !== "accepted") throw new Error("Missing actual packet");
          const decoded = decodeClientMessage(xorClientMessage(packet.payload, 12, () => ""), {
            checksumFeed: 19, serverCommand: () => "", reliableSequence: 0, lastClientCommand: 0, lastUserCommandTime: 0 });
          if (decoded.kind !== "accepted") throw new Error("Rejected actual packet");
          expect(decoded.movement?.kind).toBe(waiting ? "move-no-delta" : "move");
        } });
    }
  });
}
