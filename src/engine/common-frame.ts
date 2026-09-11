// Port of id Software's common.c Com_Init/Com_EventLoop/Com_Frame/Com_Error/Com_Quit_f.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { AsyncLocalStorage } from "node:async_hooks";
import type { CallSteps } from "../core/call-steps.ts";
import type { VfsSearchOptions } from "../assets/vfs.ts";
import type { AsyncCommandHandler, CommandContext, CommandLookup, ResolvedCommandHandler } from "../core/commands.ts";
import { CvarFlag, CvarRegistry } from "../core/cvar.ts";
import type { CvarSnapshot } from "../core/cvar.ts";
import { LinuxNativeRandom } from "../core/native-random.ts";
import { qRandom } from "../core/numeric.ts";
import { LoopbackTransport } from "../protocol/loopback.ts";
import { MAX_MESSAGE_LENGTH } from "../protocol/message.ts";
import type { ServerPacketAddress } from "../server/net-channel.ts";
import type { SystemClock } from "../platform/system-clock.ts";
import { initializeSystemCvars } from "../platform/system-init.ts";
import { CommonConsole } from "./common-console.ts";
import type { CommonBuildProfile } from "./common-console.ts";
import { CommonError } from "../core/common-error.ts";
import type { CommonErrorCode } from "../core/common-error.ts";
import { CommonEvents } from "./common-events.ts";
import type { CommonEventSource } from "./common-events.ts";
import type { CommonEventMemory } from "./event-memory.ts";
import type { ServerShutdownRequest } from "./server-engine.ts";
import { StartupCommands } from "./startup-commands.ts";

export interface CommonServerRuntime {
  readonly running: boolean;
  readonly profile: { readonly timeGame: number };
  frame(milliseconds: number): Promise<void>;
  packetEvent(from: ServerPacketAddress, payload: Uint8Array): Promise<void>;
  shutdown(request: ServerShutdownRequest): Promise<void>;
  shutdownFromCommand(reason: string): Promise<void>;
  disposeResources(): Promise<void>;
  gameConsoleCommand(context: CommandContext): CallSteps<boolean>;
  assertCommandEntry(): void;
}

export type CommonNeedCdCapability =
  | { readonly kind: "absent" }
  | { readonly kind: "available"; show(): Promise<void> };

export interface CommonClientRuntime {
  readonly needCd: CommonNeedCdCapability;
  readonly frameTimings: { readonly frontEndMsec: number; readonly backEndMsec: number };
  initializeInput(): void;
  restartInput(): void;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  disposeResources(): Promise<void>;
  frame(milliseconds: number): Promise<void>;
  packetEvent(from: ServerPacketAddress, payload: Uint8Array): Promise<void>;
  keyEvent(key: number, down: boolean, time: number): Promise<void>;
  characterEvent(character: number): Promise<void>;
  mouseEvent(dx: number, dy: number, time: number): Promise<void>;
  joystickEvent(axis: number, value: number, time: number): Promise<void>;
  disconnect(showMainMenu: boolean): Promise<void>;
  flushMemory(): Promise<void>;
  queueDefaultStartup(commands: CommonConsole["commands"]): void;
  startHunkUsers(): Promise<void>;
}

export type CommonClientCapability =
  | { readonly kind: "absent" }
  | { readonly kind: "available"; readonly runtime: CommonClientRuntime };

export interface CommonFramePlatform extends CommonEventSource {
  yieldToIo(): Promise<void>;
  showConsole(level: number, quitOnClose: boolean): void;
  initialize(cvars: CvarRegistry): Promise<void>;
  close(): void;
}

export interface CommonCommandFallbacks { readonly server: ResolvedCommandHandler }

export interface CommonServerConstruction {
  readonly common: CommonConsole;
  readonly events: CommonEvents;
  readonly platform: CommonFramePlatform;
  readonly loopback: LoopbackTransport;
  readonly random: LinuxNativeRandom;
  readonly dedicated: number;
  assertCurrentOperation(): void;
  runRendererCallback<T>(callback: () => T): T;
  pumpForDownloadsComplete(): Promise<void>;
  deferCleanup(cleanup: () => void | Promise<void>): void;
}

export interface CommonFrameOpenOptions {
  readonly roots: VfsSearchOptions;
  readonly startupText: string;
  readonly buildDate: string;
  readonly build: CommonBuildProfile;
  readonly platformPrint: (text: string) => undefined;
  readonly random?: LinuxNativeRandom;
  readonly client: CommonClientCapability;
  readonly systemClock: SystemClock;
  createPlatform(print: (text: string) => undefined, eventMemory: CommonEventMemory): CommonFramePlatform;
  createServer(services: CommonServerConstruction): Promise<CommonServerRuntime> | CommonServerRuntime;
  resolveCommand(lookup: CommandLookup, fallbacks: CommonCommandFallbacks): ResolvedCommandHandler | undefined;
}

export type CommonRunLimit = { readonly kind: "continuous" } | { readonly kind: "frames"; readonly count: number };
export interface CommonFrameResult {
  readonly kind: "frame";
  readonly frameNumber: number;
  readonly frameTime: number;
  readonly rawMilliseconds: number;
  readonly modifiedMilliseconds: number;
}
export interface CommonFrameAborted {
  readonly kind: "aborted";
  readonly frameNumber: number;
  readonly code: Exclude<CommonErrorCode, "fatal">;
  readonly message: string;
}
export interface CommonQuit { readonly kind: "quit"; readonly frames: number }
export type CommonFrameOutcome = CommonFrameResult | CommonFrameAborted | CommonQuit;
export type CommonExit = CommonQuit | { readonly kind: "frame-limit"; readonly frames: number };

export interface CommonTimeSettings {
  readonly rawMilliseconds: number;
  readonly fixedTime: number;
  readonly timeScale: number;
  readonly cameraMode: number;
  readonly dedicated: boolean;
  readonly localServer: boolean;
}

/** Explicit native binary32 profile; optimized i386 x87 excess precision differs. */
export function modifyCommonMilliseconds(settings: CommonTimeSettings): { readonly milliseconds: number; readonly hitchMilliseconds: number | null } {
  for (const value of [settings.rawMilliseconds, settings.fixedTime, settings.cameraMode]) {
    if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new RangeError("Common timing requires signed-int milliseconds and controls");
  }
  let milliseconds = settings.rawMilliseconds;
  const scale = Math.fround(settings.timeScale);
  if (settings.fixedTime !== 0) milliseconds = settings.fixedTime;
  else if (scale !== 0 || settings.cameraMode !== 0) {
    const product = Math.fround(Math.fround(milliseconds) * scale);
    if (!Number.isFinite(product) || product < -2147483648 || product >= 2147483648) throw new RangeError("Undefined native common float-to-int time conversion");
    milliseconds = Math.trunc(product) + 0;
  }
  if (milliseconds < 1 && scale !== 0) milliseconds = 1;
  const limit = settings.dedicated || !settings.localServer ? 5000 : 200;
  return { milliseconds: Math.min(milliseconds, limit), hitchMilliseconds: settings.dedicated && milliseconds > 500 ? milliseconds : null };
}

interface DriverOperation { closed: boolean }
type PendingFailure = { readonly kind: "none" } | { readonly kind: "failure"; readonly value: unknown };
class QuitControl extends Error {}

export class CommonFrameDriver {
  private readonly operationContext = new AsyncLocalStorage<DriverOperation>();
  private activeOperation: DriverOperation | undefined;
  private phase: "initializing" | "open" | "source-terminal" | "disposed" = "initializing";
  private executionStage: "source" | "system" | "resources" = "source";
  private commonResource: CommonConsole | null = null;
  private platformResource: CommonFramePlatform | null = null;
  private serverResource: CommonServerRuntime | null = null;
  private eventsResource: CommonEvents | null = null;
  private loopbackResource: LoopbackTransport | null = null;
  private clientResource: CommonClientRuntime | null;
  private readonly deferredCleanups: (() => void | Promise<void>)[] = [];
  private constructingServer = false;
  private frameNumber = 0;
  private lastTime = 0;
  private dropSeed = 0;
  private errorEntered = false;
  private enteredErrorMessage = "";
  private lastErrorTime = 0;
  private errorCount = 0;

  private constructor(private readonly options: CommonFrameOpenOptions) {
    this.clientResource = options.client.kind === "available" ? options.client.runtime : null;
  }

  static async open(options: CommonFrameOpenOptions): Promise<CommonFrameDriver> {
    const driver = new CommonFrameDriver(options);
    await driver.operation(async () => {
      try { await driver.initialize(); }
      catch (error) { await driver.finishDisposal({ kind: "failure", value: error }); }
    });
    return driver;
  }

  get common(): CommonConsole { return this.requireResource(this.commonResource, "console"); }
  get server(): CommonServerRuntime { return this.requireResource(this.serverResource, "server"); }
  get events(): CommonEvents { return this.requireResource(this.eventsResource, "events"); }
  get loopback(): LoopbackTransport { return this.requireResource(this.loopbackResource, "loopback"); }

  private requireResource<T>(resource: T | null, name: string): T {
    if (resource === null) throw new Error(`Common ${name} ownership is not initialized`);
    return resource;
  }

  private async initialize(): Promise<void> {
    this.options.platformPrint(`Q3 1.32b linux-ts ${this.options.buildDate}\n`);
    const startup = new StartupCommands(this.options.startupText);
    const random = this.options.random ?? new LinuxNativeRandom(1);
    const owner = this;
    const serverFallback: ResolvedCommandHandler = Object.freeze({ kind: "calls", *handler(context: CommandContext): CallSteps {
      if (owner.serverResource !== null) yield* owner.serverResource.gameConsoleCommand(context);
    } });
    const fallbacks: CommonCommandFallbacks = Object.freeze({ server: serverFallback });
    try {
      await CommonConsole.open({ roots: this.options.roots, startup, random, build: this.options.build,
        platformPrint: this.options.platformPrint, resolveCommand: lookup => this.options.resolveCommand(lookup, fallbacks),
        assertCommandEntry: () => { this.assertCurrentOperation(); this.serverResource?.assertCommandEntry(); },
        assertOwnerEntry: () => { this.assertOwnedOperation(); } }, common => { this.commonResource = common; return undefined; });
      const common = this.common;
      common.commands.append("exec default.cfg\n");
      if (!startup.consumeSafeMode()) common.commands.append("exec q3config.cfg\n");
      common.commands.append("exec autoexec.cfg\n");
      await common.commands.executeAsync();
      startup.applyVariables(common.cvars, null);
      const dedicated = common.registerRuntimeCvars(this.options.buildDate, this.quitCommand());
      this.validateProfile();
      const print = (text: string): undefined => { if (this.commonResource === null) this.options.platformPrint(text); else this.commonResource.output.print(text); };
      this.platformResource = this.options.createPlatform(print, common.eventMemory);
      const platform = this.platformResource;
      this.eventsResource = new CommonEvents({ getEvent: () => common.journal.getEvent(platform) }, print, common.eventMemory);
      common.publishCommonClock(this.events);
      common.commands.register("in_restart", () => {
        this.assertCurrentOperation();
        if (this.options.client.kind === "available") this.options.client.runtime.restartInput();
      });
      initializeSystemCvars(common.cvars);
      if (this.options.client.kind === "available") this.options.client.runtime.initializeInput();
      const qport = this.events.milliseconds() & 65535;
      common.cvars.register("showpackets", "0", CvarFlag.Temporary);
      common.cvars.register("showdrop", "0", CvarFlag.Temporary);
      common.cvars.register("net_qport", String(qport), CvarFlag.Init);
      this.loopbackResource = new LoopbackTransport();
      common.initVm();
      this.constructingServer = true;
      try {
        this.serverResource = await this.options.createServer({ common, events: this.events, platform: this.platformResource,
          loopback: this.loopback, random, dedicated, assertCurrentOperation: () => { this.assertCurrentOperation(); },
          runRendererCallback: callback => this.runRendererCallback(callback),
          pumpForDownloadsComplete: () => this.pumpForDownloadsComplete(),
          deferCleanup: cleanup => {
            this.assertCurrentOperation();
            if (!this.constructingServer) throw new Error("Common server construction has already transferred ownership");
            this.deferredCleanups.push(cleanup);
          } });
        this.deferredCleanups.length = 0;
      } finally { this.constructingServer = false; }
      common.cvars.clearModified("dedicated");
      if (this.cvar("dedicated").integerValue === 0) {
        if (this.options.client.kind === "available") { await this.options.client.runtime.initialize(); this.assertCurrentOperation(); }
        else common.cvars.register("cl_shownet", "0", CvarFlag.Temporary);
        this.platformResource.showConsole(this.cvar("viewlog").integerValue, false);
      }
      this.events.captureFrameTime(this.events.milliseconds());
      const added = startup.appendCommands(common.commands);
      if (!added && this.cvar("dedicated").integerValue === 0 && this.options.client.kind === "available") {
        this.options.client.runtime.queueDefaultStartup(common.commands);
      }
      common.cvars.set("r_uiFullScreen", "1", true);
      if (this.cvar("dedicated").integerValue === 0 && this.options.client.kind === "available") {
        await this.options.client.runtime.startHunkUsers(); this.assertCurrentOperation();
      }
      common.cvars.set("ui_singlePlayerActive", "0", true);
      common.markInitialized();
      common.output.print("--- Common Initialization Complete ---\n");
    } catch (error) {
      await this.rejectInitialization(error, true);
    }
    // unix_main.c initializes networking/console after Com_Init returns.
    try {
      await this.requireResource(this.platformResource, "platform").initialize(this.common.cvars);
      this.assertCurrentOperation();
      this.phase = "open";
    } catch (error) { await this.rejectInitialization(error, false); }
  }

  private validateProfile(): void {
    if (this.options.build.kind === "dedicated" && this.options.client.kind !== "absent") throw new Error("Dedicated common build requires the compiled-null client capability");
    if (this.options.build.kind === "client" && this.options.client.kind !== "available") throw new Error("Client common build requires a real build-lifetime client capability");
  }

  private quitCommand(): AsyncCommandHandler {
    return async context => {
      context.assertActive(); this.assertCurrentOperation();
      await this.sourceShutdown(this.errorEntered ? "system" : "normal", true); context.assertActive();
      throw new QuitControl();
    };
  }

  private cvar(name: string): CvarSnapshot {
    const value = this.common.cvars.get(name);
    if (value === undefined) throw new Error(`Common frame requires registered cvar ${name}`);
    return value;
  }

  assertCurrentOperation(): void {
    this.assertOwnedOperation();
    if (!this.sourceActive()) throw new Error("Common source work is no longer active");
  }

  private assertOwnedOperation(): void {
    const operation = this.operationContext.getStore();
    if (operation === undefined || operation.closed || operation !== this.activeOperation || this.phase === "disposed") {
      throw new Error("Common work requires the current owned driver operation");
    }
  }

  private runRendererCallback<T>(callback: () => T): T {
    const active = this.activeOperation;
    // A synchronous source barrier already carries the caller's shutdown scope.
    if (active !== undefined && !active.closed && this.operationContext.getStore() === active) {
      this.assertOwnedOperation();
      return callback();
    }
    if (!this.sourceActive()) throw new Error("Renderer callbacks require active common source work");
    // Worker messages retain their startup async context. Bind each callback to
    // the current frame, or a finite synchronous operation between frames.
    if (active !== undefined) return this.operationContext.run(active, callback);
    const operation: DriverOperation = { closed: false };
    this.activeOperation = operation;
    try { return this.operationContext.run(operation, callback); }
    finally { operation.closed = true; this.activeOperation = undefined; }
  }

  private async operation<T>(task: () => Promise<T>): Promise<T> {
    const inherited = this.operationContext.getStore();
    if (inherited?.closed) throw new Error("Cannot reuse a closed common driver operation");
    if (this.activeOperation !== undefined) throw new Error("Common driver operations must be awaited in source order");
    const operation: DriverOperation = { closed: false };
    this.activeOperation = operation;
    return this.operationContext.run(operation, async () => {
      try { return await task(); }
      finally { operation.closed = true; this.activeOperation = undefined; }
    });
  }

  private opened(): void { if (this.phase !== "open") throw new Error("Common frame driver is closed"); }

  async frame(): Promise<CommonFrameOutcome> {
    return this.operation(async () => {
      this.opened();
      try { return await this.advanceFrame(); }
      catch (error) { return this.handleAttemptError(error); }
    });
  }

  async run(limit: CommonRunLimit): Promise<CommonExit> {
    if (limit.kind === "frames" && (!Number.isInteger(limit.count) || limit.count < 1 || limit.count > 2147483647)) {
      throw new RangeError("Common frame count requires an integer in 1..2147483647");
    }
    return this.operation(async () => {
      this.opened();
      try {
        for (let attempted = 0; limit.kind === "continuous" || attempted < limit.count; attempted++) {
          try { await this.advanceFrame(); }
          catch (error) {
            const outcome = await this.handleAttemptError(error);
            if (outcome.kind === "quit") return outcome;
          }
        }
        await this.common.commands.executeNowAsync("quit");
        throw new Error("Common quit command returned without terminating its drain");
      } catch (error) {
        if (error instanceof QuitControl) return { kind: "frame-limit", frames: this.frameNumber };
        if (error instanceof CommonError && this.sourceActive()) await this.dispatchCommonError(error);
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.operation(async () => {
      if (this.phase === "disposed") return;
      let failure: PendingFailure = { kind: "none" };
      if (this.sourceActive()) {
        try { await this.sourceShutdown(this.errorEntered ? "system" : "normal", false); }
        catch (error) {
          failure = { kind: "failure", value: error };
          if (error instanceof CommonError && this.sourceActive()) {
            try { await this.dispatchCommonError(error); }
            catch (selected) { failure = { kind: "failure", value: selected }; }
          }
        }
      }
      await this.finishDisposal(failure);
    });
  }

  private async handleAttemptError(error: unknown): Promise<CommonFrameOutcome> {
    if (error instanceof QuitControl) return { kind: "quit", frames: this.frameNumber };
    if (error instanceof CommonError && this.sourceActive()) return this.dispatchCommonError(error);
    if (this.sourceActive()) {
      try { await this.sourceShutdown("common-error", false, { kind: "failure", value: error }); }
      catch (cleanupError) {
        if (cleanupError instanceof CommonError && this.sourceActive()) return this.dispatchCommonError(cleanupError);
        throw cleanupError;
      }
    }
    throw error;
  }

  private sourceActive(): boolean { return this.executionStage === "source" && (this.phase === "initializing" || this.phase === "open"); }

  private async dispatchCommonError(error: CommonError): Promise<CommonFrameAborted> {
    try { return await this.handleCommonError(error); }
    catch (selected) {
      if (!this.sourceActive()) throw selected;
      if (selected instanceof CommonError) return this.dispatchCommonError(selected);
      try { await this.sourceShutdown("common-error", false, { kind: "failure", value: selected }); }
      catch (cleanupError) {
        if (cleanupError instanceof CommonError && this.sourceActive()) return this.dispatchCommonError(cleanupError);
        throw cleanupError;
      }
      throw selected;
    }
  }

  private async handleCommonError(error: CommonError): Promise<CommonFrameAborted> {
    let code = error.code;
    const buildScript = this.common.readErrorCvar("com_buildScript");
    if (buildScript !== null && buildScript.integerValue !== 0) code = "fatal";
    await this.common.clearPureServerPaks(() => { this.assertCurrentOperation(); });
    this.assertCurrentOperation();
    const now = this.options.systemClock.milliseconds();
    if (((now - this.lastErrorTime) | 0) < 100) {
      this.errorCount++;
      if (this.errorCount > 3) code = "fatal";
    } else this.errorCount = 0;
    this.lastErrorTime = now;
    if (this.errorEntered) {
      const recursiveError = new CommonError("fatal", `recursive error after: ${this.enteredErrorMessage}`);
      await this.systemTermination({ kind: "failure", value: recursiveError });
      throw recursiveError;
    }
    this.errorEntered = true;
    this.enteredErrorMessage = error.message;
    if (code !== "disconnect" && code !== "need-cd") this.common.cvars.set("com_errorMessage", error.message, true);
    if (code === "fatal") {
      await this.sourceShutdown("common-error", false, { kind: "failure", value: error });
      throw error;
    }
    if (code === "server-disconnect") {
      if (this.options.client.kind === "available") {
        await this.options.client.runtime.disconnect(true); this.assertCurrentOperation();
        await this.options.client.runtime.flushMemory(); this.assertCurrentOperation();
      }
      this.errorEntered = false;
      return { kind: "aborted", frameNumber: this.frameNumber, code, message: error.message };
    }
    if (code === "drop" || code === "disconnect") {
      this.common.output.print("********************\nERROR: " + error.message + "\n********************\n");
      await this.shutdownServer({ kind: "common-error", reason: `Server crashed: ${error.message}\n` });
      if (this.options.client.kind === "available") {
        await this.options.client.runtime.disconnect(true); this.assertCurrentOperation();
        await this.options.client.runtime.flushMemory(); this.assertCurrentOperation();
      }
      this.errorEntered = false;
      return { kind: "aborted", frameNumber: this.frameNumber, code, message: error.message };
    }
    await this.shutdownServer({ kind: "common-error", reason: "Server didn't have CD\n" });
    const clientRunning = this.common.readErrorCvar("cl_running");
    if (clientRunning === null || clientRunning.integerValue === 0) {
      this.common.output.print("Server didn't have CD\n");
      return { kind: "aborted", frameNumber: this.frameNumber, code, message: error.message };
    }
    const client = this.requireClient();
    await client.disconnect(true); this.assertCurrentOperation();
    await client.flushMemory(); this.assertCurrentOperation();
    this.errorEntered = false;
    if (client.needCd.kind === "absent") throw new Error("ERR_NEED_CD requires the unavailable client CD dialog capability");
    await client.needCd.show(); this.assertCurrentOperation();
    return { kind: "aborted", frameNumber: this.frameNumber, code, message: error.message };
  }

  private async rejectInitialization(error: unknown, nativeInitialization: boolean): Promise<never> {
    let failure = error;
    if (!(failure instanceof CommonError)) {
      const errors: unknown[] = [failure];
      while (this.deferredCleanups.length !== 0) {
        const cleanup = this.deferredCleanups.pop();
        if (cleanup === undefined) throw new Error("Common initialization cleanup ledger is sparse");
        try { await cleanup(); }
        catch (cleanupError) {
          if (cleanupError instanceof CommonError) { failure = cleanupError; break; }
          errors.push(cleanupError);
        }
      }
      if (!(failure instanceof CommonError) && errors.length > 1) failure = new AggregateError(errors, "Common initialization callback cleanup failed", { cause: error });
    }
    if (!(failure instanceof CommonError)) {
      try { await this.sourceShutdown("common-error", false, { kind: "failure", value: failure }); }
      catch (cleanupError) {
        if (!(cleanupError instanceof CommonError) || !this.sourceActive()) throw cleanupError;
        failure = cleanupError;
      }
      if (!(failure instanceof CommonError)) throw failure;
    }
    await this.dispatchCommonError(failure);
    const terminal = nativeInitialization ? new CommonError("fatal", "Error during initialization") : failure;
    await this.systemTermination({ kind: "failure", value: terminal });
    throw terminal;
  }

  private async shutdownServer(request: ServerShutdownRequest): Promise<void> {
    if (this.serverResource === null) {
      const running = this.common.readErrorCvar("sv_running");
      if (running === null || running.integerValue === 0) return;
      throw new Error("Running common server has no actual server owner");
    }
    await this.serverResource.shutdown(request); this.assertCurrentOperation();
  }

  private async sourceShutdown(mode: "normal" | "common-error" | "system", fromQuitCommand: boolean,
    primary: PendingFailure = { kind: "none" }): Promise<void> {
    if (!this.sourceActive()) return;
    const errors: unknown[] = [];
    const capture = (error: unknown): void => {
      if (error instanceof CommonError) throw error;
      errors.push(error);
    };
    const client = this.options.client.kind === "available" ? this.options.client.runtime : null;
    const shutdownClient = async (): Promise<void> => {
      if (client === null) return;
      try { await client.shutdown(); this.assertCurrentOperation(); } catch (error) { capture(error); }
    };
    if (mode === "common-error") await shutdownClient();
    if (mode !== "system" && this.commonResource !== null) {
      try {
        if (fromQuitCommand && this.serverResource !== null) await this.serverResource.shutdownFromCommand("Server quit\n");
        else {
          const cause = primary.kind === "failure" ? primary.value : "Common failure";
          const message = cause instanceof Error ? cause.message : String(cause ?? "Common failure");
          await this.shutdownServer({ kind: mode,
            reason: mode === "normal" ? "Server quit\n" : `Server fatal crashed: ${message}\n` });
        }
        this.assertCurrentOperation();
      } catch (error) { capture(error); }
    }
    if (mode === "normal") await shutdownClient();
    if (mode !== "system" && this.commonResource !== null) {
      try { this.commonResource.shutdown(); } catch (error) { capture(error); }
      if (mode === "normal") { try { this.commonResource.shutdownFileSystem(); } catch (error) { capture(error); } }
    }
    await this.systemTermination(primary, errors);
  }

  private async systemTermination(primary: PendingFailure = { kind: "none" }, errors: unknown[] = []): Promise<void> {
    this.executionStage = "system";
    // Sys_Quit/Sys_Error's final CL_Shutdown is a finite system-stage attempt.
    try {
      if (this.options.client.kind === "available") {
        try { await this.options.client.runtime.shutdown(); this.assertOwnedOperation(); }
        catch (error) { errors.push(error); }
      }
    } finally {
      const platform = this.platformResource;
      this.platformResource = null;
      try { platform?.close(); } catch (error) { errors.push(error); }
      this.phase = "source-terminal";
    }
    if (errors.length > 0) {
      if (primary.kind === "failure") errors.unshift(primary.value);
      throw new AggregateError(errors, "Common shutdown failed", { cause: primary.kind === "failure" ? primary.value : undefined });
    }
  }

  private async disposeOwnedResources(): Promise<void> {
    const errors: unknown[] = [];
    try {
      while (this.deferredCleanups.length !== 0) {
        const cleanup = this.deferredCleanups.pop();
        if (cleanup === undefined) throw new Error("Common initialization cleanup ledger is sparse");
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      const server = this.serverResource;
      this.serverResource = null;
      try { await server?.disposeResources(); } catch (error) { errors.push(error); }
      const client = this.clientResource;
      this.clientResource = null;
      try { await client?.disposeResources(); } catch (error) { errors.push(error); }
      const common = this.commonResource;
      this.commonResource = null;
      try { common?.close(); } catch (error) { errors.push(error); }
    } finally {
      const platform = this.platformResource;
      this.platformResource = null;
      try { platform?.close(); } catch (error) { errors.push(error); }
      this.eventsResource = null; this.loopbackResource = null;
      this.phase = "disposed";
    }
    if (errors.length > 0) throw new AggregateError(errors, "Common resource disposal failed");
  }

  private async finishDisposal(primary: PendingFailure): Promise<void> {
    // Disposal has owned authority, never source authority, even after a recoverable abort.
    this.executionStage = "resources";
    try { await this.disposeOwnedResources(); }
    catch (error) {
      if (primary.kind === "failure") throw new AggregateError([primary.value, error], "Common operation and resource disposal failed");
      throw error;
    }
    if (primary.kind === "failure") throw primary.value;
  }

  private requireClient(): CommonClientRuntime {
    if (this.options.client.kind === "absent") throw new Error("Client/listen mode requires a real client owner");
    return this.options.client.runtime;
  }

  private async eventLoop(captureTime: boolean): Promise<number> {
    let packetStorage: Uint8Array | null = null;
    const packetBuffer = (): Uint8Array => packetStorage ??= new Uint8Array(MAX_MESSAGE_LENGTH);
    while (true) {
      const event = this.events.getEvent();
      if (event.kind === "none") {
        for (let packet = this.loopback.poll("client"); packet !== null; packet = this.loopback.poll("client")) {
          if (this.options.client.kind === "available") {
            await this.options.client.runtime.packetEvent(packet.from, packet.payload); this.assertCurrentOperation();
          }
        }
        for (let packet = this.loopback.poll("server"); packet !== null; packet = this.loopback.poll("server")) {
          if (this.cvar("sv_running").integerValue !== 0) await this.runAndTimeServerPacket(packet.from, packet.payload);
        }
        if (captureTime) this.events.captureFrameTime(event.time);
        return event.time;
      }
      const freePayload = await this.dispatchEvent(event, packetBuffer); this.assertCurrentOperation();
      if (freePayload) this.common.eventMemory.free(event);
    }
  }

  private async dispatchEvent(event: Exclude<ReturnType<CommonEvents["getEvent"]>, { readonly kind: "none" }>,
    packetBuffer: () => Uint8Array): Promise<boolean> {
    if (event.kind === "console") { this.common.commands.append(event.text); this.common.commands.append("\n"); return true; }
    if (event.kind === "packet") {
      const probability = this.cvar("com_dropsim").numericValue;
      if (probability > 0) {
        const random = qRandom(this.dropSeed); this.dropSeed = random.seed;
        if (random.value < probability) return true;
      }
      const from = event.from, payload = event.payload;
      const storage = packetBuffer();
      if (payload.byteLength > storage.byteLength) {
        this.common.output.print("Com_EventLoop: oversize packet\n"); this.assertCurrentOperation();
        return false;
      }
      storage.set(payload);
      const message = storage.subarray(0, payload.byteLength);
      if (this.cvar("sv_running").integerValue !== 0) await this.runAndTimeServerPacket(from, message);
      else if (this.options.client.kind === "available") await this.options.client.runtime.packetEvent(from, message);
      this.assertCurrentOperation(); return true;
    }
    if (this.options.client.kind === "absent") return true;
    const client = this.options.client.runtime;
    if (event.kind === "key") await client.keyEvent(event.key, event.down, event.time);
    else if (event.kind === "character") await client.characterEvent(event.character);
    else if (event.kind === "mouse") await client.mouseEvent(event.dx, event.dy, event.time);
    else await client.joystickEvent(event.axis, event.value, event.time);
    this.assertCurrentOperation();
    return true;
  }

  async pumpForDownloadsComplete(): Promise<void> {
    this.assertCurrentOperation();
    await this.eventLoop(false);
  }

  private async runAndTimeServerPacket(from: ServerPacketAddress, payload: Uint8Array): Promise<void> {
    let before = 0;
    if (this.cvar("com_speeds").integerValue !== 0) before = this.options.systemClock.milliseconds();
    await this.server.packetEvent(from, payload); this.assertCurrentOperation();
    if (this.cvar("com_speeds").integerValue !== 0) {
      const elapsed = (this.options.systemClock.milliseconds() - before) | 0;
      if (this.cvar("com_speeds").integerValue === 3) {
        this.common.output.print(`SV_PacketEvent time: ${elapsed}\n`); this.assertCurrentOperation();
      }
    }
  }

  private async advanceFrame(): Promise<CommonFrameResult> {
    let timeBeforeFirstEvents = 0, timeBeforeServer = 0, timeBeforeEvents = 0, timeBeforeClient = 0, timeAfter = 0;
    this.common.assertCapabilities();
    await this.common.writeConfiguration();
    this.assertCurrentOperation();
    const viewlog = this.cvar("viewlog");
    if (viewlog.modified) {
      if (this.cvar("dedicated").numericValue === 0) this.requireResource(this.platformResource, "platform").showConsole(viewlog.integerValue, false);
      this.common.cvars.clearModified("viewlog");
    }
    if (this.cvar("com_speeds").integerValue !== 0) timeBeforeFirstEvents = this.options.systemClock.milliseconds();
    const dedicated = this.cvar("dedicated").integerValue;
    const maxFps = this.cvar("com_maxfps").integerValue;
    const minimum = dedicated === 0 && maxFps > 0 && this.cvar("timedemo").integerValue === 0 ? Math.trunc(1000 / maxFps) : 1;
    let rawMilliseconds: number;
    do {
      await this.requireResource(this.platformResource, "platform").yieldToIo(); this.assertCurrentOperation();
      const time = await this.eventLoop(true);
      if (this.lastTime > time) this.lastTime = time;
      rawMilliseconds = (time - this.lastTime) | 0;
    } while (rawMilliseconds < minimum);
    await this.common.commands.executeAsync(); this.assertCurrentOperation();
    this.lastTime = this.events.comFrameTime;
    this.common.assertCapabilities();
    const mode = this.cvar("dedicated").integerValue;
    const modified = modifyCommonMilliseconds({ rawMilliseconds, fixedTime: this.cvar("fixedtime").integerValue,
      timeScale: this.cvar("timescale").numericValue, cameraMode: this.cvar("com_cameraMode").integerValue,
      dedicated: mode !== 0, localServer: this.cvar("sv_running").integerValue !== 0 });
    if (modified.hitchMilliseconds !== null) this.common.output.print(`Hitch warning: ${modified.hitchMilliseconds} msec frame time\n`);
    if (this.cvar("com_speeds").integerValue !== 0) timeBeforeServer = this.options.systemClock.milliseconds();
    await this.server.frame(modified.milliseconds); this.assertCurrentOperation();
    if (this.cvar("dedicated").modified) {
      const current = this.common.cvars.register("dedicated", "0").integerValue;
      this.common.cvars.clearModified("dedicated");
      if (current === 0) {
        if (this.options.client.kind === "available") { await this.options.client.runtime.initialize(); this.assertCurrentOperation(); }
        else this.common.cvars.register("cl_shownet", "0", CvarFlag.Temporary);
        this.requireResource(this.platformResource, "platform").showConsole(this.cvar("viewlog").integerValue, false);
      } else {
        if (this.options.client.kind === "available") { await this.options.client.runtime.shutdown(); this.assertCurrentOperation(); }
        this.requireResource(this.platformResource, "platform").showConsole(1, true);
      }
    }
    if (this.cvar("dedicated").integerValue === 0) {
      if (this.cvar("com_speeds").integerValue !== 0) timeBeforeEvents = this.options.systemClock.milliseconds();
      await this.eventLoop(false);
      await this.common.commands.executeAsync(); this.assertCurrentOperation();
      if (this.cvar("com_speeds").integerValue !== 0) timeBeforeClient = this.options.systemClock.milliseconds();
      if (this.options.client.kind === "available") { await this.options.client.runtime.frame(modified.milliseconds); this.assertCurrentOperation(); }
      if (this.cvar("com_speeds").integerValue !== 0) timeAfter = this.options.systemClock.milliseconds();
    }
    if (this.cvar("com_speeds").integerValue !== 0) {
      const game = this.server.profile.timeGame;
      // A dedicated executable has source static-zero client timings. Client builds
      // retain their actual CL_Frame publication across dedicated mode transitions.
      const timings = this.options.client.kind === "available" ? this.options.client.runtime.frameTimings : null;
      const frontend = timings === null ? 0 : timings.frontEndMsec;
      const backend = timings === null ? 0 : timings.backEndMsec;
      const all = (timeAfter - timeBeforeServer) | 0;
      const server = (timeBeforeEvents - timeBeforeServer - game) | 0;
      const events = (timeBeforeServer - timeBeforeFirstEvents + timeBeforeClient - timeBeforeEvents) | 0;
      const client = (timeAfter - timeBeforeClient - frontend - backend) | 0;
      const field = (value: number): string => String(value).padStart(3, " ");
      this.common.output.print(`frame:${this.frameNumber} all:${field(all)} sv:${field(server)} ev:${field(events)} cl:${field(client)} gm:${field(game)} rf:${field(frontend)} bk:${field(backend)}\n`);
      this.assertCurrentOperation();
    }
    if (this.cvar("com_showtrace").integerValue !== 0) {
      const counters = this.common.collisionCounters;
      this.common.output.print(`${String(counters.c_traces).padStart(4, " ")} traces  (${counters.c_brush_traces}b ${counters.c_patch_traces}p) ${String(counters.c_pointcontents).padStart(4, " ")} points\n`);
      this.assertCurrentOperation();
      counters.reset();
    }
    this.frameNumber = (this.frameNumber + 1) | 0;
    return { kind: "frame", frameNumber: this.frameNumber, frameTime: this.events.comFrameTime,
      rawMilliseconds, modifiedMilliseconds: modified.milliseconds };
  }
}
