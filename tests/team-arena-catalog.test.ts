import { HunkArena } from "../src/core/hunk.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { CommonParseState } from "../src/core/common-parse.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { infoValueForKey } from "../src/core/info-string.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RenderTarget } from "../src/render/commands.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { RendererResources } from "../src/render/world.ts";
import { TeamArenaCatalog } from "../src/ui/team-arena/catalog.ts";
import { TeamArenaGameInfo, TeamArenaMenuBuffer, infoSlot } from "../src/ui/team-arena/game-info.ts";
import { TeamArenaUiMemory } from "../src/ui/team-arena/memory.ts";
import { sourceZip } from "./pk3-source-fixture.ts";

async function fixture(entries: Readonly<Record<string, string>> | null, packed = false) {
  const directory = mkdtempSync(join(tmpdir(), "quake3-team-catalog-"));
  mkdirSync(join(directory, "missionpack"));
  if (entries !== null) {
    mkdirSync(join(directory, "baseq3"));
    writeFileSync(join(directory, "baseq3", "default.cfg"), "fixture\n");
    if (packed) {
      const bytes = (text: string): Uint8Array => Uint8Array.from(text, byte => byte.charCodeAt(0));
      writeFileSync(join(directory, "missionpack", "pak0.pk3"), sourceZip(Object.entries(entries).map(([path, text]) => ({
        name: bytes(path), data: bytes(text), method: 8, utf8: false,
      }))));
    } else for (const [name, text] of Object.entries(entries)) {
      const path = join(directory, "missionpack", name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, "latin1");
    }
  }
  const prints: string[] = [], registrations: (string | null)[] = [];
  const print = (text: string): undefined => { prints.push(text); };
  const cvars = new CvarRegistry(print), sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: entries === null ? process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a" : directory,
    homePath: directory, cdPath: null, product: "missionpack" }, print, sound, cvars);
  let cinematics: EngineCinematics | null = null, target: RenderTarget | null = null, active = true;
  const assertActive = (): void => { if (!active) throw new Error("retired Team Arena catalog"); };
  try {
    await files.initialize({ checksumFeed: 0, random: () => 0 }, assertActive);
    const images = new RendererImageCatalog(), builtins = new BuiltinImages(images, identityImageUploadProfile);
    target = new RenderTarget(images, [new SoftwareRenderer(1, 1, images)]);
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: files.current }, sound: { kind: "diagnostic", readMixer: () => null }, clock: { sample: () => 0 }, scratchImages: builtins,
      console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
    const resources = await RendererResources.create(files.current, { kind: "unaccounted" }, settings,
      { patchMemory: { kind: "diagnostic" }, print, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
    const register = resources.registerShaderNoMip.bind(resources);
    resources.registerShaderNoMip = async name => { registrations.push(name); return await register(name); };
    const memory = new TeamArenaUiMemory("qvm32", print), sourceParser = new CommonParseState();
    const game = new TeamArenaGameInfo({ menuBuffer: new TeamArenaMenuBuffer(files, print, assertActive),
      sourceParser, memory, resources, print, assertActive });
    const catalog = new TeamArenaCatalog({ files, cvars, memory, sourceParser, gameInfo: game, print, assertActive });
    return { directory, files, cvars, memory, sourceParser, game, catalog, prints, registrations, retire: () => { active = false; },
      close: () => { try { files.close(); sound.close(); cinematics?.dispose(); rmSync(directory, { recursive: true, force: true }); } finally { target?.close(); } } };
  } catch (error) {
    try { files.close(); sound.close(); cinematics?.dispose(); rmSync(directory, { recursive: true, force: true }); } finally { target?.close(); }
    throw error;
  }
}

test("UI_ParseInfos writes missing values into the retained COM token before parsing resumes", async () => {
  const f = await fixture({ "scripts/arenas.txt": "{ map\n longname Empty }" });
  try {
    const before: string[] = [], parse = f.sourceParser.parse.bind(f.sourceParser);
    f.sourceParser.parse = (cursor, allowLineBreaks = true) => { before.push(f.sourceParser.token); return parse(cursor, allowLineBreaks); };
    f.catalog.loadArenas();
    expect(before).toContain("<NULL>");
    expect(f.game.mapList[0]?.mapLoadName).toBe("<NULL>");
  } finally { f.close(); }
});

test("bot info retains a char pointer into the actual reused UI_Alloc bytes", async () => {
  const f = await fixture({ "scripts/bots.txt": "{ name Before }" });
  try {
    f.catalog.loadBots();
    expect(f.catalog.getBotNameByNumber(0)).toBe("Before");
    f.memory.initializeMemory();
    const offset = f.memory.allocate(32);
    if (offset === null) throw new Error("Expected available UI memory");
    expect(offset).toBe(0);
    f.memory.borrow(offset, 32).writeString("\\name\\After");
    expect(f.catalog.getBotNameByNumber(0)).toBe("After");
    expect(f.catalog.getBotInfoByName("after")).toBe("\\name\\After");
  } finally { f.close(); }
});

test("retail Team Arena catalog loads 60 arena records and 45 bots and defers map previews", async () => {
  const f = await fixture(null);
  try {
    await f.game.parseGameInfo("gameinfo.txt");
    const first = infoSlot(f.game.mapList, 0), campaignTime = first.timeToBeat[4];
    expect(first.levelShot.kind).toBe("registered");
    f.registrations.length = 0;
    f.catalog.loadArenas();
    f.catalog.loadBots();
    expect(f.game.mapCount).toBe(60);
    expect(f.catalog.getNumBots()).toBe(45);
    expect(first).toMatchObject({ mapLoadName: "q3dm1", mapName: "Arena Gate", imageName: "levelshots/q3dm1",
      levelShot: { kind: "unregistered" }, cinematic: -1, typeBits: 3, teamMembers: 3, opponentName: "Sarge" });
    expect(first.timeToBeat[4]).toBe(campaignTime);
    const mission = f.game.mapList.slice(0, f.game.mapCount).find(row => row.mapLoadName === "mpteam1");
    expect(mission?.typeBits).toBe(240);
    expect(f.catalog.getBotNameByNumber(0)).toBe("Xaero");
    expect(infoValueForKey(f.catalog.getBotInfoByName("JANET") ?? "", "name")).toBe("Janet");
    expect(infoValueForKey(f.catalog.getBotInfoByNumber(0) ?? "", "num")).toBe("");
    expect(f.catalog.getBotNameByNumber(-1)).toBe("Sarge");
    expect(f.catalog.getBotInfoByNumber(45)).toBeNull();
    expect(f.registrations).toEqual([]);
    expect(f.prints).toContain("60 arenas parsed\n");
    expect(f.prints).toContain("45 bots parsed\n");
    for (const name of ["g_arenasFile", "g_botsFile"]) expect(f.cvars.get(name)?.flags).toBe(CvarFlag.Init | CvarFlag.ReadOnly);
    const opened = f.files.current.openRead("scripts/bots.txt");
    if (opened === undefined) throw new Error("Missing actual retail bots.txt");
    expect(opened.file.slot).toBe(1); f.files.current.closeFile(opened.file);
  } finally { f.close(); }
});

test("catalog parses partial source infos, compresses only bots, and retains packed file order and live allocation usage", async () => {
  const f = await fixture({
    "scripts/arenas.txt": '{ map First longname Before/*inside*/After type "TEAM" } { map Second type "notffa_ctf_oneflag_overload_harvester_tourney" } { map Third }',
    "scripts/bots.txt": '{ name Half/*inside*/Name duplicate old duplicate new missing\r key value invalid "bad;value" } { name Partial',
    "scripts/z.bot": "{ name Last order Z }",
    "scripts/a.bot": "{ name Last order A }",
  }, true);
  try {
    f.catalog.loadArenas(); f.catalog.loadBots();
    expect(f.game.mapList.slice(0, 3).map(row => row.typeBits)).toEqual([0, 243, 1]);
    expect(infoSlot(f.game.mapList, 0).mapName).toBe("Before/*inside*/After");
    expect(f.catalog.getNumBots()).toBe(4);
    const first = f.catalog.getBotInfoByNumber(0) ?? "";
    expect(infoValueForKey(first, "name")).toBe("HalfName");
    expect(infoValueForKey(first, "duplicate")).toBe("new");
    expect(infoValueForKey(first, "missing")).toBe("<NULL>");
    expect(infoValueForKey(first, "key")).toBe("value");
    expect(infoValueForKey(first, "invalid")).toBe("");
    expect(f.catalog.getBotNameByNumber(1)).toBe("Partial");
    expect(f.catalog.getBotNameByNumber(2)).toBe("Last");
    expect(infoValueForKey(f.catalog.getBotInfoByNumber(2) ?? "", "order")).toBe("Z");
    expect(f.catalog.getBotInfoByName("LAST")).toBe(f.catalog.getBotInfoByNumber(2));
    expect(f.prints).toContain("Unexpected end of info file\n");
    const before = f.memory.allocatedBytes;
    f.catalog.loadBots();
    expect(f.catalog.getNumBots()).toBe(4);
    expect(f.memory.allocatedBytes).toBeGreaterThan(before);
  } finally { f.close(); }
});

test("cvar overrides, file limits, exhausted pools and 128-map publication cap preserve source behavior", async () => {
  const arenas = Array.from({ length: 129 }, (_, i) => `{ map m${i} }`).join("\n");
  const f = await fixture({ "custom.txt": arenas, "huge.txt": "x".repeat(8192),
    "many.txt": "{ } ".repeat(1025), "scripts/bots.txt": "{ name Bot }" });
  try {
    f.cvars.set("g_arenasFile", "custom.txt", true);
    f.cvars.set("g_botsFile", "huge.txt", true);
    f.catalog.loadArenas(); f.catalog.loadBots();
    expect(f.game.mapCount).toBe(128);
    expect(infoSlot(f.game.mapList, 127).mapLoadName).toBe("m127");
    expect(f.prints).toContain("129 arenas parsed\n");
    expect(f.catalog.getNumBots()).toBe(0);
    expect(f.prints).toContain("^1file too large: huge.txt is 8192, max allowed is 8192");
    f.cvars.set("g_botsFile", "many.txt", true);
    f.catalog.loadBots();
    expect(f.catalog.getNumBots()).toBe(1024);
    expect(f.prints).toContain("Max infos exceeded\n");
    f.memory.initializeStrings(); f.memory.allocate(1024 * 1024);
    f.cvars.set("g_botsFile", "scripts/bots.txt", true);
    f.catalog.loadBots();
    expect(f.catalog.getNumBots()).toBe(0);
    f.catalog.loadArenas();
    expect(f.game.mapCount).toBe(0);
    expect(f.prints).toContain("^3WARNING: not anough memory in pool to load all arenas\n");
  } finally { f.close(); }
});

test("catalog short reads reject reached unknown stack bytes but accept a known NUL before the unread tail", async () => {
  const f = await fixture({ "short.txt": "{ name Known }\0padding", "unknown.txt": "{ name Unknown }padding" });
  try {
    const open = f.files.current.openRead.bind(f.files.current);
    f.files.current.openRead = filename => {
      const result = open(filename);
      if (filename === "short.txt") truncateSync(join(f.directory, "missionpack", filename), 15);
      if (filename === "unknown.txt") truncateSync(join(f.directory, "missionpack", filename), 16);
      return result;
    };
    f.cvars.set("g_botsFile", "short.txt", true);
    f.catalog.loadBots();
    expect(f.catalog.getBotNameByNumber(0)).toBe("Known");
    f.cvars.set("g_botsFile", "unknown.txt", true);
    expect(() => f.catalog.loadBots()).toThrow("uninitialized short-read tail");
    expect(f.catalog.getNumBots()).toBe(0);
    const reopened = f.files.current.openRead("short.txt");
    if (reopened === undefined) throw new Error("Missing short read fixture");
    expect(reopened.file.slot).toBe(1); f.files.current.closeFile(reopened.file);
  } finally { f.close(); }
});

test("retirement during catalog logging stops before map publication", async () => {
  const f = await fixture({ "scripts/arenas.txt": "{ map Never }" });
  try {
    const push = f.prints.push.bind(f.prints);
    f.prints.push = (...messages) => { f.retire(); return push(...messages); };
    expect(() => f.catalog.loadArenas()).toThrow("retired Team Arena catalog");
    expect(f.game.mapCount).toBe(0);
    expect(infoSlot(f.game.mapList, 0).mapLoadName).toBeNull();
  } finally { f.close(); }
});
