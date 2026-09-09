// Controls menu translated from id Software code/q3_ui/ui_controls2.c. GPL-2.0-or-later.
import { KEY_CHAR_FLAG, KeyCode } from "../../core/key-codes.ts";
import { keynumToString } from "../../engine/client-keys.ts";
import { UI_BLINK, UI_CENTER, UI_LEFT, UI_PULSE, UI_RIGHT, UI_SMALLFONT } from "../../render/font.ts";
import { ItemType } from "../../shared/definitions.ts";
import { itemList } from "../../shared/items.ts";
import { PlayerAnimation } from "../../shared/player-state.ts";
import type { BaseConfirmMenu } from "./confirm.ts";
import { clampCvar, drawChar, drawProportional, drawString, fillRect } from "./draw.ts";
import { addItem, defaultKey, popMenu, pushMenu } from "./framework.ts";
import { BasePlayerInfo, clearBasePlayerInfo } from "./players.ts";
import type { BaseUiPlayers } from "./players.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag, itemAt, menuSound, nativeInt } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuAction, MenuBanner, MenuBitmap, MenuProportional, MenuRadio, MenuSlider, MenuSound } from "./state.ts";

enum Pose { Idle, Run, Walk, Back, Jump, Crouch, StepLeft, StepRight, TurnLeft, TurnRight, LookUp, LookDown,
  Weapon1, Weapon2, Weapon3, Weapon4, Weapon5, Weapon6, Weapon7, Weapon8, Weapon9, Weapon10, Attack, Gesture, Die, Chat }
interface Binding {
  readonly command: string; readonly label: string; readonly pose: Pose; readonly defaultKey: number;
  readonly item: MenuAction; bind1: number; bind2: number;
}
function binding(command: string, label: string, pose: Pose, defaultKey: number): Binding {
  return { command, label, pose, defaultKey, item: { kind: "action", common: new MenuCommon() }, bind1: -1, bind2: -1 };
}
function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null,
    focusshader: null, width: 0, height: 0, focuscolor: null };
}
function proportional(): MenuProportional { return { kind: "proportional", common: new MenuCommon(), text: null, style: 0, color: COLORS.white }; }
function radio(): MenuRadio { return { kind: "radio", common: new MenuCommon(), curvalue: 0 }; }
function slider(): MenuSlider {
  return { kind: "slider", common: new MenuCommon(), minvalue: 0, maxvalue: 0, curvalue: 0, range: 0 };
}
function asciiUpper(text: string): string {
  return text.replace(/[a-z]/g, letter => String.fromCharCode(letter.charCodeAt(0) - 32));
}
function sourceString(text: string, size: number): string { return text.split("\0", 1).join("").slice(0, size - 1); }
function cleanName(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i), next = text.charCodeAt(i + 1);
    if (c === 94 && Number.isFinite(next) && next !== 94) { i++; continue; }
    if (c >= 32 && c <= 126) result += text.charAt(i);
  }
  return result;
}
export class BaseControlsMenu {
  readonly menu = new BaseMenu();
  private readonly playerInfo = new BasePlayerInfo();
  private readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, style: 0, color: COLORS.white };
  private readonly frameLeft = bitmap();
  private readonly frameRight = bitmap();
  private readonly player = bitmap();
  private readonly name = proportional();
  private readonly sections = [proportional(), proportional(), proportional(), proportional()];
  private readonly back = bitmap();
  private readonly freelook = radio();
  private readonly invert = radio();
  private readonly alwaysRun = radio();
  private readonly autoswitch = radio();
  private readonly sensitivity = slider();
  private readonly joystick = radio();
  private readonly joyThreshold = slider();
  private readonly smooth = radio();
  private readonly bindings: Binding[] = [
    binding("+scores", "show scores", Pose.Idle, KeyCode.Tab),
    binding("+button2", "use item", Pose.Idle, KeyCode.Enter),
    binding("+speed", "run / walk", Pose.Run, KeyCode.Shift),
    binding("+forward", "walk forward", Pose.Walk, KeyCode.Up),
    binding("+back", "backpedal", Pose.Back, KeyCode.Down),
    binding("+moveleft", "step left", Pose.StepLeft, 44),
    binding("+moveright", "step right", Pose.StepRight, 46),
    binding("+moveup", "up / jump", Pose.Jump, KeyCode.Space),
    binding("+movedown", "down / crouch", Pose.Crouch, 99),
    binding("+left", "turn left", Pose.TurnLeft, KeyCode.Left),
    binding("+right", "turn right", Pose.TurnRight, KeyCode.Right),
    binding("+strafe", "sidestep / turn", Pose.Idle, KeyCode.Alt),
    binding("+lookup", "look up", Pose.LookUp, KeyCode.PageDown),
    binding("+lookdown", "look down", Pose.LookDown, KeyCode.Delete),
    binding("+mlook", "mouse look", Pose.Idle, 47),
    binding("centerview", "center view", Pose.Idle, KeyCode.End),
    binding("+zoom", "zoom view", Pose.Idle, -1),
    binding("weapon 1", "gauntlet", Pose.Weapon1, 49),
    binding("weapon 2", "machinegun", Pose.Weapon2, 50),
    binding("weapon 3", "shotgun", Pose.Weapon3, 51),
    binding("weapon 4", "grenade launcher", Pose.Weapon4, 52),
    binding("weapon 5", "rocket launcher", Pose.Weapon5, 53),
    binding("weapon 6", "lightning", Pose.Weapon6, 54),
    binding("weapon 7", "railgun", Pose.Weapon7, 55),
    binding("weapon 8", "plasma gun", Pose.Weapon8, 56),
    binding("weapon 9", "BFG", Pose.Weapon9, 57),
    binding("+attack", "attack", Pose.Attack, KeyCode.Control),
    binding("weapprev", "prev weapon", Pose.Idle, 91),
    binding("weapnext", "next weapon", Pose.Idle, 93),
    binding("+button3", "gesture", Pose.Gesture, KeyCode.Mouse3),
    binding("messagemode", "chat", Pose.Chat, 116),
    binding("messagemode2", "chat - team", Pose.Chat, -1),
    binding("messagemode3", "chat - target", Pose.Chat, -1),
    binding("messagemode4", "chat - attacker", Pose.Chat, -1),
  ];
  private readonly cvars = ["cl_run", "m_pitch", "cg_autoswitch", "sensitivity", "in_joystick", "joy_threshold", "m_filter", "cl_freelook"]
    .map(name => ({ name, value: 0, defaultValue: 0 }));
  private readonly groups: readonly (readonly BaseMenuItem[])[];
  private section = 0;
  private waiting = false;
  private changed = false;
  private playerModel = "";
  private playerName = "";

  constructor(readonly state: BaseUiState, readonly players: BaseUiPlayers, readonly confirm: BaseConfirmMenu) {
    const actions = (...ids: number[]) => ids.map(id => itemAt(this.bindings, id).item);
    this.groups = [
      [this.alwaysRun, ...actions(2, 3, 4, 5, 6, 7, 8, 9, 10, 11)],
      [this.sensitivity, this.smooth, this.invert, ...actions(12, 13, 14), this.freelook, ...actions(15, 16), this.joystick, this.joyThreshold],
      [...actions(26, 28, 27), this.autoswitch, ...actions(17, 18, 19, 20, 21, 22, 23, 24, 25)],
      actions(0, 1, 29, 30, 31, 32, 33),
    ];
  }

  private value(name: string): number {
    const cvar = this.state.services.cvars.registry.get(name);
    return cvar === undefined ? 0 : Math.fround(cvar.numericValue);
  }
  private string(name: string, size: number): string {
    const cvar = this.state.services.cvars.registry.get(name);
    return cvar === undefined ? "" : sourceString(cvar.value, size);
  }
  private setValue(name: string, value: number): void {
    this.state.assertActive();
    this.state.services.cvars.registry.setValue(name, value);
  }
  private readWidgets(defaults: boolean): void {
    const value = (name: string) => {
      const cvar = this.cvars.find(cvar => cvar.name === name);
      if (cvar === undefined) return 0;
      return defaults ? cvar.defaultValue : cvar.value;
    };
    this.invert.curvalue = value("m_pitch") < 0 ? 1 : 0;
    const settings: readonly [MenuRadio | MenuSlider, string, number, number][] = [
      [this.smooth, "m_filter", 0, 1], [this.alwaysRun, "cl_run", 0, 1], [this.autoswitch, "cg_autoswitch", 0, 1],
      [this.sensitivity, "sensitivity", 2, 30], [this.joystick, "in_joystick", 0, 1],
      [this.joyThreshold, "joy_threshold", Math.fround(.05), Math.fround(.75)], [this.freelook, "cl_freelook", 0, 1],
    ];
    for (const [widget, name, min, max] of settings) {
      const current = defaults ? value(name) : clampCvar(min, max, value(name));
      widget.curvalue = widget.kind === "radio" ? nativeInt(current) : current;
    }
  }
  private getConfig(): void {
    for (const binding of this.bindings) {
      binding.bind1 = -1; binding.bind2 = -1;
      for (let key = 0; key < 256; key++) {
        const command = this.state.services.keys.getBinding(key);
        if (command === null || asciiUpper(sourceString(command, 256)) !== asciiUpper(binding.command)) continue;
        if (binding.bind1 === -1) binding.bind1 = key;
        else { binding.bind2 = key; break; }
      }
    }
    this.readWidgets(false);
  }
  private setConfig(): void {
    for (const binding of this.bindings) if (binding.bind1 !== -1) {
      this.state.services.keys.setBinding(binding.bind1, binding.command);
      if (binding.bind2 !== -1) this.state.services.keys.setBinding(binding.bind2, binding.command);
    }
    const pitch = Math.abs(this.value("m_pitch"));
    this.setValue("m_pitch", this.invert.curvalue !== 0 ? -pitch : pitch);
    for (const [name, widget] of [
      ["m_filter", this.smooth], ["cl_run", this.alwaysRun], ["cg_autoswitch", this.autoswitch],
      ["sensitivity", this.sensitivity], ["in_joystick", this.joystick], ["joy_threshold", this.joyThreshold], ["cl_freelook", this.freelook],
    ] satisfies [string, MenuRadio | MenuSlider][]) this.setValue(name, widget.curvalue);
    this.state.services.consoleCommands.append("in_restart\n");
  }
  private update(): void {
    for (const group of this.groups) for (const item of group) item.common.flags |= MenuFlag.Hidden | MenuFlag.Inactive;
    const group = itemAt(this.groups, this.section);
    let y = nativeInt((480 - group.length * 16) / 2);
    for (const item of group) {
      Object.assign(item.common, { x: 320, y, left: 168, right: 488, top: y, bottom: y + 16 });
      item.common.flags &= ~(MenuFlag.Grayed | MenuFlag.Hidden | MenuFlag.Inactive); y += 16;
    }
    if (this.waiting) {
      for (const item of this.menu.items) item.common.flags |= MenuFlag.Grayed;
      itemAt(this.menu.items, this.menu.cursor).common.flags &= ~MenuFlag.Grayed;
      this.name.common.flags &= ~MenuFlag.Grayed;
      return;
    }
    for (const item of this.menu.items) item.common.flags &= ~MenuFlag.Grayed;
    for (const item of this.sections) {
      item.common.flags &= ~(MenuFlag.Grayed | MenuFlag.Highlight | MenuFlag.HighlightIfFocus);
      item.common.flags |= MenuFlag.PulseIfFocus;
    }
    const selected = itemAt(this.sections, this.section);
    selected.common.flags &= ~MenuFlag.PulseIfFocus;
    selected.common.flags |= MenuFlag.Highlight | MenuFlag.HighlightIfFocus;
  }
  private drawBinding(item: BaseMenuItem): void {
    const binding = itemAt(this.bindings, item.common.id), c = item.common, focused = itemAt(this.menu.items, this.menu.cursor) === item;
    let name = binding.bind1 === -1 ? "???" : asciiUpper(sourceString(keynumToString(binding.bind1), 32));
    if (binding.bind1 !== -1 && binding.bind2 !== -1) name += ` or ${asciiUpper(sourceString(keynumToString(binding.bind2), 32))}`;
    const color = focused ? COLORS.highlight : c.flags & MenuFlag.Grayed ? COLORS.disabled : COLORS.normal;
    if (focused) fillRect(this.state, c.left, c.top, c.right - c.left + 1, c.bottom - c.top + 1, COLORS.listbar);
    drawString(this.state, c.x - 8, c.y, binding.label, UI_RIGHT | UI_SMALLFONT, color);
    drawString(this.state, c.x + 8, c.y, name, UI_LEFT | UI_SMALLFONT | (focused ? UI_PULSE : 0), color);
    if (!focused) return;
    drawChar(this.state, c.x, c.y, this.waiting ? 61 : 13, UI_CENTER | UI_BLINK | UI_SMALLFONT, COLORS.highlight);
    if (this.waiting) drawString(this.state, 320, 384, "Waiting for new key ... ESCAPE to cancel", UI_SMALLFONT | UI_CENTER | UI_PULSE, COLORS.white);
    else {
      drawString(this.state, 320, Math.fround(480 * .78), "Press ENTER or CLICK to change", UI_SMALLFONT | UI_CENTER, COLORS.white);
      drawString(this.state, 320, Math.fround(480 * .82), "Press BACKSPACE to clear", UI_SMALLFONT | UI_CENTER, COLORS.white);
    }
  }
  private async updateModel(pose: Pose): Promise<void> {
    const viewAngles = { x: 0, y: 150, z: 0 }, moveAngles = { x: 0, y: 150, z: 0 };
    let legsAnim = PlayerAnimation.LEGS_IDLE, torsoAnim = PlayerAnimation.TORSO_STAND, weaponNumber = -1, chat = false;
    switch (pose) {
      case Pose.Run: legsAnim = PlayerAnimation.LEGS_RUN; break;
      case Pose.Walk: legsAnim = PlayerAnimation.LEGS_WALK; break;
      case Pose.Back: legsAnim = PlayerAnimation.LEGS_BACK; break;
      case Pose.Jump: legsAnim = PlayerAnimation.LEGS_JUMP; break;
      case Pose.Crouch: legsAnim = PlayerAnimation.LEGS_IDLECR; break;
      case Pose.TurnLeft: viewAngles.y += 90; break;
      case Pose.TurnRight: viewAngles.y -= 90; break;
      case Pose.StepLeft: legsAnim = PlayerAnimation.LEGS_WALK; moveAngles.y = viewAngles.y + 90; break;
      case Pose.StepRight: legsAnim = PlayerAnimation.LEGS_WALK; moveAngles.y = viewAngles.y - 90; break;
      case Pose.LookUp: viewAngles.x = -45; break;
      case Pose.LookDown: viewAngles.x = 45; break;
      case Pose.Weapon1: case Pose.Weapon2: case Pose.Weapon3: case Pose.Weapon4: case Pose.Weapon5:
      case Pose.Weapon6: case Pose.Weapon7: case Pose.Weapon8: case Pose.Weapon9: case Pose.Weapon10:
        weaponNumber = pose - Pose.Weapon1 + 1; break;
      case Pose.Attack: torsoAnim = PlayerAnimation.TORSO_ATTACK; break;
      case Pose.Gesture: torsoAnim = PlayerAnimation.TORSO_GESTURE; break;
      case Pose.Die: legsAnim = PlayerAnimation.BOTH_DEATH1; torsoAnim = PlayerAnimation.BOTH_DEATH1; weaponNumber = 0; break;
      case Pose.Chat: chat = true; break;
      case Pose.Idle: break;
    }
    await this.players.setInfo(this.playerInfo, { legsAnim, torsoAnim, viewAngles, moveAngles, weaponNumber, chat });
    this.state.assertActive();
  }
  private async drawPlayer(): Promise<void> {
    const model = this.string("model", 64);
    if (model !== this.playerModel) {
      await this.players.setModel(this.playerInfo, model); this.state.assertActive();
      this.playerModel = model;
      await this.updateModel(Pose.Idle); this.state.assertActive();
    }
    await this.players.drawPlayer({ x: this.player.common.x, y: this.player.common.y, width: this.player.width, height: this.player.height },
      this.playerInfo, nativeInt(this.state.realtime / 2));
    this.state.assertActive();
  }
  private async key(key: number): Promise<MenuSound> {
    this.state.assertActive();
    if (!this.waiting) {
      if (key === KeyCode.Backspace || key === KeyCode.Delete || key === KeyCode.KeypadDelete) key = -1;
      else {
        if ((key === KeyCode.Mouse2 || key === KeyCode.Escape) && this.changed) this.setConfig();
        return await defaultKey(this.state, this.menu, key);
      }
    } else {
      if ((key & KEY_CHAR_FLAG) !== 0 || key === 96) return await defaultKey(this.state, this.menu, key);
      if (key === KeyCode.Escape) { this.waiting = false; this.update(); return menuSound(this.state.media.out); }
    }
    this.changed = true;
    if (key !== -1) for (const binding of this.bindings) {
      if (binding.bind2 === key) binding.bind2 = -1;
      if (binding.bind1 === key) { binding.bind1 = binding.bind2; binding.bind2 = -1; }
    }
    const id = itemAt(this.menu.items, this.menu.cursor).common.id;
    const binding = this.bindings.find(binding => binding.item.common.id === id);
    if (binding !== undefined) {
      if (key === -1) {
        if (binding.bind1 !== -1) { this.state.services.keys.setBinding(binding.bind1, ""); binding.bind1 = -1; }
        if (binding.bind2 !== -1) { this.state.services.keys.setBinding(binding.bind2, ""); binding.bind2 = -1; }
      } else if (binding.bind1 === -1) binding.bind1 = key;
      else if (binding.bind1 !== key && binding.bind2 === -1) binding.bind2 = key;
      else {
        this.state.services.keys.setBinding(binding.bind1, ""); this.state.services.keys.setBinding(binding.bind2, "");
        binding.bind1 = key; binding.bind2 = -1;
      }
    }
    this.waiting = false;
    if (binding !== undefined) { this.update(); return menuSound(this.state.media.out); }
    return await defaultKey(this.state, this.menu, key);
  }
  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    const id = item.common.id;
    if (id >= 100 && id <= 103) { this.section = id - 100; this.update(); }
    else if (id === 104) {
      await this.confirm.show("SET TO DEFAULTS?", async () => {
        drawProportional(this.state, 320, 356, "WARNING: This will reset all", UI_CENTER | UI_SMALLFONT, COLORS.highlight);
        drawProportional(this.state, 320, 383, "controls to their default values.", UI_CENTER | UI_SMALLFONT, COLORS.highlight);
      }, async result => {
        if (!result) return;
        this.changed = true;
        for (const binding of this.bindings) { binding.bind1 = binding.defaultKey; binding.bind2 = -1; }
        this.readWidgets(true); this.update();
      }); this.state.assertActive();
    } else if (id >= 105 && id <= 107) {
      if ((id === 105 && this.changed) || id === 106) this.setConfig();
      await popMenu(this.state); this.state.assertActive();
    } else if (id >= 34 && id <= 41) this.changed = true;
  }
  private async action(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event === MenuEvent.LostFocus || event === MenuEvent.GotFocus) {
      await this.updateModel(event === MenuEvent.LostFocus ? Pose.Idle : itemAt(this.bindings, item.common.id).pose);
      this.state.assertActive();
    } else if (event === MenuEvent.Activated && !this.waiting) { this.waiting = true; this.update(); }
  }
  async cache(): Promise<void> {
    this.state.assertActive();
    for (const path of ["menu/art/back_0", "menu/art/back_1", "menu/art/frame2_l", "menu/art/frame1_r"]) {
      await this.state.services.resources.registerShaderNoMip(path); this.state.assertActive();
    }
  }
  async show(): Promise<void> {
    this.state.assertActive();
    this.menu.items.length = 0;
    Object.assign(this.menu, { cursor: 0, cursorPrev: 0, itemCount: 0, draw: null, key: null, wrapAround: false, fullscreen: false, showlogo: false });
    this.section = 0; this.waiting = false; this.changed = false; this.playerModel = "";
    clearBasePlayerInfo(this.playerInfo);
    for (const item of [this.banner, this.frameLeft, this.frameRight, this.player, this.name, ...this.sections, ...this.groups.flat(), this.back]) {
      Object.assign(item.common, new MenuCommon());
      if (item.kind === "bitmap") Object.assign(item, { focuspic: null, errorpic: null, shader: null, focusshader: null, width: 0, height: 0, focuscolor: null });
      if (item.kind === "slider") { item.minvalue = 0; item.maxvalue = 0; item.curvalue = 0; item.range = 0; }
      if (item.kind === "radio") item.curvalue = 0;
      if (item.kind === "banner" || item.kind === "proportional") { item.text = null; item.style = 0; item.color = COLORS.white; }
    }
    await this.cache(); this.state.assertActive();
    this.menu.key = key => this.key(key); this.menu.wrapAround = true; this.menu.fullscreen = true;
    Object.assign(this.banner.common, { flags: MenuFlag.CenterJustify, x: 320, y: 16 });
    Object.assign(this.banner, { text: "CONTROLS", color: COLORS.white, style: UI_CENTER });
    for (const [item, path, x, y, width, height] of [
      [this.frameLeft, "menu/art/frame2_l", 0, 78, 256, 329], [this.frameRight, "menu/art/frame1_r", 376, 76, 256, 334],
    ] satisfies [MenuBitmap, string, number, number, number, number][]) {
      Object.assign(item.common, { name: path, flags: MenuFlag.LeftJustify | MenuFlag.Inactive, x, y });
      item.width = width; item.height = height;
    }
    for (const [index, item] of this.sections.entries()) {
      const labels = ["MOVE", "LOOK", "SHOOT", "MISC"], ys = [213, 186, 240, 267];
      Object.assign(item.common, { flags: MenuFlag.RightJustify | MenuFlag.PulseIfFocus, id: 100 + index, x: 152, y: itemAt(ys, index) });
      item.common.callback = (item, event) => this.event(item, event);
      item.text = itemAt(labels, index); item.style = UI_RIGHT; item.color = COLORS.red;
    }
    Object.assign(this.back.common, { name: "menu/art/back_0", flags: MenuFlag.LeftJustify | MenuFlag.PulseIfFocus, x: 0, y: 416, id: 105 });
    this.back.common.callback = (item, event) => this.event(item, event);
    this.back.width = 128; this.back.height = 64; this.back.focuspic = "menu/art/back_1";
    Object.assign(this.player.common, { flags: MenuFlag.Inactive, x: 400, y: -40 });
    this.player.common.ownerdraw = () => this.drawPlayer(); this.player.width = 320; this.player.height = 560;
    for (const [id, binding] of this.bindings.entries()) {
      Object.assign(binding.item.common, { id, flags: MenuFlag.LeftJustify | (id === 14 ? MenuFlag.HighlightIfFocus : MenuFlag.PulseIfFocus) | MenuFlag.Grayed | MenuFlag.Hidden });
      binding.item.common.callback = (item, event) => this.action(item, event);
      binding.item.common.ownerdraw = async item => { this.drawBinding(item); };
    }
    for (const [id, item, name] of [
      [34, this.freelook, "free look"], [35, this.invert, "invert mouse"], [36, this.alwaysRun, "always run"],
      [37, this.autoswitch, "autoswitch weapons"], [38, this.sensitivity, "mouse speed"], [39, this.joystick, "joystick"],
      [40, this.joyThreshold, "joystick threshold"], [41, this.smooth, "smooth mouse"],
    ] satisfies [number, MenuRadio | MenuSlider, string][]) {
      Object.assign(item.common, { id, name, flags: MenuFlag.SmallFont, x: 320 });
      item.common.callback = (item, event) => this.event(item, event);
      item.common.statusbar = async () => { drawString(this.state, 320, 384, "Use Arrow Keys or CLICK to change", UI_SMALLFONT | UI_CENTER, COLORS.white); };
      if (item === this.sensitivity) { item.minvalue = 2; item.maxvalue = 30; }
      if (item === this.joyThreshold) { item.minvalue = Math.fround(.05); item.maxvalue = Math.fround(.75); }
    }
    Object.assign(this.name.common, { flags: MenuFlag.CenterJustify | MenuFlag.Inactive, x: 320, y: 440 });
    // Menu_AddItem sees the retained static playername buffer before this show's cvar read.
    this.name.text = this.playerName;
    this.name.style = UI_CENTER; this.name.color = COLORS.normal;
    for (const item of [this.banner, this.frameLeft, this.frameRight, this.player, this.name,
      itemAt(this.sections, 1), itemAt(this.sections, 0), itemAt(this.sections, 2), itemAt(this.sections, 3),
      ...itemAt(this.groups, 1), ...itemAt(this.groups, 0), ...itemAt(this.groups, 2), ...itemAt(this.groups, 3), this.back]) addItem(this.state, this.menu, item);
    this.playerName = cleanName(this.string("name", 16));
    this.name.text = this.playerName;
    for (const cvar of this.cvars) {
      cvar.value = this.value(cvar.name);
      this.state.services.cvars.registry.reset(cvar.name);
      cvar.defaultValue = this.value(cvar.name);
      this.setValue(cvar.name, cvar.value);
    }
    this.getConfig();
    await this.players.setModel(this.playerInfo, this.string("model", 1024)); this.state.assertActive();
    await this.updateModel(Pose.Idle); this.state.assertActive();
    for (const item of itemList("baseq3")) if (item.type === ItemType.IT_WEAPON) {
      const path = item.worldModels[0];
      if (path === null) throw new Error("Weapon item has no source world model");
      await this.state.services.resources.registerModel(path); this.state.assertActive();
    }
    this.section = 1; this.update();
    await pushMenu(this.state, this.menu); this.state.assertActive();
  }
}
