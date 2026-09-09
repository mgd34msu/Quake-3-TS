import { HunkArena } from "../src/core/hunk.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonParseState } from "../src/core/common-parse.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { ClientKeys, keynumToString } from "../src/engine/client-keys.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { ClientStaticState } from "../src/engine/client-state.ts";
import { CinematicStatus, EngineCinematics } from "../src/engine/cinematics.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { ServerBrowser, ServerBrowserSource } from "../src/engine/server-browser.ts";
import { EngineSound } from "../src/engine/sound.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { EngineUiCinematics } from "../src/engine/ui-cinematics.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { decodeConnectionless } from "../src/protocol/connectionless.ts";
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
import { TeamArenaCatalog } from "../src/ui/team-arena/catalog.ts";
import { TeamArenaUiCinematics } from "../src/ui/team-arena/cinematics.ts";
import { TeamArenaUiCvars } from "../src/ui/team-arena/cvars.ts";
import { TeamArenaFeeders } from "../src/ui/team-arena/feeders.ts";
import { infoSlot, TeamArenaGameInfo, TeamArenaMenuBuffer } from "../src/ui/team-arena/game-info.ts";
import { TeamArenaUiInteractionState } from "../src/ui/team-arena/interaction-state.ts";
import { TeamArenaLists } from "../src/ui/team-arena/lists.ts";
import { TeamArenaMenuScripts } from "../src/ui/team-arena/menu-scripts.ts";
import { CvarFlag } from "../src/core/cvar.ts";
import { TeamArenaUiMemory } from "../src/ui/team-arena/memory.ts";
import { TeamArenaModels } from "../src/ui/team-arena/models.ts";
import { TeamArenaOwnerKeys } from "../src/ui/team-arena/owner-keys.ts";
import { TeamArenaPlayerList } from "../src/ui/team-arena/player-list.ts";
import { TeamArenaUiResources } from "../src/ui/team-arena/resources.ts";
import { PostGameInfo, TeamArenaScores } from "../src/ui/team-arena/scores.ts";
import { TeamArenaSelection } from "../src/ui/team-arena/selection.ts";
import { TeamArenaServerBrowser } from "../src/ui/team-arena/server-browser.ts";
import { TeamArenaServerStatus } from "../src/ui/team-arena/server-status.ts";
import { TeamArenaSettings } from "../src/ui/team-arena/settings.ts";
import { TeamArenaTeamInfo } from "../src/ui/team-arena/team-info.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";
import { deferred } from "./base-ui-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

async function fixture(scriptTexts: readonly string[], usesUniqueKey: (common: CommonConsole) => number = () => 1) {
  const homePath = await mkdtemp(join(tmpdir(), "q3-team-menu-scripts-")), printed: string[] = [], clock = new UnixSystemClock();
  const print = (text: string): undefined => { printed.push(text); };
  let active = true, closing = false, commonOpen = true, time = 100;
  const current = (): undefined => { if (!active && !closing) throw new Error("retired Team Arena menu-script"); };
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
  const lifecycle = new ProtocolClientLifecycle(common.cvars), peer = new UnixIo(print, clock, { signals: "none" });
  let runtime: UiRuntime | undefined, assets: TeamArenaUiResources | undefined;
  let target: RenderTarget | null = null;
  const close = async (): Promise<void> => {
    // The rejected operation has settled before this separate teardown operation.
    closing = true;
    try {
      runtime?.dispose(); assets?.dispose(); movies.dispose(); lifecycle.close(); sound.close(); common.close(); commonOpen = false; io.close(); peer.close();
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
    let feeders: TeamArenaFeeders | undefined, ownerKeys: TeamArenaOwnerKeys | undefined, cinematics: TeamArenaUiCinematics | undefined, scripts: TeamArenaMenuScripts | undefined;
    const readScripts = (): TeamArenaMenuScripts => { if (scripts === undefined) throw new Error("Scripts before composition"); return scripts; };
    const readFeeders = (): TeamArenaFeeders => { if (feeders === undefined) throw new Error("Feeder before composition"); return feeders; };
    const readKeys = (): TeamArenaOwnerKeys => { if (ownerKeys === undefined) throw new Error("Owner keys before composition"); return ownerKeys; };
    const readCinematics = (): TeamArenaUiCinematics => { if (cinematics === undefined) throw new Error("Cinematics before composition"); return cinematics; };
    const source = { path: "ui/menu-scripts.menu", text: `menuDef { name driver rect 0 0 640 480
      ${scriptTexts.map((text, i) => `itemDef { name s${i} type 1 rect 0 0 20 20 action { ${text} } }`).join("\n")}
      itemDef { name binding type 13 cvar "+forward" rect 0 0 20 20 }
      itemDef { name find type 6 feeder 14 rect 0 0 20 20 }
      itemDef { name status type 6 feeder 13 rect 0 0 20 20 } }
      ${["main", "joinserver", "setup_menu2", "skirmish", "createserver"].map(name => `menuDef { name "${name}" rect 0 0 640 480
        itemDef { name maps type 6 feeder 1 rect 0 0 100 100 }
        itemDef { name allmaps type 6 feeder 4 rect 100 0 100 100 }
        itemDef { name servers type 6 feeder 2 rect 200 0 100 100 }
        itemDef { name find type 6 feeder 14 rect 0 100 100 100 }
        itemDef { name status type 6 feeder 13 rect 100 100 100 100 } }`).join("\n")}` };
    const set = { path: "ui/menu-scripts.txt", text: 'loadMenu { "ui/menu-scripts.menu" }' };
    const resolve = (path: string) => path === source.path ? source : path === set.path ? set : undefined;
    const definitions = await loadMenuDefinitions({ random: { nextInt: () => 0 }, resolver: { resolveRoot: resolve, resolve: request => resolve(request.requestedPath) } },
      { kind: "ui", setPaths: [set.path] }, {}, { memory: { kind: "qvm32", memory } });
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
      paintModel: unexpected, getTeamColor: unexpected, externalScript: { run: (cursor, context) => readScripts().run(cursor, context) },
      feeder: { count: id => readFeeders().count(id), item: (id, index, column) => readFeeders().item(id, index, column),
        image: (id, index) => readFeeders().image(id, index), select: (id, index) => readFeeders().select(id, index) },
      ownerDraw: { visible: unexpected, width: unexpected, value: unexpected, paint: unexpected,
        handleKey: (owner, flags, special, key) => readKeys().handleKey(owner, flags, special, key),
        closeCinematic: handle => readCinematics().stop(handle) } });
    expect(runtime.menuCount()).toBe(6);
    const loopback = new LoopbackTransport();
    common.cvars.register("cl_serverStatusResendTime", "750");
    const browser = new ServerBrowser({ io, cvars: common.cvars, clientStatic: new ClientStaticState(), loopback, print, assertCurrentOperation: current });
    const servers = new TeamArenaServerBrowser({ browser, cvars, gameInfo: game, runtime, commands: common.commands, calendar: clock, print, assertActive: current });
    const status = new TeamArenaServerStatus({ browser, cvars, display: servers, runtime, clock: events, print, assertActive: current });
    cinematics = new TeamArenaUiCinematics({ cinematics: cinematicInterface, game, teams, selection, cvars, servers, assertActive: current });
    const lists = new TeamArenaLists({ files: common.files, cvars: common.cvars, memory, assertActive: current });
    feeders = new TeamArenaFeeders({ cvars, game, teams, selection, scores, players, browser, servers, status, cinematics, renderer, interaction,
      lists,
      models: new TeamArenaModels(common.files, renderer, print, current), readClient: () => session, readRealTime: () => time, print, assertActive: current });
    ownerKeys = new TeamArenaOwnerKeys({ cvars, game, teams, selection, feeders, scores, players, settings, catalog, servers, cinematics,
      runtime, interaction, readClient: () => session, readRealTime: () => time, assertActive: current });
    scripts = new TeamArenaMenuScripts({ cvars, commands: common.commands, keys, cdKey: common.cdKey, usesUniqueKey: () => usesUniqueKey(common), game, teams,
      catalog, selection, lists, scores, players, feeders, browser, servers, status, cinematics, settings, ownerKeys, runtime,
      interaction, readRealTime: () => time, print, assertActive: current });
    const ui = runtime;
    const run = async (index: number): Promise<void> => {
      const definition = infoSlot(infoSlot(definitions.menus, 0).items, index);
      if (definition.action === undefined) throw new Error("Missing generated script");
      await ui.runItemScript("driver", `s${index}`, definition.action);
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
      players.build(session);
    };
    const localNetwork = async (): Promise<string> => {
      common.cvars.set("net_ip", "127.0.0.1", true); common.cvars.set("net_port", "0", true);
      await io.initializeNetwork(common.cvars); common.cvars.set("net_port", "0", true); await peer.initializeNetwork(common.cvars);
      if (peer.udp === null) throw new Error("Missing fixture peer socket");
      return `127.0.0.1:${peer.udp.address.port}`;
    };
    const peerRequest = async (): Promise<string> => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        peer.pollPacketEvent(); const event = peer.takeQueuedEvent();
        if (event?.kind === "packet") return decodeConnectionless(event.payload, "server").line;
        await Bun.sleep(1);
      }
      throw new Error("Missing localhost status packet");
    };
    return { scripts, keys, ownerKeys, interaction, cvars, common, game, teams, selection, scores, players, catalog, servers,
      browser, status, runtime, movies, cinematics, lists, loopback, memory, printed, definitions, run, loadRetail, loadPlayers,
      localNetwork, peerRequest,
      setTime: (value: number): void => { time = value; }, retire: (): void => { active = false; }, close };

  } catch (error) { await close(); throw error; }
}

function generatedMaps(f: Awaited<ReturnType<typeof fixture>>): void {
  f.game.numGameTypes = 5;
  for (let i = 0; i < 5; i++) infoSlot(f.game.gameTypes, i).gtEnum = i;
  f.game.mapCount = 3;
  for (let i = 0; i < 3; i++) {
    const map = infoSlot(f.game.mapList, i);
    map.mapLoadName = `script_map${i}`; map.mapName = `Script Map ${i}`; map.opponentName = "Sarge";
    map.teamMembers = 2; map.typeBits = i === 1 ? (1 << 4) | (1 << 2) : (1 << 0) | (1 << 2);
    map.cinematic = -1;
  }
  f.cvars.writeInteger("ui_gameType", 3); f.cvars.writeInteger("ui_currentMap", 0);
  f.cvars.writeInteger("ui_netGameType", 3); f.cvars.writeInteger("ui_currentNetMap", 0);
}

test("StartServer writes forced values and appends interleaved source bot commands from actual metadata", async () => {
  const f = await fixture(["uiScript StartServer;", "uiScript addBot;", "uiScript RunSPDemo;"]);
  try {
    await f.loadRetail(); expect(f.teams.characterCount).toBeGreaterThan(10); expect(f.game.mapCount).toBeGreaterThan(10);
    generatedMaps(f);
    infoSlot(f.teams.characterList, 0).name = "BlueOne"; infoSlot(f.teams.characterList, 1).name = "RedOne";
    f.cvars.writeInteger("ui_dedicated", 8); f.cvars.writeInteger("ui_actualNetGameType", 3);
    f.common.cvars.register("cg_thirdPerson", "1", CvarFlag.ReadOnly);
    f.common.cvars.register("g_gametype", "0", CvarFlag.Latch);
    f.common.cvars.set("sv_maxClients", "12.9", true); f.common.cvars.set("g_spSkill", "2.5", true);
    for (let i = 1; i <= 5; i++) {
      f.common.cvars.set(`ui_blueteam${i}`, "-1", true); f.common.cvars.set(`ui_redteam${i}`, "-1", true);
    }
    f.common.cvars.set("ui_blueteam1", "2.9", true); f.common.cvars.set("ui_redteam1", "3.9", true);
    f.common.cvars.set("ui_blueteam2", "1", true);
    await f.run(0);
    expect(f.common.commands.pendingText).toBe("wait ; wait ; map script_map0\naddbot BlueOne 2.500000 Blue\naddbot RedOne 2.500000 Red\n");
    expect(f.common.cvars.get("dedicated")?.value).toBe("2"); expect(f.common.cvars.get("g_gametype")?.value).toBe("3");
    expect(f.common.cvars.get("g_gametype")?.latchedValue).toBeUndefined();
    expect(f.common.cvars.get("cg_thirdPerson")?.value).toBe("0"); expect(f.common.cvars.get("sv_maxClients")?.value).toBe("12");
    expect(f.common.cvars.get("g_redTeam")?.value).toBe("Pagans"); expect(f.common.cvars.get("g_blueTeam")?.value).toBe("Stroggs");
    const before = f.common.commands.pendingText;
    f.interaction.botIndex = 1; f.interaction.skillIndex = 4; f.interaction.redBlue = 1; await f.run(1);
    expect(f.common.commands.pendingText.slice(before.length)).toBe("addbot RedOne 5 Blue\n");
    f.scores.demoAvailable = false; const noDemo = f.common.commands.pendingText; await f.run(2); expect(f.common.commands.pendingText).toBe(noDemo);
    f.scores.demoAvailable = true; await f.run(2); expect(f.common.commands.pendingText.endsWith("demo script_map0_3\n")).toBe(true);
    f.cvars.writeInteger("ui_currentNetMap", 128);
    f.common.cvars.set("cg_thirdPerson", "1", true);
    await expect(f.run(0)).rejects.toThrow("128-entry array");
    expect(f.common.cvars.get("cg_thirdPerson")?.value).toBe("0");
  } finally { await f.close(); }
});

test("skirmish preserves saves, alias fallback, delays, next-map feeder and tournament comma", async () => {
  const f = await fixture(["uiScript SkirmishStart;", "uiScript nextSkirmish;", "uiScript updateSPMenu;"]);
  try {
    await f.loadRetail(); generatedMaps(f);
    f.teams.teamCount = 2;
    const red = infoSlot(f.teams.teamList, 0), blue = infoSlot(f.teams.teamList, 1);
    red.teamName = "Pagans"; red.teamMembers[0] = "Alice"; red.teamMembers[1] = "Bob";
    blue.teamName = "Stroggs"; blue.teamMembers[0] = "Carl"; blue.teamMembers[1] = "Dan";
    f.teams.aliasCount = 2;
    Object.assign(infoSlot(f.teams.aliasList, 0), { name: "Alice", ai: "sarge" });
    Object.assign(infoSlot(f.teams.aliasList, 1), { name: "Carl", ai: "visor" });
    f.common.cvars.set("g_spSkill", "3", true); f.common.cvars.set("capturelimit", "8.75", true);
    f.common.cvars.set("fraglimit", "27.9", true); f.common.cvars.set("sv_maxClients", "16", true);
    f.common.cvars.set("g_warmup", "31", true); f.common.cvars.set("ui_recordSPDemo", "1", true);
    await f.run(0);
    expect(f.common.commands.pendingText).toBe("wait ; wait ; map script_map0\naddbot visor 3.000000 Blue 500 Carl\naddbot James 3.000000 Blue 1000 Dan\naddbot sarge 3.000000 Red 1500 Alice\nwait 5; team Red\n");
    expect(f.common.cvars.get("ui_saveCaptureLimit")?.value).toBe("8"); expect(f.common.cvars.get("ui_saveFragLimit")?.value).toBe("27");
    expect(f.common.cvars.get("capturelimit")?.value).toBe("5"); expect(f.common.cvars.get("fraglimit")?.value).toBe("10");
    expect(f.common.cvars.get("ui_maxClients")?.value).toBe("16"); expect(f.common.cvars.get("ui_Warmup")?.value).toBe("31");
    expect(f.common.cvars.get("sv_maxClients")?.value).toBe("4"); expect(f.common.cvars.get("sv_pure")?.value).toBe("0");
    expect(f.common.cvars.get("ui_recordSPDemoName")?.value).toBe("script_map0_3");
    f.common.cvars.set("ui_mapIndex", "0.9", true); await f.run(1);
    expect(f.cvars.get("ui_currentMap").integerValue).toBe(2); expect(f.cvars.get("ui_mapIndex").integerValue).toBe(1);
    expect(f.common.commands.pendingText).toContain("wait ; wait ; map script_map2\n");
    await f.run(1); // last active map advances game type then selects its first active map.
    expect(f.cvars.get("ui_gameType").integerValue).toBe(4); expect(f.cvars.get("ui_currentMap").integerValue).toBe(1);
    expect(f.common.commands.pendingText).toContain("wait ; wait ; map script_map1\n");
    await f.run(2);
    expect(f.cvars.get("ui_gameType").integerValue).toBe(4); expect(f.cvars.get("ui_currentMap").integerValue).toBe(1);
    f.cvars.writeInteger("ui_gameType", 1);
    const before = f.common.commands.pendingText; await f.run(0);
    expect(f.common.commands.pendingText.slice(before.length)).toBe("wait ; wait ; map script_map1\nwait ; addbot Sarge 3.000000 , 500 \n");
    expect(f.common.cvars.get("sv_maxClients")?.value).toBe("2");
  } finally { await f.close(); }
});

test("common dummy CD key and shared controls retain source writes and reset-to-minus-one defaults", async () => {
  const f = await fixture(["uiScript getCDKey;", "uiScript verifyCDKey;", "uiScript loadControls;", "uiScript saveControls;",
    "uiScript resetDefaults;", "uiScript update ui_setName; uiScript glCustom; uiScript clearError;"]);
  try {
    // Generated dummy bytes only. No credential file is read or written.
    const dummy = "2222222222222222";
    f.common.cdKey.writeUiForCompiledModule(() => 1, () => Uint8Array.from(dummy, letter => letter.charCodeAt(0)));
    await f.run(0); for (let i = 1; i <= 4; i++) expect(f.common.cvars.get(`cdkey${i}`)?.value).toBe("2222");
    f.common.cvars.set("cdkeychecksum", "20", true); await f.run(1);
    expect(f.common.cvars.get("cdkey")?.value).toBe(dummy);
    expect(f.common.cvars.get("ui_cdkeyvalid")?.value).toBe("CD Key Appears to be valid.");
    f.common.cvars.set("cdkey1", "xxxx", true); await f.run(1);
    expect(f.common.cvars.get("ui_cdkeyvalid")?.value).toBe("CD Key does not appear to be valid.");
    const bytes = new Uint8Array(17); f.common.cdKey.readUiForCompiledModule(() => 1, () => bytes); expect(String.fromCharCode(...bytes.slice(0, 16))).toBe(dummy);
    f.keys.setBinding(KeyCode.Up, "+forward"); await f.run(2); f.keys.setBinding(KeyCode.Up, "changed"); await f.run(3);
    expect(f.keys.getBinding(KeyCode.Up)).toBe("+forward"); expect(f.common.commands.pendingText).toBe("in_restart\n");
    await f.run(4); f.keys.setBinding(KeyCode.Up, "unchanged"); await f.run(3);
    expect(f.keys.getBinding(KeyCode.Up)).toBe("unchanged");
    expect(f.common.commands.pendingText).toBe("in_restart\nexec default.cfg\ncvar_restart\nvid_restart\nin_restart\n");
    expect(f.common.cvars.get("com_introPlayed")?.value).toBe("1");
    f.common.cvars.register("ui_glCustom", "0", CvarFlag.ReadOnly); f.common.cvars.set("ui_Name", "Script Name", true);
    await f.run(5); expect(f.common.cvars.get("name")?.value).toBe("Script Name");
    expect(f.common.cvars.get("ui_glCustom")?.value).toBe("4"); expect(f.common.cvars.get("com_errorMessage")?.value).toBe("");
  } finally { await f.close(); }
});

test("CD key scripts reach UI callbacks before buffer writes and retain cvar prefixes on callback failure", async () => {
  const failure = new Error("UI_HASUNIQUECDKEY failed");
  let fail = true, calls = 0;
  const f = await fixture(["uiScript getCDKey; setcvar afterGet 1;", "uiScript verifyCDKey; setcvar afterVerify 1;"], common => {
    const game = common.cvars.get("fs_game");
    if (game === undefined) throw new Error("UI callback reached before fs_game registration");
    expect(game.flags & (CvarFlag.Init | CvarFlag.SystemInfo)).toBe(CvarFlag.Init | CvarFlag.SystemInfo);
    calls++;
    if (fail) throw failure;
    return 1;
  });
  try {
    f.common.cdKey.writeUiForCompiledModule(() => 1, () => new Uint8Array(16).fill(50));
    for (let i = 1; i <= 4; i++) f.common.cvars.set(`cdkey${i}`, "kept", true);
    await expect(f.run(0)).rejects.toBe(failure);
    expect(calls).toBe(1);
    for (let i = 1; i <= 4; i++) expect(f.common.cvars.get(`cdkey${i}`)?.value).toBe("kept");
    expect(f.common.cvars.get("afterGet")).toBeUndefined();
    fail = false; await f.run(0);
    expect(calls).toBe(2);
    for (let i = 1; i <= 4; i++) expect(f.common.cvars.get(`cdkey${i}`)?.value).toBe("2222");
    expect(f.common.cvars.get("afterGet")?.value).toBe("1");
    for (let i = 1; i <= 4; i++) f.common.cvars.set(`cdkey${i}`, "AAAA", true);
    f.common.cvars.set("cdkeychecksum", "10", true); f.common.cvars.takeModifiedFlags();
    fail = true; await expect(f.run(1)).rejects.toBe(failure);
    expect(calls).toBe(3);
    expect(f.common.cvars.get("cdkey")?.value).toBe("A".repeat(16));
    expect(f.common.cvars.get("ui_cdkeyvalid")?.value).toBe("CD Key Appears to be valid.");
    expect(f.common.cvars.get("afterVerify")).toBeUndefined();
    expect(f.common.cvars.modifiedFlags & CvarFlag.Archive).toBe(0);
    const out = new Uint8Array(17); f.common.cdKey.readUiForCompiledModule(() => 1, () => out);
    expect(out).toEqual(new Uint8Array([...new Uint8Array(16).fill(50), 0]));
    fail = false; await f.run(1);
    expect(calls).toBe(4); expect(f.common.cvars.get("afterVerify")?.value).toBe("1");
    expect(f.common.cvars.modifiedFlags & CvarFlag.Archive).toBe(CvarFlag.Archive);
    f.common.cdKey.readUiForCompiledModule(() => 1, () => out);
    expect(out).toEqual(new Uint8Array([...new Uint8Array(16).fill(65), 0]));
  } finally { await f.close(); }
});

test("actual player records drive votes and source order formats, with key clearing and reached bad-format rejection", async () => {
  const f = await fixture(["uiScript voteKick; uiScript voteLeader; uiScript voteMap; uiScript voteGame;",
    'uiScript orders "tell %i defend";', 'uiScript orders "tell %s defend";', 'uiScript voiceOrders "vtell %i defend";',
    'uiScript voiceOrdersTeam "vsay_team defend";', "uiScript Controls;", "uiScript Leave;", "uiScript closeingame;"]);
  try {
    await f.loadPlayers(1); generatedMaps(f); f.common.cvars.set("name", "Self", true);
    f.interaction.playerIndex = 1; f.interaction.teamIndex = 0;
    await f.run(0); expect(f.common.commands.pendingText).toBe("callvote kick Other\ncallteamvote leader Alpha\ncallvote map script_map0\ncallvote g_gametype 3\n");
    f.common.cvars.set("cg_selectedPlayer", "0.9", true); f.keys.setCatcher(KeyCatcher.Ui | KeyCatcher.Console);
    await f.keys.keyEvent(KeyCode.Mouse1, true, 1); await f.run(1);
    expect(f.common.commands.pendingText.endsWith("tell 0 defend\n")).toBe(true);
    expect(f.keys.getCatcher()).toBe(KeyCatcher.Console); expect(f.keys.isDown(KeyCode.Mouse1)).toBe(false);
    expect(f.common.cvars.get("cl_paused")?.value).toBe("0");
    f.common.cvars.set("cg_selectedPlayer", "2", true); await f.run(2);
    expect(f.common.commands.pendingText.endsWith("tell Alpha defend\n")).toBe(true);
    f.keys.setCatcher(KeyCatcher.Ui); f.common.cvars.set("cl_paused", "1", true);
    await expect(f.run(1)).rejects.toThrow("must be a number");
    expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui); expect(f.common.cvars.get("cl_paused")?.value).toBe("1");
    await f.run(4); expect(f.common.commands.pendingText.endsWith("vsay_team defend\n")).toBe(true);
    f.common.cvars.set("cg_selectedPlayer", "1", true); await f.run(3);
    expect(f.common.commands.pendingText.endsWith("vtell 2 defend\n")).toBe(true);
    await f.run(5); expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui); expect(f.runtime.snapshot().focusedMenu).toBe("setup_menu2");
    await f.run(6); expect(f.runtime.snapshot().focusedMenu).toBe("main"); expect(f.common.commands.pendingText.endsWith("disconnect\n")).toBe(true);
    await f.run(7); expect(f.runtime.snapshot().focusedMenu).toBeUndefined(); expect(f.keys.getCatcher()).toBe(0);
  } finally { await f.close(); }
});

test("browser scripts use engine favorites, loopback status and original refresh deadlines", async () => {
  const f = await fixture(["uiScript createFavorite;", "uiScript JoinServer;", "uiScript ServerStatus;", "uiScript StopRefresh;",
    "uiScript ServerSort 0;", "uiScript deleteFavorite;", "uiScript closeJoin;", "uiScript RefreshFilter;", "uiScript UpdateFilter;",
    "uiScript FoundPlayerJoinServer;", "uiScript FoundPlayerServerStatus;", "uiScript FindPlayer;"]);
  try {
    const address = await f.localNetwork();
    f.cvars.writeInteger("ui_netSource", ServerBrowserSource.Favorites);
    f.common.cvars.set("ui_favoriteName", "Local Favorite", true); f.common.cvars.set("ui_favoriteAddress", address, true);
    await f.run(0); expect(f.browser.getServerCount(ServerBrowserSource.Favorites)).toBe(1);
    expect(f.printed).toContain(`Added favorite server ${address}\n`); await f.run(0); expect(f.printed).toContain("Favorite already in list\n");
    f.servers.numDisplayServers = 1; f.servers.displayServers[0] = 0; await f.run(1);
    expect(f.common.commands.pendingText).toBe(`connect ${address}\n`);
    await f.run(2); expect(f.status.serverStatusAddress).toBe(address);
    expect(await f.peerRequest()).toBe("getstatus");
    expect(f.status.nextServerStatusRefresh).toBe(600);
    f.servers.refreshActive = true; f.servers.nextDisplayRefresh = 77; f.status.nextFindPlayerRefresh = 99;
    await f.run(3); expect(f.servers.refreshActive).toBe(false); expect(f.servers.nextDisplayRefresh).toBe(0);
    expect(f.status.nextServerStatusRefresh).toBe(0); expect(f.status.nextFindPlayerRefresh).toBe(0);
    await f.run(4); expect(f.servers.sortDir).toBe(1); await f.run(4); expect(f.servers.sortDir).toBe(0);
    await f.runtime.activate("joinserver"); await f.run(6); expect(f.runtime.snapshot().focusedMenu).toBe("main");
    await f.run(7); expect(f.servers.refreshActive).toBe(true); expect(f.servers.refreshtime).toBe(100); // Display rebuild overwrites the earlier 1100 deadline.
    await f.run(8); expect(f.servers.currentServer).toBe(0);
    f.status.currentFoundPlayerServer = 1; f.status.numFoundPlayerServers = 2;
    f.status.foundPlayerServerAddresses[0] = "localhost"; f.status.foundPlayerServerAddresses[1] = "localhost";
    await f.run(9); expect(f.common.commands.pendingText.endsWith("connect localhost\n")).toBe(true);
    await f.runtime.activate("driver"); await f.run(10); expect(f.status.currentFoundPlayerServer).toBe(0);
    const request = f.loopback.poll("server"); if (request === null) throw new Error("Expected actual loopback status request");
    expect(decodeConnectionless(request.payload, "server").line).toBe("getstatus");
    f.common.cvars.set("ui_findPlayer", "", true); await f.run(11); expect(f.status.serverStatusInfo.numLines).toBe(0);
    await f.run(5); expect(f.browser.getServerCount(ServerBrowserSource.Favorites)).toBe(0);
  } finally { await f.close(); }
});

test("script cursor preserves successful NULL allocation, integer raw reads, and PB no-op", async () => {
  const f = await fixture(["uiScript setPbClStatus nonsense; uiScript ServerSort 0;", "uiScript uniqueUnknown;",
    'uiScript voiceOrdersTeam "unpooled_order";', 'uiScript orders "unpooled_order";', "uiScript update unpooledSetting;"]);
  try {
    const before = f.memory.stringBytes; await f.run(0);
    expect(f.memory.stringBytes - before).toBe("uiScript".length + 1 + "setPbClStatus".length + 1 + "ServerSort".length + 1 + 2);
    expect(f.servers.sortDir).toBe(1); expect(f.common.commands.pendingText).toBe("");
    for (const token of ["uiScript", ";", "voiceOrdersTeam", "orders", "update"]) f.memory.stringAlloc(token);
    f.memory.stringAlloc("X".repeat(384 * 1024 - f.memory.stringBytes - 2));
    await f.run(1); expect(f.printed).toContain("unknown UI script (null)\n");
    f.common.cvars.set("cg_selectedPlayer", "0", true); f.keys.setCatcher(KeyCatcher.Ui);
    await f.run(2); expect(f.common.commands.pendingText).toBe("\n"); expect(f.keys.getCatcher()).toBe(0);
    f.players.myTeamCount = 1; f.keys.setCatcher(KeyCatcher.Ui);
    await expect(f.run(3)).rejects.toThrow("strcpy with a NULL"); expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui);
    await expect(f.run(4)).rejects.toThrow("NULL String_Parse name");
  } finally { await f.close(); }
});

test("EXEC_NOW Quit awaits the common async command then detects retired UI before later script", async () => {
  const f = await fixture(["uiScript Quit; setcvar after_quit yes;"]);
  try {
    const entered = deferred(), release = deferred();
    f.common.commands.registerAsync("quit", async () => { entered.resolve(); await release.promise; f.retire(); });
    f.common.commands.append("wait 9\n");
    const operation = f.run(0); await entered.promise;
    expect(f.common.cvars.get("ui_singlePlayerActive")?.value).toBe("0");
    expect(f.common.cvars.get("after_quit")).toBeUndefined(); expect(f.common.commands.pendingText).toBe("wait 9\n");
    release.resolve(); await expect(operation).rejects.toThrow("retired Team Arena menu-script");
    expect(f.common.cvars.get("after_quit")).toBeUndefined();
  } finally { await f.close(); }
});

test("content scripts call real metadata, common lists and scores, and stop the actual preview movie", async () => {
  const f = await fixture(["uiScript loadGameInfo; uiScript loadArenas; uiScript LoadDemos; uiScript LoadMovies; uiScript LoadMods;",
    "uiScript playMovie;", "uiScript RunDemo;", "uiScript RunMod;", "uiScript Quake3;", "uiScript resetScores;",
    "uiScript RefreshServers;", "uiScript addFavorite;"]);
  try {
    f.common.cvars.set("protocol", "68", true);
    const file = f.common.files.writable.openBinaryWrite("demos/generated.dm_68");
    if (file === null) throw new Error("Missing fresh-home demo handle");
    try { file.writeBytes(new Uint8Array([255, 255, 255, 255])); } finally { file.close(); }
    await f.run(0);
    expect(f.game.mapCount).toBeGreaterThan(20); expect(f.lists.movieCount).toBeGreaterThan(10);
    expect(f.lists.demoList).toContain("GENERATED"); expect(f.lists.modCount).toBeGreaterThanOrEqual(1);
    expect(f.cvars.get("ui_currentNetMap").integerValue).toBeGreaterThanOrEqual(0);
    f.interaction.demoIndex = f.lists.demoList.indexOf("GENERATED"); await f.run(2);
    expect(f.common.commands.pendingText).toBe("demo GENERATED\n");
    f.interaction.movieIndex = f.lists.movieList.indexOf("MPTEAM1"); expect(f.interaction.movieIndex).toBeGreaterThanOrEqual(0);
    f.interaction.previewMovie = await f.cinematics.play("mpteam1.roq", { x: 0, y: 0, width: 0, height: 0 });
    const handle = f.movies.handleAtSlot(f.interaction.previewMovie); if (handle === undefined) throw new Error("Missing preview movie handle");
    f.cinematics.run(f.interaction.previewMovie); f.setTime(134); f.cinematics.run(f.interaction.previewMovie);
    const retained = f.interaction.previewMovie; await f.run(1);
    expect(f.movies.run(handle)).toBe(CinematicStatus.Idle); expect(f.interaction.previewMovie).toBe(retained);
    expect(f.common.commands.pendingText.endsWith("cinematic MPTEAM1.roq 2\n")).toBe(true);
    f.interaction.modIndex = 0; infoSlot(f.lists.modList, 0).modName = "generated_mod"; await f.run(3);
    expect(f.common.cvars.get("fs_game")?.value).toBe("generated_mod"); expect(f.common.commands.pendingText.endsWith("vid_restart;")).toBe(true);
    await f.run(4); expect(f.common.cvars.get("fs_game")?.value).toBe("");
    const score = new PostGameInfo(); score.score = 321; f.scores.writeRecord("games/generated_reset.game", score); await f.run(5);
    expect(f.scores.readRecord("games/generated_reset.game").score).toBe(0);
    await f.browser.addServer(ServerBrowserSource.Global, "Generated Host", "127.0.0.1:27999");
    f.cvars.writeInteger("ui_netSource", ServerBrowserSource.Global); f.servers.displayServers[0] = 0; f.servers.currentServer = 0;
    await f.run(7); expect(f.browser.getServerCount(ServerBrowserSource.Favorites)).toBe(1);
    f.cvars.writeInteger("ui_netSource", ServerBrowserSource.Favorites); await f.run(6);
    expect(f.servers.refreshActive).toBe(true); expect(f.servers.refreshtime).toBe(134);
  } finally { await f.close(); }
});
