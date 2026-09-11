// Level composition from id Software's cg_main.c:CG_Init, cg_view.c:CG_DrawActiveFrame and cg_draw.c:CG_DrawActive.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { PcmSound } from "../assets/wav.ts";
import type { CollisionWorld } from "../collision/world.ts";
import { CommonError } from "../core/common-error.ts";
import type { CvarSnapshot } from "../core/cvar.ts";
import type { HunkArena } from "../core/hunk.ts";
import { infoValueForKey } from "../core/info-string.ts";
import { add3, scale3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { EngineClientSession } from "../engine/client-session.ts";
import type { EngineSound } from "../engine/sound.ts";
import { EngineUiModelPainter } from "../engine/ui-model.ts";
import { gameFormat } from "../game/format.ts";
import { GameRandom, gameAtoi } from "../game/numeric.ts";
import type { RenderCommandBuffer, RenderTarget } from "../render/commands.ts";
import { UiAssetRegistry } from "../render/font.ts";
import { BspMarkProjector } from "../render/marks.ts";
import type { RendererResources, WorldScene } from "../render/world.ts";
import { PersistentIndex, Team, Weapon } from "../shared/definitions.ts";
import { MoveFlags } from "../shared/player-state.ts";
import { ClientConfiguration, ClientVmCvarSymbol } from "./config.ts";
import { ClientConsoleRuntime, clientConsoleCommandNames } from "./console.ts";
import { ClientDrawIcons } from "./draw-icons.ts";
import { ClientDrawStatus } from "./draw-status.ts";
import { ClientDrawTools, drawStrlen, fadeColor } from "./draw-tools.ts";
import { ClientEffects } from "./effects.ts";
import { PacketEntityPresenter } from "./entities.ts";
import { ClientEventRuntime } from "./events.ts";
import { ClientFrameAudio } from "./frame-audio.ts";
import { ClientHud } from "./hud.ts";
import { ClientHudCorners } from "./hud-corners.ts";
import { ClientLoadingScreen } from "./info.ts";
import { LocalEntityPool, LocalEntitySystem } from "./local-entities.ts";
import { ImpactMarkSystem } from "./marks.ts";
import { ClientMedia, registerClientLoadingGraphics, registerClientSounds, registerClientGraphics, registerClients } from "./media.ts";
import type { ClientMediaHost } from "./media.ts";
import { MissionHud } from "./mission-hud.ts";
import type { MissionHudHost } from "./mission-hud.ts";
import { ParticleSystem } from "./particles.ts";
import { PlayerStateRuntime } from "./player-state.ts";
import { ClientInfoStore, PlayerPresenter } from "./players.ts";
import { PredictionRuntime } from "./prediction.ts";
import { BaseScoreboard } from "./scoreboard.ts";
import { ClientServerCommandRuntime } from "./server-commands.ts";
import { SnapshotRuntime } from "./snapshots.ts";
import type { SoundAssetReader } from "./sound-bank.ts";
import type { VmRegistration } from "../vm/registry.ts";
import { ClientGameState, ClientGameStaticState } from "./state.ts";
import { ViewRuntime } from "./view.ts";
import { ClientWeaponRuntime, ClientWeaponSelection } from "./weapons.ts";

const VM_SYMBOLS = new Map<string, ClientVmCvarSymbol>();
for (const symbol of Object.values(ClientVmCvarSymbol)) VM_SYMBOLS.set(symbol, symbol);

export interface ClientLevelClock {
  milliseconds(): number;
  serverTime(): number;
  frameNumber(): number;
}
export interface ClientLevelOptions {
  readonly sourceDebug?: boolean;
  readonly session: EngineClientSession;
  readonly assets: SoundAssetReader;
  readonly resources: RendererResources;
  readonly commands: RenderCommandBuffer;
  readonly sound: Pick<EngineSound, "bank" | "startSound" | "startLocalSound" | "updateLoopingSound"
    | "updateRealLoopingSound" | "clearLoopingSounds" | "stopLoopingSound" | "updateEntityPosition"
    | "setListener" | "startBackgroundTrack">;
  readonly target: RenderTarget;
  updateLoadingScreen(drawCgame: () => Promise<void>): Promise<void>;
  readonly clock: ClientLevelClock;
  readonly memory: HunkArena;
  loadCollisionMap(name: string): CollisionWorld | Promise<CollisionWorld>;
  readonly hardware: "generic" | "ragepro";
  readonly menus: { readonly kind: "baseq3" } | ({ readonly kind: "missionpack" } & Pick<MissionHudHost, "cinematics" | "audio" | "setKeyCatcher">);
}
export interface ClientLevelFrame {
  readonly serverTime: number;
  readonly stereo: "center" | "left" | "right";
  readonly demoPlayback: boolean;
  readonly engineFrameNumber: number;
}

interface FrameContext { loading: boolean; demoPlayback: boolean; engineFrameNumber: number }

interface LevelGraph {
  readonly state: ClientGameState;
  readonly staticState: ClientGameStaticState;
  readonly configuration: ClientConfiguration;
  readonly media: ClientMedia;
  readonly world: WorldScene;
  readonly collision: CollisionWorld;
  readonly clients: ClientInfoStore;
  readonly prediction: PredictionRuntime;
  readonly view: ViewRuntime;
  readonly snapshots: SnapshotRuntime;
  readonly packet: PacketEntityPresenter;
  readonly effects: ClientEffects;
  readonly localEntities: LocalEntitySystem;
  readonly particles: ParticleSystem;
  readonly marks: ImpactMarkSystem;
  readonly weapons: ClientWeaponRuntime;
  readonly serverCommands: ClientServerCommandRuntime;
  readonly console: ClientConsoleRuntime;
  readonly frameAudio: ClientFrameAudio;
  readonly loading: ClientLoadingScreen;
  readonly hud: ClientHud;
  readonly status: ClientDrawStatus;
  readonly tools: ClientDrawTools;
  readonly commands: RenderCommandBuffer;
  readonly context: FrameContext;
  readonly readVm: (name: string) => CvarSnapshot;
  readonly menus: MissionHud | null;
}

// code/cgame/cg_public.h, cgameExport_t.
enum CgameExport {
  Init = 0, Shutdown = 1, ConsoleCommand = 2, DrawActiveFrame = 3,
  CrosshairPlayer = 4, LastAttacker = 5, KeyEvent = 6, MouseEvent = 7, EventHandling = 8,
}

/** Cgame state, timers and pools belong to a level; the engine owns its drawing queue. */
export class ClientLevel {
  private static readonly registeredOwners = new WeakMap<VmRegistration, ClientLevel>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private disposed = false;
  private graphOwner: LevelGraph | null = null;
  private commandOwner: Pick<LevelGraph, "console" | "menus" | "serverCommands"> | null = null;
  private generationValue = 0;
  constructor(readonly options: ClientLevelOptions, private readonly registration: VmRegistration | null = null) {
    if (registration !== null) {
      registration.bindTypeScript();
      ClientLevel.registeredOwners.set(registration, this);
    }
  }
  static registered(registration: VmRegistration): ClientLevel | null {
    return registration.binding.kind === "typescript" ? ClientLevel.registeredOwners.get(registration) ?? null : null;
  }
  get graph(): LevelGraph {
    if (this.graphOwner === null) throw new Error("Client level graph has not initialized");
    return this.graphOwner;
  }
  get generation(): number { return this.generationValue; }
  get state(): ClientGameState { return this.graph.state; }
  get staticState(): ClientGameStaticState { return this.graph.staticState; }

  static async open(options: ClientLevelOptions): Promise<ClientLevel> {
    const level = new ClientLevel(options);
    await level.initialize();
    return level;
  }

  async initialize(): Promise<void> {
    if (this.disposed) throw new Error("Client level is closed");
    this.registration?.called();
    this.registration?.printCall(CgameExport.Init);
    const options = this.options;
    const { session, resources, target, commands } = options;
    if (commands.target !== target || commands.target.images !== resources.images
      || commands.tess !== resources.tess || commands.runtime !== resources.settings.runtime) {
      throw new Error("Client level requires its engine's shared rendering target and resources");
    }
    const generation = session.gamestateGeneration;
    if (generation === 0 || session.dropped !== null) throw new Error("CG_Init requires a live engine gamestate");
    if (options.menus.kind !== session.product) throw new Error("Client level menu services differ from the engine product");
    const memoryProfile = resources.memoryProfile;
    if (memoryProfile.kind === "source-hunk" && memoryProfile.accounting.arena !== options.memory) throw new Error("Client collision and renderer must share the same source hunk arena");
    try {
      session.lifecycle.assertCurrentOperation();
      session.lifecycle.clientStatic.phase = "loading";
      this.commandOwner?.menus?.dispose(); this.commandOwner?.console.dispose(); this.commandOwner?.serverCommands.dispose();
      this.commandOwner = null;
      this.graphOwner = null; this.generationValue = generation; this.closed = false;
      await this.initializeGraph(generation);
    } catch (error: unknown) {
      return target.fail(error);
    }
  }

  private async initializeGraph(generation: number): Promise<void> {
    const options = this.options;
    const { session, resources, assets, sound, commands, target } = options;
    const soundBank = sound.bank;
    const memoryProfile = resources.memoryProfile;
    const memoryRemaining = () => memoryProfile.kind === "source-hunk" ? memoryProfile.accounting.memoryRemaining() : options.memory.memoryRemaining();
    const initialMessageSequence = session.serverMessageSequence;
    const state = new ClientGameState(session.product, session.clientNumber, initialMessageSequence);
    const staticState = new ClientGameStaticState(session.product);
    staticState.serverCommandSequence = session.lastExecutedServerCommand;
    const context: FrameContext = { loading: false, demoPlayback: session.mode.kind === "demo", engineFrameNumber: options.clock.frameNumber() };
    let loadingPhase: { readonly kind: "registering" } | { readonly kind: "constructed"; readonly level: ClientLevel } = { kind: "registering" };
    const random = new GameRandom();
    let strings: readonly string[] = Array.from({ length: 1024 }, () => "");
    const configString = (index: number): string => {
      if (Number.isInteger(index) && (index < 0 || index >= 1024)) throw new CommonError("drop", `CG_ConfigString: bad index: ${index}`);
      const value = strings[index];
      if (!Number.isInteger(index) || value === undefined) throw new RangeError(`CG_ConfigString: bad index ${index}`);
      return value;
    };
    const print = (text: string) => session.print(text);
    const setCvar = (name: string, value: string) => { session.cvars.set(name, value, true); };
    const readVm = (name: string): CvarSnapshot => {
      const symbol = VM_SYMBOLS.get(name);
      return symbol === undefined ? configuration.readVmCvar(name) : configuration.readVmSymbol(symbol);
    };
    const integer = (name: string) => readVm(name).integerValue;
    const numeric = (name: string) => readVm(name).numericValue;
    const enabled = (name: string) => integer(name) !== 0;
    const missionEnabled = (name: string) => session.product === "missionpack" && enabled(name);
    const sendClientCommand = (text: string) => { session.addReliableCommand(text); };
    const sendConsoleCommand = (text: string) => session.appendConsoleCommand(text);
    const startSound = (origin: Vec3 | null, entity: number, channel: number, pcm: PcmSound | null) => {
      sound.startSound(pcm, { entity, channel, volume: 127, origin: origin === null ? { kind: "entity", entity } : { kind: "fixed", position: { ...origin } } });
    };
    const startLocalSound = (pcm: PcmSound | null, channel: number) => {
      sound.startLocalSound(pcm, channel);
    };
    const addLoopSound = (entity: number, origin: Vec3, velocity: Vec3, pcm: PcmSound | null, realLoop: boolean) => {
      if (realLoop) sound.updateRealLoopingSound(pcm, { entity, origin, velocity });
      else sound.updateLoopingSound(pcm, { entity, origin, velocity, frameNumber: context.engineFrameNumber });
    };
    const clients = new ClientInfoStore({ state, assets, resources, print,
      memoryRemaining,
      registerShaderNoMip: name => resources.registerShaderNoMip(name),
      registerSound: (name, compressed) => soundBank.registerSound(name, compressed),
      sound: (name, compressed) => soundBank.sound(name, compressed),
      settings: () => ({ gameType: staticState.gameType, maxClients: staticState.maxclients, forceModel: enabled("cg_forceModel"),
        model: session.cvars.get("model")?.value ?? "", headModel: session.cvars.get("headmodel")?.value ?? "",
        redTeamName: session.product === "missionpack" ? readVm("cg_redTeamName").value : "",
        blueTeamName: session.product === "missionpack" ? readVm("cg_blueTeamName").value : "",
        deferPlayers: enabled("cg_deferPlayers"), buildScript: enabled("cg_buildScript"), loading: context.loading }),
    }, staticState.clientInfo);
    const configuration = new ClientConfiguration(session.product, { state, staticState, cvars: session.cvars, clients, configString });
    const media = new ClientMedia(session.product, staticState, resources, soundBank);
    const draw = commands.draw2D("stretch-640"), tools = new ClientDrawTools(draw, media);
    const icons = new ClientDrawIcons(state, tools, () => ({ drawIcons: enabled("cg_drawIcons"), draw3dIcons: enabled("cg_draw3dIcons") }), commands);
    const loading = new ClientLoadingScreen(state, media, session.cvars, { configString, updateScreen: async () => {
      if (session.serverMessageSequence !== initialMessageSequence) throw new Error("Engine server message parsing must serialize behind CG_Init");
      await options.updateLoadingScreen(async () => {
        session.lifecycle.assertCurrentOperation();
        this.requireActive();
        this.registration?.called();
        this.registration?.printCall(CgameExport.DrawActiveFrame);
        if (loadingPhase.kind === "constructed") {
          // CG_Init reenters cgame from the screen update, not through queued public VM calls.
          await loadingPhase.level.drawFrame({ serverTime: options.clock.serverTime(),
            engineFrameNumber: options.clock.frameNumber(), stereo: "center", demoPlayback: session.mode.kind === "demo" });
          return;
        }
        state.time = options.clock.serverTime();
        await configuration.updateCvars();
        if (state.infoScreenText === "") {
          sound.clearLoopingSounds(false); resources.clearScene(); await snapshots.processSnapshots();
          if (state.snap !== null && (state.snap.flags & 2) === 0) throw new Error("Engine snapshot parsing must remain serialized behind CG_Init");
        }
        await loading.drawInformation(draw);
      });
      session.lifecycle.assertCurrentOperation();
    } });
    const serverCommands = new ClientServerCommandRuntime({ state, staticState, clients, resources, assets, random,
      resetPlayerEntity: entity => players.resetPlayerEntity(entity), getServerCommand: sequence => session.getServerCommand(sequence),
      refreshGameState: () => { strings = session.getGameState(); }, configString, readVmCvar: readVm, setCvar, print,
      centerPrint: (text, y, width) => status.centerPrint(text, y, width), sendConsoleCommand,
      sound: name => media.sounds[name], registerSound: (path, compressed) => soundBank.registerSound(path, compressed), startLocalSound,
      startBackgroundTrack: (intro, loop) => sound.startBackgroundTrack(intro, loop), remapShader: (original, replacement, offset) => resources.remapShader(original, replacement, offset),
      clearLocalEntities: () => pool.initialize(), clearMarks: () => marks.reset(), clearParticles: () => particles.clear(resources),
      clearLoopingSounds: killAll => sound.clearLoopingSounds(killAll),
      setScoreSelection: () => { if (menus === null) throw new Error("Mission score selection called in baseq3"); menus.setScoreSelection(); },
      showResponseHead: () => { if (menus === null) throw new Error("Mission response head called in baseq3"); return menus.showResponseHead(); },
      memoryRemaining,
    });
    const snapshots = new SnapshotRuntime(state, { source: session.snapshots,
      get demoPlayback() { return context.demoPlayback; }, get noPredict() { return enabled("cg_nopredict"); },
      get synchronousClients() { return enabled("cg_synchronousClients"); },
      executeServerCommands: sequence => serverCommands.executeNewServerCommands(sequence), respawn: () => playerState.respawn(),
      resetPlayerEntity: entity => players.resetPlayerEntity(entity), checkEvents: entity => events.checkEvents(entity),
      transitionPlayerState: (current, previous) => playerState.transitionPlayerState(current, previous),
      lagometerSnapshot: snapshot => {
        if (snapshot === null) { status.addLagometerSnapshotInfo(null); return; }
        const ping = session.snapshotPing(snapshot.messageNumber);
        if (ping === null) throw new Error("Cgame snapshot has no engine-owned ping record");
        status.addLagometerSnapshotInfo({ ping, flags: snapshot.flags });
      }, warn: print,
    });
    const view = new ViewRuntime(state, { state,
      trace: (start, end, bounds, skip, mask) => prediction.trace(start, end, bounds, skip, mask),
      pointContents: (point, passEntity) => prediction.pointContents(point, passEntity),
    }, {
      settings: () => ({ videoWidth: target.width, videoHeight: target.height, viewSize: integer("cg_viewsize"),
        thirdPerson: enabled("cg_thirdPerson"), thirdPersonRange: numeric("cg_thirdPersonRange"), thirdPersonAngle: numeric("cg_thirdPersonAngle"),
        cameraMode: enabled("cg_cameraMode"), cameraOrbitInteger: integer("cg_cameraOrbit"), cameraOrbitValue: numeric("cg_cameraOrbit"),
        cameraOrbitDelay: integer("cg_cameraOrbitDelay"), errorDecay: numeric("cg_errorDecay"), runPitch: numeric("cg_runpitch"), runRoll: numeric("cg_runroll"),
        bobPitch: numeric("cg_bobpitch"), bobRoll: numeric("cg_bobroll"), bobUp: numeric("cg_bobup"), fov: numeric("cg_fov"), zoomFov: numeric("cg_zoomFov"),
        dmFlags: staticState.dmFlags, gunX: numeric("cg_gun_x"), gunY: numeric("cg_gun_y"), gunZ: numeric("cg_gun_z") }),
      setViewSize: value => setCvar("cg_viewsize", String(value)),
      setThirdPersonAngleValue: value => configuration.setVmNumericValue(ClientVmCvarSymbol.cg_thirdPersonAngle, value),
      registerModel: path => resources.registerModel(path), print,
    });
    const menus = options.menus.kind === "baseq3" ? null : new MissionHud(state, staticState, media, {
      ...options.menus, modelPainter: new EngineUiModelPainter(resources, commands),
      assets, fontRegistry: new UiAssetRegistry(resources, print), icons, configuration, cvars: session.cvars,
      commands: { append: sendConsoleCommand }, clients, random, configString, resetPlayerEntity: entity => players.resetPlayerEntity(entity),
      print, milliseconds: () => options.clock.milliseconds(),
    });
    const status = new ClientDrawStatus(state, staticState, tools, menus === null ? { kind: "baseq3" } : { kind: "missionpack", fonts: menus.fonts },
      { commands: session.commands, readVmCvar: readVm });
    const frameAudio = new ClientFrameAudio(state, media.sounds, { startSound, startLocalSound });
    const console = new ClientConsoleRuntime(state, staticState, { cvars: session.cvars, view, weapons: new ClientWeaponSelection(state), clients, serverCommands,
      hud: menus === null ? { kind: "unavailable", reason: "Base cgame has no mission menu console commands" } : menus,
      teamOrders: menus === null ? { kind: "unavailable", reason: "Base cgame has no mission team-order console commands" } : menus,
      readVmCvar: readVm, resetPlayerEntity: entity => players.resetPlayerEntity(entity), addCommand: name => session.registerCgameCommand(name),
      sendClientCommand, sendConsoleCommand, print, centerPrint: (text, y, width) => status.centerPrint(text, y, width),
      sound: name => media.sounds[name], addBufferedSound: sound => frameAudio.addBufferedSound(sound),
    });
    this.commandOwner = { console, menus, serverCommands };
    await registerClientLoadingGraphics(media);
    configuration.registerCvars();
    for (const name of clientConsoleCommandNames(session.product)) session.registerCgameCommand(name);
    state.weaponSelect = Weapon.WP_MACHINEGUN;
    staticState.redflag = -1; staticState.blueflag = -1; staticState.flagStatus = -1;
    strings = session.getGameState();
    if (configString(20) !== "baseq3-1") throw new CommonError("drop", `Client/Server game mismatch: baseq3-1/${configString(20)}`);
    staticState.levelStartTime = gameAtoi(configString(21));
    serverCommands.parseServerInfo();
    await loading.loadingString("collision map");
    const collision = await options.loadCollisionMap(staticState.mapname);
    context.loading = true;
    const mediaHost: ClientMediaHost = { state, staticState, clients, commands: serverCommands, configString,
      settings: () => ({ buildScript: enabled("cg_buildScript") }), loadingString: text => loading.loadingString(text),
      loadingItem: index => loading.loadingItem(index), loadingClient: index => loading.loadingClient(index), clearScene: () => resources.clearScene() };
    await loading.loadingString("sounds"); await registerClientSounds(media, mediaHost);
    await loading.loadingString("graphics"); const { world, particleAnimations } = await registerClientGraphics(media, mediaHost);
    await loading.loadingString("clients"); await registerClients(media, mediaHost);

    // Registered scalar media projections are captured only after their source registration phase.
    const pool = new LocalEntityPool(session.product);
    const prediction: PredictionRuntime = new PredictionRuntime(state, collision, { commands: session.commands,
      ...(options.sourceDebug ? { eventDebug: { kind: "source-debug", module: "cgame",
        showEvents: () => session.cvars.get("showevents")?.value ?? "", print } } : {}),
      settings: () => ({ gameType: staticState.gameType, dmFlags: staticState.dmFlags, demoPlayback: context.demoPlayback,
        noPredict: enabled("cg_nopredict"), synchronousClients: enabled("cg_synchronousClients"), predictItems: enabled("cg_predictItems"),
        pmoveFixed: enabled("pmove_fixed"), pmoveMsec: integer("pmove_msec"), errorDecayInteger: integer("cg_errorDecay"),
        errorDecayValue: numeric("cg_errorDecay"), showMiss: integer("cg_showmiss") }),
      setPmoveMsec: value => setCvar("pmove_msec", String(value)), transitionPlayerState: (current, previous) => playerState.transitionPlayerState(current, previous), warn: print });
    const effects = new ClientEffects(state, pool, media.effects, {
      get noProjectileTrail() { return enabled("cg_noProjectileTrail"); }, get blood() { return enabled("cg_blood"); },
      get gibs() { return enabled("cg_gibs"); }, get scorePlum() { return enabled("cg_scorePlum"); }, hardware: options.hardware,
    }, { randomInteger: () => random.rand(), startSound });
    const marks = new ImpactMarkSystem(new BspMarkProjector(world.markGeometry), {
      clock: () => state.time, enabled: () => enabled("cg_addMarks"), energyShader: () => media.graphics.energyMarkShader });
    const particles = new ParticleSystem(state, { animations: particleAnimations, media: media.particles, prediction, random,
      hardwareType: options.hardware === "ragepro" ? "rage-pro" : "generic", configString, print });
    const localEntities = new LocalEntitySystem(effects, { ...media.localEntities, prediction, collision, audio: { startSound: (pcm, settings) => sound.startSound(pcm, settings) },
      clientNum: state.clientNum, random, marks });
    const weapons: ClientWeaponRuntime = new ClientWeaponRuntime(state, media.weaponRegistry, { prediction, random, localEntities: pool, effects, marks, particles,
      media: media.weapons, startSound, addLoopSound, addRefEntity: entity => resources.addRefEntity(entity), addLight: light => resources.addLight(light), addPoly: poly => resources.addPoly(poly),
      clientInfo: number => clients.clientInfo(number), sound: (path, compressed) => soundBank.sound(path, compressed),
      drawing: { fadeColor: (start, duration) => fadeColor(state.time, start, duration), setColor: color => draw.setColor(color),
        drawPic: (x, y, width, height, shader) => tools.drawPic({ x, y, width, height }, shader), drawStringLength: drawStrlen,
        drawBigStringColor: (x, y, text, color) => tools.drawBigStringColor(x, y, text, color) },
      settings: () => ({ brassTime: integer("cg_brassTime"), railTrailTime: numeric("cg_railTrailTime"), oldRail: enabled("cg_oldRail"),
        noProjectileTrail: enabled("cg_noProjectileTrail"), oldPlasma: enabled("cg_oldPlasma"), oldRocket: enabled("cg_oldRocket"), trueLightning: numeric("cg_trueLightning"),
        drawGun: enabled("cg_drawGun"), fov: integer("cg_fov"), gunX: numeric("cg_gun_x"), gunY: numeric("cg_gun_y"), gunZ: numeric("cg_gun_z"), gunFrame: 0,
        tracerLength: numeric("cg_tracerLength"), tracerWidth: numeric("cg_tracerWidth"), tracerChance: numeric("cg_tracerChance"), hardware: options.hardware }),
    });
    const players = new PlayerPresenter({ state, media: media.players, clients, collision, effects, random, marks,
      ...(session.product === "baseq3" ? { product: "baseq3" } satisfies { product: "baseq3" }
        : { product: "missionpack", missionMedia: media.missionPlayers } satisfies { product: "missionpack"; missionMedia: typeof media.missionPlayers }),
      trace: (start, end, bounds, skip, mask) => prediction.trace(start, end, bounds, skip, mask),
      addEntity: entity => resources.addRefEntity(entity), addLight: light => resources.addLight(light), addPoly: poly => resources.addPoly(poly),
      lightForPoint: point => { const sample = world.lightForPoint(point); if (sample === null) throw new Error("CG_LightVerts requires the world's source light grid"); return sample; },
      addLoopingSound: (entity, origin, velocity, sound) => addLoopSound(entity, origin, velocity, sound, false),
      addPlayerWeapon: (parent, ps, entity, team) => weapons.addPlayerWeapon(parent, ps, entity, team), print,
      settings: () => ({ gameType: staticState.gameType, cameraMode: enabled("cg_cameraMode"), noPlayerAnimations: enabled("cg_noPlayerAnims"),
        animationSpeed: numeric("cg_animSpeed"), swingSpeed: numeric("cg_swingSpeed"), drawFriend: enabled("cg_drawFriend"), shadows: integer("cg_shadows"),
        enableBreath: missionEnabled("cg_enableBreath"), enableDust: missionEnabled("cg_enableDust"), debugPosition: enabled("cg_debugPosition"), debugAnimation: enabled("cg_debugAnim") }),
    });
    const packet = new PacketEntityPresenter(state, media.packet, {
      addRefEntity: entity => resources.addRefEntity(entity), addLight: light => resources.addLight(light),
      updateSoundPosition: (number, position) => sound.updateEntityPosition(number, position), addLoopSound, startSound,
      randomInteger: () => random.rand(), player: entity => players.player(entity),
      missileTrail: (kind, entity, weapon) => weapons.missileTrail(kind, entity, weapon), grappleTrail: (entity, weapon) => weapons.grappleTrail(entity, weapon),
      addEntityWithPowerups: (entity, state, team) => players.addRefEntityWithPowerups(entity, state, team),
    });
    const eventServices = {
      media: media.events, get options() { return { gameType: staticState.gameType, debugEvents: enabled("cg_debugEvents"),
        footsteps: enabled("cg_footsteps"), autoswitch: enabled("cg_autoswitch"), demoPlayback: context.demoPlayback, noPredict: enabled("cg_nopredict"),
        synchronousClients: enabled("cg_synchronousClients"), singlePlayerActive: missionEnabled("cg_singlePlayerActive"), cameraOrbit: enabled("cg_cameraOrbit") }; },
      random, entities: packet, weapons, effects,
      clientInfo: (number: number) => clients.clientInfo(number),
      playerName: (number: number) => infoValueForKey(configString(544 + number), "n"),
      soundConfigString: (index: number) => configString(288 + index), customSound: (number: number, name: string) => clients.customSound(number, name),
      registerSound: (path: string | null, compressed: boolean) => soundBank.sound(path, compressed), startSound,
      stopLoopingSound: (number: number) => sound.stopLoopingSound(number), addBufferedSound: (sound: PcmSound | null) => frameAudio.addBufferedSound(sound), print,
      centerPrint: (text: string, y: number, width: number) => status.centerPrint(text, y, width),
    };
    const events: ClientEventRuntime = new ClientEventRuntime(state, session.product === "baseq3" ? { ...eventServices, get options() { return eventServices.options; }, product: "baseq3" }
      : { ...eventServices, get options() { return eventServices.options; }, product: "missionpack", missionSounds: media.sounds, missionEffects: effects, startLocalSound,
        voiceChatLocal: (mode, voiceOnly, clientNum, color, command) => serverCommands.voiceChatLocal(mode, voiceOnly, clientNum, color, command) });
    const transitionServices = { staticState, events, sounds: media.sounds, medals: media.graphics,
      get showMiss() { return enabled("cg_showmiss"); }, startLocalSound, addBufferedSound: (sound: PcmSound | null) => frameAudio.addBufferedSound(sound), print };
    const playerState: PlayerStateRuntime = new PlayerStateRuntime(state, session.product === "baseq3" ? { ...transitionServices, get showMiss() { return enabled("cg_showmiss"); }, product: "baseq3" }
      : { ...transitionServices, get showMiss() { return enabled("cg_showmiss"); }, product: "missionpack", missionSounds: media.sounds });
    if (menus !== null) { await menus.assetCache(); await menus.loadHudMenu(); }
    const corners = new ClientHudCorners(state, staticState, icons, { readVmCvar: readVm, configString, milliseconds: () => options.clock.milliseconds() });
    const hud = new ClientHud(state, staticState, { icons, status, corners, prediction, weapons, random, readVmCvar: readVm, startLocalSound },
      menus === null ? { kind: "baseq3", scoreboard: new BaseScoreboard(state, staticState, { icons, clients, players, readVmCvar: readVm, configString, sendClientCommand, print }) }
        : { kind: "missionpack", fonts: menus.fonts, menus });
    const graph: LevelGraph = { state, staticState, configuration, media, world, collision, clients, prediction, view, snapshots, packet,
      effects, localEntities, particles, marks, weapons, serverCommands, console, frameAudio, loading, hud, status, tools, commands, context, readVm, menus };
    this.requireActive();
    this.graphOwner = graph;
    loadingPhase = { kind: "constructed", level: this };
    context.loading = false;
    pool.initialize(); marks.reset(); state.infoScreenText = "";
    serverCommands.setConfigValues(); await serverCommands.startMusic(); await loading.loadingString("");
    if (menus !== null) menus.initTeamChat();
    await serverCommands.shaderStateChanged(); sound.clearLoopingSounds(true);
    if (session.gamestateGeneration !== generation || session.serverMessageSequence !== initialMessageSequence) throw new Error("Engine server message parsing must serialize behind CG_Init");
    this.requireActive();
    session.prime(generation);
  }

  private requireActive(): void {
    if (this.closed) throw new Error("Client level is closed");
    if (this.options.session.dropped !== null) throw this.options.session.dropped;
    if (this.options.session.gamestateGeneration !== this.generation) throw new Error("Client level belongs to a stale engine gamestate");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      this.requireActive();
      try {
        return await operation();
      } catch (error: unknown) {
        return this.options.target.fail(error);
      }
    });
    this.tail = result.then(() => undefined, () => { this.closed = true; });
    return result;
  }

  async consoleCommand(argv: readonly string[]): Promise<boolean> {
    const owned = [...argv];
    if (this.disposed) throw new Error("Client level is closed");
    this.registration?.called();
    this.registration?.printCall(CgameExport.ConsoleCommand);
    try {
      if (this.commandOwner === null) throw new Error("CG_ConsoleCommand requires initialized cgame state");
      return await this.commandOwner.console.execute(owned);
    } catch (error: unknown) {
      return this.options.target.fail(error);
    }
  }

  crosshairPlayer(): number { this.requireActive(); this.registration?.called(); this.registration?.printCall(CgameExport.CrosshairPlayer); return this.graph.console.crosshairPlayer(); }
  lastAttacker(): number { this.requireActive(); this.registration?.called(); this.registration?.printCall(CgameExport.LastAttacker); return this.graph.console.lastAttacker(); }

  keyEvent(key: number, down: boolean): Promise<void> {
    return this.enqueue(async () => { this.registration?.called(); this.registration?.printCall(CgameExport.KeyEvent); if (this.graph.menus !== null) await this.graph.menus.keyEvent(key, down); });
  }
  mouseEvent(x: number, y: number): Promise<void> {
    return this.enqueue(async () => { this.registration?.called(); this.registration?.printCall(CgameExport.MouseEvent); if (this.graph.menus !== null) await this.graph.menus.mouseEvent(x, y); });
  }
  eventHandling(type: number): Promise<void> {
    return this.enqueue(async () => { this.registration?.called(); this.registration?.printCall(CgameExport.EventHandling); if (this.graph.menus !== null) await this.graph.menus.eventHandling(type); });
  }

  drawActiveFrame(input: ClientLevelFrame): Promise<void> {
    const frame = { ...input };
    return this.enqueue(() => { this.registration?.called(); this.registration?.printCall(CgameExport.DrawActiveFrame); return this.drawFrame(frame); });
  }

  private async drawFrame(frame: ClientLevelFrame): Promise<void> {
      for (const value of [frame.serverTime, frame.engineFrameNumber]) {
        if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new RangeError("Client frame clocks must be int32");
      }
      const g = this.graph, state = g.state;
      state.time = frame.serverTime; g.context.demoPlayback = frame.demoPlayback;
      g.context.engineFrameNumber = frame.engineFrameNumber;
      await g.configuration.updateCvars();
      if (state.infoScreenText !== "") return this.loadingFrame();
      this.options.sound.clearLoopingSounds(false); this.options.resources.clearScene();
      await g.snapshots.processSnapshots();
      const snapshot = state.snap;
      if (snapshot === null || (snapshot.flags & 2) !== 0) return this.loadingFrame();
      this.options.session.setUserCmdValue(state.weaponSelect, state.zoomSensitivity);
      state.clientFrame = (state.clientFrame + 1) | 0;
      await g.prediction.predictPlayerState();
      g.view.calculateViewValues();
      if (!state.renderingThirdPerson) {
        const damage = g.view.damageBlendBlob(g.media.graphics.viewBloodShader, this.options.hardware === "ragepro");
        if (damage !== null) this.options.resources.addRefEntity(damage);
      }
      if (!state.hyperspace) {
        g.packet.addPacketEntities({ gameType: g.staticState.gameType, smoothClients: g.readVm("cg_smoothClients").integerValue !== 0,
          simpleItems: g.readVm("cg_simpleItems").integerValue !== 0,
          obeliskRespawnDelay: state.product === "missionpack" ? g.readVm("cg_obeliskRespawnDelay").integerValue : 0 });
        for (const poly of g.marks.addMarks()) this.options.resources.addPoly(poly);
        for (const poly of g.particles.addParticles()) this.options.resources.addPoly(poly);
        g.localEntities.addEntities({ time: state.time, frameTime: state.frameTime, viewOrigin: state.refdef.viewOrigin }, {
          addRefEntity: entity => this.options.resources.addRefEntity(entity),
          addLight: light => this.options.resources.addLight(light),
        });
      }
      g.weapons.addViewWeapon(state.predictedPlayerState);
      g.frameAudio.playBufferedSounds(); await g.serverCommands.playBufferedVoiceChats();
      if (state.testModelEntity.model.kind !== "default") { const model = await g.view.addTestModel(); if (model !== null) this.options.resources.addRefEntity(model); }
      const refdef = g.view.finishRefdef();
      g.frameAudio.powerupTimerSounds();
      this.options.sound.setListener(snapshot.playerState.clientNum, refdef.viewOrigin, refdef.viewAxis);
      if (frame.stereo !== "right") {
        state.frameTime = Math.max(0, (state.time - state.oldTime) | 0); state.oldTime = state.time;
        g.status.addLagometerFrameInfo();
      }
      this.fadeTimescale();
      await this.drawActive(frame.stereo);
      if (g.readVm("cg_stats").integerValue !== 0) this.options.session.print(`cg.clientFrame:${state.clientFrame}\n`);
      if (this.options.session.gamestateGeneration !== this.generation) throw new Error("Engine gamestate changed during a client frame");
  }

  private async drawActive(stereo: ClientLevelFrame["stereo"]): Promise<void> {
    const g = this.graph, state = g.state, snapshot = state.snap;
    if (snapshot === null) return this.loadingFrame();
    if (snapshot.playerState.persistant.get(PersistentIndex.PERS_TEAM) === Team.TEAM_SPECTATOR && (snapshot.playerState.pmFlags & MoveFlags.SCOREBOARD) !== 0) {
      g.hud.drawTourneyScoreboard();
      return;
    }
    let separation: number;
    switch (stereo) {
      case "center": separation = 0; break;
      case "left": separation = Math.fround(-g.readVm("cg_stereoSeparation").numericValue / 2); break;
      case "right": separation = Math.fround(g.readVm("cg_stereoSeparation").numericValue / 2); break;
      default: {
        const exhaustive: never = stereo;
        throw new Error("CG_DrawActive: Undefined stereoView", { cause: exhaustive });
      }
    }
    const refdef = state.refdef;
    g.tools.tileClear(refdef);
    const baseOrigin = { ...refdef.viewOrigin };
    if (separation !== 0) refdef.viewOrigin = add3(refdef.viewOrigin, scale3(refdef.viewAxis[1], -separation));
    this.options.resources.renderScene(refdef);
    if (separation !== 0) refdef.viewOrigin = baseOrigin;
    await g.hud.draw2D();
  }

  private async loadingFrame(): Promise<void> {
    await this.graph.loading.drawInformation(this.graph.tools.draw);
  }

  private fadeTimescale(): void {
    const { configuration, state, readVm } = this.graph;
    const end = readVm("cg_timescaleFadeEnd").numericValue, speed = readVm("cg_timescaleFadeSpeed").numericValue;
    let value = readVm("cg_timescale").numericValue;
    if (value === end) return;
    const delta = Math.fround(Math.fround(speed * Math.fround(state.frameTime)) / 1000);
    if (value < end) value = Math.min(end, Math.fround(value + delta));
    else value = Math.max(end, Math.fround(value - delta));
    configuration.setVmNumericValue(ClientVmCvarSymbol.cg_timescale, value);
    if (speed !== 0) this.options.session.cvars.set("timescale", gameFormat("%f", [value]), true);
  }

  async close(): Promise<void> {
    await this.tail;
    if (this.disposed) return;
    this.registration?.called();
    this.registration?.printCall(CgameExport.Shutdown);
    this.retire();
  }

  retire(): void {
    this.closed = true;
    if (this.disposed) return;
    this.disposed = true; this.commandOwner?.menus?.dispose();
    this.commandOwner?.console.dispose(); this.commandOwner?.serverCommands.dispose();
    this.registration?.free();
  }
}
