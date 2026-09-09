import { expect, test } from "bun:test";
import { BotCharacterLibrary } from "../src/botlib/character.ts";
import { BotLog } from "../src/botlib/log.ts";
import { BotLibVars } from "../src/botlib/libvars.ts";
import { MemoryBotScriptReader } from "./helpers/bot-script-reader.ts";

test("interpolation reaches the source character dump and qualifies its undefined skill format", () => {
  const writes: string[] = [];
  const variables = new BotLibVars(); variables.set("log", "1");
  const log = new BotLog({ variables, globals: { time: 0 }, print: () => undefined,
    openFile: () => ({ kind: "opened", stream: {
      write: bytes => { writes.push(new TextDecoder().decode(bytes)); return { kind: "ok" }; },
      flush: () => ({ kind: "ok" }), close: () => ({ kind: "ok" }),
    } }),
  });
  const source = `skill 1 { 0 "Bot" 2 0.25 3 0.0078125 } skill 4 { 0 "Bot" 2 0.75 3 0.0078125 }`;
  const reader = new MemoryBotScriptReader(new Map([["bots/default_c.c", source], ["bots/test.c", source]]));
  const library = new BotCharacterLibrary(reader, { log });
  const handle = library.load("bots/test.c", 2);
  expect(handle).toBeGreaterThan(0);
  expect(writes).toEqual([]);
  expect(library.diagnostics.some(issue => issue.message.includes("interpolated skill"))).toBe(false);
  log.open("characters.log");
  expect(library.load("bots/test.c", 3)).toBeGreaterThan(0);
  expect(writes).toEqual(["bots/test.c", "{\n", "    0 Bot\n", "    2 0.583333\n", "    3 0.007812\n", "}\n"]);
  expect(library.diagnostics.filter(issue => issue.code === "unsupported-log-format").map(issue => issue.message))
    .toEqual(["BotDumpCharacter: omitted undefined skill log format (%d receives a promoted float)"]);
  const retained = library.load("bots/test.c", 3);
  expect(library.float(retained, 2)).toBeGreaterThan(0.25);
  log.close(); library.shutdown();
});
