// Cinematics menu from id Software q3_ui/ui_cinematics.c and UI_CanShowTierVideo in ui_gameinfo.c. GPL-2.0-or-later.
import type { CommandContext } from "../../core/commands.ts";
import { sourceCommandText } from "../../core/text.ts";
import { gameAtoi } from "../../game/numeric.ts";
import { UI_CENTER } from "../../render/font.ts";
import { canShowTierVideo } from "./game-info.ts";
import { addItem, popMenu, pushMenu, setCursorToItem } from "./framework.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag, itemAt, nativeInt } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap, MenuCallback, MenuProportional } from "./state.ts";

const BACK = "menu/art/back_0", BACK_FOCUS = "menu/art/back_1";
const FRAME_LEFT = "menu/art/frame2_l", FRAME_RIGHT = "menu/art/frame1_r";
const MOVIES: readonly string[] = ["idlogo", "intro", "tier1", "tier2", "tier3", "tier4", "tier5", "tier6", "tier7", "end"];
const TITLES: readonly string[] = ["ID LOGO", "INTRO", "Tier 1", "Tier 2", "Tier 3", "Tier 4", "Tier 5", "Tier 6", "Tier 7", "END"];

function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null,
    focusshader: null, width: 0, height: 0, focuscolor: null };
}
class CinematicsRecord {
  readonly menu = new BaseMenu();
  readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
  readonly frameLeft = bitmap();
  readonly frameRight = bitmap();
  readonly movies: readonly MenuProportional[] = TITLES.map(() => ({ kind: "proportional", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 }));
  readonly back = bitmap();

  reset(): void {
    this.menu.cursor = 0; this.menu.cursorPrev = 0; this.menu.itemCount = 0; this.menu.items.length = 0;
    this.menu.draw = null; this.menu.key = null; this.menu.wrapAround = false; this.menu.fullscreen = false; this.menu.showlogo = false;
    for (const item of [this.banner, ...this.movies]) {
      Object.assign(item.common, new MenuCommon()); item.text = null; item.color = COLORS.white; item.style = 0;
    }
    for (const item of [this.frameLeft, this.frameRight, this.back]) {
      Object.assign(item.common, new MenuCommon()); item.focuspic = null; item.errorpic = null; item.shader = null;
      item.focusshader = null; item.width = 0; item.height = 0; item.focuscolor = null;
    }
  }
}

export class BaseCinematicsMenu {
  private readonly record = new CinematicsRecord();
  private readonly callback: MenuCallback = (item, event) => this.event(item, event);
  private readonly backCallback: MenuCallback = (item, event) => this.backEvent(item, event);
  constructor(readonly state: BaseUiState) {}
  get menu(): BaseMenu { return this.record.menu; }

  private async backEvent(_item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    await popMenu(this.state); this.state.assertActive();
  }

  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    const index = (nativeInt(item.common.id) - 11) | 0;
    this.state.services.cvars.registry.set("nextmap", `ui_cinematics ${index}`, true);
    this.state.assertActive();
    if (this.state.demoVersion && item.common.id === 20)
      this.state.services.consoleCommands.append("disconnect; cinematic demoEnd.RoQ 1\n");
    else
      this.state.services.consoleCommands.append(`disconnect; cinematic ${itemAt(MOVIES, index)}.RoQ\n`);
  }

  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of [BACK, BACK_FOCUS, FRAME_LEFT, FRAME_RIGHT]) {
      await this.state.services.resources.registerShaderNoMip(name); this.state.assertActive();
    }
  }

  private async initialize(): Promise<void> {
    this.state.assertActive();
    await this.cache(); this.state.assertActive();
    const r = this.record;
    r.reset(); r.menu.fullscreen = true;
    r.banner.common.x = 320; r.banner.common.y = 16; r.banner.text = "CINEMATICS"; r.banner.color = COLORS.white; r.banner.style = UI_CENTER;
    r.frameLeft.common.name = FRAME_LEFT; r.frameLeft.common.flags = MenuFlag.Inactive;
    r.frameLeft.common.x = 0; r.frameLeft.common.y = 78; r.frameLeft.width = 256; r.frameLeft.height = 329;
    r.frameRight.common.name = FRAME_RIGHT; r.frameRight.common.flags = MenuFlag.Inactive;
    r.frameRight.common.x = 376; r.frameRight.common.y = 76; r.frameRight.width = 256; r.frameRight.height = 334;
    for (const [index, movie] of r.movies.entries()) {
      movie.common.flags = MenuFlag.CenterJustify | MenuFlag.PulseIfFocus;
      movie.common.x = 320; movie.common.y = 100 + index * 30; movie.common.id = 11 + index; movie.common.callback = this.callback;
      movie.text = itemAt(TITLES, index); movie.color = COLORS.red; movie.style = UI_CENTER;
      if (index === 1 && this.state.demoVersion) movie.common.flags |= MenuFlag.Grayed;
      if (index >= 2 && !canShowTierVideo(this.state, index - 1)) movie.common.flags |= MenuFlag.Grayed;
    }
    r.back.common.name = BACK; r.back.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
    r.back.common.id = 10; r.back.common.callback = this.backCallback;
    r.back.common.x = 0; r.back.common.y = 416; r.back.width = 128; r.back.height = 64; r.back.focuspic = BACK_FOCUS;
    for (const item of [r.banner, r.frameLeft, r.frameRight, ...r.movies, r.back]) addItem(this.state, r.menu, item);
  }

  async show(): Promise<void> {
    await this.initialize(); this.state.assertActive();
    await pushMenu(this.state, this.record.menu); this.state.assertActive();
  }

  async showFromCommand(context: CommandContext): Promise<void> {
    context.assertActive(); this.state.assertActive();
    const selected = gameAtoi(sourceCommandText((context.argv[1] ?? "").slice(0, 1023)));
    await this.show(); context.assertActive(); this.state.assertActive();
    const index = (selected + 3) | 0;
    if (index < 0 || index >= 64) throw new RangeError("Undefined native cinematics menu pointer slot");
    // The source menu has 64 zeroed pointer slots; unused slots pass NULL to Menu_SetCursorToItem.
    if (index >= this.record.menu.itemCount) return;
    await setCursorToItem(this.state, this.record.menu, itemAt(this.record.menu.items, index));
    context.assertActive(); this.state.assertActive();
  }
}
