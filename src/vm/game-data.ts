// SV_LocateGameData, SV_GentityNum, SV_GameClientNum and SV_NumForGentity
// from id Software's code/server/sv_game.c. GPL-2.0-or-later.
// Copyright (C) 1999-2005 Id Software, Inc.
import type { Product } from "../shared/definitions.ts";
import type { SharedEntity } from "../shared/entity-shared.ts";
import type { SourcePlayerState } from "../shared/player-state.ts";
import type { ServerGameData } from "../server/game.ts";
import type { QvmMemory } from "./memory.ts";
import { QVM_PLAYER_STATE_BYTES, readQvmPlayerState } from "./player-record.ts";
import { QVM_SHARED_ENTITY_BYTES, borrowQvmSharedEntity } from "./shared-entity-record.ts";

function int32(value: number): void {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new RangeError("Game-data indexes and strides require signed 32-bit words");
  }
}

/** Borrows the interpreter allocation. Relocation changes table descriptors, not existing pointers. */
export class QvmGameData implements ServerGameData {
  private entities: number | null = null;
  private entityStride = 0;
  private count = 0;
  private clients: number | null = null;
  private clientStride = 0;
  private readonly entityPointers = new Map<number, SharedEntity>();

  constructor(private readonly memory: QvmMemory, private readonly product: Product) {}

  get numEntities(): number { return this.count; }

  locate(entitiesWord: number, numEntities: number, entityStride: number,
    clientsWord: number, clientStride: number): void {
    const entities = this.offset(entitiesWord), clients = this.offset(clientsWord);
    int32(numEntities); int32(entityStride); int32(clientStride);
    this.entities = entities;
    this.entityStride = entityStride;
    this.count = numEntities;
    this.clients = clients;
    this.clientStride = clientStride;
  }

  private offset(word: number): number | null {
    const pointer = this.memory.pointer(word);
    return pointer === null ? null : pointer.byteOffset - this.memory.bytes.byteOffset;
  }

  private indexed(base: number | null, stride: number, number: number): number {
    if (base === null) throw new RangeError("Game-data table has a null source pointer");
    int32(number);
    const displacement = stride * number;
    int32(displacement);
    const offset = base + displacement;
    if (offset < 0 || offset > this.memory.bytes.byteLength) {
      throw new RangeError("Game-data pointer arithmetic leaves the interpreter allocation");
    }
    return offset;
  }

  private view(offset: number, size: number): DataView {
    const bytes = this.memory.bytes;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.byteLength - size) {
      throw new RangeError("Game-data record exceeds the interpreter allocation");
    }
    return new DataView(bytes.buffer, bytes.byteOffset + offset, size);
  }

  private entityAt(offset: number): SharedEntity {
    const existing = this.entityPointers.get(offset);
    if (existing !== undefined) return existing;
    const entity = borrowQvmSharedEntity(this.view(offset, QVM_SHARED_ENTITY_BYTES));
    this.entityPointers.set(offset, entity);
    return entity;
  }

  entity(number: number): SharedEntity {
    return this.entityAt(this.indexed(this.entities, this.entityStride, number));
  }

  entityFromPointer(word: number): SharedEntity {
    const offset = this.offset(word);
    if (offset === null) throw new RangeError("Game entity requires a nonnull source pointer");
    return this.entityAt(offset);
  }

  numberFromPointer(word: number): number {
    const offset = this.offset(word), base = this.entities;
    if (offset === null || base === null) throw new RangeError("Entity numbering requires nonnull source pointers");
    if (this.entityStride === 0) throw new RangeError("Entity numbering requires a nonzero source stride");
    return Math.trunc((offset - base) / this.entityStride) | 0;
  }

  copyPlayerState(number: number): SourcePlayerState {
    return readQvmPlayerState(this.view(this.indexed(this.clients, this.clientStride, number), QVM_PLAYER_STATE_BYTES), this.product);
  }

  setPlayerPing(number: number, ping: number): void {
    // The server writes this field directly, without reading or copying the rest of playerState_t.
    const offset = this.indexed(this.clients, this.clientStride, number);
    this.view(offset + 452, 4).setInt32(0, ping, true);
  }
}
