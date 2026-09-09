// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { EngineSound } from "../src/engine/sound.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { EngineUiCinematics } from "../src/engine/ui-cinematics.ts";
import { DedicatedEventSource } from "../src/platform/dedicated-input.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { UiAssetRegistry, textPaint, textWidth } from "../src/render/font.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RendererResources } from "../src/render/world.ts";
import { loadMenuDefinitions } from "../src/ui/menu.ts";
import { TeamArenaUiCvars } from "../src/ui/team-arena/cvars.ts";
import { TeamArenaUiResources } from "../src/ui/team-arena/resources.ts";
import { TeamArenaUiMemory } from "../src/ui/team-arena/memory.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

test("Team Arena registers real cached assets and partial menu destinations over engine owners", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "quake3-team-arena-resources-"));
  const printed: string[] = [], clock = new UnixSystemClock();
  const io = new UnixIo(text => { printed.push(text); }, clock, { signals: "none" });
  const events = new CommonEvents(new DedicatedEventSource(io), text => { printed.push(text); });
  let operationCurrent = true;
  const current = (): undefined => { if (!operationCurrent) throw new Error("Fixture UI operation retired"); };
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
  const services = { renderer, sound, fontRegistry, cinematics, cvars, assertCurrentOperation: current };
  const resources = new TeamArenaUiResources(services);
  try {
    expect(resources.assets.fontRegistered).toBe(false);
    expect(resources.assets.cursorStr).toBeNull();
    expect(resources.assets.shadowColor).toEqual({ x: 0, y: 0, z: 0, w: 0 });
    expect(textWidth(resources.fonts, "zero", .3)).toBe(0);
    expect(resources.fonts.bigThreshold).toBe(Math.fround(.4));
    common.cvars.set("ui_bigFont", ".5");
    expect(resources.fonts.bigThreshold).toBe(Math.fround(.4));
    cvars.update(); expect(resources.fonts.bigThreshold).toBe(Math.fround(.5));

    const exhausted = new TeamArenaUiMemory("qvm32", text => { printed.push(text); });
    exhausted.stringAllocReference("A".repeat(384 * 1024 - 2));
    const nullable = new TeamArenaUiResources(services);
    try {
      const definitions = await loadMenuDefinitions({ random: { nextInt: () => 1 }, resolver: {
        resolveRoot: path => ({ path, text: path === "null-set" ? 'loadMenu { "null-menu" }'
          : 'assetGlobalDef { font missing 16 menuEnterSound stopped fadeClamp .25 } menuDef { itemDef { type 7 asset_model missing } }' }),
        resolve: () => undefined,
      } }, { kind: "ui", setPaths: ["null-set"] }, {}, { memory: { kind: "qvm32", memory: exhausted },
        registrationSink: nullable, assetSink: nullable });
      expect(definitions.registration.events.map(event => [event.kind, event.reference.path])).toEqual([
        ["font", null], ["sound", null], ["model", null],
      ]);
      expect(nullable.fonts.normal.name).toBe("fonts/fontImage_16.dat");
      expect(nullable.assets.menuEnterSound).toBeNull();
      expect(nullable.assets.fadeClamp).toBe(.25);
      expect(definitions.menus[0]?.items[0]?.assetHandle).toBe(0);
      expect(printed).toContain("RE_RegisterModel: NULL name\n");
      expect(nullable.registeredModel(null)).toBe(renderer.modelForHandle(0));
      expect(nullable.registeredModel("null")).toBeUndefined();
    } finally { nullable.dispose(); }

    sound.initialize({ sampleRate: 48000 }); await sound.beginRegistration();
    await resources.initializeDisplayAssets(); await resources.assetCache();
    const cached = resources.assets;
    expect(cached.fxPic).toHaveLength(7); expect(cached.crosshairShader).toHaveLength(10);
    expect(cached.newHighScoreSound).not.toBeNull();
    expect(resources.registeredPicture("UI/ASSETS/SCROLLBAR.TGA")).toBe(cached.scrollBar);
    expect(resources.registeredPicture("menu/art/3_cursor2")).toBe(cached.displayCursor);
    expect(cached.cursorStr).toBeNull();
    for (const [index, color] of ["red", "yel", "grn", "teal", "blue", "cyan", "white"].entries()) {
      const registered = resources.registeredPicture(`menu/art/fx_${color}`);
      expect(registered).toBeDefined(); expect(cached.fxPic[index]).toBe(registered);
    }

    const source = (path: string) => {
      if (path === "fixture-set.txt") return { path, text: 'loadMenu { "ui/main.menu" }' };
      return files.has(path) ? { path, text: new TextDecoder().decode(files.readSync(path)) } : undefined;
    };
    const definitions = await loadMenuDefinitions({ random: { nextInt: () => 1 }, resolver: {
      resolveRoot: source, resolve: request => source(posix.join(posix.dirname(request.fromPath), request.requestedPath)) ?? source(request.requestedPath),
    } }, { kind: "ui", setPaths: ["fixture-set.txt"] }, {}, { registrationSink: resources, assetSink: resources });
    expect(definitions.registration.kind).toBe("completed"); expect(resources.assets.fontRegistered).toBe(true);
    expect(resources.assets.cursorStr).toBe("ui/assets/3_cursor3");
    expect(resources.fonts.normal.name).toBe("fonts/fontImage_16.dat");
    expect(resources.fonts.small.name).toBe("fonts/fontImage_12.dat");
    expect(resources.fonts.big.name).toBe("fonts/fontImage_20.dat");
    const focusSound = resources.registeredSound("sound/misc/menu2.wav");
    if (focusSound === undefined) throw new Error("Retail item-focus sound did not register");
    expect(resources.assets.itemFocusSound).toBe(focusSound);
    expect(resources.assets.fadeCycle).toBe(1); expect(resources.assets.shadowFadeClamp).toBe(.25);
    const draw = commands.draw2D("team-ui-640");
    textPaint(draw, resources.fonts, { x: 20, y: 80, scale: .3, color: { x: 1, y: 1, z: 1, w: 1 },
      text: "Team Arena", adjust: 0, limit: 0, style: 0 });
    expect(commands.submitFrame()?.batches).toBeGreaterThan(0);
    expect(cpu.pixels.some((value, index) => index % 4 !== 3 && value !== 0)).toBe(true);
    expect(textWidth(resources.fonts, "Team Arena", .3)).toBeGreaterThan(0);
    const asset = await resources.prepareCinematic("mpintro.roq");
    const movie = cinematics.play(asset, { x: 0, y: 0, width: 100, height: 100 });
    expect(movie).toBeDefined(); if (movie !== undefined) cinematics.stop(movie.handle.index);

    const failed = new TeamArenaUiResources({ ...services, renderer: { ...renderer,
      registerShaderNoMip: async path => {
        if (path === "menu/art/fx_yel") throw new Error("Reached shader failure");
        return renderer.registerShaderNoMip(path);
      } } });
    try {
      await expect(failed.assetCache()).rejects.toThrow("Reached shader failure");
      expect(failed.registeredPicture("ui/assets/gradientbar2.tga")).toBe(failed.assets.gradientBar);
      expect(failed.assets.fxPic[0]).toBe(failed.registeredPicture("menu/art/fx_red"));
      expect(failed.registeredPicture("menu/art/fx_yel")).toBeUndefined();
      expect(failed.assets.newHighScoreSound).toBeNull();
    } finally { failed.dispose(); }

    const gated = Promise.withResolvers<void>();
    const retiring = new TeamArenaUiResources({ ...services, renderer: { ...renderer,
      registerShaderNoMip: async path => { await gated.promise; return renderer.registerShaderNoMip(path); } } });
    const pending = retiring.registerPicture("white"); retiring.dispose(); gated.resolve();
    await expect(pending).rejects.toThrow("disposed");
    const partial = await loadMenuDefinitions({ random: { nextInt: () => 1 }, resolver: {
      resolveRoot: path => ({ path, text: path === "partial-set" ? 'loadMenu { "partial-menu" }'
        : "assetGlobalDef { shadowColor .7 .8 invalid }" }),
      resolve: () => undefined,
    } }, { kind: "ui", setPaths: ["partial-set"] }, {}, { registrationSink: resources, assetSink: resources });
    expect(partial.diagnostics.some(diagnostic => diagnostic.severity === "error" && diagnostic.message.includes("expected float"))).toBe(true);
    expect(resources.assets.shadowColor).toEqual({ x: Math.fround(.7), y: Math.fround(.8), z: Math.fround(.1), w: .25 });
    expect(resources.assets.shadowFadeClamp).toBe(.25);
    expect(resources.assets.fontRegistered).toBe(true);
    const malformed = common.files.writable.openBinaryWrite("fonts/fontImage_13.dat");
    if (malformed === null) throw new Error("Expected writable fixture font DAT");
    malformed.writeBytes(Uint8Array.of(1, 2, 3)); malformed.close();
    const destinations = new TeamArenaUiResources(services);
    const parseFontAssets = async (body: string) => loadMenuDefinitions({ random: { nextInt: () => 1 }, resolver: {
      resolveRoot: path => ({ path, text: path === "font-set" ? 'loadMenu { "font-menu" }' : `assetGlobalDef { ${body} }` }),
      resolve: () => undefined,
    } }, { kind: "ui", setPaths: ["font-set"] }, {}, { registrationSink: destinations, assetSink: destinations });
    try {
      const zeroNormal = destinations.fonts.normal, zeroSmall = destinations.fonts.small;
      const previousPrints = printed.length;
      await parseFontAssets('font "missing.ttf" 14 fadeCycle 7');
      expect(destinations.fonts.normal).toBe(zeroNormal); expect(destinations.assets.fontRegistered).toBe(true);
      expect(destinations.assets.fadeCycle).toBe(7);
      await parseFontAssets('font "fonts/arial.ttf" 12 font "wrong.ttf" 13 smallFont "missing.ttf" 14 fadeCycle 8');
      expect(destinations.fonts.normal.name).toBe("fonts/fontImage_12.dat");
      expect(destinations.fonts.small).toBe(zeroSmall); expect(destinations.assets.fadeCycle).toBe(8);
      expect(printed.slice(previousPrints).filter(text => text.startsWith("RE_RegisterFont:"))).toEqual([
        "RE_RegisterFont: FreeType code not available\n", "RE_RegisterFont: FreeType code not available\n",
        "RE_RegisterFont: FreeType code not available\n",
      ]);
      const retained = destinations.fonts.normal;
      await parseFontAssets('font "wrong.ttf" 13'); expect(destinations.fonts.normal).toBe(retained);
    } finally { destinations.dispose(); }
    sound.shutdown();
    expect(await resources.registerSound(null)).toBeUndefined();
    expect(await resources.registerSound("sound/misc/menu2.wav")).toBeUndefined();
    expect(await resources.registerPicture("white")).toBeDefined();
    const retained = new TeamArenaUiMemory("qvm32", text => { printed.push(text); });
    await loadMenuDefinitions({ random: { nextInt: () => 1 }, resolver: {
      resolveRoot: path => ({ path, text: path === "cursor-set" ? 'loadMenu { "cursor-menu" }' : 'assetGlobalDef { cursor white }' }),
      resolve: () => undefined,
    } }, { kind: "ui", setPaths: ["cursor-set"] }, {}, { memory: { kind: "qvm32", memory: retained },
      registrationSink: resources, assetSink: resources });
    expect(resources.assets.cursorStr).toBe("white");
    const cursorPicture = resources.assets.cursor;
    retained.initializeStrings(); retained.stringAllocReference("changed");
    expect(resources.assets.cursorStr).toBe("changed");
    expect(resources.assets.cursor).toBe(cursorPicture);
    operationCurrent = false;
    expect(() => resources.fonts.smallThreshold).toThrow("retired");
    await expect(resources.registerFont("fonts/font", 16)).rejects.toThrow("retired");
  } finally {
    operationCurrent = true; resources.dispose(); movies.dispose(); commands.close("discard"); target.close();
    sound.close(); common.close(); io.close();
    await rm(homePath, { recursive: true, force: true });
  }
}, 20000);
