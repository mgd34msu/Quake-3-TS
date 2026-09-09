import { HunkArena } from "../src/core/hunk.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonParseState } from "../src/core/common-parse.ts";
import { KeyCode } from "../src/core/key-codes.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { ClientKeys, keynumToString } from "../src/engine/client-keys.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { ClientStaticState } from "../src/engine/client-state.ts";
import { CinematicStatus, EngineCinematics } from "../src/engine/cinematics.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { ServerBrowser } from "../src/engine/server-browser.ts";
import { EngineSound } from "../src/engine/sound.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { EngineUiCinematics } from "../src/engine/ui-cinematics.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { ServerMessageContext, ServerOperation } from "../src/protocol/server-message.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RenderTarget } from "../src/render/commands.ts";
import { UiAssetRegistry } from "../src/render/font.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RendererResources } from "../src/render/world.ts";
import { PlayerState } from "../src/shared/player-state.ts";
import { loadMenuDefinitions } from "../src/ui/menu.ts";
import { UiRuntime } from "../src/ui/runtime.ts";
import type { UiOwnerDrawKeyResult } from "../src/ui/runtime.ts";
import { TeamArenaCatalog } from "../src/ui/team-arena/catalog.ts";
import { TeamArenaUiCinematics } from "../src/ui/team-arena/cinematics.ts";
import { TeamArenaUiCvars } from "../src/ui/team-arena/cvars.ts";
import { TeamArenaFeeders } from "../src/ui/team-arena/feeders.ts";
import { infoSlot, TeamArenaGameInfo, TeamArenaMenuBuffer } from "../src/ui/team-arena/game-info.ts";
import { TeamArenaUiInteractionState } from "../src/ui/team-arena/interaction-state.ts";
import { TeamArenaLists } from "../src/ui/team-arena/lists.ts";
import { TeamArenaUiMemory } from "../src/ui/team-arena/memory.ts";
import { TeamArenaModels } from "../src/ui/team-arena/models.ts";
import { TeamArenaOwnerKeys } from "../src/ui/team-arena/owner-keys.ts";
import { TeamArenaPlayerList } from "../src/ui/team-arena/player-list.ts";
import { TeamArenaUiResources } from "../src/ui/team-arena/resources.ts";
import { TeamArenaScores } from "../src/ui/team-arena/scores.ts";
import { TeamArenaSelection } from "../src/ui/team-arena/selection.ts";
import { TeamArenaServerBrowser } from "../src/ui/team-arena/server-browser.ts";
import { TeamArenaServerStatus } from "../src/ui/team-arena/server-status.ts";
import { TeamArenaSettings } from "../src/ui/team-arena/settings.ts";
import { TeamArenaTeamInfo } from "../src/ui/team-arena/team-info.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";
import { deferred } from "./base-ui-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "q3-team-owner-keys-")), printed: string[] = [], clock = new UnixSystemClock();
  const print = (text: string): undefined => { printed.push(text); };
  let active = true, closing = false, commonOpen = true, time = 100;
  const current = (): undefined => { if (!active && !closing) throw new Error("retired Team Arena owner-key"); };
  const commonCurrent = (): undefined => { if (!commonOpen) throw new Error("closed common fixture"); };
  const unexpected = (): never => { throw new Error("Owner-key fixture reached unrelated drawing/gameplay"); };
  const common = await CommonConsole.open({ roots: { dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a",
    homePath, cdPath: null, product: "missionpack" }, startup: new StartupCommands("+set s_initsound 0"),
    random: new LinuxNativeRandom(1), build: { kind: "dedicated" }, platformPrint: print, resolveCommand: () => undefined,
    assertCommandEntry: commonCurrent, assertOwnerEntry: commonCurrent }, commonCurrent);
  const io = new UnixIo(print, clock, { signals: "none" }), events = new CommonEvents({ getEvent: () => ({ kind: "none", time }) }, print);
  const sound = new EngineSound(common, events), images = new RendererImageCatalog(), builtins = new BuiltinImages(images, identityImageUploadProfile);
  const movies = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: text => { const developer = common.cvars.get("developer"); if (developer !== undefined && developer.integerValue !== 0) common.output.print(text); return undefined; }, print: text => { common.output.print(text); return undefined; }, files: { kind: "diagnostic-bytes", reader: common.files.current }, sound: { kind: "diagnostic", readMixer: () => sound.mixer }, clock: { sample: () => time },
    scratchImages: builtins, console: { kind: "absent" }, settings: { hardware: "generic", maxTextureSize: 4096, inGameVideo: () => 1 } });
  const lifecycle = new ProtocolClientLifecycle(common.cvars);
  let runtime: UiRuntime | undefined, assets: TeamArenaUiResources | undefined;
  let target: RenderTarget | null = null;
  const close = async (): Promise<void> => {
    // The rejected operation has settled before this separate teardown operation.
    closing = true;
    try {
      runtime?.dispose(); assets?.dispose(); movies.dispose(); lifecycle.close(); sound.close(); common.close(); commonOpen = false; io.close();
      await rm(homePath, { recursive: true, force: true });
    } finally { target?.close(); }
  };
  try {
    target = new RenderTarget(images, [new SoftwareRenderer(1, 1, images)]);
    const renderer = await RendererResources.create(common.files.current, { kind: "unaccounted" }, createRendererSettings(),
      { patchMemory: { kind: "source-zone", zone: common.mainZone }, print, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: movies.shaderCinematics });
    const cvars = new TeamArenaUiCvars(common.cvars, current), cinematicInterface = new EngineUiCinematics(movies, "ui");
    assets = new TeamArenaUiResources({ renderer, sound, cinematics: cinematicInterface,
      fontRegistry: new UiAssetRegistry(renderer, print), cvars, assertCurrentOperation: current });
    const memory = new TeamArenaUiMemory("qvm32", print), parser = new CommonParseState();
    const info = { menuBuffer: new TeamArenaMenuBuffer(common.files, print, current), sourceParser: parser, memory,
      resources: renderer, print, assertActive: current };
    const game = new TeamArenaGameInfo(info), teams = new TeamArenaTeamInfo(info), interaction = new TeamArenaUiInteractionState();
    const selection = new TeamArenaSelection(game, teams, cvars, common.files, print, current);
    const scores = new TeamArenaScores({ files: common.files, cvars: common.cvars, print, assertActive: current });
    const players = new TeamArenaPlayerList(common.cvars, current), settings = new TeamArenaSettings(cvars, game, current);
    const catalog = new TeamArenaCatalog({ files: common.files, cvars: common.cvars, gameInfo: game, sourceParser: parser, memory, print, assertActive: current });
    const session = new EngineClientSession({ product: "missionpack", cvars: common.cvars, lifecycle, mode: { kind: "network", challenge: 1, qport: 27961 } });
    const keys = new ClientKeys({ commands: common.commands, cvars: common.cvars, print, host: {
      assertCurrentOperation: current, readConnection: () => ({ kind: "disconnected", demoPlayback: false }), readUi: () => null,
      readCgame: () => null, disconnect: unexpected, stopAllSounds: () => { sound.stopAllSounds(); }, addReliableCommand: unexpected,
      toggleConsole: unexpected, updateScreen: unexpected, consoleScroll: unexpected, readConsoleWidth: () => 78,
      clipboard: { kind: "native-unix-unavailable" } } });
    let feeders: TeamArenaFeeders | undefined, ownerKeys: TeamArenaOwnerKeys | undefined, cinematics: TeamArenaUiCinematics | undefined;
    const readFeeders = (): TeamArenaFeeders => { if (feeders === undefined) throw new Error("Feeder before composition"); return feeders; };
    const readKeys = (): TeamArenaOwnerKeys => { if (ownerKeys === undefined) throw new Error("Owner keys before composition"); return ownerKeys; };
    const readCinematics = (): TeamArenaUiCinematics => { if (cinematics === undefined) throw new Error("Cinematics before composition"); return cinematics; };
    const ids = [200, 201, 203, 205, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 222, 237, 239, 240, 241, 242, 243, 245, 253];
    const source = { path: "ui/owner-keys.menu", text: ids.map(id => `menuDef { name key${id} rect 0 0 640 480 onOpen { setFocus knob; }
      itemDef { name knob type 8 ownerdraw ${id} special 42.5 rect 20 20 180 40 visible 1 action { setcvar key_action yes; } }
      itemDef { name maps type 6 feeder 1 rect 300 20 100 100 }
      itemDef { name allmaps type 6 feeder 4 rect 300 130 100 100 }
      itemDef { name servers type 6 feeder 2 rect 300 240 100 100 } }`).join("\n") };
    const set = { path: "ui/owner-keys.txt", text: 'loadMenu { "ui/owner-keys.menu" }' };
    const resolve = (path: string) => path === source.path ? source : path === set.path ? set : undefined;
    const definitions = await loadMenuDefinitions({ random: { nextInt: () => 0 }, resolver: { resolveRoot: resolve, resolve: request => resolve(request.requestedPath) } },
      { kind: "ui", setPaths: [set.path] }, {}, { memory: { kind: "qvm32", memory } });
    const results: UiOwnerDrawKeyResult[] = [];
    runtime = await UiRuntime.create({ definitions, cvars: common.cvars, commands: common.commands, resources: assets,
      fonts: assets.fonts, widgetAssets: assets.widgetAssets, zeroPicture: renderer.picture(null), cinematics: cinematicInterface,
      context: { kind: "ui", bindings: { keyName: keynumToString, getBinding: key => keys.getBinding(key) ?? "",
        setBinding: (key, command) => keys.setBinding(key, command), getOverstrike: () => keys.getOverstrike(),
        setOverstrike: value => keys.setOverstrike(value) }, pause: unexpected },
      audio: { playLocal: handle => {
        if (!sound.started || sound.muted) return;
        const pcm = typeof handle === "number" ? sound.bank.soundForIndex(handle) : handle;
        if (typeof handle === "number" && pcm === undefined) return;
        sound.startLocalSound(pcm ?? null, 6);
      }, startBackground: unexpected, stopBackground: unexpected },
      paintModel: unexpected, getTeamColor: unexpected, externalScript: { run: unexpected },
      feeder: { count: id => readFeeders().count(id), item: (id, index, column) => readFeeders().item(id, index, column),
        image: (id, index) => readFeeders().image(id, index), select: (id, index) => readFeeders().select(id, index) },
      ownerDraw: { visible: unexpected, width: unexpected, value: unexpected, paint: unexpected,
        handleKey: async (owner, flags, special, key) => { const result = await readKeys().handleKey(owner, flags, special, key); results.push(result); return result; },
        closeCinematic: handle => readCinematics().stop(handle) } });
    expect(runtime.menuCount()).toBe(ids.length);
    const browser = new ServerBrowser({ io, cvars: common.cvars, clientStatic: new ClientStaticState(), loopback: new LoopbackTransport(), print, assertCurrentOperation: current });
    const servers = new TeamArenaServerBrowser({ browser, cvars, gameInfo: game, runtime, commands: common.commands, calendar: clock, print, assertActive: current });
    const status = new TeamArenaServerStatus({ browser, cvars, display: servers, runtime, clock: events, print, assertActive: current });
    cinematics = new TeamArenaUiCinematics({ cinematics: cinematicInterface, game, teams, selection, cvars, servers, assertActive: current });
    feeders = new TeamArenaFeeders({ cvars, game, teams, selection, scores, players, browser, servers, status, cinematics, renderer, interaction,
      lists: new TeamArenaLists({ files: common.files, cvars: common.cvars, memory, assertActive: current }),
      models: new TeamArenaModels(common.files, renderer, print, current), readClient: () => session, readRealTime: () => time, print, assertActive: current });
    ownerKeys = new TeamArenaOwnerKeys({ cvars, game, teams, selection, feeders, scores, players, settings, catalog, servers, cinematics,
      runtime, interaction, readClient: () => session, readRealTime: () => time, assertActive: current });
    const ui = runtime;
    const press = async (id: number, key = KeyCode.Enter): Promise<UiOwnerDrawKeyResult> => {
      await ui.closeAll(); await ui.activate(`key${id}`); ui.setDisplayCursor(30, 30);
      const before = results.length;
      const menu = ui.focusedMenuHandle(); if (menu === undefined) throw new Error("Missing focused owner-key menu");
      await ui.handleCapturedKey(menu, { kind: "key", code: key, down: true });
      expect(results.length).toBe(before + 1);
      return infoSlot(results, before);
    };
    const loadRetail = async (): Promise<void> => { await game.parseGameInfo("gameinfo.txt"); await teams.parseTeamInfo("teaminfo.txt"); catalog.loadBots(); };
    let messageNumber = 0;
    const send = async (operations: readonly ServerOperation[]): Promise<void> => {
      const context: ServerMessageContext = { product: "missionpack", messageNumber: ++messageNumber, reliableSequence: 0,
        serverCommandSequence: 0, parseEntitiesNumber: 0, baseline: () => null, history: () => null };
      await session.receiveServerMessage(messageNumber, encodeServerMessage(0, operations, context));
    };
    const loadPlayers = async (leader: number): Promise<void> => {
      await send([{ kind: "gamestate", commandSequence: 0, clientNumber: 7, checksumFeed: 19, entries: [
        { kind: "configstring", index: 0, value: "\\sv_maxclients\\3" },
        { kind: "configstring", index: 1, value: "\\sv_serverid\\100\\sv_cheats\\1\\fs_game\\missionpack" },
        { kind: "configstring", index: 544, value: "\\n\\Alpha\\t\\1" },
        { kind: "configstring", index: 545, value: "\\n\\Other\\t\\2" },
        { kind: "configstring", index: 546, value: `\\n\\Self\\t\\1\\tl\\${leader}` },
      ] }]);
      const playerState = new PlayerState("missionpack"); playerState.clientNum = 2;
      await send([{ kind: "snapshot", validity: { kind: "valid" }, snapshot: { messageNumber: messageNumber + 1,
        serverTime: messageNumber * 100, deltaNumber: -1, flags: 0, serverCommandNumber: 0, parseEntitiesNumber: 0,
        areaMask: new Uint8Array(), playerState, entities: [] } }]);
    };
    return { ownerKeys, interaction, cvars, common, game, teams, selection, scores, players, catalog, servers, runtime, movies, cinematics,
      press, loadRetail, loadPlayers, results, setTime: (value: number): void => { time = value; }, retire: (): void => { active = false; }, close };
  } catch (error) { await close(); throw error; }
}

test("actual owner-key dispatch preserves numeric source wraps, false results and untouched special", async () => {
  const f = await fixture();
  try {
    expect([f.interaction.effectsColor, f.interaction.botIndex, f.interaction.skillIndex, f.interaction.redBlue, f.interaction.currentCrosshair]).toEqual([0, 0, 0, 0, 0]);
    f.common.cvars.set("handicap", "5", true);
    expect(await f.press(200, KeyCode.Mouse2)).toEqual({ handled: true, special: 42.5 }); expect(f.common.cvars.get("handicap")?.value).toBe("0");
    f.common.cvars.set("handicap", "99.999999", true); await f.press(200, KeyCode.KeypadEnter); expect(f.common.cvars.get("handicap")?.value).toBe("5");
    f.common.cvars.set("handicap", "99.5", true); await f.press(200); expect(f.common.cvars.get("handicap")?.value).toBe("5");
    f.common.cvars.set("handicap", "44.99999999", true); await f.press(200); expect(f.common.cvars.get("handicap")?.value).toBe("50");
    for (const key of [KeyCode.Enter, KeyCode.KeypadEnter, KeyCode.Mouse1]) {
      f.interaction.effectsColor = 6; expect((await f.press(201, key)).handled).toBe(true);
      expect(f.interaction.effectsColor).toBe(0); expect(f.common.cvars.get("color1")?.value).toBe("4");
    }
    await f.press(201, KeyCode.Mouse2); expect(f.common.cvars.get("color1")?.value).toBe("7");
    f.interaction.currentCrosshair = 0; expect(await f.press(242, KeyCode.Mouse2)).toEqual({ handled: false, special: 42.5 });
    expect(f.common.cvars.get("cg_drawCrosshair")?.value).toBe("9");
    f.interaction.redBlue = 2; expect((await f.press(241)).handled).toBe(false); expect(f.interaction.redBlue).toBe(3);
    f.interaction.skillIndex = 0; expect((await f.press(240, KeyCode.Mouse2)).handled).toBe(true); expect(f.interaction.skillIndex).toBe(4);
    f.common.cvars.set("g_spSkill", "5.9", true); await f.press(207); expect(f.common.cvars.get("g_spSkill")?.value).toBe("1");
    f.common.cvars.set("g_spSkill", "2147483648", true); await f.press(207, KeyCode.Mouse2); expect(f.common.cvars.get("g_spSkill")?.value).toBe("1");
    const before = f.interaction.effectsColor; expect((await f.press(201, KeyCode.Left)).handled).toBe(false); expect(f.interaction.effectsColor).toBe(before);
    expect(await f.ownerKeys.handleKey(999, 0, -0, KeyCode.Enter)).toEqual({ handled: false, special: -0 });
    expect(f.common.cvars.get("key_action")?.value).toBe("yes");
  } finally { await f.close(); }
});

test("clan/opponent and team-member keys use retail teams, real movie cleanup and actual bot catalog", async () => {
  const f = await fixture();
  try {
    await f.loadRetail(); expect(f.catalog.getNumBots()).toBe(45);
    const first = infoSlot(f.teams.teamList, 0), second = infoSlot(f.teams.teamList, 1), third = infoSlot(f.teams.teamList, 2);
    const firstName = first.teamName, secondName = second.teamName, thirdName = third.teamName;
    if (firstName === null || secondName === null || thirdName === null) throw new Error("Missing retail team names");
    f.common.cvars.set("ui_teamName", firstName, true);
    first.cinematic = await f.cinematics.play("mpteam1.roq", { x: 0, y: 0, width: 0, height: 0 });
    const handle = f.movies.handleAtSlot(first.cinematic); if (handle === undefined) throw new Error("Missing actual movie slot");
    f.cinematics.run(first.cinematic); f.setTime(134); f.cinematics.run(first.cinematic); f.interaction.updateModel = false;
    expect((await f.press(203)).handled).toBe(true); expect(first.cinematic).toBe(-1); expect(f.movies.run(handle)).toBe(CinematicStatus.Idle);
    expect(f.common.cvars.get("ui_teamName")?.value).toBe(secondName); expect(f.interaction.updateModel).toBe(true);
    const selected = infoSlot(f.teams.characterList, f.selection.selectedHead(0).actual);
    expect(f.common.cvars.get("team_headmodel")?.value).toBe(`*${selected.name}`);
    f.common.cvars.set("ui_opponentName", firstName, true);
    expect((await f.press(237)).handled).toBe(false); expect(f.common.cvars.get("ui_opponentName")?.value).toBe(thirdName);
    await f.press(237, KeyCode.Mouse2); expect(f.common.cvars.get("ui_opponentName")?.value).toBe(firstName);
    f.common.cvars.set("ui_blueTeam", firstName, true); expect((await f.press(208)).handled).toBe(true);
    expect(f.common.cvars.get("ui_blueTeam")?.value).toBe(secondName);
    f.cvars.writeInteger("ui_actualNetGameType", 0); f.common.cvars.set("ui_actualNetGametype", "4", true);
    f.common.cvars.set("ui_blueteam1", "0", true); expect((await f.press(210, KeyCode.Mouse2)).handled).toBe(false);
    expect(f.common.cvars.get("ui_blueteam1")?.value).toBe("46");
    f.cvars.writeInteger("ui_actualNetGameType", 4); f.common.cvars.set("ui_redteam5", "0", true);
    await f.press(219, KeyCode.Mouse2); expect(f.common.cvars.get("ui_redteam5")?.value).toBe(String(f.teams.characterCount + 1));
    f.common.cvars.set("g_gametype", "2.99999999", true); f.interaction.botIndex = 0;
    expect((await f.press(239, KeyCode.Mouse2)).handled).toBe(true); expect(f.interaction.botIndex).toBe(f.teams.characterCount + 1);
    f.common.cvars.set("g_gametype", "0", true); f.interaction.botIndex = 0; await f.press(239, KeyCode.Mouse2); expect(f.interaction.botIndex).toBe(46);
    second.teamName = null; f.common.cvars.set("ui_redTeam", firstName, true); await f.press(209);
    expect(f.common.cvars.get("ui_redTeam")?.value).toBe(f.common.cvars.get("ui_redTeam")?.resetValue);
  } finally { await f.close(); }
});

test("game-type owner keys retain source skip rules, active flags and awaited real map-feeder effects", async () => {
  const f = await fixture();
  try {
    await f.loadRetail(); expect(infoSlot(f.game.gameTypes, 3).gtEnum).toBe(4);
    f.game.mapCount = 2; infoSlot(f.game.mapList, 0).typeBits = 20; infoSlot(f.game.mapList, 1).typeBits = 20;
    f.cvars.writeInteger("ui_gameType", 1); f.cvars.writeInteger("ui_currentMap", 1);
    const writes: [string, string, number][] = [], set = f.common.cvars.set.bind(f.common.cvars);
    f.common.cvars.set = (name, value, force) => { writes.push([name, value, f.cvars.get("ui_currentMap").integerValue]); return set(name, value, force); };
    expect((await f.press(205)).handled).toBe(true);
    expect(f.cvars.get("ui_gameType").integerValue).toBe(3); expect(f.common.cvars.get("ui_Q3Model")?.value).toBe("0");
    expect(writes.slice(0, 4).map(row => row.slice(0, 2))).toEqual([["ui_Q3Model", "0"], ["ui_gameType", "3"], ["ui_captureLimit", "5"], ["ui_fragLimit", "10"]]);
    expect(writes.filter(row => row[0] === "ui_currentMap")).toEqual([["ui_currentMap", "0", 1], ["ui_currentMap", "0", 0]]);
    expect(f.cvars.get("ui_currentMap").integerValue).toBe(0); expect(infoSlot(f.game.mapList, 0).cinematic).toBeGreaterThanOrEqual(0);
    f.cvars.writeInteger("ui_gameType", 1); infoSlot(f.game.mapList, 0).typeBits = 20; infoSlot(f.game.mapList, 1).typeBits = 6;
    expect(await f.ownerKeys.gameTypeHandleKey(KeyCode.Enter, false)).toBe(true);
    expect(f.game.mapList.slice(0, 2).map(row => row.active)).toEqual([false, true]); // No post-change recount when resetMap=false.
    await f.ownerKeys.gameTypeHandleKey(KeyCode.Mouse2, false); expect(f.cvars.get("ui_gameType").integerValue).toBe(1);
    expect(f.common.cvars.get("ui_Q3Model")?.value).toBe("1");
    f.cvars.writeInteger("ui_netGameType", 2); f.cvars.writeInteger("ui_actualNetGameType", 99);
    expect((await f.press(245)).handled).toBe(true); expect(f.common.cvars.get("ui_actualnetGameType")?.value).toBe("4");
    expect(f.cvars.get("ui_actualNetGameType").integerValue).toBe(99); expect(f.cvars.get("ui_currentNetMap").integerValue).toBe(0);
  } finally { await f.close(); }
});

test("network source/filter/join handlers use real display refresh and preserve false dispatch returns", async () => {
  const f = await fixture();
  try {
    await f.loadRetail(); f.cvars.writeInteger("ui_netSource", 0);
    const writes: [string, string, number][] = [], set = f.common.cvars.set.bind(f.common.cvars);
    f.common.cvars.set = (name, value, force) => { writes.push([name, value, f.cvars.get("ui_netSource").integerValue]); return set(name, value, force); };
    expect((await f.press(220)).handled).toBe(false); expect(f.cvars.get("ui_netSource").integerValue).toBe(2);
    expect(f.servers.refreshActive).toBe(false); expect(writes.filter(row => row[0] !== "key_action").at(-1)).toEqual(["ui_netSource", "2", 2]);
    expect((await f.press(220)).handled).toBe(false); expect(f.cvars.get("ui_netSource").integerValue).toBe(3);
    expect(f.servers.refreshActive).toBe(true); expect(f.servers.refreshtime).toBe(5100);
    const stamp = writes.findIndex(row => row[0] === "ui_lastServerRefresh_3");
    expect(stamp).toBeGreaterThanOrEqual(0); expect(writes.filter(row => row[0] !== "key_action").at(-1)).toEqual(["ui_netSource", "3", 3]);
    expect(f.common.cvars.get("ui_serverFilterType")).toBeUndefined();
    expect((await f.press(222, KeyCode.Mouse2)).handled).toBe(false); expect(f.servers.serverFilterType).toBe(6);
    expect(f.common.cvars.get("ui_serverFilterType")).toBeUndefined();
    f.cvars.writeInteger("ui_joinGameType", 0); expect((await f.press(253, KeyCode.Mouse2)).handled).toBe(true);
    expect(f.cvars.get("ui_joinGameType").integerValue).toBe(f.game.numJoinGameTypes - 1);
  } finally { await f.close(); }
});

test("selected-player keys always return false after actual snapshot/team publication", async () => {
  const f = await fixture();
  try {
    await f.loadPlayers(0); f.common.cvars.set("cg_selectedPlayer", "0", true);
    expect((await f.press(243)).handled).toBe(false); expect(f.common.cvars.get("cg_selectedPlayer")?.value).toBe("1");
    expect(f.players.playerNumber).toBe(2); expect(f.common.cvars.get("cg_selectedPlayerName")?.value).toBe("Self");
    await f.loadPlayers(1); f.common.cvars.set("cg_selectedPlayer", "1", true);
    expect((await f.press(243)).handled).toBe(false); expect(f.common.cvars.get("cg_selectedPlayer")?.value).toBe("2");
    expect(f.common.cvars.get("cg_selectedPlayerName")?.value).toBe("Everyone");
    await f.press(243); expect(f.common.cvars.get("cg_selectedPlayerName")?.value).toBe("Alpha");
    await f.press(243, KeyCode.Mouse2); expect(f.common.cvars.get("cg_selectedPlayerName")?.value).toBe("Everyone");
    expect(f.interaction.playerRefresh).toBe(0);
  } finally { await f.close(); }
});

test("retirement during actual map preparation retains reached key/cvar writes and blocks later publication", async () => {
  const f = await fixture(), gate = deferred(), entered = deferred();
  try {
    await f.loadRetail(); f.cvars.writeInteger("ui_netGameType", 2);
    const read = f.common.files.current.read.bind(f.common.files.current);
    f.common.files.current.read = async path => { if (path.endsWith(".roq")) { entered.resolve(); await gate.promise; } return await read(path); };
    const pending = f.press(245);
    await entered.promise;
    expect(f.common.cvars.get("ui_actualnetGameType")?.value).toBe("4");
    f.retire(); gate.resolve(); await expect(pending).rejects.toThrow("retired Team Arena owner-key");
    expect(f.results).toHaveLength(0); expect(f.cvars.get("ui_netGameType").integerValue).toBe(3);
  } finally { gate.resolve(); await f.close(); }
});
