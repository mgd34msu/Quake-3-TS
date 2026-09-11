// Shared scene allocation from id Software renderer/tr_scene.c and tr_local.h.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import { vec3 } from "../core/math.ts";
import type { Axis, Bounds, Vec3 } from "../core/math.ts";
import { SourceBackendMemory } from "./backend-memory.ts";
import type { DynamicLight } from "./lighting.ts";
import type { RefEntity, RefPoly, RefPolyVertex, SceneShader, SourceRefEntity } from "./ref-entity.ts";
import type { SourceSceneEntities, SourceSceneRange } from "./scene-entities.ts";
import { SourceSceneSubmissionMemory } from "./scene-submission-memory.ts";
import type { SourceRendererHardware } from "./settings.ts";

export interface SceneSubmissionLimits {
  readonly maxPolys: number;
  readonly maxPolyVertices: number;
}

export interface SourceScenePoly {
  readonly shader: SceneShader | number;
  readonly vertices: readonly RefPolyVertex[];
  /** BSP fog array index; source fog zero is represented by -1. */
  readonly fog: number;
}

export interface SourceSceneCapture {
  readonly entities: SourceSceneRange;
  readonly polys: readonly SourceScenePoly[];
  readonly dynamicLights: readonly DynamicLight[];
  transformDlights(origin: Vec3, axis: Axis): readonly DynamicLight[];
}

export interface SourceSceneCaptureAllocation {
  readonly entities: SourceSceneEntities;
  readonly memory: SourceSceneSubmissionMemory;
  readonly firstPoly: number;
  readonly firstLight: number;
  readonly numPolys: number;
  readonly numLights: number;
  readonly polyVertices: number;
}

const captureAllocations = new WeakMap<SourceSceneCapture, SourceSceneCaptureAllocation>();

export function sourceSceneCaptureAllocation(capture: SourceSceneCapture): SourceSceneCaptureAllocation {
  const allocation = captureAllocations.get(capture);
  if (allocation === undefined) throw new Error("Source scene capture has no source allocation");
  allocation.entities.validateRange(capture.entities);
  allocation.memory.backend.assertLive();
  return allocation;
}

export function retainSourceSceneCaptureAllocation(capture: SourceSceneCapture, allocation: SourceSceneCaptureAllocation): void {
  captureAllocations.set(capture, allocation);
}

export type SourceSceneSubmissionProfile =
  | { readonly kind: "diagnostic-local" }
  | { readonly kind: "source"; readonly backend: SourceBackendMemory;
    readonly shaderHandle: (shader: SceneShader) => number };

interface SceneSubmissionServices {
  readonly fogBounds: () => readonly Bounds[];
  readonly developerEnabled: () => boolean;
  readonly print: (text: string) => undefined;
}

/** One renderer's r_smp=0 scene allocation, shared by UI, cgame and VM calls. */
export class SourceSceneSubmission {
  readonly #memory: SourceSceneSubmissionMemory;
  // Standalone diagnostics have unregistered typed shaders, outside the source handle ABI.
  readonly #diagnosticShaders = new Map<number, SceneShader>();
  readonly #captures = new WeakSet<SourceSceneCapture>();
  readonly #limits: SceneSubmissionLimits;
  #firstScenePoly = 0;
  #firstSceneLight = 0;
  #numPolys = 0;
  #numLights = 0;
  #polyVertices = 0;

  constructor(private readonly entities: SourceSceneEntities, limits: SceneSubmissionLimits,
    private readonly services: SceneSubmissionServices,
    private readonly profile: SourceSceneSubmissionProfile = { kind: "diagnostic-local" },
    private readonly hardware: SourceRendererHardware = "generic") {
    this.#limits = { ...limits };
    const backend = profile.kind === "source" ? profile.backend : SourceBackendMemory.local(limits);
    if (profile.kind === "source" && entities.backendMemory !== backend)
      throw new Error("Source scene entities and submissions must share the backend allocation");
    if (backend.limits.maxPolys !== limits.maxPolys || backend.limits.maxPolyVertices !== limits.maxPolyVertices)
      throw new Error("Source scene limits do not match the backend allocation");
    this.#memory = new SourceSceneSubmissionMemory(backend);
  }

  /** RE_ClearScene advances membership without reclaiming frame capacity. */
  clearScene(): undefined {
    this.#memory.backend.assertLive();
    this.#firstSceneLight = this.#numLights;
    this.entities.clearScene();
    this.#firstScenePoly = this.#numPolys;
  }

  addRefEntity(entity: RefEntity): undefined { this.entities.addRefEntity(entity); }
  addRefEntityRecord(read: () => SourceRefEntity): undefined { this.entities.addRefEntityRecord(read); }

  addPoly(input: RefPoly): undefined {
    this.#memory.backend.assertLive();
    const selected = input.shader;
    const shader = selected === null || this.profile.kind === "diagnostic-local"
      ? selected : this.profile.shaderHandle(selected);
    if (this.rejectNullPolyShader(shader)) return;
    this.addPolys(shader, input.vertices.length, 1, () => input.vertices);
  }

  addPolysByHandle(shaderHandle: number, numVerts: number, numPolys: number,
    readVertices: (index: number) => readonly RefPolyVertex[]): undefined {
    this.#memory.backend.assertLive();
    if (this.rejectNullPolyShader(shaderHandle)) return;
    this.addPolys(shaderHandle, numVerts, numPolys, readVertices);
  }

  private rejectNullPolyShader(shader: SceneShader | number | null): shader is null | 0 {
    if (shader === null || shader === 0) {
      this.services.print("^3WARNING: RE_AddPolyToScene: NULL poly shader\n");
      return true;
    }
    return false;
  }

  private addPolys(shader: SceneShader | number, count: number, numPolys: number,
    readVertices: (index: number) => readonly RefPolyVertex[]): void {
    for (let index = 0; index < numPolys; index++) {
      if (!this.addPolyRecord(shader, count, () => readVertices(index))) return;
    }
  }

  private addPolyRecord(shader: SceneShader | number, count: number, readVertices: () => readonly RefPolyVertex[]): boolean {
    if (this.#polyVertices + count > this.#limits.maxPolyVertices || this.#numPolys >= this.#limits.maxPolys) {
      if (this.services.developerEnabled())
        this.services.print("^1WARNING: RE_AddPolyToScene: r_max_polys or r_max_polyverts reached\n");
      return false;
    }
    // Zero, one and two vertices all occupy a polygon slot without generating indices.
    if (!Number.isInteger(count) || count < 0) throw new RangeError("submitted polygon requires a nonnegative vertex count");
    const input = readVertices();
    if (input.length !== count) throw new RangeError("submitted polygon vertex count does not match its record");
    const vertices = input.map(vertex => {
      const position = vec3(vertex.position.x, vertex.position.y, vertex.position.z);
      const texCoord = { x: Math.fround(vertex.texCoord.x), y: Math.fround(vertex.texCoord.y) };
      const color = { ...vertex.color };
      if (![position.x, position.y, position.z, texCoord.x, texCoord.y].every(Number.isFinite)
        || ![color.x, color.y, color.z, color.w].every(value => Number.isInteger(value) && value >= 0 && value <= 255))
        throw new RangeError("polygon vertices require finite coordinates and byte colors");
      return { position, texCoord, color };
    });
    const index = this.#numPolys;
    this.#memory.writePoly(index, typeof shader === "number" ? shader : 0, this.#polyVertices, vertices);
    if (this.hardware === "ragepro") this.#memory.writeFirstVertexWhite(index);
    if (typeof shader === "number") this.#diagnosticShaders.delete(index);
    else this.#diagnosticShaders.set(index, shader);
    this.#numPolys++;
    this.#polyVertices += count;
    this.#memory.writePolyFog(index, this.polyFog(index));
    return true;
  }

  private poly(index: number): SourceScenePoly {
    return this.#memory.poly(index, handle => this.profile.kind === "diagnostic-local" && handle === 0
      ? this.#diagnosticShaders.get(index) ?? handle : handle);
  }

  private polyFog(index: number): number {
    const fogs = this.services.fogBounds();
    if (fogs.length === 0) return -1;
    const vertices = this.poly(index).vertices;
    const first = this.#memory.firstVertex(index);
    const min = { ...first.position }, max = { ...first.position };
    for (let index = 1; index < vertices.length; index++) {
      const vertex = vertices[index];
      if (vertex === undefined) throw new Error("Submitted polygon allocation is missing a vertex");
      const position = vertex.position;
      min.x = Math.min(min.x, position.x); min.y = Math.min(min.y, position.y); min.z = Math.min(min.z, position.z);
      max.x = Math.max(max.x, position.x); max.y = Math.max(max.y, position.y); max.z = Math.max(max.z, position.z);
    }
    return fogs.findIndex(volume => max.x >= volume.min.x && max.y >= volume.min.y && max.z >= volume.min.z
      && min.x <= volume.max.x && min.y <= volume.max.y && min.z <= volume.max.z);
  }

  addLight(light: DynamicLight): undefined {
    this.addLightValue(() => light.radius, () => light.color, () => light.additive === true, () => light.origin);
  }

  addLightRecord(radius: number, color: Vec3, additive: boolean, readOrigin: () => Vec3): undefined {
    this.addLightValue(() => radius, () => color, () => additive, readOrigin);
  }

  private addLightValue(readRadius: () => number, readColor: () => Vec3, readAdditive: () => boolean, readOrigin: () => Vec3): void {
    this.#memory.backend.assertLive();
    if (this.#numLights >= 32) return;
    const radius = Math.fround(readRadius());
    if (radius <= 0) return;
    if (this.hardware === "riva128" || this.hardware === "permedia2") return;
    const sourceOrigin = readOrigin(), origin = vec3(sourceOrigin.x, sourceOrigin.y, sourceOrigin.z);
    const sourceColor = readColor(), color = vec3(sourceColor.x, sourceColor.y, sourceColor.z);
    if (![origin.x, origin.y, origin.z, color.x, color.y, color.z, radius].every(Number.isFinite))
      throw new RangeError("dynamic lights require finite float32 values");
    this.#memory.writeLight(this.#numLights, { origin, color, radius, additive: readAdditive() });
    this.#numLights++;
  }

  /** Capture has no completion writes. Portal children borrow the same result. */
  captureScene(entities: SourceSceneRange = this.entities.sceneRange()): SourceSceneCapture {
    this.#memory.backend.assertLive();
    this.entities.validateRange(entities);
    const firstLight = this.#firstSceneLight, numLights = this.#numLights - firstLight;
    const capture: SourceSceneCapture = Object.freeze({ entities,
      polys: Object.freeze(Array.from({ length: this.#numPolys - this.#firstScenePoly }, (_, index) => this.poly(this.#firstScenePoly + index))),
      dynamicLights: Object.freeze(Array.from({ length: numLights }, (_, index) => this.#memory.light(firstLight + index))),
      transformDlights: (origin: Vec3, axis: Axis): readonly DynamicLight[] => {
        this.#memory.backend.assertLive();
        this.entities.validateRange(entities);
        for (let index = 0; index < numLights; index++) this.#memory.transformLight(firstLight + index, origin, axis);
        return Object.freeze(Array.from({ length: numLights }, (_, index) => this.#memory.light(firstLight + index, true)));
      },
    });
    retainSourceSceneCaptureAllocation(capture, { entities: this.entities, memory: this.#memory,
      firstPoly: this.#firstScenePoly, firstLight, numPolys: this.#numPolys, numLights: this.#numLights,
      polyVertices: this.#polyVertices });
    this.#captures.add(capture);
    return capture;
  }

  /** RE_RenderScene reaches these writes only after all frontend work succeeds. */
  completeScene(capture: SourceSceneCapture): undefined {
    if (!this.#captures.has(capture)) throw new Error("Source scene capture belongs to another submission owner");
    this.entities.completeScene(capture.entities);
    this.#memory.backend.assertLive();
    this.#firstSceneLight = this.#numLights;
    this.#firstScenePoly = this.#numPolys;
  }

  /** R_ToggleSmpFrame runs after the actual backend consumes the previous frame. */
  rolloverFrame(): undefined {
    this.#memory.backend.assertLive();
    this.entities.rolloverFrame();
    this.#numLights = 0;
    this.#firstSceneLight = 0;
    this.#numPolys = 0;
    this.#firstScenePoly = 0;
    this.#polyVertices = 0;
  }
}
