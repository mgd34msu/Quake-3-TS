// Demos menu from id Software code/q3_ui/ui_demo2.c. GPL-2.0-or-later.
import type { CommonFileState } from "../../assets/filesystem-state.ts";
import { KeyCode } from "../../core/key-codes.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { UI_CENTER } from "../../render/font.ts";
import { addItem, defaultKey, forceMenuOff, menuItemAtCursor, popMenu, pushMenu, scrollKey } from "./framework.ts";
import { BaseMenu, COLORS, itemAt, MenuCommon, MenuEvent, MenuFlag } from "./state.ts";
import type { BaseUiState, MenuBanner, MenuBitmap, MenuCallback, MenuScroll } from "./state.ts";

const BACK = "menu/art/back_0", BACK_FOCUS = "menu/art/back_1", GO = "menu/art/play_0", GO_FOCUS = "menu/art/play_1";
const FRAME_LEFT = "menu/art/frame2_l", FRAME_RIGHT = "menu/art/frame1_r";
const ARROWS = "menu/art/arrows_horz_0", LEFT = "menu/art/arrows_horz_left", RIGHT = "menu/art/arrows_horz_right";
enum Id { Back = 10, Go = 11, List = 12, Right = 13, Left = 14 }
function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null,
    focusshader: null, width: 0, height: 0, focuscolor: null };
}
class DemosRecord {
  readonly menu = new BaseMenu();
  readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, color: COLORS.black, style: 0 };
  readonly frameLeft = bitmap();
  readonly frameRight = bitmap();
  readonly list: MenuScroll = { kind: "scroll", common: new MenuCommon(), oldvalue: 0, curvalue: 0,
    numitems: 0, top: 0, itemnames: [], width: 0, height: 0, columns: 0, separation: 0 };
  readonly arrows = bitmap();
  readonly left = bitmap();
  readonly right = bitmap();
  readonly back = bitmap();
  readonly go = bitmap();
  readonly names = new Uint8Array(2048);
  readonly demoList: string[] = [];

  reset(): void {
    const menu = this.menu;
    menu.cursor = 0; menu.cursorPrev = 0; menu.itemCount = 0; menu.items.length = 0;
    menu.draw = null; menu.key = null; menu.fullscreen = false; menu.wrapAround = false; menu.showlogo = false;
    Object.assign(this.banner.common, new MenuCommon()); this.banner.text = null; this.banner.style = 0; this.banner.color = COLORS.black;
    for (const item of [this.frameLeft, this.frameRight, this.arrows, this.left, this.right, this.back, this.go]) {
      Object.assign(item.common, new MenuCommon()); item.focuspic = null; item.errorpic = null;
      item.shader = null; item.focusshader = null; item.width = 0; item.height = 0; item.focuscolor = null;
    }
    const list = this.list; Object.assign(list.common, new MenuCommon());
    list.oldvalue = 0; list.curvalue = 0; list.numitems = 0; list.top = 0; list.itemnames = [];
    list.width = 0; list.height = 0; list.columns = 0; list.separation = 0;
    this.names.fill(0); this.demoList.length = 0;
  }
}

export class BaseDemosMenu {
  private readonly record = new DemosRecord();
  private readonly event: MenuCallback = async (item, event) => {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    switch (item.common.id) {
      case Id.Go:
        await forceMenuOff(this.state); this.state.assertActive();
        this.state.services.consoleCommands.append(`demo ${itemAt(this.record.list.itemnames, this.record.list.curvalue)}\n`);
        return;
      case Id.Back: await popMenu(this.state); this.state.assertActive(); return;
      case Id.Left: await scrollKey(this.state, this.record.list, KeyCode.Left); this.state.assertActive(); return;
      case Id.Right: await scrollKey(this.state, this.record.list, KeyCode.Right); this.state.assertActive(); return;
    }
  };
  private readonly key = async (key: number) => {
    this.state.assertActive(); menuItemAtCursor(this.record.menu);
    const sound = await defaultKey(this.state, this.record.menu, key); this.state.assertActive(); return sound;
  };
  constructor(readonly state: BaseUiState, private readonly files: CommonFileState) {}
  get menu(): BaseMenu { return this.record.menu; }

  async cache(): Promise<void> {
    this.state.assertActive();
    for (const path of [BACK, BACK_FOCUS, GO, GO_FOCUS, FRAME_LEFT, FRAME_RIGHT, ARROWS, LEFT, RIGHT]) {
      await this.state.services.resources.registerShaderNoMip(path); this.state.assertActive();
    }
  }
  async show(): Promise<void> {
    this.state.assertActive();
    const r = this.record; r.reset(); r.menu.key = this.key;
    await this.cache(); this.state.assertActive();
    r.menu.fullscreen = true; r.menu.wrapAround = true;
    r.banner.common.x = 320; r.banner.common.y = 16; r.banner.text = "DEMOS"; r.banner.color = COLORS.white; r.banner.style = UI_CENTER;
    for (const [item, path, x, y, width, height] of [
      [r.frameLeft, FRAME_LEFT, 0, 78, 256, 329], [r.frameRight, FRAME_RIGHT, 376, 76, 256, 334],
      [r.arrows, ARROWS, 256, 400, 128, 48],
    ] satisfies [MenuBitmap, string, number, number, number, number][]) {
      item.common.name = path; item.common.flags = MenuFlag.Inactive; item.common.x = x; item.common.y = y;
      item.width = width; item.height = height;
    }
    for (const [item, id, x, y, width, height, path, focus, flags] of [
      [r.left, Id.Left, 256, 400, 64, 48, null, LEFT, MenuFlag.LeftJustify | MenuFlag.MouseOnly],
      [r.right, Id.Right, 320, 400, 64, 48, null, RIGHT, MenuFlag.LeftJustify | MenuFlag.MouseOnly],
      [r.back, Id.Back, 0, 416, 128, 64, BACK, BACK_FOCUS, MenuFlag.LeftJustify],
      [r.go, Id.Go, 640, 416, 128, 64, GO, GO_FOCUS, MenuFlag.RightJustify],
    ] satisfies [MenuBitmap, Id, number, number, number, number, string | null, string, number][]) {
      item.common.name = path; item.common.flags = flags | MenuFlag.PulseIfFocus; item.common.id = id;
      item.common.callback = this.event; item.common.x = x; item.common.y = y;
      item.width = width; item.height = height; item.focuspic = focus;
    }
    const list = r.list;
    list.common.flags = MenuFlag.PulseIfFocus; list.common.callback = this.event; list.common.id = Id.List;
    list.common.x = 118; list.common.y = 130; list.width = 16; list.height = 14;
    const protocol = this.state.services.cvars.registry.get("protocol");
    const extension = `dm_${qvmFloatToInt(protocol === undefined ? 0 : protocol.numericValue)}`;
    list.numitems = this.files.current.getFileList("demos", extension, r.names);
    list.itemnames = r.demoList; list.columns = 3;
    if (list.numitems === 0) {
      r.names.set(new TextEncoder().encode("No Demos Found.")); list.numitems = 1;
      r.go.common.flags |= MenuFlag.Inactive | MenuFlag.Hidden;
    } else if (list.numitems > 128) list.numitems = 128;
    let offset = 0;
    for (let i = 0; i < list.numitems; i++) {
      const end = r.names.indexOf(0, offset);
      if (end < 0) throw new RangeError("Demos file list has no filename terminator");
      const name = String.fromCharCode(...r.names.subarray(offset, end));
      const stripped = name.slice(-4).toLowerCase() === ".dm3" ? name.slice(0, -4) : name;
      r.demoList.push(stripped.replace(/[a-z]/g, byte => String.fromCharCode(byte.charCodeAt(0) - 32)));
      offset = end + 1;
    }
    for (const item of [r.banner, r.frameLeft, r.frameRight, list, r.arrows, r.left, r.right, r.back, r.go]) addItem(this.state, r.menu, item);
    await pushMenu(this.state, r.menu); this.state.assertActive();
  }
}
