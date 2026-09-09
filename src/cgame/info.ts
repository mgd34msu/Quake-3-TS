// Ported from id Software's code/cgame/cg_info.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CvarRegistry } from "../core/cvar.ts";
import { infoValueForKey } from "../core/info-string.ts";
import { gameAtoi } from "../game/numeric.ts";
import type { Draw2D } from "../render/draw2d.ts";
import { UI_CENTER, UI_SMALLFONT, UI_DROPSHADOW } from "../render/font.ts";
import type { SceneShader } from "../render/ref-entity.ts";
import { GameType } from "../shared/definitions.ts";
import { itemAt } from "../shared/items.ts";
import { ClientDrawTools } from "./draw-tools.ts";
import type { ClientMedia } from "./media.ts";
import type { ClientGameState } from "./state.ts";

export interface ClientLoadingImports {
  /** The same cgame-owned configstring snapshot consumed by media registration. */
  configString(index: number): string;
  updateScreen(): Promise<void>;
}

function sourceText(input: string, size: number): string {
  const nul = input.indexOf("\0"), text = nul < 0 ? input : input.slice(0, nul);
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 255) throw new RangeError("Loading text requires source byte characters");
  return text.slice(0, size - 1);
}
function cleanText(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const byte = text.charCodeAt(i);
    if (byte === 94 && i + 1 < text.length && text[i + 1] !== "^") i++;
    else if (byte >= 32 && byte <= 126) result += text[i];
  }
  return result;
}

/** cg_info's icon arrays live for one cgame instance, not in the renderer cache. */
export class ClientLoadingScreen {
  private readonly playerIcons: SceneShader[] = [];
  private readonly itemIcons: (SceneShader | null)[] = [];
  constructor(readonly state: ClientGameState, readonly media: ClientMedia, private readonly cvars: CvarRegistry, private readonly imports: ClientLoadingImports) {
    if (state.product !== media.product) throw new Error("Loading screen product differs from cgame media");
  }

  async loadingString(text: string): Promise<void> {
    this.state.infoScreenText = sourceText(text, 1024);
    await this.imports.updateScreen();
  }

  async loadingItem(index: number): Promise<void> {
    const item = itemAt(this.media.product, index);
    if (item.pickupName === null) throw new RangeError("CG_LoadingItem requires a named item");
    if (item.icon !== null && this.itemIcons.length < 26) this.itemIcons.push(await this.media.resources.registerShaderNoMip(item.icon));
    await this.loadingString(item.pickupName);
  }

  async loadingClient(clientNum: number): Promise<void> {
    if (!Number.isInteger(clientNum) || clientNum < 0 || clientNum >= 64) throw new RangeError("CG_LoadingClient: bad client number");
    const info = this.imports.configString(544 + clientNum);
    if (this.playerIcons.length < 16) {
      const value = sourceText(infoValueForKey(info, "model"), 64), slash = value.lastIndexOf("/");
      const model = slash < 0 ? value : value.slice(0, slash), skin = slash < 0 ? "default" : value.slice(slash + 1);
      let icon = await this.media.resources.registerShaderNoMip(sourceText(`models/players/${model}/icon_${skin}.tga`, 64));
      if (icon === null) icon = await this.media.resources.registerShaderNoMip(sourceText(`models/players/characters/${model}/icon_${skin}.tga`, 64));
      if (icon === null) icon = await this.media.resources.registerShaderNoMip("models/players/sarge/icon_default.tga");
      if (icon !== null) this.playerIcons.push(icon);
    }
    const personality = cleanText(sourceText(infoValueForKey(info, "n"), 64));
    if (this.media.staticState.gameType === GameType.GT_SINGLE_PLAYER) await this.media.soundBank.registerSound(`sound/player/announce/${personality}.wav`, true);
    await this.loadingString(personality);
  }

  private drawLoadingIcons(tools: ClientDrawTools): void {
    for (const [n, icon] of this.playerIcons.entries()) tools.drawPic({ x: 16 + n * 78, y: 284, width: 64, height: 64 }, icon);
    for (const [n, icon] of this.itemIcons.entries()) tools.drawPic({ x: 16 + (n % 13) * 48, y: 360 + (n >= 13 ? 40 : 0), width: 32, height: 32 }, icon);
  }

  private gameTypeName(): string {
    switch (this.media.staticState.gameType) {
      case GameType.GT_FFA: return "Free For All";
      case GameType.GT_SINGLE_PLAYER: return "Single Player";
      case GameType.GT_TOURNAMENT: return "Tournament";
      case GameType.GT_TEAM: return "Team Deathmatch";
      case GameType.GT_CTF: return "Capture The Flag";
      case GameType.GT_1FCTF: return this.media.product === "missionpack" ? "One Flag CTF" : "Unknown Gametype";
      case GameType.GT_OBELISK: return this.media.product === "missionpack" ? "Overload" : "Unknown Gametype";
      case GameType.GT_HARVESTER: return this.media.product === "missionpack" ? "Harvester" : "Unknown Gametype";
      default: return "Unknown Gametype";
    }
  }

  async drawInformation(draw: Draw2D): Promise<void> {
    const info = this.imports.configString(0), system = this.imports.configString(1), resources = this.media.resources;
    const map = infoValueForKey(info, "mapname");
    let levelshot = await resources.registerShaderNoMip(`levelshots/${map}.tga`);
    if (levelshot === null) levelshot = await resources.registerShaderNoMip("menu/art/unknownmap");
    const tools = new ClientDrawTools(draw, this.media);
    draw.setColor(null); tools.drawPic({ x: 0, y: 0, width: 640, height: 480 }, levelshot);
    const detail = await resources.registerShader("levelShotDetail");
    draw.stretchPixels({ x: 0, y: 0, width: draw.width, height: draw.height }, { s: 0, t: 0, s2: 2.5, t2: 2 }, resources.picture(detail));
    this.drawLoadingIcons(tools);
    const text = (y: number, value: string): void => tools.drawProportionalString({ x: 320, y, text: value,
      style: UI_CENTER | UI_SMALLFONT | UI_DROPSHADOW, color: { x: 1, y: 1, z: 1, w: 1 }, time: this.state.time });
    text(96, this.state.infoScreenText.length > 0 ? `Loading... ${this.state.infoScreenText}` : "Awaiting snapshot...");
    let y = 148;
    // Cvar_VariableStringBuffer returns the empty string for an unregistered cvar.
    const server = this.cvars.get("sv_running");
    if (gameAtoi(server === undefined ? "" : sourceText(server.value, 1024)) === 0) {
      text(y, cleanText(sourceText(infoValueForKey(info, "sv_hostname"), 1024))); y += 27;
      if (infoValueForKey(system, "sv_pure").startsWith("1")) { text(y, "Pure Server"); y += 27; }
      const motd = sourceText(this.imports.configString(4), 16000);
      if (motd.length > 0) { text(y, motd); y += 27; }
      y += 10;
    }
    const message = sourceText(this.imports.configString(3), 16000);
    if (message.length > 0) { text(y, message); y += 27; }
    if (infoValueForKey(system, "sv_cheats").startsWith("1")) { text(y, "CHEATS ARE ENABLED"); y += 27; }
    text(y, this.gameTypeName()); y += 27;
    const timeLimit = gameAtoi(infoValueForKey(info, "timelimit"));
    if (timeLimit !== 0) { text(y, `timelimit ${timeLimit}`); y += 27; }
    if (this.media.staticState.gameType < GameType.GT_CTF) {
      const fragLimit = gameAtoi(infoValueForKey(info, "fraglimit"));
      if (fragLimit !== 0) text(y, `fraglimit ${fragLimit}`);
    }
    if (this.media.staticState.gameType >= GameType.GT_CTF) {
      const captureLimit = gameAtoi(infoValueForKey(info, "capturelimit"));
      if (captureLimit !== 0) text(y, `capturelimit ${captureLimit}`);
    }
  }
}
