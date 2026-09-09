import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { BackgroundMusic } from "../src/audio/music.ts";
import { CollisionMapLoader } from "../src/collision/map-loader.ts";
import { CollisionCounters } from "../src/collision/counters.ts";
import { ClientLevel } from "../src/cgame/client-level.ts";
import type { ClientLevelOptions } from "../src/cgame/client-level.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import { CommonError } from "../src/core/common-error.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { vec3 } from "../src/core/math.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { Netchannel } from "../src/protocol/netchan.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { Gamestate } from "../src/protocol/server-message.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RendererResources } from "../src/render/world.ts";
import { ServerSnapshotRuntime } from "../src/server/snapshots.ts";
import { ServerClientPhase, ServerStaticState, ServerWorldState } from "../src/server/state.ts";
import { GameType } from "../src/shared/definitions.ts";
import { createGameVerificationHarness } from "../tools/game-verification-harness.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { ClientLevelClockFixture } from "./client-level-clock-fixture.ts";
import { VmRegistry } from "../src/vm/registry.ts";
import type { VmRegistration } from "../src/vm/registry.ts";

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";

async function fixture(gameVersion = "baseq3-1", registration: VmRegistration | null = null) {
  const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "baseq3" });
  const map = parseBsp(await assets.read("maps/q3dm1.bsp"));
  const source = createGameVerificationHarness({ product: "baseq3", map, gameType: GameType.GT_FFA, levelTime: 1000,
    randomSeed: 42, buildDate: "Sep 5 2026", clientNamePrefix: "Failure", botsReason: "No bots in client failure verification",
    });
  const game = source.runtime;
  expect(game.clientConnect(0, true, false)).toBeNull(); game.clientBegin(0);
  const cvars = new CvarRegistry(), lifecycle = new ClientLevelClockFixture(cvars, () => 1000);
  const session = new EngineClientSession({ product: "baseq3", cvars, lifecycle,
    mode: { kind: "network", challenge: 19, qport: 27961 } });
  cvars.register("s_doppler", "1", CvarFlag.Archive);
  const entries: Gamestate["entries"][number][] = [...source.configstrings].map(([index, value]) => ({ kind: "configstring", index, value: index === 20 ? gameVersion : value }));
  entries.push({ kind: "configstring", index: 0, value: "\\mapname\\q3dm1\\g_gametype\\0\\sv_maxclients\\4" },
    { kind: "configstring", index: 1, value: "\\sv_serverid\\100\\sv_cheats\\1\\fs_game\\" });
  const gamestate = encodeServerMessage(0, [{ kind: "gamestate", commandSequence: 0, clientNumber: 0,
    checksumFeed: 0, entries }], { product: "baseq3", messageNumber: 1, reliableSequence: 0, serverCommandSequence: 0,
    parseEntitiesNumber: 0, baseline: () => null, history: () => null });
  const prints: string[] = [], mixer = new AudioMixer(22050, () => 0);
  const soundBank = new ClientSoundBank(assets, { debugPrint: text => { prints.push(text); }, print: text => { prints.push(text); } });
  await soundBank.beginRegistration();
  const music = new BackgroundMusic(() => mixer, () => assets, text => { prints.push(text); });
  const images = new RendererImageCatalog(), recorded = new BatchRecordingBackend(new SoftwareRenderer(160, 120, images));
  const target = new RenderTarget(images, [recorded]), builtins = new BuiltinImages(images, identityImageUploadProfile), settings = createRendererSettings();
  const memory = new HunkArena(64 * 1024 * 1024, text => { prints.push(text); });
  const cinematicOwner = new EngineCinematics({ temporaryMemory: memory, developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: () => 1000 }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  const resources = await RendererResources.create(assets, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, print: text => { prints.push(text); }, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematicOwner.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { prints.push(text); }, clock: { milliseconds: () => 1000 }, identityLight: 1,
    tess: resources.tess, runtime: settings.runtime });
  const observed = { presentations: 0 };
  const sound: ClientLevelOptions["sound"] = {
    bank: soundBank,
    startSound: (pcm, options) => { const resolved = soundBank.resolveForPlayback(pcm); return resolved !== null && mixer.startSound(resolved, options); },
    startLocalSound: (pcm, channel) => { const resolved = soundBank.resolveForPlayback(pcm); return resolved !== null && mixer.startLocalSound(resolved, channel); },
    updateLoopingSound: (pcm, options) => { const resolved = soundBank.resolveForPlayback(pcm); if (resolved !== null) mixer.updateLoopingSound(resolved, options); },
    updateRealLoopingSound: (pcm, options) => { const resolved = soundBank.resolveForPlayback(pcm); if (resolved !== null) mixer.updateRealLoopingSound(resolved, options); },
    clearLoopingSounds: killAll => mixer.clearLoopingSounds(killAll), stopLoopingSound: entity => mixer.stopLoopingSound(entity),
    updateEntityPosition: (entity, origin) => mixer.updateEntityPosition(entity, origin),
    setListener: (entity, origin, axis) => mixer.setListener(entity, origin, axis),
    startBackgroundTrack: async (intro, loop) => { music.start(intro, loop); },
  };
  const collision = new CollisionMapLoader({ files: () => assets, memory: () => resources.memoryProfile, counters: new CollisionCounters(),
    debug: { kind: "disabled" }, developerPrint: () => undefined });
  const options: ClientLevelOptions = { session, assets, resources, commands, sound,
    loadCollisionMap: name => collision.load(name, true).world,
    memory, hardware: "generic", menus: { kind: "baseq3" },
    clock: { milliseconds: () => 1000, serverTime: () => session.serverTime, frameNumber: () => lifecycle.clientStatic.frameCount },
    target, updateLoadingScreen: async drawCgame => {
      await drawCgame();
      commands.submit();
      observed.presentations++;
      resources.tess.endFrame();
    } };
  lifecycle.configure(options);
  let registeredLevel: ClientLevel | null = null;
  if (registration !== null) {
    lifecycle.gamestateReceived = async generation => {
      lifecycle.assertCurrentOperation();
      if (generation !== session.gamestateGeneration) throw new Error("Stale test gamestate");
      registeredLevel = new ClientLevel(options, registration);
      await registeredLevel.initialize();
    };
  }
  return { options, game, session, resources, commands, recorded, observed,
    get registeredLevel(): ClientLevel | null { return registeredLevel; },
    async open(): Promise<ClientLevel> { await session.receiveServerMessage(1, gamestate); return registeredLevel ?? lifecycle.level; },
    dispose(): void {
      try { commands.close("discard"); } finally {
        try { target.close(); } finally {
          try { cinematicOwner.dispose(); } finally { music.stop(); mixer.stopAll(); game.shutdown(false); }
        }
      }
    } };
}

function assertTerminalSubmission(commands: RenderCommandBuffer, failure: Error): void {
  let actual: unknown;
  try { commands.submit(); } catch (error: unknown) { actual = error; }
  if (!(actual instanceof Error)) throw new Error("Terminal queue submission did not reject", { cause: actual });
  expect(actual.message).toBe("Renderer image catalog is poisoned");
  expect(actual.cause).toBe(failure);
}

test.skipIf(!existsSync(dataPath))("CG_Init game-version mismatch preserves the source drop through the session", async () => {
  const f = await fixture("other-game");
  let collisionLoads = 0;
  f.options.loadCollisionMap = () => { collisionLoads++; throw new Error("Version check must precede collision loading"); };
  try {
    const failure = f.open();
    await expect(failure).rejects.toBeInstanceOf(CommonError);
    await expect(failure).rejects.toMatchObject({ code: "drop", message: "Client/Server game mismatch: baseq3-1/other-game" });
    expect(f.session.cvars.get("cg_fov")).toBeDefined();
    expect(collisionLoads).toBe(0); expect(f.observed.presentations).toBe(0);
    expect(f.recorded.trace()).toHaveLength(0);
  } finally { f.dispose(); }
}, 120000);

test.skipIf(!existsSync(dataPath))("registered CG_Init failure retains its actual owner until callback-free retirement", async () => {
  const registry = new VmRegistry(), registration = registry.reserve("cgame");
  const f = await fixture("other-game", registration);
  let calls = 0;
  const called = registration.called;
  registration.called = () => { calls++; called(); };
  try {
    await expect(f.open()).rejects.toMatchObject({ code: "drop", message: "Client/Server game mismatch: baseq3-1/other-game" });
    const owner = f.registeredLevel;
    if (owner === null) throw new Error("CG_Init did not publish its module");
    expect(ClientLevel.registered(registration)).toBe(owner);
    expect(registry.reserve("CGAME")).toBe(registration);
    expect(registration.binding.kind).toBe("typescript");
    expect(calls).toBe(1);
    owner.retire();
    expect(calls).toBe(1);
    expect(registration.binding.kind).toBe("freed");
    expect(ClientLevel.registered(registration)).toBeNull();
  } finally { f.registeredLevel?.retire(); f.dispose(); }
}, 120000);

test.skipIf(!existsSync(dataPath))("registered cgame loading draw and public entries mark calls without marking graph reads", async () => {
  const registry = new VmRegistry(), registration = registry.reserve("cgame");
  const f = await fixture("baseq3-1", registration);
  let calls = 0, loadingDraws = 0;
  const called = registration.called, update = f.options.updateLoadingScreen;
  registration.called = () => { calls++; called(); };
  f.options.updateLoadingScreen = async drawCgame => {
    const owner = ClientLevel.registered(registration);
    expect(owner).toBe(f.registeredLevel);
    expect(owner).not.toBeNull();
    const before = calls;
    await update(drawCgame);
    expect(calls).toBe(before + 1);
    loadingDraws++;
  };
  try {
    const level = await f.open();
    expect(ClientLevel.registered(registration)).toBe(level);
    expect(loadingDraws).toBeGreaterThan(0);
    expect(calls).toBe(loadingDraws + 1);
    const before = calls;
    expect(level.graph.state).toBe(level.state);
    expect(level.graph.staticState).toBe(level.staticState);
    expect(calls).toBe(before);
    expect(await level.consoleCommand(["not_a_cgame_command"])).toBe(false);
    level.crosshairPlayer(); level.lastAttacker();
    await level.keyEvent(0, false); await level.mouseEvent(0, 0); await level.eventHandling(0);
    expect(calls).toBe(before + 6);
    const beforeReinitialization = calls, previousLoadingDraws = loadingDraws;
    await expect(level.initialize()).rejects.toMatchObject({ code: "drop", message: "ERROR: attempted to redundantly load world map\n" });
    expect(ClientLevel.registered(registration)).toBe(level);
    expect(calls).toBe(beforeReinitialization + 1 + loadingDraws - previousLoadingDraws);
    const beforeShutdown = calls;
    await level.close();
    expect(calls).toBe(beforeShutdown + 1);
    expect(registration.binding.kind).toBe("freed");
    expect(ClientLevel.registered(registration)).toBeNull();
  } finally { f.registeredLevel?.retire(); f.dispose(); }
}, 120000);

test.skipIf(!existsSync(dataPath))("CG_Init producer failure prevents later submission of its queued loading picture", async () => {
  const f = await fixture(), failure = new Error("Detail registration failed during CG_Init");
  const registerShader = f.resources.registerShader.bind(f.resources);
  f.resources.registerShader = async name => {
    if (name === "levelShotDetail") throw failure;
    return registerShader(name);
  };
  try {
    await expect(f.open()).rejects.toThrow(failure.message);
    expect(f.observed.presentations).toBe(0); expect(f.recorded.trace()).toHaveLength(0);
    assertTerminalSubmission(f.commands, failure);
    expect(f.recorded.trace()).toHaveLength(0);
  } finally { f.dispose(); }
}, 120000);

test.skipIf(!existsSync(dataPath))("engine loading-screen failure after cgame drawing poisons the shared target before submission", async () => {
  const f = await fixture(), failure = new Error("Engine overlay production failed");
  let loadingDraws = 0;
  f.options.updateLoadingScreen = async drawCgame => {
    await drawCgame();
    loadingDraws++;
    throw failure;
  };
  try {
    // Protocol admission translates the thrown error to a drop; the target retains the producer identity.
    await expect(f.open()).rejects.toThrow(failure.message);
    expect(loadingDraws).toBe(1);
    expect(f.observed.presentations).toBe(0);
    expect(f.recorded.trace()).toHaveLength(0);
    assertTerminalSubmission(f.commands, failure);
    expect(f.session.cvars.get("cg_fov")).toBeDefined();
  } finally { f.dispose(); }
}, 120000);

test.skipIf(!existsSync(dataPath))("failed frame production cannot replay its world after level disposal", async () => {
  const f = await fixture();
  let level: ClientLevel | null = null;
  try {
    level = await f.open();
    const configString = level.graph.configuration.host.configString;
    expect(configString(20)).toBe("baseq3-1"); expect(configString(1023)).toBe("");
    for (const index of [-1, 1024]) {
      expect(() => configString(index)).toThrow(CommonError);
      try { configString(index); } catch (error: unknown) {
        expect(error).toMatchObject({ code: "drop", message: `CG_ConfigString: bad index: ${index}` });
      }
    }
    for (const index of [NaN, 0.5]) expect(() => configString(index)).toThrow(RangeError);
    const statics = new ServerStaticState({ product: "baseq3", maxClients: 4, dedicated: false });
    const world = new ServerWorldState(statics, { print: text => { f.session.print(text); },
      dropClient: (_client, reason) => { throw new Error(reason); } });
    world.game = f.game; world.state = "game"; statics.time = 1050;
    const peer = statics.clients[0];
    if (peer === undefined) throw new Error("Missing real snapshot client");
    const channel = new Netchannel("server", 27961);
    peer.connection = { kind: "initialized", phase: ServerClientPhase.Active, address: { kind: "loopback" }, netchan: channel };
    peer.gameEntity = f.game.data.entity(peer.slot); channel.transmit(new Uint8Array());
    f.session.createUserCommand({ serverTime: 1050, viewAngles: vec3(0, 0, 0), buttons: 0, forwardmove: 0, rightmove: 0, upmove: 0 });
    f.game.runFrame(1050);
    const snapshots = new ServerSnapshotRuntime(world, statics, { collision: f.game.options.collision, spatial: f.game.world, debugPrint: text => { f.session.print(text); } });
    snapshots.buildClientSnapshot(peer);
    const context = snapshots.messageContext(peer);
    f.session.lifecycle.clientStatic.realtime = 1100;
    await f.session.receiveServerMessage(context.messageNumber, encodeServerMessage(0, [snapshots.snapshotOperation(peer)], context));
    await f.session.setCGameTime();
    const failure = new Error("HUD producer failed before frame submission");
    level.graph.hud.draw2D = async () => { throw failure; };
    const draws = f.recorded.trace().length, presentations = f.observed.presentations;
    await expect(level.drawActiveFrame({ serverTime: f.session.serverTime, engineFrameNumber: 2, stereo: "center", demoPlayback: false })).rejects.toBe(failure);
    expect(f.recorded.trace()).toHaveLength(draws); expect(f.observed.presentations).toBe(presentations);
    await level.close();
    assertTerminalSubmission(f.commands, failure);
    expect(f.recorded.trace()).toHaveLength(draws);
  } finally { try { await level?.close(); } finally { f.dispose(); } }
}, 120000);
