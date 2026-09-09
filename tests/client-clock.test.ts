import { describe, expect, test } from "bun:test";
import { CvarRegistry } from "../src/core/cvar.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { DemoReader, encodeDemo } from "../src/protocol/demo.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { Gamestate, ServerMessageContext, ServerOperation } from "../src/protocol/server-message.ts";
import type { Product } from "../src/shared/definitions.ts";
import { PlayerState } from "../src/shared/player-state.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";

const products: readonly Product[] = ["baseq3", "missionpack"];
function gamestate(product: Product): Gamestate {
  return { kind: "gamestate", commandSequence: 0, clientNumber: 0, checksumFeed: 0,
    entries: [{ kind: "configstring", index: 1, value: `\\sv_serverid\\1\\sv_cheats\\1\\fs_game\\${product === "missionpack" ? "missionpack" : ""}` }] };
}
function context(product: Product, number: number): ServerMessageContext {
  return { product, messageNumber: number, reliableSequence: 0, serverCommandSequence: 0,
    parseEntitiesNumber: 0, baseline: () => null, history: () => null };
}
function snapshot(product: Product, number: number, time: number, flags = 0): Extract<ServerOperation, { kind: "snapshot" }> {
  return { kind: "snapshot", validity: { kind: "valid" }, snapshot: { messageNumber: number, serverTime: time,
    deltaNumber: -1, flags, serverCommandNumber: 0, parseEntitiesNumber: 0, areaMask: new Uint8Array(),
    playerState: new PlayerState(product), entities: [] } };
}
function fixture(product: Product) {
  const cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
  const session = new EngineClientSession({ product, cvars, lifecycle, mode: { kind: "network", challenge: 1, qport: 1 } });
  const state = lifecycle.clientStatic;
  cvars.set("cl_showTimeDelta", "1", true);
  async function send(operations: readonly ServerOperation[]): Promise<void> {
    const number = session.serverMessageSequence + 1;
    await session.receiveServerMessage(number, encodeServerMessage(0, operations, context(product, number)));
  }
  async function receive(time: number, flags = 0): Promise<void> {
    await send([snapshot(product, session.serverMessageSequence + 1, time, flags)]);
  }
  async function start(time = 1000, real = 1000): Promise<void> {
    await send([gamestate(product)]); session.prime(session.gamestateGeneration);
    state.realtime = real; await receive(time); await session.setCGameTime(); session.takeEvents();
  }
  function diagnostics(): string {
    return session.takeEvents().flatMap(event => event.kind === "diagnostic" ? [event.text] : []).join("");
  }
  return { session, cvars, lifecycle, state, send, receive, start, diagnostics };
}

for (const product of products) describe(`${product} source engine client clock`, () => {
  test("first eligible snapshot activates once and appends activeAction without executing it", async () => {
    const f = fixture(product);
    f.cvars.set("activeAction", "echo ready;", true);
    await f.send([gamestate(product)]); f.session.prime(1); f.state.realtime = 100;
    await f.receive(1000, 2); await f.session.setCGameTime();
    expect(f.state.phase).toBe("primed"); expect(f.session.serverTime).toBe(0);
    expect(f.cvars.get("activeAction")?.value).toBe("echo ready;");
    await f.receive(1050); await f.session.setCGameTime();
    expect(f.state.phase).toBe("active"); expect(f.session.serverTime).toBe(1050);
    expect(f.cvars.get("activeAction")?.value).toBe("");
    expect(f.session.takeEvents().filter(event => event.kind === "append-console-command")).toEqual([{ kind: "append-console-command", text: "echo ready;" }]);
    await f.session.setCGameTime(); expect(f.session.takeEvents()).toEqual([]);
  });

  for (const distance of [-501, -500, -101, -100, 100, 101, 500, 501]) {
    test(`strict source reset/fast boundaries: ${distance}ms`, async () => {
      const f = fixture(product); await f.start();
      f.state.realtime = 2000; await f.receive(2000 + distance); await f.session.setCGameTime();
      const magnitude = Math.abs(distance);
      expect(f.session.serverTime).toBe(magnitude > 500 ? 2000 + distance : 2000);
      expect(f.diagnostics()).toBe(magnitude > 500 ? `<RESET> ${distance} ` : magnitude > 100 ? `<FAST> ${distance >> 1} ` : "-2 ");
      f.state.realtime = 2001; await f.session.setCGameTime();
      expect(f.session.serverTime).toBe(magnitude > 500 ? 2001 + distance : Math.max(2000, 2001 + (magnitude > 100 ? distance >> 1 : -2)));
    });
  }

  test("local server does not replace actual RESET_TIME500 with unused resetTime100", async () => {
    const f = fixture(product); await f.start(); f.cvars.set("sv_running", "1", true);
    f.state.realtime = 2000; await f.receive(2400); await f.session.setCGameTime();
    expect(f.diagnostics()).toBe("<FAST> 200 "); expect(f.session.serverTime).toBe(2000);
  });

  test("only the triple local pause suppresses time and preserves pending arrival", async () => {
    const f = fixture(product); await f.start();
    f.cvars.set("cl_paused", "1", true); f.cvars.set("sv_paused", "1", true);
    f.state.realtime = 1050; await f.session.setCGameTime(); expect(f.session.serverTime).toBe(1050);
    f.cvars.set("sv_running", "1", true); f.state.realtime = 2000; await f.receive(2600);
    await f.session.setCGameTime(); expect(f.session.serverTime).toBe(1050); expect(f.diagnostics()).toBe("");
    f.cvars.set("cl_paused", "0", true); await f.session.setCGameTime();
    expect(f.session.serverTime).toBe(2600); expect(f.diagnostics()).toBe("<RESET> 600 ");
  });

  test("nudge is locally clamped, old time is monotonic, extrapolation ignores nudge", async () => {
    const f = fixture(product); await f.start();
    f.cvars.set("cl_timeNudge", "-99", true); await f.session.setCGameTime(); expect(f.session.serverTime).toBe(1030);
    expect(f.cvars.get("cl_timeNudge")?.value).toBe("-99");
    f.cvars.set("cl_timeNudge", "99", true); await f.session.setCGameTime(); expect(f.session.serverTime).toBe(1030);
    f.state.realtime = 1100; await f.receive(1200); await f.session.setCGameTime();
    expect(f.session.serverTime).toBe(1070); expect(f.diagnostics()).toBe("-2 ");
  });

  test("timescale other than zero/one preserves sticky extrapolation until an eligible arrival", async () => {
    const f = fixture(product); await f.start(); f.cvars.set("timescale", ".5", true);
    f.state.realtime = 1100; await f.receive(1150); await f.session.setCGameTime(); expect(f.diagnostics()).toBe("0 ");
    f.cvars.set("timescale", "0", true); f.state.realtime = 1110; await f.receive(1200); await f.session.setCGameTime();
    expect(f.diagnostics()).toBe("-2 ");
    f.cvars.set("timescale", "1", true); f.state.realtime = 1120; await f.receive(1210); await f.session.setCGameTime();
    expect(f.diagnostics()).toBe("-1 ");
  });

  test("valid arrivals coalesce, invalid arrivals do not supply a clock, and timestamp regressions drop", async () => {
    const f = fixture(product); await f.start(); f.state.realtime = 1100;
    await f.receive(1150); await f.receive(1190); await f.session.setCGameTime();
    expect(f.diagnostics()).toBe("-2 ");
    const number = f.session.serverMessageSequence + 1, old = snapshot(product, 1, 1000).snapshot;
    const invalid = snapshot(product, number, 1500);
    await f.session.receiveServerMessage(number, encodeServerMessage(0, [{ ...invalid, snapshot: { ...invalid.snapshot, deltaNumber: 1 } }],
      { ...context(product, number), history: () => ({ status: "valid", snapshot: old }) }));
    expect(f.lifecycle.debugMessages.at(-1)).toBe("Delta from invalid frame (not supposed to happen!).\n");
    f.state.realtime = 1110; await f.session.setCGameTime(); expect(f.diagnostics()).toBe("");
    await f.receive(1189); await expect(f.session.setCGameTime()).rejects.toThrow("oldFrameServerTime");
  });

  test("gamestate resets active clocks; cgame re-prime and map_restart do not", async () => {
    const f = fixture(product); await f.start(); f.state.realtime = 1100; await f.session.setCGameTime();
    f.state.phase = "loading"; f.session.prime(1); await f.session.setCGameTime(); expect(f.session.serverTime).toBe(1100);
    await f.send([{ kind: "command", sequence: 1, text: "map_restart" }]); f.session.getServerCommand(1);
    expect(f.session.serverTime).toBe(1100);
    f.lifecycle.clientConnection.lastPacketTime = 999;
    await f.send([gamestate(product)]); expect(f.session.serverTime).toBe(0); expect(f.state.realtime).toBe(1100);
    expect(f.lifecycle.clientConnection.lastPacketTime).toBe(999);
  });

  test("command creation consumes the previous render clock before this frame selects time", async () => {
    const f = fixture(product); await f.send([gamestate(product)]); f.session.prime(1);
    const create = () => f.session.createUserCommand({ serverTime: f.session.serverTime, viewAngles: { x: 0, y: 0, z: 0 },
      buttons: 0, forwardmove: 0, rightmove: 0, upmove: 0 });
    f.state.realtime = 1000; await f.receive(1000); expect(create()).toBe(1);
    await f.session.setCGameTime(); expect(f.session.commands.read(1)?.serverTime).toBe(0);
    f.state.realtime = 1100; expect(create()).toBe(2); await f.session.setCGameTime();
    expect(f.session.commands.read(2)?.serverTime).toBe(1000); expect(f.session.serverTime).toBe(1100);
  });

  test("undefined native arithmetic rejects at consumption after preceding source activation", async () => {
    const f = fixture(product); await f.send([gamestate(product)]); f.session.prime(1);
    f.state.realtime = -2147483648; await f.receive(1);
    await expect(f.session.setCGameTime()).rejects.toThrow("Undefined native client clock arithmetic");
    expect(f.state.phase).toBe("active"); expect(f.session.serverTime).toBe(0);
  });
});

test("real demo messages: initial sequence zero, first-frame skip, 50ms timedemo override despite freeze, EOF", async () => {
  const product: Product = "baseq3", cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
  const records = [
    { kind: "message", sequence: 0, payload: encodeServerMessage(0, [gamestate(product)], context(product, 0)) },
    { kind: "message", sequence: 1, payload: encodeServerMessage(0, [snapshot(product, 1, 1000)], context(product, 1)) },
    { kind: "message", sequence: 2, payload: encodeServerMessage(0, [{ kind: "command", sequence: 1, text: "print demo" }], context(product, 2)) },
    { kind: "message", sequence: 3, payload: encodeServerMessage(0, [snapshot(product, 3, 1100)], context(product, 3)) },
    { kind: "message", sequence: 4, payload: encodeServerMessage(0, [snapshot(product, 4, 1200)], context(product, 4)) },
  ] satisfies Parameters<typeof encodeDemo>[0];
  const reader = new DemoReader(encodeDemo(records), "encoded real protocol demo fixture");
  const session = new EngineClientSession({ product, cvars, lifecycle, mode: { kind: "demo", reader } });
  const loadPacketTimes: number[] = [];
  lifecycle.gamestateReceived = async generation => {
    lifecycle.gamestates.push(generation); loadPacketTimes.push(lifecycle.clientConnection.lastPacketTime); session.prime(generation);
  };
  cvars.set("timedemo", "1", true); cvars.set("cl_freezeDemo", "1", true);
  lifecycle.clientStatic.realtime = 4000;
  await session.readInitialDemoMessages(); expect(session.serverMessageSequence).toBe(0); expect(loadPacketTimes).toEqual([4000]);
  await session.setCGameTime(); expect(session.serverMessageSequence).toBe(0); expect(session.serverTime).toBe(0);
  await session.setCGameTime(); expect(session.serverTime).toBe(1050); expect(session.serverMessageSequence).toBe(3);
  await session.setCGameTime(); expect(session.serverTime).toBe(1100); expect(session.serverMessageSequence).toBe(4);
  await session.setCGameTime(); expect(session.serverTime).toBe(1150);
  lifecycle.clientStatic.realtime = 4200; await session.setCGameTime();
  expect(session.serverTime).toBe(1200); expect(lifecycle.clientStatic.phase).toBe("disconnected");
  expect(lifecycle.completions).toEqual([{ end: { kind: "end", reason: "terminator", offset: encodeDemo(records).length - 8 },
    timing: { frames: 4, elapsedMilliseconds: 200 } }]);
});

test("first frozen ordinary demo retains source zero serverTime; initial message is a real reader requirement", async () => {
  const product: Product = "missionpack", cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
  const records = [
    { kind: "message", sequence: 0, payload: encodeServerMessage(0, [gamestate(product)], context(product, 0)) },
    { kind: "message", sequence: 1, payload: encodeServerMessage(0, [snapshot(product, 1, 1000)], context(product, 1)) },
    { kind: "message", sequence: 2, payload: encodeServerMessage(0, [snapshot(product, 2, 1100)], context(product, 2)) },
  ] satisfies Parameters<typeof encodeDemo>[0];
  const session = new EngineClientSession({ product, cvars, lifecycle, mode: { kind: "demo", reader: new DemoReader(encodeDemo(records)) } });
  lifecycle.gamestateReceived = async generation => { session.prime(generation); };
  cvars.set("cl_freezeDemo", "1", true); lifecycle.clientStatic.realtime = 4000;
  await session.readInitialDemoMessages(); await session.setCGameTime(); await session.setCGameTime();
  expect(lifecycle.clientStatic.phase).toBe("active"); expect(session.serverTime).toBe(0); expect(session.serverMessageSequence).toBe(1);
  cvars.set("cl_freezeDemo", "0", true); await session.setCGameTime();
  expect(session.serverTime).toBe(1000); expect(session.serverMessageSequence).toBe(2);
});
