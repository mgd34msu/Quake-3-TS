// SPDX-License-Identifier: GPL-2.0-or-later
// MD3/MD4 registration/orientation and stage lighting from id Software's
// renderer/tr_model.c, tr_image.c, tr_main.c, tr_light.c and tr_shade_calc.c.
import { iterateSkinSurfaces } from "../assets/md3.ts";
import type { Md3Model, SkinSurface } from "../assets/md3.ts";
import { normalizeAssetPath } from "../assets/pk3.ts";
import { add3, dot3, length3, sub3, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { inverseSqrt32, normalizeFast3 } from "../core/renderer-math.ts";
import type { EntityLighting } from "./lighting.ts";
import type { RetainedFileReader } from "../assets/read-file-memory.ts";
import { BinaryReader } from "../core/binary.ts";
import { loadMd3Resource } from "./md3-resource.ts";
import { loadMd4Resource } from "./md4-resource.ts";
import type { Md4Resource } from "./md4-resource.ts";
import type { MaterialRecord } from "./material-registry.ts";

import type { RefModelEntity, SceneInlineModel, SceneModel, SceneSkin } from "./ref-entity.ts";
import { DEFAULT_MODEL } from "./ref-entity.ts";
import type { HunkAccountingProfile } from "./hunk-accounting.ts";

interface FileModelRecord {
  readonly kind: "file";
  readonly name: string;
  dataSize: number;
  loadKind: "md3" | "md4" | null;
  readonly md3: [Md3Model | null, Md3Model | null, Md3Model | null];
  pending: Promise<SceneModel> | null;
  result: SceneModel;
}
type ModelRecord = FileModelRecord | { readonly kind: "inline"; readonly name: string; readonly dataSize: 0; readonly result: SceneInlineModel };
interface SkinRecord {
  readonly name: string;
  readonly surfaces: { readonly surface: SkinSurface; readonly material: MaterialRecord }[];
  readonly result: SceneSkin;
}

function skinNameKey(name: string): string {
  return name.replace(/[A-Z]/g, letter => letter.toLowerCase());
}

/** Handles belong to one renderer resource lifetime, independent of a loaded world. */
export class SceneModelRegistry {
  // R_ModelInit reserves index zero, which R_Modellist_f does not visit.
  private readonly models: ModelRecord[] = [];
  private readonly skins: SkinRecord[] = [];
  private readonly ownedModels = new WeakSet<SceneModel>();
  private readonly ownedSkins = new WeakSet<SceneSkin>();

  constructor(private readonly assets: RetainedFileReader, private readonly material: (name: string) => Promise<MaterialRecord>,
    private readonly hunk: HunkAccountingProfile, private readonly defaultMaterial: MaterialRecord,
    private readonly print: (text: string) => undefined, private readonly shaderForHandle: (index: number) => MaterialRecord | null,
    private readonly syncRenderThread: () => void) {}

  initializeSkins(): void {
    this.skins.length = 0;
    if (this.hunk.kind === "source-hunk") this.hunk.accounting.defaultSkinRecord();
    const publishedSurfaces: SkinSurface[] = [];
    const record: SkinRecord = { name: "<default skin>", surfaces: [],
      result: { path: "<default skin>", surfaces: publishedSurfaces } };
    this.skins.push(record);
    if (this.hunk.kind === "source-hunk") this.hunk.accounting.defaultSkinSurface();
    const surface = { name: "", shader: this.defaultMaterial.name };
    record.surfaces.push({ surface, material: this.defaultMaterial });
    publishedSurfaces.push(surface);
  }

  initializeModels(): void {
    this.models.length = 0;
    if (this.hunk.kind === "source-hunk") this.hunk.accounting.defaultModelRecord();
  }

  registerModel(path: string | null): Promise<SceneModel> {
    if (path === null || path.length === 0) {
      this.print("RE_RegisterModel: NULL name\n");
      return Promise.resolve(DEFAULT_MODEL);
    }
    if (path.length >= 64) {
      this.print("Model name exceeds MAX_QPATH\n");
      return Promise.resolve(DEFAULT_MODEL);
    }
    const cached = this.models.find(model => model.name === path);
    if (cached !== undefined) {
      if (cached.kind === "file" && cached.pending !== null && cached.loadKind !== cached.result.kind) return cached.pending;
      return Promise.resolve(cached.result.kind === "bad" ? DEFAULT_MODEL : cached.result);
    }
    const filename = normalizeAssetPath(path);
    if (this.models.length === 1023) {
      this.print(`RE_RegisterModel: R_AllocModel() failed for '${path}'\n`);
      return Promise.resolve(DEFAULT_MODEL);
    }
    if (this.hunk.kind === "source-hunk") this.hunk.accounting.modelRecord(path);
    const md3: FileModelRecord["md3"] = [null, null, null];
    const result: SceneModel = { kind: "bad", path, md3, md4: null, numLods: 0 };
    this.ownedModels.add(result);
    const record: FileModelRecord = { kind: "file", name: path, dataSize: 0, loadKind: null, md3, pending: null, result };
    this.models.push(record);
    try {
      this.syncRenderThread();
    } catch (error) {
      return Promise.reject(error);
    }
    const completion = Promise.withResolvers<SceneModel>();
    record.pending = completion.promise;
    completion.resolve(this.loadModel(filename, record).finally(() => { record.pending = null; }));
    return completion.promise;
  }

  allocateInlineModels(models: readonly SceneInlineModel[]): void {
    for (const model of models) {
      if (this.models.length === 1023) throw new Error("R_LoadSubmodels: MAX_MOD_KNOWN exceeded");
      if (this.hunk.kind === "source-hunk") this.hunk.accounting.modelRecord(model.path);
      this.models.push({ kind: "inline", name: model.path, dataSize: 0, result: model });
    }
  }

  modelHandle(model: SceneModel): number {
    if (model === DEFAULT_MODEL) return 0;
    const index = this.models.findIndex(record => record.result === model);
    if (index < 0) throw new Error("model handle belongs to another renderer or is unregistered");
    return index + 1;
  }

  /** tr.currentModel->name retains registration spelling, unlike the normalized asset path. */
  modelName(model: SceneModel): string {
    const record = this.models.find(record => record.result === model);
    if (record === undefined) throw new Error("model name belongs to another renderer or is unregistered");
    return record.name;
  }

  /** R_GetModelByHandle includes retained MOD_BAD rows in the source range. */
  modelForHandle(handle: number): SceneModel {
    if (!Number.isInteger(handle)) throw new RangeError("Model handle must be an integer");
    return this.models[handle - 1]?.result ?? DEFAULT_MODEL;
  }

  skinHandle(skin: SceneSkin | null): number {
    if (skin === null) return 0;
    const index = this.skins.findIndex(record => record.result === skin);
    if (index < 0) throw new Error("skin handle belongs to another renderer or is unregistered");
    return index;
  }

  /** R_AddMD3Surfaces checks this range before calling R_GetSkinByHandle. */
  skinForHandle(handle: number): SceneSkin | null {
    if (!Number.isInteger(handle)) throw new RangeError("Skin handle must be an integer");
    return handle > 0 ? this.skins[handle]?.result ?? null : null;
  }

  private async loadModel(path: string, record: FileModelRecord): Promise<SceneModel> {
    const md3 = record.md3, sourcePath = record.name;
    let md4: Md4Resource | null = null;
    let numLods = 0;
    let lod = 2;
    const fail = (): SceneModel => {
      record.loadKind = null;
      const result: SceneModel = { kind: "bad", path: sourcePath, md3, md4, numLods };
      this.ownedModels.add(result);
      record.result = result;
      return DEFAULT_MODEL;
    };
    const publishMd4 = (resource: Md4Resource): undefined => {
      md4 = resource;
      const result: SceneModel = { kind: "md4", path, md3, md4: resource, get numLods() { return numLods; } };
      this.ownedModels.add(result);
      record.result = result;
    };
    const publishMd3 = (resource: Md3Model): undefined => {
      md3[lod] = resource;
      const result: SceneModel = { kind: "md3", path, md3, md4, get numLods() { return numLods; } };
      this.ownedModels.add(result);
      record.result = result;
    };
    const dot = path.lastIndexOf("."), stem = dot < 0 ? path : path.slice(0, dot);
    const sourceDot = sourcePath.lastIndexOf("."), sourceStem = sourceDot < 0 ? sourcePath : sourcePath.slice(0, sourceDot);
    for (; lod >= 0; lod--) {
      const filename = lod === 0 ? path : `${stem}_${lod}.md3`;
      const sourceFilename = lod === 0 ? sourcePath : `${sourceStem}_${lod}.md3`;
      const file = await this.assets.readFileRetained(sourceFilename);
      if (file === undefined) continue;
      const bytes = file.bytes;
      const accounting = this.hunk.kind === "source-hunk" ? this.hunk.accounting : null;
      let loaded = false;
      const header = new BinaryReader(bytes, filename), ident = header.u32();
      if (ident !== 0x33504449 && ident !== 0x34504449) {
        // The source unknown-ID goto fail bypasses FS_FreeFile and caches MOD_BAD.
        this.print(`RE_RegisterModel: unknown fileid for ${sourcePath}\n`);
        return fail();
      }
      if (ident === 0x34504449) {
        const resource = await loadMd4Resource({ bytes, source: sourcePath, material: this.material, defaultMaterial: this.defaultMaterial,
          registration: {
            allocate: size => {
              record.loadKind = "md4";
              record.dataSize = (record.dataSize + size) | 0;
              if (md4 !== null) publishMd4(md4);
              return accounting === null ? new Uint8Array(size) : accounting.md4Allocation(filename, size);
            },
            publish: publishMd4, print: this.print, shaderForHandle: this.shaderForHandle,
          } });
        loaded = resource !== null;
      } else {
        const resource = await loadMd3Resource({ bytes, source: sourcePath, material: this.material,
          registration: {
            allocate: size => {
              record.loadKind = "md3";
              record.dataSize = (record.dataSize + size) | 0;
              return accounting === null ? new Uint8Array(size) : accounting.md3Allocation(filename, size);
            }, publish: publishMd3, print: this.print,
          } });
        loaded = resource !== null;
      }
      this.assets.freeFile(file);
      if (!loaded) {
        if (lod === 0) return fail();
        break;
      }
      numLods++;
    }
    const kind = record.loadKind;
    if (numLods === 0 || kind === null) return fail();
    // This runs only below a nonzero failed load, not after missing files exhaust the loop.
    for (lod--; lod >= 0; lod--) {
      const alias = md3[lod + 1];
      if (alias === undefined) throw new RangeError("Model LOD duplication exceeded source slots");
      md3[lod] = alias;
      numLods++;
    }
    const result: SceneModel = kind === "md3" ? { kind, path, md3, md4, numLods }
      : md4 === null ? (() => { throw new Error("Loaded MD4 has no owned resource"); })()
        : { kind, path, md3, md4, numLods };
    this.ownedModels.add(result);
    record.result = result;
    return result;
  }

  registerSkin(path: string): Promise<SceneSkin | null> {
    if (path.length === 0) {
      this.print("Empty name passed to RE_RegisterSkin\n");
      return Promise.resolve(null);
    }
    if (path.length >= 64) {
      this.print("Skin name exceeds MAX_QPATH\n");
      return Promise.resolve(null);
    }
    const key = normalizeAssetPath(path);
    const sourceKey = skinNameKey(path);
    const cached = this.skins.find((skin, index) => index !== 0 && skinNameKey(skin.name) === sourceKey);
    if (cached !== undefined) return Promise.resolve(cached.surfaces.length === 0 ? null : cached.result);
    if (this.skins.length === 1024) {
      this.print(`WARNING: RE_RegisterSkin( '${path}' ) MAX_SKINS hit\n`);
      return Promise.resolve(null);
    }
    const accounting = this.hunk.kind === "source-hunk" ? this.hunk.accounting : null;
    if (accounting !== null) accounting.skinRecord(path);
    const completion = Promise.withResolvers<SceneSkin | null>();
    const publishedSurfaces: SkinSurface[] = [];
    const result: SceneSkin = { path: key, surfaces: publishedSurfaces };
    const record: SkinRecord = { name: path, surfaces: [], result };
    this.skins.push(record);
    this.ownedSkins.add(result);
    completion.resolve((async (): Promise<SceneSkin | null> => {
      this.syncRenderThread();
      const file = path.endsWith(".skin") ? await this.assets.readFileRetained(path) : null;
      if (file === undefined) return null;
      let text = "";
      if (file !== null) for (const byte of file.bytes) text += String.fromCharCode(byte);
      const surfaces = file !== null ? iterateSkinSurfaces(text) : [{ name: "", shader: key }];
      for (const surface of surfaces) {
        if (accounting !== null) accounting.skinSurface(path, file === null);
        const material = await this.material(file === null ? path : surface.shader);
        record.surfaces.push({ surface, material });
        publishedSurfaces.push(surface);
      }
      if (file !== null) this.assets.freeFile(file);
      return publishedSurfaces.length === 0 ? null : result;
    })());
    return completion.promise;
  }

  /** R_Modellist_f. Async registration can expose its current partial records. */
  listModels(print: (text: string) => undefined): void {
    let total = 0;
    for (const model of this.models) {
      let lods = 1;
      if (model.kind === "file") {
        const [first, second, third] = model.md3;
        if (second !== null && second !== first) lods++;
        if (third !== null && third !== second) lods++;
      }
      print(`${String(model.dataSize).padStart(8)} : (${lods}) ${model.name}\n`);
      total = (total + model.dataSize) | 0;
    }
    print(`${String(total).padStart(8)} : Total models\n`);
  }

  /** R_SkinList_f reads the registered shader, not its remapped target. */
  listSkins(print: (text: string) => undefined): void {
    print("------------------\n");
    for (const [index, skin] of this.skins.entries()) {
      print(`${String(index).padStart(3)}:${skin.name}\n`);
      for (const { surface, material } of skin.surfaces) print(`       ${surface.name} = ${material.name}\n`);
    }
    print("------------------\n");
  }

  validateModel(model: SceneModel): void {
    if ((model.kind === "md3" || model.kind === "md4" || model.kind === "bad") && !this.ownedModels.has(model)) throw new Error("model handle belongs to another renderer or is unregistered");
  }

  validateSkin(skin: SceneSkin): void {
    if (!this.ownedSkins.has(skin)) throw new Error("skin handle belongs to another renderer or is unregistered");
  }

  validateParameters(entity: Omit<RefModelEntity, "model" | "customShader" | "customSkin">): void {
    if (!Number.isInteger(entity.renderFlags) || entity.renderFlags < -0x80000000 || entity.renderFlags > 0x7fffffff) {
      throw new RangeError(`model renderFlags ${entity.renderFlags}: flags require a signed int32`);
    }
    for (const value of [entity.shaderRGBA.x, entity.shaderRGBA.y, entity.shaderRGBA.z, entity.shaderRGBA.w]) {
      if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError("model shaderRGBA requires byte values");
    }
    if (![entity.shaderTime, entity.shaderTexCoord.x, entity.shaderTexCoord.y, entity.lightingOrigin.x, entity.lightingOrigin.y, entity.lightingOrigin.z, entity.shadowPlane].every(Number.isFinite)) {
      throw new RangeError("model shader and lighting parameters must be finite");
    }
  }

  validate(entity: RefModelEntity): void {
    this.validateModel(entity.model);
    if (entity.model.kind === "md3" && entity.customShader === null && entity.customSkin !== null) this.validateSkin(entity.customSkin);
    this.validateParameters(entity);
  }
}

/** R_RotateForEntity uses reciprocal first-axis length, including its scaled-axis convention. */
export function modelViewOrigin(entity: Pick<RefModelEntity, "origin" | "axis" | "nonNormalizedAxes">, camera: Vec3): Vec3 {
  const relative = sub3(camera, entity.origin), length = length3(entity.axis[0]);
  const scale = entity.nonNormalizedAxes ? length === 0 ? 0 : Math.fround(1 / length) : 1;
  return vec3(dot3(relative, entity.axis[0]) * scale, dot3(relative, entity.axis[1]) * scale, dot3(relative, entity.axis[2]) * scale);
}

export function modelWorldPoint(entity: Pick<RefModelEntity, "origin" | "axis">, local: Vec3): Vec3 {
  return add3(vec3(dot3(local, { x: entity.axis[0].x, y: entity.axis[1].x, z: entity.axis[2].x }),
    dot3(local, { x: entity.axis[0].y, y: entity.axis[1].y, z: entity.axis[2].y }),
    dot3(local, { x: entity.axis[0].z, y: entity.axis[1].z, z: entity.axis[2].z })), entity.origin);
}

/** RB_CalcDiffuseColor outputs unsigned bytes, including source truncation. */
export function diffuseColor(normal: Vec3, lighting: EntityLighting): Vec3 {
  const incoming = dot3(normal, lighting.lightDir);
  if (incoming <= 0) return { x: lighting.ambientLightInt & 255, y: lighting.ambientLightInt >>> 8 & 255, z: lighting.ambientLightInt >>> 16 & 255 };
  const component = (ambient: number, directed: number): number => Math.min(255, Math.trunc(Math.fround(ambient + Math.fround(incoming * directed)))) & 255;
  return { x: component(lighting.ambientLight.x, lighting.directedLight.x), y: component(lighting.ambientLight.y, lighting.directedLight.y), z: component(lighting.ambientLight.z, lighting.directedLight.z) };
}

/** The stock specular helper uses this fixed local light, not entity dynamic lights. */
export function specularAlpha(position: Vec3, normal: Vec3, viewerOrigin: Vec3): number {
  const light = normalizeFast3(sub3({ x: -960, y: 1980, z: 96 }, position));
  const d = dot3(normal, light);
  const reflected = vec3(Math.fround(Math.fround(normal.x * 2) * d) - light.x,
    Math.fround(Math.fround(normal.y * 2) * d) - light.y, Math.fround(Math.fround(normal.z * 2) * d) - light.z);
  const viewer = sub3(viewerOrigin, position);
  let l = Math.fround(dot3(reflected, viewer) * inverseSqrt32(dot3(viewer, viewer)));
  if (l < 0) return 0;
  l = Math.fround(l * l); l = Math.fround(l * l);
  return Math.min(255, Math.trunc(Math.fround(l * 255)));
}
