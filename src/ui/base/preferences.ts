// Genuine game-options menu from id Software q3_ui/ui_preferences.c. GPL-2.0-or-later.
import { UI_BLINK, UI_CENTER, UI_PULSE, UI_RIGHT, UI_SMALLFONT } from "../../render/font.ts";
import type { SceneShader } from "../../render/ref-entity.ts";
import { clampCvar, drawChar, drawHandle, drawString, fillRect } from "./draw.ts";
import { addItem, popMenu, pushMenu } from "./framework.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag, itemAt, menuParent, nativeInt } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap, MenuRadio, MenuSpin, MenuText } from "./state.ts";

const PREFERENCES_X = 360;
const CROSSHAIR_COUNT = 10;
const FRAME_LEFT = "menu/art/frame2_l";
const FRAME_RIGHT = "menu/art/frame1_r";
const BACK = "menu/art/back_0";
const BACK_FOCUS = "menu/art/back_1";
const TEAM_OVERLAYS: readonly string[] = ["off", "upper right", "lower right", "lower left"];

enum PreferenceId {
  Crosshair = 127,
  SimpleItems = 128,
  HighQualitySky = 129,
  EjectingBrass = 130,
  WallMarks = 131,
  DynamicLights = 132,
  IdentifyTarget = 133,
  SyncEveryFrame = 134,
  ForceModel = 135,
  DrawTeamOverlay = 136,
  AllowDownload = 137,
  Back = 138,
}

function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null, focusshader: null,
    width: 0, height: 0, focuscolor: null };
}

function radio(): MenuRadio {
  return { kind: "radio", common: new MenuCommon(), curvalue: 0 };
}

function text(): MenuText {
  return { kind: "text", common: new MenuCommon(), text: null, style: 0, color: COLORS.white };
}

function resetCommon(item: BaseMenuItem): void {
  Object.assign(item.common, new MenuCommon());
}

function resetBitmap(item: MenuBitmap): void {
  resetCommon(item);
  item.focuspic = null;
  item.errorpic = null;
  item.shader = null;
  item.focusshader = null;
  item.width = 0;
  item.height = 0;
  item.focuscolor = null;
}

class PreferencesRecord {
  readonly menu = new BaseMenu();
  readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, style: 0, color: COLORS.white };
  readonly frameLeft = bitmap();
  readonly frameRight = bitmap();
  readonly crosshair = text();
  readonly simpleItems = radio();
  readonly brass = radio();
  readonly wallMarks = radio();
  readonly dynamicLights = radio();
  readonly identifyTarget = radio();
  readonly highQualitySky = radio();
  readonly syncEveryFrame = radio();
  readonly forceModel = radio();
  readonly drawTeamOverlay: MenuSpin = { kind: "spin", common: new MenuCommon(), oldvalue: 0, curvalue: 0, numitems: 0,
    top: 0, itemnames: TEAM_OVERLAYS, width: 0, height: 0, columns: 0, separation: 0 };
  readonly allowDownload = radio();
  readonly back = bitmap();
  readonly crosshairShaders: Array<SceneShader | null> = Array.from({ length: CROSSHAIR_COUNT }, () => null);
  crosshairValue = 0;

  reset(): void {
    this.menu.cursor = 0;
    this.menu.cursorPrev = 0;
    this.menu.itemCount = 0;
    this.menu.items.length = 0;
    this.menu.draw = null;
    this.menu.key = null;
    this.menu.wrapAround = false;
    this.menu.fullscreen = false;
    this.menu.showlogo = false;

    resetCommon(this.banner);
    this.banner.text = null;
    this.banner.style = 0;
    this.banner.color = COLORS.white;
    resetBitmap(this.frameLeft);
    resetBitmap(this.frameRight);
    resetCommon(this.crosshair);
    this.crosshair.text = null;
    this.crosshair.style = 0;
    this.crosshair.color = COLORS.white;
    for (const item of [this.simpleItems, this.brass, this.wallMarks, this.dynamicLights, this.identifyTarget,
      this.highQualitySky, this.syncEveryFrame, this.forceModel, this.allowDownload]) {
      resetCommon(item);
      item.curvalue = 0;
    }
    resetCommon(this.drawTeamOverlay);
    this.drawTeamOverlay.oldvalue = 0;
    this.drawTeamOverlay.curvalue = 0;
    this.drawTeamOverlay.numitems = 0;
    this.drawTeamOverlay.top = 0;
    this.drawTeamOverlay.itemnames = TEAM_OVERLAYS;
    this.drawTeamOverlay.width = 0;
    this.drawTeamOverlay.height = 0;
    this.drawTeamOverlay.columns = 0;
    this.drawTeamOverlay.separation = 0;
    resetBitmap(this.back);
    this.crosshairShaders.fill(null);
    this.crosshairValue = 0;
  }
}

export class BasePreferencesMenu {
  private readonly record = new PreferencesRecord();

  constructor(readonly state: BaseUiState) {}

  get menu(): BaseMenu { return this.record.menu; }

  private variableValue(name: string): number {
    this.state.assertActive();
    const variable = this.state.services.cvars.registry.get(name);
    return variable === undefined ? 0 : variable.numericValue;
  }

  private setValue(name: string, value: number): void {
    this.state.assertActive();
    this.state.services.cvars.registry.setValue(name, value);
  }

  private setMenuItems(): void {
    this.record.crosshairValue = nativeInt(this.variableValue("cg_drawCrosshair")) % CROSSHAIR_COUNT;
    this.record.simpleItems.curvalue = this.variableValue("cg_simpleItems") !== 0 ? 1 : 0;
    this.record.brass.curvalue = this.variableValue("cg_brassTime") !== 0 ? 1 : 0;
    this.record.wallMarks.curvalue = this.variableValue("cg_marks") !== 0 ? 1 : 0;
    this.record.identifyTarget.curvalue = this.variableValue("cg_drawCrosshairNames") !== 0 ? 1 : 0;
    this.record.dynamicLights.curvalue = this.variableValue("r_dynamiclight") !== 0 ? 1 : 0;
    this.record.highQualitySky.curvalue = this.variableValue("r_fastsky") === 0 ? 1 : 0;
    this.record.syncEveryFrame.curvalue = this.variableValue("r_finish") !== 0 ? 1 : 0;
    this.record.forceModel.curvalue = this.variableValue("cg_forcemodel") !== 0 ? 1 : 0;
    this.record.drawTeamOverlay.curvalue = nativeInt(clampCvar(0, 3, this.variableValue("cg_drawTeamOverlay")));
    this.record.allowDownload.curvalue = this.variableValue("cl_allowDownload") !== 0 ? 1 : 0;
  }

  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated)
      return;
    switch (item.common.id) {
      case PreferenceId.Crosshair:
        this.record.crosshairValue++;
        if (this.record.crosshairValue === CROSSHAIR_COUNT)
          this.record.crosshairValue = 0;
        this.setValue("cg_drawCrosshair", this.record.crosshairValue);
        break;
      case PreferenceId.SimpleItems:
        this.setValue("cg_simpleItems", this.record.simpleItems.curvalue);
        break;
      case PreferenceId.HighQualitySky:
        this.setValue("r_fastsky", this.record.highQualitySky.curvalue === 0 ? 1 : 0);
        break;
      case PreferenceId.EjectingBrass:
        if (this.record.brass.curvalue !== 0)
          this.state.services.cvars.registry.reset("cg_brassTime");
        else
          this.setValue("cg_brassTime", 0);
        break;
      case PreferenceId.WallMarks:
        this.setValue("cg_marks", this.record.wallMarks.curvalue);
        break;
      case PreferenceId.DynamicLights:
        this.setValue("r_dynamiclight", this.record.dynamicLights.curvalue);
        break;
      case PreferenceId.IdentifyTarget:
        this.setValue("cg_drawCrosshairNames", this.record.identifyTarget.curvalue);
        break;
      case PreferenceId.SyncEveryFrame:
        this.setValue("r_finish", this.record.syncEveryFrame.curvalue);
        break;
      case PreferenceId.ForceModel:
        this.setValue("cg_forcemodel", this.record.forceModel.curvalue);
        break;
      case PreferenceId.DrawTeamOverlay:
        this.setValue("cg_drawTeamOverlay", this.record.drawTeamOverlay.curvalue);
        break;
      case PreferenceId.AllowDownload:
        this.setValue("cl_allowDownload", this.record.allowDownload.curvalue);
        this.setValue("sv_allowDownload", this.record.allowDownload.curvalue);
        break;
      case PreferenceId.Back:
        await popMenu(this.state);
        this.state.assertActive();
        break;
    }
  }

  private async drawCrosshair(item: BaseMenuItem): Promise<void> {
    this.state.assertActive();
    const common = item.common;
    const focused = menuParent(item).cursor === common.menuPosition;
    let style = UI_SMALLFONT;
    let color = COLORS.normal;
    if ((common.flags & MenuFlag.Grayed) !== 0)
      color = COLORS.disabled;
    else if (focused) {
      color = COLORS.highlight;
      style |= UI_PULSE;
    }
    else if ((common.flags & MenuFlag.Blink) !== 0) {
      color = COLORS.highlight;
      style |= UI_BLINK;
    }
    if (focused) {
      fillRect(this.state, common.left, common.top, common.right - common.left + 1, common.bottom - common.top + 1, COLORS.listbar);
      drawChar(this.state, common.x, common.y, 13, UI_CENTER | UI_BLINK | UI_SMALLFONT, color);
    }
    drawString(this.state, common.x - 8, common.y, common.name, style | UI_RIGHT, color);
    if (this.record.crosshairValue === 0)
      return;
    drawHandle(this.state, common.x + 8, common.y - 4, 24, 24, itemAt(this.record.crosshairShaders, this.record.crosshairValue));
  }

  private configureRadio(item: MenuRadio, id: PreferenceId, name: string, y: number): void {
    item.common.name = name;
    item.common.flags = MenuFlag.PulseIfFocus | MenuFlag.SmallFont;
    item.common.callback = (item, event) => this.event(item, event);
    item.common.id = id;
    item.common.x = PREFERENCES_X;
    item.common.y = y;
  }

  private initializeMenu(): void {
    const record = this.record;
    record.menu.wrapAround = true;
    record.menu.fullscreen = true;

    record.banner.common.x = 320;
    record.banner.common.y = 16;
    record.banner.text = "GAME OPTIONS";
    record.banner.color = COLORS.white;
    record.banner.style = UI_CENTER;

    record.frameLeft.common.name = FRAME_LEFT;
    record.frameLeft.common.flags = MenuFlag.Inactive;
    record.frameLeft.common.x = 0;
    record.frameLeft.common.y = 78;
    record.frameLeft.width = 256;
    record.frameLeft.height = 329;

    record.frameRight.common.name = FRAME_RIGHT;
    record.frameRight.common.flags = MenuFlag.Inactive;
    record.frameRight.common.x = 376;
    record.frameRight.common.y = 76;
    record.frameRight.width = 256;
    record.frameRight.height = 334;

    let y = 144;
    record.crosshair.common.flags = MenuFlag.PulseIfFocus | MenuFlag.SmallFont | MenuFlag.NoDefaultInit | MenuFlag.OwnerDraw;
    record.crosshair.common.x = PREFERENCES_X;
    record.crosshair.common.y = y;
    record.crosshair.common.name = "Crosshair:";
    record.crosshair.common.callback = (item, event) => this.event(item, event);
    record.crosshair.common.ownerdraw = item => this.drawCrosshair(item);
    record.crosshair.common.id = PreferenceId.Crosshair;
    record.crosshair.common.top = y - 4;
    record.crosshair.common.bottom = y + 20;
    record.crosshair.common.left = PREFERENCES_X - (record.crosshair.common.name.length + 1) * 8;
    record.crosshair.common.right = PREFERENCES_X + 48;

    y += 22;
    this.configureRadio(record.simpleItems, PreferenceId.SimpleItems, "Simple Items:", y);
    y += 16;
    this.configureRadio(record.wallMarks, PreferenceId.WallMarks, "Marks on Walls:", y);
    y += 18;
    this.configureRadio(record.brass, PreferenceId.EjectingBrass, "Ejecting Brass:", y);
    y += 18;
    this.configureRadio(record.dynamicLights, PreferenceId.DynamicLights, "Dynamic Lights:", y);
    y += 18;
    this.configureRadio(record.identifyTarget, PreferenceId.IdentifyTarget, "Identify Target:", y);
    y += 18;
    this.configureRadio(record.highQualitySky, PreferenceId.HighQualitySky, "High Quality Sky:", y);
    y += 18;
    this.configureRadio(record.syncEveryFrame, PreferenceId.SyncEveryFrame, "Sync Every Frame:", y);
    y += 18;
    this.configureRadio(record.forceModel, PreferenceId.ForceModel, "Force Player Models:", y);
    y += 18;
    record.drawTeamOverlay.common.name = "Draw Team Overlay:";
    record.drawTeamOverlay.common.flags = MenuFlag.PulseIfFocus | MenuFlag.SmallFont;
    record.drawTeamOverlay.common.callback = (item, event) => this.event(item, event);
    record.drawTeamOverlay.common.id = PreferenceId.DrawTeamOverlay;
    record.drawTeamOverlay.common.x = PREFERENCES_X;
    record.drawTeamOverlay.common.y = y;
    record.drawTeamOverlay.itemnames = TEAM_OVERLAYS;
    y += 18;
    this.configureRadio(record.allowDownload, PreferenceId.AllowDownload, "Automatic Downloading:", y);

    record.back.common.name = BACK;
    record.back.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
    record.back.common.callback = (item, event) => this.event(item, event);
    record.back.common.id = PreferenceId.Back;
    record.back.common.x = 0;
    record.back.common.y = 416;
    record.back.width = 128;
    record.back.height = 64;
    record.back.focuspic = BACK_FOCUS;

    for (const item of [record.banner, record.frameLeft, record.frameRight, record.crosshair, record.simpleItems,
      record.wallMarks, record.brass, record.dynamicLights, record.identifyTarget, record.highQualitySky,
      record.syncEveryFrame, record.forceModel, record.drawTeamOverlay, record.allowDownload, record.back])
      addItem(this.state, record.menu, item);
    this.setMenuItems();
  }

  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of [FRAME_LEFT, FRAME_RIGHT, BACK, BACK_FOCUS]) {
      await this.state.services.resources.registerShaderNoMip(name);
      this.state.assertActive();
    }
    for (let i = 0; i < CROSSHAIR_COUNT; i++) {
      const shader = await this.state.services.resources.registerShaderNoMip(`gfx/2d/crosshair${String.fromCharCode(97 + i)}`);
      this.state.assertActive();
      this.record.crosshairShaders[i] = shader;
    }
  }

  async show(): Promise<void> {
    this.state.assertActive();
    this.record.reset();
    await this.cache();
    this.state.assertActive();
    this.initializeMenu();
    await pushMenu(this.state, this.record.menu);
    this.state.assertActive();
  }
}
