import { expect, test } from "bun:test";
import { BotChatLibrary, type ChatDiagnostic } from "../src/botlib/chat.ts";
import { BotLog } from "../src/botlib/log.ts";
import { BotLibVars } from "../src/botlib/libvars.ts";
import { BotMemory, type BotMemoryAllocation } from "../src/botlib/memory.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import { MemoryBotScriptReader } from "./helpers/bot-script-reader.ts";

test("source chat dumps write retained lists, key fragments and initial-chat flushes", () => {
  const writes: string[] = [], prints: ChatDiagnostic[] = [];
  let flushes = 0;
  const variables = new BotLibVars(); variables.set("log", "1");
  const log = new BotLog({ variables, globals: { time: 0 }, print: () => undefined,
    openFile: () => ({ kind: "opened", stream: {
      write: bytes => { writes.push(new TextDecoder().decode(bytes)); return { kind: "ok" }; },
      flush: () => { flushes++; return { kind: "ok" }; }, close: () => ({ kind: "ok" }),
    } }),
  });
  const reader = new MemoryBotScriptReader(new Map([
    ["syn.c", `1 { [("one", 1.125), ("two", 1.375)] }`],
    ["rnd.c", `hello = { "first"; "last"; }`],
    ["match.c", `1 { "hello "|"hi ", 0 = (7, 9); }`],
    ["rchat.c", `["hello", &female, !male, (0, "hi"|"hello")] = 2.5 { "reply"; }`],
    ["bots/chat.c", `chat "bot" { type "hello" { "first"; "last"; } }`],
  ]));
  const chat = new BotChatLibrary(reader, {
    random: { nextInt: () => 0 }, time: () => 0,
    *clientCommand(): CallSteps {}, report: issue => { prints.push(issue); },
  }, { log, maxMessages: 2 });
  chat.setup(); const handle = chat.allocate();
  expect(chat.replaceReplySynonyms("\x80two", 1)).toBe("\x80one");
  expect(chat.replaceReplySynonyms("prefix\x80two", 1)).toBe("prefix\x80one");
  expect(chat.loadChatFile(handle, "bots/chat.c", "bot")).toBe(true);
  chat.dumpSynonymList(); chat.dumpRandomStringList(); chat.dumpMatchTemplates(); chat.dumpReplyChat();
  expect(writes).toEqual([]);
  log.open("chat.log");
  chat.dumpSynonymList();
  expect(writes.join("")).toBe(`1 : [("one", 1.12), ("two", 1.38)]\n`);
  writes.length = 0;
  chat.dumpRandomStringList();
  expect(writes.join("")).toBe(`hello = {"last", "first"}\n`);
  writes.length = 0;
  chat.dumpMatchTemplates();
  expect(writes.join("")).toBe(`{ "hello "|"hi ", 0 = (7, 9);}\n`);
  writes.length = 0;
  chat.dumpReplyChat();
  expect(writes.join("")).toBe(`BotDumpReplyChat:\n[(0, "hi"), !male, &female, "hello"] = 2\n{\n\t"reply";\n}\n`);
  expect(flushes).toBe(0);
  prints.length = 0;
  chat.printReplyChatKeys(0);
  expect(prints.map(issue => issue.message).join("")).toBe(`[(0, "hi"), !male, &female, "hello"] = 2\n{\n`);
  writes.length = 0;
  chat.logInitialChat(handle);
  expect(writes).toEqual(["{", ` type "hello"`, " {", "  numchatmessages = 2", `  "last"`, `  "first"`, " }", "}"]);
  expect(flushes).toBe(8);
  log.close(); chat.shutdown();
});

test("developer integrity uses the source missing-string log and temporary heap list", () => {
  const events: string[] = [];
  class Memory extends BotMemory {
    override allocate(size: number, kind: "heap" | "hunk", clear: boolean): BotMemoryAllocation {
      if (kind === "heap") events.push(`allocate ${size} ${clear}`);
      return super.allocate(size, kind, clear);
    }
    override free(allocation: BotMemoryAllocation): void {
      const bytes = allocation.bytes;
      if (bytes.length === 12 || bytes.length === 14) events.push(`free ${new TextDecoder().decode(bytes.subarray(8, bytes.length - 1))}`);
      super.free(allocation);
    }
  }
  const variables = new BotLibVars(); variables.set("log", "1");
  const log = new BotLog({ variables, globals: { time: 0 }, print: () => undefined,
    openFile: () => ({ kind: "opened", stream: {
      write: bytes => { events.push(new TextDecoder().decode(bytes)); return { kind: "ok" }; },
      flush: () => ({ kind: "ok" }), close: () => ({ kind: "ok" }),
    } }),
  });
  log.open("integrity.log");
  const reader = new MemoryBotScriptReader(new Map([
    ["syn.c", ""], ["rnd.c", ""], ["match.c", ""],
    ["rchat.c", `["hello"] = 1 { first; end; first; }`],
  ]));
  const chat = new BotChatLibrary(reader, { random: { nextInt: () => 0 }, time: () => 0,
    *clientCommand(): CallSteps {},
  }, { log, developer: () => true, maxMessages: 2 }, new Memory());
  chat.setup();
  expect(events).toEqual([
    `first = {"first"} //MISSING RANDOM\r\n`, "allocate 14 true",
    `end = {"end"} //MISSING RANDOM\r\n`, "allocate 12 true",
    "free end", "free first",
  ]);
  log.close(); chat.shutdown();
});

test("chat source print branches preserve messages and separate expansion warnings", () => {
  const prints: ChatDiagnostic[] = [];
  const reader = new MemoryBotScriptReader(new Map([
    ["syn.c", ""], ["rnd.c", `loop = { loop; }`], ["match.c", ""], ["rchat.c", ""],
    ["bots/chat.c", `chat "bot" { type "hello" { loop; } }`],
  ]));
  const chat = new BotChatLibrary(reader, { random: { nextInt: () => 0 }, time: () => 0,
    *clientCommand(): CallSteps {}, report: issue => { prints.push(issue); },
  }, { maxMessages: 2, reloadCharacters: () => true });
  chat.setup(); const handle = chat.allocate();
  expect(chat.loadChatFile(handle, "bots/chat.c", "bot")).toBe(true);
  prints.length = 0;
  chat.initialChat(handle, "hello", 0);
  expect(prints.map(issue => [issue.severity, issue.message])).toEqual([
    ["warning", "too many expansions in chat message"], ["warning", "\x01rloop\x01"],
  ]);
  prints.length = 0;
  chat.numConsoleMessages(0); chat.numConsoleMessages(64);
  expect(prints.map(issue => issue.message)).toEqual(["chat state handle 0 out of range", "invalid chat state 64"]);
  prints.length = 0;
  expect(chat.loadChatFile(handle, "missing.c", "bot")).toBe(false);
  expect(prints.map(issue => issue.message)).toEqual(["counldn't load missing.c", "couldn't load chat bot from missing.c"]);
  expect(prints.every(issue => issue.location === null)).toBe(true);
  chat.shutdown();
});
