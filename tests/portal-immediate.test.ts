import { describe, expect, test } from "bun:test";
import { vec4 } from "../src/core/math.ts";
import type { Vec4 } from "../src/core/math.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import type { RendererBackend } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererImageCatalog, RgbaSnapshot } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { OPAQUE_STATE, validateRenderView } from "../src/render/types.ts";
import { SourceStateBit } from "../src/render/source-state.ts";
import type { DrawBatch, ImmediateViewOperation, RenderState, SurfaceViewOperation, TextureSampling } from "../src/render/types.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { loadGl } from "../src/platform/gl.ts";
import { executeStaticBatch, publishTexture } from "./render-target-fixture.ts";
import { createRendererSettings } from "./renderer-settings-fixture.ts";

const viewport = { x: 0, y: 0, width: 32, height: 32 };
const black = vec4(0, 0, 0, 1), gray = vec4(64 / 255, 64 / 255, 64 / 255, 1);
const white = vec4(1, 1, 1, 1), green = vec4(0, 1, 0, 1);
const quadIndices = [0, 1, 2, 0, 2, 3];
function quad(depth: number): readonly [Vec4, Vec4, Vec4, Vec4] {
  return [vec4(-1, -1, depth, 1), vec4(1, -1, depth, 1), vec4(1, 1, depth, 1), vec4(-1, 1, depth, 1)];
}
function batch(image: RendererImage, state: RenderState = OPAQUE_STATE, color: Vec4 = white, depth = 0): DrawBatch {
  return { texturing: "single", primitive: "triangles", state, texture: { kind: "bind-image", image }, indices: quadIndices,
    vertices: quad(depth).map(position => ({ position, texCoord: { x: 0.25, y: 0.25 }, color })) };
}
function installState(backend: RendererBackend, image: RendererImage, state: RenderState): void {
  executeStaticBatch(backend, { ...batch(image, state), indices: [0, 0, 0] });
}
function axis(image: RendererImage, depth = 0): Extract<ImmediateViewOperation, { kind: "entity-axis" }> {
  return { kind: "entity-axis", whiteImage: image, positions: [vec4(-0.75, 0.5, depth, 1), vec4(0.75, 0.5, depth, 1),
    vec4(-0.75, 0, depth, 1), vec4(0.75, 0, depth, 1), vec4(-0.75, -0.5, depth, 1), vec4(0.75, -0.5, depth, 1)] };
}
function beam(image: RendererImage, depth = 0): Extract<ImmediateViewOperation, { kind: "entity-beam" }> {
  // Two nondegenerate strip triangles followed by degenerate vertices expose
  // strip winding without depending on the frontend's six-sided tube projector.
  return { kind: "entity-beam", whiteImage: image, positions: [vec4(-0.75, -0.75, depth, 1), vec4(0.75, -0.75, depth, 1),
    vec4(-0.75, 0.75, depth, 1), ...Array.from({ length: 11 }, () => vec4(0.75, 0.75, depth, 1))] };
}
function texture(images: RendererImageCatalog, name: string, pixels = new Uint8Array([255, 255, 255, 255]),
  sampling: TextureSampling = { wrap: "repeat", filter: "nearest" }): RendererImage {
  return publishTexture(images, { name, width: pixels.length / 4, height: 1, pixels, internalFormat: "rgba8", sampling, registrationUnit: 0 });
}
function pixel(pixels: Uint8Array, x = 16, y = 8): number[] { return [...pixels.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)]; }
function fixture(kind: "cpu" | "gl", action: (backend: RendererBackend, image: RendererImage, target: RenderTarget, read: () => Uint8Array) => void): void {
  const images = new RendererImageCatalog();
  const window = kind === "gl" ? SdlWindow.open({ title: "Retained entity immediate proof", width: 32, height: 32, backend: "gl", stencilBits: 8, hidden: true }) : null;
  let target: RenderTarget | null = null;
  try {
    const backend = window === null ? new SoftwareRenderer(32, 32, images, 8, 8) : new GlRenderer(window, images);
    target = new RenderTarget(images, [backend]);
    if (backend instanceof GlRenderer) backend.initializeDefaultState(backend.capabilities.textureUnits > 1, () => {
      images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST");
    });
    const image = texture(images, "source white" ); texture(images, "binding sentinel");
    backend.beginView({ viewport, clear: { depth: 1, color: gray, stencil: true } });
    action(backend, image, target, backend instanceof SoftwareRenderer ? () => backend.pixels : () => backend.readPixels());
  } finally { target?.close(); window?.close(); }
}

for (const kind of ["cpu", "gl"] satisfies readonly ("cpu" | "gl")[]) {
  describe.skipIf(kind === "gl" && process.env["QUAKE_GL_TEST"] !== "1")(`${kind} retained source entity immediate calls`, () => {
    test("beam sets additive GLS bits, retains back culling, and leaves depth unwritten", () => fixture(kind, (backend, image, _target, read) => {
      installState(backend, image, { ...OPAQUE_STATE, depthTest: "equal", alphaTest: "lt128", depthRange: [0.1, 0.3] });
      backend.drawImmediate(beam(image));
      expect(pixel(read(), 8, 8)).toEqual([255, 64, 64, 255]);
      expect(pixel(read(), 24, 24)).toEqual([255, 64, 64, 255]);
      executeStaticBatch(backend, batch(image, OPAQUE_STATE, green, 0.5));
      expect(pixel(read())).toEqual([0, 255, 0, 255]);
    }));

    test("axis inherits blend, alpha and depth tests instead of installing opaque state", () => fixture(kind, (backend, image, _target, read) => {
      installState(backend, image, { ...OPAQUE_STATE, alphaTest: "lt128" });
      backend.drawImmediate(axis(image));
      expect(pixel(read())).toEqual([64, 64, 64, 255]);
      backend.drawImmediate(beam(image));
      backend.drawImmediate(axis(image));
      expect(pixel(read(), 16, 16)).toEqual([255, 255, 64, 255]);
      expect(pixel(read(), 16, 24)).toEqual([255, 64, 255, 255]);
    }));

    test("view entry restores source default GLS bits while retaining depth range", () => fixture(kind, (backend, image, _target, read) => {
      installState(backend, image, { ...OPAQUE_STATE, blend: { source: "one", destination: "one" }, depthTest: "equal",
        depthWrite: false, alphaTest: "lt128", depthRange: [0.1, 0.3] });
      backend.beginView({ viewport, clear: { depth: 0.4, color: gray, stencil: false } });
      backend.drawImmediate(axis(image));
      expect(pixel(read())).toEqual([255, 0, 0, 255]);
      executeStaticBatch(backend, batch(image, OPAQUE_STATE, green, -0.4));
      expect(pixel(read())).toEqual([255, 0, 0, 255]);
    }));

    test("2D entry disables depth testing and clears inherited alpha/cull state", () => fixture(kind, (backend, image, _target, read) => {
      installState(backend, image, { ...OPAQUE_STATE, depthTest: "equal", alphaTest: "lt128", cull: "front" });
      backend.beginView({ viewport, clear: null });
      backend.drawImmediate(axis(image, 0.8));
      expect(pixel(read())).toEqual([255, 0, 0, 255]);
      expect(pixel(read(), 16, 16)).toEqual([0, 255, 0, 255]);
    }));

    test("entity depth transitions own the queued range and restore it for the next retained call", () => fixture(kind, (backend, image, target, read) => {
      const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
        tess: new SourceTessState(), runtime: createRendererSettings().runtime });
      try {
        const range: [number, number] = [0, 0.3];
        commands.addView({ viewport, clear: { depth: 0.25, color: gray, stencil: false }, operations: [
          { kind: "depth-range", range }, axis(image), { kind: "depth-range", range: [0, 1] },
        ] });
        range[0] = 0.8; range[1] = 0.9;
        commands.submit();
        expect(pixel(read())).toEqual([255, 0, 0, 255]);
        const original = axis(image), p = original.positions;
        backend.drawImmediate({ ...original, positions: [p[2], p[3], p[0], p[1], p[4], p[5]] });
        expect(pixel(read())).toEqual([255, 0, 0, 255]);
      } finally { commands.close("discard"); }
    }));

    test("initial known coordinates sample the actual linear clamp border", () => fixture(kind, (backend, _image, target, read) => {
      const clamped = texture(target.images, "initial clamp white", new Uint8Array([255, 255, 255, 255]), { wrap: "clamp", filter: "linear" });
      texture(target.images, "clamp binding sentinel");
      backend.drawImmediate(axis(clamped));
      expect(pixel(read()).slice(0, 3)).toEqual([64, 0, 0]);
    }));

    test("beam retains front culling while a completed iterator disables its polygon offset", () => fixture(kind, (backend, image, _target, read) => {
      installState(backend, image, { ...OPAQUE_STATE, cull: "front" });
      backend.drawImmediate(beam(image));
      expect(pixel(read())).toEqual([64, 64, 64, 255]);
      backend.beginView({ viewport, clear: { depth: 0.49, color: gray, stencil: false } });
      executeStaticBatch(backend, batch(image, { ...OPAQUE_STATE, depthWrite: false, polygonOffset: { factor: 0, units: -1000000 } }, vec4(0, 0, 1, 1)));
      expect(pixel(read())).toEqual([0, 0, 255, 255]);
      backend.drawImmediate(beam(image));
      expect(pixel(read())).toEqual([0, 0, 255, 255]);
    }));

    test("axis uses width three and restores width one for the next source call", () => fixture(kind, (backend, image, _target, read) => {
      backend.drawImmediate(axis(image));
      expect(pixel(read(), 16, 7)).toEqual([255, 0, 0, 255]);
      expect(pixel(read(), 16, 8)).toEqual([255, 0, 0, 255]);
      expect(pixel(read(), 16, 9)).toEqual([255, 0, 0, 255]);
      expect(pixel(read(), 16, 10)).toEqual([64, 64, 64, 255]);
      if (backend instanceof GlRenderer) {
        const library = loadGl(backend.window), width = new Int32Array(1);
        try { library.symbols.glGetIntegerv(0x0b21, width); expect(width[0]).toBe(1); }
        finally { library.close(); }
      }
    }));

    test("white binding uses the actual current TMU and retains the second texture environment", () => fixture(kind, (backend, image, target, read) => {
      const primary = texture(target.images, "cyan primary", new Uint8Array([0, 255, 255, 255]));
      const ordinary = batch(primary);
      const pair: DrawBatch = { ...ordinary, texturing: "pair", secondTexture: { binding: { kind: "bind-image", image: primary }, environment: "replace" },
        vertices: ordinary.vertices.map(vertex => ({ ...vertex, texCoord2: { x: 0.25, y: 0.25 } })) };
      const prepared = backend.prepareGeometry(pair);
      prepared.begin(); prepared.applyTexture(0, { kind: "bind-image", image: primary }); prepared.applyTexture(1, { kind: "bind-image", image: primary });
      backend.drawImmediate(axis(image));
      expect(pixel(read())).toEqual([255, 255, 255, 255]);
      expect(pixel(read(), 16, 16)).toEqual([255, 255, 255, 255]);
      prepared.draw(); prepared.cleanup();
    }));

    test("raw drawing establishes the actual unit-zero coordinate retained by later immediate calls", () => fixture(kind, (backend, image, target, read) => {
      const colors = new Uint8Array([128, 255, 255, 255, 255, 128, 128, 255]);
      const sampled = texture(target.images, "raw current coordinate", colors);
      texture(target.images, "raw binding sentinel");
      installState(backend, image, OPAQUE_STATE);
      const raw = backend.prepareRawGeometry({ rect: { x: 0, y: 0, width: 32, height: 32 }, uploadWidth: 2, uploadHeight: 1, identityLight: 1 });
      raw.uploadCurrent({ image: sampled, sourceWidth: 2, sourceHeight: 1, uploadWidth: 2, uploadHeight: 1,
        content: new RgbaSnapshot(2, 1, colors), dirty: false }); raw.draw();
      backend.beginView({ viewport, clear: { depth: 1, color: black, stencil: false } });
      backend.drawImmediate(axis(sampled));
      expect(pixel(read())).toEqual([128, 0, 0, 255]);
      expect(pixel(read(), 16, 16)).toEqual([0, 255, 0, 255]);
    }));

    test("creation raw-unbind preserves cached white identity and samples actual incomplete object zero", () => fixture(kind, (backend, image, target, read) => {
      installState(backend, image, OPAQUE_STATE);
      const nonuniform = texture(target.images, "cached white only", new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]));
      backend.drawImmediate(axis(nonuniform));
      expect(pixel(read())).toEqual([255, 0, 0, 255]);
    }));

    test("source shadow decrement state survives into both axis draws and finish", () => fixture(kind, (backend, image, _target, read) => {
      const volume: ImmediateViewOperation = { kind: "shadow-volume", positions: quad(-0.5), indices: quadIndices,
        mirror: false, whiteImage: image };
      backend.drawImmediate(volume); backend.drawImmediate(volume);
      backend.drawImmediate(axis(image, -0.5)); backend.drawImmediate(axis(image, -0.5));
      backend.drawImmediate({ kind: "shadow-finish", positions: quad(-0.75), whiteImage: image });
      expect(pixel(read())).toEqual([255, 0, 0, 255]);
      expect(pixel(read(), 16, 12)).toEqual([38, 38, 38, 255]);
    }));

    test("queued immediate positions are owned and execute under retained viewport before clear", () => fixture(kind, (backend, image, target, read) => {
      const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
        tess: new SourceTessState(), runtime: createRendererSettings().runtime });
      try {
        backend.beginView({ viewport: { x: 0, y: 0, width: 16, height: 32 }, clear: { depth: 1, color: gray, stencil: false } });
        const operation = beam(image), positions = [...operation.positions];
        const beforeView: SurfaceViewOperation[] = [{ ...operation, positions }];
        commands.addView({ viewport: { x: 16, y: 0, width: 16, height: 32 }, clear: { depth: 1, color: black, stencil: false }, beforeView, operations: [] });
        positions.fill(vec4(0, 0, 0, 1)); beforeView.length = 0;
        expect(commands.submit()).toEqual({ commands: 1, views: 1, batches: 0 });
        expect(pixel(read(), 8, 8)).toEqual([255, 64, 64, 255]);
        expect(pixel(read(), 24, 8)).toEqual([0, 0, 0, 255]);
      } finally { commands.close("discard"); }
    }));

    test("sky-box state restores GLS bits and retains physical cull and depth range before immediate consumers", () => fixture(kind, (backend, image, _target, read) => {
      installState(backend, image, { ...OPAQUE_STATE, blend: { source: "one", destination: "one" }, depthTest: "equal",
        alphaTest: "lt128", cull: "front", depthRange: [0.1, 0.3] });
      backend.beginView({ viewport, clear: { depth: 0.4, color: gray, stencil: false } });
      installState(backend, image, { ...OPAQUE_STATE, blend: { source: "one", destination: "one" }, depthTest: "equal",
        alphaTest: "lt128", cull: "front", depthRange: [0.1, 0.3] });
      backend.drawImmediate({ kind: "sky-box-state", identityLight: 0.25 });
      if (backend instanceof GlRenderer) {
        const library = loadGl(backend.window), color = new Int32Array(4);
        try { library.symbols.glGetIntegerv(0xb00, color);
          for (const [channel, value] of color.entries()) expect(value / 0x7fffffff).toBeCloseTo(channel === 3 ? 1 : 0.25, 6); }
        finally { library.close(); }
      }
      backend.drawImmediate(axis(image));
      expect(pixel(read())).toEqual([255, 0, 0, 255]);
      backend.drawImmediate(beam(image));
      expect(pixel(read(), 16, 12)).toEqual([64, 64, 64, 255]);
      executeStaticBatch(backend, batch(image, OPAQUE_STATE, green, -0.4));
      expect(pixel(read())).toEqual([0, 255, 0, 255]);
      backend.drawImmediate({ kind: "depth-range", range: [0.1, 0.3] });
      backend.drawImmediate({ kind: "cull", cull: "back" });
      backend.drawImmediate(beam(image));
      expect(pixel(read(), 16, 12)).toEqual([255, 255, 0, 255]);
    }));

    test("sky-box state enables depth after 2D and polygon-offset operations preserve factors when disabled", () => fixture(kind, (backend, image, _target, read) => {
      backend.beginView({ viewport, clear: { depth: 0.49, color: gray, stencil: false } });
      backend.beginView({ viewport, clear: null });
      backend.drawImmediate({ kind: "sky-box-state", identityLight: 1 });
      backend.drawImmediate(axis(image));
      expect(pixel(read())).toEqual([64, 64, 64, 255]);
      backend.drawImmediate({ kind: "cull", cull: "back" });
      backend.drawImmediate({ kind: "polygon-offset", value: { factor: 2, units: -1000000 } });
      backend.drawImmediate({ kind: "sky-box-state", identityLight: 1 });
      backend.drawImmediate(beam(image));
      expect(pixel(read(), 16, 12)).toEqual([255, 64, 64, 255]);
      backend.drawImmediate({ kind: "polygon-offset", value: null });
      if (backend instanceof GlRenderer) {
        const library = loadGl(backend.window), value = new Int32Array(1);
        try { expect(library.symbols.glIsEnabled(0x8037)).toBe(0);
          library.symbols.glGetIntegerv(0x8038, value); expect(value[0]).toBe(2);
          library.symbols.glGetIntegerv(0x2a00, value); expect(value[0]).toBe(-1000000); }
        finally { library.close(); }
      }
      backend.beginView({ viewport, clear: { depth: 0.49, color: gray, stencil: false } });
      backend.drawImmediate(beam(image));
      expect(pixel(read(), 16, 12)).toEqual([64, 64, 64, 255]);
    }));

    test("invalid physical state is rejected before the retained backend changes", () => fixture(kind, (backend, image, _target, read) => {
      installState(backend, image, { ...OPAQUE_STATE, alphaTest: "lt128" });
      const cull: ImmediateViewOperation = { kind: "cull", cull: "none" }; Reflect.set(cull, "cull", "invalid");
      const sparse: [number, number] = [0, 1]; Reflect.deleteProperty(sparse, 0);
      expect(() => backend.drawImmediate(cull)).toThrow("cull face");
      expect(() => backend.drawImmediate({ kind: "sky-box-state", identityLight: Infinity })).toThrow("identity light");
      expect(() => backend.drawImmediate({ kind: "polygon-offset", value: { factor: 0, units: Number.MAX_VALUE } })).toThrow("finite float32");
      expect(() => backend.drawImmediate({ kind: "depth-range", range: sparse })).toThrow("finite endpoints");
      backend.drawImmediate(axis(image));
      expect(pixel(read())).toEqual([64, 64, 64, 255]);
    }));

    test("retained sky state executes before a new viewport clear and synchronous immediate calls", () => fixture(kind, (backend, image, target, read) => {
      const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
        tess: new SourceTessState(), runtime: createRendererSettings().runtime });
      try {
        backend.beginView({ viewport: { x: 0, y: 0, width: 16, height: 32 }, clear: { depth: 0.25, color: gray, stencil: false } });
        const range: [number, number] = [0, 0];
        const beforeView: SurfaceViewOperation[] = [{ kind: "cull", cull: "back" }, { kind: "depth-range", range },
          { kind: "sky-box-state", identityLight: 1 }, axis(image), { kind: "depth-range", range: [0, 1] }];
        commands.addView({ viewport: { x: 16, y: 0, width: 16, height: 32 }, clear: { depth: 0.25, color: gray, stencil: false }, beforeView, operations: [] });
        range[0] = 1; range[1] = 1; beforeView.length = 0;
        expect(commands.submit()).toEqual({ commands: 1, views: 1, batches: 0 });
        expect(pixel(read(), 8, 8)).toEqual([255, 0, 0, 255]);
        target.executeSurfaceOperations([axis(image)]);
        expect(pixel(read(), 24, 8)).toEqual([64, 64, 64, 255]);
        target.executeSurfaceOperations([{ kind: "depth-range", range: [0, 0] }, { kind: "sky-box-state", identityLight: 1 }, axis(image)]);
        expect(pixel(read(), 24, 8)).toEqual([255, 0, 0, 255]);
      } finally { commands.close("discard"); }
    }));

    test("zero-vertex paired source stages bind and upload, clean both units, and preserve current coordinates", () => fixture(kind, (backend, _image, target, read) => {
      const primaryPixels = new Uint8Array([128, 255, 255, 255, 255, 128, 128, 255]);
      const primary = texture(target.images, "empty primary", primaryPixels);
      const secondary = texture(target.images, "empty secondary", new Uint8Array([0, 255, 255, 255]));
      texture(target.images, "empty source sentinel");
      const events: string[] = [];
      const source = { image: primary, prepareAtExecution: () => {
        events.push("sample"); return { upload: { image: primary, sourceWidth: 2, sourceHeight: 1, uploadWidth: 2, uploadHeight: 1,
          dirty: true, content: new RgbaSnapshot(2, 1, primaryPixels) }, afterShaderUpload: () => { events.push("uploaded"); return undefined; } };
      } };
      const empty: DrawBatch = { texturing: "pair", primitive: "triangles", vertices: [], indices: [],
        state: { ...OPAQUE_STATE, polygonOffset: { factor: 2, units: 7 } }, texture: { kind: "shader-cinematic", source },
        secondTexture: { binding: { kind: "bind-image", image: secondary }, environment: "replace" } };
      const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
        tess: new SourceTessState(), runtime: createRendererSettings().runtime });
      try {
        target.executeSurfaceOperations([{ kind: "source-stage", stage: { kind: "generic-pair", stateBits: SourceStateBit.DEFAULT, batch: empty, scratch: [] } }]);
        expect(events).toEqual(["sample", "uploaded"]);
        expect(pixel(read())).toEqual([64, 64, 64, 255]);
        if (backend instanceof GlRenderer) {
          const library = loadGl(backend.window), value = new Int32Array(1);
          try { library.symbols.glGetIntegerv(0x84e0, value); expect(value[0]).toBe(0x84c0);
            library.symbols.glGetIntegerv(0x84e1, value); expect(value[0]).toBe(0x84c0);
            expect(library.symbols.glIsEnabled(0x8037)).toBe(0);
            library.symbols.glActiveTexture(0x84c1); expect(library.symbols.glIsEnabled(0xde1)).toBe(0);
            library.symbols.glActiveTexture(0x84c0); expect(library.symbols.glGetError()).toBe(0); }
          finally { library.close(); }
        }
        backend.drawImmediate(axis(primary));
        expect(pixel(read())).toEqual([128, 0, 0, 255]);
        expect(pixel(read(), 16, 16)).toEqual([0, 255, 0, 255]);
        expect(events).toEqual(["sample", "uploaded"]);
      } finally { commands.close("discard"); }
    }));
  });
}

test("CPU refuses an indeterminate coordinate-dependent read, but uniform clamp border equality proves a sample", () => fixture("cpu", (backend, image, target, read) => {
  const nonuniform = texture(target.images, "source-indeterminate", new Uint8Array([128, 255, 255, 255, 255, 128, 128, 255]));
  texture(target.images, "indeterminate binding sentinel");
  installState(backend, nonuniform, OPAQUE_STATE);
  expect(() => backend.drawImmediate(axis(nonuniform))).toThrow("source-indeterminate coordinates and coordinate-dependent texels");
  const clamped = texture(target.images, "uniform clamp", new Uint8Array([255, 255, 255, 255]), { wrap: "clamp", filter: "linear" });
  installState(backend, image, OPAQUE_STATE);
  expect(() => backend.drawImmediate(axis(clamped))).toThrow("source-indeterminate coordinates and coordinate-dependent texels");
  backend.applyImageResource({ kind: "current-border-color", color: white });
  backend.drawImmediate(axis(clamped));
  expect(pixel(read())).toEqual([255, 0, 0, 255]);
}));

test("immediate vertex counts and source-finite positions are checked before state mutation", () => fixture("cpu", (backend, image) => {
  expect(() => backend.drawImmediate({ ...beam(image), positions: [] })).toThrow("fourteen");
  expect(() => backend.drawImmediate({ ...beam(image), positions: beam(image).positions.map(position => ({ ...position, x: Infinity })) })).toThrow("finite float32");
  expect(() => backend.drawImmediate({ kind: "depth-range", range: [0, Infinity] })).toThrow("two finite endpoints");
  expect(() => validateRenderView({ viewport, clear: { depth: 1, color: black, stencil: false }, beforeView: [axis(image), beam(image)], operations: [] })).not.toThrow();
}));

test("CPU uniform classification follows successful uploads to the actual bound object", () => fixture("cpu", (backend, _image, target) => {
  const image = texture(target.images, "uniform before upload", new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255]));
  texture(target.images, "upload binding sentinel");
  installState(backend, image, OPAQUE_STATE);
  backend.drawImmediate(axis(image));
  const raw = backend.prepareRawGeometry({ rect: { x: 0, y: 0, width: 32, height: 32 }, uploadWidth: 2, uploadHeight: 1, identityLight: 1 });
  raw.uploadCurrent({ image, sourceWidth: 2, sourceHeight: 1, uploadWidth: 2, uploadHeight: 1,
    content: new RgbaSnapshot(2, 1, new Uint8Array([128, 255, 255, 255, 255, 128, 128, 255])), dirty: true });
  expect(() => backend.drawImmediate(axis(image))).toThrow("source-indeterminate coordinates and coordinate-dependent texels");
}));

test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("one actual CPU/GL target executes the retained immediate sequence with equal pixels", () => {
  const images = new RendererImageCatalog(), window = SdlWindow.open({ title: "Paired retained immediate proof", width: 32, height: 32, backend: "gl", stencilBits: 8, hidden: true });
  let target: RenderTarget | null = null;
  let commands: RenderCommandBuffer | null = null;
  try {
    const gl = new GlRenderer(window, images), cpu = new SoftwareRenderer(32, 32, images, gl.subpixelBits, gl.stencilBits);
    target = new RenderTarget(images, [cpu, gl]);
    gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => {
      images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST");
    });
    const image = texture(images, "paired source white"); texture(images, "paired sentinel");
    commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
      tess: new SourceTessState(), runtime: createRendererSettings().runtime });
    commands.addView({ viewport, clear: { depth: 1, color: gray, stencil: true }, clipPlane: vec4(1, 0, 0, 0),
      operations: [beam(image), axis(image)] });
    commands.submit();
    expect(cpu.pixels).toEqual(gl.readPixels());
    expect(pixel(cpu.pixels, 8, 8)).toEqual([64, 64, 64, 255]);
    expect(pixel(cpu.pixels, 20, 16)).toEqual([255, 255, 64, 255]);
  } finally { commands?.close("discard"); target?.close(); window.close(); }
});
