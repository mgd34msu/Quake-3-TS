import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { ReadFileMemory } from "../src/assets/read-file-memory.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";

export function withRetainedFiles<T extends Pick<SourceFileReader, "readFileOptional"> & Partial<SourceFileReader & AssetReader & { readSync(path: string): Uint8Array }>>(reader: T, fallback?: RetainedFileReader): T & RetainedFileReader {
  const memory = new ReadFileMemory();
  const owned = new Set<Parameters<RetainedFileReader["freeFile"]>[0]>();
  const retain = (bytes: Uint8Array) => { const buffer = memory.read(bytes.byteLength, target => { target.set(bytes); }); owned.add(buffer); return buffer; };
  const retained: RetainedFileReader = {
    async readFileRetained(path) {
      const bytes = await reader.readFileOptional(path);
      return bytes === undefined ? fallback?.readFileRetained(path) : retain(bytes);
    },
    readFileRetainedSync(path) {
      if (!("readFileOptionalSync" in reader) || typeof reader.readFileOptionalSync !== "function") {
        if (fallback !== undefined) return fallback.readFileRetainedSync(path);
        throw new Error(`Fixture does not supply synchronous source reads: ${path}`);
      }
      const bytes: unknown = reader.readFileOptionalSync(path);
      if (bytes === undefined) return fallback?.readFileRetainedSync(path);
      if (!(bytes instanceof Uint8Array)) throw new Error(`Invalid synchronous fixture bytes: ${path}`);
      return retain(bytes);
    },
    freeFile(buffer) { if (owned.has(buffer) || fallback === undefined) { memory.freeFile(buffer); owned.delete(buffer); } else fallback.freeFile(buffer); },
  };
  return Object.assign(reader, retained);
}
