// gameState_t and CL_ParseGamestate/CL_ConfigstringModified from id Software's
// code/game/q_shared.h and code/client/cl_parse.c, cl_cgame.c, cl_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

export interface SourceGameStateRecord {
  readonly stringOffsets: Int32Array;
  readonly stringData: Uint8Array;
  readonly dataCount: number;
}

/** The session's sole configstring owner, including source allocation order. */
export class ClientGameStateStorage {
  private readonly offsets = new Int32Array(1024);
  private readonly data = new Uint8Array(16000);
  private count = 0;

  constructor(private readonly drop: (message: string) => never) {}

  clear(): void { this.offsets.fill(0); this.data.fill(0); this.count = 0; }
  beginEntries(): void { this.count = 1; }

  copySourceRecord(): SourceGameStateRecord {
    return { stringOffsets: this.offsets.slice(), stringData: this.data.slice(), dataCount: this.count };
  }

  copyStrings(): readonly string[] {
    return Array.from({ length: this.offsets.length }, (_, index) => this.get(index) ?? "");
  }

  get(index: number): string | null {
    const offset = this.offsets[index];
    if (!Number.isInteger(index) || offset === undefined) throw new RangeError(`Invalid configstring index ${index}`);
    if (offset === 0) return null;
    let value = "";
    for (let cursor = offset; cursor < this.data.length; cursor++) {
      const byte = this.data[cursor];
      if (byte === undefined) throw new RangeError(`Invalid configstring byte ${cursor}`);
      if (byte === 0) return value;
      value += String.fromCharCode(byte);
    }
    throw new RangeError("Unterminated owned configstring");
  }

  /** Initial entries append even when their index or value already occurred. */
  append(index: number, value: string): void {
    this.validate(index, value);
    this.appendBytes(index, value);
  }

  /** Rebuild publishes each nonempty entry before advancing to the next index. */
  modify(index: number, value: string): boolean {
    this.validate(index, value);
    if ((this.get(index) ?? "") === value) return false;
    const previous = this.copyStrings();
    this.clear();
    this.beginEntries();
    for (const [slot, old] of previous.entries()) {
      const text = slot === index ? value : old;
      if (text !== "") this.appendBytes(slot, text);
    }
    return true;
  }

  private validate(index: number, value: string): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.offsets.length) this.drop("configstring > MAX_CONFIGSTRINGS");
    for (let i = 0; i < value.length; i++) {
      const byte = value.charCodeAt(i);
      if (byte === 0 || byte > 255) throw new RangeError("Configstrings require non-NUL byte characters");
    }
  }

  private appendBytes(index: number, value: string): void {
    if (value.length + 1 + this.count > this.data.length) this.drop("MAX_GAMESTATE_CHARS exceeded");
    this.offsets[index] = this.count;
    for (let i = 0; i < value.length; i++) this.data[this.count + i] = value.charCodeAt(i);
    this.data[this.count + value.length] = 0;
    this.count += value.length + 1;
  }
}
