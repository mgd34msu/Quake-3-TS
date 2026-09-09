import { HunkArena } from "../src/core/hunk.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonParseState } from "../src/core/common-parse.ts";
import { KeyCode } from "../src/core/key-codes.ts";
import type { Vec4 } from "../src/core/math.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { ClientKeys, keynumToString } from "../src/engine/client-keys.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { ClientStaticState } from "../src/engine/client-state.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { EngineUiCinematics } from "../src/engine/ui-cinematics.ts";
import { ServerBrowser } from "../src/engine/server-browser.ts";
import { EngineSound } from "../src/engine/sound.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { ServerMessageContext, ServerOperation } from "../src/protocol/server-message.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { RendererConfiguration } from "../src/render/configuration.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { UiAssetRegistry, textPaint, textWidth } from "../src/render/font.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { RendererResources } from "../src/render/world.ts";
import type { WorldFrame } from "../src/render/world.ts";
import { PlayerState } from "../src/shared/player-state.ts";
import { loadMenuDefinitions } from "../src/ui/menu.ts";
import { UiRuntime } from "../src/ui/runtime.ts";
import type { UiOwnerDrawPaintRequest } from "../src/ui/runtime.ts";
import { TeamArenaCatalog } from "../src/ui/team-arena/catalog.ts";
import { TeamArenaUiCinematics } from "../src/ui/team-arena/cinematics.ts";
import { TeamArenaUiCvars } from "../src/ui/team-arena/cvars.ts";
import { infoSlot, TeamArenaGameInfo, TeamArenaMenuBuffer } from "../src/ui/team-arena/game-info.ts";
import { TeamArenaUiInteractionState } from "../src/ui/team-arena/interaction-state.ts";
import { TeamArenaLists } from "../src/ui/team-arena/lists.ts";
import { TeamArenaUiMemory } from "../src/ui/team-arena/memory.ts";
import { TeamArenaOwnerDraw } from "../src/ui/team-arena/owner-draw.ts";
import { TeamArenaPlayerList } from "../src/ui/team-arena/player-list.ts";
import { TeamArenaUiPlayers } from "../src/ui/team-arena/players.ts";
import { TeamArenaUiResources } from "../src/ui/team-arena/resources.ts";
import { TeamArenaSelection } from "../src/ui/team-arena/selection.ts";
import { TeamArenaServerBrowser } from "../src/ui/team-arena/server-browser.ts";
import { TeamArenaTeamInfo } from "../src/ui/team-arena/team-info.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";

async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "q3-owner-draw-")), printed: string[] = [], clock = new UnixSystemClock();
  const print = (text: string): undefined => { printed.push(text); };
  let active = true, time = 0, clientReads = 0, configurationReads = 0;
  const current = (): undefined => { if (!active) throw new Error("retired UI owner draw"); };
  const unexpected = (): never => { throw new Error("Owner-draw fixture reached unrelated UI callback"); };
  const common = await CommonConsole.open({ roots: { dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath,
    cdPath: null, product: "missionpack" }, startup: new StartupCommands("+set s_initsound 0"), random: new LinuxNativeRandom(1),
    build: { kind: "dedicated" }, platformPrint: print, resolveCommand: () => undefined, assertCommandEntry: current, assertOwnerEntry: current }, current);
  const events = new CommonEvents({ getEvent: () => ({ kind: "none", time }) }, print), sound = new EngineSound(common, events);
  const io = new UnixIo(print, clock, { signals: "none" }), images = new RendererImageCatalog();
  const registered = new RegisteredRendererCvars(common.cvars, "linux");
  const window = SdlWindow.open({ title: "Team Arena CPU widgets", width: 320, height: 240, backend: "cpu", hidden: true });
  const cpu = new SoftwareRenderer(320, 240, images), recording = new BatchRecordingBackend(cpu), target = new RenderTarget(images, [recording]);
  const settings = new SourceRendererSettings(registered, cpu.capabilities);
  const configuration = RendererConfiguration.create({ window, renderer: { kind: "cpu", backend: cpu }, settings });
  const retainedConfiguration = configuration.copy();
  const builtins = new BuiltinImages(images, identityImageUploadProfile), files = common.files.current;
  const movies = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: text => { const developer = common.cvars.get("developer"); if (developer !== undefined && developer.integerValue !== 0) common.output.print(text); return undefined; }, print: text => { common.output.print(text); return undefined; }, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => sound.mixer }, clock: { sample: () => time }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { hardware: "generic", maxTextureSize: 4096, inGameVideo: () => 1 } });
  const renderer = await RendererResources.create(files, { kind: "unaccounted" }, settings, { patchMemory: { kind: "source-zone", zone: common.mainZone }, print, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: movies.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { common.output.print(text); }, clock, identityLight: 1, tess: renderer.tess, runtime: settings.runtime });
  const cvars = new TeamArenaUiCvars(common.cvars, current), cinematicInterface = new EngineUiCinematics(movies, "ui");
  const resources = new TeamArenaUiResources({ renderer, sound, cinematics: cinematicInterface,
    fontRegistry: new UiAssetRegistry(renderer, print), cvars, assertCurrentOperation: current });
  sound.initialize({ sampleRate: 48000 }); await sound.beginRegistration();
  await resources.initializeDisplayAssets(); await resources.assetCache();
  const memory = new TeamArenaUiMemory("qvm32", print), sourceParser = new CommonParseState();
  const info = { menuBuffer: new TeamArenaMenuBuffer(common.files, print, current), sourceParser, memory, resources: renderer, print, assertActive: current };
  const game = new TeamArenaGameInfo(info), teams = new TeamArenaTeamInfo(info);
  const selection = new TeamArenaSelection(game, teams, cvars, common.files, print, current);
  const lists = new TeamArenaLists({ files: common.files, cvars: common.cvars, memory, assertActive: current });
  const catalog = new TeamArenaCatalog({ files: common.files, cvars: common.cvars, gameInfo: game, sourceParser, memory, print, assertActive: current });
  const playerList = new TeamArenaPlayerList(common.cvars, current), interaction = new TeamArenaUiInteractionState();
  const players = new TeamArenaUiPlayers({ files: common.files, resources: renderer, sound, commands, sourceParser, random: new GameRandom(), print, assertActive: current });
  const lifecycle = new ProtocolClientLifecycle(common.cvars);
  const session = new EngineClientSession({ product: "missionpack", cvars: common.cvars, lifecycle, mode: { kind: "network", challenge: 1, qport: 27961 } });
  const keys = new ClientKeys({ commands: common.commands, cvars: common.cvars, print, host: {
    assertCurrentOperation: current, readConnection: () => ({ kind: "disconnected", demoPlayback: false }), readUi: () => null, readCgame: () => null,
    disconnect: unexpected, stopAllSounds: () => { sound.stopAllSounds(); }, addReliableCommand: unexpected, toggleConsole: unexpected,
    updateScreen: unexpected, consoleScroll: unexpected, readConsoleWidth: () => 78, clipboard: { kind: "native-unix-unavailable" } } });
  const menu = `assetGlobalDef { font "fonts/font" 16 smallFont "fonts/font" 16 bigFont "fonts/font" 16 }
    menuDef { name widgets rect 0 0 640 480
      itemDef { name label ownerdraw 203 rect 30 45 200 24 textscale .3 forecolor 1 1 1 1 visible 1 }
      itemDef { name effect ownerdraw 201 rect 30 100 128 20 visible 1 }
      itemDef { name crosshair ownerdraw 242 rect 200 140 24 24 forecolor 1 1 1 1 visible 1 }
      itemDef { name attack type 13 rect 20 170 150 24 textscale .3 cvar "+attack" visible 1 } }`;
  const definitions = await loadMenuDefinitions({ random: { nextInt: () => 0 }, resolver: {
    resolveRoot: path => ({ path, text: path === "set" ? 'loadMenu { "menu" }' : menu }), resolve: unexpected,
  } }, { kind: "ui", setPaths: ["set"] }, {}, { registrationSink: resources, assetSink: resources, memory: { kind: "qvm32", memory } });
  let owner: TeamArenaOwnerDraw | undefined;
  let cinematicAdapter: TeamArenaUiCinematics | undefined;
  const owned = (): TeamArenaOwnerDraw => { if (owner === undefined) throw new Error("Owner draw requested before composition"); return owner; };
  const runtime = await UiRuntime.create({ definitions, cvars: common.cvars, commands: common.commands, resources, fonts: resources.fonts,
    widgetAssets: resources.widgetAssets, zeroPicture: renderer.picture(null), cinematics: cinematicInterface,
    context: { kind: "ui", bindings: { keyName: keynumToString, getBinding: key => keys.getBinding(key) ?? "", setBinding: (key, value) => keys.setBinding(key, value),
      getOverstrike: () => keys.getOverstrike(), setOverstrike: value => keys.setOverstrike(value) }, pause: unexpected },
    audio: { playLocal: handle => {
      if (!sound.started || sound.muted) return;
      const pcm = typeof handle === "number" ? sound.bank.soundForIndex(handle) : handle;
      if (typeof handle === "number" && pcm === undefined) return;
      sound.startLocalSound(pcm ?? null, 6);
    }, startBackground: unexpected, stopBackground: unexpected },
    paintModel: unexpected, getTeamColor: unexpected, externalScript: { run: unexpected },
    feeder: { count: unexpected, item: unexpected, image: unexpected, select: unexpected },
    ownerDraw: { visible: unexpected, width: (id, scale) => owned().width(id, scale), value: id => owned().value(id), handleKey: unexpected,
      paint: request => owned().paint(request), closeCinematic: id => {
        if (cinematicAdapter === undefined) throw new Error("Cinematic hook requested before composition");
        cinematicAdapter.stop(id);
      } } });
  const browser = new ServerBrowser({ io, cvars: common.cvars, clientStatic: new ClientStaticState(), loopback: new LoopbackTransport(), print, assertCurrentOperation: current });
  const servers = new TeamArenaServerBrowser({ browser, cvars, gameInfo: game, runtime, commands: common.commands, calendar: clock, print, assertActive: current });
  const cinematics = new TeamArenaUiCinematics({ cinematics: cinematicInterface, game, teams, selection, cvars, servers, assertActive: current });
  cinematicAdapter = cinematics;
  owner = new TeamArenaOwnerDraw({ cvars, renderer, resources, game, teams, catalog, selection, lists, playerList, players, browser, servers, cinematics,
    interaction, runtime, readRendererConfiguration: () => { configurationReads++; return retainedConfiguration; },
    readClient: () => { clientReads++; return session; }, readRealTime: () => time, readFrameTime: () => 16, assertActive: current });
  const draw = commands.draw2D("team-ui-640"), calls: Parameters<typeof draw.stretchPic>[] = [], colors: (Vec4 | null)[] = [];
  const stretch = draw.stretchPic.bind(draw), setColor = draw.setColor.bind(draw);
  draw.stretchPic = (...args) => { calls.push(args); stretch(...args); };
  draw.setColor = color => { colors.push(color); setColor(color); };
  const request = (ownerDraw: number): UiOwnerDrawPaintRequest => ({ draw, rect: { x: 20, y: 60, width: 240, height: 80 }, textX: 0, textY: 0,
    ownerDraw, ownerDrawFlags: 0, alignment: 0, special: 0, textScale: .3, color: { x: 1, y: 1, z: 1, w: 1 }, background: undefined, textStyle: 0 });
  const compareText = async (id: number, expected: string): Promise<void> => {
    calls.length = 0; await owned().paint(request(id)); const actual = calls.slice(); calls.length = 0;
    textPaint(draw, resources.fonts, { x: 20, y: 60, scale: .3, color: { x: 1, y: 1, z: 1, w: 1 }, text: expected, adjust: 0, limit: 0, style: 0 });
    expect(actual).toEqual(calls); expect(actual.length).toBeGreaterThan(0);
  };
  let messageNumber = 0;
  const send = async (operations: readonly ServerOperation[]): Promise<void> => {
    const context: ServerMessageContext = { product: "missionpack", messageNumber: ++messageNumber, reliableSequence: 0,
      serverCommandSequence: 0, parseEntitiesNumber: 0, baseline: () => null, history: () => null };
    await session.receiveServerMessage(messageNumber, encodeServerMessage(0, operations, context));
  };
  const loadPlayer = async (): Promise<void> => {
    await send([{ kind: "gamestate", commandSequence: 0, clientNumber: 7, checksumFeed: 0, entries: [
      { kind: "configstring", index: 0, value: "\\sv_maxclients\\1" },
      { kind: "configstring", index: 1, value: "\\sv_serverid\\1\\sv_cheats\\1\\fs_game\\missionpack" },
      { kind: "configstring", index: 544, value: "\\n\\Self\\t\\1\\tl\\1" },
    ] }]);
    const playerState = new PlayerState("missionpack"); playerState.clientNum = 0;
    await send([{ kind: "snapshot", validity: { kind: "valid" }, snapshot: { messageNumber: messageNumber + 1, serverTime: 100,
      deltaNumber: -1, flags: 0, serverCommandNumber: 0, parseEntitiesNumber: 0, areaMask: new Uint8Array(), playerState, entities: [] } }]);
  };
  return { common, cvars, game, teams, catalog, lists, interaction, resources, renderer, commands, cpu, recording, movies,
    owner, runtime, keys, servers, players, playerList, calls, colors, printed, request, compareText, loadPlayer, configuration, retainedConfiguration,
    clientReads: () => clientReads, configurationReads: () => configurationReads, time: (value: number) => { time = value; },
    retire: () => { active = false; },
    retail: async () => { await game.parseGameInfo("gameinfo.txt"); await teams.parseTeamInfo("teaminfo.txt"); catalog.loadBots(); },
    close: async () => { active = true;
      try { runtime.dispose(); } finally {
        resources.dispose(); commands.close("discard"); configuration.close(); target.close(); window.close();
        movies.dispose(); lifecycle.close(); sound.close(); common.close(); io.close(); await rm(homePath, { recursive: true, force: true });
      }
    } };
}

test("all seven lazy team logo owner draws register sentinel icons at the reached use", async () => {
  const p = await fixture();
  try {
    const team = infoSlot(p.teams.teamList, 0);
    p.teams.teamCount = 1; team.teamName = "Lazy"; team.imageName = "ui/assets/pagans";
    p.common.cvars.set("ui_teamName", "Lazy"); p.common.cvars.set("ui_opponentName", "Lazy");
    const register = p.renderer.registerShaderNoMip.bind(p.renderer), registrations: (string | null)[] = [];
    p.renderer.registerShaderNoMip = async path => { registrations.push(path); return register(path); };
    for (const id of [204, 228, 229, 230, 231, 232, 233]) {
      team.teamIcon = -1; registrations.length = 0; p.calls.length = 0;
      await p.owner.paint(p.request(id));
      expect(registrations).toEqual(["ui/assets/pagans", "ui/assets/pagans_metal", "ui/assets/pagans_name"]);
      expect(p.calls).toHaveLength(1);
      expect(team.teamIcon).not.toBe(-1);
      await p.owner.paint(p.request(id));
      expect(registrations).toHaveLength(3);
    }
  } finally { await p.close(); }
});

test("retail Team Arena owner widgets paint through actual UiRuntime, fonts, queue and CPU", async () => {
  const p = await fixture();
  try {
    await p.retail();
    expect(p.game.mapCount).toBeGreaterThan(0); expect(p.teams.teamCount).toBeGreaterThan(0); expect(p.catalog.getNumBots()).toBeGreaterThan(0);
    await p.runtime.activate("widgets"); await p.runtime.frame({ time: 0, frameTime: 16, draw: p.request(0).draw });
    expect(p.commands.submit().batches).toBeGreaterThan(0);
    expect(p.cpu.pixels.some((value, index) => index % 4 !== 3 && value !== 0)).toBe(true);
    await p.compareText(203, "Pagans"); p.common.cvars.set("handicap", "97"); await p.compareText(200, "95");
    p.common.cvars.set("g_spSkill", "99"); await p.compareText(207, "I Can Win");
    p.common.cvars.set("ui_blueTeam", "Stroggs"); await p.compareText(208, "Blue: Stroggs");
    p.common.cvars.set("ui_blueteam1", "2"); p.cvars.writeInteger("ui_actualNetGameType", 3);
    const character = infoSlot(p.teams.characterList, 0).name; if (character === null) throw new Error("Missing retail character");
    await p.compareText(210, character);
    const alias = infoSlot(p.teams.aliasList, 0).name;
    expect(p.owner.width(210, .3)).toBe(textWidth(p.resources.fonts, `1. ${alias ?? "(null)"}`, .3));
    expect(p.owner.width(223, .3)).toBe(0); expect(p.owner.value(244)).toBe(0);
    p.calls.length = 0; await p.owner.paint({ ...p.request(201), textX: 3.25, textY: -2 });
    expect(p.calls.map(call => call[0])).toEqual([{ x: 23.25, y: 44, width: 128, height: 8 }, { x: 31.25, y: 42, width: 16, height: 12 }]);
    p.interaction.currentCrosshair = 10; p.calls.length = 0; await p.owner.paint(p.request(242));
    expect(p.interaction.currentCrosshair).toBe(0); expect(p.calls[0]?.[2]).toBe(p.resources.assets.crosshairShader[0]);
    expect(p.calls[0]?.[0]).toEqual({ x: 20, y: -20, width: 240, height: 80 });
    const pagans = p.teams.teamList.find(row => row.teamName === "Pagans"); if (pagans === undefined) throw new Error("Missing retail Pagans row");
    p.calls.length = 0; await p.owner.paint(p.request(204));
    const icon = pagans.teamIcon;
    if (icon === -1) throw new Error("Clan logo remained unregistered after paint");
    expect(p.calls[0]?.[2]).toEqual(p.renderer.picture(icon));
  } finally { await p.close(); }
});

test("source stale VM corrections, width-only alias/net-source behavior and retained tier slots", async () => {
  const p = await fixture();
  try {
    p.game.numGameTypes = 1; infoSlot(p.game.gameTypes, 0).gameType = "Zero"; infoSlot(p.game.gameTypes, 2).gameType = "Retained";
    p.cvars.writeInteger("ui_netGameType", 2); await p.compareText(245, "Retained");
    expect(p.common.cvars.get("ui_netGameType")?.value).toBe("0"); expect(p.common.cvars.get("ui_actualNetGameType")?.value).toBe("0");
    expect(p.cvars.get("ui_netGameType").integerValue).toBe(2);
    p.cvars.writeInteger("ui_netGameType", -1); await expect(p.owner.paint(p.request(245))).rejects.toThrow("source 16-entry array");
    p.game.numJoinGameTypes = 1; p.cvars.writeInteger("ui_netSource", 2);
    await p.compareText(220, "Source: Internet"); expect(p.cvars.get("ui_netSource").integerValue).toBe(2);
    expect(p.owner.width(220, .3)).toBe(textWidth(p.resources.fonts, "Source: Local", .3)); expect(p.cvars.get("ui_netSource").integerValue).toBe(0);
    p.cvars.writeInteger("ui_netSource", 4); await expect(p.owner.paint(p.request(220))).rejects.toThrow("source 4-entry array");
    p.servers.serverFilterType = 8; await p.compareText(222, "Filter: All"); expect(p.servers.serverFilterType).toBe(0);
    p.servers.serverFilterType = 7; expect(() => p.owner.width(222, .3)).toThrow("source 7-entry array");
    expect(p.owner.tierCount).toBe(0); await p.compareText(223, "Tier: (null)");
    p.calls.length = 0; await p.owner.paint(p.request(225)); expect(p.calls).toHaveLength(1); expect(p.calls[0]?.[2]).toEqual(p.renderer.picture(null));
    await p.compareText(235, "Zero"); p.calls.length = 0; await p.owner.paint(p.request(234)); expect(p.calls).toHaveLength(0);
    p.common.cvars.set("ui_currentMap", "3"); await expect(p.owner.paint(p.request(234))).rejects.toThrow("source 3-entry array");
    p.calls.length = 0; await p.owner.paint(p.request(238)); expect(p.calls).toHaveLength(0);
    p.game.mapCount = 128; p.cvars.writeInteger("ui_currentNetMap", 128); p.servers.currentServerCinematic = -1;
    // Net cinematic only checks the map bound, never indexes mapList on this path.
    await p.owner.paint(p.request(246));
    await expect(p.owner.paint(p.request(206))).rejects.toThrow("source 128-entry array");
  } finally { await p.close(); }
});

test("map/clan/preview cinematic failure timing, retail engine handles and guarded registration", async () => {
  const p = await fixture();
  try {
    await p.retail(); const row = infoSlot(p.game.mapList, 0);
    p.cvars.writeInteger("ui_currentMap", 0); p.cvars.writeInteger("ui_currentNetMap", 0);
    row.mapLoadName = "missing-owner-preview"; row.cinematic = -1; row.levelShot = { kind: "unregistered" }; row.imageName = "levelshots/mpteam1";
    p.calls.length = 0; await p.owner.paint(p.request(244)); expect(row.cinematic).toBe(-2); expect(p.calls).toHaveLength(0);
    await p.owner.paint(p.request(244)); expect(p.calls).toHaveLength(1); expect(infoSlot(p.game.mapList, 0).levelShot.kind).toBe("registered");
    const team = infoSlot(p.teams.teamList, 0); p.common.cvars.set("ui_teamName", team.teamName ?? ""); team.cinematic = -1; team.imageName = "missing-owner-clan";
    p.calls.length = 0; await p.owner.paint(p.request(251)); expect(team.cinematic).toBe(-2);
    expect(p.calls[0]?.[2]).toEqual(p.renderer.picture(team.teamIconMetal));
    p.calls.length = 0; await p.owner.paint(p.request(251)); expect(p.calls[0]?.[2]).toEqual(p.renderer.picture(team.teamIconMetal));
    p.lists.loadMovies(); p.interaction.movieIndex = p.lists.movieList.findIndex(name => name?.toLowerCase() === "idlogo");
    expect(p.interaction.movieIndex).toBeGreaterThanOrEqual(0); p.interaction.previewMovie = 0;
    await p.owner.paint(p.request(254)); const handle = p.interaction.previewMovie; expect(handle).toBeGreaterThanOrEqual(0);
    p.time(34); await p.owner.paint(p.request(254)); expect(p.interaction.previewMovie).toBe(handle);
    p.commands.submit();
    // Raw cinematic drawing has already submitted preceding queued pictures.
    expect(p.recording.trace().flatMap(view => view.batches).length).toBeGreaterThan(0); expect(p.recording.rawDraws.length).toBeGreaterThan(0);
    row.levelShot = { kind: "unregistered" }; const register = p.renderer.registerShaderNoMip.bind(p.renderer);
    p.renderer.registerShaderNoMip = async path => { const result = await register(path); p.retire(); return result; };
    await expect(p.owner.paint(p.request(206))).rejects.toThrow("retired"); expect(row.levelShot).toEqual({ kind: "unregistered" });
  } finally { await p.close(); }
});

test("actual player preview objects retain independently, switch Q3 mode and guard awaited owners", async () => {
  const p = await fixture();
  try {
    const scenes: WorldFrame[] = [], render = p.renderer.renderScene.bind(p.renderer), registrations: (string | null)[] = [];
    p.renderer.renderScene = refdef => { scenes.push({ refdef }); return render(refdef); };
    const register = p.renderer.registerModel.bind(p.renderer);
    p.renderer.registerModel = path => { registrations.push(path); return register(path); };
    p.common.cvars.set("ui_Q3Model", "1"); p.common.cvars.set("model", "sarge"); p.common.cvars.set("headmodel", "visor");
    p.common.cvars.set("ui_opponentModel", "james"); p.time(1001);
    const request = { ...p.request(202), rect: { x: 0, y: 0, width: 320, height: 480 } };
    await p.owner.paint(request); const model = p.owner.playerInfo.legsModel, cells = p.owner.playerInfo.legs;
    expect(model.path).toBe("models/players/sarge/lower.md3"); expect(p.owner.playerInfo.headModel.path).toBe("models/players/visor/head.md3");
    expect(scenes[0]?.refdef.time).toBe(500); expect(p.interaction.updateModel).toBe(false); expect(scenes).toHaveLength(1);
    const count = registrations.length; await p.owner.paint(request); expect(registrations).toHaveLength(count);
    await p.owner.paint({ ...request, ownerDraw: 224 }); expect(p.owner.opponentInfo.legsModel.path).toBe("models/players/james/lower.md3");
    expect(p.owner.playerInfo.legsModel).toBe(model); expect(p.owner.opponentInfo).not.toBe(p.owner.playerInfo); expect(p.interaction.updateOpponentModel).toBe(false);
    p.common.cvars.set("ui_Q3Model", "0"); p.common.cvars.set("team_model", "james/red"); p.common.cvars.set("team_headmodel", "*janet/blue");
    p.common.cvars.set("ui_teamName", "Pagans"); await p.owner.paint(request);
    expect(p.owner.playerInfo.legs).toBe(cells); expect(p.owner.playerInfo.legsSkin?.path).toBe("models/players/james/pagans/lower_red.skin");
    expect(p.commands.submit().batches).toBeGreaterThan(0);
    p.common.cvars.set("team_model", "x".repeat(64)); await expect(p.owner.paint(request)).rejects.toThrow("strcpy");
    p.common.cvars.set("team_model", "james"); p.interaction.updateModel = true;
    const setModel = p.players.setModel.bind(p.players);
    p.players.setModel = async (...args) => { await setModel(...args); p.retire(); };
    await expect(p.owner.paint(request)).rejects.toThrow("retired"); expect(p.interaction.updateModel).toBe(true);
  } finally { await p.close(); }
});

test("MOTD source scrolling, strict player refresh, binding state and retained CPU configuration", async () => {
  const p = await fixture();
  try {
    await p.loadPlayer(); p.common.cvars.set("cg_selectedPlayer", "0"); p.time(0);
    await p.owner.paint(p.request(243)); expect(p.clientReads()).toBe(0);
    p.time(1); await p.compareText(243, "Self"); expect(p.clientReads()).toBe(1); expect(p.interaction.playerRefresh).toBe(3001);
    p.time(3001); await p.owner.paint(p.request(243)); expect(p.clientReads()).toBe(1);
    p.time(3002); await p.owner.paint(p.request(243)); expect(p.clientReads()).toBe(2);
    await p.runtime.activate("widgets"); p.runtime.setDisplayCursor(25, 180); await p.runtime.pointerMove(25, 180);
    await p.runtime.handleKey({ kind: "key", code: KeyCode.Enter, down: true }, 25, 180);
    expect(p.runtime.bindingPending()).toBe(true);
    await p.compareText(250, "Waiting for new key... Press ESCAPE to cancel");
    expect(p.owner.width(250, .3)).toBe(textWidth(p.resources.fonts, "Waiting for new key... Press ESCAPE to cancel", .3));
    await p.runtime.handleKey({ kind: "key", code: KeyCode.Escape, down: true }, 25, 180);
    expect(p.runtime.bindingPending()).toBe(false);
    const s = p.servers; s.motd = "AB"; s.motdLen = 2; s.motdWidth = -1; p.time(0);
    await p.owner.paint(p.request(248)); expect(s.motdPaintX).toBe(21); expect(s.motdOffset).toBe(0);
    p.time(1); await p.owner.paint(p.request(248));
    expect(s.motdOffset).toBe(1); expect(s.motdTime).toBe(11); expect(s.motdPaintX).toBe(20 + textWidth(p.resources.fonts, "AB", .3, 1));
    expect(s.motdPaintX2).toBe(258);
    const x = s.motdPaintX; p.time(11); await p.owner.paint(p.request(248)); expect(s.motdPaintX).toBe(x);
    s.motdOffset = 99; await p.owner.paint(p.request(248)); expect(s.motdOffset).toBe(0); expect(s.motdPaintX).toBe(21);
    const font = p.resources.fonts.big, glyph = infoSlot(font.glyphs, 65);
    const largeScale = Math.fround(16777218 / (glyph.xSkip * font.glyphScale));
    expect(textWidth(p.resources.fonts, "A", largeScale, 1)).toBe(16777218);
    s.motd = "A"; s.motdLen = 1; s.motdWidth = -1; s.motdOffset = 0; s.motdTime = 0; p.time(1);
    await p.owner.paint({ ...p.request(248), rect: { ...p.request(248).rect, x: 0 }, textScale: largeScale });
    // Source converts the int width-minus-one operand to float before adding paintX=1.
    expect(s.motdPaintX).toBe(16777216); expect(s.motdOffset).toBe(1);
    p.common.cvars.set("ui_lastServerRefresh_0", "Yesterday"); await p.compareText(247, "Refresh Time: Yesterday");
    expect(p.owner.width(247, .3)).toBe(textWidth(p.resources.fonts, "Yesterday", .3));
    s.refreshActive = true; p.time(74); p.colors.length = 0; await p.owner.paint(p.request(247));
    const low = Math.fround(Math.fround(.8) - 1), expected = Math.fround(1 + Math.fround(.5 * low));
    expect(p.colors[0]).toEqual({ x: expected, y: expected, z: expected, w: expected });
    // The copied configuration remains valid after the actual configuration owner closes.
    p.configuration.close(); p.calls.length = 0; await p.owner.paint(p.request(249));
    expect(p.configurationReads()).toBe(1); expect(p.retainedConfiguration.backend).toBe("cpu"); expect(p.calls.length).toBeGreaterThan(0);
    expect(p.commands.submit().batches).toBeGreaterThan(0);
  } finally { await p.close(); }
});
