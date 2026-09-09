// Source release32 allocation reservations from id Software's tr_bsp/tr_model/tr_image,
// cm_load and cm_patch. Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { HunkAllocation, HunkArena, HunkAsyncClearHost, HunkPreference } from "../core/hunk.ts";
import { SOURCE_BACKEND_RELEASE32, SourceBackendMemory, sourceBackendByteLength } from "./backend-memory.ts";
import type { SceneSubmissionLimits } from "./scene-submission.ts";

// gcc -m32 sizeof/offsetof of untouched release headers, dbe4ddb10315479fc00086f08e25d968b4b43c49.
export const SOURCE_HUNK_RELEASE32 = Object.freeze({
  pointer: 4, model: 100, skin: 196, skinSurface: 68, shader: 580, shaderStage: 252, texMod: 68, image: 112,
  diskShader: 72, collisionModel: 48, collisionNode: 12, brush: 44, leaf: 24, area: 8,
  plane: 20, brushSide: 12, collisionPatch: 16, patchCollide: 40, facet: 320, patchPlane: 20,
  surface: 16, facePointsOffset: 44, facePoint: 32, triangles: 68, flare: 40, grid: 136,
  drawVertex: 44, brushModel: 32, node: 64, fog: 72,
  // tr_types.h refEntity_t140; tr_local.h appends thirteen 32-bit words.
  refEntity: 140, trRefEntity: 192, dynamicLight: 44, drawSurface: 8, poly: 20, polyVertex: 24,
  backEndData: SOURCE_BACKEND_RELEASE32.byteLength,
});

export type HunkAccountingProfile =
  | { readonly kind: "unaccounted" }
  | { readonly kind: "source-hunk"; readonly accounting: SourceHunkAccounting };
export type CollisionHunkProfile =
  | { readonly kind: "unaccounted" }
  | { readonly kind: "source-hunk"; readonly accounting: SourceHunkAccounting;
    readonly source: string; readonly fileBytes: Uint8Array; readonly clientLoad: boolean;
    readonly fileLifetime: "detached" | "retained" };

export interface SourceHunkTrace {
  readonly action: "allocate" | "free-file" | "free-temporary";
  readonly source: string;
  readonly resource: string;
  readonly bytes: number;
  readonly reservedBytes: number;
  readonly offset: number;
  readonly preference: HunkPreference | "temporary";
}

interface RendererBackendAllocation {
  readonly allocation: HunkAllocation;
  readonly memory: SourceBackendMemory;
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Missing source allocation input ${index}`);
  return value;
}

/** Named source allocations share one real port arena. Its remaining budget excludes
 * TypeScript-managed storage and does not claim native memory-pressure equivalence. */
export class SourceHunkAccounting {
  private readonly allocations: HunkAllocation[] = [];
  private readonly events: SourceHunkTrace[] = [];
  private readonly openFiles = new Map<HunkAllocation, string>();
  private readonly temporaryAllocations = new Map<HunkAllocation, string>();
  private readonly backends: [RendererBackendAllocation | null, RendererBackendAllocation | null] = [null, null];

  constructor(readonly arena: HunkArena) {}

  private live(): void {
    const latest = this.allocations.at(-1);
    if (latest !== undefined) void latest.bytes;
  }

  private discardExpired(): void {
    for (let index = this.allocations.length - 1; index >= 0; index--) {
      if (!this.arena.ownsLiveAllocation(at(this.allocations, index))) this.allocations.splice(index, 1);
    }
    for (const [allocation] of this.openFiles) {
      if (!this.arena.ownsLiveAllocation(allocation)) this.openFiles.delete(allocation);
    }
    for (const [allocation] of this.temporaryAllocations) {
      if (!this.arena.ownsLiveAllocation(allocation)) this.temporaryAllocations.delete(allocation);
    }
    for (const [index, backend] of this.backends.entries()) {
      if (backend !== null && !this.arena.ownsLiveAllocation(backend.allocation)) {
        backend.memory.retire();
        this.backends[index] = null;
      }
    }
  }

  setMark(): void { this.live(); this.arena.setMark(); }

  clearToMark(): void {
    this.arena.clearToMark();
    this.discardExpired();
  }

  async clearAsync(host: HunkAsyncClearHost): Promise<void> {
    try { await this.arena.clearAsync(host); }
    finally { this.discardExpired(); }
  }
  reserve(source: string, resource: string, bytes: number, preference: HunkPreference): HunkAllocation {
    this.live();
    const allocation = this.arena.allocate(bytes, preference);
    this.allocations.push(allocation);
    this.events.push({ action: "allocate", source, resource, bytes, reservedBytes: Math.ceil(bytes / 32) * 32, offset: allocation.byteOffset, preference });
    return allocation;
  }
  copy(source: string, resource: string, data: Uint8Array, preference: HunkPreference, capacity = data.length): Uint8Array {
    const allocation = this.reserve(source, resource, capacity, preference);
    allocation.bytes.set(data);
    return allocation.bytes.subarray(0, data.length);
  }

  report() {
    this.live();
    return { profile: "release32-reservations", budget: "port-arena", collisionNumericProfile: "gcc-i386-O2-x87", remainingReservedBytes: this.arena.memoryRemaining(),
      missingComponents: [...(this.backends[0] === null ? ["renderer backend initialization"] : []),
        "Other TypeScript-managed records are outside the port arena",
        "direct TypeScript modules do not allocate QVM data or prepared code"],
      trace: this.events.map(event => ({ ...event })) };
  }

  memoryRemaining(): number {
    return this.arena.memoryRemaining();
  }

  allocateTemp(source: string, resource: string, bytes: number): HunkAllocation {
    this.live();
    const allocation = this.arena.allocateTemp(bytes);
    this.temporaryAllocations.set(allocation, resource);
    this.events.push({ action: "allocate", source, resource, bytes,
      reservedBytes: Math.ceil(bytes / 4) * 4 + 8, offset: allocation.byteOffset, preference: "temporary" });
    return allocation;
  }

  freeTemp(source: string, resource: string, allocation: HunkAllocation): void {
    if (this.temporaryAllocations.get(allocation) !== resource) throw new Error("Temporary allocation does not belong to this accounting owner");
    this.arena.freeTemp(allocation);
    this.temporaryAllocations.delete(allocation);
    this.events.push({ action: "free-temporary", source, resource, bytes: allocation.byteLength, reservedBytes: 0,
      offset: allocation.byteOffset, preference: "temporary" });
  }

  beginFile(resource: string, bytes: Uint8Array): HunkAllocation {
    this.live();
    const allocation = this.arena.allocateTemp(bytes.length + 1);
    allocation.bytes.set(bytes); allocation.bytes[bytes.length] = 0;
    this.openFiles.set(allocation, resource);
    this.events.push({ action: "allocate", source: "FS_ReadFile", resource, bytes: bytes.length + 1,
      reservedBytes: Math.ceil((bytes.length + 1) / 4) * 4 + 8, offset: allocation.byteOffset, preference: "temporary" });
    return allocation;
  }
  endFile(resource: string, allocation: HunkAllocation): void {
    if (this.openFiles.get(allocation) !== resource) throw new Error("File temporary allocation does not belong to this accounting load");
    this.arena.freeTemp(allocation);
    this.openFiles.delete(allocation);
    this.events.push({ action: "free-file", source: "FS_FreeFile", resource, bytes: allocation.byteLength, reservedBytes: 0,
      offset: allocation.byteOffset, preference: "temporary" });
    if (this.openFiles.size === 0) this.arena.clearTemp();
  }

  /** R_Init allocates requested buffers before platform SMP availability is known. */
  initializeRendererBackend(limits: SceneSubmissionLimits, smpRequested = false): SourceBackendMemory {
    this.live();
    if (!Number.isInteger(limits.maxPolys) || limits.maxPolys < 600
      || !Number.isInteger(limits.maxPolyVertices) || limits.maxPolyVertices < 3000) {
      throw new RangeError("Renderer backend allocation requires the registered source scene limits");
    }
    const bytes = sourceBackendByteLength(limits);
    const allocation = this.reserve("R_Init:backEndData[0]", "<renderer backend>", bytes, "low");
    const memory = SourceBackendMemory.fromAllocation(allocation, limits);
    this.backends[0] = { allocation, memory };
    if (smpRequested) {
      const secondAllocation = this.reserve("R_Init:backEndData[1]", "<renderer backend>", bytes, "low");
      this.backends[1] = { allocation: secondAllocation, memory: SourceBackendMemory.fromAllocation(secondAllocation, limits) };
    } else this.backends[1] = null;
    return memory;
  }

  rendererBackend(index: 0 | 1): SourceBackendMemory | null {
    const backend = this.backends[index];
    if (backend === null) return null;
    backend.memory.assertLive();
    return backend.memory;
  }

  defaultSkinRecord(): void {
    this.reserve("R_InitSkins", "<default skin>", SOURCE_HUNK_RELEASE32.skin, "low");
  }
  defaultSkinSurface(): void {
    // Original sizeof(*skin->surfaces) is one pointer, not skinSurface_t.
    this.reserve("R_InitSkins:surface", "<default skin>", SOURCE_HUNK_RELEASE32.pointer, "low");
  }
  defaultModelRecord(): void {
    this.reserve("R_ModelInit:R_AllocModel", "<default model>", SOURCE_HUNK_RELEASE32.model, "low");
  }
  modelRecord(name: string): void { this.reserve("R_AllocModel", name, SOURCE_HUNK_RELEASE32.model, "low"); }
  md3Allocation(name: string, byteLength: number): Uint8Array {
    return this.reserve("R_LoadMD3", name, byteLength, "low").bytes;
  }
  md4Allocation(name: string, byteLength: number): Uint8Array {
    return this.reserve("R_LoadMD4", name, byteLength, "low").bytes;
  }
  skinRecord(name: string): void { this.reserve("RE_RegisterSkin", name, SOURCE_HUNK_RELEASE32.skin, "low"); }
  skinSurface(name: string, shaderOnly: boolean): void {
    this.reserve("RE_RegisterSkin:surface", name, shaderOnly ? SOURCE_HUNK_RELEASE32.pointer : SOURCE_HUNK_RELEASE32.skinSurface, "low");
  }

}
