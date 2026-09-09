import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonError } from "../src/core/common-error.ts";
import { ClientKeys } from "../src/engine/client-keys.ts";
import { CommonFrameDriver } from "../src/engine/common-frame.ts";
import type { CommonClientRuntime } from "../src/engine/common-frame.ts";
import type { CommonSystemEvent } from "../src/engine/common-events.ts";
import { ServerEngine } from "../src/engine/server-engine.ts";
import { LanAddresses } from "../src/platform/lan.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { createProtocolClientSession, transmitProtocolClient } from "../tools/client-protocol-fixture.ts";
import { ClientInput, registerClientInputCvars } from "../src/engine/client-input.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import { decodeClientMessage } from "../src/protocol/client-message.ts";
import { Netchannel, xorClientMessage } from "../src/protocol/netchan.ts";
import { CommandButtons } from "../src/shared/player-state.ts";
import type { Product } from "../src/shared/definitions.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";

async function fixture(product: Product = "baseq3", prime = true) {
  const cvars = new CvarRegistry(), prints: string[] = [], calls: string[] = [], graphs: number[] = [];
  const commands = new CommandBuffer({ resolveFallback: () => ({ kind: "sync", handler: context => { calls.push(`unknown:${context.argv[0]}`); } }) });
  const session = createProtocolClientSession({ product, cvars, mode: { kind: "network", challenge: 23, qport: 27962 } });
  let keyCatchers = 0, anyKeyDown = 0, delta = vec3(0, 0, 0), ui: (dx: number, dy: number) => Promise<void> = async (dx, dy) => { calls.push(`ui:${dx},${dy}`); };
  const input = new ClientInput({ commands, cvars, print: text => { prints.push(text); },
    readKeys: () => readKeys(), readDeltaAngles: () => delta,
    mouseToUi: (dx, dy) => ui(dx, dy), mouseToCgame: async (dx, dy) => { calls.push(`cgame:${dx},${dy}`); },
    debugGraph: (value, color) => { graphs.push(value, color); },
  });
  let readKeys = () => ({ keyCatchers, anyKeyDown });
  input.initializeCommands();
  for (const group of ["angle-speeds", "movement", "mouse"] satisfies readonly ("angle-speeds" | "movement" | "mouse")[]) registerClientInputCvars(cvars, group);
  async function gamestate() {
    const number = session.serverMessageSequence + 1;
    await session.receiveServerMessage(number, encodeServerMessage(0, [{ kind: "gamestate", commandSequence: 0, clientNumber: 0, checksumFeed: 0,
      entries: [{ kind: "configstring", index: 1, value: `\\sv_serverid\\1\\sv_pure\\0\\fs_game\\${product === "missionpack" ? "missionpack" : ""}` }] }],
    { product, messageNumber: number, reliableSequence: 0, serverCommandSequence: 0, parseEntitiesNumber: 0, baseline: () => null, history: () => null }));
    input.clearActiveState(); session.prime(session.gamestateGeneration); session.setUserCmdValue(2, 1);
  }
  if (prime) await gamestate();
  function frame(time: number, clientTime = 16, serverTime = time) {
    const number = input.createNewCommands({ kind: "primed", session, comFrameTime: time, clientFrameTime: clientTime, serverTime });
    if (number === null) throw new Error("Expected a canonical command number");
    const command = session.commands.read(number); if (command === null) throw new Error("Expected actual session history");
    return command;
  }
  return { input, cvars, commands, session, calls, graphs, prints, gamestate, frame,
    useKeys: (keys: ClientKeys) => { readKeys = () => keys.inputState; },
    keys: (catchers: number, any: number) => { keyCatchers = catchers; anyKeyDown = any; },
    delta: (value: Vec3) => { delta = value; }, ui: (callback: (dx: number, dy: number) => Promise<void>) => { ui = callback; } };
}

describe("canonical source input", () => {
  test("SendCmd retains choked movement, sends it on the next packet, and respects pause/demo gates", async () => {
    const f = await fixture(), cls = f.session.lifecycle.clientStatic, clc = f.session.lifecycle.clientConnection;
    const packets: Uint8Array[] = [], prints: string[] = [];
    f.cvars.register("cl_maxpackets", "30", CvarFlag.Archive);
    f.cvars.set("cl_showSend", "1", true); f.cvars.set("cl_packetdup", "0", true);
    const send = (time: number): void => {
      cls.realtime = time; cls.frameTime = 16;
      f.input.sendCommand({ session: f.session, comFrameTime: time,
        remoteAddress: { kind: "ipv4", host: [203, 0, 113, 1], port: 27960 }, lan: new LanAddresses([]),
        delivery: { send: bytes => { packets.push(bytes); }, print: text => { prints.push(text); }, trace: () => {} } });
    };
    f.commands.executeNow("+forward 1 1");
    send(16); expect(f.session.commands.currentNumber).toBe(1); expect(packets).toHaveLength(0); expect(prints).toEqual([". "]);
    send(34); expect(f.session.commands.currentNumber).toBe(2); expect(packets).toHaveLength(1);
    const bytes = packets[0]; if (bytes === undefined) throw new Error("Expected sent movement");
    const packet = new Netchannel("server", 27962).receive(bytes);
    if (packet.kind !== "accepted") throw new Error("Expected admitted packet");
    const message = decodeClientMessage(xorClientMessage(packet.payload, 23, () => ""), { checksumFeed: 0, serverCommand: () => "",
      reliableSequence: 0, lastClientCommand: 0, lastUserCommandTime: -1 });
    if (message.kind !== "accepted") throw new Error("Expected decoded movement");
    expect(message.movement?.commands.map(command => command.forwardmove)).toEqual([119, 127]);
    expect(prints[1]).toBe("(2)");
    for (const name of ["sv_running", "sv_paused", "cl_paused"]) f.cvars.set(name, "1", true);
    send(50); expect(f.session.commands.currentNumber).toBe(2); expect(packets).toHaveLength(1);
    f.cvars.set("sv_running", "0", true); clc.demoPlaying = true;
    send(66); expect(f.session.commands.currentNumber).toBe(3); expect(packets).toHaveLength(1); expect(prints.at(-1)).toBe(". ");
    clc.demoPlaying = false; cls.phase = "cinematic";
    send(82); expect(f.session.commands.currentNumber).toBe(4); expect(packets).toHaveLength(1);
    cls.phase = "disconnected"; send(98); expect(f.session.commands.currentNumber).toBe(4);
  });
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: native signed invalid axes are exact source drops without input publication`, async () => {
      const f = await fixture(product);
      for (const axis of [-2147483648, -1, 6, 2147483647]) {
        let failure: unknown;
        try { f.input.joystickEvent(axis, 10, 20); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(CommonError);
        if (!(failure instanceof CommonError)) throw new Error("Expected source Com_Error");
        expect(failure.code).toBe("drop"); expect(failure.message).toBe(`CL_JoystickEvent: bad axis ${axis}`);
        expect(f.session.commands.currentNumber).toBe(0);
      }
      expect(f.frame(100).forwardmove).toBe(0); expect(f.prints).toEqual([]);
    });
    test(`${product}: joystick native argument boundaries do not become source drops`, async () => {
      const f = await fixture(product);
      for (const axis of [NaN, Infinity, -Infinity, 0.5, -2147483649, 2147483648]) {
        expect(() => f.input.joystickEvent(axis, 0, 0)).toThrow("Joystick axis requires int32");
      }
      for (const value of [NaN, Infinity, 0.5, -2147483649, 2147483648]) {
        expect(() => f.input.joystickEvent(1, value, 0)).toThrow(RangeError);
        expect(() => f.input.joystickEvent(1, 0, value)).toThrow(RangeError);
      }
      expect(f.frame(100).forwardmove).toBe(0);
    });
    test(`${product}: real keys dispatch through buffered commands into admitted session history`, async () => {
      const f = await fixture(product);
      const keys = new ClientKeys({ commands: f.commands, cvars: f.cvars, print: text => { f.prints.push(text); }, host: {
        readConnection: () => ({ kind: f.session.lifecycle.clientStatic.phase, demoPlayback: false }),
        readUi: () => null, readCgame: () => null, assertCurrentOperation: () => { f.session.lifecycle.assertCurrentOperation(); },
        disconnect: async () => { throw new Error("Unexpected key disconnect"); },
        stopAllSounds: () => { throw new Error("Unexpected key sound stop"); },
        addReliableCommand: () => { throw new Error("Unexpected key reliable command"); },
        toggleConsole: async () => { throw new Error("Unexpected key console toggle"); },
        updateScreen: async () => { throw new Error("Unexpected key screen update"); },
        consoleScroll: () => { throw new Error("Unexpected key console scroll"); },
        readConsoleWidth: () => 78, clipboard: { kind: "native-unix-unavailable" },
      } });
      keys.initializeCommands(); f.useKeys(keys);
      expect(f.session.gamestateGeneration).toBe(1); expect(f.session.lifecycle.clientStatic.phase).toBe("primed");
      f.commands.append('bind w "+forward"\n'); await f.commands.executeAsync();
      await keys.keyEvent(119, true, 0); expect(f.session.commands.currentNumber).toBe(0);
      await f.commands.executeAsync(); const first = f.frame(101, 100);
      expect(first.forwardmove).toBe(127); expect(first.buttons & CommandButtons.ANY).toBe(CommandButtons.ANY);
      await keys.keyEvent(119, false, 151); await f.commands.executeAsync();
      expect(f.frame(201, 100).forwardmove).toBe(63); expect(f.frame(301, 100).forwardmove).toBe(0);
      expect(keys.inputState.anyKeyDown).toBe(0); expect(f.session.commands.currentNumber).toBe(3);
    });
    test(`${product}: actual common driver recovers from joystick source drop and runs another frame`, async () => {
      const f = await fixture(product), home = mkdtempSync(join(tmpdir(), "q3-input-drop-"));
      const dataPath = join(home, "data"), trace: string[] = [], events: CommonSystemEvent[] = [];
      mkdirSync(join(dataPath, "baseq3"), { recursive: true });
      writeFileSync(join(dataPath, "baseq3", "default.cfg"), "\n");
      writeFileSync(join(dataPath, "baseq3", "productid.txt"), SOURCE_PRODUCT_ID);
      let time = 1000, closed = false;
      const runtime: CommonClientRuntime = {
        initializeInput: () => { trace.push("input-init"); }, restartInput: () => { trace.push("input-restart"); },
        frameTimings: { frontEndMsec: 0, backEndMsec: 0 },
        needCd: { kind: "absent" }, initialize: async () => {}, shutdown: async () => { trace.push("shutdown"); },
        disposeResources: async () => { trace.push("dispose"); }, frame: async () => {}, packetEvent: async () => {},
        keyEvent: async () => {}, characterEvent: async () => {}, mouseEvent: (x, y, t) => f.input.mouseEvent(x, y, t),
        joystickEvent: async (axis, value, t) => { f.input.joystickEvent(axis, value, t); },
        disconnect: async show => { trace.push(`disconnect:${show}`); }, flushMemory: async () => { trace.push("flush"); },
        queueDefaultStartup: () => {}, startHunkUsers: async () => {},
      };
      let driver: CommonFrameDriver | undefined;
      try {
        driver = await CommonFrameDriver.open({ roots: { product, dataPath, homePath: join(home, "home"), cdPath: null },
          startupText: "+set dedicated 1", buildDate: "input-source-drop", build: { kind: "client", client: {
            initializeKeyCommands: () => {}, writeBindings: () => {}, consolePrint: () => {}, usesUniqueKey: () => 0,
          } },
          platformPrint: () => {}, client: { kind: "available", runtime },
          systemClock: { milliseconds: () => time },
          createPlatform: () => ({ getEvent: () => events.shift() ?? { kind: "none", time: ++time },
            yieldToIo: async () => {}, showConsole: () => {}, initialize: async () => {}, close: () => { closed = true; } }),
          createServer: services => ServerEngine.create({ common: services.common, buildDate: "input-source-drop",
            clock: services.events, random: services.random, network: { loopback: services.loopback, udp: null,
              lan: new LanAddresses([]), resolveAddress: async () => null, sleep: async () => {} },
            bots: { kind: "unavailable", reason: "Input boundary has no bot composition" },
            clientLifecycle: { kind: "absent" } }),
          resolveCommand: (_lookup, fallbacks) => fallbacks.server,
        });
        events.push({ kind: "joystick", time, axis: 6, value: 0 });
        expect(await driver.frame()).toEqual({ kind: "aborted", frameNumber: 0, code: "drop", message: "CL_JoystickEvent: bad axis 6" });
        expect(trace).toEqual(["input-init", "disconnect:true", "flush"]); expect(closed).toBe(false);
        expect(driver.common.cvars.get("com_errorMessage")?.value).toBe("CL_JoystickEvent: bad axis 6");
        expect((await driver.frame()).kind).toBe("frame"); expect(f.session.commands.currentNumber).toBe(0);
      } finally { try { await driver?.close(); } finally { rmSync(home, { recursive: true }); } }
    });
  }
  test("registers native command order, 16 storage versus 15 command bits and exact cvars", async () => {
    const f = await fixture(), ordered = [...f.commands.registeredNames()].reverse();
    expect(ordered.slice(0, 8)).toEqual(["wait", "centerview", "+moveup", "-moveup", "+movedown", "-movedown", "+left", "-left"]);
    expect(ordered.length).toBe(60); expect(ordered.slice(-4)).toEqual(["+button14", "-button14", "+mlook", "-mlook"]);
    expect(ordered).not.toContain("+button15"); f.commands.executeNow("+button15 1 1"); expect(f.calls).toEqual(["unknown:+button15"]);
    expect(f.cvars.get("cl_yawspeed")?.flags).toBe(CvarFlag.Archive);
    expect(f.cvars.get("cl_anglespeedkey")?.flags).toBe(0); expect(f.cvars.get("m_filter")?.value).toBe("0");
    expect(f.cvars.get("cl_upspeed")).toBeUndefined(); expect(() => f.input.initializeCommands()).toThrow("already initialized");
  });
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: actual session owns finished weapon, angles and signed saturated moves`, async () => {
      const f = await fixture(product); f.session.setUserCmdValue(5, 1);
      f.commands.executeNow("+strafe 1 1"); f.commands.executeNow("+left 2 1"); f.commands.executeNow("+moveleft 3 1");
      const command = f.frame(101, 100, 999); expect(command.rightmove).toBe(-128); expect(command.weapon).toBe(5); expect(command.serverTime).toBe(999);
      const datagram = transmitProtocolClient(f.session, 2000, 0, true)[0]; if (datagram === undefined) throw new Error("Missing actual client datagram");
      const peer = new Netchannel("server", 27962), received = peer.receive(datagram);
      if (received.kind !== "accepted") throw new Error("Missing accepted client channel packet");
      const decoded = decodeClientMessage(xorClientMessage(received.payload, 23, () => ""), {
        checksumFeed: 0, serverCommand: () => "", reliableSequence: 0, lastClientCommand: 0, lastUserCommandTime: 0,
      });
      if (decoded.kind !== "accepted") throw new Error("Server rejected generated input command");
      expect(decoded.movement?.commands).toEqual([{ ...command, angles: [command.angles.x, command.angles.y, command.angles.z] }]);
      expect(f.session.commands.currentNumber).toBe(1); const copy = f.input.viewAngles;
      expect(copy).toEqual(vec3(0, 0, 0)); await f.input.mouseEvent(0, 10, 102);
      f.commands.executeNow("-strafe 1 102"); f.commands.executeNow("-left 2 102"); f.commands.executeNow("-moveleft 3 102");
      const next = f.frame(117); expect(next.angles.x).not.toBe(0); expect(copy).toEqual(vec3(0, 0, 0));
    });
  }
  test("two holders, repeat, third hold rejection and partial release retain source fractions", async () => {
    const f = await fixture(); f.frame(100, 100);
    f.commands.executeNow("+forward 1 100"); f.commands.executeNow("+forward 1 110"); f.commands.executeNow("+forward 2 120"); f.commands.executeNow("+forward 3 130");
    f.commands.executeNow("-forward 1 140"); expect(f.frame(200, 100).forwardmove).toBe(127);
    expect(f.prints).toEqual(["Three keys down for a button!\n"]);
    f.commands.executeNow("-forward 2 250"); expect(f.frame(300, 100).forwardmove).toBe(63); expect(f.frame(400, 100).forwardmove).toBe(0);
  });
  test("manual release keeps button pulse; zero ID repeats empty slots; unmatched release is inert", async () => {
    const f = await fixture(); f.commands.executeNow("+attack 0 1"); expect(f.frame(16).buttons & 1).toBe(0);
    f.commands.executeNow("+attack"); f.commands.executeNow("-attack 4 20"); expect(f.frame(32).buttons & 1).toBe(1);
    f.commands.executeNow("-attack"); expect(f.frame(48).buttons & 1).toBe(0);
    f.commands.executeNow("+attack"); f.commands.executeNow("-attack"); expect(f.frame(64).buttons & 1).toBe(1); expect(f.frame(80).buttons & 1).toBe(0);
  });
  test("every registered generic pulse is packed, with source walking override and aliases", async () => {
    for (let index = 0; index < 15; index++) {
      const f = await fixture(); f.commands.executeNow(`+button${index} 9 1`); f.commands.executeNow(`-button${index} 9 2`);
      expect(f.frame(16).buttons).toBe(index === 4 ? 0 : 1 << index); expect(f.frame(32).buttons).toBe(0);
    }
    const f = await fixture(); f.commands.executeNow("+attack 1 1"); f.commands.executeNow("+button0 2 2"); f.commands.executeNow("-attack 1 3");
    expect(f.frame(16).buttons).toBe(1); f.commands.executeNow("-button0 2 17"); expect(f.frame(32).buttons).toBe(0);
  });
  test("movement actions, walking bitwise XOR and catchers follow source order", async () => {
    for (const [action, field, value] of [
      ["forward", "forwardmove", 127], ["back", "forwardmove", -127], ["moveleft", "rightmove", -127],
      ["moveright", "rightmove", 127], ["moveup", "upmove", 127], ["movedown", "upmove", -127],
    ] satisfies readonly (readonly [string, "forwardmove" | "rightmove" | "upmove", number])[]) {
      const f = await fixture(); f.commands.executeNow(`+${action} 1 0`); expect(f.frame(100, 100)[field]).toBe(value);
    }
    const f = await fixture(); f.keys(0, 1); f.cvars.set("cl_run", "0"); f.commands.executeNow("+forward");
    expect(f.frame(100).buttons).toBe(CommandButtons.WALKING | CommandButtons.ANY);
    f.commands.executeNow("+speed"); expect(f.frame(200).forwardmove).toBe(127);
    f.cvars.set("cl_run", "2"); expect(f.frame(300).forwardmove).toBe(127);
    f.keys(5, 1); expect(f.frame(400).buttons).toBe(CommandButtons.TALK);
  });
  test("odd missing-up timestamp halves integer duration; zero downtime and unsigned wrap are source cases", async () => {
    const f = await fixture(); f.frame(101); f.commands.executeNow("+forward 1 101"); f.commands.executeNow("-forward 1");
    expect(f.frame(202).forwardmove).toBe(62);
    f.commands.executeNow("+forward 1 0"); expect(f.frame(303).forwardmove).toBe(127);
    const wrapped = await fixture(); wrapped.commands.executeNow("+forward 1 -16"); wrapped.commands.executeNow("-forward 1 16");
    expect(wrapped.frame(100).forwardmove).toBe(40);
  });
  test("common clock and accumulated key time preserve the documented int32 wrap profile", async () => {
    const f = await fixture(); f.frame(2147483630); f.commands.executeNow("+forward 1 2147483630");
    expect(f.frame(-2147483630).forwardmove).toBe(127); f.commands.executeNow("-forward");
    f.commands.executeNow("+forward 1 -2147483648"); f.commands.executeNow("-forward 1 1");
    expect(f.frame(-2147483530).forwardmove).toBe(0);
  });
  test("unprimed does not consume state or time; reset clears active state but preserves hold and mlook", async () => {
    const f = await fixture(); f.frame(100); f.commands.executeNow("+forward 1 100"); f.commands.executeNow("+mlook");
    f.input.joystickEvent(0, 20, 100); await f.input.mouseEvent(99, 99, 100);
    expect(f.input.createNewCommands({ kind: "unprimed" })).toBeNull(); await f.gamestate();
    f.input.joystickEvent(1, 1, 0); const command = f.frame(200, 100);
    expect(command.forwardmove).toBe(127); expect(f.input.viewAngles.y).toBe(0); expect(f.input.viewAngles.x).toBe(14);
  });
  test("input caps duration at 200 while angle speed uses modified client time", async () => {
    const f = await fixture(); f.frame(100); f.commands.executeNow("+forward 1 1000"); f.commands.executeNow("+left 2 1000");
    expect(f.frame(1100, 50).forwardmove).toBe(63); expect(f.input.viewAngles.y).toBe(Math.fround(3.5));
    const before = f.session.commands.currentNumber; expect(() => f.frame(1100)).toThrow("Zero-duration"); expect(f.session.commands.currentNumber).toBe(before);
  });
  test("mouse buffers/filter/FOV and acceleration produce real view commands", async () => {
    const f = await fixture(); f.cvars.set("m_filter", "1"); f.cvars.set("sensitivity", "2"); f.session.setUserCmdValue(2, 0.5);
    await f.input.mouseEvent(20, 10, 0); f.frame(100, 100);
    expect(f.input.viewAngles.y).toBe(Math.fround(-Math.fround(Math.fround(0.022) * 10)));
    const first = f.input.viewAngles; f.frame(200, 100);
    expect(f.input.viewAngles.y).toBe(Math.fround(first.y * 2));
    f.frame(300); expect(f.input.viewAngles.y).toBe(Math.fround(first.y * 2));
    f.cvars.set("m_filter", "0"); f.cvars.set("cl_mouseAccel", "2"); f.cvars.set("cl_showmouserate", "1");
    await f.input.mouseEvent(30, 40, 310); f.frame(400, 100); expect(f.prints).toEqual(["0.500000 : 1.500000\n"]);
  });
  test("native mouse diagnostic preserves negative zero, ties-to-even and large fixed decimals", async () => {
    const f = await fixture(); f.cvars.set("cl_showmouserate", "1"); f.cvars.set("m_yaw", "0"); f.cvars.set("cl_mouseAccel", "-0");
    const values = ["-0", "1e22", "0.0078125", "0.0234375"];
    for (const [index, value] of values.entries()) {
      f.cvars.set("sensitivity", value); await f.input.mouseEvent(1, 0, 0); f.frame((index + 1) * 100);
    }
    expect(f.prints).toEqual(["0.010000 : -0.000000\n", "0.010000 : 9999999778196308361216.000000\n", "0.010000 : 0.007812\n", "0.010000 : 0.023438\n"]);
  });
  test("mlook-up centers live snapshot pitch; freelook and strafe decide mouse movement", async () => {
    const f = await fixture(); f.cvars.set("cl_freelook", "0"); f.delta(vec3(16384, 0, 0));
    f.commands.executeNow("+mlook"); f.commands.executeNow("-mlook"); expect(f.input.viewAngles.x).toBe(-90);
    f.delta(vec3(-8192, 0, 0)); f.commands.executeNow("centerview"); expect(f.input.viewAngles.x).toBe(45);
    await f.input.mouseEvent(2, 10, 0); expect(f.frame(100).forwardmove).toBe(-12);
    f.commands.executeNow("+strafe"); await f.input.mouseEvent(10, 10, 101); expect(f.frame(200).rightmove).toBe(12);
  });
  test("UI catcher wins and routing awaits actual selected callback", async () => {
    const f = await fixture(); let finish: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { finish = resolve; }); f.ui(async () => { f.calls.push("entered"); await gate; f.calls.push("finished"); });
    f.keys(10, 0); let done = false; const pending = f.input.mouseEvent(2, 3, 0).then(() => { done = true; });
    expect(f.calls).toEqual(["entered"]); expect(done).toBe(false);
    if (finish === undefined) throw new Error("Missing deferred resolver"); finish(); await pending;
    expect(f.calls).toEqual(["entered", "finished"]); f.keys(8, 0); await f.input.mouseEvent(4, 5, 0); expect(f.calls.at(-1)).toBe("cgame:4,5");
    f.keys(0, 0); f.frame(100); expect(f.input.viewAngles).toEqual(vec3(0, 0, 0));
  });
  test("failed UI routing propagates without falling through to cgame or storing mouse deltas", async () => {
    const f = await fixture(), failure = new Error("UI mouse failure"); f.keys(10, 0);
    f.ui(async () => { throw failure; });
    await expect(f.input.mouseEvent(100, 100, 0)).rejects.toBe(failure);
    expect(f.calls).toEqual([]); f.keys(0, 0); f.frame(100); expect(f.input.viewAngles).toEqual(vec3(0, 0, 0));
  });
  test("joystick axes persist, extra axes are inert, and running does not scale movement", async () => {
    const f = await fixture(); f.input.joystickEvent(1, -128, 0); f.input.joystickEvent(2, 127, 0);
    for (let axis = 3; axis < 6; axis++) f.input.joystickEvent(axis, 2147483647, 0);
    expect(f.frame(100).forwardmove).toBe(-128); expect(f.frame(200).upmove).toBe(127);
    f.commands.executeNow("+speed"); expect(f.frame(300).forwardmove).toBe(-128);
    expect(() => f.input.joystickEvent(6, 0, 0)).toThrow("bad axis 6"); expect(() => f.input.joystickEvent(-1, 0, 0)).toThrow("bad axis -1");
  });
  test("pitch is limited relative to previous frame and debug observes completed command", async () => {
    const f = await fixture(); f.cvars.set("cl_debugMove", "2"); await f.input.mouseEvent(0, 10000, 0); const cmd = f.frame(100);
    expect(f.input.viewAngles.x).toBe(90); expect(cmd.angles.x).toBe(16384); expect(f.graphs).toEqual([90, 0]);
    f.commands.executeNow("+lookup"); f.frame(200, 10000); expect(f.input.viewAngles.x).toBe(0);
  });
  test("a false claimed-primed state is an ownership error, and invalid native casts are explicit", async () => {
    const f = await fixture("baseq3", false); expect(() => f.frame(100)).toThrow("actual primed client session");
    const invalid = await fixture(); invalid.cvars.set("m_side", "1e30"); invalid.commands.executeNow("+strafe");
    await invalid.input.mouseEvent(1, 0, 0); expect(() => invalid.frame(100)).toThrow("Undefined native input float-to-int conversion");
    expect(invalid.session.commands.currentNumber).toBe(0);
  });
});
