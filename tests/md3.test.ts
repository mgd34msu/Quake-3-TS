import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BinaryError, BinaryWriter } from "../src/core/binary.ts";
import {
  decodeMd3Normal,
  interpolateSurface,
  lerpTag,
  parseMd3,
  parseSkin,
} from "../src/assets/md3.ts";
import type { Md3Model, Md3Surface } from "../src/assets/md3.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";

const HEADER_SIZE = 108;
const FRAMES_OFFSET = HEADER_SIZE;
const TAGS_OFFSET = FRAMES_OFFSET + 2 * 56;
const SURFACES_OFFSET = TAGS_OFFSET + 2 * 112;
const SURFACE_LENGTH = 108 + 68 + 12 + 3 * 8 + 2 * 3 * 8;
const MODEL_LENGTH = SURFACES_OFFSET + SURFACE_LENGTH;

function fixedString(writer: BinaryWriter, value: string, length: number): void {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length >= length) throw new RangeError(`fixture string ${value} is too long`);
  writer.bytes(encoded);
  writer.bytes(new Uint8Array(length - encoded.length));
}

function vector(writer: BinaryWriter, x: number, y: number, z: number): void {
  writer.f32(x);
  writer.f32(y);
  writer.f32(z);
}

function tag(writer: BinaryWriter, x: number, rotated: boolean): void {
  fixedString(writer, "tag_weapon", 64);
  vector(writer, x, 0, 0);
  if (rotated) {
    vector(writer, 0, 1, 0);
    vector(writer, -1, 0, 0);
  } else {
    vector(writer, 1, 0, 0);
    vector(writer, 0, 1, 0);
  }
  vector(writer, 0, 0, 1);
}

function md3Fixture(): Uint8Array {
  const writer = new BinaryWriter(MODEL_LENGTH);
  writer.u32(0x33504449);
  writer.i32(15);
  fixedString(writer, "models/test.md3", 64);
  writer.i32(3);
  writer.i32(2);
  writer.i32(1);
  writer.i32(1);
  writer.i32(1);
  writer.i32(FRAMES_OFFSET);
  writer.i32(TAGS_OFFSET);
  writer.i32(SURFACES_OFFSET);
  writer.i32(MODEL_LENGTH);
  for (let frame = 0; frame < 2; frame++) {
    vector(writer, -1, -2, -3);
    vector(writer, 1, 2, 3);
    vector(writer, frame, 2, 3);
    writer.f32(4);
    fixedString(writer, `frame${frame}`, 16);
  }
  tag(writer, 0, false);
  tag(writer, 2, true);
  writer.u32(0x33504449);
  fixedString(writer, "TORSO_1", 64);
  writer.i32(7);
  writer.i32(2);
  writer.i32(1);
  writer.i32(3);
  writer.i32(1);
  writer.i32(108 + 68);
  writer.i32(108);
  writer.i32(108 + 68 + 12);
  writer.i32(108 + 68 + 12 + 3 * 8);
  writer.i32(SURFACE_LENGTH);
  fixedString(writer, "models/test/shader", 64);
  writer.i32(99);
  writer.i32(0);
  writer.i32(1);
  writer.i32(2);
  writer.f32(0);
  writer.f32(0);
  writer.f32(1);
  writer.f32(0);
  writer.f32(0);
  writer.f32(1);
  for (const x of [64, 0, 0]) {
    writer.i16(x);
    writer.i16(0);
    writer.i16(0);
    writer.u16(0);
  }
  for (const x of [192, 128, 128]) {
    writer.i16(x);
    writer.i16(0);
    writer.i16(0);
    writer.u16(0x0040);
  }
  expect(writer.offset).toBe(MODEL_LENGTH);
  return writer.finish();
}

function setI32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const changed = bytes.slice();
  new DataView(changed.buffer, changed.byteOffset, changed.byteLength).setInt32(offset, value, true);
  return changed;
}

function sourceOracleSurface(): Md3Surface {
  return {
    name: "oracle", flags: 0, shaders: [], triangles: [], texCoords: [{ x: 0, y: 0 }],
    frames: [
      [{
        position: { x: -512, y: 192.890625, z: -0.109375 },
        normal: decodeMd3Normal(0x1234),
      }],
      [{
        position: { x: 511.984375, y: -366.5, z: 0.296875 },
        normal: decodeMd3Normal(0xabc9),
      }],
    ],
  };
}

function sourceOracleTagModel(): Md3Model {
  const frame = {
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    origin: { x: 0, y: 0, z: 0 }, radius: 0, name: "",
  };
  return {
    name: "oracle", flags: 0, skinCount: 0, frames: [frame, frame], surfaces: [],
    tags: [
      [{
        name: "tag_oracle", origin: { x: 0, y: 0, z: 0 },
        axes: [
          { x: 0.25, y: -0.75, z: Math.fround(0.61237246) },
          { x: 0, y: 1, z: 0 },
          { x: 0, y: 0, z: 1 },
        ],
      }],
      [{
        name: "tag_oracle", origin: { x: 1, y: 2, z: 3 },
        axes: [
          { x: -0.5, y: 0.125, z: Math.fround(0.85695684) },
          { x: 0, y: 1, z: 0 },
          { x: 0, y: 0, z: 1 },
        ],
      }],
    ],
  };
}

describe("MD3 v15", () => {
  test("parses frames, tags, shaders, triangles, texture coordinates and packed vertices", () => {
    const model = parseMd3(md3Fixture(), "fixture.md3");
    expect(model.name).toBe("models/test.md3");
    expect(model.flags).toBe(3);
    expect(model.skinCount).toBe(1);
    expect(model.frames).toEqual([
      { bounds: { min: { x: -1, y: -2, z: -3 }, max: { x: 1, y: 2, z: 3 } }, origin: { x: 0, y: 2, z: 3 }, radius: 4, name: "frame0" },
      { bounds: { min: { x: -1, y: -2, z: -3 }, max: { x: 1, y: 2, z: 3 } }, origin: { x: 1, y: 2, z: 3 }, radius: 4, name: "frame1" },
    ]);
    expect(model.tags[1]?.[0]?.origin).toEqual({ x: 2, y: 0, z: 0 });
    const surface = model.surfaces[0];
    expect(surface?.name).toBe("torso");
    expect(surface?.flags).toBe(7);
    expect(surface?.shaders).toEqual([{ name: "models/test/shader", index: 99 }]);
    expect(surface?.triangles).toEqual([{ indices: [0, 1, 2] }]);
    expect(surface?.texCoords).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]);
    expect(surface?.frames[0]?.[0]?.position).toEqual({ x: 1, y: 0, z: 0 });
    expect(surface?.frames[1]?.[0]?.position).toEqual({ x: 3, y: 0, z: 0 });
    expect(surface?.frames[1]?.[0]?.normal.x).toBeCloseTo(1, 4);
  });

  test("uses the source renderer sine table for normal decoding", () => {
    expect(decodeMd3Normal(0)).toEqual({
      x: 0,
      y: 0,
      z: Math.fround(0.999998808),
    });
    expect(decodeMd3Normal(0x7f7f)).toEqual({
      x: Math.fround(-0.0214908328),
      y: Math.fround(0.000462039956),
      z: Math.fround(-0.999800801),
    });
    expect(decodeMd3Normal(0xffff)).toEqual({
      x: Math.fround(-0.0184199493),
      y: Math.fround(0.000339474616),
      z: Math.fround(0.999734759),
    });
    expect(() => decodeMd3Normal(0x10000)).toThrow("uint16");
  });

  test("interpolates vertices with backlerp and normalizes blended normals", () => {
    const surface = parseMd3(md3Fixture()).surfaces[0];
    if (surface === undefined) throw new Error("missing fixture surface");
    const vertices = interpolateSurface(surface, 1, 0, 0.25);
    expect(vertices[0]?.position).toEqual({ x: 2.5, y: 0, z: 0 });
    expect(vertices[0]?.normal).toEqual({
      x: Math.fround(0.947931111), y: 0, z: Math.fround(0.313066393),
    });
    const currentFrame = surface.frames[1];
    if (currentFrame === undefined) throw new Error("missing fixture frame");
    expect(interpolateSurface(surface, 1, 0, 0)).toBe(currentFrame);
    expect(() => interpolateSurface(surface, 2, 0, 0.5)).toThrow("current MD3 frame");
  });

  test("matches native LerpMeshVertexes float scales and fast normal normalization", () => {
    const surface = sourceOracleSurface();
    const result = interpolateSurface(surface, 1, 0, 0.123456789);
    expect(result[0]?.position).toEqual({
      x: Math.fround(385.566559),
      y: Math.fround(-297.439423),
      z: Math.fround(0.246720687),
    });
    expect(result[0]?.normal).toEqual({
      x: Math.fround(0.533783913),
      y: Math.fround(0.811051726),
      z: Math.fround(0.232161999),
    });
    expect(interpolateSurface(surface, 1, 0, 0)[0]?.normal).toEqual({
      x: Math.fround(0.475606769),
      y: Math.fround(0.849980235),
      z: Math.fround(0.219311923),
    });
    const previousEndpoint = interpolateSurface(surface, 1, 0, 1)[0];
    expect(previousEndpoint?.position).toEqual({ x: -512, y: 192.890625, z: -0.109375 });
    expect(previousEndpoint?.normal).toEqual({
      x: Math.fround(0.863960147),
      y: Math.fround(0.409377515),
      z: Math.fround(0.287412971),
    });
    expect(() => interpolateSurface(surface, 1, 2, 0.5)).toThrow("old MD3 frame");
  });

  test("interpolates tag origins and separately normalizes each axis", () => {
    const model = parseMd3(md3Fixture());
    const result = lerpTag(model, "tag_weapon", 0, 1, 0.5);
    expect(result?.origin).toEqual({ x: 1, y: 0, z: 0 });
    expect(result?.axes[0].x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(result?.axes[0].y).toBeCloseTo(Math.SQRT1_2, 6);
    expect(lerpTag(model, "tag_missing", 0, 1, 0.5)).toBeNull();
    expect(lerpTag(model, "tag_missing", 0, 1, NaN)).toBeNull();
    expect(lerpTag(model, "tag_missing", 0, 1, Infinity)).toBeNull();
    expect(() => lerpTag(model, "tag_weapon", 0, 1, NaN)).toThrow("MD3 tag fraction must be finite");
    expect(lerpTag(model, "tag_weapon", 500, 500, 0)?.origin).toEqual({ x: 2, y: 0, z: 0 });
  });

  test("matches native R_LerpTag float locals and true normalization", () => {
    const result = lerpTag(sourceOracleTagModel(), "tag_oracle", 0, 1, 0.123456789);
    expect(result?.axes[0]).toEqual({
      x: Math.fround(0.170752078),
      y: Math.fround(-0.696400642),
      z: Math.fround(0.697043717),
    });
  });

  test("rejects truncated and malformed parent and surface ranges", () => {
    expect(() => parseMd3(md3Fixture().slice(0, 107), "short.md3")).toThrow(BinaryError);
    expect(() => parseMd3(setI32(md3Fixture(), 4, 14))).toThrow("version 15");
    expect(() => parseMd3(setI32(md3Fixture(), 104, MODEL_LENGTH + 1))).toThrow("model end");
    expect(() => parseMd3(setI32(md3Fixture(), SURFACES_OFFSET + 100, SURFACE_LENGTH))).toThrow("vertices range");
    expect(() => parseMd3(setI32(md3Fixture(), SURFACES_OFFSET + 72, 1))).toThrow("model has 2");
  });

  test("rejects triangle indexes outside the surface vertex array", () => {
    const triangleOffset = SURFACES_OFFSET + 108 + 68;
    expect(() => parseMd3(setI32(md3Fixture(), triangleOffset, 3))).toThrow("triangle vertex 3");
  });
});

test("skin parser handles comments, case folding, quoted fields and tag exclusions", () => {
  expect(parseSkin(`
    // player skin
    "TORSO", "models/players/test/body"
    tag_head,
    /* gear */ HEAD,models/players/test/head
    legs,models/players/test/legs arms,models/players/test/arms
  `)).toEqual([
    { name: "torso", shader: "models/players/test/body" },
    { name: "head", shader: "models/players/test/head" },
    { name: "legs", shader: "models/players/test/legs" },
    { name: "arms", shader: "models/players/test/arms" },
  ]);
});

test("skin parser retains source EOF, comma, NUL and bounded-name behavior", () => {
  expect(parseSkin("Body,")).toEqual([{ name: "body", shader: "" }]);
  expect(parseSkin("Body,\0Head,other")).toEqual([{ name: "body", shader: "" }]);
  expect(parseSkin(",body,shader")).toEqual([{ name: ",body", shader: "shader" }]);
  expect(parseSkin(`${"A".repeat(80)},shader`)).toEqual([{ name: "a".repeat(63), shader: "shader" }]);
  expect(parseSkin("ÄBODY,shader")).toEqual([{ name: "body", shader: "shader" }]);
  expect(parseSkin('"ÄBODY",shader')).toEqual([{ name: "Äbody", shader: "shader" }]);
  expect(parseSkin(`${"A".repeat(1024)},shader`)).toEqual([]);
  expect(parseSkin(`body,${"x".repeat(1024)}`)).toEqual([{ name: "body", shader: "" }]);
  expect(() => parseSkin(`body,"${"x".repeat(1024)}"`)).toThrow("source allocation");
});

const q3DataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retailAvailable = existsSync(join(q3DataPath, "baseq3", "pak0.pk3"));
test.skipIf(!retailAvailable)("parses and interpolates every frame of every installed retail MD3", async () => {
  const product = existsSync(join(q3DataPath, "missionpack", "pak0.pk3")) ? "missionpack" : "baseq3";
  const vfs = await VirtualFileSystem.openInspection({ dataPath: q3DataPath, homePath: q3DataPath, cdPath: null, product });
  const paths = vfs.list().filter(path => path.endsWith(".md3"));
  let interpolatedFrames = 0;
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) {
    const model = parseMd3(await vfs.read(path), path);
    for (const surface of model.surfaces) {
      for (let frame = 0; frame < surface.frames.length; frame++) {
        const oldFrame = frame === 0 ? Math.min(1, surface.frames.length - 1) : frame - 1;
        const vertices = interpolateSurface(surface, frame, oldFrame, 0.375);
        for (const vertex of vertices) {
          if (![vertex.position.x, vertex.position.y, vertex.position.z,
            vertex.normal.x, vertex.normal.y, vertex.normal.z].every(Number.isFinite)) {
            throw new Error(`${path} surface ${surface.name} frame ${frame} produced a non-finite vertex`);
          }
        }
        interpolatedFrames++;
      }
    }
    for (let frame = 0; frame < model.tags.length; frame++) {
      const tags = model.tags[frame];
      if (tags === undefined) throw new Error(`${path} is missing tag frame ${frame}`);
      const oldFrame = frame === 0 ? Math.min(1, model.tags.length - 1) : frame - 1;
      for (const tag of tags) {
        const interpolated = lerpTag(model, tag.name, oldFrame, frame, 0.375);
        if (interpolated === null) throw new Error(`${path} lost tag ${tag.name} in frame ${frame}`);
      }
    }
  }
  expect(interpolatedFrames).toBeGreaterThan(0);
}, 60_000);
