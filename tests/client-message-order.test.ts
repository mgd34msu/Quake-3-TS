import { expect, test } from "bun:test";
import { CvarRegistry } from "../src/core/cvar.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { ServerMessageCursor, encodeServerMessage } from "../src/protocol/server-message.ts";
import type { ServerMessageContext } from "../src/protocol/server-message.ts";
import { EntityState } from "../src/shared/entity-state.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";

// Unchanged dbe4ddb cl_parse.c/cl_main.c/cl_cgame.c + MSG_* native fixture.
// /tmp/quake3-client-parse-native-fiNEqL, both products produce identical traces.
// VM/lifecycle imports in that oracle observe control flow, not real CG_Init.
const OUTER = "6c159956d93a0bccc28e0c35ed13000000f05f91eaacfa27d9aaca34931113751698851dc1fb78f6d1231e864b56";
const INNER_SNAPSHOT = "a1ea0fe05755a699ac00";
const INNER_GAMESTATE = "a12ab23b95ad280c0cb023434dfb040000004cab6cb57bb502";
const INNER_BOTH = "a12ab23b95ad280c0cb023434dfb040000004cab6cb57bf507f0ab2ad34c56";
const INNER_COMMAND = "a16a44772a0a0303ec08dec7b38f1ef1305cb202";
const context: ServerMessageContext = { product: "baseq3", messageNumber: 100, reliableSequence: 10,
  serverCommandSequence: 8, parseEntitiesNumber: 7, baseline: () => null, history: () => null };

async function fixture() {
  const cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
  const session = new EngineClientSession({ product: "baseq3", cvars, lifecycle, mode: { kind: "network", challenge: 1, qport: 1 } });
  const baseline = new EntityState(); baseline.number = 42; baseline.modelindex = 5;
  await session.receiveServerMessage(90, encodeServerMessage(0, [{ kind: "gamestate", commandSequence: 8,
    entries: [{ kind: "baseline", number: 42, entity: baseline }], clientNumber: 8, checksumFeed: 888 }], { ...context, messageNumber: 90 }));
  await session.getServerCommand(6); lifecycle.clientStatic.phase = "active"; session.takeEvents();
  const initialized: { readonly sequence: number; readonly command: number; readonly client: number; readonly checksum: number; readonly config: string | undefined }[] = [];
  let nested: string | null = null;
  lifecycle.gamestateReceived = async () => {
    lifecycle.assertCurrentOperation();
    lifecycle.clientStatic.phase = "loading";
    if (nested !== null) {
      const bytes = Buffer.from(nested, "hex"); nested = null;
      await session.receiveServerMessage(101, bytes);
      lifecycle.assertCurrentOperation();
    }
    // Actual CL_DownloadsComplete state recheck, measured against native fixture.
    if (lifecycle.clientStatic.phase !== "loading") return;
    initialized.push({ sequence: session.serverMessageSequence, command: session.lastExecutedServerCommand,
      client: session.clientNumber, checksum: session.checksumFeed, config: session.getGameState()[0] });
    session.prime(session.gamestateGeneration);
  };
  return { session, lifecycle, initialized, nest(bytes: string): void { nested = bytes; } };
}

for (const item of [
  { name: "no nested message", inner: null, sequence: 100, command: 12, model: 7, client: 2, checksum: 111, config: "outer", parsed: 0 },
  { name: "inner gamestate", inner: INNER_GAMESTATE, sequence: 101, command: 20, model: 9, client: 3, checksum: 222, config: "inner", parsed: 0 },
  { name: "inner gamestate and snapshot", inner: INNER_BOTH, sequence: 101, command: 20, model: 9, client: 3, checksum: 222, config: "inner", parsed: 1 },
  { name: "inner snapshot", inner: INNER_SNAPSHOT, sequence: 101, command: 12, model: 7, client: 2, checksum: 111, config: "outer", parsed: 1 },
  { name: "inner command", inner: INNER_COMMAND, sequence: 101, command: 20, model: 7, client: 2, checksum: 111, config: "outer", parsed: 0 },
]) test(`native source parser continuation: ${item.name}`, async () => {
  const f = await fixture(); if (item.inner !== null) f.nest(item.inner);
  const message = await f.session.receiveServerMessage(100, Buffer.from(OUTER, "hex"));
  if (message === null) throw new Error("Nested-message fixture unexpectedly retired its connection");
  expect(f.initialized).toEqual([{ sequence: item.sequence, command: 6, client: item.client, checksum: item.checksum, config: item.config }]);
  expect(f.session.serverMessageSequence).toBe(item.sequence); expect(f.session.serverCommandSequence).toBe(item.command);
  const snapshot = f.session.snapshots.read(item.sequence);
  expect(snapshot?.serverTime).toBe(1000); expect(snapshot?.messageNumber).toBe(item.sequence);
  expect(snapshot?.parseEntitiesNumber).toBe(item.parsed); expect(snapshot?.entities[0]?.modelindex).toBe(item.model);
  expect(message.parseEntitiesNumber).toBe(item.parsed + 1); expect(f.lifecycle.clientStatic.phase).toBe("primed");
  expect(f.session.cvars.get("cl_paused")?.value).toBe("0");
});

for (const item of [
  { name: "truncated checksum", wire: "6c159956d93a0bccc28e0c35ed13000000f05f912a", client: 2 },
  { name: "truncated client number", wire: "6c159956d93a0bccc28e0c35ed13000000f05f01", client: -1 },
]) test(`source sentinel ${item.name} initializes before outer overread`, async () => {
  const f = await fixture();
  await expect(f.session.receiveServerMessage(100, Buffer.from(item.wire, "hex"))).rejects.toThrow("read past end");
  expect(f.initialized).toEqual([{ sequence: 100, command: 6, client: item.client, checksum: -1, config: "outer" }]);
  expect(f.lifecycle.clientStatic.phase).toBe("primed"); expect(f.session.clientNumber).toBe(item.client);
  expect(f.session.checksumFeed).toBe(-1); expect(f.session.cvars.get("cl_paused")?.value).toBe("0");
});

test("source malformed gamestate clears active state and preserves earlier complete fields", async () => {
  const cursor = new ServerMessageCursor(Buffer.from("6c159956d93a0bccc28e0c35ed13000000f0ff18", "hex"));
  const kinds: string[] = [];
  expect(() => {
    while (true) {
      const step = cursor.next(context); kinds.push(step.kind);
      if (step.kind === "end") break;
    }
  }).toThrow("Invalid gamestate opcode");
  expect(kinds).toEqual(["acknowledge", "gamestate-start", "gamestate-sequence", "gamestate-entry", "gamestate-entry"]);
  const f = await fixture();
  await expect(f.session.receiveServerMessage(100, Buffer.from("6c1509", "hex"))).rejects.toThrow("gamestate opcode");
  expect(f.session.serverCommandSequence).toBe(-1); expect(f.session.checksumFeed).toBe(888); expect(f.session.clientNumber).toBe(8);
  expect(f.session.snapshots.current()).toEqual({ number: 0, serverTime: 0 }); expect(f.initialized).toEqual([]);
  expect(f.session.takeEvents().slice(0, 2)).toEqual([{ kind: "close-console" }, { kind: "clear-active-state" }]);
});

for (const item of [
  { name: "after gamestate", wire: "6c159956d93a0bccc28e0c35ed13000000f05f91eaacfab802", command: 10, snapshot: 0 },
  { name: "after snapshot and command", wire: "6c159956d93a0bccc28e0c35ed13000000f05f91eaacfa27d9aaca34931113751698851dc1fb78f6d1231e864b3e06", command: 12, snapshot: 100 },
]) test(`malformed outer opcode ${item.name} cannot roll back prior source publication`, async () => {
  const f = await fixture();
  await expect(f.session.receiveServerMessage(100, Buffer.from(item.wire, "hex"))).rejects.toThrow("Invalid server opcode");
  expect(f.initialized).toHaveLength(1); expect(f.lifecycle.clientStatic.phase).toBe("primed");
  expect(f.session.serverCommandSequence).toBe(item.command); expect(f.session.snapshots.current().number).toBe(item.snapshot);
});

test("awaited gamestate work prevents later same-message publication; invalidated operation cannot resume", async () => {
  for (const cancel of [false, true]) {
    const f = await fixture(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const initialize = f.lifecycle.gamestateReceived.bind(f.lifecycle);
    f.lifecycle.gamestateReceived = async generation => { entered.resolve(); await gate.promise; f.lifecycle.assertCurrentOperation(); await initialize(generation); };
    const receiving = f.session.receiveServerMessage(100, Buffer.from(OUTER, "hex"));
    await entered.promise;
    expect(f.session.snapshots.current().number).toBe(0); expect(f.session.serverCommandSequence).toBe(10);
    if (cancel) f.lifecycle.close(); gate.resolve();
    if (cancel) {
      await expect(receiving).rejects.toThrow("no longer current"); expect(f.session.snapshots.current().number).toBe(0);
      expect(f.initialized).toEqual([]);
      expect(f.session.takeEvents().some(event => event.kind === "disconnect")).toBe(false);
    } else { await receiving; expect(f.session.snapshots.current().number).toBe(100); expect(f.initialized).toHaveLength(1); }
  }
});
