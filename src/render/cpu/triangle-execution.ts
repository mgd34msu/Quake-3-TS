/*
 * Private row-band scheduling for the TypeScript CPU rasterizer.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { availableParallelism } from "node:os";
import { runTriangleRows } from "./triangle-kernel.ts";
import type { BoundTexture, Framebuffer, Sample, TextureStorage, TriangleSetup } from "./triangle-kernel.ts";

// Provisional dispatch threshold; actual renderer measurements decide admission cost.
const MIN_PARALLEL_PIXELS = 32_768;
const MAX_REGION_PIXELS = 4_194_304;
const MAX_TEXTURE_BYTES = 134_217_728;
const MAX_BATCH_TRIANGLES = 256;
const STARTUP_TIMEOUT_MS = 5_000;
const JOB_TIMEOUT_MS = 2_000;
const CLOSE_TIMEOUT_MS = 100;

export const triangleWorkerState = {
  starting: 0, ready: 1, running: 2, complete: 3, fault: 4, stopped: 5,
};

export interface TriangleWorkerJob {
  readonly kind: "render";
  readonly generation: number;
  readonly setups: readonly TriangleSetup[];
  readonly framebuffer: Framebuffer;
  readonly sampled: Sample;
  readonly firstY: number;
  readonly lastY: number;
}

export type TriangleDrawResult = { readonly kind: "complete" }
  | { readonly kind: "failed"; readonly index: number; readonly error: unknown };

interface DrawRegion {
  readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number;
  readonly width: number; readonly height: number;
}

function drawSerial(setups: readonly TriangleSetup[], destination: Framebuffer, sampled: Sample): TriangleDrawResult {
  let index = 0;
  for (const setup of setups) {
    try { runTriangleRows(setup, destination, sampled); }
    catch (error: unknown) { return { kind: "failed", index, error }; }
    index++;
  }
  return { kind: "complete" };
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype) return false;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get !== undefined || descriptor.set !== undefined) return false;
  }
  return true;
}

function numeric(value: unknown): value is number { return typeof value === "number"; }
function boolean(value: unknown): value is boolean { return typeof value === "boolean"; }
function array(value: unknown): value is readonly unknown[] { return Array.isArray(value); }
function integer(value: unknown): value is number { return numeric(value) && Number.isSafeInteger(value); }
function dimension(value: unknown): value is number { return integer(value) && value > 0 && value <= 0x7fff_ffff; }
function fixedBuffer(value: ArrayBufferLike): boolean {
  return value instanceof ArrayBuffer && (!("resizable" in value) || value.resizable === false);
}

function validBounds(setup: TriangleSetup): boolean {
  return dimension(setup.width) && dimension(setup.height) && integer(setup.minX) && integer(setup.maxX)
    && integer(setup.minY) && integer(setup.maxY) && setup.minX >= 0 && setup.minY >= 0
    && setup.maxX >= setup.minX && setup.maxY >= setup.minY
    && setup.maxX < setup.width && setup.maxY < setup.height;
}

function createJobDecoder(record: (value: unknown) => value is Record<string, unknown>) {
  function sample(value: unknown): value is Sample {
    return record(value) && numeric(value["r"]) && numeric(value["g"]) && numeric(value["b"]) && numeric(value["a"]);
  }
  function vector4(value: unknown): boolean {
    return record(value) && numeric(value["x"]) && numeric(value["y"]) && numeric(value["z"]) && numeric(value["w"]);
  }
  function derivative(value: unknown): boolean {
    return record(value) && numeric(value["uAnchor"]) && numeric(value["vAnchor"])
      && numeric(value["uDx"]) && numeric(value["vDx"]) && numeric(value["qDx"])
      && numeric(value["uDy"]) && numeric(value["vDy"]) && numeric(value["qDy"]);
  }
  function blendFactor(value: unknown): boolean {
    return value === "zero" || value === "one" || value === "src-color" || value === "one-minus-src-color"
      || value === "dst-color" || value === "one-minus-dst-color" || value === "src-alpha" || value === "one-minus-src-alpha"
      || value === "dst-alpha" || value === "one-minus-dst-alpha" || value === "src-alpha-saturate";
  }
  function blendState(value: unknown): boolean {
    if (!record(value)) return false;
    const blend = value["blend"];
    return record(blend) && blendFactor(blend["source"]) && blendFactor(blend["destination"]);
  }
  function internalFormat(value: unknown): boolean {
    return value === "rgb" || value === "rgba" || value === "rgb5" || value === "rgba4"
      || value === "rgb8" || value === "rgba8" || value === "rgb4-s3tc";
  }
  function nativeView(value: ArrayBufferView, prototype: object): boolean {
    const actualPrototype: unknown = Object.getPrototypeOf(value);
    return actualPrototype === prototype
      && Object.getOwnPropertyDescriptor(value, "buffer") === undefined
      && Object.getOwnPropertyDescriptor(value, "byteOffset") === undefined
      && Object.getOwnPropertyDescriptor(value, "byteLength") === undefined
      && Object.getOwnPropertyDescriptor(value, "length") === undefined;
  }
  function textureStorage(value: unknown): value is TextureStorage {
    if (!record(value)) return false;
    const width = value["width"], height = value["height"], pixels = value["pixels"], data = value["data"];
    if (!dimension(width) || !dimension(height) || width * height > MAX_TEXTURE_BYTES / 4
      || !(pixels instanceof Uint8Array) || !nativeView(pixels, Uint8Array.prototype)
      || !(data instanceof DataView) || !nativeView(data, DataView.prototype)) return false;
    return pixels.byteLength === width * height * 4 && data.buffer === pixels.buffer
      && data.byteOffset === pixels.byteOffset && data.byteLength === pixels.byteLength
      && record(value["revision"]) && boolean(value["canonical"])
      && internalFormat(value["internalFormat"]) && boolean(value["hasAlpha"])
      && (value["componentMaximum"] === 15 || value["componentMaximum"] === 31 || value["componentMaximum"] === 255)
      && (value["uniform"] === null || sample(value["uniform"]));
  }
  function boundTexture(value: unknown): value is BoundTexture {
    if (!record(value)) return false;
    if (value["kind"] === "incomplete") return true;
    if (value["kind"] === "constant") return internalFormat(value["internalFormat"]) && sample(value["sample"]);
    if (value["kind"] !== "image" || !internalFormat(value["internalFormat"])
      || (value["wrap"] !== "repeat" && value["wrap"] !== "clamp")
      || !boolean(value["minifyLinear"]) || !boolean(value["magnifyLinear"])
      || (value["mipmapping"] !== "none" && value["mipmapping"] !== "nearest" && value["mipmapping"] !== "linear")
      || !numeric(value["magnificationLimit"]) || !vector4(value["borderColor"])) return false;
    const levels: unknown = value["levels"];
    if (!array(levels) || levels.length === 0) return false;
    let index = 0, width = 0, height = 0, bytes = 0;
    for (const level of levels) {
      if (!textureStorage(level) || level.internalFormat !== value["internalFormat"]) return false;
      if (index > 0 && (level.width !== Math.max(1, Math.floor(width / 2))
        || level.height !== Math.max(1, Math.floor(height / 2)))) return false;
      width = level.width; height = level.height; bytes += level.pixels.byteLength; index++;
    }
    return bytes <= MAX_TEXTURE_BYTES && (value["mipmapping"] === "none" || width === 1 && height === 1);
  }

  const setupSchema: { readonly [Key in keyof TriangleSetup]: (value: unknown) => boolean } = {
    minX: numeric, maxX: numeric, minY: numeric, maxY: numeric, inverseArea: numeric,
    depthNear: numeric, depthFar: numeric,
    edgeAX: numeric, edgeAY: numeric, edgeAC: numeric, edgeBX: numeric, edgeBY: numeric, edgeBC: numeric,
    edgeCX: numeric, edgeCY: numeric, edgeCC: numeric,
    attributeAX: numeric, attributeAY: numeric, attributeAC: numeric,
    attributeBX: numeric, attributeBY: numeric, attributeBC: numeric,
    attributeCX: numeric, attributeCY: numeric, attributeCC: numeric,
    az: numeric, bz: numeric, cz: numeric, polygonDepthOffset: numeric, planeDepth: numeric,
    aiw: numeric, biw: numeric, ciw: numeric, au: numeric, bu: numeric, cu: numeric,
    av: numeric, bv: numeric, cv: numeric, au2: numeric, bu2: numeric, cu2: numeric,
    av2: numeric, bv2: numeric, cv2: numeric, ar: numeric, br: numeric, cr: numeric,
    ag: numeric, bg: numeric, cg: numeric, ab: numeric, bb: numeric, cb: numeric,
    aa: numeric, ba: numeric, ca: numeric,
    edgeAInclusive: boolean, edgeBInclusive: boolean, edgeCInclusive: boolean, white: boolean,
    depthWrite: boolean, stencilEnabled: boolean, colorWrite: boolean, textureConsumed: boolean,
    primaryAlpha: boolean, secondaryAlpha: boolean, constantDepth: boolean,
    width: numeric, height: numeric, state: blendState,
    alphaBits: value => value === 0 || value === 8,
    blending: value => value === "opaque" || value === "alpha" || value === "add" || value === "multiply"
      || value === "dst-color-inverse-dst-alpha" || value === "general",
    depthTest: value => value === "always" || value === "less-equal" || value === "equal",
    alphaTest: value => value === "none" || value === "gt0" || value === "lt128" || value === "ge128",
    secondaryEnvironment: value => value === null || value === "modulate" || value === "add" || value === "replace",
    texture: boundTexture, secondaryTexture: boundTexture, derivative, secondaryDerivative: derivative,
    stencilFunction: value => value === "always" || value === "nonzero",
    stencilCompareMask: numeric, stencilWriteMask: numeric, stencilMaximum: numeric,
    stencilDepthFail: value => value === "keep" || value === "increment" || value === "decrement",
    stencilDepthPass: value => value === "keep" || value === "increment" || value === "decrement",
  };
  const setupValidators = Object.entries(setupSchema);

  function triangleSetup(value: unknown): value is TriangleSetup {
    if (!record(value)) return false;
    for (const [key, validate] of setupValidators) if (!validate(value[key])) return false;
    return true;
  }

  function framebuffer(value: unknown): value is Framebuffer {
    if (!record(value)) return false;
    const pixels = value["pixels"], colorWords = value["colorWords"], depth = value["depth"], stencil = value["stencil"];
    return dimension(value["width"]) && dimension(value["height"])
      && integer(value["originX"]) && integer(value["originY"]) && dimension(value["stride"])
      && pixels instanceof Uint8Array && nativeView(pixels, Uint8Array.prototype)
      && colorWords instanceof Int32Array && nativeView(colorWords, Int32Array.prototype)
      && colorWords.buffer === pixels.buffer && colorWords.byteOffset === pixels.byteOffset && colorWords.byteLength === pixels.byteLength
      && depth instanceof Float64Array && nativeView(depth, Float64Array.prototype) && depth.length === colorWords.length
      && (stencil === null || stencil instanceof Uint32Array && nativeView(stencil, Uint32Array.prototype) && stencil.length === colorWords.length);
  }

  function parseJob(value: unknown): TriangleWorkerJob | null {
    if (!record(value) || value["kind"] !== "render" || !integer(value["generation"])
      || !array(value["setups"]) || !framebuffer(value["framebuffer"])
      || !sample(value["sampled"]) || !integer(value["firstY"]) || !integer(value["lastY"])) return null;
    const frame = value["framebuffer"], firstY = value["firstY"], lastY = value["lastY"];
    const count = frame.stride * (lastY - firstY + 1), setups: TriangleSetup[] = [];
    if (value["setups"].length === 0 || value["setups"].length > MAX_BATCH_TRIANGLES
      || firstY < 0 || lastY >= frame.height || firstY > lastY || frame.originX < 0
      || frame.originX + frame.stride > frame.width || frame.originY !== firstY || frame.colorWords.length !== count
      || count > MAX_REGION_PIXELS || !(frame.pixels.buffer instanceof SharedArrayBuffer)
      || !(frame.depth.buffer instanceof SharedArrayBuffer)
      || frame.pixels.buffer === frame.depth.buffer
      || frame.stencil !== null && (!(frame.stencil.buffer instanceof SharedArrayBuffer)
        || frame.stencil.buffer === frame.pixels.buffer || frame.stencil.buffer === frame.depth.buffer)) return null;
    const storage = new Set<TextureStorage>();
    let bytes = 0;
    for (const setup of value["setups"]) {
      if (!triangleSetup(setup) || !validBounds(setup) || setup.width !== frame.width || setup.height !== frame.height
        || setup.minX < frame.originX || setup.maxX >= frame.originX + frame.stride
        || setup.stencilEnabled && frame.stencil === null) return null;
      for (const texture of [setup.texture, setup.secondaryTexture]) {
        if (texture.kind === "image") for (const level of texture.levels) {
          if (!(level.pixels.buffer instanceof SharedArrayBuffer)) return null;
          if (!storage.has(level)) { storage.add(level); bytes += level.pixels.byteLength; }
        }
      }
      setups.push(setup);
    }
    if (bytes > MAX_TEXTURE_BYTES) return null;
    return { kind: "render", generation: value["generation"], setups, framebuffer: frame,
      sampled: value["sampled"], firstY, lastY };
  }

  return { parseJob, framebuffer, textureStorage };
}

const { parseJob: strictParseJob, framebuffer, textureStorage } = createJobDecoder(record);

export function parseTriangleWorkerJob(value: unknown): TriangleWorkerJob | null {
  return strictParseJob(value);
}

// Only the fixed worker entry consumes this decoder. Native cloning supplies data
// properties; injected preloads or earlier message listeners are outside this path.
export const decodeTriangleWorkerMessage = createJobDecoder((value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype;
}).parseJob;

interface WorkerSlot {
  readonly worker: Worker;
  readonly control: Int32Array<SharedArrayBuffer>;
  readonly sampled: Float64Array<SharedArrayBuffer>;
  frame: Framebuffer | null;
  job: TriangleWorkerJob | null;
}
interface Band {
  readonly slot: WorkerSlot;
  readonly frame: Framebuffer;
  readonly firstY: number;
  readonly lastY: number;
  readonly originalOrdinals: number[];
  lastSample: number;
}

function copyRows(source: Framebuffer, destination: Framebuffer, firstY: number, lastY: number,
  firstX: number, lastX: number): void {
  if (firstX > lastX || firstY > lastY) return;
  const width = lastX - firstX + 1;
  const sourceDepth = new Uint8Array(source.depth.buffer, source.depth.byteOffset, source.depth.byteLength);
  const destinationDepth = new Uint8Array(destination.depth.buffer, destination.depth.byteOffset, destination.depth.byteLength);
  for (let y = firstY; y <= lastY; y++) {
    const from = (y - source.originY) * source.stride + firstX - source.originX;
    const to = (y - destination.originY) * destination.stride + firstX - destination.originX;
    destination.pixels.set(source.pixels.subarray(from * 4, (from + width) * 4), to * 4);
    destinationDepth.set(sourceDepth.subarray(from * 8, (from + width) * 8), to * 8);
    if (source.stencil !== null && destination.stencil !== null)
      destination.stencil.set(source.stencil.subarray(from, from + width), to);
  }
}

function sharedBuffer(previous: ArrayBufferLike | undefined, bytes: number): SharedArrayBuffer {
  return previous instanceof SharedArrayBuffer && previous.byteLength >= bytes ? previous : new SharedArrayBuffer(bytes);
}

function makeFrame(setup: DrawRegion, firstY: number, lastY: number, stencil: boolean, previous: Framebuffer | null): Framebuffer {
  const stride = setup.maxX - setup.minX + 1, count = stride * (lastY - firstY + 1);
  const colors = sharedBuffer(previous?.pixels.buffer, count * 4);
  return { width: setup.width, height: setup.height, originX: setup.minX, originY: firstY, stride,
    pixels: new Uint8Array(colors, 0, count * 4), colorWords: new Int32Array(colors, 0, count),
    depth: new Float64Array(sharedBuffer(previous?.depth.buffer, count * 8), 0, count),
    stencil: stencil ? new Uint32Array(sharedBuffer(previous?.stencil?.buffer, count * 4), 0, count) : null };
}

function publishSample(values: Float64Array, destination: Sample): void {
  const [r, g, b, a] = values;
  if (r === undefined || g === undefined || b === undefined || a === undefined) throw new Error("Missing completed worker sample");
  destination.r = r; destination.g = g; destination.b = b; destination.a = a;
}

export class CpuTriangleExecution {
  private state: "cold" | "starting" | "ready" | "disabled" | "closed" = "cold";
  private readonly slots: WorkerSlot[] = [];
  private startupDeadline = 0;
  private generation = 0;
  private readonly textures = new WeakMap<TextureStorage, { readonly revision: object; readonly storage: TextureStorage }>();

  canCapture(destination: Framebuffer, primary: readonly TextureStorage[], secondary: readonly TextureStorage[]): boolean {
    if (this.state === "disabled" || this.state === "closed" || !framebuffer(destination)
      || destination.originX !== 0 || destination.originY !== 0 || destination.stride !== destination.width
      || destination.colorWords.length !== destination.width * destination.height
      || !fixedBuffer(destination.pixels.buffer) || !fixedBuffer(destination.depth.buffer)
      || destination.pixels.buffer === destination.depth.buffer
      || destination.stencil !== null && (!fixedBuffer(destination.stencil.buffer)
        || destination.stencil.buffer === destination.pixels.buffer || destination.stencil.buffer === destination.depth.buffer)) return false;
    for (const levels of [primary, secondary]) for (const level of levels) {
      if (!level.canonical || !textureStorage(level) || !fixedBuffer(level.pixels.buffer)) return false;
    }
    return true;
  }

  draw(setups: readonly TriangleSetup[], destination: Framebuffer, sampled: Sample): TriangleDrawResult {
    const region = this.admit(setups, destination);
    if (region === null || !this.ready()) return drawSerial(setups, destination, sampled);
    const bands: Band[] = [];
    try {
      const textures = new Map<BoundTexture, BoundTexture>();
      const stable = setups.map(setup => this.stableSetup(setup, textures));
      const height = region.maxY - region.minY + 1;
      this.generation = this.generation === 0x7fff_ffff ? 1 : this.generation + 1;
      for (let index = 0; index < this.slots.length; index++) {
        const slot = this.slots[index];
        if (slot === undefined) throw new Error("Missing CPU worker slot");
        const firstY = region.minY + Math.floor(height * index / this.slots.length);
        const lastY = region.minY + Math.floor(height * (index + 1) / this.slots.length) - 1;
        const frame = makeFrame(region, firstY, lastY, destination.stencil !== null, slot.frame);
        slot.frame = frame;
        copyRows(destination, frame, firstY, lastY, region.minX, region.maxX);
        bands.push({ slot, frame, firstY, lastY, originalOrdinals: [], lastSample: -1 });
      }
      for (const band of bands) {
        const intersecting = stable.filter((setup, ordinal) => {
          if (setup.maxY < band.firstY || setup.minY > band.lastY) return false;
          band.originalOrdinals.push(ordinal);
          return true;
        });
        Atomics.store(band.slot.control, 2, this.generation);
        Atomics.store(band.slot.control, 0, triangleWorkerState.running);
        const job: TriangleWorkerJob = { kind: "render", generation: this.generation, setups: intersecting.length === 0 ? stable : intersecting,
          framebuffer: band.frame, sampled: { ...sampled }, firstY: band.firstY, lastY: band.lastY };
        band.slot.job = job;
        band.slot.worker.postMessage(job);
      }
      const deadline = performance.now() + JOB_TIMEOUT_MS;
      for (const band of bands) {
        let status = Atomics.load(band.slot.control, 0);
        while (status === triangleWorkerState.running && performance.now() < deadline) {
          Atomics.wait(band.slot.control, 0, triangleWorkerState.running, Math.min(10, Math.max(0, deadline - performance.now())));
          status = Atomics.load(band.slot.control, 0);
        }
        const ordinal = Atomics.load(band.slot.control, 1);
        if (status !== triangleWorkerState.complete || Atomics.load(band.slot.control, 2) !== this.generation
          || ordinal < -1 || ordinal >= (band.originalOrdinals.length || setups.length))
          throw new Error("CPU worker did not complete its private band");
        if (ordinal >= 0) {
          const original = band.originalOrdinals.length === 0 ? ordinal : band.originalOrdinals[ordinal];
          if (original === undefined) throw new Error("Missing CPU worker setup ordinal");
          band.lastSample = original;
        }
      }
    } catch {
      this.disable();
      return drawSerial(setups, destination, sampled);
    }
    for (const band of bands) band.slot.job = null;
    let lastSample = -1;
    for (const band of bands) {
      copyRows(band.frame, destination, band.firstY, band.lastY, region.minX, region.maxX);
      const ordinal = band.lastSample;
      if (ordinal >= 0 && ordinal >= lastSample) { publishSample(band.slot.sampled, sampled); lastSample = ordinal; }
    }
    return { kind: "complete" };
  }

  close(): void {
    if (this.state === "closed") return;
    if (this.state !== "disabled") {
      for (const slot of this.slots) {
        try { slot.worker.postMessage("close"); } catch { /* A stopped worker has no more jobs. */ }
      }
      const deadline = performance.now() + CLOSE_TIMEOUT_MS;
      for (const slot of this.slots) {
        while (Atomics.load(slot.control, 0) !== triangleWorkerState.stopped && performance.now() < deadline) {
          const status = Atomics.load(slot.control, 0);
          Atomics.wait(slot.control, 0, status, Math.min(10, Math.max(0, deadline - performance.now())));
        }
        if (Atomics.load(slot.control, 0) !== triangleWorkerState.stopped) slot.worker.terminate();
        else slot.frame = null;
      }
    }
    // Unconfirmed worker buffers remain held by these slots for the service lifetime.
    this.state = "closed";
  }

  private admit(setups: readonly TriangleSetup[], destination: Framebuffer): DrawRegion | null {
    if (setups.length === 0 || setups.length > MAX_BATCH_TRIANGLES || !this.canCapture(destination, [], [])) return null;
    let minX = destination.width, maxX = -1, minY = destination.height, maxY = -1, work = 0, bytes = 0;
    const storage = new Set<TextureStorage>();
    for (const setup of setups) {
      if (!validBounds(setup) || setup.width !== destination.width || setup.height !== destination.height
        || setup.stencilEnabled && destination.stencil === null) return null;
      minX = Math.min(minX, setup.minX); maxX = Math.max(maxX, setup.maxX);
      minY = Math.min(minY, setup.minY); maxY = Math.max(maxY, setup.maxY);
      work += (setup.maxX - setup.minX + 1) * (setup.maxY - setup.minY + 1);
      for (const texture of [setup.texture, setup.secondaryTexture]) {
        if (texture.kind === "image") for (const level of texture.levels) {
          if (storage.has(level)) continue;
          if (!level.canonical || !textureStorage(level) || !fixedBuffer(level.pixels.buffer)) return null;
          storage.add(level); bytes += level.pixels.byteLength;
        }
      }
    }
    const count = (maxX - minX + 1) * (maxY - minY + 1);
    if (work < MIN_PARALLEL_PIXELS || work < count || count > MAX_REGION_PIXELS || maxY - minY < 3 || bytes > MAX_TEXTURE_BYTES) return null;
    return { minX, maxX, minY, maxY, width: destination.width, height: destination.height };
  }

  private ready(): boolean {
    if (this.state === "ready") return true;
    if (this.state === "disabled" || this.state === "closed") return false;
    if (this.state === "cold") {
      const count = Math.min(4, availableParallelism() - 1);
      if (count < 2) { this.state = "disabled"; return false; }
      this.state = "starting";
      this.startupDeadline = performance.now() + STARTUP_TIMEOUT_MS;
      try {
        for (let index = 0; index < count; index++) {
          const worker = new Worker(new URL("./triangle-worker.ts", import.meta.url), { ref: true });
          const control = new Int32Array(new SharedArrayBuffer(3 * 4));
          const sampled = new Float64Array(new SharedArrayBuffer(4 * 8));
          this.slots.push({ worker, control, sampled, frame: null, job: null });
          worker.addEventListener("error", event => { event.preventDefault(); this.disable(); });
          worker.postMessage({ kind: "initialize", control, sampled });
        }
      } catch { this.disable(); }
      return false;
    }
    if (this.slots.every(slot => Atomics.load(slot.control, 0) === triangleWorkerState.ready)) {
      this.state = "ready";
      return true;
    }
    if (performance.now() >= this.startupDeadline || this.slots.some(slot => Atomics.load(slot.control, 0) === triangleWorkerState.fault)) this.disable();
    return false;
  }

  private disable(): void {
    if (this.state === "disabled" || this.state === "closed") return;
    this.state = "disabled";
    for (const slot of this.slots) slot.worker.terminate();
  }

  private stableSetup(setup: TriangleSetup, textures: Map<BoundTexture, BoundTexture>): TriangleSetup {
    for (const texture of [setup.texture, setup.secondaryTexture]) {
      if (!textures.has(texture)) textures.set(texture, this.stableTexture(texture));
    }
    const texture = textures.get(setup.texture), secondaryTexture = textures.get(setup.secondaryTexture);
    if (texture === undefined || secondaryTexture === undefined) throw new Error("Missing stable CPU texture");
    return { ...setup, texture, secondaryTexture };
  }

  private stableTexture(texture: BoundTexture): BoundTexture {
    if (texture.kind !== "image") return texture;
    const levels: TextureStorage[] = [];
    for (const level of texture.levels) {
      const retained = this.textures.get(level);
      if (retained !== undefined && retained.revision === level.revision) {
        levels.push(retained.storage);
      } else {
        const pixels = new Uint8Array(new SharedArrayBuffer(level.pixels.byteLength));
        pixels.set(level.pixels);
        const storage: TextureStorage = { ...level, pixels, data: new DataView(pixels.buffer),
          uniform: level.uniform === null ? null : { ...level.uniform } };
        this.textures.set(level, { revision: level.revision, storage });
        levels.push(storage);
      }
    }
    const first = levels.shift();
    if (first === undefined) throw new Error("Missing CPU texture level");
    return { ...texture, levels: [first, ...levels], borderColor: { ...texture.borderColor } };
  }
}
