// Team Arena UI lifetime, _UI_Init and callable helpers from code/ui/ui_main.c and ui_atoms.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CommonError } from "../../core/common-error.ts";
import type { BotScriptSources } from "../../botlib/script-sources.ts";
import { CommonParseState } from "../../core/common-parse.ts";
import type { CommandContext } from "../../core/commands.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { sourceCommandText } from "../../core/text.ts";
import { isPrereleaseTeamArenaDemo, RETAIL_PRODUCT_PROFILE } from "../../core/product-profile.ts";
import type { ProductProfile } from "../../core/product-profile.ts";
import { keynumToString } from "../../engine/client-keys.ts";
import type { ClientKeys } from "../../engine/client-keys.ts";
import type { EngineClientSession } from "../../engine/client-session.ts";
import type { ClientConnectionState, ClientStaticState } from "../../engine/client-state.ts";
import type { CommonConsole } from "../../engine/common-console.ts";
import type { CommonEvents } from "../../engine/common-events.ts";
import type { ServerBrowser } from "../../engine/server-browser.ts";
import type { EngineSound } from "../../engine/sound.ts";
import type { EngineUiCinematics } from "../../engine/ui-cinematics.ts";
import { EngineUiModelPainter } from "../../engine/ui-model.ts";
import { GameRandom } from "../../game/numeric.ts";
import type { LocalCalendar, SystemClock } from "../../platform/system-clock.ts";
import type { RenderCommandBuffer } from "../../render/commands.ts";
import type { PictureAsset } from "../../render/draw2d.ts";
import type { RendererConfiguration, RendererConfigurationSnapshot } from "../../render/configuration.ts";
import { UiAssetRegistry } from "../../render/font.ts";
import type { RendererResources } from "../../render/world.ts";
import type { VmRegistration } from "../../vm/registry.ts";
import type { UiMenuDefinitions } from "../menu.ts";
import { UiMenuCommand } from "../public.ts";
import { UiRuntime } from "../runtime.ts";
import type { UiRuntimeAudio } from "../runtime.ts";
import { TeamArenaCatalog } from "./catalog.ts";
import { TeamArenaUiCinematics } from "./cinematics.ts";
import { TeamArenaConnectScreen } from "./connect-screen.ts";
import { TeamArenaConsoleCommands } from "./console-commands.ts";
import { TeamArenaUiCvars } from "./cvars.ts";
import { TeamArenaFeeders } from "./feeders.ts";
import { infoSlot, TeamArenaGameInfo, TeamArenaMenuBuffer } from "./game-info.ts";
import { TeamArenaUiInteractionState } from "./interaction-state.ts";
import { TeamArenaLists } from "./lists.ts";
import { TeamArenaUiMemory } from "./memory.ts";
import { TeamArenaMenuController } from "./menu-controller.ts";
import { TeamArenaUiMenuLoader } from "./menu-loader.ts";
import { TeamArenaMenuScripts } from "./menu-scripts.ts";
import { TeamArenaModels } from "./models.ts";
import { TeamArenaOwnerDraw } from "./owner-draw.ts";
import { TeamArenaOwnerKeys } from "./owner-keys.ts";
import { TeamArenaPlayerList } from "./player-list.ts";
import { TeamArenaUiPlayers } from "./players.ts";
import { TeamArenaPostGame } from "./postgame.ts";
import { TeamArenaUiRefresh } from "./refresh.ts";
import { TeamArenaUiResources } from "./resources.ts";
import { TeamArenaScores } from "./scores.ts";
import { TeamArenaSelection } from "./selection.ts";
import { TeamArenaServerBrowser } from "./server-browser.ts";
import { TeamArenaServerStatus } from "./server-status.ts";
import { TeamArenaSettings } from "./settings.ts";
import { TeamArenaTeamInfo } from "./team-info.ts";
import { TeamArenaVisibility } from "./visibility.ts";

export function clampTeamArenaUiCvar(minimum: number, maximum: number, value: number): number {
  const min = Math.fround(minimum), max = Math.fround(maximum), current = Math.fround(value);
  if (current < min) return min;
  if (current > max) return max;
  return current;
}

/** UI_OwnerDraw_Width, compiled only by code/ui's !MISSIONPACK profile. */
export function nonMissionpackOwnerDrawWidth(_ownerDraw: number): number { return 0; }

export interface TeamArenaUiOptions {
  readonly productProfile?: ProductProfile;
  readonly common: CommonConsole;
  readonly keys: ClientKeys;
  readonly browser: ServerBrowser;
  readonly events: CommonEvents;
  readonly systemClock: SystemClock;
  readonly calendar: LocalCalendar;
  readonly configuration: RendererConfiguration;
  readonly renderer: RendererResources;
  readonly commands: RenderCommandBuffer;
  readonly sound: EngineSound;
  readonly audio: UiRuntimeAudio;
  readonly cinematics: EngineUiCinematics;
  scriptSources(): BotScriptSources;
  readClient(): Parameters<TeamArenaPlayerList["build"]>[0];
  readSession(): EngineClientSession | null;
  readRealTime(): number;
  assertCurrentOperation(): void;
}

class TeamArenaUiDisplay {
  readonly gameInfo: TeamArenaGameInfo;
  readonly teams: TeamArenaTeamInfo;
  readonly catalog: TeamArenaCatalog;
  readonly selection: TeamArenaSelection;
  readonly models: TeamArenaModels;
  readonly lists: TeamArenaLists;
  readonly scores: TeamArenaScores;
  readonly playerList: TeamArenaPlayerList;
  readonly interaction = new TeamArenaUiInteractionState();
  readonly menus: TeamArenaMenuController;
  readonly servers: TeamArenaServerBrowser;
  readonly status: TeamArenaServerStatus;
  readonly cinematics: TeamArenaUiCinematics;
  readonly feeders: TeamArenaFeeders;
  readonly settings: TeamArenaSettings;
  readonly ownerKeys: TeamArenaOwnerKeys;
  readonly scripts: TeamArenaMenuScripts;
  readonly ownerDraw: TeamArenaOwnerDraw;
  readonly visibility: TeamArenaVisibility;
  readonly refresher: TeamArenaUiRefresh;
  readonly loader: TeamArenaUiMenuLoader;
  readonly consoleCommands: TeamArenaConsoleCommands;
  readonly connectScreen: TeamArenaConnectScreen;
  constructor(options: TeamArenaUiOptions, readonly cvars: TeamArenaUiCvars,
    readonly memory: TeamArenaUiMemory, readonly resources: TeamArenaUiResources, readonly runtime: UiRuntime,
    readonly configuration: RendererConfigurationSnapshot, sourceParser: CommonParseState, current: () => void, usesUniqueKey: () => number) {
    const { common, renderer, sound, browser, keys } = options;
    const print = (text: string): void => { common.output.print(text); current(); };
    const random = new GameRandom();
    const info = { menuBuffer: new TeamArenaMenuBuffer(common.files, print, current), sourceParser, memory,
      resources: renderer, print, assertActive: current };
    this.gameInfo = new TeamArenaGameInfo(info); this.teams = new TeamArenaTeamInfo(info);
    const game = this.gameInfo, teams = this.teams, interaction = this.interaction;
    this.catalog = new TeamArenaCatalog({ ...info, files: common.files, cvars: common.cvars, gameInfo: game });
    this.selection = new TeamArenaSelection(game, teams, cvars, common.files, print, current);
    this.models = new TeamArenaModels(common.files, renderer, print, current);
    this.lists = new TeamArenaLists({ files: common.files, cvars: common.cvars, memory, assertActive: current });
    this.scores = new TeamArenaScores({ files: common.files, cvars: common.cvars, print, assertActive: current });
    this.playerList = new TeamArenaPlayerList(common.cvars, current);
    const readClient = (): Parameters<TeamArenaPlayerList["build"]>[0] => { current(); return options.readClient(); };
    const readRealTime = (): number => { current(); return this.refresher.realTime; };
    const display = this;
    this.menus = new TeamArenaMenuController({ runtime, keys, cvars, players: this.playerList,
      get loader() { return display.loader; }, readClient, assertActive: current });
    this.servers = new TeamArenaServerBrowser({ browser, cvars, gameInfo: game, runtime, commands: common.commands,
      calendar: options.calendar, print, assertActive: current });
    this.status = new TeamArenaServerStatus({ browser, cvars, display: this.servers, runtime, clock: options.events, print, assertActive: current });
    this.cinematics = new TeamArenaUiCinematics({ cinematics: options.cinematics, game, teams, selection: this.selection,
      cvars, servers: this.servers, assertActive: current });
    this.feeders = new TeamArenaFeeders({ cvars, game, teams, selection: this.selection, lists: this.lists, models: this.models,
      scores: this.scores, players: this.playerList, browser, servers: this.servers, status: this.status,
      cinematics: this.cinematics, renderer, interaction, readClient, readRealTime, print, assertActive: current });
    this.settings = new TeamArenaSettings(cvars, game, current);
    this.ownerKeys = new TeamArenaOwnerKeys({ cvars, game, teams, selection: this.selection, feeders: this.feeders,
      settings: this.settings, scores: this.scores, players: this.playerList, catalog: this.catalog, servers: this.servers,
      cinematics: this.cinematics, runtime, interaction, readClient, readRealTime, assertActive: current });
    this.scripts = new TeamArenaMenuScripts({ productProfile: options.productProfile ?? RETAIL_PRODUCT_PROFILE,
      cvars, commands: common.commands, keys, cdKey: common.cdKey, usesUniqueKey, game, teams,
      catalog: this.catalog, selection: this.selection, lists: this.lists, scores: this.scores, players: this.playerList,
      feeders: this.feeders, browser, servers: this.servers, status: this.status, cinematics: this.cinematics,
      settings: this.settings, ownerKeys: this.ownerKeys, runtime, interaction, readRealTime, print, assertActive: current });
    const players = new TeamArenaUiPlayers({ files: common.files, resources: renderer, sound, commands: options.commands,
      sourceParser, random, print, assertActive: current });
    this.ownerDraw = new TeamArenaOwnerDraw({ cvars, renderer, resources, game, teams, catalog: this.catalog,
      selection: this.selection, lists: this.lists, playerList: this.playerList, players, browser, servers: this.servers,
      cinematics: this.cinematics, interaction, runtime, readRendererConfiguration: () => configuration,
      readClient, readRealTime, readFrameTime: () => this.refresher.frameTime, assertActive: current });
    const postgame = new TeamArenaPostGame({ cvars, gameInfo: game, scores: this.scores, menus: this.menus, assertActive: current });
    this.visibility = new TeamArenaVisibility({ cvars, gameInfo: game, players: this.playerList, postgame, scores: this.scores,
      sound, newHighScoreSound: () => resources.assets.newHighScoreSound, assertActive: current });
    this.refresher = new TeamArenaUiRefresh({ cvars, runtime, menus: this.menus, resources, browser: this.servers,
      status: this.status, assertActive: current });
    this.loader = new TeamArenaUiMenuLoader({ productProfile: options.productProfile ?? RETAIL_PRODUCT_PROFILE,
      scriptSources: () => options.scriptSources(), memory, resources, cvars, runtime,
      random: { nextInt: () => random.rand() }, systemClock: options.systemClock, print,
      error: text => { throw new CommonError("drop", text); }, assertCurrentOperation: current });
    this.consoleCommands = new TeamArenaConsoleCommands({ refresh: this.refresher, runtime, memory, loader: this.loader,
      gameInfo: game, catalog: this.catalog, postgame, renderer, readClient, assertActive: current });
    this.connectScreen = new TeamArenaConnectScreen({ resources, runtime, cvars, assertActive: current });
  }
}

/** The engine publishes the VM owner before UI_INIT builds its display and menus. */
export class TeamArenaUi {
  private static readonly registeredOwners = new WeakMap<VmRegistration, TeamArenaUi>();
  private displayOwner: TeamArenaUiDisplay | null = null;
  private phase: "created" | "initializing" | "initialized" | "retired" = "created";

  constructor(private readonly options: TeamArenaUiOptions, private readonly registration: VmRegistration | null = null) {
    if (registration !== null) {
      registration.bindTypeScript();
      TeamArenaUi.registeredOwners.set(registration, this);
    }
  }

  static registered(registration: VmRegistration): TeamArenaUi | null {
    return registration.binding.kind === "typescript" ? TeamArenaUi.registeredOwners.get(registration) ?? null : null;
  }

  /** Register cvars and construct the empty display at the source String_Init position. */
  static async create(options: TeamArenaUiOptions): Promise<TeamArenaUi> {
    const ui = new TeamArenaUi(options);
    await ui.composeDisplay();
    return ui;
  }

  private async composeDisplay(): Promise<void> {
    const options = this.options;
    let owner: TeamArenaUiDisplay | null = null;
    const current = (): undefined => { this.current(); };
    const read = (): TeamArenaUiDisplay => { current(); if (owner === null) throw new Error("UI callback before display composition"); return owner; };
    const print = (text: string): void => { options.common.output.print(text); current(); };
    current();
    const cvars = new TeamArenaUiCvars(options.common.cvars, current);
    const memory = new TeamArenaUiMemory("qvm32", print); memory.initializeMemory();
    const configuration = options.configuration.copy(); current();
    const draw = options.commands.draw2D("team-ui-640");
    if (draw.width !== configuration.vidWidth || draw.height !== configuration.vidHeight) {
      throw new Error("Team Arena UI configuration must match its actual renderer command queue");
    }
    const resources = new TeamArenaUiResources({ renderer: options.renderer, sound: options.sound, cvars,
      fontRegistry: new UiAssetRegistry(options.renderer, print),
      cinematics: options.cinematics, assertCurrentOperation: current });
    // These are the source's empty/BSS menu destinations, not a second parser or a fabricated menu.
    const definitions: UiMenuDefinitions = { memory: { kind: "qvm32", memory }, menus: [], loadedFiles: [], diagnostics: [],
      registration: { kind: "completed", events: [] }, fontRegistered: false, assets: {
        textFont: undefined, smallFont: undefined, bigFont: undefined, cursor: undefined, gradientBar: undefined,
        menuEnterSound: undefined, menuExitSound: undefined, menuBuzzSound: undefined, itemFocusSound: undefined,
        fadeClamp: 0, fadeCycle: 0, fadeAmount: 0, shadowX: 0, shadowY: 0,
        shadowColor: { x: 0, y: 0, z: 0, w: 0 }, shadowFadeClamp: 0 } };
    memory.initializeStrings();
    const modelPainter = new EngineUiModelPainter(options.renderer, options.commands);
    const sourceParser = new CommonParseState();
    const runtime = await UiRuntime.create({ definitions, sourceParser, print, cvars: options.common.cvars, commands: options.common.commands,
      resources, fonts: resources.fonts, get widgetAssets() { return resources.widgetAssets; },
      zeroPicture: options.renderer.picture(null), audio: options.audio, cinematics: options.cinematics,
      paintModel: request => { current(); modelPainter.paint(request); },
      context: { kind: "ui", bindings: { keyName: keynumToString, getBinding: key => options.keys.getBinding(key) ?? "",
        setBinding: (key, command) => options.keys.setBinding(key, command), getOverstrike: () => options.keys.getOverstrike(),
        setOverstrike: enabled => options.keys.setOverstrike(enabled) }, pause: paused => read().menus.pause(paused) },
      feeder: { count: id => read().feeders.count(id), item: (id, index, column) => read().feeders.item(id, index, column),
        image: (id, index) => read().feeders.image(id, index), select: (id, index) => read().feeders.select(id, index) },
      ownerDraw: { visible: flags => { const ui = read(); return ui.visibility.visible(flags, ui.refresher.realTime); },
        width: (id, scale) => read().ownerDraw.width(id, scale), value: id => read().ownerDraw.value(id),
        handleKey: (id, flags, special, key) => read().ownerKeys.handleKey(id, flags, special, key),
        paint: request => read().ownerDraw.paint(request), closeCinematic: id => read().cinematics.stop((-id) | 0) },
      externalScript: { run: (cursor, context) => read().scripts.run(cursor, context) },
      getTeamColor: () => { current(); throw new RangeError("UI_GetTeamColor leaves the source Window_Paint color uninitialized"); } });
    current();
    owner = new TeamArenaUiDisplay(options, cvars, memory, resources, runtime, configuration, sourceParser, current, () => this.usesUniqueKey());
    this.displayOwner = owner;
  }

  private get display(): TeamArenaUiDisplay {
    if (this.displayOwner === null) throw new Error("Team Arena UI display has not initialized");
    return this.displayOwner;
  }
  get cvars(): TeamArenaUiCvars { return this.display.cvars; }
  get memory(): TeamArenaUiMemory { return this.display.memory; }
  get resources(): TeamArenaUiResources { return this.display.resources; }
  get runtime(): UiRuntime { return this.display.runtime; }
  get configuration(): RendererConfigurationSnapshot { return this.display.configuration; }
  get gameInfo(): TeamArenaGameInfo { return this.display.gameInfo; }
  get teams(): TeamArenaTeamInfo { return this.display.teams; }
  get catalog(): TeamArenaCatalog { return this.display.catalog; }
  get selection(): TeamArenaSelection { return this.display.selection; }
  get models(): TeamArenaModels { return this.display.models; }
  get lists(): TeamArenaLists { return this.display.lists; }
  get scores(): TeamArenaScores { return this.display.scores; }
  get playerList(): TeamArenaPlayerList { return this.display.playerList; }
  get interaction(): TeamArenaUiInteractionState { return this.display.interaction; }
  get menus(): TeamArenaMenuController { return this.display.menus; }
  get servers(): TeamArenaServerBrowser { return this.display.servers; }
  get status(): TeamArenaServerStatus { return this.display.status; }
  get cinematics(): TeamArenaUiCinematics { return this.display.cinematics; }
  get feeders(): TeamArenaFeeders { return this.display.feeders; }
  get settings(): TeamArenaSettings { return this.display.settings; }
  get ownerKeys(): TeamArenaOwnerKeys { return this.display.ownerKeys; }
  get scripts(): TeamArenaMenuScripts { return this.display.scripts; }
  get ownerDraw(): TeamArenaOwnerDraw { return this.display.ownerDraw; }
  get visibility(): TeamArenaVisibility { return this.display.visibility; }
  get refresher(): TeamArenaUiRefresh { return this.display.refresher; }
  get loader(): TeamArenaUiMenuLoader { return this.display.loader; }
  get consoleCommands(): TeamArenaConsoleCommands { return this.display.consoleCommands; }
  get connectScreen(): TeamArenaConnectScreen { return this.display.connectScreen; }

  private current(): void {
    this.options.assertCurrentOperation();
    if (this.phase === "retired") throw new Error("Team Arena UI has retired");
  }

  /** VM_Call before code/ui/ui_main.c vmMain; command IDs are ui_public.h uiExport_t. */
  private markVmCall(command: number): void {
    this.registration?.called();
    this.registration?.printCall(command);
  }

  apiVersion(): number { this.current(); this.markVmCall(0); return 6; }
  usesUniqueKey(): number { this.current(); this.markVmCall(10); return 1; }

  async initialize(): Promise<void> {
    this.current();
    this.markVmCall(1);
    const prepared = this.phase === "created" && this.displayOwner !== null;
    this.phase = "initializing";
    if (!prepared) {
      this.displayOwner?.runtime.retire(); this.displayOwner?.resources.dispose();
      await this.composeDisplay(); this.current();
    }
    await this.resources.initializeDisplayAssets(); this.current();
    await this.resources.assetCache(); this.current();
    this.options.systemClock.milliseconds(); this.current();
    this.teams.teamCount = 0; this.teams.characterCount = 0; this.teams.aliasCount = 0;
    const demo = isPrereleaseTeamArenaDemo(this.options.productProfile ?? RETAIL_PRODUCT_PROFILE);
    await this.teams.parseTeamInfo(demo ? "demoteaminfo.txt" : "teaminfo.txt"); this.current();
    if (!demo) { await this.teams.loadTeams(); this.current(); }
    await this.gameInfo.parseGameInfo(demo ? "demogameinfo.txt" : "gameinfo.txt"); this.current();
    const menuSet = sourceCommandText(this.cvars.registry.get("ui_menuFiles")?.value ?? "").slice(0, 1023);
    await this.loader.load(menuSet.length === 0 ? "ui/menus.txt" : menuSet, true); this.current();
    await this.loader.load("ui/ingame.txt", false); this.current();
    await this.runtime.closeAll(); this.current();
    this.options.browser.loadCachedServers(this.options.common.files); this.current();
    this.scores.loadBestScores(infoSlot(this.gameInfo.mapList, this.cvars.get("ui_currentMap").integerValue).mapLoadName,
      infoSlot(this.gameInfo.gameTypes, this.cvars.get("ui_gameType").integerValue).gtEnum); this.current();
    await this.models.buildList(); this.current();
    this.catalog.loadBots(); this.current();
    const value = (name: string): number => Math.fround(this.cvars.registry.get(name)?.numericValue ?? 0);
    this.interaction.effectsColor = infoSlot([4, 2, 3, 0, 5, 1, 6], (qvmFloatToInt(value("color1")) - 1) | 0);
    this.interaction.currentCrosshair = qvmFloatToInt(value("cg_drawCrosshair"));
    this.cvars.registry.set("ui_mousePitch", value("m_pitch") >= 0 ? "0" : "1", true); this.current();
    this.servers.currentServerCinematic = -1; this.interaction.previewMovie = -1;
    if (value("ui_TeamArenaFirstRun") === 0) {
      this.cvars.registry.set("s_volume", "0.8", true); this.current();
      this.cvars.registry.set("s_musicvolume", "0.5", true); this.current();
      this.cvars.registry.set("ui_TeamArenaFirstRun", "1", true); this.current();
    }
    this.cvars.registry.register("debug_protocol", "", 0); this.current();
    this.cvars.registry.set("ui_actualNetGameType", String(this.cvars.get("ui_netGameType").integerValue), true); this.current();
    this.phase = "initialized";
  }

  shutdown(): void { this.current(); this.markVmCall(2); this.options.browser.saveServersToCache(this.options.common.files); this.current(); }
  startDemoLoop(): void { this.current(); this.options.common.commands.append("d1\n"); this.current(); }
  needCdAction(result: boolean): void { this.current(); if (!result) this.options.common.commands.append("quit\n"); this.current(); }
  needCdKeyAction(result: boolean): void { this.current(); if (!result) this.options.common.commands.append("quit\n"); this.current(); }
  maxServerPing(): number {
    this.current();
    const value = qvmFloatToInt(this.options.common.cvars.get("cl_maxPing")?.numericValue ?? 0);
    return value < 100 ? 100 : value;
  }
  drawCenteredPic(image: PictureAsset, width: number, height: number): void {
    this.current();
    const w = width | 0, h = height | 0;
    this.options.commands.draw2D("team-ui-640").drawHandlePic({
      x: Math.fround(Math.trunc(((640 - w) | 0) / 2)), y: Math.fround(Math.trunc(((480 - h) | 0) / 2)),
      width: Math.fround(w), height: Math.fround(h),
    }, image);
    this.current();
  }
  fontReport(): void {
    this.current();
    this.options.common.output.print("Font Info\n"); this.current();
    this.options.common.output.print("=========\n"); this.current();
    for (let index = 32; index < 96; index++) {
      const glyph = infoSlot(this.resources.assets.textFont.glyphs, index);
      const handle = this.resources.handles.pictureHandle(glyph.picture ?? undefined);
      this.options.common.output.print(`Glyph handle ${index}: ${handle}\n`); this.current();
    }
  }
  drawTextBox(x: number, y: number, width: number, lines: number): void {
    this.current();
    const draw = this.options.commands.draw2D("team-ui-640"), white = this.resources.assets.whiteShader;
    const rect = { x: Math.fround(((x | 0) + 8) | 0), y: Math.fround(((y | 0) + 8) | 0),
      width: Math.fround(Math.imul(((width | 0) + 1) | 0, 16)), height: Math.fround(Math.imul(((lines | 0) + 1) | 0, 16)) };
    draw.fillRect(rect, { x: 0, y: 0, z: 0, w: 1 }, white);
    draw.drawUiRect(rect, { x: 1, y: 1, z: 1, w: 1 }, white);
    this.current();
  }
  cursorInRect(x: number, y: number, width: number, height: number): boolean {
    this.current();
    const left = x | 0, top = y | 0;
    return !(this.menus.cursorX < Math.fround(left) || this.menus.cursorY < Math.fround(top)
      || this.menus.cursorX > Math.fround((left + (width | 0)) | 0)
      || this.menus.cursorY > Math.fround((top + (height | 0)) | 0));
  }
  retire(): void { this.displayOwner?.runtime.retire(); this.displayOwner?.resources.dispose(); this.phase = "retired"; this.registration?.free(); }
  keyEvent(key: number, down: boolean): Promise<void> { this.current(); this.markVmCall(3); return this.menus.keyEvent(key, down); }
  mouseEvent(dx: number, dy: number): Promise<void> { this.current(); this.markVmCall(4); return this.menus.mouseEvent(dx, dy); }
  refresh(realTime: number): Promise<void> { this.current(); this.markVmCall(5); return this.refresher.refresh(realTime, this.options.commands.draw2D("team-ui-640")); }
  isFullscreen(): boolean { this.current(); this.markVmCall(6); return this.menus.isFullscreen(); }
  consoleCommand(context: CommandContext): Promise<boolean> { this.current(); this.markVmCall(8); return this.consoleCommands.run(context, this.options.readRealTime()); }
  drawConnectScreen(overlay: boolean, clientStatic: ClientStaticState, connection: ClientConnectionState): Promise<void> {
    this.current();
    this.markVmCall(9);
    return this.connectScreen.draw(overlay, { time: this.refresher.realTime, frameTime: this.refresher.frameTime,
      draw: this.options.commands.draw2D("team-ui-640") }, clientStatic, connection, this.options.readSession());
  }
  async setActiveMenu(menu: number | "main" | "ingame"): Promise<void> {
    this.current();
    this.markVmCall(7);
    switch (menu) {
      case "main": await this.menus.setActiveMenu(UiMenuCommand.Main); break;
      case "ingame": await this.menus.setActiveMenu(UiMenuCommand.InGame); break;
      case UiMenuCommand.None: case UiMenuCommand.Main: case UiMenuCommand.InGame: case UiMenuCommand.Team:
      case UiMenuCommand.Postgame: case UiMenuCommand.NeedCd: case UiMenuCommand.BadCdKey:
        await this.menus.setActiveMenu(menu); break;
    }
    this.current();
  }
}
