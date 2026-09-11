import { HunkArena } from "./core/hunk.ts";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { VirtualFileSystem } from "./assets/vfs.ts";
import { NativeRoot } from "./assets/native-root.ts";
import { parseBsp } from "./assets/bsp.ts";
import { add3, angleVectors, anglesToAxis, scale3 } from "./core/math.ts";
import { createRefdef } from "./render/refdef.ts";
import type { Vec3 } from "./core/math.ts";
import { encodePng } from "./core/png.ts";
import { discoverDataPath, findDataPath } from "./engine/data-path.ts";
import { DedicatedServerHost } from "./engine/dedicated-server.ts";
import type { DedicatedRunLimit } from "./engine/dedicated-server.ts";
import { ClientHost } from "./engine/client-host.ts";
import type { CommonRunLimit } from "./engine/common-frame.ts";
import { LocalPlayer } from "./engine/local-player.ts";
import { SdlWindow } from "./platform/sdl.ts";
import { SoftwareRenderer } from "./render/cpu/rasterizer.ts";
import { GlRenderer } from "./render/gl/renderer.ts";
import { RendererResources } from "./render/world.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "./render/settings.ts";
import { RendererConfiguration } from "./render/configuration.ts";
import type { ConfiguredRenderer } from "./render/configuration.ts";
import { CvarRegistry } from "./core/cvar.ts";
import { AudioMixer } from "./audio/mixer.ts";
import { EngineCinematics } from "./engine/cinematics.ts";
import { BuiltinImages } from "./render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "./render/commands.ts";
import type { SourceRenderView, ViewOperation } from "./render/types.ts";
import { RendererImageCatalog } from "./render/image-resource.ts";

const help = `Quake III TypeScript port

Play from a directory containing quake3-ts and baseq3/:
  ./quake3-ts client --data . --home ~/.local/share/quake3-ts --renderer gl -- +map q3dm1
From the source checkout:
  bun start client --data /path/to/Quake3 --home ~/.local/share/quake3-ts --renderer gl -- +map q3dm1

The client subcommand and a writable --home separate from retail data are required.
Put +commands after --. For the menu without intro videos, use +echo menu instead
of +map q3dm1. For Team Arena, add --product missionpack before -- and use +map mpteam1.
Use client --help for game options or server --help for a dedicated server.

Asset inspection and render diagnostics (fly viewer, not a match):
bun start inspect --map q3dm1
bun start render --map q3dm1 --renderer cpu --output .artifacts/q3dm1.png
bun start render --map mpteam1 --product missionpack --renderer gl --interactive
bun start server --help
bun start client --help

Inspect/render options:
  --data PATH                 Installed game directory containing baseq3
  --product baseq3|missionpack
  --map NAME                  Map name without maps/ or .bsp
  --renderer cpu|gl           TypeScript software or SDL2 OpenGL renderer
  --width N --height N        Framebuffer size, default 640x480
  --frames N                 Render fixed frames, default 1
  --time SECONDS             Initial material animation time, default 0
  --output PATH              Save final RGBA frame as PNG
  --hidden                   Create a hidden SDL2 window
  --interactive              Fly camera: WASD, space/C, drag left mouse, Esc
  --walk                     Use ported player movement and BSP collision

Quake III and Team Arena gameplay, bots and menus are integrated.
See docs/COMPATIBILITY.md for supported profiles and docs/STATUS.md for optimization work.
`;

const serverHelp = `Dedicated server

bun start server --data /path/to/Quake3 --home /path/to/server-home -- \\
  +set bot_enable 0 +set sv_pure 0 +map q3dm1

Options before --:
  --data PATH                 Default retail directory; Q3_DATA or discovery if omitted
  --home PATH                 Required writable server home, separate from retail data
  --cdpath PATH               Optional read-only CD search root
  --missing-files PATH        Append failed source file opens to this diagnostic log
  --product baseq3|missionpack Default baseq3
  --frames N                  Stop after N common frames, not fixed simulation steps
  --help                      Show this help without initializing the engine

Arguments after -- use the original +command parser. Native +set fs_* values
override the default roots. Console input uses the same command queue. EOF does
not quit. The quit command requests ordered shutdown; SIGTERM follows the source
signal handler's immediate platform cleanup and exit. Dedicated mode 1 is
the default. The current console uses line-oriented Latin-1 input.

Source bot AI is integrated. Use +addbot Sarge 3 after +map to add an opponent,
or bot_enable 0 for human-only play. Full mode and parity coverage remains open.
`;

const clientHelp = `Graphical client and listen server

./quake3-ts client --data . --home ~/.local/share/quake3-ts --renderer gl -- +map q3dm1

From the source checkout:
bun start client --data /path/to/Quake3 --home /path/to/client-home --renderer cpu -- \\
  +set bot_enable 0 +set sv_pure 0 +map q3dm1

Options before --:
  --data PATH                 Retail installation; Q3_DATA or discovery if omitted
  --home PATH                 Required writable client home, separate from retail
  --cdpath PATH               Optional read-only CD search root
  --missing-files PATH        Append failed source file opens to this diagnostic log
  --product baseq3|missionpack Default baseq3; selects the actual product menus/game
  --renderer cpu|gl           TypeScript software or SDL2 OpenGL renderer
  --width N --height N        Window dimensions, default 640x480
  --sound-rate N              SDL output sample rate, default 48000
  --hidden                    Create a hidden window
  --frames N                  Stop after N common frames
  --help                      Print help without starting SDL or the engine

Use +map NAME after -- to start a match; --map is an inspect/render option.
For Team Arena, add --product missionpack before -- and use +map mpteam1.
Replace +map q3dm1 with +echo menu to open the menu without intro videos.
Arguments after -- use the original +command parser. Without startup commands,
the client follows its cinematic/menu startup. This application is still being
ported: bots play through the source AI, but complete mode coverage, stock pure
compatibility and full parity remain incomplete. No retail files or CD keys
are imported into the project.
`;

function integerOption(value: string, name: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${name} must be ${minimum}..${maximum}`);
  return number;
}

async function main(): Promise<void> {
  if (Bun.argv[2] === "server") { await dedicatedMain(Bun.argv.slice(3)); return; }
  if (Bun.argv[2] === "client") { await clientMain(Bun.argv.slice(3)); return; }
  const { positionals, values } = parseArgs({
    args: Bun.argv.slice(2), allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" }, data: { type: "string" },
      product: { type: "string", default: "baseq3" }, map: { type: "string", default: "q3dm1" },
      renderer: { type: "string", default: "cpu" }, width: { type: "string", default: "640" },
      height: { type: "string", default: "480" }, frames: { type: "string", default: "1" },
      time: { type: "string", default: "0" }, output: { type: "string" },
      hidden: { type: "boolean", default: false }, interactive: { type: "boolean", default: false },
      walk: { type: "boolean", default: false },
    },
  });
  if (values.help === true || positionals.length === 0) { process.stdout.write(help); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || (command !== "inspect" && command !== "render")) throw new Error("Expected inspect or render; use --help");
  if (values.product !== "baseq3" && values.product !== "missionpack") throw new Error("Product must be baseq3 or missionpack");
  if (values.renderer !== "cpu" && values.renderer !== "gl") throw new Error("Renderer must be cpu or gl");
  if (!/^[a-zA-Z0-9_/-]+$/.test(values.map) || values.map.includes("..") || values.map.startsWith("/")) throw new Error("Invalid map name");
  const dataPath = await findDataPath(values.data);
  const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: values.product });
  try {
    const mapPath = `maps/${values.map}.bsp`;
    if (command === "inspect") {
      const map = parseBsp(await vfs.read(mapPath), mapPath);
      process.stdout.write(JSON.stringify({
        product: values.product, dataPath, map: mapPath, source: vfs.source(mapPath),
        entities: map.entityRecords.length, vertices: map.vertices.length, surfaces: map.surfaces.length,
        brushes: map.brushes.length, models: map.models.length, lightmaps: map.lightmaps.length,
        clusters: map.visibility?.clusterCount ?? 0,
      }, null, 2) + "\n");
      return;
    }
    const width = integerOption(values.width, "width", 16, 4096);
    const height = integerOption(values.height, "height", 16, 4096);
    const frameLimit = integerOption(values.frames, "frames", 1, 100000);
    const initialTime = Number(values.time);
    if (!Number.isFinite(initialTime)) throw new Error("Time must be finite");
    const registered = new RegisteredRendererCvars(new CvarRegistry(), process.platform === "linux" ? "linux" : "other");
    const window = SdlWindow.open({ title: `Quake III TypeScript - ${values.map}`, width, height, backend: values.renderer, hidden: values.hidden });
    let gl: GlRenderer | null = null;
    let cpu: SoftwareRenderer | null = null;
    let target: RenderTarget | null = null;
    let cinematics: EngineCinematics | null = null;
    let configuration: RendererConfiguration | null = null;
    try {
      const images = new RendererImageCatalog();
      gl = values.renderer === "gl" ? new GlRenderer(window, images) : null;
      cpu = values.renderer === "cpu" ? new SoftwareRenderer(width, height, images, 8, 0, 0) : null;
      const backend = cpu ?? gl;
      if (backend === null) throw new Error("No renderer was constructed");
      target = new RenderTarget(images, [backend]);
      const settings = new SourceRendererSettings(registered, backend.capabilities);
      const configuredRenderer: ConfiguredRenderer | null = cpu !== null ? { kind: "cpu", backend: cpu }
        : gl !== null ? { kind: "gl", backend: gl } : null;
      if (configuredRenderer === null) throw new Error("No renderer was constructed");
      const actualConfiguration = RendererConfiguration.create({ window, renderer: configuredRenderer, settings });
      configuration = actualConfiguration;
      const imageProfile = () => actualConfiguration.imageUploadProfile();
      const builtins = new BuiltinImages(images, imageProfile);
      const clockOrigin = performance.now();
      let diagnosticMilliseconds = 0;
      const clock = { milliseconds: () => values.interactive ? Math.trunc(performance.now() - clockOrigin) : diagnosticMilliseconds };
      const mixer = new AudioMixer(44100, clock.milliseconds);
      cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), files: { kind: "retained", current: () => vfs }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
        print: text => { process.stderr.write(text); },
        developerPrint: text => { process.stderr.write(text); },
        console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
      const resources = await RendererResources.create(vfs, { kind: "unaccounted" }, settings,
        { patchMemory: { kind: "diagnostic" }, target, images, builtins, shaderCinematics: cinematics.shaderCinematics, imageProfile,
          print: text => { process.stderr.write(text); },
          drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); } });
      const commands = new RenderCommandBuffer(target, { print: (text: string) => { process.stderr.write(text); }, clock, identityLight: imageProfile().colorMappings.identityLight,
        tess: resources.tess, runtime: settings.runtime });
      const world = await resources.loadWorld(values.map);
      const player = values.walk ? new LocalPlayer(parseBsp(await vfs.read(mapPath), mapPath), values.product) : null;
      const initial = player?.camera ?? world.initialCamera();
      let origin = initial.origin;
      let angles = initial.angles;
      const keys = new Set<number>();
      let running = true;
      let frames = 0;
      let triangles = 0;
      let lastPixels = new Uint8Array(width * height * 4);
      const started = performance.now();
      let previous = started;
      do {
        const now = performance.now();
        const elapsed = Math.min((now - previous) / 1000, 0.1);
        previous = now;
        for (const event of window.pollEvents()) {
          if (event.kind === "quit") running = false;
          if (event.kind === "key") {
            if (event.keycode === 27 && event.down) running = false;
            if (event.down) keys.add(event.keycode); else keys.delete(event.keycode);
          }
          if (event.kind === "mouse-motion" && (event.buttons & 1) !== 0 && values.interactive) {
            angles = { x: Math.max(-89, Math.min(89, angles.x + event.dy * 0.2)), y: angles.y - event.dx * 0.2, z: 0 };
          }
        }
        if (values.interactive && player === null) {
          const axes = angleVectors(angles);
          let direction: Vec3 = { x: 0, y: 0, z: 0 };
          if (keys.has(119)) direction = add3(direction, axes.forward);
          if (keys.has(115)) direction = add3(direction, scale3(axes.forward, -1));
          if (keys.has(100)) direction = add3(direction, axes.right);
          if (keys.has(97)) direction = add3(direction, scale3(axes.right, -1));
          if (keys.has(32)) direction = add3(direction, { x: 0, y: 0, z: 1 });
          if (keys.has(99)) direction = add3(direction, { x: 0, y: 0, z: -1 });
          origin = add3(origin, scale3(direction, elapsed * 320));
        }
        if (player !== null) {
          player.advance({
            serverTime: values.interactive ? Math.max(player.state.commandTime + 1, Math.round(now - started)) : (frames + 1) * 16,
            angles: { x: Math.trunc(angles.x * 65536 / 360) & 65535, y: Math.trunc(angles.y * 65536 / 360) & 65535, z: 0 },
            buttons: 0, weapon: player.state.weapon,
            forwardmove: (keys.has(119) ? 127 : 0) - (keys.has(115) ? 127 : 0),
            rightmove: (keys.has(100) ? 127 : 0) - (keys.has(97) ? 127 : 0),
            upmove: keys.has(32) ? 127 : keys.has(99) ? -127 : 0,
          });
          origin = player.camera.origin;
          angles = player.camera.angles;
        }
        const elapsedMilliseconds = values.interactive ? now - started : frames * 1000 / 60;
        diagnosticMilliseconds = Math.trunc(elapsedMilliseconds);
        const time = initialTime + elapsedMilliseconds / 1000;
        const refdef = createRefdef();
        refdef.width = width; refdef.height = height;
        refdef.fovX = 90; refdef.fovY = Math.atan(height / width) * 360 / Math.PI;
        refdef.viewOrigin = origin; refdef.viewAxis = anglesToAxis(angles); refdef.time = Math.trunc(time * 1000);
        const clear = { x: 0.05, y: 0.05, z: 0.08, w: 1 };
        actualConfiguration.beginFrame(commands);
        commands.beginFrame();
        commands.addView({ viewport: { x: 0, y: 0, width, height }, clear: { stencil: false, depth: 1, color: clear }, operations: [{ kind: "draw", batches: [] }] });
        const prepare = world.prepareFrame({ refdef });
        commands.addPreparedViews(function* (drawSurfs): Generator<SourceRenderView, void, unknown> {
          triangles = 0;
          for (const view of prepare(drawSurfs)) {
            const operations = function* (): Generator<ViewOperation, void, unknown> {
              for (const operation of view.operations) {
                const count = operation.kind === "draw" ? operation.batches.reduce((total, batch) => total + batch.indices.length / 3, 0)
                  : operation.kind === "source-stage" || operation.kind === "source-tess-stage" ? operation.stage.batch.indices.length / 3
                  : operation.kind === "sky-side" ? operation.strips.reduce((total, strip) => total + Math.max(0, strip.length - 2), 0) : 0;
                yield operation;
                triangles += count;
              }
            };
            yield { viewport: view.viewport, get clear() { return view.clear; }, operations: operations(),
              ...(view.clipPlane === undefined ? {} : { clipPlane: view.clipPlane }),
              ...(view.beforeView === undefined ? {} : { beforeView: view.beforeView }) };
          }
        });
        const receipt = commands.submitFrame(() => {
          if (cpu !== null) {
            window.present(cpu.pixels);
            if (values.output !== undefined) lastPixels = new Uint8Array(cpu.pixels);
          } else if (gl !== null) {
            if (values.output !== undefined) lastPixels = new Uint8Array(gl.readPixels());
            window.swap();
          }
        });
        if (receipt !== null) world.resources.rolloverFrame();
        frames++;
        if (values.interactive) await Bun.sleep(1);
      } while (running && (values.interactive || frames < frameLimit));
      if (values.output !== undefined) {
        await mkdir(dirname(values.output), { recursive: true });
        await Bun.write(values.output, encodePng(width, height, lastPixels));
      }
      process.stdout.write(JSON.stringify({
        map: values.map, product: values.product, renderer: values.renderer, width, height, frames,
        triangles, elapsedMilliseconds: Math.round(performance.now() - started),
        camera: { origin, angles }, output: values.output ?? null,
        diagnostics: world.diagnostics, driver: gl?.driver ?? null,
      }, null, 2) + "\n");
    } catch (error: unknown) {
      if (target !== null) target.fail(error);
      throw error;
    } finally {
      try {
        try { target?.close(); }
        finally { cinematics?.dispose(); }
      } finally {
        try { configuration?.close(); }
        finally {
          try { cpu?.close(); gl?.close(); }
          finally { window.close(); }
        }
      }
    }
  } finally {
    vfs.close();
  }
}

async function dedicatedMain(args: readonly string[]): Promise<void> {
  const separator = args.indexOf("--");
  const { values } = parseArgs({ args: separator < 0 ? args : args.slice(0, separator), options: {
    help: { type: "boolean", short: "h" }, data: { type: "string" }, home: { type: "string" },
    cdpath: { type: "string" }, product: { type: "string", default: "baseq3" }, frames: { type: "string" },
    "missing-files": { type: "string" },
  } });
  if (values.help === true) { process.stdout.write(serverHelp); return; }
  if (values.home === undefined || values.home.length === 0) throw new Error("--home is required and must be nonempty");
  if (values.product !== "baseq3" && values.product !== "missionpack") throw new Error("Product must be baseq3 or missionpack");
  const limit: DedicatedRunLimit = values.frames === undefined ? { kind: "continuous" }
    : { kind: "frames", count: integerOption(values.frames, "frames", 1, 2147483647) };
  // Sys_DefaultInstallPath falls back to the working directory. Validate effective
  // roots in CommonConsole only after the native early startup-variable passes.
  const dataPath = values.data ?? process.env["Q3_DATA"] ?? await discoverDataPath() ?? process.cwd();
  const host = await DedicatedServerHost.open({
    roots: { dataPath, homePath: values.home, cdPath: values.cdpath ?? null, product: values.product,
      ...(values["missing-files"] === undefined ? {} : { missingFileLogPath: values["missing-files"] }) },
    startupText: separator < 0 ? "" : NativeRoot.fromHost(args.slice(separator + 1).join(" ")).sourceText,
    buildDate: "development",
    print: text => { process.stdout.write(text); },
    bots: { kind: "source" },
  });
  try { await host.run(limit); }
  finally { await host.close(); }
}

async function clientMain(args: readonly string[]): Promise<void> {
  const separator = args.indexOf("--");
  const { values } = parseArgs({ args: separator < 0 ? args : args.slice(0, separator), options: {
    help: { type: "boolean", short: "h" }, data: { type: "string" }, home: { type: "string" }, cdpath: { type: "string" },
    product: { type: "string", default: "baseq3" }, renderer: { type: "string", default: "cpu" },
    width: { type: "string", default: "640" }, height: { type: "string", default: "480" },
    "sound-rate": { type: "string", default: "48000" }, hidden: { type: "boolean", default: false }, frames: { type: "string" },
    "missing-files": { type: "string" },
  } });
  if (values.help === true) { process.stdout.write(clientHelp); return; }
  if (values.home === undefined || values.home.length === 0) throw new Error("--home is required and must be nonempty");
  if (values.product !== "baseq3" && values.product !== "missionpack") throw new Error("Product must be baseq3 or missionpack");
  if (values.renderer !== "cpu" && values.renderer !== "gl") throw new Error("Renderer must be cpu or gl");
  const limit: CommonRunLimit = values.frames === undefined ? { kind: "continuous" }
    : { kind: "frames", count: integerOption(values.frames, "frames", 1, 2147483647) };
  const dataPath = values.data ?? process.env["Q3_DATA"] ?? await discoverDataPath() ?? process.cwd();
  const host = await ClientHost.open({
    roots: { dataPath, homePath: values.home, cdPath: values.cdpath ?? null, product: values.product,
      ...(values["missing-files"] === undefined ? {} : { missingFileLogPath: values["missing-files"] }) },
    startupText: separator < 0 ? "" : NativeRoot.fromHost(args.slice(separator + 1).join(" ")).sourceText, buildDate: "development",
    print: text => { process.stdout.write(text); },
    video: { renderer: values.renderer, width: integerOption(values.width, "width", 16, 4096),
      height: integerOption(values.height, "height", 16, 4096), hidden: values.hidden },
    sound: { sampleRate: integerOption(values["sound-rate"], "sound-rate", 8000, 192000) },
    bots: { kind: "source" },
  });
  try { await host.run(limit); }
  finally { await host.close(); }
}

try { await main(); }
catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
