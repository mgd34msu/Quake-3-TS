import { createProtocolClientSession, ProtocolClientLifecycle, transmitProtocolClient } from "../tools/client-protocol-fixture.ts";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { QvmOpcode as Op } from "../src/assets/qvm.ts";
import { compareClientPaks } from "../src/assets/client-download.ts";
import type { BotLogStream } from "../src/botlib/log.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import type { CallCommandHandler } from "../src/core/commands.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { infoValueForKey } from "../src/core/info-string.ts";
import { vec3 } from "../src/core/math.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { ClientDownloads } from "../src/engine/client-download.ts";
import { ServerEngine } from "../src/engine/server-engine.ts";
import { QvmGame } from "../src/engine/qvm-game.ts";
import type { ServerEngineOptions } from "../src/engine/server-engine.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { acquireGameModule } from "../src/engine/client-modules.ts";
import { CommonError } from "../src/core/common-error.ts";
import { ConnectionState } from "../src/game/state.ts";
import { GameRuntime } from "../src/game/runtime.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { LanAddresses } from "../src/platform/lan.ts";
import { UdpTransport } from "../src/platform/network.ts";
import type { Ipv4Address } from "../src/platform/network.ts";
import { decodeConnectionless, encodeConnect, encodeConnectionlessText } from "../src/protocol/connectionless.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { ServerClientPhase } from "../src/server/state.ts";
import type { ServerClient } from "../src/server/state.ts";
import { Weapon } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import type { VmRegistration } from "../src/vm/registry.ts";
import { sourceZip } from "./pk3-source-fixture.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/.local/share/Steam/steamapps/common/Quake 3 Arena";
const resources: { readonly server: ServerEngine; readonly homePath: string }[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    try { if (resource.server.state.kind !== "disposed") await resource.server.shutdown({ kind: "normal", reason: "test cleanup" }); }
    finally { resource.server.options.common.close(); rmSync(resource.homePath, { recursive: true }); }
  }
});

async function fixture(product: Product = "baseq3", humanOnly = true,
  configure: (options: ServerEngineOptions) => ServerEngineOptions = options => options,
  onPrint?: (text: string) => undefined) {
  const homePath = mkdtempSync(join(tmpdir(), "q3-server-engine-"));
  const loopback = new LoopbackTransport(), prints: string[] = [], random = new LinuxNativeRandom(1);
  let owner: ServerEngine | null = null;
  const serverHandler: CallCommandHandler = function* (context): CallSteps { if (owner !== null) yield* owner.gameConsoleCommand(context); };
  const adopted: CommonConsole[] = [];
  let common: CommonConsole;
  try { common = await CommonConsole.open({ roots: { product, dataPath, homePath, cdPath: null }, random,
    startup: new StartupCommands(""), build: { kind: "dedicated" }, platformPrint: text => { onPrint?.(text); prints.push(text); },
    resolveCommand: () => ({ kind: "calls", handler: serverHandler }),
    assertCommandEntry: () => { owner?.assertCommandEntry(); }, assertOwnerEntry: () => { void owner?.options.common.roots; } },
    value => { adopted.push(value); return undefined; }); }
  catch (error) { for (const value of adopted) value.close(); rmSync(homePath, { recursive: true }); throw error; }
  const cvars = common.cvars;
  cvars.register("showpackets", "0", CvarFlag.Temporary);
  cvars.register("showdrop", "0", CvarFlag.Temporary);
  cvars.set("sv_pure", "0", true); cvars.set("sv_maxclients", "2", true);
  cvars.set("dedicated", "1", true);
  if (humanOnly) cvars.set("bot_enable", "0", true);
  const clock = { comFrameTime: 1000, wallTime: 2000, milliseconds(): number { return ++this.wallTime; } };
  const options = configure({ common, clock,
    buildDate: "source-host-test", random,
    network: { loopback, udp: null, lan: new LanAddresses([[127, 0, 0, 1]]),
      resolveAddress: async () => { throw new Error("Private loopback server must not request external DNS"); },
      sleep: async milliseconds => { await Bun.sleep(milliseconds); } },
    bots: { kind: "unavailable", reason: "Game bot AI composition is not yet available" },
    clientLifecycle: { kind: "absent" } });
  try {
    common.commands.append("exec default.cfg\nexec q3config.cfg\nexec autoexec.cfg\n");
    await common.commands.executeAsync();
    common.registerRuntimeCvars(options.buildDate, async () => undefined);
    common.initVm();
    const server = ServerEngine.create(options); owner = server;
    cvars.clearModified("dedicated"); cvars.set("r_uiFullScreen", "1", true); cvars.set("ui_singlePlayerActive", "0", true);
    common.markInitialized();
    resources.push({ server, homePath });
    return { server, homePath, cvars, loopback, prints, clock, options };
  } catch (error) { common.close(); rmSync(homePath, { recursive: true }); throw error; }
}

function running(server: ServerEngine) {
  const state = server.state;
  if (state.kind !== "running") throw new Error("Expected running host");
  const game = state.world.game;
  if (!(game instanceof GameRuntime)) throw new Error("Running host has no direct TypeScript game");
  return { ...state, game };
}
async function execute(server: ServerEngine, text: string): Promise<void> {
  server.commands.append(`${text}\n`); await server.commands.executeAsync();
}

/** One entity records real GAME exports; console argv[1] optionally executes a nested command. */
function authoredServerGame(initCommand = ""): Uint8Array {
  const operations: (readonly [Op, number?])[] = [[Op.OP_ENTER, 64]];
  const trap = (number: number, args: readonly number[]): void => {
    args.forEach((value, index) => operations.push([Op.OP_CONST, value], [Op.OP_ARG, 8 + index * 4]));
    operations.push([Op.OP_CONST, -1 - number], [Op.OP_CALL], [Op.OP_POP]);
  };
  const afterInit = operations.length + 3;
  operations.push([Op.OP_LOCAL, 72], [Op.OP_LOAD4], [Op.OP_CONST, 0], [Op.OP_NE, 0]);
  trap(15, [64, 1, 516, 2048, 468]);
  if (initCommand.length !== 0) trap(14, [0, 1728]);
  trap(37, [1024, 128]);
  operations.push([Op.OP_CONST, 244], [Op.OP_CONST, 1024], [Op.OP_LOAD1], [Op.OP_STORE4],
    [Op.OP_CONST, 148], [Op.OP_LOCAL, 76], [Op.OP_LOAD4], [Op.OP_STORE4],
    [Op.OP_CONST, 248], [Op.OP_LOCAL, 84], [Op.OP_LOAD4], [Op.OP_STORE4]);
  trap(0, [1536]);
  operations.push([Op.OP_CONST, 0], [Op.OP_LEAVE, 64]);
  operations[afterInit] = [Op.OP_NE, operations.length];
  const afterFrame = operations.length + 3;
  operations.push([Op.OP_LOCAL, 72], [Op.OP_LOAD4], [Op.OP_CONST, 8], [Op.OP_NE, 0],
    [Op.OP_CONST, 152], [Op.OP_CONST, 152], [Op.OP_LOAD4], [Op.OP_CONST, 1], [Op.OP_ADD], [Op.OP_STORE4],
    [Op.OP_CONST, 204], [Op.OP_LOCAL, 76], [Op.OP_LOAD4], [Op.OP_STORE4]);
  const notRestarting = operations.length + 3;
  operations.push([Op.OP_CONST, 248], [Op.OP_LOAD4], [Op.OP_CONST, 1], [Op.OP_NE, 0]);
  const notFourthFrame = operations.length + 3;
  operations.push([Op.OP_CONST, 152], [Op.OP_LOAD4], [Op.OP_CONST, 4], [Op.OP_NE, 0]);
  trap(14, [0, 1664]);
  operations[notRestarting] = [Op.OP_NE, operations.length];
  operations[notFourthFrame] = [Op.OP_NE, operations.length];
  operations.push([Op.OP_CONST, 0], [Op.OP_LEAVE, 64]);
  operations[afterFrame] = [Op.OP_NE, operations.length];
  const afterConsole = operations.length + 3;
  operations.push([Op.OP_LOCAL, 72], [Op.OP_LOAD4], [Op.OP_CONST, 9], [Op.OP_NE, 0],
    [Op.OP_CONST, 236], [Op.OP_CONST, 236], [Op.OP_LOAD4], [Op.OP_CONST, 1], [Op.OP_ADD], [Op.OP_STORE4]);
  trap(9, [0, 1024, 128]);
  const afterMutation = operations.length + 3;
  operations.push([Op.OP_CONST, 1024], [Op.OP_LOAD1], [Op.OP_CONST, 95], [Op.OP_NE, 0],
    [Op.OP_CONST, 268], [Op.OP_CONST, 999], [Op.OP_STORE4]);
  operations[afterMutation] = [Op.OP_NE, operations.length];
  trap(9, [1, 1024, 128]);
  const afterNested = operations.length + 3;
  operations.push([Op.OP_CONST, 1024], [Op.OP_LOAD1], [Op.OP_CONST, 0], [Op.OP_EQ, 0]);
  trap(14, [0, 1024]);
  operations[afterNested] = [Op.OP_EQ, operations.length];
  trap(9, [0, 1024, 128]);
  operations.push([Op.OP_CONST, 224], [Op.OP_CONST, 1024], [Op.OP_LOAD1], [Op.OP_STORE4],
    [Op.OP_CONST, 1], [Op.OP_LEAVE, 64]);
  operations[afterConsole] = [Op.OP_NE, operations.length];
  const afterShutdown = operations.length + 3;
  operations.push([Op.OP_LOCAL, 72], [Op.OP_LOAD4], [Op.OP_CONST, 1], [Op.OP_NE, 0],
    [Op.OP_CONST, 260], [Op.OP_CONST, 260], [Op.OP_LOAD4], [Op.OP_CONST, 1], [Op.OP_ADD], [Op.OP_STORE4],
    [Op.OP_CONST, 264], [Op.OP_LOCAL, 76], [Op.OP_LOAD4], [Op.OP_STORE4]);
  trap(0, [1600]);
  operations[afterShutdown] = [Op.OP_NE, operations.length];
  operations.push([Op.OP_CONST, 0], [Op.OP_LEAVE, 64]);
  const code = new BinaryWriter(operations.length * 5);
  for (const [opcode, operand] of operations) {
    code.u8(opcode);
    if (operand !== undefined) {
      if (opcode === Op.OP_ARG) code.u8(operand);
      else code.i32(operand);
    }
  }
  const initialized = new Uint8Array(2048);
  new DataView(initialized.buffer).setInt32(268, 29, true);
  initialized.set(new TextEncoder().encode("authored GAME init\n\0"), 1536);
  initialized.set(new TextEncoder().encode("authored GAME shutdown\n\0"), 1600);
  initialized.set(new TextEncoder().encode("restart_probe\0"), 1664);
  initialized.set(new TextEncoder().encode(`${initCommand}\0`), 1728);
  const bytes = code.finish(), image = new BinaryWriter(32 + bytes.length + initialized.length);
  for (const word of [0x12721444, operations.length, 32, bytes.length, 32 + bytes.length, initialized.length, 0, 6144]) image.i32(word);
  image.bytes(bytes); image.bytes(initialized);
  return image.finish();
}

test("server operator commands retain source registration order", async () => {
  const f = await fixture();
  const sourceOrder = ["heartbeat", "kick", "banUser", "banClient", "clientkick", "status", "serverinfo", "systeminfo",
    "dumpuser", "map_restart", "sectorlist", "map", "devmap", "spmap", "spdevmap", "killserver", "say"];
  expect(f.server.commands.registeredNames().filter(name => sourceOrder.includes(name))).toEqual([...sourceOrder].reverse());
});

test("VM_Create frees a source-invalid header before the source fatal error", async () => {
  const f = await fixture(), bytes = authoredServerGame();
  new DataView(bytes.buffer).setInt32(0, 0, true);
  mkdirSync(join(f.homePath, "baseq3"), { recursive: true });
  writeFileSync(join(f.homePath, "baseq3/zz-authored-game.pk3"), sourceZip([
    { name: new TextEncoder().encode("vm/qagame.qvm"), data: bytes, method: 0, utf8: false },
  ]));
  await f.options.common.files.restart({ checksumFeed: 0, random: () => 0 }, () => undefined);
  const registry = f.options.common.vm, registration = registry.reserve("qagame");
  expect(() => acquireGameModule({ files: f.server.files, product: "baseq3", registry,
    print: text => { f.options.common.output.print(text); }, hunk: { kind: "source-hunk", accounting: f.options.common.hunk.accounting } }))
    .toThrow(new CommonError("fatal", "vm/qagame.qvm has bad header"));
  expect(registration.binding.kind).toBe("freed");
});

for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  test(`${product}: server VM registry retains retail registration on fast restart and frees it on shutdown`, async () => {
    const f = await fixture(product);
    await execute(f.server, `map ${product === "baseq3" ? "q3dm1" : "mpteam1"}`);
    const before = running(f.server), registration = f.options.common.vm.reserve("qagame");
    expect(registration.binding.kind).toBe("typescript"); expect(GameRuntime.registered(registration)).toBe(before.game);
    const read = spyOn(f.server.files, "readFileRetainedSync"), freed = spyOn(registration, "free");
    try {
      const module = acquireGameModule({ product, files: f.server.files, registry: f.options.common.vm,
        print: text => { f.options.common.output.print(text); }, hunk: { kind: "source-hunk", accounting: f.options.common.hunk.accounting } });
      if (module === null) throw new Error("Expected the registered retail GAME module");
      expect(module.mode).toBe("registered"); expect(module.registration).toBe(registration); expect(read).not.toHaveBeenCalled();
      f.clock.comFrameTime++;
      await execute(f.server, "map_restart 0");
      const replacement = running(f.server).game;
      expect(replacement).not.toBe(before.game); expect(GameRuntime.registered(registration)).toBe(replacement);
      expect(f.options.common.vm.reserve("qagame")).toBe(registration);
      expect(read.mock.calls.some(([path]) => path === "vm/qagame.qvm")).toBe(false);
      before.game.disposeResources();
      expect(GameRuntime.registered(registration)).toBe(replacement); expect(freed).not.toHaveBeenCalled();
      const infoStart = f.prints.length;
      await execute(f.server, "vminfo");
      expect(f.prints.slice(infoStart)).toEqual(["Registered virtual machines:\n", "qagame : ", "TypeScript replacement\n"]);
      await execute(f.server, "killserver");
      expect(registration.binding.kind).toBe("freed"); expect(freed).toHaveBeenCalledTimes(1);
      expect(GameRuntime.registered(registration)).toBeNull();
      await f.server.disposeResources(); expect(freed).toHaveBeenCalledTimes(1);
    } finally { read.mockRestore(); freed.mockRestore(); }
  });
}

test("server VM registry loads authored GAME symbols and retains them with the interpreter on fast restart", async () => {
  const f = await fixture();
  mkdirSync(join(f.homePath, "baseq3"), { recursive: true });
  writeFileSync(join(f.homePath, "baseq3/zz-authored-game.pk3"), sourceZip([
    { name: new TextEncoder().encode("vm/qagame.qvm"), data: authoredServerGame(), method: 0, utf8: false },
    { name: new TextEncoder().encode("vm/qagame.map"), data: new TextEncoder().encode("0 0 authored_game_entry\n"), method: 0, utf8: false },
  ]));
  f.cvars.set("developer", "1", true);
  await execute(f.server, "map q3dm1");
  const state = f.server.state, registration = f.options.common.vm.reserve("qagame");
  const binding = registration.binding;
  if (state.kind !== "running" || !(state.world.game instanceof QvmGame) || binding.kind !== "interpreted") {
    throw new Error("Expected the registered external GAME interpreter");
  }
  const game = state.world.game, interpreter = binding.interpreter;
  expect(QvmGame.registered(registration)).toBe(game);
  expect(interpreter.symbols.entries.map(symbol => symbol.name)).toEqual(["authored_game_entry"]);
  const symbolPrint = f.prints.indexOf("1 symbols parsed from vm/qagame.map\n");
  expect(symbolPrint).toBeGreaterThan(-1); expect(symbolPrint).toBeLessThan(f.prints.indexOf("authored GAME init\n"));
  const loadedPrint = f.prints.findIndex(text => /^qagame loaded in \d+ bytes on the hunk\n$/.test(text));
  expect(f.prints.indexOf("Loading vm file vm/qagame.qvm.\n")).toBeLessThan(symbolPrint);
  expect(loadedPrint).toBeGreaterThan(symbolPrint); expect(loadedPrint).toBeLessThan(f.prints.indexOf("authored GAME init\n"));
  const read = spyOn(f.server.files, "readFileRetainedSync"), freed = spyOn(registration, "free");
  try {
    const module = acquireGameModule({ product: "baseq3", files: f.server.files, registry: f.options.common.vm,
      print: text => { f.options.common.output.print(text); }, hunk: { kind: "source-hunk", accounting: f.options.common.hunk.accounting } });
    expect(module?.mode).toBe("registered");
    expect(read).not.toHaveBeenCalled();
    f.clock.comFrameTime++;
    const restartPrint = f.prints.length;
    await execute(f.server, "map_restart 0");
    const shutdownPrint = f.prints.indexOf("authored GAME shutdown\n", restartPrint);
    expect(shutdownPrint).toBeGreaterThanOrEqual(restartPrint);
    expect(f.prints.slice(shutdownPrint, shutdownPrint + 4)).toEqual([
      "authored GAME shutdown\n", "VM_Restart()\n", "Loading vm file vm/qagame.qvm.\n", "authored GAME init\n",
    ]);
    expect(f.prints.slice(restartPrint).some(text => text.startsWith("qagame loaded in "))).toBe(false);
    expect(state.world.game).toBe(game); expect(QvmGame.registered(registration)).toBe(game);
    expect(registration.binding).toEqual({ kind: "interpreted", interpreter });
    expect(read.mock.calls.filter(([path]) => path === "vm/qagame.qvm")).toHaveLength(1);
    expect(read.mock.calls.some(([path]) => path === "vm/qagame.map")).toBe(false); expect(freed).not.toHaveBeenCalled();
    const start = f.prints.length;
    await execute(f.server, "vmprofile");
    expect(f.prints.slice(start).some(text => text.includes("authored_game_entry"))).toBe(true);
    await execute(f.server, "killserver");
    expect(registration.binding.kind).toBe("freed"); expect(freed).toHaveBeenCalledTimes(1);
    const afterShutdown = f.prints.length;
    await execute(f.server, "vmprofile"); expect(f.prints).toHaveLength(afterShutdown);
  } finally { read.mockRestore(); freed.mockRestore(); }
});

for (const sourceAbort of [false, true]) {
  test(`server VM registry ${sourceAbort ? "retains source-aborted" : "frees ordinary failed"} retail GAME initialization`, async () => {
    let armed = false;
    const observed: { registration: VmRegistration | null } = { registration: null };
    const failure = sourceAbort ? new CommonError("drop", "registry INIT source abort") : new Error("registry INIT ordinary failure");
    const f = await fixture("baseq3", true, options => options, text => {
      if (armed && text === "------- Game Initialization -------\n") {
        observed.registration = f.options.common.vm.reserve("qagame");
        throw failure;
      }
    });
    armed = true;
    try {
      await expect(execute(f.server, "map q3dm1")).rejects.toBe(failure);
      const registration = observed.registration;
      if (registration === null) throw new Error("Expected INIT to observe the published VM registration");
      expect(registration.binding.kind).toBe(sourceAbort ? "typescript" : "freed");
      expect(f.server.state.kind).toBe(sourceAbort ? "initializing" : "stopped");
      expect(GameRuntime.registered(registration) !== null).toBe(sourceAbort);
      await f.server.disposeResources();
      expect(registration.binding.kind).toBe("freed"); expect(GameRuntime.registered(registration)).toBeNull();
    } finally { armed = false; }
  });
}

test("authored GAME INIT operator status observes the running server on load and fast restart", async () => {
  let server: ServerEngine | null = null;
  const runningAtInit: boolean[] = [];
  const f = await fixture("baseq3", true, options => options, text => {
    if (text === "authored GAME init\n") {
      if (server === null) throw new Error("Missing initialized server owner");
      runningAtInit.push(server.running);
    }
  });
  server = f.server;
  const map = renderBspFixture([{ shader: "test/first", lightmap: -1 }, { shader: "test/second", lightmap: -1 }], []);
  mkdirSync(join(f.homePath, "baseq3"), { recursive: true });
  writeFileSync(join(f.homePath, "baseq3/zz-authored-game.pk3"), sourceZip([
    { name: new TextEncoder().encode("maps/operator-init.bsp"), data: map, method: 0, utf8: false },
    { name: new TextEncoder().encode("vm/qagame.qvm"), data: authoredServerGame("status"), method: 0, utf8: false },
  ]));
  await f.options.common.files.restart({ checksumFeed: 0, random: () => 0 }, () => undefined);
  const before = f.prints.length;
  await execute(f.server, "map operator-init");
  f.clock.comFrameTime++;
  await execute(f.server, "map_restart 0");
  const printed = f.prints.slice(before);
  expect(runningAtInit).toEqual([true, true]);
  expect(printed.filter(text => text === "map: operator-init\n")).toHaveLength(2);
  expect(printed.filter(text => text === "num score ping name            lastmsg address               qport rate\n")).toHaveLength(2);
  expect(printed).not.toContain("Server is not running.\n");
});

test("authored external GAME uses actual map, frame, console reentry and nested shutdown owners", async () => {
  const f = await fixture();
  mkdirSync(join(f.homePath, "baseq3"), { recursive: true });
  writeFileSync(join(f.homePath, "baseq3/zz-authored-game.pk3"), sourceZip([
    { name: new TextEncoder().encode("vm/qagame.qvm"), data: authoredServerGame(), method: 0, utf8: false },
  ]));
  await execute(f.server, "map q3dm1");
  const state = f.server.state;
  if (state.kind !== "running" || !(state.world.game instanceof QvmGame)) throw new Error("Expected the actual external GAME owner");
  const game = state.world.game, entity = game.data.entity(0);
  expect(game.data.numEntities).toBe(1);
  expect(entity.s.generic1).toBe(29); expect(entity.s.event).toBe(123); expect(entity.s.eventParm).toBe(0);
  expect(entity.s.time).toBe(state.statics.time - 400); expect(entity.s.time2).toBe(4);
  expect(f.cvars.get("sv_referencedPakNames")?.value.split(" ")).toContain("baseq3/zz-authored-game");
  await f.server.frame(50);
  expect(entity.s.time2).toBe(5);
  await execute(f.server, "authored_probe");
  expect(entity.s.frame).toBe(1); expect(entity.s.modelindex).toBe(97);
  await execute(f.server, 'authored_probe "nested_probe"');
  expect(entity.s.frame).toBe(3); expect(entity.s.modelindex).toBe(110);
  expect(f.server.commands.tokenizedArguments).toEqual(["nested_probe"]);
  await execute(f.server, 'authored_probe "killserver"');
  expect(f.server.state.kind).toBe("stopped"); expect(state.world.game).toBeNull();
  expect(entity.s.frame).toBe(4); expect(entity.s.legsAnim).toBe(1); expect(entity.s.torsoAnim).toBe(0);
  expect(f.prints.filter(text => text === "authored GAME shutdown\n")).toHaveLength(1);
});

test("authored external GAME fast restart retains allocation and resets data, parser and client pointers before INIT", async () => {
  let restarting = false, resetObserved = false;
  const retained: { client: ServerClient | null } = { client: null };
  const f = await fixture("baseq3", true, options => options, text => {
    if (restarting && text === "authored GAME init\n") {
      if (retained.client === null) throw new Error("Missing retained server client");
      expect(retained.client.gameEntity).toBeNull(); resetObserved = true;
    }
  });
  mkdirSync(join(f.homePath, "baseq3"), { recursive: true });
  writeFileSync(join(f.homePath, "baseq3/zz-authored-game.pk3"), sourceZip([
    { name: new TextEncoder().encode("vm/qagame.qvm"), data: authoredServerGame(), method: 0, utf8: false },
  ]));
  await execute(f.server, "map q3dm1");
  const state = f.server.state;
  if (state.kind !== "running" || !(state.world.game instanceof QvmGame)) throw new Error("Expected the actual external GAME owner");
  const game = state.world.game, data = game.data, entity = data.entity(0), client = state.statics.clients[0];
  if (client === undefined) throw new Error("Missing actual server client slot");
  await execute(f.server, "_mutate_generic1");
  expect(entity.s.generic1).toBe(999);
  entity.r.linkcount = 77; client.gameEntity = entity; retained.client = client;
  f.clock.comFrameTime++; restarting = true;
  await execute(f.server, "map_restart 0");
  expect(resetObserved).toBe(true); expect(state.world.game).toBe(game); expect(game.data).toBe(data);
  expect(data.entity(0)).toBe(entity); expect(entity.s.generic1).toBe(29); expect(entity.r.linkcount).toBe(0);
  expect(entity.s.event).toBe(123); expect(entity.s.eventParm).toBe(1); expect(entity.s.time2).toBe(4);
  expect(entity.s.frame).toBe(1); expect(entity.s.modelindex).toBe(114);
  expect(f.server.commands.tokenizedArguments).toEqual(["restart_probe"]);
  expect(entity.s.legsAnim).toBe(0); expect(f.prints.filter(text => text === "authored GAME shutdown\n")).toHaveLength(1);
  await f.server.frame(50); expect(entity.s.time2).toBe(5);
  restarting = false;
  await execute(f.server, "killserver");
  expect(state.world.game).toBeNull(); expect(entity.s.legsAnim).toBe(1);
  expect(f.prints.filter(text => text === "authored GAME shutdown\n")).toHaveLength(2);
});

for (const badHeader of [false, true]) {
  test(`authored GAME restart ${badHeader ? "frees a bad header before the source fatal error" : "reloads data without decoding replacement code"}`, async () => {
    const f = await fixture();
    const path = join(f.homePath, "baseq3/zz-authored-game.pk3"), bytes = authoredServerGame();
    const save = (): void => { writeFileSync(path, sourceZip([
      { name: new TextEncoder().encode("vm/qagame.qvm"), data: bytes, method: 0, utf8: false },
    ])); };
    mkdirSync(join(f.homePath, "baseq3"), { recursive: true }); save();
    await execute(f.server, "map q3dm1");
    const registration = f.options.common.vm.reserve("qagame"), binding = registration.binding;
    if (binding.kind !== "interpreted") throw new Error("Expected authored GAME interpreter");
    const header = new DataView(bytes.buffer), interpreter = binding.interpreter;
    if (badHeader) header.setInt32(0, 0, true);
    else {
      bytes[32] = 255;
      header.setInt32(4, 0, true);
      header.setInt32(8, -123, true);
      header.setInt32(header.getInt32(16, true) + 268, 71, true);
    }
    save(); f.clock.comFrameTime++;
    try {
      if (badHeader) {
        await expect(execute(f.server, "map_restart 0")).rejects.toEqual(new CommonError("fatal", "vm/qagame.qvm has bad header"));
        expect(registration.binding.kind).toBe("freed");
      } else {
        await execute(f.server, "map_restart 0");
        expect(registration.binding).toEqual({ kind: "interpreted", interpreter });
        expect(new DataView(interpreter.memory.buffer, interpreter.memory.byteOffset).getInt32(268, true)).toBe(71);
        expect(f.prints.filter(text => text === "authored GAME init\n")).toHaveLength(2);
      }
    } finally { await f.server.disposeResources(); }
  });
}

test("authored external GAME schedules the default restart delay without registering game warmup", async () => {
  const f = await fixture();
  mkdirSync(join(f.homePath, "baseq3"), { recursive: true });
  writeFileSync(join(f.homePath, "baseq3/zz-authored-game.pk3"), sourceZip([
    { name: new TextEncoder().encode("vm/qagame.qvm"), data: authoredServerGame(), method: 0, utf8: false },
  ]));
  await execute(f.server, "map q3dm1");
  const state = f.server.state;
  if (state.kind !== "running" || !(state.world.game instanceof QvmGame)) throw new Error("Expected the actual external GAME owner");
  expect(f.cvars.get("g_doWarmup")).toBeUndefined();
  f.clock.comFrameTime++;
  await execute(f.server, "map_restart");
  expect(state.world.restartTime).toBe(state.statics.time + 5000);
  expect(state.world.configstrings.get(5)).toBe(String(state.world.restartTime));
  expect(f.cvars.get("g_doWarmup")).toBeUndefined();
  expect(state.world.game.data.entity(0).s.eventParm).toBe(0);
});

async function sectorCounts(f: Awaited<ReturnType<typeof fixture>>): Promise<readonly number[]> {
  const start = f.prints.length;
  await execute(f.server, "sectorlist ignored arguments");
  const lines = f.prints.slice(start);
  expect(lines).toHaveLength(64);
  return lines.map((line, slot) => {
    const match = /^sector (\d+): (\d+) entities\n$/.exec(line);
    if (match === null || match[1] !== String(slot) || match[2] === undefined) throw new Error("Invalid source sector output");
    return Number(match[2]);
  });
}
async function pumpServer(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  for (let packet = f.loopback.poll("server"); packet !== null; packet = f.loopback.poll("server")) {
    await f.server.packetEvent(packet.from, packet.payload);
  }
}
async function pumpClient(f: Awaited<ReturnType<typeof fixture>>, client: EngineClientSession): Promise<void> {
  for (let packet = f.loopback.poll("client"); packet !== null; packet = f.loopback.poll("client")) (await client.receiveDatagram(packet.payload));
}
async function send(f: Awaited<ReturnType<typeof fixture>>, client: EngineClientSession): Promise<void> {
  for (const packet of transmitProtocolClient(client, f.clock.wallTime, 0, true)) f.loopback.send("client", packet);
  await pumpServer(f);
}
async function receiveGamestate(f: Awaited<ReturnType<typeof fixture>>, client: EngineClientSession, oldGeneration: number): Promise<void> {
  for (let count = 0; count < 32 && client.gamestateGeneration === oldGeneration; count++) {
    (await pumpClient(f, client));
    if (client.gamestateGeneration === oldGeneration) await f.server.frame(50);
  }
  expect(client.gamestateGeneration).toBe(oldGeneration + 1);
}
async function connect(f: Awaited<ReturnType<typeof fixture>>): Promise<EngineClientSession> {
  const challenge = 17, qport = 123;
  f.loopback.send("client", encodeConnect(`\\protocol\\68\\qport\\${qport}\\challenge\\${challenge}\\name\\HostPeer\\rate\\25000\\snaps\\20\\model\\sarge/default`));
  await pumpServer(f);
  const response = f.loopback.poll("client");
  if (response === null) throw new Error("Missing real connectResponse");
  expect(decodeConnectionless(response.payload, "client").command).toBe("connectResponse");
  const client = createProtocolClientSession({ product: f.options.common.roots.product, mode: { kind: "network", challenge, qport }, cvars: new CvarRegistry() });
  await send(f, client); await receiveGamestate(f, client, 0);
  const serverClient = running(f.server).statics.clients[0];
  expect(serverClient?.phase).toBe(ServerClientPhase.Primed);
  // This peer exercises the protocol prime boundary, not cgame initialization or presentation.
  client.prime(client.gamestateGeneration); client.setUserCmdValue(Weapon.WP_MACHINEGUN, 1);
  expect(client.createUserCommand({ serverTime: running(f.server).statics.time, viewAngles: vec3(0, 0, 0), buttons: 0,
    forwardmove: 0, rightmove: 0, upmove: 0 })).not.toBeNull();
  await send(f, client); expect(serverClient?.phase).toBe(ServerClientPhase.Active);
  await f.server.frame(50); (await pumpClient(f, client));
  expect(client.snapshots.current().number).toBeGreaterThan(0);
  return client;
}

test("server pure verification reads current mounts after client-side filesystem restarts", async () => {
  const f = await fixture();
  await execute(f.server, "map q3dm1");
  const client = await connect(f), state = running(f.server), files = f.options.common.files;
  const serverClient = state.statics.clients[0];
  if (serverClient === undefined) throw new Error("Missing connected server client");
  f.cvars.set("sv_pure", "1", true);
  const original = files.current;
  await files.restart({ checksumFeed: 0, random: () => 0 }, () => undefined);
  await files.restart({ checksumFeed: state.world.checksumFeed, random: () => 0 }, () => undefined);
  expect(() => original.pakPureChecksum("vm/cgame.qvm")).toThrow("Filesystem view is retired");
  expect(running(f.server).world).toBe(state.world);
  const cgame = files.current.pakPureChecksum("vm/cgame.qvm"), ui = files.current.pakPureChecksum("vm/ui.qvm");
  if (cgame === undefined || ui === undefined) throw new Error("Missing retail client packages");
  const command = `cp ${state.world.serverId} ${cgame | 0} ${ui | 0} @ ${state.world.checksumFeed}`;
  client.addReliableCommand("vdr"); client.addReliableCommand(command);
  await send(f, client);
  expect(serverClient.gotCP).toBe(true); expect(serverClient.pureAuthentic).toBe(true);
  expect(serverClient.phase).toBe(ServerClientPhase.Active);
  client.addReliableCommand("vdr"); client.addReliableCommand(`cp ${state.world.serverId} 0 0 @ 0`);
  await send(f, client);
  expect(serverClient.pureAuthentic).toBe(false); expect(serverClient.phase).toBe(ServerClientPhase.Zombie);
});

test("real server download installs an authored map package and receives the post-restart gamestate", async () => {
  const openEvents: string[] = [];
  const f = await fixture("baseq3", true, options => options, text => {
    if (text.startsWith("FS_SV_FOpenFileRead")) openEvents.push(text);
  });
  const mapBytes = renderBspFixture([{ shader: "test/first", lightmap: -1 }, { shader: "test/second", lightmap: -1 }], []);
  const payload = new TextEncoder().encode("locally authored download payload\n".repeat(800));
  const packageBytes = sourceZip([
    { name: new TextEncoder().encode("maps/download.bsp"), data: mapBytes, method: 0, utf8: false },
    { name: new TextEncoder().encode("scripts/download.txt"), data: payload, method: 0, utf8: false },
  ]);
  mkdirSync(join(f.homePath, "baseq3"), { recursive: true });
  writeFileSync(join(f.homePath, "baseq3/download.pk3"), packageBytes);
  await f.options.common.files.restart({ checksumFeed: 0, random: () => 0 }, () => undefined);
  f.cvars.set("sv_allowDownload", "1", true);
  await execute(f.server, "map download");
  expect(f.cvars.get("sv_referencedPakNames")?.value.split(" ")).toContain("baseq3/download");

  const clientHome = mkdtempSync(join(tmpdir(), "q3-server-download-client-"));
  let common: CommonConsole | null = null;
  let downloads: ClientDownloads | null = null;
  let lifecycle: ProtocolClientLifecycle | null = null;
  const clearSoundBuffer = f.options.common.sound.clearSoundBuffer.bind(f.options.common.sound);
  try {
    common = await CommonConsole.open({ roots: { product: "baseq3", dataPath, homePath: clientHome, cdPath: null },
      random: new LinuxNativeRandom(1), startup: new StartupCommands(""), build: { kind: "dedicated" },
      platformPrint: () => undefined, resolveCommand: () => undefined,
      assertCommandEntry: () => undefined, assertOwnerEntry: () => undefined }, value => { common = value; return undefined; });
    const { files, cvars } = common;
    cvars.register("cl_allowDownload", "1");
    const clientLifecycle = new ProtocolClientLifecycle(cvars); lifecycle = clientLifecycle;
    const connection = clientLifecycle.clientConnection, challenge = 17, qport = 123;
    const client = new EngineClientSession({ product: "baseq3", cvars, lifecycle: clientLifecycle,
      mode: { kind: "network", challenge, qport } });
    const delivery = { send: (bytes: Uint8Array): undefined => { f.loopback.send("client", bytes); },
      print: (): undefined => undefined, trace: (): undefined => undefined };
    let completedGamestate = 0, restarts = 0;
    const owner = new ClientDownloads({ files, cvars, connection, clientStatic: clientLifecycle.clientStatic,
      assertCurrentOperation: () => clientLifecycle.assertCurrentOperation(), print: () => undefined,
      addReliableCommand: text => { client.addReliableCommand(text); }, writePacket: () => { client.transmit(delivery); },
      downloadsComplete: async () => {
        if (owner.consumeRestart()) {
          await files.restart({ checksumFeed: client.checksumFeed, random: () => 0 }, () => clientLifecycle.assertCurrentOperation());
          restarts++; client.addReliableCommand("donedl");
        } else {
          // This test ends at the real gamestate handoff before graphical cgame initialization.
          completedGamestate = client.gamestateGeneration;
        }
      } });
    downloads = owner; connection.downloads = owner;
    clientLifecycle.applyServerPackages = async info => {
      await files.setServerLoadedPaks(infoValueForKey(info, "sv_paks"), infoValueForKey(info, "sv_pakNames"), () => clientLifecycle.assertCurrentOperation());
      files.setServerReferencedPaks(infoValueForKey(info, "sv_referencedPaks"), infoValueForKey(info, "sv_referencedPakNames"));
    };
    clientLifecycle.downloadSizeReceived = fileSize => owner.publishSize(fileSize);
    clientLifecycle.downloadReceived = block => owner.receive(block);
    clientLifecycle.gamestateReceived = async () => {
      await files.conditionalRestart(client.checksumFeed, () => clientLifecycle.assertCurrentOperation());
      await owner.initialize();
    };
    f.loopback.send("client", encodeConnect(`\\protocol\\68\\qport\\${qport}\\challenge\\${challenge}\\name\\DownloadPeer\\rate\\25000\\snaps\\20`));
    await pumpServer(f);
    const response = f.loopback.poll("client");
    if (response === null) throw new Error("Missing download peer admission response");
    expect(decodeConnectionless(response.payload, "client").command).toBe("connectResponse");
    await send(f, client); await receiveGamestate(f, client, 0);
    expect(connection.downloadTempName).toBe("baseq3/download.pk3.tmp");
    expect(completedGamestate).toBe(0);
    expect(f.options.common.sound.mixer).toBeNull();
    f.options.common.sound.clearSoundBuffer = () => { openEvents.push("clear"); clearSoundBuffer(); };
    f.cvars.set("fs_debug", "1", true);
    await send(f, client); await f.server.frame(50);
    expect(openEvents).toEqual(["clear", `FS_SV_FOpenFileRead (fs_homepath): ${f.homePath}/baseq3/download.pk3\n`]);
    const openPaths: string[] = [];
    f.server.files.printSearchPath(text => { openPaths.push(text); });
    expect(openPaths.some(text => /^handle \d+: baseq3\/download\.pk3\n$/.test(text))).toBe(true);
    await pumpClient(f, client);
    for (let frame = 0; frame < 256 && completedGamestate === 0; frame++) {
      f.clock.wallTime += 50;
      await send(f, client); await f.server.frame(50); await pumpClient(f, client);
    }
    expect(completedGamestate).toBe(2); expect(restarts).toBe(1);
    expect(owner.receivedBytes).toBe(packageBytes.byteLength);
    expect(owner.blockNumber).toBe(Math.ceil(packageBytes.byteLength / 2048) + 1);
    expect(readFileSync(join(clientHome, "baseq3/download.pk3"))).toEqual(Buffer.from(packageBytes));
    expect(files.current.readSync("maps/download.bsp")).toEqual(mapBytes);
    expect(files.current.readSync("scripts/download.txt")).toEqual(payload);
    expect(compareClientPaks(files, true)).toBe("");
    expect(connection.downloadTempName).toBe("");
    const serverClient = running(f.server).statics.clients[0];
    expect(serverClient?.lastClientCommandString).toBe("donedl");
    expect(serverClient?.download.file).toBeNull(); expect(serverClient?.download.name).toBe("");
    expect(f.prints).toContain('clientDownload: 0 : file "baseq3/download.pk3" completed\n');
  } finally {
    f.options.common.sound.clearSoundBuffer = clearSoundBuffer;
    try { downloads?.disposeResources(); }
    finally { try { common?.close(); } finally { lifecycle?.close(); rmSync(clientHome, { recursive: true }); } }
  }
});

for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  test(`${product}: real server false UDP enqueue returns through channel trace and source commit`, async () => {
    const udp = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    const originalSend = udp.send.bind(udp);
    let restoreAddress: (() => undefined) | null = null;
    try {
      const f = await fixture(product, true, options => ({ ...options, network: { ...options.network, udp } }));
      await execute(f.server, `map ${product === "missionpack" ? "mpteam1" : "q3dm1"}`);
      await connect(f);
      const client = running(f.server).statics.clients[0];
      if (client === undefined || client.connection.kind !== "initialized") throw new Error("Missing real admitted channel");
      const connection = client.connection, before = connection.netchan.outgoingSequence, calls: number[] = [];
      connection.address = udp.address; restoreAddress = () => { connection.address = { kind: "loopback" }; };
      f.cvars.set("developer", "1", true); f.cvars.set("showpackets", "1", true);
      const printStart = f.prints.length;
      udp.send = (to, packet) => { expect(to).toEqual(udp.address); calls.push(packet.length); return false; };
      await f.server.frame(50);
      expect(calls.length).toBeGreaterThan(0); expect(connection.netchan.outgoingSequence).toBe(before + 1);
      expect(connection.netchan.hasUnsentFragments).toBe(false);
      const lines = f.prints.slice(printStart).filter(text => text.startsWith("Sys_SendPacket:") || text.startsWith("server send "));
      expect(lines.length).toBe(calls.length * 2);
      for (let index = 0; index < calls.length; index++) {
        expect(lines[index * 2]).toBe("Sys_SendPacket: UDP socket could not queue packet\n");
        expect(lines[index * 2 + 1]).toMatch(/^server send /);
      }
    } finally { restoreAddress?.(); udp.send = originalSend; udp.close(); }
  });

  test(`${product}: real channel delivery samples showpackets after actual loopback send`, async () => {
    const f = await fixture(product);
    await execute(f.server, `map ${product === "missionpack" ? "mpteam1" : "q3dm1"}`);
    const originalSend = f.loopback.send.bind(f.loopback), observed: { readonly remaining: number; readonly sequence: number; readonly lineCount: number }[] = [];
    let enabled = true;
    f.loopback.send = (from, packet) => {
      originalSend(from, packet);
      if (from !== "server" || packet.length < 4 || new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(0, true) === 0xffffffff) return;
      const client = running(f.server).statics.clients[0];
      if (client === undefined || client.connection.kind !== "initialized") throw new Error("Missing actual server channel");
      observed.push({ remaining: client.connection.netchan.remainingUnsentBytes, sequence: client.connection.netchan.outgoingSequence,
        lineCount: f.prints.filter(text => text.startsWith("server send ")).length });
      f.cvars.set("showpackets", enabled ? "1" : "0", true);
    };
    const client = await connect(f);
    const lines = f.prints.filter(text => text.startsWith("server send "));
    expect(lines.length).toBe(observed.length); expect(lines.length).toBeGreaterThan(1);
    for (const [index, observation] of observed.entries()) {
      const line = lines[index]; if (line === undefined) throw new Error("Missing actual channel diagnostic");
      expect(observation.lineCount).toBe(index);
      expect(line).toMatch(/^server send +\d+ : s=\d+ (?:ack=\d+|fragment=\d+,\d+)\n$/);
      const fragment = /fragment=\d+,(\d+)/.exec(line);
      if (fragment !== null) expect(observation.remaining).toBeGreaterThanOrEqual(Number(fragment[1]));
    }
    expect(observed.some(value => value.remaining > 1300)).toBe(true);
    enabled = false;
    const previousPackets = observed.length;
    await f.server.frame(50); await pumpClient(f, client);
    expect(observed.length).toBeGreaterThan(previousPackets);
    expect(f.prints.filter(text => text.startsWith("server send "))).toEqual(lines);
    const serverClient = running(f.server).statics.clients[0];
    if (serverClient === undefined || serverClient.connection.kind !== "initialized") throw new Error("Missing actual server receive channel");
    const incoming = serverClient.connection.netchan.incomingSequence;
    transmitProtocolClient(client, f.clock.wallTime, 0, true);
    const packet = transmitProtocolClient(client, f.clock.wallTime, 0, true)[0];
    if (packet === undefined) throw new Error("Missing actual client datagram");
    const sequence = incoming + 2, printStart = f.prints.length;
    f.cvars.set("showdrop", "1", true);
    f.loopback.send("client", packet); await pumpServer(f);
    f.loopback.send("client", packet); await pumpServer(f);
    expect(f.prints.slice(printStart)).toEqual([
      `loopback:Dropped 1 packets at ${sequence}\n`,
      `loopback:Out of order packet ${sequence} at ${sequence}\n`,
    ]);
    f.cvars.set("showdrop", "0", true); f.cvars.set("showpackets", "1", true);
    f.loopback.send("client", packet); await pumpServer(f);
    expect(f.prints.slice(printStart + 2)).toEqual([
      `server recv ${String(packet.length).padStart(4)} : s=${sequence}\n`,
      `loopback:Out of order packet ${sequence} at ${sequence}\n`,
    ]);
  });

  test(`${product}: connection-owned reliable userinfo reaches actual server after genuine admission`, async () => {
    const f = await fixture(product); await execute(f.server, `map ${product === "missionpack" ? "mpteam1" : "q3dm1"}`);
    const cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars), challenge = 17, qport = 123;
    lifecycle.clientStatic.phase = "challenging";
    const ring = lifecycle.clientConnection.reliable;
    const text = 'userinfo "\\name\\BeforeAdmission\\rate\\25000\\snaps\\20\\model\\sarge/default"';
    expect(ring.add(text)).toEqual({ sequence: 1, text });
    f.loopback.send("client", encodeConnect(`\\protocol\\68\\qport\\${qport}\\challenge\\${challenge}\\name\\Initial\\rate\\25000\\snaps\\20\\model\\sarge/default`));
    await pumpServer(f);
    const response = f.loopback.poll("client"); if (response === null) throw new Error("Missing actual admission response");
    expect(decodeConnectionless(response.payload, "client").command).toBe("connectResponse");
    lifecycle.clientStatic.phase = "connected";
    const client = new EngineClientSession({ product, cvars, lifecycle, mode: { kind: "network", challenge, qport } });
    await send(f, client); await receiveGamestate(f, client, 0);
    // The first pre-gamestate packet requests gamestate; its reliable command stays pending until the matching serverId arrives.
    await send(f, client);
    const serverClient = running(f.server).statics.clients[0]; if (serverClient === undefined) throw new Error("Missing admitted server client");
    expect(serverClient.lastClientCommand).toBe(1); expect(serverClient.lastClientCommandString).toBe(text);
    expect(serverClient.name).toBe("BeforeAdmission");
    await f.server.frame(50); await pumpClient(f, client);
    expect(ring.acknowledge).toBe(1); expect(ring.pending()).toEqual([]); expect(ring.sequence).toBe(1);
    expect(client.addReliableCommand("disconnect").sequence).toBe(2); expect(ring.sequence).toBe(2);
    await send(f, client); expect(serverClient.phase).toBe(ServerClientPhase.Zombie);
    expect(serverClient.lastClientCommand).toBe(2);
  });
}

async function receiveUdp(socket: UdpTransport) {
  const deadline = performance.now() + 2000;
  while (socket.statistics.pending === 0) {
    if (performance.now() > deadline) throw new Error("Timed out waiting for actual localhost UDP delivery");
    await Bun.sleep(1);
  }
  const packet = socket.poll();
  if (packet === null) throw new Error("Missing queued UDP packet");
  if (packet.kind === "error") throw packet.error;
  return packet;
}

async function connectKickPeer(f: Awaited<ReturnType<typeof fixture>>, socket: UdpTransport, peer: UdpTransport, name: string) {
  async function submit(bytes: Uint8Array): Promise<void> {
    expect(peer.send(socket.address, bytes)).toBe(true);
    const packet = await receiveUdp(socket); await f.server.packetEvent(packet.from, packet.payload);
  }
  await submit(encodeConnectionlessText("getchallenge"));
  const response = decodeConnectionless((await receiveUdp(peer)).payload, "client");
  expect(response.command).toBe("challengeResponse");
  const challengeText = response.arguments[0];
  if (challengeText === undefined) throw new Error("Missing source challenge number");
  const challenge = Number(challengeText), qport = 891;
  await submit(encodeConnect(`\\protocol\\68\\qport\\${qport}\\challenge\\${challenge}\\name\\${name}\\rate\\25000\\snaps\\20`));
  expect(decodeConnectionless((await receiveUdp(peer)).payload, "client").command).toBe("connectResponse");
  const client = createProtocolClientSession({ product: f.options.common.roots.product,
    mode: { kind: "network", challenge, qport }, cvars: new CvarRegistry() });
  async function sendCommands(): Promise<void> {
    for (const packet of transmitProtocolClient(client, f.clock.wallTime, 0, true)) await submit(packet);
  }
  await sendCommands();
  for (let count = 0; count < 32 && client.gamestateGeneration === 0; count++) {
    await client.receiveDatagram((await receiveUdp(peer)).payload);
    if (client.gamestateGeneration === 0) await f.server.frame(50);
  }
  expect(client.gamestateGeneration).toBe(1); client.prime(1); client.setUserCmdValue(Weapon.WP_MACHINEGUN, 1);
  const state = running(f.server), serverClient = state.statics.clients.find(value => value.connection.kind === "initialized"
    && value.connection.address.kind === "ipv4" && value.connection.address.port === peer.address.port);
  if (serverClient === undefined) throw new Error("Missing actual remote client");
  client.createUserCommand({ serverTime: state.statics.time, viewAngles: vec3(0, 0, 0), buttons: 0,
    forwardmove: 0, rightmove: 0, upmove: 0 });
  await sendCommands(); expect(serverClient.phase).toBe(ServerClientPhase.Active);
  await f.server.frame(50); await client.receiveDatagram((await receiveUdp(peer)).payload);
  return { client, serverClient, sendCommands };
}

describe("server operator kick commands", () => {
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: source bot operator removal releases active and delayed clients for reuse`, async () => {
      const f = await fixture(product, false, options => ({ ...options, bots: { kind: "source" } }));
      f.cvars.set("bot_enable", "1", true); f.cvars.set("sv_maxclients", "3", true);
      f.cvars.set("g_log", "", true); f.cvars.set("bot_minplayers", "0", true);
      await execute(f.server, `map ${product === "baseq3" ? "q3dm1" : "mpteam1"}`);
      await connect(f);
      await execute(f.server, "addbot Sarge 4 red 0 Immediate\naddbot Visor 4 blue 200 Queued");
      const state = running(f.server), host = state.statics.clients[0], active = state.statics.clients[1], delayed = state.statics.clients[2];
      if (host === undefined || active === undefined || delayed === undefined) throw new Error("Missing actual server client slots");
      expect(host.phase).toBe(ServerClientPhase.Active);
      expect(active.connection.address.kind).toBe("bot"); expect(delayed.connection.address.kind).toBe("bot");
      expect(state.game.pool.clientAt(active.slot).pers.connected).toBe(ConnectionState.CONNECTED);
      expect(state.game.pool.clientAt(delayed.slot).pers.connected).toBe(ConnectionState.CONNECTING);
      const before = f.prints.length;
      await execute(f.server, "kick ALLBOTS");
      expect(f.prints.slice(before)).toContain("Player ALLBOTS is not on the server\n");
      expect(host.phase).toBe(ServerClientPhase.Active);
      for (const client of [active, delayed]) {
        expect(client.phase).toBe(ServerClientPhase.Free); expect(client.userinfo).toBe("");
        expect(client.lastPacketTime).toBe(state.statics.time);
        expect(state.game.pool.clientAt(client.slot).pers.connected).toBe(ConnectionState.DISCONNECTED);
        expect(state.game.pool.at(client.slot).inuse).toBe(false);
        expect(state.world.configstrings.get(544 + client.slot)).toBe("");
      }
      for (let frame = 0; frame < 6; frame++) await f.server.frame(50);
      expect(state.game.pool.clientAt(delayed.slot).pers.connected).toBe(ConnectionState.DISCONNECTED);
      expect(state.game.pool.at(delayed.slot).inuse).toBe(false);
      await execute(f.server, "addbot Sarge 4 red 0 allbots\naddbot Visor 4 blue 0 Survivor");
      expect(state.game.pool.clientAt(active.slot).pers.connected).toBe(ConnectionState.CONNECTED);
      expect(state.game.pool.clientAt(delayed.slot).pers.connected).toBe(ConnectionState.CONNECTED);
      const namedBefore = f.prints.length;
      await execute(f.server, "kick ALLBOTS");
      expect(f.prints.slice(namedBefore)).not.toContain("Player ALLBOTS is not on the server\n");
      expect(active.phase).toBe(ServerClientPhase.Free); expect(delayed.phase).toBe(ServerClientPhase.Active);
      await execute(f.server, `clientkick ${delayed.slot}`);
      expect(delayed.phase).toBe(ServerClientPhase.Free);
      expect(state.game.pool.clientAt(delayed.slot).pers.connected).toBe(ConnectionState.DISCONNECTED);
      expect(host.phase).toBe(ServerClientPhase.Active);
      expect(f.prints.join("")).not.toContain("already setup");
    });
  }

  test("a passed clientkick vote drops an actual remote player and delivers its reliable disconnect", async () => {
    const socket = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    const peer = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    try {
      const f = await fixture("baseq3", true, options => ({ ...options, network: { ...options.network, udp: socket } }));
      await execute(f.server, "map q3dm1"); const host = await connect(f);
      const remote = await connectKickPeer(f, socket, peer, "^2Target"), state = running(f.server);
      host.addReliableCommand(`callvote clientkick ${remote.serverClient.slot}`); await send(f, host);
      expect(state.game.level.vote.string).toBe('clientkick "1"');
      remote.client.addReliableCommand("vote yes"); await remote.sendCommands();
      await f.server.frame(50); expect(state.game.level.vote.executeTime).toBeGreaterThan(state.statics.time);
      for (let frame = 0; frame < 62 && f.server.commands.pendingText === ""; frame++) await f.server.frame(50);
      expect(f.server.commands.pendingText).toBe('clientkick "1"\n');
      expect(remote.serverClient.phase).toBe(ServerClientPhase.Active);
      await f.server.commands.executeAsync();
      expect(remote.serverClient.phase).toBe(ServerClientPhase.Zombie);
      expect(state.game.pool.clientAt(remote.serverClient.slot).pers.connected).toBe(ConnectionState.DISCONNECTED);
      expect(remote.serverClient.lastPacketTime).toBe(state.statics.time);
      const disconnect = remote.serverClient.reliable.pending().find(command => command.text === 'disconnect "was kicked"');
      if (disconnect === undefined) throw new Error("Missing actual queued disconnect");
      await f.server.frame(50);
      for (let packet = 0; packet < 80; packet++) {
        await remote.client.receiveDatagram((await receiveUdp(peer)).payload);
        if (peer.statistics.pending === 0) break;
      }
      await expect(remote.client.getServerCommand(disconnect.sequence)).rejects.toThrow("Server Disconnected - was kicked");
      expect(remote.client.takeEvents()).toContainEqual({ kind: "disconnect", reason: "Server Disconnected - was kicked", errorKind: "server-disconnect" });
    } finally { socket.close(); peer.close(); }
  });

  test("raw and cleaned names match per slot before a literal all player suppresses the group", async () => {
    const socket = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    const peer = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    try {
      const f = await fixture("baseq3", true, options => ({ ...options, network: { ...options.network, udp: socket } }));
      await execute(f.server, "map q3dm1"); const host = await connect(f);
      host.addReliableCommand('userinfo "\\name\\^1Twin"'); await send(f, host);
      const remote = await connectKickPeer(f, socket, peer, "Twin"), state = running(f.server);
      const hostClient = state.statics.clients[0]; if (hostClient === undefined) throw new Error("Missing admitted host");
      for (const name of ["tWiN", "^1tWIN"]) {
        const before = hostClient.reliable.sequence;
        await execute(f.server, `kick "${name}"`);
        expect(remote.serverClient.phase).toBe(ServerClientPhase.Active);
        expect(hostClient.reliable.pending().filter(command => command.sequence > before).map(command => command.text))
          .toEqual(['print "Cannot kick host player\n"']);
      }
      remote.client.addReliableCommand('userinfo "\\name\\all"'); await remote.sendCommands();
      expect(remote.serverClient.name).toBe("all");
      const printStart = f.prints.length;
      await execute(f.server, "kick ALL");
      expect(f.prints.slice(printStart).join("")).not.toContain("Player ALL is not on the server");
      expect(hostClient.phase).toBe(ServerClientPhase.Active); expect(remote.serverClient.phase).toBe(ServerClientPhase.Zombie);
    } finally { socket.close(); peer.close(); }
  });

  test("clientkick preserves source usage, decimal slot validation, and quoted empty slot zero", async () => {
    const f = await fixture();
    await execute(f.server, "kick nobody\nclientkick 0");
    expect(f.prints.slice(-2)).toEqual(["Server is not running.\n", "Server is not running.\n"]);
    await execute(f.server, "map q3dm1"); await connect(f);
    const printStart = f.prints.length;
    await execute(f.server, "kick\nclientkick\nclientkick -1\nclientkick +0\nclientkick 1x\nclientkick 2\nclientkick 1");
    expect(f.prints.slice(printStart)).toEqual([
      "Usage: kick <player name>\nkick all = kick everyone\nkick allbots = kick all bots\n",
      "Usage: kicknum <client number>\n", "Bad slot number: -1\n", "Bad slot number: +0\n", "Bad slot number: 1x\n",
      "Bad client slot: 2\n", "Client 1 is not active\n",
    ]);
    const hostClient = running(f.server).statics.clients[0]; if (hostClient === undefined) throw new Error("Missing admitted host");
    const before = hostClient.reliable.sequence;
    await execute(f.server, 'clientkick ""\nclientkick 00');
    expect(hostClient.phase).toBe(ServerClientPhase.Active);
    expect(hostClient.reliable.pending().filter(command => command.sequence > before).map(command => command.text))
      .toEqual(['print "Cannot kick host player\n"', 'print "Cannot kick host player\n"']);
  });

  test("group lookup reports its miss, retains humans for allbots, and refreshes a kicked zombie timestamp", async () => {
    const socket = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    const peer = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    try {
      const f = await fixture("missionpack", true, options => ({ ...options, network: { ...options.network, udp: socket } }));
      await execute(f.server, "map mpteam1"); await connect(f);
      const remote = await connectKickPeer(f, socket, peer, "Remote"), state = running(f.server);
      const printStart = f.prints.length;
      await execute(f.server, "kick ALLBOTS");
      expect(f.prints.slice(printStart)).toEqual(["Player ALLBOTS is not on the server\n"]);
      expect(remote.serverClient.phase).toBe(ServerClientPhase.Active);
      await execute(f.server, "kick all");
      expect(f.prints.slice(printStart + 1)[0]).toBe("Player all is not on the server\n");
      expect(state.statics.clients[0]?.phase).toBe(ServerClientPhase.Active);
      expect(remote.serverClient.phase).toBe(ServerClientPhase.Zombie);
      expect(state.game.pool.clientAt(remote.serverClient.slot).pers.connected).toBe(ConnectionState.DISCONNECTED);
      const before = remote.serverClient.reliable.sequence, time = remote.serverClient.lastPacketTime;
      await f.server.frame(50); await execute(f.server, `clientkick ${remote.serverClient.slot}`);
      expect(remote.serverClient.lastPacketTime).toBe(state.statics.time); expect(remote.serverClient.lastPacketTime).toBeGreaterThan(time);
      expect(remote.serverClient.reliable.sequence).toBe(before);
    } finally { socket.close(); peer.close(); }
  });
});

describe("server operator ban commands", () => {
  async function banFixture(product: Product = "baseq3",
    configure: (options: ServerEngineOptions) => ServerEngineOptions = options => options) {
    const f = await fixture(product, true, configure);
    const map = renderBspFixture([{ shader: "test/first", lightmap: -1 }, { shader: "test/second", lightmap: -1 }], []);
    mkdirSync(join(f.homePath, product), { recursive: true });
    writeFileSync(join(f.homePath, product, "operator-ban.pk3"), sourceZip([
      { name: new TextEncoder().encode("maps/operator-ban.bsp"), data: map, method: 0, utf8: false },
    ]));
    await f.options.common.files.restart({ checksumFeed: 0, random: () => 0 }, () => undefined);
    f.cvars.set("g_gametype", "0", true); f.cvars.set("g_log", "", true);
    return f;
  }

  test("source running, usage, lookup and loopback refusal ordering through registered commands", async () => {
    const f = await banFixture();
    let start = f.prints.length;
    await execute(f.server, "banUser\nbanClient\nbanUser HostPeer\nbanClient 0");
    expect(f.prints.slice(start)).toEqual(Array.from({ length: 4 }, () => "Server is not running.\n"));
    await execute(f.server, "map operator-ban"); await connect(f);
    start = f.prints.length;
    await execute(f.server, "banUser\nbanUser HostPeer extra\nbanClient\nbanClient 0 extra\nbanUser all\nbanUser 0\nbanClient -1\nbanClient +0\nbanClient 1x\nbanClient 2\nbanClient 1");
    expect(f.prints.slice(start)).toEqual([
      "Usage: banUser <player name>\n", "Usage: banUser <player name>\n",
      "Usage: banClient <client number>\n", "Usage: banClient <client number>\n",
      "Player all is not on the server\n", "Player 0 is not on the server\n",
      "Bad slot number: -1\n", "Bad slot number: +0\n", "Bad slot number: 1x\n",
      "Bad client slot: 2\n", "Client 1 is not active\n",
    ]);
    const state = running(f.server), client = state.statics.clients[0];
    if (client === undefined) throw new Error("Missing admitted host");
    const sequence = client.reliable.sequence;
    await execute(f.server, 'banUser hOsTpEeR\nbanClient ""\nbanClient 00');
    expect(client.reliable.pending().filter(command => command.sequence > sequence).map(command => command.text))
      .toEqual(Array.from({ length: 3 }, () => 'print "Cannot kick host player\n"'));
    expect(client.phase).toBe(ServerClientPhase.Active);
    expect(state.statics.authorizeAddress).toEqual({ kind: "unresolved" });
  });

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: registered ban commands send authorization packets without kicking and share challenge cache`, async () => {
      const socket = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
      const peer = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
      const authority: Ipv4Address = { kind: "ipv4", host: [192, 0, 2, 10], port: 27952 };
      const requests: string[] = [], packets: { address: Ipv4Address; payload: Uint8Array }[] = [];
      try {
        const f = await banFixture(product, options => ({ ...options, network: { ...options.network, udp: socket,
          resolveAddress: async (name, port) => { requests.push(`${name}:${port}`); return { ...authority, port: 1 }; } } }));
        await execute(f.server, "map operator-ban");
        const remote = await connectKickPeer(f, socket, peer, "^2MiXeD"), client = remote.serverClient;
        socket.send = (address, payload) => { packets.push({ address, payload: new Uint8Array(payload) }); return true; };
        const before = { phase: client.phase, time: client.lastPacketTime, reliable: client.reliable.sequence };
        const start = f.prints.length;
        await execute(f.server, "banUser mixed\nbanClient 00");
        expect(f.prints.slice(start)).toEqual([
          "Resolving authorize.quake3arena.com\n", "authorize.quake3arena.com resolved to 192.0.2.10:27952\n",
          "^2MiXeD was banned from coming back\n", "^2MiXeD was banned from coming back\n",
        ]);
        expect(requests).toEqual(["authorize.quake3arena.com:27952"]);
        for (const packet of packets) {
          expect(packet.address).toEqual(authority);
          expect([...packet.payload]).toEqual([...encodeConnectionlessText("banUser 127.0.0.1")]);
        }
        expect(packets).toHaveLength(2);
        expect({ phase: client.phase, time: client.lastPacketTime, reliable: client.reliable.sequence }).toEqual(before);
        expect(running(f.server).game.pool.clientAt(client.slot).pers.connected).toBe(ConnectionState.CONNECTED);
        await f.server.packetEvent({ kind: "ipv4", host: [203, 0, 113, 9], port: 27961 }, encodeConnectionlessText("getchallenge"));
        expect(requests).toHaveLength(1);
        const challenge = packets.at(-1);
        if (challenge === undefined) throw new Error("Missing captured authorization request");
        expect(challenge.address).toEqual(authority);
        expect(decodeConnectionless(challenge.payload, "server").command).toBe("getIpAuthorize");
        client.connection.phase = ServerClientPhase.Zombie;
        const zombieTime = client.lastPacketTime;
        await execute(f.server, "banUser ^2mixed");
        expect(client.phase).toBe(ServerClientPhase.Zombie); expect(client.lastPacketTime).toBe(zombieTime);
        expect(f.prints.at(-1)).toBe("^2MiXeD was banned from coming back\n");
      } finally { socket.close(); peer.close(); }
    });
  }

  test("rcon ban awaits DNS with shared redirect and command ownership until the actual send", async () => {
    const socket = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    const peer = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<Ipv4Address | null>();
    const packets: { address: Ipv4Address; payload: Uint8Array }[] = [];
    try {
      const f = await banFixture("baseq3", options => ({ ...options, network: { ...options.network, udp: socket,
        resolveAddress: (name, port) => {
          expect(name).toBe("authorize.quake3arena.com"); expect(port).toBe(27952);
          entered.resolve(); return gate.promise;
        } } }));
      await execute(f.server, "map operator-ban");
      const remote = await connectKickPeer(f, socket, peer, "RconTarget");
      socket.send = (address, payload) => {
        packets.push({ address, payload: new Uint8Array(payload) }); return true;
      };
      f.cvars.set("rconPassword", "host-secret", true);
      const pending = f.server.packetEvent({ kind: "loopback" }, encodeConnectionlessText("rcon host-secret banClient 0"));
      await entered.promise;
      expect(f.server.output.redirecting).toBe(true); expect(f.server.networkControl.rconBusy).toBe(true);
      expect(f.loopback.poll("client")).toBeNull(); expect(packets).toEqual([]);
      await expect(f.server.frame(50)).rejects.toThrow("awaited in source order");
      await expect(f.server.commands.executeNowAsync("banClient 0")).rejects.toThrow("overlapping command execution");
      gate.resolve({ kind: "ipv4", host: [192, 0, 2, 10], port: 1 }); await pending;
      const packet = packets[0];
      if (packet === undefined) throw new Error("Missing captured ban packet");
      expect(packet.address).toEqual({ kind: "ipv4", host: [192, 0, 2, 10], port: 27952 });
      expect(packets).toHaveLength(1); expect([...packet.payload]).toEqual([...encodeConnectionlessText("banUser 127.0.0.1")]);
      const response = f.loopback.poll("client");
      if (response === null) throw new Error("Missing actual rcon redirect response");
      expect([...response.payload]).toEqual([...encodeConnectionlessText(
        "print\nResolving authorize.quake3arena.com\nauthorize.quake3arena.com resolved to 192.0.2.10:27952\nRconTarget was banned from coming back\n")]);
      expect(f.server.output.redirecting).toBe(false); expect(f.server.networkControl.connectionlessBusy).toBe(false);
      expect(remote.serverClient.phase).toBe(ServerClientPhase.Active);
    } finally { gate.resolve(null); socket.close(); peer.close(); }
  });
});

describe("server operator info and say commands", () => {
  test("stopped info commands print live cvar values with the ordinary system-info limit", async () => {
    const f = await fixture();
    f.cvars.register("operator_server", "current", CvarFlag.ServerInfo | CvarFlag.Latch);
    f.cvars.set("operator_server", "pending");
    f.cvars.register("operator_user", "local-user-only", CvarFlag.UserInfo);
    f.cvars.register("operator_system_a", "a".repeat(400), CvarFlag.SystemInfo);
    f.cvars.register("operator_system_b", "b".repeat(400), CvarFlag.SystemInfo);
    f.cvars.register("operator_system_c", "c".repeat(400), CvarFlag.SystemInfo);
    const printStart = f.prints.length;
    await execute(f.server, "serverinfo ignored-argument\nsysteminfo");
    const output = f.prints.slice(printStart), joined = output.join("");
    expect(f.server.state.kind).toBe("stopped"); expect(output[0]).toBe("Server info settings:\n");
    const serverIndex = output.indexOf("operator_server     ");
    expect(serverIndex).toBeGreaterThan(0); expect(output[serverIndex + 1]).toBe("current\n");
    expect(joined).not.toContain("pending"); expect(joined).not.toContain("operator_user");
    const systemIndex = output.indexOf("System info settings:\n"); expect(systemIndex).toBeGreaterThan(serverIndex);
    expect(output.slice(systemIndex)).toContain("operator_system_b   ");
    expect(output.slice(systemIndex)).toContain("operator_system_c   ");
    expect(output.slice(systemIndex)).not.toContain("operator_system_a   ");
    expect(output).toContain(`${"b".repeat(400)}\n`); expect(output).toContain(`${"c".repeat(400)}\n`);
    expect(f.cvars.infoString(CvarFlag.SystemInfo, 8192)).toContain(`\\operator_system_a\\${"a".repeat(400)}`);
  });

  test("dumpuser prints the actual remote userinfo after name lookup, including numeric names", async () => {
    const socket = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    const peer = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    let server: ServerEngine | null = null;
    try {
      const f = await fixture("missionpack", true, options => ({ ...options, network: { ...options.network, udp: socket } }));
      server = f.server;
      await execute(f.server, "dumpuser"); expect(f.prints.at(-1)).toBe("Server is not running.\n");
      await execute(f.server, "map mpteam1"); await connect(f);
      const remote = await connectKickPeer(f, socket, peer, "^2Remote");
      f.cvars.register("operator_probe", "local-cvar", CvarFlag.UserInfo);
      remote.client.addReliableCommand('userinfo "\\name\\^2Remote\\operator_probe\\remote-updated\\empty\\\\rate\\25000"');
      await remote.sendCommands();
      expect(remote.serverClient.userinfo).toContain("\\operator_probe\\remote-updated");
      let printStart = f.prints.length;
      await execute(f.server, "dumpuser rEmOtE");
      const output = f.prints.slice(printStart), field = output.indexOf("operator_probe      ");
      expect(output.slice(0, 2)).toEqual(["userinfo\n", "--------\n"]);
      expect(field).toBeGreaterThan(1); expect(output[field + 1]).toBe("remote-updated\n");
      expect(output.join("")).not.toContain("local-cvar");
      expect(output).toContain("^2Remote\n"); expect(output).toContain("empty               ");
      expect(running(f.server).world.configstrings.get(544 + remote.serverClient.slot)).not.toContain("operator_probe");
      printStart = f.prints.length;
      await execute(f.server, "dumpuser\ndumpuser Remote extra\ndumpuser 1");
      expect(f.prints.slice(printStart)).toEqual(["Usage: info <userid>\n", "Usage: info <userid>\n", "Player 1 is not on the server\n"]);
      remote.client.addReliableCommand('userinfo "\\name\\0\\operator_probe\\numeric-name"'); await remote.sendCommands();
      printStart = f.prints.length; await execute(f.server, "dumpuser 0");
      expect(f.prints.slice(printStart)).toContain("numeric-name\n");
      expect(f.prints.slice(printStart)).not.toContain("HostPeer\n");
    } finally {
      try { await server?.shutdown({ kind: "normal", reason: "operator info test complete" }); }
      finally { socket.close(); peer.close(); }
    }
  });

  test("dedicated say retains registration, sends exact tokenized chat and preserves source storage bounds", async () => {
    const socket = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    const peer = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    let server: ServerEngine | null = null;
    try {
      const f = await fixture("baseq3", true, options => ({ ...options, network: { ...options.network, udp: socket } }));
      server = f.server;
      expect(f.server.commands.registeredNames()).toContain("say");
      await execute(f.server, "say"); expect(f.prints.at(-1)).toBe("Server is not running.\n");
      await execute(f.server, "map q3dm1"); const remote = await connectKickPeer(f, socket, peer, "Listener");
      const before = remote.serverClient.reliable.sequence, printStart = f.prints.length;
      await execute(f.server, 'say\nsay ""\nsay  "hello world"    second');
      expect(remote.serverClient.reliable.pending().filter(command => command.sequence > before).map(command => command.text))
        .toEqual(['chat "console: \n"', 'chat "console: hello world second\n"']);
      expect(f.prints.slice(printStart)).toEqual([]);
      await f.server.frame(50); await remote.client.receiveDatagram((await receiveUdp(peer)).payload);
      expect(await remote.client.getServerCommand(before + 1)).toEqual(["chat", "console: \n"]);
      expect(await remote.client.getServerCommand(before + 2)).toEqual(["chat", "console: hello world second\n"]);
      f.cvars.set("dedicated", "0", true);
      await execute(f.server, "say retained-registration");
      expect(remote.serverClient.reliable.pending().at(-1)?.text).toBe('chat "console: retained-registration\n"');
      await execute(f.server, `say ${"x".repeat(1014)}`);
      expect(remote.serverClient.reliable.pending().at(-1)?.text).toBe(`chat "console: ${"x".repeat(1008)}`);
      const sequence = remote.serverClient.reliable.sequence;
      await expect(execute(f.server, `say ${"x".repeat(1015)}`)).rejects.toThrow("SV_ConSay_f would overflow its source text buffer");
      await expect(f.server.commands.executeNowAsync(`say ${"x".repeat(1024)}`)).rejects.toThrow("Cmd_Args would overflow its source buffer");
      expect(remote.serverClient.reliable.sequence).toBe(sequence);
      const listen = await fixture("baseq3", true, options => {
        options.common.cvars.set("dedicated", "0", true); return options;
      });
      expect(listen.cvars.get("dedicated")?.integerValue).toBe(0);
      expect(listen.server.commands.registeredNames()).not.toContain("say");
      listen.cvars.set("dedicated", "1", true);
      await execute(listen.server, "map q3dm1"); await connect(listen);
      expect(listen.server.commands.registeredNames()).not.toContain("say");
      await execute(listen.server, "say fallback");
      expect(running(listen.server).statics.clients[0]?.reliable.pending().at(-1)?.text).toBe('print "server: fallback"');
    } finally {
      try { await server?.shutdown({ kind: "normal", reason: "operator chat test complete" }); }
      finally { socket.close(); peer.close(); }
    }
  });
});

function homeDescriptors(homePath: string): { descriptor: number; path: string }[] {
  return readdirSync("/proc/self/fd").flatMap(entry => {
    try { const path = readlinkSync(`/proc/self/fd/${entry}`); return path.startsWith(`${homePath}/`) ? [{ descriptor: Number(entry), path }] : []; }
    catch { return []; }
  });
}

describe("resource-only server disposal", () => {
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    for (const point of ["running", "server-banner", "bot-control", "bot-ordinary", "restart-before-bots", "init-bots", "init-ordinary-cleanup", "source-stopped"]) {
      test(`${product}: resource-only disposal retains the server bot owner through ${point}`, async () => {
        let armed = false;
        const clientCalls: string[] = [];
        const failure = new CommonError("drop", `source ${point}`), ordinary = new Error("ordinary bot shutdown");
        const f = await fixture(product, false, options => {
          return { ...options, bots: { kind: "source" }, clientLifecycle: { kind: "available",
            mapLoading: async () => { clientCalls.push("mapLoading"); },
            shutdownAllForServerMap: async () => { clientCalls.push("shutdownAll"); },
            disconnectAfterServerShutdown: async () => { clientCalls.push("disconnect"); },
          } };
        }, text => {
          if (!armed) return;
          if ((point === "server-banner" && text === "----- Server Shutdown -----\n")
            || (point === "restart-before-bots" && text === "------- Game Initialization -------\n")
            || (point === "bot-control" && text === "Closed log botlib.log\n")
            || (point === "init-bots" && text === "------- BotLib Initialization -------\n")
            || (point === "init-ordinary-cleanup" && text === "Closed log botlib.log\n")) throw failure;
          if ((point === "bot-ordinary" && text === "Closed log botlib.log\n")
            || (point === "init-ordinary-cleanup" && text === "------------ Map Loading ------------\n")) throw ordinary;
        });
        const map = product === "baseq3" ? "q3dm1" : "mpteam1";
        f.cvars.set("bot_enable", "1", true); f.cvars.set("g_gametype", "3", true);
        f.cvars.set("logfile", "1", true); f.options.common.output.print("open qconsole\n");
        try {
          if (point === "init-bots" || point === "init-ordinary-cleanup") {
            armed = true;
            await expect(execute(f.server, `map ${map}`)).rejects.toBe(failure);
          } else {
            await execute(f.server, `map ${map}`);
            const botLog = homeDescriptors(f.homePath).find(fd => fd.path.endsWith("/botlib.log"));
            if (botLog === undefined) throw new Error("Source bot library did not open its actual log");
            expect(f.prints.filter(text => text === "Opened log botlib.log\n")).toHaveLength(1);
            if (point === "source-stopped") {
              await f.server.shutdown({ kind: "normal", reason: "source stop" });
              expect(f.server.state.kind).toBe("stopped");
              expect(homeDescriptors(f.homePath).some(fd => fd.path.endsWith("/botlib.log"))).toBe(false);
              await execute(f.server, `map ${map}`);
              await f.server.shutdown({ kind: "normal", reason: "source stop again" });
              expect(f.server.state.kind).toBe("stopped");
              expect(f.prints.filter(text => text === "Opened log botlib.log\n")).toHaveLength(2);
              expect(f.prints.filter(text => text === "Closed log botlib.log\n")).toHaveLength(2);
            } else if (point === "restart-before-bots") {
              const old = running(f.server).game;
              f.clock.comFrameTime++;
              await execute(f.server, "map_restart 0");
              old.disposeResources();
              expect(homeDescriptors(f.homePath).find(fd => fd.path.endsWith("/botlib.log"))).toEqual(botLog);
              const setups = f.prints.filter(text => text === "------- BotLib Initialization -------\n").length;
              f.clock.comFrameTime++; armed = true;
              await expect(execute(f.server, "map_restart 0")).rejects.toBe(failure);
              expect(f.prints.filter(text => text === "------- BotLib Initialization -------\n")).toHaveLength(setups);
              expect(homeDescriptors(f.homePath).find(fd => fd.path.endsWith("/botlib.log"))).toEqual(botLog);
            } else if (point !== "running") {
              armed = true;
              if (point === "bot-ordinary") await expect(f.server.shutdown({ kind: "normal", reason: "abort" })).rejects.toBeInstanceOf(AggregateError);
              else await expect(f.server.shutdown({ kind: "normal", reason: "abort" })).rejects.toBe(failure);
            }
          }
          const state = f.server.state;
          const game = state.kind === "running" ? state.world.game : null;
          if (game !== null && !(game instanceof GameRuntime)) throw new Error("Expected direct TypeScript game");
          const before = [...f.prints], clients = [...clientCalls], session = f.cvars.get("session")?.value;
          const serverRunning = f.cvars.get("sv_running"), singlePlayerActive = f.cvars.get("ui_singlePlayerActive");
          expect(homeDescriptors(f.homePath).some(fd => fd.path.endsWith("qconsole.log"))).toBe(true);
          await f.server.disposeResources(); await f.server.disposeResources();
          expect(f.server.state.kind).toBe("disposed");
          expect(clientCalls).toEqual(clients);
          expect(f.prints).toEqual(before); expect(f.cvars.get("session")?.value).toBe(session);
          expect(homeDescriptors(f.homePath).map(fd => fd.path)).toEqual([join(f.homePath, product, "qconsole.log")]);
          expect(f.cvars.get("sv_running")).toEqual(serverRunning); expect(f.cvars.get("ui_singlePlayerActive")).toEqual(singlePlayerActive);
          if (game !== null) expect(() => game.runFrame(5000)).toThrow("shut down");
          await expect(f.server.frame(50)).rejects.toThrow("disposed");
          await expect(execute(f.server, `map ${map}`)).rejects.toThrow("disposed");
          f.options.common.close(); expect(homeDescriptors(f.homePath)).toEqual([]);
        } finally { armed = false; }
      });
    }
  }

  for (const failure of [new CommonError("drop", "managed bot release"), null, undefined,
    new AggregateError([new CommonError("drop", "nested managed value"), null], "opaque owner failure")]) {
    test(`resource-only disposal finishes all owners after download and bot failures: ${String(failure)}`, async () => {
      const f = await fixture("baseq3", false, options => ({ ...options, bots: { kind: "source" } }));
      f.cvars.set("bot_enable", "1", true); f.cvars.set("g_gametype", "3", true);
      const botLogs: BotLogStream[] = [], openBotLog = f.server.writable.openBotLog.bind(f.server.writable);
      f.server.writable.openBotLog = filename => {
        const result = openBotLog(filename);
        if (result.kind === "opened") botLogs.push(result.stream);
        return result;
      };
      await execute(f.server, "map q3dm1");
      const botLog = botLogs[0];
      if (botLog === undefined) throw new Error("Expected actual source bot log resource");
      expect(botLogs).toHaveLength(1);
      const before = running(f.server), calls: string[] = [], reentrant: Promise<void>[] = [];
      const disposeGame = before.game.disposeResources, gameFailure = new CommonError("drop", "managed game release");
      before.game.disposeResources = () => { calls.push("game"); disposeGame.call(before.game); throw gameFailure; };
      mkdirSync(join(f.homePath, "custom")); writeFileSync(join(f.homePath, "custom", "map.pk3"), "synthetic download");
      const client = before.statics.clients[0], file = f.options.common.files.server.openDownload("custom/map.pk3");
      if (client === undefined || file === null) throw new Error("Expected actual download file");
      client.download.file = file; client.download.name = "custom/map.pk3"; client.download.blocks[0] = new Uint8Array([1]);
      const close = file.close.bind(file), downloadFailure = new CommonError("drop", "managed download release");
      file.close = () => {
        calls.push("download"); expect(client.download.file).toBeNull(); expect(client.download.name).toBe("");
        close(); reentrant.push(f.server.frame(50), f.server.disposeResources()); throw downloadFailure;
      };
      const closeBotLog = botLog.close.bind(botLog);
      botLog.close = () => { calls.push("bots"); expect(closeBotLog().kind).toBe("ok"); throw failure; };
      const extra = f.server.writable.openAppend("common-extra.log", false);
      if (extra === null) throw new Error("Expected actual writable resource");
      const closeWritable = f.server.writable.closeAll.bind(f.server.writable);
      f.server.writable.closeAll = () => { throw new Error("Server must not close common-owned files"); };
      const prints = [...f.prints];
      try {
        let result: unknown;
        try { await f.server.disposeResources(); } catch (error) { result = error; }
        expect(result).toBeInstanceOf(AggregateError);
        if (!(result instanceof AggregateError)) throw new Error("Expected finite release aggregate");
        const errors: unknown = result.errors;
        expect(errors).toEqual([gameFailure, downloadFailure, failure]); expect(calls).toEqual(["game", "download", "bots"]);
        for (const entry of reentrant) await expect(entry).rejects.toThrow("awaited in source order");
        expect(before.world.game).toBeNull(); expect(before.world.state).toBe("dead"); expect(client.gameEntity).toBeNull();
        expect(f.server.state.kind).toBe("disposed"); expect(f.prints).toEqual(prints); expect(f.loopback.poll("client")).toBeNull();
        expect(homeDescriptors(f.homePath).map(fd => fd.path)).toEqual([join(f.homePath, "baseq3", "common-extra.log")]);
        extra.write("survives server disposal");
        await f.server.disposeResources(); expect(calls).toEqual(["game", "download", "bots"]);
        extra.close(); expect(homeDescriptors(f.homePath)).toEqual([]);
        expect(readFileSync(join(f.homePath, "baseq3", "common-extra.log"), "latin1")).toBe("survives server disposal");
      } finally {
        file.close = close; before.game.disposeResources = disposeGame; f.server.writable.closeAll = closeWritable;
        botLog.close = closeBotLog; f.server.writable.openBotLog = openBotLog;
      }
    });
  }

  test("resource-only disposal is independent across two simultaneous retail servers", async () => {
    const a = await fixture("baseq3"), b = await fixture("missionpack");
    await execute(a.server, "map q3dm1"); await execute(b.server, "map mpteam1");
    const gameB = running(b.server).game, descriptors = homeDescriptors(b.homePath);
    expect(descriptors.length).toBeGreaterThan(0);
    await a.server.disposeResources(); expect(homeDescriptors(a.homePath)).toEqual([]);
    expect(homeDescriptors(b.homePath)).toEqual(descriptors); await b.server.frame(50); expect(running(b.server).game).toBe(gameB);
    await b.server.disposeResources(); expect(homeDescriptors(b.homePath)).toEqual([]);
  });

  test("resource-only disposal invalidates an active real protocol client without final messages", async () => {
    const f = await fixture(); await execute(f.server, "map q3dm1"); await connect(f);
    f.cvars.set("developer", "1", true);
    const state = running(f.server), client = state.statics.clients[0];
    if (client === undefined) throw new Error("Expected active protocol client");
    expect(client.phase).toBe(ServerClientPhase.Active); expect(client.gameEntity).toBe(state.game.data.entity(client.slot));
    expect(f.loopback.poll("client")).toBeNull();
    const prints = [...f.prints], session = f.cvars.get("session")?.value;
    const serverRunning = f.cvars.get("sv_running"), singlePlayerActive = f.cvars.get("ui_singlePlayerActive");
    await f.server.disposeResources();
    expect(f.loopback.poll("client")).toBeNull(); expect(f.prints).toEqual(prints);
    expect(client.gameEntity).toBeNull(); expect(state.world.game).toBeNull();
    expect(f.cvars.get("session")?.value).toBe(session); expect(homeDescriptors(f.homePath)).toEqual([]);
    expect(f.cvars.get("sv_running")).toEqual(serverRunning); expect(f.cvars.get("ui_singlePlayerActive")).toEqual(singlePlayerActive);
  });

  test("resource-only disposal releases an inert source bot owner without opening a map", async () => {
    const f = await fixture("baseq3", true, options => ({ ...options, bots: { kind: "source" } }));
    expect(f.server.options.bots.kind).toBe("source");
    expect(f.prints.some(text => text === "------- BotLib Initialization -------\n")).toBe(false);
    expect(homeDescriptors(f.homePath)).toEqual([]);
    const before = [...f.prints];
    await f.server.disposeResources(); await f.server.disposeResources();
    expect(f.server.state.kind).toBe("disposed");
    expect(f.prints).toEqual(before); expect(homeDescriptors(f.homePath)).toEqual([]);
  });
});

describe("production dedicated server composition with real retail VFS and loopback", () => {
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: capped area queries print through the actual common output`, async () => {
      const f = await fixture(product);
      await execute(f.server, `map ${product === "baseq3" ? "q3dm1" : "mpteam1"}`);
      const { game } = running(f.server), bounds = game.options.collision.modelBounds(0);
      const all = game.world.areaEntities(bounds);
      expect(all.length).toBeGreaterThan(1);
      let start = f.prints.length;
      expect(game.world.areaEntities(bounds, all.length)).toEqual(all);
      expect(f.prints.slice(start)).toEqual([]);
      start = f.prints.length;
      expect(game.world.areaEntities(bounds, 1)).toEqual(all.slice(0, 1));
      const diagnostics = f.prints.slice(start);
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.every(text => text === "SV_AreaEntities: MAXCOUNT\n")).toBe(true);
      start = f.prints.length;
      expect(game.world.areaEntities(bounds, 0)).toEqual([]);
      expect(f.prints.slice(start).length).toBeGreaterThan(0);
      expect(f.prints.slice(start).every(text => text === "SV_AreaEntities: MAXCOUNT\n")).toBe(true);
    });
  }

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: sectorlist reads actual membership before maps, through restarts and after repeated shutdown`, async () => {
      const f = await fixture(product), map = product === "baseq3" ? "q3dm1" : "mpteam1";
      expect(await sectorCounts(f)).toEqual(Array<number>(64).fill(0));
      await execute(f.server, `map ${map}`);
      const first = running(f.server), live = await sectorCounts(f);
      const bounds = first.game.options.collision.modelBounds(0);
      expect(live.reduce((sum, count) => sum + count, 0)).toBe(first.game.world.areaEntities(bounds).length);
      expect(live.some(count => count > 1)).toBe(true); expect(live.slice(31)).toEqual(Array<number>(33).fill(0));
      f.clock.comFrameTime++;
      await execute(f.server, "map_restart 0");
      expect(running(f.server).game.world).toBe(first.game.world);
      const restarted = await sectorCounts(f);
      expect(restarted.some(count => count > 1)).toBe(true);
      f.cvars.set("g_gametype", "3", true); f.clock.comFrameTime++;
      await execute(f.server, "map_restart 0");
      expect(running(f.server).game.world).not.toBe(first.game.world);
      const replaced = await sectorCounts(f);
      expect(replaced.some(count => count > 1)).toBe(true);
      await execute(f.server, "killserver");
      const cleared = replaced.map(count => count === 0 ? 0 : 1);
      expect(await sectorCounts(f)).toEqual(cleared);
      await execute(f.server, "killserver"); expect(await sectorCounts(f)).toEqual(cleared);
      await execute(f.server, `map ${map}`); expect((await sectorCounts(f)).some(count => count > 1)).toBe(true);
      await f.server.disposeResources(); await expect(sectorCounts(f)).rejects.toThrow("disposed");
    });
  }

  for (const point of ["shutdown", "files", "game", "construction"] satisfies readonly string[]) {
    for (const sourceControl of [true, false]) {
      test(`sectorlist preserves reached clears after ${sourceControl ? "CommonError" : "ordinary error"} at ${point}`, async () => {
        let armed = false;
        const failure = sourceControl ? new CommonError("drop", `sector ${point}`) : new Error(`sector ${point}`);
        const f = await fixture("baseq3", true, options => options, text => {
          if (armed && text === (point === "shutdown" ? "==== ShutdownGame ====\n" : point === "game" ? "------- Game Initialization -------\n" : "")) {
            armed = false; throw failure;
          }
        });
        await execute(f.server, "map q3dm1");
        const before = await sectorCounts(f), files = f.options.common.files;
        const restart = files.restart.bind(files), register = f.cvars.register.bind(f.cvars);
        files.restart = async (...args) => { if (armed && point === "files") { armed = false; throw failure; } await restart(...args); };
        f.cvars.register = (...args) => {
          if (armed && point === "construction" && args[0] === "bot_enable") { armed = false; throw failure; }
          return register(...args);
        };
        armed = true;
        try {
          await expect(execute(f.server, "map q3dm2")).rejects.toBe(failure);
          const expected = point === "game" || point === "construction" ? Array<number>(64).fill(0)
            : point === "shutdown" && sourceControl ? before : before.map(count => count === 0 ? 0 : 1);
          expect(await sectorCounts(f)).toEqual(expected);
        } finally { armed = false; files.restart = restart; f.cvars.register = register; }
        await execute(f.server, "map q3dm1"); expect((await sectorCounts(f)).some(count => count > 1)).toBe(true);
      });
    }
  }

  test("fast restart CommonError before game spawning leaves actual membership unchanged", async () => {
    let armed = false;
    const failure = new CommonError("drop", "sector fast restart");
    const f = await fixture("baseq3", true, options => options, text => {
      if (armed && text === "------- Game Initialization -------\n") throw failure;
    });
    await execute(f.server, "map q3dm1"); const before = await sectorCounts(f);
    f.clock.comFrameTime++; armed = true;
    try { await expect(execute(f.server, "map_restart 0")).rejects.toBe(failure); expect(await sectorCounts(f)).toEqual(before); }
    finally { armed = false; }
  });

  for (const point of ["game", "footer"]) {
    test(`shutdown sector heads reflect only clears reached before CommonError at ${point}`, async () => {
      let armed = false;
      const failure = new CommonError("drop", `sector shutdown ${point}`);
      const f = await fixture("baseq3", true, options => options, text => {
        if (armed && text === (point === "game" ? "==== ShutdownGame ====\n" : "---------------------------\n")) throw failure;
      });
      await execute(f.server, "map q3dm1"); const before = await sectorCounts(f);
      armed = true;
      try {
        await expect(execute(f.server, "killserver")).rejects.toBe(failure);
        expect(await sectorCounts(f)).toEqual(point === "game" ? before : before.map(count => count === 0 ? 0 : 1));
      } finally { armed = false; }
    });
  }

  test("sectorlist rejects nested map callback entry and leaves normal map execution intact", async () => {
    let server: ServerEngine | null = null, checked = false;
    const f = await fixture("baseq3", true, options => options, text => {
      if (text !== "------- Game Initialization -------\n") return;
      const current = server; if (current === null) throw new Error("Missing map owner");
      expect(() => current.commands.executeNow("sectorlist")).toThrow("awaited in source order"); checked = true;
    });
    server = f.server;
    await execute(f.server, "map q3dm1"); expect(checked).toBe(true);
    expect((await sectorCounts(f)).some(count => count > 1)).toBe(true);
  });

  for (const point of ["shutdown", "initialize"]) {
    test(`real fast restart game source control retains ${point === "shutdown" ? "old" : "replacement"} publication`, async () => {
      let armed = false;
      const trace: string[] = [], failure = new CommonError("drop", `restart ${point}`);
      const f = await fixture("baseq3", true, options => options, text => {
        if (!armed) return;
        trace.push(text);
        if (text === (point === "shutdown" ? "==== ShutdownGame ====\n" : "------- Game Initialization -------\n")) throw failure;
      });
      await execute(f.server, "map q3dm1");
      const before = running(f.server);
      f.clock.comFrameTime++;
      armed = true;
      try {
        await expect(execute(f.server, "map_restart 0")).rejects.toBe(failure);
        expect(f.server.state.kind).toBe("initializing");
        const retained = before.world.game;
        expect(retained).not.toBeNull();
        if (!(retained instanceof GameRuntime)) throw new Error("Source control must retain the direct TypeScript owner");
        if (point === "shutdown") {
          expect(retained).toBe(before.game); expect(trace).toEqual(["==== ShutdownGame ====\n"]);
        } else {
          expect(retained).not.toBe(before.game);
          expect(retained.world).toBe(before.game.world);
          expect(trace).toEqual(["==== ShutdownGame ====\n", "ShutdownGame:\n",
            "------------------------------------------------------------\n", "------- Game Initialization -------\n"]);
          expect(() => before.game.runFrame(2000)).toThrow("shut down");
        }
      } finally { armed = false; }
    });
  }

  for (const point of ["banner", "game", "footer", "client"]) {
    test(`ServerEngine preserves CommonError identity and stops shutdown at ${point}`, async () => {
      let armed = false;
      const trace: string[] = [], failure = new CommonError("drop", `source shutdown ${point}`);
      const step = (name: string): void => {
        if (!armed) return;
        trace.push(name);
        if (name === point) throw failure;
      };
      const f = await fixture("baseq3", true, options => ({ ...options, clientLifecycle: { kind: "available",
        mapLoading: async () => undefined, shutdownAllForServerMap: async () => undefined,
        disconnectAfterServerShutdown: async () => { step("client"); } } }), text => {
          if (text === "----- Server Shutdown -----\n") step("banner");
          if (text === "==== ShutdownGame ====\n") step("game");
          if (text === "---------------------------\n") step("footer");
        });
      await execute(f.server, "map q3dm1");
      const retained = f.server.writable.openAppend("retained-control.log", true);
      if (retained === null) throw new Error("Expected real server log");
      armed = true;
      try {
        await expect(f.server.shutdown({ kind: "common-error", reason: "source abort" })).rejects.toBe(failure);
        const order = ["banner", "game", "footer", "client"];
        expect(trace).toEqual(order.slice(0, order.indexOf(point) + 1));
        if (point === "banner" || point === "game") {
          expect(f.server.state.kind).toBe("running");
          expect(() => retained.write("still owned\n")).not.toThrow();
        } else expect(f.server.state.kind).toBe("stopped");
      } finally { armed = false; }
    });
  }

  for (const command of ["map q3dm2", "map_restart 0"]) {
    test(`ServerEngine propagates CommonError through map and operation catches: ${command}`, async () => {
      let armed = false;
      const failure = new CommonError("drop", "source map error");
      const point = command === "map q3dm2" ? "------ Server Initialization ------\n" : "------- Game Initialization -------\n";
      const f = await fixture("baseq3", true, options => options, text => { if (armed && text === point) throw failure; });
      await execute(f.server, "map q3dm1");
      const first = running(f.server);
      const retained = f.server.writable.openAppend("retained-map-control.log", true);
      if (retained === null) throw new Error("Expected retained map log");
      f.clock.comFrameTime = 2000;
      armed = true;
      try {
        await expect(execute(f.server, command)).rejects.toBe(failure);
        expect(f.server.state.kind).toBe(command === "map q3dm2" ? "running" : "initializing");
        expect(f.cvars.get("sv_running")?.integerValue).toBe(1);
        expect(first.world.state).not.toBe("dead");
        expect(() => retained.write("not generically released\n")).not.toThrow();
      } finally { armed = false; }
    });
  }

  for (const operation of ["shutdown", "map"]) {
    test(`ordinary ${operation} failure followed by cleanup CommonError preserves the control object`, async () => {
      let armed = false, ordinaryThrown = false, mapFooters = 0;
      const trace: string[] = [], control = new CommonError("drop", "cleanup source control");
      const ordinary = new Error("ordinary adapter failure");
      const f = await fixture("baseq3", true, options => ({ ...options, clientLifecycle: { kind: "available",
        mapLoading: async () => undefined, shutdownAllForServerMap: async () => undefined,
        disconnectAfterServerShutdown: async () => { if (armed) trace.push("client"); } } }), text => {
          if (!armed) return;
          if ((operation === "shutdown" && text === "----- Server Shutdown -----\n")
            || (operation === "map" && text === "-----------------------------------\n" && ++mapFooters === 2)) { ordinaryThrown = true; trace.push("ordinary"); throw ordinary; }
          if (ordinaryThrown && text === "==== ShutdownGame ====\n") { trace.push("control"); throw control; }
          if (ordinaryThrown && text === "---------------------------\n") trace.push("footer");
        });
      await execute(f.server, "map q3dm1");
      f.clock.comFrameTime = 2000;
      armed = true;
      try {
        const pending = operation === "shutdown" ? f.server.shutdown({ kind: "normal", reason: "managed failure" }) : execute(f.server, "map q3dm2");
        await expect(pending).rejects.toBe(control);
        expect(trace).toEqual(["ordinary", "control"]);
        expect(f.server.state.kind).toBe("running");
      } finally { armed = false; }
    });
  }

  for (const failurePoint of ["none", "banner", "name", "map-loading", "shutdown-all"] satisfies readonly string[]) {
    test(`full-map source order shuts down the old game before diagnostics/client callbacks, failure=${failurePoint}`, async () => {
      const trace: string[] = [];
      let armed = false;
      let oldWorld: ReturnType<typeof running>["world"] | null = null;
      const failure = new Error(`map lifecycle failure at ${failurePoint}`);
      const step = (name: string): void => {
        if (!armed) return;
        trace.push(name);
        if (name === "map-loading" || name === "shutdown-all") {
          trace.push(oldWorld?.game === null ? "old-game-detached" : "old-game-still-live");
        }
        if (name === failurePoint) throw failure;
      };
      const f = await fixture("baseq3", true, options => ({ ...options, clientLifecycle: { kind: "available",
        mapLoading: async () => { step("map-loading"); },
        shutdownAllForServerMap: async () => { step("shutdown-all"); },
        disconnectAfterServerShutdown: async () => undefined } }), text => {
          if (text === "==== ShutdownGame ====\n") step("game-shutdown");
          if (text === "------ Server Initialization ------\n") step("banner");
          if (text === "Server: q3dm2\n") step("name");
        });
      await execute(f.server, "map q3dm1");
      oldWorld = running(f.server).world;
      const oldGame = oldWorld.game;
      if (!(oldGame instanceof GameRuntime)) throw new Error("Expected first map direct TypeScript game");
      const files = f.server.files;
      const log = f.server.writable.openAppend("map-lifecycle.log", true);
      if (log === null) throw new Error("Expected lifecycle log");
      armed = true;
      f.clock.comFrameTime = 2000;
      if (failurePoint === "none") await execute(f.server, "map q3dm2");
      else await expect(execute(f.server, "map q3dm2")).rejects.toBe(failure);
      const expected = ["game-shutdown", "banner", "name", "map-loading", "old-game-detached", "shutdown-all", "old-game-detached"];
      const stop = expected.indexOf(failurePoint);
      expect(trace).toEqual(failurePoint === "none" ? expected : expected.slice(0, stop + (failurePoint === "map-loading" || failurePoint === "shutdown-all" ? 2 : 1)));
      expect(oldWorld.game).toBeNull();
      expect(() => oldGame.consoleCommand(["status"])).toThrow("Game runtime is shut down");
      if (failurePoint !== "none") {
        expect(f.server.state.kind).toBe("stopped");
        expect(f.cvars.get("sv_running")?.integerValue).toBe(0);
        expect(f.server.files).toBe(files);
        expect(() => log.write("common file survives failed map\n")).not.toThrow();
      }
      armed = false;
    });
  }

  test("listen-mode server storage and client lifecycle remain live across full maps and shutdown", async () => {
    const lifecycle: string[] = [];
    const f = await fixture("baseq3", true, options => {
      options.common.cvars.set("dedicated", "0", true);
      return { ...options, clientLifecycle: { kind: "available",
        mapLoading: async () => { lifecycle.push("map-loading"); },
        shutdownAllForServerMap: async () => { lifecycle.push("shutdown-all"); },
        disconnectAfterServerShutdown: async () => { lifecycle.push("disconnect-local"); } } };
    });
    f.cvars.set("sv_killserver", "1", true);
    await f.server.frame(0);
    expect(f.cvars.get("sv_killserver")?.integerValue).toBe(0);
    await execute(f.server, "map q3dm1");
    await f.server.frame(0);
    const first = running(f.server).statics;
    expect(first.snapshotFrames).toBe(4); expect(first.numSnapshotEntities).toBe(2 * 4 * 64);
    f.clock.comFrameTime = 2000; await execute(f.server, "map q3dm2");
    expect(running(f.server).statics).toBe(first);
    expect(first.snapshotFrames).toBe(4); expect(first.numSnapshotEntities).toBe(2 * 4 * 64);
    await execute(f.server, "killserver");
    expect(lifecycle).toEqual(["map-loading", "shutdown-all", "map-loading", "shutdown-all", "disconnect-local"]);
  });

  test("validated map consumes an earlier menu shutdown before replacing the client and server lifetimes", async () => {
    const lifecycle: string[] = [], failure = new Error("Local disconnect failed");
    let rejectShutdown = false;
    const f = await fixture("baseq3", true, options => {
      const cvars = options.common.cvars;
      cvars.set("dedicated", "0", true);
      return { ...options, clientLifecycle: { kind: "available",
        mapLoading: async () => { lifecycle.push(`map-loading:${cvars.get("sv_killserver")?.integerValue}`); },
        shutdownAllForServerMap: async () => { lifecycle.push("shutdown-all"); },
        disconnectAfterServerShutdown: async () => {
          lifecycle.push(`disconnect-local:${cvars.get("sv_killserver")?.integerValue}`);
          if (rejectShutdown) throw failure;
        } } };
    });
    f.cvars.set("sv_killserver", "1", true);
    await execute(f.server, "map");
    expect(f.cvars.get("sv_killserver")?.integerValue).toBe(1);
    expect(f.server.state.kind).toBe("stopped"); expect(lifecycle).toEqual([]);
    await execute(f.server, "map q3dm1");
    expect(f.cvars.get("sv_killserver")?.integerValue).toBe(0);
    expect(lifecycle).toEqual(["map-loading:0", "shutdown-all"]);
    const first = running(f.server);
    await f.server.frame(0);
    expect(running(f.server).world).toBe(first.world);

    f.cvars.set("sv_killserver", "1", true);
    await execute(f.server, "map nonexistent-menu-shutdown-map");
    expect(f.cvars.get("sv_killserver")?.integerValue).toBe(1);
    expect(running(f.server).world).toBe(first.world);
    expect(lifecycle).toEqual(["map-loading:0", "shutdown-all"]);
    await execute(f.server, "map q3dm1");
    expect(f.cvars.get("sv_killserver")?.integerValue).toBe(0);
    expect(first.world.game).toBeNull();
    expect(running(f.server).statics).not.toBe(first.statics);
    expect(lifecycle).toEqual(["map-loading:0", "shutdown-all", "disconnect-local:1", "map-loading:0", "shutdown-all"]);

    f.cvars.set("sv_killserver", "1", true); rejectShutdown = true;
    await expect(execute(f.server, "map q3dm1")).rejects.toBe(failure);
    expect(f.cvars.get("sv_killserver")?.integerValue).toBe(1);
    expect(f.server.state.kind).toBe("stopped");
    expect(lifecycle).toEqual(["map-loading:0", "shutdown-all", "disconnect-local:1", "map-loading:0", "shutdown-all", "disconnect-local:1"]);
  });

  test("common-error shutdown suppresses final packets but still disconnects the local client bridge", async () => {
    const lifecycle: string[] = [];
    const f = await fixture("baseq3", true, options => ({ ...options, clientLifecycle: { kind: "available",
      mapLoading: async () => undefined, shutdownAllForServerMap: async () => undefined,
      disconnectAfterServerShutdown: async () => { lifecycle.push("disconnect-local"); } } }));
    await execute(f.server, "map q3dm1");
    await connect(f);
    const serverClient = running(f.server).statics.clients[0];
    if (serverClient === undefined) throw new Error("Missing connected server client");
    const before = serverClient.reliable.pending().filter(command => command.text === "disconnect").length;
    await f.server.shutdown({ kind: "common-error", reason: "drop" });
    expect(serverClient.reliable.pending().filter(command => command.text === "disconnect")).toHaveLength(before);
    expect(lifecycle).toEqual(["disconnect-local"]);
  });

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: buffered map settles, publishes tracked metadata and admits a real protocol client`, async () => {
      const f = await fixture(product), map = product === "baseq3" ? "q3dm1" : "mpteam1";
      expect(f.server.state.kind).toBe("stopped");
      await execute(f.server, `map ${map}; status`);
      const state = running(f.server), random = new LinuxNativeRandom(2001);
      expect(state.statics.time).toBe(400); expect(state.game.level.time).toBe(300);
      expect(state.world.serverId).toBe(1000); expect(state.world.restartedServerId).toBe(1000);
      expect(state.world.checksumFeedServerId).toBe(1000);
      expect(state.world.checksumFeed).toBe(((random.next() << 16) ^ random.next()) ^ 2002);
      expect(f.cvars.get("nextmap")?.value).toBe("map_restart 0"); expect(f.cvars.get("sv_cheats")?.value).toBe("0");
      expect(f.prints.join("")).toContain(`map: ${map}\n`);
      expect(f.server.files.source(`maps/${map}.bsp`)?.kind).toBe("pk3");
      expect(f.cvars.get("sv_referencedPaks")?.value.length).toBeGreaterThan(0);
      const client = await connect(f);
      expect(client.serverId).toBe(state.world.serverId); expect(client.checksumFeed).toBe(state.world.checksumFeed);
      const before = state.game.pool.clientAt(0).ps.origin;
      client.createUserCommand({ serverTime: state.statics.time + 100, viewAngles: vec3(0, 0, 0), buttons: 0,
        forwardmove: 127, rightmove: 0, upmove: 0 });
      await send(f, client); await f.server.frame(100); (await pumpClient(f, client));
      expect(state.game.pool.clientAt(0).ps.origin).not.toEqual(before);
      expect(client.snapshots.current().serverTime).toBe(state.statics.time);
      const log = join(f.homePath, product, "games.log");
      expect(readFileSync(log, "latin1")).toContain("InitGame:");
      const serverClient = state.statics.clients[0];
      if (serverClient === undefined || serverClient.connection.kind !== "initialized") throw new Error("Missing live channel");
      const beforeShutdown = serverClient.connection.netchan.outgoingSequence;
      await f.server.shutdown({ kind: "normal", reason: "host finished" });
      expect(serverClient.connection.netchan.outgoingSequence).toBe(beforeShutdown + 2);
      expect(serverClient.reliable.pending().some(command => command.text.startsWith("disconnect"))).toBe(false);
      expect(f.server.state.kind).toBe("stopped"); expect(f.cvars.get("sv_running")?.value).toBe("0");
      expect(readFileSync(log, "latin1")).toContain("ShutdownGame:");
    });
  }

  test("fast restart retains map and channel identity; full spawn preserves only the server session", async () => {
    const f = await fixture(); await execute(f.server, "map q3dm1"); const client = await connect(f);
    const first = running(f.server), files = f.server.files, ring = first.statics.snapshotEntities;
    const serverClient = first.statics.clients[0];
    if (serverClient === undefined || serverClient.connection.kind !== "initialized") throw new Error("Missing connected server client");
    const channel = serverClient.connection.netchan, baseline = first.world.baselines, generation = client.gamestateGeneration;
    const checksum = first.world.checksumFeed, initialTime = first.statics.time, initialCommands = serverClient.reliable.sequence;
    f.clock.comFrameTime = 2000; await execute(f.server, "map_restart 0");
    const second = running(f.server);
    expect(second.statics).toBe(first.statics); expect(second.world).toBe(first.world); expect(second.game).not.toBe(first.game);
    expect(second.game.world).toBe(first.game.world); expect(second.game.options.collision).toBe(first.game.options.collision);
    expect(second.world.baselines).toBe(baseline); expect(second.statics.snapshotEntities).toBe(ring); expect(f.server.files).toBe(files);
    expect(second.world.serverId).toBe(2000); expect(second.world.restartedServerId).toBe(1000);
    expect(second.world.checksumFeedServerId).toBe(1000); expect(second.world.checksumFeed).toBe(checksum);
    expect(second.statics.time).toBe(initialTime + 400); expect(serverClient.phase).toBe(ServerClientPhase.Active);
    expect(serverClient.reliable.sequence).toBeGreaterThan(initialCommands);
    expect(serverClient.reliable.pending().some(command => command.text === "map_restart\n")).toBe(true);
    const settledTime = second.statics.time;
    await execute(f.server, "map_restart 0"); expect(second.statics.time).toBe(settledTime);
    await f.server.frame(50); (await pumpClient(f, client));
    expect(client.gamestateGeneration).toBe(generation);
    while (client.lastExecutedServerCommand < client.serverCommandSequence) client.getServerCommand(client.lastExecutedServerCommand + 1);
    expect(client.serverId).toBe(2000);
    f.clock.comFrameTime = 3000; const beforeFull = second.statics.time;
    await execute(f.server, "map q3dm2"); const third = running(f.server);
    expect(third.statics).toBe(first.statics); expect(third.statics.clients[0]).toBe(serverClient);
    expect(serverClient.connection.netchan).toBe(channel); expect(serverClient.phase).toBe(ServerClientPhase.Connected);
    expect(third.world).not.toBe(second.world); expect(third.game.world).not.toBe(second.game.world);
    expect(third.statics.snapshotEntities).not.toBe(ring); expect(f.server.files).not.toBe(files);
    expect(third.statics.time).toBe(beforeFull + 400); expect(third.world.serverId).toBe(3000);
    await send(f, client); await receiveGamestate(f, client, generation);
    expect(client.serverId).toBe(3000);
  });

  test("missing maps leave the game intact; native delay and maxclient latch select fast/full paths", async () => {
    const f = await fixture(); await execute(f.server, "devmap q3dm1");
    const first = running(f.server);
    expect(f.cvars.get("sv_cheats")?.value).toBe("1");
    await execute(f.server, "map no_such_retail_map"); expect(running(f.server).game).toBe(first.game);
    f.clock.comFrameTime = 2000; await execute(f.server, "map_restart 1");
    expect(first.world.restartTime).toBe(first.statics.time + 1000);
    const scheduled = first.world.restartTime;
    await execute(f.server, "map_restart 0"); expect(first.world.restartTime).toBe(scheduled);
    await f.server.frame(1000); expect(running(f.server).game).toBe(first.game);
    await f.server.frame(50); expect(f.server.commands.pendingText).toBe("map_restart 0\n");
    await f.server.commands.executeAsync(); const second = running(f.server);
    expect(second.game).not.toBe(first.game); expect(second.world).toBe(first.world);
    f.clock.comFrameTime = 3000; await execute(f.server, "seta sv_maxclients 3; map_restart 0");
    const third = running(f.server);
    expect(third.statics).toBe(first.statics); expect(third.world).not.toBe(first.world); expect(third.statics.clients).toHaveLength(3);
  });

  test("exec reads writable-home configs in source order and actual nextmap text runs on the following drain", async () => {
    const f = await fixture(); mkdirSync(join(f.homePath, "baseq3"));
    writeFileSync(join(f.homePath, "baseq3", "host.cfg"), "set host_before yes\nmap q3dm1\nset nextmap \"map q3dm2\"\n");
    await execute(f.server, "exec host; set host_after yes");
    expect(f.cvars.get("host_before")?.value).toBe("yes"); expect(f.cvars.get("host_after")?.value).toBe("yes");
    expect(f.cvars.get("nextmap")?.value).toBe("map q3dm2");
    const old = running(f.server); f.clock.comFrameTime = 2000;
    old.game.match.exitLevel();
    expect(f.server.commands.pendingText).toBe("vstr nextmap\n"); expect(running(f.server).game).toBe(old.game);
    await f.server.commands.executeAsync(); expect(f.cvars.get("mapname")?.value).toBe("q3dm2");
    expect(running(f.server).statics).toBe(old.statics);
  });

  test("unsupported default bots fail visibly and close resources; an explicit human-only second start succeeds", async () => {
    const f = await fixture("baseq3", false);
    await expect(execute(f.server, "map q3dm1")).rejects.toThrow("Game bot services unavailable");
    expect(f.server.state.kind).toBe("stopped"); expect(f.cvars.get("sv_running")?.value).toBe("0");
    f.cvars.set("bot_enable", "0", true); await execute(f.server, "map q3dm1");
    const first = running(f.server), commands = f.server.commands, control = f.server.networkControl, output = f.server.output;
    const file = f.server.writable.openAppend("extra.log", true);
    if (file === null) throw new Error("Cannot open actual common log");
    file.write("before shutdown\n"); await execute(f.server, "killserver");
    file.write("after shutdown\n");
    expect(f.server.state.kind).toBe("stopped");
    f.clock.comFrameTime = 3000; await execute(f.server, "map q3dm1");
    expect(running(f.server).statics).not.toBe(first.statics); expect(running(f.server).statics.time).toBe(400);
    expect(f.server.commands).toBe(commands); expect(f.server.networkControl).toBe(control); expect(f.server.output).toBe(output);
    file.write("after restart\n"); file.close();
    expect(readFileSync(join(f.homePath, "baseq3", "extra.log"), "latin1")).toBe("before shutdown\nafter shutdown\nafter restart\n");
  });

  test("native listip immediately reenters the common cvar command inside an awaited outer drain", async () => {
    const f = await fixture(); await execute(f.server, "map q3dm1; addip 192.0.2.5");
    const ready = Promise.withResolvers<void>();
    f.server.commands.registerAsync("inspect-bans", async () => {
      await ready.promise;
      f.server.commands.executeNow("listip");
      expect(f.prints.at(-1)).toContain('"g_banIPs" is:"192.0.2.5 ');
    });
    f.server.commands.append("inspect-bans; set after_inspection yes\n");
    const drain = f.server.commands.executeAsync();
    expect(f.cvars.get("after_inspection")).toBeUndefined();
    ready.resolve(); await drain;
    expect(f.cvars.get("after_inspection")?.value).toBe("yes");
  });

  test("native cvar command flags and combined empty arguments survive real config execution", async () => {
    const f = await fixture();
    await execute(f.server, 'set joined a "" b ""; seta archived ""; sets public visible; setu user visible');
    expect(f.cvars.get("joined")?.value).toBe("a  b "); expect(f.cvars.get("archived")?.value).toBe("");
    for (const [name, flag] of [["archived", CvarFlag.Archive], ["public", CvarFlag.ServerInfo], ["user", CvarFlag.UserInfo]] satisfies readonly (readonly [string, CvarFlag])[]) {
      const value = f.cvars.get(name);
      if (value === undefined) throw new Error(`Cvar command failed to create ${name}`);
      expect(value.flags & flag).toBe(flag);
    }
    await f.server.commands.executeNowAsync("set single one; set another two");
    expect(f.cvars.get("single")?.value).toBe("one; set another two"); expect(f.cvars.get("another")).toBeUndefined();
  });

  test("loose length probes use source random floats and full-load reads preserve the following challenge draws", async () => {
    const f = await fixture();
    mkdirSync(join(f.homePath, "baseq3", "sound"), { recursive: true });
    mkdirSync(join(f.homePath, "baseq3", "maps"));
    writeFileSync(join(f.homePath, "baseq3", "sound", "host-probe.wav"), Uint8Array.of(1, 2, 3));
    writeFileSync(join(f.homePath, "baseq3", "maps", "q3dm1.bsp"), await f.server.files.read("maps/q3dm1.bsp"));
    const before = new LinuxNativeRandom(1);
    expect(f.server.files.fileLength("sound/host-probe.wav")).toBe(3); before.next();
    expect(f.options.random.next()).toBe(before.next());
    await execute(f.server, "map q3dm1");
    const native = new LinuxNativeRandom(2001), expectedFeed = ((native.next() << 16) ^ native.next()) ^ 2002;
    native.next(); // CM_LoadMap reads the selected loose BSP after FS_Restart reseeds the shared generator.
    const state = running(f.server);
    expect(state.world.checksumFeed).toBe(expectedFeed);
    expect(f.server.files.source("maps/q3dm1.bsp")?.kind).toBe("loose");
    expect(f.server.files.fileLength("sound/host-probe.wav")).toBe(3); native.next();
    const challenge = (native.next() << 16) ^ native.next() ^ state.statics.time;
    await f.server.packetEvent({ kind: "loopback" }, encodeConnectionlessText("getchallenge"));
    const packet = f.loopback.poll("client");
    if (packet === null) throw new Error("Missing actual challenge response");
    const response = decodeConnectionless(packet.payload, "client");
    expect(response.command).toBe("challengeResponse"); expect(response.arguments[0]).toBe(String(challenge));
    expect(f.options.random.next()).toBe(native.next());
  });

  test("sp command setup uses native game-type, warmup, maxclient and cheat changes without supplying fake capabilities", async () => {
    const f = await fixture();
    await execute(f.server, "spdevmap q3dm1");
    expect(f.cvars.get("g_gametype")?.value).toBe("2"); expect(f.cvars.get("g_doWarmup")?.value).toBe("0");
    expect(running(f.server).statics.clients).toHaveLength(8); expect(f.cvars.get("sv_cheats")?.value).toBe("0");
    expect(f.server.options.bots.kind).toBe("unavailable");
    f.clock.comFrameTime = 2000; await execute(f.server, "map q3dm2");
    expect(f.cvars.get("g_gametype")?.value).toBe("0"); expect(f.cvars.get("sv_cheats")?.value).toBe("0");
  });

  test("independent engines admit independent loopback peers and advance no shared session or game state", async () => {
    const [first, second] = await Promise.all([fixture(), fixture()]);
    await Promise.all([execute(first.server, "map q3dm1"), execute(second.server, "map q3dm1")]);
    const [one, two] = await Promise.all([connect(first), connect(second)]);
    const a = running(first.server), b = running(second.server), stationary = b.game.pool.clientAt(0).ps.origin;
    expect(a.statics).not.toBe(b.statics); expect(a.world).not.toBe(b.world); expect(a.game.world).not.toBe(b.game.world);
    expect(first.server.networkControl).not.toBe(second.server.networkControl);
    one.createUserCommand({ serverTime: a.statics.time + 100, viewAngles: vec3(0, 0, 0), buttons: 0,
      forwardmove: 127, rightmove: 0, upmove: 0 });
    await send(first, one); await first.server.frame(100); (await pumpClient(first, one));
    expect(a.statics.time).toBe(b.statics.time + 100); expect(b.game.pool.clientAt(0).ps.origin).toEqual(stationary);
    expect(two.snapshots.current().serverTime).toBe(b.statics.time);
    await first.server.shutdown({ kind: "normal", reason: "one engine only" }); expect(second.server.running).toBe(true);
  });

  test("an awaited frame rejects overlapping work, rejects escaped ownership and releases its gate after failure", async () => {
    const ready = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), escape = Promise.withResolvers<void>();
    const owned: { host: ServerEngine | null; escaped: Promise<void> | null } = { host: null, escaped: null };
    const f = await fixture("baseq3", true, options => ({ ...options, network: { ...options.network,
      sleep: async () => {
        const host = owned.host;
        if (host === null) throw new Error("Sleep before engine construction completed");
        owned.escaped = escape.promise.then(() => host.frame(50)); entered.resolve(); await ready.promise;
      } } }));
    owned.host = f.server;
    await execute(f.server, "map q3dm1"); const original = running(f.server);
    const pending = f.server.frame(0); await entered.promise;
    await expect(f.server.frame(50)).rejects.toThrow("awaited in source order");
    await expect(f.server.shutdown({ kind: "normal", reason: "overlap" })).rejects.toThrow("awaited in source order");
    await expect(f.server.packetEvent({ kind: "loopback" }, encodeConnectionlessText("getinfo x"))).rejects.toThrow("awaited in source order");
    expect(() => f.server.commands.executeNow("set outside blocked")).toThrow("awaited in source order");
    const failure = new Error("sleep dependency failed"); ready.reject(failure);
    await expect(pending).rejects.toBe(failure);
    expect(running(f.server).game).toBe(original.game);
    if (owned.escaped === null) throw new Error("Missing escaped operation continuation");
    escape.resolve(); await expect(owned.escaped).rejects.toThrow("closed server operation");
    await f.server.frame(50); expect(running(f.server).statics.time).toBe(450);
  });

  test("actual RCON killserver awaits nested master resolution, drops the reset redirect and preserves common logs", async () => {
    const entered = Promise.withResolvers<void>(), resolved = Promise.withResolvers<Ipv4Address | null>();
    const f = await fixture("baseq3", true, options => {
      options.common.cvars.set("dedicated", "2", true);
      return { ...options, network: { ...options.network,
        resolveAddress: async hostname => { expect(hostname).toBe("master.test.invalid"); entered.resolve(); return await resolved.promise; } } };
    });
    await execute(f.server, "map q3dm1");
    f.cvars.set("rconPassword", "host-secret", true); f.cvars.set("sv_master1", "master.test.invalid", true);
    const log = f.server.writable.openAppend("rcon.log", true);
    if (log === null) throw new Error("Cannot open actual RCON lifetime log");
    const pending = f.server.packetEvent({ kind: "loopback" }, encodeConnectionlessText("rcon host-secret killserver"));
    await entered.promise;
    expect(f.server.running).toBe(true); expect(f.server.output.redirecting).toBe(true);
    log.write("still owned during DNS\n");
    await expect(f.server.frame(50)).rejects.toThrow("awaited in source order");
    resolved.resolve(null); await pending;
    expect(f.server.state.kind).toBe("stopped"); expect(f.server.output.redirecting).toBe(false);
    expect(f.server.networkControl.redirectAddress).toEqual({ kind: "bot" });
    expect(() => log.write("common file survives RCON shutdown\n")).not.toThrow();
    expect(homeDescriptors(f.homePath).some(fd => fd.path.endsWith("/games.log"))).toBe(false);
    expect(f.loopback.poll("client")).toBeNull();
    await execute(f.server, "map q3dm1"); expect(f.server.running).toBe(true);
  });

  test("an unawaited RCON map cannot publish after its parent closes or release ownership before cleanup", async () => {
    const f = await fixture(); await execute(f.server, "map q3dm1");
    f.cvars.set("rconPassword", "host-secret", true);
    const original = running(f.server);
    const gameInitializations = f.prints.filter(text => text === "------- Game Initialization -------\n").length;
    const log = f.server.writable.openAppend("escaped-map.log", true);
    if (log === null) throw new Error("Missing real pending-map log");
    const opened = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const createTracked = VirtualFileSystem.createTracked.bind(VirtualFileSystem);
    const child: { result: Promise<number> | null } = { result: null };
    VirtualFileSystem.createTracked = options => {
      const files = createTracked(options), startup = files.startup.bind(files);
      files.startup = async () => { opened.resolve(); await gate.promise; await startup(); };
      return files;
    };
    f.server.commands.register("escape-map", () => { child.result = f.server.commands.executeNowAsync("map q3dm2"); });
    try {
      const parent = f.server.packetEvent({ kind: "loopback" }, encodeConnectionlessText("rcon host-secret escape-map"));
      const parentRejected = expect(parent).rejects.toThrow("Nested command execution must be awaited");
      await opened.promise; await parentRejected;
      expect(f.server.state.kind).toBe("stopped"); expect(original.world.game).toBeNull();
      expect(f.cvars.get("mapname")?.value).toBe("q3dm1");
      expect(() => f.server.files).toThrow("Filesystem call made without initialization");
      await expect(f.server.frame(50)).rejects.toThrow("awaited in source order");
      await expect(f.server.shutdown({ kind: "normal", reason: "must await child cleanup" })).rejects.toThrow("awaited in source order");
      await expect(f.server.commands.executeNowAsync("map q3dm1")).rejects.toThrow("overlapping command execution");
      if (child.result === null) throw new Error("Missing actual escaped map command");
      gate.resolve(); await expect(child.result).rejects.toThrow("closed server operation");
      expect(f.server.state.kind).toBe("stopped");
      expect(f.server.files.initialized).toBe(true);
      expect(f.cvars.get("mapname")?.value).toBe("q3dm1"); expect(f.cvars.get("sv_running")?.value).toBe("0");
      expect(() => log.write("common file survives escaped map\n")).not.toThrow();
      expect(f.prints.filter(text => text === "------- Game Initialization -------\n")).toHaveLength(gameInitializations);
      VirtualFileSystem.createTracked = createTracked;
      await f.server.disposeResources(); f.options.common.close();
      expect(homeDescriptors(f.homePath)).toEqual([]); expect(() => log.write("closed\n")).toThrow("closed log");
    } finally {
      VirtualFileSystem.createTracked = createTracked; gate.resolve();
      if (child.result !== null) await expect(child.result).rejects.toThrow("closed server operation");
    }
  });

  test("a parent closing after filesystem remount prevents game creation and keeps cleanup ahead of second startup", async () => {
    const f = await fixture(); await execute(f.server, "map q3dm1"); f.cvars.set("rconPassword", "host-secret", true);
    const original = running(f.server), originalFiles = f.server.files;
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const child: { result: Promise<number> | null } = { result: null };
    const common = f.options.common, finishRestart = common.finishFileSystemRestart.bind(common);
    common.finishFileSystemRestart = async (checksumFeed, assertCurrentOperation) => {
      await finishRestart(checksumFeed, assertCurrentOperation);
      entered.resolve(); await gate.promise;
    };
    f.server.commands.registerAsync("escape-read", async () => {
      child.result = f.server.commands.executeNowAsync("map q3dm2"); await entered.promise;
    });
    try {
      await expect(f.server.packetEvent({ kind: "loopback" }, encodeConnectionlessText("rcon host-secret escape-read")))
        .rejects.toThrow("Nested command execution must be awaited");
      expect(f.server.files).not.toBe(originalFiles); expect(f.server.state.kind).toBe("stopped");
      await expect(f.server.frame(50)).rejects.toThrow("awaited in source order");
      if (child.result === null) throw new Error("Missing actual filesystem restart child");
      gate.resolve(); await expect(child.result).rejects.toThrow("closed server operation");
      expect(f.cvars.get("mapname")?.value).toBe("q3dm1"); expect(original.world.game).toBeNull();
      common.finishFileSystemRestart = finishRestart;
      f.clock.comFrameTime = 3000; await execute(f.server, "map q3dm1");
      expect(running(f.server).statics).not.toBe(original.statics); expect(running(f.server).world.serverId).toBe(3000);
    } finally {
      common.finishFileSystemRestart = finishRestart; gate.resolve();
      if (child.result !== null) await expect(child.result).rejects.toThrow("closed server operation");
    }
  });

  test("a synchronously completed fast transition still cleans up when its unawaited RCON command parent rejects", async () => {
    const f = await fixture(); await execute(f.server, "map q3dm1"); f.cvars.set("rconPassword", "host-secret", true);
    const original = running(f.server); f.clock.comFrameTime = 2000;
    type CommandOutcome = { readonly kind: "completed"; readonly count: number } | { readonly kind: "failed"; readonly error: unknown };
    const child: { result: Promise<CommandOutcome> | null } = { result: null };
    f.server.commands.register("escape-fast", () => {
      child.result = f.server.commands.executeNowAsync("map_restart 0").then(
        count => ({ kind: "completed", count } satisfies CommandOutcome),
        (error: unknown) => ({ kind: "failed", error } satisfies CommandOutcome));
    });
    await expect(f.server.packetEvent({ kind: "loopback" }, encodeConnectionlessText("rcon host-secret escape-fast")))
      .rejects.toThrow("Nested command execution must be awaited");
    if (child.result === null) throw new Error("Missing actual fast restart child");
    const result = await child.result;
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed" || !(result.error instanceof Error)) throw new Error("Expected rejected closed command ownership");
    expect(result.error.message).toContain("closed");
    expect(f.server.state.kind).toBe("stopped"); expect(original.world.game).toBeNull();
    f.clock.comFrameTime = 3000; await execute(f.server, "map q3dm1");
    expect(running(f.server).statics).not.toBe(original.statics); expect(running(f.server).statics.time).toBe(400);
  });

  test("actual localhost UDP queries and RCON map replacement use the borrowed socket", async () => {
    const socket = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    const peer = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    try {
      const f = await fixture("baseq3", true, options => ({ ...options, network: { ...options.network, udp: socket } }));
      await execute(f.server, "map q3dm1");
      async function request(text: string): Promise<void> {
        expect(peer.send(socket.address, encodeConnectionlessText(text))).toBe(true);
        const packet = await receiveUdp(socket); await f.server.packetEvent(packet.from, packet.payload);
      }
      await request("getinfo own-test");
      const info = decodeConnectionless((await receiveUdp(peer)).payload, "client");
      expect(info.command).toBe("infoResponse"); expect(info.line).toContain("infoResponse");
      f.cvars.set("rconPassword", "host-secret", true); f.clock.comFrameTime = 2000;
      const first = running(f.server);
      await request("rcon host-secret map q3dm2");
      expect(running(f.server).statics).toBe(first.statics); expect(running(f.server).world).not.toBe(first.world);
      expect(f.cvars.get("mapname")?.value).toBe("q3dm2");
      expect(decodeConnectionless((await receiveUdp(peer)).payload, "client").command).toBe("print");
      await f.server.shutdown({ kind: "normal", reason: "borrowed socket remains open" });
      expect(socket.send(peer.address, Uint8Array.of(7))).toBe(true);
      // RCON load diagnostics may already occupy the receive queue.
      for (let count = 0; count < 16; count++) {
        const packet = await receiveUdp(peer);
        if (packet.payload.length === 1) { expect(packet.payload).toEqual(Uint8Array.of(7)); return; }
      }
      throw new Error("Borrowed transport did not deliver after shutdown");
    } finally { socket.close(); peer.close(); }
  });

  test("an actual remote protocol client receives both final message passes before the host releases its session", async () => {
    const socket = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    const peer = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    try {
      const f = await fixture("baseq3", true, options => ({ ...options, network: { ...options.network, udp: socket } }));
      await execute(f.server, "map q3dm1");
      async function submit(bytes: Uint8Array): Promise<void> {
        expect(peer.send(socket.address, bytes)).toBe(true);
        const packet = await receiveUdp(socket); await f.server.packetEvent(packet.from, packet.payload);
      }
      await submit(encodeConnectionlessText("getchallenge"));
      const response = decodeConnectionless((await receiveUdp(peer)).payload, "client");
      expect(response.command).toBe("challengeResponse");
      const challengeText = response.arguments[0];
      if (challengeText === undefined) throw new Error("Missing source challenge number");
      const challenge = Number(challengeText), qport = 891;
      await submit(encodeConnect(`\\protocol\\68\\qport\\${qport}\\challenge\\${challenge}\\name\\UdpPeer\\rate\\25000\\snaps\\20`));
      expect(decodeConnectionless((await receiveUdp(peer)).payload, "client").command).toBe("connectResponse");
      const client = createProtocolClientSession({ product: "baseq3", mode: { kind: "network", challenge, qport }, cvars: new CvarRegistry() });
      for (const packet of transmitProtocolClient(client, f.clock.wallTime, 0, true)) await submit(packet);
      for (let count = 0; count < 32 && client.gamestateGeneration === 0; count++) {
        (await client.receiveDatagram((await receiveUdp(peer)).payload));
        if (client.gamestateGeneration === 0) await f.server.frame(50);
      }
      expect(client.gamestateGeneration).toBe(1); client.prime(1); client.setUserCmdValue(Weapon.WP_MACHINEGUN, 1);
      const state = running(f.server), serverClient = state.statics.clients[0];
      if (serverClient === undefined || serverClient.connection.kind !== "initialized") throw new Error("Missing remote channel");
      expect(serverClient.connection.address).toEqual(peer.address);
      client.createUserCommand({ serverTime: state.statics.time, viewAngles: vec3(0, 0, 0), buttons: 0,
        forwardmove: 0, rightmove: 0, upmove: 0 });
      for (const packet of transmitProtocolClient(client, f.clock.wallTime, 0, true)) await submit(packet);
      expect(serverClient.phase).toBe(ServerClientPhase.Active);
      await f.server.frame(50); (await client.receiveDatagram((await receiveUdp(peer)).payload));
      const commandsBefore = serverClient.reliable.sequence, packetsBefore = serverClient.connection.netchan.outgoingSequence;
      const snapshotBefore = client.snapshots.current().number;
      await f.server.shutdown({ kind: "normal", reason: "remote finished" });
      expect(serverClient.reliable.pending().filter(command => command.sequence > commandsBefore).map(command => command.text))
        .toEqual(['print "remote finished"', "disconnect", 'print "remote finished"', "disconnect"]);
      expect(serverClient.connection.netchan.outgoingSequence).toBe(packetsBefore + 2);
      (await client.receiveDatagram((await receiveUdp(peer)).payload)); (await client.receiveDatagram((await receiveUdp(peer)).payload));
      expect(client.snapshots.current().number).toBe(snapshotBefore + 2);
      expect(f.server.state.kind).toBe("stopped");
    } finally { socket.close(); peer.close(); }
  });

  test("a real client download descriptor survives a full map and closes on shutdown", async () => {
    const f = await fixture(); await execute(f.server, "map q3dm1"); const client = await connect(f);
    writeFileSync(join(f.homePath, "baseq3", "host-download.bin"), new Uint8Array(32000).fill(37));
    f.cvars.set("sv_allowDownload", "1", true);
    client.addReliableCommand("download baseq3/host-download.bin"); await send(f, client); await f.server.frame(50);
    const state = running(f.server), serverClient = state.statics.clients[0];
    if (serverClient === undefined || serverClient.download.file === null) throw new Error("Actual client command did not open a download");
    const descriptor = serverClient.download.file;
    expect(descriptor.size).toBe(32000); expect(serverClient.download.count).toBeGreaterThan(0);
    f.clock.comFrameTime = 2000; await execute(f.server, "map q3dm2");
    expect(serverClient.download.file).toBe(descriptor); expect(descriptor.read(new Uint8Array())).toBe(0);
    await f.server.shutdown({ kind: "normal", reason: "download owner finished" });
    expect(serverClient.download.file).toBeNull(); expect(() => descriptor.read(new Uint8Array(1))).toThrow("closed");
    // Client download consumption is a separate capability; no successful client file installation is claimed.
  });

  test("default.cfg validation retains a source-aborted replacement until common cleanup; mod directories queue q3config", async () => {
    const f = await fixture(); mkdirSync(join(f.homePath, "baseq3"));
    writeFileSync(join(f.homePath, "baseq3", "q3config.cfg"), "set queued_config yes\n");
    await execute(f.server, "map q3dm1");
    f.cvars.set("fs_game", "baseq3", true); f.clock.comFrameTime = 2000;
    await execute(f.server, "map q3dm2; set command_after_map yes");
    expect(f.cvars.get("queued_config")?.value).toBe("yes"); expect(f.cvars.get("command_after_map")?.value).toBe("yes");
    f.cvars.set("fs_game", "authored-mod", true);
    await execute(f.server, "map q3dm1");
    expect(f.server.state.kind).toBe("running");
    expect(f.server.writable.rootPath).toBe(join(f.homePath, "authored-mod"));
    f.cvars.set("fs_game", "", true); await execute(f.server, "map q3dm1");
    const log = f.server.writable.openAppend("failed-restart.log", true);
    if (log === null) throw new Error("Missing actual failure cleanup log");
    writeFileSync(join(f.homePath, "baseq3", "default.cfg"), "");
    let failure: unknown = null;
    try { await execute(f.server, "map q3dm2"); } catch (error) { failure = error; }
    if (!(failure instanceof CommonError)) throw new Error("Expected source filesystem common error");
    expect(failure.code).toBe("fatal"); expect(failure.message).toBe("Couldn't load default.cfg");
    expect(f.server.state.kind).toBe("initializing"); expect(() => log.write("common file survives failed restart\n")).not.toThrow();
    await f.server.disposeResources();
    expect(f.server.state.kind).toBe("disposed");
    expect(() => log.write("common file survives server disposal\n")).not.toThrow();
    const adopted: CommonConsole[] = [];
    try {
      await expect(CommonConsole.open({ roots: f.options.common.roots, random: f.options.random, startup: new StartupCommands(""),
        build: { kind: "dedicated" }, platformPrint: text => { f.prints.push(text); },
        resolveCommand: () => undefined, assertCommandEntry: () => {}, assertOwnerEntry: () => {} },
        value => { adopted.push(value); return undefined; })).rejects.toThrow("Couldn't load default.cfg");
    } finally { for (const common of adopted) common.close(); }
    f.options.common.close();
    expect(homeDescriptors(f.homePath)).toEqual([]);
    expect(() => log.write("closed\n")).toThrow("closed");
  });

  test("shutdown diagnostic failure closes the game log and session while common files survive", async () => {
    const failure = new Error("Output device failed"); let failPrint = false;
    const f = await fixture("baseq3", true, options => options, () => { if (failPrint) throw failure; });
    await execute(f.server, "map q3dm1");
    const log = f.server.writable.openAppend("output-failure.log", true);
    if (log === null) throw new Error("Missing actual output failure log");
    failPrint = true;
    await expect(f.server.shutdown({ kind: "normal", reason: "output failure" })).rejects.toBeInstanceOf(AggregateError);
    expect(f.server.state.kind).toBe("stopped"); expect(() => log.write("common file survives output failure\n")).not.toThrow();
    expect(homeDescriptors(f.homePath).some(fd => fd.path.endsWith("/games.log"))).toBe(false);
    failPrint = false; await execute(f.server, "map q3dm1"); expect(f.server.running).toBe(true);
  });

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: common console and manual logs survive maps and server teardown while the real game log closes`, async () => {
      const f = await fixture(product), common = f.options.common;
      const firstMap = product === "baseq3" ? "q3dm1" : "mpteam1", secondMap = product === "baseq3" ? "q3dm2" : "mpteam2";
      await execute(f.server, `set logfile 2\nset g_logSync 1\nmap ${firstMap}`);
      expect(f.server.writable).toBe(common.files.writable);
      const path = join(f.homePath, product, "qconsole.log"), gamePath = join(f.homePath, product, "games.log");
      const extra = f.server.writable.openAppend("common-extra.log", true);
      if (extra === null) throw new Error("Missing real common log");
      const before = readFileSync(path, "latin1"); expect(before).toContain(`Server: ${firstMap}\n`);
      expect(homeDescriptors(f.homePath).some(fd => fd.path === gamePath)).toBe(true);
      const commandOwner = f.server.commands, outputOwner = f.server.output, fileOwner = common.files, firstFiles = f.server.files;
      await execute(f.server, `map ${secondMap}\n`);
      expect(common.files).toBe(fileOwner); expect(f.server.files).not.toBe(firstFiles);
      expect(f.server.writable).toBe(fileOwner.writable);
      extra.write("after map\n");
      expect(readFileSync(gamePath, "latin1").match(/ShutdownGame:/g)).toHaveLength(1);
      expect(homeDescriptors(f.homePath).filter(fd => fd.path === gamePath)).toHaveLength(1);
      await execute(f.server, "killserver\necho common still open\n");
      expect(f.server.state.kind).toBe("stopped"); extra.write("after killserver\n");
      expect(readFileSync(path, "latin1")).toContain("common still open \n");
      expect(homeDescriptors(f.homePath).some(fd => fd.path === gamePath)).toBe(false);
      expect(readFileSync(gamePath, "latin1").match(/ShutdownGame:/g)).toHaveLength(2);
      await execute(f.server, `map ${firstMap}\n`);
      expect(f.server.commands).toBe(commandOwner); expect(f.server.commands).toBe(common.commands);
      expect(f.server.output).toBe(outputOwner); expect(f.server.output).toBe(common.output);
      const after = readFileSync(path, "latin1"); expect(after.startsWith(before)).toBe(true); expect(after).toContain(`Server: ${secondMap}\n`);
      expect(after.match(/logfile opened on/g)).toHaveLength(1);
      expect(homeDescriptors(f.homePath).some(fd => fd.path === gamePath)).toBe(true);
      await f.server.disposeResources(); extra.write("after disposal\n");
      expect(homeDescriptors(f.homePath).some(fd => fd.path === gamePath)).toBe(false);
      expect(readFileSync(gamePath, "latin1").match(/ShutdownGame:/g)).toHaveLength(2);
      common.output.print("common survives disposal\n");
      expect(readFileSync(path, "latin1")).toContain("common survives disposal\n");
      expect(readFileSync(join(f.homePath, product, "common-extra.log"), "latin1")).toBe("after map\nafter killserver\nafter disposal\n");
      common.close(); expect(homeDescriptors(f.homePath)).toEqual([]);
      expect(() => extra.write("closed\n")).toThrow("closed log");
    });
  }
});
