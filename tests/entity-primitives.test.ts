import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import { describe, expect, spyOn, test } from "bun:test";
import { anglesToAxis, vec3 } from "../src/core/math.ts";
import { spriteGeometry, spriteFog, beamBatch, railGeometry, polyGeometry } from "../src/render/entity-primitives.ts";
import { createBeamEntity, createLightningEntity, createRailCoreEntity, createRailRingsEntity, createModelEntity, createPortalEntity, createSpriteEntity, copyRefEntity, copyRefPoly, DEFAULT_MODEL } from "../src/render/ref-entity.ts";
import type { RefPoly } from "../src/render/ref-entity.ts";
import { RendererResources } from "../src/render/world.ts";
import { CPU_OFFSET_DEPTH_BITS, SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import type { DrawBatch, RenderVertex, SingleTextureBatch } from "../src/render/types.ts";
import type { WorldFrame } from "../src/render/world.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { RendererImage, ImageResourceOperation, CreateImageOperation } from "../src/render/image-resource.ts";
import { RenderTarget, RenderCommandBuffer } from "../src/render/commands.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { BatchRecordingBackend, executeStaticBatch } from "./render-target-fixture.ts";

class ImageRecorder extends BatchRecordingBackend {
  readonly creations: CreateImageOperation[] = [];
  override applyImageResource(operation: ImageResourceOperation): undefined {
    super.applyImageResource(operation);
    if (operation.kind === "create-image") this.creations.push(operation.creation);
    return undefined;
  }
}
function pipeline(gl: GlRenderer | null = null) {
  const images = gl === null ? new RendererImageCatalog() : gl.images;
  const cpu = new SoftwareRenderer(64, 64, images, gl === null ? 8 : gl.subpixelBits), recorder = new ImageRecorder(cpu);
  const target = new RenderTarget(images, gl === null ? [recorder] : [recorder, gl]), builtins = new BuiltinImages(images, identityImageUploadProfile);
  const image = builtins.find("*white")?.image; if (image === undefined) throw new Error("Missing real built-in white");
  return { images, cpu, recorder, target, builtins, image };
}
async function fixture(reader: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">) {
  const f = pipeline(), settings = createRendererSettings();
  const cinematicMixer = new AudioMixer(44100, () => 0);
  const movies = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: reader }, sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: { sample: () => 0 },
    scratchImages: f.builtins, console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  const resources = await RendererResources.create(reader, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target: f.target, images: f.images, builtins: f.builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: movies.shaderCinematics });
  const queue = new RenderCommandBuffer(f.target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  return { ...f, resources, queue, close: () => { movies.closeAllVideos(); f.target.close(); } };
}
const viewport = { x: 0, y: 0, width: 64, height: 64 };
const identity = anglesToAxis(vec3(0, 0, 0));
const view: WorldFrame = { refdef: { ...cameraRefdef({ origin: vec3(0, 0, 0), angles: vec3(0, 0, 0) }, 64, 64), renderFlags: RDF_NOWORLDMODEL } };
const black = { x: 0, y: 0, z: 0, w: 1 };
const white = { x: 1, y: 1, z: 1, w: 1 };

function line(image: RendererImage, ax: number, ay: number, bx: number, by: number, lineWidth = 3): SingleTextureBatch {
  const vertex = (x: number, y: number): RenderVertex => ({ position: { x: x / 32 - 1, y: y / 32 - 1, z: 0, w: 1 }, texCoord: { x: 0, y: 0 }, color: white });
  return { texturing: "single", primitive: "lines", lineWidth, vertices: [vertex(ax, ay), vertex(bx, by)], indices: [0, 1], texture: { kind: "bind-image", image }, state: OPAQUE_STATE };
}

describe("source procedural ref entities", () => {
  test("sprite corners store the first source addition before applying the other axis", () => {
    const sprite = createSpriteEntity();
    sprite.origin = vec3(16777216, 0, 0); sprite.radius = 1;
    const mesh = spriteGeometry(sprite, [vec3(0, 0, 1), vec3(1, 0, 0), vec3(-16777216, 1, 0)], false);
    expect(mesh.vertices[0]?.position).toEqual(vec3(0, 1, 0));
    expect(mesh.vertices[1]?.position).toEqual(vec3(-1, 1, 0));
    expect(mesh.vertices[0]?.position.x).not.toBe(Math.fround(16777216 + 1 - 16777216));
  });
  test("rail core truncates length, quarters only its first RGB, and lightning emits four rotated quads", () => {
    const core = createRailCoreEntity();
    core.oldOrigin = vec3(16, 0, 0); core.origin = vec3(16, 256.75, 0); core.shaderRGBA = { x: 255, y: 128, z: 65, w: 99 };
    const geometry = railGeometry(core, vec3(0, 0, 0));
    expect(geometry.indices).toEqual([0, 1, 2, 2, 1, 3]);
    expect(geometry.vertices.map(vertex => vertex.position)).toEqual([vec3(16, 0, 6), vec3(16, 0, -6), vec3(16, 256.75, 6), vec3(16, 256.75, -6)]);
    expect(geometry.vertices[0]?.color).toEqual({ x: 63, y: 32, z: 16, w: 0 });
    expect(geometry.vertices[2]?.texCoord.x).toBe(1);
    const lightning = { ...createLightningEntity(), origin: core.oldOrigin, oldOrigin: core.origin, shaderRGBA: core.shaderRGBA };
    const bolt = railGeometry(lightning, vec3(0, 0, 0));
    expect(bolt.vertices.length).toBe(16); expect(bolt.indices.length).toBe(24);
    expect(bolt.vertices[0]?.position.z).toBe(8);
    expect(bolt.vertices[4]?.position.x).toBeCloseTo(16 + Math.sqrt(32), 4);
    expect(bolt.vertices[4]?.position.z).toBeCloseTo(Math.sqrt(32), 4);
    expect(bolt.vertices[8]?.position.x).toBeCloseTo(24, 4);
    expect(bolt.vertices[8]?.position.z).toBeCloseTo(0, 4);
  });
  test("rail rings retain source reduced segment count and long-shot starting offset", () => {
    const rings = createRailRingsEntity(); rings.origin = vec3(128, 0, 0);
    const geometry = railGeometry(rings, vec3(0, 0, 16));
    expect(geometry.vertices.length).toBe(12);
    expect(geometry.vertices.filter((_, index) => index % 4 === 0).map(vertex => vertex.position.x)).toEqual([32, 64, 96]);
    expect(geometry.vertices[0]?.position.y).toBeCloseTo(-Math.sqrt(8), 5);
    expect(geometry.vertices[0]?.position.z).toBeCloseTo(Math.sqrt(8), 5);
    rings.origin = vec3(64, 0, 0);
    expect(railGeometry(rings, vec3(0, 0, 16)).vertices[0]?.position.x).toBe(0);
    expect(() => railGeometry(rings, vec3(0, 0, 0), { coreWidth: 6, ringWidth: 16, segmentLength: 0 })).toThrow();
  });
  test("polygon submission owns attributes and uses the source triangle fan", async () => {
    const path = "scripts/polygon.shader", script = new TextEncoder().encode("test/polygon { { map $whiteimage rgbGen identity } }");
    const f = await fixture(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
      readFileLength: name => name === path ? script.length : -1, readFileOptional: async name => name === path ? script : undefined,
      has: name => name === path, list: () => [path],
      read: async name => { if (name !== path) throw new Error(`unexpected asset read ${name}`); return script; },
    })), resources = f.resources;
    const shader = await resources.registerShader("test/polygon");
    if (shader === null) throw new Error("fixture picture registration failed");
    const vertices = [vec3(16, 4, 4), vec3(16, -4, 4), vec3(16, -4, -4), vec3(16, 4, -4)].map(position => ({ position, texCoord: { x: 0, y: 0 }, color: { x: 255, y: 0, z: 0, w: 255 } }));
    const poly: RefPoly = { shader, vertices }, copy = copyRefPoly(poly);
    expect(copy.vertices[0]).not.toBe(vertices[0]);
    expect(polyGeometry(poly).indices).toEqual([0, 1, 2, 0, 2, 3]);
    f.queue.addPreparedViews(resources.prepareFrame({ ...view, polys: [poly] })); f.queue.submit();
    const batches = f.recorder.trace().flatMap(view => view.batches);
    expect(batches.length).toBe(1);
    // An explicit opaque stage retains depth testing and writing.
    expect(batches[0]?.state.depthTest).toBe("less-equal");
    expect(batches[0]?.state.depthWrite).toBe(true);
    f.queue.addPreparedViews(resources.prepareFrame({ ...view, polys: [{ ...poly, shader: null }] }));
    expect(f.queue.submit().batches).toBe(0);
    expect(() => resources.prepareFrame({ ...view, polys: [{ ...poly, shader: { name: shader.name } }] })).toThrow("shader handle belongs to another renderer or is unregistered"); f.close();
  });
  test("world-free noMip registration uses source picture state and caches failed skins", async () => {
    const image = new Uint8Array(22); image[2] = 2; image[12] = 1; image[14] = 1; image[16] = 32; image[17] = 32;
    image.set([0, 0, 255, 128], 18);
    const f = await fixture(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: path => path === "icon.tga" ? image.byteLength : -1,
      readFileOptional: async path => path === "icon.tga" ? image : undefined, has: path => path === "icon.tga", list: () => [], read: async () => image })), resources = f.resources;
    expect(await resources.registerSkin("missing.skin")).toBeNull();
    expect(await resources.registerSkin("")).toBeNull();
    expect(await resources.registerModel("")).toBe(DEFAULT_MODEL);
    const shader = await resources.registerShaderNoMip("icon");
    expect(await resources.registerShader("icon")).toBe(shader);
    const sprite = { ...createSpriteEntity(), origin: vec3(16, 0, 0), radius: 4, customShader: shader, shaderRGBA: { x: 128, y: 255, z: 255, w: 127 } };
    f.queue.addPreparedViews(resources.prepareFrame({ ...view, entities: [sprite] })); f.queue.submit();
    const batch = f.recorder.trace().flatMap(view => view.batches)[0];
    if (batch === undefined || batch.texture.kind !== "bind-image") throw new Error("Missing consumed image batch");
    const bound = batch.texture.image;
    expect(f.recorder.creations.find(creation => creation.image === bound)?.sampling.wrap).toBe("clamp"); expect(batch?.state.depthTest).toBe("always"); expect(batch?.state.depthWrite).toBe(false);
    expect(batch?.state.blend).toEqual({ source: "src-alpha", destination: "one-minus-src-alpha" });
    expect(batch?.vertices[0]?.color).toEqual({ x: 128 / 255, y: 1, z: 1, w: 127 / 255 }); f.close();
  });
  test("factories preserve source zero values and submission copies values", () => {
    const model = createModelEntity();
    expect(model.model).toBe(DEFAULT_MODEL);
    expect(model.shaderRGBA).toEqual({ x: 0, y: 0, z: 0, w: 0 });
    expect(model.axis).toEqual([vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 0)]);
    const copy = copyRefEntity(model);
    model.origin = vec3(10, 20, 30);
    expect(copy.origin).toEqual(vec3(0, 0, 0));
    expect(copy).not.toBe(model);
    expect(createPortalEntity().oldOrigin).toEqual(vec3(0, 0, 0));
  });
  test("sprite corners, winding, normal, UVs, byte color and mirror rotation", () => {
    const sprite = createSpriteEntity();
    sprite.origin = vec3(8, 0, 0); sprite.radius = 2; sprite.shaderRGBA = { x: 21, y: 42, z: 63, w: 84 };
    const geometry = spriteGeometry(sprite, identity, false);
    expect(geometry.indices).toEqual([0, 1, 3, 3, 1, 2]);
    expect(geometry.vertices.map(vertex => vertex.position)).toEqual([vec3(8, 2, 2), vec3(8, -2, 2), vec3(8, -2, -2), vec3(8, 2, -2)]);
    expect(geometry.vertices.map(vertex => vertex.texCoord)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
    expect(geometry.vertices[0]?.normal.x).toBe(-1);
    expect(geometry.vertices[0]?.normal.y).toBeCloseTo(0);
    expect(geometry.vertices[0]?.normal.z).toBeCloseTo(0);
    expect(geometry.vertices[0]?.color).toEqual(sprite.shaderRGBA);
    expect(spriteGeometry(sprite, identity, true).vertices[0]?.position).toEqual(vec3(8, -2, 2));
    sprite.rotation = 90;
    const rotated = spriteGeometry(sprite, identity, false).vertices[0];
    expect(rotated?.position.y).toBeCloseTo(2, 5); expect(rotated?.position.z).toBeCloseTo(-2, 5);
  });
  test("beam keeps fixed source geometry and zero length emits no triangles", () => {
    const f = pipeline(), beam = createBeamEntity();
    beam.origin = vec3(20, 0, 0); beam.oldOrigin = vec3(20, 0, 16); beam.radius = 100;
    const batch = beamBatch(beam, point => ({ ...point, w: 1 }), OPAQUE_STATE, f.image);
    expect(batch.vertices.length).toBe(12); expect(batch.indices.length).toBe(36);
    expect(batch.vertices.every(vertex => Math.abs(vertex.position.x) <= 4 && Math.abs(vertex.position.y) <= 4)).toBe(true);
    expect(batch.vertices.every(vertex => vertex.color.x === 1 && vertex.color.y === 0)).toBe(true);
    expect(batch.state.blend).toEqual({ source: "one", destination: "one" });
    expect(batch.state.depthWrite).toBe(false);
    beam.oldOrigin = beam.origin;
    expect(beamBatch(beam, point => ({ ...point, w: 1 }), OPAQUE_STATE, f.image).indices).toEqual([]); f.target.close();
  });
  test("sprite fog keeps strict tangency and source first-volume selection", () => {
    const fogs = [{ min: vec3(0, 0, 0), max: vec3(10, 10, 10) }];
    expect(spriteFog(vec3(-2, 5, 5), 2, fogs)).toBe(-1);
    expect(spriteFog(vec3(-1, 5, 5), 2, fogs)).toBe(0);
  });
  test("resources prepare shaders before a world exists and frame without I/O", async () => {
    let reads = 0;
    const f = await fixture(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: name => name === "scripts/test.shader" ? new TextEncoder().encode("test/sprite { cull none { map $whiteimage rgbGen vertex alphaGen vertex } }").byteLength : -1,
      async readFileOptional(name) { return name === "scripts/test.shader" ? this.read(name) : undefined; },
      has: path => path === "scripts/test.shader", list: () => ["scripts/test.shader"],
      read: async () => { reads++; return new TextEncoder().encode("test/sprite { cull none { map $whiteimage rgbGen vertex alphaGen vertex } }"); } })), resources = f.resources;
    const sprite = createSpriteEntity(); sprite.origin = vec3(32, 0, 0); sprite.radius = 8;
    sprite.shaderRGBA = { x: 255, y: 0, z: 0, w: 255 };
    sprite.customShader = await resources.registerShader("test/sprite");
    expect(await resources.registerModel("missing.md3")).toBe(DEFAULT_MODEL);
    const before = reads;
    f.queue.addPreparedViews(resources.prepareFrame({ ...view, entities: [sprite] }));
    expect(reads).toBe(before); expect(f.queue.submit().views).toBe(1);
    const cpu = f.cpu;
    expect([...cpu.pixels.slice((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4)]).toEqual([255, 0, 0, 255]);
    const axis = createModelEntity(); axis.axis = identity; axis.origin = vec3(32, 0, 0);
    const immediate = spyOn(cpu, "drawImmediate");
    try {
      f.queue.addPreparedViews(resources.prepareFrame({ ...view, entities: [axis] })); f.queue.submit();
      const axes = immediate.mock.calls.flatMap(([operation]) => operation.kind === "entity-axis" ? [operation] : []);
      expect(axes).toHaveLength(1); expect(axes[0]?.positions).toHaveLength(6);
      expect(axes[0]?.whiteImage).toBe(f.image); expect(reads).toBe(before);
    } finally { immediate.mockRestore(); f.close(); }
  });
});

describe("aliased line rasterization", () => {
  test("polygon offset uses the configured slope and resolvable 24-bit depth unit", () => {
    const f = pipeline(), cpu = f.cpu;
    const triangle: DrawBatch = { texturing: "single", primitive: "triangles", indices: [0, 1, 2], texture: { kind: "bind-image", image: f.image }, state: { ...OPAQUE_STATE, cull: "none", polygonOffset: { factor: 0, units: -2 } },
      vertices: [vec3(-1, -1, 0), vec3(1, -1, 0), vec3(0, 1, 0)].map(position => ({ position: { ...position, w: 1 }, color: white, texCoord: { x: 0, y: 0 } })) };
    cpu.beginView({ viewport, clear: { stencil: false, color: black, depth: 0.5 - 2 ** -CPU_OFFSET_DEPTH_BITS } }); executeStaticBatch(cpu, triangle);
    expect(cpu.pixels[(32 * 64 + 32) * 4]).toBe(255);
    cpu.beginView({ viewport, clear: { stencil: false, color: black, depth: 0.5 - 3 * 2 ** -CPU_OFFSET_DEPTH_BITS } }); executeStaticBatch(cpu, triangle);
    expect(cpu.pixels[(32 * 64 + 32) * 4]).toBe(0);
    const slope = { ...triangle, state: { ...triangle.state, polygonOffset: { factor: -1, units: 0 } },
      vertices: triangle.vertices.map(vertex => ({ ...vertex, position: { ...vertex.position, z: vertex.position.x / 2 } })) };
    cpu.beginView({ viewport, clear: { stencil: false, color: black, depth: 0.5 } }); executeStaticBatch(cpu, slope);
    expect(cpu.pixels[(32 * 64 + 32) * 4]).toBe(255);
    cpu.beginView({ viewport, clear: { stencil: false, color: black, depth: 0.5 } }); executeStaticBatch(cpu, { ...slope, state: { ...OPAQUE_STATE, cull: "none" } });
    expect(cpu.pixels[(32 * 64 + 32) * 4]).toBe(0); f.target.close();
  });
  test("depth range is applied after clipping and restored by subsequent batches", () => {
    const f = pipeline(), cpu = f.cpu;
    const triangle: DrawBatch = { texturing: "single", primitive: "triangles", indices: [0, 1, 2], texture: { kind: "bind-image", image: f.image }, state: { ...OPAQUE_STATE, cull: "none", depthRange: [0, 0.3] },
      vertices: [vec3(-1, -1, 0), vec3(1, -1, 0), vec3(0, 1, 0)].map(position => ({ position: { ...position, w: 1 }, color: white, texCoord: { x: 0, y: 0 } })) };
    cpu.beginView({ viewport, clear: { stencil: false, color: black, depth: 0.2 } }); executeStaticBatch(cpu, triangle);
    expect(cpu.pixels[(32 * 64 + 32) * 4]).toBe(255);
    cpu.beginView({ viewport, clear: { stencil: false, color: black, depth: 0.2 } }); executeStaticBatch(cpu, { ...triangle, state: OPAQUE_STATE });
    expect(cpu.pixels[(32 * 64 + 32) * 4]).toBe(0);
    cpu.beginView({ viewport, clear: { stencil: false, color: black, depth: 1 } }); executeStaticBatch(cpu, { ...triangle, vertices: triangle.vertices.map(vertex => ({ ...vertex, position: { ...vertex.position, z: -2 } })) });
    expect(cpu.pixels[(32 * 64 + 32) * 4]).toBe(0); f.target.close();
  });
  test("width-three half-open horizontal line covers exactly 48 columns and three rows", () => {
    const f = pipeline(), cpu = f.cpu; cpu.beginView({ viewport, clear: { stencil: false, color: black, depth: 1 } }); executeStaticBatch(cpu, line(f.image, 8, 12, 56, 12));
    let fragments = 0;
    for (let index = 0; index < cpu.pixels.length; index += 4) if (cpu.pixels[index] === 255) fragments++;
    expect(fragments).toBe(48 * 3); f.target.close();
  });
  test("rejects invalid index counts and widths", () => {
    const f = pipeline(), cpu = f.cpu, batch = line(f.image, 8, 12, 56, 12);
    expect(() => executeStaticBatch(cpu, { ...batch, indices: [0] })).toThrow();
    expect(() => executeStaticBatch(cpu, { ...batch, primitive: "lines", lineWidth: 0 })).toThrow();
    expect(() => executeStaticBatch(cpu, { ...batch, primitive: "lines", lineWidth: 1e30 })).toThrow("safe pixel stepping"); f.target.close();
  });
  test("line clipping bounds large finite homogeneous plane sums", () => {
    const f = pipeline(), cpu = f.cpu, ordinary = line(f.image, -8, 20, 80, 20);
    cpu.beginView({ viewport, clear: { stencil: false, color: black, depth: 1 } }); executeStaticBatch(cpu, ordinary); const expected = cpu.pixels.slice();
    const magnitude = Number.MAX_VALUE / 3;
    const huge = { ...ordinary, vertices: ordinary.vertices.map(vertex => ({ ...vertex, position: {
      x: vertex.position.x * magnitude, y: vertex.position.y * magnitude, z: 0, w: magnitude } })) };
    cpu.beginView({ viewport, clear: { stencil: false, color: black, depth: 1 } }); executeStaticBatch(cpu, huge); expect(cpu.pixels).toEqual(expected); f.target.close();
  });
  test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("real GL_LINES width-three coverage matches CPU across octants and clipped endpoints", () => {
    const window = SdlWindow.open({ title: "Source line width parity", width: 64, height: 64, backend: "gl", hidden: true });
    const images = new RendererImageCatalog(), gl = new GlRenderer(window, images);
    gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => {
      images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST");
    });
    const f = pipeline(gl), cpu = f.cpu;
    const queue = new RenderCommandBuffer(f.target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1, tess: new SourceTessState(), runtime: createRendererSettings().runtime });
    try {
      expect(gl.depthBits).toBe(CPU_OFFSET_DEPTH_BITS);
      const offsetTriangle: DrawBatch = { texturing: "single", primitive: "triangles", indices: [0, 1, 2], texture: { kind: "bind-image", image: f.image },
        state: { ...OPAQUE_STATE, cull: "none", polygonOffset: { factor: -1, units: -2 } },
        vertices: [vec3(-1, -1, -0.5), vec3(1, -1, 0.5), vec3(0, 1, 0)].map(position => ({ position: { ...position, w: 1 }, color: white, texCoord: { x: 0, y: 0 } })) };

      const later: DrawBatch = { ...offsetTriangle, state: { ...OPAQUE_STATE, cull: "none" }, vertices: offsetTriangle.vertices.map(vertex => ({ ...vertex, color: black })) };
      queue.addView({ viewport, clear: { stencil: false, color: black, depth: 1 }, operations: [{ kind: "draw", batches: [offsetTriangle, later] }] }); queue.submit();
      expect(gl.readPixels()).toEqual(cpu.pixels);
      expect(cpu.pixels[(32 * 64 + 32) * 4]).toBe(255);
      const depthLine = line(f.image, 8, 12, 56, 12);

      const hacked: DrawBatch = { ...depthLine, state: { ...depthLine.state, depthRange: [0, 0.3] } };
      queue.addView({ viewport, clear: { stencil: false, color: black, depth: .2 }, operations: [{ kind: "draw", batches: [hacked] }] }); queue.submit();
      expect(gl.readPixels()).toEqual(cpu.pixels);
      expect(cpu.pixels.some((value, index) => index % 4 === 0 && value === 255)).toBe(true);
      const coloredBase = line(f.image, 8, 8, 56, 56);
      const colored: DrawBatch = { ...coloredBase, vertices: coloredBase.vertices.map((vertex, index) => ({ ...vertex,
        color: { x: index === 0 ? 1 : 0, y: 0, z: index === 0 ? 0 : 1, w: 1 } })) };
      queue.addView({ viewport, clear: { stencil: false, color: black, depth: 1 }, operations: [{ kind: "draw", batches: [colored] }] }); queue.submit();
      const coloredGl = gl.readPixels();
      let colorDifference = 0;
      for (const [index, value] of cpu.pixels.entries()) {
        const expected = coloredGl[index]; if (expected === undefined) throw new Error("missing GL gradient channel");
        colorDifference = Math.max(colorDifference, Math.abs(value - expected));
      }
      expect(colorDifference).toBeLessThanOrEqual(1);
      for (const [ax, ay, bx, by] of [[8, 12, 56, 12], [12, 8, 12, 56], [8, 8, 56, 56], [56, 8, 8, 56], [8.5, 8.5, 52.5, 26.5], [52.5, 26.5, 8.5, 8.5], [-8, 20, 80, 20]] satisfies [number, number, number, number][]) {
        const batch = line(f.image, ax, ay, bx, by);
        queue.addView({ viewport, clear: { stencil: false, color: black, depth: 1 }, operations: [{ kind: "draw", batches: [batch] }] }); queue.submit();
        const actual = gl.readPixels();
        const mismatch = cpu.pixels.reduce((count, value, index) => count + (value === actual[index] ? 0 : 1), 0);
        if (Number.isInteger(ax)) expect({ endpoints: [ax, ay, bx, by], mismatch }).toEqual({ endpoints: [ax, ay, bx, by], mismatch: 0 });
        else {
          // OpenGL 2.1 permits a one-pixel minor-axis choice at line ties.
          for (let x = 0; x < 64; x++) {
            const cpuRows: number[] = [], glRows: number[] = [];
            for (let y = 0; y < 64; y++) {
              if (cpu.pixels[(y * 64 + x) * 4] === 255) cpuRows.push(y);
              if (actual[(y * 64 + x) * 4] === 255) glRows.push(y);
            }
            expect(cpuRows.length).toBe(glRows.length);
            for (const [index, y] of cpuRows.entries()) {
              const expected = glRows[index];
              if (expected === undefined) throw new Error("missing corresponding GL line fragment");
              expect(Math.abs(y - expected)).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    } finally { f.target.close(); window.close(); }
  });
});
