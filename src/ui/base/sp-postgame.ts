// Single-player postgame from id Software q3_ui/ui_sppostgame.c. GPL-2.0-or-later.
import type { PcmSound } from "../../assets/wav.ts";
import type { CommandContext } from "../../core/commands.ts";
import { infoValueForKey } from "../../core/info-string.ts";
import { KeyCatcher, KeyCode } from "../../core/key-codes.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { sourceCommandText } from "../../core/text.ts";
import type { EngineClientSession } from "../../engine/client-session.ts";
import { gameAtoi } from "../../game/numeric.ts";
import { UI_CENTER, UI_LEFT, UI_SMALLFONT } from "../../render/font.ts";
import { drawNamed, drawProportional, drawString, stringWidth } from "./draw.ts";
import { addItem, defaultKey, drawMenu, popMenu, pushMenu, setCursorToItem } from "./framework.ts";
import type { BaseUiGameInfo } from "./game-info.ts";
import { MEDAL_NAMES, MEDAL_PICTURES, MEDAL_SOUNDS } from "./medals.ts";
import { startSinglePlayerArena } from "./sp-arena.ts";
import { BaseMenu, COLORS, itemAt, MenuCommon, MenuEvent, MenuFlag, nativeInt, NO_SOUND } from "./state.ts";
import type { BaseUiState, MenuBitmap, MenuCallback, MenuSound } from "./state.ts";

const MENU = "menu/art/menu_0", MENU_FOCUS = "menu/art/menu_1";
const REPLAY = "menu/art/replay_0", REPLAY_FOCUS = "menu/art/replay_1";
const NEXT = "menu/art/next_0", NEXT_FOCUS = "menu/art/next_1";
const MEDAL_LOCATIONS: readonly number[] = [144, 448, 88, 504, 32, 560];
const RANK_TIED = 0x4000, AWARD_TIME = 2000;
enum Id { Again = 10, Next = 11, Menu = 12 }
function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null,
    focusshader: null, width: 0, height: 0, focuscolor: null };
}
function cleanName(info: string): string {
  const copied = infoValueForKey(info, "n").slice(0, 63);
  let result = "";
  for (let n = 0; n < copied.length; n++) {
    const code = copied.charCodeAt(n), next = copied.charAt(n + 1);
    if (code === 94 && next !== "" && next !== "^") n++;
    else if (code >= 32 && code <= 126) result += copied.charAt(n);
  }
  return result;
}
class PostgameRecord {
  readonly menu = new BaseMenu();
  readonly again = bitmap();
  readonly next = bitmap();
  readonly returnMenu = bitmap();
  readonly clientNums = new Array<number>(8).fill(0);
  readonly ranks = new Array<number>(8).fill(0);
  readonly scores = new Array<number>(8).fill(0);
  readonly placeNames = new Array<string>(3).fill("");
  readonly awardsEarned = new Array<number>(6).fill(0);
  readonly awardsLevels = new Array<number>(6).fill(0);
  readonly playedSound = new Array<boolean>(6).fill(false);
  phase = 0;
  ignoreKeysTime = 0;
  starttime = 0;
  scoreboardtime = 0;
  serverId = 0;
  level = 0;
  numClients = 0;
  won = 0;
  numAwards = 0;
  lastTier = 0;
  winnerSound: PcmSound | null = null;
  reset(): void {
    const menu = this.menu;
    menu.cursor = 0; menu.cursorPrev = 0; menu.itemCount = 0; menu.items.length = 0;
    menu.draw = null; menu.key = null; menu.fullscreen = false; menu.wrapAround = false; menu.showlogo = false;
    for (const item of [this.again, this.next, this.returnMenu]) {
      Object.assign(item.common, new MenuCommon()); item.focuspic = null; item.errorpic = null;
      item.shader = null; item.focusshader = null; item.width = 0; item.height = 0; item.focuscolor = null;
    }
    this.clientNums.fill(0); this.ranks.fill(0); this.scores.fill(0); this.placeNames.fill("");
    this.awardsEarned.fill(0); this.awardsLevels.fill(0); this.playedSound.fill(false);
    this.phase = 0; this.ignoreKeysTime = 0; this.starttime = 0; this.scoreboardtime = 0; this.serverId = 0;
    this.level = 0; this.numClients = 0; this.won = 0; this.numAwards = 0; this.lastTier = 0; this.winnerSound = null;
  }
}

export class BaseSpPostgameMenu {
  private readonly record = new PostgameRecord();
  private arenaInfo = "";
  constructor(readonly state: BaseUiState, private readonly gameInfo: BaseUiGameInfo,
    private readonly client: Pick<EngineClientSession, "getGameState">) {}
  get menu(): BaseMenu { return this.record.menu; }

  private readonly againEvent: MenuCallback = async (_item, event) => {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    await popMenu(this.state); this.state.assertActive();
    this.state.services.consoleCommands.append("map_restart 0\n");
  };
  private readonly nextEvent: MenuCallback = async (_item, event) => {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    await popMenu(this.state); this.state.assertActive();
    const r = this.record;
    let level = r.won === 0 ? 0 : (r.level + 1) | 0;
    const levelSet = Math.trunc(level / 4);
    let currentLevel = this.gameInfo.getCurrentGame();
    if (currentLevel === -1) currentLevel = r.level;
    const currentSet = Math.trunc(currentLevel / 4);
    if (levelSet > currentSet || levelSet === this.gameInfo.getNumSPTiers()) level = currentLevel;
    const arena = this.gameInfo.getArenaInfoByNumber(level);
    if (arena === null) return;
    startSinglePlayerArena(this.state, this.gameInfo, arena);
  };
  private readonly menuEvent: MenuCallback = async (_item, event) => {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    await popMenu(this.state); this.state.assertActive();
    this.state.services.consoleCommands.append("disconnect; levelselect\n");
  };
  private async key(key: number): Promise<MenuSound> {
    this.state.assertActive();
    const r = this.record, time = this.state.realtime;
    if (time < r.ignoreKeysTime) return NO_SOUND;
    if (r.phase === 1) {
      this.state.services.consoleCommands.append("abort_podium\n");
      r.phase = 2; r.starttime = time; r.ignoreKeysTime = (time + 250) | 0;
      return NO_SOUND;
    }
    if (r.phase === 2) {
      r.phase = 3; r.starttime = time; r.ignoreKeysTime = (time + 250) | 0;
      return NO_SOUND;
    }
    if (key === KeyCode.Escape || key === KeyCode.Mouse2) return NO_SOUND;
    return await defaultKey(this.state, r.menu, key);
  }
  private configString(index: number): string {
    // Each caller supplies fresh stack storage. CL_GetConfigString does not write an invalid index.
    if (index < 0 || index >= 1024) throw new RangeError("SP postgame reached uninitialized configstring storage");
    const strings = this.client.getGameState(); this.state.assertActive();
    return sourceCommandText(itemAt(strings, index).slice(0, 1023));
  }
  private cvarNumber(name: string): number {
    this.state.assertActive();
    const cvar = this.state.services.cvars.registry.get(name);
    return cvar === undefined ? 0 : cvar.numericValue;
  }
  private announce(sound: PcmSound | null): void {
    this.state.assertActive();
    const resolved = this.state.services.sounds.resolveForPlayback(sound);
    if (resolved !== null) this.state.services.audio.startLocalSound(resolved, 7);
  }
  private async drawMedals(max: number): Promise<void> {
    const r = this.record;
    for (let n = 0; n < max; n++) {
      const x = itemAt(MEDAL_LOCATIONS, n), medal = itemAt(r.awardsEarned, n), amount = itemAt(r.awardsLevels, n);
      await drawNamed(this.state, x, 64, 48, 48, itemAt(MEDAL_PICTURES, medal)); this.state.assertActive();
      if (medal !== 0 && amount === 1) continue;
      drawString(this.state, x + 24, 116, medal === 0 ? `${amount}%` : String(amount), UI_CENTER, COLORS.highlight);
    }
  }
  private async drawPresentation(timer: number): Promise<void> {
    const r = this.record, awardNum = Math.trunc(timer / AWARD_TIME), atimer = timer % AWARD_TIME;
    drawProportional(this.state, 320, 64, itemAt(MEDAL_NAMES, itemAt(r.awardsEarned, awardNum)), UI_CENTER,
      { x: 1, y: 1, z: 1, w: Math.fround(Math.fround(AWARD_TIME - atimer) / AWARD_TIME) });
    await this.drawMedals(awardNum + 1); this.state.assertActive();
    if (!itemAt(r.playedSound, awardNum)) {
      r.playedSound[awardNum] = true;
      const sound = await this.state.services.sounds.registerSound(itemAt(MEDAL_SOUNDS, itemAt(r.awardsEarned, awardNum)), false);
      this.state.assertActive(); this.announce(sound);
    }
  }
  private drawScoreLine(n: number, y: number): void {
    const r = this.record;
    if (n > r.numClients + 1) n -= r.numClients + 2;
    if (n >= r.numClients) return;
    let rank = itemAt(r.ranks, n);
    if ((rank & RANK_TIED) !== 0) {
      drawString(this.state, 392, y, "(tie)", UI_LEFT | UI_SMALLFONT, COLORS.white);
      rank &= ~RANK_TIED;
    }
    const name = cleanName(this.configString((544 + itemAt(r.clientNums, n)) | 0));
    drawString(this.state, 440, y, `#${(rank + 1) | 0}: ${name.padEnd(16)} ${String(itemAt(r.scores, n)).padStart(2)}`,
      UI_LEFT | UI_SMALLFONT, COLORS.white);
  }
  private async draw(): Promise<void> {
    this.state.assertActive();
    const r = this.record, state = this.state;
    if (gameAtoi(infoValueForKey(this.configString(1), "sv_serverid")) !== r.serverId) {
      await popMenu(state); state.assertActive(); return;
    }
    if (r.numClients > 2) drawProportional(state, 510, 389, itemAt(r.placeNames, 2), UI_CENTER, COLORS.white);
    drawProportional(state, 130, 389, itemAt(r.placeNames, 1), UI_CENTER, COLORS.white);
    drawProportional(state, 320, 362, itemAt(r.placeNames, 0), UI_CENTER, COLORS.white);
    if (r.phase === 1) {
      const timer = (state.realtime - r.starttime) | 0;
      if (timer >= 1000 && r.winnerSound !== null) { this.announce(r.winnerSound); r.winnerSound = null; }
      if (timer < 5000) return;
      r.phase = 2; r.starttime = state.realtime;
    }
    if (r.phase === 2) {
      const timer = (state.realtime - r.starttime) | 0;
      if (timer >= r.numAwards * AWARD_TIME) {
        if (timer < 5000) return;
        r.phase = 3; r.starttime = state.realtime;
      } else { await this.drawPresentation(timer); state.assertActive(); }
    }
    if (r.phase === 3) {
      const cvars = state.services.cvars.registry;
      if (state.demoVersion) {
        if (r.won === 1 && this.gameInfo.showTierVideo(8)) {
          cvars.set("nextmap", "", true);
          state.services.consoleCommands.append("disconnect; cinematic demoEnd.RoQ\n"); return;
        }
      } else if (r.won > -1 && this.gameInfo.showTierVideo((r.won + 1) | 0)) {
        if (r.won === r.lastTier) {
          cvars.set("nextmap", "", true);
          state.services.consoleCommands.append("disconnect; cinematic end.RoQ\n"); return;
        }
        cvars.set("ui_spSelection", String(nativeInt(Math.fround(Math.imul(r.won, 4)))), true);
        cvars.set("nextmap", "levelselect", true);
        state.services.consoleCommands.append(`disconnect; cinematic tier${(r.won + 1) | 0}.RoQ\n`); return;
      }
      r.again.common.flags &= ~MenuFlag.Inactive; r.next.common.flags &= ~MenuFlag.Inactive; r.returnMenu.common.flags &= ~MenuFlag.Inactive;
      await this.drawMedals(r.numAwards); state.assertActive();
      await drawMenu(state, r.menu); state.assertActive();
    }
    if (this.cvarNumber("ui_spScoreboard") === 0) return;
    const timer = (state.realtime - r.scoreboardtime) | 0;
    const n = r.numClients <= 3 ? 0 : Math.trunc(timer / 1500) % (r.numClients + 2);
    this.drawScoreLine(n, 0); this.drawScoreLine(n + 1, 16); this.drawScoreLine(n + 2, 32);
  }
  async cache(): Promise<void> {
    this.state.assertActive();
    const buildscript = qvmFloatToInt(this.cvarNumber("com_buildscript"));
    for (const name of [MENU, MENU_FOCUS, REPLAY, REPLAY_FOCUS, NEXT, NEXT_FOCUS]) {
      await this.state.services.resources.registerShaderNoMip(name); this.state.assertActive();
    }
    for (let n = 0; n < 6; n++) {
      await this.state.services.resources.registerShaderNoMip(itemAt(MEDAL_PICTURES, n)); this.state.assertActive();
      await this.state.services.sounds.registerSound(itemAt(MEDAL_SOUNDS, n), false); this.state.assertActive();
    }
    if (buildscript !== 0) for (const name of ["music/loss.wav", "music/win.wav", "sound/player/announce/youwin.wav"]) {
      await this.state.services.sounds.registerSound(name, false); this.state.assertActive();
    }
  }
  private async init(): Promise<void> {
    const r = this.record;
    r.menu.wrapAround = true; r.menu.key = key => this.key(key); r.menu.draw = () => this.draw();
    r.ignoreKeysTime = (this.state.realtime + 1500) | 0;
    await this.cache(); this.state.assertActive();
    for (const [item, id, x, align, name, focus, callback] of [
      [r.returnMenu, Id.Menu, 0, MenuFlag.LeftJustify, MENU, MENU_FOCUS, this.menuEvent],
      [r.again, Id.Again, 320, MenuFlag.CenterJustify, REPLAY, REPLAY_FOCUS, this.againEvent],
      [r.next, Id.Next, 640, MenuFlag.RightJustify, NEXT, NEXT_FOCUS, this.nextEvent],
    ] satisfies [MenuBitmap, Id, number, MenuFlag, string, string, MenuCallback][]) {
      item.common.name = name; item.common.flags = align | MenuFlag.PulseIfFocus | MenuFlag.Inactive;
      item.common.x = x; item.common.y = 416; item.common.callback = callback; item.common.id = id;
      item.width = 128; item.height = 64; item.focuspic = focus;
    }
    addItem(this.state, r.menu, r.returnMenu); addItem(this.state, r.menu, r.again); addItem(this.state, r.menu, r.next);
  }
  private prepName(index: number): void {
    let name = cleanName(this.configString((544 + itemAt(this.record.clientNums, index)) | 0));
    while (name.length > 0 && stringWidth(name) > 256) name = name.slice(0, -1);
    this.record.placeNames[index] = name;
  }
  private addAward(medal: number, amount: number): void {
    const r = this.record;
    itemAt(r.awardsEarned, r.numAwards); itemAt(r.awardsLevels, r.numAwards);
    r.awardsEarned[r.numAwards] = medal; r.awardsLevels[r.numAwards] = amount; r.numAwards++;
  }
  async showFromCommand(context: CommandContext): Promise<void> {
    this.state.assertActive(); context.assertActive();
    const r = this.record; r.reset();
    r.serverId = gameAtoi(infoValueForKey(this.configString(1), "sv_serverid"));
    const map = infoValueForKey(this.configString(0), "mapname").slice(0, 63);
    const arena = this.gameInfo.getArenaInfoByMap(map);
    if (arena === null) return;
    this.arenaInfo = arena.slice(0, 1023);
    r.level = gameAtoi(infoValueForKey(this.arenaInfo, "num"));
    const argv = (index: number): number => {
      this.state.assertActive(); context.assertActive();
      const value = context.argv[index];
      return gameAtoi(value === undefined ? "" : sourceCommandText(value).slice(0, 1023));
    };
    r.numClients = argv(1);
    const playerClientNum = argv(2);
    let playerGameRank = 8;
    if (r.numClients > 8) r.numClients = 8;
    for (let n = 0; n < r.numClients; n++) {
      r.clientNums[n] = argv(9 + n * 3); r.ranks[n] = argv(10 + n * 3); r.scores[n] = argv(11 + n * 3);
      if (itemAt(r.clientNums, n) === playerClientNum) playerGameRank = ((itemAt(r.ranks, n) & ~RANK_TIED) + 1) | 0;
    }
    this.gameInfo.setBestScore(r.level, playerGameRank);
    const values = [argv(3), argv(4), argv(5), argv(6), argv(7), argv(8)];
    r.numAwards = 0;
    const accuracy = itemAt(values, 0);
    if (accuracy >= 50) { this.gameInfo.logAwardData(0, 1); this.addAward(0, accuracy); }
    for (let medal = 1; medal <= 3; medal++) {
      const amount = itemAt(values, medal);
      if (amount !== 0) { this.gameInfo.logAwardData(medal, amount); this.addAward(medal, amount); }
    }
    const oldFrags = Math.trunc(this.gameInfo.getAwardLevel(4) / 100);
    this.gameInfo.logAwardData(4, itemAt(values, 4));
    const newFrags = Math.trunc(this.gameInfo.getAwardLevel(4) / 100);
    if (newFrags > oldFrags) this.addAward(4, Math.imul(newFrags, 100));
    if (itemAt(values, 5) !== 0) { this.gameInfo.logAwardData(5, 1); this.addAward(5, 1); }
    r.won = playerGameRank === 1 ? this.gameInfo.tierCompleted(r.level) : -1;
    r.starttime = this.state.realtime; r.scoreboardtime = this.state.realtime;
    this.state.services.keys.setCatcher(KeyCatcher.Ui); this.state.menuDepth = 0;
    await this.init(); this.state.assertActive(); context.assertActive();
    await pushMenu(this.state, r.menu); this.state.assertActive(); context.assertActive();
    await setCursorToItem(this.state, r.menu, playerGameRank === 1 ? r.next : r.again);
    this.state.assertActive(); context.assertActive();
    this.prepName(0); this.prepName(1); this.prepName(2);
    const winner = playerGameRank === 1 ? "sound/player/announce/youwin.wav" : `sound/player/announce/${itemAt(r.placeNames, 0)}_wins.wav`;
    const sound = await this.state.services.sounds.registerSound(winner, false); this.state.assertActive(); context.assertActive();
    r.winnerSound = sound;
    this.state.services.consoleCommands.append(playerGameRank === 1 ? "music music/win\n" : "music music/loss\n");
    r.phase = 1;
    r.lastTier = this.gameInfo.getNumSPTiers();
    if (this.gameInfo.getSpecialArenaInfo("final") !== null) r.lastTier++;
  }
}
