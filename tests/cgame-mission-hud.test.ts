import { HunkArena } from "../src/core/hunk.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { SourceFileReader } from "../src/assets/reader.ts";
import type { PcmSound } from "../src/assets/wav.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { AudioMixer } from "../src/audio/mixer.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { ClientDrawIcons } from "../src/cgame/draw-icons.ts";
import { ClientDrawTools } from "../src/cgame/draw-tools.ts";
import { ClientConfiguration, ClientVmCvarSymbol } from "../src/cgame/config.ts";
import { ClientMedia } from "../src/cgame/media.ts";
import { MissionHud, MissionScoreFeeder } from "../src/cgame/mission-hud.ts";
import type { MissionHudHost } from "../src/cgame/mission-hud.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import type { SoundAssetReader } from "../src/cgame/sound-bank.ts";
import { ClientGameState, ClientGameStaticState } from "../src/cgame/state.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { EngineUiCinematics } from "../src/engine/ui-cinematics.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import { EngineUiModelPainter } from "../src/engine/ui-model.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { UiAssetRegistry } from "../src/render/font.ts";
import { RendererResources } from "../src/render/world.ts";
import { GameType, MoveType, Team, statSchema } from "../src/shared/definitions.ts";
import { loadMenuDefinitions, UiWindowFlag } from "../src/ui/menu.ts";
import { UiRuntime } from "../src/ui/runtime.ts";
import type { UiRuntimeOptions } from "../src/ui/runtime.ts";
import { TeamArenaUiCvars } from "../src/ui/team-arena/cvars.ts";
import { TeamArenaUiMemory } from "../src/ui/team-arena/memory.ts";
import { TeamArenaUiResources } from "../src/ui/team-arena/resources.ts";
import { musicWav } from "./music-file-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

function at<T>(items: readonly T[], index: number): T { const item = items[index]; if (item === undefined) throw new Error(`Missing fixture ${index}`); return item; }
function unexpected(): never { throw new Error("Unexpected fixture service"); }
class MemoryAssets implements SoundAssetReader, SourceFileReader, RetainedFileReader {
  private readonly retained = withRetainedFiles({
    readFileOptional: (path: string) => this.readFileOptional(path),
    readFileOptionalSync: (path: string) => this.readFileOptionalSync(path),
  });
  readFileRetained = this.retained.readFileRetained;
  readFileRetainedSync = this.retained.readFileRetainedSync;
  freeFile = this.retained.freeFile;
  readonly files = new Map<string, Uint8Array>();
  has(path: string): boolean { return this.files.has(path); }
  list(prefix = ""): readonly string[] { return [...this.files.keys()].filter(path => path.startsWith(prefix)); }
  async read(path: string): Promise<Uint8Array> { return this.readSync(path); }
  readSync(path: string): Uint8Array { const bytes = this.files.get(path); if (bytes === undefined) throw new Error(`Missing ${path}`); return bytes.slice(); }
  readFileLength(path: string): number { return this.files.get(path)?.byteLength ?? -1; }
  readFileOptionalSync(path: string): Uint8Array | undefined { return this.files.get(path)?.slice(); }
  async readFileOptional(path: string): Promise<Uint8Array | undefined> { return this.readFileOptionalSync(path); }
  text(path: string, value: string): void { this.files.set(path, new TextEncoder().encode(value)); }
}
function menuMediaAssets(): MemoryAssets {
  const assets = new MemoryAssets(), model = new Uint8Array(164), view = new DataView(model.buffer);
  view.setInt32(0, 0x33504449, true); view.setInt32(4, 15, true); view.setInt32(76, 1, true);
  view.setInt32(92, 108, true); view.setInt32(96, 164, true); view.setInt32(100, 164, true); view.setInt32(104, 164, true);
  assets.files.set("models/hud.md3", model);
  assets.files.set("sound/focus.wav", musicWav({ sampleRate: 22050, channels: 1,
    samples: Int16Array.of(100, -100), frameCount: 2, loopStart: null }));
  assets.text("scripts/hud.shader", "fixture/first { { map $whiteimage } } fixture/second { { map $whiteimage } }");
  return assets;
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
async function fixture(assets: RetainedFileReader & SoundAssetReader & SourceFileReader = new MemoryAssets(), window: SdlWindow | null = null) {
  const state = new ClientGameState("missionpack", 0, 0), cgs = new ClientGameStaticState("missionpack");
  state.snap = { messageNumber: 1, serverTime: 1000, deltaNumber: -1, flags: 0, serverCommandNumber: 0,
    parseEntitiesNumber: 0, areaMask: new Uint8Array(32), playerState: state.predictedPlayerState.copy(), entities: [] };
  state.snap.playerState.clientNum = 3;
  const cvars = new CvarRegistry();
  for (const [name, value] of [["cg_currentSelectedPlayer", "0"], ["cl_paused", "0"], ["ui_smallFont", ".25"],
    ["ui_bigFont", ".4"], ["cg_drawStatus", "1"], ["cg_drawIcons", "1"], ["cg_draw3dIcons", "0"],
    ["cg_redTeamName", "Stroggs"], ["cg_blueTeamName", "Pagans"]]) {
    if (name === undefined || value === undefined) throw new Error("Missing cvar pair");
    cvars.register(name, value);
  }
  const configuration = new ClientConfiguration("missionpack", { cvars, state, staticState: cgs,
    clients: { newClientInfo: unexpected }, configString: () => "" });
  configuration.registerCvars();
  const calls: string[] = [], prints: string[] = [], catches: number[] = [];
  const images = new RendererImageCatalog(), gl = window === null ? null : new GlRenderer(window, images);
  const settings = createRendererSettings();
  gl?.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const cpu = new SoftwareRenderer(640, 480, images, gl?.subpixelBits ?? 8), recording = new BatchRecordingBackend(cpu);
  const target = gl === null ? new RenderTarget(images, [recording]) : new RenderTarget(images, [recording, gl]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => state.time };
  const cinematicOwner = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: text => { prints.push(text); return undefined; }, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 2048, inGameVideo: () => 1 } });
  const resources = await RendererResources.create(assets, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, print: text => { prints.push(text); }, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematicOwner.shaderCinematics }), bank = new ClientSoundBank(assets, { debugPrint: text => { prints.push(text); }, print: text => { prints.push(text); } });
  const renderCommands = new RenderCommandBuffer(target, { print: (text: string) => { prints.push(text); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  const media = new ClientMedia("missionpack", cgs, resources, bank), draw = renderCommands.draw2D("stretch-640");
  media.graphics.whiteShader = await resources.registerShader("white");
  const tools = new ClientDrawTools(draw, media);
  const icons = new ClientDrawIcons(state, tools, () => ({ drawIcons: true, draw3dIcons: false }), renderCommands);
  const cinematics = new EngineUiCinematics(cinematicOwner, "cgame");
  const host: MissionHudHost = { assets, fontRegistry: new UiAssetRegistry(resources, text => { prints.push(text); }), icons,
    configuration,
    cvars, commands: { append: text => { calls.push(text); } }, clients: { loadDeferredPlayers: async () => { calls.push("deferred"); } },
    random: new GameRandom(1), cinematics, modelPainter: new EngineUiModelPainter(resources, renderCommands),
    audio: { playLocal: sound => {
      const registered = typeof sound === "number" ? bank.soundForIndex(sound) : sound ?? null;
      if (registered === undefined) return;
      const pcm = bank.resolveForPlayback(registered); if (pcm !== null) mixer.startLocalSound(pcm, 6);
    },
      startBackground: unexpected, stopBackground: unexpected },
    configString: () => "", resetPlayerEntity: unexpected, print: text => { prints.push(text); }, milliseconds: () => state.time,
    setKeyCatcher: mask => { catches.push(mask); } };
  const hud = new MissionHud(state, cgs, media, host);
  cleanups.push(() => { hud.dispose(); cinematicOwner.dispose(); renderCommands.close("discard"); target.close(); window?.close(); });
  return { hud, state, cgs, cvars, configuration, calls, prints, catches, resources, media, host, draw, renderCommands, cpu, gl, recording,
    select: (integerValue: number) => { configuration.setVmInteger(ClientVmCvarSymbol.cg_currentSelectedPlayer, integerValue); } };
}

describe("Team Arena MissionHud source orders and feeders", () => {
  test("actual cgame pools use 128KiB and exhausted strings reach model, font and stopped sound owners as NULL", async () => {
    const assets = menuMediaAssets();
    assets.text("ui/hud.txt", 'loadmenu { "ui/test.menu" }');
    assets.text("ui/test.menu", 'menuDef { name "seed" }');
    const f = await fixture(assets), captured: { options: UiRuntimeOptions | null } = { options: null };
    const create = UiRuntime.create;
    UiRuntime.create = async options => { captured.options = options; return create(options); };
    try { await f.hud.loadHudMenu(); } finally { UiRuntime.create = create; }
    const options = captured.options;
    if (options === null || options.definitions.memory.kind !== "qvm32"
      || !(options.definitions.memory.memory instanceof TeamArenaUiMemory)) throw new Error("HUD did not publish its source pool");
    const memory = options.definitions.memory.memory, bridge = options.resources;
    expect(memory.module).toBe("cgame");
    expect(memory.allocate(128 * 1024 - memory.allocatedBytes)).not.toBeNull();
    expect(memory.allocate(1)).toBeNull();
    f.hud.resetStrings();
    expect(memory.stringAlloc("x".repeat(128 * 1024 - 2))).not.toBeNull();
    expect(memory.stringBytes).toBe(128 * 1024 - 1);
    expect(memory.stringAlloc("overflow")).toBeNull();

    const fontBytes = new Uint8Array(20548);
    new DataView(fontBytes.buffer).setFloat32(20480, 4, true);
    assets.files.set("fonts/fontImage_12.dat", fontBytes);
    assets.text("ui/test.menu", 'assetGlobalDef { font "ignored.ttf" 12 } menuDef { name "exhausted" '
      + 'itemDef { type 7 asset_model "models/hud.md3" } itemDef { focusSound "sound/focus.wav" } }');
    f.media.soundBank.setRegistrationEnabled(false);
    const reached: (readonly [string, string | null])[] = [];
    const model = f.resources.registerModel, font = f.host.fontRegistry.registerFont.bind(f.host.fontRegistry);
    const sound = f.media.soundBank.registerSound.bind(f.media.soundBank);
    f.resources.registerModel = async path => { reached.push(["model", path]); return model(path); };
    f.host.fontRegistry.registerFont = async (path, size) => { reached.push(["font", path]); return font(path, size); };
    f.media.soundBank.registerSound = async (path, compressed) => { reached.push(["sound", path]); return sound(path, compressed); };
    await f.hud.loadHudMenu();
    expect(reached).toEqual([["font", null], ["model", null], ["sound", null]]);
    expect(f.hud.fonts.normal.glyphScale).toBe(4);
    expect(bridge.registeredModel(null)).toBe(f.resources.modelForHandle(0));
    expect(bridge.registeredModel("null")).toBeUndefined();
    expect(bridge.registeredSound(null)).toBeUndefined();
    expect(f.hud.menuState()?.menus[0]?.items).toHaveLength(2);
    expect(f.prints).toContain("RE_RegisterModel: NULL name\n");
    const shader = f.resources.registerShaderNoMip;
    f.resources.registerShaderNoMip = async path => { reached.push(["shader", path]); return shader(path); };
    assets.text("ui/test.menu", 'menuDef { itemDef { asset_shader "missing" } }');
    await expect(f.hud.loadHudMenu()).rejects.toThrow("RE_RegisterShaderNoMip: undefined source NULL name read");
    expect(reached.at(-1)).toEqual(["shader", null]);
  });
  test("source UI records store engine media handles and retain source lookup lifetimes", async () => {
    const assets = menuMediaAssets();
    assets.text("ui/resources.txt", 'loadmenu { "ui/resources.menu" }');
    assets.text("ui/resources.menu", 'menuDef { name "media" background "fixture/first" '
      + 'itemDef { name "picture" background "fixture/first" asset_shader "fixture/first" focusSound "sound/focus.wav" } '
      + 'itemDef { name "model" type 7 asset_model "models/hud.md3" background "missing" focusSound "sound/missing.wav" } }');
    const f = await fixture(assets), current = (): undefined => undefined;
    await f.media.soundBank.beginRegistration();
    const resources = new TeamArenaUiResources({ renderer: f.resources, sound: { bank: f.media.soundBank },
      fontRegistry: f.host.fontRegistry, cvars: new TeamArenaUiCvars(f.cvars, current),
      cinematics: new EngineUiCinematics(f.host.cinematics.owner, "ui"), assertCurrentOperation: current });
    cleanups.push(() => resources.dispose());
    const memory = new TeamArenaUiMemory("qvm32", text => { f.prints.push(text); });
    const definitions = await loadMenuDefinitions({ random: { nextInt: () => 1 }, resolver: {
      resolveRoot: path => {
        const bytes = assets.files.get(path);
        return bytes === undefined ? undefined : { path, text: new TextDecoder().decode(bytes) };
      }, resolve: () => undefined,
    } }, { kind: "ui", setPaths: ["ui/resources.txt"] }, {}, { memory: { kind: "qvm32", memory }, registrationSink: resources });
    const menu = at(definitions.menus, 0), pictureItem = at(menu.items, 0), modelItem = at(menu.items, 1);
    const pictureOffset = pictureItem.allocationOffset, modelOffset = modelItem.allocationOffset;
    if (pictureOffset === undefined || modelOffset === undefined) throw new Error("Source media items have no pool allocation");
    const pictureRecord = memory.borrow(pictureOffset, 540), modelRecord = memory.borrow(modelOffset, 540);
    const shader = await f.resources.registerShaderNoMip("fixture/first"), shaderHandle = f.resources.shaderHandle(shader);
    const model = await f.resources.registerModel("models/hud.md3"), modelHandle = f.resources.modelHandle(model);
    const sound = await f.media.soundBank.registerSound("sound/focus.wav", false), soundHandle = f.media.soundBank.indexForSound(sound);
    if (sound === null) throw new Error("Authored focus sound did not register");
    expect(shaderHandle).toBeGreaterThan(0); expect(modelHandle).toBeGreaterThan(0); expect(soundHandle).toBeGreaterThan(0);
    expect(memory.menuRecord(0).getInt32(176)).toBe(shaderHandle);
    expect(pictureRecord.getInt32(176)).toBe(shaderHandle); expect(pictureRecord.getInt32(232)).toBe(shaderHandle);
    expect(pictureRecord.getInt32(280)).toBe(soundHandle); expect(modelRecord.getInt32(232)).toBe(modelHandle);
    expect(modelRecord.getInt32(176)).toBe(0); expect(modelRecord.getInt32(280)).toBe(0);
    const handles = resources.handles;
    if (handles.kind !== "source") throw new Error("Production UI resources selected diagnostic handles");
    expect(handles.pictureForHandle(shaderHandle)).toBe(resources.registeredPicture("fixture/first"));
    expect(handles.modelForHandle(modelHandle)).toBe(model); expect(f.media.soundBank.soundForIndex(soundHandle)).toBe(sound);
    expect(handles.pictureForHandle(0)).toBeUndefined();
    expect(await resources.register({ kind: "model", reference: { kind: "model", path: "models/missing.md3" },
      location: { path: "fixture", line: 1, column: 1 } })).toEqual({ handle: 0 });
    expect(handles.modelForHandle(0)).toBe(f.resources.modelForHandle(0));
    const second = await f.resources.registerShaderNoMip("fixture/second"), secondHandle = f.resources.shaderHandle(second);
    pictureRecord.setInt32(176, secondHandle);
    expect(pictureItem.window.backgroundHandle).toBe(secondHandle);
    expect(handles.pictureForHandle(secondHandle)).toBe(f.resources.picture(second));
    f.media.soundBank.resetLookup();
    const replacement = await resources.registerSound("sound/focus.wav");
    expect(replacement).not.toBe(sound); expect(f.media.soundBank.soundForIndex(soundHandle)).toBe(sound);
    expect(pictureItem.focusSoundHandle).toBe(soundHandle);
    f.media.soundBank.setRegistrationEnabled(false);
    expect(await resources.register({ kind: "sound", reference: { kind: "sound", path: "sound/focus.wav" },
      location: { path: "fixture", line: 1, column: 1 } })).toEqual({ handle: 0 });
    resources.dispose(); expect(() => handles.pictureForHandle(shaderHandle)).toThrow("disposed");
  });
  test("MissionHud retains source media handles through focus scripts and rejects retired registration", async () => {
    const assets = menuMediaAssets(); assets.text("ui/hud.txt", 'loadmenu { "ui/test.menu" }');
    assets.text("ui/test.menu", 'menuDef { name "score_menu" visible 1 rect 0 0 640 480 background "fixture/first" '
      + 'itemDef { name "panel" type 1 visible 1 rect 10 10 80 30 background "fixture/first" asset_shader "fixture/first" '
      + 'focusSound "sound/focus.wav" onFocus { setbackground "missing"; } } '
      + 'itemDef { name "model" type 7 asset_model "models/hud.md3" } }');
    const f = await fixture(assets); await f.media.soundBank.beginRegistration();
    await f.hud.loadHudMenu(); f.state.showScores = true; await f.hud.drawScoreboard();
    const captured = f.hud.menuScoreboard();
    if (captured === null) throw new Error("Authored scoreboard was not captured");
    const panel = at(captured.definition.items, 0), modelItem = at(captured.definition.items, 1);
    const shader = await f.resources.registerShaderNoMip("fixture/first"), shaderHandle = f.resources.shaderHandle(shader);
    const model = await f.resources.registerModel("models/hud.md3");
    const sound = await f.media.soundBank.registerSound("sound/focus.wav", false), soundHandle = f.media.soundBank.indexForSound(sound);
    if (sound === null) throw new Error("Authored focus sound did not register");
    expect(panel.allocationOffset).toBeDefined(); expect(captured.definition.window.backgroundHandle).toBe(shaderHandle);
    expect(panel.window.backgroundHandle).toBe(shaderHandle); expect(panel.assetHandle).toBe(shaderHandle);
    expect(modelItem.assetHandle).toBe(f.resources.modelHandle(model)); expect(panel.focusSoundHandle).toBe(soundHandle);
    const sourceLookup = f.media.soundBank.soundForIndex.bind(f.media.soundBank), soundLookups: number[] = [];
    const played: (PcmSound | null | undefined)[] = [], reachedBackgrounds: (number | undefined)[] = [];
    f.media.soundBank.soundForIndex = handle => {
      soundLookups.push(handle); const value = sourceLookup(handle); played.push(value); return value;
    };
    const register = f.resources.registerShaderNoMip;
    f.resources.registerShaderNoMip = async path => {
      if (path === "missing") reachedBackgrounds.push(panel.window.backgroundHandle);
      return await register(path);
    };
    f.state.predictedPlayerState.pmType = MoveType.PM_DEAD;
    await f.hud.mouseEvent(20, 20); await f.hud.mouseEvent(0, 0);
    expect(reachedBackgrounds).toEqual([shaderHandle]); expect(panel.window.backgroundHandle).toBe(0);
    expect(soundLookups).toEqual([soundHandle]); expect(played).toEqual([sound]);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.resources.registerShaderNoMip = async path => { entered.resolve(); await release.promise; return await register(path); };
    const pending = f.hud.loadHudMenu(); await entered.promise; f.hud.resetStrings(); release.resolve();
    await expect(pending).rejects.toThrow("retired lifecycle");
  });
  test("font thresholds resolve source engine ui_* names through the real cgame VM cache", async () => {
    const f = await fixture();
    const configuration = new ClientConfiguration("missionpack", { cvars: f.cvars, state: f.state, staticState: f.cgs,
      clients: { newClientInfo: unexpected }, configString: () => "" });
    configuration.registerCvars();
    const hud = new MissionHud(f.state, f.cgs, f.media, { ...f.host, configuration });
    expect(hud.fonts.smallThreshold).toBe(Math.fround(0.25));
    expect(hud.fonts.bigThreshold).toBe(Math.fround(0.4));
    expect(f.cvars.get("cg_smallFont")).toBeUndefined(); expect(f.cvars.get("cg_bigFont")).toBeUndefined();
    f.state.showScores = true; expect(await hud.drawScoreboard()).toBe(true); expect(f.cvars.get("cg_paused")).toBeUndefined();
    hud.dispose();
  });
  test("native source all seven tasks preserve self, targeted and Everyone command ordering", async () => {
    const f = await fixture(); f.cgs.gameType = GameType.GT_CTF; f.state.numSortedTeamPlayers = 2;
    f.state.sortedTeamPlayers[0] = 3; f.state.sortedTeamPlayers[1] = 7;
    const personal = ["onoffense", "ondefense", "onpatrol", "onfollow", "ongetflag", "onfollowcarrier", "oncamping"];
    const team = ["offense", "defend", "patrol", "followme", "returnflag", "followflagcarrier", "camp"];
    for (let target = 0; target < 3; target++) for (let task = 1; task <= 7; task++) {
      f.calls.length = 0; f.select(target); f.cgs.currentOrder = task; f.cgs.orderPending = true;
      f.hud.checkOrderPending();
      const expected = target === 0 ? [`teamtask ${task}\n`, `cmd vsay_team ${at(personal, task - 1)}\n`]
        : [target === 1 ? `cmd vtell 7 ${at(team, task - 1)}\n` : `cmd vsay_team ${at(team, task - 1)}\n`];
      if (task <= 4) expected.push(`+button${task + 6}; wait; -button${task + 6}`);
      expect(f.calls).toEqual(expected); expect(f.cgs.orderPending).toBe(false);
    }
    f.cgs.gameType = GameType.GT_TEAM; f.cgs.orderPending = true; f.calls.length = 0;
    f.hud.checkOrderPending(); expect(f.cgs.orderPending).toBe(true); expect(f.calls).toEqual([]);
  });
  test("native selection quirks mutate only VM integer and flush prior order first", async () => {
    const f = await fixture(); f.cgs.gameType = GameType.GT_CTF; f.state.numSortedTeamPlayers = 2;
    f.state.sortedTeamPlayers[0] = 3; f.state.sortedTeamPlayers[1] = 7;
    Object.assign(at(f.cgs.clientInfo, 7), { name: "Other", teamTask: 7 });
    f.cgs.currentOrder = 2; f.cgs.orderPending = true; f.hud.selectNextPlayer();
    expect(f.calls).toEqual(["teamtask 2\n", "cmd vsay_team ondefense\n", "+button8; wait; -button8"]);
    expect(f.hud.getSelectedPlayer()).toBe(1); expect(f.cgs.currentOrder).toBe(7);
    expect(f.cvars.get("cg_selectedPlayerName")?.value).toBe("Other"); expect(f.cvars.get("cg_selectedPlayer")?.value).toBe("7");
    expect(f.cvars.get("cg_currentSelectedPlayer")?.integerValue).toBe(0);
    expect(f.host.configuration.readVmCvar("cg_currentSelectedPlayer").value).toBe("0");
    f.hud.selectNextPlayer(); expect(f.cvars.get("cg_selectedPlayerName")?.value).toBe("Everyone");
    f.hud.selectPreviousPlayer(); expect(f.host.configuration.readVmCvar("cg_currentSelectedPlayer").integerValue).toBe(2);
    expect(f.hud.getSelectedPlayer()).toBe(0); expect(f.cvars.get("cg_selectedPlayer")?.value).toBe("7");
  });
  test("source chat rotation and source byte bounds", async () => {
    const f = await fixture(); f.hud.setPrintString(0, "system"); f.hud.setPrintString(1, "first"); f.hud.setPrintString(2, "second");
    expect(f.hud.chat()).toEqual({ system: "system", team1: "second", team2: "first" });
    expect(() => f.hud.setPrintString(1, "x".repeat(256))).toThrow(); f.hud.initTeamChat();
    expect(f.hud.chat()).toEqual({ system: "", team1: "", team2: "" });
  });
  test("score feed uses team filtered rows, source info.score, readiness mask and numeric formatting", async () => {
    const f = await fixture(); f.cgs.gameType = GameType.GT_CTF; f.state.numScores = 3;
    Object.assign(at(f.state.scores, 0), { client: 2, team: Team.TEAM_BLUE, score: 100, time: 9, ping: -1 });
    Object.assign(at(f.state.scores, 1), { client: 3, team: Team.TEAM_RED, score: 200, time: 31, ping: 58 });
    Object.assign(at(f.state.scores, 2), { client: 7, team: Team.TEAM_BLUE });
    Object.assign(at(f.cgs.clientInfo, 2), { infoValid: true, name: "Blue", score: 4, handicap: 90, team: Team.TEAM_BLUE });
    Object.assign(at(f.cgs.clientInfo, 3), { infoValid: true, name: "Self", score: 5, team: Team.TEAM_RED, teamLeader: true });
    expect(f.hud.feederCount(MissionScoreFeeder.BLUE)).toBe(2); expect(f.hud.feederCount(MissionScoreFeeder.RED)).toBe(1);
    expect(f.hud.feederCount(MissionScoreFeeder.SCOREBOARD)).toBe(3); expect(f.hud.feederCount(99)).toBe(0);
    expect(f.hud.feederItem(5, 0, 3).text).toBe("Self"); expect(f.hud.feederItem(5, 0, 4).text).toBe("5");
    expect(f.hud.feederItem(5, 0, 2).text).toBe("Leader"); expect(f.hud.feederItem(5, 0, 5).text).toBe("  31");
    expect(f.hud.feederItem(6, 0, 6).text).toBe("connecting"); expect(f.hud.feederItem(6, 0, 0).text).toBe("90");
    const snap = f.state.snap; if (snap === null) throw new Error("Missing snapshot"); snap.playerState.stats.set(statSchema("missionpack").clientsReady, 1 << 3);
    expect(f.hud.feederItem(5, 0, 2).text).toBe("Ready");
    f.hud.feederSelection(6, 1); expect(f.state.selectedScore).toBe(2); f.hud.setScoreSelection(); expect(f.state.selectedScore).toBe(1);
  });
  test("feeder optional image distinguishes source -1 from handle zero, unlike window backgrounds", async () => {
    const f = await fixture(); f.cgs.gameType = GameType.GT_CTF; f.state.numScores = 1;
    Object.assign(at(f.state.scores, 0), { client: 3, team: Team.TEAM_RED });
    const info = at(f.cgs.clientInfo, 3); Object.assign(info, { infoValid: true, handicap: 100 });
    expect(f.hud.feederItem(5, 0, 0).picture).toBeUndefined();
    // Item_ListBox_Paint tests optionalImage >= 0: an assigned source zero still draws the global default shader.
    expect(f.hud.feederItem(5, 0, 1).picture).toEqual(f.resources.picture(null));
    info.botSkill = 1; expect(f.hud.feederItem(5, 0, 0).picture).toEqual(f.resources.picture(null));
  });
  test("image-style feeders call source CG_FeederItemImage zero, never text-column icon lookup", async () => {
    const assets = new MemoryAssets(); assets.text("ui/hud.txt", 'loadmenu { "ui/test.menu" }');
    assets.text("ui/test.menu", 'menuDef { name "images" visible 1 rect 0 0 640 480 '
      + 'itemDef { name "flags" type 6 visible 1 rect 10 10 100 80 feeder 11 elementwidth 32 elementheight 32 elementtype 1 } }');
    const f = await fixture(assets); f.state.numScores = 1;
    f.hud.feederItem = () => { throw new Error("Image feeder invoked text callback"); };
    await f.hud.loadHudMenu(); await f.hud.paintAll();
    expect(f.hud.menuState()?.menus[0]?.items[0]?.name).toBe("flags");
  });
  test("client lookup folds ASCII only and observes infoValid/maxclients", async () => {
    const f = await fixture(); f.cgs.maxclients = 4;
    Object.assign(at(f.cgs.clientInfo, 2), { infoValid: true, name: "\u00c0LPHA" });
    expect(f.hud.clientNumFromName("\u00c0lpha")).toBe(2); expect(f.hud.clientNumFromName("\u00e0lpha")).toBe(-1);
    at(f.cgs.clientInfo, 2).infoValid = false; expect(f.hud.clientNumFromName("\u00c0LPHA")).toBe(-1);
    expect(f.hud.clientNumFromName("x".repeat(2048))).toBe(-1);
  });
  test("source scoreboard paused/warmup/fade/deferred paths do not invent a menu", async () => {
    const f = await fixture(); f.state.showScores = true;
    for (let i = 0; i < 11; i++) expect(await f.hud.drawScoreboard()).toBe(true);
    expect(f.calls).toEqual(["deferred"]); expect(f.hud.menuScoreboard()).toBeNull();
    f.state.showScores = false; f.state.warmup = 10; expect(await f.hud.drawScoreboard()).toBe(false);
    expect(f.state.deferredPlayerLoading).toBe(11);
    f.state.warmup = 0; f.state.time = 1200; f.state.scoreFadeTime = 1000; f.state.killerName = "killer";
    expect(await f.hud.drawScoreboard()).toBe(false); expect(f.state.killerName).toBe(""); expect(f.state.deferredPlayerLoading).toBe(0);
    f.state.predictedPlayerState.pmType = MoveType.PM_DEAD; expect(await f.hud.drawScoreboard()).toBe(true);
    f.configuration.setVmInteger(ClientVmCvarSymbol.cg_paused, 1);
    expect(await f.hud.drawScoreboard()).toBe(false); expect(f.state.deferredPlayerLoading).toBe(0);
  });
  test("voice timeout closes after 2500, not at the boundary, and source input gates clear catcher", async () => {
    const f = await fixture(); f.state.time = 100; await f.hud.showResponseHead();
    expect(f.state.voiceTime).toBe(100); expect(f.cvars.get("cl_conXOffset")?.value).toBe("72");
    f.state.time = 2600; await f.hud.drawTimedMenus(); expect(f.state.voiceTime).toBe(100);
    f.state.time++; await f.hud.drawTimedMenus(); expect(f.state.voiceTime).toBe(0); expect(f.cvars.get("cl_conXOffset")?.value).toBe("0");
    await f.hud.mouseEvent(5, 8); await f.hud.keyEvent(13, false); await f.hud.keyEvent(13, true);
    expect(f.catches).toEqual([0, 0]); expect(f.cgs.cursorX).toBe(0); expect(f.cgs.eventHandling).toBe(0);
  });
  test("CG_AssetCache registers all seventeen actual names in source order and owns zero handles", async () => {
    const f = await fixture(), paths: (string | null)[] = [], original = f.resources.registerShaderNoMip;
    f.resources.registerShaderNoMip = async path => { paths.push(path); return await original(path); };
    await f.hud.assetCache();
    expect(paths).toEqual(["ui/assets/gradientbar2.tga", "menu/art/fx_base", "menu/art/fx_red", "menu/art/fx_yel", "menu/art/fx_grn",
      "menu/art/fx_teal", "menu/art/fx_blue", "menu/art/fx_cyan", "menu/art/fx_white", "ui/assets/scrollbar.tga",
      "ui/assets/scrollbar_arrow_dwn_a.tga", "ui/assets/scrollbar_arrow_up_a.tga", "ui/assets/scrollbar_arrow_left.tga",
      "ui/assets/scrollbar_arrow_right.tga", "ui/assets/scrollbar_thumb.tga", "ui/assets/slider2.tga", "ui/assets/sliderbutt_1.tga"]);
    expect(f.hud.cachedAssets().fxBase).toBeNull(); expect(f.hud.cachedAssets().fxColors).toEqual([null, null, null, null, null, null, null]);
    expect(f.hud.cachedAssets().widgets.whiteShader).toBe(f.resources.picture(f.media.graphics.whiteShader));
    expect(f.hud.fonts.normal.glyphScale).toBe(0); expect(f.hud.fonts.normal.glyphs).toHaveLength(256);
  });
  test("parse registration executes in source token order once, preserving missing shader zero", async () => {
    const assets = new MemoryAssets(); assets.text("ui/hud.txt", 'loadmenu { "ui/test.menu" }');
    assets.text("ui/test.menu", 'assetGlobalDef { cursor "cursor-a" gradientbar "gradient-a" cursor "cursor-b" } '
      + 'menuDef { name "score_menu" visible 0 rect 0 0 640 480 itemDef { name "value" visible 1 rect 10 10 20 20 ownerdraw 4 background "missing" } }');
    const f = await fixture(assets), paths: (string | null)[] = [], original = f.resources.registerShaderNoMip;
    f.resources.registerShaderNoMip = async path => { paths.push(path); return await original(path); };
    await f.hud.loadHudMenu();
    expect(paths).toEqual(["cursor-a", "gradient-a", "cursor-b", "missing"]);
    expect(f.hud.menuState()?.menus[0]?.items[0]?.background).toBeUndefined();
    f.state.showScores = true; expect(await f.hud.drawScoreboard()).toBe(true);
    expect(f.hud.menuScoreboard()?.definition.window.name).toBe("score_menu");
    expect(f.renderCommands.submit().batches).toBe(0); // Zero font metrics draw no glyphs; failed background does not take the shader branch.
  });
  test("font no-write outcomes preserve reached HUD destinations and continue menu parsing", async () => {
    const assets = new MemoryAssets(), valid = new Uint8Array(20548);
    new DataView(valid.buffer).setFloat32(20480, 4, true);
    assets.files.set("fonts/fontImage_12.dat", valid);
    assets.files.set("fonts/fontImage_14.dat", new Uint8Array(3));
    assets.text("ui/hud.txt", 'loadmenu { "ui/test.menu" }');
    assets.text("ui/test.menu", 'assetGlobalDef { font "ignored.ttf" 12 font "missing.ttf" 13 smallFont "wrong.ttf" 14 } '
      + 'menuDef { name "continued" rect 0 0 640 480 }');
    const f = await fixture(assets), small = f.hud.fonts.small;
    await f.hud.loadHudMenu();
    expect(f.hud.fonts.normal.name).toBe("fonts/fontImage_12.dat");
    expect(f.hud.fonts.normal.glyphScale).toBe(4); expect(f.hud.fonts.small).toBe(small);
    expect(f.hud.menuState()?.menus[0]?.name).toBe("continued");
    expect(f.prints.filter(text => text.startsWith("RE_RegisterFont:"))).toEqual([
      "RE_RegisterFont: FreeType code not available\n", "RE_RegisterFont: FreeType code not available\n",
    ]);
    const retained = f.hud.fonts.normal;
    assets.text("ui/test.menu", 'assetGlobalDef { font "missing.ttf" 13 } menuDef { name "later" rect 0 0 640 480 }');
    await f.hud.loadHudMenu(); expect(f.hud.fonts.normal).toBe(retained);
  });
  test("scoreboard forced paint does not activate/onOpen and team selection passes total row count", async () => {
    const assets = new MemoryAssets(); assets.text("ui/hud.txt", 'loadmenu { "ui/test.menu" }');
    assets.text("ui/test.menu", 'menuDef { name "teamscore_menu" visible 0 rect 0 0 640 480 onOpen { setcvar opened yes; } '
      + 'itemDef { name "red" visible 1 rect 10 10 200 40 type 6 feeder 5 elementwidth 180 elementheight 20 elementtype 1 columns 1 0 100 10 } }');
    const f = await fixture(assets); f.cgs.gameType = GameType.GT_CTF; f.state.numScores = 3;
    Object.assign(at(f.state.scores, 0), { client: 2, team: Team.TEAM_BLUE });
    Object.assign(at(f.state.scores, 1), { client: 3, team: Team.TEAM_RED });
    Object.assign(at(f.state.scores, 2), { client: 7, team: Team.TEAM_RED });
    await f.hud.loadHudMenu(); f.state.showScores = true; await f.hud.drawScoreboard();
    const menu = f.hud.menuState()?.menus[0]; expect(menu).toBeDefined();
    expect(menu?.items[0]?.cursorPosition).toBe(2); expect(f.state.selectedScore).toBe(1);
    expect((menu?.flags ?? 0) & UiWindowFlag.Forced).not.toBe(0);
    expect((menu?.flags ?? 0) & (UiWindowFlag.Visible | UiWindowFlag.HasFocus)).toBe(0);
    expect(f.cvars.get("opened")).toBeUndefined();
    f.configuration.setVmInteger(ClientVmCvarSymbol.cg_paused, 1);
    await f.hud.drawScoreboard(); expect((f.hud.menuState()?.menus[0]?.flags ?? 0) & UiWindowFlag.Forced).toBe(0);
  });
  test("voice menu open/close scripts complete before source cvar and timestamp changes", async () => {
    const assets = new MemoryAssets(); assets.text("ui/hud.txt", 'loadmenu { "ui/test.menu" }');
    assets.text("ui/test.menu", 'menuDef { name "voiceMenu" visible 0 rect 0 0 100 100 onOpen { setcvar voiceOpened yes; } onClose { setcvar voiceClosed yes; } }');
    const f = await fixture(assets); await f.hud.loadHudMenu(); f.state.time = 100;
    await f.hud.showResponseHead(); expect(f.cvars.get("voiceOpened")?.value).toBe("yes");
    expect((f.hud.menuState()?.menus[0]?.flags ?? 0) & UiWindowFlag.Visible).not.toBe(0);
    f.state.time = 2601; await f.hud.drawTimedMenus(); expect(f.cvars.get("voiceClosed")?.value).toBe("yes");
    expect((f.hud.menuState()?.menus[0]?.flags ?? 0) & UiWindowFlag.Visible).toBe(0); expect(f.state.voiceTime).toBe(0);
  });
  test("menu soundLoop stays a music name until activation and never registers a sound effect", async () => {
    const assets = new MemoryAssets(); assets.text("ui/hud.txt", 'loadmenu { "ui/test.menu" }');
    assets.text("ui/test.menu", 'menuDef { name "voiceMenu" visible 0 rect 0 0 100 100 soundLoop "music/voice.wav" }');
    const f = await fixture(assets), music: (string | null)[] = [];
    f.media.soundBank.registerSound = () => { throw new Error("Music name registered as a sound effect"); };
    f.host.audio.startBackground = async path => { music.push(path); return undefined; };
    await f.hud.loadHudMenu(); expect(music).toEqual([]);
    await f.hud.showResponseHead(); expect(music).toEqual(["music/voice.wav"]);
  });
  test("source empty CG_RunMenuScript leaves the outer parser to advance unknown commands", async () => {
    const assets = new MemoryAssets(); assets.text("ui/hud.txt", 'loadmenu { "ui/test.menu" }');
    assets.text("ui/test.menu", 'menuDef { name "voiceMenu" visible 0 rect 0 0 100 100 '
      + 'onOpen { uiScript ignored; unknown words; setcvar after yes; } }');
    const f = await fixture(assets); await f.hud.loadHudMenu(); await f.hud.showResponseHead();
    expect(f.cvars.get("after")?.value).toBe("yes"); expect(f.calls).toEqual([]);
  });
  test("cgame has no executeText display callback and does not invent successful exec scripts", async () => {
    const assets = new MemoryAssets(); assets.text("ui/hud.txt", 'loadmenu { "ui/test.menu" }');
    assets.text("ui/test.menu", 'menuDef { name "voiceMenu" visible 0 rect 0 0 100 100 onOpen { exec "echo forbidden"; } }');
    const f = await fixture(assets); await f.hud.loadHudMenu();
    await expect(f.hud.showResponseHead()).rejects.toThrow("cgame");
    expect(f.calls).toEqual([]); expect(f.state.voiceTime).toBe(0);
  });
  test("missing menu files use actual testhud fallback, while missing HUD set is fatal", async () => {
    const assets = new MemoryAssets(); assets.text("ui/hud.txt", 'loadmenu { "ui/missing.menu" }');
    assets.text("ui/testhud.menu", 'menuDef { name "fallback" visible 1 rect 0 0 100 100 }');
    const f = await fixture(assets); await f.hud.loadHudMenu(); expect(f.hud.menuState()?.menus[0]?.name).toBe("fallback");
    const missing = new MemoryAssets(); missing.text("ui/hud.txt", 'loadmenu { "ui/missing.menu" }');
    const absent = await fixture(missing); await absent.hud.loadHudMenu(); expect(absent.hud.menuState()?.menus).toEqual([]);
    const noSet = await fixture(); await expect(noSet.hud.loadHudMenu()).rejects.toThrow("menu file not found");
    missing.text("ui/oversize.txt", " ".repeat(4096)); await expect(absent.hud.loadMenus("ui/oversize.txt")).rejects.toThrow("menu file too large");
  });
  test("mouse capture moves the source first containing menu by deltas and any next key releases it", async () => {
    const assets = new MemoryAssets(); assets.text("ui/hud.txt", 'loadmenu { "ui/test.menu" }');
    assets.text("ui/test.menu", 'menuDef { name "drag" visible 1 rect 10 10 100 100 itemDef { name "child" visible 1 rect 5 5 20 20 decoration } }');
    const f = await fixture(assets); await f.hud.loadHudMenu(); f.state.predictedPlayerState.pmType = MoveType.PM_DEAD;
    await f.hud.mouseEvent(20, 20); await f.hud.keyEvent(179, true); await f.hud.mouseEvent(7, -4);
    expect(f.hud.menuState()?.menus[0]?.rect).toEqual({ x: 17, y: 6, width: 100, height: 100 });
    expect(f.hud.menuState()?.menus[0]?.items[0]?.rect.x).toBe(22);
    await f.hud.keyEvent(32, true); await f.hud.mouseEvent(5, 5);
    expect(f.hud.menuState()?.menus[0]?.rect.x).toBe(17);
    await f.hud.mouseEvent(1000, -1000); expect(f.cgs.cursorX).toBe(640); expect(f.cgs.cursorY).toBe(0);
  });
  test("vmMain copies the prior cgs cursor before mouse movement, while key dispatch keeps that cgDC position", async () => {
    const assets = new MemoryAssets(); assets.text("ui/hud.txt", 'loadmenu { "ui/test.menu" }');
    assets.text("ui/test.menu", 'menuDef { name "controls" visible 1 rect 0 0 640 480 '
      + 'itemDef { name "toggle" type 11 visible 1 rect 10 10 100 20 cvar toggle } }');
    const f = await fixture(assets); await f.hud.loadHudMenu(); f.cvars.set("toggle", "0");
    f.state.predictedPlayerState.pmType = MoveType.PM_DEAD;
    await f.hud.mouseEvent(20, 20); await f.hud.keyEvent(178, true);
    expect(f.cgs.cursorX).toBe(20); expect(f.cgs.cursorY).toBe(20);
    expect(f.cvars.get("toggle")?.value).toBe("0");
    await f.hud.mouseEvent(0, 0); await f.hud.keyEvent(178, true);
    expect(f.cvars.get("toggle")?.value).toBe("1");
    await f.hud.keyEvent(178, false); expect(f.cvars.get("toggle")?.value).toBe("1");
  });
  test("Menu_Reset and String_Init retain the captured static menu slot across reload", async () => {
    for (const reset of ["menus", "strings"]) {
      const assets = new MemoryAssets(); assets.text("ui/hud.txt", 'loadmenu { "ui/test.menu" }');
      assets.text("ui/test.menu", 'menuDef { name "old" visible 1 rect 10 10 100 100 }');
      const f = await fixture(assets); await f.hud.loadHudMenu(); f.state.predictedPlayerState.pmType = MoveType.PM_DEAD;
      await f.hud.mouseEvent(20, 20); await f.hud.keyEvent(179, true);
      if (reset === "menus") f.hud.resetMenus(); else f.hud.resetStrings();
      expect(f.hud.menuState()?.menus).toEqual([]);
      assets.text("ui/test.menu", 'menuDef { name "replacement" visible 1 rect 40 50 80 90 }');
      await f.hud.loadMenus("ui/hud.txt"); await f.hud.mouseEvent(7, -4);
      expect(f.hud.menuState()?.menus[0]?.name).toBe("replacement");
      expect(f.hud.menuState()?.menus[0]?.rect).toEqual({ x: 47, y: 46, width: 80, height: 90 });
      f.hud.dispose();
    }
  });
  test("direct CG_LoadMenus file errors occur before Menu_Reset", async () => {
    const assets = new MemoryAssets(); assets.text("ui/hud.txt", 'loadmenu { "ui/test.menu" }');
    assets.text("ui/test.menu", 'menuDef { name "retained" visible 1 rect 0 0 100 100 }');
    const f = await fixture(assets); await f.hud.loadHudMenu();
    assets.text("ui/oversize.txt", " ".repeat(4096));
    await expect(f.hud.loadMenus("ui/oversize.txt")).rejects.toThrow("menu file too large");
    expect(f.hud.menuState()?.menus[0]?.name).toBe("retained");
    await expect(f.hud.loadMenus("ui/missing.txt")).rejects.toThrow("menu file not found");
    expect(f.hud.menuState()?.menus[0]?.name).toBe("retained");
  });
  test("the cached scoreboard pointer survives Menu_Reset and observes replacement of its static slot", async () => {
    const assets = new MemoryAssets(); assets.text("ui/hud.txt", 'loadmenu { "ui/test.menu" }');
    assets.text("ui/test.menu", 'menuDef { name "score_menu" visible 0 rect 0 0 100 100 }');
    const f = await fixture(assets); await f.hud.loadHudMenu(); f.state.showScores = true;
    await f.hud.drawScoreboard(); const held = f.hud.menuScoreboard();
    if (held === null) throw new Error("Source scoreboard was not found");
    f.hud.resetMenus(); expect(await f.hud.drawScoreboard()).toBe(true);
    expect(f.hud.menuState()?.menus).toEqual([]); expect(f.hud.menuScoreboard()).toBe(held);
    assets.text("ui/test.menu", 'menuDef { name "replacement" visible 0 rect 50 60 120 130 onOpen { setcvar unintended yes; } }');
    await f.hud.loadMenus("ui/hud.txt"); expect(f.hud.menuScoreboard()).toBe(held);
    expect(held.definition.window.name).toBe("replacement"); await f.hud.drawScoreboard();
    expect((f.hud.menuState()?.menus[0]?.flags ?? 0) & UiWindowFlag.Forced).toBe(UiWindowFlag.Forced);
    expect(f.cvars.get("unintended")).toBeUndefined();
    f.hud.clearScoreboard(); expect(f.hud.menuScoreboard()).toBeNull();
  });
  test("disposing during the first AssetCache await prevents all later registrations", async () => {
    const f = await fixture(), paths: (string | null)[] = [];
    const gate = Promise.withResolvers<void>();
    const original = f.resources.registerShaderNoMip;
    f.resources.registerShaderNoMip = async path => { paths.push(path); await gate.promise; return await original(path); };
    const loading = f.hud.assetCache(); f.hud.dispose(); gate.resolve();
    await expect(loading).rejects.toThrow("disposed");
    expect(paths).toEqual(["ui/assets/gradientbar2.tga"]);
  });
  test("native cgDC remains source-zero while cg.time advances, so shared menu fades do not advance", async () => {
    const assets = new MemoryAssets(); assets.text("scripts/clock.shader", "clock { { map *white } }");
    assets.text("ui/hud.txt", 'loadmenu { "ui/test.menu" }');
    assets.text("ui/test.menu", 'assetGlobalDef { fadeAmount .1 fadeCycle 1 fadeClamp 1 } '
      + 'menuDef { name "voiceMenu" visible 0 rect 0 0 100 100 onOpen { fadeout child; } '
      + 'itemDef { name "child" visible 1 rect 0 0 20 20 style 1 background "clock" backcolor 1 1 1 1 } }');
    const f = await fixture(assets); await f.hud.loadHudMenu(); f.state.time = 54321; f.state.frameTime = 16;
    await f.hud.showResponseHead(); await f.hud.paintAll();
    expect(f.hud.menuState()?.menus[0]?.items[0]?.backColor.w).toBe(1);
  });
});

const retailData = process.env["Q3_DATA"];
test.skipIf(retailData === undefined)("retail Team Arena HUD assets, fonts and forced scoreboard use real multi-stage CPU and GL pictures", async () => {
  if (retailData === undefined) throw new Error("Q3_DATA required");
  const assets = await VirtualFileSystem.openInspection({ dataPath: retailData, homePath: retailData, cdPath: null, product: "missionpack" });
  const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Mission HUD source scoreboard", width: 640, height: 480, backend: "gl", hidden: true }) : null;
  const f = await fixture(assets, window);
  try {
    f.renderCommands.addView({ viewport: { x: 0, y: 0, width: 640, height: 480 }, clear: { stencil: false, color: { x: 0, y: 0, z: 0, w: 1 }, depth: 1 }, operations: [{ kind: "draw", batches: [] }] });
    await f.hud.assetCache(); await f.hud.loadHudMenu();
    expect(f.media.graphics.whiteShader).not.toBeNull();
    expect(f.hud.cachedAssets().widgets.whiteShader).toBe(f.resources.picture(f.media.graphics.whiteShader));
    expect(f.hud.fonts.normal.glyphScale).toBeGreaterThan(0);
    expect(f.hud.menuState()?.menus.length).toBeGreaterThan(1);
    f.state.time = 1000; f.state.showScores = true; expect(await f.hud.drawScoreboard()).toBe(true);
    expect(f.hud.menuScoreboard()?.definition.window.name).toBe("score_menu");
    const cpu = f.cpu; f.renderCommands.submit();
    expect(cpu.pixels.filter((value, index) => index % 4 !== 3 && value > 20).length).toBeGreaterThan(1000);
    const gl = f.gl;
    if (gl === null) return;
      const pixels = gl.readPixels(); let maximum = 0, total = 0;
      for (let i = 0; i < pixels.length; i++) {
        const actual = pixels[i], expected = cpu.pixels[i];
        if (actual === undefined || expected === undefined) throw new Error("Missing framebuffer channel");
        const error = Math.abs(actual - expected); maximum = Math.max(maximum, error); total += error;
      }
      expect(maximum).toBeLessThanOrEqual(3); expect(total / pixels.length).toBeLessThan(0.1);
  } finally { f.hud.dispose(); }
}, 60000);
