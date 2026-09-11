// FS_SV_FOpenFileRead/Write and FS_GetModList from id Software's code/qcommon/files.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { NativeRoot } from "./native-root.ts";
import { closeSync, realpathSync } from "node:fs";
import type { Buffer } from "node:buffer";
import { openDownloadDescriptor, ServerDownloadError, ServerDownloadFile } from "./download-file.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import type { SoundOutput } from "../engine/sound-output.ts";
import type { CommonFileState } from "./filesystem-state.ts";
import type { FileHandle, SourceFileHandles } from "./file-handles.ts";
import { normalizeAssetPath } from "./pk3.ts";
import { checkListBytes, listLooseNames, looseRequestPath, openLooseDescriptor, pathCaseEqual } from "./vfs.ts";
import type { OpenedRead, TrackedVirtualFileSystem } from "./vfs.ts";
import type { WritableBinaryFile } from "./writable-files.ts";

function osPath(root: NativeRoot, filename: string): string {
  const path = `${root.sourceText}/${looseRequestPath(filename)}`;
  if (path.length >= 4096) throw new RangeError("Server file path exceeds the supported Unix MAX_OSPATH");
  return path;
}

function canonicalRoot(root: NativeRoot): Buffer | undefined {
  try { return realpathSync(root.resolvedBytes(), { encoding: "buffer" }); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return undefined;
    throw error;
  }
}

function listRootNames(root: NativeRoot, path: string, extension: string): readonly string[] {
  const directory = canonicalRoot(root);
  return directory === undefined ? [] : listLooseNames(directory, path, extension);
}

/** Server-relative loose files share common's source handles, including its private zero row. */
export class ServerFileSystem {
  constructor(
    private readonly common: CommonFileState,
    private readonly handles: SourceFileHandles,
    private readonly sound: SoundOutput,
    private readonly cvars: CvarRegistry,
    private readonly print: (text: string) => undefined,
  ) {}

  private assertCurrent(view: TrackedVirtualFileSystem): void {
    if (this.common.current !== view) throw new Error("Filesystem mounts changed during server file operation");
  }

  private openAt(root: NativeRoot, filename: string, label: "fs_homepath" | "fs_basepath" | "fs_cdpath", file: FileHandle | null,
    view: TrackedVirtualFileSystem, profile: "ordinary" | "download"): void {
    const path = osPath(root, filename);
    const debug = this.cvars.get("fs_debug");
    if (debug === undefined) throw new Error("Server filesystem requires registered fs_debug");
    if (debug.integerValue !== 0) {
      this.print(`FS_SV_FOpenFileRead (${label})${label === "fs_cdpath" ? " " : ""}: ${path}\n`);
      this.assertCurrent(view);
    }
    // Empty fs_cdpath builds /filename in the source, never a cwd-relative path.
    if (profile === "download") {
      const opened = root.sourceText === "" ? undefined : openDownloadDescriptor(root, filename);
      this.handles.assignServerRead(file, opened?.descriptor, opened?.root ?? null);
    } else {
      const directory = canonicalRoot(root);
      this.handles.assignServerRead(file, directory === undefined ? undefined : openLooseDescriptor(directory, looseRequestPath(filename)));
    }
  }

  openRead(filename: string, profile: "ordinary" | "download" = "ordinary"): OpenedRead | null {
    const view = this.common.current;
    normalizeAssetPath(filename);
    let file: FileHandle | null = this.handles.selectFree();
    this.handles.setName(file, filename);
    this.sound.clearSoundBuffer();
    this.assertCurrent(view);
    const roots = this.common.roots;
    this.openAt(roots.homePath, filename, "fs_homepath", file, view, profile);
    if (!this.handles.serverReadOccupied(file) && !pathCaseEqual(roots.homePath.sourceText, roots.dataPath.sourceText)) {
      this.openAt(roots.dataPath, filename, "fs_basepath", file, view, profile);
      if (!this.handles.serverReadOccupied(file)) file = null;
    }
    if (!this.handles.serverReadOccupied(file)) this.openAt(roots.cdPath ?? NativeRoot.fromSource(""), filename, "fs_cdpath", file, view, profile);
    if (!this.handles.serverReadOccupied(file) || file === null) return null;
    try {
      const length = this.handles.captureLooseLength(file);
      if (!Number.isSafeInteger(length) || length < 0 || length > 0x7fff_ffff) {
        if (profile === "download") throw new ServerDownloadError("size", filename,
          `Server download file size ${length} is outside signed 32-bit protocol range`, undefined);
        throw new RangeError("Server file length exceeds the source signed 32-bit return boundary");
      }
      return { file, length };
    } catch (cause) {
      if (profile !== "download") throw cause;
      try { this.handles.closeFile(file); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], "Download length capture and release failed"); }
      if (cause instanceof Error && "code" in cause && typeof cause.code === "string")
        throw new ServerDownloadError("io", filename, `Cannot inspect server download file: ${filename}`, cause);
      throw cause;
    }
  }

  openDownload(filename: string): ServerDownloadFile | null {
    try { normalizeAssetPath(filename); }
    catch (cause) { throw new ServerDownloadError("path", filename, `Invalid server download path: ${filename}`, cause); }
    const opened = this.openRead(filename, "download");
    if (opened === null) return null;
    return new ServerDownloadFile(this.handles.borrowLooseRead(opened.file), opened.length, filename);
  }

  openWrite(filename: string): WritableBinaryFile | null {
    return this.write(filename, "truncate");
  }

  openWriteExclusive(filename: string): WritableBinaryFile | null {
    return this.write(filename, "exclusive");
  }

  private write(filename: string, mode: "truncate" | "exclusive"): WritableBinaryFile | null {
    const view = this.common.current;
    const path = osPath(this.common.roots.homePath, filename);
    const file = this.handles.selectFree();
    const debug = this.cvars.get("fs_debug");
    if (debug === undefined) throw new Error("Server filesystem requires registered fs_debug");
    if (debug.integerValue !== 0) {
      this.print(`FS_SV_FOpenFileWrite: ${path}\n`); this.assertCurrent(view);
    }
    return this.common.writable.openServerBinaryWrite(filename, file, () => {
      this.assertCurrent(view);
      const developer = this.cvars.get("developer");
      if (developer !== undefined && developer.integerValue !== 0) {
        this.print(`writing to: ${path}\n`); this.assertCurrent(view);
      }
    }, mode);
  }

  exists(filename: string): boolean {
    this.common.current;
    normalizeAssetPath(filename);
    osPath(this.common.roots.homePath, filename);
    const directory = canonicalRoot(this.common.roots.homePath);
    const descriptor = directory === undefined ? undefined : openLooseDescriptor(directory, looseRequestPath(filename));
    if (descriptor === undefined) return false;
    closeSync(descriptor);
    return true;
  }

  rename(from: string, to: string): void {
    this.renameOrdinary(from, to, "server");
  }

  renameGame(from: string, to: string): void {
    this.renameOrdinary(from, to, "game");
  }

  private renameOrdinary(from: string, to: string, scope: "server" | "game"): void {
    const view = this.common.current;
    this.sound.clearSoundBuffer();
    this.assertCurrent(view);
    const beforeRename = (root: string): void => {
      const source = osPath(NativeRoot.fromSource(root), from), destination = osPath(NativeRoot.fromSource(root), to);
      const debug = this.cvars.get("fs_debug");
      if (debug === undefined) throw new Error("Server filesystem requires registered fs_debug");
      if (debug.integerValue !== 0) {
        this.print(`${scope === "server" ? "FS_SV_Rename" : "FS_Rename"}: ${source} --> ${destination}\n`);
        this.assertCurrent(view);
      }
    };
    if (scope === "server") this.common.writable.renameServerFile(from, to, beforeRename);
    else this.common.writable.renameFile(from, to, beforeRename);
  }

  renameNoReplace(from: string, to: string): void {
    const view = this.common.current;
    const source = osPath(this.common.roots.homePath, from), destination = osPath(this.common.roots.homePath, to);
    this.sound.clearSoundBuffer();
    this.assertCurrent(view);
    const debug = this.cvars.get("fs_debug");
    if (debug === undefined) throw new Error("Server filesystem requires registered fs_debug");
    if (debug.integerValue !== 0) {
      this.print(`FS_SV_Rename: ${source} --> ${destination}\n`);
      this.assertCurrent(view);
    }
    this.common.writable.renameServerFileNoReplace(from, to);
  }

  closeZeroHandle(): void {
    const view = this.common.current;
    this.handles.closeZeroHandle();
    this.assertCurrent(view);
  }

  getModList(destination: Uint8Array): number {
    const view = this.common.current;
    if (destination.byteLength === 0) throw new RangeError("Mod listing requires a nonempty destination");
    destination[0] = 0;
    const roots = this.common.roots;
    const names: string[] = [];
    for (const root of [roots.homePath, roots.dataPath, roots.cdPath ?? NativeRoot.fromSource("")]) {
      // Sys_ListFiles("") fails; only FS_BuildOSPath adds a leading separator.
      if (root.sourceText !== "") names.push(...listRootNames(root, "", "/"));
    }
    const seen: string[] = [];
    let total = 0, count = 0;
    for (const name of names) {
      if (seen.some(previous => pathCaseEqual(previous, name))) continue;
      seen.push(name);
      if (pathCaseEqual(name, "baseq3") || name.startsWith(".")) continue;
      let hasPaks = false;
      for (const root of [roots.dataPath, roots.cdPath ?? NativeRoot.fromSource(""), roots.homePath]) {
        osPath(root, name);
        if (listRootNames(root, name, ".pk3").length > 0) { hasPaks = true; break; }
      }
      if (!hasPaks) continue;
      checkListBytes(name, "Mod directory");
      let description = name;
      const opened = this.openRead(`${name}/description.txt`);
      this.assertCurrent(view);
      if (opened !== null && opened.length > 0) {
        const bytes = new Uint8Array(48);
        const copied = this.handles.readLooseDirect(opened.file, bytes);
        description = "";
        for (const byte of bytes.subarray(0, copied)) { if (byte === 0) break; description += String.fromCharCode(byte); }
        this.handles.closeFile(opened.file);
      }
      // Source keeps a successfully opened zero-length description handle alive.
      const length = name.length + 1 + description.length + 1;
      if (total + length + 2 >= destination.byteLength) break;
      for (const text of [name, description]) {
        for (let index = 0; index < text.length; index++) destination[total++] = text.charCodeAt(index);
        destination[total++] = 0;
      }
      count++;
    }
    return count;
  }
}
