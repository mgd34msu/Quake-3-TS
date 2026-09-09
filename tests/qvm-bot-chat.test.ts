import { describe, expect, test } from "bun:test";
import { BotChatLibrary } from "../src/botlib/chat.ts";
import type { BotChatHost, BotChatOptions, ChatDiagnostic } from "../src/botlib/chat.ts";
import { waitForCall } from "../src/core/call-steps.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import { QVM_BOT_MATCH_BYTES, QVM_CONSOLE_MESSAGE_BYTES } from "../src/vm/bot-chat-record.ts";
import { qvmBotChatSyscall } from "../src/vm/bot-chat-syscalls.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { MemoryBotScriptReader } from "./helpers/bot-script-reader.ts";

const INITIAL = 'chat "bot" { type "hello" { "hello"; } type "compose" { "~",0,"/",1,"/",7; } type "tilde" { "~~hi~~~there~"; } }';
const MATCHES = `1 { 0," says ",1 = (7,9); } 4 { 0," says ",1," stop" = (11,12); }
  8 { "${"x".repeat(128)}",0,"!" = (21,22); }`;

class Host implements BotChatHost {
  now = 0;
  timeCalls = 0;
  randomCalls = 0;
  randomValue = 0;
  onTime: () => void = () => {};
  onRandom: () => void = () => {};
  onReport: (issue: ChatDiagnostic) => void = () => {};
  onCommand: () => void = () => {};
  readonly commands: { readonly client: number; readonly command: string }[] = [];
  readonly diagnostics: ChatDiagnostic[] = [];
  readonly random = { nextInt: (): number => { this.randomCalls++; this.onRandom(); return this.randomValue; } };
  time(): number { this.timeCalls++; this.onTime(); return this.now; }
  *clientCommand(client: number, command: string): CallSteps { this.commands.push({ client, command }); this.onCommand(); }
  report(issue: ChatDiagnostic): void { this.diagnostics.push(issue); this.onReport(issue); }
}

function words(...values: number[]): DataView {
  const result = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, index) => result.setInt32(index * 4, value, true));
  return result;
}

function fixture(options: BotChatOptions = {}, host = new Host()) {
  const reader = new MemoryBotScriptReader(new Map([
    ["syn.c", '1 { [("do not",1),("don\'t",1)] } 2 { [("I",1),("you",0)] }'],
    ["rnd.c", ""], ["match.c", MATCHES], ["rchat.c", '["hello"] = 1 { 0,"/",7; }'],
    ["bots/authored.c", INITIAL],
  ]));
  const chat = new BotChatLibrary(reader, host, options);
  const memory = new QvmMemory(new Uint8Array(4096).fill(165));
  memory.writeString(32, "bots/authored.c", 16);
  memory.writeString(64, "bot", 4);
  memory.writeString(96, "hello", 6);
  memory.writeString(128, "hello", 6);
  memory.writeString(160, "Ada", 4);
  const call = (args: DataView, role: "game" | "cgame" | "ui" = "game") => qvmBotChatSyscall(role, args, memory, chat);
  const load = (handle: number) => call(words(522, handle, 32, 64));
  return { reader, host, chat, memory, call, load };
}

describe("QVM bot chat authored boundary", () => {
  test("enter chat retains normalized pending text until the GAME callback returns", async () => {
    const gate = Promise.withResolvers<undefined>();
    class WaitingHost extends Host {
      override *clientCommand(client: number, command: string): CallSteps {
        yield* super.clientCommand(client, command);
        yield* waitForCall(() => gate.promise);
      }
    }
    const { chat, host, call, load } = fixture({}, new WaitingHost());
    const handle = chat.allocate();
    load(handle);
    chat.setName(handle, "Ada", 3);
    chat.initialChat(handle, "tilde", 0);
    const result = call(words(516, handle, 9, 2));
    expect(result).toBeInstanceOf(Promise);
    expect(host.commands).toEqual([{ client: 3, command: "tell 9 ~hi~there" }]);
    expect(chat.chatLength(handle)).toBe(9);
    gate.resolve(undefined);
    expect(await result).toBe(0);
    expect(chat.chatLength(handle)).toBe(0);
  });

  test("enter chat callback rejection preserves its pending message and error identity", async () => {
    const failure = new Error("GAME chat callback failed");
    class RejectingHost extends Host {
      override *clientCommand(client: number, command: string): CallSteps {
        yield* super.clientCommand(client, command);
        yield* waitForCall(() => Promise.reject(failure));
      }
    }
    const { chat, call, load } = fixture({}, new RejectingHost());
    const handle = chat.allocate();
    load(handle);
    chat.initialChat(handle, "tilde", 0);
    const result = call(words(516, handle, 0, 0));
    await expect(result).rejects.toBe(failure);
    expect(chat.chatLength(handle)).toBe(9);
    expect(chat.getChatMessage(handle)).toBe("hithere");
  });

  test("recognizes game chat traps and uses the actual state allocation", () => {
    const { chat, call } = fixture();
    expect(call(new DataView(new ArrayBuffer(0)), "ui")).toBeNull();
    expect(call(new DataView(new ArrayBuffer(0)), "cgame")).toBeNull();
    for (const trap of [0, 506, 525, 568, 571]) expect(call(words(trap))).toBeNull();
    expect(chat.allocate()).toBe(1);
    expect(call(words(507))).toBe(2);
    expect(call(words(508, 1))).toBe(0);
    expect(chat.allocate()).toBe(1);
    for (let index = 3; index <= 64; index++) expect(call(words(507))).toBe(index);
    expect(call(words(507))).toBe(0);
  });

  test("invalid states and full console heaps do not read unreachable pointers", () => {
    const { chat, host, memory, call } = fixture({ maxMessages: 2 });
    const handle = chat.allocate(), before = memory.bytes.slice();
    expect(call(words(509, handle, 7, 0))).toBe(0);
    expect(host.diagnostics.at(-1)?.code).toBe("message-heap-full");
    for (const args of [
      words(509, -1, 7, 0), words(510, -1, 1), words(511, -1, 0), words(512, -1),
      words(513, -1, 0, 0, 4095, 0, 0, 0, 0, 0, 0, 0),
      words(514, -1, 0, 0, 0, 4095, 0, 0, 0, 0, 0, 0, 0),
      words(515, -1), words(516, -1, 0, 0), words(523, -1, 1), words(524, -1, 0, 2),
      words(569, -1, 0), words(570, -1, 0, -1),
    ]) expect(call(args)).toBe(0);
    expect(call(words(522, -1, 0, 0))).toBe(8);
    expect(call(words(511, handle, 0))).toBe(0);
    expect(call(words(513, handle, 0, 0, 4095, 0, 0, 0, 0, 0, 0, 0))).toBe(0);
    expect(memory.bytes).toEqual(before);
    expect(host.timeCalls).toBe(0);
    chat.setup();
    call(words(509, handle, 1, 128)); call(words(509, handle, 2, 128));
    expect(call(words(509, handle, 3, 0))).toBe(0);
    expect(call(words(512, handle))).toBe(2);
    expect(host.timeCalls).toBe(2);
  });

  test("writes the 276-byte console ABI including source-cleared links and byte tails", () => {
    const { chat, host, memory, call } = fixture();
    chat.setup(); const handle = chat.allocate(); host.now = 0.1;
    memory.bytes.set([255, 65, 0, 99], 128);
    expect(call(words(509, handle, -17, 128))).toBe(0);
    expect(chat.nextConsoleMessage(handle)).toEqual({ handle: 1, time: Math.fround(0.1), type: -17, message: "\xffA" });
    expect(call(words(511, handle, -3584))).toBe(1);
    const view = memory.view(512, QVM_CONSOLE_MESSAGE_BYTES);
    expect(view.getInt32(0, true)).toBe(1);
    expect(view.getFloat32(4, true)).toBe(Math.fround(0.1));
    expect(view.getInt32(8, true)).toBe(-17);
    expect(Array.from(memory.bytes.subarray(524, 528))).toEqual([255, 65, 0, 0]);
    expect(memory.bytes.subarray(526, 788).every(byte => byte === 0)).toBe(true);
    expect(memory.bytes[511]).toBe(165); expect(memory.bytes[788]).toBe(165);
    expect(call(words(510, handle, 1))).toBe(0);
    expect(chat.nextConsoleMessage(handle)).toBeNull();
    const copied = memory.bytes.slice(512, 788);
    expect(call(words(511, handle, 512))).toBe(0);
    expect(memory.bytes.subarray(512, 788)).toEqual(copied);
  });

  test("console strncpy reads at most 256 bytes and accepts an unterminated full message", () => {
    const { chat, memory, call } = fixture(); chat.setup(); const handle = chat.allocate();
    memory.bytes.fill(255, 3840);
    expect(call(words(509, handle, 9, 3840))).toBe(0);
    expect(chat.nextConsoleMessage(handle)?.message).toBe("\xff".repeat(256));
    expect(call(words(511, handle, 512))).toBe(1);
    expect(memory.bytes.subarray(524, 780).every(byte => byte === 255)).toBe(true);
    expect(memory.bytes.subarray(780, 788).every(byte => byte === 0)).toBe(true);
    const before = memory.bytes.slice();
    expect(() => call(words(511, handle, 3900))).toThrow(RangeError);
    expect(memory.bytes).toEqual(before);
    expect(chat.numConsoleMessages(handle)).toBe(1);
  });

  test("console words are captured before time callbacks, while message bytes are read afterward", () => {
    const { chat, host, memory, call } = fixture(); chat.setup(); const handle = chat.allocate();
    const args = words(509, handle, 9, 128);
    host.onTime = () => {
      memory.writeString(128, "changed", 8);
      args.setInt32(8, 99, true); args.setInt32(12, 0, true);
    };
    call(args);
    expect(chat.nextConsoleMessage(handle)?.message).toBe("changed");
    expect(chat.nextConsoleMessage(handle)?.type).toBe(9);
  });

  test("a reached bad console input retains the source allocation and handle increment", () => {
    const { chat, host, call } = fixture({ maxMessages: 2 }); chat.setup(); const handle = chat.allocate();
    expect(() => call(words(509, handle, 1, 0))).toThrow(RangeError);
    expect(chat.numConsoleMessages(handle)).toBe(0);
    call(words(509, handle, 2, 128));
    expect(chat.nextConsoleMessage(handle)?.handle).toBe(2);
    expect(call(words(509, handle, 3, 0))).toBe(0);
    expect(host.diagnostics.at(-1)?.code).toBe("message-heap-full");
  });

  test("initial and reply selection defer variable reads and retain source word arguments", () => {
    const { chat, host, memory, call, load } = fixture(); chat.setup(); const handle = chat.allocate(); expect(load(handle)).toBe(0);
    memory.writeString(96, "compose", 8);
    const args = words(513, handle, 96, 0, 160, 0, 0, 0, 0, 0, 0, 192);
    memory.writeString(192, "last", 5);
    host.onRandom = () => { memory.writeString(160, "new", 4); args.setInt32(16, 0, true); };
    expect(call(args)).toBe(0);
    expect(chat.getChatMessage(handle)).toBe("new//last");
    memory.writeString(96, "missing", 8);
    expect(call(words(513, handle, 96, 0, 4095, 0, 0, 0, 0, 0, 0, 0))).toBe(0);
    memory.writeString(128, "absent", 7);
    expect(call(words(514, handle, 128, 0, 0, 4095, 0, 0, 0, 0, 0, 0, 0))).toBe(0);
    memory.writeString(128, "hello", 6);
    expect(call(words(514, handle, 128, 0, 0, 160, 0, 0, 0, 0, 0, 0, 192))).toBe(1);
    expect(chat.getChatMessage(handle)).toBe("new/last");
  });

  test("reply key checks reread input after earlier random callbacks while captures retain their copy", () => {
    const { chat, host, reader, memory, call } = fixture();
    reader.files.set("rchat.c", '["changed"] = 2 { "later"; } ["hello"] = 1 { "first"; }');
    chat.setup(); const handle = chat.allocate();
    host.onRandom = () => { memory.writeString(128, "changed", 8); };
    expect(call(words(514, handle, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).toBe(1);
    expect(chat.getChatMessage(handle)).toBe("later");
    expect(host.randomCalls).toBe(2);
  });

  test("type comparisons skip null pointers and stop at an early byte mismatch", () => {
    const { chat, host, memory, call, load } = fixture(); const handle = chat.allocate(); load(handle);
    memory.bytes[4095] = 255;
    for (const pointer of [0, 4095]) {
      expect(call(words(569, handle, pointer))).toBe(0);
      expect(call(words(513, handle, pointer, 0, 4095, 0, 0, 0, 0, 0, 0, 0))).toBe(0);
    }
    expect(host.timeCalls).toBe(0); expect(host.randomCalls).toBe(0);
  });

  test("get message pads within capacity and removes tildes before output failures", () => {
    const { chat, memory, call, load } = fixture(); const handle = chat.allocate(); load(handle);
    chat.initialChat(handle, "tilde", 0);
    expect(() => call(words(570, handle, 0, 20))).toThrow(RangeError);
    expect(chat.chatLength(handle)).toBe("~hi~there".length);
    expect(call(words(570, handle, 1536, 15))).toBe(0);
    expect(memory.readString(1536)).toBe("hithere");
    expect(memory.bytes.subarray(1543, 1551).every(byte => byte === 0)).toBe(true);
    expect(memory.bytes[1551]).toBe(165); expect(call(words(515, handle))).toBe(0);
    chat.initialChat(handle, "hello", 0);
    expect(call(words(570, handle, 1536, 3))).toBe(0);
    expect(Array.from(memory.bytes.subarray(1536, 1539))).toEqual([104, 101, 0]);
    expect(chat.chatLength(handle)).toBe(0);
  });

  test("name and gender setters feed actual commands and command failures preserve the stripped message", () => {
    const { chat, host, memory, call, load } = fixture(); const handle = chat.allocate(); load(handle);
    memory.bytes.fill(255, 4064);
    expect(call(words(524, handle, 4064, 7))).toBe(0);
    for (const [destination, prefix] of [[0, "say"], [1, "say_team"], [2, "tell 9"], [-7, "say"]] satisfies readonly (readonly [number, string])[]) {
      chat.initialChat(handle, "hello", 0);
      expect(call(words(516, handle, 9, destination))).toBe(0);
      expect(host.commands.at(-1)).toEqual({ client: 7, command: `${prefix} hello` });
    }
    chat.initialChat(handle, "tilde", 0);
    const failure = new Error("command failed");
    host.onCommand = () => { expect(chat.chatLength(handle)).toBe(9); throw failure; };
    expect(() => call(words(516, handle, 9, 1))).toThrow(failure);
    expect(chat.chatLength(handle)).toBe(9);
    expect(() => call(words(524, handle, 0, 11))).toThrow(RangeError);
    host.onCommand = () => {};
    chat.initialChat(handle, "hello", 0); call(words(516, handle, 0, 0));
    expect(host.commands.at(-1)?.client).toBe(11);
  });

  test("gender traps preserve source fallback and name matching uses the stored 31 bytes", () => {
    const { reader, chat, memory, call } = fixture();
    reader.files.set("rchat.c", '[female] = 1 { "female"; } [male] = 1 { "male"; } [it] = 1 { "none"; }');
    chat.setup(); const handle = chat.allocate();
    for (const [gender, expected] of [[1, "female"], [2, "male"], [-1, "none"]] satisfies readonly (readonly [number, string])[]) {
      call(words(523, handle, gender));
      expect(call(words(514, handle, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).toBe(1);
      expect(chat.getChatMessage(handle)).toBe(expected);
    }
    reader.files.set("rchat.c", '[name] = 1 { "named"; }'); chat.setup();
    memory.bytes.fill(65, 4064);
    call(words(524, handle, 4064, 3)); memory.writeString(128, "A".repeat(31), 32);
    expect(call(words(514, handle, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).toBe(1);
    expect(chat.getChatMessage(handle)).toBe("named");
  });

  test("load errors use BLERR codes, two passes, and publish after loaded callbacks", () => {
    const { chat, host, reader, call, load } = fixture(); const handle = chat.allocate();
    host.onReport = issue => {
      if (issue.code === "loaded") expect(chat.numInitialChats(handle, "hello")).toBe(0);
    };
    expect(load(handle)).toBe(0);
    expect(reader.reads).toEqual(["bots/authored.c", "bots/authored.c"]);
    expect(call(words(569, handle, 96))).toBe(1);
    const other = chat.allocate(); expect(load(other)).toBe(0);
    expect(reader.reads).toHaveLength(2);
    expect(call(words(522, -1, 0, 0))).toBe(8);
    reader.files.delete("bots/authored.c"); chat.freeChatFile(handle);
    expect(load(handle)).toBe(0);
  });

  test("failed initial chat loaders publish null before the outer fatal and reread names after inner diagnostics", () => {
    for (const source of [undefined, "invalid chat definition"]) {
      const { chat, host, reader, memory, call, load } = fixture(); const handle = chat.allocate();
      expect(load(handle)).toBe(0);
      chat.initialChat(handle, "hello", 0);
      memory.writeString(32, "bots/missing.c", 16);
      if (source !== undefined) reader.files.set("bots/missing.c", source);
      const args = words(522, handle, 32, 64), start = host.diagnostics.length;
      host.onReport = issue => {
        if (issue.code !== "load-error") return;
        if (issue.severity === "error") {
          memory.writeString(32, "bots/current.c", 16);
          memory.writeString(64, "current", 8);
          args.setInt32(8, 0, true); args.setInt32(12, 0, true);
        } else if (issue.severity === "fatal") {
          expect(chat.dumpInitialChat(handle)).toBeNull();
          expect(chat.chatLength(handle)).toBe(5);
        }
      };
      expect(call(args)).toBe(8);
      const errors = host.diagnostics.slice(start);
      expect(errors.map(issue => issue.severity)).toEqual(["error", "fatal"]);
      expect(errors.at(-1)?.message).toBe("couldn't load chat current from bots/current.c");
      expect(errors.at(-1)?.source).toBe("bots/current.c");
      const failure = new Error("outer fatal callback failed");
      host.onReport = issue => { if (issue.severity === "fatal") throw failure; };
      expect(() => load(handle)).toThrow(failure);
      expect(chat.dumpInitialChat(handle)).toBeNull();
      expect(chat.chatLength(handle)).toBe(5);
    }
  });

  test("load filenames, declaration names and cache copies retain each source callback read", () => {
    const { chat, host, reader, memory, call, load } = fixture(); const handle = chat.allocate();
    reader.files.set("bots/authored.c", '#include "rename.h"\nchat "third" { type "hello" { "first!"; } }');
    reader.files.set("rename.h", "");
    reader.files.set("bots/revised.c", 'chat "third" { type "hello" { "second"; } }');
    reader.beforeRead = path => {
      if (path === "bots/authored.c") { memory.writeString(32, "bots/revised.c", 16); memory.writeString(64, "second", 7); }
      if (path === "rename.h") memory.writeString(64, "third", 6);
    };
    host.onReport = issue => {
      if (issue.code !== "loaded") return;
      memory.writeString(32, "bots/cached.c", 16); memory.writeString(64, "cached", 7);
    };
    expect(load(handle)).toBe(0);
    expect(reader.reads).toEqual(["bots/authored.c", "rename.h", "bots/revised.c"]);
    chat.initialChat(handle, "hello", 0); expect(chat.getChatMessage(handle)).toBe("second");
    expect(call(words(522, chat.allocate(), 32, 64))).toBe(0);
    expect(reader.reads).toHaveLength(3);
  });

  test("load clears old chat before reload controls and checks reload again after publication", () => {
    let reloadReads = 0;
    const observations: number[] = [];
    const { chat, reader, memory, load } = fixture({ reloadCharacters: () => {
      reloadReads++; observations.push(chat.numInitialChats(handle, "hello"));
      if (reloadReads === 1) memory.writeString(32, "bots/revised.c", 16);
      return reloadReads === 2;
    } });
    const handle = chat.allocate();
    reader.files.set("bots/revised.c", INITIAL);
    expect(load(handle)).toBe(0);
    expect(observations).toEqual([0, 1]);
    expect(reader.reads).toEqual(["bots/revised.c", "bots/revised.c"]);
    expect(load(chat.allocate())).toBe(0);
    expect(reader.reads).toHaveLength(4);
  });

  test("a successful first load pass retains foundchat when the second pass has no matching name", () => {
    const { chat, reader, memory, load } = fixture(); const handle = chat.allocate();
    let passes = 0;
    reader.beforeRead = path => {
      if (path === "bots/authored.c" && ++passes === 2) memory.writeString(64, "absent", 7);
    };
    expect(load(handle)).toBe(0);
    expect(chat.dumpInitialChat(handle)).toEqual({ types: [] });
    expect(chat.numInitialChats(handle, "hello")).toBe(0);
  });

  test("initial-chat diagnostics occur twice and read current type text after option callbacks", () => {
    let enabled = false;
    const { chat, host, memory, call, load } = fixture({ testInitialChats: () => {
      if (enabled) memory.writeString(96, "changed", 8);
      return enabled;
    } });
    const handle = chat.allocate(); load(handle); enabled = true;
    expect(call(words(569, handle, 96))).toBe(1);
    expect(host.diagnostics.filter(issue => issue.code === "test-output").map(issue => issue.message))
      .toEqual(["changed has 1 chat lines", "-------------------"]);
  });

  test("find match writes exact fields, signed captures, padding and failed-match mutations", () => {
    const { chat, memory, call } = fixture(); chat.setup();
    memory.writeString(128, "\xffAda says hi\n\n", 15);
    expect(call(words(518, 128, 1024, 1))).toBe(1);
    const record = memory.view(1024, QVM_BOT_MATCH_BYTES);
    expect(memory.readString(1024)).toBe("\xffAda says hi");
    expect(record.getInt32(256, true)).toBe(7); expect(record.getInt32(260, true)).toBe(9);
    expect(record.getInt8(264)).toBe(0); expect(record.getInt32(268, true)).toBe(4);
    expect(record.getInt8(272)).toBe(10); expect(record.getInt32(276, true)).toBe(2);
    for (let index = 0; index < 8; index++) {
      expect(Array.from(memory.bytes.subarray(1024 + 265 + index * 8, 1024 + 268 + index * 8))).toEqual([165, 165, 165]);
      if (index >= 2) { expect(record.getInt8(264 + index * 8)).toBe(-1); expect(record.getUint32(268 + index * 8, true)).toBe(0xa5a5a5a5); }
    }
    memory.bytes.fill(165, 1024, 1024 + QVM_BOT_MATCH_BYTES);
    memory.writeString(128, "Ada says no", 12);
    expect(call(words(518, 128, 1024, 4))).toBe(0);
    expect(record.getUint32(256, true)).toBe(0xa5a5a5a5);
    expect(record.getInt8(264)).toBe(0); expect(record.getInt32(268, true)).toBe(3);
    expect(record.getInt8(272)).toBe(9); expect(record.getUint32(276, true)).toBe(0xa5a5a5a5);
    memory.writeString(128, `${"x".repeat(128)}hi!`, 132);
    expect(call(words(518, 128, 1024, 8))).toBe(1);
    expect(record.getInt8(264)).toBe(-128); expect(record.getInt32(268, true)).toBe(258);
  });

  test("find match gates untouched fields and preserves string writes before a later field failure", () => {
    const { chat, memory, call } = fixture(); chat.setup();
    expect(call(words(518, 128, 3840, 0))).toBe(0);
    expect(memory.readString(3840)).toBe("hello");
    memory.bytes.fill(165, 3840);
    expect(() => call(words(518, 128, 3840, 1))).toThrow(RangeError);
    expect(memory.readString(3840)).toBe("hello");
    memory.bytes.fill(90, 3840);
    memory.view(1024, 328).setInt32(256, 0, true);
    expect(call(words(518, 3840, 1024, 0))).toBe(0);
    expect(memory.bytes.subarray(1024, 1280).every(byte => byte === 90)).toBe(true);
    const before = memory.bytes.slice();
    expect(() => call(words(518, 0, 1024, 0))).toThrow(RangeError);
    expect(memory.bytes).toEqual(before);
  });

  test("match variable writes only its selected size and pads bounded bytes after NUL", () => {
    const { memory, call } = fixture();
    const record = memory.view(1024, 328);
    memory.bytes.set([88, 88, 88, 104, 105, 0, 90], 1024);
    record.setInt8(264, 3); record.setInt32(268, 6, true);
    expect(call(words(519, 1024, 0, 1536, 10))).toBe(0);
    expect(Array.from(memory.bytes.subarray(1536, 1544))).toEqual([104, 105, 0, 0, 0, 0, 0, 165]);
    memory.bytes.fill(165, 1536, 1552); record.setInt32(268, 2, true);
    call(words(519, 1024, 0, 1536, 10));
    expect(Array.from(memory.bytes.subarray(1536, 1540))).toEqual([104, 105, 0, 165]);
    memory.bytes.fill(165, 1024, 1280); memory.bytes.fill(165, 1536, 1552);
    call(words(519, 1024, 0, 1536, 1));
    expect(Array.from(memory.bytes.subarray(1536, 1538))).toEqual([0, 165]);
  });

  test("absent and invalid match variables clear one byte without reading irrelevant fields", () => {
    const { host, memory, call } = fixture();
    memory.bytes[4095] = 255;
    expect(call(words(519, 3775, 7, 1536, -9))).toBe(0);
    expect(Array.from(memory.bytes.subarray(1536, 1538))).toEqual([0, 165]);
    const args = words(519, 0, 8, 1568, 0);
    host.onReport = () => { args.setInt32(12, 0, true); };
    expect(call(args)).toBe(0);
    expect(host.diagnostics.at(-1)?.code).toBe("invalid-variable");
    expect(Array.from(memory.bytes.subarray(1568, 1570))).toEqual([0, 165]);
    expect(() => call(words(519, 0, 8, 0, 0))).toThrow(RangeError);
  });

  test("string contains checks both null pointers before reading and uses source byte case rules", () => {
    const { memory, call } = fixture();
    expect(call(words(517, 4095, 0, 0))).toBe(-1);
    expect(call(words(517, 0, 4095, 0))).toBe(-1);
    memory.writeString(128, "\xffQuAkE III", 11); memory.writeString(160, "quake", 6);
    expect(call(words(517, 128, 160, 0))).toBe(1);
    expect(call(words(517, 128, 160, -3))).toBe(-1);
    memory.writeString(160, "\xff", 2);
    expect(call(words(517, 128, 160, 0))).toBe(0);
    memory.writeString(160, "", 1); expect(call(words(517, 128, 160, 0))).toBe(0);
    expect(() => call(words(517, 4095, 160, 0))).toThrow(RangeError);
  });

  test("in-place whitespace and synonyms preserve source moves and untouched trailing bytes", () => {
    const { chat, memory, call } = fixture(); chat.setup();
    memory.writeString(128, "   a    b   ", 13);
    expect(call(words(520, 128))).toBe(0);
    expect(memory.readString(128)).toBe("a   b");
    expect(Array.from(memory.bytes.subarray(128, 141))).toEqual([97, 32, 32, 32, 98, 0, 32, 32, 0, 0, 32, 32, 0]);
    memory.writeString(128, "you!", 5);
    expect(call(words(521, 128, 2))).toBe(0);
    expect(Array.from(memory.bytes.subarray(128, 133))).toEqual([73, 33, 0, 33, 0]);
    memory.writeString(128, "don't", 6); expect(call(words(521, 128, 1))).toBe(0);
    expect(memory.readString(128)).toBe("do not");
    expect(call(words(521, 0, 0))).toBe(0);
    expect(() => call(words(521, 0, 1))).toThrow(RangeError);
    expect(() => call(words(520, 0))).toThrow(RangeError);
  });

  test("short argument blocks reject before owner calls and invalid reached sizes retain chat", () => {
    const { chat, host, call, load } = fixture(); const handle = chat.allocate(); load(handle);
    const before = host.diagnostics.length;
    for (const trap of [508, 509, 510, 511, 512, 513, 514, 515, 516, 517, 518, 519, 520, 521, 522, 523, 524, 569, 570]) {
      expect(() => call(words(trap))).toThrow(RangeError);
    }
    expect(host.diagnostics.length).toBe(before);
    chat.initialChat(handle, "hello", 0);
    expect(() => call(words(570, handle, 1536, 0))).toThrow(RangeError);
    expect(chat.chatLength(handle)).toBe(5);
    expect(() => call(words(570, handle, 4095, 2))).toThrow(RangeError);
    expect(chat.chatLength(handle)).toBe(5);
  });
});
