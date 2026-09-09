import { createProtocolClientSession } from "../tools/client-protocol-fixture.ts";
import { describe, expect, test } from "bun:test";
import { CvarRegistry } from "../src/core/cvar.ts";
import { tmpdir } from "node:os";
import { UdpTransport } from "../src/platform/network.ts";
import type { Ipv4Address } from "../src/platform/network.ts";
import { decodeConnectionless, encodeConnectionlessText } from "../src/protocol/connectionless.ts";
import { Netchannel, xorServerMessage } from "../src/protocol/netchan.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { Gamestate, ServerOperation, Snapshot, SnapshotHistoryEntry } from "../src/protocol/server-message.ts";
import type { Product } from "../src/shared/definitions.ts";
import { PlayerState } from "../src/shared/player-state.ts";
import { DedicatedPacketObserver, verifyDedicatedServer } from "../tools/verify-dedicated-server.ts";

function fixture(product: Product = "baseq3") {
  const challenge = 12345, qport = 27961, channel = new Netchannel("server", qport);
  const client = createProtocolClientSession({ product, cvars: new CvarRegistry(), mode: { kind: "network", challenge, qport } });
  const observer = new DedicatedPacketObserver(client);
  function packets(operations: readonly ServerOperation[], old: SnapshotHistoryEntry | null = null): readonly Uint8Array[] {
    const sequence = channel.outgoingSequence;
    const bytes = encodeServerMessage(0, operations, { product, messageNumber: sequence, reliableSequence: 0,
      serverCommandSequence: client.serverCommandSequence, parseEntitiesNumber: 0, baseline: () => null, history: () => old });
    return channel.transmit(xorServerMessage(bytes, challenge, sequence, ""));
  }
  async function send(operations: readonly ServerOperation[], old: SnapshotHistoryEntry | null = null): Promise<void> {
    for (const packet of packets(operations, old)) (await observer.receive(packet));
  }
  function gamestate(serverId = 100, large = false): Gamestate {
    return { kind: "gamestate", commandSequence: client.serverCommandSequence, clientNumber: 0, checksumFeed: 1,
      entries: [{ kind: "configstring", index: 1,
        value: `\\sv_serverid\\${serverId}\\sv_cheats\\1\\fs_game\\${product === "missionpack" ? "missionpack" : ""}` },
      ...(large ? [{ kind: "configstring", index: 10, value: "abcdefghijklmnopqrstuvwxyz0123456789".repeat(80) } satisfies Gamestate["entries"][number]] : [])] };
  }
  function snapshot(deltaNumber = -1): Extract<ServerOperation, { kind: "snapshot" }> {
    const number = channel.outgoingSequence;
    return { kind: "snapshot", validity: { kind: "valid" }, snapshot: { messageNumber: number, serverTime: number * 50,
      deltaNumber, flags: 0, serverCommandNumber: client.serverCommandSequence, parseEntitiesNumber: 0,
      areaMask: new Uint8Array(0), playerState: new PlayerState(product), entities: [] } };
  }
  function disconnect(sequence: number): Extract<ServerOperation, { kind: "command" }> {
    return { kind: "command", sequence, text: "disconnect" };
  }
  return { client, observer, channel, packets, send, gamestate, snapshot, disconnect };
}

/** Deliberately incomplete negative peer. It must never count as server implementation or successful verification. */
async function noProgressPeer(): Promise<void> {
  const portText = Bun.argv[Bun.argv.indexOf("net_port") + 1];
  if (portText === undefined || !/^\d+$/.test(portText)) throw new Error("Missing negative-peer UDP port");
  const port = Number(portText);
  if (port < 1 || port > 65535) throw new Error("Invalid negative-peer UDP port");
  const socket = await UdpTransport.bind({ host: [127, 0, 0, 1], port }), f = fixture();
  let destination: Ipv4Address | null = null, running = true, began: number | null = null, sent = 0;
  const stop = (): void => { running = false; };
  process.on("SIGTERM", stop);
  process.stdout.write(`Opening IP socket: 127.0.0.1:${port}\n__DEDICATED_READY__ \nNEGATIVE_PEER_PID ${process.pid}\n`);
  try {
    const hardStop = performance.now() + 22000;
    while (running && performance.now() < hardStop) {
      const packet = socket.poll();
      if (packet !== null) {
        if (packet.kind === "error") throw packet.error;
        if (packet.payload[0] === 255 && packet.payload[1] === 255 && packet.payload[2] === 255 && packet.payload[3] === 255) {
          const message = decodeConnectionless(packet.payload, "server");
          if (message.command === "getchallenge") socket.send(packet.from, encodeConnectionlessText("challengeResponse 12345"));
          if (message.command === "connect") {
            socket.send(packet.from, encodeConnectionlessText("connectResponse")); destination = packet.from; began = performance.now();
          }
        }
      }
      if (destination !== null && began !== null) {
        for (const bytes of f.packets([{ kind: "nop" }])) {
          if ((await f.observer.receive(bytes)).kind !== "accepted") throw new Error("Negative fixture did not produce canonical accepted traffic");
          socket.send(destination, bytes); sent++;
        }
        if (sent === 1) process.stdout.write(`CANONICAL NOP accepted; gamestates=${f.client.gamestateGeneration}\n`);
        if (performance.now() - began >= 17000) break;
      }
      await Bun.sleep(50);
    }
  } finally { socket.close(); process.off("SIGTERM", stop); }
}

if (import.meta.main && Bun.argv.includes("--dedicated-negative-peer")) {
  await noProgressPeer();
} else describe("dedicated verifier canonical packet evidence", () => {
  test("continuous accepted UDP traffic cannot renew the initial-gamestate phase deadline", async () => {
    const started = performance.now();
    let failure: unknown;
    try {
      await verifyDedicatedServer({ command: [process.execPath, import.meta.path, "--dedicated-negative-peer"],
        dataPath: tmpdir(), product: "baseq3", stop: "quit" });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Missing verifier phase timeout");
    expect(failure.message).toContain("Timed out waiting for initial gamestate:");
    expect(failure.message).toContain("CANONICAL NOP accepted; gamestates=0");
    expect(failure.message).not.toContain("Dedicated process exited before");
    expect(performance.now() - started).toBeGreaterThanOrEqual(15000);
    const portText = /Opening IP socket: 127\.0\.0\.1:(\d+)/.exec(failure.message)?.[1];
    const pidText = /NEGATIVE_PEER_PID (\d+)/.exec(failure.message)?.[1];
    if (portText === undefined || pidText === undefined) throw new Error("Missing negative-peer cleanup evidence");
    const rebound = await UdpTransport.bind({ host: [127, 0, 0, 1], port: Number(portText) }); rebound.close();
    expect(() => process.kill(Number(pidText), 0)).toThrow();
  }, 25000);

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: counts accepted valid snapshots across gamestates, not datagrams or message sequences`, async () => {
      const f = fixture(product), fragments = f.packets([f.gamestate(100, true)]);
      expect(fragments.length).toBeGreaterThan(1);
      const first = fragments[0]; if (first === undefined) throw new Error("Missing first encoded fragment");
      expect((await f.observer.receive(first)).kind).toBe("fragment");
      expect(f.observer.snapshots).toBe(0); expect(f.client.gamestateGeneration).toBe(0);
      for (const packet of fragments.slice(1)) (await f.observer.receive(packet));
      expect(f.client.gamestateGeneration).toBe(1);
      const snapshotPackets = f.packets([f.snapshot()]);
      for (const packet of snapshotPackets) (await f.observer.receive(packet));
      expect(f.observer.snapshots).toBe(1); expect(f.client.snapshots.current().number).toBe(2);
      (await f.send([{ kind: "nop" }])); expect(f.client.serverMessageSequence).toBe(3); expect(f.observer.snapshots).toBe(1);
      const duplicate = snapshotPackets[0]; if (duplicate === undefined) throw new Error("Missing duplicate encoded datagram");
      expect((await f.observer.receive(duplicate)).kind).toBe("rejected"); expect(f.observer.snapshots).toBe(1);
      (await f.send([f.gamestate(200)])); expect(f.client.gamestateGeneration).toBe(2);
      expect(f.client.snapshots.current().number).toBe(0); expect(f.observer.snapshots).toBe(1);
      (await f.send([f.snapshot()])); expect(f.observer.snapshots).toBe(2); expect(f.client.serverMessageSequence).toBe(5);
    });
  }

  test("canonical missing-delta rejection cannot qualify a shutdown packet or make its repeated disconnect new", async () => {
    const f = fixture(); (await f.send([f.gamestate()])); (await f.send([{ kind: "nop" }]));
    f.observer.beginShutdown();
    const unavailable: Snapshot = { ...f.snapshot().snapshot, messageNumber: 2 };
    const packets = f.packets([f.disconnect(1), f.snapshot(2)], { status: "valid", snapshot: unavailable });
    const packet = packets[0]; if (packet === undefined || packets.length !== 1) throw new Error("Expected one invalid-delta datagram");
    const result = (await f.observer.receive(packet));
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("Expected channel-accepted invalid snapshot");
    const decoded = result.message.operations.find(operation => operation.kind === "snapshot");
    expect(decoded?.validity).toEqual({ kind: "invalid", reason: "missing-delta" });
    expect(f.client.snapshots.current().number).toBe(0); expect(f.observer.snapshots).toBe(0); expect(f.observer.finalPackets).toBe(0);
    (await f.send([f.disconnect(1), f.snapshot()])); expect(f.observer.snapshots).toBe(1); expect(f.observer.finalPackets).toBe(0);
    (await f.send([f.disconnect(2), f.snapshot()])); expect(f.observer.finalPackets).toBe(1);
    (await f.send([f.disconnect(2), f.disconnect(3), f.snapshot()]));
    expect(f.observer.finalDatagrams).toEqual([
      { messageSequence: 5, snapshotMessageNumber: 5, disconnectSequence: 2 },
      { messageSequence: 6, snapshotMessageNumber: 6, disconnectSequence: 3 },
    ]);
  });

  test("two new disconnect commands in one datagram prove only one final packet, even when replayed", async () => {
    const f = fixture(); (await f.send([f.gamestate()])); f.observer.beginShutdown();
    (await f.send([f.disconnect(1), f.disconnect(2), f.snapshot()])); expect(f.observer.finalPackets).toBe(1);
    (await f.send([f.disconnect(1), f.disconnect(2), f.snapshot()])); expect(f.observer.finalPackets).toBe(1);
    (await f.send([f.disconnect(2), f.disconnect(3), f.snapshot()])); expect(f.observer.finalPackets).toBe(2);
    expect(f.observer.snapshots).toBe(3);
    expect(f.observer.finalDatagrams.map(packet => [packet.messageSequence, packet.disconnectSequence])).toEqual([[2, 2], [4, 3]]);
  });

  test("command-only packets and pre-shutdown reliable backlog cannot masquerade as either final pass", async () => {
    const f = fixture(); (await f.send([f.gamestate()])); (await f.send([f.disconnect(1)])); f.observer.beginShutdown();
    expect(() => f.observer.beginShutdown()).toThrow("already began");
    (await f.send([f.disconnect(1), f.snapshot()])); expect(f.observer.finalPackets).toBe(0);
    (await f.send([f.disconnect(2)])); expect(f.observer.finalPackets).toBe(0);
    (await f.send([f.disconnect(2), f.snapshot()])); expect(f.observer.finalPackets).toBe(0);
    (await f.send([f.disconnect(3), f.snapshot()])); expect(f.observer.finalPackets).toBe(1);
    const before = f.observer.finalDatagrams;
    (await f.send([f.disconnect(3), f.disconnect(4), f.snapshot()]));
    expect(f.observer.finalPackets).toBe(2); expect(before).toHaveLength(1);
    expect(f.observer.finalDatagrams.map(packet => packet.disconnectSequence)).toEqual([3, 4]);
    expect(f.observer.snapshots).toBe(4);
  });
});
