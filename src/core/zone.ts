// Ported from id Software's code/qcommon/common.c zone allocator.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CommonError } from "./common-error.ts";

export enum ZoneTag {
  Free = 0,
  General = 1,
  Botlib = 2,
  Renderer = 3,
  Small = 4,
  Static = 5,
}

const ZONE_ID = 0x1d4a11;
const BLOCK_BYTES = 20;
const ZONE_BYTES = 32;
const SENTINEL_OFFSET = 8;
const ROVER_OFFSET = 28;
const MIN_FRAGMENT = 64;

export interface ZoneAllocation {
  /** Borrow for the current operation; an already obtained view cannot be revoked. */
  readonly bytes: Uint8Array;
}

export interface ZoneMemoryInfo {
  readonly usedBytes: number;
  readonly blockCount: number;
  readonly botlibBytes: number;
  readonly rendererBytes: number;
}

interface AllocationRecord {
  readonly offset: number;
  bytes: Uint8Array | null;
}

/** Release32, without ZONE_DEBUG. Pointer words contain offsets in this arena. */
class ZoneBlock {
  allocation: AllocationRecord | null = null;

  constructor(readonly offset: number, private readonly view: DataView) {}

  get size(): number { return this.view.getInt32(this.offset, true); }
  set size(value: number) { this.view.setInt32(this.offset, value, true); }
  get tag(): number { return this.view.getInt32(this.offset + 4, true); }
  set tag(value: number) { this.view.setInt32(this.offset + 4, value, true); }
  get next(): number { return this.view.getUint32(this.offset + 8, true); }
  set next(value: number) { this.view.setUint32(this.offset + 8, value, true); }
  get prev(): number { return this.view.getUint32(this.offset + 12, true); }
  set prev(value: number) { this.view.setUint32(this.offset + 12, value, true); }
  get id(): number { return this.view.getInt32(this.offset + 16, true); }
  set id(value: number) { this.view.setInt32(this.offset + 16, value, true); }
}

class ZoneStorage {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly blocks = new Map<number, ZoneBlock>();
  readonly sentinel: ZoneBlock;

  constructor(byteLength: number) {
    this.bytes = new Uint8Array(byteLength);
    this.view = new DataView(this.bytes.buffer);
    this.sentinel = this.addBlock(SENTINEL_OFFSET);
    const block = this.addBlock(ZONE_BYTES);
    this.sentinel.next = this.sentinel.prev = block.offset;
    this.sentinel.tag = 1;
    this.sentinel.id = 0;
    this.sentinel.size = 0;
    this.rover = block.offset;
    this.view.setInt32(0, byteLength, true);
    this.used = 0;
    block.prev = block.next = this.sentinel.offset;
    block.tag = 0;
    block.id = ZONE_ID;
    block.size = byteLength - ZONE_BYTES;
  }

  get used(): number { return this.view.getInt32(4, true); }
  set used(value: number) { this.view.setInt32(4, value, true); }
  get rover(): number { return this.view.getUint32(ROVER_OFFSET, true); }
  set rover(value: number) { this.view.setUint32(ROVER_OFFSET, value, true); }

  addBlock(offset: number): ZoneBlock {
    if (offset < 0 || offset + BLOCK_BYTES > this.bytes.length || this.blocks.has(offset)) {
      throw new CommonError("fatal", "Zone allocator: invalid block address");
    }
    const block = new ZoneBlock(offset, this.view);
    this.blocks.set(offset, block);
    return block;
  }

  block(offset: number): ZoneBlock {
    const block = this.blocks.get(offset);
    if (block === undefined) throw new CommonError("fatal", "Zone allocator: invalid block pointer");
    return block;
  }

  blockEnd(block: ZoneBlock, operation: string): number {
    const end = block.offset + block.size;
    if (block === this.sentinel || block.size < BLOCK_BYTES + 4 || end > this.bytes.length) {
      throw new CommonError("fatal", `${operation}: invalid block size`);
    }
    return end;
  }
}

/** An actual source zone. Static CopyString storage is outside this arena. */
export class ZoneArena {
  private storage: ZoneStorage | null;
  private readonly allocations = new WeakMap<ZoneAllocation, AllocationRecord>();

  constructor(byteLength: number, private readonly name: "main" | "small" = "main") {
    if (!Number.isInteger(byteLength) || byteLength < ZONE_BYTES + BLOCK_BYTES || byteLength > 0x7fffffff) {
      throw new RangeError("Zone size must fit a source signed int and its zone and block headers");
    }
    this.storage = new ZoneStorage(byteLength);
  }

  allocate(size: number, tag: number, clear = false): ZoneAllocation {
    if (tag === 0) throw new CommonError("fatal", "Z_TagMalloc: tried to use a 0 tag");
    this.validateTag(tag);
    if (!Number.isInteger(size) || size < 0 || size > 0x7ffffffc - BLOCK_BYTES - 4) {
      throw new RangeError("Zone allocation must fit a nonnegative aligned source signed size");
    }
    const storage = this.requireStorage("Z_TagMalloc");
    const total = Math.ceil((size + BLOCK_BYTES + 4) / 4) * 4;
    let base = storage.block(storage.rover);
    let rover = base;
    const start = storage.block(base.prev);
    let remaining = storage.blocks.size + 1;
    do {
      if (rover === start) {
        throw new CommonError("fatal", `Z_Malloc: failed on allocation of ${total} bytes from the ${this.name} zone`);
      }
      if (--remaining < 0) throw new CommonError("fatal", "Z_TagMalloc: corrupt block list");
      if (rover.tag !== 0) base = rover = storage.block(rover.next);
      else rover = storage.block(rover.next);
    } while (base.tag !== 0 || base.size < total);

    storage.blockEnd(base, "Z_TagMalloc");
    const extra = base.size - total;
    if (extra > MIN_FRAGMENT) {
      const fragment = storage.addBlock(base.offset + total);
      fragment.size = extra;
      fragment.tag = 0;
      fragment.prev = base.offset;
      fragment.id = ZONE_ID;
      fragment.next = base.next;
      storage.block(fragment.next).prev = fragment.offset;
      base.next = fragment.offset;
      base.size = total;
    }
    base.tag = tag;
    storage.rover = base.next;
    storage.used += base.size;
    base.id = ZONE_ID;
    storage.view.setInt32(base.offset + base.size - 4, ZONE_ID, true);
    const bytes = storage.bytes.subarray(base.offset + BLOCK_BYTES, base.offset + BLOCK_BYTES + size);
    if (clear) bytes.fill(0);
    const record: AllocationRecord = { offset: base.offset, bytes };
    const allocation: ZoneAllocation = {
      get bytes(): Uint8Array {
        if (record.bytes === null) throw new CommonError("fatal", "Zone allocation is no longer valid");
        return record.bytes;
      },
    };
    base.allocation = record;
    this.allocations.set(allocation, record);
    return allocation;
  }

  free(allocation: ZoneAllocation | null): void {
    if (allocation === null) throw new CommonError("drop", "Z_Free: NULL pointer");
    const record = this.allocations.get(allocation);
    if (record === undefined) throw new CommonError("fatal", "Z_Free: freed a pointer without ZONEID");
    if (record.bytes === null) throw new CommonError("fatal", "Z_Free: freed a freed pointer");
    const storage = this.requireStorage("Z_Free");
    this.freeBlock(storage, storage.block(record.offset));
  }

  freeTags(tag: number): void {
    this.validateTag(tag);
    const storage = this.requireStorage("Z_FreeTags");
    storage.rover = storage.sentinel.next;
    let remaining = storage.blocks.size * 2 + 1;
    do {
      if (--remaining < 0) throw new CommonError("fatal", "Z_FreeTags: corrupt block list");
      const block = storage.block(storage.rover);
      if (block.tag === tag) {
        this.freeBlock(storage, block);
        if (tag === ZoneTag.Static) throw new CommonError("fatal", "Z_FreeTags: static blocks cannot be reclaimed");
        continue;
      }
      storage.rover = block.next;
    } while (storage.rover !== storage.sentinel.offset);
  }

  memoryRemaining(): number {
    const storage = this.requireStorage("Z_AvailableZoneMemory");
    return (storage.view.getInt32(0, true) - storage.used) | 0;
  }

  get byteLength(): number { return this.requireStorage("Com_Meminfo_f").bytes.byteLength; }

  /** Com_Meminfo_f; zone+ offsets identify actual arena headers, not native pointers. */
  memoryInfo(print: (text: string) => void, verbose = false): ZoneMemoryInfo {
    const storage = this.requireStorage("Com_Meminfo_f");
    let usedBytes = 0, blockCount = 0, botlibBytes = 0, rendererBytes = 0;
    let block = storage.block(storage.sentinel.next);
    for (;;) {
      if (this.name === "main" && verbose) {
        print(`block:zone+0x${block.offset.toString(16)}    size:${String(block.size).padStart(7)}    tag:${String(block.tag).padStart(3)}\n`);
      }
      if (block.tag !== 0) {
        usedBytes = (usedBytes + block.size) | 0; blockCount++;
        if (block.tag === ZoneTag.Botlib) botlibBytes = (botlibBytes + block.size) | 0;
        else if (block.tag === ZoneTag.Renderer) rendererBytes = (rendererBytes + block.size) | 0;
      }
      if (block.next === storage.sentinel.offset) break;
      if (this.name === "main") {
        if (block.offset + block.size !== block.next) print("ERROR: block size does not touch the next block\n");
        if (storage.block(block.next).prev !== block.offset) print("ERROR: next block doesn't have proper back link\n");
        if (block.tag === 0 && storage.block(block.next).tag === 0) print("ERROR: two consecutive free blocks\n");
      }
      block = storage.block(block.next);
    }
    return { usedBytes, blockCount, botlibBytes, rendererBytes };
  }

  /** Z_LogZoneHeap's release branch intentionally stops before the final block. */
  logHeap(name: string, write: (text: string) => void): void {
    const storage = this.requireStorage("Z_LogZoneHeap");
    let size = 0, count = 0;
    write(`\r\n================\r\n${name} log\r\n================\r\n`);
    for (let block = storage.block(storage.sentinel.next); block.next !== storage.sentinel.offset; block = storage.block(block.next)) {
      if (block.tag !== 0) { size = (size + block.size) | 0; count++; }
    }
    write(`${size} ${name} memory in ${count} blocks\r\n`);
    write(`${(size - count * BLOCK_BYTES) | 0} ${name} memory overhead\r\n`);
  }

  checkHeap(): void {
    const storage = this.requireStorage("Z_CheckHeap");
    let block = storage.block(storage.sentinel.next);
    let remaining = storage.blocks.size;
    for (;;) {
      const next = storage.block(block.next);
      if (next === storage.sentinel) break;
      if (block.offset + block.size !== next.offset) {
        throw new CommonError("fatal", "Z_CheckHeap: block size does not touch the next block\n");
      }
      if (next.prev !== block.offset) {
        throw new CommonError("fatal", "Z_CheckHeap: next block doesn't have proper back link\n");
      }
      if (block.tag === 0 && next.tag === 0) {
        throw new CommonError("fatal", "Z_CheckHeap: two consecutive free blocks\n");
      }
      if (--remaining < 0) throw new CommonError("fatal", "Z_CheckHeap: corrupt block list");
      block = next;
    }
  }

  /** Com_TouchMemory walks tagged blocks from their real release32 headers. */
  touchMemory(): number {
    const storage = this.requireStorage("Com_TouchMemory");
    let sum = 0;
    let block = storage.block(storage.sentinel.next);
    let remaining = storage.blocks.size;
    for (;;) {
      if (block.tag !== 0) {
        const end = block.size >> 2;
        for (let index = 0; index < end; index += 64) {
          sum = (sum + storage.view.getInt32(block.offset + index * 4, true)) | 0;
        }
      }
      if (block.next === storage.sentinel.offset) break;
      if (--remaining < 0) throw new CommonError("fatal", "Com_TouchMemory: corrupt block list");
      block = storage.block(block.next);
    }
    return sum;
  }

  dispose(): void {
    if (this.storage === null) return;
    for (const block of this.storage.blocks.values()) {
      if (block.allocation !== null) block.allocation.bytes = null;
    }
    this.storage = null;
  }

  private requireStorage(operation: string): ZoneStorage {
    if (this.storage === null) throw new CommonError("fatal", `${operation}: zone has been disposed`);
    return this.storage;
  }

  private validateTag(tag: number): void {
    if (!Number.isInteger(tag) || tag < -0x80000000 || tag > 0x7fffffff) {
      throw new RangeError("Zone tag must fit a source signed int");
    }
    if ((tag === ZoneTag.Small) !== (this.name === "small")) {
      throw new RangeError("TAG_SMALL allocations belong to the small zone; other tags belong to the main zone");
    }
  }

  private freeBlock(storage: ZoneStorage, initial: ZoneBlock): void {
    let block = initial;
    if (block.id !== ZONE_ID) throw new CommonError("fatal", "Z_Free: freed a pointer without ZONEID");
    if (block.tag === 0) throw new CommonError("fatal", "Z_Free: freed a freed pointer");
    if (block.tag === ZoneTag.Static) return;
    const end = storage.blockEnd(block, "Z_Free");
    if (storage.view.getInt32(end - 4, true) !== ZONE_ID) {
      throw new CommonError("fatal", "Z_Free: memory block wrote past end");
    }
    this.validateTag(block.tag);
    storage.used -= block.size;
    storage.bytes.fill(0xaa, block.offset + BLOCK_BYTES, end);
    block.tag = 0;
    if (block.allocation !== null) block.allocation.bytes = null;
    block.allocation = null;

    let other = storage.block(block.prev);
    if (other.tag === 0) {
      other.size += block.size;
      other.next = block.next;
      storage.block(other.next).prev = other.offset;
      if (block.offset === storage.rover) storage.rover = other.offset;
      storage.blocks.delete(block.offset);
      block = other;
    }
    storage.rover = block.offset;
    other = storage.block(block.next);
    if (other.tag === 0) {
      block.size += other.size;
      block.next = other.next;
      storage.block(block.next).prev = block.offset;
      if (other.offset === storage.rover) storage.rover = block.offset;
      storage.blocks.delete(other.offset);
    }
  }
}
