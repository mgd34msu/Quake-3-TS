// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { loadGl } from "../src/platform/gl.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import type { SingleTextureBatch, TextureBinding, TextureSampling } from "../src/render/types.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { executeStaticBatch as draw, publishTexture } from "./render-target-fixture.ts";

const sampling: TextureSampling = { wrap: "repeat", filter: "nearest" };
function quad(texture: TextureBinding): SingleTextureBatch {
  return { texturing: "single", primitive: "triangles", texture, indices: [0, 1, 2, 0, 2, 3],
    state: { ...OPAQUE_STATE, cull: "none", depthTest: "always" },
    vertices: [{ x: -1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: -1 }].map(position => ({
      position: { ...position, z: 0, w: 1 }, texCoord: { x: 0.5, y: 0.5 }, color: { x: 0.25, y: 0.5, z: 0.75, w: 0.5 } })) };
}

test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("R_CreateImage raw unbind preserves source cache while actual native binding remains zero", () => {
  const window = SdlWindow.open({ title: "Source image registration state", width: 8, height: 8, backend: "gl", hidden: true });
  const images = new RendererImageCatalog(), renderer = new GlRenderer(window, images), native = loadGl(window), session = images.openSession();
  renderer.initializeDefaultState(renderer.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  session.attach(renderer); session.beginExecution();
  const white = publishTexture(images, { name: "white", width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]), sampling, internalFormat: "rgba8", registrationUnit: 0 });
  const image = publishTexture(images, { name: "red", width: 1, height: 1, pixels: new Uint8Array([255, 0, 0, 255]), sampling, internalFormat: "rgba8", registrationUnit: 0 });
  const binding: TextureBinding = { kind: "bind-image", image };
  renderer.beginView({ viewport: { x: 0, y: 0, width: 8, height: 8 }, clear: { stencil: false, depth: 1, color: { x: 0, y: 0, z: 0, w: 0 } } });
  const actualBinding = (): number => {
    const value = new Int32Array(1);
    native.symbols.glGetIntegerv(0x8069, value);
    const name = value[0]; if (name === undefined) throw new Error("Native texture query is missing");
    return name;
  };
  const pixel = (): number[] => Array.from(renderer.readPixels().slice((4 * 8 + 4) * 4, (4 * 8 + 5) * 4));
  const bits = renderer.alphaBits, maximum = 2 ** bits - 1;
  const alpha = (value: number): number => bits === 0 ? 255 : Math.round(Math.round(value * maximum / 255) * 255 / maximum);
  try {
    expect(actualBinding()).toBe(0);
    draw(renderer, quad(binding));
    expect(actualBinding()).toBe(0);
    expect(pixel()).toEqual([64, 127, 191, alpha(127)]);
    draw(renderer, quad({ kind: "bind-image", image: white }));
    expect(actualBinding()).toBeGreaterThan(0);
    draw(renderer, quad(binding));
    const imageName = actualBinding();
    expect(imageName).toBeGreaterThan(0);
    expect(pixel()).toEqual([64, 0, 0, alpha(127)]);
    renderer.beginView({ viewport: { x: 0, y: 0, width: 8, height: 8 }, clear: { stencil: false, depth: 1, color: { x: 0, y: 0, z: 0, w: 0 } } });
    draw(renderer, quad({ kind: "retain-current-texture" }));
    expect(actualBinding()).toBe(imageName);
    expect(pixel()).toEqual([64, 0, 0, alpha(127)]);
    expect(actualBinding()).toBe(imageName);
    publishTexture(images, { name: "lightmap", width: 1, height: 1, pixels: new Uint8Array([0, 255, 0, 255]), sampling, internalFormat: "rgba8", registrationUnit: 1 });
    expect(actualBinding()).toBe(imageName);
    native.symbols.glActiveTexture(0x84c1);
    expect(actualBinding()).toBe(0);
    native.symbols.glActiveTexture(0x84c0);
  } finally { session.close(); native.close(); renderer.close(); window.close(); }
});
