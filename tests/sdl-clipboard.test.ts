import { expect, test } from "bun:test";
import { CommandBuffer } from "../src/core/commands.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import type { FieldClipboard } from "../src/core/edit-field.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { ClientKeys } from "../src/engine/client-keys.ts";
import { sourceClipboardBytes } from "../src/platform/sdl.ts";
import { MenuField } from "../src/ui/base/field.ts";

test("Win32 clipboard truncates the first token and retains leading strtok delimiters", () => {
  for (const separator of ["\n", "\r", "\b"])
    expect(sourceClipboardBytes(Buffer.from(`one${separator}two`))).toEqual(Uint8Array.of(111, 110, 101, 0));
  expect(sourceClipboardBytes(Buffer.from("\n\r\bone\ntwo")))
    .toEqual(Uint8Array.of(10, 13, 8, 111, 110, 101, 0));
  expect(sourceClipboardBytes(Uint8Array.of(10, 13, 8))).toEqual(Uint8Array.of(10, 13, 8, 0));
  expect(sourceClipboardBytes(new Uint8Array())).toEqual(Uint8Array.of(0));
});

test("clipboard bytes own their storage, retain UTF-8 and stop at native NUL", () => {
  const input = Uint8Array.of(65, 0xc3, 0xa9, 0, 66);
  const result = sourceClipboardBytes(input);
  input.fill(0);
  expect(result).toEqual(Uint8Array.of(65, 0xc3, 0xa9, 0));
});

function fixture() {
  const commands = new CommandBuffer(), cvars = new CvarRegistry();
  let content = "", reads = 0;
  const clipboard = { kind: "available", read: () => {
    reads++;
    return sourceClipboardBytes(Buffer.from(content));
  } } satisfies FieldClipboard;
  const keys = new ClientKeys({ commands, cvars, print: () => undefined, host: {
    readConnection: () => ({ kind: "active", demoPlayback: false }),
    readUi: () => null, readCgame: () => null, assertCurrentOperation: () => { commands.assertCurrentExecution(); },
    disconnect: async () => undefined, stopAllSounds: () => undefined,
    addReliableCommand: () => undefined, toggleConsole: async () => undefined,
    updateScreen: async () => undefined, consoleScroll: () => undefined, readConsoleWidth: () => 78, clipboard,
  } });
  keys.initializeCommands();
  keys.initializeConsoleFields(78);
  keys.setCatcher(KeyCatcher.Console);
  return { keys, clipboard, content: (text: string) => { content = text; }, reads: () => reads };
}

test("actual ClientKeys Ctrl-V and Shift-Insert preserve insertion and overstrike", async () => {
  const f = fixture();
  f.content("AB\nignored");
  await f.keys.charEvent(22);
  expect(f.keys.consoleField.text).toBe("AB");
  await f.keys.keyEvent(KeyCode.Left, true, 1);
  f.content("xy");
  await f.keys.keyEvent(KeyCode.Shift, true, 2);
  await f.keys.keyEvent(KeyCode.Insert, true, 3);
  await f.keys.keyEvent(KeyCode.Insert, false, 4);
  await f.keys.keyEvent(KeyCode.Shift, false, 5);
  expect(f.keys.consoleField.text).toBe("AxyB");
  await f.keys.keyEvent(KeyCode.Home, true, 6);
  await f.keys.keyEvent(KeyCode.Insert, true, 7);
  f.content("Zé");
  await f.keys.charEvent(22);
  expect(f.keys.consoleField.text).toBe("ZxyB");
  expect(f.reads()).toBe(3);
});

test("clipboard reaches chat fields and retains console and menu capacity limits", async () => {
  const f = fixture();
  f.content("chat\rsecond line");
  f.keys.setCatcher(KeyCatcher.Message);
  await f.keys.charEvent(22);
  expect(f.keys.chatField.text).toBe("chat");
  f.keys.setCatcher(KeyCatcher.Console);
  f.content("x".repeat(300));
  await f.keys.charEvent(22);
  expect(f.keys.consoleField.text).toBe("x".repeat(255));
  const menu = new MenuField();
  menu.widthInChars = 20;
  menu.charEvent(22, { clipboard: f.clipboard, isDown: key => f.keys.isDown(key),
    getOverstrike: () => f.keys.getOverstrike(), setOverstrike: value => { f.keys.setOverstrike(value); } });
  expect(menu.text).toBe("x".repeat(63));
});
