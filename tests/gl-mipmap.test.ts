// SPDX-License-Identifier: GPL-2.0-or-later
// tr_image.c Upload32/R_CreateImage/GL_TextureMode, exercised on the actual driver.
import { describe, expect, test } from "bun:test";
import { loadGl } from "../src/platform/gl.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererImageCatalog, RgbaSnapshot } from "../src/render/image-resource.ts";
import type { ImageInternalFormat, ImageSource, RendererImage } from "../src/render/image-resource.ts";
import type { DrawBatch, TextureBinding, TextureFilter } from "../src/render/types.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import { executeStaticBatch } from "./render-target-fixture.ts";

function level(width: number, height: number, rgba: readonly number[]) {
  const pixels = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(rgba, offset);
  return { width, height, pixels };
}
function source(name: string): ImageSource {
  return { name, sourceWidth: 4, sourceHeight: 4, mipmap: true, registrationUnit: 0,
    levels: [level(4, 4, [255, 0, 0, 255]), level(2, 2, [0, 255, 0, 255]), level(1, 1, [0, 0, 255, 255])],
    internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "linear-mipmap-nearest" } };
}
function quad(texture: TextureBinding, repeat = 0): DrawBatch {
  return { primitive: "triangles", texturing: "single", texture,
    state: { ...OPAQUE_STATE, cull: "none", depthTest: "always" }, indices: [0, 1, 2, 0, 2, 3],
    vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(point => {
      const [x, y] = point;
      if (x === undefined || y === undefined) throw new Error("Missing quad coordinate");
      return { position: { x, y, z: 0, w: 1 }, color: { x: 1, y: 1, z: 1, w: 1 },
        texCoord: { x: 0.5 + x * repeat / 2, y: 0.5 + y * repeat / 2 } };
    }) };
}
function fixture() {
  const window = SdlWindow.open({ title: "GL prepared mip uploads", width: 8, height: 8, backend: "gl", hidden: true });
  const images = new RendererImageCatalog(), renderer = new GlRenderer(window, images), session = images.openSession(), native = loadGl(window), gl = native.symbols;
  renderer.initializeDefaultState(renderer.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  session.attach(renderer); session.beginExecution();
  const integer = (key: number): number => {
    const output = new Int32Array(1); gl.glGetIntegerv(key, output);
    const value = output[0]; if (value === undefined) throw new Error("Missing GL integer"); return value;
  };
  const inspect = (image: RendererImage | null, index = 0) => {
    window.makeCurrent(); const previous = integer(0x8069); gl.glBindTexture(0xde1, image === null ? 0 : image.ordinal + 1024);
    try {
      const queryLevel = (key: number): number => {
        const output = new Int32Array(1); gl.glGetTexLevelParameteriv(0xde1, index, key, output);
        const value = output[0]; if (value === undefined) throw new Error("Missing GL level value"); return value;
      };
      const parameter = (key: number): number => {
        const output = new Float32Array(1); gl.glGetTexParameterfv(0xde1, key, output);
        const value = output[0]; if (value === undefined) throw new Error("Missing GL parameter"); return value;
      };
      const width = queryLevel(0x1000), height = queryLevel(0x1001), pixels = new Uint8Array(width * height * 4);
      if (pixels.length > 0) gl.glGetTexImage(0xde1, index, 0x1908, 0x1401, pixels);
      return { width, height, pixels, format: queryLevel(0x1003), bits: [queryLevel(0x805c), queryLevel(0x805d), queryLevel(0x805e), queryLevel(0x805f)],
        min: parameter(0x2801), mag: parameter(0x2800), wrapS: parameter(0x2802), wrapT: parameter(0x2803) };
    } finally { gl.glBindTexture(0xde1, previous); }
  };
  renderer.beginView({ viewport: { x: 0, y: 0, width: 8, height: 8 }, clear: { stencil: false, depth: 1, color: { x: 0, y: 0, z: 0, w: 0 } } });
  return { window, images, renderer, integer, inspect, gl,
    close: () => { session.close(); native.close(); renderer.close(); window.close(); } };
}
function center(renderer: GlRenderer): number[] { return Array.from(renderer.readPixels().slice(144, 148)); }
function cinematic(renderer: GlRenderer, image: RendererImage, width: number, color: readonly number[], dirty: boolean): void {
  const content = level(width, width, color);
  renderer.prepareRawGeometry({ rect: { x: 0, y: 0, width: 8, height: 8 }, uploadWidth: width, uploadHeight: width, identityLight: 1 }).uploadCurrent({
    image, sourceWidth: width, sourceHeight: width, uploadWidth: width, uploadHeight: width,
    content: new RgbaSnapshot(width, width, content.pixels), dirty });
}

describe.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("native prepared mip levels and texture modes", () => {
  test("catalog snapshots each level before attachment and uploads the complete chain", () => {
    const window = SdlWindow.open({ title: "GL detached mip snapshots", width: 8, height: 8, backend: "gl", hidden: true });
    const images = new RendererImageCatalog(), renderer = new GlRenderer(window, images), session = images.openSession(), native = loadGl(window), gl = native.symbols;
    try {
      renderer.initializeDefaultState(renderer.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
      const input = source("owned"), image = images.create(input);
      for (const entry of input.levels) entry.pixels.fill(31);
      session.attach(renderer); session.beginExecution();
      const binding = new Int32Array(1); gl.glGetIntegerv(0x8069, binding);
      expect(binding[0]).toBe(0);
      gl.glBindTexture(0xde1, image.ordinal + 1024);
      for (const [index, color] of [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]].entries()) {
        const dimension = 4 >> index, width = new Int32Array(1), height = new Int32Array(1), format = new Int32Array(1);
        gl.glGetTexLevelParameteriv(0xde1, index, 0x1000, width);
        gl.glGetTexLevelParameteriv(0xde1, index, 0x1001, height);
        gl.glGetTexLevelParameteriv(0xde1, index, 0x1003, format);
        expect([width[0], height[0], format[0]]).toEqual([dimension, dimension, 0x8058]);
        const pixels = new Uint8Array(dimension * dimension * 4);
        gl.glGetTexImage(0xde1, index, 0x1908, 0x1401, pixels);
        expect(pixels).toEqual(level(dimension, dimension, color).pixels);
      }
      const missingWidth = new Int32Array(1); gl.glGetTexLevelParameteriv(0xde1, 3, 0x1000, missingWidth);
      expect(missingWidth[0]).toBe(0);
      gl.glBindTexture(0xde1, 0); gl.glGetIntegerv(0x8069, binding);
      expect(binding[0]).toBe(0);
      expect(gl.glGetError()).toBe(0);
    } finally { session.close(); native.close(); renderer.close(); window.close(); }
  });

  const modes: readonly { readonly name: string; readonly filter: TextureFilter; readonly min: number; readonly mag: number }[] = [
    { name: "GL_NEAREST", filter: "nearest", min: 0x2600, mag: 0x2600 },
    { name: "GL_LINEAR", filter: "linear", min: 0x2601, mag: 0x2601 },
    { name: "GL_NEAREST_MIPMAP_NEAREST", filter: "nearest-mipmap-nearest", min: 0x2700, mag: 0x2600 },
    { name: "GL_LINEAR_MIPMAP_NEAREST", filter: "linear-mipmap-nearest", min: 0x2701, mag: 0x2601 },
    { name: "GL_NEAREST_MIPMAP_LINEAR", filter: "nearest-mipmap-linear", min: 0x2702, mag: 0x2600 },
    { name: "GL_LINEAR_MIPMAP_LINEAR", filter: "linear-mipmap-linear", min: 0x2703, mag: 0x2601 },
  ];
  for (const mode of modes) test(`${mode.name} has source min/mag parameters and uses prepared child bytes`, () => {
    const f = fixture();
    try {
      const image = f.images.create({ ...source(mode.name), sampling: { wrap: "clamp", filter: mode.filter } });
      f.images.create({ ...source("nonmip"), mipmap: false, levels: [level(1, 1, [255, 255, 255, 255])], sampling: { wrap: "repeat", filter: "linear" } });
      const created = f.inspect(image);
      expect([created.min, created.mag]).toEqual([mode.min, mode.mag]);
      expect(f.images.setTextureMode(mode.name.toLowerCase())).toBe(true);
      const changed = f.inspect(image);
      expect([changed.min, changed.mag, changed.wrapS, changed.wrapT]).toEqual([mode.min, mode.mag, 0x2900, 0x2900]);
      executeStaticBatch(f.renderer, quad({ kind: "bind-image", image }, 4));
      // Center lies inside GL_CLAMP's interior. rho=2 selects the explicitly green child.
      expect(center(f.renderer)).toEqual(mode.filter.includes("mipmap") ? [0, 255, 0, 255] : [255, 0, 0, 255]);
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("one 1x1 mip member keeps creation cache divergence observable", () => {
    const f = fixture();
    try {
      const image = f.images.create({ ...source("one"), sourceWidth: 1, sourceHeight: 1, levels: [level(1, 1, [0, 255, 0, 255])] });
      expect(f.images.setTextureMode("GL_NEAREST")).toBe(true);
      expect(f.integer(0x8069)).toBe(0);
      expect(f.inspect(null).min).toBe(0x2600);
      expect(f.inspect(image).min).toBe(0x2701);
      executeStaticBatch(f.renderer, quad({ kind: "bind-image", image }));
      expect(f.integer(0x8069)).toBe(0);
      expect(center(f.renderer)).toEqual([255, 255, 255, 255]);
      const before = f.inspect(null);
      expect(f.images.setTextureMode("GL_FAKE")).toBe(false);
      expect(f.inspect(null)).toEqual(before);
      expect(f.images.textureFilter).toBe("nearest");
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("linear mip filters blend prepared levels at fractional native LOD", () => {
    const f = fixture();
    try {
      const image = f.images.create(source("fractional")); f.images.create(source("sentinel"));
      for (const mode of ["GL_NEAREST_MIPMAP_LINEAR", "GL_LINEAR_MIPMAP_LINEAR"]) {
        f.images.setTextureMode(mode);
        executeStaticBatch(f.renderer, quad({ kind: "bind-image", image }, 2 ** 1.25));
        const [red, green, blue, alpha] = center(f.renderer);
        if (red === undefined || green === undefined) throw new Error("Missing framebuffer channels");
        // Ideal lambda=.25. Native derivative/LOD approximation is not bit-exact CPU parity.
        expect(Math.abs(red - 191)).toBeLessThanOrEqual(16); expect(Math.abs(green - 64)).toBeLessThanOrEqual(16);
        expect([blue, alpha]).toEqual([0, 255]);
      }
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("mode traversal visits mip members in creation order on the current TMU", () => {
    const f = fixture();
    try {
      const a = f.images.create(source("a")), skipped = f.images.create({ ...source("skip"), mipmap: false, levels: [level(1, 1, [255, 255, 255, 255])], sampling: { wrap: "repeat", filter: "linear" } });
      const b = f.images.create({ ...source("b"), registrationUnit: 1 });
      expect(f.integer(0x84e0)).toBe(0x84c0);
      const single = quad({ kind: "bind-image", image: skipped });
      const pair: DrawBatch = { ...single, texturing: "pair", vertices: single.vertices.map(vertex => ({ ...vertex, texCoord2: { x: 0.5, y: 0.5 } })), secondTexture: { binding: { kind: "bind-image", image: a }, environment: "replace" } };
      const prepared = f.renderer.prepareGeometry(pair);
      prepared.begin(); prepared.applyTexture(0, { kind: "bind-image", image: skipped }); prepared.applyTexture(1, { kind: "bind-image", image: a });
      expect(f.images.setTextureMode("GL_NEAREST_MIPMAP_LINEAR")).toBe(true);
      expect(f.integer(0x84e0)).toBe(0x84c1); expect(f.integer(0x84e1)).toBe(0x84c1);
      expect(f.integer(0x8069)).toBe(b.ordinal + 1024);
      expect(f.inspect(a).min).toBe(0x2702); expect(f.inspect(b).min).toBe(0x2702); expect(f.inspect(skipped).min).toBe(0x2601);
      prepared.draw(); expect(center(f.renderer)).toEqual([255, 0, 0, 255]); prepared.cleanup();
      expect(f.integer(0x84e0)).toBe(0x84c0); expect(f.integer(0x8069)).toBe(0);
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("mode replay remains interleaved with creation raw unbinds", () => {
    const window = SdlWindow.open({ title: "GL detached mode replay", width: 8, height: 8, backend: "gl", hidden: true });
    const images = new RendererImageCatalog(), renderer = new GlRenderer(window, images), session = images.openSession(), native = loadGl(window), gl = native.symbols;
    try {
      renderer.initializeDefaultState(renderer.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
      const a = images.create(source("a"));
      images.setTextureMode("GL_NEAREST");
      const b = images.create({ ...source("b"), sampling: { wrap: "repeat", filter: images.textureFilter } });
      images.setTextureMode("GL_LINEAR_MIPMAP_LINEAR");
      session.attach(renderer); session.beginExecution();
      const binding = new Int32Array(1); gl.glGetIntegerv(0x8069, binding);
      expect(binding[0]).toBe(b.ordinal + 1024);
      const filter = new Float32Array(1);
      gl.glBindTexture(0xde1, 0); gl.glGetTexParameterfv(0xde1, 0x2801, filter);
      expect(filter[0]).toBe(0x2600);
      gl.glBindTexture(0xde1, a.ordinal + 1024); gl.glGetTexParameterfv(0xde1, 0x2801, filter);
      expect(filter[0]).toBe(0x2703);
      gl.glBindTexture(0xde1, b.ordinal + 1024); gl.glGetTexParameterfv(0xde1, 0x2801, filter);
      expect(filter[0]).toBe(0x2703);
      gl.glGetIntegerv(0x8069, binding); expect(binding[0]).toBe(b.ordinal + 1024);
      expect(gl.glGetError()).toBe(0);
    } finally { session.close(); native.close(); renderer.close(); window.close(); }
  });

  const formats: readonly { readonly format: ImageInternalFormat; readonly native: number; readonly bits: number; readonly alpha: boolean }[] = [
    { format: "rgb", native: 3, bits: 1, alpha: false }, { format: "rgba", native: 4, bits: 1, alpha: true },
    { format: "rgb5", native: 0x8050, bits: 5, alpha: false }, { format: "rgba4", native: 0x8056, bits: 4, alpha: true },
    { format: "rgb8", native: 0x8051, bits: 8, alpha: false }, { format: "rgba8", native: 0x8058, bits: 8, alpha: true },
  ];
  for (const format of formats) test(`${format.format} requests its source format separately at every mip level`, () => {
    const f = fixture();
    try {
      const colors = [[81, 143, 201, 115], [45, 97, 159, 219], [13, 61, 177, 245]];
      const [base, child, tail] = colors;
      if (base === undefined || child === undefined || tail === undefined) throw new Error("Missing colors");
      const image = f.images.create({ ...source(format.format), internalFormat: format.format,
        levels: [level(4, 4, base), level(2, 2, child), level(1, 1, tail)] });
      for (const [index, color] of colors.entries()) {
        const actual = f.inspect(image, index);
        expect(actual.format).toBe(format.native);
        for (const [channel, input] of color.entries()) {
          const bits = actual.bits[channel], stored = actual.pixels[channel];
          if (bits === undefined || stored === undefined) throw new Error("Missing queried channel");
          if (channel === 3 && !format.alpha) { expect(bits).toBe(0); expect(stored).toBe(255); }
          else {
            expect(bits).toBeGreaterThanOrEqual(format.bits);
            // Sized requests may receive greater precision. GL conversion rounding is driver selected.
            expect(Math.abs(stored - input)).toBeLessThanOrEqual(255 / (2 ** bits - 1) + 1);
          }
        }
      }
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("cinematic dirty writes preserve child levels and filters; resize replaces only level zero", () => {
    const f = fixture();
    try {
      const image = f.images.create(source("cinematic")); f.images.create(source("sentinel"));
      executeStaticBatch(f.renderer, quad({ kind: "bind-image", image }));
      cinematic(f.renderer, image, 4, [31, 73, 127, 43], true);
      const updated = f.inspect(image);
      expect([updated.format, updated.min, updated.mag, updated.wrapS]).toEqual([0x8058, 0x2701, 0x2601, 0x2901]);
      expect(updated.pixels).toEqual(level(4, 4, [31, 73, 127, 43]).pixels);
      expect(f.inspect(image, 1).pixels).toEqual(level(2, 2, [0, 255, 0, 255]).pixels);
      executeStaticBatch(f.renderer, quad({ kind: "retain-current-texture" }, 4)); expect(center(f.renderer)).toEqual([0, 255, 0, 255]);
      cinematic(f.renderer, image, 8, [255, 0, 255, 0], false);
      const resized = f.inspect(image);
      expect([resized.width, resized.format, resized.min, resized.wrapS]).toEqual([8, 0x8051, 0x2601, 0x2900]);
      expect(resized.pixels).toEqual(level(8, 8, [255, 0, 255, 255]).pixels);
      expect(f.inspect(image, 1).pixels).toEqual(level(2, 2, [0, 255, 0, 255]).pixels);
      f.images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST");
      executeStaticBatch(f.renderer, quad({ kind: "bind-image", image }));
      expect(center(f.renderer)).toEqual([255, 255, 255, 255]);
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("picmip-sized storage rejects a dirty original-size cinematic without changing levels", () => {
    const f = fixture();
    try {
      const image = f.images.create({ ...source("reduced"), sourceWidth: 8, sourceHeight: 8 }); f.images.create(source("sentinel"));
      executeStaticBatch(f.renderer, quad({ kind: "bind-image", image }));
      const before = [f.inspect(image), f.inspect(image, 1), f.inspect(image, 2)];
      cinematic(f.renderer, image, 8, [255, 0, 255, 255], true);
      expect(f.gl.glGetError()).toBe(0x501);
      expect([f.inspect(image), f.inspect(image, 1), f.inspect(image, 2)]).toEqual(before);
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });
});
