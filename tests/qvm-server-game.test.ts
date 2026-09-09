import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { CommonParseCursor, CommonParseState } from "../src/core/common-parse.ts";
import { waitForCall } from "../src/core/call-steps.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { vec3 } from "../src/core/math.ts";
import { Netchannel } from "../src/protocol/netchan.ts";
import { ServerBotAdapter } from "../src/server/bot-adapter.ts";
import { BotDebugPolygons } from "../src/server/bot-debug.ts";
import { ServerClientCommandRuntime } from "../src/server/client-commands.ts";
import { ServerClientLifecycleRuntime } from "../src/server/client-lifecycle.ts";
import { ServerDownloadRuntime } from "../src/server/downloads.ts";
import { ServerNetChannelRuntime } from "../src/server/net-channel.ts";
import { ServerSnapshotSendRuntime } from "../src/server/snapshot-send.ts";
import { ServerSnapshotRuntime } from "../src/server/snapshots.ts";
import { ServerClientPhase, ServerStaticState, ServerWorldState } from "../src/server/state.ts";
import type { ServerClient } from "../src/server/state.ts";
import { ServerWorld } from "../src/server/world.ts";
import { ServerEntityFlags } from "../src/shared/entity-shared.ts";
import { QvmGameData } from "../src/vm/game-data.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { qvmServerGameSyscall } from "../src/vm/server-game-syscalls.ts";
import type { QvmServerGameServices } from "../src/vm/server-game-syscalls.ts";
import { QVM_SHARED_ENTITY_BYTES } from "../src/vm/shared-entity-record.ts";

function args(...words: number[]): DataView {
  const view = new DataView(new ArrayBuffer(words.length * 4));
  for (const [index, word] of words.entries()) view.setInt32(index * 4, word, true);
  return view;
}
function unexpected(): never { throw new Error("Unexpected fixture host operation"); }

function setup() {
  const memory = new QvmMemory(new Uint8Array(4096));
  const data = new QvmGameData(memory, "baseq3");
  const staticState = new ServerStaticState({ product: "baseq3", maxClients: 2, dedicated: false });
  const prints: string[] = [], disconnects: number[] = [];
  const print = (text: string): undefined => { prints.push(text); };
  const cvars = new CvarRegistry();
  cvars.set("sv_maxclients", "2", true); cvars.set("dedicated", "0", true);
  const dropClient = (target: ServerClient, reason: string): CallSteps => lifecycle.dropClient(target, reason);
  const world = new ServerWorldState(staticState, { print, dropClient });
  const bounds = { min: vec3(-64, -64, -64), max: vec3(64, 64, 64) };
  const map: BspMap = {
    entities: '{ "classname" "worldspawn" }', entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null,
  };
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const spatial = new ServerWorld(collision, bounds, number => data.entity(number), { get loading() { return world.state === "loading"; }, print: print, developerPrint: text => { const developer = cvars.get("developer"); if (developer !== undefined && developer.integerValue !== 0) print(text); } });
  const clientCommands = new ServerClientCommandRuntime(world, staticState, {
    debugBuild: false, pure: false, clientRunning: false, floodProtect: false, print, debugPrint: print,
    tokenize: unexpected, dropClient, sendClientGameState: unexpected, userinfoChanged: unexpected,
    verifyPaks: unexpected, beginDownload: unexpected, nextDownload: unexpected, stopDownload: unexpected, doneDownload: unexpected,
  });
  const downloads = new ServerDownloadRuntime(staticState, { files: { openDownload: unexpected }, cvars, print,
    debugPrint: print, dropClient, sendClientGameState: unexpected });
  const channel = new ServerNetChannelRuntime(staticState, { sendPacket: unexpected, tracePacket: unexpected, debugPrint: unexpected,
    connectionless: unexpected, executeClientMessage: unexpected, print });
  const snapshots = new ServerSnapshotRuntime(world, staticState, { collision, spatial, debugPrint: print });
  const sender = new ServerSnapshotSendRuntime(snapshots, channel, { cvars, downloads, print, isLanAddress: unexpected });
  const lifecycle = new ServerClientLifecycleRuntime(world, staticState, { cvars, downloads, sender, print,
    debugPrint: print, sendPacket: unexpected, isLanAddress: unexpected });
  const bots = new ServerBotAdapter({ map, collision, spatial, world, statics: staticState, clientCommands }, cvars, print);
  const debugPolygons = new BotDebugPolygons();
  const parser = new CommonParseState(), cursor = new CommonParseCursor(map.entities);
  const services: QvmServerGameServices = { data, world, staticState, spatial, collision, lifecycle, cvars, bots, debugPolygons,
    entityToken() { const token = parser.parse(cursor); return { token, ended: cursor.offset === null }; } };
  const call = (...words: number[]) => qvmServerGameSyscall("game", args(...words), memory, services);
  world.game = { product: "baseq3", data, disposeResources: unexpected, calls: {
    clientConnect: unexpected, clientBegin: unexpected, clientUserinfoChanged: unexpected, clientCommand: unexpected,
    clientThink: unexpected, runFrame: unexpected, botFrame: unexpected, consoleCommand: unexpected, shutdown: unexpected,
    *clientDisconnect(number): CallSteps {
      yield* waitForCall(async () => { disconnects.push(number); return undefined; });
      memory.writeString(64, "changed by game", 20);
    },
  } };
  call(15, 256, 2, QVM_SHARED_ENTITY_BYTES, 2048, 468);
  const client = staticState.clients[0];
  if (client === undefined) throw new Error("Missing fixture client");
  return { memory, data, staticState, world, spatial, collision, lifecycle, cvars, bots, debugPolygons,
    parser, cursor, services, call, client, prints, disconnects };
}

describe("game server syscall ownership and source publication", () => {
  test("role dispatch and source header numbering leave unrelated traps alone", () => {
    const { memory, services, call } = setup();
    expect(qvmServerGameSyscall("cgame", args(), memory, services)).toBeNull();
    expect(qvmServerGameSyscall("ui", args(), memory, services)).toBeNull();
    for (const trap of [14, 38, 41, 42, 45, 200]) expect(call(trap)).toBeNull();
    expect(() => call(15, 256)).toThrow(RangeError);
    expect(call(16, -1, 0)).toBe(0);
    expect(call(17, 2, 0)).toBe(0);
  });

  test("locate borrows source strides and brush failure retains the first model-index write", () => {
    const { call, memory, data } = setup();
    const retained = data.entity(0);
    memory.writeString(64, "*99", 8);
    expect(() => call(23, 256, 64)).toThrow("CM_InlineModel: bad number");
    expect(retained.s.modelindex).toBe(99);
    expect(retained.r.model.kind).toBe("box");
    expect(retained.r.contents).toBe(0);
    call(15, 1024, 1, 600, 2048, 468);
    expect(data.entity(0)).not.toBe(retained);
    expect(data.entityFromPointer(256)).toBe(retained);
    memory.writeString(64, "*0", 8);
    call(23, 256, 64);
    expect(retained.r.mins).toEqual(vec3(-65, -65, -65));
    expect(retained.r.maxs).toEqual(vec3(65, 65, 65));
    expect(retained.r.model).toEqual({ kind: "inline", index: 0 });
    expect(retained.r.contents).toBe(-1);
  });

  test("configstrings and userinfo mutate the actual owners and preserve byte strings", () => {
    const { call, memory, world, client, cvars } = setup();
    memory.writeString(64, "\xffvalue", 16);
    expect(call(18, 3, 64)).toBe(0);
    expect(world.configstrings.get(3)).toBe("\xffvalue");
    memory.bytes.fill(0xa5, 100, 110);
    call(19, 3, 100, 4);
    expect([...memory.bytes.subarray(100, 105)]).toEqual([255, 118, 97, 0, 165]);
    call(18, 3, 0); expect(world.configstrings.get(3)).toBe("");
    memory.writeString(64, "\\name\\byte\xff", 24);
    call(21, 0, 64); expect(client.name).toBe("byte\xff");
    call(20, 0, 100, 24); expect(memory.readString(100)).toBe(client.userinfo);
    call(21, 0, 0); expect(client.userinfo).toBe("");
    cvars.register("hostname", "test", CvarFlag.ServerInfo);
    call(22, 100, 80); expect(memory.readString(100)).toBe("\\hostname\\test");
    expect(() => call(20, -1, 0, 0)).toThrow("bufferSize");
    expect(() => call(18, -1, 0)).toThrow("bad index");
    for (const trap of [18, 19]) {
      let failure: unknown;
      try { call(trap, -1, 0, 1); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "drop", message: `SV_${trap === 18 ? "Set" : "Get"}Configstring: bad index -1\n` });
    }
  });

  test("server commands and asynchronous drop run the actual reliable and client lifetimes", async () => {
    const { call, memory, client, disconnects } = setup();
    expect(call(34)).toBe(0);
    memory.writeString(64, "print hello", 20);
    expect(call(17, -1, 64)).toBe(0);
    expect(client.reliable.lookupMasked(1)).toBe("print hello");
    client.download.name = "pending";
    memory.writeString(64, "bye", 20);
    const pending = call(16, 0, 64);
    expect(pending).toBeInstanceOf(Promise);
    expect(client.download.name).toBe("");
    expect(client.phase).toBe(ServerClientPhase.Zombie);
    await pending;
    expect(disconnects).toEqual([0]);
    expect(client.phase).toBe(ServerClientPhase.Free);
    expect(client.reliable.lookupMasked(3)).toBe('disconnect "changed by game"');
  });

  test("drop dereferences its reason after download close and ignores it for zombies", () => {
    const { call, client } = setup();
    call(34);
    client.download.name = "pending";
    expect(() => call(16, 0, 0)).toThrow("nonnull pointer");
    expect(client.download.name).toBe("");
    expect(client.phase).toBe(ServerClientPhase.Active);
    if (client.connection.kind !== "initialized") throw new Error("Missing allocated connection");
    client.connection.phase = ServerClientPhase.Zombie;
    expect(call(16, 0, 0)).toBe(0);
  });

  test("bot allocation and free retain the canonical entity pointer after locate moves", () => {
    const { call, data, client } = setup();
    const original = data.entity(0);
    expect(call(34)).toBe(0); expect(client.gameEntity).toBe(original);
    original.r.svFlags = ServerEntityFlags.BOT;
    call(15, 1536, 1, 600, 2048, 468);
    call(35, 0);
    expect(original.r.svFlags & ServerEntityFlags.BOT).toBe(0);
    expect(client.gameEntity).toBe(original);
    expect(() => call(35, 2)).toThrow("bad clientNum");
  });

  test("bot allocation preserves remote IPv4 bytes through type-only changes and repeated bot reuse", () => {
    const { bots, client } = setup();
    expect(bots.allocateClient()).toBe(0);
    expect(client.retainedBotAddressIp).toEqual([0, 0, 0, 0]);
    bots.freeClient(0);
    const host: [number, number, number, number] = [198, 51, 100, 17];
    client.connection = { kind: "initialized", phase: ServerClientPhase.Free,
      address: { kind: "ipv4", host, port: 27961 }, netchan: new Netchannel("server", 891) };
    const channel = client.connection.netchan;
    expect(bots.allocateClient()).toBe(0); host[0] = 203;
    expect(client.connection.address).toEqual({ kind: "bot" });
    expect(client.connection.netchan).toBe(channel);
    expect(client.retainedBotAddressIp).toEqual([198, 51, 100, 17]);
    bots.freeClient(0); expect(bots.allocateClient()).toBe(0);
    expect(client.retainedBotAddressIp).toEqual([198, 51, 100, 17]);
  });

  test("last usercmd writes source integer angles and byte moves without a channel", () => {
    const { call, client, memory } = setup();
    client.lastUsercmd = { ...client.lastUsercmd, serverTime: 0x12345678,
      angles: vec3(-2147483648, 2147483647, -1), buttons: -1, forwardmove: -128, rightmove: 127, upmove: -3 };
    call(36, 0, 64);
    expect(memory.view(64, 24).getInt32(4, true)).toBe(-2147483648);
    expect([...memory.bytes.subarray(85, 88)]).toEqual([128, 127, 253]);
    expect(() => call(36, 2, 0)).toThrow("bad clientNum");
    expect(() => call(36, 0, 4090)).toThrow(RangeError);
  });

  test("entity parser consumes its token before a destination error", () => {
    const { call, memory, cursor } = setup();
    expect(() => call(37, 0, 8)).toThrow();
    expect(cursor.offset).not.toBe(0);
    expect(call(37, 64, 32)).toBe(1); expect(memory.readString(64)).toBe("classname");
    expect(call(37, 64, 32)).toBe(1); expect(memory.readString(64)).toBe("worldspawn");
    expect(call(37, 64, 32)).toBe(1); expect(memory.readString(64)).toBe("}");
    expect(call(37, 64, 32)).toBe(0); expect(memory.readString(64)).toBe("");
  });

  test("debug polygon allocation reads points only after the real owner publishes metadata", () => {
    const { call, debugPolygons, memory } = setup();
    expect(call(39, 7, 999, 0)).toBe(0);
    debugPolygons.initialize(2);
    expect(() => call(39, 7, 1, 4092)).toThrow(RangeError);
    const row = debugPolygons.rows[1];
    if (row === undefined) throw new Error("Missing polygon slot");
    expect(row.inuse).toBe(true); expect(row.numPoints).toBe(1); expect(row.color).toBe(7);
    call(40, 1);
    memory.view(64, 12).setFloat32(0, 2.5, true);
    expect(call(39, 4, 1, 64)).toBe(1);
    expect(row.points[0]?.x).toBe(2.5);
  });

  test("trace source record and spatial queries consume actual borrowed records", () => {
    const { call, memory, data } = setup();
    memory.view(64, 12).setFloat32(0, -10, true);
    memory.view(80, 12).setFloat32(0, 10, true);
    for (const trap of [24, 43]) {
      call(trap, 128, 64, 0, 0, 80, 1023, -1);
      expect(memory.view(128, 56).getFloat32(8, true)).toBe(1);
      expect(memory.view(128, 56).getInt32(52, true)).toBe(1023);
    }
    expect(call(26, 64, 80)).toBe(1); expect(call(27, 64, 80)).toBe(1);
    expect(call(29, 0, 0)).toBe(1);
    const entity = data.entity(0);
    entity.r.mins = vec3(-4, -4, -4); entity.r.maxs = vec3(4, 4, 4); entity.r.contents = 1;
    entity.r.ownerNum = 1023;
    call(30, 256); expect(entity.r.linked).toBe(true);
    memory.view(64, 12).setFloat32(0, -1, true);
    memory.view(80, 12).setFloat32(0, 1, true);
    expect(call(32, 64, 80, 128, 8)).toBe(1);
    expect(memory.view(128, 4).getInt32(0, true)).toBe(0);
    for (const trap of [33, 44]) expect(call(trap, 64, 80, 256)).toBe(1);
    const otherPointer = data.entityFromPointer(1536);
    otherPointer.s.number = 0;
    otherPointer.r.mins = vec3(-4, -4, -4); otherPointer.r.maxs = vec3(4, 4, 4);
    otherPointer.r.currentOrigin = vec3(100, 0, 0);
    for (const trap of [33, 44]) expect(call(trap, 64, 80, 1536)).toBe(0);
    expect(call(25, 64, 1023)).not.toBe(0);
    call(28, 256, 1);
    call(31, 256); expect(entity.r.linked).toBe(false);
    expect(call(32, 64, 80, 0, 8)).toBe(0);
  });

  test("area output retains reached writes and source signed capacities", () => {
    const { call, memory, data } = setup();
    for (const number of [0, 1]) {
      const entity = data.entity(number);
      entity.s.number = number;
      entity.r.mins = vec3(-2, -2, -2); entity.r.maxs = vec3(2, 2, 2);
      call(30, 256 + number * QVM_SHARED_ENTITY_BYTES);
    }
    expect(() => call(32, 64, 80, 4092, 2)).toThrow(RangeError);
    expect(memory.view(4092, 4).getInt32(0, true)).toBe(1);
    expect(call(32, 64, 80, 128, -1)).toBe(2);
    expect(call(32, 64, 80, 0, 0)).toBe(0);
  });
});
