import { describe, expect, test } from "bun:test";
import { BotActionBuffer, BotActionFlag } from "../src/botlib/actions.ts";
import { waitForCall } from "../src/core/call-steps.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import { qvmBotActionSyscall } from "../src/vm/bot-action-syscalls.ts";
import { QvmMemory } from "../src/vm/memory.ts";

function argumentsView(...words: number[]): DataView {
  const view = new DataView(new ArrayBuffer(words.length * 4));
  for (const [index, word] of words.entries()) view.setInt32(index * 4, word, true);
  return view;
}

function floatWord(value: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getInt32(0, true);
}

function vector(memory: QvmMemory, pointer: number, x: number, y: number, z: number): void {
  const view = memory.view(pointer, 12);
  view.setFloat32(0, x, true);
  view.setFloat32(4, y, true);
  view.setFloat32(8, z, true);
}

function setup() {
  const memory = new QvmMemory(new Uint8Array(256));
  const commands: { client: number; command: string }[] = [];
  const actions = new BotActionBuffer(2, { *clientCommand(client, command): CallSteps { commands.push({ client, command }); } });
  const call = (...words: number[]) => qvmBotActionSyscall("game", argumentsView(...words), memory, actions);
  return { memory, actions, commands, call };
}

describe("game VM elementary bot actions over the actual action owner", () => {
  test("other roles and unrelated traps never read dependent arguments", () => {
    const { memory, actions, call } = setup();
    expect(qvmBotActionSyscall("cgame", argumentsView(), memory, actions)).toBeNull();
    expect(qvmBotActionSyscall("ui", argumentsView(), memory, actions)).toBeNull();
    for (const trap of [399, 424, -1, 500]) expect(call(trap)).toBeNull();
    expect(() => call()).toThrow(RangeError);
    expect(() => call(400)).toThrow(RangeError);
  });

  test("say, team say and command preserve byte strings and source callback order", () => {
    const { memory, actions, commands, call } = setup();
    memory.bytes.set([0x68, 0x69, 0x80, 0xff, 0, 0x78], 24);
    actions.shutdown();
    expect(call(400, -1, 24)).toBe(0);
    expect(call(401, 42, 24)).toBe(0);
    expect(call(402, 42, 24)).toBe(0);
    expect(commands).toEqual([
      { client: -1, command: "say hi\x80\xff" },
      { client: 42, command: "say_team hi\x80\xff" },
      { client: 42, command: "hi\x80\xff" },
    ]);
  });

  test("command traps finish only after the reached GAME callback completes", async () => {
    for (const [trap, text] of [[400, "say hello"], [401, "say_team hello"], [402, "hello"]] satisfies readonly [number, string][]) {
      const memory = new QvmMemory(new Uint8Array(256));
      memory.writeString(16, "hello", 6);
      const words = argumentsView(trap, 7, 16);
      const gate = Promise.withResolvers<undefined>();
      const events: string[] = [];
      const actions = new BotActionBuffer(1, {
        *clientCommand(client, command): CallSteps {
          events.push(`enter ${client} ${command}`);
          yield* waitForCall(() => gate.promise);
          events.push(`leave ${client} ${command}`);
        },
      });
      const result = qvmBotActionSyscall("game", words, memory, actions);
      expect(result).toBeInstanceOf(Promise);
      expect(events).toEqual([`enter 7 ${text}`]);
      words.setInt32(4, 99, true);
      memory.writeString(16, "other", 6);
      gate.resolve(undefined);
      expect(await result).toBe(0);
      expect(events).toEqual([`enter 7 ${text}`, `leave 7 ${text}`]);
    }
  });

  test("rejected GAME callbacks propagate and direct calls do not launch asynchronous work", async () => {
    const memory = new QvmMemory(new Uint8Array(256));
    memory.writeString(16, "hello", 6);
    const failure = new Error("nested GAME failed");
    let started = 0;
    const actions = new BotActionBuffer(1, {
      *clientCommand(): CallSteps {
        yield* waitForCall(() => { started++; return Promise.reject(failure); });
        throw new Error("Unreachable callback tail");
      },
    });
    expect(() => actions.say(0, "hello")).toThrow("Cannot synchronously finish");
    expect(started).toBe(0);
    await expect(qvmBotActionSyscall("game", argumentsView(400, 0, 16), memory, actions)).rejects.toBe(failure);
    expect(started).toBe(1);
  });

  test("each flag trap changes the source flag on only its selected client", () => {
    const { actions, call } = setup();
    const flags: readonly [number, number][] = [
      [404, 0x20000], [405, 0x10000], [406, 1], [407, 2], [408, 8],
      [409, 0x80], [410, 0x20], [411, 0x100], [412, 0x200],
      [413, 0x800], [414, 0x1000], [415, 0x2000], [417, 0x10], [418, 0x8000],
    ];
    for (const [trap, flag] of flags) {
      call(423, 1);
      call(423, 1);
      expect(call(trap, 1)).toBe(0);
      expect(actions.getInput(1, 0).actionFlags).toBe(flag);
      expect(actions.getInput(0, 0).actionFlags).toBe(0);
    }
    expect(call(403, 1, -0x80000000)).toBe(-1);
    expect(actions.getInput(1, 0).actionFlags).toBe(-0x7fff8000);
    expect(call(416, 1, -2147483648)).toBe(0);
    expect(actions.getInput(1, 0).weapon).toBe(-2147483648);
  });

  test("move and view read binary32 vectors and GetInput writes the exact 40-byte layout", () => {
    const { memory, actions, call } = setup();
    vector(memory, 16, 0.1, -0, -3.25);
    vector(memory, 32, -15.5, 270.25, 0);
    expect(call(419, 1, 16, floatWord(1.5))).toBe(0);
    expect(call(420, 1, 32)).toBe(0);
    call(403, 1, 0x81234567 | 0);
    call(416, 1, -7);
    memory.bytes.fill(0xa5, 63, 105);
    expect(call(422, 1, floatWord(0.125), 64)).toBe(0);
    const out = memory.view(64, 40);
    expect(Array.from({ length: 8 }, (_, index) => out.getFloat32(index * 4, true))).toEqual([
      0.125, Math.fround(0.1), -0, -3.25, 1.5, -15.5, 270.25, 0,
    ]);
    expect(out.getInt32(32, true)).toBe(0x81234567 | 0);
    expect(out.getInt32(36, true)).toBe(-7);
    expect(memory.bytes[63]).toBe(0xa5);
    expect(memory.bytes[104]).toBe(0xa5);
    expect(actions.getInput(0, 0).speed).toBe(0);
    call(419, 1, 16, floatWord(401));
    expect(actions.getInput(1, 0).speed).toBe(400);
    call(419, 1, 16, floatWord(-401));
    expect(actions.getInput(1, 0).speed).toBe(-400);
    call(419, 1, 16, floatWord(-0));
    expect(actions.getInput(1, 0).speed).toBe(-0);
  });

  test("reset retains view and weapon and the shared crouch/jumped bit inhibits both jump traps", () => {
    const { memory, actions, call } = setup();
    vector(memory, 16, 1, 2, 3);
    call(419, 0, 16, floatWord(12));
    call(420, 0, 16);
    call(416, 0, 5);
    call(417, 0);
    call(422, 0, floatWord(0.5), 64);
    expect(call(423, 0)).toBe(0);
    expect(actions.getInput(0, 0)).toEqual({
      thinkTime: 0, direction: { x: 0, y: 0, z: 0 }, speed: 0,
      viewAngles: { x: 1, y: 2, z: 3 }, actionFlags: 0x80, weapon: 5,
    });
    call(417, 0);
    call(418, 0);
    expect(actions.getInput(0, 0).actionFlags).toBe(0x80);
    call(423, 0);
    call(418, 0);
    expect(actions.getInput(0, 0).actionFlags).toBe(0x8000);
    call(409, 0);
    call(418, 0);
    expect(actions.getInput(0, 0).actionFlags).toBe(0x80);
  });

  test("EndRegular remains empty for invalid clients and nonfinite time after shutdown", () => {
    const { memory, actions, call } = setup();
    actions.attack(0);
    expect(call(421, 0, floatWord(0.25))).toBe(0);
    expect(actions.getInput(0, 0).actionFlags).toBe(BotActionFlag.ATTACK);
    actions.shutdown();
    for (const time of [Number.NaN, Infinity, -Infinity]) {
      expect(call(421, -2147483648, floatWord(time), 0)).toBe(0);
    }
    expect(() => call(421, 0)).toThrow(RangeError);
    expect(memory.bytes).toEqual(new Uint8Array(256));
  });

  test("owner selection precedes vector pointer reads and GetInput output resolution", () => {
    const { actions, call } = setup();
    for (const words of [[419, 2, 0, 0], [420, 2, 0], [422, 2, 0, 0]]) {
      expect(() => call(...words)).toThrow("bot action client");
    }
    actions.shutdown();
    expect(() => call(419, 0, 0, 0)).toThrow("shut down");
    expect(() => call(420, 0, 0)).toThrow("shut down");
    expect(() => call(422, 0, 0, 0)).toThrow("shut down");
  });

  test("GetInput updates the real owner before output-span failure", () => {
    const actions = new BotActionBuffer(1, { *clientCommand(): CallSteps {} });
    const memory = new QvmMemory(new Uint8Array(128).fill(0xa5));
    actions.attack(0);
    const bytes = actions.getInputBytes(0, 0);
    const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const pointer of [0, 89]) {
      input.setFloat32(0, 0, true);
      expect(() => qvmBotActionSyscall("game", argumentsView(422, 0, floatWord(0.75), pointer), memory, actions)).toThrow(RangeError);
      expect(input.getFloat32(0, true)).toBe(0.75);
      expect(input.getInt32(32, true)).toBe(1);
      expect(memory.bytes).toEqual(new Uint8Array(128).fill(0xa5));
    }
  });

  test("argument words are captured before command callbacks and overlapping output writes", () => {
    const memory = new QvmMemory(new Uint8Array(256));
    const words = memory.view(64, 16);
    const commands: { client: number; command: string }[] = [];
    const actions = new BotActionBuffer(1, {
      *clientCommand(client, command): CallSteps {
        words.setInt32(4, 123, true);
        words.setInt32(8, 0, true);
        memory.bytes.fill(0, 16, 24);
        actions.attack(client);
        commands.push({ client, command });
      },
    });
    memory.writeString(16, "attack", 8);
    words.setInt32(0, 402, true);
    words.setInt32(4, 0, true);
    words.setInt32(8, 16, true);
    expect(qvmBotActionSyscall("game", words, memory, actions)).toBe(0);
    expect(commands).toEqual([{ client: 0, command: "attack" }]);
    words.setInt32(0, 422, true);
    words.setInt32(4, 0, true);
    words.setFloat32(8, 0.625, true);
    words.setInt32(12, 64, true);
    expect(qvmBotActionSyscall("game", words, memory, actions)).toBe(0);
    expect(words.getFloat32(0, true)).toBe(0.625);
    expect(memory.view(96, 4).getInt32(0, true)).toBe(1);
  });

  test("masked unaligned pointers, nonzero byte-zero alias and exact-end output respect borrowed bounds", () => {
    const backing = new Uint8Array(288).fill(0xa5);
    const memory = new QvmMemory(backing.subarray(16, 272));
    const actions = new BotActionBuffer(1, { *clientCommand(): CallSteps {} });
    vector(memory, 17, -0, 2, 3);
    qvmBotActionSyscall("game", argumentsView(419, 0, -239, floatWord(0.25)), memory, actions);
    qvmBotActionSyscall("game", argumentsView(422, 0, floatWord(-0), 216), memory, actions);
    expect(memory.view(216, 40).getFloat32(4, true)).toBe(-0);
    qvmBotActionSyscall("game", argumentsView(422, 0, floatWord(1), 256), memory, actions);
    expect(memory.view(256, 40).getFloat32(0, true)).toBe(1);
    expect(backing.subarray(0, 16)).toEqual(new Uint8Array(16).fill(0xa5));
    expect(backing.subarray(272)).toEqual(new Uint8Array(16).fill(0xa5));
  });

  test("truncated words and unterminated, null or short input spans reject without commands", () => {
    const { memory, actions, commands, call } = setup();
    memory.bytes.fill(0xff);
    for (const trap of [400, 401, 402]) {
      expect(() => call(trap, 0, 255)).toThrow("no terminator");
      expect(() => call(trap, 0, 0)).toThrow("nonnull");
      expect(() => call(trap, 0)).toThrow(RangeError);
    }
    expect(commands).toEqual([]);
    expect(() => call(419, 0, 16)).toThrow(RangeError);
    expect(() => call(422, 0, 0)).toThrow(RangeError);
    for (const pointer of [0, 245]) {
      expect(() => call(419, 0, pointer, 0)).toThrow(RangeError);
      expect(() => call(420, 0, pointer)).toThrow(RangeError);
    }
    expect(actions.getInput(0, 0).direction).toEqual({ x: 0, y: 0, z: 0 });
  });

  test("nonfinite source action values are stored and infinite movement speeds are capped", () => {
    const { memory, actions, call } = setup();
    vector(memory, 16, 1, 2, 3);
    expect(call(419, 0, 16, floatWord(Infinity))).toBe(0);
    expect(actions.getInput(0, 0)).toMatchObject({ direction: { x: 1, y: 2, z: 3 }, speed: 400 });
    expect(call(419, 0, 16, floatWord(-Infinity))).toBe(0);
    expect(actions.getInput(0, 0).speed).toBe(-400);
    vector(memory, 16, 4, Number.NaN, 6);
    expect(call(419, 0, 16, floatWord(NaN))).toBe(0);
    expect(actions.getInput(0, 0)).toMatchObject({ direction: { x: 4, y: NaN, z: 6 }, speed: NaN });
    expect(call(420, 0, 16)).toBe(0);
    expect(call(422, 0, floatWord(NaN), 64)).toBe(0);
    expect(memory.view(64, 40).getFloat32(0, true)).toBeNaN();
    expect(memory.view(64, 40).getFloat32(24, true)).toBeNaN();
  });

  test("GetInput copies untouched noncanonical float words from the actual source record", () => {
    const { memory, actions, call } = setup();
    const bytes = actions.getInputBytes(0, 0), raw = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const words = [0x7f800001, 0xff800042, 0x80000000, 0x7fc12345, 0xffc45678, 0x00000001, 0x7fffffff, 0xdeadbeef, 0xfedcba98];
    for (const [index, word] of words.entries()) raw.setUint32(4 + index * 4, word, true);
    expect(call(422, 0, floatWord(.25), 64)).toBe(0);
    const output = memory.view(64, 40);
    expect(output.getFloat32(0, true)).toBe(.25);
    for (const [index, word] of words.entries()) expect(output.getUint32(4 + index * 4, true)).toBe(word);
  });
});
