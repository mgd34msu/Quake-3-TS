/*
 * Bot library composition translated from id Software's botlib/be_interface.c
 * and its be_aas_main.c, be_ea.c and be_ai_* setup/shutdown calls.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { VirtualFileSystem } from "../assets/vfs.ts";
import type { CallSteps } from "../core/call-steps.ts";
import type { Vec3 } from "../core/math.ts";
import type { LinuxNativeRandom } from "../core/native-random.ts";
import type { ZoneArena } from "../core/zone.ts";
import type { HunkAccountingProfile } from "../render/hunk-accounting.ts";
import type { ScriptDiagnostic, SourceLocation } from "../script/lexer.ts";
import { ScriptGlobalDefines } from "../script/preprocessor.ts";
import { BotActionBuffer } from "./actions.ts";
import { AasRuntime } from "./aas-runtime.ts";
import type { AasMapInput, AasRuntimeMap, AasRuntimeOptions } from "./aas-runtime.ts";
import { BotCharacterLibrary } from "./character.ts";
import { BotChatLibrary } from "./chat.ts";
import type { BotEntityUpdate } from "./entity.ts";
import { geneticParentsAndChildSelection } from "./genetic.ts";
import type { GeneticSelectionInput, GeneticSelectionResult } from "./genetic.ts";
import { BotGoalLibrary } from "./goals.ts";
import { BotLibVars } from "./libvars.ts";
import type { BotLibVar } from "./libvars.ts";
import { BotLog } from "./log.ts";
import type { BotLogOpenResult } from "./log.ts";
import { BotMemory } from "./memory.ts";
import { BotMovement } from "./movement.ts";
import { BotMovementRouting } from "./movement-routing.ts";
import { BotMoveStateStore } from "./movement-state.ts";
import { BotScriptSources } from "./script-sources.ts";
import { WeaponAi } from "./weapons.ts";
import { WeightConfigStore } from "./weights.ts";
import type { BotRandom } from "./weights.ts";

type BotLibraryFiles = Pick<VirtualFileSystem, "openRead" | "readInto" | "seekFile" | "closeFile" | "readSync">;
type PrintSeverity = 1 | 2 | 3 | 4 | 5;
type DiagnosticSeverity = "message" | "info" | "warning" | "error" | "fatal";

export interface BotLibraryOptions extends Pick<AasRuntimeOptions, "milliseconds" | "openWrite" | "permanentLine" | "movementDebug"> {
  /** Omitted only by unaccounted diagnostic compositions. */
  readonly hunk?: HunkAccountingProfile;
  /** Omitted only by diagnostic compositions without source heap accounting. */
  readonly zone?: ZoneArena;
  readonly assets: () => BotLibraryFiles;
  readonly random: LinuxNativeRandom;
  readonly print: (severity: PrintSeverity, text: string) => undefined;
  readonly commonPrint: (text: string) => undefined;
  readonly openLog: (filename: string) => BotLogOpenResult;
  readonly clientCommand: (client: number, command: string) => CallSteps;
}

export type BotLibraryMapInput = Omit<AasMapInput, "assets">;
export type BotLibrarySetupStage = "none" | "log" | "aas" | "actions" | "weapons"
  | "goals" | "chat" | "movement" | "complete" | "shutdown";

interface MapMovement {
  readonly map: AasRuntimeMap;
  readonly routing: BotMovementRouting;
  readonly movement: BotMovement;
}

function sourceInteger(value: number, operation: string): number {
  const integer = Math.trunc(value);
  if (!Number.isFinite(integer) || integer < -2147483648 || integer > 2147483647) {
    throw new RangeError(`${operation}: source float-to-int conversion is undefined`);
  }
  return integer;
}

function diagnosticSeverity(severity: DiagnosticSeverity): 1 | 2 | 3 | 4 {
  switch (severity) {
    case "message": case "info": return 1;
    case "warning": return 2;
    case "error": return 3;
    case "fatal": return 4;
  }
}

/** Server-lived botlib globals, shared script caches and source setup residue. */
export class BotLibrary {
  readonly variables: BotLibVars;
  readonly memory: BotMemory;
  readonly globals: ScriptGlobalDefines;
  readonly sources: BotScriptSources;
  readonly log: BotLog;
  readonly weights: WeightConfigStore;
  readonly characters: BotCharacterLibrary;
  readonly weapons: WeaponAi;
  readonly goals: BotGoalLibrary;
  readonly chat: BotChatLibrary;
  readonly moveStates: BotMoveStateStore;
  private readonly random: BotRandom;
  private readonly logGlobals = { time: 0 };
  readonly aas: AasRuntime;
  readonly actions: BotActionBuffer;
  private mapMovement: MapMovement | null = null;
  private droppedWeight: BotLibVar | null = null;
  private goalGameType = 0;
  private developerValue = 0;
  private clientCapacity = 0;
  private entityCapacity = 0;
  private librarySetup = false;
  private terminal = false;
  private currentSetupStage: BotLibrarySetupStage = "none";

  /** Constructors install borrows only. Source reads and setup run through setup(). */
  constructor(private readonly options: BotLibraryOptions) {
    this.memory = new BotMemory(options.hunk, options.zone);
    const variables = this.variables = new BotLibVars(this.memory);
    this.random = { nextInt: () => { this.requireLive(); return options.random.next(); } };
    this.globals = new ScriptGlobalDefines(diagnostic => this.scriptDiagnostic(diagnostic), this.memory);
    this.sources = new BotScriptSources({
      openRead: path => this.files().openRead(path),
      readInto: (file, buffer) => this.files().readInto(file, buffer),
      closeFile: file => this.files().closeFile(file),
    }, this.globals, (severity, text) => this.print(severity, text), options.commonPrint, this.memory);
    this.log = new BotLog({ variables, globals: this.logGlobals, print: (severity, text) => this.print(severity, text),
      openFile: filename => { this.requireLive(); return options.openLog(filename); } });
    this.aas = new AasRuntime({ variables, memory: this.memory, print: (severity, text) => this.print(severity, text),
      commonPrint: options.commonPrint,
      log: this.log, developer: () => this.developerValue !== 0,
      milliseconds: () => this.options.milliseconds(), openWrite: filename => this.options.openWrite(filename),
      movementDebug: this.options.movementDebug,
      permanentLine: (start, end, color) => this.options.permanentLine(start, end, color) }, "unallocated");
    this.actions = new BotActionBuffer(null, { clientCommand: (client, text) => this.clientCommand(client, text) }, this.memory);
    const reloadCharacters = (): boolean => variables.getValue("bot_reloadcharacters") !== 0;
    this.weights = new WeightConfigStore(this.sources, { memory: this.memory, reloadCharacters,
      print: (severity, text) => this.print(severity, text) });
    this.characters = new BotCharacterLibrary(this.sources, {
      memory: this.memory,
      log: this.log,
      reloadCharacters,
      report: diagnostic => this.printDiagnostic(diagnostic.severity, diagnostic.message, diagnostic.location),
    });
    this.weapons = new WeaponAi({ resolver: this.sources, weights: this.weights }, {
      memory: this.memory,
      maxWeaponInfo: () => this.weaponCapacity("max_weaponinfo"),
      maxProjectileInfo: () => this.weaponCapacity("max_projectileinfo"),
      report: diagnostic => this.printDiagnostic(diagnostic.severity, diagnostic.message,
        diagnostic.origin === "source" ? diagnostic.location : null),
    });
    this.goals = new BotGoalLibrary({
      memory: this.memory,
      log: this.log,
      resolver: this.sources, weightStore: this.weights, random: this.random,
      clock: () => this.time(), gameType: () => this.goalGameType,
      maxItemInfo: { get: () => variables.value("max_iteminfo", "256"), set: value => variables.set("max_iteminfo", String(value)) },
      maxLevelItems: () => variables.value("max_levelitems", "256"),
      droppedWeight: () => {
        const variable = this.droppedWeight;
        if (variable === null) throw new Error("Bot goal droppedweight requires successful goal setup");
        return variable.value;
      },
      developer: () => this.developerValue !== 0,
      report: diagnostic => this.printDiagnostic(diagnostic.severity, diagnostic.message),
    });
    this.chat = new BotChatLibrary(this.sources, {
      random: this.random, time: () => this.time(), clientCommand: (client, text) => this.clientCommand(client, text),
      report: diagnostic => diagnostic.code === "missing-random" ? undefined : diagnostic.code === "print-fragment"
        ? this.print(1, diagnostic.message) : this.printDiagnostic(diagnostic.severity, diagnostic.message, diagnostic.location),
    }, {
      log: this.log,
      maxMessages: () => variables.value("max_messages", "1024"),
      get synonymFile(): string { return variables.string("synfile", "syn.c"); },
      get randomFile(): string { return variables.string("rndfile", "rnd.c"); },
      get matchFile(): string { return variables.string("matchfile", "match.c"); },
      get replyFile(): string { return variables.string("rchatfile", "rchat.c"); },
      noChat: () => variables.value("nochat", "0") !== 0, reloadCharacters,
      testInitialChats: () => variables.getValue("bot_testichat") !== 0,
      testReplyChats: () => variables.getValue("bot_testrchat") !== 0,
      developer: () => this.developerValue !== 0,
    }, this.memory);
    this.moveStates = new BotMoveStateStore({
      time: () => this.time(), print: (severity, text) => this.print(severity, text),
      libVar: (name, initial) => variables.getOrCreate(name, initial),
      setBrushModelTypes: () => this.setBrushModelTypes(),
    }, this.memory);
  }

  get isSetup(): boolean { return this.librarySetup; }
  get disposed(): boolean { return this.terminal; }
  get setupStage(): BotLibrarySetupStage { return this.currentSetupStage; }
  get maxClients(): number { return this.clientCapacity; }
  get maxEntities(): number { return this.entityCapacity; }
  validClientNumber(client: number, operation: string): boolean {
    this.requireLive();
    if (!Number.isInteger(client) || client < -2147483648 || client > 2147483647) {
      throw new RangeError("ValidClientNumber requires a source signed client number");
    }
    if (client < 0 || client > this.clientCapacity) {
      this.print(3, `${operation}: invalid client number ${client}, [0, ${this.clientCapacity}]\n`);
      return false;
    }
    return true;
  }
  get aasInitialized(): boolean { return this.aas.initialized; }
  get movement(): BotMovement { return this.requireMapMovement().movement; }
  get movementRouting(): BotMovementRouting { return this.requireMapMovement().routing; }
  time(): number { return this.aas.time(); }

  /** BotExportTest: Unix Makefile flags and be_interface.h leave DEBUG undefined. */
  test(): number;
  test(parm0: number, parm1: string | null, parm2: Vec3, parm3: Vec3): number;
  test(_parm0?: number, _parm1?: string | null, _parm2?: Vec3, _parm3?: Vec3): number {
    this.requireLive();
    return 0;
  }

  setup(): number {
    this.requireLive();
    this.developerValue = sourceInteger(this.variables.getValue("bot_developer"), "BotLibSetup bot_developer");
    this.librarySetup = false;
    this.clientCapacity = 0;
    this.entityCapacity = 0;
    this.logGlobals.time = 0;
    this.currentSetupStage = "log";
    this.log.open("botlib.log");
    this.requireLive();
    this.print(1, "------- BotLib Initialization -------\n");
    this.requireLive();
    this.clientCapacity = sourceInteger(this.variables.value("maxclients", "128"), "BotLibSetup maxclients");
    this.entityCapacity = sourceInteger(this.variables.value("maxentities", "1024"), "BotLibSetup maxentities");
    this.currentSetupStage = "aas";
    this.aas.setup();
    this.currentSetupStage = "actions";
    this.actions.setup(this.clientCapacity);
    this.mapMovement = null;
    const phase = this.aas.phase;
    if (phase.kind === "loaded" || phase.kind === "ready") this.composeMovement(phase.map);
    this.currentSetupStage = "weapons";
    const weaponResult = this.weapons.setup(this.variables.string("weaponconfig", "weapons.c"));
    this.requireLive();
    if (weaponResult !== 0) return weaponResult;
    this.currentSetupStage = "goals";
    this.goalGameType = this.variables.value("g_gametype", "0");
    const goalResult = this.goals.setup(this.variables.string("itemconfig", "items.c"));
    this.requireLive();
    if (goalResult !== 0) return goalResult;
    this.droppedWeight = this.variables.getOrCreate("droppedweight", "1000");
    this.currentSetupStage = "chat";
    this.chat.setup();
    this.requireLive();
    this.currentSetupStage = "movement";
    const moveResult = this.moveStates.setup();
    this.requireLive();
    if (moveResult !== 0) return moveResult;
    this.librarySetup = true;
    this.currentSetupStage = "complete";
    return 0;
  }

  shutdown(): number {
    this.requireLive();
    if (!this.checkSetup("BotLibShutdown")) return 1;
    this.currentSetupStage = "shutdown";
    this.chat.shutdown();
    this.moveStates.shutdown();
    this.goals.shutdown();
    this.weapons.shutdown();
    this.weights.shutdown();
    this.characters.shutdown();
    this.aas.shutdown();
    this.requireLive();
    this.actions.shutdown();
    this.mapMovement = null;
    this.variables.clear();
    this.globals.clear();
    this.log.shutdown();
    this.requireLive();
    this.librarySetup = false;
    this.currentSetupStage = "none";
    this.sources.checkOpenSourceHandles();
    return 0;
  }

  loadMap(sourceInput: BotLibraryMapInput | (() => BotLibraryMapInput)): number {
    this.requireLive();
    if (!this.checkSetup("BotLoadMap")) return 1;
    this.print(1, "------------ Map Loading ------------\n");
    this.requireLive();
    const input = typeof sourceInput === "function" ? sourceInput() : sourceInput;
    const aas = this.aas;
    const result = aas.loadMap({ ...input, assets: {
      readSync: path => this.files().readSync(path),
      openRead: path => this.files().openRead(path),
      readInto: (file, buffer) => this.files().readInto(file, buffer),
      closeFile: file => this.files().closeFile(file),
      seekFile: (file, offset, origin) => this.files().seekFile(file, offset, origin),
    } });
    this.requireLive();
    if (result !== 0) return result;
    const phase = aas.phase;
    if (phase.kind === "data-loaded") throw new Error("Bot map composition reached interrupted AAS spatial initialization");
    const navigation = phase.kind === "unloaded" ? null : { spatial: phase.map.spatial, routing: phase.map.routing };
    if (phase.kind !== "unloaded") this.composeMovement(phase.map);
    const host = navigation === null ? input.spatialHost : navigation.spatial.host;
    this.goals.initLevelItems({ bspEntities: aas.bspEntities, navigation,
      pointArea: origin => aas.pointArea(origin), host: {
        trace: (start, end, bounds, passEntity, mask) => host.trace(start, end, bounds, passEntity, mask),
        pointContents: point => host.pointContents(point),
        nextEntity: after => aas.entities.nextEntity(after),
        entityInfo: entity => aas.entities.info(entity),
      } });
    this.requireLive();
    this.setBrushModelTypes();
    this.requireLive();
    this.print(1, "-------------------------------------\n");
    this.requireLive();
    return 0;
  }

  startFrame(time: number): number {
    this.requireLive();
    if (!this.checkSetup("BotStartFrame")) return 1;
    return this.aas.startFrame(time);
  }

  updateEntity(entity: number, state: BotEntityUpdate | null | (() => BotEntityUpdate | null)): number {
    this.requireLive();
    if (!this.checkSetup("BotUpdateEntity")) return 1;
    if (!Number.isInteger(entity) || entity < -2147483648 || entity > 2147483647) {
      throw new RangeError("BotUpdateEntity requires a source signed entity number");
    }
    if (entity < 0 || entity > this.entityCapacity) {
      this.print(3, `BotUpdateEntity: invalid entity number ${entity}, [0, ${this.entityCapacity}]\n`);
      return 2;
    }
    // ValidEntityNumber accepts maxentities; AAS owns the resulting allocation check.
    return this.aas.updateEntity(entity, state);
  }

  geneticSelection(ranks: GeneticSelectionInput): GeneticSelectionResult {
    this.requireLive();
    return geneticParentsAndChildSelection(ranks, this.random, text => this.print(2, text));
  }

  /** Terminal cleanup consumes setup residue without replaying source diagnostics. */
  disposeResources(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.librarySetup = false;
    const failures: unknown[] = [];
    const release = (operation: () => void): void => {
      try { operation(); } catch (error) { failures.push(error); }
    };
    release(() => this.chat.disposeResources());
    release(() => this.moveStates.shutdown());
    release(() => this.goals.shutdown());
    release(() => this.weapons.shutdown());
    release(() => this.weights.shutdown());
    release(() => this.characters.shutdown());
    release(() => this.aas.disposeResources());
    release(() => this.actions.disposeResources());
    this.mapMovement = null;
    release(() => this.variables.clear());
    release(() => this.globals.clear());
    release(() => this.sources.disposeResources());
    release(() => {
      const result = this.log.disposeResources();
      if (result.kind === "failed") throw result.error;
    });
    this.currentSetupStage = "none";
    const first = failures[0];
    if (failures.length === 1) throw first;
    if (failures.length > 1) throw new AggregateError(failures, "Bot library resource disposal failed", { cause: first });
  }

  private composeMovement(map: AasRuntimeMap): void {
    if (this.mapMovement?.map === map) return;
    const aas = this.aas;
    const routing = new BotMovementRouting(this.moveStates, map.spatial, map.routing, {
      originOfMoverWithModelNum: model => aas.entities.originOfMoverWithModelNum(model),
      entityModelNum: entity => aas.entities.entityModelNum(entity),
    });
    const movement = new BotMovement(routing, this.actions, {
      random: this.random, developer: () => this.developerValue !== 0,
      nextEntity: after => aas.entities.nextEntity(after),
      entityType: entity => aas.entities.entityType(entity),
      entityWeapon: entity => aas.entities.info(entity).weapon,
    });
    this.mapMovement = { map, routing, movement };
  }

  private requireMapMovement(): MapMovement {
    this.requireLive();
    const phase = this.aas.phase;
    const movement = this.mapMovement;
    if (phase.kind === "unloaded" || phase.kind === "data-loaded" || movement === null || movement.map !== phase.map) {
      throw new Error("Bot movement requires the library's current loaded AAS map");
    }
    return movement;
  }

  private setBrushModelTypes(): void {
    const aas = this.aas;
    aas.brushModelTypes.set(aas.bspEntities, text => this.print(1, text));
  }

  private weaponCapacity(name: "max_weaponinfo" | "max_projectileinfo"): number {
    const value = sourceInteger(this.variables.value(name, "32"), `LoadWeaponConfig ${name}`);
    if (value >= 0) return value;
    this.print(3, `${name} = ${value}\n`);
    this.variables.set(name, "32");
    return 32;
  }

  private checkSetup(operation: string): boolean {
    if (this.librarySetup) return true;
    this.print(3, `${operation}: bot library used before being setup\n`);
    return false;
  }

  private printDiagnostic(severity: DiagnosticSeverity, text: string, location: SourceLocation | null = null): undefined {
    if (location !== null) return this.print(diagnosticSeverity(severity), `file ${location.path}, line ${location.line}: ${text}\n`);
    this.print(diagnosticSeverity(severity), text.endsWith("\n") ? text : `${text}\n`);
    return undefined;
  }

  private scriptDiagnostic(diagnostic: ScriptDiagnostic): void {
    this.printDiagnostic(diagnostic.severity, diagnostic.message, diagnostic.location);
  }

  private files(): BotLibraryFiles { this.requireLive(); return this.options.assets(); }

  private print(severity: PrintSeverity, text: string): undefined {
    this.requireLive();
    return this.options.print(severity, text);
  }

  private *clientCommand(client: number, text: string): CallSteps {
    this.requireLive();
    yield* this.options.clientCommand(client, text);
  }

  private requireLive(): void {
    if (this.terminal) throw new Error("Bot library resources have been disposed");
  }
}
