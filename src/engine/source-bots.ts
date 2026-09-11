// Port of id Software's sv_bot.c, g_main.c, g_bot.c and ai_main.c composition.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { BotLibrary } from "../botlib/library.ts";
import { AasDebugLines } from "../botlib/aas-debug.ts";
import { AasDebugGeometry } from "../botlib/aas-debug-geometry.ts";
import { CommonError } from "../core/common-error.ts";
import { finishCalls } from "../core/call-steps.ts";
import type { CallSteps } from "../core/call-steps.ts";
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import type { LinuxNativeRandom } from "../core/native-random.ts";
import { GameAi } from "../game/ai-main.ts";
import { GameBotCatalog } from "../game/bots.ts";
import type { GameBotFactory, GameBotServices, GameRuntime } from "../game/runtime.ts";
import { ServerBotAdapter } from "../server/bot-adapter.ts";
import { BotDebugPolygons } from "../server/bot-debug.ts";
import type { BotDebugServer, DebugPolygonDraw } from "../server/bot-debug.ts";
import type { ServerBotMap } from "../server/bot-adapter.ts";
import type { ServerGame } from "../server/game.ts";
import type { CommonConsole } from "./common-console.ts";

export type ServerBotConfiguration =
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "source" };

interface AttachedGame {
  readonly kind: "attached";
  readonly game: GameRuntime;
  readonly adapter: ServerBotAdapter;
  readonly ai: GameAi;
  readonly catalog: GameBotCatalog;
}
type SourceBotsPhase = { readonly kind: "idle" | "disposed" } | AttachedGame
  | { readonly kind: "external"; readonly game: ServerGame; readonly adapter: ServerBotAdapter };

/** SV_BotInitCvars precedes GameAISetup's VM cvar registration. */
export function registerSourceBotCvars(cvars: CvarRegistry): void {
  const cheat = CvarFlag.Cheat;
  const definitions: readonly (readonly [string, string, number])[] = [
    ["bot_enable", "1", 0], ["bot_developer", "0", cheat], ["bot_debug", "0", cheat],
    ["bot_maxdebugpolys", "2", 0], ["bot_groundonly", "1", 0], ["bot_reachability", "0", 0],
    ["bot_visualizejumppads", "0", cheat], ["bot_forceclustering", "0", 0], ["bot_forcereachability", "0", 0],
    ["bot_forcewrite", "0", 0], ["bot_aasoptimize", "0", 0], ["bot_saveroutingcache", "0", 0],
    ["bot_thinktime", "100", cheat], ["bot_reloadcharacters", "0", 0], ["bot_testichat", "0", 0],
    ["bot_testrchat", "0", 0], ["bot_testsolid", "0", cheat], ["bot_testclusters", "0", cheat],
    ["bot_fastchat", "0", 0], ["bot_nochat", "0", 0], ["bot_pause", "0", cheat], ["bot_report", "0", cheat],
    ["bot_grapple", "0", 0], ["bot_rocketjump", "1", 0], ["bot_challenge", "0", 0], ["bot_minplayers", "0", 0],
    ["bot_interbreedchar", "", cheat], ["bot_interbreedbots", "10", cheat],
    ["bot_interbreedcycle", "20", cheat], ["bot_interbreedwrite", "", cheat],
  ];
  for (const [name, value, flags] of definitions) cvars.register(name, value, flags);
}

/** One server-linked library with a fresh game VM owner at every game creation. */
export class SourceBots {
  readonly library: BotLibrary;
  readonly debugPolygons = new BotDebugPolygons();
  readonly aasDebug: AasDebugGeometry;
  private phase: SourceBotsPhase = { kind: "idle" };

  constructor(private readonly common: CommonConsole, random: LinuxNativeRandom, debugBuild = false) {
    const owner = this;
    const capability = (name: string): boolean => common.cvars.register(name, "0", CvarFlag.Init).integerValue !== 0;
    const memoryManager = capability("com_botMemoryManager"), memoryDebug = capability("com_botMemoryDebug");
    const aasFileDebug = capability("com_botAasFileDebug"), alternativeRouteDebug = capability("com_botAlternativeRouteDebug");
    const aasSampleDebug = capability("com_botAasSampleDebug"), reachDebug = capability("com_botReachDebug");
    const weaponDebug = capability("com_botWeaponDebug"), debugEval = capability("com_botDebugEval");
    const aiMove = capability("com_botAiMoveDebug"), elevator = capability("com_botElevatorDebug");
    const funcBob = capability("com_botFuncBobDebug"), grapple = capability("com_botGrappleDebug");
    const maxDebugPolys = common.cvars.get("bot_maxdebugpolys");
    if (maxDebugPolys === undefined) throw new Error("Server bot cvars must register before bot library initialization");
    this.debugPolygons.initialize(maxDebugPolys.integerValue);
    const debugLines = new AasDebugLines(this.debugPolygons, text => { this.print(1, text); });
    this.aasDebug = new AasDebugGeometry(debugLines, {
      polygonCreate: (color, count, points) => this.debugPolygons.create(color, count, points),
      polygonDelete: handle => { this.debugPolygons.delete(handle); },
      print: (severity, text) => { this.print(severity, text); },
      debugBuild,
      memory: () => this.library.memory,
    });
    const geometry = { geometry: this.aasDebug, createLine: () => this.debugPolygons.lineCreate(),
      showLine: this.debugPolygons.lineShow.bind(this.debugPolygons) };
    this.library = new BotLibrary({ assets: () => common.files.current, random,
      ...(debugBuild ? { debugProfile: { kind: "source-debug", ...geometry } } : {}),
      ...(memoryDebug ? { memoryProfile: "debug" } : memoryManager ? { memoryProfile: "manager" } : {}),
      aasFileDebug, aasSampleDebug, reachDebug, weaponDebug, debugEval,
      ...(alternativeRouteDebug ? { alternativeRouteDebug: this.aasDebug } : {}),
      ...(aiMove || elevator || funcBob || grapple ? { movementProfile: { ...geometry, aiMove, elevator, funcBob, grapple } } : {}),
      hunk: { kind: "source-hunk", get accounting() { return common.hunk.accounting; } },
      zone: common.mainZone,
      print: (severity, text) => this.print(severity, text), openLog: filename => common.files.writable.openBotLog(filename),
      commonPrint: text => { common.output.print(text); return undefined; },
      openWrite: filename => common.files.writable.openBinaryWrite(filename),
      milliseconds: () => {
        // botlib Sys_MilliSeconds uses process CPU time, not the common event clock.
        const usage = process.cpuUsage();
        const milliseconds = Math.trunc((usage.user + usage.system) / 1000);
        if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 2147483647) {
          throw new RangeError("Bot library CPU clock exceeds the source signed millisecond range");
        }
        return milliseconds;
      },
      permanentLine: (start, end, color) => { this.debugPolygons.permanentLine(start, end, color); },
      movementDebug: debugLines.movement,
      *clientCommand(client, text): CallSteps {
        const phase = owner.phase;
        if (phase.kind !== "attached" && phase.kind !== "external") throw new Error("Bot client command requires an attached server game");
        yield* phase.adapter.clientCommand(client, text);
      } });
  }

  private print(severity: 1 | 2 | 3 | 4 | 5, text: string): undefined {
    switch (severity) {
      case 1: this.common.output.print(text); return;
      case 2: this.common.output.print(`^3Warning: ${text}`); return;
      case 3: this.common.output.print(`^1Error: ${text}`); return;
      case 4: this.common.output.print(`^1Fatal: ${text}`); return;
      case 5: throw new CommonError("drop", `^1Exit: ${text}`);
    }
  }

  drawDebugPolygons(drawPoly: DebugPolygonDraw, value: number, server: BotDebugServer): undefined {
    if (this.phase.kind === "disposed") throw new Error("Source bot resources are disposed");
    this.debugPolygons.draw(drawPoly, value, { cvars: this.common.cvars, library: this.library, ...server });
  }

  forMap(map: ServerBotMap): Extract<GameBotFactory, { kind: "source" }> {
    if (this.phase.kind === "disposed") throw new Error("Source bot resources are disposed");
    const adapter = new ServerBotAdapter(map, this.common.cvars, text => { this.common.output.print(text); });
    return { kind: "source", attach: game => this.attach(game, adapter) };
  }

  attachExternal(game: ServerGame, adapter: ServerBotAdapter): void {
    if (this.phase.kind === "disposed") throw new Error("Source bot resources are disposed");
    if (adapter.map.world.game !== game || game.product !== adapter.map.world.product) {
      throw new Error("External bot attachment must borrow the map's actual published game");
    }
    this.phase = { kind: "external", game, adapter };
  }

  private attach(game: GameRuntime, adapter: ServerBotAdapter): Extract<GameBotServices, { kind: "available" }> {
    if (this.phase.kind === "disposed") throw new Error("Source bot resources are disposed");
    if (adapter.map.world.game !== game || game.options.map !== adapter.map.map || game.world !== adapter.map.spatial
      || game.options.collision !== adapter.map.collision || game.options.cvars !== this.common.cvars
      || game.options.configstrings !== adapter.map.world.configstrings || game.options.product !== adapter.map.world.product) {
      throw new Error("Bot attachment must borrow the map's actual published game");
    }
    const ai = new GameAi(game, this.library, {
      getSnapshotEntity: (client, sequence) => adapter.getSnapshotEntity(client, sequence),
      getConsoleMessage: client => adapter.getConsoleMessage(client),
      userCommand: (client, command) => { finishCalls(adapter.userCommand(client, command)); },
      insertConsoleCommand: text => { game.options.engine.insertConsoleCommand(text); },
      checkBotSpawn: () => { catalog.checkSpawn(); },
      loadMap: name => this.library.loadMap({ name, bsp: adapter.map.map, spatialHost: adapter }),
    });
    const catalog = new GameBotCatalog(game, this.common.files, game.parser, {
      allocateClient: () => adapter.allocateClient(),
      setupClient: (client, settings, restart) => ai.setupClient(client, settings, restart),
      shutdownClient: (client, restart) => { ai.shutdownClient(client, restart); },
    });
    this.phase = { kind: "attached", game, adapter, ai, catalog };
    return { kind: "available",
      initialize: restart => { ai.setup(restart); }, loadMap: restart => { ai.loadMap(restart); },
      initializeBots: restart => { catalog.initializeBots(restart); },
      shutdown: restart => { ai.shutdown(restart); }, interbreedEndMatch: () => { ai.interbreedEndMatch(); },
      consoleCommand: argv => { catalog.consoleCommand(argv); },
      connect: (client, restart) => catalog.connect(client, restart),
      shutdownClient: (client, restart) => { catalog.shutdownClient(client, restart); },
      removeQueuedBegin: client => { catalog.removeQueuedBegin(client); }, frame: time => { ai.startFrame(time); },
      testAas: origin => { ai.testAas(origin); },
    };
  }

  /** A failed replacement may have no game while still retaining the last map's botlib. */
  releaseSession(): void {
    if (this.phase.kind === "disposed") return;
    if (this.library.isSetup) this.library.shutdown();
    this.phase = { kind: "idle" };
  }

  disposeResources(): void {
    if (this.phase.kind === "disposed") return;
    this.phase = { kind: "disposed" };
    this.library.disposeResources();
  }
}
