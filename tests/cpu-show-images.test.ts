// tr_backend.c RB_ShowImages and its retained fixed-function state, id Software renderer.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { CvarRegistry } from "../src/core/cvar.ts";
import type { Vec4 } from "../src/core/math.ts";
import { RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog, RgbaSnapshot } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { SourceStateBit } from "../src/render/source-state.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import type { RenderState, SourceStageData } from "../src/render/types.ts";
import { executeStaticBatch, publishTexture } from "./render-target-fixture.ts";

const white: Vec4 = { x: 1, y: 1, z: 1, w: 1 }, black: Vec4 = { x: 0, y: 0, z: 0, w: 1 };
const opaque: RenderState = { ...OPAQUE_STATE, cull: "none" };
const quad = [{ x: -1, y: 1, z: 0, w: 1 }, { x: 1, y: 1, z: 0, w: 1 },
  { x: 1, y: -1, z: 0, w: 1 }, { x: -1, y: -1, z: 0, w: 1 }];
const quadIndices = [0, 1, 2, 0, 2, 3];

function pixels(width: number, height: number, color: readonly [number, number, number, number]): Uint8Array {
  const result = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < result.length; offset += 4) result.set(color, offset);
  return result;
}
function texture(images: RendererImageCatalog, name: string, bytes: Uint8Array, width = bytes.length / 4, height = 1): RendererImage {
  return publishTexture(images, { name, pixels: bytes, width, height, internalFormat: "rgba8",
    sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
}
function pixel(cpu: SoftwareRenderer, x: number, y: number): number[] {
  const offset = (y * cpu.width + x) * 4;
  return [...cpu.pixels.subarray(offset, offset + 4)];
}
function clear(cpu: SoftwareRenderer, color: Vec4 | null = black, depth = 1): void {
  cpu.beginView({ viewport: { x: 0, y: 0, width: cpu.width, height: cpu.height }, clear: { color, depth, stencil: true } });
}
function enter2D(cpu: SoftwareRenderer): void {
  cpu.beginView({ viewport: { x: 0, y: 0, width: cpu.width, height: cpu.height }, clear: null });
}
function source(image: RendererImage, color: Vec4 = white, indices: readonly number[] = [0, 0, 0]): Extract<SourceStageData, { batch: { texturing: "single" } }> {
  const vertices = quad.map(position => ({ position, color, texCoord: { x: 0.75, y: 0.5 } }));
  return { kind: "generic-single", stateBits: SourceStateBit.DEFAULT,
    batch: { primitive: "triangles", texturing: "single", texture: { kind: "bind-image", image }, vertices, indices, state: opaque },
    scratch: vertices.map(vertex => ({ color: vertex.color, texCoord: vertex.texCoord, texCoord2: { x: 0.75, y: 0.5 },
      rawTexCoord: { ...vertex.texCoord }, rawTexCoord2: { x: 0.75, y: 0.5 } })) };
}
function retain(cpu: SoftwareRenderer, stage: SourceStageData, mode = 0): void {
  const first = stage.batch.texture, second = stage.batch.texturing === "pair" ? stage.batch.secondTexture.binding : null;
  if (first.kind === "shader-cinematic" || second?.kind === "shader-cinematic") throw new Error("Show-images fixture requires static bindings");
  if (stage.kind === "generic-single" || stage.kind === "generic-pair")
    cpu.drawImmediate({ kind: "begin-generic-iterator", setArraysOnce: stage.kind === "generic-single", scratch: stage.scratch });
  const prepared = cpu.prepareSourceGeometry(stage);
  prepared.begin(); prepared.prepareTexture(0); prepared.applyTexture(0, first);
  if (second !== null) { prepared.prepareTexture(1); prepared.applyTexture(1, second); }
  prepared.finishTextures(); prepared.draw(mode); prepared.cleanup();
}
interface Fixture { readonly cpu: SoftwareRenderer; readonly images: RendererImageCatalog; readonly cvars: CvarRegistry; readonly whiteImage: RendererImage }
function withCpu(width: number, height: number, action: (fixture: Fixture) => void, stencilBits = 0): void {
  const images = new RendererImageCatalog(), cvars = new CvarRegistry();
  images.setBindingSettings(new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true }));
  const cpu = new SoftwareRenderer(width, height, images, 8, stencilBits), target = new RenderTarget(images, [cpu]);
  try {
    const whiteImage = texture(images, "white", new Uint8Array([255, 255, 255, 255]));
    texture(images, "registration sentinel", new Uint8Array([0, 0, 0, 255]));
    action({ cpu, images, cvars, whiteImage });
  } finally { target.close(); }
}

describe("CPU RB_ShowImages", () => {
  test("641x481 grid cells retain pixel origins at indices 19, 20 and 300", () => withCpu(641, 481, ({ cpu, images }) => {
    const red = texture(images, "red", new Uint8Array([255, 0, 0, 255]));
    const green = texture(images, "green", new Uint8Array([0, 255, 0, 255]));
    const blue = texture(images, "blue", new Uint8Array([0, 0, 255, 255]));
    clear(cpu); enter2D(cpu);
    cpu.drawShowImage(red, { x: 608, y: 0, width: 32, height: 32 }, false);
    cpu.drawShowImage(green, { x: 0, y: 32, width: 32, height: 32 }, false);
    cpu.drawShowImage(blue, { x: 0, y: 480, width: 32, height: 32 }, false);
    expect(pixel(cpu, 608, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(cpu, 639, 31)).toEqual([255, 0, 0, 255]);
    expect(pixel(cpu, 640, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(cpu, 0, 32)).toEqual([0, 255, 0, 255]);
    expect(pixel(cpu, 31, 63)).toEqual([0, 255, 0, 255]);
    expect(pixel(cpu, 32, 32)).toEqual([0, 0, 0, 255]);
    expect(pixel(cpu, 0, 480)).toEqual([0, 0, 255, 255]);
    expect(pixel(cpu, 31, 480)).toEqual([0, 0, 255, 255]);
  }));

  test("default strips retain nonwhite current color and immediate UV0 ignores r_primitives", () => withCpu(8, 8, ({ cpu, images, whiteImage, cvars }) => {
    const palette = texture(images, "palette", new Uint8Array([64, 128, 192, 255, 192, 64, 128, 255]));
    const tint = { x: 0.5, y: 0.25, z: 0.75, w: 1 };
    retain(cpu, source(whiteImage, tint));
    clear(cpu); enter2D(cpu); cvars.set("r_primitives", "-1");
    cpu.drawShowImage(palette, { x: 0, y: 0, width: 8, height: 8 }, false);
    expect(pixel(cpu, 1, 4)).toEqual([32, 32, 144, 255]);
    expect(pixel(cpu, 6, 4)).toEqual([96, 16, 96, 255]);
  }));

  test("mode 2 scales by requested level-zero upload size despite source dimensions and r_nobind", () => withCpu(64, 64, ({ cpu, images, cvars }) => {
    const requested = images.create({ name: "downsampled", sourceWidth: 512, sourceHeight: 1024,
      levels: [{ width: 128, height: 256, pixels: pixels(128, 256, [255, 0, 0, 255]) }], mipmap: false,
      internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
    const dlight = texture(images, "dlight", pixels(64, 64, [0, 255, 0, 255]), 64, 64);
    texture(images, "final registration", new Uint8Array([0, 0, 0, 255])); images.setDlightImage(dlight);
    for (const noBind of [false, true]) {
      clear(cpu); enter2D(cpu); cvars.set("r_nobind", noBind ? "1" : "0");
      cpu.drawShowImage(requested, { x: 5, y: 7, width: 32, height: 32 }, true);
      const expected = noBind ? [0, 255, 0, 255] : [255, 0, 0, 255];
      expect(pixel(cpu, 5, 7)).toEqual(expected); expect(pixel(cpu, 12, 22)).toEqual(expected);
      expect(pixel(cpu, 13, 7)).toEqual([0, 0, 0, 255]); expect(pixel(cpu, 5, 23)).toEqual([0, 0, 0, 255]);
    }
  }));

  for (const path of ["shader", "raw"]) test(`${path} cinematic resize updates requested upload dimensions when r_nobind redirects storage`, () => withCpu(64, 64, ({ cpu, images, cvars }) => {
    const scratch = texture(images, "scratch", pixels(32, 32, [255, 0, 0, 255]), 32, 32);
    const dlight = texture(images, "dlight", pixels(64, 64, [0, 0, 255, 255]), 64, 64);
    texture(images, "final registration", new Uint8Array([0, 0, 0, 255])); images.setDlightImage(dlight); cvars.set("r_nobind", "1");
    const upload = { image: scratch, sourceWidth: 128, sourceHeight: 256, uploadWidth: 128, uploadHeight: 256,
      content: new RgbaSnapshot(128, 256, pixels(128, 256, [0, 255, 0, 255])), dirty: false };
    if (path === "shader") {
      const stage = source(scratch, white, []);
      cpu.drawImmediate({ kind: "begin-generic-iterator", setArraysOnce: true, scratch: stage.scratch });
      const prepared = cpu.prepareSourceGeometry(stage);
      prepared.begin(); prepared.prepareTexture(0); prepared.applyTexture(0, { kind: "cinematic-upload", upload });
      prepared.finishTextures(); prepared.draw(-1); prepared.cleanup();
    } else {
      const prepared = cpu.prepareRawGeometry({ rect: { x: 0, y: 64, width: 32, height: 32 }, uploadWidth: 128, uploadHeight: 256, identityLight: 1 });
      prepared.uploadCurrent(upload); prepared.draw();
    }
    clear(cpu); enter2D(cpu);
    cpu.drawShowImage(scratch, { x: 0, y: 0, width: 32, height: 32 }, true);
    cpu.drawShowImage(dlight, { x: 32, y: 0, width: 32, height: 32 }, true);
    expect(pixel(cpu, 7, 15)).toEqual([0, 255, 0, 255]);
    expect(pixel(cpu, 8, 0)).toEqual([0, 0, 0, 255]); expect(pixel(cpu, 0, 16)).toEqual([0, 0, 0, 255]);
    expect(pixel(cpu, 34, 2)).toEqual([0, 255, 0, 255]);
    expect(pixel(cpu, 36, 0)).toEqual([0, 0, 0, 255]); expect(pixel(cpu, 32, 4)).toEqual([0, 0, 0, 255]);
  }));

  test("active unit 1 retains its secondary environment and coordinates while the quad supplies UV0", () => withCpu(32, 32, ({ cpu, images, whiteImage }) => {
    const primary = texture(images, "primary", new Uint8Array([32, 64, 96, 255, 128, 160, 192, 255]));
    const secondary = texture(images, "secondary", new Uint8Array([255, 0, 0, 255, 0, 32, 64, 255]));
    const single = source(primary, { x: 0.5, y: 0.5, z: 0.5, w: 1 });
    const pair: SourceStageData = { ...single, kind: "generic-pair", batch: { ...single.batch, texturing: "pair",
      vertices: single.batch.vertices.map(vertex => ({ ...vertex, texCoord2: { x: 0.75, y: 0.5 } })),
      secondTexture: { binding: { kind: "bind-image", image: whiteImage }, environment: "add" } } };
    cpu.drawImmediate({ kind: "begin-generic-iterator", setArraysOnce: false, scratch: pair.scratch });
    const prepared = cpu.prepareSourceGeometry(pair);
    prepared.begin(); prepared.prepareTexture(0); prepared.applyTexture(0, { kind: "bind-image", image: primary });
    prepared.prepareTexture(1); prepared.applyTexture(1, { kind: "bind-image", image: whiteImage });
    prepared.finishTextures(); prepared.draw(0);
    clear(cpu); enter2D(cpu);
    cpu.drawShowImage(secondary, { x: 0, y: 0, width: 32, height: 32 }, false);
    expect(pixel(cpu, 4, 16)).toEqual([16, 64, 112, 255]); expect(pixel(cpu, 28, 16)).toEqual([64, 112, 160, 255]);
    cpu.drawImmediate({ kind: "entity-axis", whiteImage: secondary, positions: [
      { x: -0.75, y: 0.5, z: 0, w: 1 }, { x: 0.75, y: 0.5, z: 0, w: 1 },
      { x: 2, y: 2, z: 0, w: 1 }, { x: 3, y: 2, z: 0, w: 1 },
      { x: 2, y: 2, z: 0, w: 1 }, { x: 3, y: 2, z: 0, w: 1 },
    ] });
    expect(pixel(cpu, 16, 8)).toEqual([32, 32, 64, 255]);
    prepared.cleanup();
  }));

  test("indexed primary coordinates are replaced by immediate UV0 after an explicit known-color write", () => withCpu(8, 8, ({ cpu, images }) => {
    const palette = texture(images, "palette", new Uint8Array([64, 128, 192, 255, 192, 64, 128, 255]));
    texture(images, "final registration", new Uint8Array([0, 0, 0, 255]));
    retain(cpu, source(palette), 2);
    expect(() => cpu.drawShowImage(palette, { x: 0, y: 0, width: 8, height: 8 }, false)).toThrow("CPU show-images color is source-indeterminate");
    cpu.drawImmediate({ kind: "sky-box-state", identityLight: 0.5 });
    clear(cpu); enter2D(cpu);
    cpu.drawShowImage(palette, { x: 0, y: 0, width: 8, height: 8 }, false);
    expect(pixel(cpu, 1, 4)).toEqual([32, 64, 96, 255]); expect(pixel(cpu, 6, 4)).toEqual([96, 32, 64, 255]);
  }));

  test("clipped and degenerate quads still publish the final UV0", () => {
    for (const rect of [{ x: 0, y: 32, width: 32, height: 32 }, { x: 0, y: 0, width: 0, height: 32 }]) withCpu(32, 32, ({ cpu, images }) => {
      const palette = texture(images, "palette", new Uint8Array([32, 96, 160, 255, 208, 176, 144, 255]));
      texture(images, "final registration", new Uint8Array([0, 0, 0, 255]));
      retain(cpu, source(palette)); clear(cpu); enter2D(cpu);
      cpu.drawShowImage(palette, rect, false);
      expect(pixel(cpu, 16, 8)).toEqual([0, 0, 0, 255]);
      cpu.drawImmediate({ kind: "entity-axis", whiteImage: palette, positions: [
        { x: -0.75, y: 0.5, z: 0, w: 1 }, { x: 0.75, y: 0.5, z: 0, w: 1 },
        { x: -0.75, y: 0, z: 0, w: 1 }, { x: 0.75, y: 0, z: 0, w: 1 },
        { x: -0.75, y: -0.5, z: 0, w: 1 }, { x: 0.75, y: -0.5, z: 0, w: 1 },
      ] });
      expect(pixel(cpu, 16, 8)).toEqual([32, 0, 0, 255]);
    });
  });

  test("line-mode quads retain culling and their clipped perimeter without a diagonal", () => withCpu(32, 32, ({ cpu, whiteImage }) => {
    clear(cpu);
    const debug = cpu.prepareDebugTris({ allocation: { kind: "standalone" }, whiteImage, positions: [], indices: [], scratch: [] });
    debug.begin(); debug.draw(-1); debug.cleanup();
    cpu.drawShowImage(whiteImage, { x: 4, y: 4, width: 24, height: 24 }, false);
    expect(pixel(cpu, 16, 4)).toEqual([255, 255, 255, 255]); expect(pixel(cpu, 3, 16)).toEqual([255, 255, 255, 255]);
    expect(pixel(cpu, 16, 16)).toEqual([0, 0, 0, 255]);
    cpu.clearColorBuffer(); cpu.drawImmediate({ kind: "cull", cull: "back" });
    cpu.drawShowImage(whiteImage, { x: 4, y: 4, width: 24, height: 24 }, false);
    expect(pixel(cpu, 16, 4)).toEqual([0, 0, 0, 255]);
    cpu.beginView({ viewport: { x: 0, y: 0, width: 32, height: 32 }, clear: null, clipPlane: { x: 1, y: 0, z: 0, w: 0 } });
    const clipped = cpu.prepareDebugTris({ allocation: { kind: "standalone" }, whiteImage, positions: [], indices: [], scratch: [] });
    clipped.begin(); clipped.draw(-1); clipped.cleanup();
    cpu.drawShowImage(whiteImage, { x: -4, y: 4, width: 32, height: 24 }, false);
    expect(pixel(cpu, 15, 16)).toEqual([255, 255, 255, 255]); expect(pixel(cpu, 24, 16)).toEqual([0, 0, 0, 255]);
  }));

  test("retained depth test, range and polygon offset still control image fragments", () => withCpu(8, 8, ({ cpu, whiteImage }) => {
    clear(cpu, black, 0.25);
    cpu.drawImmediate({ kind: "depth-range", range: [0.5, 0.5] });
    cpu.drawShowImage(whiteImage, { x: 0, y: 0, width: 8, height: 8 }, false);
    expect(pixel(cpu, 4, 4)).toEqual([0, 0, 0, 255]);
    cpu.drawImmediate({ kind: "depth-range", range: [0, 1] });
    cpu.drawImmediate({ kind: "polygon-offset", value: { factor: 0, units: 2 ** 24 } });
    cpu.drawShowImage(whiteImage, { x: 0, y: 0, width: 8, height: 8 }, false);
    expect(pixel(cpu, 4, 4)).toEqual([0, 0, 0, 255]);
    cpu.drawImmediate({ kind: "polygon-offset", value: null });
    cpu.drawShowImage(whiteImage, { x: 0, y: 0, width: 8, height: 8 }, false);
    expect(pixel(cpu, 4, 4)).toEqual([255, 255, 255, 255]);
  }));

  test("color-only clear starts transparent black and retains explicit clear color under scissor", () => withCpu(8, 8, ({ cpu, whiteImage }) => {
    cpu.drawShowImage(whiteImage, { x: 0, y: 0, width: 8, height: 8 }, false);
    cpu.clearColorBuffer(); expect(cpu.pixels).toEqual(new Uint8Array(8 * 8 * 4));
    clear(cpu, { x: 0.25, y: 0.5, z: 0.75, w: 0.5 });
    cpu.drawShowImage(whiteImage, { x: 0, y: 0, width: 8, height: 8 }, false);
    cpu.beginView({ viewport: { x: 2, y: 3, width: 3, height: 2 }, clear: { color: null, depth: 0.25, stencil: false } });
    cpu.clearColorBuffer();
    expect(pixel(cpu, 2, 3)).toEqual([64, 128, 191, 128]); expect(pixel(cpu, 4, 4)).toEqual([64, 128, 191, 128]);
    expect(pixel(cpu, 1, 3)).toEqual([255, 255, 255, 255]); expect(pixel(cpu, 5, 4)).toEqual([255, 255, 255, 255]);
  }));

  test("color-only clear preserves depth and stencil for later actual draws", () => withCpu(8, 8, ({ cpu, whiteImage }) => {
    const gray = { x: 200 / 255, y: 200 / 255, z: 200 / 255, w: 1 };
    clear(cpu, gray, 0.25);
    const positions: readonly [Vec4, Vec4, Vec4, Vec4] = [{ x: -1, y: -1, z: -0.75, w: 1 }, { x: 1, y: -1, z: -0.75, w: 1 },
      { x: 1, y: 1, z: -0.75, w: 1 }, { x: -1, y: 1, z: -0.75, w: 1 }];
    cpu.drawImmediate({ kind: "shadow-volume", whiteImage, positions, indices: quadIndices, mirror: false });
    cpu.clearColorBuffer();
    executeStaticBatch(cpu, source(whiteImage, { x: 1, y: 0, z: 0, w: 1 }, quadIndices).batch);
    expect(pixel(cpu, 4, 4)).toEqual([200, 200, 200, 255]);
    cpu.drawImmediate({ kind: "shadow-finish", whiteImage, positions });
    expect(pixel(cpu, 4, 4)).toEqual([120, 120, 120, 255]);
  }, 8));
});
