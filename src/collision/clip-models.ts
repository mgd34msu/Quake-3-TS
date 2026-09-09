/* Clip handles and shared temporary hull state from id Software's cm_load.c,
 * cm_test.c and cm_trace.c. Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
import { add3, scale3, sub3, vec3 } from "../core/math.ts";
import { CommonError } from "../core/common-error.ts";
import type { Bounds, Vec3 } from "../core/math.ts";
import { createBoxModel, createCapsuleModel } from "./model.ts";
import type { TemporaryCollisionModel, TemporaryTraceQuery } from "./model.ts";
import { emptySourceTrace, sourceTraceEnd } from "./world.ts";
import type { CollisionWorld, SourceTraceResult } from "./world.ts";

export const SOURCE_BOX_MODEL_HANDLE = 255;
export const SOURCE_CAPSULE_MODEL_HANDLE = 254;

type ClipModel = { readonly kind: "inline"; readonly index: number }
  | { readonly kind: "box"; readonly model: TemporaryCollisionModel };

/** One map's actual inline indexes and the source's single reusable box hull. */
export class SourceClipModels {
  #bounds: Bounds = { min: vec3(0, 0, 0), max: vec3(0, 0, 0) };
  #box: TemporaryCollisionModel;

  constructor(readonly world: CollisionWorld) {
    this.#box = createBoxModel(this.#bounds, world.counters, world.boxStorage);
  }

  get modelCount(): number { return this.world.modelCount; }

  inlineModel(index: number): number {
    if (!Number.isInteger(index)) throw new RangeError("CM_InlineModel: bad number");
    if (index < 0 || index >= this.modelCount) {
      throw new CommonError("drop", "CM_InlineModel: bad number");
    }
    return index;
  }

  tempBoxModel(mins: Vec3, maxs: Vec3, capsule: boolean): number {
    this.#bounds = { min: vec3(mins.x, mins.y, mins.z), max: vec3(maxs.x, maxs.y, maxs.z) };
    if (this.world.boxStorage !== null) {
      this.world.boxStorage.setBounds(mins, maxs, capsule);
      return capsule ? SOURCE_CAPSULE_MODEL_HANDLE : SOURCE_BOX_MODEL_HANDLE;
    }
    // The capsule call changes box_model bounds but leaves box_brush planes intact.
    if (capsule) return SOURCE_CAPSULE_MODEL_HANDLE;
    this.#box = createBoxModel(this.#bounds, this.world.counters);
    return SOURCE_BOX_MODEL_HANDLE;
  }

  modelBounds(handle: number): Bounds {
    const model = this.#resolve(handle);
    if (model.kind === "inline") return this.world.modelBounds(model.index);
    const bounds = this.world.boxStorage === null ? this.#bounds : this.world.boxStorage.bounds;
    return { min: vec3(bounds.min.x, bounds.min.y, bounds.min.z), max: vec3(bounds.max.x, bounds.max.y, bounds.max.z) };
  }

  pointContents(point: Vec3, handle: number): number {
    if (!this.world.hasNodes) return 0;
    const model = this.#resolve(handle);
    return model.kind === "inline" ? this.world.pointContents(point, model.index) : model.model.pointContents(point);
  }

  transformedPointContents(point: Vec3, handle: number, origin: Vec3, angles: Vec3): number {
    if (!this.world.hasNodes) return 0;
    const model = this.#resolve(handle);
    // Even a real submodel occupying index 255 takes the source no-rotation branch.
    const rotation = handle === SOURCE_BOX_MODEL_HANDLE ? vec3(0, 0, 0) : angles;
    return model.kind === "inline"
      ? this.world.transformedPointContents(point, model.index, origin, rotation)
      : model.model.transformedPointContents(point, origin, rotation);
  }

  trace(query: TemporaryTraceQuery, handle: number): SourceTraceResult {
    const model = this.#resolve(handle);
    if (!this.world.hasNodes) {
      this.world.advanceCheckCount();
      this.world.counters.c_traces = (this.world.counters.c_traces + 1) | 0;
      return emptySourceTrace();
    }
    if (handle === SOURCE_CAPSULE_MODEL_HANDLE) {
      this.world.advanceCheckCount();
      const capsule = this.#capsule(query, handle, false);
      return query.shape.kind !== "capsule" && this.modelCount > SOURCE_BOX_MODEL_HANDLE
        ? capsule.traceCapsuleReplacementSource(query, this.world, null) : capsule.traceSource(query);
    }
    if (model.kind === "inline") return this.world.traceSource({ ...query, modelIndex: model.index });
    this.world.advanceCheckCount();
    return model.model.traceSource(query);
  }

  /** CM_Trace checks its handle before the no-node return, without reading vectors. */
  traceWithoutNodes(handle: number): SourceTraceResult | null {
    if (this.world.hasNodes) return null;
    this.#resolve(handle);
    this.world.advanceCheckCount();
    this.world.counters.c_traces = (this.world.counters.c_traces + 1) | 0;
    return emptySourceTrace();
  }

  transformedTrace(query: TemporaryTraceQuery, handle: number, origin: Vec3, angles: Vec3): SourceTraceResult {
    const model = this.#resolve(handle);
    if (!this.world.hasNodes) {
      this.world.advanceCheckCount();
      this.world.counters.c_traces = (this.world.counters.c_traces + 1) | 0;
      return { ...emptySourceTrace(), end: sourceTraceEnd(query.start, query.end, 1) };
    }
    if (handle === SOURCE_CAPSULE_MODEL_HANDLE) {
      this.world.advanceCheckCount();
      const capsule = this.#capsule(query, handle, true);
      return query.shape.kind !== "capsule" && this.modelCount > SOURCE_BOX_MODEL_HANDLE
        ? capsule.traceCapsuleReplacementSource(query, this.world, { origin, angles })
        : capsule.transformedTraceSource(query, origin, angles);
    }
    const rotation = handle === SOURCE_BOX_MODEL_HANDLE ? vec3(0, 0, 0) : angles;
    if (model.kind === "inline") return this.world.transformedTraceSource({ ...query, modelIndex: model.index }, origin, rotation);
    this.world.advanceCheckCount();
    return model.model.transformedTraceSource(query, origin, rotation);
  }

  #capsule(query: TemporaryTraceQuery, handle: number, transformed: boolean): TemporaryCollisionModel {
    // In the pinned source 254 succeeds only when it names an actual submodel.
    const capsule = createCapsuleModel(this.modelBounds(handle), this.world.counters, this.world.boxStorage);
    if (query.shape.kind !== "capsule") {
      // Both box-versus-capsule branches replace the retained temporary box.
      const mins = query.shape.kind === "point" ? vec3(0, 0, 0) : query.shape.mins;
      const maxs = query.shape.kind === "point" ? vec3(0, 0, 0) : query.shape.maxs;
      const center = scale3(add3(mins, maxs), 0.5);
      let sizeMin = sub3(mins, center), sizeMax = sub3(maxs, center);
      if (transformed) {
        const traceCenter = scale3(add3(sizeMin, sizeMax), 0.5);
        sizeMin = sub3(sizeMin, traceCenter); sizeMax = sub3(sizeMax, traceCenter);
      }
      this.tempBoxModel(sizeMin, sizeMax, false);
    }
    return capsule;
  }

  #resolve(handle: number): ClipModel {
    if (!Number.isInteger(handle)) throw new RangeError(`CM_ClipHandleToModel: bad handle ${handle}`);
    if (handle < 0) throw new CommonError("drop", `CM_ClipHandleToModel: bad handle ${handle}`);
    if (handle < this.modelCount) return { kind: "inline", index: handle };
    if (handle === SOURCE_BOX_MODEL_HANDLE) return { kind: "box", model: this.#box };
    if (handle < 256) throw new CommonError("drop", `CM_ClipHandleToModel: bad handle ${this.modelCount} < ${handle} < 256`);
    throw new CommonError("drop", `CM_ClipHandleToModel: bad handle ${(handle + 256) | 0}`);
  }
}
