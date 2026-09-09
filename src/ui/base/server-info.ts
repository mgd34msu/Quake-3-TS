// Server Info from id Software q3_ui/ui_serverinfo.c and q_shared.c. GPL-2.0-or-later.
import { sourceCommandText } from "../../core/text.ts";
import { UI_CENTER, UI_LEFT, UI_RIGHT, UI_SMALLFONT } from "../../render/font.ts";
import { drawString } from "./draw.ts";
import { addItem, defaultKey, drawMenu, popMenu, pushMenu } from "./framework.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap, MenuCallback, MenuProportional } from "./state.ts";

const FRAME_LEFT = "menu/art/frame2_l", FRAME_RIGHT = "menu/art/frame1_r";
const BACK = "menu/art/back_0", BACK_FOCUS = "menu/art/back_1";
enum ServerInfoId { Add = 100, Back = 101 }

function cString(value: string, capacity: number): string {
  return sourceCommandText(value.slice(0, capacity - 1));
}
function equalAddress(left: string, right: string): boolean {
  const uppercase = (text: string) => text.replace(/[a-z]/g, letter => String.fromCharCode(letter.charCodeAt(0) - 32));
  return uppercase(left) === uppercase(right);
}
// Info_NextPair, including a final key without a separator and an empty key.
function nextPair(info: string, offset: number): { readonly key: string; readonly value: string; readonly next: number } {
  const start = info.charAt(offset) === "\\" ? offset + 1 : offset;
  const separator = info.indexOf("\\", start);
  if (separator < 0) return { key: info.slice(start), value: "", next: info.length };
  const end = info.indexOf("\\", separator + 1), next = end < 0 ? info.length : end;
  return { key: info.slice(start, separator), value: info.slice(separator + 1, next), next };
}
function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null,
    focusshader: null, width: 0, height: 0, focuscolor: null };
}
class ServerInfoRecord {
  readonly menu = new BaseMenu();
  readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
  readonly frameLeft = bitmap();
  readonly frameRight = bitmap();
  readonly back = bitmap();
  readonly add: MenuProportional = { kind: "proportional", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
  info = "";
  numlines = 0;

  reset(): void {
    this.menu.cursor = 0; this.menu.cursorPrev = 0; this.menu.itemCount = 0; this.menu.items.length = 0;
    this.menu.draw = null; this.menu.key = null; this.menu.wrapAround = false; this.menu.fullscreen = false; this.menu.showlogo = false;
    for (const item of [this.banner, this.add]) {
      Object.assign(item.common, new MenuCommon()); item.text = null; item.color = COLORS.white; item.style = 0;
    }
    for (const item of [this.frameLeft, this.frameRight, this.back]) {
      Object.assign(item.common, new MenuCommon()); item.focuspic = null; item.errorpic = null; item.shader = null;
      item.focusshader = null; item.width = 0; item.height = 0; item.focuscolor = null;
    }
    this.info = ""; this.numlines = 0;
  }
}

export class BaseServerInfoMenu {
  private readonly record = new ServerInfoRecord();
  private readonly callback: MenuCallback = (item, event) => this.event(item, event);
  private readonly drawCallback = () => this.draw();
  private readonly keyCallback = (key: number) => defaultKey(this.state, this.record.menu, key);
  constructor(readonly state: BaseUiState, private readonly readServerInfo: () => string) {}
  get menu(): BaseMenu { return this.record.menu; }

  private addFavorite(): void {
    const cvars = this.state.services.cvars.registry;
    const current = cvars.get("cl_currentServerAddress"), server = cString(current === undefined ? "" : current.value, 128);
    if (server === "") return;
    let best = 0;
    for (let i = 1; i <= 16; i++) {
      const variable = cvars.get(`server${i}`), address = cString(variable === undefined ? "" : variable.value, 128);
      if (equalAddress(server, address)) return;
      const first = address.charAt(0);
      if ((first < "0" || first > "9") && best === 0) best = i;
    }
    if (best !== 0) cvars.set(`server${best}`, server, true);
  }

  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    switch (item.common.id) {
      case ServerInfoId.Add:
        if (event !== MenuEvent.Activated) break;
        this.addFavorite();
        await popMenu(this.state); this.state.assertActive();
        break;
      case ServerInfoId.Back:
        if (event !== MenuEvent.Activated) break;
        await popMenu(this.state); this.state.assertActive();
        break;
    }
  }

  private async draw(): Promise<void> {
    this.state.assertActive();
    let y = 240 - this.record.numlines * 16 / 2 - 20, offset = 0;
    while (true) {
      const pair = nextPair(this.record.info, offset);
      if (pair.key === "") break;
      // Q_strcat uses Q_strncpyz: a 1023-byte key has no room for the colon.
      drawString(this.state, 312, y, cString(`${pair.key}:`, 1024), UI_RIGHT | UI_SMALLFONT, COLORS.red);
      drawString(this.state, 328, y, pair.value, UI_LEFT | UI_SMALLFONT, COLORS.normal);
      y += 16; offset = pair.next;
    }
    await drawMenu(this.state, this.record.menu); this.state.assertActive();
  }

  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of [FRAME_LEFT, FRAME_RIGHT, BACK, BACK_FOCUS]) {
      await this.state.services.resources.registerShaderNoMip(name);
      this.state.assertActive();
    }
  }

  async show(): Promise<void> {
    this.state.assertActive();
    const r = this.record;
    r.reset();
    await this.cache(); this.state.assertActive();
    r.menu.draw = this.drawCallback;
    r.menu.key = this.keyCallback;
    r.menu.wrapAround = true; r.menu.fullscreen = true;
    r.banner.common.x = 320; r.banner.common.y = 16;
    r.banner.text = "SERVER INFO"; r.banner.color = COLORS.white; r.banner.style = UI_CENTER;
    r.frameLeft.common.name = FRAME_LEFT; r.frameLeft.common.flags = MenuFlag.Inactive;
    r.frameLeft.common.x = 0; r.frameLeft.common.y = 78; r.frameLeft.width = 256; r.frameLeft.height = 329;
    r.frameRight.common.name = FRAME_RIGHT; r.frameRight.common.flags = MenuFlag.Inactive;
    r.frameRight.common.x = 376; r.frameRight.common.y = 76; r.frameRight.width = 256; r.frameRight.height = 334;
    r.add.common.flags = MenuFlag.CenterJustify | MenuFlag.PulseIfFocus;
    r.add.common.callback = this.callback; r.add.common.id = ServerInfoId.Add;
    r.add.common.x = 320; r.add.common.y = 371; r.add.text = "ADD TO FAVORITES";
    r.add.style = UI_CENTER | UI_SMALLFONT; r.add.color = COLORS.red;
    const running = this.state.services.cvars.registry.get("sv_running");
    if (running !== undefined && running.numericValue !== 0) r.add.common.flags |= MenuFlag.Grayed;
    r.back.common.name = BACK; r.back.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
    r.back.common.callback = this.callback; r.back.common.id = ServerInfoId.Back;
    r.back.common.x = 0; r.back.common.y = 416; r.back.width = 128; r.back.height = 64; r.back.focuspic = BACK_FOCUS;
    const info = this.readServerInfo(); this.state.assertActive();
    r.info = cString(info, 1024);
    r.numlines = 0;
    let offset = 0;
    while (true) {
      const pair = nextPair(r.info, offset);
      if (pair.key === "") break;
      r.numlines++; offset = pair.next;
    }
    if (r.numlines > 16) r.numlines = 16;
    for (const item of [r.banner, r.frameLeft, r.frameRight, r.add, r.back]) addItem(this.state, r.menu, item);
    await pushMenu(this.state, r.menu); this.state.assertActive();
  }
}
