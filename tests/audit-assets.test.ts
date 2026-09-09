import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VirtualFileSystem } from "../src/assets/vfs.ts";

const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retailAvailable = existsSync(join(retailRoot, "baseq3", "pak0.pk3"))
  && existsSync(join(retailRoot, "missionpack", "pak0.pk3"));
const temporaryDirectories: string[] = [];
const executable = resolve(import.meta.dir, "../tools/audit-assets.ts");

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "quake3-asset-audit-"));
  temporaryDirectories.push(path);
  return path;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

async function run(arguments_: readonly string[]): Promise<{ readonly exitCode: number; readonly stderr: string }> {
  const child = Bun.spawn([process.execPath, executable, ...arguments_], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, stderr };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test.skipIf(!retailAvailable)("CLI audits one installed AAS and RoQ with metadata and provenance", async () => {
  const output = join(temporaryDirectory(), "audit.json");
  const result = await run(["--data", retailRoot, "--product", "missionpack", "--kinds", "aas,roq", "--limit", "1", "--output", output]);
  expect(result).toEqual({ exitCode: 0, stderr: "" });

  const report: unknown = await Bun.file(output).json();
  if (typeof report !== "object" || report === null
    || !("passed" in report) || report.passed !== 2
    || !("failed" in report) || report.failed !== 0
    || !("records" in report) || !isUnknownArray(report.records)) {
    throw new Error("audit report has an invalid summary");
  }
  expect(report.records).toHaveLength(2);
  const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product: "missionpack" });
  for (const record of report.records) {
    if (typeof record !== "object" || record === null
      || !("kind" in record) || (record.kind !== "aas" && record.kind !== "roq")
      || !("sha256" in record) || typeof record.sha256 !== "string"
      || !("path" in record) || typeof record.path !== "string"
      || !("source" in record) || typeof record.source !== "object" || record.source === null
      || !("details" in record) || typeof record.details !== "object" || record.details === null
      || !("kind" in record.details) || record.details.kind !== record.kind) {
      throw new Error("audit record has invalid metadata or provenance");
    }
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    const original = await vfs.read(record.path);
    expect(record.sha256).toBe(new Bun.CryptoHasher("sha256").update(original).digest("hex"));
  }
}, 30_000);

test.skipIf(!retailAvailable)("CLI rejects an unsupported kind", async () => {
  const output = join(temporaryDirectory(), "audit.json");
  const result = await run(["--data", retailRoot, "--kinds", "invalid", "--limit", "1", "--output", output]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Unsupported audit kind invalid");
  expect(existsSync(output)).toBe(false);
}, 30_000);
