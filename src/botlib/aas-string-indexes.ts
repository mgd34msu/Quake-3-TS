// Port of id Software's botlib/be_aas_main.c string indexes and be_aas_def.h offsets.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { BotMemory, BotMemoryAllocation } from "./memory.ts";

function sourceText(text: string): string {
  const nul = text.indexOf("\0"), value = nul < 0 ? text : text.slice(0, nul);
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 255) throw new RangeError("AAS string indexes require source byte strings");
  }
  return value;
}

function insensitive(text: string): string {
  return text.replace(/[a-z]/g, character => String.fromCharCode(character.charCodeAt(0) - 32));
}

export class AasStringIndexes {
  private readonly configstrings: (BotMemoryAllocation | null)[] = Array.from({ length: 1024 }, () => null);
  private indexesSetup = false;

  constructor(private readonly memory: BotMemory, private readonly print: (severity: 3, message: string) => void) {}

  stringFromIndex(name: string, first: number, count: number, index: number): string {
    if (!this.indexesSetup) {
      this.print(3, `${name}: index ${index} not setup\n`);
      return "";
    }
    if (index < 0 || index >= count) {
      this.print(3, `${name}: index ${index} out of range\n`);
      return "";
    }
    const allocation = this.slot(first + index);
    if (allocation === null) {
      if (index !== 0) this.print(3, `${name}: reference to unused index ${index}\n`);
      return "";
    }
    return this.text(allocation);
  }

  indexFromString(name: string, first: number, count: number, text: string): number {
    const value = sourceText(text);
    if (!this.indexesSetup) {
      this.print(3, `${name}: index not setup "${value}"\n`);
      return 0;
    }
    for (let index = 0; index < count; index++) {
      const allocation = this.slot(first + index);
      if (allocation !== null && insensitive(this.text(allocation)) === insensitive(value)) return index;
    }
    return 0;
  }

  modelFromIndex(index: number): string { return this.stringFromIndex("ModelFromIndex", 96, 256, index); }
  indexFromModel(model: string): number { return this.indexFromString("IndexFromModel", 96, 256, model); }

  update(count: number, strings: readonly (string | null)[]): void {
    for (let index = 0; index < count; index++) {
      const input = strings[index];
      if (input === undefined) throw new RangeError("AAS_UpdateStringIndexes input exceeds source allocation");
      if (input === null) continue;
      const text = sourceText(input);
      const allocation = this.memory.allocate(text.length + 1, "heap", false);
      this.slot(index);
      this.configstrings[index] = allocation;
      const bytes = allocation.bytes;
      for (let byte = 0; byte < text.length; byte++) bytes[byte] = text.charCodeAt(byte);
      bytes[text.length] = 0;
    }
    this.indexesSetup = true;
  }

  /** AAS_Shutdown clears pointers without freeing the string allocations. */
  clear(): void {
    this.configstrings.fill(null);
    this.indexesSetup = false;
  }

  private slot(index: number): BotMemoryAllocation | null {
    const value = this.configstrings[index];
    if (value === undefined) throw new RangeError("AAS configstring index exceeds source allocation");
    return value;
  }

  private text(allocation: BotMemoryAllocation): string {
    let result = "";
    for (const byte of allocation.bytes) {
      if (byte === 0) return result;
      result += String.fromCharCode(byte);
    }
    throw new RangeError("AAS configstring has no source terminator");
  }
}
