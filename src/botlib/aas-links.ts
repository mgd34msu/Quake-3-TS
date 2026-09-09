/*
 * AAS link storage translated from id Software's botlib/be_aas_sample.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { BotMemory } from "./memory.ts";
import type { BotMemoryAllocation } from "./memory.ts";

export interface AasLink {
  entity: number;
  area: number;
  previousEntity: AasLink | null;
  nextEntity: AasLink | null;
  previousArea: AasLink | null;
  nextArea: AasLink | null;
}

const LINK_BYTES = 24;

class AasLinkStorage {
  private cached: { readonly view: DataView; readonly byteOffset: number; readonly byteLength: number } | null = null;

  constructor(readonly allocation: BotMemoryAllocation) {}

  view(): DataView {
    const bytes = this.allocation.bytes;
    let cached = this.cached;
    if (cached === null || cached.view.buffer !== bytes.buffer || cached.byteOffset !== bytes.byteOffset || cached.byteLength !== bytes.byteLength) {
      cached = { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        byteOffset: bytes.byteOffset, byteLength: bytes.byteLength };
      this.cached = cached;
    }
    return cached.view;
  }
}

/** Stable link identity; all six source fields reside in the hunk allocation. */
class AasLinkCell implements AasLink {
  constructor(readonly index: number, private readonly storage: AasLinkStorage,
    private readonly decode: (reference: number) => AasLink | null,
    private readonly encode: (link: AasLink | null) => number) {}

  private read(offset: number): number {
    return this.storage.view().getInt32(this.index * LINK_BYTES + offset, true);
  }

  private write(offset: number, value: number): void {
    this.storage.view().setInt32(this.index * LINK_BYTES + offset, value, true);
  }

  get entity(): number { return this.read(0); }
  set entity(value: number) { this.write(0, value); }
  get area(): number { return this.read(4); }
  set area(value: number) { this.write(4, value); }
  get nextEntity(): AasLink | null { return this.decode(this.read(8)); }
  set nextEntity(value: AasLink | null) { this.write(8, this.encode(value)); }
  get previousEntity(): AasLink | null { return this.decode(this.read(12)); }
  set previousEntity(value: AasLink | null) { this.write(12, this.encode(value)); }
  get nextArea(): AasLink | null { return this.decode(this.read(16)); }
  set nextArea(value: AasLink | null) { this.write(16, this.encode(value)); }
  get previousArea(): AasLink | null { return this.decode(this.read(20)); }
  set previousArea(value: AasLink | null) { this.write(20, this.encode(value)); }
}

/** The source area pointer array stores one-based link slots, with zero for NULL. */
export class AasLinkHeads {
  private storage: AasLinkStorage | null;

  constructor(private readonly memory: BotMemory, count: number,
    private readonly decode: (reference: number) => AasLink | null,
    private readonly encode: (link: AasLink | null) => number) {
    this.storage = new AasLinkStorage(memory.allocate(count * 4, "hunk", true));
  }

  private view(): DataView {
    if (this.storage === null) throw new RangeError("AAS area link heads have been freed");
    return this.storage.view();
  }

  get(area: number): AasLink | null { return this.decode(this.view().getInt32(area * 4, true)); }
  set(area: number, link: AasLink | null): void { this.view().setInt32(area * 4, this.encode(link), true); }

  free(): void {
    if (this.storage !== null) this.memory.free(this.storage.allocation);
    this.storage = null;
  }
}

/** AAS_InitAASLinkHeap retains its cells across maps and rebuilds their free list. */
export class AasLinkHeap {
  private links: AasLinkCell[] | null = null;
  private allocation: BotMemoryAllocation | null = null;
  private firstFree: AasLink | null = null;
  private available = 0;

  constructor(private readonly onEmpty: () => void, private readonly memory: BotMemory = new BotMemory()) {}

  get capacity(): number { return this.links === null ? 0 : this.links.length; }
  get freeCount(): number { return this.available; }

  initialize(readMaximum: () => number): void {
    if (this.links === null) {
      const maximum = Math.trunc(readMaximum());
      if (!Number.isFinite(maximum) || maximum < -2147483648 || maximum > 2147483647) {
        throw new RangeError("AAS_InitAASLinkHeap: source float-to-int conversion is undefined");
      }
      const capacity = Math.max(0, maximum);
      if (capacity < 2) {
        throw new RangeError("AAS_InitAASLinkHeap: fewer than two links forms pointers outside the source allocation");
      }
      const allocation = this.memory.allocate(capacity * LINK_BYTES, "hunk", false);
      const storage = new AasLinkStorage(allocation);
      const links = Array.from({ length: capacity }, (_, index) => new AasLinkCell(index, storage,
        reference => this.decode(reference), link => this.encode(link)));
      this.allocation = allocation;
      this.links = links;
    }
    let previous: AasLink | null = null;
    this.firstFree = null;
    for (const link of this.links) {
      link.previousEntity = previous;
      link.nextEntity = null;
      if (previous === null) this.firstFree = link;
      else previous.nextEntity = link;
      previous = link;
    }
    this.available = this.links.length;
  }

  createAreaHeads(count: number): AasLinkHeads {
    return new AasLinkHeads(this.memory, count, reference => this.decode(reference), link => this.encode(link));
  }

  decode(reference: number): AasLink | null {
    if (reference === 0) return null;
    const link = this.links?.[reference - 1];
    if (link === undefined) throw new RangeError("AAS link reference exceeds the retained heap");
    return link;
  }

  encode(link: AasLink | null): number {
    if (link === null) return 0;
    if (!(link instanceof AasLinkCell) || this.links?.[link.index] !== link) {
      throw new RangeError("AAS link does not belong to the retained heap");
    }
    return link.index + 1;
  }

  allocate(): AasLink | null {
    const link = this.firstFree;
    if (link === null) {
      this.onEmpty();
      return null;
    }
    this.firstFree = link.nextEntity;
    if (this.firstFree !== null) this.firstFree.previousEntity = null;
    this.available--;
    return link;
  }

  release(link: AasLink): void {
    if (this.firstFree !== null) this.firstFree.previousEntity = link;
    link.previousEntity = null;
    link.nextEntity = this.firstFree;
    link.previousArea = null;
    link.nextArea = null;
    this.firstFree = link;
    this.available++;
  }

  free(): void {
    if (this.allocation !== null) this.memory.free(this.allocation);
    this.allocation = null;
    this.links = null;
    this.firstFree = null;
    this.available = 0;
  }
}
