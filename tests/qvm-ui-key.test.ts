// Authored placeholder bytes only. No installed or user-supplied key files.
import { expect, test } from "bun:test";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { CommonCdKeyState } from "../src/engine/cd-key.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { qvmUiKeySyscall } from "../src/vm/ui-key-syscalls.ts";

function words(...args: number[]): DataView {
  const view = new DataView(new ArrayBuffer(args.length * 4));
  for (const [index, value] of args.entries()) view.setInt32(index * 4, value, true);
  return view;
}

test("UI module slot callback sees registered fs_game and its result selects the actual shared key bytes", async () => {
  const cvars = new CvarRegistry(), keys = new CommonCdKeyState(cvars, "client"), memory = new QvmMemory(new Uint8Array(256));
  keys.writeUiForCompiledModule(() => 1, () => new Uint8Array(16).fill(0x41));
  cvars.set("fs_game", "missionpack", true); keys.writeUiForCompiledModule(() => 1, () => new Uint8Array(16).fill(0x42));
  for (const result of [0, 1, 2, -1]) {
    memory.span(64, 20).fill(0xa5);
    expect(await qvmUiKeySyscall("ui", words(53, 64, -1), memory, keys, () => {
      expect(cvars.get("fs_game")?.flags).toBe(CvarFlag.Init | CvarFlag.SystemInfo);
      return result;
    })).toBe(0);
    expect(memory.span(64, 20)).toEqual(new Uint8Array([...new Uint8Array(16).fill(result === 1 ? 0x42 : 0x41), 0, 0xa5, 0xa5, 0xa5]));
  }
  cvars.set("fs_game", "", true);
  expect(await qvmUiKeySyscall("ui", words(53, 64, 0), memory, keys, async () => {
    cvars.set("fs_game", "missionpack", true);
    return 1;
  })).toBe(0);
  expect(memory.span(64, 16).every(byte => byte === 0x42)).toBe(true);
});

test("UI fixed-width writes capture argument words but read caller bytes after the module callback", async () => {
  const cvars = new CvarRegistry(), keys = new CommonCdKeyState(cvars, "client"), memory = new QvmMemory(new Uint8Array(256));
  const call = words(54, 64);
  memory.span(64, 16).fill(0x41); cvars.takeModifiedFlags();
  expect(await qvmUiKeySyscall("ui", call, memory, keys, async () => {
    expect(cvars.get("fs_game")).toBeDefined();
    call.setInt32(4, 0, true);
    memory.span(64, 16).fill(0x43);
    return 0;
  })).toBe(0);
  const output = new Uint8Array(17); keys.readUiForCompiledModule(() => 1, () => output);
  expect(output).toEqual(new Uint8Array([...new Uint8Array(16).fill(0x43), 0]));
  expect(cvars.modifiedFlags & CvarFlag.Archive).toBe(CvarFlag.Archive);
  cvars.takeModifiedFlags();
  let callbacks = 0;
  await expect(qvmUiKeySyscall("ui", words(54, 0), memory, keys, () => { callbacks++; return 0; })).rejects.toThrow("nonnull");
  expect(callbacks).toBe(1); expect(cvars.modifiedFlags).toBe(0);
  keys.readUiForCompiledModule(() => 1, () => output);
  expect(output[0]).toBe(0x43);
});

test("UI key validation ignores checksum pointers after wrong key length and leaves other roles alone", () => {
  const keys = new CommonCdKeyState(new CvarRegistry(), "client"), memory = new QvmMemory(new Uint8Array(256));
  const callback = (): never => { throw new Error("Unexpected UI module call"); };
  memory.writeString(64, "short", 32); memory.span(255, 1)[0] = 1;
  expect(qvmUiKeySyscall("ui", words(81, 64, 255), memory, keys, callback)).toBe(0);
  memory.writeString(64, "A".repeat(16), 32);
  expect(qvmUiKeySyscall("ui", words(81, 64, 0), memory, keys, callback)).toBe(1);
  memory.writeString(128, "10", 3);
  expect(qvmUiKeySyscall("ui", words(81, 64, 128), memory, keys, callback)).toBe(1);
  expect(() => qvmUiKeySyscall("ui", words(81, 64, 255), memory, keys, callback)).toThrow("no terminator");
  expect(qvmUiKeySyscall("ui", words(87), memory, keys, callback)).toBe(0);
  expect(qvmUiKeySyscall("ui", words(1), memory, keys, callback)).toBeNull();
  for (const role of ["game", "cgame"] satisfies readonly ("game" | "cgame")[])
    expect(qvmUiKeySyscall(role, new DataView(new ArrayBuffer(0)), memory, keys, callback)).toBeNull();
});
