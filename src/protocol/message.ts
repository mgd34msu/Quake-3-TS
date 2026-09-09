// Port of id Software's code/qcommon/msg.c, GPL-2.0-or-later.
// Copyright (C) 1999-2005 Id Software, Inc.
import { BinaryError } from "../core/binary.ts";
import { bitsToFloat32, float32ToBits } from "../core/numeric.ts";
import { createMessageHuffman } from "./huffman.ts";

export type MessageMode = "bitstream" | "oob";
export const MAX_MESSAGE_LENGTH = 16384;

/** Null counters identify undefined native signed arithmetic, not a wrapped result. */
export class SourceMessageState {
  oldsize: number | null = 0;
  newsize: number | null = 0;
  overflows: number | null = 0;

  constructor(readonly print: (text: string) => void) {}

  addOldsize(bits: number): void { this.oldsize = this.add(this.oldsize, bits); }
  addNewsize(bytes: number): void { this.newsize = this.add(this.newsize, bytes); }
  checkOverflow(value: number, bits: number): void {
    if (bits === 32) return;
    if (bits < 0 || bits === 31) { this.overflows = null; return; }
    if (value > 2 ** bits - 1 || value < 0) this.overflows = this.add(this.overflows, 1);
  }
  private add(value: number | null, increment: number): number | null {
    if (value === null) return null;
    const result = value + increment;
    return Number.isInteger(result) && result >= -0x80000000 && result <= 0x7fffffff ? result : null;
  }
}

function widthOf(bits: number, mode: MessageMode): number {
  if (!Number.isInteger(bits) || bits === 0 || bits < -31 || bits > 32) throw new RangeError("Invalid message bit width");
  const width = Math.abs(bits);
  if (mode === "oob" && width !== 8 && width !== 16 && width !== 32) throw new RangeError("OOB messages require 8, 16 or 32 bits");
  return width;
}

function angleInteger(value: number, scale: number): number {
  const scaled = Math.fround(Math.fround(Math.fround(value) * scale) / 360);
  if (!Number.isFinite(scaled) || scaled < -2147483648 || scaled >= 2147483648) {
    throw new RangeError("Undefined native message angle float-to-int conversion");
  }
  return Math.trunc(scaled);
}

export class MessageWriter {
  private readonly buffer: Uint8Array;
  private readonly view: DataView;
  private position = 0;
  private size = 0;
  overflowed = false;

  constructor(private encoding: MessageMode = "bitstream", readonly capacity = MAX_MESSAGE_LENGTH,
    readonly sourceState: SourceMessageState | null = null) {
    if (!Number.isInteger(capacity) || capacity < 0 || capacity > MAX_MESSAGE_LENGTH) throw new RangeError("Invalid message capacity");
    this.buffer = new Uint8Array(capacity);
    this.view = new DataView(this.buffer.buffer);
  }

  get bitPosition(): number { return this.position; }
  get mode(): MessageMode { return this.encoding; }
  get byteLength(): number { return this.size; }
  toBytes(): Uint8Array { return this.buffer.slice(0, this.size); }
  /** MSG_Clear retains storage and mode, resetting only cursor and overflow state. */
  clear(): void { this.position = 0; this.size = 0; this.overflowed = false; }
  bitstream(): void { this.encoding = "bitstream"; }
  copy(): MessageWriter {
    const result = new MessageWriter(this.mode, this.capacity, this.sourceState);
    result.buffer.set(this.buffer.subarray(0, this.size));
    result.position = this.position;
    result.size = this.size;
    result.overflowed = this.overflowed;
    return result;
  }

  writeBits(value: number, bits: number): void {
    this.sourceState?.addOldsize(bits);
    // MSG_WriteBits reserves four bytes before each scalar write.
    if (this.capacity - this.size < 4) {
      this.overflowed = true;
      return;
    }
    const width = widthOf(bits, "bitstream");
    if (!Number.isInteger(value)) throw new RangeError("Message integer must be integral");
    this.sourceState?.checkOverflow(value, bits);
    if (this.mode === "oob") {
      widthOf(bits, this.mode);
      if (width === 8) this.view.setUint8(this.size, value);
      else if (width === 16) this.view.setUint16(this.size, value, true);
      else this.view.setInt32(this.size, value, true);
      this.size += width >>> 3;
      // The original OOB writer advances bit by eight for a long; readers advance by 32.
      this.position += width === 32 ? 8 : width;
      return;
    }
    let remaining = value >>> 0;
    const encoded: number[] = [];
    const putBit = (bit: number): void => { encoded.push(bit); };
    for (let i = 0; i < (width & 7); i++) {
      putBit(remaining & 1);
      remaining >>>= 1;
    }
    const codec = createMessageHuffman();
    for (let i = width & 7; i < width; i += 8) {
      codec.encodeSymbol(remaining & 255, putBit);
      remaining >>>= 8;
    }
    const size = ((this.position + encoded.length) >>> 3) + 1;
    if (size > this.capacity) {
      this.overflowed = true;
      return;
    }
    for (const bit of encoded) {
      const offset = this.position >>> 3;
      if ((this.position & 7) === 0) this.view.setUint8(offset, 0);
      this.view.setUint8(offset, this.view.getUint8(offset) | (bit << (this.position & 7)));
      this.position++;
    }
    this.size = size;
  }

  writeByte(value: number): void { this.writeBits(value, 8); }
  writeChar(value: number): void { this.writeBits(value, 8); }
  writeShort(value: number): void { this.writeBits(value, 16); }
  writeLong(value: number): void { this.writeBits(value, 32); }
  writeFloat(value: number): void {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    this.writeLong(view.getInt32(0, true));
  }
  writeData(data: Uint8Array): void { for (const byte of data) this.writeByte(byte); }

  writeString(value: string | null): void { this.writeText(value, 1024); }
  writeBigString(value: string | null): void { this.writeText(value, 8192); }
  private writeText(value: string | null, limit: number): void {
    if (value === null) { this.writeByte(0); return; }
    const nul = value.indexOf("\0");
    const length = nul === -1 ? value.length : nul;
    if (length < limit) {
      for (let i = 0; i < length; i++) {
        const char = value.charCodeAt(i);
        this.writeByte(char > 127 ? 46 : char);
      }
    } else this.sourceState?.print(limit === 1024 ? "MSG_WriteString: MAX_STRING_CHARS" : "MSG_WriteString: BIG_INFO_STRING");
    this.writeByte(0);
  }

  writeAngle(value: number): void { this.writeByte(angleInteger(value, 256) & 255); }
  writeAngle16(value: number): void { this.writeShort(angleInteger(value, 65536) & 65535); }

  writeDelta(previous: number, value: number, bits: number): void {
    this.writeBits(previous === value ? 0 : 1, 1);
    if (previous !== value) this.writeBits(value, bits);
  }

  writeDeltaKey(key: number, previous: number, value: number, bits: number): void {
    this.writeBits(previous === value ? 0 : 1, 1);
    if (previous !== value) this.writeBits(value ^ key, bits);
  }

  writeDeltaFloat(previous: number, value: number): void {
    const oldFloat = Math.fround(previous), newFloat = Math.fround(value);
    this.writeBits(oldFloat === newFloat ? 0 : 1, 1);
    if (oldFloat !== newFloat) this.writeBits(float32ToBits(newFloat), 32);
  }

  writeDeltaKeyFloat(key: number, previous: number, value: number): void {
    const oldFloat = Math.fround(previous), newFloat = Math.fround(value);
    this.writeBits(oldFloat === newFloat ? 0 : 1, 1);
    if (oldFloat !== newFloat) this.writeBits(float32ToBits(newFloat) ^ key, 32);
  }
}

export class MessageReader {
  private readonly view: DataView;
  private position = 0;
  private count = 0;
  constructor(readonly data: Uint8Array, private encoding: MessageMode = "bitstream", readonly source = "<message>") {
    if (data.length > MAX_MESSAGE_LENGTH) throw new BinaryError(source, 0, "message exceeds maximum length");
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get bitPosition(): number { return this.position; }
  get readCount(): number { return this.count; }
  get mode(): MessageMode { return this.encoding; }
  bitstream(): void { this.encoding = "bitstream"; }
  beginReading(): void { this.position = 0; this.count = 0; this.encoding = "bitstream"; }
  beginReadingOob(): void { this.position = 0; this.count = 0; this.encoding = "oob"; }
  copy(): MessageReader {
    const result = new MessageReader(new Uint8Array(this.data), this.mode, this.source);
    result.position = this.position;
    result.count = this.count;
    return result;
  }

  private getBit = (): number => {
    if (this.position >= this.data.length * 8) throw new BinaryError(this.source, this.position >>> 3, "truncated message bits");
    const bit = (this.view.getUint8(this.position >>> 3) >>> (this.position & 7)) & 1;
    this.position++;
    return bit;
  };

  readBits(bits: number): number {
    const width = bits === 0 && this.mode === "bitstream" ? 0 : widthOf(bits, this.mode);
    let value = 0;
    let signWidth = width;
    if (this.mode === "oob") {
      if (this.count + (width >>> 3) > this.data.length) throw new BinaryError(this.source, this.count, "truncated OOB integer");
      if (width === 8) value = this.view.getUint8(this.count);
      else if (width === 16) value = this.view.getUint16(this.count, true);
      else value = this.view.getInt32(this.count, true);
      this.count += width >>> 3;
      this.position += width;
    } else {
      const lowBits = width & 7;
      for (let i = 0; i < lowBits; i++) value |= this.getBit() << i;
      const codec = createMessageHuffman();
      for (let i = lowBits; i < width; i += 8) value |= codec.decodeSymbol(this.getBit) << i;
      this.count = (this.position >>> 3) + 1;
      // MSG_ReadBits mutates bits after raw low bits, including for sign extension.
      signWidth -= lowBits;
    }
    if (bits < 0 && (value & (1 << (signWidth - 1))) !== 0) value |= -1 ^ ((1 << signWidth) - 1);
    return value;
  }

  /** Scalar readers replace a fully decoded value when the source readcount passed cursize. */
  private readScalar(bits: number): number {
    const value = this.readBits(bits);
    return this.count > this.data.length ? -1 : value;
  }
  readByte(): number { const value = this.readScalar(8); return value === -1 ? -1 : value & 255; }
  readChar(): number { return (this.readScalar(8) << 24) >> 24; }
  readShort(): number { return (this.readScalar(16) << 16) >> 16; }
  readLong(): number { return this.readScalar(32); }
  readFloat(): number {
    const value = this.readBits(32);
    if (this.count > this.data.length) return -1;
    const view = new DataView(new ArrayBuffer(4));
    view.setInt32(0, value, true);
    return view.getFloat32(0, true);
  }
  readData(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0 || length > MAX_MESSAGE_LENGTH) throw new RangeError("Invalid message data length");
    const data = new Uint8Array(length);
    for (let i = 0; i < length; i++) data[i] = this.readByte();
    return data;
  }
  readString(): string { return this.readText(1024, false, true); }
  readBigString(): string { return this.readText(8192, false, false); }
  readStringLine(): string { return this.readText(1024, true, false); }
  private readText(limit: number, newline: boolean, ascii: boolean): string {
    let text = "";
    for (let i = 0; i < limit - 1; i++) {
      const char = this.readByte();
      if (char === -1 || char === 0 || (newline && char === 10)) break;
      text += String.fromCharCode(char === 37 || (ascii && char > 127) ? 46 : char);
    }
    return text;
  }
  readAngle16(): number { return this.readShort() * (360 / 65536); }

  readDelta(previous: number, bits: number): number {
    return this.readBits(1) === 0 ? previous : this.readBits(bits);
  }

  readDeltaKey(key: number, previous: number, bits: number): number {
    if (this.readBits(1) === 0) return previous;
    const value = this.readBits(bits);
    // MSG_ReadDeltaKey indexes kbitmask by bits, retaining one extra key bit.
    if (!Number.isInteger(bits) || bits < 0 || bits >= 32) throw new RangeError("Keyed delta mask index is outside kbitmask");
    return value ^ (key & (0xffffffff >>> (31 - bits)));
  }

  readDeltaFloat(previous: number): number {
    return this.readBits(1) === 0 ? Math.fround(previous) : bitsToFloat32(this.readBits(32));
  }

  readDeltaKeyFloat(key: number, previous: number): number {
    return this.readBits(1) === 0 ? Math.fround(previous) : bitsToFloat32(this.readBits(32) ^ key);
  }
}

export interface WireUserCommand {
  readonly serverTime: number;
  readonly angles: readonly [number, number, number];
  readonly forwardmove: number;
  readonly rightmove: number;
  readonly upmove: number;
  readonly buttons: number;
  readonly weapon: number;
}

function commandFields(command: WireUserCommand): readonly number[] {
  return [...command.angles, command.forwardmove, command.rightmove, command.upmove, command.buttons, command.weapon];
}

const COMMAND_WIDTHS = [16, 16, 16, 8, 8, 8, 16, 8];

/** null key selects MSG_WriteDeltaUsercmd; a number selects MSG_WriteDeltaUsercmdKey. */
export function writeDeltaUserCommand(writer: MessageWriter, from: WireUserCommand, to: WireUserCommand, key: number | null = null): void {
  const difference = (to.serverTime - from.serverTime) | 0;
  writer.writeBits(difference < 256 ? 1 : 0, 1);
  writer.writeBits(difference < 256 ? difference : to.serverTime, difference < 256 ? 8 : 32);
  const previous = commandFields(from);
  const next = commandFields(to);
  if (key !== null) {
    const changed = previous.some((value, i) => value !== next[i]);
    writer.writeBits(changed ? 1 : 0, 1);
    if (!changed) { writer.sourceState?.addOldsize(7); return; }
  }
  for (const [i, width] of COMMAND_WIDTHS.entries()) {
    const oldValue = previous[i];
    const value = next[i];
    if (oldValue === undefined || value === undefined) throw new Error("Invalid user command shape");
    if (key === null) writer.writeDelta(oldValue, value, width);
    else writer.writeDeltaKey(key ^ to.serverTime, oldValue, value, width);
  }
}

export function readDeltaUserCommand(reader: MessageReader, from: WireUserCommand, key: number | null = null): WireUserCommand {
  const serverTime = reader.readBits(1) ? (from.serverTime + reader.readBits(8)) | 0 : reader.readBits(32);
  if (key !== null && reader.readBits(1) === 0) return { ...from, serverTime, angles: [...from.angles] };
  const delta = (previous: number, width: number): number => {
    return key === null ? reader.readDelta(previous, width) : reader.readDeltaKey(key ^ serverTime, previous, width);
  };
  const angles: [number, number, number] = [delta(from.angles[0], 16), delta(from.angles[1], 16), delta(from.angles[2], 16)];
  const forwardmove = (delta(from.forwardmove, 8) << 24) >> 24;
  const rightmove = (delta(from.rightmove, 8) << 24) >> 24;
  const upmove = (delta(from.upmove, 8) << 24) >> 24;
  const buttons = delta(from.buttons, 16);
  const weapon = delta(from.weapon, 8) & 255;
  return { serverTime, angles, forwardmove, rightmove, upmove, buttons, weapon };
}
