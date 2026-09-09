import { afterEach, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { FileHandleExhaustionError, SourceFileHandles } from "../src/assets/file-handles.ts";
import type { FileHandle } from "../src/assets/file-handles.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function write(path: string, content: string | Uint8Array): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "latin1");
}

function descriptors(root: string): string[] {
  const paths: string[] = [];
  for (const name of readdirSync("/proc/self/fd")) {
    try {
      const path = readlinkSync(`/proc/self/fd/${name}`);
      if (path.startsWith(`${root}/`)) paths.push(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return paths.sort();
}

async function fixture(sameRoots = false, print: (text: string) => undefined = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "quake3-fs-server-"));
  cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
  const home = join(root, "home"), base = sameRoots ? home : join(root, "base"), cd = join(root, "cd");
  for (const directory of [home, base, cd]) mkdirSync(directory, { recursive: true });
  write(join(home, "baseq3", "default.cfg"), "set fixture 1\n");
  const sound = new SoundOutput(), cvars = new CvarRegistry();
  const files = new CommonFileState({ homePath: home, dataPath: base, cdPath: cd, product: "baseq3" }, print, sound, cvars);
  cleanup.push(() => { try { files.close(); } finally { sound.close(); } });
  expect(cvars.get("fs_debug")).toBeUndefined();
  await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
  return { root, home, base, cd, sound, cvars, files };
}

function read(files: CommonFileState, path: string): string | null {
  const opened = files.server.openRead(path);
  if (opened === null) return null;
  const destination = new Uint8Array(opened.length);
  expect(files.current.readInto(opened.file, destination)).toBe(opened.length);
  files.current.closeFile(opened.file);
  return String.fromCharCode(...destination);
}

function pairs(bytes: Uint8Array, count: number): readonly (readonly [string, string])[] {
  let offset = 0;
  const next = (): string => {
    let text = "";
    for (;;) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error("Missing source string terminator");
      if (byte === 0) return text;
      text += String.fromCharCode(byte);
    }
  };
  return Array.from({ length: count }, () => [next(), next()]);
}

function mod(root: string, name: string, description?: string | Uint8Array): void {
  write(join(root, name, "content.PK3"), "Only directory membership matters to FS_GetModList");
  if (description !== undefined) write(join(root, name, "description.txt"), description);
}

async function commonFixture() {
  const root = mkdtempSync(join(tmpdir(), "quake3-common-server-files-"));
  cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
  write(join(root, "baseq3", "default.cfg"), "set fixture 1\n");
  write(join(root, "baseq3", "productid.txt"), SOURCE_PRODUCT_ID);
  const adopted: CommonConsole[] = [];
  const common = await CommonConsole.open({ roots: { dataPath: root, homePath: root, cdPath: null, product: "baseq3" },
    startup: new StartupCommands(""), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
    platformPrint: () => {}, resolveCommand: () => undefined, assertCommandEntry: () => {}, assertOwnerEntry: () => {} },
    value => { expect(value.sound.mixer).toBeNull(); expect(value.cvars.get("fs_debug")).toBeUndefined(); adopted.push(value); });
  cleanup.push(() => { common.close(); });
  expect(adopted).toEqual([common]);
  return { common, root };
}

if (process.env["QUAKE_FS_SERVER_SOUND_CHILD"] === "1") {
  test("server read clears the actual common mixer and SDL queue before opening a description", async () => {
    const { common, root } = await commonFixture();
    mod(root, "sample", "Real description");
    const mixer = common.sound.start({ sampleRate: 48000 }, () => 0);
    mixer.queueRaw({ sampleRate: 48000, channels: 1, samples: new Int16Array([1024, 2048, 4096]), frameCount: 3, loopStart: null }, 1);
    common.sound.submit(2);
    expect(common.sound.queuedFrames).toBe(2); expect(mixer.rawEnd).toBe(3);
    const bytes = new Uint8Array(128);
    expect(common.files.current.getFileList("$modlist", "", bytes)).toBe(1);
    expect(pairs(bytes, 1)).toEqual([["sample", "Real description"]]);
    expect(common.sound.queuedFrames).toBe(0); expect(mixer.rawEnd).toBe(0); expect(mixer.sampleClock).toBe(2);
    expect(Array.from(mixer.mix(2))).toEqual([0, 0, 0, 0]);
    common.close(); expect(common.sound.mixer).toBeNull();
    expect(() => common.sound.start({ sampleRate: 48000 }, () => 0)).toThrow("closed");
  });
} else {
  test("server reads prefer home then distinct base and share real retained handles", async () => {
    const prints: string[] = [], f = await fixture(false, text => { prints.push(text); });
    write(join(f.home, "mod", "home.txt"), "HOME"); write(join(f.base, "mod", "home.txt"), "BASE");
    write(join(f.base, "mod", "base.txt"), "BASE");
    write(join(f.home, "mod", "empty.txt"), "");
    f.cvars.set("fs_debug", "1");
    expect(read(f.files, "mod/home.txt")).toBe("HOME");
    expect(read(f.files, "mod/base.txt")).toBe("BASE");
    expect(prints).toEqual([`FS_SV_FOpenFileRead (fs_homepath): ${f.home}/mod/home.txt\n`,
      `FS_SV_FOpenFileRead (fs_homepath): ${f.home}/mod/base.txt\n`, `FS_SV_FOpenFileRead (fs_basepath): ${f.base}/mod/base.txt\n`]);
    const empty = f.files.server.openRead("mod/empty.txt");
    if (empty === null) throw new Error("Zero-length open must return its real positive handle");
    expect(empty.length).toBe(0); expect(empty.file.slot).toBe(1);
    await f.files.restart({ checksumFeed: 1, random: () => 0 }, () => {});
    expect(f.files.current.readInto(empty.file, new Uint8Array(3))).toBe(0);
    f.files.current.closeFile(empty.file);
  });

  test("equal home/base preserves the selected positive slot for a CD-only read", async () => {
    const prints: string[] = [], f = await fixture(true, text => { prints.push(text); });
    write(join(f.cd, "mod", "description.txt"), "CD description"); f.cvars.set("fs_debug", "1");
    expect(read(f.files, "mod/description.txt")).toBe("CD description");
    expect(prints).toEqual([`FS_SV_FOpenFileRead (fs_homepath): ${f.home}/mod/description.txt\n`,
      `FS_SV_FOpenFileRead (fs_cdpath) : ${f.cd}/mod/description.txt\n`]);
  });

  test("distinct-base miss assigns CD to row zero, reports missing and skips later CD probes", async () => {
    const prints: string[] = [], f = await fixture(false, text => { prints.push(text); });
    const path = join(f.cd, "mod", "description.txt"); write(path, "retained CD descriptor"); f.cvars.set("fs_debug", "1");
    expect(f.files.server.openRead("mod/description.txt")).toBeNull(); expect(descriptors(f.root)).toEqual([path]);
    expect(f.files.server.openRead("other/missing.txt")).toBeNull();
    expect(prints.filter(text => text.includes("(fs_cdpath)"))).toHaveLength(1);
    const handles: FileHandle[] = [];
    for (let index = 1; index <= 63; index++) {
      const opened = f.files.current.openRead("default.cfg");
      if (opened === undefined) throw new Error("Expected source slot");
      expect(opened.file.slot).toBe(index); handles.push(opened.file);
    }
    expect(() => f.files.server.openRead("missing.txt")).toThrow(FileHandleExhaustionError);
    for (const handle of handles) f.files.current.closeFile(handle);
    await f.files.restart({ checksumFeed: 1, random: () => 0 }, () => {});
    expect(descriptors(f.root)).toEqual([path]); f.files.close(); expect(descriptors(f.root)).toEqual([]);
  });

  test("reentrant CD diagnostics preserve displaced zero-row resources until managed cleanup", async () => {
    let nested = false, files: CommonFileState | null = null;
    const f = await fixture(false, text => {
      if (files !== null && !nested && text.includes("(fs_cdpath)")) {
        nested = true; expect(files.server.openRead("second.txt")).toBeNull();
      }
    });
    files = f.files; f.cvars.set("fs_debug", "1");
    const first = join(f.cd, "first.txt"), second = join(f.cd, "second.txt"); write(first, "one"); write(second, "two");
    expect(f.files.server.openRead("first.txt")).toBeNull();
    expect(descriptors(f.root)).toEqual([first, second]);
    f.files.close(); expect(descriptors(f.root)).toEqual([]);
  });

  test("empty CD root uses an absolute source path without trying the process working directory", async () => {
    const f = await fixture(true), prints: string[] = [], sound = new SoundOutput(), cvars = new CvarRegistry();
    const files = new CommonFileState({ ...f.files.roots, cdPath: null }, text => { prints.push(text); }, sound, cvars);
    cleanup.push(() => { try { files.close(); } finally { sound.close(); } });
    await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {}); cvars.set("fs_debug", "1");
    expect(files.server.openRead("package.json")).toBeNull();
    expect(prints.at(-1)).toBe("FS_SV_FOpenFileRead (fs_cdpath) : /package.json\n");
  });

  test("mod lists concatenate home/base/CD directories, deduplicate case and pack exact byte pairs", async () => {
    const f = await fixture();
    mod(f.home, "Home", "Home description"); mod(f.base, "Home", "lower priority"); mod(f.cd, "home", "case duplicate");
    mod(f.base, "Base", new Uint8Array([65, 0, 66])); mod(f.cd, "Cd", "unreachable source CD description");
    mod(f.home, ".hidden", "hidden"); mod(f.home, "missionpack", "Team Arena");
    mkdirSync(join(f.home, "empty"));
    const expectedNames = [f.home, f.base, f.cd].flatMap(root => readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name))
      .filter((name, index, all) => all.findIndex(candidate => candidate.toLowerCase() === name.toLowerCase()) === index)
      .filter(name => name !== "baseq3" && name !== "empty" && !name.startsWith("."));
    const descriptions = new Map([["Home", "Home description"], ["Base", "A"], ["Cd", "Cd"], ["missionpack", "Team Arena"]]);
    const expectedPairs = expectedNames.map((name): [string, string] => {
      const description = descriptions.get(name);
      if (description === undefined) throw new Error(`Unexpected fixture mod ${name}`);
      return [name, description];
    });
    const bytes = new Uint8Array(256).fill(0xcc);
    const count = f.files.current.getFileList("$MODLIST", "\0é ignored by source dispatch", bytes);
    expect(pairs(bytes, count)).toEqual(expectedPairs);
    expect(descriptors(f.root)).toEqual([join(f.cd, "Cd", "description.txt")]);
    const total = expectedPairs.reduce((size, [name, description]) => size + name.length + description.length + 2, 0);
    expect(bytes[total]).toBe(0xcc);
    f.files.close(); expect(descriptors(f.root)).toEqual([]);
  });

  test("mod discovery preserves distinct source-byte names beneath a raw canonical root", async () => {
    const parent = mkdtempSync(join(tmpdir(), "quake3-fs-server-native-"));
    cleanup.push(() => { rmSync(parent, { recursive: true, force: true }); });
    const rawRoot = Buffer.concat([Buffer.from(`${parent}/`), Buffer.from([0xe9])]);
    mkdirSync(Buffer.concat([rawRoot, Buffer.from("/baseq3")]), { recursive: true });
    writeFileSync(Buffer.concat([rawRoot, Buffer.from("/baseq3/default.cfg")]), "set fixture 1\n");
    const root = join(parent, "configured-root");
    symlinkSync(rawRoot, root);
    const sound = new SoundOutput(), cvars = new CvarRegistry();
    const files = new CommonFileState({ homePath: root, dataPath: root, cdPath: null, product: "baseq3" },
      () => {}, sound, cvars);
    cleanup.push(() => { try { files.close(); } finally { sound.close(); } });
    await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
    const expected = new Map([["\u00e9", "Raw byte"], ["\u00c3\u00a9", "UTF-8 bytes"]]);
    for (const [name, description] of expected) {
      const path = Buffer.concat([rawRoot, Buffer.from("/"), Buffer.from(name, "latin1")]);
      mkdirSync(path);
      writeFileSync(Buffer.concat([path, Buffer.from("/content.PK3")]), "Authored mod membership fixture");
      writeFileSync(Buffer.concat([path, Buffer.from("/description.txt")]), description);
      expect(files.server.exists(`${name}/description.txt`)).toBe(true);
      expect(read(files, `${name}/description.txt`)).toBe(description);
    }
    const bytes = new Uint8Array(128).fill(0xcc);
    const count = files.current.getFileList("$modlist", "", bytes);
    expect(count).toBe(2);
    expect(new Map(pairs(bytes, count))).toEqual(expected);
  });

  test("description fread is capped at 48 raw bytes and runs before the strict pair-buffer bound", async () => {
    const f = await fixture(true), name = "sample", description = "x".repeat(60);
    mod(f.home, name, description);
    const expectedLength = name.length + 1 + 48 + 1;
    for (const size of [1, expectedLength + 2, expectedLength + 3]) {
      const bytes = new Uint8Array(size).fill(0xcc);
      const count = f.files.current.getFileList("$modlist", "", bytes);
      expect(count).toBe(size === expectedLength + 3 ? 1 : 0);
      if (count === 1) expect(pairs(bytes, count)).toEqual([[name, "x".repeat(48)]]);
      else expect(bytes[0]).toBe(0);
      expect(descriptors(f.root)).toEqual([]);
    }
    const table = new SourceFileHandles(), file = table.selectFree(), fd = openSync(join(f.home, name, "description.txt"), "r");
    table.attachLooseRead(file, fd);
    try {
      expect(table.readLooseDirect(file, new Uint8Array(48))).toBe(48); expect(table.readCount).toBe(0);
      expect(table.readInto(file, new Uint8Array(48))).toBe(12); expect(table.readCount).toBe(48);
    } finally { table.close(); }
    const failed = new SourceFileHandles(), broken = failed.selectFree(), closed = openSync(join(f.home, name, "description.txt"), "r");
    failed.attachLooseRead(broken, closed); closeSync(closed);
    try {
      const destination = new Uint8Array(48).fill(0xcc);
      expect(failed.readLooseDirect(broken, destination)).toBe(0); expect(failed.readCount).toBe(0);
      expect(destination).toEqual(new Uint8Array(48).fill(0xcc));
      expect(() => failed.readLooseDirect(file, destination)).toThrow("different filesystem");
    } finally { expect(() => failed.close()).toThrow(AggregateError); }
  });

  test("zero-length mod descriptions keep positive source handles even when the buffer rejects the pair", async () => {
    const f = await fixture(true); mod(f.home, "empty-description", "");
    expect(f.files.current.getFileList("$modlist", "", new Uint8Array(1))).toBe(0);
    const bytes = new Uint8Array(128);
    expect(f.files.current.getFileList("$modlist", "", bytes)).toBe(1);
    expect(pairs(bytes, 1)).toEqual([["empty-description", "empty-description"]]);
    expect(descriptors(f.root)).toEqual(Array.from({ length: 2 }, () => join(f.home, "empty-description", "description.txt")));
    await f.files.restart({ checksumFeed: 1, random: () => 0 }, () => {});
    expect(descriptors(f.root)).toHaveLength(2); f.files.close(); expect(descriptors(f.root)).toEqual([]);
  });

  test("security boundaries reject credential and traversal reads and ignore symlink mod directories", async () => {
    const f = await fixture(true); write(join(f.home, "mod", "q3key"), "fixture credential");
    mod(f.cd, "actual", "real"); symlinkSync(join(f.cd, "actual"), join(f.home, "linked"));
    expect(f.files.server.openRead("mod/q3key")).toBeNull(); expect(f.files.server.openRead("mod/Quake3CDKey")).toBeNull();
    expect(() => f.files.server.openRead("../outside")).toThrow("traversal");
    const bytes = new Uint8Array(128), count = f.files.current.getFileList("$modlist", "", bytes);
    expect(pairs(bytes, count)).toEqual([["actual", "real"]]);
    expect(descriptors(f.root)).toEqual([]);
  });

  test("sound and diagnostic reentry cannot publish descriptors into closed or retired mounts", async () => {
    for (const point of ["sound", "print", "remount"]) {
      let files: CommonFileState | null = null, pending: Promise<void> | null = null;
      const f = await fixture(true, () => {
        if (files === null || point === "sound") return;
        const owner = files; files = null;
        if (point === "print") owner.close();
        else pending = owner.restart({ checksumFeed: 1, random: () => 0 }, () => {});
      });
      files = f.files; f.cvars.set("fs_debug", "1"); write(join(f.home, "read.txt"), "real resource");
      const clear = f.sound.clearSoundBuffer.bind(f.sound);
      if (point === "sound") f.sound.clearSoundBuffer = () => { clear(); f.files.close(); };
      expect(() => f.files.server.openRead("read.txt")).toThrow("no active mounts");
      if (pending !== null) await pending;
      expect(descriptors(f.root)).toEqual([]);
      f.sound.clearSoundBuffer = clear;
    }
  });

  test("ownerless inspection explicitly rejects mod listing while common's inert sound exists before FS startup", async () => {
    const { common, root } = await commonFixture();
    expect(common.sound.mixer).toBeNull(); expect(common.cvars.get("fs_debug")?.integerValue).toBe(0);
    const inspection = await VirtualFileSystem.openInspection(common.roots);
    try { expect(() => inspection.getFileList("$modlist", "", new Uint8Array(32))).toThrow("common server-filesystem owner"); }
    finally { inspection.close(); }
    common.close(); expect(descriptors(root)).toEqual([]);
    expect(() => common.sound.start({ sampleRate: 48000 }, () => 0)).toThrow("closed");
  });

  test("common final cleanup closes sound after filesystem failure and preserves both owner failures", async () => {
    const { common } = await commonFixture(), files = common.files;
    const closeFiles = files.close.bind(files), closeSound = common.sound.close.bind(common.sound);
    const first = new Error("filesystem cleanup"), second = new Error("sound cleanup"), calls: string[] = [];
    files.close = () => { calls.push("files"); closeFiles(); throw first; };
    common.sound.close = () => { calls.push("sound"); closeSound(); throw second; };
    let caught: unknown;
    try { common.close(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError)) throw new Error("Expected cleanup aggregate");
    const errors: unknown = caught.errors;
    expect(errors).toEqual([first, second]); expect(caught.cause).toBe(first); expect(calls).toEqual(["files", "sound"]);
    common.close(); expect(calls).toEqual(["files", "sound"]);
  });

  test("server filesystem clears real common SDL output in an isolated dummy process", async () => {
    const child = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, SDL_AUDIODRIVER: "dummy", SDL_AUDIO_FREQUENCY: "48000", QUAKE_FS_SERVER_SOUND_CHILD: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(`Server filesystem sound child failed (${exitCode})\n${stdout}${stderr}`);
    expect(exitCode).toBe(0);
  }, 15000);
}
