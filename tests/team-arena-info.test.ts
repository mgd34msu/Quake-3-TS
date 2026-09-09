import { HunkArena } from "../src/core/hunk.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { CommonParseState } from "../src/core/common-parse.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RenderTarget } from "../src/render/commands.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { RendererResources } from "../src/render/world.ts";
import { TeamArenaGameInfo, TeamArenaMenuBuffer, infoSlot } from "../src/ui/team-arena/game-info.ts";
import { TeamArenaUiMemory, UiMemoryAllocation } from "../src/ui/team-arena/memory.ts";
import { TeamArenaTeamInfo } from "../src/ui/team-arena/team-info.ts";
import { TeamArenaUiCvars } from "../src/ui/team-arena/cvars.ts";
import { TeamArenaSelection } from "../src/ui/team-arena/selection.ts";
import { deferred } from "./base-ui-fixture.ts";

async function fixture(entries: Readonly<Record<string, string>> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "quake3-team-info-"));
  for (const [name, text] of Object.entries(entries)) {
    const path = join(directory, "missionpack", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "latin1");
  }
  const prints: string[] = [], registrations: (string | null)[] = [];
  const print = (text: string): undefined => { prints.push(text); };
  const cvars = new CvarRegistry(print), sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a",
    homePath: directory, cdPath: null, product: "missionpack" }, print, sound, cvars);
  let cinematics: EngineCinematics | null = null, target: RenderTarget | null = null, active = true;
  const assertActive = (): void => { if (!active) throw new Error("retired Team Arena UI"); };
  try {
    await files.initialize({ checksumFeed: 0, random: () => 0 }, assertActive);
    const images = new RendererImageCatalog(), builtins = new BuiltinImages(images, identityImageUploadProfile);
    target = new RenderTarget(images, [new SoftwareRenderer(1, 1, images)]);
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: files.current }, sound: { kind: "diagnostic", readMixer: () => null },
      clock: { sample: () => 0 }, scratchImages: builtins, console: { kind: "absent" },
      settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
    const resources = await RendererResources.create(files.current, { kind: "unaccounted" }, settings,
      { patchMemory: { kind: "diagnostic" }, print, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
    const register = resources.registerShaderNoMip.bind(resources);
    resources.registerShaderNoMip = async name => { registrations.push(name); return await register(name); };
    const memory = new TeamArenaUiMemory("qvm32", print), menuBuffer = new TeamArenaMenuBuffer(files, print, assertActive);
    const services = { menuBuffer, sourceParser: new CommonParseState(), memory, resources, print, assertActive };
    return { directory, files, resources, memory, menuBuffer, prints, registrations, cvars, assertActive,
      game: new TeamArenaGameInfo(services), teams: new TeamArenaTeamInfo(services), retire: () => { active = false; },
      close: () => { try { files.close(); sound.close(); cinematics?.dispose(); rmSync(directory, { recursive: true, force: true }); } finally { target?.close(); } } };
  } catch (error) {
    try { files.close(); sound.close(); cinematics?.dispose(); rmSync(directory, { recursive: true, force: true }); } finally { target?.close(); }
    throw error;
  }
}

test("CGAME selects its separate 128 KiB memory and string pools", () => {
  const printed: string[] = [], memory = new TeamArenaUiMemory("qvm32", text => { printed.push(text); }, "cgame");
  expect(memory.allocate(128 * 1024)).toBe(0);
  expect(memory.allocate(1)).toBeNull();
  expect(memory.outOfMemory).toBe(true);
  memory.initializeStrings();
  expect(memory.outOfMemory).toBe(false);
  const text = "A".repeat(128 * 1024 - 2);
  expect(memory.stringAllocReference(text)?.read()).toBe(text);
  expect(memory.stringAllocReference("B")).toBeNull();
  memory.report();
  expect(printed).toContain("String Pool is 99.9% full, 131071 bytes out of 131072 used.\n");
  expect(printed).toContain("Memory Pool is 0.0% full, 16 bytes out of 131072 used.\n");
});

test("String_Init preserves old char pointers while reusing and overwriting actual pool bytes", () => {
  const memory = new TeamArenaUiMemory("qvm32", () => {}), slots = UiMemoryAllocation.zeroed(8);
  const first = memory.stringAllocReference("Alpha"), second = memory.stringAllocReference("Beta");
  if (first === null || second === null) throw new Error("Small source strings did not allocate");
  slots.setString(0, first); slots.setString(4, second);
  expect(memory.stringAllocReference("Alpha")).toBe(first);
  expect([memory.stringBytes, memory.allocatedBytes]).toEqual([11, 32]);
  memory.initializeStrings();
  expect([slots.getString(0), slots.getString(4)]).toEqual(["Alpha", "Beta"]);
  const reused = memory.stringAllocReference("UVWXYZ012345");
  expect(reused).not.toBe(first);
  expect([slots.getString(0), slots.getString(4)]).toEqual(["UVWXYZ012345", "012345"]);
  memory.initializeStrings(); memory.stringAllocReference("X");
  expect([slots.getString(0), slots.getString(4)]).toEqual(["X", "012345"]);
  const offset = memory.allocate(16);
  if (offset === null) throw new Error("Small info allocation failed");
  const allocation = memory.borrow(offset, 16), bytes = allocation.stringReference();
  allocation.writeString("catalog");
  expect(bytes.read()).toBe("catalog");
  allocation.setInt32(0, 0x00636261);
  expect(bytes.read()).toBe("abc");
});

test("UI_Load String_Init and game-info parsing overwrite retained team and member string aliases", async () => {
  const f = await fixture({ "team-pointer.txt": "teams { { AAAA BBBB AAAA CCCC DDDD EEEE FFFF } }",
    "new-game.txt": "gametypes { { ZZZZ 0 } }" });
  try {
    await f.teams.parseTeamInfo("team-pointer.txt");
    const team = infoSlot(f.teams.teamList, 0), member = team.strings.getStringReference(8);
    expect(team.strings.getStringReference(0)).toBe(member);
    f.memory.initializeStrings();
    await f.game.parseGameInfo("new-game.txt");
    expect([team.teamName, team.imageName, team.teamMembers[0]]).toEqual(["ZZZZ", "BBBB", "ZZZZ"]);
    const cvars = new TeamArenaUiCvars(f.cvars, () => { f.assertActive(); });
    const selection = new TeamArenaSelection(f.game, f.teams, cvars, f.files, text => { f.prints.push(text); }, f.assertActive);
    expect(selection.teamIndexFromName("ZZZZ")).toBe(0);
  } finally { f.close(); }
});

test("Team Arena retail metadata keeps original records and actual registered shader identities", async () => {
  const f = await fixture();
  try {
    await f.teams.parseTeamInfo("teaminfo.txt");
    await f.teams.loadTeams();
    await f.game.parseGameInfo("gameinfo.txt");
    expect([f.teams.teamCount, f.teams.characterCount, f.teams.aliasCount]).toEqual([5, 11, 25]);
    expect([f.game.numGameTypes, f.game.numJoinGameTypes, f.game.mapCount]).toEqual([7, 8, 17]);
    const crusaders = infoSlot(f.teams.teamList, 0), firstMap = infoSlot(f.game.mapList, 0);
    expect(crusaders.teamName).toBe("Crusaders");
    expect([...crusaders.teamMembers]).toEqual(["Darkangel", "Lionheart", "Bradamante", "Furioso", "Aria"]);
    expect(crusaders.teamIcon).not.toBeNull();
    expect(crusaders.teamIcon).toBe(await f.resources.registerShaderNoMip("ui/assets/crusaders"));
    expect(crusaders.teamIconMetal).toBe(await f.resources.registerShaderNoMip("ui/assets/crusaders_metal"));
    expect(crusaders.teamIconName).toBe(await f.resources.registerShaderNoMip("ui/assets/crusaders_name"));
    expect(infoSlot(f.teams.teamList, 3).teamMembers[1]).toBe("Icarus ");
    expect(infoSlot(f.teams.characterList, 1)).toMatchObject({ name: "Janet", base: "Janet", headImage: { kind: "unregistered" } });
    const alias = infoSlot(f.teams.aliasList, 19);
    expect({ name: alias.name, ai: alias.ai, action: alias.action }).toEqual({ name: "Whyrlwynd", ai: "Ursla", action: "o" });
    expect(firstMap).toMatchObject({ mapName: "Base Siege", mapLoadName: "mpteam1", teamMembers: 3, opponentName: "Sarge", typeBits: 244, cinematic: -1 });
    expect([...firstMap.timeToBeat]).toEqual([0, 0, 0, 0, 240, 180, 180, 180, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(firstMap.levelShot.kind).toBe("registered");
    if (firstMap.levelShot.kind !== "registered") throw new Error("Retail gameinfo map preview was not registered");
    expect(firstMap.levelShot.shader).not.toBeNull();
    expect(firstMap.levelShot.shader).toBe(await f.resources.registerShaderNoMip("levelshots/mpteam1_small"));
    const joinGame = infoSlot(f.game.joinGameTypes, 0);
    expect({ gameType: joinGame.gameType, gtEnum: joinGame.gtEnum }).toEqual({ gameType: "All", gtEnum: -1 });
    expect(f.registrations.slice(0, 3)).toEqual(["ui/assets/crusaders", "ui/assets/crusaders_metal", "ui/assets/crusaders_name"]);
    const opened = f.files.current.openRead("gameinfo.txt");
    if (opened === undefined) throw new Error("Missing retail gameinfo.txt");
    expect(opened.file.slot).toBe(1);
    f.files.current.closeFile(opened.file);
  } finally { f.close(); }
});

test("game info preserves section reset timing, atoi prefixes, partial fields and consumed map delimiters", async () => {
  const f = await fixture({
    "one.txt": "gametypes { { First 3junk } } maps { { Name mpteam1 3 Enemy 10 99 not-a-brace { Next mpteam2 4 Enemy 4 60 } }",
    "two.txt": "maps { { Again mpteam1 1 Enemy 4 20 } } gametypes wrong joingametypes { { Skipped 7 } }",
    "three.txt": "gametypes { { Broken\n 7 } } joingametypes { { Skipped 7 } }",
    "four.txt": "joingametypes { { Counted -1 bad-close } }",
  });
  try {
    await f.game.parseGameInfo("one.txt");
    expect(f.game.numGameTypes).toBe(1);
    expect(infoSlot(f.game.gameTypes, 0).gtEnum).toBe(3);
    expect(f.game.mapCount).toBe(2);
    expect(infoSlot(f.game.mapList, 0).typeBits).toBe(2);
    expect(infoSlot(f.game.mapList, 0).timeToBeat[1]).toBe(99);
    await f.game.parseGameInfo("two.txt");
    expect(f.game.mapCount).toBe(1);
    expect(infoSlot(f.game.mapList, 0).timeToBeat[1]).toBe(99);
    expect(infoSlot(f.game.mapList, 0).timeToBeat[4]).toBe(20);
    expect(f.game.numGameTypes).toBe(1);
    expect(f.game.numJoinGameTypes).toBe(0);
    await f.game.parseGameInfo("three.txt");
    expect(f.game.numGameTypes).toBe(0);
    const broken = infoSlot(f.game.gameTypes, 0);
    expect({ gameType: broken.gameType, gtEnum: broken.gtEnum }).toEqual({ gameType: "Broken", gtEnum: 3 });
    await f.game.parseGameInfo("four.txt");
    expect(f.game.numJoinGameTypes).toBe(1);
    const counted = infoSlot(f.game.joinGameTypes, 0);
    expect({ gameType: counted.gameType, gtEnum: counted.gtEnum }).toEqual({ gameType: "Counted", gtEnum: -1 });
  } finally { f.close(); }
});

test("team metadata retains registered icons and partial members, aliases the COM token, and appends listed teams", async () => {
  const f = await fixture({
    "partial.txt": "teams { { Partial ui/assets/crusaders One Two\n Three Four Five } } aliases { { Skipped Ai d } }",
    "alias.txt": "characters aliases { { Recovered Ai o } }",
    "characters.txt": "characters { { Neutral Custom } { Male MALE } { Female female wrong } }",
    "extra.team": "teams { { Extra ui/assets/pagans A B C D E } } aliases { { Extra Janet d } }",
  });
  try {
    await f.teams.parseTeamInfo("partial.txt");
    expect(f.teams.teamCount).toBe(0);
    const partial = infoSlot(f.teams.teamList, 0);
    expect([...partial.teamMembers]).toEqual(["One", "Two", null, null, null]);
    expect(partial.cinematic).toBe(-1);
    expect(partial.teamIconName).not.toBeNull();
    expect(f.teams.aliasCount).toBe(0);
    await f.teams.parseTeamInfo("alias.txt");
    expect(f.teams.aliasCount).toBe(1);
    const recovered = infoSlot(f.teams.aliasList, 0);
    expect({ name: recovered.name, ai: recovered.ai, action: recovered.action }).toEqual({ name: "Recovered", ai: "Ai", action: "o" });
    await f.teams.parseTeamInfo("characters.txt");
    expect(f.teams.characterCount).toBe(3);
    expect(f.teams.characterList.slice(0, 3).map(row => row.base)).toEqual(["Custom", "James", "Janet"]);
    await f.teams.loadTeams();
    expect([f.teams.teamCount, f.teams.aliasCount]).toEqual([1, 2]);
    expect(infoSlot(f.teams.teamList, 0).teamName).toBe("Extra");
    expect(infoSlot(f.teams.aliasList, 1).name).toBe("Extra");
  } finally { f.close(); }
});

test("GetMenuBuffer retains source static bytes across short reads and uses default on missing/oversized files", async () => {
  const f = await fixture({ "full.txt": "abcdefghijkl", "short.txt": "XYZ.........", "large.txt": "x".repeat(32768) });
  try {
    expect(f.menuBuffer.read("full.txt")?.source).toBe("abcdefghijkl");
    const open = f.files.current.openRead.bind(f.files.current);
    f.files.current.openRead = filename => {
      const result = open(filename);
      if (filename === "short.txt") truncateSync(join(f.directory, "missionpack", filename), 3);
      return result;
    };
    expect(f.menuBuffer.read("short.txt")?.source).toBe("XYZdefghijkl");
    expect(f.menuBuffer.read("absent.txt")).toBeNull();
    f.menuBuffer.defaultMenu = "fallback";
    expect(f.menuBuffer.read("absent.txt")?.source).toBe("fallback");
    expect(f.menuBuffer.read("large.txt")?.source).toBe("fallback");
    expect(f.prints).toContain("^1menu file too large: large.txt is 32768, max allowed is 32768");
  } finally { f.close(); }
});

test("source metadata capacity stops at the first out-of-bounds write after retaining accepted entries", async () => {
  const f = await fixture({
    "games.txt": `gametypes { ${Array.from({ length: 17 }, (_, i) => `{ Game${i} ${i} }`).join(" ")} }`,
    "aliases.txt": `aliases { ${Array.from({ length: 65 }, (_, i) => `{ Alias${i} Ai a }`).join(" ")} }`,
  });
  try {
    await expect(f.game.parseGameInfo("games.txt")).rejects.toThrow("16-entry array at 16");
    expect(f.game.numGameTypes).toBe(16);
    expect(infoSlot(f.game.gameTypes, 15).gameType).toBe("Game15");
    await expect(f.teams.parseTeamInfo("aliases.txt")).rejects.toThrow("64-entry array at 64");
    expect(f.teams.aliasCount).toBe(64);
  } finally { f.close(); }
});

test("registration awaits source order and callback retirement prevents further metadata publication", async () => {
  const f = await fixture({ "one.txt": "teams { { Team ui/assets/crusaders A B C D E } }" });
  try {
    const entered = deferred(), release = deferred(), register = f.resources.registerShaderNoMip.bind(f.resources);
    f.resources.registerShaderNoMip = async name => { entered.resolve(); await release.promise; return await register(name); };
    const pending = f.teams.parseTeamInfo("one.txt");
    await entered.promise;
    expect(f.teams.teamCount).toBe(0);
    expect(infoSlot(f.teams.teamList, 0).teamIcon).toBeNull();
    f.retire(); release.resolve();
    await expect(pending).rejects.toThrow("retired Team Arena UI");
    expect(infoSlot(f.teams.teamList, 0).teamIcon).toBeNull();
    expect(f.registrations).toEqual(["ui/assets/crusaders"]);
  } finally { f.close(); }
  for (const text of ["teams { { Team ui/assets/crusaders A B C D E } }",
    "characters { { One male } { Two female } }", "aliases { { One Ai a } { Two Ai d } }", null]) {
    const printed = await fixture(text === null ? {} : { "callback.txt": text });
    try {
      const push = printed.prints.push.bind(printed.prints);
      printed.prints.push = (...messages) => { printed.retire(); return push(...messages); };
      await expect(printed.teams.parseTeamInfo("callback.txt")).rejects.toThrow("retired Team Arena UI");
      expect([printed.teams.teamCount, printed.teams.characterCount, printed.teams.aliasCount]).toEqual([0, 0, 0]);
    } finally { printed.close(); }
  }
});

test("String_Alloc preserves strict byte quota, case-sensitive reuse and source collision-tail replacement", () => {
  const memory = new TeamArenaUiMemory("qvm32", () => {});
  expect(memory.stringAlloc(null)).toBeNull();
  expect(memory.stringAlloc("")).toBe("");
  for (const text of ["aA", "Aa", "AA"]) expect(memory.stringAlloc(text)).toBe(text);
  expect([memory.stringBytes, memory.allocatedBytes]).toEqual([9, 48]);
  memory.stringAlloc("aA");
  expect(memory.stringBytes).toBe(9);
  memory.stringAlloc("Aa");
  expect([memory.stringBytes, memory.allocatedBytes]).toEqual([12, 64]);
  memory.initializeStrings();
  expect(memory.stringAlloc("x".repeat(384 * 1024 - 2))).not.toBeNull();
  expect(memory.stringAlloc("a")).toBeNull();
  expect(memory.outOfMemory).toBe(false);
  expect(memory.stringAlloc("\0ignored")).toBe("");
  memory.initializeStrings();
  expect(memory.allocate(1024 * 1024)).toBe(0);
  expect(() => memory.stringAlloc("failed")).toThrow("failed UI_Alloc");
  expect(memory.stringBytes).toBe(7);
  expect(memory.outOfMemory).toBe(true);
});

test("UI_Alloc borrowed bytes and typed string slots survive memory and string initialization", () => {
  const memory = new TeamArenaUiMemory("qvm32", () => {});
  expect(memory.allocate(392)).toBe(0);
  expect(memory.allocatedBytes).toBe(400);
  const record = memory.borrow(0, 392);
  expect([record.getFloat32(256), record.getInt32(384), record.getInt32(388)]).toEqual([0, 0, 0]);
  record.setFloat32(256, 3.25);
  record.setFloat32(260, .1);
  record.setInt32(384, 2);
  record.setString(0, "Kept");
  expect(record.getInt32(256)).toBe(0x40500000);
  expect(record.getFloat32(260)).toBe(Math.fround(.1));
  memory.initializeMemory();
  expect(memory.allocatedBytes).toBe(0);
  expect(memory.allocate(392)).toBe(0);
  const reused = memory.borrow(0, 392);
  expect([reused.getFloat32(256), reused.getInt32(384), reused.getString(0)]).toEqual([3.25, 2, "Kept"]);
  reused.setFloat32(256, -2);
  expect(record.getFloat32(256)).toBe(-2);
  memory.initializeStrings();
  expect([record.getFloat32(256), record.getInt32(384), record.getString(0)]).toEqual([-2, 2, "Kept"]);
  memory.borrow(0, 4).clear();
  expect(record.getString(0)).toBeUndefined();
  expect(record.getFloat32(256)).toBe(-2);
  record.clear();
  expect([record.getFloat32(256), record.getInt32(384), record.getInt32(388)]).toEqual([0, 0, 0]);
});

test("UI_Alloc borrows only physical spans and never synthesizes pointer address bits", () => {
  const memory = new TeamArenaUiMemory("qvm32", () => {});
  for (const [offset, size] of [[-1, 4], [0, -1], [.5, 4], [0, .5], [1024 * 1024, 1], [NaN, 4]]) {
    if (offset === undefined || size === undefined) throw new Error("missing physical span");
    expect(() => memory.borrow(offset, size)).toThrow("physical memory pool");
  }
  const record = memory.borrow(0, 8);
  expect(memory.allocatedBytes).toBe(0);
  record.setString(4, "value");
  expect(record.getString(4)).toBe("value");
  expect(() => record.getFloat32(4)).toThrow("pointer address bits");
  expect(() => record.getInt32(2)).toThrow("pointer address bits");
  expect(() => record.getInt32(5)).toThrow("borrowed record");
  record.setFloat32(4, 3.25);
  expect(record.getFloat32(4)).toBe(3.25);
  expect(() => record.getString(4)).toThrow("non-pointer bytes");
  memory.borrow(4, 4).clear();
  expect(record.getString(4)).toBeUndefined();
  expect(memory.borrow(1024 * 1024, 0).size).toBe(0);
});

test("Team Arena map selection mutates actual active rows and observes source VM game-type cells", async () => {
  const f = await fixture({ "selection.txt": "gametypes { { FFA 0 } { Duel 1 } { Single 2 } { Team 3 } { CTF 4 } } maps { { Arena q3dm1 2 Enemy 0 10 2 12 } { Duel q3tourney1 2 Enemy 1 20 } { Flag mpteam1 3 Enemy 4 30 2 40 } }" });
  try {
    await f.game.parseGameInfo("selection.txt");
    const cvars = new TeamArenaUiCvars(f.cvars, () => { f.assertActive(); });
    const selection = new TeamArenaSelection(f.game, f.teams, cvars, f.files, text => { f.prints.push(text); }, f.assertActive);
    infoSlot(f.game.mapList, 127).active = true;
    expect(selection.mapCountByGameType(false)).toBe(1);
    expect(selection.selectedMap(0)).toEqual({ name: "Arena", actual: 0 });
    f.cvars.set("ui_netGametype", "4", true);
    expect(selection.mapCountByGameType(false)).toBe(1);
    expect(selection.selectedMap(0).name).toBe("Arena");
    cvars.update();
    expect(selection.mapCountByGameType(false)).toBe(1);
    expect(selection.selectedMap(0)).toEqual({ name: "Flag", actual: 2 });
    cvars.writeInteger("ui_gameType", 2);
    expect(selection.mapCountByGameType(true)).toBe(1);
    expect(selection.selectedMap(0).name).toBe("Arena");
    cvars.writeInteger("ui_gameType", 1);
    expect(selection.mapCountByGameType(true)).toBe(0);
    expect(selection.selectedMap(-1)).toEqual({ name: "", actual: 0 });
    infoSlot(f.game.mapList, 0).active = true;
    infoSlot(f.game.mapList, 2).active = true;
    expect(selection.indexFromSelection(2)).toBe(1);
    expect(selection.indexFromSelection(1)).toBe(0);
    expect(infoSlot(f.game.mapList, 127).active).toBe(true);
  } finally { f.close(); }
});

test("Team Arena head filtering probes real empty skins once and uses the live team-name cvar", async () => {
  const f = await fixture({
    "selection.txt": "teams { { One ui/assets/crusaders Alias A B C D } { Two ui/assets/pagans A B C D E } } characters { { Alpha male } { Beta female } { Gamma Alien } } aliases { { Alias Alpha o } }",
    "models/players/James/One/lower_default.skin": "",
    "models/players/characters/Janet/One/lower_default.skin": "",
    "models/players/Alien/Two/lower_default.skin": "",
  });
  try {
    await f.teams.parseTeamInfo("selection.txt");
    const cvars = new TeamArenaUiCvars(f.cvars, () => { f.assertActive(); });
    const selection = new TeamArenaSelection(f.game, f.teams, cvars, f.files, text => { f.prints.push(text); }, f.assertActive);
    f.cvars.set("ui_teamName", "oNE", true);
    expect(selection.teamIndexFromName("TWO\0ignored")).toBe(1);
    expect(selection.teamIndexFromName(null)).toBe(0);
    f.cvars.set("ui_opponentName", "oNE", true);
    expect(selection.opponentLeaderName()).toBe("Alias");
    expect(selection.opponentLeaderHead()).toBe("Alpha");
    expect(selection.opponentLeaderModel()).toBe("James");
    expect(selection.aiIndex("bETA")).toBe(1);
    expect(selection.aiIndexFromName("ALIAS")).toBe(0);
    infoSlot(f.teams.aliasList, 0).ai = "Beta";
    expect(selection.aiIndexFromName("ALIAS")).toBe(1);
    expect(selection.opponentLeaderModel()).toBe("Janet");
    expect(selection.aiIndexFromName("missing")).toBe(0);
    f.cvars.set("ui_opponentName", "Two", true);
    expect(selection.opponentLeaderHead()).toBe("James");
    expect(selection.opponentLeaderModel()).toBe("James");
    expect(selection.headCountByTeam()).toBe(2);
    expect(f.teams.characterList.slice(0, 3).map(row => row.reference)).toEqual([1, 1, 2]);
    expect(selection.selectedHead(1)).toEqual({ name: "Beta", actual: 1 });
    f.cvars.set("ui_teamName", "Two", true);
    expect(selection.headCountByTeam()).toBe(1);
    expect(selection.selectedHead(0)).toEqual({ name: "Gamma", actual: 2 });
    expect(selection.selectedHead(1)).toEqual({ name: "", actual: 0 });
    const added = join(f.directory, "missionpack/models/players/Alien/One/lower_default.skin");
    mkdirSync(dirname(added), { recursive: true }); writeFileSync(added, "");
    f.cvars.set("ui_teamName", "One", true);
    expect(selection.headCountByTeam()).toBe(2);
    expect(infoSlot(f.teams.characterList, 2).reference).toBe(2);
    f.retire();
    expect(() => selection.selectedHead(0)).toThrow("retired Team Arena UI");
  } finally { f.close(); }
});
