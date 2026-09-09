// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { UI_PICTURE_STATE } from "../src/render/draw2d.ts";
import type { CoordinateSpace, ImagePicture } from "../src/render/draw2d.ts";
import { RenderCommandBuffer, RenderTarget, RendererCommandStorage } from "../src/render/commands.ts";
import { SOURCE_COMMAND_RELEASE32 } from "../src/render/command-memory.ts";
import { RendererImageCatalog, RgbaSnapshot } from "../src/render/image-resource.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import { parseShaderScript } from "../src/render/material.ts";
import { finishShader } from "../src/render/material-finish.ts";
import { createRendererSettings } from "./renderer-settings-fixture.ts";
import { BatchRecordingBackend, publishTexture } from "./render-target-fixture.ts";

const white = { x: 1, y: 1, z: 1, w: 1 };
const runtime = { smpRequested: false, skipBackEnd: false, speeds: 0, clear: false, measureOverdraw: 0, showImages: 0, debugSort: 0, showTris: 0, showNormals: 0, primitives: 0, finish: 0, logFile: 0, lightmap: false, vertexLighting: false, polygonOffset: { factor: -1, units: -2 } };
function fixture(width = 16, height = 16, space: CoordinateSpace = "pixels", identityLight = 1) {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(width, height, images), recorder = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, [recorder]);
  const texture = publishTexture(images, { name: "white", width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  publishTexture(images, { name: "registration-tail", width: 1, height: 1, pixels: new Uint8Array([0, 0, 0, 0]), internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  const commandStorage = new RendererCommandStorage(() => null, "isolated");
  const queue = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight, tess: new SourceTessState(), runtime, commandStorage });
  const picture: ImagePicture = { kind: "image", name: "fixture", texture: { kind: "bind-image", image: texture }, state: UI_PICTURE_STATE, color: { rgb: "vertex", alpha: "vertex" } };
  return { images, cpu, recorder, target, queue, commandStorage, draw: queue.draw2D(space), picture, texture };
}
function batch(f: ReturnType<typeof fixture>, index = 0) {
  f.queue.submit(); const result = f.recorder.trace().flatMap(view => view.batches)[index];
  if (result === undefined) throw new Error("Missing executed batch"); return result;
}
function point(f: ReturnType<typeof fixture>, index: number, vertex: number): readonly number[] {
  const value = batch(f, index).vertices[vertex]; if (value === undefined) throw new Error("Missing vertex");
  return [(value.position.x + 1) * f.draw.width / 2, (1 - value.position.y) * f.draw.height / 2];
}
test("picture stages follow source byte color and distinguish identity, lighting and exact vertex", () => {
  const f = fixture(16, 16, "pixels", 0.5);
  f.draw.setColor({ x: 0.5, y: 0.25, z: 1, w: 0.25 });
  for (const rgb of ["vertex", "exactvertex", "identity", "identitylighting"] satisfies readonly ImagePicture["color"]["rgb"][]) {
    f.draw.drawPic({ x: 0, y: 0, width: 8, height: 8 }, { ...f.picture, color: { rgb, alpha: rgb === "identitylighting" ? "identitylighting" : rgb === "identity" ? "identity" : "vertex" } });
  }
  f.queue.submit(); expect(f.recorder.trace().flatMap(view => view.batches).map(batch => batch.vertices[0]?.color)).toEqual([
    { x: 63 / 255, y: 31 / 255, z: 127 / 255, w: 63 / 255 }, { x: 127 / 255, y: 63 / 255, z: 1, w: 63 / 255 },
    white, { x: 127 / 255, y: 127 / 255, z: 127 / 255, w: 127 / 255 },
  ]); f.target.close();
});
test("base menus pillarbox while cgame and Team Arena stretch independently", () => {
  const f = fixture(1280, 720), rect = { x: 0, y: 0, width: 640, height: 480 };
  expect(f.queue.draw2D("base-ui-640").scaleX).toBe(1.5000001192092896);
  expect(f.queue.draw2D("base-ui-640").adjust(rect)).toEqual({ x: 160, y: 0, width: 960.0000610351562, height: 720.0000610351562 });
  expect(f.queue.draw2D("stretch-640").adjust(rect)).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
  expect(f.queue.draw2D("team-ui-640").adjust(rect)).toEqual({ x: 0, y: 0, width: 1280, height: 720.0000610351562 }); f.target.close();
  const narrow = fixture(320, 480); expect(narrow.queue.draw2D("base-ui-640").adjust(rect)).toEqual(rect); narrow.target.close();
  const wide = fixture(1000, 721);
  expect(wide.queue.draw2D("base-ui-640").biasX).toBe(19.33331298828125); wide.target.close();
});
test("Team Arena reciprocal scaling preserves exact source picture coordinate words", () => {
  for (const sample of [
    { width: 640, height: 480, scaleX: 1, scaleY: 1, widthWord: 0x44200000, heightWord: 0x43f00000 },
    { width: 1280, height: 720, scaleX: 2, scaleY: 1.5000001192092896, widthWord: 0x44a00000, heightWord: 0x44340001 },
  ]) {
    const f = fixture(sample.width, sample.height, "team-ui-640");
    try {
      expect(f.queue.draw2D("team-ui-640")).toBe(f.draw);
      expect(f.draw.scaleX).toBe(sample.scaleX); expect(f.draw.scaleY).toBe(sample.scaleY); expect(f.draw.biasX).toBe(0);
      f.draw.drawPic({ x: -0, y: -0, width: 640, height: 480 }, f.picture);
      const command = f.commandStorage.memory().data();
      expect([8, 12, 16, 20].map(offset => command.getUint32(offset, true))).toEqual([
        0x80000000, 0x80000000, sample.widthWord, sample.heightWord,
      ]);
      const cg = f.queue.draw2D("stretch-640");
      expect(cg.scaleY).toBe(sample.height === 480 ? 1 : 1.5);
      cg.drawPic({ x: 0, y: 0, width: 640, height: 480 }, f.picture);
      expect(command.getFloat32(SOURCE_COMMAND_RELEASE32.stretchPicBytes + 20, true)).toBe(sample.height);
    } finally { f.queue.close("discard"); f.target.close(); }
  }
  const f = fixture(642, 480, "team-ui-640");
  try {
    expect(f.draw.scaleX).toBe(1.0031250715255737);
    expect(f.queue.draw2D("stretch-640").scaleX).toBe(1.0031249523162842);
    expect(f.queue.draw2D("pixels").adjust({ x: 4, y: 5, width: 6, height: 7 })).toEqual({ x: 4, y: 5, width: 6, height: 7 });
  } finally { f.queue.close("discard"); f.target.close(); }
});
test("StretchPic preserves source indices, UVs, positions and ordered SetColor bytes", () => {
  const f = fixture(640, 480);
  f.draw.setColor({ x: 0.5, y: 0.25, z: 1, w: 0.5 });
  f.draw.stretchPic({ x: 80, y: 60, width: 160, height: 120 }, { s: 0.2, t: 0.3, s2: 0.6, t2: 0.8 }, f.picture);
  f.draw.setColor(null); f.draw.drawPic({ x: 0, y: 0, width: 1, height: 1 }, f.picture);
  expect(batch(f).indices).toEqual([3, 0, 2, 2, 0, 1]); expect(point(f, 0, 0)).toEqual([80, 60]); expect(point(f, 0, 2)).toEqual([240, 180]);
  expect(batch(f).vertices[0]?.color).toEqual({ x: 127 / 255, y: 63 / 255, z: 1, w: 127 / 255 }); expect(batch(f, 1).vertices[0]?.color).toEqual(white);
  expect(batch(f).state.depthWrite).toBe(false); expect(batch(f).state.depthTest).toBe("always"); f.target.close();
});
test("Draw2D reserves each picture before reentrant lookup and skips lookup on command overflow", () => {
  const f = fixture(), rect = { x: 0, y: 0, width: 8, height: 8 }, uv = { s: 0, t: 0, s2: 1, t2: 1 };
  const draws: readonly ((picture: () => ImagePicture) => void)[] = [
    picture => f.draw.stretchPixels(rect, uv, picture),
    picture => f.draw.stretchPic(rect, uv, picture),
    picture => f.draw.drawHandlePic(rect, picture),
  ];
  try {
    for (const draw of draws) {
      let lookups = 0;
      f.draw.setColor({ x: 1, y: 0, z: 0, w: 1 });
      draw(() => {
        lookups++;
        f.draw.setColor({ x: 0, y: 1, z: 0, w: 1 });
        f.draw.drawPic({ x: 8, y: 0, width: 8, height: 8 }, f.picture);
        return f.picture;
      });
      expect(lookups).toBe(1);
      expect(f.queue.submit().commands).toBe(4);
      expect(Array.from(f.cpu.pixels.subarray((2 * 16 + 2) * 4, (2 * 16 + 2) * 4 + 4))).toEqual([255, 0, 0, 255]);
      expect(Array.from(f.cpu.pixels.subarray((2 * 16 + 10) * 4, (2 * 16 + 10) * 4 + 4))).toEqual([0, 255, 0, 255]);
      const colors = Math.floor((SOURCE_COMMAND_RELEASE32.capacity - SOURCE_COMMAND_RELEASE32.endBytes) / SOURCE_COMMAND_RELEASE32.setColorBytes);
      for (let index = 0; index < colors; index++) f.draw.setColor(null);
      draw(() => { lookups++; return f.picture; });
      expect(lookups).toBe(1);
      expect(f.queue.submit().commands).toBe(colors);
    }
  } finally { f.target.close(); }
});
test("identity light scales RGB bytes without changing alpha", () => {
  const f = fixture(16, 16, "pixels", 0.5);
  f.draw.setColor({ x: 0.5, y: 1, z: 0.25, w: 0.5 }); f.draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, f.picture);
  expect(batch(f).vertices[0]?.color).toEqual({ x: 63 / 255, y: 127 / 255, z: 31 / 255, w: 127 / 255 }); f.target.close();
});
test("UI negative sizes flip UV at the same anchor; cgame preserves signed geometry", () => {
  const f = fixture(640, 480), rect = { x: 320, y: 240, width: -160, height: -120 };
  f.draw.setColor(null); f.draw.drawHandlePic(rect, f.picture); f.draw.drawPic(rect, f.picture);
  expect(point(f, 0, 2)).toEqual([480, 360]); expect(point(f, 1, 2)).toEqual([160, 120]);
  expect(batch(f).vertices[0]?.texCoord).toEqual({ x: 1, y: 1 }); expect(batch(f).vertices[2]?.texCoord).toEqual({ x: 0, y: 0 }); f.target.close();
});
test("UI outlines remain one physical pixel; cgame scales virtual thickness", () => {
  const f = fixture(1280, 960), rect = { x: 0, y: 0, width: 100, height: 100 };
  f.queue.draw2D("base-ui-640").drawUiRect(rect, white, f.picture);
  f.queue.draw2D("stretch-640").drawCgRect(rect, 1, white, f.picture);
  expect(point(f, 0, 2)[1]).toBeCloseTo(1, 4); expect(point(f, 4, 2)[1]).toBeCloseTo(2, 4); f.target.close();
});
test("base UI outlines retain source edge order and round addition before subtracting one", () => {
  const f = fixture(640, 480, "base-ui-640");
  try {
    f.draw.drawUiRect({ x: 16777216, y: 16777216, width: 1, height: 3 }, white, f.picture);
    const commands = f.commandStorage.memory().data();
    const rectangles = Array.from({ length: 4 }, (_, index) => {
      const offset = SOURCE_COMMAND_RELEASE32.setColorBytes + index * SOURCE_COMMAND_RELEASE32.stretchPicBytes;
      return [8, 12, 16, 20].map(field => commands.getFloat32(offset + field, true));
    });
    expect(rectangles).toEqual([
      [16777216, 16777216, 1, 1], [16777216, 16777216, 1, 3],
      [16777216, 16777220, 1, 1], [16777215, 16777216, 1, 3],
    ]);
  } finally { f.queue.close("discard"); f.target.close(); }
});
test("Team Arena ui_atoms outlines remain distinct from active scaled display callbacks", () => {
  const f = fixture(1280, 960, "team-ui-640"), rect = { x: 10, y: 20, width: 30, height: 40 };
  try {
    f.draw.drawUiRect(rect, white, f.picture);
    f.draw.drawCgRect(rect, 3, white, f.picture);
    const commands = f.commandStorage.memory().data();
    const rectangles = (start: number) => Array.from({ length: 4 }, (_, index) => {
      const offset = start + SOURCE_COMMAND_RELEASE32.setColorBytes + index * SOURCE_COMMAND_RELEASE32.stretchPicBytes;
      return [8, 12, 16, 20].map(field => commands.getFloat32(offset + field, true));
    });
    expect(rectangles(0)).toEqual([[20, 40, 60, 1], [20, 119, 60, 1], [20, 40, 1, 80], [79, 40, 1, 80]]);
    const second = 2 * SOURCE_COMMAND_RELEASE32.setColorBytes + 4 * SOURCE_COMMAND_RELEASE32.stretchPicBytes;
    expect(rectangles(second)).toEqual([[20, 40, 60, 6], [20, 114, 60, 6], [20, 40, 6, 80], [74, 40, 6, 80]]);
  } finally { f.queue.close("discard"); f.target.close(); }
});
test("actual CPU alpha picture clips without an internal shared-edge seam", () => {
  const f = fixture(); f.queue.addView({ viewport: { x: 0, y: 0, width: 16, height: 16 }, clear: { stencil: false, color: { x: 0, y: 0, z: 0, w: 1 }, depth: 1 }, operations: [{ kind: "draw", batches: [] }] });
  f.draw.fillRect({ x: -2, y: -2, width: 20, height: 20 }, { x: 1, y: 0, z: 0, w: 0.5 }, f.picture); f.queue.submit();
  for (let index = 0; index < f.cpu.pixels.length; index += 4) expect(f.cpu.pixels[index]).toBe(127); f.target.close();
});
test("source Fade's tenth binary32 subtraction still paints with zero alpha byte", () => {
  const f = fixture();
  try {
    let alpha = Math.fround(1);
    for (let step = 0; step < 10; step++) alpha = Math.fround(alpha - Math.fround(0.1));
    expect(alpha).toBe(-7.450580596923828e-8);
    f.queue.addView({ viewport: { x: 0, y: 0, width: 16, height: 16 }, clear: { stencil: false, color: { x: 0, y: 0, z: 1, w: 1 }, depth: 1 }, operations: [{ kind: "draw", batches: [] }] });
    f.draw.setColor({ x: 1, y: 0, z: 0, w: alpha });
    f.draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, f.picture);
    expect(batch(f).vertices[0]?.color).toEqual({ x: 1, y: 0, z: 0, w: 0 });
    expect(Array.from(f.cpu.pixels.subarray((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4))).toEqual([0, 0, 255, 255]);
  } finally { f.target.close(); }
});
test("SetColor byte wrapping agrees for image and material pictures and survives a raw draw barrier", async () => {
  const f = fixture();
  try {
    const definition = parseShaderScript("pic { { map $whiteimage rgbGen exactVertex alphaGen vertex blendFunc blend } }")[0];
    if (definition === undefined) throw new Error("Missing fixture shader");
    const finished = finishShader({ definition, lightmapIndex: -4, profile: createRendererSettings().registrationProfile(), images: [{ kind: "loaded", tmu: 0,
      binding: { kind: "images", playback: { kind: "single", image: { image: f.texture } } } }] });
    const material = await new MaterialRegistry(async () => ({ definition, image: f.texture, whiteImage: f.texture, finished, defaulted: false, sky: null }), text => { throw new Error(text); })
      .register("pic", { kind: "picture" });
    const content = new RgbaSnapshot(1, 1, new Uint8Array([255, 255, 255, 255]));
    f.draw.setColor({ x: -0.5, y: 1.5, z: 2, w: 1 });
    f.draw.drawPic({ x: 0, y: 0, width: 4, height: 8 }, f.picture);
    f.draw.drawPic({ x: 4, y: 0, width: 4, height: 8 }, { kind: "material", name: "pic", material });
    f.draw.stretchRawPixels({ x: 8, y: 0, width: 4, height: 8 }, { image: f.texture, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1, dirty: true,
      captureAfterBarrier: () => ({ upload: { image: f.texture, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1, dirty: true, content }, afterUiDraw: () => undefined }) });
    f.draw.drawPic({ x: 12, y: 0, width: 4, height: 8 }, f.picture);
    f.draw.setColor(null); f.draw.drawPic({ x: 0, y: 8, width: 16, height: 8 }, f.picture);
    f.queue.submit();
    const colors = f.recorder.trace().flatMap(view => view.batches).map(batch => batch.vertices[0]?.color);
    const wrapped = { x: 129 / 255, y: 126 / 255, z: 254 / 255, w: 1 };
    expect(colors).toEqual([wrapped, wrapped, wrapped, white]);
    for (const x of [2, 6, 14]) expect(Array.from(f.cpu.pixels.subarray((4 * 16 + x) * 4, (4 * 16 + x) * 4 + 4))).toEqual([129, 126, 254, 255]);
    expect(Array.from(f.cpu.pixels.subarray((4 * 16 + 10) * 4, (4 * 16 + 10) * 4 + 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(f.cpu.pixels.subarray((12 * 16 + 8) * 4, (12 * 16 + 8) * 4 + 4))).toEqual([255, 255, 255, 255]);
  } finally { f.target.close(); }
});
test("SetColor rejects nonfinite frontend floats but reaches int32 conversion bounds only on consumption", () => {
  for (const value of [1e20, -1e20]) {
    const f = fixture();
    try {
      f.draw.setColor({ ...white, x: value });
      expect(() => f.queue.submit()).toThrow("int32");
    } finally { f.target.close(); }
  }
});
test("invalid frontend coordinates and colors reject after source command reservation", () => {
  const f = fixture();
  expect(() => f.draw.setColor({ ...white, w: NaN })).toThrow();
  expect(() => f.draw.setColor({ ...white, w: Infinity })).toThrow();
  expect(() => f.draw.setColor({ ...white, w: Number.MAX_VALUE })).toThrow();
  expect(() => f.draw.drawPic({ x: Infinity, y: 0, width: 1, height: 1 }, f.picture)).toThrow();
  expect(f.queue.submit().commands).toBe(4); f.target.close();
});
test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("raw float color preserves source SetColor with actual paired CPU/GL output", () => {
  const images = new RendererImageCatalog(), window = SdlWindow.open({ title: "Raw source color", width: 16, height: 16, backend: "gl", hidden: true });
  const gl = new GlRenderer(window, images), cpu = new SoftwareRenderer(16, 16, images, gl.subpixelBits), target = new RenderTarget(images, [cpu, gl]);
  gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  try {
    const texture = publishTexture(images, { name: "raw", width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgba8", sampling: { wrap: "clamp", filter: "linear" }, registrationUnit: 0 });
    const pictureTexture = publishTexture(images, { name: "white", width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
    publishTexture(images, { name: "tail", width: 1, height: 1, pixels: new Uint8Array(4), internalFormat: "rgba8", sampling: { wrap: "clamp", filter: "linear" }, registrationUnit: 0 });
    const queue = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 0.5, tess: new SourceTessState(), runtime }), draw = queue.draw2D("pixels");
    const content = new RgbaSnapshot(1, 1, new Uint8Array([255, 255, 255, 255]));
    draw.setColor({ x: 1, y: 0, z: 0, w: 1 });
    draw.stretchRawPixels({ x: 0, y: 0, width: 16, height: 16 }, { image: texture, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1, dirty: true,
      captureAfterBarrier: () => ({ upload: { image: texture, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1, dirty: true, content }, afterUiDraw: () => undefined }) });
    draw.drawPic({ x: 0, y: 0, width: 4, height: 4 }, { kind: "image", name: "white", texture: { kind: "bind-image", image: pictureTexture }, color: { rgb: "exactvertex", alpha: "vertex" }, state: UI_PICTURE_STATE }); queue.submit();
    expect(Array.from(cpu.pixels.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    const actual = gl.readPixels(); expect(Array.from(actual.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    expect(cpu.pixels[(8 * 16 + 8) * 4]).toBe(128);
    for (const [index, value] of actual.entries()) {
      const expected = cpu.pixels[index]; if (expected === undefined) throw new Error("Missing pixel");
      expect(Math.abs(value - expected)).toBeLessThanOrEqual(1);
    }
  } finally { target.close(); window.close(); }
});
