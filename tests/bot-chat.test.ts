import { BotScriptSources } from "../src/botlib/script-sources.ts";
import { MemoryBotScriptReader } from "./helpers/bot-script-reader.ts";
import { ScriptGlobalDefines } from "../src/script/preprocessor.ts";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { BotChatLibrary, ChatDestination, ChatGender, stringContains, unifyWhiteSpaces, type BotChatHost, type ChatConfiguration, type ChatDiagnostic } from "../src/botlib/chat.ts";
import { ChatDataParser, type MatchPiece } from "../src/botlib/chat-data.ts";
import { ScriptSourceReader } from "../src/script/preprocessor.ts";
import type { ScriptSource } from "../src/script/preprocessor.ts";
import { allocateScriptSource, ScriptLanguageError, type ScriptDiagnostic } from "../src/script/lexer.ts";
import { SOURCE_TOKEN_BYTES } from "../src/script/token-memory.ts";
import type { Product } from "../src/shared/definitions.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import { BotMemory, type BotMemoryAllocation } from "../src/botlib/memory.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";

const SYNONYMS = `1 { [("do not", 1), ("don't", 1)] } 2 { [("I",1),("you",0)] [("my",1),("your",0)] }`;
const RANDOMS = `greeting = { "first"; "last"; } nested = { greeting, " ", 0; }`;
const MATCHES = `1 { 0, " says ", 1 = (7, 9); } 2 { "hello "|"hi ", 0 = (3, 1); }`;
const REPLIES = `["hello"] = 5 { "hello-first"; "hello-last"; } [(0, " says ", 1)] = 8 { 1, " ", 0; }`;
const INITIAL = `chat "bot" { type "hello" { "first"; "last"; } type "compose" { "~", nested; } type "tildes" { "~~hello~~~world~"; } }`;

class ChatScriptReader extends MemoryBotScriptReader {
  constructor() {
    super(new Map([["syn.c", SYNONYMS], ["rnd.c", RANDOMS], ["match.c", MATCHES], ["rchat.c", REPLIES], ["bots/test_t.c", INITIAL]]));
  }
}
class Host implements BotChatHost {
  now = 0;
  randomValue = 0;
  randomCalls = 0;
  readonly commands: { readonly client: number; readonly command: string }[] = [];
  readonly issues: ChatDiagnostic[] = [];
  readonly random = { nextInt: (): number => { this.randomCalls++; return this.randomValue; } };
  time(): number { return this.now; }
  *clientCommand(client: number, command: string): CallSteps { this.commands.push({ client, command }); }
  report(issue: ChatDiagnostic): void { this.issues.push(issue); }
}
async function parser(text: string): Promise<ChatDataParser> {
  const source = ScriptSourceReader.open({ path: "fixture.c", text }, { resolve: () => undefined });
  return new ChatDataParser(source, "fixture.c");
}

class RecordedChatMemory extends BotMemory {
  readonly recordedAllocations: BotMemoryAllocation[] = [];
  readonly recordedSizes: number[] = [];
  readonly hunkAllocations: BotMemoryAllocation[] = [];
  readonly recordedFrees: BotMemoryAllocation[] = [];
  override allocate(size: number, kind: "heap" | "hunk", clear: boolean): BotMemoryAllocation {
    const allocation = super.allocate(size, kind, clear);
    this.recordedAllocations.push(allocation);
    this.recordedSizes.push(size);
    if (kind === "hunk") this.hunkAllocations.push(allocation);
    return allocation;
  }
  override free(allocation: BotMemoryAllocation): void {
    this.recordedFrees.push(allocation);
    super.free(allocation);
  }
}

class AllocatedChatScriptReader extends MemoryBotScriptReader {
  readonly openedSources: { readonly path: string; readonly allocation: BotMemoryAllocation }[] = [];
  constructor(files: Map<string, string>, private readonly memory: RecordedChatMemory) { super(files); }
  override resolveRoot(path: string): ScriptSource | undefined {
    const input = super.resolveRoot(path);
    if (input === undefined) return undefined;
    const firstAllocation = this.memory.recordedAllocations.length;
    const source = allocateScriptSource(input.text.length, path, this.memory);
    source.copyText(input.text);
    const allocation = this.memory.recordedAllocations[firstAllocation];
    if (allocation === undefined) throw new Error("missing allocated chat source");
    this.openedSources.push({ path, allocation });
    return source;
  }
}

describe("bot chat hunk ownership", () => {
  function fixture(capacity = 8192) {
    const arena = new HunkArena(capacity, () => undefined);
    const memory = new RecordedChatMemory({ kind: "source-hunk", accounting: new SourceHunkAccounting(arena) });
    const reader = new MemoryBotScriptReader(new Map([["syn.c", `1 { [("a",1),("b",2)] }`], ["rnd.c", `q = { "a"; "bc"; }`], ["match.c", ""], ["rchat.c", ""]]));
    const host = new Host(), library = new BotChatLibrary(reader, host, { maxMessages: 2 }, memory);
    return { arena, memory, reader, host, library };
  }
  function allocation(memory: RecordedChatMemory, index: number): BotMemoryAllocation {
    const result = memory.recordedAllocations[index];
    if (result === undefined) throw new Error(`missing chat allocation ${index}`);
    return result;
  }
  test("allocates source-sized synonym and random blocks before the second read", () => {
    const { arena, memory, reader, library } = fixture();
    const reads: { readonly path: string; readonly allocated: number }[] = [];
    reader.beforeRead = path => { reads.push({ path, allocated: memory.recordedAllocations.length }); };
    library.setup();
    expect(reads).toEqual([
      { path: "syn.c", allocated: 0 }, { path: "syn.c", allocated: 1 },
      { path: "rnd.c", allocated: 1 }, { path: "rnd.c", allocated: 2 },
      { path: "match.c", allocated: 2 }, { path: "rchat.c", allocated: 2 },
    ]);
    expect(memory.recordedAllocations.map(value => value.bytes.length)).toEqual([44, 39, 552]);
    expect(arena.memoryRemaining()).toBe(8192 - 64 - 64 - 576);
  });
  test("uses actual allocated synonym and random payload and numeric bytes", () => {
    const { memory, library } = fixture(); library.setup();
    allocation(memory, 0).bytes[28] = 122;
    allocation(memory, 1).bytes[36] = 120;
    expect(library.replaceSynonyms("b", 1)).toBe("z");
    expect(library.randomString("q")).toBe("xc");
    const bytes = allocation(memory, 0).bytes;
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(0, 2, true);
    expect(library.replaceSynonyms("b", 1)).toBe("b");
    expect(library.dumpConfiguration().synonyms[0]?.entries[0].text).toBe("z");
  });
  test("console records reuse real bytes and retain older heap messages across setup", () => {
    const { memory, library } = fixture(); library.setup(); const handle = library.allocate();
    library.queueConsoleMessage(handle, 4, "old");
    const original = allocation(memory, 2);
    original.bytes[12] = 79;
    expect(library.nextConsoleMessage(handle)?.message).toBe("Old");
    const snapshot = library.nextConsoleMessage(handle);
    library.setup();
    expect(library.nextConsoleMessage(handle)?.message).toBe("Old");
    library.removeConsoleMessage(handle, 1);
    library.queueConsoleMessage(handle, 5, "new");
    expect(original.bytes[12]).toBe(110);
    expect(snapshot?.message).toBe("Old");
    library.queueConsoleMessage(handle, 6, "second");
    library.queueConsoleMessage(handle, 7, "third");
    expect(library.numConsoleMessages(handle)).toBe(3);
  });
  test("random selection reads the live count after its callback and only the selected payload", () => {
    const { host, memory, library } = fixture(); library.setup();
    const bytes = allocation(memory, 1).bytes;
    bytes.fill(120, 36);
    host.randomValue = 32767;
    expect(library.randomString("q")).toBeNull();
    host.random.nextInt = () => {
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(4, 1, true);
      return 32767;
    };
    expect(library.randomString("q")).toBe("a");
  });
  test("expired hunk allocations reject retained chat payload and console reads", () => {
    const { arena, library } = fixture(); library.setup(); const handle = library.allocate();
    library.queueConsoleMessage(handle, 0, "message"); arena.clear(null);
    expect(() => library.nextConsoleMessage(handle)).toThrow("no longer valid");
    expect(() => library.randomString("q")).toThrow("no longer valid");
    expect(() => library.replaceSynonyms("b", 1)).toThrow("no longer valid");
    library.disposeResources();
  });
  test("hunk exhaustion aborts before opening the second synonym pass", () => {
    const { reader, library } = fixture(32);
    expect(() => library.setup()).toThrow("Hunk_Alloc failed");
    expect(reader.reads).toEqual(["syn.c"]);
  });
  test("failed second reads retain their reached allocation and continue later setup", () => {
    const { memory, reader, library } = fixture();
    reader.beforeRead = path => { if (path === "syn.c" && memory.recordedAllocations.length === 1) reader.files.delete(path); };
    library.setup();
    expect(memory.recordedAllocations.map(value => value.bytes.length)).toEqual([44, 39, 552]);
    expect(library.configurationCounts.synonyms).toBe(0);
    expect(library.randomString("q")).toBe("bc");
  });
  test("failed second-pass random parsing retains its completed message count and bytes", () => {
    const { memory, reader, library } = fixture();
    reader.beforeRead = path => {
      if (path === "rnd.c" && memory.recordedAllocations.length === 2) reader.files.set(path, `q = { "a"; "bc", }`);
    };
    library.setup();
    const bytes = allocation(memory, 1).bytes;
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true)).toBe(1);
    expect(bytes[26]).toBe(97);
    expect(library.configurationCounts.randomLists).toBe(0);
  });
});

describe("bot chat source parser", () => {
  test("preserves synonym context masking and reverse insertion orders", async () => {
    const synonyms = (await parser(`1 { [("a",1),("b",0)] 1 { [("c",1),("d",0)] } [("e",1),("f",0)] }`)).synonyms();
    expect(synonyms.map(group => group.context)).toEqual([1, 1, 0]);
    expect((await parser(RANDOMS)).randoms()[0]?.messages).toEqual(["last", "first"]);
    const chat = (await parser(INITIAL)).initial("BOT");
    expect(chat.types.map(type => type.name)).toEqual(["tildes", "compose", "hello"]);
    expect(chat.types[2]?.messages.map(message => message.text)).toEqual(["last", "first"]);
    const replies = (await parser(`["a", &name, !male] = 1.5 { "first"; "last"; } [female] = 2 { "female"; }`)).replies();
    expect(replies.map(reply => reply.priority)).toEqual([2, 1.5]);
    expect(replies[1]?.keys.map(key => key.mode)).toEqual(["not", "and", "any"]);
    expect(replies[1]?.messages.map(message => message.text)).toEqual(["last", "first"]);
  });
  test("uses source preprocessor macros and includes in chat definitions", async () => {
    const reader = new ChatScriptReader();
    reader.files.set("bots/test_t.c", `#include "chat.h"\nchat "bot" { type "hello" { WORD, VARIABLE; } }`);
    reader.files.set("chat.h", `#define WORD "source "\n#define VARIABLE 0`);
    const library = new BotChatLibrary(reader, new Host());
    const handle = library.allocate();
    expect(await library.loadChatFile(handle, "bots/test_t.c", "bot")).toBe(true);
    library.initialChat(handle, "hello", 0, ["match", null, null, null, null, null, null, null]);
    expect(library.getChatMessage(handle)).toBe("source match");
  });
  test("rejects malformed match variables, synonym lists and oversized messages", async () => {
    const adjacent = await parser(`1 { 0, 1 = (1, 0); }`);
    expect(() => adjacent.matches()).toThrow("adjacent variables");
    const emptyBridge = await parser(`1 { 0, ""|"then", 1 = (1, 0); }`);
    expect(() => emptyBridge.matches()).toThrow("adjacent variables");
    const outOfRange = await parser(`1 { 8 = (1, 0); }`);
    expect(() => outOfRange.matches()).toThrow("can't have more than 8 match variables");
    const singleton = await parser(`1 { [("a",1)] }`);
    expect(() => singleton.synonyms()).toThrow("at least two");
    const oversized = await parser(`word = { "${"a".repeat(256)}"; }`);
    expect(() => oversized.randoms()).toThrow("chat message too long");
  });
});

// Untouched be_ai_chat.c + q_shared.c + l_script.c + l_precomp.c, GCC16.2.1
// -DBOTLIB -fno-builtin-strcpy -std=gnu99 -O0, rand() host input.
// --wrap=strcpy pins forward byte copying for StripDoubleQuotes' overlapping
// strcpy; current glibc otherwise produces ASLR-dependent undefined corruption.
// Driver and output: /tmp/quake3-chat-reference-Cyns3x/reference{.c,}.
describe("native bot chat fixtures", () => {
  test("preserves moving-pointer whitespace and tilde deletion quirks", async () => {
    expect(unifyWhiteSpaces("   a    b   ")).toBe("a   b");
    expect(unifyWhiteSpaces("a!b!!c\td")).toBe("a b c d");
    expect(unifyWhiteSpaces("   one   two   three   four   ")).toBe("one two three four");
    expect(stringContains("Quake III", "III")).toBe(6);
    expect(stringContains(null, "III")).toBe(-1);
    expect(stringContains("AAA", "a", true)).toBe(-1);
    const library = new BotChatLibrary(new ChatScriptReader(), new Host()), handle = library.allocate();
    await library.loadChatFile(handle, "bots/test_t.c", "bot");
    library.initialChat(handle, "tildes", 0);
    expect(library.getChatMessage(handle)).toBe("~hello~world");
  });
  test("matches templates and extracts owned, byte-offset variables", async () => {
    const library = new BotChatLibrary(new ChatScriptReader(), new Host()); await library.setup();
    const match = library.findMatch("Sarge says hello\n", 1);
    expect(match?.type).toBe(7); expect(match?.subtype).toBe(9);
    if (match === null) throw new Error("missing native fixture match");
    expect(library.matchVariable(match, 0)).toBe("Sarge");
    expect(library.matchVariable(match, 1)).toBe("hello");
    expect(library.matchVariable(match, 1, 3)).toBe("he");
    expect(library.matchVariable(match, 7)).toBe("");
    expect(library.findMatch("Sarge says hello", 2)).toBeNull();
    expect(library.findMatch("HELLO Sarge", 2)?.type).toBe(3);
  });
  test("preserves synonym word scanning and endpoint random behavior", async () => {
    const host = new Host(), library = new BotChatLibrary(new ChatScriptReader(), host); await library.setup();
    expect(library.replaceSynonyms("don't don't!don't,don't.", 1)).toBe("do not don't!do not,don't.");
    expect(library.replaceSynonyms("don't", 2)).toBe("don't");
    expect(library.replaceReplySynonyms("you have your gun", 2)).toBe("I have my gun");
    expect(library.randomString("greeting")).toBe("last");
    host.randomValue = 32767;
    expect(library.randomString("greeting")).toBeNull();
    expect(library.replaceWeightedSynonyms("don't", 1)).toBe("don't");
  });
  test("initial selection shares cooldowns, oldest fallback, and inclusive endpoint", async () => {
    const host = new Host(), reader = new ChatScriptReader(), library = new BotChatLibrary(reader, host);
    const first = library.allocate(), second = library.allocate();
    await library.loadChatFile(first, "bots/test_t.c", "bot"); await library.loadChatFile(second, "bots/test_t.c", "bot");
    expect(reader.reads.filter(path => path.endsWith("test_t.c"))).toHaveLength(2);
    library.initialChat(first, "hello", 0); expect(library.getChatMessage(first)).toBe("last");
    library.initialChat(second, "hello", 0); expect(library.getChatMessage(second)).toBe("first");
    library.initialChat(first, "hello", 0); expect(library.getChatMessage(first)).toBe("last");
    host.now = 20; host.randomValue = 32767;
    library.initialChat(first, "hello", 0); expect(library.getChatMessage(first)).toBe("");
  });
});

describe("chat composition, replies and message ownership", () => {
  test("setup reports each failed configuration but preserves source success and usable later loads", async () => {
    const reader = new ChatScriptReader(), host = new Host();
    reader.files.delete("syn.c");
    reader.files.set("match.c", "invalid match input");
    const library = new BotChatLibrary(reader, host);
    await library.setup();
    expect(library.configurationCounts).toEqual({ synonyms: 0, randomLists: 2, matches: 0, replies: 2 });
    expect(library.randomString("greeting")).toBe("last");
    expect(host.issues.filter(issue => issue.code === "load-error").map(issue => issue.source))
      .toEqual(["syn.c", "match.c"]);
    const handle = library.allocate();
    expect(library.replyChat(handle, "hello", 0, 0)).toBe(true);
    expect(library.getChatMessage(handle)).toBe("hello-last");

    reader.files.clear();
    await library.setup();
    expect(library.configurationCounts).toEqual({ synonyms: 0, randomLists: 0, matches: 0, replies: 0 });
    expect(library.randomString("greeting")).toBeNull();
  });

  test("expands nested random strings, substitutes variables and sends exact local commands", async () => {
    const host = new Host(), library = new BotChatLibrary(new ChatScriptReader(), host); await library.setup();
    const handle = library.allocate(); await library.loadChatFile(handle, "bots/test_t.c", "bot"); library.setName(handle, "Sarge", 3);
    library.initialChat(handle, "compose", 0, ["player", null, null, null, null, null, null, null]);
    expect(library.chatLength(handle)).toBe(12); library.enterChat(handle, 7, ChatDestination.Tell);
    expect(host.commands).toEqual([{ client: 3, command: "tell 7 last player" }]); expect(library.chatLength(handle)).toBe(0);
    library.initialChat(handle, "hello", 0); library.enterChat(handle, 0, ChatDestination.Team);
    expect(host.commands[1]?.command).toBe("say_team last");
  });
  test("replies retain integer priority and pre-cooldown decrement behavior", async () => {
    const reader = new ChatScriptReader(); reader.files.set("rchat.c", `["hello"] = 1.1 { "earlier"; } ["hello"] = 1.9 { "later"; }`);
    const library = new BotChatLibrary(reader, new Host()); await library.setup(); const handle = library.allocate();
    expect(library.replyChat(handle, "hello", 0, 0)).toBe(true); expect(library.getChatMessage(handle)).toBe("earlier");
    expect(library.replyChat(handle, "hello", 0, 0)).toBe(true); expect(library.getChatMessage(handle)).toBe("earlier");
  });
  test("reply variables, gender/name requirements and exclusions follow source key rules", async () => {
    const reader = new ChatScriptReader(); reader.files.set("rchat.c", `[(0," says ",1), &female, &name, !"stop"] = 3 { 1, " ", 0; }`);
    const library = new BotChatLibrary(reader, new Host()); await library.setup(); const handle = library.allocate(); library.setName(handle, "Sarge", 0);
    expect(library.replyChat(handle, "Sarge says you", 0, 2)).toBe(false);
    library.setGender(handle, ChatGender.Female);
    expect(library.replyChat(handle, "Sarge says you", 0, 2)).toBe(true); expect(library.getChatMessage(handle)).toBe("I Sarge");
    expect(library.replyChat(handle, "Sarge says stop", 0, 2)).toBe(false);
  });
  test("console capacity starts at setup, is shared, and released messages detach", () => {
    const host = new Host(), library = new BotChatLibrary(new ChatScriptReader(), host, { maxMessages: 2 });
    const first = library.allocate(), second = library.allocate(); host.now = 0.1;
    library.queueConsoleMessage(first, 4, "before setup");
    expect(library.numConsoleMessages(first)).toBe(0); expect(library.nextConsoleMessage(first)).toBeNull();
    expect(host.issues.filter(issue => issue.code === "message-heap-full")).toHaveLength(1);
    library.setup();
    library.queueConsoleMessage(first, 4, "first"); library.queueConsoleMessage(second, 5, "second"); library.queueConsoleMessage(first, 4, "overflow");
    expect(library.numConsoleMessages(first)).toBe(1); expect(host.issues.filter(issue => issue.code === "message-heap-full")).toHaveLength(2);
    const snapshot = library.nextConsoleMessage(first); expect(snapshot).toEqual({ handle: 1, type: 4, time: Math.fround(0.1), message: "first" });
    library.removeConsoleMessage(first, 1); expect(library.nextConsoleMessage(first)).toBeNull(); expect(snapshot?.message).toBe("first");
    library.queueConsoleMessage(first, 7, "third"); library.free(second); library.queueConsoleMessage(first, 8, "fourth"); expect(library.numConsoleMessages(first)).toBe(2);
    expect(library.allocate()).toBe(second);
  });
  test("message handles wrap at 8192 and shutdown retains source state handle 64", () => {
    const library = new BotChatLibrary(new ChatScriptReader(), new Host(), { maxMessages: 2 }); const handle = library.allocate();
    library.setup();
    for (let index = 1; index <= 8193; index++) { library.queueConsoleMessage(handle, 0, "x"); const queued = library.nextConsoleMessage(handle); if (queued === null) throw new Error("queue unexpectedly empty"); expect(queued.handle).toBe((index - 1) % 8192 + 1); library.removeConsoleMessage(handle, queued.handle); }
    for (let index = 2; index <= 64; index++) expect(library.allocate()).toBe(index);
    expect(library.allocate()).toBe(0);
    library.queueConsoleMessage(64, 0, "retained");
    library.shutdown();
    expect(library.nextConsoleMessage(64)).toEqual({ handle: 1, type: 0, time: 0, message: "retained" });
    for (let index = 1; index < 64; index++) expect(library.allocate()).toBe(index);
    expect(library.allocate()).toBe(0);
    library.free(64); expect(library.allocate()).toBe(64);
  });
  test("reports load errors and expansion failures without fallback chats", async () => {
    const reader = new ChatScriptReader(), host = new Host(), library = new BotChatLibrary(reader, host);
    reader.files.delete("match.c"); await library.setup();
    expect(library.configurationCounts).toEqual({ synonyms: 3, randomLists: 2, matches: 0, replies: 2 });
    const handle = library.allocate(); expect(await library.loadChatFile(handle, "missing.c", "bot")).toBe(false);
    reader.files.set("bots/test_t.c", `chat "bot" { type "hello" { unknownRandom; } }`);
    await library.loadChatFile(handle, "bots/test_t.c", "bot"); library.initialChat(handle, "hello", 0);
    expect(host.issues.some(issue => issue.code === "expansion-error")).toBe(true); expect(library.getChatMessage(handle)).toBe("");
  });
  test("bounded expansion, debug output and detached dumps stay observable", async () => {
    const reader = new ChatScriptReader(), host = new Host();
    reader.files.set("rnd.c", `loop = { loop; }`);
    reader.files.set("bots/test_t.c", `chat "bot" { type "hello" { loop; } }`);
    const library = new BotChatLibrary(reader, host, { testInitialChats: () => true });
    await library.setup(); const handle = library.allocate(); await library.loadChatFile(handle, "bots/test_t.c", "bot");
    expect(library.numInitialChats(handle, "hello")).toBe(1);
    library.initialChat(handle, "hello", 0);
    expect(host.issues.filter(issue => issue.code === "expansion-limit")).toHaveLength(2);
    library.enterChat(handle, 1, ChatDestination.All); expect(host.commands).toEqual([]);
    expect(host.issues.filter(issue => issue.code === "test-output")).toHaveLength(3);
    const dump = library.dumpConfiguration(), line = dump.replies[0]?.messages[0];
    if (line === undefined) throw new Error("missing fixture reply");
    line.time = 900; expect(library.dumpConfiguration().replies[0]?.messages[0]?.time).toBe(-40);
    library.replyChat(handle, "hello", 0, 0); library.reset();
    expect(library.dumpConfiguration().replies.flatMap(reply => reply.messages).every(message => message.time === 0)).toBe(true);
  });
  test("source byte boundaries reject unsafe buffers and signed capture overflow", async () => {
    const library = new BotChatLibrary(new ChatScriptReader(), new Host()); await library.setup(); const handle = library.allocate();
    library.queueConsoleMessage(handle, 0, "a".repeat(256));
    expect(library.nextConsoleMessage(handle)?.message).toBe("a".repeat(256));
    library.removeConsoleMessage(handle, 1);
    expect(() => library.queueConsoleMessage(handle, 0, "😀")).toThrow("byte-valued");
    library.queueConsoleMessage(handle, 0, "before\0after"); expect(library.nextConsoleMessage(handle)?.message).toBe("before");
    expect(() => library.findMatch(`${"a".repeat(128)} says x`, 1)).toThrow("signed-char");
    expect(() => library.getChatMessage(handle, 0)).toThrow("positive");
    await library.loadChatFile(handle, "bots/test_t.c", "bot"); library.initialChat(handle, "hello", 0);
    expect(library.getChatMessage(handle, 3)).toBe("la"); expect(library.chatLength(handle)).toBe(0);
  });
  test("nochat skips reply reads while reloadcharacters bypasses shared cooldown caches", async () => {
    const reader = new ChatScriptReader(), library = new BotChatLibrary(reader, new Host(), { noChat: () => true, reloadCharacters: () => true });
    await library.setup(); expect(reader.reads).not.toContain("rchat.c"); expect(library.configurationCounts.replies).toBe(0);
    const first = library.allocate(), second = library.allocate();
    await library.loadChatFile(first, "bots/test_t.c", "bot"); await library.loadChatFile(second, "bots/test_t.c", "bot");
    library.initialChat(first, "hello", 0); library.initialChat(second, "hello", 0);
    expect(library.getChatMessage(first)).toBe("last"); expect(library.getChatMessage(second)).toBe("last");
    library.freeChatFile(first); expect(library.numInitialChats(first, "hello")).toBe(0);
  });
  test("developer integrity diagnostics preserve random draws and deduplicate missing names", async () => {
    const reader = new ChatScriptReader(), host = new Host();
    reader.files.set("rchat.c", `["hello"] = 1 { missing; missing; greeting; "\x01bad"; }`);
    const library = new BotChatLibrary(reader, host, { developer: () => true }); await library.setup();
    expect(host.randomCalls).toBe(1);
    expect(host.issues.filter(issue => issue.code === "missing-random")).toHaveLength(1);
    expect(host.issues.filter(issue => issue.code === "integrity-error")).toHaveLength(1);
  });
});

describe("chat synchronous ownership", () => {
  test("source read failures preserve reached frees, completed data and empty-piece leaks", () => {
    const memory = new RecordedChatMemory(), host = new Host();
    const reader = new AllocatedChatScriptReader(new Map([
      ["rnd.c", 'q = { "kept"; }\n#error top_stop\n#include "never.h"'],
      ["match.c", '1 { 0, 1 = (1,0); }\n#include "never.h"'],
      ["rchat.c", "[("],
      ["initial.c", 'chat "bot" {\n#error required_stop\n}'],
    ]), memory);
    let freesAtMatchError = -1;
    host.report = issue => {
      host.issues.push(issue);
      if (issue.message.includes("adjacent variables")) freesAtMatchError = memory.recordedFrees.length;
    };
    const library = new BotChatLibrary(reader, host, { maxMessages: 2 }, memory);
    library.setup();
    expect(reader.reads).toEqual(["rnd.c", "rnd.c", "match.c", "rchat.c"]);
    expect(library.randomString("q")).toBe("kept");
    expect(library.configurationCounts).toEqual({ synonyms: 0, randomLists: 1, matches: 0, replies: 0 });
    expect(host.issues.filter(issue => issue.message === "#error directive: top_stop")).toHaveLength(2);
    expect(host.issues.filter(issue => issue.source === "rchat.c")).toEqual([]);
    const matchSource = reader.openedSources.find(source => source.path === "match.c");
    const replySource = reader.openedSources.find(source => source.path === "rchat.c");
    const [, match, piece, reply, key] = memory.hunkAllocations;
    if (matchSource === undefined || replySource === undefined || match === undefined || piece === undefined || reply === undefined || key === undefined) {
      throw new Error("missing source chat allocation");
    }
    expect(memory.recordedFrees.slice(0, freesAtMatchError)).not.toContain(matchSource.allocation);
    expect(memory.recordedFrees.slice(freesAtMatchError).filter(allocation => allocation === matchSource.allocation || memory.hunkAllocations.includes(allocation)))
      .toEqual([matchSource.allocation, piece, match, key, reply]);
    expect(memory.recordedFrees).not.toContain(replySource.allocation);
    const handle = library.allocate();
    expect(library.loadChatFile(handle, "initial.c", "bot")).toBe(false);
    expect(host.issues.filter(issue => issue.source === "initial.c").map(issue => issue.message))
      .toEqual(["#error directive: required_stop", "couldn't read expected token", "couldn't load chat bot from initial.c"]);
    const initialSource = reader.openedSources.find(source => source.path === "initial.c");
    if (initialSource === undefined) throw new Error("missing initial chat source");
    expect(memory.recordedFrees).toContain(initialSource.allocation);
  });

  test("diagnostic, include and chat-name callback aborts preserve the thrown identity and reached allocations", () => {
    const diagnostic: ScriptDiagnostic = { severity: "error", message: "host callback abort", location: { path: "host", line: 1, column: 1 } };
    const primary = new ScriptLanguageError(diagnostic, [diagnostic]);
    const cases: readonly { readonly kind: "warning" | "lexer" | "include" | "name"; readonly text: string }[] = [
      { kind: "warning", text: '[&name] = 1 { "unused"; }\n#include "never.h"' },
      { kind: "lexer", text: '[name] = 1 { "unterminated' },
      { kind: "include", text: '[name] = 1 {\n#include "abort.h"' },
      { kind: "name", text: 'chat "bot" { type "hello" { "unused"; } }\n#include "never.h"' },
    ];
    for (const scenario of cases) {
      const memory = new RecordedChatMemory(), host = new Host(), path = scenario.kind === "name" ? "initial.c" : "rchat.c";
      const reader = new AllocatedChatScriptReader(new Map([[path, scenario.text], ["abort.h", "unused"]]), memory);
      if (scenario.kind === "include") reader.beforeRead = requested => { if (requested === "abort.h") throw primary; };
      host.report = issue => {
        host.issues.push(issue);
        if (issue.source === path && (scenario.kind === "warning" || scenario.kind === "lexer")) throw primary;
      };
      const library = new BotChatLibrary(reader, host, { maxMessages: 2 }, memory);
      let caught: unknown;
      try {
        if (scenario.kind === "name") library.loadChatFile(library.allocate(), path, () => { throw primary; });
        else library.setup();
      } catch (error) { caught = error; }
      expect(caught).toBe(primary);
      const retainedSizes = scenario.kind === "name"
        ? [316, 2148 + scenario.text.length + 1, 1024, 3144, 4096]
        : [2148 + scenario.text.length + 1, 1024, 3144, 4096, 20, 16];
      const tokenSizes = scenario.kind === "warning" || scenario.kind === "name"
        ? [SOURCE_TOKEN_BYTES] : [SOURCE_TOKEN_BYTES, SOURCE_TOKEN_BYTES, SOURCE_TOKEN_BYTES];
      expect(memory.recordedSizes).toEqual([...retainedSizes, ...tokenSizes]);
      const tokenIndexes = scenario.kind === "name" ? [5] : scenario.kind === "warning" ? [6] : [6, 7, 8];
      expect(memory.recordedFrees).toEqual(tokenIndexes.map(index => {
        const allocation = memory.recordedAllocations[index];
        if (allocation === undefined) throw new Error(`missing unread chat token allocation ${index}`);
        return allocation;
      }));
      expect(memory.recordedAllocations.slice(0, retainedSizes.length).map(allocation => allocation.bytes.length))
        .toEqual(retainedSizes);
      expect(reader.reads).toEqual(scenario.kind === "include" ? [path, "abort.h"] : [path]);
      expect(library.configurationCounts.replies).toBe(0);
    }
  });

  test("a reporting failure precedes publication of the loaded chat and cache", () => {
    const reader = new ChatScriptReader(), host = new Host(), primary = new Error("report boundary failed");
    const library = new BotChatLibrary(reader, {
      random: host.random, time: () => 0, *clientCommand(): CallSteps {}, report: () => { throw primary; },
    });
    const handle = library.allocate();
    expect(() => library.loadChatFile(handle, "bots/test_t.c", "bot")).toThrow(primary);
    expect(library.numInitialChats(handle, "hello")).toBe(0);
    const another = library.allocate();
    expect(() => library.loadChatFile(another, "bots/test_t.c", "bot")).toThrow(primary);
    expect(reader.reads).toEqual(["bots/test_t.c", "bots/test_t.c", "bots/test_t.c", "bots/test_t.c"]);
  });

  test("integrity diagnostics stop with their setup owner after report-time shutdown", () => {
    const reader = new ChatScriptReader(), host = new Host();
    reader.files.set("rchat.c", '["hello"] = 1 { missingFirst; missingSecond; }');
    const reported: ChatDiagnostic[] = [];
    const library = new BotChatLibrary(reader, {
      random: host.random, time: () => 0, *clientCommand(): CallSteps {}, report: issue => {
        reported.push(issue);
        if (issue.code === "missing-random") library.shutdown();
      },
    }, { developer: () => true });
    library.setup();
    expect(reported.filter(issue => issue.code === "missing-random")).toHaveLength(1);
    expect(library.configurationCounts).toEqual({ synonyms: 0, randomLists: 0, matches: 0, replies: 0 });
  });

  test("shutdown and handle reuse happen after a completed load, with no pending reader", () => {
    const reader = new ChatScriptReader(), library = new BotChatLibrary(reader, new Host());
    const old = library.allocate();
    expect(library.loadChatFile(old, "bots/test_t.c", "bot")).toBe(true);
    expect(reader.reads).toEqual(["bots/test_t.c", "bots/test_t.c"]);
    library.shutdown();
    const handle = library.allocate(); expect(handle).toBe(old);
    expect(library.numInitialChats(handle, "hello")).toBe(0);
    expect(library.loadChatFile(handle, "bots/test_t.c", "bot")).toBe(true);
    library.initialChat(handle, "hello", 0); expect(library.getChatMessage(handle)).toBe("last");
  });
  test("diagnostic shutdown stops the old setup before the next source read", () => {
    const reader = new ChatScriptReader();
    let replaced = false;
    const host = new Host();
    const library = new BotChatLibrary(reader, { ...host, random: host.random, time: () => 0, *clientCommand(): CallSteps {}, report: issue => {
      if (issue.code !== "loaded" || replaced) return;
      expect(reader.reads).toEqual(["syn.c", "syn.c"]);
      expect(library.configurationCounts).toEqual({ synonyms: 0, randomLists: 0, matches: 0, replies: 0 });
      replaced = true; library.shutdown(); library.setup();
    } });
    library.setup();
    expect(reader.reads).toEqual(["syn.c", "syn.c", "syn.c", "syn.c", "rnd.c", "rnd.c", "match.c", "rchat.c"]);
    expect(library.configurationCounts.synonyms).toBe(3);
    expect(library.replaceSynonyms("don't", 1)).toBe("do not");
  });
  test("report-time free and reuse cannot make the old load own the new state", () => {
    const reader = new ChatScriptReader(), host = new Host();
    let replaced = false, fresh = 0;
    const library = new BotChatLibrary(reader, { random: host.random, time: () => 0, *clientCommand(): CallSteps {}, report: issue => {
      if (issue.code !== "loaded" || replaced) return;
      replaced = true; library.free(old); fresh = library.allocate();
      expect(library.loadChatFile(fresh, "bots/test_t.c", "bot")).toBe(true);
    } });
    const old = library.allocate();
    expect(library.loadChatFile(old, "bots/test_t.c", "bot")).toBe(false);
    expect(fresh).toBe(old);
    library.initialChat(fresh, "hello", 0); expect(library.getChatMessage(fresh)).toBe("last");
    expect(reader.reads).toEqual(["bots/test_t.c", "bots/test_t.c", "bots/test_t.c", "bots/test_t.c"]);
  });
  test("sequential loads publish one shared cooldown identity immediately", () => {
    const reader = new ChatScriptReader(), library = new BotChatLibrary(reader, new Host());
    const first = library.allocate(), second = library.allocate();
    expect(library.loadChatFile(first, "bots/test_t.c", "bot")).toBe(true);
    expect(library.loadChatFile(second, "bots/test_t.c", "bot")).toBe(true);
    library.initialChat(second, "hello", 0); expect(library.getChatMessage(second)).toBe("last");
    library.initialChat(first, "hello", 0); expect(library.getChatMessage(first)).toBe("first");
    expect(reader.reads).toEqual(["bots/test_t.c", "bots/test_t.c"]);
  });
  test("a replacement load in a report preserves its own published chat", () => {
    const reader = new ChatScriptReader();
    reader.files.set("bots/next.c", 'chat "bot" { type "hello" { "replacement"; } }');
    const host = new Host(); let replaced = false;
    const library = new BotChatLibrary(reader, { random: host.random, time: () => 0, *clientCommand(): CallSteps {}, report: issue => {
      if (issue.code !== "loaded" || replaced) return;
      replaced = true; expect(library.loadChatFile(handle, "bots/next.c", "bot")).toBe(true);
    } });
    const handle = library.allocate();
    expect(library.loadChatFile(handle, "bots/test_t.c", "bot")).toBe(false);
    library.initialChat(handle, "hello", 0); expect(library.getChatMessage(handle)).toBe("replacement");
  });
});

const DATA = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
class NativeChatHash {
  value = 2166136261;
  byte(value: number): void { this.value = Math.imul(this.value ^ (value & 255), 16777619) >>> 0; }
  word(value: number): void { for (let index = 0; index < 4; index++) this.byte(value >>> (8 * index)); }
  float(value: number): void { const bits = new DataView(new ArrayBuffer(4)); bits.setFloat32(0, value, true); this.word(bits.getUint32(0, true)); }
  text(value: string): void { for (let index = 0; index < value.length; index++) this.byte(value.charCodeAt(index)); this.byte(0); }
  pieces(pieces: readonly MatchPiece[]): void {
    for (const piece of pieces) {
      this.word(piece.kind === "variable" ? 1 : 2);
      if (piece.kind === "variable") this.word(piece.index); else for (const text of piece.alternatives) this.text(text);
    }
    this.word(0);
  }
  configuration(config: ChatConfiguration): void {
    for (const group of config.synonyms) { this.word(group.context); this.float(group.totalWeight); for (const entry of group.entries) { this.text(entry.text); this.float(entry.weight); } this.byte(255); }
    for (const list of config.randomLists) { this.text(list.name); this.word(list.messages.length); for (const message of list.messages) this.text(message); }
    for (const match of config.matches) { this.word(match.context); this.word(match.type); this.word(match.subtype); this.pieces(match.pieces); }
    for (const reply of config.replies) {
      this.float(reply.priority);
      for (const key of reply.keys) {
        const mode = key.mode === "and" ? 1 : key.mode === "not" ? 2 : 0;
        switch (key.test.kind) {
          case "name": this.word(mode | 4); break;
          case "string": this.word(mode | 8); this.text(key.test.text); break;
          case "match": this.word(mode | 16); this.pieces(key.test.pieces); break;
          case "botnames": this.word(mode | 32); this.text(key.test.names); break;
          case "gender": this.word(mode | (key.test.gender === 1 ? 64 : key.test.gender === 2 ? 128 : 256)); break;
        }
      }
      this.word(0); this.word(reply.messages.length); for (const message of reply.messages) this.text(message.text);
    }
  }
}
// Native BotLoadInitialChat type/message totals from both merged product VFSes.
const RETAIL_COUNTS = new Map<string, readonly [number, number]>([
  ["anarki", [100, 393]], ["angel", [97, 330]], ["biker", [100, 365]], ["bitterman", [100, 349]], ["bones", [100, 338]],
  ["cadavre", [100, 364]], ["crash", [100, 329]], ["daemia", [100, 396]], ["didcotmassif", [97, 293]], ["doom", [100, 407]],
  ["tao", [100, 235]], ["taa", [100, 235]], ["tad", [100, 235]], ["example", [98, 235]], ["fritzkrieg", [100, 355]],
  ["gorre", [100, 369]], ["grunt", [99, 370]], ["hossman", [100, 377]], ["hunter", [100, 393]], ["keel", [100, 352]],
  ["klesk", [100, 368]], ["lucy", [100, 357]], ["major", [99, 356]], ["malaki", [97, 315]], ["mynx", [100, 394]],
  ["orbb", [99, 360]], ["patriot", [100, 348]], ["phobos", [100, 369]], ["pi", [99, 333]], ["ranger", [100, 363]],
  ["razor", [100, 375]], ["sarge", [99, 395]], ["slash", [99, 371]], ["sorlag", [100, 324]], ["stripe", [100, 356]],
  ["tankjr", [100, 348]], ["tim", [98, 264]], ["trillian", [98, 263]], ["uriel", [100, 377]], ["visor", [98, 369]],
  ["wrack", [100, 363]], ["xaero", [100, 394]], ["xian", [98, 258]],
]);
test.skipIf(!existsSync(DATA))("retail merged chat corpus loads both product configurations and every bot chat", async () => {
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    const reader = await VirtualFileSystem.openInspection({ dataPath: DATA, homePath: DATA, cdPath: null, product }), library = new BotChatLibrary(new BotScriptSources(reader, new ScriptGlobalDefines(), (_severity, text) => { throw new Error(text); }, (_text: string): undefined => undefined), new Host()); await library.setup();
    expect(library.configurationCounts).toEqual({ synonyms: 191, randomLists: 249, matches: 182, replies: 457 });
    const configurationHash = new NativeChatHash(); configurationHash.configuration(library.dumpConfiguration()); expect(configurationHash.value).toBe(3847978505);
    const files = reader.list("botfiles/bots/").filter(path => path.endsWith("_t.c")); expect(files).toHaveLength(42);
    const handle = library.allocate(), initialHash = new NativeChatHash();
    for (const file of files) {
      const text = new TextDecoder().decode(await reader.read(file));
      const names = [...text.matchAll(/\bchat\s+"([^"]*)"/g)].map(match => match[1]);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        if (name === undefined) throw new Error(`missing chat name in ${file}`);
        const loaded = library.loadChatFile(handle, file.slice("botfiles/".length), name);
        initialHash.text(name); initialHash.word(loaded ? 1 : 0);
        if (name === "cadaver") { expect(loaded).toBe(false); continue; }
        expect(loaded).toBe(true);
        const chat = library.dumpInitialChat(handle);
        if (chat === null) throw new Error(`missing loaded chat ${name}`);
        for (const type of chat.types) { initialHash.text(type.name); initialHash.word(type.messages.length); for (const message of type.messages) initialHash.text(message.text); }
        const counts = RETAIL_COUNTS.get(name);
        if (counts === undefined) throw new Error(`missing native chat counts for ${name}`);
        expect([chat.types.length, chat.types.reduce((sum, type) => sum + type.messages.length, 0)]).toEqual([...counts]);
      }
    }
    const errors = library.diagnostics.filter(issue => issue.severity === "error" || issue.severity === "fatal");
    expect(initialHash.value).toBe(2700937545);
    expect(errors).toHaveLength(2); expect(errors[0]?.source).toBe("bots/cadaver_t.c"); expect(errors[0]?.message).toBe("expected ,, found HELLO4");
    expect(errors[1]?.severity).toBe("fatal");
  }
}, 30_000);
