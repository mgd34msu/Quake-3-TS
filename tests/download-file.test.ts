import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { closeSync, readFileSync } from "node:fs";
import { appendFile, mkdtemp, mkdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDownloadDescriptor, ServerDownloadError, ServerDownloadFile } from "../src/assets/download-file.ts";
import { SourceFileHandles } from "../src/assets/file-handles.ts";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";

const temporaryDirectories: string[] = [];
const fileOwners: CommonFileState[] = [];

async function downloadFiles(roots: readonly [string, ...string[]]) {
  const files = new CommonFileState({ homePath: roots[0], dataPath: roots[1] ?? roots[0], cdPath: roots[2] ?? null, product: "baseq3" },
    () => undefined, new SoundOutput(), new CvarRegistry());
  fileOwners.push(files);
  await files.initialize({ checksumFeed: 0, random: () => 0 }, () => undefined);
  return files.server;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "quake3-download-file-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const files of fileOwners.splice(0)) files.close();
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function downloadError(action: () => unknown): ServerDownloadError {
  try {
    action();
  } catch (error) {
    if (error instanceof ServerDownloadError) return error;
    throw error;
  }
  throw new Error("Expected ServerDownloadError");
}

describe("server raw download files", () => {
  test("keeps source filename bytes distinct under a Unicode host root", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "hôte-é");
    await mkdir(join(root, "baseq3"), { recursive: true });
    const files = await downloadFiles([root]);
    const prefix = Buffer.from(`${root}/baseq3/`);
    await writeFile(Buffer.concat([prefix, Buffer.from([0xe9]), Buffer.from(".cfg")]), "raw byte");
    await writeFile(Buffer.concat([prefix, Buffer.from([0xc3, 0xa9]), Buffer.from(".cfg")]), "UTF-8 bytes");

    for (const { name, expected } of [
      { name: "baseq3\\\u00e9.cfg", expected: "raw byte" },
      { name: "baseq3/\u00c3\u00a9.cfg", expected: "UTF-8 bytes" },
    ]) {
      const file = files.openDownload(name);
      if (file === null) throw new Error("Expected byte filename fixture");
      const bytes = new Uint8Array(file.size);
      expect(file.read(bytes)).toBe(bytes.length);
      expect(text(bytes)).toBe(expected);
      file.close();
    }
    expect(downloadError(() => files.openDownload("\u0100.cfg")).kind).toBe("path");
  });

  test("acquires source-byte files through a Unicode configured root symlink", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "目录");
    const rootLink = join(parent, "répertoire");
    await mkdir(root);
    await symlink(root, rootLink);
    await writeFile(Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xe9]), Buffer.from(".cfg")]), "raw byte");
    const opened = openDownloadDescriptor(rootLink, "\u00e9.cfg");
    if (opened === undefined) throw new Error("Expected Unicode host root fixture");
    try {
      expect(opened.root).toEqual(Buffer.from(root));
      expect(readFileSync(opened.descriptor, "utf8")).toBe("raw byte");
    } finally { closeSync(opened.descriptor); }
  });

  test("resolves contained raw-byte symlinks and rejects outside targets", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const files = await downloadFiles([root]);
    const rawName = Buffer.from([0xe9, 0x2e, 0x63, 0x66, 0x67]);
    const contained = Buffer.concat([Buffer.from(`${root}/`), rawName]);
    const escaped = Buffer.concat([Buffer.from(`${outside}/`), rawName]);
    await writeFile(contained, "contained");
    await writeFile(escaped, "outside");
    await symlink(contained, join(root, "inside.cfg"));
    await symlink(escaped, join(root, "outside.cfg"));
    const file = files.openDownload("inside.cfg");
    if (file === null) throw new Error("Expected contained raw-byte symlink");
    const bytes = new Uint8Array(file.size);
    expect(file.read(bytes)).toBe(9);
    expect(text(bytes)).toBe("contained");
    file.close();
    expect(downloadError(() => files.openDownload("outside.cfg")).kind).toBe("path");
  });

  test("revalidates raw-byte descriptors after their inode moves outside the root", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const files = await downloadFiles([root]);
    const rawName = Buffer.from([0xe9, 0x2e, 0x63, 0x66, 0x67]);
    const original = Buffer.concat([Buffer.from(`${root}/`), rawName]);
    await writeFile(original, "raw byte");
    await writeFile(join(root, "\u00e9.cfg"), "UTF-8 alias");
    const file = files.openDownload("\u00e9.cfg");
    if (file === null) throw new Error("Expected moved raw-byte fixture");
    await rename(original, Buffer.concat([Buffer.from(`${outside}/`), rawName]));
    expect(downloadError(() => file.read(new Uint8Array(1))).kind).toBe("path");
    expect(() => file.read(new Uint8Array(1))).toThrow("closed");
  });

  test("retains canonical raw-byte roots through configured symlinks and borrowed downloads", async () => {
    const parent = await temporaryDirectory();
    const rawRoot = Buffer.concat([Buffer.from(`${parent}/`), Buffer.from([0xe9])]);
    await mkdir(rawRoot);
    await writeFile(Buffer.concat([rawRoot, Buffer.from("/file.cfg")]), "raw root");
    const rootLink = join(parent, "root-link");
    await symlink(rawRoot, rootLink);
    const opened = openDownloadDescriptor(rootLink, "file.cfg");
    if (opened === undefined) throw new Error("Expected raw canonical root fixture");
    expect(opened.root).toEqual(rawRoot);
    const handles = new SourceFileHandles(), handle = handles.selectFree();
    handles.assignServerRead(handle, opened.descriptor, opened.root);
    try {
      opened.root.fill(0);
      const borrowed = handles.borrowLooseRead(handle);
      expect(borrowed.root).toEqual(rawRoot);
      const file = new ServerDownloadFile(borrowed, 8, "file.cfg");
      borrowed.root.fill(0);
      expect(handles.borrowLooseRead(handle).root).toEqual(rawRoot);
      const bytes = new Uint8Array(8);
      expect(file.read(bytes)).toBe(8);
      expect(text(bytes)).toBe("raw root");
      await rename(Buffer.concat([rawRoot, Buffer.from("/file.cfg")]), join(parent, "moved.cfg"));
      expect(downloadError(() => file.read(new Uint8Array(1))).kind).toBe("path");
      expect(() => file.read(new Uint8Array(1))).toThrow("closed");
    } finally { handles.close(); }
  });

  test("raw canonical roots reject sibling-prefix and outside symlink targets", async () => {
    const parent = await temporaryDirectory();
    const rawRoot = Buffer.concat([Buffer.from(`${parent}/`), Buffer.from([0xe9])]);
    const sibling = Buffer.concat([rawRoot, Buffer.from("-outside")]);
    await mkdir(rawRoot);
    await mkdir(sibling);
    const outside = Buffer.concat([sibling, Buffer.from("/file.cfg")]);
    await writeFile(outside, "outside");
    await symlink(outside, Buffer.concat([rawRoot, Buffer.from("/escape.cfg")]));
    const rootLink = join(parent, "root-link");
    await symlink(rawRoot, rootLink);
    expect(downloadError(() => openDownloadDescriptor(rootLink, "escape.cfg")).kind).toBe("path");
  });

  test("searches case-sensitive configured roots in order and deduplicates them", async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    await mkdir(join(first, "baseq3"));
    await mkdir(join(second, "baseq3"));
    const files = await downloadFiles([first, first, second]);
    await writeFile(join(first, "baseq3", "pak9.pk3"), "home");
    await writeFile(join(second, "baseq3", "pak9.pk3"), "base");
    await writeFile(join(second, "Case.PK3"), "case");

    const selected = files.openDownload("baseq3/pak9.pk3");
    if (selected === null) throw new Error("Expected precedence fixture file");
    const bytes = new Uint8Array(selected.size);
    expect(selected.read(bytes)).toBe(4);
    expect(text(bytes)).toBe("home");
    selected.close();

    const exactCase = files.openDownload("Case.PK3");
    if (exactCase === null) throw new Error("Expected exact-case fixture file");
    const caseBytes = new Uint8Array(exactCase.size);
    expect(exactCase.read(caseBytes)).toBe(4);
    expect(text(caseBytes)).toBe("case");
    exactCase.close();
    expect(files.openDownload("case.pk3")).toBeNull();
  });

  test("reads bounded views sequentially through EOF", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "five.dat"), "abcde");
    const file = (await downloadFiles([root])).openDownload("five.dat");
    if (file === null) throw new Error("Expected sequential fixture file");
    const backing = new Uint8Array(7).fill(95);
    expect(file.read(backing.subarray(2, 5))).toBe(3);
    expect(backing).toEqual(Uint8Array.from([95, 95, 97, 98, 99, 95, 95]));
    expect(file.read(backing.subarray(4))).toBe(2);
    expect(backing).toEqual(Uint8Array.from([95, 95, 97, 98, 100, 101, 95]));
    expect(file.read(new Uint8Array(4))).toBe(0);
    expect(file.read(new Uint8Array(0))).toBe(0);
    file.close();
  });

  test("supports empty and maximum signed-32-bit sparse files but rejects larger sizes", async () => {
    const root = await temporaryDirectory();
    const emptyPath = join(root, "empty.pk3");
    const maximumPath = join(root, "maximum.pk3");
    const oversizedPath = join(root, "oversized.pk3");
    await writeFile(emptyPath, new Uint8Array());
    await writeFile(maximumPath, new Uint8Array());
    await writeFile(oversizedPath, new Uint8Array());
    await truncate(maximumPath, 0x7fffffff);
    await truncate(oversizedPath, 0x80000000);
    const files = (await downloadFiles([root]));

    const empty = files.openDownload("empty.pk3");
    if (empty === null) throw new Error("Expected empty fixture file");
    expect(empty.size).toBe(0);
    expect(empty.read(new Uint8Array(1))).toBe(0);
    empty.close();

    const maximum = files.openDownload("maximum.pk3");
    if (maximum === null) throw new Error("Expected maximum-size fixture file");
    expect(maximum.size).toBe(0x7fffffff);
    maximum.close();
    const oversized = downloadError(() => files.openDownload("oversized.pk3"));
    expect(oversized.kind).toBe("size");
    expect(oversized.message).toContain("signed 32-bit protocol range");
  });

  test("close is idempotent and closed reads reject explicitly", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "file.dat"), "x");
    const files = await downloadFiles([root]), common = fileOwners.at(-1);
    if (common === undefined) throw new Error("Missing common file owner");
    const file = files.openDownload("file.dat");
    if (file === null) throw new Error("Expected close fixture file");
    file.close();
    file.close();
    expect(() => file.read(new Uint8Array(1))).toThrow("closed");
    const original = files.openRead("file.dat");
    if (original === null) throw new Error("Missing source handle");
    common.current.closeFile(original.file);
    const stale = files.openDownload("file.dat");
    if (stale === null) throw new Error("Missing borrowed download");
    common.current.closeFile(original.file);
    const replacement = files.openRead("file.dat");
    if (replacement === null) throw new Error("Missing replacement handle");
    expect(replacement.file).toBe(original.file);
    expect(() => stale.read(new Uint8Array(1))).toThrow("closed or replaced");
    stale.close();
    const bytes = new Uint8Array(1);
    expect(common.current.readInto(replacement.file, bytes)).toBe(1);
    expect(text(bytes)).toBe("x");
    common.current.closeFile(replacement.file);
    const terminal = files.openDownload("file.dat");
    if (terminal === null) throw new Error("Missing terminal download");
    common.close();
    expect(() => terminal.read(bytes)).toThrow("Filesystem handles are closed");
    expect(() => terminal.close()).not.toThrow();
  });

  test("size growth and shrinkage close the descriptor and reject further reads", async () => {
    const root = await temporaryDirectory();
    const growPath = join(root, "grow.dat");
    const shrinkPath = join(root, "shrink.dat");
    await writeFile(growPath, "abc");
    await writeFile(shrinkPath, "abc");
    const files = (await downloadFiles([root]));
    const grow = files.openDownload("grow.dat");
    const shrink = files.openDownload("shrink.dat");
    if (grow === null || shrink === null) throw new Error("Expected mutation fixture files");

    await appendFile(growPath, "d");
    const grown = downloadError(() => grow.read(new Uint8Array(1)));
    expect(grown.kind).toBe("changed");
    expect(grown.path).toBe("grow.dat");
    expect(() => grow.read(new Uint8Array(1))).toThrow("closed");

    await truncate(shrinkPath, 1);
    const shrunk = downloadError(() => shrink.read(new Uint8Array(1)));
    expect(shrunk.kind).toBe("changed");
    expect(shrunk.path).toBe("shrink.dat");
    expect(() => shrink.read(new Uint8Array(1))).toThrow("closed");
  });

  test("returns null only for missing or non-regular paths", async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    await mkdir(join(first, "shared"));
    await writeFile(join(second, "shared"), "later regular file");
    const files = (await downloadFiles([first, second]));
    expect(files.openDownload("missing.pk3")).toBeNull();
    const file = files.openDownload("shared");
    if (file === null) throw new Error("Expected search to continue past a non-regular path");
    expect(file.size).toBe(18);
    file.close();
  });

  test("rejects unsafe names and symlinks escaping a configured root", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeFile(join(outside, "secret.pk3"), "secret");
    await symlink(join(outside, "secret.pk3"), join(root, "escape.pk3"));
    const files = (await downloadFiles([root]));
    for (const name of ["", "../secret", "safe/../secret", "/absolute", "\\absolute", "C:\\absolute", "bad:name", "bad\0name", "two//parts", "./relative"]) {
      expect(downloadError(() => files.openDownload(name)).kind).toBe("path");
    }
    const escape = downloadError(() => files.openDownload("escape.pk3"));
    expect(escape.kind).toBe("path");
    expect(escape.message).toContain("escapes configured root");
  });

  test("revalidates the opened descriptor containment before reading", async () => {
    const root = await temporaryDirectory();
    const base = join(root, "base");
    await mkdir(base);
    const original = join(base, "moved.pk3");
    await writeFile(original, "content");
    const file = (await downloadFiles([root, base])).openDownload("moved.pk3");
    if (file === null) throw new Error("Expected moved fixture file");
    await rename(original, join(root, "moved.pk3"));

    const moved = downloadError(() => file.read(new Uint8Array(1)));
    expect(moved.kind).toBe("path");
    expect(() => file.read(new Uint8Array(1))).toThrow("closed");
  });
});
