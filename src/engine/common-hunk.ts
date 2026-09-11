// Common hunk and VM lifetimes from id Software's code/qcommon/common.c and vm.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { CommonError } from "../core/common-error.ts";
import { initializeHunk } from "../core/hunk.ts";
import type { HunkArena, HunkAsyncClearHost } from "../core/hunk.ts";
import { SourceHunkAccounting } from "../render/hunk-accounting.ts";
import type { VmRegistry } from "../vm/registry.ts";

export interface CommonHunkClient {
  shutdownCGame(): void | Promise<void>;
  shutdownUi(): void | Promise<void>;
  closeAllVideos(): void | Promise<void>;
  clearVm(): void;
}

export interface CommonHunkServer {
  shutdownGameProgs(): void | Promise<void>;
  clearVm(): void;
}

type HunkState =
  | { readonly kind: "unallocated" }
  | { readonly kind: "allocated"; readonly accounting: SourceHunkAccounting }
  | { readonly kind: "disposed" };

/** One common arena; engine borrows resolve their current module fields on every call. */
export class CommonHunk {
  private state: HunkState = { kind: "unallocated" };
  private client: CommonHunkClient | null = null;
  private server: CommonHunkServer | null = null;

  constructor(private readonly build: "client" | "dedicated", private readonly cvars: CvarRegistry,
    private readonly print: (text: string) => void,
    private readonly vm: VmRegistry,
    private readonly writeDebugLog: (text: string) => void = () => {},
  ) {}

  get arena(): HunkArena | null { return this.state.kind === "allocated" ? this.state.accounting.arena : null; }

  get accounting(): SourceHunkAccounting {
    if (this.state.kind !== "allocated") throw new Error(`Common hunk is ${this.state.kind}`);
    return this.state.accounting;
  }

  /** Com_InitHunkMemory follows config execution and dedicated cvar registration. */
  initialize(dedicated: boolean, filesystemLoadStack: number): void {
    if (this.state.kind !== "unallocated") throw new Error("Common hunk initialization already ran");
    if (this.client !== null || this.server !== null) throw new Error("Common hunk initialization requires unstarted module owners");
    if (filesystemLoadStack !== 0) throw new CommonError("fatal", "Hunk initialization failed. File system load stack not zero");
    const megs = this.cvars.register("com_hunkMegs", "56", CvarFlag.Latch | CvarFlag.Archive).integerValue;
    const debug = (this.cvars.get("com_hunkDebug")?.integerValue ?? 0) !== 0;
    initializeHunk({ megs, dedicated, filesystemLoadStack,
      ...(debug ? { debug: { writeLog: this.writeDebugLog } } : {}) }, this.print, null, arena => {
      this.state = { kind: "allocated", accounting: new SourceHunkAccounting(arena) };
    });
  }

  attachClient(client: CommonHunkClient): void {
    this.accounting;
    if (this.build !== "client") throw new Error("Dedicated builds have no client hunk owner");
    this.client = client;
  }

  attachServer(server: CommonHunkServer): void { this.accounting; this.server = server; }

  private clearVm(): void {
    this.accounting;
    this.server?.clearVm();
    if (this.build === "client") this.client?.clearVm();
    this.vm.clear();
  }

  clear(): Promise<void> {
    const common = this;
    const server = {
      shutdownGameProgs(): void | Promise<void> { common.accounting; return common.server?.shutdownGameProgs(); },
      clearVm(): void { common.clearVm(); },
    };
    const host: HunkAsyncClearHost = this.build === "dedicated" ? { kind: "dedicated", ...server } : {
      kind: "client", ...server,
      shutdownCGame(): void | Promise<void> { common.accounting; return common.client?.shutdownCGame(); },
      shutdownUi(): void | Promise<void> { common.accounting; return common.client?.shutdownUi(); },
      closeAllVideos(): void | Promise<void> { common.accounting; return common.client?.closeAllVideos(); },
    };
    return this.accounting.clearAsync(host);
  }

  clearToMark(): void { this.accounting.clearToMark(); }
  setMark(): void { this.accounting.setMark(); }
  touchMemory(): number { return this.accounting.arena.touchMemory(); }

  /** Final managed disposal drops borrows without replaying source shutdown or FS frees. */
  disposeResources(): void {
    this.client = null;
    this.server = null;
    this.state = { kind: "disposed" };
  }
}
