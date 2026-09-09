// Port of id Software's client/cl_keys.c key ownership and command dispatch.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { ClientLevel } from "../cgame/client-level.ts";
import type { CommandBuffer, CommandContext } from "../core/commands.ts";
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { EditField } from "../core/edit-field.ts";
import type { FieldClipboard, FieldControls } from "../core/edit-field.ts";
import { KEY_CHAR_FLAG, KeyCatcher, KeyCode } from "../core/key-codes.ts";
import { sourceCommandText } from "../core/text.ts";

export type ClientKeyPhase = "uninitialized" | "disconnected" | "connecting" | "challenging"
  | "connected" | "loading" | "primed" | "active" | "cinematic";
export interface ClientKeyConnection { readonly kind: ClientKeyPhase; readonly demoPlayback: boolean }
export interface ClientKeyUi {
  keyEvent(key: number, down: boolean): Promise<void>;
  setActiveMenu(menu: "main" | "ingame"): Promise<void>;
}
export interface ClientKeyHost {
  readConnection(): ClientKeyConnection;
  readUi(): ClientKeyUi | null;
  readCgame(): Pick<ClientLevel, "keyEvent" | "eventHandling"> | null;
  assertCurrentOperation(): undefined;
  disconnect(): Promise<void>;
  stopAllSounds(): undefined;
  addReliableCommand(text: string): undefined;
  toggleConsole(): Promise<void>;
  updateScreen(): Promise<void>;
  consoleScroll(action: "page-up" | "page-down" | "top" | "bottom"): undefined;
  readConsoleWidth(): number;
  readonly clipboard: FieldClipboard;
}
export interface ClientKeysOptions {
  readonly commands: CommandBuffer;
  readonly cvars: CvarRegistry;
  readonly print: (text: string) => undefined;
  readonly host: ClientKeyHost;
}

const keyNames: readonly (readonly [string, number])[] = [
  ["TAB", KeyCode.Tab], ["ENTER", KeyCode.Enter], ["ESCAPE", KeyCode.Escape], ["SPACE", KeyCode.Space], ["BACKSPACE", KeyCode.Backspace],
  ["UPARROW", KeyCode.Up], ["DOWNARROW", KeyCode.Down], ["LEFTARROW", KeyCode.Left], ["RIGHTARROW", KeyCode.Right],
  ["ALT", KeyCode.Alt], ["CTRL", KeyCode.Control], ["SHIFT", KeyCode.Shift], ["COMMAND", KeyCode.Command], ["CAPSLOCK", KeyCode.CapsLock],
  ...Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, KeyCode.F1 + i] satisfies readonly [string, number]),
  ["INS", KeyCode.Insert], ["DEL", KeyCode.Delete], ["PGDN", KeyCode.PageDown], ["PGUP", KeyCode.PageUp], ["HOME", KeyCode.Home], ["END", KeyCode.End],
  ...Array.from({ length: 5 }, (_, i) => [`MOUSE${i + 1}`, KeyCode.Mouse1 + i] satisfies readonly [string, number]),
  ["MWHEELUP", KeyCode.MouseWheelUp], ["MWHEELDOWN", KeyCode.MouseWheelDown],
  ...Array.from({ length: 32 }, (_, i) => [`JOY${i + 1}`, KeyCode.Joy1 + i] satisfies readonly [string, number]),
  ...Array.from({ length: 16 }, (_, i) => [`AUX${i + 1}`, KeyCode.Aux1 + i] satisfies readonly [string, number]),
  ["KP_HOME", KeyCode.KeypadHome], ["KP_UPARROW", KeyCode.KeypadUp], ["KP_PGUP", KeyCode.KeypadPageUp], ["KP_LEFTARROW", KeyCode.KeypadLeft],
  ["KP_5", KeyCode.Keypad5], ["KP_RIGHTARROW", KeyCode.KeypadRight], ["KP_END", KeyCode.KeypadEnd], ["KP_DOWNARROW", KeyCode.KeypadDown],
  ["KP_PGDN", KeyCode.KeypadPageDown], ["KP_ENTER", KeyCode.KeypadEnter], ["KP_INS", KeyCode.KeypadInsert], ["KP_DEL", KeyCode.KeypadDelete],
  ["KP_SLASH", KeyCode.KeypadSlash], ["KP_MINUS", KeyCode.KeypadMinus], ["KP_PLUS", KeyCode.KeypadPlus], ["KP_NUMLOCK", KeyCode.KeypadNumLock],
  ["KP_STAR", KeyCode.KeypadStar], ["KP_EQUALS", KeyCode.KeypadEquals], ["PAUSE", KeyCode.Pause], ["SEMICOLON", 59],
];
function lower(text: string): string { return text.replace(/[A-Z]/g, letter => String.fromCharCode(letter.charCodeAt(0) + 32)); }
function int32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new RangeError(`${label} requires int32`);
}
export function stringToKeynum(value: string | null): number {
  if (value === null) return -1;
  const text = sourceCommandText(value);
  if (text === "") return -1;
  if (text.length === 1) { const byte = text.charCodeAt(0); return byte < 128 ? byte : byte - 256; }
  if (text.startsWith("0x") && text.length === 4) {
    const nibble = (code: number): number => code >= 48 && code <= 57 ? code - 48 : code >= 97 && code <= 102 ? code - 87 : 0;
    return nibble(text.charCodeAt(2)) * 16 + nibble(text.charCodeAt(3));
  }
  for (const [name, number] of keyNames) if (lower(text) === lower(name)) return number;
  return -1;
}
export function keynumToString(key: number): string {
  if (key === -1) return "<KEY NOT FOUND>";
  if (!Number.isInteger(key) || key < 0 || key > 255) return "<OUT OF RANGE>";
  if (key > 32 && key < 127 && key !== 34 && key !== 59) return String.fromCharCode(key);
  for (const [name, number] of keyNames) if (key === number) return name;
  return `0x${key.toString(16).padStart(2, "0")}`;
}
class KeyCell { down = false; repeats = 0; binding: string | null = null }

export class ClientKeys {
  readonly consoleField = new EditField();
  readonly chatField = new EditField();
  private readonly history = Array.from({ length: 32 }, () => new EditField());
  private readonly cells = Array.from({ length: 256 }, () => new KeyCell());
  private nextHistoryLine = 0;
  private historyLine = 0;
  private anyKeyDown = 0;
  private catcher = 0;
  private overstrike = 0;
  private teamChat = false;
  private playerChat = 0;
  private initialized = false;
  private readonly controls: FieldControls;

  constructor(private readonly options: ClientKeysOptions) {
    this.controls = { isDown: key => this.isDown(key), getOverstrike: () => this.getOverstrike(),
      setOverstrike: value => { this.setOverstrike(value); }, clipboard: options.host.clipboard };
  }
  get inputState(): { readonly keyCatchers: number; readonly anyKeyDown: number } { return { keyCatchers: this.catcher, anyKeyDown: this.anyKeyDown }; }
  get chatTeam(): boolean { return this.teamChat; }
  get chatPlayer(): number { return this.playerChat; }
  getCatcher(): number { return this.catcher; }
  setCatcher(value: number): void { this.guard(); int32(value, "Key catcher"); this.catcher = value; }
  isDown(key: number): boolean { return key === -1 ? false : this.cell(key).down; }
  getOverstrike(): boolean { return this.overstrike !== 0; }
  setOverstrike(value: boolean): void { this.setOverstrikeMode(Number(value)); }
  getOverstrikeMode(): number { return this.overstrike; }
  setOverstrikeMode(value: number): void { this.guard(); int32(value, "Overstrike mode"); this.overstrike = value; }
  getBinding(key: number): string | null { return key === -1 ? "" : this.cell(key).binding; }
  setBinding(key: number, text: string): void {
    this.guard(); if (key === -1) return;
    const cell = this.cell(key); cell.binding = sourceCommandText(text); this.options.cvars.markModifiedFlags(CvarFlag.Archive);
  }
  getKey(binding: string | null): number {
    if (binding === null) return -1;
    const text = lower(sourceCommandText(binding));
    for (const [index, cell] of this.cells.entries()) if (cell.binding !== null && lower(cell.binding) === text) return index;
    return -1;
  }
  setChatTeam(value: boolean): void { this.guard(); this.teamChat = value; }
  setChatPlayer(value: number): void { this.guard(); int32(value, "Message player"); this.playerChat = value; }
  initializeConsoleFields(width: number): void {
    this.guard(); int32(width, "Console width"); this.consoleField.clear(); this.consoleField.widthInChars = width;
    for (const field of this.history) { field.clear(); field.widthInChars = width; }
  }
  initializeCommands(): void {
    this.guard(); if (this.initialized) throw new Error("Key commands are already initialized");
    this.options.commands.register("bind", context => { context.assertActive(); this.guard(); this.bind(context); });
    this.options.commands.register("unbind", context => {
      context.assertActive(); this.guard();
      if (context.argv.length !== 2) { this.options.print("unbind <key> : remove commands from a key\n"); return; }
      const name = context.argv[1] ?? "", key = stringToKeynum(name);
      if (key === -1) { this.options.print(`"${name}" isn't a valid key\n`); return; }
      this.setBinding(key, "");
    });
    this.options.commands.register("unbindall", context => {
      context.assertActive(); this.guard();
      for (let key = 0; key < this.cells.length; key++) if (this.cell(key).binding !== null) this.setBinding(key, "");
    });
    this.options.commands.register("bindlist", context => {
      context.assertActive(); this.guard();
      for (const [key, cell] of this.cells.entries()) if (cell.binding !== null && cell.binding !== "") this.options.print(`${keynumToString(key)} "${cell.binding}"\n`);
    });
    this.initialized = true;
  }
  writeBindings(write: (text: string) => undefined): void {
    this.guard(); write("unbindall\n");
    for (const [key, cell] of this.cells.entries()) if (cell.binding !== null && cell.binding !== "") write(`bind ${keynumToString(key)} "${cell.binding}"\n`);
  }
  private guard(): void { this.options.host.assertCurrentOperation(); }
  private cell(key: number): KeyCell {
    const cell = this.cells[key];
    if (cell === undefined) throw new RangeError(`Undefined native key index ${key}`);
    return cell;
  }
  private numeric(name: string): number { return this.options.cvars.get(name)?.numericValue ?? 0; }
  private format(text: string, size: number): string {
    if (text.length >= size) this.options.print(`Com_sprintf: overflow of ${text.length} in ${size}\n`);
    return text.slice(0, size - 1);
  }
  private bind(context: CommandContext): void {
    if (context.argv.length < 2) { this.options.print("bind <key> [command] : attach a command to a key\n"); return; }
    const name = context.argv[1] ?? "", key = stringToKeynum(name);
    if (key === -1) { this.options.print(`"${name}" isn't a valid key\n`); return; }
    const cell = this.cell(key);
    if (context.argv.length === 2) { this.options.print(cell.binding === null ? `"${name}" is not bound\n` : `"${name}" = "${cell.binding}"\n`); return; }
    const text = context.argv.slice(2).join(" ");
    if (text.length >= 1024) throw new RangeError("Undefined native bind command buffer overflow");
    this.setBinding(key, text);
  }
  private *segments(binding: string): Generator<string, undefined, undefined> {
    let segment = "";
    for (let index = 0; ; index++) {
      let byte = index < binding.length ? binding.charCodeAt(index) : 0;
      if (byte === 59 || byte === 0) {
        yield segment; segment = "";
        while (byte !== 0 && (byte <= 32 || byte >= 128 || byte === 59)) {
          index++; byte = index < binding.length ? binding.charCodeAt(index) : 0;
        }
      }
      if (byte === 0) return;
      if (segment.length >= 1023) throw new RangeError("Undefined native binding segment buffer overflow");
      segment += String.fromCharCode(byte);
    }
  }
  private addKeyUpCommands(key: number, binding: string | null, time: number): void {
    if (binding === null) return;
    let keyEvent = false;
    for (const segment of this.segments(binding)) {
      if (segment.startsWith("+")) {
        // Repair the source helper's accidental libc `time` pointer formatting.
        this.options.commands.append(this.format(`-${segment.slice(1)} ${key} ${time | 0}\n`, 1024)); keyEvent = true;
      } else if (keyEvent) { this.options.commands.append(segment); this.options.commands.append("\n"); }
    }
  }
  private ui(): ClientKeyUi {
    const ui = this.options.host.readUi(); if (ui === null) throw new Error("Native key path requires unavailable product UI"); return ui;
  }
  async keyEvent(key: number, down: boolean, time: number): Promise<void> {
    this.guard();
    const cell = this.cell(key);
    if (!Number.isInteger(time) || time < 0 || time > 4294967295) throw new RangeError("Key event time requires uint32");
    cell.down = down;
    if (down) {
      if (cell.repeats === 2147483647) throw new RangeError("Undefined native key repeat overflow");
      cell.repeats++;
      if (cell.repeats === 1) this.anyKeyDown = (this.anyKeyDown + 1) >>> 0;
    } else { cell.repeats = 0; this.anyKeyDown = (this.anyKeyDown - 1) >>> 0; }
    if (key === KeyCode.Enter && down && this.isDown(KeyCode.Alt)) {
      await this.clearStates(); this.guard();
      if (this.numeric("r_fullscreen") === 0) { this.options.print("Switching to fullscreen rendering\n"); this.options.cvars.set("r_fullscreen", "1", true); }
      else { this.options.print("Switching to windowed rendering\n"); this.options.cvars.set("r_fullscreen", "0", true); }
      this.options.commands.append("vid_restart\n"); return;
    }
    if (key === 96 || key === 126) { if (down) { await this.options.host.toggleConsole(); this.guard(); } return; }
    if (down && (key < 128 || key === KeyCode.Mouse1)
      && (this.options.host.readConnection().demoPlayback || this.options.host.readConnection().kind === "cinematic") && this.catcher === 0) {
      if (this.numeric("com_cameraMode") === 0) { this.options.cvars.set("nextdemo", "", true); key = KeyCode.Escape; }
    }
    if (key === KeyCode.Escape && down) {
      if ((this.catcher & KeyCatcher.Message) !== 0) { this.messageKey(key); return; }
      if ((this.catcher & KeyCatcher.Cgame) !== 0) {
        this.catcher &= ~KeyCatcher.Cgame;
        const cgame = this.options.host.readCgame(); if (cgame === null) throw new Error("Native escape requires unavailable cgame");
        await cgame.eventHandling(0); this.guard(); return;
      }
      if ((this.catcher & KeyCatcher.Ui) === 0) {
        if (this.options.host.readConnection().kind === "active" && !this.options.host.readConnection().demoPlayback) await this.ui().setActiveMenu("ingame");
        else {
          await this.options.host.disconnect(); this.guard(); this.options.host.stopAllSounds();
          await this.ui().setActiveMenu("main");
        }
        this.guard(); return;
      }
      await this.ui().keyEvent(key, down); this.guard(); return;
    }
    if (!down) {
      this.addKeyUpCommands(key, this.cell(key).binding, time);
      if ((this.catcher & KeyCatcher.Ui) !== 0 && this.options.host.readUi() !== null) { await this.ui().keyEvent(key, down); this.guard(); }
      else if ((this.catcher & KeyCatcher.Cgame) !== 0) {
        const cgame = this.options.host.readCgame(); if (cgame !== null) { await cgame.keyEvent(key, down); this.guard(); }
      }
      return;
    }
    if ((this.catcher & KeyCatcher.Console) !== 0) { await this.consoleKey(key); this.guard(); }
    else if ((this.catcher & KeyCatcher.Ui) !== 0) {
      const ui = this.options.host.readUi(); if (ui !== null) { await ui.keyEvent(key, down); this.guard(); }
    } else if ((this.catcher & KeyCatcher.Cgame) !== 0) {
      const cgame = this.options.host.readCgame(); if (cgame !== null) { await cgame.keyEvent(key, down); this.guard(); }
    } else if ((this.catcher & KeyCatcher.Message) !== 0) this.messageKey(key);
    else if (this.options.host.readConnection().kind === "disconnected") { await this.consoleKey(key); this.guard(); }
    else {
      const binding = this.cell(key).binding;
      if (binding === null) { if (key >= 200) this.options.print(`${keynumToString(key)} is unbound, use controls menu to set.\n`); }
      else if (binding.startsWith("+")) for (const segment of this.segments(binding)) {
        if (segment.startsWith("+")) this.options.commands.append(this.format(`${segment} ${key} ${time | 0}\n`, 1024));
        else { this.options.commands.append(segment); this.options.commands.append("\n"); }
      }
      else { this.options.commands.append(binding); this.options.commands.append("\n"); }
    }
  }
  async charEvent(character: number): Promise<void> {
    this.guard(); if (character === 96 || character === 126) return;
    if (!Number.isInteger(character) || character < 0 || character > 255) throw new RangeError("Key characters require source bytes");
    if ((this.catcher & KeyCatcher.Console) !== 0) this.consoleField.charEvent(character, this.controls);
    else if ((this.catcher & KeyCatcher.Ui) !== 0) { await this.ui().keyEvent(character | KEY_CHAR_FLAG, true); this.guard(); }
    else if ((this.catcher & KeyCatcher.Message) !== 0) this.chatField.charEvent(character, this.controls);
    else if (this.options.host.readConnection().kind === "disconnected") this.consoleField.charEvent(character, this.controls);
  }
  async clearStates(): Promise<void> {
    this.guard(); this.anyKeyDown = 0;
    for (const [key, cell] of this.cells.entries()) {
      if (cell.down) { await this.keyEvent(key, false, 0); this.guard(); }
      cell.down = false; cell.repeats = 0;
    }
  }
  private messageKey(key: number): void {
    if (key === KeyCode.Escape) { this.catcher &= ~KeyCatcher.Message; this.chatField.clear(); return; }
    if (key === KeyCode.Enter || key === KeyCode.KeypadEnter) {
      if (this.chatField.text !== "" && this.options.host.readConnection().kind === "active") {
        const command = this.playerChat !== -1 ? `tell ${this.playerChat}` : this.teamChat ? "say_team" : "say";
        this.options.host.addReliableCommand(this.format(`${command} "${this.chatField.text}"\n`, 1024));
      }
      this.catcher &= ~KeyCatcher.Message; this.chatField.clear(); return;
    }
    this.chatField.keyDown(key, this.controls);
  }
  private async consoleKey(key: number): Promise<void> {
    const field = this.consoleField, host = this.options.host;
    if (key === 108 && this.isDown(KeyCode.Control)) { this.options.commands.append("clear\n"); return; }
    if (key === KeyCode.Enter || key === KeyCode.KeypadEnter) {
      if (host.readConnection().kind !== "active" && !field.text.startsWith("\\") && !field.text.startsWith("/")) {
        field.setText(this.format(`\\${field.text}`, 256)); field.cursor++;
      }
      this.options.print(`]${field.text}\n`);
      if (field.text.startsWith("\\") || field.text.startsWith("/")) { this.options.commands.append(field.text.slice(1)); this.options.commands.append("\n"); }
      else if (field.text === "") return;
      else { this.options.commands.append("cmd say "); this.options.commands.append(field.text); this.options.commands.append("\n"); }
      this.historyField(this.nextHistoryLine).copyFrom(field); this.nextHistoryLine = (this.nextHistoryLine + 1) | 0; this.historyLine = this.nextHistoryLine;
      field.clear(); field.widthInChars = host.readConsoleWidth();
      if (host.readConnection().kind === "disconnected") { await host.updateScreen(); this.guard(); }
      return;
    }
    if (key === KeyCode.Tab) { field.complete(this.options.commands, this.options.cvars, this.options.print); return; }
    if ((key === KeyCode.MouseWheelUp && this.isDown(KeyCode.Shift)) || key === KeyCode.Up || key === KeyCode.KeypadUp
      || ((key === 80 || key === 112) && this.isDown(KeyCode.Control))) {
      if (this.nextHistoryLine - this.historyLine < 32 && this.historyLine > 0) this.historyLine--;
      field.copyFrom(this.historyField(this.historyLine)); return;
    }
    if ((key === KeyCode.MouseWheelDown && this.isDown(KeyCode.Shift)) || key === KeyCode.Down || key === KeyCode.KeypadDown
      || ((key === 78 || key === 110) && this.isDown(KeyCode.Control))) {
      if (this.historyLine === this.nextHistoryLine) return;
      this.historyLine++; field.copyFrom(this.historyField(this.historyLine)); return;
    }
    if (key === KeyCode.PageUp) { host.consoleScroll("page-up"); return; }
    if (key === KeyCode.PageDown) { host.consoleScroll("page-down"); return; }
    if (key === KeyCode.MouseWheelUp || key === KeyCode.MouseWheelDown) {
      const action = key === KeyCode.MouseWheelUp ? "page-up" : "page-down"; host.consoleScroll(action);
      if (this.isDown(KeyCode.Control)) { host.consoleScroll(action); host.consoleScroll(action); } return;
    }
    if (key === KeyCode.Home && this.isDown(KeyCode.Control)) { host.consoleScroll("top"); return; }
    if (key === KeyCode.End && this.isDown(KeyCode.Control)) { host.consoleScroll("bottom"); return; }
    field.keyDown(key, this.controls);
  }
  private historyField(number: number): EditField {
    const field = this.history[number % 32]; if (field === undefined) throw new RangeError("Undefined native negative console history index"); return field;
  }
}
