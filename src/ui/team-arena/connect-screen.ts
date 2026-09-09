// Connection/download drawing from id Software's code/ui/ui_main.c and client/cl_ui.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { infoValueForKey } from "../../core/info-string.ts";
import type { Vec4 } from "../../core/math.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { sourceCommandText } from "../../core/text.ts";
import type { ClientConnectionPhase, ClientConnectionState, ClientStaticState } from "../../engine/client-state.ts";
import type { EngineClientSession } from "../../engine/client-session.ts";
import { textPaint, textWidth } from "../../render/font.ts";
import type { Draw2D } from "../../render/draw2d.ts";
import type { UiRuntime, UiRuntimeFrame } from "../runtime.ts";
import type { TeamArenaUiCvars } from "./cvars.ts";
import type { TeamArenaUiResources } from "./resources.ts";

const WHITE = { x: 1, y: 1, z: 1, w: 1 };
const PHASE_ORDER: Record<ClientConnectionPhase, number> = {
  uninitialized: 0, disconnected: 1, connecting: 3, challenging: 4, connected: 5,
  loading: 6, primed: 7, active: 8, cinematic: 9,
};

function divide(value: number, divisor: number): number {
  if (divisor === 0 || value === -2147483648 && divisor === -1) {
    throw new RangeError("Undefined source Team Arena connection-screen integer division");
  }
  return Math.trunc(value / divisor) | 0;
}

export function readableDownloadSize(value: number): string {
  if (value > 1073741824) return `${divide(value, 1073741824)}.${String(divide(Math.imul(value % 1073741824, 100), 1073741824)).padStart(2, "0")} GB`;
  if (value > 1048576) return `${divide(value, 1048576)}.${String(divide(Math.imul(value % 1048576, 100), 1048576)).padStart(2, "0")} MB`;
  if (value > 1024) return `${divide(value, 1024)} KB`;
  return `${value} bytes`;
}

export function connectionDownloadTime(milliseconds: number): string {
  const seconds = divide(milliseconds, 1000);
  if (seconds > 3600) return `${divide(seconds, 3600)} hr ${divide(seconds % 3600, 60)} min`;
  if (seconds > 60) return `${divide(seconds, 60)} min ${seconds % 60} sec`;
  return `${seconds} sec`;
}

function buffer(value: string): string { return sourceCommandText(value).slice(0, 1023); }

export interface TeamArenaConnectServices {
  readonly resources: TeamArenaUiResources;
  readonly runtime: UiRuntime;
  readonly cvars: TeamArenaUiCvars;
  assertActive(): void;
}

/** One UI VM's retained connection-screen state; the engine owns submit/present. */
export class TeamArenaConnectScreen {
  private lastConnState = 0;
  private readonly lastLoadingText = new Uint8Array(1024);

  constructor(private readonly services: TeamArenaConnectServices) {}

  async draw(overlay: boolean, frame: UiRuntimeFrame, clientStatic: ClientStaticState,
    connection: ClientConnectionState, client: EngineClientSession | null): Promise<void> {
    this.services.assertActive();
    if (overlay) return;
    await this.services.runtime.paintNamed("Connect", frame, true);
    this.services.assertActive();
    // GetClientState copies these values before GetConfigString and later live cvar reads.
    const phase = clientStatic.phase, servername = buffer(clientStatic.servername);
    const updateInfo = buffer(clientStatic.updateInfoString), message = buffer(connection.serverMessage);
    const packets = connection.connectPacketCount, draw = frame.draw;
    if (client !== null) {
      if (client.lifecycle.clientStatic !== clientStatic || client.lifecycle.clientConnection !== connection) {
        throw new Error("Team Arena connection screen requires the current session's actual client states");
      }
      const serverInfo = client.getConfigString(0);
      this.services.assertActive();
      if (serverInfo !== null) this.textPaintCenter(draw, 320, 130, 0.5, WHITE, `Loading ${infoValueForKey(buffer(serverInfo), "mapname")}`, 0);
    }
    const local = servername.replace(/[A-Z]/g, character => character.toLowerCase()) === "localhost";
    if (local) this.textPaintCenter(draw, 320, 178, 0.5, WHITE, "Starting up...", 0);
    else {
      const text = `Connecting to ${servername}`;
      if (text.length >= 256) throw new RangeError("UI_DrawConnectScreen strcpy exceeds its 256-byte source text buffer");
      this.textPaintCenter(draw, 320, 178, 0.5, WHITE, text, 0);
    }
    this.textPaintCenter(draw, 320, 600, 0.5, WHITE, infoValueForKey(updateInfo, "motd"), 0);
    if (PHASE_ORDER[phase] < PHASE_ORDER.connected) this.textPaintCenterAutoWrapped(draw, 320, 306, 630, 20, 0.5, WHITE, message, 0);
    if (this.lastConnState > PHASE_ORDER[phase]) this.lastLoadingText[0] = 0;
    this.lastConnState = PHASE_ORDER[phase];

    let text: string;
    switch (phase) {
      case "connecting": text = `Awaiting connection...${packets}`; break;
      case "challenging": text = `Awaiting challenge...${packets}`; break;
      case "connected": {
        const name = buffer(this.services.cvars.registry.get("cl_downloadName")?.value ?? "");
        if (name.length !== 0) { this.displayDownloadInfo(draw, frame.time, name, 320, 130, .5); return; }
        text = "Awaiting gamestate..."; break;
      }
      case "uninitialized": case "disconnected": case "loading": case "primed": case "active": case "cinematic": return;
    }
    if (!local) this.textPaintCenter(draw, 320, 210, 0.5, WHITE, text, 0);
  }

  textPaintCenter(draw: Draw2D, x: number, y: number, scale: number, color: Vec4, text: string | null, _adjust: number): void {
    this.services.assertActive();
    if (text === null) return;
    const fonts = this.services.resources.fonts;
    const width = textWidth(fonts, text, Math.fround(scale));
    textPaint(draw, fonts, { x: Math.fround(Math.fround(x) - Math.fround(divide(width, 2))), y: Math.fround(y), scale: Math.fround(scale),
      color, text, adjust: 0, limit: 0, style: 6 });
  }

  textPaintCenterAutoWrapped(draw: Draw2D, x: number, initialY: number, maximumWidth: number, lineStep: number,
    scale: number, color: Vec4, input: string | null, adjust: number): void {
    this.services.assertActive();
    if (input === null || input.length === 0 || input.startsWith("\0")) return;
    const text = buffer(input);
    let start = 0, lastSpace = 0, scan = 0, y = Math.fround(initialY);
    for (;;) {
      do { scan++; } while (scan < text.length && text[scan] !== " ");
      if (scan >= 1024) throw new RangeError("Text_PaintCenter_AutoWrapped reads beyond its 1024-byte source buffer");
      const ended = scan >= text.length;
      if (Math.fround(textWidth(this.services.resources.fonts, text.slice(start, scan), Math.fround(scale))) > Math.fround(maximumWidth)) {
        if (start === lastSpace) lastSpace = scan;
        this.textPaintCenter(draw, x, y, scale, color, text.slice(start, lastSpace), adjust); y = Math.fround(y + Math.fround(lineStep));
        if (ended) {
          lastSpace++;
          if (lastSpace >= 1024) throw new RangeError("Text_PaintCenter_AutoWrapped reads beyond its 1024-byte source buffer");
          if (lastSpace > text.length) throw new RangeError("Text_PaintCenter_AutoWrapped reads uninitialized source buffer after final overflowing word");
          if (lastSpace < text.length) this.textPaintCenter(draw, x, y, scale, color, text.slice(lastSpace), adjust);
          break;
        }
        lastSpace++; start = lastSpace; scan = lastSpace;
      } else {
        lastSpace = scan;
        if (ended) { this.textPaintCenter(draw, x, y, scale, color, text.slice(start), adjust); break; }
      }
    }
  }

  displayDownloadInfo(draw: Draw2D, realTime: number, name: string, centerPoint: number, yStart: number, scale: number): void {
    this.services.assertActive();
    centerPoint = Math.fround(centerPoint); yStart = Math.fround(yStart); scale = Math.fround(scale);
    const registry = this.services.cvars.registry;
    const size = qvmFloatToInt(registry.get("cl_downloadSize")?.numericValue ?? 0);
    const count = qvmFloatToInt(registry.get("cl_downloadCount")?.numericValue ?? 0);
    const start = qvmFloatToInt(registry.get("cl_downloadTime")?.numericValue ?? 0);
    draw.setColor(WHITE);
    this.textPaintCenter(draw, centerPoint, Math.fround(yStart + 112), scale, WHITE, "Downloading:", 0);
    this.textPaintCenter(draw, centerPoint, Math.fround(yStart + 192), scale, WHITE, "Estimated time left:", 0);
    this.textPaintCenter(draw, centerPoint, Math.fround(yStart + 248), scale, WHITE, "Transfer rate:", 0);
    this.textPaintCenter(draw, centerPoint, Math.fround(yStart + 136), scale, WHITE, size > 0 ? `${name} (${divide(Math.imul(count, 100), size)}%)` : name, 0);
    const downloaded = readableDownloadSize(count), total = readableDownloadSize(size);
    if (count < 4096 || start === 0) {
      this.textPaintCenter(draw, 320, Math.fround(yStart + 216), scale, WHITE, "estimating", 0);
      this.textPaintCenter(draw, 320, Math.fround(yStart + 160), scale, WHITE, `(${downloaded} of ${total} copied)`, 0); return;
    }
    const elapsed = divide((realTime - start) | 0, 1000), rate = elapsed === 0 ? 0 : divide(count, elapsed);
    const rateText = readableDownloadSize(rate);
    if (size !== 0 && rate !== 0) {
      const seconds = divide(size, rate);
      const remaining = Math.imul((seconds - divide(Math.imul(divide(count, 1024), seconds), divide(size, 1024))) | 0, 1000);
      this.textPaintCenter(draw, 320, Math.fround(yStart + 216), scale, WHITE, connectionDownloadTime(remaining), 0);
      this.textPaintCenter(draw, 320, Math.fround(yStart + 160), scale, WHITE, `(${downloaded} of ${total} copied)`, 0);
    } else {
      this.textPaintCenter(draw, 320, Math.fround(yStart + 216), scale, WHITE, "estimating", 0);
      this.textPaintCenter(draw, 320, Math.fround(yStart + 160), scale, WHITE, size !== 0 ? `(${downloaded} of ${total} copied)` : `(${downloaded} copied)`, 0);
    }
    if (rate !== 0) this.textPaintCenter(draw, 320, Math.fround(yStart + 272), scale, WHITE, `${rateText}/Sec`, 0);
  }
}
