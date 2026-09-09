import { expect, spyOn, test } from "bun:test";
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
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { Gamestate } from "../src/protocol/server-message.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RendererResources } from "../src/render/world.ts";
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

test.skipIf(!existsSync(dataPath))("actual cgame exports trace source IDs, loading reentry and live debug gating", async () => {
  const trace: string[] = [];
  const registry = new VmRegistry(text => { trace.push(text); });
  const registration = registry.reserve("cgame");
  const originalCalled = registration.called;
  registration.called = () => { originalCalled(); trace.push("called"); };
  registry.debug(1);
  const f = await fixture("baseq3-1", registration);
  try {
    expect(trace).toEqual([]);
    let earlyCommand = false;
    const registerShader = f.resources.registerShader.bind(f.resources);
    f.resources.registerShader = async (...args) => {
      if (!earlyCommand) {
        earlyCommand = true;
        const initializing = f.registeredLevel;
        if (initializing === null) throw new Error("Cgame was not published before shader registration");
        expect(await initializing.consoleCommand(["+zoom"])).toBe(true);
        expect(await initializing.consoleCommand(["-zoom"])).toBe(true);
      }
      return registerShader(...args);
    };
    const level = await f.open();
    expect(earlyCommand).toBe(true);
    expect(trace[0]).toBe("called");
    expect(trace[1]).toBe("VM_Call( 0 )\n");
    expect(trace.filter(text => text === "VM_Call( 0 )\n")).toHaveLength(1);
    expect(trace.filter(text => text === "VM_Call( 3 )\n").length).toBeGreaterThan(0);
    for (let index = 1; index < trace.length; index += 2) {
      expect(trace[index - 1]).toBe("called");
      expect(trace[index]).toMatch(/^VM_Call\( [023] \)\n$/);
    }
    trace.length = 0;
    expect(await level.consoleCommand(["+zoom"])).toBe(true);
    expect(level.state.zoomed).toBe(true);
    level.crosshairPlayer(); level.lastAttacker();
    const key = level.keyEvent(1, true), mouse = level.mouseEvent(2, 3), event = level.eventHandling(0);
    expect(trace).toEqual(["called", "VM_Call( 2 )\n", "called", "VM_Call( 4 )\n", "called", "VM_Call( 5 )\n"]);
    await Promise.all([key, mouse, event]);
    await level.drawActiveFrame({ serverTime: 1234, engineFrameNumber: 1, stereo: "center", demoPlayback: false });
    expect(level.state.time).toBe(1234);
    expect(trace).toEqual([2, 4, 5, 6, 7, 8, 3].flatMap(id => ["called", `VM_Call( ${id} )\n`]));
    registry.debug(0); trace.length = 0;
    await level.consoleCommand(["-zoom"]);
    expect(level.state.zoomed).toBe(false); expect(trace).toEqual(["called"]);
    registry.debug(-1); trace.length = 0;
    await level.close(); await level.close();
    expect(trace).toEqual(["called", "VM_Call( 1 )\n"]);
    expect(registration.binding.kind).toBe("freed");
  } finally { f.registeredLevel?.retire(); f.dispose(); }
}, 20000);

for (const id of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
  test.skipIf(!existsSync(dataPath))(`cgame export ${id}: throwing VM print aborts before its body`, async () => {
    let abort = false;
    const failure = new Error("VM print abort");
    const trace: string[] = [];
    const registry = new VmRegistry(text => { trace.push(text); if (abort) throw failure; });
    const registration = registry.reserve("cgame");
    const originalCalled = registration.called;
    registration.called = () => { originalCalled(); trace.push("called"); };
    registry.debug(1);
    const f = await fixture("baseq3-1", registration);
    try {
      if (id === 0) {
        abort = true;
        await expect(f.open()).rejects.toThrow("VM print abort");
        expect(trace).toEqual(["called", "VM_Call( 0 )\n"]);
        expect(f.session.lifecycle.clientStatic.phase).not.toBe("loading");
        expect(f.registeredLevel?.generation).toBe(0);
      } else {
        const level = await f.open();
        const consoleBody = spyOn(level.graph.console, "execute");
        const crosshairBody = spyOn(level.graph.console, "crosshairPlayer");
        const attackerBody = spyOn(level.graph.console, "lastAttacker");
        const previousTime = level.state.time;
        trace.length = 0; abort = true;
        switch (id) {
          case 1: await expect(level.close()).rejects.toBe(failure); break;
          case 2: await expect(level.consoleCommand(["+zoom"])).rejects.toBe(failure); break;
          case 3: await expect(level.drawActiveFrame({ serverTime: 9876, engineFrameNumber: 1, stereo: "center", demoPlayback: false })).rejects.toBe(failure); break;
          case 4: expect(() => level.crosshairPlayer()).toThrow(failure); break;
          case 5: expect(() => level.lastAttacker()).toThrow(failure); break;
          case 6: await expect(level.keyEvent(1, true)).rejects.toBe(failure); break;
          case 7: await expect(level.mouseEvent(2, 3)).rejects.toBe(failure); break;
          case 8: await expect(level.eventHandling(0)).rejects.toBe(failure); break;
        }
        expect(trace).toEqual(["called", `VM_Call( ${id} )\n`]);
        expect(consoleBody).not.toHaveBeenCalled(); expect(crosshairBody).not.toHaveBeenCalled(); expect(attackerBody).not.toHaveBeenCalled();
        expect(level.state.time).toBe(previousTime);
        expect(registration.binding.kind).toBe("typescript");
        consoleBody.mockRestore(); crosshairBody.mockRestore(); attackerBody.mockRestore();
      }
    } finally { abort = false; f.registeredLevel?.retire(); f.dispose(); }
  }, 20000);
}
