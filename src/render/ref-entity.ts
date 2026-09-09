// Source refEntity_t variants from id Software code/cgame/tr_types.h.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import type { RendererBspMap } from "./bsp-resource.ts";
import type { Md3Model, SkinSurface } from "../assets/md3.ts";
import type { Axis, Vec2, Vec3, Vec4 } from "../core/math.ts";
import type { Md4Resource } from "./md4-resource.ts";

export type Md3Slots = readonly [Md3Model | null, Md3Model | null, Md3Model | null];
export interface FileModelSlots {
  readonly path: string;
  readonly md3: Md3Slots;
  readonly numLods: number;
}
export interface SceneMd3Model extends FileModelSlots {
  readonly kind: "md3";
  readonly md4: Md4Resource | null;
}
export interface SceneMd4Model extends FileModelSlots {
  readonly kind: "md4";
  readonly md4: Md4Resource;
}
export interface SceneBadModel extends FileModelSlots {
  readonly kind: "bad";
  readonly md4: Md4Resource | null;
}
export interface SceneInlineModel {
  readonly kind: "inline";
  readonly path: string;
  readonly index: number;
  readonly map: Pick<RendererBspMap, "models" | "shaders"> & {
    readonly surfaces: readonly Pick<RendererBspMap["surfaces"][number], "type" | "shader" | "fog">[];
  };
}
export interface SceneDefaultModel { readonly kind: "default"; readonly path: "*default" }
export type SceneModel = SceneMd3Model | SceneMd4Model | SceneBadModel | SceneInlineModel | SceneDefaultModel;
export interface SceneSkin { readonly path: string; readonly surfaces: readonly SkinSurface[] }
export interface SceneShader { readonly name: string }
export const DEFAULT_MODEL: SceneDefaultModel = Object.freeze({ kind: "default", path: "*default" });

export const RF_MINLIGHT = 1;
export const RF_THIRD_PERSON = 2;
export const RF_FIRST_PERSON = 4;
export const RF_DEPTHHACK = 8;
export const RF_NOSHADOW = 64;
export const RF_LIGHTING_ORIGIN = 128;
export const RF_SHADOW_PLANE = 256;
export const RF_WRAP_FRAMES = 512;

interface ShadedEntity {
  renderFlags: number;
  customShader: SceneShader | null;
  /** Source byte channels, including zero defaults from Com_Memset. */
  shaderRGBA: Vec4;
  shaderTexCoord: Vec2;
  /** Seconds subtracted from the submitted scene shader clock. */
  shaderTime: number;
}
export interface RefModelEntity extends ShadedEntity {
  kind: "model";
  model: SceneModel;
  origin: Vec3;
  oldOrigin: Vec3;
  axis: Axis;
  nonNormalizedAxes: boolean;
  lightingOrigin: Vec3;
  shadowPlane: number;
  frame: number;
  oldFrame: number;
  backLerp: number;
  skinNum: number;
  customSkin: SceneSkin | null;
}
export interface RefSpriteEntity extends ShadedEntity {
  kind: "sprite";
  origin: Vec3;
  radius: number;
  rotation: number;
}
export interface RefBeamEntity extends ShadedEntity {
  kind: "beam";
  origin: Vec3;
  oldOrigin: Vec3;
  axis: Axis;
  /** Used for source sprite-fog selection; beam geometry has fixed radius four. */
  radius: number;
}
export interface RefRailCoreEntity extends ShadedEntity {
  kind: "rail-core";
  origin: Vec3;
  oldOrigin: Vec3;
  radius: number;
}
export interface RefRailRingsEntity extends ShadedEntity {
  kind: "rail-rings";
  origin: Vec3;
  oldOrigin: Vec3;
  radius: number;
}
export interface RefLightningEntity extends ShadedEntity {
  kind: "lightning";
  origin: Vec3;
  oldOrigin: Vec3;
  radius: number;
}
export type RefRailEntity = RefRailCoreEntity | RefRailRingsEntity | RefLightningEntity;
export interface RefPolyVertex {
  readonly position: Vec3;
  readonly texCoord: Vec2;
  /** Source polyVert_t.modulate byte channels. */
  readonly color: Vec4;
}
export interface RefPoly {
  readonly shader: SceneShader | null;
  readonly vertices: readonly RefPolyVertex[];
}
export interface RefPortalEntity {
  kind: "portal-surface";
  renderFlags: number;
  origin: Vec3;
  oldOrigin: Vec3;
  axis: Axis;
  frame: number;
  oldFrame: number;
  skinNum: number;
}
export type RefEntity = RefModelEntity | RefSpriteEntity | RefBeamEntity | RefRailEntity | RefPortalEntity;

type SourceHandles<Entity> = {
  [Property in keyof Entity]: Property extends "model" | "customShader" | "customSkin" ? Entity[Property] | number : Entity[Property];
};
interface SourceRefEntityFields extends Omit<SourceHandles<RefModelEntity>, "kind"> {
  radius: number;
  rotation: number;
}
/** The complete refEntity_t value survives admission, including retained backend pose reads. */
export type SourceRefEntityRecord = {
  [Kind in RefEntity["kind"] | "poly"]: SourceRefEntityFields & { kind: Kind };
}[RefEntity["kind"] | "poly"];
/** Typed producers retain their existing shapes; VM handles stay numeric until consumed. */
export type SourceRefEntity = SourceHandles<RefEntity> | SourceRefEntityRecord;

function zero(): Vec3 { return { x: 0, y: 0, z: 0 }; }
function zeroAxis(): Axis { return [zero(), zero(), zero()]; }
function shading(): ShadedEntity {
  return { renderFlags: 0, customShader: null, shaderRGBA: { x: 0, y: 0, z: 0, w: 0 }, shaderTexCoord: { x: 0, y: 0 }, shaderTime: 0 };
}
export function createModelEntity(model: SceneModel = DEFAULT_MODEL): RefModelEntity {
  return { ...shading(), kind: "model", model, origin: zero(), oldOrigin: zero(), axis: zeroAxis(), nonNormalizedAxes: false,
    lightingOrigin: zero(), shadowPlane: 0, frame: 0, oldFrame: 0, backLerp: 0, skinNum: 0, customSkin: null };
}
export function createSpriteEntity(): RefSpriteEntity {
  return { ...shading(), kind: "sprite", origin: zero(), radius: 0, rotation: 0 };
}
export function createBeamEntity(): RefBeamEntity {
  return { ...shading(), kind: "beam", origin: zero(), oldOrigin: zero(), axis: zeroAxis(), radius: 0 };
}
export function createRailCoreEntity(): RefRailCoreEntity {
  return { ...shading(), kind: "rail-core", origin: zero(), oldOrigin: zero(), radius: 0 };
}
export function createRailRingsEntity(): RefRailRingsEntity {
  return { ...shading(), kind: "rail-rings", origin: zero(), oldOrigin: zero(), radius: 0 };
}
export function createLightningEntity(): RefLightningEntity {
  return { ...shading(), kind: "lightning", origin: zero(), oldOrigin: zero(), radius: 0 };
}
export function createPortalEntity(): RefPortalEntity {
  return { kind: "portal-surface", renderFlags: 0, origin: zero(), oldOrigin: zero(), axis: zeroAxis(), frame: 0, oldFrame: 0, skinNum: 0 };
}

/** RE_AddRefEntityToScene owns a value copy; resource handle identity is retained. */
export function copyRefEntity(entity: RefEntity): RefEntity {
  if (entity.kind === "portal-surface") return { ...entity, origin: { ...entity.origin }, oldOrigin: { ...entity.oldOrigin },
    axis: [{ ...entity.axis[0] }, { ...entity.axis[1] }, { ...entity.axis[2] }] };
  const color = { ...entity.shaderRGBA }, texCoord = { ...entity.shaderTexCoord };
  if (entity.kind === "sprite") return { ...entity, origin: { ...entity.origin }, shaderRGBA: color, shaderTexCoord: texCoord };
  if (entity.kind === "beam") return { ...entity, origin: { ...entity.origin }, oldOrigin: { ...entity.oldOrigin },
    axis: [{ ...entity.axis[0] }, { ...entity.axis[1] }, { ...entity.axis[2] }], shaderRGBA: color, shaderTexCoord: texCoord };
  if (entity.kind !== "model") return { ...entity, origin: { ...entity.origin }, oldOrigin: { ...entity.oldOrigin }, shaderRGBA: color, shaderTexCoord: texCoord };
  return { ...entity, origin: { ...entity.origin }, oldOrigin: { ...entity.oldOrigin }, lightingOrigin: { ...entity.lightingOrigin },
    axis: [{ ...entity.axis[0] }, { ...entity.axis[1] }, { ...entity.axis[2] }], shaderRGBA: color, shaderTexCoord: texCoord };
}

export function copySourceRefEntity(entity: SourceRefEntity): SourceRefEntity {
  if ("lightingOrigin" in entity) return { ...entity, origin: { ...entity.origin }, oldOrigin: { ...entity.oldOrigin },
    lightingOrigin: { ...entity.lightingOrigin }, axis: [{ ...entity.axis[0] }, { ...entity.axis[1] }, { ...entity.axis[2] }],
    shaderRGBA: { ...entity.shaderRGBA }, shaderTexCoord: { ...entity.shaderTexCoord } };
  if (entity.kind === "portal-surface") return { ...entity, origin: { ...entity.origin }, oldOrigin: { ...entity.oldOrigin },
    axis: [{ ...entity.axis[0] }, { ...entity.axis[1] }, { ...entity.axis[2] }] };
  const color = { ...entity.shaderRGBA }, texCoord = { ...entity.shaderTexCoord };
  if (entity.kind === "sprite") return { ...entity, origin: { ...entity.origin }, shaderRGBA: color, shaderTexCoord: texCoord };
  if (entity.kind === "beam") return { ...entity, origin: { ...entity.origin }, oldOrigin: { ...entity.oldOrigin },
    axis: [{ ...entity.axis[0] }, { ...entity.axis[1] }, { ...entity.axis[2] }], shaderRGBA: color, shaderTexCoord: texCoord };
  return { ...entity, origin: { ...entity.origin }, oldOrigin: { ...entity.oldOrigin }, shaderRGBA: color, shaderTexCoord: texCoord };
}

export function copyRefPoly(poly: RefPoly): RefPoly {
  return { shader: poly.shader, vertices: poly.vertices.map(vertex => ({ position: { ...vertex.position },
    texCoord: { ...vertex.texCoord }, color: { ...vertex.color } })) };
}
