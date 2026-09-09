/*
 * Reachability construction from id Software's code/botlib/be_aas_reach.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { Vec3 } from "../core/math.ts";
import type { AasMovementSettings } from "./aas-movement.ts";
import type { AasWorldState } from "./aas-world.ts";
import type { AasBspEntities } from "./bsp-entities.ts";
import type { BotLibVars } from "./libvars.ts";
import type { AasSpatial } from "./spatial.ts";
import { aasAt, AasReachabilityGeometry } from "./aas-reachability-geometry.ts";
import { AasReachabilitySpecial } from "./aas-reachability-special.ts";
import type { BotMemory, BotMemoryAllocation } from "./memory.ts";

const MAX_REACHABILITY = 65536;
const LINK_BYTES = 48;

/** Standalone instances are diagnostic records; pool cells override the byte borrow. */
export class AasLinkedReachability {
  private diagnosticBytes: Uint8Array | null = null;
  private diagnosticNext: AasLinkedReachability | null = null;
  private readonly startVector = this.vector(12);
  private readonly endVector = this.vector(24);

  protected view(): DataView {
    if (this.diagnosticBytes === null) this.diagnosticBytes = new Uint8Array(LINK_BYTES);
    return new DataView(this.diagnosticBytes.buffer, this.diagnosticBytes.byteOffset, LINK_BYTES);
  }

  private vector(offset: number): Vec3 {
    const record = this;
    return Object.freeze({
      get x(): number { return record.view().getFloat32(offset, true); },
      get y(): number { return record.view().getFloat32(offset + 4, true); },
      get z(): number { return record.view().getFloat32(offset + 8, true); },
    });
  }

  private setVector(offset: number, value: Vec3): void {
    this.view().setFloat32(offset, value.x, true);
    this.view().setFloat32(offset + 4, value.y, true);
    this.view().setFloat32(offset + 8, value.z, true);
  }

  get area(): number { return this.view().getInt32(0, true); }
  set area(value: number) { this.view().setInt32(0, value, true); }
  get face(): number { return this.view().getInt32(4, true); }
  set face(value: number) { this.view().setInt32(4, value, true); }
  get edge(): number { return this.view().getInt32(8, true); }
  set edge(value: number) { this.view().setInt32(8, value, true); }
  get start(): Vec3 { return this.startVector; }
  set start(value: Vec3) { this.setVector(12, value); }
  get end(): Vec3 { return this.endVector; }
  set end(value: Vec3) { this.setVector(24, value); }
  get travelType(): number { return this.view().getInt32(36, true); }
  set travelType(value: number) { this.view().setInt32(36, value, true); }
  get next(): AasLinkedReachability | null { return this.diagnosticNext; }
  set next(value: AasLinkedReachability | null) { this.diagnosticNext = value; }
  get travelTime(): number { return this.view().getUint16(40, true); }
  set travelTime(value: number) {
    const integer = Math.trunc(value);
    if (!Number.isFinite(integer) || integer < -2147483648 || integer > 2147483647) {
      throw new RangeError("AAS reachability travel time exceeds source integer conversion range");
    }
    this.view().setUint16(40, integer, true);
  }

  clear(): void {
    const view = this.view();
    new Uint8Array(view.buffer, view.byteOffset, LINK_BYTES).fill(0);
    this.diagnosticNext = null;
  }
}

/** Release32 next words use one-based pool slots, with zero representing NULL. */
class AasPooledReachability extends AasLinkedReachability {
  constructor(readonly index: number, private readonly pool: AasReachabilityPool) { super(); }

  protected override view(): DataView {
    const bytes = this.pool.allocation.bytes;
    return new DataView(bytes.buffer, bytes.byteOffset + this.index * LINK_BYTES, LINK_BYTES);
  }

  override get next(): AasLinkedReachability | null { return this.pool.decode(this.view().getUint32(44, true)); }
  override set next(value: AasLinkedReachability | null) { this.view().setUint32(44, this.pool.encode(value), true); }
}

class AasReachabilityPool {
  readonly allocation: BotMemoryAllocation;
  readonly cells: readonly AasPooledReachability[];

  constructor(memory: BotMemory) {
    this.allocation = memory.allocate(MAX_REACHABILITY * LINK_BYTES, "heap", true);
    this.cells = Object.freeze(Array.from({ length: MAX_REACHABILITY }, (_, index) => new AasPooledReachability(index, this)));
  }

  initializeFreeList(): AasLinkedReachability {
    for (let index = 0; index < MAX_REACHABILITY - 1; index++) aasAt(this.cells, index).next = aasAt(this.cells, index + 1);
    aasAt(this.cells, MAX_REACHABILITY - 1).next = null;
    return aasAt(this.cells, 0);
  }

  decode(reference: number): AasLinkedReachability | null {
    if (reference === 0) return null;
    const link = this.cells[reference - 1];
    if (link === undefined) throw new RangeError("AAS reachability pointer exceeds its source pool");
    return link;
  }

  encode(link: AasLinkedReachability | null): number {
    if (link === null) return 0;
    if (!(link instanceof AasPooledReachability) || this.cells[link.index] !== link) {
      throw new RangeError("AAS reachability pointer belongs to another pool");
    }
    return link.index + 1;
  }

  areaHeads(allocation: BotMemoryAllocation, count: number): (AasLinkedReachability | null)[] {
    const heads: (AasLinkedReachability | null)[] = [];
    const view = (): DataView => {
      const bytes = allocation.bytes;
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };
    for (let area = 0; area < count; area++) {
      Object.defineProperty(heads, area, { enumerable: true,
        get: (): AasLinkedReachability | null => this.decode(view().getUint32(area * 4, true)),
        set: (link: AasLinkedReachability | null): void => { view().setUint32(area * 4, this.encode(link), true); },
      });
    }
    Object.freeze(heads);
    return heads;
  }
}

export interface AasReachabilityContext {
  readonly world: AasWorldState;
  readonly spatial: AasSpatial;
  readonly bspEntities: AasBspEntities;
  readonly variables: BotLibVars;
  readonly settings: AasMovementSettings;
  readonly print: (severity: 1 | 2 | 3 | 4 | 5, text: string) => undefined;
  readonly log: (text: string) => undefined;
  readonly permanentLine: (start: Vec3, end: Vec3, color: number) => undefined;
  readonly heads: (AasLinkedReachability | null)[];
  allocate(): AasLinkedReachability | null;
  free(link: AasLinkedReachability): void;
  exists(from: number, to: number): boolean;
}

export interface AasReachabilityOptions {
  readonly world: AasWorldState;
  readonly spatial: AasSpatial;
  readonly bspEntities: AasBspEntities;
  readonly variables: BotLibVars;
  readonly print: (severity: 1 | 2 | 3 | 4 | 5, text: string) => undefined;
  readonly log: (text: string) => undefined;
  readonly permanentLine: (start: Vec3, end: Vec3, color: number) => undefined;
  readonly milliseconds: () => number;
}

function sourceInteger(value: number, operation: string): number {
  const integer = Math.trunc(value);
  if (!Number.isFinite(integer) || integer < -2147483648 || integer > 2147483647) {
    throw new RangeError(`${operation}: source signed integer conversion is undefined`);
  }
  return integer + 0;
}

/** Map-owned AAS reachability heap and the source incremental initialization state. */
export class AasReachabilityGenerator implements AasReachabilityContext {
  readonly world: AasWorldState;
  readonly spatial: AasSpatial;
  readonly bspEntities: AasBspEntities;
  readonly variables: BotLibVars;
  readonly print: AasReachabilityOptions["print"];
  readonly log: AasReachabilityOptions["log"];
  readonly permanentLine: AasReachabilityOptions["permanentLine"];
  heads: (AasLinkedReachability | null)[] = [];
  private pool: AasReachabilityPool | null = null;
  private headAllocation: BotMemoryAllocation | null = null;
  private next: AasLinkedReachability | null = null;
  private linkCount = 0;
  private calculateGrapple = 0;
  private frameReachability = 0;
  private reachabilityDelay = 0;
  private lastPercentage = 0;
  private readonly geometry: AasReachabilityGeometry;
  private readonly special: AasReachabilitySpecial;

  constructor(private readonly options: AasReachabilityOptions) {
    this.world = options.world;
    this.spatial = options.spatial;
    this.bspEntities = options.bspEntities;
    this.variables = options.variables;
    this.print = options.print;
    this.log = options.log;
    this.permanentLine = options.permanentLine;
    this.geometry = new AasReachabilityGeometry(this);
    this.special = new AasReachabilitySpecial(this);
  }

  get settings(): AasMovementSettings { return this.spatial.movement.settings; }
  get allocatedReachabilityCount(): number { return this.linkCount; }

  initialize(): void {
    if (this.world.reachabilitySize !== 0 && sourceInteger(this.variables.getValue("forcereachability"), "AAS_InitReachability") === 0) {
      this.world.numReachabilityAreas = this.world.areas.length + 2;
      return;
    }
    this.calculateGrapple = sourceInteger(this.variables.getValue("grapplereach"), "AAS_InitReachability grapplereach");
    this.world.saveFile = true;
    this.world.numReachabilityAreas = 1;
    this.pool = new AasReachabilityPool(this.world.memory);
    this.next = this.pool.initializeFreeList();
    this.linkCount = 0;
    this.headAllocation = this.world.memory.allocate(this.world.areas.length * 4, "heap", true);
    this.heads = this.pool.areaHeads(this.headAllocation, this.world.areas.length);
    this.special.setWeaponJumpAreaFlags();
  }

  allocate(): AasLinkedReachability | null {
    if (this.next === null) return null;
    if (this.next.next === null) this.print(4, "AAS_MAX_REACHABILITYSIZE");
    const next = this.next;
    if (next === null) throw new Error("AAS_AllocReachability: fatal diagnostic invalidated the next source allocation");
    this.next = next.next;
    this.linkCount++;
    return next;
  }

  free(link: AasLinkedReachability): void {
    link.clear();
    link.next = this.next;
    this.next = link;
    this.linkCount--;
  }

  exists(from: number, to: number): boolean {
    for (let link = aasAt(this.heads, from); link !== null; link = link.next) if (link.area === to) return true;
    return false;
  }

  /** The final storing frame returns true; clustering starts on the following false return. */
  continueInitialization(_time: number): boolean {
    const world = this.world, count = world.areas.length;
    if (world.numReachabilityAreas >= count + 2) return false;
    if (world.numReachabilityAreas === 1) {
      this.print(1, "calculating reachability...\n");
      this.lastPercentage = 0;
      this.frameReachability = 2000;
      this.reachabilityDelay = 1000;
    }
    const todo = world.numReachabilityAreas + sourceInteger(this.frameReachability, "AAS_ContinueInitReachability frame count");
    const startTime = sourceInteger(this.options.milliseconds(), "Sys_MilliSeconds");
    for (let from = world.numReachabilityAreas; from < count && from < todo; from++) {
      world.numReachabilityAreas++;
      if ((aasAt(world.areaSettings, from).contents & 128) !== 0) continue;
      for (let to = 1; to < count; to++) {
        if (from === to) continue;
        if ((aasAt(world.areaSettings, from).contents & (64 | 128)) !== 0
          && (aasAt(world.areaSettings, to).contents & (64 | 128)) === 0) continue;
        if (this.exists(from, to)) continue;
        if (this.geometry.swim(from, to)) continue;
        if (this.geometry.equalFloorHeight(from, to)) continue;
        if (this.geometry.stepBarrierWaterJumpWalkOffLedge(from, to)) continue;
        if (this.geometry.ladder(from, to)) continue;
        if (this.geometry.jump(from, to)) continue;
      }
      if ((aasAt(world.areaSettings, from).contents & (64 | 128)) !== 0) continue;
      for (let to = 1; to < count; to++) {
        if (from === to || this.exists(from, to)) continue;
        if (this.calculateGrapple !== 0) this.special.grapple(from, to);
        this.special.weaponJump(from, to);
      }
      const elapsed = sourceInteger(this.options.milliseconds(), "Sys_MilliSeconds") - startTime;
      if (sourceInteger(elapsed, "AAS_ContinueInitReachability elapsed time") > sourceInteger(this.reachabilityDelay, "AAS reachability delay")) break;
      if (this.percentage() > this.lastPercentage) break;
    }
    if (world.numReachabilityAreas === count) {
      this.print(1, "\r 100.0%");
      this.print(1, "\nplease wait while storing reachability...\n");
      world.numReachabilityAreas++;
    } else if (world.numReachabilityAreas === count + 1) {
      for (let area = 1; area < count; area++) {
        if ((aasAt(world.areaSettings, area).contents & 128) === 0) this.geometry.walkOffLedge(area);
      }
      this.special.jumpPad();
      this.special.teleport();
      this.special.elevator();
      this.special.funcBobbing();
      this.store();
      if (this.pool === null) throw new Error("AAS_ShutDownReachabilityHeap: source pool is missing");
      this.world.memory.free(this.pool.allocation);
      this.linkCount = 0;
      if (this.headAllocation === null) throw new Error("AAS_ContinueInitReachability: source area heads are missing");
      this.world.memory.free(this.headAllocation);
      world.numReachabilityAreas++;
      this.print(1, "calculating clusters...\n");
    } else {
      this.lastPercentage = this.percentage();
      this.print(1, `\r${Math.fround(Math.fround(this.lastPercentage) / 10).toFixed(1).padStart(6)}%`);
    }
    return true;
  }

  private percentage(): number {
    const numerator = sourceInteger(this.world.numReachabilityAreas * 1000, "AAS reachability progress multiply");
    return sourceInteger(numerator / this.world.areas.length, "AAS reachability progress divide");
  }

  private store(): void {
    this.world.allocateReachability(this.linkCount + 10);
    this.world.reachabilitySize = 1;
    for (let area = 0; area < this.world.areas.length; area++) {
      const settings = this.world.areaSettingsRecord(area);
      settings.firstReachableArea = this.world.reachabilitySize;
      settings.reachableAreaCount = 0;
      for (let link = aasAt(this.heads, area); link !== null; link = link.next) {
        const reach = this.world.reachabilityRecord(settings.firstReachableArea + settings.reachableAreaCount);
        reach.area = link.area; reach.face = link.face; reach.edge = link.edge;
        reach.start.x = link.start.x; reach.start.y = link.start.y; reach.start.z = link.start.z;
        reach.end.x = link.end.x; reach.end.y = link.end.y; reach.end.z = link.end.z;
        reach.travelType = link.travelType; reach.travelTime = link.travelTime;
        settings.reachableAreaCount++;
      }
      this.world.reachabilitySize += settings.reachableAreaCount;
    }
  }
}
