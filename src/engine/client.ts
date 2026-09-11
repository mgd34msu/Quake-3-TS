// Client ownership from id Software's code/client/cl_main.c, cl_cgame.c and cl_ui.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { AsyncLocalStorage } from "node:async_hooks";
import { NativeRoot } from "../assets/native-root.ts";
import { runCalls } from "../core/call-steps.ts";
import type { SoundAssetReader } from "../cgame/sound-bank.ts";
import type { SourceFileReader } from "../assets/reader.ts";
import type { RetainedFileReader } from "../assets/read-file-memory.ts";
import { ClientLevel } from "../cgame/client-level.ts";
import { SourceClipModels } from "../collision/clip-models.ts";
import type { CommandContext, CommandHandler, CommandLookup, ResolvedCommandHandler } from "../core/commands.ts";
import { CommonError } from "../core/common-error.ts";
import type { CvarSnapshot } from "../core/cvar.ts";
import { CvarFlag } from "../core/cvar.ts";
import type { FieldClipboard } from "../core/edit-field.ts";
import { infoValueForKey } from "../core/info-string.ts";
import { KeyCatcher } from "../core/key-codes.ts";
import { nativeAtoi } from "../core/native-numeric.ts";
import { qStrncpyz } from "../core/source-strings.ts";
import { SdlGameInput } from "../platform/sdl-game-input.ts";
import { SourceInputState } from "../platform/source-input.ts";
import { SourceMidiInput } from "../platform/midi.ts";
import { readSdlClipboard, SdlWindow } from "../platform/sdl.ts";
import { openUnixGlDriver, initializeUnixGlRenderer } from "../platform/renderer-driver.ts";
import type { SystemClock } from "../platform/system-clock.ts";
import { UnixSystemClock } from "../platform/system-clock.ts";
import type { UnixIo } from "../platform/unix-io.ts";
import { encodeConnectionlessText } from "../protocol/connectionless.ts";
import type { ConnectionlessPacket } from "../protocol/connectionless.ts";
import type { LoopbackTransport } from "../protocol/loopback.ts";
import { ReliableOverflowError } from "../protocol/reliable.ts";
import { BuiltinImages } from "../render/builtin-images.ts";
import { SOURCE_BACKEND_RELEASE32 } from "../render/backend-memory.ts";
import { RenderCommandBuffer, RendererCommandStorage, RenderTarget } from "../render/commands.ts";
import { RendererPerformanceCounters } from "../render/performance.ts";
import { emptyRendererConfiguration, printRendererGfxInfo, RendererConfiguration } from "../render/configuration.ts";
import type { ConfiguredRenderer, RendererConfigurationSnapshot } from "../render/configuration.ts";
import { SoftwareRenderer } from "../render/cpu/rasterizer.ts";
import { CpuTriangleExecution } from "../render/cpu/triangle-execution.ts";
import { GlRenderer } from "../render/gl/renderer.ts";
import { GlCallLogging } from "../render/gl/logging.ts";
import { ThreadedBackend } from "../render/threaded-backend.ts";
import { ThreadedCommandBridge } from "../render/threaded-command-runtime.ts";
import { ThreadedGlRenderer, ThreadedRendererBackend, ThreadedSoftwareRenderer } from "../render/threaded-backend-proxy.ts";
import { wireInteger, wireRecord, wireString } from "../render/threaded-backend-protocol.ts";
import type { ShaderCinematicSource } from "../render/cinematic-command.ts";
import { RendererImageCatalog } from "../render/image-resource.ts";
import { RegisteredRendererCvars, SourceRendererSettings, rendererVideoMode, printRendererVideoModes } from "../render/settings.ts";
import { SourceTessState } from "../render/tess-state.ts";
import type { TextureFilter } from "../render/types.ts";
import { RendererResources } from "../render/world.ts";
import type { ServerPacketAddress } from "../server/net-channel.ts";
import { PlayerStateRecord } from "../shared/player-state.ts";
import type { SourcePlayerState } from "../shared/player-state.ts";
import { BaseUiCvars } from "../ui/base/cvars.ts";
import { BaseUiGameInfo } from "../ui/base/game-info.ts";
import { BaseUiState } from "../ui/base/state.ts";
import { BaseUi } from "../ui/base/ui.ts";
import { UiMenuCommand } from "../ui/public.ts";
import type { UiRuntimeAudio } from "../ui/runtime.ts";
import { TeamArenaUi } from "../ui/team-arena/ui.ts";
import { EngineCinematics } from "./cinematics.ts";
import type { EngineSystemCinematics } from "./cinematics.ts";
import { ClientAdmission } from "./client-admission.ts";
import { ClientActiveState, getClientServerCommand } from "./client-active.ts";
import { ClientAuthorization } from "./client-authorization.ts";
import { ClientConsoleCommands } from "./client-console-commands.ts";
import { registerClientCvars } from "./client-cvars.ts";
import { ClientDemoRecording } from "./client-demo-recording.ts";
import { ClientDemoPlayback } from "./client-demo-playback.ts";
import { ClientDownloads } from "./client-download.ts";
import { ClientInput } from "./client-input.ts";
import { ClientKeys } from "./client-keys.ts";
import { acquireClientModule } from "./client-modules.ts";
import { ClientMotd } from "./client-motd.ts";
import { EngineClientSession, ClientSessionError } from "./client-session.ts";
import type { ClientPacketDelivery, ClientSessionMode } from "./client-session.ts";
import { ClientConnectionState, ClientStaticState } from "./client-state.ts";
import type { ClientPacketAddress } from "./client-state.ts";
import type { CommonClientBootstrap, CommonConsole, CommonEarlyServices } from "./common-console.ts";
import type { CommonEvents } from "./common-events.ts";
import type { CommonClientRuntime, CommonCommandFallbacks, CommonNeedCdCapability } from "./common-frame.ts";
import { EngineConsole } from "./console.ts";
import { EngineScreen } from "./screen.ts";
import type { EngineScreenPresentation } from "./screen.ts";
import { createEngineScreenDrawing } from "./screen-draw.ts";
import { ServerBrowser } from "./server-browser.ts";
import type { ServerEngine } from "./server-engine.ts";
import { EngineSound } from "./sound.ts";
import { aviFrameMilliseconds, EngineScreenshots } from "./screenshots.ts";
import type { SoundOutputOptions } from "./sound-output.ts";
import { EngineUiCinematics } from "./ui-cinematics.ts";
import { QvmUi } from "./qvm-ui.ts";
import { QvmCgame } from "./qvm-cgame.ts";
import { qvmCommonSyscall } from "../vm/common-syscalls.ts";
import { qvmFilesystemSyscall } from "../vm/filesystem-syscalls.ts";
import { qvmRenderResourceSyscall } from "../vm/render-resource-syscalls.ts";
import { qvmRenderSceneSyscall } from "../vm/render-scene-syscalls.ts";
import { qvmSoundSyscall } from "../vm/sound-syscalls.ts";
import { qvmClientStateSyscall } from "../vm/client-state-syscalls.ts";
import { qvmKeySyscall } from "../vm/key-syscalls.ts";
import { qvmCinematicSyscall } from "../vm/cinematic-syscalls.ts";
import { qvmFontSyscall } from "../vm/font-syscalls.ts";
import { qvmBrowserSyscall } from "../vm/browser-syscalls.ts";
import { qvmUiKeySyscall } from "../vm/ui-key-syscalls.ts";
import { qvmScriptSyscall } from "../vm/script-syscalls.ts";
import { qvmCollisionSyscall } from "../vm/collision-syscalls.ts";
import { qvmRenderWorldSyscall } from "../vm/render-world-syscalls.ts";
import { qvmMarkSyscall } from "../vm/mark-syscalls.ts";
import { qvmRealTimeSyscall } from "../vm/real-time-syscalls.ts";
import { QvmMemory } from "../vm/memory.ts";
import type { QvmSyscall } from "../vm/interpreter.ts";

export interface EngineClientOptions {
  readonly renderer: "cpu" | "gl";
  readonly width: number;
  readonly height: number;
  readonly hidden: boolean;
  readonly sound: SoundOutputOptions;
  readonly buildDate: string;
  readonly systemClock: SystemClock;
}
export interface EngineClientServices {
  readonly common: CommonConsole;
  readonly events: CommonEvents;
  readonly loopback: LoopbackTransport;
  readonly io: UnixIo;
  readonly server: ServerEngine;
  assertCurrentOperation(): void;
  runRendererCallback<T>(callback: () => T): T;
  pumpForDownloadsComplete(): Promise<void>;
}
interface Graphics {
  readonly presentation: EngineScreenPresentation;
  readonly resources: RendererResources;
  readonly commands: RenderCommandBuffer;
  readonly target: RenderTarget;
}
interface ExternalCgameContext {
  models: SourceClipModels | null;
}
function connected(state: ClientStaticState): boolean {
  return state.phase === "connected" || state.phase === "loading" || state.phase === "primed"
    || state.phase === "active" || state.phase === "cinematic";
}

/** Common owns execution; this client owns static, connection and level lifetimes. */
export class EngineClient implements CommonClientBootstrap, CommonClientRuntime {
  readonly clientStatic = new ClientStaticState();
  readonly clientActive = new ClientActiveState(text => {
    if (this.cvar("developer").integerValue !== 0) this.print(text);
  });
  readonly needCd: CommonNeedCdCapability = { kind: "available", show: async () => {
    this.entry(); this.cdDialog = true;
  } };
  private early: CommonEarlyServices | null = null;
  private services: EngineClientServices | null = null;
  private keyOwner: ClientKeys | null = null;
  private readonly clipboard = { kind: "available", read: () => {
    this.entry();
    return readSdlClipboard();
  } } satisfies FieldClipboard;
  private consoleOwner: EngineConsole | null = null;
  private inputOwner: ClientInput | null = null;
  private screenOwner: EngineScreen | null = null;
  private soundOwner: EngineSound | null = null;
  private browserOwner: ServerBrowser | null = null;
  private consoleCommands: ClientConsoleCommands | null = null;
  private connection = new ClientConnectionState();
  private admission: ClientAdmission | null = null;
  private authorization: ClientAuthorization | null = null;
  private motd: ClientMotd | null = null;
  private session: EngineClientSession | null = null;
  private remoteAddress: ClientPacketAddress | null = null;
  private level: ClientLevel | QvmCgame | null = null;
  private ui: BaseUi | TeamArenaUi | QvmUi | null = null;
  private window: SdlWindow | null = null;
  private windowStencilBits = 0;
  private windowAspect = 1;
  private videoSettingsRegistered = false;
  private rendererInterfaceInitialized = false;
  private sdlInput: SdlGameInput | null = null;
  private sourceInput: SourceInputState | null = null;
  private midiInput: SourceMidiInput | null = null;
  private glLogging: GlCallLogging | null = null;
  private cpuExecution: CpuTriangleExecution | null = null;
  private backend: ConfiguredRenderer | null = null;
  private builtins: BuiltinImages | null = null;
  private graphics: Graphics | null = null;
  private registeredRendererCommands: RenderCommandBuffer | null = null;
  private rendererCommandBridge: ThreadedCommandBridge | null = null;
  private rendererCommandCleanupPending = false;
  private readonly renderTimings = { frontEndMsec: 0, backEndMsec: 0 };
  private rendererConfiguration: RendererConfigurationSnapshot | null = null;
  private rendererInfo: RendererConfigurationSnapshot;
  private cinematicOwner: EngineCinematics | null = null;
  private systemCinematics: EngineSystemCinematics | null = null;
  private readonly graphicsCleanup: (() => void)[] = [];
  private soundStarted = false;
  private soundRegistered = false;
  private shutdownRecursive = false;
  private disposed = false;
  private timeoutCount = 0;
  private cdDialog = false;
  private textureFilter: TextureFilter = "linear-mipmap-nearest";
  private readonly shutdownContext = new AsyncLocalStorage<boolean>();
  private emptyPlayerState: SourcePlayerState | null = null;
  private readonly calendar = new UnixSystemClock();
  private screenshots: EngineScreenshots | null = null;

  constructor(private readonly options: EngineClientOptions) {
    this.rendererInfo = emptyRendererConfiguration(options.renderer);
  }
  get input(): SdlGameInput | null { return this.sdlInput; }
  get systemInput(): SourceInputState | null { return this.sourceInput; }
  private required<T>(value: T | null, name: string): T {
    if (value === null) throw new Error(`Client requires initialized ${name}`);
    return value;
  }
  private get common(): CommonConsole { return this.required(this.services, "common services").common; }
  private get keys(): ClientKeys { return this.required(this.keyOwner, "keys"); }
  private get console(): EngineConsole { return this.required(this.consoleOwner, "console"); }
  private get sound(): EngineSound { return this.required(this.soundOwner, "sound"); }
  private get screen(): EngineScreen { return this.required(this.screenOwner, "screen"); }
  get frameTimings(): Readonly<typeof this.renderTimings> { return this.renderTimings; }
  private entry(): undefined {
    if (this.disposed) throw new Error("Client resources are disposed");
    if (this.shutdownContext.getStore() === true) this.required(this.early, "early common services").assertOwnerEntry();
    else if (this.services !== null) this.services.assertCurrentOperation();
    else this.required(this.early, "early common services").assertOwnerEntry();
  }
  private print(text: string): undefined {
    this.required(this.early, "early common services").output.print(text); this.entry();
  }
  private cvar(name: string): CvarSnapshot {
    const value = this.required(this.early, "early common services").cvars.get(name);
    if (value === undefined) throw new Error(`Client requires registered cvar ${name}`);
    return value;
  }
  private requireUi(): BaseUi | TeamArenaUi | QvmUi { return this.required(this.ui, "product UI"); }
  private scaledMilliseconds(): number {
    const value = Math.fround(Math.fround(this.options.systemClock.milliseconds()) * Math.fround(this.cvar("timescale").numericValue));
    if (!Number.isFinite(value) || value < -2147483648 || value >= 2147483648)
      throw new RangeError("Undefined native scaled milliseconds conversion");
    return Math.trunc(value) + 0;
  }
  private snapshotPlayerState(): SourcePlayerState {
    const playerState = this.clientActive.history.readCurrentPlayerState();
    if (playerState !== null) return playerState;
    const product = this.common.roots.product;
    if (this.emptyPlayerState === null || this.emptyPlayerState.product !== product)
      this.emptyPlayerState = new PlayerStateRecord<number, number, number>(product, 0, 0, 0);
    return this.emptyPlayerState;
  }

  initializeKeyCommands(services: CommonEarlyServices): void {
    if (this.early !== null) throw new Error("Client key bootstrap already ran");
    this.early = services; this.entry();
    this.keyOwner = new ClientKeys({ commands: services.commands, cvars: services.cvars,
      print: text => this.print(text), host: {
        readConnection: () => ({ kind: this.clientStatic.phase, demoPlayback: this.connection.demoPlaying }),
        readUi: () => this.ui, readCgame: () => this.level, assertCurrentOperation: () => this.entry(),
        disconnect: () => this.disconnect(true), stopAllSounds: () => { this.sound.stopAllSounds(); this.entry(); },
        addReliableCommand: text => { this.addReliableCommand(text); }, toggleConsole: () => this.console.toggle(),
        updateScreen: async () => { await this.screen.update(); this.entry(); },
        consoleScroll: action => this.console.scroll(action), readConsoleWidth: () => this.console.fieldWidth,
        clipboard: this.clipboard,
      } });
    this.consoleOwner = new EngineConsole({ state: this.clientStatic, keys: this.keys, cvars: services.cvars,
      commands: services.commands, output: services.output, host: {
        assertCurrentOperation: () => this.entry(), startDemoLoop: async () => { this.startDemoLoop(); },
        readCgame: () => this.level, snapshotMoveType: () => this.snapshotPlayerState().pmType,
        writableFiles: () => this.common.files.writable, version: `Q3 1.32b ${this.options.buildDate}`,
      } });
    this.keys.initializeCommands();
  }
  writeBindings(write: (text: string) => undefined): void { this.keys.writeBindings(write); }
  usesUniqueKey(): number | Promise<number> { this.entry(); return this.ui === null ? 0 : this.ui.usesUniqueKey(); }
  consolePrint(text: string): void { this.console.print(text); }

  initializeInput(): void {
    this.entry();
    if (this.sourceInput !== null) throw new Error("System input already initialized");
    const early = this.required(this.early, "early common services");
    this.sourceInput = new SourceInputState({ cvars: early.cvars, print: text => this.print(text) });
    this.sourceInput.initialize();
    this.midiInput = new SourceMidiInput({ cvars: early.cvars, print: text => this.print(text) });
    this.midiInput.initialize();
    early.commands.register("midiinfo", () => { this.entry(); this.required(this.midiInput, "MIDI input").info(); });
  }

  restartInput(): void {
    this.entry();
    this.required(this.sourceInput, "system input").restart();
    this.required(this.midiInput, "MIDI input").restart();
  }

  pollMidiInput(unix: UnixIo): void {
    this.midiInput?.frame((key, down, time) => { unix.queueEvent({ kind: "key", key, down, time }); });
  }

  bind(services: EngineClientServices): void {
    this.entry();
    if (this.services !== null) throw new Error("Client services are already bound");
    if (services.common.commands !== this.early?.commands || services.common.cvars !== this.early.cvars)
      throw new Error("Graphical client must borrow its actual early common owners");
    this.services = services;
    this.soundOwner = new EngineSound(services.common, services.events);
    this.browserOwner = new ServerBrowser({ clientStatic: this.clientStatic, cvars: this.common.cvars,
      io: services.io, loopback: services.loopback, print: text => this.print(text), assertCurrentOperation: () => this.entry() });
    this.consoleCommands = new ClientConsoleCommands({ common: this.common, clientStatic: this.clientStatic,
      io: services.io, loopback: services.loopback, readConnection: () => this.connection, readSession: () => this.session,
      readRemoteAddress: () => this.remoteAddress, assertCurrentOperation: () => this.entry() });
    this.resetConnection();
  }

  async initialize(): Promise<void> {
    this.entry(); this.print("----- Client Initialization -----\n");
    this.common.hunk.attachClient({
      shutdownCGame: () => this.shutdownCgame(),
      shutdownUi: () => this.shutdownUi(),
      closeAllVideos: () => { this.entry(); this.cinematicOwner?.closeAllVideos(); this.entry(); },
      clearVm: () => this.clearVm(),
    });
    this.screenshots ??= new EngineScreenshots({ kind: "source-hunk", accounting: this.common.hunk.accounting });
    if (this.authorization === null) this.resetConnection();
    this.console.initialize();
    this.clientActive.clear();
    this.clientStatic.phase = "disconnected"; this.clientStatic.realtime = 0;
    this.inputOwner = new ClientInput({ commands: this.common.commands, cvars: this.common.cvars,
      print: text => this.print(text), readKeys: () => this.keys.inputState,
      readDeltaAngles: () => this.snapshotPlayerState().deltaAngles,
      mouseToUi: (dx, dy) => this.requireUi().mouseEvent(dx, dy),
      mouseToCgame: (dx, dy) => this.required(this.level, "cgame").mouseEvent(dx, dy),
      debugGraph: (value, color) => this.screen.debugGraph(value, color) });
    this.inputOwner.initializeCommands();
    registerClientCvars(this.common.cvars);
    this.registerCommands();
    this.initializeRendererInterface();
    this.screenOwner = new EngineScreen({ cvars: this.common.cvars, keys: this.keys, console: this.console,
      frameTimings: this.renderTimings,
      sound: this.sound, readPresentation: () => this.graphics?.presentation ?? null,
      readUi: () => this.ui, readCgame: () => this.level, readSession: () => this.session,
      readConnection: () => this.connection, print: text => this.print(text), assertCurrentOperation: () => this.entry() });
    this.screen.initialize();
    await this.common.commands.executeAsync(); this.entry();
    this.common.cvars.set("cl_running", "1", true);
    this.print("----- Client Initialization Complete -----\n");
  }

  private registerCommands(): void {
    const commands = this.common.commands, console = this.required(this.consoleCommands, "client console commands");
    commands.register("cmd", context => console.forwardToServer(context));
    commands.register("configstrings", context => console.configstrings(context));
    commands.register("clientinfo", context => console.clientinfo(context));
    commands.registerAsync("snd_restart", async () => { this.sound.shutdown(); this.sound.initialize(this.options.sound); await this.restartVideo(); });
    commands.registerAsync("vid_restart", () => this.restartVideo());
    commands.register("disconnect", () => {
      this.entry(); this.systemCinematics?.stop(); this.entry();
      this.common.cvars.set("ui_singlePlayerActive", "0", true);
      if (this.clientStatic.phase !== "disconnected" && this.clientStatic.phase !== "cinematic")
        throw new CommonError("disconnect", "Disconnected from server");
    });
    commands.register("record", context => { this.required(this.connection.demoRecording, "demo recorder").record(context); });
    commands.registerAsync("demo", context => this.playDemo(context));
    commands.registerAsync("cinematic", async context => {
      if (context.argv.length < 2) { this.print("cinematic <file> [1|2]\n"); return; }
      await this.required(this.systemCinematics, "cinematics").play(context.argv[1] ?? "", context.argv[2] ?? ""); this.entry();
    });
    commands.register("stoprecord", () => { this.required(this.connection.demoRecording, "demo recorder").stop(); });
    commands.registerAsync("connect", context => this.connect(context));
    commands.register("reconnect", () => {
      this.entry();
      if (this.clientStatic.servername === "" || this.clientStatic.servername === "localhost") {
        this.print("Can't reconnect to localhost.\n"); return;
      }
      this.common.cvars.set("ui_singlePlayerActive", "0", true);
      this.common.commands.append(`connect ${this.clientStatic.servername}\n`);
    });
    commands.register("localservers", () => { this.required(this.browserOwner, "server browser").localServers(); });
    commands.registerAsync("globalservers", context => this.required(this.browserOwner, "server browser").globalServersCommand(context));
    commands.registerAsync("rcon", context => console.rcon(context));
    commands.register("setenv", context => console.setenv(context));
    commands.registerAsync("ping", context => this.required(this.browserOwner, "server browser").pingCommand(context));
    commands.registerAsync("serverstatus", context => this.required(this.browserOwner, "server browser").serverStatusCommand(context, this.connection));
    commands.register("showip", () => { this.entry(); this.required(this.services, "services").io.lan.showIp(text => this.print(text)); });
    commands.register("fs_openedList", context => console.openedPakList(context));
    commands.register("fs_referencedList", context => console.referencedPakList(context));
    commands.register("model", context => console.setModel(context));
  }

  resolveCommand(_lookup: CommandLookup, fallbacks: CommonCommandFallbacks): ResolvedCommandHandler | undefined {
    if (this.consoleCommands === null) return fallbacks.server;
    return { kind: "async", handler: async context => {
      this.entry();
      if (this.level !== null && await this.level.consoleCommand(context.argv)) { this.entry(); return; }
      this.entry();
      if (this.common.cvars.get("sv_running")?.integerValue !== 0
        && await runCalls(this.required(this.services, "services").server.gameConsoleCommand(context))) { this.entry(); return; }
      if (this.ui !== null && await this.ui.consoleCommand(context)) { this.entry(); return; }
      this.entry(); this.required(this.consoleCommands, "client console commands").forwardCommand(context);
    } };
  }

  private assets(): SoundAssetReader & RetainedFileReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> {
    return { has: path => this.common.files.current.has(path), list: prefix => this.common.files.current.list(prefix),
      read: path => this.common.files.current.read(path), readSync: path => this.common.files.current.readSync(path),
      readFileLength: path => {
        this.entry(); const length = this.common.files.current.readFileLength(path); this.entry(); return length;
      },
      readFileOptional: async path => {
        this.entry(); const bytes = await this.common.files.current.readFileOptional(path); this.entry(); return bytes;
      },
      readFileRetained: async path => {
        this.entry(); const buffer = await this.common.files.current.readFileRetained(path); this.entry(); return buffer;
      },
      readFileRetainedSync: path => {
        this.entry(); const buffer = this.common.files.current.readFileRetainedSync(path); this.entry(); return buffer;
      },
      freeFile: buffer => { this.entry(); this.common.files.current.freeFile(buffer); this.entry(); },
    };
  }
  private uiAudio(): UiRuntimeAudio {
    return {
      playLocal: sound => {
        this.entry();
        if (!this.sound.started || this.sound.muted) return;
        const pcm = typeof sound === "number" ? this.sound.bank.soundForIndex(sound) : sound;
        if (typeof sound === "number" && pcm === undefined) return;
        this.sound.startLocalSound(pcm ?? null, 6); this.entry();
      },
      startBackground: async path => { this.entry(); await this.sound.startBackgroundTrack(path, path); this.entry(); },
      stopBackground: () => { this.entry(); this.sound.stopBackgroundTrack(); this.entry(); },
    };
  }
  async startHunkUsers(): Promise<void> {
    this.entry(); if (this.cvar("cl_running").integerValue === 0) return;
    this.common.validateGameDirectory();
    if (this.graphics === null) await this.initializeRenderer();
    this.entry();
    if (!this.soundStarted) { this.soundStarted = true; this.sound.initialize(this.options.sound); this.entry(); }
    if (!this.soundRegistered) { this.soundRegistered = true; await this.sound.beginRegistration(); this.entry(); }
    if (this.ui === null) {
      const module = acquireClientModule({ files: this.common.files.current, product: this.common.roots.product, role: "ui", registry: this.common.vm,
        print: text => this.print(text), hunk: { kind: "source-hunk", accounting: this.common.hunk.accounting } });
      if (module === null) throw new CommonError("fatal", "VM_Create on UI failed");
      const graphics = this.required(this.graphics, "graphics");
      let ui: BaseUi | TeamArenaUi | QvmUi;
      if (module.mode === "registered") {
        const registered = QvmUi.registered(module.registration) ?? BaseUi.registered(module.registration) ?? TeamArenaUi.registered(module.registration);
        if (registered === null) throw new CommonError("fatal", "UI VM has not published a callable owner");
        ui = registered;
      } else if (module.mode === "bytecode") {
        ui = new QvmUi(module.image, call => this.uiSystemCall(call, graphics), this.clientStatic, () => this.entry(),
          { kind: "source-hunk", accounting: this.common.hunk.accounting }, module.registration);
        module.releaseImage();
        ui.loadSymbols({ developer: this.cvar("developer").integerValue, files: this.common.files.current, print: text => this.print(text) });
        module.completeLoading();
      } else if (module.product === "missionpack") {
        ui = new TeamArenaUi({ common: this.common, keys: this.keys, productProfile: this.common.productProfile,
          scriptSources: () => this.required(this.services, "services").server.scriptSources(),
          browser: this.required(this.browserOwner, "server browser"), events: this.required(this.services, "services").events,
          systemClock: this.options.systemClock, calendar: this.calendar, configuration: graphics.presentation.configuration,
          renderer: graphics.resources, commands: graphics.commands, sound: this.sound, audio: this.uiAudio(),
          cinematics: new EngineUiCinematics(this.required(this.cinematicOwner, "cinematics"), "ui"),
          readSession: () => this.session, readRealTime: () => this.clientStatic.realtime,
          readClient: () => ({
            readSnapshotClientNumber: () => { this.entry(); return this.clientActive.readSnapshotClientNumber(); },
            getConfigString: index => { this.entry(); return this.clientActive.getConfigString(index); },
          }), assertCurrentOperation: () => this.entry() }, module.registration);
      } else {
        const state = new BaseUiState({ cvars: new BaseUiCvars(this.common.cvars, () => this.entry()), keys: this.keys,
          clipboard: this.clipboard, resources: graphics.resources, commands: graphics.commands,
          consoleCommands: this.common.commands, sounds: this.sound.bank, audio: this.sound,
          hardware: this.rendererInfo.hardwareType === "ragepro" ? "ragepro" : "generic",
          readClientPhase: () => this.clientStatic.phase, print: text => this.print(text), assertCurrentOperation: () => this.entry() });
        ui = new BaseUi({ state, gameInfo: new BaseUiGameInfo(state, this.common.files), files: this.common.files,
          cdKey: this.common.cdKey, commands: this.common.commands, hunk: this.required(this.common.hunk.arena, "common hunk"),
          browser: this.required(this.browserOwner, "server browser"), configuration: graphics.presentation.configuration,
          readSession: () => this.session }, module.registration);
      }
      this.ui = ui;
      if (!(ui instanceof QvmUi)) ui.apiVersion();
      await ui.initialize(); this.entry();
    }
  }

  private uiSystemCall(call: QvmSyscall, graphics: Graphics): number | Promise<number> {
    this.entry();
    const { words } = call, memory = new QvmMemory(call.memory), trap = words.getInt32(0, true);
    if (trap === 28) return this.screen.update().then(() => 0);
    if (trap === 42) {
      const bytes = this.clipboard.read();
      if (bytes === null) memory.view(words.getInt32(4, true), 1).setUint8(0, 0);
      else qStrncpyz(memory.pointer(words.getInt32(4, true)), bytes, words.getInt32(8, true));
      return 0;
    }
    if (trap === 52) return this.common.hunk.accounting.memoryRemaining();
    if (trap >= 57 && trap <= 61) {
      const sources = this.required(this.services, "services").server.scriptSources();
      const result = qvmScriptSyscall("ui", words, memory, sources);
      if (result !== null) return result;
    }
    const result = this.clientSystemCall("ui", words, memory, graphics)
      ?? qvmBrowserSyscall("ui", words, memory, {
        browser: this.required(this.browserOwner, "server browser"), files: this.common.files,
        events: this.required(this.services, "services").events,
      }) ?? qvmUiKeySyscall("ui", words, memory, this.common.cdKey, () => {
        const ui = this.ui;
        return ui === null ? 0 : ui.usesUniqueKey();
      });
    if (result === null) throw new CommonError("drop", `Bad UI system trap: ${trap}`);
    return result;
  }

  private clientSystemCall(role: "ui" | "cgame", words: DataView, memory: QvmMemory, graphics: Graphics): number | Promise<number> | null {
    const client = this;
    return qvmCommonSyscall(role, words, memory, {
      commands: this.common.commands, output: this.common.output, clock: this.options.systemClock, cvars: this.common.cvars,
    }) ?? qvmRealTimeSyscall(role, words, memory, this.calendar)
      ?? qvmFilesystemSyscall(role, words, memory, this.common.files)
      ?? qvmRenderResourceSyscall(role, words, memory, graphics.resources, graphics.commands)
      ?? qvmRenderSceneSyscall(role, words, memory, graphics.resources)
      ?? qvmSoundSyscall(role, words, memory, { sound: this.sound, frameNumber: () => this.clientStatic.frameCount })
      ?? qvmClientStateSyscall(role, words, memory, {
        clientStatic: this.clientStatic, get connection() { return client.connection; },
        active: this.clientActive, getServerCommand: sequence => this.getServerCommand(sequence),
        configuration: () => this.required(this.rendererConfiguration, "client renderer configuration"),
      }) ?? qvmKeySyscall(role, words, memory, this.keys)
      ?? qvmCinematicSyscall(role, words, memory, {
        cinematics: this.required(this.cinematicOwner, "cinematics"), get draw() { return graphics.commands.draw2D("pixels"); },
        developerPrint: text => { if (this.cvar("developer").integerValue !== 0) this.print(text); },
      }) ?? qvmFontSyscall(role, words, memory, {
        fonts: graphics.resources.fonts, print: text => this.print(text), clearScene: () => { graphics.resources.clearScene(); },
      });
  }

  private cgameSystemCall(call: QvmSyscall, graphics: Graphics, context: ExternalCgameContext): number | Promise<number> {
    this.entry();
    const { words } = call, memory = new QvmMemory(call.memory), trap = words.getInt32(0, true);
    if (trap === 15 || trap === 72) {
      const name = memory.readString(words.getInt32(4, true));
      if (trap === 15) this.common.commands.registerFallbackName(name);
      else this.common.commands.unregister(name);
      return 0;
    }
    if (trap === 16) { this.addReliableCommand(memory.readString(words.getInt32(4, true))); return 0; }
    // The source deliberately does not pump events inside CG_UPDATESCREEN.
    if (trap === 17) return this.screen.update().then(() => 0);
    if (trap === 18) {
      const name = memory.readString(words.getInt32(4, true));
      context.models = new SourceClipModels(this.common.collision.load(name, true).world);
      this.entry();
      return 0;
    }
    if (trap === 19 || trap === 20 || (trap >= 22 && trap <= 26) || (trap >= 82 && trap <= 84)) {
      const result = qvmCollisionSyscall("cgame", words, memory, this.required(context.models, "cgame collision map"));
      if (result !== null) return result;
    }
    if (trap === 58) return this.common.hunk.accounting.memoryRemaining();
    if (trap >= 64 && trap <= 68) {
      const result = qvmScriptSyscall("cgame", words, memory, this.required(this.services, "services").server.scriptSources());
      if (result !== null) return result;
    }
    const result = this.clientSystemCall("cgame", words, memory, graphics)
      ?? qvmMarkSyscall("cgame", words, memory, graphics.resources)
      ?? qvmRenderWorldSyscall("cgame", words, memory, graphics.resources, {
        clusterPVS: cluster => this.required(context.models, "cgame collision map").world.clusterPVS(cluster),
      });
    if (result === null) throw new CommonError("drop", `Bad cgame system trap: ${trap}`);
    return result;
  }

  private initializeRendererInterface(): void {
    this.print("----- Initializing Renderer ----\n");
    this.print("-------------------------------\n");
    this.rendererInterfaceInitialized = true;
    this.common.cvars.set("cl_paused", "0", true);
    this.entry();
  }

  private async initializeRenderer(): Promise<void> {
    this.entry();
    if (!this.rendererInterfaceInitialized) throw new Error("Renderer interface has not initialized");
    if (this.graphicsCleanup.length !== 0) throw new Error("Renderer startup must retire its preceding partial lifetime");
    this.print("----- R_Init -----\n");
    const tess = new SourceTessState(new RendererPerformanceCounters());
    const commandStorage = new RendererCommandStorage(() => this.common.hunk.accounting.rendererBackend(tess.frontEndSmpFrame), "source");
    const images = new RendererImageCatalog(this.textureFilter,
      { kind: "source-hunk", accounting: this.common.hunk.accounting });
    let renderer: ConfiguredRenderer | null = null;
    let configuration: RendererConfiguration | null = null;
    let resources: RendererResources | null = null;
    let commands: RenderCommandBuffer | null = null;
    let thread: ThreadedBackend | null = null;
    let threadedBackend: ThreadedRendererBackend | null = null;
    let bridge: ThreadedCommandBridge | null = null;
    // R_Init clears these tables before R_Register; each real registry replaces its empty table below.
    let listShaders: RendererResources["listShaders"] = (_sorted, print) => {
      print("-----------------------\n"); print("0 total shaders\n"); print("------------------\n");
    };
    let listModels: RendererResources["listModels"] = print => { print("       0 : Total models\n"); };
    let listSkins: RendererResources["listSkins"] = print => { print("------------------\n"); print("------------------\n"); };
    let active = true;
    const rendererEntry = (): undefined => {
      this.entry();
      if (!active || renderer !== this.backend) throw new Error("Client renderer has retired");
    };
    const printRenderer = (text: string): undefined => {
      rendererEntry(); this.print(text); rendererEntry();
    };
    this.graphicsCleanup.push(() => {
      active = false; commandStorage.discardReferences();
      if (this.rendererCommandCleanupPending) this.unregisterRendererCommands();
    });
    const client = this;
    const screenshotGraphics = {
      get commands() { rendererEntry(); return commands ?? commandStorage; },
      get renderer() { rendererEntry(); return client.required(renderer, "renderer backend"); },
      get configuration() { rendererEntry(); return client.required(configuration, "renderer configuration"); },
      get width() { return client.rendererInfo.vidWidth; },
      get height() { return client.rendererInfo.vidHeight; },
      get worldBaseName() { return resources?.worldBaseName ?? null; },
    };
    const registered = new RegisteredRendererCvars(this.common.cvars, process.platform === "linux" ? "linux" : "other", this.videoSettingsRegistered ? null : this.options, text => this.print(text));
    for (const [name, value] of [["vid_screen", "-1"], ["r_minDisplayRefresh", "0"], ["r_maxDisplayRefresh", "0"],
      ["vid_xpos", "3"], ["vid_ypos", "22"]] satisfies readonly (readonly [string, string])[])
      this.common.cvars.register(name, value, CvarFlag.Archive);
    this.common.cvars.register("r_checkGLErrors", "0");
    this.common.cvars.register("r_enablerender", "1");
    this.videoSettingsRegistered = true;
    const register = (name: string, handler: CommandHandler): void => {
      if (this.common.commands.registeredNames().includes(name)) {
        printRenderer(`Cmd_AddCommand: ${name} already defined\n`);
        return;
      }
      this.common.commands.register(name, handler);
    };
    this.rendererCommandCleanupPending = true;
    register("toggle_renderer", () => {
      rendererEntry();
      this.common.cvars.set("r_enablerender", this.cvar("r_enablerender").integerValue === 0 ? "1" : "0", true);
    });
    register("imagelist", () => { rendererEntry(); images.listImages(printRenderer); });
    register("shaderlist", context => {
      rendererEntry(); listShaders(context.argv.length > 1, printRenderer);
    });
    register("skinlist", () => {
      rendererEntry(); listSkins(printRenderer);
    });
    register("modellist", () => {
      rendererEntry(); listModels(printRenderer);
    });
    register("modelist", () => { rendererEntry(); printRendererVideoModes(printRenderer); });
    register("screenshot", context => {
      rendererEntry();
      this.required(this.screenshots, "screenshots").command(context, screenshotGraphics, this.common.files.writable, printRenderer);
    });
    register("screenshotJPEG", context => {
      rendererEntry();
      this.required(this.screenshots, "screenshots").command(context, screenshotGraphics, this.common.files.writable, printRenderer, "jpeg");
    });
    register("gfxinfo", () => {
      rendererEntry();
      if (configuration === null) printRendererGfxInfo(this.common.cvars, {
        configuration: () => this.rendererInfo, overbrightBits: () => 0, assertCurrent: rendererEntry,
      }, printRenderer);
      else configuration.printGfxInfo(this.common.cvars, printRenderer);
    });
    this.common.hunk.accounting.initializeRendererBackend({ maxPolys: Math.max(600, this.cvar("r_maxpolys").integerValue),
      maxPolyVertices: Math.max(3000, this.cvar("r_maxpolyverts").integerValue) }, this.cvar("r_smp").integerValue !== 0);
    tess.frontEndSmpFrame = this.cvar("r_smp").integerValue !== 0 ? 1 : 0;
    tess.frontEndMemory = this.required(this.common.hunk.accounting.rendererBackend(tess.frontEndSmpFrame), "selected renderer backend storage");
    tess.frontEndMemory.commandsData().setInt32(SOURCE_BACKEND_RELEASE32.commandBytes, 0, true);
    // R_Register's Linux default, consumed by GLimp_SetMode before creating the visual.
    const stencilBits = Math.trunc(this.cvar("r_stencilbits").numericValue);
    const initializingGl = this.window === null && this.options.renderer === "gl";
    if (this.window === null) {
      this.required(this.services, "services").io.initializeSignals(() => {
        this.window?.close(); this.window = null;
      });
      let fullscreen = this.cvar("r_fullscreen").integerValue !== 0;
      if (fullscreen && this.common.cvars.register("in_nograb", "0").numericValue !== 0) {
        this.print("Fullscreen not allowed with in_nograb 1\n");
        this.common.cvars.set("r_fullscreen", "0", true); this.common.cvars.clearModified("r_fullscreen"); fullscreen = false;
      }
      const requestedMode = this.cvar("r_mode").integerValue;
      const open = (mode: number, driver?: string): SdlWindow => {
        const video = rendererVideoMode(this.common.cvars, mode);
        if (video === null) throw new Error(`Invalid renderer video mode ${mode}`);
        // GLimp's R_GetModeInfo publishes these fields before opening the display.
        this.rendererInfo = { ...this.rendererInfo, vidWidth: video.width, vidHeight: video.height, windowAspect: video.windowAspect };
        const dimensions = { title: "Quake III Arena", width: video.width, height: video.height,
          hidden: this.options.hidden, fullscreen, displayRefresh: this.cvar("r_displayRefresh").integerValue,
          displayIndex: this.cvar("vid_screen").integerValue,
          minDisplayRefresh: this.cvar("r_minDisplayRefresh").integerValue,
          maxDisplayRefresh: this.cvar("r_maxDisplayRefresh").integerValue,
          position: { x: this.cvar("vid_xpos").integerValue, y: this.cvar("vid_ypos").integerValue } };
        const window = this.options.renderer === "cpu" ? SdlWindow.open({ ...dimensions, backend: "cpu" })
          : SdlWindow.open({ ...dimensions, backend: "gl", ...(driver === undefined ? {} : { driver }), allowSoftwareGl: this.cvar("r_allowSoftwareGL").integerValue !== 0,
            stereo: this.cvar("r_stereo").integerValue !== 0, stencilBits,
            colorBits: this.cvar("r_colorbits").numericValue, depthBits: this.cvar("r_depthbits").numericValue });
        this.windowAspect = video.windowAspect;
        return window;
      };
      const openModes = (driver?: string): SdlWindow => {
        try { return open(requestedMode, driver); }
        catch (error) {
          if (requestedMode === 3) throw error;
          this.print(`...WARNING: could not set the given mode (${requestedMode}); trying mode 3\n`);
          try { return open(3, driver); }
          catch (fallback) { throw new AggregateError([error, fallback], "Renderer video initialization failed", { cause: error }); }
        }
      };
      this.window = this.options.renderer === "gl" ? openUnixGlDriver(this.common.cvars, driver => openModes(driver)) : openModes();
      if (this.window.fullscreenFailure !== null)
        this.print(`SDL fullscreen unavailable: ${this.window.fullscreenFailure}; continuing windowed\n`);
      this.windowStencilBits = stencilBits;
      this.sdlInput = SdlGameInput.open({ window: this.window, unix: this.required(this.services, "services").io,
        source: this.required(this.sourceInput, "system input"),
        cvars: this.common.cvars, keys: this.keys, clock: this.options.systemClock, print: text => this.print(text) });
    }
    const window = this.window;
    if (this.options.renderer === "gl" && this.glLogging === null) {
      this.glLogging = new GlCallLogging({ cvars: this.common.cvars,
        openLog: basePath => this.common.files.writable.openGlLog(NativeRoot.fromSource(basePath)),
        errorChecking: { enabled: () => this.cvar("r_checkGLErrors").integerValue !== 0,
          writeDiagnostic: text => this.print(text) },
        localCalendar: () => this.calendar.localCalendar(), print: text => this.print(text) });
    }
    const cinematics = new Map<number, ShaderCinematicSource>();
    const cinematicIds = new Map<ShaderCinematicSource, number>();
    const cinematicId = (source: ShaderCinematicSource): number => {
      const existing = cinematicIds.get(source);
      if (existing !== undefined) return existing;
      const id = cinematicIds.size + 1;
      cinematicIds.set(source, id); cinematics.set(id, source); return id;
    };
    if (this.cvar("r_smp").integerValue !== 0) {
      this.print("Trying SMP acceleration...\n");
      try {
        const initialization = this.options.renderer === "cpu"
          ? { kind: "cpu", ...window.drawableSize, textureFilter: this.textureFilter, subpixelBits: 8,
            stencilBits: this.windowStencilBits, alphaBits: 0 }
          : { kind: "gl", context: window.detachRenderContext(), textureFilter: this.textureFilter };
        const rendererServices = this.required(this.services, "services");
        thread = await ThreadedBackend.open(initialization, {
          request: payload => rendererServices.runRendererCallback(() => {
            if (typeof payload !== "object" || payload === null || !("kind" in payload) || typeof payload.kind !== "string")
              throw new TypeError("Invalid engine renderer callback");
            if (payload.kind === "backend-gl-log") {
              const message = wireRecord(payload), log = this.required(this.glLogging, "GL logging");
              switch (message["operation"]) {
                case "reset": log.resetCalls(); return { enabled: log.enabled, comments: log.commentEnabled };
                case "end-frame": log.endFrame(); return { enabled: log.enabled, comments: log.commentEnabled };
                case "state": return { enabled: log.enabled, comments: log.commentEnabled };
                case "call": log.call(wireString(message["text"])); return undefined;
                case "comment": log.comment(wireString(message["text"])); return undefined;
                case "error-enabled": return this.cvar("r_checkGLErrors").integerValue !== 0;
                case "error": {
                  const errors = this.required(log.errors, "GL error diagnostics");
                  errors.report(wireString(message["name"]), wireInteger(message["error"])); return undefined;
                }
                case "diagnostic": case "print": return this.print(wireString(message["text"]));
                default: throw new TypeError("Invalid GL logging callback");
              }
            }
            if (payload.kind.startsWith("source-")) return this.required(bridge, "renderer command bridge").request(payload);
            return this.required(threadedBackend, "threaded backend").handleHostRequest(payload, {
              cinematic: id => {
                const source = cinematics.get(id);
                if (source === undefined) throw new Error("Unknown renderer cinematic");
                return source;
              },
              print: text => this.print(text), textureMode: () => { throw new Error("Renderer texture mode callback has no active initializer"); },
              presentPixels: pixels => { window.present(pixels); },
            });
          }),
          completed: payload => rendererServices.runRendererCallback(() => this.required(bridge, "renderer command bridge").completed(payload)),
        });
        if (this.options.renderer === "cpu") {
          const backend = new ThreadedSoftwareRenderer(thread, images, thread.description, cinematicId);
          threadedBackend = backend; renderer = { kind: "cpu", backend };
        } else {
          const backend = new ThreadedGlRenderer(thread, images, thread.description, cinematicId, window);
          threadedBackend = backend; renderer = { kind: "gl", backend };
        }
      } catch {
        thread?.close(); thread = null; threadedBackend = null; renderer = null;
        if (this.options.renderer === "gl") window.restoreRenderContext();
      }
      this.entry();
      if (thread !== null && renderer?.kind === "gl") this.graphicsCleanup.push(() => window.restoreRenderContext());
      this.print(thread === null ? "...failed.\n" : "...succeeded.\n");
    }
    renderer ??= this.options.renderer === "cpu"
      ? { kind: "cpu", backend: new SoftwareRenderer(window.drawableSize.width, window.drawableSize.height, images, 8, this.windowStencilBits, 0,
        this.cpuExecution ??= new CpuTriangleExecution()) }
      : { kind: "gl", backend: new GlRenderer(window, images, this.glLogging) };
    this.backend = renderer;
    const target = new RenderTarget(images, [renderer.backend]);
    this.graphicsCleanup.push(() => { try { target.close(); } finally { bridge?.close(); } });
    if (initializingGl && renderer.kind === "gl") initializeUnixGlRenderer(this.common.cvars, renderer.backend.driver.renderer.replace(/\n$/, ""));
    const settings = new SourceRendererSettings(registered, renderer.backend.capabilities);
    configuration = RendererConfiguration.beginInitialization({ window, renderer, settings, windowAspect: this.windowAspect });
    if (initializingGl && renderer.kind === "gl" && settings.extensionSettings().allow)
      renderer.backend.initializeAppleTransformHint(() => this.common.cvars.register("r_appleTransformHint", "1", CvarFlag.Archive).integerValue !== 0,
        text => this.print(text));
    const currentConfiguration = configuration;
    this.graphicsCleanup.push(() => currentConfiguration.close());
    this.rendererInfo = configuration.copy();
    if (thread !== null && threadedBackend !== null) bridge = new ThreadedCommandBridge({ thread, backend: threadedBackend,
      settings, tess, clock: { milliseconds: () => this.scaledMilliseconds() }, performanceClock: this.options.systemClock,
      temporaryMemory: this.common.hunk.accounting.arena,
      identityLight: () => currentConfiguration.imageUploadProfile().colorMappings.identityLight,
      backendMaterials: () => this.required(resources, "renderer resources").backendMaterials,
      print: printRenderer, debugBuild: this.cvar("com_rendererDebug").integerValue !== 0,
      showSmp: () => this.cvar("r_showSmp").integerValue !== 0 });
    this.rendererCommandBridge = bridge;
    commands = new RenderCommandBuffer(target, { clock: { milliseconds: () => this.scaledMilliseconds() },
      performanceClock: this.options.systemClock, temporaryMemory: this.common.hunk.accounting.arena,
      commandStorage, identityLight: 0, tess, runtime: settings.runtime, print: printRenderer,
      ...(bridge === null ? {} : { thread: bridge }) });
    const currentCommands = commands;
    if (bridge !== null) {
      const currentBridge = bridge;
      this.graphicsCleanup.push(() => currentBridge.close());
    }
    this.graphicsCleanup.push(() => currentCommands.close("discard"));
    configuration.printGfxInfo(this.common.cvars, printRenderer);
    configuration.initializeDefaultState();
    configuration.initializeColorMappings(commands);
    const imageProfile = () => currentConfiguration.imageUploadProfile();
    this.builtins = new BuiltinImages(images, imageProfile);
    if (this.cinematicOwner === null) {
      this.cinematicOwner = new EngineCinematics({ files: { kind: "retained", current: () => this.common.files.current }, sound: { kind: "engine", owner: this.sound },
        temporaryMemory: this.common.hunk.accounting.arena,
        print: text => this.print(text),
        developerPrint: text => { if (this.cvar("developer").integerValue !== 0) this.print(text); },
        clock: { sample: () => Math.fround(Math.fround(this.scaledMilliseconds()) * Math.fround(this.cvar("timescale").numericValue)) },
        scratchImages: { scratchImage: index => this.required(this.builtins, "cinematic scratch images").scratchImage(index) },
        console: { kind: "available", close: () => this.console.close() }, settings: {
          inGameVideo: () => this.cvar("r_inGameVideo").integerValue,
          get hardware(): "ragepro" | "generic" { return client.rendererInfo.hardwareType === "ragepro" ? "ragepro" : "generic"; },
          get maxTextureSize(): number { const backend = client.required(client.backend, "cinematic renderer"); return backend.kind === "gl" ? backend.backend.maxTextureSize : 4096; },
        } });
      this.systemCinematics = this.cinematicOwner.attachSystem({
        state: () => this.clientStatic.phase === "cinematic" ? "cinematic" : "other",
        closeMenu: async () => { this.entry(); if (this.ui !== null) await this.ui.setActiveMenu(UiMenuCommand.None); this.entry(); },
        enterCinematic: () => { this.clientStatic.phase = "cinematic"; }, enterDisconnected: () => { this.clientStatic.phase = "disconnected"; },
        nextMap: () => this.common.cvars.get("nextmap")?.value ?? "", clearNextMap: () => { this.common.cvars.set("nextmap", "", true); },
        appendCommand: text => { this.common.commands.append(text); }, stopAllSounds: () => { this.sound.stopAllSounds(); },
      });
    }
    resources = await RendererResources.create(this.assets(), { kind: "source-hunk", accounting: this.common.hunk.accounting }, settings,
      { images, builtins: this.builtins, shaderCinematics: this.cinematicOwner.shaderCinematics, target, imageProfile,
        debugBuild: this.cvar("com_rendererDebug").integerValue !== 0,
        ...(bridge === null ? {} : { worldTransport: bridge.worldTransport }),
        tess, clock: this.options.systemClock,
        patchMemory: { kind: "source-zone", zone: this.common.mainZone },
        fontGeneration: {
          saveFontData: () => this.cvar("r_saveFontData").integerValue !== 0,
          writeFile: (name, bytes) => {
            this.entry();
            const opened = this.common.files.openByMode(name, "write");
            if (opened === undefined) return;
            this.common.files.writable.writeBytes(opened.file, bytes);
            this.common.files.closeFile(opened.file.slot);
          },
        },
        print: text => { this.entry(); return this.print(text); },
        publishListings: listings => {
          rendererEntry();
          if (listings.kind === "shaders") listShaders = listings.listShaders;
          else { listModels = listings.listModels; listSkins = listings.listSkins; }
        },
        drawDebugSurface: drawPoly => {
          this.entry();
          const mode = this.cvar("r_debugSurface").integerValue;
          if (mode === 1) this.common.collisionDebug.draw(drawPoly);
          else this.required(this.services, "services").server.drawBotDebugPolygons(drawPoly, mode);
        } });
    const currentResources = resources;
    this.graphicsCleanup.push(() => currentResources.fonts.close());
    this.entry();
    if (renderer.kind === "gl") {
      const error = renderer.backend.getError();
      if (error !== 0) this.print(`glGetError() = 0x${error.toString(16)}\n`);
    }
    this.print("----- finished R_Init -----\n");
    // RE_BeginRegistration publishes cls.glconfig only after R_Init succeeds.
    this.rendererConfiguration = configuration.copy();
    // Its R_SyncRenderThread still sees tr.registered == qfalse here.
    this.entry();
    resources.performance.viewCluster = -1;
    resources.tess.flares.clear();
    resources.clearScene();
    this.registeredRendererCommands = commands;
    commands.stretchPixels({ x: 0, y: 0, width: 0, height: 0 }, { s: 0, t: 0, s2: 1, t2: 1 }, resources.picture(null));
    const charset = resources.picture(await resources.registerShader("gfx/2d/bigchars")); this.entry();
    const white = resources.picture(await resources.registerShader("white")); this.entry();
    const console = resources.picture(await resources.registerShader("console")); this.entry();
    this.console.rendererInitialized(target.width);
    const drawing = createEngineScreenDrawing({ commands, resources, pictures: { charset, white, console }, state: this.clientStatic, keys: this.keys });
    this.graphics = { target, commands, resources, presentation: { drawing, renderer, window, configuration,
      cinematics: this.required(this.systemCinematics, "system cinematics") } };
    if (renderer.kind === "gl") renderer.backend.updateRenderingEnabled(this.cvar("r_enablerender").integerValue, text => this.print(text));
  }

  private resetConnection(): void {
    const services = this.required(this.services, "services");
    this.connection = new ClientConnectionState(); this.session = null; this.remoteAddress = null;
    const connection = this.connection;
    const guard = (): void => { this.entry(); if (connection !== this.connection) throw new Error("Client connection has retired"); };
    this.authorization ??= new ClientAuthorization({ cvars: this.common.cvars, cdKey: this.common.cdKey,
      io: services.io, print: text => this.print(text) });
    this.motd ??= new ClientMotd({ clientStatic: this.clientStatic, cvars: this.common.cvars,
      io: services.io, random: services.server.options.random, milliseconds: () => services.events.milliseconds(),
      rendererString: () => this.graphics?.presentation.configuration.copy().rendererString ?? "",
      print: text => this.print(text) });
    this.admission = new ClientAdmission({ clientStatic: this.clientStatic, clientConnection: connection,
      cvars: this.common.cvars, io: services.io, loopback: services.loopback,
      authorization: this.authorization, assertCurrentOperation: guard, print: text => this.print(text) });
    connection.downloads = new ClientDownloads({ files: this.common.files, cvars: this.common.cvars,
      connection, clientStatic: this.clientStatic, assertCurrentOperation: guard, print: text => this.print(text),
      addReliableCommand: text => this.addReliableCommand(text), writePacket: () => this.writePacket(),
      downloadsComplete: async () => {
        guard(); const session = this.required(this.session, "download session");
        await this.downloadsComplete(session.gamestateGeneration); this.entry();
        if (connection !== this.connection) return "retired";
        return;
      } });
    new ClientDemoRecording({ files: this.common.files, cvars: this.common.cvars, connection,
      session: () => this.session, print: text => this.print(text) });
    this.timeoutCount = 0;
  }
  private createSession(mode: ClientSessionMode): EngineClientSession {
    const connection = this.connection;
    const guard = (): void => { this.entry(); if (connection !== this.connection) throw new Error("Client connection has retired"); };
    return new EngineClientSession({ product: this.common.roots.product, mode, cvars: this.common.cvars,
      lifecycle: { sourceState: this.common.sourceState, clientStatic: this.clientStatic, clientConnection: connection, clientActive: this.clientActive, consoleCommands: this.common.commands,
        assertCurrentOperation: guard,
        print: text => this.print(text),
        milliseconds: () => this.required(this.services, "services").events.milliseconds(),
        applyServerPackages: info => this.applyServerPackages(info, guard),
        downloadSizeReceived: fileSize => this.required(connection.downloads, "download owner").publishSize(fileSize),
        downloadReceived: block => this.required(connection.downloads, "download owner").receive(block),
        gamestateReceived: async generation => {
          await this.initializeDownloads(generation); this.entry();
          if (connection !== this.connection) return "retired";
          return;
        },
        demoCompleted: async (_end, timing) => {
          if (timing !== null && timing.elapsedMilliseconds > 0) {
            const seconds = timing.elapsedMilliseconds / 1000, fps = timing.frames * 1000 / timing.elapsedMilliseconds;
            // C printf rounds exact .25 ties to even; toFixed rounds them away from zero.
            const secondsText = (seconds % 1 === 0.25 ? Math.trunc(seconds * 10) / 10 : seconds).toFixed(1).padStart(3);
            const fpsText = (Math.abs(fps) % 1 === 0.25 ? Math.trunc(fps * 10) / 10 : fps).toFixed(1).padStart(3);
            this.print(`${timing.frames} frames, ${secondsText} seconds: ${fpsText} fps\n`);
          }
          await this.disconnect(true); this.entry();
          const next = this.common.cvars.get("nextdemo")?.value.slice(0, 1023) ?? "";
          if (this.cvar("developer").integerValue !== 0) this.print(`CL_NextDemo: ${next}\n`);
          if (next === "") return;
          this.common.cvars.set("nextdemo", "", true);
          this.common.commands.append(next);
          this.common.commands.append("\n");
          await this.common.commands.executeAsync(); this.entry();
        } } });
  }
  private async applyServerPackages(info: string, guard: () => void): Promise<void> {
    await this.common.files.setServerLoadedPaks(infoValueForKey(info, "sv_paks"), infoValueForKey(info, "sv_pakNames"), guard);
    guard();
    this.common.files.setServerReferencedPaks(infoValueForKey(info, "sv_referencedPaks"), infoValueForKey(info, "sv_referencedPakNames"));
  }
  private getServerCommand(sequence: number): Promise<readonly string[] | null> {
    const connection = this.connection;
    const guard = (): void => { this.entry(); if (connection !== this.connection) throw new Error("Client connection has retired"); };
    return getClientServerCommand(sequence, this.clientActive, connection, this.clientStatic, {
      cvars: this.common.cvars, consoleCommands: this.common.commands, assertCurrentOperation: guard,
      applyServerPackages: info => this.applyServerPackages(info, guard),
      emitEvent: event => {
        guard();
        switch (event.kind) {
          case "clear-notify": this.console.clearNotify(); break;
          case "close-console": this.console.close(); break;
          case "append-console-command": this.common.commands.append(event.text); break;
        }
      },
      fail: (kind, message) => { throw new CommonError(kind, message); },
    });
  }
  private addReliableCommand(text: string): void {
    this.entry();
    if (this.session !== null) this.session.addReliableCommand(text);
    else {
      try { this.connection.reliable.add(text); }
      catch (error) {
        if (error instanceof ReliableOverflowError) throw new CommonError("drop", error.message);
        throw error;
      }
    }
  }
  changeReliableCommand(): void {
    this.entry();
    // CL_ChangeReliableCommand consumes random() even though its computed r is unused.
    this.required(this.services, "services").server.options.random.next();
    this.connection.reliable.changeLatest();
  }
  private delivery(): ClientPacketDelivery {
    const services = this.required(this.services, "services"), remote = this.required(this.remoteAddress, "admitted server address");
    return { send: bytes => {
      this.entry();
      if (remote.kind === "loopback") services.loopback.send("client", bytes);
      else if (services.io.udp !== null && !services.io.udp.send(remote, bytes)) this.print("Sys_SendPacket: UDP socket could not queue packet\n");
      this.entry();
    }, trace: text => { if (this.cvar("showpackets").integerValue !== 0) this.print(text); }, print: text => this.print(text) };
  }
  private writePacket(): void { if (this.session !== null && !this.connection.demoPlaying) this.session.transmit(this.delivery()); }

  async packetEvent(from: ServerPacketAddress, payload: Uint8Array): Promise<void> {
    this.entry();
    const result = this.required(this.admission, "admission").packetEvent(from, payload);
    try {
      switch (result.kind) {
        case "handled": return;
        case "admitted": this.remoteAddress = result.connection.remoteAddress; this.session = this.createSession(result.connection.mode); return;
        case "connectionless":
          if (!this.required(this.browserOwner, "server browser").handleConnectionless(from, result.packet, payload))
            await this.connectionlessPacket(from, result.packet);
          return;
        case "sequenced":
          if (this.session !== null) {
            const client = this;
            await this.session.receiveDatagram(result.payload, {
              get showPackets() { return client.cvar("showpackets").integerValue !== 0; },
              get showDrop() { return client.cvar("showdrop").integerValue !== 0; },
              get remoteAddress() {
                const address = client.required(client.remoteAddress, "admitted server address");
                return address.kind === "loopback" ? "loopback" : `${address.host.join(".")}:${address.port}`;
              },
              print: text => this.print(text),
            });
            this.entry(); await this.sessionEvents();
          }
          return;
      }
    } catch (error) {
      this.rethrowSessionError(error);
    }
  }
  private rethrowSessionError(error: unknown): never {
    if (error instanceof ClientSessionError) throw new CommonError(error.kind === "server-disconnect" ? "server-disconnect" : "drop", error.message);
    throw error;
  }
  private async connectionlessPacket(from: ClientPacketAddress, packet: ConnectionlessPacket): Promise<void> {
    switch (packet.command.toLowerCase()) {
      case "disconnect": {
        const remote = this.remoteAddress;
        const same = remote !== null && (from.kind === "loopback" ? remote.kind === "loopback"
          : remote.kind === "ipv4" && from.port === remote.port && from.host.every((octet, index) => octet === remote.host[index]));
        if (!same || this.clientStatic.phase === "disconnected" || this.clientStatic.phase === "uninitialized"
          || this.clientStatic.realtime - this.connection.lastPacketTime < 3000) return;
        const message = "Server disconnected for unknown reason\n";
        this.print(message); this.common.cvars.set("com_errorMessage", message, true); await this.disconnect(true); return;
      }
      case "echo": {
        const bytes = encodeConnectionlessText(packet.arguments[0] ?? ""), services = this.required(this.services, "services");
        if (from.kind === "loopback") services.loopback.send("client", bytes);
        else if (services.io.udp !== null) services.io.udp.send(from, bytes);
        return;
      }
      case "keyauthorize": return;
      case "motd": this.required(this.motd, "MOTD").packet(from, packet); return;
      case "statusresponse":
        this.required(this.browserOwner, "server browser").serverStatusResponse(from, packet.payload, this.required(this.services, "services").events);
        return;
      default:
        if (this.cvar("developer").integerValue !== 0) this.print("Unknown connectionless packet command.\n");
        return;
    }
  }
  private async sessionEvents(): Promise<void> {
    const session = this.session; if (session === null) return;
    for (const event of session.takeEvents()) {
      this.entry();
      switch (event.kind) {
        case "close-console": this.console.close(); break;
        case "clear-notify": this.console.clearNotify(); break;
        case "clear-active-state": this.inputOwner?.clearActiveState(); this.timeoutCount = 0; break;
        case "append-console-command": this.common.commands.append(event.text); break;
        case "diagnostic": this.print(event.text); break;
        case "register-cgame-command": this.common.commands.registerFallbackName(event.name); break;
        case "gamestate": break;
        case "disconnect": throw new CommonError(event.errorKind === "server-disconnect" ? "server-disconnect" : "drop", event.reason);
      }
    }
  }

  private async initializeDownloads(generation: number): Promise<void> {
    this.entry(); await this.sessionEvents();
    const session = this.required(this.session, "gamestate session");
    await this.conditionalRestartFiles(session.checksumFeed); this.entry();
    if (this.session !== session || session.gamestateGeneration !== generation) return;
    await this.required(this.connection.downloads, "download owner").initialize();
  }
  private async downloadsComplete(generation: number): Promise<void> {
    this.entry();
    const session = this.required(this.session, "gamestate session");
    const connection = this.connection;
    const guard = (): void => { this.entry(); if (connection !== this.connection) throw new Error("Client connection has retired"); };
    if (this.required(this.connection.downloads, "download owner").consumeRestart()) {
      const random = this.required(this.services, "services").server.options.random;
      await this.common.files.restart({ checksumFeed: session.checksumFeed,
        random: () => Math.fround((random.next() & 0x7fff) / 32767) }, guard);
      guard();
      this.addReliableCommand("donedl");
      return;
    }
    this.clientStatic.phase = "loading";
    await this.required(this.services, "services").pumpForDownloadsComplete(); this.entry();
    if (this.clientStatic.phase !== "loading" || this.session !== session || session.gamestateGeneration !== generation) return;
    this.common.cvars.set("r_uiFullScreen", "0", true);
    await this.flushMemory(); this.entry();
    await this.initializeCgame(session); this.entry();
    this.sendPureChecksums();
    this.writePacket(); this.writePacket(); this.writePacket();
  }
  private async conditionalRestartFiles(checksumFeed: number): Promise<void> {
    const connection = this.connection;
    const guard = (): void => { this.entry(); if (connection !== this.connection) throw new Error("Client connection has retired"); };
    await this.common.files.conditionalRestart(checksumFeed, guard);
    guard();
  }
  private sendPureChecksums(): void {
    const session = this.required(this.session, "session");
    this.addReliableCommand(`cp ${session.serverId} ${this.common.files.current.pakReferences.referencedPakPureChecksums()}`.slice(0, 1023));
  }
  private async initializeCgame(session: EngineClientSession): Promise<void> {
    this.common.validateGameDirectory();
    const graphics = this.required(this.graphics, "graphics");
    const start = this.options.systemClock.milliseconds();
    this.entry();
    this.console.close();
    const module = acquireClientModule({ files: this.common.files.current, product: this.common.roots.product, role: "cgame", registry: this.common.vm,
      print: text => this.print(text), hunk: { kind: "source-hunk", accounting: this.common.hunk.accounting } });
    if (module === null) throw new CommonError("drop", "VM_Create on cgame failed");
    let level: ClientLevel | QvmCgame;
    if (module.mode === "registered") {
      const registered = QvmCgame.registered(module.registration) ?? ClientLevel.registered(module.registration);
      if (registered === null) throw new CommonError("drop", "Cgame VM has not published a callable owner");
      if (registered instanceof ClientLevel && registered.options.session !== session)
        throw new Error("Registered cgame belongs to a different client session");
      level = registered;
    } else if (module.mode === "bytecode") {
      const context: ExternalCgameContext = { models: null };
      level = new QvmCgame(module.image, call => this.cgameSystemCall(call, graphics, context), session, () => this.entry(),
        { kind: "source-hunk", accounting: this.common.hunk.accounting }, module.registration);
      module.releaseImage();
      level.loadSymbols({ developer: this.cvar("developer").integerValue, files: this.common.files.current, print: text => this.print(text) });
      module.completeLoading();
    } else level = new ClientLevel({ session, assets: this.assets(), resources: graphics.resources,
      sourceDebug: this.cvar("com_gameDebug").integerValue !== 0,
      commands: graphics.commands, target: graphics.target, sound: this.sound,
      memory: this.required(this.common.hunk.arena, "common hunk"),
      hardware: this.rendererInfo.hardwareType === "ragepro" ? "ragepro" : "generic",
      loadCollisionMap: name => {
        this.entry(); const world = this.common.collision.load(name, true).world; this.entry(); return world;
      },
      menus: module.product === "baseq3" ? { kind: "baseq3" } : { kind: "missionpack",
        cinematics: new EngineUiCinematics(this.required(this.cinematicOwner, "cinematics"), "cgame"),
        audio: this.uiAudio(), setKeyCatcher: mask => { this.entry(); this.keys.setCatcher(mask); } },
      clock: { milliseconds: () => this.required(this.services, "services").events.milliseconds(),
        serverTime: () => session.serverTime, frameNumber: () => this.clientStatic.frameCount },
      updateLoadingScreen: async draw => { await this.sessionEvents(); await this.screen.update(draw); this.entry(); } }, module.registration);
    this.level = level;
    await level.initialize(); this.entry();
    await this.sessionEvents(); this.entry();
    const end = this.options.systemClock.milliseconds();
    this.entry();
    const elapsed = (end - start) | 0;
    let seconds = (elapsed / 1000).toFixed(2);
    // The exact binary64 half-cent ties are odd multiples of 125 milliseconds.
    if (Math.abs(elapsed) % 250 === 125) {
      const lower = Math.floor(Math.abs(elapsed) / 10), cents = lower + lower % 2;
      seconds = `${elapsed < 0 ? "-" : ""}${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
    }
    this.print(`CL_InitCGame: ${seconds.padStart(5)} seconds\n`);
    graphics.commands.endRegistration(); this.entry();
    this.common.touchMemory(this.options.systemClock); this.entry();
    this.console.clearNotify();
  }

  private async connect(context: CommandContext): Promise<void> {
    this.entry(); if (context.argv.length !== 2) { this.print("usage: connect [server]\n"); return; }
    this.common.cvars.set("ui_singlePlayerActive", "0", true);
    await this.required(this.motd, "MOTD").request(() => this.entry()); this.entry();
    this.connection.serverMessage = "";
    const server = context.argv[1] ?? "", services = this.required(this.services, "services");
    if (services.server.running && server === "localhost") await services.server.shutdownFromCommand("Server quit\n");
    this.entry(); this.common.cvars.set("sv_killserver", "1", true); await services.server.frame(0); this.entry();
    await this.disconnect(true); this.console.close();
    this.clientStatic.servername = server.slice(0, 4095);
    const colon = server.indexOf(":"), host = colon < 0 ? server : server.slice(0, colon);
    const port = colon < 0 ? 27960 : nativeAtoi(server.slice(colon + 1)) & 65535;
    const address: ClientPacketAddress | null = server === "localhost" ? { kind: "loopback" }
      : await services.io.resolveAddress(host, port === 0 ? 27960 : port);
    this.entry();
    if (address === null) { this.print("Bad server address\n"); return; }
    this.required(this.admission, "admission").beginResolved(server, address); this.keys.setCatcher(0);
  }
  async mapLoading(): Promise<void> {
    this.entry(); if (this.cvar("cl_running").integerValue === 0) return;
    this.console.close(); this.keys.setCatcher(0);
    if (connected(this.clientStatic) && this.clientStatic.servername.toLowerCase() === "localhost") {
      this.clientStatic.phase = "connected"; this.clientStatic.updateInfoString = ""; this.connection.serverMessage = "";
      this.clientActive.gameState.clear();
      this.connection.lastPacketSentTime = -9999; await this.screen.update(); this.entry();
    } else {
      this.common.cvars.set("nextmap", "", true); await this.disconnect(true); this.entry();
      this.clientStatic.servername = "localhost"; this.clientStatic.phase = "challenging";
      this.keys.setCatcher(0); await this.screen.update(); this.entry();
      this.connection.connectTime = -3000; this.connection.serverAddress = { kind: "loopback" };
      await this.required(this.admission, "admission").checkForResend(); this.entry();
    }
  }
  async disconnectAfterServerShutdown(): Promise<void> { await this.disconnect(false); }
  async disconnect(showMainMenu: boolean): Promise<void> {
    this.entry(); if ((this.early?.cvars.get("cl_running")?.integerValue ?? 0) === 0) return;
    this.common.cvars.set("r_uiFullScreen", "1", true);
    const recorder = this.connection.demoRecording;
    if (recorder?.active) recorder.stop();
    this.connection.downloads?.close();
    this.connection.demoPlayback?.close(); this.connection.demoPlayback = null;
    if (this.ui !== null && showMainMenu) { await this.ui.setActiveMenu(UiMenuCommand.None); this.entry(); }
    this.systemCinematics?.stop(); this.common.sound.clearSoundBuffer();
    if (connected(this.clientStatic) && this.session !== null && !this.connection.demoPlaying) {
      this.session.disconnectPackets(this.delivery());
    }
    this.inputOwner?.clearActiveState();
    recorder?.close(); this.clientActive.clear(); this.resetConnection(); this.clientStatic.phase = "disconnected";
    this.common.cvars.set("sv_cheats", "1", true); this.common.cvars.setCheatsEnabled(true);
  }
  private async shutdownCgame(): Promise<void> {
    if (this.keyOwner !== null) this.keyOwner.setCatcher(this.keyOwner.getCatcher() & ~KeyCatcher.Cgame);
    const level = this.level;
    if (level !== null) { await level.close(); this.entry(); this.level = null; }
  }
  private async shutdownUi(): Promise<void> {
    if (this.keyOwner !== null) this.keyOwner.setCatcher(this.keyOwner.getCatcher() & ~KeyCatcher.Ui);
    await this.ui?.shutdown(); this.entry();
    this.ui?.retire();
    this.ui = null;
  }
  private clearVm(): void {
    this.entry();
    this.level?.retire(); this.level = null;
    this.ui?.retire(); this.ui = null;
  }
  private disposeGraphics(): void {
    const failures: unknown[] = [];
    if (this.backend?.backend instanceof ThreadedRendererBackend && this.rendererCommandBridge?.retired !== true) {
      try { this.backend.backend.thread.synchronize(); } catch (error) { failures.push(error); }
    }
    this.graphics = null;
    this.registeredRendererCommands = null;
    while (this.graphicsCleanup.length !== 0) {
      const close = this.graphicsCleanup.pop();
      if (close !== undefined) try { close(); } catch (error) { failures.push(error); }
    }
    this.backend = null; this.builtins = null; this.rendererCommandBridge = null;
    if (failures.length !== 0) throw new AggregateError(failures, "Client renderer disposal failed");
  }
  private unregisterRendererCommands(): void {
    this.common.commands.unregister("modellist");
    this.common.commands.unregister("screenshotJPEG"); this.common.commands.unregister("screenshot");
    this.common.commands.unregister("imagelist");
    this.common.commands.unregister("shaderlist"); this.common.commands.unregister("skinlist");
    this.common.commands.unregister("gfxinfo");
    this.common.commands.unregister("modelist");
    this.common.commands.unregister("shaderstate");
    this.common.commands.unregister("toggle_renderer");
    this.rendererCommandCleanupPending = false;
  }
  private shutdownRenderer(destroyWindow: boolean): void {
    if (!this.rendererInterfaceInitialized) return;
    this.print(`RE_Shutdown( ${destroyWindow ? 1 : 0} )\n`);
    this.unregisterRendererCommands();
    const retired = this.rendererCommandBridge?.retireAfterFailure() === true || this.rendererCommandBridge?.retired === true;
    if (!retired) {
      this.retainTextureFilter();
      // RE_Shutdown -> R_SyncRenderThread executes pending screenshots before teardown.
      this.registeredRendererCommands?.target.syncRenderThread();
    }
    this.graphics = null; this.registeredRendererCommands = null;
    while (this.graphicsCleanup.length !== 0) {
      const close = this.graphicsCleanup.pop();
      if (close !== undefined) close();
      this.entry();
    }
    this.backend = null; this.builtins = null; this.rendererCommandBridge = null;
  }
  private retainTextureFilter(): void {
    if (this.backend !== null) this.textureFilter = this.backend.backend.images.textureFilter;
  }
  async shutdownAllForServerMap(): Promise<void> {
    this.entry(); this.sound.disableSounds(); await this.shutdownCgame(); this.entry();
    await this.shutdownUi(); this.entry(); this.shutdownRenderer(false); this.soundRegistered = false;
  }
  async flushMemory(): Promise<void> {
    await this.shutdownAllForServerMap(); this.entry();
    if (this.cvar("sv_running").integerValue === 0) {
      await this.common.hunk.clear(); this.entry();
      this.common.collision.clear(); this.entry();
    } else this.common.hunk.clearToMark();
    await this.startHunkUsers(); this.entry();
  }
  private async restartVideo(): Promise<void> {
    this.entry(); this.sound.stopAllSounds(); await this.shutdownUi(); this.entry(); await this.shutdownCgame(); this.entry();
    this.shutdownRenderer(true); this.sdlInput?.close(); this.sdlInput = null; this.window?.close(); this.window = null;
    this.rendererInfo = emptyRendererConfiguration(this.options.renderer);
    this.rendererInterfaceInitialized = false;
    this.addReliableCommand("vdr");
    this.common.files.current.pakReferences.clear(6);
    await this.conditionalRestartFiles(this.session?.checksumFeed ?? 0); this.entry();
    this.common.cvars.set("cl_paused", "0", true); this.soundRegistered = false;
    if (this.cvar("sv_running").integerValue === 0) { await this.common.hunk.clear(); this.entry(); }
    else this.common.hunk.clearToMark();
    this.initializeRendererInterface();
    await this.startHunkUsers(); this.entry();
    if (this.session !== null && (this.clientStatic.phase === "loading" || this.clientStatic.phase === "primed" || this.clientStatic.phase === "active")) {
      await this.initializeCgame(this.session); this.sendPureChecksums();
    }
  }
  async frame(milliseconds: number): Promise<void> {
    try { await this.frameSource(milliseconds); }
    catch (error) { this.rethrowSessionError(error); }
  }
  private async frameSource(milliseconds: number): Promise<void> {
    this.entry(); if (this.cvar("cl_running").integerValue === 0) return;
    if (this.cdDialog) {
      this.cdDialog = false; await this.requireUi().setActiveMenu(UiMenuCommand.NeedCd); this.entry();
    } else if (this.clientStatic.phase === "disconnected" && (this.keys.getCatcher() & KeyCatcher.Ui) === 0 && this.cvar("sv_running").integerValue === 0) {
      this.sound.stopAllSounds(); await this.requireUi().setActiveMenu("main"); this.entry();
    }
    const aviFps = this.cvar("cl_avidemo").integerValue;
    if (aviFps !== 0 && milliseconds !== 0) {
      if (this.clientStatic.phase === "active" || this.cvar("cl_forceavidemo").integerValue !== 0) {
        this.common.commands.executeNow("screenshot silent\n"); this.entry();
      }
      milliseconds = aviFrameMilliseconds(this.cvar("cl_avidemo").integerValue, this.cvar("timescale").numericValue);
    }
    this.clientStatic.realFrameTime = milliseconds; this.clientStatic.frameTime = milliseconds;
    this.clientStatic.realtime = (this.clientStatic.realtime + milliseconds) | 0;
    if (this.cvar("timegraph").integerValue !== 0) this.screen.debugGraph(Math.fround(milliseconds * 0.25), 0);
    this.required(this.admission, "admission").checkUserinfo();
    if ((this.cvar("cl_paused").integerValue === 0 || this.cvar("sv_paused").integerValue === 0)
      && connected(this.clientStatic) && this.clientStatic.phase !== "cinematic"
      && this.clientStatic.realtime - this.connection.lastPacketTime > this.cvar("cl_timeout").numericValue * 1000) {
      if (++this.timeoutCount > 5) { this.print("\nServer connection timed out.\n"); await this.disconnect(true); this.entry(); }
    } else this.timeoutCount = 0;
    if (this.connection.demoPlaying || this.clientStatic.phase === "cinematic") {
      this.required(this.inputOwner, "input").sendPlaybackCommand(this.clientActive, this.clientStatic,
        this.required(this.services, "services").events.comFrameTime);
    } else if (this.session !== null && this.remoteAddress !== null) this.required(this.inputOwner, "input").sendCommand({
      session: this.session, remoteAddress: this.remoteAddress, lan: this.required(this.services, "services").io.lan,
      comFrameTime: this.required(this.services, "services").events.comFrameTime, delivery: this.delivery() });
    await this.required(this.admission, "admission").checkForResend(); this.entry();
    if (this.session !== null) { await this.session.setCGameTime(); this.entry(); await this.sessionEvents(); }
    await this.screen.update(); this.entry(); await this.sessionEvents();
    this.sound.update(); this.entry(); this.systemCinematics?.run(); this.entry(); this.console.run();
    this.clientStatic.frameCount = (this.clientStatic.frameCount + 1) | 0;
  }
  async keyEvent(key: number, down: boolean, time: number): Promise<void> { this.entry(); await this.keys.keyEvent(key, down, time >>> 0); this.entry(); }
  async characterEvent(character: number): Promise<void> { this.entry(); await this.keys.charEvent(character); this.entry(); }
  async mouseEvent(dx: number, dy: number, time: number): Promise<void> { this.entry(); await this.required(this.inputOwner, "input").mouseEvent(dx, dy, time); this.entry(); }
  async joystickEvent(axis: number, value: number, time: number): Promise<void> { this.entry(); this.required(this.inputOwner, "input").joystickEvent(axis, value, time); }
  private startDemoLoop(): void { this.entry(); this.common.commands.append("d1\n"); this.keys.setCatcher(0); }
  queueDefaultStartup(commands: CommonConsole["commands"]): void {
    this.entry(); if (commands !== this.common.commands) throw new Error("Client startup requires its common command buffer");
    commands.append("cinematic idlogo.RoQ\n");
    if (this.cvar("com_introplayed").integerValue === 0) {
      this.common.cvars.set("com_introplayed", "1", true);
      this.common.cvars.set("nextmap", "cinematic intro.RoQ", true);
    }
  }
  private async playDemo(context: CommandContext): Promise<void> {
    this.entry(); if (context.argv.length !== 2) { this.print("playdemo <demoname>\n"); return; }
    this.common.cvars.set("sv_killserver", "1", true);
    await this.disconnect(true); this.entry();
    const name = context.argv[1] ?? "";
    const playback = ClientDemoPlayback.open(this.common.files, name, text => this.print(text),
      opened => { this.connection.demoPlayback = opened; }); this.entry();
    this.console.close(); this.clientStatic.phase = "connected"; this.clientStatic.servername = name.slice(0, 4095);
    this.connection.demoPlaying = true; this.session = this.createSession({ kind: "demo", reader: playback });
    try { await this.session.readInitialDemoMessages(); this.entry(); await this.sessionEvents(); }
    catch (error) { this.rethrowSessionError(error); }
  }
  async shutdown(): Promise<void> {
    if (this.early === null) return;
    this.required(this.early, "early common services").assertOwnerEntry();
    await this.shutdownContext.run(true, () => this.shutdownSource());
  }
  private async shutdownSource(): Promise<void> {
    this.entry(); this.print("----- CL_Shutdown -----\n");
    if (this.shutdownRecursive) { this.print("recursive shutdown\n"); return; }
    this.shutdownRecursive = true;
    await this.disconnect(true); this.entry(); this.soundOwner?.shutdown(); this.shutdownRenderer(true);
    this.sdlInput?.close(); this.sdlInput = null; this.window?.close(); this.window = null;
    this.rendererInfo = emptyRendererConfiguration(this.options.renderer);
    this.rendererInterfaceInitialized = false;
    await this.shutdownUi(); this.entry();
    for (const name of ["cmd", "configstrings", "userinfo", "snd_restart", "vid_restart", "disconnect", "record", "demo", "cinematic",
      "stoprecord", "connect", "localservers", "globalservers", "rcon", "setenv", "ping", "serverstatus", "showip", "model"])
      this.required(this.early, "early common services").commands.unregister(name);
    this.required(this.early, "early common services").cvars.set("cl_running", "0", true);
    this.soundStarted = false; this.soundRegistered = false; this.shutdownRecursive = false;
    this.cdDialog = false;
    this.clientStatic.phase = "uninitialized"; this.clientStatic.realtime = 0; this.clientStatic.frameTime = 0;
    this.clientStatic.realFrameTime = 0; this.clientStatic.frameCount = 0; this.clientStatic.servername = ""; this.clientStatic.updateInfoString = "";
    this.rendererConfiguration = null;
    this.authorization = null;
    this.motd = null;
    this.print("-----------------------\n");
  }
  async disposeResources(): Promise<void> {
    if (this.disposed) return;
    const failures: unknown[] = [];
    const close = async (dispose: () => void | Promise<void>): Promise<void> => { try { await dispose(); } catch (error) { failures.push(error); } };
    await close(() => { this.level?.retire(); this.level = null; });
    await close(() => { this.ui?.retire(); this.ui = null; });
    await close(() => { this.connection.demoRecording?.close(); });
    await close(() => { this.connection.downloads?.disposeResources(); });
    await close(() => { this.connection.demoPlayback?.close(); this.connection.demoPlayback = null; });
    await close(() => { this.cinematicOwner?.dispose(); this.cinematicOwner = null; this.systemCinematics = null; });
    await close(() => this.disposeGraphics());
    await close(() => { this.cpuExecution?.close(); this.cpuExecution = null; });
    await close(() => { this.sdlInput?.close(); this.sdlInput = null; });
    await close(() => { this.window?.close(); this.window = null; });
    await close(() => { this.sourceInput?.close(); this.sourceInput = null; });
    await close(() => { this.midiInput?.close(); this.midiInput = null; });
    await close(() => { this.glLogging?.close(); this.glLogging = null; });
    await close(() => { this.soundOwner?.close(); });
    this.ui = null; this.session = null; this.rendererConfiguration = null; this.screenshots = null; this.disposed = true;
    if (failures.length !== 0) throw new AggregateError(failures, "Client resource disposal failed");
  }
}
