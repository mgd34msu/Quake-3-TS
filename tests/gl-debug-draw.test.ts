// SPDX-License-Identifier: GPL-2.0-or-later
// Analytic SDL/system GL checks for id Software tr_shade.c DrawTris/DrawNormals
// and tr_main.c R_DebugGraphics/R_DebugPolygon.
import { describe, expect, test } from "bun:test";
import type { Vec4 } from "../src/core/math.ts";
import { loadGl } from "../src/platform/gl.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { snapshotSourceDebugOperations } from "../src/render/debug-draw.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import type { DrawBatch, SourceDebugTris, SourceStageData } from "../src/render/types.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { SourceStateBit } from "../src/render/source-state.ts";

const white = { x: 1, y: 1, z: 1, w: 1 }, blue = { x: 0, y: 0, z: 1, w: 1 }, red = { x: 1, y: 0, z: 0, w: 1 };
const viewport = { x: 0, y: 0, width: 32, height: 32 };
type PairStage = Extract<SourceStageData, { kind: "generic-pair" | "lightmapped-pair" }>;
function fixture() {
  const window = SdlWindow.open({ title: "Source GL debug drawing", width: 32, height: 32, backend: "gl", stencilBits: 8, hidden: true });
  const images = new RendererImageCatalog(), renderer = new GlRenderer(window, images), session = images.openSession();
  renderer.initializeDefaultState(renderer.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  session.attach(renderer); session.beginExecution();
  const native = loadGl(window), gl = native.symbols;
  const image = (name: string, pixels: Uint8Array) => images.create({ name, sourceWidth: pixels.length / 4, sourceHeight: 1,
    levels: [{ width: pixels.length / 4, height: 1, pixels }], mipmap: false, internalFormat: "rgba8",
    sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  const solid = image("white", new Uint8Array([255, 255, 255, 255]));
  const stripes = image("red-green", new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]));
  image("binding sentinel", new Uint8Array([0, 0, 0, 255]));
  const integers = (name: number, count = 1): number[] => { const values = new Int32Array(count); gl.glGetIntegerv(name, values); return [...values]; };
  const integer = (name: number): number => {
    const value = integers(name)[0]; if (value === undefined) throw new Error("Missing GL integer"); return value;
  };
  const current = (name: number, count = 4): number[] => { const values = new Float32Array(count); gl.glGetFloatv(name, values); return [...values]; };
  const uv = (unit: 0 | 1): number[] => {
    const active = integer(0x84e0); gl.glActiveTexture(0x84c0 + unit);
    const result = current(0xb03); gl.glActiveTexture(active); return result;
  };
  const arrays = () => {
    const client = integer(0x84e1), vertex = gl.glIsEnabled(0x8074), color = gl.glIsEnabled(0x8076);
    gl.glClientActiveTexture(0x84c0); const uv0 = gl.glIsEnabled(0x8078);
    gl.glClientActiveTexture(0x84c1); const uv1 = gl.glIsEnabled(0x8078);
    gl.glClientActiveTexture(client); return { vertex, color, uv0, uv1 };
  };
  const pixel = (x: number, y: number): number[] => [...renderer.readPixels().slice((y * 32 + x) * 4, (y * 32 + x + 1) * 4)];
  const depth = (x: number, y: number): number => {
    const value = new Float32Array(1); gl.glReadPixels(x, 31 - y, 1, 1, 0x1902, 0x1406, value);
    const result = value[0]; if (result === undefined) throw new Error("Missing GL depth"); return result;
  };
  const clear = (clipPlane?: Vec4) => renderer.beginView({ viewport, clear: { stencil: false, depth: 1, color: { x: 0, y: 0, z: 0, w: 1 } },
    ...(clipPlane === undefined ? {} : { clipPlane }) });
  clear();
  renderer.drawImmediate({ kind: "cull", cull: "none" });
  return { renderer, images, gl, solid, stripes, integer, integers, current, uv, arrays, pixel, depth, clear,
    close: () => { session.close(); native.close(); renderer.close(); window.close(); } };
}
function triangle(image: RendererImage): SourceDebugTris {
  const positions = [{ x: -0.71875, y: -0.71875, z: 0.5, w: 1 }, { x: 0.71875, y: -0.71875, z: 0.5, w: 1 },
    { x: -0.71875, y: 0.71875, z: 0.5, w: 1 }];
  return { whiteImage: image, positions, indices: [0, 1, 2], allocation: { kind: "standalone" },
    scratch: positions.map(() => ({ color: { x: 0, y: 1, z: 0, w: 1 }, texCoord: { x: 0.25, y: 0.5 }, texCoord2: { x: 0.875, y: 0.625 },
      rawTexCoord: { x: 0.25, y: 0.5 }, rawTexCoord2: { x: 0.125, y: 0.75 } })) };
}
function quad(image: RendererImage, color = blue, depth = -0.5): DrawBatch {
  return { primitive: "triangles", texturing: "single", texture: { kind: "bind-image", image }, state: { ...OPAQUE_STATE, cull: "none" },
    vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
      if (x === undefined || y === undefined) throw new Error("Missing fixture coordinate");
      return { position: { x, y, z: depth, w: 1 }, color: { ...color }, texCoord: { x: 0.75, y: 0.25 } };
    }), indices: [0, 1, 2, 0, 2, 3] };
}
function direct(f: ReturnType<typeof fixture>, batch: DrawBatch): void {
  if (batch.texture.kind !== "bind-image" || batch.texturing !== "single") throw new Error("Fixture requires a single image");
  const prepared = f.renderer.prepareGeometry(batch); prepared.begin(); prepared.applyTexture(0, batch.texture); prepared.draw(); prepared.cleanup();
}
function pair(image: RendererImage, second: RendererImage, kind: PairStage["kind"] = "generic-pair"): PairStage {
  const vertex = { position: { x: 0, y: 0, z: 0, w: 1 }, color: { ...white }, texCoord: { x: 0.25, y: 0.5 }, texCoord2: { x: 0.125, y: 0.75 } };
  return { kind, stateBits: SourceStateBit.DEFAULT, batch: { primitive: "triangles", texturing: "pair", texture: { kind: "bind-image", image },
    secondTexture: { binding: { kind: "bind-image", image: second }, environment: "modulate" },
    vertices: [vertex], indices: [0, 0, 0], state: { ...OPAQUE_STATE, cull: "none" } },
    scratch: [{ ...vertex, rawTexCoord: { ...vertex.texCoord }, rawTexCoord2: { ...vertex.texCoord2 } }] };
}
function source(f: ReturnType<typeof fixture>, stage: SourceStageData) {
  if (stage.batch.texture.kind !== "bind-image") throw new Error("Fixture requires an image");
  if (stage.kind === "generic-single" || stage.kind === "generic-pair")
    f.renderer.drawImmediate({ kind: "begin-generic-iterator", setArraysOnce: stage.kind === "generic-single", scratch: stage.scratch });
  const prepared = f.renderer.prepareSourceGeometry(stage); prepared.begin();
  prepared.prepareTexture(0); prepared.applyTexture(0, stage.batch.texture);
  if (stage.batch.texturing === "pair") {
    prepared.prepareTexture(1);
    const binding = stage.batch.secondTexture.binding;
    if (binding.kind !== "bind-image") throw new Error("Fixture requires a second image");
    prepared.applyTexture(1, binding);
  }
  prepared.finishTextures();
  return prepared;
}
function debug(f: ReturnType<typeof fixture>, input: SourceDebugTris, mode: number): void {
  const prepared = f.renderer.prepareDebugTris(input); prepared.begin(); prepared.draw(mode); prepared.cleanup();
}
function normal(f: ReturnType<typeof fixture>): void {
  f.renderer.drawDebugNormals({ whiteImage: f.solid, segments: [[
    { x: 0.03125, y: -0.46875, z: 0.75, w: 1 }, { x: 0.03125, y: 0.40625, z: 0.75, w: 1 },
  ]] });
}
const surfacePolygon: readonly Vec4[] = [
  { x: -0.71875, y: -0.71875, z: 0.5, w: 1 }, { x: 0.71875, y: -0.71875, z: 0.5, w: 1 },
  { x: 0.71875, y: 0.71875, z: 0.5, w: 1 }, { x: -0.71875, y: 0.71875, z: 0.5, w: 1 },
];

describe.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("actual source GL collision debug surfaces", () => {
  test("RGB bits add to the framebuffer while the white perimeter writes depth zero without fan diagonals", () => {
    const f = fixture();
    try {
      for (const color of [0, 1, 2, 3, 4, 5, 6, 7, 8, -1]) {
        f.renderer.beginView({ viewport, clear: { stencil: false, depth: 1, color: { x: 32 / 255, y: 64 / 255, z: 128 / 255, w: 1 } } });
        f.renderer.drawImmediate({ kind: "depth-range", range: [0.125, 0.625] });
        f.renderer.drawImmediate({ kind: "begin-debug-surface", whiteImage: f.solid, cull: "back" });
        f.renderer.drawImmediate({ kind: "debug-polygon", color, positions: surfacePolygon });
        const fill = [color & 1 ? 255 : 32, color & 2 ? 255 : 64, color & 4 ? 255 : 128, 255];
        expect(f.pixel(16, 16)).toEqual(fill); expect(f.depth(16, 16)).toBeCloseTo(0.5, 6);
        expect(f.pixel(12, 27)).toEqual([255, 255, 255, 255]); expect(f.depth(12, 27)).toBe(0);
        expect(f.pixel(2, 16)).toEqual([32, 64, 128, 255]);
        f.renderer.drawImmediate({ kind: "debug-polygon", color: 7, positions: surfacePolygon });
        expect(f.pixel(16, 16)).toEqual(fill); expect(f.depth(16, 16)).toBeCloseTo(0.5, 6);
      }
      expect(f.gl.glIsEnabled(0xb71)).toBe(1); expect(f.integer(0xb74)).toBe(0x203); expect(f.integer(0xb72)).toBe(1);
      expect(f.gl.glIsEnabled(0xbe2)).toBe(1); expect(f.integer(0xbe1)).toBe(1); expect(f.integer(0xbe0)).toBe(1);
      expect(f.gl.glIsEnabled(0xbc0)).toBe(0); expect(f.integers(0xb40, 2)).toEqual([0x1b01, 0x1b01]);
      expect(f.current(0xb70, 2)).toEqual([0, 1]); expect(f.current(0xb00)).toEqual([1, 1, 1, 1]);
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("debug entry binds on the retained unit and preserves other state before the first polygon", () => {
    const f = fixture();
    try {
      source(f, pair(f.stripes, f.stripes));
      f.gl.glDisable(0xde1); f.gl.glColor3f(0.25, 0.5, 0.75); f.gl.glTexCoord2f(0.75, 0.5);
      f.gl.glDisable(0xb71); f.gl.glDepthMask(0); f.gl.glEnable(0xbc0); f.gl.glAlphaFunc(0x204, 0.75);
      f.gl.glLineWidth(3); f.renderer.drawImmediate({ kind: "polygon-offset", value: { factor: 3, units: 5 } });
      f.renderer.drawImmediate({ kind: "depth-range", range: [0.125, 0.375] });
      const arrays = f.arrays(), uv0 = f.uv(0), uv1 = f.uv(1);
      f.renderer.drawImmediate({ kind: "begin-debug-surface", whiteImage: f.solid, cull: "front" });
      expect(f.integer(0x84e0)).toBe(0x84c1); expect(f.integer(0x84e1)).toBe(0x84c1);
      expect(f.integer(0x8069)).toBe(1024 + f.solid.ordinal); expect(f.gl.glIsEnabled(0xde1)).toBe(0);
      f.gl.glActiveTexture(0x84c0); expect(f.integer(0x8069)).toBe(1024 + f.stripes.ordinal); f.gl.glActiveTexture(0x84c1);
      expect(f.gl.glIsEnabled(0xb44)).toBe(1); expect(f.integer(0xb45)).toBe(0x404);
      expect(f.arrays()).toEqual(arrays); expect(f.uv(0)).toEqual(uv0); expect(f.uv(1)).toEqual(uv1);
      expect(f.current(0xb00)).toEqual([0.25, 0.5, 0.75, 1]); expect(f.current(0xb70, 2)).toEqual([0.125, 0.375]);
      expect(f.gl.glIsEnabled(0xb71)).toBe(0); expect(f.integer(0xb72)).toBe(0); expect(f.gl.glIsEnabled(0xbc0)).toBe(1);
      expect(f.gl.glIsEnabled(0xbe2)).toBe(0); expect(f.integers(0xb40, 2)).toEqual([0x1b02, 0x1b02]);
      f.renderer.drawImmediate({ kind: "debug-polygon", color: 1, positions: [] });
      expect(f.arrays()).toEqual(arrays); expect(f.uv(0)).toEqual(uv0); expect(f.uv(1)).toEqual(uv1);
      expect(f.integer(0x84e0)).toBe(0x84c1); expect(f.integer(0x84e1)).toBe(0x84c1); expect(f.gl.glIsEnabled(0xde1)).toBe(0);
      expect(f.current(0xb00)).toEqual([1, 1, 1, 1]); expect(f.current(0xb70, 2)).toEqual([0, 1]);
      expect(f.current(0xb21, 1)).toEqual([3]); expect(f.gl.glIsEnabled(0x8037)).toBe(1);
      expect(f.current(0x8038, 1)).toEqual([3]); expect(f.current(0x2a00, 1)).toEqual([5]); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("r_nobind samples explicit retained coordinates and preserves replace or disabled texturing", () => {
    const f = fixture();
    try {
      f.images.setDlightImage(f.stripes); f.images.setBindingSettings({ noBind: true });
      for (const s of [0.25, 0.75]) {
        f.clear(); f.gl.glTexCoord2f(s, 0.5);
        f.renderer.drawImmediate({ kind: "begin-debug-surface", whiteImage: f.solid, cull: "none" });
        f.renderer.drawImmediate({ kind: "debug-polygon", color: 7, positions: surfacePolygon });
        const sampled = s === 0.25 ? [255, 0, 0, 255] : [0, 255, 0, 255];
        expect(f.pixel(16, 16)).toEqual(sampled); expect(f.pixel(12, 27)).toEqual(sampled);
        expect(f.uv(0)).toEqual([s, 0.5, 0, 1]); expect(f.integer(0x8069)).toBe(1024 + f.stripes.ordinal);
      }
      f.clear(); f.gl.glTexEnvi(0x2300, 0x2200, 0x1e01);
      f.renderer.drawImmediate({ kind: "begin-debug-surface", whiteImage: f.solid, cull: "none" });
      f.renderer.drawImmediate({ kind: "debug-polygon", color: 0, positions: surfacePolygon });
      expect(f.pixel(16, 16)).toEqual([0, 255, 0, 255]);
      f.clear(); f.gl.glDisable(0xde1);
      f.renderer.drawImmediate({ kind: "begin-debug-surface", whiteImage: f.solid, cull: "none" });
      f.renderer.drawImmediate({ kind: "debug-polygon", color: 5, positions: surfacePolygon });
      expect(f.pixel(16, 16)).toEqual([255, 0, 255, 255]); expect(f.gl.glIsEnabled(0xde1)).toBe(0); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("native polygons retain culling and clip their white outlines to near and portal planes", () => {
    const f = fixture();
    try {
      f.renderer.drawImmediate({ kind: "begin-debug-surface", whiteImage: f.solid, cull: "front" });
      f.renderer.drawImmediate({ kind: "debug-polygon", color: 1, positions: surfacePolygon });
      expect(f.pixel(16, 16)).toEqual([0, 0, 0, 255]); expect(f.pixel(12, 27)).toEqual([0, 0, 0, 255]);
      f.renderer.drawImmediate({ kind: "begin-debug-surface", whiteImage: f.solid, cull: "back" });
      f.renderer.drawImmediate({ kind: "debug-polygon", color: 1, positions: [
        { x: -0.75, y: -0.75, z: -2, w: 1 }, { x: 0.75, y: -0.75, z: 0, w: 1 }, { x: -0.75, y: 0.75, z: 0, w: 1 },
      ] });
      expect(f.pixel(7, 19)).toEqual([255, 255, 255, 255]); expect(f.pixel(10, 15)).toEqual([255, 0, 0, 255]);
      expect(f.pixel(8, 26)).toEqual([0, 0, 0, 255]);
      f.clear({ x: 1, y: 0, z: 0, w: -0.03125 });
      f.renderer.drawImmediate({ kind: "begin-debug-surface", whiteImage: f.solid, cull: "none" });
      f.renderer.drawImmediate({ kind: "debug-polygon", color: 2, positions: surfacePolygon });
      expect(f.pixel(16, 20)).toEqual([255, 255, 255, 255]); expect(f.pixel(22, 20)).toEqual([0, 255, 0, 255]);
      expect(f.pixel(10, 20)).toEqual([0, 0, 0, 255]); expect(f.gl.glIsEnabled(0x3000)).toBe(1); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("empty polygons retain the source tail and rejected data never leaves a native begin open", () => {
    const f = fixture();
    try {
      f.renderer.drawImmediate({ kind: "begin-debug-surface", whiteImage: f.solid, cull: "none" });
      f.renderer.drawImmediate({ kind: "depth-range", range: [0.125, 0.375] });
      f.renderer.drawImmediate({ kind: "debug-polygon", color: 2, positions: [] });
      expect(f.current(0xb00)).toEqual([1, 1, 1, 1]); expect(f.current(0xb70, 2)).toEqual([0, 1]);
      expect(f.integers(0xb40, 2)).toEqual([0x1b01, 0x1b01]); expect(f.gl.glIsEnabled(0xbe2)).toBe(1);
      expect(f.pixel(16, 16)).toEqual([0, 0, 0, 255]);
      expect(() => f.renderer.drawImmediate({ kind: "debug-polygon", color: 0.5, positions: [] })).toThrow("int32");
      expect(() => f.renderer.drawImmediate({ kind: "debug-polygon", color: 0x80000000, positions: [] })).toThrow("int32");
      expect(() => f.renderer.drawImmediate({ kind: "debug-polygon", color: 1,
        positions: [...surfacePolygon, { x: Number.MAX_VALUE, y: 0, z: 0, w: 1 }] })).toThrow("finite float32");
      f.renderer.drawImmediate({ kind: "debug-polygon", color: 1, positions: surfacePolygon });
      expect(f.pixel(16, 16)).toEqual([255, 0, 0, 255]); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });
});

describe.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("actual source GL triangle and normal debug drawing", () => {
  test("primitive modes draw polygon outlines at depth zero and normals bypass every selection", () => {
    const f = fixture();
    try {
      for (const mode of [0, 1, 2, 3, -1, 7]) {
        f.clear(); direct(f, quad(f.solid));
        const prepared = f.renderer.prepareDebugTris(triangle(f.solid)); prepared.begin();
        expect(f.current(0xb70, 2)).toEqual([0, 0]);
        prepared.draw(mode); prepared.cleanup();
        expect(f.pixel(12, 27)).toEqual(mode === 3 ? [0, 255, 0, 255] : mode === -1 || mode === 7 ? [0, 0, 255, 255] : [255, 255, 255, 255]);
        expect(f.pixel(10, 20)).toEqual([0, 0, 255, 255]);
        if (mode === -1 || mode === 7) expect(f.depth(12, 27)).toBeCloseTo(0.25, 6);
        else expect(f.depth(12, 27)).toBe(0);
        expect(f.current(0xb70, 2)).toEqual([0, 1]); expect(f.integers(0xb40, 2)).toEqual([0x1b01, 0x1b01]);
        expect(f.arrays()).toEqual({ vertex: 1, color: 0, uv0: 0, uv1: 0 });
        expect(f.current(0xb00)).toEqual(mode === 3 ? [0, 1, 0, 1] : [1, 1, 1, 1]);
        normal(f); expect(f.pixel(16, 19)).toEqual([255, 255, 255, 255]); expect(f.depth(16, 19)).toBe(0);
        expect(f.current(0xb00)).toEqual([1, 1, 1, 1]); expect(f.current(0xb70, 2)).toEqual([0, 1]);
      }
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("culling suppresses polygon outlines while normals retain arrays, line width, texture state, and polygon offset", () => {
    const f = fixture();
    try {
      direct(f, quad(f.solid));
      f.renderer.drawImmediate({ kind: "cull", cull: "front" });
      f.renderer.drawImmediate({ kind: "polygon-offset", value: { factor: 3, units: 5 } });
      f.gl.glLineWidth(3);
      debug(f, triangle(f.solid), 1); expect(f.pixel(12, 27)).toEqual([0, 0, 255, 255]);
      const arrays = f.arrays();
      normal(f); expect(f.arrays()).toEqual(arrays);
      for (const x of [15, 16, 17]) expect(f.pixel(x, 19)).toEqual([255, 255, 255, 255]);
      expect(f.pixel(14, 19)).toEqual([0, 0, 255, 255]);
      expect(f.gl.glIsEnabled(0xb44)).toBe(1); expect(f.integer(0xb45)).toBe(0x404);
      expect(f.gl.glIsEnabled(0x8037)).toBe(1); expect(f.current(0x8038, 1)).toEqual([3]); expect(f.current(0x2a00, 1)).toEqual([5]);
      expect(f.current(0xb21, 1)).toEqual([3]); expect(f.gl.glIsEnabled(0xde1)).toBe(1);
      expect(f.gl.glIsEnabled(0xb71)).toBe(1); expect(f.integer(0xb74)).toBe(0x203); expect(f.integer(0xb72)).toBe(1);
      expect(f.gl.glIsEnabled(0xbe2)).toBe(0); expect(f.gl.glIsEnabled(0xbc0)).toBe(0); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("native polygon-line clipping draws new near and portal boundaries without triangulation spokes", () => {
    const f = fixture();
    try {
      const input = triangle(f.solid);
      const near: SourceDebugTris = { ...input, positions: [{ x: -0.75, y: -0.75, z: -2, w: 1 },
        { x: 0.75, y: -0.75, z: 0, w: 1 }, { x: -0.75, y: 0.75, z: 0, w: 1 }] };
      debug(f, near, 2); expect(f.pixel(7, 19)).toEqual([255, 255, 255, 255]);
      expect(f.pixel(10, 15)).toEqual([0, 0, 0, 255]); expect(f.pixel(8, 26)).toEqual([0, 0, 0, 255]);
      f.clear({ x: 1, y: 0, z: 0, w: -0.03125 }); debug(f, input, 1);
      expect(f.pixel(16, 22)).toEqual([255, 255, 255, 255]); expect(f.pixel(10, 27)).toEqual([0, 0, 0, 255]);
      expect(f.pixel(18, 24)).toEqual([0, 0, 0, 255]); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("GL_Bind honors r_nobind and debug uses retained UVs or explicit discrete svars with the retained texture environment", () => {
    const f = fixture();
    try {
      f.images.setDlightImage(f.stripes); f.images.setBindingSettings({ noBind: true });
      f.gl.glTexCoord2f(0.75, 0.5);
      for (const mode of [1, 2]) {
        f.clear(); debug(f, triangle(f.solid), mode);
        expect(f.pixel(12, 27)).toEqual([0, 255, 0, 255]); expect(f.uv(0)).toEqual([0.75, 0.5, 0, 1]);
        expect(f.integer(0x8069)).toBe(1024 + f.stripes.ordinal);
      }
      const initial = triangle(f.solid), input: SourceDebugTris = { ...initial,
        scratch: initial.scratch.map(cell => ({ ...cell, color: { x: 128 / 255, y: 64 / 255, z: 0, w: 1 } })) };
      f.clear(); debug(f, input, 3); expect(f.pixel(12, 27)).toEqual([128, 0, 0, 255]); expect(f.uv(0)).toEqual([0.25, 0.5, 0, 1]);
      expect(f.current(0xb00).map(value => Math.round(value * 255))).toEqual([128, 64, 0, 255]);
      normal(f); expect(f.pixel(16, 19)).toEqual([255, 0, 0, 255]);
      f.gl.glTexEnvi(0x2300, 0x2200, 0x1e01); f.clear(); debug(f, input, 3);
      expect(f.pixel(12, 27)).toEqual([255, 0, 0, 255]);
      f.gl.glDisable(0xde1); normal(f); expect(f.pixel(16, 19)).toEqual([255, 255, 255, 255]);
      expect(f.gl.glIsEnabled(0xde1)).toBe(0); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("debug refreshes retained UV1 against its own allocation and owns copied data across collection", () => {
    const f = fixture();
    try {
      const previous = source(f, pair(f.solid, f.solid)); previous.draw(1); previous.cleanup();
      expect(f.arrays().uv1).toBe(1); expect(f.uv(1)).toEqual([0.125, 0.75, 0, 1]);
      const enabledArrays = f.arrays(); normal(f); expect(f.arrays()).toEqual(enabledArrays);
      expect(f.uv(1)).toEqual([0.125, 0.75, 0, 1]);
      const input = triangle(f.solid), positions = input.positions.map(position => ({ ...position }));
      const scratch = input.scratch.map((cell, index) => ({ color: { ...cell.color }, texCoord: { ...cell.texCoord }, texCoord2: { x: index === 2 ? 0.875 : 0.125, y: 0.625 },
        rawTexCoord: { ...cell.rawTexCoord }, rawTexCoord2: { ...cell.rawTexCoord2 } }));
      const indices = [0, 1, 2], prepared = f.renderer.prepareDebugTris({ ...input, positions, scratch, indices });
      for (const position of positions) position.x = 99;
      for (const cell of scratch) { cell.texCoord2.x = 99; cell.color.y = 0; }
      indices.fill(0); prepared.begin(); Bun.gc(true); prepared.draw(1); prepared.cleanup(); Bun.gc(true);
      expect(f.uv(1)).toEqual([0.875, 0.625, 0, 1]); expect(f.current(0xb00)).toEqual([1, 1, 1, 1]);
      expect(f.pixel(12, 27)).toEqual([255, 255, 255, 255]);
      expect(f.arrays()).toEqual({ vertex: 1, color: 0, uv0: 0, uv1: 1 });
      const uv1 = f.uv(1); debug(f, input, 3); expect(f.uv(1)).toEqual(uv1);
      normal(f); expect(f.arrays()).toEqual({ vertex: 1, color: 0, uv0: 0, uv1: 1 });
      const lightmapped = source(f, pair(f.solid, f.solid, "lightmapped-pair")); lightmapped.draw(1); lightmapped.cleanup();
      const disabledUv = f.uv(1); debug(f, input, 1); expect(f.uv(1)).toEqual(disabledUv); expect(f.arrays().uv1).toBe(0);
      expect(f.integer(0x84e0)).toBe(0x84c0); expect(f.integer(0x84e1)).toBe(0x84c0); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("the selected nonzero unit stays selected and discrete failure retains reached state without cleanup", () => {
    const f = fixture();
    try {
      const stage = source(f, pair(f.stripes, f.stripes));
      const prepared = f.renderer.prepareDebugTris(triangle(f.solid)); prepared.begin();
      expect(f.integer(0x84e0)).toBe(0x84c1); expect(f.integer(0x84e1)).toBe(0x84c1);
      expect(f.integer(0x8069)).toBe(1024 + f.solid.ordinal); expect(f.arrays()).toEqual({ vertex: 1, color: 0, uv0: 1, uv1: 0 });
      expect(() => prepared.draw(3)).toThrow("undefined source MultiTexCoordARB targets 0 and 1");
      expect(() => prepared.cleanup()).toThrow("not completed");
      expect(f.current(0xb70, 2)).toEqual([0, 0]); expect(f.integers(0xb40, 2)).toEqual([0x1b01, 0x1b01]);
      expect(f.pixel(12, 27)).toEqual([0, 0, 0, 255]); expect(f.gl.glGetError()).toBe(0);
      void stage;
    } finally { f.close(); }
  });

  test("empty calls retain their full state sequence and validate reached inputs before native drawing", () => {
    const f = fixture();
    try {
      for (const mode of [0, 1, 2, 3, -1, 7]) {
        f.renderer.drawImmediate({ kind: "depth-range", range: [0, 0.3] });
        debug(f, { whiteImage: f.solid, positions: [], scratch: [], indices: [], allocation: { kind: "standalone" } }, mode);
        expect(f.current(0xb70, 2)).toEqual([0, 1]); expect(f.integers(0xb40, 2)).toEqual([0x1b01, 0x1b01]);
        f.renderer.drawDebugNormals({ whiteImage: f.solid, segments: [] });
        expect(f.current(0xb00)).toEqual([1, 1, 1, 1]); expect(f.current(0xb70, 2)).toEqual([0, 1]);
      }
      const input = triangle(f.solid);
      expect(() => f.renderer.prepareDebugTris({ ...input, indices: [0, 1] })).toThrow("index count");
      expect(() => f.renderer.prepareDebugTris({ ...input, indices: [0, 1, 3] })).toThrow("out of range");
      expect(() => f.renderer.prepareDebugTris({ ...input, scratch: [] })).toThrow("scratch");
      expect(() => debug(f, { ...input, positions: input.positions.map(position => ({ ...position, x: Number.MAX_VALUE })) }, 1)).toThrow("finite float32");
      expect(() => f.renderer.drawDebugNormals({ whiteImage: f.solid, segments: [[{ x: NaN, y: 0, z: 0, w: 1 }, white]] })).toThrow("finite float32");
      const prepared = f.renderer.prepareDebugTris(input);
      expect(() => prepared.draw(1)).toThrow("not begun"); expect(() => prepared.cleanup()).toThrow("not completed");
      prepared.begin(); expect(() => prepared.begin()).toThrow("already begun"); prepared.draw(-1); prepared.cleanup();
      expect(() => prepared.draw(1)).toThrow("not begun"); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("debug validates retained source coordinates only when its selected draw reads them", () => {
    const f = fixture();
    try {
      for (const unit of [0, 1] satisfies readonly (0 | 1)[]) {
        const tess = new SourceTessState(), initial = triangle(f.solid);
        tess.appendGeometry({ indices: initial.indices, vertices: initial.positions.map(position => ({
          position: { x: position.x, y: position.y, z: position.z }, normal: { x: 0, y: 0, z: 1 },
          texCoord: { x: 0, y: 0 }, lightmapCoord: { x: 0, y: 0 }, color: { x: 255, y: 255, z: 255, w: 255 },
        })) }, "bsp-normal");
        for (const index of initial.indices) tess.writeStageColor(index, white);
        tess.writeStageTexCoord(unit, 2, { x: NaN, y: 0 });
        const [operation] = snapshotSourceDebugOperations(tess, position => ({ ...position, w: 1 }), f.solid,
          { showTris: 1, showNormals: 0 });
        if (operation?.kind !== "debug-tris") throw new Error("Missing enabled triangle debug operation");
        tess.endSurface();
        for (const mode of [0, 1, 2]) {
          f.clear(); debug(f, operation.input, mode); expect(f.pixel(12, 27)).toEqual([255, 255, 255, 255]);
        }
        if (unit === 0) {
          const reached = f.renderer.prepareDebugTris(operation.input); reached.begin();
          expect(() => reached.draw(3)).toThrow("coordinates");
          expect(f.current(0xb70, 2)).toEqual([0, 0]); expect(f.gl.glGetError()).toBe(0);
        } else {
          const paired = source(f, pair(f.solid, f.solid)); paired.draw(1); paired.cleanup();
          const retainedUv = f.uv(1); debug(f, operation.input, 3); expect(f.uv(1)).toEqual(retainedUv);
          for (const mode of [1, 2]) {
            const reached = f.renderer.prepareDebugTris(operation.input); reached.begin();
            expect(() => reached.draw(mode)).toThrow("coordinates");
            expect(f.current(0xb70, 2)).toEqual([0, 0]); expect(f.gl.glGetError()).toBe(0);
          }
        }
      }
    } finally { f.close(); }
  });

  test("suppressed numeric data completes debug state while a consumed invalid position rejects after begin", () => {
    const f = fixture();
    try {
      const initial = triangle(f.solid), input = { ...initial,
        positions: initial.positions.map((position, index) => ({ ...position, x: index === 2 ? NaN : position.x })) };
      for (const mode of [-1, 7]) {
        f.clear(); f.renderer.drawImmediate({ kind: "depth-range", range: [0.2, 0.4] }); f.gl.glColor3f(0.25, 0.5, 0.75);
        debug(f, input, mode);
        expect(f.integer(0x8069)).toBe(1024 + f.solid.ordinal); expect(f.current(0xb00)).toEqual([1, 1, 1, 1]);
        expect(f.current(0xb70, 2)).toEqual([0, 1]); expect(f.integers(0xb40, 2)).toEqual([0x1b01, 0x1b01]);
        expect(f.pixel(12, 27)).toEqual([0, 0, 0, 255]);
      }
      for (const mode of [0, 1, 2, 3]) {
        const reached = f.renderer.prepareDebugTris(input); reached.begin();
        expect(() => reached.draw(mode)).toThrow("positions"); expect(() => reached.cleanup()).toThrow("not completed");
        expect(f.current(0xb70, 2)).toEqual([0, 0]); expect(f.current(0xb00)).toEqual([1, 1, 1, 1]);
        expect(f.integers(0xb40, 2)).toEqual([0x1b01, 0x1b01]); expect(f.gl.glGetError()).toBe(0);
      }
      normal(f); expect(f.pixel(16, 19)).toEqual([255, 255, 255, 255]); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("later source stages and shadow volumes inherit the executing range while actual GL_State restores fill", () => {
    const f = fixture();
    try {
      const stage = (color: Vec4, depth: number): SourceStageData => {
        const batch = quad(f.solid, color, depth);
        if (batch.primitive !== "triangles" || batch.texturing !== "single") throw new Error("Fixture requires triangles");
        return { kind: "generic-single", stateBits: SourceStateBit.DEFAULT, batch: { ...batch, state: { ...batch.state, depthRange: [0, 0.3] } },
          scratch: batch.vertices.map(vertex => ({ color: vertex.color, texCoord: vertex.texCoord, texCoord2: { x: 0, y: 0 },
            rawTexCoord: { ...vertex.texCoord }, rawTexCoord2: { x: 0, y: 0 } })) };
      };
      f.renderer.drawImmediate({ kind: "depth-range", range: [0, 0.3] });
      const first = source(f, stage(blue, 0)); first.draw(2); first.cleanup();
      expect(f.depth(10, 20)).toBeCloseTo(0.15, 6);
      debug(f, triangle(f.solid), 1);
      f.renderer.drawImmediate({ kind: "cull", cull: "none" }); f.renderer.drawImmediate({ kind: "polygon-offset", value: null });
      expect(f.integers(0xb40, 2)).toEqual([0x1b01, 0x1b01]);
      const second = source(f, stage(red, -0.5)); second.draw(2); second.cleanup();
      expect(f.current(0xb70, 2)).toEqual([0, 1]); expect(f.integers(0xb40, 2)).toEqual([0x1b02, 0x1b02]);
      expect(f.pixel(10, 20)).toEqual([0, 0, 255, 255]);
      f.renderer.drawImmediate({ kind: "depth-range", range: [0, 0.3] });
      const transitioned = source(f, stage(red, -0.5)); transitioned.draw(2); transitioned.cleanup(); expect(f.pixel(10, 20)).toEqual([255, 0, 0, 255]);
      direct(f, quad(f.solid)); expect(f.current(0xb70, 2)).toEqual([0, 1]);
      debug(f, { whiteImage: f.solid, positions: [], scratch: [], indices: [], allocation: { kind: "standalone" } }, -1);
      f.renderer.drawImmediate({ kind: "depth-range", range: [0.125, 0.375] });
      expect(f.integers(0xb40, 2)).toEqual([0x1b01, 0x1b01]);
      const volume = { kind: "shadow-volume", positions: [], indices: [], mirror: false, whiteImage: f.solid } satisfies Parameters<GlRenderer["drawImmediate"]>[0];
      f.renderer.drawImmediate(volume); expect(f.current(0xb70, 2)).toEqual([0.125, 0.375]);
      debug(f, { whiteImage: f.solid, positions: [], scratch: [], indices: [], allocation: { kind: "standalone" } }, -1);
      f.renderer.drawImmediate(volume); expect(f.current(0xb70, 2)).toEqual([0, 1]); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });
});
