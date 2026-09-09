// Credits menu from id Software code/q3_ui/ui_credits.c. GPL-2.0-or-later.
// Copyright (C) 1999-2005 Id Software, Inc.
import { KEY_CHAR_FLAG } from "../../core/key-codes.ts";
import { UI_CENTER, UI_SMALLFONT } from "../../render/font.ts";
import { drawProportional, drawString } from "./draw.ts";
import { pushMenu } from "./framework.ts";
import { BaseMenu, COLORS, nativeInt, NO_SOUND } from "./state.ts";
import type { BaseUiState, MenuSound } from "./state.ts";

export class BaseCreditsMenu {
  private readonly record = new BaseMenu();
  constructor(readonly state: BaseUiState) {}
  get menu(): BaseMenu { return this.record; }

  private readonly key = async (key: number): Promise<MenuSound> => {
    this.state.assertActive();
    if ((key & KEY_CHAR_FLAG) !== 0) return NO_SOUND;
    this.state.services.consoleCommands.append("quit\n");
    this.state.assertActive();
    return NO_SOUND;
  };

  private readonly draw = async (): Promise<void> => {
    this.state.assertActive();
    const style = UI_CENTER | UI_SMALLFONT;
    let y = 12;
    drawProportional(this.state, 320, y, "id Software is:", style, COLORS.white);
    y = nativeInt(y + 1.42 * 27 * .75);
    drawProportional(this.state, 320, y, "Programming", style, COLORS.white);
    y = nativeInt(y + 27 * .75);
    drawProportional(this.state, 320, y, "John Carmack, Robert A. Duffy, Jim Dose'", style, COLORS.white);
    y = nativeInt(y + 1.42 * 27 * .75);
    drawProportional(this.state, 320, y, "Art", style, COLORS.white);
    y = nativeInt(y + 27 * .75);
    drawProportional(this.state, 320, y, "Adrian Carmack, Kevin Cloud,", style, COLORS.white);
    y = nativeInt(y + 27 * .75);
    drawProportional(this.state, 320, y, "Kenneth Scott, Seneca Menard, Fred Nilsson", style, COLORS.white);
    y = nativeInt(y + 1.42 * 27 * .75);
    drawProportional(this.state, 320, y, "Game Designer", style, COLORS.white);
    y = nativeInt(y + 27 * .75);
    drawProportional(this.state, 320, y, "Graeme Devine", style, COLORS.white);
    y = nativeInt(y + 1.42 * 27 * .75);
    drawProportional(this.state, 320, y, "Level Design", style, COLORS.white);
    y = nativeInt(y + 27 * .75);
    drawProportional(this.state, 320, y, "Tim Willits, Christian Antkow, Paul Jaquays", style, COLORS.white);
    y = nativeInt(y + 1.42 * 27 * .75);
    drawProportional(this.state, 320, y, "CEO", style, COLORS.white);
    y = nativeInt(y + 27 * .75);
    drawProportional(this.state, 320, y, "Todd Hollenshead", style, COLORS.white);
    y = nativeInt(y + 1.42 * 27 * .75);
    drawProportional(this.state, 320, y, "Director of Business Development", style, COLORS.white);
    y = nativeInt(y + 27 * .75);
    drawProportional(this.state, 320, y, "Marty Stratton", style, COLORS.white);
    y = nativeInt(y + 1.42 * 27 * .75);
    drawProportional(this.state, 320, y, "Biz Assist and id Mom", style, COLORS.white);
    y = nativeInt(y + 27 * .75);
    drawProportional(this.state, 320, y, "Donna Jackson", style, COLORS.white);
    y = nativeInt(y + 1.42 * 27 * .75);
    drawProportional(this.state, 320, y, "Development Assistance", style, COLORS.white);
    y = nativeInt(y + 27 * .75);
    drawProportional(this.state, 320, y, "Eric Webb", style, COLORS.white);
    y = nativeInt(y + 1.35 * 27 * .75);
    drawString(this.state, 320, y, "To order: 1-800-idgames     www.quake3arena.com     www.idsoftware.com", style, COLORS.red);
    y += 16;
    drawString(this.state, 320, y, "Quake III Arena(c) 1999-2000, Id Software, Inc.  All Rights Reserved", style, COLORS.red);
    this.state.assertActive();
  };

  async show(): Promise<void> {
    this.state.assertActive();
    const menu = this.record;
    menu.cursor = 0; menu.cursorPrev = 0; menu.itemCount = 0; menu.items.length = 0;
    menu.draw = null; menu.key = null; menu.wrapAround = false; menu.fullscreen = false; menu.showlogo = false;
    menu.draw = this.draw; menu.key = this.key; menu.fullscreen = true;
    await pushMenu(this.state, menu);
    this.state.assertActive();
  }
}
