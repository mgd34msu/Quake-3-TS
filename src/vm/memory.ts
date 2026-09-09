/*
 * VM_ArgPtr from qcommon/vm.c and Q_strncpyz from game/q_shared.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { qStrncpyz } from "../core/source-strings.ts";

/** Borrows an interpreter allocation; pointer masking applies only to its start. */
export class QvmMemory {
  constructor(readonly bytes: Uint8Array) {
    const length = bytes.byteLength;
    if (length === 0 || length > 0x40000000 || (length & (length - 1)) !== 0) {
      throw new RangeError("QVM memory allocation must be a nonzero power of two at most 2^30 bytes");
    }
  }

  pointer(word: number): Uint8Array | null {
    if (!Number.isInteger(word) || word < -0x80000000 || word > 0x7fffffff) {
      throw new RangeError("QVM pointer must be a signed 32-bit word");
    }
    return word === 0 ? null : this.bytes.subarray(word & (this.bytes.byteLength - 1));
  }

  span(word: number, length: number, relativeOffset = 0): Uint8Array {
    const pointer = this.pointer(word);
    if (pointer === null) throw new RangeError("QVM memory span requires a nonnull pointer");
    const start = pointer.byteOffset - this.bytes.byteOffset + relativeOffset;
    if (!Number.isSafeInteger(relativeOffset) || !Number.isSafeInteger(length) || length < 0
      || start < 0 || start > this.bytes.byteLength || length > this.bytes.byteLength - start) {
      throw new RangeError("QVM memory span exceeds allocation or has an invalid length");
    }
    return this.bytes.subarray(start, start + length);
  }

  view(word: number, length: number, relativeOffset = 0): DataView {
    const span = this.span(word, length, relativeOffset);
    return new DataView(span.buffer, span.byteOffset, span.byteLength);
  }

  readString(word: number): string {
    const pointer = this.pointer(word);
    if (pointer === null) throw new RangeError("QVM string requires a nonnull pointer");
    const terminator = pointer.indexOf(0);
    if (terminator < 0) throw new RangeError("QVM string has no terminator before the allocation ends");
    let text = "";
    for (const byte of pointer.subarray(0, terminator)) text += String.fromCharCode(byte);
    return text;
  }

  /** Q_strncpyz pads within capacity and leaves bytes beyond capacity untouched. */
  writeString(word: number, text: string, capacity: number): void {
    const pointer = this.pointer(word);
    if (pointer !== null && (!Number.isInteger(capacity) || capacity > pointer.length)) {
      throw new RangeError("Q_strncpyz destination exceeds QVM allocation");
    }
    qStrncpyz(pointer, text, capacity);
  }

  /** Raw strncpy(size - 1) plus NUL has no source Com_Error for invalid pointers or sizes. */
  writeBoundedString(word: number, text: string, capacity: number): void {
    const pointer = this.pointer(word);
    if (pointer === null || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > pointer.length) {
      throw new RangeError("Bounded string copy exceeds QVM allocation");
    }
    qStrncpyz(pointer, text, capacity);
  }
}
