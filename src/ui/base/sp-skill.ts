// Single-player skill menu from id Software q3_ui/ui_spskill.c. GPL-2.0-or-later.
import type { PcmSound } from "../../assets/wav.ts";
import { KeyCode } from "../../core/key-codes.ts";
import type { Vec4 } from "../../core/math.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { UI_CENTER } from "../../render/font.ts";
import type { SceneShader } from "../../render/ref-entity.ts";
import { addItem, defaultKey, popMenu, pushMenu, setCursorToItem } from "./framework.ts";
import type { BaseUiGameInfo } from "./game-info.ts";
import { startSinglePlayerArena } from "./sp-arena.ts";
import { BaseMenu, COLORS, itemAt, MenuCommon, MenuEvent, MenuFlag } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap, MenuProportional, MenuSound } from "./state.ts";

const FRAME = "menu/art/cut_frame", BACK = "menu/art/back_0.tga", BACK_FOCUS = "menu/art/back_1.tga";
const FIGHT = "menu/art/fight_0", FIGHT_FOCUS = "menu/art/fight_1";
const SKILL_PICS = ["menu/art/level_complete1", "menu/art/level_complete2", "menu/art/level_complete3",
  "menu/art/level_complete4", "menu/art/level_complete5"];
enum SkillId { Baby = 10, Easy = 11, Medium = 12, Hard = 13, Nightmare = 14, Back = 15, Fight = 16 }

function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null,
    focusshader: null, width: 0, height: 0, focuscolor: null };
}
function proportional(): MenuProportional {
  return { kind: "proportional", common: new MenuCommon(), text: null, style: 0, color: COLORS.white };
}
class SkillRecord {
  readonly menu = new BaseMenu();
  readonly frame = bitmap();
  readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, style: 0, color: COLORS.white };
  readonly baby = proportional();
  readonly easy = proportional();
  readonly medium = proportional();
  readonly hard = proportional();
  readonly nightmare = proportional();
  readonly skillPic = bitmap();
  readonly back = bitmap();
  readonly fight = bitmap();
  arenaInfo: string | null = null;
  readonly skillpics: (SceneShader | null)[] = [null, null, null, null, null];
  nightmareSound: PcmSound | null = null;
  silenceSound: PcmSound | null = null;

  reset(): void {
    this.menu.cursor = 0; this.menu.cursorPrev = 0; this.menu.itemCount = 0; this.menu.items.length = 0;
    this.menu.draw = null; this.menu.key = null; this.menu.wrapAround = false; this.menu.fullscreen = false; this.menu.showlogo = false;
    for (const item of [this.banner, this.baby, this.easy, this.medium, this.hard, this.nightmare]) {
      Object.assign(item.common, new MenuCommon()); item.text = null; item.style = 0; item.color = COLORS.white;
    }
    for (const item of [this.frame, this.skillPic, this.back, this.fight]) {
      Object.assign(item.common, new MenuCommon()); item.focuspic = null; item.errorpic = null; item.shader = null;
      item.focusshader = null; item.width = 0; item.height = 0; item.focuscolor = null;
    }
    this.arenaInfo = null; this.skillpics.fill(null); this.nightmareSound = null; this.silenceSound = null;
  }
}

export class BaseSpSkillMenu {
  private readonly record = new SkillRecord();
  constructor(readonly state: BaseUiState, private readonly gameInfo: BaseUiGameInfo) {}
  get menu(): BaseMenu { return this.record.menu; }

  private setSkillColor(skill: number, color: Vec4): void {
    switch (skill) {
      case 1: this.record.baby.color = color; break;
      case 2: this.record.easy.color = color; break;
      case 3: this.record.medium.color = color; break;
      case 4: this.record.hard.color = color; break;
      case 5: this.record.nightmare.color = color; break;
    }
  }
  private announce(sound: PcmSound | null): void {
    this.state.assertActive();
    const resolved = this.state.services.sounds.resolveForPlayback(sound);
    if (resolved !== null) this.state.services.audio.startLocalSound(resolved, 7);
  }
  private async skillEvent(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    const cvars = this.state.services.cvars.registry, oldSkill = cvars.get("g_spSkill");
    this.setSkillColor(qvmFloatToInt(oldSkill === undefined ? 0 : oldSkill.numericValue), COLORS.red);
    const id = item.common.id, skill = id - SkillId.Baby + 1;
    cvars.set("g_spSkill", String(skill), true);
    this.setSkillColor(skill, COLORS.white);
    this.record.skillPic.shader = itemAt(this.record.skillpics, skill - 1);
    this.announce(id === SkillId.Nightmare ? this.record.nightmareSound : this.record.silenceSound);
  }
  private async fightEvent(_item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    startSinglePlayerArena(this.state, this.gameInfo, this.record.arenaInfo);
  }
  private async backEvent(_item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    this.announce(this.record.silenceSound);
    await popMenu(this.state); this.state.assertActive();
  }
  private async key(key: number): Promise<MenuSound> {
    this.state.assertActive();
    if (key === KeyCode.Mouse2 || key === KeyCode.Escape) this.announce(this.record.silenceSound);
    const sound = await defaultKey(this.state, this.record.menu, key); this.state.assertActive();
    return sound;
  }
  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of [FRAME, BACK, BACK_FOCUS, FIGHT, FIGHT_FOCUS]) {
      await this.state.services.resources.registerShaderNoMip(name); this.state.assertActive();
    }
    for (const [index, name] of SKILL_PICS.entries()) {
      const shader = await this.state.services.resources.registerShaderNoMip(name); this.state.assertActive();
      this.record.skillpics[index] = shader;
    }
    const nightmare = await this.state.services.sounds.registerSound("sound/misc/nightmare.wav", false); this.state.assertActive();
    this.record.nightmareSound = nightmare;
    const silence = await this.state.services.sounds.registerSound("sound/misc/silence.wav", false); this.state.assertActive();
    this.record.silenceSound = silence;
  }
  private async initialize(): Promise<void> {
    this.state.assertActive();
    const r = this.record; r.reset(); r.menu.fullscreen = true; r.menu.key = key => this.key(key);
    await this.cache(); this.state.assertActive();
    r.frame.common.name = FRAME; r.frame.common.flags = MenuFlag.LeftJustify | MenuFlag.Inactive;
    r.frame.common.x = 142; r.frame.common.y = 118; r.frame.width = 359; r.frame.height = 256;
    r.banner.common.flags = MenuFlag.CenterJustify; r.banner.common.x = 320; r.banner.common.y = 16;
    r.banner.text = "DIFFICULTY"; r.banner.color = COLORS.white; r.banner.style = UI_CENTER;
    const skills: readonly (readonly [MenuProportional, SkillId, string, number])[] = [
      [r.baby, SkillId.Baby, "I Can Win", 170], [r.easy, SkillId.Easy, "Bring It On", 198],
      [r.medium, SkillId.Medium, "Hurt Me Plenty", 227], [r.hard, SkillId.Hard, "Hardcore", 255],
      [r.nightmare, SkillId.Nightmare, "NIGHTMARE!", 283],
    ];
    for (const [item, id, text, y] of skills) {
      item.common.flags = MenuFlag.CenterJustify | MenuFlag.PulseIfFocus; item.common.x = 320; item.common.y = y;
      item.common.callback = (target, event) => this.skillEvent(target, event); item.common.id = id;
      item.text = text; item.color = COLORS.red; item.style = UI_CENTER;
    }
    r.back.common.name = BACK; r.back.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
    r.back.common.x = 0; r.back.common.y = 416; r.back.common.callback = (item, event) => this.backEvent(item, event);
    r.back.common.id = SkillId.Back; r.back.width = 128; r.back.height = 64; r.back.focuspic = BACK_FOCUS;
    r.skillPic.common.flags = MenuFlag.LeftJustify | MenuFlag.Inactive;
    r.skillPic.common.x = 256; r.skillPic.common.y = 368; r.skillPic.width = 128; r.skillPic.height = 96;
    r.fight.common.name = FIGHT; r.fight.common.flags = MenuFlag.RightJustify | MenuFlag.PulseIfFocus;
    r.fight.common.callback = (item, event) => this.fightEvent(item, event); r.fight.common.id = SkillId.Fight;
    r.fight.common.x = 640; r.fight.common.y = 416; r.fight.width = 128; r.fight.height = 64; r.fight.focuspic = FIGHT_FOCUS;
    for (const item of [r.frame, r.banner, r.baby, r.easy, r.medium, r.hard, r.nightmare, r.skillPic, r.back, r.fight]) addItem(this.state, r.menu, item);
    const variable = this.state.services.cvars.registry.get("g_spSkill"), value = variable === undefined ? 0 : variable.numericValue;
    const skill = qvmFloatToInt(value < 1 ? 1 : value > 5 ? 5 : value);
    this.setSkillColor(skill, COLORS.white); r.skillPic.shader = itemAt(r.skillpics, skill - 1);
    if (skill === 5) this.announce(r.nightmareSound);
  }
  async show(arenaInfo: string | null): Promise<void> {
    await this.initialize(); this.state.assertActive();
    this.record.arenaInfo = arenaInfo;
    await pushMenu(this.state, this.record.menu); this.state.assertActive();
    await setCursorToItem(this.state, this.record.menu, this.record.fight); this.state.assertActive();
  }
}
