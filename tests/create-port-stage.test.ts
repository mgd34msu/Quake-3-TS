import { afterAll, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createPortStage } from "../tools/create-port-stage.ts";
import { WorkspaceSnapshot } from "../tools/workspace-snapshot.ts";

const temporary = await mkdtemp(join(tmpdir(), "quake3-create-stage-test-"));
const tool = resolve(import.meta.dir, "../tools/create-port-stage.ts");
afterAll(async () => { await rm(temporary, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(temporary, "case-")), source = join(root, "source 'with spaces"), parent = join(root, "stages 'with spaces");
  await mkdir(source); await mkdir(parent);
  const paths = [".gitignore", "README.md", "NOTICE.md", "LICENSE", "licenses/IJG-README.txt", "licenses/LGPL-2.1.txt",
    "arbitrary-new-root.data", "src/main.ts", "node_modules/dep/index.js"];
  for (const path of paths) await Bun.write(join(source, path), `fixture ${path}\n`);
  return { root, source, parent, paths };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected metadata object");
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const entry: unknown = Reflect.get(value, key);
    result[key] = entry;
  }
  return result;
}

function isUnknownArray(value: unknown): value is readonly unknown[] { return Array.isArray(value); }

test("API metadata records canonical manifest and actual paths without clobbering existing parent files", async () => {
  const f = await fixture();
  await writeFile(join(f.parent, "CAPTURE.json"), "existing parent metadata");
  await mkdir(join(f.parent, "quake3-port-stage-existing"));
  await writeFile(join(f.parent, "quake3-port-stage-existing", "keep"), "existing stage bytes");
  const sourceAlias = join(f.root, "source-alias"), parentAlias = join(f.root, "parent-alias");
  await symlink(f.source, sourceAlias); await symlink(f.parent, parentAlias);
  const initial = await WorkspaceSnapshot.capture(f.source), first = await createPortStage(sourceAlias, parentAlias);
  const second = await createPortStage(f.source, f.parent);
  expect(first.root).not.toBe(second.root); expect(dirname(first.root)).toBe(await realpath(f.parent));
  expect(first.sourceDirectory).toBe(await realpath(f.source));
  expect(dirname(first.baseline)).toBe(first.root); expect(dirname(first.candidate)).toBe(first.root);
  expect(first.metadataPath).toBe(join(first.root, "CAPTURE.json"));
  const raw: unknown = JSON.parse(await readFile(first.metadataPath, "utf8")), metadata = record(raw);
  const fields: readonly (keyof typeof first)[] = ["sourceDirectory", "root", "baseline", "candidate", "manifestSha256", "fileCount", "metadataPath"];
  for (const key of fields) expect(metadata[key]).toBe(first[key]);
  const manifest = record(metadata["manifest"]), files = manifest["files"];
  if (!isUnknownArray(files)) throw new Error("Expected manifest file array");
  expect(files.length).toBe(first.fileCount);
  expect(files.map(file => stringField(record(file), "path"))).toEqual(initial.manifest.files.map(file => file.path));
  expect<unknown>(manifest).toEqual(initial.manifest); expect(first.manifestSha256).toBe(initial.manifest.sha256);
  expect(await readFile(join(f.parent, "CAPTURE.json"), "utf8")).toBe("existing parent metadata");
  expect(await readFile(join(f.parent, "quake3-port-stage-existing", "keep"), "utf8")).toBe("existing stage bytes");
});

test("both materialized copies own source and dependency bytes, modes and relative internal links", async () => {
  const f = await fixture(), dependency = "node_modules/dep/index.js";
  await chmod(join(f.source, dependency), 0o755); await mkdir(join(f.source, "node_modules/.bin"));
  await symlink("../dep/index.js", join(f.source, "node_modules/.bin/tool"));
  const stage = await createPortStage(f.source, f.parent);
  await writeFile(join(f.source, "src/main.ts"), "later source edit");
  await writeFile(join(f.source, dependency), "later dependency edit");
  for (const copy of [stage.baseline, stage.candidate]) {
    expect(await readFile(join(copy, "src/main.ts"), "utf8")).toBe("fixture src/main.ts\n");
    expect(await readFile(join(copy, dependency), "utf8")).toBe(`fixture ${dependency}\n`);
    expect((await stat(join(copy, dependency))).mode & 0o777).toBe(0o755);
    expect(await readlink(join(copy, "node_modules/.bin/tool"))).toBe("../dep/index.js");
    expect(await realpath(join(copy, "node_modules/.bin/tool"))).toBe(join(copy, dependency));
  }
  await writeFile(join(stage.candidate, dependency), "candidate only");
  expect(await readFile(join(stage.baseline, dependency), "utf8")).toBe(`fixture ${dependency}\n`);
  expect(await readFile(join(f.source, dependency), "utf8")).toBe("later dependency edit");
});

test("equal and descendant parents, including symlink aliases, reject before creating a stage", async () => {
  const f = await fixture(), inside = join(f.source, "inside"), alias = join(f.root, "inside-alias");
  await mkdir(inside); await symlink(inside, alias);
  const sourceAlias = join(f.root, "source-alias"); await symlink(f.source, sourceAlias);
  const before = (await readdir(f.source)).sort();
  for (const [source, parent] of [[f.source, f.source], [f.source, inside], [f.source, alias], [sourceAlias, inside]])
    if (source !== undefined && parent !== undefined) await expect(createPortStage(source, parent)).rejects.toThrow("outside the source");
    else throw new Error("Missing path fixture");
  expect((await readdir(f.source)).sort()).toEqual(before); expect(await readdir(inside)).toEqual([]);
  expect(await readdir(f.parent)).toEqual([]);
});

test("existing directory validation rejects missing and non-directory inputs without creating paths", async () => {
  const f = await fixture(), absent = join(f.root, "absent"), file = join(f.root, "file");
  await writeFile(file, "keep");
  await expect(createPortStage(f.source, absent)).rejects.toThrow();
  await expect(createPortStage(absent, f.parent)).rejects.toThrow();
  await expect(createPortStage(f.source, file)).rejects.toThrow("existing directories");
  await expect(createPortStage(file, f.parent)).rejects.toThrow("existing directories");
  expect(await Bun.file(absent).exists()).toBe(false); expect(await readFile(file, "utf8")).toBe("keep");
  expect(await readdir(f.parent)).toEqual([]);
});

test("a lexical source-prefix sibling is a valid outside parent", async () => {
  const f = await fixture(), parent = `${f.source}-sibling`;
  await mkdir(parent);
  const stage = await createPortStage(f.source, parent);
  expect(dirname(stage.root)).toBe(await realpath(parent));
});

test("source drift after the initial capture rejects success and preserves both initial copies", async () => {
  const f = await fixture(), capture = WorkspaceSnapshot.capture;
  let calls = 0;
  const spy = spyOn(WorkspaceSnapshot, "capture").mockImplementation(async directory => {
    const snapshot = await capture(directory);
    if (++calls === 1) await writeFile(join(f.source, "new-during-capture.data"), "real deterministic source drift");
    return snapshot;
  });
  let failure: unknown;
  try { await createPortStage(f.source, f.parent); } catch (error) { failure = error; } finally { spy.mockRestore(); }
  if (!(failure instanceof Error) || !(failure.cause instanceof Error)) throw new Error("Expected preserved stage drift error");
  expect(failure.cause.message).toContain("input drift"); expect(failure.cause.message).toContain(f.source);
  expect(calls).toBe(4);
  const entries = await readdir(f.parent), entry = entries[0];
  if (entry === undefined) throw new Error("Missing preserved stage");
  expect(entries.length).toBe(1); const root = join(f.parent, entry);
  expect(failure.message).toContain(root); expect(await Bun.file(join(root, "CAPTURE.json")).exists()).toBe(false);
  const copies = await readdir(root); expect(copies.length).toBe(2);
  for (const copy of copies) expect(await Bun.file(join(root, copy, "new-during-capture.data")).exists()).toBe(false);
  expect(await readFile(join(f.source, "new-during-capture.data"), "utf8")).toBe("real deterministic source drift");
});

test("baseline or candidate tampering during materialization is detected using the real filesystem", async () => {
  for (const changedCopy of [1, 2]) {
    const f = await fixture(), materialize = WorkspaceSnapshot.prototype.materialize;
    let calls = 0;
    const spy = spyOn(WorkspaceSnapshot.prototype, "materialize").mockImplementation(async function (this: WorkspaceSnapshot, parent, prefix) {
      const copy = await materialize.call(this, parent, prefix);
      if (++calls === changedCopy) await writeFile(join(copy, "README.md"), "actual copy drift");
      return copy;
    });
    let failure: unknown;
    try { await createPortStage(f.source, f.parent); } catch (error) { failure = error; } finally { spy.mockRestore(); }
    if (!(failure instanceof Error) || !(failure.cause instanceof Error)) throw new Error("Expected copy drift failure");
    expect(failure.cause.message).toContain("input drift"); expect(calls).toBe(2);
    expect(await readFile(join(f.source, "README.md"), "utf8")).toBe("fixture README.md\n");
    const entries = await readdir(f.parent); expect(entries.length).toBe(1);
  }
});

test("metadata creation never overwrites a file introduced at the fresh stage path", async () => {
  const f = await fixture(), materialize = WorkspaceSnapshot.prototype.materialize;
  let metadataPath = "";
  const spy = spyOn(WorkspaceSnapshot.prototype, "materialize").mockImplementation(async function (this: WorkspaceSnapshot, parent, prefix) {
    const copy = await materialize.call(this, parent, prefix);
    if (metadataPath === "") { metadataPath = join(parent, "CAPTURE.json"); await writeFile(metadataPath, "existing metadata bytes"); }
    return copy;
  });
  let failure: unknown;
  try { await createPortStage(f.source, f.parent); } catch (error) { failure = error; } finally { spy.mockRestore(); }
  if (!(failure instanceof Error)) throw new Error("Expected exclusive metadata write failure");
  expect(failure.message).toContain(dirname(metadataPath));
  expect(await readFile(metadataPath, "utf8")).toBe("existing metadata bytes");
});

test("post-creation failures retain their exact cause and report the preserved stage", async () => {
  for (const cause of [new Error("capture failed"), null, undefined]) {
    const f = await fixture();
    const spy = spyOn(WorkspaceSnapshot, "capture").mockImplementation(async () => { throw cause; });
    let failure: unknown;
    try { await createPortStage(f.source, f.parent); } catch (error) { failure = error; } finally { spy.mockRestore(); }
    if (!(failure instanceof Error)) throw new Error("Expected stage failure");
    expect(failure.cause).toBe(cause);
    const entries = await readdir(f.parent), entry = entries[0];
    if (entry === undefined) throw new Error("Missing preserved failure directory");
    expect(entries.length).toBe(1); expect(failure.message).toContain(join(f.parent, entry));
    expect(await readdir(join(f.parent, entry))).toEqual([]);
  }
});

test("failure after a real materialization preserves the acquired copy and original source", async () => {
  const f = await fixture(), materialize = WorkspaceSnapshot.prototype.materialize, cause = new Error("after actual materialization");
  let acquired = "";
  const spy = spyOn(WorkspaceSnapshot.prototype, "materialize").mockImplementation(async function (this: WorkspaceSnapshot, parent, prefix) {
    acquired = await materialize.call(this, parent, prefix);
    throw cause;
  });
  let failure: unknown;
  try { await createPortStage(f.source, f.parent); } catch (error) { failure = error; } finally { spy.mockRestore(); }
  if (!(failure instanceof Error)) throw new Error("Expected materialization failure");
  expect(failure.cause).toBe(cause); expect(failure.message).toContain(dirname(acquired));
  expect(await readFile(join(acquired, "README.md"), "utf8")).toBe("fixture README.md\n");
  expect(await readFile(join(f.source, "README.md"), "utf8")).toBe("fixture README.md\n");
  expect(await readdir(dirname(acquired))).toEqual([acquired.slice(dirname(acquired).length + 1)]);
  expect(await Bun.file(join(dirname(acquired), "CAPTURE.json")).exists()).toBe(false);
});

test("CLI uses the default temp directory and reports invalid inputs without success JSON", async () => {
  const f = await fixture(), success = await cli(f.source, [], { TMPDIR: f.parent });
  expect(success.code).toBe(0); expect(success.stderr).toBe("");
  const value: unknown = JSON.parse(success.stdout), result = record(value);
  expect(dirname(stringField(result, "root"))).toBe(await realpath(f.parent));
  const before = (await readdir(f.parent)).sort();
  for (const arguments_ of [[f.parent, "extra"], [join(f.root, "missing")], [f.source]]) {
    const failure = await cli(f.source, arguments_);
    expect(failure.code).not.toBe(0); expect(failure.stdout).toBe(""); expect(failure.stderr.length).toBeGreaterThan(0);
  }
  expect((await readdir(f.parent)).sort()).toEqual(before);
});

test("CLI preserves and names a stage when canonical capture rejects a source symlink", async () => {
  const f = await fixture(); await symlink("README.md", join(f.source, "source-link"));
  const failure = await cli(f.source, [f.parent]);
  expect(failure.code).not.toBe(0); expect(failure.stdout).toBe(""); expect(failure.stderr).toContain("symlink");
  const entries = await readdir(f.parent), entry = entries[0];
  if (entry === undefined) throw new Error("Missing CLI failure stage");
  expect(entries.length).toBe(1); expect(failure.stderr).toContain(join(f.parent, entry));
  expect(await readlink(join(f.source, "source-link"))).toBe("README.md");
});
function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`Expected metadata string ${key}`);
  return field;
}
async function cli(source: string, arguments_: readonly string[], environment: Readonly<Record<string, string>> = {}) {
  const child = Bun.spawn([process.execPath, tool, ...arguments_], {
    cwd: source, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test("CLI includes canonical root metadata and arbitrary new root files in both private copies", async () => {
  const f = await fixture(), initial = await WorkspaceSnapshot.capture(f.source);
  const result = await cli(f.source, [f.parent]);
  expect(result.code).toBe(0); expect(result.stderr).toBe("");
  const decoded: unknown = JSON.parse(result.stdout), output = record(decoded);
  const baseline = stringField(output, "baseline"), candidate = stringField(output, "candidate");
  expect(output["manifestSha256"]).toBe(initial.manifest.sha256); expect(output["fileCount"]).toBe(f.paths.length);
  expect(baseline).not.toBe(candidate);
  for (const copy of [baseline, candidate]) {
    expect((await WorkspaceSnapshot.capture(copy)).manifest).toEqual(initial.manifest);
    for (const path of f.paths) expect(await readFile(join(copy, path), "utf8")).toBe(`fixture ${path}\n`);
  }
  expect((await WorkspaceSnapshot.capture(f.source)).manifest).toEqual(initial.manifest);
});
