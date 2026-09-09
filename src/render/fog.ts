// BSP fog volumes, coordinates and lookup texture translated from id Software's
// GPL-2.0-or-later renderer/tr_bsp.c, tr_shade_calc.c, tr_shade.c and tr_image.c.
import type { BspMap } from "../assets/bsp.ts";
import { dot3, scale3, sub3 } from "../core/math.ts";
import type { Bounds, Plane, Vec2, Vec3, Vec4 } from "../core/math.ts";
import type { ShaderDefinition, ShaderStage } from "./material.ts";
import type { RenderState, TextureImage } from "./types.ts";

export interface FogVolume {
  readonly bounds: Bounds;
  /** The inward-facing plane; positive distance is inside fog. */
  readonly surface: Plane | null;
  readonly color: Vec4;
  readonly tcScale: number;
}
export type FogAdjustment = "none" | "rgb" | "alpha" | "rgba";
export type FogPass = "none" | "equal" | "less-equal";

function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new RangeError(`fog index ${index} outside ${items.length}`);
  return value;
}

/** R_LoadFogs reads the six axial brush sides before the optional visible side. */
export function prepareFogVolume(map: BspMap, index: number, parameters: NonNullable<ShaderDefinition["fog"]>): FogVolume {
  const fog = at(map.fogs, index), brush = at(map.brushes, fog.brush);
  if (brush.sideCount < 6) throw new Error(`fog brush ${fog.brush} has fewer than six axial sides`);
  const plane = (side: number): Plane => at(map.planes, at(map.brushSides, brush.firstSide + side).plane);
  const bounds = { min: { x: -plane(0).distance, y: -plane(2).distance, z: -plane(4).distance },
    max: { x: plane(1).distance, y: plane(3).distance, z: plane(5).distance } };
  const outsidePlane = fog.visibleSide < 0 ? null : plane(fog.visibleSide);
  const surface = outsidePlane === null ? null : { normal: sub3({ x: 0, y: 0, z: 0 }, outsidePlane.normal), distance: -outsidePlane.distance };
  const byte = (value: number): number => (Math.trunc(Math.fround(value * 255)) & 255) / 255;
  return { bounds, surface, color: { x: byte(parameters.color.x), y: byte(parameters.color.y), z: byte(parameters.color.z), w: 1 },
    tcScale: Math.fround(1 / Math.fround(Math.max(1, parameters.depthForOpaque) * 8)) };
}

/** Renderer distance is camera-forward depth, with the source half-texel S bias. */
export function fogCoordinates(fog: FogVolume, origin: Vec3, forward: Vec3): (position: Vec3) => Vec2 {
  const distanceVector = scale3(forward, fog.tcScale);
  const offset = Math.fround(Math.fround(dot3(sub3({ x: 0, y: 0, z: 0 }, origin), forward) * fog.tcScale) + 1 / 512);
  const surface = fog.surface;
  const eyeDepth = surface === null ? 1 : Math.fround(dot3(origin, surface.normal) - surface.distance);
  return position => {
    const x = Math.fround(dot3(position, distanceVector) + offset);
    // The original declares non-surface fog constant, but reads an uninitialized
    // depth vector afterwards. Define the documented constant-interior case.
    if (surface === null) return { x, y: 31 / 32 };
    const depth = Math.fround(dot3(position, surface.normal) - surface.distance);
    const y = eyeDepth < 0
      ? depth < 1 ? 1 / 32 : Math.fround(1 / 32 + Math.fround(Math.fround(30 / 32 * depth) / Math.fround(depth - eyeDepth)))
      : depth < 0 ? 1 / 32 : 31 / 32;
    return { x, y };
  };
}

const FOG_TABLE: readonly number[] = Array.from({ length: 256 }, (_, index) => Math.fround(Math.sqrt(Math.fround(index / 255))));

/** R_FogFactor quantizes sqrt density through the 256-entry renderer table. */
export function fogFactor(s: number, t: number): number {
  let distance = Math.fround(s - 1 / 512);
  if (distance < 0 || t < 1 / 32) return 0;
  if (t < 31 / 32) distance = Math.fround(distance * Math.fround(Math.fround(t - 1 / 32) / (30 / 32)));
  distance = Math.fround(distance * 8);
  if (distance > 1) distance = 1;
  return at(FOG_TABLE, Math.trunc(Math.fround(distance * 255)));
}

export function createFogTexture(pixels: Uint8Array = new Uint8Array(256 * 32 * 4)): TextureImage {
  if (pixels.length !== 256 * 32 * 4) throw new RangeError("Fog texture requires 256x32 RGBA bytes");
  for (let y = 0; y < 32; y++) for (let x = 0; x < 256; x++) {
    const density = fogFactor((x + 0.5) / 256, (y + 0.5) / 32);
    pixels.set([255, 255, 255, Math.trunc(Math.fround(255 * density))], (y * 256 + x) * 4);
  }
  return { width: 256, height: 32, pixels };
}

function isBlended(blend: RenderState["blend"]): boolean { return blend.source !== "one" || blend.destination !== "zero"; }

export function fogAdjustment(stage: ShaderStage, first: ShaderStage): FogAdjustment {
  if (!isBlended(stage.blend) || !isBlended(first.blend)) return "none";
  const { source, destination } = stage.blend;
  if (source === "one" && destination === "one" || source === "zero" && destination === "one-minus-src-color") return "rgb";
  if (source === "src-alpha" && destination === "one-minus-src-alpha") return "alpha";
  if (source === "one" && destination === "one-minus-src-alpha") return "rgba";
  return "none";
}

export function attenuateFogColor(color: Vec4, adjustment: FogAdjustment, coordinates: Vec2): Vec4 {
  if (adjustment === "none") return color;
  const attenuation = Math.fround(1 - fogFactor(coordinates.x, coordinates.y));
  const modulate = (component: number): number => Math.trunc(Math.fround(Math.round(component * 255) * attenuation)) / 255;
  const rgb = adjustment === "rgb" || adjustment === "rgba", alpha = adjustment === "alpha" || adjustment === "rgba";
  return { x: rgb ? modulate(color.x) : color.x, y: rgb ? modulate(color.y) : color.y, z: rgb ? modulate(color.z) : color.z, w: alpha ? modulate(color.w) : color.w };
}

/** FinishShader and GeneratePermanentShader choose fog depth from final material sort. */
export function shaderSort(shader: ShaderDefinition | null): number {
  if (shader === null) return 3;
  if (shader.stages.length === 0) return 7;
  if (shader.sky !== null) return 2;
  if (shader.sort !== null && shader.sort !== 0) return shader.sort;
  if (shader.polygonOffset) return 4;
  const first = at(shader.stages, 0);
  return isBlended(first.blend) ? first.depthWrite ? 5 : 9 : 3;
}

export function shaderFogPass(shader: ShaderDefinition | null): FogPass {
  if (shaderSort(shader) <= 3) return "equal";
  return shader !== null && shader.surfaceParms.includes("fog") ? "less-equal" : "none";
}

export function fogPassState(pass: Exclude<FogPass, "none">, cull: RenderState["cull"]): RenderState {
  return { blend: { source: "src-alpha", destination: "one-minus-src-alpha" }, depthTest: pass, depthWrite: false,
    alphaTest: "none", cull };
}
