import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { BackgroundMusic } from "../src/audio/music.ts";
import { CollisionMapLoader } from "../src/collision/map-loader.ts";
import { CollisionCounters } from "../src/collision/counters.ts";
import type { ClientLevelOptions } from "../src/cgame/client-level.ts";
import { ClientLevelClockFixture } from "./client-level-clock-fixture.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { vec3, vec4 } from "../src/core/math.ts";
import { encodePng } from "../src/core/png.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { EngineUiCinematics } from "../src/engine/ui-cinematics.ts";
import { Netchannel } from "../src/protocol/netchan.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { Gamestate, ServerMessageContext } from "../src/protocol/server-message.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RendererResources } from "../src/render/world.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { ServerSnapshotRuntime } from "../src/server/snapshots.ts";
import { ServerClientPhase, ServerStaticState, ServerWorldState } from "../src/server/state.ts";
import { EntityEvent, GameType, PersistentIndex, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { createGameVerificationHarness } from "../tools/game-verification-harness.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
function at<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index]; if (value === undefined) throw new Error(`Missing test slot ${index}`); return value;
}
for (const { product, emptyName } of [
  { product: "baseq3", emptyName: false }, { product: "baseq3", emptyName: true }, { product: "missionpack", emptyName: false },
] satisfies readonly { readonly product: Product; readonly emptyName: boolean }[]) {
  test.skipIf(!existsSync(dataPath))(`${product}${emptyName ? " empty loading name" : ""}: GameRuntime packets initialize and drive the actual client level`, async () => {
    const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    const map = parseBsp(await assets.read("maps/q3dm1.bsp"));
    const fixture = createGameVerificationHarness({ product, map, gameType: GameType.GT_FFA, levelTime: 1000,
      randomSeed: 42, buildDate: "Sep 5 2026", clientNamePrefix: "Level", botsReason: "No bots in this client composition gate",
      });
    const game = fixture.runtime; expect(game.clientConnect(0, true, false)).toBeNull(); game.clientBegin(0);
    let milliseconds = 1000;
    const cvars = new CvarRegistry(), lifecycle = new ClientLevelClockFixture(cvars, () => milliseconds);
    const session = new EngineClientSession({ product, cvars, lifecycle, mode: { kind: "network", challenge: 19, qport: 27961 } });
    cvars.register("s_doppler", "1", CvarFlag.Archive);
    const prints: string[] = [], mixer = new AudioMixer(22050, () => 0), soundBank = new ClientSoundBank(assets, { debugPrint: text => { prints.push(text); }, print: text => prints.push(text) });
    const loadingOrder: string[] = [], clearLoops = mixer.clearLoopingSounds.bind(mixer), currentSnapshot = session.snapshots.current.bind(session.snapshots);
    mixer.clearLoopingSounds = killAll => { loadingOrder.push(`clear:${killAll}`); clearLoops(killAll); };
    session.snapshots.current = () => { loadingOrder.push("snapshots"); return currentSnapshot(); };
    await soundBank.beginRegistration();
    const music = new BackgroundMusic(() => mixer, () => assets, text => { prints.push(text); });
    fixture.configstrings.set(289, "sound/misc/talk.wav");
    if (emptyName) {
      const playerInfo = fixture.configstrings.get(544);
      if (playerInfo === undefined || !/(^|\\)n\\/.test(playerInfo)) throw new Error("Missing real player name configstring");
      fixture.configstrings.set(544, playerInfo.replace(/(^|\\)n\\[^\\]*/, "$1n\\"));
    }
    const entries: Gamestate["entries"][number][] = [...fixture.configstrings].map(([index, value]) => ({ kind: "configstring", index, value }));
    entries.push({ kind: "configstring", index: 0, value: "\\mapname\\q3dm1\\g_gametype\\0\\sv_maxclients\\4\\sv_hostname\\Composition" },
      { kind: "configstring", index: 1, value: `\\sv_serverid\\100\\sv_cheats\\1\\fs_game\\${product === "missionpack" ? "missionpack" : ""}` });
    const initial: Gamestate = { kind: "gamestate", commandSequence: 0, clientNumber: 0, checksumFeed: 0, entries };
    const initialContext: ServerMessageContext = { product, messageNumber: 1, reliableSequence: 0, serverCommandSequence: 0,
      parseEntitiesNumber: 0, baseline: () => null, history: () => null };
    const width = 160, height = 120;
    const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Actual client level", width, height, backend: "gl", hidden: true }) : null;
    const images = new RendererImageCatalog();
    const gl = window === null ? null : new GlRenderer(window, images);
    const settings = createRendererSettings();
    gl?.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
      if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
    });
    const alphaBits = gl?.alphaBits ?? 8;
    if (alphaBits !== 0 && alphaBits !== 8) throw new RangeError(`CPU/GL comparison requires 0 or 8 framebuffer alpha bits; OpenGL reports ${alphaBits}`);
    const cpu = new SoftwareRenderer(width, height, images, gl?.subpixelBits ?? 8, 0, alphaBits);
    const recorded = new BatchRecordingBackend(cpu);
    const target = gl === null ? new RenderTarget(images, [recorded]) : new RenderTarget(images, [recorded, gl]);
    const builtins = new BuiltinImages(images, identityImageUploadProfile);
    // Arena is real; source CM/render reservation accounting is a separate integration gate.
    const memory = new HunkArena(64 * 1024 * 1024, text => prints.push(text));
    const cinematicOwner = new EngineCinematics({ temporaryMemory: memory, developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: () => milliseconds }, scratchImages: builtins,
      console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
    const cinematics = new EngineUiCinematics(cinematicOwner, "cgame");
    const resources = await RendererResources.create(assets, { kind: "unaccounted" }, settings,
      { patchMemory: { kind: "diagnostic" }, print: text => { prints.push(text); }, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematicOwner.shaderCinematics });
    const registerShader = resources.registerShader.bind(resources);
    let earlyCommands = false, levelInitializing = false;
    resources.registerShader = async (...args) => {
      if (levelInitializing && !earlyCommands) {
        earlyCommands = true;
        expect(await lifecycle.level.consoleCommand(["unknown_cgame_command"])).toBe(false);
        expect(await lifecycle.level.consoleCommand(["+zoom"])).toBe(true);
        expect(await lifecycle.level.consoleCommand(["-zoom"])).toBe(true);
        expect(await lifecycle.level.consoleCommand(["sizeup"])).toBe(true);
        expect(cvars.get("cg_viewsize")?.value).toBe("10");
        cvars.set("cg_viewsize", "100");
      }
      return registerShader(...args);
    };
    const commands = new RenderCommandBuffer(target, { print: (text: string) => { prints.push(text); }, clock: { milliseconds: () => milliseconds }, identityLight: 1,
      tess: resources.tess, runtime: settings.runtime });
    const screenWhite = resources.picture(await resources.registerShader("white"));
    let presentations = 0, endFrames = 0;
    const endFrame = resources.tess.endFrame.bind(resources.tess);
    resources.tess.endFrame = () => { endFrames++; endFrame(); };
    // This offscreen caller owns submission and end-of-frame, not cgame.
    const present = () => {
      const receipt = commands.submitFrame();
      if (receipt === null) throw new Error("Client-level frame exceeded the renderer command allocation");
      presentations++;
      if (presentations === 1) cvars.set("cg_fov", "110");
      resources.rolloverFrame();
      return receipt;
    };
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
    const options: ClientLevelOptions = { session, assets, resources, commands, sound, memory, hardware: "generic",
      loadCollisionMap: name => collision.load(name, true).world,
      clock: { milliseconds: () => milliseconds, serverTime: () => session.serverTime, frameNumber: () => lifecycle.clientStatic.frameCount }, target,
      updateLoadingScreen: async drawCgame => {
        expect(await lifecycle.level.consoleCommand(["unknown_cgame_command"])).toBe(false);
        expect(await lifecycle.level.consoleCommand(["+zoom"])).toBe(true);
        expect(await lifecycle.level.consoleCommand(["-zoom"])).toBe(true);
        const before = presentations, ended = endFrames, draws = recorded.trace().length;
        await drawCgame();
        expect(presentations).toBe(before);
        expect(endFrames).toBe(ended);
        expect(recorded.trace()).toHaveLength(draws);
        commands.draw2D("pixels").fillRect({ x: 0, y: 0, width: 4, height: 4 }, vec4(1, 0, 1, 1), screenWhite);
        present();
        expect([...cpu.pixels.slice(0, 4)]).toEqual([255, 0, 255, 255]);
      },
      menus: product === "baseq3" ? { kind: "baseq3" } : { kind: "missionpack", cinematics,
        setKeyCatcher: mask => prints.push(`keycatcher:${mask}`), audio: {
          playLocal: handle => {
            const pcm = typeof handle === "number" ? soundBank.soundForIndex(handle) : handle;
            if (typeof handle === "number" && pcm === undefined) return;
            sound.startLocalSound(pcm ?? null, 6);
          },
          startBackground: async path => { music.start(path, path); }, stopBackground: () => music.stop(),
        } },
    };
    lifecycle.configure(options);
    levelInitializing = true;
    await session.receiveServerMessage(1, encodeServerMessage(0, [initial], initialContext)).catch((error: unknown) => {
      commands.close("discard");
      try { target.close(); } finally { cinematicOwner.dispose(); window?.close(); }
      throw error;
    });
    const level = lifecycle.level;
    try {
      expect(presentations).toBeGreaterThan(6); expect(level.state.infoScreenText).toBe("");
      expect(level.graph.configuration.readVmCvar("cg_fov").numericValue).toBe(110);
      expect(loadingOrder).toEqual(emptyName ? ["clear:false", "snapshots", "clear:false", "snapshots", "clear:true"] : ["clear:false", "snapshots", "clear:true"]);
      cvars.set("cg_fov", "90");
      expect(level.state.snap).toBeNull(); expect(level.staticState.clientInfo[0]?.infoValid).toBe(true);
      milliseconds = 1050;
      const beforeLoading = presentations, loadingDraws = recorded.trace().length;
      await level.drawActiveFrame({ serverTime: 1000, engineFrameNumber: 9, stereo: "center", demoPlayback: false });
      expect(presentations).toBe(beforeLoading); expect(recorded.trace()).toHaveLength(loadingDraws);
      const loadingReceipt = present();
      expect(loadingReceipt.views).toBe(0); expect(loadingReceipt.batches).toBeGreaterThan(0); expect(level.state.clientFrame).toBe(0);
      const observedFrameTimes: number[] = [], addLocal = level.graph.localEntities.addEntities.bind(level.graph.localEntities);
      level.graph.localEntities.addEntities = (frame, scene) => { observedFrameTimes.push(frame.frameTime); addLocal(frame, scene); };
      cvars.setCheatsEnabled(false);
      cvars.set("timescale", "2", true); cvars.set("cg_timescaleFadeEnd", "1", true); cvars.set("cg_timescaleFadeSpeed", "0.5", true);
      const registration = session.takeEvents();
      expect(registration.some(event => event.kind === "register-cgame-command" && event.name === "testmodel")).toBe(true);
      const statics = new ServerStaticState({ product, maxClients: 4, dedicated: false });
      const world = new ServerWorldState(statics, { print: text => prints.push(text), dropClient: (_client, reason) => { throw new Error(reason); } });
      world.game = game; world.state = "game"; statics.time = 1000;
      const peer = at(statics.clients, 0), channel = new Netchannel("server", 27961);
      peer.connection = { kind: "initialized", phase: ServerClientPhase.Active, address: { kind: "loopback" }, netchan: channel }; peer.gameEntity = game.data.entity(peer.slot);
      // The first server channel sequence carried the gamestate above.
      channel.transmit(new Uint8Array());
      const server = new ServerSnapshotRuntime(world, statics, { collision: game.options.collision, spatial: game.world, debugPrint: text => prints.push(text) });
      session.createUserCommand({ serverTime: 1050, viewAngles: vec3(0, 0, 0), buttons: 0, forwardmove: 0, rightmove: 0, upmove: 0 });
      statics.time = 1050; game.runFrame(1050);
      game.pool.tempEntity(game.pool.at(0).r.currentOrigin, EntityEvent.EV_GLOBAL_SOUND).s.eventParm = 1;
      server.buildClientSnapshot(peer);
      const operation = server.snapshotOperation(peer), context = server.messageContext(peer);
      lifecycle.clientStatic.realtime = 1100;
      await session.receiveServerMessage(context.messageNumber, encodeServerMessage(0, [operation], context));
      await session.setCGameTime();
      expect(session.serverTime).toBe(1050); expect(lifecycle.clientStatic.phase).toBe("active");
      const frameTraceStart = recorded.trace().length;
      commands.addView({ viewport: { x: 0, y: 0, width, height }, clear: { stencil: false, color: vec4(0, 0, 0, 1), depth: 1 }, operations: [{ kind: "draw", batches: [] }] });
      milliseconds = 1100;
      const beforeActive = presentations, endedBeforeActive = endFrames;
      await level.drawActiveFrame({ serverTime: session.serverTime, engineFrameNumber: 10, stereo: "center", demoPlayback: false });
      expect(presentations).toBe(beforeActive); expect(recorded.trace()).toHaveLength(frameTraceStart);
      expect(endFrames).toBe(endedBeforeActive);
      const receipt = present();
      const renderedViews = recorded.trace().slice(frameTraceStart);
      expect(level.state.snap?.playerState.health).toBe(operation.snapshot.playerState.stats.get(statSchema(product).health));
      expect(level.state.clientFrame).toBe(1); expect(level.state.frameTime).toBe(1050);
      expect(observedFrameTimes).toEqual([0]); expect(session.userCmdSensitivity).toBe(0);
      expect(cvars.get("timescale")?.value).toBe("1.475000");
      expect(receipt.views).toBeGreaterThan(1);
      expect(renderedViews.some(view => view.state.clear !== null && view.batches.length > 0)).toBe(true);
      expect(cpu.pixels.filter((value, index) => index % 4 !== 3 && value > 20).length).toBeGreaterThan(1000);
      expect(mixer.mix(2048).some(value => value !== 0)).toBe(true);
      const capture = process.env["QUAKE_CLIENT_CAPTURE"];
      if (capture !== undefined) await Bun.write(`${capture}.${product}.cpu.png`, encodePng(width, height, cpu.pixels));
      if (gl !== null) {
        const actual = gl.readPixels(); let sum = 0, maximum = 0;
        for (let i = 0; i < actual.length; i++) { const error = Math.abs(at(actual, i) - at(cpu.pixels, i)); sum += error; maximum = Math.max(maximum, error); }
        console.log(`${product} client frame CPU ${createHash("sha256").update(cpu.pixels).digest("hex")} GL ${createHash("sha256").update(actual).digest("hex")} mean ${sum / actual.length} max ${maximum}`);
        if (capture !== undefined) await Bun.write(`${capture}.${product}.gl.png`, encodePng(width, height, actual));
        if (process.env["QUAKE_CLIENT_PIXEL_PROBE"] === "1") {
          const errors: { index: number; error: number }[] = [];
          for (let index = 0; index < actual.length; index++) errors.push({ index, error: Math.abs(at(actual, index) - at(cpu.pixels, index)) });
          console.log(errors.sort((a, b) => b.error - a.error).slice(0, 12).map(({ index, error }) => ({ x: Math.floor(index / 4) % width,
            y: Math.floor(index / 4 / width), channel: index % 4, error, cpu: at(cpu.pixels, index), gl: at(actual, index) })));
          console.log(renderedViews.map(view => ({ viewport: view.state.viewport, batches: view.batches.map(batch => ({
            image: batch.texture.kind === "bind-image" ? batch.texture.image : batch.texture.kind, state: batch.state,
          })) })));
        }
        expect(sum / actual.length).toBeLessThan(0.2); expect(maximum).toBeLessThanOrEqual(14);
      }
      const before = presentations;
      const geometry = () => JSON.stringify(renderedViews.map(view => view.batches.map(batch => batch.vertices)));
      const originalGeometry = geometry();
      milliseconds = 1130;
      const first = level.drawActiveFrame({ serverTime: 1060, engineFrameNumber: 11, stereo: "center", demoPlayback: false });
      const second = level.drawActiveFrame({ serverTime: 1080, engineFrameNumber: 12, stereo: "center", demoPlayback: false });
      await first;
      present();
      await second;
      expect(presentations - before).toBe(1);
      commands.draw2D("pixels").fillRect({ x: 0, y: 0, width: 4, height: 4 }, vec4(1, 0, 1, 1), screenWhite);
      present();
      expect([...cpu.pixels.slice(0, 4)]).toEqual([255, 0, 255, 255]);
      expect(level.state.time).toBe(1080); expect(level.state.frameTime).toBe(20); expect(level.state.clientFrame).toBe(3);
      expect(presentations - before).toBe(2);
      expect(observedFrameTimes).toEqual([0, 1050, 10]); expect(session.userCmdSensitivity).toBe(1);
      expect(geometry()).toBe(originalGeometry);
      expect(await level.consoleCommand(["+zoom"])).toBe(true); expect(level.state.zoomed).toBe(true);
      level.state.crosshairClientNum = 3; level.state.crosshairClientTime = level.state.time;
      expect(level.crosshairPlayer()).toBe(3);
      level.state.crosshairClientTime = level.state.time - 1001;
      expect(level.crosshairPlayer()).toBe(-1);
      level.state.attackerTime = 0; expect(level.lastAttacker()).toBe(-1);
      level.state.attackerTime = level.state.time;
      expect(level.lastAttacker()).toBe(operation.snapshot.playerState.persistant.get(PersistentIndex.PERS_ATTACKER));
      const beforeInput = presentations;
      await level.eventHandling(1);
      expect(level.staticState.eventHandling).toBe(product === "missionpack" ? 1 : 0);
      level.state.showScores = true; level.staticState.cursorX = 0; level.staticState.cursorY = 0;
      await Promise.all([level.mouseEvent(3, 4), level.mouseEvent(5, 7), level.keyEvent(0, false)]);
      expect([level.staticState.cursorX, level.staticState.cursorY]).toEqual(product === "missionpack" ? [8, 11] : [0, 0]);
      level.state.showScores = false; await level.eventHandling(0);
      expect(level.staticState.eventHandling).toBe(0); expect(presentations).toBe(beforeInput);
      if (product === "missionpack") {
        await music.start("music/fla22k_01_intro.wav", "music/fla22k_01_intro.wav"); music.update();
        const queuedMusic = mixer.rawEnd;
        expect(queuedMusic).toBeGreaterThan(0);
        const stopSlot = cinematicOwner.stopSlot.bind(cinematicOwner);
        let cinematicStops = 0;
        cinematicOwner.stopSlot = handle => { cinematicStops++; return stopSlot(handle); };
        try { await level.close(); } finally { cinematicOwner.stopSlot = stopSlot; }
        expect(cinematicStops).toBe(0);
        expect(music.isPlaying).toBe(true); expect(mixer.rawEnd).toBe(queuedMusic);
      }
      // Map replacement requires EngineClient's renderer/hunk restart, outside this level-only caller.
      await lifecycle.close();
      await expect(level.drawActiveFrame({ serverTime: 1100, engineFrameNumber: 13, stereo: "center", demoPlayback: false })).rejects.toThrow("closed");
      expect(session.dropped).toBeNull();
      await level.close();
      await expect(level.drawActiveFrame({ serverTime: 1100, engineFrameNumber: 13, stereo: "center", demoPlayback: false })).rejects.toThrow("closed");
      // Closing a level does not release the engine's renderer queue or target.
      commands.addView({ viewport: { x: 0, y: 0, width, height }, clear: { stencil: false, color: vec4(0, 0, 0, 1), depth: 1 }, operations: [{ kind: "draw", batches: [] }] });
      expect(commands.submit().views).toBe(1);
    } finally {
      try { await lifecycle.close(); } finally {
        commands.close("discard");
        try { target.close(); } finally { cinematicOwner.dispose(); window?.close(); }
      }
    }
  }, 120000);
}
