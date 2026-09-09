import { expect, test } from "bun:test";
import { CommandBuffer } from "../src/core/commands.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { ClientActiveState } from "../src/engine/client-active.ts";
import { ClientInput, registerClientInputCvars } from "../src/engine/client-input.ts";
import { ClientStaticState } from "../src/engine/client-state.ts";
import { CommandButtons } from "../src/shared/player-state.ts";

function fixture() {
  const active = new ClientActiveState(() => undefined), state = new ClientStaticState();
  const commands = new CommandBuffer(), cvars = new CvarRegistry(), prints: string[] = [];
  const input = new ClientInput({ commands, cvars, print: text => { prints.push(text); },
    readKeys: () => ({ keyCatchers: 0, anyKeyDown: 1 }), readDeltaAngles: () => ({ x: 0, y: 0, z: 0 }),
    mouseToUi: async () => { throw new Error("Unexpected UI mouse input"); },
    mouseToCgame: async () => { throw new Error("Unexpected cgame mouse input"); }, debugGraph: () => undefined });
  input.initializeCommands();
  registerClientInputCvars(cvars, "angle-speeds"); registerClientInputCvars(cvars, "movement"); registerClientInputCvars(cvars, "mouse");
  cvars.register("sv_running", "0"); cvars.register("sv_paused", "0"); cvars.register("cl_paused", "0");
  cvars.register("cl_showSend", "1");
  state.frameTime = 16;
  return { input, active, state, commands, cvars, prints };
}

test("standalone cinematic frames create actual active usercmds and consume held and pressed buttons", async () => {
  const f = fixture(); f.state.phase = "cinematic";
  f.commands.executeNow("+forward 1 1"); f.commands.executeNow("+attack 2 1"); f.commands.executeNow("-attack 2 9");
  await f.input.mouseEvent(100, 0, 10);
  f.input.sendPlaybackCommand(f.active, f.state, 16);
  const first = f.active.commands.read(1);
  expect(first).toEqual({ serverTime: 0, angles: { x: 0, y: 0, z: 0 }, buttons: CommandButtons.ATTACK | CommandButtons.ANY,
    weapon: 0, forwardmove: 119, rightmove: 0, upmove: 0 });
  f.input.sendPlaybackCommand(f.active, f.state, 32);
  expect(f.active.commands.currentNumber).toBe(2);
  expect(f.active.commands.read(2)?.buttons).toBe(CommandButtons.ANY);
  expect(f.active.commands.read(2)?.forwardmove).toBe(127);
  expect(f.prints).toEqual([". ", ". "]);
});

test("demo playback preserves command clock, sensitivity, weapon truncation and source pause gates", async () => {
  const f = fixture(); f.state.phase = "connected";
  f.input.sendPlaybackCommand(f.active, f.state, 1);
  expect(f.active.commands.currentNumber).toBe(0);
  expect(f.prints).toEqual([". "]);
  f.state.phase = "active"; f.active.time = 1234; f.active.setUserCmdValue(261, 1);
  await f.input.mouseEvent(10, 0, 10);
  f.input.sendPlaybackCommand(f.active, f.state, 16);
  expect(f.active.commands.read(1)?.serverTime).toBe(1234);
  expect(f.active.commands.read(1)?.weapon).toBe(5);
  expect(f.active.commands.read(1)?.angles.y).toBe(65336);
  f.cvars.set("sv_running", "1"); f.cvars.set("sv_paused", "1"); f.cvars.set("cl_paused", "1");
  f.input.sendPlaybackCommand(f.active, f.state, 32);
  expect(f.active.commands.currentNumber).toBe(1);
  expect(f.prints).toHaveLength(2);
  f.cvars.set("cl_paused", "0"); f.cvars.set("cl_showSend", "0");
  f.input.sendPlaybackCommand(f.active, f.state, 48);
  expect(f.active.commands.currentNumber).toBe(2);
  expect(f.prints).toHaveLength(2);
});

test("the active IN_Button15 helpers retain two-key state without registering or packing button15", () => {
  const f = fixture(); f.state.phase = "cinematic"; f.cvars.set("cl_showSend", "0");
  expect(f.commands.registeredNames()).not.toContain("+button15");
  expect(f.commands.registeredNames()).not.toContain("-button15");
  f.commands.register("source_button_down", context => { f.input.buttonDown(15, context); });
  f.commands.register("source_button_up", context => { f.input.buttonUp(15, context); });
  f.commands.executeNow("source_button_down 1 1");
  f.commands.executeNow("source_button_down 2 2");
  f.commands.executeNow("source_button_down 3 3");
  expect(f.prints).toEqual(["Three keys down for a button!\n"]);
  f.input.sendPlaybackCommand(f.active, f.state, 16);
  expect(f.active.commands.read(1)?.buttons).toBe(CommandButtons.ANY);
  f.commands.executeNow("source_button_up 1 17"); f.commands.executeNow("source_button_up 2 18");
  f.commands.executeNow("source_button_down 3 19");
  expect(f.prints).toHaveLength(1);
});
