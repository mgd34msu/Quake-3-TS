import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, open as openFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReadFileMemory } from "../src/assets/read-file-memory.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { PakReferenceFlag, ServerPakSet } from "../src/assets/pak-references.ts";
import type { PakCatalogEntry } from "../src/assets/pak-references.ts";
import { Pk3Archive } from "../src/assets/pk3.ts";
import { checkedGameDirectory, VirtualFileSystem } from "../src/assets/vfs.ts";
import type { TrackedVirtualFileSystem, VfsSearchOptions } from "../src/assets/vfs.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { CommonError } from "../src/core/common-error.ts";
import { readdirSync, readlinkSync, renameSync, writeFileSync } from "node:fs";

interface StoredEntry {
  readonly name: string;
  readonly text: string;
}

const temporaryDirectories: string[] = [];
const retailDataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retailBaseAvailable = await Bun.file(join(retailDataPath, "baseq3", "pak0.pk3")).exists();
const retailMissionpackAvailable = await Bun.file(join(retailDataPath, "missionpack", "pak0.pk3")).exists();

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function descriptorCount(path: string): number {
  let count = 0;
  for (const descriptor of readdirSync("/proc/self/fd")) {
    try {
      if (readlinkSync(`/proc/self/fd/${descriptor}`) === path) count++;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return count;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function storedZip(entries: readonly StoredEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.text);
    const checksum = crc32(data);
    const local = new Uint8Array(30 + name.byteLength + data.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, data.byteLength, true);
    localView.setUint32(22, data.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(data, 30 + name.byteLength);
    locals.push(local);
    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, data.byteLength, true);
    centralView.setUint32(24, data.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centrals.push(central);
    localOffset += local.byteLength;
  }
  const localBytes = concatenate(locals);
  const centralBytes = concatenate(centrals);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralBytes.byteLength, true);
  endView.setUint32(16, localBytes.byteLength, true);
  return concatenate([localBytes, centralBytes, end]);
}

function monoWav(firstSample: number, secondSample: number): Uint8Array {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  const markers = [
    { offset: 0, text: "RIFF" },
    { offset: 8, text: "WAVE" },
    { offset: 12, text: "fmt " },
    { offset: 36, text: "data" },
  ];
  for (const marker of markers) {
    for (let index = 0; index < marker.text.length; index++) {
      bytes[marker.offset + index] = marker.text.charCodeAt(index);
    }
  }
  view.setUint32(4, bytes.byteLength - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 22_050, true);
  view.setUint32(28, 44_100, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, 4, true);
  view.setInt16(44, firstSample, true);
  view.setInt16(46, secondSample, true);
  return bytes;
}

async function makeDataTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "quake3-vfs-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "baseq3", "scripts"), { recursive: true });
  await mkdir(join(root, "missionpack", "scripts"), { recursive: true });
  await writeFile(join(root, "baseq3", "scripts", "shared.cfg"), "base loose");
  await writeFile(join(root, "baseq3", "loose-only.txt"), "base loose only");
  await writeFile(join(root, "missionpack", "fallback.txt"), "mission loose fallback");
  await writeFile(join(root, "missionpack", "scripts", "shared.cfg"), "mission loose");
  await writeFile(join(root, "missionpack", "mission-only.txt"), "mission loose only");
  await writeFile(join(root, "baseq3", "empty.pk3"), storedZip([]));
  await writeFile(join(root, "baseq3", "pak1.pk3"), storedZip([
    { name: "scripts/shared.cfg", text: "base pak1" },
    { name: "base-pack.txt", text: "base pack" },
    { name: "fallback.txt", text: "base packed fallback" },
  ]));
  await writeFile(join(root, "baseq3", "pak2.pk3"), storedZip([
    { name: "scripts/shared.cfg", text: "base pak2" },
    { name: "vm/cgame.qvm", text: "base cgame" },
  ]));
  await writeFile(join(root, "missionpack", "MiXeD.pk3"), storedZip([]));
  await writeFile(join(root, "missionpack", "pak0.pk3"), storedZip([
    { name: "scripts/shared.cfg", text: "mission pak0" },
    { name: "mission-pack.txt", text: "mission pack" },
  ]));
  return root;
}

async function makeSearchRoot(parent: string, name: string): Promise<string> {
  const root = join(parent, name);
  await mkdir(join(root, "baseq3"), { recursive: true });
  await mkdir(join(root, "missionpack"), { recursive: true });
  return root;
}

async function makeLooseFallbackTree(): Promise<{
  readonly dataPath: string;
  readonly homePath: string;
  readonly homeDirectory: string;
  readonly homeFile: string;
}> {
  const parent = await mkdtemp(join(tmpdir(), "quake3-vfs-fallback-"));
  temporaryDirectories.push(parent);
  const dataPath = await makeSearchRoot(parent, "base");
  const homePath = await makeSearchRoot(parent, "home");
  const homeDirectory = join(homePath, "baseq3");
  const homeFile = join(homeDirectory, "x.dat");
  await writeFile(join(dataPath, "baseq3", "x.dat"), "lower-content");
  await writeFile(homeFile, "x");
  return { dataPath, homePath, homeDirectory, homeFile };
}

async function readText(vfs: VirtualFileSystem, path: string): Promise<string> {
  return new TextDecoder().decode(await vfs.read(path));
}

function searchOptions(dataPath: string, product: Product): VfsSearchOptions {
  return { dataPath, homePath: dataPath, cdPath: null, product };
}

function readTextSync(vfs: VirtualFileSystem, path: string): string {
  return new TextDecoder().decode(vfs.readSync(path));
}

describe("Quake virtual filesystem", () => {
  test("mounts byte-distinct mod directories and PK3 basenames under Unicode host roots", async () => {
    const parent = await makeDataTree();
    const dataPath = join(parent, "hôte-\u0100");
    await mkdir(dataPath);
    for (const game of ["\xe9", "\xc3\xa9"]) {
      const nativeDirectory = Buffer.concat([Buffer.from(`${dataPath}/`), Buffer.from(game, "latin1")]);
      await mkdir(nativeDirectory);
      const nativePath = (name: string): Buffer => Buffer.concat([nativeDirectory, Buffer.from(`/${name}`, "latin1")]);
      await writeFile(nativePath("loose.cfg"), `loose-${game}`);
      for (const basename of ["\xe9", "\xc3\xa9", "a"]) {
        await writeFile(nativePath(`${basename}.pk3`), storedZip([
          { name: "shared.cfg", text: `packed-${game}-${basename}` },
          { name: `${basename === "\xe9" ? "raw" : basename === "\xc3\xa9" ? "utf8" : "ascii"}.cfg`, text: basename },
        ]));
      }
      using vfs = await VirtualFileSystem.openTracked({ dataPath, homePath: dataPath, cdPath: null, product: "baseq3",
        gameDirectory: game, references: { checksumFeed: 0, random: () => 0 } });
      expect(vfs.pakReferences.snapshot().map(row => row.pack.basename)).toEqual(["a", "\xe9", "\xc3\xa9"]);
      expect(readTextSync(vfs, "loose.cfg")).toBe(`loose-${game}`);
      expect(readTextSync(vfs, "shared.cfg")).toBe(`packed-${game}-a`);
      expect(vfs.source("raw.cfg")).toEqual({ kind: "pk3", game, path: "raw.cfg", archivePath: join(dataPath, game, "\xe9.pk3") });
      expect(vfs.source("loose.cfg")).toEqual({ kind: "loose", game, path: "loose.cfg", filePath: join(dataPath, game, "loose.cfg") });
      for (const [path, expected] of [["raw.cfg", "\xe9"], ["utf8.cfg", "\xc3\xa9"]]) {
        if (path === undefined || expected === undefined) throw new Error("Incomplete native path fixture");
        expect(readTextSync(vfs, path)).toBe(expected);
        const opened = vfs.openUniqueRead(path);
        if (opened === undefined) throw new Error("Native PK3 entry did not reopen");
        try {
          const bytes = new Uint8Array(opened.length);
          expect(vfs.readInto(opened.file, bytes)).toBe(opened.length);
          expect(new TextDecoder().decode(bytes)).toBe(expected);
        } finally { vfs.closeFile(opened.file); }
        const retained = vfs.readFileRetainedSync(path);
        if (retained === undefined) throw new Error("Native PK3 entry did not retain");
        try { expect(new TextDecoder().decode(retained.bytes)).toBe(expected); }
        finally { vfs.freeFile(retained); }
      }
    }
  });

  test("accepts byte game names while retaining game-directory safety guards", () => {
    for (const game of ["", "\xe9", "\xc3\xa9", "\xff"]) expect(checkedGameDirectory(game)).toBe(game);
    for (const game of ["\0", "\u0100", ".", "..", "x..y", "x/y", "x\\y", "x:y", "a".repeat(4096)]) {
      expect(() => checkedGameDirectory(game)).toThrow();
    }
  });

  async function copyFixture(product: Product = "baseq3", print: (text: string) => undefined = () => {}) {
    const parent = await mkdtemp(join(tmpdir(), "quake3-vfs-copy-"));
    temporaryDirectories.push(parent);
    const cdPath = await makeSearchRoot(parent, "cd");
    const dataPath = await makeSearchRoot(parent, "base");
    const homePath = await makeSearchRoot(parent, "home");
    const cvars = new CvarRegistry(), sound = new SoundOutput();
    cvars.register("fs_copyfiles", "1");
    const files = new CommonFileState({ dataPath, homePath, cdPath, product }, print, sound, cvars);
    return { parent, cdPath, dataPath, homePath, cvars, files,
      start: async () => { await files.initialize({ checksumFeed: 0, random: () => 0.25 }, () => {}); },
      close: () => { files.close(); sound.close(); } };
  }

  test("restricted mode validates the source product artifact prefix and frees it before an identification error", async () => {
    const f = await copyFixture();
    // The decoded static table in files.c:310, independent of installed retail assets.
    const productId = "This file is copyright 1999 Id Software, and may not be duplicated except during a licensed installation of the full commercial version of Quake 3:Arena";
    const path = join(f.homePath, "baseq3", "productid.txt");
    await writeFile(path, `${productId}\0ignored suffix`);
    await f.start();
    try {
      const original = f.files.current;
      await f.files.setRestrictions(() => {});
      expect(f.files.current).toBe(original);
      expect(f.cvars.get("fs_restrict")).toMatchObject({ value: "", flags: 16 });
      expect(f.files.fileMemory.loadCount).toBe(1);
      expect(f.files.fileMemory.loadStack).toBe(0);
      for (const invalid of ["", productId.slice(0, -1), `x${productId.slice(1)}`, `${productId.slice(0, -1)}x`]) {
        await writeFile(path, invalid);
        await expect(f.files.setRestrictions(() => {})).rejects.toMatchObject({ code: "fatal", message: "Invalid product identification" });
        expect(f.files.current).toBe(original);
        expect(f.cvars.get("fs_restrict")?.value).toBe("");
        expect(f.files.fileMemory.loadStack).toBe(0);
      }
      expect(f.files.fileMemory.loadCount).toBe(5);
    } finally { f.close(); }
  });

  test("restricted mode remounts the pinned demota directory and consumes live read and listing restrictions", async () => {
    const printed: string[] = [];
    const f = await copyFixture("missionpack", text => { printed.push(text); });
    f.cvars.register("fs_game", "authoredmod");
    f.cvars.register("fs_basegame", "parentmod");
    for (const root of [f.cdPath, f.dataPath, f.homePath]) {
      for (const game of ["authoredmod", "parentmod", "demota"]) await mkdir(join(root, game));
      await writeFile(join(root, "demota", "priority.cfg"), root);
    }
    await writeFile(join(f.homePath, "authoredmod", "mod-only.cfg"), "mod");
    const allowed = ["cfg", "MENU", "game", "dm_68", "dat"], blocked = ["txt", "wav", "dm_67", "arena", "shader"];
    for (const extension of [...allowed, ...blocked]) await writeFile(join(f.homePath, "demota", `loose.${extension}`), extension);
    await f.start();
    try {
      const original = f.files.current, roots = f.files.roots;
      expect(original.readFileLength("mod-only.cfg")).toBe(3);
      await f.files.setRestrictions(() => {});
      expect(printed).toContain("\nRunning in restricted demo mode.\n\n");
      expect(f.files.roots).toBe(roots);
      expect(f.files.current).not.toBe(original);
      expect(() => original.readFileLength("mod-only.cfg")).toThrow("retired");
      expect(f.cvars.get("fs_game")).toMatchObject({ value: "authoredmod", modified: false });
      expect(f.cvars.get("fs_basegame")?.value).toBe("parentmod");
      expect(f.cvars.get("fs_restrict")?.value).toBe("1");
      expect(f.files.writable.rootPath).toBe(join(f.homePath, "demota"));
      expect(f.files.current.readFileLength("mod-only.cfg")).toBe(-1);
      expect(readTextSync(f.files.current, "priority.cfg")).toBe(f.homePath);
      for (const extension of allowed) expect(f.files.current.readFileLength(`loose.${extension}`)).toBe(extension.length);
      for (const extension of blocked) {
        expect(f.files.current.readFileLength(`loose.${extension}`)).toBe(-1);
        expect(f.files.current.has(`loose.${extension}`)).toBe(true);
      }
      const listing = new Uint8Array(1024).fill(126);
      expect(f.files.current.getFileList("", ".cfg", listing)).toBe(0);
      expect(listing[0]).toBe(0);
      expect(f.files.current.list()).toEqual([]);
      expect(f.files.current.listFilteredFiles("", "", "*.cfg")).toEqual([]);
      const written = f.files.writable.openBinaryWrite("new-demo.dat");
      if (written === null) throw new Error("Expected restricted-mode write");
      written.writeBytes(new TextEncoder().encode("saved")); written.close();
      expect(await Bun.file(join(f.homePath, "demota", "new-demo.dat")).text()).toBe("saved");
      f.cvars.set("fs_restrict", "0", true);
      expect(f.files.current.readFileLength("loose.txt")).toBe(3);
      expect(f.files.current.list()).toContain("loose.txt");
      f.cvars.set("fs_restrict", "-7", true);
      expect(f.files.current.readFileLength("loose.txt")).toBe(-1);
      expect(f.files.current.list()).toEqual([]);
    } finally { f.close(); }
  });

  test("restricted mode skips the product read when forced and preserves source shutdown handle lifetimes", async () => {
    let inspect = (): void => {};
    const f = await copyFixture("baseq3", text => { if (text === "\nRunning in restricted demo mode.\n\n") inspect(); });
    f.cvars.register("fs_restrict", "-1");
    await writeFile(join(f.homePath, "baseq3", "productid.txt"), "invalid");
    await writeFile(join(f.homePath, "baseq3", "positive.cfg"), "positive");
    await writeFile(join(f.homePath, "baseq3", "empty.cfg"), "");
    await f.start();
    try {
      const original = f.files.current;
      const positive = original.openRead("positive.cfg"), empty = original.openRead("empty.cfg");
      const writer = f.files.writable.openBinaryWrite("retained.dat");
      if (positive === undefined || empty === undefined || writer === null) throw new Error("Expected source handles");
      let printed = false;
      inspect = () => {
        printed = true;
        expect(f.cvars.get("fs_restrict")?.value).toBe("1");
        expect(f.files.current).toBe(original);
        expect(f.files.writable.rootPath).toBe(join(f.homePath, "baseq3"));
        expect(original.readInto(positive.file, new Uint8Array(1))).toBe(1);
      };
      await f.files.setRestrictions(() => {});
      expect(printed).toBe(true);
      expect(f.files.fileMemory.loadCount).toBe(0);
      expect(() => f.files.current.readInto(positive.file, new Uint8Array(1))).toThrow("not readable");
      expect(f.files.current.readInto(empty.file, new Uint8Array(1))).toBe(0);
      f.files.closeFile(empty.file.slot);
      writer.writeBytes(new TextEncoder().encode("retained")); writer.close();
      expect(await Bun.file(join(f.homePath, "baseq3", "retained.dat")).text()).toBe("retained");
    } finally { f.close(); }
  });

  test("restricted mode checks every mounted pack even when its name or pure membership differs", async () => {
    const f = await copyFixture();
    for (const root of [f.dataPath, f.homePath]) await mkdir(join(root, "demota"));
    await writeFile(join(f.dataPath, "demota", "pak0.pk3"), storedZip([{ name: "base.cfg", text: "base" }]));
    const highPath = join(f.homePath, "demota", "unapproved.pk3");
    await writeFile(highPath, storedZip([{ name: "home.cfg", text: "home" }]));
    using archive = await Pk3Archive.open(highPath);
    const checksum = archive.checksum;
    expect(checksum).not.toBe(437558517);
    await f.start();
    try {
      const original = f.files.current;
      await f.files.setServerLoadedPaks("123", "missing/pak", () => {});
      await expect(f.files.setRestrictions(() => {})).rejects.toMatchObject({ code: "fatal", message: `Corrupted pak0.pk3: ${checksum}` });
      expect(f.cvars.get("fs_restrict")?.value).toBe("1");
      expect(() => original.has("unused.cfg")).toThrow("retired");
      expect(f.files.current.pakReferences.snapshot().map(record => record.pack.basename)).toEqual(["unapproved", "pak0"]);
      expect(f.files.writable.rootPath).toBe(join(f.homePath, "demota"));
      expect(f.files.current.has("home.cfg")).toBe(true);
      expect(f.files.current.readFileLength("home.cfg")).toBe(-1);
    } finally { f.close(); }
  });

  test("restricted mode retains the reached cvar and old mounts when its announcement aborts", async () => {
    const failure = new CommonError("drop", "restriction print stopped");
    const f = await copyFixture("baseq3", text => { if (text === "\nRunning in restricted demo mode.\n\n") throw failure; });
    await writeFile(join(f.homePath, "baseq3", "original.cfg"), "original");
    await f.start();
    try {
      const original = f.files.current;
      await expect(f.files.setRestrictions(() => {})).rejects.toBe(failure);
      expect(f.cvars.get("fs_restrict")?.value).toBe("1");
      expect(f.files.current).toBe(original);
      expect(original.readFileLength("original.cfg")).toBe(8);
      expect(f.files.writable.rootPath).toBe(join(f.homePath, "baseq3"));
    } finally { f.close(); }
  });

  test("restricted startup preserves the initial-game empty-base home predicate", async () => {
    const parent = await mkdtemp(join(tmpdir(), "quake3-vfs-restricted-roots-"));
    temporaryDirectories.push(parent);
    const mounted: string[] = [];
    using vfs = await VirtualFileSystem.openTracked({ dataPath: "", homePath: parent, cdPath: null, product: "missionpack",
      gameDirectory: "authoredmod", baseGameDirectory: "parentmod", startupGame: "demota", isRestricted: () => true,
      references: { checksumFeed: 0, random: () => 0 }, mountGameDirectory: game => { mounted.push(game); } });
    try {
      expect(mounted).toEqual([]);
      expect(vfs.initialized).toBe(false);
    } finally { vfs.close(); }
  });

  test("restricted mode forced with empty roots reaches the announcement and remount before an initialized read is required", async () => {
    const printed: string[] = [];
    const f = await copyFixture("baseq3", text => { printed.push(text); });
    f.cvars.register("fs_basepath", ""); f.cvars.register("fs_cdpath", "");
    await f.start();
    try {
      await expect(f.files.setRestrictions(() => {})).rejects.toMatchObject({ code: "fatal", message: "Filesystem call made without initialization\n" });
      expect(f.cvars.get("fs_restrict")?.value).toBe("");
      expect(printed).toEqual([]);
      f.cvars.set("fs_restrict", "-1", true);
      await f.files.setRestrictions(() => {});
      expect(f.cvars.get("fs_restrict")?.value).toBe("1");
      expect(printed).toEqual(["\nRunning in restricted demo mode.\n\n"]);
      expect(() => f.files.current).toThrow("Filesystem call made without initialization");
      expect(f.files.fileMemory.loadCount).toBe(0);
    } finally { f.close(); }
  });

  test("every source read strips one leading separator and rejects traversal before selecting a handle", async () => {
    const f = await copyFixture();
    await writeFile(join(f.homePath, "baseq3", "loose.cfg"), "loose");
    await writeFile(join(f.homePath, "baseq3", "pak0.pk3"), storedZip([{ name: "packed.cfg", text: "packed" }]));
    await f.start();
    try {
      expect(f.files.current.readFileLength("/loose.cfg")).toBe(5);
      expect(f.files.current.fileLength("\\packed.cfg")).toBe(6);
      expect(new TextDecoder().decode(f.files.current.readFileOptionalSync("/packed.cfg"))).toBe("packed");
      const retained = f.files.current.readFileRetainedSync("\\loose.cfg");
      if (retained === undefined) throw new Error("Expected source retained read");
      expect(new TextDecoder().decode(retained.bytes)).toBe("loose");
      f.files.current.freeFile(retained);
      const unique = f.files.current.openUniqueRead("/packed.cfg");
      if (unique === undefined) throw new Error("Expected source unique read");
      f.files.closeFile(unique.file.slot);
      for (let index = 0; index < 63; index++) expect(f.files.current.openRead("loose.cfg")?.file.slot).toBe(index + 1);
      for (const path of ["../loose.cfg", "part::loose.cfg", "/../loose.cfg"]) {
        expect(f.files.current.readFileLength(path)).toBe(-1);
        expect(f.files.current.readFileRetainedSync(path)).toBeUndefined();
        expect(f.files.current.openUniqueRead(path)).toBeUndefined();
        expect(f.files.current.openRead(path)).toBeUndefined();
        const published: number[] = [];
        expect(f.files.openByMode(path, "read", file => { published.push(file === null ? 0 : file.slot); })).toBeUndefined();
        expect(published).toEqual([0]);
      }
      expect(() => f.files.current.readSync("/loose.cfg")).toThrow(RangeError);
    } finally { f.close(); }
  });

  test("root cvars redirect new server and product opens while restart replaces only mounted search paths", async () => {
    const f = await copyFixture();
    await writeFile(join(f.homePath, "baseq3", "winner.cfg"), "old home");
    const nextHome = await makeSearchRoot(f.parent, "next-home"), nextBase = await makeSearchRoot(f.parent, "next-base");
    const nextCd = await makeSearchRoot(f.parent, "next-cd");
    await writeFile(join(nextHome, "baseq3", "winner.cfg"), "new home");
    await writeFile(join(nextBase, "baseq3", "base.cfg"), "new base");
    await writeFile(join(nextCd, "baseq3", "cd.cfg"), "new CD");
    await writeFile(join(nextHome, "server.dat"), "server home");
    await f.start();
    try {
      const roots = f.files.roots;
      const oldWriter = f.files.writable.openBinaryWrite("retained.dat");
      if (oldWriter === null) throw new Error("Expected retained writer");
      oldWriter.writeBytes(new TextEncoder().encode("before"));
      const retained = f.files.current.readFileRetainedSync("winner.cfg");
      if (retained === undefined) throw new Error("Expected retained file buffer");
      f.cvars.set("fs_copyfiles", "0", true);
      f.cvars.set("fs_basepath", nextBase, true);
      f.cvars.set("fs_homepath", nextHome, true);
      f.cvars.set("fs_cdpath", nextCd, true);
      expect([roots.dataPath, roots.homePath, roots.cdPath]).toEqual([nextBase, nextHome, nextCd]);
      expect(f.files.current.readFileLength("base.cfg")).toBe(-1);
      expect(readTextSync(f.files.current, "winner.cfg")).toBe("old home");
      const newWriter = f.files.writable.openBinaryWrite("new.dat");
      if (newWriter === null) throw new Error("Expected writer under the selected home root");
      newWriter.writeBytes(new TextEncoder().encode("new")); newWriter.close();
      expect(await Bun.file(join(nextHome, "baseq3", "new.dat")).text()).toBe("new");
      expect(await Bun.file(join(f.homePath, "baseq3", "new.dat")).exists()).toBe(false);
      const server = f.files.server.openRead("server.dat");
      if (server === null) throw new Error("Expected server read under the selected home root");
      expect(server.length).toBe(11); f.files.closeFile(server.file.slot);
      expect(await f.files.conditionalRestart(0, () => {})).toBe(false);
      const previous = f.files.current;
      await f.files.restart({ checksumFeed: 7, random: () => 0.25 }, () => {});
      expect(() => previous.readFileLength("winner.cfg")).toThrow("retired");
      expect(readTextSync(f.files.current, "winner.cfg")).toBe("new home");
      expect(readTextSync(f.files.current, "base.cfg")).toBe("new base");
      expect(readTextSync(f.files.current, "cd.cfg")).toBe("new CD");
      expect(new TextDecoder().decode(retained.bytes)).toBe("old home");
      f.files.current.freeFile(retained);
      oldWriter.writeBytes(new TextEncoder().encode("after")); oldWriter.close();
      expect(await Bun.file(join(f.homePath, "baseq3", "retained.dat")).text()).toBe("beforeafter");
      expect(await Bun.file(join(nextHome, "baseq3", "retained.dat")).exists()).toBe(false);
    } finally { f.close(); }
  });

  test("fs_debug reaches shared, unique, mode and retained reads with live gates and pure filtering", async () => {
    const printed: string[] = [];
    const f = await copyFixture("baseq3", text => { printed.push(text); });
    await writeFile(join(f.homePath, "baseq3", "loose.cfg"), "loose");
    const archive = join(f.homePath, "baseq3", "pak0.pk3");
    await writeFile(archive, storedZip([{ name: "packed.cfg", text: "packed" }]));
    await f.start();
    try {
      expect(f.files.current.readFileLength("packed.cfg")).toBe(6);
      expect(printed).toEqual([]);
      f.cvars.set("fs_debug", "-1");
      expect(f.files.current.has("packed.cfg")).toBe(true);
      expect(f.files.writable.fileExists("loose.cfg")).toBe(true);
      expect(printed).toEqual([]);
      expect(f.files.current.fileLength("packed.cfg")).toBe(6);
      expect(f.files.current.readFileLength("loose.cfg")).toBe(5);
      const retained = f.files.current.readFileRetainedSync("packed.cfg");
      if (retained === undefined) throw new Error("Expected retained packed file");
      f.files.current.freeFile(retained);
      expect(new TextDecoder().decode(await f.files.current.readFileOptional("loose.cfg"))).toBe("loose");
      const unique = f.files.current.openUniqueRead("packed.cfg");
      const mode = f.files.openByMode("/loose.cfg", "read");
      if (unique === undefined || mode === undefined) throw new Error("Expected read handles");
      f.files.closeFile(unique.file.slot); f.files.closeFile(mode.file.slot);
      const packed = `FS_FOpenFileRead: packed.cfg (found in '${archive}')\n`;
      const loose = `FS_FOpenFileRead: loose.cfg (found in '${join(f.homePath, "baseq3")}')\n`;
      expect(printed).toEqual([packed, loose, packed, loose, packed, loose]);
      printed.length = 0;
      expect(f.files.current.fileLength("missing.cfg")).toBe(-1);
      expect(printed).toEqual([]);
      f.cvars.register("developer", "1");
      expect(f.files.current.readFileLength("missing.cfg")).toBe(-1);
      expect(printed.splice(0)).toEqual(["Can't find missing.cfg\n"]);
      await f.files.setServerLoadedPaks("123", "", () => {});
      printed.length = 0;
      expect(f.files.current.fileLength("packed.cfg")).toBe(-1);
      expect(printed.splice(0)).toEqual(["Can't find packed.cfg\n"]);
      f.cvars.set("fs_debug", "0");
      expect(f.files.current.fileLength("loose.cfg")).toBe(5);
      expect(f.files.openByMode("missing.cfg", "read")).toBeUndefined();
      expect(printed).toEqual(["Can't find missing.cfg\n"]);
    } finally { f.close(); }
  });

  test("fs_debug runs after handle publication before loose length and preserves source aborts", async () => {
    let sourcePath = "", selected = 0, action: "resize" | "abort" | "none" = "resize";
    let inspect = (): void => {};
    const f = await copyFixture("baseq3", text => {
      if (!text.startsWith("FS_FOpenFileRead:")) return;
      inspect();
      if (action === "resize") writeFileSync(sourcePath, "resized");
      if (action === "abort") throw new CommonError("drop", "interrupted debug print");
    });
    sourcePath = join(f.homePath, "baseq3", "timing.cfg");
    await writeFile(sourcePath, "old");
    await f.start();
    try {
      f.cvars.set("fs_debug", "1");
      inspect = () => {
        const paths: string[] = [];
        f.files.current.printSearchPath(text => { paths.push(text); });
        expect(paths).toContain(`handle ${selected}: timing.cfg\n`);
      };
      const opened = f.files.openByMode("timing.cfg", "read", file => { selected = file?.slot ?? 0; });
      if (opened === undefined) throw new Error("Expected published handle");
      expect(opened.length).toBe(7);
      f.files.closeFile(opened.file.slot);
      action = "abort";
      expect(() => f.files.openByMode("timing.cfg", "read", file => { selected = file?.slot ?? 0; })).toThrow("interrupted debug print");
      const bytes = new Uint8Array(7);
      expect(f.files.readFile(selected, bytes)).toBe(7);
      expect(new TextDecoder().decode(bytes)).toBe("resized");
      action = "none"; inspect = () => {};
      const next = f.files.current.openUniqueRead("timing.cfg");
      expect(next?.file.slot).toBe(2);
      f.files.closeFile(selected);
      if (next !== undefined) f.files.closeFile(next.file.slot);
    } finally { f.close(); }
  });

  test("fs_debug returns shared archive size after nested diagnostics update current file information", async () => {
    let nested = false, readNested = (): void => {};
    const f = await copyFixture("baseq3", text => {
      if (text.startsWith("FS_FOpenFileRead: outer.cfg") && !nested) {
        nested = true; readNested();
      }
    });
    await writeFile(join(f.homePath, "baseq3", "pak0.pk3"), storedZip([
      { name: "outer.cfg", text: "outer" }, { name: "inner.cfg", text: "inner text" },
    ]));
    await f.start();
    try {
      f.cvars.set("fs_debug", "1");
      readNested = () => { expect(f.files.current.fileLength("inner.cfg")).toBe(10); };
      expect(f.files.current.fileLength("outer.cfg")).toBe(10);
      nested = false;
      readNested = () => {
        const opened = f.files.current.openUniqueRead("inner.cfg");
        if (opened === undefined) throw new Error("Expected unique nested handle");
        f.files.current.closeFile(opened.file);
      };
      expect(f.files.current.fileLength("outer.cfg")).toBe(10);
      nested = false;
      const unique = f.files.current.openUniqueRead("outer.cfg");
      expect(unique?.length).toBe(5);
      if (unique !== undefined) f.files.current.closeFile(unique.file);
    } finally { f.close(); }
  });

  test("fs_debug reaches direct product writers and server read, write and rename operations", async () => {
    const printed: string[] = [];
    const f = await copyFixture("baseq3", text => { printed.push(text); });
    await f.start();
    try {
      f.cvars.set("fs_debug", "1");
      f.files.writable.openWrite("output.cfg", false)?.close();
      f.files.writable.openAppend("output.cfg", false)?.close();
      f.files.writable.openBinaryWrite("demo.dm_68")?.close();
      const mode = f.files.openByMode("sync.log", "append-sync");
      if (mode !== undefined) f.files.closeFile(mode.file.slot);
      expect(printed.splice(0)).toEqual([
        `FS_FOpenFileWrite: ${join(f.homePath, "baseq3", "output.cfg")}\n`,
        `FS_FOpenFileAppend: ${join(f.homePath, "baseq3", "output.cfg")}\n`,
        `FS_FOpenFileWrite: ${join(f.homePath, "baseq3", "demo.dm_68")}\n`,
        `FS_FOpenFileAppend: ${join(f.homePath, "baseq3", "sync.log")}\n`,
      ]);
      expect(f.files.server.openRead("missing.dat")).toBeNull();
      expect(printed.splice(0)).toEqual([
        `FS_SV_FOpenFileRead (fs_homepath): ${join(f.homePath, "missing.dat")}\n`,
        `FS_SV_FOpenFileRead (fs_basepath): ${join(f.dataPath, "missing.dat")}\n`,
        `FS_SV_FOpenFileRead (fs_cdpath) : ${join(f.cdPath, "missing.dat")}\n`,
      ]);
      const writer = f.files.server.openWrite("download.tmp");
      if (writer === null) throw new Error("Expected server writer");
      writer.writeBytes(new TextEncoder().encode("server")); writer.close();
      f.files.server.renameNoReplace("download.tmp", "download.pk3");
      const server = f.files.server.openRead("download.pk3");
      if (server === null) throw new Error("Expected renamed server file");
      expect(server.length).toBe(6); f.files.closeFile(server.file.slot);
      expect(printed).toEqual([
        `FS_SV_FOpenFileWrite: ${join(f.homePath, "download.tmp")}\n`,
        `FS_SV_Rename: ${join(f.homePath, "download.tmp")} --> ${join(f.homePath, "download.pk3")}\n`,
        `FS_SV_FOpenFileRead (fs_homepath): ${join(f.homePath, "download.pk3")}\n`,
      ]);
    } finally { f.close(); }
  });

  test("fs_copyfiles copies selected CD loose files at open into their own game directory", async () => {
    const printed: string[] = [];
    const f = await copyFixture("missionpack", text => { printed.push(text); });
    await mkdir(join(f.cdPath, "missionpack", "Config"));
    await writeFile(join(f.cdPath, "missionpack", "Config", "Mixed.cfg"), "mission");
    await writeFile(join(f.cdPath, "baseq3", "fallback.cfg"), "base");
    await f.start();
    try {
      f.cvars.set("fs_debug", "1");
      expect(f.files.current.has("Config/Mixed.cfg")).toBe(true);
      expect(await Bun.file(join(f.dataPath, "missionpack", "Config", "Mixed.cfg")).exists()).toBe(false);
      expect(printed).toEqual([]);
      const opened = f.files.openByMode("Config\\Mixed.cfg", "read");
      if (opened === undefined) throw new Error("Expected CD source open");
      expect(opened.length).toBe(7);
      expect(await Bun.file(join(f.dataPath, "missionpack", "Config", "Mixed.cfg")).text()).toBe("mission");
      const bytes = new Uint8Array(7);
      expect(f.files.readFile(opened.file.slot, bytes)).toBe(7);
      expect(new TextDecoder().decode(bytes)).toBe("mission");
      f.files.closeFile(opened.file.slot);
      expect(f.files.current.fileLength("fallback.cfg")).toBe(4);
      expect(await Bun.file(join(f.dataPath, "baseq3", "fallback.cfg")).text()).toBe("base");
      expect(await Bun.file(join(f.homePath, "missionpack", "Config", "Mixed.cfg")).exists()).toBe(false);
      expect(printed).toEqual([
        `FS_FOpenFileRead: Config\\Mixed.cfg (found in '${join(f.cdPath, "missionpack")}')\n`,
        `copy ${join(f.cdPath, "missionpack", "Config", "Mixed.cfg")} to ${join(f.dataPath, "missionpack", "Config", "Mixed.cfg")}\n`,
        `FS_FOpenFileRead: fallback.cfg (found in '${join(f.cdPath, "baseq3")}')\n`,
        `copy ${join(f.cdPath, "baseq3", "fallback.cfg")} to ${join(f.dataPath, "baseq3", "fallback.cfg")}\n`,
      ]);
    } finally { f.close(); }
  });

  test("fs_copyfiles preserves precedence and excludes packed, pure-denied, disabled and journal reads", async () => {
    const printed: string[] = [];
    const f = await copyFixture("baseq3", text => { printed.push(text); });
    for (const name of ["home.cfg", "base.cfg", "disabled.cfg", "denied.txt", "journal.dat", "journaldata.dat.bak", "empty.cfg"]) {
      await writeFile(join(f.cdPath, "baseq3", name), name === "empty.cfg" ? "" : "cd");
    }
    await writeFile(join(f.homePath, "baseq3", "home.cfg"), "home");
    await writeFile(join(f.dataPath, "baseq3", "base.cfg"), "base");
    await writeFile(join(f.cdPath, "baseq3", "pak0.pk3"), storedZip([{ name: "packed.cfg", text: "pack" }]));
    await f.start();
    try {
      expect(f.files.current.readSync("home.cfg")).toEqual(new TextEncoder().encode("home"));
      expect(f.files.current.fileLength("base.cfg")).toBe(4);
      expect(f.files.current.fileLength("packed.cfg")).toBe(4);
      f.cvars.set("fs_copyfiles", "0", true);
      expect(f.files.current.fileLength("disabled.cfg")).toBe(2);
      f.cvars.set("fs_copyfiles", "-1", true);
      await f.files.setServerLoadedPaks("123", "", () => {});
      expect(f.files.current.fileLength("denied.txt")).toBe(-1);
      expect(printed).toEqual([]);
      for (const name of ["journal.dat", "journaldata.dat.bak"]) {
        // The .bak suffix is denied while pure, so clear the pure filter before this open.
        await f.files.setServerLoadedPaks("", "", () => {});
        expect(f.files.current.fileLength(name)).toBe(2);
        expect(await Bun.file(join(f.dataPath, "baseq3", name)).exists()).toBe(false);
      }
      expect(printed.filter(text => text === "Ignoring journal files\n")).toHaveLength(2);
      expect(f.files.current.fileLength("empty.cfg")).toBe(0);
      expect(await Bun.file(join(f.dataPath, "baseq3", "empty.cfg")).exists()).toBe(true);
      for (const name of ["home.cfg", "packed.cfg", "disabled.cfg", "denied.txt"]) {
        expect(await Bun.file(join(f.dataPath, "baseq3", name)).exists()).toBe(false);
      }
    } finally { f.close(); }
  });

  test("fs_copyfiles reopens after its diagnostic while preserving the original common read handle", async () => {
    let sourcePath = "";
    const f = await copyFixture("baseq3", text => {
      if (!text.startsWith("copy ")) return;
      renameSync(sourcePath, `${sourcePath}.original`);
      writeFileSync(sourcePath, "replacement");
    });
    sourcePath = join(f.cdPath, "baseq3", "timing.cfg");
    await writeFile(sourcePath, "old");
    await f.start();
    try {
      const opened = f.files.openByMode("timing.cfg", "read");
      if (opened === undefined) throw new Error("Expected original source handle");
      expect(opened.file.slot).toBe(1);
      expect(opened.length).toBe(3);
      expect(await Bun.file(join(f.dataPath, "baseq3", "timing.cfg")).text()).toBe("replacement");
      const bytes = new Uint8Array(3);
      expect(f.files.readFile(opened.file.slot, bytes)).toBe(3);
      expect(new TextDecoder().decode(bytes)).toBe("old");
      f.files.closeFile(opened.file.slot);
    } finally { f.close(); }
  });

  test("fs_copyfiles samples live roots, overwrites its base destination and consumes no extra common slots", async () => {
    const f = await copyFixture();
    await writeFile(join(f.cdPath, "baseq3", "slots.cfg"), "copy");
    await f.start();
    try {
      const destination = join(f.parent, "new-base");
      f.cvars.set("fs_basepath", destination, true);
      f.cvars.set("fs_cdpath", f.homePath, true);
      expect(f.files.current.fileLength("slots.cfg")).toBe(4);
      expect(await Bun.file(join(destination, "baseq3", "slots.cfg")).exists()).toBe(false);
      f.cvars.set("fs_cdpath", f.cdPath.toUpperCase(), true);
      for (let slot = 1; slot <= 63; slot++) {
        const opened = f.files.openByMode("slots.cfg", "read");
        if (opened === undefined) throw new Error("Expected available common slot");
        expect(opened.file.slot).toBe(slot);
        expect(opened.length).toBe(4);
      }
      expect(await Bun.file(join(destination, "baseq3", "slots.cfg")).text()).toBe("copy");
      expect(await Bun.file(join(f.dataPath, "baseq3", "slots.cfg")).exists()).toBe(false);
      for (let slot = 1; slot <= 63; slot++) f.files.closeFile(slot);
      await writeFile(join(destination, "baseq3", "slots.cfg"), "longer old value");
      expect(f.files.current.fileLength("slots.cfg")).toBe(4);
      expect(await Bun.file(join(destination, "baseq3", "slots.cfg")).text()).toBe("copy");
    } finally { f.close(); }
  });

  test("fs_copyfiles finishes the source read before truncating an identical base and CD destination", async () => {
    const f = await copyFixture();
    await writeFile(join(f.cdPath, "baseq3", "same.cfg"), "retained source bytes");
    await f.start();
    try {
      f.cvars.set("fs_basepath", f.cdPath, true);
      expect(new TextDecoder().decode(f.files.current.readSync("same.cfg"))).toBe("retained source bytes");
      expect(await Bun.file(join(f.cdPath, "baseq3", "same.cfg")).text()).toBe("retained source bytes");
    } finally { f.close(); }
  });

  test("fs_copyfiles source reopen failure retains the already-open caller descriptor", async () => {
    let sourcePath = "";
    const f = await copyFixture("baseq3", text => {
      if (text.startsWith("copy ")) renameSync(sourcePath, `${sourcePath}.original`);
    });
    sourcePath = join(f.cdPath, "baseq3", "removed.cfg");
    await writeFile(sourcePath, "opened");
    await f.start();
    try {
      expect(new TextDecoder().decode(f.files.current.readSync("removed.cfg"))).toBe("opened");
      expect(await Bun.file(join(f.dataPath, "baseq3", "removed.cfg")).exists()).toBe(false);
    } finally { f.close(); }
  });

  test("fs_copyfiles returns the original read when destination acquisition fails and rejects symlink escape", async () => {
    const f = await copyFixture();
    await mkdir(join(f.cdPath, "baseq3", "nested"));
    await writeFile(join(f.cdPath, "baseq3", "nested", "safe.cfg"), "source");
    await f.start();
    try {
      await writeFile(join(f.dataPath, "baseq3", "nested"), "not a directory");
      expect(f.files.current.fileLength("nested/safe.cfg")).toBe(6);
      await rm(join(f.dataPath, "baseq3", "nested"));
      const outside = join(f.parent, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "safe.cfg"), "untouched");
      await symlink(outside, join(f.dataPath, "baseq3", "nested"));
      expect(() => f.files.current.fileLength("nested/safe.cfg")).toThrow("symbolic link");
      expect(await Bun.file(join(outside, "safe.cfg")).text()).toBe("untouched");
      await rm(join(f.dataPath, "baseq3", "nested"));
      const opened = f.files.openByMode("nested/safe.cfg", "read");
      if (opened === undefined) throw new Error("Expected cleanup to release failed source handle");
      expect(opened.file.slot).toBe(1);
      f.files.closeFile(opened.file.slot);
    } finally { f.close(); }
  });

  test("empty roots preserve the distinct baseq3 and additional-game home mount predicates", async () => {
    const parent = await mkdtemp(join(tmpdir(), "quake3-vfs-empty-roots-"));
    temporaryDirectories.push(parent);
    const homePath = await makeSearchRoot(parent, "home");
    await writeFile(join(homePath, "baseq3", "base.cfg"), "base home");
    await writeFile(join(homePath, "missionpack", "mod.cfg"), "mod home");
    using homeOnly = await VirtualFileSystem.openInspection({ dataPath: "", homePath, cdPath: "", product: "missionpack" });
    using empty = await VirtualFileSystem.openInspection({ dataPath: "", homePath, cdPath: null, product: "baseq3" });
    using cdOnly = await VirtualFileSystem.openInspection({ dataPath: "", homePath: "", cdPath: homePath, product: "baseq3" });
    try {
      expect(homeOnly.initialized).toBe(true);
      expect(homeOnly.fileLength("base.cfg")).toBe(-1);
      expect(readTextSync(homeOnly, "mod.cfg")).toBe("mod home");
      expect(empty.initialized).toBe(false);
      const printed: string[] = [];
      empty.printSearchPath(text => { printed.push(text); });
      expect(printed).toEqual(["Current search path:\n", "\n"]);
      expect(() => empty.fileLength("base.cfg")).toThrow("Filesystem call made without initialization");
      expect(readTextSync(cdOnly, "base.cfg")).toBe("base home");
    } finally { homeOnly.close(); empty.close(); cdOnly.close(); }
  });

  test("an empty home reached by the baseq3 mount builds an absolute root rather than cwd", async () => {
    const dataPath = await makeDataTree();
    using files = await VirtualFileSystem.openInspection({ dataPath, homePath: "", cdPath: null, product: "baseq3" });
    try {
      const printed: string[] = [];
      files.printSearchPath(text => { printed.push(text); });
      expect(printed[1]).toBe("/baseq3\n");
      expect(printed).toContain(`${join(dataPath, "baseq3")}\n`);
    } finally { files.close(); }
  });

  test("rejects NUL in filesystem roots", async () => {
    const path = await makeDataTree();
    await expect(VirtualFileSystem.openInspection({ dataPath: "bad\0base", homePath: path, cdPath: null, product: "baseq3" }))
      .rejects.toThrow("Base path contains NUL");
    await expect(VirtualFileSystem.openInspection({ dataPath: path, homePath: "bad\0home", cdPath: null, product: "baseq3" }))
      .rejects.toThrow("Home path contains NUL");
    await expect(VirtualFileSystem.openInspection({ dataPath: path, homePath: path, cdPath: "bad\0cd", product: "baseq3" }))
      .rejects.toThrow("CD path contains NUL");
  });

  test("restart retains the reached search paths and pack owner after a later mount failure", async () => {
    const f = await copyFixture("missionpack");
    const previousPath = join(f.homePath, "missionpack", "pak0.pk3");
    const firstPath = join(f.cdPath, "baseq3", "pak0.pk3");
    const failedPath = join(f.cdPath, "baseq3", "pak1.pk3");
    await writeFile(previousPath, storedZip([{ name: "old.dat", text: "previous" }]));
    await f.files.initialize({ checksumFeed: 0, random: () => 1 }, () => {});
    try {
      const previous = f.files.current;
      previous.pakReferences.recordLooseOpen("previous.wav");
      const oldFile = f.files.openByMode("old.dat", "read");
      if (oldFile === undefined) throw new Error("Expected previous mounted entry");
      expect(f.files.writable.rootPath).toBe(join(f.homePath, "missionpack"));
      await writeFile(firstPath, storedZip([{ name: "reached.dat", text: "reached" }]));
      const invalid = storedZip([{ name: "failed.dat", text: "not mounted" }]);
      const invalidView = new DataView(invalid.buffer);
      invalidView.setUint32(invalidView.getUint32(invalid.byteLength - 6, true), 0, true);
      await writeFile(failedPath, invalid);
      await writeFile(join(f.cdPath, "baseq3", "loose.cfg"), "reached loose");
      await writeFile(join(f.dataPath, "baseq3", "later.cfg"), "not mounted");
      f.cvars.set("fs_game", "newmod", true);
      await expect(f.files.restart({ checksumFeed: 1, random: () => 0 }, () => {})).rejects.toThrow("central directory signature");
      expect(f.files.writable.rootPath).toBe(join(f.homePath, "baseq3"));
      expect(f.files.initialized).toBe(true);
      expect(() => previous.has("old.dat")).toThrow("retired");
      expect(() => f.files.readFile(oldFile.file.slot, new Uint8Array(1))).toThrow("FS_FileForHandle: NULL");
      expect(descriptorCount(previousPath)).toBe(0);
      expect(descriptorCount(firstPath)).toBe(1);
      expect(descriptorCount(failedPath)).toBe(0);
      const current = f.files.current;
      expect(current.pakReferences.snapshot().map(row => [row.pack.basename, row.flags])).toEqual([["pak0", 0]]);
      expect(current.pakReferences.checksumFeed).toBe(1);
      expect(current.pakReferences.referencedPakPureChecksums()).toBe("1 1 @ 1 1");
      expect(readTextSync(current, "reached.dat")).toBe("reached");
      expect(readTextSync(current, "loose.cfg")).toBe("reached loose");
      expect(current.has("later.cfg")).toBe(false);
      expect(current.has("old.dat")).toBe(false);
      expect(f.cvars.get("fs_game")?.modified).toBe(true);
      const printed: string[] = [];
      current.printSearchPath(text => { printed.push(text); });
      expect(printed).toEqual(["Current search path:\n", `${firstPath} (1 files)\n`, `${join(f.cdPath, "baseq3")}\n`, "\n"]);
    } finally { f.close(); }
    expect(descriptorCount(firstPath)).toBe(0);
  });

  test("initialization publishes the first loose path before yielding and close prevents later pack adoption", async () => {
    const f = await copyFixture();
    const archivePath = join(f.cdPath, "baseq3", "pak0.pk3");
    await writeFile(archivePath, storedZip([{ name: "packed.cfg", text: "not adopted" }]));
    await writeFile(join(f.cdPath, "baseq3", "loose.cfg"), "available");
    const pending = f.files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
    try {
      expect(f.files.initialized).toBe(true);
      const reached = f.files.current;
      expect(reached.has("loose.cfg")).toBe(true);
      expect(reached.has("packed.cfg")).toBe(false);
      expect(reached.pakReferences.snapshot()).toEqual([]);
      f.close();
      await expect(pending).rejects.toThrow("retired");
      expect(() => reached.has("loose.cfg")).toThrow("retired");
      expect(descriptorCount(archivePath)).toBe(0);
    } finally { f.close(); }
  });

  test("a post-startup abort retains the new owner and reached pure reorder before clearing fs_game", async () => {
    const f = await copyFixture();
    const lowPath = join(f.cdPath, "baseq3", "pak-low.pk3");
    const highPath = join(f.homePath, "baseq3", "pak-high.pk3");
    await writeFile(lowPath, storedZip([{ name: "entry.cfg", text: "low" }]));
    await writeFile(highPath, storedZip([{ name: "entry.cfg", text: "high" }]));
    await f.start();
    try {
      const previous = f.files.current;
      const low = previous.pakReferences.snapshot().find(row => row.pack.basename === "pak-low")?.pack;
      if (low === undefined) throw new Error("Expected the actual low-priority pack");
      await f.files.setServerLoadedPaks(String(low.checksum | 0), "pak-low", () => {});
      f.cvars.set("fs_game", "authoredmod", true);
      const failure = new CommonError("drop", "post-startup guard stopped");
      let checks = 0;
      await expect(f.files.restart({ checksumFeed: 3, random: () => 0 }, () => {
        if (++checks === 3) throw failure;
      })).rejects.toBe(failure);
      const reached = f.files.current;
      expect(reached).not.toBe(previous);
      expect(() => previous.has("entry.cfg")).toThrow("retired");
      expect(reached.pakReferences.loadedPakNames()).toBe("pak-low pak-high");
      expect(reached.pureReordered).toBe(true);
      expect(f.cvars.get("fs_game")?.modified).toBe(true);
      expect(descriptorCount(lowPath)).toBe(1);
      expect(descriptorCount(highPath)).toBe(1);
      await f.files.setServerLoadedPaks("", "", () => {});
      expect(f.files.current).not.toBe(reached);
      expect(f.files.current.pakReferences.loadedPakNames()).toBe("pak-high pak-low");
      expect(readTextSync(f.files.current, "entry.cfg")).toBe("high");
    } finally { f.close(); }
  });

  test("startup callbacks observe the reached owner and pure reorder retains pack identities and references", async () => {
    const parent = await mkdtemp(join(tmpdir(), "quake3-vfs-incremental-order-"));
    temporaryDirectories.push(parent);
    const cdPath = await makeSearchRoot(parent, "cd"), dataPath = await makeSearchRoot(parent, "base");
    const homePath = await makeSearchRoot(parent, "home");
    const firstPath = join(cdPath, "baseq3", "pak-a.pk3");
    await writeFile(firstPath, storedZip([{ name: "vm/cgame.qvm", text: "first" }]));
    await writeFile(join(dataPath, "baseq3", "pak-b.pk3"), storedZip([{ name: "base.cfg", text: "second" }]));
    await writeFile(join(homePath, "missionpack", "pak-c.pk3"), storedZip([{ name: "mod.cfg", text: "third" }]));
    let checksum: number;
    {
      using archive = await Pk3Archive.open(firstPath);
      checksum = archive.checksum;
    }
    const serverPaks = new ServerPakSet();
    serverPaks.setChecksums(String(checksum | 0));
    let owner: TrackedVirtualFileSystem | null = null;
    let reachedPack: PakCatalogEntry | null = null;
    const prefixes: string[][] = [];
    using files = VirtualFileSystem.createTracked({ dataPath, homePath, cdPath, product: "missionpack", serverPaks,
      references: { checksumFeed: 7, random: () => 0 }, mountGameDirectory: game => {
        if (owner === null) throw new Error("Expected the actual startup owner");
        prefixes.push(owner.pakReferences.snapshot().map(row => row.pack.basename));
        if (game !== "missionpack" || reachedPack !== null) return;
        expect(owner.initialized).toBe(true);
        expect(owner.has("mod.cfg")).toBe(false);
        expect(readTextSync(owner, "vm/cgame.qvm")).toBe("first");
        const pack = owner.pakReferences.snapshot().find(row => row.pack.basename === "pak-a")?.pack;
        if (pack === undefined) throw new Error("Expected already published packed reference");
        reachedPack = pack;
      } });
    owner = files;
    expect(files.initialized).toBe(false);
    await files.startup();
    expect(prefixes).toEqual([[], ["pak-a"], ["pak-b", "pak-a"], ["pak-b", "pak-a"], ["pak-b", "pak-a"], ["pak-b", "pak-a"]]);
    const records = files.pakReferences.snapshot();
    expect(records.map(row => row.pack.basename)).toEqual(["pak-a", "pak-c", "pak-b"]);
    expect(reachedPack !== null && records[0]?.pack === reachedPack).toBe(true);
    expect(records[0]?.flags).toBe(PakReferenceFlag.General | PakReferenceFlag.Cgame);
    expect(files.pureReordered).toBe(true);
    expect(files.pakReferences.loadedPakNames()).toBe("pak-a pak-c pak-b");
    expect(descriptorCount(firstPath)).toBe(1);
  });

  test("a startup callback failure retains prior paths without publishing the next directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "quake3-vfs-incremental-callback-"));
    temporaryDirectories.push(parent);
    const cdPath = await makeSearchRoot(parent, "cd"), dataPath = await makeSearchRoot(parent, "base");
    const archivePath = join(cdPath, "baseq3", "pak0.pk3");
    await writeFile(archivePath, storedZip([{ name: "entry.cfg", text: "reached" }]));
    await writeFile(join(dataPath, "baseq3", "later.cfg"), "not reached");
    const failure = new CommonError("drop", "stop at next fs_gamedir");
    let directories = 0;
    using files = VirtualFileSystem.createTracked({ dataPath, homePath: dataPath, cdPath, product: "baseq3",
      references: { checksumFeed: 0, random: () => 0 }, mountGameDirectory: () => {
        if (++directories === 2) throw failure;
      } });
    await expect(files.startup()).rejects.toBe(failure);
    expect(readTextSync(files, "entry.cfg")).toBe("reached");
    expect(files.has("later.cfg")).toBe(false);
    expect(files.pakReferences.loadedPakNames()).toBe("pak0");
    expect(files.pureReordered).toBe(false);
    expect(descriptorCount(archivePath)).toBe(1);
    const printed: string[] = [];
    files.printSearchPath(text => { printed.push(text); });
    expect(printed).toEqual(["Current search path:\n", `${archivePath} (1 files)\n`, `${join(cdPath, "baseq3")}\n`, "\n"]);
  });

  test("builds the source home, base, CD and game-directory priority chain", async () => {
    const parent = await mkdtemp(join(tmpdir(), "quake3-vfs-roots-"));
    temporaryDirectories.push(parent);
    const cdPath = await makeSearchRoot(parent, "cd");
    const dataPath = await makeSearchRoot(parent, "base");
    const homePath = await makeSearchRoot(parent, "home");

    await writeFile(join(homePath, "baseq3", "game-order.txt"), "home baseq3");
    await writeFile(join(cdPath, "missionpack", "game-order.txt"), "cd missionpack");
    await writeFile(join(homePath, "missionpack", "root-order.txt"), "home missionpack loose");
    await writeFile(join(dataPath, "missionpack", "base-cd-order.txt"), "base missionpack loose");
    await writeFile(join(cdPath, "missionpack", "pak8.pk3"), storedZip([
      { name: "base-cd-order.txt", text: "cd missionpack packed" },
    ]));
    await writeFile(join(dataPath, "missionpack", "pak9.pk3"), storedZip([
      { name: "root-order.txt", text: "base missionpack packed" },
    ]));
    await writeFile(join(homePath, "missionpack", "pack-order.txt"), "home missionpack loose");
    await writeFile(join(homePath, "missionpack", "pak1.pk3"), storedZip([
      { name: "pack-order.txt", text: "home missionpack pak1" },
    ]));
    await writeFile(join(homePath, "missionpack", "pak2.pk3"), storedZip([
      { name: "pack-order.txt", text: "home missionpack pak2" },
    ]));

    using vfs = await VirtualFileSystem.openInspection({ dataPath, homePath, cdPath, product: "missionpack" });

    expect(readTextSync(vfs, "game-order.txt")).toBe("cd missionpack");
    expect(readTextSync(vfs, "root-order.txt")).toBe("home missionpack loose");
    expect(readTextSync(vfs, "base-cd-order.txt")).toBe("base missionpack loose");
    expect(readTextSync(vfs, "pack-order.txt")).toBe("home missionpack pak2");
    expect(vfs.source("root-order.txt")).toEqual({
      kind: "loose",
      game: "missionpack",
      path: "root-order.txt",
      filePath: join(homePath, "missionpack", "root-order.txt"),
    });
  });

  test.skipIf(process.platform !== "linux")("falls through a loose file that cannot be opened", async () => {
    const tree = await makeLooseFallbackTree();
    let randomCalls = 0;
    using vfs = await VirtualFileSystem.openTracked({
      dataPath: tree.dataPath,
      homePath: tree.homePath,
      cdPath: null,
      product: "baseq3",
      references: {
        checksumFeed: 0,
        random: () => {
          randomCalls++;
          return 0;
        },
      },
    });
    await chmod(tree.homeFile, 0);
    try {
      expect(vfs.has("x.dat")).toBe(true);
      expect(vfs.source("x.dat")).toEqual({
        kind: "loose",
        game: "baseq3",
        path: "x.dat",
        filePath: join(tree.dataPath, "baseq3", "x.dat"),
      });
      expect(vfs.list()).toContain("x.dat");
      expect(randomCalls).toBe(0);
      expect(vfs.fileLength("x.dat")).toBe(13);
      expect(randomCalls).toBe(0);
      expect(await readText(vfs, "x.dat")).toBe("lower-content");
      expect(readTextSync(vfs, "x.dat")).toBe("lower-content");
      expect(randomCalls).toBe(0);
    } finally {
      await chmod(tree.homeFile, 0o600);
    }
  });

  test.skipIf(process.platform !== "linux")("falls through a loose directory that becomes inaccessible", async () => {
    const tree = await makeLooseFallbackTree();
    using vfs = await VirtualFileSystem.openInspection({
      dataPath: tree.dataPath,
      homePath: tree.homePath,
      cdPath: null,
      product: "baseq3",
    });
    await chmod(tree.homeDirectory, 0);
    try {
      expect(vfs.has("x.dat")).toBe(true);
      const source = vfs.source("x.dat");
      expect(source?.kind).toBe("loose");
      expect(source?.kind === "loose" ? source.filePath : undefined)
        .toBe(join(tree.dataPath, "baseq3", "x.dat"));
      expect(vfs.fileLength("x.dat")).toBe(13);
      expect(await readText(vfs, "x.dat")).toBe("lower-content");
      expect(readTextSync(vfs, "x.dat")).toBe("lower-content");
      expect(vfs.list()).toContain("x.dat");
    } finally {
      await chmod(tree.homeDirectory, 0o700);
    }
  });

  test.skipIf(process.platform !== "linux")("mounts lower roots when a higher game directory is inaccessible", async () => {
    const tree = await makeLooseFallbackTree();
    await chmod(tree.homeDirectory, 0);
    try {
      using vfs = await VirtualFileSystem.openInspection({
        dataPath: tree.dataPath,
        homePath: tree.homePath,
        cdPath: null,
        product: "baseq3",
      });
      expect(await readText(vfs, "x.dat")).toBe("lower-content");
      const source = vfs.source("x.dat");
      expect(source?.kind === "loose" ? source.filePath : undefined)
        .toBe(join(tree.dataPath, "baseq3", "x.dat"));
    } finally {
      await chmod(tree.homeDirectory, 0o700);
    }
  });

  test.skipIf(process.platform !== "linux")("skips an inaccessible PK3 while retaining its loose directory", async () => {
    const tree = await makeLooseFallbackTree();
    const archivePath = join(tree.homeDirectory, "pak0.pk3");
    await rm(tree.homeFile);
    await writeFile(archivePath, storedZip([]));
    await chmod(archivePath, 0);
    try {
      using vfs = await VirtualFileSystem.openInspection({
        dataPath: tree.dataPath,
        homePath: tree.homePath,
        cdPath: null,
        product: "baseq3",
      });
      expect(await readText(vfs, "x.dat")).toBe("lower-content");
      expect(vfs.list()).toContain("x.dat");
    } finally {
      await chmod(archivePath, 0o600);
    }
  });

  test("keeps opened malformed PK3 central records fatal", async () => {
    const root = await mkdtemp(join(tmpdir(), "quake3-vfs-malformed-pack-"));
    temporaryDirectories.push(root);
    const directory = join(root, "baseq3");
    await mkdir(directory, { recursive: true });
    const bytes = storedZip([{ name: "entry.cfg", text: "invalid central record" }]);
    const view = new DataView(bytes.buffer);
    view.setUint32(view.getUint32(bytes.byteLength - 6, true), 0, true);
    await writeFile(join(directory, "pak0.pk3"), bytes);

    await expect(VirtualFileSystem.openInspection(searchOptions(root, "baseq3")))
      .rejects.toThrow("central directory signature");
  });

  test.skipIf(process.platform !== "linux")("preserves source case-insensitive duplicate-root suppression", async () => {
    const parent = await mkdtemp(join(tmpdir(), "quake3-vfs-root-case-"));
    temporaryDirectories.push(parent);
    const dataPath = await makeSearchRoot(parent, "Install");
    const homePath = await makeSearchRoot(parent, "install");
    await writeFile(join(dataPath, "baseq3", "winner.txt"), "base path");
    await writeFile(join(homePath, "baseq3", "winner.txt"), "home path");

    using vfs = await VirtualFileSystem.openInspection({ dataPath, homePath, cdPath: null, product: "baseq3" });

    expect(readTextSync(vfs, "winner.txt")).toBe("base path");
    expect(vfs.source("winner.txt")).toEqual({
      kind: "loose",
      game: "baseq3",
      path: "winner.txt",
      filePath: join(dataPath, "baseq3", "winner.txt"),
    });
  });

  test("caps each game directory at the source 1024 PK3 limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "quake3-vfs-pack-cap-"));
    temporaryDirectories.push(root);
    const directory = join(root, "baseq3");
    await mkdir(directory, { recursive: true });
    const emptyArchive = storedZip([]);
    for (let index = 0; index < 1_025; index++) {
      await writeFile(join(directory, `pak${String(index).padStart(4, "0")}.pk3`), emptyArchive);
    }

    using vfs = await VirtualFileSystem.openTracked({
      ...searchOptions(root, "baseq3"),
      references: { checksumFeed: 0, random: () => 0 },
    });

    expect(vfs.pakReferences.snapshot()).toHaveLength(1_024);
  });

  test("gives later PK3 names priority over earlier packs and loose files", async () => {
    const root = await makeDataTree();
    using vfs = await VirtualFileSystem.openInspection(searchOptions(root, "baseq3"));
    expect(await readText(vfs, "SCRIPTS\\SHARED.CFG")).toBe("base pak2");
    expect(readTextSync(vfs, "SCRIPTS\\SHARED.CFG")).toBe("base pak2");
    expect(await readText(vfs, "loose-only.txt")).toBe("base loose only");
    expect(readTextSync(vfs, "loose-only.txt")).toBe("base loose only");
    expect(vfs.source("scripts/shared.cfg")).toEqual({
      kind: "pk3",
      game: "baseq3",
      path: "scripts/shared.cfg",
      archivePath: join(root, "baseq3", "pak2.pk3"),
    });
  });

  test("puts the missionpack search chain above baseq3", async () => {
    const root = await makeDataTree();
    using vfs = await VirtualFileSystem.openInspection(searchOptions(root, "missionpack"));
    expect(await readText(vfs, "scripts/shared.cfg")).toBe("mission pak0");
    expect(await readText(vfs, "base-pack.txt")).toBe("base pack");
    expect(await readText(vfs, "mission-only.txt")).toBe("mission loose only");
    expect(vfs.source("mission-only.txt")).toEqual({
      kind: "loose",
      game: "missionpack",
      path: "mission-only.txt",
      filePath: join(root, "missionpack", "mission-only.txt"),
    });
  });

  test("lists normalized unique paths and rejects unsafe lookups", async () => {
    const root = await makeDataTree();
    using vfs = await VirtualFileSystem.openInspection(searchOptions(root, "missionpack"));
    expect(vfs.has("MISSION-PACK.TXT")).toBe(true);
    expect(vfs.list("scripts/")).toEqual(["scripts/shared.cfg"]);
    expect(vfs.list()).toContain("base-pack.txt");
    expect(vfs.list()).toContain("mission-pack.txt");
    expect(() => vfs.has("../outside")).toThrow(RangeError);
    await expect(vfs.read("/absolute")).rejects.toThrow(RangeError);
    expect(() => vfs.readSync("/absolute")).toThrow(RangeError);
    await expect(vfs.read("missing.txt")).rejects.toThrow("Asset not found");
    expect(() => vfs.readSync("missing.txt")).toThrow("Asset not found");
  });

  test("reads a loose file above 128 MiB through the configured source hunk", async () => {
    const root = await makeDataTree();
    const path = join(root, "baseq3", "large.dat"), length = 128 * 1024 * 1024 + 1;
    await writeFile(path, new Uint8Array([1]));
    const hunk = new HunkArena(length + 31, () => {});
    const memory = new ReadFileMemory(() => hunk);
    using vfs = await VirtualFileSystem.openTracked({ ...searchOptions(root, "baseq3"),
      references: { checksumFeed: 0, random: () => 0 }, fileMemory: memory });
    await truncate(path, length);
    const retained = vfs.readFileRetainedSync("large.dat");
    if (retained === undefined) throw new Error("Expected retained large file");
    expect(retained.length).toBe(length);
    expect(retained.bytes[0]).toBe(1);
    expect(retained.bytes[length - 1]).toBe(0);
    expect(retained.terminatedBytes[length]).toBe(0);
    expect(memory.loadCount).toBe(1);
    expect(memory.loadStack).toBe(1);
    expect(descriptorCount(path)).toBe(0);
    vfs.freeFile(retained);
    expect(memory.loadStack).toBe(0);
    expect(hunk.snapshot().high.temp).toBe(0);
  });

  test("detached reads observe loose files grown above 128 MiB after mounting", async () => {
    const root = await makeDataTree();
    const path = join(root, "baseq3", "large.dat"), length = 128 * 1024 * 1024 + 1;
    await writeFile(path, new Uint8Array([1]));
    using vfs = await VirtualFileSystem.openInspection(searchOptions(root, "baseq3"));
    await truncate(path, length);
    const bytes = vfs.readSync("large.dat");
    expect(bytes.length).toBe(length);
    expect(bytes[0]).toBe(1);
    expect(bytes[length - 1]).toBe(0);
    expect(descriptorCount(path)).toBe(0);
  });

  test("large loose and packed reads reach hunk failure after source counters and handle selection", async () => {
    const root = await makeDataTree();
    const length = 128 * 1024 * 1024 + 1;
    const path = join(root, "baseq3", "large.dat");
    await writeFile(path, new Uint8Array());
    await truncate(path, length);
    const zip = storedZip([{ name: "packed.dat", text: "" }]);
    const view = new DataView(zip.buffer), central = view.getUint32(zip.length - 6, true);
    // Independently calculated CRC32 for 134217729 zero bytes.
    view.setUint32(14, 0xceeeebae, true); view.setUint32(central + 16, 0xceeeebae, true);
    view.setUint32(18, length, true); view.setUint32(22, length, true);
    view.setUint32(central + 20, length, true); view.setUint32(central + 24, length, true);
    view.setUint32(zip.length - 6, central + length, true);
    const packedPath = join(root, "baseq3", "large.pk3");
    const packed = await openFile(packedPath, "w");
    try {
      await packed.write(zip.subarray(0, central), 0, central, 0);
      await packed.write(zip.subarray(central), 0, zip.length - central, central + length);
    } finally { await packed.close(); }
    const hunk = new HunkArena(1024, () => {}), memory = new ReadFileMemory(() => hunk);
    using vfs = await VirtualFileSystem.openTracked({ ...searchOptions(root, "baseq3"),
      references: { checksumFeed: 0, random: () => 0 }, fileMemory: memory });
    for (const name of ["large.dat", "packed.dat"]) {
      expect(vfs.fileLength(name)).toBe(length);
      expect(() => vfs.readFileRetainedSync(name)).toThrow("Hunk_AllocateTempMemory: failed on 134217740");
    }
    expect(memory.loadCount).toBe(2);
    expect(memory.loadStack).toBe(2);
    expect(descriptorCount(path)).toBe(1);
    const next = vfs.openUniqueRead("large.dat");
    if (next === undefined) throw new Error("Expected source handle after allocation failures");
    expect(next.file.slot).toBe(3);
    vfs.closeFile(next.file);
    expect(hunk.snapshot().high.temp).toBe(0);
  });

  test("whole loose reads reject unrepresentable signed sizes before allocating payload", async () => {
    const root = await makeDataTree(), path = join(root, "baseq3", "signed.dat");
    await writeFile(path, new Uint8Array());
    await truncate(path, 0x80000000);
    using vfs = await VirtualFileSystem.openInspection(searchOptions(root, "baseq3"));
    expect(() => vfs.readSync("signed.dat")).toThrow("source signed 32-bit return boundary");
    expect(descriptorCount(path)).toBe(0);
    expect(() => vfs.readFileRetainedSync("signed.dat")).toThrow("source signed 32-bit return boundary");
    expect(vfs.fileMemory.loadCount).toBe(0);
    expect(descriptorCount(path)).toBe(0);
    await truncate(path, 0x7fffffff);
    expect(() => vfs.readFileRetainedSync("signed.dat")).toThrow("Invalid FS_ReadFile allocation length");
    expect(descriptorCount(path)).toBe(1);
  });

  test("sync reads observe changes to an indexed loose file", async () => {
    const root = await makeDataTree();
    const path = join(root, "baseq3", "loose-only.txt");
    using vfs = await VirtualFileSystem.openInspection(searchOptions(root, "baseq3"));
    await writeFile(path, "changed after mount");
    expect(readTextSync(vfs, "loose-only.txt")).toBe("changed after mount");
    expect(await readText(vfs, "loose-only.txt")).toBe("changed after mount");
  });

  test("discovers loose files created after opening and refreshes normalized listings", async () => {
    const root = await makeDataTree();
    using base = await VirtualFileSystem.openInspection(searchOptions(root, "baseq3"));
    using missionpack = await VirtualFileSystem.openInspection(searchOptions(root, "missionpack"));
    const basePath = join(root, "baseq3", "sound", "dynamic.wav");
    const missionPath = join(root, "missionpack", "sound", "dynamic.wav");
    await mkdir(join(root, "baseq3", "sound"), { recursive: true });
    await mkdir(join(root, "missionpack", "sound"), { recursive: true });
    await writeFile(basePath, "new base sound");
    await writeFile(missionPath, "new mission sound");

    expect(await readText(base, "sound/dynamic.wav")).toBe("new base sound");
    expect(readTextSync(base, "sound/dynamic.wav")).toBe("new base sound");
    expect(readTextSync(missionpack, "sound/dynamic.wav")).toBe("new mission sound");
    expect(missionpack.source("sound/dynamic.wav")?.game).toBe("missionpack");
    expect(base.list("SOUND/")).toEqual(["sound/dynamic.wav"]);

    await writeFile(basePath, "changed base sound");
    expect(readTextSync(base, "sound/dynamic.wav")).toBe("changed base sound");
    await rm(basePath);
    expect(base.has("sound/dynamic.wav")).toBe(false);
    expect(base.list("sound/")).toEqual([]);
  });

  test("serves a real loose WAV created after opening to synchronous first-use sound registration", async () => {
    const root = await makeDataTree();
    using vfs = await VirtualFileSystem.openInspection(searchOptions(root, "baseq3"));
    const feedbackDirectory = join(root, "baseq3", "sound", "feedback");
    await mkdir(feedbackDirectory, { recursive: true });
    await writeFile(join(feedbackDirectory, "hit.wav"), monoWav(-1, 1));
    const diagnostics: string[] = [];
    const sounds = new ClientSoundBank(vfs, { debugPrint: text => { diagnostics.push(text); }, print: text => diagnostics.push(text) });
    await sounds.beginRegistration();

    await writeFile(join(root, "baseq3", "sound", "dynamic.wav"), monoWav(-321, 654));
    const sound = sounds.sound("sound/dynamic.wav", false);

    expect(sound?.samples).toEqual(new Int16Array([-321, 654]));
    expect(sound?.frameCount).toBe(2);
    expect(diagnostics).toEqual([]);
  });

  test("falls through a removed missionpack loose winner to the base packed file", async () => {
    const root = await makeDataTree();
    const path = join(root, "missionpack", "fallback.txt");
    using vfs = await VirtualFileSystem.openInspection(searchOptions(root, "missionpack"));
    expect(readTextSync(vfs, "fallback.txt")).toBe("mission loose fallback");
    expect(vfs.source("fallback.txt")?.game).toBe("missionpack");

    await rm(path);
    expect(vfs.has("fallback.txt")).toBe(true);
    expect(vfs.fileLength("fallback.txt")).toBe(new TextEncoder().encode("base packed fallback").byteLength);
    expect(await readText(vfs, "fallback.txt")).toBe("base packed fallback");
    expect(readTextSync(vfs, "fallback.txt")).toBe("base packed fallback");
    expect(vfs.source("fallback.txt")?.kind).toBe("pk3");
    expect(vfs.source("fallback.txt")?.game).toBe("baseq3");
  });

  test.skipIf(process.platform !== "linux")("keeps loose paths case-sensitive on Linux while listing normalized names", async () => {
    const root = await makeDataTree();
    const path = join(root, "baseq3", "sound", "MixedCase.wav");
    await mkdir(join(root, "baseq3", "sound"), { recursive: true });
    await writeFile(path, "mixed case loose");
    using vfs = await VirtualFileSystem.openInspection(searchOptions(root, "baseq3"));

    expect(vfs.has("sound/MixedCase.wav")).toBe(true);
    expect(readTextSync(vfs, "sound\\MixedCase.wav")).toBe("mixed case loose");
    expect(vfs.has("sound/mixedcase.wav")).toBe(false);
    expect(() => vfs.readSync("sound/mixedcase.wav")).toThrow("Asset not found");
    expect(vfs.list("sound/")).toEqual(["sound/mixedcase.wav"]);
  });

  test.skipIf(process.platform !== "linux")("keeps length probes coherent with loose symlink exclusion", async () => {
    const root = await makeDataTree();
    const external = join(root, "outside-q3key");
    await writeFile(external, "must not be opened through the VFS");
    await symlink(external, join(root, "baseq3", "q3key"));
    using vfs = await VirtualFileSystem.openInspection(searchOptions(root, "baseq3"));

    expect(vfs.has("q3key")).toBe(false);
    expect(vfs.source("q3key")).toBeUndefined();
    expect(vfs.fileLength("q3key")).toBe(-1);
    expect(vfs.list()).not.toContain("q3key");
  });

  test("reports a removed loose file as missing when no lower search path has it", async () => {
    const root = await makeDataTree();
    const path = join(root, "baseq3", "loose-only.txt");
    using vfs = await VirtualFileSystem.openInspection(searchOptions(root, "baseq3"));
    await rm(path);
    await expect(vfs.read("loose-only.txt")).rejects.toThrow("Asset not found");
    expect(() => vfs.readSync("loose-only.txt")).toThrow("Asset not found");
  });

  test("tracks logical packed opens against the complete source-order catalog", async () => {
    const root = await makeDataTree();
    const checksumFeed = 0x1234_5678;
    using vfs = await VirtualFileSystem.openTracked({
      ...searchOptions(root, "missionpack"),
      references: { checksumFeed, random: () => 0 },
    });
    const packPaths = [
      join(root, "missionpack", "pak0.pk3"),
      join(root, "missionpack", "MiXeD.pk3"),
      join(root, "baseq3", "pak2.pk3"),
      join(root, "baseq3", "pak1.pk3"),
      join(root, "baseq3", "empty.pk3"),
    ];
    const archives = await Promise.all(packPaths.map(async path => {
      using archive = await Pk3Archive.open(path);
      return { checksum: archive.checksum, pureChecksum: archive.pureChecksum(checksumFeed) };
    }));
    expect(vfs.pakReferences.checksumFeed).toBe(checksumFeed);
    expect(vfs.pakReferences.snapshot().map(record => record.pack.archivePath)).toEqual(packPaths);
    expect(vfs.pakReferences.loadedPakChecksums()).toBe(
      archives.map(archive => `${archive.checksum | 0} `).join(""),
    );
    expect(vfs.pakReferences.loadedPakPureChecksums()).toBe(
      archives.map(archive => `${archive.pureChecksum | 0} `).join(""),
    );
    expect(vfs.pakReferences.loadedPakNames()).toBe("pak0 MiXeD pak2 pak1 empty");
    expect(archives[1]?.checksum).toBe(archives[4]?.checksum);

    expect(vfs.has("VM/CGAME.QVM")).toBe(true);
    const source = vfs.source("VM/CGAME.QVM");
    expect(source?.kind).toBe("pk3");
    expect(source?.kind === "pk3" ? source.archivePath : undefined).toBe(join(root, "baseq3", "pak2.pk3"));
    expect(vfs.list("vm/")).toEqual(["vm/cgame.qvm"]);
    expect(vfs.pakReferences.snapshot().every(record => record.flags === 0)).toBe(true);
    expect(vfs.pakPureChecksum("VM\\CGAME.QVM")).toBe(archives[2]?.pureChecksum);
    expect(vfs.pakReferences.snapshot().every(record => record.flags === 0)).toBe(true);

    await vfs.read("VM/CGAME.QVM");
    expect(vfs.pakReferences.snapshot()[2]?.flags).toBe(PakReferenceFlag.General);
    vfs.readSync("vm/cgame.qvm");
    expect(vfs.pakReferences.snapshot()[2]?.flags).toBe(PakReferenceFlag.General | PakReferenceFlag.Cgame);
  });

  test("publishes current packed sizes through VFS opens and source length probes", async () => {
    const root = await mkdtemp(join(tmpdir(), "quake3-vfs-current-pack-"));
    temporaryDirectories.push(root);
    const directory = join(root, "baseq3");
    await mkdir(directory);
    const archivePath = join(directory, "pak0.pk3");
    const bytes = storedZip([{ name: "vm/cgame.qvm", text: "payload" }]);
    await writeFile(archivePath, bytes);
    using vfs = await VirtualFileSystem.openTracked({
      ...searchOptions(root, "baseq3"), references: { checksumFeed: 0, random: () => 0 },
    });
    try {
      expect(descriptorCount(archivePath)).toBe(1);
      const checksum = vfs.pakReferences.loadedPakChecksums();
      const view = new DataView(bytes.buffer);
      const central = view.getUint32(bytes.byteLength - 6, true);
      view.setUint32(18, 3, true);
      view.setUint32(22, 3, true);
      view.setUint32(central + 20, 3, true);
      view.setUint32(central + 24, 3, true);
      await writeFile(archivePath, bytes);
      const opened = vfs.openRead("vm/cgame.qvm");
      if (opened === undefined) throw new Error("Authored packed entry is missing");
      expect(opened.length).toBe(3);
      const destination = new Uint8Array(5).fill(0x7e);
      expect(vfs.readInto(opened.file, destination)).toBe(3);
      expect(destination).toEqual(new TextEncoder().encode("pay~~"));
      vfs.closeFile(opened.file);
      expect(vfs.fileLength("vm/cgame.qvm")).toBe(3);
      expect(vfs.readFileLength("vm/cgame.qvm")).toBe(3);
      expect(vfs.readFileOptionalSync("vm/cgame.qvm")).toEqual(new TextEncoder().encode("pay"));
      expect(vfs.pakReferences.snapshot()[0]?.flags).toBe(PakReferenceFlag.General | PakReferenceFlag.Cgame);
      expect(vfs.pakReferences.loadedPakChecksums()).toBe(checksum);
      expect(descriptorCount(archivePath)).toBe(1);
    } finally {
      vfs.close();
    }
    expect(descriptorCount(archivePath)).toBe(0);
  });

  test("retiring VFS closes mounted packs before any entry has been opened", async () => {
    const root = await mkdtemp(join(tmpdir(), "quake3-vfs-mount-close-"));
    temporaryDirectories.push(root);
    const directory = join(root, "baseq3");
    await mkdir(directory);
    const archivePath = join(directory, "pak0.pk3");
    await writeFile(archivePath, storedZip([{ name: "entry.cfg", text: "entry" }]));
    using vfs = await VirtualFileSystem.openInspection(searchOptions(root, "baseq3"));
    try {
      expect(descriptorCount(archivePath)).toBe(1);
      vfs.retire();
      expect(descriptorCount(archivePath)).toBe(0);
      expect(() => vfs.has("entry.cfg")).toThrow("retired");
    } finally {
      vfs.close();
    }
  });

  test("failed standalone VFS opens release mounted packs and reject invalid reference feeds before acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "quake3-vfs-mount-failure-"));
    temporaryDirectories.push(root);
    const directory = join(root, "baseq3");
    await mkdir(directory);
    const firstPath = join(directory, "pak0.pk3");
    const secondPath = join(directory, "pak1.pk3");
    const bytes = storedZip([{ name: "entry.cfg", text: "entry" }]);
    await writeFile(firstPath, bytes);
    const view = new DataView(bytes.buffer);
    view.setUint32(view.getUint32(bytes.byteLength - 6, true), 0, true);
    await writeFile(secondPath, bytes);
    await expect(VirtualFileSystem.openInspection(searchOptions(root, "baseq3"))).rejects.toThrow("central directory signature");
    expect(descriptorCount(firstPath)).toBe(0);
    expect(descriptorCount(secondPath)).toBe(0);
    await writeFile(secondPath, storedZip([{ name: "entry.cfg", text: "entry" }]));
    await expect(VirtualFileSystem.openTracked({
      ...searchOptions(root, "baseq3"), references: { checksumFeed: Infinity, random: () => 0 },
    })).rejects.toThrow("Checksum feed must be a signed or unsigned 32-bit integer");
    expect(descriptorCount(firstPath)).toBe(0);
    expect(descriptorCount(secondPath)).toBe(0);
  });

  test("startup skips unopened short packs and keeps loading later valid archives", async () => {
    const root = await mkdtemp(join(tmpdir(), "quake3-vfs-unopened-packs-"));
    temporaryDirectories.push(root);
    const directory = join(root, "baseq3");
    await mkdir(directory);
    const rejected = [join(directory, "pak0.pk3"), join(directory, "pak1.pk3"), join(directory, "pak4.pk3")];
    for (const [index, path] of rejected.entries()) await writeFile(path, new Uint8Array(index === 0 ? 0 : index === 1 ? 1 : 21));
    const archivePath = join(directory, "pak2.pk3");
    await writeFile(archivePath, storedZip([{ name: "entry.cfg", text: "loaded" }]));
    using files = await VirtualFileSystem.openTracked({ ...searchOptions(root, "baseq3"),
      references: { checksumFeed: 9, random: () => 0 } });
    expect(readTextSync(files, "entry.cfg")).toBe("loaded");
    expect(files.pakReferences.loadedPakNames()).toBe("pak2");
    for (const path of rejected) expect(descriptorCount(path)).toBe(0);
    expect(descriptorCount(archivePath)).toBe(1);
    using inspection = await VirtualFileSystem.openInspection(searchOptions(root, "baseq3"));
    expect(readTextSync(inspection, "entry.cfg")).toBe("loaded");
    expect(descriptorCount(archivePath)).toBe(2);
  });

  test("marks a selected packed entry and returns its bytes despite a payload CRC mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "quake3-vfs-reference-error-"));
    temporaryDirectories.push(root);
    const directory = join(root, "baseq3");
    const archivePath = join(directory, "bad.pk3");
    await mkdir(directory, { recursive: true });
    await writeFile(archivePath, storedZip([{ name: "vm/cgame.qvm", text: "payload" }]));
    using vfs = await VirtualFileSystem.openTracked({
      ...searchOptions(root, "baseq3"),
      references: { checksumFeed: 0, random: () => 0 },
    });
    const handle = await openFile(archivePath, "r+");
    try {
      const nameLength = new TextEncoder().encode("vm/cgame.qvm").byteLength;
      await handle.write(new Uint8Array([0xff]), 0, 1, 30 + nameLength);
    } finally {
      await handle.close();
    }

    const expected = new Uint8Array([0xff, ...new TextEncoder().encode("ayload")]);
    expect(await vfs.read("vm/cgame.qvm")).toEqual(expected);
    expect(vfs.pakReferences.snapshot()[0]?.flags).toBe(PakReferenceFlag.General | PakReferenceFlag.Cgame);
    vfs.pakReferences.clear(0);
    expect(vfs.readSync("vm/cgame.qvm")).toEqual(expected);
    expect(vfs.pakReferences.snapshot()[0]?.flags).toBe(PakReferenceFlag.General | PakReferenceFlag.Cgame);
  });

  test("probes packed length and references without reading or decompressing the payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "quake3-vfs-length-packed-"));
    temporaryDirectories.push(root);
    const directory = join(root, "baseq3");
    const archivePath = join(directory, "bad.pk3");
    await mkdir(directory, { recursive: true });
    await writeFile(archivePath, storedZip([{ name: "vm/cgame.qvm", text: "payload" }]));
    using vfs = await VirtualFileSystem.openTracked({
      ...searchOptions(root, "baseq3"),
      references: { checksumFeed: 0, random: () => 0 },
    });
    const handle = await openFile(archivePath, "r+");
    try {
      const nameLength = new TextEncoder().encode("vm/cgame.qvm").byteLength;
      await handle.write(new Uint8Array([0xff]), 0, 1, 30 + nameLength);
    } finally {
      await handle.close();
    }

    expect(vfs.fileLength("vm/cgame.qvm")).toBe(7);
    expect(vfs.pakReferences.snapshot()[0]?.flags).toBe(PakReferenceFlag.General | PakReferenceFlag.Cgame);
    expect(vfs.readSync("vm/cgame.qvm")).toEqual(new Uint8Array([0xff, ...new TextEncoder().encode("ayload")]));
  });

  test("probes loose length through an opened descriptor and returns minus one when missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "quake3-vfs-length-loose-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "baseq3"), { recursive: true });
    await writeFile(join(root, "baseq3", "server.cfg"), "set a 1");
    await writeFile(join(root, "baseq3", "sound.wav"), "wave");
    let randomCalls = 0;
    using vfs = await VirtualFileSystem.openTracked({
      ...searchOptions(root, "baseq3"),
      references: {
        checksumFeed: 0,
        random: () => {
          randomCalls++;
          return 0;
        },
      },
    });

    expect(vfs.fileLength("missing.dat")).toBe(-1);
    expect(randomCalls).toBe(0);
    expect(vfs.fileLength("server.cfg")).toBe(7);
    expect(randomCalls).toBe(0);
    expect(vfs.fileLength("sound.wav")).toBe(4);
    expect(randomCalls).toBe(1);
    expect(() => vfs.fileLength("")).toThrow("must not be empty");
  });

  test("rejects loose probe lengths outside the source signed-int return boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "quake3-vfs-length-int-"));
    temporaryDirectories.push(root);
    const directory = join(root, "baseq3");
    const path = join(directory, "huge.bin");
    await mkdir(directory, { recursive: true });
    await writeFile(path, new Uint8Array([0]));
    await truncate(path, 0x8000_0000);
    let randomCalls = 0;
    using vfs = await VirtualFileSystem.openTracked({
      ...searchOptions(root, "baseq3"),
      references: {
        checksumFeed: 0,
        random: () => {
          randomCalls++;
          return 0;
        },
      },
    });

    expect(() => vfs.fileLength("huge.bin")).toThrow("signed 32-bit");
    expect(randomCalls).toBe(1);
  });

  test("tracks a late loose file only after an actual open", async () => {
    const root = await mkdtemp(join(tmpdir(), "quake3-vfs-loose-reference-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "baseq3"), { recursive: true });
    let randomCalls = 0;
    using vfs = await VirtualFileSystem.openTracked({
      ...searchOptions(root, "baseq3"),
      references: {
        checksumFeed: 77,
        random: () => {
          randomCalls++;
          return 1;
        },
      },
    });
    const path = join(root, "baseq3", "late.wav");
    await writeFile(path, "late loose sound");
    expect(vfs.has("late.wav")).toBe(true);
    expect(vfs.source("late.wav")?.kind).toBe("loose");
    expect(vfs.list()).toEqual(["late.wav"]);
    expect(randomCalls).toBe(0);
    expect(vfs.pakReferences.referencedPakPureChecksums()).toBe("@ 77");

    expect(readTextSync(vfs, "late.wav")).toBe("late loose sound");
    expect(randomCalls).toBe(1);
    expect(vfs.pakReferences.referencedPakPureChecksums()).toBe("1 1 @ 1 77");
  });

  test.skipIf(!retailBaseAvailable)("mounts installed base data when available", async () => {
    using base = await VirtualFileSystem.openInspection(searchOptions(retailDataPath, "baseq3"));
    expect(base.has("default.cfg")).toBe(true);
    expect(new TextDecoder().decode(base.readSync("default.cfg"))).toContain("unbindall");
  });

  test.skipIf(!retailMissionpackAvailable)("mounts installed Team Arena data when available", async () => {
    using missionpack = await VirtualFileSystem.openInspection(searchOptions(retailDataPath, "missionpack"));
    expect(missionpack.has("maps/mpteam1.bsp")).toBe(true);
    expect(missionpack.source("maps/mpteam1.bsp")?.kind).toBe("pk3");
  });

  test.skipIf(!retailBaseAvailable || !retailMissionpackAvailable)("catalogs installed retail checksums with the active feed", async () => {
    const checksumFeed = 0x1234_5678;
    using vfs = await VirtualFileSystem.openTracked({
      ...searchOptions(retailDataPath, "missionpack"),
      references: { checksumFeed, random: () => 0 },
    });
    const missionPak0 = vfs.pakReferences.snapshot().find(record =>
      record.pack.game === "missionpack" && record.pack.basename.toLowerCase() === "pak0");
    const basePak0 = vfs.pakReferences.snapshot().find(record =>
      record.pack.game === "baseq3" && record.pack.basename.toLowerCase() === "pak0");
    expect(missionPak0?.pack.checksum).toBe(2_430_342_401);
    expect(missionPak0?.pack.pureChecksum).toBe(2_674_869_564);
    expect(basePak0?.pack.checksum).toBe(1_566_731_103);
    expect(basePak0?.pack.pureChecksum).toBe(3_017_657_714);
  });
});
