import { HunkArena } from "../src/core/hunk.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BotMemory } from "../src/botlib/memory.ts";
import { BotScriptSources } from "../src/botlib/script-sources.ts";
import { ScriptGlobalDefines } from "../src/script/preprocessor.ts";
import { CommonParseState } from "../src/core/common-parse.ts";
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
import { decodeConnectionless, encodeConnectionlessText } from "../src/protocol/connectionless.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { ServerMessageContext, ServerOperation } from "../src/protocol/server-message.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
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
import { TeamArenaUiMemory } from "../src/ui/team-arena/memory.ts";
import { TeamArenaUiMenuLoader } from "../src/ui/team-arena/menu-loader.ts";
import { TeamArenaModels } from "../src/ui/team-arena/models.ts";
import { TeamArenaPlayerList } from "../src/ui/team-arena/player-list.ts";
import { TeamArenaUiResources } from "../src/ui/team-arena/resources.ts";
import { PostGameInfo, TeamArenaScores } from "../src/ui/team-arena/scores.ts";
import { TeamArenaSelection } from "../src/ui/team-arena/selection.ts";
import { TeamArenaServerBrowser } from "../src/ui/team-arena/server-browser.ts";
import { TeamArenaServerStatus } from "../src/ui/team-arena/server-status.ts";
import { TeamArenaTeamInfo } from "../src/ui/team-arena/team-info.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";
import { deferred } from "./base-ui-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

function socket(io: UnixIo) { if (io.udp === null) throw new Error("Missing fixture UDP socket"); return io.udp; }
async function packet(io: UnixIo) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    io.pollPacketEvent(); const event = io.takeQueuedEvent();
    if (event !== null) { if (event.kind !== "packet") throw new Error("Expected actual packet"); return event; }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for localhost packet");
}

async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "q3-team-feeders-")), printed: string[] = [], clock = new UnixSystemClock();
  const print = (text: string): undefined => { printed.push(text); };
  let active = true, commonOpen = true, time = 0, clientReads = 0;
  const current = (): undefined => { if (!active) throw new Error("retired Team Arena feeder"); };
  const commonCurrent = (): undefined => { if (!commonOpen) throw new Error("closed common fixture"); };
  const unexpected = (): never => { throw new Error("Feeder fixture reached unrelated gameplay/ownerdraw"); };
  const common = await CommonConsole.open({ roots: { dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a",
    homePath, cdPath: null, product: "missionpack" }, startup: new StartupCommands("+set s_initsound 0"),
    random: new LinuxNativeRandom(1), build: { kind: "dedicated" }, platformPrint: print, resolveCommand: () => undefined,
    assertCommandEntry: commonCurrent, assertOwnerEntry: commonCurrent }, commonCurrent);
  const events = new CommonEvents({ getEvent: () => ({ kind: "none", time }) }, print), sound = new EngineSound(common, events);
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(320, 240, images), target = new RenderTarget(images, [cpu]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), files = common.files.current;
  const movies = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: text => { const developer = common.cvars.get("developer"); if (developer !== undefined && developer.integerValue !== 0) common.output.print(text); return undefined; }, print: text => { common.output.print(text); return undefined; }, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => sound.mixer }, clock: { sample: () => time },
    scratchImages: builtins, console: { kind: "absent" }, settings: { hardware: "generic", maxTextureSize: 4096, inGameVideo: () => 1 } });
  const ios: UnixIo[] = [], streams: PassThrough[] = [], lifecycle = new ProtocolClientLifecycle(common.cvars);
  let runtime: UiRuntime | undefined, commands: RenderCommandBuffer | undefined, assets: TeamArenaUiResources | undefined;
  const close = async (): Promise<void> => {
    runtime?.dispose(); assets?.dispose(); commands?.close("discard"); target.close(); movies.dispose(); lifecycle.close();
    for (const io of ios) io.close(); for (const stream of streams) stream.destroy();
    sound.close(); common.close(); commonOpen = false; await rm(homePath, { recursive: true, force: true });
  };
  try {
    const settings = createRendererSettings(), renderer = await RendererResources.create(files, { kind: "unaccounted" }, settings,
      { patchMemory: { kind: "source-zone", zone: common.mainZone }, print, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: movies.shaderCinematics });
    commands = new RenderCommandBuffer(target, { print: (text: string) => { common.output.print(text); }, clock, identityLight: 1, tess: renderer.tess, runtime: settings.runtime });
    const cvars = new TeamArenaUiCvars(common.cvars, current), cinematicInterface = new EngineUiCinematics(movies, "ui");
    assets = new TeamArenaUiResources({ renderer, sound, cinematics: cinematicInterface,
      fontRegistry: new UiAssetRegistry(renderer, print), cvars, assertCurrentOperation: current });
    sound.initialize({ sampleRate: 48000 }); await sound.beginRegistration();
    await assets.initializeDisplayAssets(); await assets.assetCache();
    const memory = new TeamArenaUiMemory("qvm32", print), parser = new CommonParseState();
    const info = { menuBuffer: new TeamArenaMenuBuffer(common.files, print, current), sourceParser: parser, memory,
      resources: renderer, print, assertActive: current };
    const game = new TeamArenaGameInfo(info), teams = new TeamArenaTeamInfo(info);
    const selection = new TeamArenaSelection(game, teams, cvars, common.files, print, current);
    const models = new TeamArenaModels(common.files, renderer, print, current);
    const lists = new TeamArenaLists({ files: common.files, cvars: common.cvars, memory, assertActive: current });
    const scores = new TeamArenaScores({ files: common.files, cvars: common.cvars, print, assertActive: current });
    const players = new TeamArenaPlayerList(common.cvars, current), interaction = new TeamArenaUiInteractionState();
    const session = new EngineClientSession({ product: "missionpack", cvars: common.cvars, lifecycle, mode: { kind: "network", challenge: 1, qport: 27961 } });
    const keys = new ClientKeys({ commands: common.commands, cvars: common.cvars, print, host: {
      assertCurrentOperation: current, readConnection: () => ({ kind: "disconnected", demoPlayback: false }), readUi: () => null,
      readCgame: () => null, disconnect: unexpected, stopAllSounds: () => { sound.stopAllSounds(); }, addReliableCommand: unexpected,
      toggleConsole: unexpected, updateScreen: unexpected, consoleScroll: unexpected, readConsoleWidth: () => 78,
      clipboard: { kind: "native-unix-unavailable" } } });
    let feeders: TeamArenaFeeders | undefined;
    const readFeeders = (): TeamArenaFeeders => { if (feeders === undefined) throw new Error("UI feeder requested before composition"); return feeders; };
    const definitions = await loadMenuDefinitions({ random: { nextInt: () => 0 }, resolver: { resolveRoot: unexpected, resolve: unexpected } },
      { kind: "ui", setPaths: [] }, {}, { memory: { kind: "qvm32", memory } });
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
      ownerDraw: { visible: unexpected, width: unexpected, value: unexpected, handleKey: unexpected, paint: unexpected, closeCinematic: unexpected } });
    common.cvars.register("net_ip", "127.0.0.1"); common.cvars.register("net_port", "0");
    common.cvars.register("cl_serverStatusResendTime", "750");
    const network = async (): Promise<UnixIo> => {
      const stdin = new PassThrough(), io = new UnixIo(print, clock, { stdin, signals: "none" });
      streams.push(stdin); ios.push(io); await io.initializeNetwork(common.cvars); return io;
    };
    const io = await network(), cls = new ClientStaticState(), loopback = new LoopbackTransport();
    const browser = new ServerBrowser({ io, cvars: common.cvars, clientStatic: cls, loopback, print, assertCurrentOperation: current });
    const servers = new TeamArenaServerBrowser({ browser, cvars, gameInfo: game, runtime, commands: common.commands, calendar: clock, print, assertActive: current });
    const status = new TeamArenaServerStatus({ browser, cvars, display: servers, runtime, clock: events, print, assertActive: current });
    const cinematics = new TeamArenaUiCinematics({ cinematics: cinematicInterface, game, teams, selection, cvars, servers, assertActive: current });
    feeders = new TeamArenaFeeders({ cvars, game, teams, selection, lists, models, scores, players, browser, servers, status, cinematics,
      renderer, interaction, readClient: () => { clientReads++; return session; }, readRealTime: () => time, print, assertActive: current });
    const write = (path: string, text: string): void => {
      const file = common.files.writable.openBinaryWrite(path); if (file === null) throw new Error("Cannot write generated fixture data");
      try { file.writeBytes(new TextEncoder().encode(text)); } finally { file.close(); }
    };
    const scriptMemory = new BotMemory(undefined, common.mainZone);
    const sourceOwner = new BotScriptSources(common.files.current, new ScriptGlobalDefines(undefined, scriptMemory),
      (_severity, text) => { common.output.print(text); }, text => { common.output.print(text); return undefined; }, scriptMemory);
    const loader = new TeamArenaUiMenuLoader({ scriptSources: () => sourceOwner, memory, resources: assets, cvars, runtime,
      random: { nextInt: () => 0 }, systemClock: clock, print, error: text => { throw new Error(text); }, assertCurrentOperation: current });
    write("ui/feeder-test.txt", 'loadMenu { "ui/feeder-test.menu" }');
    write("ui/feeder-test.menu", `assetGlobalDef { font "fonts/font" 16 smallFont "fonts/font" 16 bigFont "fonts/font" 16 }
      ${[0, 1, 2, 4, 7, 8, 9, 10, 12, 13, 14, 15].map(id => `menuDef { name "feed-${id}" rect 0 0 640 480
        itemDef { name rows type 6 feeder ${id} rect 20 20 550 180 elementwidth 120 elementheight 24
          ${id === 13 ? "columns 4 0 30 8 35 70 12 110 70 12 185 320 40" : ""}
          textscale .3 forecolor 1 1 1 1 visible 1 }
        ${id === 14 ? "itemDef { name status type 6 feeder 13 rect 20 230 550 180 elementheight 24 visible 1 }" : ""} }`).join("\n")}
      menuDef { name "head-images" rect 0 0 640 480 itemDef { name images type 6 feeder 0 rect 20 20 500 140
        elementwidth 100 elementheight 100 elementtype 1 visible 1 } }`);
    await loader.load("ui/feeder-test.txt", true);
    expect(runtime.menuCount()).toBe(13);
    const loadRetail = async (): Promise<void> => { await game.parseGameInfo("gameinfo.txt"); await teams.parseTeamInfo("teaminfo.txt"); };
    let messageNumber = 0;
    const send = async (operations: readonly ServerOperation[]): Promise<void> => {
      const context: ServerMessageContext = { product: "missionpack", messageNumber: ++messageNumber, reliableSequence: 0,
        serverCommandSequence: 0, parseEntitiesNumber: 0, baseline: () => null, history: () => null };
      await session.receiveServerMessage(messageNumber, encodeServerMessage(0, operations, context));
    };
    const loadPlayers = async (): Promise<void> => {
      await send([{ kind: "gamestate", commandSequence: 0, clientNumber: 7, checksumFeed: 19, entries: [
        { kind: "configstring", index: 0, value: "\\sv_maxclients\\3" },
        { kind: "configstring", index: 1, value: "\\sv_serverid\\100\\sv_cheats\\1\\fs_game\\missionpack" },
        { kind: "configstring", index: 544, value: "\\n\\^1Alpha\\t\\1" },
        { kind: "configstring", index: 545, value: "\\n\\^2Other\\t\\2" },
        { kind: "configstring", index: 546, value: "\\n\\^3Self\\t\\1\\tl\\0" },
      ] }]);
      const playerState = new PlayerState("missionpack"); playerState.clientNum = 2;
      await send([{ kind: "snapshot", validity: { kind: "valid" }, snapshot: { messageNumber: messageNumber + 1,
        serverTime: 100, deltaNumber: -1, flags: 0, serverCommandNumber: 0, parseEntitiesNumber: 0,
        areaMask: new Uint8Array(), playerState, entities: [] } }]);
    };
    common.commands.registerAsync("ping", context => browser.pingCommand(context));
    const addServer = async (name: string, map = "mpteam1", source = ServerBrowserSource.Favorites, netType = 1) => {
      const peer = await network(), remote = socket(peer).address, address = `${remote.host.join(".")}:${remote.port}`;
      await browser.addServer(source, name, address); cls.realtime += 100;
      await common.commands.executeNowAsync(`ping ${address}`);
      const request = await packet(peer); expect(decodeConnectionless(request.payload, "server").line).toBe("getinfo xxx");
      cls.realtime += 9;
      socket(peer).send(request.from, encodeConnectionlessText(`infoResponse\n\\protocol\\68\\hostname\\${name}\\mapname\\${map}\\clients\\2\\sv_maxclients\\8\\gametype\\4\\game\\missionpack\\nettype\\${netType}\\punkbuster\\1`));
      const response = await packet(io); browser.handleConnectionless(response.from, decodeConnectionless(response.payload, "client"), response.payload);
      browser.clearPing(0); servers.displayServers[servers.numDisplayServers] = browser.getServerCount(source) - 1; servers.numDisplayServers++;
      return { peer, address };
    };
    const replyStatus = async (peer: UnixIo, text: string): Promise<void> => {
      const request = await packet(peer); expect(decodeConnectionless(request.payload, "server").line).toBe("getstatus");
      socket(peer).send(request.from, encodeConnectionlessText(`statusResponse\n${text}`));
      const response = await packet(io); browser.serverStatusResponse(response.from, decodeConnectionless(response.payload, "client").payload, events);
    };
    return { feeders, interaction, cvars, common, game, teams, selection, lists, models, scores, players, browser, servers, status,
      cinematics, movies, renderer, runtime, commands, cpu, memory, parser, printed, session, loadRetail, loadPlayers, addServer, replyStatus,
      write, clientReads: () => clientReads, setTime: (value: number): void => { time = value; }, retire: (): void => { active = false; }, close };
  } catch (error) { await close(); throw error; }
}

test("retail metadata feeds real CPU lists and preserves null text, default pictures and source active selection", async () => {
  const f = await fixture();
  try {
    expect(f.interaction).toEqual({ playerRefresh: 0, playerIndex: 0, teamIndex: 0, modIndex: 0, movieIndex: 0, demoIndex: 0,
      previewMovie: 0, effectsColor: 0, botIndex: 0, skillIndex: 0, redBlue: 0, currentCrosshair: 0,
      updateModel: true, updateOpponentModel: true });
    expect(f.servers.currentServerPreview).toBeNull();
    await f.loadRetail(); await f.models.buildList(); f.lists.loadMovies();
    expect(f.feeders.count(0)).toBeGreaterThan(0); expect(f.feeders.count(1)).toBeGreaterThan(0);
    expect(f.feeders.count(12)).toBe(f.models.headCount); expect(f.feeders.count(15)).toBe(f.lists.movieCount);
    expect(f.feeders.count(999)).toBe(0); expect(f.feeders.count(.5)).toBe(0);
    const firstHead = f.selection.selectedHead(0), row = infoSlot(f.teams.characterList, firstHead.actual);
    expect((await f.feeders.item(0, 0, 0)).text).toBe(firstHead.name);
    expect(row.headImage.kind).toBe("unregistered");
    const icon = await f.feeders.image(0, 0);
    expect(icon).not.toBe(f.renderer.picture(null)); expect(row.headImage.kind).toBe("registered");
    expect(await f.feeders.image(0, 999)).toBe(await f.feeders.image(0, -1)); // Both miss to actual row zero.
    expect(await f.feeders.image(99, 0)).toBe(f.renderer.picture(null));
    expect(await f.feeders.image(12, 0)).toBe(f.renderer.picture(infoSlot(f.models.heads, 0).icon));
    row.name = null; expect(await f.feeders.item(0, 0, 0)).toEqual({ text: null, picture: undefined });
    row.name = firstHead.name;
    f.lists.modCount = 1; expect((await f.feeders.item(9, 0, 0)).text).toBeNull();
    const mod = infoSlot(f.lists.modList, 0); mod.modName = "fixture"; mod.modDescr = "";
    expect((await f.feeders.item(9, 0, 0)).text).toBe("fixture"); mod.modDescr = "Fixture Mod";
    expect((await f.feeders.item(9, 0, 0)).text).toBe("Fixture Mod");
    f.lists.demoCount = 1; expect((await f.feeders.item(10, 0, 0)).text).toBeNull();
    f.status.serverStatusInfo.numLines = 1; expect((await f.feeders.item(13, 0, 3)).text).toBeNull();
    expect((await f.feeders.item(13, 0, 4)).text).toBe(""); expect((await f.feeders.item(15, -1, 0)).text).toBe("");
    await f.runtime.activate("feed-0");
    await f.runtime.frame({ time: 1, frameTime: 1, draw: f.commands.draw2D("team-ui-640") });
    expect(f.commands.submit().batches).toBeGreaterThan(0);
    expect(f.cpu.pixels.some((value, index) => index % 4 !== 3 && value !== 0
      && Math.floor(index / 4) % 320 > 10 && Math.floor(index / 4) % 320 < 200)).toBe(true); // Excludes the scrollbar.
    await f.runtime.activate("head-images");
    await f.runtime.frame({ time: 2, frameTime: 1, draw: f.commands.draw2D("team-ui-640") });
    expect(f.commands.submit().batches).toBeGreaterThan(0);
    await f.runtime.activate("feed-13");
    await f.runtime.frame({ time: 3, frameTime: 1, draw: f.commands.draw2D("team-ui-640") }); f.commands.submit();
  } finally { await f.close(); }
});

test("map and head menu selections publish real scores, cvars and engine RoQ slots in source order", async () => {
  const f = await fixture();
  try {
    await f.loadRetail(); await f.models.buildList(); f.feeders.count(0); f.feeders.count(1);
    const selected = f.selection.selectedMap(0), map = infoSlot(f.game.mapList, selected.actual);
    const score = new PostGameInfo(); score.score = 321; score.time = 65;
    f.scores.writeRecord(f.scores.scorePath(map.mapLoadName, infoSlot(f.game.gameTypes, f.cvars.get("ui_gameType").integerValue).gtEnum), score);
    const writes: string[] = [], vmWrites: [string, number, number][] = [], set = f.common.cvars.set.bind(f.common.cvars);
    f.common.cvars.set = (name, value, force) => {
      writes.push(`${name}:${value}:${force}`);
      if (name === "ui_mapIndex" || name === "ui_currentMap") vmWrites.push([name, f.cvars.get("ui_mapIndex").integerValue, f.cvars.get("ui_currentMap").integerValue]);
      return set(name, value, force);
    };
    f.interaction.updateModel = false;
    await f.runtime.setFeederSelection(0, 0, "feed-0");
    const head = infoSlot(f.teams.characterList, f.selection.selectedHead(0).actual);
    expect(writes.slice(-2)).toEqual([`team_model:${head.base}:true`, `team_headmodel:*${head.name}:true`]);
    expect(f.interaction.updateModel).toBe(true); f.interaction.updateModel = false;
    await f.runtime.setFeederSelection(12, 0, "feed-12");
    expect(f.common.cvars.get("model")?.value).toBe(infoSlot(f.models.heads, 0).name);
    expect(f.common.cvars.get("headmodel")?.value).toBe(infoSlot(f.models.heads, 0).name); expect(f.interaction.updateModel).toBe(true);
    writes.length = 0; f.interaction.updateOpponentModel = false;
    f.cvars.writeInteger("ui_mapIndex", 7); f.cvars.writeInteger("ui_currentMap", 1);
    await f.runtime.setFeederSelection(1, 0, "feed-1");
    expect(writes.slice(0, 2)).toEqual(["ui_mapIndex:0:true", `ui_currentMap:${selected.actual}:true`]);
    expect(writes.at(-1)).toBe(`ui_opponentModel:${map.opponentName}:true`);
    expect(vmWrites).toEqual([["ui_mapIndex", 7, 1], ["ui_currentMap", 0, selected.actual]]);
    expect(f.cvars.get("ui_currentMap").integerValue).toBe(selected.actual); expect(f.cvars.get("ui_mapIndex").integerValue).toBe(0);
    expect(f.common.cvars.get("ui_scoreScore")?.value).toBe("321"); expect(f.common.cvars.get("ui_scoreTime")?.value).toBe("01:05");
    expect(f.interaction.updateOpponentModel).toBe(true); expect(map.cinematic).toBeGreaterThanOrEqual(0);
    const handle = f.movies.handleAtSlot(map.cinematic); if (handle === undefined) throw new Error("Missing actual preview slot");
    f.cinematics.run(map.cinematic); f.setTime(34); f.cinematics.run(map.cinematic);
    await f.runtime.setFeederSelection(15, 3, "feed-15");
    expect(f.interaction.movieIndex).toBe(3); expect(f.interaction.previewMovie).toBe(-1);
    f.interaction.previewMovie = map.cinematic;
    await f.runtime.setFeederSelection(15, 4, "feed-15"); expect(f.movies.run(handle)).toBe(CinematicStatus.Idle);
    f.interaction.updateOpponentModel = false; writes.length = 0; f.feeders.count(4);
    await f.runtime.setFeederSelection(4, 0, "feed-4");
    expect(writes.map(value => value.split(":")[0])).toEqual(["ui_mapIndex", "ui_currentNetMap"]);
    expect(f.interaction.updateOpponentModel).toBe(false);
    f.common.cvars.set("ui_opponentModel", "changed", true); map.opponentName = null; f.feeders.count(1);
    await f.runtime.setFeederSelection(1, 0, "feed-1");
    expect(f.common.cvars.get("ui_opponentModel")?.value).toBe(f.common.cvars.get("ui_opponentModel")?.resetValue);
  } finally { await f.close(); }
});

test("player and team feeders share strict refresh timing and the actual session snapshot", async () => {
  const f = await fixture();
  try {
    await f.loadPlayers(); expect(f.feeders.count(7)).toBe(0); expect(f.clientReads()).toBe(0);
    f.setTime(1); expect(f.feeders.count(7)).toBe(3); expect(f.feeders.count(8)).toBe(2);
    expect(f.interaction.playerRefresh).toBe(3001); expect(f.clientReads()).toBe(1);
    expect((await f.feeders.item(7, 0, 0)).text).toBe("Alpha"); expect((await f.feeders.item(8, 1, 0)).text).toBe("Self");
    expect(f.players.playerNumber).toBe(2); expect(f.common.cvars.get("cg_selectedPlayerName")?.value).toBe("Self");
    f.setTime(3001); f.feeders.count(8); expect(f.clientReads()).toBe(1);
    f.setTime(3002); f.feeders.count(8); expect(f.clientReads()).toBe(2);
    f.setTime(2147483640); f.feeders.count(7); expect(f.interaction.playerRefresh).toBe(-2147480656);
    for (const [id, index] of [[7, -3], [8, 99], [9, 8], [10, 10]]) {
      if (id === undefined || index === undefined) throw new Error("Invalid expected feeder pair");
      await f.runtime.setFeederSelection(id, index, `feed-${id}`);
    }
    expect([f.interaction.playerIndex, f.interaction.teamIndex, f.interaction.modIndex, f.interaction.demoIndex]).toEqual([-3, 99, 8, 10]);
  } finally { await f.close(); }
});

test("server text preserves the source column-only cache and selected preview uses real UDP metadata", async () => {
  const f = await fixture();
  try {
    f.common.cvars.set("ui_netSource", "3", true); f.cvars.update();
    const first = await f.addServer("First", "mpteam1"), second = await f.addServer("Second", "mpteam2");
    f.setTime(100);
    expect((await f.feeders.item(2, 0, -1)).text).toBe(""); // Initial -1 column does not populate the BSS cache.
    expect((await f.feeders.item(2, 0, 0)).text).toBe("First");
    expect((await f.feeders.item(2, 1, 0)).text).toBe("First");
    f.setTime(10000); expect((await f.feeders.item(2, 1, 0)).text).toBe("First");
    expect((await f.feeders.item(2, 1, 1)).text).toBe("mpteam2");
    expect((await f.feeders.item(2, 1, 0)).text).toBe("Second");
    f.setTime(0); expect((await f.feeders.item(2, 0, 0)).text).toBe("First"); // Backwards source deadline condition.
    expect((await f.feeders.item(2, 0, 2)).text).toBe("2 (8)");
    expect((await f.feeders.item(2, 0, 3)).text).toBe("CTF");
    expect((await f.feeders.item(2, 0, 4)).text).toBe("10"); expect((await f.feeders.item(2, 0, 5)).text).toBe("Yes");
    await f.runtime.setFeederSelection(2, 1, "feed-2");
    expect(f.servers.currentServer).toBe(1); expect(f.servers.currentServerPreview).toBe(await f.renderer.registerShaderNoMip("levelshots/mpteam2"));
    expect(f.servers.currentServerCinematic).toBeGreaterThanOrEqual(0);
    f.cinematics.run(f.servers.currentServerCinematic); f.setTime(34); f.cinematics.run(f.servers.currentServerCinematic);
    const old = f.movies.handleAtSlot(f.servers.currentServerCinematic); if (old === undefined) throw new Error("Missing server movie");
    const empty = await f.addServer("Empty", ""); await f.runtime.setFeederSelection(2, 2, "feed-2");
    expect(f.servers.currentServerPreview).toBeNull(); expect(f.servers.currentServerCinematic).toBe(-1); expect(f.movies.run(old)).toBe(CinematicStatus.Idle);
    f.status.numFoundPlayerServers = 2; f.status.foundPlayerServerAddresses[0] = first.address; f.status.foundPlayerServerNames[0] = "First";
    await f.runtime.activate("feed-14"); await f.runtime.setFeederSelection(14, 0);
    expect(f.status.serverStatusAddress).toBe(first.address); expect(f.status.nextServerStatusRefresh).toBe(534);
    await f.replyStatus(first.peer, '\\sv_hostname\\First\n10 20 "Alice"\n');
    f.setTime(534); await f.status.buildServerStatus(false, 534);
    expect((await f.feeders.item(13, 0, 3)).text).toBe("First"); expect((await f.feeders.item(14, 0, 0)).text).toBe("First");
    await f.runtime.frame({ time: 534, frameTime: 500, draw: f.commands.draw2D("team-ui-640") }); expect(f.commands.submit().batches).toBeGreaterThan(0);
    expect(second.address).not.toBe(empty.address);
  } finally { await f.close(); }
});

test("local server network-name bounds, pending ping text and catalog shader failures stay source-shaped", async () => {
  const f = await fixture();
  try {
    await f.addServer("Local", "mpteam1", ServerBrowserSource.Local, 3);
    expect((await f.feeders.item(2, 0, 0)).text).toBe("Local [(null)]");
    await f.addServer("Bad network", "mpteam1", ServerBrowserSource.Local, 4);
    await f.feeders.item(2, 1, 1);
    await expect(f.feeders.item(2, 1, 0)).rejects.toThrow("source 4-entry array");
    await f.browser.addServer(ServerBrowserSource.Local, "Unpinged", "127.0.0.1:1");
    f.servers.displayServers[2] = 2; f.servers.numDisplayServers = 3;
    expect((await f.feeders.item(2, 2, 4)).text).toBe("..."); expect((await f.feeders.item(2, 2, 0)).text).toBe("127.0.0.1:1");
    const catalog = new TeamArenaCatalog({ files: f.common.files, cvars: f.common.cvars, gameInfo: f.game,
      sourceParser: f.parser, memory: f.memory, print: text => { f.printed.push(text); }, assertActive: () => undefined });
    catalog.loadArenas(); infoSlot(f.game.gameTypes, 0).gtEnum = 0; f.cvars.writeInteger("ui_netGameType", 0);
    expect(f.feeders.count(4)).toBeGreaterThan(0);
    const map = infoSlot(f.game.mapList, f.selection.selectedMap(0).actual); expect(map.levelShot.kind).toBe("unregistered");
    map.imageName = "missing-feeder-image";
    expect(await f.feeders.image(4, 0)).toBe(f.renderer.picture(null)); expect(map.levelShot).toEqual({ kind: "registered", shader: null });
    map.imageName = "levelshots/mpteam1"; expect(await f.feeders.image(4, 0)).toBe(f.renderer.picture(null));
    map.levelShot = { kind: "unregistered" }; map.imageName = null;
    const register = f.renderer.registerShaderNoMip.bind(f.renderer), reached: (string | null)[] = [];
    f.renderer.registerShaderNoMip = async name => { reached.push(name); return register(name); };
    await expect(f.feeders.image(4, 0)).rejects.toThrow("RE_RegisterShaderNoMip: undefined source NULL name read");
    expect(reached).toEqual([null]); expect(map.levelShot.kind).toBe("unregistered");
    await f.loadRetail(); f.feeders.count(0); reached.length = 0;
    const head = infoSlot(f.teams.characterList, f.selection.selectedHead(0).actual);
    head.headImage = { kind: "unregistered" }; head.imageName = null;
    await expect(f.feeders.image(0, 0)).rejects.toThrow("RE_RegisterShaderNoMip: undefined source NULL name read");
    expect(reached).toEqual([null]); expect(head.headImage.kind).toBe("unregistered");
    await expect(f.feeders.select(2, -1)).rejects.toThrow("displayServers[2048]"); expect(f.servers.currentServer).toBe(-1);
    f.cvars.writeInteger("ui_currentMap", 128);
    await expect(f.feeders.select(1, 0)).rejects.toThrow("source 128-entry array");
  } finally { await f.close(); }
});

test("actual shader preparation retirement leaves source selection writes but no preview publication", async () => {
  const f = await fixture(), gate = deferred();
  try {
    f.common.cvars.set("ui_netSource", "3", true); f.cvars.update(); await f.addServer("Pending");
    const register = f.renderer.registerShaderNoMip.bind(f.renderer);
    f.renderer.registerShaderNoMip = async name => { await gate.promise; return await register(name); };
    const pending = f.runtime.setFeederSelection(2, 0, "feed-2");
    expect(f.servers.currentServer).toBe(0); f.retire(); gate.resolve();
    await expect(pending).rejects.toThrow("retired Team Arena feeder");
    expect(f.servers.currentServerPreview).toBeNull(); expect(f.servers.currentServerCinematic).toBe(0);
  } finally { gate.resolve(); await f.close(); }
});
