// backEndData_t storage from id Software renderer/tr_local.h and tr_init.c:R_Init.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import type { HunkAllocation } from "../core/hunk.ts";
import type { SceneSubmissionLimits } from "./scene-submission.ts";

// Pinned release32 ABI. Every member has four-byte alignment.
export const SOURCE_BACKEND_RELEASE32 = Object.freeze({
  drawSurfaces: 0, drawSurfaceCount: 65536, drawSurfaceBytes: 8,
  dynamicLights: 524288, dynamicLightCount: 32, dynamicLightBytes: 44,
  entities: 525696, entityCount: 1023, entityBytes: 192,
  polysPointer: 722112, polyVerticesPointer: 722116,
  commands: 722120, commandBytes: 262144, commandsUsed: 984264,
  byteLength: 984268, polyBytes: 20, polyVertexBytes: 24,
});

type BackendStorage =
  | { readonly kind: "source-hunk"; readonly allocation: HunkAllocation }
  | { readonly kind: "local"; readonly bytes: Uint8Array; readonly originalByteOffset: number };

export interface SourceBackendSnapshot {
  readonly limits: SceneSubmissionLimits;
  readonly originalByteOffset: number;
  readonly bytes: Uint8Array;
}

export function sourceBackendByteLength(limits: SceneSubmissionLimits): number {
  if (!Number.isSafeInteger(limits.maxPolys) || limits.maxPolys < 0
    || !Number.isSafeInteger(limits.maxPolyVertices) || limits.maxPolyVertices < 0) {
    throw new RangeError("Renderer backend capacities must be nonnegative integers");
  }
  const bytes = SOURCE_BACKEND_RELEASE32.byteLength + limits.maxPolys * SOURCE_BACKEND_RELEASE32.polyBytes
    + limits.maxPolyVertices * SOURCE_BACKEND_RELEASE32.polyVertexBytes;
  if (!Number.isSafeInteger(bytes) || bytes > 0x7fffffff) {
    throw new RangeError("Renderer backend allocation exceeds the signed release32 size");
  }
  return bytes;
}

function recordIndex(index: number, count: number, label: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new RangeError(`Renderer backend ${label} index is outside its allocation`);
  }
}

/** Owns source bytes. Each accessor renews the hunk borrow before returning a cached view. */
export class SourceBackendMemory {
  readonly limits: SceneSubmissionLimits;
  readonly byteLength: number;
  readonly #fixedViews = new Map<number, DataView>();
  readonly #drawSurfaceViews = new Map<number, DataView>();
  readonly #entityViews = new Map<number, DataView>();
  readonly #dynamicLightViews = new Map<number, DataView>();
  readonly #polyViews = new Map<number, DataView>();
  readonly #polyVertexViews = new Map<number, DataView>();
  #retired = false;

  private constructor(private readonly storage: BackendStorage, limits: SceneSubmissionLimits, initialize = true) {
    this.limits = Object.freeze({ maxPolys: limits.maxPolys, maxPolyVertices: limits.maxPolyVertices });
    this.byteLength = sourceBackendByteLength(this.limits);
    const bytes = this.bytes;
    if (bytes.byteLength !== this.byteLength) throw new RangeError("Renderer backend allocation has the wrong byte length");
    if (initialize) {
      const data = this.fullData();
      data.setUint32(SOURCE_BACKEND_RELEASE32.polysPointer, this.byteOffset + SOURCE_BACKEND_RELEASE32.byteLength, true);
      data.setUint32(SOURCE_BACKEND_RELEASE32.polyVerticesPointer, this.byteOffset + this.polyVerticesOffset(), true);
    }
  }

  /** Explicit diagnostics own the same layout without charging an unrelated source arena. */
  static local(limits: SceneSubmissionLimits): SourceBackendMemory {
    return new SourceBackendMemory({ kind: "local", bytes: new Uint8Array(sourceBackendByteLength(limits)), originalByteOffset: 0 }, limits);
  }

  snapshot(): SourceBackendSnapshot {
    return { limits: { ...this.limits }, originalByteOffset: this.byteOffset, bytes: this.bytes.slice() };
  }

  static fromSnapshot(snapshot: SourceBackendSnapshot): SourceBackendMemory {
    if (!Number.isSafeInteger(snapshot.originalByteOffset) || snapshot.originalByteOffset < 0
      || snapshot.originalByteOffset % 4 !== 0 || snapshot.originalByteOffset + snapshot.bytes.length > 0x100000000)
      throw new RangeError("Renderer backend snapshot has an invalid release32 pointer base");
    return new SourceBackendMemory({ kind: "local", bytes: snapshot.bytes.slice(),
      originalByteOffset: snapshot.originalByteOffset }, snapshot.limits, false);
  }

  /** Synchronization updates the existing allocation so retained cell views keep identity. */
  restoreSnapshot(snapshot: SourceBackendSnapshot): void {
    if (snapshot.originalByteOffset !== this.byteOffset || snapshot.bytes.length !== this.byteLength
      || snapshot.limits.maxPolys !== this.limits.maxPolys || snapshot.limits.maxPolyVertices !== this.limits.maxPolyVertices)
      throw new RangeError("Renderer backend snapshot belongs to another allocation layout");
    this.bytes.set(snapshot.bytes);
  }

  /** R_Init supplies a freshly zeroed permanent Hunk_Alloc result. */
  static fromAllocation(allocation: HunkAllocation, limits: SceneSubmissionLimits): SourceBackendMemory {
    if (allocation.kind !== "permanent") throw new Error("Renderer backend requires a permanent hunk allocation");
    return new SourceBackendMemory({ kind: "source-hunk", allocation }, limits);
  }

  get byteOffset(): number {
    return this.storage.kind === "source-hunk" ? this.storage.allocation.byteOffset : this.storage.originalByteOffset;
  }

  /** Raw borrows have the same lifetime restriction as HunkAllocation.bytes. */
  get bytes(): Uint8Array {
    if (this.#retired) throw new Error("Renderer backend allocation is no longer valid");
    return this.storage.kind === "source-hunk" ? this.storage.allocation.bytes : this.storage.bytes;
  }

  assertLive(): void { void this.bytes; }

  retire(): void {
    this.#retired = true;
    this.#fixedViews.clear(); this.#drawSurfaceViews.clear(); this.#entityViews.clear();
    this.#dynamicLightViews.clear(); this.#polyViews.clear(); this.#polyVertexViews.clear();
  }

  private view(views: Map<number, DataView>, offset: number, byteLength: number): DataView {
    const bytes = this.bytes;
    if (!Number.isInteger(offset) || offset < 0 || offset + byteLength > bytes.byteLength) {
      throw new RangeError("Renderer backend view is outside its allocation");
    }
    const byteOffset = bytes.byteOffset + offset, retained = views.get(offset);
    if (retained !== undefined && retained.buffer === bytes.buffer
      && retained.byteOffset === byteOffset && retained.byteLength === byteLength) return retained;
    const data = new DataView(bytes.buffer, byteOffset, byteLength);
    views.set(offset, data);
    return data;
  }

  fullData(): DataView { return this.view(this.#fixedViews, 0, this.byteLength); }

  drawSurfaceData(index: number): DataView {
    recordIndex(index, SOURCE_BACKEND_RELEASE32.drawSurfaceCount, "draw surface");
    return this.view(this.#drawSurfaceViews, SOURCE_BACKEND_RELEASE32.drawSurfaces
      + index * SOURCE_BACKEND_RELEASE32.drawSurfaceBytes, SOURCE_BACKEND_RELEASE32.drawSurfaceBytes);
  }

  entityData(index: number): DataView {
    recordIndex(index, SOURCE_BACKEND_RELEASE32.entityCount, "entity");
    return this.view(this.#entityViews, SOURCE_BACKEND_RELEASE32.entities
      + index * SOURCE_BACKEND_RELEASE32.entityBytes, SOURCE_BACKEND_RELEASE32.entityBytes);
  }

  dlightData(index: number): DataView {
    recordIndex(index, SOURCE_BACKEND_RELEASE32.dynamicLightCount, "dynamic light");
    return this.view(this.#dynamicLightViews, SOURCE_BACKEND_RELEASE32.dynamicLights
      + index * SOURCE_BACKEND_RELEASE32.dynamicLightBytes, SOURCE_BACKEND_RELEASE32.dynamicLightBytes);
  }

  commandsData(): DataView {
    return this.view(this.#fixedViews, SOURCE_BACKEND_RELEASE32.commands, SOURCE_BACKEND_RELEASE32.commandBytes + 4);
  }

  private polyVerticesOffset(): number {
    return SOURCE_BACKEND_RELEASE32.byteLength + this.limits.maxPolys * SOURCE_BACKEND_RELEASE32.polyBytes;
  }

  private arrayPointer(field: number, start: number, end: number, stride: number): number {
    const data = this.fullData(), pointer = data.getUint32(field, true), offset = pointer - this.byteOffset;
    if (offset < start || offset > end || (offset - start) % stride !== 0) {
      throw new RangeError("Renderer backend array pointer is outside its allocation");
    }
    return offset;
  }

  polyData(index: number): DataView {
    recordIndex(index, this.limits.maxPolys, "polygon");
    const start = SOURCE_BACKEND_RELEASE32.byteLength, end = this.polyVerticesOffset();
    const offset = this.arrayPointer(SOURCE_BACKEND_RELEASE32.polysPointer, start, end, SOURCE_BACKEND_RELEASE32.polyBytes)
      + index * SOURCE_BACKEND_RELEASE32.polyBytes;
    if (offset + SOURCE_BACKEND_RELEASE32.polyBytes > end) throw new RangeError("Renderer backend polygon pointer exceeds its allocation");
    return this.view(this.#polyViews, offset, SOURCE_BACKEND_RELEASE32.polyBytes);
  }

  polyVertexPointer(index: number): number {
    // A zero-vertex polygon may retain the one-past pointer without reading it.
    recordIndex(index, this.limits.maxPolyVertices + 1, "polygon vertex");
    const offset = this.arrayPointer(SOURCE_BACKEND_RELEASE32.polyVerticesPointer, this.polyVerticesOffset(), this.byteLength,
      SOURCE_BACKEND_RELEASE32.polyVertexBytes) + index * SOURCE_BACKEND_RELEASE32.polyVertexBytes;
    if (offset > this.byteLength) {
      throw new RangeError("Renderer backend polygon vertex pointer exceeds its allocation");
    }
    return this.byteOffset + offset;
  }

  /** Source pointer words resolve against the allocation's preserved release32 base. */
  resolvePolyVertexPointer(pointer: number): number {
    this.assertLive();
    const offset = pointer - this.byteOffset - this.polyVerticesOffset();
    if (!Number.isInteger(pointer) || offset < 0 || offset % SOURCE_BACKEND_RELEASE32.polyVertexBytes !== 0
      || offset + SOURCE_BACKEND_RELEASE32.polyVertexBytes > this.limits.maxPolyVertices * SOURCE_BACKEND_RELEASE32.polyVertexBytes) {
      throw new RangeError("Renderer backend polygon vertex pointer is outside its allocation");
    }
    return offset / SOURCE_BACKEND_RELEASE32.polyVertexBytes;
  }

  polyVertexData(index: number): DataView { return this.polyVertexDataAtPointer(this.polyVertexPointer(index)); }

  /** An srfPoly_t retains its own pointer independently of the backend's current array pointer. */
  polyVertexDataAtPointer(pointer: number): DataView {
    const index = this.resolvePolyVertexPointer(pointer);
    return this.view(this.#polyVertexViews, this.polyVerticesOffset() + index * SOURCE_BACKEND_RELEASE32.polyVertexBytes,
      SOURCE_BACKEND_RELEASE32.polyVertexBytes);
  }
}
