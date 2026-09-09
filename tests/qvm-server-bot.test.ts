import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { waitForCall } from "../src/core/call-steps.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import { vec3 } from "../src/core/math.ts";
import { Netchannel } from "../src/protocol/netchan.ts";
import { ServerBotAdapter } from "../src/server/bot-adapter.ts";
import { ServerSnapshotEntities } from "../src/server/snapshot-entities.ts";
import { ServerClientCommandRuntime } from "../src/server/client-commands.ts";
import { ServerClientPhase, ServerStaticState, ServerWorldState } from "../src/server/state.ts";
import { ServerWorld } from "../src/server/world.ts";
import { Weapon } from "../src/shared/definitions.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { qvmServerBotSyscall } from "../src/vm/server-bot-syscalls.ts";
import type { QvmServerBotServices } from "../src/vm/server-bot-syscalls.ts";

function argumentsView(...words: number[]): DataView {
  const view = new DataView(new ArrayBuffer(words.length * 4));
  for (const [index, word] of words.entries()) view.setInt32(index * 4, word, true);
  return view;
}

function unexpected(): never { throw new Error("Unexpected server host operation"); }

function setup() {
  const statics = new ServerStaticState({ product: "baseq3", maxClients: 2, dedicated: false });
  const world = new ServerWorldState(statics, { print: unexpected, dropClient: unexpected });
  const cvars = new CvarRegistry();
  const bounds = { min: vec3(-16, -16, -16), max: vec3(16, 16, 16) };
  const map: BspMap = {
    entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null,
  };
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const spatial = new ServerWorld(collision, bounds, () => undefined, { get loading() { return world.state === "loading"; }, print: unexpected, developerPrint: () => { const developer = cvars.get("developer"); if (developer !== undefined && developer.integerValue !== 0) unexpected(); } });
  const clientCommands = new ServerClientCommandRuntime(world, statics, {
    debugBuild: false, pure: false, clientRunning: false, floodProtect: false,
    print: unexpected, debugPrint: unexpected, tokenize: unexpected, dropClient: unexpected, sendClientGameState: unexpected,
    userinfoChanged: unexpected, verifyPaks: unexpected, beginDownload: unexpected,
    nextDownload: unexpected, stopDownload: unexpected, doneDownload: unexpected,
  });
  const adapter = new ServerBotAdapter({ map, collision, spatial, world, statics, clientCommands }, cvars, unexpected);
  const memory = new QvmMemory(new Uint8Array(256).fill(0xa5));
  const client = statics.clients[0];
  if (client === undefined) throw new Error("Missing authored server client");
  const call = (...words: number[]) => qvmServerBotSyscall("game", argumentsView(...words), memory, adapter);
  return { statics, world, clientCommands, adapter, memory, client, call };
}

const commandBytes = Uint8Array.of(
  0x78, 0x56, 0x34, 0x12, 0xff, 0xff, 0xff, 0x7f,
  0, 0, 0, 0x80, 0xff, 0xff, 0xff, 0xff,
  1, 0, 0, 0x80, 13, 0x80, 0x7f, 0xfd,
);
const expectedCommand = {
  serverTime: 0x12345678, angles: { x: 0x7fffffff, y: -0x80000000, z: -1 },
  buttons: -2147483647, weapon: Weapon.WP_CHAINGUN, forwardmove: -128, rightmove: 127, upmove: -3,
};

describe("server bot VM traps over canonical server state", () => {
  test("unrelated traps and other roles do not read missing argument words", () => {
    const { adapter, memory, call } = setup();
    expect(qvmServerBotSyscall("ui", argumentsView(), memory, adapter)).toBeNull();
    expect(qvmServerBotSyscall("cgame", argumentsView(), memory, adapter)).toBeNull();
    for (const trap of [208, 212, -1]) expect(call(trap)).toBeNull();
    expect(() => call()).toThrow(RangeError);
    for (const trap of [209, 210, 211]) expect(() => call(trap, 0)).toThrow(RangeError);
  });

  test("never-connected allocated clients read their zeroed frame without creating a channel", () => {
    const { client, statics, call } = setup();
    expect(client.connection.kind).toBe("uninitialized");
    expect(client.phase).toBe(ServerClientPhase.Free);
    // Empty backing storage makes an accidental entity read fail explicitly.
    statics.snapshotEntities = new ServerSnapshotEntities(0, { kind: "unaccounted" });
    for (const sequence of [-2147483648, -1, 0, 1, 2147483647]) {
      expect(call(209, 0, sequence)).toBe(-1);
    }
    expect(client.connection.kind).toBe("uninitialized");
  });

  test("snapshot index uses the actual current channel frame and wrapped entity storage", () => {
    const { client, statics, call } = setup();
    client.connection = { kind: "initialized", phase: ServerClientPhase.Active, address: { kind: "bot" }, netchan: Netchannel.sourceZero() };
    const frame = client.frames[0];
    const last = statics.snapshotEntities.get(statics.numSnapshotEntities - 1), first = statics.snapshotEntities.get(0);
    if (frame === undefined) throw new Error("Missing source snapshot storage");
    frame.firstEntity = statics.numSnapshotEntities - 1;
    frame.numEntities = 2;
    last.number = 82;
    first.number = 17;
    statics.snapshotEntities.set(statics.numSnapshotEntities - 1, last);
    statics.snapshotEntities.set(0, first);
    expect(call(209, 0, -1)).toBe(-1);
    expect(call(209, 0, 2)).toBe(-1);
    expect(call(209, 0, 0)).toBe(82);
    expect(call(209, 0, 1)).toBe(17);
    last.number = 83;
    statics.snapshotEntities.set(statics.numSnapshotEntities - 1, last);
    expect(call(209, 0, 0)).toBe(83);
    frame.numEntities = 0;
    statics.snapshotEntities = new ServerSnapshotEntities(0, { kind: "unaccounted" });
    expect(call(209, 0, 0)).toBe(-1);
  });

  test("no pending message and a consumed empty slot do not resolve output or size", () => {
    const { client, statics, memory, call } = setup();
    statics.time = 123;
    expect(call(210, 0, 0, -1)).toBe(0);
    expect(client.lastPacketTime).toBe(123);
    expect(client.reliable.acknowledge).toBe(0);
    client.reliable.add("");
    client.reliable.add("next");
    statics.time = 456;
    expect(call(210, 0, 255, -1)).toBe(0);
    expect(client.lastPacketTime).toBe(456);
    expect(client.reliable.acknowledge).toBe(1);
    expect(memory.bytes).toEqual(new Uint8Array(256).fill(0xa5));
    expect(call(210, 0, 16, 8)).toBe(1);
    expect(memory.readString(16)).toBe("next");
    expect(client.reliable.acknowledge).toBe(2);
  });

  test("console text copies byte characters, truncates and pads only requested capacity", () => {
    const { client, memory, call } = setup();
    client.reliable.add("a\x80\xff");
    expect(call(210, 0, 16, 6)).toBe(1);
    expect(memory.bytes.subarray(15, 23)).toEqual(Uint8Array.of(0xa5, 97, 128, 255, 0, 0, 0, 0xa5));
    client.reliable.add("long");
    expect(call(210, 0, 24, 3)).toBe(1);
    expect(memory.readString(24)).toBe("lo");
    client.reliable.add("visible");
    expect(call(210, 0, 255, 1)).toBe(1);
    expect(memory.bytes[255]).toBe(0);
  });

  test("nonnull text consumes its slot before null, invalid-size or output-extent failure", () => {
    const { client, statics, memory, call } = setup();
    statics.time = 789;
    client.reliable.add("one");
    expect(() => call(210, 0, 0, -1)).toThrow("NULL dest");
    expect(client.reliable.acknowledge).toBe(1);
    expect(client.lastPacketTime).toBe(789);
    client.reliable.add("two");
    expect(() => call(210, 0, 16, 0)).toThrow("destsize < 1");
    expect(client.reliable.acknowledge).toBe(2);
    client.reliable.add("three");
    expect(() => call(210, 0, 253, 4)).toThrow("exceeds QVM allocation");
    expect(client.reliable.acknowledge).toBe(3);
    expect(memory.bytes).toEqual(new Uint8Array(256).fill(0xa5));
  });

  test("commands save the source 24-byte copy before the inactive-client gate", () => {
    const { client, memory, call } = setup();
    memory.bytes.set(commandBytes, 17);
    expect(client.phase).toBe(ServerClientPhase.Free);
    expect(call(211, 0, -239)).toBe(0);
    expect(client.lastUsercmd).toEqual(expectedCommand);
    memory.bytes.fill(0, 17, 41);
    expect(client.lastUsercmd).toEqual(expectedCommand);
    memory.bytes.set(commandBytes, 232);
    expect(call(211, 0, 232)).toBe(0);
    memory.bytes.set(commandBytes, 0);
    expect(call(211, 0, 256)).toBe(0);
    expect(client.lastUsercmd).toEqual(expectedCommand);
  });

  test("active command saves its copy before reaching the required game owner", () => {
    const { client, memory, call } = setup();
    client.connection = { kind: "initialized", phase: ServerClientPhase.Active, address: { kind: "bot" }, netchan: Netchannel.sourceZero() };
    memory.bytes.set(commandBytes, 16);
    expect(() => call(211, 0, 16)).toThrow("requires a current game runtime");
    expect(client.lastUsercmd).toEqual(expectedCommand);
  });

  test("missing client storage rejects before resolving null command or console pointers", () => {
    const { call } = setup();
    for (const client of [-1, 2]) {
      expect(() => call(211, client, 0)).toThrow("has no server storage");
      expect(() => call(210, client, 0, 0)).toThrow("has no server storage");
      expect(() => call(209, client, 0)).toThrow("has no server storage");
    }
  });

  test("command pointer bounds and raw weapon byte retention", () => {
    const { client, memory, call } = setup();
    const original = client.lastUsercmd;
    expect(() => call(211, 0, 0)).toThrow("nonnull");
    expect(() => call(211, 0, 233)).toThrow("exceeds allocation");
    expect(client.lastUsercmd).toBe(original);
    memory.bytes.set(commandBytes, 16);
    memory.bytes[36] = 255;
    expect(call(211, 0, 16)).toBe(0);
    expect(client.lastUsercmd.weapon).toBe(255);
    memory.bytes[36] = 0;
    expect(call(211, 0, 16)).toBe(0);
    expect(client.lastUsercmd.weapon).toBe(0);
  });

  test("deferred service command uses captured words and propagates async completion", async () => {
    const { adapter, client, memory } = setup();
    const words = argumentsView(211, 0, 16);
    memory.bytes.set(commandBytes, 16);
    const events: string[] = [];
    const services: QvmServerBotServices = {
      getSnapshotEntity: adapter.getSnapshotEntity.bind(adapter),
      getConsoleMessage: adapter.getConsoleMessage.bind(adapter),
      *userCommand(number, command): CallSteps {
        words.setInt32(4, 99, true);
        words.setInt32(8, 0, true);
        yield* adapter.userCommand(number, command);
        events.push("copied");
        yield* waitForCall(() => Promise.resolve());
        events.push("completed");
      },
    };
    const result = qvmServerBotSyscall("game", words, memory, services);
    expect(result).toBeInstanceOf(Promise);
    expect(events).toEqual(["copied"]);
    expect(client.lastUsercmd).toEqual(expectedCommand);
    expect(await result).toBe(0);
    expect(events).toEqual(["copied", "completed"]);
  });

  test("asynchronous command failure reaches the VM caller after the actual command copy", async () => {
    const { adapter, client, memory } = setup();
    memory.bytes.set(commandBytes, 16);
    const failure = new Error("game think rejected");
    const services: QvmServerBotServices = {
      getSnapshotEntity: adapter.getSnapshotEntity.bind(adapter),
      getConsoleMessage: adapter.getConsoleMessage.bind(adapter),
      *userCommand(number, command): CallSteps {
        yield* adapter.userCommand(number, command);
        yield* waitForCall(() => Promise.reject(failure));
      },
    };
    const result = qvmServerBotSyscall("game", argumentsView(211, 0, 16), memory, services);
    expect(client.lastUsercmd).toEqual(expectedCommand);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toBe(failure);
  });
});
