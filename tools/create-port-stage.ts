import { mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { WorkspaceSnapshot } from "./workspace-snapshot.ts";

export interface PortStage {
  readonly sourceDirectory: string;
  readonly root: string;
  readonly baseline: string;
  readonly candidate: string;
  readonly manifestSha256: string;
  readonly fileCount: number;
  readonly metadataPath: string;
}

/** Uses the canonical workspace inventory, including its exclusions and link policy. */
export async function createPortStage(sourceDirectory: string, parentDirectory: string): Promise<PortStage> {
  const source = await realpath(sourceDirectory), parent = await realpath(parentDirectory);
  if (!(await stat(source)).isDirectory() || !(await stat(parent)).isDirectory())
    throw new Error("Port stage source and parent must be existing directories");
  const path = relative(source, parent);
  if (path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)))
    throw new Error("Port stage parent must be outside the source directory");
  const root = await mkdtemp(join(parent, "quake3-port-stage-"));
  try {
    const snapshot = await WorkspaceSnapshot.capture(source);
    const baseline = await snapshot.materialize(root, "test-");
    const candidate = await snapshot.materialize(root, "test-");
    for (const directory of [baseline, candidate, source]) {
      const captured = await WorkspaceSnapshot.capture(directory);
      if (captured.manifest.sha256 !== snapshot.manifest.sha256
        || JSON.stringify(captured.manifest.files) !== JSON.stringify(snapshot.manifest.files))
        throw new Error(`Port stage input drift detected at ${directory}`);
    }
    const result: PortStage = { sourceDirectory: source, root, baseline, candidate,
      manifestSha256: snapshot.manifest.sha256, fileCount: snapshot.manifest.files.length, metadataPath: join(root, "CAPTURE.json") };
    await writeFile(result.metadataPath, `${JSON.stringify({ ...result, manifest: snapshot.manifest }, null, 2)}\n`, { flag: "wx" });
    return result;
  } catch (cause) {
    throw new Error(`Port stage creation failed; partial stage preserved at ${root}`, { cause });
  }
}

if (import.meta.main) {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_.length > 1) throw new Error("Usage: bun tools/create-port-stage.ts [parent-directory]");
    console.log(JSON.stringify(await createPortStage(process.cwd(), arguments_[0] ?? tmpdir())));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
