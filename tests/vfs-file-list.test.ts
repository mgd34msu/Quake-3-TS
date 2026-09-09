import { afterEach, describe, expect, test } from "bun:test";
import { opendirSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathCompare, VirtualFileSystem } from "../src/assets/vfs.ts";
import type { Product } from "../src/shared/definitions.ts";
import { sourceZip } from "./pk3-source-fixture.ts";
import type { SourceZipEntry } from "./pk3-source-fixture.ts";

const temporaryDirectories: string[] = [];
const retailData = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retailAvailable = await Bun.file(join(retailData, "missionpack", "pak0.pk3")).exists();

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "quake3-file-list-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "baseq3", "scripts"), { recursive: true });
  return directory;
}

function entry(name: string, data = "fixture"): SourceZipEntry {
  return { name: new TextEncoder().encode(name), data: new TextEncoder().encode(data), method: 0, utf8: true };
}

async function mount(directory: string, entries: readonly SourceZipEntry[]): Promise<VirtualFileSystem> {
  await writeFile(join(directory, "baseq3", "pak0.pk3"), sourceZip(entries));
  return VirtualFileSystem.openInspection({ dataPath: directory, homePath: directory, cdPath: null, product: "baseq3" });
}

function listed(vfs: VirtualFileSystem, path: string, extension: string, capacity = 65536): string[] {
  const bytes = new Uint8Array(capacity).fill(0x7e);
  const count = vfs.getFileList(path, extension, bytes);
  const names: string[] = [];
  let start = 0;
  for (let index = 0; index < count; index++) {
    const end = bytes.indexOf(0, start);
    if (end < 0) throw new Error("Listing omitted a filename terminator");
    names.push(Array.from(bytes.subarray(start, end), byte => String.fromCharCode(byte)).join(""));
    start = end + 1;
  }
  expect(bytes.subarray(Math.max(1, start)).every(byte => byte === 0x7e)).toBe(true);
  return names;
}

function platformNames(directory: string, directoriesOnly: boolean): string[] {
  const result: string[] = [];
  const stream = opendirSync(directory);
  try {
    for (let item = stream.readSync(); item !== null; item = stream.readSync()) {
      if (directoriesOnly ? item.isDirectory() : item.isFile()) result.push(item.name);
    }
  } finally {
    stream.closeSync();
  }
  return result;
}

describe("source bounded filesystem listing", () => {
  test("lists both byte-spelled mod mounts in game and signed-byte PK3 precedence", async () => {
    const directory = join(await root(), "hôte-\u0100");
    await mkdir(directory);
    for (const game of ["\xe9", "\xc3\xa9"]) {
      const nativeDirectory = Buffer.concat([Buffer.from(`${directory}/`), Buffer.from(game, "latin1")]);
      await mkdir(nativeDirectory);
      const osPath = (name: string): Buffer => Buffer.concat([nativeDirectory, Buffer.from(`/${name}`, "latin1")]);
      await writeFile(osPath(`${game}.cfg`), game);
      await mkdir(osPath("child"));
      await writeFile(osPath(`child/${game}.cfg`), game);
      for (const basename of ["\xe9", "\xc3\xa9", "a"]) {
        await writeFile(osPath(`${basename}.pk3`), sourceZip([
          entry(`shared.cfg`, `${game}-${basename}`), entry(`${game === "\xe9" ? "base" : "mod"}-${basename === "\xe9" ? "raw" : basename === "\xc3\xa9" ? "utf8" : "ascii"}.cfg`),
        ]));
      }
    }
    using vfs = await VirtualFileSystem.openInspection({ dataPath: directory, homePath: directory, cdPath: null,
      product: "baseq3", baseGameDirectory: "\xe9", gameDirectory: "\xc3\xa9" });
    expect(listed(vfs, "", ".cfg")).toEqual(["shared.cfg", "mod-ascii.cfg", "mod-raw.cfg", "mod-utf8.cfg", "\xc3\xa9.cfg",
      "base-ascii.cfg", "base-raw.cfg", "base-utf8.cfg", "\xe9.cfg"]);
    expect(listed(vfs, "child", ".cfg")).toEqual(["\xc3\xa9.cfg", "\xe9.cfg"]);
    expect(vfs.listFilteredFiles("", "", "child/*.cfg")).toEqual(["child/\xc3\xa9.cfg", "child/\xe9.cfg"]);
    expect(vfs.listFilteredFiles("", "", "/*.cfg")).toEqual(["/\xc3\xa9.cfg", "/\xe9.cfg"]);
    expect(new TextDecoder().decode(vfs.readSync("shared.cfg"))).toBe("\xc3\xa9-a");
    expect(vfs.list()).toContain("child/\xe9.cfg");
    expect(vfs.list()).toContain("child/\xc3\xa9.cfg");
  });

  test("filtered listing visits loose children first and retains source root slash and packed spelling", async () => {
    const directory = await root();
    await mkdir(join(directory, "baseq3", "branch", "child"), { recursive: true });
    await writeFile(join(directory, "baseq3", "branch", "child", "Leaf.dat"), "leaf");
    await writeFile(join(directory, "baseq3", "Root.dat"), "root");
    await symlink(join(directory, "baseq3", "branch"), join(directory, "baseq3", "linked"));
    const vfs = await mount(directory, [entry("z.dat"), entry("branch\\packed.dat"), entry("branch/deep/deeper/end.dat"), entry("Z.DAT")]);
    const filtered = vfs.listFilteredFiles("", "ignored", "*.dat");
    expect(filtered.slice(0, 3)).toEqual(["z.dat", "branch\\packed.dat", "branch/deep/deeper/end.dat"]);
    expect(filtered.slice(3).sort()).toEqual(["/Root.dat", "branch/child/Leaf.dat"]);
    expect(vfs.listFilteredFiles("", "", "branch:*")).toEqual(["branch\\packed.dat", "branch/deep/deeper/end.dat", "branch/child/Leaf.dat", "branch/child"]);
    const all = vfs.listFilteredFiles("", "", "*");
    expect(all.indexOf("branch/child/Leaf.dat")).toBeLessThan(all.indexOf("branch/child"));
    expect(all.indexOf("branch/child")).toBeLessThan(all.indexOf("/branch"));
    expect(all.some(name => name.includes("linked"))).toBe(false);
    expect(vfs.listFilteredFiles("branch", ".not-used", "child/*")).toEqual(["child/Leaf.dat"]);
    await mkdir(join(directory, "baseq3", "raw\\directory"));
    await writeFile(join(directory, "baseq3", "raw\\directory", "file.dat"), "raw separators");
    expect(vfs.listFilteredFiles("", "", "raw:directory/*")).toEqual(["raw\\directory/file.dat"]);
  });

  test("filtered listing preserves Com_Filter prefix matching and 63-byte path conversion", async () => {
    const prefix = "a".repeat(63);
    const vfs = await mount(await root(), [entry("dir/A.dat"), entry("dir/B.data"), entry(`${prefix}x.cfg`), entry(`${prefix}y.cfg`)]);
    expect(vfs.listFilteredFiles("", "", "dir/[a-b].dat")).toEqual(["dir/a.dat", "dir/b.data"]);
    expect(vfs.listFilteredFiles("", "", `${prefix}Z.nonexistent`)).toEqual([`${prefix}x.cfg`, `${prefix}y.cfg`]);
    expect(() => vfs.listFilteredFiles("", "", "bad\0filter")).toThrow("source bytes");
    expect(() => vfs.listFilteredFiles("../outside", "", "*")).toThrow();
  });

  test("uses actual PK3 central order, first listing duplicate, and unchanged last read duplicate", async () => {
    const vfs = await mount(await root(), [entry("scripts/Z.arena"), entry("scripts/A.arena", "first"),
      entry("scripts/a.ARENA", "last"), entry("scripts2/c.arena"), entry("scripts/sub/d.arena"),
      entry("scripts/sub/deeper/e.arena"), entry("scriptsfoo.arena"), entry("scripts/xarenA")]);
    // files.c: FS_ReturnPath / FS_ListFilteredFiles. No separator boundary
    // follows the prefix; trailing query slash also increases pathDepth.
    expect(listed(vfs, "scripts", ".ARENA")).toEqual(["z.arena", "a.arena", "/c.arena", "sub/d.arena"]);
    expect(listed(vfs, "scripts/", ".arena")).toEqual(["z.arena", "a.arena", "/c.arena", "sub/d.arena", "sub/deeper/e.arena"]);
    expect(listed(vfs, "scripts", "arena")).toEqual(["z.arena", "a.arena", "/c.arena", "sub/d.arena", "xarena"]);
    expect(new TextDecoder().decode(vfs.readSync("scripts/a.arena"))).toBe("last");
    expect(vfs.list("scripts/")).toEqual(["scripts/a.arena", "scripts/sub/d.arena", "scripts/sub/deeper/e.arena", "scripts/xarena", "scripts/z.arena"]);
  });

  test("retains explicit packed directories and separator spelling without inventing parents", async () => {
    const vfs = await mount(await root(), [entry("models/players/sarge/", ""), entry("models/players/visor/icon.tga"),
      entry("models/players/slash\\", ""), entry("scripts\\Back.arena"), entry("root.cfg")]);
    expect(listed(vfs, "models/players", "/")).toEqual(["sarge/"]);
    expect(listed(vfs, "models/players", "")).toEqual(["sarge/", "visor/icon.tga", "slash\\"]);
    expect(listed(vfs, "scripts", ".arena")).toEqual(["back.arena"]);
    expect(listed(vfs, "scripts/", ".arena")).toEqual(["back.arena"]);
    expect(listed(vfs, "scripts\\", ".arena")).toEqual(["back.arena"]);
    expect(listed(vfs, "", "cfg")).toEqual(["root.cfg"]);
    expect(listed(vfs, "", "/")).toEqual(["scripts"]);
  });

  test("packs exact capacities, stops at first non-fitting name, and leaves all tail bytes untouched", async () => {
    const vfs = await mount(await root(), [entry("scripts/z.arena"), entry("scripts/a.arena"), entry("scripts/x")]);
    for (const capacity of [1, 2, 9]) expect(listed(vfs, "scripts", "", capacity)).toEqual([]);
    for (const capacity of [10, 17]) expect(listed(vfs, "scripts", "", capacity)).toEqual(["z.arena"]);
    expect(listed(vfs, "scripts", "", 18)).toEqual(["z.arena", "a.arena"]);
    const backing = new Uint8Array(20).fill(0x7e);
    expect(vfs.getFileList("scripts", "", backing.subarray(3, 13))).toBe(1);
    expect(Array.from(backing)).toEqual([126, 126, 126, 122, 46, 97, 114, 101, 110, 97, 0, 126, 126, 126, 126, 126, 126, 126, 126, 126]);
    expect(() => vfs.getFileList("scripts", "", new Uint8Array())).toThrow("nonempty");
    expect(listed(vfs, "missing", ".arena", 1)).toEqual([]);
  });

  test("traverses product, root and pak precedence then retains loose case spelling", async () => {
    const data = await root();
    const home = await root();
    const cd = await root();
    for (const directory of [data, home, cd]) {
      await mkdir(join(directory, "missionpack", "scripts"), { recursive: true });
    }
    await writeFile(join(home, "missionpack", "pak2.pk3"), sourceZip([entry("scripts/Z.arena"), entry("scripts/shared.arena")]));
    await writeFile(join(home, "missionpack", "pak1.pk3"), sourceZip([entry("scripts/a.arena"), entry("scripts/SHARED.arena")]));
    await writeFile(join(home, "missionpack", "scripts", "Loose.ARENA"), "loose");
    await writeFile(join(home, "missionpack", "scripts", "Shared.ARENA"), "duplicate");
    await writeFile(join(data, "missionpack", "pak0.pk3"), sourceZip([entry("scripts/data.arena")]));
    await writeFile(join(cd, "missionpack", "pak0.pk3"), sourceZip([entry("scripts/cd.arena")]));
    await writeFile(join(home, "baseq3", "pak0.pk3"), sourceZip([entry("scripts/base.arena")]));
    let randomCalls = 0;
    const vfs = await VirtualFileSystem.openTracked({ dataPath: data, homePath: home, cdPath: cd, product: "missionpack",
      references: { checksumFeed: 42, random: () => { randomCalls++; return 7; } } });
    expect(listed(vfs, "scripts", ".arena")).toEqual(["z.arena", "shared.arena", "a.arena", "Loose.ARENA", "data.arena", "cd.arena", "base.arena"]);
    expect(randomCalls).toBe(0);
    expect(vfs.pakReferences.snapshot().every(state => state.flags === 0)).toBe(true);
  });

  test("uses live unsorted platform directory order and omits dots and symlinks", async () => {
    const directory = await root();
    const scripts = join(directory, "baseq3", "scripts");
    for (const name of ["Z.arena", "a.ARENA", "NodotarenA", "other.cfg"]) await writeFile(join(scripts, name), "loose");
    for (const name of ["z-sub", "a-sub"]) await mkdir(join(scripts, name));
    await writeFile(join(scripts, "z-sub", "nested.arena"), "nested");
    await symlink(join(scripts, "Z.arena"), join(scripts, "linked.arena"));
    await symlink(join(scripts, "z-sub"), join(scripts, "linked-dir"));
    const vfs = await mount(directory, []);
    expect(listed(vfs, "scripts", "")).toEqual(platformNames(scripts, false));
    expect(listed(vfs, "scripts", "arena")).toEqual(platformNames(scripts, false).filter(name => name.toLowerCase().endsWith("arena")));
    expect(listed(vfs, "scripts", "/")).toEqual(platformNames(scripts, true));
    expect(listed(vfs, "scripts", "/")).not.toContain(".");
    expect(listed(vfs, "scripts", "/")).not.toContain("..");
    expect(listed(vfs, "scripts/linked-dir", "")).toEqual([]);
    await writeFile(join(scripts, "new.arena"), "new");
    expect(listed(vfs, "scripts", ".arena")).toContain("new.arena");
  });

  test("lists named pipes with source extension and recursive filtering without following symlinks", async () => {
    const directory = await root();
    const scripts = join(directory, "baseq3", "scripts");
    await mkdir(join(scripts, "nested"));
    const pipe = join(scripts, "Queue.ARENA");
    const childPipe = join(scripts, "nested", "Child.bot");
    const created = Bun.spawn(["mkfifo", "--", pipe, childPipe], { stdout: "ignore", stderr: "pipe" });
    expect(await created.exited).toBe(0);
    await symlink(pipe, join(scripts, "linked.arena"));
    await symlink(join(directory, "absent"), join(scripts, "broken.arena"));
    await mkdir(join(directory, "outside"));
    await writeFile(join(directory, "outside", "escape.arena"), "outside product root");
    await symlink(join(directory, "outside"), join(scripts, "outside"));
    const vfs = await mount(directory, []);
    expect(listed(vfs, "scripts", "")).toEqual(["Queue.ARENA"]);
    expect(listed(vfs, "scripts", "arena")).toEqual(["Queue.ARENA"]);
    expect(listed(vfs, "scripts", ".ARENA")).toEqual(["Queue.ARENA"]);
    expect(listed(vfs, "scripts", "/")).toEqual(["nested"]);
    expect(listed(vfs, "scripts/nested", ".bot")).toEqual(["Child.bot"]);
    expect(vfs.listFilteredFiles("scripts", "ignored", "*.arena")).toEqual(["/Queue.ARENA"]);
    expect(vfs.listFilteredFiles("scripts", "ignored", "nested/*")).toEqual(["nested/Child.bot"]);
    const all = vfs.listFilteredFiles("scripts", "ignored", "*");
    expect(all).toHaveLength(3);
    expect(all).toContain("/Queue.ARENA");
    expect(all.indexOf("nested/Child.bot")).toBeLessThan(all.indexOf("/nested"));
    expect(listed(vfs, "scripts/outside", "")).toEqual([]);
    expect(vfs.listFilteredFiles("scripts/outside", "", "*")).toEqual([]);
  });

  test("rejects unsafe query paths, non-byte queries and unavailable mod listing", async () => {
    const vfs = await mount(await root(), []);
    for (const path of ["/", "../escape", "a/../b", "a//b", "C:/b", "a/./b", "a\0b", "\u0100"]) {
      expect(() => listed(vfs, path, "")).toThrow();
    }
    expect(() => listed(vfs, "a".repeat(256), "")).toThrow("MAX_ZPATH");
    expect(() => listed(vfs, "", "\u0100")).toThrow("source bytes");
    expect(() => listed(vfs, "", "\0")).toThrow("source bytes");
    expect(() => listed(vfs, "$MODLIST", "")).toThrow("FS_SV");
  });

  test("lists packed and loose bytes while retaining the source overlength qualification", async () => {
    const directory = await root();
    const vfs = await mount(directory, [entry("scripts/café.arena"), entry("other/" + "x".repeat(250) + ".cfg"), entry("scripts/ok.bot")]);
    expect(listed(vfs, "scripts", ".bot")).toEqual(["ok.bot"]);
    expect(listed(vfs, "absent", "")).toEqual([]);
    expect(listed(vfs, "scripts", ".arena")).toEqual(["caf\xc3\xa9.arena"]);
    expect(() => listed(vfs, "other", ".cfg")).toThrow("name-too-long");
    await writeFile(join(directory, "baseq3", "scripts", "é.bot"), "loose");
    expect(listed(vfs, "scripts", ".bot")).toEqual(["ok.bot", "\xc3\xa9.bot"]);
  });

  test("keeps raw loose names distinct from UTF-8 names under a Unicode host root", async () => {
    const directory = join(await root(), "hôte");
    const game = join(directory, "baseq3");
    await mkdir(game, { recursive: true });
    const osPath = (relative: string): Buffer => Buffer.concat([Buffer.from(`${game}/`), Buffer.from(relative, "latin1")]);
    for (const name of ["\xe9", "\xc3\xa9", "\xff"]) {
      await writeFile(osPath(`${name}.cfg`), `file-${name}`);
      await mkdir(osPath(`${name}dir`));
      await writeFile(osPath(`${name}dir/Child.cfg`), `child-${name}`);
    }
    const outside = join(directory, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "escape.cfg"), "outside");
    await symlink(outside, osPath("\xe9link"));
    await symlink(join(outside, "escape.cfg"), osPath("\xfflink.cfg"));
    using vfs = await VirtualFileSystem.openInspection({ dataPath: directory, homePath: directory, cdPath: null, product: "baseq3" });
    expect(new TextDecoder().decode(vfs.readSync("\xe9.cfg"))).toBe("file-\xe9");
    expect(listed(vfs, "", ".cfg").sort()).toEqual(["\xc3\xa9.cfg", "\xe9.cfg", "\xff.cfg"]);
    expect(listed(vfs, "", "/").sort()).toEqual(["\xc3\xa9dir", "\xe9dir", "\xffdir"]);
    for (const name of ["\xe9", "\xc3\xa9", "\xff"]) {
      expect(new TextDecoder().decode(vfs.readSync(`${name}.cfg`))).toBe(`file-${name}`);
      expect(new TextDecoder().decode(await vfs.readFileOptional(`${name}dir/Child.cfg`))).toBe(`child-${name}`);
      expect(vfs.has(`${name}dir/Child.cfg`)).toBe(true);
      expect(listed(vfs, `${name}dir`, ".cfg")).toEqual(["Child.cfg"]);
      expect(vfs.listFilteredFiles(`${name}dir`, "", "*.cfg")).toEqual(["/Child.cfg"]);
      expect(vfs.listFilteredFiles("", "", `${name}dir/*.cfg`)).toEqual([`${name}dir/Child.cfg`]);
    }
    expect(vfs.list()).toEqual(["\xc3\xa9.cfg", "\xc3\xa9dir/child.cfg", "\xe9.cfg", "\xe9dir/child.cfg", "\xff.cfg", "\xffdir/child.cfg"]);
    expect(listed(vfs, "\xe9link", ".cfg")).toEqual([]);
    expect(vfs.listFilteredFiles("\xe9link", "", "*")).toEqual([]);
    expect(vfs.openRead("\xe9link/escape.cfg")).toBeUndefined();
    expect(vfs.openRead("\xfflink.cfg")).toBeUndefined();
    expect(vfs.listFilteredFiles("", "", "*link*")).toEqual([]);
    expect(() => vfs.openRead("\u0100.cfg")).toThrow("source bytes");
    expect(() => vfs.openRead("a".repeat(4096))).toThrow("MAX_OSPATH");
  });

  test("lists exact packed bytes and reopens them with retained readers regardless of UTF-8 flags", async () => {
    const packed = (name: string, data: string, utf8: boolean): SourceZipEntry => ({
      name: Uint8Array.from(name, character => character.charCodeAt(0)),
      data: new TextEncoder().encode(data), method: 8, utf8,
    });
    const vfs = await mount(await root(), [
      packed("scripts/\xe9A.ARENA", "first", false),
      packed("scripts/\xc9A.ARENA", "distinct", true),
      packed("scripts/\xe9a.arena", "last", true),
      packed("scripts/\xc3\xa9.ARENA", "utf8-first", false),
      packed("scripts/\xc3\xa9.arena", "utf8-last", true),
      packed("scripts/\xc3(.ARENA", "invalid-utf8", true),
      packed("scripts/\xffA.ARENA", "eof", true),
      packed("\xe9dir/File.\xc9", "query", false),
    ]);
    const names = listed(vfs, "scripts", ".ARENA");
    expect(names).toEqual(["\xe9a.arena", "\xc9a.arena", "\xc3\xa9.arena", "\xc3(.arena", "\xffa.arena"]);
    const payloads: string[] = [];
    for (const name of names) {
      const opened = vfs.openRead(`scripts/${name}`);
      if (opened === undefined) throw new Error(`Listed entry did not reopen: ${name}`);
      try {
        const bytes = new Uint8Array(opened.length);
        expect(vfs.readInto(opened.file, bytes)).toBe(opened.length);
        payloads.push(new TextDecoder().decode(bytes));
      } finally { vfs.closeFile(opened.file); }
    }
    expect(payloads).toEqual(["last", "distinct", "utf8-last", "invalid-utf8", "eof"]);
    expect(listed(vfs, "scripts", ".bot")).toEqual([]);
    expect(listed(vfs, "\xe9DIR", ".\xc9")).toEqual(["file.\xc9"]);
    expect(listed(vfs, "\xc9dir", ".\xc9")).toEqual([]);
    expect(vfs.listFilteredFiles("", "", "scripts/\xe9A.*")).toEqual(["scripts/\xe9a.arena"]);
    expect(vfs.listFilteredFiles("", "", "scripts/[\xc9-\xe9]*")).toEqual([
      "scripts/\xe9a.arena", "scripts/\xc9a.arena",
    ]);
    expect(vfs.listFilteredFiles("", "", "scripts/\xff*")).toEqual(["scripts/\xffa.arena"]);
  });

  test("sorts fdir byte names as signed char while retaining ASCII and separator comparisons", () => {
    expect(["z", "\xff", "\xe9", "\xc9", "\x80", "a"].sort(pathCompare)).toEqual([
      "\x80", "\xc9", "\xe9", "\xff", "a", "z",
    ]);
    expect(pathCompare("a\xff", "a")).toBe(-1);
    expect(pathCompare("\xe9/A", "\xe9\\a")).toBe(0);
    expect(pathCompare("\xc9", "\xe9")).toBe(-1);
  });

  test("caps unique packed names at 4095 despite duplicates before and after the cap", async () => {
    const entries: SourceZipEntry[] = [entry("scripts/first.bot"), entry("scripts/FIRST.bot")];
    for (let index = 1; index < 4095; index++) entries.push(entry(`scripts/${index}.bot`));
    entries.push(entry("scripts/FIRST.bot"), entry("scripts/beyond.bot"));
    const vfs = await mount(await root(), entries);
    const result = listed(vfs, "scripts", ".bot");
    expect(result).toHaveLength(4095);
    expect(result[0]).toBe("first.bot");
    expect(result[4094]).toBe("4094.bot");
    expect(result).not.toContain("beyond.bot");
  });

  test("applies the loose directory cap before global case-insensitive deduplication", async () => {
    const directory = await root();
    const scripts = join(directory, "baseq3", "scripts");
    const fileNames = ["FIRST.bot", "first.bot"];
    for (let index = 0; index < 4094; index++) fileNames.push(`${index}.bot`);
    await Promise.all(fileNames.map(name => writeFile(join(scripts, name), "")));
    const vfs = await mount(directory, []);
    const sourceOrder = platformNames(scripts, false).slice(0, 4095);
    const expected: string[] = [];
    const seen = new Set<string>();
    for (const name of sourceOrder) {
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      expected.push(name);
    }
    expect(listed(vfs, "scripts", ".bot")).toEqual(expected);
  });

  test.skipIf(!retailAvailable)("lists both installed products' arena and bot names without reference effects", async () => {
    const products: readonly Product[] = ["baseq3", "missionpack"];
    for (const product of products) {
      let calls = 0;
      const vfs = await VirtualFileSystem.openTracked({ dataPath: retailData, homePath: retailData, cdPath: null, product,
        references: { checksumFeed: 0, random: () => { calls++; return 1; } } });
      for (const extension of [".arena", ".bot"]) {
        const result = listed(vfs, "scripts", extension);
        if (extension === ".arena") expect(result.length).toBeGreaterThan(0);
        expect(new Set(result.map(name => name.toLowerCase())).size).toBe(result.length);
        expect(result.every(name => name.endsWith(extension))).toBe(true);
        const inventory = vfs.list("scripts/").filter(name => name.endsWith(extension)).map(name => name.slice(8));
        expect([...result].sort()).toEqual([...inventory].sort());
      }
      expect(calls).toBe(0);
      expect(vfs.pakReferences.snapshot().every(state => state.flags === 0)).toBe(true);
    }
  });
});
