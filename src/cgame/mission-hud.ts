// Team Arena HUD from id Software's code/cgame/cg_newdraw.c, cg_main.c and cg_draw.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CommandBuffer } from "../core/commands.ts";
import { posix } from "node:path";
import type { PcmSound } from "../assets/wav.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import type { GameRandom } from "../game/numeric.ts";
import { gameAtof } from "../game/numeric.ts";
import type { FontSet, RegisteredFont, UiAssetRegistry } from "../render/font.ts";
import type { SceneModel, SceneShader } from "../render/ref-entity.ts";
import type { MaterialPicture, PictureAsset } from "../render/draw2d.ts";
import type { EngineUiCinematics } from "../engine/ui-cinematics.ts";
import type { EngineUiModelPainter } from "../engine/ui-model.ts";
import type { VirtualFileSystem } from "../assets/vfs.ts";
import { GameType, MoveType, PersistentIndex, Powerup, Team, statSchema } from "../shared/definitions.ts";
import { findItemForPowerup, itemList } from "../shared/items.ts";
import { ClientVmCvarSymbol } from "./config.ts";
import type { ClientConfiguration } from "./config.ts";
import type { ClientDrawIcons } from "./draw-icons.ts";
import { fadeColor } from "./draw-tools.ts";
import type { ClientMedia } from "./media.ts";
import type { ClientInfoStore } from "./players.ts";
import type { ClientEntity, ClientGameState, ClientGameStaticState } from "./state.ts";
import { UiRuntime } from "../ui/runtime.ts";
import { KeyCode } from "../core/key-codes.ts";
import type { UiCapturedMenu, UiRuntimeAudio, UiRuntimeFeederItem, UiRuntimeResources, UiRuntimeSnapshot, UiWidgetAssets } from "../ui/runtime.ts";
import { loadMenuDefinitions } from "../ui/menu.ts";
import type { UiFontReference, UiGlobalAssets, UiMenuDefinitions, UiMenuRegistrationEvent, UiMenuRegistrationResult } from "../ui/menu.ts";
import type { ScriptSource } from "../script/preprocessor.ts";
import { TeamArenaUiMemory } from "../ui/team-arena/memory.ts";
import { MissionOwnerDraw } from "./mission-owner-draw.ts";

export interface MissionHudHost {
  readonly assets: Pick<VirtualFileSystem, "has" | "readSync">;
  readonly fontRegistry: UiAssetRegistry;
  readonly icons: ClientDrawIcons;
  readonly configuration: Pick<ClientConfiguration, "readVmCvar" | "setVmInteger">;
  readonly cvars: Pick<CvarRegistry, "get" | "set" | "set2">;
  readonly commands: Pick<CommandBuffer, "append">;
  readonly clients: Pick<ClientInfoStore, "loadDeferredPlayers">;
  readonly random: GameRandom;
  readonly cinematics: EngineUiCinematics;
  readonly modelPainter: EngineUiModelPainter;
  readonly audio: UiRuntimeAudio;
  configString(index: number): string;
  resetPlayerEntity(entity: ClientEntity): void;
  print(text: string): void;
  milliseconds(): number;
  setKeyCatcher(mask: number): void;
}

interface TeamOrder { readonly personal: string; readonly team: string; readonly button: string | null }
const ORDERS: readonly TeamOrder[] = [
  { personal: "onoffense", team: "offense", button: "+button7; wait; -button7" },
  { personal: "ondefense", team: "defend", button: "+button8; wait; -button8" },
  { personal: "onpatrol", team: "patrol", button: "+button9; wait; -button9" },
  { personal: "onfollow", team: "followme", button: "+button10; wait; -button10" },
  { personal: "ongetflag", team: "returnflag", button: null },
  { personal: "onfollowcarrier", team: "followflagcarrier", button: null },
  { personal: "oncamping", team: "camp", button: null },
];
export enum MissionScoreFeeder { RED = 5, BLUE = 6, SCOREBOARD = 11 }
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Mission HUD source index ${index} outside ${values.length}`);
  return value;
}
function sourceText(value: string, maximum: number): string {
  const nul = value.indexOf("\0"), text = nul < 0 ? value : value.slice(0, nul);
  if (text.length >= maximum) throw new RangeError(`Mission HUD source string exceeds ${maximum - 1} bytes`);
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 255) throw new RangeError("Mission HUD text requires source byte characters");
  return text;
}
function fold(value: string): string { return value.replace(/[A-Z]/g, character => String.fromCharCode(character.charCodeAt(0) + 32)); }
function assetKey(path: string | null): string | null { return path === null ? null : fold(path); }
function scriptSource(path: string, bytes: Uint8Array): ScriptSource {
  let text = "";
  for (const byte of bytes) { if (byte === 0) break; text += String.fromCharCode(byte); }
  return { path, text };
}
function zeroFont(): RegisteredFont {
  return { name: "", glyphScale: 0, glyphs: Array.from({ length: 256 }, () => ({ height: 0, top: 0, bottom: 0,
    pitch: 0, xSkip: 0, imageWidth: 0, imageHeight: 0, s: 0, t: 0, s2: 0, t2: 0, shaderName: "", picture: null })) };
}
interface LoadedMenus { readonly definitions: UiMenuDefinitions; readonly runtime: UiRuntime }

/** One cgDC/menu lifetime, sharing canonical cg/cgs and the engine registration caches. */
export class MissionHud {
  readonly kind = "available";
  private systemChat = "";
  private teamChat1 = "";
  private teamChat2 = "";
  readonly ownerDraw: MissionOwnerDraw;
  private smallFont = zeroFont();
  private normalFont = zeroFont();
  private bigFont = zeroFont();
  readonly fonts: FontSet;
  private loaded: LoadedMenus | null = null;
  private scoreboard: UiCapturedMenu | null = null;
  private scoreboardFirstTime = true;
  private generation = 0;
  private closed = false;
  private loading = false;
  private capturedMenu: UiCapturedMenu | undefined = undefined;
  private widgetAssets: UiWidgetAssets;
  private fxBase: SceneShader | null = null;
  private readonly fxColors: (SceneShader | null)[] = Array.from({ length: 7 }, () => null);
  private readonly pictures = new Map<string | null, PictureAsset | undefined>();
  private readonly sounds = new Map<string | null, PcmSound | undefined>();
  private readonly models = new Map<string | null, SceneModel>();
  private readonly registeredFonts = new Map<string | null, Map<number, RegisteredFont | null>>();
  private assetDefinitions: UiGlobalAssets | undefined = undefined;
  private readonly memory: TeamArenaUiMemory;

  constructor(readonly state: ClientGameState, readonly staticState: ClientGameStaticState,
    readonly media: ClientMedia, readonly host: MissionHudHost) {
    if (state.product !== "missionpack" || staticState.product !== state.product || media.staticState !== staticState
      || host.icons.state !== state || host.icons.tools.media !== media) throw new Error("Mission HUD requires one Team Arena cgame state and media owner");
    this.memory = new TeamArenaUiMemory("qvm32", text => host.print(text), "cgame");
    const owner = this;
    this.fonts = { profile: "cgame", get small() { return owner.smallFont; }, get normal() { return owner.normalFont; },
      get big() { return owner.bigFont; },
      get smallThreshold() { return owner.host.configuration.readVmCvar("ui_smallFont").numericValue; },
      get bigThreshold() { return owner.host.configuration.readVmCvar("ui_bigFont").numericValue; } };
    this.ownerDraw = new MissionOwnerDraw(state, staticState, media, { icons: host.icons, fonts: () => this.fonts,
      configuration: host.configuration, random: host.random, configString: index => host.configString(index),
      selectedPlayer: () => this.getSelectedPlayer(), chat: () => this.chat() });
    const zero = media.resources.picture(null);
    this.widgetAssets = { whiteShader: media.resources.picture(media.graphics.whiteShader), gradientBar: zero, scrollBar: zero, scrollBarArrowDown: zero, scrollBarArrowUp: zero,
      scrollBarArrowLeft: zero, scrollBarArrowRight: zero, scrollBarThumb: zero, sliderBar: zero, sliderThumb: zero };
  }

  private open(): void { if (this.closed) throw new Error("Mission HUD is disposed"); }
  private registrationCurrent(generation: number): void {
    this.open();
    if (generation !== this.generation) throw new Error("Mission HUD media registration belongs to a retired lifecycle");
  }
  private runtime(): UiRuntime {
    this.open();
    if (this.loaded === null) throw new Error("Mission HUD menus are not loaded");
    return this.loaded.runtime;
  }
  cachedAssets(): { readonly fxBase: SceneShader | null; readonly fxColors: readonly (SceneShader | null)[]; readonly widgets: UiWidgetAssets } {
    return { fxBase: this.fxBase, fxColors: Object.freeze([...this.fxColors]), widgets: this.widgetAssets };
  }
  menuState(): UiRuntimeSnapshot | null { return this.loaded?.runtime.snapshot() ?? null; }
  async assetCache(): Promise<void> {
    this.open();
    const generation = this.generation;
    const shader = async (path: string) => {
      const registered = await this.media.resources.registerShaderNoMip(path);
      this.open();
      if (generation !== this.generation) throw new Error("Mission HUD asset registration belongs to a retired lifecycle");
      return registered;
    };
    const gradientBar = this.media.resources.picture(await shader("ui/assets/gradientbar2.tga"));
    this.fxBase = await shader("menu/art/fx_base");
    const colors = ["red", "yel", "grn", "teal", "blue", "cyan", "white"];
    for (const [index, name] of colors.entries()) this.fxColors[index] = await shader(`menu/art/fx_${name}`);
    const scrollBar = this.media.resources.picture(await shader("ui/assets/scrollbar.tga"));
    const scrollBarArrowDown = this.media.resources.picture(await shader("ui/assets/scrollbar_arrow_dwn_a.tga"));
    const scrollBarArrowUp = this.media.resources.picture(await shader("ui/assets/scrollbar_arrow_up_a.tga"));
    const scrollBarArrowLeft = this.media.resources.picture(await shader("ui/assets/scrollbar_arrow_left.tga"));
    const scrollBarArrowRight = this.media.resources.picture(await shader("ui/assets/scrollbar_arrow_right.tga"));
    const scrollBarThumb = this.media.resources.picture(await shader("ui/assets/scrollbar_thumb.tga"));
    const sliderBar = this.media.resources.picture(await shader("ui/assets/slider2.tga"));
    const sliderThumb = this.media.resources.picture(await shader("ui/assets/sliderbutt_1.tga"));
    this.open();
    this.widgetAssets = { whiteShader: this.media.resources.picture(this.media.graphics.whiteShader), gradientBar, scrollBar, scrollBarArrowDown, scrollBarArrowUp, scrollBarArrowLeft,
      scrollBarArrowRight, scrollBarThumb, sliderBar, sliderThumb };
  }
  otherTeamHasFlag(): boolean { return this.ownerDraw.otherTeamHasFlag(); }
  yourTeamHasFlag(): boolean { return this.ownerDraw.yourTeamHasFlag(); }

  private async registerPicture(path: string | null): Promise<MaterialPicture | undefined> {
    this.open(); const generation = this.generation;
    const shader = await this.media.resources.registerShaderNoMip(path);
    this.registrationCurrent(generation);
    const picture = shader === null ? undefined : this.media.resources.picture(shader);
    this.pictures.set(assetKey(path), picture); return picture;
  }
  private async registerSound(path: string | null): Promise<PcmSound | undefined> {
    this.open(); const generation = this.generation;
    const sound = await this.media.soundBank.registerSound(path, false), handle = sound === null ? undefined : sound;
    this.registrationCurrent(generation);
    this.sounds.set(assetKey(path), handle);
    return handle;
  }
  private async registerModel(path: string | null): Promise<SceneModel> {
    this.open(); const generation = this.generation;
    const model = await this.media.resources.registerModel(path); this.registrationCurrent(generation);
    this.models.set(assetKey(path), model); return model;
  }
  private async registerFont(path: string | null, pointSize: number): Promise<void> {
    this.open(); const generation = this.generation;
    const font = await this.host.fontRegistry.registerFont(path, pointSize); this.registrationCurrent(generation);
    let sizes = this.registeredFonts.get(path);
    if (sizes === undefined) { sizes = new Map<number, RegisteredFont | null>(); this.registeredFonts.set(path, sizes); }
    sizes.set(pointSize, font);
  }
  private async register(event: UiMenuRegistrationEvent): Promise<UiMenuRegistrationResult> {
    this.open(); const generation = this.generation;
    switch (event.kind) {
      case "font": await this.registerFont(event.reference.path, event.reference.pointSize); return;
      case "picture": {
        const picture = await this.registerPicture(event.reference.path); this.registrationCurrent(generation);
        return { handle: picture === undefined ? 0 : picture.material.order };
      }
      case "sound": {
        const sound = await this.registerSound(event.reference.path); this.registrationCurrent(generation);
        return { handle: this.media.soundBank.indexForSound(sound ?? null) };
      }
      case "model": {
        const model = await this.registerModel(event.reference.path); this.registrationCurrent(generation);
        return { handle: this.media.resources.modelHandle(model) };
      }
    }
  }
  private runtimeResources(): UiRuntimeResources {
    return { handles: { kind: "source",
      pictureHandle: picture => {
        this.open();
        if (picture === undefined) return 0;
        if (picture.kind !== "material") throw new Error("Source HUD picture handle requires a registered renderer material");
        return picture.material.order;
      },
      pictureForHandle: handle => {
        this.open(); const generation = this.generation;
        if (handle === 0) return undefined;
        const picture = this.media.resources.picture(this.media.resources.shaderForHandle(handle));
        this.registrationCurrent(generation); return picture;
      },
      modelForHandle: handle => {
        this.open(); const generation = this.generation;
        const model = this.media.resources.modelForHandle(handle); this.registrationCurrent(generation); return model;
      } },
      registerFont: (path, pointSize) => this.registerFont(path, pointSize),
      registerPicture: path => this.registerPicture(path), registeredPicture: path => { this.open(); return this.pictures.get(assetKey(path)); },
      registerSound: path => this.registerSound(path), registeredSound: path => { this.open(); return this.sounds.get(assetKey(path)); },
      registerModel: path => this.registerModel(path), registeredModel: path => { this.open(); return this.models.get(assetKey(path)); },
      prepareCinematic: path => this.host.cinematics.owner.prepare(path) };
  }
  private font(reference: UiFontReference): RegisteredFont | null {
    const registered = this.registeredFonts.get(reference.path)?.get(reference.pointSize);
    if (registered === undefined) throw new Error("HUD font declaration has no completed registration");
    return registered;
  }
  private source(path: string): ScriptSource | undefined {
    if (!this.host.assets.has(path)) return undefined;
    return scriptSource(path, this.host.assets.readSync(path));
  }
  getMenuBuffer(filename: string): string | null {
    this.open();
    if (!this.host.assets.has(filename)) {
      this.host.print(`^1menu file not found: ${filename}, using default\n`);
      return null;
    }
    const data = this.host.assets.readSync(filename);
    if (data.length >= 32768) {
      this.host.print(`^1menu file too large: ${filename} is ${data.length}, max allowed is 32768`);
      return null;
    }
    return scriptSource(filename, data).text;
  }
  resetStrings(): void {
    this.open(); this.generation++;
    this.memory.initializeStrings();
    this.loaded?.runtime.resetDefinitions("strings");
  }
  resetMenus(): void { this.open(); this.generation++; this.loaded?.runtime.resetDefinitions("menus"); }
  async loadHudMenu(): Promise<void> {
    this.resetMenus();
    const requested = this.host.cvars.get("cg_hudFiles")?.value.slice(0, 1023) ?? "";
    await this.loadMenus(requested.length === 0 ? "ui/hud.txt" : requested);
  }
  async loadMenus(path: string): Promise<void> {
    this.open();
    if (this.loading) throw new Error("Mission HUD menu registration is already active");
    const started = this.host.milliseconds();
    if (!this.host.assets.has(path)) throw new Error(`^3menu file not found: ${path}, using default\n`);
    let generation = this.generation;
    const current = () => {
      this.open();
      if (generation !== this.generation) throw new Error("Mission HUD menu load belongs to a retired lifecycle");
    };
    this.loading = true;
    try {
      const bytes = this.host.assets.readSync(path);
      current();
      if (bytes.length >= 4096) throw new Error(`^1menu file too large: ${path} is ${bytes.length}, max allowed is 4096`);
      const rootSource = scriptSource(path, bytes);
      this.resetMenus(); generation = this.generation;
      const definitions = await loadMenuDefinitions({ random: { nextInt: () => this.host.random.rand() },
        resolver: { resolveRoot: requested => requested === path ? rootSource : this.source(requested),
          resolve: request => this.source(posix.join(posix.dirname(request.fromPath), request.requestedPath))
            ?? this.source(request.requestedPath) } },
      { kind: "hud", setPath: path }, {}, { memory: { kind: "qvm32", memory: this.memory }, registrationSink: { register: async event => {
        current(); const result = await this.register(event); current(); return result;
      } },
        assetSink: { publish: event => {
          current();
          if (event.field !== "smallFont" && event.field !== "textFont" && event.field !== "bigFont") return;
          const font = this.font(event.value);
          if (font === null) return;
          if (event.field === "smallFont") this.smallFont = font;
          else if (event.field === "textFont") this.normalFont = font;
          else this.bigFont = font;
        } },
        ...(this.assetDefinitions === undefined ? {} : { initialAssets: this.assetDefinitions }) });
      current();
      this.assetDefinitions = definitions.assets;
      const gradient = definitions.assets.gradientBar;
      if (gradient !== undefined) this.widgetAssets = { ...this.widgetAssets,
        gradientBar: this.pictures.get(assetKey(gradient.path)) ?? this.media.resources.picture(null) };
      if (this.loaded !== null) {
        await this.loaded.runtime.reloadDefinitions(definitions);
        current();
        this.loaded = { definitions, runtime: this.loaded.runtime };
      } else {
        const owner = this;
        const runtime = await UiRuntime.create({ definitions, cvars: this.host.cvars, commands: this.host.commands,
          cvarValue: name => gameAtof(this.host.cvars.get(name)?.value.slice(0, 127) ?? ""),
          resources: this.runtimeResources(), fonts: this.fonts, get widgetAssets() { return owner.widgetAssets; },
          zeroPicture: this.media.resources.picture(null), audio: this.host.audio, cinematics: this.host.cinematics,
          paintModel: request => this.host.modelPainter.paint(request), context: { kind: "cgame" },
          // CG_FeederItemImage returns handle zero; text-column optional images are a separate callback.
          feeder: { count: feeder => this.feederCount(feeder), image: () => undefined,
            item: (feeder, index, column) => this.feederItem(feeder, index, column),
            select: (feeder, index) => this.feederSelection(feeder, index) },
          ownerDraw: { visible: flags => this.ownerDraw.visible(flags), width: (id, scale) => this.ownerDraw.width(id, scale),
            value: id => this.ownerDraw.value(id), handleKey: (_id, _flags, special, _key) => ({ handled: false, special }),
            paint: request => this.ownerDraw.paint(request), closeCinematic: handle => { this.host.cinematics.owner.stopSlot(handle); } },
          // CG_RunMenuScript is empty in the original cgame module.
          externalScript: { run: () => {} }, getTeamColor: () => {
            const team = this.snapshot().persistant.get(PersistentIndex.PERS_TEAM);
            return team === Team.TEAM_RED ? { x: 1, y: 0, z: 0, w: 0.25 }
              : team === Team.TEAM_BLUE ? { x: 0, y: 0, z: 1, w: 0.25 } : { x: 0, y: Math.fround(0.17), z: 0, w: 0.25 };
          } });
        try { current(); } catch (error: unknown) { runtime.retire(); throw error; }
        this.loaded = { definitions, runtime };
      }
      this.host.print(`UI menu load time = ${(this.host.milliseconds() - started) | 0} milli seconds\n`);
    } finally { this.loading = false; }
  }
  dispose(): void {
    if (this.closed) return;
    this.generation++; this.closed = true; this.loaded?.runtime.retire(); this.loaded = null; this.capturedMenu = undefined;
  }

  private snapshot() {
    const snapshot = this.state.snap;
    if (snapshot === null) throw new Error("Mission HUD operation requires cg.snap");
    return snapshot.playerState;
  }
  private selected(): number { return this.host.configuration.readVmCvar("cg_currentSelectedPlayer").integerValue; }
  private setSelected(value: number): void { this.host.configuration.setVmInteger(ClientVmCvarSymbol.cg_currentSelectedPlayer, value); }
  private setCvar(name: string, value: string): void { this.host.cvars.set(name, value, true); }

  initTeamChat(): void { this.systemChat = ""; this.teamChat1 = ""; this.teamChat2 = ""; }
  setPrintString(type: number, value: string): void {
    const text = sourceText(value, 256);
    if (type === 0) this.systemChat = text;
    else { this.teamChat2 = this.teamChat1; this.teamChat1 = text; }
  }
  chat(): { readonly system: string; readonly team1: string; readonly team2: string } {
    return { system: this.systemChat, team1: this.teamChat1, team2: this.teamChat2 };
  }

  checkOrderPending(): void {
    const cgs = this.staticState;
    if (cgs.gameType < GameType.GT_CTF || !cgs.orderPending) return;
    const order = ORDERS[cgs.currentOrder - 1], selected = this.selected();
    if (selected === this.state.numSortedTeamPlayers) {
      if (order === undefined) throw new Error("CG_CheckOrderPending: Everyone order has no source voice command");
      this.host.commands.append(`cmd vsay_team ${order.team}\n`);
    } else {
      const client = at(this.state.sortedTeamPlayers, selected);
      if (client === this.snapshot().clientNum && order !== undefined) {
        this.host.commands.append(`teamtask ${cgs.currentOrder}\n`);
        this.host.commands.append(`cmd vsay_team ${order.personal}\n`);
      } else if (order !== undefined) this.host.commands.append(`cmd vtell ${client} ${order.team}\n`);
    }
    if (order !== undefined && order.button !== null) this.host.commands.append(order.button);
    cgs.orderPending = false;
  }

  private setSelectedPlayerName(): void {
    const index = this.selected();
    if (index >= 0 && index < this.state.numSortedTeamPlayers) {
      const number = at(this.state.sortedTeamPlayers, index), client = at(this.staticState.clientInfo, number);
      this.setCvar("cg_selectedPlayerName", client.name);
      this.setCvar("cg_selectedPlayer", `${number}`);
      this.staticState.currentOrder = client.teamTask;
    } else this.setCvar("cg_selectedPlayerName", "Everyone");
  }
  getSelectedPlayer(): number {
    const index = this.selected();
    if (index < 0 || index >= this.state.numSortedTeamPlayers) this.setSelected(0);
    return this.selected();
  }
  selectNextPlayer(): void {
    this.checkOrderPending();
    const index = this.selected();
    this.setSelected(index >= 0 && index < this.state.numSortedTeamPlayers ? (index + 1) | 0 : 0);
    this.setSelectedPlayerName();
  }
  selectPreviousPlayer(): void {
    this.checkOrderPending();
    const index = this.selected();
    this.setSelected(index > 0 && index < this.state.numSortedTeamPlayers ? (index - 1) | 0 : this.state.numSortedTeamPlayers);
    this.setSelectedPlayerName();
  }

  feederCount(feeder: number): number {
    if (feeder === MissionScoreFeeder.SCOREBOARD) return this.state.numScores;
    const team = feeder === MissionScoreFeeder.RED ? Team.TEAM_RED : feeder === MissionScoreFeeder.BLUE ? Team.TEAM_BLUE : null;
    if (team === null) return 0;
    let count = 0;
    for (let i = 0; i < this.state.numScores; i++) if (at(this.state.scores, i).team === team) count++;
    return count;
  }
  private infoFromScoreIndex(index: number, team: number) {
    let scoreIndex = index;
    if (this.staticState.gameType >= GameType.GT_TEAM) {
      let count = 0;
      for (let i = 0; i < this.state.numScores; i++) {
        if (at(this.state.scores, i).team !== team) continue;
        if (count === index) { scoreIndex = i; break; }
        count++;
      }
    }
    const score = at(this.state.scores, scoreIndex);
    return { score, info: at(this.staticState.clientInfo, score.client) };
  }
  feederItem(feeder: number, index: number, column: number): UiRuntimeFeederItem {
    const team = feeder === MissionScoreFeeder.RED ? Team.TEAM_RED : feeder === MissionScoreFeeder.BLUE ? Team.TEAM_BLUE : -1;
    const { score, info } = this.infoFromScoreIndex(index, team);
    let text = "";
    let picture: UiRuntimeFeederItem["picture"];
    if (info.infoValid) switch (column) {
      case 0: {
        let powerup: Powerup | null = null;
        if ((info.powerups & (1 << Powerup.PW_NEUTRALFLAG)) !== 0) powerup = Powerup.PW_NEUTRALFLAG;
        else if ((info.powerups & (1 << Powerup.PW_REDFLAG)) !== 0) powerup = Powerup.PW_REDFLAG;
        else if ((info.powerups & (1 << Powerup.PW_BLUEFLAG)) !== 0) powerup = Powerup.PW_BLUEFLAG;
        if (powerup !== null) {
          const item = findItemForPowerup(this.state.product, powerup);
          if (item === null) throw new Error("Mission HUD flag has no source item");
          const visual = at(this.media.weaponRegistry.items, itemList(this.state.product).indexOf(item));
          picture = this.media.resources.picture(visual.icon);
        } else if (info.botSkill > 0 && info.botSkill <= 5) {
          const shader = at(this.media.graphics.botSkillShaders, info.botSkill - 1);
          picture = this.media.resources.picture(shader);
        } else if (info.handicap < 100) text = `${info.handicap}`;
        break;
      }
      case 1: {
        if (team !== -1) {
          const shader = this.ownerDraw.statusHandle(info.teamTask);
          picture = this.media.resources.picture(shader);
        }
        break;
      }
      case 2:
        if ((this.snapshot().stats.get(statSchema(this.state.product).clientsReady) & (1 << score.client)) !== 0) text = "Ready";
        else if (team === -1) {
          if (this.staticState.gameType === GameType.GT_TOURNAMENT) text = `${info.wins}/${info.losses}`;
          else if (info.team === Team.TEAM_SPECTATOR) text = "Spectator";
        } else if (info.teamLeader) text = "Leader";
        break;
      case 3: text = info.name; break;
      case 4: text = `${info.score}`; break;
      case 5: text = `${score.time}`.padStart(4); break;
      case 6: text = score.ping === -1 ? "connecting" : `${score.ping}`.padStart(4); break;
    }
    return { text, picture };
  }
  feederSelection(feeder: number, index: number): void {
    if (this.staticState.gameType < GameType.GT_TEAM) { this.state.selectedScore = index; return; }
    const team = feeder === MissionScoreFeeder.RED ? Team.TEAM_RED : Team.TEAM_BLUE;
    let count = 0;
    for (let i = 0; i < this.state.numScores; i++) {
      if (at(this.state.scores, i).team !== team) continue;
      if (index === count) this.state.selectedScore = i;
      count++;
    }
  }

  setScoreSelection(): void;
  setScoreSelection(menu: UiCapturedMenu): Promise<void>;
  setScoreSelection(menu?: UiCapturedMenu): void | Promise<void> {
    const player = this.snapshot();
    let red = 0, blue = 0;
    for (let i = 0; i < this.state.numScores; i++) {
      const score = at(this.state.scores, i);
      if (score.team === Team.TEAM_RED) red++;
      else if (score.team === Team.TEAM_BLUE) blue++;
      if (player.clientNum === score.client) this.state.selectedScore = i;
    }
    if (menu === undefined) return;
    if (this.loaded === null) return Promise.resolve();
    if (this.staticState.gameType >= GameType.GT_TEAM) {
      const isBlue = at(this.state.scores, this.state.selectedScore).team === Team.TEAM_BLUE;
      return this.loaded.runtime.setCapturedFeederSelection(menu, isBlue ? MissionScoreFeeder.BLUE : MissionScoreFeeder.RED, isBlue ? blue : red);
    }
    return this.loaded.runtime.setCapturedFeederSelection(menu, MissionScoreFeeder.SCOREBOARD, this.state.selectedScore);
  }
  clearScoreboard(): void { this.scoreboard = null; }
  menuScoreboard(): UiCapturedMenu | null { return this.scoreboard; }
  async scrollFeeder(menu: UiCapturedMenu, feeder: number, down: boolean): Promise<void> {
    if (menu !== this.scoreboard) throw new Error("Score scrolling requires the current Mission HUD scoreboard");
    await this.runtime().scrollCapturedFeeder(menu, feeder, down);
  }
  // cgDC.realTime/frameTime are never assigned by the original cgame module.
  private frame() { return { time: 0, frameTime: 0, draw: this.host.icons.tools.draw }; }
  async paintAll(): Promise<void> { this.open(); if (this.loaded !== null) await this.loaded.runtime.frame(this.frame()); }
  async drawScoreboard(): Promise<boolean> {
    this.open();
    const state = this.state, type = state.predictedPlayerState.pmType;
    if (this.scoreboard !== null && this.loaded !== null) this.loaded.runtime.clearCapturedForced(this.scoreboard);
    if (this.host.configuration.readVmCvar("cl_paused").integerValue !== 0
      || (this.staticState.gameType === GameType.GT_SINGLE_PLAYER && type === MoveType.PM_INTERMISSION)) {
      state.deferredPlayerLoading = 0; this.scoreboardFirstTime = true; return false;
    }
    if (state.warmup !== 0 && !state.showScores) return false;
    if (!state.showScores && type !== MoveType.PM_DEAD && type !== MoveType.PM_INTERMISSION
      && fadeColor(state.time, state.scoreFadeTime, 200) === null) {
      state.deferredPlayerLoading = 0; state.killerName = ""; this.scoreboardFirstTime = true; return false;
    }
    if (this.scoreboard === null && this.loaded !== null) {
      const name = this.staticState.gameType >= GameType.GT_TEAM ? "teamscore_menu" : "score_menu";
      this.scoreboard = this.loaded.runtime.menuHandle(name) ?? null;
    }
    if (this.scoreboard !== null && this.loaded !== null) {
      if (this.scoreboardFirstTime) { await this.setScoreSelection(this.scoreboard); this.open(); this.scoreboardFirstTime = false; }
      await this.loaded.runtime.paintCaptured(this.scoreboard, this.frame(), true);
    }
    state.deferredPlayerLoading = (state.deferredPlayerLoading + 1) | 0;
    if (state.deferredPlayerLoading > 10) await this.host.clients.loadDeferredPlayers(entity => this.host.resetPlayerEntity(entity));
    return true;
  }
  async closeByName(name: string): Promise<void> { this.open(); await this.loaded?.runtime.close(name); }
  async showResponseHead(): Promise<void> {
    this.open();
    await this.loaded?.runtime.show("voiceMenu");
    this.setCvar("cl_conXOffset", "72");
    this.state.voiceTime = this.state.time;
  }
  async drawTimedMenus(): Promise<void> {
    if (this.state.voiceTime !== 0 && ((this.state.time - this.state.voiceTime) | 0) > 2500) {
      await this.closeByName("voiceMenu"); this.setCvar("cl_conXOffset", "0"); this.state.voiceTime = 0;
    }
  }
  clientNumFromName(name: string): number {
    const text = fold(sourceText(name, name.length + 1));
    for (let i = 0; i < this.staticState.maxclients; i++) {
      const client = at(this.staticState.clientInfo, i);
      if (client.infoValid && fold(client.name) === text) return i;
    }
    return -1;
  }
  async hideTeamMenu(): Promise<void> { await this.closeByName("teamMenu"); await this.closeByName("getMenu"); }
  async showTeamMenu(): Promise<void> { this.open(); await this.loaded?.runtime.show("teamMenu"); }
  async eventHandling(type: number): Promise<void> {
    this.staticState.eventHandling = type | 0;
    if (type === 0) await this.hideTeamMenu();
  }
  async mouseEvent(x: number, y: number): Promise<void> {
    // vmMain copies the old cgs cursor into cgDC before CG_MouseEvent applies its delta.
    this.loaded?.runtime.setDisplayCursor(this.staticState.cursorX, this.staticState.cursorY);
    const type = this.state.predictedPlayerState.pmType;
    if ((type === MoveType.PM_NORMAL || type === MoveType.PM_SPECTATOR) && !this.state.showScores) {
      this.host.setKeyCatcher(0); return;
    }
    const cgs = this.staticState;
    cgs.cursorX = Math.max(0, Math.min(640, (cgs.cursorX + x) | 0));
    cgs.cursorY = Math.max(0, Math.min(480, (cgs.cursorY + y) | 0));
    const runtime = this.loaded?.runtime;
    const cursor = runtime === undefined ? "arrow" : runtime.cursorType(cgs.cursorX, cgs.cursorY);
    cgs.activeCursor = cursor === "arrow" ? this.media.graphics.selectCursor : this.media.graphics.sizeCursor;
    if (runtime === undefined) return;
    if (this.capturedMenu !== undefined) runtime.moveCapturedMenu(this.capturedMenu, x, y);
    else await runtime.pointerMove(cgs.cursorX, cgs.cursorY);
  }
  async keyEvent(key: number, down: boolean): Promise<void> {
    if (!down) return;
    const type = this.state.predictedPlayerState.pmType;
    if (type === MoveType.PM_NORMAL || (type === MoveType.PM_SPECTATOR && !this.state.showScores)) {
      await this.eventHandling(0); this.host.setKeyCatcher(0); return;
    }
    const runtime = this.loaded?.runtime;
    if (runtime !== undefined) await runtime.handleKey({ kind: "key", code: key, down }, this.staticState.cursorX, this.staticState.cursorY);
    if (this.capturedMenu !== undefined) this.capturedMenu = undefined;
    else if (key === KeyCode.Mouse2 && runtime !== undefined) this.capturedMenu = runtime.captureMenu(this.staticState.cursorX, this.staticState.cursorY);
  }
}
