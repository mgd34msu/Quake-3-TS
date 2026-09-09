// Ported from id Software's code/qcommon/files.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  realpathSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Product } from "../shared/definitions.ts";
import { BufferedLog } from "./buffered-log.ts";
import { SourceFileHandles } from "./file-handles.ts";
import type { FileHandle, FileSeekOrigin, WriteFileLifetime } from "./file-handles.ts";
import type { BotLogIoResult, BotLogOpenResult } from "../botlib/log.ts";
import { checkedGameDirectory, openLooseDescriptor } from "./vfs.ts";
import { CommonError } from "../core/common-error.ts";

export interface WritableLog {
  write(text: string): void;
  close(): void;
}

export interface WritableBinaryFile {
  writeBytes(bytes: Uint8Array): number;
  tell(): number;
  seek(offset: number, origin: FileSeekOrigin): number;
  close(): void;
}

export interface WritableFileSystemOptions {
  readonly homePath: string | (() => string);
  readonly product: Product;
  readonly print: (text: string) => undefined;
  readonly handles?: SourceFileHandles;
  readonly clearSoundBuffer?: () => void;
  readonly beforeProductOpen?: (path: string, mode: "write" | "append") => void;
}

type PathInspection =
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable"; readonly error: unknown }
  | { readonly kind: "present"; readonly stats: Stats };

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function isPlatformWriteFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "code" in error && typeof error.code === "string"
    && "errno" in error && typeof error.errno === "number"
    && "syscall" in error && error.syscall === "write";
}

function isPlatformFileFailure(error: unknown): error is Error {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    && "errno" in error && typeof error.errno === "number"
    && "syscall" in error && typeof error.syscall === "string";
}

/** Preserve expected acquisition failures without hiding internal errors. */
class FileAcquisition {
  private readonly failures: { readonly error: unknown; readonly expected: boolean }[] = [];

  get failed(): boolean { return this.failures.length !== 0; }
  fail(error: unknown, expected = isPlatformFileFailure(error)): void {
    this.failures.push({ error, expected });
  }
  caught(error: unknown): void {
    if (this.failures.some(failure => failure.error === error)) return;
    this.failures.unshift({ error, expected: isPlatformFileFailure(error) });
  }
  result(): BotLogIoResult {
    const first = this.failures[0];
    if (first === undefined) return { kind: "ok" };
    const error = this.failures.length === 1 ? first.error
      : new AggregateError(this.failures.map(failure => failure.error), "Filesystem acquisition/cleanup failed", { cause: first.error });
    if (this.failures.every(failure => failure.expected) && error instanceof Error) return { kind: "failed", error };
    throw error;
  }
}

interface AcquiredWritableFile { readonly descriptor: number; readonly path: string }
interface OpenedWritableHandle { readonly file: FileHandle; readonly lifetime: WriteFileLifetime; readonly path: string }
interface ServerParent { readonly descriptor: number; readonly filename: string }
type AcquisitionMode = "append" | "truncate" | "exclusive" | "bot-log";
type WritableScope = { readonly kind: "product" }
  | { readonly kind: "server"; readonly file: FileHandle; beforeOpen(): void };
type AcquisitionScope = WritableScope | { readonly kind: "directory"; readonly basePath: string; readonly gameDirectory: string };

function unavailable(acquisition: FileAcquisition | undefined, error: unknown, expected = isPlatformFileFailure(error)): null {
  acquisition?.fail(error, expected);
  return null;
}

function securityError(path: string): Error {
  return new Error(`Refusing writable path through symbolic link: ${path}`);
}

function containmentError(path: string): Error {
  return new Error(`Opened writable path escapes pinned product root: ${path}`);
}

function copyDescriptor(source: number, openDestination: () => number | null): void {
  let bytes: Uint8Array;
  try {
    const length = fstatSync(source).size;
    if (!Number.isSafeInteger(length) || length < 0 || length > 0x7fff_ffff) {
      throw new RangeError("FS_CopyFile length exceeds the source signed 32-bit boundary");
    }
    bytes = new Uint8Array(length);
    for (let offset = 0; offset < length;) {
      let count: number;
      try { count = readSync(source, bytes, offset, length - offset, offset); }
      catch (cause) {
        if (!isPlatformFileFailure(cause)) throw cause;
        throw new CommonError("fatal", "Short read in FS_Copyfiles()\n");
      }
      if (count === 0) throw new CommonError("fatal", "Short read in FS_Copyfiles()\n");
      offset += count;
    }
  } finally { closeSync(source); }
  const destination = openDestination();
  if (destination === null) return;
  try {
    for (let offset = 0; offset < bytes.byteLength;) {
      let count: number;
      try { count = writeSync(destination, bytes, offset, bytes.byteLength - offset, offset); }
      catch (cause) {
        if (!isPlatformFileFailure(cause)) throw cause;
        throw new CommonError("fatal", "Short write in FS_Copyfiles()\n");
      }
      if (count === 0) throw new CommonError("fatal", "Short write in FS_Copyfiles()\n");
      offset += count;
    }
  } finally { closeSync(destination); }
}

function checkedRelativePath(path: string): string {
  if (path.length === 0 || path.includes("\0")) {
    throw new RangeError("Writable path must be a nonempty C string");
  }
  for (let index = 0; index < path.length; index += 1) {
    if (path.charCodeAt(index) > 0xff) throw new RangeError("Writable path must contain only byte characters");
  }

  const normalized = path.replaceAll("\\", "/");
  if (
    isAbsolute(normalized) ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes(":") ||
    normalized.includes("..")
  ) {
    throw new RangeError(`Unsafe writable path: ${path}`);
  }

  return normalized;
}

function sourceStringBytes(text: string): Uint8Array {
  const nul = text.indexOf("\0");
  const length = nul < 0 ? text.length : nul;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0xff) {
      throw new RangeError("Game log text must contain only Latin-1 byte characters");
    }
    bytes[index] = code;
  }
  return bytes;
}

function inspectPath(path: Buffer): PathInspection {
  try {
    return { kind: "present", stats: lstatSync(path) };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "missing" };
    return { kind: "unavailable", error };
  }
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const fromRoot = relative(rootPath, candidatePath);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function isWithinBytes(rootPath: Buffer, candidatePath: Buffer): boolean {
  return candidatePath.equals(rootPath) || (candidatePath.subarray(0, rootPath.length).equals(rootPath)
    && (rootPath[rootPath.length - 1] === 47 || candidatePath[rootPath.length] === 47));
}

function childPath(descriptor: number, component: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`/proc/self/fd/${descriptor}/`), component]);
}

function descriptorPath(descriptor: number, requestedPath: string): Buffer {
  if (process.platform !== "linux") {
    throw new Error(
      `Secure writable descriptor containment requires Linux /proc/self/fd: ${requestedPath}`,
    );
  }
  try {
    return realpathSync(`/proc/self/fd/${descriptor}`, { encoding: "buffer" });
  } catch (cause) {
    throw new Error(`Cannot verify open writable path: ${requestedPath}`, { cause });
  }
}

class OpenWritableLog implements WritableLog, WritableBinaryFile {
  private closed = false;

  constructor(
    private readonly handles: SourceFileHandles,
    private readonly handle: FileHandle,
    private readonly lifetime: WriteFileLifetime,
    private readonly path: string,
    private readonly writer: WritableFileSystem,
    private readonly unregister: () => void,
  ) {}

  write(text: string): void {
    if (this.closed || this.lifetime.closed) throw new Error(`Cannot write closed log: ${this.path}`);
    this.writeBytes(sourceStringBytes(text));
  }

  writeBytes(bytes: Uint8Array): number {
    if (this.closed || this.lifetime.closed) throw new Error(`Cannot write closed log: ${this.path}`);
    return this.writer.writeBytes(this.handle, bytes);
  }

  tell(): number {
    if (this.closed || this.lifetime.closed) throw new Error(`Cannot tell closed log: ${this.path}`);
    return this.handles.tellWrite(this.handle) | 0;
  }

  seek(offset: number, origin: FileSeekOrigin): number {
    if (this.closed || this.lifetime.closed) throw new Error(`Cannot seek closed log: ${this.path}`);
    return this.handles.seekWrite(this.handle, offset, origin);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (!this.lifetime.closed) this.handles.closeFile(this.handle);
    } finally {
      this.unregister();
    }
  }
}

export class WritableFileSystem {
  private readonly homePathSource: WritableFileSystemOptions["homePath"];
  private gameDirectory: string;
  private readonly print: (text: string) => undefined;
  private readonly handles: SourceFileHandles;
  private readonly clearSoundBuffer: WritableFileSystemOptions["clearSoundBuffer"];
  private readonly beforeProductOpen: WritableFileSystemOptions["beforeProductOpen"];
  private readonly openLogs = new Set<OpenWritableLog | BufferedLog>();

  constructor(options: WritableFileSystemOptions) {
    this.homePathSource = options.homePath;
    this.homePath;
    this.gameDirectory = options.product;
    this.print = options.print;
    this.handles = options.handles ?? new SourceFileHandles();
    this.clearSoundBuffer = options.clearSoundBuffer;
    this.beforeProductOpen = options.beforeProductOpen;
  }

  private get homePath(): string {
    const path = typeof this.homePathSource === "string" ? this.homePathSource : this.homePathSource();
    if (path.includes("\0")) throw new RangeError("Writable home path contains NUL");
    return resolve(path === "" ? "/" : path);
  }

  /** FS_CopyFile uses temporary descriptors, leaving the caller's source handle and cursor intact. */
  copyFileFromCd(sourceDirectory: string, game: string, path: string, basePath: string,
    nativeSourceDirectory: Buffer = Buffer.from(sourceDirectory)): void {
    this.handles.assertActive();
    const relativePath = checkedRelativePath(path), gameDirectory = checkedGameDirectory(game);
    const fromPath = join(sourceDirectory, relativePath), toPath = join(basePath, gameDirectory, relativePath);
    this.print(`copy ${fromPath} to ${toPath}\n`);
    this.handles.assertActive();
    if (fromPath.includes("journal.dat") || fromPath.includes("journaldata.dat")) {
      this.print("Ignoring journal files\n");
      return;
    }
    const source = openLooseDescriptor(nativeSourceDirectory, relativePath);
    if (source === undefined) return;
    copyDescriptor(source, () => this.acquireFile(relativePath, "truncate", undefined,
      { kind: "directory", basePath, gameDirectory })?.descriptor ?? null);
  }

  /** FS_Write is shared by typed writers and common's numeric VM handles. */
  writeBytes(file: FileHandle, bytes: Uint8Array): number {
    const descriptor = this.handles.writeDescriptor(file);
    let offset = 0;
    let retriedZeroWrite = false;
    while (offset < bytes.byteLength) {
      const remaining = bytes.byteLength - offset;
      let written: number;
      try {
        written = this.writeChunk(descriptor, bytes, offset, remaining, this.handles.writePosition(file));
      } catch (error) {
        if (!isPlatformWriteFailure(error)) throw error;
        written = 0;
      }
      if (!Number.isInteger(written) || written < -1 || written > remaining) {
        throw new Error(`Invalid write result for file handle ${file.slot}: ${written}`);
      }
      if (written === 0) {
        if (retriedZeroWrite) {
          this.print("FS_Write: 0 bytes written\n");
          return 0;
        }
        retriedZeroWrite = true;
        continue;
      }
      if (written === -1) {
        this.print("FS_Write: -1 bytes written\n");
        return 0;
      }
      this.handles.advanceWrite(file, written);
      offset += written;
    }
    return bytes.byteLength;
  }

  get rootPath(): string { return resolve(this.homePath, this.gameDirectory); }

  setGameDirectory(game: string): void {
    this.handles.assertActive();
    this.gameDirectory = checkedGameDirectory(game) || "baseq3";
  }

  /** files.c FS_FileExists probes only fs_homepath/fs_gamedir with fopen(rb). */
  fileExists(path: string): boolean {
    this.handles.assertActive();
    const relativePath = checkedRelativePath(path), rootPath = this.rootPath;
    const targetPath = resolve(rootPath, relativePath);
    if (!isWithin(rootPath, targetPath)) throw new RangeError(`Unsafe writable path: ${path}`);
    if (process.platform !== "linux") throw new Error("Secure writable descriptor containment requires Linux /proc/self/fd");
    const components = relativePath.split("/").filter(component => component.length > 0 && component !== ".");
    const filename = components.pop() ?? ".";
    const directorySyntax = relativePath === "." || relativePath.endsWith("/") || relativePath.endsWith("/.");
    const acquisition = new FileAcquisition();
    let root: number | null = null, parent: number | null = null, descriptor: number | null = null;
    try {
      const home = this.openHomeDirectory(acquisition, false);
      if (home === null) return false;
      root = this.openChildReplacingParent(home, Buffer.from(this.gameDirectory, "latin1"), rootPath, acquisition, false);
      if (root === null) return false;
      parent = this.duplicateDirectory(root, rootPath, acquisition);
      if (parent === null) return false;
      let parentPath = rootPath;
      for (const component of components) {
        parentPath = join(parentPath, component);
        const previous = parent;
        parent = null;
        parent = this.openChildReplacingParent(previous, Buffer.from(component, "latin1"), parentPath, acquisition, false);
        if (parent === null) return false;
      }
      const openedPath = childPath(parent, Buffer.from(filename, "latin1"));
      const stats = lstatSync(openedPath);
      if (stats.isSymbolicLink()) throw securityError(targetPath);
      // Unix fopen accepts directories. Other special files retain the
      // writable owner's regular-file/directory containment profile.
      if (!stats.isFile() && !stats.isDirectory()) return false;
      descriptor = openSync(openedPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        | (directorySyntax ? constants.O_DIRECTORY : 0));
      if (!isWithinBytes(descriptorPath(root, rootPath), descriptorPath(descriptor, targetPath))) throw containmentError(targetPath);
      return true;
    } catch (error) {
      acquisition.caught(errorCode(error) === "ELOOP" ? securityError(targetPath) : error);
      return false;
    } finally {
      for (const opened of [descriptor, parent, root]) {
        if (opened === null) continue;
        try { closeSync(opened); } catch (error) { acquisition.fail(error); }
      }
      acquisition.result();
    }
  }

  /**
   * Opens an unbuffered append descriptor. Node's synchronous writes are visible
   * immediately in both modes; the source's synchronous mode adds fflush, not fsync.
   */
  openAppend(path: string, synchronous: boolean): WritableLog | null {
    return this.openFile(path, synchronous, "append");
  }

  openWrite(path: string, synchronous: boolean): WritableLog | null {
    return this.openFile(path, synchronous, "truncate");
  }

  /** Unix QGL owns the returned FILE across FS_Shutdown, outside all common handles/logs. */
  openGlLog(basePath: string): WritableLog | null {
    this.handles.assertActive();
    const opened = this.acquireFile("gl.log", "truncate", undefined,
      { kind: "directory", basePath: basePath === "" ? "/" : basePath, gameDirectory: "." });
    if (opened === null) return null;
    let log: BufferedLog;
    try { log = new BufferedLog(opened.descriptor, opened.path, () => {}); }
    catch (error) {
      try { closeSync(opened.descriptor); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "GL log construction/cleanup failed", { cause: error }); }
      throw error;
    }
    return {
      write: text => { log.write(sourceStringBytes(text)); },
      close: () => {
        const result = log.close();
        if (result.kind === "failed") throw result.error;
      },
    };
  }

  openBinaryWrite(path: string): WritableBinaryFile | null {
    return this.openFile(path, false, "truncate");
  }

  openByMode(path: string, mode: "write" | "append" | "append-sync"): FileHandle | null {
    const opened = this.openHandle(path, mode === "append-sync", mode === "write" ? "truncate" : "append",
      { kind: "product" });
    return opened === null ? null : opened.file;
  }

  /** FS_SV_FOpenFileWrite borrows this writer and the already selected common handle. */
  openServerBinaryWrite(path: string, file: FileHandle, beforeOpen: () => void, mode: "truncate" | "exclusive" = "truncate"): WritableBinaryFile | null {
    return this.openFile(path, false, mode, { kind: "server", file, beforeOpen });
  }

  renameFile(from: string, to: string, beforeRename: (directory: string) => void): void {
    this.renameRelative(from, to, this.homePath, this.gameDirectory, beforeRename);
  }

  renameServerFile(from: string, to: string, beforeRename: (directory: string) => void): void {
    this.renameRelative(from, to, this.homePath, "", beforeRename);
  }

  /** FS_Rename/FS_SV_Rename overwrite first, then copy and remove on ordinary OS failure. */
  private renameRelative(from: string, to: string, homePath: string, gameDirectory: string, beforeRename: (directory: string) => void): void {
    this.handles.assertActive();
    const fromRelative = checkedRelativePath(from), toRelative = checkedRelativePath(to);
    const directory = resolve(homePath, gameDirectory);
    const fromPath = join(directory, fromRelative), toPath = join(directory, toRelative);
    beforeRename(directory);
    this.handles.assertActive();
    const copyNotice = (): void => {
      this.print(`copy ${fromPath} to ${toPath}\n`);
      this.handles.assertActive();
    };
    const home = this.openHomeDirectory(undefined, false, homePath);
    const root = home === null || gameDirectory === "" ? home
      : this.openChildReplacingParent(home, Buffer.from(gameDirectory, "latin1"), directory, undefined, false);
    if (root === null) { copyNotice(); return; }
    let source: ServerParent | null = null, destination: ServerParent | null = null;
    try {
      source = this.renameParent(root, directory, fromRelative, false);
      destination = this.renameParent(root, directory, toRelative, false);
      if (source === null) { copyNotice(); return; }
      const sourcePath = childPath(source.descriptor, Buffer.from(source.filename, "latin1"));
      const sourceState = inspectPath(sourcePath);
      if (sourceState.kind === "present") {
        if (sourceState.stats.isSymbolicLink()) throw securityError(fromPath);
        if (!sourceState.stats.isFile()) throw new Error(`Rename source is not a regular file: ${fromPath}`);
      }
      if (destination !== null) {
        const destinationPath = childPath(destination.descriptor, Buffer.from(destination.filename, "latin1"));
        const target = inspectPath(destinationPath);
        if (target.kind === "present" && target.stats.isSymbolicLink()) throw securityError(toPath);
        try { renameSync(sourcePath, destinationPath); return; }
        catch (cause) { if (!isPlatformFileFailure(cause)) throw cause; }
      }
      copyNotice();
      if (fromPath.includes("journal.dat") || fromPath.includes("journaldata.dat")) this.print("Ignoring journal files\n");
      else {
        let descriptor: number | null = null;
        try { descriptor = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch (cause) {
          if (errorCode(cause) === "ELOOP") throw securityError(fromPath);
          if (!isPlatformFileFailure(cause)) throw cause;
        }
        if (descriptor !== null) {
          try {
            if (!fstatSync(descriptor).isFile() || !isWithinBytes(descriptorPath(root, directory), descriptorPath(descriptor, fromPath))) {
              throw containmentError(fromPath);
            }
          } catch (cause) { closeSync(descriptor); throw cause; }
        }
        if (descriptor !== null) copyDescriptor(descriptor, () => {
          if (destination === null) destination = this.renameParent(root, directory, toRelative, true);
          if (destination === null) return null;
          const targetPath = childPath(destination.descriptor, Buffer.from(destination.filename, "latin1"));
          const target = inspectPath(targetPath);
          if (target.kind === "unavailable") return null;
          if (target.kind === "present") {
            if (target.stats.isSymbolicLink()) throw securityError(toPath);
            if (!target.stats.isFile()) return null;
          }
          let output: number;
          try { output = openSync(targetPath, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o666); }
          catch (cause) {
            if (errorCode(cause) === "ELOOP") throw securityError(toPath);
            if (!isPlatformFileFailure(cause)) throw cause;
            return null;
          }
          try {
            if (!fstatSync(output).isFile() || !isWithinBytes(descriptorPath(root, directory), descriptorPath(output, toPath))) {
              throw containmentError(toPath);
            }
          } catch (cause) { closeSync(output); throw cause; }
          try { ftruncateSync(output, 0); }
          catch (cause) {
            closeSync(output);
            if (!isPlatformFileFailure(cause)) throw cause;
            return null;
          }
          return output;
        });
      }
      // Source removes the old name even when the nonfatal copy attempt failed.
      try { unlinkSync(sourcePath); }
      catch (cause) { if (!isPlatformFileFailure(cause)) throw cause; }
    } finally {
      try { if (destination !== null) closeSync(destination.descriptor); }
      finally { try { if (source !== null) closeSync(source.descriptor); } finally { closeSync(root); } }
    }
  }

  private renameParent(root: number, directory: string, path: string, create: boolean): ServerParent | null {
    const components = path.split("/").filter(component => component.length > 0 && component !== ".");
    const filename = components.pop();
    if (filename === undefined || path.endsWith("/") || path.endsWith("/.")) throw new RangeError("Rename requires a filename");
    let descriptor = this.duplicateDirectory(root, directory, undefined);
    if (descriptor === null) return null;
    try {
      for (const component of components) {
        const parent = descriptor;
        descriptor = null;
        descriptor = this.openChildReplacingParent(parent, Buffer.from(component, "latin1"), join(directory, path), undefined, create);
        if (descriptor === null) return null;
      }
      if (!isWithinBytes(descriptorPath(root, directory), descriptorPath(descriptor, directory))) throw containmentError(directory);
      const result = { descriptor, filename };
      descriptor = null;
      return result;
    } finally { if (descriptor !== null) closeSync(descriptor); }
  }

  /** Same-filesystem no-replace finalization keeps a conflicting destination and the temporary file intact. */
  renameServerFileNoReplace(from: string, to: string): void {
    this.handles.assertActive();
    const fromRelative = checkedRelativePath(from), toRelative = checkedRelativePath(to);
    const root = this.openHomeDirectory(undefined, false);
    if (root === null) throw new Error("Cannot open server home directory for rename");
    let source: ServerParent | null = null, destination: ServerParent | null = null;
    try {
      source = this.existingServerParent(root, fromRelative);
      destination = this.existingServerParent(root, toRelative);
      const canonicalRoot = descriptorPath(root, this.homePath);
      for (const parent of [source, destination]) {
        if (!isWithinBytes(canonicalRoot, descriptorPath(parent.descriptor, this.homePath))) throw containmentError(this.homePath);
      }
      const sourcePath = childPath(source.descriptor, Buffer.from(source.filename, "latin1"));
      const destinationPath = childPath(destination.descriptor, Buffer.from(destination.filename, "latin1"));
      const stats = lstatSync(sourcePath);
      if (stats.isSymbolicLink()) throw securityError(from);
      if (!stats.isFile()) throw new Error(`Server rename source is not a regular file: ${from}`);
      linkSync(sourcePath, destinationPath);
      unlinkSync(sourcePath);
    } finally {
      try { if (destination !== null) closeSync(destination.descriptor); }
      finally { try { if (source !== null) closeSync(source.descriptor); } finally { closeSync(root); } }
    }
  }

  private existingServerParent(root: number, path: string): ServerParent {
    const components = path.split("/").filter(component => component.length > 0 && component !== ".");
    const filename = components.pop();
    if (filename === undefined || path.endsWith("/") || path.endsWith("/.")) throw new RangeError("Server rename requires a filename");
    let descriptor = this.duplicateDirectory(root, this.homePath, undefined);
    if (descriptor === null) throw new Error("Cannot retain server home directory for rename");
    try {
      for (const component of components) {
        const parent = descriptor;
        descriptor = null;
        descriptor = this.openChildReplacingParent(parent, Buffer.from(component, "latin1"), join(this.homePath, path), undefined, false);
        if (descriptor === null) throw new Error(`Cannot open server rename directory: ${path}`);
      }
      return { descriptor, filename };
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      throw error;
    }
  }

  openBotLog(path: string): BotLogOpenResult {
    this.handles.assertActive();
    const acquisition = new FileAcquisition();
    let opened: AcquiredWritableFile | null = null;
    try { opened = this.acquireFile(path, "bot-log", acquisition); }
    catch (error) { acquisition.caught(error); }
    if (acquisition.failed) {
      if (opened !== null) {
        const descriptor = opened.descriptor;
        opened = null;
        try { closeSync(descriptor); } catch (error) { acquisition.fail(error); }
      }
      const result = acquisition.result();
      if (result.kind === "failed") return result;
    }
    if (opened === null) throw new Error("Bot log acquisition returned no file or failure");
    let log: BufferedLog;
    try { log = new BufferedLog(opened.descriptor, opened.path, () => this.openLogs.delete(log)); }
    catch (error) {
      acquisition.caught(error);
      try { closeSync(opened.descriptor); } catch (cleanup) { acquisition.fail(cleanup); }
      acquisition.result();
      throw error;
    }
    this.openLogs.add(log);
    return { kind: "opened", stream: log };
  }

  private openFile(
    path: string,
    synchronous: boolean,
    mode: "append" | "truncate" | "exclusive",
    scope: WritableScope = { kind: "product" },
  ): OpenWritableLog | null {
    const opened = this.openHandle(path, synchronous, mode, scope);
    if (opened === null) return null;
    const log = new OpenWritableLog(this.handles, opened.file, opened.lifetime, opened.path,
      this, () => this.openLogs.delete(log));
    this.openLogs.add(log);
    return log;
  }

  private openHandle(
    path: string,
    synchronous: boolean,
    mode: "append" | "truncate" | "exclusive",
    scope: WritableScope,
  ): OpenedWritableHandle | null {
    const relativePath = checkedRelativePath(path);
    const handle = scope.kind === "server" ? scope.file : this.handles.selectFree();
    if (mode === "append") this.handles.setName(handle, path);
    if (scope.kind === "product" && mode === "append") this.clearSoundBuffer?.();
    const directory: AcquisitionScope = scope.kind === "product"
      ? { kind: "directory", basePath: this.homePath, gameDirectory: this.gameDirectory } : scope;
    if (directory.kind === "directory") this.beforeProductOpen?.(resolve(directory.basePath, directory.gameDirectory, relativePath),
      mode === "append" ? "append" : "write");
    const opened = this.acquireFile(relativePath, mode, undefined, directory);
    if (opened === null) return null;
    let lifetime: WriteFileLifetime;
    try {
      lifetime = this.handles.attachWrite(handle, opened.descriptor, synchronous, mode === "append");
      this.handles.setName(handle, path);
    } catch (error) {
      try { closeSync(opened.descriptor); }
      catch (cleanup) {
        throw new AggregateError([error, cleanup], "Writable handle attachment/cleanup failed", { cause: error });
      }
      throw error;
    }
    return { file: handle, lifetime, path: opened.path };
  }

  private acquireFile(
    path: string,
    mode: AcquisitionMode,
    acquisition: FileAcquisition | undefined,
    scope: AcquisitionScope = { kind: "product" },
  ): AcquiredWritableFile | null {
    const relativePath = checkedRelativePath(path);
    if (relativePath === "." || relativePath.endsWith("/") || relativePath.endsWith("/.")) {
      return unavailable(acquisition, new Error(`Writable target names a directory: ${path}`), true);
    }
    const basePath = scope.kind === "directory" ? resolve(scope.basePath) : this.homePath;
    const gameDirectory = scope.kind === "directory" ? scope.gameDirectory : this.gameDirectory;
    const rootPath = scope.kind === "server" ? basePath : resolve(basePath, gameDirectory);
    const targetPath = resolve(rootPath, relativePath);
    if (!isWithin(rootPath, targetPath) || targetPath === rootPath) {
      throw new RangeError(`Unsafe writable path: ${path}`);
    }
    if (process.platform !== "linux") {
      throw new Error("Secure writable descriptor containment requires Linux /proc/self/fd");
    }
    const components = relativePath.split("/").filter(component => component.length > 0 && component !== ".");
    const filename = components.pop();
    if (filename === undefined) return unavailable(acquisition, new Error(`Writable path has no filename: ${path}`), true);

    const homeDescriptor = this.openHomeDirectory(acquisition, true, basePath);
    if (homeDescriptor === null) return null;
    const rootDescriptor = scope.kind === "server" ? homeDescriptor
      : this.openChildReplacingParent(homeDescriptor, Buffer.from(gameDirectory, "latin1"), rootPath, acquisition);
    if (rootDescriptor === null) return null;

    let descriptor: number | null = null;
    try {
      let parentDescriptor: number | null = this.duplicateDirectory(rootDescriptor, rootPath, acquisition);
      if (parentDescriptor === null) return null;
      let parentPath = rootPath;
      try {
        for (const component of components) {
          parentPath = join(parentPath, component);
          const previousDescriptor = parentDescriptor;
          parentDescriptor = null;
          parentDescriptor = this.openChildReplacingParent(previousDescriptor, Buffer.from(component, "latin1"), parentPath, acquisition);
          if (parentDescriptor === null) return null;
        }

        if (scope.kind === "server") scope.beforeOpen();
        const openedTargetPath = childPath(parentDescriptor, Buffer.from(filename, "latin1"));
        const target = inspectPath(openedTargetPath);
        if (target.kind === "unavailable") return unavailable(acquisition, target.error);
        if (target.kind === "present" && target.stats.isSymbolicLink()) {
          throw securityError(targetPath);
        }
        if (target.kind === "present" && !target.stats.isFile()) {
          return unavailable(acquisition, new Error(`Writable target is not a regular file: ${targetPath}`), true);
        }

        try {
          const modeFlags = mode === "append" ? constants.O_APPEND : mode === "exclusive" ? constants.O_EXCL : 0;
          descriptor = openSync(
            openedTargetPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW
              | constants.O_NONBLOCK | modeFlags,
            0o666,
          );
        } catch (error) {
          if (errorCode(error) === "ELOOP") throw securityError(targetPath);
          return unavailable(acquisition, error);
        }
      } catch (error) {
        acquisition?.caught(error);
        throw error;
      } finally {
        if (parentDescriptor !== null) {
          try {
            closeSync(parentDescriptor);
          } catch (error) {
            acquisition?.fail(error);
            if (descriptor !== null) {
              const failedDescriptor = descriptor;
              descriptor = null;
              try {
                closeSync(failedDescriptor);
              } catch (cleanup) {
                acquisition?.fail(cleanup);
                // Preserve the parent descriptor close error.
              }
            }
            if (acquisition === undefined) throw error;
          }
        }
      }

      if (descriptor === null) return null;

      try {
        if (!fstatSync(descriptor).isFile()) {
          const failedDescriptor = descriptor;
          descriptor = null;
          acquisition?.fail(new Error(`Opened writable target is not a regular file: ${targetPath}`), true);
          try { closeSync(failedDescriptor); }
          catch (error) { if (acquisition === undefined) throw error; acquisition.fail(error); }
          return null;
        }
        const canonicalRoot = descriptorPath(rootDescriptor, rootPath);
        const canonicalTarget = descriptorPath(descriptor, targetPath);
        if (!isWithinBytes(canonicalRoot, canonicalTarget)) {
          const failedDescriptor = descriptor;
          descriptor = null;
          const error = containmentError(targetPath);
          acquisition?.caught(error);
          try { closeSync(failedDescriptor); }
          catch (cleanup) { if (acquisition === undefined) throw cleanup; acquisition.fail(cleanup); }
          throw error;
        }
        if (mode === "truncate" || mode === "bot-log") {
          try {
            ftruncateSync(descriptor, 0);
          } catch (error) {
            acquisition?.fail(error);
            const failedDescriptor = descriptor;
            descriptor = null;
            try { closeSync(failedDescriptor); }
            catch (cleanup) { if (acquisition === undefined) throw cleanup; acquisition.fail(cleanup); }
            return null;
          }
        }
      } catch (error) {
        acquisition?.caught(error);
        if (descriptor !== null) {
          const failedDescriptor = descriptor;
          descriptor = null;
          try {
            closeSync(failedDescriptor);
          } catch (cleanup) {
            acquisition?.fail(cleanup);
            // Preserve the validation error.
          }
        }
        throw error;
      }
    } finally {
      try {
        closeSync(rootDescriptor);
      } catch (error) {
        acquisition?.fail(error);
        if (descriptor !== null) {
          const failedDescriptor = descriptor;
          descriptor = null;
          try {
            closeSync(failedDescriptor);
          } catch (cleanup) {
            acquisition?.fail(cleanup);
            // Preserve the root descriptor close error.
          }
        }
        if (acquisition === undefined) throw error;
      }
    }

    if (descriptor === null) return null;
    return { descriptor, path: targetPath };
  }

  closeAll(): void {
    const failures: unknown[] = [];
    let bufferedFailure = false;
    for (const log of [...this.openLogs]) {
      try {
        const result = log.close();
        if (result !== undefined && result.kind === "failed") throw result.error;
      } catch (error) {
        failures.push(error);
        if (log instanceof BufferedLog) bufferedFailure = true;
      }
    }
    if (failures.length === 0) return;
    const firstError = failures[0];
    if (bufferedFailure && failures.length > 1) {
      throw new AggregateError(failures, "Writable log terminal cleanup failed", { cause: firstError });
    }
    throw firstError;
  }

  protected writeChunk(
    descriptor: number,
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number {
    return writeSync(descriptor, bytes, offset, length, position);
  }

  private openHomeDirectory(acquisition: FileAcquisition | undefined, create = true, basePath = this.homePath): number | null {
    let descriptor: number | null;
    try {
      descriptor = openSync(
        "/",
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      return unavailable(acquisition, error);
    }

    let directoryPath = "/";
    const components = basePath.split("/").filter(component => component.length > 0);
    for (const component of components) {
      directoryPath = join(directoryPath, component);
      descriptor = this.openChildReplacingParent(descriptor, Buffer.from(component), directoryPath, acquisition, create);
      if (descriptor === null) return null;
    }
    return descriptor;
  }

  private openChildReplacingParent(
    parent: number,
    component: Buffer,
    displayPath: string,
    acquisition: FileAcquisition | undefined,
    create = true,
  ): number | null {
    let child: number | null = null;
    try {
      child = this.openChildDirectory(parent, component, displayPath, acquisition, create);
    } catch (error) {
      acquisition?.caught(error);
      throw error;
    } finally {
      try {
        closeSync(parent);
      } catch (error) {
        acquisition?.fail(error);
        if (child !== null) {
          const failedChild = child;
          child = null;
          try {
            closeSync(failedChild);
          } catch (cleanup) {
            acquisition?.fail(cleanup);
            // Preserve the parent descriptor close error.
          }
        }
        if (acquisition === undefined) throw error;
      }
    }
    return child;
  }

  private openChildDirectory(parent: number, component: Buffer, displayPath: string, acquisition: FileAcquisition | undefined, create: boolean): number | null {
    const path = childPath(parent, component);
    let inspection = inspectPath(path);
    if (inspection.kind === "present" && inspection.stats.isSymbolicLink()) {
      throw securityError(displayPath);
    }
    if (inspection.kind === "unavailable") return unavailable(acquisition, inspection.error);
    if (inspection.kind === "missing") {
      if (!create) return unavailable(acquisition, new Error(`Writable parent is missing: ${displayPath}`), true);
      try {
        mkdirSync(path);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") return unavailable(acquisition, error);
      }
      inspection = inspectPath(path);
      if (inspection.kind === "present" && inspection.stats.isSymbolicLink()) {
        throw securityError(displayPath);
      }
    }
    if (inspection.kind === "unavailable") return unavailable(acquisition, inspection.error);
    if (inspection.kind !== "present" || !inspection.stats.isDirectory()) {
      return unavailable(acquisition, new Error(`Writable parent is not a directory: ${displayPath}`), true);
    }
    try {
      return openSync(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (errorCode(error) === "ELOOP") throw securityError(displayPath);
      return unavailable(acquisition, error);
    }
  }

  private duplicateDirectory(descriptor: number, displayPath: string, acquisition: FileAcquisition | undefined): number | null {
    try {
      return openSync(
        `/proc/self/fd/${descriptor}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK,
      );
    } catch (cause) {
      if (acquisition !== undefined) return unavailable(acquisition, cause);
      throw new Error(`Cannot retain writable directory: ${displayPath}`, { cause });
    }
  }
}
