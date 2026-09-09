// Console storage, commands and drawing from id Software code/client/cl_console.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { WritableFileSystem } from "../assets/writable-files.ts";
import type { CommandBuffer, CommandContext } from "../core/commands.ts";
import type { ConsoleOutput } from "../core/console-output.ts";
import type { CvarRegistry, CvarSnapshot } from "../core/cvar.ts";
import { KeyCatcher } from "../core/key-codes.ts";
import type { Vec4 } from "../core/math.ts";
import { sourceCommandText } from "../core/text.ts";
import { MoveType } from "../shared/definitions.ts";
import type { ClientKeys } from "./client-keys.ts";
import type { ClientStaticState } from "./client-state.ts";
import { screenColor, screenColorEscape, screenDrawBigField, screenDrawBigString,
  screenDrawField, screenDrawPic, screenDrawSmallChar, screenFillRect } from "./screen-draw.ts";
import type { EngineScreenDrawing } from "./screen-draw.ts";

export interface ConsoleHost {
  assertCurrentOperation(): undefined;
  startDemoLoop(): Promise<void>;
  readCgame(): { crosshairPlayer(): number | Promise<number>; lastAttacker(): number | Promise<number> } | null;
  snapshotMoveType(): number;
  writableFiles(): Pick<WritableFileSystem, "openWrite">;
  readonly version: string;
}
export interface EngineConsoleOptions {
  readonly state: ClientStaticState;
  readonly keys: ClientKeys;
  readonly cvars: CvarRegistry;
  readonly commands: CommandBuffer;
  readonly output: ConsoleOutput;
  readonly host: ConsoleHost;
}
const TEXT_SIZE = 32768, WHITE_SPACE = (7 << 8) | 32;
function nativeInt(value: number): number {
  if (!Number.isFinite(value) || value < -2147483648 || value >= 2147483648) throw new RangeError("Undefined native console integer conversion");
  return Math.trunc(value) || 0;
}

/** Engine-lived con storage; keys, clocks, renderer resources and output remain borrowed. */
export class EngineConsole {
  private readonly text = new Uint16Array(TEXT_SIZE);
  private readonly times = new Int32Array(4);
  private initialized = false;
  private current = 0;
  private x = 0;
  private display = 0;
  private linewidth = 0;
  private totalLines = 0;
  private displayFrac = 0;
  private finalFrac = 0;
  private vislines = 0;
  private color: Vec4 = { x: 0, y: 0, z: 0, w: 0 };
  private editWidth = 78;

  constructor(private readonly options: EngineConsoleOptions) {}
  get fieldWidth(): number { return this.editWidth; }

  rendererInitialized(physicalWidth: number): void {
    this.options.host.assertCurrentOperation();
    if (!Number.isInteger(physicalWidth) || physicalWidth <= 0) throw new RangeError("Invalid renderer width");
    this.editWidth = nativeInt(physicalWidth / 8) - 2;
    this.options.keys.consoleField.widthInChars = this.editWidth;
  }

  initialize(): void {
    const { host, cvars, keys, commands } = this.options;
    host.assertCurrentOperation();
    cvars.register("con_notifytime", "3");
    cvars.register("scr_conspeed", "3");
    keys.initializeConsoleFields(this.editWidth);
    commands.registerAsync("toggleconsole", async () => { await this.toggle(); });
    commands.register("messagemode", () => { this.messageMode(false); });
    commands.register("messagemode2", () => { this.messageMode(true); });
    commands.registerAsync("messagemode3", () => this.targetMessageMode("crosshairPlayer"));
    commands.registerAsync("messagemode4", () => this.targetMessageMode("lastAttacker"));
    commands.register("clear", () => { this.clear(); });
    commands.register("condump", context => { this.dump(context); });
  }

  async toggle(): Promise<void> {
    const { host, state, keys } = this.options;
    host.assertCurrentOperation();
    if (state.phase === "disconnected" && keys.getCatcher() === KeyCatcher.Console) {
      await host.startDemoLoop(); host.assertCurrentOperation(); return;
    }
    keys.consoleField.clear(); keys.consoleField.widthInChars = this.editWidth;
    this.clearNotify(); keys.setCatcher(keys.getCatcher() ^ KeyCatcher.Console);
  }
  private messageMode(team: boolean): void {
    const { host, keys } = this.options; host.assertCurrentOperation();
    keys.setChatPlayer(-1); keys.setChatTeam(team); keys.chatField.clear();
    keys.chatField.widthInChars = team ? 25 : 30;
    keys.setCatcher(keys.getCatcher() ^ KeyCatcher.Message);
  }
  private async targetMessageMode(method: "crosshairPlayer" | "lastAttacker"): Promise<void> {
    const { host, keys } = this.options; host.assertCurrentOperation();
    const cgame = host.readCgame();
    if (cgame === null) throw new Error("Targeted message mode requires the actual cgame");
    const target = await cgame[method](); host.assertCurrentOperation(); keys.setChatPlayer(target);
    if (target < 0 || target >= 64) { keys.setChatPlayer(-1); return; }
    keys.setChatTeam(false); keys.chatField.clear(); keys.chatField.widthInChars = 30;
    keys.setCatcher(keys.getCatcher() ^ KeyCatcher.Message);
  }
  private clear(): void { this.options.host.assertCurrentOperation(); this.text.fill(WHITE_SPACE); this.display = this.current; }
  private dump(context: CommandContext): void {
    const { host, output } = this.options; host.assertCurrentOperation();
    if (context.argv.length !== 2) { output.print("usage: condump <filename>\n"); return; }
    const path = context.argv[1];
    if (path === undefined) throw new Error("Console dump command lost its filename");
    output.print(`Dumped console text to ${path}.\n`);
    const file = host.writableFiles().openWrite(path, false);
    if (file === null) { output.print("ERROR: couldn't open.\n"); return; }
    try {
      let line = this.current - this.totalLines + 1;
      for (; line <= this.current; line++) {
        let column = 0;
        for (; column < this.linewidth && (this.cell(line, column) & 255) === 32; column++);
        if (column !== this.linewidth) break;
      }
      for (; line <= this.current; line++) {
        let row = "";
        for (let column = 0; column < this.linewidth; column++) row += String.fromCharCode(this.cell(line, column) & 255);
        file.write(row.replace(/ +$/, "") + "\n");
      }
    } finally { file.close(); }
  }
  clearNotify(): undefined { this.options.host.assertCurrentOperation(); this.times.fill(0); }

  private checkResize(): void {
    const width = 78;
    if (width === this.linewidth) return;
    const oldWidth = this.linewidth, oldTotal = this.totalLines, old = this.text.slice();
    this.linewidth = width; this.totalLines = Math.trunc(TEXT_SIZE / width);
    this.text.fill(WHITE_SPACE);
    const lines = Math.min(oldTotal, this.totalLines), columns = Math.min(oldWidth, width);
    for (let i = 0; i < lines; i++) for (let j = 0; j < columns; j++) {
      const value = old[((this.current - i + oldTotal) % oldTotal) * oldWidth + j];
      if (value === undefined) throw new RangeError("Undefined native console resize read");
      this.text[(this.totalLines - 1 - i) * width + j] = value;
    }
    this.clearNotify(); this.current = this.totalLines - 1; this.display = this.current;
  }
  private cell(line: number, column: number): number {
    const value = this.text[(line % this.totalLines) * this.linewidth + column];
    if (value === undefined) throw new RangeError("Undefined native console text read");
    return value;
  }
  private linefeed(skipNotify: boolean): void {
    if (this.current >= 0) this.times[this.current % 4] = skipNotify ? 0 : this.options.state.realtime;
    this.x = 0;
    if (this.display === this.current) this.display = nativeInt(this.display + 1);
    this.current = nativeInt(this.current + 1);
    const start = (this.current % this.totalLines) * this.linewidth;
    this.text.fill(WHITE_SPACE, start, start + this.linewidth);
  }
  print(input: string): undefined {
    const { host, state, cvars } = this.options; host.assertCurrentOperation();
    let text = sourceCommandText(input);
    const skipNotify = text.startsWith("[skipnotify]"); if (skipNotify) text = text.slice(12);
    const noPrint = cvars.get("cl_noprint"); if (noPrint !== undefined && noPrint.integerValue !== 0) return;
    if (!this.initialized) { this.color = screenColor(7); this.linewidth = -1; this.checkResize(); this.initialized = true; }
    let color = 7;
    for (let i = 0; i < text.length; i++) {
      if (screenColorEscape(text, i)) { color = (text.charCodeAt(i + 1) - 48) & 7; i++; continue; }
      let length = 0;
      for (; length < this.linewidth; length++) {
        const code = text.charCodeAt(i + length);
        if (i + length >= text.length || code <= 32 || code >= 128) break;
      }
      if (length !== this.linewidth && this.x + length >= this.linewidth) this.linefeed(skipNotify);
      const byte = text.charCodeAt(i), character = byte >= 128 ? byte - 256 : byte;
      if (character === 10) this.linefeed(skipNotify);
      else if (character === 13) this.x = 0;
      else {
        this.text[(this.current % this.totalLines) * this.linewidth + this.x] = (color << 8) | character;
        this.x++;
        if (this.x >= this.linewidth) { this.linefeed(skipNotify); this.x = 0; }
      }
    }
    if (this.current >= 0) {
      if (skipNotify) this.times[(this.current % 4 + 3) % 4] = 0;
      else this.times[this.current % 4] = state.realtime;
    }
  }
  private cvar(name: string): CvarSnapshot {
    const value = this.options.cvars.get(name);
    if (value === undefined) throw new Error(`Console requires initialized cvar ${name}`);
    return value;
  }
  private drawInput(drawing: EngineScreenDrawing): void {
    const { keys, state } = this.options;
    if (state.phase !== "disconnected" && (keys.getCatcher() & KeyCatcher.Console) === 0) return;
    const y = this.vislines - 32;
    drawing.pixels.setColor(this.color); screenDrawSmallChar(drawing, 8, y, 93);
    screenDrawField(drawing, keys.consoleField, 16, y, true);
  }
  private drawNotify(drawing: EngineScreenDrawing): void {
    const { state, keys, host } = this.options; let color = 7, y = 0;
    drawing.pixels.setColor(screenColor(color));
    for (let line = this.current - 3; line <= this.current; line++) {
      if (line < 0) continue;
      const timestamp = this.times[line % 4];
      if (timestamp === undefined) throw new RangeError("Undefined native notify timestamp");
      if (timestamp === 0 || ((state.realtime - timestamp) | 0) > this.cvar("con_notifytime").numericValue * 1000) continue;
      if (host.snapshotMoveType() !== MoveType.PM_INTERMISSION && (keys.getCatcher() & (KeyCatcher.Ui | KeyCatcher.Cgame)) !== 0) continue;
      for (let x = 0; x < this.linewidth; x++) {
        const cell = this.cell(line, x); if ((cell & 255) === 32) continue;
        if (((cell >> 8) & 7) !== color) { color = (cell >> 8) & 7; drawing.pixels.setColor(screenColor(color)); }
        screenDrawSmallChar(drawing, this.cvar("cl_conXOffset").integerValue + (x + 1) * 8, y, cell & 255);
      }
      y += 16;
    }
    drawing.pixels.setColor(null);
    if ((keys.getCatcher() & (KeyCatcher.Ui | KeyCatcher.Cgame)) !== 0) return;
    if ((keys.getCatcher() & KeyCatcher.Message) !== 0) {
      const team = keys.chatTeam;
      screenDrawBigString(drawing, 8, y, team ? "say_team:" : "say:", 1);
      screenDrawBigField(drawing, keys.chatField, (team ? 11 : 5) * 16, y, true);
    }
  }
  private drawSolid(drawing: EngineScreenDrawing, fraction: number): void {
    const { width, height } = drawing.commands.target;
    let lines = nativeInt(height * fraction); if (lines <= 0) return; if (lines > height) lines = height;
    let y = nativeInt(fraction * 480 - 2);
    if (y < 1) y = 0; else screenDrawPic(drawing, { x: 0, y: 0, width: 640, height: y }, drawing.pictures.console);
    screenFillRect(drawing, { x: 0, y, width: 640, height: 2 }, screenColor(1));
    drawing.pixels.setColor(screenColor(1));
    const version = sourceCommandText(this.options.host.version);
    for (let x = 0; x < version.length; x++) screenDrawSmallChar(drawing, width - (version.length - x) * 8, lines - 24, version.charCodeAt(x));
    this.vislines = lines; let rows = nativeInt((lines - 8) / 8); y = lines - 48;
    if (this.display !== this.current) {
      drawing.pixels.setColor(screenColor(1));
      for (let x = 0; x < this.linewidth; x += 4) screenDrawSmallChar(drawing, (x + 1) * 8, y, 94);
      y -= 16; rows--;
    }
    let row = this.display; if (this.x === 0) row--;
    let color = 7; drawing.pixels.setColor(screenColor(color));
    for (let i = 0; i < rows; i++, y -= 16, row--) {
      if (row < 0) break; if (this.current - row >= this.totalLines) continue;
      for (let x = 0; x < this.linewidth; x++) {
        const cell = this.cell(row, x); if ((cell & 255) === 32) continue;
        if (((cell >> 8) & 7) !== color) { color = (cell >> 8) & 7; drawing.pixels.setColor(screenColor(color)); }
        screenDrawSmallChar(drawing, (x + 1) * 8, y, cell & 255);
      }
    }
    this.drawInput(drawing); drawing.pixels.setColor(null);
  }
  draw(drawing: EngineScreenDrawing): undefined {
    const { state, keys, host } = this.options; host.assertCurrentOperation();
    if (drawing.state !== state || drawing.keys !== keys) throw new Error("Console drawing must borrow its actual clock and keys");
    this.checkResize();
    if (state.phase === "disconnected" && (keys.getCatcher() & (KeyCatcher.Ui | KeyCatcher.Cgame)) === 0) { this.drawSolid(drawing, 1); return; }
    if (this.displayFrac !== 0) this.drawSolid(drawing, this.displayFrac);
    else if (state.phase === "active") this.drawNotify(drawing);
  }
  run(): undefined {
    const { host, keys, state } = this.options; host.assertCurrentOperation();
    this.finalFrac = (keys.getCatcher() & KeyCatcher.Console) !== 0 ? 0.5 : 0;
    if (this.finalFrac < this.displayFrac) {
      this.displayFrac = Math.fround(this.displayFrac - this.cvar("scr_conspeed").numericValue * state.realFrameTime * 0.001);
      if (this.finalFrac > this.displayFrac) this.displayFrac = this.finalFrac;
    } else if (this.finalFrac > this.displayFrac) {
      this.displayFrac = Math.fround(this.displayFrac + this.cvar("scr_conspeed").numericValue * state.realFrameTime * 0.001);
      if (this.finalFrac < this.displayFrac) this.displayFrac = this.finalFrac;
    }
  }
  scroll(action: "page-up" | "page-down" | "top" | "bottom"): undefined {
    this.options.host.assertCurrentOperation();
    switch (action) {
      case "page-up": this.display -= 2; if (this.current - this.display >= this.totalLines) this.display = this.current - this.totalLines + 1; break;
      case "page-down": this.display += 2; if (this.display > this.current) this.display = this.current; break;
      case "top": this.display = this.totalLines; if (this.current - this.display >= this.totalLines) this.display = this.current - this.totalLines + 1; break;
      case "bottom": this.display = this.current; break;
    }
  }
  close(): undefined {
    const { host, keys } = this.options; host.assertCurrentOperation();
    if (this.cvar("cl_running").integerValue === 0) return;
    keys.consoleField.clear(); this.clearNotify(); keys.setCatcher(keys.getCatcher() & ~KeyCatcher.Console);
    this.finalFrac = 0; this.displayFrac = 0;
  }
}
