import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const utilityPath = resolve(import.meta.dir, "../tools/run-focused-tests.ts");
const temporaryRoot = await mkdtemp(join(tmpdir(), "quake3-focused-test-runner-"));

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runUtility(cwd: string, arguments_: readonly string[]): Promise<RunResult> {
  const child = Bun.spawn([process.execPath, utilityPath, ...arguments_], {
    cwd,
    env: { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function encodeString(value: string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Fixture string could not be encoded");
  return encoded;
}

async function makeCaseDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(temporaryRoot, `${prefix}-`));
}

async function writeMarkerTest(directory: string, filename: string, markerPath: string, name: string): Promise<string> {
  const fixturePath = join(directory, filename);
  const source = [
    'import { test } from "bun:test";',
    `test(${encodeString(name)}, async () => {`,
    `  await Bun.write(${encodeString(markerPath)}, "executed\\n");`,
    "});",
    "",
  ].join("\n");
  await Bun.write(fixturePath, source);
  return fixturePath;
}

async function writeFailingTest(directory: string): Promise<string> {
  const fixturePath = join(directory, "failing.test.ts");
  await Bun.write(fixturePath, [
    'import { test } from "bun:test";',
    'test("failing focused fixture", () => { throw new Error("focused fixture failure"); });',
    "",
  ].join("\n"));
  return fixturePath;
}

test("rejects a missing later file before any earlier test body executes", async () => {
  const directory = await makeCaseDirectory("missing");
  const markerPath = join(directory, "must-not-run.marker");
  await writeMarkerTest(directory, "first.test.ts", markerPath, "must not execute");
  const missingPath = join(directory, "missing.test.ts");

  const result = await runUtility(directory, ["first.test.ts", missingPath]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(missingPath);
  expect(result.stderr).toContain("regular file");
  expect(await Bun.file(markerPath).exists()).toBe(false);
});

test("rejects a directory with a .test.ts suffix", async () => {
  const directory = await makeCaseDirectory("directory");
  const testDirectory = join(directory, "directory.test.ts");
  await mkdir(testDirectory);

  const result = await runUtility(directory, [testDirectory]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(testDirectory);
  expect(result.stderr).toContain("regular file");
});

test("rejects no arguments, non-test files, and option-like inputs", async () => {
  const directory = await makeCaseDirectory("invalid");
  const nonTestPath = join(directory, "not-a-test.ts");
  await Bun.write(nonTestPath, "export const fixtureValue = 1;\n");

  const noArguments = await runUtility(directory, []);
  expect(noArguments.exitCode).not.toBe(0);
  expect(noArguments.stderr).toContain("Usage:");

  const nonTest = await runUtility(directory, [nonTestPath]);
  expect(nonTest.exitCode).not.toBe(0);
  expect(nonTest.stderr).toContain(nonTestPath);
  expect(nonTest.stderr).toContain(".test.ts");

  const option = await runUtility(directory, ["--filter"]);
  expect(option.exitCode).not.toBe(0);
  expect(option.stderr).toContain("--filter");
  expect(option.stderr).toContain("option-like");
});

test("rejects duplicate paths after resolving relative aliases", async () => {
  const directory = await makeCaseDirectory("duplicate");
  const markerPath = join(directory, "must-not-run.marker");
  await writeMarkerTest(directory, "duplicate.test.ts", markerPath, "must not execute");
  const absolutePath = join(directory, "duplicate.test.ts");

  const result = await runUtility(directory, [absolutePath, "./duplicate.test.ts"]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(absolutePath);
  expect(result.stderr).toContain("Duplicate");
  expect(await Bun.file(markerPath).exists()).toBe(false);
});

test("forwards two real passing test files in the provided order", async () => {
  const directory = await makeCaseDirectory("passing");
  const firstMarker = join(directory, "first.marker");
  const secondMarker = join(directory, "second.marker");
  const firstPath = await writeMarkerTest(directory, "first.test.ts", firstMarker, "first focused fixture");
  const secondPath = await writeMarkerTest(directory, "second.test.ts", secondMarker, "second focused fixture");

  const result = await runUtility(directory, ["./first.test.ts", secondPath]);

  expect(result.exitCode).toBe(0);
  expect(await Bun.file(firstMarker).exists()).toBe(true);
  expect(await Bun.file(secondMarker).exists()).toBe(true);
  expect(result.stdout).toContain(`Focused test files (2):\n1. ${firstPath}\n2. ${secondPath}\n`);
});

test("propagates a failing real test status", async () => {
  const directory = await makeCaseDirectory("failing");
  const failingPath = await writeFailingTest(directory);

  const result = await runUtility(directory, [failingPath]);

  expect(result.exitCode).toBe(1);
  expect(`${result.stdout}\n${result.stderr}`).toContain("focused fixture failure");
});
