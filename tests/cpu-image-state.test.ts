// R_CreateImage, GL_Bind and RE_UploadCinematic state, id Software renderer.
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { CvarRegistry } from "../src/core/cvar.ts";
import { CommonError } from "../src/core/common-error.ts";
import { HunkArena } from "../src/core/hunk.ts";
import type { Vec4 } from "../src/core/math.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog, RgbaSnapshot } from "../src/render/image-resource.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import { createImageColorMappings, imageUploadSteps } from "../src/render/image-upload.ts";
import type { ImageResourceOperation, ImageSource, RendererImage } from "../src/render/image-resource.ts";
import type { CinematicUpload } from "../src/render/cinematic-command.ts";
import type { DrawBatch, SingleTextureBatch, SourceStageData, TextureBinding, TextureSampling } from "../src/render/types.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { executeStaticBatch } from "./render-target-fixture.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";

const WHITE: Vec4 = { x: 1, y: 1, z: 1, w: 1 };
function fixture() {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(2, 2, images), session = images.openSession();
  session.attach(cpu); session.beginExecution();
  return { images, cpu, session };
}
function image(images: RendererImageCatalog, bytes: readonly number[], width = 1, height = 1,
  sampling: TextureSampling = { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 | 1 = 0,
  internalFormat: ImageSource["internalFormat"] = "rgba8"): RendererImage {
  return images.create({ name: "fixture", sourceWidth: width, sourceHeight: height,
    levels: [{ width, height, pixels: new Uint8Array(bytes) }], mipmap: false, internalFormat, sampling, registrationUnit });
}
function quad(texture: TextureBinding = { kind: "retain-current-texture" }, color: Vec4 = WHITE, u = .5, v = .5): SingleTextureBatch {
  return { texturing: "single", primitive: "triangles", texture,
    indices: [0,1,2,0,2,3], vertices: [{x:-1,y:1},{x:1,y:1},{x:1,y:-1},{x:-1,y:-1}].map(position => ({
      position: {...position,z:0,w:1}, color: {...color}, texCoord: {x:u,y:v} })),
    state: { blend: {source:"one",destination:"zero"}, depthTest:"always", depthWrite:false,alphaTest:"none",cull:"none" } };
}

test("source raw blend errors occur after single binding and before paired binding", () => {
  const { images, cpu, session } = fixture();
  try {
    const singleImage = image(images, [255, 0, 0, 255]), pairImage = image(images, [0, 255, 0, 255]);
    image(images, [0, 0, 0, 255]); images.beginFrame();
    const base = quad({ kind: "bind-image", image: singleImage });
    const single: SourceStageData = { kind: "generic-single", stateBits: 0x00000002, scratch: [],
      batch: { ...base, primitive: "triangles", vertices: [], indices: [],
        get state(): SingleTextureBatch["state"] { throw new Error("Source execution read diagnostic state"); } } };
    const prepared = cpu.prepareSourceGeometry(single);
    prepared.begin(); prepared.prepareTexture(0); prepared.applyTexture(0, { kind: "bind-image", image: singleImage });
    expect(singleImage.frameUsed).toBe(1);
    let failure: unknown;
    try { prepared.finishTextures(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CommonError);
    if (!(failure instanceof CommonError)) throw new Error("Expected source blend ERR_DROP");
    expect([failure.code, failure.message]).toEqual(["drop", "GL_State: invalid dst blend state bits\n"]);
    const pair: SourceStageData = { kind: "generic-pair", stateBits: 0x00000020, scratch: [],
      batch: { ...base, primitive: "triangles", texturing: "pair", vertices: [], indices: [],
        texture: { kind: "bind-image", image: pairImage },
        secondTexture: { binding: { kind: "bind-image", image: pairImage }, environment: "modulate" } } };
    const paired = cpu.prepareSourceGeometry(pair);
    expect(() => paired.begin()).toThrow("GL_State: invalid src blend state bits\n");
    expect(pairImage.frameUsed).toBe(0);
    expect([...cpu.pixels]).toEqual(new Array<number>(16).fill(0));
  } finally { session.close(); cpu.close(); }
});

test("source failed blend retains the preceding depth function and uncommitted raw cache", () => {
  const { images, cpu, session } = fixture();
  try {
    const white = image(images, [255, 255, 255, 255]); image(images, [0, 0, 0, 255]);
    cpu.beginView({ viewport: { x: 0, y: 0, width: 2, height: 2 },
      clear: { color: { x: 0, y: 0, z: 0, w: 0 }, depth: 1, stencil: false } });
    const draw = (stateBits: number, z: number, color: Vec4): void => {
      const base = quad({ kind: "bind-image", image: white }, color);
      const vertices = base.vertices.map(vertex => ({ ...vertex, position: { ...vertex.position, z } }));
      const stage: SourceStageData = { kind: "generic-single", stateBits,
        batch: { ...base, primitive: "triangles", vertices },
        scratch: vertices.map(vertex => ({ color: vertex.color, texCoord: vertex.texCoord, texCoord2: vertex.texCoord,
          rawTexCoord: vertex.texCoord, rawTexCoord2: vertex.texCoord })) };
      cpu.drawImmediate({ kind: "begin-generic-iterator", setArraysOnce: false, scratch: stage.scratch });
      const prepared = cpu.prepareSourceGeometry(stage);
      prepared.begin(); prepared.prepareTexture(0); prepared.applyTexture(0, { kind: "bind-image", image: white });
      prepared.finishTextures(); prepared.draw(2); prepared.cleanup();
    };
    draw(0x00000100, 0, WHITE);
    draw(0x00020100, 0, { x: 0, y: 0, z: 1, w: 1 });
    expect(pixel(cpu)).toEqual([0, 0, 255, 255]);
    draw(0x00000100, 0, WHITE);
    expect(() => draw(0x00020002, -.5, { x: 1, y: 0, z: 0, w: 1 })).toThrow("invalid dst blend");
    // Returning to the unchanged raw cache is a GL_State no-op. GL_EQUAL
    // therefore survives the failed blend decode and rejects this nearer quad.
    draw(0x00000100, -.5, { x: 1, y: 0, z: 0, w: 1 });
    expect(pixel(cpu)).toEqual([255, 255, 255, 255]);
    // The failure precedes glDepthMask(false), so the clear still writes depth.
    cpu.selectDrawBuffer("back", true);
    draw(0x00020100, 1, { x: 0, y: 1, z: 0, w: 1 });
    expect(pixel(cpu)).toEqual([0, 255, 0, 255]);
    // GL_ALWAYS is diagnostic state. The next source state must restore its
    // function even when its bits equal the last successful source call.
    const diagnostic = quad({ kind: "bind-image", image: white });
    executeStaticBatch(cpu, { ...diagnostic, state: { ...diagnostic.state, depthWrite: true },
      vertices: diagnostic.vertices.map(vertex => ({ ...vertex, position: { ...vertex.position, z: -1 } })) });
    draw(0x00020100, 0, { x: 0, y: 1, z: 0, w: 1 });
    expect(pixel(cpu)).toEqual([255, 255, 255, 255]);
    cpu.beginView({ viewport: { x: 0, y: 0, width: 2, height: 2 },
      clear: { color: { x: 0, y: 0, z: 0, w: 0 }, depth: 1, stencil: false } });
    draw(0x00010122, 0, { x: .5, y: 0, z: 0, w: .5 });
    expect(pixel(cpu)).toEqual([128, 0, 0, 128]);
    draw(0x00010100, 0, { x: 0, y: .5, z: 0, w: .5 });
    expect(pixel(cpu)).toEqual([0, 128, 0, 128]);
    draw(0x00020100, 1, WHITE);
    expect(pixel(cpu)).toEqual([255, 255, 255, 255]);
  } finally { session.close(); cpu.close(); }
});

test("source paired portal fill preserves raw line bits and follows the current view kind", () => {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(8, 8, images), session = images.openSession();
  session.attach(cpu); session.beginExecution();
  try {
    const white = image(images, [255, 255, 255, 255]); image(images, [0, 0, 0, 255]);
    const draw = (paired: boolean, color: Vec4): void => {
      const base = quad({ kind: "bind-image", image: white }, color);
      const scratch = base.vertices.map(vertex => ({ color: vertex.color, texCoord: vertex.texCoord, texCoord2: vertex.texCoord,
        rawTexCoord: vertex.texCoord, rawTexCoord2: vertex.texCoord }));
      const stage: SourceStageData = paired
        ? { kind: "generic-pair", stateBits: 0x00001100, scratch, batch: { ...base, primitive: "triangles", texturing: "pair",
          vertices: base.vertices.map(vertex => ({ ...vertex, texCoord2: vertex.texCoord })),
          secondTexture: { binding: { kind: "bind-image", image: white }, environment: "modulate" } } }
        : { kind: "generic-single", stateBits: 0x00001100, scratch, batch: { ...base, primitive: "triangles" } };
      cpu.drawImmediate({ kind: "begin-generic-iterator", setArraysOnce: false, scratch });
      const prepared = cpu.prepareSourceGeometry(stage);
      prepared.begin(); prepared.prepareTexture(0); prepared.applyTexture(0, { kind: "bind-image", image: white });
      if (paired) { prepared.prepareTexture(1); prepared.applyTexture(1, { kind: "bind-image", image: white }); }
      prepared.finishTextures(); prepared.draw(2); prepared.cleanup();
    };
    const view = { viewport: { x: 0, y: 0, width: 8, height: 8 },
      clear: { color: { x: 0, y: 0, z: 0, w: 0 }, depth: 1, stencil: false } };
    const interior = (): number[] => [...cpu.pixels.subarray(48, 52)];
    cpu.beginView(view); draw(true, WHITE);
    expect(interior()).toEqual([0, 0, 0, 0]);
    cpu.beginView({ ...view, clipPlane: { kind: "portal", eyePlane: { x: 0, y: 0, z: 0, w: 0 }, projection: [1, 1, -1, -2] } });
    draw(true, WHITE);
    expect(interior()).toEqual([255, 255, 255, 255]);
    draw(false, { x: 1, y: 0, z: 0, w: 1 });
    expect(interior()).toEqual([255, 0, 0, 255]);
    cpu.beginView({ ...view, clipPlane: { kind: "retain", projection: [1, 1, -1, -2] } });
    draw(true, WHITE);
    expect(interior()).toEqual([0, 0, 0, 0]);
  } finally { session.close(); cpu.close(); }
});

function pixel(cpu: SoftwareRenderer): number[] { return [...cpu.pixels.subarray(0,4)]; }
function upload(image: RendererImage, width: number, height: number, rgba: readonly number[], dirty = true): CinematicUpload {
  return { image, sourceWidth: width, sourceHeight: height, uploadWidth: width, uploadHeight: height,
    content: new RgbaSnapshot(width,height,new Uint8Array(rgba)), dirty };
}
function apply(cpu: SoftwareRenderer, data: CinematicUpload): void {
  const prepared = cpu.prepareGeometry(quad()); prepared.begin();
  prepared.applyTexture(0,{kind:"cinematic-upload",upload:data}); prepared.draw(); prepared.cleanup();
}

function noBindFixture() {
  const cvars = new CvarRegistry();
  const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
  const images = new RendererImageCatalog();
  images.setBindingSettings(settings);
  const cpu = new SoftwareRenderer(2, 2, images), target = new RenderTarget(images, [cpu]);
  return { cvars, images, cpu, target };
}

test("sky side strips retain identity color for their pixels and subsequent show-images", () => {
  const { images, cpu, session } = fixture();
  try {
    const sky = image(images, [200, 0, 0, 255, 0, 200, 0, 255, 0, 0, 200, 255, 200, 200, 200, 255], 2, 2);
    const shown = image(images, [200, 100, 50, 255]);
    image(images, [0, 0, 0, 255]);
    const strip = [{ x: -1, y: 1 }, { x: -1, y: -1 }, { x: 1, y: 1 }, { x: 1, y: -1 }].map(position => ({
      position: { ...position, z: 0, w: 1 }, texCoord: { x: (position.x + 1) / 2, y: (1 - position.y) / 2 },
    }));
    cpu.drawImmediate({ kind: "sky-box-state", identityLight: .5 });
    cpu.drawImmediate({ kind: "sky-side", image: sky, strips: [strip] });
    expect([...cpu.pixels]).toEqual([100, 0, 0, 255, 0, 100, 0, 255, 0, 0, 100, 255, 100, 100, 100, 255]);
    cpu.drawShowImage(shown, { x: 0, y: 0, width: 2, height: 2 }, false);
    expect([...cpu.pixels]).toEqual(Array.from({ length: 4 }, () => [100, 50, 25, 255]).flat());
    const probe = quad({ kind: "bind-image", image: shown }, { x: 0, y: 1, z: 0, w: 1 });
    const far: SingleTextureBatch = { ...probe,
      vertices: probe.vertices.map(vertex => ({ ...vertex, position: { ...vertex.position, z: 1 } })),
      state: { ...probe.state, depthTest: "equal", depthRange: [0, 1] } };
    executeStaticBatch(cpu, far);
    expect([...cpu.pixels]).toEqual(Array.from({ length: 4 }, () => [0, 100, 0, 255]).flat());
  } finally { session.close(); cpu.close(); }
});

test("empty sky sides still apply r_nobind and two-vertex rows retain UV0 without drawing", () => {
  const { cvars, images, cpu, target } = noBindFixture();
  try {
    const dlight = image(images, [255, 0, 0, 255, 0, 0, 255, 255], 2, 1);
    const requested = image(images, [0, 255, 0, 255]);
    image(images, [255, 255, 255, 255]);
    images.setDlightImage(dlight); cvars.set("r_nobind", "1"); images.beginFrame();
    cpu.drawImmediate({ kind: "sky-side", image: requested, strips: [] });
    expect([requested.frameUsed, dlight.frameUsed]).toEqual([1, 0]);
    cpu.drawImmediate({ kind: "sky-side", image: requested, strips: [[
      { position: { x: -1, y: 1, z: 0, w: 1 }, texCoord: { x: .25, y: .5 } },
      { position: { x: -1, y: -1, z: 0, w: 1 }, texCoord: { x: .75, y: .5 } },
    ]] });
    expect([...cpu.pixels]).toEqual(new Array<number>(16).fill(0));
    const start = { x: -1, y: 1, z: 0, w: 1 }, end = { x: 1, y: -1, z: 0, w: 1 };
    cpu.drawImmediate({ kind: "entity-axis", whiteImage: requested, positions: [start, end, start, end, start, end] });
    expect(pixel(cpu)).toEqual([0, 0, 255, 255]);
  } finally { target.close(); }
});

test("sky side binds on retained unit1 while supplying UV0 and retaining secondary coordinates", () => {
  const { images, cpu, session } = fixture();
  try {
    const primary = image(images, [128, 255, 64, 255, 64, 128, 255, 255], 2, 1);
    const sky = image(images, [200, 100, 50, 255, 40, 60, 80, 255], 2, 1);
    const other = image(images, [255, 255, 255, 255]);
    image(images, [0, 0, 0, 255]);
    const base = quad({ kind: "bind-image", image: primary });
    const prepared = cpu.prepareGeometry({ ...base, texturing: "pair",
      vertices: base.vertices.map(vertex => ({ ...vertex, texCoord2: { x: .5, y: .5 } })),
      secondTexture: { binding: { kind: "bind-image", image: other }, environment: "modulate" } });
    prepared.begin(); prepared.applyTexture(0, { kind: "bind-image", image: primary });
    prepared.applyTexture(1, { kind: "bind-image", image: other });
    const strip = [{ x: -1, y: 1 }, { x: -1, y: -1 }, { x: 1, y: 1 }, { x: 1, y: -1 }].map(position => ({
      position: { ...position, z: 0, w: 1 }, texCoord: { x: (position.x + 1) / 2, y: .5 },
    }));
    cpu.drawImmediate({ kind: "sky-box-state", identityLight: .5 });
    cpu.drawImmediate({ kind: "sky-side", image: sky, strips: [strip] });
    expect([...cpu.pixels]).toEqual([50, 50, 6, 255, 25, 25, 25, 255, 50, 50, 6, 255, 25, 25, 25, 255]);
    cpu.drawImmediate({ kind: "sky-side", image: primary, strips: [] });
    prepared.draw(); prepared.cleanup();
    expect(pixel(cpu)).toEqual([16, 64, 255, 255]);
  } finally { session.close(); cpu.close(); }
});

test("image usage follows changed binds across frames while cached raw-zero and retain remain unmarked", () => {
  const { images, cpu, session } = fixture();
  try {
    const first = image(images, [255, 0, 0, 255]), cached = image(images, [0, 255, 0, 255]);
    expect(images.frameCount).toBe(0); expect(images.sumOfUsedImages()).toBe(2);
    images.beginFrame();
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: cached }));
    expect(pixel(cpu)).toEqual([255, 255, 255, 255]);
    expect(cached.frameUsed).toBe(0); expect(images.sumOfUsedImages()).toBe(0);
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: first }));
    expect(first.frameUsed).toBe(1); expect(images.sumOfUsedImages()).toBe(1);
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: cached }));
    expect(images.sumOfUsedImages()).toBe(2);
    images.beginFrame();
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: cached }));
    executeStaticBatch(cpu, quad());
    expect(pixel(cpu)).toEqual([0, 255, 0, 255]);
    expect(cached.frameUsed).toBe(1); expect(images.sumOfUsedImages()).toBe(0);
    const created = image(images, [0, 0, 255, 255]);
    expect(created.frameUsed).toBe(2); expect(images.sumOfUsedImages()).toBe(1);
  } finally { session.close(); cpu.close(); }
});

test("overdraw counts alpha-surviving failed depth for triangles and lines, retains state, and reads source-packed rows", () => {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(4, 2, images, 8, 8), session = images.openSession();
  session.attach(cpu); session.beginExecution();
  try {
    cpu.setOverdrawMeasurement(true);
    cpu.beginView({ viewport: { x: 0, y: 0, width: 4, height: 2 }, clear: { depth: .25, color: { x: 0, y: 0, z: 0, w: 1 }, stencil: true } });
    const base = quad(), failed: SingleTextureBatch = { ...base, state: { ...base.state, depthTest: "less-equal" } };
    executeStaticBatch(cpu, failed);
    executeStaticBatch(cpu, { ...failed, state: { ...failed.state, alphaTest: "gt0" },
      vertices: failed.vertices.map(vertex => ({ ...vertex, color: { ...vertex.color, w: 0 } })) });
    expect(pixel(cpu)).toEqual([0, 0, 0, 255]);
    executeStaticBatch(cpu, { ...base, vertices: base.vertices.map(vertex => ({ ...vertex,
      position: { ...vertex.position, y: (vertex.position.y + 1) / 2 } })) });
    const readback = new Uint8Array(8);
    cpu.readStencilOverdraw(readback); expect([...readback]).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    const line: DrawBatch = { texturing: "single", primitive: "lines", lineWidth: 1, texture: base.texture, state: failed.state, indices: [0, 1],
      vertices: [-1, 1].map(x => ({ position: { x, y: -.5, z: 0, w: 1 }, color: WHITE, texCoord: { x: 0, y: 0 } })) };
    executeStaticBatch(cpu, line);
    executeStaticBatch(cpu, { ...line, state: { ...line.state, alphaTest: "gt0" },
      vertices: line.vertices.map(vertex => ({ ...vertex, color: { ...vertex.color, w: 0 } })) });
    cpu.setOverdrawMeasurement(false); executeStaticBatch(cpu, base);
    cpu.setOverdrawMeasurement(true);
    // The half-open line excludes its terminal pixel diamond.
    cpu.readStencilOverdraw(readback); expect([...readback]).toEqual([2, 2, 2, 1, 2, 2, 2, 2]);
    for (let index = 0; index < 260; index++) executeStaticBatch(cpu, base);
    cpu.readStencilOverdraw(readback); expect([...readback]).toEqual(new Array<number>(8).fill(255));
    cpu.beginView({ viewport: { x: 0, y: 0, width: 4, height: 1 }, clear: { depth: 1, color: null, stencil: true } });
    cpu.readStencilOverdraw(readback); expect([...readback]).toEqual([255, 255, 255, 255, 0, 0, 0, 0]);
  } finally { session.close(); cpu.close(); }
  const odd = new SoftwareRenderer(3, 2, new RendererImageCatalog(), 8, 8);
  try {
    odd.beginView({ viewport: { x: 0, y: 0, width: 3, height: 2 }, clear: { depth: 1, color: null, stencil: true } });
    const tight = new Uint8Array(6).fill(77);
    expect(() => odd.readStencilOverdraw(tight)).toThrow("PACK_ALIGNMENT=4"); expect([...tight]).toEqual(new Array<number>(6).fill(77));
    const padded = new Uint8Array(7).fill(77);
    odd.readStencilOverdraw(padded); expect([...padded]).toEqual([0, 0, 0, 77, 0, 0, 0]);
  } finally { odd.close(); }
});

test("paired r_nobind usage marks requested images in reached unit order and suppresses cached marks", () => {
  const { images, cpu, session } = fixture();
  try {
    const first = image(images, [255, 0, 0, 255]), second = image(images, [0, 255, 0, 255]);
    const dlight = image(images, [128, 128, 128, 255]);
    image(images, [0, 0, 0, 255]); images.setDlightImage(dlight);
    const seen: number[][] = [];
    images.setBindingSettings({ get noBind(): boolean { seen.push([first.frameUsed, second.frameUsed]); return true; } });
    const base = quad({ kind: "bind-image", image: first });
    const pair: DrawBatch = { ...base, texturing: "pair",
      vertices: base.vertices.map(vertex => ({ ...vertex, texCoord2: { x: .5, y: .5 } })),
      secondTexture: { binding: { kind: "bind-image", image: second }, environment: "modulate" } };
    images.beginFrame(); executeStaticBatch(cpu, pair);
    expect(seen).toEqual([[0, 0], [1, 0]]);
    expect([first.frameUsed, second.frameUsed, dlight.frameUsed]).toEqual([1, 1, 0]);
    expect(images.sumOfUsedImages()).toBe(2);
    images.beginFrame(); executeStaticBatch(cpu, pair);
    expect(images.sumOfUsedImages()).toBe(0);
    expect([first.frameUsed, second.frameUsed, dlight.frameUsed]).toEqual([1, 1, 0]);
  } finally { session.close(); cpu.close(); }
});

test("R_CreateImage binds before preparation and completes without resampling r_nobind", () => {
  const { images, cpu, session } = fixture();
  try {
    const dlight = image(images, [0, 255, 0, 255]); images.setDlightImage(dlight);
    let noBind = false, reads = 0;
    images.setBindingSettings({ get noBind(): boolean { reads++; return noBind; } });
    images.beginFrame();
    const created = images.createUploaded({ name: "bound-before-upload", sourceWidth: 1, sourceHeight: 1,
      mipmap: false, allowPicmip: false, sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 1 }, () => {
      const pending = images.registeredImages().at(-1);
      if (pending === undefined) throw new Error("Missing allocated image");
      expect(pending.frameUsed).toBe(1); expect(pending.uploadWidth).toBe(0);
      expect(reads).toBe(1); noBind = true;
      return imageUploadSteps({ width: 1, height: 1, pixels: new Uint8Array([255, 0, 0, 255]) },
        { name: "bound-before-upload", mipmap: false, allowPicmip: false }, identityImageUploadProfile());
    });
    expect(reads).toBe(1); expect(created.frameUsed).toBe(1); expect(images.sumOfUsedImages()).toBe(1);
    noBind = false;
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: dlight }));
    expect(pixel(cpu)).toEqual([255, 255, 255, 255]);
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: created }));
    expect(pixel(cpu)).toEqual([255, 0, 0, 255]);
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: dlight }));
    expect(pixel(cpu)).toEqual([0, 255, 0, 255]);
  } finally { session.close(); cpu.close(); }
});

test("failed source-hunk preparation retains the real bind, frame slot and replay prefix", () => {
  const arena = new HunkArena(1024, () => {}), backing = arena.allocate(4, "low").bytes.buffer;
  const accounting = new SourceHunkAccounting(arena), images = new RendererImageCatalog("linear-mipmap-nearest", { kind: "source-hunk", accounting });
  const cpu = new SoftwareRenderer(2, 2, images), session = images.openSession(); session.attach(cpu); session.beginExecution();
  const profile = { picmip: 0, roundImagesDown: false, simpleMipMaps: true, colorMipLevels: false,
    textureBits: 0, textureCompression: "none", maxTextureSize: null,
    colorMappings: createImageColorMappings({ gamma: 1, intensity: 1, requestedOverbrightBits: 0,
      deviceSupportsGamma: false, isFullscreen: false, colorBits: 24 }) } satisfies Parameters<typeof imageUploadSteps>[2];
  const descriptor = { name: "complete", sourceWidth: 1, sourceHeight: 1, mipmap: false, allowPicmip: false,
    sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 } satisfies Parameters<RendererImageCatalog["createUploaded"]>[0];
  try {
    const complete = images.createUploaded(descriptor, () => imageUploadSteps({ width: 1, height: 1, pixels: new Uint8Array([255, 0, 0, 255]) },
      { name: descriptor.name, mipmap: false, allowPicmip: false }, profile, images.hunk));
    images.beginFrame();
    const failure = new Error("Upload32 preparation stopped");
    expect(() => images.createUploaded({ ...descriptor, name: "partial" }, () => { throw failure; })).toThrow(failure);
    const partial = images.registeredImages().at(-1), allocation = accounting.report().trace.at(-1);
    if (partial === undefined || allocation === undefined) throw new Error("Missing retained source image allocation");
    const record = new DataView(backing, allocation.offset, allocation.bytes);
    expect([record.getInt32(72, true), record.getInt32(76, true), record.getInt32(84, true)]).toEqual([0, 0, 1]);
    expect(partial.frameUsed).toBe(1); expect(complete.frameUsed).toBe(0);
    expect(images.sumOfUsedImages()).toBe(0);
    executeStaticBatch(cpu, quad()); expect(pixel(cpu)).toEqual([255, 255, 255, 255]);
    record.setInt32(72, 0x7fffffff, true); record.setInt32(76, 2, true);
    expect(images.sumOfUsedImages()).toBe(-2);
    record.setInt32(84, 0, true); expect(images.sumOfUsedImages()).toBe(0);
    record.setInt32(72, 0, true); record.setInt32(76, 0, true); record.setInt32(84, 1, true);
    session.close(); cpu.close();
    const beforeReplay = accounting.report().trace.length, replay = images.openSession(), nextCpu = new SoftwareRenderer(2, 2, images);
    try {
      replay.attach(nextCpu); replay.beginExecution();
      executeStaticBatch(nextCpu, quad()); expect(pixel(nextCpu)).toEqual([255, 255, 255, 255]);
      expect(images.frameCount).toBe(1); expect(accounting.report().trace.length).toBe(beforeReplay);
      expect(new RendererImageCatalog().frameCount).toBe(0);
    } finally { replay.close(); nextCpu.close(); }
  } finally { session.close(); cpu.close(); }
});

test("weighted mip exhaustion follows the real base upload and retains its bound object through replay", () => {
  for (const noBind of [false, true]) {
    const arena = new HunkArena(352, () => {}), backing = arena.allocateTemp(8).bytes.buffer;
    const accounting = new SourceHunkAccounting(arena), images = new RendererImageCatalog("linear-mipmap-nearest", { kind: "source-hunk", accounting });
    const cpu = new SoftwareRenderer(2, 2, images), session = images.openSession(), operations: ImageResourceOperation[] = [];
    session.attach(cpu); session.attach({ images, applyImageResource(operation): undefined { operations.push(operation); } }); session.beginExecution();
    const profile = { ...identityImageUploadProfile(), simpleMipMaps: false };
    const descriptor = { name: "dlight", sourceWidth: 1, sourceHeight: 1, mipmap: false, allowPicmip: false,
      sampling: { wrap: "clamp", filter: "linear" }, registrationUnit: 1 } satisfies Parameters<RendererImageCatalog["createUploaded"]>[0];
    try {
      const dlight = images.createUploaded(descriptor, () => imageUploadSteps({ width: 1, height: 1, pixels: new Uint8Array([0, 255, 0, 255]) }, descriptor, profile, images.hunk));
      images.setDlightImage(dlight); images.setBindingSettings({ noBind }); images.beginFrame();
      const request = { ...descriptor, name: "partial-mips", sourceWidth: 4, sourceHeight: 4, mipmap: true, registrationUnit: 0 } satisfies Parameters<RendererImageCatalog["createUploaded"]>[0];
      const pixels = new Uint8Array(Array.from({ length: 16 }, () => [200, 0, 0, 255]).flat());
      const before = operations.length;
      expect(() => images.createUploaded(request, () => imageUploadSteps({ width: 4, height: 4, pixels }, request, profile, images.hunk))).toThrow("Hunk_AllocateTempMemory: failed on 24");
      const partial = images.registeredImages().at(-1), allocation = accounting.report().trace.at(-2);
      if (partial === undefined || allocation === undefined) throw new Error("Missing partially uploaded source image");
      expect(operations.slice(before).map(operation => operation.kind)).toEqual(["begin-image", "set-image-upload-descriptor", "upload-image-level"]);
      expect(allocation.source).toBe("R_CreateImage");
      const record = new DataView(backing, allocation.offset, allocation.bytes);
      expect([record.getInt32(72, true), record.getInt32(76, true), record.getInt32(84, true), record.getInt32(88, true)]).toEqual([4, 4, 1, 0x8051]);
      expect(images.sumOfUsedImages()).toBe(16); expect(dlight.frameUsed).toBe(0); expect(arena.memoryRemaining()).toBe(8);
      executeStaticBatch(cpu, quad());
      expect(pixel(cpu)).toEqual(noBind ? [200, 0, 0, 255] : [255, 255, 255, 255]);
      if (!noBind) {
        images.setTextureMode("GL_LINEAR");
        executeStaticBatch(cpu, quad()); expect(pixel(cpu)).toEqual([200, 0, 0, 255]);
      }
      session.close(); cpu.close();
      const traceLength = accounting.report().trace.length, replay = images.openSession(), nextCpu = new SoftwareRenderer(2, 2, images);
      try {
        replay.attach(nextCpu); replay.beginExecution();
        executeStaticBatch(nextCpu, quad()); expect(pixel(nextCpu)).toEqual([200, 0, 0, 255]);
        expect(accounting.report().trace.length).toBe(traceLength); expect(arena.memoryRemaining()).toBe(8);
        expect([partial.uploadWidth, partial.uploadHeight]).toEqual([4, 4]);
      } finally { replay.close(); nextCpu.close(); }
    } finally { session.close(); cpu.close(); }
  }
});

test("a complete chain stopped before Upload32 filtering retains the new object's linear magnification", () => {
  const { images, cpu, session } = fixture();
  const failure = new Error("stopped before filter");
  const descriptor = { name: "unchecked", sourceWidth: 2, sourceHeight: 1, mipmap: true, allowPicmip: false,
    sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 } satisfies Parameters<RendererImageCatalog["createUploaded"]>[0];
  try {
    expect(() => images.createUploaded(descriptor, function* () {
      for (const step of imageUploadSteps({ width: 2, height: 1, pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]) }, descriptor, identityImageUploadProfile())) {
        if (step.kind === "finish-upload") throw failure;
        yield step;
      }
      return undefined;
    })).toThrow(failure);
    executeStaticBatch(cpu, quad()); expect(pixel(cpu)).toEqual([128, 128, 0, 255]);
    images.setTextureMode("GL_NEAREST");
    executeStaticBatch(cpu, quad()); expect(pixel(cpu)).toEqual([0, 255, 0, 255]);
  } finally { session.close(); cpu.close(); }
});

test("r_nobind waits for the dlight marker and samples the live cvar at each bind", () => {
  const { cvars, images, cpu, target } = noBindFixture();
  try {
    const requested = image(images, [255, 0, 0, 255]), dlight = image(images, [0, 255, 0, 255]);
    image(images, [0, 0, 255, 255]);
    cvars.set("r_nobind", "1");
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: requested }));
    expect(pixel(cpu)).toEqual([255, 0, 0, 255]);
    images.setDlightImage(dlight);
    executeStaticBatch(cpu, quad());
    expect(pixel(cpu)).toEqual([255, 0, 0, 255]);
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: requested }));
    expect(pixel(cpu)).toEqual([0, 255, 0, 255]);
    const prepared = cpu.prepareGeometry(quad({ kind: "bind-image", image: requested }));
    cvars.set("r_nobind", "0");
    executeStaticBatch(cpu, quad());
    expect(pixel(cpu)).toEqual([0, 255, 0, 255]);
    prepared.begin(); prepared.applyTexture(0, { kind: "bind-image", image: requested }); prepared.draw(); prepared.cleanup();
    expect(pixel(cpu)).toEqual([255, 0, 0, 255]);
    cvars.set("r_nobind", "-2");
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: requested }));
    expect(pixel(cpu)).toEqual([0, 255, 0, 255]);
  } finally { target.close(); }
});

test("r_nobind selects the dlight object independently on both texture units", () => {
  const { cvars, images, cpu, target } = noBindFixture();
  try {
    const first = image(images, [255, 0, 0, 255]);
    const second = image(images, [0, 255, 0, 255], 1, 1, { wrap: "repeat", filter: "nearest" }, 1);
    const dlight = image(images, [128, 64, 32, 128]);
    image(images, [0, 0, 0, 255]);
    images.setDlightImage(dlight);
    const base = quad({ kind: "bind-image", image: first });
    const pair: DrawBatch = { ...base, texturing: "pair",
      vertices: base.vertices.map(vertex => ({ ...vertex, texCoord2: { x: .5, y: .5 } })),
      secondTexture: { binding: { kind: "bind-image", image: second }, environment: "modulate" } };
    cvars.set("r_nobind", "1");
    executeStaticBatch(cpu, pair);
    expect(pixel(cpu)).toEqual([64, 16, 4, 64]);
    cvars.set("r_nobind", "0");
    executeStaticBatch(cpu, pair);
    expect(pixel(cpu)).toEqual([0, 0, 0, 255]);
  } finally { target.close(); }
});

test("r_nobind marker replay preserves creations that preceded the source dlight assignment", () => {
  const cvars = new CvarRegistry();
  const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
  const images = new RendererImageCatalog();
  images.setBindingSettings(settings);
  cvars.set("r_nobind", "1");
  const before = image(images, [255, 0, 0, 255]), dlight = image(images, [0, 255, 0, 255]);
  images.setDlightImage(dlight);
  const after = image(images, [0, 0, 255, 255]);
  const cpu = new SoftwareRenderer(2, 2, images), target = new RenderTarget(images, [cpu]);
  try {
    executeStaticBatch(cpu, quad());
    expect(pixel(cpu)).toEqual([0, 0, 255, 255]);
    cvars.set("r_nobind", "0");
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: before }));
    expect(pixel(cpu)).toEqual([255, 0, 0, 255]);
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: dlight }));
    expect(pixel(cpu)).toEqual([0, 255, 0, 255]);
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: after }, { x: .25, y: .5, z: .75, w: .5 }));
    expect(pixel(cpu)).toEqual([64, 128, 191, 128]);
  } finally { target.close(); }
});

test("dlight marker validation requires a replayed image from the backend's catalog", () => {
  const { images, cpu, target } = noBindFixture(), foreign = noBindFixture();
  try {
    const owned = image(images, [255, 0, 0, 255]), other = image(foreign.images, [0, 255, 0, 255]);
    const unreplayed = new SoftwareRenderer(2, 2, images);
    expect(() => unreplayed.applyImageResource({ kind: "dlight-image", image: owned })).toThrow("replayed");
    expect(() => cpu.applyImageResource({ kind: "dlight-image", image: other })).toThrow("another catalog");
    unreplayed.close();
  } finally { target.close(); foreign.target.close(); }
});

test("redirected creation writes the selected object then cached raw zero, leaving requested objects incomplete", () => {
  const { cvars, images, cpu, target } = noBindFixture();
  try {
    const dlight = image(images, [0, 255, 0, 255]);
    image(images, [255, 255, 255, 255]);
    images.setDlightImage(dlight);
    cvars.set("r_nobind", "1");
    const first = image(images, [192, 128, 64, 255]);
    const second = image(images, [0, 0, 255, 64]);
    executeStaticBatch(cpu, quad());
    expect(pixel(cpu)).toEqual([0, 0, 255, 64]);
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: first }));
    expect(pixel(cpu)).toEqual([0, 0, 255, 64]);
    cvars.set("r_nobind", "0");
    const color = { x: .25, y: .5, z: .75, w: .5 };
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: first }, color));
    expect(pixel(cpu)).toEqual([64, 128, 191, 128]);
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: dlight }));
    expect(pixel(cpu)).toEqual([192, 128, 64, 255]);
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: second }, color));
    expect(pixel(cpu)).toEqual([64, 128, 191, 128]);
  } finally { target.close(); }
});

test("redirected unit1 creation restores unit0 before the next current-object operation", () => {
  const { cvars, images, cpu, target } = noBindFixture();
  try {
    const dlight = image(images, [128, 128, 128, 255]);
    const first = image(images, [255, 0, 0, 255], 1, 1, { wrap: "clamp", filter: "linear" });
    image(images, [255, 255, 255, 255]);
    images.setDlightImage(dlight);
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: first }));
    cvars.set("r_nobind", "1");
    const redirected = image(images, [0, 0, 255, 128], 1, 1, { wrap: "repeat", filter: "nearest" }, 1);
    images.setCurrentBorderColor(WHITE);
    cvars.set("r_nobind", "0");
    executeStaticBatch(cpu, quad(undefined, WHITE, 0, 0));
    expect(pixel(cpu)).toEqual([255, 191, 191, 255]);
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: dlight }));
    expect(pixel(cpu)).toEqual([0, 0, 255, 128]);
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: redirected }, { x: .25, y: .5, z: .75, w: .5 }));
    expect(pixel(cpu)).toEqual([64, 128, 191, 128]);
  } finally { target.close(); }
});

test("redirected creation preserves unsupplied mip levels and the selected object's border", () => {
  const { cvars, images, cpu, target } = noBindFixture();
  try {
    const dlight = image(images, [128, 128, 128, 255]);
    const other = image(images, [255, 255, 255, 255]);
    images.setDlightImage(dlight);
    cvars.set("r_nobind", "1");
    const mip = images.create({ name: "redirected-mip", sourceWidth: 4, sourceHeight: 4, mipmap: true,
      internalFormat: "rgb8", sampling: { wrap: "repeat", filter: "nearest-mipmap-nearest" }, registrationUnit: 0,
      levels: [
        { width: 4, height: 4, pixels: new Uint8Array(Array.from({ length: 16 }, () => [255, 0, 0, 255]).flat()) },
        { width: 2, height: 2, pixels: new Uint8Array(Array.from({ length: 4 }, () => [0, 255, 0, 255]).flat()) },
        { width: 1, height: 1, pixels: new Uint8Array([0, 0, 255, 255]) },
      ] });
    cvars.set("r_nobind", "0");
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: other }));
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: dlight }));
    images.setCurrentBorderColor(WHITE);
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: other }));
    cvars.set("r_nobind", "1");
    image(images, new Array<number>(64).fill(0), 4, 4, { wrap: "clamp", filter: "linear" }, 0, "rgb8");
    cvars.set("r_nobind", "0");
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: other }));
    cvars.set("r_nobind", "1");
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: other }));
    images.setTextureMode("GL_NEAREST_MIPMAP_NEAREST");
    for (const [factor, expected] of [[.5, [0, 255, 0, 255]], [1, [0, 0, 255, 255]]] satisfies readonly [number, readonly number[]][]) {
      const base = quad();
      executeStaticBatch(cpu, { ...base, vertices: base.vertices.map(vertex => ({ ...vertex,
        texCoord: { x: (vertex.position.x + 1) * factor, y: .5 } })) });
      expect(pixel(cpu)).toEqual(expected);
    }
    images.setTextureMode("GL_LINEAR");
    executeStaticBatch(cpu, quad(undefined, WHITE, 0, 0));
    expect(pixel(cpu)).toEqual([191, 191, 191, 255]);
    cvars.set("r_nobind", "0");
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: mip }, { x: .25, y: .5, z: .75, w: .5 }));
    expect(pixel(cpu)).toEqual([64, 128, 191, 128]);
  } finally { target.close(); }
});

test("redirected cinematic resize keeps requested scratch dimensions separate from selected storage", () => {
  const { cvars, images, cpu, target } = noBindFixture();
  try {
    const scratch = image(images, [200, 0, 0, 20]);
    const dlight = image(images, Array.from({ length: 4 }, () => [0, 0, 255, 255]).flat(), 2, 2);
    image(images, [255, 255, 255, 255]);
    images.setDlightImage(dlight);
    cvars.set("r_nobind", "1");
    images.beginFrame();
    apply(cpu, upload(scratch, 2, 2, Array.from({ length: 4 }, () => [0, 200, 0, 0]).flat(), false));
    expect(pixel(cpu)).toEqual([0, 200, 0, 255]);
    expect([scratch.frameUsed, dlight.frameUsed, scratch.uploadWidth, scratch.uploadHeight]).toEqual([1, 0, 2, 2]);
    expect(images.sumOfUsedImages()).toBe(4);
    const listing: string[] = []; images.listImages(text => { listing.push(text); });
    expect(listing.join("")).toContain("   0:    2    2  no    0   RGBA8rept  fixture\n");
    images.beginFrame();
    apply(cpu, upload(scratch, 2, 2, Array.from({ length: 4 }, () => [255, 0, 0, 0]).flat(), false));
    expect(pixel(cpu)).toEqual([0, 200, 0, 255]);
    expect(images.sumOfUsedImages()).toBe(0);
    cvars.set("r_nobind", "0");
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: scratch }));
    expect(pixel(cpu)).toEqual([200, 0, 0, 20]);
    apply(cpu, upload(scratch, 2, 2, Array.from({ length: 4 }, () => [0, 255, 0, 0]).flat()));
    expect(pixel(cpu)).toEqual([200, 0, 0, 20]);
    apply(cpu, upload(scratch, 1, 1, [200, 200, 0, 0], false));
    expect(pixel(cpu)).toEqual([200, 200, 0, 255]);
    expect([scratch.uploadWidth, scratch.uploadHeight, images.sumOfUsedImages()]).toEqual([1, 1, 1]);
  } finally { target.close(); }
});

test("queued shader uploads update the one dlight object bound by both texture slots", () => {
  const { cvars, images, cpu, target } = noBindFixture();
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
    tess: new SourceTessState(), runtime: createRendererSettings().runtime });
  try {
    const requested = image(images, [255, 0, 0, 255]), scratch = image(images, [0, 255, 0, 255]);
    const dlight = image(images, [255, 255, 255, 255]);
    image(images, [0, 0, 0, 255]);
    images.setDlightImage(dlight);
    cvars.set("r_nobind", "1");
    let preparations = 0, completions = 0;
    const base = quad({ kind: "bind-image", image: requested });
    const pair: DrawBatch = { ...base, texturing: "pair",
      vertices: base.vertices.map(vertex => ({ ...vertex, texCoord2: { x: .5, y: .5 } })),
      secondTexture: { environment: "modulate", binding: { kind: "shader-cinematic", source: {
        image: scratch, prepareAtExecution() {
          preparations++;
          return { upload: upload(scratch, 1, 1, [128, 64, 32, 128]), afterShaderUpload() { completions++; } };
        },
      } } } };
    commands.addView({ viewport: { x: 0, y: 0, width: 2, height: 2 },
      clear: { stencil: false, color: { x: 0, y: 0, z: 0, w: 0 }, depth: 1 }, operations: [{ kind: "draw", batches: [pair] }] });
    expect(preparations).toBe(0);
    commands.submit();
    expect(preparations).toBe(1);
    expect(completions).toBe(1);
    expect(pixel(cpu)).toEqual([64, 16, 4, 64]);
  } finally { commands.close("discard"); target.close(); }
});

test("r_nobind texture-mode changes target the actual object on the retained active unit", () => {
  const { cvars, images, cpu, target } = noBindFixture();
  try {
    const dlight = image(images, [255, 0, 0, 255, 0, 0, 255, 255], 2, 1);
    const requested = images.create({ name: "mode-requested", sourceWidth: 2, sourceHeight: 1, mipmap: true,
      internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest-mipmap-nearest" }, registrationUnit: 0,
      levels: [{ width: 2, height: 1, pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]) },
        { width: 1, height: 1, pixels: new Uint8Array([0, 0, 0, 255]) }] });
    const other = image(images, [255, 255, 255, 255], 1, 1, { wrap: "repeat", filter: "nearest" }, 1);
    images.setDlightImage(dlight);
    cvars.set("r_nobind", "1");
    const base = quad({ kind: "bind-image", image: requested });
    const pair: DrawBatch = { ...base, texturing: "pair",
      vertices: base.vertices.map(vertex => ({ ...vertex, texCoord2: { x: .5, y: .5 } })),
      secondTexture: { binding: { kind: "bind-image", image: other }, environment: "modulate" } };
    const prepared = cpu.prepareGeometry(pair);
    prepared.begin(); prepared.applyTexture(0, { kind: "bind-image", image: requested });
    prepared.applyTexture(1, { kind: "bind-image", image: other });
    images.setTextureMode("GL_LINEAR");
    prepared.draw(); prepared.cleanup();
    expect(pixel(cpu)).toEqual([64, 0, 64, 255]);
    cvars.set("r_nobind", "0");
    executeStaticBatch(cpu, quad({ kind: "bind-image", image: requested }));
    expect(pixel(cpu)).toEqual([0, 255, 0, 255]);
  } finally { target.close(); }
});

test("r_nobind applies to immediate source binds without requiring a prepared texture slot", () => {
  const { cvars, images, cpu, target } = noBindFixture();
  try {
    const requested = image(images, [255, 255, 255, 255]), dlight = image(images, [128, 128, 128, 255]);
    image(images, [0, 0, 0, 255]);
    images.setDlightImage(dlight);
    cvars.set("r_nobind", "1");
    cpu.drawImmediate({ kind: "entity-beam", whiteImage: requested,
      positions: Array.from({ length: 14 }, (_, index) => ({
        x: -1 + Math.floor(index / 2) / 3, y: index % 2 === 0 ? 1 : -1, z: 0, w: 1,
      })) });
    expect(pixel(cpu)).toEqual([128, 0, 0, 255]);
    executeStaticBatch(cpu, quad());
    expect(pixel(cpu)).toEqual([128, 128, 128, 255]);
  } finally { target.close(); }
});

test("initial incomplete unit skips its environment; real registration preserves cache/raw-zero divergence", () => {
  const { images, cpu } = fixture();
  const color = {x:.25,y:.5,z:.75,w:.5};
  executeStaticBatch(cpu,quad(undefined,color)); expect(pixel(cpu)).toEqual([64,128,191,128]);
  const red = image(images,[255,0,0,255]), green = image(images,[0,255,0,255]);
  executeStaticBatch(cpu,quad({kind:"bind-image",image:green},color)); expect(pixel(cpu)).toEqual([64,128,191,128]);
  executeStaticBatch(cpu,quad({kind:"bind-image",image:red})); expect(pixel(cpu)).toEqual([255,0,0,255]);
  executeStaticBatch(cpu,quad({kind:"bind-image",image:green})); expect(pixel(cpu)).toEqual([0,255,0,255]);
  executeStaticBatch(cpu,quad()); expect(pixel(cpu)).toEqual([0,255,0,255]);
});

test("creation owns pixels and RGB8 storage discards alpha without synthetic white", () => {
  const { images, cpu } = fixture(), bytes = new Uint8Array([70,80,90,7]);
  const owned = images.create({name:"owned",sourceWidth:1,sourceHeight:1,levels:[{width:1,height:1,pixels:bytes}],mipmap:false,
    internalFormat:"rgb8",sampling:{wrap:"repeat",filter:"nearest"},registrationUnit:0});
  image(images,[1,2,3,4]); bytes.fill(255);
  executeStaticBatch(cpu,quad({kind:"bind-image",image:owned})); expect(pixel(cpu)).toEqual([70,80,90,255]);
});

test("RGB8 clamp border and REPLACE preserve incoming alpha, unlike RGBA8", () => {
  // OpenGL 1.4 tables 3.22-3.23: RGB environments never replace/modulate alpha.
  // https://registry.khronos.org/OpenGL/specs/gl/glspec14.pdf
  const { images, cpu } = fixture();
  const rgb = image(images,[200,100,40,0],1,1,{wrap:"clamp",filter:"linear"},0,"rgb8");
  image(images,[1,1,1,255]);
  executeStaticBatch(cpu,quad({kind:"bind-image",image:rgb},{x:1,y:1,z:1,w:.5},0,0));
  expect(pixel(cpu)).toEqual([50,25,10,128]);
  const base = quad(undefined,{x:1,y:1,z:1,w:.5});
  const pair: DrawBatch = {...base,texturing:"pair",vertices:base.vertices.map(vertex=>({...vertex,texCoord2:{x:.5,y:.5}})),
    secondTexture:{binding:{kind:"bind-image",image:rgb},environment:"replace"}};
  executeStaticBatch(cpu,pair); expect(pixel(cpu)).toEqual([200,100,40,128]);
});

test("cinematic resize writes shared actual zero RGB8, preserving its post-fog white border", () => {
  const { images, cpu } = fixture();
  const other = image(images,[0,255,0,255]);
  const scratch = image(images,[255,0,0,64],1,1,{wrap:"clamp",filter:"linear"});
  images.setCurrentBorderColor(WHITE);
  const blue = [0,0,255,0,0,0,255,0,0,0,255,0,0,0,255,0];
  apply(cpu,upload(scratch,2,2,blue));
  executeStaticBatch(cpu,quad()); expect(pixel(cpu)).toEqual([0,0,255,255]);
  const single = quad(undefined,WHITE,0,0);
  const pair: DrawBatch = {...single,texturing:"pair",vertices:single.vertices.map(vertex=>({...vertex,texCoord2:{x:0,y:0}})),
    secondTexture:{binding:{kind:"retain-current-texture"},environment:"replace"}};
  executeStaticBatch(cpu,pair); expect(pixel(cpu)).toEqual([191,191,255,255]);
  executeStaticBatch(cpu,quad({kind:"bind-image",image:other}));
  executeStaticBatch(cpu,quad({kind:"bind-image",image:scratch},WHITE,0,0));
  expect(pixel(cpu)).toEqual([64,0,0,16]); // Named scratch kept RGBA8 and black border.
});

test("equal clean only binds, dirty subimage preserves format, filter and larger storage", () => {
  const { images, cpu } = fixture();
  const scratch = image(images,[200,0,0,20]); image(images,[0,0,0,255]);
  executeStaticBatch(cpu,quad({kind:"bind-image",image:scratch}));
  apply(cpu,upload(scratch,1,1,[10,20,30,40],false));
  executeStaticBatch(cpu,quad()); expect(pixel(cpu)).toEqual([200,0,0,20]);
  apply(cpu,upload(scratch,1,1,[10,20,30,40]));
  executeStaticBatch(cpu,quad()); expect(pixel(cpu)).toEqual([10,20,30,40]);
  apply(cpu,upload(scratch,2,1,[100,110,120,0,130,140,150,0]));
  executeStaticBatch(cpu,quad(undefined,WHITE,.25,.5)); expect(pixel(cpu)).toEqual([100,110,120,255]);
  apply(cpu,upload(scratch,2,1,[50,60,70,8,80,90,100,8]));
  executeStaticBatch(cpu,quad(undefined,WHITE,.25,.5)); expect(pixel(cpu)).toEqual([50,60,70,255]);
});

test("invalid dirty subimage into absent storage neither creates storage nor throws", () => {
  const { images, cpu } = fixture(), scratch = image(images,[255,0,0,20]);
  expect(()=>apply(cpu,upload(scratch,1,1,[0,255,0,255]))).not.toThrow();
  executeStaticBatch(cpu,quad(undefined,{x:.25,y:.5,z:.75,w:1})); expect(pixel(cpu)).toEqual([64,128,191,255]);
});

test("subimages use actual storage stride and reject oversized writes without reallocating zero", () => {
  const { images, cpu } = fixture(), first = image(images,[255,0,0,255]);
  apply(cpu,upload(first,2,2,[0,0,255,0,0,0,255,0,0,0,255,0,0,0,255,0]));
  const one = image(images,[255,0,0,255]);
  apply(cpu,upload(one,1,1,[0,255,0,0]));
  executeStaticBatch(cpu,quad(undefined,WHITE,.25,.25)); expect(pixel(cpu)).toEqual([0,255,0,255]);
  executeStaticBatch(cpu,quad(undefined,WHITE,.75,.75)); expect(pixel(cpu)).toEqual([0,0,255,255]);
  const four = Array.from({length:16},()=>[255,0,0,255]).flat(), large = image(images,four,4,4);
  expect(()=>apply(cpu,upload(large,4,4,four))).not.toThrow();
  executeStaticBatch(cpu,quad(undefined,WHITE,.75,.75)); expect(pixel(cpu)).toEqual([0,0,255,255]);
});

test("registration unit1 restores current unit0; border journal targets actual current object", () => {
  const { images, cpu } = fixture(), a = image(images,[255,0,0,255],1,1,{wrap:"clamp",filter:"linear"});
  image(images,[0,255,0,255]); executeStaticBatch(cpu,quad({kind:"bind-image",image:a}));
  image(images,[0,0,255,255],1,1,{wrap:"repeat",filter:"nearest"},1);
  images.setCurrentBorderColor(WHITE);
  executeStaticBatch(cpu,quad(undefined,WHITE,0,0)); expect(pixel(cpu)).toEqual([255,191,191,255]);
});

test("geometry preparation snapshots attributes but changes no bindings or framebuffer", () => {
  const { images, cpu } = fixture();
  const red = image(images,[255,0,0,255]), green = image(images,[0,255,0,255]);
  executeStaticBatch(cpu,quad({kind:"bind-image",image:red}));
  const input = quad({kind:"bind-image",image:green}), prepared = cpu.prepareGeometry(input);
  executeStaticBatch(cpu,quad()); expect(pixel(cpu)).toEqual([255,0,0,255]);
  for (const vertex of input.vertices) Object.assign(vertex.color,{x:0,y:0,z:0,w:0});
  prepared.begin(); prepared.applyTexture(0,{kind:"bind-image",image:green}); prepared.draw(); prepared.cleanup();
  expect(pixel(cpu)).toEqual([0,255,0,255]);
  expect(()=>cpu.prepareGeometry({...input,indices:[999,0,1]})).toThrow("index");
});

test("prepared operations reject replay and invalid static state before texture effects",()=>{
  const {images,cpu}=fixture(),prepared=cpu.prepareGeometry(quad());
  expect(()=>prepared.draw()).toThrow("unapplied");prepared.begin();
  expect(()=>prepared.applyTexture(1,{kind:"retain-current-texture"})).toThrow("order");
  prepared.applyTexture(0,{kind:"retain-current-texture"});prepared.draw();prepared.cleanup();
  expect(()=>prepared.begin()).toThrow("already");expect(()=>prepared.draw()).toThrow("unapplied");
  const invalid=quad();Object.assign(invalid.state.blend,{destination:"src-alpha-saturate"});
  expect(()=>cpu.prepareGeometry(invalid)).toThrow("blend");
  const uninitialized=new SoftwareRenderer(2,2,images),owned=image(images,[1,2,3,4]);
  expect(()=>uninitialized.prepareGeometry(quad({kind:"bind-image",image:owned}))).toThrow("replayed");
});

test("raw draw applies full-frame 2D state every time with float identity light", () => {
  const { images, cpu } = fixture(), scratch = image(images,[200,100,50,255]); image(images,[0,0,0,255]);
  cpu.beginView({viewport:{x:1,y:1,width:1,height:1},clear:{ stencil: false,color:{x:0,y:0,z:0,w:0},depth:0}});
  const raw = cpu.prepareRawGeometry({rect:{x:0,y:0,width:2,height:2},uploadWidth:1,uploadHeight:1,identityLight:.5});
  raw.uploadCurrent(upload(scratch,1,1,[200,100,50,255],false)); raw.draw();
  expect([...cpu.pixels]).toEqual([100,50,25,255,100,50,25,255,100,50,25,255,100,50,25,255]);
});

test("separate backend instances own actual objects and rejected foreign images never allocate", () => {
  const first = fixture(), second = fixture();
  const a = image(first.images,[255,0,0,255]); image(first.images,[0,0,0,255]);
  executeStaticBatch(first.cpu,quad({kind:"bind-image",image:a}));
  expect(()=>second.cpu.prepareGeometry(quad({kind:"bind-image",image:a}))).toThrow("another catalog");
  executeStaticBatch(second.cpu,quad()); expect(pixel(second.cpu)).toEqual([255,255,255,255]);
  first.cpu.close(); expect(()=>first.cpu.prepareGeometry(quad())).toThrow("closed");
});

test("actual consuming target prepares each shader slot once and mirrors its upload to two CPU backends", () => {
  const images = new RendererImageCatalog(), first = new SoftwareRenderer(2,2,images), second = new SoftwareRenderer(2,2,images);
  const target = new RenderTarget(images,[first,second]);
  const a = image(images,[1,1,1,255]), b = image(images,[2,2,2,255]); image(images,[3,3,3,255]);
  const commands = new RenderCommandBuffer(target,{print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock:{milliseconds:()=>123},identityLight:1,tess:new SourceTessState(),runtime:createRendererSettings().runtime});
  const events: string[] = [];
  const binding = (name: string, data: CinematicUpload): TextureBinding => ({kind:"shader-cinematic",source:{image:data.image,prepareAtExecution(){
    events.push(`prepare:${name}`); return {upload:data,afterShaderUpload(){events.push(`complete:${name}`);}};
  }}});
  const base = quad(binding("a",upload(a,1,1,[128,0,0,128])));
  const pair: DrawBatch = {...base,texturing:"pair",vertices:base.vertices.map(vertex=>({...vertex,texCoord2:{x:.5,y:.5}})),
    secondTexture:{binding:binding("b",upload(b,1,1,[128,255,255,128])),environment:"modulate"}};
  commands.addView({viewport:{x:0,y:0,width:2,height:2},clear:{ stencil: false,color:{x:0,y:0,z:0,w:0},depth:1},operations: [{ kind: "draw", batches: [pair] }]});
  expect(events).toEqual([]);
  expect(commands.submit()).toEqual({commands:1,views:1,batches:1});
  expect(events).toEqual(["prepare:a","complete:a","prepare:b","complete:b"]);
  expect(pixel(first)).toEqual([64,0,0,64]); expect(second.pixels).toEqual(first.pixels);
  expect(commands.submit()).toEqual({commands:0,views:0,batches:0});
  expect(events).toHaveLength(4); target.close();
});

test("registration precedes an older queued retain draw without implicitly submitting it",()=>{
  const images=new RendererImageCatalog(),cpu=new SoftwareRenderer(2,2,images),target=new RenderTarget(images,[cpu]);
  const commands=new RenderCommandBuffer(target,{print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock:{milliseconds:()=>0},identityLight:1,tess:new SourceTessState(),runtime:createRendererSettings().runtime});
  const red=image(images,[255,0,0,255],1,1,{wrap:"repeat",filter:"nearest"},1);
  executeStaticBatch(cpu,quad({kind:"bind-image",image:red}));
  commands.addView({viewport:{x:0,y:0,width:2,height:2},clear:{ stencil: false,color:null,depth:1},operations: [{ kind: "draw", batches: [quad()] }]});
  image(images,[0,255,0,255]);expect(pixel(cpu)).toEqual([255,0,0,255]);
  expect(commands.submit()).toEqual({commands:1,views:1,batches:1});expect(pixel(cpu)).toEqual([255,255,255,255]);target.close();
});

test("actual queued shader work precedes raw pointer capture and raw completion follows both CPU draws", () => {
  const images = new RendererImageCatalog(), first = new SoftwareRenderer(2,2,images), second = new SoftwareRenderer(2,2,images);
  const target = new RenderTarget(images,[first,second]), scratch = image(images,[255,0,0,255]); image(images,[0,0,0,255]);
  const pointer = new Uint8Array([255,0,0,255]), events: string[] = [];
  const commands = new RenderCommandBuffer(target,{print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock:{milliseconds(){events.push("clock");return 99;}},identityLight:1,tess:new SourceTessState(),runtime:createRendererSettings().runtime});
  commands.addView({viewport:{x:0,y:0,width:2,height:2},clear:{ stencil: false,color:null,depth:1},operations: [{ kind: "draw", batches: [quad({kind:"shader-cinematic",source:{image:scratch,prepareAtExecution(){
    pointer.set([0,255,0,255]); events.push("shader"); return null;
  }}})] }]});
  commands.stretchRaw({x:0,y:0,width:2,height:2},{image:scratch,sourceWidth:1,sourceHeight:1,uploadWidth:1,uploadHeight:1,dirty:true,
    captureAfterBarrier(){events.push("capture");return {upload:{image:scratch,sourceWidth:1,sourceHeight:1,uploadWidth:1,uploadHeight:1,dirty:true,content:new RgbaSnapshot(1,1,pointer)},
      afterUiDraw(){events.push("complete");expect(pixel(first)).toEqual([0,255,0,255]);expect(second.pixels).toEqual(first.pixels);}};}});
  expect(events).toEqual(["clock","shader","clock","capture","clock","complete"]); target.close();
});

test.skipIf(process.env["QUAKE_GL_TEST"]!=="1")("actual GL matches RGB alpha and raw resize into shared object zero without changing named storage",()=>{
  const window=SdlWindow.open({title:"CPU explicit image state",width:2,height:2,backend:"gl",hidden:true});
  const images=new RendererImageCatalog(),gl=new GlRenderer(window,images),cpu=new SoftwareRenderer(2,2,images,gl.subpixelBits),target=new RenderTarget(images,[cpu,gl]);
  gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  const commands=new RenderCommandBuffer(target,{print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock:{milliseconds:()=>1},identityLight:.5,tess:new SourceTessState(),runtime:createRendererSettings().runtime});
  const compare=(batch:DrawBatch,expected:readonly number[]):void=>{
    commands.addView({viewport:{x:0,y:0,width:2,height:2},clear:{ stencil: false,color:{x:0,y:0,z:0,w:0},depth:1},operations: [{ kind: "draw", batches: [batch] }]});commands.submit();
    expect(pixel(cpu)).toEqual([...expected]);expect([...gl.readPixels().subarray(0,4)]).toEqual([...expected]);
  };
  try {
    const rgb=image(images,[200,100,40,0],1,1,{wrap:"clamp",filter:"linear"},1,"rgb8");
    compare(quad({kind:"bind-image",image:rgb},{x:1,y:1,z:1,w:128/255},0,0),[50,25,10,128]);
    const base=quad(undefined,{x:1,y:1,z:1,w:128/255});
    const pair:DrawBatch={...base,texturing:"pair",vertices:base.vertices.map(vertex=>({...vertex,texCoord2:{x:.5,y:.5}})),
      secondTexture:{binding:{kind:"bind-image",image:rgb},environment:"replace"}};
    // Unit1 cache still equals rgb after registration; first establish a different real image.
    const other=image(images,[0,255,0,255],1,1,{wrap:"repeat",filter:"nearest"},1);
    compare(pair,[200,100,40,128]);
    const scratch=image(images,[255,0,0,64]);images.setCurrentBorderColor(WHITE);
    const bytes=new Uint8Array([200,100,50,0,200,100,50,0,200,100,50,0,200,100,50,0]);let completed=0;
    commands.stretchRaw({x:0,y:0,width:2,height:2},{image:scratch,sourceWidth:2,sourceHeight:2,uploadWidth:2,uploadHeight:2,dirty:false,
      captureAfterBarrier(){return {upload:{image:scratch,sourceWidth:2,sourceHeight:2,uploadWidth:2,uploadHeight:2,dirty:false,content:new RgbaSnapshot(2,2,bytes)},
        afterUiDraw(){completed++;expect(pixel(cpu)).toEqual([100,50,25,255]);expect(gl.readPixels()).toEqual(cpu.pixels);}};}});
    expect(completed).toBe(1);
    compare(quad({kind:"bind-image",image:other}),[0,255,0,255]);
    compare(quad({kind:"bind-image",image:scratch}),[255,0,0,64]);
  }finally{target.close();window.close();}
});

test.skipIf(process.env["QUAKE_GL_TEST"]!=="1")("raw upload preserves current unit1 and changes shared zero rather than rebinding its named image on unit0",()=>{
  const window=SdlWindow.open({title:"Current unit1 raw upload",width:2,height:2,backend:"gl",hidden:true});
  const images=new RendererImageCatalog(),gl=new GlRenderer(window,images),cpu=new SoftwareRenderer(2,2,images,gl.subpixelBits),target=new RenderTarget(images,[cpu,gl]);
  gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  try {
    const a=image(images,[255,0,0,255],1,1,{wrap:"repeat",filter:"nearest"},0), b=image(images,[0,255,0,255],1,1,{wrap:"repeat",filter:"nearest"},1);
    const base=quad({kind:"bind-image",image:a}),pair:DrawBatch={...base,texturing:"pair",vertices:base.vertices.map(vertex=>({...vertex,texCoord2:{x:.5,y:.5}})),secondTexture:{binding:{kind:"bind-image",image:b},environment:"modulate"}};
    const previous=[cpu.prepareGeometry(pair),gl.prepareGeometry(pair)];
    for(const prepared of previous){prepared.begin();prepared.applyTexture(0,{kind:"bind-image",image:a});prepared.applyTexture(1,{kind:"bind-image",image:b});prepared.draw();}
    // DrawElements leaves current UV1 indeterminate. Matching the actual shared
    // zero object's border to its blue upload makes this raw sample independent.
    images.setCurrentBorderColor({x:0,y:0,z:1,w:1});
    const content=upload(b,2,2,[0,0,255,0,0,0,255,0,0,0,255,0,0,0,255,0]);
    for(const backend of [cpu,gl]){
      const raw=backend.prepareRawGeometry({rect:{x:0,y:0,width:2,height:2},uploadWidth:2,uploadHeight:2,identityLight:1});
      raw.uploadCurrent(content);raw.draw();
    }
    for(const prepared of previous)prepared.cleanup();
    const commands=new RenderCommandBuffer(target,{print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock:{milliseconds:()=>0},identityLight:1,tess:new SourceTessState(),runtime:createRendererSettings().runtime});
    commands.addView({viewport:{x:0,y:0,width:2,height:2},clear:{ stencil: false,color:null,depth:1},operations: [{ kind: "draw", batches: [quad()] }]});commands.submit();
    expect(pixel(cpu)).toEqual([0,0,255,255]);expect(gl.readPixels()).toEqual(cpu.pixels);
    commands.addView({viewport:{x:0,y:0,width:2,height:2},clear:{ stencil: false,color:null,depth:1},operations: [{ kind: "draw", batches: [quad({kind:"bind-image",image:b})] }]});commands.submit();
    expect(pixel(cpu)).toEqual([0,255,0,255]);expect(gl.readPixels()).toEqual(cpu.pixels);
  }finally{target.close();window.close();}
});
