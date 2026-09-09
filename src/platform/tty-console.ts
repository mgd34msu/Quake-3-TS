// Port of unix_main.c Sys_ConsoleInput, tty_Hide/Show and Hist_Add/Prev/Next.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { EditField } from "../core/edit-field.ts";

interface TtyConsoleServices {
  readonly erase: number;
  readonly write: (byte: number) => undefined;
  readonly complete: (field: EditField) => undefined;
  readonly developerPrint: (text: string) => undefined;
}

/** The Linux signed-char editor, separate from the graphical field key handler. */
export class TtyConsole {
  private readonly field = new EditField();
  private readonly history: EditField[] = [];
  private historyCurrent = -1;
  private hidden = 0;

  constructor(private readonly services: TtyConsoleServices) {
    if (!Number.isInteger(services.erase) || services.erase < 0 || services.erase > 255) {
      throw new RangeError("TTY erase requires a source control byte");
    }
  }

  private back(): void {
    this.services.write(8); this.services.write(32); this.services.write(8);
  }

  hide(): void {
    if (this.hidden > 0) { this.hidden++; return; }
    for (let i = 0; i < this.field.cursor; i++) this.back();
    this.hidden++;
  }

  show(): void {
    if (this.hidden === 0) throw new Error("TTY console show without hide");
    if (--this.hidden !== 0) return;
    for (let i = 0; i < this.field.cursor; i++) this.services.write(this.field.readByte(i));
  }

  private addHistory(): void {
    const saved = new EditField(); saved.copyFrom(this.field);
    this.history.unshift(saved);
    if (this.history.length > 32) this.history.pop();
    this.historyCurrent = -1;
  }

  private previousHistory(): EditField | null {
    const next = this.historyCurrent + 1;
    if (next >= this.history.length) return null;
    this.historyCurrent = next;
    const field = this.history[next];
    if (field === undefined) throw new Error("TTY history entry is missing");
    return field;
  }

  private nextHistory(): EditField | null {
    if (this.historyCurrent >= 0) this.historyCurrent--;
    if (this.historyCurrent === -1) return null;
    const field = this.history[this.historyCurrent];
    if (field === undefined) throw new Error("TTY history entry is missing");
    return field;
  }

  private flush(read: () => number | null): void { while (read() !== null) { /* tty_FlushIn */ } }

  /** One source poll. Escape suffix reads and flushing consume only currently ready bytes. */
  poll(read: () => number | null): string | null {
    const byte = read();
    if (byte === null) return null;
    let key = byte < 128 ? byte : byte - 256;
    if (key === this.services.erase || key === 127 || key === 8) {
      if (this.field.cursor > 0) {
        this.field.cursor--;
        this.field.writeByte(this.field.cursor, 0);
        this.back();
      }
      return null;
    }
    if (key !== 0 && key < 32) {
      if (key === 10) {
        this.addHistory();
        const text = this.field.text;
        this.field.clear(); this.services.write(10);
        return text;
      }
      if (key === 9) {
        this.hide(); this.services.complete(this.field);
        this.field.cursor = this.field.text.length;
        if (this.field.cursor > 0 && this.field.readByte(0) === 92) {
          // The source copies one byte beyond the terminator as well.
          for (let i = 0; i <= this.field.cursor; i++) this.field.writeByte(i, this.field.readByte(i + 1));
          this.field.cursor--;
        }
        this.show();
        return null;
      }
      const second = read();
      if (second !== null) {
        key = second < 128 ? second : second - 256;
        if (key === 91 || key === 79) {
          const third = read();
          if (third !== null) {
            key = third < 128 ? third : third - 256;
            if (key === 65) {
              const previous = this.previousHistory();
              if (previous !== null) { this.hide(); this.field.copyFrom(previous); this.show(); }
              this.flush(read); return null;
            }
            if (key === 66) {
              const next = this.nextHistory();
              this.hide();
              if (next === null) this.field.clear(); else this.field.copyFrom(next);
              this.show(); this.flush(read); return null;
            }
            if (key === 67 || key === 68) return null;
          }
        }
      }
      this.services.developerPrint(`droping ISCTL sequence: ${key}, tty_erase: ${this.services.erase}\n`);
      this.flush(read); return null;
    }
    // Native code has no capacity check or trailing-NUL write here. EditField
    // rejects the eventual undefined access instead of truncating a command.
    this.field.writeByte(this.field.cursor, byte); this.field.cursor++;
    this.services.write(byte);
    return null;
  }
}
