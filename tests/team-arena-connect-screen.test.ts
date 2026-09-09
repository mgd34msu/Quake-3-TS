import { HunkArena } from "../src/core/hunk.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { ClientConnectionState, ClientStaticState, type ClientConnectionPhase } from "../src/engine/client-state.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { EngineUiCinematics } from "../src/engine/ui-cinematics.ts";
import { EngineSound } from "../src/engine/sound.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { DedicatedEventSource } from "../src/platform/dedicated-input.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { UiAssetRegistry, textPaint, textWidth } from "../src/render/font.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RendererResources } from "../src/render/world.ts";
import { loadMenuDefinitions } from "../src/ui/menu.ts";
import { UiRuntime } from "../src/ui/runtime.ts";
import { TeamArenaConnectScreen, connectionDownloadTime, readableDownloadSize } from "../src/ui/team-arena/connect-screen.ts";
import { TeamArenaUiCvars } from "../src/ui/team-arena/cvars.ts";
import { TeamArenaUiResources } from "../src/ui/team-arena/resources.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

type Line = readonly [y: number, text: string];
const background = { x: .125, y: .25, z: .5, w: 1 };
function unused(): never { throw new Error("Connect fixture reached an unrelated menu service"); }

async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "quake3-team-arena-connect-"));
  const printed: string[] = [], clock = new UnixSystemClock();
  const print = (text: string): undefined => { printed.push(text); };
  const io = new UnixIo(print, clock, { signals: "none" });
  const events = new CommonEvents(new DedicatedEventSource(io), print);
  let current = true;
  const assertActive = (): undefined => { if (!current) throw new Error("Fixture UI operation retired"); };
  const common = await CommonConsole.open({
    roots: { dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath, cdPath: null, product: "missionpack" },
    startup: new StartupCommands("+set s_initsound 0"), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
    platformPrint: print, resolveCommand: () => undefined, assertCommandEntry: assertActive, assertOwnerEntry: assertActive,
  }, assertActive);
  const sound = new EngineSound(common, events), images = new RendererImageCatalog();
  const cpu = new SoftwareRenderer(320, 240, images), recording = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, [recording]), builtins = new BuiltinImages(images, identityImageUploadProfile), files = common.files.current;
  const movies = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: text => { const developer = common.cvars.get("developer"); if (developer !== undefined && developer.integerValue !== 0) common.output.print(text); return undefined; }, print: text => { common.output.print(text); return undefined; }, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => sound.mixer }, clock: { sample: () => clock.milliseconds() },
    scratchImages: builtins, console: { kind: "absent" }, settings: { hardware: "generic", maxTextureSize: 4096, inGameVideo: () => 1 } });
  const settings = createRendererSettings();
  const renderer = await RendererResources.create(files, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "source-zone", zone: common.mainZone }, print, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: movies.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { common.output.print(text); }, clock, identityLight: 1, tess: renderer.tess, runtime: settings.runtime });
  const cvars = new TeamArenaUiCvars(common.cvars, assertActive);
  const cinematics = new EngineUiCinematics(movies, "ui");
  const resources = new TeamArenaUiResources({ renderer, sound, cinematics, cvars, assertCurrentOperation: assertActive,
    fontRegistry: new UiAssetRegistry(renderer, print) });
  await resources.initializeDisplayAssets();
  const definitions = await loadMenuDefinitions({ random: { nextInt: () => 1 }, resolver: {
    resolveRoot: path => ({ path, text: path === "set" ? 'loadMenu { "connect" }' : `
      assetGlobalDef { font "fonts/arial.ttf" 16 smallFont "fonts/arial.ttf" 12 bigFont "fonts/arial.ttf" 20 }
      menuDef { name "Connect" rect 0 0 640 480 style 1 backcolor .125 .25 .5 1 visible 0 }
    ` }), resolve: () => undefined,
  } }, { kind: "ui", setPaths: ["set"] }, {}, { registrationSink: resources, assetSink: resources });
  const runtime = await UiRuntime.create({ definitions, cvars: common.cvars, commands: common.commands, resources,
    fonts: resources.fonts, widgetAssets: resources.widgetAssets, zeroPicture: renderer.picture(null), cinematics,
    audio: { playLocal: unused, startBackground: unused, stopBackground: unused }, paintModel: unused,
    context: { kind: "ui", bindings: { getBinding: () => "", keyName: unused, setBinding: unused,
      getOverstrike: unused, setOverstrike: unused }, pause: unused },
    feeder: { count: unused, item: unused, image: unused, select: unused },
    ownerDraw: { visible: unused, width: unused, value: unused, handleKey: unused, paint: unused, closeCinematic: unused },
    externalScript: { run: unused }, getTeamColor: unused });
  const frame = { time: 3000, frameTime: 16, draw: commands.draw2D("team-ui-640") };
  const screen = new TeamArenaConnectScreen({ resources, runtime, cvars, assertActive });
  const begin = (): number => {
    const index = recording.trace().length;
    commands.addView({ viewport: { x: 0, y: 0, width: 320, height: 240 },
      clear: { stencil: false, color: { x: 0, y: 0, z: 0, w: 1 }, depth: 1 }, operations: [{ kind: "draw", batches: [] }] });
    return index;
  };
  const center = (y: number, text: string): void => {
    textPaint(frame.draw, resources.fonts, { x: 320 - Math.trunc(textWidth(resources.fonts, text, .5) / 2),
      y, scale: .5, color: { x: 1, y: 1, z: 1, w: 1 }, text, adjust: 0, limit: 0, style: 6 });
  };
  const compare = async (paint: () => Promise<void>, lines: readonly Line[]): Promise<void> => {
    const actualStart = begin(); await paint(); expect(commands.submitFrame()?.batches).toBeGreaterThan(0);
    const actualPixels = Buffer.from(cpu.pixels), expectedStart = begin();
    frame.draw.fillRect({ x: 0, y: 0, width: 640, height: 480 }, background, resources.assets.whiteShader);
    for (const [y, text] of lines) center(y, text);
    commands.submitFrame();
    expect(actualPixels.equals(Buffer.from(cpu.pixels))).toBe(true);
    const trace = recording.trace();
    // Includes the deliberately off-screen y=600 MOTD, not just visible pixels.
    expect(trace.slice(actualStart, expectedStart).flatMap(view => view.batches.map(batch => batch.vertices)))
      .toEqual(trace.slice(expectedStart).flatMap(view => view.batches.map(batch => batch.vertices)));
  };
  return { common, commands, cpu, resources, runtime, screen, frame, compare, printed, begin, recording,
    retire: () => { current = false; },
    close: async () => {
      current = true; runtime.dispose(); resources.dispose(); movies.dispose(); commands.close("discard"); target.close();
      sound.close(); common.close(); io.close(); await rm(homePath, { recursive: true, force: true });
    } };
}

test("Team Arena download formatting keeps strict thresholds and signed source arithmetic", () => {
  const sizes: readonly (readonly [number, string])[] = [[0, "0 bytes"], [1024, "1024 bytes"], [1025, "1 KB"],
    [1048576, "1024 KB"], [1572864, "1.50 MB"], [1073741824, "1024.00 MB"], [1610612736, "1.-2 GB"], [-1, "-1 bytes"]];
  for (const [value, text] of sizes) expect(readableDownloadSize(value)).toBe(text);
  for (const [value, text] of [[0, "0 sec"], [60000, "60 sec"], [61000, "1 min 1 sec"], [3600000, "60 min 0 sec"],
    [3661000, "1 hr 1 min"], [-1999, "-1 sec"]] satisfies readonly (readonly [number, string])[]) {
    expect(connectionDownloadTime(value)).toBe(text);
  }
});

test("callable centered text helpers retain parameters, ignored adjust, bounded copies and partial overflow paint", async () => {
  const f = await fixture();
  try {
    const x = 143.75, y = 81.5, scale = .37, text = "Center", color = { x: .2, y: .6, z: .9, w: 1 };
    const actualStart = f.begin();
    f.screen.textPaintCenter(f.frame.draw, x, y, scale, color, text, 300);
    f.commands.submitFrame(); const actualPixels = Buffer.from(f.cpu.pixels);
    const expectedStart = f.begin();
    textPaint(f.frame.draw, f.resources.fonts, { x: Math.fround(x - Math.trunc(textWidth(f.resources.fonts, text, Math.fround(scale)) / 2)),
      y, scale: Math.fround(scale), color, text, adjust: 0, limit: 0, style: 6 });
    f.commands.submitFrame(); expect(actualPixels.equals(Buffer.from(f.cpu.pixels))).toBe(true);
    const trace = f.recording.trace();
    expect(trace.slice(actualStart, expectedStart).flatMap(view => view.batches.map(batch => batch.vertices)))
      .toEqual(trace.slice(expectedStart).flatMap(view => view.batches.map(batch => batch.vertices)));
    const center = f.screen.textPaintCenter.bind(f.screen), reached: (readonly [number, number, number, string | null, number])[] = [];
    f.screen.textPaintCenter = (draw, px, py, size, rgba, value, adjust) => {
      reached.push([px, py, size, value, adjust]); center(draw, px, py, size, rgba, value, adjust);
    };
    const wordWidth = textWidth(f.resources.fonts, "WW", .5);
    f.screen.textPaintCenterAutoWrapped(f.frame.draw, 123, 50, wordWidth, 13.25, .5, color, "WW WW", 7);
    expect(reached).toEqual([[123, 50, .5, "WW", 7], [123, 63.25, .5, "WW", 7]]);
    reached.length = 0;
    f.screen.textPaintCenterAutoWrapped(f.frame.draw, 1, 2, 1e9, 5, .25, color, "A".repeat(1100), 9);
    expect(reached).toEqual([[1, 2, .25, "A".repeat(1023), 9]]);
    reached.length = 0;
    f.screen.textPaintCenterAutoWrapped(f.frame.draw, 1, 2, 1, 5, .25, color, null, 0);
    expect(reached).toEqual([]);
    expect(() => f.screen.textPaintCenterAutoWrapped(f.frame.draw, 1, 2, 1, 5, .5, color, "WW", 0))
      .toThrow("uninitialized source buffer");
    expect(reached).toEqual([[1, 2, .5, "WW", 0]]);
    reached.length = 0;
    f.common.cvars.set("cl_downloadSize", "8192"); f.common.cvars.set("cl_downloadCount", "2048");
    f.common.cvars.set("cl_downloadTime", "0");
    f.screen.displayDownloadInfo(f.frame.draw, 100, "pak.pk3", 123, 10.25, .75);
    expect(reached).toEqual([[123, 122.25, .75, "Downloading:", 0], [123, 202.25, .75, "Estimated time left:", 0],
      [123, 258.25, .75, "Transfer rate:", 0], [123, 146.25, .75, "pak.pk3 (25%)", 0],
      [320, 226.25, .75, "estimating", 0], [320, 170.25, .75, "(2 KB of 8 KB copied)", 0]]);
    f.commands.submitFrame();
  } finally { await f.close(); }
});

test("Team Arena forces the actual Connect menu then paints retail-font client states and wrapped errors", async () => {
  const f = await fixture(), cls = new ClientStaticState(), clc = new ClientConnectionState();
  try {
    expect(f.resources.fonts.big.name).toBe("fonts/fontImage_20.dat");
    const cases: readonly (readonly [ClientConnectionPhase, string | null, boolean])[] = [
      ["connecting", "Awaiting connection...3", true], ["challenging", "Awaiting challenge...3", true],
      ["connected", "Awaiting gamestate...", false], ["loading", null, false], ["primed", null, false],
    ];
    cls.servername = "quake.example"; cls.updateInfoString = "\\motd\\Team Arena";
    clc.connectPacketCount = 3; clc.serverMessage = "Server is full";
    for (const [phase, status, message] of cases) {
      cls.phase = phase;
      const lines: Line[] = [[178, "Connecting to quake.example"], [600, "Team Arena"]];
      if (message) lines.push([306, "Server is full"]);
      if (status !== null) lines.push([210, status]);
      await f.compare(() => f.screen.draw(false, f.frame, cls, clc, null), lines);
    }
    cls.servername = "LOCALHOST"; cls.phase = "connecting"; clc.serverMessage = "";
    await f.compare(() => f.screen.draw(false, f.frame, cls, clc, null), [[178, "Starting up..."], [600, "Team Arena"]]);
    const word = "W".repeat(20);
    expect(textWidth(f.resources.fonts, word, .5)).toBeLessThan(630);
    expect(textWidth(f.resources.fonts, `${word} ${word}`, .5)).toBeGreaterThan(630);
    clc.serverMessage = `${word} ${word} end`;
    await f.compare(() => f.screen.draw(false, f.frame, cls, clc, null),
      [[178, "Starting up..."], [600, "Team Arena"], [306, word], [326, `${word} end`]]);
    clc.serverMessage = "W".repeat(1023);
    await expect(f.screen.draw(false, f.frame, cls, clc, null)).rejects.toThrow("source buffer");
    f.commands.submitFrame(); clc.serverMessage = ""; cls.servername = "x".repeat(242);
    await expect(f.screen.draw(false, f.frame, cls, clc, null)).rejects.toThrow("256-byte");
  } finally { await f.close(); }
}, 20000);

test("Team Arena downloads sample live cvars against UI time, with estimating and measured-rate layouts", async () => {
  const f = await fixture(), cls = new ClientStaticState(), clc = new ClientConnectionState();
  try {
    cls.phase = "connected"; cls.servername = "localhost"; cls.realtime = 900000;
    const cases: readonly (readonly [number, number, number, string, string, string, string | null])[] = [
      [8192, 2048, 0, "pak.pk3 (25%)", "estimating", "(2 KB of 8 KB copied)", null],
      [65536, 8192, 1000, "pak.pk3 (12%)", "14 sec", "(8 KB of 64 KB copied)", "4 KB/Sec"],
      [0, 8192, 1000, "pak.pk3", "estimating", "(8 KB copied)", "4 KB/Sec"],
      [65536, 8192, 3000, "pak.pk3 (12%)", "estimating", "(8 KB of 64 KB copied)", null],
    ];
    for (const [size, count, time, title, eta, copied, rate] of cases) {
      for (const [name, value] of [["cl_downloadName", "pak.pk3"], ["cl_downloadSize", String(size)],
        ["cl_downloadCount", String(count)], ["cl_downloadTime", String(time)]] satisfies readonly (readonly [string, string])[]) f.common.cvars.set(name, value);
      const lines: Line[] = [[178, "Starting up..."], [242, "Downloading:"], [322, "Estimated time left:"],
        [378, "Transfer rate:"], [266, title], [346, eta], [290, copied]];
      if (rate !== null) lines.push([402, rate]);
      await f.compare(() => f.screen.draw(false, f.frame, cls, clc, null), lines);
    }
    f.common.cvars.set("cl_downloadSize", "1"); f.common.cvars.set("cl_downloadCount", "4096");
    f.common.cvars.set("cl_downloadTime", "1000");
    await expect(f.screen.draw(false, f.frame, cls, clc, null)).rejects.toThrow("integer division");
  } finally { await f.close(); }
}, 20000);

test("Team Arena overlay returns before painting or session reads; non-overlay copies after menu paint", async () => {
  const f = await fixture(), lifecycle = new ProtocolClientLifecycle(f.common.cvars);
  const client = new EngineClientSession({ product: "missionpack", cvars: f.common.cvars, lifecycle,
    mode: { kind: "network", challenge: 17, qport: 27961 } });
  try {
    const cls = lifecycle.clientStatic, clc = lifecycle.clientConnection;
    cls.servername = "localhost"; cls.phase = "loading";
    f.cpu.pixels.fill(31);
    await f.screen.draw(true, f.frame, cls, new ClientConnectionState(), client);
    expect(f.commands.submitFrame()?.batches).toBe(0); expect(f.cpu.pixels.every(value => value === 31)).toBe(true);
    expect(client.getConfigString(0)).toBeNull();
    await f.compare(() => f.screen.draw(false, f.frame, cls, clc, client), [[178, "Starting up..."]]);
    for (const [sequence, map] of [[1, "q3tourney6"], [2, ""]] satisfies readonly (readonly [number, string])[]) {
      await client.receiveServerMessage(sequence, encodeServerMessage(0, [{ kind: "gamestate", commandSequence: 0,
        clientNumber: 0, checksumFeed: 19, entries: [{ kind: "configstring", index: 0, value: map === "" ? "" : `\\mapname\\${map}` },
          { kind: "configstring", index: 1, value: "\\sv_serverid\\100\\sv_cheats\\1\\fs_game\\missionpack" }] }],
      { product: "missionpack", messageNumber: sequence, reliableSequence: 0, serverCommandSequence: 0,
        parseEntitiesNumber: 0, baseline: () => null, history: () => null }));
      cls.phase = "loading";
      await f.compare(() => f.screen.draw(false, f.frame, cls, clc, client), [[130, `Loading ${map}`], [178, "Starting up..."]]);
    }
    cls.phase = "connected"; cls.servername = "before-config";
    const getConfigString = client.getConfigString.bind(client);
    client.getConfigString = index => {
      const result = getConfigString(index);
      cls.phase = "loading"; cls.servername = "after-config";
      f.common.cvars.set("cl_downloadName", "live.pk3");
      return result;
    };
    await f.compare(() => f.screen.draw(false, f.frame, cls, clc, client), [[130, "Loading "],
      [178, "Connecting to before-config"], [242, "Downloading:"], [322, "Estimated time left:"],
      [378, "Transfer rate:"], [266, "live.pk3"], [346, "estimating"], [290, "(0 bytes of 0 bytes copied)"]]);
    client.getConfigString = getConfigString;
    const paintNamed = f.runtime.paintNamed.bind(f.runtime);
    f.runtime.paintNamed = async (name, frame, force) => {
      const painted = await paintNamed(name, frame, force);
      cls.servername = "after-paint"; cls.phase = "challenging"; clc.connectPacketCount = 7;
      f.common.cvars.set("cl_downloadName", ""); return painted;
    };
    await f.compare(() => f.screen.draw(false, f.frame, cls, clc, client),
      [[130, "Loading "], [178, "Connecting to after-paint"], [210, "Awaiting challenge...7"]]);
    await expect(f.screen.draw(false, f.frame, cls, new ClientConnectionState(), client)).rejects.toThrow("actual client states");
    f.commands.submitFrame(); lifecycle.close();
    await expect(f.screen.draw(false, f.frame, cls, clc, client)).rejects.toThrow("no longer current");
    f.commands.submitFrame(); f.retire();
    await expect(f.screen.draw(false, f.frame, cls, clc, client)).rejects.toThrow("retired");
  } finally { lifecycle.close(); await f.close(); }
}, 20000);
