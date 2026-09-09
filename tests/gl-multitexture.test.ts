// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import type { MultitextureBatch, TextureEnvironment, TextureSampling } from "../src/render/types.ts";
import { RendererImageCatalog, RgbaSnapshot } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { executeStaticBatch as draw, publishTexture } from "./render-target-fixture.ts";

const enabled = process.env["QUAKE_GL_TEST"] === "1";
const full = { x: 1, y: 1, z: 1, w: 1 };
function publish(renderer: GlRenderer, pixels: Uint8Array, width: number, height: number,
  sampling: TextureSampling = { wrap: "repeat", filter: "nearest" }): RendererImage {
  return publishTexture(renderer.images, { name: "multitexture fixture", width, height, pixels, sampling, internalFormat: "rgba8", registrationUnit: 0 });
}
function solid(renderer: GlRenderer, red: number, green: number, blue: number, alpha = 255): RendererImage {
  return publish(renderer, new Uint8Array([red, green, blue, alpha]), 1, 1);
}
function pair(environment: TextureEnvironment, texture: RendererImage, second: RendererImage): MultitextureBatch {
  return { texturing: "pair", primitive: "triangles",
    texture: { kind: "bind-image", image: texture },
    secondTexture: { binding: { kind: "bind-image", image: second }, environment },
    state: { ...OPAQUE_STATE, cull: "none", depthTest: "always", depthWrite: false },
    vertices: [{ x: -1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: -1 }].map(position => ({
      position: { ...position, z: 0, w: 1 }, color: full, texCoord: { x: 0.5, y: 0.5 }, texCoord2: { x: 0.5, y: 0.5 } })),
    indices: [3, 0, 2, 2, 0, 1] };
}
function withRenderer(run: (renderer: GlRenderer, alpha: (value: number) => number) => void): void {
  const window = SdlWindow.open({ title: "Fixed-function multitexture", width: 16, height: 16, backend: "gl", hidden: true });
  const images = new RendererImageCatalog(), renderer = new GlRenderer(window, images), session = images.openSession();
  renderer.initializeDefaultState(renderer.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  session.attach(renderer); session.beginExecution();
  renderer.beginView({ viewport: { x: 0, y: 0, width: 16, height: 16 }, clear: { stencil: false, depth: 1, color: { x: 0, y: 0, z: 0, w: 0 } } });
  const bits = renderer.alphaBits, maximum = 2 ** bits - 1;
  try { run(renderer, value => bits === 0 ? 255 : Math.round(Math.round(value * maximum / 255) * 255 / maximum)); }
  finally { session.close(); renderer.close(); window.close(); }
}
function pixel(renderer: GlRenderer): readonly number[] { return Array.from(renderer.readPixels().slice((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4)); }

test.skipIf(!enabled)("actual GL evaluates MODULATE, ADD and REPLACE with source RGBA equations", () => withRenderer((renderer, alpha) => {
  expect(renderer.capabilities.textureUnits).toBeGreaterThanOrEqual(2); expect(renderer.capabilities.textureEnvAdd).toBe(true);
  const cases: readonly { readonly environment: TextureEnvironment; readonly expected: readonly number[] }[] = [
    { environment: "modulate", expected: [16, 8, 24, alpha(16)] }, { environment: "add", expected: [128, 144, 223, alpha(16)] }, { environment: "replace", expected: [64, 128, 32, alpha(64)] },
  ];
  for (const row of cases) {
    const batch = pair(row.environment, solid(renderer, 128, 64, 255, 128), solid(renderer, 64, 128, 32, 64));
    draw(renderer, { ...batch, vertices: batch.vertices.map(vertex => ({ ...vertex, color: { x: 0.5, y: 0.25, z: 0.75, w: 0.5 } })) });
    expect(pixel(renderer)).toEqual(row.expected);
  }
}));

test.skipIf(!enabled)("distinct registered images retain independent sampling and explicit uploads update both units", () => withRenderer(renderer => {
  const pixels = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]);
  const repeat = publish(renderer, pixels, 2, 1), clamp = publish(renderer, pixels, 2, 1, { wrap: "clamp", filter: "linear" });
  const original = pair("modulate", repeat, clamp);
  const batch: MultitextureBatch = { ...original,
    vertices: original.vertices.map(vertex => ({ ...vertex, texCoord: { x: 0, y: 0.5 }, texCoord2: { x: 0, y: 0.5 } })) };
  draw(renderer, batch);
  const first = pixel(renderer);
  expect(first[0]).toBeGreaterThanOrEqual(127); expect(first[0]).toBeLessThanOrEqual(128);
  expect(first[1]).toBe(0); expect(first[2]).toBe(0);
  pixels.set([0, 255, 0, 255], 0);
  draw(renderer, batch);
  expect(pixel(renderer)).toEqual(first);
  const prepared = renderer.prepareGeometry(batch); prepared.begin();
  for (const [unit, image] of [[0, repeat], [1, clamp]] satisfies readonly [0 | 1, RendererImage][]) {
    prepared.applyTexture(unit, { kind: "cinematic-upload", upload: { image, sourceWidth: 2, sourceHeight: 1, uploadWidth: 2, uploadHeight: 1,
      content: new RgbaSnapshot(2, 1, pixels), dirty: true } });
  }
  prepared.draw(); prepared.cleanup();
  const second = pixel(renderer);
  expect(second[0]).toBe(0); expect(second[1]).toBeGreaterThanOrEqual(127); expect(second[1]).toBeLessThanOrEqual(128);
}));

test.skipIf(!enabled)("UV2 is independent and unit1 is disabled before the next single-texture draw", () => withRenderer(renderer => {
  const image = publish(renderer, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]), 2, 1), white = solid(renderer, 255, 255, 255);
  const original = pair("replace", white, image);
  draw(renderer, { ...original, vertices: original.vertices.map(vertex => ({ ...vertex, texCoord: { x: 0.25, y: 0.5 }, texCoord2: { x: 0.75, y: 0.5 } })) });
  expect(pixel(renderer)).toEqual([0, 255, 0, 255]);
  draw(renderer, { texturing: "single", primitive: "triangles", texture: { kind: "bind-image", image: white }, state: original.state, indices: original.indices,
    vertices: original.vertices.map(vertex => ({ position: vertex.position, texCoord: vertex.texCoord, color: { x: 0, y: 0, z: 1, w: 1 } })) });
  expect(pixel(renderer)).toEqual([0, 0, 255, 255]);
  draw(renderer, pair("replace", image, white));
  expect(pixel(renderer)).toEqual([255, 255, 255, 255]);
}));

test.skipIf(!enabled)("alpha test observes combined alpha, not the first texture's alpha", () => withRenderer((renderer, alpha) => {
  renderer.beginView({ viewport: { x: 0, y: 0, width: 16, height: 16 }, clear: { stencil: false, depth: 1, color: { x: 0, y: 0, z: 1, w: 1 } } });
  const batch = pair("add", solid(renderer, 255, 0, 0, 128), solid(renderer, 0, 255, 0, 128));
  draw(renderer, { ...batch, state: { ...batch.state, alphaTest: "ge128" } });
  expect(pixel(renderer)).toEqual([0, 0, 255, 255]);
  draw(renderer, { ...batch, state: { ...batch.state, alphaTest: "lt128" } });
  expect(pixel(renderer)).toEqual([255, 255, 0, alpha(64)]);
}));

test.skipIf(!enabled)("two alternating GL contexts retain independent unit state and native texture caches", () => {
  withRenderer(first => withRenderer(second => {
    draw(first, pair("add", solid(first, 128, 0, 0), solid(first, 0, 64, 0)));
    draw(second, pair("modulate", solid(second, 0, 255, 0), solid(second, 255, 0, 0)));
    expect(pixel(first)).toEqual([128, 64, 0, 255]); expect(pixel(second)).toEqual([0, 0, 0, 255]);
    draw(first, pair("replace", solid(first, 255, 255, 255), solid(first, 0, 0, 255)));
    expect(pixel(first)).toEqual([0, 0, 255, 255]);
  }));
});
