// Ordered renderer registration across the R_SyncRenderThread boundary.
// Source: id Software renderer/tr_image.c, tr_shader.c and tr_cmds.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { RgbaSnapshot } from "./image-resource.ts";
import type { ImageResourceOperation, ImageInternalFormat, RendererImage, RendererImageCatalog, RendererImageIdentity } from "./image-resource.ts";
import type { MaterialLighting, MaterialRecord } from "./material-registry.ts";
import type { FinishedStageBinding, RegisteredSky, RegisteredSkyBox, SourceSkyFaceName } from "./material.ts";
import type { FinishedShader, FinishedShaderStage } from "./material-finish.ts";
import type { FinishedIteratorStage, IteratorPass } from "./material-iterator.ts";
import type { ShaderCinematicSource } from "./cinematic-command.ts";
import type { TextureFilter, TextureSampling } from "./types.ts";

export interface RgbaTransfer { readonly width: number; readonly height: number; readonly pixels: Uint8Array }
export function captureRgba(content: RgbaSnapshot): RgbaTransfer {
  return { width: content.width, height: content.height, pixels: content.copyPixels() };
}
export function restoreRgba(content: RgbaTransfer): RgbaSnapshot { return new RgbaSnapshot(content.width, content.height, content.pixels); }

export type ImageOperationTransfer =
  | { readonly kind: "begin-image"; readonly image: number; readonly mipmap: boolean; readonly registrationUnit: 0 | 1 }
  | { readonly kind: "create-image"; readonly image: number; readonly levels: readonly [RgbaTransfer, ...RgbaTransfer[]];
      readonly internalFormat: ImageInternalFormat; readonly mipmap: boolean; readonly sampling: TextureSampling; readonly registrationUnit: 0 | 1 }
  | { readonly kind: "upload-image-level"; readonly image: number; readonly index: number; readonly content: RgbaTransfer; readonly internalFormat: ImageInternalFormat }
  | { readonly kind: "set-image-upload-descriptor"; readonly image: number; readonly width: number; readonly height: number; readonly internalFormat: ImageInternalFormat }
  | { readonly kind: "finish-image-upload"; readonly image: number; readonly filter: TextureFilter }
  | { readonly kind: "dlight-image"; readonly image: number }
  | Extract<ImageResourceOperation, { readonly kind: "texture-mode" | "current-border-color" }>;

export function captureImageOperation(operation: ImageResourceOperation, image: (image: RendererImage) => number): ImageOperationTransfer {
  switch (operation.kind) {
    case "begin-image": return { kind: operation.kind, ...operation.creation, image: image(operation.creation.image) };
    case "create-image": {
      const creation = operation.creation;
      return { kind: operation.kind, ...creation, image: image(creation.image),
        sampling: { ...creation.sampling }, levels: [captureRgba(creation.levels[0]), ...creation.levels.slice(1).map(captureRgba)] };
    }
    case "upload-image-level": return { ...operation, image: image(operation.image), content: captureRgba(operation.content) };
    case "set-image-upload-descriptor": case "finish-image-upload": case "dlight-image": return { ...operation, image: image(operation.image) };
    case "texture-mode": return { ...operation };
    case "current-border-color": return { ...operation, color: { ...operation.color } };
  }
}

export function decodeImageOperation(operation: ImageOperationTransfer, image: (id: number) => RendererImage): ImageResourceOperation {
  switch (operation.kind) {
    case "begin-image": return { kind: operation.kind, creation: { image: image(operation.image), mipmap: operation.mipmap, registrationUnit: operation.registrationUnit } };
    case "create-image": return { kind: operation.kind, creation: { image: image(operation.image), mipmap: operation.mipmap,
      registrationUnit: operation.registrationUnit, internalFormat: operation.internalFormat, sampling: { ...operation.sampling },
      levels: [restoreRgba(operation.levels[0]), ...operation.levels.slice(1).map(restoreRgba)] } };
    case "upload-image-level": return { ...operation, image: image(operation.image), content: restoreRgba(operation.content) };
    case "set-image-upload-descriptor": case "finish-image-upload": case "dlight-image": return { ...operation, image: image(operation.image) };
    case "texture-mode": return { ...operation };
    case "current-border-color": return { ...operation, color: { ...operation.color } };
  }
}

type BindingTransfer =
  | { readonly kind: "images"; readonly playback: { readonly kind: "single"; readonly image: number }
      | { readonly kind: "animation"; readonly frequency: number; readonly frames: readonly [number, ...number[]] } }
  | { readonly kind: "video"; readonly source: number }
  | { readonly kind: "retain-current-texture" };
type StageTransfer = Omit<FinishedIteratorStage, "active" | "imageTMU" | "binding"> &
  ({ readonly active: true; readonly imageTMU: 0 | 1; readonly binding: BindingTransfer }
  | { readonly active: false; readonly imageTMU: null; readonly binding: null });
type ShaderStageTransfer = StageTransfer & Pick<FinishedShaderStage, "fogAdjustment" | "rgbGen">;
type PassTransfer = Omit<IteratorPass, "bundles"> & { readonly bundles: readonly [StageTransfer] | readonly [StageTransfer, StageTransfer] };
type FinishedTransfer = Omit<FinishedShader, "sourceStages" | "iterator"> & {
  readonly sourceStages: readonly ShaderStageTransfer[];
  readonly iterator: Omit<FinishedShader["iterator"], "passes"> & { readonly passes: readonly PassTransfer[] };
};
type SkyBoxTransfer = Readonly<Record<SourceSkyFaceName, number>>;
type SkyTransfer = { readonly outer: SkyBoxTransfer | null; readonly inner: SkyBoxTransfer | null; readonly cloudHeight: number };
type LightingTransfer = Exclude<MaterialLighting, { readonly kind: "lightmap" }>
  | { readonly kind: "lightmap"; readonly owner: number; readonly index: number; readonly image: number };
export type MaterialTransfer = Omit<MaterialRecord, "image" | "whiteImage" | "finished" | "lighting" | "sky" | "remapped"> & {
  readonly image: number; readonly whiteImage: number; readonly finished: FinishedTransfer;
  readonly lighting: LightingTransfer; readonly sky: SkyTransfer | null; readonly remapped: number | null;
};
export type ResourceRegistration =
  | { readonly kind: "image-identity"; readonly identity: RendererImageIdentity }
  | { readonly kind: "image-operation"; readonly operation: ImageOperationTransfer }
  | { readonly kind: "material"; readonly material: MaterialTransfer }
  | { readonly kind: "material-state"; readonly handle: number; readonly sortedIndex: number; readonly remapped: number | null; readonly timeOffset: number };
export interface ResourceJournal { readonly first: number; readonly entries: readonly ResourceRegistration[] }
export interface ImageFrameState { readonly frameCount: number; readonly noBind: boolean; readonly ignoreGLErrors: boolean }
export interface ImageUsageState { readonly ordinal: number; readonly frameUsed: number; readonly uploadWidth: number; readonly uploadHeight: number }
type MaterialState = Extract<ResourceRegistration, { readonly kind: "material-state" }>;

function skyBoxTransfer(box: RegisteredSkyBox, image: (image: RendererImage) => number): SkyBoxTransfer {
  return { rt: image(box.image("rt").image), bk: image(box.image("bk").image), lf: image(box.image("lf").image),
    ft: image(box.image("ft").image), up: image(box.image("up").image), dn: image(box.image("dn").image) };
}

export class RendererResourceSender {
  private imageCursor = 0;
  private journalCursor = 0;
  private readonly identities = new Set<number>();
  private readonly materials = new Map<number, MaterialRecord>();
  private readonly materialStates = new Map<number, MaterialState>();
  private readonly lightmapOwners = new Map<Extract<MaterialLighting, { readonly kind: "lightmap" }>["owner"], number>();
  private readonly entries: ResourceRegistration[] = [];

  constructor(readonly images: RendererImageCatalog, private readonly synchronize: () => void,
    private readonly cinematicId: (source: ShaderCinematicSource) => number) {
    images.setResourceSynchronization(synchronize);
  }

  sourceImageHandle(image: RendererImage): number { this.images.requireOwned(image); return image.ordinal; }

  registerLightmapOwner(owner: Extract<MaterialLighting, { readonly kind: "lightmap" }>["owner"], id: number): void {
    this.synchronize();
    const prior = this.lightmapOwners.get(owner);
    if (prior !== undefined && prior !== id) throw new Error("Lightmap owner already has another worker handle");
    this.lightmapOwners.set(owner, id);
  }

  private imageIdentity(image: RendererImage): number {
    this.images.requireOwned(image);
    if (!this.identities.has(image.ordinal)) {
      const unit = image.textureUnit;
      if (unit !== 0 && unit !== 1) throw new RangeError("Transferred image has an invalid source texture unit");
      if (image.wrapMode !== 0x2900 && image.wrapMode !== 0x2901) throw new RangeError("Transferred image has an invalid wrap mode");
      this.identities.add(image.ordinal);
      this.entries.push({ kind: "image-identity", identity: { ordinal: image.ordinal, name: image.name,
        sourceWidth: image.sourceWidth, sourceHeight: image.sourceHeight, mipmap: image.mipmapEnabled,
        wrap: image.wrapMode === 0x2901 ? "repeat" : "clamp", registrationUnit: unit } });
    }
    return image.ordinal;
  }

  private captureImages(): void {
    const operations = this.images.resourceJournal(this.imageCursor);
    for (const operation of operations) {
      const transfer = captureImageOperation(operation, image => this.imageIdentity(image));
      this.entries.push({ kind: "image-operation", operation: transfer });
      this.imageCursor++;
    }
  }

  private binding(binding: FinishedStageBinding): BindingTransfer {
    switch (binding.kind) {
      case "retain-current-texture": return { kind: binding.kind };
      case "video": return { kind: binding.kind, source: this.cinematicId(binding.source) };
      case "images": {
        const playback = binding.playback;
        return { kind: binding.kind, playback: playback.kind === "single"
          ? { kind: "single", image: this.sourceImageHandle(playback.image.image) }
          : { kind: "animation", frequency: playback.frequency,
            frames: [this.sourceImageHandle(playback.frames[0].image), ...playback.frames.slice(1).map(frame => this.sourceImageHandle(frame.image))] } };
      }
    }
  }

  private stage(stage: FinishedIteratorStage): StageTransfer {
    return stage.active ? { ...stage, binding: this.binding(stage.binding) } : { ...stage };
  }

  materialHandle(material: MaterialRecord): number {
    const prior = this.materials.get(material.order);
    if (prior !== undefined) {
      if (prior !== material) throw new Error("Renderer material handle belongs to another registry");
      return material.order;
    }
    this.synchronize();
    this.captureImages();
    let lighting: LightingTransfer;
    if (material.lighting.kind === "lightmap") {
      const owner = this.lightmapOwners.get(material.lighting.owner);
      if (owner === undefined) throw new Error("Register the BSP lightmap owner before its material");
      lighting = { kind: "lightmap", owner, index: material.lighting.index, image: this.sourceImageHandle(material.lighting.image) };
    } else lighting = { ...material.lighting };
    this.materials.set(material.order, material);
    const sky = material.sky, finished = material.finished;
    const transfer: MaterialTransfer = { ...material, image: this.sourceImageHandle(material.image), whiteImage: this.sourceImageHandle(material.whiteImage),
      lighting, remapped: null, sky: sky === null ? null : { cloudHeight: sky.cloudHeight,
        outer: sky.outer === null ? null : skyBoxTransfer(sky.outer, image => this.sourceImageHandle(image)),
        inner: sky.inner === null ? null : skyBoxTransfer(sky.inner, image => this.sourceImageHandle(image)) },
      finished: { ...finished, sourceStages: finished.sourceStages.map(stage => this.stage(stage)),
        iterator: { ...finished.iterator, passes: finished.iterator.passes.map(pass => ({ ...pass,
          bundles: pass.bundles[1] === undefined ? [this.stage(pass.bundles[0])] : [this.stage(pass.bundles[0]), this.stage(pass.bundles[1])] })) } } };
    this.entries.push({ kind: "material", material: structuredClone(transfer) });
    this.materialStates.set(material.order, { kind: "material-state", handle: material.order,
      sortedIndex: material.sortedIndex, remapped: null, timeOffset: material.timeOffset });
    if (material.remapped !== null) this.materialHandle(material.remapped);
    return material.order;
  }

  takeJournal(): ResourceJournal {
    this.captureImages();
    for (const material of this.materials.values()) {
      const remapped = material.remapped === null ? null : this.materialHandle(material.remapped);
      const prior = this.materialStates.get(material.order);
      if (prior !== undefined && prior.sortedIndex === material.sortedIndex && prior.remapped === remapped && Object.is(prior.timeOffset, material.timeOffset)) continue;
      const state: MaterialState = { kind: "material-state", handle: material.order, sortedIndex: material.sortedIndex, remapped, timeOffset: material.timeOffset };
      this.entries.push(state);
      this.materialStates.set(material.order, state);
    }
    const result: ResourceJournal = { first: this.journalCursor, entries: this.entries.splice(0) };
    this.journalCursor += result.entries.length;
    return result;
  }

  captureState(): ImageFrameState { return { frameCount: this.images.frameCount, noBind: this.images.noBind, ignoreGLErrors: this.images.ignoreGLErrors }; }

  applyUsage(states: readonly ImageUsageState[]): void {
    const images = this.images.registeredImages();
    for (const state of states) {
      const image = images[state.ordinal];
      if (image === undefined || image.ordinal !== state.ordinal) throw new RangeError("Worker returned an unregistered image");
      image.markUsed(state.frameUsed);
      if (image.uploadWidth !== state.uploadWidth || image.uploadHeight !== state.uploadHeight)
        image.resizeCinematic(state.uploadWidth, state.uploadHeight);
    }
  }
}

export class RendererResourceReceiver {
  private journalCursor = 0;
  private readonly imageRecords = new Map<number, RendererImage>();
  private readonly materialRecords = new Map<number, MaterialRecord>();
  private readonly sortedMaterials = new Map<number, MaterialRecord>();

  constructor(readonly images: RendererImageCatalog,
    private readonly cinematicSource: (id: number) => ShaderCinematicSource,
    private readonly lightmapOwner: (id: number) => Extract<MaterialLighting, { readonly kind: "lightmap" }>["owner"]) {}

  resolveImage(id: number): RendererImage {
    const image = this.imageRecords.get(id);
    if (image === undefined) throw new RangeError(`Unregistered worker image ${id}`);
    this.images.requireOwned(image);
    return image;
  }
  resolveMaterial(handle: number): MaterialRecord {
    const material = this.materialRecords.get(handle);
    if (material === undefined) throw new RangeError(`Unregistered worker material ${handle}`);
    return material;
  }
  materialBySortedIndex(index: number): MaterialRecord | null {
    return this.sortedMaterials.get(index) ?? null;
  }

  private binding(binding: BindingTransfer): FinishedStageBinding {
    switch (binding.kind) {
      case "retain-current-texture": return { kind: binding.kind };
      case "video": return { kind: binding.kind, source: this.cinematicSource(binding.source) };
      case "images": {
        const playback = binding.playback;
        return { kind: binding.kind, playback: playback.kind === "single"
          ? { kind: "single", image: { image: this.resolveImage(playback.image) } }
          : { kind: "animation", frequency: playback.frequency, frames: [{ image: this.resolveImage(playback.frames[0]) },
            ...playback.frames.slice(1).map(id => ({ image: this.resolveImage(id) }))] } };
      }
    }
  }
  private stage(stage: StageTransfer): FinishedIteratorStage {
    return stage.active ? { ...stage, binding: this.binding(stage.binding) } : { ...stage };
  }
  private sky(sky: SkyTransfer | null): RegisteredSky | null {
    if (sky === null) return null;
    const box = (faces: SkyBoxTransfer): RegisteredSkyBox => ({ image: face => ({ image: this.resolveImage(faces[face]) }) });
    return { cloudHeight: sky.cloudHeight, outer: sky.outer === null ? null : box(sky.outer), inner: sky.inner === null ? null : box(sky.inner) };
  }
  private material(transfer: MaterialTransfer): MaterialRecord {
    const finished = transfer.finished, lighting = transfer.lighting;
    return { ...transfer, image: this.resolveImage(transfer.image), whiteImage: this.resolveImage(transfer.whiteImage),
      lighting: lighting.kind === "lightmap" ? { ...lighting, image: this.resolveImage(lighting.image), owner: this.lightmapOwner(lighting.owner) } : { ...lighting },
      remapped: transfer.remapped === null ? null : this.resolveMaterial(transfer.remapped), sky: this.sky(transfer.sky),
      finished: { ...finished, sourceStages: finished.sourceStages.map(stage => this.stage(stage)),
        iterator: { ...finished.iterator, passes: finished.iterator.passes.map(pass => ({ ...pass,
          bundles: pass.bundles[1] === undefined ? [this.stage(pass.bundles[0])] : [this.stage(pass.bundles[0]), this.stage(pass.bundles[1])] })) } } };
  }

  applyJournal(journal: ResourceJournal): void {
    if (journal.first !== this.journalCursor) throw new Error("Renderer resource journal is out of order");
    let materialChanged = false;
    for (const entry of journal.entries) {
      switch (entry.kind) {
        case "image-identity": {
          const image = this.images.importIdentity(entry.identity);
          this.imageRecords.set(image.ordinal, image);
          break;
        }
        case "image-operation": this.images.importResourceOperation(decodeImageOperation(entry.operation, id => this.resolveImage(id))); break;
        case "material": {
          if (this.materialRecords.has(entry.material.order)) throw new Error("Renderer material was registered twice");
          this.materialRecords.set(entry.material.order, this.material(entry.material));
          materialChanged = true;
          break;
        }
        case "material-state": {
          const material = this.resolveMaterial(entry.handle);
          material.sortedIndex = entry.sortedIndex;
          material.remapped = entry.remapped === null ? null : this.resolveMaterial(entry.remapped);
          material.timeOffset = entry.timeOffset;
          materialChanged = true;
          break;
        }
      }
      this.journalCursor++;
    }
    if (materialChanged) {
      this.sortedMaterials.clear();
      for (const material of this.materialRecords.values()) {
        if (this.sortedMaterials.has(material.sortedIndex)) throw new Error("Worker materials have duplicate sorted indices");
        this.sortedMaterials.set(material.sortedIndex, material);
      }
    }
  }

  applyState(state: ImageFrameState): void { this.images.importFrameState(state.frameCount, state); }
  captureUsage(): readonly ImageUsageState[] {
    return [...this.imageRecords.values()].map(image => ({ ordinal: image.ordinal, frameUsed: image.frameUsed,
      uploadWidth: image.uploadWidth, uploadHeight: image.uploadHeight }));
  }
}
