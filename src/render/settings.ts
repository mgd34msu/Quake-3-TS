// Renderer cvars and command initialization from id Software's tr_init.c and tr_cmds.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { CvarFlag, CvarRegistry } from "../core/cvar.ts";
import { defaultOpenGlDriver } from "../platform/native-libraries.ts";
import type { CvarSnapshot } from "../core/cvar.ts";
import type { RailSettings } from "./entity-primitives.ts";
import type { ColorMappingInputs, ImageUploadProfile } from "./image-upload.ts";
import type { LightingScales } from "./lighting.ts";
import type { FinishShaderProfile } from "./material-finish.ts";
import type { SceneSubmissionLimits } from "./scene-submission.ts";
import type { SourceFlareSettings } from "./flares.ts";

export type SourceRendererHardware = "generic" | "3dfx2d3d" | "riva128" | "ragepro" | "permedia2";
export type SourceRendererDriver = "icd" | "standalone" | "voodoo";

function rendererHardware(value: string): SourceRendererHardware {
  switch (value) {
    case "generic": case "3dfx2d3d": case "riva128": case "ragepro": case "permedia2": return value;
    default: throw new RangeError(`Unknown r_hardwareProfile: ${value}`);
  }
}

function rendererDriver(value: string): SourceRendererDriver {
  switch (value) {
    case "icd": case "standalone": case "voodoo": return value;
    default: throw new RangeError(`Unknown r_driverProfile: ${value}`);
  }
}

export interface RendererRuntimeSettings {
  readonly clear: boolean;
  readonly smpRequested: boolean;
  readonly skipBackEnd: boolean;
  readonly finish: number;
  readonly primitives: number;
  readonly debugSort: number;
  readonly showTris: number;
  readonly showNormals: number;
  readonly showImages: number;
  readonly speeds: number;
  readonly logFile: number;
  readonly measureOverdraw: number;
  readonly lightmap: boolean;
  readonly vertexLighting: boolean;
  readonly polygonOffset: { readonly factor: number; readonly units: number };
}

export interface RendererSettings {
  readonly hardwareType: SourceRendererHardware;
  readonly flares: SourceFlareSettings;
  registrationProfile(): FinishShaderProfile;
  bspProfile(): RendererBspSettings;
  sceneLimits(): SceneSubmissionLimits;
  readonly visibility: RendererVisibilitySettings;
  readonly lighting: LightingScales;
  readonly rail: RailSettings;
  readonly runtime: RendererRuntimeSettings & { readonly debugSurface: number; readonly shadows: number; readonly lodCurveError: number;
    readonly lodBias: number; readonly lodScale: number; readonly zNear: number;
    readonly noPortals: boolean; readonly portalOnly: boolean; readonly fastSky: number; readonly showSky: number; readonly drawSun: number; readonly dynamicLights: boolean;
    readonly noCull: boolean; readonly facePlaneCull: boolean; readonly noCurves: boolean;
    readonly noRefresh: boolean; readonly drawEntities: boolean; readonly developerEnabled: boolean;
    readonly debugLight: boolean; readonly printShaders: boolean };
}

export interface RendererVisibilitySettings {
  readonly drawWorld: boolean;
  readonly noVis: boolean;
  readonly lockPvs: boolean;
  readonly showCluster: boolean;
  readonly showClusterModified: boolean;
  clearShowClusterModified(): void;
}

export interface RendererBspSettings {
  readonly vertexLight: boolean;
  readonly fullbright: boolean;
  readonly singleShader: boolean;
  readonly mapOverbrightBits: number;
  readonly subdivisions: number;
  readonly lightmap: number;
}

export interface RendererCapabilities {
  readonly textureUnits: number;
  readonly textureEnvAdd: boolean;
}

export interface SourceGlExtensionSettings {
  readonly allow: boolean;
  readonly compressedTextures: boolean;
  readonly compiledVertexArrays: boolean;
  readonly textureEnvAdd: boolean;
  readonly multitexture: boolean;
  readonly print: (text: string) => void;
}

type RendererCvarRegistration = readonly [name: string, defaultValue: string, flags: number];

const ARCHIVE_LATCH = CvarFlag.Archive | CvarFlag.Latch;

// AssertCvarRange has already required a finite binary32 value convertible to int32.
// Scaling binary32 by 1,000,000 is exact in binary64; native %f rounds ties to even.
function rangeWarningValue(value: number): string {
  const scaled = Math.abs(value) * 1_000_000, lower = Math.floor(scaled), fraction = scaled - lower;
  const rounded = lower + (fraction > 0.5 || (fraction === 0.5 && lower % 2 !== 0) ? 1 : 0);
  const sign = value < 0 || Object.is(value, -0) ? "-" : "";
  return `${sign}${Math.floor(rounded / 1_000_000)}.${String(rounded % 1_000_000).padStart(6, "0")}`;
}

function assertCvarRange(cvars: CvarRegistry, name: string, minimum: number, maximum: number, print: (text: string) => void): void {
  const read = (): CvarSnapshot => {
    const value = cvars.get(name);
    if (value === undefined) throw new Error(`Renderer cvar ${name} is not registered`);
    return value;
  };
  let value = read();
  const integral = Math.trunc(value.numericValue);
  if (!Number.isFinite(integral) || integral < -0x80000000 || integral > 0x7fffffff)
    throw new RangeError(`Undefined native ${name} float-to-int conversion`);
  if (integral !== value.integerValue) {
    print(`^3WARNING: cvar '${value.name}' must be integral (${rangeWarningValue(value.numericValue)})\n`);
    value = cvars.set(name, String(read().integerValue), true);
  }
  if (value.numericValue < minimum) {
    print(`^3WARNING: cvar '${value.name}' out of range (${rangeWarningValue(value.numericValue)} < ${rangeWarningValue(minimum)})\n`);
    cvars.set(name, rangeWarningValue(minimum), true);
  } else if (value.numericValue > maximum) {
    print(`^3WARNING: cvar '${value.name}' out of range (${rangeWarningValue(value.numericValue)} > ${rangeWarningValue(maximum)})\n`);
    cvars.set(name, rangeWarningValue(maximum), true);
  }
}

export interface RendererVideoMode {
  readonly width: number;
  readonly height: number;
  readonly windowAspect: number;
}

// tr_init.c:R_GetModeInfo. The final wide mode is source index 11.
const VIDEO_MODES: readonly (readonly [number, number])[] = [
  [320, 240], [400, 300], [512, 384], [640, 480], [800, 600], [960, 720],
  [1024, 768], [1152, 864], [1280, 1024], [1600, 1200], [2048, 1536], [856, 480],
];

// tr_init.c:R_ModeList_f.
export function printRendererVideoModes(print: (text: string) => undefined): void {
  print("\n");
  for (const [index, [width, height]] of VIDEO_MODES.entries()) {
    print(`Mode ${String(index).padStart(2)}: ${width}x${height}${index === 11 ? " (wide)" : ""}\n`);
  }
  print("\n");
}

/** Apply the host profile at the source video-cvar registration position. */
function registerVideoModes(cvars: CvarRegistry, initial: { readonly width: number; readonly height: number } | null): void {
  const seedMode = initial !== null && cvars.get("r_mode") === undefined;
  const seedFullscreen = initial !== null && cvars.get("r_fullscreen") === undefined;
  const seedWidth = cvars.get("r_customwidth") === undefined;
  const seedHeight = cvars.get("r_customheight") === undefined;
  const seedAspect = cvars.get("r_customaspect") === undefined;
  if (seedMode && initial !== null) {
    for (const dimension of [initial.width, initial.height]) {
      if (!Number.isInteger(dimension) || dimension <= 0 || dimension > 16384)
        throw new RangeError("Initial video profile dimensions must be integers in 1..16384");
    }
  }
  const registrations: readonly RendererCvarRegistration[] = [
    ["r_mode", "3", ARCHIVE_LATCH], ["r_fullscreen", "1", ARCHIVE_LATCH],
    ["r_customwidth", "1600", ARCHIVE_LATCH], ["r_customheight", "1024", ARCHIVE_LATCH],
    ["r_customaspect", "1", ARCHIVE_LATCH],
  ];
  for (const [name, value, flags] of registrations) cvars.register(name, value, flags);
  if (seedMode && initial !== null) {
    const index = VIDEO_MODES.findIndex(([width, height]) => width === initial.width && height === initial.height);
    cvars.set("r_mode", String(index), true);
    if (index === -1) {
      if (seedWidth) cvars.set("r_customwidth", String(initial.width), true);
      if (seedHeight) cvars.set("r_customheight", String(initial.height), true);
      if (seedAspect) cvars.set("r_customaspect", String(Math.fround(initial.width / initial.height)), true);
    }
  }
  if (seedFullscreen) cvars.set("r_fullscreen", "0", true);
}

export function rendererVideoMode(cvars: CvarRegistry, mode: number): RendererVideoMode | null {
  if (mode === -1) {
    const width = cvars.get("r_customwidth"), height = cvars.get("r_customheight"), aspect = cvars.get("r_customaspect");
    if (width === undefined || height === undefined || aspect === undefined) throw new Error("Renderer custom video cvars are not registered");
    return { width: width.integerValue, height: height.integerValue, windowAspect: aspect.numericValue };
  }
  const dimensions = VIDEO_MODES[mode];
  return dimensions === undefined ? null : { width: dimensions[0], height: dimensions[1], windowAspect: Math.fround(dimensions[0] / dimensions[1]) };
}

/** R_Register completes before SDL creation and before actual backend capabilities exist. */
export class RegisteredRendererCvars {
  constructor(private readonly registry: CvarRegistry, platform: "linux" | "other",
    initial: { readonly width: number; readonly height: number } | null = null,
    readonly print: (text: string) => void = text => { process.stdout.write(text); }) {
    const registrations: readonly RendererCvarRegistration[] = [
      ["r_glDriver", defaultOpenGlDriver(), ARCHIVE_LATCH],
      ["r_allowExtensions", "1", ARCHIVE_LATCH],
      ["r_ext_compressed_textures", "0", ARCHIVE_LATCH],
      ["r_ext_gamma_control", "1", ARCHIVE_LATCH],
      ["r_ext_multitexture", "1", ARCHIVE_LATCH],
      ["r_ext_compiled_vertex_array", "1", ARCHIVE_LATCH],
      ["r_ext_texture_env_add", platform === "linux" ? "0" : "1", ARCHIVE_LATCH],
      ["r_picmip", "1", ARCHIVE_LATCH],
      ["r_roundImagesDown", "1", ARCHIVE_LATCH],
      ["r_colorMipLevels", "0", CvarFlag.Latch],
      ["r_detailtextures", "1", ARCHIVE_LATCH],
      ["r_texturebits", "0", ARCHIVE_LATCH],
      ["r_colorbits", "0", ARCHIVE_LATCH],
      ["r_stereo", "0", ARCHIVE_LATCH],
      ["r_stencilbits", platform === "linux" ? "0" : "8", ARCHIVE_LATCH],
      ["r_depthbits", "0", ARCHIVE_LATCH],
      ["r_overBrightBits", "1", ARCHIVE_LATCH],
      ["r_ignorehwgamma", "0", ARCHIVE_LATCH],
      ["r_simpleMipMaps", "1", ARCHIVE_LATCH],
      ["r_vertexLight", "0", ARCHIVE_LATCH],
      ["r_uifullscreen", "0", CvarFlag.None],
      ["r_subdivisions", "4", ARCHIVE_LATCH],
      ["r_smp", "0", ARCHIVE_LATCH],
      ["r_ignoreFastPath", "1", ARCHIVE_LATCH],
      ["r_displayRefresh", "0", CvarFlag.Latch],
      ["r_fullbright", "0", CvarFlag.Latch | CvarFlag.Cheat],
      ["r_mapOverBrightBits", "2", CvarFlag.Latch],
      ["r_intensity", "1", CvarFlag.Latch],
      ["r_singleShader", "0", CvarFlag.Cheat | CvarFlag.Latch],
      ["r_lodCurveError", "250", CvarFlag.Archive | CvarFlag.Cheat],
      ["r_lodbias", "0", CvarFlag.Archive],
      ["r_flares", "0", CvarFlag.Archive],
      ["r_znear", "4", CvarFlag.Cheat],
      ["r_ignoreGLErrors", "1", CvarFlag.Archive],
      ["r_fastsky", "0", CvarFlag.Archive],
      ["r_inGameVideo", "1", CvarFlag.Archive],
      ["r_drawSun", "0", CvarFlag.Archive],
      ["r_dynamiclight", "1", CvarFlag.Archive],
      ["r_dlightBacks", "1", CvarFlag.Archive],
      ["r_finish", "0", CvarFlag.Archive],
      ["r_textureMode", "GL_LINEAR_MIPMAP_NEAREST", CvarFlag.Archive],
      ["r_swapInterval", "0", CvarFlag.Archive],
      ["r_gamma", "1", CvarFlag.Archive],
      ["r_facePlaneCull", "1", CvarFlag.Archive],
      ["r_railWidth", "16", CvarFlag.Archive],
      ["r_railCoreWidth", "6", CvarFlag.Archive],
      ["r_railSegmentLength", "32", CvarFlag.Archive],
      ["r_primitives", "0", CvarFlag.Archive],
      ["r_ambientScale", "0.6", CvarFlag.Cheat],
      ["r_directedScale", "1", CvarFlag.Cheat],
      ["r_showImages", "0", CvarFlag.Temporary],
      ["r_debuglight", "0", CvarFlag.Temporary],
      ["r_debugSort", "0", CvarFlag.Cheat],
      ["r_printShaders", "0", CvarFlag.None],
      ["r_saveFontData", "0", CvarFlag.None],
      ["r_nocurves", "0", CvarFlag.Cheat],
      ["r_drawworld", "1", CvarFlag.Cheat],
      ["r_lightmap", "0", CvarFlag.None],
      ["r_portalOnly", "0", CvarFlag.Cheat],
      ["r_flareSize", "40", CvarFlag.Cheat],
      ["r_flareFade", "7", CvarFlag.Cheat],
      ["r_showSmp", "0", CvarFlag.Cheat],
      ["r_skipBackEnd", "0", CvarFlag.Cheat],
      ["r_measureOverdraw", "0", CvarFlag.Cheat],
      ["r_lodscale", "5", CvarFlag.Cheat],
      ["r_norefresh", "0", CvarFlag.Cheat],
      ["r_drawentities", "1", CvarFlag.Cheat],
      ["r_ignore", "1", CvarFlag.Cheat],
      ["r_nocull", "0", CvarFlag.Cheat],
      ["r_novis", "0", CvarFlag.Cheat],
      ["r_showcluster", "0", CvarFlag.Cheat],
      ["r_speeds", "0", CvarFlag.Cheat],
      ["r_verbose", "0", CvarFlag.Cheat],
      ["r_logFile", "0", CvarFlag.Cheat],
      ["r_debugSurface", "0", CvarFlag.Cheat],
      ["r_nobind", "0", CvarFlag.Cheat],
      ["r_showtris", "0", CvarFlag.Cheat],
      ["r_showsky", "0", CvarFlag.Cheat],
      ["r_shownormals", "0", CvarFlag.Cheat],
      ["r_clear", "0", CvarFlag.Cheat],
      ["r_offsetfactor", "-1", CvarFlag.Cheat],
      ["r_offsetunits", "-2", CvarFlag.Cheat],
      ["r_drawBuffer", "GL_BACK", CvarFlag.Cheat],
      ["r_lockpvs", "0", CvarFlag.Cheat],
      ["r_noportals", "0", CvarFlag.Cheat],
      ["cg_shadows", "1", CvarFlag.None],
      ["r_maxpolys", "600", CvarFlag.None],
      ["r_maxpolyverts", "3000", CvarFlag.None],
      ["r_hardwareProfile", "generic", ARCHIVE_LATCH],
      ["r_driverProfile", "icd", ARCHIVE_LATCH],
    ];
    for (const [name, defaultValue, flags] of registrations) {
      registry.register(name, defaultValue, flags);
      if (name === "r_colorMipLevels") assertCvarRange(registry, "r_picmip", 0, 16, print);
      if (name === "r_ignorehwgamma") registerVideoModes(registry, initial);
      if (name === "r_displayRefresh") assertCvarRange(registry, "r_displayRefresh", 0, 200, print);
      if (name === "r_znear") assertCvarRange(registry, "r_znear", Math.fround(0.001), 200, print);
    }
  }

  get cvars(): CvarRegistry { return this.registry; }
}

export class SourceRendererSettings implements RendererSettings {
  readonly hardwareType: SourceRendererHardware;
  readonly driverType: SourceRendererDriver;
  readonly flares: SourceFlareSettings;
  readonly runtime: RendererSettings["runtime"];
  readonly visibility: RendererVisibilitySettings;
  readonly lighting: LightingScales;
  readonly rail: RailSettings;
  private initializedMultitexture: boolean;
  private initializedTextureEnvAdd: boolean;
  private initializedTextureUnits: number;
  get maxActiveTextures(): number { return this.initializedTextureUnits; }
  private readonly cvars: CvarRegistry;
  private readonly print: (text: string) => void;

  constructor(registered: RegisteredRendererCvars, capabilities: RendererCapabilities) {
    const cvars = registered.cvars;
    this.cvars = cvars;
    this.print = registered.print;
    const hardware = rendererHardware(this.required("r_hardwareProfile").value);
    this.hardwareType = hardware;
    this.driverType = rendererDriver(this.required("r_driverProfile").value);
    this.flares = {
      get enabled(): boolean {
        const value = cvars.get("r_flares");
        if (value === undefined) throw new Error("Renderer flare cvar is not registered");
        return value.integerValue !== 0;
      },
      get fade(): number {
        const value = cvars.get("r_flareFade");
        if (value === undefined) throw new Error("Renderer flare-fade cvar is not registered");
        return Math.fround(value.numericValue);
      },
      get size(): number {
        const value = cvars.get("r_flareSize");
        if (value === undefined) throw new Error("Renderer flare-size cvar is not registered");
        return Math.fround(value.numericValue);
      },
    };
    const extensions = this.enabled("r_allowExtensions");
    const multitexture = cvars.get("r_ext_multitexture");
    if (multitexture === undefined) throw new Error("Renderer multitexture cvar is not registered");
    this.initializedMultitexture = extensions && Math.fround(multitexture.numericValue) !== 0 && capabilities.textureUnits >= 2;
    this.initializedTextureEnvAdd = extensions && this.enabled("r_ext_texture_env_add") && capabilities.textureEnvAdd;
    this.initializedTextureUnits = this.initializedMultitexture ? capabilities.textureUnits : 0;
    this.rail = {
      get coreWidth(): number {
        const value = cvars.get("r_railCoreWidth");
        if (value === undefined) throw new Error("Renderer rail-core width cvar is not registered");
        return value.integerValue;
      },
      get ringWidth(): number {
        const value = cvars.get("r_railWidth");
        if (value === undefined) throw new Error("Renderer rail-ring width cvar is not registered");
        return value.integerValue;
      },
      get segmentLength(): number {
        const value = cvars.get("r_railSegmentLength");
        if (value === undefined) throw new Error("Renderer rail-segment length cvar is not registered");
        return Math.fround(value.numericValue);
      },
    };
    this.lighting = {
      get ambientScale(): number {
        const value = cvars.get("r_ambientScale");
        if (value === undefined) throw new Error("Renderer ambient-light scale cvar is not registered");
        return Math.fround(value.numericValue);
      },
      get directedScale(): number {
        const value = cvars.get("r_directedScale");
        if (value === undefined) throw new Error("Renderer directed-light scale cvar is not registered");
        return Math.fround(value.numericValue);
      },
    };
    this.visibility = {
      get drawWorld(): boolean {
        const value = cvars.get("r_drawworld");
        if (value === undefined) throw new Error("Renderer draw-world cvar is not registered");
        return value.integerValue !== 0;
      },
      get noVis(): boolean {
        const value = cvars.get("r_novis");
        if (value === undefined) throw new Error("Renderer no-vis cvar is not registered");
        return value.integerValue !== 0;
      },
      get lockPvs(): boolean {
        const value = cvars.get("r_lockpvs");
        if (value === undefined) throw new Error("Renderer lock-PVS cvar is not registered");
        return value.integerValue !== 0;
      },
      get showCluster(): boolean {
        const value = cvars.get("r_showcluster");
        if (value === undefined) throw new Error("Renderer show-cluster cvar is not registered");
        return value.integerValue !== 0;
      },
      get showClusterModified(): boolean {
        const value = cvars.get("r_showcluster");
        if (value === undefined) throw new Error("Renderer show-cluster cvar is not registered");
        return value.modified;
      },
      clearShowClusterModified(): void { cvars.clearModified("r_showcluster"); },
    };
    this.runtime = {
      get logFile(): number {
        const value = cvars.find("r_logfile");
        if (value === undefined) throw new Error("Renderer logging cvar is not registered");
        return value.integerValue;
      },
      get clear(): boolean {
        const value = cvars.find("r_clear");
        if (value === undefined) throw new Error("Renderer clear cvar is not registered");
        return value.integerValue !== 0;
      },
      get smpRequested(): boolean {
        const value = cvars.find("r_smp");
        if (value === undefined) throw new Error("Renderer SMP cvar is not registered");
        return value.integerValue !== 0;
      },
      get skipBackEnd(): boolean {
        const value = cvars.find("r_skipbackend");
        if (value === undefined) throw new Error("Renderer skip-backend cvar is not registered");
        return value.integerValue !== 0;
      },
      get noRefresh(): boolean {
        const value = cvars.find("r_norefresh");
        if (value === undefined) throw new Error("Renderer no-refresh cvar is not registered");
        return value.integerValue !== 0;
      },
      get drawEntities(): boolean {
        const value = cvars.find("r_drawentities");
        if (value === undefined) throw new Error("Renderer draw-entities cvar is not registered");
        return value.integerValue !== 0;
      },
      get developerEnabled(): boolean {
        const value = cvars.find("developer");
        return value !== undefined && value.integerValue !== 0;
      },
      get debugLight(): boolean {
        const value = cvars.find("r_debuglight");
        if (value === undefined) throw new Error("Renderer debug-light cvar is not registered");
        return value.integerValue !== 0;
      },
      get printShaders(): boolean {
        const value = cvars.find("r_printshaders");
        if (value === undefined) throw new Error("Renderer print-shaders cvar is not registered");
        return value.integerValue !== 0;
      },
      get debugSurface(): number {
        const value = cvars.find("r_debugsurface");
        if (value === undefined) throw new Error("Renderer debug-surface cvar is not registered");
        return value.integerValue;
      },
      get showImages(): number {
        const value = cvars.find("r_showimages");
        if (value === undefined) throw new Error("Renderer show-images cvar is not registered");
        return value.integerValue;
      },
      get speeds(): number {
        const value = cvars.find("r_speeds");
        if (value === undefined) throw new Error("Renderer speeds cvar is not registered");
        return value.integerValue;
      },
      get measureOverdraw(): number {
        const value = cvars.find("r_measureoverdraw");
        if (value === undefined) throw new Error("Renderer overdraw cvar is not registered");
        return value.integerValue;
      },
      get debugSort(): number {
        const value = cvars.find("r_debugsort");
        if (value === undefined) throw new Error("Renderer debug-sort cvar is not registered");
        return value.integerValue;
      },
      get showTris(): number {
        const value = cvars.find("r_showtris");
        if (value === undefined) throw new Error("Renderer show-tris cvar is not registered");
        return value.integerValue;
      },
      get showNormals(): number {
        const value = cvars.find("r_shownormals");
        if (value === undefined) throw new Error("Renderer show-normals cvar is not registered");
        return value.integerValue;
      },
      get primitives(): number {
        const value = cvars.find("r_primitives");
        if (value === undefined) throw new Error("Renderer primitives cvar is not registered");
        return value.integerValue;
      },
      get finish(): number {
        const value = cvars.find("r_finish");
        if (value === undefined) throw new Error("Renderer finish cvar is not registered");
        return value.integerValue;
      },
      get noCull(): boolean {
        const value = cvars.find("r_nocull");
        if (value === undefined) throw new Error("Renderer culling cvar is not registered");
        return value.integerValue !== 0;
      },
      get facePlaneCull(): boolean {
        const value = cvars.find("r_faceplanecull");
        if (value === undefined) throw new Error("Renderer face-culling cvar is not registered");
        return value.integerValue !== 0;
      },
      get noCurves(): boolean {
        const value = cvars.find("r_nocurves");
        if (value === undefined) throw new Error("Renderer curve-culling cvar is not registered");
        return value.integerValue !== 0;
      },
      get dynamicLights(): boolean {
        const dynamicLight = cvars.find("r_dynamiclight"), vertexLight = cvars.find("r_vertexlight");
        if (dynamicLight === undefined || vertexLight === undefined) throw new Error("Renderer dynamic-light cvars are not registered");
        return dynamicLight.integerValue !== 0 && vertexLight.integerValue !== 1 && hardware !== "permedia2";
      },
      get noPortals(): boolean {
        const value = cvars.find("r_noportals");
        if (value === undefined) throw new Error("Renderer portal cvar is not registered");
        return value.integerValue !== 0;
      },
      get portalOnly(): boolean {
        const value = cvars.find("r_portalonly");
        if (value === undefined) throw new Error("Renderer portal-only cvar is not registered");
        return value.integerValue !== 0;
      },
      get fastSky(): number {
        const value = cvars.find("r_fastsky");
        if (value === undefined) throw new Error("Renderer fast-sky cvar is not registered");
        return value.integerValue;
      },
      get showSky(): number {
        const value = cvars.find("r_showsky");
        if (value === undefined) throw new Error("Renderer show-sky cvar is not registered");
        return value.integerValue;
      },
      get drawSun(): number {
        const value = cvars.find("r_drawsun");
        if (value === undefined) throw new Error("Renderer r_drawSun cvar is not registered");
        return value.integerValue;
      },
      get lodCurveError(): number {
        const value = cvars.find("r_lodcurveerror");
        if (value === undefined) throw new Error("Renderer curve LOD cvar is not registered");
        return Math.fround(value.numericValue);
      },
      get lodBias(): number {
        const value = cvars.find("r_lodbias");
        if (value === undefined) throw new Error("Renderer model LOD bias cvar is not registered");
        return value.integerValue;
      },
      get lodScale(): number {
        const value = cvars.find("r_lodscale");
        if (value === undefined) throw new Error("Renderer model LOD scale cvar is not registered");
        return value.numericValue;
      },
      get zNear(): number {
        const value = cvars.find("r_znear");
        if (value === undefined) throw new Error("Renderer near-plane cvar is not registered");
        return value.numericValue;
      },
      get shadows(): number {
        const value = cvars.find("cg_shadows");
        if (value === undefined) throw new Error("Renderer shadow cvar is not registered");
        return value.integerValue;
      },
      get lightmap(): boolean {
        const value = cvars.find("r_lightmap");
        if (value === undefined) throw new Error("Renderer lightmap cvar is not registered");
        return value.integerValue !== 0;
      },
      get vertexLighting(): boolean {
        const vertexLight = cvars.find("r_vertexlight"), uiFullscreen = cvars.find("r_uifullscreen");
        if (vertexLight === undefined || uiFullscreen === undefined) throw new Error("Renderer vertex-lighting cvars are not registered");
        return (vertexLight.integerValue !== 0 && uiFullscreen.integerValue === 0) || hardware === "permedia2";
      },
      get polygonOffset(): { readonly factor: number; readonly units: number } {
        const factor = cvars.get("r_offsetfactor"), units = cvars.get("r_offsetunits");
        if (factor === undefined || units === undefined) throw new Error("Renderer polygon-offset cvars are not registered");
        return { factor: factor.numericValue, units: units.numericValue };
      },
    };
  }

  registrationProfile(): FinishShaderProfile {
    return {
      detailTextures: this.enabled("r_detailtextures"),
      vertexLight: this.enabled("r_vertexLight"),
      uiFullscreen: this.enabled("r_uifullscreen"),
      hardware: this.hardwareType === "permedia2" ? "permedia2" : "generic",
      iterator: {
        ignoreFastPath: this.enabled("r_ignoreFastPath"),
        multitexture: this.initializedMultitexture,
        textureEnvAdd: this.initializedTextureEnvAdd,
        driver: this.driverType === "voodoo" ? "voodoo" : "generic",
      },
    };
  }

  bspProfile(): RendererBspSettings {
    return {
      vertexLight: this.enabled("r_vertexLight"),
      fullbright: this.enabled("r_fullbright"),
      singleShader: this.enabled("r_singleShader"),
      mapOverbrightBits: this.required("r_mapOverBrightBits").integerValue,
      subdivisions: this.required("r_subdivisions").numericValue,
      lightmap: this.required("r_lightmap").integerValue,
    };
  }

  /** GLW_InitExtensions reads these only for a newly initialized GL context. */
  retainTextureExtensions(retained: { readonly maxActiveTextures: number; readonly textureEnvAddAvailable: boolean }): void {
    this.initializedTextureUnits = retained.maxActiveTextures;
    this.initializedMultitexture = retained.maxActiveTextures > 1;
    this.initializedTextureEnvAdd = retained.textureEnvAddAvailable;
  }

  /** GLW_InitExtensions reads these only for a newly initialized GL context. */
  extensionSettings(): SourceGlExtensionSettings {
    const settings = this;
    return { get allow() { return settings.required("r_allowExtensions").integerValue !== 0; },
      get compressedTextures() { return settings.required("r_ext_compressed_textures").numericValue !== 0; },
      get compiledVertexArrays() { return settings.required("r_ext_compiled_vertex_array").numericValue !== 0; },
      get textureEnvAdd() { return settings.required("r_ext_texture_env_add").integerValue !== 0; },
      get multitexture() { return settings.required("r_ext_multitexture").numericValue !== 0; }, print: this.print };
  }

  /** R_Init reads these non-latched cvars once for its backEndData allocation. */
  sceneLimits(): SceneSubmissionLimits {
    return { maxPolys: Math.max(600, this.required("r_maxpolys").integerValue),
      maxPolyVertices: Math.max(3000, this.required("r_maxpolyverts").integerValue) };
  }

  /** R_InitCommandBuffers with unix/linux_glimp.c's non-SMP build branch. */
  initializeNonThreadedCommandBuffers(print: (text: string) => undefined): void {
    if (this.enabled("r_smp")) {
      print("Trying SMP acceleration...\n");
      print("^3ERROR: SMP support was disabled at compile time\n");
      print("...failed.\n");
    }
  }

  get textureEnvAddAvailable(): boolean { return this.initializedTextureEnvAdd; }

  imageUploadSettings(): Pick<ImageUploadProfile, "picmip" | "roundImagesDown" | "simpleMipMaps" | "colorMipLevels" | "textureBits"> {
    return { picmip: this.required("r_picmip").integerValue, roundImagesDown: this.enabled("r_roundImagesDown"),
      simpleMipMaps: this.enabled("r_simpleMipMaps"), colorMipLevels: this.enabled("r_colorMipLevels"),
      textureBits: this.required("r_texturebits").integerValue };
  }

  get requestedOverbrightBits(): number { return this.required("r_overBrightBits").integerValue; }

  colorMappingInputs(device: Pick<ColorMappingInputs, "deviceSupportsGamma" | "isFullscreen" | "colorBits">): ColorMappingInputs {
    const requestedOverbrightBits = this.requestedOverbrightBits;
    // R_SetColorMappings writes intensity before gamma, including when gamma is invalid.
    if (this.required("r_intensity").numericValue <= 1) this.cvars.set("r_intensity", "1", true);
    const gamma = this.gammaValue();
    return { ...device, gamma, intensity: this.required("r_intensity").numericValue,
      requestedOverbrightBits };
  }

  get ignoreGLErrors(): boolean { return this.enabled("r_ignoreGLErrors"); }
  get noBind(): boolean { return this.enabled("r_nobind"); }
  get drawBuffer(): string { return this.required("r_drawBuffer").value; }
  get textureMode(): CvarSnapshot { return this.required("r_textureMode"); }
  textureModeProfile(): { readonly hardware: SourceRendererHardware; readonly print: (text: string) => void } {
    return { hardware: this.hardwareType, print: this.print };
  }
  clearTextureModeModified(): void { this.cvars.clearModified("r_textureMode"); }
  warnBadTextureMode(): void { this.print("bad filter name\n"); }

  /** RE_BeginFrame checks conflicts before synchronizing and always consumes modified. */
  beginOverdrawFrame(stencilBits: number, apply: (enabled: boolean) => undefined): void {
    if (this.required("r_measureOverdraw").integerValue !== 0) {
      if (stencilBits < 4) {
        this.print(`Warning: not enough stencil bits to measure overdraw: ${stencilBits}\n`);
        this.cvars.set("r_measureOverdraw", "0", true);
        this.cvars.clearModified("r_measureOverdraw");
      } else if (this.runtime.shadows === 2) {
        this.print("Warning: stencil shadows and overdraw measurement are mutually exclusive\n");
        this.cvars.set("r_measureOverdraw", "0", true);
        this.cvars.clearModified("r_measureOverdraw");
      } else {
        apply(true);
      }
    } else if (this.required("r_measureOverdraw").modified) {
      apply(false);
    }
    this.cvars.clearModified("r_measureOverdraw");
  }

  /** RE_BeginFrame clears this flag before synchronization and color mapping. */
  takeGammaModified(): boolean {
    const gamma = this.cvars.get("r_gamma");
    if (gamma === undefined) throw new Error("Renderer gamma cvar is not registered");
    if (!gamma.modified) return false;
    this.cvars.clearModified("r_gamma");
    return true;
  }

  /** The source float cvar field already carries binary32 rounding. */
  gammaValue(): number {
    const gamma = this.cvars.get("r_gamma");
    if (gamma === undefined) throw new Error("Renderer gamma cvar is not registered");
    if (Number.isNaN(gamma.numericValue)) throw new RangeError("Undefined native NaN gamma mapping");
    if (gamma.numericValue < 0.5) return this.cvars.set("r_gamma", "0.5", true).numericValue;
    if (gamma.numericValue > 3) return this.cvars.set("r_gamma", "3.0", true).numericValue;
    return gamma.numericValue;
  }

  private enabled(name: string): boolean {
    return this.required(name).integerValue !== 0;
  }

  private required(name: string): CvarSnapshot {
    const value = this.cvars.get(name);
    if (value === undefined) throw new Error(`Renderer cvar is not registered: ${name}`);
    return value;
  }
}
