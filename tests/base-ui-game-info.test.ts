import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { infoValueForKey } from "../src/core/info-string.ts";
import { CvarFlag } from "../src/core/cvar.ts";
import { BaseUiGameInfo } from "../src/ui/base/game-info.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";
import { sourceZip } from "./pk3-source-fixture.ts";
import type { SourceZipEntry } from "./pk3-source-fixture.ts";

async function fixture(entries: Readonly<Record<string, string>> | null, packed: boolean | readonly SourceZipEntry[] = false) {
  const ui = await baseFixture();
  const directory = entries === null ? null : mkdtempSync(join(tmpdir(), "quake3-ui-game-info-"));
  const root = directory ?? process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  const sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: root, homePath: root, cdPath: null, product: "baseq3" }, text => { ui.prints.push(text); }, sound, ui.cvars);
  try {
    if (entries !== null && directory !== null) {
      mkdirSync(join(directory, "baseq3", "scripts"), { recursive: true });
      writeFileSync(join(directory, "baseq3", "default.cfg"), "fixture\n");
      if (packed) {
        const encoder = new TextEncoder();
        writeFileSync(join(directory, "baseq3", "pak0.pk3"), sourceZip(packed === true ? Object.entries(entries).map(([name, text]) => ({
          name: encoder.encode(name), data: encoder.encode(text), method: 8, utf8: false,
        })) : packed));
      } else {
        for (const [name, text] of Object.entries(entries)) writeFileSync(join(directory, "baseq3", name), text, "latin1");
      }
    }
    await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
    const game = new BaseUiGameInfo(ui.state, files);
    return { ...ui, files, game, directory, close: () => {
      try { files.close(); } finally { sound.close(); ui.close(); ui.assets.files.close(); if (directory !== null) rmSync(directory, { recursive: true, force: true }); }
    } };
  } catch (error) {
    files.close(); sound.close(); ui.close(); ui.assets.files.close();
    if (directory !== null) rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function field(info: string | null, key: string): string {
  if (info === null) throw new Error(`Missing catalog entry for ${key}`);
  return infoValueForKey(info, key);
}
const four = Array.from({ length: 4 }, (_, index) => `{ map m${index} type single }`).join("\n");
const campaign = `${four}\n{ map training type single special training }\n{ map final type single special final }`;

test("base catalog opens distinct raw byte script names from the actual packed file list", async () => {
  const bytes = (text: string): Uint8Array => Uint8Array.from(text, byte => byte.charCodeAt(0));
  const definitions: readonly (readonly [string, string, boolean])[] = [
    ["\xe9", "Raw", false], ["\xc3\xa9", "Utf8", true], ["\xff", "Invalid", true],
  ];
  const entries: SourceZipEntry[] = [];
  for (const [name, identity, utf8] of definitions) {
    entries.push({ name: bytes(`scripts/${name}.arena`), data: bytes(`{ map ${identity} type ffa } { map Duplicate type ffa origin ${identity} }`), method: 8, utf8 });
    entries.push({ name: bytes(`scripts/${name}.bot`), data: bytes(`{ name ${identity} } { name Duplicate origin ${identity} }`), method: 8, utf8 });
  }
  const f = await fixture({}, entries);
  try {
    for (const extension of [".arena", ".bot"]) {
      const listed = new Uint8Array(1024);
      expect(f.files.current.getFileList("scripts", extension, listed)).toBe(3);
      const expected = bytes(definitions.map(([name]) => `${name}${extension}\0`).join(""));
      expect<Uint8Array>(listed.subarray(0, expected.length)).toEqual(expected);
    }
    f.game.initialize();
    expect(f.game.getNumArenas()).toBe(6);
    expect(f.game.getNumBots()).toBe(6);
    expect(Array.from({ length: 6 }, (_, index) => field(f.game.getArenaInfoByNumber(index), "map")))
      .toEqual(["Raw", "Duplicate", "Utf8", "Duplicate", "Invalid", "Duplicate"]);
    expect(Array.from({ length: 6 }, (_, index) => field(f.game.getBotInfoByNumber(index), "name")))
      .toEqual(["Raw", "Duplicate", "Utf8", "Duplicate", "Invalid", "Duplicate"]);
    expect(field(f.game.getArenaInfoByMap("duplicate"), "origin")).toBe("Raw");
    expect(field(f.game.getBotInfoByName("duplicate"), "origin")).toBe("Raw");
  } finally { f.close(); }
});

test("game info loads real retail arenas and bots, numbers tiers, progresses and closes source handles", async () => {
  const f = await fixture(null);
  try {
    f.game.initialize();
    expect(f.game.getNumArenas()).toBeGreaterThanOrEqual(30);
    expect(f.game.getNumSPArenas()).toBe(24);
    expect(f.game.getNumSPTiers()).toBe(6);
    expect(f.game.getNumBots()).toBe(32);
    expect(f.state.demoVersion).toBe(false);
    expect(field(f.game.getSpecialArenaInfo("training"), "map")).toBe("q3dm0");
    expect(field(f.game.getSpecialArenaInfo("FINAL"), "map")).toBe("q3tourney6");
    expect(field(f.game.getArenaInfoByMap("Q3DM1"), "num")).toBe("0");
    expect(field(f.game.getBotInfoByName("SARGE"), "name")).toBe("Sarge");
    const numbers = new Set<string>();
    for (let n = 0; n < f.game.getNumArenas(); n++) numbers.add(field(f.game.getArenaInfoByNumber(n), "num"));
    expect(numbers.size).toBe(f.game.getNumArenas());
    expect(f.game.getCurrentGame()).toBe(24);
    f.game.unlockLevelScores();
    expect(f.game.getCurrentGame()).toBe(25);
    expect(f.game.tierCompleted(24)).toBe(0);
    expect(f.game.tierCompleted(25)).toBe(7);
    expect(f.game.tierCompleted(23)).toBe(6);
    const opened = f.files.current.openRead("scripts/arenas.txt");
    if (opened === undefined) throw new Error("Missing actual retail arenas");
    expect(opened.file.slot).toBe(1);
    f.files.current.closeFile(opened.file);
    f.game.newGame();
    expect(f.game.getCurrentGame()).toBe(24);
  } finally { f.close(); }
});

test("source parser retains partial infos, line barriers, duplicate keys, listing order and numbering collisions", async () => {
  const f = await fixture({
    "scripts/arenas.txt": `${four}\n{ map extra type single }\n{ map train type single special training }\n{ map upper type SINGLE }`,
    "scripts/z.arena": "{ map duplicate type ffa }",
    "scripts/a.arena": "{ map duplicate type single }",
    "scripts/bots.txt": "// comment\n{ name old name New missing\n key value invalid \"x;y\" }\n{ name Partial",
  }, true);
  try {
    f.game.initialize();
    expect(f.game.getNumArenas()).toBe(9);
    expect(f.game.getNumSPArenas()).toBe(4);
    expect(field(f.game.getArenaInfoByNumber(4), "map")).toBe("extra");
    expect(field(f.game.getSpecialArenaInfo("training"), "num")).toBe("4");
    expect(field(f.game.getArenaInfoByMap("duplicate"), "type")).toBe("ffa");
    expect(field(f.game.getArenaInfoByMap("upper"), "num")).toBe("5");
    expect(f.game.getNumBots()).toBe(2);
    const bot = f.game.getBotInfoByName("new");
    expect(field(bot, "missing")).toBe("<NULL>");
    expect(field(bot, "key")).toBe("value");
    expect(field(bot, "invalid")).toBe("");
    expect(field(f.game.getBotInfoByNumber(1), "name")).toBe("Partial");
    expect(f.prints).toContain("Unexpected end of info file\n");
    expect(f.prints).toContain("2 arenas ignored to make count divisible by 4\n");
    expect(f.game.getArenaInfoByNumber(8)).toBeNull();
    expect(f.game.getBotInfoByNumber(-1)).toBeNull();
  } finally { f.close(); }
});

test("progression uses real forced cvars, QVM atoi overflow, highest-skill ties and exact new-game write order", async () => {
  const f = await fixture({ "scripts/arenas.txt": campaign, "scripts/bots.txt": "" });
  try {
    f.game.initialize();
    f.cvars.set("g_spScores1", "\\l0\\3\\l6\\1", true);
    f.cvars.set("g_spScores3", "\\l0\\2", true);
    f.cvars.set("g_spScores5", "\\l0\\2", true);
    const score = { score: 90, skill: 91 };
    f.game.getBestScore(-1, score); expect(score).toEqual({ score: 90, skill: 91 });
    f.game.getBestScore(7, score); expect(score).toEqual({ score: 90, skill: 91 });
    f.game.getBestScore(6, score); expect(score).toEqual({ score: 1, skill: 1 });
    f.game.getBestScore(0, score); expect(score).toEqual({ score: 2, skill: 5 });
    f.cvars.set("g_spSkill", "2.9", true);
    f.game.setBestScore(-9, 1);
    expect(infoValueForKey(f.cvars.get("g_spScores2")?.value ?? "", "l-9")).toBe("1");
    f.game.setBestScore(0, 4); f.game.setBestScore(0, 5);
    expect(infoValueForKey(f.cvars.get("g_spScores2")?.value ?? "", "l0")).toBe("4");
    f.cvars.set("g_spAwards", "\\a-1\\2147483647\\a2\\4294967297\\a3\\\xff +12rest", true);
    f.game.logAwardData(-1, 1);
    expect(f.game.getAwardLevel(-1)).toBe(-2147483648);
    expect(f.game.getAwardLevel(2)).toBe(1);
    expect(f.game.getAwardLevel(3)).toBe(12);
    f.game.logAwardData(6, 1); expect(f.prints).toContain("^1Bad award 6 in UI_LogAwardData\n");
    f.game.unlockMedals(); for (let n = 0; n < 6; n++) expect(f.game.getAwardLevel(n)).toBe(100);
    f.game.unlockLevelScores(); expect(f.game.tierCompleted(-1)).toBe(1);
    expect(() => f.game.tierCompleted(-4)).toThrow("uninitialized source score");
    const writes: string[] = [], set = f.cvars.set.bind(f.cvars);
    f.cvars.set = (name, value, force) => { writes.push(name); expect(force).toBe(true); return set(name, value, force); };
    f.game.newGame();
    expect(writes).toEqual(["g_spScores1", "g_spScores2", "g_spScores3", "g_spScores4", "g_spScores5", "g_spAwards", "g_spVideos"]);
    expect(f.cvars.get("g_spScores1")?.flags).toBe(CvarFlag.Archive | CvarFlag.ReadOnly);
  } finally { f.close(); }
});

test("demo detection, null special arenas, negative video lookup and initialization follow live owner state", async () => {
  const f = await fixture({ "scripts/arenas.txt": four, "scripts/bots.txt": "" });
  try {
    f.game.initialize(); expect(f.state.demoVersion).toBe(true);
    expect(f.game.showTierVideo(1)).toBe(true); expect(f.game.showTierVideo(1)).toBe(false);
    expect(f.game.canShowTierVideo(1)).toBe(false);
    expect(f.game.showTierVideo(8)).toBe(true); expect(f.game.canShowTierVideo(8)).toBe(true);
    expect(f.game.showTierVideo(-1)).toBe(false);
    f.state.demoVersion = false;
    f.cvars.set("g_spVideos", "\\tier-1\\1", true);
    expect(f.game.canShowTierVideo(-1)).toBe(true); expect(f.game.canShowTierVideo(0)).toBe(false);
    expect(f.game.tierCompleted(4)).toBe(2);
    f.cvars.set("g_arenasFile", "scripts/bots.txt", true);
    f.game.initialize(); expect(f.game.getNumArenas()).toBe(0);
    expect(f.game.tierCompleted(0)).toBe(0);
    expect(f.game.getCurrentGame()).toBe(-1);
    f.cvars.set("fs_restrict", "1", true);
    f.game.initialize(); expect(f.state.demoVersion).toBe(true);
    await f.files.restart({ checksumFeed: 17, random: () => 0 }, () => {});
    f.game.initialize(); expect(f.game.getNumBots()).toBe(0);
    const gate = deferred(); let escaped: Promise<void> | null = null;
    f.consoleCommands.register("escape-game-info", () => { escaped = gate.promise.then(() => { f.game.getNumBots(); }); });
    f.consoleCommands.executeNow("escape-game-info"); gate.resolve();
    if (escaped === null) throw new Error("Missing escaped operation");
    await expect(escaped).rejects.toThrow("closed command");
    f.state.retire(); expect(() => f.game.initialize()).toThrow("retired");
  } finally { f.close(); }
});

test("oversized files print before close, abort retains source handle, missing files never read", async () => {
  const f = await fixture({ "scripts/arenas.txt": "x".repeat(8192), "scripts/bots.txt": "" }, true);
  try {
    const operations: string[] = [], view = f.files.current;
    const open = view.openRead.bind(view), read = view.readInto.bind(view), close = view.closeFile.bind(view), print = f.state.services.print.bind(f.state.services);
    view.openRead = name => { operations.push(`open:${name}`); return open(name); };
    view.readInto = (handle, bytes) => { operations.push(`read:${bytes.length}`); return read(handle, bytes); };
    view.closeFile = handle => { operations.push(`close:${handle.slot}`); close(handle); };
    let abort = true;
    f.state.services.print = text => { operations.push(`print:${text}`); if (abort && text.includes("file too large")) throw new Error("print abort"); return print(text); };
    expect(() => f.game.initialize()).toThrow("print abort");
    expect(operations).toEqual(["open:scripts/arenas.txt", "print:^1file too large: scripts/arenas.txt is 8192, max allowed is 8192"]);
    const retained = open("scripts/bots.txt"); if (retained === undefined) throw new Error("Missing empty file");
    expect(retained.file.slot).toBe(2); close(retained.file);
    abort = false; operations.length = 0; f.game.initialize();
    expect(operations.slice(0, 3)).toEqual(["open:scripts/arenas.txt", "print:^1file too large: scripts/arenas.txt is 8192, max allowed is 8192", "close:2"]);
    expect(operations).toContain("read:0");
    f.cvars.set("g_arenasFile", "scripts/missing.txt", true); operations.length = 0; f.game.initialize();
    expect(operations.slice(0, 2)).toEqual(["open:scripts/missing.txt", "print:^1file not found: scripts/missing.txt\n"]);
    f.files.close(); expect(() => read(retained.file, new Uint8Array(0))).toThrow();
  } finally { f.close(); }
});

test("short loose reads reject only reached undefined bytes, and source filename concatenation is bounded", async () => {
  const f = await fixture({ "scripts/arenas.txt": "{ map x } padded", "scripts/bots.txt": "" });
  try {
    if (f.directory === null) throw new Error("Expected loose fixture");
    const path = join(f.directory, "baseq3", "scripts", "arenas.txt");
    const open = f.files.current.openRead.bind(f.files.current);
    let length = 9;
    f.files.current.openRead = name => { const result = open(name); if (name === "scripts/arenas.txt") truncateSync(path, length); return result; };
    expect(() => f.game.initialize()).toThrow("uninitialized short-read tail");
    writeFileSync(path, "{ map x }\0 padded"); length = 10;
    f.game.initialize(); expect(f.game.getNumArenas()).toBe(1);
    writeFileSync(path, "wrong token padded"); length = 12;
    f.game.initialize(); expect(f.game.getNumArenas()).toBe(0);
    expect(f.prints).toContain("Missing { in info file\n");
    writeFileSync(path, '"wrong" padded'); length = 7;
    const previousMissingBrace = f.prints.filter(text => text === "Missing { in info file\n").length;
    f.game.initialize(); expect(f.game.getNumArenas()).toBe(0);
    expect(f.prints.filter(text => text === "Missing { in info file\n").length).toBe(previousMissingBrace + 1);
    writeFileSync(join(f.directory, "baseq3", "scripts", `${"x".repeat(115)}.arena`), "{}");
    expect(() => f.game.initialize()).toThrow("128-byte storage");
  } finally { f.close(); }
});

test("source allocation pool is shared between arena and bot loads and reset on reinitialization", async () => {
  const entries: Record<string, string> = { "scripts/arenas.txt": "", "scripts/bots.txt": "{ name After }" };
  const entry = `{ map x long ${"v".repeat(850)} }\n`;
  for (let n = 0; n < 20; n++) entries[`scripts/${n}.arena`] = entry.repeat(9);
  const f = await fixture(entries, true);
  try {
    f.game.initialize();
    // Each 862-byte info requests 872 bytes, then consumes 896 aligned bytes.
    expect(f.game.getNumArenas()).toBe(146);
    expect(f.game.getNumBots()).toBe(1);
    expect(f.prints).toContain("^3WARNING: not anough memory in pool to load all arenas\n");
    expect(f.prints).toContain("^3WARNING: not anough memory in pool to load all bots\n");
    f.game.initialize(); expect(f.game.getNumArenas()).toBe(146);
    expect(f.game.getNumBots()).toBe(1);
  } finally { f.close(); }
});
