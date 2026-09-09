// clientActive_t parseEntities storage from id Software's client/client.h,
// cl_parse.c and cl_main.c. Copyright (C) 1999-2005 Id Software, Inc.
// GPL-2.0-or-later.
import { EntityStateRecord } from "../shared/entity-state.ts";
import type { SourceEntityState } from "../shared/entity-state.ts";

export const MAX_PARSE_ENTITIES = 2048;

/** Client-active allocation, including the partially written next entity cell. */
export class SourceParseEntities {
  private readonly cells = Array.from({ length: MAX_PARSE_ENTITIES }, () => new EntityStateRecord<number>(0));
  number = 0;

  at(absoluteIndex: number): SourceEntityState {
    const cell = this.cells[absoluteIndex & (MAX_PARSE_ENTITIES - 1)];
    if (cell === undefined) throw new Error("Missing parse entity ring cell");
    return cell;
  }

  advance(): void { this.number = (this.number + 1) | 0; }

  clear(): void {
    const zero = new EntityStateRecord<number>(0);
    for (const cell of this.cells) cell.copyFrom(zero);
    this.number = 0;
  }
}
