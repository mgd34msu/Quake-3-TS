// SPDX-License-Identifier: GPL-2.0-or-later
import { SdlWindow } from "../src/platform/sdl.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import type { DrawBatch } from "../src/render/types.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { createImageColorMappings, prepareImageUpload } from "../src/render/image-upload.ts";
import type { ImageUploadProfile } from "../src/render/image-upload.ts";

function diagnosticUploadProfile(renderer: GlRenderer): ImageUploadProfile {
  return { picmip: 1, roundImagesDown: true, simpleMipMaps: true, colorMipLevels: false,
    textureBits: 0, textureCompression: "none", maxTextureSize: renderer.maxTextureSize,
    colorMappings: createImageColorMappings({ gamma: 1, intensity: 1, requestedOverbrightBits: 1,
      deviceSupportsGamma: false, isFullscreen: false, colorBits: renderer.colorBits }) };
}

export function runGlSmoke(): string {
  const registered = new RegisteredRendererCvars(new CvarRegistry(), process.platform === "linux" ? "linux" : "other", null,
    text => { process.stderr.write(text); });
  const window = SdlWindow.open({ title: "Quake III GL verification", width: 32, height: 32, backend: "gl", hidden: true });
  let renderer: GlRenderer | null = null;
  let target: RenderTarget | null = null, commands: RenderCommandBuffer | null = null;
  try {
    const images = new RendererImageCatalog(); renderer = new GlRenderer(window, images); target = new RenderTarget(images, [renderer]);
    const settings = new SourceRendererSettings(registered, renderer.capabilities);
    renderer.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
      if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
    });
    const uploadProfile = diagnosticUploadProfile(renderer);
    commands = new RenderCommandBuffer(target, { print: (text: string) => { process.stderr.write(text); }, tess: new SourceTessState(), identityLight: uploadProfile.colorMappings.identityLight,
      clock: { milliseconds: () => Math.trunc(performance.now()) },
      runtime: { smpRequested: false, skipBackEnd: false, speeds: 0, clear: false, measureOverdraw: 0, showImages: 0, debugSort: 0, showTris: 0, showNormals: 0, primitives: 0, finish: 0, logFile: 0, lightmap: false, vertexLighting: false, polygonOffset: { factor: -1, units: -2 } } });
    const upload = prepareImageUpload({ width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]) },
      { name: "smoke-white", mipmap: false, allowPicmip: false }, uploadProfile);
    const white = images.create({ ...upload, name: "smoke-white", sourceWidth: 1, sourceHeight: 1, mipmap: false,
      sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
    commands.addView({ viewport: { x: 0, y: 0, width: 32, height: 32 }, clear: { stencil: false, depth: 1, color: { x: 0, y: 0, z: 1, w: 1 } }, operations: [{ kind: "draw", batches: [{ texturing: "single", primitive: "triangles",
      vertices: [
        { position: { x: -1, y: -1, z: 0, w: 1 }, texCoord: { x: 0, y: 0 }, color: { x: 1, y: 0, z: 0, w: 1 } },
        { position: { x: 1, y: -1, z: 0, w: 1 }, texCoord: { x: 0, y: 0 }, color: { x: 1, y: 0, z: 0, w: 1 } },
        { position: { x: -1, y: 1, z: 0, w: 1 }, texCoord: { x: 0, y: 0 }, color: { x: 1, y: 0, z: 0, w: 1 } },
      ], indices: [0, 1, 2], texture: { kind: "bind-image", image: white }, state: OPAQUE_STATE,
    }] }] });
    commands.submit();
    const rgba = renderer.readPixels();
    for (const [x, y, expected] of [[4, 24, [255, 0, 0, 255]], [24, 4, [0, 0, 255, 255]]] satisfies readonly [number, number, readonly number[]][]) {
      if (!expected.every((value, channel) => rgba[(y * 32 + x) * 4 + channel] === value)) throw new Error(`GL triangle readback mismatch at ${x},${y}`);
    }
    window.swap();
    return `GL indexed triangle and top-down RGBA readback passed; ${renderer.driver.vendor}; ${renderer.driver.renderer}; ${renderer.driver.version}`;
  } finally { commands?.close("discard"); target?.close(); renderer?.close(); window.close(); }
}

export function runGlBenchmark(): string {
  const registered = new RegisteredRendererCvars(new CvarRegistry(), process.platform === "linux" ? "linux" : "other", null,
    text => { process.stderr.write(text); });
  const window = SdlWindow.open({ title: "Quake III GL benchmark", width: 320, height: 240, backend: "gl", hidden: true });
  let renderer: GlRenderer | null = null;
  let target: RenderTarget | null = null, commands: RenderCommandBuffer | null = null;
  try {
    const images = new RendererImageCatalog(); renderer = new GlRenderer(window, images); target = new RenderTarget(images, [renderer]);
    const settings = new SourceRendererSettings(registered, renderer.capabilities);
    renderer.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
      if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
    });
    const uploadProfile = diagnosticUploadProfile(renderer);
    commands = new RenderCommandBuffer(target, { print: (text: string) => { process.stderr.write(text); }, tess: new SourceTessState(), identityLight: uploadProfile.colorMappings.identityLight,
      clock: { milliseconds: () => Math.trunc(performance.now()) },
      runtime: { smpRequested: false, skipBackEnd: false, speeds: 0, clear: false, measureOverdraw: 0, showImages: 0, debugSort: 0, showTris: 0, showNormals: 0, primitives: 0, finish: 0, logFile: 0, lightmap: false, vertexLighting: false, polygonOffset: { factor: -1, units: -2 } } });
    const textures = Array.from({ length: 8 }, (_, texture) => {
      const pixels = new Uint8Array(256 * 256 * 4);
      for (let offset = 0; offset < pixels.length; offset += 4) {
        pixels[offset] = texture * 31;
        pixels[offset + 1] = 255 - texture * 31;
        pixels[offset + 2] = 83;
        pixels[offset + 3] = 255;
      }
      const name = `benchmark-${texture}`;
      const upload = prepareImageUpload({ width: 256, height: 256, pixels }, { name, mipmap: false, allowPicmip: false }, uploadProfile);
      return images.create({ ...upload, name, sourceWidth: 256, sourceHeight: 256, mipmap: false,
        sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 });
    });
    const batches: DrawBatch[] = Array.from({ length: 1020 }, (_, index) => {
      const texture = textures[index % textures.length];
      if (texture === undefined) throw new Error("Benchmark texture missing");
      const x = (index % 34) / 17 - 1;
      const y = Math.floor(index / 34) / 15 - 1;
      const color = { x: 1, y: 1, z: 1, w: 1 };
      return { texturing: "single", primitive: "triangles",
        vertices: [
          { position: { x, y, z: 0, w: 1 }, texCoord: { x: 0, y: 0 }, color },
          { position: { x: x + 1 / 17, y, z: 0, w: 1 }, texCoord: { x: 1, y: 0 }, color },
          { position: { x, y: y + 1 / 15, z: 0, w: 1 }, texCoord: { x: 0, y: 1 }, color },
        ], indices: [0, 1, 2], texture: { kind: "bind-image", image: texture }, state: OPAQUE_STATE,
      };
    });
    const samples: number[] = [];
    let checksum = 0;
    for (let frame = 0; frame < 17; frame++) {
      const started = performance.now();
      commands.addView({ viewport: { x: 0, y: 0, width: 320, height: 240 }, clear: { stencil: false, depth: 1, color: { x: 0, y: 0, z: 0, w: 1 } }, operations: [{ kind: "draw", batches }] });
      commands.submit();
      const pixels = renderer.readPixels();
      const elapsed = performance.now() - started;
      if (frame >= 5) samples.push(elapsed);
      checksum = 0;
      for (const value of pixels) checksum = (checksum + value) >>> 0;
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    if (median === undefined) throw new Error("Benchmark timing missing");
    return JSON.stringify({ driver: renderer.driver, width: 320, height: 240, batches: batches.length, textures: textures.length,
      warmupFrames: 5, measuredFrames: samples.length, medianMilliseconds: median, minimumMilliseconds: samples[0],
      maximumMilliseconds: samples.at(-1), readbackChecksum: checksum });
  } finally { commands?.close("discard"); target?.close(); renderer?.close(); window.close(); }
}

if (import.meta.main) process.stdout.write(`${process.argv[2] === "--benchmark" ? runGlBenchmark() : runGlSmoke()}\n`);
