// Main and error menus from id Software q3_ui/ui_menu.c. GPL-2.0-or-later.
import type { CommonFileState } from "../../assets/filesystem-state.ts";
import { KeyCatcher } from "../../core/key-codes.ts";
import { vec3 } from "../../core/math.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { qvmAnglesToAxis } from "../../core/qvm-math.ts";
import { sourceCommandText } from "../../core/text.ts";
import { validateCdKey } from "../../engine/cd-key.ts";
import type { CommonCdKeyState } from "../../engine/cd-key.ts";
import { UI_CENTER, UI_DROPSHADOW, UI_SMALLFONT } from "../../render/font.ts";
import { createModelEntity, DEFAULT_MODEL, RF_LIGHTING_ORIGIN, RF_NOSHADOW } from "../../render/ref-entity.ts";
import type { SceneModel } from "../../render/ref-entity.ts";
import { createRefdef, RDF_NOWORLDMODEL } from "../../render/refdef.ts";
import type { BaseCdKeyMenu } from "./cd-key.ts";
import type { BaseConfirmMenu } from "./confirm.ts";
import { autoWrapped, drawProportional, drawString } from "./draw.ts";
import { addItem, drawMenu, popMenu, pushMenu } from "./framework.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuProportional } from "./state.ts";

const BANNER = "models/mapobjects/banner/banner5.md3", f = Math.fround;
enum Id { SinglePlayer = 10, Multiplayer = 11, Setup = 12, Demos = 13, Cinematics = 14, TeamArena = 15, Mods = 16, Exit = 17 }
export interface BaseMainNavigation {
  singlePlayer(): Promise<void>;
  multiplayer(): Promise<void>;
  setup(): Promise<void>;
  demos(): Promise<void>;
  cinematics(): Promise<void>;
  mods(): Promise<void>;
  credits(): Promise<void>;
}
function textItem(): MenuProportional {
  return { kind: "proportional", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
}
function resetMenu(menu: BaseMenu): void {
  menu.cursor = 0; menu.cursorPrev = 0; menu.itemCount = 0; menu.items.length = 0;
  menu.draw = null; menu.key = null; menu.wrapAround = false; menu.fullscreen = false; menu.showlogo = false;
}

export class BaseMainMenu {
  readonly menu = new BaseMenu();
  private readonly errorMenu = new BaseMenu();
  private errorMessage = "";
  private banner: SceneModel = DEFAULT_MODEL;
  private readonly singlePlayer = textItem();
  private readonly multiplayer = textItem();
  private readonly setup = textItem();
  private readonly demos = textItem();
  private readonly cinematics = textItem();
  private readonly teamArena = textItem();
  private readonly mods = textItem();
  private readonly exit = textItem();

  constructor(
    readonly state: BaseUiState,
    private readonly files: CommonFileState,
    private readonly keys: CommonCdKeyState,
    private readonly cdKeyMenu: BaseCdKeyMenu,
    private readonly confirm: BaseConfirmMenu,
    private readonly navigation: BaseMainNavigation,
    private readonly usesUniqueKey: () => number,
  ) {
    if (cdKeyMenu.state !== state || confirm.state !== state) throw new Error("Main menu requires this UI's shared menus");
  }

  async cache(): Promise<void> {
    this.state.assertActive();
    this.banner = await this.state.services.resources.registerModel(BANNER);
    this.state.assertActive();
  }

  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    switch (item.common.id) {
      case Id.SinglePlayer: await this.navigation.singlePlayer(); break;
      case Id.Multiplayer: await this.navigation.multiplayer(); break;
      case Id.Setup: await this.navigation.setup(); break;
      case Id.Demos: await this.navigation.demos(); break;
      case Id.Cinematics: await this.navigation.cinematics(); break;
      case Id.Mods: await this.navigation.mods(); break;
      case Id.TeamArena:
        this.state.services.cvars.registry.set("fs_game", "missionpack", true);
        this.state.assertActive();
        this.state.services.consoleCommands.append("vid_restart;");
        break;
      case Id.Exit:
        await this.confirm.show("EXIT GAME?", null, async result => {
          this.state.assertActive();
          if (!result) return;
          await popMenu(this.state); this.state.assertActive();
          await this.navigation.credits(); this.state.assertActive();
        });
        break;
    }
    this.state.assertActive();
  }

  private async draw(): Promise<void> {
    this.state.assertActive();
    const viewport = this.state.draw.adjust({ x: 0, y: 0, width: 640, height: 120 }), refdef = createRefdef();
    refdef.x = qvmFloatToInt(viewport.x); refdef.y = qvmFloatToInt(viewport.y);
    refdef.width = qvmFloatToInt(viewport.width); refdef.height = qvmFloatToInt(viewport.height);
    refdef.viewAxis = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
    refdef.renderFlags = RDF_NOWORLDMODEL; refdef.fovX = 60; refdef.fovY = 19.6875; refdef.time = this.state.realtime;
    const scene = this.state.services.resources;
    scene.clearScene();
    const entity = createModelEntity(this.banner), origin = vec3(300, 0, -32);
    const adjust = f(5 * Math.sin(f(f(this.state.realtime) / 5000)));
    entity.axis = qvmAnglesToAxis(vec3(0, f(180 + adjust), 0));
    entity.origin = { ...origin }; entity.lightingOrigin = { ...origin }; entity.oldOrigin = { ...origin };
    entity.renderFlags = RF_LIGHTING_ORIGIN | RF_NOSHADOW;
    scene.addRefEntity(entity);
    scene.renderScene(refdef);
    if (this.errorMessage.length !== 0)
      autoWrapped(this.state, 320, 192, 600, 20, this.errorMessage, UI_CENTER | UI_SMALLFONT | UI_DROPSHADOW, COLORS.menuText);
    else { await drawMenu(this.state, this.menu); this.state.assertActive(); }
    const color = { x: 0.5, y: 0, z: 0, w: 1 };
    if (this.state.demoVersion)
      drawProportional(this.state, 320, 372, "DEMO      FOR MATURE AUDIENCES      DEMO", UI_CENTER | UI_SMALLFONT, color);
    drawString(this.state, 320, this.state.demoVersion ? 400 : 450,
      "Quake III Arena(c) 1999-2000, Id Software, Inc.  All Rights Reserved", UI_CENTER | UI_SMALLFONT, color);
  }

  private teamArenaExists(): boolean {
    const bytes = new Uint8Array(2048), count = this.files.current.getFileList("$modlist", "", bytes);
    this.state.assertActive();
    let offset = 0;
    for (let index = 0; index < count; index++) {
      const end = bytes.indexOf(0, offset);
      if (end < 0) throw new RangeError("Main menu mod list has an unterminated directory");
      if (String.fromCharCode(...bytes.subarray(offset, end)).toLowerCase() === "missionpack") return true;
      const descriptionEnd = bytes.indexOf(0, end + 1);
      if (descriptionEnd < 0) throw new RangeError("Main menu mod list has an unterminated description");
      offset = descriptionEnd + 1;
    }
    return false;
  }

  async show(): Promise<void> {
    this.state.assertActive();
    const cvars = this.state.services.cvars;
    cvars.registry.set("sv_killserver", "1", true); this.state.assertActive();
    if (!this.state.demoVersion && cvars.get("ui_cdkeychecked").integerValue === 0) {
      const bytes = new Uint8Array(17); this.keys.readUiForCompiledModule(this.usesUniqueKey, () => bytes);
      const key = String.fromCharCode(...bytes.subarray(0, bytes.indexOf(0)));
      if (!validateCdKey(key, null)) { await this.cdKeyMenu.show(); this.state.assertActive(); return; }
    }
    resetMenu(this.menu); resetMenu(this.errorMenu); this.errorMessage = ""; this.banner = DEFAULT_MODEL;
    for (const item of [this.singlePlayer, this.multiplayer, this.setup, this.demos, this.cinematics, this.teamArena, this.mods, this.exit]) {
      Object.assign(item.common, new MenuCommon()); item.text = null; item.color = COLORS.white; item.style = 0;
    }
    await this.cache(); this.state.assertActive();
    this.errorMessage = sourceCommandText(cvars.registry.get("com_errorMessage")?.value ?? "").slice(0, 4095);
    if (this.errorMessage.length !== 0) {
      this.errorMenu.draw = () => this.draw();
      this.errorMenu.key = async () => {
        this.state.assertActive(); cvars.registry.set("com_errorMessage", "", true); this.state.assertActive();
        await this.show(); this.state.assertActive(); return this.state.media.nullSound;
      };
      this.errorMenu.fullscreen = true; this.errorMenu.wrapAround = true; this.errorMenu.showlogo = true;
      this.state.services.keys.setCatcher(KeyCatcher.Ui); this.state.assertActive(); this.state.menuDepth = 0;
      await pushMenu(this.state, this.errorMenu); this.state.assertActive(); return;
    }
    this.menu.draw = () => this.draw(); this.menu.fullscreen = true; this.menu.wrapAround = true; this.menu.showlogo = true;
    let y = 134;
    const configure = (item: MenuProportional, id: Id, text: string): void => {
      item.common.flags = MenuFlag.CenterJustify | MenuFlag.PulseIfFocus; item.common.x = 320; item.common.y = y;
      item.common.id = id; item.common.callback = (value, event) => this.event(value, event);
      item.text = text; item.color = COLORS.red; item.style = UI_CENTER | UI_DROPSHADOW; y += 34;
    };
    configure(this.singlePlayer, Id.SinglePlayer, "SINGLE PLAYER"); configure(this.multiplayer, Id.Multiplayer, "MULTIPLAYER");
    configure(this.setup, Id.Setup, "SETUP"); configure(this.demos, Id.Demos, "DEMOS"); configure(this.cinematics, Id.Cinematics, "CINEMATICS");
    const teamArena = this.teamArenaExists();
    if (teamArena) configure(this.teamArena, Id.TeamArena, "TEAM ARENA");
    configure(this.mods, Id.Mods, "MODS"); configure(this.exit, Id.Exit, "EXIT");
    for (const item of [this.singlePlayer, this.multiplayer, this.setup, this.demos, this.cinematics]) addItem(this.state, this.menu, item);
    if (teamArena) addItem(this.state, this.menu, this.teamArena);
    addItem(this.state, this.menu, this.mods); addItem(this.state, this.menu, this.exit);
    this.state.services.keys.setCatcher(KeyCatcher.Ui); this.state.assertActive(); this.state.menuDepth = 0;
    await pushMenu(this.state, this.menu); this.state.assertActive();
  }
}
