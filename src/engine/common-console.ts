// Port of id Software's common.c/cmd.c/cvar.c common console and configuration lifetime.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CommonFileState } from "../assets/filesystem-state.ts";
import { hostRootInput } from "../assets/native-root.ts";
import { checkedGameDirectory, pathCompare } from "../assets/vfs.ts";
import type { NativeSearchRoots, VfsRootOptions } from "../assets/vfs.ts";
import type { WritableLog } from "../assets/writable-files.ts";
import { CollisionMapLoader } from "../collision/map-loader.ts";
import { CollisionCounters } from "../collision/counters.ts";
import { SourceMessageState } from "../protocol/message.ts";
import { CollisionDebugSurface } from "../collision/patch.ts";
import { CollisionMapSettings } from "../collision/world.ts";
import { CommandBuffer } from "../core/commands.ts";
import type {
  AsyncCommandHandler,
  CommandContext,
  CommandFallbackResolver,
  CommandLookup,
  ResolvedCommandHandler,
} from "../core/commands.ts";
import { ConsoleOutput } from "../core/console-output.ts";
import { CommonError } from "../core/common-error.ts";
import { CvarFlag, CvarRegistry } from "../core/cvar.ts";
import { RETAIL_PRODUCT_PROFILE } from "../core/product-profile.ts";
import type { ProductProfile } from "../core/product-profile.ts";
import { ZoneArena } from "../core/zone.ts";
import { SourceZoneStrings } from "../core/zone-strings.ts";
import type { CvarSnapshot, CvarStringInput } from "../core/cvar.ts";
import { sourceFilter } from "../core/filter.ts";
import { nativeAtof, nativeAtoi } from "../core/native-numeric.ts";
import type { LinuxNativeRandom } from "../core/native-random.ts";
import type { SystemClock } from "../platform/system-clock.ts";
import { VmRegistry } from "../vm/registry.ts";
import type { StartupCommands } from "./startup-commands.ts";
import { SoundOutput } from "./sound-output.ts";
import { CommonCdKeyState } from "./cd-key.ts";
import { CommonJournal } from "./common-journal.ts";
import { CommonHunk } from "./common-hunk.ts";
import { CommonEventMemory } from "./event-memory.ts";

export interface CommonEarlyServices {
  readonly commands: CommandBuffer;
  readonly cvars: CvarRegistry;
  readonly output: ConsoleOutput;
  assertOwnerEntry(): undefined;
}
export interface CommonClientBootstrap {
  initializeKeyCommands(services: CommonEarlyServices): void;
  writeBindings(write: (text: string) => undefined): void;
  consolePrint(text: string): void;
  usesUniqueKey(): number | Promise<number>;
}
export type CommonBuildProfile =
  | { readonly kind: "dedicated" }
  | { readonly kind: "client"; readonly client: CommonClientBootstrap };
export interface CommonConsoleOptions {
  readonly roots: VfsRootOptions;
  readonly startup: StartupCommands;
  readonly random: LinuxNativeRandom;
  readonly build: CommonBuildProfile;
  readonly platformPrint: (text: string) => undefined;
  readonly resolveCommand: CommandFallbackResolver;
  readonly assertCommandEntry: () => undefined;
  readonly assertOwnerEntry: () => undefined;
}

export type CommonErrorCvarName = "com_buildScript" | "sv_running" | "cl_running";
type CommonBinding = CommonErrorCvarName | "dedicated" | "developer" | "logfile";
type CommonFileOwner = { readonly kind: "unconfigured" } | {
  readonly kind: "configured";
  readonly roots: VfsRootOptions;
  readonly files: CommonFileState;
};

function argument(context: CommandContext, index: number): string { return context.argv[index] ?? ""; }
function startupDebug(startup: StartupCommands, name: string): boolean {
  let enabled = false;
  for (const line of startup.lines) {
    if (line.argv[0] === "set" && line.argv[1]?.toLowerCase() === name.toLowerCase()) enabled = nativeAtoi(line.argv[2] ?? "") !== 0;
  }
  return enabled;
}
// The pinned Linux/glibc print profile formats a NULL %s argument as (null).
function cvarPrintText(value: CvarStringInput | null): string {
  return value === null ? "(null)" : typeof value === "string" ? value : value.value;
}
function configPath(text: string): string {
  let path = text.slice(0, 63);
  if (!path.slice(path.lastIndexOf("/") + 1).includes(".")) path = `${path}.cfg`.slice(0, 63);
  return path;
}
function sourceText(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) { if (byte === 0) break; text += String.fromCharCode(byte); }
  return text;
}
function sourceDate(date: Date): string {
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()];
  if (weekday === undefined || month === undefined) throw new Error("Cannot format an invalid console log date");
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, "0")).join(":");
  return `${weekday} ${month} ${String(date.getDate()).padStart(2, " ")} ${time} ${date.getFullYear()}\n`;
}

export class CommonConsole {
  readonly sound = new SoundOutput();
  readonly vm = new VmRegistry(text => { this.output.print(text); }, () => {
    const level = this.cvars.get("com_vmDebug")?.integerValue ?? 0;
    return level <= 0 ? { kind: "release" } : { kind: "debug", trace: level >= 3 ? 2 : level === 2 ? 1 : 0,
      breakFunction: this.cvars.get("com_vmBreakFunction")?.integerValue ?? 0 };
  });
  readonly cdKey: CommonCdKeyState;
  readonly cvars: CvarRegistry;
  readonly collisionDebug: CollisionDebugSurface;
  readonly collisionSettings: CollisionMapSettings;
  readonly collision: CollisionMapLoader;
  readonly collisionCounters = new CollisionCounters();
  readonly sourceState: SourceMessageState;
  readonly commands: CommandBuffer;
  readonly output: ConsoleOutput;
  readonly startup: StartupCommands;
  readonly journal: CommonJournal;
  readonly eventMemory = new CommonEventMemory(() => this.mainZone);
  readonly hunk: CommonHunk;
  private readonly smallZone: ZoneArena;
  private readonly strings: SourceZoneStrings;
  private readonly zoneDebug: boolean;
  private zone: ZoneArena | null = null;
  private fileOwner: CommonFileOwner = { kind: "unconfigured" };
  private phase: "core" | "filesystem" | "runtime" | "initialized" | "closed" = "core";
  private logfile: WritableLog | null = null;
  private readonly bindings = new Set<CommonBinding>();
  private openingLog = false;
  private lastValidFileSystem: { readonly base: string; readonly game: string } | null = null;
  private commonClock: SystemClock | null = null;
  private vmInitialized = false;
  private selectedProductProfile: ProductProfile = RETAIL_PRODUCT_PROFILE;

  get productProfile(): ProductProfile { return this.selectedProductProfile; }

  static async open(options: CommonConsoleOptions, adopt: (common: CommonConsole) => undefined): Promise<CommonConsole> {
    const common = new CommonConsole(options);
    adopt(common);
    try {
      common.initializeCore();
      const owner = common.configuredFiles();
      await owner.files.initialize({ checksumFeed: 0,
        random: () => Math.fround((options.random.next() & 0x7fff) / 32767) }, options.assertOwnerEntry);
      common.phase = "filesystem";
      if (owner.files.current.readFileLength("default.cfg") <= 0) throw new CommonError("fatal", "Couldn't load default.cfg");
      common.lastValidFileSystem = { base: common.cvar("fs_basepath").value, game: common.cvar("fs_game").value };
      common.cvars.clearModified("fs_game");
      common.startup.applyVariables(common.cvars, "journal");
      common.journal.initialize();
      common.assertCapabilities();
      return common;
    } catch (error) {
      if (error instanceof CommonError) throw error;
      try { common.close(); }
      catch (cleanupError) {
        if (cleanupError instanceof CommonError) throw cleanupError;
        throw new AggregateError([error, cleanupError], "Common initialization and cleanup failed");
      }
      throw error;
    }
  }

  private constructor(private readonly options: CommonConsoleOptions) {
    this.zoneDebug = startupDebug(options.startup, "com_zoneDebug");
    this.smallZone = new ZoneArena(512 * 1024, "small", this.zoneDebug ? {
      onAllocationFailure: () => { if (this.logfile !== null) this.logHeap(); },
    } : undefined);
    this.strings = new SourceZoneStrings(this.smallZone);
    this.output = new ConsoleOutput(text => { this.normalPrint(text); });
    this.sourceState = new SourceMessageState(text => { this.output.print(text); });
    this.cvars = new CvarRegistry(text => { this.cvarPrint(text); }, text => {
      if (this.bindings.has("developer") && this.cvar("developer").integerValue !== 0) this.cvarPrint(text);
    }, this.strings);
    this.hunk = new CommonHunk(options.build.kind, this.cvars, text => { this.output.print(text); }, this.vm,
      text => { this.logfile?.write(text); });
    this.collisionDebug = new CollisionDebugSurface({
      cvars: this.cvars,
      windings: {
        allocate: bytes => this.mainZone.allocate(bytes, 1, true),
        free: allocation => { this.mainZone.free(allocation); },
      },
      print: text => { this.output.print(text); },
      developerPrint: text => {
        if (this.bindings.has("developer") && this.cvar("developer").integerValue !== 0) this.output.print(text);
      },
    });
    this.collisionSettings = new CollisionMapSettings(this.cvars);
    this.collision = new CollisionMapLoader({
      counters: this.collisionCounters,
      files: () => this.files.current,
      memory: () => ({ kind: "source-hunk", accounting: this.hunk.accounting }),
      debug: { kind: "shared", owner: this.collisionDebug, settings: this.collisionSettings },
      developerPrint: text => {
        if (this.bindings.has("developer") && this.cvar("developer").integerValue !== 0) this.output.print(text);
      },
    });
    this.cdKey = new CommonCdKeyState(this.cvars, options.build.kind);
    this.commands = new CommandBuffer({ strings: this.strings, print: text => { this.cvarPrint(text); },
      waitRegistration: "manual", resolveFallback: lookup => this.resolveFallback(lookup),
      assertExecutionEntry: () => { this.opened(); this.options.assertCommandEntry(); } });
    this.startup = options.startup;
    this.journal = new CommonJournal(this.cvars, () => this.files, text => { this.cvarPrint(text); }, text => {
      if (this.bindings.has("developer") && this.cvar("developer").integerValue !== 0) this.cvarPrint(text);
    }, () => { this.opened(); this.commands.assertCurrentExecution(); this.options.assertOwnerEntry(); }, this.eventMemory);
  }

  private initializeCore(): void {
    const options = this.options;
    this.cvars.register("sv_cheats", "1", CvarFlag.ReadOnly | CvarFlag.SystemInfo);
    const zoneMegs = this.cvars.register("com_zoneMegs", "16", CvarFlag.Latch | CvarFlag.Archive).integerValue;
    this.zone = new ZoneArena((zoneMegs < 20 ? 16 : zoneMegs) * 1048576, "main", this.zoneDebug ? {
      onAllocationFailure: () => { if (this.logfile !== null) this.logHeap(); },
    } : undefined);
    this.registerEarlyCommands();
    this.startup.applyVariables(this.cvars, null);
    this.startup.applyVariables(this.cvars, "developer");
    this.cvars.register("com_vmDebug", "0");
    this.cvars.register("com_vmBreakFunction", "0");
    this.cvars.register("com_botDebug", "0", CvarFlag.Init);
    this.cvars.register("com_gameDebug", "0", CvarFlag.Init);
    this.cvars.register("com_serverDebug", "0", CvarFlag.Init);
    this.cvars.register("com_rendererDebug", "0", CvarFlag.Init);
    this.cvars.register("com_zoneDebug", "0", CvarFlag.Init);
    this.cvars.register("com_hunkDebug", "0", CvarFlag.Init);
    const prereleaseDemo = this.cvars.register("com_prereleaseDemo", "0", CvarFlag.Init).integerValue !== 0;
    const prereleaseTeamArena = this.cvars.register("com_prereleaseTeamArenaDemo", "0", CvarFlag.Init).integerValue !== 0;
    this.selectedProductProfile = prereleaseDemo
      ? { kind: "prerelease-demo", teamArenaUi: prereleaseTeamArena ? "demo" : "retail" }
      : prereleaseTeamArena ? { kind: "prerelease-ta-demo" } : RETAIL_PRODUCT_PROFILE;
    if (options.build.kind === "client") options.build.client.initializeKeyCommands({ commands: this.commands, cvars: this.cvars,
      output: this.output, assertOwnerEntry: options.assertOwnerEntry });
    for (const name of ["fs_cdpath", "fs_basepath", "fs_homepath", "fs_game", "fs_copyfiles", "fs_restrict"]) this.startup.applyVariables(this.cvars, name);
    this.output.print("----- FS_Startup -----\n");
    this.cvars.register("fs_debug", "0"); this.cvars.register("fs_copyfiles", "0", CvarFlag.Init);
    this.cvars.register("fs_cdpath", hostRootInput(options.roots.cdPath ?? "").sourceText, CvarFlag.Init);
    this.cvars.register("fs_basepath", hostRootInput(options.roots.dataPath).sourceText, CvarFlag.Init);
    this.cvars.register("fs_basegame", options.roots.baseGameDirectory ?? "", CvarFlag.Init);
    this.cvars.register("fs_homepath", hostRootInput(options.roots.homePath).sourceText, CvarFlag.Init);
    this.cvars.register("fs_game", options.roots.gameDirectory ?? (options.roots.product === "missionpack" ? "missionpack" : ""), CvarFlag.Init | CvarFlag.SystemInfo);
    this.cvars.register("fs_restrict", "", CvarFlag.Init);
    const roots = options.roots;
    this.fileOwner = { kind: "configured", roots,
      files: new CommonFileState(roots, text => { this.output.print(text); }, this.sound, this.cvars, this,
        () => this.hunk.arena, () => this.mainZone) };
    this.validateFileSystemPaths();
    this.registerFileSystemCommands();
  }

  get mainZone(): ZoneArena {
    this.opened();
    if (this.zone === null) throw new Error("Common main zone is not initialized");
    return this.zone;
  }

  /** Com_TouchMemory checks only mainzone before timing the actual hunk and zone reads. */
  touchMemory(clock: SystemClock): number {
    this.opened(); this.commands.assertCurrentExecution(); this.options.assertOwnerEntry();
    this.mainZone.checkHeap();
    const start = clock.milliseconds();
    this.opened(); this.commands.assertCurrentExecution(); this.options.assertOwnerEntry();
    const sum = (this.hunk.touchMemory() + this.mainZone.touchMemory()) | 0;
    const end = clock.milliseconds();
    this.cvarPrint(`Com_TouchMemory: ${(end - start) | 0} msec\n`);
    return sum;
  }

  memoryInfo(verbose = false): void {
    this.entry();
    const print = (text: string): void => { this.cvarPrint(text); };
    const zone = this.mainZone.memoryInfo(print, verbose), small = this.smallZone.memoryInfo(print);
    const value = (number: number, label: string): void => { print(`${String(number).padStart(8)} ${label}\n`); };
    value(this.hunk.accounting.arena.byteLength, "bytes total hunk");
    value(this.mainZone.byteLength, "bytes total zone"); print("\n");
    for (const side of ["low", "high"] satisfies readonly ("low" | "high")[]) {
      const bank = () => this.hunk.accounting.arena.snapshot()[side];
      value(bank().mark, `${side} mark`);
      value(bank().permanent, `${side} permanent`);
      if (bank().temp !== bank().permanent) value(bank().temp, `${side} temp`);
      value(bank().tempHighwater, `${side} tempHighwater`); print("\n");
    }
    const hunk = () => this.hunk.accounting.arena.snapshot();
    value(hunk().low.permanent + hunk().high.permanent, "total hunk in use");
    let unused = 0;
    if (hunk().low.tempHighwater > hunk().low.permanent) unused += hunk().low.tempHighwater - hunk().low.permanent;
    if (hunk().high.tempHighwater > hunk().high.permanent) unused += hunk().high.tempHighwater - hunk().high.permanent;
    value(unused, "unused highwater"); print("\n");
    value(zone.usedBytes, `bytes in ${zone.blockCount} zone blocks`);
    print(`        ${String(zone.botlibBytes).padStart(8)} bytes in dynamic botlib\n`);
    print(`        ${String(zone.rendererBytes).padStart(8)} bytes in dynamic renderer\n`);
    print(`        ${String(zone.usedBytes - zone.botlibBytes - zone.rendererBytes).padStart(8)} bytes in dynamic other\n`);
    print(`        ${String(small.usedBytes).padStart(8)} bytes in small Zone memory\n`);
  }

  logZoneHeap(zone: ZoneArena, name: string): void {
    this.opened();
    if (this.logfile === null || this.fileOwner.kind !== "configured" || !this.fileOwner.files.initialized) return;
    zone.logHeap(name, text => { this.logfile?.write(text); });
  }

  logHeap(): void {
    this.logZoneHeap(this.mainZone, "MAIN");
    this.logZoneHeap(this.smallZone, "SMALL");
  }

  logHunk(small = false): void {
    this.opened();
    if (this.logfile === null || this.fileOwner.kind !== "configured" || !this.fileOwner.files.initialized) return;
    this.hunk.accounting.arena.log(text => { this.logfile?.write(text); }, small);
  }

  publishCommonClock(clock: SystemClock): void {
    this.opened(); this.commands.assertCurrentExecution(); this.options.assertOwnerEntry();
    if (this.phase !== "runtime" || this.commonClock !== null) throw new Error("Common clock publication must follow runtime registration exactly once");
    this.commonClock = clock;
  }

  /** files.c: FS_Path_f, FS_Dir_f, FS_NewDir_f and FS_TouchFile_f. */
  private registerFileSystemCommands(): void {
    this.commands.register("path", () => {
      this.entry();
      this.files.current.printSearchPath(text => { this.output.print(text); this.entry(); });
    });
    this.commands.register("dir", context => {
      this.entry();
      const path = context.argv[1], extension = context.argv[2] ?? "";
      if (path === undefined || context.argv.length > 3) {
        this.output.print("usage: dir <directory> [extension]\n"); return;
      }
      this.output.print(`Directory of ${path} ${extension}\n`);
      this.output.print("---------------\n");
      this.entry();
      for (const name of this.files.current.listFilteredFiles(path, extension, null)) {
        this.output.print(`${name}\n`); this.entry();
      }
    });
    this.commands.register("fdir", context => {
      this.entry();
      const filter = context.argv[1];
      if (filter === undefined) {
        this.output.print("usage: fdir <filter>\n");
        this.output.print("example: fdir *q3dm*.bsp\n"); return;
      }
      this.output.print("---------------\n");
      this.entry();
      const names = [...this.files.current.listFilteredFiles("", "", filter)].sort(pathCompare);
      for (const name of names) {
        this.output.print(`${name.replaceAll("\\", "/").replaceAll(":", "/")}\n`); this.entry();
      }
      this.output.print(`${names.length} files listed\n`);
    });
    this.commands.register("touchFile", context => {
      this.entry();
      const filename = context.argv[1];
      if (filename === undefined || context.argv.length !== 2) { this.output.print("Usage: touchFile <file>\n"); return; }
      this.files.current.fileLength(filename);
    });
  }

  private configuredFiles(): Extract<CommonFileOwner, { kind: "configured" }> {
    if (this.fileOwner.kind === "unconfigured") throw new Error("Common filesystem roots are not configured");
    return this.fileOwner;
  }
  get roots(): NativeSearchRoots { this.opened(); return this.configuredFiles().files.roots; }
  get fullyInitialized(): boolean { return this.phase === "initialized"; }

  /** FS_Startup calls these between publishing the search paths and pure reordering. */
  readCdKeys(): void {
    const files = this.files;
    this.cdKey.readFile("baseq3", files);
    const game = this.cvars.register("fs_game", "", CvarFlag.Init | CvarFlag.SystemInfo);
    if (game.value.length !== 0) this.cdKey.appendFile(game.value, files);
  }

  get files(): CommonFileState {
    this.opened();
    const owner = this.configuredFiles();
    owner.files.assertInitialized();
    return owner.files;
  }
  async clearPureServerPaks(assertCurrentOperation: () => void): Promise<void> {
    this.opened();
    assertCurrentOperation();
    if (this.fileOwner.kind === "configured") {
      await this.fileOwner.files.setServerLoadedPaks("", "", assertCurrentOperation);
    }
  }
  readErrorCvar(name: CommonErrorCvarName): CvarSnapshot | null {
    return this.bindings.has(name) ? this.cvar(name) : null;
  }
  private opened(): void { if (this.phase === "closed") throw new Error("Common console is closed"); }
  private entry(): void { this.opened(); this.commands.assertCurrentExecution(); this.options.assertCommandEntry(); }
  private cvar(name: string): CvarSnapshot {
    const value = this.cvars.get(name);
    if (value === undefined) throw new Error(`Common console requires registered cvar ${name}`);
    return value;
  }
  validateGameDirectory(): void {
    // FS_Startup mounts fs_basegame and fs_game independently of the executable's
    // product. CommonFileState owns replacement mounts and the writable directory;
    // module acquisition selects the implementation from the mounted artifact.
    this.validateFileSystemPaths();
  }
  private validateFileSystemPaths(): void {
    checkedGameDirectory(this.cvar("fs_game").value);
    checkedGameDirectory(this.cvar("fs_basegame").value);
    for (const name of ["fs_basepath", "fs_homepath", "fs_cdpath"]) {
      if (this.cvar(name).value.includes("\0")) throw new Error(`${name} contains a NUL byte`);
    }
  }
  assertCapabilities(): void {
    this.opened(); this.validateFileSystemPaths();
  }

  /** FS_Restart's common configuration continuation runs after the actual mount replacement. */
  async finishFileSystemRestart(checksumFeed: number, assertCurrentOperation: () => void): Promise<void> {
    assertCurrentOperation(); this.opened();
    if (this.files.current.readFileLength("default.cfg") <= 0) {
      if (this.lastValidFileSystem !== null) {
        await this.files.setServerLoadedPaks("", "", assertCurrentOperation);
        assertCurrentOperation(); this.opened();
        const previous = this.lastValidFileSystem;
        if (previous === null) throw new Error("Filesystem recovery lost its last-valid directories");
        this.cvars.set("fs_basepath", previous.base, true);
        this.cvars.set("fs_gamedirvar", previous.game, true);
        this.lastValidFileSystem = null;
        this.cvars.set("fs_restrict", "0", true);
        await this.files.restart({ checksumFeed, random: () => Math.fround((this.options.random.next() & 0x7fff) / 32767) }, assertCurrentOperation);
        throw new CommonError("drop", "Invalid game folder\n");
      }
      throw new CommonError("fatal", "Couldn't load default.cfg");
    }
    const directory = this.cvar("fs_game").value;
    if (directory.toLowerCase() !== (this.lastValidFileSystem?.game ?? "").toLowerCase() && !this.startup.consumeSafeMode()) {
      this.commands.append("exec q3config.cfg\n");
    }
    this.lastValidFileSystem = { base: this.cvar("fs_basepath").value, game: directory };
  }

  registerRuntimeCvars(buildDate: string, quit: AsyncCommandHandler): number {
    if (this.phase !== "filesystem") throw new Error("Common runtime registration must follow filesystem/config initialization exactly once");
    const dedicated = this.options.build.kind === "dedicated"
      ? this.cvars.register("dedicated", "1", CvarFlag.ReadOnly).integerValue
      : this.cvars.register("dedicated", "0", CvarFlag.Latch).integerValue;
    this.bindings.add("dedicated");
    this.hunk.initialize(dedicated !== 0, this.files.fileMemory.loadStack);
    this.commands.register("meminfo", context => { this.memoryInfo(context.argv.length !== 1); });
    if (this.zoneDebug) this.commands.register("zonelog", () => { this.logHeap(); });
    if (this.cvars.register("com_hunkDebug", "0", CvarFlag.Init).integerValue !== 0) {
      this.commands.register("hunklog", () => { this.logHunk(); });
      this.commands.register("hunksmalllog", () => { this.logHunk(true); });
    }
    this.cvars.clearModifiedFlags(CvarFlag.Archive);
    const definitions: readonly (readonly [string, string, number])[] = [
      ["com_maxfps", "85", CvarFlag.Archive], ["com_blood", "1", CvarFlag.Archive],
      ["developer", "0", CvarFlag.Temporary], ["logfile", "0", CvarFlag.Temporary],
      ["timescale", "1", CvarFlag.Cheat | CvarFlag.SystemInfo], ["fixedtime", "0", CvarFlag.Cheat],
      ["com_showtrace", "0", CvarFlag.Cheat], ["com_dropsim", "0", CvarFlag.Cheat], ["viewlog", "0", CvarFlag.Cheat],
      ["com_speeds", "0", 0], ["timedemo", "0", CvarFlag.Cheat], ["com_cameraMode", "0", CvarFlag.Cheat],
      ["cl_paused", "0", CvarFlag.ReadOnly], ["sv_paused", "0", CvarFlag.ReadOnly],
      ["sv_running", "0", CvarFlag.ReadOnly], ["cl_running", "0", CvarFlag.ReadOnly],
      ["com_buildScript", "0", 0], ["com_introplayed", "0", CvarFlag.Archive],
    ];
    for (const [name, value, flags] of definitions) {
      this.cvars.register(name, value, flags);
      if (name === "developer" || name === "logfile" || name === "sv_running" || name === "cl_running" || name === "com_buildScript") this.bindings.add(name);
    }
    if (dedicated !== 0 && this.cvar("viewlog").integerValue === 0) this.cvars.set("viewlog", "1", true);
    if (this.cvar("developer").integerValue !== 0) {
      this.commands.register("error", context => {
        this.entry();
        if (context.argv.length > 1) throw new CommonError("drop", "Testing drop error");
        throw new CommonError("fatal", "Testing fatal error");
      });
      this.unavailable("crash", "unsafe native NULL-pointer fault");
      this.commands.register("freeze", context => { this.freeze(context); });
    }
    this.commands.registerAsync("quit", context => { this.entry(); return quit(context); });
    // msg.c's zero-initialized pcount never changes; both source increments are commented out.
    this.commands.register("changeVectors", () => { this.entry(); });
    this.commands.register("writeconfig", context => {
      this.entry();
      if (context.argv.length !== 2) { this.output.print("Usage: writeconfig <filename>\n"); return; }
      const path = configPath(argument(context, 1)); this.output.print(`Writing ${path}.\n`); this.writeConfig(path);
    });
    this.cvars.register("version", `Q3 1.32b ${process.platform}-ts ${buildDate}`, CvarFlag.ReadOnly | CvarFlag.ServerInfo);
    this.assertCapabilities(); this.phase = "runtime";
    return dedicated;
  }
  markInitialized(): void {
    if (this.phase !== "runtime") throw new Error("Common initialization must follow runtime registration exactly once");
    this.phase = "initialized";
  }

  /** vm.c: VM_Init follows Netchan_Init and precedes SV_Init. */
  initVm(): void {
    this.opened(); this.commands.assertCurrentExecution(); this.options.assertOwnerEntry();
    if (this.phase !== "runtime" || this.vmInitialized) throw new Error("VM initialization must follow runtime registration exactly once");
    this.cvars.register("vm_cgame", "2", CvarFlag.Archive);
    this.cvars.register("vm_game", "2", CvarFlag.Archive);
    this.cvars.register("vm_ui", "2", CvarFlag.Archive);
    this.commands.register("vmprofile", () => { this.entry(); this.vm.printProfile(text => { this.cvarPrint(text); }); });
    this.commands.register("vminfo", () => { this.entry(); this.vm.printInfo(text => { this.cvarPrint(text); }); });
    this.vm.clear();
    this.vmInitialized = true;
  }

  /** common.c: Com_Freeze_f polls Com_Milliseconds and retains its acquired events. */
  private freeze(context: CommandContext): void {
    this.entry();
    if (context.argv.length !== 2) { this.output.print("freeze <seconds>\n"); return; }
    const seconds = Math.fround(nativeAtof(argument(context, 1)));
    if (Number.isNaN(seconds) || seconds >= 2147483647 * 0.001) {
      throw new RangeError("freeze duration cannot terminate within the source signed-millisecond interval");
    }
    const clock = this.commonClock;
    if (clock === null) throw new Error("freeze requires the published common event clock");
    const milliseconds = (): number => {
      const time = clock.milliseconds();
      this.entry();
      if (!Number.isInteger(time) || time < -2147483648 || time > 2147483647) {
        throw new RangeError("freeze requires signed-int common milliseconds");
      }
      return time;
    };
    const start = milliseconds();
    while (true) {
      const now = milliseconds();
      if (((now - start) | 0) * 0.001 > seconds) return;
    }
  }

  private registerEarlyCommands(): void {
    this.commands.register("toggle", context => {
      this.entry();
      if (context.argv.length !== 2) { this.output.print("usage: toggle <variable>\n"); return; }
      const value = this.cvars.find(argument(context, 1))?.numericValue ?? 0;
      this.setValue(this.commands.argumentReference(1), String(Math.trunc(value) === 0 ? 1 : 0));
    });
    for (const [name, flags] of [["set", 0], ["sets", CvarFlag.ServerInfo], ["setu", CvarFlag.UserInfo], ["seta", CvarFlag.Archive]] satisfies readonly (readonly [string, number])[]) {
      this.commands.register(name, context => { this.entry(); this.setCommand(context, name, flags); });
    }
    this.commands.register("reset", context => {
      this.entry();
      if (context.argv.length !== 2) { this.output.print("usage: reset <variable>\n"); return; }
      this.cvars.set2(this.commands.argumentReference(1), null); this.assertCapabilities();
    });
    this.commands.register("cvarlist", context => { this.entry(); this.listCvars(context); });
    this.commands.register("cvar_restart", () => { this.entry(); this.cvars.resetAll(); });
    this.commands.register("cmdlist", () => {
      this.entry(); let count = 0;
      const match = this.commands.tokenizedArguments.length > 1 ? this.commands.argumentReference(1) : null;
      this.commands.completeNames(name => {
        if (match !== null && !sourceFilter(match.value, name, false)) return;
        this.output.print(`${name}\n`); count++;
      });
      this.output.print(`${count} commands\n`);
    });
    this.commands.registerAsync("exec", async context => {
      this.entry();
      if (context.argv.length !== 2) { this.output.print("exec <filename> : execute a script file\n"); return; }
      const path = configPath(argument(context, 1));
      const files = this.files, file = await files.current.readFileRetained(path);
      context.assertActive(); this.entry();
      if (file === undefined) { this.output.print(`couldn't exec ${argument(context, 1)}\n`); return; }
      this.output.print(`execing ${argument(context, 1)}\n`); context.insert(sourceText(file.bytes));
      files.fileMemory.freeFile(file);
    });
    this.commands.register("vstr", context => {
      this.entry();
      if (context.argv.length !== 2) { this.output.print("vstr <variablename> : execute a variable command\n"); return; }
      context.insert(`${this.cvars.get(argument(context, 1))?.value ?? ""}\n`);
    });
    this.commands.register("echo", () => {
      this.entry();
      for (let index = 1; index < this.commands.tokenizedArguments.length; index++) {
        this.output.print(`${this.commands.tokenizedArguments[index] ?? ""} `);
      }
      this.output.print("\n");
    });
    this.commands.registerWaitCommand(() => { this.entry(); });
  }
  private setValue(name: CvarStringInput, value: CvarStringInput): void {
    this.cvars.set2(name, value); this.assertCapabilities();
  }
  private setCommand(context: CommandContext, command: string, flags: number): void {
    if (context.argv.length < 3 || (flags !== 0 && context.argv.length !== 3)) { this.output.print(`usage: ${command} <variable> <value>\n`); return; }
    let value = "", sourceLength = 0;
    for (let index = 2; index < context.argv.length; index++) {
      const part = this.commands.argumentReference(index).value, length = this.commands.argumentReference(index).offset(1).value.length;
      if (sourceLength + length >= 1022) break;
      const addition = part + (index !== context.argv.length - 1 ? " " : "");
      if (value.length + addition.length >= 1024) throw new RangeError("Source Cvar_Set_f command exceeds its destination");
      value += addition; sourceLength += length;
    }
    this.setValue(this.commands.argumentReference(1), value);
    if (flags !== 0) {
      const flaggedName = this.commands.argumentReference(1).value;
      if (this.cvars.find(flaggedName) !== undefined) this.cvars.addFlags(flaggedName, flags);
    }
  }
  private resolveFallback(lookup: CommandLookup): ResolvedCommandHandler | undefined {
    if (this.cvars.find(lookup.name) === undefined) return this.options.resolveCommand(lookup);
    return { kind: "sync", handler: context => { this.executeCvar(context); } };
  }
  private executeCvar(context: CommandContext): void {
    this.entry();
    const value = this.cvars.find(argument(context, 0));
    if (value === undefined) throw new Error(`Resolved cvar command ${argument(context, 0)} is no longer registered`);
    if (context.argv.length === 1) {
      this.output.print(`"${cvarPrintText(value.nameString)}" is:"${cvarPrintText(value.currentString)}^7" default:"${cvarPrintText(value.resetString)}^7"\n`);
      if (value.latchedString !== null) this.output.print(`latched: "${value.latchedString.value}"\n`);
    } else {
      if (value.nameString === null) throw new RangeError("Undefined native NULL cvar name");
      this.setValue(value.nameString, this.commands.argumentReference(1));
    }
  }
  private listCvars(context: CommandContext): void {
    let count = 0;
    const match = context.argv.length > 1 ? this.commands.argumentReference(1) : null;
    this.cvars.visit(0, value => {
      count++;
      if (match !== null) {
        if (value.nameString === null) throw new RangeError("Undefined native NULL cvar filter input");
        if (!sourceFilter(match.value, value.nameString.value, false)) return;
      }
      for (const [flag, text] of [[CvarFlag.ServerInfo, "S"], [CvarFlag.UserInfo, "U"], [CvarFlag.ReadOnly, "R"], [CvarFlag.Init, "I"],
        [CvarFlag.Archive, "A"], [CvarFlag.Latch, "L"], [CvarFlag.Cheat, "C"]] satisfies readonly (readonly [number, string])[]) this.output.print((value.flags & flag) !== 0 ? text : " ");
      this.output.print(` ${cvarPrintText(value.nameString)} "${cvarPrintText(value.currentString)}"\n`);
    });
    this.output.print(`\n${count} total cvars\n`); this.output.print(`${this.cvars.indexCount} cvar indexes\n`);
  }
  private unavailable(command: string, capability: string): void {
    this.commands.register(command, () => { this.entry(); throw new Error(`${command} requires unavailable ${capability}`); });
  }

  async writeConfiguration(): Promise<void> {
    this.opened();
    if (this.phase !== "initialized" || (this.cvars.modifiedFlags & CvarFlag.Archive) === 0) return;
    this.cvars.clearModifiedFlags(CvarFlag.Archive); this.writeConfig("q3config.cfg");
    if (this.options.build.kind === "client") {
      const game = this.cvars.bindVm("fs_game", "", CvarFlag.Init | CvarFlag.SystemInfo);
      const unique = await this.options.build.client.usesUniqueKey();
      this.opened(); this.commands.assertCurrentExecution(); this.options.assertOwnerEntry();
      if (unique === 1) {
        const value = this.cvars.readVm(game);
        if (value === undefined) throw new Error("Configuration lost its registered fs_game allocation");
        if (value.value.length !== 0) {
          this.cdKey.writeFile(value.value, 16, this.files, text => { this.cvarPrint(text); });
          return;
        }
      }
      this.cdKey.writeFile("baseq3", 0, this.files, text => { this.cvarPrint(text); });
    }
  }
  private writeConfig(path: string): void {
    const file = this.configuredFiles().files.writable.openWrite(path, false);
    if (file === null) { this.output.print(`Couldn't write ${path}.\n`); return; }
    try {
      file.write("// generated by quake, do not modify\n");
      if (this.options.build.kind === "client") this.options.build.client.writeBindings(text => { file.write(text); });
      this.cvars.writeVariables(text => { file.write(text); });
    } finally { file.close(); }
  }
  private cvarPrint(text: string): void {
    this.opened(); this.commands.assertCurrentExecution(); this.options.assertOwnerEntry();
    this.output.print(text);
    this.opened(); this.commands.assertCurrentExecution(); this.options.assertOwnerEntry();
  }
  private normalPrint(text: string): void {
    this.opened();
    if (this.bindings.has("dedicated") && this.cvar("dedicated").integerValue === 0 && this.options.build.kind === "client") this.options.build.client.consolePrint(text);
    this.opened();
    this.options.platformPrint(text);
    this.opened();
    const logging = this.bindings.has("logfile") ? this.cvar("logfile").integerValue : 0;
    const owner = this.fileOwner;
    if (logging === 0 || owner.kind === "unconfigured" || !owner.files.initialized) return;
    if (this.logfile === null && !this.openingLog) {
      this.openingLog = true;
      const date = sourceDate(new Date());
      this.logfile = owner.files.writable.openWrite("qconsole.log", false);
      this.output.print(`logfile opened on ${date}\n`);
      if (this.cvar("logfile").integerValue > 1 && this.logfile === null) {
        throw new CommonError("drop", "FS_FileForHandle: NULL");
      }
      // Node descriptors have no stdio output buffer. Source FS_ForceFlush only
      // disables that buffer; it does not fsync or set the handleSync flag.
      this.openingLog = false;
    }
    if (this.fileOwner.kind === "configured" && this.fileOwner.files.initialized) this.logfile?.write(text);
  }
  /** Com_Shutdown closes journals/logs; source cvars and console remain alive for Sys_Quit. */
  shutdown(): void {
    this.opened(); this.commands.assertCurrentExecution(); this.options.assertOwnerEntry();
    const logfile = this.logfile;
    if (logfile !== null) { logfile.close(); this.logfile = null; }
    this.journal.shutdown();
  }

  /** FS_Shutdown after normal Com_Quit, without retiring the common core. */
  shutdownFileSystem(): void {
    this.opened(); this.commands.assertCurrentExecution(); this.options.assertOwnerEntry();
    const owner = this.fileOwner;
    if (owner.kind !== "configured" || !owner.files.initialized) return;
    try { owner.files.close(); }
    finally { this.logfile = null; }
  }

  close(): void {
    if (this.phase === "closed") return;
    this.commands.assertCurrentExecution(); this.options.assertOwnerEntry();
    this.journal.retire();
    this.phase = "closed";
    const owner = this.fileOwner;
    const failures: unknown[] = [];
    try {
      try { if (owner.kind === "configured") owner.files.close(); } catch (error) { failures.push(error); }
      try { this.sound.close(); } catch (error) { failures.push(error); }
    }
    finally {
      if (owner.kind === "configured") owner.files.fileMemory.disposeResources();
      this.collision.clear();
      this.vm.clear();
      this.hunk.disposeResources();
      this.zone?.dispose();
      this.zone = null;
      this.smallZone.dispose();
      this.logfile = null; this.fileOwner = { kind: "unconfigured" };
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Common filesystem and sound cleanup failed", { cause: failures[0] });
  }
}
