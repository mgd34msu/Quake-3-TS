// Port of cl_keys.c fields and common.c field completion.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CommandBuffer, CommandStringReference } from "./commands.ts";
import type { CvarRegistry } from "./cvar.ts";
import { KeyCode } from "./key-codes.ts";
import { sourceCommandText } from "./text.ts";

export type FieldClipboard = { readonly kind: "native-unix-unavailable" }
  | { readonly kind: "available"; readonly read: () => Uint8Array | null };
export interface FieldControls {
  isDown(key: number): boolean;
  getOverstrike(): boolean;
  setOverstrike(value: boolean): void;
  readonly clipboard: FieldClipboard;
}
function lower(text: string): string { return text.replace(/[A-Z]/g, letter => String.fromCharCode(letter.charCodeAt(0) + 32)); }
function index(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= 256) throw new RangeError("Undefined native field buffer index");
}
function integer(value: number): void {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new RangeError("Field input requires int32");
}

/** common.c's completion globals belong to the common command owner. */
export class CommandCompletionState {
  private completionString: CommandStringReference | null = null;
  private completionField: EditField | null = null;
  private readonly shortestMatch = new Uint8Array(1024);
  private matchCount = 0;

  private field(): EditField {
    if (this.completionField === null) throw new Error("Field completion has no current field");
    return this.completionField;
  }

  private prefix(): string {
    if (this.completionString === null) throw new Error("Field completion has no current token");
    return this.completionString.value;
  }

  private shortest(): string {
    let text = "";
    for (const byte of this.shortestMatch) { if (byte === 0) return text; text += String.fromCharCode(byte); }
    throw new RangeError("Undefined native unterminated completion match");
  }

  private findMatch(name: string): undefined {
    if (!lower(name).startsWith(lower(this.prefix()))) return;
    if (++this.matchCount === 1) {
      const length = Math.min(name.length, this.shortestMatch.length - 1);
      for (let i = 0; i < length; i++) this.shortestMatch[i] = name.charCodeAt(i);
      this.shortestMatch[length] = 0;
      return;
    }
    for (let i = 0; i < name.length; i++) {
      const byte = this.shortestMatch[i];
      if (byte === undefined) throw new RangeError("Undefined native completion match index");
      if (lower(String.fromCharCode(byte)) !== lower(name.charAt(i))) this.shortestMatch[i] = 0;
    }
  }

  private append(text: string): void {
    const field = this.field();
    field.setText((field.text + text).slice(0, 255));
  }

  private concatRemaining(original: string, commands: CommandBuffer): void {
    const prefix = this.prefix(), found = original.indexOf(prefix);
    if (found >= 0) { this.append(original.slice(found + prefix.length)); return; }
    for (let i = 1; i < commands.tokenizedArguments.length; i++) {
      this.append(" ");
      const arg = commands.argumentReference(i).value, quoted = arg.includes(" ");
      if (quoted) this.append('"');
      this.append(commands.argumentReference(i).value);
      if (quoted) this.append('"');
    }
  }

  private writeMatch(print: (text: string) => undefined): void {
    const destination = this.field(), text = `\\${this.shortest()}`;
    if (text.length >= 256) print(`Com_sprintf: overflow of ${text.length} in 256\n`);
    destination.setText(text.slice(0, 255));
  }

  complete(field: EditField, commands: CommandBuffer, cvars: CvarRegistry, print: (text: string) => undefined): void {
    this.completionField = field;
    commands.tokenize(this.field().text);
    this.completionString = commands.argumentReference(0);
    if (this.prefix().startsWith("\\") || this.prefix().startsWith("/")) this.completionString = this.completionString.offset(1);
    this.matchCount = 0;
    this.shortestMatch[0] = 0;
    if (this.prefix().length === 0) return;
    commands.completeNames(name => this.findMatch(name));
    cvars.visit(0, value => { if (value.nameString !== null) this.findMatch(value.nameString.value); });
    if (this.matchCount === 0) return;
    const original = this.field().text;
    if (this.matchCount === 1) {
      this.writeMatch(print);
      if (commands.tokenizedArguments.length === 1) this.append(" "); else this.concatRemaining(original, commands);
      this.field().cursor = this.field().text.length;
      return;
    }
    this.writeMatch(print);
    this.field().cursor = this.field().text.length;
    this.concatRemaining(original, commands);
    print(`]${this.field().text}\n`);
    const printMatch = (name: string): undefined => { if (lower(name).startsWith(lower(this.shortest()))) print(`    ${name}\n`); };
    commands.completeNames(printMatch);
    cvars.visit(0, value => { if (value.nameString !== null) printMatch(value.nameString.value); });
  }
}

export class EditField {
  cursor = 0;
  scroll = 0;
  widthInChars = 0;
  private readonly buffer = new Uint8Array(256);
  private pasteDepth = 0;
  private pasteWork = 0;

  get text(): string {
    let result = "";
    for (const byte of this.buffer) { if (byte === 0) return result; result += String.fromCharCode(byte); }
    throw new RangeError("Undefined native unterminated field buffer");
  }
  readByte(offset: number): number {
    index(offset);
    const byte = this.buffer[offset];
    if (byte === undefined) throw new RangeError("Undefined native field buffer index");
    return byte;
  }
  writeByte(offset: number, byte: number): void {
    index(offset);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new RangeError("Field characters require source bytes");
    this.buffer[offset] = byte;
  }
  clear(): void { this.buffer.fill(0); this.cursor = 0; this.scroll = 0; }
  setText(value: string): void {
    const text = sourceCommandText(value);
    if (text.length >= this.buffer.length) throw new RangeError("Field text exceeds 255 bytes");
    for (let i = 0; i < text.length; i++) this.buffer[i] = text.charCodeAt(i);
    this.buffer[text.length] = 0;
  }
  copyFrom(source: EditField): void {
    this.buffer.set(source.buffer); this.cursor = source.cursor; this.scroll = source.scroll; this.widthInChars = source.widthInChars;
  }
  private move(destination: number, start: number, end: number): void {
    index(destination); index(start);
    if (!Number.isInteger(end) || end < start || end > 256 || destination + end - start > 256) throw new RangeError("Undefined native field memmove range");
    this.buffer.copyWithin(destination, start, end);
  }
  private paste(controls: FieldControls): void {
    if (controls.clipboard.kind === "native-unix-unavailable") return;
    if (this.pasteDepth >= 32) throw new RangeError("Recursive field paste exceeded 32 clipboard reads");
    const bytes = controls.clipboard.read();
    if (bytes === null) return;
    if (this.pasteDepth === 0) this.pasteWork = 0;
    this.pasteDepth++;
    try {
      for (const byte of bytes) {
        if (byte === 0) break;
        if (++this.pasteWork > 65536) throw new RangeError("Field paste exceeded 65536 byte operations");
        this.charEvent(byte < 128 ? byte : byte - 256, controls);
      }
    } finally { this.pasteDepth--; }
  }
  keyDown(key: number, controls: FieldControls): void {
    integer(key);
    if ((key === KeyCode.Insert || key === KeyCode.KeypadInsert) && controls.isDown(KeyCode.Shift)) { this.paste(controls); return; }
    const length = this.text.length;
    if (key === KeyCode.Delete) {
      if (this.cursor < length) this.move(this.cursor, this.cursor + 1, length + 1);
      return;
    }
    if (key === KeyCode.Right) {
      if (this.cursor < length) this.cursor++;
      if (this.cursor >= this.scroll + this.widthInChars && this.cursor <= length) this.scroll++;
      return;
    }
    if (key === KeyCode.Left) {
      if (this.cursor > 0) this.cursor--;
      if (this.cursor < this.scroll) this.scroll--;
      return;
    }
    if (key === KeyCode.Home || ((key === 65 || key === 97) && controls.isDown(KeyCode.Control))) { this.cursor = 0; return; }
    if (key === KeyCode.End || ((key === 69 || key === 101) && controls.isDown(KeyCode.Control))) { this.cursor = length; return; }
    if (key === KeyCode.Insert) controls.setOverstrike(!controls.getOverstrike());
  }
  charEvent(character: number, controls: FieldControls): void {
    integer(character);
    if (character === 22) { this.paste(controls); return; }
    if (character === 3) { this.clear(); return; }
    const length = this.text.length;
    if (character === 8) {
      if (this.cursor > 0) {
        this.move(this.cursor - 1, this.cursor, length + 1); this.cursor--;
        if (this.cursor < this.scroll) this.scroll--;
      }
      return;
    }
    if (character === 1) { this.cursor = 0; this.scroll = 0; return; }
    if (character === 5) { this.cursor = length; this.scroll = this.cursor - this.widthInChars; return; }
    if (character < 32) return;
    if (character > 255) throw new RangeError("Field characters require source bytes");
    if (controls.getOverstrike()) {
      if (this.cursor === 255) return;
      index(this.cursor); this.buffer[this.cursor] = character; this.cursor++;
    } else {
      if (length === 255) return;
      this.move(this.cursor + 1, this.cursor, length + 1); this.buffer[this.cursor] = character; this.cursor++;
    }
    if (this.cursor >= this.widthInChars) this.scroll++;
    if (this.cursor === length + 1) { index(this.cursor); this.buffer[this.cursor] = 0; }
  }
  complete(commands: CommandBuffer, cvars: CvarRegistry, print: (text: string) => undefined): void {
    commands.completionState.complete(this, commands, cvars, print);
  }
}
