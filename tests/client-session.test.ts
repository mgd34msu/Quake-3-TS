import { createProtocolClientSession, ProtocolClientLifecycle, transmitProtocolClient } from "../tools/client-protocol-fixture.ts";
// Source packet captures and engine/cgame lifetime boundaries. GPL-2.0-or-later.
import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { CommonError } from "../src/core/common-error.ts";
import { vec3 } from "../src/core/math.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { ClientDownloads } from "../src/engine/client-download.ts";
import { ClientConnectionState } from "../src/engine/client-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { ReliableOverflowError } from "../src/protocol/reliable.ts";
import type { ClientMoveSample } from "../src/engine/client-session.ts";
import { setOrigin } from "../src/game/entities.ts";
import { decodeClientMessage } from "../src/protocol/client-message.ts";
import { Netchannel, xorClientMessage, xorServerMessage } from "../src/protocol/netchan.ts";
import { MessageReader, MessageWriter } from "../src/protocol/message.ts";
import { DemoReader, encodeDemo } from "../src/protocol/demo.ts";
import type { DemoMessage } from "../src/protocol/demo.ts";
import { encodeServerMessage, ServerOpcode } from "../src/protocol/server-message.ts";
import type { Gamestate, ServerMessageContext, ServerOperation, Snapshot, SnapshotHistoryEntry } from "../src/protocol/server-message.ts";
import { writeDeltaEntity, writeDeltaPlayerState } from "../src/protocol/state-delta.ts";
import { ServerSnapshotRuntime } from "../src/server/snapshots.ts";
import { ServerClientPhase, ServerStaticState, ServerWorldState } from "../src/server/state.ts";
import { GameType, Weapon, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ServerEntityFlags } from "../src/shared/entity-shared.ts";
import { EntityState, EntityStateRecord } from "../src/shared/entity-state.ts";
import { PlayerState, PlayerStateRecord } from "../src/shared/player-state.ts";
import { createGameVerificationHarness } from "../tools/game-verification-harness.ts";

// Untouched dbe4ddb SV_WriteSnapshotToClient/SV_EmitPacketEntities/MSG_* oracle;
// same immutable captures independently checked in server-message.test.ts.
const GAMESTATE = "6c15f9ab6c3d967781cdcde66519781ec18e014259ca028f60b2b7c7f22eb0f3604717b023944bc786df2f1bba3e01c0480000ff15a92e8d3705bf02";
const FULL = "6c35e2570b8f5018b23707c3c49cf54fb2d55024fb9b21be6c5d29410100000000cbdb4b229d58f900bc97c90a";
const DELTA = "6cf55f2554772892fd21c53eea13001c0a0060da9eac00";
function at<T>(values: readonly T[], index: number): T {
  const value = values[index]; if (value === undefined) throw new Error(`Missing fixture ${index}`); return value;
}
function session(product: Product = "baseq3", demo = false): EngineClientSession {
  return createProtocolClientSession({ product, cvars: new CvarRegistry(),
    mode: demo ? { kind: "demo", reader: new DemoReader(new Uint8Array(), "protocol-only fixture") }
      : { kind: "network", challenge: 0x1234567, qport: 27961 } });
}

test("actual client sends consume live net_qport between packets and fragments for both products", () => {
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    const client = session(product), packets: Uint8Array[] = [];
    client.cvars.set("net_qport", "4660", true);
    client.transmit({ send: bytes => { packets.push(bytes); }, trace: () => undefined, print: () => undefined });
    expect(new DataView(at(packets, 0).buffer).getUint16(4, true)).toBe(0x1234);
    packets.length = 0;
    for (let index = 0; index < 3; index++) client.addReliableCommand("x".repeat(1000));
    client.transmit({ send: bytes => { packets.push(bytes); client.cvars.set("net_qport", "-1", true); }, trace: () => undefined, print: () => undefined });
    expect(packets.length).toBeGreaterThan(1);
    expect(new DataView(at(packets, 0).buffer).getUint16(4, true)).toBe(0x1234);
    for (const packet of packets.slice(1)) expect(new DataView(packet.buffer).getUint16(4, true)).toBe(65535);
  }
});
test("actual client accounting includes packet writes and counts only fully accepted decoded datagrams", async () => {
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    const client = session(product), state = client.lifecycle.sourceState;
    const packets = transmitProtocolClient(client, 0, 0, false);
    expect(state.oldsize).toBe(104 + at(packets, 0).length * 8);
    const server = new Netchannel("server");
    const first = encodeServerMessage(0, [gamestate()], context(1, product));
    const packet = at(server.transmit(xorServerMessage(first, 0x1234567, 1, "")), 0);
    expect((await client.receiveDatagram(packet)).kind).toBe("accepted");
    expect(state.newsize).toBe(first.length + 4);
    expect((await client.receiveDatagram(packet)).kind).toBe("rejected");
    expect(state.newsize).toBe(first.length + 4);
    const second = encodeServerMessage(0, [gamestate(0, [{ kind: "configstring", index: 2, value: "x".repeat(4000) }])], context(2, product));
    const fragments = server.transmit(xorServerMessage(second, 0x1234567, 2, ""));
    expect(fragments.length).toBeGreaterThan(1);
    for (const fragment of fragments.slice(0, -1)) {
      expect((await client.receiveDatagram(fragment)).kind).toBe("fragment");
      expect(state.newsize).toBe(first.length + 4);
    }
    expect((await client.receiveDatagram(at(fragments, fragments.length - 1))).kind).toBe("accepted");
    expect(state.newsize).toBe(first.length + second.length + 8);
    expect(client.lifecycle.sourceState).toBe(state);
    const invalid = new MessageWriter(); invalid.writeLong(0); invalid.writeByte(255);
    const malformed = at(server.transmit(xorServerMessage(invalid.toBytes(), 0x1234567, 3, "")), 0);
    await expect(client.receiveDatagram(malformed)).rejects.toThrow();
    expect(state.newsize).toBe(first.length + second.length + invalid.byteLength + 12);
  }
});
function downloadSession(developerPrint: (text: string) => undefined) {
  const cvars = new CvarRegistry(undefined, developerPrint), lifecycle = new ProtocolClientLifecycle(cvars);
  const client = new EngineClientSession({ product: "baseq3", cvars, lifecycle,
    mode: { kind: "network", challenge: 1, qport: 1 } });
  const files = new CommonFileState({ dataPath: process.cwd(), homePath: process.cwd(), cdPath: null, product: "baseq3" },
    text => lifecycle.print(text), new SoundOutput(), cvars);
  const owner = new ClientDownloads({ files, cvars, connection: lifecycle.clientConnection, clientStatic: lifecycle.clientStatic,
    assertCurrentOperation: () => lifecycle.assertCurrentOperation(), print: text => lifecycle.print(text),
    addReliableCommand: text => { client.addReliableCommand(text); },
    writePacket: () => { throw new Error("Unexpected download packet write"); },
    downloadsComplete: () => { throw new Error("Unexpected download completion"); } });
  lifecycle.clientConnection.downloads = owner;
  lifecycle.downloadSizeReceived = fileSize => owner.publishSize(fileSize);
  lifecycle.downloadReceived = block => owner.receive(block);
  return { client, cvars, lifecycle, owner };
}
function context(number: number, product: Product = "baseq3", old: SnapshotHistoryEntry | null = null): ServerMessageContext {
  return { product, messageNumber: number, reliableSequence: 0, serverCommandSequence: 0, parseEntitiesNumber: 0,
    baseline: () => null, history: () => old };
}
function gamestate(sequence = 0, entries: Gamestate["entries"] = []): Gamestate {
  return { kind: "gamestate", commandSequence: sequence, clientNumber: 0, checksumFeed: 19,
    entries: [{ kind: "configstring", index: 1, value: "\\sv_serverid\\100\\sv_cheats\\1" }, ...entries] };
}
async function send(client: EngineClientSession, operations: readonly ServerOperation[], number = client.serverMessageSequence + 1,
  old: SnapshotHistoryEntry | null = null): Promise<void> {
  (await client.receiveServerMessage(number, encodeServerMessage(0, operations, context(number, client.product, old))));
}
async function command(client: EngineClientSession, text: string): Promise<number> {
  const sequence = client.serverCommandSequence + 1;
  (await send(client, [{ kind: "command", sequence, text }])); return sequence;
}
function sample(serverTime = 1000): ClientMoveSample {
  return { serverTime, viewAngles: vec3(90, -90, 360), buttons: 1, forwardmove: 127, rightmove: -127, upmove: 0 };
}
function snapshot(number: number, flags = 0, entities: readonly EntityState[] = []) {
  return { messageNumber: number, serverTime: number * 50, deltaNumber: -1, flags, serverCommandNumber: 0,
    parseEntitiesNumber: 0, areaMask: Uint8Array.of(5), playerState: new PlayerState("baseq3"), entities } satisfies Snapshot;
}
function operation(value: Snapshot): Extract<ServerOperation, { kind: "snapshot" }> {
  return { kind: "snapshot", validity: { kind: "valid" }, snapshot: value };
}

describe("real engine client session", () => {
  test("raw mod snapshots and baselines pass through full and delta session messages", async () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const client = session(product), baseline = new EntityStateRecord<number>(0);
      baseline.number = 7; baseline.weapon = 255;
      baseline.pos = { ...baseline.pos, type: 221 };
      baseline.apos = { ...baseline.apos, type: 222 };
      const retainedBaseline = at(client.active.baselines, 7);
      await send(client, [gamestate(0, [{ kind: "baseline", number: 7, entity: baseline }])]);
      expect(at(client.active.baselines, 7)).toBe(retainedBaseline);
      expect([retainedBaseline.pos.type, retainedBaseline.apos.type, retainedBaseline.weapon]).toEqual([221, 222, 255]);
      const copiedBaseline = client.copyGamestate().entries.find(entry => entry.kind === "baseline");
      if (copiedBaseline?.kind !== "baseline") throw new Error("Raw recorded gamestate baseline missing");
      expect([copiedBaseline.entity.pos.type, copiedBaseline.entity.apos.type, copiedBaseline.entity.weapon])
        .toEqual([221, 222, 255]);
      copiedBaseline.entity.weapon = 1;
      expect(retainedBaseline.weapon).toBe(255);
      const playerState = new PlayerStateRecord<number, number, number>(product, 201, 31, 14);
      playerState.stats.set(statSchema(product).health, 80);
      const full = { ...snapshot(2), playerState, entities: [baseline] } satisfies Snapshot;
      await send(client, [operation(full)]);
      const read = client.snapshots.read(2);
      if (read === null) throw new Error("Raw full snapshot missing");
      expect([read.playerState.pmType, read.playerState.weapon, read.playerState.weaponState]).toEqual([201, 31, 14]);
      expect(read.entities.map(entity => [entity.pos.type, entity.apos.type, entity.weapon])).toEqual([[221, 222, 255]]);
      const old = client.active.history.borrowSlot(2, product);
      old.snapshot.playerState.externalEventTime = 101; old.snapshot.playerState.ping = 102;
      old.snapshot.playerState.pmoveFramecount = 103; old.snapshot.playerState.jumppadFrame = 104;
      old.snapshot.playerState.entityEventSequence = 105;
      expect(client.readCurrentPlayerState()?.externalEventTime).toBe(0);
      const nextState = old.snapshot.playerState.copy();
      nextState.pmType = 202; nextState.weapon = 30; nextState.weaponState = 13;
      const nextEntity = baseline.copy();
      nextEntity.pos = { ...nextEntity.pos, type: 223 };
      const delta = { ...snapshot(3), deltaNumber: 2, playerState: nextState, entities: [nextEntity] } satisfies Snapshot;
      await send(client, [operation(delta)], 3, old);
      const current = client.readCurrentPlayerState();
      if (current === null) throw new Error("Raw delta player state missing");
      expect([current.pmType, current.weapon, current.weaponState]).toEqual([202, 30, 13]);
      expect([current.externalEventTime, current.ping, current.pmoveFramecount, current.jumppadFrame,
        current.entityEventSequence]).toEqual([101, 102, 103, 104, 105]);
      expect(client.snapshots.read(3)?.entities.map(entity => [entity.pos.type, entity.apos.type, entity.weapon]))
        .toEqual([[223, 222, 255]]);
      const parsed = client.active.parseEntities.at(1);
      expect([parsed.pos.type, parsed.apos.type, parsed.weapon]).toEqual([223, 222, 255]);
      current.pmType = 12; current.externalEventTime = 13;
      expect(client.readCurrentPlayerState()?.pmType).toBe(202);
      expect(client.readCurrentPlayerState()?.externalEventTime).toBe(101);
      await send(client, [gamestate()]);
      expect(at(client.active.baselines, 7)).toBe(retainedBaseline);
      expect([retainedBaseline.number, retainedBaseline.pos.type, retainedBaseline.apos.type, retainedBaseline.weapon])
        .toEqual([0, 0, 0, 0]);
      expect(client.active.parseEntities.at(1)).toBe(parsed);
      expect([parsed.number, parsed.pos.type, parsed.apos.type, parsed.weapon]).toEqual([0, 0, 0, 0]);
      expect(client.readCurrentPlayerState()).toBeNull();
      const lifecycle = client.lifecycle;
      if (!(lifecycle instanceof ProtocolClientLifecycle)) throw new Error("Expected inert protocol lifecycle");
      lifecycle.close();
    }
  });

  test("download headers publish actual size and its cvar print before malformed payloads", async () => {
    for (const suffix of ["payload", "length", "error"]) {
      const printed: string[] = [];
      const f = downloadSession(text => {
        if (!text.startsWith("Cvar_Set2: cl_downloadSize ")) return;
        printed.push(text);
        expect(f.owner.fileSize).toBe(suffix === "error" ? -16777217 : 16777217);
        expect(f.cvars.get("cl_downloadSize")).toBeUndefined();
      });
      const writer = new MessageWriter();
      writer.writeLong(0); writer.writeByte(ServerOpcode.Download); writer.writeShort(0);
      writer.writeLong(suffix === "error" ? -16777217 : 16777217);
      if (suffix === "payload") { writer.writeShort(100); writer.writeByte(65); }
      if (suffix === "length") writer.writeShort(16385);
      await expect(f.client.receiveServerMessage(1, writer.toBytes())).rejects.toThrow();
      expect(f.owner.fileSize).toBe(suffix === "error" ? -16777217 : 16777217);
      expect(f.cvars.get("cl_downloadSize")?.value).toBe(suffix === "error" ? "-16777216" : "16777216");
      expect(printed).toEqual([`Cvar_Set2: cl_downloadSize ${suffix === "error" ? "-16777216" : "16777216"}\n`]);
      expect(f.owner.receivedBytes).toBe(0); expect(f.owner.blockNumber).toBe(0);
      expect(f.lifecycle.clientConnection.reliable.sequence).toBe(0);
      f.owner.disposeResources(); f.lifecycle.close();
    }
  });

  test("download size publication aborts at synchronous cvar printing and connection retirement", async () => {
    for (const retire of [false, true]) {
      const f = downloadSession(text => {
        if (!text.startsWith("Cvar_Set2: cl_downloadSize ")) return;
        expect(f.owner.fileSize).toBe(7); expect(f.cvars.get("cl_downloadSize")).toBeUndefined();
        if (retire) f.lifecycle.close();
        else throw new CommonError("drop", "interrupted download size print");
      });
      const writer = new MessageWriter();
      writer.writeLong(0); writer.writeByte(ServerOpcode.Download); writer.writeShort(0); writer.writeLong(7);
      writer.writeShort(100);
      await expect(f.client.receiveServerMessage(1, writer.toBytes()))
        .rejects.toThrow(retire ? "no longer current" : "interrupted download size print");
      expect(f.owner.fileSize).toBe(7);
      expect(f.cvars.get("cl_downloadSize")?.value).toBe(retire ? "7" : undefined);
      expect(f.lifecycle.clientConnection.reliable.sequence).toBe(0);
      f.owner.disposeResources(); f.lifecycle.close();
    }
  });

  test("download sign reads live size after nested cvar printing", async () => {
    let nested: Promise<void> | null = null;
    const sizes: string[] = [];
    const f = downloadSession(text => {
      if (!text.startsWith("Cvar_Set2: cl_downloadSize ")) return;
      sizes.push(text);
      if (text !== "Cvar_Set2: cl_downloadSize 5\n") return;
      nested = send(f.client, [{ kind: "download", block: { kind: "error", fileSize: -7, message: "nested refusal" } }], 2)
        .catch((error: unknown) => {
          expect(error).toBeInstanceOf(CommonError);
          expect(error instanceof Error ? error.message : error).toBe("nested refusal");
        });
    });
    const writer = new MessageWriter();
    writer.writeLong(0); writer.writeByte(ServerOpcode.Download); writer.writeShort(0); writer.writeLong(5);
    writer.writeString("outer refusal after nested size");
    await expect(f.client.receiveServerMessage(1, writer.toBytes())).rejects.toThrow("outer refusal after nested size");
    expect(nested).not.toBeNull();
    await nested;
    expect(f.owner.fileSize).toBe(-7); expect(f.cvars.get("cl_downloadSize")?.value).toBe("5");
    expect(sizes).toEqual(["Cvar_Set2: cl_downloadSize 5\n", "Cvar_Set2: cl_downloadSize -7\n"]);
    expect(f.lifecycle.clientConnection.reliable.sequence).toBe(0);
    f.owner.disposeResources(); f.lifecycle.close();
  });

  test("download body preserves single size publication, live diagnostics and terminal server errors", async () => {
    const sizes: string[] = [];
    const f = downloadSession(text => { if (text.startsWith("Cvar_Set2: cl_downloadSize ")) sizes.push(text); });
    await send(f.client, [{ kind: "download", block: { kind: "start", fileSize: 5, data: Uint8Array.of(65) } }]);
    expect(sizes).toEqual(["Cvar_Set2: cl_downloadSize 5\n"]);
    expect(f.owner.fileSize).toBe(5); expect(f.cvars.get("cl_downloadSize")?.value).toBe("5");
    expect(f.lifecycle.debugMessages).toEqual(["Server sending download, but no download was requested\n"]);
    expect(f.lifecycle.clientConnection.reliable.lookupMasked(1)).toBe("stopdl");
    f.cvars.set("cl_shownet", "2", true); f.cvars.set("developer", "0", true);
    f.lifecycle.print = text => {
      f.lifecycle.debugMessages.push(text);
      if (text.endsWith(":svc_download\n")) f.cvars.set("developer", "1", true);
    };
    await send(f.client, [{ kind: "download", block: { kind: "chunk", number: 1, data: new Uint8Array() } }]);
    expect(f.lifecycle.debugMessages).toContain("CL_ParseDownload: Expected block 0, got 1\n");
    await expect(send(f.client, [{ kind: "download", block: { kind: "error", fileSize: -123, message: "server refused download" } }]))
      .rejects.toThrow("server refused download");
    expect(f.owner.fileSize).toBe(-123); expect(f.cvars.get("cl_downloadSize")?.value).toBe("-123");
    expect(sizes).toEqual(["Cvar_Set2: cl_downloadSize 5\n", "Cvar_Set2: cl_downloadSize -123\n"]);
    expect(f.owner.receivedBytes).toBe(0); expect(f.lifecycle.clientConnection.reliable.sequence).toBe(1);
    f.owner.disposeResources(); f.lifecycle.close();
  });

  test("shownet samples the live cvar and uses network or demo packet size", async () => {
    for (const demo of [false, true]) {
      const cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
      const client = new EngineClientSession({ product: "baseq3", cvars, lifecycle,
        mode: demo ? { kind: "demo", reader: new DemoReader(new Uint8Array()) }
          : { kind: "network", challenge: 1, qport: 1 } });
      const bytes = encodeServerMessage(0, [{ kind: "nop" }], context(1));
      cvars.set("cl_shownet", "1", true);
      lifecycle.print = text => {
        lifecycle.assertCurrentOperation(); lifecycle.debugMessages.push(text);
        cvars.set("cl_shownet", "2", true);
      };
      await client.receiveServerMessage(1, bytes);
      expect(lifecycle.debugMessages[0]).toBe(`${bytes.length + (demo ? 0 : 4)} `);
      expect(lifecycle.debugMessages.slice(1).map(text => text.slice(text.indexOf(":") + 1)))
        .toEqual(["svc_nop\n", "END OF MESSAGE\n"]);
      lifecycle.close();
    }
  });

  test("shownet callbacks preserve live acknowledgement, command and snapshot context", async () => {
    {
      const cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
      const client = new EngineClientSession({ product: "baseq3", cvars, lifecycle,
        mode: { kind: "network", challenge: 1, qport: 1 } });
      cvars.set("cl_shownet", "1", true);
      lifecycle.print = () => { client.addReliableCommand("print reached"); };
      await client.receiveServerMessage(1, encodeServerMessage(-64, [{ kind: "nop" }], context(1)));
      expect(lifecycle.clientConnection.reliable.sequence).toBe(1);
      expect(lifecycle.clientConnection.reliable.acknowledge).toBe(1);
      lifecycle.close();
    }
    {
      const cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
      const client = new EngineClientSession({ product: "baseq3", cvars, lifecycle,
        mode: { kind: "network", challenge: 1, qport: 1 } });
      let nested: Promise<void> | null = null;
      cvars.set("cl_shownet", "2", true);
      lifecycle.print = text => {
        if (!text.endsWith(":svc_serverCommand\n")) return;
        cvars.set("cl_shownet", "0", true);
        nested = send(client, [{ kind: "command", sequence: 7, text: "print nested" }], 2);
      };
      await send(client, [{ kind: "command", sequence: 5, text: "print outer" }], 1);
      expect(nested).not.toBeNull(); await nested;
      expect(client.serverCommandSequence).toBe(7);
      expect(lifecycle.clientConnection.serverCommands[5]).toBe("");
      expect(lifecycle.clientConnection.serverCommands[7]).toBe("print nested");
      lifecycle.close();
    }
    {
      const cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
      const client = new EngineClientSession({ product: "baseq3", cvars, lifecycle,
        mode: { kind: "network", challenge: 1, qport: 1 } });
      const old = snapshot(1);
      await send(client, [operation(old)], 1);
      let nested: Promise<void> | null = null;
      cvars.set("cl_shownet", "2", true);
      lifecycle.print = text => {
        if (!text.endsWith(":svc_snapshot\n")) return;
        cvars.set("cl_shownet", "0", true);
        nested = send(client, [{ kind: "nop" }], 3);
      };
      const bytes = encodeServerMessage(0, [operation({ ...snapshot(2), deltaNumber: 1 })],
        context(2, "baseq3", { status: "valid", snapshot: old }));
      const received = await client.receiveServerMessage(2, bytes);
      expect(nested).not.toBeNull(); await nested;
      const parsed = received?.operations[0];
      if (parsed?.kind !== "snapshot") throw new Error("Missing snapshot after opcode callback");
      expect([parsed.snapshot.messageNumber, parsed.snapshot.deltaNumber, parsed.validity])
        .toEqual([3, 2, { kind: "invalid", reason: "invalid-delta" }]);
      expect(client.serverMessageSequence).toBe(3);
      expect(client.snapshots.current()).toEqual({ number: 1, serverTime: 50 });
      lifecycle.close();
    }
  });

  test("snapshot diagnostics run after publication and before newSnapshots", async () => {
    const cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
    const client = new EngineClientSession({ product: "baseq3", cvars, lifecycle,
      mode: { kind: "network", challenge: 1, qport: 1 } });
    cvars.set("cl_shownet", "3", true);
    lifecycle.clientStatic.realtime = 73;
    lifecycle.print = text => {
      lifecycle.debugMessages.push(text);
      if (!text.startsWith("   snapshot:")) return;
      expect(client.snapshots.current()).toEqual({ number: 1, serverTime: 50 });
      expect(client.snapshotPing(1)).toBe(73);
      expect(client.active.newSnapshots).toBe(false);
      throw new CommonError("drop", "interrupted source snapshot print");
    };
    await expect(send(client, [operation(snapshot(1))])).rejects.toThrow("interrupted source snapshot print");
    expect(lifecycle.debugMessages.at(-1)).toBe("   snapshot:1  delta:-1  ping:73\n");
    expect(client.active.newSnapshots).toBe(false);
    lifecycle.close();
  });

  test("truncated descending entities retain reached command and ring writes without publishing the snapshot", async () => {
    const client = session();
    await send(client, [operation(snapshot(1))]);
    client.active.newSnapshots = false;
    client.lifecycle.clientConnection.demoWaiting = true;
    client.addReliableCommand("pending client command");
    client.active.parseEntities.at(2).modelindex = 44;
    client.cvars.set("cl_shownet", "3", true);
    const writer = new MessageWriter(); writer.writeLong(1);
    writer.writeByte(ServerOpcode.Command); writer.writeLong(1); writer.writeString("before truncated snapshot");
    writer.writeByte(ServerOpcode.Snapshot); writer.writeLong(100); writer.writeByte(0); writer.writeByte(0); writer.writeByte(0);
    writeDeltaPlayerState(writer, null, new PlayerState("baseq3"));
    for (const number of [2, 1]) {
      const entity = new EntityState(); entity.number = number; entity.modelindex = number * 11;
      writeDeltaEntity(writer, null, entity, true);
    }
    // Third entity reaches its number, then truncates within the first 32-bit field.
    writer.writeBits(2, 10); writer.writeBits(0, 1); writer.writeBits(1, 1); writer.writeByte(1);
    writer.writeBits(1, 1); writer.writeBits(1, 1);
    await expect(client.receiveServerMessage(2, writer.toBytes())).rejects.toThrow("truncated message bits");
    expect(client.lifecycle.clientConnection.reliable.acknowledge).toBe(1);
    expect(client.lifecycle.clientConnection.serverCommandSequence).toBe(1);
    expect(client.lifecycle.clientConnection.serverCommands[1]).toBe("before truncated snapshot");
    expect(client.lifecycle.clientConnection.demoWaiting).toBe(false);
    expect(client.active.parseEntitiesNumber).toBe(2);
    expect([0, 1, 2].map(index => {
      const entity = client.active.parseEntities.at(index); return [entity.number, entity.modelindex];
    })).toEqual([[2, 22], [1, 11], [2, 44]]);
    expect(client.active.history.latest?.messageNumber).toBe(1);
    expect(client.active.history.readSlot(2)).toBeNull();
    expect(client.active.newSnapshots).toBe(false);
    const lifecycle = client.lifecycle;
    if (!(lifecycle instanceof ProtocolClientLifecycle)) throw new Error("Expected protocol fixture lifecycle");
    expect(lifecycle.debugMessages.filter(text => text.includes(":  ")).map(text => text.slice(text.indexOf(":  ") + 3).trim()))
      .toEqual(["baseline: 2", "baseline: 1", "baseline: 2"]);
    lifecycle.close();
  });

  test("retained current player state survives expired entity history at zero and nonzero snapshot numbers", async () => {
    for (const number of [0, 10]) {
      const client = session("baseq3", true);
      expect(client.readCurrentPlayerState()).toBeNull();
      const current = snapshot(number);
      current.playerState.health = 80; current.playerState.deltaAngles = vec3(57344, 0, 0);
      await send(client, [operation(current)], number);
      const missing = snapshot(number + 1);
      const entities = Array.from({ length: 512 }, (_, index) => { const entity = new EntityState(); entity.number = index + 1; return entity; });
      for (let offset = 2; offset < 6; offset++) {
        const invalid = { ...snapshot(number + offset, 0, entities), deltaNumber: missing.messageNumber };
        await send(client, [operation(invalid)], invalid.messageNumber, { status: "valid", snapshot: missing });
      }
      expect(client.snapshots.current().number).toBe(number);
      expect(client.snapshots.read(number)).toBeNull();
      const retained = client.readCurrentPlayerState();
      if (retained === null) throw new Error("Expired entities discarded cl.snap.ps");
      expect(retained.health).toBe(80); expect(retained.deltaAngles.x).toBe(57344);
      retained.health = 2; retained.deltaAngles = vec3(1, 0, 0);
      expect(client.readCurrentPlayerState()?.health).toBe(80);
      expect(client.readCurrentPlayerState()?.deltaAngles.x).toBe(57344);
      await send(client, [gamestate()]);
      expect(client.readCurrentPlayerState()).toBeNull();
    }
  });
  test("actual demo reader accepts signed, duplicate and regressive message headers without resetting reliable commands", async () => {
    const numbers = [-0x80000000, -1, 0, 10, 5, 5, 2];
    const records = numbers.map((number, index) => ({ kind: "message", sequence: number,
      payload: encodeServerMessage(1, [{ kind: "command", sequence: index + 1, text: `print ${index}` },
        operation({ ...snapshot(number), serverTime: 1000 + index })], context(number)) } satisfies DemoMessage));
    const reader = new DemoReader(encodeDemo(records));
    const client = createProtocolClientSession({ product: "baseq3", cvars: new CvarRegistry(), mode: { kind: "demo", reader } });
    const ring = client.lifecycle.clientConnection.reliable;
    ring.add("retained reliable");
    await client.readInitialDemoMessages();
    expect(client.dropped).toBeNull();
    expect(client.serverMessageSequence).toBe(-1);
    expect(client.serverCommandSequence).toBe(7);
    expect(await client.getServerCommand(7)).toEqual(["print", "6"]);
    expect(client.snapshots.current()).toEqual({ number: 2, serverTime: 1006 });
    expect(client.snapshots.read(0)?.serverTime).toBe(1002);
    expect(client.snapshots.read(-1)?.serverTime).toBe(1001);
    expect(client.snapshotPing(2)).toBe(0);
    expect(client.lifecycle.clientConnection.reliable).toBe(ring);
    expect(ring.acknowledge).toBe(1);
    expect(ring.lookupMasked(1)).toBe("retained reliable");
  });

  test("demo delta distance crosses the signed sequence boundary using the retained positive slot", async () => {
    const client = session("baseq3", true);
    const previous = { ...snapshot(0x7fffffff), serverTime: 1000 };
    previous.playerState.health = 80;
    await send(client, [operation(previous)], previous.messageNumber);
    const next = { ...snapshot(-0x80000000), serverTime: 1050, deltaNumber: 0x7fffffff };
    next.playerState.health = 70;
    await send(client, [operation(next)], next.messageNumber, { status: "valid", snapshot: previous });
    expect(client.snapshots.current()).toEqual({ number: -0x80000000, serverTime: 1050 });
    expect(client.snapshots.read(-0x80000000)?.playerState.stats.get(statSchema("baseq3").health)).toBe(70);
    expect(client.snapshotPing(-0x80000000)).toBe(0);
    expect(client.dropped).toBeNull();
    for (const invalid of [1.5, 0x80000000, -0x80000001]) {
      const invalidSnapshot = { ...next, messageNumber: invalid };
      expect(() => encodeServerMessage(0, [operation(invalidSnapshot)], context(invalid, "baseq3", { status: "valid", snapshot: previous })))
        .toThrow("int32");
    }
  });

  test("signed malformed demo packets retain preceding sequence, acknowledgement and command publications", async () => {
    const client = session("baseq3", true), ring = client.lifecycle.clientConnection.reliable;
    ring.add("retained reliable");
    await send(client, [operation({ ...snapshot(10), serverTime: 1000 })], 10);
    client.lifecycle.clientConnection.demoWaiting = true;
    const writer = new MessageWriter();
    writer.writeLong(1); writer.writeByte(ServerOpcode.Command); writer.writeLong(7); writer.writeString("print reached");
    writer.writeByte(ServerOpcode.Snapshot); writer.writeLong(1050); writer.writeByte(0); writer.writeByte(0); writer.writeByte(33);
    await expect(client.receiveServerMessage(-1, writer.toBytes())).rejects.toThrow("area mask exceeds 32 bytes");
    expect(client.serverMessageSequence).toBe(-1);
    expect(client.serverCommandSequence).toBe(7);
    expect(ring.acknowledge).toBe(1);
    expect(client.lifecycle.clientConnection.demoWaiting).toBe(false);
    expect(client.snapshots.current()).toEqual({ number: 10, serverTime: 1000 });
    expect(client.dropped?.kind).toBe("drop");
  });

  test("owned loading cancellation retires parsing without reviving the old connection", async () => {
    const cvars = new CvarRegistry(), owner = new ProtocolClientLifecycle(cvars);
    const client = new EngineClientSession({ product: "baseq3", cvars,
      mode: { kind: "network", challenge: 17, qport: 27961 },
      lifecycle: {
        sourceState: owner.sourceState,
        clientStatic: owner.clientStatic, clientConnection: owner.clientConnection, consoleCommands: owner.consoleCommands,
        clientActive: owner.clientActive,
        assertCurrentOperation: () => owner.assertCurrentOperation(),
        print: text => owner.print(text),
        milliseconds: () => owner.milliseconds(),
        applyServerPackages: info => owner.applyServerPackages(info),
        downloadSizeReceived: fileSize => owner.downloadSizeReceived(fileSize),
        downloadReceived: block => owner.downloadReceived(block),
        demoCompleted: (end, timing) => owner.demoCompleted(end, timing),
        gamestateReceived: async () => {
          await Promise.resolve(); owner.assertCurrentOperation();
          owner.clientStatic.phase = "disconnected"; owner.close();
          return "retired";
        },
      } });
    cvars.set("cl_paused", "1", true);
    const bytes = encodeServerMessage(0, [gamestate(), { kind: "command", sequence: 1, text: "must not run" }], context(1));
    const channel = new Netchannel("server", 0);
    const packet = at(channel.transmit(xorServerMessage(bytes, 17, 1, "")), 0);
    expect(await client.receiveDatagram(packet)).toEqual({ kind: "retired" });
    expect(cvars.get("cl_paused")?.value).toBe("0");
    expect(owner.clientStatic.phase).toBe("disconnected");
    expect(() => client.getGameState()).toThrow("no longer current");
    await expect(client.receiveDatagram(packet)).rejects.toThrow("no longer current");
  });

  test("parser drop still sends three disconnect datagrams without reopening the failed session", async () => {
    const client = session(), packets: Uint8Array[] = [], messages: string[] = [];
    await expect(client.receiveServerMessage(1, Uint8Array.of(0))).rejects.toThrow();
    const failure = client.dropped;
    if (failure === null) throw new Error("Fixture did not reach a parser drop");
    const delivery = {
      send: (bytes: Uint8Array): undefined => {
        expect(() => client.getGameState()).toThrow(failure);
        expect(() => client.transmit(delivery)).toThrow(failure);
        expect(() => client.disconnectPackets(delivery)).toThrow("cannot reenter");
        packets.push(bytes.slice());
      },
      trace: (text: string): undefined => { messages.push(text); },
      print: (text: string): undefined => { messages.push(text); },
    };
    client.disconnectPackets(delivery);
    expect(packets).toHaveLength(3); expect(client.dropped).toBe(failure);
    const peer = new Netchannel("server", 27961);
    for (const bytes of packets) {
      const packet = peer.receive(bytes);
      if (packet.kind !== "accepted") throw new Error("Disconnect datagram was not accepted");
      const decoded = decodeClientMessage(xorClientMessage(packet.payload, 0x1234567, () => ""), {
        checksumFeed: client.checksumFeed, serverCommand: () => "", reliableSequence: client.serverCommandSequence,
        lastClientCommand: 0, lastUserCommandTime: 0,
      });
      expect(decoded.commands).toEqual([{ sequence: 1, text: "disconnect" }]);
    }
    expect(() => client.getGameState()).toThrow(failure);
  });

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: connection-owned reliable ring survives admission, real TX/ACK and active resets`, async () => {
      const cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
      lifecycle.clientStatic.phase = "challenging";
      const connection = lifecycle.clientConnection, ring = connection.reliable;
      expect(ring.add('userinfo "\\name\\First"')).toEqual({ sequence: 1, text: 'userinfo "\\name\\First"' });
      expect(ring.add('userinfo "\\name\\Second"')).toEqual({ sequence: 2, text: 'userinfo "\\name\\Second"' });
      connection.lastPacketTime = 789;
      lifecycle.clientStatic.phase = "connected";
      const client = new EngineClientSession({ product, cvars, lifecycle, mode: { kind: "network", challenge: 0x1234567, qport: 27961 } });
      expect(client.addReliableCommand("say admitted")).toEqual({ sequence: 3, text: "say admitted" });
      expect(ring.sequence).toBe(3);
      const peer = new Netchannel("server", 27961);
      function outgoing() {
        const packet = peer.receive(at(transmitProtocolClient(client, 1000, 0, true), 0));
        if (packet.kind !== "accepted") throw new Error("Expected actual reliable packet");
        const serverCommand = (sequence: number): string => sequence === 1 ? "map_restart" : "";
        return decodeClientMessage(xorClientMessage(packet.payload, 0x1234567, serverCommand), {
          checksumFeed: client.checksumFeed, serverCommand, reliableSequence: client.serverCommandSequence,
          lastClientCommand: ring.acknowledge, lastUserCommandTime: 0,
        });
      }
      expect(outgoing().commands).toEqual([{ sequence: 1, text: 'userinfo "\\name\\First"' },
        { sequence: 2, text: 'userinfo "\\name\\Second"' }, { sequence: 3, text: "say admitted" }]);
      async function receive(operations: readonly ServerOperation[]): Promise<void> {
        const sequence = peer.outgoingSequence;
        const bytes = encodeServerMessage(2, operations, { ...context(sequence, product), reliableSequence: ring.sequence });
        for (const packet of peer.transmit(xorServerMessage(bytes, 0x1234567, sequence, ring.lookupMasked(2)))) {
          expect((await client.receiveDatagram(packet)).kind).toBe("accepted");
        }
      }
      const state = gamestate(0, [{ kind: "configstring", index: 1,
        value: `\\sv_serverid\\100\\sv_cheats\\1\\fs_game\\${product === "missionpack" ? "missionpack" : ""}` }]);
      await receive([state]);
      expect(ring.acknowledge).toBe(2); expect(ring.lookupMasked(2)).toBe('userinfo "\\name\\Second"');
      expect(ring.pending()).toEqual([{ sequence: 3, text: "say admitted" }]);
      expect(outgoing().commands).toEqual([{ sequence: 3, text: "say admitted" }]);
      client.prime(client.gamestateGeneration); client.createUserCommand(sample());
      await receive([state]);
      expect(client.gamestateGeneration).toBe(2); expect(client.commands.currentNumber).toBe(0);
      expect(connection.reliable).toBe(ring); expect(ring.sequence).toBe(3); expect(ring.acknowledge).toBe(2);
      client.prime(client.gamestateGeneration); client.createUserCommand(sample());
      expect(outgoing().commands).toEqual([{ sequence: 3, text: "say admitted" }]);
      await receive([{ kind: "command", sequence: 1, text: "map_restart" }]);
      expect(await client.getServerCommand(1)).toEqual(["map_restart"]); expect(client.commands.currentNumber).toBe(1);
      expect(client.commands.read(1)).toEqual({ serverTime: 0, angles: vec3(0, 0, 0), buttons: 0,
        weapon: 0, forwardmove: 0, rightmove: 0, upmove: 0 });
      expect(ring.pending()).toEqual([{ sequence: 3, text: "say admitted" }]);
      expect(connection.lastPacketTime).toBe(789); expect(ring.add("say same owner").sequence).toBe(4);
      expect(outgoing().commands).toEqual([{ sequence: 3, text: "say admitted" }, { sequence: 4, text: "say same owner" }]);
    });
    test(`${product}: connection-owned reliable ring retains full65 overflow before and after admission`, () => {
      const cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
      lifecycle.clientStatic.phase = "challenging";
      const ring = lifecycle.clientConnection.reliable;
      for (let i = 1; i <= 65; i++) expect(ring.add(`command ${i}`).sequence).toBe(i);
      expect(() => ring.add("pre-admission overflow")).toThrow(ReliableOverflowError);
      expect(ring.sequence).toBe(65); expect(ring.lookupMasked(1)).toBe("command 65");
      lifecycle.clientStatic.phase = "connected";
      const client = new EngineClientSession({ product, cvars, lifecycle, mode: { kind: "network", challenge: 1, qport: 1 } });
      expect(() => client.addReliableCommand("post-admission overflow")).toThrow("Client command overflow");
      expect(client.dropped?.kind).toBe("drop"); expect(ring.sequence).toBe(65);
      expect(ring.lookupMasked(1)).toBe("command 65"); expect(() => client.addReliableCommand("sticky")).toThrow("Client command overflow");
    });
    test(`${product}: connection-owned reliable ring survives rejected construction and fresh states stay isolated`, () => {
      const cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
      lifecycle.clientStatic.phase = "challenging";
      const ring = lifecycle.clientConnection.reliable; ring.add("before rejection");
      expect(() => new EngineClientSession({ product, cvars, lifecycle, mode: { kind: "network", challenge: 1, qport: 1 } }))
        .toThrow("admitted connected phase");
      expect(ring.sequence).toBe(1); expect(ring.pending()).toEqual([{ sequence: 1, text: "before rejection" }]);
      lifecycle.clientStatic.phase = "connected";
      const client = new EngineClientSession({ product, cvars, lifecycle, mode: { kind: "network", challenge: 1, qport: 1 } });
      const other = new ClientConnectionState(); expect(other.reliable).not.toBe(ring);
      expect(other.reliable.sequence).toBe(0); expect(other.reliable.acknowledge).toBe(0);
      expect(other.reliable.pending()).toEqual([]); expect(other.reliable.lookup(0)).toBe("");
      other.reliable.add("independent"); other.reliable.assignAcknowledgement(1);
      expect(ring.acknowledge).toBe(0); expect(ring.pending()).toEqual([{ sequence: 1, text: "before rejection" }]);
      lifecycle.close(); expect(() => client.addReliableCommand("retired")).toThrow("no longer current");
      const fresh = session(product); expect(fresh.lifecycle.clientConnection.reliable).not.toBe(ring);
      expect(fresh.addReliableCommand("fresh").sequence).toBe(1); expect(ring.sequence).toBe(1);
    });
  }
  test("snapshot pings use acknowledged command time and real outgoing packet history", async () => {
    const client = session(); (await send(client, [gamestate()])); client.prime(1);
    client.createUserCommand(sample(100)); transmitProtocolClient(client, 1000, 0, true);
    client.createUserCommand(sample(200)); transmitProtocolClient(client, 1020, 0, true);
    client.lifecycle.clientStatic.realtime = 1090;
    const first = snapshot(2); first.playerState.commandTime = 100;
    (await send(client, [operation(first)]));
    expect(client.snapshotPing(2)).toBe(90);
    client.lifecycle.clientStatic.realtime = 1120;
    const second = snapshot(3); second.playerState.commandTime = 200;
    (await send(client, [operation(second)]));
    expect(client.snapshotPing(3)).toBe(100); expect(client.snapshotPing(2)).toBe(90);
    const negative = snapshot(4); negative.playerState.commandTime = -1;
    (await send(client, [operation(negative)])); expect(client.snapshotPing(4)).toBe(999);
    (await send(client, [operation(snapshot(36))], 36));
    expect(client.snapshotPing(4)).toBeNull();
    (await send(client, [gamestate()])); expect(client.snapshotPing(36)).toBeNull();
  });

  test("stale negative reliable acknowledgement transmits native masked zero-filled slots", async () => {
    const client = session(), peer = new Netchannel("server", 27961);
    (await client.receiveServerMessage(1, encodeServerMessage(-64, [gamestate()], context(1))));
    const result = peer.receive(at(transmitProtocolClient(client, 0, 0, true), 0));
    if (result.kind !== "accepted") throw new Error("Missing stale-ack packet");
    const reader = new MessageReader(xorClientMessage(result.payload, 0x1234567, () => ""));
    expect([reader.readLong(), reader.readLong(), reader.readLong()]).toEqual([100, 1, 0]);
    for (let sequence = -63; sequence <= 0; sequence++) {
      expect(reader.readByte()).toBe(4); expect(reader.readLong()).toBe(sequence); expect(reader.readString()).toBe("");
    }
    expect(reader.readByte()).toBe(5); expect(client.dropped).toBeNull();
  });

  test("level console imports publish ordered owned engine events", () => {
    const client = session(); client.registerCgameCommand("testmodel"); client.print("loading\n"); client.appendConsoleCommand("echo ready\n");
    expect(client.takeEvents()).toEqual([{ kind: "register-cgame-command", name: "testmodel" },
      { kind: "diagnostic", text: "loading\n" }, { kind: "append-console-command", text: "echo ready\n" }]);
    expect(client.pendingEvents).toEqual([]);
  });
  test("native gamestate/full/delta messages feed owned cgame snapshots without changing native values", async () => {
    const client = session();
    (await client.receiveServerMessage(9, Buffer.from(GAMESTATE, "hex")));
    expect(client.getGameState()[0]).toBe("\\sv_hostname\\Fixture");
    expect(client.getGameState()[1]).toBe("\\sv_serverid\\123");
    expect(client.clientNumber).toBe(2); expect(client.checksumFeed).toBe(0x12345678);
    expect(client.serverId).toBe(123); expect(client.lastExecutedServerCommand).toBe(0);
    expect(client.serverCommandSequence).toBe(7);
    (await client.receiveServerMessage(10, Buffer.from(FULL, "hex")));
    const full = client.snapshots.read(10);
    expect(full?.playerState.origin).toEqual(vec3(10.5, 0, 0));
    expect(full?.entities.map(entity => entity.number)).toEqual([1, 3]);
    expect(full?.areaMask.length).toBe(32); expect(full?.areaMask.slice(0, 3)).toEqual(Uint8Array.of(3, 128, 0));
    if (full === null) throw new Error("Expected native full snapshot");
    full.playerState.origin = vec3(999, 999, 999); full.areaMask.fill(0);
    (await client.receiveServerMessage(11, Buffer.from(DELTA, "hex")));
    const delta = client.snapshots.read(11);
    expect(delta?.playerState.origin).toEqual(vec3(12, 0, 0));
    expect(delta?.entities.map(entity => entity.number)).toEqual([1, 2]);
    expect(client.snapshots.read(10)?.playerState.origin.x).toBe(10.5);
    expect(client.snapshots.current()).toEqual({ number: 11, serverTime: 1050 });
  });

  test("UI configstring presence preserves empty gamestate entries until a changed command rebuilds offsets", async () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const client = session(product);
      const productInfo: Gamestate["entries"] = [{ kind: "configstring", index: 1,
        value: `\\sv_serverid\\100\\sv_cheats\\1\\fs_game\\${product === "missionpack" ? "missionpack" : ""}` }];
      expect(client.getConfigString(0)).toBeNull();
      await send(client, [gamestate(0, [...productInfo, { kind: "configstring", index: 0, value: "" }, { kind: "configstring", index: 32, value: "old" }])]);
      expect(client.getConfigString(0)).toBe("");
      expect(client.getGameState()[0]).toBe("");
      await client.getServerCommand(await command(client, 'cs 0 ""'));
      expect(client.getConfigString(0)).toBe("");
      await client.getServerCommand(await command(client, 'cs 32 "new"'));
      expect(client.getConfigString(0)).toBeNull();
      expect(client.getConfigString(32)).toBe("new");
      await client.getServerCommand(await command(client, 'cs 0 "value"'));
      expect(client.getConfigString(0)).toBe("value");
      await client.getServerCommand(await command(client, 'cs 0 ""'));
      expect(client.getConfigString(0)).toBeNull();
      await send(client, [gamestate(client.serverCommandSequence, [...productInfo, { kind: "configstring", index: 0, value: "" }])]);
      expect(client.getConfigString(0)).toBe("");
      expect(client.getConfigString(32)).toBeNull();
      await send(client, [gamestate(client.serverCommandSequence, productInfo)]);
      expect(client.getConfigString(0)).toBeNull();
      expect(client.getConfigString(-1)).toBeNull(); expect(client.getConfigString(1024)).toBeNull();
    }
  });

  test("command acquisition defers configstrings, preserves ArgsFrom spacing and retains owned prior gamestate", async () => {
    const client = session(); (await send(client, [gamestate()]));
    const old = client.getGameState();
    const sequence = (await command(client, 'cs 32 "a  b" c /* discarded */ " d "'));
    expect(client.getGameState()[32]).toBe("");
    expect(await client.getServerCommand(sequence)).toEqual(["cs", "32", "a  b", "c", " d "]);
    expect(client.getGameState()[32]).toBe("a  b c  d "); expect(old[32]).toBe("");
    expect(client.lastExecutedServerCommand).toBe(sequence);
    const empty = (await command(client, "cs not_a_number")); await client.getServerCommand(empty);
    expect(client.getGameState()[0]).toBe("");
    (await send(client, [{ kind: "command", sequence, text: 'cs 32 "duplicate ignored"' }]));
    expect(client.getGameState()[32]).toBe("a  b c  d ");
  });

  test("bcs uses only argv2, ignores later chunk indexes and rescans into cs", async () => {
    const client = session(); (await send(client, [gamestate()]));
    expect(await client.getServerCommand((await command(client, 'bcs0 42 "first  " ignored')))).toBeNull();
    expect(await client.getServerCommand((await command(client, 'bcs1 999 "middle" ignored')))).toBeNull();
    expect(client.getGameState()[42]).toBe("");
    expect(await client.getServerCommand((await command(client, 'bcs2 -1 "  end" ignored')))).toEqual(["cs", "42", "first  middle  end"]);
    expect(client.getGameState()[42]).toBe("first  middle  end");
    expect(client.getGameState()[999]).toBe("");
  });

  test("bcs exact BIG_INFO_STRING terminator boundary and gamestate aggregate capacity", async () => {
    for (const length of [8183, 8184]) {
      const client = session(); (await send(client, [gamestate()]));
      const text = "x".repeat(length); let offset = 0;
      await client.getServerCommand((await command(client, `bcs0 42 "${text.slice(0, 999)}"`))); offset = 999;
      while (text.length - offset > 999) {
        await client.getServerCommand((await command(client, `bcs1 42 "${text.slice(offset, offset + 999)}"`))); offset += 999;
      }
      const finish = (await command(client, `bcs2 42 "${text.slice(offset)}"`));
      if (length === 8183) { await client.getServerCommand(finish); expect(client.getGameState()[42]).toBe(text); }
      else { await expect(client.getServerCommand(finish)).rejects.toThrow("BIG_INFO_STRING"); expect(client.dropped?.kind).toBe("drop"); }
    }
    const client = session(); (await send(client, [gamestate(0, [{ kind: "configstring", index: 2, value: "0".repeat(7950) },
      { kind: "configstring", index: 3, value: "0".repeat(7950) }])]));
    await expect((async () => await client.getServerCommand((await command(client, `cs 4 "${"c".repeat(100)}"`))))()).rejects.toThrow("MAX_GAMESTATE_CHARS");
  });

  test("map_restart clears all slots but preserves command number; gamestate resets active history only", async () => {
    const client = session(), commands = client.commands, snapshots = client.snapshots;
    (await send(client, [gamestate()])); client.prime(client.gamestateGeneration);
    for (let i = 0; i < 70; i++) client.createUserCommand(sample(i));
    expect(commands.currentNumber).toBe(70); expect(commands.read(6)).toBeNull();
    expect(() => commands.read(71)).toThrow("CL_GetUserCmd: 71 >= 70");
    await client.getServerCommand((await command(client, "map_restart")));
    expect(commands.currentNumber).toBe(70); expect(commands.read(6)).toBeNull();
    for (let i = 7; i <= 70; i++) expect(commands.read(i)?.serverTime).toBe(0);
    client.createUserCommand(sample(101)); expect(commands.currentNumber).toBe(71);
    expect(commands.read(71)?.serverTime).toBe(101); expect(commands.read(70)?.serverTime).toBe(0);
    expect(client.pendingEvents.some(event => event.kind === "clear-notify")).toBe(true);
    const executed = client.lastExecutedServerCommand;
    (await send(client, [gamestate(9)]));
    expect(client.commands).toBe(commands); expect(client.snapshots).toBe(snapshots);
    expect(commands.currentNumber).toBe(0); expect(commands.read(0)?.serverTime).toBe(0);
    expect(client.lastExecutedServerCommand).toBe(executed);
    expect(client.createUserCommand(sample())).toBeNull();
    expect(() => client.prime(1)).toThrow("stale");
  });

  test("finish-move uses byte weapon feedback and angle shorts; zoom remains separate input multiplier", async () => {
    const client = session(); expect(client.createUserCommand(sample())).toBeNull();
    (await send(client, [gamestate()])); client.prime(1);
    client.setUserCmdValue(256 + Weapon.WP_ROCKET_LAUNCHER, 0.3333333333);
    expect(client.userCmdSensitivity).toBe(Math.fround(0.3333333333));
    expect(client.createUserCommand(sample())).toBe(1);
    const cmd = client.commands.read(1);
    expect(cmd).toEqual({ serverTime: 1000, angles: vec3(16384, 49152, 0), buttons: 1,
      weapon: Weapon.WP_ROCKET_LAUNCHER, forwardmove: 127, rightmove: -127, upmove: 0 });
    if (cmd === null) throw new Error("Missing command"); cmd.angles = vec3(999, 0, 0);
    expect(client.commands.read(1)?.angles.x).toBe(16384);
    expect(() => client.createUserCommand({ ...sample(), forwardmove: 128 })).toThrow("movement");
  });

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: source ClampChar negative endpoint survives command history and encoded transmission`, async () => {
      const client = session(product), peer = new Netchannel("server", 27961);
      (await send(client, [{ ...gamestate(), entries: [{ kind: "configstring", index: 1,
        value: `\\sv_serverid\\100\\sv_cheats\\1\\fs_game\\${product === "missionpack" ? "missionpack" : ""}` }] }]));
      client.prime(1);
      // CL_KeyMove/MouseMove/JoystickMove clamp to a signed byte, including -128.
      const movement = { forwardmove: -128, rightmove: -128, upmove: -128 };
      expect(client.createUserCommand({ ...sample(), ...movement })).toBe(1);
      expect(client.commands.read(1)).toMatchObject(movement);
      const packet = peer.receive(at(transmitProtocolClient(client, 2000, 0, true), 0));
      if (packet.kind !== "accepted") throw new Error("Missing actual signed-byte client packet");
      const decoded = decodeClientMessage(xorClientMessage(packet.payload, 0x1234567, () => ""),
        { checksumFeed: 19, serverCommand: () => "", reliableSequence: 0, lastClientCommand: 0, lastUserCommandTime: 0 });
      if (decoded.kind !== "accepted") throw new Error("Server rejected signed-byte command");
      expect(decoded.movement?.commands).toHaveLength(1);
      expect(decoded.movement?.commands[0]).toMatchObject(movement);
      for (const value of [-129, 128, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        for (const axis of ["forwardmove", "rightmove", "upmove"] satisfies readonly (keyof typeof movement)[]) {
          expect(() => client.createUserCommand({ ...sample(), [axis]: value })).toThrow("movement");
          expect(client.commands.currentNumber).toBe(1);
        }
      }
    });
  }

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: native angle shorts preserve defined endpoints and reject undefined conversions before publication`, async () => {
      const client = session(product), peer = new Netchannel("server", 27961);
      (await send(client, [{ ...gamestate(), entries: [{ kind: "configstring", index: 1,
        value: `\\sv_serverid\\100\\sv_cheats\\1\\fs_game\\${product === "missionpack" ? "missionpack" : ""}` }] }]));
      client.prime(1);
      // Unchanged CL_FinishMove/ANGLE2SHORT, i386 SSE2 binary32 native profile.
      const defined: readonly (readonly [number, number])[] = [
        [90, 16384], [-90, 49152], [0.022, 4], [11796479, 65408], [-11796480, 0],
      ];
      for (const [index, [angle, expected]] of defined.entries()) {
        const number = client.createUserCommand({ ...sample(1000 + index), viewAngles: vec3(angle, angle, angle) });
        expect(number).toBe(index + 1);
        expect(client.commands.read(index + 1)?.angles).toEqual(vec3(expected, expected, expected));
      }
      const packet = peer.receive(at(transmitProtocolClient(client, 2000, 0, true), 0));
      if (packet.kind !== "accepted") throw new Error("Missing actual native-angle packet");
      const decoded = decodeClientMessage(xorClientMessage(packet.payload, 0x1234567, () => ""),
        { checksumFeed: 19, serverCommand: () => "", reliableSequence: 0, lastClientCommand: 0, lastUserCommandTime: 0 });
      if (decoded.kind !== "accepted") throw new Error("Server rejected defined angle command");
      expect(decoded.movement?.commands.map(command => command.angles)).toEqual(defined.map(([, value]) => [value, value, value]));
      // +2^31 is not representable by the native signed cast; -2^31 above is valid.
      for (const value of [11796480, 11796479.75, -11796481, 1e20, -1e20, Number.MAX_VALUE]) {
        for (const axis of ["x", "y", "z"] satisfies readonly (keyof ReturnType<typeof vec3>)[]) {
          expect(() => client.createUserCommand({ ...sample(), viewAngles: { ...vec3(0, 0, 0), [axis]: value } }))
            .toThrow("Undefined native angle float-to-int conversion");
          expect(client.commands.currentNumber).toBe(defined.length);
        }
      }
      expect(client.dropped).toBeNull();
      expect(client.createUserCommand(sample(2001))).toBe(defined.length + 1);
    });
  }

  test("lost/invalid snapshots do not replace latest; inactive flags and cgame entity cap survive", async () => {
    const client = session(); (await send(client, [gamestate()]));
    const first = snapshot(2, 2); (await send(client, [operation(first)]));
    expect(client.snapshots.read(2)?.flags).toBe(2);
    const old = snapshot(3); const missing = { ...snapshot(4), deltaNumber: 3 };
    (await send(client, [operation(missing)], 4, { status: "valid", snapshot: old }));
    expect(client.snapshots.current().number).toBe(2);
    expect(client.serverMessageSequence).toBe(4);
    const entities = Array.from({ length: 300 }, (_, number) => { const entity = new EntityState(); entity.number = number; return entity; });
    (await send(client, [operation(snapshot(5, 0, entities))]));
    expect(client.snapshots.read(3)).toBeNull(); expect(client.snapshots.read(4)).toBeNull();
    expect(client.snapshots.read(5)?.entities.length).toBe(256);
    const lifecycle = client.lifecycle;
    if (!(lifecycle instanceof ProtocolClientLifecycle)) throw new Error("Expected protocol fixture lifecycle");
    expect(lifecycle.debugMessages).toEqual(["Delta from invalid frame (not supposed to happen!).\n", "CL_GetSnapshot: truncated 300 entities to 256\n"]);
    expect(() => client.snapshots.read(6)).toThrow("snapshotNumber");
    (await send(client, [operation(snapshot(37))], 37));
    expect(client.snapshots.read(5)).toBeNull();
  });

  test("reliable acquisition has exact 64-slot stale boundary, demo exception, and terminal disconnect", async () => {
    for (const demo of [false, true]) {
      const client = session("baseq3", demo); (await send(client, [gamestate()]));
      for (let i = 0; i < 65; i++) (await command(client, `print ${i}`));
      expect(await client.getServerCommand(2)).toEqual(["print", "1"]);
      if (demo) expect(await client.getServerCommand(1)).toBeNull();
      else await expect(client.getServerCommand(1)).rejects.toThrow("cycled out");
    }
    const client = session(); (await send(client, [gamestate()]));
    const sequence = (await command(client, 'disconnect "Fixture reason" extra'));
    expect(client.dropped).toBeNull();
    await expect(client.getServerCommand(sequence)).rejects.toThrow("Server Disconnected - Fixture reason");
    expect(client.lastExecutedServerCommand).toBe(sequence);
    expect(client.pendingEvents.at(-1)).toEqual({ kind: "disconnect", reason: "Server Disconnected - Fixture reason", errorKind: "server-disconnect" });
    expect(() => client.addReliableCommand("say no")).toThrow("Fixture reason");
    await expect((async () => (await client.receiveServerMessage(99, Uint8Array.of(0))))()).rejects.toThrow("Fixture reason");
  });

  test("console side effects are explicit, ordered, owned and remote levelshots cannot write", async () => {
    const client = session(); (await send(client, [gamestate()]));
    expect(client.takeEvents()).toEqual([{ kind: "close-console" }, { kind: "clear-active-state" }, { kind: "gamestate", generation: 1 }]);
    expect(await client.getServerCommand((await command(client, "clientLevelShot")))).toBeNull(); expect(client.pendingEvents).toEqual([]);
    client.cvars.set("sv_running", "1", true);
    expect(await client.getServerCommand((await command(client, "clientLevelShot")))).toEqual(["clientLevelShot"]);
    const pending = client.pendingEvents; const taken = client.takeEvents();
    expect(taken).toEqual([{ kind: "close-console" }, { kind: "append-console-command", text: "wait ; wait ; wait ; wait ; screenshot levelshot\n" }]);
    expect(pending).toEqual(taken); expect(client.pendingEvents).toEqual([]);
  });

  test("nonpure referenced-pack metadata is retained for both products without enabling pure filtering", async () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const client = session(product), game = product === "missionpack" ? "missionpack" : "";
      const references = "123 -456", names = "baseq3/pak0 missionpack/pak0";
      (await send(client, [gamestate(0, [{ kind: "configstring", index: 1,
        value: `\\sv_serverid\\100\\sv_pure\\0\\sv_paks\\\\sv_referencedPaks\\${references}\\sv_referencedPakNames\\${names}\\fs_game\\${game}` }])]));
      expect(client.dropped).toBeNull();
      expect(client.gamestateGeneration).toBe(1);
      expect(client.cvars.get("sv_referencedPaks")?.value).toBe(references);
      expect(client.cvars.get("sv_referencedPakNames")?.value).toBe(names);
      const update = (await command(client, `cs 1 "\\sv_serverid\\200\\sv_pure\\0\\sv_referencedPaks\\789\\sv_referencedPakNames\\baseq3/pak1\\fs_game\\${game}"`));
      await client.getServerCommand(update);
      expect(client.serverId).toBe(200);
      expect(client.cvars.get("sv_referencedPaks")?.value).toBe("789");
      expect(client.cvars.get("sv_referencedPakNames")?.value).toBe("baseq3/pak1");
      expect(client.dropped).toBeNull();
    }
  });

  test("systeminfo resets cheats and awaits the explicitly separate package owner", async () => {
    const client = session(); client.cvars.register("cheat", "1", CvarFlag.Cheat); client.cvars.set("cheat", "2");
    (await send(client, [gamestate()]));
    const update = (await command(client, 'cs 1 "\\sv_serverid\\200\\sv_cheats\\0"'));
    expect(client.serverId).toBe(100); await client.getServerCommand(update);
    expect(client.serverId).toBe(200); expect(client.cvars.get("cheat")?.value).toBe("1");
    const rejected = session();
    await expect(send(rejected, [gamestate(0, [{ kind: "configstring", index: 1, value: "\\sv_paks\\123" }])]))
      .rejects.toThrow("Protocol fixture has no pure filesystem");
    const pure = session();
    await send(pure, [gamestate(0, [{ kind: "configstring", index: 1, value: "\\sv_pure\\1" }])]);
    expect(pure.lifecycle.clientConnection.connectedToPureServer).toBe(true);
    const demo = session("baseq3", true); (await send(demo, [gamestate(0, [{ kind: "configstring", index: 1, value: "\\sv_serverid\\77\\sv_pure\\1" }])]));
    expect(demo.serverId).toBe(77); expect(demo.cvars.get("sv_pure")).toBeUndefined();
    const switched = session("missionpack");
    await send(switched, [gamestate()]);
    expect(switched.cvars.get("fs_game")?.value ?? "").toBe("");
    const download = session();
    await expect((async () => (await send(download, [{ kind: "download", block: { kind: "start", fileSize: 1, data: Uint8Array.of(1) } }])))()).rejects.toThrow("download");
  });

  test("native truncations/malformed packets drop only this connection; malformed channel headers reject", async () => {
    const bytes = Buffer.from(GAMESTATE, "hex");
    for (let length = 0; length < bytes.length; length++) {
      const client = session(); await expect((async () => (await client.receiveServerMessage(1, bytes.subarray(0, length))))()).rejects.toThrow();
      expect(client.dropped?.kind).toBe("drop");
    }
    const a = session(), b = session();
    expect((await a.receiveDatagram(Uint8Array.of(1)))).toEqual({ kind: "rejected", reason: "malformed" });
    expect(a.dropped).toBeNull(); (await send(b, [gamestate()])); expect(b.gamestateGeneration).toBe(1);
  });

  test("real netchannel fragments and XOR feed gamestate; outgoing movement uses acknowledged server command key", async () => {
    const client = session(), server = new Netchannel("server", 27961), challenge = 0x1234567;
    client.addReliableCommand("userinfo alpha");
    const initial = gamestate(0, Array.from({ length: 30 }, (_, index) => ({ kind: "configstring", index: index + 10, value: `entry ${index} ${"abcdefghij".repeat(20)}` })));
    const raw = encodeServerMessage(1, [initial], context(1));
    const packets = server.transmit(xorServerMessage(raw, challenge, 1, "userinfo alpha"));
    expect(packets.length).toBeGreaterThan(1);
    for (let index = 0; index < packets.length; index++) {
      const result = (await client.receiveDatagram(at(packets, index)));
      expect(result.kind).toBe(index === packets.length - 1 ? "accepted" : "fragment");
    }
    expect((await client.receiveDatagram(at(packets, 0)))).toEqual({ kind: "rejected", reason: "sequence" });
    client.prime(1); client.setUserCmdValue(Weapon.WP_MACHINEGUN, 0.5); client.createUserCommand(sample());
    const message = server.receive(at(transmitProtocolClient(client, 2000, 1, false), 0));
    if (message.kind !== "accepted") throw new Error("Missing actual client packet");
    const decoded = decodeClientMessage(xorClientMessage(message.payload, challenge, () => ""),
      { checksumFeed: 19, serverCommand: () => "", reliableSequence: 0, lastClientCommand: 0, lastUserCommandTime: 0 });
    if (decoded.kind !== "accepted") throw new Error("Server rejected client payload");
    expect(decoded.header).toEqual({ serverId: 100, messageAcknowledge: 1, reliableAcknowledge: 0 });
    expect(decoded.commands).toEqual([]); expect(decoded.movement?.kind).toBe("move-no-delta");
    expect(decoded.movement?.commands[0]?.weapon).toBe(Weapon.WP_MACHINEGUN);
  });

  test("packet backups recover skipped commands, switch to no-delta after loss and retain map-restart sequence", async () => {
    const client = session(), server = new Netchannel("server", 27961);
    (await send(client, [gamestate()])); client.prime(1);
    const received = (await command(client, 'print "acknowledged text"'));
    const first = snapshot(3); (await send(client, [operation(first)]));
    const read = (packetDup: number) => {
      const packet = server.receive(at(transmitProtocolClient(client, 1000, packetDup, false), 0));
      if (packet.kind !== "accepted") throw new Error("Missing outgoing packet");
      const text = 'print "acknowledged text"';
      const decoded = decodeClientMessage(xorClientMessage(packet.payload, 0x1234567, () => text),
        { checksumFeed: 19, serverCommand: () => text, reliableSequence: received, lastClientCommand: 0, lastUserCommandTime: 0 });
      if (decoded.kind !== "accepted") throw new Error("Rejected backup packet");
      return decoded;
    };
    for (let i = 1; i <= 3; i++) client.createUserCommand(sample(i * 50));
    const initial = read(0); expect(initial.movement?.kind).toBe("move");
    expect(initial.movement?.commands.map(value => value.serverTime)).toEqual([50, 100, 150]);
    client.createUserCommand(sample(200));
    expect(read(1).movement?.commands.map(value => value.serverTime)).toEqual([50, 100, 150, 200]);
    client.createUserCommand(sample(250));
    const absent = snapshot(4); (await send(client, [operation({ ...snapshot(5), deltaNumber: 4 })], 5, { status: "valid", snapshot: absent }));
    const loss = read(1); expect(loss.movement?.kind).toBe("move-no-delta");
    expect(loss.movement?.commands.map(value => value.serverTime)).toEqual([200, 250]);
    (await send(client, [operation(snapshot(6))])); client.createUserCommand(sample(300));
    expect(read(0).movement?.kind).toBe("move");
    for (let i = 0; i < 40; i++) client.createUserCommand(sample(400 + i));
    expect(read(0).movement?.commands.length).toBe(32);
  });

  test("reliable overflow is terminal; gamestate does not reset unacknowledged client commands", async () => {
    const client = session();
    for (let i = 1; i <= 65; i++) expect(client.addReliableCommand(`say ${i}`).sequence).toBe(i);
    expect(() => client.addReliableCommand("overflow")).toThrow("overflow");
    expect(client.dropped?.kind).toBe("drop");
    const fresh = session(), peer = new Netchannel("server", 27961);
    fresh.addReliableCommand("say before"); (await send(fresh, [gamestate()])); fresh.addReliableCommand("say after");
    const result = peer.receive(at(transmitProtocolClient(fresh, 100, 0, true), 0));
    if (result.kind !== "accepted") throw new Error("Missing reliable packet");
    const decoded = decodeClientMessage(xorClientMessage(result.payload, 0x1234567, () => ""),
      { checksumFeed: 19, serverCommand: () => "", reliableSequence: 0, lastClientCommand: 0, lastUserCommandTime: 0 });
    expect(decoded.commands).toEqual([{ sequence: 1, text: "say before" }, { sequence: 2, text: "say after" }]);
  });
});

function gameMap(): BspMap {
  const bounds = { min: vec3(-4096, -4096, -4096), max: vec3(4096, 4096, 4096) };
  return { entities: '{ "classname" "worldspawn" } { "classname" "info_player_deathmatch" "origin" "0 0 0" }',
    entityRecords: [], planes: [], nodes: [], leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    visibility: { clusterCount: 1, bytesPerCluster: 1, bits: Uint8Array.of(1) }, shaders: [], leafSurfaces: [], leafBrushes: [],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [] };
}

for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  test(`${product}: actual GameRuntime and ServerSnapshotRuntime publish through real session packets`, async () => {
    const fixture = createGameVerificationHarness({ product, map: gameMap(), gameType: GameType.GT_FFA, levelTime: 1000,
      randomSeed: 42, buildDate: "Sep 5 2026", clientNamePrefix: "Session", botsReason: "No bots in session fixture",
      });
    const game = fixture.runtime;
    expect(game.clientConnect(0, true, false)).toBeNull(); game.clientBegin(0);
    const statics = new ServerStaticState({ product, maxClients: 4, dedicated: false });
    const world = new ServerWorldState(statics, { print: text => fixture.prints.push(text), dropClient: (_client, reason) => { throw new Error(reason); } });
    world.game = game; world.state = "game"; statics.time = 1000;
    const peer = at(statics.clients, 0), channel = new Netchannel("server", 27961);
    peer.connection = { kind: "initialized", phase: ServerClientPhase.Active, address: { kind: "loopback" }, netchan: channel };
    peer.gameEntity = game.data.entity(peer.slot);
    const entity = game.pool.spawn(); setOrigin(entity, vec3(100, 0, 0)); entity.s.modelindex = 7; game.world.link(entity);
    const server = new ServerSnapshotRuntime(world, statics, { collision: game.options.collision, spatial: game.world, debugPrint: text => fixture.prints.push(text) });
    server.createBaselines();
    const client = session(product);
    const entries: Gamestate["entries"] = [
      { kind: "configstring", index: 1, value: `\\sv_serverid\\100\\sv_cheats\\1\\fs_game\\${product === "missionpack" ? "missionpack" : ""}` },
      ...world.baselines.filter(value => value.number !== 0)
        .map((value): Extract<Gamestate["entries"][number], { kind: "baseline" }> => ({ kind: "baseline", number: value.number, entity: value.copy() })),
    ];
    const initial = encodeServerMessage(0, [gamestate(0, entries)], context(1, product));
    for (const packet of channel.transmit(xorServerMessage(initial, 0x1234567, 1, ""))) (await client.receiveDatagram(packet));
    client.prime(1);
    for (let index = 0; index < 3; index++) {
      statics.time += 50; game.runFrame(statics.time);
      server.buildClientSnapshot(peer);
      const expected = server.snapshotOperation(peer), ctx = server.messageContext(peer);
      const writer = new MessageWriter(); writer.writeLong(0);
      server.writeSnapshotToClient(peer, writer); writer.writeByte(ServerOpcode.Eof);
      const bytes = writer.toBytes();
      for (const packet of channel.transmit(xorServerMessage(bytes, 0x1234567, ctx.messageNumber, ""))) (await client.receiveDatagram(packet));
      const actual = client.snapshots.read(ctx.messageNumber);
      expect(actual?.playerState.origin).toEqual(expected.snapshot.playerState.origin);
      expect(actual?.playerState.stats.get(statSchema(product).health)).toBe(expected.snapshot.playerState.stats.get(statSchema(product).health));
      expect(actual?.entities.map(value => value.number)).toEqual(expected.snapshot.entities.map(value => value.number));
      expect(actual?.entities.find(value => value.number === entity.slot)?.modelindex).toBe(7);
      peer.deltaMessage = ctx.messageNumber;
    }
    expect(client.snapshots.current().serverTime).toBe(1150);
    expect(client.dropped).toBeNull();
  });

  test(`${product}: a wrapped server snapshot retains source order through the actual client session`, async () => {
    const fixture = createGameVerificationHarness({ product, map: { ...gameMap(), entities: '{ "classname" "worldspawn" }' },
      gameType: GameType.GT_FFA, levelTime: 1000, randomSeed: 42, buildDate: "Sep 5 2026", clientNamePrefix: "Session",
      botsReason: "No bots in session fixture", additionalCvars: [["sv_maxclients", "1"]] });
    const game = fixture.runtime;
    expect(game.pool.numEntities).toBe(72);
    const statics = new ServerStaticState({ product, maxClients: 1, dedicated: false });
    const world = new ServerWorldState(statics, { print: text => fixture.prints.push(text), dropClient: (_client, reason) => { throw new Error(reason); } });
    world.game = game; world.state = "game"; statics.time = 1000;
    const peer = at(statics.clients, 0);
    peer.connection = { kind: "initialized", phase: ServerClientPhase.Active, address: { kind: "loopback" }, netchan: new Netchannel("server", 27961) };
    peer.gameEntity = game.data.entity(peer.slot);
    for (let index = 0; index < 257; index++) {
      const entity = game.pool.spawn();
      entity.r.linked = true; entity.r.svFlags = ServerEntityFlags.BROADCAST;
      entity.s.modelindex = (index & 15) + 1;
    }
    const server = new ServerSnapshotRuntime(world, statics, { collision: game.options.collision, spatial: game.world, debugPrint: text => fixture.prints.push(text) });
    const frame = server.buildClientSnapshot(peer);
    expect(statics.numSnapshotEntities).toBe(256); expect(frame.numEntities).toBe(257);
    const writer = new MessageWriter(); writer.writeLong(0);
    writer.writeByte(ServerOpcode.Command); writer.writeLong(1); writer.writeString("before wrapped snapshot");
    server.writeSnapshotToClient(peer, writer);
    writer.writeByte(ServerOpcode.Command); writer.writeLong(2); writer.writeString("after wrapped snapshot");
    writer.writeByte(ServerOpcode.Eof);
    const client = session(product);
    const result = await client.receiveServerMessage(1, writer.toBytes());
    const parsed = result?.operations[1];
    if (parsed?.kind !== "snapshot") throw new Error("Missing wrapped server snapshot");
    const expected = [328, ...Array.from({ length: 256 }, (_, index) => index + 73)];
    expect(parsed.validity).toEqual({ kind: "valid" });
    expect(parsed.snapshot.entities.map(entity => entity.number)).toEqual(expected);
    expect(parsed.snapshot.serverCommandNumber).toBe(1);
    expect(result?.operations[2]).toEqual({ kind: "command", sequence: 2, text: "after wrapped snapshot" });
    expect(client.serverCommandSequence).toBe(2);
    expect(client.active.parseEntitiesNumber).toBe(257);
    expect(client.active.history.readSlot(1)?.snapshot.entities.map(entity => entity.number)).toEqual(expected);
    const presented = client.snapshots.read(1);
    expect(presented?.entities.map(entity => entity.number)).toEqual(expected.slice(0, 256));
    expect(presented?.entities.map(entity => entity.modelindex)).toEqual(expected.slice(0, 256).map(number => ((number - 72) & 15) + 1));
    at(parsed.snapshot.entities, 0).modelindex = 99;
    at(parsed.snapshot.entities, 256).modelindex = 98;
    expect([client.active.parseEntities.at(0).modelindex, client.active.parseEntities.at(256).modelindex]).toEqual([1, 1]);
    expect(client.active.history.readSlot(1)?.snapshot.entities[0]?.modelindex).toBe(1);
    expect(client.active.newSnapshots).toBe(true); expect(client.dropped).toBeNull();
    const lifecycle = client.lifecycle;
    if (!(lifecycle instanceof ProtocolClientLifecycle)) throw new Error("Expected protocol fixture lifecycle");
    expect(lifecycle.debugMessages).toEqual(["CL_GetSnapshot: truncated 257 entities to 256\n"]);
    lifecycle.close();
  });
}
