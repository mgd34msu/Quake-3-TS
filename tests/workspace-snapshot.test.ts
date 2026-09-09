import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceSnapshot } from "../tools/workspace-snapshot.ts";

const temporary = await mkdtemp(join(tmpdir(), "quake3-snapshot-test-"));
afterAll(async () => { await rm(temporary, { recursive: true, force: true }); });

test("captured bytes stay owned across live edits, including edit-and-restore", async () => {
  const root = join(temporary, "owned");
  await Bun.write(join(root, "src/main.ts"), "export const version = 1;\n");
  const before = await WorkspaceSnapshot.capture(root);
  await Bun.write(join(root, "src/main.ts"), "export const version = 2;\n");
  expect((await WorkspaceSnapshot.capture(root)).manifest.sha256).not.toBe(before.manifest.sha256);
  const copy = await before.materialize(join(temporary, "copies"), "test-");
  expect(await Bun.file(join(copy, "src/main.ts")).text()).toBe("export const version = 1;\n");
  expect((await WorkspaceSnapshot.capture(copy)).manifest).toEqual(before.manifest);
  await Bun.write(join(root, "src/main.ts"), "export const version = 1;\n");
  expect((await WorkspaceSnapshot.capture(root)).manifest).toEqual(before.manifest);
  await Bun.write(join(copy, "src/main.ts"), "export const version = 3;\n");
  expect((await WorkspaceSnapshot.capture(copy)).manifest.sha256).not.toBe(before.manifest.sha256);
  expect(await Bun.file(join(root, "src/main.ts")).text()).toBe("export const version = 1;\n");
});

test("only root outputs and supplied archives are excluded; nested policy inputs remain", async () => {
  const root = join(temporary, "exclusions");
  for (const path of ["dist/result", ".artifacts/old/check.json", ".git/config", "source.zip", "pak.pk3", "source.bundle", "check.log", "src/dist/native.c", "src/hidden.zip", "tools/check.ts", "node_modules/dep/index.js"]) {
    await Bun.write(join(root, path), path);
  }
  const snapshot = await WorkspaceSnapshot.capture(root);
  expect(snapshot.manifest.files.map(file => file.path)).toEqual(["node_modules/dep/index.js", "src/dist/native.c", "src/hidden.zip", "tools/check.ts"]);
  await Bun.write(join(root, "node_modules/dep/index.js"), "changed dependency");
  expect((await WorkspaceSnapshot.capture(root)).manifest.sha256).not.toBe(snapshot.manifest.sha256);
});

test("dependency links remain internal and executable file modes are preserved", async () => {
  const root = join(temporary, "dependencies");
  await Bun.write(join(root, "node_modules/dep/bin/tool"), "tool bytes");
  await chmod(join(root, "node_modules/dep/bin/tool"), 0o755);
  await mkdir(join(root, "node_modules/.bin"));
  await symlink("../dep/bin/tool", join(root, "node_modules/.bin/tool"));
  const snapshot = await WorkspaceSnapshot.capture(root);
  const copy = await snapshot.materialize(join(temporary, "copies"), "test-");
  expect(await readlink(join(copy, "node_modules/.bin/tool"))).toBe("../dep/bin/tool");
  expect((await WorkspaceSnapshot.capture(copy)).manifest).toEqual(snapshot.manifest);
  await chmod(join(root, "node_modules/dep/bin/tool"), 0o644);
  expect((await WorkspaceSnapshot.capture(root)).manifest.sha256).not.toBe(snapshot.manifest.sha256);
});

test("source links and external dependency links cannot keep checks attached to live files", async () => {
  const source = join(temporary, "source-link");
  await Bun.write(join(source, "original.ts"), "export const value = 1;");
  await symlink("original.ts", join(source, "alias.ts"));
  await expect(WorkspaceSnapshot.capture(source)).rejects.toThrow("symlink");
  const dependency = join(temporary, "external-link");
  await mkdir(join(dependency, "node_modules"), { recursive: true });
  await symlink("../../source-link", join(dependency, "node_modules/external"));
  await expect(WorkspaceSnapshot.capture(dependency)).rejects.toThrow("symlink");
});

test("credential filenames are rejected before their contents or link targets are read", async () => {
  const names = ["q3key", "quake3cdkey.md", "nested/Q3KEY.backup", "nested/Quake3CdKey.MD"];
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    if (name === undefined) throw new Error("Missing credential filename fixture");
    const root = join(temporary, `credential-${index}`), path = join(root, name);
    await Bun.write(path, "synthetic credential-boundary fixture; not a key");
    await chmod(path, 0);
    try {
      await expect(WorkspaceSnapshot.capture(root)).rejects.toThrow("credential filename");
    } finally { await chmod(path, 0o600); }
  }
  const linkRoot = join(temporary, "credential-link");
  await mkdir(linkRoot);
  await symlink("unavailable-target", join(linkRoot, "q3key"));
  await expect(WorkspaceSnapshot.capture(linkRoot)).rejects.toThrow("credential filename");
});
