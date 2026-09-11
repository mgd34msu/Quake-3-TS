import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLooseNames, VirtualFileSystem } from "../src/assets/vfs.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "quake3-portable-listing-"));
  roots.push(root);
  return root;
}

test("trusted ancestor aliases permit listings while descendant links stay excluded", async () => {
  const root = await fixture();
  const actual = join(root, "actual");
  const alias = join(root, "alias");
  const outside = join(root, "outside");
  await mkdir(join(actual, "home", "baseq3", "scripts", "child"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(actual, "home", "baseq3", "scripts", "inside.cfg"), "inside");
  await writeFile(join(actual, "home", "baseq3", "scripts", "child", "nested.cfg"), "nested");
  await writeFile(join(outside, "escaped.cfg"), "outside");
  await symlink(actual, alias, "junction");
  const home = join(alias, "home");
  const game = join(home, "baseq3");
  await symlink(outside, join(game, "scripts", "escape"), "junction");
  await symlink(outside, join(root, "linked-root"), "junction");
  expect(listLooseNames(game, "scripts", ".cfg")).toEqual(["inside.cfg"]);
  expect(listLooseNames(game, "scripts", "/")).toEqual(["child"]);
  expect(listLooseNames(game, "scripts/escape", ".cfg")).toEqual([]);
  expect(listLooseNames(join(root, "linked-root"), "", ".cfg")).toEqual([]);
  using vfs = await VirtualFileSystem.openInspection({ dataPath: home, homePath: home, cdPath: null, product: "baseq3" });
  expect(vfs.listFilteredFiles("scripts", "", "*.cfg").slice().sort()).toEqual(["/inside.cfg", "child/nested.cfg"]);
  expect(new TextDecoder().decode(vfs.readSync("scripts/inside.cfg"))).toBe("inside");
});

test("native host roots preserve source filename bytes in listings and reads", async () => {
  const root = join(await fixture(), "hôte-\u0100");
  const game = join(root, "baseq3");
  await mkdir(game, { recursive: true });
  const names = ["\xe9.cfg", "\xc3\xa9.cfg"];
  for (const name of names) {
    const path = Buffer.concat([Buffer.from(`${game}/`), Buffer.from(name, process.platform === "win32" ? "utf8" : "latin1")]);
    await writeFile(path, name);
  }
  expect(listLooseNames(game, "", ".cfg").slice().sort()).toEqual(names.slice().sort());
  using vfs = await VirtualFileSystem.openInspection({ dataPath: root, homePath: root, cdPath: null, product: "baseq3" });
  for (const name of names) expect(new TextDecoder().decode(vfs.readSync(name))).toBe(name);
  expect(vfs.listFilteredFiles("", "", "*.cfg").slice().sort()).toEqual(names.map(name => `/${name}`).sort());
});

test.skipIf(process.platform !== "win32")("Windows listings omit names outside the source byte domain", async () => {
  const root = await fixture();
  const game = join(root, "baseq3");
  await mkdir(game);
  await writeFile(join(game, "allowed.cfg"), "source name");
  await writeFile(join(game, "\u0100.cfg"), "unrepresentable name");
  expect(listLooseNames(game, "", ".cfg")).toEqual(["allowed.cfg"]);
  using vfs = await VirtualFileSystem.openInspection({ dataPath: root, homePath: root, cdPath: null, product: "baseq3" });
  expect(vfs.list()).toEqual(["allowed.cfg"]);
  expect(vfs.listFilteredFiles("", "", "*.cfg")).toEqual(["/allowed.cfg"]);
});
