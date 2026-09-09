// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BotMemory } from "../src/botlib/memory.ts";
import { BotScriptSources } from "../src/botlib/script-sources.ts";
import { ScriptGlobalDefines } from "../src/script/preprocessor.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { ClientKeys } from "../src/engine/client-keys.ts";
import { ClientConnectionState, ClientStaticState } from "../src/engine/client-state.ts";
import { EngineSound } from "../src/engine/sound.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { EngineUiCinematics } from "../src/engine/ui-cinematics.ts";
import { ServerBrowser } from "../src/engine/server-browser.ts";
import { DedicatedEventSource } from "../src/platform/dedicated-input.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { RendererConfiguration } from "../src/render/configuration.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RendererResources } from "../src/render/world.ts";
import { TeamArenaUi } from "../src/ui/team-arena/ui.ts";
import { VmRegistry } from "../src/vm/registry.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

// Reuses the real common/renderer/menu-loader composition from team-arena-menu-loader.test.ts.
// The SDL configuration boundary is exercised only with the dummy driver, never a desktop.
test("Team Arena VM_Call traces all source UI export IDs before bodies, including print aborts", async () => {
  if (process.env["SDL_VIDEODRIVER"] !== "dummy") throw new Error("Run this CPU fixture with SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy");
  const homePath = await mkdtemp(join(tmpdir(), "quake3-team-vm-trace-"));
  const cleanup: (() => void)[] = [];
  const print = (): undefined => undefined, current = (): undefined => undefined;
  const unexpected = (): never => { throw new Error("VM trace fixture reached an unrelated client operation"); };
  try {
    const clock = new UnixSystemClock(), stdin = new PassThrough();
    cleanup.push(() => stdin.destroy());
    const io = new UnixIo(print, clock, { stdin, signals: "none" }); cleanup.push(() => io.close());
    const events = new CommonEvents(new DedicatedEventSource(io), print);
    const common = await CommonConsole.open({
      roots: { dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath, cdPath: null, product: "missionpack" },
      startup: new StartupCommands("+set s_initsound 0 +set s_volume 0 +set s_musicvolume 0 +set color1 4"), random: new LinuxNativeRandom(1),
      build: { kind: "dedicated" }, platformPrint: print, resolveCommand: () => undefined,
      assertCommandEntry: current, assertOwnerEntry: current,
    }, current);
    cleanup.push(() => common.close());
    common.hunk.initialize(true, common.files.fileMemory.loadStack);
    const sound = new EngineSound(common, events); sound.initialize({ sampleRate: 48000 });
    const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(320, 240, images);
    const target = new RenderTarget(images, [cpu]); cleanup.push(() => target.close());
    const builtins = new BuiltinImages(images, identityImageUploadProfile), settings = createRendererSettings();
    const movies = new EngineCinematics({ temporaryMemory: common.hunk.accounting.arena, developerPrint: print, print, files: { kind: "diagnostic-bytes", reader: common.files.current },
      sound: { kind: "diagnostic", readMixer: () => sound.mixer }, clock: { sample: () => clock.milliseconds() },
      scratchImages: builtins, console: { kind: "absent" }, settings: { hardware: "generic", maxTextureSize: 4096, inGameVideo: () => 0 } });
    cleanup.push(() => movies.dispose());
    const renderer = await RendererResources.create(common.files.current, { kind: "unaccounted" }, settings,
      { patchMemory: { kind: "source-zone", zone: common.mainZone }, print, imageProfile: identityImageUploadProfile,
        target, images, builtins, drawDebugSurface: unexpected, shaderCinematics: movies.shaderCinematics });
    const commands = new RenderCommandBuffer(target, { print, clock, identityLight: 1, tess: renderer.tess, runtime: settings.runtime });
    cleanup.push(() => commands.close("discard"));
    const window = SdlWindow.open({ title: "Team Arena VM trace", width: 320, height: 240, backend: "cpu", hidden: true });
    cleanup.push(() => window.close());
    const configuration = RendererConfiguration.create({ window, renderer: { kind: "cpu", backend: cpu }, settings });
    cleanup.push(() => configuration.close());
    const keys = new ClientKeys({ commands: common.commands, cvars: common.cvars, print, host: {
      assertCurrentOperation: current, readConnection: () => ({ kind: "disconnected", demoPlayback: false }), readUi: () => null,
      readCgame: () => null, disconnect: unexpected, stopAllSounds: () => { sound.stopAllSounds(); }, addReliableCommand: unexpected,
      toggleConsole: unexpected, updateScreen: unexpected, consoleScroll: unexpected, readConsoleWidth: () => 78,
      clipboard: { kind: "native-unix-unavailable" },
    } });
    const clientStatic = new ClientStaticState(), connection = new ClientConnectionState();
    const browser = new ServerBrowser({ io, clientStatic, loopback: new LoopbackTransport(), cvars: common.cvars, print, assertCurrentOperation: current });
    const memory = new BotMemory(undefined, common.mainZone);
    const sources = new BotScriptSources(common.files.current, new ScriptGlobalDefines(undefined, memory), print, print, memory);
    const traces: string[] = [], order: string[] = [];
    let abort = false;
    let beforePrint: () => void = current;
    const registry = new VmRegistry(text => { traces.push(text); order.push("print"); beforePrint(); if (abort) throw new Error("trace abort"); });
    const registration = registry.reserve("ui"), called = registration.called;
    registration.called = () => { called(); order.push("called"); };
    const ui = new TeamArenaUi({ common, keys, browser, events, systemClock: clock, calendar: clock, configuration, renderer, commands,
      sound, audio: { playLocal: print, startBackground: async () => {}, stopBackground: print }, cinematics: new EngineUiCinematics(movies, "ui"),
      scriptSources: () => sources, readClient: () => ({ readSnapshotClientNumber: () => 0, getConfigString: () => null }),
      readSession: () => null, readRealTime: () => 17, assertCurrentOperation: current }, registration);
    cleanup.push(() => ui.retire());
    expect(TeamArenaUi.registered(registration)).toBe(ui);
    expect(ui.apiVersion()).toBe(6);
    await ui.initialize();
    expect(ui.runtime.snapshot().menus.length).toBeGreaterThan(0);
    expect(traces).toEqual([]);
    const context = { argv: ["unknown_vm_trace_command"], args: [], raw: "unknown_vm_trace_command", append: unexpected, insert: unexpected, assertActive: current };
    // ui_public.h uiExport_t and ui_main.c vmMain list these in precisely this order.
    const calls: readonly (() => unknown)[] = [() => ui.apiVersion(), () => ui.initialize(), () => ui.shutdown(),
      () => ui.keyEvent(0, false), () => ui.mouseEvent(3, 4), () => ui.refresh(123), () => ui.isFullscreen(),
      () => ui.setActiveMenu(0), () => ui.consoleCommand(context), () => ui.drawConnectScreen(true, clientStatic, connection),
      () => ui.usesUniqueKey()];
    const state = () => ({ runtime: ui.runtime, cursorX: ui.menus.cursorX, cursorY: ui.menus.cursorY,
      realTime: ui.refresher.realTime, frameTime: ui.refresher.frameTime, catcher: keys.getCatcher(),
      serverCache: common.files.current.has("servercache.dat") });
    for (const [id, call] of calls.entries()) {
      const body = id === 1 ? spyOn(configuration, "copy") : id === 2 ? spyOn(browser, "saveServersToCache")
        : id === 3 ? spyOn(ui.menus, "keyEvent") : id === 4 ? spyOn(ui.menus, "mouseEvent")
        : id === 5 ? spyOn(ui.refresher, "refresh") : id === 6 ? spyOn(ui.menus, "isFullscreen")
        : id === 7 ? spyOn(ui.menus, "setActiveMenu") : id === 8 ? spyOn(ui.consoleCommands, "run")
        : id === 9 ? spyOn(ui.connectScreen, "draw") : null;
      beforePrint = () => { if (body !== null) expect(body.mock.calls.length).toBe(0); };
      registry.debug(1); abort = true; traces.length = 0; order.length = 0;
      const before = state();
      await expect(Promise.resolve().then(call)).rejects.toThrow("trace abort");
      expect(traces).toEqual([`VM_Call( ${id} )\n`]);
      expect(order).toEqual(["called", "print"]);
      expect(state()).toEqual(before);
      abort = false; traces.length = 0; order.length = 0;
      const result = await call();
      if (id === 0) expect(result).toBe(6);
      if (id === 10) expect(result).toBe(1);
      expect(traces).toEqual([`VM_Call( ${id} )\n`]);
      expect(order).toEqual(["called", "print"]);
      if (body !== null) { expect(body.mock.calls.length).toBe(1); body.mockRestore(); }
      if (id === 5) expect(ui.refresher.realTime).toBe(123);
    }
    beforePrint = current;
    expect(ui.menus.cursorX).toBe(3);
    expect(ui.menus.cursorY).toBe(4);
    expect(ui.refresher.realTime).toBe(17);
    registry.debug(0); traces.length = 0;
    await ui.mouseEvent(2, 1);
    expect(traces).toEqual([]);
    expect([ui.menus.cursorX, ui.menus.cursorY]).toEqual([5, 5]);
  } finally {
    try { for (const close of cleanup.reverse()) close(); }
    finally { await rm(homePath, { recursive: true, force: true }); }
  }
}, 120_000);
