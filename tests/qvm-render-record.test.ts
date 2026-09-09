import { describe, expect, test } from "bun:test";
import type { Md3Tag } from "../src/assets/md3.ts";
import { BinaryError } from "../src/core/binary.ts";
import type { SourceRefEntity } from "../src/render/ref-entity.ts";
import { copyRefdef } from "../src/render/refdef.ts";
import {
  QVM_ORIENTATION_BYTES, QVM_POLY_VERTEX_BYTES, QVM_REF_ENTITY_BYTES, QVM_REFDEF_BYTES,
  readQvmPolyVertices, readQvmRefdef, readQvmRefEntity, writeQvmOrientation,
} from "../src/vm/render-record.ts";

function bytes(words: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(words.trim().split(/\s+/).flatMap(word => [
    Number.parseInt(word.slice(0, 2), 16), Number.parseInt(word.slice(2, 4), 16),
    Number.parseInt(word.slice(4, 6), 16), Number.parseInt(word.slice(6, 8), 16),
  ]));
}

// Independent source declaration order: tr_types.h:74-107, 35 four-byte words.
function entityFixture(): Uint8Array<ArrayBuffer> {
  return bytes(`
    00000000 09000080 feffffff
    0000a03f 000020c0 00000080 00006040
    0000803f 00000040 00004040 00008040 0000a040 0000c040 0000e040 00000041 00001041
    ffffffff 00002041 00003041 00004041 01000001
    00005041 00006041 00007041 00000080 0000803e
    85ffffff efffffff ffffff7f 0180feff 0000003f 000080bf 000000c0 0000d040 0000b4c2
  `);
}

describe("QVM renderer ABI records", () => {
  test("decodes every model field, keeping signed resource words and byte channels", () => {
    const input = entityFixture(), before = input.slice();
    expect(input.length).toBe(140);
    expect(QVM_REF_ENTITY_BYTES).toBe(140);
    const entity = readQvmRefEntity(new DataView(input.buffer));
    expect(entity).toEqual({
      kind: "model", model: -2, customSkin: -17, customShader: 2147483647, renderFlags: -2147483639,
      lightingOrigin: { x: 1.25, y: -2.5, z: -0 }, shadowPlane: 3.5,
      axis: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }, { x: 7, y: 8, z: 9 }], nonNormalizedAxes: true,
      origin: { x: 10, y: 11, z: 12 }, frame: 16777217, oldOrigin: { x: 13, y: 14, z: 15 }, oldFrame: -2147483648,
      backLerp: 0.25, skinNum: -123, shaderRGBA: { x: 1, y: 128, z: 254, w: 255 },
      shaderTexCoord: { x: 0.5, y: -1 }, shaderTime: -2, radius: 6.5, rotation: -90,
    });
    expect(input).toEqual(before);
    input.fill(0);
    expect(entity.origin).toEqual({ x: 10, y: 11, z: 12 });
    if (entity.kind !== "model") throw new Error("Expected model");
    expect(entity.axis[2]).toEqual({ x: 7, y: 8, z: 9 });
    expect(entity.customShader).toBe(2147483647);
    expect(entity.customSkin).toBe(-17);
    expect(Object.is(entity.lightingOrigin.z, -0)).toBe(true);
  });

  test("preserves every generated kind and its otherwise unused source fields", () => {
    const variants: readonly { readonly type: number; readonly kind: SourceRefEntity["kind"] }[] = [
      { type: 2, kind: "sprite" }, { type: 3, kind: "beam" }, { type: 4, kind: "rail-core" },
      { type: 5, kind: "rail-rings" }, { type: 6, kind: "lightning" },
    ];
    for (const variant of variants) {
      const input = entityFixture(), view = new DataView(input.buffer);
      view.setInt32(0, variant.type, true);
      const entity = readQvmRefEntity(view);
      expect(entity.kind).toBe(variant.kind);
      expect(entity.origin).toEqual({ x: 10, y: 11, z: 12 });
      expect(entity.radius).toBe(6.5);
      expect(entity.renderFlags).toBe(-2147483639);
      expect(entity.shaderRGBA).toEqual({ x: 1, y: 128, z: 254, w: 255 });
      expect(entity.shaderTexCoord).toEqual({ x: 0.5, y: -1 });
      expect(entity.shaderTime).toBe(-2);
      expect(entity.customShader).toBe(2147483647);
      expect(entity.model).toBe(-2);
      expect(entity.customSkin).toBe(-17);
      expect(entity.rotation).toBe(-90);
      expect(entity.oldOrigin).toEqual({ x: 13, y: 14, z: 15 });
      expect(entity.axis).toEqual([{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }, { x: 7, y: 8, z: 9 }]);
      expect(entity.nonNormalizedAxes).toBe(true);
      expect(entity.frame).toBe(16777217);
      expect(entity.oldFrame).toBe(-2147483648);
      expect(entity.backLerp).toBe(0.25);
    }
  });

  test("retains the portal source shading and pose as well as its matching fields", () => {
    const input = entityFixture(), view = new DataView(input.buffer);
    view.setInt32(0, 7, true);
    expect(readQvmRefEntity(view)).toMatchObject({
      kind: "portal-surface", renderFlags: -2147483639, origin: { x: 10, y: 11, z: 12 }, oldOrigin: { x: 13, y: 14, z: 15 },
      axis: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }, { x: 7, y: 8, z: 9 }],
      frame: 16777217, oldFrame: -2147483648, skinNum: -123,
      backLerp: 0.25, nonNormalizedAxes: true, customShader: 2147483647, model: -2, customSkin: -17,
      shaderRGBA: { x: 1, y: 128, z: 254, w: 255 }, shaderTexCoord: { x: 0.5, y: -1 }, shaderTime: -2,
    });
  });

  test("retains zero handles and keeps source boolean truth semantics", () => {
    const view = new DataView(new ArrayBuffer(140));
    for (const value of [0, 1, 2, -2147483648]) {
      view.setInt32(64, value, true);
      const entity = readQvmRefEntity(view);
      if (entity.kind !== "model") throw new Error("Expected model");
      expect(entity.nonNormalizedAxes).toBe(value !== 0);
      expect(entity.model).toBe(0);
      expect(entity.customShader).toBe(0);
      expect(entity.customSkin).toBe(0);
    }
  });

  test("accepts source RT_POLY for the later entity-surface error and rejects unknown types", () => {
    const input = entityFixture(), view = new DataView(input.buffer);
    view.setInt32(0, 1, true);
    expect(readQvmRefEntity(view)).toMatchObject({ kind: "poly", model: -2, customShader: 2147483647,
      customSkin: -17, frame: 16777217, oldFrame: -2147483648, backLerp: 0.25 });
    for (const value of [-2147483648, -1, 8, 2147483647]) {
      view.setInt32(0, value, true);
      expect(() => readQvmRefEntity(view)).toThrow(BinaryError);
    }
  });

  test("accepts unaligned resolved views and leaves surrounding bytes untouched", () => {
    const input = new Uint8Array(149).fill(0xa5);
    input.set(entityFixture(), 3);
    const before = input.slice();
    expect(readQvmRefEntity(new DataView(input.buffer, 3, 145)).origin.x).toBe(10);
    expect(input).toEqual(before);
  });

  test("keeps binary32 non-finite and subnormal values without numeric coercion", () => {
    const input = entityFixture(), view = new DataView(input.buffer);
    view.setInt32(0, 2, true);
    view.setUint32(68, 0x00000001, true);
    view.setUint32(72, 0x7f800000, true);
    view.setUint32(76, 0xff800000, true);
    view.setUint32(136, 0x7fc01234, true);
    const entity = readQvmRefEntity(view);
    if (entity.kind !== "sprite") throw new Error("Expected sprite");
    expect(entity.origin).toEqual({ x: 2 ** -149, y: Infinity, z: -Infinity });
    expect(Number.isNaN(entity.rotation)).toBe(true);
    expect(view.getUint32(136, true)).toBe(0x7fc01234);
  });

  test("keeps every signed handle boundary without resource interpretation", () => {
    const view = new DataView(entityFixture().buffer);
    for (const handle of [-2147483648, -17, -1, 0, 1, 16777217, 2147483647]) {
      for (const offset of [8, 108, 112]) view.setInt32(offset, handle, true);
      const entity = readQvmRefEntity(view);
      expect(entity.model).toBe(handle);
      expect(entity.customSkin).toBe(handle);
      expect(entity.customShader).toBe(handle);
    }
  });

  test("decodes the source refdef header, copied area mask and complete text rows", () => {
    // tr_types.h:113-129: twenty header words, 32 mask bytes, eight 32-byte rows.
    const input = new Uint8Array(376).fill(0xa5), view = new DataView(input.buffer, 3, 371);
    input.set(bytes(`f5ffffff 0c000000 01000001 ffffff7f 0000b442 00007042
      00000080 cdcccc3d 00000040
      0000803f 00000040 00004040 00008040 0000a040 0000c040 0000e040 00000041 00001041
      01000080 05000080`), 3);
    for (let index = 0; index < 32; index++) view.setUint8(80 + index, index * 7);
    for (let row = 0; row < 8; row++) {
      for (let column = 0; column < 32; column++) view.setUint8(112 + row * 32 + column, 128 + row);
      view.setUint8(112 + row * 32 + row, 0);
    }
    const before = input.slice(), refdef = readQvmRefdef(view);
    expect(QVM_REFDEF_BYTES).toBe(368);
    expect(refdef).toMatchObject({ x: -11, y: 12, width: 16777217, height: 2147483647, fovX: 90, fovY: 60,
      viewOrigin: { x: -0, y: Math.fround(0.1), z: 2 }, time: -2147483647, renderFlags: -2147483643 });
    expect(refdef.viewAxis).toEqual([{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }, { x: 7, y: 8, z: 9 }]);
    expect([...refdef.areaMask]).toEqual(Array.from({ length: 32 }, (_, index) => index * 7));
    for (const [index, row] of refdef.text.entries()) {
      expect(row).toBe(String.fromCharCode(128 + index).repeat(index) + "\0" + String.fromCharCode(128 + index).repeat(31 - index));
    }
    expect(copyRefdef(refdef)).toEqual(refdef);
    expect(input).toEqual(before);
    input.fill(0);
    expect(refdef.areaMask[31]).toBe(217);
    expect(refdef.text[7].charCodeAt(31)).toBe(135);
  });

  test("rejects each unterminated text row at its actual source offset", () => {
    for (let row = 0; row < 8; row++) {
      const input = new Uint8Array(368);
      input.fill(65, 112 + row * 32, 144 + row * 32);
      expect(() => readQvmRefdef(new DataView(input.buffer))).toThrow(`QVM refdef_t:${112 + row * 32}:`);
    }
  });

  test("reads packed polyVert_t records with byte colors and owned vertices", () => {
    const fixture = bytes(`0000803f 000000c0 00000080 0000003f 000080bf 00ff807f
      00005040 00009040 0000b040 0000803e 0000403f ff010203`);
    const input = new Uint8Array(53).fill(0xa5);
    input.set(fixture, 1);
    const before = input.slice(), vertices = readQvmPolyVertices(new DataView(input.buffer, 1, 51), 2);
    expect(QVM_POLY_VERTEX_BYTES).toBe(24);
    expect(vertices).toEqual([
      { position: { x: 1, y: -2, z: -0 }, texCoord: { x: 0.5, y: -1 }, color: { x: 0, y: 255, z: 128, w: 127 } },
      { position: { x: 3.25, y: 4.5, z: 5.5 }, texCoord: { x: 0.25, y: 0.75 }, color: { x: 255, y: 1, z: 2, w: 3 } },
    ]);
    expect(input).toEqual(before);
    input.fill(0);
    expect(vertices[1]?.color.w).toBe(3);
    expect(readQvmPolyVertices(new DataView(new ArrayBuffer(0)), 0)).toEqual([]);
  });

  test("rejects invalid vertex counts and short polygon arrays", () => {
    for (const count of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 2]) {
      expect(() => readQvmPolyVertices(new DataView(new ArrayBuffer(24)), count)).toThrow(BinaryError);
    }
    for (let length = 0; length < 24; length++) {
      expect(() => readQvmPolyVertices(new DataView(new ArrayBuffer(length)), 1)).toThrow(BinaryError);
    }
  });

  test("writes actual tag orientation in source order and rounds at binary32 storage", () => {
    const tag: Md3Tag = { name: "tag_fixture", origin: { x: 0.1, y: -0, z: 1 },
      axes: [{ x: 2, y: 3, z: 4 }, { x: 5, y: 6, z: 7 }, { x: 8, y: 9, z: -10 }] };
    const input = new Uint8Array(56).fill(0xa5);
    writeQvmOrientation(new DataView(input.buffer, 3, 51), tag);
    expect(QVM_ORIENTATION_BYTES).toBe(48);
    expect(input.subarray(3, 51)).toEqual(bytes(`cdcccc3d 00000080 0000803f
      00000040 00004040 00008040 0000a040 0000c040 0000e040 00000041 00001041 000020c1`));
    expect([...input.subarray(0, 3), ...input.subarray(51)]).toEqual(new Array<number>(8).fill(0xa5));
    expect(tag.origin.x).toBe(0.1);
  });

  test("checks every truncated record extent before reading or writing", () => {
    for (let length = 0; length < 140; length++) {
      expect(() => readQvmRefEntity(new DataView(new ArrayBuffer(length)))).toThrow(BinaryError);
    }
    for (let length = 0; length < 368; length++) {
      expect(() => readQvmRefdef(new DataView(new ArrayBuffer(length)))).toThrow(BinaryError);
    }
    const orientation: Pick<Md3Tag, "origin" | "axes"> = { origin: { x: 1, y: 2, z: 3 },
      axes: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }] };
    for (let length = 0; length < 48; length++) {
      const input = new Uint8Array(52).fill(0xa5), before = input.slice();
      expect(() => writeQvmOrientation(new DataView(input.buffer, 1, length), orientation)).toThrow(BinaryError);
      expect(input).toEqual(before);
    }
  });
});
