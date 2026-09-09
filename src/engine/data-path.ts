import { homedir } from "node:os";
import { join } from "node:path";

export async function findDataPath(explicit?: string): Promise<string> {
  const requested = explicit ?? process.env["Q3_DATA"];
  if (requested !== undefined) {
    if (!await Bun.file(join(requested, "baseq3", "pak0.pk3")).exists()) {
      throw new Error(`No baseq3/pak0.pk3 in ${requested}`);
    }
    return requested;
  }
  const discovered = await discoverDataPath();
  if (discovered !== null) return discovered;
  throw new Error("Quake 3 retail data not found. Pass --data /path/to/Quake3 or set Q3_DATA.");
}

/** Optional installation discovery; common startup still owns native root overrides. */
export async function discoverDataPath(): Promise<string | null> {
  const candidates = [
    join(homedir(), "Projects", "qfiles", "q3a"),
    join(homedir(), ".local", "share", "Steam", "steamapps", "common", "Quake 3 Arena"),
  ];
  for (const path of candidates) if (await Bun.file(join(path, "baseq3", "pak0.pk3")).exists()) return path;
  return null;
}
