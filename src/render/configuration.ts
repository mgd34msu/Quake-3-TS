// Renderer/client glconfig publication from tr_init.c and tr_model.c RE_BeginRegistration.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { SdlGammaCapability, SdlGammaLease, SdlWindow } from "../platform/sdl.ts";
import type { SoftwareRenderer } from "./cpu/rasterizer.ts";
import type { GlRenderer } from "./gl/renderer.ts";
import type { ThreadedGlRenderer, ThreadedSoftwareRenderer } from "./threaded-backend-proxy.ts";
import { ThreadedRendererBackend } from "./threaded-backend-proxy.ts";
import type { SourceRendererDriver, SourceRendererHardware, SourceRendererSettings } from "./settings.ts";
import type { RenderCommandBuffer } from "./commands.ts";
import { createImageColorMappings, imageColorLighting } from "./image-upload.ts";
import type { ImageColorLighting, ImageColorMappings, ImageUploadProfile } from "./image-upload.ts";
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { CommonError } from "../core/common-error.ts";

export type ConfiguredRenderer =
  | { readonly kind: "cpu"; readonly backend: SoftwareRenderer | ThreadedSoftwareRenderer }
  | { readonly kind: "gl"; readonly backend: GlRenderer | ThreadedGlRenderer };

interface ConfigurationFields {
  readonly rendererString: string;
  readonly vendorString: string;
  readonly versionString: string;
  readonly extensionsString: string;
  readonly maxActiveTextures: number;
  readonly colorBits: number;
  readonly depthBits: number;
  readonly stencilBits: number;
  readonly hardwareType: SourceRendererHardware;
  readonly deviceSupportsGamma: boolean;
  readonly gamma: SdlGammaCapability;
  readonly textureCompression: "none" | "s3tc";
  readonly compiledVertexArrays: boolean;
  readonly textureEnvAddAvailable: boolean;
  readonly vidWidth: number;
  readonly vidHeight: number;
  readonly windowAspect: number;
  readonly displayFrequency: number;
  readonly isFullscreen: boolean;
  readonly stereoEnabled: boolean;
  readonly smpActive: boolean;
}

export type RendererConfigurationSnapshot = ConfigurationFields & (
  | { readonly backend: "cpu"; readonly driverType: "cpu" | "standalone" | "voodoo"; readonly maxTextureSize: null; readonly depthStorage: "binary64" }
  | { readonly backend: "gl"; readonly driverType: SourceRendererDriver; readonly maxTextureSize: number; readonly depthStorage: "driver" }
);

export interface RendererConfigurationOptions {
  readonly window: SdlWindow;
  readonly renderer: ConfiguredRenderer;
  readonly settings: SourceRendererSettings;
  readonly windowAspect?: number;
}

/** R_Init clears tr; GLimp_Shutdown clears glConfig only when it destroys the window. */
export function emptyRendererConfiguration(backend: "cpu" | "gl"): RendererConfigurationSnapshot {
  const fields: ConfigurationFields = {
    rendererString: "", vendorString: "", versionString: "", extensionsString: "",
    maxActiveTextures: 0, colorBits: 0, depthBits: 0, stencilBits: 0, hardwareType: "generic",
    deviceSupportsGamma: false, gamma: { kind: "unavailable", reason: "Renderer gamma has not initialized" },
    textureCompression: "none", compiledVertexArrays: false, textureEnvAddAvailable: false, vidWidth: 0, vidHeight: 0, windowAspect: 0,
    displayFrequency: 0, isFullscreen: false, stereoEnabled: false, smpActive: false,
  };
  return backend === "cpu"
    ? { ...fields, backend: "cpu", driverType: "cpu", maxTextureSize: null, depthStorage: "binary64" }
    : { ...fields, backend: "gl", driverType: "icd", maxTextureSize: 0, depthStorage: "driver" };
}

/** GfxInfo_f also reads the retained or zero glConfig before InitOpenGL is reached. */
export function printRendererGfxInfo(cvars: CvarRegistry, source: {
  configuration(): RendererConfigurationSnapshot;
  overbrightBits(): number;
  assertCurrent(): void;
}, print: (text: string) => undefined): void {
  source.assertCurrent();
  cvars.register("sys_cpustring", "", CvarFlag.None);
  source.assertCurrent();
  const emit = (text: string): void => {
    source.assertCurrent(); print(text); source.assertCurrent();
  };
  const cvar = (name: string) => {
    const value = cvars.get(name);
    if (value === undefined) throw new Error(`Renderer cvar is not registered: ${name}`);
    return value;
  };
  emit(`\nGL_VENDOR: ${source.configuration().vendorString}\n`);
  emit(`GL_RENDERER: ${source.configuration().rendererString}\n`);
  emit(`GL_VERSION: ${source.configuration().versionString}\n`);
  emit(`GL_EXTENSIONS: ${source.configuration().extensionsString}\n`);
  const maximum = source.configuration().maxTextureSize;
  emit(`GL_MAX_TEXTURE_SIZE: ${maximum === null ? "N/A (CPU renderer)" : maximum}\n`);
  emit(`GL_MAX_ACTIVE_TEXTURES_ARB: ${source.configuration().maxActiveTextures}\n`);
  const pixel = source.configuration();
  emit(`\nPIXELFORMAT: color(${pixel.colorBits}-bits) Z(${pixel.depthBits}-bit) stencil(${pixel.stencilBits}-bits)\n`);
  const mode = source.configuration();
  emit(`MODE: ${cvar("r_mode").integerValue}, ${mode.vidWidth} x ${mode.vidHeight} ${cvar("r_fullscreen").integerValue === 1 ? "fullscreen" : "windowed"} hz:`);
  const frequency = source.configuration().displayFrequency;
  emit(frequency !== 0 ? `${frequency}\n` : "N/A\n");
  emit(`GAMMA: ${source.configuration().deviceSupportsGamma ? "hardware" : "software"} w/ ${source.overbrightBits()} overbright bits\n`);
  emit(`CPU: ${cvar("sys_cpustring").value}\n`);
  emit("rendering primitives: ");
  const requested = cvar("r_primitives").integerValue;
  const primitives = requested === 0 ? source.configuration().compiledVertexArrays ? 2 : 1 : requested;
  if (primitives === -1) emit("none\n");
  else if (primitives === 2) emit(source.configuration().backend === "gl" ? "single glDrawElements\n" : "CPU indexed triangles\n");
  else if (primitives === 1) emit(source.configuration().backend === "gl" ? "multiple glArrayElement\n" : "CPU array-element triangle strips\n");
  else if (primitives === 3) emit(source.configuration().backend === "gl"
    ? "multiple glColor4ubv + glTexCoord2fv + glVertex3fv\n" : "CPU discrete-element triangle strips\n");
  emit(`texturemode: ${cvar("r_textureMode").value}\n`);
  emit(`picmip: ${cvar("r_picmip").integerValue}\n`);
  emit(`texture bits: ${cvar("r_texturebits").integerValue}\n`);
  emit(`multitexture: ${source.configuration().maxActiveTextures > 1 ? "enabled" : "disabled"}\n`);
  emit(`compiled vertex arrays: ${source.configuration().compiledVertexArrays ? "enabled" : "disabled"}\n`);
  emit(`texenv add: ${source.configuration().textureEnvAddAvailable ? "enabled" : "disabled"}\n`);
  emit(`compressed textures: ${source.configuration().textureCompression === "s3tc" ? "enabled" : "disabled"}\n`);
  if (cvar("r_vertexLight").integerValue !== 0 || source.configuration().hardwareType === "permedia2")
    emit("HACK: using vertex lightmap approximation\n");
  if (source.configuration().hardwareType === "ragepro") emit("HACK: ragePro approximations\n");
  if (source.configuration().hardwareType === "riva128") emit("HACK: riva128 approximations\n");
  if (cvar("r_finish").integerValue !== 0) emit("Forcing glFinish\n");
}

/** source-sized copied strings, with no aliases back into a native buffer. */
function sourceString(text: string, capacity: number): string {
  const bytes = Buffer.from(text, "utf8"), end = bytes.indexOf(0);
  return bytes.subarray(0, Math.min(capacity - 1, end < 0 ? bytes.length : end)).toString("latin1");
}

/** The client copies this after renderer registration; UI_Init copies after game info. */
export class RendererConfiguration {
  private closed = false;
  private colorLighting: ImageColorLighting = { deviceSupportsGamma: false, overbrightBits: 0, identityLight: 0, identityLightByte: 0 };
  private colorMappings: ImageColorMappings | null = null;
  private constructor(private readonly options: RendererConfigurationOptions, private readonly gamma: SdlGammaLease) {}

  static create(options: RendererConfigurationOptions): RendererConfiguration {
    const result = RendererConfiguration.beginInitialization(options);
    try {
      result.initializeDefaultState();
      result.initializeColorMappings();
      return result;
    } catch (error) {
      try { result.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Renderer configuration initialization failed", { cause: error }); }
      throw error;
    }
  }

  static beginInitialization(options: RendererConfigurationOptions): RendererConfiguration {
    const { window, renderer } = options;
    if (window.backend !== renderer.kind) throw new Error("Renderer configuration requires the actual selected SDL backend");
    if (renderer.kind === "gl" && renderer.backend.window !== window)
      throw new Error("Renderer configuration requires the GL renderer's own SDL window");
    if ((options.settings.maxActiveTextures !== 0 && options.settings.maxActiveTextures !== renderer.backend.capabilities.textureUnits)
      || (options.settings.textureEnvAddAvailable && !renderer.backend.capabilities.textureEnvAdd))
      throw new Error("Renderer settings capabilities differ from the actual backend");
    const size = window.drawableSize;
    if (renderer.backend.width !== size.width || renderer.backend.height !== size.height)
      throw new Error("Renderer configuration dimensions differ from the actual SDL drawable");
    renderer.backend.images.setBindingSettings(options.settings);
    renderer.backend.images.setErrorSettings(options.settings);
    if (renderer.kind === "gl") {
      renderer.backend.initializeExtensions(options.settings.extensionSettings());
      options.settings.retainTextureExtensions(renderer.backend.textureExtensions);
    }
    renderer.backend.finish();
    const gamma = window.beginGamma();
    return new RendererConfiguration(options, gamma);
  }

  /** InitOpenGL reaches GL_SetDefaultState after command-buffer setup and GfxInfo_f. */
  initializeDefaultState(): void {
    this.requireOpen();
    const { renderer, settings } = this.options;
    const textureMode = (): undefined => {
      if (!renderer.backend.images.setTextureMode(settings.textureMode.value, settings.textureModeProfile())) settings.warnBadTextureMode();
      this.requireOpen();
    };
    if (renderer.kind === "gl") {
      renderer.backend.initializeDefaultState(settings.maxActiveTextures > 1, textureMode);
    } else {
      if (settings.maxActiveTextures !== 0) textureMode();
      textureMode();
    }
  }

  /** R_InitImages reaches color mappings before it creates any built-in image. */
  initializeColorMappings(commands?: RenderCommandBuffer): void {
    this.requireOpen();
    this.colorMappings = this.createColorMappings(commands);
    this.requireOpen();
    this.applyGamma();
    this.requireOpen();
  }

  private requireOpen(): void {
    if (this.closed || this.gamma.closed || this.options.window.closed) throw new Error("Renderer configuration is closed");
  }

  get gammaCapability(): SdlGammaCapability { this.requireOpen(); return this.gamma.capability; }

  /** Copy at the source trap call site, not during a menu's construction or cache. */
  copy(): RendererConfigurationSnapshot {
    this.requireOpen();
    const { window, renderer, settings } = this.options;
    const size = window.drawableSize, display = window.display, gamma = this.gamma.capability;
    const configuration: ConfigurationFields = {
      rendererString: renderer.kind === "gl" ? sourceString(renderer.backend.driver.renderer, 1024).replace(/\n$/, "") : "Quake III TypeScript CPU rasterizer",
      vendorString: renderer.kind === "gl" ? sourceString(renderer.backend.driver.vendor, 1024) : "Quake III TypeScript port",
      versionString: renderer.kind === "gl" ? sourceString(renderer.backend.driver.version, 1024) : "CPU implementation",
      extensionsString: renderer.kind === "gl" ? sourceString(renderer.backend.extensions, 8192) : "",
      maxActiveTextures: settings.maxActiveTextures,
      colorBits: renderer.kind === "gl" ? renderer.backend.colorBits : renderer.backend.configuration.colorBits,
      depthBits: renderer.kind === "gl" ? renderer.backend.depthBits : renderer.backend.configuration.depthBits,
      stencilBits: renderer.kind === "gl" ? renderer.backend.stencilBits : renderer.backend.configuration.stencilBits,
      hardwareType: settings.hardwareType, deviceSupportsGamma: gamma.kind === "api-accepted", gamma,
      textureCompression: renderer.kind === "gl" ? renderer.backend.textureCompression : "none", textureEnvAddAvailable: settings.textureEnvAddAvailable,
      compiledVertexArrays: renderer.kind === "gl" && renderer.backend.compiledVertexArrays,
      vidWidth: size.width, vidHeight: size.height, windowAspect: this.options.windowAspect ?? Math.fround(size.width / size.height),
      displayFrequency: display.refreshRate, isFullscreen: (window.flags & 1) !== 0,
      stereoEnabled: renderer.kind === "gl" ? renderer.backend.stereoEnabled : renderer.backend.configuration.stereoEnabled,
      smpActive: renderer.backend instanceof ThreadedRendererBackend,
    };
    return renderer.kind === "cpu"
      ? { ...configuration, backend: "cpu", driverType: settings.driverType === "icd" ? "cpu" : settings.driverType,
        maxTextureSize: null, depthStorage: "binary64" }
      : { ...configuration, backend: "gl", driverType: settings.driverType, maxTextureSize: renderer.backend.maxTextureSize, depthStorage: "driver" };
  }

  imageUploadProfile(): ImageUploadProfile {
    this.requireOpen();
    if (this.colorMappings === null) throw new Error("Renderer color mappings have not initialized");
    return { ...this.options.settings.imageUploadSettings(), colorMappings: this.colorMappings,
      textureCompression: this.options.renderer.kind === "gl" ? this.options.renderer.backend.textureCompression : "none",
      maxTextureSize: this.options.renderer.kind === "gl" ? this.options.renderer.backend.maxTextureSize : null };
  }

  /** tr_init.c:GfxInfo_f, using the caller's actual renderer cvar registry. */
  printGfxInfo(cvars: CvarRegistry, print: (text: string) => undefined): void {
    printRendererGfxInfo(cvars, { configuration: () => this.copy(),
      overbrightBits: () => this.colorLighting.overbrightBits,
      assertCurrent: () => this.requireOpen() }, print);
  }

  private createColorMappings(commands?: RenderCommandBuffer): ImageColorMappings {
    const { window, renderer, settings } = this.options;
    const device = { deviceSupportsGamma: this.gamma.capability.kind === "api-accepted",
      isFullscreen: (window.flags & 1) !== 0,
      colorBits: renderer.kind === "gl" ? renderer.backend.colorBits : renderer.backend.configuration.colorBits };
    this.colorLighting = imageColorLighting({ ...device, requestedOverbrightBits: settings.requestedOverbrightBits });
    commands?.setIdentityLight(this.colorLighting.identityLight);
    const inputs = settings.colorMappingInputs(device);
    this.requireOpen();
    return createImageColorMappings({ ...inputs, requestedOverbrightBits: this.colorLighting.overbrightBits });
  }

  private applyGamma(): void {
    if (this.gamma.capability.kind === "api-accepted") this.gamma.apply(this.options.settings.gammaValue());
  }

  /** RE_BeginFrame applies each eye's settings before queuing its draw buffer. */
  beginFrame(commands: RenderCommandBuffer, stereo: "center" | "left" | "right" = "center"): void {
    this.requireOpen();
    if (commands.target.images !== this.options.renderer.backend.images)
      throw new Error("Renderer configuration requires its own image command target");
    commands.beginFrame();
    this.options.renderer.backend.images.beginFrame();
    commands.tess.flares.beginFrame();
    this.options.settings.beginOverdrawFrame(this.options.renderer.backend.stencilBits,
      enabled => commands.setOverdrawMeasurement(enabled));
    this.gamma.synchronize();
    if (this.options.settings.textureMode.modified) {
      commands.submit();
      if (!this.options.renderer.backend.images.setTextureMode(this.options.settings.textureMode.value, this.options.settings.textureModeProfile()))
        this.options.settings.warnBadTextureMode();
      this.options.settings.clearTextureModeModified();
    }
    if (this.options.settings.takeGammaModified()) {
      commands.submit();
      this.colorMappings = this.createColorMappings(commands);
      this.applyGamma();
    }
    const renderer = this.options.renderer;
    // The CPU backend has no native GL error queue.
    if (renderer.kind === "gl" && !this.options.settings.ignoreGLErrors) {
      commands.submit();
      renderer.backend.checkFrameErrors();
    }
    const stereoEnabled = renderer.kind === "gl" ? renderer.backend.stereoEnabled : renderer.backend.configuration.stereoEnabled;
    if (stereoEnabled) {
      if (stereo === "left") commands.drawBuffer("back-left");
      else if (stereo === "right") commands.drawBuffer("back-right");
      else throw new CommonError("fatal", "RE_BeginFrame: Stereo is enabled, but stereoFrame was 0");
    } else {
      if (stereo !== "center") throw new CommonError("fatal", `RE_BeginFrame: Stereo is disabled, but stereoFrame was ${stereo === "left" ? 1 : 2}`);
      commands.drawBuffer(this.options.settings.drawBuffer.replace(/[a-z]/g, character => character.toUpperCase()) === "GL_FRONT" ? "front" : "back");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.gamma.close();
  }
}
