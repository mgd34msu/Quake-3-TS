import { expect, test } from "bun:test";
import { CvarFlag, CvarRegistry, CvarVmStringError } from "../src/core/cvar.ts";
import { CommonError } from "../src/core/common-error.ts";
import { float32ToBits } from "../src/core/numeric.ts";
import { qvmCvarSyscall } from "../src/vm/cvar-syscalls.ts";
import { QvmMemory } from "../src/vm/memory.ts";

function argumentsView(...args: number[]): DataView {
  const view = new DataView(new ArrayBuffer(args.length * 4));
  args.forEach((value, index) => view.setInt32(index * 4, value, true));
  return view;
}

function setup(): { memory: QvmMemory; bytes: Uint8Array; cvars: CvarRegistry } {
  const bytes = new Uint8Array(4096);
  const memory = new QvmMemory(bytes);
  memory.writeString(32, "number", 32);
  memory.writeString(64, "12.5", 32);
  return { memory, bytes, cvars: new CvarRegistry() };
}

test("all roles bind actual registry indices and copied records independently update", () => {
  for (const role of ["game", "cgame", "ui"] satisfies readonly ("game" | "cgame" | "ui")[]) {
    const { memory, bytes, cvars } = setup();
    const typed = cvars.registerVm("preceding", "1");
    const trap = role === "ui" ? 50 : 3;
    expect(qvmCvarSyscall(role, argumentsView(trap, 256, 32, 64, CvarFlag.Archive), memory, cvars)).toBe(0);
    const record = memory.view(256, 272);
    expect(record.getInt32(0, true)).toBe(1);
    expect(record.getInt32(4, true)).toBe(1);
    expect(record.getFloat32(8, true)).toBe(12.5);
    expect(record.getInt32(12, true)).toBe(12);
    expect(memory.readString(272)).toBe("12.5");
    bytes.set(memory.span(256, 272), 768);
    const mirror = cvars.registerVm("number", "0");
    cvars.set("number", "-7.25", true);
    qvmCvarSyscall(role, argumentsView(trap + 1, 768), memory, cvars);
    expect(memory.readString(784)).toBe("-7.25");
    expect(memory.view(768, 272).getInt32(12, true)).toBe(-7);
    expect(memory.readString(272)).toBe("12.5");
    expect(mirror.value).toBe("12.5");
    mirror.update();
    expect(mirror.value).toBe("-7.25");
    expect(typed.value).toBe("1");
    expect(cvars.indexCount).toBe(2);
  }
});

test("equal counts and deleted source handles leave every byte untouched", () => {
  const { memory, bytes, cvars } = setup();
  cvars.set("number", "first");
  memory.writeString(64, "", 32);
  qvmCvarSyscall("game", argumentsView(3, 256, 32, 64, 0), memory, cvars);
  const record = memory.view(256, 272);
  record.setInt32(12, 777, true);
  memory.span(272, 256).fill(0xa5);
  const before = bytes.slice();
  qvmCvarSyscall("game", argumentsView(4, 256), memory, cvars);
  expect(bytes).toEqual(before);
  cvars.resetAll();
  cvars.set("number", "replacement");
  qvmCvarSyscall("game", argumentsView(4, 256), memory, cvars);
  expect(bytes).toEqual(before);
  expect(cvars.indexCount).toBe(2);
});

test("null registration still applies flags and a pending latch without writing memory", () => {
  const { memory, bytes, cvars } = setup();
  cvars.register("number", "1", CvarFlag.Latch);
  cvars.set("number", "2");
  const before = bytes.slice();
  qvmCvarSyscall("ui", argumentsView(50, 0, 32, 64, CvarFlag.Archive), memory, cvars);
  expect(bytes).toEqual(before);
  expect(cvars.get("number")?.value).toBe("2");
  expect(cvars.get("number")?.flags).toBe(CvarFlag.Latch | CvarFlag.Archive);
  expect(cvars.indexCount).toBe(1);
});

test("overflow publishes count before throwing and same-count retry does not write", () => {
  const { memory, bytes, cvars } = setup();
  qvmCvarSyscall("game", argumentsView(3, 256, 32, 64, 0), memory, cvars);
  const before = bytes.slice();
  cvars.set("number", "x".repeat(256), true);
  try { qvmCvarSyscall("game", argumentsView(4, 256), memory, cvars); throw new Error("Expected cvar overflow"); }
  catch (error) {
    expect(error).toBeInstanceOf(CvarVmStringError);
    if (!(error instanceof CommonError)) throw error;
    expect(error.code).toBe("drop");
  }
  new DataView(before.buffer).setInt32(260, 2, true);
  expect(bytes).toEqual(before);
  expect(() => qvmCvarSyscall("game", argumentsView(4, 256), memory, cvars)).not.toThrow();
  expect(bytes).toEqual(before);
  cvars.set("number", "\xff".repeat(255), true);
  qvmCvarSyscall("game", argumentsView(4, 256), memory, cvars);
  expect(memory.readString(272)).toBe("\xff".repeat(255));
  expect(memory.view(527, 1).getUint8(0)).toBe(0);
});

test("invalid source handles reject before mutation and null or truncated records reject", () => {
  const { memory, bytes, cvars } = setup();
  cvars.register("number", "1");
  for (const handle of [-1, 1, 1024, -2147483648]) {
    memory.view(256, 272).setInt32(0, handle, true);
    const before = bytes.slice();
    try { qvmCvarSyscall("cgame", argumentsView(4, 256), memory, cvars); throw new Error("Expected invalid handle"); }
    catch (error) {
      expect(error).toBeInstanceOf(CommonError);
      if (!(error instanceof CommonError)) throw error;
      expect(error.code).toBe("drop");
      expect(error.message).toBe("Cvar_Update: handle out of range");
    }
    expect(bytes).toEqual(before);
  }
  expect(() => qvmCvarSyscall("game", argumentsView(4, 0), memory, cvars)).toThrow();
  expect(() => qvmCvarSyscall("game", argumentsView(4, 4090), memory, cvars)).toThrow();
  expect(() => qvmCvarSyscall("ui", argumentsView(50, 256), memory, cvars)).toThrow();
});

test("forced set clears latches and overrides protected cvars, including null-value reset", () => {
  const { memory, cvars } = setup();
  for (const [role, trap] of [["game", 5], ["cgame", 5], ["ui", 3]] satisfies readonly (readonly ["game" | "cgame" | "ui", number])[]) {
    cvars.register("number", "1", CvarFlag.Latch | CvarFlag.ReadOnly);
    qvmCvarSyscall(role, argumentsView(trap, 32, 64), memory, cvars);
    expect(cvars.get("number")?.value).toBe("12.5");
    qvmCvarSyscall(role, argumentsView(trap, 32, 0), memory, cvars);
    expect(cvars.get("number")?.value).toBe("1");
  }
  cvars.register("latched", "1", CvarFlag.Latch);
  cvars.set("latched", "2");
  memory.writeString(32, "latched", 32);
  qvmCvarSyscall("game", argumentsView(5, 32, 64), memory, cvars);
  expect(cvars.get("latched")?.latchedValue).toBeUndefined();
  expect(cvars.get("latched")?.value).toBe("12.5");
});

test("string reads truncate and pad, while unknown variables only write the first byte", () => {
  const { memory, cvars } = setup();
  cvars.register("number", "12.5");
  for (const [role, trap] of [["game", 7], ["cgame", 6], ["ui", 5]] satisfies readonly (readonly ["game" | "cgame" | "ui", number])[]) {
    memory.span(256, 12).fill(0xa5);
    qvmCvarSyscall(role, argumentsView(trap, 32, 256, 3), memory, cvars);
    expect(Array.from(memory.span(256, 4))).toEqual([49, 50, 0, 165]);
    qvmCvarSyscall(role, argumentsView(trap, 32, 256, 8), memory, cvars);
    expect(Array.from(memory.span(256, 9))).toEqual([49, 50, 46, 53, 0, 0, 0, 0, 165]);
    expect(() => qvmCvarSyscall(role, argumentsView(trap, 32, 256, 0), memory, cvars)).toThrow();
    memory.writeString(96, "missing", 32);
    memory.span(256, 8).fill(0xa5);
    qvmCvarSyscall(role, argumentsView(trap, 96, 256, -1), memory, cvars);
    expect(Array.from(memory.span(256, 3))).toEqual([0, 165, 165]);
  }
});

test("game integer and UI floating returns use the actual registry numeric fields", () => {
  const { memory, cvars } = setup();
  cvars.register("number", "-12.75suffix");
  expect(qvmCvarSyscall("game", argumentsView(6, 32), memory, cvars)).toBe(-12);
  expect(qvmCvarSyscall("ui", argumentsView(4, 32), memory, cvars)).toBe(float32ToBits(-12.75) | 0);
  memory.writeString(32, "missing", 32);
  expect(qvmCvarSyscall("game", argumentsView(6, 32), memory, cvars)).toBe(0);
  expect(qvmCvarSyscall("ui", argumentsView(4, 32), memory, cvars)).toBe(0);
});

test("UI info trap returns native high-byte text from the actual common registry", () => {
  const { memory, cvars } = setup();
  cvars.register("x", "\xe9".repeat(600), CvarFlag.ServerInfo);
  expect(qvmCvarSyscall("ui", argumentsView(9, CvarFlag.ServerInfo, 256, 1024), memory, cvars)).toBe(0);
  expect(memory.readString(256)).toBe(`\\x\\${"\xe9".repeat(600)}`);
});

test("cvar callback effects cannot retarget already-decoded destination arguments", () => {
  const { memory } = setup();
  const registration = argumentsView(3, 256, 32, 64, 0);
  const cvars = new CvarRegistry(undefined, () => { registration.setInt32(4, 1024, true); });
  cvars.register("number", "1");
  memory.span(1024, 272).fill(0xa5);
  qvmCvarSyscall("game", registration, memory, cvars);
  expect(memory.readString(272)).toBe("1");
  expect(memory.span(1024, 272)).toEqual(new Uint8Array(272).fill(0xa5));

  const info = argumentsView(9, CvarFlag.ServerInfo, 2048, 32);
  const information = new CvarRegistry(() => { info.setInt32(12, 0, true); });
  information.register("good", "ok", CvarFlag.ServerInfo);
  information.register("bad", "x;y", CvarFlag.ServerInfo);
  expect(qvmCvarSyscall("ui", info, memory, information)).toBe(0);
  expect(memory.readString(2048)).toBe("\\good\\ok");
});

test("UI setvalue formats binary32 integers and six decimals with ties-even and source truncation", () => {
  const { memory, cvars } = setup();
  for (const [value, expected] of [
    [12, "12"], [-0, "0"], [-7.25, "-7.250000"], [0.1, "0.100000"],
    [1 / 128, "0.007812"], [3 / 128, "0.023438"], [-1 / 128, "-0.007812"],
    [2147483648, "2147483648.000000"], [2 ** 100, "1267650600228229401496703205376"],
  ] satisfies readonly (readonly [number, string])[]) {
    qvmCvarSyscall("ui", argumentsView(6, 32, float32ToBits(value)), memory, cvars);
    expect(cvars.get("number")?.value).toBe(expected);
  }
  const before = cvars.get("number");
  for (const value of [NaN, Infinity, -Infinity]) {
    expect(() => qvmCvarSyscall("ui", argumentsView(6, 32, float32ToBits(value)), memory, cvars)).toThrow("finite float");
    expect(cvars.get("number")).toEqual(before);
  }
});

test("UI oversized setvalue retains the common Com_sprintf overflow diagnostic", () => {
  const { memory } = setup();
  const printed: string[] = [];
  const cvars = new CvarRegistry(text => { printed.push(text); });
  qvmCvarSyscall("ui", argumentsView(6, 32, float32ToBits(2 ** 100)), memory, cvars);
  expect(printed).toEqual(["Com_sprintf: overflow of 38 in 32\n"]);
  expect(cvars.get("number")?.value).toBe("1267650600228229401496703205376");
});

test("UI create, reset and info read operate on actual flags and reset/latch state", () => {
  const { memory, cvars } = setup();
  qvmCvarSyscall("ui", argumentsView(8, 32, 64, CvarFlag.ServerInfo | CvarFlag.Latch), memory, cvars);
  cvars.set("number", "9", true);
  qvmCvarSyscall("ui", argumentsView(7, 32), memory, cvars);
  expect(cvars.get("number")?.value).toBe("9");
  expect(cvars.get("number")?.latchedValue).toBe("12.5");
  qvmCvarSyscall("ui", argumentsView(9, CvarFlag.ServerInfo, 256, 64), memory, cvars);
  expect(memory.readString(256)).toBe("\\number\\9");
  memory.writeString(32, "missing", 32);
  qvmCvarSyscall("ui", argumentsView(7, 32), memory, cvars);
  expect(cvars.indexCount).toBe(1);
});

test("non-cvar traps return null without reading further words or mutating records", () => {
  const { memory, bytes, cvars } = setup();
  const before = bytes.slice();
  for (const role of ["game", "cgame", "ui"] satisfies readonly ("game" | "cgame" | "ui")[]) {
    expect(qvmCvarSyscall(role, argumentsView(999), memory, cvars)).toBeNull();
  }
  expect(qvmCvarSyscall("cgame", argumentsView(7), memory, cvars)).toBeNull();
  expect(qvmCvarSyscall("game", argumentsView(50), memory, cvars)).toBeNull();
  expect(bytes).toEqual(before);
  expect(cvars.indexCount).toBe(0);
});
