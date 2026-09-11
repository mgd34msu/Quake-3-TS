// Ported from id Software's code/qcommon/files.c and code/unix/unix_shared.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { readdir } from "node:fs/promises";
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  opendirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { sourceNativeComponent } from "../platform/file-native.ts";
import { hostRootInput, NativeRoot } from "./native-root.ts";
import type { RootInput } from "./native-root.ts";
import type { MissingFileLog } from "./missing-file-log.ts";
import type { Dir, Dirent } from "node:fs";
import { SourceFileHandles } from "./file-handles.ts";
import type { FileHandle } from "./file-handles.ts";
import type { ServerFileSystem } from "./server-files.ts";
import type { Product } from "../shared/definitions.ts";
import { allowedPureLoosePath, isPakPure, PakReferences, reorderPurePaks } from "./pak-references.ts";
import type { PakCatalogEntry, PureSearchPath, ServerPakSet } from "./pak-references.ts";
import { normalizeAssetPath, Pk3Archive, Pk3OpenError } from "./pk3.ts";
import { sourceFilter } from "../core/filter.ts";
import { CommonError } from "../core/common-error.ts";
import type { SourceFileReader } from "./reader.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import type { WritableFileSystem } from "./writable-files.ts";
import { ReadFileMemory } from "./read-file-memory.ts";
import type { RetainedFileBuffer, RetainedFileReader } from "./read-file-memory.ts";

const MAX_PAK_FILES = 1_024;
const MAX_LISTED_FILES = 4_095;

export type VfsSource = LooseSource | Pk3Source;

export interface LooseSource {
  readonly kind: "loose";
  readonly game: string;
  readonly path: string;
  readonly filePath: string;
}

export interface Pk3Source {
  readonly kind: "pk3";
  readonly game: string;
  readonly path: string;
  readonly archivePath: string;
}

interface LooseFile {
  readonly kind: "loose";
  readonly provenance: LooseSource;
}

interface PackedFile {
  readonly kind: "pk3";
  readonly archive: Pk3Archive;
  readonly catalogEntry: PakCatalogEntry | null;
  readonly provenance: Pk3Source;
}

type MountedFile = LooseFile | PackedFile;

interface LooseDirectoryMount {
  readonly kind: "loose-directory";
  readonly root: NativeRoot;
  readonly game: string;
  readonly directory: string;
  readonly nativeDirectory: Buffer;
}

interface Pk3Mount {
  readonly kind: "pk3";
  readonly game: string;
  readonly archive: Pk3Archive;
  readonly archivePath: string;
  readonly catalogEntry: PakCatalogEntry | null;
}

type SearchPathMount = LooseDirectoryMount | Pk3Mount;

export interface VfsReferenceOptions {
  readonly checksumFeed: number;
  readonly random: () => number;
}

export interface VfsSearchOptions {
  readonly missingFileLogPath?: string;
  readonly dataPath: string;
  readonly homePath: string;
  readonly cdPath: string | null;
  readonly product: Product;
  readonly gameDirectory?: string;
  readonly baseGameDirectory?: string;
}

/** External VFS entries interpret plain root strings as host Unicode. */
export interface VfsRootOptions extends Omit<VfsSearchOptions, "dataPath" | "homePath" | "cdPath"> {
  readonly dataPath: RootInput;
  readonly homePath: RootInput;
  readonly cdPath: RootInput | null;
}

export interface NativeSearchRoots extends Omit<VfsSearchOptions, "dataPath" | "homePath" | "cdPath"> {
  readonly dataPath: NativeRoot;
  readonly homePath: NativeRoot;
  readonly cdPath: NativeRoot | null;
}

export interface VfsTrackedSearchOptions extends VfsRootOptions {
  readonly missingFiles?: MissingFileLog;
  readonly references: VfsReferenceOptions;
  readonly startupGame?: "baseq3" | "demota";
  readonly isRestricted?: () => boolean;
  readonly handles?: SourceFileHandles;
  readonly serverFiles?: ServerFileSystem;
  readonly serverPaks?: ServerPakSet;
  readonly configJournal?: ConfigFileJournal;
  readonly copyFiles?: VfsCopyFiles;
  readonly fileMemory?: ReadFileMemory;
  readonly diagnostics?: VfsDiagnostics;
  readonly mountGameDirectory?: (game: string) => void;
  readonly readCdKeys?: () => void;
  readonly isFullyInitialized?: () => boolean;
}

interface VfsDiagnostics {
  debugPrint(text: string): void;
  developerPrint(text: string): void;
}

interface VfsCopyFiles {
  readonly cvars: CvarRegistry;
  readonly writable: WritableFileSystem;
}

/** The FS_ReadFile journal borrow. Open/exists/ordinary length probes never consume it. */
export interface ConfigFileJournal {
  readonly mode: number;
  readLength(path: string): number;
  readFile(path: string): Uint8Array | undefined;
  readFileRetained(path: string, memory: ReadFileMemory): RetainedFileBuffer | undefined;
  writeLength(path: string, length: number): void;
  writeFile(path: string, bytes: Uint8Array | undefined): void;
}

export interface OpenedRead {
  readonly file: FileHandle;
  readonly length: number;
}

export function pathCompare(left: string, right: string): number {
  const limit = Math.max(left.length, right.length);
  for (let index = 0; index <= limit; index++) {
    let leftCode = index < left.length ? left.charCodeAt(index) : 0;
    let rightCode = index < right.length ? right.charCodeAt(index) : 0;
    if (leftCode >= 97 && leftCode <= 122) leftCode -= 32;
    if (rightCode >= 97 && rightCode <= 122) rightCode -= 32;
    if (leftCode === 92 || leftCode === 58) leftCode = 47;
    if (rightCode === 92 || rightCode === 58) rightCode = 47;
    // FS_PathCmp promotes plain signed char on the selected Linux build.
    if (leftCode >= 128 && leftCode <= 255) leftCode -= 256;
    if (rightCode >= 128 && rightCode <= 255) rightCode -= 256;
    if (leftCode < rightCode) return -1;
    if (leftCode > rightCode) return 1;
  }
  return 0;
}

export function pathCaseEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    let leftCode = left.charCodeAt(index);
    let rightCode = right.charCodeAt(index);
    if (leftCode >= 97 && leftCode <= 122) leftCode -= 32;
    if (rightCode >= 97 && rightCode <= 122) rightCode -= 32;
    if (leftCode !== rightCode) return false;
  }
  return true;
}

function isFileSystemFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string";
}

function normalizePrefix(prefix: string): string {
  if (prefix.length === 0) return "";
  const separated = prefix.replaceAll("\\", "/");
  if (!separated.endsWith("/")) return normalizeAssetPath(separated);
  return `${normalizeAssetPath(separated.slice(0, -1))}/`;
}

export function checkListBytes(value: string, label: string): void {
  for (let index = 0; index < value.length; index++) {
    const byte = value.charCodeAt(index);
    if (byte === 0 || byte > 255) throw new RangeError(`${label} requires non-NUL source bytes`);
  }
}

function checkSourceListBytes(value: string, label: string): void {
  for (let index = 0; index < value.length; index++) {
    const byte = value.charCodeAt(index);
    if (byte === 0 || byte > 255) throw new RangeError(`${label} requires non-NUL source bytes`);
  }
}

// FS_ReturnPath counts either separator, but the prefix comparison does not
// equate them. Its returned length excludes the final separator.
function listedPathParts(path: string): { readonly length: number; readonly depth: number } {
  let length = 0;
  let depth = 0;
  for (let index = 0; index < path.length; index++) {
    if (path[index] === "/" || path[index] === "\\") {
      length = index;
      depth++;
    }
  }
  return { length, depth };
}

function listSuffixMatches(name: string, extension: string): boolean {
  return name.length >= extension.length && pathCaseEqual(name.slice(name.length - extension.length), extension);
}

function addListedName(names: string[], name: string): void {
  // FS_AddFileToList checks the source cap before scanning duplicates.
  if (names.length === MAX_LISTED_FILES) return;
  if (!names.some(previous => pathCaseEqual(previous, name))) names.push(name);
}

function looseOsPath(directory: Buffer, relative: string): Buffer {
  checkSourceListBytes(relative, "Loose path");
  const path = Buffer.concat([directory, Buffer.from("/"), sourceNativeComponent(relative)]);
  if (path.length >= 4096) throw new RangeError("Loose filename exceeds the supported Unix MAX_OSPATH");
  return path;
}

function openListingDirectory(directory: Buffer, relative: string): Dir | null {
  try {
    // Host ancestors may be aliases such as Darwin /tmp. The selected root
    // itself and its source-relative descendants must still be directories.
    if (!lstatSync(directory).isDirectory()) return null;
    const canonical = realpathSync(directory, { encoding: "buffer" });
    const target = looseOsPath(canonical, relative);
    for (let end = canonical.length + 1; end <= target.length; end++) {
      if (end < target.length && target[end] !== 47) continue;
      if (!lstatSync(target.subarray(0, end)).isDirectory()) return null;
    }
    return opendirSync(target, { encoding: process.platform === "win32" ? "utf8" : "latin1" });
  } catch (error) {
    if (isFileSystemFailure(error)) return null;
    throw error;
  }
}

function isSourceListingName(name: string): boolean {
  // Windows Unicode names outside Latin-1 cannot round-trip through source
  // filename strings. POSIX enumeration already supplies one unit per byte.
  for (let index = 0; index < name.length; index++) {
    if (name.charCodeAt(index) === 0 || name.charCodeAt(index) > 255) return false;
  }
  return true;
}

function looseListingMode(path: Buffer): number | null {
  if (path.length >= 4096) throw new RangeError("Loose filename exceeds the supported Unix MAX_OSPATH");
  try {
    // Sys_ListFiles stats each row. lstat preserves the contained profile:
    // symlink targets are never inspected or followed during listing.
    const metadata = lstatSync(path);
    return metadata.isSymbolicLink() ? null : metadata.mode;
  } catch (error) {
    if (isFileSystemFailure(error)) return null;
    throw error;
  }
}

export function listLooseNames(directory: string | Buffer, path: string, extension: string): readonly string[] {
  const nativeDirectory = typeof directory === "string" ? Buffer.from(directory) : directory;
  const relative = looseRequestPath(path);
  const stream = openListingDirectory(nativeDirectory, relative);
  if (stream === null) return [];
  const names: string[] = [];
  const directoriesOnly = extension === "/";
  try {
    // Bun/Node preserves its platform enumeration order but omits . and .. .
    // This is the supported platform profile, with no fabricated dot entries.
    for (let entry = stream.readSync(); entry !== null; entry = stream.readSync()) {
      if (!isSourceListingName(entry.name)) continue;
      const mode = looseListingMode(looseOsPath(nativeDirectory, `${relative}/${entry.name}`));
      if (mode === null) continue;
      // Source tests this bit directly, including its socket/block-device overlap.
      if (directoriesOnly !== ((mode & constants.S_IFDIR) !== 0)) continue;
      if (!directoriesOnly && !listSuffixMatches(entry.name, extension)) continue;
      if (names.length === MAX_LISTED_FILES) break;
      names.push(entry.name);
    }
  } finally {
    stream.closeSync();
  }
  return names;
}

/** Com_FilterPath truncates both converted strings to MAX_QPATH - 1 bytes. */
function filterPath(filter: string, name: string): boolean {
  return sourceFilter(filter.slice(0, 63).replaceAll("\\", "/").replaceAll(":", "/"),
    name.slice(0, 63).replaceAll("\\", "/").replaceAll(":", "/"), false);
}

function listFilteredLooseNames(directory: Buffer, path: string, filter: string): readonly string[] {
  const base = looseRequestPath(path);
  const names: string[] = [];
  // unix_shared.c visits children before matching their directory row. The
  // current platform profile omits dot entries and does not follow symlinks.
  const visit = (subdirs: string): void => {
    if (names.length === MAX_LISTED_FILES) return;
    const search = subdirs === "" ? base : `${base}/${subdirs}`;
    const stream = openListingDirectory(directory, search);
    if (stream === null) return;
    try {
      for (let item = stream.readSync(); item !== null; item = stream.readSync()) {
        if (!isSourceListingName(item.name)) continue;
        const mode = looseListingMode(looseOsPath(directory, `${search}/${item.name}`));
        if (mode === null) continue;
        const relative = subdirs === "" ? item.name : `${subdirs}/${item.name}`;
        if ((mode & constants.S_IFDIR) !== 0) visit(relative);
        if (names.length === MAX_LISTED_FILES) break;
        const name = `${subdirs}/${item.name}`;
        if (filterPath(filter, name)) names.push(name);
      }
    } finally { stream.closeSync(); }
  };
  visit("");
  return names;
}

async function directoryEntries(path: Buffer): Promise<Dirent[]> {
  try {
    if (!lstatSync(path).isDirectory()) return [];
    return (await readdir(path, { withFileTypes: true, encoding: process.platform === "win32" ? "utf8" : "latin1" }))
      .filter(entry => isSourceListingName(entry.name));
  } catch (error) {
    if (isFileSystemFailure(error)) return [];
    throw error;
  }
}

function loosePaths(directory: Buffer, relativeDirectory = ""): readonly string[] {
  const currentPath = looseOsPath(directory, relativeDirectory);
  let entries: Dirent[];
  try {
    entries = readdirSync(currentPath, { withFileTypes: true, encoding: process.platform === "win32" ? "utf8" : "latin1" });
  } catch (error) {
    if (isFileSystemFailure(error)) return [];
    throw error;
  }
  const found: string[] = [];
  entries.sort((left, right) => pathCompare(left.name, right.name));
  for (const entry of entries) {
    if (!isSourceListingName(entry.name)) continue;
    const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...loosePaths(directory, relativePath));
    } else if (entry.isFile()) {
      found.push(normalizeAssetPath(relativePath));
    }
  }
  return found;
}

export function looseRequestPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isCredentialPath(normalized: string): boolean {
  return normalized.includes("q3key") || normalized.includes("quake3cdkey");
}

function validateSourceLength(source: VfsSource, size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > 0x7fff_ffff) {
    throw new Error(`Asset ${JSON.stringify(source.path)} has length ${size}, outside the source signed 32-bit return boundary`);
  }
}

export function checkedGameDirectory(game: string): string {
  if (game === "") return game;
  checkListBytes(game, "Game directory");
  if (game === "." || game.includes("..") || /[\\/:]/.test(game)) {
    throw new RangeError(`Unsafe game directory: ${JSON.stringify(game)}`);
  }
  if (game.length >= 4096) throw new RangeError("Game directory exceeds the supported Unix MAX_OSPATH");
  return game;
}

export function openLooseDescriptor(directory: string | Buffer, requestedPath: string): number | undefined {
  const nativeDirectory = typeof directory === "string" ? Buffer.from(directory) : directory;
  const filePath = looseOsPath(nativeDirectory, requestedPath);
  try {
    let parent = "";
    if (!lstatSync(nativeDirectory).isDirectory()) return undefined;
    const components = requestedPath.split("/");
    for (const component of components.slice(0, -1)) {
      parent = `${parent}/${component}`;
      if (!lstatSync(looseOsPath(nativeDirectory, parent)).isDirectory()) return undefined;
    }
    if (!lstatSync(filePath).isFile()) return undefined;
  } catch (error) {
    if (isFileSystemFailure(error)) return undefined;
    throw error;
  }
  try {
    return openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isFileSystemFailure(error)) return undefined;
    throw error;
  }
}

export class VirtualFileSystem implements SourceFileReader, RetainedFileReader, Disposable {
  private retired = false;
  private started = false;
  private searchPaths: SearchPathMount[] = [];
  protected reordered = false;
  private readonly handles: SourceFileHandles;
  private readonly ownsHandles: boolean;

  protected constructor(
    private readonly searchOptions: VfsRootOptions,
    private readonly referenceTracker: PakReferences | null,
    handles?: SourceFileHandles,
    private readonly serverFiles?: ServerFileSystem,
    private readonly serverPaks?: ServerPakSet,
    private readonly configJournal?: ConfigFileJournal,
    private readonly copyFiles?: VfsCopyFiles,
    readonly fileMemory: ReadFileMemory = new ReadFileMemory(),
    private readonly diagnostics?: VfsDiagnostics,
    private readonly isRestricted: () => boolean = () => false,
    private readonly mountGameDirectory?: (game: string) => void,
    private readonly startupGame: "baseq3" | "demota" = "baseq3",
    private readonly readCdKeys?: () => void,
    private readonly isFullyInitialized: () => boolean = () => true,
    private readonly missingFiles?: MissingFileLog,
  ) {
    this.handles = handles ?? new SourceFileHandles();
    this.ownsHandles = handles === undefined;
  }

  /** FS_AddGameDirectory publishes each directory and pack to this actual owner. */
  async startup(): Promise<void> {
    this.assertLive();
    if (this.started) throw new Error("Filesystem startup has already been reached");
    this.started = true;
    const inputs = this.searchOptions, startupGame = this.startupGame;
    const options: NativeSearchRoots = { ...inputs, dataPath: hostRootInput(inputs.dataPath),
      homePath: hostRootInput(inputs.homePath), cdPath: inputs.cdPath === null ? null : hostRootInput(inputs.cdPath) };
    const games: string[] = [startupGame];
    if (startupGame === "baseq3") {
      const baseGame = checkedGameDirectory(options.baseGameDirectory ?? "");
      const currentGame = checkedGameDirectory(options.gameDirectory ?? (options.product === "missionpack" ? "missionpack" : ""));
      if (baseGame !== "" && !pathCaseEqual(baseGame, startupGame)) games.push(baseGame);
      if (currentGame !== "" && !pathCaseEqual(currentGame, startupGame)) games.push(currentGame);
    }
    for (const game of games) {
      const roots: NativeRoot[] = [];
      if (options.cdPath !== null && options.cdPath.sourceText !== "") roots.push(options.cdPath);
      if (options.dataPath.sourceText !== "") roots.push(options.dataPath);
      // The initial game home test reads fs_basepath; the two mod tests read fs_homepath.
      if ((game === startupGame ? options.dataPath : options.homePath).sourceText !== ""
        && !pathCaseEqual(options.homePath.sourceText, options.dataPath.sourceText)) roots.push(options.homePath);
      for (const root of roots) {
        if (this.searchPaths.some(mounted => mounted.kind === "loose-directory"
          && pathCaseEqual(mounted.game, game) && pathCaseEqual(mounted.root.sourceText, root.sourceText))) continue;
        this.assertLive();
        this.mountGameDirectory?.(game);
        this.assertLive();
        const resolvedRoot = root.resolvedBytes();
        const directory = join(resolvedRoot.toString("latin1"), game);
        const nativeDirectory = looseOsPath(resolvedRoot, game);
        this.searchPaths.unshift(Object.freeze({ kind: "loose-directory", root, game, directory, nativeDirectory } satisfies LooseDirectoryMount));
        const entries = await directoryEntries(nativeDirectory);
        this.assertLive();
        const pk3Names: string[] = [];
        for (const entry of entries) {
          if (pk3Names.length === MAX_PAK_FILES) break;
          if (entry.isFile() && entry.name.toLowerCase().endsWith(".pk3")) pk3Names.push(entry.name);
        }
        pk3Names.sort(pathCompare);
        for (const pk3Name of pk3Names) {
          const archivePath = join(directory, pk3Name);
          let archive: Pk3Archive;
          try {
            archive = await Pk3Archive.open(archivePath, looseOsPath(nativeDirectory, pk3Name));
          } catch (error) {
            this.assertLive();
            if (error instanceof Pk3OpenError || isFileSystemFailure(error)) continue;
            throw error;
          }
          try {
            this.assertLive();
            let catalogEntry: PakCatalogEntry | null = null;
            if (this.referenceTracker !== null) {
              catalogEntry = Object.freeze({
                game,
                basename: pk3Name.length > 4 ? pk3Name.slice(0, -4) : pk3Name,
                archivePath,
                checksum: archive.checksum,
                pureChecksum: archive.pureChecksum(this.referenceTracker.checksumFeed),
              } satisfies PakCatalogEntry);
              this.referenceTracker.prependPack(catalogEntry);
            }
            this.searchPaths.unshift(Object.freeze({
              kind: "pk3",
              game,
              archive,
              archivePath,
              catalogEntry,
            } satisfies Pk3Mount));
          } catch (error) {
            try { archive.close(); } finally { throw error; }
          }
        }
      }
    }
    this.readCdKeys?.();
    this.assertLive();
    const checksums = this.serverPaks?.checksums ?? [];
    const purePaths = this.searchPaths.map((mount): PureSearchPath<SearchPathMount> => mount.kind === "pk3"
      ? { kind: "pak", checksum: mount.archive.checksum, value: mount }
      : { kind: "directory", value: mount });
    const orderedPaths = reorderPurePaks(purePaths, checksums).map(path => path.value);
    this.reordered = this.searchPaths.some(mount => mount.kind === "pk3" && checksums.length > 0 && isPakPure(mount.archive.checksum, checksums));
    const packs: PakCatalogEntry[] = [];
    for (const searchPath of orderedPaths) {
      if (searchPath.kind === "pk3" && searchPath.catalogEntry !== null) packs.push(searchPath.catalogEntry);
    }
    this.referenceTracker?.reorderPacks(packs);
    this.searchPaths = orderedPaths;
    this.missingFiles?.startup();
  }

  private assertLive(): void {
    if (this.retired) throw new Error("Filesystem view is retired");
    this.handles.assertActive();
  }

  protected assertActive(): void {
    this.assertLive();
    if (!this.initialized) throw new CommonError("fatal", "Filesystem call made without initialization\n");
  }

  get initialized(): boolean { return !this.retired && !this.handles.closed && this.searchPaths.length > 0; }

  retire(): void {
    if (this.retired) return;
    this.retired = true;
    const failures: unknown[] = [];
    for (const mount of this.searchPaths) {
      if (mount.kind !== "pk3") continue;
      try { mount.archive.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length !== 0) throw new AggregateError(failures, "Failed to retire filesystem mounts", { cause: failures[0] });
  }

  close(): void {
    const failures: unknown[] = [];
    try { this.retire(); } catch (error) { failures.push(error); }
    if (this.ownsHandles) {
      try { this.handles.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length !== 0) throw new AggregateError(failures, "Failed to close filesystem view", { cause: failures[0] });
  }

  [Symbol.dispose](): void { this.close(); }

  static async openInspection(options: VfsRootOptions): Promise<VirtualFileSystem> {
    return new VirtualFileSystem(options, null).finishOpen();
  }

  static async openTracked(options: VfsTrackedSearchOptions): Promise<TrackedVirtualFileSystem> {
    return VirtualFileSystem.createTracked(options).finishOpen();
  }

  static createTracked(options: VfsTrackedSearchOptions): TrackedVirtualFileSystem {
    return new TrackedVirtualFileSystem(options);
  }

  private async finishOpen(): Promise<this> {
    try {
      await this.startup();
      return this;
    } catch (error) {
      try { this.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Filesystem open and cleanup failed", { cause: error }); }
      throw error;
    }
  }

  private find(path: string): MountedFile | undefined {
    this.assertActive();
    const normalized = normalizeAssetPath(path);
    const loosePath = looseRequestPath(path);
    for (const searchPath of this.searchPaths) {
      switch (searchPath.kind) {
        case "pk3":
          if (searchPath.archive.has(normalized)) {
            const provenance = Object.freeze({
              kind: "pk3",
              game: searchPath.game,
              path: normalized,
              archivePath: searchPath.archivePath,
            } satisfies Pk3Source);
            return Object.freeze({
              kind: "pk3",
              archive: searchPath.archive,
              catalogEntry: searchPath.catalogEntry,
              provenance,
            } satisfies PackedFile);
          }
          break;
        case "loose-directory": {
          const filePath = join(searchPath.directory, loosePath);
          const descriptor = openLooseDescriptor(searchPath.nativeDirectory, loosePath);
          if (descriptor === undefined) break;
          closeSync(descriptor);
          const provenance = Object.freeze({
            kind: "loose",
            game: searchPath.game,
            path: normalized,
            filePath,
          } satisfies LooseSource);
          return Object.freeze({ kind: "loose", provenance } satisfies LooseFile);
        }
        default: {
          const exhaustive: never = searchPath;
          throw new Error(`Unknown search path kind: ${String(exhaustive)}`);
        }
      }
    }
    return undefined;
  }

  has(path: string): boolean {
    return this.find(path) !== undefined;
  }

  private purePack(mount: Pk3Mount): boolean {
    return isPakPure(mount.archive.checksum, this.serverPaks?.checksums ?? []);
  }

  private get pure(): boolean { return (this.serverPaks?.checksums.length ?? 0) > 0; }

  list(prefix = ""): readonly string[] {
    this.assertActive();
    const normalizedPrefix = normalizePrefix(prefix);
    const paths = new Set<string>();
    for (const searchPath of this.searchPaths) {
      switch (searchPath.kind) {
        case "pk3":
          if (!this.purePack(searchPath)) break;
          for (const path of searchPath.archive.list(normalizedPrefix)) paths.add(path);
          break;
        case "loose-directory":
          if (this.isRestricted() || this.pure) break;
          for (const path of loosePaths(searchPath.nativeDirectory)) {
            if (path.startsWith(normalizedPrefix)) paths.add(path);
          }
          break;
        default: {
          const exhaustive: never = searchPath;
          throw new Error(`Unknown search path kind: ${String(exhaustive)}`);
        }
      }
    }
    return Object.freeze([...paths].sort());
  }

  /** FS_GetFileList reads the current source search order and pure-server restrictions. */
  getFileList(path: string, extension: string, destination: Uint8Array): number {
    this.assertActive();
    if (destination.byteLength === 0) throw new RangeError("File listing requires a nonempty destination");
    destination[0] = 0;
    checkSourceListBytes(path, "Listing path");
    if (pathCaseEqual(path, "$modlist")) {
      if (this.serverFiles === undefined) throw new Error("$modlist requires a common server-filesystem owner for FS_SV reads");
      return this.serverFiles.getModList(destination);
    }
    const names = this.listFilteredFiles(path, extension, null);
    let total = 0;
    let count = 0;
    for (const name of names) {
      const length = name.length + 1;
      if (total + length + 1 >= destination.byteLength) break;
      for (let index = 0; index < name.length; index++) destination[total + index] = name.charCodeAt(index);
      destination[total + name.length] = 0;
      total += length;
      count++;
    }
    return count;
  }

  /** FS_ListFilteredFiles preserves search-path and central-directory order. */
  listFilteredFiles(path: string, extension: string, filter: string | null): readonly string[] {
    this.assertActive();
    checkSourceListBytes(path, "Listing path");
    checkSourceListBytes(extension, "Listing extension");
    if (filter !== null) checkSourceListBytes(filter, "Listing filter");
    if (path.length >= 256) throw new RangeError("Listing path exceeds source MAX_ZPATH");
    normalizePrefix(path);
    const pathLength = path.endsWith("/") || path.endsWith("\\") ? path.length - 1 : path.length;
    const pathDepth = listedPathParts(path).depth;
    const names: string[] = [];
    for (const searchPath of this.searchPaths) {
      if (searchPath.kind === "loose-directory") {
        if (this.isRestricted() || this.pure) continue;
        const loose = filter === null ? listLooseNames(searchPath.nativeDirectory, path, extension)
          : listFilteredLooseNames(searchPath.nativeDirectory, path, filter);
        for (const name of loose) addListedName(names, name);
        continue;
      }
      if (!this.purePack(searchPath)) continue;
      for (const sourceName of searchPath.archive.sourceNames) {
        const name = sourceName.kind === "supported" ? sourceName.name : sourceName.rawName;
        const parts = listedPathParts(name);
        if (filter === null ? (parts.depth - pathDepth > 2 || pathLength > parts.length
          || !pathCaseEqual(name.slice(0, pathLength), path.slice(0, pathLength))
          || !listSuffixMatches(name, extension)) : !filterPath(filter, name)) continue;
        if (sourceName.kind === "unsupported") {
          throw new Error(`Unsupported PK3 listing name in ${JSON.stringify(searchPath.archivePath)}: ${sourceName.reason}`);
        }
        addListedName(names, filter === null ? name.slice(pathLength === 0 ? 0 : pathLength + 1) : name);
      }
    }
    return names;
  }

  /** FS_Path_f reports all mounted packs, including packs excluded by pure. */
  printSearchPath(print: (text: string) => void): void {
    this.assertLive();
    print("Current search path:\n");
    for (const mount of this.searchPaths) {
      this.assertLive();
      if (mount.kind === "loose-directory") print(`${mount.directory}\n`);
      else {
        print(`${mount.archivePath} (${mount.archive.sourceNames.length} files)\n`);
        this.assertLive();
        if (this.pure) print(this.purePack(mount) ? "    on the pure list\n" : "    not on the pure list\n");
      }
    }
    print("\n");
    this.assertLive();
    this.handles.printOpenFiles(print);
  }

  source(path: string): VfsSource | undefined {
    return this.find(path)?.provenance;
  }

  private acquire(path: string, kind: "shared" | "unique" | "mode", debugPrint = this.diagnostics?.debugPrint,
    selected?: (file: FileHandle) => void): OpenedRead | undefined {
    this.assertActive();
    if (path.startsWith("/") || path.startsWith("\\")) path = path.slice(1);
    if (path.includes("..") || path.includes("::")) return undefined;
    const normalized = normalizeAssetPath(path);
    if (this.isFullyInitialized() && path.includes("q3key")) return undefined;
    const file = this.handles.selectFree();
    selected?.(file);
    const loosePath = looseRequestPath(path);
    for (const searchPath of this.searchPaths) {
      if (searchPath.kind === "pk3") {
        if (!this.purePack(searchPath)) continue;
        if (!searchPath.archive.has(normalized)) continue;
        if (this.referenceTracker !== null) {
          if (searchPath.catalogEntry === null) throw new Error("Tracked PK3 mount has no catalog identity");
          this.referenceTracker.recordPackedOpen(searchPath.catalogEntry, path);
        }
        const reader = kind === "shared" ? searchPath.archive.openSharedRead(normalized) : searchPath.archive.openRead(normalized);
        try { this.handles.attachPackedRead(file, reader); }
        catch (error) {
          try { reader.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Failed packed acquisition cleanup", { cause: error }); }
          throw error;
        }
        try {
          this.handles.setName(file, path);
          debugPrint?.(`FS_FOpenFileRead: ${path} (found in '${searchPath.archivePath}')\n`);
          this.assertActive();
          if (kind === "mode") this.handles.setReadMode(file, reader.length);
          return Object.freeze({ file, length: reader.length });
        } catch (error) {
          this.closeFailedAcquisition(file, error);
        }
      } else {
        if ((this.isRestricted() || this.pure) && !allowedPureLoosePath(path)) continue;
        const filePath = join(searchPath.directory, loosePath);
        const descriptor = openLooseDescriptor(searchPath.nativeDirectory, loosePath);
        if (descriptor === undefined) continue;
        try { this.handles.attachLooseRead(file, descriptor); }
        catch (error) {
          try { closeSync(descriptor); } catch (cleanup) { throw new AggregateError([error, cleanup], "Failed loose acquisition cleanup", { cause: error }); }
          throw error;
        }
        try {
          this.referenceTracker?.recordLooseOpen(path);
          this.assertActive();
          this.handles.setName(file, path);
          debugPrint?.(`FS_FOpenFileRead: ${path} (found in '${searchPath.directory}')\n`);
          this.assertActive();
          if (this.copyFiles !== undefined) {
            const copy = this.copyFiles.cvars.get("fs_copyfiles");
            const cd = this.copyFiles.cvars.get("fs_cdpath");
            const base = this.copyFiles.cvars.get("fs_basepath");
            if (copy === undefined || cd === undefined || base === undefined) throw new Error("Filesystem copy cvars are not initialized");
            if (copy.integerValue !== 0 && pathCaseEqual(searchPath.root.sourceText, cd.value)) {
              this.copyFiles.writable.copyFileFromCd(searchPath.directory, searchPath.game, loosePath,
                NativeRoot.fromSource(base.value), searchPath.nativeDirectory);
              this.assertActive();
            }
          }
          const provenance: LooseSource = { kind: "loose", game: searchPath.game, path: normalized, filePath };
          let length: number;
          try { length = this.handles.captureLooseLength(file); }
          catch (error) { throw new Error(`Failed to inspect loose asset ${JSON.stringify(path)}: ${errorDetail(error)}`, { cause: error }); }
          validateSourceLength(provenance, length);
          if (kind === "mode") this.handles.setReadMode(file, length);
          return Object.freeze({ file, length });
        } catch (error) {
          this.closeFailedAcquisition(file, error);
        }
      }
    }
    this.diagnostics?.developerPrint(`Can't find ${path}\n`);
    this.assertActive();
    this.missingFiles?.record(path);
    return undefined;
  }

  private closeFailedAcquisition(file: FileHandle, error: unknown): never {
    if (error instanceof CommonError) throw error;
    try { this.handles.closeFile(file); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Failed filesystem acquisition cleanup", { cause: error }); }
    throw error;
  }

  openRead(path: string, debugPrint?: (text: string) => void, selected?: (file: FileHandle) => void): OpenedRead | undefined {
    return this.acquire(path, "mode", debugPrint, selected);
  }

  /** FS_FOpenFileRead(qtrue) retains a unique reader without FS_FOpenFileByMode metadata. */
  openUniqueRead(path: string, selected?: (file: FileHandle) => void): OpenedRead | undefined {
    return this.acquire(path, "unique", this.diagnostics?.debugPrint, selected);
  }

  readInto(file: FileHandle, destination: Uint8Array): number {
    this.assertActive();
    return this.handles.readInto(file, destination);
  }

  seekFile(file: FileHandle, offset: number, origin: number): number {
    this.assertActive();
    return this.handles.seek(file, offset, origin);
  }

  closeFile(file: FileHandle): void {
    this.assertActive();
    this.handles.closeFile(file);
  }

  fileLength(path: string): number {
    const opened = this.acquire(path, "shared");
    if (opened === undefined) return -1;
    this.handles.closeFile(opened.file);
    return opened.length;
  }

  /** FS_ReadFile(qpath, NULL), distinct from FS_FOpenFileRead length-only probes. */
  readFileLength(path: string): number {
    this.assertActive();
    if (path.length === 0) throw new CommonError("fatal", "FS_ReadFile with empty name\n");
    const journal = path.includes(".cfg") ? this.configJournal : undefined;
    if (journal?.mode === 2) return journal.readLength(path);
    const opened = this.acquire(path, "shared"), length = opened === undefined ? -1 : opened.length;
    if (journal?.mode === 1) journal.writeLength(path, length);
    if (opened !== undefined) this.handles.closeFile(opened.file);
    return length;
  }

  async read(path: string): Promise<Uint8Array> {
    return this.readSync(path);
  }

  readSync(path: string): Uint8Array {
    const bytes = this.readOptionalSync(path);
    if (bytes === undefined) throw new Error(`Asset not found: ${JSON.stringify(path)}`);
    return bytes;
  }

  /** Detached adapter: the source allocation is released after copying the completed read. */
  async readFileOptional(path: string): Promise<Uint8Array | undefined> {
    return this.readFileOptionalSync(path);
  }

  readFileOptionalSync(path: string): Uint8Array | undefined {
    const buffer = this.readFileRetainedSync(path);
    if (buffer === undefined) return undefined;
    const bytes = buffer.bytes.slice();
    this.freeFile(buffer);
    return bytes;
  }

  async readFileRetained(path: string): Promise<RetainedFileBuffer | undefined> {
    return this.readFileRetainedSync(path);
  }

  /** FS_ReadFile(qpath, &buffer). The caller owns FS_FreeFile at its source position. */
  readFileRetainedSync(path: string): RetainedFileBuffer | undefined {
    this.assertActive();
    if (path.length === 0) throw new CommonError("fatal", "FS_ReadFile with empty name\n");
    const journal = path.includes(".cfg") ? this.configJournal : undefined;
    if (journal?.mode === 2) return journal.readFileRetained(path, this.fileMemory);
    const opened = this.acquire(path, "shared");
    if (opened === undefined) {
      if (journal?.mode === 1) journal.writeFile(path, undefined);
      return undefined;
    }
    const buffer = this.fileMemory.read(opened.length, bytes => { this.handles.readInto(opened.file, bytes); });
    this.handles.closeFile(opened.file);
    if (journal?.mode === 1) journal.writeFile(path, buffer.bytes);
    return buffer;
  }

  freeFile(buffer: RetainedFileBuffer): void {
    this.assertActive();
    this.fileMemory.freeFile(buffer);
  }

  private readOptionalSync(path: string): Uint8Array | undefined {
    normalizeAssetPath(path);
    const opened = this.acquire(path, "shared");
    if (opened === undefined) return undefined;
    let bytes: Uint8Array;
    try {
      if (!Number.isInteger(opened.length) || opened.length < 0 || opened.length > 0x7fffffff) {
        throw new RangeError("Whole-file read length exceeds the source signed file size");
      }
      bytes = new Uint8Array(opened.length);
      const copied = this.handles.readInto(opened.file, bytes);
      this.handles.validateWholeRead(opened.file, opened.length, copied);
    } catch (error) {
      this.closeFailedAcquisition(opened.file, error);
    }
    this.handles.closeFile(opened.file);
    return bytes;
  }

  protected packedCatalogEntry(path: string): PakCatalogEntry | undefined {
    this.assertActive();
    const normalized = normalizeAssetPath(path);
    for (const searchPath of this.searchPaths) {
      if (searchPath.kind === "pk3" && this.purePack(searchPath) && searchPath.archive.has(normalized)) {
        if (searchPath.catalogEntry === null) return undefined;
        return searchPath.catalogEntry;
      }
    }
    return undefined;
  }
}

export class TrackedVirtualFileSystem extends VirtualFileSystem {
  readonly pakReferences: PakReferences;

  constructor(options: VfsTrackedSearchOptions) {
    const references = new PakReferences({ packs: [], checksumFeed: options.references.checksumFeed, random: options.references.random });
    super(options, references, options.handles, options.serverFiles, options.serverPaks, options.configJournal,
      options.copyFiles, options.fileMemory, options.diagnostics, options.isRestricted, options.mountGameDirectory, options.startupGame,
      options.readCdKeys, options.isFullyInitialized, options.missingFiles);
    this.pakReferences = references;
  }

  get pureReordered(): boolean { return this.reordered; }

  pakPureChecksum(path: string): number | undefined {
    return this.packedCatalogEntry(path)?.pureChecksum;
  }
}
