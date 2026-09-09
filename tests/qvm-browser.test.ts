import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { parseQvm, QvmOpcode } from "../src/assets/qvm.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { infoValueForKey } from "../src/core/info-string.ts";
import { ClientStaticState } from "../src/engine/client-state.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { ServerBrowser } from "../src/engine/server-browser.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { qvmBrowserSyscall } from "../src/vm/browser-syscalls.ts";
import { QvmInterpreter } from "../src/vm/interpreter.ts";
import { QvmMemory } from "../src/vm/memory.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function words(...values: number[]): DataView {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  for (const [index, value] of values.entries()) view.setInt32(index * 4, value, true);
  return view;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quake3-qvm-browser-"));
  cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
  const data = join(root, "data"), home = join(root, "home");
  mkdirSync(join(data, "baseq3"), { recursive: true });
  writeFileSync(join(data, "baseq3", "default.cfg"), "set authored_browser 1\n");
  const cvars = new CvarRegistry(), sound = new SoundOutput(), memory = new QvmMemory(new Uint8Array(2048));
  const files = new CommonFileState({ dataPath: data, homePath: home, cdPath: null, product: "baseq3" },
    () => undefined, sound, cvars);
  cleanup.push(() => { try { files.close(); } finally { sound.close(); } });
  await files.initialize({ checksumFeed: 0, random: () => 0.25 }, () => undefined);
  const stdin = new PassThrough(), io = new UnixIo(() => undefined, new UnixSystemClock(), { stdin, signals: "none" });
  cleanup.push(() => { io.close(); stdin.destroy(); });
  // Authored transport boundary: no sockets, system input, DNS or external address resolution.
  io.resolveAddress = async (host, port) => {
    expect(host).toBe("127.0.0.1");
    return { kind: "ipv4", host: [127, 0, 0, 1], port };
  };
  cvars.register("cl_maxPing", "800"); cvars.register("cl_serverStatusResendTime", "750");
  const clientStatic = new ClientStaticState(), loopback = new LoopbackTransport();
  const hooks = { entry: (): void => {}, print: (_text: string): void => {}, clock: (): void => {} };
  let now = 1000;
  const events = new CommonEvents({ getEvent: () => { hooks.clock(); return { kind: "none", time: now }; } }, () => undefined);
  const browser = new ServerBrowser({ clientStatic, cvars, io, loopback,
    assertCurrentOperation: () => { hooks.entry(); }, print: text => { hooks.print(text); } });
  const services = { browser, files, events };
  const call = (...values: number[]) => qvmBrowserSyscall("ui", words(...values), memory, services);
  const add = async (name: string, port = 27960, source = 3) => {
    memory.writeString(16, name, 64); memory.writeString(80, `127.0.0.1:${port}`, 64);
    return call(73, source, 16, 80);
  };
  return { memory, browser, files, services, call, add, hooks, clientStatic, io, loopback,
    cachePath: join(home, "servercache.dat"), setTime: (value: number) => { now = value; } };
}

test("UI LAN IDs share actual lists, capacity rows, sort order and raw visibility", async () => {
  const f = await fixture();
  for (const source of [0, 1, 2, 3]) {
    expect(f.call(65, source)).toBe(0);
    expect(await f.add("Zulu", 27960, source)).toBe(1);
    expect(await f.add("Alpha", 27961, source)).toBe(1);
    expect(f.call(65, source)).toBe(2);
    expect(f.call(85, source, 0, 0, 0, 1)).toBe(1);
    expect(f.call(85, source, 0, -123, 0, 1)).toBe(-1);
    expect(f.call(85, source, 999, 0, 0, 1)).toBe(0);
    for (const raw of [-2147483648, -1, 2, 2147483647, 0]) {
      expect(f.call(68, source, -1, raw)).toBe(0);
      expect(f.call(84, source, 127)).toBe(raw);
      expect(f.browser.serverIsVisible(source, 127)).toBe(raw !== 0);
    }
    f.call(70, source); expect(f.call(83, source, 127)).toBe(-1);
    expect(f.call(83, source, source === 2 ? 4096 : 128)).toBe(-1);
    expect(await f.call(74, source, 80)).toBe(0);
    expect(f.call(65, source)).toBe(1);
    f.call(66, source, 1, 160, 64); expect(f.memory.readString(160)).toBe("127.0.0.1:27961");
  }
  f.call(68, 2, 4095, -7); expect(f.call(84, 2, 4095)).toBe(-7);
  expect(f.call(84, 2, 4096)).toBe(0);
  f.call(68, 99, -1, 7); expect(f.call(84, 99, 0)).toBe(0);
  expect(f.call(65, 99)).toBe(0); expect(f.call(69, 99)).toBe(0);
  expect(f.call(85, 3, 0, 0, -1, 0)).toBe(0);
});

test("address and info output preserve masked pointers, padding, null guards and partial first-byte writes", async () => {
  const f = await fixture();
  f.memory.bytes.fill(0xaa);
  expect(f.call(66, 3, 127, 2208, 8)).toBe(0);
  expect(f.memory.span(160, 9)).toEqual(new Uint8Array([98, 111, 116, 0, 0, 0, 0, 0, 0xaa]));
  f.call(66, 3, 127, 160, 3); expect(f.memory.readString(160)).toBe("bo");
  for (const trap of [66, 67]) for (const source of [3, 99]) {
    f.memory.bytes.fill(0xaa);
    expect(f.call(trap, source, 4096, 2047, -5)).toBe(0);
    expect(f.memory.bytes[2047]).toBe(0); expect(f.memory.bytes[2046]).toBe(0xaa);
  }
  expect(f.call(67, 3, 0, 0, -1)).toBe(0);
  expect(f.call(67, 99, 0, 0, -1)).toBe(0);
  expect(() => f.call(66, 99, 0, 0, 0)).toThrow("nonnull pointer");
  expect(() => f.call(66, 3, 0, 0, 0)).toThrow("NULL dest");
  expect(() => f.call(66, 3, 0, 160, 0)).toThrow("destsize");
  f.memory.bytes[160] = 0xaa;
  expect(() => f.call(67, 3, 0, 160, 0)).toThrow("destsize");
  expect(f.memory.bytes[160]).toBe(0);
  expect(() => f.call(66, 3, 0, 2047, 2)).toThrow("exceeds QVM allocation");
  await f.add("bad\\name");
  f.memory.bytes[160] = 0xaa;
  f.hooks.print = () => { expect(f.memory.bytes[160]).toBe(0); throw new Error("authored info failure"); };
  expect(() => f.call(67, 3, 0, 160, 1024)).toThrow("authored info failure");
});

test("add/remove guards avoid unused strings and preserve reached insertion after a failed name read", async () => {
  const f = await fixture();
  expect(await f.call(73, 99, 0, 0)).toBe(-1);
  expect(await f.call(74, 99, 0)).toBe(0);
  expect(await f.add("first")).toBe(1);
  expect(await f.call(73, 3, 0, 80)).toBe(0);
  f.memory.writeString(80, "127.0.0.1:27962", 64);
  await expect(Promise.resolve(f.call(73, 3, 0, 80))).rejects.toThrow("NULL src");
  expect(f.call(65, 3)).toBe(1);
  f.call(66, 3, 1, 160, 64); expect(f.memory.readString(160)).toBe("127.0.0.1:27962");
  f.memory.span(2017, 31).fill(0xe9);
  expect(await f.call(73, 3, 2017, 80)).toBe(1);
  f.call(67, 3, 1, 160, 1024);
  expect(infoValueForKey(f.memory.readString(160), "hostname")).toBe("\xe9".repeat(31));
  f.call(72);
  const bytes = readFileSync(f.cachePath), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setInt32(8, 128, true); writeFileSync(f.cachePath, bytes); f.call(71);
  expect(await f.call(73, 3, 0, 0)).toBe(-1);
  expect(f.call(65, 3)).toBe(128);
});

test("ping output distinguishes inactive slots from active empty info and publishes before info mutation", async () => {
  const f = await fixture();
  expect(f.call(46)).toBe(0);
  f.memory.bytes.fill(0xaa);
  expect(f.call(49, 0, 0, 0)).toBe(0);
  expect(f.call(49, 0, 2047, -1)).toBe(0); expect(f.memory.bytes[2047]).toBe(0);
  expect(f.call(48, 0, 160, -1, 240)).toBe(0);
  expect(f.memory.span(160, 2)).toEqual(new Uint8Array([0, 0xaa]));
  expect(f.memory.view(240, 4).getInt32(0, true)).toBe(0);
  for (const index of [-1, 32]) {
    expect(f.call(47, index)).toBe(0);
    expect(() => f.call(48, index, 160, 64, 240)).toThrow("source index");
    expect(() => f.call(49, index, 160, 64)).toThrow("source index");
  }
  await f.add("pending"); f.call(70, 3);
  expect(f.call(69, 3)).toBe(1); expect(f.call(46)).toBe(1);
  f.memory.span(160, 65).fill(0xaa);
  expect(f.call(49, 0, 160, 64)).toBe(0);
  expect(f.memory.span(160, 64).every(byte => byte === 0)).toBe(true);
  expect(f.memory.bytes[224]).toBe(0xaa);
  expect(() => f.call(49, 0, 0, 0)).toThrow("NULL dest");
  expect(() => f.call(49, 0, 160, 0)).toThrow("destsize");
  f.call(70, 3);
  f.clientStatic.realtime = 900;
  expect(() => f.call(48, 0, 0, 64, 240)).toThrow("NULL dest");
  expect(f.call(83, 3, 0)).toBe(-1);
  expect(f.call(48, 0, 160, 64, 240)).toBe(0);
  expect(f.memory.readString(160)).toBe("127.0.0.1:27960");
  expect(f.memory.view(240, 4).getInt32(0, true)).toBe(900);
  expect(f.call(83, 3, 0)).toBe(0);
  const aliased = f.memory.view(300, 20);
  for (const [index, value] of [48, 0, 312, 8, 240].entries()) aliased.setInt32(index * 4, value, true);
  expect(qvmBrowserSyscall("ui", aliased, f.memory, f.services)).toBe(0);
  expect(f.memory.readString(312)).toBe("127.0.0");
  expect(f.memory.view(240, 4).getInt32(0, true)).toBe(900);
  f.call(47, 0); expect(f.call(46)).toBe(0);
});

test("status reset, pending and completion use actual common events and source output timing", async () => {
  const f = await fixture();
  expect(await f.call(82, 0, 2047, -1)).toBe(0);
  f.memory.writeString(80, "127.0.0.1:27960", 64); f.memory.span(160, 64).fill(0xaa);
  const args = words(82, 80, 160, 64);
  f.hooks.clock = () => { args.setInt32(8, 0, true); args.setInt32(12, -1, true); };
  expect(await qvmBrowserSyscall("ui", args, f.memory, f.services)).toBe(0);
  expect(f.memory.bytes[160]).toBe(0xaa);
  f.browser.serverStatusResponse({ kind: "ipv4", host: [127, 0, 0, 1], port: 27960 },
    new TextEncoder().encode("\\hostname\\Authored\n4 12 \"player\"\n\n"), f.services.events);
  await expect(Promise.resolve(f.call(82, 80, 2047, 64))).rejects.toThrow("exceeds QVM allocation");
  f.memory.writeString(80, "127.0.0.1:27961", 64);
  expect(await f.call(82, 80, 160, 64)).toBe(0);
  f.memory.writeString(80, "127.0.0.1:27960", 64);
  expect(await f.call(82, 80, 160, 64)).toBe(1);
  expect(f.memory.readString(160)).toBe('\\hostname\\Authored\\\\4 12 "player"\\');
  expect(f.memory.bytes[223]).toBe(0); expect(f.memory.bytes[224]).toBe(0);
  expect(await f.call(82, 80, 0, -1)).toBe(0);
  expect(await f.call(82, 0, 0, 0)).toBe(0);
});

test("cache traps persist source raw visibility and truncated cache writes through common files", async () => {
  const f = await fixture();
  await f.add("retained"); f.call(68, 3, 0, -123); f.call(68, 2, 4095, 0x12345678);
  expect(f.call(72)).toBe(0);
  const bytes = readFileSync(f.cachePath), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(bytes.length).toBe(661520); expect(view.getInt32(12, true)).toBe(661504);
  expect(view.getInt32(16 + (4096 + 128) * 152 + 144, true)).toBe(-123);
  expect(view.getInt32(16 + 4095 * 152 + 144, true)).toBe(0x12345678);
  f.call(68, 3, 0, 0); f.call(71); expect(f.call(84, 3, 0)).toBe(-123);
  bytes[16 + 144] = 0x55;
  writeFileSync(f.cachePath, bytes.subarray(0, 16 + 145));
  f.call(71); expect(f.call(84, 2, 0)).toBe(0x55); expect(f.call(84, 3, 0)).toBe(-123);
  f.call(67, 3, 0, 160, 1024);
  expect(infoValueForKey(f.memory.readString(160), "hostname")).toBe("retained");
});

test("scalar words remain captured at owner reentry and deferred name follows source insertion timing", async () => {
  const f = await fixture(), args = words(68, 3, 0, -17);
  f.hooks.entry = () => { args.setInt32(4, 0, true); args.setInt32(8, 1, true); args.setInt32(12, 0, true); };
  expect(qvmBrowserSyscall("ui", args, f.memory, f.services)).toBe(0);
  f.hooks.entry = () => {};
  expect(f.call(84, 3, 0)).toBe(-17); expect(f.call(84, 0, 1)).toBe(0);
  f.memory.writeString(16, "before", 64); f.memory.writeString(80, "127.0.0.1:27960", 64);
  const addWords = words(73, 3, 16, 80);
  f.io.resolveAddress = async (host, port) => {
    expect(host).toBe("127.0.0.1"); expect(port).toBe(27960);
    addWords.setInt32(4, 0, true); addWords.setInt32(8, 0, true); addWords.setInt32(12, 0, true);
    f.memory.writeString(16, "at insertion", 64);
    return { kind: "ipv4", host: [127, 0, 0, 1], port };
  };
  expect(await qvmBrowserSyscall("ui", addWords, f.memory, f.services)).toBe(1);
  f.call(67, 3, 0, 160, 1024);
  expect(infoValueForKey(f.memory.readString(160), "hostname")).toBe("at insertion");
  expect(f.call(65, 0)).toBe(0);
});

test("role guards and authored interpreter use the exact UI browser trap numbers", async () => {
  const f = await fixture();
  for (const role of ["game", "cgame"] satisfies readonly ("game" | "cgame")[]) {
    expect(qvmBrowserSyscall(role, words(), f.memory, f.services)).toBeNull();
  }
  for (const trap of [45, 50, 64, 75, 81, 86, 999]) expect(f.call(trap)).toBeNull();
  expect(() => f.call(68, 3, 0)).toThrow(RangeError);
  const code = new BinaryWriter(64);
  code.u8(QvmOpcode.OP_ENTER); code.i32(16);
  code.u8(QvmOpcode.OP_CONST); code.i32(3);
  code.u8(QvmOpcode.OP_ARG); code.u8(8);
  code.u8(QvmOpcode.OP_CONST); code.i32(-66);
  code.u8(QvmOpcode.OP_CALL);
  code.u8(QvmOpcode.OP_LEAVE); code.i32(16);
  const bytes = code.finish(), file = new BinaryWriter(32 + bytes.length);
  for (const value of [0x12721444, 6, 32, bytes.length, 32 + bytes.length, 0, 0, 512]) file.i32(value);
  file.bytes(bytes);
  await f.add("actual owner");
  const vm = new QvmInterpreter(parseQvm(file.finish(), "authored-browser.qvm"), call => {
    const result = qvmBrowserSyscall("ui", call.words, new QvmMemory(call.memory), f.services);
    if (result === null) throw new Error("Unexpected authored browser trap");
    return result;
  });
  expect(await vm.invoke([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(1);
});
