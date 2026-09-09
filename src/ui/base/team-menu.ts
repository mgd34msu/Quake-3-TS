// Team menu from id Software code/q3_ui/ui_team.c. GPL-2.0-or-later.
import { infoValueForKey } from "../../core/info-string.ts";
import { sourceCommandText } from "../../core/text.ts";
import { gameAtoi } from "../../game/numeric.ts";
import { UI_CENTER, UI_SMALLFONT } from "../../render/font.ts";
import { GameType } from "../../shared/definitions.ts";
import { addItem, forceMenuOff, pushMenu } from "./framework.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBitmap, MenuCallback, MenuProportional } from "./state.ts";

const FRAME = "menu/art/cut_frame";
enum TeamId { JoinRed = 100, JoinBlue = 101, JoinGame = 102, Spectate = 103 }

function proportional(): MenuProportional {
  return { kind: "proportional", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
}

class TeamRecord {
  readonly menu = new BaseMenu();
  readonly frame: MenuBitmap = {
    kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null,
    shader: null, focusshader: null, width: 0, height: 0, focuscolor: null,
  };
  readonly joinRed = proportional();
  readonly joinBlue = proportional();
  readonly joinGame = proportional();
  readonly spectate = proportional();

  reset(): void {
    this.menu.cursor = 0; this.menu.cursorPrev = 0; this.menu.itemCount = 0; this.menu.items.length = 0;
    this.menu.draw = null; this.menu.key = null; this.menu.wrapAround = false;
    this.menu.fullscreen = false; this.menu.showlogo = false;
    Object.assign(this.frame.common, new MenuCommon());
    this.frame.focuspic = null; this.frame.errorpic = null; this.frame.shader = null;
    this.frame.focusshader = null; this.frame.width = 0; this.frame.height = 0; this.frame.focuscolor = null;
    for (const item of [this.joinRed, this.joinBlue, this.joinGame, this.spectate]) {
      Object.assign(item.common, new MenuCommon());
      item.text = null; item.color = COLORS.white; item.style = 0;
    }
  }
}

export class BaseTeamMenu {
  private readonly record = new TeamRecord();
  private readonly callback: MenuCallback = (item, event) => this.event(item, event);

  constructor(readonly state: BaseUiState, private readonly readServerInfo: () => string) {}

  get menu(): BaseMenu { return this.record.menu; }

  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    let command: string;
    switch (item.common.id) {
      case TeamId.JoinRed: command = "cmd team red\n"; break;
      case TeamId.JoinBlue: command = "cmd team blue\n"; break;
      case TeamId.JoinGame: command = "cmd team free\n"; break;
      case TeamId.Spectate: command = "cmd team spectator\n"; break;
      default: return;
    }
    this.state.services.consoleCommands.append(command);
    await forceMenuOff(this.state);
    this.state.assertActive();
  }

  async cache(): Promise<void> {
    this.state.assertActive();
    await this.state.services.resources.registerShaderNoMip(FRAME);
    this.state.assertActive();
  }

  private async initialize(): Promise<void> {
    this.state.assertActive();
    const record = this.record;
    record.reset();
    await this.cache();
    this.state.assertActive();
    record.menu.wrapAround = true;
    record.frame.common.name = FRAME; record.frame.common.flags = MenuFlag.Inactive;
    record.frame.common.x = 142; record.frame.common.y = 118;
    record.frame.width = 359; record.frame.height = 256;
    const choices: readonly (readonly [MenuProportional, TeamId, string, number])[] = [
      [record.joinRed, TeamId.JoinRed, "JOIN RED", 194],
      [record.joinBlue, TeamId.JoinBlue, "JOIN BLUE", 214],
      [record.joinGame, TeamId.JoinGame, "JOIN GAME", 234],
      [record.spectate, TeamId.Spectate, "SPECTATE", 254],
    ];
    for (const [item, id, text, y] of choices) {
      item.common.flags = MenuFlag.CenterJustify | MenuFlag.PulseIfFocus;
      item.common.id = id; item.common.callback = this.callback; item.common.x = 320; item.common.y = y;
      item.text = text; item.style = UI_CENTER | UI_SMALLFONT; item.color = COLORS.red;
    }
    const info = sourceCommandText(this.readServerInfo().slice(0, 1023));
    const gameType = gameAtoi(infoValueForKey(info, "g_gametype"));
    switch (gameType) {
      case GameType.GT_SINGLE_PLAYER:
      case GameType.GT_FFA:
      case GameType.GT_TOURNAMENT:
        record.joinRed.common.flags |= MenuFlag.Grayed;
        record.joinBlue.common.flags |= MenuFlag.Grayed;
        break;
      default:
        record.joinGame.common.flags |= MenuFlag.Grayed;
        break;
    }
    for (const item of [record.frame, record.joinRed, record.joinBlue, record.joinGame, record.spectate])
      addItem(this.state, record.menu, item);
  }

  async show(): Promise<void> {
    await this.initialize();
    this.state.assertActive();
    await pushMenu(this.state, this.record.menu);
    this.state.assertActive();
  }
}
