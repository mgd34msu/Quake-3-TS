import { expect, test } from "bun:test";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { CpuTriangleExecution, decodeTriangleWorkerMessage, parseTriangleWorkerJob } from "../src/render/cpu/triangle-execution.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { runTriangleRows, runWorkerTriangleRows } from "../src/render/cpu/triangle-kernel.ts";
import type { Framebuffer, TriangleSetup } from "../src/render/cpu/triangle-kernel.ts";
import { sourceStateBits } from "../src/render/source-state.ts";
import type { MultitextureVertex, RenderState, SourceStageData } from "../src/render/types.ts";

function vertex(x: number, y: number, w: number, ordinal: number, size: number, secondaryU = ordinal / 32): MultitextureVertex {
  return { position: { x: (x / (size / 2) - 1) * w, y: (1 - y / (size / 2)) * w, z: 0, w },
    color: { x: (ordinal + 1) / 12, y: 0.5, z: 1, w: 1 },
    texCoord: { x: ordinal / 16, y: 0.5 }, texCoord2: { x: secondaryU, y: 0.25 } };
}

function retained(cpu: SoftwareRenderer): unknown {
  const color: unknown = Reflect.get(cpu, "currentColor");
  const coordinates: unknown = Reflect.get(cpu, "currentTexCoords");
  const sampled: unknown = Reflect.get(cpu, "sampled");
  return structuredClone({ color, coordinates, sampled });
}

function render(execution: CpuTriangleExecution | null, failing: boolean, mode: number, size = 8, prefixTriangles = 1, setupFaultAt = 0, clipped = false, sparse = false) {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(size, size, images, 8, 8, 8, execution);
  const session = images.openSession(); session.attach(cpu); session.beginExecution();
  try {
    const image = images.create({ name: "batch fixture", sourceWidth: 2, sourceHeight: 1,
      levels: [{ width: 2, height: 1, pixels: new Uint8Array([255, 128, 64, 255, 32, 192, 96, 255]) },
        { width: 1, height: 1, pixels: new Uint8Array([144, 160, 80, 255]) }], mipmap: true,
      internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest-mipmap-nearest" }, registrationUnit: 0 });
    const vertices = [vertex(clipped ? -size / 2 : 0, 0, 1, 0, size), vertex(size, 0, 1, 1, size), vertex(size, sparse ? size / 8 : size, 1, 2, size),
      vertex(size / 2, sparse ? size * 7 / 8 : 0, failing ? 1e-300 : 1, 3, size),
      vertex(clipped ? size * 1.5 : size, size - 0.5, failing ? 1e300 : 1, 4, size), vertex(0, size - 0.5, failing ? 1e300 : 1, 5, size),
      vertex(0, size / 8, 1, 6, size, sparse ? 0.75 : undefined), vertex(0, 0, 1, 7, size, sparse ? 0.75 : undefined),
      vertex(size / 8, size / 8, 1, 8, size, sparse ? 0.75 : undefined)];
    const state = { blend: { source: "src-alpha", destination: "one-minus-src-alpha" },
      depthTest: "less-equal", depthWrite: true, alphaTest: "none", cull: "none" } satisfies RenderState;
    const stage: SourceStageData = { kind: "generic-pair", stateBits: sourceStateBits(state),
      batch: { texturing: "pair", primitive: "triangles", vertices,
        indices: [...Array.from({ length: prefixTriangles }, () => sparse ? [3, 4, 5] : [0, 1, 2]).flat(),
          ...sparse ? [0, 1, 2] : [3, 4, 5], 6, 7, 8],
        texture: { kind: "bind-image", image }, secondTexture: { binding: { kind: "bind-image", image }, environment: "modulate" }, state },
      scratch: vertices.map(v => ({ color: v.color, texCoord: v.texCoord, texCoord2: v.texCoord2,
        rawTexCoord: v.texCoord, rawTexCoord2: v.texCoord2 })) };
    cpu.drawImmediate({ kind: "cull", cull: "none" });
    cpu.drawImmediate({ kind: "begin-generic-iterator", setArraysOnce: false, scratch: stage.scratch });
    const prepared = cpu.prepareSourceGeometry(stage);
    prepared.begin(); prepared.prepareTexture(0); prepared.applyTexture(0, { kind: "bind-image", image });
    prepared.prepareTexture(1); prepared.applyTexture(1, { kind: "bind-image", image }); prepared.finishTextures();
    if (setupFaultAt !== 0) {
      const triangle: unknown = Reflect.get(cpu, "triangle");
      if (typeof triangle !== "function") throw new Error("Missing triangle setup boundary");
      let ordinal = 0;
      Reflect.set(cpu, "triangle", (...args: readonly unknown[]): unknown => {
        ordinal++;
        if (ordinal === setupFaultAt) throw new Error("injected setup failure");
        const result: unknown = Reflect.apply(triangle, cpu, args);
        return result;
      });
    }
    let error: unknown = null;
    try { prepared.draw(mode); } catch (cause: unknown) { error = cause instanceof Error ? cause.message : cause; }
    const beforeCleanup = retained(cpu);
    if (error === null) prepared.cleanup();
    else expect(() => prepared.cleanup()).toThrow("has not completed");
    return { error, pixels: cpu.pixels.slice(), depth: Array.from({ length: size * size }, (_, i) => cpu.readDepthPixel(i % size, Math.floor(i / size))),
      beforeCleanup };
  } finally { session.close(); cpu.close(); }
}

test("captured default strips and elements retain exact successful and failing prefixes", () => {
  const execution = new CpuTriangleExecution();
  try {
    for (const mode of [0, 1, 2]) for (const failing of [false, true]) {
      const serial = render(null, failing, mode), captured = render(execution, failing, mode);
      if (failing) expect(serial.error).toBe("Texture LOD is outside its complete mip chain");
      else expect(serial.error).toBeNull();
      expect(captured).toEqual(serial);
    }
  } finally { execution.close(); }
});

test("bounded collection preserves the successful prefix on either side of a chunk boundary", () => {
  const execution = new CpuTriangleExecution();
  try {
    for (const count of [255, 256, 257]) for (const failing of [false, true]) {
      expect(render(execution, failing, 0, 8, count)).toEqual(render(null, failing, 0, 8, count));
    }
  } finally { execution.close(); }
});

test("a later setup failure drains owned pixels and preserves an earlier pixel error", () => {
  const execution = new CpuTriangleExecution();
  try {
    for (const failing of [false, true]) {
      const serial = render(null, failing, 0, 8, 1, 3);
      expect(serial.error).toBe(failing ? "Texture LOD is outside its complete mip chain" : "injected setup failure");
      expect(render(execution, failing, 0, 8, 1, 3)).toEqual(serial);
    }
  } finally { execution.close(); }
});

test("clipped fan children preserve pixels and retained attributes on a later LOD failure", () => {
  const execution = new CpuTriangleExecution();
  try {
    for (const mode of [0, 2]) for (const failing of [false, true]) {
      const serial = render(null, failing, mode, 8, 1, 0, true);
      if (failing) expect(serial.error).toBe("Texture LOD is outside its complete mip chain");
      expect(render(execution, failing, mode, 8, 1, 0, true)).toEqual(serial);
    }
  } finally { execution.close(); }
});

test("actual list workers preserve output and replay complete transactions after pixel or transport faults", async () => {
  const NativeWorker = Worker;
  let jobs = 0, corruptNext = false;
  class ObservedWorker extends NativeWorker {
    override postMessage(message: unknown): void {
      if (typeof message === "object" && message !== null && "kind" in message && message.kind === "render") {
        jobs++;
        if (corruptNext) { corruptNext = false; super.postMessage({ ...message, setups: [] }); return; }
      }
      super.postMessage(message);
    }
  }
  globalThis.Worker = ObservedWorker;
  try {
    for (const fault of ["pixel", "transport"]) {
      const execution = new CpuTriangleExecution();
      try {
        const before = jobs, expected = render(null, false, 0, 192);
        for (let attempt = 0; attempt < 100 && jobs === before; attempt++) {
          expect(render(execution, false, 0, 192)).toEqual(expected);
          if (jobs === before) await Bun.sleep(10);
        }
        expect(jobs).toBeGreaterThan(before);
        const failing = fault === "pixel", baseline = render(null, failing, 0, 192);
        if (failing) expect(baseline.error).toBe("Texture LOD is outside its complete mip chain");
        corruptNext = fault === "transport";
        const dispatched = jobs;
        expect(render(execution, failing, 0, 192)).toEqual(baseline);
        expect(jobs).toBeGreaterThan(dispatched);
        const retired = jobs;
        expect(render(execution, false, 0, 192)).toEqual(expected);
        expect(jobs).toBe(retired);
      } finally { execution.close(); }
    }
  } finally { globalThis.Worker = NativeWorker; }
});

test("worker clone decoding retains value checks while public parsing rejects nested accessors", async () => {
  const NativeWorker = Worker;
  const messages: unknown[] = [];
  class ObservedWorker extends NativeWorker {
    override postMessage(message: unknown): void {
      if (typeof message === "object" && message !== null && "kind" in message && message.kind === "render") messages.push(message);
      super.postMessage(message);
    }
  }
  globalThis.Worker = ObservedWorker;
  const execution = new CpuTriangleExecution();
  try {
    for (let attempt = 0; attempt < 100 && messages.length === 0; attempt++) {
      render(execution, false, 0, 192);
      if (messages.length === 0) await Bun.sleep(10);
    }
    const job = parseTriangleWorkerJob(messages[0]);
    if (job === null) throw new Error("Missing valid worker job");
    const setup = job.setups[0];
    if (setup === undefined) throw new Error("Missing worker setup");
    // Retain shared views; Bun 1.3.14's structuredClone copies them into ArrayBuffers.
    const clone: unknown = { ...job, setups: job.setups.map(value => ({ ...value })),
      sampled: { ...job.sampled }, framebuffer: { ...job.framebuffer } };
    expect(parseTriangleWorkerJob(clone)).not.toBeNull();
    expect(decodeTriangleWorkerMessage(clone)).toEqual(parseTriangleWorkerJob(clone));
    const imageTexture = setup.texture.kind === "image" ? setup.texture : setup.secondaryTexture;
    if (imageTexture.kind !== "image") throw new Error(`Missing worker image texture: ${setup.texture.kind}/${setup.secondaryTexture.kind}`);
    for (const mipmapping of ["nearest", "linear"] satisfies readonly ["nearest", "linear"])
    for (const magnificationLimit of [1, Math.SQRT2])
    for (const rho of [0, .25, .8, 1, Math.SQRT2 * (1 - 2 ** -34), Math.SQRT2,
      Math.SQRT2 * (1 + 2 ** -34), 2.7, 2 ** 1.5, 2 ** 180, 2 ** -180, 2 ** 250, 2 ** -250, Infinity, NaN]) {
      const texture = { ...imageTexture, mipmapping, magnificationLimit,
        minifyLinear: magnificationLimit === 1, magnifyLinear: magnificationLimit === Math.SQRT2 };
      const selected: TriangleSetup = { ...setup, texture, secondaryTexture: texture, secondaryEnvironment: "modulate", textureConsumed: true,
        derivative: { ...setup.derivative, uDx: rho / (2 * Math.SQRT2), vDx: rho / Math.SQRT2, qDx: 0, uDy: 0, vDy: 0, qDy: 0 },
        secondaryDerivative: { ...setup.secondaryDerivative, uDx: 0, vDx: 0, qDx: 0, uDy: rho / (2 * Math.SQRT2), vDy: rho / Math.SQRT2, qDy: 0 } };
      const result = (worker: boolean) => {
        const row = Math.floor((job.firstY + job.lastY) / 2);
        const pixels = job.framebuffer.pixels.slice();
        const framebuffer: Framebuffer = { ...job.framebuffer, pixels,
          colorWords: new Int32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4),
          depth: job.framebuffer.depth.slice(), stencil: job.framebuffer.stencil?.slice() ?? null };
        const sampled = { ...job.sampled };
        let didSample: boolean | null = null, error: string | null = null;
        try {
          didSample = worker ? runWorkerTriangleRows(selected, framebuffer, sampled, row, row)
            : runTriangleRows(selected, framebuffer, sampled, row, row);
        } catch (cause: unknown) {
          if (!(cause instanceof Error)) throw cause;
          error = cause.message;
        }
        return { pixels, depth: new Uint8Array(framebuffer.depth.buffer, framebuffer.depth.byteOffset, framebuffer.depth.byteLength),
          stencil: framebuffer.stencil, sampled, didSample, error };
      };
      const serial = result(false);
      if (Number.isFinite(rho)) expect(serial.didSample).toBe(true);
      expect(result(true)).toEqual(serial);
    }
    for (const invalid of [
      { ...job, generation: NaN }, { ...job, firstY: -1 }, { ...job, lastY: job.framebuffer.height },
      { ...job, setups: [] }, { ...job, setups: [{ ...setup, inverseArea: "invalid" }] },
      { ...job, setups: [{ ...setup, depthTest: "invalid" }] },
      { ...job, setups: [{ ...setup, maxX: setup.width }] },
      { ...job, sampled: { ...job.sampled, r: "invalid" } },
      { ...job, framebuffer: { ...job.framebuffer, stride: 0 } },
      { ...job, framebuffer: { ...job.framebuffer, depth: new Float64Array(job.framebuffer.depth.length) } },
      { ...job, framebuffer: { ...job.framebuffer, colorWords: new Int32Array(job.framebuffer.colorWords.length) } },
    ]) {
      expect(parseTriangleWorkerJob(invalid)).toBeNull();
      expect(decodeTriangleWorkerMessage(invalid)).toBeNull();
    }
    let accessorReads = 0;
    const pending: unknown[] = [job], seen = new Set<object>();
    for (const value of pending) {
      if (typeof value !== "object" || value === null || seen.has(value)) continue;
      seen.add(value);
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && !Array.isArray(value)) continue;
      for (const key of Object.keys(value)) {
        const nested: unknown = Reflect.get(value, key);
        pending.push(nested);
      }
      if (Array.isArray(value)) continue;
      Object.defineProperty(value, "unexpectedAccessor", { configurable: true, get: () => { accessorReads++; return 1; } });
      try { expect(parseTriangleWorkerJob(job)).toBeNull(); }
      finally { Reflect.deleteProperty(value, "unexpectedAccessor"); }
    }
    expect(accessorReads).toBe(0);
    expect(parseTriangleWorkerJob(job)).not.toBeNull();
  } finally { execution.close(); globalThis.Worker = NativeWorker; }
});

test("sparse worker lists preserve original sample order and full jobs for empty bands", async () => {
  const NativeWorker = Worker;
  const messages: unknown[] = [];
  class ObservedWorker extends NativeWorker {
    override postMessage(message: unknown): void {
      if (typeof message === "object" && message !== null && "kind" in message && message.kind === "render") messages.push(message);
      super.postMessage(message);
    }
  }
  globalThis.Worker = ObservedWorker;
  const execution = new CpuTriangleExecution();
  try {
    const expected = render(null, false, 0, 192, 16, 0, false, true);
    for (let attempt = 0; attempt < 100 && messages.length === 0; attempt++) {
      expect(render(execution, false, 0, 192, 16, 0, false, true)).toEqual(expected);
      if (messages.length === 0) await Bun.sleep(10);
    }
    expect(messages.length).toBeGreaterThan(0);
    let emptyBands = 0, filteredBands = 0;
    for (const message of messages) {
      const job = parseTriangleWorkerJob(message);
      if (job === null) throw new Error("Missing valid sparse worker job");
      const intersecting = job.setups.filter(setup => setup.maxY >= job.firstY && setup.minY <= job.lastY);
      if (intersecting.length === 0) {
        emptyBands++;
        expect(job.setups.length).toBe(18);
      } else {
        filteredBands++;
        expect(job.setups).toEqual(intersecting);
        expect(job.setups.length).toBeLessThan(18);
      }
    }
    expect(filteredBands).toBe(2);
    expect(emptyBands).toBe(messages.length - 2);
    const dispatched = messages.length;
    expect(render(execution, false, 0, 192, 16, 0, false, true)).toEqual(expected);
    expect(messages.length).toBeGreaterThan(dispatched);
  } finally { execution.close(); globalThis.Worker = NativeWorker; }
});
