import { HunkArena } from "../src/core/hunk.ts";
import { KEY_CHAR_FLAG, KeyCode } from "../src/core/key-codes.ts";
import { CommonParseCursor, CommonParseState } from "../src/core/common-parse.ts";
import { gameAtof } from "../src/game/numeric.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AudioMixer } from "../src/audio/mixer.ts";
import { BackgroundMusic } from "../src/audio/music.ts";
import { musicFiles } from "./music-file-fixture.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { EngineUiCinematics, type EngineUiCinematicInstance } from "../src/engine/ui-cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { BatchRecordingBackend, publishTexture } from "./render-target-fixture.ts";
import { existsSync } from "node:fs";
import { posix } from "node:path";

import type { PcmSound } from "../src/assets/wav.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { TeamArenaUiMemory } from "../src/ui/team-arena/memory.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { Draw2D, UI_PICTURE_STATE, type PictureAsset } from "../src/render/draw2d.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import type { FontSet, RegisteredFont } from "../src/render/font.ts";
import { DEFAULT_MODEL } from "../src/render/ref-entity.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { RendererResources } from "../src/render/world.ts";
import type { IncludeRequest, ScriptSource } from "../src/script/preprocessor.ts";
import {
  UiWindowFlag,
  UiMenuSourceParser,
  defaultUiMenuPlan,
  loadMenuDefinitions,
  type UiMenuDefinitions,
  type UiMenuMemoryOwnership,
  type UiMenuRegistrationEvent,
  type UiMenuRegistrationSink,
  type UiMenuResolver,
  type UiScript,
  type UiRect,
} from "../src/ui/menu.ts";
import {
  UiRuntime,
  type UiCinematicAsset,
  type UiCinematicInstance,
  type UiExternalScriptContext,
  type UiRuntimeAudio,
  type UiRuntimeFeederItem,
  type UiRuntimeResources,
  type UiScriptCursor,
  type UiModelPaintRequest,
  type UiOwnerDrawPaintRequest,
  type UiOwnerDrawKeyResult,
  type UiRuntimeItemSnapshot,
  type UiWidgetAssets,
} from "../src/ui/runtime.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";

class MemoryResolver implements UiMenuResolver {
  private readonly sources = new Map<string, string>();

  constructor(menu: string) {
    this.sources.set("ui/set.txt", `{ loadMenu { "ui/runtime.menu" } }`);
    this.sources.set("ui/runtime.menu", menu);
  }

  resolveRoot(path: string): ScriptSource | undefined { return this.source(path); }

  resolve(request: IncludeRequest): ScriptSource | undefined {
    return this.source(posix.join(posix.dirname(request.fromPath), request.requestedPath))
      ?? this.source(request.requestedPath);
  }

  private source(path: string): ScriptSource | undefined {
    const text = this.sources.get(path);
    return text === undefined ? undefined : { path, text };
  }
}

class RetailResolver implements UiMenuResolver {
  constructor(private readonly vfs: VirtualFileSystem) {}
  resolveRoot(path: string): ScriptSource | undefined { return this.source(path); }
  resolve(request: IncludeRequest): ScriptSource | undefined {
    return this.source(posix.join(posix.dirname(request.fromPath), request.requestedPath)) ?? this.source(request.requestedPath);
  }
  private source(path: string): ScriptSource | undefined {
    if (!this.vfs.has(path)) return undefined;
    return { path, text: new TextDecoder().decode(this.vfs.readSync(path)) };
  }
}

class ResourceTrace implements UiRuntimeResources {
  constructor(readonly handles: UiRuntimeResources["handles"] = { kind: "diagnostic" }) {}
  readonly registrations: string[] = [];
  readonly pictures: string[] = [];
  readonly sounds: string[] = [];
  readonly pictureValues = new Map<string | null, PictureAsset | undefined>();
  readonly soundValues = new Map<string | null, PcmSound | undefined>();
  readonly modelValues = new Map<string | null, typeof DEFAULT_MODEL>();
  readonly missingSounds = new Set<string>();

  async registerFont(path: string | null, pointSize: number): Promise<void> { this.registrations.push(`font:${path}:${pointSize}`); }

  async registerPicture(path: string | null): Promise<PictureAsset> {
    if (path === null) throw new Error("RE_RegisterShaderNoMip dereferences NULL name at strlen");
    this.registrations.push(`picture:${path}`);
    this.pictures.push(path);
    const value: PictureAsset = { ...picture, name: path };
    this.pictureValues.set(path, value);
    return value;
  }

  registeredPicture(path: string | null): PictureAsset | undefined { return this.pictureValues.get(path); }

  async registerSound(path: string | null): Promise<PcmSound | undefined> {
    if (path === null) throw new Error("S_RegisterSound dereferences NULL name at strlen");
    this.registrations.push(`sound:${path}`);
    this.sounds.push(path);
    if (this.missingSounds.has(path)) {
      this.soundValues.set(path, undefined);
      return undefined;
    }
    const value = { sampleRate: 22050, channels: 1, samples: new Int16Array(0), frameCount: 0, loopStart: null } satisfies PcmSound;
    this.soundValues.set(path, value);
    return value;
  }

  registeredSound(path: string | null): PcmSound | undefined { return this.soundValues.get(path); }
  async registerModel(path: string | null): Promise<typeof DEFAULT_MODEL> {
    this.registrations.push(`model:${path}`);
    this.modelValues.set(path, DEFAULT_MODEL);
    return DEFAULT_MODEL;
  }
  registeredModel(path: string | null): typeof DEFAULT_MODEL | undefined { return this.modelValues.get(path); }
  prepareCinematic(path: string): Promise<UiCinematicAsset> { return graphics.cinematics.prepare(path); }
}

class ResourceRegistrationSink implements UiMenuRegistrationSink {
  constructor(private readonly resources: ResourceTrace) {}

  async register(event: UiMenuRegistrationEvent): Promise<void> {
    switch (event.kind) {
      case "font": await this.resources.registerFont(event.reference.path, event.reference.pointSize); return;
      case "picture": await this.resources.registerPicture(event.reference.path); return;
      case "sound": await this.resources.registerSound(event.reference.path); return;
      case "model": await this.resources.registerModel(event.reference.path); return;
    }
  }
}

class AudioTrace implements UiRuntimeAudio {
  readonly local: (PcmSound | number | undefined)[] = [];
  readonly started: (string | null)[] = [];
  readonly events: string[] = [];
  stops = 0;

  playLocal(sound: PcmSound | number | undefined): void { this.local.push(sound); }

  async startBackground(path: string | null): Promise<void> {
    this.started.push(path);
    this.events.push(`start:${path}`);
  }

  stopBackground(): void { this.stops++; this.events.push("stop"); }
}

class ExternalTrace {
  readonly calls: string[] = [];

  run(cursor: UiScriptCursor, context: UiExternalScriptContext): void {
    const command = cursor.next();
    if (command === undefined) throw new Error("missing external command");
    const args: string[] = [];
    while (cursor.peek()?.text !== ";") {
      const token = cursor.next();
      if (token === undefined) break;
      args.push(token.text);
    }
    const owner = `${context.menuName ?? ""}/${context.itemName ?? ""}`;
    this.calls.push(`${owner}:${command.text}${args.length === 0 ? "" : ` ${args.join(" ")}`}`);
  }
}

class BindingsTrace {
  readonly values = new Map<number, string>();
  readonly writes: string[] = [];
  overstrike = false;
  keyName(key: number): string { return `key${key}`; }
  getBinding(key: number): string { return this.values.get(key) ?? ""; }
  setBinding(key: number, command: string): void { this.values.set(key, command); this.writes.push(`${key}:${command}`); }
  getOverstrike(): boolean { return this.overstrike; }
  setOverstrike(enabled: boolean): void { this.overstrike = enabled; }
}

class FeederTrace {
  readonly selections: string[] = [];
  readonly itemCalls: string[] = [];
  readonly imageCalls: string[] = [];
  itemValue: UiRuntimeFeederItem | undefined;
  imageValue: PictureAsset | undefined;
  count(): number { return 8; }
  item(feeder: number, index: number, column: number): UiRuntimeFeederItem | undefined | Promise<UiRuntimeFeederItem | undefined> {
    this.itemCalls.push(`${feeder}:${index}:${column}`);
    return this.itemValue;
  }
  image(feeder: number, index: number): PictureAsset | undefined | Promise<PictureAsset | undefined> {
    this.imageCalls.push(`${feeder}:${index}`);
    return this.imageValue;
  }
  select(feeder: number, index: number): void | Promise<void> { this.selections.push(`${feeder}:${index}`); }
}

class OwnerDrawTrace {
  readonly paints: UiOwnerDrawPaintRequest[] = [];
  readonly closed: number[] = [];
  readonly keys: number[] = [];
  visible(): boolean { return true; }
  width(): number { return 0; }
  value(): number { return 0; }
  handleKey(_ownerDraw: number, _flags: number, special: number, key: number): UiOwnerDrawKeyResult | Promise<UiOwnerDrawKeyResult> {
    this.keys.push(key); return { handled: false, special };
  }
  paint(request: UiOwnerDrawPaintRequest): void { this.paints.push(request); }
  closeCinematic(ownerDrawValue: number): void { this.closed.push(ownerDrawValue); }
}

function createGraphics() {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(640, 480, images), recording = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, [recording]), builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0);
  const clock = { time: 0, milliseconds(): number { return this.time; } };
  const data = new BinaryWriter(34); data.u16(0x1084); data.u32(0xffffffff); data.u16(30);
  data.u16(0x1001); data.u32(8); data.u16(0); data.bytes(new Uint8Array([8, 0, 8, 0, 8, 0, 4, 0]));
  data.u16(0x1013); data.u32(0); data.u16(0);
  const bytes = data.finish();
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: { has: () => true, list: () => [], read: async () => bytes } }, sound: { kind: "diagnostic", readMixer: () => mixer },
    clock: { sample: () => clock.milliseconds() }, scratchImages: builtins, console: { kind: "absent" },
    settings: { hardware: "generic", maxTextureSize: 4096, inGameVideo: () => 1 } });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: new SourceTessState(), runtime: createRendererSettings().runtime });
  const image = publishTexture(images, { name: "fixture/white", width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]),
    internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 });
  const picture: PictureAsset = { kind: "image", name: "fixture", texture: { kind: "bind-image", image }, state: UI_PICTURE_STATE, color: { rgb: "vertex", alpha: "vertex" } };
  return { images, cpu, recording, cinematics, commands, picture, clock, target, builtins, consumed: 0,
    close: () => { commands.close("discard"); cinematics.dispose(); target.close(); } };
}
let graphics = createGraphics();
let picture: PictureAsset = graphics.picture;
let whitePicture: PictureAsset = { ...picture, name: "owned-white-fixture" };
function draw2D(): Draw2D { return graphics.commands.draw2D("stretch-640"); }
function consumedBatches(draw: Draw2D) {
  draw.commands.submit();
  const batches = graphics.recording.trace().flatMap(view => view.batches), fresh = batches.slice(graphics.consumed);
  graphics.consumed = batches.length;
  return fresh;
}
function fixtureFont(): RegisteredFont {
  const glyphs = Array.from({ length: 256 }, () => ({
    height: 8, top: 8, bottom: 0, pitch: 8, xSkip: 8, imageWidth: 8, imageHeight: 8,
    shaderName: "fixture", s: 0, t: 0, s2: 1, t2: 1, picture,
  }));
  return { name: "fixture", glyphScale: 1, glyphs };
}
let fonts: FontSet = { small: fixtureFont(), normal: fixtureFont(), big: fixtureFont(), profile: "ui", smallThreshold: .25, bigThreshold: .4 };
let widgetAssets: UiWidgetAssets = Object.freeze({
  whiteShader: whitePicture,
  gradientBar: picture, scrollBar: picture, scrollBarArrowDown: picture, scrollBarArrowUp: picture,
  scrollBarArrowLeft: picture, scrollBarArrowRight: picture, scrollBarThumb: picture,
  sliderBar: picture, sliderThumb: picture,
});
beforeEach(() => {
  graphics.close(); graphics = createGraphics(); picture = graphics.picture; whitePicture = { ...picture, name: "owned-white-fixture" };
  fonts = { ...fonts, small: fixtureFont(), normal: fixtureFont(), big: fixtureFont() };
  widgetAssets = Object.freeze({ whiteShader: whitePicture, gradientBar: picture, scrollBar: picture, scrollBarArrowDown: picture,
    scrollBarArrowUp: picture, scrollBarArrowLeft: picture, scrollBarArrowRight: picture, scrollBarThumb: picture, sliderBar: picture, sliderThumb: picture });
});
afterEach(() => { graphics.close(); });
class CinematicTrace extends EngineUiCinematics {
  readonly played: UiCinematicInstance[] = [];
  readonly runTimes: number[] = [];
  readonly stopped: number[] = [];
  constructor() { super(graphics.cinematics, "ui"); }
  override play(asset: UiCinematicAsset, rect: UiRect): EngineUiCinematicInstance | undefined {
    const instance = super.play(asset, rect); if (instance !== undefined) this.played.push(instance); return instance;
  }
  override run(handle: number, time: number): void { this.runTimes.push(time); super.run(handle, time); }
  override stop(handle: number): void { this.stopped.push(handle); super.stop(handle); }
}

async function parse(source: string, memory: UiMenuMemoryOwnership = { kind: "unaccounted" }): Promise<UiMenuDefinitions> {
  const resolver = new MemoryResolver(source);
  return loadMenuDefinitions({ resolver, random: { nextInt: (): number => 7 } }, { kind: "ui", setPaths: ["ui/set.txt"] }, {}, { memory });
}

async function runtimeFromDefinitions(
  definitions: UiMenuDefinitions,
  cvars = new CvarRegistry(),
  resources = new ResourceTrace(),
  whiteShader: PictureAsset = whitePicture,
  profile: FontSet["profile"] = "ui",
  pause: (paused: boolean) => void | Promise<void> = () => {},
  cvarValue: (name: string) => number = name => cvars.get(name)?.numericValue ?? 0,
) {
  const audio = new AudioTrace(), external = new ExternalTrace();
  const bindings = new BindingsTrace(), feeder = new FeederTrace();
  const owner = new OwnerDrawTrace(), cinema = new CinematicTrace(), modelPaints: UiModelPaintRequest[] = [];
  const commands = new CommandBuffer();
  const sourceParser = new CommonParseState(), printed: string[] = [];
  const value = await UiRuntime.create({
    definitions,
    sourceParser,
    print: text => { printed.push(text); },
    cvars,
    cvarValue,
    commands,
    resources,
    fonts: { ...fonts, profile },
    widgetAssets: { ...widgetAssets, whiteShader },
    zeroPicture: picture,
    audio,
    cinematics: cinema,
    paintModel: (request): void => { modelPaints.push(request); },
    context: { kind: "ui", bindings, pause },
    feeder,
    ownerDraw: owner,
    externalScript: external,
    getTeamColor: () => ({ x: .25, y: .5, z: .75, w: 1 }),
  });
  return { value, definitions, resources, audio, external, commands, cvars, bindings, feeder, owner, cinema, modelPaints, sourceParser, printed };
}

async function runtime(source: string, cvars = new CvarRegistry()) {
  return runtimeFromDefinitions(await parse(source), cvars);
}

function requiredScript(script: UiScript | undefined): UiScript {
  if (script === undefined) throw new Error("expected script");
  return script;
}

function requiredValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

function firstRuntimeItem(value: UiRuntime): UiRuntimeItemSnapshot {
  return requiredValue(value.snapshot().menus[0]?.items[0], "runtime item");
}

describe("Team Arena shared menu runtime", () => {
  test("executes the partial final token retained by PC_Script_Parse", async () => {
    const state = await runtime(`menuDef { name scripts onOpen { setcvar result ${"x".repeat(1023)} } }`);
    const script = requiredScript(state.definitions.menus[0]?.onOpen);
    expect(script.truncated).toBe(true);
    expect(script.tokens.map(token => token.text)).toEqual(["setcvar", "result"]);
    state.sourceParser.parse(new CommonParseCursor("seed\n"));
    const line = state.sourceParser.line;
    await state.value.activate("scripts");
    expect(state.cvars.get("result")?.value).toBe("x".repeat(1023 - '"setcvar" "result" "'.length));
    expect(state.sourceParser.line).toBe(line);
    expect(state.sourceParser.token).toBe("");
  });

  test("cvar enable scripts reparse empty PC tokens instead of treating them as EOF", async () => {
    const state = await runtime(`menuDef { name scripts itemDef {
      name target cvarTest gate enableCvar { "" 1 }
    } }`);
    state.cvars.set("gate", "1");
    expect(firstRuntimeItem(state.value).enabled).toBe(true);
    expect(state.sourceParser.token).toBe("1");
  });

  test("PC script buffers count Latin-1 bytes and leave a single high byte unquoted", async () => {
    const state = await runtime(`menuDef { name scripts onOpen { setcvar latin "${"é".repeat(600)}" ; setcvar single "é" } }`);
    const script = requiredScript(state.definitions.menus[0]?.onOpen);
    expect(script.truncated).toBe(false);
    await state.value.activate("scripts");
    expect(state.cvars.get("latin")?.value).toBe("é".repeat(600));
    expect(state.cvars.get("single")).toBeUndefined();
  });

  test("shared centered text truncates odd integer widths before positioning", async () => {
    const state = await runtime(`menuDef { name centered rect 0 0 640 480
      itemDef { name normal rect 10 20 100 20 visible 1 text X textscale .375 textalign 1 textalignx 50 }
      itemDef { name wrapped rect 10 50 100 20 visible 1 text "XX " textscale .375 textalign 1 textalignx 50 autowrapped }
    }`);
    const menu = requiredValue(state.definitions.menus[0], "centered menu");
    requiredValue(menu.items[0], "normal text").textRect.width = .5;
    await state.value.activate("centered");
    await state.value.frame({ time: 1, frameTime: 1, draw: draw2D() });
    expect(menu.items[0]?.textRect).toMatchObject({ x: 59, width: 3 });
    expect(menu.items[1]?.textRect.x).toBe(57);
  });

  test("slider keys retain reversed ranges and the source unhandled print", async () => {
    const state = await runtime(`menuDef { name sliders itemDef {
      name slider type 10 rect 10 10 120 20 visible 1 cvarFloat volume 0 10 0
    } }`);
    await state.value.activate("sliders");
    state.value.setDisplayCursor(58, 20);
    await state.value.pointerMove(58, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Enter, down: true }, 58, 20);
    expect(state.cvars.get("volume")?.value).toBe("5.000000");
    await state.value.handleKey({ kind: "key", code: KeyCode.KeypadEnter, down: true }, 58, 20);
    expect(state.printed).toContain("slider handle key exit\n");
  });

  test("multi widgets compare the source 1024-byte cvar buffer for painting and input", async () => {
    const prefix = "x".repeat(1023);
    const state = await runtime(`menuDef { name values rect 0 0 640 480 itemDef {
      name choice type 12 rect 10 10 120 20 visible 1 cvar selected textscale .5 forecolor 1 1 1 1
      cvarStrList { First first Kept ${prefix} Last last }
    } }`);
    state.cvars.set("selected", prefix + "discarded");
    requiredValue(state.definitions.menus[0]?.items[0], "multi item").textRect = { x: 20, y: 30, width: 0, height: 8 };
    await state.value.activate("values");
    const draw = draw2D();
    await state.value.frame({ time: 1, frameTime: 1, draw });
    expect(consumedBatches(draw).flatMap(batch => batch.vertices)).toHaveLength(4 * 4);
    state.value.setDisplayCursor(20, 20);
    await state.value.pointerMove(20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Enter, down: true }, 20, 20);
    expect(state.cvars.get("selected")?.value).toBe("last");
  });

  test("menu scripts use bg_lib decimal prefixes and wrapped integer accumulation", async () => {
    const state = await runtime(`menuDef { name numbers itemDef { name target rect 0 0 1 1
      action { setcolor forecolor "1e2" 0 0 1 ; orbit target "2e3" 4 5 6 9007199254740993 }
    } }`);
    const item = requiredValue(state.definitions.menus[0]?.items[0], "numeric script item");
    await state.value.runItemScript("numbers", "target", requiredScript(item.action));
    expect(item.window.foreColor.x).toBe(1);
    expect(item.window.clientRect.x).toBe(2);
    expect(item.window.offsetTime).toBe(1);
  });

  test("numeric multi and slider writes use the source six-digit float formatter", async () => {
    const state = await runtime(`menuDef { name values rect 0 0 640 480
      itemDef { name choice type 12 rect 10 10 120 20 visible 1 cvar choice cvarFloatList { First 0 Next 1.23456788 } }
      itemDef { name slider type 10 rect 10 50 120 20 visible 1 cvarFloat volume 0 0 2.46913576 }
    }`);
    await state.value.activate("values");
    state.value.setDisplayCursor(20, 20);
    await state.value.pointerMove(20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Enter, down: true }, 20, 20);
    expect(state.cvars.get("choice")?.value).toBe("1.234567");
    state.value.setDisplayCursor(58, 60);
    await state.value.pointerMove(58, 60);
    await state.value.handleKey({ kind: "key", code: KeyCode.Enter, down: true }, 58, 60);
    expect(state.cvars.get("volume")?.value).toBe("1.234567");
  });

  test("focused text pulses at the source integer clock quotient", async () => {
    const state = await runtime(`menuDef { name pulse rect 0 0 640 480 focuscolor 1 1 1 1 onOpen { setfocus target }
      itemDef { name target type 1 rect 10 20 100 30 visible 1 text X textscale .5 textaligny 10 }
    }`);
    await state.value.activate("pulse");
    const colors: number[] = [];
    for (const time of [0, 74, 75]) {
      const draw = draw2D();
      await state.value.frame({ time, frameTime: 0, draw });
      colors.push(requiredValue(consumedBatches(draw)[0]?.vertices[0], "focused glyph").color.x);
    }
    expect(colors).toEqual([229 / 255, 229 / 255, 208 / 255]);
  });

  test("keypad Enter runs the menu action without toggling a yes-no value", async () => {
    const state = await runtime(`menuDef { name keys rect 0 0 640 480 itemDef {
      name choice type 11 rect 10 10 100 20 visible 1 cvar selected action { uiScript selected }
    } }`);
    state.cvars.set("selected", "0");
    await state.value.activate("keys");
    state.value.setDisplayCursor(20, 20);
    await state.value.pointerMove(20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.KeypadEnter, down: true }, 20, 20);
    expect(state.cvars.get("selected")?.value).toBe("0");
    expect(state.external.calls).toEqual(["keys/choice:selected"]);
  });

  test("retains callable hit-test, mouse-over and image helpers outside normal item dispatch", async () => {
    const state = await runtime(`menuDef { name helpers rect 0 0 640 480 itemDef {
      name image rect 10 20 30 40 asset_shader fixture visible 0 decoration
    } }`);
    const menu = requiredValue(state.value.menuHandle("helpers"), "helper menu");
    const item = requiredValue(state.definitions.menus[0]?.items[0], "helper image");
    expect(state.value.hitTestMenu(menu, 20, 30)).toBe(item);
    expect(state.value.hitTestMenu(menu, 10, 30)).toBeUndefined();
    state.value.setItemMouseOver(item, true);
    expect(item.window.flags & UiWindowFlag.MouseOver).toBe(UiWindowFlag.MouseOver);
    state.value.setItemMouseOver(item, false);
    expect(item.window.flags & UiWindowFlag.MouseOver).toBe(0);
    const draw = draw2D();
    state.value.paintItemImage(null, draw);
    state.value.paintItemImage(item, draw);
    const vertices = consumedBatches(draw).flatMap(batch => batch.vertices);
    expect(vertices.map(vertex => [Math.round((vertex.position.x + 1) * 320), Math.round((1 - vertex.position.y) * 240)]))
      .toEqual([[11, 21], [39, 21], [39, 59], [11, 59]]);
  });

  test("slider, yes-no, multi and bind paints preserve text rectangles when their label is NULL", async () => {
    const state = await runtime(`menuDef { name values rect 0 0 640 480
      itemDef { name yes type 11 rect 10 10 120 20 visible 1 cvar enabled }
      itemDef { name multi type 12 rect 10 50 120 20 visible 1 cvar choice cvarStrList { Chosen chosen } }
      itemDef { name bind type 13 rect 10 90 120 20 visible 1 cvar "+attack" }
      itemDef { name slider type 10 rect 10 130 120 20 visible 1 cvarFloat volume 5 0 10 }
    }`);
    state.cvars.set("enabled", "1"); state.cvars.set("choice", "chosen");
    state.cvars.set("+attack", "1"); state.cvars.set("volume", "5");
    const menu = requiredValue(state.definitions.menus[0], "value widgets");
    for (let index = 0; index < menu.itemCount; index++) {
      const item = requiredValue(menu.itemAt(index), "value widget");
      item.textRect = { x: 30, y: 40 + index * 40, width: 0, height: 17 };
    }
    await state.value.activate("values");
    const draw = draw2D();
    await state.value.frame({ time: 1, frameTime: 1, draw });
    expect(menu.items.map(item => ({ ...item.textRect }))).toEqual([
      { x: 30, y: 40, width: 0, height: 17 }, { x: 30, y: 80, width: 0, height: 17 },
      { x: 30, y: 120, width: 0, height: 17 }, { x: 30, y: 160, width: 0, height: 17 },
    ]);
    expect(consumedBatches(draw).flatMap(batch => batch.vertices)).toHaveLength((3 + 6 + 5 + 2) * 4);
    state.value.dispose();
  });

  test("slider, yes-no, multi and bind paints still lay out an explicitly empty label", async () => {
    const state = await runtime(`menuDef { name values rect 0 0 640 480
      itemDef { name yes type 11 rect 10 10 120 20 visible 1 text "" cvar enabled }
      itemDef { name multi type 12 rect 10 50 120 20 visible 1 text "" cvar choice cvarStrList { Chosen chosen } }
      itemDef { name bind type 13 rect 10 90 120 20 visible 1 text "" cvar "+attack" }
      itemDef { name slider type 10 rect 10 130 120 20 visible 1 text "" cvarFloat volume 5 0 10 }
    }`);
    state.cvars.set("enabled", "1"); state.cvars.set("choice", "chosen"); state.cvars.set("volume", "5");
    const menu = requiredValue(state.definitions.menus[0], "empty-label widgets");
    for (const item of menu.items) item.textRect = { x: 30, y: 40, width: 0, height: 17 };
    await state.value.activate("values");
    const draw = draw2D();
    await state.value.frame({ time: 1, frameTime: 1, draw });
    expect(menu.items.map(item => ({ ...item.textRect }))).toEqual([
      { x: 10, y: 10, width: 0, height: 0 }, { x: 10, y: 50, width: 0, height: 0 },
      { x: 10, y: 90, width: 0, height: 0 }, { x: 10, y: 130, width: 0, height: 0 },
    ]);
    expect(consumedBatches(draw).flatMap(batch => batch.vertices)).toHaveLength((3 + 6 + 3 + 2) * 4);
    state.value.dispose();
  });

  test("slider thumbs preserve binary32 steps, reversed bounds and the NULL edit-data return", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    const definitions = await parse(`menuDef { name sliders rect 0 0 640 480
      itemDef { name precise type 10 rect .1 10 120 20 visible 1 cvarFloat precise .7 -.2 1.1 }
      itemDef { name reversed type 10 rect 10 50 120 20 visible 1 cvarFloat reversed 5 10 0 }
      itemDef { name missing type 10 rect 20 90 120 20 visible 1 cvarFloat missing 5 0 10 }
    }`, { kind: "qvm32", memory: pool });
    const missing = requiredValue(definitions.menus[0]?.itemAt(2), "NULL edit-data slider");
    pool.borrow(requiredValue(missing.allocationOffset, "slider offset"), 540).setAllocationPointer(536, undefined);
    const cvars = new CvarRegistry();
    cvars.set("precise", ".7"); cvars.set("reversed", "5"); cvars.set("missing", "5");
    const state = await runtimeFromDefinitions(definitions, cvars);
    await state.value.activate("sliders");
    const draw = draw2D();
    await state.value.frame({ time: 1, frameTime: 1, draw });
    const vertices = consumedBatches(draw).flatMap(batch => batch.vertices);
    expect(vertices).toHaveLength(24);
    expect(vertices[4]?.position.x).toBe(-0.8107452392578125);
    expect(vertices[12]?.position.x).toBe(Math.fround(4 * 2 / 640 - 1));
    expect(vertices[20]?.position.x).toBe(Math.fround(14 * 2 / 640 - 1));
    state.value.dispose();
  });

  test("a slider with a NULL cvar draws its bar before reaching the source hash dereference", async () => {
    const state = await runtime(`menuDef { name sliders itemDef {
      name missing type 10 rect 10 10 120 20 visible 1
    } }`);
    await state.value.activate("sliders");
    const draw = draw2D();
    await expect(state.value.frame({ time: 1, frameTime: 1, draw })).rejects.toThrow("Item_Slider_ThumbPosition hashes NULL cvar in Cvar_FindVar");
    expect(consumedBatches(draw).flatMap(batch => batch.vertices)).toHaveLength(4);
    state.value.dispose();
  });

  test("slider bar lookup completes before the thumb reads live type data and preserves queued color", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    const definitions = await parse(`menuDef { name sliders rect 0 0 640 480
      itemDef { name slider type 10 rect 10 40 120 20 visible 1 forecolor 1 0 0 1 cvarFloat volume 5 0 10 }
      itemDef { name replacement type 10 cvarFloat other 0 0 20 }
    }`, { kind: "qvm32", memory: pool });
    const slider = requiredValue(definitions.menus[0]?.itemAt(0), "slider");
    const replacement = requiredValue(definitions.menus[0]?.itemAt(1), "replacement slider");
    const sliderRecord = pool.borrow(requiredValue(slider.allocationOffset, "slider offset"), 540);
    const nextRecord = pool.borrow(requiredValue(replacement.allocationOffset, "replacement offset"), 540);
    const shaderPath = "scripts/slider.shader";
    const shaderBytes = new TextEncoder().encode("fixture/slider { { map $whiteimage rgbGen vertex } }");
    const prints: string[] = [];
    const reader = withRetainedFiles({
      read: async (path: string): Promise<Uint8Array> => { throw new Error(`Unexpected renderer read ${path}`); },
      has: (path: string): boolean => path === shaderPath,
      list: (prefix = ""): readonly string[] => shaderPath.startsWith(prefix) ? [shaderPath] : [],
      readFileLength: (path: string): number => path === shaderPath ? shaderBytes.byteLength : -1,
      readFileOptional: async (path: string): Promise<Uint8Array | undefined> => path === shaderPath ? shaderBytes : undefined,
      readFileOptionalSync: (path: string): Uint8Array | undefined => path === shaderPath ? shaderBytes : undefined,
    });
    const renderer = await RendererResources.create(reader, { kind: "unaccounted" }, createRendererSettings(), {
      patchMemory: { kind: "diagnostic" }, target: graphics.target, images: graphics.images, builtins: graphics.builtins,
      shaderCinematics: graphics.cinematics.shaderCinematics, imageProfile: identityImageUploadProfile,
      print: text => { prints.push(text); },
      drawDebugSurface: () => { throw new Error("Unexpected debug surface draw"); },
    });
    const shader = await renderer.registerShaderNoMip("fixture/slider");
    expect(prints).toContain("...loading 'scripts/slider.shader'\n");
    const bar = renderer.picture(shader), handle = renderer.shaderHandle(shader), lookups: number[] = [];
    const draw = draw2D();
    const resources = new ResourceTrace({ kind: "source",
      pictureHandle: value => {
        if (value === undefined) return 0;
        if (value.kind !== "material") throw new Error("Expected actual material handle");
        return value.material.order;
      },
      pictureForHandle: index => {
        const result = renderer.picture(renderer.shaderForHandle(index));
        lookups.push(index);
        if (lookups.length === 1) {
          sliderRecord.setAllocationPointer(536, nextRecord.getAllocationPointer(536));
          slider.window.rect.x = 200; slider.window.rect.y = 90;
          draw.setColor({ x: 0, y: 1, z: 0, w: 1 });
          draw.drawHandlePic({ x: 150, y: 20, width: 8, height: 8 }, result);
        }
        return result;
      },
      modelForHandle: index => renderer.modelForHandle(index),
    });
    widgetAssets = Object.freeze({ ...widgetAssets, sliderBar: bar, sliderThumb: bar });
    const cvars = new CvarRegistry(); cvars.set("volume", "5");
    const state = await runtimeFromDefinitions(definitions, cvars, resources);
    await state.value.activate("sliders");
    await state.value.frame({ time: 1, frameTime: 1, draw });
    draw.drawHandlePic({ x: 300, y: 20, width: 8, height: 8 }, bar);
    expect(lookups).toEqual([handle, handle]);
    draw.commands.submitFrame();
    const vertices = graphics.recording.trace().flatMap(view => view.batches).flatMap(batch => batch.vertices);
    expect(vertices).toHaveLength(16);
    expect([vertices[0]?.position.x, vertices[0]?.position.y]).toEqual([Math.fround(10 * 2 / 640 - 1), Math.fround(1 - 40 * 2 / 480)]);
    expect([vertices[8]?.position.x, vertices[8]?.position.y]).toEqual([Math.fround(218 * 2 / 640 - 1), Math.fround(1 - 38 * 2 / 480)]);
    expect(vertices[0]?.color).toEqual({ x: 1, y: 0, z: 0, w: 1 });
    expect(vertices[8]?.color).toEqual({ x: 0, y: 1, z: 0, w: 1 });
    expect(vertices[12]?.color).toEqual({ x: 0, y: 1, z: 0, w: 1 });
    state.value.dispose();
  });

  test("runtime window, item and menu mutations use their retained records after publication", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    const definitions = await parse(`menuDef { name stored rect 0 0 640 480 itemDef {
      name control type 8 ownerdraw 9 rect 10 10 100 30 visible 1 special 7
      action { setcolor forecolor .25 .5 }
    } }`, { kind: "qvm32", memory: pool });
    const menu = requiredValue(definitions.menus[0], "stored menu");
    const definition = requiredValue(menu.items[0], "stored item");
    const record = pool.borrow(requiredValue(definition.allocationOffset, "stored item offset"), 540);
    const state = await runtimeFromDefinitions(definitions);
    record.setFloat32(0, 100);
    record.setFloat32(528, 9.25);
    record.setInt32(532, 6);
    expect(firstRuntimeItem(state.value).rect.x).toBe(100);
    expect(firstRuntimeItem(state.value).special).toBe(9.25);
    expect(firstRuntimeItem(state.value).cursorPosition).toBe(6);
    state.owner.handleKey = (_owner, _flags, special) => ({ handled: true, special: special + 1 });
    await state.value.activate("stored");
    state.value.setDisplayCursor(110, 20); await state.value.pointerMove(110, 20);
    expect(menu.cursorItem).toBe(0);
    expect(record.getInt32(68) & UiWindowFlag.HasFocus).toBe(UiWindowFlag.HasFocus);
    await state.value.handleKey({ kind: "key", code: KeyCode.Enter, down: true }, 110, 20);
    expect(record.getFloat32(528)).toBe(10.25);
    expect([record.getFloat32(112), record.getFloat32(116), record.getFloat32(120), record.getFloat32(124)])
      .toEqual([.25, .5, 1, 1]);
    expect(record.getInt32(68) & UiWindowFlag.ForeColorSet).toBe(UiWindowFlag.ForeColorSet);
    await state.value.setFeederSelection(10.25, 3, "stored");
    expect(record.getInt32(532)).toBe(3);
    expect(state.feeder.selections).toEqual(["10.25:3"]);
    state.value.dispose();
  });

  test("runtime publication preserves already populated source text rectangles", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    const definitions = await parse(`menuDef { name stored rect 0 0 640 480 itemDef {
      name label type 0 rect 10 10 100 30 visible 1 text label
    } }`, { kind: "qvm32", memory: pool });
    const definition = requiredValue(definitions.menus[0]?.items[0], "stored label");
    const record = pool.borrow(requiredValue(definition.allocationOffset, "stored label offset"), 540);
    record.setFloat32(180, 20); record.setFloat32(184, 20);
    record.setFloat32(188, 3); record.setFloat32(192, 4);
    const state = await runtimeFromDefinitions(definitions);
    await state.value.activate("stored");
    state.value.setDisplayCursor(21, 18); await state.value.pointerMove(21, 18);
    expect(firstRuntimeItem(state.value).flags & UiWindowFlag.HasFocus).toBe(UiWindowFlag.HasFocus);
    expect([record.getFloat32(180), record.getFloat32(184), record.getFloat32(188), record.getFloat32(192)])
      .toEqual([20, 20, 3, 4]);
    state.value.dispose();
  });

  test("fade uses and updates the retained signed32 timer and color words", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    const definitions = await parse(`menuDef { name fade rect 0 0 640 480 fadeCycle 10 fadeAmount .5 itemDef {
      name label type 1 rect 10 10 100 30 visible 1 text label action { fadeout label }
    } }`, { kind: "qvm32", memory: pool });
    const definition = requiredValue(definitions.menus[0]?.items[0], "fading item");
    const record = pool.borrow(requiredValue(definition.allocationOffset, "fading item offset"), 540);
    const state = await runtimeFromDefinitions(definitions);
    await state.value.activate("fade");
    await state.value.runItemScript("fade", "label", requiredScript(definition.action));
    record.setInt32(108, 0x7ffffffe);
    await state.value.frame({ time: 0x7ffffffe, frameTime: 1, draw: draw2D() });
    expect(record.getFloat32(124)).toBe(1);
    await state.value.frame({ time: 0x7fffffff, frameTime: 1, draw: draw2D() });
    expect(record.getInt32(108)).toBe(-2147483639);
    expect(record.getFloat32(124)).toBe(.5);
    await state.value.frame({ time: -2147483639, frameTime: 10, draw: draw2D() });
    expect(record.getFloat32(124)).toBe(.5);
    await state.value.frame({ time: -2147483638, frameTime: 1, draw: draw2D() });
    expect(record.getFloat32(124)).toBe(0);
    expect(record.getInt32(68) & (UiWindowFlag.FadingOut | UiWindowFlag.Visible)).toBe(0);
    state.value.dispose();
  });

  test("runtime controls borrow mutable edit, list and model records in both directions", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    const definitions = await parse(`menuDef { name controls rect 0 0 640 480
      itemDef { name edit type 9 rect 10 10 100 20 visible 1 cvar field maxPaintChars 3 }
      itemDef { name list type 6 rect 10 50 120 80 visible 1 feeder 7 elementWidth 32 elementHeight 16 }
      itemDef { name model type 7 rect 200 10 100 100 visible 1 asset_model model model_rotation 10 }
    }`, { kind: "qvm32", memory: pool });
    const edit = definitions.menus[0]?.items[0]?.behavior, list = definitions.menus[0]?.items[1]?.behavior;
    const model = definitions.menus[0]?.items[2]?.behavior;
    if (edit?.kind !== "numeric-field" || list?.kind !== "list-box" || model?.kind !== "model" || model.model === undefined) {
      throw new Error("missing source widget records");
    }
    const state = await runtimeFromDefinitions(definitions);
    state.cvars.set("field", "abcdef");
    edit.edit.paintOffset = 2;
    list.list.startPosition = 3; list.list.endPosition = 6; list.list.cursorPosition = 4; list.list.drawPadding = 1.75;
    model.model.angle = 359;
    expect(state.value.snapshot().menus[0]?.items[0]?.behavior).toEqual({ kind: "edit", paintOffset: 2 });
    expect(state.value.snapshot().menus[0]?.items[1]?.behavior).toEqual({
      kind: "list-box", startPosition: 3, endPosition: 6, cursorPosition: 4, drawPadding: 1,
    });
    await state.value.activate("controls");
    state.value.setDisplayCursor(20, 20); await state.value.pointerMove(20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Home, down: true }, 20, 20);
    expect(edit.edit.paintOffset).toBe(0);
    await state.value.handleKey({ kind: "key", code: KeyCode.End, down: true }, 20, 20);
    expect(edit.edit.paintOffset).toBe(3);
    await state.value.setFeederSelection(7, 0, "controls");
    expect([list.list.startPosition, list.list.cursorPosition]).toEqual([0, 0]);
    await state.value.frame({ time: 1, frameTime: 1, draw: draw2D() });
    expect(model.model.angle).toBe(0);
    expect(state.modelPaints[0]?.angle).toBe(0);
    model.model.angle = 0x7fffffff;
    await state.value.frame({ time: 12, frameTime: 11, draw: draw2D() });
    expect(model.model.angle).toBe(-128);
    expect(state.modelPaints[1]?.angle).toBe(-128);
    state.value.dispose();
  });

  test("captured list callbacks keep using retained type data after the item type changes", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    const definitions = await parse(`menuDef { name capture rect 0 0 640 480 itemDef {
      name list type 6 rect 10 10 120 80 visible 1 feeder 7 elementwidth 32 elementheight 16
    } }`, { kind: "qvm32", memory: pool });
    const item = requiredValue(definitions.menus[0]?.items[0], "captured list");
    const list = requiredValue(item.listData(), "captured list data");
    const record = pool.borrow(requiredValue(item.allocationOffset, "captured list offset"), 540);
    const state = await runtimeFromDefinitions(definitions);
    await state.value.activate("capture");
    await state.value.frame({ time: 0, frameTime: 0, draw: draw2D() });
    state.value.setDisplayCursor(120, 35); await state.value.pointerMove(120, 35);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 120, 35);
    record.setInt32(196, 1);
    state.value.setDisplayCursor(120, 60);
    await state.value.frame({ time: 1, frameTime: 1, draw: draw2D() });
    expect(item.type).toBe(1);
    expect(list.startPosition).toBe(3);
    await state.value.setFeederSelection(7, 0, "capture");
    expect([list.startPosition, list.cursorPosition]).toEqual([0, 0]);
    state.value.dispose();
  });

  test("list cursor arithmetic stores signed32 before the source clamp comparisons", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    const definitions = await parse(`menuDef { name list rect 0 0 640 480 itemDef {
      name rows type 6 rect 10 10 120 80 visible 1 feeder 7 elementwidth 32 elementheight 16
    } }`, { kind: "qvm32", memory: pool });
    const item = requiredValue(definitions.menus[0]?.itemAt(0), "list item");
    const list = requiredValue(item.listData(), "list data");
    const state = await runtimeFromDefinitions(definitions);
    await state.value.activate("list");
    list.cursorPosition = -2147483648;
    await state.value.scrollFeeder(7, false, "list");
    expect([list.cursorPosition, list.startPosition, item.cursorPosition]).toEqual([2147483647, 2147483643, 2147483647]);
    state.value.setDisplayCursor(20, 20); await state.value.pointerMove(20, 20);
    list.startPosition = 0; list.cursorPosition = 2147483647;
    await state.value.handleKey({ kind: "key", code: KeyCode.PageDown, down: true }, 20, 20);
    expect([list.cursorPosition, list.startPosition, item.cursorPosition]).toEqual([-2147483644, -2147483644, -2147483644]);
    state.value.dispose();
  });

  test("captured slider callbacks use retained edit data and the reached nullable cvar name", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    const definitions = await parse(`menuDef { name capture rect 0 0 640 480 itemDef {
      name slider type 10 rect 10 10 120 20 visible 1 cvarFloat level 0 0 10
    } }`, { kind: "qvm32", memory: pool });
    const item = requiredValue(definitions.menus[0]?.items[0], "captured slider");
    const record = pool.borrow(requiredValue(item.allocationOffset, "captured slider offset"), 540);
    const state = await runtimeFromDefinitions(definitions);
    await state.value.activate("capture");
    state.value.setDisplayCursor(11, 15); await state.value.pointerMove(11, 15);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 11, 15);
    record.setInt32(196, 1);
    state.value.setDisplayCursor(58, 15);
    await state.value.frame({ time: 1, frameTime: 1, draw: draw2D() });
    expect(state.cvars.get("level")?.value).toBe("5.000000");
    record.setInt32(264, 0);
    await state.value.frame({ time: 2, frameTime: 1, draw: draw2D() });
    expect(state.cvars.get("BADNAME")?.value).toBe("5.000000");
    state.value.dispose();
  });

  test("enable and show tests read their own bits from the retained combined cvar flags", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    const definitions = await parse(`menuDef { name rules itemDef {
      name combined cvarTest mode enableCvar { yes }
    } }`, { kind: "qvm32", memory: pool });
    const item = requiredValue(definitions.menus[0]?.items[0], "combined cvar rule");
    const record = pool.borrow(requiredValue(item.allocationOffset, "combined cvar rule offset"), 540);
    const state = await runtimeFromDefinitions(definitions);
    state.cvars.set("mode", "no");
    record.setInt32(276, 1 | 4);
    expect([firstRuntimeItem(state.value).enabled, firstRuntimeItem(state.value).shown]).toEqual([false, false]);
    record.setInt32(276, 2 | 4);
    expect([firstRuntimeItem(state.value).enabled, firstRuntimeItem(state.value).shown]).toEqual([true, false]);
    state.cvars.set("mode", "yes");
    expect([firstRuntimeItem(state.value).enabled, firstRuntimeItem(state.value).shown]).toEqual([false, true]);
    state.value.dispose();
  });

  test("focus, shared scripts and animation use the item's retained parent pointer", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    const definitions = await parse(`menuDef { name first rect 0 0 200 100 itemDef {
      name child type 1 rect 10 10 40 20 visible 1 action { hide peer }
    } } menuDef { name second rect 100 100 200 100 itemDef {
      name peer type 1 rect 10 10 40 20 visible 1
    } }`, { kind: "qvm32", memory: pool });
    const first = requiredValue(definitions.menus[0], "first parent");
    const second = requiredValue(definitions.menus[1], "second parent");
    const child = requiredValue(first.itemAt(0), "child");
    const peer = requiredValue(second.itemAt(0), "peer");
    const record = pool.borrow(requiredValue(child.allocationOffset, "child offset"), 540);
    const state = await runtimeFromDefinitions(definitions);
    await state.value.activate("first");
    record.setMenu(228, second);
    peer.window.flags |= UiWindowFlag.HasFocus;
    state.value.setDisplayCursor(20, 20); await state.value.pointerMove(20, 20);
    expect(peer.window.flags & UiWindowFlag.HasFocus).toBe(0);
    expect([first.cursorItem, second.cursorItem]).toEqual([-1, -1]);
    await state.value.runItemScript("first", "child", requiredScript(child.action));
    expect(peer.window.flags & UiWindowFlag.Visible).toBe(0);
    child.window.clientRect.x = 5;
    child.window.rectEffects = { ...child.window.clientRect, x: 15 };
    child.window.rectEffects2.x = 5;
    child.window.flags |= UiWindowFlag.InTransition;
    await state.value.frame({ time: 1, frameTime: 1, draw: draw2D() });
    expect(child.window.rect.x).toBe(110);
    record.setMenu(228, undefined);
    child.window.flags &= ~UiWindowFlag.Visible;
    await state.value.frame({ time: 2, frameTime: 1, draw: draw2D() });
    expect(child.window.clientRect.x).toBe(15);
    expect(child.window.rect.x).toBe(110);
    state.value.dispose();
  });

  test("numeric cinematic words reach actual permanent slots without reading an absent filename", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    const definitions = await parse("menuDef { name cinema rect 0 0 100 100 style 5 }", { kind: "qvm32", memory: pool });
    const menu = requiredValue(definitions.menus[0], "cinematic menu");
    const record = pool.menuRecord(0);
    const state = await runtimeFromDefinitions(definitions);
    await state.value.activate("cinema");
    record.setInt32(44, 0);
    await state.value.frame({ time: 1, frameTime: 1, draw: draw2D() });
    expect(state.cinema.played).toEqual([]);
    expect(menu.window.cinematicHandle).toBe(0);
    record.setInt32(44, -2);
    await state.value.frame({ time: 2, frameTime: 1, draw: draw2D() });
    record.setInt32(44, 16);
    await state.value.frame({ time: 3, frameTime: 1, draw: draw2D() });
    expect(state.cinema.runTimes).toEqual([1, 3]);
    await state.value.activate("missing");
    expect(state.cinema.stopped).toEqual([16]);
    expect(record.getInt32(44)).toBe(-1);
    state.value.dispose();
  });

  test("focus callbacks re-read menu membership and menu moves skip reached NULL item slots", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    const definitions = await parse(`menuDef { name members rect 0 0 200 100
      itemDef { name first type 1 rect 10 10 30 20 visible 1 leaveFocus { uiScript shrink } action { setfocus first } }
      itemDef { name second type 1 rect 50 10 30 20 visible 1 leaveFocus { uiScript unexpected } }
    }`, { kind: "qvm32", memory: pool });
    const menu = requiredValue(definitions.menus[0], "members menu");
    const first = requiredValue(menu.itemAt(0), "first member");
    const second = requiredValue(menu.itemAt(1), "second member");
    const record = pool.menuRecord(0);
    const state = await runtimeFromDefinitions(definitions);
    const seen: string[] = [];
    state.external.run = cursor => {
      seen.push(requiredValue(cursor.next(), "membership command").text);
      record.setInt32(188, 1);
      record.setItem(264, undefined);
    };
    await state.value.runItemScript("members", "first", requiredScript(first.action));
    expect(seen).toEqual(["shrink"]);
    expect(menu.itemCount).toBe(1);
    const handle = requiredValue(state.value.menuHandle("members"), "members handle");
    record.setInt32(188, 2);
    state.value.moveCapturedMenu(handle, 5, 7);
    expect(first.window.rect).toEqual({ x: 15, y: 17, width: 30, height: 20 });
    expect(second.window.rect).toEqual({ x: 50, y: 10, width: 30, height: 20 });
    record.setInt32(188, 1);
    state.value.dispose();
  });

  test("activates zero-count numeric multi widgets using their retained first value before the item action", async () => {
    const cases = [
      { list: "", expected: "0" },
      { list: "cvarFloatList { }", expected: "0" },
      { list: "cvarFloatList { Kept 3.25 } cvarFloatList { }", expected: "3.250000" },
      { list: "cvarFloatList { Old 3.25 } cvarFloatList { New -2 } cvarFloatList { }", expected: "-2" },
      { list: "cvarFloatList { Kept 3.25 } cvarStrList { Text value } cvarFloatList { }", expected: "3.250000" },
    ];
    for (const example of cases) for (const accounted of [false, true]) {
      const memory: UiMenuMemoryOwnership = accounted
        ? { kind: "qvm32", memory: new TeamArenaUiMemory("qvm32", () => {}) } : { kind: "unaccounted" };
      const state = await runtimeFromDefinitions(await parse(`menuDef { name multi rect 0 0 300 100 itemDef {
        name choice type 12 rect 10 10 100 30 visible 1 cvar selected ${example.list}
        action { uiScript selected }
      } }`, memory));
      state.cvars.set("selected", "9");
      const valuesAtAction: string[] = [];
      state.external.run = (cursor): void => {
        cursor.next();
        valuesAtAction.push(requiredValue(state.cvars.get("selected"), "selected cvar").value);
      };
      await state.value.activate("multi");
      state.value.setDisplayCursor(20, 20);
      await state.value.pointerMove(20, 20);
      await state.value.handleKey({ kind: "key", code: KeyCode.Mouse3, down: true }, 20, 20);
      expect(state.cvars.get("selected")?.value).toBe(example.expected);
      expect(valuesAtAction).toEqual([example.expected]);
      state.value.dispose();
    }
  });

  test("numeric multi activation reads retained pool bytes after String_Init and later shared writes", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    const source = (list: string): string => `menuDef { name multi rect 0 0 300 100 itemDef {
      name choice type 12 rect 10 10 100 30 visible 1 cvar selected ${list}
    } }`;
    await parse(source("cvarFloatList { Kept 3.25 }"), { kind: "qvm32", memory: pool });
    pool.initializeStrings();
    const definitions = await parse(source("cvarFloatList { }"), { kind: "qvm32", memory: pool });
    const state = await runtimeFromDefinitions(definitions);
    await state.value.activate("multi");
    state.value.setDisplayCursor(20, 20);
    await state.value.pointerMove(20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse3, down: true }, 20, 20);
    expect(state.cvars.get("selected")?.value).toBe("3.250000");
    const record = pool.borrow(576, 392);
    record.setFloat32(256, -2);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse3, down: true }, 20, 20);
    expect(state.cvars.get("selected")?.value).toBe("-2");
    record.setFloat32(260, 7.5);
    record.setInt32(384, 2);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse3, down: true }, 20, 20);
    expect(state.cvars.get("selected")?.value).toBe("7.500000");
    record.setInt32(384, 0);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse3, down: true }, 20, 20);
    expect(state.cvars.get("selected")?.value).toBe("-2");
    state.value.dispose();
  });

  test("publishes pointer focus before nested onFocus scripts and preserves their redirection", async () => {
    const state = await runtime(`menuDef { name focus rect 0 0 300 100
      itemDef { name first type 1 rect 10 10 100 30 visible 1
        onFocus { uiScript entered ; setfocus first ; setfocus target ; } }
      itemDef { name target type 1 rect 150 10 100 30 visible 1 onFocus { uiScript redirected } }
    }`);
    await state.value.activate("focus");
    await state.value.pointerMove(20, 20);
    expect(state.external.calls).toEqual(["focus/first:entered", "focus/target:redirected"]);
    const menu = requiredValue(state.value.snapshot().menus[0], "focus menu");
    expect(menu.items.map(item => item.flags & UiWindowFlag.HasFocus)).toEqual([0, UiWindowFlag.HasFocus]);
    expect(menu.cursorItem).toBe(0);
  });

  test("retains the old focus while a keyboard text miss still advances the menu cursor", async () => {
    const state = await runtime(`menuDef { name focus rect 0 0 300 200
      itemDef { name first type 1 rect 10 10 100 30 visible 1 onFocus { uiScript first } }
      itemDef { name label type 0 rect 10 60 100 30 visible 1 text Label textscale 1 textaligny 16 }
      itemDef { name next type 1 rect 10 110 100 30 visible 1 onFocus { uiScript next } }
    }`);
    await state.value.activate("focus");
    await state.value.frame({ time: 0, frameTime: 0, draw: draw2D() });
    state.value.setDisplayCursor(20, 20);
    await state.value.pointerMove(20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Down, down: true }, 20, 20);
    const menu = requiredValue(state.value.snapshot().menus[0], "focus menu");
    expect(menu.cursorItem).toBe(1);
    expect(menu.items.map(item => item.flags & UiWindowFlag.HasFocus)).toEqual([UiWindowFlag.HasFocus, 0, 0]);
    expect(state.external.calls).toEqual(["focus/first:first", "focus/first:first"]);
    expect(state.audio.local).toHaveLength(1);
  });

  test("uses the source preincrement and predecrement when keyboard navigation starts without a cursor", async () => {
    for (const key of [KeyCode.Down, KeyCode.Up]) {
      const state = await runtime(`menuDef { name focus rect 0 0 300 200
        itemDef { name first type 1 rect 10 10 100 30 visible 1 }
        itemDef { name second type 1 rect 10 50 100 30 visible 1 }
        itemDef { name third type 1 rect 10 90 100 30 visible 1 }
        itemDef { name last type 1 rect 10 130 100 30 visible 1 }
      }`);
      await state.value.activate("focus");
      const handle = requiredValue(state.value.menuHandle("focus"), "focus handle");
      expect(state.value.snapshot().menus[0]?.cursorItem).toBe(-1);
      await state.value.handleCapturedKey(handle, { kind: "key", code: key, down: true });
      const menu = requiredValue(state.value.snapshot().menus[0], "focus menu");
      expect(menu.cursorItem).toBe(key === KeyCode.Down ? 1 : 2);
      expect(menu.items.filter(item => (item.flags & UiWindowFlag.HasFocus) !== 0).map(item => item.name))
        .toEqual([key === KeyCode.Down ? "second" : "third"]);
    }
  });

  test("navigates the retained editing field's parent after another menu becomes focused", async () => {
    const state = await runtime(`menuDef { name editing rect 0 0 300 200
      itemDef { name first type 4 rect 10 10 100 30 visible 1 cvar first }
      itemDef { name second type 4 rect 10 60 100 30 visible 1 cvar second }
    }
    menuDef { name overlay rect 0 0 300 200
      itemDef { name other type 4 rect 10 10 100 30 visible 1 cvar other }
    }`);
    state.cvars.set("first", "a");
    state.cvars.set("second", "");
    state.cvars.set("other", "b");
    await state.value.activate("editing");
    state.value.setDisplayCursor(20, 20);
    await state.value.pointerMove(20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 20, 20);
    await state.value.activate("overlay");
    const overlay = requiredValue(state.value.menuHandle("overlay"), "overlay handle");
    await state.value.handleCapturedKey(overlay, { kind: "key", code: KeyCode.Tab, down: true });
    await state.value.handleCapturedKey(overlay, { kind: "character", code: 90 });
    expect(state.cvars.get("first")?.value).toBe("a");
    expect(state.cvars.get("second")?.value).toBe("Z");
    expect(state.cvars.get("other")?.value).toBe("b");
    expect(state.value.snapshot().menus[0]?.cursorItem).toBe(1);
  });

  test("recomputes painted text and mouse hitboxes after menu moves and item transitions", async () => {
    const state = await runtime(`menuDef { name layout rect 10 20 250 100
      itemDef { name label type 0 rect 10 10 100 30 visible 1 text X textscale 1 textaligny 16
        action { uiScript pressed } }
      itemDef { name move action { transition label 10 10 100 30 30 10 100 30 0 1 } }
    }`);
    await state.value.activate("layout");
    const draw = draw2D();
    await state.value.frame({ time: 0, frameTime: 0, draw });
    const initial = requiredValue(consumedBatches(draw)[0]?.vertices[0], "initial text vertex");
    expect((initial.position.x + 1) * 320).toBeCloseTo(20, 4);
    expect((1 - initial.position.y) * 240).toBeCloseTo(38, 4);
    state.value.setDisplayCursor(22, 40);
    await state.value.pointerMove(22, 40);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 22, 40);

    const handle = requiredValue(state.value.menuHandle("layout"), "layout handle");
    state.value.moveCapturedMenu(handle, 100, 30);
    await state.value.frame({ time: 1, frameTime: 1, draw });
    const moved = requiredValue(consumedBatches(draw)[0]?.vertices[0], "moved text vertex");
    expect((moved.position.x + 1) * 320).toBeCloseTo(120, 4);
    expect((1 - moved.position.y) * 240).toBeCloseTo(68, 4);
    state.value.setDisplayCursor(122, 70);
    await state.value.pointerMove(122, 70);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 122, 70);

    await state.value.runItemScript("layout", "move", requiredScript(state.definitions.menus[0]?.items[1]?.action));
    await state.value.frame({ time: 2, frameTime: 1, draw });
    const transitioned = requiredValue(consumedBatches(draw)[0]?.vertices[0], "transitioned text vertex");
    expect((transitioned.position.x + 1) * 320).toBeCloseTo(140, 4);
    expect((1 - transitioned.position.y) * 240).toBeCloseTo(68, 4);
    state.value.setDisplayCursor(142, 70);
    await state.value.pointerMove(142, 70);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 142, 70);
    expect(state.external.calls).toEqual(["layout/label:pressed", "layout/label:pressed", "layout/label:pressed"]);
  });

  test("preserves automatic-wrap spaces, source break width and item border coordinates", async () => {
    const state = await runtime(`menuDef { name wrapping rect 0 0 300 200 itemDef {
      name label type 0 rect 10 10 100 100 border 1 bordersize 2 visible 1 autowrapped
      text "A  B" textscale 1 textalign 2 textalignx 100 textaligny 16
    } }`);
    await state.value.activate("wrapping");
    const draw = draw2D();
    await state.value.frame({ time: 0, frameTime: 0, draw });
    const batches = consumedBatches(draw);
    expect(batches).toHaveLength(8);
    for (const [index, batch] of batches.slice(4).entries()) {
      const vertex = requiredValue(batch.vertices[0], "automatic-wrap glyph");
      expect((vertex.position.x + 1) * 320).toBeCloseTo(90 + index * 8, 4);
      expect((1 - vertex.position.y) * 240).toBeCloseTo(22, 4);
    }
  });

  test("retains the last automatically wrapped line as the text mouse hitbox", async () => {
    const state = await runtime(`menuDef { name wrapping rect 0 0 300 200 itemDef {
      name label type 0 rect 10 10 8 100 visible 1 autowrapped text "A B" textscale 1 textaligny 16
      action { uiScript pressed }
    } }`);
    await state.value.activate("wrapping");
    const draw = draw2D();
    await state.value.frame({ time: 0, frameTime: 0, draw });
    const batches = consumedBatches(draw);
    expect(batches).toHaveLength(2);
    for (const [index, batch] of batches.entries()) {
      const vertex = requiredValue(batch.vertices[0], "wrapped glyph");
      expect((1 - vertex.position.y) * 240).toBeCloseTo(18 + index * 13, 4);
    }
    state.value.setDisplayCursor(12, 20);
    await state.value.pointerMove(12, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 12, 20);
    expect(state.external.calls).toEqual([]);
    state.value.setDisplayCursor(12, 33);
    await state.value.pointerMove(12, 33);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 12, 33);
    expect(state.external.calls).toEqual(["wrapping/label:pressed"]);
  });

  test("preserves blank automatic-wrap lines and the retained buffer width after a newline", async () => {
    const state = await runtime(`menuDef { name wrapping rect 0 0 300 200 itemDef {
      name label type 0 rect 10 10 100 100 visible 1 autowrapped cvar content
      textscale 1 textalign 2 textalignx 100 textaligny 16
    } }`);
    state.cvars.set("content", "A\n\nB");
    await state.value.activate("wrapping");
    const draw = draw2D();
    await state.value.frame({ time: 0, frameTime: 0, draw });
    const batches = consumedBatches(draw);
    expect(batches).toHaveLength(2);
    const first = requiredValue(batches[0]?.vertices[0], "first-line glyph");
    const last = requiredValue(batches[1]?.vertices[0], "last-line glyph");
    expect((first.position.x + 1) * 320).toBeCloseTo(110, 4);
    expect((1 - first.position.y) * 240).toBeCloseTo(18, 4);
    expect((last.position.x + 1) * 320).toBeCloseTo(102, 4);
    expect((1 - last.position.y) * 240).toBeCloseTo(44, 4);
  });

  test("reads an owner value only when that widget has color ranges", async () => {
    const state = await runtime(`menuDef { name owners rect 0 0 300 200
      itemDef { name plain ownerdraw 9 rect 10 10 100 30 visible 1 }
      itemDef { name range ownerdraw 10 rect 10 60 100 30 visible 1 addColorRange 0 1 0 1 0 1 }
    }`);
    let reads = 0;
    state.owner.value = (): number => { reads++; return .5; };
    await state.value.activate("owners");
    await state.value.frame({ time: 0, frameTime: 0, draw: draw2D() });
    expect(reads).toBe(1);
    expect(state.owner.paints.map(request => request.color)).toEqual([
      { x: 1, y: 1, z: 1, w: 1 }, { x: 0, y: 1, z: 0, w: 1 },
    ]);
  });

  test("retains setcolor flags and component prefixes when later numeric operands are absent", async () => {
    const state = await runtime(`menuDef { name colors
      itemDef { name back action { setcolor backcolor } }
      itemDef { name fore action { setcolor forecolor .25 .5 } }
      itemDef { name border action { setcolor bordercolor .25 .5 .75 } }
    }`);
    const menu = requiredValue(state.definitions.menus[0], "color definitions");
    for (const item of menu.items) {
      await state.value.runItemScript("colors", requiredValue(item.window.name, "color item name"), requiredScript(item.action));
    }
    const items = requiredValue(state.value.snapshot().menus[0], "color menu").items;
    const back = requiredValue(items[0], "backcolor item"), fore = requiredValue(items[1], "forecolor item");
    expect(back.flags & UiWindowFlag.BackColorSet).toBe(UiWindowFlag.BackColorSet);
    expect(back.backColor).toEqual({ x: 0, y: 0, z: 0, w: 0 });
    expect(fore.flags & UiWindowFlag.ForeColorSet).toBe(UiWindowFlag.ForeColorSet);
    expect(fore.foreColor).toEqual({ x: .25, y: .5, z: 1, w: 1 });
    expect(items[2]?.borderColor).toEqual({ x: .25, y: .5, z: .75, w: 0 });
  });

  test("uses disableColor for both focused and blinking disabled text", async () => {
    const state = await runtime(`menuDef { name colors rect 0 0 300 100
      focuscolor 1 0 0 1 disablecolor 0 1 0 1 onOpen { setfocus focus }
      itemDef { name focus type 1 rect 10 10 100 30 visible 1 text F textscale 1 textaligny 16
        cvarTest enabled enableCvar { 1 } }
      itemDef { name blink type 1 rect 150 10 100 30 visible 1 text B textscale 1 textaligny 16 textstyle 1
        cvarTest enabled enableCvar { 1 } }
    }`);
    state.cvars.set("enabled", "0");
    await state.value.activate("colors");
    const draw = draw2D();
    await state.value.frame({ time: 0, frameTime: 0, draw });
    expect(consumedBatches(draw).map(batch => batch.vertices[0]?.color)).toEqual([
      { x: 0, y: 1, z: 0, w: 1 }, { x: 0, y: 1, z: 0, w: 1 },
    ]);
  });

  test("retains failed window cinematics across hide, show and menu activation", async () => {
    const state = await runtime(`menuDef { name movies rect 0 0 300 100 style 5 cinematic video/menu.roq
      itemDef { name movie rect 10 10 100 30 visible 1 style 5 cinematic video/item.roq
        action { hide movie ; show movie ; } }
    }`);
    let attempts = 0;
    state.cinema.play = (): undefined => { attempts++; return undefined; };
    await state.value.activate("movies");
    await state.value.frame({ time: 0, frameTime: 0, draw: draw2D() });
    expect(attempts).toBe(2);
    await state.value.runItemScript("movies", "movie", requiredScript(state.definitions.menus[0]?.items[0]?.action));
    await state.value.frame({ time: 1, frameTime: 1, draw: draw2D() });
    await state.value.activate("movies");
    await state.value.frame({ time: 2, frameTime: 1, draw: draw2D() });
    expect(attempts).toBe(2);
    expect(state.cinema.stopped).toEqual([]);
  });

  test("draws a captured list thumb at the cursor before its row position changes", async () => {
    for (const horizontal of [false, true]) {
      const state = await runtime(`menuDef { name capture rect 0 0 300 200 itemDef {
        name list type 6 rect 10 10 120 80 visible 1 feeder 7 elementwidth 32 elementheight 16
        ${horizontal ? "horizontalscroll" : ""}
      } }`);
      await state.value.activate("capture");
      const draw = draw2D();
      await state.value.frame({ time: 0, frameTime: 0, draw });
      consumedBatches(draw);
      const x = horizontal ? 35 : 120, y = horizontal ? 80 : 35;
      state.value.setDisplayCursor(x, y);
      await state.value.pointerMove(x, y);
      await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, x, y);
      const movedX = horizontal ? 40 : x, movedY = horizontal ? y : 40;
      state.value.setDisplayCursor(movedX, movedY);
      await state.value.frame({ time: 1, frameTime: 1, draw });
      const held = requiredValue(consumedBatches(draw)[3]?.vertices[0], "held thumb vertex");
      expect(horizontal ? (held.position.x + 1) * 320 : (1 - held.position.y) * 240).toBeCloseTo(32, 4);
      const behavior = firstRuntimeItem(state.value).behavior;
      if (behavior.kind !== "list-box") throw new Error("expected list state");
      expect(behavior.startPosition).toBe(0);
      await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: false }, movedX, movedY);
      await state.value.frame({ time: 2, frameTime: 1, draw });
      const released = requiredValue(consumedBatches(draw)[3]?.vertices[0], "released thumb vertex");
      expect(horizontal ? (released.position.x + 1) * 320 : (1 - released.position.y) * 240).toBeCloseTo(27, 4);
    }
  });

  test("retains prior arrow scroll timers when the next capture grabs a vertical thumb", async () => {
    const state = await runtime(`menuDef { name capture rect 0 0 300 200 itemDef {
      name list type 6 rect 10 10 120 80 visible 1 feeder 7 elementwidth 32 elementheight 16
    } }`);
    await state.value.activate("capture");
    state.value.setDisplayCursor(120, 80);
    await state.value.pointerMove(120, 80);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 120, 80);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: false }, 120, 80);
    state.value.setDisplayCursor(120, 40);
    await state.value.pointerMove(120, 40);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 120, 40);
    await state.value.close("capture");
    let countReads = 0;
    state.feeder.count = (): number => { countReads++; return 8; };
    await state.value.frame({ time: 499, frameTime: 499, draw: draw2D() });
    await state.value.frame({ time: 500, frameTime: 1, draw: draw2D() });
    expect(countReads).toBe(0);
    await state.value.frame({ time: 501, frameTime: 1, draw: draw2D() });
    expect(countReads).toBeGreaterThan(0);
  });

  test("returns before timer and feeder work while a horizontal thumb has not moved", async () => {
    const state = await runtime(`menuDef { name capture rect 0 0 300 200 itemDef {
      name list type 6 rect 10 10 120 80 visible 1 horizontalscroll feeder 7 elementwidth 32 elementheight 16
    } }`);
    await state.value.activate("capture");
    state.value.setDisplayCursor(35, 80);
    await state.value.pointerMove(35, 80);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 35, 80);
    await state.value.close("capture");
    let countReads = 0;
    state.feeder.count = (): number => { countReads++; return 8; };
    await state.value.frame({ time: 1, frameTime: 1, draw: draw2D() });
    state.value.setDisplayCursor(35, 79);
    await state.value.frame({ time: 2, frameTime: 1, draw: draw2D() });
    expect(countReads).toBe(0);
    state.value.setDisplayCursor(40, 79);
    await state.value.frame({ time: 3, frameTime: 1, draw: draw2D() });
    expect(countReads).toBeGreaterThan(0);
  });

  test("selection and owner key callbacks finish before the following menu action", async () => {
    const state = await runtime(`menuDef { name main rect 0 0 200 200
      itemDef { name list type 6 rect 10 10 100 60 visible 1 feeder 7 elementwidth 20 elementheight 10
        action { setcvar list_action 1 } }
      itemDef { name owner ownerdraw 1 rect 10 100 100 20 visible 1 special 4 action { setcvar owner_action 1 } }
    }`);
    await state.value.activate("main");
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    state.feeder.select = async (feeder, index) => {
      entered.resolve(); await release.promise; state.feeder.selections.push(`${feeder}:${index}`);
    };
    let complete = false;
    const selection = state.value.setFeederSelection(7, 2).then(() => { complete = true; });
    await entered.promise;
    expect(complete).toBe(false); expect(state.feeder.selections).toEqual([]);
    release.resolve(); await selection;
    expect(state.feeder.selections).toEqual(["7:2"]);
    const keyEntered = Promise.withResolvers<void>(), keyRelease = Promise.withResolvers<void>();
    state.feeder.select = async () => { keyEntered.resolve(); await keyRelease.promise; };
    state.value.setDisplayCursor(20, 20); await state.value.pointerMove(20, 20);
    const key = state.value.handleKey({ kind: "key", code: KeyCode.Down, down: true }, 20, 20);
    await keyEntered.promise; expect(state.cvars.get("list_action")).toBeUndefined();
    keyRelease.resolve(); await key; expect(state.cvars.get("list_action")?.value).toBe("1");
    const ownerEntered = Promise.withResolvers<void>(), ownerRelease = Promise.withResolvers<void>();
    state.owner.handleKey = async () => {
      ownerEntered.resolve(); await ownerRelease.promise; return { handled: true, special: 9 };
    };
    state.value.setDisplayCursor(20, 110); await state.value.pointerMove(20, 110);
    const owner = state.value.handleKey({ kind: "key", code: KeyCode.Enter, down: true }, 20, 110);
    await ownerEntered.promise; expect(state.cvars.get("owner_action")).toBeUndefined();
    ownerRelease.resolve(); await owner;
    expect(state.cvars.get("owner_action")?.value).toBe("1");
    expect(state.value.snapshot().menus[0]?.items[1]?.special).toBe(9);
    state.value.dispose();
  });

  test("list painting awaits both shader and text providers and rejects a retired pending frame", async () => {
    for (const style of [0, 1]) {
      const state = await runtime(`menuDef { name main rect 0 0 200 100 itemDef {
        name list type 6 rect 10 10 100 60 visible 1 feeder 7 elementwidth 20 elementheight 10 elementtype ${style}
      } }`);
      await state.value.activate("main");
      state.feeder.item = () => ({ text: null, picture: undefined });
      await state.value.frame({ time: 0, frameTime: 0, draw: draw2D() });
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      state.feeder.item = async () => { entered.resolve(); await release.promise; return { text: "row", picture: undefined }; };
      state.feeder.image = async () => { entered.resolve(); await release.promise; return picture; };
      const pending = state.value.frame({ time: 0, frameTime: 0, draw: draw2D() });
      await entered.promise; state.value.retire();
      release.resolve(); await expect(pending).rejects.toThrow("disposed");
    }
  });

  for (const operation of ["paint", "cache"]) {
    test(`cinematic ${operation} resolves the current retained source name after pool reuse`, async () => {
      const pool = new TeamArenaUiMemory("qvm32", () => {}), ownership: UiMenuMemoryOwnership = { kind: "qvm32", memory: pool };
      const definitions = await parse('menuDef { name main rect 0 0 640 480 style 5 cinematic "old.roq" }', ownership);
      const state = await runtimeFromDefinitions(definitions);
      const handle = requiredValue(state.value.menuHandle("main"), "retained cinematic menu");
      const prepare = state.resources.prepareCinematic.bind(state.resources), prepared: string[] = [];
      state.resources.prepareCinematic = async path => { prepared.push(path); return prepare(path); };
      pool.initializeStrings();
      if (operation === "paint") state.value.resetDefinitions("strings");
      pool.stringAlloc("main"); pool.stringAlloc("new.roq");
      expect(handle.definition.window.cinematic).toBe("new.roq");
      if (operation === "paint") {
        await state.value.paintCaptured(handle, { time: 0, frameTime: 0, draw: draw2D() }, true);
        expect(state.cinema.runTimes).toEqual([0]);
      } else {
        await state.value.cacheAll();
        expect(state.cinema.stopped).toEqual([0]);
      }
      expect(prepared).toEqual(["new.roq"]);
      expect(state.cinema.played.map(instance => instance.asset.path)).toEqual(["video/new.roq"]);
      state.value.dispose();
    });
  }

  test("incremental publication preserves earlier live menu/item/capture state without replaying registrations", async () => {
    const memory = new TeamArenaUiMemory("qvm32", () => {});
    const ownership: UiMenuMemoryOwnership = { kind: "qvm32", memory };
    const state = await runtimeFromDefinitions(await parse("", ownership));
    const registration = new ResourceRegistrationSink(state.resources);
    const parser = new UiMenuSourceParser({ resolver: new MemoryResolver(""), random: { nextInt: () => 7 } }, {}, {
      memory: ownership,
      registrationSink: { async register(event) { await registration.register(event); state.value.acceptMenuRegistration(event); } },
      assetSink: { publish(event) { state.value.publishMenuAsset(event); } },
      menuSink: { menuCount: () => state.value.menuCount(), publish: menu => state.value.appendMenu(menu, ownership) },
    });
    await parser.parseSource({ path: "first", text: `menuDef { name first background firstShader itemDef { name target
      action { setcolor backcolor .2 .4 .6 .8 ; } } }` });
    await state.value.activate("first");
    const captured = state.value.focusedMenuHandle();
    if (captured === undefined) throw new Error("missing first menu");
    await state.value.runItemScript("first", "target", requiredScript(captured.definition.items[0]?.action));
    const before = state.value.snapshot().menus[0], allocated = memory.allocatedBytes;
    await parser.parseSource({ path: "second", text: "menuDef { name second background secondShader }" });
    expect(state.value.snapshot().menus[0]).toEqual(before);
    expect(state.value.focusedMenuHandle()).toBe(captured);
    expect(state.resources.registrations).toEqual(["picture:firstShader", "picture:secondShader"]);
    expect(memory.allocatedBytes - allocated).toBe(32);
    await state.value.activate("second");
    const stack = state.value.snapshot().openStack;
    await parser.parseSource({ path: "third", text: "menuDef { name third }" });
    expect(state.value.snapshot().openStack).toEqual(stack);
    expect(state.value.menuCount()).toBe(3);
    state.value.resetDefinitions("menus");
    await parser.parseSource({ path: "replacement", text: "menuDef { name replaced }" });
    expect(state.value.menuCount()).toBe(1);
    expect(captured.definition.window.name).toBe("replaced");
    state.value.dispose();
  });

  for (const operation of ["close", "activate", "pointer"]) {
    test(`${operation} menu traversal rereads source menuCount after script reset`, async () => {
      const pool = new TeamArenaUiMemory("qvm32", () => {});
      const menuText = (name: string, command: string) => `menuDef { name ${name} rect 0 0 100 100 visible 1
        ${operation === "close" ? `onClose { uiScript ${command} }` : operation === "activate" ? `onOpen { uiScript ${command} }`
          : `itemDef { name target type 1 rect 10 10 50 50 visible 1 mouseEnter { uiScript ${command} } }`}
      }`;
      const definitions = await parse(menuText("first", "reset") + menuText(operation === "activate" ? "first" : "second", "unexpected"),
        { kind: "qvm32", memory: pool });
      const second = requiredValue(definitions.menus[1], "second retained menu");
      const state = await runtimeFromDefinitions(definitions), calls: string[] = [];
      state.external.run = cursor => {
        const command = cursor.next()?.text; if (command === undefined) throw new Error("missing reset command");
        calls.push(command); if (command === "reset") state.value.resetDefinitions("menus");
      };
      if (operation === "close") await state.value.closeAll();
      else if (operation === "activate") await state.value.activate("first");
      else await state.value.pointerMove(20, 20);
      expect(calls).toEqual(["reset"]);
      expect(state.value.menuCount()).toBe(0);
      expect(second.window.flags & UiWindowFlag.Visible).toBe(UiWindowFlag.Visible);
      state.value.dispose();
    });
  }

  test("frame traversal rereads source menuCount after owner draw callback reset", async () => {
    const state = await runtime(`menuDef { name first rect 0 0 100 100 visible 1 itemDef { name widget type 8 ownerdraw 200 visible 1 } }
      menuDef { name second rect 0 0 100 100 visible 1 itemDef { name widget type 8 ownerdraw 201 visible 1 } }`);
    const painted: number[] = [];
    state.owner.paint = request => { painted.push(request.ownerDraw); state.value.resetDefinitions("menus"); };
    await state.value.frame({ time: 0, frameTime: 0, draw: draw2D() });
    expect(painted).toEqual([200]);
    state.value.dispose();
  });

  test("focused dispatch selects the source captured menu instead of the menu under the pointer", async () => {
    const state = await runtime(`menuDef { name first rect 0 0 100 100 visible 1 onESC { setcvar chosen first } }
      menuDef { name second rect 200 0 100 100 visible 1 onESC { setcvar chosen second } }`);
    await state.value.activate("second");
    const handle = state.value.focusedMenuHandle();
    if (handle === undefined) throw new Error("missing focused menu");
    await state.value.handleKey({ kind: "key", code: KeyCode.Escape, down: true }, 20, 20);
    expect(state.cvars.get("chosen")?.value).toBe("first");
    await state.value.handleCapturedKey(handle, { kind: "key", code: KeyCode.Escape, down: true });
    expect(state.cvars.get("chosen")?.value).toBe("second");
    const foreign = await runtime("menuDef { name foreign visible 1 }");
    await foreign.value.activate("foreign");
    const foreignHandle = foreign.value.focusedMenuHandle();
    if (foreignHandle === undefined) throw new Error("missing foreign menu");
    await expect(state.value.handleCapturedKey(foreignHandle, { kind: "key", code: KeyCode.Escape, down: true })).rejects.toThrow("belong");
    foreign.value.dispose(); state.value.dispose();
  });

  test("character events retain their flag through ordinary menu, item, ownerdraw and out-of-bounds handling", async () => {
    const state = await runtime(`menuDef { name main rect 0 0 200 200 outofboundsclick onESC { setcvar escaped 1 }
      itemDef { name button type 1 rect 10 10 100 20 visible 1 action { setcvar activated 1 } }
      itemDef { name owner ownerdraw 1 rect 10 40 100 20 visible 1 }
    }`);
    await state.value.activate("main");
    const handle = state.value.focusedMenuHandle();
    if (handle === undefined) throw new Error("missing focused menu");
    state.value.setDisplayCursor(20, 20); await state.value.pointerMove(20, 20);
    for (const code of [KeyCode.Escape, KeyCode.Enter, KeyCode.Mouse1]) {
      await state.value.handleCapturedKey(handle, { kind: "character", code });
      await state.value.handleKey({ kind: "character", code }, 20, 20);
    }
    expect(state.cvars.get("escaped")).toBeUndefined(); expect(state.cvars.get("activated")).toBeUndefined();
    state.value.setDisplayCursor(300, 300);
    await state.value.handleCapturedKey(handle, { kind: "character", code: KeyCode.Mouse1 });
    expect(state.value.focusedMenuHandle()).toBe(handle);
    state.value.setDisplayCursor(20, 20);
    await state.value.handleCapturedKey(handle, { kind: "key", code: KeyCode.Enter, down: true });
    expect(state.cvars.get("activated")?.value).toBe("1");
    state.value.setDisplayCursor(20, 50); await state.value.pointerMove(20, 50);
    await state.value.handleCapturedKey(handle, { kind: "character", code: KeyCode.Escape });
    expect(state.owner.keys).toEqual([KEY_CHAR_FLAG | KeyCode.Escape]);
    expect(state.cvars.get("escaped")).toBeUndefined();
    state.value.dispose();
  });

  test("text entry strips the character flag locally while the outer menu retains it", async () => {
    const state = await runtime(`menuDef { name main rect 0 0 200 200 onESC { setcvar escaped 1 }
      itemDef { name edit type 4 cvar field rect 10 10 100 20 visible 1 } }`);
    state.cvars.set("field", "abc");
    await state.value.activate("main");
    const handle = state.value.focusedMenuHandle();
    if (handle === undefined) throw new Error("missing focused menu");
    state.value.setDisplayCursor(20, 20); await state.value.pointerMove(20, 20);
    await state.value.handleCapturedKey(handle, { kind: "key", code: KeyCode.Enter, down: true });
    await state.value.handleCapturedKey(handle, { kind: "character", code: KeyCode.Escape });
    await state.value.handleCapturedKey(handle, { kind: "character", code: 120 });
    expect(state.cvars.get("field")?.value).toBe("xbc");
    await state.value.handleCapturedKey(handle, { kind: "character", code: 8 });
    expect(state.cvars.get("field")?.value).toBe("bc");
    expect(state.cvars.get("escaped")).toBeUndefined();
    state.value.dispose();
  });

  test("outside-click dispatch awaits actual pause completion before closing cinematics", async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const state = await runtimeFromDefinitions(await parse(`menuDef { name main rect 0 0 100 100
      style 5 cinematic "video/intro.roq" outofboundsclick }`), new CvarRegistry(), new ResourceTrace(), whitePicture, "ui",
      async paused => { expect(paused).toBe(false); entered.resolve(); await release.promise; });
    await state.value.activate("main");
    await state.value.frame({ time: 0, frameTime: 0, draw: draw2D() });
    const handle = state.value.focusedMenuHandle();
    if (handle === undefined) throw new Error("missing focused menu");
    state.value.setDisplayCursor(200, 200);
    const pending = state.value.handleCapturedKey(handle, { kind: "key", code: KeyCode.Mouse1, down: true });
    await entered.promise;
    expect(state.cinema.played).toHaveLength(1);
    expect(state.cinema.stopped).toEqual([]);
    release.resolve(); await pending;
    expect(state.cinema.stopped).toEqual([requiredValue(state.cinema.played[0], "playing cinematic").handle.index]);
    state.value.dispose();
  });

  test("runtime borrows parsed memory, allocating script strings but not numeric operands or runtime items", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {}), strings: (string | null)[] = [];
    const memory: UiMenuMemoryOwnership = { kind: "qvm32", memory: {
      allocate(size) { return pool.allocate(size); },
      borrow(offset, size) { return pool.borrow(offset, size); },
      menuRecord(index) { return pool.menuRecord(index); },
      stringAlloc(text) { strings.push(text); return pool.stringAlloc(text); },
      stringAllocReference(text) { strings.push(text); return pool.stringAllocReference(text); },
    } };
    const definitions = await parse(`menuDef { name main itemDef { name target action {
      setcolor backcolor .1 .2 .3 .4 ; transition target 0 0 1 1 2 2 3 3 10 2 ; setcvar flag yes ;
    } } }`, memory);
    const beforeRuntime = pool.allocatedBytes;
    const state = await runtimeFromDefinitions(definitions);
    expect(pool.allocatedBytes).toBe(beforeRuntime);
    strings.length = 0;
    const script = requiredScript(definitions.menus[0]?.items[0]?.action);
    await state.value.runItemScript("main", "target", script);
    expect(strings).toEqual(["setcolor", "backcolor", ";", "transition", "target", ";", "setcvar", "flag", "yes", ";"]);
    expect(state.cvars.get("flag")?.value).toBe("yes");
    const used = pool.allocatedBytes;
    await state.value.runItemScript("main", "target", script);
    expect(pool.allocatedBytes).toBe(used);
    state.value.dispose();
  });

  test("cvar predicates allocate only through the first match and Menu_Count remains a pure query", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {}), strings: (string | null)[] = [];
    const memory: UiMenuMemoryOwnership = { kind: "qvm32", memory: {
      allocate(size) { return pool.allocate(size); },
      borrow(offset, size) { return pool.borrow(offset, size); },
      menuRecord(index) { return pool.menuRecord(index); },
      stringAlloc(text) { strings.push(text); return pool.stringAlloc(text); },
      stringAllocReference(text) { strings.push(text); return pool.stringAllocReference(text); },
    } };
    const definitions = await parse(`menuDef { name main visible 1 itemDef {
      name target visible 1 cvarTest choice showCvar { yes ; no ; later }
    } }`, memory);
    const state = await runtimeFromDefinitions(definitions);
    state.cvars.set("choice", "yes");
    strings.length = 0;
    expect(state.value.menuCount()).toBe(1);
    expect(strings).toEqual([]);
    state.value.snapshot();
    expect(strings).toContain("yes");
    expect(strings).not.toContain("no");
    expect(strings).not.toContain("later");
    const bytes = pool.allocatedBytes;
    state.value.resetDefinitions("menus");
    expect(state.value.menuCount()).toBe(0);
    expect(pool.allocatedBytes).toBe(bytes);
    await state.value.reloadDefinitions(definitions);
    expect(state.value.menuCount()).toBe(1);
    state.value.resetDefinitions("strings");
    expect(pool.allocatedBytes).toBe(bytes);
    await state.value.reloadDefinitions(definitions);
    expect(pool.allocatedBytes).toBe(bytes);
    state.value.dispose();
    expect(() => state.value.menuCount()).toThrow();
  });

  test("reload rejects a different or absent pool before registering resources", async () => {
    const memory: UiMenuMemoryOwnership = { kind: "qvm32", memory: new TeamArenaUiMemory("qvm32", () => {}) };
    const state = await runtimeFromDefinitions(await parse("menuDef { name main }", memory));
    for (const replacement of [await parse("menuDef { background new }"),
      await parse("menuDef { background new }", { kind: "qvm32", memory: new TeamArenaUiMemory("qvm32", () => {}) })]) {
      const registrations = [...state.resources.registrations];
      await expect(state.value.reloadDefinitions(replacement)).rejects.toThrow("memory owner");
      expect(state.resources.registrations).toEqual(registrations);
      expect(state.value.menuCount()).toBe(1);
    }
    state.value.dispose();
  });

  test("runtime preserves String_Alloc NULL until the reached command dereference", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    const definitions = await parse("menuDef { name main itemDef { name target action { setcvar flag yes ; } } }",
      { kind: "qvm32", memory: pool });
    const state = await runtimeFromDefinitions(definitions);
    pool.stringAlloc("x".repeat(384 * 1024 - pool.stringBytes - 2));
    await expect(state.value.runItemScript("main", "target", requiredScript(definitions.menus[0]?.items[0]?.action)))
      .rejects.toThrow("NULL command");
    expect(state.cvars.get("flag")).toBeUndefined();
    state.value.dispose();
  });

  test("NULL script cvar values reset through the actual registry and leave missing variables absent", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    for (const text of ["setcvar", "selected", "missing", "setplayermodel", "setplayerhead", ";", "done", "yes"]) pool.stringAlloc(text);
    const definitions = await parse(`menuDef { name main itemDef { name trigger action {
      setcvar selected unavailable ; setcvar missing unavailable ; setplayermodel unavailable ;
      setplayerhead unavailable ; setcvar done yes
    } } }`, { kind: "qvm32", memory: pool });
    const state = await runtimeFromDefinitions(definitions);
    state.cvars.register("selected", "default", CvarFlag.Latch);
    state.cvars.set("selected", "changed", true); state.cvars.set("selected", "pending");
    state.cvars.register("team_model", "model-default"); state.cvars.set("team_model", "model-change", true);
    state.cvars.register("team_headmodel", "head-default"); state.cvars.set("team_headmodel", "head-change", true);
    pool.stringAlloc("x".repeat(384 * 1024 - pool.stringBytes - 2));
    await state.value.runItemScript("main", "trigger", requiredScript(definitions.menus[0]?.items[0]?.action));
    expect(state.cvars.get("selected")?.value).toBe("default");
    expect(state.cvars.get("selected")?.latchedValue).toBeUndefined();
    expect(state.cvars.get("missing")).toBeUndefined();
    expect(state.cvars.get("team_model")?.value).toBe("model-default");
    expect(state.cvars.get("team_headmodel")?.value).toBe("head-default");
    expect(state.cvars.get("done")?.value).toBe("yes");
    state.value.dispose();
  });

  test("NULL script cvar names reach actual BADNAME validation before reset or assignment", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {}), printed: string[] = [], debug: string[] = [];
    for (const text of ["setcvar", "value", ";"]) pool.stringAlloc(text);
    const definitions = await parse(`menuDef { name main itemDef { name assign action { setcvar unavailable value } }
      itemDef { name reset action { setcvar unavailable unavailable } } }`, { kind: "qvm32", memory: pool });
    const cvars = new CvarRegistry(text => { printed.push(text); }, text => { debug.push(text); });
    cvars.register("BADNAME", "default");
    const state = await runtimeFromDefinitions(definitions, cvars);
    pool.stringAlloc("x".repeat(384 * 1024 - pool.stringBytes - 2));
    await state.value.runItemScript("main", "assign", requiredScript(definitions.menus[0]?.items[0]?.action));
    expect(cvars.get("BADNAME")?.value).toBe("value");
    await state.value.runItemScript("main", "reset", requiredScript(definitions.menus[0]?.items[1]?.action));
    expect(cvars.get("BADNAME")?.value).toBe("default");
    expect(printed).toEqual(["invalid cvar name string: (null)\n", "invalid cvar name string: (null)\n"]);
    expect(debug).toEqual(["Cvar_Set2: (null) value\n", "Cvar_Set2: (null) (null)\n"]);
    state.value.dispose();
  });

  test("NULL string multi values reset the registered cvar before the source item action", async () => {
    const state = await runtime(`menuDef { name main rect 0 0 300 100 itemDef {
      name choice type 12 rect 10 10 100 30 visible 1 cvar selected cvarStrList { }
      action { uiScript selected }
    } }`);
    state.cvars.register("selected", "default", CvarFlag.Latch);
    state.cvars.set("selected", "changed", true); state.cvars.set("selected", "pending");
    const actionValues: string[] = [];
    state.external.run = cursor => { cursor.next(); actionValues.push(requiredValue(state.cvars.get("selected"), "selected cvar").value); };
    await state.value.activate("main");
    state.value.setDisplayCursor(20, 20); await state.value.pointerMove(20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse3, down: true }, 20, 20);
    expect(state.cvars.get("selected")?.value).toBe("default");
    expect(state.cvars.get("selected")?.latchedValue).toBeUndefined();
    expect(actionValues).toEqual(["default"]);
    state.value.dispose();
  });

  test("Script_Exec formats a NULL allocated argument with the source bg_lib string formatter", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    pool.stringAlloc("exec");
    const definitions = await parse("menuDef { name main itemDef { name trigger action { exec unavailable } } }", { kind: "qvm32", memory: pool });
    const state = await runtimeFromDefinitions(definitions);
    pool.stringAlloc("x".repeat(384 * 1024 - pool.stringBytes - 2));
    await state.value.runItemScript("main", "trigger", requiredScript(definitions.menus[0]?.items[0]?.action));
    expect(state.commands.pendingText).toBe("(null) ; ");
    state.value.dispose();
  });

  test("NULL lookup and picture names qualify the reached source dereference without earlier mutation", async () => {
    for (const [command, message] of [
      ["conditionalopen unavailable first second", "Cvar_VariableValue hashes NULL"],
      ["setbackground unavailable", "RE_RegisterShaderNoMip dereferences NULL"],
    ] satisfies readonly (readonly [string, string])[]) {
      const pool = new TeamArenaUiMemory("qvm32", () => {});
      for (const text of ["conditionalopen", "setbackground"]) pool.stringAlloc(text);
      const definitions = await parse(`menuDef { name main itemDef { name trigger background original action { ${command} } } }
        menuDef { name first } menuDef { name second }`, { kind: "qvm32", memory: pool });
      const state = await runtimeFromDefinitions(definitions);
      await state.value.activate("main");
      const before = state.value.snapshot(), registrations = [...state.resources.registrations];
      pool.stringAlloc("x".repeat(384 * 1024 - pool.stringBytes - 2));
      await expect(state.value.runItemScript("main", "trigger", requiredScript(definitions.menus[0]?.items[0]?.action)))
        .rejects.toThrow(message);
      expect(state.value.snapshot()).toEqual(before);
      expect(state.resources.registrations).toEqual(registrations);
      state.value.dispose();
    }
  });

  test("NULL play names reach the sound bank startup guard before the unsafe name read", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    for (const text of ["play", "setcvar", "done", "yes", ";"]) pool.stringAlloc(text);
    const definitions = await parse(`menuDef { name main itemDef { name trigger action {
      play unavailable ; setcvar done yes
    } } }`, { kind: "qvm32", memory: pool });
    const state = await runtimeFromDefinitions(definitions);
    const unavailable = (): never => { throw new Error("NULL sound name must not reach asset IO or diagnostics"); };
    const bank = new ClientSoundBank({ readFileRetained: unavailable, readFileRetainedSync: unavailable, freeFile: unavailable },
      { print: unavailable, debugPrint: unavailable });
    const names: (string | null)[] = [];
    state.resources.registerSound = async path => { names.push(path); return await bank.registerSound(path, false) ?? undefined; };
    pool.stringAlloc("x".repeat(384 * 1024 - pool.stringBytes - 2));
    bank.setRegistrationEnabled(false);
    await state.value.runItemScript("main", "trigger", requiredScript(definitions.menus[0]?.items[0]?.action));
    expect(names).toEqual([null]);
    expect(state.audio.local).toEqual([undefined]);
    expect(state.cvars.get("done")?.value).toBe("yes");
    state.cvars.set("done", "no", true); bank.setRegistrationEnabled(true);
    await expect(state.value.runItemScript("main", "trigger", requiredScript(definitions.menus[0]?.items[0]?.action)))
      .rejects.toThrow("S_RegisterSound dereferences NULL");
    expect(names).toEqual([null, null]);
    expect(state.audio.local).toEqual([undefined]);
    expect(state.cvars.get("done")?.value).toBe("no");
    state.value.dispose();
  });

  test("a successful NULL open operand still clears focus and closes actual cinematics without matching unnamed menus", async () => {
    for (const command of ["open missing", "conditionalopen gate missing other"]) {
      const pool = new TeamArenaUiMemory("qvm32", () => {});
      pool.stringAlloc("open"); pool.stringAlloc("conditionalopen"); pool.stringAlloc("gate");
      const definitions = await parse(`menuDef { name main rect 0 0 640 480 style 5 cinematic "video/intro.roq"
        itemDef { name target action { ${command} } }
      } menuDef { }`, { kind: "qvm32", memory: pool });
      const state = await runtimeFromDefinitions(definitions);
      await state.value.activate("main");
      await state.value.frame({ time: 0, frameTime: 0, draw: draw2D() });
      expect(state.value.snapshot().focusedMenu).toBe("main");
      expect(state.cinema.played).toHaveLength(1);
      pool.stringAlloc("x".repeat(384 * 1024 - pool.stringBytes - 2));
      await state.value.runItemScript("main", "target", requiredScript(definitions.menus[0]?.items[0]?.action));
      expect(state.value.snapshot().menus.every(menu => (menu.flags & UiWindowFlag.HasFocus) === 0)).toBe(true);
      expect(state.cinema.stopped).toEqual([requiredValue(state.cinema.played[0], "played cinematic").handle.index]);
      expect(state.value.snapshot().menus[1]?.flags).toBe(0);
      state.value.dispose();
    }
  });

  test("zero-sized list elements reach source QVM conversions during pointer selection", async () => {
    const state = await runtime(`menuDef { name main rect 0 0 300 200 itemDef {
      name list type 6 rect 10 10 100 100 visible 1 elementwidth 0 elementheight 0 feeder 1
    } }`);
    await state.value.activate("main");
    state.value.setDisplayCursor(20, 60);
    await state.value.pointerMove(20, 60);
    const list = state.definitions.menus[0]?.items[0]?.listData();
    expect(list?.cursorPosition).toBe(-2147483648);
    expect(list?.startPosition).toBe(0);
    state.value.dispose();
  });

  test("Window_Paint draws its debug outline before the empty-style early return", async () => {
    const state = await runtime("menuDef { name main rect 0 0 20 20 }");
    await state.value.activate("main");
    state.cvars.set("developer", "1");
    await state.value.handleKey({ kind: "key", code: KeyCode.F11, down: true }, 1, 1);
    const draw = draw2D();
    await state.value.frame({ time: 0, frameTime: 0, draw });
    const colors = consumedBatches(draw).slice(0, 8).map(batch => batch.vertices[0]?.color);
    expect(colors).toEqual([...Array.from({ length: 4 }, () => ({ x: 1, y: 1, z: 1, w: 1 })),
      ...Array.from({ length: 4 }, () => ({ x: 1, y: 0, z: 1, w: 1 }))]);
    state.value.dispose();
  });

  test("window fills and all solid border paths use the caller-owned white shader picture", async () => {
    const texture = publishTexture(graphics.images, { name: "owned/white", width: 1, height: 1, pixels: new Uint8Array([64, 128, 192, 255]),
      internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 });
    const ownedWhite: PictureAsset = { kind: "image", name: "observable-owned-white", state: UI_PICTURE_STATE,
      color: { rgb: "vertex", alpha: "vertex" }, texture: { kind: "bind-image", image: texture } };
    // A later real registration makes the first owned-white draw bind its image;
    // latest-upload cache/actual-zero behavior is tested separately.
    publishTexture(graphics.images, { name: "registration-after-owned-white", width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]),
      internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 });
    for (const profile of ["ui", "cgame"] satisfies readonly FontSet["profile"][]) {
      for (const border of [1, 2, 3]) {
        const definitions = await parse(`menuDef { name owned rect 0 0 20 20 visible 1 style 1
          backcolor 1 1 1 1 border ${border} bordersize 2 bordercolor 1 1 1 1 }`);
        const state = await runtimeFromDefinitions(definitions, new CvarRegistry(), new ResourceTrace(), ownedWhite, profile);
        const draw = draw2D();
        await state.value.frame({ time: 0, frameTime: 0, draw });
        const batches = consumedBatches(draw);
        expect(batches.length).toBeGreaterThan(1);
        expect(batches.every(batch => batch.texture.kind === "bind-image" && batch.texture.image === texture)).toBe(true);
        const edges = batches.slice(1).map(batch => {
          const xs = batch.vertices.map(vertex => (vertex.position.x + 1) * 320), ys = batch.vertices.map(vertex => (1 - vertex.position.y) * 240);
          return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
        });
        const size = 2;
        const horizontal = [[0, 0, 20, size], [0, 20 - size, 20, size]];
        const vertical = [[0, 0, size, 20], [20 - size, 0, size, 20]];
        const expected = border === 1 ? [...horizontal, ...vertical] : border === 2 ? horizontal : vertical;
        expect(edges).toHaveLength(expected.length);
        expected.forEach((edge, index) => edge.forEach((component, axis) => {
          expect(edges[index]?.[axis]).toBeCloseTo(component, 4);
        }));
        const cpu = graphics.cpu;
        expect(Array.from(cpu.pixels.subarray((10 * 640 + 10) * 4, (10 * 640 + 10) * 4 + 4))).toEqual([64, 128, 192, 255]);
        state.value.dispose();
      }
    }
  });

  test("conditionalopen uses the selected product cvar-value callback and its 128-byte copy", async () => {
    for (const profile of ["ui", "cgame"]) {
      const definitions = await parse(`menuDef { name main itemDef { name trigger action { conditionalopen gate yes no } } }
        menuDef { name yes } menuDef { name no }`);
      const cvars = new CvarRegistry();
      cvars.set("gate", " ".repeat(127) + "1");
      expect(cvars.get("gate")?.numericValue).toBe(1);
      const read = (name: string): number => profile === "ui" ? cvars.get(name)?.numericValue ?? 0
        : gameAtof(cvars.get(name)?.value.slice(0, 127) ?? "");
      const state = await runtimeFromDefinitions(definitions, cvars, new ResourceTrace(), whitePicture, "ui", () => {}, read);
      await state.value.runItemScript("main", "trigger", requiredScript(definitions.menus[0]?.items[0]?.action));
      expect(state.value.snapshot().focusedMenu).toBe(profile === "ui" ? "yes" : "no");
      state.value.dispose();
    }
  });

  test("runs source shared and product scripts with exact command-buffer and activation traces", async () => {
    const state = await runtime(`
      assetGlobalDef { itemFocusSound "sound/focus" }
      menuDef { name main visible 1 soundLoop "sound/menu" onOpen {
        setcvar opened yes ; exec "echo ready" ; uiScript update profile ; open overlay ;
      } itemDef { name trigger visible 1 action {
        setplayermodel sarge ; setplayerhead visor ; conditionalopen gate enabled disabled ;
        play "sound/click" ; playlooped "sound/loop" ;
      } } }
      menuDef { name overlay onOpen { uiScript overlayOpen } }
      menuDef { name enabled }
      menuDef { name disabled }
    `);
    state.cvars.set("gate", "1");
    state.cvars.register("opened", "no", CvarFlag.ReadOnly | CvarFlag.Latch);

    expect(await state.value.activate("MAIN")).toBe(true);
    expect(state.cvars.get("opened")?.value).toBe("yes");
    expect(state.commands.pendingText).toBe("echo ready ; ");
    expect(state.external.calls).toEqual(["main/:update profile", "overlay/:overlayOpen"]);
    // The outer ActivateByName resumes after nested open and clears the later menu's focus.
    expect(state.value.snapshot().focusedMenu).toBeUndefined();
    expect(state.value.snapshot().openStack).toEqual(["main"]);

    const main = state.definitions.menus[0];
    const action = main?.items[0]?.action;
    await state.value.runItemScript("main", "trigger", requiredScript(action));
    expect(state.cvars.get("team_model")?.value).toBe("sarge");
    expect(state.cvars.get("team_headmodel")?.value).toBe("visor");
    expect(state.value.snapshot().focusedMenu).toBe("enabled");
    expect(state.audio.local).toHaveLength(1);
    expect(state.audio.started).toHaveLength(2);
    expect(state.audio.events).toEqual(["start:sound/menu", "stop", "start:sound/loop"]);
    expect(state.resources.sounds.sort()).toEqual(["sound/click", "sound/focus"].sort());
  });

  test("first playLooped stops the global PCM stream while menu activation preserves queued raw samples", async () => {
    const state = await runtime(`menuDef { name main soundLoop "music/menu" itemDef {
      name trigger action { playlooped "music/script" }
    } itemDef { name missing action { playlooped } } }`);
    const mixer = new AudioMixer(22050, () => 0);
    const pcm: PcmSound = { sampleRate: 22050, channels: 1, samples: new Int16Array([100, 200, 300, 400]),
      frameCount: 4, loopStart: null };
    const fixture = await musicFiles(new Map([
      ["music/engine.wav", pcm], ["music/script.wav", pcm], ["music/menu.wav", pcm],
    ]));
    const music = new BackgroundMusic(() => mixer, () => fixture.files, () => {});
    const trace: string[] = [];
    state.audio.startBackground = async path => { trace.push(`start:${path}:${mixer.rawEnd}`); await music.start(path, path); };
    state.audio.stopBackground = () => { trace.push("stop"); music.stop(); };
    try {
      // An engine/cgame stream already exists before this UI starts any music.
      await music.start("music/engine", "music/engine"); music.update();
      const queued = mixer.rawEnd;
      expect(queued).toBeGreaterThan(0);
      await state.value.runItemScript("main", "missing", requiredScript(state.definitions.menus[0]?.items[1]?.action));
      expect(trace).toEqual([]); expect(mixer.rawEnd).toBe(queued);
      await state.value.runItemScript("main", "trigger", requiredScript(state.definitions.menus[0]?.items[0]?.action));
      expect(trace).toEqual(["stop", "start:music/script:0"]);
      expect(music.loopName).toBe("music/script"); expect(mixer.rawEnd).toBe(0);
      music.update(); expect(mixer.rawEnd).toBe(queued);
      await state.value.activate("main");
      expect(trace).toEqual(["stop", "start:music/script:0", `start:music/menu:${queued}`]);
      expect(music.loopName).toBe("music/menu"); expect(mixer.rawEnd).toBe(queued);
      state.value.retire(); state.value.dispose();
      expect(music.isPlaying).toBe(true); expect(mixer.rawEnd).toBe(queued);
    } finally { state.value.retire(); music.stop(); await fixture.close(); }
  });

  test("NULL playLooped operands stop global music and reach the owner's empty-intro return", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    for (const text of ["playlooped", "setcvar", "done", "yes", ";"]) pool.stringAlloc(text);
    const definitions = await parse(`menuDef { name main itemDef { name trigger action { playlooped newMusic ; setcvar done yes } } }`,
      { kind: "qvm32", memory: pool });
    const state = await runtimeFromDefinitions(definitions);
    const mixer = new AudioMixer(22050, () => 0);
    const pcm: PcmSound = { sampleRate: 22050, channels: 1, samples: new Int16Array([100, 200, 300, 400]),
      frameCount: 4, loopStart: null };
    const fixture = await musicFiles(new Map([["music/retained.wav", pcm]]));
    let fileReadsAllowed = true, mixerReads = 0;
    const music = new BackgroundMusic(() => { mixerReads++; return mixer; },
      () => {
        if (!fileReadsAllowed) throw new Error("empty intro must not read files");
        return fixture.files;
      }, () => { if (!fileReadsAllowed) throw new Error("empty intro must not print a load warning"); });
    const trace: (string | null)[] = [];
    state.audio.startBackground = async path => { trace.push(path); music.start(path, path); };
    state.audio.stopBackground = () => { trace.push("stop"); music.stop(); fileReadsAllowed = false; };
    try {
      music.start("music/retained", "music/retained"); music.update();
      expect(music.isPlaying).toBe(true); expect(mixer.rawEnd).toBeGreaterThan(0);
      const priorMixerReads = mixerReads;
      pool.stringAlloc("x".repeat(384 * 1024 - pool.stringBytes - 2));
      await state.value.runItemScript("main", "trigger", requiredScript(definitions.menus[0]?.items[0]?.action));
      expect(trace).toEqual(["stop", null]);
      expect(music.isPlaying).toBe(false); expect(mixer.rawEnd).toBe(0);
      expect(mixerReads).toBe(priorMixerReads + 1);
      expect(music.loopName).toBe("music/retained");
      expect(state.cvars.get("done")?.value).toBe("yes");
    } finally { state.value.retire(); fileReadsAllowed = true; music.stop(); await fixture.close(); }
  });

  test("managed retirement never calls movie, owner-draw or audio services and invalidates subsequent operations", async () => {
    const state = await runtime(`menuDef { name media rect 0 0 640 480 style 5 cinematic "video/intro.roq" soundLoop "music/menu"
      itemDef { name owner ownerdraw 9 rect 10 10 100 20 visible 1 }
    }`);
    await state.value.activate("media");
    await state.value.frame({ time: 10, frameTime: 10, draw: draw2D() });
    expect(state.cinema.played).toHaveLength(1);
    const ownerCalls = state.owner.closed.length;
    const retiredCallback = (): never => { throw new Error("callback into retired engine operation"); };
    state.cinema.stop = retiredCallback; state.owner.closeCinematic = retiredCallback; state.audio.stopBackground = retiredCallback;
    state.value.retire(); state.value.retire(); state.value.dispose();
    expect(state.cinema.stopped).toEqual([]); expect(state.owner.closed).toHaveLength(ownerCalls);
    expect(state.audio.events).toEqual(["start:music/menu"]);
    expect(() => state.value.snapshot()).toThrow("disposed");
    await expect(state.value.activate("media")).rejects.toThrow("disposed");
  });

  test("group scripts mutate the published item records while explicit snapshots stay unchanged", async () => {
    const state = await runtime(`menuDef { name main rect 10 20 200 100 visible 1
      itemDef { name first group pair rect 1 2 10 10 visible 1 leaveFocus { uiScript leaveFirst } }
      itemDef { name second group pair rect 3 4 10 10 visible 1 leaveFocus { uiScript leaveSecond }
        action { hide pair ; show second ; fadein pair ; setitemcolor pair forecolor .1 .2 .3 .4 ;
          setfocus second ; transition pair 1 2 3 4 11 12 13 14 100 2 ; orbit first 7 8 30 40 50 ; }
      }
    }`);
    const window = requiredValue(state.definitions.menus[0]?.items[0]?.window, "first window");
    const original = { ...window.rect };
    const script = state.definitions.menus[0]?.items[1]?.action;
    await state.value.runItemScript("main", "second", requiredScript(script));
    const items = state.value.snapshot().menus[0]?.items;

    expect(state.external.calls).toEqual(["main/first:leaveFirst", "main/second:leaveSecond"]);
    expect(items?.map(item => item.flags & UiWindowFlag.HasFocus)).toEqual([0, UiWindowFlag.HasFocus]);
    expect(items?.map(item => item.flags & UiWindowFlag.FadingIn)).toEqual([UiWindowFlag.FadingIn, UiWindowFlag.FadingIn]);
    expect(items?.map(item => item.foreColor)).toEqual([
      { x: Math.fround(.1), y: Math.fround(.2), z: Math.fround(.3), w: Math.fround(.4) },
      { x: Math.fround(.1), y: Math.fround(.2), z: Math.fround(.3), w: Math.fround(.4) },
    ]);
    expect(items?.[0]?.clientRect).toEqual({ x: 7, y: 8, width: 3, height: 4 });
    expect(items?.[0]?.rect).toEqual({ x: 17, y: 28, width: 3, height: 4 });
    expect(window.rect).toEqual(requiredValue(items?.[0], "first item snapshot").rect);
    expect(original).toEqual({ x: 11, y: 22, width: 10, height: 10 });
  });

  test("implements enable/disable/show/hide cvar lists with source case folding and missing defaults", async () => {
    const cvars = new CvarRegistry();
    cvars.set("mode", "BETA");
    const state = await runtime(`menuDef { name rules
      itemDef { name enabled cvarTest mode enableCvar { alpha ; beta } }
      itemDef { name disabled cvarTest mode disableCvar { beta } }
      itemDef { name shown cvarTest mode showCvar { BETA } }
      itemDef { name hidden cvarTest mode hideCvar { beta } }
      itemDef { name missing cvarTest absent enableCvar { "" } }
    }`, cvars);
    const items = state.value.snapshot().menus[0]?.items;
    expect(items?.map(item => [item.enabled, item.shown])).toEqual([
      [true, true], [false, true], [true, true], [true, false], [false, true],
    ]);
  });

  test("preserves duplicate activation and first-close source stack behavior", async () => {
    const state = await runtime(`
      menuDef { name prior visible 1 }
      menuDef { name duplicate onOpen { uiScript first } onClose { uiScript closeFirst } }
      menuDef { name DUPLICATE onOpen { uiScript second } onClose { uiScript closeSecond } }
    `);
    expect(await state.value.show("prior")).toBe(true);
    expect(await state.value.activate("duplicate")).toBe(true);
    const snapshot = state.value.snapshot();
    expect(snapshot.menus.map(menu => (menu.flags & UiWindowFlag.HasFocus) !== 0)).toEqual([false, true, true]);
    expect(snapshot.openStack).toEqual(["prior", "prior"]);
    expect(state.external.calls).toEqual(["duplicate/:first", "DUPLICATE/:second"]);
    await state.value.close("DUPLICATE");
    expect(state.external.calls).toEqual(["duplicate/:first", "DUPLICATE/:second", "duplicate/:closeFirst"]);
    expect(state.value.snapshot().menus.map(menu => (menu.flags & UiWindowFlag.Visible) !== 0)).toEqual([true, false, true]);
  });

  test("transition differences convert to signed int before QVM abs and float division", async () => {
    const state = await runtime(`menuDef { name main itemDef { name x action {
      transition x 0 0 0 0 "-2147483800" 2147483800 0 "-3.75" 10 2
    } } }`);
    await state.value.runItemScript("main", "x", requiredScript(state.definitions.menus[0]?.items[0]?.action));
    const effects = state.definitions.menus[0]?.items[0]?.window.rectEffects2;
    expect(effects?.x).toBe(-1073741824); expect(effects?.y).toBe(-1073741824);
    expect(effects?.width).toBe(0); expect(effects?.height).toBe(1.5);
    state.value.dispose();
  });

  test("finite onOpen chains exceed 32 scripts before the source open-stack limit applies", async () => {
    const memory = new TeamArenaUiMemory("qvm32", () => {});
    const source = Array.from({ length: 33 }, (_, index) => `menuDef { name m${index} onOpen {
      ${index === 32 ? "setcvar reached 1" : `open m${index + 1}`}
    } }`).join("\n");
    const definitions = await parse(source, { kind: "qvm32", memory });
    const state = await runtimeFromDefinitions(definitions);
    try {
      expect(definitions.menus).toHaveLength(33);
      for (const menu of definitions.menus) {
        const script = requiredScript(menu.onOpen);
        expect(script.truncated).toBe(false);
        expect(script.text.length).toBeLessThanOrEqual(1023);
      }
      expect(await state.value.activate("m0")).toBe(true);
      expect(state.cvars.get("reached")?.value).toBe("1");
      expect(state.value.snapshot().openStack).toEqual(Array.from({ length: 16 }, (_, index) => `m${31 - index}`));
    } finally { state.value.dispose(); }
  });

  test("finite shared-menu scripts consume more than 65536 tokens within source script buffers", async () => {
    const memory = new TeamArenaUiMemory("qvm32", () => {});
    const source = `menuDef { name root onOpen { ${"open branch ".repeat(16)} setcvar completed 1 } }
      menuDef { name branch onOpen { ${"open leaf ".repeat(32)} } }
      menuDef { name leaf onOpen { ${Array.from({ length: 64 }, (_, index) => `setcvar x ${index % 2}`).join(" ")} } }`;
    const definitions = await parse(source, { kind: "qvm32", memory });
    const state = await runtimeFromDefinitions(definitions);
    try {
      for (const menu of definitions.menus) {
        const script = requiredScript(menu.onOpen);
        expect(script.truncated).toBe(false);
        expect(script.text.length).toBeLessThanOrEqual(1023);
      }
      const initial = state.cvars.set("x", "-1").modificationCount;
      expect(await state.value.activate("root")).toBe(true);
      expect(state.cvars.get("x")?.modificationCount).toBe(initial + 16 * 32 * 64);
      expect(state.cvars.get("x")?.value).toBe("1");
      expect(state.cvars.get("completed")?.value).toBe("1");
      expect(state.value.snapshot().openStack).toHaveLength(16);
    } finally { state.value.dispose(); }
  });

  test("preserves source zero transition division and leaves global music on disposal", async () => {
    const state = await runtime(`menuDef { name main soundLoop a itemDef { name x action {
      transition x 0 0 1 1 2 0 3 1 10 0 ; setcvar reached yes
    } } }`);
    await state.value.activate("main");
    const action = state.definitions.menus[0]?.items[0]?.action;
    await state.value.runItemScript("main", "x", requiredScript(action));
    const effects = state.definitions.menus[0]?.items[0]?.window.rectEffects2;
    expect(effects?.x).toBe(Infinity); expect(effects?.y).toBeNaN();
    expect(effects?.width).toBe(Infinity); expect(effects?.height).toBeNaN();
    expect(state.cvars.get("reached")?.value).toBe("yes");
    state.value.dispose();
    state.value.dispose();
    expect(state.audio.events).toEqual(["start:a"]);
    expect(() => state.value.snapshot()).toThrow("disposed");

    const noProgress = await runtime(`menuDef { name main onOpen { uiScript command } }`);
    const stuck = await UiRuntime.create({
      definitions: noProgress.definitions,
      cvars: noProgress.cvars,
      commands: noProgress.commands,
      resources: noProgress.resources,
      fonts,
      widgetAssets,
      zeroPicture: picture,
      audio: noProgress.audio,
      cinematics: noProgress.cinema,
      paintModel: (): void => {},
      context: { kind: "ui", bindings: noProgress.bindings, pause: (): void => {} },
      feeder: noProgress.feeder,
      ownerDraw: noProgress.owner,
      externalScript: { run: (): void => {} },
      getTeamColor: () => ({ x: 0, y: 0, z: 0, w: 1 }),
    });
    expect(await stuck.activate("main")).toBe(true);
  });

  test("moves only maxChars bytes in the source edit buffer and retains a cursor beyond a shortened cvar", async () => {
    const state = await runtime(`menuDef { name editing rect 0 0 300 200
      itemDef { name limited type 4 rect 10 10 120 20 visible 1 cvar limited maxChars 3 }
      itemDef { name stale type 4 rect 10 50 120 20 visible 1 cvar stale }
    }`);
    state.cvars.set("limited", "abcdef");
    state.cvars.set("stale", "abcdef");
    await state.value.activate("editing");
    state.value.setDisplayCursor(20, 20);
    await state.value.pointerMove(20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.End, down: true }, 20, 20);
    await state.value.handleKey({ kind: "character", code: 8 }, 20, 20);
    expect(state.cvars.get("limited")?.value).toBe("abddef");
    state.cvars.set("limited", "abcdef");
    await state.value.handleKey({ kind: "key", code: KeyCode.Home, down: true }, 20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Delete, down: true }, 20, 20);
    expect(state.cvars.get("limited")?.value).toBe("bcddef");
    await state.value.handleKey({ kind: "key", code: KeyCode.Enter, down: true }, 20, 20);
    state.value.setDisplayCursor(20, 60);
    await state.value.pointerMove(20, 60);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 20, 60);
    await state.value.handleKey({ kind: "key", code: KeyCode.End, down: true }, 20, 60);
    state.cvars.set("stale", "a");
    await state.value.handleKey({ kind: "character", code: 90 }, 20, 60);
    expect(state.cvars.get("stale")?.value).toBe("a");
    expect(state.value.snapshot().menus[0]?.items[1]?.cursorPosition).toBe(6);
    await state.value.handleKey({ kind: "key", code: KeyCode.Left, down: true }, 20, 60);
    expect(state.value.snapshot().menus[0]?.items[1]?.cursorPosition).toBe(5);
  });

  test("edit publication rereads its cvar after overstrike callbacks and guards null only at the source read", async () => {
    for (const mutation of ["second", "null-after-read", "null-after-overstrike"]) {
      const pool = new TeamArenaUiMemory("qvm32", () => {});
      const definitions = await parse(`menuDef { name main rect 0 0 640 480 itemDef {
        name edit type 4 rect 10 10 120 20 visible 1 cvar first maxChars 20
      } }`, { kind: "qvm32", memory: pool });
      const item = requiredValue(definitions.menus[0]?.items[0], "mutable edit");
      const record = pool.borrow(requiredValue(item.allocationOffset, "mutable edit offset"), 540);
      const state = await runtimeFromDefinitions(definitions);
      state.cvars.set("first", "abc"); state.cvars.set("second", "xyz");
      await state.value.activate("main");
      state.value.setDisplayCursor(20, 20); await state.value.pointerMove(20, 20);
      await state.value.handleKey({ kind: "key", code: KeyCode.Enter, down: true }, 20, 20);
      let overstrikeCalls = 0;
      state.bindings.getOverstrike = () => {
        overstrikeCalls++;
        record.setString(264, mutation === "second" ? "second" : undefined);
        return true;
      };
      const get = state.cvars.get.bind(state.cvars);
      if (mutation === "null-after-read") state.cvars.get = name => {
        const result = get(name); if (name === "first") record.setString(264, undefined); return result;
      };
      await state.value.handleKey({ kind: "character", code: 65 }, 20, 20);
      expect(get("first")?.value).toBe("abc");
      expect(get("second")?.value).toBe(mutation === "second" ? "Abc" : "xyz");
      expect(get("BADNAME")?.value).toBe(mutation === "null-after-overstrike" ? "Abc" : undefined);
      expect(overstrikeCalls).toBe(mutation === "null-after-read" ? 0 : 1);
      expect(item.cursorPosition).toBe(mutation === "null-after-read" ? 0 : 1);
      state.value.dispose();
    }
  });

  test("drives real cvars through yes-no, multi, slider and numeric edit input", async () => {
    const state = await runtime(`menuDef { name controls rect 0 0 640 480
      itemDef { name yes type 11 rect 10 10 100 20 visible 1 cvar yes action { uiScript yesAction } }
      itemDef { name multi type 12 rect 10 40 100 20 visible 1 cvar mode cvarStrList { A , alpha B , beta } }
      itemDef { name slider type 10 rect 10 70 120 20 visible 1 cvarFloat volume 0 0 10 }
      itemDef { name number type 9 rect 10 100 120 20 visible 1 cvar number maxChars 4 maxPaintChars 2 }
    }`);
    state.cvars.register("yes", "0", CvarFlag.ReadOnly);
    state.cvars.register("mode", "alpha", CvarFlag.ReadOnly);
    state.cvars.register("volume", "0", CvarFlag.Latch);
    state.cvars.register("number", "12", CvarFlag.ReadOnly);
    await state.value.activate("controls");

    state.value.setDisplayCursor(20, 20);
    await state.value.pointerMove(20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 20, 20);
    expect(state.cvars.get("yes")?.value).toBe("1");
    expect(state.external.calls).toEqual(["controls/yes:yesAction"]);

    state.value.setDisplayCursor(20, 50);
    await state.value.pointerMove(20, 50);
    await state.value.handleKey({ kind: "key", code: KeyCode.Enter, down: true }, 20, 50);
    expect(state.cvars.get("mode")?.value).toBe("beta");

    state.value.setDisplayCursor(58, 80);
    await state.value.pointerMove(58, 80);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 58, 80);
    expect(state.cvars.get("volume")?.value).toBe("5.000000");

    state.value.setDisplayCursor(20, 110);
    await state.value.pointerMove(20, 110);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 20, 110);
    expect(state.bindings.overstrike).toBe(true);
    await state.value.handleKey({ kind: "character", code: 57 }, 20, 110);
    expect(state.cvars.get("number")?.value).toBe("92");
    await state.value.handleKey({ kind: "character", code: 46 }, 20, 110);
    expect(state.cvars.get("number")?.value).toBe("92");
  });

  test("keeps Display_MouseMove coordinates separate from the lagging display-context cursor", async () => {
    const state = await runtime(`menuDef { name lag rect 0 0 200 100 itemDef {
      name toggle type 11 rect 10 10 100 20 visible 1 cvar enabled
    } }`);
    state.cvars.set("enabled", "0");
    await state.value.activate("lag");

    await state.value.pointerMove(20, 20);
    expect(firstRuntimeItem(state.value).flags & UiWindowFlag.HasFocus).toBe(UiWindowFlag.HasFocus);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 20, 20);
    expect(state.cvars.get("enabled")?.value).toBe("0");

    state.value.setDisplayCursor(20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 20, 20);
    expect(state.cvars.get("enabled")?.value).toBe("1");
  });

  test("preserves the distinct source zero-handle rules for pointer focus and scripted setfocus", async () => {
    const pointerResources = new ResourceTrace();
    pointerResources.missingSounds.add("sound/item-missing");
    const pointerDefinitions = await parse(`assetGlobalDef { itemFocusSound "sound/global" }
      menuDef { name pointer rect 0 0 200 100 itemDef {
        name target type 11 rect 10 10 100 20 visible 1 focusSound "sound/item-missing"
      } }`);
    const pointer = await runtimeFromDefinitions(pointerDefinitions, new CvarRegistry(), pointerResources);
    await pointer.value.activate("pointer");
    await pointer.value.pointerMove(20, 20);
    expect(pointer.audio.local).toEqual([pointerResources.soundValues.get("sound/global")]);

    const scriptResources = new ResourceTrace();
    scriptResources.missingSounds.add("sound/global-missing");
    const scriptDefinitions = await parse(`assetGlobalDef { itemFocusSound "sound/global-missing" }
      menuDef { name scripted itemDef { name trigger action { setfocus target } }
        itemDef { name target visible 1 focusSound "sound/item" }
      }`);
    const scripted = await runtimeFromDefinitions(scriptDefinitions, new CvarRegistry(), scriptResources);
    const action = scriptDefinitions.menus[0]?.items[0]?.action;
    await scripted.value.runItemScript("scripted", "trigger", requiredScript(action));
    expect(scripted.audio.local).toEqual([]);
  });

  test("selects list feeders, fires source double-click timing, and converts zero geometry through QVM arithmetic", async () => {
    const state = await runtime(`menuDef { name lists rect 0 0 640 480
      itemDef { name list type 6 rect 10 10 120 80 visible 1 feeder 7 elementwidth 32 elementheight 16
        doubleClick { uiScript double } action { uiScript changed } }
      itemDef { name harmless type 6 rect 200 10 100 50 visible 1 feeder 9 }
    }`);
    await state.value.activate("lists");
    state.value.setDisplayCursor(20, 35);
    await state.value.pointerMove(20, 35);
    await state.value.handleKey({ kind: "key", code: KeyCode.Down, down: true }, 20, 35);
    expect(state.feeder.selections).toEqual(["7:1"]);
    expect(state.external.calls).toEqual(["lists/list:changed"]);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 20, 35);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 20, 35);
    expect(state.external.calls).toEqual(["lists/list:changed", "lists/list:changed", "lists/list:double", "lists/list:changed"]);

    expect(state.value.snapshot().menus[0]?.items[1]?.behavior.kind).toBe("list-box");
    await state.value.pointerMove(210, 20);
    const zeroSize = state.value.snapshot().menus[0]?.items[1]?.behavior;
    expect(zeroSize?.kind === "list-box" ? zeroSize.cursorPosition : undefined).toBe(-2147483648);
  });

  test("uses the source feeder image callback instead of the text-column callback", async () => {
    const state = await runtime(`menuDef { name images rect 0 0 640 480 itemDef {
      name list type 6 rect 10 10 120 80 visible 1 feeder 7 elementwidth 32 elementheight 16 elementtype 1
    } }`);
    state.feeder.itemValue = { text: "wrong", picture };
    await state.value.activate("images");
    await state.value.frame({ time: 0, frameTime: 0, draw: draw2D() });
    expect(state.feeder.imageCalls).toContain("7:0");
    expect(state.feeder.itemCalls).toEqual([]);
    const list = state.value.snapshot().menus[0]?.items[0]?.behavior;
    expect(list?.kind === "list-box" ? list.endPosition : undefined).toBe(2);
  });

  for (const horizontal of [true, false]) {
    test(`list paint converts ${horizontal ? "horizontal" : "vertical"} floating draw padding with source OP_CVFI`, async () => {
      const pool = new TeamArenaUiMemory("qvm32", () => {});
      const definitions = await parse(`menuDef { name main rect 0 0 640 480 itemDef {
        name list type 6 rect 10 10 120 80 visible 1 feeder 7 elementwidth 3000000000.0 elementheight 16 elementtype 1
        ${horizontal ? "horizontalscroll" : ""}
      } }`, { kind: "qvm32", memory: pool });
      const list = requiredValue(definitions.menus[0]?.items[0]?.listData(), "oversized image list");
      const state = await runtimeFromDefinitions(definitions);
      state.feeder.count = () => 3;
      await state.value.paintNamed("main", { time: 0, frameTime: 0, draw: draw2D() }, true);
      expect(state.feeder.imageCalls).toEqual(["7:0"]);
      expect(list.drawPadding).toBe(-2147483648);
      expect(list.endPosition).toBe(horizontal ? 0 : 1);
      state.value.dispose();
    });
  }

  test("vertical list paint retains the source outer image/text branch across feeder mutations", async () => {
    for (const initialStyle of [1, 0]) {
      const pool = new TeamArenaUiMemory("qvm32", () => {});
      const definitions = await parse(`menuDef { name main rect 0 0 640 480 itemDef {
        name list type 6 rect 10 10 120 80 visible 1 feeder 7 elementwidth 32 elementheight 16 elementtype ${initialStyle}
      } }`, { kind: "qvm32", memory: pool });
      const item = requiredValue(definitions.menus[0]?.items[0], "mutable list");
      const list = requiredValue(item.listData(), "mutable list data");
      const record = pool.borrow(requiredValue(item.allocationOffset, "mutable list offset"), 540);
      const retained = requiredValue(record.getAllocationPointer(536), "mutable list allocation").dereference(232);
      const state = await runtimeFromDefinitions(definitions), calls: string[] = [];
      state.feeder.count = () => 3;
      state.feeder.image = () => { calls.push("image"); retained.setInt32(24, 1 - initialStyle); return undefined; };
      state.feeder.item = () => { calls.push("text"); retained.setInt32(24, 1 - initialStyle); return undefined; };
      await state.value.paintNamed("main", { time: 0, frameTime: 0, draw: draw2D() }, true);
      expect(calls).toEqual(initialStyle === 1 ? ["image", "image"] : ["text", "text", "text"]);
      expect(list.endPosition).toBe(initialStyle === 1 ? 2 : 3);
      expect(list.drawPadding).toBe(initialStyle === 1 ? 2 : 0);
      expect(list.elementStyle).toBe(1 - initialStyle);
      state.value.dispose();
    }
  });

  test("keeps binding state per runtime and reproduces escape/backspace/restart ordering", async () => {
    const state = await runtime(`menuDef { name binds rect 0 0 640 480 focuscolor 1 1 1 1
      itemDef { name attack type 13 rect 10 10 120 20 visible 1 cvar "+attack" }
    }`);
    await state.value.activate("binds");
    state.value.setDisplayCursor(20, 20);
    await state.value.pointerMove(20, 20);
    await state.value.handleKey({ kind: "character", code: KeyCode.Enter }, 20, 20);
    expect(state.value.bindingPending()).toBe(false);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 20, 20);
    expect(state.value.bindingPending()).toBe(true);
    await state.value.handleKey({ kind: "character", code: KeyCode.Escape }, 20, 20);
    expect(state.value.bindingPending()).toBe(true);
    const bindDraw = draw2D();
    await state.value.frame({ time: 0, frameTime: 0, draw: bindDraw });
    const bindVertex = consumedBatches(bindDraw)[0]?.vertices[0];
    expect(bindVertex?.color).toEqual({ x: 229 / 255, y: 127 / 255, z: 127 / 255, w: 229 / 255 });
    await state.value.handleKey({ kind: "character", code: 120 }, 20, 20);
    expect(state.value.bindingPending()).toBe(true);
    state.value.setDisplayCursor(300, 300);
    await state.value.pointerMove(300, 300);
    await state.value.handleKey({ kind: "key", code: 70, down: true }, 300, 300);
    expect(state.value.bindingPending()).toBe(false);
    expect(state.bindings.values.get(70)).toBe("+attack");
    expect(state.commands.pendingText).toBe("in_restart\n");

    state.value.setDisplayCursor(20, 20);
    await state.value.pointerMove(20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 20, 20);
    state.value.setDisplayCursor(300, 300);
    await state.value.pointerMove(300, 300);
    await state.value.handleKey({ kind: "key", code: KeyCode.Escape, down: true }, 300, 300);
    expect(state.value.bindingPending()).toBe(false);
    state.value.setDisplayCursor(20, 20);
    await state.value.pointerMove(20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 20, 20);
    state.value.setDisplayCursor(300, 300);
    await state.value.pointerMove(300, 300);
    await state.value.handleKey({ kind: "key", code: KeyCode.Backspace, down: true }, 300, 300);
    expect(state.bindings.writes).toEqual(["70:+attack"]);
    expect(state.commands.pendingText).toBe("in_restart\nin_restart\n");
  });

  test("paints a fullscreen retail-style menu into actual Draw2D glyph and picture batches", async () => {
    const state = await runtime(`menuDef { name painted fullscreen 1 background "ui/background" itemDef {
      name label type 1 rect 10 20 100 30 visible 1 text "OK" textscale .55 forecolor 1 1 1 1
    } }`);
    await state.value.activate("painted");
    const draw = draw2D();
    await state.value.frame({ time: 100, frameTime: 16, draw });
    const batches = consumedBatches(draw);
    expect(batches).toHaveLength(3);
    expect(state.resources.pictures).toEqual(["ui/background"]);
    expect(state.value.snapshot().menus[0]?.items[0]?.rect).toEqual({ x: 10, y: 20, width: 100, height: 30 });
  });

  test("uses typed owner-draw, model and cinematic render boundaries without duplicate caches", async () => {
    const state = await runtime(`menuDef { name media rect 0 0 640 480 style 5 cinematic "video/intro.roq"
      itemDef { name owner ownerdraw 9 rect 10 10 100 20 visible 1 special 4 }
      itemDef { name model type 7 rect 20 40 80 80 visible 1 asset_model "models/test.md3" model_fovx 60 model_fovy 50 model_angle 12 model_rotation 5 }
    }`);
    await state.value.activate("media");
    expect(state.owner.closed).toEqual([-9, -9]);
    await state.value.frame({ time: 10, frameTime: 10, draw: draw2D() });
    expect(state.cinema.played).toHaveLength(1);
    expect(state.cinema.runTimes).toEqual([10]);
    expect(state.owner.paints).toHaveLength(1);
    expect(state.owner.paints[0]?.special).toBe(4);
    expect(state.modelPaints).toHaveLength(1);
    expect(state.modelPaints[0]?.angle).toBe(13);
    expect(state.modelPaints[0]?.fieldOfViewX).toBe(60);
    await state.value.activate("media");
    expect(state.cinema.stopped).toEqual([requiredValue(state.cinema.played[0], "played cinematic").handle.index]);
  });

  test("advances list-thumb capture before frame painting and releases it on the next item key", async () => {
    const state = await runtime(`menuDef { name capture rect 0 0 640 480 itemDef {
      name list type 6 rect 10 10 120 80 visible 1 feeder 7 elementwidth 32 elementheight 16
    } }`);
    await state.value.activate("capture");
    await state.value.frame({ time: 0, frameTime: 0, draw: draw2D() });
    state.value.setDisplayCursor(120, 35);
    await state.value.pointerMove(120, 35);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 120, 35);
    state.value.setDisplayCursor(120, 60);
    await state.value.pointerMove(120, 60);
    await state.value.frame({ time: 1, frameTime: 1, draw: draw2D() });
    const behavior = firstRuntimeItem(state.value).behavior;
    if (behavior.kind !== "list-box") throw new Error("expected runtime list state");
    expect(behavior.startPosition).toBe(3);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: false }, 120, 60);
    await state.value.pointerMove(20, 20);
    expect(firstRuntimeItem(state.value).flags & UiWindowFlag.MouseOver).toBe(UiWindowFlag.MouseOver);
  });

  test("advances transition and fade flags with source strict-time comparisons", async () => {
    const state = await runtime(`menuDef { name animated fadeAmount .5 fadeClamp 1 fadeCycle 0 rect 0 0 640 480 itemDef {
      name moving type 1 rect 0 0 20 20 visible 1 forecolor 1 1 1 1 text X action {
        transition moving 0 0 20 20 4 0 20 20 0 2 ; fadeout moving ;
      }
    } }`);
    const action = state.definitions.menus[0]?.items[0]?.action;
    await state.value.runItemScript("animated", "moving", requiredScript(action));
    await state.value.activate("animated");
    await state.value.frame({ time: 1, frameTime: 1, draw: draw2D() });
    expect(firstRuntimeItem(state.value).clientRect.x).toBe(2);
    await state.value.frame({ time: 2, frameTime: 1, draw: draw2D() });
    expect(firstRuntimeItem(state.value).flags & UiWindowFlag.Visible).toBe(UiWindowFlag.Visible);
    await state.value.frame({ time: 3, frameTime: 1, draw: draw2D() });
    expect(firstRuntimeItem(state.value).flags & UiWindowFlag.Visible).toBe(UiWindowFlag.Visible);
    await state.value.frame({ time: 4, frameTime: 1, draw: draw2D() });
    expect(firstRuntimeItem(state.value).flags & UiWindowFlag.Visible).toBe(UiWindowFlag.Visible);
    await state.value.frame({ time: 5, frameTime: 1, draw: draw2D() });
    expect(firstRuntimeItem(state.value).flags & UiWindowFlag.Visible).toBe(0);
  });

  test("orbit preserves transition extents while both effects share the reached timer", async () => {
    const state = await runtime(`menuDef { name effects rect 0 0 640 480 itemDef {
      name moving type 1 rect 0 0 10 12 visible 1 action {
        transition moving 0 0 10 12 100 100 30 32 1 2 ; orbit moving 0 0 100 100 "-1"
      }
    } }`);
    await state.value.runItemScript("effects", "moving", requiredScript(state.definitions.menus[0]?.items[0]?.action));
    await state.value.activate("effects");
    await state.value.frame({ time: 1, frameTime: 1, draw: draw2D() });
    const item = firstRuntimeItem(state.value);
    expect(item.clientRect.width).toBe(20);
    expect(item.clientRect.height).toBe(22);
    expect(item.flags & (UiWindowFlag.Orbiting | UiWindowFlag.InTransition))
      .toBe(UiWindowFlag.Orbiting | UiWindowFlag.InTransition);
    state.value.dispose();
  });

  test("reuses source menu slots across both reset kinds while capture handles stay stable", async () => {
    const cvars = new CvarRegistry();
    cvars.set("persist", "yes");
    const state = await runtime(`
      menuDef { name old rect 0 0 80 80 soundLoop "music/old" }
      menuDef { name top rect 100 0 80 80 }
    `, cvars);
    const captured = state.value.captureMenu(10, 10);
    if (captured === undefined) throw new Error("expected captured source slot");
    await state.value.show("old");
    await state.value.activate("top");

    const replacement = await parse(`menuDef { name replacement rect 20 30 100 100
      itemDef { name retained rect 1 2 10 10 cvarTest persist enableCvar { yes } }
    }`);
    state.value.resetDefinitions("menus");
    expect(state.value.snapshot().menus).toEqual([]);
    expect(captured.definition.window.name).toBe("old");
    await state.value.reloadDefinitions(replacement);
    expect(captured.definition.window.name).toBe("replacement");
    expect(state.value.snapshot().openStack).toEqual(["replacement"]);
    expect(state.value.snapshot().menus[0]?.items[0]?.enabled).toBe(true);
    state.value.moveCapturedMenu(captured, 5, -10);
    expect(state.value.snapshot().menus[0]?.rect).toEqual({ x: 25, y: 20, width: 100, height: 100 });
    expect(state.value.snapshot().menus[0]?.items[0]?.rect).toEqual({ x: 26, y: 22, width: 10, height: 10 });
    expect(state.audio.stops).toBe(0);

    const finalDefinitions = await parse(`menuDef { name final rect 40 50 60 70 }`);
    state.value.resetDefinitions("strings");
    expect(state.value.snapshot().menus).toEqual([]);
    await state.value.reloadDefinitions(finalDefinitions);
    expect(captured.definition.window.name).toBe("final");
    expect(state.value.snapshot().openStack).toEqual([]);
    state.value.moveCapturedMenu(captured, 2, 3);
    expect(state.value.snapshot().menus[0]?.rect).toEqual({ x: 42, y: 53, width: 60, height: 70 });
    expect(state.audio.stops).toBe(0);
  });

  test("preserves Menu_Reset item pointers and reuses their actual allocations after String_Init", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    const source = `menuDef { name capture rect 0 0 640 480 itemDef {
      name list type 6 rect 10 10 120 80 visible 1 feeder 7 elementwidth 32 elementheight 16
    } }`;
    const definitions = await parse(source, { kind: "qvm32", memory: pool });
    const state = await runtimeFromDefinitions(definitions);
    await state.value.activate("capture");
    await state.value.frame({ time: 0, frameTime: 0, draw: draw2D() });
    state.value.setDisplayCursor(120, 35);
    await state.value.pointerMove(120, 35);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 120, 35);

    state.value.resetDefinitions("menus");
    await state.value.reloadDefinitions(await parse(source, { kind: "qvm32", memory: pool }));
    state.value.setDisplayCursor(120, 60);
    await state.value.frame({ time: 1, frameTime: 1, draw: draw2D() });
    const afterMenuReset = firstRuntimeItem(state.value).behavior;
    if (afterMenuReset.kind !== "list-box") throw new Error("expected list state after Menu_Reset");
    expect(afterMenuReset.startPosition).toBe(0);

    state.value.resetDefinitions("strings");
    pool.initializeStrings();
    await state.value.reloadDefinitions(await parse(source, { kind: "qvm32", memory: pool }));
    state.value.setDisplayCursor(120, 70);
    await state.value.frame({ time: 2, frameTime: 1, draw: draw2D() });
    const afterStringInit = firstRuntimeItem(state.value).behavior;
    if (afterStringInit.kind !== "list-box") throw new Error("expected list state after String_Init");
    expect(afterStringInit.startPosition).toBeGreaterThan(0);
  });

  test("rebinds retained edit and bind pointers across String_Init item slots even when their contents change", async () => {
    const definitions = await parse(`menuDef { name inputs rect 0 0 640 480
      itemDef { name edit type 9 rect 10 10 100 20 visible 1 cvar value maxChars 4 }
      itemDef { name bind type 13 rect 10 40 100 20 visible 1 cvar "+attack" }
    }`);
    const state = await runtimeFromDefinitions(definitions);
    state.cvars.set("value", "1");
    await state.value.activate("inputs");
    state.value.setDisplayCursor(20, 20);
    await state.value.pointerMove(20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 20, 20);
    state.value.resetDefinitions("strings");
    await state.value.reloadDefinitions(definitions);
    await state.value.handleKey({ kind: "character", code: 50 }, 20, 20);
    expect(state.cvars.get("value")?.value).toBe("2");
    await state.value.handleKey({ kind: "key", code: KeyCode.Enter, down: true }, 20, 20);
    await state.value.activate("inputs");

    state.value.setDisplayCursor(20, 50);
    await state.value.pointerMove(20, 50);
    expect(state.value.snapshot().menus[0]?.items.map(item => item.flags & UiWindowFlag.HasFocus)).toEqual([0, UiWindowFlag.HasFocus]);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 20, 50);
    expect(state.value.bindingPending()).toBe(true);
    state.value.resetDefinitions("strings");
    await state.value.reloadDefinitions(definitions);
    expect(state.value.bindingPending()).toBe(true);
    expect(await state.value.handleKey({ kind: "key", code: 70, down: true }, 20, 50)).toBe(true);
    expect(state.value.bindingPending()).toBe(false);
    expect(state.bindings.writes).toContain("70:+attack");
    expect(state.bindings.values.get(70)).toBe("+attack");

    await state.value.activate("inputs");
    state.value.setDisplayCursor(20, 20);
    await state.value.pointerMove(20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 20, 20);
    state.value.resetDefinitions("strings");
    await state.value.reloadDefinitions(await parse(`menuDef { name changed rect 0 0 640 480 itemDef {
      name replacement type 11 rect 10 10 100 20 visible 1 cvar other
    } }`));
    await state.value.handleKey({ kind: "character", code: 51 }, 20, 20);
    expect(state.cvars.get("other")?.value).toBe("3");
  });

  test("reuses retained QVM32 item addresses when both their contents and parsed item index change", async () => {
    for (const previousIndex of [0, 1]) {
      const pool = new TeamArenaUiMemory("qvm32", () => {});
      const definitions = await parse(`menuDef {
        itemDef { name first type 9 rect 10 10 100 20 visible 1 cvar first maxChars 4 }
        itemDef { name second type 9 rect 10 50 100 20 visible 1 cvar second maxChars 4 }
        name inputs rect 0 0 640 480
      }`, { kind: "qvm32", memory: pool });
      const offset = requiredValue(definitions.menus[0]?.items[previousIndex]?.allocationOffset, "source item allocation");
      const state = await runtimeFromDefinitions(definitions);
      await state.value.activate("inputs");
      const y = previousIndex === 0 ? 20 : 60;
      state.value.setDisplayCursor(20, y);
      await state.value.pointerMove(20, y);
      await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 20, y);
      state.value.resetDefinitions("strings");
      pool.initializeStrings();
      expect(pool.allocate(offset)).toBe(0);
      const replacement = await parse(`menuDef {
        itemDef { name replacement type 9 rect 10 10 100 20 visible 1 cvar replacement maxChars 4 }
        name changed rect 0 0 640 480
      }`, { kind: "qvm32", memory: pool });
      expect(replacement.menus[0]?.items[0]?.allocationOffset).toBe(offset);
      await state.value.reloadDefinitions(replacement);
      await state.value.handleKey({ kind: "character", code: 55 }, 20, y);
      expect(state.cvars.get("replacement")?.value).toBe("7");
      expect(firstRuntimeItem(state.value).name).toBe("replacement");
      state.value.dispose();
    }
  });

  test("overlapping item allocation preserves the reached NULL-cvar edit return", async () => {
    const pool = new TeamArenaUiMemory("qvm32", () => {});
    const definitions = await parse(`menuDef {
      itemDef { name edit type 9 rect 10 10 100 20 visible 1 cvar original }
      name inputs rect 0 0 640 480
    }`, { kind: "qvm32", memory: pool });
    const retained = requiredValue(definitions.menus[0]?.itemAt(0), "retained source item");
    const state = await runtimeFromDefinitions(definitions);
    await state.value.activate("inputs");
    state.value.setDisplayCursor(20, 20);
    await state.value.pointerMove(20, 20);
    await state.value.handleKey({ kind: "key", code: KeyCode.Mouse1, down: true }, 20, 20);
    state.value.resetDefinitions("strings");
    pool.initializeStrings();
    pool.allocate(16);
    const replacement = await parse(`menuDef {
      itemDef { name shifted type 9 rect 10 10 100 20 visible 1 cvar shifted }
      name changed rect 0 0 640 480
    }`, { kind: "qvm32", memory: pool });
    expect(replacement.menus[0]?.items[0]?.allocationOffset).toBe(16);
    await state.value.reloadDefinitions(replacement);
    const retainedRecord = pool.borrow(0, 540);
    expect(retainedRecord.getInt32(264)).toBe(0);
    await state.value.handleKey({ kind: "character", code: 55 }, 20, 20);
    expect(retained.cvar).toBeUndefined();
    expect(state.cvars.get("original")).toBeUndefined();
    expect(state.cvars.get("shifted")).toBeUndefined();
    state.value.dispose();
  });

  test("force-paints a named hidden menu, clears the sticky flag, and scrolls an unfocused feeder", async () => {
    const state = await runtime(`menuDef { name scores rect 0 0 200 100 itemDef {
      name list type 6 rect 10 10 100 60 visible 1 feeder 7 elementwidth 20 elementheight 10 action { uiScript changed }
    } }`);
    const draw = draw2D();
    const scores = state.value.menuHandle("scores");
    if (scores === undefined) throw new Error("expected scores menu handle");
    await state.value.paintCaptured(scores, { time: 50, frameTime: 16, draw }, true);
    expect(requiredValue(state.value.snapshot().menus[0], "scores menu").flags & UiWindowFlag.Forced).toBe(UiWindowFlag.Forced);
    await state.value.setCapturedFeederSelection(scores, 7, 0);
    await state.value.scrollCapturedFeeder(scores, 7, true);
    expect(state.feeder.selections).toEqual(["7:0", "7:1"]);
    expect(state.external.calls).toEqual([]);
    state.value.clearCapturedForced(scores);
    expect(requiredValue(state.value.snapshot().menus[0], "scores menu").flags & UiWindowFlag.Forced).toBe(0);
    expect(await state.value.paintNamed("scores", { time: 51, frameTime: 1, draw }, false)).toBe(true);
    expect(state.value.clearForced("scores")).toBe(true);
    expect(await state.value.paintNamed("missing", { time: 51, frameTime: 1, draw }, true)).toBe(false);
  });

  test("uses completed parse registrations without replay and rejects only reached cgame binding calls", async () => {
    const resources = new ResourceTrace();
    const resolver = new MemoryResolver(`assetGlobalDef { itemFocusSound "sound/focus" }
      menuDef { name hud background "ui/hud"
        itemDef { name bind type 13 text Bind visible 1 rect 0 0 100 20 cvar +attack }
        itemDef { name command action { exec screenshot } }
      }`);
    const definitions = await loadMenuDefinitions(
      { resolver, random: { nextInt: (): number => 0 } },
      { kind: "ui", setPaths: ["ui/set.txt"] },
      {},
      { registrationSink: new ResourceRegistrationSink(resources) },
    );
    const registrations = [...resources.registrations];
    const cvars = new CvarRegistry(), commands = new CommandBuffer(), draw = draw2D();
    const value = await UiRuntime.create({
      definitions, cvars, commands, resources, fonts, widgetAssets, zeroPicture: picture,
      audio: new AudioTrace(), cinematics: new CinematicTrace(), paintModel: (): void => {},
      context: { kind: "cgame" }, feeder: new FeederTrace(), ownerDraw: new OwnerDrawTrace(),
      externalScript: new ExternalTrace(), getTeamColor: () => ({ x: 0, y: 0, z: 0, w: 1 }),
    });
    expect(resources.registrations).toEqual(registrations);
    const exec = definitions.menus[0]?.items[1]?.action;
    await expect(value.runItemScript("hud", "command", requiredScript(exec))).rejects.toThrow("executeText is unavailable in cgame context");
    expect(commands.pendingText).toBe("");
    expect(await value.paintNamed("hud", { time: 1, frameTime: 1, draw }, false)).toBe(true);
    await value.show("hud");
    await expect(value.frame({ time: 2, frameTime: 1, draw })).rejects.toThrow("paint binding is unavailable in cgame context");
    expect(resources.registrations).toEqual(registrations);
  });

  const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  test.skipIf(!existsSync(`${retailRoot}/missionpack/pak0.pk3`))("constructs and paints the shipped Team Arena main menu", async () => {
    const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product: "missionpack" });
    const memory = new TeamArenaUiMemory("qvm32", () => {});
    const definitions = await loadMenuDefinitions(
      { resolver: new RetailResolver(vfs), random: { nextInt: (): number => 725 } },
      defaultUiMenuPlan(),
      {}, { memory: { kind: "qvm32", memory } },
    );
    const state = await runtimeFromDefinitions(definitions);
    expect(await state.value.activate("main")).toBe(true);
    const draw = draw2D();
    await state.value.frame({ time: 1000, frameTime: 16, draw });
    expect(consumedBatches(draw).length).toBeGreaterThan(0);
    expect(state.value.snapshot().menus).toHaveLength(45);
    expect(state.value.snapshot().focusedMenu).toBe("main");
    expect(memory.outOfMemory).toBe(false);
  });
});
