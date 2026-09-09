// qcommon/vm.c VM_Call and game/g_public.h gameExport_t. GPL-2.0-or-later.
import { expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { QvmOpcode, parseQvm } from "../src/assets/qvm.ts";
import { ReadFileMemory } from "../src/assets/read-file-memory.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { finishCalls } from "../src/core/call-steps.ts";
import { CommonError } from "../src/core/common-error.ts";
import { vec3 } from "../src/core/math.ts";
import { GameRuntime } from "../src/game/runtime.ts";
import { GameType } from "../src/shared/definitions.ts";
import { VmRegistry } from "../src/vm/registry.ts";
import { QvmInterpreter } from "../src/vm/interpreter.ts";
import { createGameVerificationHarness } from "../tools/game-verification-harness.ts";

function actualGameRuntime() {
  const bounds = { min: vec3(-1024, -1024, -1024), max: vec3(1024, 1024, 1024) };
  const map: BspMap = {
    entities: '{ "classname" "worldspawn" } { "classname" "info_player_deathmatch" "origin" "200 0 64" }',
    entityRecords: [], shaders: [], planes: [{ normal: vec3(1, 0, 0), distance: 0 }],
    nodes: [{ plane: 0, children: [-1, -2], bounds }],
    leaves: [0, 1].map(area => ({ cluster: area, area, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 })),
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null,
  };
  const fixture = createGameVerificationHarness({ product: "baseq3", map, gameType: GameType.GT_FFA,
    levelTime: 1000, randomSeed: 42, buildDate: "Sep  9 2026", clientNamePrefix: "Trace",
    botsReason: "Trace fixture has no bot clients" });
  fixture.runtime.shutdown(false);
  return fixture;
}

test("actual GAME entries print exact source IDs and ordinary helpers stay quiet", () => {
  const fixture = actualGameRuntime(), traces: string[] = [];
  const registry = new VmRegistry(text => { traces.push(text); });
  const registration = registry.reserve("qagame");
  registry.debug(1);
  const game = GameRuntime.create(fixture.runtime.options, fixture.owner, registration);
  try {
    expect(traces).toEqual(["VM_Call( 0 )\n"]);
    expect(finishCalls(game.calls.clientConnect(0, true, false))).toBeNull();
    finishCalls(game.calls.clientBegin(0));
    finishCalls(game.calls.clientUserinfoChanged(0));
    finishCalls(game.calls.clientCommand(0, ["score"]));
    finishCalls(game.calls.clientThink(0, fixture.engine.getUserCommand(0)));
    finishCalls(game.calls.runFrame(1050));
    expect(() => finishCalls(game.calls.botFrame(1050))).toThrow("Game bot services unavailable");
    finishCalls(game.calls.consoleCommand(["unknown"]));
    finishCalls(game.calls.clientDisconnect(0));
    game.runFrame(1100);
    finishCalls(game.calls.shutdown(false));
    expect(traces).toEqual([0, 2, 3, 4, 6, 7, 8, 10, 9, 5, 1].map(id => `VM_Call( ${id} )\n`));
  } finally { game.disposeResources(); }
});

test("actual GAME traces follow the registry's default and live debug gate", () => {
  const fixture = actualGameRuntime(), traces: string[] = [];
  const registry = new VmRegistry(text => { traces.push(text); });
  const game = GameRuntime.create(fixture.runtime.options, fixture.owner, registry.reserve("qagame"));
  try {
    finishCalls(game.calls.runFrame(1050));
    expect(traces).toEqual([]);
    registry.debug(-1);
    finishCalls(game.calls.runFrame(1100));
    registry.debug(0);
    finishCalls(game.calls.shutdown(false));
    expect(traces).toEqual(["VM_Call( 8 )\n"]);
  } finally { game.disposeResources(); }
});

test("GAME_INIT trace aborts before game construction and publication", () => {
  const fixture = actualGameRuntime(), failure = new CommonError("drop", "init trace");
  const printsBefore = fixture.prints.length;
  const registry = new VmRegistry(text => {
    expect(text).toBe("VM_Call( 0 )\n");
    expect(fixture.owner.game).toBeNull();
    throw failure;
  });
  const registration = registry.reserve("qagame");
  registry.debug(1);
  expect(() => GameRuntime.create(fixture.runtime.options, fixture.owner, registration)).toThrow(failure);
  expect(fixture.owner.game).toBeNull();
  expect(GameRuntime.registered(registration)).toBeNull();
  expect(fixture.prints).toHaveLength(printsBefore);
  expect(registration.binding.kind).toBe("typescript");
});

test("GAME frame print abort prevents simulation and synchronous print reentry completes first", () => {
  const fixture = actualGameRuntime(), failure = new CommonError("drop", "frame trace");
  let abort = false;
  const frames: number[] = [];
  const registry = new VmRegistry(text => {
    if (text !== "VM_Call( 8 )\n") return;
    const current = fixture.owner.game;
    if (!(current instanceof GameRuntime)) throw new Error("Missing current game");
    frames.push(current.level.time);
    if (abort) throw failure;
    registry.debug(0);
    finishCalls(current.calls.runFrame(1025));
    frames.push(current.level.time);
  });
  const game = GameRuntime.create(fixture.runtime.options, fixture.owner, registry.reserve("qagame"));
  try {
    registry.debug(1);
    abort = true;
    expect(() => finishCalls(game.calls.runFrame(1050))).toThrow(failure);
    expect(game.level.time).toBe(1000);
    expect(game.level.frameNum).toBe(0);
    abort = false;
    finishCalls(game.calls.runFrame(1050));
    expect(frames).toEqual([1000, 1000, 1025]);
    expect(game.level.previousTime).toBe(1025);
    expect(game.level.time).toBe(1050);
    expect(game.level.frameNum).toBe(2);
  } finally { game.shutdown(false); }
});

test("GAME call marking precedes printing and preserves a nested print callback's VM selection", () => {
  const fixture = actualGameRuntime(), observations: string[][] = [];
  const registry = new VmRegistry(() => {
    const profile: string[] = [];
    registry.printProfile(text => { profile.push(text); });
    observations.push(profile);
    nested.called();
  });
  const writer = new BinaryWriter(53);
  for (const word of [0x12721444, 3, 32, 18, 50, 0, 0, 129]) writer.i32(word);
  writer.u8(QvmOpcode.OP_ENTER); writer.i32(0);
  writer.u8(QvmOpcode.OP_CONST); writer.i32(19);
  writer.u8(QvmOpcode.OP_LEAVE); writer.i32(0);
  writer.u8(0); writer.u8(0); writer.u8(0);
  const nested = registry.reserve("ui");
  const interpreter = new QvmInterpreter(parseQvm(writer.finish(), "authored-trace.qvm"), () => 0,
    { kind: "unaccounted" }, nested);
  const memory = new ReadFileMemory(), symbols = new TextEncoder().encode("0 0 nestedMain\n");
  interpreter.loadSymbols({ name: "ui", developer: 1, print: () => undefined,
    files: {
      readFileRetainedSync: () => memory.read(symbols.length, bytes => { bytes.set(symbols); }),
      freeFile: bytes => { memory.freeFile(bytes); },
    } });
  nested.called();
  registry.debug(1);
  const registration = registry.reserve("qagame");
  let game = GameRuntime.create(fixture.runtime.options, fixture.owner, registration);
  try {
    const profile = (): string => {
      let text = "";
      registry.printProfile(part => { text += part; });
      return text;
    };
    expect(profile()).toContain("nestedMain");
    finishCalls(game.calls.runFrame(1050));
    expect(profile()).toContain("nestedMain");
    game = GameRuntime.reinitialize({ ...game.options, restart: true, levelTime: 1100 }, fixture.owner, registration);
    expect(game.level.time).toBe(1100);
    expect(GameRuntime.registered(registration)).toBe(game);
    expect(registration.binding.kind).toBe("typescript");
    expect(profile()).toContain("nestedMain");
    expect(observations).toEqual([[], [], []]);
  } finally { registry.debug(0); game.shutdown(false); nested.free(); }
});
