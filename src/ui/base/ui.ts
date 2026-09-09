// Base product UI entry points from id Software q3_ui/ui_atoms.c and ui_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CommonFileState } from "../../assets/filesystem-state.ts";
import type { CommandBuffer, CommandContext } from "../../core/commands.ts";
import type { HunkArena } from "../../core/hunk.ts";
import { sourceCommandText } from "../../core/text.ts";
import type { CommonCdKeyState } from "../../engine/cd-key.ts";
import type { EngineClientSession } from "../../engine/client-session.ts";
import type { ClientConnectionState, ClientStaticState } from "../../engine/client-state.ts";
import type { ServerBrowser } from "../../engine/server-browser.ts";
import type { RendererConfiguration, RendererConfigurationSnapshot } from "../../render/configuration.ts";
import type { VmRegistration } from "../../vm/registry.ts";
import { BaseAddBotsMenu } from "./add-bots.ts";
import { BaseArenaServersMenu } from "./arena-servers.ts";
import { BaseCdKeyMenu } from "./cd-key.ts";
import { BaseCinematicsMenu } from "./cinematics-menu.ts";
import { BaseConfirmMenu } from "./confirm.ts";
import { BaseConnectScreen } from "./connect-screen.ts";
import { BaseControlsMenu } from "./controls.ts";
import { BaseCreditsMenu } from "./credits.ts";
import { BaseDemosMenu } from "./demos.ts";
import { BaseDisplayOptionsMenu } from "./display-options.ts";
import { cacheMenu } from "./draw.ts";
import { forceMenuOff, isFullscreen, keyEvent, mouseEvent, refresh } from "./framework.ts";
import type { BaseUiGameInfo } from "./game-info.ts";
import { BaseGraphicsOptionsMenu } from "./graphics-options.ts";
import { BaseInGameMenu } from "./ingame.ts";
import { BaseLoadConfigMenu } from "./load-config.ts";
import { BaseMainMenu } from "./main-menu.ts";
import { BaseModsMenu } from "./mods.ts";
import { BaseNetworkOptionsMenu } from "./network-options.ts";
import { BasePlayerModelMenu } from "./player-model.ts";
import { BasePlayerSettingsMenu } from "./player-settings.ts";
import { BaseUiPlayers } from "./players.ts";
import { BasePreferencesMenu } from "./preferences.ts";
import { BaseRemoveBotsMenu } from "./remove-bots.ts";
import { BaseSaveConfigMenu } from "./save-config.ts";
import { BaseServerInfoMenu } from "./server-info.ts";
import { BaseSetupMenu } from "./setup.ts";
import { BaseSoundOptionsMenu } from "./sound-options.ts";
import { BaseSpLevelMenu } from "./sp-level.ts";
import { BaseSpPostgameMenu } from "./sp-postgame.ts";
import { BaseSpResetMenu } from "./sp-reset.ts";
import { BaseSpSkillMenu } from "./sp-skill.ts";
import { BaseSpecifyServerMenu } from "./specify-server.ts";
import { BaseStartServerMenu } from "./start-server.ts";
import { BaseSystemConfigMenu } from "./system-config.ts";
import type { BaseUiState } from "./state.ts";
import { BaseTeamMenu } from "./team-menu.ts";
import { BaseTeamOrdersMenu } from "./team-orders.ts";

import { UiMenuCommand } from "../public.ts";

// uiExport_t in code/ui/ui_public.h, dispatched by q3_ui/ui_main.c vmMain.
enum BaseUiCall {
  GetApiVersion = 0, Init = 1, Shutdown = 2, KeyEvent = 3, MouseEvent = 4,
  Refresh = 5, IsFullscreen = 6, SetActiveMenu = 7, ConsoleCommand = 8,
  DrawConnectScreen = 9, HasUniqueCdKey = 10,
}

export interface BaseUiOptions {
  readonly state: BaseUiState;
  readonly gameInfo: BaseUiGameInfo;
  readonly files: CommonFileState;
  readonly cdKey: CommonCdKeyState;
  readonly commands: CommandBuffer;
  readonly hunk: HunkArena;
  readonly browser: ServerBrowser;
  readonly configuration: RendererConfiguration;
  readSession(): EngineClientSession | null;
}

class BaseUiMenus {
  readonly confirm: BaseConfirmMenu;
  readonly specifyServer: BaseSpecifyServerMenu;
  readonly cdKey: BaseCdKeyMenu;
  readonly players: BaseUiPlayers;
  readonly playerModel: BasePlayerModelMenu;
  readonly playerSettings: BasePlayerSettingsMenu;
  readonly controls: BaseControlsMenu;
  readonly preferences: BasePreferencesMenu;
  readonly demos: BaseDemosMenu;
  readonly loadConfig: BaseLoadConfigMenu;
  readonly saveConfig: BaseSaveConfigMenu;
  readonly cinematics: BaseCinematicsMenu;
  readonly mods: BaseModsMenu;
  readonly credits: BaseCreditsMenu;
  readonly graphics: BaseGraphicsOptionsMenu;
  readonly display: BaseDisplayOptionsMenu;
  readonly sound: BaseSoundOptionsMenu;
  readonly network: BaseNetworkOptionsMenu;
  readonly systemConfig: BaseSystemConfigMenu;
  readonly setup: BaseSetupMenu;
  readonly inGame: BaseInGameMenu;
  readonly main: BaseMainMenu;
  readonly arenaServers: BaseArenaServersMenu;
  readonly startServer: BaseStartServerMenu;
  readonly spLevel: BaseSpLevelMenu;
  readonly spSkill: BaseSpSkillMenu;
  readonly spPostgame: BaseSpPostgameMenu;
  readonly spReset: BaseSpResetMenu;
  readonly team: BaseTeamMenu;
  readonly teamOrders: BaseTeamOrdersMenu;
  readonly addBots: BaseAddBotsMenu;
  readonly removeBots: BaseRemoveBotsMenu;
  readonly serverInfo: BaseServerInfoMenu;
  readonly connectScreen: BaseConnectScreen;
  private readonly currentGameState: Pick<EngineClientSession, "getGameState">;

  constructor(private readonly options: BaseUiOptions, readonly configuration: RendererConfigurationSnapshot, usesUniqueKey: () => number) {
    const { state, files, gameInfo } = options;
    this.currentGameState = { getGameState: () => this.currentSession().getGameState() };
    this.confirm = new BaseConfirmMenu(state);
    this.specifyServer = new BaseSpecifyServerMenu(state);
    this.cdKey = new BaseCdKeyMenu(state, options.cdKey, usesUniqueKey);
    this.players = new BaseUiPlayers(state, files);
    this.playerModel = new BasePlayerModelMenu(state, this.players, options.hunk);
    this.playerSettings = new BasePlayerSettingsMenu(state, this.players, this.playerModel);
    this.controls = new BaseControlsMenu(state, this.players, this.confirm);
    this.preferences = new BasePreferencesMenu(state);
    this.demos = new BaseDemosMenu(state, files);
    this.loadConfig = new BaseLoadConfigMenu(state, files);
    this.saveConfig = new BaseSaveConfigMenu(state);
    this.cinematics = new BaseCinematicsMenu(state);
    this.mods = new BaseModsMenu(state, files);
    this.credits = new BaseCreditsMenu(state);
    this.graphics = new BaseGraphicsOptionsMenu(state, configuration, {
      display: () => this.display.show(), sound: () => this.sound.show(), network: () => this.network.show(),
    });
    this.display = new BaseDisplayOptionsMenu(state, configuration, {
      graphics: () => this.graphics.show(), sound: () => this.sound.show(), network: () => this.network.show(),
    });
    this.sound = new BaseSoundOptionsMenu(state, {
      graphics: () => this.graphics.show(), display: () => this.display.show(), network: () => this.network.show(),
    });
    this.network = new BaseNetworkOptionsMenu(state, {
      graphics: () => this.graphics.show(), display: () => this.display.show(), sound: () => this.sound.show(),
    });
    this.systemConfig = new BaseSystemConfigMenu(state, {
      graphics: () => this.graphics.show(), display: () => this.display.show(),
      sound: () => this.sound.show(), network: () => this.network.show(),
    });
    this.setup = new BaseSetupMenu(state, this.confirm, {
      playerSettings: () => this.playerSettings.show(), controls: () => this.controls.show(),
      graphics: () => this.graphics.show(), preferences: () => this.preferences.show(), cdKey: () => this.cdKey.show(),
    });
    this.startServer = new BaseStartServerMenu(state, gameInfo);
    this.spSkill = new BaseSpSkillMenu(state, gameInfo);
    this.spLevel = new BaseSpLevelMenu(state, gameInfo, this.spSkill, this.playerSettings, this.startServer, this.confirm);
    this.spReset = new BaseSpResetMenu(state, gameInfo, this.spLevel);
    this.spPostgame = new BaseSpPostgameMenu(state, gameInfo, this.currentGameState);
    this.team = new BaseTeamMenu(state, () => this.currentSession().getConfigString(0) ?? "");
    this.teamOrders = new BaseTeamOrdersMenu(state);
    this.addBots = new BaseAddBotsMenu(state, gameInfo);
    this.removeBots = new BaseRemoveBotsMenu(state);
    this.serverInfo = new BaseServerInfoMenu(state, () => this.currentSession().getConfigString(0) ?? "");
    this.inGame = new BaseInGameMenu(state, this.confirm, {
      team: () => this.team.show(), addBots: () => this.addBots.show(this.currentGameState), removeBots: () => this.removeBots.show(this.currentGameState),
      teamOrders: () => this.teamOrders.show(this.currentSession()), setup: () => this.setup.show(),
      serverInfo: () => this.serverInfo.show(), credits: () => this.credits.show(),
    });
    this.arenaServers = new BaseArenaServersMenu(state, options.browser, options.commands, this.startServer, this.specifyServer, this.confirm);
    this.main = new BaseMainMenu(state, files, options.cdKey, this.cdKey, this.confirm, {
      singlePlayer: () => this.spLevel.show(), multiplayer: () => this.arenaServers.show(), setup: () => this.setup.show(),
      demos: () => this.demos.show(), cinematics: () => this.cinematics.show(), mods: () => this.mods.show(), credits: () => this.credits.show(),
    }, usesUniqueKey);
    this.connectScreen = new BaseConnectScreen(state);
  }

  private currentSession(): EngineClientSession {
    this.options.state.assertActive();
    const session = this.options.readSession();
    if (session === null) throw new Error("This UI operation requires the engine's current client session");
    return session;
  }
}

/** One compiled base UI lifetime, published before UI_INIT builds its menus. */
export class BaseUi {
  private static readonly registeredOwners = new WeakMap<VmRegistration, BaseUi>();
  private menuOwner: BaseUiMenus | null = null;
  private retired = false;

  constructor(private readonly options: BaseUiOptions, private readonly registration: VmRegistration | null = null) {
    if (registration !== null) {
      registration.bindTypeScript();
      BaseUi.registeredOwners.set(registration, this);
    }
  }

  static registered(registration: VmRegistration): BaseUi | null {
    return registration.binding.kind === "typescript" ? BaseUi.registeredOwners.get(registration) ?? null : null;
  }

  static async create(options: BaseUiOptions): Promise<BaseUi> {
    const ui = new BaseUi(options);
    await ui.initialize();
    return ui;
  }

  private markCall(call: BaseUiCall): void {
    this.registration?.called();
    this.registration?.printCall(call);
  }

  apiVersion(): number { this.markCall(BaseUiCall.GetApiVersion); return 6; }
  usesUniqueKey(): number { this.markCall(BaseUiCall.HasUniqueCdKey); return 1; }

  async initialize(): Promise<void> {
    this.markCall(BaseUiCall.Init);
    const { state } = this.options;
    state.assertActive();
    state.services.cvars.register();
    this.options.gameInfo.initialize();
    const configuration = this.options.configuration.copy();
    if (state.draw.width !== configuration.vidWidth || state.draw.height !== configuration.vidHeight)
      throw new Error("Base UI renderer configuration must match its actual render queue dimensions");
    this.menuOwner = new BaseUiMenus(this.options, configuration, () => this.usesUniqueKey());
    await cacheMenu(state); state.assertActive();
    state.activeMenu = null; state.menuDepth = 0;
  }

  private get menus(): BaseUiMenus {
    if (this.menuOwner === null) throw new Error("Base UI menus have not initialized");
    return this.menuOwner;
  }
  get configuration(): RendererConfigurationSnapshot { return this.menus.configuration; }
  get confirm(): BaseConfirmMenu { return this.menus.confirm; }
  get specifyServer(): BaseSpecifyServerMenu { return this.menus.specifyServer; }
  get cdKey(): BaseCdKeyMenu { return this.menus.cdKey; }
  get players(): BaseUiPlayers { return this.menus.players; }
  get playerModel(): BasePlayerModelMenu { return this.menus.playerModel; }
  get playerSettings(): BasePlayerSettingsMenu { return this.menus.playerSettings; }
  get controls(): BaseControlsMenu { return this.menus.controls; }
  get preferences(): BasePreferencesMenu { return this.menus.preferences; }
  get demos(): BaseDemosMenu { return this.menus.demos; }
  get loadConfig(): BaseLoadConfigMenu { return this.menus.loadConfig; }
  get saveConfig(): BaseSaveConfigMenu { return this.menus.saveConfig; }
  get cinematics(): BaseCinematicsMenu { return this.menus.cinematics; }
  get mods(): BaseModsMenu { return this.menus.mods; }
  get credits(): BaseCreditsMenu { return this.menus.credits; }
  get graphics(): BaseGraphicsOptionsMenu { return this.menus.graphics; }
  get display(): BaseDisplayOptionsMenu { return this.menus.display; }
  get sound(): BaseSoundOptionsMenu { return this.menus.sound; }
  get network(): BaseNetworkOptionsMenu { return this.menus.network; }
  get systemConfig(): BaseSystemConfigMenu { return this.menus.systemConfig; }
  get setup(): BaseSetupMenu { return this.menus.setup; }
  get inGame(): BaseInGameMenu { return this.menus.inGame; }
  get main(): BaseMainMenu { return this.menus.main; }
  get arenaServers(): BaseArenaServersMenu { return this.menus.arenaServers; }
  get startServer(): BaseStartServerMenu { return this.menus.startServer; }
  get spLevel(): BaseSpLevelMenu { return this.menus.spLevel; }
  get spSkill(): BaseSpSkillMenu { return this.menus.spSkill; }
  get spPostgame(): BaseSpPostgameMenu { return this.menus.spPostgame; }
  get spReset(): BaseSpResetMenu { return this.menus.spReset; }
  get team(): BaseTeamMenu { return this.menus.team; }
  get teamOrders(): BaseTeamOrdersMenu { return this.menus.teamOrders; }
  get addBots(): BaseAddBotsMenu { return this.menus.addBots; }
  get removeBots(): BaseRemoveBotsMenu { return this.menus.removeBots; }
  get serverInfo(): BaseServerInfoMenu { return this.menus.serverInfo; }
  get connectScreen(): BaseConnectScreen { return this.menus.connectScreen; }
  get state(): BaseUiState { return this.options.state; }
  private currentSession(): EngineClientSession {
    this.state.assertActive();
    const session = this.options.readSession();
    if (session === null) throw new Error("This UI operation requires the engine's current client session");
    return session;
  }

  // The source shutdown entry point does not retire shared engine or UI resources.
  shutdown(): void { this.markCall(BaseUiCall.Shutdown); }
  retire(): void {
    if (this.retired) return;
    this.retired = true; this.state.retire(); this.registration?.free();
  }
  keyEvent(key: number, down: boolean): Promise<void> { this.markCall(BaseUiCall.KeyEvent); return keyEvent(this.state, key, down); }
  mouseEvent(dx: number, dy: number): Promise<void> { this.markCall(BaseUiCall.MouseEvent); return mouseEvent(this.state, dx, dy); }
  refresh(realtime: number): Promise<void> { this.markCall(BaseUiCall.Refresh); return refresh(this.state, realtime); }
  isFullscreen(): boolean { this.markCall(BaseUiCall.IsFullscreen); return isFullscreen(this.state); }
  drawConnectScreen(overlay: boolean, clientStatic: ClientStaticState, connection: ClientConnectionState): Promise<void> {
    this.markCall(BaseUiCall.DrawConnectScreen);
    return this.connectScreen.draw(overlay, clientStatic, connection, this.options.readSession());
  }

  async setActiveMenu(menu: number | "main" | "ingame"): Promise<void> {
    this.markCall(BaseUiCall.SetActiveMenu);
    await cacheMenu(this.state); this.state.assertActive();
    switch (menu) {
      case UiMenuCommand.None: await forceMenuOff(this.state); break;
      case "main": case UiMenuCommand.Main: await this.main.show(); break;
      case "ingame": case UiMenuCommand.InGame:
        this.state.services.cvars.registry.set("cl_paused", "1", true);
        await this.inGame.show(this.currentSession()); break;
      case UiMenuCommand.NeedCd: case UiMenuCommand.BadCdKey:
        await this.confirm.show(menu === UiMenuCommand.NeedCd ? "Insert the CD" : "Bad CD Key", null, async result => {
          this.state.assertActive(); if (!result) this.options.commands.append("quit\n");
        }); break;
      default: this.state.services.print(`UI_SetActiveMenu: bad enum ${menu}\n`); break;
    }
    this.state.assertActive();
  }

  async consoleCommand(context: CommandContext): Promise<boolean> {
    context.assertActive();
    this.markCall(BaseUiCall.ConsoleCommand);
    const command = sourceCommandText(context.argv[0] ?? "").slice(0, 1023)
      .replace(/[A-Z]/g, byte => String.fromCharCode(byte.charCodeAt(0) + 32));
    await cacheMenu(this.state); this.state.assertActive(); context.assertActive();
    switch (command) {
      case "levelselect": await this.spLevel.showFromCommand(); break;
      case "postgame": await this.spPostgame.showFromCommand(context); break;
      case "ui_cache": await this.cacheAll(); break;
      case "ui_cinematics": await this.cinematics.showFromCommand(context); break;
      case "ui_teamorders": await this.teamOrders.showFromCommand(this.currentSession()); break;
      case "iamacheater": this.options.gameInfo.unlockLevelScores(); this.spLevel.reInit(); break;
      case "iamamonkey": this.options.gameInfo.unlockMedals(); break;
      case "ui_cdkey": await this.cdKey.show(); break;
      default: return false;
    }
    this.state.assertActive(); context.assertActive(); return true;
  }

  async cacheAll(): Promise<void> {
    this.state.assertActive();
    await this.main.cache(); await this.inGame.cache(); await this.confirm.cache();
    await this.playerModel.cache(); await this.playerSettings.cache(); await this.controls.cache();
    await this.demos.cache(); await this.cinematics.cache(); await this.preferences.cache();
    await this.serverInfo.cache(); await this.specifyServer.cache(); await this.arenaServers.cache();
    await this.startServer.cache(); await this.startServer.cacheServerOptions(); await this.graphics.cacheDriverInfo();
    await this.graphics.cache(); await this.display.cache(); await this.sound.cache(); await this.network.cache();
    await this.spLevel.cache(); await this.spSkill.cache(); await this.spPostgame.cache();
    await this.team.cache(); await this.addBots.cache(); await this.removeBots.cache(); await this.setup.cache();
    await this.startServer.cacheBotSelect(); await this.cdKey.cache(); await this.mods.cache();
    this.state.assertActive();
  }
}
