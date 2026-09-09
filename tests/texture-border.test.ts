// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import type { Vec4 } from "../src/core/math.ts";
import type { DrawBatch, TextureSampling } from "../src/render/types.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";

import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { BatchRecordingBackend, publishTexture } from "./render-target-fixture.ts";

const WHITE: Vec4 = { x: 1, y: 1, z: 1, w: 1 };
function fixture(gl: GlRenderer | null = null) {
  const images = gl === null ? new RendererImageCatalog() : gl.images;
  const cpu = new SoftwareRenderer(1, 1, images, gl === null ? 8 : gl.subpixelBits), recorder = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, gl === null ? [recorder] : [recorder, gl]);
  const queue = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
    tess: new SourceTessState(), runtime: { smpRequested: false, skipBackEnd: false, speeds: 0, clear: false, measureOverdraw: 0, showImages: 0, debugSort: 0, showTris: 0, showNormals: 0, primitives: 0, finish: 0, logFile: 0, lightmap: false, vertexLighting: false, polygonOffset: { factor: -1, units: -2 } } });
  const guard = publishTexture(images, { name: "binding-guard", width: 1, height: 1, pixels: new Uint8Array([255,255,255,255]),
    internalFormat: "rgba8", sampling: { filter: "nearest", wrap: "repeat" }, registrationUnit: 0 });
  function sample(image: RendererImage, u: number, v: number): Uint8Array {
    queue.addView({ viewport: { x: 0, y: 0, width: 1, height: 1 }, clear: { stencil: false, color: null, depth: 1 },
      operations: [{ kind: "draw", batches: [batch(guard, .5, .5), batch(image, u, v)] }] });
    const before = recorder.trace().flatMap(view => view.batches).length;
    expect(queue.submit().batches).toBe(2);
    expect(recorder.trace().flatMap(view => view.batches).length - before).toBe(2);
    if (gl !== null) expected(gl.readPixels(), [...cpu.pixels], 1);
    return gl === null ? cpu.pixels : gl.readPixels();
  }
  function texture(borderColor: Vec4 | undefined, filter: TextureSampling["filter"] = "linear",
    wrap: TextureSampling["wrap"] = "clamp", width = 1, height = 1, pixels = new Uint8Array([0,0,0,0])): RendererImage {
    const image = publishTexture(images, { name: "sampling-fixture", width, height, pixels,
      internalFormat: "rgba8", sampling: { filter, wrap }, registrationUnit: 0 });
    sample(image, .5, .5);
    if (borderColor !== undefined) images.setCurrentBorderColor(borderColor);
    return image;
  }
  return { images, cpu, recorder, target, queue, sample, texture, guard };
}
function batch(image: RendererImage, u: number, v: number): DrawBatch {
  return { texturing: "single", primitive: "triangles", indices: [0, 1, 2, 0, 2, 3],
    texture: { kind: "bind-image", image },
    state: { ...OPAQUE_STATE, cull: "none", depthTest: "always", depthWrite: false },
    vertices: [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(point => {
      const [x, y] = point; if (x === undefined || y === undefined) throw new Error("Missing quad corner");
      return { position: { x, y, z: 0, w: 1 }, texCoord: { x: u, y: v }, color: WHITE };
    }) };
}
function expected(actual: Uint8Array, values: readonly number[], tolerance = 0): void {
  for (const [index, value] of values.entries()) {
    const channel = actual[index]; if (channel === undefined) throw new Error("Missing framebuffer channel");
    expect(Math.abs(channel - value)).toBeLessThanOrEqual(tolerance);
  }
}
function analytic(f: ReturnType<typeof fixture>, tolerance = 0): void {
  const white = f.texture(WHITE), empty = f.texture(undefined);
  expected(f.sample(white, 0.5, 0.5), [0, 0, 0, 0], tolerance);
  for (const [u, v] of [[0, 0.5], [1, 0.5], [0.5, 0], [0.5, 1], [-10, 0.5], [10, 0.5]] satisfies readonly (readonly [number, number])[]) {
    expected(f.sample(white, u, v), [128, 128, 128, 128], tolerance);
    expected(f.sample(empty, u, v), [0, 0, 0, 0], tolerance);
  }
  for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [-10, 10], [10, -10]] satisfies readonly (readonly [number, number])[]) {
    expected(f.sample(white, u, v), [191, 191, 191, 191], tolerance);
    expected(f.sample(empty, u, v), [0, 0, 0, 0], tolerance);
  }
  const colored = f.texture({ x: 0.2, y: 0.4, z: 0.6, w: 0.8 });
  expected(f.sample(colored, 0, 0), [38, 77, 115, 153], tolerance);
  expected(f.sample(colored, 0, 0.5), [26, 51, 77, 102], tolerance);
  const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 64, 0, 0, 0, 0]);
  const image = f.texture(WHITE, "linear", "clamp", 2, 2, pixels), nearest = f.texture(WHITE, "nearest", "clamp", 2, 2, pixels);
  expected(f.sample(image, 0.25, 0.25), [255, 0, 0, 255], tolerance);
  expected(f.sample(image, 0.5, 0.5), [64, 64, 64, 112], tolerance);
  expected(f.sample(image, 0, 0.25), [255, 128, 128, 255], tolerance);
  expected(f.sample(nearest, -8, 3), [0, 0, 255, 64], tolerance);
  expected(f.sample(nearest, 2, -8), [0, 255, 0, 128], tolerance);
  expected(f.sample(nearest, 0.75, 0.75), [0, 0, 0, 0], tolerance);
  for (const filter of ["nearest", "linear"] satisfies readonly TextureSampling["filter"][]) {
    expected(f.sample(f.texture(WHITE, filter, "repeat"), -10, 20), [0, 0, 0, 0], tolerance);
    expected(f.sample(f.texture(WHITE, "nearest", "clamp"), -10, 20), [0, 0, 0, 0], tolerance);
  }
}
function mutations(f: ReturnType<typeof fixture>, tolerance = 0): void {
  const color = { x: 1, y: 1, z: 1, w: 1 }, pixels = new Uint8Array([0,0,0,0]);
  const image = f.texture(color, "linear", "clamp", 1, 1, pixels), omitted = f.texture(undefined);
  expected(f.sample(image, 0, .5), [128,128,128,128], tolerance);
  expected(f.sample(omitted, 0, .5), [0,0,0,0], tolerance);
  expected(f.sample(image, 0, .5), [128,128,128,128], tolerance);
  color.y = 0; color.z = 0;
  // Publication copies caller data. Only an explicit current-object operation changes GL state.
  expected(f.sample(image, 0, .5), [128,128,128,128], tolerance);
  f.images.setCurrentBorderColor(color);
  expected(f.sample(image, 0, .5), [128,0,0,128], tolerance);
  f.images.setCurrentBorderColor({ x: 0, y: 1, z: 0, w: 0 });
  expected(f.sample(image, 0, .5), [0,128,0,0], tolerance);
  f.images.setCurrentBorderColor({ x: 0, y: 0, z: 0, w: 0 });
  expected(f.sample(image, 0, .5), [0,0,0,0], tolerance);
  f.images.setCurrentBorderColor(WHITE);
  expected(f.sample(image, 0, .5), [128,128,128,128], tolerance);
  expected(f.sample(f.guard, 0, .5), [255,255,255,255], tolerance);
  expected(f.sample(omitted, 0, .5), [0,0,0,0], tolerance);
  expected(f.sample(image, 0, .5), [128,128,128,128], tolerance);
  pixels.set([255,0,0,255]);
  expected(f.sample(image, 0, .5), [128,128,128,128], tolerance);
  const red = f.texture(WHITE, "linear", "clamp", 1, 1, pixels);
  expected(f.sample(red, 0, .5), [255,128,128,255], tolerance);
  const resized = f.texture(WHITE, "linear", "clamp", 2, 1, new Uint8Array([0,0,255,0,0,255,0,0]));
  expected(f.sample(resized, 0, .5), [128,128,255,128], tolerance);
  f.images.setCurrentBorderColor({ x: 0, y: 0, z: 0, w: 0 });
  expected(f.sample(resized, 0, .5), [0,0,128,0], tolerance);
}
function invalid(f: ReturnType<typeof fixture>): void {
  for (const channel of [NaN, Infinity, -Infinity, -.1, 1.1]) {
    for (const color of [{ ...WHITE, x: channel }, { ...WHITE, y: channel }, { ...WHITE, z: channel }, { ...WHITE, w: channel }]) {
      expect(() => f.images.setCurrentBorderColor(color)).toThrow();
    }
  }
}

test("CPU GL_CLAMP samples exact texture border contributions at edges/corners; repeat and nearest stay source-correct", () => {
  const f = fixture(); try { analytic(f); } finally { f.target.close(); }
});
test("CPU border operations retain actual per-object state and image publication owns immutable bytes", () => {
  const f = fixture(); try { mutations(f); } finally { f.target.close(); }
});
test("CPU rejects non-finite or non-normalized border colors at the resource boundary", () => {
  const f = fixture(); try { invalid(f); } finally { f.target.close(); }
});
test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("actual OpenGL border parameters match analytic filtering, publication ownership and current-object operations", () => {
  const window = SdlWindow.open({ title: "Texture border colors", width: 1, height: 1, backend: "gl", hidden: true });
  const images = new RendererImageCatalog(), gl = new GlRenderer(window, images);
  gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  const f = fixture(gl);
  try { analytic(f, 1); mutations(f, 1); invalid(f); } finally { f.target.close(); window.close(); }
});
