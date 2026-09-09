import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { WritableFileSystem } from "../src/assets/writable-files.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import { ConsoleOutput } from "../src/core/console-output.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import type { Vec4 } from "../src/core/math.ts";
import { ClientKeys } from "../src/engine/client-keys.ts";
import { ClientStaticState } from "../src/engine/client-state.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { EngineConsole } from "../src/engine/console.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { createEngineScreenDrawing } from "../src/engine/screen-draw.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import type { PictureAsset, Rect2D, TextureRect } from "../src/render/draw2d.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RendererResources } from "../src/render/world.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

export function floatBits(value: number): number { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true); }
class RecordedCommands extends RenderCommandBuffer {
  readonly trace: string[] = [];
  readonly pictures = new Map<PictureAsset, number>();
  override setColor(color: Vec4 | null): void {
    super.setColor(color);
    this.trace.push(color === null ? "C null" : `C ${[color.x, color.y, color.z, color.w].map(floatBits).join(" ")}`);
  }
  override stretchPixels(rect: Rect2D, uv: TextureRect, picture: PictureAsset): void {
    super.stretchPixels(rect, uv, picture);
    let id = this.pictures.get(picture); if (id === undefined) { id = this.pictures.size + 1; this.pictures.set(picture, id); }
    this.trace.push(`P ${[rect.x, rect.y, rect.width, rect.height, uv.s, uv.t, uv.s2, uv.t2].map(floatBits).join(" ")} ${id}`);
  }
}
export function whiteAssets(): RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> {
  const image = new Uint8Array(22); image[2] = 2; image[12] = 1; image[14] = 1; image[16] = 32; image[17] = 0x20; image.fill(255, 18);
  return withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ list: () => [], has: path => path.endsWith(".tga"), read: async () => image,
    readFileLength: path => path.endsWith(".tga") ? image.byteLength : -1,
    readFileOptional: async path => path.endsWith(".tga") ? image : undefined });
}
export async function screenFixture(width = 640, height = 480, assets = whiteAssets(), graphics = false, initialConsoleText: string | null = null) {
  const state = new ClientStaticState(), cvars = new CvarRegistry(), commands = new CommandBuffer();
  const prints: string[] = [], calls: string[] = [];
  let destination: ((text: string) => undefined) | null = null;
  const output = new ConsoleOutput(text => { prints.push(text); if (destination !== null) destination(text); });
  const home = mkdtempSync(join(tmpdir(), "quake3-console-test-"));
  const files = new WritableFileSystem({ homePath: home, product: "baseq3", print: text => { output.print(text); } });
  let targetPlayer = -1, moveType = 0, fsReads = 0, operationError: Error | null = null;
  const guard = (): undefined => { if (operationError !== null) throw operationError; commands.assertCurrentExecution(); };
  const keys: ClientKeys = new ClientKeys({ commands, cvars, print: text => { output.print(text); }, host: {
    readConnection: () => ({ kind: state.phase, demoPlayback: false }), readUi: () => null, readCgame: () => null,
    assertCurrentOperation: guard, disconnect: async () => { throw new Error("Unexpected fixture disconnect"); },
    stopAllSounds: () => { throw new Error("Unexpected fixture audio stop"); }, addReliableCommand: text => { calls.push(text); },
    toggleConsole: async () => { await console.toggle(); }, updateScreen: async () => { calls.push("screen"); },
    consoleScroll: action => console.scroll(action), readConsoleWidth: () => console.fieldWidth, clipboard: { kind: "native-unix-unavailable" },
  } });
  const console: EngineConsole = new EngineConsole({ state, keys, cvars, commands, output, host: {
    assertCurrentOperation: guard, startDemoLoop: async () => { calls.push("DEMO"); },
    readCgame: () => ({ crosshairPlayer: () => targetPlayer, lastAttacker: () => targetPlayer }),
    snapshotMoveType: () => moveType, writableFiles: () => { fsReads++; return files; }, version: "Q3 1.32b",
  } });
  destination = text => console.print(text);
  if (initialConsoleText !== null) output.print(initialConsoleText);
  cvars.register("cl_noprint", "0"); cvars.register("cl_conXOffset", "0"); cvars.register("cl_running", "1");
  keys.initializeCommands(); console.initialize(); state.phase = "active"; state.realtime = 100;
  const images = new RendererImageCatalog();
  const window = graphics ? SdlWindow.open({ title: "Engine console verification", width, height, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images);
  const settings = createRendererSettings();
  gl?.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const cpu = new SoftwareRenderer(width, height, images, gl?.subpixelBits), target = new RenderTarget(images, gl === null ? [cpu] : [cpu, gl]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => state.realtime };
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  const resources = await RendererResources.create(assets, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: text => { output.print(text); }, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  const queue = new RecordedCommands(target, { print: text => { output.print(text); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  const charset = resources.picture(await resources.registerShader("gfx/2d/bigchars"));
  const white = resources.picture(await resources.registerShader("white"));
  const background = resources.picture(await resources.registerShader("console"));
  queue.pictures.set(charset, 1); queue.pictures.set(white, 2); queue.pictures.set(background, 3);
  const drawing = createEngineScreenDrawing({ commands: queue, resources, pictures: { charset, white, console: background }, state, keys });
  return { state, cvars, commands, output, keys, console, drawing, queue, cpu, gl, home, calls, prints, resources,
    targetPlayer: (value: number) => { targetPlayer = value; }, moveType: (value: number) => { moveType = value; },
    fsReads: () => fsReads, guardError: (value: Error | null) => { operationError = value; },
    submit: () => { const result = queue.submit(); resources.tess.endFrame(); return result; },
    close: () => { try { queue.close("require-empty"); } finally { try { target.close(); } finally { try { cinematics.dispose(); files.closeAll(); } finally { window?.close(); } } } },
  };
}
