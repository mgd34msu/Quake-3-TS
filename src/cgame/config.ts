// Ported from id Software's code/cgame/cg_main.c CG_RegisterCvars,
// CG_ForceModelChange and CG_UpdateCvars, with vmCvar_t copying from cvar.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry, CvarSnapshot } from "../core/cvar.ts";
import { gameAtoi } from "../game/numeric.ts";
import type { Product } from "../shared/definitions.ts";
import type { ClientInfoStore } from "./players.ts";
import type { ClientGameState, ClientGameStaticState } from "./state.ts";

const MAX_CLIENTS = 64;
const CS_PLAYERS = 544;
const MAX_CVAR_VALUE_STRING = 256;
const MAX_TOKEN_CHARS = 1024;

/** The C globals addressed by cvarTable, distinct from their engine cvar names. */
export enum ClientVmCvarSymbol {
  cg_ignore = "cg_ignore",
  cg_autoswitch = "cg_autoswitch",
  cg_drawGun = "cg_drawGun",
  cg_zoomFov = "cg_zoomFov",
  cg_fov = "cg_fov",
  cg_viewsize = "cg_viewsize",
  cg_stereoSeparation = "cg_stereoSeparation",
  cg_shadows = "cg_shadows",
  cg_gibs = "cg_gibs",
  cg_draw2D = "cg_draw2D",
  cg_drawStatus = "cg_drawStatus",
  cg_drawTimer = "cg_drawTimer",
  cg_drawFPS = "cg_drawFPS",
  cg_drawSnapshot = "cg_drawSnapshot",
  cg_draw3dIcons = "cg_draw3dIcons",
  cg_drawIcons = "cg_drawIcons",
  cg_drawAmmoWarning = "cg_drawAmmoWarning",
  cg_drawAttacker = "cg_drawAttacker",
  cg_drawCrosshair = "cg_drawCrosshair",
  cg_drawCrosshairNames = "cg_drawCrosshairNames",
  cg_drawRewards = "cg_drawRewards",
  cg_crosshairSize = "cg_crosshairSize",
  cg_crosshairHealth = "cg_crosshairHealth",
  cg_crosshairX = "cg_crosshairX",
  cg_crosshairY = "cg_crosshairY",
  cg_brassTime = "cg_brassTime",
  cg_simpleItems = "cg_simpleItems",
  cg_addMarks = "cg_addMarks",
  cg_lagometer = "cg_lagometer",
  cg_railTrailTime = "cg_railTrailTime",
  cg_gun_x = "cg_gun_x",
  cg_gun_y = "cg_gun_y",
  cg_gun_z = "cg_gun_z",
  cg_centertime = "cg_centertime",
  cg_runpitch = "cg_runpitch",
  cg_runroll = "cg_runroll",
  cg_bobup = "cg_bobup",
  cg_bobpitch = "cg_bobpitch",
  cg_bobroll = "cg_bobroll",
  cg_swingSpeed = "cg_swingSpeed",
  cg_animSpeed = "cg_animSpeed",
  cg_debugAnim = "cg_debugAnim",
  cg_debugPosition = "cg_debugPosition",
  cg_debugEvents = "cg_debugEvents",
  cg_errorDecay = "cg_errorDecay",
  cg_nopredict = "cg_nopredict",
  cg_noPlayerAnims = "cg_noPlayerAnims",
  cg_showmiss = "cg_showmiss",
  cg_footsteps = "cg_footsteps",
  cg_tracerChance = "cg_tracerChance",
  cg_tracerWidth = "cg_tracerWidth",
  cg_tracerLength = "cg_tracerLength",
  cg_thirdPersonRange = "cg_thirdPersonRange",
  cg_thirdPersonAngle = "cg_thirdPersonAngle",
  cg_thirdPerson = "cg_thirdPerson",
  cg_teamChatTime = "cg_teamChatTime",
  cg_teamChatHeight = "cg_teamChatHeight",
  cg_forceModel = "cg_forceModel",
  cg_predictItems = "cg_predictItems",
  cg_deferPlayers = "cg_deferPlayers",
  cg_drawTeamOverlay = "cg_drawTeamOverlay",
  cg_teamOverlayUserinfo = "cg_teamOverlayUserinfo",
  cg_stats = "cg_stats",
  cg_drawFriend = "cg_drawFriend",
  cg_teamChatsOnly = "cg_teamChatsOnly",
  cg_noVoiceChats = "cg_noVoiceChats",
  cg_noVoiceText = "cg_noVoiceText",
  cg_buildScript = "cg_buildScript",
  cg_paused = "cg_paused",
  cg_blood = "cg_blood",
  cg_synchronousClients = "cg_synchronousClients",
  cg_redTeamName = "cg_redTeamName",
  cg_blueTeamName = "cg_blueTeamName",
  cg_currentSelectedPlayer = "cg_currentSelectedPlayer",
  cg_currentSelectedPlayerName = "cg_currentSelectedPlayerName",
  cg_singlePlayer = "cg_singlePlayer",
  cg_enableDust = "cg_enableDust",
  cg_enableBreath = "cg_enableBreath",
  cg_singlePlayerActive = "cg_singlePlayerActive",
  cg_recordSPDemo = "cg_recordSPDemo",
  cg_recordSPDemoName = "cg_recordSPDemoName",
  cg_obeliskRespawnDelay = "cg_obeliskRespawnDelay",
  cg_hudFiles = "cg_hudFiles",
  cg_cameraOrbit = "cg_cameraOrbit",
  cg_cameraOrbitDelay = "cg_cameraOrbitDelay",
  cg_timescaleFadeEnd = "cg_timescaleFadeEnd",
  cg_timescaleFadeSpeed = "cg_timescaleFadeSpeed",
  cg_timescale = "cg_timescale",
  cg_scorePlum = "cg_scorePlum",
  cg_smoothClients = "cg_smoothClients",
  cg_cameraMode = "cg_cameraMode",
  pmove_fixed = "pmove_fixed",
  pmove_msec = "pmove_msec",
  cg_noTaunt = "cg_noTaunt",
  cg_noProjectileTrail = "cg_noProjectileTrail",
  cg_smallFont = "cg_smallFont",
  cg_bigFont = "cg_bigFont",
  cg_oldRail = "cg_oldRail",
  cg_oldRocket = "cg_oldRocket",
  cg_oldPlasma = "cg_oldPlasma",
  cg_trueLightning = "cg_trueLightning",
}

interface CvarDefinition {
  readonly symbol: ClientVmCvarSymbol;
  readonly name: string;
  readonly defaultValue: string;
  readonly flags: number;
}

function cv(symbol: ClientVmCvarSymbol, name: string, defaultValue: string, flags = CvarFlag.None): CvarDefinition {
  return { symbol, name, defaultValue, flags };
}

const A = CvarFlag.Archive;
const C = CvarFlag.Cheat;
const R = CvarFlag.ReadOnly;
const U = CvarFlag.UserInfo;
const S = CvarFlag.ServerInfo;

function cvarTable(product: Product): readonly CvarDefinition[] {
  const table: CvarDefinition[] = [
    cv(ClientVmCvarSymbol.cg_ignore, "cg_ignore", "0"),
    cv(ClientVmCvarSymbol.cg_autoswitch, "cg_autoswitch", "1", A),
    cv(ClientVmCvarSymbol.cg_drawGun, "cg_drawGun", "1", A),
    cv(ClientVmCvarSymbol.cg_zoomFov, "cg_zoomfov", "22.5", A),
    cv(ClientVmCvarSymbol.cg_fov, "cg_fov", "90", A),
    cv(ClientVmCvarSymbol.cg_viewsize, "cg_viewsize", "100", A),
    cv(ClientVmCvarSymbol.cg_stereoSeparation, "cg_stereoSeparation", "0.4", A),
    cv(ClientVmCvarSymbol.cg_shadows, "cg_shadows", "1", A),
    cv(ClientVmCvarSymbol.cg_gibs, "cg_gibs", "1", A),
    cv(ClientVmCvarSymbol.cg_draw2D, "cg_draw2D", "1", A),
    cv(ClientVmCvarSymbol.cg_drawStatus, "cg_drawStatus", "1", A),
    cv(ClientVmCvarSymbol.cg_drawTimer, "cg_drawTimer", "0", A),
    cv(ClientVmCvarSymbol.cg_drawFPS, "cg_drawFPS", "0", A),
    cv(ClientVmCvarSymbol.cg_drawSnapshot, "cg_drawSnapshot", "0", A),
    cv(ClientVmCvarSymbol.cg_draw3dIcons, "cg_draw3dIcons", "1", A),
    cv(ClientVmCvarSymbol.cg_drawIcons, "cg_drawIcons", "1", A),
    cv(ClientVmCvarSymbol.cg_drawAmmoWarning, "cg_drawAmmoWarning", "1", A),
    cv(ClientVmCvarSymbol.cg_drawAttacker, "cg_drawAttacker", "1", A),
    cv(ClientVmCvarSymbol.cg_drawCrosshair, "cg_drawCrosshair", "4", A),
    cv(ClientVmCvarSymbol.cg_drawCrosshairNames, "cg_drawCrosshairNames", "1", A),
    cv(ClientVmCvarSymbol.cg_drawRewards, "cg_drawRewards", "1", A),
    cv(ClientVmCvarSymbol.cg_crosshairSize, "cg_crosshairSize", "24", A),
    cv(ClientVmCvarSymbol.cg_crosshairHealth, "cg_crosshairHealth", "1", A),
    cv(ClientVmCvarSymbol.cg_crosshairX, "cg_crosshairX", "0", A),
    cv(ClientVmCvarSymbol.cg_crosshairY, "cg_crosshairY", "0", A),
    cv(ClientVmCvarSymbol.cg_brassTime, "cg_brassTime", "2500", A),
    cv(ClientVmCvarSymbol.cg_simpleItems, "cg_simpleItems", "0", A),
    cv(ClientVmCvarSymbol.cg_addMarks, "cg_marks", "1", A),
    cv(ClientVmCvarSymbol.cg_lagometer, "cg_lagometer", "1", A),
    cv(ClientVmCvarSymbol.cg_railTrailTime, "cg_railTrailTime", "400", A),
    cv(ClientVmCvarSymbol.cg_gun_x, "cg_gunX", "0", C),
    cv(ClientVmCvarSymbol.cg_gun_y, "cg_gunY", "0", C),
    cv(ClientVmCvarSymbol.cg_gun_z, "cg_gunZ", "0", C),
    cv(ClientVmCvarSymbol.cg_centertime, "cg_centertime", "3", C),
    cv(ClientVmCvarSymbol.cg_runpitch, "cg_runpitch", "0.002", A),
    cv(ClientVmCvarSymbol.cg_runroll, "cg_runroll", "0.005", A),
    cv(ClientVmCvarSymbol.cg_bobup, "cg_bobup", "0.005", C),
    cv(ClientVmCvarSymbol.cg_bobpitch, "cg_bobpitch", "0.002", A),
    cv(ClientVmCvarSymbol.cg_bobroll, "cg_bobroll", "0.002", A),
    cv(ClientVmCvarSymbol.cg_swingSpeed, "cg_swingSpeed", "0.3", C),
    cv(ClientVmCvarSymbol.cg_animSpeed, "cg_animspeed", "1", C),
    cv(ClientVmCvarSymbol.cg_debugAnim, "cg_debuganim", "0", C),
    cv(ClientVmCvarSymbol.cg_debugPosition, "cg_debugposition", "0", C),
    cv(ClientVmCvarSymbol.cg_debugEvents, "cg_debugevents", "0", C),
    cv(ClientVmCvarSymbol.cg_errorDecay, "cg_errordecay", "100"),
    cv(ClientVmCvarSymbol.cg_nopredict, "cg_nopredict", "0"),
    cv(ClientVmCvarSymbol.cg_noPlayerAnims, "cg_noplayeranims", "0", C),
    cv(ClientVmCvarSymbol.cg_showmiss, "cg_showmiss", "0"),
    cv(ClientVmCvarSymbol.cg_footsteps, "cg_footsteps", "1", C),
    cv(ClientVmCvarSymbol.cg_tracerChance, "cg_tracerchance", "0.4", C),
    cv(ClientVmCvarSymbol.cg_tracerWidth, "cg_tracerwidth", "1", C),
    cv(ClientVmCvarSymbol.cg_tracerLength, "cg_tracerlength", "100", C),
    cv(ClientVmCvarSymbol.cg_thirdPersonRange, "cg_thirdPersonRange", "40", C),
    cv(ClientVmCvarSymbol.cg_thirdPersonAngle, "cg_thirdPersonAngle", "0", C),
    cv(ClientVmCvarSymbol.cg_thirdPerson, "cg_thirdPerson", "0"),
    cv(ClientVmCvarSymbol.cg_teamChatTime, "cg_teamChatTime", "3000", A),
    cv(ClientVmCvarSymbol.cg_teamChatHeight, "cg_teamChatHeight", "0", A),
    cv(ClientVmCvarSymbol.cg_forceModel, "cg_forceModel", "0", A),
    cv(ClientVmCvarSymbol.cg_predictItems, "cg_predictItems", "1", A),
    cv(ClientVmCvarSymbol.cg_deferPlayers, "cg_deferPlayers", product === "missionpack" ? "0" : "1", A),
    cv(ClientVmCvarSymbol.cg_drawTeamOverlay, "cg_drawTeamOverlay", "0", A),
    cv(ClientVmCvarSymbol.cg_teamOverlayUserinfo, "teamoverlay", "0", R | U),
    cv(ClientVmCvarSymbol.cg_stats, "cg_stats", "0"),
    cv(ClientVmCvarSymbol.cg_drawFriend, "cg_drawFriend", "1", A),
    cv(ClientVmCvarSymbol.cg_teamChatsOnly, "cg_teamChatsOnly", "0", A),
    cv(ClientVmCvarSymbol.cg_noVoiceChats, "cg_noVoiceChats", "0", A),
    cv(ClientVmCvarSymbol.cg_noVoiceText, "cg_noVoiceText", "0", A),
    cv(ClientVmCvarSymbol.cg_buildScript, "com_buildScript", "0"),
    cv(ClientVmCvarSymbol.cg_paused, "cl_paused", "0", R),
    cv(ClientVmCvarSymbol.cg_blood, "com_blood", "1", A),
    cv(ClientVmCvarSymbol.cg_synchronousClients, "g_synchronousClients", "0"),
  ];
  if (product === "missionpack") table.push(
    cv(ClientVmCvarSymbol.cg_redTeamName, "g_redteam", "Stroggs", A | S | U),
    cv(ClientVmCvarSymbol.cg_blueTeamName, "g_blueteam", "Pagans", A | S | U),
    cv(ClientVmCvarSymbol.cg_currentSelectedPlayer, "cg_currentSelectedPlayer", "0", A),
    cv(ClientVmCvarSymbol.cg_currentSelectedPlayerName, "cg_currentSelectedPlayerName", "", A),
    cv(ClientVmCvarSymbol.cg_singlePlayer, "ui_singlePlayerActive", "0", U),
    cv(ClientVmCvarSymbol.cg_enableDust, "g_enableDust", "0", S),
    cv(ClientVmCvarSymbol.cg_enableBreath, "g_enableBreath", "0", S),
    cv(ClientVmCvarSymbol.cg_singlePlayerActive, "ui_singlePlayerActive", "0", U),
    cv(ClientVmCvarSymbol.cg_recordSPDemo, "ui_recordSPDemo", "0", A),
    cv(ClientVmCvarSymbol.cg_recordSPDemoName, "ui_recordSPDemoName", "", A),
    cv(ClientVmCvarSymbol.cg_obeliskRespawnDelay, "g_obeliskRespawnDelay", "10", S),
    cv(ClientVmCvarSymbol.cg_hudFiles, "cg_hudFiles", "ui/hud.txt", A),
  );
  table.push(
    cv(ClientVmCvarSymbol.cg_cameraOrbit, "cg_cameraOrbit", "0", C),
    cv(ClientVmCvarSymbol.cg_cameraOrbitDelay, "cg_cameraOrbitDelay", "50", A),
    cv(ClientVmCvarSymbol.cg_timescaleFadeEnd, "cg_timescaleFadeEnd", "1"),
    cv(ClientVmCvarSymbol.cg_timescaleFadeSpeed, "cg_timescaleFadeSpeed", "0"),
    cv(ClientVmCvarSymbol.cg_timescale, "timescale", "1"),
    cv(ClientVmCvarSymbol.cg_scorePlum, "cg_scorePlums", "1", U | A),
    cv(ClientVmCvarSymbol.cg_smoothClients, "cg_smoothClients", "0", U | A),
    cv(ClientVmCvarSymbol.cg_cameraMode, "com_cameraMode", "0", C),
    cv(ClientVmCvarSymbol.pmove_fixed, "pmove_fixed", "0"),
    cv(ClientVmCvarSymbol.pmove_msec, "pmove_msec", "8"),
    cv(ClientVmCvarSymbol.cg_noTaunt, "cg_noTaunt", "0", A),
    cv(ClientVmCvarSymbol.cg_noProjectileTrail, "cg_noProjectileTrail", "0", A),
    cv(ClientVmCvarSymbol.cg_smallFont, "ui_smallFont", "0.25", A),
    cv(ClientVmCvarSymbol.cg_bigFont, "ui_bigFont", "0.4", A),
    cv(ClientVmCvarSymbol.cg_oldRail, "cg_oldRail", "1", A),
    cv(ClientVmCvarSymbol.cg_oldRocket, "cg_oldRocket", "1", A),
    cv(ClientVmCvarSymbol.cg_oldPlasma, "cg_oldPlasma", "1", A),
    cv(ClientVmCvarSymbol.cg_trueLightning, "cg_trueLightning", "0.0", A),
  );
  return table;
}

export interface ClientConfigurationHost {
  readonly cvars: CvarRegistry;
  readonly state: ClientGameState;
  readonly staticState: ClientGameStaticState;
  readonly clients: Pick<ClientInfoStore, "newClientInfo">;
  configString(index: number): string;
}

function sourceString(value: string, capacity: number): string {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("Source string capacity must be positive");
  let end = value.length;
  for (let index = 0; index < value.length; index++) {
    const byte = value.charCodeAt(index);
    if (byte === 0) { end = index; break; }
    if (byte > 255) throw new RangeError("Cvar VM strings require source byte characters");
  }
  return value.slice(0, Math.min(end, capacity - 1));
}

function changedSnapshot(engine: CvarSnapshot): CvarSnapshot {
  const value = sourceString(engine.value, MAX_CVAR_VALUE_STRING);
  if (value.length !== engine.value.length) {
    throw new RangeError(`Cvar_Update: src ${engine.value} length ${engine.value.length} exceeds MAX_CVAR_VALUE_STRING`);
  }
  return Object.freeze({ ...engine, value, numericValue: Math.fround(engine.numericValue), integerValue: engine.integerValue,
    modificationCount: engine.modificationCount });
}

/** Instance-owned cvarTable and vmCvar_t cache for one cgame lifecycle. */
export class ClientConfiguration {
  private readonly table: readonly CvarDefinition[];
  private readonly cache = new Map<ClientVmCvarSymbol, CvarSnapshot>();
  private readonly names = new Map<string, ClientVmCvarSymbol>();
  private forceModelModificationCount = 0;
  private drawTeamOverlayModificationCount = -1;
  private registered = false;
  private updating = false;

  constructor(readonly product: Product, readonly host: ClientConfigurationHost) {
    if (host.state.product !== product || host.staticState.product !== product) {
      throw new Error("Client configuration services must share one product");
    }
    this.table = cvarTable(product);
    for (const definition of this.table) {
      this.names.set(definition.name.toLowerCase(), definition.symbol);
      this.cache.set(definition.symbol, Object.freeze({ name: definition.name, value: "", resetValue: "",
        latchedValue: undefined, flags: 0, modified: false, modificationCount: 0, numericValue: 0, integerValue: 0 }));
    }
  }

  registerCvars(): void {
    if (this.updating) throw new Error("Cannot register cvars during a configuration update");
    this.names.clear();
    for (const definition of this.table) {
      const engine = this.host.cvars.register(definition.name, definition.defaultValue, definition.flags);
      this.copyDefinition(definition, engine, true);
      this.names.set(definition.name.toLowerCase(), definition.symbol);
    }
    const running = this.host.cvars.get("sv_running");
    this.host.staticState.localServer = gameAtoi(sourceString(running === undefined ? "" : running.value, MAX_TOKEN_CHARS));
    this.forceModelModificationCount = this.readVmSymbol(ClientVmCvarSymbol.cg_forceModel).modificationCount;
    const teamModel = this.product === "missionpack" ? "james" : "sarge";
    const teamHead = this.product === "missionpack" ? "*james" : "sarge";
    this.host.cvars.register("model", "sarge", U | A);
    this.host.cvars.register("headmodel", "sarge", U | A);
    this.host.cvars.register("team_model", teamModel, U | A);
    this.host.cvars.register("team_headmodel", teamHead, U | A);
    this.registered = true;
  }

  readVmSymbol(symbol: ClientVmCvarSymbol): CvarSnapshot {
    const value = this.cache.get(symbol);
    if (value === undefined) throw new Error(`VM cvar ${symbol} is not registered for ${this.product}`);
    return value;
  }

  /** Direct vmCvar_t field writes do not update its string or engine cvar. */
  setVmNumericValue(symbol: ClientVmCvarSymbol, value: number): void {
    const previous = this.readVmSymbol(symbol);
    this.cache.set(symbol, Object.freeze({ ...previous, numericValue: Math.fround(value) }));
  }

  setVmInteger(symbol: ClientVmCvarSymbol, value: number): void {
    const previous = this.readVmSymbol(symbol);
    this.cache.set(symbol, Object.freeze({ ...previous, integerValue: value | 0 }));
  }

  readVmCvar(name: string): CvarSnapshot {
    const symbol = this.names.get(name.toLowerCase());
    if (symbol === undefined) throw new Error(`Cgame VM cvar ${name} is not registered for ${this.product}`);
    return this.readVmSymbol(symbol);
  }

  async forceModelChange(): Promise<void> {
    if (!this.registered) throw new Error("Client cvars must be registered before forcing models");
    if (this.updating) throw new Error("Client configuration update is already active");
    this.updating = true;
    try { await this.reloadClientInfo(); } finally { this.updating = false; }
  }

  async updateCvars(): Promise<void> {
    if (!this.registered) throw new Error("Client cvars must be registered before updating");
    if (this.updating) throw new Error("Client configuration update is already active");
    this.updating = true;
    try {
      for (const definition of this.table) {
        const engine = this.host.cvars.get(definition.name);
        if (engine !== undefined) this.copyDefinition(definition, engine, false);
      }
      const overlay = this.readVmSymbol(ClientVmCvarSymbol.cg_drawTeamOverlay);
      if (this.drawTeamOverlayModificationCount !== overlay.modificationCount) {
        this.drawTeamOverlayModificationCount = overlay.modificationCount;
        this.host.cvars.set("teamoverlay", overlay.integerValue > 0 ? "1" : "0", true);
        this.host.cvars.set("teamoverlay", "1", true);
      }
      const forceModel = this.readVmSymbol(ClientVmCvarSymbol.cg_forceModel);
      if (this.forceModelModificationCount !== forceModel.modificationCount) {
        this.forceModelModificationCount = forceModel.modificationCount;
        await this.reloadClientInfo();
      }
    } finally { this.updating = false; }
  }

  private copyDefinition(definition: CvarDefinition, engine: CvarSnapshot, forced: boolean): void {
    const previous = this.cache.get(definition.symbol);
    if (!forced && previous !== undefined && previous.modificationCount === engine.modificationCount) return;
    const retained = previous ?? { ...engine, value: "", numericValue: 0, integerValue: 0 };
    const pending = Object.freeze({ ...engine, value: retained.value, numericValue: retained.numericValue,
      integerValue: retained.integerValue, modificationCount: engine.modificationCount });
    this.cache.set(definition.symbol, pending);
    this.cache.set(definition.symbol, changedSnapshot(engine));
  }

  private async reloadClientInfo(): Promise<void> {
    for (let index = 0; index < MAX_CLIENTS; index++) {
      const config = this.host.configString(CS_PLAYERS + index);
      if (config.length > 0) await this.host.clients.newClientInfo(index, config);
    }
  }
}
