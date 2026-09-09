import { expect, test } from "bun:test";
import { CommonError } from "../src/core/common-error.ts";
import { HunkArena, initializeHunk } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";

function errorFrom(operation: () => unknown): CommonError {
  try { operation(); }
  catch (error) {
    if (!(error instanceof CommonError)) throw error;
    return error;
  }
  throw new Error("Expected a source common error");
}

test("Hunk_Alloc and Hunk_AllocateTempMemory exhaustion propagate source drop errors", () => {
  const arena = new HunkArena(64, () => {}), accounting = new SourceHunkAccounting(arena);
  accounting.reserve("fixture", "full arena", 64, "low");
  const before = arena.snapshot();
  const permanent = errorFrom(() => accounting.reserve("fixture", "overflow", 1, "low"));
  expect(permanent.code).toBe("drop");
  expect(permanent.message).toBe("Hunk_Alloc failed on 32");
  const temporary = errorFrom(() => accounting.allocateTemp("fixture", "overflow", 1));
  expect(temporary.code).toBe("drop");
  expect(temporary.message).toBe("Hunk_AllocateTempMemory: failed on 12");
  expect(arena.snapshot().low.permanent).toBe(before.low.permanent);
  expect(arena.memoryRemaining()).toBe(0);
});

test("Hunk_FreeTempMemory bad magic is fatal before counters or storage change", () => {
  const arena = new HunkArena(64, () => {}), temporary = arena.allocateTemp(4);
  const header = new DataView(temporary.bytes.buffer);
  header.setUint32(temporary.byteOffset - 8, 0, true);
  const before = arena.snapshot();
  const error = errorFrom(() => arena.freeTemp(temporary));
  expect(error.code).toBe("fatal");
  expect(error.message).toBe("Hunk_FreeTempMemory: bad magic");
  expect(arena.snapshot()).toEqual(before);
  expect(header.getUint32(temporary.byteOffset - 8, true)).toBe(0);
});

test("Com_InitHunkMemory rejects an outstanding filesystem load stack as fatal", () => {
  const error = errorFrom(() => initializeHunk({ megs: 1, dedicated: true, filesystemLoadStack: 1 }, () => {}, null));
  expect(error.code).toBe("fatal");
  expect(error.message).toBe("Hunk initialization failed. File system load stack not zero");
});
