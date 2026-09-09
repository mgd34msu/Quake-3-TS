import { expect, test } from "bun:test";
import { Weapon } from "../src/shared/definitions.ts";
import type { UserCommand } from "../src/shared/player-state.ts";
import { QVM_USER_COMMAND_BYTES, readQvmUserCommand, writeQvmUserCommand } from "../src/vm/user-command.ts";

const bytes = new Uint8Array([
  0x78, 0x56, 0x34, 0x12, 0xff, 0xff, 0xff, 0x7f,
  0, 0, 0, 0x80, 0xff, 0xff, 0xff, 0xff,
  1, 0, 0, 0x80, 13, 0x80, 0x7f, 0xfd,
]);
const command: UserCommand = {
  serverTime: 0x12345678, angles: { x: 0x7fffffff, y: -0x80000000, z: -1 },
  buttons: -2147483647, weapon: Weapon.WP_CHAINGUN, forwardmove: -128, rightmove: 127, upmove: -3,
};

test("usercmd_t reads exact source words and signed movement bytes into owned state", () => {
  expect(QVM_USER_COMMAND_BYTES).toBe(24);
  const record = bytes.slice();
  const decoded = readQvmUserCommand(new DataView(record.buffer));
  expect(decoded).toEqual(command);
  record.fill(0);
  expect(decoded.angles.x).toBe(0x7fffffff);
});

test("usercmd_t writes only its 24 bytes in a nonzero-offset view", () => {
  const storage = new Uint8Array(40).fill(0x55);
  writeQvmUserCommand(new DataView(storage.buffer, 7, 30), command);
  expect(storage.subarray(0, 7)).toEqual(new Uint8Array(7).fill(0x55));
  expect(storage.subarray(7, 31)).toEqual(bytes);
  expect(storage.subarray(31)).toEqual(new Uint8Array(9).fill(0x55));
  expect(readQvmUserCommand(new DataView(storage.buffer, 7, 30))).toEqual(command);
});

test("usercmd_t rejects a short record before writing", () => {
  const short = new Uint8Array(23).fill(0x55);
  expect(() => readQvmUserCommand(new DataView(short.buffer))).toThrow("Truncated");
  expect(() => writeQvmUserCommand(new DataView(short.buffer), command)).toThrow("Truncated");
  expect(short).toEqual(new Uint8Array(23).fill(0x55));
});

test("usercmd_t transports zero, retail and custom weapon bytes without changing signed fields", () => {
  for (const weapon of [0, Weapon.WP_CHAINGUN, 255]) {
    const source = bytes.slice();
    source[20] = weapon;
    const decoded = readQvmUserCommand(new DataView(source.buffer));
    expect(decoded).toEqual({ ...command, weapon });
    const output = new Uint8Array(QVM_USER_COMMAND_BYTES);
    writeQvmUserCommand(new DataView(output.buffer), decoded);
    expect(output).toEqual(source);
  }
});
