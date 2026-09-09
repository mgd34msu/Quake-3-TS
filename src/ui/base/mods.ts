// Mods menu from id Software code/q3_ui/ui_mods.c. GPL-2.0-or-later.
import type { CommonFileState } from "../../assets/filesystem-state.ts";
import { UI_CENTER } from "../../render/font.ts";
import { addItem, popMenu, pushMenu } from "./framework.ts";
import { BaseMenu, COLORS, itemAt, MenuCommon, MenuEvent, MenuFlag } from "./state.ts";
import type { BaseUiState, MenuBanner, MenuBitmap, MenuCallback, MenuScroll } from "./state.ts";

const BACK = "menu/art/back_0", BACK_FOCUS = "menu/art/back_1";
const GO = "menu/art/load_0", GO_FOCUS = "menu/art/load_1";
const FRAME_LEFT = "menu/art/frame2_l", FRAME_RIGHT = "menu/art/frame1_r";
enum Id { Back = 10, Go = 11, List = 12 }
function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null,
    shader: null, focusshader: null, width: 0, height: 0, focuscolor: null };
}
class ModsRecord {
  readonly menu = new BaseMenu();
  readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, color: COLORS.black, style: 0 };
  readonly frameLeft = bitmap();
  readonly frameRight = bitmap();
  readonly list: MenuScroll = { kind: "scroll", common: new MenuCommon(), oldvalue: 0, curvalue: 0,
    numitems: 0, top: 0, itemnames: [], width: 0, height: 0, columns: 0, separation: 0 };
  readonly back = bitmap();
  readonly go = bitmap();
  readonly descriptions: string[] = [];
  readonly games = new Array<string | null>(64).fill(null);

  reset(): void {
    const menu = this.menu;
    menu.cursor = 0; menu.cursorPrev = 0; menu.itemCount = 0; menu.items.length = 0;
    menu.draw = null; menu.key = null; menu.fullscreen = false; menu.wrapAround = false; menu.showlogo = false;
    Object.assign(this.banner.common, new MenuCommon()); this.banner.text = null; this.banner.color = COLORS.black; this.banner.style = 0;
    for (const item of [this.frameLeft, this.frameRight, this.back, this.go]) {
      Object.assign(item.common, new MenuCommon()); item.focuspic = null; item.errorpic = null;
      item.shader = null; item.focusshader = null; item.width = 0; item.height = 0; item.focuscolor = null;
    }
    const list = this.list; Object.assign(list.common, new MenuCommon());
    list.oldvalue = 0; list.curvalue = 0; list.numitems = 0; list.top = 0; list.itemnames = [];
    list.width = 0; list.height = 0; list.columns = 0; list.separation = 0;
    this.descriptions.length = 0; this.games.fill(null);
  }
}

export class BaseModsMenu {
  private readonly record = new ModsRecord();
  constructor(readonly state: BaseUiState, private readonly files: CommonFileState) {}
  get menu(): BaseMenu { return this.record.menu; }

  private readonly event: MenuCallback = async (item, event) => {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    if (item.common.id === Id.Go) {
      const game = itemAt(this.record.games, this.record.list.curvalue);
      const cvars = this.state.services.cvars.registry;
      // Unused source pointer slots are NULL: Cvar_Set(name, NULL) resets the cvar.
      if (game === null) {
        const previous = cvars.get("fs_game");
        if (previous !== undefined) cvars.set("fs_game", previous.resetValue, true);
      } else cvars.set("fs_game", game, true);
      this.state.assertActive();
      this.state.services.consoleCommands.append("vid_restart;");
      this.state.assertActive();
      await popMenu(this.state); this.state.assertActive();
    } else if (item.common.id === Id.Back) {
      await popMenu(this.state); this.state.assertActive();
    }
  };

  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of [BACK, BACK_FOCUS, GO, GO_FOCUS, FRAME_LEFT, FRAME_RIGHT]) {
      await this.state.services.resources.registerShaderNoMip(name); this.state.assertActive();
    }
  }

  private loadMods(): void {
    const r = this.record, list = r.list;
    list.itemnames = r.descriptions;
    list.numitems = 1; r.descriptions[0] = "Quake III Arena"; r.games[0] = "";
    const bytes = new Uint8Array(2048);
    const count = this.files.current.getFileList("$modlist", "", bytes);
    this.state.assertActive();
    let offset = 0;
    const nextString = (): string => {
      const end = bytes.indexOf(0, offset);
      if (end < 0) throw new RangeError("Mods file list reached an unterminated source string");
      const value = String.fromCharCode(...bytes.subarray(offset, end));
      offset = end + 1;
      return value;
    };
    for (let index = 0; index < count; index++) {
      const directory = nextString(), description = nextString();
      // Source's MAX_MODS clamp is after the loop; the 65th pointer write is already undefined.
      itemAt(r.games, list.numitems);
      r.games[list.numitems] = directory.slice(0, 15);
      r.descriptions[list.numitems] = description.slice(0, 47);
      list.numitems++;
    }
    this.state.services.print(`${list.numitems} mods parsed\n`); this.state.assertActive();
    if (list.numitems > 64) list.numitems = 64;
  }

  async show(): Promise<void> {
    this.state.assertActive();
    await this.cache(); this.state.assertActive();
    const r = this.record; r.reset();
    r.menu.wrapAround = true; r.menu.fullscreen = true;
    r.banner.common.x = 320; r.banner.common.y = 16; r.banner.text = "MODS";
    r.banner.color = COLORS.white; r.banner.style = UI_CENTER;
    for (const [item, name, x, y, width, height] of [
      [r.frameLeft, FRAME_LEFT, 0, 78, 256, 329], [r.frameRight, FRAME_RIGHT, 376, 76, 256, 334],
    ] satisfies [MenuBitmap, string, number, number, number, number][]) {
      item.common.name = name; item.common.flags = MenuFlag.Inactive; item.common.x = x; item.common.y = y;
      item.width = width; item.height = height;
    }
    for (const [item, id, name, focus, x, align] of [
      [r.back, Id.Back, BACK, BACK_FOCUS, 0, MenuFlag.LeftJustify],
      [r.go, Id.Go, GO, GO_FOCUS, 640, MenuFlag.RightJustify],
    ] satisfies [MenuBitmap, Id, string, string, number, MenuFlag][]) {
      item.common.name = name; item.common.flags = align | MenuFlag.PulseIfFocus; item.common.id = id;
      item.common.callback = this.event; item.common.x = x; item.common.y = 416;
      item.width = 128; item.height = 64; item.focuspic = focus;
    }
    const list = r.list;
    list.common.flags = MenuFlag.PulseIfFocus | MenuFlag.CenterJustify;
    list.common.callback = this.event; list.common.id = Id.List; list.common.x = 320; list.common.y = 130;
    list.width = 48; list.height = 14;
    this.loadMods();
    for (const item of [r.banner, r.frameLeft, r.frameRight, list, r.back, r.go]) addItem(this.state, r.menu, item);
    await pushMenu(this.state, r.menu); this.state.assertActive();
  }
}
