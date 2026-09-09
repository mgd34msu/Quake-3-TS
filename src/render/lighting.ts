/*
 * BSP light-grid loading and entity lighting translated from renderer/tr_bsp.c
 * and renderer/tr_light.c. Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { BspLightGridPoint, BspMap } from "../assets/bsp.ts";
import type { Axis, Vec3 } from "../core/math.ts";
import { add3, dot3, length3, normalize3, normalize3OrZero, scale3, sub3, vec3 } from "../core/math.ts";
import { rendererSine } from "../core/renderer-math.ts";
import { RF_FIRST_PERSON } from "./ref-entity.ts";

export const RF_MINLIGHT = 1;
export const RF_LIGHTING_ORIGIN = 128;

export interface LightGrid {
  readonly origin: Vec3;
  readonly size: Vec3;
  readonly inverseSize: Vec3;
  /** Sample counts, with X varying fastest in samples. */
  readonly bounds: Vec3;
  readonly samples: readonly BspLightGridPoint[];
}

export interface LightingScales {
  readonly ambientScale: number;
  readonly directedScale: number;
}

export interface LightingSample {
  /** RGB in source byte units, not normalized to 0..1. */
  readonly ambientLight: Vec3;
  readonly directedLight: Vec3;
  readonly lightDir: Vec3;
}

export interface LightingEntity {
  readonly origin: Vec3;
  readonly lightingOrigin: Vec3;
  readonly axis: Axis;
  readonly renderFlags: number;
}

export interface DynamicLight {
  readonly origin: Vec3;
  readonly radius: number;
  readonly color: Vec3;
  /** RE_AddLightToScene is modulative; RE_AddAdditiveLightToScene sets this flag. */
  readonly additive?: boolean;
}

export interface EntityLightingState extends LightingScales {
  readonly grid: LightGrid | null;
  readonly noWorldModel: boolean;
  readonly identityLight: number;
  readonly identityLightByte: number;
  readonly sunDirection: Vec3;
  readonly dynamicLights: readonly DynamicLight[];
}

export interface EntityLighting extends LightingSample {
  /** Unsigned little-endian RGBA packet. lightDir is in entity-local space. */
  readonly ambientLightInt: number;
}

export type EntityLightingStorage = { -readonly [Key in keyof EntityLighting]: EntityLighting[Key] };

export interface EntityLightingDiagnostics {
  readonly enabled: boolean;
  print(text: string): undefined;
}

const f = Math.fround;

function shiftedColor(color: Vec3, shift: number): Vec3 {
  const r = color.x << shift, g = color.y << shift, b = color.z << shift;
  if ((r | g | b) <= 255) return vec3(r, g, b);
  const maximum = Math.max(r, g, b);
  // R_ColorShiftLightingBytes uses integer division, preserving color ratios.
  return vec3(Math.trunc(r * 255 / maximum), Math.trunc(g * 255 / maximum), Math.trunc(b * 255 / maximum));
}

function gridFloat(token: string): number {
  const value = token.trim().toLowerCase();
  if (!/^[+-]?0x/.test(value)) return f(Number.parseFloat(value));
  const exponentIndex = value.indexOf("p");
  const mantissa = (exponentIndex < 0 ? value : value.slice(0, exponentIndex)).replace(/^[+-]?0x/, "");
  const exponent = exponentIndex < 0 ? 0 : Number.parseInt(value.slice(exponentIndex + 1), 10);
  const dot = mantissa.indexOf(".");
  const fractionalDigits = dot < 0 ? 0 : mantissa.length - dot - 1;
  const sign = value.startsWith("-") ? -1 : 1;
  return f(sign * Number.parseInt(mantissa.replace(".", ""), 16) * 2 ** (exponent - fractionalDigits * 4));
}

function worldGridSize(map: BspMap): Vec3 {
  const size = { x: 64, y: 64, z: 128 };
  const worldspawn = map.entityRecords[0];
  if (worldspawn === undefined) return size;
  const axes: readonly (keyof Vec3)[] = ["x", "y", "z"];
  for (const [key, value] of worldspawn) {
    if (key.toLowerCase() !== "gridsize") continue;
    let rest = value;
    // Like sscanf's three sequential conversions, a partial value retains the
    // remaining defaults. Invalid dimensions are diagnosed by the loader below.
    for (const axis of axes) {
      const match = /^\s*[+-]?(?:0x(?:[\da-f]+\.?[\da-f]*|\.[\da-f]+)(?:p[+-]?\d+)?|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|infinity|inf|nan)/i.exec(rest);
      if (match === null) break;
      const token = match[0];
      size[axis] = gridFloat(token);
      rest = rest.slice(token.length);
    }
  }
  return size;
}

function gridAxis(minimum: number, maximum: number, size: number): { readonly origin: number; readonly count: number } {
  const origin = f(size * Math.ceil(f(minimum / size)));
  const end = f(size * Math.floor(f(maximum / size)));
  return { origin, count: Math.trunc(f(f(f(end - origin) / size) + 1)) };
}

/** R_LoadEntities/R_LoadLightGrid. Copies and overbright-shifts both RGB triples. */
export function prepareLightGrid(map: BspMap, overbright: {
  readonly mapOverbrightBits: number;
  readonly overbrightBits: number;
}): { readonly grid: LightGrid | null; readonly diagnostics: readonly string[] } {
  const shift = overbright.mapOverbrightBits - overbright.overbrightBits;
  if (!Number.isInteger(overbright.mapOverbrightBits) || !Number.isInteger(overbright.overbrightBits) || shift < 0 || shift > 15) {
    throw new RangeError("Light-grid overbright shift must be an integer in 0..15; other values have undefined source C shifts or overflow");
  }
  const world = map.models[0];
  if (world === undefined) throw new RangeError("Light-grid loading requires BSP world model zero");
  const size = worldGridSize(map);
  if (![size.x, size.y, size.z].every(value => Number.isFinite(value) && value > 0)) {
    return { grid: null, diagnostics: ["Invalid worldspawn gridsize: dimensions must be finite and positive"] };
  }
  const x = gridAxis(world.bounds.min.x, world.bounds.max.x, size.x);
  const y = gridAxis(world.bounds.min.y, world.bounds.max.y, size.y);
  const z = gridAxis(world.bounds.min.z, world.bounds.max.z, size.z);
  const count = x.count * y.count * z.count;
  if (![x.count, y.count, z.count].every(value => Number.isSafeInteger(value) && value > 0) || !Number.isSafeInteger(count)) {
    return { grid: null, diagnostics: ["Invalid light-grid bounds: no finite positive sample layout"] };
  }
  if (map.lightGrid.length !== count) {
    return { grid: null, diagnostics: [`Light grid mismatch: expected ${count} samples, found ${map.lightGrid.length}`] };
  }
  return {
    grid: {
      origin: vec3(x.origin, y.origin, z.origin), size,
      inverseSize: vec3(1 / size.x, 1 / size.y, 1 / size.z), bounds: vec3(x.count, y.count, z.count),
      samples: map.lightGrid.map(point => ({
        ambient: shiftedColor(point.ambient, shift), directed: shiftedColor(point.directed, shift),
        latLong: { x: point.latLong.x, y: point.latLong.y },
      })),
    },
    diagnostics: [],
  };
}

function sampleAxis(coordinate: number, inverseSize: number, count: number): { readonly position: number; readonly fraction: number } {
  const v = f(coordinate * inverseSize), position = Math.floor(v);
  return { position: Math.max(0, Math.min(count - 1, position)), fraction: f(v - position) };
}

function multiplyAdd(a: Vec3, factor: number, b: Vec3): Vec3 {
  return add3(a, scale3(b, factor));
}

/** R_LightForPoint/R_SetupEntityLightingGrid. lightDir remains in world space. */
export function lightForPoint(grid: LightGrid | null, point: Vec3, scales: LightingScales): LightingSample | null {
  if (grid === null) return null;
  if (![point.x, point.y, point.z].every(Number.isFinite)) throw new RangeError("Light sample origin must be finite");
  const relative = sub3(point, grid.origin);
  const x = sampleAxis(relative.x, grid.inverseSize.x, grid.bounds.x);
  const y = sampleAxis(relative.y, grid.inverseSize.y, grid.bounds.y);
  const z = sampleAxis(relative.z, grid.inverseSize.z, grid.bounds.z);
  let ambient = vec3(0, 0, 0), directed = vec3(0, 0, 0), direction = vec3(0, 0, 0), totalFactor = 0;
  for (let i = 0; i < 8; i++) {
    let factor = (i & 1) !== 0 ? x.fraction : f(1 - x.fraction);
    factor = f(factor * ((i & 2) !== 0 ? y.fraction : f(1 - y.fraction)));
    factor = f(factor * ((i & 4) !== 0 ? z.fraction : f(1 - z.fraction)));
    const sx = x.position + (i & 1), sy = y.position + ((i >> 1) & 1), sz = z.position + ((i >> 2) & 1);
    // Source gridStep offsets can cross X/Y rows, including zero-weight corners.
    let index = sx + grid.bounds.x * (sy + grid.bounds.y * sz);
    if (index >= grid.samples.length) {
      // Source reads past its allocation here. Retain the explicit replicated-edge
      // safety profile only for those undefined reads, not in-allocation aliases.
      index = Math.min(grid.bounds.x - 1, sx) + grid.bounds.x * (Math.min(grid.bounds.y - 1, sy)
        + grid.bounds.y * Math.min(grid.bounds.z - 1, sz));
    }
    const data = grid.samples[index];
    if (data === undefined) throw new RangeError("Prepared light-grid sample layout is inconsistent");
    if (data.ambient.x + data.ambient.y + data.ambient.z === 0) continue;
    totalFactor = f(totalFactor + factor);
    ambient = multiplyAdd(ambient, factor, data.ambient);
    directed = multiplyAdd(directed, factor, data.directed);
    const latitude = data.latLong.y * 4, longitude = data.latLong.x * 4;
    const normal = vec3(
      rendererSine(latitude + 256) * rendererSine(longitude),
      rendererSine(latitude) * rendererSine(longitude),
      rendererSine(longitude + 256),
    );
    direction = multiplyAdd(direction, factor, normal);
  }
  if (totalFactor > 0 && totalFactor < 0.99) {
    const inverseFactor = f(1 / totalFactor);
    ambient = scale3(ambient, inverseFactor);
    directed = scale3(directed, inverseFactor);
  }
  return {
    ambientLight: scale3(ambient, f(scales.ambientScale)),
    directedLight: scale3(directed, f(scales.directedScale)),
    lightDir: normalize3OrZero(direction),
  };
}

/** R_SetupEntityLighting. The caller owns its once-per-entity/frame cache. */
export function setupEntityLighting(entity: LightingEntity, state: EntityLightingState,
  output: EntityLightingStorage = { ambientLight: vec3(0, 0, 0), directedLight: vec3(0, 0, 0), lightDir: vec3(0, 0, 0), ambientLightInt: 0 },
  diagnostics: EntityLightingDiagnostics | null = null): EntityLighting {
  const origin = (entity.renderFlags & RF_LIGHTING_ORIGIN) !== 0 ? entity.lightingOrigin : entity.origin;
  const fallback = f(f(state.identityLight) * 150);
  const sample = (state.noWorldModel ? null : lightForPoint(state.grid, origin, state)) ?? {
    ambientLight: vec3(fallback, fallback, fallback), directedLight: vec3(fallback, fallback, fallback),
    lightDir: vec3(state.sunDirection.x, state.sunDirection.y, state.sunDirection.z),
  };
  // The original has `if (1 /* renderfx & RF_MINLIGHT */)`: every entity gets it.
  const minimum = f(f(state.identityLight) * 32);
  let ambient = add3(sample.ambientLight, vec3(minimum, minimum, minimum));
  let directed = sample.directedLight, direction = scale3(sample.lightDir, length3(directed));
  for (const light of state.dynamicLights) {
    const relative = sub3(light.origin, origin);
    const distance = Math.max(length3(relative), 16);
    const power = f(16 * f(f(light.radius) * f(light.radius)));
    const attenuation = f(power / f(distance * distance));
    directed = multiplyAdd(directed, attenuation, light.color);
    direction = multiplyAdd(direction, attenuation, normalize3(relative));
  }
  ambient = vec3(Math.min(ambient.x, state.identityLightByte), Math.min(ambient.y, state.identityLightByte), Math.min(ambient.z, state.identityLightByte));
  output.lightDir = sample.lightDir;
  output.ambientLight = ambient;
  output.directedLight = directed;
  if (diagnostics !== null && diagnostics.enabled && (entity.renderFlags & RF_FIRST_PERSON) !== 0) {
    // LogLight compares each float against the truncated integer and skips Z when Y wins.
    let max1 = Math.trunc(output.ambientLight.x), max2 = Math.trunc(output.directedLight.x);
    if (output.ambientLight.y > max1) max1 = Math.trunc(output.ambientLight.y);
    else if (output.ambientLight.z > max1) max1 = Math.trunc(output.ambientLight.z);
    if (output.directedLight.y > max2) max2 = Math.trunc(output.directedLight.y);
    else if (output.directedLight.z > max2) max2 = Math.trunc(output.directedLight.z);
    diagnostics.print(`amb:${max1}  dir:${max2}\n`);
  }
  output.ambientLightInt = ((Math.trunc(output.ambientLight.x) & 255) | ((Math.trunc(output.ambientLight.y) & 255) << 8)
    | ((Math.trunc(output.ambientLight.z) & 255) << 16) | 0xff000000) >>> 0;
  direction = normalize3(direction);
  output.lightDir = vec3(dot3(direction, entity.axis[0]), dot3(direction, entity.axis[1]), dot3(direction, entity.axis[2]));
  return output;
}
