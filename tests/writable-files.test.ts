import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { BspMap } from "../src/assets/bsp.ts";
import { WritableFileSystem } from "../src/assets/writable-files.ts";
import { NativeRoot } from "../src/assets/native-root.ts";
import { FileHandleExhaustionError, SourceFileHandles } from "../src/assets/file-handles.ts";
import type { FileHandle } from "../src/assets/file-handles.ts";
import { vec3 } from "../src/core/math.ts";
import { GameRuntime } from "../src/game/runtime.ts";
import { GameType } from "../src/shared/definitions.ts";
import { createGameVerificationHarness } from "../tools/game-verification-harness.ts";

const temporaryDirectories: string[] = [];
const owners: WritableFileSystem[] = [];
const handleOwners: SourceFileHandles[] = [];

afterEach(async () => {
  for (const owner of owners.splice(0)) owner.closeAll();
  for (const handles of handleOwners.splice(0)) handles.close();
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "quake3-writable-"));
  temporaryDirectories.push(root);
  return root;
}

function owner(homePath: string, product: "baseq3" | "missionpack" = "baseq3"): WritableFileSystem {
  const files = new WritableFileSystem({ homePath, product, print: () => undefined });
  owners.push(files);
  return files;
}

function sharedOwner(homePath: string): { readonly files: WritableFileSystem; readonly handles: SourceFileHandles } {
  const handles = new SourceFileHandles();
  handleOwners.push(handles);
  const files = new WritableFileSystem({ homePath, product: "baseq3", print: () => undefined, handles });
  owners.push(files);
  return { files, handles };
}

function bytePath(hostRoot: string | NativeRoot, sourcePath: string): Buffer {
  return Buffer.concat([typeof hostRoot === "string" ? Buffer.from(hostRoot) : hostRoot.resolvedBytes(), Buffer.from("/"), Buffer.from(sourcePath, "latin1")]);
}

function openRead(handles: SourceFileHandles, path: string): FileHandle {
  const handle = handles.selectFree();
  handles.attachLooseRead(handle, openSync(path, "r"));
  handles.setReadMode(handle, handles.captureLooseLength(handle));
  return handle;
}

function emptyMap(): BspMap {
  const bounds = { min: vec3(-1024, -1024, -1024), max: vec3(1024, 1024, 1024) };
  return {
    entities: `{ "classname" "worldspawn" }`, entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [],
    models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [],
    lightmaps: [], lightGrid: [], visibility: null,
  };
}

describe("Quake writable files", () => {
  test("source byte names create, truncate, append and probe distinct files beneath a Unicode host root", async () => {
    const root = await temporaryRoot(), home = join(root, "home-\u6e38\u620f-\u00e9");
    const paths: string[] = [];
    const files = new WritableFileSystem({ homePath: home, product: "baseq3", print: () => undefined,
      beforeProductOpen: (path, mode) => { paths.push(`${mode} ${path}`); } });
    owners.push(files);
    for (const name of ["\xe9/\xe9.cfg", "\xc3\xa9/\xc3\xa9.cfg"]) {
      const first = files.openWrite(name, false);
      if (first === null) throw new Error("Expected source byte write");
      first.write(name); first.close();
      expect(readFileSync(bytePath(NativeRoot.fromSource(files.rootPath), name), "latin1")).toBe(name);
      expect(files.fileExists(name)).toBe(true);
    }
    const append = files.openAppend("\xe9/\xe9.cfg", false);
    if (append === null) throw new Error("Expected source byte append");
    append.write("+"); append.close();
    expect(readFileSync(bytePath(NativeRoot.fromSource(files.rootPath), "\xe9/\xe9.cfg"), "latin1")).toBe("\xe9/\xe9.cfg+");
    const overwrite = files.openWrite("\xe9/\xe9.cfg", false);
    if (overwrite === null) throw new Error("Expected source byte overwrite");
    overwrite.write("new"); overwrite.close();
    expect(readFileSync(bytePath(NativeRoot.fromSource(files.rootPath), "\xe9/\xe9.cfg"), "latin1")).toBe("new");
    expect(readFileSync(bytePath(NativeRoot.fromSource(files.rootPath), "\xc3\xa9/\xc3\xa9.cfg"), "latin1")).toBe("\xc3\xa9/\xc3\xa9.cfg");
    expect(paths).toEqual([`write ${join(files.rootPath, "\xe9/\xe9.cfg")}`,
      `write ${join(files.rootPath, "\xc3\xa9/\xc3\xa9.cfg")}`,
      `append ${join(files.rootPath, "\xe9/\xe9.cfg")}`, `write ${join(files.rootPath, "\xe9/\xe9.cfg")}`]);
    const retained = files.openBinaryWrite("\xe9/\xe9.cfg");
    if (retained === null) throw new Error("Expected retained source byte descriptor");
    await rename(bytePath(NativeRoot.fromSource(files.rootPath), "\xe9/\xe9.cfg"), bytePath(NativeRoot.fromSource(files.rootPath), "\xe9/retained.cfg"));
    await writeFile(bytePath(NativeRoot.fromSource(files.rootPath), "\xe9/\xe9.cfg"), "replacement");
    retained.writeBytes(new Uint8Array([82])); retained.close();
    expect(readFileSync(bytePath(NativeRoot.fromSource(files.rootPath), "\xe9/retained.cfg"), "utf8")).toBe("R");
    expect(readFileSync(bytePath(NativeRoot.fromSource(files.rootPath), "\xe9/\xe9.cfg"), "utf8")).toBe("replacement");
    const bot = files.openBotLog("\xe9/bot.log");
    if (bot.kind !== "opened") throw new Error("Expected source byte bot log");
    expect(bot.stream.write(new Uint8Array([66]))).toEqual({ kind: "ok" });
    expect(bot.stream.close()).toEqual({ kind: "ok" });
    expect(readFileSync(bytePath(NativeRoot.fromSource(files.rootPath), "\xe9/bot.log"), "utf8")).toBe("B");
  });

  test("source byte rename, fallback copy and no-replace finalization preserve coexisting names", async () => {
    const root = await temporaryRoot(), home = join(root, "home-\u6e38\u620f");
    const { files, handles } = sharedOwner(home);
    await mkdir(NativeRoot.fromSource(files.rootPath).resolvedBytes(), { recursive: true });
    await writeFile(bytePath(NativeRoot.fromSource(files.rootPath), "\xe9.tmp"), "raw");
    await writeFile(bytePath(NativeRoot.fromSource(files.rootPath), "\xc3\xa9.tmp"), "utf8");
    const directories: string[] = [];
    files.renameFile("\xe9.tmp", "\xe9.cfg", directory => { directories.push(directory); });
    expect(readFileSync(bytePath(NativeRoot.fromSource(files.rootPath), "\xe9.cfg"), "utf8")).toBe("raw");
    expect(existsSync(bytePath(NativeRoot.fromSource(files.rootPath), "\xe9.tmp"))).toBe(false);
    expect(readFileSync(bytePath(NativeRoot.fromSource(files.rootPath), "\xc3\xa9.tmp"), "utf8")).toBe("utf8");
    files.renameFile("\xe9.cfg", "\xe9/new/\xe9.cfg", directory => { directories.push(directory); });
    expect(readFileSync(bytePath(NativeRoot.fromSource(files.rootPath), "\xe9/new/\xe9.cfg"), "utf8")).toBe("raw");
    expect(existsSync(bytePath(NativeRoot.fromSource(files.rootPath), "\xe9.cfg"))).toBe(false);
    expect(directories).toEqual([files.rootPath, files.rootPath]);
    const server = files.openServerBinaryWrite("\xe9/\xe9.tmp", handles.selectFree(), () => {});
    if (server === null) throw new Error("Expected source byte server write");
    server.writeBytes(new Uint8Array([83])); server.close();
    await writeFile(bytePath(home, "\xe9/\xc3\xa9.pk3"), "other");
    files.renameServerFileNoReplace("\xe9/\xe9.tmp", "\xe9/\xe9.pk3");
    expect(readFileSync(bytePath(home, "\xe9/\xe9.pk3"), "utf8")).toBe("S");
    expect(readFileSync(bytePath(home, "\xe9/\xc3\xa9.pk3"), "utf8")).toBe("other");
    await writeFile(bytePath(home, "\xe9/\xe9.tmp"), "conflict source");
    expect(() => files.renameServerFileNoReplace("\xe9/\xe9.tmp", "\xe9/\xe9.pk3")).toThrow();
    expect(readFileSync(bytePath(home, "\xe9/\xe9.tmp"), "utf8")).toBe("conflict source");
    expect(readFileSync(bytePath(home, "\xe9/\xe9.pk3"), "utf8")).toBe("S");
    files.renameServerFile("\xe9/\xe9.pk3", "\xe9/\xe9.done", () => {});
    expect(readFileSync(bytePath(home, "\xe9/\xe9.done"), "utf8")).toBe("S");
  });

  test("source byte CD copies retain raw source and destination names", async () => {
    const root = await temporaryRoot(), source = join(root, "cd-\u6e38\u620f"), base = join(root, "base-\u6e38\u620f");
    await mkdir(source);
    await writeFile(bytePath(source, "\xe9.cfg"), "raw");
    await writeFile(bytePath(source, "\xc3\xa9.cfg"), "utf8");
    const files = owner(join(root, "home"));
    files.copyFileFromCd(source, "baseq3", "\xe9.cfg", NativeRoot.fromHost(base), Buffer.from(source));
    files.copyFileFromCd(source, "baseq3", "\xc3\xa9.cfg", NativeRoot.fromHost(base), Buffer.from(source));
    expect(readFileSync(bytePath(join(base, "baseq3"), "\xe9.cfg"), "utf8")).toBe("raw");
    expect(readFileSync(bytePath(join(base, "baseq3"), "\xc3\xa9.cfg"), "utf8")).toBe("utf8");
  });

  test("native CD game directories retain distinct source bytes and display diagnostics", async () => {
    const root = await temporaryRoot(), cd = join(root, "cd-\u6e38\u620f-\u00e9"), base = join(root, "base-\u6e38\u620f");
    const printed: string[] = [];
    const files = new WritableFileSystem({ homePath: join(root, "home"), product: "baseq3",
      print: text => { printed.push(text); } });
    owners.push(files);
    for (const game of ["\xe9", "\xc3\xa9"]) {
      await mkdir(bytePath(cd, `${game}/nested`), { recursive: true });
      await writeFile(bytePath(cd, `${game}/nested/\xe9.cfg`), Buffer.from(game, "latin1"));
      await writeFile(bytePath(cd, `${game}/nested/\xc3\xa9.cfg`), Buffer.from(`${game}+`, "latin1"));
    }
    for (const game of ["\xe9", "\xc3\xa9"]) {
      for (const path of ["nested/\xe9.cfg", "nested/\xc3\xa9.cfg"]) {
        files.copyFileFromCd(join(cd, game), game, path, NativeRoot.fromHost(base), bytePath(cd, game));
        expect(readFileSync(bytePath(base, `${game}/${path}`))).toEqual(readFileSync(bytePath(cd, `${game}/${path}`)));
      }
    }
    expect(printed).toEqual(["\xe9", "\xc3\xa9"].flatMap(game => ["nested/\xe9.cfg", "nested/\xc3\xa9.cfg"]
      .map(path => `copy ${join(cd, game, path)} to ${join(NativeRoot.fromHost(base).sourceText, game, path)}\n`)));
  });

  test("native CD copying retains journal exclusion and retirement before source acquisition", async () => {
    const root = await temporaryRoot(), cd = join(root, "cd-\u6e38\u620f"), base = join(root, "base");
    const source = bytePath(cd, "\xe9");
    await mkdir(source, { recursive: true });
    await writeFile(bytePath(cd, "\xe9/journal.dat.backup"), "journal");
    await writeFile(bytePath(cd, "\xe9/normal.cfg"), "normal");
    const printed: string[] = [];
    const files = new WritableFileSystem({ homePath: join(root, "home"), product: "baseq3",
      print: text => { printed.push(text); } });
    owners.push(files);
    files.copyFileFromCd(join(cd, "\xe9"), "baseq3", "journal.dat.backup", NativeRoot.fromHost(base), source);
    expect(printed).toEqual([`copy ${join(cd, "\xe9", "journal.dat.backup")} to ${join(base, "baseq3", "journal.dat.backup")}\n`,
      "Ignoring journal files\n"]);
    expect(existsSync(base)).toBe(false);
    const handles = new SourceFileHandles();
    handleOwners.push(handles);
    const retiring = new WritableFileSystem({ homePath: join(root, "home"), product: "baseq3", handles,
      print: () => { handles.close(); } });
    owners.push(retiring);
    expect(() => retiring.copyFileFromCd(join(cd, "\xe9"), "baseq3", "normal.cfg", NativeRoot.fromHost(base), source)).toThrow("closed");
    expect(existsSync(base)).toBe(false);
    expect(readFileSync(bytePath(cd, "\xe9/normal.cfg"), "utf8")).toBe("normal");
  });

  test("source byte symlinks reject before truncating coexisting names", async () => {
    const root = await temporaryRoot(), files = owner(join(root, "home"));
    await mkdir(NativeRoot.fromSource(files.rootPath).resolvedBytes(), { recursive: true });
    const outside = join(root, "outside.cfg");
    await writeFile(outside, "preserved");
    await symlink(outside, bytePath(NativeRoot.fromSource(files.rootPath), "\xe9.cfg"));
    await writeFile(bytePath(NativeRoot.fromSource(files.rootPath), "\xc3\xa9.cfg"), "other");
    expect(() => files.openWrite("\xe9.cfg", false)).toThrow("symbolic link");
    expect(() => files.fileExists("\xe9.cfg")).toThrow("symbolic link");
    expect(readFileSync(outside, "utf8")).toBe("preserved");
    expect(readFileSync(bytePath(NativeRoot.fromSource(files.rootPath), "\xc3\xa9.cfg"), "utf8")).toBe("other");
  });

  test("source byte containment rejects byte-distinct moved roots before truncation", async () => {
    const root = await temporaryRoot(), home = join(root, "\ufffd");
    const { files, handles } = sharedOwner(home);
    await mkdir(join(home, "configs"), { recursive: true });
    await mkdir(bytePath(root, "\xff"));
    await writeFile(bytePath(home, "configs/\xe9.cfg"), "raw retained");
    await writeFile(bytePath(home, "configs/\xc3\xa9.cfg"), "utf8 retained");
    expect(() => files.openServerBinaryWrite("configs/\xe9.cfg", handles.selectFree(), () => {
      renameSync(join(home, "configs"), bytePath(root, "\xff/configs"));
    })).toThrow("escapes pinned product root");
    expect(readFileSync(bytePath(root, "\xff/configs/\xe9.cfg"), "utf8")).toBe("raw retained");
    expect(readFileSync(bytePath(root, "\xff/configs/\xc3\xa9.cfg"), "utf8")).toBe("utf8 retained");
  });

  test("source paths reject NUL and non-byte code units before opening or callbacks", async () => {
    const root = await temporaryRoot();
    let callbacks = 0;
    const files = new WritableFileSystem({ homePath: join(root, "home"), product: "baseq3", print: () => undefined,
      beforeProductOpen: () => { callbacks += 1; } });
    owners.push(files);
    for (const path of ["bad\0name", "\u0100.cfg", "\ud800.cfg", "\u012e\u012e/escape.cfg"]) {
      expect(() => files.openWrite(path, false)).toThrow(RangeError);
      expect(() => files.openAppend(path, false)).toThrow(RangeError);
      expect(() => files.fileExists(path)).toThrow(RangeError);
      expect(() => files.renameFile(path, "target", () => { callbacks += 1; })).toThrow(RangeError);
    }
    expect(callbacks).toBe(0);
    expect(existsSync(files.rootPath)).toBe(false);
  });

  test("live home roots are sampled after append sound clearing and retained through the open diagnostic", async () => {
    const root = await temporaryRoot();
    let home = join(root, "initial");
    const afterSound = join(root, "after-sound"), afterDebug = join(root, "after-debug");
    const printed: string[] = [];
    const files = new WritableFileSystem({ homePath: () => home, product: "baseq3", print: () => undefined,
      clearSoundBuffer: () => { home = afterSound; },
      beforeProductOpen: (path, mode) => { printed.push(`${mode} ${path}`); home = afterDebug; } });
    owners.push(files);
    const append = files.openAppend("source.log", false);
    if (append === null) throw new Error("Expected source append open");
    append.write("append"); append.close();
    expect(printed).toEqual([`append ${join(afterSound, "baseq3", "source.log")}`]);
    expect(await readFile(join(afterSound, "baseq3", "source.log"), "utf8")).toBe("append");
    expect(existsSync(join(afterDebug, "baseq3", "source.log"))).toBe(false);
    const write = files.openWrite("source.log", false);
    if (write === null) throw new Error("Expected source write open");
    write.write("write"); write.close();
    expect(printed[1]).toBe(`write ${join(afterDebug, "baseq3", "source.log")}`);
    expect(await readFile(join(afterDebug, "baseq3", "source.log"), "utf8")).toBe("write");
    home = "";
    expect(files.rootPath).toBe("/baseq3");
    home = "bad\0home";
    expect(() => files.rootPath).toThrow("contains NUL");
  });

  test("fileExists probes the current home game tree without creating paths or consuming slots", async () => {
    const root = await temporaryRoot(), home = join(root, "home");
    const { files, handles } = sharedOwner(home);
    expect(files.fileExists("screenshots/shot0000.tga")).toBe(false);
    expect(existsSync(home)).toBe(false);
    await mkdir(join(home, "baseq3", "screenshots"), { recursive: true });
    await writeFile(join(home, "baseq3", "screenshots", "shot0000.tga"), "original");
    await writeFile(join(home, "home-only.tga"), "outside game");
    const occupied = Array.from({ length: 63 }, () => openRead(handles, join(home, "home-only.tga")));
    expect(() => handles.selectFree()).toThrow(FileHandleExhaustionError);
    expect(files.fileExists("screenshots\\shot0000.tga")).toBe(true);
    expect(files.fileExists("screenshots/shot0001.tga")).toBe(false);
    expect(files.fileExists("home-only.tga")).toBe(false);
    expect(files.fileExists("screenshots")).toBe(true);
    expect(files.fileExists("screenshots/")).toBe(true);
    expect(files.fileExists("screenshots/.")).toBe(true);
    expect(files.fileExists(".")).toBe(true);
    expect(files.fileExists("screenshots/shot0000.tga/")).toBe(false);
    expect(files.fileExists("screenshots/shot0000.tga/child")).toBe(false);
    expect(await readFile(join(home, "baseq3", "screenshots", "shot0000.tga"), "utf8")).toBe("original");
    expect(() => handles.selectFree()).toThrow(FileHandleExhaustionError);
    files.setGameDirectory("missionpack");
    expect(files.fileExists("screenshots/shot0000.tga")).toBe(false);
    expect(existsSync(join(home, "missionpack"))).toBe(false);
    for (const file of occupied) handles.closeFile(file);
    handles.close();
    expect(() => files.fileExists("screenshots/shot0000.tga")).toThrow("closed");
  });

  test("fileExists rejects unsafe and symlink paths and reports actual read-open denial", async () => {
    const root = await temporaryRoot(), home = join(root, "home"), product = join(home, "baseq3");
    await mkdir(product, { recursive: true });
    const target = join(product, "unreadable.tga");
    await writeFile(target, "preserved");
    const files = owner(home);
    expect(files.fileExists("unreadable.tga")).toBe(true);
    await chmod(target, 0);
    try { expect(files.fileExists("unreadable.tga")).toBe(false); }
    finally { await chmod(target, 0o600); }
    await symlink(target, join(product, "linked.tga"));
    await symlink(product, join(product, "linked-parent"));
    for (const path of ["../outside", "/absolute", "bad\0path", ""]) {
      expect(() => files.fileExists(path)).toThrow(RangeError);
    }
    expect(() => files.fileExists("linked.tga")).toThrow("symbolic link");
    expect(() => files.fileExists("linked-parent/unreadable.tga")).toThrow("symbolic link");
    expect(await readFile(target, "utf8")).toBe("preserved");
  });

  test("reads, config writes and game logs share 63 slots while direct bot logs stay outside the budget", async () => {
    const root = await temporaryRoot();
    const inputPath = join(root, "input.cfg");
    await writeFile(inputPath, "R");
    const { files, handles } = sharedOwner(join(root, "home"));
    const reads = Array.from({ length: 61 }, () => openRead(handles, inputPath));
    const game = files.openAppend("games.log", true);
    const config = files.openWrite("q3config.cfg", false);
    if (game === null || config === null) throw new Error("Expected real writable files");
    game.write("game\n");
    config.write("seta value 1\n");
    expect(() => handles.selectFree()).toThrow(FileHandleExhaustionError);
    expect(() => files.openAppend("not-created/deep.log", false)).toThrow(FileHandleExhaustionError);
    expect(() => files.openWrite("q3config.cfg", false)).toThrow(FileHandleExhaustionError);
    expect(existsSync(join(files.rootPath, "not-created"))).toBe(false);
    expect(await readFile(join(files.rootPath, "q3config.cfg"), "utf8")).toBe("seta value 1\n");
    expect(() => files.openAppend("../unsafe.log", false)).toThrow(RangeError);

    const bot = files.openBotLog("bot.log");
    if (bot.kind !== "opened") throw new Error("Expected direct bot log despite full source table");
    expect(bot.stream.write(new Uint8Array([66]))).toEqual({ kind: "ok" });
    expect(() => handles.selectFree()).toThrow(FileHandleExhaustionError);
    files.closeAll();
    expect(handles.selectFree().slot).toBe(62);
    for (const handle of reads) {
      const byte = new Uint8Array(1);
      expect(handles.readInto(handle, byte)).toBe(1);
      expect([...byte]).toEqual([82]);
    }
    expect(() => bot.stream.write(new Uint8Array())).toThrow("closed");
    expect(await readFile(join(files.rootPath, "bot.log"), "utf8")).toBe("B");
  });

  test("failed secure acquisition leaves the selected source slot free for close and reuse", async () => {
    const root = await temporaryRoot();
    const { files, handles } = sharedOwner(join(root, "home"));
    await mkdir(join(files.rootPath, "directory"), { recursive: true });
    await writeFile(join(root, "outside.log"), "preserved");
    await symlink(join(root, "outside.log"), join(files.rootPath, "linked.log"));
    const first = handles.selectFree();
    expect(files.openWrite("directory", false)).toBeNull();
    expect(handles.selectFree()).toBe(first);
    expect(() => files.openAppend("linked.log", false)).toThrow("symbolic link");
    expect(handles.selectFree()).toBe(first);
    const log = files.openAppend("new.log", true);
    if (log === null) throw new Error("Expected actual writable file");
    expect(handles.selectFree().slot).toBe(2);
    log.close();
    expect(handles.selectFree()).toBe(first);
    const replacement = files.openWrite("new.log", false);
    if (replacement === null) throw new Error("Expected replacement writable file");
    log.close();
    replacement.write("replacement");
    expect(await readFile(join(files.rootPath, "new.log"), "utf8")).toBe("replacement");
  });

  test("source restart closes sized reads and keeps zero-size source writes alive", async () => {
    const root = await temporaryRoot();
    const inputPath = join(root, "input.cfg");
    await writeFile(inputPath, "read");
    const { files, handles } = sharedOwner(join(root, "home"));
    const read = openRead(handles, inputPath);
    const game = files.openAppend("games.log", true);
    const config = files.openWrite("q3config.cfg", false);
    if (game === null || config === null) throw new Error("Expected actual writable files");
    game.write("before\n");
    config.write("before\n");
    handles.closeSizedFiles();
    expect(handles.selectFree()).toBe(read);
    expect(() => handles.readInto(read, new Uint8Array(1))).toThrow("not readable");
    game.write("after\n");
    config.write("after\n");
    expect(await readFile(join(files.rootPath, "games.log"), "utf8")).toBe("before\nafter\n");
    expect(await readFile(join(files.rootPath, "q3config.cfg"), "utf8")).toBe("before\nafter\n");
    handles.close();
    expect(() => game.write("closed")).toThrow("closed");
    expect(() => config.write("closed")).toThrow("closed");
    expect(() => files.closeAll()).not.toThrow();
  });

  test("managed log cleanup cannot close a reused source slot after an external source close", async () => {
    const root = await temporaryRoot();
    const inputPath = join(root, "input.cfg");
    await writeFile(inputPath, "R");
    const { files, handles } = sharedOwner(join(root, "home"));
    const read = openRead(handles, inputPath);
    handles.closeFile(read);
    const log = files.openAppend("games.log", false);
    if (log === null) throw new Error("Expected actual writable file");
    handles.closeFile(read);
    const replacementRead = openRead(handles, inputPath);
    expect(replacementRead).toBe(read);
    expect(() => log.write("stale")).toThrow("closed");
    expect(() => files.closeAll()).not.toThrow();
    const byte = new Uint8Array(1);
    expect(handles.readInto(replacementRead, byte)).toBe(1);
    expect([...byte]).toEqual([82]);
    expect(await readFile(join(files.rootPath, "games.log"), "utf8")).toBe("");
  });

  test("ordinary writes preserve source filenames including key-like paths", async () => {
    const root = await temporaryRoot();
    const { files, handles } = sharedOwner(join(root, "home"));
    for (const path of ["Q3KEY", "logs\\QuAkE3CdKeY.backup", "config/q3key-extra.cfg"]) {
      const file = files.openAppend(path, false);
      if (file === null) throw new Error("Synthetic ordinary append failed");
      file.write("synthetic fixture"); file.close();
      expect(files.fileExists(path)).toBe(true);
      expect(await readFile(join(files.rootPath, path.replaceAll("\\", "/")), "utf8")).toBe("synthetic fixture");
    }
    expect(handles.selectFree().slot).toBe(1);
    expect(existsSync(files.rootPath)).toBe(true);
  });

  test("creates the explicit product tree, appends real bytes, and exposes synchronous writes before close", async () => {
    const root = await temporaryRoot();
    const homePath = join(root, "home");
    const files = owner(homePath, "missionpack");
    const outputPath = join(homePath, "missionpack", "Logs", "Games.LOG");
    expect(files.rootPath).toBe(resolve(homePath, "missionpack"));
    expect(existsSync(files.rootPath)).toBe(false);

    const first = files.openAppend("Logs\\Games.LOG", true);
    expect(first).not.toBeNull();
    first?.write("first\n");
    expect(await readFile(outputPath, "utf8")).toBe("first\n");
    first?.close();
    first?.close();
    expect(() => first?.write("closed\n")).toThrow("closed");

    const second = files.openAppend("Logs/Games.LOG", false);
    expect(second).not.toBeNull();
    second?.write("second\n");
    second?.close();
    expect(await readFile(outputPath, "utf8")).toBe("first\nsecond\n");
  });

  test("secure write-open truncates existing bytes and subsequent writes replace rather than append", async () => {
    const root = await temporaryRoot();
    const homePath = join(root, "home");
    const outputPath = join(homePath, "baseq3", "configs", "q3config.cfg");
    await mkdir(join(homePath, "baseq3", "configs"), { recursive: true });
    await writeFile(outputPath, "old configuration bytes");
    const files = owner(homePath);

    const first = files.openWrite("configs/q3config.cfg", true);
    expect(first).not.toBeNull();
    expect(await readFile(outputPath, "utf8")).toBe("");
    first?.write("seta one 1\n");
    expect(await readFile(outputPath, "utf8")).toBe("seta one 1\n");
    first?.close();

    const second = files.openWrite("configs\\q3config.cfg", false);
    expect(second).not.toBeNull();
    second?.write("seta two 2\n");
    second?.close();
    expect(await readFile(outputPath, "utf8")).toBe("seta two 2\n");
  });

  test("write-open rejects symlinked targets and parents before destroying existing bytes", async () => {
    const root = await temporaryRoot();
    const homePath = join(root, "home");
    const productPath = join(homePath, "baseq3");
    const outside = join(root, "outside");
    const outsideTarget = join(outside, "preserve.cfg");
    await mkdir(productPath, { recursive: true });
    await mkdir(outside);
    await writeFile(outsideTarget, "must remain intact");
    await symlink(outsideTarget, join(productPath, "linked.cfg"));
    await symlink(outside, join(productPath, "linked-parent"));
    const files = owner(homePath);

    expect(() => files.openWrite("linked.cfg", true)).toThrow("symbolic link");
    expect(() => files.openWrite("linked-parent/preserve.cfg", true)).toThrow("symbolic link");
    expect(await readFile(outsideTarget, "utf8")).toBe("must remain intact");
  });

  test("write-open refuses a moved parent and leaves its original file intact", async () => {
    const root = await temporaryRoot();
    const homePath = join(root, "home");
    const productPath = join(homePath, "baseq3");
    const originalParent = join(productPath, "configs");
    const movedParent = join(root, "moved-configs");
    await mkdir(originalParent, { recursive: true });
    await writeFile(join(originalParent, "server.cfg"), "preserve moved bytes");
    await rename(originalParent, movedParent);
    await symlink(movedParent, originalParent);
    const files = owner(homePath);

    expect(() => files.openWrite("configs/server.cfg", true)).toThrow("symbolic link");
    expect(await readFile(join(movedParent, "server.cfg"), "utf8")).toBe("preserve moved bytes");
  });

  test("write-open permission failure is nonfatal and does not truncate", async () => {
    const root = await temporaryRoot();
    const homePath = join(root, "home");
    const outputPath = join(homePath, "baseq3", "readonly.cfg");
    await mkdir(join(homePath, "baseq3"), { recursive: true });
    await writeFile(outputPath, "readonly bytes");
    await chmod(outputPath, 0o444);
    const diagnostics: string[] = [];
    const files = new WritableFileSystem({
      homePath, product: "baseq3",
      print: text => { diagnostics.push(text); return undefined; },
    });
    owners.push(files);

    expect(files.openWrite("readonly.cfg", true)).toBeNull();
    expect(await readFile(outputPath, "utf8")).toBe("readonly bytes");
    expect(diagnostics).toEqual([]);
  });

  test("binary seek shares the source handle cursor and overwrites the retained file with relative, end and hole writes", async () => {
    const root = await temporaryRoot();
    const { files, handles } = sharedOwner(join(root, "home"));
    const handle = handles.selectFree(), file = files.openBinaryWrite("seek.dat");
    if (file === null) throw new Error("Expected actual binary writable file");
    const path = join(files.rootPath, "seek.dat"), descriptor = handles.writeDescriptor(handle);
    expect(file.tell()).toBe(0);
    expect(file.writeBytes(new Uint8Array([65, 66, 67, 68, 69, 70]))).toBe(6);
    expect(file.tell()).toBe(6);
    expect(file.seek(1, "set")).toBe(0);
    expect(file.tell()).toBe(1);
    expect(handles.tellWrite(handle)).toBe(1);
    expect(file.writeBytes(new Uint8Array([120, 121]))).toBe(2);
    expect(file.tell()).toBe(3);
    expect(handles.seekWrite(handle, -1, "current")).toBe(0);
    expect(file.tell()).toBe(2);
    expect(file.writeBytes(new Uint8Array([90]))).toBe(1);
    expect(file.seek(-2, "end")).toBe(0);
    expect(file.tell()).toBe(4);
    expect(file.writeBytes(new Uint8Array([81]))).toBe(1);
    expect(await readFile(path, "utf8")).toBe("AxZDQF");
    expect(file.seek(3, "end")).toBe(0);
    expect(file.tell()).toBe(9);
    expect(fstatSync(descriptor).size).toBe(6);
    expect(file.writeBytes(new Uint8Array([33]))).toBe(1);
    expect(file.tell()).toBe(10);
    expect(new Uint8Array(await readFile(path))).toEqual(new Uint8Array([65, 120, 90, 68, 81, 70, 0, 0, 0, 33]));
    // The shared FILE cursor advances while positioned writes preserve the kernel descriptor offset.
    expect(/^pos:\s*(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${descriptor}`, "utf8"))?.[1]).toBe("6");
    const moved = join(files.rootPath, "retained.dat");
    await rename(path, moved);
    await writeFile(path, "replacement");
    expect(file.seek(0, "end")).toBe(0);
    expect(file.tell()).toBe(10);
    expect(file.writeBytes(new Uint8Array([63]))).toBe(1);
    expect(await readFile(path, "utf8")).toBe("replacement");
    expect(new Uint8Array(await readFile(moved))).toEqual(new Uint8Array([65, 120, 90, 68, 81, 70, 0, 0, 0, 33, 63]));
    expect(file.seek(0, "set")).toBe(0);
    expect(file.writeBytes(new Uint8Array())).toBe(0);
    expect(file.tell()).toBe(0);
  });

  test("end-relative seeks observe the current file size while tell retains the stream cursor", async () => {
    const root = await temporaryRoot(), files = owner(join(root, "home"));
    const file = files.openBinaryWrite("resize.dat");
    if (file === null) throw new Error("Expected actual binary writable file");
    const path = join(files.rootPath, "resize.dat");
    expect(file.writeBytes(new Uint8Array([1, 2, 3, 4]))).toBe(4);
    expect(file.seek(-1, "current")).toBe(0);
    await writeFile(path, new Uint8Array(10).fill(7));
    expect(file.tell()).toBe(3);
    expect(file.seek(-2, "end")).toBe(0);
    expect(file.tell()).toBe(8);
    await writeFile(path, new Uint8Array([6, 5]));
    expect(file.tell()).toBe(8);
    expect(file.seek(-1, "end")).toBe(0);
    expect(file.tell()).toBe(1);
    expect(file.writeBytes(new Uint8Array([9]))).toBe(1);
    expect(new Uint8Array(await readFile(path))).toEqual(new Uint8Array([6, 9]));
  });

  test("failed seeks preserve the cursor and retired binary views cannot seek a reused common slot", async () => {
    const root = await temporaryRoot();
    const { files, handles } = sharedOwner(join(root, "home"));
    const handle = handles.selectFree(), file = files.openBinaryWrite("invalid-seek.dat");
    if (file === null) throw new Error("Expected actual binary writable file");
    expect(file.writeBytes(new Uint8Array([1, 2, 3]))).toBe(3);
    for (const offset of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(file.seek(offset, "set")).toBe(-1);
      expect(file.tell()).toBe(3);
    }
    expect(file.seek(-4, "current")).toBe(-1);
    expect(file.seek(-4, "end")).toBe(-1);
    expect(file.seek(Number.MAX_SAFE_INTEGER, "current")).toBe(-1);
    expect(file.tell()).toBe(3);
    expect(file.seek(1, "set")).toBe(0);
    const descriptor = handles.writeDescriptor(handle);
    closeSync(descriptor);
    expect(file.seek(0, "set")).toBe(-1);
    expect(file.tell()).toBe(1);
    expect(() => handles.closeFile(handle)).toThrow();
    const replacement = files.openBinaryWrite("replacement.dat");
    if (replacement === null) throw new Error("Expected replacement binary writable file");
    expect(() => file.seek(0, "set")).toThrow("closed");
    expect(() => file.tell()).toThrow("closed");
    expect(() => file.writeBytes(new Uint8Array([8]))).toThrow("closed");
    file.close();
    expect(replacement.writeBytes(new Uint8Array([9]))).toBe(1);
    expect(replacement.seek(0, "set")).toBe(0);
    expect(replacement.tell()).toBe(0);
    replacement.close();
    expect(() => replacement.seek(0, "end")).toThrow("closed");
    expect(() => handles.seekWrite(handle, 0, "set")).toThrow("not writable");
  });

  test("public FS_FTell narrows to int32 while relative seek retains the full FILE position", async () => {
    const root = await temporaryRoot();
    const { files, handles } = sharedOwner(join(root, "home"));
    const handle = handles.selectFree(), file = files.openBinaryWrite("wide-seek.dat");
    if (file === null) throw new Error("Expected actual binary writable file");
    expect(file.seek(0x80000000, "set")).toBe(0);
    expect(file.tell()).toBe(-2147483648);
    expect(handles.tellWrite(handle)).toBe(2147483648);
    expect(file.seek(-1, "current")).toBe(0);
    expect(file.tell()).toBe(2147483647);
    expect(file.seek(2, "current")).toBe(0);
    expect(file.tell()).toBe(-2147483647);
    expect(handles.tellWrite(handle)).toBe(2147483649);
    expect(fstatSync(handles.writeDescriptor(handle)).size).toBe(0);
  });

  test("nonempty append opens retain EOF before the first write and O_APPEND placement after seeking", async () => {
    const root = await temporaryRoot();
    const { files, handles } = sharedOwner(join(root, "home"));
    const path = join(files.rootPath, "append-seek.log");
    await mkdir(NativeRoot.fromSource(files.rootPath).resolvedBytes(), { recursive: true });
    await writeFile(path, "first");
    const handle = handles.selectFree(), log = files.openAppend("append-seek.log", true);
    if (log === null) throw new Error("Expected actual append file");
    expect(handles.tellWrite(handle)).toBe(5);
    expect(handles.seekWrite(handle, -1, "current")).toBe(0);
    expect(handles.tellWrite(handle)).toBe(4);
    await writeFile(path, "first-more");
    expect(handles.tellWrite(handle)).toBe(4);
    await writeFile(path, "first");
    expect(handles.tellWrite(handle)).toBe(4);
    expect(handles.seekWrite(handle, 1, "set")).toBe(0);
    expect(handles.tellWrite(handle)).toBe(1);
    log.write("");
    expect(handles.tellWrite(handle)).toBe(1);
    log.write("-next");
    expect(handles.tellWrite(handle)).toBe(10);
    expect(handles.seekWrite(handle, 5, "end")).toBe(0);
    expect(handles.tellWrite(handle)).toBe(15);
    log.write("!");
    expect(handles.tellWrite(handle)).toBe(11);
    expect(await readFile(path, "utf8")).toBe("first-next!");
  });

  test("positioned partial writes publish their cursor before zero, negative and internal failure handling", async () => {
    const root = await temporaryRoot();
    for (const failure of ["zero", "negative", "internal"] satisfies readonly ("zero" | "negative" | "internal")[]) {
      const handles = new SourceFileHandles();
      handleOwners.push(handles);
      const handle = handles.selectFree(), writeFailure = new Error("write hook failed");
      const diagnostics: { readonly text: string; readonly position: number }[] = [];
      class PartialSeekFiles extends WritableFileSystem {
        readonly positions: (number | null)[] = [];
        protected override writeChunk(descriptor: number, bytes: Uint8Array, offset: number, length: number, position: number | null): number {
          this.positions.push(position);
          if (this.positions.length === 1) return super.writeChunk(descriptor, bytes, offset, Math.min(2, length), position);
          if (failure === "internal") throw writeFailure;
          return failure === "negative" ? -1 : 0;
        }
      }
      const files = new PartialSeekFiles({
        homePath: join(root, "home"), product: "baseq3", handles,
        print: text => { diagnostics.push({ text, position: handles.tellWrite(handle) }); },
      });
      owners.push(files);
      const file = files.openBinaryWrite(`${failure}.dat`);
      if (file === null) throw new Error("Expected actual binary writable file");
      expect(file.seek(3, "set")).toBe(0);
      const bytes = new Uint8Array([21, 22, 23, 24]);
      if (failure === "internal") expect(() => file.writeBytes(bytes)).toThrow(writeFailure);
      else expect(file.writeBytes(bytes)).toBe(0);
      expect(file.tell()).toBe(5);
      expect(files.positions).toEqual(failure === "zero" ? [3, 5, 5] : [3, 5]);
      expect(diagnostics).toEqual(failure === "internal" ? [] : [{
        text: `FS_Write: ${failure === "negative" ? -1 : 0} bytes written\n`, position: 5,
      }]);
      expect(new Uint8Array(await readFile(join(files.rootPath, `${failure}.dat`)))).toEqual(new Uint8Array([0, 0, 0, 21, 22]));
      expect(file.seek(-1, "current")).toBe(0);
      expect(file.tell()).toBe(4);
    }
  });

  test("positioned platform write failures retain actual partial bytes and the source retry budget", async () => {
    const root = await temporaryRoot(), fullDevice = openSync("/dev/full", "w");
    const handles = new SourceFileHandles(), diagnostics: string[] = [];
    handleOwners.push(handles);
    const handle = handles.selectFree();
    class FullSeekFiles extends WritableFileSystem {
      calls = 0;
      protected override writeChunk(descriptor: number, bytes: Uint8Array, offset: number, length: number, position: number | null): number {
        this.calls += 1;
        return this.calls === 1 ? super.writeChunk(descriptor, bytes, offset, Math.min(2, length), position)
          : writeSync(fullDevice, bytes, offset, length, position);
      }
    }
    try {
      const files = new FullSeekFiles({
        homePath: join(root, "home"), product: "baseq3", handles,
        print: text => { expect(handles.tellWrite(handle)).toBe(3); diagnostics.push(text); },
      });
      owners.push(files);
      const file = files.openBinaryWrite("full-seek.dat");
      if (file === null) throw new Error("Expected actual binary writable file");
      expect(file.seek(1, "set")).toBe(0);
      expect(file.writeBytes(new Uint8Array([4, 5, 6, 7]))).toBe(0);
      expect(file.tell()).toBe(3);
      expect(files.calls).toBe(3);
      expect(diagnostics).toEqual(["FS_Write: 0 bytes written\n"]);
      expect(new Uint8Array(await readFile(join(files.rootPath, "full-seek.dat")))).toEqual(new Uint8Array([0, 4, 5]));
    } finally { closeSync(fullDevice); }
  });

  test("handles partial writes until every encoded byte reaches the file", async () => {
    class PartialWritableFileSystem extends WritableFileSystem {
      readonly chunkSizes: number[] = [];

      protected override writeChunk(
        descriptor: number,
        bytes: Uint8Array,
        offset: number,
        length: number,
        position: number | null,
      ): number {
        const chunk = Math.min(3, length);
        this.chunkSizes.push(chunk);
        return super.writeChunk(descriptor, bytes, offset, chunk, position);
      }
    }

    const root = await temporaryRoot();
    const files = new PartialWritableFileSystem({
      homePath: join(root, "home"), product: "baseq3", print: () => undefined,
    });
    owners.push(files);
    const log = files.openAppend("partial.log", true);
    expect(log).not.toBeNull();
    log?.write("abcdefgh");
    log?.close();
    expect(files.chunkSizes).toEqual([3, 3, 2]);
    expect(await readFile(join(files.rootPath, "partial.log"), "utf8")).toBe("abcdefgh");
  });

  test("keeps the source retry budget after progress and reports the second zero write", async () => {
    class StallingWritableFileSystem extends WritableFileSystem {
      calls = 0;

      protected override writeChunk(
        descriptor: number,
        bytes: Uint8Array,
        offset: number,
        length: number,
        position: number | null,
      ): number {
        this.calls += 1;
        if (this.calls === 1 || this.calls === 3) return 0;
        return super.writeChunk(descriptor, bytes, offset, Math.min(1, length), position);
      }
    }

    const root = await temporaryRoot();
    const diagnostics: string[] = [];
    const files = new StallingWritableFileSystem({
      homePath: join(root, "home"), product: "baseq3",
      print: text => { diagnostics.push(text); return undefined; },
    });
    owners.push(files);
    const log = files.openAppend("stall.log", true);
    expect(log).not.toBeNull();
    log?.write("XYZ");
    log?.close();
    expect(files.calls).toBe(3);
    expect(await readFile(join(files.rootPath, "stall.log"), "utf8")).toBe("X");
    expect(diagnostics).toEqual(["FS_Write: 0 bytes written\n"]);
  });

  test("reports the source negative write result without throwing", async () => {
    class NegativeWritableFileSystem extends WritableFileSystem {
      protected override writeChunk(
        _descriptor: number,
        _bytes: Uint8Array,
        _offset: number,
        _length: number,
      ): number {
        return -1;
      }
    }

    const root = await temporaryRoot();
    const diagnostics: string[] = [];
    const files = new NegativeWritableFileSystem({
      homePath: join(root, "home"), product: "baseq3",
      print: text => { diagnostics.push(text); return undefined; },
    });
    owners.push(files);
    const log = files.openAppend("negative.log", true);
    expect(log).not.toBeNull();
    expect(() => log?.write("not written")).not.toThrow();
    log?.close();
    expect(diagnostics).toEqual(["FS_Write: -1 bytes written\n"]);
    expect(await readFile(join(files.rootPath, "negative.log"), "utf8")).toBe("");
  });

  test("does not swallow a diagnostic sink failure", async () => {
    class ZeroWritableFileSystem extends WritableFileSystem {
      protected override writeChunk(
        _descriptor: number,
        _bytes: Uint8Array,
        _offset: number,
        _length: number,
      ): number {
        return 0;
      }
    }

    const root = await temporaryRoot();
    const diagnosticFailure = new Error("diagnostic sink failed");
    const files = new ZeroWritableFileSystem({
      homePath: join(root, "home"), product: "baseq3",
      print: () => { throw diagnosticFailure; },
    });
    owners.push(files);
    const log = files.openAppend("print-failure.log", true);
    expect(log).not.toBeNull();
    expect(() => log?.write("not written")).toThrow(diagnosticFailure);
  });

  test.skipIf(process.platform !== "linux")(
    "keeps actual GameRuntime initialization alive when the log device reports ENOSPC",
    async () => {
      const root = await temporaryRoot();
      const diagnostics: string[] = [];
      const fullDevice = openSync("/dev/full", "w");
      class FullDeviceWritableFileSystem extends WritableFileSystem {
        protected override writeChunk(
          _descriptor: number,
          bytes: Uint8Array,
          offset: number,
          length: number,
        ): number {
          return writeSync(fullDevice, bytes, offset, length, null);
        }
      }

      const files = new FullDeviceWritableFileSystem({
        homePath: join(root, "home"), product: "baseq3",
        print: text => { diagnostics.push(text); return undefined; },
      });
      owners.push(files);
      const harness = createGameVerificationHarness({
        product: "baseq3", map: emptyMap(), gameType: GameType.GT_FFA, levelTime: 1000,
        randomSeed: 42, buildDate: "writable-test", clientNamePrefix: "writer",
        botsReason: "No bot clients in writable test",
      });
      harness.runtime.shutdown(false);
      harness.cvars.set("g_log", "games.log", true);

      let game: GameRuntime | null = null;
      try {
        game = GameRuntime.create({
          ...harness.runtime.options,
          engine: {
            ...harness.engine,
            openLog: (path, synchronous) => files.openAppend(path, synchronous),
          },
        }, harness.owner);
        expect(harness.owner.game).toBe(game);
        expect(diagnostics.length).toBeGreaterThan(0);
        expect(diagnostics.every(text => text === "FS_Write: 0 bytes written\n")).toBe(true);
      } finally {
        game?.shutdown(false);
        closeSync(fullDevice);
      }
      expect(harness.owner.game).toBeNull();
    },
  );

  test("writes source byte strings, stops at NUL, and rejects characters outside Latin-1", async () => {
    const root = await temporaryRoot();
    const files = owner(join(root, "home"));
    const log = files.openAppend("bytes.log", true);
    expect(log).not.toBeNull();
    log?.write("Aé\0ignored漢");
    expect(() => log?.write("漢")).toThrow(RangeError);
    log?.close();
    expect([...await readFile(join(files.rootPath, "bytes.log"))]).toEqual([0x41, 0xe9]);
  });

  test("returns null only when the real append target cannot be opened", async () => {
    const root = await temporaryRoot();
    const homePath = join(root, "home");
    await mkdir(join(homePath, "baseq3", "directory.log"), { recursive: true });
    const files = owner(homePath);
    expect(files.openAppend("directory.log", false)).toBeNull();
    await writeFile(join(homePath, "baseq3", "regular.log"), "unchanged");
    expect(files.openAppend("regular.log/.", true)).toBeNull();
    expect(await readFile(join(homePath, "baseq3", "regular.log"), "utf8")).toBe("unchanged");
    expect(files.openAppend(".", true)).toBeNull();
    await writeFile(join(homePath, "baseq3", "parent-file"), "not a directory");
    expect(files.openAppend("parent-file/child.log", false)).toBeNull();
  });

  test("rejects unsafe paths before creating or opening anything outside the product root", async () => {
    const root = await temporaryRoot();
    const homePath = join(root, "home");
    const files = owner(homePath);
    for (const path of ["../outside.log", "logs/has..dots.log", "/absolute.log", "C:\\absolute.log", "bad\0name.log"]) {
      expect(() => files.openAppend(path, true)).toThrow(RangeError);
    }
    expect(existsSync(join(homePath, "outside.log"))).toBe(false);
    expect(existsSync(files.rootPath)).toBe(false);
  });

  test("rejects parent and target symlinks that could escape the product root", async () => {
    const root = await temporaryRoot();
    const homePath = join(root, "home");
    const productPath = join(homePath, "baseq3");
    const outside = join(root, "outside");
    await mkdir(productPath, { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "target.log"), "outside");
    await symlink(outside, join(productPath, "linked-directory"));
    await symlink(join(outside, "target.log"), join(productPath, "linked-file.log"));
    const files = owner(homePath);

    expect(() => files.openAppend("linked-directory/escape.log", true)).toThrow("symbolic link");
    expect(() => files.openAppend("linked-file.log", true)).toThrow("symbolic link");
    expect(await readFile(join(outside, "target.log"), "utf8")).toBe("outside");
    expect(existsSync(join(outside, "escape.log"))).toBe(false);
  });

  test("rejects a configured product root that is a symbolic link", async () => {
    const root = await temporaryRoot();
    const homePath = join(root, "home");
    const outside = join(root, "outside");
    await mkdir(homePath);
    await mkdir(outside);
    await symlink(outside, join(homePath, "baseq3"));
    const files = owner(homePath);

    expect(() => files.openAppend("escape.log", true)).toThrow("symbolic link");
    expect(existsSync(join(outside, "escape.log"))).toBe(false);
  });

  test("rejects a symbolic-link component in the configured home path", async () => {
    const root = await temporaryRoot();
    const outside = join(root, "outside");
    const linkedHome = join(root, "linked-home");
    await mkdir(outside);
    await symlink(outside, linkedHome);
    const files = owner(join(linkedHome, "profile"));

    expect(() => files.openAppend("escape.log", true)).toThrow("symbolic link");
    expect(existsSync(join(outside, "profile", "baseq3", "escape.log"))).toBe(false);
  });

  test("closeAll closes every live log and remains idempotent", async () => {
    const root = await temporaryRoot();
    const files = owner(join(root, "home"));
    const first = files.openAppend("one.log", false);
    const second = files.openWrite("two.log", true);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    first?.write("one");
    second?.write("two");

    files.closeAll();
    files.closeAll();
    expect(() => first?.write("more")).toThrow("closed");
    expect(() => second?.write("more")).toThrow("closed");
    expect(await readFile(join(files.rootPath, "one.log"), "utf8")).toBe("one");
    expect(await readFile(join(files.rootPath, "two.log"), "utf8")).toBe("two");
  });
});
