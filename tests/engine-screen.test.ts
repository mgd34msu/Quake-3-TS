import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { HunkArena } from "../src/core/hunk.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { ClientKeys } from "../src/engine/client-keys.ts";
import { ClientConnectionState, ClientStaticState } from "../src/engine/client-state.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { EngineConsole } from "../src/engine/console.ts";
import { EngineScreen } from "../src/engine/screen.ts";
import { createEngineScreenDrawing } from "../src/engine/screen-draw.ts";
import { ServerBrowser } from "../src/engine/server-browser.ts";
import { EngineSound } from "../src/engine/sound.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { DedicatedEventSource } from "../src/platform/dedicated-input.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { RendererConfiguration } from "../src/render/configuration.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { RendererResources } from "../src/render/world.ts";
import { BaseUiCvars } from "../src/ui/base/cvars.ts";
import { setCursorToItem } from "../src/ui/base/framework.ts";
import { BaseUiGameInfo } from "../src/ui/base/game-info.ts";
import { BaseUiState } from "../src/ui/base/state.ts";
import { BaseUi } from "../src/ui/base/ui.ts";

function expectPresentedFramebuffer(window: SdlWindow, cpu: SoftwareRenderer): void {
  expect(window.drawableSize).toEqual({ width: cpu.width, height: cpu.height });
  const readback = window.readPixels();
  expect(readback.length).toBe(cpu.pixels.length);
  expect(readback.every((value, index) => index % 4 === 3 || value === cpu.pixels[index])).toBe(true);
  // SDL_BLENDMODE_NONE copies RGBA. Alpha-bearing window targets retain alpha;
  // RGB targets discard it and RGBA readback supplies opaque alpha instead.
  const retainedAlpha = readback.every((value, index) => index % 4 !== 3 || value === cpu.pixels[index]);
  const opaqueAlpha = readback.every((value, index) => index % 4 !== 3 || value === 255);
  expect(retainedAlpha || opaqueAlpha).toBe(true);
}

test("engine screen presents real Main/Setup, connecting and loading overlays through shared common, UI, audio and SDL owners", async () => {
  const homePath = mkdtempSync(join(tmpdir(), "quake3-screen-")), cleanup: (() => void)[] = [];
  const cls = new ClientStaticState(), clc = new ClientConnectionState(), prints: string[] = [];
  let keys: ClientKeys | null = null, con: EngineConsole | null = null, ui: BaseUi | null = null, screen: EngineScreen | null = null;
  const currentKeys = (): ClientKeys => { if (keys === null) throw new Error("Key bootstrap did not run"); return keys; };
  const currentConsole = (): EngineConsole => { if (con === null) throw new Error("Console bootstrap did not run"); return con; };
  const outsideFlow = async (): Promise<never> => { throw new Error("Outside this screen composition flow"); };
  try {
    const common = await CommonConsole.open({
      roots: { dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath, cdPath: null, product: "baseq3" },
      startup: new StartupCommands(""), random: new LinuxNativeRandom(1),
      build: { kind: "client", client: { initializeKeyCommands: () => currentKeys().initializeCommands(),
        writeBindings: write => currentKeys().writeBindings(write), consolePrint: text => currentConsole().print(text), usesUniqueKey: () => 0 } },
      platformPrint: text => { prints.push(text); }, resolveCommand: () => undefined,
      assertCommandEntry: () => {}, assertOwnerEntry: () => {},
    }, owner => {
      cleanup.push(() => owner.close());
      keys = new ClientKeys({ commands: owner.commands, cvars: owner.cvars, print: text => { owner.output.print(text); }, host: {
        readConnection: () => ({ kind: cls.phase, demoPlayback: clc.demoPlaying }), readUi: () => ui, readCgame: () => null,
        assertCurrentOperation: () => { owner.commands.assertCurrentExecution(); }, disconnect: outsideFlow,
        stopAllSounds: () => { throw new Error("Unexpected cinematic shortcut"); }, addReliableCommand: text => { clc.reliable.add(text); },
        toggleConsole: () => currentConsole().toggle(), updateScreen: async () => { if (screen !== null) await screen.update(); },
        consoleScroll: action => currentConsole().scroll(action), readConsoleWidth: () => currentConsole().fieldWidth,
        clipboard: { kind: "native-unix-unavailable" },
      } });
      con = new EngineConsole({ state: cls, keys, cvars: owner.cvars, commands: owner.commands, output: owner.output, host: {
        assertCurrentOperation: () => { owner.commands.assertCurrentExecution(); }, startDemoLoop: outsideFlow, readCgame: () => null,
        snapshotMoveType: () => 0, writableFiles: () => owner.files.writable, version: "Quake III TypeScript",
      } });
    });
    const stdin = new PassThrough(), io = new UnixIo(text => { common.output.print(text); }, new UnixSystemClock(), { stdin, signals: "none" });
    cleanup.push(() => { io.close(); stdin.destroy(); });
    const events = new CommonEvents(new DedicatedEventSource(io), text => { common.output.print(text); });
    const sound = new EngineSound(common, events); cleanup.push(() => sound.close());
    sound.initialize({ sampleRate: 48000, bufferFrames: 256 }); await sound.beginRegistration();
    if (sound.mixer === null) throw new Error("Actual audio did not start");
    const registered = new RegisteredRendererCvars(common.cvars, "linux");
    const window = SdlWindow.open({ title: "Quake III screen", width: 320, height: 180, backend: "cpu", hidden: true });
    cleanup.push(() => window.close());
    const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(320, 180, images), target = new RenderTarget(images, [cpu]);
    cleanup.push(() => target.close());
    const settings = new SourceRendererSettings(registered, cpu.capabilities);
    const configuration = RendererConfiguration.create({ window, renderer: { kind: "cpu", backend: cpu }, settings });
    cleanup.push(() => configuration.close());
    const imageProfile = () => configuration.imageUploadProfile(), builtins = new BuiltinImages(images, imageProfile);
    const memory = new HunkArena(1024 * 1024, text => { common.output.print(text); });
    const movies = new EngineCinematics({ temporaryMemory: memory, developerPrint: text => { const developer = common.cvars.get("developer"); if (developer !== undefined && developer.integerValue !== 0) common.output.print(text); return undefined; }, print: text => { common.output.print(text); return undefined; }, files: { kind: "diagnostic-bytes", reader: common.files.current }, sound: { kind: "diagnostic", readMixer: () => common.sound.mixer }, clock: { sample: () => cls.realtime }, scratchImages: builtins,
      console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
    cleanup.push(() => movies.dispose());
    const resources = await RendererResources.create(common.files.current, { kind: "unaccounted" }, settings,
      { patchMemory: { kind: "source-zone", zone: common.mainZone }, print: text => { common.output.print(text); }, target, images, builtins, shaderCinematics: movies.shaderCinematics, imageProfile,
        drawDebugSurface: () => { throw new Error("Screen fixture has no collision or server debug drawing provider"); } });
    const commands = new RenderCommandBuffer(target, { print: (text: string) => { common.output.print(text); }, clock: { milliseconds: () => cls.realtime }, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
    cleanup.push(() => commands.close("discard"));
    const state = new BaseUiState({ cvars: new BaseUiCvars(common.cvars, () => { common.commands.assertCurrentExecution(); }), keys: currentKeys(),
      clipboard: { kind: "native-unix-unavailable" }, resources, commands, consoleCommands: common.commands, sounds: sound.bank, audio: sound,
      hardware: "generic", readClientPhase: () => cls.phase, print: text => { common.output.print(text); },
      assertCurrentOperation: () => { common.commands.assertCurrentExecution(); } });
    const browser = new ServerBrowser({ io, clientStatic: cls, loopback: new LoopbackTransport(), cvars: common.cvars,
      print: text => { common.output.print(text); }, assertCurrentOperation: () => common.commands.assertCurrentExecution() });
    ui = await BaseUi.create({ state, gameInfo: new BaseUiGameInfo(state, common.files), files: common.files, cdKey: common.cdKey,
      commands: common.commands, hunk: memory, browser, configuration, readSession: () => null });
    const system = movies.attachSystem({ state: () => cls.phase === "cinematic" ? "cinematic" : "other",
      closeMenu: async () => { currentKeys().setCatcher(0); }, enterCinematic: () => { cls.phase = "cinematic"; },
      enterDisconnected: () => { cls.phase = "disconnected"; }, nextMap: () => common.cvars.get("nextmap")?.value ?? "",
      clearNextMap: () => { common.cvars.set("nextmap", "", true); }, appendCommand: text => { common.commands.append(text); },
      stopAllSounds: () => { sound.stopAllSounds(); } });
    for (const [name, value] of [["developer", "0"], ["cl_debugMove", "0"], ["cl_running", "1"], ["cl_conXOffset", "0"]] satisfies readonly (readonly [string, string])[]) common.cvars.register(name, value);
    currentConsole().initialize();
    const drawing = createEngineScreenDrawing({ commands, resources, state: cls, keys: currentKeys(), pictures: {
      charset: resources.picture(await resources.registerShader("gfx/2d/bigchars")),
      white: resources.picture(await resources.registerShader("white")), console: resources.picture(await resources.registerShader("console")),
    } });
    screen = new EngineScreen({ cvars: common.cvars, keys: currentKeys(), console: currentConsole(), sound,
      frameTimings: { frontEndMsec: 0, backEndMsec: 0 },
      readPresentation: () => ({ drawing, configuration, renderer: { kind: "cpu", backend: cpu }, window, cinematics: system }),
      readUi: () => ui, readCgame: () => null,
      readSession: () => null, readConnection: () => clc, print: text => { common.output.print(text); },
      assertCurrentOperation: () => { common.commands.assertCurrentExecution(); } });
    expect(await screen.update()).toBeNull(); screen.initialize(); cls.phase = "disconnected";
    await screen.update(); expect(state.activeMenu).toBe(ui.cdKey.menu);
    await ui.setActiveMenu("main"); cls.realtime = 10;
    expect((await screen.update())?.batches).toBeGreaterThan(0); expect(state.activeMenu).toBe(ui.main.menu);
    expectPresentedFramebuffer(window, cpu);
    const setup = ui.main.menu.items.find(item => item.common.id === 12);
    if (setup === undefined) throw new Error("Missing Main Setup");
    await setCursorToItem(state, ui.main.menu, setup); await currentKeys().keyEvent(KeyCode.Enter, true, 11);
    await currentKeys().keyEvent(KeyCode.Enter, false, 12); await screen.update(); expect(state.activeMenu).toBe(ui.setup.menu);
    await ui.setActiveMenu(0); cls.phase = "connecting"; cls.servername = "localhost"; clc.connectPacketCount = 2;
    expect((await screen.update())?.batches).toBeGreaterThan(0);
    cls.phase = "loading"; let loadingDraws = 0;
    await screen.update(async () => { loadingDraws++; drawing.pixels.fillRect({ x: 0, y: 0, width: 320, height: 180 }, { x: 0.2, y: 0.3, z: 0.4, w: 1 }, drawing.pictures.white); });
    expect(loadingDraws).toBe(1);
    expectPresentedFramebuffer(window, cpu);
    common.cvars.set("debuggraph", "1", true); screen.debugGraph(20, 1);
    currentKeys().setCatcher(KeyCatcher.Console); cls.realFrameTime = 100; currentConsole().run();
    await screen.update(async () => {});
    expectPresentedFramebuffer(window, cpu);
    sound.shutdown(); cls.phase = "disconnected";
    await ui.setActiveMenu("main");
    expect((await screen.update())?.batches).toBeGreaterThan(0);
  } finally { for (const close of cleanup.reverse()) close(); rmSync(homePath, { recursive: true }); }
}, 15000);
