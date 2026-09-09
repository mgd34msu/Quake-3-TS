// Derived from RSA Data Security, Inc.'s MD4 Message-Digest Algorithm as used
// by id Software's code/qcommon/md4.c.
//
// Copyright (C) 1990-1992 RSA Data Security, Inc. All rights reserved.
//
// License to copy and use this software is granted provided that it is
// identified as the "RSA Data Security, Inc. MD4 Message-Digest Algorithm" in
// all material mentioning or referencing this software or this function.
// License is also granted to make and use derivative works provided that such
// works are identified as "derived from the RSA Data Security, Inc. MD4
// Message-Digest Algorithm" in all material mentioning or referencing the
// derived work. RSA Data Security, Inc. makes no representations concerning
// either the merchantability of this software or the suitability of this
// software for any particular purpose. It is provided "as is" without express
// or implied warranty of any kind.

interface Md4State {
  a: number;
  b: number;
  c: number;
  d: number;
}

function rotateLeft(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function f(x: number, y: number, z: number): number {
  return ((x & y) | (~x & z)) >>> 0;
}

function g(x: number, y: number, z: number): number {
  return ((x & y) | (x & z) | (y & z)) >>> 0;
}

function h(x: number, y: number, z: number): number {
  return (x ^ y ^ z) >>> 0;
}

function ff(a: number, b: number, c: number, d: number, x: number, shift: number): number {
  return rotateLeft((a + f(b, c, d) + x) >>> 0, shift);
}

function gg(a: number, b: number, c: number, d: number, x: number, shift: number): number {
  return rotateLeft((a + g(b, c, d) + x + 0x5a827999) >>> 0, shift);
}

function hh(a: number, b: number, c: number, d: number, x: number, shift: number): number {
  return rotateLeft((a + h(b, c, d) + x + 0x6ed9eba1) >>> 0, shift);
}

function transform(state: Md4State, block: Uint8Array, offset: number): void {
  if (offset < 0 || offset > block.byteLength - 64) throw new RangeError("MD4 block is truncated");
  const view = new DataView(block.buffer, block.byteOffset + offset, 64);
  const x0 = view.getUint32(0, true);
  const x1 = view.getUint32(4, true);
  const x2 = view.getUint32(8, true);
  const x3 = view.getUint32(12, true);
  const x4 = view.getUint32(16, true);
  const x5 = view.getUint32(20, true);
  const x6 = view.getUint32(24, true);
  const x7 = view.getUint32(28, true);
  const x8 = view.getUint32(32, true);
  const x9 = view.getUint32(36, true);
  const x10 = view.getUint32(40, true);
  const x11 = view.getUint32(44, true);
  const x12 = view.getUint32(48, true);
  const x13 = view.getUint32(52, true);
  const x14 = view.getUint32(56, true);
  const x15 = view.getUint32(60, true);
  let a = state.a;
  let b = state.b;
  let c = state.c;
  let d = state.d;

  a = ff(a, b, c, d, x0, 3);
  d = ff(d, a, b, c, x1, 7);
  c = ff(c, d, a, b, x2, 11);
  b = ff(b, c, d, a, x3, 19);
  a = ff(a, b, c, d, x4, 3);
  d = ff(d, a, b, c, x5, 7);
  c = ff(c, d, a, b, x6, 11);
  b = ff(b, c, d, a, x7, 19);
  a = ff(a, b, c, d, x8, 3);
  d = ff(d, a, b, c, x9, 7);
  c = ff(c, d, a, b, x10, 11);
  b = ff(b, c, d, a, x11, 19);
  a = ff(a, b, c, d, x12, 3);
  d = ff(d, a, b, c, x13, 7);
  c = ff(c, d, a, b, x14, 11);
  b = ff(b, c, d, a, x15, 19);

  a = gg(a, b, c, d, x0, 3);
  d = gg(d, a, b, c, x4, 5);
  c = gg(c, d, a, b, x8, 9);
  b = gg(b, c, d, a, x12, 13);
  a = gg(a, b, c, d, x1, 3);
  d = gg(d, a, b, c, x5, 5);
  c = gg(c, d, a, b, x9, 9);
  b = gg(b, c, d, a, x13, 13);
  a = gg(a, b, c, d, x2, 3);
  d = gg(d, a, b, c, x6, 5);
  c = gg(c, d, a, b, x10, 9);
  b = gg(b, c, d, a, x14, 13);
  a = gg(a, b, c, d, x3, 3);
  d = gg(d, a, b, c, x7, 5);
  c = gg(c, d, a, b, x11, 9);
  b = gg(b, c, d, a, x15, 13);

  a = hh(a, b, c, d, x0, 3);
  d = hh(d, a, b, c, x8, 9);
  c = hh(c, d, a, b, x4, 11);
  b = hh(b, c, d, a, x12, 15);
  a = hh(a, b, c, d, x2, 3);
  d = hh(d, a, b, c, x10, 9);
  c = hh(c, d, a, b, x6, 11);
  b = hh(b, c, d, a, x14, 15);
  a = hh(a, b, c, d, x1, 3);
  d = hh(d, a, b, c, x9, 9);
  c = hh(c, d, a, b, x5, 11);
  b = hh(b, c, d, a, x13, 15);
  a = hh(a, b, c, d, x3, 3);
  d = hh(d, a, b, c, x11, 9);
  c = hh(c, d, a, b, x7, 11);
  b = hh(b, c, d, a, x15, 15);

  state.a = (state.a + a) >>> 0;
  state.b = (state.b + b) >>> 0;
  state.c = (state.c + c) >>> 0;
  state.d = (state.d + d) >>> 0;
}

const PADDING = new Uint8Array(64);
PADDING[0] = 0x80;

export class Md4Context {
  readonly state: Md4State = {
    a: 0x67452301,
    b: 0xefcdab89,
    c: 0x98badcfe,
    d: 0x10325476,
  };
  readonly count: [number, number] = [0, 0];
  readonly buffer = new Uint8Array(64);

  initialize(): void {
    this.count[0] = 0;
    this.count[1] = 0;
    this.state.a = 0x67452301;
    this.state.b = 0xefcdab89;
    this.state.c = 0x98badcfe;
    this.state.d = 0x10325476;
  }

  update(data: Uint8Array): void {
    if (data.byteLength > 0xffffffff) throw new RangeError("MD4 update length exceeds unsigned int");
    let index = (this.count[0] >>> 3) & 63;
    const addedBits = (data.byteLength << 3) >>> 0;
    this.count[0] = (this.count[0] + addedBits) >>> 0;
    this.count[1] = (this.count[1] + (this.count[0] < addedBits ? 1 : 0) + (data.byteLength >>> 29)) >>> 0;
    const partLength = 64 - index;
    let offset = 0;
    if (data.byteLength >= partLength) {
      this.buffer.set(data.subarray(0, partLength), index);
      transform(this.state, this.buffer, 0);
      for (offset = partLength; offset + 63 < data.byteLength; offset += 64) transform(this.state, data, offset);
      index = 0;
    }
    this.buffer.set(data.subarray(offset), index);
  }

  final(): Uint8Array {
    const bits = new Uint8Array(8), countView = new DataView(bits.buffer);
    countView.setUint32(0, this.count[0], true);
    countView.setUint32(4, this.count[1], true);
    const index = (this.count[0] >>> 3) & 63;
    this.update(PADDING.subarray(0, index < 56 ? 56 - index : 120 - index));
    this.update(bits);
    const digest = new Uint8Array(16), digestView = new DataView(digest.buffer);
    digestView.setUint32(0, this.state.a, true);
    digestView.setUint32(4, this.state.b, true);
    digestView.setUint32(8, this.state.c, true);
    digestView.setUint32(12, this.state.d, true);
    this.state.a = 0; this.state.b = 0; this.state.c = 0; this.state.d = 0;
    this.count[0] = 0; this.count[1] = 0;
    this.buffer.fill(0);
    return digest;
  }
}

export function md4(data: Uint8Array): Uint8Array {
  const context = new Md4Context();
  context.update(data);
  return context.final();
}

function foldDigest(digest: Uint8Array): number {
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  return (view.getUint32(0, true) ^ view.getUint32(4, true)
    ^ view.getUint32(8, true) ^ view.getUint32(12, true)) >>> 0;
}

export function blockChecksum(data: Uint8Array): number { return foldDigest(md4(data)); }

function checksumKeyBytes(key: number): Uint8Array {
  if (!Number.isInteger(key) || key < -0x80000000 || key > 0xffffffff) {
    throw new RangeError(`Checksum key ${key} is outside signed-int32/uint32 range`);
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, key >>> 0, true);
  return bytes;
}

export function blockChecksumKey(data: Uint8Array, key: number): number {
  const context = new Md4Context();
  context.update(checksumKeyBytes(key));
  context.update(data);
  return foldDigest(context.final());
}
