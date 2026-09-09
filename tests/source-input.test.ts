// linux_joystick.c IN_JoyMove queues K_JOY1 + the unsigned-byte button number.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { expect, test } from "bun:test";
import { CommandBuffer } from "../src/core/commands.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { ClientKeys } from "../src/engine/client-keys.ts";
import { SourceInputState } from "../src/platform/source-input.ts";

function fixture() {
  const cvars = new CvarRegistry(), commands = new CommandBuffer();
  const unused = (): never => { throw new Error("Unexpected client service during joystick binding"); };
  const input = new SourceInputState({ cvars, print: unused });
  const keys = new ClientKeys({ cvars, commands, print: unused, host: {
    readConnection: () => ({ kind: "active", demoPlayback: false }), readUi: () => null, readCgame: () => null,
    assertCurrentOperation: () => { commands.assertCurrentExecution(); }, disconnect: unused, stopAllSounds: unused,
    addReliableCommand: unused, toggleConsole: unused, updateScreen: unused, consoleScroll: unused,
    readConsoleWidth: () => 78, clipboard: { kind: "native-unix-unavailable" },
  } });
  const events: { readonly key: number; readonly down: boolean; readonly time: number }[] = [];
  const queue = (key: number, down: boolean, time: number): undefined => { events.push({ key, down, time }); };
  return { input, keys, commands, events, queue };
}

test("source joystick buttons reach JOY32, AUX1, AUX16 and the last engine key binding", async () => {
  const f = fixture();
  try {
    for (const [button, key] of [[31, 216], [32, 217], [47, 232], [70, 255]] satisfies readonly (readonly [number, number])[]) {
      f.keys.setBinding(key, "+attack");
      f.input.joystickState.button(button, true, f.queue);
      f.input.joystickState.button(button, false, f.queue);
    }
    expect(f.events).toEqual([216, 217, 232, 255].flatMap(key => [
      { key, down: true, time: 0 }, { key, down: false, time: 0 },
    ]));
    for (const event of f.events) await f.keys.keyEvent(event.key, event.down, event.time);
    expect(f.commands.pendingText).toBe([216, 217, 232, 255].map(key => `+attack ${key} 0\n-attack ${key} 0\n`).join(""));
    expect(f.keys.inputState.anyKeyDown).toBe(0);
  } finally { f.input.close(); }
});

test("focus loss releases auxiliary joystick buttons once with the supplied time", () => {
  const f = fixture();
  try {
    f.input.joystickState.button(32, true, f.queue);
    f.input.joystickState.button(47, true, f.queue);
    f.input.releaseJoystickState(123, f.queue);
    f.input.releaseJoystickState(124, f.queue);
    expect(f.events).toEqual([
      { key: 217, down: true, time: 0 }, { key: 232, down: true, time: 0 },
      { key: 217, down: false, time: 123 }, { key: 232, down: false, time: 123 },
    ]);
  } finally { f.input.close(); }
});

test("source byte buttons outside the engine key allocation reach its explicit rejection", async () => {
  const f = fixture();
  try {
    f.input.joystickState.button(71, true, f.queue);
    f.input.joystickState.button(255, true, f.queue);
    expect(f.events).toEqual([{ key: 256, down: true, time: 0 }, { key: 440, down: true, time: 0 }]);
    for (const event of f.events) await expect(f.keys.keyEvent(event.key, event.down, event.time)).rejects.toThrow("Undefined native key index");
    expect(f.commands.pendingText).toBe("");
  } finally { f.input.close(); }
});

test("non-byte injected joystick button numbers reject before publishing events", () => {
  const f = fixture();
  try {
    for (const button of [-1, 256, 1.5, NaN, Infinity]) {
      expect(() => f.input.joystickState.button(button, true, f.queue)).toThrow("Joystick button requires an unsigned byte");
    }
    expect(f.events).toEqual([]);
  } finally { f.input.close(); }
});
