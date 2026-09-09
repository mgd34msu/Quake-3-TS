// R_CreateImage publication and renderer image ownership, id Software tr_image.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { Vec4 } from "../core/math.ts";
import { CommonError } from "../core/common-error.ts";
import type { HunkAllocation } from "../core/hunk.ts";
import { SOURCE_HUNK_RELEASE32 } from "./hunk-accounting.ts";
import type { HunkAccountingProfile } from "./hunk-accounting.ts";
import type { ImageUploadSteps } from "./image-upload.ts";
import type { TextureFilter, TextureImage, TextureSampling } from "./types.ts";

function dimension(value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > 0x7fffffff) throw new RangeError("Image dimensions must be positive int32 values");
}

/** Bytes are copied both into and out of this immutable publication. */
export class RgbaSnapshot {
  readonly #pixels: Uint8Array;

  constructor(readonly width: number, readonly height: number, pixels: Uint8Array) {
    dimension(width); dimension(height);
    const size = width * height * 4;
    if (!Number.isSafeInteger(size) || pixels.length !== size) throw new RangeError("Image RGBA byte count does not match upload dimensions");
    this.#pixels = new Uint8Array(pixels);
    Object.freeze(this);
  }

  copyPixels(): Uint8Array { return new Uint8Array(this.#pixels); }
}

class CatalogImage {
  readonly #owner: RendererImageCatalog;
  #frameUsed = 0;
  #uploadWidth = 0;
  #uploadHeight = 0;
  #internalFormat = 0;

  constructor(owner: RendererImageCatalog, readonly ordinal: number, readonly name: string,
    readonly sourceWidth: number, readonly sourceHeight: number,
    private readonly mipmap: boolean, private readonly wrap: TextureSampling["wrap"], private readonly registrationUnit: 0 | 1,
    private readonly allocation: HunkAllocation | null = null) {
    this.#owner = owner;
    Object.freeze(this);
  }

  belongsTo(catalog: RendererImageCatalog): boolean {
    if (this.allocation !== null) void this.allocation.bytes;
    return this.#owner === catalog;
  }

  private record(): DataView | null {
    if (this.allocation === null) return null;
    const bytes = this.allocation.bytes;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  // release32 image_t stores upload dimensions at 72/76 and frameUsed at 84.
  get frameUsed(): number {
    const record = this.record();
    return record === null ? this.#frameUsed : record.getInt32(84, true);
  }

  get uploadWidth(): number {
    const record = this.record();
    return record === null ? this.#uploadWidth : record.getInt32(72, true);
  }

  get uploadHeight(): number {
    const record = this.record();
    return record === null ? this.#uploadHeight : record.getInt32(76, true);
  }

  get internalFormat(): number { return this.record()?.getInt32(88, true) ?? this.#internalFormat; }
  get mipmapEnabled(): boolean { const record = this.record(); return record === null ? this.mipmap : record.getInt32(96, true) !== 0; }
  get textureUnit(): number { return this.record()?.getInt32(92, true) ?? this.registrationUnit; }
  get wrapMode(): number { return this.record()?.getInt32(104, true) ?? (this.wrap === "repeat" ? 0x2901 : 0x2900); }

  markUsed(frameCount: number): void {
    const record = this.record();
    if (record === null) this.#frameUsed = frameCount;
    else record.setInt32(84, frameCount, true);
  }

  setUploadDimensions(width: number, height: number): void {
    const record = this.record();
    if (record === null) { this.#uploadWidth = width; this.#uploadHeight = height; }
    else { record.setInt32(72, width, true); record.setInt32(76, height, true); }
  }

  setUploadDescriptor(width: number, height: number, format: ImageInternalFormat): void {
    this.setUploadDimensions(width, height);
    const record = this.record();
    const formats: Readonly<Record<ImageInternalFormat, number>> = { rgb: 3, rgba: 4, rgb5: 0x8050, rgba4: 0x8056, rgb8: 0x8051, rgba8: 0x8058, "rgb4-s3tc": 0x83a1 };
    if (record === null) this.#internalFormat = formats[format];
    else record.setInt32(88, formats[format], true);
  }

  resizeCinematic(width: number, height: number): void {
    const record = this.record();
    if (record === null) { this.#uploadWidth = width; this.#uploadHeight = height; }
    else {
      record.setInt32(72, width, true); record.setInt32(64, width, true);
      record.setInt32(76, height, true); record.setInt32(68, height, true);
    }
  }
}

/** Only this module can construct the nominal identity of a catalog creation. */
export type RendererImage = CatalogImage;

export type ImageInternalFormat = "rgb" | "rgba" | "rgb5" | "rgba4" | "rgb8" | "rgba8" | "rgb4-s3tc";
const imageListFormats: Readonly<Record<number, string>> = {
  1: "I    ", 2: "IA   ", 3: "RGB  ", 4: "RGBA ", 0x8050: "RGB5 ", 0x8056: "RGBA4", 0x8051: "RGB8", 0x8058: "RGBA8", 0x83a1: "S3TC ",
};
export type ImageLevel = Pick<TextureImage, "width" | "height" | "pixels">;
export interface ImageUpload {
  readonly levels: readonly [ImageLevel, ...ImageLevel[]];
  readonly internalFormat: ImageInternalFormat;
}
export interface ImageSource extends ImageUpload {
  readonly name: string;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly mipmap: boolean;
  readonly sampling: TextureSampling;
  readonly registrationUnit: 0 | 1;
}
export interface ImageUploadSource extends Omit<ImageSource, keyof ImageUpload> {
  readonly allowPicmip: boolean;
}

export interface CreateImageOperation {
  readonly image: RendererImage;
  readonly levels: readonly [RgbaSnapshot, ...RgbaSnapshot[]];
  readonly internalFormat: ImageInternalFormat;
  readonly mipmap: boolean;
  readonly sampling: TextureSampling;
  readonly registrationUnit: ImageSource["registrationUnit"];
}

export type BeginImageOperation = Pick<CreateImageOperation, "image" | "mipmap" | "registrationUnit">;

export type ImageUploadPhase =
  | { readonly kind: "pending" }
  | { readonly kind: "checked" }
  | { readonly kind: "complete" }
  | { readonly kind: "uploading"; readonly nextLevel: number };

export type ImageResourceOperation =
  | { readonly kind: "begin-image"; readonly creation: BeginImageOperation }
  | { readonly kind: "upload-image-level"; readonly image: RendererImage; readonly index: number;
    readonly content: RgbaSnapshot; readonly internalFormat: ImageInternalFormat }
  | { readonly kind: "set-image-upload-descriptor"; readonly image: RendererImage;
    readonly width: number; readonly height: number; readonly internalFormat: ImageInternalFormat }
  | { readonly kind: "finish-image-upload"; readonly image: RendererImage; readonly filter: TextureFilter }
  | { readonly kind: "create-image"; readonly creation: CreateImageOperation }
  | { readonly kind: "dlight-image"; readonly image: RendererImage }
  | { readonly kind: "texture-mode"; readonly filter: TextureFilter }
  | { readonly kind: "current-border-color"; readonly color: Vec4 };

export interface RendererBindingSettings {
  readonly noBind: boolean;
}

export interface RendererErrorSettings {
  readonly ignoreGLErrors: boolean;
}

export interface ImageCreationTarget {
  readonly images: RendererImageCatalog;
  /** undefined, rather than void, prevents an async backend being accepted. */
  applyImageResource(operation: ImageResourceOperation): undefined;
}

type SessionState =
  | { readonly kind: "attaching"; readonly targets: ImageCreationTarget[] }
  | { readonly kind: "executing"; readonly targets: readonly [ImageCreationTarget, ...ImageCreationTarget[]] }
  | { readonly kind: "closed" | "poisoned" };
interface SessionRecord {
  readonly epoch: number;
  state: SessionState;
}
interface CatalogData {
  frameCount: number;
  textureFilter: TextureFilter;
  bindingSettings: RendererBindingSettings;
  errorSettings: RendererErrorSettings;
  readonly journal: ImageResourceOperation[];
  readonly issued: Set<RendererImage>;
  readonly usedTargets: WeakSet<ImageCreationTarget>;
  status: { readonly kind: "ready" } | { readonly kind: "poisoned"; readonly cause: unknown };
  active: SessionRecord | null;
  nextEpoch: number;
  scope: "idle" | "resource" | "execution";
}

function healthy(data: CatalogData): void {
  if (data.status.kind === "poisoned") throw new Error("Renderer image catalog is poisoned", { cause: data.status.cause });
}

function idle(data: CatalogData): void {
  if (data.scope === "idle") return;
  const error = new Error("Reentrant image catalog mutation is not allowed");
  if (data.scope === "execution") fail(data, error);
  throw error;
}

function continued(data: CatalogData): void {
  if (data.status.kind === "poisoned") throw data.status.cause;
}

function mutate<T>(data: CatalogData, operation: () => T): T {
  idle(data); healthy(data);
  data.scope = "resource";
  try {
    const result = operation();
    continued(data);
    return result;
  } catch (error: unknown) {
    continued(data);
    throw error;
  } finally {
    data.scope = "idle";
  }
}

function live(data: CatalogData, session: SessionRecord): void {
  healthy(data);
  if (session.state.kind === "closed" || data.active !== session) throw new Error("Renderer image session is closed");
}

function fail(data: CatalogData, cause: unknown): never {
  const failure = data.status.kind === "poisoned" ? data.status.cause : cause;
  data.status = { kind: "poisoned", cause: failure };
  if (data.active !== null) data.active.state = { kind: "poisoned" };
  throw failure;
}

function deliver(data: CatalogData, targets: readonly ImageCreationTarget[], operations: readonly ImageResourceOperation[]): void {
  try {
    for (const operation of operations) for (const target of targets) {
      continued(data);
      const applyImageResource = target.applyImageResource;
      continued(data);
      applyImageResource.call(target, operation);
      continued(data);
    }
  } catch (error: unknown) {
    fail(data, error);
  }
}

function publish(data: CatalogData, operation: ImageResourceOperation): void {
  continued(data);
  data.journal.push(operation);
  const active = data.active;
  if (active !== null) {
    const state = active.state;
    if (state.kind !== "attaching" && state.kind !== "executing") throw new Error("Image catalog has no live creation targets");
    deliver(data, state.targets, [operation]);
  }
}

class CatalogSession {
  constructor(readonly images: RendererImageCatalog, private readonly data: CatalogData, private readonly record: SessionRecord) {}

  get epoch(): number { return this.record.epoch; }
  get phase(): SessionState["kind"] { return this.record.state.kind; }

  attach(target: ImageCreationTarget): void {
    mutate(this.data, () => {
      live(this.data, this.record);
      const state = this.record.state;
      if (state.kind !== "attaching") throw new Error("Renderer image backend set is fixed after execution begins");
      const owner = target.images;
      continued(this.data);
      if (owner !== this.images) throw new Error("Image creation target belongs to another catalog");
      if (this.data.usedTargets.has(target)) throw new Error("Image sessions require a fresh backend object");
      this.data.usedTargets.add(target);
      state.targets.push(target);
      deliver(this.data, [target], this.data.journal);
    });
  }

  beginExecution(): void {
    idle(this.data); live(this.data, this.record);
    const state = this.record.state;
    if (state.kind === "executing") return;
    if (state.kind !== "attaching") throw new Error("Renderer image session cannot begin execution");
    const first = state.targets[0];
    if (first === undefined) throw new Error("Renderer image execution requires at least one backend");
    const targets: readonly [ImageCreationTarget, ...ImageCreationTarget[]] = [first, ...state.targets.slice(1)];
    this.record.state = { kind: "executing", targets: Object.freeze(targets) };
  }

  assertExecutable(): void {
    live(this.data, this.record);
    if (this.record.state.kind !== "executing") throw new Error("Renderer image execution has not begun");
  }

  /** One synchronous consuming operation; failure cannot be retried or swallowed. */
  execute(operation: () => undefined): undefined {
    idle(this.data); this.assertExecutable();
    this.data.scope = "execution";
    try {
      operation();
      continued(this.data);
    } catch (error: unknown) {
      fail(this.data, error);
    } finally {
      this.data.scope = "idle";
    }
  }

  /** A partial dynamic broadcast is terminal for every target and this catalog. */
  poison(cause: unknown): never {
    live(this.data, this.record);
    return fail(this.data, cause);
  }

  /** Releases logical ownership only; the target owner closes its actual devices. */
  close(): void {
    idle(this.data);
    if (this.record.state.kind === "closed") return;
    if (this.data.active === this.record) this.data.active = null;
    this.record.state = { kind: "closed" };
  }
}

/** One fixed backend group and its dynamic-execution lifetime. */
export type RendererImageSession = CatalogSession;

export class RendererImageCatalog {
  private readonly data: CatalogData;

  constructor(initialTextureFilter: TextureFilter = "linear-mipmap-nearest",
    readonly hunk: HunkAccountingProfile = { kind: "unaccounted" }) {
    this.data = {
      frameCount: 0,
      textureFilter: initialTextureFilter,
      bindingSettings: { noBind: false },
      errorSettings: { ignoreGLErrors: true },
      journal: [], issued: new Set(), usedTargets: new WeakSet(), status: { kind: "ready" },
      active: null, nextEpoch: 0, scope: "idle",
    };
  }

  create(source: ImageSource): RendererImage {
    if (this.hunk.kind === "source-hunk") throw new Error("Source-hunk images require createUploaded at the actual upload call");
    return mutate(this.data, () => this.publishImage(source));
  }

  createUploaded(source: ImageUploadSource, prepare: () => ImageUploadSteps): RendererImage {
    return mutate(this.data, () => {
      const { name, sourceWidth, sourceHeight, mipmap, allowPicmip, sampling, registrationUnit } = source;
      const { wrap, filter } = sampling;
      continued(this.data);
      const nul = name.indexOf("\0"), sourceName = nul < 0 ? name : name.slice(0, nul);
      if (sourceName.length >= 64) throw new CommonError("drop", `R_CreateImage: "${sourceName}" is too long\n`);
      const encodedName = Uint8Array.from(Array.from(sourceName), character => {
        const value = character.charCodeAt(0);
        if (value > 255) throw new RangeError("R_CreateImage name requires source bytes");
        return value;
      });
      if (this.data.issued.size === 2048) throw new CommonError("drop", "R_CreateImage: MAX_DRAWIMAGES hit\n");
      const active = this.data.active;
      if (this.hunk.kind === "source-hunk" && (active === null
        || (active.state.kind !== "attaching" && active.state.kind !== "executing") || active.state.targets.length === 0)) {
        throw new Error("Source-hunk image upload requires an attached creation target");
      }
      const allocation = this.hunk.kind === "source-hunk"
        ? this.hunk.accounting.reserve("R_CreateImage", name, SOURCE_HUNK_RELEASE32.image, "low") : null;
      const image = new CatalogImage(this, this.data.issued.size, sourceName, sourceWidth, sourceHeight, mipmap, wrap, registrationUnit, allocation);
      this.data.issued.add(image);
      if (allocation !== null) {
        const bytes = allocation.bytes, record = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        bytes.set(encodedName);
        record.setInt32(64, sourceWidth, true); record.setInt32(68, sourceHeight, true);
        record.setUint32(80, 1024 + image.ordinal, true); record.setInt32(92, registrationUnit, true);
        record.setInt32(96, mipmap ? 1 : 0, true); record.setInt32(100, allowPicmip ? 1 : 0, true);
        record.setInt32(104, wrap === "repeat" ? 0x2901 : 0x2900, true);
      }
      publish(this.data, Object.freeze({ kind: "begin-image", creation: Object.freeze({ image, mipmap, registrationUnit }) }));
      const levels: RgbaSnapshot[] = [];
      let descriptor: { readonly width: number; readonly height: number; readonly internalFormat: ImageInternalFormat } | null = null;
      let checked = false, uploadFilter = filter;
      for (const step of prepare()) {
        continued(this.data);
        if (checked) throw new Error("Image preparation continued after its upload check");
        switch (step.kind) {
          case "upload-level": {
            const { index, internalFormat } = step, { width, height, pixels } = step.level;
            if (index !== levels.length) throw new Error("Image upload levels are out of order");
            const previous = levels.at(-1);
            if (previous !== undefined && (!mipmap || (previous.width === 1 && previous.height === 1)
              || width !== Math.max(1, previous.width >> 1) || height !== Math.max(1, previous.height >> 1)))
              throw new RangeError("Image mip chain must halve each dimension");
            if (descriptor !== null && internalFormat !== descriptor.internalFormat) throw new Error("Image upload changed internal format between levels");
            const content = new RgbaSnapshot(width, height, pixels);
            levels.push(content);
            publish(this.data, Object.freeze({ kind: "upload-image-level", image, index, content, internalFormat }));
            break;
          }
          case "set-upload-descriptor": {
            if (descriptor !== null) throw new Error("Image upload descriptor was already assigned");
            const { width, height, internalFormat } = step;
            dimension(width); dimension(height);
            descriptor = { width, height, internalFormat };
            image.setUploadDescriptor(width, height, internalFormat);
            publish(this.data, Object.freeze({ kind: "set-image-upload-descriptor", image, width, height, internalFormat }));
            break;
          }
          case "finish-upload": {
            const base = levels[0], last = levels.at(-1);
            if (descriptor === null || base === undefined || last === undefined) throw new Error("Image upload has no base descriptor");
            if (base.width !== descriptor.width || base.height !== descriptor.height) throw new Error("Image upload dimensions disagree with its descriptor");
            if (mipmap && (last.width !== 1 || last.height !== 1)) throw new RangeError("Image mip chain must end at 1x1");
            uploadFilter = mipmap ? this.data.textureFilter : "linear";
            publish(this.data, Object.freeze({ kind: "finish-image-upload", image, filter: uploadFilter }));
            checked = true;
            break;
          }
        }
      }
      continued(this.data);
      const first = levels[0];
      if (!checked || descriptor === null || first === undefined) throw new Error("Image preparation did not reach the Upload32 completion boundary");
      const snapshots: readonly [RgbaSnapshot, ...RgbaSnapshot[]] = Object.freeze([first, ...levels.slice(1)]);
      const creation: CreateImageOperation = Object.freeze({ image, levels: snapshots, internalFormat: descriptor.internalFormat,
        mipmap, sampling: Object.freeze({ wrap, filter: uploadFilter }), registrationUnit });
      publish(this.data, Object.freeze({ kind: "create-image", creation }));
      return image;
    });
  }

  private publishImage(source: ImageSource): RendererImage {
      const { name, sourceWidth, sourceHeight, levels, mipmap,
        internalFormat, sampling, registrationUnit } = source;
      const { wrap, filter } = sampling;
      continued(this.data);
      dimension(sourceWidth); dimension(sourceHeight);
      const snapshots = levels.map(level => {
        const { width, height, pixels } = level;
        continued(this.data);
        return new RgbaSnapshot(width, height, pixels);
      });
      const first = snapshots[0];
      if (first === undefined) throw new RangeError("Image creation requires level zero");
      if (!mipmap && snapshots.length !== 1) throw new RangeError("Nonmipmapped images require exactly one level");
      let previous = first;
      for (const child of snapshots.slice(1)) {
        if ((previous.width === 1 && previous.height === 1)
          || child.width !== Math.max(1, previous.width >> 1)
          || child.height !== Math.max(1, previous.height >> 1)) throw new RangeError("Image mip chain must halve each dimension");
        previous = child;
      }
      if (mipmap && (previous.width !== 1 || previous.height !== 1)) throw new RangeError("Image mip chain must end at 1x1");
      const ownedLevels: readonly [RgbaSnapshot, ...RgbaSnapshot[]] = Object.freeze([first, ...snapshots.slice(1)]);
      const image = new CatalogImage(this, this.data.issued.size, name, sourceWidth, sourceHeight, mipmap, wrap, registrationUnit);
      image.setUploadDescriptor(first.width, first.height, internalFormat);
      const operation: CreateImageOperation = Object.freeze({ image, levels: ownedLevels, internalFormat, mipmap,
        sampling: Object.freeze({ wrap, filter }), registrationUnit });
      continued(this.data);
      // Publish ownership before callbacks; a partial broadcast permanently poisons
      // the journal, so no failed creation can be replayed into a later session.
      this.data.issued.add(image);
      publish(this.data, Object.freeze({ kind: "create-image", creation: operation }));
      return image;
  }

  get textureFilter(): TextureFilter { healthy(this.data); return this.data.textureFilter; }

  get frameCount(): number { healthy(this.data); return this.data.frameCount; }

  /** RE_BeginFrame advances tr.frameCount before texture mode or gamma work. */
  beginFrame(): void {
    mutate(this.data, () => { this.data.frameCount = (this.data.frameCount + 1) | 0; });
  }

  /** GL_Bind marks the requested image only when the selected texnum changes. */
  markUsed(image: RendererImage): void {
    this.requireOwned(image);
    image.markUsed(this.data.frameCount);
  }

  /** RE_UploadCinematic writes the requested scratch descriptor before native storage. */
  resizeCinematic(image: RendererImage, width: number, height: number): void {
    this.requireOwned(image);
    image.resizeCinematic(width, height);
  }

  /** R_SumOfUsedImages excludes mip levels and retains source int32 arithmetic. */
  sumOfUsedImages(): number {
    healthy(this.data);
    let total = 0;
    for (const image of this.data.issued) {
      if (image.frameUsed === this.data.frameCount) total = (total + Math.imul(image.uploadWidth, image.uploadHeight)) | 0;
    }
    return total;
  }

  registeredImages(): readonly RendererImage[] {
    healthy(this.data);
    if (this.data.active !== null) live(this.data, this.data.active);
    return Object.freeze([...this.data.issued]);
  }

  /** R_ImageList_f reads requested image descriptors, not current GL objects. */
  listImages(print: (text: string) => undefined): void {
    const session = this.data.active;
    const emit = (text: string): void => {
      healthy(this.data);
      if (session !== null) live(this.data, session);
      print(text);
      continued(this.data);
      if (session !== null) live(this.data, session);
    };
    emit("\n      -w-- -h-- -mm- -TMU- -if-- wrap --name-------\n");
    let texels = 0;
    for (const image of this.data.issued) {
      texels = (texels + Math.imul(image.uploadWidth, image.uploadHeight)) | 0;
      emit(`${String(image.ordinal).padStart(4)}: ${String(image.uploadWidth).padStart(4)} ${String(image.uploadHeight).padStart(4)}  ${image.mipmapEnabled ? "yes" : "no "}   ${image.textureUnit}   `);
      emit(imageListFormats[image.internalFormat] ?? "???? ");
      emit(image.wrapMode === 0x2901 ? "rept " : image.wrapMode === 0x2900 ? "clmp " : `${String(image.wrapMode).padStart(4)} `);
      const nul = image.name.indexOf("\0");
      emit(` ${nul < 0 ? image.name : image.name.slice(0, nul)}\n`);
    }
    emit(" ---------\n");
    emit(` ${texels} total texels (not including mipmaps)\n`);
    emit(` ${this.data.issued.size} total images\n\n`);
  }

  /** Retain the source settings owner so every GL_Bind reads its current cvar. */
  setBindingSettings(settings: RendererBindingSettings): void {
    mutate(this.data, () => { this.data.bindingSettings = settings; });
  }

  get noBind(): boolean {
    healthy(this.data);
    const value = this.data.bindingSettings.noBind;
    continued(this.data);
    return value;
  }

  /** GL_CheckErrors samples the retained source owner after consuming a nonzero error. */
  setErrorSettings(settings: RendererErrorSettings): void {
    mutate(this.data, () => { this.data.errorSettings = settings; });
  }

  get ignoreGLErrors(): boolean {
    healthy(this.data);
    const value = this.data.errorSettings.ignoreGLErrors;
    continued(this.data);
    return value;
  }

  /** R_CreateDlightImage assigns tr.dlightImage only after R_CreateImage returns. */
  setDlightImage(image: RendererImage): undefined {
    return mutate(this.data, () => {
      this.requireOwned(image);
      publish(this.data, Object.freeze({ kind: "dlight-image", image }));
      return undefined;
    });
  }

  setTextureMode(sourceName: string): boolean {
    return mutate(this.data, () => {
      // Q_stricmp folds only ASCII a..z and stops at the source string's NUL.
      let name = "";
      for (let i = 0; i < sourceName.length; i++) {
        const code = sourceName.charCodeAt(i);
        if (code === 0) break;
        if (i >= "GL_NEAREST_MIPMAP_NEAREST".length || code > 127) return false;
        name += String.fromCharCode(code >= 97 && code <= 122 ? code - 32 : code);
      }
      let filter: TextureFilter;
      switch (name) {
        case "GL_NEAREST": filter = "nearest"; break;
        case "GL_LINEAR": filter = "linear"; break;
        case "GL_NEAREST_MIPMAP_NEAREST": filter = "nearest-mipmap-nearest"; break;
        case "GL_LINEAR_MIPMAP_NEAREST": filter = "linear-mipmap-nearest"; break;
        case "GL_NEAREST_MIPMAP_LINEAR": filter = "nearest-mipmap-linear"; break;
        case "GL_LINEAR_MIPMAP_LINEAR": filter = "linear-mipmap-linear"; break;
        default: return false;
      }
      this.data.textureFilter = filter;
      publish(this.data, Object.freeze({ kind: "texture-mode", filter }));
      return true;
    });
  }

  /** Source qglTexParameterfv targets the actual current object without binding. */
  setCurrentBorderColor(color: Vec4): undefined {
    return mutate(this.data, () => {
      const { x, y, z, w } = color;
      continued(this.data);
      if (![x, y, z, w].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
        throw new RangeError("Image border color must be finite and normalized");
      }
      publish(this.data, Object.freeze({ kind: "current-border-color", color: Object.freeze({ x, y, z, w }) }));
      return undefined;
    });
  }

  requireOwned(image: RendererImage): void {
    healthy(this.data);
    if (!this.data.issued.has(image) || !image.belongsTo(this)) throw new Error("Renderer image belongs to another catalog");
  }

  /** Replays creation only; a fresh epoch does not clone prior dynamic state. */
  openSession(): RendererImageSession {
    idle(this.data); healthy(this.data);
    if (this.data.active !== null) throw new Error("Image catalog already has an active session");
    if (!Number.isSafeInteger(this.data.nextEpoch)) throw new RangeError("Image session epoch exceeds integer precision");
    const record: SessionRecord = { epoch: this.data.nextEpoch++, state: { kind: "attaching", targets: [] } };
    this.data.active = record;
    return new CatalogSession(this, this.data, record);
  }
}
