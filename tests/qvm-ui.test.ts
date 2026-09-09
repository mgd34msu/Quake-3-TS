import { expect, spyOn, test } from "bun:test";
import { QvmOpcode, parseQvm } from "../src/assets/qvm.ts";
import type { QvmImage } from "../src/assets/qvm.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import { CommonError } from "../src/core/common-error.ts";
import { ClientConnectionState, ClientStaticState } from "../src/engine/client-state.ts";
import { QvmUi } from "../src/engine/qvm-ui.ts";
import { VmRegistry } from "../src/vm/registry.ts";

function observedModule(): QvmImage {
  const code = new BinaryWriter(64);
  code.u8(QvmOpcode.OP_ENTER); code.i32(32);
  for (let index = 0; index < 3; index++) {
    code.u8(QvmOpcode.OP_LOCAL); code.i32(40 + index * 4);
    code.u8(QvmOpcode.OP_LOAD4);
    code.u8(QvmOpcode.OP_ARG); code.u8(8 + index * 4);
  }
  code.u8(QvmOpcode.OP_CONST); code.i32(-501);
  code.u8(QvmOpcode.OP_CALL);
  code.u8(QvmOpcode.OP_LEAVE); code.i32(32);
  const bytes = code.finish(), writer = new BinaryWriter(32 + bytes.length);
  for (const word of [0x12721444, 13, 32, bytes.length, 32 + bytes.length, 0, 0, 2048]) writer.i32(word);
  writer.bytes(bytes);
  return parseQvm(writer.finish(), "authored-ui.qvm");
}

test("external UI forwards source exports, live connection phase and menu arguments", async () => {
  const client = new ClientStaticState(), calls: number[][] = [];
  const registration = new VmRegistry().reserve("ui"), called = spyOn(registration, "called");
  client.phase = "primed"; client.realtime = 123;
  const ui = new QvmUi(observedModule(), call => {
    const command = call.words.getInt32(4, true);
    calls.push([command, call.words.getInt32(8, true), call.words.getInt32(12, true)]);
    return command === 0 ? 6 : 2;
  }, client, () => undefined, { kind: "unaccounted" }, registration);
  expect(QvmUi.registered(registration)).toBe(ui);
  await ui.initialize();
  await ui.keyEvent(42, true); await ui.mouseEvent(-7, 9); await ui.refresh(-123);
  expect(await ui.isFullscreen()).toBe(true);
  await ui.setActiveMenu("main"); await ui.setActiveMenu("ingame"); await ui.setActiveMenu(17);
  const commands = new CommandBuffer();
  commands.registerAsync("mod-command", async context => { expect(await ui.consoleCommand(context)).toBe(true); });
  await commands.executeNowAsync("mod-command");
  await ui.drawConnectScreen(true, client, new ClientConnectionState());
  expect(await ui.usesUniqueKey()).toBe(2);
  await ui.shutdown();
  expect(calls).toEqual([[0, 0, 0], [1, 1, 0], [3, 42, 1], [4, -7, 9], [5, -123, 0],
    [6, 0, 0], [7, 1, 0], [7, 2, 0], [7, 17, 0], [8, 123, 0], [9, 1, 0], [10, 0, 0], [2, 0, 0]]);
  ui.retire();
  expect(registration.binding.kind).toBe("freed");
  expect(QvmUi.registered(registration)).toBeNull();
  await expect(ui.refresh(0)).rejects.toThrow("retired");
  expect(calls.length).toBe(13);
  expect(called).toHaveBeenCalledTimes(13);
  called.mockRestore();
});

test("UI version checking accepts old API and reads connection state after the API call", async () => {
  const client = new ClientStaticState(), calls: number[][] = [];
  const ui = new QvmUi(observedModule(), call => {
    const command = call.words.getInt32(4, true);
    calls.push([command, call.words.getInt32(8, true)]);
    if (command === 0) { client.phase = "active"; return 4; }
    return 0;
  }, client, () => undefined);
  client.phase = "connecting";
  await ui.initialize();
  expect(calls).toEqual([[0, 0], [1, 0]]);
  const rejected: number[] = [];
  const incompatible = new QvmUi(observedModule(), call => {
    rejected.push(call.words.getInt32(4, true)); return 5;
  }, client, () => undefined);
  await expect(incompatible.initialize()).rejects.toThrow(CommonError);
  expect(rejected).toEqual([0]);
});

test("UI command callbacks reenter the same suspended interpreter after an await", async () => {
  const client = new ClientStaticState(), calls: number[] = [], commands = new CommandBuffer();
  const registration = new VmRegistry().reserve("ui"), called = spyOn(registration, "called");
  const ui = new QvmUi(observedModule(), async call => {
    const command = call.words.getInt32(4, true);
    calls.push(command);
    if (command === 5) { await Promise.resolve(); await commands.executeNowAsync("nested"); }
    return command === 0 ? 6 : 1;
  }, client, () => undefined, { kind: "unaccounted" }, registration);
  commands.registerAsync("nested", async context => {
    expect(await ui.isFullscreen()).toBe(true); context.assertActive();
  });
  await ui.initialize(); await ui.refresh(100); await ui.shutdown();
  expect(calls).toEqual([0, 1, 5, 6, 2]);
  expect(called).toHaveBeenCalledTimes(5);
  ui.retire(); called.mockRestore();
});
