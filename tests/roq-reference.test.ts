import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { RoqDecoder } from "../src/cinematic/roq.ts";

function chunk(id: number, payload: readonly number[], flags = 0): Uint8Array {
  const writer = new BinaryWriter(payload.length + 8);
  writer.u16(id);
  writer.u32(payload.length);
  writer.u16(flags);
  writer.bytes(Uint8Array.from(payload));
  return writer.finish();
}

function movie(chunks: readonly Uint8Array[]): Uint8Array {
  const writer = new BinaryWriter(chunks.reduce((size, data) => size + data.length, 8));
  writer.u16(0x1084);
  writer.u32(0xffffffff);
  writer.u16(30);
  for (const data of chunks) writer.bytes(data);
  return writer.finish();
}

function frame(decoder: RoqDecoder): Uint8Array {
  const event = decoder.next();
  if (event.kind !== "frame") throw new Error(`Expected frame, received ${event.kind}`);
  return event.rgba;
}

function pair(bytes: Uint8Array, x: number, y: number, width: number): Uint8Array {
  return bytes.subarray((y * width + x) * 4, (y * width + x + 2) * 4);
}

test("RoQ copies signaling-NaN-shaped RGBA bytes without floating-point pixel corruption", () => {
  // mpteam1.roq frame590, book2[212]: Y=[236,236,234,235], U=131, V=123.
  // Its bottom RGBA pair is 0xfff2eee6fff1ede5, a negative signaling NaN as a double.
  // cl_cin.c's double-pointer copies are nonportable: the GCC16 i386 reference uses
  // x87 fldl/fstpl on a blitter's last pair, changing blue242 to250 by setting bit51.
  // The canonical decoder preserves RGBA bytes, independent of FP instruction choice.
  const info = chunk(0x1001, [8, 0, 8, 0, 8, 0, 4, 0]);
  const book = chunk(0x1002, [236, 236, 234, 235, 131, 123, 0, 0, 0, 0], 0x0101);
  const split = chunk(0x1011, [0x80, 0xfa, 0, 0, 0, 0, 0, 0, 0]);
  const motion4 = chunk(0x1011, [0x40, 0xd5, 0x88, 0x88, 0x88, 0x88]);
  const whole8 = chunk(0x1011, [0, 0x80, 0]);
  const motion8 = chunk(0x1011, [0, 0x40, 0x88]);
  const decoder = new RoqDecoder(movie([info, book, split, motion4, whole8, motion8]));
  const expected = new Uint8Array([229, 237, 241, 255, 230, 238, 242, 255]);
  const packed = new DataView(expected.buffer);
  expect(Number.isNaN(packed.getFloat64(0, true))).toBe(true);
  expect(packed.getBigUint64(0, true)).toBe(0xfff2eee6fff1ede5n);
  expect(packed.getBigUint64(0, true) | (1n << 51n)).toBe(0xfffaeee6fff1ede5n);
  const first = frame(decoder);
  expect(pair(first, 0, 1, 8)).toEqual(expected); // blit2_32 final pair.
  expect(pair(first, 6, 3, 8)).toEqual(expected); // blit4_32 final pair.
  const moved4 = frame(decoder);
  expect(moved4).toEqual(first);
  const expanded = frame(decoder);
  const expectedExpanded = new Uint8Array([230, 238, 242, 255, 230, 238, 242, 255]);
  expect(pair(expanded, 6, 7, 8)).toEqual(expectedExpanded); // blit8_32 final pair.
  expect(frame(decoder)).toEqual(expanded);
});

const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const nativeCapture = process.env["Q3_ROQ_REFERENCE"]
  ?? "/tmp/quake3-graphics-reference-RTpxku/runtime/cinematic/handle-0.rgba";

test.skipIf(!existsSync(join(retailRoot, "missionpack/pak0.pk3")) || !existsSync(nativeCapture))(
  "full native frame591 comparison isolates the two proven i386 x87 quiet-bit differences",
  async () => {
    const reference = new Uint8Array(await Bun.file(nativeCapture).arrayBuffer());
    expect(new Bun.CryptoHasher("sha256").update(reference).digest("hex"))
      .toBe("1f11555ea1d2dc17b8c32ecfecc831ee0bb51d0d9046a935b00f01c1bbf0bbdb");
    const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product: "missionpack" });
    const data = await vfs.read("video/mpteam1.roq");
    expect(new Bun.CryptoHasher("sha256").update(data).digest("hex"))
      .toBe("b58629c998426f5c9d7c8008db65a84ca6e5b276266faa27e32a9f97ad2fc903");
    // Independent byte offsets identify the exact source entries and VQ index bytes.
    expect(Array.from(data.subarray(2523354, 2523360))).toEqual([236, 236, 234, 235, 131, 123]);
    expect(Array.from(data.subarray(2523952, 2523956))).toEqual([207, 207, 201, 212]);
    expect(data[2524912]).toBe(212);
    const decoder = new RoqDecoder(data, "video/mpteam1.roq");
    let decoded = frame(decoder);
    for (let index = 1; index <= 591; index++) decoded = frame(decoder);
    expect(decoded.length).toBe(reference.length);
    const differences: { offset: number; decoded: number; reference: number }[] = [];
    const native = new DataView(reference.buffer);
    const portable = new DataView(decoded.buffer);
    for (let offset = 0; offset < decoded.length; offset++) {
      const actual = portable.getUint8(offset);
      const expected = native.getUint8(offset);
      if (actual !== expected) differences.push({ offset, decoded: actual, reference: expected });
    }
    expect(differences).toEqual([
      { offset: 120286, decoded: 242, reference: 250 },
      { offset: 138702, decoded: 242, reference: 250 },
    ]);
    // GDB observations before/after native frame590 blit2_32 and blit4_32 establish
    // these exact words. Frame591's FCC0x88 copies both affected blocks in place.
    for (const offset of [120280, 138696]) {
      expect(portable.getBigUint64(offset, true)).toBe(0xfff2eee6fff1ede5n);
      expect(native.getBigUint64(offset, true)).toBe(0xfffaeee6fff1ede5n);
    }
  },
);

const sseCapture = process.env["Q3_ROQ_SSE_REFERENCE"]
  ?? "/tmp/quake3-graphics-reference-RTpxku/runtime/roq-differential/sse2-retained.rgba";

test.skipIf(!existsSync(join(retailRoot, "missionpack/pak0.pk3")) || !existsSync(sseCapture))(
  "unchanged native source compiled with SSE2 matches complete frame591 byte for byte",
  async () => {
    // Same native scheduling oracle and flags, adding only -mfpmath=sse -msse2.
    // Its blitters use movsd for every pair, including the last, and preserve payloads.
    const reference = new Uint8Array(await Bun.file(sseCapture).arrayBuffer());
    expect(new Bun.CryptoHasher("sha256").update(reference).digest("hex"))
      .toBe("c27ca6ed725687883c6499b5dbf6fa7efcccb761897a12f32819152162e245e1");
    const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product: "missionpack" });
    const data = await vfs.read("video/mpteam1.roq");
    const decoder = new RoqDecoder(data, "video/mpteam1.roq", { endPolicy: "cinematic-lookahead" });
    let decoded = frame(decoder);
    for (let index = 1; index <= 591; index++) decoded = frame(decoder);
    expect(decoded).toEqual(reference);
    expect(decoder.next()).toEqual({ kind: "end" });
  },
);
