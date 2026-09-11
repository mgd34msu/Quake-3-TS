// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BotMemory } from "../src/botlib/memory.ts";
import { BotScriptSources } from "../src/botlib/script-sources.ts";
import { ScriptGlobalDefines } from "../src/script/preprocessor.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { isPrereleaseDemo, isPrereleaseTeamArenaDemo, RETAIL_PRODUCT_PROFILE } from "../src/core/product-profile.ts";
import type { ProductProfile } from "../src/core/product-profile.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { ClientKeys } from "../src/engine/client-keys.ts";
import { ClientStaticState } from "../src/engine/client-state.ts";
import { EngineSound } from "../src/engine/sound.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { EngineUiCinematics } from "../src/engine/ui-cinematics.ts";
import { ServerBrowser } from "../src/engine/server-browser.ts";
import { ServerEngine } from "../src/engine/server-engine.ts";
import { LanAddresses } from "../src/platform/lan.ts";
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
import { infoSlot } from "../src/ui/team-arena/game-info.ts";
import { TeamArenaUi } from "../src/ui/team-arena/ui.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";

const profiles: readonly { readonly profile: ProductProfile; readonly engineDemo: boolean; readonly uiDemo: boolean }[] = [
  { profile: RETAIL_PRODUCT_PROFILE, engineDemo: false, uiDemo: false },
  { profile: { kind: "prerelease-demo", teamArenaUi: "retail" }, engineDemo: true, uiDemo: false },
  { profile: { kind: "prerelease-demo", teamArenaUi: "demo" }, engineDemo: true, uiDemo: true },
  { profile: { kind: "prerelease-ta-demo" }, engineDemo: false, uiDemo: true },
];

test("prerelease profiles preserve the two independent source switches", () => {
  for (const { profile, engineDemo, uiDemo } of profiles) {
    expect(isPrereleaseDemo(profile)).toBe(engineDemo);
    expect(isPrereleaseTeamArenaDemo(profile)).toBe(uiDemo);
  }
});

test("actual server registration omits only the PRE_RELEASE_DEMO map variants", async () => {
  for (const { profile, engineDemo, uiDemo } of profiles) {
    for (const dedicated of [0, 1]) {
      const directory = await mkdtemp(join(tmpdir(), "quake3-prerelease-commands-"));
      const current = (): undefined => undefined;
      const adopted: CommonConsole[] = [];
      let server: ServerEngine | null = null;
      try {
        for (const game of ["baseq3", "demota"]) {
          await mkdir(join(directory, game));
          await writeFile(join(directory, game, "default.cfg"), "\n");
        }
        await writeFile(join(directory, "baseq3", "productid.txt"), SOURCE_PRODUCT_ID);
        const random = new LinuxNativeRandom(1);
        const common = await CommonConsole.open({
          roots: { dataPath: directory, homePath: join(directory, "home"), cdPath: null, product: "baseq3" },
          startup: new StartupCommands(`+set s_initsound 0 +set com_prereleaseDemo ${engineDemo ? 1 : 0} +set com_prereleaseTeamArenaDemo ${uiDemo ? 1 : 0}`),
          random, build: { kind: "dedicated" }, platformPrint: current, resolveCommand: () => undefined,
          assertCommandEntry: current, assertOwnerEntry: current,
        }, owner => { adopted.push(owner); });
        common.registerRuntimeCvars("prerelease-fixture", async () => {});
        common.cvars.set("dedicated", String(dedicated), true);
        expect(common.productProfile).toEqual(profile);
        server = ServerEngine.create({ common, buildDate: "prerelease-fixture", random,
          clock: { milliseconds: () => 0, comFrameTime: 0 },
          network: { loopback: new LoopbackTransport(), udp: null, lan: new LanAddresses([]),
            resolveAddress: async () => { throw new Error("Command registration must not resolve addresses"); }, sleep: async () => {} },
          bots: { kind: "unavailable", reason: "Registration fixture" }, clientLifecycle: { kind: "absent" } });
        const names = common.commands.registeredNames();
        for (const name of ["heartbeat", "kick", "banUser", "banClient", "clientkick", "status", "serverinfo",
          "systeminfo", "dumpuser", "map_restart", "sectorlist", "map", "killserver"]) expect(names).toContain(name);
        for (const name of ["devmap", "spmap", "spdevmap"]) expect(names.includes(name)).toBe(!engineDemo);
        expect(names.includes("say")).toBe(dedicated !== 0);
      } finally {
        await server?.disposeResources();
        for (const common of adopted) common.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}, 20_000);

async function fixture(profile: ProductProfile) {
  if (process.env["SDL_VIDEODRIVER"] !== "dummy" || process.env["SDL_AUDIODRIVER"] !== "dummy") {
    throw new Error("Run this fixture with SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy");
  }
  const directory = await mkdtemp(join(tmpdir(), "quake3-prerelease-profile-"));
  const cleanup: (() => void)[] = [];
  const print = (): undefined => undefined, current = (): undefined => undefined;
  const unexpected = (): never => { throw new Error("Profile fixture reached unrelated gameplay or networking"); };
  const close = async (): Promise<void> => {
    try { for (const dispose of cleanup.reverse()) dispose(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  };
  try {
    const root = join(directory, "baseq3");
    await mkdir(join(root, "ui"), { recursive: true });
    await writeFile(join(root, "default.cfg"), "\n");
    await writeFile(join(root, "productid.txt"), SOURCE_PRODUCT_ID);
    await writeFile(join(root, "teaminfo.txt"), "teams { { Retail ui/retail A B C D E } }");
    await writeFile(join(root, "demoteaminfo.txt"), "teams { { Demo ui/demo A B C D E } }");
    await writeFile(join(root, "extra.team"), "teams { { Extra ui/extra A B C D E } }");
    await writeFile(join(root, "gameinfo.txt"), "gametypes { { FFA 0 } } maps { { Retail retail_map 1 Retail 0 10 } }");
    await writeFile(join(root, "demogameinfo.txt"), "gametypes { { FFA 0 } } maps { { Demo demo_map 1 Demo 0 20 } }");
    await writeFile(join(root, "ui", "menus.txt"), 'loadMenu { "ui/profile.menu" }');
    await writeFile(join(root, "ui", "ingame.txt"), "loadMenu { }");
    await writeFile(join(root, "ui", "profile.menu"), "menuDef { name main itemDef { name reload type 1 action { uiScript loadGameInfo; } } }");
    const clock = new UnixSystemClock(), stdin = new PassThrough(); cleanup.push(() => stdin.destroy());
    const io = new UnixIo(print, clock, { stdin, signals: "none" }); cleanup.push(() => io.close());
    const events = new CommonEvents({ getEvent: () => ({ kind: "none", time: 0 }) }, print);
    const common = await CommonConsole.open({
      roots: { dataPath: directory, homePath: join(directory, "home"), cdPath: null, product: "missionpack" },
      startup: new StartupCommands("+set s_initsound 0 +set s_volume 0 +set s_musicvolume 0 +set color1 4"), random: new LinuxNativeRandom(1),
      build: { kind: "dedicated" }, platformPrint: print, resolveCommand: () => undefined,
      assertCommandEntry: current, assertOwnerEntry: current,
    }, current);
    cleanup.push(() => common.close());
    common.hunk.initialize(true, common.files.fileMemory.loadStack);
    const sound = new EngineSound(common, events); cleanup.push(() => sound.close());
    sound.initialize({ sampleRate: 48000 });
    const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(1, 1, images);
    const target = new RenderTarget(images, [cpu]); cleanup.push(() => target.close());
    const builtins = new BuiltinImages(images, identityImageUploadProfile), settings = createRendererSettings();
    const movies = new EngineCinematics({ temporaryMemory: common.hunk.accounting.arena, developerPrint: print, print,
      files: { kind: "diagnostic-bytes", reader: common.files.current }, sound: { kind: "diagnostic", readMixer: () => sound.mixer },
      clock: { sample: () => clock.milliseconds() }, scratchImages: builtins, console: { kind: "absent" },
      settings: { hardware: "generic", maxTextureSize: 4096, inGameVideo: () => 0 } });
    cleanup.push(() => movies.dispose());
    const renderer = await RendererResources.create(common.files.current, { kind: "unaccounted" }, settings,
      { patchMemory: { kind: "source-zone", zone: common.mainZone }, print, imageProfile: identityImageUploadProfile,
        target, images, builtins, drawDebugSurface: unexpected, shaderCinematics: movies.shaderCinematics });
    const commands = new RenderCommandBuffer(target, { print, clock, identityLight: 1, tess: renderer.tess, runtime: settings.runtime });
    cleanup.push(() => commands.close("discard"));
    const window = SdlWindow.open({ title: "Private prerelease fixture", width: 1, height: 1, backend: "cpu", hidden: true });
    cleanup.push(() => window.close());
    const configuration = RendererConfiguration.create({ window, renderer: { kind: "cpu", backend: cpu }, settings });
    cleanup.push(() => configuration.close());
    const keys = new ClientKeys({ commands: common.commands, cvars: common.cvars, print, host: {
      assertCurrentOperation: current, readConnection: () => ({ kind: "disconnected", demoPlayback: false }), readUi: () => null,
      readCgame: () => null, disconnect: unexpected, stopAllSounds: () => { sound.stopAllSounds(); }, addReliableCommand: unexpected,
      toggleConsole: unexpected, updateScreen: unexpected, consoleScroll: unexpected, readConsoleWidth: () => 78,
      clipboard: { kind: "native-unix-unavailable" },
    } });
    const browser = new ServerBrowser({ io, clientStatic: new ClientStaticState(), loopback: new LoopbackTransport(),
      cvars: common.cvars, print, assertCurrentOperation: current });
    const memory = new BotMemory(undefined, common.mainZone);
    const sources = new BotScriptSources(common.files.current, new ScriptGlobalDefines(undefined, memory), print, print, memory);
    cleanup.push(() => sources.disposeResources());
    const ui = await TeamArenaUi.create({ productProfile: profile, common, keys, browser, events, systemClock: clock,
      calendar: clock, configuration, renderer, commands, sound,
      audio: { playLocal: print, startBackground: async () => {}, stopBackground: print }, cinematics: new EngineUiCinematics(movies, "ui"),
      scriptSources: () => sources, readClient: () => ({ readSnapshotClientNumber: () => 0, getConfigString: () => null }),
      readSession: () => null, readRealTime: () => 0, assertCurrentOperation: current });
    cleanup.push(() => ui.retire());
    return { ui, common, sound, close };
  } catch (error) { await close(); throw error; }
}

for (const { profile, uiDemo } of profiles) {
  test(`Team Arena metadata init, reload and scripts follow ${JSON.stringify(profile)}`, async () => {
    const f = await fixture(profile);
    try {
      const ui = f.ui, calls: string[] = [];
      const parseTeams = ui.teams.parseTeamInfo.bind(ui.teams), loadTeams = ui.teams.loadTeams.bind(ui.teams);
      const parseGame = ui.gameInfo.parseGameInfo.bind(ui.gameInfo), arenas = ui.catalog.loadArenas.bind(ui.catalog);
      const load = ui.loader.load.bind(ui.loader), scores = ui.scores.loadBestScores.bind(ui.scores);
      spyOn(ui.teams, "parseTeamInfo").mockImplementation(async path => { calls.push(path); await parseTeams(path); });
      spyOn(ui.teams, "loadTeams").mockImplementation(async () => { calls.push("loadTeams"); await loadTeams(); });
      spyOn(ui.gameInfo, "parseGameInfo").mockImplementation(async path => { calls.push(path); await parseGame(path); });
      spyOn(ui.catalog, "loadArenas").mockImplementation(() => { calls.push("loadArenas"); arenas(); });
      spyOn(ui.loader, "load").mockImplementation(async (path, reset) => { calls.push(path); await load(path, reset); });
      spyOn(ui.scores, "loadBestScores").mockImplementation((map, game) => { calls.push(`score:${map}:${game}`); scores(map, game); });
      await ui.initialize();
      expect(calls).toEqual(uiDemo
        ? ["demoteaminfo.txt", "demogameinfo.txt", "ui/menus.txt", "ui/ingame.txt", "score:demo_map:0"]
        : ["teaminfo.txt", "loadTeams", "extra.team", "gameinfo.txt", "ui/menus.txt", "ui/ingame.txt", "score:retail_map:0"]);
      expect(infoSlot(ui.teams.teamList, 0).teamName).toBe(uiDemo ? "Demo" : "Retail");
      expect(ui.teams.teamCount).toBe(uiDemo ? 1 : 2);
      expect(infoSlot(ui.gameInfo.mapList, 0).mapLoadName).toBe(uiDemo ? "demo_map" : "retail_map");
      expect(f.sound.started).toBe(false);
      await ui.runtime.activate("main"); calls.length = 0;
      await ui.loader.reload(ui.gameInfo, ui.catalog);
      expect(calls).toEqual(uiDemo ? ["demogameinfo.txt"] : ["gameinfo.txt", "loadArenas"]);
      expect(ui.runtime.focusedMenuHandle()?.definition.window.name).toBe("main");
      calls.length = 0;
      const action = ui.runtime.focusedMenuHandle()?.definition.items[0]?.action;
      if (action === undefined) throw new Error("Authored metadata script missing");
      await ui.runtime.runItemScript("main", "reload", action);
      expect(calls).toEqual(uiDemo ? ["demogameinfo.txt", "score:demo_map:0"] : ["gameinfo.txt", "score:retail_map:0"]);
    } finally { await f.close(); }
  }, 20_000);
}

test("demo metadata read failure stops reload and script at the reached file read", async () => {
  const f = await fixture({ kind: "prerelease-ta-demo" });
  try {
    const ui = f.ui;
    await ui.initialize();
    await ui.runtime.activate("main");
    const action = ui.runtime.focusedMenuHandle()?.definition.items[0]?.action;
    if (action === undefined) throw new Error("Authored metadata script missing");
    const opened: string[] = [], filesystem = f.common.files.current;
    const open = filesystem.openRead.bind(filesystem);
    const read = spyOn(filesystem, "openRead").mockImplementation((path, unique) => {
      opened.push(path);
      if (path === "demogameinfo.txt") throw new Error("metadata read abort");
      return open(path, unique);
    });
    const arenas = spyOn(ui.catalog, "loadArenas"), scores = spyOn(ui.scores, "loadBestScores");
    await expect(ui.runtime.runItemScript("main", "reload", action)).rejects.toThrow("metadata read abort");
    expect(opened).toEqual(["demogameinfo.txt"]);
    expect(scores).not.toHaveBeenCalled();
    expect(arenas).not.toHaveBeenCalled();
    opened.length = 0;
    await expect(ui.loader.reload(ui.gameInfo, ui.catalog)).rejects.toThrow("metadata read abort");
    expect(opened).toEqual(["demogameinfo.txt"]);
    expect(scores).not.toHaveBeenCalled();
    expect(arenas).not.toHaveBeenCalled();
    read.mockRestore();
    await ui.loader.load("ui/menus.txt", true);
    expect(ui.runtime.menuCount()).toBe(1);
  } finally { await f.close(); }
}, 20_000);
