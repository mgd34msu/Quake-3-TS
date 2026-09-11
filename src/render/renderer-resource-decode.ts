// Worker boundary for renderer/tr_image.c and tr_shader.c resource records.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { Vec2, Vec3, Vec4 } from "../core/math.ts";
import type { ImageInternalFormat, RendererImageIdentity } from "./image-resource.ts";
import { SourceAlphaGenerator, SourceColorGenerator, SourceTexCoordGenerator, SourceWaveFunction } from "./material.ts";
import type { AlphaGenerator, ColorGenerator, ParsedShaderStage, ShaderDefinition, ShaderMap, ShaderStage,
  SourceShaderStageState, SourceWaveStorage, TexCoordGenerator, TexCoordModifier, VertexDeformation, Waveform } from "./material.ts";
import type { BlendFactor, TextureFilter, TextureSampling } from "./types.ts";
import type { ImageFrameState, ImageOperationTransfer, ImageUsageState, MaterialTransfer,
  ResourceJournal, ResourceRegistration, RgbaTransfer } from "./renderer-resource-transport.ts";

type Stage = MaterialTransfer["finished"]["sourceStages"][number];
type Binding = Extract<Stage, { readonly active: true }>["binding"];
type Pass = MaterialTransfer["finished"]["iterator"]["passes"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Renderer resource needs a record");
  return value;
}
function isUnknownArray(value: unknown): value is readonly unknown[] { return Array.isArray(value); }
function list(value: unknown, maximum = Number.MAX_SAFE_INTEGER): readonly unknown[] {
  if (!isUnknownArray(value) || value.length > maximum) throw new TypeError("Invalid renderer resource array");
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw new TypeError("Sparse renderer resource array");
  }
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number") throw new TypeError("Renderer resource needs a number");
  return value;
}
function integer(value: unknown, minimum = 0, maximum = 0x7fffffff): number {
  const result = number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new RangeError("Renderer resource integer out of range");
  return result;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("Renderer resource needs a boolean");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Renderer resource needs a string");
  return value;
}
function choice<T extends string | number>(value: unknown, options: readonly T[]): T {
  for (const option of options) if (value === option) return option;
  throw new TypeError("Unknown renderer resource variant");
}
function nullableHandle(value: unknown): number | null { return value === null ? null : integer(value, 0, 16383); }
function vec2(value: unknown): Vec2 { const v = record(value); return { x: number(v["x"]), y: number(v["y"]) }; }
function vec3(value: unknown): Vec3 { const v = record(value); return { x: number(v["x"]), y: number(v["y"]), z: number(v["z"]) }; }
function vec4(value: unknown): Vec4 { const v = record(value); return { x: number(v["x"]), y: number(v["y"]), z: number(v["z"]), w: number(v["w"]) }; }
function filter(value: unknown): TextureFilter {
  return choice(value, ["nearest", "linear", "nearest-mipmap-nearest", "linear-mipmap-nearest", "nearest-mipmap-linear", "linear-mipmap-linear"]);
}
function format(value: unknown): ImageInternalFormat { return choice(value, ["rgb", "rgba", "rgb5", "rgba4", "rgb8", "rgba8", "rgb4-s3tc"]); }
function sampling(value: unknown): TextureSampling {
  const v = record(value); return { wrap: choice(v["wrap"], ["repeat", "clamp"]), filter: filter(v["filter"]) };
}
function rgba(value: unknown): RgbaTransfer {
  const v = record(value), width = integer(v["width"], 1), height = integer(v["height"], 1);
  if (!(v["pixels"] instanceof Uint8Array) || v["pixels"].buffer instanceof SharedArrayBuffer
    || !Number.isSafeInteger(width * height * 4) || v["pixels"].length !== width * height * 4) throw new RangeError("Invalid renderer RGBA extent");
  return { width, height, pixels: new Uint8Array(v["pixels"]) };
}
function imageIdentity(value: unknown): RendererImageIdentity {
  const v = record(value);
  return { ordinal: integer(v["ordinal"]), name: string(v["name"]), sourceWidth: integer(v["sourceWidth"], 1), sourceHeight: integer(v["sourceHeight"], 1),
    mipmap: boolean(v["mipmap"]), wrap: choice(v["wrap"], ["repeat", "clamp"]), registrationUnit: choice(v["registrationUnit"], [0, 1]) };
}
function imageOperation(value: unknown): ImageOperationTransfer {
  const v = record(value);
  switch (v["kind"]) {
    case "begin-image": return { kind: v["kind"], image: integer(v["image"]), mipmap: boolean(v["mipmap"]), registrationUnit: choice(v["registrationUnit"], [0, 1]) };
    case "create-image": {
      const levels = list(v["levels"]).map(rgba), first = levels[0];
      if (first === undefined) throw new RangeError("Renderer image needs a base level");
      return { kind: v["kind"], image: integer(v["image"]), levels: [first, ...levels.slice(1)], internalFormat: format(v["internalFormat"]),
        mipmap: boolean(v["mipmap"]), sampling: sampling(v["sampling"]), registrationUnit: choice(v["registrationUnit"], [0, 1]) };
    }
    case "upload-image-level": return { kind: v["kind"], image: integer(v["image"]), index: integer(v["index"]), content: rgba(v["content"]), internalFormat: format(v["internalFormat"]) };
    case "set-image-upload-descriptor": return { kind: v["kind"], image: integer(v["image"]), width: integer(v["width"], 1), height: integer(v["height"], 1), internalFormat: format(v["internalFormat"]) };
    case "finish-image-upload": return { kind: v["kind"], image: integer(v["image"]), filter: filter(v["filter"]) };
    case "dlight-image": return { kind: v["kind"], image: integer(v["image"]) };
    case "texture-mode": return { kind: v["kind"], filter: filter(v["filter"]) };
    case "current-border-color": {
      const color = vec4(v["color"]);
      if (![color.x, color.y, color.z, color.w].every(value => Number.isFinite(value) && value >= 0 && value <= 1))
        throw new RangeError("Renderer border color must be finite and normalized");
      return { kind: v["kind"], color };
    }
    default: throw new TypeError("Unknown renderer image operation");
  }
}
function wave(value: unknown): Waveform {
  const v = record(value);
  return { kind: choice(v["kind"], ["none", "sin", "square", "triangle", "sawtooth", "inversesawtooth", "noise"]),
    base: number(v["base"]), amplitude: number(v["amplitude"]), phase: number(v["phase"]), frequency: number(v["frequency"]) };
}
function sourceWave(value: unknown): SourceWaveStorage {
  const v = record(value);
  return { func: choice(v["func"], [SourceWaveFunction.None, SourceWaveFunction.Sin, SourceWaveFunction.Square,
    SourceWaveFunction.Triangle, SourceWaveFunction.Sawtooth, SourceWaveFunction.InverseSawtooth, SourceWaveFunction.Noise]),
  base: number(v["base"]), amplitude: number(v["amplitude"]), phase: number(v["phase"]), frequency: number(v["frequency"]) };
}
function sourceColor(value: unknown): SourceColorGenerator {
  return choice(value, [SourceColorGenerator.Bad, SourceColorGenerator.IdentityLighting, SourceColorGenerator.Identity,
    SourceColorGenerator.Entity, SourceColorGenerator.OneMinusEntity, SourceColorGenerator.ExactVertex, SourceColorGenerator.Vertex,
    SourceColorGenerator.OneMinusVertex, SourceColorGenerator.Waveform, SourceColorGenerator.LightingDiffuse, SourceColorGenerator.Fog, SourceColorGenerator.Const]);
}
function sourceTc(value: unknown): SourceTexCoordGenerator {
  return choice(value, [SourceTexCoordGenerator.Bad, SourceTexCoordGenerator.Identity, SourceTexCoordGenerator.Lightmap,
    SourceTexCoordGenerator.Texture, SourceTexCoordGenerator.EnvironmentMapped, SourceTexCoordGenerator.Fog, SourceTexCoordGenerator.Vector]);
}
function sourceState(value: unknown): SourceShaderStageState {
  const v = record(value);
  return { active: boolean(v["active"]), stateBits: integer(v["stateBits"], -0x80000000, 0xffffffff), rgbGen: sourceColor(v["rgbGen"]),
    alphaGen: choice(v["alphaGen"], [SourceAlphaGenerator.Identity, SourceAlphaGenerator.Skip, SourceAlphaGenerator.Entity,
      SourceAlphaGenerator.OneMinusEntity, SourceAlphaGenerator.Vertex, SourceAlphaGenerator.OneMinusVertex,
      SourceAlphaGenerator.LightingSpecular, SourceAlphaGenerator.Waveform, SourceAlphaGenerator.Portal, SourceAlphaGenerator.Const]),
    tcGen: sourceTc(v["tcGen"]), rgbWave: sourceWave(v["rgbWave"]), alphaWave: sourceWave(v["alphaWave"]),
    isLightmap: boolean(v["isLightmap"]), vertexLightmap: boolean(v["vertexLightmap"]) };
}
function colorGenerator(value: unknown): ColorGenerator {
  const v = record(value);
  switch (v["kind"]) {
    case "identity": case "identitylighting": case "entity": case "oneminusentity": case "vertex": case "exactvertex": case "lightingdiffuse": case "oneminusvertex": return { kind: v["kind"] };
    case "const": return { kind: v["kind"], color: vec3(v["color"]) };
    case "wave": return { kind: v["kind"], wave: wave(v["wave"]) };
    default: throw new TypeError("Unknown renderer color generator");
  }
}
function alphaGenerator(value: unknown): AlphaGenerator {
  const v = record(value);
  switch (v["kind"]) {
    case "identity": case "entity": case "oneminusentity": case "vertex": case "lightingspecular": case "oneminusvertex": return { kind: v["kind"] };
    case "const": return { kind: v["kind"], alpha: number(v["alpha"]) };
    case "wave": return { kind: v["kind"], wave: wave(v["wave"]) };
    case "portal": return { kind: v["kind"], range: number(v["range"]) };
    default: throw new TypeError("Unknown renderer alpha generator");
  }
}
function texCoordGenerator(value: unknown): TexCoordGenerator {
  const v = record(value);
  switch (v["kind"]) {
    case "texture": case "lightmap": case "environment": return { kind: v["kind"] };
    case "vector": return { kind: v["kind"], s: vec3(v["s"]), t: vec3(v["t"]) };
    default: throw new TypeError("Unknown renderer texture coordinate generator");
  }
}
function texCoordModifier(value: unknown): TexCoordModifier {
  const v = record(value);
  switch (v["kind"]) {
    case "scale": case "scroll": return { kind: v["kind"], amount: vec2(v["amount"]) };
    case "stretch": case "turb": return { kind: v["kind"], wave: wave(v["wave"]) };
    case "rotate": return { kind: v["kind"], degreesPerSecond: number(v["degreesPerSecond"]) };
    case "transform": return { kind: v["kind"], m00: number(v["m00"]), m01: number(v["m01"]), m10: number(v["m10"]), m11: number(v["m11"]), translation: vec2(v["translation"]) };
    case "entitytranslate": case "none": return { kind: v["kind"] };
    default: throw new TypeError("Unknown renderer texture coordinate modifier");
  }
}
function shaderMap(value: unknown): ShaderMap {
  const v = record(value);
  switch (v["kind"]) {
    case "image": return { kind: v["kind"], name: string(v["name"]), clamp: boolean(v["clamp"]) };
    case "animation": return { kind: v["kind"], frequency: number(v["frequency"]), frames: list(v["frames"], 8).map(string) };
    case "video": return { kind: v["kind"], name: string(v["name"]) };
    case "lightmap": case "whiteimage": case "none": return { kind: v["kind"] };
    default: throw new TypeError("Unknown renderer shader map");
  }
}
function blendFactor(value: unknown): BlendFactor {
  return choice(value, ["zero", "one", "src-color", "one-minus-src-color", "dst-color", "one-minus-dst-color",
    "src-alpha", "one-minus-src-alpha", "dst-alpha", "one-minus-dst-alpha", "src-alpha-saturate"]);
}
function shaderStage(value: unknown): ShaderStage {
  const v = record(value), blend = record(v["blend"]);
  return { map: shaderMap(v["map"]), blend: { source: blendFactor(blend["source"]), destination: blendFactor(blend["destination"]) },
    depthFunc: choice(v["depthFunc"], ["less-equal", "equal", "always"]), depthWrite: boolean(v["depthWrite"]),
    alphaFunc: choice(v["alphaFunc"], ["none", "gt0", "lt128", "ge128"]), detail: boolean(v["detail"]),
    rgbGen: colorGenerator(v["rgbGen"]), alphaGen: alphaGenerator(v["alphaGen"]), tcGen: texCoordGenerator(v["tcGen"]), tcMods: list(v["tcMods"], 4).map(texCoordModifier) };
}
function parsedStage(value: unknown): ParsedShaderStage { const v = record(value); return { ...shaderStage(v), sourceState: sourceState(v["sourceState"]) }; }
function deformation(value: unknown): VertexDeformation {
  const v = record(value);
  switch (v["kind"]) {
    case "projectionshadow": case "autosprite": case "autosprite2": case "none": return { kind: v["kind"] };
    case "text": return { kind: v["kind"], index: integer(v["index"], 0, 7) };
    case "wave": return { kind: v["kind"], spread: number(v["spread"]), wave: wave(v["wave"]) };
    case "normal": return { kind: v["kind"], amplitude: number(v["amplitude"]), frequency: number(v["frequency"]) };
    case "move": return { kind: v["kind"], direction: vec3(v["direction"]), wave: wave(v["wave"]) };
    case "bulge": return { kind: v["kind"], width: number(v["width"]), height: number(v["height"]), speed: number(v["speed"]) };
    default: throw new TypeError("Unknown renderer deformation");
  }
}
function definition(value: unknown): ShaderDefinition | null {
  if (value === null) return null;
  const v = record(value), sky = v["sky"] === null ? null : record(v["sky"]), fog = v["fog"] === null ? null : record(v["fog"]), sun = v["sun"] === null ? null : record(v["sun"]);
  return { name: string(v["name"]), stages: list(v["stages"], 8).map(parsedStage), surfaceParms: list(v["surfaceParms"]).map(string),
    cull: choice(v["cull"], ["none", "back", "front"]), sort: v["sort"] === null ? null : number(v["sort"]),
    sky: sky === null ? null : { outerBox: sky["outerBox"] === null ? null : string(sky["outerBox"]), cloudHeight: number(sky["cloudHeight"]), innerBox: sky["innerBox"] === null ? null : string(sky["innerBox"]) },
    fog: fog === null ? null : { color: vec3(fog["color"]), depthForOpaque: number(fog["depthForOpaque"]) },
    sun: sun === null ? null : { color: vec3(sun["color"]), intensity: number(sun["intensity"]), azimuth: number(sun["azimuth"]), elevation: number(sun["elevation"]) },
    deforms: list(v["deforms"], 3).map(deformation), polygonOffset: boolean(v["polygonOffset"]), noMipMaps: boolean(v["noMipMaps"]), noPicMip: boolean(v["noPicMip"]),
    entityMergable: boolean(v["entityMergable"]), portalRange: number(v["portalRange"]), clampTime: number(v["clampTime"]),
    warnings: list(v["warnings"]).map(value => { const warning = record(value); return { source: string(warning["source"]), line: integer(warning["line"]), column: integer(warning["column"]), message: string(warning["message"]) }; }),
    compilerDirectives: list(v["compilerDirectives"]).map(value => { const directive = record(value); return { name: string(directive["name"]), arguments: list(directive["arguments"]).map(string) }; }) };
}
function binding(value: unknown): Binding {
  const v = record(value);
  switch (v["kind"]) {
    case "retain-current-texture": return { kind: v["kind"] };
    case "video": return { kind: v["kind"], source: integer(v["source"]) };
    case "images": {
      const playback = record(v["playback"]);
      if (playback["kind"] === "single") return { kind: v["kind"], playback: { kind: playback["kind"], image: integer(playback["image"]) } };
      if (playback["kind"] !== "animation") throw new TypeError("Unknown renderer image playback");
      const frames = list(playback["frames"], 8).map(value => integer(value)), first = frames[0];
      if (first === undefined) throw new RangeError("Renderer animation needs an image");
      return { kind: v["kind"], playback: { kind: playback["kind"], frequency: number(playback["frequency"]), frames: [first, ...frames.slice(1)] } };
    }
    default: throw new TypeError("Unknown renderer stage binding");
  }
}
function iteratorFields(v: Record<string, unknown>): Pick<Pass, "stage" | "stateBits" | "rgbGen" | "fogAdjustment" | "alphaGen"> {
  return { stage: shaderStage(v["stage"]), stateBits: integer(v["stateBits"], -0x80000000, 0xffffffff), rgbGen: sourceColor(v["rgbGen"]),
    fogAdjustment: choice(v["fogAdjustment"], ["none", "rgb", "alpha", "rgba"]),
    alphaGen: choice(v["alphaGen"], ["identity", "entity", "oneminusentity", "vertex", "lightingspecular", "oneminusvertex", "const", "wave", "portal", "skip"]) };
}
function stage(value: unknown): Stage {
  const v = record(value), fields = { ...iteratorFields(v), tcGen: sourceTc(v["tcGen"]), rgbWave: sourceWave(v["rgbWave"]), alphaWave: sourceWave(v["alphaWave"]), isLightmap: boolean(v["isLightmap"]), vertexLightmap: boolean(v["vertexLightmap"]) };
  if (v["active"] === true) return { ...fields, active: true, imageTMU: choice(v["imageTMU"], [0, 1]), binding: binding(v["binding"]) };
  if (v["active"] !== false || v["imageTMU"] !== null || v["binding"] !== null) throw new TypeError("Inconsistent inactive renderer stage");
  return { ...fields, active: false, imageTMU: null, binding: null };
}
function pass(value: unknown): Pass {
  const v = record(value), bundles = list(v["bundles"], 2).map(stage), first = bundles[0], second = bundles[1];
  if (first === undefined) throw new RangeError("Renderer pass needs one or two bundles");
  return { ...iteratorFields(v), bundles: second === undefined ? [first] : [first, second] };
}
function finished(value: unknown): MaterialTransfer["finished"] {
  const v = record(value), iterator = record(v["iterator"]);
  return { sort: number(v["sort"]), lightmapIndex: integer(v["lightmapIndex"], -4), hasLightmapStage: boolean(v["hasLightmapStage"]), sourceStages: list(v["sourceStages"], 8).map(stage),
    numUnfoggedPasses: integer(v["numUnfoggedPasses"], 0, 8), fogPass: choice(v["fogPass"], ["none", "equal", "less-equal"]),
    iterator: { kind: choice(iterator["kind"], ["generic", "vertex-lit", "lightmapped-multitexture", "sky"]), passes: list(iterator["passes"], 8).map(pass), multitextureEnv: choice(iterator["multitextureEnv"], ["none", "modulate", "add"]) },
    diagnostics: list(v["diagnostics"]).map(value => { const diagnostic = record(value); return { kind: choice(diagnostic["kind"], ["missing-image", "lightmap-cleared"]), stage: diagnostic["stage"] === null ? null : integer(diagnostic["stage"], 0, 7), message: string(diagnostic["message"]) }; }) };
}
function lighting(value: unknown): MaterialTransfer["lighting"] {
  const v = record(value);
  switch (v["kind"]) {
    case "none": case "vertex": case "white": case "picture": return { kind: v["kind"] };
    case "lightmap": return { kind: v["kind"], owner: integer(v["owner"]), index: integer(v["index"]), image: integer(v["image"]) };
    default: throw new TypeError("Unknown renderer material lighting");
  }
}
function skyBox(value: unknown): NonNullable<MaterialTransfer["sky"]>["outer"] {
  if (value === null) return null;
  const v = record(value); return { rt: integer(v["rt"]), bk: integer(v["bk"]), lf: integer(v["lf"]), ft: integer(v["ft"]), up: integer(v["up"]), dn: integer(v["dn"]) };
}
function material(value: unknown): MaterialTransfer {
  const v = record(value), sky = v["sky"] === null ? null : record(v["sky"]);
  return { kind: choice(v["kind"], ["ordinary", "stencil-shadow"]), name: string(v["name"]), order: integer(v["order"], 0, 16383), sortedIndex: integer(v["sortedIndex"], 0, 16383),
    sort: number(v["sort"]), lighting: lighting(v["lighting"]), mip: boolean(v["mip"]), remapped: nullableHandle(v["remapped"]), timeOffset: number(v["timeOffset"]),
    definition: definition(v["definition"]), image: integer(v["image"]), whiteImage: integer(v["whiteImage"]), defaulted: boolean(v["defaulted"]), finished: finished(v["finished"]),
    sky: sky === null ? null : { outer: skyBox(sky["outer"]), inner: skyBox(sky["inner"]), cloudHeight: number(sky["cloudHeight"]) } };
}
function registration(value: unknown): ResourceRegistration {
  const v = record(value);
  switch (v["kind"]) {
    case "image-identity": return { kind: v["kind"], identity: imageIdentity(v["identity"]) };
    case "image-operation": return { kind: v["kind"], operation: imageOperation(v["operation"]) };
    case "material": return { kind: v["kind"], material: material(v["material"]) };
    case "material-state": return { kind: v["kind"], handle: integer(v["handle"], 0, 16383), sortedIndex: integer(v["sortedIndex"], 0, 16383), remapped: nullableHandle(v["remapped"]), timeOffset: number(v["timeOffset"]) };
    default: throw new TypeError("Unknown renderer resource registration");
  }
}

export function decodeResourceJournal(value: unknown): ResourceJournal {
  const v = record(value), first = integer(v["first"], 0, Number.MAX_SAFE_INTEGER), entries = list(v["entries"]);
  if (!Number.isSafeInteger(first + entries.length)) throw new RangeError("Renderer journal cursor exceeds safe integer storage");
  return { first, entries: entries.map(registration) };
}
export function decodeImageFrameState(value: unknown): ImageFrameState {
  const v = record(value); return { frameCount: integer(v["frameCount"], -0x80000000), noBind: boolean(v["noBind"]), ignoreGLErrors: boolean(v["ignoreGLErrors"]) };
}
export function decodeImageUsageState(value: unknown): readonly ImageUsageState[] {
  return list(value).map(value => { const v = record(value); return { ordinal: integer(v["ordinal"]), frameUsed: integer(v["frameUsed"], -0x80000000), uploadWidth: integer(v["uploadWidth"]), uploadHeight: integer(v["uploadHeight"]) }; });
}
