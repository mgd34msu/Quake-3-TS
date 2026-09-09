import { expect, test } from "bun:test";
import { BotChatLibrary, type ChatDiagnostic } from "../src/botlib/chat.ts";
import { ChatDataParser } from "../src/botlib/chat-data.ts";
import { ScriptSourceReader } from "../src/script/preprocessor.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import { MemoryBotScriptReader } from "./helpers/bot-script-reader.ts";

test("chat parsers preserve source error text and embedded trailing newlines", () => {
  const cases: { readonly text: string; readonly parse: (parser: ChatDataParser) => unknown; readonly message: string }[] = [
    { text: "}", parse: p => p.synonyms(), message: "too many }" },
    { text: '[("",1),("a",1)]', parse: p => p.synonyms(), message: "empty string" },
    { text: '[("a",1)]', parse: p => p.synonyms(), message: "synonym must have at least two entries\n" },
    { text: '1 { 8 = (1,0); }', parse: p => p.matches(), message: "can't have more than 8 match variables\n" },
    { text: '1 { 0,1 = (1,0); }', parse: p => p.matches(), message: "not allowed to have adjacent variables\n" },
    { text: '1 { bad = (1,0); }', parse: p => p.matches(), message: "invalid token bad\n" },
    { text: 'bad {}', parse: p => p.matches(), message: "expected integer, found bad\n" },
    { text: 'random = { +; }', parse: p => p.randoms(), message: "unknown message component +\n" },
    { text: `random = { "${"x".repeat(256)}"; }`, parse: p => p.randoms(), message: "chat message too long\n" },
    { text: 'chat "bot" { bad }', parse: p => p.initial("bot"), message: "expected type found bad\n" },
  ];
  for (const item of cases) {
    const source = ScriptSourceReader.open({ path: "fixture.c", text: item.text }, { resolve: () => undefined });
    const parser = new ChatDataParser(source, "fixture.c");
    expect(() => item.parse(parser)).toThrow(item.message);
    expect(parser.diagnostics.at(-1)?.message).toBe(item.message);
    parser.dispose();
  }
});

test("missing initial chat is ordinary print output and fixed names use retained strncpy bytes", () => {
  const issues: ChatDiagnostic[] = [];
  const name = "x".repeat(32);
  const reader = new MemoryBotScriptReader(new Map([
    ["syn.c", ""], ["rnd.c", ""], ["match.c", ""], ["rchat.c", ""],
    ["chat.c", `chat "bot" { type "${name}suffix" { "line"; } }`],
  ]));
  const chat = new BotChatLibrary(reader, { random: { nextInt: () => 0 }, time: () => 0,
    *clientCommand(): CallSteps {}, report: issue => { issues.push(issue); },
  }, { maxMessages: 2, reloadCharacters: () => true });
  chat.setup(); const handle = chat.allocate();
  issues.length = 0;
  expect(chat.loadChatFile(handle, "chat.c", "absent")).toBe(false);
  expect(issues.map(issue => [issue.severity, issue.message, issue.location])).toEqual([
    ["error", "couldn't find chat absent in chat.c", null],
    ["fatal", "couldn't load chat absent from chat.c", null],
  ]);
  expect(chat.loadChatFile(handle, "chat.c", "bot")).toBe(true);
  // strncpy fills all 32 bytes; the following little-endian count supplies byte 33 and NUL.
  expect(chat.numInitialChats(handle, `${name}\x01`)).toBe(1);
  chat.shutdown();
});

test("reply-key validation emits each source warning verbatim", () => {
  const cases = [
    { keys: "&name", message: "all keys have a & or ! prefix" },
    { keys: '&"need",("other")', message: "one of the match templates does not leave space for the key need with the & prefix" },
    { keys: '!"bad","bad word"', message: "the key bad with prefix ! is inside the key bad word" },
    { keys: '!"bad",("bad")', message: "the key bad with prefix ! is inside the match template string bad" },
    { keys: '(0),"plain"', message: "variables from the match template(s) could be invalid when outputting one of the chat messages" },
  ];
  for (const item of cases) {
    const source = ScriptSourceReader.open({ path: "fixture.c", text: `[${item.keys}] = 1 { "reply"; }` }, { resolve: () => undefined });
    const parser = new ChatDataParser(source, "fixture.c");
    parser.replies();
    expect(parser.diagnostics.map(issue => issue.message)).toEqual([item.message]);
    parser.freeGraphs(); parser.dispose();
  }
});
