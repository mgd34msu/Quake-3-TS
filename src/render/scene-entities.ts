// Renderer entity storage from id Software renderer/tr_scene.c and tr_local.h.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import type { EntityLighting, EntityLightingDiagnostics, EntityLightingState, EntityLightingStorage } from "./lighting.ts";
import { setupEntityLighting } from "./lighting.ts";
import type { RefEntity, SourceRefEntity, SourceRefEntityRecord } from "./ref-entity.ts";
import { copySourceRefEntity } from "./ref-entity.ts";
import { SourceBackendMemory } from "./backend-memory.ts";
import { SourceRefEntityMemory } from "./scene-entity-memory.ts";
import type { SourceEntityHandles } from "./scene-entity-memory.ts";
import type { Vec3 } from "../core/math.ts";

// tr_types.h allocates MAX_ENTITIES; q_shared.h reserves ENTITYNUM_WORLD.
const MAX_ENTITIES = 1023;
const ENTITYNUM_WORLD = 1022;

export interface SourceSceneEntity {
  /** The actual source .e value; source frontend frame repair may mutate it. */
  readonly entity: SourceRefEntityRecord;
  axisLength: number;
  needDlights: boolean;
  readonly lightingCalculated: boolean;
  readonly lighting: EntityLighting;
  setupLighting(state: EntityLightingState, diagnostics?: EntityLightingDiagnostics | null): EntityLighting;
  copyRefEntity(): SourceRefEntity;
}

/** A frame-owned source refdef range. Portal children borrow this same range. */
export interface SourceSceneRange {
  readonly length: number;
  entity(localIndex: number): SourceSceneEntity;
  /** RB_RenderDrawSurfList indexes the allocation beyond submitted scene membership. */
  allocatedEntity(localIndex: number): SourceSceneEntity;
  copyRefEntities(): readonly SourceRefEntity[];
}

export interface SourceSceneEntityState {
  readonly generation: number;
  readonly count: number;
  readonly firstSceneEntity: number;
}
export interface SourceSceneEntityRangeState { readonly first: number; readonly count: number }

class SceneEntityCell implements SourceSceneEntity {
  readonly #record: SourceRefEntityMemory;
  readonly #lighting: EntityLightingStorage;

  constructor(private readonly memory: SourceBackendMemory, private readonly index: number, handles: SourceEntityHandles | undefined) {
    this.#record = new SourceRefEntityMemory(() => this.data(), handles);
    const cell = this;
    const vector = (offset: number): Vec3 => ({
      get x() { return cell.data().getFloat32(offset, true); },
      get y() { return cell.data().getFloat32(offset + 4, true); },
      get z() { return cell.data().getFloat32(offset + 8, true); },
    });
    const lightDir = vector(152), ambientLight = vector(164), directedLight = vector(180);
    const writeVector = (offset: number, value: Vec3): void => {
      const data = cell.data();
      data.setFloat32(offset, value.x, true);
      data.setFloat32(offset + 4, value.y, true);
      data.setFloat32(offset + 8, value.z, true);
    };
    this.#lighting = {
      get lightDir() { cell.data(); return lightDir; },
      set lightDir(value: Vec3) { writeVector(152, value); },
      get ambientLight() { cell.data(); return ambientLight; },
      set ambientLight(value: Vec3) { writeVector(164, value); },
      get directedLight() { cell.data(); return directedLight; },
      set directedLight(value: Vec3) { writeVector(180, value); },
      get ambientLightInt() { return cell.data().getUint32(176, true); },
      set ambientLightInt(value: number) { cell.data().setUint32(176, value, true); },
    };
  }

  private data(): DataView { return this.memory.entityData(this.index); }

  get entity(): SourceRefEntityRecord { this.data(); return this.#record.entity; }
  get axisLength(): number { return this.data().getFloat32(140, true); }
  set axisLength(value: number) { this.data().setFloat32(140, value, true); }
  get needDlights(): boolean { return this.data().getInt32(144, true) !== 0; }
  set needDlights(value: boolean) { this.data().setInt32(144, value ? 1 : 0, true); }
  get lightingCalculated(): boolean { return this.data().getInt32(148, true) !== 0; }
  get lighting(): EntityLighting { this.data(); return this.#lighting; }

  addRefEntity(entity: SourceRefEntity): void {
    this.#record.copyFrom(entity);
    this.data().setInt32(148, 0, true);
  }

  /** R_SetupEntityLighting's cache is shared by every view using this cell. */
  setupLighting(state: EntityLightingState, diagnostics: EntityLightingDiagnostics | null = null): EntityLighting {
    if (this.lightingCalculated) return this.#lighting;
    if (this.entity.kind !== "model") throw new Error("Entity lighting requires a source model entity");
    this.data().setInt32(148, 1, true);
    return setupEntityLighting(this.entity, state, this.#lighting, diagnostics);
  }

  copyRefEntity(): SourceRefEntity { return copySourceRefEntity(this.entity); }
}

/** One backEndData entity region, retained for its renderer allocation lifetime. */
export class SourceSceneEntities {
  readonly #cells = new Array<SceneEntityCell | undefined>(MAX_ENTITIES);
  readonly #ranges = new WeakMap<SourceSceneRange, { readonly frame: object; readonly first: number }>();
  #frame: object = {};
  #generation = 0;
  #count = 0;
  #firstSceneEntity = 0;

  constructor(readonly backendMemory = SourceBackendMemory.local({ maxPolys: 600, maxPolyVertices: 3000 }),
    private readonly handles?: SourceEntityHandles) {}

  snapshotState(): SourceSceneEntityState {
    this.backendMemory.assertLive();
    return { generation: this.#generation, count: this.#count, firstSceneEntity: this.#firstSceneEntity };
  }

  restoreState(state: SourceSceneEntityState): void {
    this.backendMemory.assertLive();
    if (!Number.isSafeInteger(state.generation) || state.generation < 0
      || !Number.isInteger(state.count) || state.count < 0 || state.count > ENTITYNUM_WORLD
      || !Number.isInteger(state.firstSceneEntity) || state.firstSceneEntity < 0 || state.firstSceneEntity > state.count)
      throw new RangeError("Source entity snapshot counters exceed the allocation");
    if (state.generation !== this.#generation) this.#frame = {};
    this.#generation = state.generation;
    this.#count = state.count;
    this.#firstSceneEntity = state.firstSceneEntity;
  }

  rangeState(range: SourceSceneRange): SourceSceneEntityRangeState {
    this.validateRange(range);
    const entry = this.#ranges.get(range);
    if (entry === undefined) throw new Error("Source scene range belongs to another entity owner");
    return { first: entry.first, count: range.length };
  }

  /** R_ToggleSmpFrame: call after the previous frame's backend has consumed its work. */
  rolloverFrame(): void {
    this.backendMemory.assertLive();
    this.#frame = {};
    this.#generation++;
    this.#count = 0;
    this.#firstSceneEntity = 0;
  }

  /** RE_ClearScene discards pending membership, without reclaiming frame cells. */
  clearScene(): void { this.backendMemory.assertLive(); this.#firstSceneEntity = this.#count; }

  /** RE_AddRefEntityToScene after the renderer's registered gate. */
  addRefEntity(entity: RefEntity): boolean { return this.addRefEntityRecord(() => entity); }

  /** Source capacity precedes reading the incoming refEntity_t. */
  addRefEntityRecord(read: () => SourceRefEntity): boolean {
    this.backendMemory.assertLive();
    if (this.#count >= ENTITYNUM_WORLD) return false;
    let cell = this.#cells[this.#count];
    if (cell === undefined) {
      cell = new SceneEntityCell(this.backendMemory, this.#count, this.handles);
      this.#cells[this.#count] = cell;
    }
    cell.addRefEntity(read());
    this.#count++;
    return true;
  }

  /** Captures RE_RenderScene's entity pointer/count, without its later completion writes. */
  sceneRange(): SourceSceneRange {
    this.backendMemory.assertLive();
    return this.restoreRange({ first: this.#firstSceneEntity, count: this.#count - this.#firstSceneEntity });
  }

  restoreRange(state: SourceSceneEntityRangeState): SourceSceneRange {
    this.backendMemory.assertLive();
    const first = state.first, end = first + state.count;
    if (!Number.isInteger(first) || first < 0 || !Number.isInteger(state.count) || state.count < 0 || end > this.#count)
      throw new RangeError("Source scene entity snapshot range exceeds submitted cells");
    const range: SourceSceneRange = Object.freeze({
      length: end - first,
      entity: (localIndex: number): SourceSceneEntity => {
        this.validateRange(range);
        if (!Number.isInteger(localIndex) || localIndex < 0 || localIndex >= range.length)
          throw new RangeError("Source scene entity index is outside the captured range");
        return range.allocatedEntity(localIndex);
      },
      allocatedEntity: (localIndex: number): SourceSceneEntity => {
        this.validateRange(range);
        if (!Number.isInteger(localIndex) || localIndex < 0)
          throw new RangeError("Source scene entity index must be a nonnegative integer");
        const index = first + localIndex;
        this.backendMemory.entityData(index);
        let cell = this.#cells[index];
        if (cell === undefined) {
          cell = new SceneEntityCell(this.backendMemory, index, this.handles);
          this.#cells[index] = cell;
        }
        return cell;
      },
      copyRefEntities: (): readonly SourceRefEntity[] => {
        this.validateRange(range);
        return Array.from({ length: range.length }, (_, index) => range.entity(index).copyRefEntity());
      },
    });
    this.#ranges.set(range, { frame: this.#frame, first });
    return range;
  }

  validateRange(range: SourceSceneRange): void {
    this.backendMemory.assertLive();
    const frame = this.#ranges.get(range);
    if (frame === undefined) throw new Error("Source scene range belongs to another entity owner");
    if (frame.frame !== this.#frame) throw new Error("Source scene range belongs to a completed frame");
  }

  /** Call only after RE_RenderScene's frontend succeeds, including its portal children. */
  completeScene(range: SourceSceneRange): void {
    this.validateRange(range);
    this.#firstSceneEntity = this.#count;
  }
}
