// SPDX-License-Identifier: GPL-2.0-or-later
// Replaces code/unix/linux_glimp.c window/context and HandleEvents platform duties.
// Event offsets follow SDL2 SDL_events.h; key translation remains a client duty.
import { dlopen, linkSymbols, ptr } from "bun:ffi";
import type { Pointer } from "bun:ffi";
import { endianness } from "node:os";

function loadSdl() {
  return dlopen(process.env["QUAKE_SDL2_LIBRARY"] ?? "libSDL2-2.0.so.0", {
    SDL_InitSubSystem: { args: ["u32"], returns: "i32" },
    SDL_SetHint: { args: ["buffer", "buffer"], returns: "i32" },
    SDL_QuitSubSystem: { args: ["u32"], returns: "void" },
    SDL_GetError: { args: [], returns: "cstring" },
    SDL_CreateWindow: { args: ["buffer", "i32", "i32", "i32", "i32", "u32"], returns: "ptr" },
    SDL_DestroyWindow: { args: ["ptr"], returns: "void" },
    SDL_GetWindowID: { args: ["ptr"], returns: "u32" },
    SDL_GetWindowFlags: { args: ["ptr"], returns: "u32" },
    SDL_SetWindowFullscreen: { args: ["ptr", "u32"], returns: "i32" },
    SDL_GetWindowDisplayIndex: { args: ["ptr"], returns: "i32" },
    SDL_GetNumVideoDisplays: { args: [], returns: "i32" },
    SDL_GetDisplayName: { args: ["i32"], returns: "cstring" },
    SDL_GetCurrentDisplayMode: { args: ["i32", "buffer"], returns: "i32" },
    SDL_GetClosestDisplayMode: { args: ["i32", "buffer", "buffer"], returns: "ptr" },
    SDL_SetWindowDisplayMode: { args: ["ptr", "buffer"], returns: "i32" },
    SDL_GetWindowGammaRamp: { args: ["ptr", "buffer", "buffer", "buffer"], returns: "i32" },
    SDL_SetWindowGammaRamp: { args: ["ptr", "buffer", "buffer", "buffer"], returns: "i32" },
    SDL_CalculateGammaRamp: { args: ["f32", "buffer"], returns: "void" },
    SDL_GetTicks: { args: [], returns: "u32" },
    SDL_SetRelativeMouseMode: { args: ["i32"], returns: "i32" },
    SDL_GetRelativeMouseMode: { args: [], returns: "i32" },
    SDL_StartTextInput: { args: [], returns: "void" },
    SDL_StopTextInput: { args: [], returns: "void" },
    SDL_NumJoysticks: { args: [], returns: "i32" },
    SDL_JoystickOpen: { args: ["i32"], returns: "ptr" },
    SDL_JoystickClose: { args: ["ptr"], returns: "void" },
    SDL_JoystickInstanceID: { args: ["ptr"], returns: "i32" },
    SDL_JoystickName: { args: ["ptr"], returns: "cstring" },
    SDL_JoystickNumAxes: { args: ["ptr"], returns: "i32" },
    SDL_JoystickNumButtons: { args: ["ptr"], returns: "i32" },
    SDL_JoystickNumHats: { args: ["ptr"], returns: "i32" },
    SDL_JoystickNumBalls: { args: ["ptr"], returns: "i32" },
    SDL_JoystickUpdate: { args: [], returns: "void" },
    SDL_CreateRenderer: { args: ["ptr", "i32", "u32"], returns: "ptr" },
    SDL_DestroyRenderer: { args: ["ptr"], returns: "void" },
    SDL_GetRendererOutputSize: { args: ["ptr", "buffer", "buffer"], returns: "i32" },
    SDL_CreateTexture: { args: ["ptr", "u32", "i32", "i32", "i32"], returns: "ptr" },
    SDL_DestroyTexture: { args: ["ptr"], returns: "void" },
    SDL_SetTextureBlendMode: { args: ["ptr", "i32"], returns: "i32" },
    SDL_UpdateTexture: { args: ["ptr", "ptr", "buffer", "i32"], returns: "i32" },
    SDL_RenderCopy: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    SDL_RenderPresent: { args: ["ptr"], returns: "void" },
    SDL_RenderReadPixels: { args: ["ptr", "ptr", "u32", "buffer", "i32"], returns: "i32" },
    SDL_PollEvent: { args: ["buffer"], returns: "i32" },
    SDL_PeepEvents: { args: ["buffer", "i32", "i32", "u32", "u32"], returns: "i32" },
    SDL_PushEvent: { args: ["buffer"], returns: "i32" },
    SDL_EventState: { args: ["u32", "i32"], returns: "u8" },
    SDL_GL_SetAttribute: { args: ["i32", "i32"], returns: "i32" },
    SDL_GL_LoadLibrary: { args: ["ptr"], returns: "i32" },
    SDL_GL_UnloadLibrary: { args: [], returns: "void" },
    SDL_GL_GetAttribute: { args: ["i32", "buffer"], returns: "i32" },
    SDL_GL_CreateContext: { args: ["ptr"], returns: "ptr" },
    SDL_GL_DeleteContext: { args: ["ptr"], returns: "void" },
    SDL_GL_MakeCurrent: { args: ["ptr", "ptr"], returns: "i32" },
    SDL_GL_GetDrawableSize: { args: ["ptr", "buffer", "buffer"], returns: "void" },
    SDL_GL_GetProcAddress: { args: ["buffer"], returns: "ptr" },
    SDL_GL_SwapWindow: { args: ["ptr"], returns: "void" },
  });
}

let library: ReturnType<typeof loadSdl> | undefined;
function sdl() {
  library ??= loadSdl();
  return library.symbols;
}

const videoSubsystem = 0x20;
const rgba32 = endianness() === "LE" ? 0x16762004 : 0x16462004;
const littleEndian = endianness() === "LE";
const windows = new Map<number, SdlWindow>();
let inputLease: SdlInputLease | null = null;
let gammaLease: SdlGammaLease | null = null;

function checked(result: number, operation: string): void {
  if (result < 0) throw new Error(`${operation}: ${sdl().SDL_GetError()}`);
}

function handle(result: Pointer | null, operation: string): Pointer {
  if (result === null) throw new Error(`${operation}: ${sdl().SDL_GetError()}`);
  return result;
}

function cString(value: string): Buffer {
  if (value.includes("\0")) throw new Error("SDL string contains NUL");
  return Buffer.from(`${value}\0`, "utf8");
}

function initializeSubsystem(subsystem: number, operation: string): void {
  const api = sdl();
  if (api.SDL_SetHint(cString("SDL_NO_SIGNAL_HANDLERS"), cString("1")) !== 1)
    throw new Error("SDL must leave signal handling to the Unix signal owner");
  checked(api.SDL_InitSubSystem(subsystem), operation);
}

interface SdlWindowDimensions {
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly hidden?: boolean;
  readonly fullscreen?: boolean;
  readonly displayRefresh?: number;
}
export type SdlWindowOptions = SdlWindowDimensions &
  ({ readonly backend: "cpu" } | { readonly backend: "gl"; readonly stereo?: boolean;
    readonly stencilBits?: number; readonly colorBits?: number; readonly depthBits?: number; readonly driver?: string;
    readonly allowSoftwareGl?: boolean });

/** GLW_SetMode's sixteen visual attempts, including the depth/stencil fallthrough. */
function* visualAttempts(requestedColor: number, requestedDepth: number, requestedStencil: number) {
  let color = requestedColor;
  let depth = requestedDepth;
  let stencil = requestedStencil;
  const reduce = (bits: number): number => bits === 24 ? 16 : bits === 16 ? 8 : bits;
  for (let index = 0; index < 16; index++) {
    if (index === 4) { depth = reduce(depth); stencil = reduce(stencil); }
    if (index === 8 && color === 24) color = 16;
    if (index === 12) stencil = reduce(stencil);
    const candidateColor = index % 4 === 3 && color === 24 ? 16 : color;
    yield {
      component: candidateColor === 24 ? 8 : 4,
      depth: index % 4 === 2 ? reduce(depth) : depth,
      stencil: index % 4 === 1 ? stencil === 24 ? 16 : stencil === 16 ? 8 : 0 : stencil,
    };
  }
}

function nativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
    throw new RangeError(`${name} must be a signed 32-bit integer`);
}

/** Linux tests the stored cvar float for zero before assigning it to an int. */
function sourceVisualPrecision(value: number, name: string): number {
  const numeric = Math.fround(value);
  if (numeric === 0) return 24;
  const integer = Math.trunc(numeric);
  nativeInteger(integer, name);
  return integer;
}

function fullscreen(window: Pointer, options: SdlWindowOptions): string | null {
  if (options.fullscreen !== true) return null;
  const api = sdl(), refresh = options.displayRefresh ?? 0;
  const index = api.SDL_GetWindowDisplayIndex(window);
  checked(index, "SDL_GetWindowDisplayIndex");
  // SDL2 SDL_DisplayMode: four 32-bit fields and an aligned driver pointer.
  const requested = new Uint8Array(24), closest = new Uint8Array(24);
  const view = new DataView(requested.buffer);
  view.setInt32(4, options.width, littleEndian);
  view.setInt32(8, options.height, littleEndian);
  view.setInt32(12, refresh, littleEndian);
  // GLW_SetMode continues windowed when no mode fits, leaving the cvars alone.
  // SDL replaces XF86 matching with size/format/refresh ordering; Linux ignores refresh.
  if (api.SDL_GetClosestDisplayMode(index, requested, closest) === null) {
    const failure = `SDL_GetClosestDisplayMode: ${api.SDL_GetError()}`;
    if ((api.SDL_GetWindowFlags(window) & 1) !== 0)
      throw new Error(`${failure}; SDL's newly created window is unexpectedly fullscreen`);
    return failure;
  }
  let failure: string;
  if (api.SDL_SetWindowDisplayMode(window, closest) < 0) failure = `SDL_SetWindowDisplayMode: ${api.SDL_GetError()}`;
  else if (api.SDL_SetWindowFullscreen(window, 1) < 0) failure = `SDL_SetWindowFullscreen: ${api.SDL_GetError()}`;
  else if ((api.SDL_GetWindowFlags(window) & 1) !== 0) return null;
  else failure = "SDL did not enter the requested fullscreen mode";
  // SDL transition failures have no XF86 counterpart. Continue only after restoring
  // the actual window; failed restoration remains a fatal initialization error.
  checked(api.SDL_SetWindowFullscreen(window, 0), `SDL_SetWindowFullscreen windowed fallback after ${failure}`);
  if ((api.SDL_GetWindowFlags(window) & 1) !== 0) throw new Error(`${failure}; SDL did not restore windowed mode`);
  return failure;
}

export interface SdlInputLease {
  readonly closed: boolean;
  setRelativeMouse(enabled: boolean): void;
  close(): void;
}

export interface SdlDisplay {
  readonly index: number;
  readonly name: string;
  readonly count: number;
  readonly refreshRate: number;
}
export type SdlGammaCapability =
  | { readonly kind: "api-accepted"; readonly displayIndex: number; readonly displayName: string }
  | { readonly kind: "unsupported" | "unavailable" | "retired"; readonly reason: string };
export interface SdlGammaLease {
  readonly capability: SdlGammaCapability;
  readonly closed: boolean;
  synchronize(): void;
  apply(gamma: number): void;
  close(): void;
}

function gammaRamp(): { readonly red: Uint16Array; readonly green: Uint16Array; readonly blue: Uint16Array } {
  return { red: new Uint16Array(256), green: new Uint16Array(256), blue: new Uint16Array(256) };
}

export type SdlEvent =
  | { readonly kind: "quit"; readonly timestamp: number }
  | { readonly kind: "key"; readonly timestamp: number; readonly down: boolean; readonly repeat: boolean; readonly scancode: number; readonly keycode: number; readonly modifiers: number }
  | { readonly kind: "text"; readonly timestamp: number; readonly text: string }
  | { readonly kind: "mouse-motion"; readonly timestamp: number; readonly buttons: number; readonly x: number; readonly y: number; readonly dx: number; readonly dy: number }
  | { readonly kind: "mouse-button"; readonly timestamp: number; readonly down: boolean; readonly button: number; readonly clicks: number; readonly x: number; readonly y: number }
  | { readonly kind: "mouse-wheel"; readonly timestamp: number; readonly x: number; readonly y: number; readonly preciseX: number; readonly preciseY: number; readonly flipped: boolean }
  | { readonly kind: "window"; readonly timestamp: number; readonly event: number; readonly data1: number; readonly data2: number }
  | SdlJoystickEvent
  | { readonly kind: "unsupported"; readonly timestamp: number; readonly type: number };

export type SdlJoystickEvent =
  | { readonly kind: "joystick-axis"; readonly timestamp: number; readonly instance: number; readonly axis: number; readonly value: number }
  | { readonly kind: "joystick-button"; readonly timestamp: number; readonly instance: number; readonly button: number; readonly down: boolean }
  | { readonly kind: "joystick-removed"; readonly timestamp: number; readonly instance: number };

// sdl2-compat 2.32.70 cannot convert injected text safely or wheel steps faithfully.
// Native text/wheel input is decoded normally; neither is synthetically injected.
export type SdlInjectedEvent = Exclude<SdlEvent, SdlJoystickEvent | { readonly kind: "unsupported" | "text" | "mouse-wheel" }>;

type Resources =
  | { readonly kind: "cpu"; readonly window: Pointer; readonly renderer: Pointer; readonly texture: Pointer }
  | { readonly kind: "gl"; readonly window: Pointer; readonly context: Pointer; readonly driver: string | null };

function decodeEvent(bytes: Uint8Array): SdlEvent {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (offset: number): number => view.getUint32(offset, littleEndian);
  const i32 = (offset: number): number => view.getInt32(offset, littleEndian);
  const type = u32(0);
  const timestamp = u32(4);
  switch (type) {
    case 0x100: return { kind: "quit", timestamp };
    case 0x200: return { kind: "window", timestamp, event: view.getUint8(12), data1: i32(16), data2: i32(20) };
    case 0x300:
    case 0x301:
      return { kind: "key", timestamp, down: type === 0x300, repeat: view.getUint8(13) !== 0, scancode: i32(16), keycode: i32(20), modifiers: view.getUint16(24, littleEndian) };
    case 0x303: {
      const textBytes = bytes.subarray(12, 44);
      const end = textBytes.indexOf(0);
      return { kind: "text", timestamp, text: new TextDecoder("utf-8", { fatal: true }).decode(end < 0 ? textBytes : textBytes.subarray(0, end)) };
    }
    case 0x400: return { kind: "mouse-motion", timestamp, buttons: u32(16), x: i32(20), y: i32(24), dx: i32(28), dy: i32(32) };
    case 0x401:
    case 0x402:
      return { kind: "mouse-button", timestamp, down: type === 0x401, button: view.getUint8(16), clicks: view.getUint8(18), x: i32(20), y: i32(24) };
    case 0x403: return { kind: "mouse-wheel", timestamp, x: i32(16), y: i32(20), preciseX: view.getFloat32(28, littleEndian), preciseY: view.getFloat32(32, littleEndian), flipped: u32(24) === 1 };
    case 0x600: return { kind: "joystick-axis", timestamp, instance: i32(8), axis: view.getUint8(12), value: view.getInt16(16, littleEndian) };
    case 0x603:
    case 0x604: return { kind: "joystick-button", timestamp, instance: i32(8), button: view.getUint8(12), down: type === 0x603 };
    case 0x606: return { kind: "joystick-removed", timestamp, instance: i32(8) };
    default: return { kind: "unsupported", timestamp, type };
  }
}

export class SdlWindow {
  private resources: Resources | null;
  private pending: SdlEvent[] = [];
  private hasFrame = false;
  private input: SdlInputLease | null = null;
  private gamma: SdlGammaLease | null = null;

  private constructor(resources: Resources, readonly width: number, readonly height: number, readonly id: number,
    readonly fullscreenFailure: string | null) {
    this.resources = resources;
  }

  static open(options: SdlWindowOptions): SdlWindow {
    for (const dimension of [options.width, options.height]) {
      if (!Number.isInteger(dimension) || dimension <= 0 || dimension > 16384) throw new Error("SDL window dimensions must be integers in 1..16384");
    }
    nativeInteger(options.displayRefresh ?? 0, "SDL display refresh");
    const colorBits = options.backend === "gl" ? sourceVisualPrecision(options.colorBits ?? 0, "SDL color precision") : 0;
    const depthBits = options.backend === "gl" ? sourceVisualPrecision(options.depthBits ?? 0, "SDL depth precision") : 0;
    if (options.backend === "gl") {
      const stencilBits = options.stencilBits ?? 0;
      if (!Number.isInteger(stencilBits) || stencilBits < 0 || stencilBits > 32) throw new RangeError("SDL stencil precision must be an integer in 0..32");
    }
    const title = cString(options.title);
    const driver = options.backend === "gl" ? options.driver ?? null : null;
    const driverName = driver === null ? null : cString(driver);
    let sharingDriver = false;
    if (driver === "") throw new Error("SDL GL driver name is empty");
    if (options.backend === "gl") {
      for (const existing of windows.values()) {
        const current = existing.resources;
        if (current?.kind === "gl" && current.driver !== driver)
          throw new Error("SDL cannot select different GL libraries for concurrent windows");
        if (current?.kind === "gl") sharingDriver = true;
      }
    }
    // SDL's EGL/offscreen loader can accept a path without loading that library.
    // This replacement supports the system GL library, not legacy vendor drivers.
    if (driver !== null && driver !== "libGL.so.1")
      throw new Error(`Unsupported SDL system OpenGL driver: ${driver}`);
    const api = sdl();
    initializeSubsystem(videoSubsystem, "SDL_InitSubSystem");
    let window: Pointer | null = null;
    let renderer: Pointer | null = null;
    let texture: Pointer | null = null;
    let context: Pointer | null = null;
    let driverLoaded = false;
    try {
      // These event types own native strings and are outside the game input contract.
      api.SDL_EventState(0x1000, 0);
      api.SDL_EventState(0x1001, 0);
      api.SDL_EventState(0x305, 0);
      const flags = (options.hidden === true ? 0x8 : 0x4) | (options.backend === "gl" ? 0x2 : 0);
      if (options.backend === "gl") {
        if (driverName !== null) {
          checked(api.SDL_GL_LoadLibrary(sharingDriver ? null : ptr(driverName)), "SDL_GL_LoadLibrary");
          driverLoaded = true;
        }
        checked(api.SDL_GL_SetAttribute(17, 2), "SDL_GL_CONTEXT_MAJOR_VERSION");
        checked(api.SDL_GL_SetAttribute(18, 1), "SDL_GL_CONTEXT_MINOR_VERSION");
        checked(api.SDL_GL_SetAttribute(21, 2), "SDL_GL_CONTEXT_PROFILE_COMPATIBILITY");
        checked(api.SDL_GL_SetAttribute(5, 1), "SDL_GL_DOUBLEBUFFER");
        // Portable renderer stereo support; the pinned Linux GLX path ignores r_stereo.
        // SDL retains attributes across windows, so a mono context must request zero.
        checked(api.SDL_GL_SetAttribute(12, Number(options.stereo === true)), "SDL_GL_STEREO");
        checked(api.SDL_GL_SetAttribute(3, 0), "SDL_GL_ALPHA_SIZE");
        const failures: unknown[] = [];
        for (const visual of visualAttempts(colorBits, depthBits, options.stencilBits ?? 0)) {
          try {
            for (const attribute of [0, 1, 2]) checked(api.SDL_GL_SetAttribute(attribute, visual.component), "SDL_GL RGB_SIZE");
            checked(api.SDL_GL_SetAttribute(6, visual.depth), "SDL_GL_DEPTH_SIZE");
            checked(api.SDL_GL_SetAttribute(7, visual.stencil), "SDL_GL_STENCIL_SIZE");
            window = handle(api.SDL_CreateWindow(title, 0x1fff0000, 0x1fff0000, options.width, options.height, flags), "SDL_CreateWindow");
            context = handle(api.SDL_GL_CreateContext(window), "SDL_GL_CreateContext");
            checked(api.SDL_GL_MakeCurrent(window, context), "SDL_GL_MakeCurrent");
            const attributes: readonly (readonly [number, number])[] = [
              [0, visual.component], [1, visual.component], [2, visual.component], [3, 0], [6, visual.depth], [7, visual.stencil],
            ];
            for (const [attribute, minimum] of attributes) {
              const actual = new Int32Array(1);
              checked(api.SDL_GL_GetAttribute(attribute, actual), "SDL_GL_GetAttribute");
              const bits = actual[0];
              if (bits === undefined || bits < 0 || bits < minimum) throw new Error(`SDL visual attribute ${attribute} did not satisfy ${minimum} bits`);
            }
            break;
          } catch (error) {
            failures.push(error);
            if (context !== null) api.SDL_GL_DeleteContext(context);
            if (window !== null) api.SDL_DestroyWindow(window);
            context = null; window = null;
          }
        }
        if (window === null || context === null) throw new AggregateError(failures, "SDL could not create any source GL visual candidate");
        if (options.allowSoftwareGl === false) {
          const rendererQuery = linkSymbols({ glGetString: { args: ["u32"], returns: "cstring",
            ptr: handle(api.SDL_GL_GetProcAddress(cString("glGetString")), "SDL_GL_GetProcAddress glGetString") } });
          try {
            const rendererName = String(rendererQuery.symbols.glGetString(0x1f01)).toLowerCase();
            // GLW_SetMode rejects only these two source tokens, not modern Mesa drivers.
            if (rendererName === "mesa x11" || rendererName === "mesa glx indirect")
              throw new Error("You are using software Mesa; add +set r_allowSoftwareGL 1 to allow this driver");
          } finally { rendererQuery.close(); }
        }
      } else window = handle(api.SDL_CreateWindow(title, 0x1fff0000, 0x1fff0000, options.width, options.height, flags), "SDL_CreateWindow");
      const fullscreenFailure = fullscreen(window, options);
      const drawableWidth = new Int32Array(1), drawableHeight = new Int32Array(1);
      let resources: Resources;
      if (options.backend === "cpu") {
        renderer = handle(api.SDL_CreateRenderer(window, -1, 1), "SDL_CreateRenderer SOFTWARE");
        checked(api.SDL_GetRendererOutputSize(renderer, drawableWidth, drawableHeight), "SDL_GetRendererOutputSize");
        const width = drawableWidth[0], height = drawableHeight[0];
        if (width === undefined || height === undefined || width <= 0 || height <= 0) throw new Error("SDL returned invalid drawable dimensions");
        texture = handle(api.SDL_CreateTexture(renderer, rgba32, 1, width, height), "SDL_CreateTexture");
        checked(api.SDL_SetTextureBlendMode(texture, 0), "SDL_SetTextureBlendMode NONE");
        resources = { kind: "cpu", window, renderer, texture };
      } else {
        if (context === null) throw new Error("SDL GL visual has no context");
        api.SDL_GL_GetDrawableSize(window, drawableWidth, drawableHeight);
        resources = { kind: "gl", window, context, driver };
      }
      const id = api.SDL_GetWindowID(window);
      if (id === 0) throw new Error(`SDL_GetWindowID: ${api.SDL_GetError()}`);
      const width = drawableWidth[0], height = drawableHeight[0];
      if (width === undefined || height === undefined || width <= 0 || height <= 0) throw new Error("SDL returned invalid drawable dimensions");
      const result = new SdlWindow(resources, width, height, id, fullscreenFailure);
      windows.set(id, result);
      return result;
    } catch (error) {
      if (texture !== null) api.SDL_DestroyTexture(texture);
      if (renderer !== null) api.SDL_DestroyRenderer(renderer);
      if (context !== null) api.SDL_GL_DeleteContext(context);
      if (window !== null) api.SDL_DestroyWindow(window);
      if (driverLoaded) api.SDL_GL_UnloadLibrary();
      api.SDL_QuitSubSystem(videoSubsystem);
      throw error;
    }
  }

  private opened(): Resources {
    if (this.resources === null) throw new Error("SDL window is closed");
    return this.resources;
  }

  get flags(): number { return sdl().SDL_GetWindowFlags(this.opened().window); }
  get ticks(): number { this.opened(); return sdl().SDL_GetTicks(); }
  get closed(): boolean { return this.resources === null; }
  get relativeMouse(): boolean { return this.input !== null && inputLease === this.input && sdl().SDL_GetRelativeMouseMode() !== 0; }
  get backend(): "cpu" | "gl" { return this.opened().kind; }

  get display(): SdlDisplay {
    const api = sdl(), index = api.SDL_GetWindowDisplayIndex(this.opened().window), count = api.SDL_GetNumVideoDisplays();
    checked(index, "SDL_GetWindowDisplayIndex"); checked(count, "SDL_GetNumVideoDisplays");
    // SDL_DisplayMode has four 32-bit fields followed by a pointer; only refresh_rate is read.
    const mode = new Uint8Array(24);
    checked(api.SDL_GetCurrentDisplayMode(index, mode), "SDL_GetCurrentDisplayMode");
    return { index, count, name: String(api.SDL_GetDisplayName(index)), refreshRate: new DataView(mode.buffer).getInt32(12, littleEndian) };
  }

  /** One selected gamma window, on one display. SDL owns native focus restoration.
   * SDL getters cache ramps; successful Set is API acceptance, never hardware readback.
   * Display migration/replug is unsupported. Poll-time checks cannot undo earlier SDL actions.
   */
  beginGamma(): SdlGammaLease {
    const resources = this.opened();
    if (gammaLease !== null) throw new Error("SDL display gamma already has an owner");
    const display = this.display, api = sdl();
    let capability: SdlGammaCapability;
    let original: ReturnType<typeof gammaRamp> | null = null;
    if (display.count !== 1) capability = { kind: "unavailable", reason: "Gamma requires the single-display ownership profile" };
    else if ((this.flags & 0x200) === 0) capability = { kind: "unavailable", reason: "Gamma acquisition requires actual native input focus" };
    else {
      const ramp = gammaRamp();
      if (api.SDL_GetWindowGammaRamp(resources.window, ramp.red, ramp.green, ramp.blue) < 0)
        capability = { kind: "unsupported", reason: `SDL_GetWindowGammaRamp: ${api.SDL_GetError()}` };
      else if (api.SDL_SetWindowGammaRamp(resources.window, ramp.red, ramp.green, ramp.blue) < 0)
        capability = { kind: "unsupported", reason: `SDL_SetWindowGammaRamp: ${api.SDL_GetError()}` };
      else {
        original = ramp;
        capability = { kind: "api-accepted", displayIndex: display.index, displayName: display.name };
      }
    }
    const sameDisplay = (current: SdlDisplay): boolean => current.index === display.index && current.name === display.name;
    const restore = (): void => {
      if (original === null) return;
      if (!sameDisplay(this.display)) return;
      const ramp = original;
      checked(api.SDL_SetWindowGammaRamp(resources.window, ramp.red, ramp.green, ramp.blue), "SDL_SetWindowGammaRamp restore");
      original = null;
    };
    const lease: SdlGammaLease = {
      get closed(): boolean { return gammaLease !== lease; },
      get capability(): SdlGammaCapability { lease.synchronize(); return { ...capability }; },
      synchronize: (): void => {
        if (gammaLease !== lease) return;
        if (capability.kind !== "api-accepted") return;
        const current = this.display;
        if (current.count === 1 && sameDisplay(current)) return;
        capability = { kind: "retired", reason: "SDL display topology changed; hardware continuity and cross-display restoration are unsupported" };
        restore();
      },
      apply: (gamma: number): void => {
        if (gammaLease !== lease) throw new Error("SDL gamma lease is closed");
        if (!Number.isFinite(gamma) || gamma < 0.5 || gamma > 3) throw new RangeError("Gamma requires a finite value in 0.5..3");
        lease.synchronize();
        if (capability.kind !== "api-accepted") throw new Error(`SDL gamma is ${capability.kind}: ${capability.reason}`);
        const ramp = new Uint16Array(256);
        // Linux GLimp_SetGamma consumes r_gamma itself, not the renderer's overbright table.
        api.SDL_CalculateGammaRamp(Math.fround(gamma), ramp);
        checked(api.SDL_SetWindowGammaRamp(resources.window, ramp, ramp, ramp), "SDL_SetWindowGammaRamp");
      },
      close: (): void => {
        if (gammaLease !== lease) return;
        try { restore(); }
        finally { gammaLease = null; }
      },
    };
    gammaLease = lease;
    this.gamma = lease;
    return lease;
  }

  /** SDL text and relative mouse modes are process-global; one gameplay owner leases both. */
  beginInput(): SdlInputLease {
    this.opened();
    if (inputLease !== null) throw new Error("SDL gameplay input already has an owner");
    let relative = false;
    const lease: SdlInputLease = {
      get closed(): boolean { return inputLease !== lease; },
      setRelativeMouse: (enabled: boolean): void => {
        this.opened();
        if (inputLease !== lease) throw new Error("SDL input lease is closed");
        if (relative === enabled && this.relativeMouse === enabled) return;
        checked(sdl().SDL_SetRelativeMouseMode(Number(enabled)), "SDL_SetRelativeMouseMode");
        relative = enabled;
      },
      close: (): void => {
        if (inputLease !== lease) return;
        const errors: unknown[] = [];
        try { if (relative) checked(sdl().SDL_SetRelativeMouseMode(0), "SDL_SetRelativeMouseMode release"); }
        catch (error) { errors.push(error); }
        try { sdl().SDL_StopTextInput(); } catch (error) { errors.push(error); }
        inputLease = null;
        if (errors.length !== 0) throw new AggregateError(errors, "SDL input release failed");
      },
    };
    sdl().SDL_StartTextInput();
    inputLease = lease;
    this.input = lease;
    return lease;
  }

  get drawableSize(): { readonly width: number; readonly height: number } {
    const resources = this.opened();
    const width = new Int32Array(1);
    const height = new Int32Array(1);
    if (resources.kind === "cpu") checked(sdl().SDL_GetRendererOutputSize(resources.renderer, width, height), "SDL_GetRendererOutputSize");
    else sdl().SDL_GL_GetDrawableSize(resources.window, width, height);
    const w = width[0];
    const h = height[0];
    if (w === undefined || h === undefined || w <= 0 || h <= 0) throw new Error("SDL returned invalid drawable dimensions");
    return { width: w, height: h };
  }

  pollEvents(): readonly SdlEvent[] {
    this.opened();
    gammaLease?.synchronize();
    const bytes = new Uint8Array(56);
    const view = new DataView(bytes.buffer);
    while (sdl().SDL_PollEvent(bytes) === 1) {
      const event = decodeEvent(bytes);
      if (SdlJoystick.queueEvent(event)) continue;
      const type = view.getUint32(0, littleEndian);
      const targeted = type === 0x200 || (type >= 0x300 && type <= 0x305) || (type >= 0x400 && type <= 0x403);
      if (targeted) windows.get(view.getUint32(8, littleEndian))?.pending.push(event);
      else for (const window of windows.values()) window.pending.push(event);
    }
    const events = this.pending;
    this.pending = [];
    gammaLease?.synchronize();
    return events;
  }

  present(rgba: Uint8Array): void {
    const resources = this.opened();
    if (resources.kind !== "cpu") throw new Error("present requires a CPU window");
    if (rgba.byteLength !== this.width * this.height * 4) throw new Error("RGBA framebuffer size does not match the window");
    checked(sdl().SDL_UpdateTexture(resources.texture, null, rgba, this.width * 4), "SDL_UpdateTexture");
    checked(sdl().SDL_RenderCopy(resources.renderer, resources.texture, null, null), "SDL_RenderCopy");
    sdl().SDL_RenderPresent(resources.renderer);
    this.hasFrame = true;
  }

  readPixels(): Uint8Array {
    const resources = this.opened();
    if (resources.kind !== "cpu") throw new Error("readPixels requires a CPU window");
    if (!this.hasFrame) throw new Error("No framebuffer has been presented");
    const size = this.drawableSize;
    const rgba = new Uint8Array(size.width * size.height * 4);
    // SDL invalidates the backbuffer on present; replay the retained texture first.
    checked(sdl().SDL_RenderCopy(resources.renderer, resources.texture, null, null), "SDL_RenderCopy readback");
    checked(sdl().SDL_RenderReadPixels(resources.renderer, null, rgba32, rgba, size.width * 4), "SDL_RenderReadPixels");
    return rgba;
  }

  makeCurrent(): void {
    const resources = this.opened();
    if (resources.kind !== "gl") throw new Error("makeCurrent requires a GL window");
    checked(sdl().SDL_GL_MakeCurrent(resources.window, resources.context), "SDL_GL_MakeCurrent");
  }

  getGlProcAddress(name: string): Pointer {
    const symbol = cString(name);
    if (name.length === 0) throw new Error("GL procedure name is empty");
    this.makeCurrent();
    return handle(sdl().SDL_GL_GetProcAddress(symbol), `SDL_GL_GetProcAddress ${name}`);
  }

  swap(): void {
    const resources = this.opened();
    this.makeCurrent();
    sdl().SDL_GL_SwapWindow(resources.window);
  }

  pushEvent(event: SdlInjectedEvent): void {
    this.opened();
    const bytes = new Uint8Array(56);
    const view = new DataView(bytes.buffer);
    const u32 = (offset: number, value: number): void => {
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error("SDL event field exceeds uint32");
      view.setUint32(offset, value, littleEndian);
    };
    const i32 = (offset: number, value: number): void => {
      if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new Error("SDL event field exceeds int32");
      view.setInt32(offset, value, littleEndian);
    };
    const byte = (offset: number, value: number): void => {
      if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error("SDL event field exceeds uint8");
      view.setUint8(offset, value);
    };
    u32(4, event.timestamp);
    u32(8, this.id);
    switch (event.kind) {
      case "quit": u32(0, 0x100); break;
      case "key":
        u32(0, event.down ? 0x300 : 0x301);
        byte(12, Number(event.down)); byte(13, Number(event.repeat));
        i32(16, event.scancode); i32(20, event.keycode);
        if (!Number.isInteger(event.modifiers) || event.modifiers < 0 || event.modifiers > 65535) throw new Error("SDL key modifiers exceed uint16");
        view.setUint16(24, event.modifiers, littleEndian);
        break;
      case "mouse-motion":
        u32(0, 0x400); u32(16, event.buttons);
        i32(20, event.x); i32(24, event.y); i32(28, event.dx); i32(32, event.dy);
        break;
      case "mouse-button":
        u32(0, event.down ? 0x401 : 0x402);
        byte(16, event.button); byte(17, Number(event.down)); byte(18, event.clicks);
        i32(20, event.x); i32(24, event.y);
        break;
      case "window":
        u32(0, 0x200); byte(12, event.event); i32(16, event.data1); i32(20, event.data2);
        break;
      default: {
        const exhaustive: never = event;
        throw new Error(`Unsupported SDL event: ${String(exhaustive)}`);
      }
    }
    const result = sdl().SDL_PushEvent(bytes);
    checked(result, "SDL_PushEvent");
    if (result === 0) throw new Error("SDL event was filtered");
  }

  close(): void {
    const resources = this.resources;
    if (resources === null) return;
    const errors: unknown[] = [];
    try { this.gamma?.close(); } catch (error) { errors.push(error); }
    try { this.input?.close(); } catch (error) { errors.push(error); }
    this.resources = null;
    windows.delete(this.id);
    this.pending = [];
    if (resources.kind === "cpu") {
      sdl().SDL_DestroyTexture(resources.texture);
      sdl().SDL_DestroyRenderer(resources.renderer);
    } else sdl().SDL_GL_DeleteContext(resources.context);
    sdl().SDL_DestroyWindow(resources.window);
    if (resources.kind === "gl" && resources.driver !== null) sdl().SDL_GL_UnloadLibrary();
    sdl().SDL_QuitSubSystem(videoSubsystem);
    if (errors.length !== 0) throw new AggregateError(errors, "SDL window cleanup failed");
  }
}

/** SDL replaces /dev/js0..3 selection. Events retain every button edge for IN_JoyMove. */
export class SdlJoystick {
  private static readonly opened = new Set<SdlJoystick>();
  private pending: SdlJoystickEvent[] = [];
  private constructor(private pointer: Pointer | null, readonly instance: number,
    readonly name: string, readonly axes: number, readonly buttons: number) {
    SdlJoystick.opened.add(this);
  }

  /** Joystick records belong to device owners, independently of SDL window event consumers. */
  static queueEvent(event: SdlEvent): boolean {
    if (event.kind !== "joystick-axis" && event.kind !== "joystick-button" && event.kind !== "joystick-removed") return false;
    for (const joystick of SdlJoystick.opened) if (joystick.instance === event.instance) joystick.pending.push(event);
    return true;
  }

  static openFirst(print: (text: string) => undefined): SdlJoystick | null {
    const api = sdl(), subsystem = 0x200;
    initializeSubsystem(subsystem, "SDL_InitSubSystem joystick");
    let pointer: Pointer | null = null;
    try {
      const count = api.SDL_NumJoysticks();
      checked(count, "SDL_NumJoysticks");
      for (let index = 0; index < Math.min(4, count); index++) {
        pointer = api.SDL_JoystickOpen(index);
        if (pointer !== null) break;
        print(`SDL_JoystickOpen ${index}: ${api.SDL_GetError()}\n`);
      }
      if (pointer === null) { api.SDL_QuitSubSystem(subsystem); return null; }
      const instance = api.SDL_JoystickInstanceID(pointer), axes = api.SDL_JoystickNumAxes(pointer);
      const buttons = api.SDL_JoystickNumButtons(pointer), hats = api.SDL_JoystickNumHats(pointer), balls = api.SDL_JoystickNumBalls(pointer);
      for (const value of [instance, axes, buttons, hats, balls]) checked(value, "SDL joystick description");
      if (hats !== 0 || balls !== 0) print(`SDL joystick has ${hats} hats and ${balls} balls; this Unix axis/button profile does not map them.\n`);
      if (axes > 8 || buttons > 32) print("SDL joystick inputs beyond 8 mapped axes and 32 buttons are ignored.\n");
      return new SdlJoystick(pointer, instance, String(api.SDL_JoystickName(pointer)), axes, buttons);
    } catch (error) {
      if (pointer !== null) api.SDL_JoystickClose(pointer);
      api.SDL_QuitSubSystem(subsystem);
      throw error;
    }
  }

  /** Pumps only joystick devices and removes only their event range, including before video init. */
  pollEvents(): readonly SdlJoystickEvent[] {
    if (this.pointer === null) throw new Error("SDL joystick is closed");
    const api = sdl(), bytes = new Uint8Array(56);
    api.SDL_JoystickUpdate();
    for (;;) {
      const count = api.SDL_PeepEvents(bytes, 1, 2, 0x600, 0x606);
      checked(count, "SDL_PeepEvents joystick");
      if (count === 0) break;
      SdlJoystick.queueEvent(decodeEvent(bytes));
    }
    const events = this.pending;
    this.pending = [];
    return events;
  }

  close(): void {
    const pointer = this.pointer;
    if (pointer === null) return;
    this.pointer = null;
    SdlJoystick.opened.delete(this);
    this.pending = [];
    sdl().SDL_JoystickClose(pointer);
    sdl().SDL_QuitSubSystem(0x200);
  }
}
