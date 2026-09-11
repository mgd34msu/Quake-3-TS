// R_FindShader/R_GetShaderByHandle/R_RemapShader/R_ShaderList_f,
// GeneratePermanentShader/SortNewShader, id Software tr_shader.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { sameShaderName, shaderNameHash, stripShaderExtension } from "./material.ts";
import type { RegisteredSky, ShaderDefinition } from "./material.ts";
import type { RendererImage } from "./image-resource.ts";
import { finishImplicitShader } from "./material-finish.ts";
import type { FinishedShader, FinishLoadedImageMetadata, FinishShaderProfile } from "./material-finish.ts";
import { SOURCE_HUNK_RELEASE32 } from "./hunk-accounting.ts";
import type { HunkAccountingProfile } from "./hunk-accounting.ts";
import { nativeAtof } from "../core/native-numeric.ts";

const MAX_SHADERS = 16384;
const FILE_HASH_SIZE = 1024;

function lookupName(name: string): string {
  const stripped = stripShaderExtension(name);
  if (stripped.length >= 64) throw new RangeError("Shader lookup exceeds COM_StripExtension MAX_QPATH storage");
  return stripped;
}

export type MaterialLighting = { readonly kind: "none" | "vertex" | "white" | "picture" }
  | { readonly kind: "lightmap"; readonly owner: object; readonly index: number; readonly image: RendererImage };

export interface MaterialContent {
  readonly definition: ShaderDefinition | null;
  readonly image: RendererImage;
  readonly defaulted: boolean;
  readonly finished: FinishedShader;
  readonly whiteImage: RendererImage;
  readonly sky: RegisteredSky | null;
}
export interface MaterialRecord extends MaterialContent {
  readonly kind: "ordinary" | "stencil-shadow";
  readonly name: string;
  readonly order: number;
  sortedIndex: number;
  readonly sort: number;
  readonly lighting: MaterialLighting;
  readonly mip: boolean;
  remapped: MaterialRecord | null;
  timeOffset: number;
}

function sameLighting(a: MaterialLighting, b: MaterialLighting): boolean {
  return a.kind === "lightmap" ? b.kind === "lightmap" && a.owner === b.owner && a.index === b.index : a.kind === b.kind;
}

/** Native atof accepts a numeric prefix, unlike Number's whole-string conversion. */
export function remapTimeOffset(text: string): number {
  return Math.fround(nativeAtof(text));
}

export class MaterialRegistry {
  private readonly names = new Map<number, MaterialRecord[]>();
  private readonly handles: MaterialRecord[] = [];
  private readonly sortedHandles: MaterialRecord[] = [];
  private preparations: Promise<void> = Promise.resolve();

  constructor(private readonly prepare: (name: string, lighting: MaterialLighting, mip: boolean) => Promise<MaterialContent>,
    private readonly print: (text: string) => undefined,
    private readonly memory: HunkAccountingProfile = { kind: "unaccounted" },
    private readonly onSortInsertion: (newShader: number) => undefined = () => {}) {}

  find(name: string): MaterialRecord | null {
    if (name.length === 0 || name[0] === "\0") return this.handles[0] ?? null;
    const stripped = lookupName(name);
    return this.names.get(shaderNameHash(stripped, FILE_HASH_SIZE))?.find(material => sameShaderName(material.name, stripped)) ?? null;
  }

  private publishName(material: MaterialRecord): void {
    const hash = shaderNameHash(material.name, FILE_HASH_SIZE), records = this.names.get(hash);
    if (records === undefined) this.names.set(hash, [material]);
    else records.unshift(material);
  }

  findByHandle(handle: number): MaterialRecord | null {
    if (!Number.isInteger(handle)) throw new RangeError("Shader handle must be an integer");
    return this.handles[handle] ?? null;
  }

  findBySortedIndex(index: number): MaterialRecord | null {
    if (!Number.isInteger(index)) throw new RangeError("Sorted shader index must be an integer");
    return this.sortedHandles[index] ?? null;
  }

  /** GeneratePermanentShader runs after FinishShader and retains no overflow name. */
  private defaultWhenFull(): MaterialRecord | null {
    if (this.handles.length < MAX_SHADERS) return null;
    this.print("WARNING: GeneratePermanentShader - MAX_SHADERS hit\n");
    const fallback = this.findByHandle(0);
    if (fallback === null) throw new Error("Full shader registry has no default row");
    return fallback;
  }

  listShaders(sorted: boolean, print: (text: string) => undefined): void {
    print("-----------------------\n");
    const materials = sorted ? this.sortedHandles : this.handles;
    let count = 0;
    for (const material of materials) {
      const finished = material.finished;
      print(`${finished.numUnfoggedPasses | 0} `);
      print(finished.lightmapIndex >= 0 ? "L " : "  ");
      switch (finished.iterator.multitextureEnv) {
        case "add": print("MT(a) "); break;
        case "modulate": print("MT(m) "); break;
        case "none": print("      "); break;
      }
      print(material.definition !== null && !material.defaulted ? "E " : "  ");
      switch (finished.iterator.kind) {
        case "generic": print("gen "); break;
        case "sky": print("sky "); break;
        case "lightmapped-multitexture": print("lmmt"); break;
        case "vertex-lit": print("vlt "); break;
      }
      print(`: ${material.name}${material.defaulted ? " (DEFAULTED)" : ""}\n`);
      count = (count + 1) | 0;
    }
    print(`${count} total shaders\n`);
    print("------------------\n");
  }

  private allocateRecord(name: string): void {
    if (this.memory.kind === "source-hunk") this.memory.accounting.reserve("GeneratePermanentShader", name, SOURCE_HUNK_RELEASE32.shader, "low");
  }

  /** tr.shaders is published before the stages; the name hash is published after them. */
  private publishStages(material: MaterialRecord): void {
    this.handles.push(material);
    this.sortedHandles.push(material);
    if (this.memory.kind === "unaccounted") return;
    for (const [index, pass] of material.finished.iterator.passes.entries()) {
      if (index >= material.finished.numUnfoggedPasses || !pass.bundles[0].active) break;
      const resource = `${material.name}#${index}`;
      this.memory.accounting.reserve("GeneratePermanentShader:stage", resource, SOURCE_HUNK_RELEASE32.shaderStage, "low");
      for (let bundle = 0; bundle < 2; bundle++) {
        const stage = pass.bundles[bundle];
        const count = stage === undefined ? 0 : stage.stage.tcMods.length;
        this.memory.accounting.reserve("GeneratePermanentShader:texMods", `${resource}/${bundle}`, count * SOURCE_HUNK_RELEASE32.texMod, "low");
      }
    }
  }

  private sortNewShader(material: MaterialRecord): void {
    let index = this.sortedHandles.length - 2;
    for (; index >= 0; index--) {
      const preceding = this.sortedHandles[index];
      if (preceding === undefined) throw new Error("Sorted shader table lost an allocated record");
      if (preceding.sort <= material.sort) break;
      this.sortedHandles[index + 1] = preceding;
      preceding.sortedIndex++;
    }
    this.onSortInsertion(index + 1);
    material.sortedIndex = index + 1;
    this.sortedHandles[index + 1] = material;
  }

  /** CreateInternalShaders reuses the default stage and inserts this marker first. */
  registerStencilShadow(defaultMaterial: MaterialRecord): MaterialRecord {
    const name = "<stencil shadow>";
    if (this.find(name) !== null) throw new Error("Internal stencil shader was already registered");
    const fallback = this.defaultWhenFull();
    if (fallback !== null) return fallback;
    this.allocateRecord(name);
    const material: MaterialRecord = { ...defaultMaterial, kind: "stencil-shadow", name, order: this.handles.length, sortedIndex: this.handles.length,
      definition: null, defaulted: false, finished: { ...defaultMaterial.finished, sort: 14, fogPass: "none" },
      sort: 14, lighting: { kind: "none" }, mip: true, remapped: null, timeOffset: 0 };
    this.publishStages(material);
    this.sortNewShader(material);
    this.publishName(material);
    return material;
  }

  register(name: string, lighting: MaterialLighting, mip = true): Promise<MaterialRecord> {
    const promise = this.preparations.then(async () => {
      if (name.length === 0 || name[0] === "\0") {
        const fallback = this.handles[0];
        if (fallback === undefined) throw new Error("Empty shader lookup has no default row");
        return fallback;
      }
      const stripped = lookupName(name);
      // Native R_FindShader completes each registration before the next lookup.
      // A preceding request may have published a default matching every lightmap.
      const preceding = this.names.get(shaderNameHash(stripped, FILE_HASH_SIZE))?.find(material =>
        (material.defaulted || sameLighting(material.lighting, lighting)) && sameShaderName(material.name, stripped));
      if (preceding !== undefined) return preceding;
      const nul = name.indexOf("\0"), sourceInput = nul === -1 ? name : name.slice(0, nul);
      const content = await this.prepare(sourceInput, lighting, mip);
      const fallback = this.defaultWhenFull();
      if (fallback !== null) return fallback;
      // FinishShader may change the lookup key. Future registrations must inspect
      // the finished key, not retain an alias for the original positive index.
      const index = content.finished.lightmapIndex;
      const finishedLighting: MaterialLighting = index === -1 ? { kind: "none" }
        : index === -2 ? { kind: "white" } : index === -3 ? { kind: "vertex" } : index === -4 ? { kind: "picture" }
          : lighting.kind === "lightmap" && lighting.index === index ? lighting
            : (() => { throw new Error(`Finished material ${stripped} has an unregistered lightmap ${index}`); })();
      // COM_StripExtension stops at the first dot; shader.name retains spelling.
      const sourceName = stripped === "*default" && this.handles.length === 0 ? "<default>" : stripped;
      this.allocateRecord(sourceName);
      const material: MaterialRecord = { ...content, kind: "ordinary", name: sourceName, order: this.handles.length, sortedIndex: this.handles.length, lighting: finishedLighting, mip, remapped: null, timeOffset: 0,
        sort: content.finished.sort };
      this.publishStages(material);
      this.sortNewShader(material);
      this.publishName(material);
      return material;
    });
    this.preparations = promise.then(() => {}, () => {});
    return promise;
  }

  /** RE_RegisterShaderFromImage uses the supplied image and does not strip the lookup name. */
  registerFromImage(name: string, lighting: MaterialLighting, image: RendererImage, _mipRawImage: boolean,
    context: { readonly whiteImage: RendererImage; readonly profile: FinishShaderProfile;
      readonly smp: () => number; readonly synchronize: () => void }): Promise<MaterialRecord> {
    const promise = this.preparations.then(() => {
      const nul = name.indexOf("\0"), sourceName = nul === -1 ? name : name.slice(0, nul);
      const cached = this.names.get(shaderNameHash(sourceName, FILE_HASH_SIZE))?.find(material =>
        (material.defaulted || sameLighting(material.lighting, lighting)) && sameShaderName(material.name, sourceName));
      if (cached !== undefined) return cached;
      if (context.smp() !== 0) context.synchronize();
      const storedName = Buffer.from(sourceName, "latin1").subarray(0, 63).toString("latin1");
      const loaded = (image: RendererImage): FinishLoadedImageMetadata => {
        const tmu = image.textureUnit;
        if (tmu !== 0 && tmu !== 1) throw new RangeError("Supplied shader image has an invalid source texture unit");
        return { kind: "loaded", tmu, binding: { kind: "images", playback: { kind: "single", image: { image } } } };
      };
      const fields = { name: storedName, baseImage: loaded(image), profile: context.profile };
      const finished = lighting.kind === "lightmap"
        ? finishImplicitShader({ ...fields, kind: "lightmap", lightmapIndex: lighting.index, lightmapImage: loaded(lighting.image) })
        : lighting.kind === "white" ? finishImplicitShader({ ...fields, kind: "white", whiteImage: loaded(context.whiteImage) })
          : finishImplicitShader({ ...fields, kind: lighting.kind === "none" ? "dynamic" : lighting.kind });
      const fallback = this.defaultWhenFull();
      if (fallback !== null) return fallback;
      const finishedLighting: MaterialLighting = finished.lightmapIndex === -3 ? { kind: "vertex" }
        : finished.lightmapIndex === -1 ? { kind: "none" } : lighting;
      this.allocateRecord(storedName);
      const material: MaterialRecord = { kind: "ordinary", name: storedName, order: this.handles.length,
        sortedIndex: this.handles.length, definition: null, defaulted: false, finished, image, whiteImage: context.whiteImage,
        sky: null, sort: finished.sort, lighting: finishedLighting, mip: true, remapped: null, timeOffset: 0 };
      this.publishStages(material);
      this.sortNewShader(material);
      this.publishName(material);
      return material;
    });
    this.preparations = promise.then(() => {}, () => {});
    return promise;
  }

  remap(original: string, replacement: MaterialRecord, offset: string | null): void {
    const stripped = lookupName(original);
    const time = offset === null ? null : remapTimeOffset(offset);
    for (const record of this.names.get(shaderNameHash(stripped, FILE_HASH_SIZE)) ?? []) {
      if (sameShaderName(record.name, stripped)) record.remapped = record === replacement ? null : replacement;
    }
    if (time !== null) replacement.timeOffset = time;
  }
}

/** RB_BeginSurface resolves exactly one link; chains and cycles are not traversed. */
export function resolvedMaterial(material: MaterialRecord): MaterialRecord { return material.remapped ?? material; }

/** C converts the integer to float before multiplying by the float literal. */
export function rendererFloatTime(milliseconds: number): number { return Math.fround(Math.fround(milliseconds) * Math.fround(0.001)); }
