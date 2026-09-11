// Filesystem lifetime from id Software's code/qcommon/files.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { SourceFileHandles } from "./file-handles.ts";
import type { FileHandle } from "./file-handles.ts";
import { ServerFileSystem } from "./server-files.ts";
import { CvarFlag } from "../core/cvar.ts";
import { CommonError } from "../core/common-error.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import type { SoundOutput } from "../engine/sound-output.ts";
import type { CommonConsole } from "../engine/common-console.ts";
import { checkedGameDirectory, pathCaseEqual, VirtualFileSystem } from "./vfs.ts";
import type { NativeSearchRoots, OpenedRead, TrackedVirtualFileSystem, VfsReferenceOptions, VfsRootOptions } from "./vfs.ts";
import { hostRootInput, NativeRoot } from "./native-root.ts";
import { MissingFileLog } from "./missing-file-log.ts";
import { isPrereleaseDemo } from "../core/product-profile.ts";
import { WritableFileSystem } from "./writable-files.ts";
import { ServerPakSet } from "./pak-references.ts";
import type { ServerPak } from "./pak-references.ts";
import { ReadFileMemory } from "./read-file-memory.ts";
import type { HunkArena } from "../core/hunk.ts";
import type { ZoneArena } from "../core/zone.ts";
import type { Product } from "../shared/definitions.ts";

const DEMO_PAK_CHECKSUM = 437558517;
const SCRAMBLED_PRODUCT_ID = new Uint8Array([
  220, 129, 255, 108, 244, 163, 171, 55, 133, 65, 199, 36, 140, 222, 53, 99,
  65, 171, 175, 232, 236, 193, 210, 250, 169, 104, 231, 231, 21, 201, 170, 208,
  135, 175, 130, 136, 85, 215, 71, 23, 96, 32, 96, 83, 44, 240, 219, 138,
  184, 215, 73, 27, 196, 247, 55, 139, 148, 68, 78, 203, 213, 238, 139, 23,
  45, 205, 118, 186, 236, 230, 231, 107, 212, 1, 10, 98, 30, 20, 116, 180,
  216, 248, 166, 35, 45, 22, 215, 229, 35, 116, 250, 167, 117, 3, 57, 55,
  201, 229, 218, 222, 128, 12, 141, 149, 32, 110, 168, 215, 184, 53, 31, 147,
  62, 12, 138, 67, 132, 54, 125, 6, 221, 148, 140, 4, 21, 44, 198, 3,
  126, 12, 100, 236, 61, 42, 44, 251, 15, 135, 14, 134, 89, 92, 177, 246,
  152, 106, 124, 78, 118, 80, 28, 42,
]);

type MountState =
  | { readonly kind: "unmounted" }
  | { readonly kind: "mounted"; readonly files: TrackedVirtualFileSystem }
  | { readonly kind: "retired" }
  | { readonly kind: "closed" };

export type FileOpenMode = "read" | "write" | "append" | "append-sync";

/** Common owns source handles. A null configuration owner is the standalone asset-tool mount profile. */
export class CommonFileState {
  readonly roots: NativeSearchRoots;
  private readonly initialBase: NativeRoot;
  private readonly initialHome: NativeRoot;
  private readonly initialCd: NativeRoot | null;
  private readonly missingFiles: MissingFileLog;
  readonly writable: WritableFileSystem;
  readonly server: ServerFileSystem;
  readonly fileMemory: ReadFileMemory;
  private readonly handles = new SourceFileHandles();
  private state: MountState = { kind: "unmounted" };
  private mounting = false;
  private readonly loaded = new ServerPakSet();
  private readonly referenced = new ServerPakSet();
  private references: VfsReferenceOptions | null = null;
  private reordered = false;

  constructor(
    private readonly initialRoots: VfsRootOptions,
    private readonly print: (text: string) => undefined,
    private readonly sound: SoundOutput,
    private readonly cvars: CvarRegistry,
    private readonly configuration: CommonConsole | null = null,
    hunk: () => HunkArena | null = () => null,
    mainZone: (() => ZoneArena) | null = null,
  ) {
    const initialBase = hostRootInput(initialRoots.dataPath);
    const initialHome = hostRootInput(initialRoots.homePath);
    const initialCd = initialRoots.cdPath === null ? null : hostRootInput(initialRoots.cdPath);
    this.initialBase = initialBase;
    this.initialHome = initialHome;
    this.initialCd = initialCd;
    this.missingFiles = new MissingFileLog(initialRoots.missingFileLogPath ?? null);
    this.roots = {
      ...initialRoots,
      get product(): Product {
        const game = checkedGameDirectory(cvars.get("fs_game")?.value
          ?? initialRoots.gameDirectory ?? (initialRoots.product === "missionpack" ? "missionpack" : ""));
        const baseGame = checkedGameDirectory(cvars.get("fs_basegame")?.value ?? initialRoots.baseGameDirectory ?? "");
        if (pathCaseEqual(game, "missionpack") || pathCaseEqual(baseGame, "missionpack")) return "missionpack";
        if (game === "" || pathCaseEqual(game, "baseq3") || pathCaseEqual(baseGame, "baseq3")) return "baseq3";
        return initialRoots.product;
      },
      get dataPath(): NativeRoot { return NativeRoot.fromSource(cvars.get("fs_basepath")?.value ?? initialBase.sourceText); },
      get homePath(): NativeRoot { return NativeRoot.fromSource(cvars.get("fs_homepath")?.value ?? initialHome.sourceText); },
      get cdPath(): NativeRoot | null {
        const path = cvars.get("fs_cdpath")?.value;
        return path === undefined ? initialCd : path === "" ? null : NativeRoot.fromSource(path);
      },
    };
    this.fileMemory = new ReadFileMemory(hunk, mainZone);
    this.writable = new WritableFileSystem({
      homePath: () => this.roots.homePath, product: initialRoots.product, print, handles: this.handles,
      clearSoundBuffer: () => {
        const view = this.current;
        this.sound.clearSoundBuffer();
        if (this.current !== view) throw new Error("Filesystem mounts changed during file open");
      },
      beforeProductOpen: (path, mode) => {
        this.fileDebugPrint(`FS_FOpenFile${mode === "write" ? "Write" : "Append"}: ${path}\n`);
      },
    });
    this.server = new ServerFileSystem(this, this.handles, sound, cvars, print);
  }

  get current(): TrackedVirtualFileSystem {
    const files = this.mountedFiles();
    this.assertInitialized();
    return files;
  }

  get initialized(): boolean { return this.state.kind === "mounted" && this.state.files.initialized; }

  private mountedFiles(): TrackedVirtualFileSystem {
    if (this.state.kind !== "mounted") throw new Error("Common filesystem has no active mounts");
    return this.state.files;
  }

  assertInitialized(): void {
    if (!this.initialized) throw new CommonError("fatal", "Filesystem call made without initialization\n");
  }

  /** FS_FOpenFileByMode borrows the common table used by every typed caller. */
  openByMode(path: string, mode: FileOpenMode, publish?: (file: FileHandle | null) => void): OpenedRead | undefined {
    this.assertInitialized();
    const view = this.current;
    if (mode === "read") {
      const opened = view.openRead(path, undefined, publish);
      if (opened === undefined) publish?.(null);
      return opened;
    }
    const file = this.writable.openByMode(path, mode);
    publish?.(file);
    if (file !== null) this.handles.setWriteMode(file);
    return file === null ? undefined : { file, length: 0 };
  }

  readFile(slot: number, destination: Uint8Array): number {
    this.assertInitialized();
    return this.handles.read2(this.handles.fromSlot(slot), destination);
  }

  writeFile(slot: number, bytes: Uint8Array): number {
    this.assertInitialized();
    const file = this.handles.fromSlot(slot);
    return file === null ? 0 : this.writable.writeBytes(file, bytes);
  }

  seekFile(slot: number, offset: number, origin: number): number {
    this.assertInitialized();
    return this.handles.seek(this.handles.fromSlot(slot), offset, origin);
  }

  closeFile(slot: number): void {
    this.assertInitialized();
    const file = this.handles.fromSlot(slot);
    if (file === null) this.handles.closeZeroHandle();
    else this.handles.closeFile(file);
  }

  get serverLoadedPaks(): readonly ServerPak[] { this.assertOpen(); return this.loaded.snapshot(); }
  get serverReferencedPaks(): readonly ServerPak[] { this.assertOpen(); return this.referenced.snapshot(); }

  async setServerLoadedPaks(checksums: string, names: string, assertCurrentOperation: () => void): Promise<void> {
    assertCurrentOperation();
    this.assertOpen();
    if (this.mounting) throw new Error("Filesystem mount operations must be awaited");
    const count = this.loaded.setChecksums(checksums);
    if (count > 0) this.debugPrint("Connected to a pure server.\n", assertCurrentOperation);
    else if (this.reordered) {
      this.debugPrint("FS search reorder is required\n", assertCurrentOperation);
      await this.restart(this.currentReferences(), assertCurrentOperation);
      return;
    }
    this.loaded.setNames(names, count);
  }

  private debugPrint(text: string, assertCurrentOperation: () => void): void {
    const developer = this.cvars.get("developer");
    if (developer !== undefined && developer.integerValue !== 0) {
      this.print(text);
      assertCurrentOperation();
      this.current;
    }
  }

  private fileDebugPrint(text: string): void {
    const view = this.current;
    const debug = this.cvars.get("fs_debug");
    if (debug === undefined) throw new Error("Filesystem requires registered fs_debug");
    if (debug.integerValue !== 0) {
      this.print(text);
      if (this.current !== view) throw new Error("Filesystem mounts changed during file open");
    }
  }

  setServerReferencedPaks(checksums: string, names: string): void {
    this.current;
    if (this.mounting) throw new Error("Filesystem mount operations must be awaited");
    this.referenced.setChecksums(checksums);
    this.referenced.setNames(names);
  }

  async conditionalRestart(checksumFeed: number, assertCurrentOperation: () => void): Promise<boolean> {
    assertCurrentOperation();
    if (!Number.isInteger(checksumFeed) || checksumFeed < -0x8000_0000 || checksumFeed > 0xffff_ffff) {
      throw new RangeError("Checksum feed must be a signed or unsigned 32-bit integer");
    }
    const current = this.current;
    if (this.cvars.get("fs_game")?.modified !== true && current.pakReferences.checksumFeed === (checksumFeed >>> 0)) return false;
    await this.restart({ checksumFeed, random: this.currentReferences().random }, assertCurrentOperation);
    return true;
  }

  private currentReferences(): VfsReferenceOptions {
    if (this.references === null) throw new Error("Common filesystem references are not initialized");
    return this.references;
  }

  async initialize(references: VfsReferenceOptions, assertCurrentOperation: () => void): Promise<void> {
    if (this.state.kind !== "unmounted") throw new Error("Common filesystem is already initialized");
    await this.mount(references, assertCurrentOperation);
    if (this.configuration !== null) await this.setRestrictions(assertCurrentOperation);
  }

  async restart(references: VfsReferenceOptions, assertCurrentOperation: () => void): Promise<void> {
    assertCurrentOperation();
    if (this.mounting) throw new Error("Filesystem mount operations must be awaited");
    const previous = this.shutdownMount();
    await this.mount(references, assertCurrentOperation, "baseq3", previous);
    if (this.configuration !== null) {
      await this.setRestrictions(assertCurrentOperation);
      await this.configuration.finishFileSystemRestart(references.checksumFeed, assertCurrentOperation);
      assertCurrentOperation();
    }
  }

  /** FS_SetRestrictions checks the source static product artifact before selecting the demo paths. */
  async setRestrictions(assertCurrentOperation: () => void): Promise<void> {
    assertCurrentOperation();
    if (this.mounting) throw new Error("Filesystem mount operations must be awaited");
    const current = this.mountedFiles(), restriction = this.cvars.find("fs_restrict");
    if (restriction === undefined) throw new Error("Filesystem restriction cvar is not initialized");
    if (restriction.integerValue === 0 && !(this.configuration !== null && isPrereleaseDemo(this.configuration.productProfile))) {
      const productId = current.readFileRetainedSync("productid.txt");
      assertCurrentOperation();
      if (productId !== undefined) {
        const bytes = productId.terminatedBytes;
        let seed = 5000, index = 0;
        for (const scrambled of SCRAMBLED_PRODUCT_ID) {
          if ((scrambled ^ (seed & 255)) !== bytes[index]) break;
          seed = (Math.imul(69069, seed) + 1) | 0;
          index++;
        }
        current.freeFile(productId);
        assertCurrentOperation();
        if (index === SCRAMBLED_PRODUCT_ID.length) return;
        throw new CommonError("fatal", "Invalid product identification");
      }
    }
    this.cvars.set("fs_restrict", "1", true);
    this.print("\nRunning in restricted demo mode.\n\n");
    assertCurrentOperation();
    if (this.mountedFiles() !== current) throw new Error("Filesystem mounts changed during restriction selection");
    const previous = this.shutdownMount();
    await this.mount(this.currentReferences(), assertCurrentOperation, "demota", previous);
    const restricted = this.mountedFiles();
    for (const { pack } of restricted.pakReferences.snapshot()) {
      if (pack.checksum !== DEMO_PAK_CHECKSUM) throw new CommonError("fatal", `Corrupted pak0.pk3: ${pack.checksum >>> 0}`);
    }
  }

  private shutdownMount(): TrackedVirtualFileSystem {
    const previous = this.mountedFiles();
    this.state = { kind: "retired" };
    try { this.handles.closeSizedFiles(); }
    finally { previous.retire(); }
    return previous;
  }

  private assertOpen(): void {
    if (this.state.kind === "closed") throw new Error("Common filesystem is closed");
  }

  private async mount(references: VfsReferenceOptions, assertCurrentOperation: () => void,
    startupGame: "baseq3" | "demota" = "baseq3", previous: TrackedVirtualFileSystem | null = null): Promise<void> {
    assertCurrentOperation();
    this.assertOpen();
    if (this.mounting) throw new Error("Filesystem mount operations must be awaited");
    if (this.state.kind === "unmounted") {
      this.cvars.register("fs_debug", "0");
      this.cvars.register("fs_copyfiles", "0", CvarFlag.Init);
      this.cvars.register("fs_cdpath", this.initialCd?.sourceText ?? "", CvarFlag.Init);
      this.cvars.register("fs_basepath", this.initialBase.sourceText, CvarFlag.Init);
      this.cvars.register("fs_basegame", this.initialRoots.baseGameDirectory ?? "", CvarFlag.Init);
      this.cvars.register("fs_homepath", this.initialHome.sourceText, CvarFlag.Init);
      this.cvars.register("fs_game", this.initialRoots.gameDirectory ?? (this.initialRoots.product === "missionpack" ? "missionpack" : ""), CvarFlag.Init | CvarFlag.SystemInfo);
    }
    this.cvars.register("fs_restrict", "", CvarFlag.Init);
    const game = this.cvars.get("fs_game"), baseGame = this.cvars.get("fs_basegame"), restriction = this.cvars.find("fs_restrict");
    if (game === undefined || baseGame === undefined || restriction === undefined) throw new Error("Filesystem cvars are not initialized");
    const gameDirectory = startupGame === "baseq3" ? checkedGameDirectory(game.value) : "";
    const baseGameDirectory = startupGame === "baseq3" ? checkedGameDirectory(baseGame.value) : "";
    this.mounting = true;
    this.references = references;
    try {
      const files = VirtualFileSystem.createTracked({ ...this.roots, gameDirectory, baseGameDirectory, references, startupGame,
        isRestricted: () => restriction.integerValue !== 0,
        mountGameDirectory: game => { this.writable.setGameDirectory(game); },
        handles: this.handles, serverFiles: this.server, serverPaks: this.loaded,
        fileMemory: this.fileMemory,
        missingFiles: this.missingFiles,
        diagnostics: {
          debugPrint: text => this.fileDebugPrint(text),
          developerPrint: text => {
            const view = this.current;
            this.debugPrint(text, () => {
              if (this.current !== view) throw new Error("Filesystem mounts changed during file open");
            });
          },
        },
        copyFiles: { cvars: this.cvars, writable: this.writable },
        ...(this.configuration === null ? {} : {
          configJournal: this.configuration.journal,
          readCdKeys: () => { this.configuration?.readCdKeys(); assertCurrentOperation(); },
          isFullyInitialized: () => this.configuration?.fullyInitialized === true,
        }) });
      if (previous !== null) files.pakReferences.retainLooseReference(previous.pakReferences);
      this.state = { kind: "mounted", files };
      await files.startup();
      if (this.loaded.checksums.length > 0) this.reordered = files.pureReordered;
      assertCurrentOperation();
      this.assertOpen();
      this.cvars.clearModified("fs_game");
    } finally {
      this.mounting = false;
    }
  }

  /** Final managed disposal also releases source zero-size rows and direct bot logs. */
  close(): void {
    const previous = this.state;
    if (previous.kind === "closed") return;
    this.state = { kind: "closed" };
    const errors: unknown[] = [];
    const release = (operation: () => void): void => {
      try { operation(); } catch (error) { errors.push(error); }
    };
    release(() => this.handles.closeSizedFiles());
    if (previous.kind === "mounted") release(() => previous.files.retire());
    release(() => this.writable.closeAll());
    release(() => this.handles.close());
    release(() => this.missingFiles.close());
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Common filesystem disposal failed", { cause: errors[0] });
  }
}
