// RllSetupTable and RllDecode functions from id Software code/client/cl_cin.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

function byte(input: Uint8Array, index: number): number {
  const value = input[index];
  if (value === undefined) throw new RangeError("RoQ audio input is truncated");
  return value;
}

function write(output: Int16Array, index: number, value: number): void {
  if (index >= output.length) throw new RangeError("RoQ audio output is truncated");
  output[index] = value;
}

function parameters(size: number, flag: number): void {
  if (!Number.isInteger(size) || size < 0 || size > 0xffffffff) throw new RangeError("RoQ audio size requires an unsigned int");
  if (!Number.isInteger(flag) || flag < 0 || flag > 65535) throw new RangeError("RoQ audio flag requires an unsigned short");
}

/** The source's owned square table, including zero state before initRoQ. */
export class SourceRoqAudio {
  private readonly square = new Int16Array(256);

  setupTable(): void {
    for (let index = 0; index < 128; index++) {
      this.square[index] = index * index;
      this.square[index + 128] = -index * index;
    }
  }

  private delta(value: number): number {
    const result = this.square[value];
    if (result === undefined) throw new RangeError("RoQ square table index is invalid");
    return result;
  }

  decodeMonoToMono(input: Uint8Array, output: Int16Array, size: number, signedOutput: boolean, flag: number): number {
    parameters(size, flag);
    let previous = signedOutput ? flag - 0x8000 : flag;
    for (let index = 0; index < size; index++) {
      previous = ((previous + this.delta(byte(input, index))) << 16) >> 16;
      write(output, index, previous);
    }
    return size;
  }

  decodeMonoToStereo(input: Uint8Array, output: Int16Array, size: number, signedOutput: boolean, flag: number): number {
    parameters(size, flag);
    let previous = signedOutput ? flag - 0x8000 : flag;
    for (let index = 0; index < size; index++) {
      previous = ((previous + this.delta(byte(input, index))) << 16) >> 16;
      // The C chained assignment writes the right-hand sample first.
      write(output, index * 2 + 1, previous);
      write(output, index * 2, previous);
    }
    return size;
  }

  decodeStereoToStereo(input: Uint8Array, output: Int16Array, size: number, signedOutput: boolean, flag: number): number {
    parameters(size, flag);
    let left = (flag & 0xff00) - (signedOutput ? 0x8000 : 0);
    let right = ((flag & 0xff) << 8) - (signedOutput ? 0x8000 : 0);
    for (let index = 0; index < size; index += 2) {
      left = ((left + this.delta(byte(input, index))) << 16) >> 16;
      right = ((right + this.delta(byte(input, index + 1))) << 16) >> 16;
      write(output, index, left);
      write(output, index + 1, right);
    }
    return size >>> 1;
  }

  /** Source size counts output mono samples here, and consumes twice that many input bytes. */
  decodeStereoToMono(input: Uint8Array, output: Int16Array, size: number, signedOutput: boolean, flag: number): number {
    parameters(size, flag);
    let left = (flag & 0xff00) - (signedOutput ? 0x8000 : 0);
    let right = ((flag & 0xff) << 8) - (signedOutput ? 0x8000 : 0);
    for (let index = 0; index < size; index++) {
      left = (left + this.delta(byte(input, index * 2))) | 0;
      right = (right + this.delta(byte(input, index * 2 + 1))) | 0;
      write(output, index, Math.trunc(((left + right) | 0) / 2));
    }
    return size;
  }
}
