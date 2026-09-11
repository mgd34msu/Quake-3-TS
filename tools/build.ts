import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceSnapshot } from "./workspace-snapshot.ts";
import { NETWORK_DEFAULTS, parseNetworkDefaults } from "../src/core/network-defaults.ts";
import { networkDefaultsPlugin } from "./network-build-defaults.ts";
import type { NetworkDefaults } from "../src/core/network-defaults.ts";

export function buildNetworkDefaults(args: readonly string[]): NetworkDefaults {
  let masterServer = NETWORK_DEFAULTS.masterServer;
  let authorizeServer = NETWORK_DEFAULTS.authorizeServer;
  let authorizePort = String(NETWORK_DEFAULTS.authorizePort);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag !== "--master-server" && flag !== "--auth-server" && flag !== "--auth-port") {
      throw new Error(`Unknown build option: ${flag}`);
    }
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--master-server") masterServer = value;
    else if (flag === "--auth-server") authorizeServer = value;
    else authorizePort = value;
  }
  return parseNetworkDefaults({ masterServer, authorizeServer, authorizePort });
}

export async function checkedBuildSnapshot(workspace: string): Promise<{ snapshot: WorkspaceSnapshot; snapshotPath: string }> {
  const snapshot = await WorkspaceSnapshot.capture(workspace);
  const snapshotPath = await snapshot.materialize(join(workspace, ".artifacts/snapshots"), "build-");
  const check = Bun.spawn([process.execPath, "run", "typecheck"], { cwd: snapshotPath, stdout: "inherit", stderr: "inherit" });
  if (await check.exited !== 0) throw new Error("Build snapshot typecheck failed");
  const policy = Bun.spawn([process.execPath, "run", "policy"], { cwd: snapshotPath, stdout: "inherit", stderr: "inherit" });
  if (await policy.exited !== 0) throw new Error("Build snapshot policy failed");
  return { snapshot, snapshotPath };
}

export async function compileSnapshot(snapshotPath: string, networkDefaults: NetworkDefaults,
  compile: Bun.CompileBuildOptions, sourcemap: "inline" | "none"): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(snapshotPath, "src/main.ts"), join(snapshotPath, "src/render/cpu/triangle-worker.ts"),
      join(snapshotPath, "src/render/threaded-backend-worker.ts")],
    target: "bun",
    plugins: [networkDefaultsPlugin(snapshotPath, networkDefaults)],
    naming: { entry: "[name].ts" },
    compile,
    sourcemap,
  });
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${log}\n`);
    throw new Error(`Compilation failed: ${compile.outfile}`);
  }
}

export async function assertBuildInputs(workspace: string, snapshotPath: string, snapshot: WorkspaceSnapshot): Promise<void> {
  if ((await WorkspaceSnapshot.capture(snapshotPath)).manifest.sha256 !== snapshot.manifest.sha256
    || (await WorkspaceSnapshot.capture(workspace)).manifest.sha256 !== snapshot.manifest.sha256) {
    throw new Error(`Build inputs changed. Published artifacts were not replaced; candidate remains at ${snapshotPath}`);
  }
}

async function buildHost(): Promise<void> {
  const networkDefaults = buildNetworkDefaults(process.argv.slice(2));
  const workspace = process.cwd();
  const { snapshot, snapshotPath } = await checkedBuildSnapshot(workspace);
  const executableName = process.platform === "win32" ? "quake3-ts.exe" : "quake3-ts";
  const buildPath = join(snapshotPath, "dist", executableName);
  await mkdir(join(snapshotPath, "dist"), { recursive: true });
  await compileSnapshot(snapshotPath, networkDefaults, { outfile: buildPath }, "inline");
  await assertBuildInputs(workspace, snapshotPath, snapshot);
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
  await rename(buildPath, join(workspace, "dist", executableName));
  await Bun.write(join(workspace, "dist/build.json"), `${JSON.stringify({ built: new Date().toISOString(), bun: Bun.version, executable: process.execPath,
    snapshotPath, snapshot: snapshot.manifest, binarySha256, networkDefaults, sourceMap: { mode: "inline", companions },
    gates: ["typecheck", "policy"] }, null, 2)}\n`);
  process.stdout.write(`Built dist/${executableName} from snapshot ${snapshot.manifest.sha256}; evidence: dist/build.json\n`);
}

if (import.meta.main) await buildHost();
