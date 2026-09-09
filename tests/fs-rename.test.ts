import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import type { Product } from "../src/shared/definitions.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

async function fixture(product: Product = "baseq3", printEffect: (text: string) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "quake3-fs-rename-"));
  cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, "baseq3"));
  writeFileSync(join(root, "baseq3", "default.cfg"), "set fixture 1\n");
  if (product !== "baseq3") mkdirSync(join(root, product));
  const prints: string[] = [], cvars = new CvarRegistry(), sound = new SoundOutput();
  const files = new CommonFileState({ homePath: root, dataPath: root, cdPath: null, product },
    text => { prints.push(text); printEffect(text); }, sound, cvars);
  cleanup.push(() => { try { files.close(); } finally { sound.close(); } });
  await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
  prints.length = 0;
  return { root, files, prints, cvars };
}

for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  test(`FS_Rename replaces a home game file and uses live fs_debug (${product})`, async () => {
    const { root, files, prints, cvars } = await fixture(product);
    const source = join(root, product, "old.cfg"), destination = join(root, product, "new.cfg");
    writeFileSync(source, "new contents"); writeFileSync(destination, "obsolete contents");
    cvars.set("fs_debug", "1", true);
    files.server.renameGame("old.cfg", "new.cfg");
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(destination, "utf8")).toBe("new contents");
    expect(prints).toEqual([`FS_Rename: ${source} --> ${destination}\n`]);
  });
}

test("FS_SV_Rename replaces while download renameNoReplace preserves a conflict", async () => {
  const { root, files, prints, cvars } = await fixture();
  const source = join(root, "download.tmp"), destination = join(root, "download.pk3");
  writeFileSync(source, "new"); writeFileSync(destination, "old");
  expect(() => files.server.renameNoReplace("download.tmp", "download.pk3")).toThrow();
  expect(readFileSync(source, "utf8")).toBe("new");
  expect(readFileSync(destination, "utf8")).toBe("old");
  cvars.set("fs_debug", "1", true);
  files.server.rename("download.tmp", "download.pk3");
  expect(existsSync(source)).toBe(false);
  expect(readFileSync(destination, "utf8")).toBe("new");
  expect(prints).toEqual([`FS_SV_Rename: ${source} --> ${destination}\n`]);
});

test("missing destination parents take the copy fallback and then remove the source", async () => {
  const { root, files, prints } = await fixture();
  writeFileSync(join(root, "old.cfg"), "fallback data");
  files.server.rename("old.cfg", "nested/more/new.cfg");
  expect(existsSync(join(root, "old.cfg"))).toBe(false);
  expect(readFileSync(join(root, "nested/more/new.cfg"), "utf8")).toBe("fallback data");
  expect(prints).toEqual([`copy ${root}/old.cfg to ${root}/nested/more/new.cfg\n`]);
});

test("source removes a private fixture after a nonfatal copy destination failure", async () => {
  const { root, files, prints } = await fixture();
  writeFileSync(join(root, "old.cfg"), "disposable failure-path fixture");
  mkdirSync(join(root, "directory"));
  files.server.rename("old.cfg", "directory");
  expect(existsSync(join(root, "old.cfg"))).toBe(false);
  expect(existsSync(join(root, "directory"))).toBe(true);
  expect(prints).toEqual([`copy ${root}/old.cfg to ${root}/directory\n`]);
});

test("journal fallback is skipped but its private source name is still removed", async () => {
  const { root, files, prints } = await fixture();
  writeFileSync(join(root, "journal.dat"), "disposable journal fixture");
  files.server.rename("journal.dat", "missing/journal.dat");
  expect(existsSync(join(root, "journal.dat"))).toBe(false);
  expect(existsSync(join(root, "missing"))).toBe(false);
  expect(prints).toEqual([`copy ${root}/journal.dat to ${root}/missing/journal.dat\n`, "Ignoring journal files\n"]);
});

test("ordinary rename rejects a symlink destination without removing either private file", async () => {
  const { root, files } = await fixture();
  writeFileSync(join(root, "old.cfg"), "new"); writeFileSync(join(root, "target.cfg"), "old");
  symlinkSync(join(root, "target.cfg"), join(root, "alias.cfg"));
  expect(() => files.server.rename("old.cfg", "alias.cfg")).toThrow("symbolic link");
  expect(readFileSync(join(root, "old.cfg"), "utf8")).toBe("new");
  expect(readFileSync(join(root, "target.cfg"), "utf8")).toBe("old");
});

test("a missing source follows the silent failed-copy path", async () => {
  const { root, files, prints } = await fixture();
  files.server.rename("missing.cfg", "new.cfg");
  expect(existsSync(join(root, "new.cfg"))).toBe(false);
  expect(prints).toEqual([`copy ${root}/missing.cfg to ${root}/new.cfg\n`]);
});

test("rename retains the source-built paths when its diagnostic changes fs_homepath", async () => {
  let change: (() => void) | null = null;
  const { root, files, cvars } = await fixture("baseq3", text => {
    if (text.startsWith("FS_SV_Rename:")) change?.();
  });
  const other = join(root, "other"); mkdirSync(other);
  writeFileSync(join(root, "old.cfg"), "original root");
  writeFileSync(join(other, "old.cfg"), "changed root");
  change = () => { cvars.set("fs_homepath", other, true); };
  cvars.set("fs_debug", "1", true);
  files.server.rename("old.cfg", "new.cfg");
  expect(readFileSync(join(root, "new.cfg"), "utf8")).toBe("original root");
  expect(readFileSync(join(other, "old.cfg"), "utf8")).toBe("changed root");
  expect(existsSync(join(other, "new.cfg"))).toBe(false);
});
