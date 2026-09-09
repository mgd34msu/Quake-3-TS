// Ported from id Software's code/cgame/cg_draw.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CvarSnapshot } from "../core/cvar.ts";
import { textHeight, textPaint, textWidth } from "../render/font.ts";
import type { FontSet } from "../render/font.ts";
import type { CommandSource } from "./prediction.ts";
import type { ClientGameState, ClientGameStaticState } from "./state.ts";
import { drawStrlen, fadeColor } from "./draw-tools.ts";
import type { ClientDrawTools } from "./draw-tools.ts";

const LAG_SAMPLES = 128;
const MAX_LAGOMETER_PING = 900;
const MAX_LAGOMETER_RANGE = 300;
const YELLOW = { x: 1, y: 1, z: 0, w: 1 };
const BLUE = { x: 0, y: 0, z: 1, w: 1 };
const GREEN = { x: 0, y: 1, z: 0, w: 1 };
const RED = { x: 1, y: 0, z: 0, w: 1 };
const ZERO_UV = { s: 0, t: 0, s2: 0, t2: 0 };
const f = Math.fround;

export type ClientDrawStatusVariant =
  | { readonly kind: "baseq3" }
  | { readonly kind: "missionpack"; readonly fonts: FontSet };

export type ClientDrawStatusCvar = "cg_centertime" | "cg_lagometer" | "cg_nopredict" | "g_synchronousClients";

export interface ClientDrawStatusHost {
  readonly commands: CommandSource;
  readVmCvar(name: ClientDrawStatusCvar): CvarSnapshot;
}

export interface LagometerSnapshotSample {
  readonly ping: number;
  readonly flags: number;
}

function sourceText(input: string): string {
  const nul = input.indexOf("\0"), text = nul < 0 ? input : input.slice(0, nul);
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 255) throw new RangeError("Center print requires source byte characters");
  }
  return text.slice(0, 1023);
}

function sampleAt(samples: Int32Array, index: number): number {
  const value = samples[index];
  if (value === undefined) throw new RangeError(`Lagometer sample index ${index} outside ${samples.length}`);
  return value;
}

/** Per-cgame-instance status text and lagometer state from cg_draw.c. */
export class ClientDrawStatus {
  private readonly frameSamples = new Int32Array(LAG_SAMPLES);
  private readonly snapshotFlags = new Int32Array(LAG_SAMPLES);
  private readonly snapshotSamples = new Int32Array(LAG_SAMPLES);
  private frameCount = 0;
  private snapshotCount = 0;

  constructor(
    readonly state: ClientGameState,
    readonly staticState: ClientGameStaticState,
    readonly tools: ClientDrawTools,
    readonly variant: ClientDrawStatusVariant,
    private readonly host: ClientDrawStatusHost,
  ) {
    if (state.product !== staticState.product || tools.media.staticState !== staticState) {
      throw new Error("Draw status services must share canonical cgame state");
    }
    if (variant.kind !== state.product) throw new Error("Draw status product variant differs from cgame state");
    if (variant.kind === "missionpack" && variant.fonts.profile !== "cgame") {
      throw new Error("Missionpack center print requires cgame fonts");
    }
  }

  centerPrint(text: string, y: number, charWidth: number): void {
    const state = this.state;
    state.centerPrint = sourceText(text);
    state.centerPrintTime = state.time;
    state.centerPrintY = y | 0;
    state.centerPrintCharWidth = charWidth | 0;
    state.centerPrintLines = 1;
    for (let index = 0; index < state.centerPrint.length; index++) {
      if (state.centerPrint.charCodeAt(index) === 10) state.centerPrintLines++;
    }
  }

  drawCenterString(): void {
    const state = this.state;
    if (state.centerPrintTime === 0) return;
    const duration = f(1000 * f(this.host.readVmCvar("cg_centertime").numericValue));
    const color = fadeColor(state.time, state.centerPrintTime, duration);
    if (color === null) return;
    let y = (state.centerPrintY - Math.trunc(Math.imul(state.centerPrintLines, 16) / 2)) | 0;
    let start = 0;
    while (true) {
      let end = start;
      while (end < state.centerPrint.length && state.centerPrint.charCodeAt(end) !== 10) end++;
      const line = state.centerPrint.slice(start, Math.min(end, start + 50));
      if (this.variant.kind === "missionpack") {
        const width = textWidth(this.variant.fonts, line, 0.5, 0);
        const height = textHeight(this.variant.fonts, line, 0.5, 0);
        const x = Math.trunc((640 - width) / 2);
        textPaint(this.tools.draw, this.variant.fonts, { x, y: (y + height) | 0, scale: 0.5, color,
          text: line, adjust: 0, limit: 0, style: 6 });
        y = (y + height + 6) | 0;
      } else {
        const width = Math.imul(state.centerPrintCharWidth, drawStrlen(line));
        const x = Math.trunc((640 - width) / 2);
        const height = Math.trunc(f(f(state.centerPrintCharWidth) * f(1.5)));
        this.tools.drawStringExt({ x, y, text: line, color, forceColor: false, shadow: true,
          charWidth: state.centerPrintCharWidth, charHeight: height, maxChars: 0 });
        y = Math.trunc(f(f(y) + f(f(state.centerPrintCharWidth) * f(1.5))));
      }
      if (end === state.centerPrint.length) break;
      start = end + 1;
    }
    this.tools.draw.setColor(null);
  }

  addLagometerFrameInfo(): void {
    this.frameSamples[this.frameCount & (LAG_SAMPLES - 1)] = (this.state.time - this.state.latestSnapshotTime) | 0;
    this.frameCount = (this.frameCount + 1) | 0;
  }

  addLagometerSnapshotInfo(sample: LagometerSnapshotSample | null): void {
    const index = this.snapshotCount & (LAG_SAMPLES - 1);
    if (sample === null) this.snapshotSamples[index] = -1;
    else {
      this.snapshotSamples[index] = sample.ping | 0;
      this.snapshotFlags[index] = sample.flags | 0;
    }
    this.snapshotCount = (this.snapshotCount + 1) | 0;
  }

  async drawDisconnect(): Promise<void> {
    const snapshot = this.state.snap;
    if (snapshot === null) throw new Error("CG_DrawDisconnect requires a current snapshot");
    const commandNumber = (this.host.commands.currentNumber - 64 + 1) | 0;
    const command = this.host.commands.read(commandNumber);
    if (command === null) throw new Error("CG_DrawDisconnect command fell outside CMD_BACKUP");
    if (command.serverTime <= snapshot.playerState.commandTime || command.serverTime > this.state.time) return;
    const message = "Connection Interrupted";
    const width = Math.imul(drawStrlen(message), 16);
    this.tools.drawBigString(Math.trunc(320 - width / 2), 100, message, 1);
    if (((this.state.time >> 9) & 1) !== 0) return;
    const shader = await this.tools.media.resources.registerShader("gfx/2d/net.tga");
    this.tools.drawPic({ x: 640 - 48, y: 480 - 48, width: 48, height: 48 }, shader);
  }

  async drawLagometer(): Promise<void> {
    if (this.host.readVmCvar("cg_lagometer").integerValue === 0 || this.staticState.localServer !== 0) {
      await this.drawDisconnect();
      return;
    }
    const x = 640 - 48, y = this.state.product === "missionpack" ? 480 - 144 : 480 - 48;
    this.tools.draw.setColor(null);
    this.tools.drawPic({ x, y, width: 48, height: 48 }, this.tools.media.graphics.lagometerShader);
    const adjusted = this.tools.adjustFrom640({ x, y, width: 48, height: 48 });
    const picture = this.tools.media.resources.picture(this.tools.media.graphics.whiteShader);
    let color = -1;
    let range = f(adjusted.height / 3), mid = f(adjusted.y + range), scale = f(range / MAX_LAGOMETER_RANGE);
    for (let a = 0; a < adjusted.width; a++) {
      const index = (this.frameCount - 1 - a) & (LAG_SAMPLES - 1);
      let value = f(sampleAt(this.frameSamples, index));
      value = f(value * scale);
      if (value > 0) {
        if (color !== 1) { color = 1; this.tools.draw.setColor(YELLOW); }
        if (value > range) value = range;
        this.tools.draw.stretchPixels({ x: f(f(adjusted.x + adjusted.width) - f(a)), y: f(mid - value), width: 1, height: value }, ZERO_UV, picture);
      } else if (value < 0) {
        if (color !== 2) { color = 2; this.tools.draw.setColor(BLUE); }
        value = f(-value);
        if (value > range) value = range;
        this.tools.draw.stretchPixels({ x: f(f(adjusted.x + adjusted.width) - f(a)), y: mid, width: 1, height: value }, ZERO_UV, picture);
      }
    }
    range = f(adjusted.height / 2);
    scale = f(range / MAX_LAGOMETER_PING);
    for (let a = 0; a < adjusted.width; a++) {
      const index = (this.snapshotCount - 1 - a) & (LAG_SAMPLES - 1);
      let value = f(sampleAt(this.snapshotSamples, index));
      if (value > 0) {
        if ((sampleAt(this.snapshotFlags, index) & 1) !== 0) {
          if (color !== 5) { color = 5; this.tools.draw.setColor(YELLOW); }
        } else if (color !== 3) { color = 3; this.tools.draw.setColor(GREEN); }
        value = f(value * scale);
        if (value > range) value = range;
        this.tools.draw.stretchPixels({ x: f(f(adjusted.x + adjusted.width) - f(a)), y: f(f(adjusted.y + adjusted.height) - value), width: 1, height: value }, ZERO_UV, picture);
      } else if (value < 0) {
        if (color !== 4) { color = 4; this.tools.draw.setColor(RED); }
        this.tools.draw.stretchPixels({ x: f(f(adjusted.x + adjusted.width) - f(a)), y: f(f(adjusted.y + adjusted.height) - range), width: 1, height: range }, ZERO_UV, picture);
      }
    }
    this.tools.draw.setColor(null);
    if (this.host.readVmCvar("cg_nopredict").integerValue !== 0
      || this.host.readVmCvar("g_synchronousClients").integerValue !== 0) {
      this.tools.drawBigString(Math.trunc(adjusted.x), Math.trunc(adjusted.y), "snc", 1);
    }
    await this.drawDisconnect();
  }
}
