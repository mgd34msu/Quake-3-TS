import { HunkArena } from "../src/core/hunk.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { Tokenizer } from "../src/core/text.ts";
import { CommonParseCursor } from "../src/core/common-parse.ts";
import {
  evaluateTexCoords, evaluateWaveform, inspectShaderScript, normalizeShaderName,
  parseShaderScript, ShaderParseError, SourceAlphaGenerator, SourceColorGenerator,
  SourceShaderRegistrationProgram, SourceTexCoordGenerator, SourceWaveFunction, stageState,
} from "../src/render/material.ts";
import type {
  FinishedStageImage,
  ParsedShaderStage,
  RegisteredImage,
  RegisteredShaderVideo,
  RegisteredSun,
  ShaderCatalogEntry,
  ShaderDefinition,
  ShaderRegistrationHost,
  ShaderScriptInspection,
  SourceImageRequest,
  Waveform,
} from "../src/render/material.ts";
import type { TextureSampling } from "../src/render/types.ts";
import type { Product } from "../src/shared/definitions.ts";
import { RendererImageCatalog, type RendererImage } from "../src/render/image-resource.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { publishTexture } from "./render-target-fixture.ts";

function shader(source: string): ShaderDefinition {
  const definition = parseShaderScript(source)[0];
  if (definition === undefined) throw new Error("Fixture has no shader");
  return definition;
}

function stage(directives: string): ParsedShaderStage {
  const result = shader(`fixture\n{\n{\n${directives}\n}\n}`).stages[0];
  if (result === undefined) throw new Error("Fixture has no stage");
  return result;
}

function acceptedDefinitions(inspection: ShaderScriptInspection): readonly ShaderDefinition[] {
  const result: ShaderDefinition[] = [];
  for (const entry of inspection.entries) {
    if (entry.textResult.kind === "accepted") result.push(entry.textResult.definition);
  }
  return result;
}

function catalogEntry(source: string): ShaderCatalogEntry {
  const entry = inspectShaderScript(source, "registration.shader").entries[0];
  if (entry === undefined) throw new Error("Fixture has no shader catalog entry");
  return entry;
}

function registeredImage(images: RendererImageCatalog, seed: number, sampling: TextureSampling = { wrap: "repeat", filter: "linear" }, tmu: 0 | 1 = 0): RegisteredImage {
  return { frame: { image: publishTexture(images, { name: `registration-${seed}`, width: 1, height: 1,
    pixels: new Uint8Array([seed, seed, seed, 255]), internalFormat: "rgba8", sampling, registrationUnit: tmu }) }, tmu };
}

function registrationMovie(): Uint8Array {
  const out = new BinaryWriter(64);
  out.u16(0x1084); out.u32(0xffffffff); out.u16(30);
  const chunks = [
    { id: 0x1001, flags: 0, data: [16, 0, 16, 0, 8, 0, 4, 0] },
    { id: 0x1002, flags: 0x0101, data: [255, 255, 255, 255, 128, 128, 0, 0, 0, 0] },
    { id: 0x1011, flags: 0, data: [0, 170, 0, 0, 0, 0] },
    { id: 0x1013, flags: 0, data: [] },
  ];
  for (const chunk of chunks) { out.u16(chunk.id); out.u32(chunk.data.length); out.u16(chunk.flags); out.bytes(Uint8Array.from(chunk.data)); }
  return out.finish();
}

const cinematicOwners: EngineCinematics[] = [];
afterEach(() => { for (const owner of cinematicOwners) owner.dispose(); cinematicOwners.length = 0; });

class RecordingRegistrationHost implements ShaderRegistrationHost {
  readonly images = new RendererImageCatalog();
  readonly whiteImage = registeredImage(this.images, 250);
  readonly defaultImage = registeredImage(this.images, 251, { wrap: "clamp", filter: "linear" });
  readonly lightmapImage = registeredImage(this.images, 252, { wrap: "clamp", filter: "linear" }, 1);
  readonly events: string[] = [];
  readonly warnings: string[] = [];
  printWarning(message: string): void { this.warnings.push(message); }
  readonly imageResults: RegisteredImage[] = [];
  readonly suns: RegisteredSun[] = [];
  private imageSeed = 1;
  private readonly cinematics: EngineCinematics;

  constructor(private readonly missingImages: readonly string[] = [], failedMovies: readonly string[] = []) {
    const bytes = registrationMovie();
    const cinematicMixer = new AudioMixer(22050, () => 0);
    this.cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined,
      files: { kind: "diagnostic-bytes", reader: { has: path => !failedMovies.some(name => path === `video/${name}`), list: () => [], read: async () => bytes } },
      sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: { sample: () => 0 }, scratchImages: new BuiltinImages(this.images, identityImageUploadProfile),
      console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 },
    });
    cinematicOwners.push(this.cinematics);
  }

  findImage(request: SourceImageRequest): Promise<RegisteredImage | null> {
    this.events.push(`image:${request.name}:${request.mipmap ? "mip" : "nomip"}:${request.allowPicmip ? "picmip" : "nopicmip"}:${request.wrap}`);
    if (this.missingImages.includes(request.name)) return Promise.resolve(null);
    const result = registeredImage(this.images, this.imageSeed, { wrap: request.wrap, filter: "linear" });
    this.imageSeed++;
    this.imageResults.push(result);
    return Promise.resolve(result);
  }

  async playShaderCinematic(name: string): Promise<RegisteredShaderVideo | null> {
    this.events.push(`video:${name}`);
    const source = await this.cinematics.shaderCinematics.playShaderCinematic(name);
    return source === null ? null : { source, image: { frame: { image: source.image }, tmu: 0 } };
  }

  applySun(sun: RegisteredSun): void {
    this.events.push("sun");
    this.suns.push(sun);
  }

  initializeSkyTexCoords(height: number): void {
    this.events.push(`sky:${height}`);
  }
}

function stageImage(stage: FinishedStageImage | undefined): RendererImage {
  if (stage === undefined) throw new Error("Missing registered stage image");
  return stage.image;
}

const origin = { x: 0, y: 0, z: 0 };
const normal = { x: 0, y: 0, z: 1 };

describe("shader script parsing", () => {
  test("preserves globals, sun, deformations and source-only compiler directives", () => {
    const result = shader(`Textures\\Example.TGA
{
  qer_editorimage Textures/Editor.tga
  q3map_surfacelight 350
  q3map_sun 1 0.5 0.25 100 90 45
  tesssize 32
  light 10
  surfaceparm sky
  surfaceparm noimpact
  cull disable
  sort sky
  skyparms env/space 0 -
  fogparms ( 0.25 0.5 0.75 ) 512 0 0 1
  deformVertexes wave 100 sin 0 3 0 2
  deformVertexes normal 0.2 0.5
  deformVertexes move 0 0 2 triangle 0 2 0 1
  polygonOffset
  noMipMaps
  entityMergable
  clampTime 5
  { map $whiteimage }
}`);
    expect(result.name).toBe("Textures\\Example.TGA");
    expect(result.cull).toBe("none");
    expect(result.sort).toBe(2);
    expect(result.sky).toEqual({ outerBox: "env/space", cloudHeight: 512, innerBox: null });
    expect(result.fog).toEqual({ color: { x: 0.25, y: 0.5, z: 0.75 }, depthForOpaque: 512 });
    expect(result.sun).toEqual({ color: { x: 1, y: 0.5, z: 0.25 }, intensity: 100, azimuth: 90, elevation: 45 });
    expect(result.deforms).toEqual([
      { kind: "wave", spread: Math.fround(0.01), wave: { kind: "sin", base: 0, amplitude: 3, phase: 0, frequency: 2 } },
      { kind: "normal", amplitude: Math.fround(0.2), frequency: 0.5 },
      { kind: "move", direction: { x: 0, y: 0, z: 2 }, wave: { kind: "triangle", base: 0, amplitude: 2, phase: 0, frequency: 1 } },
    ]);
    expect(result.compilerDirectives.map(directive => directive.name)).toEqual(["qer_editorimage", "q3map_surfacelight", "tesssize", "light"]);
    expect(result.noMipMaps).toBe(true);
    expect(result.noPicMip).toBe(true);
    expect(result.polygonOffset).toBe(true);
    expect(result.entityMergable).toBe(true);
    expect(result.clampTime).toBe(5);
    expect(result.warnings).toEqual([]);
  });

  test("parses stages and uses source defaults for blend/depth/generators", () => {
    const opaque = stage("map $lightmap\nblendFunc GL_ONE GL_ZERO");
    expect(opaque.tcGen).toEqual({ kind: "lightmap" });
    expect(opaque.rgbGen).toEqual({ kind: "identitylighting" });
    expect(opaque.depthWrite).toBe(true);
    const filtered = stage("map Texture.TGA\nblendFunc filter");
    expect(filtered.rgbGen).toEqual({ kind: "identity" });
    expect(filtered.depthWrite).toBe(false);
    const blended = stage("clampMap Texture.TGA\nblendFunc blend\ndepthWrite\ndepthFunc equal\nalphaFunc GE128\nrgbGen vertex\ndetail");
    expect(blended.alphaGen).toEqual({ kind: "vertex" });
    expect(blended.detail).toBe(true);
    expect(stageState(blended, "none")).toEqual({
      blend: { source: "src-alpha", destination: "one-minus-src-alpha" },
      depthTest: "equal", depthWrite: true, alphaTest: "ge128", cull: "none",
    });
    expect(stage("depthWrite\nmap test\nblendFunc add").depthWrite).toBe(true);
    expect(stageState(opaque).cull).toBe("front");
    expect(shader("test { cull back { map test } }").cull).toBe("back");
  });

  test("animMap consumes only its line, handles comments and caps images at eight", () => {
    const result = stage("animMap 4 a.tga b.tga c.tga d.tga e.tga f.tga g.tga h.tga i.tga // frames\nblendFunc add\nrgbGen wave square 0.5 0.5 0 2");
    expect(result.map).toEqual({ kind: "animation", frequency: 4, frames: ["a.tga", "b.tga", "c.tga", "d.tga", "e.tga", "f.tga", "g.tga", "h.tga"] });
    expect(result.blend).toEqual({ source: "one", destination: "one" });
    expect(result.rgbGen).toEqual({ kind: "wave", wave: { kind: "square", base: 0.5, amplitude: 0.5, phase: 0, frequency: 2 } });
    expect(stage("videoMap Video/Intro.RoQ").map).toEqual({ kind: "video", name: "video/intro.roq" });
  });

  test("partial complex blends retain raw destination and depth bits until ParseStage finishes", () => {
    const absent = stage("map test\nblendFunc GL_ONE\n");
    expect(absent.sourceState.stateBits).toBe(0x102);
    expect(absent.depthWrite).toBe(true);
    const freshAlpha = stage("map test\nblendFunc GL_SRC_ALPHA\n");
    expect(freshAlpha.sourceState.stateBits).toBe(0x105);
    const retained = stage("map test\nblendFunc add\nblendFunc GL_SRC_ALPHA\n");
    expect(retained.sourceState.stateBits).toBe(0x25);
    expect(retained.blend).toEqual({ source: "src-alpha", destination: "one" });
    expect(retained.depthWrite).toBe(false);
    expect(stage("map test\nblendFunc GL_ONE GL_ZERO\nblendFunc GL_SRC_ALPHA\n").sourceState.stateBits).toBe(0x15);
    expect(stage("map test\nblendFunc GL_SRC_ALPHA\nblendFunc GL_ONE GL_ZERO\n").sourceState.stateBits).toBe(0x100);
    expect(stage("map test\nblendFunc add\ndepthWrite\nblendFunc GL_ONE\n").sourceState.stateBits).toBe(0x122);
    expect(stage("map test\nblendFunc\n").sourceState.stateBits).toBe(0x100);
  });

  test("preserves generators, vectors and portal's source default", () => {
    const result = stage("map test\nrgbGen const ( 1 0.5 0 )\nalphaGen const 0.25\ntcGen vector ( 1 2 3 ) ( 4 5 6 )");
    expect(result.rgbGen).toEqual({ kind: "const", color: { x: 1, y: 0.5, z: 0 } });
    expect(result.alphaGen).toEqual({ kind: "const", alpha: 0.25 });
    expect(result.tcGen).toEqual({ kind: "vector", s: { x: 1, y: 2, z: 3 }, t: { x: 4, y: 5, z: 6 } });
    expect(stage("map test\nalphaGen portal\nblendFunc blend").alphaGen).toEqual({ kind: "portal", range: 256 });
  });

  test("retains zero-initialized source fields and overwritten waveform storage", () => {
    const initial = stage("map test");
    expect(initial.sourceState).toEqual({
      active: true,
      stateBits: 0x100,
      rgbGen: SourceColorGenerator.IdentityLighting,
      alphaGen: SourceAlphaGenerator.Identity,
      tcGen: SourceTexCoordGenerator.Bad,
      rgbWave: { func: SourceWaveFunction.None, base: 0, amplitude: 0, phase: 0, frequency: 0 },
      alphaWave: { func: SourceWaveFunction.None, base: 0, amplitude: 0, phase: 0, frequency: 0 },
      isLightmap: false,
      vertexLightmap: false,
    });
    const overwritten = stage("map $lightmap\nmap test\nrgbGen wave sawtooth 1 2 3 4\nrgbGen identity\nalphaGen wave square 5 6 7 8\nalphaGen portal 64");
    expect(overwritten.tcGen).toEqual({ kind: "lightmap" });
    expect(overwritten.sourceState).toEqual({
      active: true,
      stateBits: 0x100,
      rgbGen: SourceColorGenerator.Identity,
      alphaGen: SourceAlphaGenerator.Portal,
      tcGen: SourceTexCoordGenerator.Bad,
      rgbWave: { func: SourceWaveFunction.Sawtooth, base: 1, amplitude: 2, phase: 3, frequency: 4 },
      alphaWave: { func: SourceWaveFunction.Square, base: 5, amplitude: 6, phase: 7, frequency: 8 },
      isLightmap: true,
      vertexLightmap: false,
    });
  });

  test("preserves ParseStage's cross-enum alpha skip comparison", () => {
    expect(stage("map test\nrgbGen identity\nalphaGen entity").sourceState.alphaGen).toBe(SourceAlphaGenerator.Skip);
    expect(stage("map test\nrgbGen lightingDiffuse\nalphaGen entity").sourceState.alphaGen).toBe(SourceAlphaGenerator.Skip);
    expect(stage("map test\nrgbGen vertex\nalphaGen entity").sourceState.alphaGen).toBe(SourceAlphaGenerator.Entity);
  });

  test("source registration retains generators after missing or unknown stage parameters", async () => {
    const body = `{
      {
        map retained.tga
        rgbGen vertex
        alphaGen identity
        rgbGen unknown
        rgbGen
        alphaGen
        tcGen vector ( 1 2 3 ) ( 4 5 6 )
        tcGen
        texGen unknown
        blendFunc add
        depthWrite
        blendFunc
      }
    }`;
    const host = new RecordingRegistrationHost();
    const result = await new SourceShaderRegistrationProgram(new CommonParseCursor(body), 0, "retained.shader", "retained").register(host);
    expect(result.kind).toBe("defined");
    expect(host.events).toEqual(["image:retained.tga:mip:picmip:repeat"]);
    const parsed = result.definition.stages[0];
    expect(parsed?.sourceState.rgbGen).toBe(SourceColorGenerator.Vertex);
    expect(parsed?.sourceState.alphaGen).toBe(SourceAlphaGenerator.Identity);
    expect(parsed?.tcGen).toEqual({ kind: "vector", s: { x: 1, y: 2, z: 3 }, t: { x: 4, y: 5, z: 6 } });
    expect(parsed?.blend).toEqual({ source: "one", destination: "one" });
    expect(parsed?.depthWrite).toBe(true);
    expect(result.definition.warnings).toHaveLength(6);
  });

  test("source registration accepts brace-prefix tokens and native hexadecimal float parameters", async () => {
    const body = "{outer\n sort 0x1.8p1\n clampTime 0x1p2\n {stage\n map retained.tga\n tcMod scale 0x1.8p1 -0x1p-2\n }stage\n }outer";
    const result = await new SourceShaderRegistrationProgram(new CommonParseCursor(body), 0, "hex.shader", "hex")
      .register(new RecordingRegistrationHost());
    expect(result.kind).toBe("defined");
    expect(result.definition.sort).toBe(3);
    expect(result.definition.clampTime).toBe(4);
    expect(result.definition.stages[0]?.tcMods).toEqual([{ kind: "scale", amount: { x: 3, y: -0.25 } }]);
    expect(stage("map test\ntcMod scale 0x1.8p1 -0x1p-2").tcMods).toEqual([{ kind: "scale", amount: { x: 3, y: -0.25 } }]);
  });

  test("source warnings print synchronously before the next image or token failure", async () => {
    class WarningHost extends RecordingRegistrationHost {
      override printWarning(message: string): void { this.events.push(message); }
    }
    const body = "{ { map first\nrgbGen INVALID\nmap second } }";
    const host = new WarningHost();
    await new SourceShaderRegistrationProgram(new CommonParseCursor(body), 0, "warning.shader", "ExactName").register(host);
    expect(host.events).toEqual(["image:first:mip:picmip:repeat", "WARNING: unknown rgbGen parameter 'INVALID' in shader 'ExactName'\n",
      "image:second:mip:picmip:repeat"]);
    class StoppingHost extends RecordingRegistrationHost {
      override printWarning(): void { throw new Error("warning callback stopped registration"); }
    }
    const stopped = new StoppingHost();
    await expect(new SourceShaderRegistrationProgram(new CommonParseCursor(body), 0, "warning.shader", "ExactName").register(stopped))
      .rejects.toThrow("warning callback stopped registration");
    expect(stopped.events).toEqual(["image:first:mip:picmip:repeat"]);
  });

  test("source atof stores special floats without warnings until a reached integer conversion", async () => {
    const host = new RecordingRegistrationHost();
    const body = "{ sort infinity clampTime -inf { map first\ntcMod scale nan(payload) -0x0p0\n} }";
    const result = await new SourceShaderRegistrationProgram(new CommonParseCursor(body), 0, "floats.shader", "floats").register(host);
    expect(result.kind).toBe("defined"); expect(result.definition.sort).toBe(Infinity);
    expect(result.definition.clampTime).toBe(-Infinity); expect(host.warnings).toEqual([]);
    const mod = result.definition.stages[0]?.tcMods[0];
    if (mod?.kind !== "scale") throw new Error("Expected scale modifier");
    expect(mod.amount.x).toBeNaN(); expect(Object.is(mod.amount.y, -0)).toBe(true);
    expect(() => evaluateTexCoords(stage("map first\ntcMod rotate inf"), { x: 0, y: 0 }, origin, normal, 1))
      .toThrow("undefined source float-to-int conversion");
  });

  test("source compiler and fog skips stop at the first raw newline", async () => {
    const directives = [
      "qer_editorimage }", "q3map_surfacelight }", "tessSize }",
      'qer_editorimage "ignored', "qer_editorimage /* ignored",
      "fogParms ( 1 0 0 ) 64 }",
    ];
    for (const directive of directives) {
      const body = `{\n${directive}\n{\nmap retained.tga\n}\n}\n`;
      const cursor = new CommonParseCursor(body);
      const host = new RecordingRegistrationHost();
      const findImage = host.findImage.bind(host);
      host.findImage = request => {
        expect(cursor.offset).toBe(body.indexOf("retained.tga") + "retained.tga".length);
        return findImage(request);
      };
      const result = await new SourceShaderRegistrationProgram(cursor, 0, "skip.shader", "skip").register(host);
      expect(result.kind).toBe("defined");
      expect(result.definition.stages).toHaveLength(1);
      expect(cursor.offset).toBe(body.length - 1);
      expect(host.events).toEqual(["image:retained.tga:mip:picmip:repeat"]);
    }
    const body = "{\nqer_editorimage ignored\ncull wrong\n{\nmap retained.tga\n}\n}\n";
    const result = await new SourceShaderRegistrationProgram(new CommonParseCursor(body), 0, "skip.shader", "skip").register(new RecordingRegistrationHost());
    expect(result.definition.warnings[0]?.line).toBe(5);
  });

  test("source tcMod copies the whole line before parsing its arguments", async () => {
    const cases: readonly { readonly tail: string; readonly kind: "defined" | "defaulted"; readonly scaled: boolean }[] = [
      { tail: "tcMod scale 2 3 }\n}", kind: "defaulted", scaled: true },
      { tail: "tcMod\n}\n}", kind: "defined", scaled: false },
      { tail: "tcMod scale 2 3", kind: "defaulted", scaled: true },
      { tail: "tcMod", kind: "defaulted", scaled: false },
      { tail: "tcMod scale 2 3\n}\n}", kind: "defined", scaled: true },
      { tail: 'tcMod scale "2 3"\n}\n}', kind: "defined", scaled: true },
    ];
    for (const fixture of cases) {
      const host = new RecordingRegistrationHost();
      const body = `{\n{\nmap retained.tga\n${fixture.tail}`;
      const result = await new SourceShaderRegistrationProgram(new CommonParseCursor(body), 0, "tcmod.shader", "tcmod").register(host);
      expect(result.kind).toBe(fixture.kind);
      expect(result.definition.stages[0]?.tcMods).toEqual([fixture.scaled
        ? { kind: "scale", amount: { x: 2, y: 3 } } : { kind: "none" }]);
      expect(host.events).toEqual(["image:retained.tga:mip:picmip:repeat"]);
    }
    for (const length of [1012, 1013]) {
      const host = new RecordingRegistrationHost();
      const body = `{\n{\nmap retained.tga\ntcMod scale 2 3 ${"x".repeat(length)}\n}\n}`;
      const result = new SourceShaderRegistrationProgram(new CommonParseCursor(body), 0, "tcmod.shader", "tcmod").register(host);
      if (length === 1012) expect((await result).kind).toBe("defined");
      else await expect(result).rejects.toThrow("tcMod arguments exceed the source 1024-byte buffer");
      expect(host.events).toEqual(["image:retained.tga:mip:picmip:repeat"]);
    }
  });

  test("partial stage waveforms retain each prior source field across generator changes", () => {
    const retained = stage(`map test
      rgbGen wave sawtooth .25 .125 .375 2
      rgbGen identity
      rgbGen wave square .5
      alphaGen wave triangle .125 .25 .5 3
      alphaGen identity
      alphaGen wave sin .75 .5`);
    expect(retained.rgbGen).toEqual({ kind: "wave", wave: { kind: "square", base: .5, amplitude: .125, phase: .375, frequency: 2 } });
    expect(retained.sourceState.rgbWave).toEqual({ func: SourceWaveFunction.Square, base: .5, amplitude: .125, phase: .375, frequency: 2 });
    expect(retained.alphaGen).toEqual({ kind: "wave", wave: { kind: "sin", base: .75, amplitude: .5, phase: .5, frequency: 3 } });
    expect(retained.sourceState.alphaWave).toEqual({ func: SourceWaveFunction.Sin, base: .75, amplitude: .5, phase: .5, frequency: 3 });
    const empty = stage("map test\nrgbGen wave\nalphaGen wave");
    expect(empty.sourceState.rgbGen).toBe(SourceColorGenerator.Waveform);
    expect(empty.sourceState.alphaGen).toBe(SourceAlphaGenerator.Waveform);
    expect(empty.sourceState.rgbWave.func).toBe(SourceWaveFunction.None);
    expect(empty.sourceState.alphaWave.func).toBe(SourceWaveFunction.None);
    expect(empty.rgbGen).toEqual({ kind: "wave", wave: { kind: "none", base: 0, amplitude: 0, phase: 0, frequency: 0 } });
    expect(stage("map test\nalphaGen const").alphaGen).toEqual({ kind: "const", alpha: 0 });
  });

  test("source shader parameters preserve prior values when their line ends", () => {
    const result = shader(`retained {
      fogParms ( 1 0 .5 ) 12
      fogParms ( .25 .5 .75 )
      sort additive
      cull none
      cull
      sort
      clampTime 1.5
      clampTime
      surfaceParm
      light
      deformVertexes
      deformVertexes text3suffix
      { map test }
    }`);
    expect(result.fog).toEqual({ color: { x: .25, y: .5, z: .75 }, depthForOpaque: 12 });
    expect(result.sort).toBe(10);
    expect(result.cull).toBe("none");
    expect(result.clampTime).toBe(1.5);
    expect(result.surfaceParms).toEqual([]);
    expect(result.deforms).toEqual([{ kind: "text", index: 3 }]);
    expect(result.warnings).toHaveLength(4);
  });

  test("tcGen vectors retain partial writes and fog rejection publishes its written components", () => {
    const parsed = stage(`map test
      tcGen vector ( 1 2 3 ) ( 4 5 6 )
      tcGen texture
      tcGen vector ( 9
      ( 8 7 6 )`);
    expect(parsed.tcGen).toEqual({ kind: "vector", s: { x: 9, y: 2, z: 3 }, t: { x: 8, y: 7, z: 6 } });
    const entry = catalogEntry(`partial {
      fogParms ( 1 2 3 ) 12
      fogParms ( 9
      { map test }
    }`);
    expect(entry.textResult.kind).toBe("rejected");
    if (entry.textResult.kind !== "rejected") throw new Error("Expected source fog vector rejection");
    expect(entry.textResult.partial.fog).toEqual({ color: { x: 9, y: 2, z: 3 }, depthForOpaque: 12 });
  });

  test("partial deformation parameters consume an inactive slot until the source selects its operation", () => {
    for (const directive of ["bulge", "bulge 2", "bulge 2 3", "normal", "normal .5", "move", "move 1", "move 1 2", "wave"]) {
      const result = shader(`partial {\ndeformVertexes ${directive}\n{ map test }\n}`);
      expect(result.deforms).toEqual([{ kind: "none" }]);
      expect(result.warnings).toHaveLength(1);
    }
    const full = shader(`partial {
      deformVertexes bulge 2
      deformVertexes normal .5
      deformVertexes move 1 2
      deformVertexes projectionShadow
      { map test }
    }`);
    expect(full.deforms).toEqual([{ kind: "none" }, { kind: "none" }, { kind: "none" }]);
    expect(full.warnings).toHaveLength(4);
  });

  test("partial deformation waveforms remain active with their source zero-initialized tails", () => {
    const result = shader(`partial {
      deformVertexes wave 2 triangle .5
      deformVertexes move 1 2 3
      deformVertexes wave 0
      { map test }
    }`);
    expect(result.deforms).toEqual([
      { kind: "wave", spread: .5, wave: { kind: "triangle", base: .5, amplitude: 0, phase: 0, frequency: 0 } },
      { kind: "move", direction: { x: 1, y: 2, z: 3 }, wave: { kind: "none", base: 0, amplitude: 0, phase: 0, frequency: 0 } },
      { kind: "wave", spread: 100, wave: { kind: "none", base: 0, amplitude: 0, phase: 0, frequency: 0 } },
    ]);
    expect(result.warnings).toHaveLength(4);
  });

  test("source-tolerated malformed legacy parameters produce warnings", () => {
    const result = shader("legacy\n{\nskyparms env/test full -\n{\nmap test\nrgbGen identitylight\ntcMod turb sin .5 1 0 1\ntcMod scroll 1 2 10 20\n}\n}");
    expect(result.sky?.cloudHeight).toBe(512);
    expect(result.warnings.map(warning => warning.message)).toEqual(["WARNING: unknown rgbGen parameter 'identitylight' in shader 'legacy'\n"]);
    expect(result.stages[0]?.tcMods[0]).toEqual({ kind: "turb", wave: { kind: "sin", base: 0, amplitude: 0.5, phase: 1, frequency: 0 } });
  });

  test("unknown modifier subtypes warn and retain the source no-op behavior", () => {
    const result = shader("legacy\n{\ndeformVertexes unknown\nsort unknown\n{\nmap test\ntcMod unknown\ntcMod scale 9 9\n}\n}");
    expect(result.deforms).toEqual([{ kind: "none" }]);
    expect(result.sort).toBe(0);
    expect(result.warnings.length).toBe(2);
    const pass = result.stages[0];
    if (pass === undefined) throw new Error("Missing fixture stage");
    expect(evaluateTexCoords(pass, { x: 0.25, y: 0.5 }, origin, normal, 1)).toEqual({ x: 0.25, y: 0.5 });
  });

  test("rejects unknown runtime directives, missing parameters and source capacity overflow", () => {
    expect(() => parseShaderScript("test { unsupportedEffect 1 }", "bad.shader")).toThrow("WARNING: unknown general shader parameter 'unsupportedEffect' in 'test'\n");
    expect(() => stage("map\nrgbGen vertex")).toThrow(ShaderParseError);
    expect(() => stage("map test\nalphamap test")).toThrow("WARNING: unknown parameter 'alphamap' in shader 'fixture'\n");
    expect(() => stage("map test\n" + "tcMod scale 1 1\n".repeat(5))).toThrow("four tcMod");
    expect(() => parseShaderScript("test { { map test }")).toThrow(ShaderParseError);
    expect(() => parseShaderScript("test { } ")).toThrow("neither sky nor fog");
    expect(stage("map test\ntcMod scale 1e999 1").tcMods).toEqual([{ kind: "scale", amount: { x: Infinity, y: 1 } }]);
  });

  test("inspects every sibling definition while retaining source rejection diagnostics", () => {
    const result = inspectShaderScript("bad { cloudparms 512 full }\ngood { { map test } }\nempty { }\nfog { surfaceparm fog }", "retail.shader");
    expect(result.entries.map(value => [value.name, value.textResult.kind])).toEqual([
      ["bad", "rejected"], ["good", "accepted"], ["empty", "rejected"], ["fog", "accepted"],
    ]);
    const first = result.entries[0]?.textResult;
    if (first === undefined || first.kind !== "rejected") throw new Error("Expected rejected fixture");
    expect(first.error.source).toBe("retail.shader");
    expect(first.error.reason).toBe("source-rejection");
    expect(normalizeShaderName("Textures\\Mixed.CASE.TGA")).toBe("textures\\mixed");
    expect(normalizeShaderName("DIR.With.Dot/Name.tga")).toBe("dir");
    expect(normalizeShaderName("ÄBC\0suffix")).toBe("Äbc");
  });
});

describe("shader registration programs", () => {
  test("retains a completed prefix stage when later shader text is rejected", async () => {
    const entry = catalogEntry("partial { { map shared.tga } unknownDirective }");
    expect(entry.textResult.kind).toBe("rejected");
    const host = new RecordingRegistrationHost();
    const result = await entry.program.register(host);
    expect(host.events).toEqual(["image:shared.tga:mip:picmip:repeat"]);
    expect(result.kind).toBe("defaulted");
    expect(result.definition.stages).toHaveLength(1);
    expect(result.definition.stages[0]?.depthWrite).toBe(true);
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]?.kind).toBe("loaded");
    if (result.kind !== "defaulted") throw new Error("Expected source-text default");
    expect(result.failure.kind).toBe("source-text");
  });

  test("retains an active incomplete stage with zero state bits on a stage-text rejection", async () => {
    const entry = catalogEntry(`partial {
      { map shared.tga blendFunc add unknownStage }
      skyParms env/later 512 -
    }`);
    const host = new RecordingRegistrationHost();
    const result = await entry.program.register(host);
    expect(host.events).toEqual(["image:shared.tga:mip:picmip:repeat"]);
    expect(result.kind).toBe("defaulted");
    expect(result.definition.stages[0]).toMatchObject({
      blend: { source: "one", destination: "zero" },
      depthFunc: "less-equal",
      depthWrite: false,
      alphaFunc: "none",
      sourceState: {
        active: true,
        stateBits: 0,
        rgbGen: SourceColorGenerator.Bad,
        alphaGen: SourceAlphaGenerator.Identity,
        tcGen: SourceTexCoordGenerator.Bad,
      },
    });
    expect(result.stages[0]?.kind).toBe("loaded");
  });

  test("stops at the first missing image with the exact pre-closing stage snapshot", async () => {
    const entry = catalogEntry(`early {
      { map present }
      { map missing blendFunc add }
      { videoMap later.roq }
      skyParms env/later 64 -
      q3map_sun 1 1 1 100 90 45
    }`);
    const host = new RecordingRegistrationHost(["missing"]);
    const result = await entry.program.register(host);
    expect(host.events).toEqual([
      "image:present:mip:picmip:repeat",
      "image:missing:mip:picmip:repeat",
    ]);
    expect(result.kind).toBe("defaulted");
    expect(result.definition.stages).toHaveLength(2);
    expect(result.definition.stages[1]).toMatchObject({
      map: { kind: "image", name: "missing", clamp: false },
      blend: { source: "one", destination: "zero" },
      depthFunc: "less-equal",
      depthWrite: false,
      alphaFunc: "none",
    });
    expect(result.stages.map(value => value.kind)).toEqual(["loaded", "missing"]);
    if (result.kind !== "defaulted" || result.failure.kind !== "missing-image") throw new Error("Expected missing-image default");
    expect(result.failure.request.name).toBe("missing");
  });

  test("a first-stage image miss skips every later registration effect", async () => {
    const entry = catalogEntry(`first-miss {
      { map missing }
      { map later }
      q3map_sun 1 1 1 100 90 45
      skyParms env/later 64 -
    }`);
    const host = new RecordingRegistrationHost(["missing"]);
    const result = await entry.program.register(host);
    expect(host.events).toEqual(["image:missing:mip:picmip:repeat"]);
    expect(result.stages).toEqual([{ kind: "missing" }]);
    expect(result.sky).toBeNull();
  });

  test("uses directive-time image flags and preserves animation storage across later writes", async () => {
    const entry = catalogEntry(`animated {
      { animMap 4 a b
        map c }
      noMipMaps
      { clampMap d }
    }`);
    const host = new RecordingRegistrationHost();
    const result = await entry.program.register(host);
    expect(host.events).toEqual([
      "image:a:mip:picmip:repeat",
      "image:b:mip:picmip:repeat",
      "image:c:mip:picmip:repeat",
      "image:d:nomip:nopicmip:clamp",
    ]);
    const first = result.stages[0];
    if (first === undefined || first.kind !== "loaded" || first.binding.kind !== "images"
      || first.binding.playback.kind !== "animation") throw new Error("Expected registered animation");
    expect(first.binding.playback.frequency).toBe(4);
    const expectedFrames = [
      stageImage(host.imageResults[2]?.frame),
      stageImage(host.imageResults[1]?.frame),
    ];
    expect(first.binding.playback.frames).toHaveLength(expectedFrames.length);
    for (const [index, frame] of first.binding.playback.frames.entries()) {
      const expected = expectedFrames[index];
      if (expected === undefined) throw new Error("Unexpected registered animation frame");
      expect(frame.image).toBe(expected);
    }
  });

  test("updates animation frequency before a failed appended frame and leaves the registered prefix", async () => {
    const entry = catalogEntry(`animated {
      { animMap 4 a b
        animMap 8 c missing
        map later }
    }`);
    const host = new RecordingRegistrationHost(["missing"]);
    const result = await entry.program.register(host);
    expect(host.events).toEqual([
      "image:a:mip:picmip:repeat",
      "image:b:mip:picmip:repeat",
      "image:c:mip:picmip:repeat",
      "image:missing:mip:picmip:repeat",
    ]);
    const first = result.stages[0];
    if (first === undefined || first.kind !== "loaded" || first.binding.kind !== "images"
      || first.binding.playback.kind !== "animation") throw new Error("Expected registered animation prefix");
    expect(first.binding.playback.frequency).toBe(8);
    expect(first.binding.playback.frames).toHaveLength(host.imageResults.length);
    for (const [index, frame] of first.binding.playback.frames.entries()) expect(frame.image).toBe(stageImage(host.imageResults[index]?.frame));
    expect(result.definition.stages[0]?.map).toEqual({ kind: "animation", frequency: 8, frames: ["c", "missing"] });
  });

  test("a failed ordinary map clears animation slot zero and defaults the stage", async () => {
    const entry = catalogEntry(`animated {
      { animMap 4 a b
        map missing
        map later }
    }`);
    const host = new RecordingRegistrationHost(["missing"]);
    const result = await entry.program.register(host);
    expect(host.events).toEqual([
      "image:a:mip:picmip:repeat",
      "image:b:mip:picmip:repeat",
      "image:missing:mip:picmip:repeat",
    ]);
    expect(result.stages).toEqual([{ kind: "missing" }]);
    expect(result.definition.stages[0]?.map).toEqual({ kind: "image", name: "missing", clamp: false });
  });

  test("retains animation count through empty and builtin overwrites and stops looking up after frame eight", async () => {
    const entry = catalogEntry(`animated {
      { animMap 4 a b
        animMap 8
        map $whiteimage }
      { animMap 2 a b c d e f g h ignored missing }
    }`);
    const host = new RecordingRegistrationHost(["missing"]);
    const result = await entry.program.register(host);
    expect(host.events).toEqual([
      "image:a:mip:picmip:repeat", "image:b:mip:picmip:repeat",
      "image:a:mip:picmip:repeat", "image:b:mip:picmip:repeat",
      "image:c:mip:picmip:repeat", "image:d:mip:picmip:repeat",
      "image:e:mip:picmip:repeat", "image:f:mip:picmip:repeat",
      "image:g:mip:picmip:repeat", "image:h:mip:picmip:repeat",
    ]);
    const first = result.stages[0];
    if (first === undefined || first.kind !== "loaded" || first.binding.kind !== "images"
      || first.binding.playback.kind !== "animation") throw new Error("Expected retained builtin animation");
    expect(first.binding.playback.frequency).toBe(8);
    expect(first.binding.playback.frames[0]).toBe(host.whiteImage.frame);
    expect(first.binding.playback.frames[1]?.image).toBe(host.imageResults[1]?.frame.image);
    const second = result.stages[1];
    if (second === undefined || second.kind !== "loaded" || second.binding.kind !== "images"
      || second.binding.playback.kind !== "animation") throw new Error("Expected capped animation");
    expect(second.binding.playback.frames).toHaveLength(8);
  });

  test("models sticky successful video state and a later failed handle as retain-current-texture", async () => {
    const entry = catalogEntry("video { { videoMap ok.roq videoMap absent.roq map final } }");
    const host = new RecordingRegistrationHost([], ["absent.roq"]);
    const result = await entry.program.register(host);
    expect(host.events).toEqual(["video:ok.roq", "video:absent.roq", "image:final:mip:picmip:repeat"]);
    const first = result.stages[0];
    if (first === undefined || first.kind !== "loaded") throw new Error("Expected registered video stage");
    expect(first.binding).toEqual({ kind: "retain-current-texture" });

    const initialFailure = catalogEntry("video { { videoMap absent.roq map final } }");
    const secondHost = new RecordingRegistrationHost([], ["absent.roq"]);
    const recovered = await initialFailure.program.register(secondHost);
    const recoveredStage = recovered.stages[0];
    if (recoveredStage === undefined || recoveredStage.kind !== "loaded") throw new Error("Expected ordinary image after failed video");
    expect(recoveredStage.binding.kind).toBe("images");
  });

  test("registers sky faces and sun in source FIFO order with default-image substitution", async () => {
    const entry = catalogEntry(`space {
      q3map_sun 1 0.5 0.25 100 90 45
      skyParms env/outer 0 env/inner
    }`);
    const host = new RecordingRegistrationHost(["env/outer_bk.tga"]);
    const result = await entry.program.register(host);
    expect(host.events).toEqual([
      "sun",
      "image:env/outer_rt.tga:mip:picmip:clamp",
      "image:env/outer_bk.tga:mip:picmip:clamp",
      "image:env/outer_lf.tga:mip:picmip:clamp",
      "image:env/outer_ft.tga:mip:picmip:clamp",
      "image:env/outer_up.tga:mip:picmip:clamp",
      "image:env/outer_dn.tga:mip:picmip:clamp",
      "sky:512",
      "image:env/inner_rt.tga:mip:picmip:repeat",
      "image:env/inner_bk.tga:mip:picmip:repeat",
      "image:env/inner_lf.tga:mip:picmip:repeat",
      "image:env/inner_ft.tga:mip:picmip:repeat",
      "image:env/inner_up.tga:mip:picmip:repeat",
      "image:env/inner_dn.tga:mip:picmip:repeat",
    ]);
    expect(host.suns[0]?.light.x).toBeCloseTo(87.287, 3);
    expect(host.suns[0]?.direction.z).toBeCloseTo(Math.SQRT1_2, 6);
    expect(result.sky?.cloudHeight).toBe(512);
    expect(result.sky?.outer?.image("bk")).toBe(host.defaultImage.frame);
  });

  test("retains outer-sky registration when ParseSkyParms returns before cloud height", async () => {
    const entry = catalogEntry(`partial-sky {
      skyParms env/outer
      { map later }
    }`);
    const host = new RecordingRegistrationHost();
    const result = await entry.program.register(host);
    expect(result.definition.sky).toBeNull();
    expect(host.events).toEqual([
      "image:env/outer_rt.tga:mip:picmip:clamp",
      "image:env/outer_bk.tga:mip:picmip:clamp",
      "image:env/outer_lf.tga:mip:picmip:clamp",
      "image:env/outer_ft.tga:mip:picmip:clamp",
      "image:env/outer_up.tga:mip:picmip:clamp",
      "image:env/outer_dn.tga:mip:picmip:clamp",
      "image:later:mip:picmip:repeat",
    ]);
    expect(result.sky?.outer?.image("rt")).toBe(host.imageResults[0]?.frame);
    expect(result.sky?.cloudHeight).toBe(0);
    expect(result.sky?.inner).toBeNull();
  });

  test("preserves negative cloud height and source atof empty values for an incomplete sun", async () => {
    const negative = catalogEntry("negative { skyParms - -128 - }");
    const negativeHost = new RecordingRegistrationHost();
    const negativeResult = await negative.program.register(negativeHost);
    expect(negativeHost.events).toEqual(["sky:-128"]);
    expect(negativeResult.sky).toEqual({ outer: null, inner: null, cloudHeight: -128 });

    const incomplete = catalogEntry(`sun {
      q3map_sun
      { map swallowed }
    }`);
    const sunHost = new RecordingRegistrationHost();
    const sunResult = await incomplete.program.register(sunHost);
    expect(sunHost.events).toEqual(["sun"]);
    expect(sunHost.suns).toEqual([{ light: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }]);
    expect(sunResult.kind).toBe("defaulted");
    expect(sunResult.stages).toEqual([]);
  });

  test("keeps duplicate catalog entries in source order, including a rejected first definition", () => {
    const inspection = inspectShaderScript("dup { rejected } dup { { map accepted } }", "duplicates.shader");
    expect(inspection.entries.map(entry => [entry.name, entry.textResult.kind])).toEqual([
      ["dup", "rejected"], ["dup", "accepted"],
    ]);
  });
});

describe("material evaluation", () => {
  test("waveforms use source table quantization and negative-time truncation", () => {
    const wave: Waveform = { kind: "triangle", base: 2, amplitude: 4, phase: 0, frequency: 1 };
    expect(evaluateWaveform(wave, 0)).toBe(2);
    expect(evaluateWaveform(wave, 0.25)).toBe(6);
    expect(evaluateWaveform(wave, 0.75)).toBe(-2);
    expect(evaluateWaveform({ ...wave, kind: "square" }, 0.5)).toBe(-2);
    expect(evaluateWaveform({ ...wave, kind: "sawtooth", base: 0, amplitude: 1 }, -1 / 2048)).toBe(0);
    expect(evaluateWaveform({ ...wave, kind: "inversesawtooth", base: 0, amplitude: 1 }, 0.25)).toBe(0.75);
    expect(evaluateWaveform({ ...wave, kind: "sin", base: 0, amplitude: 1 }, 0.25)).toBeCloseTo(0.9999988079, 7);
    expect(() => evaluateWaveform({ ...wave, kind: "noise" }, 0)).toThrow("R_NoiseGet4f");
  });

  test("stores tcGen and affine intermediate floats before later modifiers", () => {
    const generated = evaluateTexCoords(stage("map test\ntcGen vector ( 1 1 1 ) ( 0 0 0 )"), { x: 0, y: 0 },
      { x: 16777216, y: 1, z: -16777216 }, normal, 0);
    expect(generated).toEqual({ x: 0, y: 0 });
    expect(evaluateTexCoords(stage("map test\ntcMod transform 16777216 0 1 0 -16777216 0"),
      { x: 1, y: 1 }, origin, normal, 0)).toEqual({ x: 0, y: 0 });
    expect(evaluateTexCoords(stage("map test\ntcMod scale 3 3"),
      { x: 1 + 2 ** -24, y: 1 + 2 ** -24 }, origin, normal, 0)).toEqual({ x: 3, y: 3 });
  });

  test("clamps a scroll offset before adding small coordinates", () => {
    const uv = { x: 2 ** -30, y: 2 ** -30 };
    expect(evaluateTexCoords(stage("map test\ntcMod scroll 16777216 -16777216"), uv, origin, normal, 1)).toEqual(uv);
    expect(evaluateTexCoords(stage("map test\ntcMod entityTranslate"), uv, origin, normal, 1,
      { shaderTexCoord: { x: 16777216, y: -16777216 } })).toEqual(uv);
  });

  test("composes scale, negative scroll and affine transform in source order", () => {
    const result = evaluateTexCoords(stage("map test\ntcMod scale 2 3\ntcMod scroll -0.25 0.5\ntcMod transform 1 2 3 4 5 6"), { x: 0.25, y: 0.5 }, origin, normal, 1);
    expect(result).toEqual({ x: 12.25, y: 16.5 });
  });

  test("rotation rounds the table index and stores the source affine matrix", () => {
    const f = Math.fround;
    const sine = (index: number): number => f(Math.sin(f(((index & 1023) * 360) / 1023) * Math.PI / 180));
    const sin = sine(-1187), cos = sine(-1187 + 256), s = f(0.123), t = f(0.456);
    const result = evaluateTexCoords(stage("map test\ntcMod rotate 24.191574096679688"), { x: s, y: t }, origin, normal, 17.25);
    expect(result).toEqual({
      x: f(f(f(s * cos) + f(t * -sin)) + f(0.5 - 0.5 * cos + 0.5 * sin)),
      y: f(f(f(s * sin) + f(t * cos)) + f(0.5 - 0.5 * sin - 0.5 * cos)),
    });
  });

  test("rotates and stretches about the texture center, including sine table endpoint", () => {
    const rotated = evaluateTexCoords(stage("map test\ntcMod rotate 90"), { x: 1, y: 0.5 }, origin, normal, 1);
    expect(rotated.x).toBeCloseTo(0.5, 5);
    expect(rotated.y).toBeCloseTo(0.0000053048, 6);
    expect(evaluateTexCoords(stage("map test\ntcMod stretch sin 2 0 0 0"), { x: 1, y: 0 }, origin, normal, 1)).toEqual({ x: 0.75, y: 0.25 });
  });

  test("turbulence depends on vertex position and ignores the waveform base", () => {
    const result = evaluateTexCoords(stage("map test\ntcMod turb 999 0.5 0 0"), { x: 0.25, y: 0.5 }, { x: 128, y: 256, z: 128 }, normal, 0);
    expect(result.x).toBeCloseTo(0.7499994, 6);
    expect(result.y).toBeCloseTo(0.9999994, 6);
  });

  test("turbulence rounds the position sum before its promoted phase expression", () => {
    const result = evaluateTexCoords(stage("map test\ntcMod turb 0 1 0 0"), { x: 0, y: 0 },
      { x: 16777216, y: 0, z: 1 }, normal, 0);
    expect(result).toEqual({ x: 0, y: 0 });
  });

  test("evaluates vector and lightmap generation and explicit entity context", () => {
    expect(evaluateTexCoords(stage("map test\ntcGen vector ( 1 0 0 ) ( 0 0.5 0 )"), { x: 0, y: 0 }, { x: 2, y: 8, z: 4 }, normal, 0)).toEqual({ x: 2, y: 4 });
    const lightmap = stage("map $lightmap");
    expect(() => evaluateTexCoords(lightmap, { x: 1, y: 1 }, origin, normal, 0)).toThrow("Lightmap tcGen requires");
    expect(evaluateTexCoords(lightmap, { x: 1, y: 1 }, origin, normal, 0, { lightmap: { x: 0.2, y: 0.3 } })).toEqual({ x: Math.fround(0.2), y: Math.fround(0.3) });
    const entity = stage("map test\ntcMod entityTranslate");
    expect(() => evaluateTexCoords(entity, { x: 0, y: 0 }, origin, normal, 1)).toThrow("entityTranslate requires");
    expect(evaluateTexCoords(entity, { x: 0, y: 0 }, origin, normal, 2, { shaderTexCoord: { x: 0.25, y: -0.25 } })).toEqual({ x: 0.5, y: 0.5 });
  });

  test("environment generation preserves source fast-normalization error", () => {
    const environment = stage("map test\ntcGen environment");
    expect(() => evaluateTexCoords(environment, { x: 0, y: 0 }, origin, normal, 0)).toThrow("view origin");
    const result = evaluateTexCoords(environment, { x: 0, y: 0 }, origin, normal, 0, { viewOrigin: normal });
    expect(result.x).toBe(0.5);
    expect(result.y).toBeCloseTo(0.0008464157, 7);
  });
});

const dataPath = Bun.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const products: readonly Product[] = ["baseq3", "missionpack"];
for (const product of products) {
  test.skipIf(!existsSync(join(dataPath, product, "pak0.pk3")))(`accounts for every merged retail ${product} shader definition`, async () => {
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    const files = vfs.list("scripts").filter(path => path.endsWith(".shader"));
    let definitions = 0;
    let accepted = 0;
    let rejected = 0;
    for (const path of files) {
      const source = new TextDecoder().decode(await vfs.read(path));
      const result = inspectShaderScript(source, path);
      const tokenizer = new Tokenizer(source, path);
      let depth = 0;
      let names = 0;
      for (let token = tokenizer.next(); token !== undefined; token = tokenizer.next()) {
        if (token.value === "{") depth++;
        else if (token.value === "}") depth--;
        else if (depth === 0) names++;
      }
      expect(depth).toBe(0);
      expect(result.entries.length).toBe(names);
      const registrationHost = new RecordingRegistrationHost();
      for (const entry of result.entries) {
        const registered = await entry.program.register(registrationHost);
        expect(registered.definition.name).toBe(entry.name);
        expect(registered.stages).toHaveLength(registered.definition.stages.length);
        if (entry.textResult.kind === "rejected") {
          expect(registered.kind).toBe("defaulted");
          expect(entry.textResult.error.source).toBe(path);
          expect(entry.textResult.error.reason).toBe("source-rejection");
          expect(entry.textResult.error.message).toMatch(/WARNING: unknown (general shader )?parameter|Incomplete fogParms color vector|Shader has no stages/);
        } else {
          expect(registered.kind).toBe("defined");
          const definition = entry.textResult.definition;
          for (const pass of definition.stages) expect(stageState(pass, definition.cull).depthWrite).toBe(pass.depthWrite);
        }
      }
      definitions += names;
      accepted += acceptedDefinitions(result).length;
      rejected += result.entries.length - acceptedDefinitions(result).length;
    }
    expect(files.length).toBeGreaterThanOrEqual(30);
    expect(definitions).toBeGreaterThan(1400);
    expect(accepted).toBeGreaterThan(1300);
    expect(accepted + rejected).toBe(definitions);
  });
}
