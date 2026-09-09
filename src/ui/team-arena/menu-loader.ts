/*
 * UI_Load, UI_LoadMenus, Load_Menu and UI_ParseMenu from id Software's code/ui/ui_main.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { BotScriptSources } from "../../botlib/script-sources.ts";
import { sourceCommandText } from "../../core/text.ts";
import type { SystemClock } from "../../platform/system-clock.ts";
import type { ScriptDiagnostic, ScriptToken } from "../../script/lexer.ts";
import { UiMenuSourceParser, UiMenuTokenCursor, type UiMenuMemoryOwnership, type UiMenuRandom } from "../menu.ts";
import type { UiRuntime } from "../runtime.ts";
import type { TeamArenaUiCvars } from "./cvars.ts";
import type { TeamArenaCatalog } from "./catalog.ts";
import type { TeamArenaGameInfo } from "./game-info.ts";
import type { TeamArenaUiMemory } from "./memory.ts";
import type { TeamArenaUiResources } from "./resources.ts";

export interface TeamArenaUiMenuLoaderServices {
  readonly memory: TeamArenaUiMemory;
  readonly resources: TeamArenaUiResources;
  readonly cvars: TeamArenaUiCvars;
  readonly runtime: UiRuntime;
  readonly random: UiMenuRandom;
  readonly systemClock: SystemClock;
  scriptSources(): BotScriptSources;
  print(text: string): void;
  error(text: string): never;
  assertCurrentOperation(): void;
}

function text(token: ScriptToken): string {
  const value = token.kind === "string" ? token.value : token.text;
  const nul = value.indexOf("\0");
  return nul < 0 ? value : value.slice(0, nul);
}

/** One UI VM's parser destinations persist across loads. Only explicit reload performs String_Init. */
export class TeamArenaUiMenuLoader {
  inGameLoad = false;
  private readonly parser: UiMenuSourceParser;
  private readonly memory: UiMenuMemoryOwnership;
  private loading = false;

  constructor(private readonly services: TeamArenaUiMenuLoaderServices) {
    services.assertCurrentOperation();
    this.memory = { kind: "qvm32", memory: services.memory };
    services.runtime.assertMenuMemory(this.memory);
    this.parser = new UiMenuSourceParser({ random: services.random, scriptSources: () => services.scriptSources(),
      assertCurrentOperation: () => this.current() }, {}, {
      memory: this.memory,
      reportDiagnostic: diagnostic => this.reportDiagnostic(diagnostic),
      registrationSink: { register: async event => {
        this.current(); const result = await services.resources.register(event); this.current();
        services.runtime.acceptMenuRegistration(event);
        return result;
      } },
      assetSink: { publish: event => {
        this.current(); services.resources.publish(event); this.current(); services.runtime.publishMenuAsset(event);
      } },
      menuSink: {
        menuCount: () => { this.current(); return services.runtime.menuCount(); },
        publish: async menu => {
          this.current(); await services.runtime.appendMenu(menu, this.memory); this.current();
        },
      },
    });
  }

  private current(): void { this.services.assertCurrentOperation(); }

  private reportDiagnostic(diagnostic: ScriptDiagnostic): void {
    this.current();
    const prefix = diagnostic.severity === "error" ? "^1ERROR" : "^3WARNING";
    this.services.print(`${prefix}: ${diagnostic.location.path}, line ${diagnostic.location.line}: ${diagnostic.message}\n`);
    this.current();
  }

  private source(path: string): UiMenuTokenCursor | undefined {
    return UiMenuTokenCursor.openHandle(path, () => this.services.scriptSources(), () => this.current());
  }

  async load(menuFile: string, reset: boolean): Promise<void> {
    this.current();
    if (this.loading) throw new Error("UI menu loads must be awaited");
    this.loading = true;
    try { await this.loadSet(menuFile, reset); }
    finally { this.loading = false; }
  }

  async loadNonIngame(): Promise<void> {
    this.current();
    const menuSet = sourceCommandText(this.services.cvars.registry.get("ui_menuFiles")?.value ?? "").slice(0, 1023);
    this.current();
    await this.load(menuSet.length === 0 ? "ui/menus.txt" : menuSet, false);
    this.current();
    this.inGameLoad = false;
  }

  async reload(gameInfo: TeamArenaGameInfo, catalog: TeamArenaCatalog): Promise<void> {
    this.current();
    if (this.loading) throw new Error("UI menu loads must be awaited");
    this.loading = true;
    try {
      const focused = this.services.runtime.focusedMenuHandle();
      const menuSet = sourceCommandText(this.services.cvars.registry.get("ui_menuFiles")?.value ?? "").slice(0, 1023);
      this.current();
      const lastName = focused?.definition.window.name;
      if (lastName !== undefined && lastName.length >= 1024) {
        throw new RangeError("UI_Load copies beyond its 1024-byte source lastName buffer");
      }
      this.services.memory.initializeStrings();
      this.services.runtime.resetDefinitions("strings"); this.current();
      await gameInfo.parseGameInfo("gameinfo.txt"); this.current();
      catalog.loadArenas(); this.current();
      await this.loadSet(menuSet.length === 0 ? "ui/menus.txt" : menuSet, true); this.current();
      await this.services.runtime.closeAll(); this.current();
      await this.services.runtime.activate(lastName ?? (() => {
        throw new RangeError("UI_Load reads uninitialized source lastName without a named focused menu");
      })); this.current();
    } finally { this.loading = false; }
  }

  private async loadSet(menuFile: string, reset: boolean): Promise<void> {
    const start = this.services.systemClock.milliseconds(); this.current();
    const tokens = this.source(menuFile);
    if (tokens === undefined) this.services.error(`^3menu file not found: ${menuFile}, using default\n`);
    this.current();
    this.services.cvars.writeInteger("ui_new", 1); this.current();
    if (reset) this.services.runtime.resetDefinitions("menus");
    while (true) {
      this.current();
      const token = tokens.next();
      if (token === undefined) break;
      const value = text(token);
      if (value.length === 0 || value.startsWith("}")) break;
      if (value.toLowerCase() !== "loadmenu") continue;
      const opening = tokens.next();
      if (opening === undefined || !text(opening).startsWith("{")) break;
      if (!await this.loadMenu(tokens)) break;
    }
    const elapsed = (this.services.systemClock.milliseconds() - start) | 0; this.current();
    this.services.print(`UI menu load time = ${elapsed} milli seconds\n`); this.current();
    tokens.dispose();
  }

  private async loadMenu(tokens: UiMenuTokenCursor): Promise<boolean> {
    while (true) {
      this.current();
      const token = tokens.next();
      if (token === undefined) return false;
      const value = text(token);
      if (value.length === 0) return false;
      if (value.startsWith("}")) return true;
      await this.parseReached(value);
    }
  }

  async parseMenu(menuFile: string): Promise<void> {
    this.current();
    if (this.loading) throw new Error("UI menu loads must be awaited");
    this.loading = true;
    try { await this.parseReached(menuFile); }
    finally { this.loading = false; }
  }

  private async parseReached(menuFile: string): Promise<void> {
    this.current(); this.services.print(`Parsing menu file:${menuFile}\n`); this.current();
    const source = this.source(menuFile);
    if (source === undefined) return;
    await this.parser.parseSource(source); this.current();
  }
}
