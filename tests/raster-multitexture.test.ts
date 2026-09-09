// SPDX-License-Identifier: GPL-2.0-or-later
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
import type { MultitextureBatch, RenderState, SingleTextureBatch, TextureEnvironment, TextureSampling } from "../src/render/types.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { executeStaticBatch, publishTexture } from "./render-target-fixture.ts";

const white = vec4(1, 1, 1, 1), black = vec4(0, 0, 0, 0);
const state: RenderState = { ...OPAQUE_STATE, cull: "none" };
const nearest: TextureSampling = { wrap: "repeat", filter: "nearest" };
interface Pixels { readonly width: number; readonly height: number; readonly pixels: Uint8Array }
interface Fixture {
  readonly images: RendererImageCatalog;
  readonly cpu: SoftwareRenderer;
  readonly target: RenderTarget;
  readonly backends: readonly RendererBackend[];
}
function texture(r: number, g: number, b: number, a: number): Pixels {
  return { width: 1, height: 1, pixels: new Uint8Array([r, g, b, a]) };
}
function createCpu(): Fixture {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(8, 8, images), target = new RenderTarget(images, [cpu]);
  cpu.beginView({ viewport: { x: 0, y: 0, width: 8, height: 8 }, clear: { stencil: false, color: null, depth: 1 } });
  return { images, cpu, target, backends: [cpu] };
}
function publish(fixture: Fixture, source: Pixels, registrationUnit: 0 | 1, sampling: TextureSampling = nearest): RendererImage {
  return publishTexture(fixture.images, { name: "multitexture-fixture", width: source.width, height: source.height,
    pixels: source.pixels, internalFormat: "rgba8", sampling, registrationUnit });
}
function pairImages(fixture: Fixture, first: Pixels, second: Pixels,
  firstSampling: TextureSampling = nearest, secondSampling: TextureSampling = nearest): readonly [RendererImage, RendererImage] {
  return [publish(fixture, first, 1, firstSampling), publish(fixture, second, 0, secondSampling)];
}
function quad(first: RendererImage, second: RendererImage, environment: TextureEnvironment = "modulate", color = white): MultitextureBatch {
  return { texturing: "pair", primitive: "triangles", texture: { kind: "bind-image", image: first },
    secondTexture: { binding: { kind: "bind-image", image: second }, environment }, state,
    indices: [0, 1, 2, 0, 2, 3], vertices: [vec4(-1, 1, 0, 1), vec4(1, 1, 0, 1), vec4(1, -1, 0, 1), vec4(-1, -1, 0, 1)]
      .map(position => ({ position, color, texCoord: { x: 0.5, y: 0.5 }, texCoord2: { x: 0.5, y: 0.5 } })) };
}
function single(batch: MultitextureBatch, unit: 0 | 1): SingleTextureBatch {
  const common = { texturing: "single", texture: unit === 0 ? batch.texture : batch.secondTexture.binding,
    state: batch.state, indices: batch.indices,
    vertices: batch.vertices.map(vertex => ({ position: vertex.position, color: vertex.color, texCoord: unit === 0 ? vertex.texCoord : vertex.texCoord2 })) } satisfies Omit<SingleTextureBatch, "primitive">;
  return batch.primitive === "lines" ? { ...common, primitive: "lines", lineWidth: batch.lineWidth } : { ...common, primitive: "triangles" };
}
function begin(fixture: Fixture, color: Vec4): void {
  for (const backend of fixture.backends) backend.beginView({ viewport: { x: 0, y: 0, width: 8, height: 8 }, clear: { stencil: false, color, depth: 1 } });
}
function execute(fixture: Fixture, batch: MultitextureBatch | SingleTextureBatch): void {
  for (const backend of fixture.backends) executeStaticBatch(backend, batch);
}
function pixel(pixels: Uint8Array, width = 8, x = 4, y = 4): number[] {
  const offset = (y * width + x) * 4;
  return Array.from(pixels.subarray(offset, offset + 4));
}
function setBorder(fixture: Fixture, image: RendererImage, color: Vec4): void {
  const degenerate: SingleTextureBatch = { texturing: "single", primitive: "triangles", texture: { kind: "bind-image", image }, state,
    indices: [0, 1, 2], vertices: [vec4(0, 0, 0, 1), vec4(0, 0, 0, 1), vec4(0, 0, 0, 1)]
      .map(position => ({ position, color: white, texCoord: { x: 0, y: 0 } })) };
  execute(fixture, degenerate);
  fixture.images.setCurrentBorderColor(color);
}

test("two fixed-function texture environments combine before a single byte conversion", () => {
  const fixture = createCpu();
  const [first, second] = pairImages(fixture, texture(128, 192, 64, 128), texture(128, 128, 192, 64));
  const color = vec4(0.5, 0.25, 0.75, 0.5);
  // OpenGL 1.3 texture environment equations, RGBA row: ADD multiplies alpha.
  // https://registry.khronos.org/OpenGL/extensions/ARB/ARB_texture_env_add.txt
  for (const [environment, expected] of [["modulate", [32, 24, 36, 16]], ["add", [192, 176, 240, 16]], ["replace", [128, 128, 192, 64]]] satisfies readonly (readonly [TextureEnvironment, readonly number[]])[]) {
    begin(fixture, black); execute(fixture, quad(first, second, environment, color));
    expect(pixel(fixture.cpu.pixels)).toEqual(expected);
  }
  const [low, half] = pairImages(fixture, texture(1, 1, 1, 255), texture(128, 128, 128, 255));
  execute(fixture, quad(low, half, "modulate", vec4(0.5, 0.5, 0.5, 1)));
  expect(pixel(fixture.cpu.pixels)).toEqual([0, 0, 0, 255]);
  fixture.target.close();
});

test("overlapping coplanar triangles demonstrate why two sequential batches are not a collapsed pass", () => {
  const fixture = createCpu(), [first, second] = pairImages(fixture, texture(255, 255, 255, 255), texture(128, 128, 128, 255));
  const pair = quad(first, second), overlap = { ...pair, indices: [...pair.indices, ...pair.indices] };
  execute(fixture, overlap); expect(pixel(fixture.cpu.pixels)).toEqual([128, 128, 128, 255]);
  begin(fixture, black); execute(fixture, single(overlap, 0));
  execute(fixture, { ...single(overlap, 1), state: { ...state, depthWrite: false, blend: { source: "dst-color", destination: "zero" } } });
  expect(pixel(fixture.cpu.pixels)).toEqual([64, 64, 64, 255]);
  fixture.target.close();
});

test("combined alpha rejects before depth writes and blends only once", () => {
  const fixture = createCpu(), [red, alpha] = pairImages(fixture, texture(255, 0, 0, 255), texture(255, 255, 255, 64));
  const pair = quad(red, alpha);
  begin(fixture, vec4(0, 0, 1, 1)); execute(fixture, { ...pair, state: { ...state, alphaTest: "ge128" } });
  expect(pixel(fixture.cpu.pixels)).toEqual([0, 0, 255, 255]);
  const [green, whiteImage] = pairImages(fixture, texture(0, 255, 0, 255), texture(255, 255, 255, 255));
  const behind = single(quad(green, whiteImage), 0);
  execute(fixture, { ...behind, vertices: behind.vertices.map(vertex => ({ ...vertex, position: { ...vertex.position, z: 0.5 } })) });
  expect(pixel(fixture.cpu.pixels)).toEqual([0, 255, 0, 255]);
  begin(fixture, vec4(0, 0, 1, 1)); execute(fixture, { ...pair, state: { ...state, blend: { source: "src-alpha", destination: "one-minus-src-alpha" } } });
  expect(pixel(fixture.cpu.pixels)).toEqual([64, 0, 191, 207]);
  fixture.target.close();
});

test("each texture unit uses its own UVs, filter, wrap and border color", () => {
  const fixture = createCpu();
  const colors: Pixels = { width: 2, height: 1, pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]) };
  const [first, second] = pairImages(fixture, colors, colors, nearest, { wrap: "clamp", filter: "linear" });
  setBorder(fixture, first, vec4(0, 0, 1, 1)); setBorder(fixture, second, vec4(0, 0, 1, 1)); begin(fixture, black);
  const pair = quad(first, second, "add");
  execute(fixture, { ...pair, vertices: pair.vertices.map(vertex => ({ ...vertex,
    texCoord: { x: 1.25, y: 0.5 }, texCoord2: { x: 1, y: 0.5 } })) });
  expect(pixel(fixture.cpu.pixels)).toEqual([255, 128, 128, 255]);
  fixture.target.close();
});

test("secondary UVs remain perspective-correct through homogeneous clipping", () => {
  const fixture = createCpu(), colors = { width: 4, height: 1, pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]) };
  const [whiteImage, colorsImage] = pairImages(fixture, texture(255, 255, 255, 255), colors);
  const base = quad(whiteImage, colorsImage, "replace");
  const pair: MultitextureBatch = { ...base, indices: [0, 1, 2], vertices: [
    { position: vec4(-2, 1, 0, 1), color: white, texCoord: { x: 0, y: 0 }, texCoord2: { x: 0, y: 0.5 } },
    { position: vec4(2, 2, 0, 2), color: white, texCoord: { x: 0, y: 0 }, texCoord2: { x: 1, y: 0.5 } },
    { position: vec4(-4, -4, 0, 4), color: white, texCoord: { x: 0, y: 0 }, texCoord2: { x: 0, y: 0.5 } },
  ] };
  execute(fixture, pair);
  const expected = createCpu(), expectedImage = publish(expected, colors, 1);
  execute(expected, { ...single(pair, 1), texture: { kind: "bind-image", image: expectedImage } });
  expect(fixture.cpu.pixels).toEqual(expected.cpu.pixels);
  expect(pixel(fixture.cpu.pixels, 8, 3, 1)).toEqual([0, 255, 0, 255]);
  fixture.target.close(); expected.target.close();
});

test("paired wide lines clip and interpolate the second coordinate without changing coverage", () => {
  const fixture = createCpu(), colors = { width: 4, height: 1, pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]) };
  const [whiteImage, colorsImage] = pairImages(fixture, texture(255, 255, 255, 255), colors);
  const pair: MultitextureBatch = { ...quad(whiteImage, colorsImage, "replace"), primitive: "lines", lineWidth: 3, indices: [0, 1], vertices: [
    { position: vec4(-2, 0.125, 0, 1), color: white, texCoord: { x: 0, y: 0 }, texCoord2: { x: 0, y: 0.5 } },
    { position: vec4(2, 0.25, 0, 2), color: white, texCoord: { x: 0, y: 0 }, texCoord2: { x: 1, y: 0.5 } },
  ] };
  execute(fixture, pair);
  const expected = createCpu(), expectedImage = publish(expected, colors, 1);
  execute(expected, { ...single(pair, 1), texture: { kind: "bind-image", image: expectedImage } });
  expect(fixture.cpu.pixels).toEqual(expected.cpu.pixels);
  const colorsDrawn = new Set(Array.from({ length: 8 }, (_, x) => pixel(fixture.cpu.pixels, 8, x, 3).join(",")));
  expect(colorsDrawn.size).toBeGreaterThan(1);
  fixture.target.close(); expected.target.close();
});

test("paired fragments retain depth equality and disabled-write behavior", () => {
  const fixture = createCpu(), [first, second] = pairImages(fixture, texture(255, 255, 255, 255), texture(0, 255, 0, 255));
  const pair = quad(first, second), whiteImage = publish(fixture, texture(255, 255, 255, 255), 1);
  const atDepth = (color: Vec4, depth: number): SingleTextureBatch => ({ ...single(quad(whiteImage, whiteImage, "modulate", color), 0),
    vertices: pair.vertices.map(vertex => ({ position: { ...vertex.position, z: depth }, color, texCoord: vertex.texCoord })) });
  execute(fixture, atDepth(vec4(1, 0, 0, 1), 0));
  execute(fixture, { ...pair, state: { ...state, depthTest: "equal" } });
  expect(pixel(fixture.cpu.pixels)).toEqual([0, 255, 0, 255]);
  execute(fixture, { ...pair, state: { ...state, depthWrite: false }, vertices: pair.vertices.map(vertex => ({ ...vertex, position: { ...vertex.position, z: -0.5 } })) });
  execute(fixture, atDepth(vec4(0, 0, 1, 1), -0.25));
  expect(pixel(fixture.cpu.pixels)).toEqual([0, 0, 255, 255]);
  fixture.target.close();
});

test("secondary texture validation occurs before drawing and honors byte subviews", () => {
  const fixture = createCpu(), [whiteImage, red] = pairImages(fixture, texture(255, 255, 255, 255), texture(255, 0, 0, 255));
  const base = quad(whiteImage, red, "replace");
  expect(() => execute(fixture, { ...base, vertices: base.vertices.map(vertex => ({ ...vertex, texCoord2: { x: NaN, y: 0 } })) })).toThrow("finite");
  expect(() => publish(fixture, { width: 2, height: 1, pixels: new Uint8Array(4) }, 1)).toThrow("byte count");
  expect(fixture.cpu.pixels.every(value => value === 0)).toBe(true);
  const bytes = new Uint8Array([19, 20, 21, 22, 17, 33, 65, 255, 23, 24]);
  const subview = publish(fixture, { width: 1, height: 1, pixels: bytes.subarray(4, 8) }, 0);
  execute(fixture, { ...base, secondTexture: { ...base.secondTexture, binding: { kind: "bind-image", image: subview } } });
  expect(pixel(fixture.cpu.pixels)).toEqual([17, 33, 65, 255]);
  const [value, whiteAgain] = pairImages(fixture, texture(17, 33, 65, 255), texture(255, 255, 255, 255));
  execute(fixture, quad(value, whiteAgain, "replace")); expect(pixel(fixture.cpu.pixels)).toEqual([255, 255, 255, 255]);
  fixture.target.close();
});

test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("actual GL matches two-unit combination, blending, overlap, sampler independence and single-unit restoration", () => {
  const window = SdlWindow.open({ title: "Single-pass multitexture", width: 8, height: 8, backend: "gl", hidden: true });
  const images = new RendererImageCatalog(), gl = new GlRenderer(window, images), cpu = new SoftwareRenderer(8, 8, images, gl.subpixelBits);
  gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  const target = new RenderTarget(images, [cpu, gl]), fixture: Fixture = { images, cpu, target, backends: [cpu, gl] };
  try {
    const [first, second] = pairImages(fixture, texture(128, 192, 64, 128), texture(128, 128, 192, 64));
    const environments: readonly TextureEnvironment[] = ["modulate", "add", "replace"];
    const cases = environments.map(environment => quad(first, second, environment, vec4(0.5, 0.25, 0.75, 0.5)));
    const [alphaFirst, alphaSecond] = pairImages(fixture, texture(255, 0, 0, 255), texture(255, 255, 255, 64));
    const alphaPair = quad(alphaFirst, alphaSecond);
    cases.push({ ...alphaPair, state: { ...state, blend: { source: "src-alpha", destination: "one-minus-src-alpha" } } });
    cases.push({ ...alphaPair, state: { ...state, alphaTest: "ge128" } });
    cases.push({ ...alphaPair, indices: [...alphaPair.indices, ...alphaPair.indices] });
    const [low, half] = pairImages(fixture, texture(1, 1, 1, 255), texture(128, 128, 128, 255));
    cases.push(quad(low, half, "modulate", vec4(0.5, 0.5, 0.5, 1)));
    const [addFirst, addWhite] = pairImages(fixture, texture(128, 192, 64, 128), texture(255, 255, 255, 255));
    cases.push(quad(addFirst, addWhite, "add"), quad(addFirst, addWhite, "replace"));
    const sharedPixels: Pixels = { width: 2, height: 1, pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]) };
    const [sharedFirst, sharedSecond] = pairImages(fixture, sharedPixels, sharedPixels, nearest, { wrap: "clamp", filter: "linear" });
    setBorder(fixture, sharedFirst, vec4(0, 0, 1, 1)); setBorder(fixture, sharedSecond, vec4(0, 0, 1, 1));
    const sharedPair = quad(sharedFirst, sharedSecond, "add");
    cases.push({ ...sharedPair, vertices: sharedPair.vertices.map(vertex => ({ ...vertex, texCoord: { x: 1.25, y: 0.5 }, texCoord2: { x: 1, y: 0.5 } })) });
    const [linearFirst, linearSecond] = pairImages(fixture, sharedPixels, sharedPixels,
      { wrap: "repeat", filter: "linear" }, { wrap: "repeat", filter: "linear" });
    const linearPair = quad(linearFirst, linearSecond);
    cases.push({ ...linearPair, indices: [0, 1, 2], vertices: [
      { position: vec4(-2, 1, 0, 1), color: white, texCoord: { x: 0.25, y: 0.5 }, texCoord2: { x: 0.75, y: 0.5 } },
      { position: vec4(2, 2, 0, 2), color: white, texCoord: { x: 0.75, y: 0.5 }, texCoord2: { x: 0.25, y: 0.5 } },
      { position: vec4(-4, -4, 0, 4), color: white, texCoord: { x: 0.25, y: 0.5 }, texCoord2: { x: 0.75, y: 0.5 } },
    ] });
    cases.push({ ...quad(first, second), primitive: "lines", lineWidth: 3, indices: [0, 1], vertices: [
      { position: vec4(-0.7, 0.1, 0, 1), color: white, texCoord: { x: 0.5, y: 0.5 }, texCoord2: { x: 0.5, y: 0.5 } },
      { position: vec4(0.7, 0.1, 0, 1), color: white, texCoord: { x: 0.5, y: 0.5 }, texCoord2: { x: 0.5, y: 0.5 } },
    ] });
    for (const batch of cases) {
      const background = vec4(0, 0, 1, 1); begin(fixture, background); execute(fixture, batch);
      const actual = gl.readPixels(); let maximum = 0;
      for (const [index, value] of actual.entries()) {
        const expected = cpu.pixels[index]; if (expected === undefined) throw new Error("Missing CPU channel");
        maximum = Math.max(maximum, Math.abs(value - expected));
      }
      expect(maximum).toBeLessThanOrEqual(1);
      const [value, whiteImage] = pairImages(fixture, texture(17, 33, 65, 255), texture(255, 255, 255, 255));
      execute(fixture, single(quad(value, whiteImage), 0));
      expect(pixel(gl.readPixels())).toEqual([17, 33, 65, 255]);
    }
  } finally { target.close(); window.close(); }
});
