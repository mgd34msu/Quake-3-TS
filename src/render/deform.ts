// Geometry deformations and noise translated from id Software's GPL-2.0-or-later
// code/renderer/tr_shade_calc.c, tr_surface.c, tr_shadows.c and tr_noise.c.
import type { BspVertex } from "../assets/bsp.ts";
import { CommonError } from "../core/common-error.ts";
import { add3, cross3, dot3, length3, normalize3, scale3, sub3, vec3 } from "../core/math.ts";
import type { Axis, Vec3 } from "../core/math.ts";
import { normalizeFast3, rendererSine } from "../core/renderer-math.ts";
import { evaluateWaveform, SourceWaveFunction } from "./material.ts";
import type { VertexDeformation } from "./material.ts";
import type { SourceTessState } from "./tess-state.ts";

export interface DeformGeometry { readonly vertices: readonly BspVertex[]; readonly indices: readonly number[] }
export interface DeformView {
  readonly axis: Axis;
  readonly mirror: boolean;
  readonly entityAxis: Axis | null;
  readonly nonNormalizedAxis: Vec3 | null;
}
export interface ProjectionShadowContext {
  readonly axis: Axis;
  readonly origin: Vec3;
  readonly shadowPlane: number;
  readonly lightDir: Vec3;
}

/** RB_ProjectionShadowDeform operates in the retained entity's local coordinates. */
function projectionShadowGeometry(mesh: DeformGeometry, context: ProjectionShadowContext): DeformGeometry {
  const ground = vec3(context.axis[0].z, context.axis[1].z, context.axis[2].z);
  const groundDist = Math.fround(context.origin.z - context.shadowPlane);
  let lightDir = context.lightDir, d = dot3(lightDir, ground);
  if (d < 0.5) {
    // The source macro's 0.5 literal promotes this adjustment to double before storage.
    lightDir = vec3(lightDir.x + ground.x * (0.5 - d), lightDir.y + ground.y * (0.5 - d), lightDir.z + ground.z * (0.5 - d));
    d = dot3(lightDir, ground);
  }
  const light = scale3(lightDir, Math.fround(1 / d));
  return { indices: mesh.indices, vertices: mesh.vertices.map(vertex => {
    const height = Math.fround(dot3(vertex.position, ground) + groundDist);
    return { ...vertex, position: sub3(vertex.position, scale3(light, height)) };
  }) };
}

function localDirection(direction: Vec3, view: DeformView): Vec3 {
  return view.entityAxis === null ? direction : vec3(dot3(direction, view.entityAxis[0]), dot3(direction, view.entityAxis[1]), dot3(direction, view.entityAxis[2]));
}

function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new RangeError(`deformation index ${index} outside ${items.length}`);
  return value;
}

/** Linux rand() sequence: x^31+x^3+1 additive recurrence, Park-Miller initialization. */
function linuxRandom(seed: number): () => number {
  const state: number[] = [seed === 0 ? 1 : seed];
  for (let i = 1; i < 31; i++) state.push(16807 * at(state, i - 1) % 2147483647);
  let front = 3, rear = 0;
  function next(): number {
    const value = (at(state, front) + at(state, rear)) >>> 0;
    state[front] = value;
    front = (front + 1) % 31; rear = (rear + 1) % 31;
    return value >>> 1;
  }
  for (let i = 0; i < 310; i++) next();
  return next;
}

/** R_NoiseInit uses the Linux source target's srand(1001), with immutable tables per world. */
export class RendererNoise {
  private readonly values: readonly number[];
  private readonly permutation: readonly number[];

  constructor() {
    const random = linuxRandom(1001), values: number[] = [], permutation: number[] = [];
    for (let i = 0; i < 256; i++) {
      const value = Math.fround(Math.fround(random()) / Math.fround(2147483647));
      values.push(Math.fround(value * 2 - 1));
      permutation.push(Math.trunc(Math.fround(Math.fround(Math.fround(random()) / Math.fround(2147483647)) * 255)) & 255);
    }
    this.values = values; this.permutation = permutation;
  }

  sample(x: number, y: number, z: number, time: number): number {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), it = Math.floor(time);
    const fx = Math.fround(x - ix), fy = Math.fround(y - iy), fz = Math.fround(z - iz), ft = Math.fround(time - it);
    const perm = (index: number): number => at(this.permutation, index & 255);
    const lattice = (dx: number, dy: number, dz: number, dt: number): number => at(this.values, perm(ix + dx + perm(iy + dy + perm(iz + dz + perm(it + dt)))));
    const lerp = (a: number, b: number, amount: number): number => Math.fround(Math.fround(a * Math.fround(1 - amount)) + Math.fround(b * amount));
    const plane = (dz: number, dt: number): number => lerp(lerp(lattice(0, 0, dz, dt), lattice(1, 0, dz, dt), fx), lerp(lattice(0, 1, dz, dt), lattice(1, 1, dz, dt), fx), fy);
    return lerp(lerp(plane(0, 0), plane(1, 0), fz), lerp(plane(0, 1), plane(1, 1), fz), ft);
  }
}

function spriteGeometry(mesh: DeformGeometry, view: DeformView): DeformGeometry {
  if (mesh.vertices.length % 4 !== 0 || mesh.indices.length !== mesh.vertices.length / 4 * 6) throw new Error("autosprite requires independent four-vertex quads");
  const vertices: BspVertex[] = [], indices: number[] = [];
  const leftDir = localDirection(view.axis[1], view), upDir = localDirection(view.axis[2], view);
  let axisScale = 1;
  if (view.nonNormalizedAxis !== null) {
    const length = length3(view.nonNormalizedAxis); axisScale = length === 0 ? 0 : Math.fround(1 / length);
  }
  for (let start = 0; start < mesh.vertices.length; start += 4) {
    const first = at(mesh.vertices, start);
    const center = scale3(add3(add3(first.position, at(mesh.vertices, start + 1).position), add3(at(mesh.vertices, start + 2).position, at(mesh.vertices, start + 3).position)), 0.25);
    const delta = sub3(first.position, center), radius = Math.fround(Math.sqrt(dot3(delta, delta)) * 0.707);
    const left = scale3(scale3(leftDir, view.mirror ? -radius : radius), axisScale), up = scale3(scale3(upDir, radius), axisScale);
    // RB_AddQuadStamp writes the global view normal even for entity-local quads.
    const normal = sub3(vec3(0, 0, 0), view.axis[0]);
    const positions = [add3(add3(center, left), up), add3(sub3(center, left), up), sub3(sub3(center, left), up), sub3(add3(center, left), up)];
    const coords = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    for (let corner = 0; corner < 4; corner++) vertices.push({ position: at(positions, corner), normal, texCoord: at(coords, corner), lightmapCoord: at(coords, corner), color: first.color });
    indices.push(start, start + 1, start + 3, start + 3, start + 1, start + 2);
  }
  return { vertices, indices };
}

/** DeformText and RB_AddQuadStampExt, tr_shade_calc.c:261 and tr_surface.c:77. */
function textGeometry(tess: SourceTessState, index: number, view: DeformView): void {
  const text = at(tess.renderText, index), quad = tess.textQuad();
  let width = cross3(quad[0].normal, vec3(0, 0, -1));
  let mid = vec3(0, 0, 0), bottom = 999999, top = -999999;
  for (const vertex of quad) {
    mid = add3(vertex.position, mid);
    if (vertex.position.z < bottom) bottom = vertex.position.z;
    if (vertex.position.z > top) top = vertex.position.z;
  }
  const height = vec3(0, 0, Math.fround(top - bottom) * 0.5);
  width = scale3(width, Math.fround(height.z * -0.75));
  const nul = text.indexOf("\0"), length = nul < 0 ? text.length : nul;
  let origin = add3(scale3(mid, 0.25), scale3(width, length - 1));
  const normal = sub3(vec3(0, 0, 0), view.axis[0]);
  tess.resetGeometry();
  // Valid refdef rows contain at most 31 glyphs: 124 vertices/186 indexes.
  // Their reset starts below RB_CHECKOVERFLOW's 1000/6000 sentinels.
  for (let character = 0; character < length; character++) {
    const ch = text.charCodeAt(character) & 255;
    if (ch !== 32) {
      const s = (ch & 15) * 0.0625, t = (ch >> 4) * 0.0625;
      const positions = [add3(add3(origin, width), height), add3(sub3(origin, width), height),
        sub3(sub3(origin, width), height), sub3(add3(origin, width), height)];
      const coords = [{ x: s, y: t }, { x: s + 0.0625, y: t }, { x: s + 0.0625, y: t + 0.0625 }, { x: s, y: t + 0.0625 }];
      tess.appendGeometry({ vertices: positions.map((position, corner) => ({ position, normal, texCoord: at(coords, corner),
        lightmapCoord: at(coords, corner), color: { x: 255, y: 255, z: 255, w: 255 } })), indices: [0, 1, 3, 3, 1, 2] }, "stamp");
    }
    origin = add3(origin, scale3(width, -2));
  }
}

function pivotGeometry(mesh: DeformGeometry, view: DeformView): DeformGeometry {
  if (mesh.vertices.length % 4 !== 0 || mesh.indices.length !== mesh.vertices.length / 4 * 6) throw new Error("autosprite2 requires independent four-vertex quads");
  const forward = localDirection(view.axis[0], view), vertices = [...mesh.vertices];
  const edges: readonly (readonly [number, number])[] = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
  for (let start = 0; start < vertices.length; start += 4) {
    let shortest = 0, second = 0, firstLength = 999999, secondLength = 999999;
    for (const [index, [a, b]] of edges.entries()) {
      const delta = sub3(at(vertices, start + a).position, at(vertices, start + b).position), length = dot3(delta, delta);
      if (length < firstLength) { second = shortest; secondLength = firstLength; shortest = index; firstLength = length; }
      else if (length < secondLength) { second = index; secondLength = length; }
    }
    const midpoint = (edge: number): Vec3 => {
      const [a, b] = at(edges, edge);
      return scale3(add3(at(vertices, start + a).position, at(vertices, start + b).position), 0.5);
    };
    const firstMid = midpoint(shortest), secondMid = midpoint(second);
    const minor = normalize3(cross3(sub3(secondMid, firstMid), forward));
    const selected = [{ edge: shortest, midpoint: firstMid, length: firstLength }, { edge: second, midpoint: secondMid, length: secondLength }];
    for (const selection of selected) {
      const [a, b] = at(edges, selection.edge);
      let follows = false;
      for (let k = 0; k < 5; k++) if (mesh.indices[start / 4 * 6 + k] === start + a && mesh.indices[start / 4 * 6 + k + 1] === start + b) follows = true;
      const radius = Math.sqrt(selection.length) * 0.5 * (follows ? -1 : 1);
      vertices[start + a] = { ...at(vertices, start + a), position: add3(selection.midpoint, scale3(minor, radius)) };
      vertices[start + b] = { ...at(vertices, start + b), position: add3(selection.midpoint, scale3(minor, -radius)) };
    }
  }
  return { vertices, indices: mesh.indices };
}

/** Scene-owned orientation retains the source entity-axis scale flag and mirror mode. */
export function deformGeometry(tess: SourceTessState, deforms: readonly VertexDeformation[], view: DeformView, time: number, noise: RendererNoise,
  projectionShadow: ProjectionShadowContext | null = null): DeformGeometry {
  let result = tess.snapshotGeometry();
  for (const deform of deforms) {
    if (deform.kind === "none") continue;
    if (deform.kind === "text") { textGeometry(tess, deform.index, view); result = tess.snapshotGeometry(); continue; }
    if (deform.kind === "autosprite") { result = spriteGeometry(result, view); tess.replaceGeometry(result); continue; }
    if (deform.kind === "autosprite2") { result = pivotGeometry(result, view); tess.replaceGeometry(result); continue; }
    if (deform.kind === "projectionshadow") {
      if (projectionShadow === null) throw new Error("projectionshadow deformation requires retained entity orientation and lighting");
      result = projectionShadowGeometry(result, projectionShadow); tess.replaceGeometry(result); continue;
    }
    if ((deform.kind === "move" || deform.kind === "wave") && (deform.wave.kind === "none" || deform.wave.kind === "noise")) {
      const material = tess.material;
      if (material === null) throw new Error("Invalid deformation waveform requires its begun source material");
      const func = deform.wave.kind === "none" ? SourceWaveFunction.None : SourceWaveFunction.Noise;
      throw new CommonError("drop", `TableForFunc called with invalid function '${func}' in shader '${material.name}'\n`);
    }
    if (deform.kind === "move") {
      const offset = scale3(deform.direction, evaluateWaveform(deform.wave, time));
      result = { indices: result.indices, vertices: result.vertices.map(vertex => ({ ...vertex, position: add3(vertex.position, offset) })) };
      tess.replaceGeometry(result);
      continue;
    }
    if (deform.kind === "wave") {
      const constantScale = deform.wave.frequency === 0 ? evaluateWaveform(deform.wave, time) : null;
      result = { indices: result.indices, vertices: result.vertices.map(vertex => {
        const sum = Math.fround(Math.fround(vertex.position.x + vertex.position.y) + vertex.position.z);
        const phase = Math.fround(deform.wave.phase + Math.fround(sum * deform.spread));
        const scale = constantScale === null ? evaluateWaveform({ ...deform.wave, phase }, time) : constantScale;
        return { ...vertex, position: add3(vertex.position, scale3(vertex.normal, scale)) };
      }) };
      tess.replaceGeometry(result);
      continue;
    }
    result = { indices: result.indices, vertices: result.vertices.map(vertex => {
      let position = vertex.position, normal = vertex.normal;
      switch (deform.kind) {
        case "normal": {
          const scale = Math.fround(0.98);
          const x = Math.fround(position.x * scale), y = Math.fround(position.y * scale), z = Math.fround(position.z * scale), t = Math.fround(time * deform.frequency);
          normal = normalizeFast3({ x: Math.fround(normal.x + Math.fround(deform.amplitude * noise.sample(x, y, z, t))),
            y: Math.fround(normal.y + Math.fround(deform.amplitude * noise.sample(Math.fround(100 + x), y, z, t))),
            z: Math.fround(normal.z + Math.fround(deform.amplitude * noise.sample(Math.fround(200 + x), y, z, t))) }); break;
        }
        case "bulge": {
          const now = Math.fround(Math.fround(Math.fround(tess.refdefTime) * deform.speed) * Math.fround(0.001));
          const phase = Math.fround(Math.fround(vertex.texCoord.x * deform.width) + now);
          const index = Math.trunc(Math.fround(Math.fround(1024 / (Math.PI * 2)) * phase)) & 1023;
          position = add3(position, scale3(normal, Math.fround(rendererSine(index) * deform.height))); break;
        }
      }
      return { ...vertex, position, normal };
    }) };
    tess.replaceGeometry(result);
  }
  return result;
}
