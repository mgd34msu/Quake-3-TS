// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotMemory } from "../src/botlib/memory.ts";
import { BotScriptSources } from "../src/botlib/script-sources.ts";
import { ScriptGlobalDefines } from "../src/script/preprocessor.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { CommonParseState } from "../src/core/common-parse.ts";
import { KeyCode } from "../src/core/key-codes.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { ClientKeys, keynumToString } from "../src/engine/client-keys.ts";
import { EngineSound } from "../src/engine/sound.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { EngineUiCinematics } from "../src/engine/ui-cinematics.ts";
import { ClientStaticState } from "../src/engine/client-state.ts";
import { ServerBrowser } from "../src/engine/server-browser.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { DedicatedEventSource } from "../src/platform/dedicated-input.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { UiAssetRegistry } from "../src/render/font.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RendererResources } from "../src/render/world.ts";
import { loadMenuDefinitions, type UiMenuDefinition } from "../src/ui/menu.ts";
import { UiRuntime } from "../src/ui/runtime.ts";
import { UiMenuCommand } from "../src/ui/public.ts";
import { TeamArenaUiCvars } from "../src/ui/team-arena/cvars.ts";
import { TeamArenaCatalog } from "../src/ui/team-arena/catalog.ts";
import { TeamArenaGameInfo, TeamArenaMenuBuffer } from "../src/ui/team-arena/game-info.ts";
import { TeamArenaUiMemory } from "../src/ui/team-arena/memory.ts";
import { TeamArenaUiMenuLoader } from "../src/ui/team-arena/menu-loader.ts";
import { TeamArenaMenuController } from "../src/ui/team-arena/menu-controller.ts";
import { TeamArenaPlayerList } from "../src/ui/team-arena/player-list.ts";
import { TeamArenaUiRefresh } from "../src/ui/team-arena/refresh.ts";
import { TeamArenaServerBrowser } from "../src/ui/team-arena/server-browser.ts";
import { TeamArenaServerStatus } from "../src/ui/team-arena/server-status.ts";
import { TeamArenaConsoleCommands } from "../src/ui/team-arena/console-commands.ts";
import { TeamArenaPostGame } from "../src/ui/team-arena/postgame.ts";
import { TeamArenaScores } from "../src/ui/team-arena/scores.ts";
import { TeamArenaUiResources } from "../src/ui/team-arena/resources.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";

test.each(["resource aliases", "item reloads"])("Team Arena source allocation permits UI quota regression: %s", async scenario => {
  const directory = await mkdtemp(join(tmpdir(), "quake3-ui-source-quota-"));
  await mkdir(join(directory, "baseq3"));
  await writeFile(join(directory, "baseq3", "default.cfg"), "\n");
  await writeFile(join(directory, "baseq3", "productid.txt"), SOURCE_PRODUCT_ID);
  const printed: string[] = [], clock = new UnixSystemClock();
  const print = (text: string): undefined => { printed.push(text); };
  const current = (): undefined => undefined;
  const unexpected = (): never => { throw new Error("Empty quota menus reached an unrelated callback"); };
  const io = new UnixIo(print, clock, { signals: "none" });
  const events = new CommonEvents(new DedicatedEventSource(io), print);
  const common = await CommonConsole.open({
    roots: { dataPath: directory, homePath: directory, cdPath: null, product: "missionpack" },
    startup: new StartupCommands("+set s_initsound 0"), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
    platformPrint: print, resolveCommand: () => undefined, assertCommandEntry: current, assertOwnerEntry: current,
  }, current);
  common.hunk.initialize(true, common.files.fileMemory.loadStack);
  const sound = new EngineSound(common, events), images = new RendererImageCatalog();
  const target = new RenderTarget(images, [new SoftwareRenderer(1, 1, images)]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile);
  const movies = new EngineCinematics({ temporaryMemory: common.hunk.accounting.arena, developerPrint: print, print,
    files: { kind: "diagnostic-bytes", reader: common.files.current }, sound: { kind: "diagnostic", readMixer: () => null },
    clock: { sample: () => 0 }, scratchImages: builtins, console: { kind: "absent" },
    settings: { hardware: "generic", maxTextureSize: 4096, inGameVideo: () => 1 } });
  let runtime: UiRuntime | undefined, resources: TeamArenaUiResources | undefined;
  const scriptMemory = new BotMemory(undefined, common.mainZone);
  const sourceOwner = new BotScriptSources(common.files.current, new ScriptGlobalDefines(undefined, scriptMemory),
    (_severity, text) => { print(text); }, print, scriptMemory);
  try {
    const renderer = await RendererResources.create(common.files.current, { kind: "unaccounted" }, createRendererSettings(),
      { patchMemory: { kind: "source-zone", zone: common.mainZone }, print, imageProfile: identityImageUploadProfile,
        target, images, builtins, drawDebugSurface: unexpected, shaderCinematics: movies.shaderCinematics });
    const cvars = new TeamArenaUiCvars(common.cvars, current), cinematics = new EngineUiCinematics(movies, "ui");
    resources = new TeamArenaUiResources({ renderer, sound, fontRegistry: new UiAssetRegistry(renderer, print),
      cinematics, cvars, assertCurrentOperation: current });
    const memory = new TeamArenaUiMemory("qvm32", print), random = { nextInt: () => 0 };
    const empty = await loadMenuDefinitions({ random, resolver: { resolveRoot: unexpected, resolve: unexpected } },
      { kind: "ui", setPaths: [] }, {}, { memory: { kind: "qvm32", memory } });
    runtime = await UiRuntime.create({ definitions: empty, cvars: common.cvars, commands: common.commands, resources,
      fonts: resources.fonts, widgetAssets: resources.widgetAssets, zeroPicture: renderer.picture(null), cinematics,
      context: { kind: "ui", bindings: { keyName: keynumToString, getBinding: () => "", setBinding: unexpected,
        getOverstrike: () => false, setOverstrike: unexpected }, pause: unexpected },
      audio: { playLocal: unexpected, startBackground: unexpected, stopBackground: unexpected },
      paintModel: unexpected, getTeamColor: unexpected, externalScript: { run: unexpected },
      feeder: { count: unexpected, item: unexpected, image: unexpected, select: unexpected },
      ownerDraw: { visible: unexpected, width: unexpected, value: unexpected, handleKey: unexpected, paint: unexpected,
        closeCinematic: unexpected },
    });
    const published: UiMenuDefinition[] = [], append = runtime.appendMenu.bind(runtime);
    runtime.appendMenu = async (definition, ownership) => { await append(definition, ownership); published.push(definition); };
    const loader = new TeamArenaUiMenuLoader({ scriptSources: () => sourceOwner, memory, resources, cvars, runtime, random,
      systemClock: clock, print, error: text => { throw new Error(text); }, assertCurrentOperation: current });
    const write = (path: string, text: string): void => {
      const file = common.files.writable.openBinaryWrite(path);
      if (file === null) throw new Error("Quota menu source could not be written");
      try { file.writeBytes(new TextEncoder().encode(text)); } finally { file.close(); }
    };
    write("ui/quota.txt", 'loadMenu { "ui/quota.menu" }');
    if (scenario === "resource aliases") {
      const paths = Array.from({ length: 4097 }, (_, index) => `q_missing.${index.toString().padStart(4, "0")}`);
      const registered: (string | null)[] = [], register = renderer.registerShaderNoMip.bind(renderer);
      renderer.registerShaderNoMip = async path => { registered.push(path); return register(path); };
      const beforeImages = images.registeredImages().length, beforeShaders: string[] = [];
      renderer.listShaders(false, text => { beforeShaders.push(text); });
      write("ui/quota.menu", `assetGlobalDef { ${paths.map(path => `gradientbar "${path}"`).join("\n")} }`);
      await loader.load("ui/quota.txt", true);
      expect(registered).toEqual(paths);
      expect(resources.registeredPicture("q_missing.4096")).toBeUndefined();
      expect(memory.stringBytes).toBe(4097 * 15);
      expect(memory.allocatedBytes).toBe(4097 * 16);
      expect(memory.outOfMemory).toBe(false);
      expect(images.registeredImages()).toHaveLength(beforeImages);
      const afterShaders: string[] = [];
      renderer.listShaders(false, text => { afterShaders.push(text); });
      expect(afterShaders.filter(line => line.includes("q_missing"))).toHaveLength(1);
      expect(afterShaders.filter(line => line.startsWith(": ")).length
        - beforeShaders.filter(line => line.startsWith(": ")).length).toBe(1);
      expect(runtime.menuCount()).toBe(0);
    } else {
      const sourceParser = new CommonParseState();
      const gameInfo = new TeamArenaGameInfo({ menuBuffer: new TeamArenaMenuBuffer(common.files, print, current),
        sourceParser, memory, resources: renderer, print, assertActive: current });
      const catalog = new TeamArenaCatalog({ files: common.files, cvars: common.cvars, gameInfo, sourceParser,
        memory, print, assertActive: current });
      write("gameinfo.txt", "\n");
      write("ui/quota.menu", "menuDef { name main }");
      await loader.load("ui/quota.txt", true); await runtime.activate("main");
      common.cvars.set("ui_menuFiles", "ui/quota.txt", true);
      common.commands.registerAsync("ui_load", () => loader.reload(gameInfo, catalog));
      const offsets = new Set<number>(), firstOffsets: number[] = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        const padding = Array.from({ length: cycle }, (_, index) => `name pad${index}`).join(" ");
        write("ui/quota.menu", Array.from({ length: 15 }, (_, index) => {
          const name = index === 0 ? `name main ${padding} name main` : `name menu${index}`;
          return `menuDef { ${name} ${"itemDef { } ".repeat(index === 14 ? 22 : 96)} }`;
        }).join("\n"));
        published.length = 0;
        await common.commands.executeNowAsync("ui_load");
        expect(runtime.focusedMenuHandle()?.definition.window.name).toBe("main");
        expect(runtime.menuCount()).toBe(15);
        expect(runtime.snapshot().menus.reduce((count, menu) => count + menu.items.length, 0)).toBe(1366);
        expect(memory.allocatedBytes).toBeLessThan(750_000);
        expect(memory.stringBytes).toBeLessThan(200);
        expect(memory.outOfMemory).toBe(false);
        const first = published[0]?.items[0]?.allocationOffset;
        if (first === undefined) throw new Error("Actual loader omitted its first allocated item");
        firstOffsets.push(first);
        for (const menu of published) for (const item of menu.items) {
          if (item.allocationOffset === undefined) throw new Error("Actual loader published an unaccounted item");
          offsets.add(item.allocationOffset);
        }
        expect(offsets.size).toBe((cycle + 1) * 1366);
      }
      expect(firstOffsets).toEqual([16, 32, 48]);
      expect(offsets.size).toBe(4098);
      write("ui/overflow.menu", Array.from({ length: 6 }, () => `menuDef { ${"itemDef { } ".repeat(96)} }`).join("\n"));
      await expect(loader.parseMenu("ui/overflow.menu")).rejects.toThrow("failed UI_Alloc");
      expect(memory.outOfMemory).toBe(true);
      expect(printed).toContain("UI_Alloc: Failure. Out of memory!\n");
    }
    expect(sound.started).toBe(false);
    expect(common.sound.mixer).toBeNull();
  } finally {
    runtime?.resetDefinitions("menus"); runtime?.dispose(); resources?.dispose(); movies.dispose(); target.close();
    sourceOwner.disposeResources(); sound.close(); common.close(); io.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);

test("Team Arena source menu loading appends over real filesystem/resources/runtime owners and preserves failed-load effects", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "quake3-team-arena-menu-loader-"));
  const printed: string[] = [], clock = new UnixSystemClock();
  const io = new UnixIo(text => { printed.push(text); }, clock, { signals: "none" });
  const events = new CommonEvents(new DedicatedEventSource(io), text => { printed.push(text); });
  let active = true;
  const current = (): undefined => { if (!active) throw new Error("Fixture UI operation retired"); };
  const unexpected = (): never => { throw new Error("Fixture reached a product branch outside menu loading"); };
  const common = await CommonConsole.open({
    roots: { dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath, cdPath: null, product: "missionpack" },
    startup: new StartupCommands("+set s_initsound 1"), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
    platformPrint: text => { printed.push(text); }, resolveCommand: () => undefined,
    assertCommandEntry: current, assertOwnerEntry: current,
  }, current);
  common.hunk.initialize(true, common.files.fileMemory.loadStack);
  const sound = new EngineSound(common, events), images = new RendererImageCatalog();
  const cpu = new SoftwareRenderer(320, 240, images), target = new RenderTarget(images, [cpu]), builtins = new BuiltinImages(images, identityImageUploadProfile);
  const files = common.files.current;
  const movies = new EngineCinematics({ temporaryMemory: common.hunk.accounting.arena, developerPrint: text => { const developer = common.cvars.get("developer"); if (developer !== undefined && developer.integerValue !== 0) common.output.print(text); return undefined; }, print: text => { common.output.print(text); return undefined; }, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => sound.mixer }, clock: { sample: () => clock.milliseconds() },
    scratchImages: builtins, console: { kind: "absent" }, settings: { hardware: "generic", maxTextureSize: 4096, inGameVideo: () => 1 } });
  const settings = createRendererSettings();
  const renderer = await RendererResources.create(files, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "source-zone", zone: common.mainZone }, print: text => { common.output.print(text); }, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: movies.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { common.output.print(text); }, clock, identityLight: 1, tess: renderer.tess, runtime: settings.runtime });
  const cvars = new TeamArenaUiCvars(common.cvars, current), fontRegistry = new UiAssetRegistry(renderer, text => common.output.print(text));
  const cinematics = new EngineUiCinematics(movies, "ui");
  const resources = new TeamArenaUiResources({ renderer, sound, fontRegistry, cinematics, cvars, assertCurrentOperation: current });
  const memory = new TeamArenaUiMemory("qvm32", text => { printed.push(text); }), random = new GameRandom(1);
  const keys = new ClientKeys({ commands: common.commands, cvars: common.cvars, print: text => { printed.push(text); }, host: {
    assertCurrentOperation: current, readConnection: () => ({ kind: "disconnected", demoPlayback: false }),
    readUi: () => null, readCgame: () => null, disconnect: unexpected, stopAllSounds: () => { sound.stopAllSounds(); },
    addReliableCommand: unexpected, toggleConsole: unexpected, updateScreen: unexpected, consoleScroll: unexpected,
    readConsoleWidth: () => 78, clipboard: { kind: "native-unix-unavailable" },
  } });
  const empty = await loadMenuDefinitions({ random: { nextInt: () => random.rand() }, resolver: { resolveRoot: unexpected, resolve: unexpected } },
    { kind: "ui", setPaths: [] }, {}, { memory: { kind: "qvm32", memory } });
  const closedOwnerCinematics: number[] = [];
  let runtime: UiRuntime | undefined;
  try {
    sound.initialize({ sampleRate: 48000 }); await sound.beginRegistration();
    await resources.initializeDisplayAssets(); await resources.assetCache();
    runtime = await UiRuntime.create({ definitions: empty, cvars: common.cvars, commands: common.commands, resources,
      fonts: resources.fonts, widgetAssets: resources.widgetAssets, zeroPicture: renderer.picture(null), cinematics,
      context: { kind: "ui", bindings: { keyName: keynumToString, getBinding: key => keys.getBinding(key) ?? "",
        setBinding: (key, command) => keys.setBinding(key, command), getOverstrike: () => keys.getOverstrike(),
        setOverstrike: value => keys.setOverstrike(value) }, pause: unexpected },
      audio: { playLocal: handle => {
        if (!sound.started || sound.muted) return;
        const pcm = typeof handle === "number" ? sound.bank.soundForIndex(handle) : handle;
        if (typeof handle === "number" && pcm === undefined) return;
        sound.startLocalSound(pcm ?? null, 6);
      }, startBackground: unexpected, stopBackground: unexpected },
      paintModel: unexpected, getTeamColor: unexpected, externalScript: { run: unexpected },
      feeder: { count: unexpected, item: unexpected, image: unexpected, select: unexpected },
      ownerDraw: { visible: unexpected, width: unexpected, value: unexpected, handleKey: unexpected, paint: unexpected,
        closeCinematic: handle => { closedOwnerCinematics.push(handle); } },
    });
    const scriptMemory = new BotMemory(undefined, common.mainZone);
    const sourceOwner = new BotScriptSources(common.files.current, new ScriptGlobalDefines(undefined, scriptMemory),
      (_severity, text) => { common.output.print(text); }, text => { common.output.print(text); return undefined; }, scriptMemory);
    const services = { scriptSources: () => sourceOwner, memory, resources, cvars, runtime, random: { nextInt: () => random.rand() },
      systemClock: clock, print: (text: string): void => { printed.push(text); },
      error: (text: string): never => { throw new Error(text); }, assertCurrentOperation: current };
    const loader = new TeamArenaUiMenuLoader(services);
    const write = (path: string, text: string): void => {
      const file = common.files.writable.openBinaryWrite(path);
      if (file === null) throw new Error("Expected writable fixture menu source");
      try { file.writeBytes(new TextEncoder().encode(text)); } finally { file.close(); }
    };
    write("ui/loader-first.txt", 'loadMenu { "ui/loader-missing.menu" } loadMenu { "ui/loader-first.menu" }');
    write("ui/loader-first.menu", `assetGlobalDef { font "fonts/font" 16 gradientbar white fadeClamp .25 }
      menuDef { name first rect 0 0 640 480 style 1 backcolor .2 .4 .6 1 background white
        itemDef { name target text "Actual menu loader" rect 20 40 300 40 visible 1 } }`);
    write("ui/loader-second.txt", 'loadMenu { "ui/loader-second.menu" }');
    write("ui/loader-second.menu", "menuDef { name second unexpected }");
    write("ui/loader-empty.txt", "loadMenu { }");
    write("ui/loader-partial.txt", 'loadMenu { "ui/loader-second.menu" } loadMenu { "ui/loader-bad.menu" }');
    write("ui/loader-bad.menu", "assetGlobalDef { fadeClamp .75 } menuDef { rect invalid }");
    const cvarValue = common.cvars.get("ui_new")?.value;
    cvars.writeInteger("ui_new", 0);
    await loader.load("ui/loader-first.txt", true);
    expect(cvars.get("ui_new").integerValue).toBe(1);
    expect(common.cvars.get("ui_new")?.value).toBe(cvarValue);
    expect(runtime.menuCount()).toBe(1);
    expect(printed).toContain("Parsing menu file:ui/loader-missing.menu\n");
    expect(resources.fonts.normal.name).toBe("fonts/fontImage_16.dat");
    await runtime.activate("first");
    const captured = runtime.focusedMenuHandle(), before = runtime.snapshot().menus[0];
    await runtime.frame({ time: 1, frameTime: 1, draw: commands.draw2D("team-ui-640") });
    expect(commands.submitFrame()?.batches).toBeGreaterThan(0);
    expect(cpu.pixels.some((value, index) => index % 4 !== 3 && value !== 0)).toBe(true);
    await loader.load("ui/loader-second.txt", false);
    expect(printed).toContain("^1ERROR: ui/loader-second.menu, line 1: unknown menu keyword unexpected\n");
    expect(runtime.menuCount()).toBe(2);
    expect(runtime.focusedMenuHandle()).toBe(captured);
    expect(runtime.snapshot().menus[0]).toEqual(before);
    cvars.writeInteger("ui_new", 0);
    const bytes = memory.allocatedBytes;
    await expect(loader.load("ui/loader-absent-root.txt", true)).rejects.toThrow("using default");
    expect(runtime.menuCount()).toBe(2); expect(cvars.get("ui_new").integerValue).toBe(0);
    expect(memory.allocatedBytes).toBe(bytes);
    await loader.load("ui/loader-empty.txt", true);
    expect(runtime.menuCount()).toBe(0); expect(memory.allocatedBytes).toBe(bytes);
    await loader.load("ui/loader-partial.txt", false);
    expect(printed).toContain("^1ERROR: ui/loader-bad.menu, line 1: expected float but found invalid\n");
    expect(runtime.menuCount()).toBe(1); expect(resources.assets.fadeClamp).toBe(.75);
    const printCount = printed.length;
    expect(() => new TeamArenaUiMenuLoader({ ...services, memory: new TeamArenaUiMemory("qvm32", unexpected) })).toThrow("memory owner");
    expect(printed).toHaveLength(printCount);

    // String_Init belongs to the controller, not either source UI_LoadMenus invocation.
    memory.initializeStrings(); runtime.resetDefinitions("strings");
    await loader.load("ui/menus.txt", true);
    const initialCount = runtime.menuCount();
    await loader.load("ui/ingame.txt", false);
    expect(initialCount).toBeGreaterThan(0); expect(initialCount).toBeLessThan(45);
    expect(runtime.menuCount()).toBe(45);
    expect(runtime.snapshot().menus.reduce((count, menu) => count + menu.items.length, 0)).toBe(1462);
    expect(memory.outOfMemory).toBe(false);
    const sourceParser = new CommonParseState();
    const gameInfo = new TeamArenaGameInfo({ menuBuffer: new TeamArenaMenuBuffer(common.files, services.print, current),
      sourceParser, memory, resources: renderer, print: services.print, assertActive: current });
    const catalog = new TeamArenaCatalog({ files: common.files, cvars: common.cvars, gameInfo, sourceParser,
      memory, print: services.print, assertActive: current });
    common.cvars.set("ui_menuFiles", "ui/loader-first.txt", true);
    await loader.load("ui/loader-first.txt", true); await runtime.activate("first");
    const filesOpened: string[] = [], open = files.openRead.bind(files);
    files.openRead = path => { filesOpened.push(path); return open(path); };
    await loader.reload(gameInfo, catalog);
    expect(runtime.menuCount()).toBe(1);
    expect(runtime.focusedMenuHandle()?.definition.window.name).toBe("first");
    expect(gameInfo.numGameTypes).toBe(7);
    expect(gameInfo.mapCount).toBe(60); // UI_LoadArenas replaces the campaign map list parsed immediately before it.
    expect(filesOpened.indexOf("gameinfo.txt")).toBeGreaterThanOrEqual(0);
    expect(filesOpened.indexOf("ui/loader-first.txt")).toBeGreaterThan(filesOpened.indexOf("gameinfo.txt"));
    expect(memory.outOfMemory).toBe(false);
    await runtime.closeAll();
    await expect(loader.reload(gameInfo, catalog)).rejects.toThrow("uninitialized source lastName");
    expect(runtime.menuCount()).toBe(1); // Source reaches all loads and close-all before reading the uninitialized local.
    expect(runtime.focusedMenuHandle()).toBeUndefined();
    common.cvars.set("ui_menuFiles", "ui/loader-empty.txt", true);
    await loader.reload(gameInfo, catalog);
    expect(runtime.menuCount()).toBe(0); // No name comparison reaches the uninitialized buffer.
    write("ui/loader-unnamed.txt", 'loadMenu { "ui/loader-unnamed.menu" }');
    write("ui/loader-unnamed.menu", "menuDef { rect 0 0 640 480 }");
    common.cvars.set("ui_menuFiles", "ui/loader-unnamed.txt", true);
    await loader.reload(gameInfo, catalog);
    expect(runtime.menuCount()).toBe(1);
    expect(runtime.focusedMenuHandle()).toBeUndefined(); // Q_stricmp(NULL, lastName) does not read either string.

    await loader.load("ui/loader-first.txt", true); await runtime.activate("first");
    const browser = new ServerBrowser({ io, cvars: common.cvars, clientStatic: new ClientStaticState(),
      loopback: new LoopbackTransport(), print: services.print, assertCurrentOperation: current });
    const display = new TeamArenaServerBrowser({ browser, cvars, gameInfo, runtime, commands: common.commands,
      calendar: clock, print: services.print, assertActive: current });
    const status = new TeamArenaServerStatus({ browser, cvars, display, runtime, clock: events,
      print: services.print, assertActive: current });
    const menus = new TeamArenaMenuController({ runtime, keys, cvars, loader,
      players: new TeamArenaPlayerList(common.cvars, current), readClient: unexpected, assertActive: current });
    const refresh = new TeamArenaUiRefresh({ runtime, cvars, menus, resources, browser: display, status, assertActive: current });
    const order: string[] = [], paintAll = runtime.frame.bind(runtime), updateCvars = cvars.update.bind(cvars);
    const doRefresh = display.doRefresh.bind(display), buildStatus = status.buildServerStatus.bind(status);
    const findPlayers = status.buildFindPlayerList.bind(status), draw = commands.draw2D("team-ui-640");
    const setColor = draw.setColor.bind(draw), drawHandlePic = draw.drawHandlePic.bind(draw);
    cvars.update = () => { order.push("cvars"); updateCvars(); };
    runtime.frame = async (frame, fps) => { order.push("paint"); await paintAll(frame, fps); };
    display.doRefresh = async time => { order.push(`browser:${time}`); await doRefresh(time); };
    status.buildServerStatus = async (force, time) => { order.push(`status:${force}:${time}`); await buildStatus(force, time); };
    status.buildFindPlayerList = async (force, time) => { order.push(`find:${force}:${time}`); await findPlayers(force, time); };
    draw.setColor = color => { if (color === null) order.push("color:null"); setColor(color); };
    draw.drawHandlePic = (rect, picture) => {
      if (picture === resources.assets.cursor) { order.push("cursor"); expect(rect).toEqual({ x: 48, y: 32, width: 32, height: 32 }); }
      drawHandlePic(rect, picture);
    };
    await menus.mouseEvent(64, 48);
    common.cvars.set("ui_browserShowEmpty", "0", true);
    for (const time of [10, 20, 30, 40]) { await refresh.refresh(time, draw); commands.submitFrame(); }
    expect(refresh.framesPerSecond).toBe(0);
    order.length = 0; await refresh.refresh(50, draw);
    expect(cvars.get("ui_browserShowEmpty").integerValue).toBe(0);
    expect(refresh.framesPerSecond).toBe(100);
    expect(order.slice(0, 2)).toEqual(["cvars", "paint"]);
    expect(order.slice(-5)).toEqual(["browser:50", "status:false:50", "find:false:50", "color:null", "cursor"]);
    expect(commands.submitFrame()?.batches).toBeGreaterThan(0);
    refresh.setTime(90); await refresh.refresh(100, draw); commands.submitFrame();
    expect(refresh.frameTime).toBe(10); expect(refresh.framesPerSecond).toBe(100);
    await refresh.refresh(90, draw); commands.submitFrame();
    expect(refresh.frameTime).toBe(-10); expect(refresh.framesPerSecond).toBe(200);
    common.cvars.set("developer", "1", true);
    await menus.keyEvent(KeyCode.F11, true);
    for (let index = 0; index < 4; index++) { await refresh.refresh(90, draw); commands.submitFrame(); }
    expect(refresh.framesPerSecond).toBe(4000);
    expect(cpu.pixels.some((value, index) => index < 320 * 20 * 4 && index % 4 !== 3 && value !== 0)).toBe(true);
    await loader.load("ui/loader-empty.txt", true); order.length = 0;
    await refresh.refresh(100, draw);
    expect(order).toEqual(["cvars", "color:null"]);
    commands.submitFrame();

    const scores = new TeamArenaScores({ files: common.files, cvars: common.cvars, print: services.print, assertActive: current });
    const postgame = new TeamArenaPostGame({ cvars, gameInfo, scores, menus, assertActive: current });
    const console = new TeamArenaConsoleCommands({ refresh, runtime, memory, loader, gameInfo, catalog, postgame,
      renderer, readClient: unexpected, assertActive: current });
    let commandTime = 200;
    const handled: boolean[] = [];
    for (const command of ["ui_report", "ui_cache", "ui_load", "ui_test", "ui_teamOrders", "ui_cdkey", "remapShader", "ui_unknown_test"]) {
      common.commands.registerAsync(command, async context => { handled.push(await console.run(context, commandTime)); });
    }
    const reportStart = printed.length;
    await common.commands.executeNowAsync("UI_REPORT");
    expect(printed[reportStart]).toBe("Memory/String Pool Info\n");
    expect(printed[reportStart + 1]).toBe("----------------\n");
    expect(printed[reportStart + 2]).toMatch(/^String Pool is \d+\.\d% full, \d+ bytes out of 393216 used\.\n$/);
    expect(printed[reportStart + 3]).toMatch(/^Memory Pool is \d+\.\d% full, \d+ bytes out of 1048576 used\.\n$/);
    expect(handled.pop()).toBe(true); expect(refresh.realTime).toBe(200); expect(refresh.frameTime).toBe(100);
    commandTime = 220; await common.commands.executeNowAsync("ui_unknown_test");
    expect(handled.pop()).toBe(false); expect(refresh.frameTime).toBe(20);
    await common.commands.executeNowAsync("remapShader white"); expect(handled.pop()).toBe(false);
    const remaps: string[][] = [], remap = renderer.remapShader.bind(renderer);
    renderer.remapShader = async (original, replacement, offset) => {
      if (offset === null) throw new Error("UI console supplies a string shader time");
      remaps.push([original, replacement, offset]); await remap(original, replacement, offset);
    };
    await common.commands.executeNowAsync("remapShader white white 1.5");
    expect(handled.pop()).toBe(true); expect(remaps).toEqual([["white", "white", "1.5"]]);
    await loader.load("ui/loader-first.txt", true); await runtime.activate("first");
    common.cvars.set("ui_menuFiles", "ui/loader-first.txt", true);
    await common.commands.executeNowAsync("ui_load"); expect(handled.pop()).toBe(true);
    expect(runtime.focusedMenuHandle()?.definition.window.name).toBe("first");
    await common.commands.executeNowAsync("ui_teamOrders"); await common.commands.executeNowAsync("ui_cdkey");
    expect(handled.splice(0)).toEqual([true, true]);
    await common.commands.executeNowAsync("ui_test"); expect(handled.pop()).toBe(false);
    expect(postgame.soundHighScore).toBe(true); expect(common.cvars.get("sv_killserver")?.value).toBe("1");
    write("ui/loader-cache.txt", 'loadMenu { "ui/loader-cache.menu" }');
    write("ui/loader-cache.menu", 'menuDef { name cache cinematic "idlogo.RoQ" soundLoop "sound/feedback/voc_newhighscore.wav" itemDef { cinematic "idlogo.RoQ" } }');
    await loader.load("ui/loader-cache.txt", true);
    const cacheCalls: string[] = [], play = cinematics.play.bind(cinematics), stop = cinematics.stop.bind(cinematics);
    const registerSound = resources.registerSound.bind(resources);
    cinematics.play = (asset, rect) => { cacheCalls.push(`play:${asset.path}`); return play(asset, rect); };
    cinematics.stop = instance => { cacheCalls.push("stop"); stop(instance); };
    resources.registerSound = async path => { cacheCalls.push(`sound:${path}`); return registerSound(path); };
    await common.commands.executeNowAsync("ui_cache");
    expect(handled.pop()).toBe(true);
    expect(cacheCalls).toEqual(["play:video/idlogo.RoQ", "stop", "play:video/idlogo.RoQ", "stop", "sound:sound/feedback/voc_newhighscore.wav"]);
    expect(runtime.focusedMenuHandle()).toBeUndefined();
    expect(loader.inGameLoad).toBe(false);
    write("ui/loader-noningame.txt", 'loadMenu { "ui/loader-noningame.menu" }');
    write("ui/loader-noningame.menu", 'menuDef { name main } menuDef { name endofgame }');
    common.cvars.set("ui_menuFiles", "ui/loader-noningame.txt", true);
    const nonIngame = loader.loadNonIngame.bind(loader), nonIngameCalls: (readonly [number, boolean, number])[] = [];
    const observedRuntime = runtime;
    loader.loadNonIngame = async () => {
      nonIngameCalls.push([keys.getCatcher(), loader.inGameLoad, observedRuntime.menuCount()]);
      await nonIngame();
    };
    await menus.setActiveMenu(UiMenuCommand.Main);
    expect(nonIngameCalls).toEqual([]);
    loader.inGameLoad = true;
    await menus.setActiveMenu(UiMenuCommand.Main);
    expect(nonIngameCalls).toEqual([[2, true, 1]]);
    expect(loader.inGameLoad).toBe(false); expect(runtime.menuCount()).toBe(3);
    expect(runtime.focusedMenuHandle()?.definition.window.name).toBe("main");
    loader.inGameLoad = true;
    await menus.setActiveMenu(UiMenuCommand.Postgame);
    expect(nonIngameCalls).toEqual([[2, true, 1], [2, true, 3]]);
    expect(loader.inGameLoad).toBe(false); expect(runtime.menuCount()).toBe(5);
    expect(runtime.focusedMenuHandle()?.definition.window.name).toBe("endofgame");
    active = false;
    await expect(loader.parseMenu("ui/loader-second.menu")).rejects.toThrow("retired");
    await expect(refresh.refresh(110, draw)).rejects.toThrow("retired");
  } finally {
    active = true; runtime?.dispose(); resources.dispose(); movies.dispose(); commands.close("discard"); target.close();
    sound.close(); common.close(); io.close();
    await rm(homePath, { recursive: true, force: true });
  }
}, 20000);
