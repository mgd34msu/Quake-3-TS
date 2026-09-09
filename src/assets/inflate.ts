// Altered TypeScript implementation of the inflater in code/qcommon/unzip.c
// (inflate, adler32, inflate_blocks, inflate_trees_*, inflate_codes).
// The dictionary setter translates the source's disabled #if 0 implementation.
// Canonical decoding follows
// RFC 1951 sections 3.1-3.2: https://www.rfc-editor.org/rfc/rfc1951.
// This uses a canonical symbol table, not the original multi-level lookup table.
/*
  Copyright (C) 1995-1998 Jean-loup Gailly and Mark Adler

  This software is provided 'as-is', without any express or implied
  warranty.  In no event will the authors be held liable for any damages
  arising from the use of this software.

  Permission is granted to anyone to use this software for any purpose,
  including commercial applications, and to alter it and redistribute it
  freely, subject to the following restrictions:

  1. The origin of this software must not be misrepresented; you must not
     claim that you wrote the original software. If you use this software
     in a product, an acknowledgment in the product documentation would be
     appreciated but is not required.
  2. Altered source versions must be plainly marked as such, and must not be
     misrepresented as being the original software.
  3. This notice may not be removed or altered from any source distribution.

  Jean-loup Gailly        Mark Adler
  jloup@gzip.org          madler@alumni.caltech.edu
*/

const CODE_LENGTH_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

/** Source adler32: null resets to one; non-null empty input preserves the seed. */
export function adler32(adler: number, bytes: Uint8Array | null): number {
  if (bytes === null) return 1;
  let low = adler & 0xffff;
  let high = (adler >>> 16) & 0xffff;
  for (let offset = 0; offset < bytes.length; offset += 5552) {
    for (const byte of bytes.subarray(offset, offset + 5552)) {
      low += byte;
      high += low;
    }
    low %= 65521;
    high %= 65521;
  }
  return ((high << 16) | low) >>> 0;
}

export class RawInflateError extends Error {
  constructor(readonly bitOffset: number, message: string) {
    super(`DEFLATE bit ${bitOffset}: ${message}`);
    this.name = "RawInflateError";
  }
}

class BitInput {
  private buffer = 0;
  private bufferedBits = 0;
  private bytesRead = 0;

  constructor(private readonly readByte: () => number | undefined) {}

  get bitOffset(): number {
    return this.bytesRead * 8 - this.bufferedBits;
  }

  fail(message: string): never {
    throw new RawInflateError(this.bitOffset, message);
  }

  readBits(count: number): number {
    while (this.bufferedBits < count) {
      const byte = this.readByte();
      if (byte === undefined) this.fail("truncated compressed input");
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) this.fail("input callback returned an invalid byte");
      this.buffer |= byte << this.bufferedBits;
      this.bufferedBits += 8;
      this.bytesRead++;
    }
    const value = this.buffer & ((1 << count) - 1);
    this.buffer >>>= count;
    this.bufferedBits -= count;
    return value;
  }

  alignByte(): void {
    this.readBits(this.bufferedBits & 7);
  }
}

class HuffmanTree {
  private readonly counts = new DataView(new ArrayBuffer(32));
  private readonly symbols: DataView;
  private readonly maximumLength: number;

  constructor(lengths: Uint8Array, input: BitInput, readonly name: string) {
    this.symbols = new DataView(new ArrayBuffer(lengths.length * 2));
    let maximumLength = 0;
    for (const length of lengths) {
      this.counts.setUint16(length * 2, this.counts.getUint16(length * 2, true) + 1, true);
      maximumLength = Math.max(maximumLength, length);
    }
    this.maximumLength = maximumLength;
    let unused = 1;
    for (let length = 1; length <= 15; length++) {
      unused = unused * 2 - this.counts.getUint16(length * 2, true);
      if (unused < 0) input.fail(`oversubscribed ${name} tree`);
    }
    // huft_build accepts a one-bit single-code tree. An empty distance tree
    // is checked separately against the declared literal/length count.
    if (maximumLength !== 0 && unused !== 0 && maximumLength !== 1) input.fail(`incomplete ${name} tree`);

    const offsets = new DataView(new ArrayBuffer(32));
    let offset = 0;
    for (let length = 1; length <= 15; length++) {
      offsets.setUint16(length * 2, offset, true);
      offset += this.counts.getUint16(length * 2, true);
    }
    const lengthView = new DataView(lengths.buffer, lengths.byteOffset, lengths.byteLength);
    for (let symbol = 0; symbol < lengths.length; symbol++) {
      const length = lengthView.getUint8(symbol);
      if (length === 0) continue;
      const index = offsets.getUint16(length * 2, true);
      this.symbols.setUint16(index * 2, symbol, true);
      offsets.setUint16(length * 2, index + 1, true);
    }
  }

  get empty(): boolean {
    return this.maximumLength === 0;
  }

  readSymbol(input: BitInput): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let length = 1; length <= this.maximumLength; length++) {
      code = code * 2 + input.readBits(1);
      const count = this.counts.getUint16(length * 2, true);
      const relative = code - first;
      if (relative >= 0 && relative < count) return this.symbols.getUint16((index + relative) * 2, true);
      index += count;
      first = (first + count) * 2;
    }
    return input.fail(`invalid ${this.name} code`);
  }
}

interface MatchCopy {
  remaining: number;
  readonly distance: number;
}

interface CompressedBlock {
  readonly kind: "compressed";
  readonly final: boolean;
  readonly literals: HuffmanTree;
  readonly distances: HuffmanTree;
  match: MatchCopy | null;
}

type InflateState =
  | { readonly kind: "header" }
  | { readonly kind: "stored"; readonly final: boolean; remaining: number }
  | CompressedBlock
  | { readonly kind: "ended" }
  | { readonly kind: "failed"; readonly error: unknown };

class InflateBlocks {
  private readonly window: DataView;
  private readonly windowMask: number;
  private windowOffset = 0;
  private historyLength = 0;
  private state: InflateState = { kind: "header" };

  constructor(private readonly input: BitInput, windowBits: number) {
    this.window = new DataView(new ArrayBuffer(1 << windowBits));
    this.windowMask = this.window.byteLength - 1;
  }

  setDictionary(dictionary: Uint8Array): void {
    // inflateSetDictionary retains window size minus one bytes, not a full ring.
    const retained = dictionary.subarray(Math.max(0, dictionary.length - this.windowMask));
    for (const byte of retained) this.remember(byte);
  }

  get ended(): boolean {
    return this.state.kind === "ended";
  }

  /** Filling the destination does not consume the next symbol or end marker. */
  readInto(destination: Uint8Array): number {
    if (destination.byteLength === 0) return 0;
    let written = 0;
    try {
      while (written < destination.byteLength) {
        const state = this.state;
        switch (state.kind) {
          case "ended":
            return written;
          case "failed":
            throw state.error;
          case "header":
            this.state = this.readBlock();
            break;
          case "stored":
            if (state.remaining === 0) {
              this.finishBlock(state.final);
              break;
            }
            destination[written++] = this.remember(this.input.readBits(8));
            state.remaining--;
            if (state.remaining === 0) this.finishBlock(state.final);
            break;
          case "compressed": {
            if (state.match !== null) {
              const match = state.match;
              const count = Math.min(match.remaining, destination.byteLength - written);
              const end = written + count;
              while (written < end) {
                const byte = this.window.getUint8((this.windowOffset - match.distance) & this.windowMask);
                destination[written++] = this.remember(byte);
              }
              match.remaining -= count;
              if (match.remaining === 0) state.match = null;
              break;
            }
            const symbol = state.literals.readSymbol(this.input);
            if (symbol < 256) {
              destination[written++] = this.remember(symbol);
            } else if (symbol === 256) {
              this.finishBlock(state.final);
            } else {
              if (symbol > 285) this.input.fail("invalid literal/length code");
              const length = this.readLength(symbol);
              const distance = this.readDistance(state.distances.readSymbol(this.input));
              if (distance > this.historyLength) this.input.fail("distance exceeds available output history");
              state.match = { remaining: length, distance };
            }
            break;
          }
        }
      }
      return written;
    } catch (error) {
      this.state = { kind: "failed", error };
      throw error;
    }
  }

  private remember(byte: number): number {
    this.window.setUint8(this.windowOffset, byte);
    this.windowOffset = (this.windowOffset + 1) & this.windowMask;
    if (this.historyLength < this.window.byteLength) this.historyLength++;
    return byte;
  }

  private finishBlock(final: boolean): void {
    this.state = final ? { kind: "ended" } : { kind: "header" };
  }

  private readBlock(): InflateState {
    const final = this.input.readBits(1) !== 0;
    const type = this.input.readBits(2);
    switch (type) {
      case 0: {
        this.input.alignByte();
        const remaining = this.input.readBits(16);
        const complement = this.input.readBits(16);
        if ((remaining ^ complement) !== 0xffff) this.input.fail("invalid stored block lengths");
        return { kind: "stored", final, remaining };
      }
      case 1: {
        const lengths = new Uint8Array(288);
        lengths.fill(8, 0, 144);
        lengths.fill(9, 144, 256);
        lengths.fill(7, 256, 280);
        lengths.fill(8, 280);
        return {
          kind: "compressed",
          final,
          literals: new HuffmanTree(lengths, this.input, "literal/length"),
          distances: new HuffmanTree(new Uint8Array(32).fill(5), this.input, "distance"),
          match: null,
        };
      }
      case 2:
        return this.readDynamicBlock(final);
      default:
        return this.input.fail("invalid block type");
    }
  }

  private readDynamicBlock(final: boolean): CompressedBlock {
    const literalCount = this.input.readBits(5) + 257;
    const distanceCount = this.input.readBits(5) + 1;
    const codeLengthCount = this.input.readBits(4) + 4;
    // Match inflate_blocks without PKZIP_BUG_WORKAROUND in the pinned source.
    if (literalCount > 286 || distanceCount > 30) this.input.fail("too many length or distance symbols");
    const codeLengths = new Uint8Array(19);
    let codeLengthIndex = 0;
    for (const symbol of CODE_LENGTH_ORDER) {
      if (codeLengthIndex++ === codeLengthCount) break;
      codeLengths[symbol] = this.input.readBits(3);
    }
    const codeTree = new HuffmanTree(codeLengths, this.input, "code-length");
    if (codeTree.empty) this.input.fail("incomplete code-length tree");
    const lengths = new Uint8Array(literalCount + distanceCount);
    const lengthView = new DataView(lengths.buffer);
    let index = 0;
    while (index < lengths.length) {
      const symbol = codeTree.readSymbol(this.input);
      if (symbol < 16) {
        lengths[index++] = symbol;
        continue;
      }
      const repeat = symbol === 18 ? this.input.readBits(7) + 11
        : symbol === 17 ? this.input.readBits(3) + 3 : this.input.readBits(2) + 3;
      if (index + repeat > lengths.length || (symbol === 16 && index === 0)) this.input.fail("invalid bit length repeat");
      const length = symbol === 16 ? lengthView.getUint8(index - 1) : 0;
      lengths.fill(length, index, index + repeat);
      index += repeat;
    }
    const literals = new HuffmanTree(lengths.subarray(0, literalCount), this.input, "literal/length");
    if (literals.empty) this.input.fail("incomplete literal/length tree");
    const distances = new HuffmanTree(lengths.subarray(literalCount), this.input, "distance");
    if (distances.empty && literalCount > 257) this.input.fail("empty distance tree with lengths");
    return { kind: "compressed", final, literals, distances, match: null };
  }

  private readLength(symbol: number): number {
    if (symbol <= 264) return symbol - 254;
    if (symbol === 285) return 258;
    const extra = (symbol - 261) >>> 2;
    return ((4 + ((symbol - 265) & 3)) << extra) + 3 + this.input.readBits(extra);
  }

  private readDistance(symbol: number): number {
    if (symbol > 29) this.input.fail("invalid distance code");
    if (symbol < 4) return symbol + 1;
    const extra = (symbol >>> 1) - 1;
    return ((2 + (symbol & 1)) << extra) + 1 + this.input.readBits(extra);
  }
}

/** Raw DEFLATE with no preset dictionary, wrapper checksum, or output buffering. */
export class RawInflateReader {
  private readonly blocks: InflateBlocks;

  constructor(readByte: () => number | undefined) {
    this.blocks = new InflateBlocks(new BitInput(readByte), 15);
  }

  get ended(): boolean {
    return this.blocks.ended;
  }

  /** Filling the destination does not consume the next symbol or end marker. */
  readInto(destination: Uint8Array): number {
    return this.blocks.readInto(destination);
  }
}

/** The recoverable Z_NEED_DICT outcome, before a subsequent imDICT0 read fails. */
export class ZlibDictionaryRequired extends RawInflateError {
  constructor(bitOffset: number, readonly adler: number) {
    super(bitOffset, "need dictionary");
    this.name = "ZlibDictionaryRequired";
  }
}

type ZlibState =
  | { readonly kind: "header" }
  | { readonly kind: "dictionary"; readonly adler: number }
  | { readonly kind: "blocks" }
  | { readonly kind: "ended" }
  | { readonly kind: "failed"; readonly error: unknown };

/** Pull-input translation of inflate's zlib wrapper. Undefined input is terminal EOF. */
export class ZlibInflateReader {
  private readonly input: BitInput;
  private readonly blocks: InflateBlocks;
  private state: ZlibState = { kind: "header" };
  private checksum = 1;

  constructor(readByte: () => number | undefined, private readonly windowBits = 15) {
    if (!Number.isInteger(windowBits) || windowBits < 8 || windowBits > 15) {
      throw new RangeError("inflate window bits must be between 8 and 15");
    }
    this.input = new BitInput(readByte);
    this.blocks = new InflateBlocks(this.input, windowBits);
  }

  get ended(): boolean {
    return this.state.kind === "ended";
  }

  get dictionaryAdler(): number | null {
    return this.state.kind === "dictionary" ? this.state.adler : null;
  }

  /** Translates disabled inflateSetDictionary; a wrong dictionary permits retry. */
  setDictionary(dictionary: Uint8Array): void {
    if (this.state.kind !== "dictionary") this.input.fail("dictionary not requested");
    if (adler32(1, dictionary) !== this.state.adler) this.input.fail("incorrect dictionary check");
    this.blocks.setDictionary(dictionary);
    this.checksum = 1;
    this.state = { kind: "blocks" };
  }

  readInto(destination: Uint8Array): number {
    if (destination.byteLength === 0) return 0;
    try {
      switch (this.state.kind) {
        case "ended": return 0;
        case "failed": throw this.state.error;
        case "dictionary": return this.input.fail("need dictionary");
        case "header": {
          const method = this.input.readBits(8);
          if ((method & 15) !== 8) this.input.fail("unknown compression method");
          if ((method >>> 4) + 8 > this.windowBits) this.input.fail("invalid window size");
          const flag = this.input.readBits(8);
          if (((method << 8) + flag) % 31 !== 0) this.input.fail("incorrect header check");
          if ((flag & 32) !== 0) {
            const adler = this.readCheck();
            this.state = { kind: "dictionary", adler };
            throw new ZlibDictionaryRequired(this.input.bitOffset, adler);
          }
          this.state = { kind: "blocks" };
          break;
        }
        case "blocks": break;
      }
      const written = this.blocks.readInto(destination);
      this.checksum = adler32(this.checksum, destination.subarray(0, written));
      if (this.blocks.ended) {
        this.input.alignByte();
        if (this.readCheck() !== this.checksum) this.input.fail("incorrect data check");
        this.state = { kind: "ended" };
      }
      return written;
    } catch (error) {
      if (!(error instanceof ZlibDictionaryRequired && this.state.kind === "dictionary")) {
        this.state = { kind: "failed", error };
      }
      throw error;
    }
  }

  private readCheck(): number {
    let check = 0;
    for (let byte = 0; byte < 4; byte++) check = (check << 8) | this.input.readBits(8);
    return check >>> 0;
  }
}
