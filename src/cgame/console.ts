// Ported from id Software's code/cgame/cg_consolecmds.c and the
// CG_CrosshairPlayer/CG_LastAttacker helpers in cg_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { PcmSound } from "../assets/wav.ts";
import type { CvarRegistry, CvarSnapshot } from "../core/cvar.ts";
import { qvmFloatToInt } from "../core/numeric.ts";
import { gameFormat } from "../game/format.ts";
import { gameAtof, gameAtoi } from "../game/numeric.ts";
import { GameType, PersistentIndex } from "../shared/definitions.ts";
import type { Product } from "../shared/definitions.ts";
import type { UiCapturedMenu } from "../ui/runtime.ts";
import type { ClientInfoStore } from "./players.ts";
import type { ClientServerCommandRuntime } from "./server-commands.ts";
import type { ClientEntity, ClientGameState, ClientGameStaticState } from "./state.ts";
import type { ViewRuntime } from "./view.ts";
import type { ClientWeaponSelection } from "./weapons.ts";

export type ClientConsoleCvar = "cg_viewsize" | "cg_cameraOrbit" | "cg_currentSelectedPlayer";
export type ClientConsoleHud = { readonly kind: "unavailable"; readonly reason: string } | {
  readonly kind: "available";
  resetStrings(): void;
  resetMenus(): void;
  /** The HUD owner keeps asynchronous publication within its own cgame epoch. */
  loadMenus(path: string): Promise<void>;
  clearScoreboard(): void;
  menuScoreboard(): UiCapturedMenu | null;
  scrollFeeder(menu: UiCapturedMenu, feeder: number, down: boolean): Promise<void>;
};
export type ClientConsoleTeamOrders = { readonly kind: "unavailable"; readonly reason: string } | {
  readonly kind: "available";
  selectNextPlayer(): void;
  selectPreviousPlayer(): void;
  otherTeamHasFlag(): boolean;
  yourTeamHasFlag(): boolean;
};
export interface ClientConsoleHost {
  readonly cvars: Pick<CvarRegistry, "get" | "set">;
  readonly view: Pick<ViewRuntime, "state" | "testGun" | "testModel" | "nextModelFrame" | "previousModelFrame"
    | "nextModelSkin" | "previousModelSkin" | "zoomDown" | "zoomUp" | "clearTestModel">;
  readonly weapons: Pick<ClientWeaponSelection, "state" | "nextWeapon" | "previousWeapon" | "selectWeapon">;
  readonly clients: Pick<ClientInfoStore, "loadDeferredPlayers" | "reset">;
  readonly serverCommands: Pick<ClientServerCommandRuntime, "buildSpectatorString">;
  readonly hud: ClientConsoleHud;
  readonly teamOrders: ClientConsoleTeamOrders;
  readVmCvar(name: ClientConsoleCvar): CvarSnapshot;
  resetPlayerEntity(entity: ClientEntity): void;
  addCommand(name: string): void;
  sendClientCommand(text: string): void;
  sendConsoleCommand(text: string): void;
  print(text: string): void;
  centerPrint(text: string, y: number, charWidth: number): void;
  sound(name: "winnerSound" | "loserSound"): PcmSound | null;
  addBufferedSound(sound: PcmSound | null): void;
}

const COMMON_COMMANDS = ["testgun", "testmodel", "nextframe", "prevframe", "nextskin", "prevskin", "viewpos", "+scores", "-scores",
  "+zoom", "-zoom", "sizeup", "sizedown", "weapnext", "weapprev", "weapon", "tell_target", "tell_attacker", "vtell_target", "vtell_attacker", "tcmd"];
const MISSION_COMMANDS = ["loadhud", "nextTeamMember", "prevTeamMember", "nextOrder", "confirmOrder", "denyOrder", "taskOffense", "taskDefense",
  "taskPatrol", "taskCamp", "taskFollow", "taskRetrieve", "taskEscort", "taskSuicide", "taskOwnFlag", "tauntKillInsult", "tauntPraise", "tauntTaunt",
  "tauntDeathInsult", "tauntGauntlet", "spWin", "spLose", "scoresDown", "scoresUp"];
const FORWARDED_COMMANDS = ["kill", "say", "say_team", "tell", "vsay", "vsay_team", "vtell", "vtaunt", "vosay", "vosay_team", "votell",
  "give", "god", "notarget", "noclip", "team", "follow", "levelshot", "addbot", "setviewpos", "callvote", "vote", "callteamvote", "teamvote", "stats", "teamtask", "loaddefered"];
function localCommandNames(product: Product): readonly string[] {
  return [...COMMON_COMMANDS, ...(product === "missionpack" ? MISSION_COMMANDS : []), "startOrbit", "loaddeferred"];
}
/** CG_Init registers names before collision and the command dispatch owner exist. */
export function clientConsoleCommandNames(product: Product): readonly string[] {
  return [...localCommandNames(product), ...FORWARDED_COMMANDS];
}
function fold(value: string): string { return value.replace(/[A-Z]/g, letter => String.fromCharCode(letter.charCodeAt(0) + 32)); }
function sourceBytes(value: string): string {
  const nul = value.indexOf("\0"), text = nul < 0 ? value : value.slice(0, nul);
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 255) throw new RangeError("Console commands require source byte characters");
  return text;
}
function argument(argv: readonly string[], index: number, size = 1024): string {
  const value = argv[index]; return value === undefined ? "" : value.slice(0, size - 1);
}
function slot<T>(values: readonly T[], index: number): T {
  const value = values[index]; if (value === undefined) throw new RangeError(`Console source array index ${index} outside ${values.length}`); return value;
}

/** Engine tokenization precedes this awaited boundary; forwarded commands return false. */
export class ClientConsoleRuntime {
  private readonly commands: readonly string[];
  private pending: Promise<boolean> = Promise.resolve(false);
  private closed = false;
  constructor(readonly state: ClientGameState, readonly staticState: ClientGameStaticState, readonly host: ClientConsoleHost) {
    if (state.product !== staticState.product || host.view.state !== state || host.weapons.state !== state) throw new Error("Console services must share canonical cgame state");
    this.commands = localCommandNames(state.product);
  }
  initializeCommands(): void { this.open(); for (const name of clientConsoleCommandNames(this.state.product)) this.host.addCommand(name); }
  dispose(): void { this.closed = true; this.host.view.clearTestModel(); this.host.clients.reset(); }
  private open(): void { if (this.closed) throw new Error("Cgame console runtime is closed"); }
  execute(argv: readonly string[]): Promise<boolean> {
    if (argv.length > 1024) return Promise.reject(new RangeError("Console command exceeds MAX_STRING_TOKENS"));
    let owned: readonly string[];
    try {
      owned = argv.map(sourceBytes);
      if (owned.reduce((length, value) => length + value.length + 1, 0) > 8192 + 1024) throw new RangeError("Console command exceeds source token storage");
    } catch (error: unknown) { return Promise.reject(error); }
    const next = this.pending.then(async () => {
      this.open();
      const name = fold(argument(owned, 0));
      if (!this.commands.some(command => fold(command) === name)) return false;
      await this.dispatch(name, owned); this.open(); return true;
    }).catch((error: unknown) => { this.dispose(); throw error; });
    this.pending = next;
    return next;
  }
  crosshairPlayer(): number { return this.state.time > ((this.state.crosshairClientTime + 1000) | 0) ? -1 : this.state.crosshairClientNum; }
  lastAttacker(): number {
    if (this.state.attackerTime === 0) return -1;
    const snap = this.state.snap; if (snap === null) throw new Error("CG_LastAttacker requires cg.snap");
    return snap.playerState.persistant.get(PersistentIndex.PERS_ATTACKER);
  }
  private set(name: string, value: string): void { this.host.cvars.set(name, value, true); }
  private immediate(name: string): string { const value = this.host.cvars.get(name); return value === undefined ? "" : sourceBytes(value.value).slice(0, 1023); }
  private hud() { const hud = this.host.hud; if (hud.kind === "unavailable") throw new Error(`Cgame HUD unavailable: ${hud.reason}`); return hud; }
  private orders() { const orders = this.host.teamOrders; if (orders.kind === "unavailable") throw new Error(`Cgame team orders unavailable: ${orders.reason}`); return orders; }
  private scoresDown(): void {
    const state = this.state;
    if (state.product === "missionpack") this.host.serverCommands.buildSpectatorString();
    if (((state.scoresRequestTime + 2000) | 0) < state.time) {
      state.scoresRequestTime = state.time; this.host.sendClientCommand("score");
      if (!state.showScores) { state.showScores = true; state.numScores = 0; }
    } else state.showScores = true;
  }
  private nextOrder(): void {
    const snap = this.state.snap; if (snap === null) throw new Error("CG_NextOrder requires cg.snap");
    const client = slot(this.staticState.clientInfo, snap.playerState.clientNum);
    if (!client.teamLeader && slot(this.state.sortedTeamPlayers, this.host.readVmCvar("cg_currentSelectedPlayer").integerValue) !== snap.playerState.clientNum) return;
    const cgs = this.staticState;
    if (cgs.currentOrder < 7) {
      cgs.currentOrder = (cgs.currentOrder + 1) | 0;
      if (cgs.currentOrder === 5 && !this.orders().otherTeamHasFlag()) cgs.currentOrder++;
      if (cgs.currentOrder === 6 && !this.orders().yourTeamHasFlag()) cgs.currentOrder++;
    } else cgs.currentOrder = 1;
    cgs.orderPending = true; cgs.orderTime = (this.state.time + 3000) | 0;
  }
  private task(voice: string, task: number): void {
    this.host.sendConsoleCommand(`cmd vsay_team ${voice}\n`);
    this.host.sendClientCommand(gameFormat("teamtask %d\n", [task]));
  }
  private async dispatch(name: string, argv: readonly string[]): Promise<void> {
    const state = this.state, cgs = this.staticState, host = this.host;
    switch (name) {
      case "testgun": await host.view.testGun(argv.length < 2 ? null : argument(argv, 1), argv.length === 3 ? gameAtof(argument(argv, 2)) : null); return;
      case "testmodel": await host.view.testModel(argv.length < 2 ? null : argument(argv, 1), argv.length === 3 ? gameAtof(argument(argv, 2)) : null); return;
      case "nextframe": host.view.nextModelFrame(); return;
      case "prevframe": host.view.previousModelFrame(); return;
      case "nextskin": host.view.nextModelSkin(); return;
      case "prevskin": host.view.previousModelSkin(); return;
      case "+zoom": host.view.zoomDown(); return;
      case "-zoom": host.view.zoomUp(); return;
      case "weapnext": host.weapons.nextWeapon(); return;
      case "weapprev": host.weapons.previousWeapon(); return;
      case "weapon": host.weapons.selectWeapon(gameAtoi(argument(argv, 1))); return;
      case "viewpos": host.print(gameFormat("(%i %i %i) : %i\n", [qvmFloatToInt(state.refdef.viewOrigin.x), qvmFloatToInt(state.refdef.viewOrigin.y), qvmFloatToInt(state.refdef.viewOrigin.z), qvmFloatToInt(state.refdefViewAngles.y)], 1024)); return;
      case "sizeup": case "sizedown": this.set("cg_viewsize", gameFormat("%i", [(host.readVmCvar("cg_viewsize").integerValue + (name === "sizeup" ? 10 : -10)) | 0])); return;
      case "+scores": this.scoresDown(); return;
      case "-scores": if (state.showScores) { state.showScores = false; state.scoreFadeTime = state.time; } return;
      case "tcmd": { const target = this.crosshairPlayer(); if (target !== 0) host.sendConsoleCommand(gameFormat("gc %i %i", [target, gameAtoi(argument(argv, 1, 4))])); return; }
      case "tell_target": case "tell_attacker": case "vtell_target": case "vtell_attacker": {
        const target = name.endsWith("target") ? this.crosshairPlayer() : this.lastAttacker(); if (target === -1) return;
        const args = argv.slice(1).join(" "); if (args.length >= 1024) throw new RangeError("Cmd_Args exceeds MAX_STRING_CHARS");
        host.sendClientCommand(gameFormat("%s %i %s", [name.startsWith("v") ? "vtell" : "tell", target, args.slice(0, 127)], 128)); return;
      }
      case "loaddeferred": await host.clients.loadDeferredPlayers(entity => host.resetPlayerEntity(entity)); return;
      case "startorbit":
        if (gameAtoi(this.immediate("developer")) === 0) return;
        if (host.readVmCvar("cg_cameraOrbit").numericValue !== 0) { this.set("cg_cameraOrbit", "0"); this.set("cg_thirdPerson", "0"); }
        else { this.set("cg_cameraOrbit", "5"); this.set("cg_thirdPerson", "1"); this.set("cg_thirdPersonAngle", "0"); this.set("cg_thirdPersonRange", "100"); } return;
      case "loadhud": {
        const hud = this.hud(); hud.resetStrings(); hud.resetMenus();
        const path = this.immediate("cg_hudFiles"); await hud.loadMenus(path.length === 0 ? "ui/hud.txt" : path); this.open(); hud.clearScoreboard(); return;
      }
      case "scoresdown": case "scoresup": {
        const hud = this.hud(), menu = hud.menuScoreboard();
        if (menu !== null && state.scoreBoardShowing) for (const feeder of [11, 5, 6]) await hud.scrollFeeder(menu, feeder, name === "scoresdown"); return;
      }
      case "nextteammember": this.orders().selectNextPlayer(); return;
      case "prevteammember": this.orders().selectPreviousPlayer(); return;
      case "nextorder": this.nextOrder(); return;
      case "confirmorder": case "denyorder": {
        const yes = name === "confirmorder";
        host.sendConsoleCommand(gameFormat("cmd vtell %d %s\n", [cgs.acceptLeader, yes ? "yes" : "no"]));
        host.sendConsoleCommand(yes ? "+button5; wait; -button5" : "+button6; wait; -button6");
        if (state.time < cgs.acceptOrderTime) { if (yes) host.sendClientCommand(gameFormat("teamtask %d\n", [cgs.acceptTask])); cgs.acceptOrderTime = 0; } return;
      }
      case "taskoffense": this.task(cgs.gameType === GameType.GT_CTF || cgs.gameType === GameType.GT_1FCTF ? "ongetflag" : "onoffense", 1); return;
      case "taskdefense": this.task("ondefense", 2); return;
      case "taskpatrol": this.task("onpatrol", 3); return;
      case "taskcamp": this.task("oncamp", 7); return;
      case "taskfollow": this.task("onfollow", 4); return;
      case "taskretrieve": this.task("onreturnflag", 5); return;
      case "taskescort": this.task("onfollowcarrier", 6); return;
      case "taskownflag": host.sendConsoleCommand("cmd vsay_team ihaveflag\n"); return;
      case "tasksuicide": { const target = this.crosshairPlayer(); if (target !== -1) host.sendClientCommand(gameFormat("tell %i suicide", [target], 128)); return; }
      case "tauntkillinsult": host.sendConsoleCommand("cmd vsay kill_insult\n"); return;
      case "tauntpraise": host.sendConsoleCommand("cmd vsay praise\n"); return;
      case "taunttaunt": host.sendConsoleCommand("cmd vtaunt\n"); return;
      case "tauntdeathinsult": host.sendConsoleCommand("cmd vsay death_insult\n"); return;
      case "tauntgauntlet": host.sendConsoleCommand("cmd vsay kill_guantlet\n"); return;
      case "spwin": case "splose":
        this.set("cg_cameraOrbit", "2"); this.set("cg_cameraOrbitDelay", "35"); this.set("cg_thirdPerson", "1"); this.set("cg_thirdPersonAngle", "0"); this.set("cg_thirdPersonRange", "100");
        host.addBufferedSound(host.sound(name === "spwin" ? "winnerSound" : "loserSound")); host.centerPrint(name === "spwin" ? "YOU WIN!" : "YOU LOSE...", 144, 0); return;
      default: throw new Error(`Registered cgame console command has no handler: ${name}`);
    }
  }
}
