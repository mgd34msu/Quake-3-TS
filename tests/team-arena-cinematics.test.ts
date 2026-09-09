import { HunkArena } from "../src/core/hunk.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonParseState } from "../src/core/common-parse.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { ClientStaticState } from "../src/engine/client-state.ts";
import { ClientKeys, keynumToString } from "../src/engine/client-keys.ts";
import { CinematicStatus, EngineCinematics } from "../src/engine/cinematics.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { ServerBrowser } from "../src/engine/server-browser.ts";
import { EngineSound } from "../src/engine/sound.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { EngineUiCinematics } from "../src/engine/ui-cinematics.ts";
import { DedicatedEventSource } from "../src/platform/dedicated-input.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { UiAssetRegistry } from "../src/render/font.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RendererResources } from "../src/render/world.ts";
import { loadMenuDefinitions } from "../src/ui/menu.ts";
import { UiRuntime } from "../src/ui/runtime.ts";
import { TeamArenaUiCinematics } from "../src/ui/team-arena/cinematics.ts";
import { TeamArenaUiCvars } from "../src/ui/team-arena/cvars.ts";
import { infoSlot, TeamArenaGameInfo, TeamArenaMenuBuffer } from "../src/ui/team-arena/game-info.ts";
import { TeamArenaUiMemory } from "../src/ui/team-arena/memory.ts";
import { TeamArenaUiResources } from "../src/ui/team-arena/resources.ts";
import { TeamArenaSelection } from "../src/ui/team-arena/selection.ts";
import { TeamArenaServerBrowser } from "../src/ui/team-arena/server-browser.ts";
import { TeamArenaTeamInfo } from "../src/ui/team-arena/team-info.ts";
import { deferred } from "./base-ui-fixture.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "quake3-team-cinematics-"));
  const printed: string[] = [], clock = new UnixSystemClock();
  const print = (text: string): undefined => { printed.push(text); };
  const io = new UnixIo(print, clock, { signals: "none" });
  const events = new CommonEvents(new DedicatedEventSource(io), print);
  let active = true, commonOpen = true, time = 0;
  const current = (): undefined => { if (!active) throw new Error("retired Team Arena cinematic operation"); };
  const commonCurrent = (): undefined => { if (!commonOpen) throw new Error("closed fixture common owner"); };
  const unexpected = (): never => { throw new Error("Cinematic fixture reached an unrelated product branch"); };
  const common = await CommonConsole.open({
    roots: { dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath, cdPath: null, product: "missionpack" },
    startup: new StartupCommands("+set s_initsound 0"), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
    platformPrint: print, resolveCommand: () => undefined, assertCommandEntry: commonCurrent, assertOwnerEntry: commonCurrent,
  }, commonCurrent);
  const sound = new EngineSound(common, events), images = new RendererImageCatalog();
  const cpu = new SoftwareRenderer(320, 180, images), recorder = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, [recorder]), builtins = new BuiltinImages(images, identityImageUploadProfile);
  const files = common.files.current;
  const movies = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: text => { const developer = common.cvars.get("developer"); if (developer !== undefined && developer.integerValue !== 0) common.output.print(text); return undefined; }, print: text => { common.output.print(text); return undefined; }, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => sound.mixer }, clock: { sample: () => time },
    scratchImages: builtins, console: { kind: "absent" }, settings: { hardware: "generic", maxTextureSize: 4096, inGameVideo: () => 1 } });
  let commands: RenderCommandBuffer | undefined, runtime: UiRuntime | undefined, resources: TeamArenaUiResources | undefined;
  const close = async (): Promise<void> => {
    runtime?.dispose(); resources?.dispose(); commands?.close("discard"); target.close(); movies.dispose();
    sound.close(); common.close(); commonOpen = false; io.close(); await rm(homePath, { recursive: true, force: true });
  };
  try {
    const settings = createRendererSettings();
    const renderer = await RendererResources.create(files, { kind: "unaccounted" }, settings,
      { patchMemory: { kind: "source-zone", zone: common.mainZone }, print, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: movies.shaderCinematics });
    commands = new RenderCommandBuffer(target, { print: (text: string) => { common.output.print(text); }, clock, identityLight: 1, tess: renderer.tess, runtime: settings.runtime });
    const cvars = new TeamArenaUiCvars(common.cvars, current), cinematics = new EngineUiCinematics(movies, "ui");
    resources = new TeamArenaUiResources({ renderer, sound, fontRegistry: new UiAssetRegistry(renderer, print),
      cinematics, cvars, assertCurrentOperation: current });
    const memory = new TeamArenaUiMemory("qvm32", print);
    const keys = new ClientKeys({ commands: common.commands, cvars: common.cvars, print, host: {
      assertCurrentOperation: current, readConnection: () => ({ kind: "disconnected", demoPlayback: false }),
      readUi: () => null, readCgame: () => null, disconnect: unexpected, stopAllSounds: () => { sound.stopAllSounds(); },
      addReliableCommand: unexpected, toggleConsole: unexpected, updateScreen: unexpected, consoleScroll: unexpected,
      readConsoleWidth: () => 78, clipboard: { kind: "native-unix-unavailable" },
    } });
    const definitions = await loadMenuDefinitions({ random: { nextInt: () => 0 }, resolver: { resolveRoot: unexpected, resolve: unexpected } },
      { kind: "ui", setPaths: [] }, {}, { memory: { kind: "qvm32", memory } });
    runtime = await UiRuntime.create({ definitions, cvars: common.cvars, commands: common.commands, resources,
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
      ownerDraw: { visible: unexpected, width: unexpected, value: unexpected, handleKey: unexpected, paint: unexpected, closeCinematic: unexpected },
    });
    const info = { menuBuffer: new TeamArenaMenuBuffer(common.files, print, current), sourceParser: new CommonParseState(),
      memory, resources: renderer, print, assertActive: current };
    const game = new TeamArenaGameInfo(info), teams = new TeamArenaTeamInfo(info);
    const selection = new TeamArenaSelection(game, teams, cvars, common.files, print, current);
    const browser = new ServerBrowser({ io, cvars: common.cvars, clientStatic: new ClientStaticState(),
      loopback: new LoopbackTransport(), print, assertCurrentOperation: current });
    const servers = new TeamArenaServerBrowser({ browser, cvars, gameInfo: game, runtime, commands: common.commands,
      calendar: clock, print, assertActive: current });
    const services = { cinematics, game, teams, selection, cvars, servers, assertActive: current };
    return { ...services, bridge: new TeamArenaUiCinematics(services), movies, common, files, commands, recorder, cpu, close,
      setTime: (value: number): void => { time = value; }, retire: (): void => { active = false; } };
  } catch (error) { await close(); throw error; }
}

const rect = { x: 20.9, y: 40.9, width: 200.9, height: 120.9 };

test("Team Arena traps use actual retail RoQ engine slots, draw extents and metadata stop destinations", async () => {
  const f = await fixture();
  try {
    expect(f.servers.currentServerCinematic).toBe(0);
    f.bridge.stop(-246); expect(f.servers.currentServerCinematic).toBe(-1);
    f.bridge.stop(-251); expect(infoSlot(f.teams.teamList, 0).cinematic).toBe(0);
    await f.game.parseGameInfo("gameinfo.txt"); await f.teams.parseTeamInfo("teaminfo.txt");
    const shader = await f.movies.shaderCinematics.playShaderCinematic("mpteam1.roq");
    expect(shader).not.toBeNull();
    const index = await f.bridge.play("crusaders.roq", rect);
    expect(index).toBe(1); expect(await f.bridge.play("mpteam1.roq", rect)).toBe(0);
    expect(await f.bridge.play("crusaders.roq", rect)).toBe(index);
    const handle = f.movies.handleAtSlot(index);
    if (handle === undefined) throw new Error("Missing actual engine handle");
    const draw = f.commands.draw2D("base-ui-640");
    f.bridge.draw(index, rect, draw); expect(f.recorder.rawDraws).toHaveLength(0);
    f.bridge.run(index); f.setTime(34); f.bridge.run(index); f.bridge.draw(index, rect, draw);
    expect(f.recorder.rawDraws.at(-1)?.rect).toEqual({ x: 10, y: 15, width: 100, height: 45 });
    expect(f.cpu.pixels.some((value, offset) => offset % 4 !== 3 && value !== 0)).toBe(true);
    expect(f.movies.prepareUiRaw(handle)?.dirty).toBe(false);
    const first = infoSlot(f.game.mapList, 0), second = infoSlot(f.game.mapList, 1);
    first.cinematic = index; second.cinematic = 0;
    f.cvars.writeInteger("ui_currentMap", 0);
    f.common.cvars.set("ui_currentMap", "1", true);
    f.bridge.stop(-244);
    expect(first.cinematic).toBe(-1); expect(second.cinematic).toBe(0);
    expect(f.movies.run(handle)).toBe(CinematicStatus.Idle);
    expect(await f.bridge.play("crusaders.roq", rect)).toBe(index);
    expect(f.movies.handleAtSlot(index)).toBe(handle);
    const team = infoSlot(f.teams.teamList, 0);
    team.cinematic = index;
    f.common.cvars.set("ui_teamName", "Crusaders", true);
    // Stop before a fresh frame still writes the metadata -1, even if CIN_Stop cannot free a slot.
    f.bridge.stop(-251); expect(team.cinematic).toBe(-1);
    const replacement = await f.bridge.play("mpteam2.roq", rect);
    f.servers.currentServerCinematic = replacement;
    f.bridge.run(replacement); f.setTime(68); f.bridge.run(replacement);
    f.bridge.stop(-246); expect(f.servers.currentServerCinematic).toBe(-1);
    const current = f.movies.handleAtSlot(replacement);
    if (current === undefined) throw new Error("Missing replacement handle");
    expect(f.movies.run(current)).toBe(CinematicStatus.Idle);
    const count = f.recorder.rawDraws.length;
    for (const invalid of [-1, 16, -2147483648, Number.NaN, 1.5]) {
      f.bridge.run(invalid); f.bridge.draw(invalid, rect, draw); f.bridge.stop(invalid);
    }
    expect(f.recorder.rawDraws).toHaveLength(count);
    expect(await f.bridge.play("missing-ui-cinematic.roq", rect)).toBe(-1);
    // Source team-name misses fall back to index zero, using the live engine cvar.
    team.cinematic = 16; f.common.cvars.set("ui_teamName", "Unknown team", true);
    f.bridge.stop(-251); expect(team.cinematic).toBe(-1);
    f.cvars.writeInteger("ui_currentMap", 128);
    f.bridge.stop(-999); f.bridge.stop(-244.5);
    expect(() => f.bridge.stop(-244)).toThrow("source 128-entry array");
    f.movies.dispose(); team.cinematic = 0;
    expect(() => f.bridge.stop(-251)).toThrow("disposed"); expect(team.cinematic).toBe(0);
  } finally { await f.close(); }
});

test("Team Arena play rejects a retired operation after actual asynchronous movie preparation", async () => {
  const f = await fixture(), gate = deferred();
  try {
    const read = f.files.read.bind(f.files);
    f.files.read = async path => { await gate.promise; return await read(path); };
    const pending = f.bridge.play("mpteam1.roq", rect);
    f.retire(); gate.resolve();
    await expect(pending).rejects.toThrow("retired Team Arena cinematic operation");
    const handle = f.movies.handleAtSlot(0);
    if (handle === undefined) throw new Error("Missing permanent BSS cell");
    expect(f.movies.run(handle)).toBe(CinematicStatus.Idle);
    expect(() => f.bridge.stop(0)).toThrow("retired");
    expect(() => f.bridge.run(-1)).toThrow("retired");
    expect(() => f.bridge.draw(-1, rect, f.commands.draw2D("pixels"))).toThrow("retired");
  } finally { gate.resolve(); await f.close(); }
});
