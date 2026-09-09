/*
 * Shader parsing and texture evaluation translated from renderer/tr_shader.c,
 * tr_shade_calc.c and tr_init.c in Quake III Arena.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import { dot3, normalize3, scale3, sub3 } from "../core/math.ts";
import { nativeAtof } from "../core/native-numeric.ts";
import type { Vec2, Vec3 } from "../core/math.ts";
import { normalizeFast3, rendererSine } from "../core/renderer-math.ts";
import { Tokenizer } from "../core/text.ts";
import { CommonError } from "../core/common-error.ts";
import { CommonParseCursor, CommonParseState } from "../core/common-parse.ts";
import type { Token } from "../core/text.ts";
import type { BlendFactor, RenderState } from "./types.ts";
import type { RendererImage } from "./image-resource.ts";
import type { ShaderCinematicSource } from "./cinematic-command.ts";
import { SourceStateBit, sourceStateBits } from "./source-state.ts";

export interface Waveform {
  readonly kind: "none" | "sin" | "square" | "triangle" | "sawtooth" | "inversesawtooth" | "noise";
  readonly base: number;
  readonly amplitude: number;
  readonly phase: number;
  readonly frequency: number;
}

/** Numeric values and retained fields from renderer shaderStage_t storage. */
export enum SourceWaveFunction {
  None = 0,
  Sin = 1,
  Square = 2,
  Triangle = 3,
  Sawtooth = 4,
  InverseSawtooth = 5,
  Noise = 6,
}

export enum SourceColorGenerator {
  Bad = 0,
  IdentityLighting = 1,
  Identity = 2,
  Entity = 3,
  OneMinusEntity = 4,
  ExactVertex = 5,
  Vertex = 6,
  OneMinusVertex = 7,
  Waveform = 8,
  LightingDiffuse = 9,
  Fog = 10,
  Const = 11,
}

export enum SourceAlphaGenerator {
  Identity = 0,
  Skip = 1,
  Entity = 2,
  OneMinusEntity = 3,
  Vertex = 4,
  OneMinusVertex = 5,
  LightingSpecular = 6,
  Waveform = 7,
  Portal = 8,
  Const = 9,
}

export enum SourceTexCoordGenerator {
  Bad = 0,
  Identity = 1,
  Lightmap = 2,
  Texture = 3,
  EnvironmentMapped = 4,
  Fog = 5,
  Vector = 6,
}

export interface SourceWaveStorage {
  readonly func: SourceWaveFunction;
  readonly base: number;
  readonly amplitude: number;
  readonly phase: number;
  readonly frequency: number;
}

export interface SourceShaderStageState {
  readonly active: boolean;
  /** Authoritative GL_State input; an incomplete factor has no semantic BlendFactor value. */
  readonly stateBits: number;
  readonly rgbGen: SourceColorGenerator;
  readonly alphaGen: SourceAlphaGenerator;
  readonly tcGen: SourceTexCoordGenerator;
  readonly rgbWave: SourceWaveStorage;
  readonly alphaWave: SourceWaveStorage;
  /** Once set by `$lightmap`, ParseStage never clears this field. */
  readonly isLightmap: boolean;
  /** Present in textureBundle_t but never assigned by the original renderer. */
  readonly vertexLightmap: boolean;
}

export interface FinishedStageImage {
  readonly image: RendererImage;
}

export type FinishedImagePlayback =
  | { readonly kind: "single"; readonly image: FinishedStageImage }
  | { readonly kind: "animation"; readonly frequency: number; readonly frames: readonly [FinishedStageImage, ...FinishedStageImage[]] };

/** Registered bundle data retained by a finished material pass. */
export type FinishedStageBinding =
  | { readonly kind: "images"; readonly playback: FinishedImagePlayback }
  | { readonly kind: "video"; readonly source: ShaderCinematicSource }
  | { readonly kind: "retain-current-texture" };

export interface SourceImageRequest {
  readonly name: string;
  readonly mipmap: boolean;
  readonly allowPicmip: boolean;
  readonly wrap: "repeat" | "clamp";
}

export interface RegisteredImage {
  readonly frame: FinishedStageImage;
  readonly tmu: 0 | 1;
}

export interface RegisteredShaderVideo {
  readonly source: ShaderCinematicSource;
  readonly image: RegisteredImage;
}

export type RegisteredShaderStage =
  | { readonly kind: "loaded"; readonly tmu: 0 | 1; readonly binding: FinishedStageBinding }
  | { readonly kind: "missing" };

export interface RegisteredSun {
  readonly light: Vec3;
  readonly direction: Vec3;
}

export type SourceSkyFaceName = "rt" | "bk" | "lf" | "ft" | "up" | "dn";

export interface RegisteredSkyBox {
  image(face: SourceSkyFaceName): FinishedStageImage;
}

export interface RegisteredSky {
  readonly outer: RegisteredSkyBox | null;
  readonly inner: RegisteredSkyBox | null;
  readonly cloudHeight: number;
}

export type ColorGenerator =
  | { readonly kind: "identity" | "identitylighting" | "entity" | "oneminusentity" | "vertex" | "exactvertex" | "lightingdiffuse" | "oneminusvertex" }
  | { readonly kind: "const"; readonly color: Vec3 }
  | { readonly kind: "wave"; readonly wave: Waveform };

export type AlphaGenerator =
  | { readonly kind: "identity" | "entity" | "oneminusentity" | "vertex" | "lightingspecular" | "oneminusvertex" }
  | { readonly kind: "const"; readonly alpha: number }
  | { readonly kind: "wave"; readonly wave: Waveform }
  | { readonly kind: "portal"; readonly range: number };

export type TexCoordGenerator =
  | { readonly kind: "texture" | "lightmap" | "environment" }
  | { readonly kind: "vector"; readonly s: Vec3; readonly t: Vec3 };

export type TexCoordModifier =
  | { readonly kind: "scale" | "scroll"; readonly amount: Vec2 }
  | { readonly kind: "stretch" | "turb"; readonly wave: Waveform }
  | { readonly kind: "rotate"; readonly degreesPerSecond: number }
  | { readonly kind: "transform"; readonly m00: number; readonly m01: number; readonly m10: number; readonly m11: number; readonly translation: Vec2 }
  | { readonly kind: "entitytranslate" | "none" };

export type ShaderMap =
  | { readonly kind: "image"; readonly name: string; readonly clamp: boolean }
  | { readonly kind: "lightmap" | "whiteimage" }
  | { readonly kind: "animation"; readonly frequency: number; readonly frames: readonly string[] }
  | { readonly kind: "video"; readonly name: string }
  | { readonly kind: "none" };

export interface ShaderStage {
  readonly map: ShaderMap;
  readonly blend: RenderState["blend"];
  readonly depthFunc: RenderState["depthTest"];
  readonly depthWrite: boolean;
  readonly alphaFunc: RenderState["alphaTest"];
  readonly detail: boolean;
  readonly rgbGen: ColorGenerator;
  readonly alphaGen: AlphaGenerator;
  readonly tcGen: TexCoordGenerator;
  readonly tcMods: readonly TexCoordModifier[];
}

/** A stage produced by ParseStage, before FinishShader mutates its C fields. */
export interface ParsedShaderStage extends ShaderStage {
  readonly sourceState: SourceShaderStageState;
}

export type VertexDeformation =
  | { readonly kind: "projectionshadow" | "autosprite" | "autosprite2" | "none" }
  | { readonly kind: "text"; readonly index: number }
  | { readonly kind: "wave"; readonly spread: number; readonly wave: Waveform }
  | { readonly kind: "normal"; readonly amplitude: number; readonly frequency: number }
  | { readonly kind: "move"; readonly direction: Vec3; readonly wave: Waveform }
  | { readonly kind: "bulge"; readonly width: number; readonly height: number; readonly speed: number };

export interface ShaderDefinition {
  readonly name: string;
  readonly stages: readonly ParsedShaderStage[];
  readonly surfaceParms: readonly string[];
  readonly cull: RenderState["cull"];
  readonly sort: number | null;
  readonly sky: { readonly outerBox: string | null; readonly cloudHeight: number; readonly innerBox: string | null } | null;
  readonly fog: { readonly color: Vec3; readonly depthForOpaque: number } | null;
  readonly sun: { readonly color: Vec3; readonly intensity: number; readonly azimuth: number; readonly elevation: number } | null;
  readonly deforms: readonly VertexDeformation[];
  readonly polygonOffset: boolean;
  readonly noMipMaps: boolean;
  readonly noPicMip: boolean;
  readonly entityMergable: boolean;
  /** One shader-wide value; the last alphaGen portal directive wins. */
  readonly portalRange: number;
  readonly clampTime: number;
  readonly warnings: readonly ShaderDiagnostic[];
  /** qer*, q3map* except q3map_sun, tesssize and light have no renderer effect. */
  readonly compilerDirectives: readonly { readonly name: string; readonly arguments: readonly string[] }[];
}

export interface ShaderDiagnostic {
  readonly source: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export class ShaderParseError extends Error {
  constructor(readonly source: string, readonly line: number, readonly column: number, message: string, readonly reason: "source-rejection" | "validation" = "source-rejection") {
    super(`${source}:${line}:${column}: ${message}`);
    this.name = "ShaderParseError";
  }
}

export interface ShaderRegistrationHost {
  readonly whiteImage: RegisteredImage;
  readonly defaultImage: RegisteredImage;
  readonly lightmapImage: RegisteredImage;
  findImage(request: SourceImageRequest): Promise<RegisteredImage | null>;
  playShaderCinematic(name: string): Promise<RegisteredShaderVideo | null>;
  applySun(sun: RegisteredSun): void;
  initializeSkyTexCoords(height: number): void;
  printWarning(message: string): void;
}

export type ShaderRegistrationFailure =
  | { readonly kind: "source-text"; readonly error: ShaderParseError }
  | { readonly kind: "missing-image"; readonly request: SourceImageRequest };

interface RegisteredExplicitShaderFields {
  readonly definition: ShaderDefinition;
  readonly stages: readonly RegisteredShaderStage[];
  readonly sky: RegisteredSky | null;
}

export type RegisteredExplicitShader = RegisteredExplicitShaderFields & (
  | { readonly kind: "defined" }
  | { readonly kind: "defaulted"; readonly failure: ShaderRegistrationFailure }
);

export abstract class ShaderRegistrationProgram {
  protected constructor() {}
  abstract register(host: ShaderRegistrationHost): Promise<RegisteredExplicitShader>;
}

export interface ShaderCatalogEntry {
  readonly name: string;
  readonly program: ShaderRegistrationProgram;
  readonly textResult:
    | { readonly kind: "accepted"; readonly definition: ShaderDefinition }
    | { readonly kind: "rejected"; readonly partial: ShaderDefinition; readonly error: ShaderParseError };
}

export interface ShaderScriptInspection {
  readonly entries: readonly ShaderCatalogEntry[];
}

/** q_shared.c COM_StripExtension stops at the first dot, including directory dots. */
export function stripShaderExtension(name: string): string {
  const end = name.search(/[.\0]/);
  return end === -1 ? name : name.slice(0, end);
}

/** A Q_stricmp lookup key. Path separators remain distinct in the comparison. */
export function normalizeShaderName(name: string): string {
  return stripShaderExtension(name).replace(/[A-Z]/g, letter => letter.toLowerCase());
}

/** tr_shader.c generateHashValue folds separators only for bucket selection. */
export function shaderNameHash(name: string, size: 1024 | 2048): number {
  let hash = 0;
  for (let index = 0; index < name.length; index++) {
    let letter = name.charCodeAt(index);
    if (letter === 0 || letter === 46) break;
    if (letter >= 65 && letter <= 90) letter += 32;
    if (letter === 92) letter = 47;
    if (letter >= 128 && letter <= 255) letter -= 256;
    hash = (hash + letter * (index + 119)) | 0;
  }
  return (hash ^ (hash >> 10) ^ (hash >> 20)) & (size - 1);
}

/** q_shared.c Q_stricmp compares through NUL and folds only ASCII letters. */
export function sameShaderName(first: string, second: string): boolean {
  for (let index = 0; index < 99999; index++) {
    let a = index < first.length ? first.charCodeAt(index) : 0;
    let b = index < second.length ? second.charCodeAt(index) : 0;
    if (a >= 65 && a <= 90) a += 32;
    if (b >= 65 && b <= 90) b += 32;
    if (a !== b) return false;
    if (a === 0) return true;
  }
  return true;
}

function normalizeImageName(name: string): string {
  return name.startsWith("*") ? name : name.replaceAll("\\", "/").toLowerCase();
}

function sourceWave(wave: Waveform): SourceWaveStorage {
  let func: SourceWaveFunction;
  switch (wave.kind) {
    case "none": func = SourceWaveFunction.None; break;
    case "sin": func = SourceWaveFunction.Sin; break;
    case "square": func = SourceWaveFunction.Square; break;
    case "triangle": func = SourceWaveFunction.Triangle; break;
    case "sawtooth": func = SourceWaveFunction.Sawtooth; break;
    case "inversesawtooth": func = SourceWaveFunction.InverseSawtooth; break;
    case "noise": func = SourceWaveFunction.Noise; break;
  }
  return { func, base: wave.base, amplitude: wave.amplitude, phase: wave.phase, frequency: wave.frequency };
}

function sourceColorGenerator(generator: ColorGenerator): SourceColorGenerator {
  switch (generator.kind) {
    case "identitylighting": return SourceColorGenerator.IdentityLighting;
    case "identity": return SourceColorGenerator.Identity;
    case "entity": return SourceColorGenerator.Entity;
    case "oneminusentity": return SourceColorGenerator.OneMinusEntity;
    case "exactvertex": return SourceColorGenerator.ExactVertex;
    case "vertex": return SourceColorGenerator.Vertex;
    case "oneminusvertex": return SourceColorGenerator.OneMinusVertex;
    case "wave": return SourceColorGenerator.Waveform;
    case "lightingdiffuse": return SourceColorGenerator.LightingDiffuse;
    case "const": return SourceColorGenerator.Const;
  }
}

function sourceAlphaGenerator(generator: AlphaGenerator): SourceAlphaGenerator {
  switch (generator.kind) {
    case "identity": return SourceAlphaGenerator.Identity;
    case "entity": return SourceAlphaGenerator.Entity;
    case "oneminusentity": return SourceAlphaGenerator.OneMinusEntity;
    case "vertex": return SourceAlphaGenerator.Vertex;
    case "oneminusvertex": return SourceAlphaGenerator.OneMinusVertex;
    case "lightingspecular": return SourceAlphaGenerator.LightingSpecular;
    case "wave": return SourceAlphaGenerator.Waveform;
    case "portal": return SourceAlphaGenerator.Portal;
    case "const": return SourceAlphaGenerator.Const;
  }
}

function sourceTexCoordGenerator(generator: TexCoordGenerator): SourceTexCoordGenerator {
  switch (generator.kind) {
    case "texture": return SourceTexCoordGenerator.Texture;
    case "lightmap": return SourceTexCoordGenerator.Lightmap;
    case "environment": return SourceTexCoordGenerator.EnvironmentMapped;
    case "vector": return SourceTexCoordGenerator.Vector;
  }
}

interface ShaderStageSlot { readonly index: number }
interface ShaderAnimationSlot { readonly index: number }

type StageImageTarget =
  | { readonly kind: "primary"; readonly stage: ShaderStageSlot }
  | { readonly kind: "animation"; readonly stage: ShaderStageSlot; readonly frame: ShaderAnimationSlot; readonly countAfterSuccess: number };

type RegistrationInstruction =
  | { readonly kind: "warning"; readonly message: string }
  | { readonly kind: "find-stage-image"; readonly request: SourceImageRequest; readonly target: StageImageTarget; readonly missing: ShaderDefinition }
  | { readonly kind: "set-animation-frequency"; readonly stage: ShaderStageSlot; readonly frequency: number }
  | { readonly kind: "bind-white"; readonly stage: ShaderStageSlot }
  | { readonly kind: "bind-lightmap"; readonly stage: ShaderStageSlot }
  | { readonly kind: "play-video"; readonly stage: ShaderStageSlot; readonly name: string }
  | { readonly kind: "find-sky-image"; readonly box: "outer" | "inner"; readonly face: SourceSkyFaceName; readonly request: SourceImageRequest }
  | { readonly kind: "initialize-sky"; readonly height: number }
  | { readonly kind: "apply-sun"; readonly value: RegisteredSun }
  | { readonly kind: "drop"; readonly message: string };

type RegistrationTerminal =
  | { readonly kind: "accepted"; readonly definition: ShaderDefinition }
  | { readonly kind: "rejected"; readonly partial: ShaderDefinition; readonly error: ShaderParseError };

interface WorkingRegisteredBundle {
  readonly images: (RegisteredImage | null)[];
  animationCount: number;
  animationFrequency: number;
  videoEnabled: boolean;
  video: RegisteredShaderVideo | null;
}

interface WorkingRegisteredSkyBox {
  rt: FinishedStageImage | null;
  bk: FinishedStageImage | null;
  lf: FinishedStageImage | null;
  ft: FinishedStageImage | null;
  up: FinishedStageImage | null;
  dn: FinishedStageImage | null;
}

interface WorkingRegisteredSky {
  readonly outer: WorkingRegisteredSkyBox;
  readonly inner: WorkingRegisteredSkyBox;
  cloudHeight: number;
}

function checkedStageSlot(index: number): ShaderStageSlot {
  if (!Number.isInteger(index) || index < 0 || index >= 8) throw new RangeError("shader stage slot must be 0..7");
  return { index };
}

function checkedAnimationSlot(index: number): ShaderAnimationSlot {
  if (!Number.isInteger(index) || index < 0 || index >= 8) throw new RangeError("shader animation slot must be 0..7");
  return { index };
}

function emptyRegisteredBundle(): WorkingRegisteredBundle {
  return { images: Array.from({ length: 8 }, () => null), animationCount: 0, animationFrequency: 0,
    videoEnabled: false, video: null };
}

function emptyRegisteredSkyBox(): WorkingRegisteredSkyBox {
  return { rt: null, bk: null, lf: null, ft: null, up: null, dn: null };
}

function registeredBundleAt(bundles: readonly WorkingRegisteredBundle[], stage: ShaderStageSlot): WorkingRegisteredBundle {
  const bundle = bundles[stage.index];
  if (bundle === undefined) throw new RangeError(`shader stage slot ${stage.index} is unavailable`);
  return bundle;
}

function setSkyImage(box: WorkingRegisteredSkyBox, face: SourceSkyFaceName, image: FinishedStageImage): void {
  switch (face) {
    case "rt": box.rt = image; break;
    case "bk": box.bk = image; break;
    case "lf": box.lf = image; break;
    case "ft": box.ft = image; break;
    case "up": box.up = image; break;
    case "dn": box.dn = image; break;
  }
}

function registeredSkyBox(box: WorkingRegisteredSkyBox): RegisteredSkyBox | null {
  const { rt, bk, lf, ft, up, dn } = box;
  if (rt === null && bk === null && lf === null && ft === null && up === null && dn === null) return null;
  if (rt === null || bk === null || lf === null || ft === null || up === null || dn === null) {
    throw new Error("source sky box registration became incomplete");
  }
  return {
    image(face: SourceSkyFaceName): FinishedStageImage {
      switch (face) {
        case "rt": return rt;
        case "bk": return bk;
        case "lf": return lf;
        case "ft": return ft;
        case "up": return up;
        case "dn": return dn;
      }
    },
  };
}

function registeredSky(sky: WorkingRegisteredSky): RegisteredSky | null {
  const hasOuter = sky.outer.rt !== null || sky.outer.bk !== null || sky.outer.lf !== null
    || sky.outer.ft !== null || sky.outer.up !== null || sky.outer.dn !== null;
  const hasInner = sky.inner.rt !== null || sky.inner.bk !== null || sky.inner.lf !== null
    || sky.inner.ft !== null || sky.inner.up !== null || sky.inner.dn !== null;
  if (!hasOuter && !hasInner && sky.cloudHeight === 0) return null;
  return { outer: registeredSkyBox(sky.outer), inner: registeredSkyBox(sky.inner), cloudHeight: sky.cloudHeight };
}

function registeredStage(bundle: WorkingRegisteredBundle): RegisteredShaderStage {
  const primary = bundle.images[0];
  if (primary === undefined || primary === null) return { kind: "missing" };
  if (bundle.videoEnabled) {
    if (bundle.video === null) return { kind: "loaded", tmu: primary.tmu, binding: { kind: "retain-current-texture" } };
    return { kind: "loaded", tmu: primary.tmu,
      binding: { kind: "video", source: bundle.video.source } };
  }
  if (bundle.animationCount > 0) {
    const first = bundle.images[0];
    if (first === undefined || first === null) return { kind: "missing" };
    const rest: FinishedStageImage[] = [];
    for (let index = 1; index < bundle.animationCount; index++) {
      const frame = bundle.images[index];
      if (frame === undefined || frame === null) throw new Error("source animation count includes an unregistered frame");
      rest.push(frame.frame);
    }
    return { kind: "loaded", tmu: primary.tmu,
      binding: { kind: "images", playback: { kind: "animation", frequency: bundle.animationFrequency, frames: [first.frame, ...rest] } } };
  }
  return { kind: "loaded", tmu: primary.tmu, binding: { kind: "images", playback: { kind: "single", image: primary.frame } } };
}

function registeredStages(definition: ShaderDefinition, bundles: readonly WorkingRegisteredBundle[]): readonly RegisteredShaderStage[] {
  const result: RegisteredShaderStage[] = [];
  for (let index = 0; index < definition.stages.length; index++) {
    const bundle = bundles[index];
    if (bundle === undefined) throw new Error("shader definition exceeds the registered stage store");
    result.push(registeredStage(bundle));
  }
  return result;
}

class CompiledShaderRegistrationProgram extends ShaderRegistrationProgram {
  constructor(private readonly instructions: readonly RegistrationInstruction[], private readonly terminal: RegistrationTerminal) { super(); }

  private *parse(): Generator<RegistrationInstruction, RegistrationTerminal, void> {
    yield* this.instructions;
    return this.terminal;
  }

  register(host: ShaderRegistrationHost): Promise<RegisteredExplicitShader> {
    return registerShader(this.parse(), host);
  }
}

/** FindShaderInShaderText returns the cursor after the matched name. The body is
 * consumed only when R_FindShader reaches ParseShader. */
export class SourceShaderRegistrationProgram extends ShaderRegistrationProgram {
  constructor(private readonly cursor: CommonParseCursor, private readonly offset: number | null,
    private readonly source: string, private readonly name: string) { super(); }

  register(host: ShaderRegistrationHost): Promise<RegisteredExplicitShader> {
    return registerShader(new ShaderParser(this.cursor.source, this.source, this.name,
      { cursor: this.cursor, offset: this.offset }, message => host.printWarning(message)).definition(this.name), host);
  }
}

async function registerShader(parser: Generator<RegistrationInstruction, RegistrationTerminal, void>,
  host: ShaderRegistrationHost): Promise<RegisteredExplicitShader> {
  const bundles = Array.from({ length: 8 }, emptyRegisteredBundle);
  const sky: WorkingRegisteredSky = { outer: emptyRegisteredSkyBox(), inner: emptyRegisteredSkyBox(), cloudHeight: 0 };
  let step = parser.next();
  while (!step.done) {
    const instruction = step.value;
    switch (instruction.kind) {
      case "warning": host.printWarning(instruction.message); break;
      case "find-stage-image": {
        const image = await host.findImage(instruction.request);
        const bundle = registeredBundleAt(bundles, instruction.target.stage);
        bundle.images[instruction.target.kind === "primary" ? 0 : instruction.target.frame.index] = image;
        if (image === null) {
          host.printWarning(`WARNING: R_FindImageFile could not find '${instruction.request.name}' in shader '${instruction.missing.name}'\n`);
          return { kind: "defaulted", failure: { kind: "missing-image", request: instruction.request }, definition: instruction.missing,
            stages: registeredStages(instruction.missing, bundles), sky: registeredSky(sky) };
        }
        if (instruction.target.kind === "animation") bundle.animationCount = instruction.target.countAfterSuccess;
        break;
      }
      case "set-animation-frequency":
        registeredBundleAt(bundles, instruction.stage).animationFrequency = instruction.frequency;
        break;
      case "bind-white":
        registeredBundleAt(bundles, instruction.stage).images[0] = host.whiteImage;
        break;
      case "bind-lightmap":
        registeredBundleAt(bundles, instruction.stage).images[0] = host.lightmapImage;
        break;
      case "play-video": {
        const video = await host.playShaderCinematic(instruction.name);
        const bundle = registeredBundleAt(bundles, instruction.stage);
        bundle.video = video;
        if (video !== null) { bundle.videoEnabled = true; bundle.images[0] = video.image; }
        break;
      }
      case "find-sky-image": {
        const image = await host.findImage(instruction.request);
        setSkyImage(instruction.box === "outer" ? sky.outer : sky.inner, instruction.face, (image ?? host.defaultImage).frame);
        break;
      }
      case "initialize-sky":
        sky.cloudHeight = instruction.height;
        host.initializeSkyTexCoords(instruction.height);
        break;
      case "apply-sun": host.applySun(instruction.value); break;
      case "drop": throw new CommonError("drop", instruction.message);
    }
    step = parser.next();
  }
  const terminal = step.value;
  if (terminal.kind === "rejected") {
    return { kind: "defaulted", failure: { kind: "source-text", error: terminal.error }, definition: terminal.partial,
      stages: registeredStages(terminal.partial, bundles), sky: registeredSky(sky) };
  }
  return { kind: "defined", definition: terminal.definition, stages: registeredStages(terminal.definition, bundles),
    sky: registeredSky(sky) };
}

class ShaderParser {
  private readonly tokens: Tokenizer;
  private readonly common = new CommonParseState();
  private pending: Token | undefined;
  private depth = 0;
  private warnings: ShaderDiagnostic[] = [];
  private portalRange = 0;
  private shaderName = "";
  private warningInstructions: RegistrationInstruction[] | null = null;
  private location: Token = { value: "", line: 1, column: 1, quoted: false };

  constructor(text: string, private readonly source: string, private readonly registrationName: string | null = null,
    private readonly input: { readonly cursor: CommonParseCursor; offset: number | null } | null = null,
    private readonly printWarning: (message: string) => void = () => {}) {
    this.tokens = new Tokenizer(text, source);
  }

  private sourceNext(allowLineBreaks: boolean): Token | undefined {
    if (this.input === null) return this.tokens.next(allowLineBreaks);
    const { cursor } = this.input;
    cursor.offset = this.input.offset;
    const value = this.common.parse(cursor, allowLineBreaks);
    this.input.offset = cursor.offset;
    return value.length === 0 ? undefined : { value, line: this.common.line + 1, column: 1, quoted: false };
  }

  private next(allowLineBreaks = true): Token | undefined {
    const wasPending = this.pending !== undefined;
    const token = this.pending ?? this.sourceNext(allowLineBreaks);
    this.pending = undefined;
    if (token !== undefined) {
      this.location = token;
      if (!wasPending) {
        if (token.value.startsWith("{")) this.depth++;
        if (token.value.startsWith("}")) this.depth--;
      }
    }
    return token;
  }

  private fail(message: string): never {
    throw new ShaderParseError(this.source, this.location.line, this.location.column, message);
  }

  private warn(message: string): void {
    this.warnings.push({ source: this.source, line: this.location.line, column: this.location.column, message });
    this.warningInstructions?.push({ kind: "warning", message });
    this.printWarning(message);
  }

  private reject(message: string): never { this.warn(message); this.fail(message); }

  private stageParameter(keyword: string): string {
    const token = this.next(false);
    if (token === undefined) this.reject(`WARNING: missing parameter for '${keyword}' keyword in shader '${this.shaderName}'\n`);
    return token.value;
  }

  private required(allowLineBreaks = false): string {
    const token = this.next(allowLineBreaks);
    if (token === undefined) this.fail("Missing shader parameter");
    return token.value;
  }

  private number(): number {
    return this.sourceAtof(this.required());
  }

  private expect(value: string, allowLineBreaks = false): void {
    const actual = this.required(allowLineBreaks);
    if (value === "{" ? !actual.startsWith(value) : actual !== value) this.fail(`Expected '${value}', received '${actual}'`);
  }

  private vector(): Vec3 {
    this.expect("(");
    const result = { x: this.number(), y: this.number(), z: this.number() };
    this.expect(")");
    return result;
  }

  private sourceVector(previous: Vec3): { readonly value: Vec3; readonly complete: boolean } {
    if (this.next(false)?.value !== "(") {
      this.warn(`WARNING: missing parenthesis in shader '${this.shaderName}'\n`);
      return { value: previous, complete: false };
    }
    let value = previous;
    const fields: readonly ("x" | "y" | "z")[] = ["x", "y", "z"];
    for (const field of fields) {
      const token = this.next(false);
      if (token === undefined) {
        this.warn(`WARNING: missing vector element in shader '${this.shaderName}'\n`);
        return { value, complete: false };
      }
      value = { ...value, [field]: this.sourceAtof(token.value) };
    }
    if (this.next(false)?.value !== ")") {
      this.warn(`WARNING: missing parenthesis in shader '${this.shaderName}'\n`);
      return { value, complete: false };
    }
    return { value, complete: true };
  }

  private lineArguments(): string[] {
    if (this.input !== null) {
      const { cursor } = this.input;
      cursor.offset = this.input.offset;
      this.common.skipRestOfLine(cursor);
      this.input.offset = cursor.offset;
      return [];
    }
    const args: string[] = [];
    for (;;) {
      const token = this.next(false);
      if (token === undefined) return args;
      if (token.value === "}" || token.value === "{") {
        this.pending = token;
        return args;
      }
      args.push(token.value);
    }
  }

  private sourceLineValue(): string | null {
    return this.next(false)?.value ?? null;
  }

  private sourceAtof(value: string): number {
    return Math.fround(nativeAtof(value));
  }

  private sunDirective(): { readonly source: NonNullable<ShaderDefinition["sun"]>; readonly registered: RegisteredSun } {
    const red = this.sourceAtof(this.sourceLineValue() ?? "");
    const green = this.sourceAtof(this.sourceLineValue() ?? "");
    const blue = this.sourceAtof(this.sourceLineValue() ?? "");
    const intensity = this.sourceAtof(this.sourceLineValue() ?? "");
    const azimuth = this.sourceAtof(this.sourceLineValue() ?? "");
    const elevation = this.sourceAtof(this.sourceLineValue() ?? "");
    const color = { x: red, y: green, z: blue };
    const light = scale3(normalize3(color), intensity);
    const azimuthRadians = Math.fround(Math.fround(azimuth / 180) * Math.PI);
    const elevationRadians = Math.fround(Math.fround(elevation / 180) * Math.PI);
    const direction = {
      x: Math.fround(Math.cos(azimuthRadians) * Math.cos(elevationRadians)),
      y: Math.fround(Math.sin(azimuthRadians) * Math.cos(elevationRadians)),
      z: Math.fround(Math.sin(elevationRadians)),
    };
    return { source: { color, intensity, azimuth, elevation }, registered: { light, direction } };
  }

  private *skyDirective(previous: ShaderDefinition["sky"]): Generator<RegistrationInstruction, ShaderDefinition["sky"], void> {
    const outerToken = this.next(false);
    if (outerToken === undefined) {
      this.warn(`WARNING: 'skyParms' missing parameter in shader '${this.shaderName}'\n`);
      return previous;
    }
    const outerName = outerToken.value === "-" ? previous?.outerBox ?? null : normalizeImageName(outerToken.value);
    if (outerToken.value !== "-") yield* this.skyImages("outer", outerToken.value, "clamp");

    const heightToken = this.next(false);
    if (heightToken === undefined) {
      this.warn(`WARNING: 'skyParms' missing parameter in shader '${this.shaderName}'\n`);
      return previous === null ? null : { ...previous, outerBox: outerName };
    }
    const parsedHeight = this.sourceAtof(heightToken.value);
    const cloudHeight = parsedHeight === 0 ? 512 : parsedHeight;
    yield { kind: "initialize-sky", height: cloudHeight };

    const innerToken = this.next(false);
    if (innerToken === undefined) {
      this.warn(`WARNING: 'skyParms' missing parameter in shader '${this.shaderName}'\n`);
      return previous === null ? null : { ...previous, outerBox: outerName, cloudHeight };
    }
    const innerName = innerToken.value === "-" ? previous?.innerBox ?? null : normalizeImageName(innerToken.value);
    if (innerToken.value !== "-") yield* this.skyImages("inner", innerToken.value, "repeat");
    return { outerBox: outerName, cloudHeight, innerBox: innerName };
  }

  private *skyImages(box: "outer" | "inner", base: string,
    wrap: SourceImageRequest["wrap"]): Generator<RegistrationInstruction, void, void> {
    const faces: readonly SourceSkyFaceName[] = ["rt", "bk", "lf", "ft", "up", "dn"];
    for (const face of faces) {
      yield { kind: "find-sky-image", box, face,
        request: { name: `${base}_${face}.tga`, mipmap: true, allowPicmip: true, wrap } };
    }
  }

  private wave(previous: Waveform | null = null, missing = `WARNING: missing waveform parm in shader '${this.shaderName}'\n`): Waveform {
    const token = this.next(false);
    if (token === undefined) {
      this.warn(missing);
      if (previous === null) this.fail(missing);
      return previous;
    }
    const name = token.value.toLowerCase();
    let kind: Waveform["kind"];
    switch (name) {
      case "sin": case "square": case "triangle": case "sawtooth": case "inversesawtooth": case "noise": kind = name; break;
      default: this.warn(`WARNING: invalid genfunc name '${token.value}' in shader '${this.shaderName}'\n`); kind = "sin"; break;
    }
    let result: Waveform = previous === null
      ? { kind, base: 0, amplitude: 0, phase: 0, frequency: 0 }
      : { ...previous, kind };
    const fields: readonly ("base" | "amplitude" | "phase" | "frequency")[] = ["base", "amplitude", "phase", "frequency"];
    for (const field of fields) {
      const value = this.next(false);
      if (value === undefined) {
        this.warn(missing);
        if (previous === null) this.fail(missing);
        return result;
      }
      this.pending = value;
      result = { ...result, [field]: this.number() };
    }
    return result;
  }

  private rgb(previousWave: Waveform): ColorGenerator | null {
    const token = this.next(false);
    if (token === undefined) {
      this.warn(`WARNING: missing parameters for rgbGen in shader '${this.shaderName}'\n`);
      return null;
    }
    const kind = token.value.toLowerCase();
    switch (kind) {
      case "identity": case "identitylighting": case "entity": case "oneminusentity": case "vertex":
      case "exactvertex": case "lightingdiffuse": case "oneminusvertex": return { kind };
      case "const": return { kind, color: this.vector() };
      case "wave": return { kind, wave: this.wave(previousWave) };
      default: this.warn(`WARNING: unknown rgbGen parameter '${token.value}' in shader '${this.shaderName}'\n`); return null;
    }
  }

  private alpha(previousWave: Waveform): AlphaGenerator | null {
    const token = this.next(false);
    if (token === undefined) {
      this.warn(`WARNING: missing parameters for alphaGen in shader '${this.shaderName}'\n`);
      return null;
    }
    const kind = token.value.toLowerCase();
    switch (kind) {
      case "identity": case "entity": case "oneminusentity": case "vertex": case "lightingspecular": case "oneminusvertex": return { kind };
      case "const": {
        const alpha = nativeAtof(this.sourceLineValue() ?? ""), integer = Math.trunc(255 * alpha);
        if (!Number.isFinite(integer) || integer < -2147483648 || integer > 2147483647)
          throw new ShaderParseError(this.source, this.location.line, this.location.column, "alphaGen const reaches undefined source byte conversion", "validation");
        return { kind, alpha };
      }
      case "wave": return { kind, wave: this.wave(previousWave) };
      case "portal": {
        const token = this.next(false);
        if (token === undefined) {
          this.portalRange = 256;
          this.warn(`WARNING: missing range parameter for alphaGen portal in shader '${this.shaderName}', defaulting to 256\n`);
          return { kind, range: 256 };
        }
        this.pending = token;
        const range = this.number();
        this.portalRange = range;
        return { kind, range };
      }
      default: this.warn(`WARNING: unknown alphaGen parameter '${token.value}' in shader '${this.shaderName}'\n`); return null;
    }
  }

  private tcGen(vectors: Extract<TexCoordGenerator, { readonly kind: "vector" }>): TexCoordGenerator | null {
    const token = this.next(false);
    if (token === undefined) {
      this.warn(`WARNING: missing texgen parm in shader '${this.shaderName}'\n`);
      return null;
    }
    const kind = token.value.toLowerCase();
    switch (kind) {
      case "environment": case "lightmap": case "texture": return { kind };
      case "base": return { kind: "texture" };
      case "vector": return { kind, s: this.sourceVector(vectors.s).value, t: this.sourceVector(vectors.t).value };
      default: this.warn(`WARNING: unknown texgen parm in shader '${this.shaderName}'\n`); return null;
    }
  }

  private tcMod(): TexCoordModifier {
    const token = this.next(false)?.value ?? "", kind = token.toLowerCase();
    let count = 0;
    const number = (): number => {
      const token = this.next(false);
      if (token !== undefined) { count++; return this.sourceAtof(token.value); }
      const label = kind === "scale" ? "scale parms" : kind === "scroll" ? "scale scroll parms"
        : kind === "transform" ? "transform parms" : kind === "turb" ? count === 0 ? "tcMod turb parms" : "tcMod turb" : "tcMod rotate parms";
      const message = `WARNING: missing ${label} in shader '${this.shaderName}'\n`;
      this.warn(message); this.fail(message);
    };
    switch (kind) {
      case "scale": case "scroll": return { kind, amount: { x: number(), y: number() } };
      case "stretch": return { kind, wave: this.wave(null, `WARNING: missing stretch parms in shader '${this.shaderName}'\n`) };
      case "turb": return { kind, wave: { kind: "sin", base: number(), amplitude: number(), phase: number(), frequency: number() } };
      case "rotate": return { kind, degreesPerSecond: number() };
      case "transform": return { kind, m00: number(), m01: number(), m10: number(), m11: number(), translation: { x: number(), y: number() } };
      case "entitytranslate": return { kind };
      default:
        this.warn(`WARNING: unknown tcMod '${token}' in shader '${this.shaderName}'\n`);
        return { kind: "none" };
    }
  }

  private blendFactor(value: string, destination: boolean): { readonly value: BlendFactor; readonly bits: number } {
    const name = value.toLowerCase();
    switch (name) {
      case "gl_zero": return { value: "zero", bits: destination ? SourceStateBit.DSTBLEND_ZERO : SourceStateBit.SRCBLEND_ZERO };
      case "gl_one": return { value: "one", bits: destination ? SourceStateBit.DSTBLEND_ONE : SourceStateBit.SRCBLEND_ONE };
      case "gl_src_alpha": return { value: "src-alpha", bits: destination ? SourceStateBit.DSTBLEND_SRC_ALPHA : SourceStateBit.SRCBLEND_SRC_ALPHA };
      case "gl_one_minus_src_alpha": return { value: "one-minus-src-alpha", bits: destination ? SourceStateBit.DSTBLEND_ONE_MINUS_SRC_ALPHA : SourceStateBit.SRCBLEND_ONE_MINUS_SRC_ALPHA };
      case "gl_dst_alpha": return { value: "dst-alpha", bits: destination ? SourceStateBit.DSTBLEND_DST_ALPHA : SourceStateBit.SRCBLEND_DST_ALPHA };
      case "gl_one_minus_dst_alpha": return { value: "one-minus-dst-alpha", bits: destination ? SourceStateBit.DSTBLEND_ONE_MINUS_DST_ALPHA : SourceStateBit.SRCBLEND_ONE_MINUS_DST_ALPHA };
      case "gl_dst_color": if (!destination) return { value: "dst-color", bits: SourceStateBit.SRCBLEND_DST_COLOR }; break;
      case "gl_one_minus_dst_color": if (!destination) return { value: "one-minus-dst-color", bits: SourceStateBit.SRCBLEND_ONE_MINUS_DST_COLOR }; break;
      case "gl_src_alpha_saturate": if (!destination) return { value: "src-alpha-saturate", bits: SourceStateBit.SRCBLEND_ALPHA_SATURATE }; break;
      case "gl_src_color": if (destination) return { value: "src-color", bits: SourceStateBit.DSTBLEND_SRC_COLOR }; break;
      case "gl_one_minus_src_color": if (destination) return { value: "one-minus-src-color", bits: SourceStateBit.DSTBLEND_ONE_MINUS_SRC_COLOR }; break;
    }
    this.warn(`WARNING: unknown blend mode '${value}' in shader '${this.shaderName}', substituting GL_ONE\n`);
    return { value: "one", bits: destination ? SourceStateBit.DSTBLEND_ONE : SourceStateBit.SRCBLEND_ONE };
  }

  private blend(previous: RenderState["blend"], previousDestinationBits: number): {
    readonly blend: RenderState["blend"];
    readonly sourceBits: number;
    readonly destinationBits: number;
    readonly complete: boolean;
  } {
    const value = this.required();
    switch (value.toLowerCase()) {
      case "add": return { blend: { source: "one", destination: "one" }, sourceBits: SourceStateBit.SRCBLEND_ONE, destinationBits: SourceStateBit.DSTBLEND_ONE, complete: true };
      case "filter": return { blend: { source: "dst-color", destination: "zero" }, sourceBits: SourceStateBit.SRCBLEND_DST_COLOR, destinationBits: SourceStateBit.DSTBLEND_ZERO, complete: true };
      case "blend": return { blend: { source: "src-alpha", destination: "one-minus-src-alpha" }, sourceBits: SourceStateBit.SRCBLEND_SRC_ALPHA, destinationBits: SourceStateBit.DSTBLEND_ONE_MINUS_SRC_ALPHA, complete: true };
      default: {
        const source = this.blendFactor(value, false);
        const token = this.next(false);
        if (token === undefined) {
          this.warn(`WARNING: missing parm for blendFunc in shader '${this.shaderName}'\n`);
          return { blend: { source: source.value, destination: previous.destination }, sourceBits: source.bits,
            destinationBits: previousDestinationBits, complete: false };
        }
        const destination = this.blendFactor(token.value, true);
        return { blend: { source: source.value, destination: destination.value }, sourceBits: source.bits,
          destinationBits: destination.bits, complete: true };
      }
    }
  }

  private *stage(
    slot: ShaderStageSlot,
    imageRequest: (name: string, wrap: SourceImageRequest["wrap"]) => SourceImageRequest,
    partial: (stage: ParsedShaderStage) => ShaderDefinition,
  ): Generator<RegistrationInstruction, ParsedShaderStage, void> {
    let map: ShaderMap = { kind: "none" };
    let blend: RenderState["blend"] = { source: "one", destination: "zero" };
    let sourceBlendBits = 0;
    let destinationBlendBits = 0;
    let depthFunc: "less-equal" | "equal" = "less-equal";
    let depthWrite = true;
    let explicitDepthWrite = false;
    let alphaFunc: RenderState["alphaTest"] = "none";
    let detail = false;
    let rgbGen: ColorGenerator | null = null;
    let alphaGen: AlphaGenerator = { kind: "identity" };
    let tcGen: TexCoordGenerator | null = null;
    let tcVectors: Extract<TexCoordGenerator, { readonly kind: "vector" }> = { kind: "vector", s: { x: 0, y: 0, z: 0 }, t: { x: 0, y: 0, z: 0 } };
    let rawRgbGen = SourceColorGenerator.Bad;
    let rawAlphaGen = SourceAlphaGenerator.Identity;
    let rawTcGen = SourceTexCoordGenerator.Bad;
    let rgbWave: Waveform = { kind: "none", base: 0, amplitude: 0, phase: 0, frequency: 0 };
    let alphaWave: Waveform = { kind: "none", base: 0, amplitude: 0, phase: 0, frequency: 0 };
    let isLightmap = false;
    let animationCount = 0;
    const tcMods: TexCoordModifier[] = [];
    const value = (completed: boolean): ParsedShaderStage => {
      let stageRgbGen = rgbGen ?? { kind: "identitylighting" } satisfies ColorGenerator;
      let stageRawRgbGen = rawRgbGen;
      let stageRawAlphaGen = rawAlphaGen;
      let stageTcGen = tcGen ?? { kind: isLightmap ? "lightmap" : "texture" } satisfies TexCoordGenerator;
      let stageBlend = blend;
      let stageDepthFunc = depthFunc;
      let stageDepthWrite = depthWrite;
      let stageAlphaFunc = alphaFunc;
      let stateBits = 0;
      if (completed) {
        if (rgbGen === null) {
          stageRgbGen = { kind: sourceBlendBits === 0 || sourceBlendBits === SourceStateBit.SRCBLEND_ONE
            || sourceBlendBits === SourceStateBit.SRCBLEND_SRC_ALPHA ? "identitylighting" : "identity" };
          stageRawRgbGen = sourceColorGenerator(stageRgbGen);
        }
        let blendBits = sourceBlendBits | destinationBlendBits;
        if (sourceBlendBits === SourceStateBit.SRCBLEND_ONE && destinationBlendBits === SourceStateBit.DSTBLEND_ZERO) {
          blendBits = 0;
          stageDepthWrite = true;
        }
        stateBits = blendBits | sourceStateBits({ blend: null, depthTest: depthFunc, depthWrite: stageDepthWrite, alphaTest: stageAlphaFunc });
        // ParseStage accidentally compares alphaGen_t to CGEN_IDENTITY (numeric 2).
        if (stageRawAlphaGen === SourceAlphaGenerator.Entity
          && (stageRawRgbGen === SourceColorGenerator.Identity || stageRawRgbGen === SourceColorGenerator.LightingDiffuse)) {
          stageRawAlphaGen = SourceAlphaGenerator.Skip;
        }
      } else {
        // ParseStage keeps these in locals and writes stateBits only after the closing brace.
        stageBlend = { source: "one", destination: "zero" };
        stageDepthFunc = "less-equal";
        stageDepthWrite = false;
        stageAlphaFunc = "none";
      }
      return {
        map, blend: stageBlend, depthFunc: stageDepthFunc, depthWrite: stageDepthWrite, alphaFunc: stageAlphaFunc,
        detail, rgbGen: stageRgbGen, alphaGen, tcGen: stageTcGen, tcMods: [...tcMods],
        sourceState: {
          active: true,
          stateBits,
          rgbGen: stageRawRgbGen,
          alphaGen: stageRawAlphaGen,
          tcGen: rawTcGen,
          rgbWave: sourceWave(rgbWave),
          alphaWave: sourceWave(alphaWave),
          isLightmap,
          vertexLightmap: false,
        },
      };
    };
    partial(value(false));
    for (;;) {
      const token = this.next(true);
      if (token === undefined) this.reject("WARNING: no matching '}' found\n");
      const keyword = token.value.toLowerCase();
      if (keyword.startsWith("}")) {
        const result = value(true);
        partial(result);
        return result;
      }
      switch (keyword) {
        case "map": case "clampmap": {
          const sourceName = this.stageParameter(keyword);
          const name = normalizeImageName(sourceName);
          if (keyword === "map" && name === "$lightmap") {
            map = { kind: "lightmap" }; isLightmap = true;
            partial(value(false));
            yield { kind: "bind-lightmap", stage: slot };
          } else if (keyword === "map" && name === "$whiteimage") {
            map = { kind: "whiteimage" };
            partial(value(false));
            yield { kind: "bind-white", stage: slot };
          } else {
            map = { kind: "image", name, clamp: keyword === "clampmap" };
            const snapshot = partial(value(false));
            yield { kind: "find-stage-image", request: imageRequest(sourceName, keyword === "clampmap" ? "clamp" : "repeat"),
              target: { kind: "primary", stage: slot }, missing: snapshot };
          }
          break;
        }
        case "animmap": {
          const frequency = this.sourceAtof(this.stageParameter("animMmap"));
          yield { kind: "set-animation-frequency", stage: slot, frequency };
          const frames: string[] = [];
          map = { kind: "animation", frequency, frames };
          for (;;) {
            const token = this.next(false);
            if (token === undefined) break;
            if (this.input === null && (token.value === "}" || token.value === "{")) { this.pending = token; break; }
            const sourceName = token.value;
            if (frames.length < 8) frames.push(normalizeImageName(sourceName));
            map = { kind: "animation", frequency, frames: [...frames] };
            if (animationCount >= 8) continue;
            const snapshot = partial(value(false));
            const frame = checkedAnimationSlot(animationCount);
            animationCount++;
            yield { kind: "find-stage-image", request: imageRequest(sourceName, "repeat"),
              target: { kind: "animation", stage: slot, frame, countAfterSuccess: animationCount }, missing: snapshot };
          }
          break;
        }
        case "videomap": {
          const sourceName = this.stageParameter("videoMmap");
          map = { kind: "video", name: normalizeImageName(sourceName) };
          partial(value(false));
          yield { kind: "play-video", stage: slot, name: sourceName };
          break;
        }
        case "blendfunc": {
          const token = this.next(false);
          if (token === undefined) {
            this.warn(`WARNING: missing parm for blendFunc in shader '${this.shaderName}'\n`);
            break;
          }
          this.pending = token;
          const parsed = this.blend(blend, destinationBlendBits);
          blend = parsed.blend;
          sourceBlendBits = parsed.sourceBits;
          destinationBlendBits = parsed.destinationBits;
          if (parsed.complete && !explicitDepthWrite) depthWrite = false;
          break;
        }
        case "depthwrite": depthWrite = true; explicitDepthWrite = true; break;
        case "depthfunc": {
          const value = this.stageParameter("depthfunc").toLowerCase();
          if (value === "equal") depthFunc = "equal";
          else if (value === "lequal") depthFunc = "less-equal";
          else this.warn(`WARNING: unknown depthfunc '${this.location.value}' in shader '${this.shaderName}'\n`);
          break;
        }
        case "alphafunc": {
          const value = this.stageParameter("alphaFunc").toLowerCase();
          if (value === "gt0" || value === "lt128" || value === "ge128") alphaFunc = value;
          else { this.warn(`WARNING: invalid alphaFunc name '${this.location.value}' in shader '${this.shaderName}'\n`); alphaFunc = "none"; }
          break;
        }
        case "detail": detail = true; break;
        case "rgbgen": {
          const parsed = this.rgb(rgbWave);
          if (parsed !== null) {
            rgbGen = parsed;
            rawRgbGen = sourceColorGenerator(parsed);
            if (parsed.kind === "wave") rgbWave = parsed.wave;
            if (parsed.kind === "vertex" && rawAlphaGen === SourceAlphaGenerator.Identity) {
              alphaGen = { kind: "vertex" };
              rawAlphaGen = SourceAlphaGenerator.Vertex;
            }
          }
          break;
        }
        case "alphagen": {
          const parsed = this.alpha(alphaWave);
          if (parsed !== null) {
            alphaGen = parsed;
            rawAlphaGen = sourceAlphaGenerator(parsed);
            if (parsed.kind === "wave") alphaWave = parsed.wave;
          }
          break;
        }
        case "tcgen": case "texgen": {
          const parsed = this.tcGen(tcVectors);
          if (parsed !== null) {
            tcGen = parsed;
            rawTcGen = sourceTexCoordGenerator(parsed);
            if (parsed.kind === "vector") tcVectors = parsed;
          }
          break;
        }
        case "tcmod": {
          let parser: ShaderParser = this;
          if (this.input !== null) {
            // ParseStage strips token quotes while copying the entire line,
            // including braces, before ParseTexMod parses that separate buffer.
            const arguments_: string[] = [];
            let length = 0;
            for (;;) {
              const token = this.next(false);
              if (token === undefined) break;
              length += token.value.length + 1;
              if (length >= 1024) throw new RangeError("tcMod arguments exceed the source 1024-byte buffer");
              arguments_.push(token.value);
            }
            const text = arguments_.join(" ") + " ";
            parser = new ShaderParser(text, this.source, this.shaderName,
              { cursor: new CommonParseCursor(text), offset: 0 }, message => this.warn(message));
            parser.shaderName = this.shaderName;
          }
          if (tcMods.length === 4) {
            const shader = partial(value(false));
            yield { kind: "drop", message: `ERROR: too many tcMod stages in shader '${shader.name}'\n` };
            this.fail("A stage cannot exceed four tcMod directives");
          }
          const index = tcMods.length;
          // ParseTexMod increments numTexMods before reading its arguments.
          tcMods.push({ kind: "none" });
          partial(value(false));
          try {
            tcMods[index] = parser.tcMod();
            if (parser === this) this.lineArguments();
          } catch (error: unknown) {
            if (!(error instanceof ShaderParseError) || error.reason !== "source-rejection") throw error;
          }
          break;
        }
        default: this.reject(`WARNING: unknown parameter '${token.value}' in shader '${this.shaderName}'\n`);
      }
      partial(value(false));
    }
  }

  private deformNumber(bulge = false): number | null {
    const token = this.next(false);
    if (token === undefined) {
      this.warn(`WARNING: missing deformVertexes ${bulge ? "bulge " : ""}parm in shader '${this.shaderName}'\n`);
      return null;
    }
    return this.sourceAtof(token.value);
  }

  private deform(): VertexDeformation {
    const token = this.required(), kind = token.toLowerCase();
    const zeroWave: Waveform = { kind: "none", base: 0, amplitude: 0, phase: 0, frequency: 0 };
    switch (kind) {
      case "projectionshadow": case "autosprite": case "autosprite2": return { kind };
      case "bulge": {
        const width = this.deformNumber(true);
        if (width === null) return { kind: "none" };
        const height = this.deformNumber(true);
        if (height === null) return { kind: "none" };
        const speed = this.deformNumber(true);
        return speed === null ? { kind: "none" } : { kind, width, height, speed };
      }
      case "normal": {
        const amplitude = this.deformNumber();
        if (amplitude === null) return { kind: "none" };
        const frequency = this.deformNumber();
        return frequency === null ? { kind: "none" } : { kind, amplitude, frequency };
      }
      case "move": {
        const x = this.deformNumber();
        if (x === null) return { kind: "none" };
        const y = this.deformNumber();
        if (y === null) return { kind: "none" };
        const z = this.deformNumber();
        return z === null ? { kind: "none" } : { kind, direction: { x, y, z }, wave: this.wave(zeroWave) };
      }
      case "wave": {
        const divisor = this.deformNumber();
        if (divisor === null) return { kind: "none" };
        if (divisor === 0) this.warn(`WARNING: illegal div value of 0 in deformVertexes command for shader '${this.shaderName}'\n`);
        return { kind, spread: divisor === 0 ? 100 : Math.fround(1 / divisor), wave: this.wave(zeroWave) };
      }
      default:
        if (kind.startsWith("text")) {
          const character = kind.charCodeAt(4);
          if (character >= 48 && character <= 55) return { kind: "text", index: character - 48 };
          return { kind: "text", index: 0 };
        }
        this.warn(`WARNING: unknown deformVertexes subtype '${token}' found in shader '${this.shaderName}'\n`);
        return { kind: "none" };
    }
  }

  private sort(): number | null {
    const token = this.next(false);
    if (token === undefined) {
      this.warn(`WARNING: missing sort parameter in shader '${this.shaderName}'\n`);
      return null;
    }
    const value = token.value.toLowerCase();
    switch (value) {
      case "portal": return 1;
      case "sky": return 2;
      case "opaque": return 3;
      case "decal": return 4;
      case "seethrough": return 5;
      case "banner": return 6;
      case "underwater": return 8;
      case "additive": return 10;
      case "nearest": return 16;
      default: return this.sourceAtof(value);
    }
  }

  parse(recover: boolean): readonly ShaderCatalogEntry[] {
    const entries: ShaderCatalogEntry[] = [];
    for (;;) {
      const nameToken = this.next();
      if (nameToken === undefined) return entries;
      if (nameToken.value === "{" || nameToken.value === "}") this.fail("Expected shader name");
      const name = nameToken.value;
      const instructions: RegistrationInstruction[] = [], parser = this.definition(name);
      this.warningInstructions = instructions;
      let step = parser.next();
      while (!step.done) { instructions.push(step.value); step = parser.next(); }
      this.warningInstructions = null;
      const terminal = step.value;
      if (terminal.kind === "rejected" && !recover) throw terminal.error;
      entries.push({ name, program: new CompiledShaderRegistrationProgram(instructions, terminal), textResult: terminal });
      if (terminal.kind === "rejected") {
        while (this.depth > 0) {
          if (this.next() === undefined) return entries;
        }
      }
    }
  }

  *definition(name: string): Generator<RegistrationInstruction, RegistrationTerminal, void> {
    this.warnings = [];
    this.shaderName = this.registrationName ?? name;
    this.portalRange = 0;
    const stages: ParsedShaderStage[] = [];
    const surfaceParms: string[] = [];
    const deforms: VertexDeformation[] = [];
    const compilerDirectives: { name: string; arguments: readonly string[] }[] = [];
    let cull: RenderState["cull"] = "front";
    let sort: number | null = null;
    let sky: ShaderDefinition["sky"] = null;
    let fog: ShaderDefinition["fog"] = null;
    let sun: ShaderDefinition["sun"] = null;
    let polygonOffset = false;
    let noMipMaps = false;
    let noPicMip = false;
    let entityMergable = false;
    let clampTime = 0;
    let currentStage: ParsedShaderStage | null = null;
    const definition = (partialStage: ParsedShaderStage | null): ShaderDefinition => ({
      name: this.registrationName ?? name,
      stages: partialStage === null ? [...stages] : [...stages, partialStage],
      surfaceParms: [...surfaceParms],
      cull,
      sort,
      sky,
      fog,
      sun,
      deforms: [...deforms],
      polygonOffset,
      noMipMaps,
      noPicMip,
      entityMergable,
      portalRange: this.portalRange,
      clampTime,
      compilerDirectives: compilerDirectives.map(directive => ({ name: directive.name, arguments: [...directive.arguments] })),
      warnings: [...this.warnings],
    });
    try {
      const opening = this.next(true)?.value ?? "";
      if (!opening.startsWith("{")) this.reject(`WARNING: expecting '{', found '${opening}' instead in shader '${this.shaderName}'\n`);
      for (;;) {
        const next = this.next(true);
        if (next === undefined) this.reject(`WARNING: no concluding '}' in shader ${this.shaderName}\n`);
        const token = next.value.toLowerCase();
        if (token.startsWith("}")) break;
        const keyword = token.startsWith("{") ? "{" : token;
        switch (keyword) {
          case "{": {
            if (stages.length === 8) throw new ShaderParseError(this.source, this.location.line, this.location.column, "A shader cannot exceed eight stages", "validation");
            const slot = checkedStageSlot(stages.length);
            const parsed = yield* this.stage(slot,
              (imageName, wrap) => ({ name: imageName, mipmap: !noMipMaps, allowPicmip: !noPicMip, wrap }),
              stage => { currentStage = stage; return definition(stage); });
            stages.push(parsed);
            currentStage = null;
            break;
          }
          case "surfaceparm": {
            const token = this.next(false);
            if (token === undefined) break;
            const value = token.value.toLowerCase();
            surfaceParms.push(value);
            break;
          }
          case "nomipmaps": noMipMaps = true; noPicMip = true; break;
          case "nopicmip": noPicMip = true; break;
          case "polygonoffset": polygonOffset = true; break;
          case "entitymergable": entityMergable = true; break;
          case "clamptime": {
            const token = this.next(false);
            if (token !== undefined) clampTime = this.sourceAtof(token.value);
            break;
          }
          case "portal": sort = 1; break;
          case "sort": sort = this.sort() ?? sort; break;
          case "cull": {
            const token = this.next(false);
            if (token === undefined) {
              this.warn(`WARNING: missing cull parms in shader '${this.shaderName}'\n`);
              break;
            }
            const value = token.value.toLowerCase();
            if (value === "none" || value === "twosided" || value === "disable") cull = "none";
            else if (value === "back" || value === "backside" || value === "backsided") cull = "back";
            else this.warn(`WARNING: invalid cull parm '${token.value}' in shader '${this.shaderName}'\n`);
            break;
          }
          case "deformvertexes": {
            const token = this.next(false);
            if (token === undefined) {
              this.warn(`WARNING: missing deform parm in shader '${this.shaderName}'\n`);
              break;
            }
            if (deforms.length === 3) {
              this.warn(`WARNING: MAX_SHADER_DEFORMS in '${this.shaderName}'\n`);
              break;
            }
            this.pending = token;
            deforms.push(this.deform());
            break;
          }
          case "skyparms": sky = yield* this.skyDirective(sky); break;
          case "fogparms": {
            const color = this.sourceVector(fog === null ? { x: 0, y: 0, z: 0 } : fog.color);
            fog = { color: color.value, depthForOpaque: fog === null ? 0 : fog.depthForOpaque };
            if (!color.complete) this.fail("Incomplete fogParms color vector");
            const token = this.next(false);
            if (token === undefined) {
              this.warn(`WARNING: missing parm for 'fogParms' keyword in shader '${this.shaderName}'\n`);
              break;
            }
            fog = { ...fog, depthForOpaque: this.sourceAtof(token.value) };
            this.lineArguments();
            break;
          }
          case "q3map_sun": {
            const parsed = this.sunDirective();
            sun = parsed.source;
            yield { kind: "apply-sun", value: parsed.registered };
            break;
          }
          case "light": {
            const token = this.next(false);
            compilerDirectives.push({ name: keyword, arguments: token === undefined ? [] : [token.value] });
            break;
          }
          default:
            if (keyword.startsWith("qer") || keyword.startsWith("q3map") || keyword === "tesssize") compilerDirectives.push({ name: keyword, arguments: this.lineArguments() });
            else this.reject(`WARNING: unknown general shader parameter '${next.value}' in '${this.shaderName}'\n`);
        }
      }
      if (stages.length === 0 && sky === null && !surfaceParms.includes("fog")) this.fail("Shader has no stages and is neither sky nor fog; source uses an implicit material");
      return { kind: "accepted", definition: definition(null) };
    } catch (error: unknown) {
      if (!(error instanceof ShaderParseError)) throw error;
      return { kind: "rejected", partial: definition(currentStage), error };
    }
  }

}

export function parseShaderScript(text: string, source = "<shader>"): readonly ShaderDefinition[] {
  const entries = new ShaderParser(text, source).parse(false);
  const definitions: ShaderDefinition[] = [];
  for (const entry of entries) {
    if (entry.textResult.kind === "rejected") throw entry.textResult.error;
    definitions.push(entry.textResult.definition);
  }
  return definitions;
}

/** Retains valid sibling definitions when a retail script contains obsolete syntax. */
export function inspectShaderScript(text: string, source = "<shader>", registrationName: string | null = null): ShaderScriptInspection {
  return { entries: new ShaderParser(text, source, registrationName).parse(true) };
}

/** EvalWaveForm uses a 1024-entry table, including the repeated sine endpoint. */
function shaderTableIndex(value: number): number {
  const integer = Math.trunc(value);
  if (!Number.isFinite(integer) || integer < -2147483648 || integer > 2147483647)
    throw new RangeError("Shader table index reaches undefined source float-to-int conversion");
  return integer & 1023;
}

export function evaluateWaveform(wave: Waveform, time: number): number {
  const index = shaderTableIndex(Math.fround(Math.fround(wave.phase + Math.fround(time * wave.frequency)) * 1024));
  let value: number;
  switch (wave.kind) {
    case "none": throw new Error("EvalWaveForm does not support GF_NONE");
    case "sin": value = rendererSine(index); break;
    case "square": value = index < 512 ? 1 : -1; break;
    case "sawtooth": value = index / 1024; break;
    case "inversesawtooth": value = 1 - index / 1024; break;
    case "triangle": value = index < 256 ? index / 256 : index < 768 ? 2 - index / 256 : index / 256 - 4; break;
    case "noise": throw new Error("Noise waveforms require the renderer's seeded R_NoiseGet4f context; EvalWaveForm does not support GF_NOISE");
  }
  return Math.fround(wave.base + Math.fround(value * wave.amplitude));
}

export interface TexCoordContext {
  readonly lightmap?: Vec2;
  readonly viewOrigin?: Vec3;
  readonly shaderTexCoord?: Vec2;
}

export function evaluateTexCoords(stage: ShaderStage, uv: Vec2, position: Vec3, normal: Vec3, time: number, context: TexCoordContext = {}): Vec2 {
  const f = Math.fround;
  let result: Vec2;
  switch (stage.tcGen.kind) {
    case "texture": result = uv; break;
    case "lightmap":
      if (context.lightmap === undefined) throw new Error("Lightmap tcGen requires lightmap coordinates");
      result = context.lightmap;
      break;
    case "vector": result = { x: dot3(position, stage.tcGen.s), y: dot3(position, stage.tcGen.t) }; break;
    case "environment": {
      if (context.viewOrigin === undefined) throw new Error("Environment tcGen requires the view origin in model coordinates");
      const delta = sub3(context.viewOrigin, position);
      const viewer = normalizeFast3(delta);
      const d = dot3(normal, viewer);
      const reflectedY = f(f(f(normal.y * 2) * d) - viewer.y);
      const reflectedZ = f(f(f(normal.z * 2) * d) - viewer.z);
      result = { x: 0.5 + reflectedY * 0.5, y: 0.5 - reflectedZ * 0.5 };
      break;
    }
  }
  result = { x: f(result.x), y: f(result.y) };
  for (const mod of stage.tcMods) {
    const { x: s, y: t } = result;
    switch (mod.kind) {
      case "none": return { x: Math.fround(result.x), y: Math.fround(result.y) };
      case "scale": result = { x: s * mod.amount.x, y: t * mod.amount.y }; break;
      case "scroll": {
        const x = Math.fround(mod.amount.x * time);
        const y = Math.fround(mod.amount.y * time);
        result = { x: s + f(x - Math.floor(x)), y: t + f(y - Math.floor(y)) };
        break;
      }
      case "entitytranslate": {
        if (context.shaderTexCoord === undefined) throw new Error("entityTranslate requires entity shaderTexCoord");
        const x = Math.fround(context.shaderTexCoord.x * time);
        const y = Math.fround(context.shaderTexCoord.y * time);
        result = { x: s + f(x - Math.floor(x)), y: t + f(y - Math.floor(y)) };
        break;
      }
      case "transform": result = {
        x: f(f(s * mod.m00) + f(t * mod.m10)) + mod.translation.x,
        y: f(f(s * mod.m01) + f(t * mod.m11)) + mod.translation.y,
      }; break;
      case "rotate": {
        const index = shaderTableIndex(f(f(-mod.degreesPerSecond * time) * f(1024 / 360)));
        const sin = rendererSine(index);
        const cos = rendererSine(index + 256);
        result = {
          x: f(f(s * cos) + f(t * -sin)) + f(0.5 - 0.5 * cos + 0.5 * sin),
          y: f(f(s * sin) + f(t * cos)) + f(0.5 - 0.5 * sin - 0.5 * cos),
        };
        break;
      }
      case "stretch": {
        const scale = Math.fround(1 / evaluateWaveform(mod.wave, time));
        const translate = f(0.5 - f(0.5 * scale));
        result = { x: f(f(s * scale) + f(t * 0)) + translate, y: f(f(s * 0) + f(t * scale)) + translate };
        break;
      }
      case "turb": {
        const now = Math.fround(mod.wave.phase + Math.fround(time * mod.wave.frequency));
        const sx = shaderTableIndex((f(position.x + position.z) / 1024 + now) * 1024);
        const sy = shaderTableIndex((position.y / 1024 + now) * 1024);
        result = { x: s + f(rendererSine(sx) * mod.wave.amplitude), y: t + f(rendererSine(sy) * mod.wave.amplitude) };
        break;
      }
    }
    result = { x: Math.fround(result.x), y: Math.fround(result.y) };
  }
  return { x: Math.fround(result.x), y: Math.fround(result.y) };
}

/** cull is the GL face to discard, matching tr_backend.c GL_Cull. */
export function stageState(stage: ShaderStage, cull: RenderState["cull"] = "front"): RenderState {
  return {
    blend: stage.blend,
    depthTest: stage.depthFunc,
    depthWrite: stage.depthWrite,
    alphaTest: stage.alphaFunc,
    cull,
  };
}
