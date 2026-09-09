// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SdlWindow } from "../src/platform/sdl.ts";
import { loadGl } from "../src/platform/gl.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { createLoggedGlCalls, GlCallLogging } from "../src/render/gl/logging.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { RegisteredRendererCvars } from "../src/render/settings.ts";
import { WritableFileSystem } from "../src/assets/writable-files.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import type { RenderState, SingleTextureBatch, TextureSampling } from "../src/render/types.ts";
import { RendererImageCatalog, RgbaSnapshot } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { executeStaticBatch as draw, publishTexture } from "./render-target-fixture.ts";
import type { Vec4 } from "../src/core/math.ts";
import { runGlSmoke } from "../tools/gl-smoke.ts";

const red: Vec4 = { x: 1, y: 0, z: 0, w: 1 };
const green: Vec4 = { x: 0, y: 1, z: 0, w: 1 };
const blue: Vec4 = { x: 0, y: 0, z: 1, w: 1 };
const white: Vec4 = { x: 1, y: 1, z: 1, w: 1 };

function quad(color: Vec4, depth = 0, state: RenderState = OPAQUE_STATE, texture: RendererImage | null = null, u = 0.5, v = 0.5): SingleTextureBatch {
  return { texturing: "single", primitive: "triangles",
    vertices: [
      { position: { x: -1, y: -1, z: depth, w: 1 }, texCoord: { x: u, y: v }, color },
      { position: { x: 1, y: -1, z: depth, w: 1 }, texCoord: { x: u, y: v }, color },
      { position: { x: 1, y: 1, z: depth, w: 1 }, texCoord: { x: u, y: v }, color },
      { position: { x: -1, y: 1, z: depth, w: 1 }, texCoord: { x: u, y: v }, color },
    ], indices: [0, 1, 2, 0, 2, 3], texture: texture === null ? { kind: "retain-current-texture" } : { kind: "bind-image", image: texture }, state,
  };
}

function publish(renderer: GlRenderer, pixels: Uint8Array, width: number, height: number,
  sampling: TextureSampling = { wrap: "repeat", filter: "linear" }): RendererImage {
  return publishTexture(renderer.images, { name: "GL analytic image", width, height, pixels, sampling, internalFormat: "rgba8", registrationUnit: 0 });
}
function clear(renderer: GlRenderer, color: Vec4): void {
  renderer.beginView({ viewport: { x: 0, y: 0, width: renderer.width, height: renderer.height }, clear: { stencil: false, depth: 1, color } });
}
function update(renderer: GlRenderer, image: RendererImage, pixels: Uint8Array, width: number, height: number): void {
  const prepared = renderer.prepareGeometry(quad(white, 0, OPAQUE_STATE, image)); prepared.begin();
  prepared.applyTexture(0, { kind: "cinematic-upload", upload: { image, sourceWidth: width, sourceHeight: height,
    uploadWidth: width, uploadHeight: height, dirty: true, content: new RgbaSnapshot(width, height, pixels) } });
  prepared.draw(); prepared.cleanup();
}
function withRenderer(action: (renderer: GlRenderer, window: SdlWindow, alpha: (value: number) => number) => void,
  logging: GlCallLogging | null = null): void {
  const window = SdlWindow.open({ title: "GL renderer test", width: 16, height: 16, backend: "gl", hidden: true });
  let renderer: GlRenderer | null = null;
  const images = new RendererImageCatalog(), session = images.openSession();
  try {
    renderer = new GlRenderer(window, images, logging);
    renderer.initializeDefaultState(renderer.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
    session.attach(renderer); session.beginExecution();
    const whiteImage = publish(renderer, new Uint8Array([255, 255, 255, 255]), 1, 1);
    publish(renderer, new Uint8Array([0, 0, 0, 0]), 1, 1);
    clear(renderer, blue);
    draw(renderer, quad(white, 0, OPAQUE_STATE, whiteImage));
    const bits = renderer.alphaBits, maximum = 2 ** bits - 1;
    action(renderer, window, value => bits === 0 ? 255 : Math.round(Math.round(value * maximum / 255) * 255 / maximum));
  }
  finally { session.close(); renderer?.close(); window.close(); }
}

function pixel(renderer: GlRenderer): number[] { return Array.from(renderer.readPixels().subarray((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4)); }

function nearPixel(renderer: GlRenderer, expected: readonly number[]): void {
  const actual = pixel(renderer);
  expected.forEach((value, channel) => {
    const measured = actual[channel];
    if (measured === undefined) throw new Error("Readback channel missing");
    expect(Math.abs(measured - value)).toBeLessThanOrEqual(1);
  });
}

describe.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("system OpenGL indexed renderer", () => {
  test("r_logFile records actual renderer draws and teardown before its retained file closes", () => {
    const root = mkdtempSync(join(tmpdir(), "quake3-gl-call-output-"));
    const cvars = new CvarRegistry(); new RegisteredRendererCvars(cvars, "linux"); cvars.register("fs_basepath", root);
    const files = new WritableFileSystem({ homePath: root, product: "baseq3", print: () => {} });
    const logging = new GlCallLogging({ cvars, openLog: path => files.openGlLog(path), print: () => {},
      localCalendar: () => ({ year: 126, month: 8, day: 9, hour: 1, minute: 2, second: 3, weekday: 3, yearDay: 251, isDst: 1 }) });
    try {
      withRenderer(renderer => {
        expect(logging.enabled).toBe(false);
        cvars.set("r_logFile", "1", true); renderer.endFrameLogging();
        clear(renderer, blue); draw(renderer, quad(red));
        expect(pixel(renderer)).toEqual([255, 0, 0, 255]);
        renderer.drawImmediate({ kind: "log-comment", text: "iterator comment\n" });
      }, logging);
      logging.comment("renderer already closed\n"); logging.close();
      const contents = readFileSync(join(root, "gl.log"), "latin1");
      expect(contents.startsWith("Wed Sep  9 01:02:03 2026\n\n")).toBe(true);
      for (const text of ["glClear\n", "glDrawElements\n", "glReadPixels\n", "iterator comment\n", "glDeleteTextures\n"])
        expect(contents).toContain(text);
      expect(contents.endsWith("renderer already closed\n")).toBe(true);
      expect(contents).not.toContain("CLOSING LOG");
    } finally { logging.close(); files.closeAll(); rmSync(root, { recursive: true, force: true }); }
  });

  test("logged FFI calls retain Linux formats, float rounding and signed glColor4ub dispatch", () => {
    const cvars = new CvarRegistry(); new RegisteredRendererCvars(cvars, "linux");
    const output: string[] = [];
    const logging = new GlCallLogging({ cvars, print: () => {},
      openLog: () => ({ write: text => { output.push(text); }, close: () => {} }),
      localCalendar: () => ({ year: 126, month: 8, day: 9, hour: 1, minute: 2, second: 3, weekday: 3, yearDay: 251, isDst: 1 }) });
    const window = SdlWindow.open({ title: "GL logging native calls", width: 16, height: 16, backend: "gl", hidden: true });
    const library = loadGl(window), gl = createLoggedGlCalls(library.symbols, logging);
    try {
      const expectedSigned = new Float32Array(4), expectedUnsigned = new Float32Array(4), actual = new Float32Array(4);
      library.symbols.glColor4b(-1, -128, 127, 0); library.symbols.glGetFloatv(0xb00, expectedSigned);
      library.symbols.glColor4ub(255, 128, 127, 0); library.symbols.glGetFloatv(0xb00, expectedUnsigned);
      gl.glColor4f(1, 1, 1, 1); expect(output).toHaveLength(0);
      cvars.set("r_logFile", "1", true); logging.endFrame();
      gl.glColor4f(-0, 0.0078125, 0.0234375, 1 / 255);
      gl.glColor4ub(255, 128, 127, 0); gl.glGetFloatv(0xb00, actual);
      expect(Array.from(actual)).toEqual(Array.from(expectedSigned));
      expect(Array.from(actual)).not.toEqual(Array.from(expectedUnsigned));
      gl.glActiveTexture(0x84c0); gl.glClientActiveTexture(0x84c0);
      gl.glEnable(0xb71); expect(gl.glIsEnabled(0xb71)).toBe(1);
      gl.glBlendFunc(0x302, 0x303); gl.glAlphaFunc(0x204, 0.0078125);
      expect(output).toEqual(["Wed Sep  9 01:02:03 2026\n\n",
        "glColor4f( -0.000000,0.007812,0.023438,0.003922 )\n", "glColor4b\n", "glGetFloatv\n",
        "glEnable( 0xb71 )\n", "glIsEnabled\n", "glBlendFunc( 0x302, 0x303 )\n", "glAlphaFunc( 0x204, 0.007812 )\n"]);
      logging.endFrame(); const count = output.length;
      gl.glColor4ub(255, 128, 127, 0); gl.glGetFloatv(0xb00, actual);
      expect(Array.from(actual)).toEqual(Array.from(expectedUnsigned)); expect(output).toHaveLength(count);
      expect(library.symbols.glGetError()).toBe(0);
    } finally { library.close(); window.close(); logging.close(); }
  });

  test("renders an analytic triangle and flips readback to top-down rows", () => { expect(runGlSmoke()).toContain("readback passed"); });

  test("implements depth comparison, writes, clear and cull transitions", () => withRenderer(renderer => {
    clear(renderer, blue);
    draw(renderer, quad(red, 0)); draw(renderer, quad(green, 0.5));
    expect(pixel(renderer)).toEqual([255, 0, 0, 255]);
    draw(renderer, quad(green, 0, { ...OPAQUE_STATE, depthTest: "equal" }));
    expect(pixel(renderer)).toEqual([0, 255, 0, 255]);
    draw(renderer, quad(blue, -0.5, { ...OPAQUE_STATE, cull: "front" }));
    expect(pixel(renderer)).toEqual([0, 255, 0, 255]);
    draw(renderer, quad(blue, -0.5, { ...OPAQUE_STATE, depthWrite: false }));
    draw(renderer, quad(red, -0.25));
    expect(pixel(renderer)).toEqual([255, 0, 0, 255]);
    draw(renderer, quad(green, 0.9, { ...OPAQUE_STATE, depthTest: "always", depthWrite: false }));
    clear(renderer, blue); draw(renderer, quad(red, 0.5));
    expect(pixel(renderer)).toEqual([255, 0, 0, 255]);
  }));

  test("uploads RGBA textures, samples repeat/clamp and modulates colors", () => withRenderer((renderer, _window, alpha) => {
    const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
    const repeat = publish(renderer, pixels, 2, 1, { wrap: "repeat", filter: "nearest" });
    const clamp = publish(renderer, pixels, 2, 1, { wrap: "clamp", filter: "nearest" });
    const linear = publish(renderer, pixels, 2, 1), edge = publish(renderer, pixels, 2, 1, { wrap: "clamp", filter: "linear" });
    clear(renderer, blue);
    draw(renderer, quad(white, 0, OPAQUE_STATE, repeat, 1.25, 0.5));
    expect(pixel(renderer)).toEqual([255, 0, 0, 255]);
    draw(renderer, quad(white, 0, OPAQUE_STATE, clamp, 1.25, 0.5));
    expect(pixel(renderer)).toEqual([0, 255, 0, 255]);
    draw(renderer, quad(white, 0, OPAQUE_STATE, linear, 0.5));
    nearPixel(renderer, [128, 128, 0, 255]);
    draw(renderer, quad(white, 0, OPAQUE_STATE, edge, 0, 0.5));
    nearPixel(renderer, [128, 0, 0, alpha(128)]);
    draw(renderer, quad({ x: 0.5, y: 1, z: 1, w: 1 }, 0, OPAQUE_STATE, repeat, 0.25, 0.5));
    nearPixel(renderer, [128, 0, 0, 255]);
    pixels.set([0, 0, 255, 255]);
    draw(renderer, quad(white, 0, OPAQUE_STATE, repeat, 0.25, 0.5));
    expect(pixel(renderer)).toEqual([255, 0, 0, 255]);
    update(renderer, repeat, pixels, 2, 1);
    draw(renderer, quad(white, 0, OPAQUE_STATE, repeat, 0.25, 0.5));
    expect(pixel(renderer)).toEqual([0, 0, 255, 255]);
  }));

  test("uses source alpha tests and blending without rejected fragments writing depth", () => withRenderer((renderer, _window, alpha) => {
    clear(renderer, blue);
    // Fixed-function driver precision can move the exact alpha boundary by 1/255.
    draw(renderer, quad({ ...red, w: 126 / 255 }, -0.5, { ...OPAQUE_STATE, alphaTest: "ge128" }));
    expect(pixel(renderer)).toEqual([0, 0, 255, 255]);
    draw(renderer, quad({ ...green, w: 128 / 255 }, 0, { ...OPAQUE_STATE, alphaTest: "ge128" }));
    expect(pixel(renderer)).toEqual([0, 255, 0, alpha(128)]);
    draw(renderer, quad({ ...red, w: 0 }, -0.5, { ...OPAQUE_STATE, alphaTest: "gt0" }));
    expect(pixel(renderer)).toEqual([0, 255, 0, alpha(128)]);
    draw(renderer, quad({ ...red, w: 129 / 255 }, -0.5, { ...OPAQUE_STATE, alphaTest: "lt128" }));
    expect(pixel(renderer)).toEqual([0, 255, 0, alpha(128)]);
    draw(renderer, quad({ ...red, w: 126 / 255 }, -0.5, { ...OPAQUE_STATE, alphaTest: "lt128" }));
    expect(pixel(renderer)).toEqual([255, 0, 0, alpha(126)]);
    clear(renderer, blue);
    draw(renderer, quad({ ...red, w: 0.5 }, 0, { ...OPAQUE_STATE, blend: { source: "src-alpha", destination: "one-minus-src-alpha" } }));
    nearPixel(renderer, [128, 0, 127, alpha(191)]);
  }));

  test("validates native buffer boundaries and retains window ownership", () => withRenderer((renderer, window) => {
    const batch = quad(red);
    expect(() => draw(renderer, { ...batch, indices: [0, 1, 4] })).toThrow("out of range");
    expect(() => draw(renderer, { ...batch, indices: [0] })).toThrow("count");
    expect(() => draw(renderer, quad(red, NaN))).toThrow("finite");
    expect(() => publish(renderer, new Uint8Array(4), 2, 2)).toThrow("RGBA");
    renderer.close(); renderer.close();
    expect(() => clear(renderer, blue)).toThrow("closed");
    expect(window.drawableSize).toEqual({ width: 16, height: 16 });
    window.swap();
  }));

  test("switches renderer contexts while keeping their framebuffer and texture state separate", () => withRenderer(first => {
    clear(first, red);
    withRenderer(second => {
      clear(second, blue);
      expect(pixel(first)).toEqual([255, 0, 0, 255]);
      draw(first, quad(green));
      expect(pixel(second)).toEqual([0, 0, 255, 255]);
    });
    expect(pixel(first)).toEqual([0, 255, 0, 255]);
  }));

  test("submits homogeneous positions for GPU clipping and perspective division", () => withRenderer(renderer => {
    clear(renderer, blue);
    const batch = quad(red);
    draw(renderer, { ...batch, vertices: batch.vertices.map(vertex => ({ ...vertex, position: { ...vertex.position, w: 2 } })) });
    expect(pixel(renderer)).toEqual([255, 0, 0, 255]);
    expect(Array.from(renderer.readPixels().subarray(0, 4))).toEqual([0, 0, 255, 255]);
    draw(renderer, quad(green, -2));
    expect(pixel(renderer)).toEqual([255, 0, 0, 255]);
  }));

  test("retains distinct immutable images and updates subviews only through explicit cinematic upload", () => withRenderer(renderer => {
    const memory = new Uint8Array([17, 18, 19, 20, 255, 0, 0, 255, 0, 255, 0, 255, 21, 22, 23, 24]);
    const first = publish(renderer, memory.subarray(4, 8), 1, 1);
    const second = publish(renderer, memory.subarray(8, 12), 1, 1);
    clear(renderer, blue);
    draw(renderer, quad(white, 0, OPAQUE_STATE, first));
    expect(pixel(renderer)).toEqual([255, 0, 0, 255]);
    draw(renderer, quad(white, 0, OPAQUE_STATE, second));
    expect(pixel(renderer)).toEqual([0, 255, 0, 255]);
    draw(renderer, quad(white, 0, OPAQUE_STATE, first));
    expect(pixel(renderer)).toEqual([255, 0, 0, 255]);
    memory.subarray(4, 8).set([0, 0, 255, 255]);
    memory[0] = 99;
    draw(renderer, quad(white, 0, OPAQUE_STATE, first));
    expect(pixel(renderer)).toEqual([255, 0, 0, 255]);
    update(renderer, first, memory.subarray(4, 8), 1, 1);
    expect(pixel(renderer)).toEqual([0, 0, 255, 255]);
    draw(renderer, quad(white, 0, OPAQUE_STATE, second));
    expect(pixel(renderer)).toEqual([0, 255, 0, 255]);
  }));

  test("owns geometry buffers without drawing stale vertices or index tails", () => withRenderer(renderer => {
    clear(renderer, blue);
    draw(renderer, quad(red));
    clear(renderer, blue);
    const batch = quad(green);
    draw(renderer, { ...batch, vertices: batch.vertices.slice(0, 3), indices: [0, 1, 2] });
    const topLeft = (2 * 16 + 2) * 4;
    expect(Array.from(renderer.readPixels().subarray(topLeft, topLeft + 4))).toEqual([0, 0, 255, 255]);
    clear(renderer, blue);
    draw(renderer, { ...batch, indices: [] });
    expect(pixel(renderer)).toEqual([0, 0, 255, 255]);
    draw(renderer, quad(red));
    expect(pixel(renderer)).toEqual([255, 0, 0, 255]);
  }));
});
