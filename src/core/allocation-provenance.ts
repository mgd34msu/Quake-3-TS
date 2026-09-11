import type { AllocationProvenance } from "./zone.ts";

/** Debug-only caller location. Bun remaps captured stacks with embedded source maps.
 * Labels name the port operation; they do not reconstruct the C size expression. */
export function captureAllocationProvenance(label: string): AllocationProvenance | null {
  const error = new Error();
  Error.captureStackTrace(error, captureAllocationProvenance);
  const stack: unknown = error.stack;
  if (typeof stack !== "string") return null;
  const caller = stack.split("\n")[2];
  if (caller === undefined) return null;
  const location = /^\s+at (?:.+ \()?(.+?):(\d+)(?::\d+)?\)?$/.exec(caller);
  if (location === null) return null;
  const file = location[1], lineText = location[2];
  if (file === undefined || lineText === undefined) return null;
  const line = Number(lineText);
  return Number.isSafeInteger(line) && line > 0 ? { label, file, line } : null;
}
