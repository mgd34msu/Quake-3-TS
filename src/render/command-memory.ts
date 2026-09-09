// Renderer command storage from id Software renderer/tr_cmds.c and tr_local.h.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import { CommonError } from "../core/common-error.ts";
import { SOURCE_BACKEND_RELEASE32 } from "./backend-memory.ts";
import type { SourceBackendMemory } from "./backend-memory.ts";

export const SOURCE_RENDER_COMMAND = Object.freeze({
  endOfList: 0, setColor: 1, stretchPic: 2, drawSurfs: 3, drawBuffer: 4, swapBuffers: 5, screenshot: 6,
});

// Pinned release32 members align to four bytes. orientationr_t is 124 bytes,
// trRefdef_t is 408, and viewParms_t is 492, making drawSurfsCommand_t 912.
export const SOURCE_COMMAND_RELEASE32 = Object.freeze({
  capacity: SOURCE_BACKEND_RELEASE32.commandBytes, endBytes: 4,
  setColorBytes: 20, stretchPicBytes: 40, drawSurfsBytes: 912,
  drawBufferBytes: 8, swapBuffersBytes: 4, screenshotBytes: 28,
  drawSurfsCount: 908,
});

/** Numeric commands live in these bytes; typed pointer bindings retain their command addresses. */
export class SourceCommandMemory<Reference> {
  private readonly localData: DataView | null;
  private readonly references = new Map<number, Reference>();

  private constructor(private readonly backend: SourceBackendMemory | null) {
    this.localData = backend === null ? new DataView(new ArrayBuffer(SOURCE_COMMAND_RELEASE32.capacity + 4)) : null;
  }

  static local<Reference>(): SourceCommandMemory<Reference> { return new SourceCommandMemory<Reference>(null); }
  static fromBackend<Reference>(backend: SourceBackendMemory): SourceCommandMemory<Reference> {
    return new SourceCommandMemory<Reference>(backend);
  }

  data(): DataView {
    if (this.backend !== null) return this.backend.commandsData();
    const data = this.localData;
    if (data === null) throw new Error("Local renderer commands have no allocation");
    return data;
  }

  get used(): number { return this.data().getInt32(SOURCE_COMMAND_RELEASE32.capacity, true); }

  /** R_GetCommandBuffer neither drains a full list nor rounds command sizes. */
  reserve(bytes: number): number | null {
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > 0x7fffffff) throw new RangeError("Renderer command size requires nonnegative int32");
    const data = this.data(), used = data.getInt32(SOURCE_COMMAND_RELEASE32.capacity, true);
    if (used + bytes + 4 > SOURCE_COMMAND_RELEASE32.capacity) {
      if (bytes > SOURCE_COMMAND_RELEASE32.capacity - 4) throw new CommonError("fatal", `R_GetCommandBuffer: bad size ${bytes}`);
      return null;
    }
    if (used < 0) throw new RangeError("Renderer command position precedes its allocation");
    data.setInt32(SOURCE_COMMAND_RELEASE32.capacity, used + bytes, true);
    // A newly occupied command invalidates overwritten TypeScript pointer bindings.
    // Untouched bindings beyond this command remain available to the source stale-tail scan.
    for (let offset = used; offset < used + bytes; offset += 4) this.references.delete(offset);
    return used;
  }

  retain(offset: number, reference: Reference): void { this.references.set(offset, reference); }
  reference(offset: number): Reference | undefined { this.data(); return this.references.get(offset); }

  /** R_IssueRenderCommands writes the terminator, then resets used before any execution. */
  issue(): void {
    const data = this.data(), used = data.getInt32(SOURCE_COMMAND_RELEASE32.capacity, true);
    if (used < 0 || used > SOURCE_COMMAND_RELEASE32.capacity - 4) throw new RangeError("Renderer command terminator exceeds its allocation");
    data.setInt32(used, SOURCE_RENDER_COMMAND.endOfList, true);
    data.setInt32(SOURCE_COMMAND_RELEASE32.capacity, 0, true);
  }

  /** Disposal can release typed borrows after the source hunk has already retired. */
  discardReferences(): void { this.references.clear(); }
}
