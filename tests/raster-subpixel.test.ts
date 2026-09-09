import { expect, test } from "bun:test";
import { vec4 } from "../src/core/math.ts";
import type { Vec4 } from "../src/core/math.ts";
import { RenderTarget } from "../src/render/commands.ts";
import type { RendererBackend } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import type { DrawBatch, SingleTextureBatch } from "../src/render/types.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { executeStaticBatch, publishTexture } from "./render-target-fixture.ts";

const f = Math.fround;
function whiteImage(images: RendererImageCatalog): RendererImage {
  return publishTexture(images, { name: "subpixel-white", width: 1, height: 1,
    pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgb8",
    sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 1 });
}
function rectangle(image: RendererImage, x: number, width = 13.5): SingleTextureBatch {
  const left = f(x), top = f(96), right = f(left + f(width)), bottom = f(top + f(20.25));
  const vertex = (px: number, py: number, u: number, v: number) => ({
    position: { x: f(px * 2 / 640 - 1), y: f(1 - py * 2 / 480), z: -1, w: 1 },
    texCoord: { x: u, y: v }, color: vec4(1, 1, 1, 1),
  });
  return { texturing: "single", primitive: "triangles", texture: { kind: "bind-image", image },
    state: { ...OPAQUE_STATE, cull: "none" }, indices: [3, 0, 2, 2, 0, 1],
    vertices: [vertex(left, top, 0, 0), vertex(right, top, 1, 0),
      vertex(right, bottom, 1, 1), vertex(left, bottom, 0, 1)] };
}
function begin(backend: RendererBackend, width: number, height: number, color: Vec4,
  viewport = { x: 0, y: 0, width, height }): void {
  backend.beginView({ viewport, clear: { stencil: false, depth: 1, color } });
}
function covered(pixels: Uint8Array): boolean { return pixels[(98 * 640 + 443) * 4] === 255; }

test("CPU coverage retains the half-pixel edge after float32 clip-space storage", () => {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(640, 480, images);
  const target = new RenderTarget(images, [cpu]), image = whiteImage(images);
  begin(cpu, 640, 480, vec4(0, 0, 0, 1)); executeStaticBatch(cpu, rectangle(image, 443.5));
  expect(covered(cpu.pixels)).toBe(true);
  target.close();
});

test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("actual GL snaps coverage around its reported subpixel grid", () => {
  const window = SdlWindow.open({ title: "Subpixel rasterization", width: 640, height: 480, backend: "gl", hidden: true });
  const images = new RendererImageCatalog(), gl = new GlRenderer(window, images);
  gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  const cpu = new SoftwareRenderer(640, 480, images, gl.subpixelBits), target = new RenderTarget(images, [cpu, gl]), image = whiteImage(images);
  try {
    const step = 2 ** -gl.subpixelBits;
    for (const [fraction, expected] of [[-0.5, true], [0, true], [0.25, true], [0.5, true], [0.75, false], [1.5, false]] satisfies readonly (readonly [number, boolean])[]) {
      begin(gl, 640, 480, vec4(0, 0, 0, 1)); begin(cpu, 640, 480, vec4(0, 0, 0, 1));
      const batch = rectangle(image, 443.5 + step * fraction);
      executeStaticBatch(gl, batch); executeStaticBatch(cpu, batch);
      expect(covered(gl.readPixels())).toBe(expected);
      expect(cpu.pixels).toEqual(gl.readPixels());
    }
  } finally { target.close(); window.close(); }
});

test("explicit four-bit and eight-bit profiles use their own coverage grids and reject unsupported precision", () => {
  for (const bits of [4, 8]) {
    const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(640, 480, images, bits);
    const target = new RenderTarget(images, [cpu]), image = whiteImage(images);
    for (const [fraction, expected] of [[0.25, true], [0.75, false]] satisfies readonly (readonly [number, boolean])[]) {
      begin(cpu, 640, 480, vec4(0, 0, 0, 1)); executeStaticBatch(cpu, rectangle(image, 443.5 + 2 ** -bits * fraction));
      expect(covered(cpu.pixels)).toBe(expected);
    }
    target.close();
  }
  expect(() => new SoftwareRenderer(16, 16, new RendererImageCatalog(), 3)).toThrow("subpixel");
  expect(() => new SoftwareRenderer(16, 16, new RendererImageCatalog(), 17)).toThrow("subpixel");
});

test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("actual GL interpolates color from snapped triangle endpoints", () => {
  const window = SdlWindow.open({ title: "Snapped interpolation", width: 640, height: 480, backend: "gl", hidden: true });
  const images = new RendererImageCatalog(), gl = new GlRenderer(window, images);
  gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  const cpu = new SoftwareRenderer(640, 480, images, gl.subpixelBits), target = new RenderTarget(images, [cpu, gl]), image = whiteImage(images);
  try {
    const base = rectangle(image, 443.49, 0.015);
    const batch: SingleTextureBatch = { ...base, vertices: base.vertices.map((vertex, index) => ({ ...vertex,
      color: vec4(index === 1 || index === 2 ? 1 : 0, 0, 0, 1) })) };
    begin(cpu, 640, 480, vec4(0, 0, 0, 1)); begin(gl, 640, 480, vec4(0, 0, 0, 1));
    executeStaticBatch(cpu, batch); executeStaticBatch(gl, batch);
    const native = gl.readPixels(), offset = (98 * 640 + 443) * 4;
    expect(native[offset]).toBe(191); expect(cpu.pixels[offset]).toBe(191);
    expect(cpu.pixels).toEqual(native);
  } finally { target.close(); window.close(); }
});

test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("CPU and native GL distinguish lower and upper edges and collapse the original sub-float32 triangle", () => {
  const window = SdlWindow.open({ title: "Subpixel thin triangles", width: 8, height: 8, backend: "gl", hidden: true });
  const images = new RendererImageCatalog(), gl = new GlRenderer(window, images);
  gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  const cpu = new SoftwareRenderer(8, 8, images, gl.subpixelBits), target = new RenderTarget(images, [cpu, gl]), image = whiteImage(images);
  try {
    for (const thickness of [2 ** -30, 2 ** -10, -(2 ** -10)]) {
      const batch: DrawBatch = { texturing: "single", primitive: "triangles", texture: { kind: "bind-image", image }, state: { ...OPAQUE_STATE, cull: "none" }, indices: [0, 1, 2],
        vertices: [[-0.875, 0.875], [0.875, 0.875], [-0.875, 0.875 - thickness]].map(([x, y]) => {
          if (x === undefined || y === undefined) throw new Error("thin triangle fixture coordinate missing");
          return { position: vec4(x, y, 0, 1), texCoord: { x: 0, y: 0 }, color: vec4(1, 1, 1, 1) };
        }) };
      begin(cpu, 8, 8, vec4(0, 0, 0, 0)); begin(gl, 8, 8, vec4(0, 0, 0, 0));
      executeStaticBatch(cpu, batch); executeStaticBatch(gl, batch);
      const native = gl.readPixels(); expect(cpu.pixels).toEqual(native);
      for (let x = 0; x < 8; x++) expect(native[x * 4]).toBe(thickness >= 0 || x === 7 ? 0 : 255);
    }
  } finally { target.close(); window.close(); }
});

test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("negative viewport origins and clipped triangles retain shared-edge coverage on the native grid", () => {
  const window = SdlWindow.open({ title: "Negative subpixel coordinates", width: 16, height: 16, backend: "gl", hidden: true });
  const images = new RendererImageCatalog(), gl = new GlRenderer(window, images);
  gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  const cpu = new SoftwareRenderer(16, 16, images, gl.subpixelBits), target = new RenderTarget(images, [cpu, gl]), image = whiteImage(images);
  try {
    for (const shift of [-0.5, 0.5, 1.5]) {
      const left = f(2.5 + shift * 2 ** -gl.subpixelBits), top = f(2.5), right = f(left + 12), bottom = f(top + 10);
      const vertex = (x: number, y: number) => ({ position: { x: f(x * 2 / 16 - 1), y: f(1 - y * 2 / 16), z: -1, w: 1 },
        texCoord: { x: 0, y: 0 }, color: vec4(1, 1, 1, 1) });
      const batch: SingleTextureBatch = { texturing: "single", primitive: "triangles", texture: { kind: "bind-image", image },
        state: { ...OPAQUE_STATE, cull: "none" }, indices: [3, 0, 2, 2, 0, 1],
        vertices: [vertex(left, top), vertex(right, top), vertex(right, bottom), vertex(left, bottom)] };
      const viewport = { x: -4, y: -4, width: 16, height: 16 };
      begin(cpu, 16, 16, vec4(0, 0, 0, 0), viewport); begin(gl, 16, 16, vec4(0, 0, 0, 0), viewport);
      executeStaticBatch(cpu, batch); executeStaticBatch(gl, batch);
      expect(cpu.pixels).toEqual(gl.readPixels());
    }
  } finally { target.close(); window.close(); }
});

test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("opposite shared-edge sides cover once under winding reversal and shifted viewports", () => {
  const window = SdlWindow.open({ title: "Shared snapped edges", width: 8, height: 8, backend: "gl", hidden: true });
  const images = new RendererImageCatalog(), gl = new GlRenderer(window, images);
  gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  const cpu = new SoftwareRenderer(8, 8, images, gl.subpixelBits), target = new RenderTarget(images, [cpu, gl]), image = whiteImage(images);
  try {
    for (const origin of [0, -2]) for (const reversed of [false, true]) {
      const size = origin === 0 ? 8 : 12, left = f(0.5 - origin), top = f(0.5 - origin), right = f(left + 7), bottom = f(top + 7);
      const quarter = Math.trunc(f(0.25 * 255)) / 255;
      const vertex = (x: number, y: number) => ({ position: { x: f(x * 2 / size - 1), y: f(1 - y * 2 / size), z: -1, w: 1 },
        texCoord: { x: 0, y: 0 }, color: vec4(quarter, quarter, quarter, quarter) });
      const batch: SingleTextureBatch = { texturing: "single", primitive: "triangles", texture: { kind: "bind-image", image },
        state: { ...OPAQUE_STATE, cull: "none", depthTest: "always", depthWrite: false, blend: { source: "one", destination: "one" } },
        indices: reversed ? [2, 0, 3, 1, 0, 2] : [3, 0, 2, 2, 0, 1],
        vertices: [vertex(left, top), vertex(right, top), vertex(right, bottom), vertex(left, bottom)] };
      const viewport = { x: origin, y: origin, width: size, height: size };
      begin(cpu, 8, 8, vec4(0, 0, 0, 0), viewport); begin(gl, 8, 8, vec4(0, 0, 0, 0), viewport);
      executeStaticBatch(cpu, batch); executeStaticBatch(gl, batch);
      const native = gl.readPixels(); expect(cpu.pixels).toEqual(native);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) expect(native[(y * 8 + x) * 4]).toBe(y > 0 && x < 7 ? 63 : 0);
    }
  } finally { target.close(); window.close(); }
});
