// SPDX-License-Identifier: GPL-2.0-or-later
// Analytic SDL/system GL checks for id Software tr_backend.c RB_ShowImages.
import { describe, expect, test } from "bun:test";
import { loadGl } from "../src/platform/gl.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererImageCatalog, RgbaSnapshot } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import type { CinematicUpload } from "../src/render/cinematic-command.ts";
import type { SourceStageData } from "../src/render/types.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import { SourceStateBit } from "../src/render/source-state.ts";

function pixels(width: number, height: number, color: readonly number[]): Uint8Array {
  const result = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < result.length; offset += 4) result.set(color, offset);
  return result;
}
function upload(image: RendererImage, width: number, height: number): CinematicUpload {
  return { image, sourceWidth: width, sourceHeight: height, uploadWidth: width, uploadHeight: height,
    content: new RgbaSnapshot(width, height, pixels(width, height, [0, 255, 0, 255])), dirty: false };
}
function fixture(width = 64, height = 64) {
  const window = SdlWindow.open({ title: "Source GL show images", width, height, backend: "gl", stencilBits: 8, hidden: true });
  const images = new RendererImageCatalog(), renderer = new GlRenderer(window, images), session = images.openSession();
  renderer.initializeDefaultState(renderer.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  session.attach(renderer); session.beginExecution();
  const native = loadGl(window), gl = native.symbols;
  const image = (name: string, w = 1, h = 1, color: readonly number[] = [255, 255, 255, 255], sourceWidth = w, sourceHeight = h) => images.create({
    name, sourceWidth, sourceHeight, levels: [{ width: w, height: h, pixels: pixels(w, h, color) }],
    mipmap: false, internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0,
  });
  const solid = image("white"), sentinel = image("binding sentinel");
  const integer = (name: number): number => {
    const values = new Int32Array(1); gl.glGetIntegerv(name, values);
    const value = values[0]; if (value === undefined) throw new Error("Missing GL integer"); return value;
  };
  const current = (name: number, count = 4): number[] => { const values = new Float32Array(count); gl.glGetFloatv(name, values); return [...values]; };
  const uv = (unit: 0 | 1): number[] => {
    const active = integer(0x84e0); gl.glActiveTexture(0x84c0 + unit);
    const result = current(0xb03); gl.glActiveTexture(active); return result;
  };
  const pixel = (x: number, y: number): number[] => [...renderer.readPixels().slice((y * width + x) * 4, (y * width + x + 1) * 4)];
  const depth = (x: number, y: number): number => {
    const values = new Float32Array(1); gl.glReadPixels(x, height - 1 - y, 1, 1, 0x1902, 0x1406, values);
    const value = values[0]; if (value === undefined) throw new Error("Missing GL depth"); return value;
  };
  const stencil = (x: number, y: number): number => {
    const values = new Uint8Array(1); gl.glReadPixels(x, height - 1 - y, 1, 1, 0x1901, 0x1401, values);
    const value = values[0]; if (value === undefined) throw new Error("Missing GL stencil"); return value;
  };
  const clear = () => {
    renderer.beginView({ viewport: { x: 0, y: 0, width, height }, clear: { color: { x: 0, y: 0, z: 0, w: 1 }, depth: 1, stencil: true } });
    renderer.beginView({ viewport: { x: 0, y: 0, width, height }, clear: null });
  };
  clear();
  return { renderer, images, gl, image, solid, sentinel, integer, current, uv, pixel, depth, stencil, clear,
    close: () => { session.close(); native.close(); renderer.close(); window.close(); } };
}

describe.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("actual GL show images", () => {
  test("pixel cells retain nonwhite color and UV order under identity and raw matrices", () => {
    const f = fixture(641, 481);
    try {
      const tile = f.images.create({ name: "four corners", sourceWidth: 2, sourceHeight: 2,
        levels: [{ width: 2, height: 2, pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]) }],
        mipmap: false, internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
      f.image("later sentinel");
      f.gl.glColor4ub(128, 64, 255, 255);
      f.renderer.drawShowImage(tile, { x: 608, y: 0, width: 32, height: 32 }, false);
      expect(f.pixel(612, 4)).toEqual([128, 0, 0, 255]); expect(f.pixel(636, 4)).toEqual([0, 64, 0, 255]);
      expect(f.pixel(612, 28)).toEqual([0, 0, 255, 255]); expect(f.pixel(636, 28)).toEqual([128, 64, 255, 255]);
      expect(f.pixel(640, 4)).toEqual([0, 0, 0, 255]); expect(f.uv(0)).toEqual([0, 1, 0, 1]);
      const raw = f.renderer.prepareRawGeometry({ rect: { x: 100, y: 100, width: 1, height: 1 }, uploadWidth: 1, uploadHeight: 1, identityLight: 1 });
      raw.uploadCurrent(upload(f.solid, 1, 1)); raw.draw();
      f.renderer.drawShowImage(tile, { x: 0, y: 32, width: 32, height: 32 }, false);
      expect(f.pixel(4, 36)).toEqual([255, 0, 0, 255]); expect(f.pixel(28, 60)).toEqual([255, 255, 255, 255]);
      f.renderer.drawShowImage(tile, { x: 0, y: 480, width: 32, height: 32 }, false);
      expect(f.pixel(4, 480)).toEqual([255, 0, 0, 255]); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("mode two uses upload dimensions and tracks requested cinematic resizes through r_nobind", () => {
    const f = fixture();
    try {
      const scratch = f.image("scratch", 128, 256, [255, 255, 255, 255], 512, 512);
      const dlight = f.image("dlight", 2, 2, [255, 0, 0, 255]); f.images.setDlightImage(dlight); f.image("last");
      f.renderer.drawShowImage(scratch, { x: 8, y: 8, width: 32, height: 32 }, true);
      expect(f.pixel(15, 23)).toEqual([255, 255, 255, 255]); expect(f.pixel(16, 23)).toEqual([0, 0, 0, 255]);
      expect(f.pixel(15, 24)).toEqual([0, 0, 0, 255]);
      f.images.setBindingSettings({ noBind: true });
      const raw = f.renderer.prepareRawGeometry({ rect: { x: 0, y: 0, width: 1, height: 1 }, uploadWidth: 256, uploadHeight: 128, identityLight: 1 });
      raw.uploadCurrent(upload(scratch, 256, 128));
      f.clear(); f.renderer.drawShowImage(scratch, { x: 8, y: 8, width: 32, height: 32 }, true);
      expect(f.pixel(23, 15)).toEqual([0, 255, 0, 255]); expect(f.pixel(24, 15)).toEqual([0, 0, 0, 255]);
      expect(f.pixel(23, 16)).toEqual([0, 0, 0, 255]); expect(f.integer(0x8069)).toBe(1024 + dlight.ordinal);
      f.renderer.drawShowImage(dlight, { x: 40, y: 40, width: 32, height: 32 }, true);
      expect(f.pixel(40, 40)).toEqual([0, 0, 0, 255]);
      const stage = f.renderer.prepareGeometry({ primitive: "triangles", texturing: "single", vertices: [], indices: [],
        texture: { kind: "bind-image", image: scratch }, state: { ...OPAQUE_STATE, cull: "none" } });
      stage.begin(); stage.applyTexture(0, { kind: "cinematic-upload", upload: upload(scratch, 64, 128) }); stage.draw(); stage.cleanup();
      f.clear(); f.renderer.drawShowImage(scratch, { x: 8, y: 8, width: 32, height: 32 }, true);
      expect(f.pixel(11, 15)).toEqual([0, 255, 0, 255]); expect(f.pixel(12, 15)).toEqual([0, 0, 0, 255]);
      expect(f.pixel(11, 16)).toEqual([0, 0, 0, 255]); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("selected unit one retains secondary coordinates and texture environment", () => {
    const f = fixture();
    try {
      const stripes = f.images.create({ name: "secondary stripes", sourceWidth: 2, sourceHeight: 1,
        levels: [{ width: 2, height: 1, pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]) }],
        mipmap: false, internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
      f.image("last");
      const vertex = { position: { x: 0, y: 0, z: 0, w: 1 }, color: { x: 0.5, y: 0.25, z: 1, w: 1 },
        texCoord: { x: 0.5, y: 0.5 }, texCoord2: { x: 0.75, y: 0.5 } };
      const stage: SourceStageData = { kind: "generic-pair", stateBits: SourceStateBit.DEFAULT,
        scratch: [{ ...vertex, rawTexCoord: { ...vertex.texCoord }, rawTexCoord2: { ...vertex.texCoord2 } }], batch: {
        primitive: "triangles", texturing: "pair", vertices: [vertex], indices: [0, 0, 0],
        texture: { kind: "bind-image", image: f.solid }, secondTexture: { binding: { kind: "bind-image", image: f.sentinel }, environment: "modulate" },
        state: { ...OPAQUE_STATE, cull: "none" },
      } };
      f.renderer.drawImmediate({ kind: "cull", cull: "none" });
      f.renderer.drawImmediate({ kind: "begin-generic-iterator", setArraysOnce: false, scratch: stage.scratch });
      const prepared = f.renderer.prepareSourceGeometry(stage); prepared.begin();
      prepared.prepareTexture(0); prepared.applyTexture(0, { kind: "bind-image", image: f.solid });
      prepared.prepareTexture(1); prepared.applyTexture(1, { kind: "bind-image", image: f.sentinel });
      prepared.finishTextures(); prepared.draw(1);
      const color = f.current(0xb00), secondary = f.uv(1);
      f.renderer.drawShowImage(stripes, { x: 0, y: 0, width: 32, height: 32 }, false);
      expect(f.pixel(4, 4)).toEqual([0, 64, 0, 255]); expect(f.pixel(28, 28)).toEqual([0, 64, 0, 255]);
      expect(f.current(0xb00)).toEqual(color); expect(f.uv(0)).toEqual([0, 1, 0, 1]); expect(f.uv(1)).toEqual(secondary);
      expect(f.integer(0x84e0)).toBe(0x84c1); expect(f.integer(0x84e1)).toBe(0x84c1); expect(f.integer(0x8069)).toBe(1024 + stripes.ordinal);
      f.gl.glTexEnvi(0x2300, 0x2200, 0x1e01);
      f.renderer.drawShowImage(stripes, { x: 32, y: 0, width: 32, height: 32 }, false);
      expect(f.pixel(36, 4)).toEqual([0, 255, 0, 255]); expect(f.gl.glIsEnabled(0xde1)).toBe(1);
      expect(f.gl.glIsEnabled(0xb71)).toBe(1); expect(f.depth(4, 4)).toBe(0); expect(f.gl.glGetError()).toBe(0);
      prepared.cleanup();
    } finally { f.close(); }
  });

  test("color-only clear retains clear color, scissor and color mask without touching depth or stencil", () => {
    const f = fixture();
    try {
      f.gl.glClearDepth(0.375); f.gl.glClearStencil(7); f.gl.glDepthMask(1); f.gl.glClear(0x100 | 0x400);
      f.gl.glClearColor(0.25, 0.5, 0.75, 1); f.gl.glColorMask(1, 0, 1, 0); f.gl.glScissor(8, 64 - 24, 16, 16);
      f.renderer.clearColorBuffer();
      expect(f.pixel(8, 8)).toEqual([64, 0, 191, 255]); expect(f.pixel(23, 23)).toEqual([64, 0, 191, 255]);
      expect(f.pixel(7, 8)).toEqual([0, 0, 0, 255]); expect(f.pixel(24, 23)).toEqual([0, 0, 0, 255]);
      expect(f.depth(8, 8)).toBeCloseTo(0.375, 6); expect(f.depth(0, 0)).toBeCloseTo(0.375, 6);
      expect(f.stencil(8, 8)).toBe(7); expect(f.stencil(0, 0)).toBe(7);
      expect(f.current(0xc22)).toEqual([0.25, 0.5, 0.75, 1]); expect(f.current(0xc23)).toEqual([1, 0, 1, 0]);
      expect(f.current(0xc10)).toEqual([8, 40, 16, 16]); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });
});
