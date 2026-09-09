// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { vec4 } from "../src/core/math.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import type { MultitextureBatch, RenderVertex, SingleTextureBatch } from "../src/render/types.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { executeStaticBatch, publishTexture } from "./render-target-fixture.ts";
import { createRendererSettings } from "./renderer-settings-fixture.ts";

function stripedTexture(images: RendererImageCatalog, registrationUnit: 0 | 1 = 1): RendererImage {
  const pixels = new Uint8Array(256 * 256 * 4);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) pixels.set([x % 2 * 255, y % 2 * 255, x % 4 * 85, 255], (y * 256 + x) * 4);
  return publishTexture(images,{name:"analytic-stripes",width:256,height:256,pixels,internalFormat:"rgba8",sampling:{wrap:"repeat",filter:"linear"},registrationUnit});
}
function vertex(x: number, y: number, w: number, u: number, v: number): RenderVertex {
  return { position: vec4((x / 8 - 1) * w, (1 - y / 8) * w, 0, w), texCoord: { x: u, y: v }, color: vec4(1, 1, 1, 1) };
}
function clippedBatch(images: RendererImageCatalog): SingleTextureBatch {
  return { texturing: "single", primitive: "triangles", indices: [0, 1, 2], texture: { kind: "bind-image", image: stripedTexture(images) }, state: { ...OPAQUE_STATE, cull: "none" }, vertices: [
    vertex(7.517, 11.590, 400, 11, 3), vertex(-15.568, 8.556, 500, 15, 1.5), vertex(5.714, 7.851, 550, 14, 3),
  ] };
}
function pixel(pixels: Uint8Array, x = 2, y = 8): number[] { return Array.from(pixels.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)); }
function commandBuffer(target: RenderTarget): RenderCommandBuffer {
  return new RenderCommandBuffer(target,{print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock:{milliseconds:()=>0},identityLight:1,tess:new SourceTessState(),runtime:createRendererSettings().runtime});
}

test("thin laterally clipped triangle retains the captured native perspective sample", () => {
  // Original snapped interpolation plane gives [123,233,129]; re-snapping the
  // generated left-edge vertices gave [175,230,112]. Procedural texture only.
  // Native fixed-function OpenGL, RTX 5060 Ti, eight subpixel bits, offscreen SDL.
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(16,16,images), target = new RenderTarget(images,[cpu]);
  executeStaticBatch(cpu,clippedBatch(images)); expect(pixel(cpu.pixels)).toEqual([123, 233, 129, 255]); target.close();
});

test("unprojectable finite lateral coordinates retain bounded homogeneous clipping", () => {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(16,16,images), target = new RenderTarget(images,[cpu]);
  const original = clippedBatch(images), white = publishTexture(images,{name:"analytic-white",width:1,height:1,pixels:new Uint8Array([255,255,255,255]),internalFormat:"rgba8",sampling:{wrap:"repeat",filter:"nearest"},registrationUnit:1});
  const red = vec4(1, 0, 0, 1);
  executeStaticBatch(cpu,{ ...original, texture: { kind: "bind-image",image:white }, vertices: [
    { position: { x: -1e308, y: 1e308, z: 0, w: 1 }, texCoord: { x: 0, y: 0 }, color: red },
    { position: { x: 1e308, y: 1e308, z: 0, w: 1 }, texCoord: { x: 0, y: 0 }, color: red },
    { position: { x: 0, y: -1e308, z: 0, w: 1 }, texCoord: { x: 0, y: 0 }, color: red },
  ] });
  expect(pixel(cpu.pixels)).toEqual([255, 0, 0, 255]); target.close();
});

test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("viewport clipping preserves the native original triangle's snapped perspective plane", () => {
  const window = SdlWindow.open({ title: "Clipped perspective plane", width: 16, height: 16, backend: "gl", hidden: true });
  const images = new RendererImageCatalog(), gl = new GlRenderer(window,images), cpu = new SoftwareRenderer(16,16,images,gl.subpixelBits);
  gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  const target = new RenderTarget(images,[cpu,gl]), commands = commandBuffer(target);
  try {
    const batch = clippedBatch(images);
    commands.addView({viewport:{x:0,y:0,width:16,height:16},clear:{ stencil: false,color:vec4(0,0,0,0),depth:1},operations: [{ kind: "draw", batches: [batch] }]}); commands.submit();
    expect(pixel(gl.readPixels())).toEqual([123, 233, 129, 255]);
    expect(pixel(cpu.pixels)).toEqual(pixel(gl.readPixels()));
  } finally { target.close(); window.close(); }
});

test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("all viewport sides and reversed winding preserve the same original perspective plane", () => {
  const window = SdlWindow.open({ title: "Perspective clipping sides", width: 16, height: 16, backend: "gl", hidden: true });
  const images = new RendererImageCatalog(), gl = new GlRenderer(window,images), cpu = new SoftwareRenderer(16,16,images,gl.subpixelBits);
  gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  const target = new RenderTarget(images,[cpu,gl]), commands = commandBuffer(target);
  try {
    const original = clippedBatch(images);
    for (const side of ["left", "right", "top", "bottom"]) for (const reversed of [false, true]) {
      const batch: SingleTextureBatch = { ...original, indices: reversed ? [2, 1, 0] : [0, 1, 2], vertices: original.vertices.map(vertex => {
        const p = vertex.position;
        return { ...vertex, position: side === "right" ? { ...p, x: -p.x } : side === "top" ? { ...p, x: p.y, y: -p.x }
          : side === "bottom" ? { ...p, x: -p.y, y: p.x } : p };
      }) };
      const x = side === "right" ? 13 : side === "top" ? 7 : side === "bottom" ? 8 : 2;
      const y = side === "top" ? 2 : side === "bottom" ? 13 : 8;
      commands.addView({viewport:{x:0,y:0,width:16,height:16},clear:{ stencil: false,color:vec4(0,0,0,0),depth:1},operations: [{ kind: "draw", batches: [batch] }]}); commands.submit();
      expect(pixel(cpu.pixels, x, y)).toEqual([123, 233, 129, 255]);
      expect(pixel(gl.readPixels(), x, y)).toEqual([123, 233, 129, 255]);
    }
  } finally { target.close(); window.close(); }
});

test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("paired textures share the preserved thin-triangle interpolation plane", () => {
  const window = SdlWindow.open({ title: "Paired perspective plane", width: 16, height: 16, backend: "gl", hidden: true });
  const images = new RendererImageCatalog(), gl = new GlRenderer(window,images), cpu = new SoftwareRenderer(16,16,images,gl.subpixelBits);
  gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  const target = new RenderTarget(images,[cpu,gl]), commands = commandBuffer(target);
  try {
    const original = clippedBatch(images);
    const pair: MultitextureBatch = { ...original, texturing: "pair", secondTexture: { binding: { kind: "bind-image", image: stripedTexture(images,0) }, environment: "modulate" },
      vertices: original.vertices.map(vertex => ({ ...vertex, texCoord2: { x: vertex.texCoord.y, y: vertex.texCoord.x } })) };
    commands.addView({viewport:{x:0,y:0,width:16,height:16},clear:{ stencil: false,color:vec4(0,0,0,0),depth:1},operations: [{ kind: "draw", batches: [pair] }]}); commands.submit();
    expect(pixel(cpu.pixels)).toEqual(pixel(gl.readPixels()));
  } finally { target.close(); window.close(); }
});
