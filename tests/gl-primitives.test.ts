// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { loadGl } from "../src/platform/gl.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererImageCatalog, RgbaSnapshot } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import { SourceStateBit } from "../src/render/source-state.ts";
import type { SourceGeometryAllocation, SourceStageData, SourceStageCell } from "../src/render/types.ts";

type SingleStage = Extract<SourceStageData, { kind: "generic-single" | "vertex-lit" | "dlight" | "fog" }>;
type PairStage = Extract<SourceStageData, { kind: "generic-pair" | "lightmapped-pair" }>;
const white = { x: 1, y: 1, z: 1, w: 1 };
const viewport = { x: 0, y: 0, width: 16, height: 16 };
function fixture() {
  const window = SdlWindow.open({ title: "Source GL primitives", width: 16, height: 16, backend: "gl", hidden: true });
  const images = new RendererImageCatalog(), renderer = new GlRenderer(window, images), session = images.openSession();
  renderer.initializeDefaultState(renderer.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  session.attach(renderer); session.beginExecution();
  const native = loadGl(window), gl = native.symbols;
  const image = (name: string, pixels: Uint8Array) => images.create({ name, sourceWidth: pixels.length / 4, sourceHeight: 1,
    levels: [{ width: pixels.length / 4, height: 1, pixels }], mipmap: false, internalFormat: "rgba8",
    sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  const solid = image("white", new Uint8Array([255, 255, 255, 255]));
  const stripes = image("red-green", new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]));
  image("sentinel", new Uint8Array([0, 0, 0, 255]));
  const integer = (name: number): number => {
    const value = new Int32Array(1); gl.glGetIntegerv(name, value);
    const result = value[0]; if (result === undefined) throw new Error("Missing GL integer"); return result;
  };
  const current = (name: number): number[] => { const value = new Float32Array(4); gl.glGetFloatv(name, value); return [...value]; };
  const uv = (unit: 0 | 1): number[] => {
    const active = integer(0x84e0); gl.glActiveTexture(0x84c0 + unit);
    const value = current(0xb03); gl.glActiveTexture(active); return value;
  };
  const secondary = () => {
    const active = integer(0x84e0), client = integer(0x84e1);
    gl.glActiveTexture(0x84c1); gl.glClientActiveTexture(0x84c1);
    const result = { texture: gl.glIsEnabled(0xde1), array: gl.glIsEnabled(0x8078) };
    gl.glActiveTexture(active); gl.glClientActiveTexture(client); return result;
  };
  const clear = () => renderer.beginView({ viewport, clear: { stencil: false, depth: 1, color: { x: 0, y: 0, z: 0, w: 1 } } });
  clear();
  renderer.drawImmediate({ kind: "cull", cull: "none" });
  return { renderer, images, gl, solid, stripes, integer, current, uv, secondary, clear,
    pixel: () => [...renderer.readPixels().slice((8 * 16 + 8) * 4, (8 * 16 + 9) * 4)],
    close: () => { session.close(); native.close(); renderer.close(); window.close(); } };
}
function single(image: RendererImage, kind: SingleStage["kind"] = "generic-single", indices: readonly number[] = [0, 1, 2, 2, 1, 3]): SingleStage {
  const vertices = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y]) => {
    if (x === undefined || y === undefined) throw new Error("Missing fixture vertex");
    return { position: { x, y, z: 0, w: 1 }, color: { ...white }, texCoord: { x: 0.25, y: 0.5 } };
  });
  return { kind, stateBits: SourceStateBit.DEPTHTEST_DISABLE, batch: { texturing: "single", primitive: "triangles", texture: { kind: "bind-image", image },
    vertices, indices, state: { ...OPAQUE_STATE, cull: "none", depthTest: "always", depthWrite: false } },
    scratch: vertices.map(vertex => ({ color: { ...vertex.color }, texCoord: { ...vertex.texCoord }, texCoord2: { x: 0.875, y: 0.625 },
      rawTexCoord: { ...vertex.texCoord }, rawTexCoord2: { x: 0.125, y: 0.75 } })) };
}
function pair(first: RendererImage, second: RendererImage, kind: PairStage["kind"] = "generic-pair"): PairStage {
  const initial = single(first);
  return { kind, stateBits: initial.stateBits, batch: { ...initial.batch, texturing: "pair",
    vertices: initial.batch.vertices.map(vertex => ({ ...vertex, texCoord2: { x: 0.125, y: 0.75 } })),
    secondTexture: { binding: { kind: "bind-image", image: second }, environment: "modulate" } }, scratch: initial.scratch };
}
function prepared(f: ReturnType<typeof fixture>, stage: SourceStageData, allocation: SourceGeometryAllocation = { kind: "standalone" }) {
  if (allocation.kind === "tess") f.renderer.drawImmediate({ kind: "begin-source-arrays",
    positions: stage.batch.vertices.map(vertex => vertex.position), slots: allocation.slots, vertexCount: allocation.vertexCount });
  if (stage.kind === "generic-single" || stage.kind === "generic-pair")
    f.renderer.drawImmediate({ kind: "begin-generic-iterator", setArraysOnce: stage.kind === "generic-single", scratch: stage.scratch });
  const result = f.renderer.prepareSourceGeometry(stage, allocation); result.begin();
  result.prepareTexture(0);
  const first = stage.batch.texture;
  if (first.kind !== "bind-image") throw new Error("Fixture requires an image");
  result.applyTexture(0, first);
  if (stage.batch.texturing === "pair") {
    result.prepareTexture(1);
    const second = stage.batch.secondTexture.binding;
    if (second.kind !== "bind-image") throw new Error("Fixture requires a second image");
    result.applyTexture(1, second);
  }
  result.finishTextures();
  return result;
}
function draw(f: ReturnType<typeof fixture>, stage: SourceStageData, mode: number): void {
  const result = prepared(f, stage); result.draw(mode); result.cleanup();
}

describe.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("actual source r_primitives GL execution", () => {
  test("source preparation preserves grouped scratch getter reads and later capture reads", () => {
    const f = fixture();
    try {
      const initial = single(f.solid), vertex = initial.batch.vertices[0];
      if (vertex === undefined) throw new Error("Missing fixture vertex");
      const reads: string[] = []; let invalid = "", failure = "";
      const read = (name: string, value: number): number => {
        reads.push(name);
        if (name === failure) throw new Error(`getter ${name}`);
        return name === invalid ? NaN : value;
      };
      const cell: SourceStageCell = {
        get color() { reads.push("color"); return { get x() { return read("cx", 1); }, get y() { return read("cy", 1); },
          get z() { return read("cz", 1); }, get w() { return read("cw", 1); } }; },
        get texCoord() { reads.push("uv0"); return { get x() { return read("s0", 0.25); }, get y() { return read("t0", 0.5); } }; },
        get texCoord2() { reads.push("uv1"); return { get x() { return read("s1", 0.875); }, get y() { return read("t1", 0.625); } }; },
        get rawTexCoord() { reads.push("raw0"); return { get x() { return read("rs0", Infinity); }, get y() { return read("rt0", NaN); } }; },
        get rawTexCoord2() { reads.push("raw1"); return { get x() { return read("rs1", -Infinity); }, get y() { return read("rt1", Number.MAX_VALUE); } }; },
      };
      const stage: SingleStage = { ...initial, batch: { ...initial.batch, vertices: [vertex], indices: [] }, scratch: [cell] };
      const colors = ["color", "cx", "color", "cy", "color", "cz", "color", "cw"];
      const coordinates = ["uv0", "s0", "uv0", "t0", "uv1", "s1", "uv1", "t1"];
      expect(() => f.renderer.prepareSourceGeometry(stage)).not.toThrow();
      expect(reads).toEqual([...colors, ...coordinates, ...coordinates,
        "raw0", "rs0", "raw0", "rt0", "raw1", "rs1", "raw1", "rt1", ...colors, "uv0", "s0", "t0"]);
      for (const check of [
        { invalid: "cx", failure: "cw", message: "getter cw", reads: colors },
        { invalid: "cx", failure: "s0", message: "Source stage colors must be normalized bytes", reads: colors },
        { invalid: "s0", failure: "t1", message: "getter t1", reads: [...colors, ...coordinates] },
        { invalid: "s0", failure: "rs0", message: "Source stage coordinates must be finite float32 values", reads: [...colors, ...coordinates] },
      ]) {
        reads.length = 0; invalid = check.invalid; failure = check.failure;
        expect(() => f.renderer.prepareSourceGeometry(stage)).toThrow(check.message);
        expect(reads).toEqual(check.reads);
      }
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("source preparation validates every normalized color and rounded float32 coordinate", () => {
    const f = fixture();
    try {
      const initial = single(f.solid), vertex = initial.batch.vertices[0];
      if (vertex === undefined) throw new Error("Missing fixture vertex");
      const color = { x: -0, y: 0, z: 1 / 255, w: 1 }, texCoord = { x: -0, y: 1e-50 }, texCoord2 = { x: 3.4028234663852886e38, y: -3.4028234663852886e38 };
      const cell = { color, texCoord, texCoord2, rawTexCoord: { x: Infinity, y: NaN }, rawTexCoord2: { x: -Infinity, y: Number.MAX_VALUE } };
      const stage: SingleStage = { ...initial, batch: { ...initial.batch, vertices: [vertex], indices: [] }, scratch: [cell] };
      expect(() => f.renderer.prepareSourceGeometry(stage)).not.toThrow();
      for (const axis of ["x", "y", "z", "w"] satisfies readonly (keyof typeof color)[]) {
        const original = color[axis];
        for (const value of [NaN, Infinity, -Infinity, -Number.MIN_VALUE, 1 + Number.EPSILON]) {
          color[axis] = value;
          expect(() => f.renderer.prepareSourceGeometry(stage)).toThrow("Source stage colors must be normalized bytes");
        }
        color[axis] = original;
      }
      for (const coordinate of [texCoord, texCoord2]) for (const axis of ["x", "y"] satisfies readonly (keyof typeof texCoord)[]) {
        const original = coordinate[axis];
        for (const value of [NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE]) {
          coordinate[axis] = value;
          expect(() => f.renderer.prepareSourceGeometry(stage)).toThrow("Source stage coordinates must be finite float32 values");
        }
        coordinate[axis] = original;
      }
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("extension prints precede live later gates and a retained GL context never rereads them", () => {
    const f = fixture();
    let restarted: GlRenderer | null = null;
    try {
      const printed: string[] = []; let envAdd = false;
      f.renderer.initializeExtensions({ allow: true, compressedTextures: false, compiledVertexArrays: true, multitexture: true,
        get textureEnvAdd() { return envAdd; },
        print(text) { printed.push(text); if (text.includes("GL_S3_s3tc")) envAdd = true; } });
      expect(printed).toEqual(["Initializing OpenGL extensions\n", "...ignoring GL_S3_s3tc\n",
        "...using GL_EXT_texture_env_add\n", "...using GL_ARB_multitexture\n", "...using GL_EXT_compiled_vertex_array\n"]);
      const retained = f.renderer.textureExtensions;
      f.renderer.close();
      restarted = new GlRenderer(f.renderer.window, new RendererImageCatalog());
      restarted.initializeExtensions({ get allow(): boolean { throw new Error("Retained context reread r_allowExtensions"); },
        compressedTextures: false, compiledVertexArrays: false, textureEnvAdd: false, multitexture: false,
        print() { throw new Error("Retained context repeated extension initialization"); } });
      expect(restarted.compiledVertexArrays).toBe(true);
      expect(restarted.textureExtensions).toEqual(retained);
    } finally { restarted?.close(); f.close(); }
  });

  test("compiled arrays retain sparse source vertex slots through the complete iterator", () => {
    const f = fixture();
    try {
      f.renderer.initializeExtensions({ allow: true, compiledVertexArrays: true, compressedTextures: false,
        textureEnvAdd: false, multitexture: true, print() {} });
      expect(f.renderer.compiledVertexArrays).toBe(true);
      const stage = single(f.stripes), slots = [1, 3, 4, 6], vertexCount = 8;
      f.renderer.drawImmediate({ kind: "begin-source-arrays", positions: stage.batch.vertices.map(vertex => vertex.position), slots, vertexCount });
      f.renderer.drawImmediate({ kind: "begin-generic-iterator", setArraysOnce: false, scratch: stage.scratch });
      expect(f.integer(0x81a9)).toBe(vertexCount);
      for (const pass of [stage, single(f.solid, "fog")]) {
        const prepared = f.renderer.prepareSourceGeometry(pass, { kind: "tess", slots, vertexCount });
        prepared.begin(); prepared.prepareTexture(0);
        const binding = pass.batch.texture;
        if (binding.kind !== "bind-image") throw new Error("Expected source fixture image");
        prepared.applyTexture(0, binding); prepared.finishTextures(); prepared.draw(0); prepared.cleanup();
        expect(f.integer(0x81a9)).toBe(vertexCount);
      }
      expect(f.pixel()).toEqual([255, 255, 255, 255]);
      f.renderer.drawImmediate({ kind: "end-source-arrays" });
      expect(f.integer(0x81a9)).toBe(0);
      const positionError = new Error("Source position w getter failed");
      const invalidPosition = { x: Infinity, y: 0, z: 0, get w(): number { throw positionError; } };
      expect(() => f.renderer.drawImmediate({ kind: "begin-source-arrays", positions: [invalidPosition],
        slots: [0], vertexCount: 1 })).toThrow(positionError);
      expect(() => f.renderer.drawImmediate({ kind: "begin-source-arrays", positions: [{ x: Infinity, y: 0, z: 0, w: 1 }],
        slots: [0], vertexCount: 1 })).toThrow(new RangeError("Invalid indexed source iterator position"));
      const debug = f.renderer.prepareDebugTris({ whiteImage: f.solid, positions: stage.batch.vertices.map(vertex => vertex.position),
        indices: stage.batch.indices, scratch: stage.scratch, allocation: { kind: "tess", slots, vertexCount } });
      debug.begin(); expect(f.integer(0x81a9)).toBe(vertexCount);
      debug.draw(0); expect(f.integer(0x81a9)).toBe(vertexCount);
      debug.cleanup(); expect(f.integer(0x81a9)).toBe(0);
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });
  test("optimized source iterators lock at their distinct texture phases and retain the lock through fog", () => {
    const f = fixture();
    try {
      f.renderer.initializeExtensions({ allow: true, compiledVertexArrays: true, compressedTextures: false,
        textureEnvAdd: false, multitexture: true, print() {} });
      const slots = [1, 3, 4, 6], vertexCount = 8;
      for (const stage of [single(f.stripes, "vertex-lit"), pair(f.stripes, f.solid, "lightmapped-pair")]) {
        f.clear();
        f.renderer.drawImmediate({ kind: "begin-source-arrays", positions: stage.batch.vertices.map(vertex => vertex.position), slots, vertexCount });
        const draw = f.renderer.prepareSourceGeometry(stage, { kind: "tess", slots, vertexCount });
        draw.begin(); expect(f.integer(0x81a9)).toBe(0);
        draw.prepareTexture(0);
        expect(f.integer(0x81a9)).toBe(stage.kind === "vertex-lit" ? vertexCount : 0);
        const first = stage.batch.texture;
        if (first.kind !== "bind-image") throw new Error("Expected source fixture image");
        draw.applyTexture(0, first);
        if (stage.batch.texturing === "pair") {
          draw.prepareTexture(1);
          const second = stage.batch.secondTexture.binding;
          if (second.kind !== "bind-image") throw new Error("Expected second source fixture image");
          draw.applyTexture(1, second); expect(f.integer(0x81a9)).toBe(0);
        }
        draw.finishTextures(); expect(f.integer(0x81a9)).toBe(vertexCount);
        draw.draw(0); draw.cleanup(); expect(f.integer(0x81a9)).toBe(vertexCount);
        expect(f.pixel()).toEqual([255, 0, 0, 255]);
        const fog = f.renderer.prepareSourceGeometry(single(f.solid, "fog"), { kind: "tess", slots, vertexCount });
        fog.begin(); fog.prepareTexture(0); fog.applyTexture(0, { kind: "bind-image", image: f.solid });
        fog.finishTextures(); fog.draw(0); fog.cleanup(); expect(f.integer(0x81a9)).toBe(vertexCount);
        expect(f.pixel()).toEqual([255, 255, 255, 255]);
        f.renderer.drawImmediate({ kind: "end-source-arrays" }); expect(f.integer(0x81a9)).toBe(0);
      }
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });
  test("default array strips, explicit strips, and indexed triangles render continuation and broken strips", () => {
    const f = fixture();
    try {
      for (const indices of [[0, 1, 2, 2, 1, 3], [0, 1, 2, 1, 3, 2]]) for (const mode of [0, 1, 2]) {
        f.clear(); draw(f, single(f.stripes, "generic-single", indices), mode);
        expect(f.pixel()).toEqual([255, 0, 0, 255]);
        if (mode !== 2) expect(f.uv(0)).toEqual([0.25, 0.5, 0, 1]);
      }
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("array and discrete strips submit the final degenerate element's attributes without covering pixels", () => {
    const f = fixture();
    try {
      const initial = single(f.solid, "dlight", [3, 3, 3]);
      const vertices = initial.batch.vertices.map(vertex => ({ ...vertex, color: { x: 51 / 255, y: 102 / 255, z: 153 / 255, w: 204 / 255 } }));
      const scratch = initial.scratch.map(cell => ({ ...cell, color: { x: 17 / 255, y: 34 / 255, z: 68 / 255, w: 136 / 255 }, texCoord: { x: 0.75, y: 0.25 } }));
      const stage: SingleStage = { ...initial, batch: { ...initial.batch, vertices }, scratch };
      for (const mode of [0, 1, 3]) {
        draw(f, stage, mode); expect(f.pixel()).toEqual([0, 0, 0, 255]);
        expect(f.current(0xb00).map(value => Math.round(value * 255))).toEqual(mode === 3 ? [17, 34, 68, 136] : [51, 102, 153, 204]);
        expect(f.uv(0)).toEqual(mode === 3 ? [0.75, 0.25, 0, 1] : [0.25, 0.5, 0, 1]);
      }
      expect(f.current(0xb02).slice(0, 3)).toEqual([0, 0, 1]); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("single discrete draws use detached svars rather than vertex-lit or dlight bound arrays", () => {
    const f = fixture();
    try {
      for (const kind of ["generic-single", "vertex-lit", "dlight", "fog"] satisfies readonly SingleStage["kind"][])
      for (const allocation of [{ kind: "standalone" }, { kind: "tess", slots: [0, 1, 2, 3], vertexCount: 4 }] satisfies readonly SourceGeometryAllocation[]) {
        const initial = single(f.stripes, kind);
        const scratch = initial.scratch.map(cell => ({ ...cell, color: { ...white, y: 128 / 255 }, texCoord: { x: 0.75, y: 0.5 } }));
        const stage: SingleStage = { ...initial, scratch };
        const result = prepared(f, stage, allocation);
        for (const cell of scratch) { cell.texCoord.x = 0.25; cell.color.y = 0; }
        result.draw(3); result.cleanup(); expect(f.pixel()).toEqual([0, 128, 0, 255]);
        if (allocation.kind === "tess") f.renderer.drawImmediate({ kind: "end-source-arrays" });
        draw(f, initial, 1); expect(f.pixel()).toEqual([255, 0, 0, 255]);
      }
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("generic pair retains UV1 client state across safe direct drawing and rebinds current single-stage scratch", () => {
    const f = fixture();
    try {
      draw(f, pair(f.solid, f.solid), 1);
      expect(f.secondary()).toEqual({ texture: 0, array: 1 }); expect(f.uv(1)).toEqual([0.125, 0.75, 0, 1]);
      const initial = single(f.stripes), last = initial.batch.vertices[3];
      if (last === undefined) throw new Error("Missing fixture vertex");
      const vertices = [...initial.batch.vertices, last, last];
      const scratch: SourceStageCell[] = vertices.map(vertex => ({ color: vertex.color, texCoord: vertex.texCoord, texCoord2: { x: 0.875, y: 0.625 },
        rawTexCoord: { ...vertex.texCoord }, rawTexCoord2: { x: 0.125, y: 0.75 } }));
      const stage: SingleStage = { ...initial, batch: { ...initial.batch, vertices, indices: [5, 5, 5] }, scratch };
      const direct = f.renderer.prepareGeometry(stage.batch); direct.begin(); direct.applyTexture(0, { kind: "bind-image", image: f.stripes }); direct.draw(); direct.cleanup();
      expect(f.secondary()).toEqual({ texture: 0, array: 1 }); expect(f.uv(1)).toEqual([0.125, 0.75, 0, 1]);
      draw(f, stage, 3); expect(f.uv(1)).toEqual([0.125, 0.75, 0, 1]);
      draw(f, stage, 1); expect(f.uv(1)).toEqual([0.875, 0.625, 0, 1]);
      expect(f.integer(0x84e0)).toBe(0x84c0); expect(f.integer(0x84e1)).toBe(0x84c0); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("lightmapped pair disables UV1 client state and later single draws leave its current value intact", () => {
    const f = fixture();
    try {
      draw(f, pair(f.solid, f.solid, "lightmapped-pair"), 1);
      expect(f.secondary()).toEqual({ texture: 0, array: 0 });
      draw(f, single(f.solid), 1); expect(f.uv(1)).toEqual([0.125, 0.75, 0, 1]);
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("non-drawing values preserve pixels and attributes while uploads and pair cleanup execute", () => {
    const f = fixture();
    try {
      draw(f, single(f.stripes), 1); const before = f.pixel(), uv = f.uv(0), color = f.current(0xb00);
      for (const mode of [-1, 4, 99]) {
        const stage = single(f.solid);
        f.renderer.drawImmediate({ kind: "begin-generic-iterator", setArraysOnce: true, scratch: stage.scratch });
        const result = f.renderer.prepareSourceGeometry(stage); result.begin();
        result.prepareTexture(0);
        result.applyTexture(0, { kind: "cinematic-upload", upload: { image: f.solid, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1,
          dirty: true, content: new RgbaSnapshot(1, 1, new Uint8Array([0, 0, 255, 255])) } });
        result.finishTextures();
        result.draw(mode); result.cleanup();
        const uploaded = new Uint8Array(4); f.gl.glGetTexImage(0xde1, 0, 0x1908, 0x1401, uploaded);
        expect([...uploaded]).toEqual([0, 0, 255, 255]); expect(f.pixel()).toEqual(before);
        expect(f.uv(0)).toEqual(uv); expect(f.current(0xb00)).toEqual(color);
        draw(f, pair(f.solid, f.stripes, "lightmapped-pair"), mode);
        expect(f.secondary()).toEqual({ texture: 0, array: 0 }); expect(f.pixel()).toEqual(before);
      }
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("paired discrete mode rejects the reached undefined targets after binding without issuing invalid GL calls", () => {
    const f = fixture();
    try {
      const result = prepared(f, pair(f.solid, f.stripes));
      expect(f.integer(0x84e0)).toBe(0x84c1); expect(f.integer(0x8069)).toBe(1024 + f.stripes.ordinal);
      expect(() => result.draw(3)).toThrow("undefined source MultiTexCoordARB targets 0 and 1");
      expect(f.gl.glGetError()).toBe(0); expect(f.pixel()).toEqual([0, 0, 0, 255]);
      expect(() => result.cleanup()).toThrow("has not completed");
      draw(f, pair(f.solid, f.stripes, "lightmapped-pair"), 2);
      expect(f.pixel()).toEqual([255, 0, 0, 255]);
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("empty modes retain the selected zero-count profile and avoid empty native pointers", () => {
    const f = fixture();
    try {
      draw(f, single(f.solid), 1); const uv = f.uv(0), color = f.current(0xb00);
      for (const mode of [0, 1, 2, 3, -1]) {
        const initial = single(f.solid), stage: SingleStage = { ...initial, batch: { ...initial.batch, vertices: [], indices: [] }, scratch: [] };
        draw(f, stage, mode); expect(f.uv(0)).toEqual(uv); expect(f.current(0xb00)).toEqual(color);
      }
      const initial = pair(f.solid, f.stripes), stage: PairStage = { ...initial, batch: { ...initial.batch, vertices: [], indices: [] }, scratch: [] };
      draw(f, stage, 3); expect(f.secondary()).toEqual({ texture: 0, array: 1 });
      expect(() => f.renderer.prepareSourceGeometry(single(f.solid, "generic-single", [0, 1]))).toThrow("index count");
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("direct batches and raw cinematic geometry bypass source primitive suppression", () => {
    const f = fixture();
    try {
      const stage = single(f.stripes); draw(f, stage, -1); expect(f.pixel()).toEqual([0, 0, 0, 255]);
      const direct = f.renderer.prepareGeometry(stage.batch); direct.begin(); direct.applyTexture(0, { kind: "bind-image", image: f.stripes }); direct.draw(); direct.cleanup();
      expect(f.pixel()).toEqual([255, 0, 0, 255]);
      const raw = f.renderer.prepareRawGeometry({ rect: { x: 0, y: 0, width: 16, height: 16 }, uploadWidth: 1, uploadHeight: 1, identityLight: 1 });
      raw.uploadCurrent({ image: f.solid, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1, dirty: true,
        content: new RgbaSnapshot(1, 1, new Uint8Array([0, 255, 255, 255])) }); raw.draw();
      expect(f.pixel()).toEqual([0, 255, 255, 255]); expect(f.uv(0)).toEqual([0.5, 0.5, 0, 1]); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });
});
