// Connection/download drawing from id Software's q3_ui/ui_connect.c and cl_ui.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { infoValueForKey } from "../../core/info-string.ts";
import { KeyCode } from "../../core/key-codes.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { sourceCommandText } from "../../core/text.ts";
import type { EngineClientSession } from "../../engine/client-session.ts";
import type { ClientConnectionState, ClientStaticState } from "../../engine/client-state.ts";
import { UI_CENTER, UI_DROPSHADOW, UI_LEFT, UI_SMALLFONT } from "../../render/font.ts";
import { autoWrapped, cacheMenu, drawHandle, drawProportional, proportionalScale, stringWidth } from "./draw.ts";
import { COLORS, itemAt, nativeInt } from "./state.ts";
import type { BaseUiState } from "./state.ts";

const UI_BIGFONT = 0x20;

function divide(value: number, divisor: number): number {
  if (divisor === 0 || (value === -2147483648 && divisor === -1)) throw new RangeError("Undefined source connection-screen integer division");
  return Math.trunc(value / divisor) | 0;
}

/** UI_ReadableSize retains strict thresholds and the QVM's signed multiply wrap. */
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

/** Each draw borrows the current concrete engine owners; it does not create a connection. */
export class BaseConnectScreen {
  constructor(private readonly state: BaseUiState) {}

  async draw(overlay: boolean, clientStatic: ClientStaticState, connection: ClientConnectionState, client: EngineClientSession | null): Promise<void> {
    const state = this.state;
    state.assertActive();
    await cacheMenu(state);
    state.assertActive();
    if (!overlay) {
      state.draw.setColor(COLORS.white);
      drawHandle(state, 0, 0, 640, 480, state.media.background);
    }
    // cl_ui.c GetClientState copies these fields before reading the configstring.
    const phase = clientStatic.phase, servername = buffer(clientStatic.servername);
    const updateInfo = buffer(clientStatic.updateInfoString), message = buffer(connection.serverMessage);
    const packetCount = connection.connectPacketCount;
    if (client !== null) {
      if (client.lifecycle.clientStatic !== clientStatic || client.lifecycle.clientConnection !== connection) {
        throw new Error("Connection screen requires the current session's actual client states");
      }
      const serverInfo = client.getConfigString(0);
      if (serverInfo !== null) drawProportional(state, 320, 16, `Loading ${infoValueForKey(buffer(serverInfo), "mapname")}`,
        UI_BIGFONT | UI_CENTER | UI_DROPSHADOW, COLORS.white);
    }
    const style = UI_CENTER | UI_SMALLFONT | UI_DROPSHADOW;
    drawProportional(state, 320, 64, `Connecting to ${servername}`, style, COLORS.menuText);
    drawProportional(state, 320, 448, infoValueForKey(updateInfo, "motd"), style, COLORS.menuText);
    if (phase === "uninitialized" || phase === "disconnected" || phase === "connecting" || phase === "challenging") {
      autoWrapped(state, 320, 192, 630, 20, message, style, COLORS.menuText);
    }
    // Source lastLoadingText is only cleared and never read; the disabled password field is omitted.
    let text: string;
    switch (phase) {
      case "connecting": text = `Awaiting challenge...${packetCount}`; break;
      case "challenging": text = `Awaiting connection...${packetCount}`; break;
      case "connected": {
        const downloadName = buffer(state.services.cvars.registry.get("cl_downloadName")?.value ?? "");
        if (downloadName.length !== 0) { this.download(downloadName); return; }
        text = "Awaiting gamestate...";
        break;
      }
      case "uninitialized": case "disconnected": case "loading": case "primed": case "active": case "cinematic": return;
    }
    drawProportional(state, 320, 128, text, style, COLORS.white);
  }

  keyEvent(key: number): void {
    this.state.assertActive();
    if (key === KeyCode.Escape) this.state.services.consoleCommands.append("disconnect\n");
  }

  private download(name: string): void {
    const state = this.state, registry = state.services.cvars.registry;
    const size = qvmFloatToInt(registry.get("cl_downloadSize")?.numericValue ?? 0);
    const count = qvmFloatToInt(registry.get("cl_downloadCount")?.numericValue ?? 0);
    const start = qvmFloatToInt(registry.get("cl_downloadTime")?.numericValue ?? 0);
    const style = UI_LEFT | UI_SMALLFONT | UI_DROPSHADOW;
    const labels = ["Downloading:", "Estimated time left:", "Transfer rate:"];
    let left = 0;
    for (const label of labels) left = Math.max(left, nativeInt(Math.fround(stringWidth(label) * proportionalScale(style))));
    left = (left + 16) | 0;
    const draw = (x: number, y: number, text: string): void => { drawProportional(state, x, y, text, style, COLORS.white); };
    draw(8, 128, itemAt(labels, 0)); draw(8, 160, itemAt(labels, 1)); draw(8, 224, itemAt(labels, 2));
    draw(left, 128, size > 0 ? `${name} (${divide(Math.imul(count, 100), size)}%)` : name);
    const downloaded = readableDownloadSize(count), total = readableDownloadSize(size);
    if (count < 4096 || start === 0) {
      draw(left, 160, "estimating");
      draw(left, 192, `(${downloaded} of ${total} copied)`);
      return;
    }
    const elapsed = divide((state.realtime - start) | 0, 1000);
    const rate = elapsed === 0 ? 0 : divide(count, elapsed);
    const rateText = readableDownloadSize(rate);
    if (size !== 0 && rate !== 0) {
      let seconds = divide(size, rate);
      seconds = Math.imul((seconds - divide(Math.imul(divide(count, 1024), seconds), divide(size, 1024))) | 0, 1000);
      draw(left, 160, connectionDownloadTime(seconds));
      draw(left, 192, `(${downloaded} of ${total} copied)`);
    } else {
      draw(left, 160, "estimating");
      draw(left, 192, size !== 0 ? `(${downloaded} of ${total} copied)` : `(${downloaded} copied)`);
    }
    if (rate !== 0) draw(left, 224, `${rateText}/Sec`);
  }
}
