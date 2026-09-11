import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceSnapshot } from "./workspace-snapshot.ts";

const workspace = process.cwd();
const snapshot = await WorkspaceSnapshot.capture(workspace);
const snapshotPath = await snapshot.materialize(join(workspace, ".artifacts/snapshots"), "build-");
const check = Bun.spawn([process.execPath, "run", "typecheck"], { cwd: snapshotPath, stdout: "inherit", stderr: "inherit" });
if (await check.exited !== 0) process.exit(1);
const policy = Bun.spawn([process.execPath, "run", "policy"], { cwd: snapshotPath, stdout: "inherit", stderr: "inherit" });
if (await policy.exited !== 0) process.exit(1);
const buildPath = join(snapshotPath, "dist/quake3-ts");
await mkdir(join(snapshotPath, "dist"), { recursive: true });
const result = await Bun.build({
  entrypoints: [join(snapshotPath, "src/main.ts"), join(snapshotPath, "src/render/cpu/triangle-worker.ts"),
    join(snapshotPath, "src/render/threaded-backend-worker.ts")],
  target: "bun",
  naming: { entry: "[name].ts" },
  compile: { outfile: buildPath },
  sourcemap: "inline",
});
if (!result.success) {
  for (const log of result.logs) process.stderr.write(`${log}\n`);
  process.exit(1);
}
if ((await WorkspaceSnapshot.capture(snapshotPath)).manifest.sha256 !== snapshot.manifest.sha256
  || (await WorkspaceSnapshot.capture(workspace)).manifest.sha256 !== snapshot.manifest.sha256) {
  throw new Error(`Build inputs changed. Existing dist/quake3-ts was not replaced; candidate remains at ${buildPath}`);
}
const binarySha256 = Bun.CryptoHasher.hash("sha256", await Bun.file(buildPath).bytes(), "hex");
// Bun 1.3.14 also writes redundant companions for compiled inline maps.
// Archive them away from the published executable, whose debug maps are embedded.
const companions: { readonly archivedCompanion: string; readonly sha256: string }[] = [];
for (const mapName of ["main.ts.map", "triangle-worker.ts.map", "threaded-backend-worker.ts.map"]) {
  const generatedMap = join(snapshotPath, "dist", mapName);
  const archivedMap = join(snapshotPath, ".artifacts", `build-${mapName}`);
  if (await Bun.file(generatedMap).exists()) {
    const sha256 = Bun.CryptoHasher.hash("sha256", await Bun.file(generatedMap).bytes(), "hex");
    await mkdir(join(snapshotPath, ".artifacts"), { recursive: true });
    await rename(generatedMap, archivedMap);
    companions.push({ archivedCompanion: archivedMap, sha256 });
  }
}
await mkdir(join(workspace, "dist"), { recursive: true });
const previousMap = join(workspace, "dist/main.js.map");
if (await Bun.file(previousMap).exists()) {
  const savedMap = join(snapshotPath, "dist/superseded-main.js.map");
  await rename(previousMap, savedMap);
  process.stdout.write(`Previous generated source map moved recoverably to ${savedMap}\n`);
}
await rename(buildPath, join(workspace, "dist/quake3-ts"));
await Bun.write(join(workspace, "dist/build.json"), `${JSON.stringify({ built: new Date().toISOString(), bun: Bun.version, executable: process.execPath,
  snapshotPath, snapshot: snapshot.manifest, binarySha256, sourceMap: { mode: "inline", companions },
  gates: ["typecheck", "policy"] }, null, 2)}\n`);
process.stdout.write(`Built dist/quake3-ts from snapshot ${snapshot.manifest.sha256}; evidence: dist/build.json\n`);
