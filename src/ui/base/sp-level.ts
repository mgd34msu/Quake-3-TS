// Single-player level menu from id Software q3_ui/ui_splevel.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { PcmSound } from "../../assets/wav.ts";
import { infoValueForKey } from "../../core/info-string.ts";
import { KeyCatcher } from "../../core/key-codes.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { sourceCommandText } from "../../core/text.ts";
import { gameAtoi } from "../../game/numeric.ts";
import { UI_CENTER, UI_LEFT, UI_SMALLFONT } from "../../render/font.ts";
import type { SceneShader } from "../../render/ref-entity.ts";
import type { BaseConfirmMenu } from "./confirm.ts";
import { drawHandle, drawProportional, drawString, fillRect } from "./draw.ts";
import { addItem, drawMenu, menuItemAtCursor, popMenu, pushMenu, setCursorToItem } from "./framework.ts";
import type { BaseUiGameInfo } from "./game-info.ts";
import { MEDAL_PICTURES, MEDAL_SOUNDS } from "./medals.ts";
import type { BasePlayerSettingsMenu } from "./player-settings.ts";
import type { BaseSpSkillMenu } from "./sp-skill.ts";
import type { BaseStartServerMenu } from "./start-server.ts";
import { BaseMenu, COLORS, itemAt, MenuCommon, MenuEvent, MenuFlag } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap } from "./state.ts";

const FOCUS = "menu/art/maps_select", SELECTED = "menu/art/maps_selected";
const ARROW = "menu/art/narrow_0", ARROW_FOCUS = "menu/art/narrow_1", UNKNOWN = "menu/art/unknownmap";
const COMPLETE = ["menu/art/level_complete1", "menu/art/level_complete2", "menu/art/level_complete3", "menu/art/level_complete4", "menu/art/level_complete5"];
const BACK = "menu/art/back_0", BACK_FOCUS = "menu/art/back_1", FIGHT = "menu/art/fight_0", FIGHT_FOCUS = "menu/art/fight_1";
const RESET = "menu/art/reset_0", RESET_FOCUS = "menu/art/reset_1", CUSTOM = "menu/art/skirmish_0", CUSTOM_FOCUS = "menu/art/skirmish_1";
const PULSE = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
const UI_BIGFONT = 0x20, ORANGE = { x: 1, y: Math.fround(.43), z: 0, w: 1 }, YELLOW = { x: 1, y: 1, z: 0, w: 1 };
enum Id { Left = 10, Map = 11, Right = 15, Player = 16, Award = 17, Back = 23, Reset = 24, Custom = 25, Fight = 26 }
function bitmap(): MenuBitmap { return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null, focusshader: null, width: 0, height: 0, focuscolor: null }; }
function upper(value: string): string { return value.replace(/[a-z]/g, byte => String.fromCharCode(byte.charCodeAt(0) - 32)); }
function clean(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    if (value.charAt(i) === "^" && i + 1 < value.length && value.charAt(i + 1) !== "^") i++;
    else if (value.charCodeAt(i) >= 32 && value.charCodeAt(i) <= 126) result += value.charAt(i);
  }
  return result;
}
function info(value: string | null, key: string): string { return infoValueForKey(value === null ? "" : value, key); }
class LevelRecord {
  readonly menu = new BaseMenu();
  readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, style: 0, color: COLORS.black };
  readonly left = bitmap();
  readonly maps = Array.from({ length: 4 }, bitmap);
  readonly right = bitmap();
  readonly player = bitmap();
  readonly awards = Array.from({ length: 6 }, bitmap);
  readonly back = bitmap(); readonly resetButton = bitmap(); readonly custom = bitmap(); readonly fight = bitmap(); readonly nullItem = bitmap();
  reinit = false;
  selectedArenaInfo: string | null = null;
  numMaps = 0;
  readonly levelNames = ["", "", "", ""];
  readonly scores = Array.from({ length: 4 }, () => ({ score: 0, skill: 0 }));
  selectedPic: SceneShader | null = null; focusPic: SceneShader | null = null;
  readonly completePics: (SceneShader | null)[] = Array.from({ length: 5 }, () => null);
  playerModel = ""; playerPicName = "";
  readonly awardLevels = [0, 0, 0, 0, 0, 0];
  readonly awardSounds: (PcmSound | null)[] = Array.from({ length: 6 }, () => null);
  numBots = 0;
  readonly botPics: (SceneShader | null)[] = Array.from({ length: 7 }, () => null);
  readonly botNames = ["", "", "", "", "", "", ""];
  reset(): void {
    this.menu.cursor = 0; this.menu.cursorPrev = 0; this.menu.itemCount = 0; this.menu.items.length = 0;
    this.menu.draw = null; this.menu.key = null; this.menu.wrapAround = false; this.menu.fullscreen = false; this.menu.showlogo = false;
    Object.assign(this.banner.common, new MenuCommon()); this.banner.text = null; this.banner.style = 0; this.banner.color = COLORS.black;
    for (const item of [this.left, ...this.maps, this.right, this.player, ...this.awards, this.back, this.resetButton, this.custom, this.fight, this.nullItem]) {
      Object.assign(item.common, new MenuCommon()); item.focuspic = null; item.errorpic = null; item.shader = null; item.focusshader = null;
      item.width = 0; item.height = 0; item.focuscolor = null;
    }
    this.reinit = false; this.selectedArenaInfo = null; this.numMaps = 0; this.levelNames.fill("");
    for (const score of this.scores) { score.score = 0; score.skill = 0; }
    this.selectedPic = null; this.focusPic = null; this.completePics.fill(null); this.playerModel = ""; this.playerPicName = "";
    this.awardLevels.fill(0); this.awardSounds.fill(null); this.numBots = 0; this.botPics.fill(null); this.botNames.fill("");
  }
}

export class BaseSpLevelMenu {
  private readonly record = new LevelRecord();
  private selectedArenaSet = 0; private selectedArena = 0; private currentSet = 0; private currentGame = 0;
  private trainingTier = 0; private finalTier = 0; private minTier = 0; private maxTier = 0;
  constructor(readonly state: BaseUiState, private readonly gameInfo: BaseUiGameInfo, private readonly skill: BaseSpSkillMenu,
    private readonly playerSettings: BasePlayerSettingsMenu, private readonly startServer: BaseStartServerMenu, private readonly confirm: BaseConfirmMenu) {}
  get menu(): BaseMenu { return this.record.menu; }
  private string(name: string): string { const value = this.state.services.cvars.registry.get(name); return value === undefined ? "" : sourceCommandText(value.value); }
  private setSelection(value: number): void { this.state.services.cvars.registry.set("ui_spSelection", String(qvmFloatToInt(Math.fround(value))), true); }
  private format(value: string, size: number): string {
    if (value.length >= size) {
      this.state.services.print(`Com_sprintf: overflow of ${value.length} in ${size}\n`);
      this.state.assertActive();
    }
    return value.slice(0, size - 1);
  }
  private async shader(name: string): Promise<SceneShader | null> {
    this.state.assertActive();
    const result = await this.state.services.resources.registerShaderNoMip(name); this.state.assertActive(); return result;
  }
  private writePlayerIcon(name: string): void {
    this.record.playerPicName = name;
    if (this.record.player.common.name !== null) this.record.player.common.name = name;
  }
  private async playerIcon(modelAndSkin: string, player: boolean): Promise<string> {
    const text = modelAndSkin.slice(0, 63), slash = text.lastIndexOf("/");
    const model = slash < 0 ? text : text.slice(0, slash), skin = slash < 0 ? "default" : text.slice(slash + 1);
    let name = this.format(`models/players/${model}/icon_${skin}.tga`, 64); if (player) this.writePlayerIcon(name);
    const registered = await this.shader(name); this.state.assertActive();
    if (registered === null && upper(skin) !== "DEFAULT") {
      name = this.format(`models/players/${model}/icon_default.tga`, 64); if (player) this.writePlayerIcon(name);
    }
    return name;
  }
  private async setPlayerIcon(): Promise<void> {
    await this.playerIcon(this.record.playerModel, true); this.state.assertActive();
  }
  private async setBots(): Promise<void> {
    const r = this.record; r.numBots = 0;
    if (this.selectedArenaSet > this.currentSet) return;
    const bots = info(r.selectedArenaInfo, "bots").slice(0, 1023); let p = 0;
    while (p < bots.length && r.numBots < 7) {
      while (bots.charAt(p) === " ") p++;
      const start = p;
      while (p < bots.length && bots.charAt(p) !== " ") p++;
      const bot = bots.slice(start, p); if (p < bots.length) p++;
      const botInfo = this.gameInfo.getBotInfoByName(bot);
      if (botInfo !== null) {
        const name = await this.playerIcon(info(botInfo, "model"), false); this.state.assertActive();
        const pic = await this.shader(name); this.state.assertActive(); r.botPics[r.numBots] = pic;
        r.botNames[r.numBots] = info(botInfo, "name").slice(0, 9);
      } else { r.botPics[r.numBots] = null; r.botNames[r.numBots] = bot.slice(0, 9); }
      r.botNames[r.numBots] = clean(itemAt(r.botNames, r.numBots)); r.numBots++;
    }
  }
  private async setArena(n: number, level: number, arena: string | null): Promise<void> {
    const r = this.record, map = info(arena, "map").slice(0, 63);
    r.levelNames[n] = upper(map.slice(0, 15));
    const score = itemAt(r.scores, n); this.gameInfo.getBestScore(level, score); if (score.score > 8) score.score = 8;
    const name = `levelshots/${map}.tga`;
    if (name.length >= 64) throw new RangeError("UI_SPLevelMenu_SetMenuArena strcpy exceeds source levelPicNames[64]");
    const item = itemAt(r.maps, n); item.common.name = name;
    const registered = await this.shader(name); this.state.assertActive();
    if (registered === null) item.common.name = UNKNOWN;
    item.shader = null;
    if (this.selectedArenaSet > this.currentSet) item.common.flags |= MenuFlag.Grayed;
    else item.common.flags &= ~MenuFlag.Grayed;
    item.common.flags &= ~MenuFlag.Inactive;
  }
  // Bitmap_Init is local here because the shared framework only exposes Menu_AddItem.
  private repositionFirstMap(x: number, extra: number): void {
    const item = itemAt(this.record.maps, 0), c = item.common;
    c.x = x; c.left = x; c.right = x + Math.abs(item.width); c.top = c.y; c.bottom = c.y + Math.abs(item.height) + extra;
    item.shader = null; item.focusshader = null;
  }
  private async setMenuItems(): Promise<void> {
    const r = this.record;
    if (this.selectedArenaSet > this.currentSet) this.selectedArena = -1;
    else if (this.selectedArena === -1) this.selectedArena = 0;
    if (this.selectedArenaSet === this.trainingTier || this.selectedArenaSet === this.finalTier) this.selectedArena = 0;
    if (this.selectedArena !== -1) this.setSelection((this.selectedArenaSet * 4 + this.selectedArena) | 0);
    if (this.selectedArenaSet === this.trainingTier || this.selectedArenaSet === this.finalTier) {
      const arena = this.gameInfo.getSpecialArenaInfo(this.selectedArenaSet === this.trainingTier ? "training" : "final");
      await this.setArena(0, gameAtoi(info(arena, "num")), arena); this.state.assertActive(); r.selectedArenaInfo = arena;
      this.repositionFirstMap(256, 32); r.numMaps = 1;
      for (let n = 1; n < 4; n++) { const map = itemAt(r.maps, n); map.common.flags |= MenuFlag.Inactive; map.common.name = ""; map.shader = null; }
    } else {
      this.repositionFirstMap(46, 18); r.numMaps = 4;
      for (let n = 0; n < 4; n++) {
        const level = (this.selectedArenaSet * 4 + n) | 0;
        await this.setArena(n, level, this.gameInfo.getArenaInfoByNumber(level)); this.state.assertActive();
      }
      if (this.selectedArena !== -1) r.selectedArenaInfo = this.gameInfo.getArenaInfoByNumber((this.selectedArenaSet * 4 + this.selectedArena) | 0);
    }
    const unavailable = MenuFlag.Inactive | MenuFlag.Hidden;
    if (this.selectedArenaSet === this.minTier) r.left.common.flags |= unavailable; else r.left.common.flags &= ~unavailable;
    if (this.selectedArenaSet === this.maxTier) r.right.common.flags |= unavailable; else r.right.common.flags &= ~unavailable;
    await this.setBots(); this.state.assertActive();
  }
  private async resetDraw(): Promise<void> {
    this.state.assertActive();
    const lines = ["WARNING: This resets all of the", "single player game variables.", "Do this only if you want to", "start over from the beginning."];
    for (const [n, text] of lines.entries()) drawProportional(this.state, 320, 356 + 27 * n, text, UI_CENTER | UI_SMALLFONT, YELLOW);
  }
  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive(); if (event !== MenuEvent.Activated) return;
    const id = item.common.id;
    if (id >= Id.Map && id < Id.Right) {
      if (this.selectedArenaSet === this.trainingTier || this.selectedArenaSet === this.finalTier) return;
      this.selectedArena = id - Id.Map;
      this.record.selectedArenaInfo = this.gameInfo.getArenaInfoByNumber((this.selectedArenaSet * 4 + this.selectedArena) | 0);
      await this.setBots(); this.state.assertActive(); this.setSelection((this.selectedArenaSet * 4 + this.selectedArena) | 0);
    } else if (id >= Id.Award && id < Id.Back) {
      const sound = this.state.services.sounds.resolveForPlayback(itemAt(this.record.awardSounds, id - Id.Award));
      if (sound !== null) this.state.services.audio.startLocalSound(sound, 7);
    } else switch (id) {
      case Id.Left:
        if (this.selectedArenaSet === this.minTier) return;
        this.selectedArenaSet = (this.selectedArenaSet - 1) | 0; await this.setMenuItems(); break;
      case Id.Right:
        if (this.selectedArenaSet === this.maxTier) return;
        this.selectedArenaSet = (this.selectedArenaSet + 1) | 0; await this.setMenuItems(); break;
      case Id.Player: await this.playerSettings.show(); break;
      case Id.Back:
        if (this.selectedArena === -1) this.selectedArena = 0;
        await popMenu(this.state); break;
      case Id.Reset:
        await this.confirm.show("RESET GAME?", () => this.resetDraw(), async result => {
          this.state.assertActive(); if (!result) return;
          this.gameInfo.newGame(); this.setSelection(-4);
          await popMenu(this.state); this.state.assertActive(); await this.show(); this.state.assertActive();
        }); break;
      case Id.Custom: await this.startServer.show(false); break;
      case Id.Fight:
        if (this.selectedArenaSet > this.currentSet) return;
        if (this.selectedArena === -1) this.selectedArena = 0;
        await this.skill.show(this.record.selectedArenaInfo); break;
    }
    this.state.assertActive();
  }
  private async draw(): Promise<void> {
    this.state.assertActive(); const r = this.record;
    if (r.reinit) { await popMenu(this.state); this.state.assertActive(); await this.show(); this.state.assertActive(); return; }
    drawProportional(this.state, 320, 314, clean(this.string("name").slice(0, 31)), UI_CENTER | UI_SMALLFONT, ORANGE);
    const model = this.string("model").slice(0, 1023);
    if (upper(model) !== upper(r.playerModel)) {
      r.playerModel = model.slice(0, 63); await this.setPlayerIcon(); this.state.assertActive(); r.player.shader = null;
    }
    await drawMenu(this.state, r.menu); this.state.assertActive();
    let count = 0;
    for (const level of r.awardLevels) {
      if (level <= 0) continue;
      const x = count & 1 ? 224 - (count - 1) / 2 * 64 : 368 + count / 2 * 64; count++;
      if (level === 1) continue;
      const text = level >= 1000000 ? `${Math.trunc(level / 1000000)}m` : level >= 1000 ? `${Math.trunc(level / 1000)}k` : String(level);
      drawString(this.state, x + 24, 388, text, UI_CENTER, YELLOW);
    }
    drawProportional(this.state, 18, 38, `Tier ${(this.selectedArenaSet + 1) | 0}`, UI_LEFT | UI_SMALLFONT, ORANGE);
    for (let n = 0; n < r.numMaps; n++) { const c = itemAt(r.maps, n).common; fillRect(this.state, c.x, c.y + 96, 128, 18, COLORS.black); }
    if (this.selectedArenaSet > this.currentSet) { drawProportional(this.state, 320, 216, "ACCESS DENIED", UI_CENTER | UI_BIGFONT, COLORS.red); return; }
    const color = { ...COLORS.white, w: Math.fround(.5 + .5 * Math.fround(Math.sin(Math.fround(Math.trunc(this.state.realtime / 75))))) };
    for (let n = 0; n < r.numMaps; n++) {
      const item = itemAt(r.maps, n), c = item.common, score = itemAt(r.scores, n);
      drawString(this.state, c.x + 64, c.y + 96, itemAt(r.levelNames, n), UI_CENTER | UI_SMALLFONT, ORANGE);
      if (score.score === 1) drawHandle(this.state, c.x, c.y, 128, 96, itemAt(r.completePics, score.skill - 1));
      if (n === this.selectedArena) {
        if (menuItemAtCursor(r.menu) === item) this.state.draw.setColor(color);
        drawHandle(this.state, c.x - 1, c.y - 1, 130, 116, r.selectedPic); this.state.draw.setColor(null);
      } else if (menuItemAtCursor(r.menu) === item) {
        this.state.draw.setColor(color); drawHandle(this.state, c.x - 31, c.y - 30, 256, 229, r.focusPic); this.state.draw.setColor(null);
      }
    }
    const description = this.format(`${upper(info(r.selectedArenaInfo, "map").slice(0, 19))}: ${info(r.selectedArenaInfo, "longname")}`, 64);
    drawProportional(this.state, 320, 192, description, UI_CENTER | UI_SMALLFONT, ORANGE);
    const pad = Math.trunc((7 - r.numBots) * 90 / 2);
    for (let n = 0; n < r.numBots; n++) {
      const x = 18 + pad + 90 * n, pic = itemAt(r.botPics, n);
      if (pic !== null) drawHandle(this.state, x, 216, 64, 64, pic);
      else { fillRect(this.state, x, 216, 64, 64, COLORS.black); drawProportional(this.state, x + 22, 234, "?", UI_BIGFONT, ORANGE); }
      drawString(this.state, x, 280, itemAt(r.botNames, n), UI_SMALLFONT | UI_LEFT, ORANGE);
    }
  }
  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of [FOCUS, SELECTED, ARROW, ARROW_FOCUS, UNKNOWN, ...COMPLETE, BACK, BACK_FOCUS, FIGHT, FIGHT_FOCUS, RESET, RESET_FOCUS, CUSTOM, CUSTOM_FOCUS]) {
      await this.shader(name); this.state.assertActive();
    }
    for (let n = 0; n < 6; n++) {
      await this.shader(itemAt(MEDAL_PICTURES, n)); this.state.assertActive();
      const sound = await this.state.services.sounds.registerSound(itemAt(MEDAL_SOUNDS, n), false); this.state.assertActive(); this.record.awardSounds[n] = sound;
    }
    const selected = await this.shader(SELECTED); this.state.assertActive(); this.record.selectedPic = selected;
    const focus = await this.shader(FOCUS); this.state.assertActive(); this.record.focusPic = focus;
    for (const [n, name] of COMPLETE.entries()) {
      const complete = await this.shader(name); this.state.assertActive(); this.record.completePics[n] = complete;
    }
  }
  private configure(item: MenuBitmap, id: number, x: number, y: number, width: number, height: number, flags: number, name: string | null, focus: string | null = null): void {
    item.common.id = id; item.common.x = x; item.common.y = y; item.common.flags = flags; item.common.name = name;
    item.common.callback = (target, event) => this.event(target, event); item.width = width; item.height = height; item.focuspic = focus;
  }
  private async initialize(): Promise<void> {
    const skillValue = this.state.services.cvars.registry.get("g_spSkill"), skill = qvmFloatToInt(skillValue === undefined ? 0 : skillValue.numericValue);
    if (skill < 1 || skill > 5) this.state.services.cvars.registry.set("g_spSkill", "2", true);
    const r = this.record; r.reset(); r.menu.fullscreen = true; r.menu.wrapAround = true; r.menu.draw = () => this.draw();
    await this.cache(); this.state.assertActive();
    r.banner.common.x = 320; r.banner.common.y = 16; r.banner.text = "CHOOSE LEVEL"; r.banner.color = COLORS.red; r.banner.style = UI_CENTER;
    this.configure(r.left, Id.Left, 18, 64, 16, 114, PULSE, ARROW, ARROW_FOCUS);
    for (const [n, item] of r.maps.entries()) this.configure(item, Id.Map + n, 46 + 140 * n, 64, 128, 96, MenuFlag.LeftJustify, "");
    this.configure(r.right, Id.Right, 606, 64, -16, 114, PULSE, ARROW, ARROW_FOCUS);
    r.playerModel = this.string("model").slice(0, 63); await this.setPlayerIcon(); this.state.assertActive();
    this.configure(r.player, Id.Player, 288, 340, 64, 64, MenuFlag.LeftJustify | MenuFlag.MouseOnly, r.playerPicName);
    for (let n = 0; n < 6; n++) r.awardLevels[n] = this.gameInfo.getAwardLevel(n);
    r.awardLevels[4] = 100 * Math.trunc(itemAt(r.awardLevels, 4) / 100);
    let count = 0;
    for (let n = 0; n < 6; n++) if (itemAt(r.awardLevels, n) !== 0) {
      const x = count & 1 ? 224 - (count - 1) / 2 * 64 : 368 + count / 2 * 64;
      this.configure(itemAt(r.awards, count), Id.Award + n, x, 340, 48, 48, MenuFlag.LeftJustify | MenuFlag.Silent | MenuFlag.MouseOnly, itemAt(MEDAL_PICTURES, n)); count++;
    }
    this.configure(r.back, Id.Back, 0, 416, 128, 64, PULSE, BACK, BACK_FOCUS);
    this.configure(r.resetButton, Id.Reset, 170, 416, 128, 64, PULSE, RESET, RESET_FOCUS);
    this.configure(r.custom, Id.Custom, 342, 416, 128, 64, PULSE, CUSTOM, CUSTOM_FOCUS);
    this.configure(r.fight, Id.Fight, 640, 416, 128, 64, MenuFlag.RightJustify | MenuFlag.PulseIfFocus, FIGHT, FIGHT_FOCUS);
    this.configure(r.nullItem, 0, 0, 0, 640, 480, MenuFlag.LeftJustify | MenuFlag.MouseOnly | MenuFlag.Silent, null); r.nullItem.common.callback = null;
    for (const item of [r.banner, r.left, ...r.maps]) addItem(this.state, r.menu, item);
    for (const map of r.maps) map.common.bottom += 18;
    addItem(this.state, r.menu, r.right); addItem(this.state, r.menu, r.player);
    for (let n = 0; n < count; n++) addItem(this.state, r.menu, itemAt(r.awards, n));
    for (const item of [r.back, r.resetButton, r.custom, r.fight, r.nullItem]) addItem(this.state, r.menu, item);
    const selection = this.string("ui_spSelection").slice(0, 63);
    if (selection.length !== 0) { const n = gameAtoi(selection); this.selectedArenaSet = Math.trunc(n / 4); this.selectedArena = n % 4; }
    else { this.selectedArenaSet = this.currentSet; this.selectedArena = this.currentGame; }
    await this.setMenuItems(); this.state.assertActive();
  }
  async show(): Promise<void> {
    this.state.assertActive(); this.trainingTier = -1;
    const training = this.gameInfo.getSpecialArenaInfo("training"); this.minTier = training === null ? 0 : this.trainingTier;
    const trainingLevel = training === null ? -2 : gameAtoi(info(training, "num"));
    this.finalTier = this.gameInfo.getNumSPTiers();
    this.maxTier = this.gameInfo.getSpecialArenaInfo("final") !== null ? this.finalTier : Math.max(this.finalTier - 1, this.minTier);
    let level = this.gameInfo.getCurrentGame();
    if (level === -1) { level = this.gameInfo.getNumSPArenas() - 1; if (this.maxTier === this.finalTier) level++; }
    if (level === trainingLevel) { this.currentSet = -1; this.currentGame = 0; }
    else { this.currentSet = Math.trunc(level / 4); this.currentGame = level % 4; }
    await this.initialize(); this.state.assertActive(); await pushMenu(this.state, this.record.menu); this.state.assertActive();
    await setCursorToItem(this.state, this.record.menu, this.record.fight); this.state.assertActive();
  }
  async showFromCommand(): Promise<void> {
    this.state.assertActive(); this.state.services.keys.setCatcher(KeyCatcher.Ui); this.state.menuDepth = 0;
    await this.show(); this.state.assertActive();
  }
  reInit(): void { this.state.assertActive(); this.record.reinit = true; }
}
