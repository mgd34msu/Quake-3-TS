import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporary = await mkdtemp(join(tmpdir(), "quake3-build-test-"));
const buildTool = resolve(import.meta.dir, "../tools/build.ts");
afterAll(async () => { await rm(temporary, { recursive: true, force: true }); });

function unknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

async function runBuild(root: string, environment: Readonly<Record<string, string>> = {}): Promise<{ readonly code: number; readonly output: string }> {
  const child = Bun.spawn([process.execPath, buildTool], { cwd: root, env: { ...process.env, ...environment }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: stdout + stderr };
}

test("compiled workers and inline maps work away from sources; failed or stale-input builds preserve the previous executable", async () => {
  const root = join(temporary, "project");
  await Bun.write(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { typecheck: "bun gate.ts", policy: "bun gate.ts" } }));
  await Bun.write(join(root, "gate.ts"), [
    "if (process.env['BUILD_FIXTURE_FAIL'] === '1') process.exit(17);",
    "const liveTarget = process.env['BUILD_FIXTURE_MUTATE'];",
    "if (liveTarget !== undefined) await Bun.write(liveTarget, 'export const changed = true;\\n');",
  ].join("\n"));
  await Bun.write(join(root, "src/main.ts"), [
    "function fail(): never {",
    "  throw new Error('compiled-map-fixture');",
    "}",
    "import { startWorker } from './render/cpu/triangle-execution.ts';",
    "const worker = startWorker();",
    "try {",
    "  await new Promise<void>((resolve, reject) => {",
    "    const timeout = setTimeout(() => reject(new Error('worker fixture timed out')), 5000);",
    "    worker.onmessage = (event: MessageEvent<unknown>) => {",
    "      clearTimeout(timeout);",
    "      if (event.data !== 42) reject(new Error('worker fixture returned unexpected value'));",
    "      else resolve();",
    "    };",
    "    worker.onerror = (event: ErrorEvent) => { clearTimeout(timeout); reject(new Error(event.message)); };",
    "  });",
    "} finally { worker.terminate(); }",
    "fail();",
    "",
  ].join("\n"));
  await Bun.write(join(root, "src/render/cpu/triangle-execution.ts"),
    "export function startWorker(): Worker { return new Worker(new URL('./triangle-worker.ts', import.meta.url), { ref: true }); }\n");
  await Bun.write(join(root, "src/render/cpu/triangle-worker.ts"), "postMessage(42);\n");
  await Bun.write(join(root, "dist/main.js.map"), "prior generated source map");
  const built = await runBuild(root);
  expect(built.code).toBe(0);
  const executable = join(root, "dist/quake3-ts");
  const originalHash = Bun.CryptoHasher.hash("sha256", await Bun.file(executable).bytes(), "hex");
  const metadata: unknown = await Bun.file(join(root, "dist/build.json")).json();
  if (metadata === null || typeof metadata !== "object" || !("binarySha256" in metadata)
    || !("sourceMap" in metadata) || !("snapshotPath" in metadata) || typeof metadata.snapshotPath !== "string") throw new Error("Missing build evidence");
  expect(metadata.binarySha256).toBe(originalHash);
  const sourceMap = metadata.sourceMap;
  if (sourceMap === null || typeof sourceMap !== "object" || !("mode" in sourceMap)
    || !("companions" in sourceMap)) throw new Error("Missing source-map evidence");
  const companionValues: unknown = sourceMap.companions;
  if (!unknownArray(companionValues)) throw new Error("Missing source-map companions");
  expect(sourceMap.mode).toBe("inline");
  expect(await Bun.file(join(root, "dist/main.js.map")).exists()).toBe(false);
  expect(await Bun.file(join(metadata.snapshotPath, "dist/superseded-main.js.map")).text()).toBe("prior generated source map");
  const archivedPaths: string[] = [];
  for (const companion of companionValues) {
    if (companion === null || typeof companion !== "object"
      || !("archivedCompanion" in companion) || typeof companion.archivedCompanion !== "string"
      || !("sha256" in companion) || typeof companion.sha256 !== "string") throw new Error("Missing archived source-map evidence");
    archivedPaths.push(companion.archivedCompanion);
    expect(Bun.CryptoHasher.hash("sha256", await Bun.file(companion.archivedCompanion).bytes(), "hex")).toBe(companion.sha256);
  }
  expect(archivedPaths.sort()).toEqual([
    join(metadata.snapshotPath, ".artifacts/build-main.ts.map"),
    join(metadata.snapshotPath, ".artifacts/build-triangle-worker.ts.map"),
  ]);
  for (const mapName of ["main.ts.map", "triangle-worker.ts.map"]) {
    expect(await Bun.file(join(metadata.snapshotPath, "dist", mapName)).exists()).toBe(false);
    expect(await Bun.file(join(root, "dist", mapName)).exists()).toBe(false);
  }
  const process_ = Bun.spawn([executable], { cwd: temporary, stdout: "pipe", stderr: "pipe" });
  const [code, output] = await Promise.all([process_.exited, new Response(process_.stderr).text()]);
  expect(code).toBe(1);
  expect(output).toContain("compiled-map-fixture");
  expect(output).toContain("src/main.ts:2:9");

  const failed = await runBuild(root, { BUILD_FIXTURE_FAIL: "1" });
  expect(failed.code).not.toBe(0);
  expect(Bun.CryptoHasher.hash("sha256", await Bun.file(executable).bytes(), "hex")).toBe(originalHash);
  const changed = await runBuild(root, { BUILD_FIXTURE_MUTATE: join(root, "src/main.ts") });
  expect(changed.code).not.toBe(0);
  expect(changed.output).toContain("Existing dist/quake3-ts was not replaced");
  expect(Bun.CryptoHasher.hash("sha256", await Bun.file(executable).bytes(), "hex")).toBe(originalHash);
  expect(await Bun.file(join(root, "src/main.ts")).text()).toBe("export const changed = true;\n");
}, 30_000);
