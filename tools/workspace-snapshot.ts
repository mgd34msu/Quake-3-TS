import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type SnapshotEntry =
  | { readonly kind: "file"; readonly path: string; readonly mode: number; readonly bytes: Uint8Array; readonly sha256: string }
  | { readonly kind: "link"; readonly path: string; readonly target: string };

export type SnapshotFile =
  | { readonly kind: "file"; readonly path: string; readonly mode: number; readonly bytes: number; readonly sha256: string }
  | { readonly kind: "link"; readonly path: string; readonly target: string };

export interface SnapshotManifest {
  readonly sha256: string;
  readonly files: readonly SnapshotFile[];
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function excluded(path: string, name: string): boolean {
  if (name === ".git") return true;
  if (path.includes("/")) return false;
  return name === "dist" || name === ".artifacts" || /\.(?:bundle|zip|pk3|log)$/.test(name);
}

/** Owns the exact source, tooling and installed dependency bytes used by a check. */
export class WorkspaceSnapshot {
  readonly #entries: readonly SnapshotEntry[];
  readonly manifest: SnapshotManifest;

  private constructor(entries: readonly SnapshotEntry[]) {
    this.#entries = entries;
    const files: SnapshotFile[] = entries.map(entry => entry.kind === "link"
      ? { kind: "link", path: entry.path, target: entry.target }
      : { kind: "file", path: entry.path, mode: entry.mode, bytes: entry.bytes.length, sha256: entry.sha256 });
    this.manifest = { sha256: Bun.CryptoHasher.hash("sha256", JSON.stringify(files), "hex"), files };
  }

  static async capture(directory: string): Promise<WorkspaceSnapshot> {
    const root = await realpath(directory);
    const dependencyRoot = join(root, "node_modules");
    const entries: SnapshotEntry[] = [];
    async function visit(directoryPath: string, prefix: string): Promise<void> {
      for (const child of await readdir(directoryPath, { withFileTypes: true })) {
        const path = prefix === "" ? child.name : `${prefix}/${child.name}`;
        if (excluded(path, child.name)) continue;
        if (/^(?:q3key|quake3cdkey)(?:\..*)?$/i.test(child.name)) {
          throw new Error(`Snapshot refuses a credential filename: ${path}`);
        }
        const absolutePath = join(directoryPath, child.name);
        if (child.isDirectory()) {
          await visit(absolutePath, path);
        } else if (child.isSymbolicLink()) {
          const target = await readlink(absolutePath);
          if (!path.startsWith("node_modules/") || isAbsolute(target)
            || !isWithin(dependencyRoot, resolve(dirname(absolutePath), target))
            || !isWithin(dependencyRoot, await realpath(absolutePath))) {
            throw new Error(`Snapshot refuses a source or external dependency symlink: ${path}`);
          }
          entries.push({ kind: "link", path, target });
        } else if (child.isFile()) {
          const stat = await lstat(absolutePath);
          if (!stat.isFile()) throw new Error(`Snapshot input changed file kind: ${path}`);
          const bytes = new Uint8Array(await readFile(absolutePath));
          entries.push({ kind: "file", path, mode: stat.mode & 0o777, bytes, sha256: Bun.CryptoHasher.hash("sha256", bytes, "hex") });
        } else {
          throw new Error(`Snapshot refuses a non-regular input: ${path}`);
        }
      }
    }
    await visit(root, "");
    entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    return new WorkspaceSnapshot(entries);
  }

  async materialize(parent: string, prefix: "check-" | "build-" | "test-"): Promise<string> {
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(resolve(parent), prefix));
    for (const entry of this.#entries) {
      const path = join(root, entry.path);
      await mkdir(dirname(path), { recursive: true });
      if (entry.kind === "link") await symlink(entry.target, path);
      else {
        await Bun.write(path, entry.bytes);
        await chmod(path, entry.mode);
      }
    }
    return root;
  }
}
