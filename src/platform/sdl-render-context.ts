// SPDX-License-Identifier: GPL-2.0-or-later
// SDL replacement for code/unix/linux_glimp.c GLimp_* SMP context handoff.
// Copyright (C) 1999-2005 Id Software, Inc.
import { dlopen, ptr } from "bun:ffi";
import type { Pointer } from "bun:ffi";
import { isMainThread } from "node:worker_threads";

export interface SdlRenderContext {
  readonly drawableSize: { readonly width: number; readonly height: number };
  readonly renderingEnabled: boolean;
  setRenderingEnabled(enabled: boolean): void;
  makeCurrent(): void;
  getGlProcAddress(name: string): Pointer;
  swap(): void;
}

/** Same-process worker token. Native pointers stay in SDL's window data. */
export interface SdlRenderContextTransfer {
  readonly windowId: number;
  readonly key: string;
  readonly ownership: SharedArrayBuffer;
}

function loadSdlRenderContext() {
  return dlopen(process.env["QUAKE_SDL2_LIBRARY"] ?? "libSDL2-2.0.so.0", {
    SDL_GetError: { args: [], returns: "cstring" },
    SDL_GetWindowFromID: { args: ["u32"], returns: "ptr" },
    SDL_SetWindowData: { args: ["ptr", "buffer", "ptr"], returns: "ptr" },
    SDL_GetWindowData: { args: ["ptr", "buffer"], returns: "ptr" },
    SDL_GL_MakeCurrent: { args: ["ptr", "ptr"], returns: "i32" },
    SDL_GL_GetCurrentContext: { args: [], returns: "ptr" },
    SDL_GL_GetDrawableSize: { args: ["ptr", "buffer", "buffer"], returns: "void" },
    SDL_GL_GetProcAddress: { args: ["buffer"], returns: "ptr" },
    SDL_GL_SwapWindow: { args: ["ptr"], returns: "void" },
  });
}
let library: ReturnType<typeof loadSdlRenderContext> | null = null;
function sdl() { library ??= loadSdlRenderContext(); return library.symbols; }
function checked(result: number, operation: string): void {
  if (result < 0) throw new Error(`${operation}: ${sdl().SDL_GetError()}`);
}
function pointer(value: Pointer | null, operation: string): Pointer {
  if (value === null) throw new Error(`${operation}: ${sdl().SDL_GetError()}`);
  return value;
}
function cString(value: string): Buffer { return Buffer.from(`${value}\0`); }

const offered = 0, adopted = 1, released = 2, restoring = 3, restored = 4;

/** The window owner keeps this lease until cancellation or worker release. */
export class SdlRenderContextLease {
  private constructor(private readonly window: Pointer, private readonly context: Pointer,
    readonly transfer: SdlRenderContextTransfer, private readonly state: Int32Array) {}

  static detach(window: Pointer, context: Pointer, windowId: number): SdlRenderContextLease {
    if (!isMainThread) throw new Error("SDL window lifetime belongs to the main thread");
    const api = sdl();
    if (api.SDL_GL_GetCurrentContext() !== context) throw new Error("SDL context must be current before detach");
    const transfer = { windowId, key: `quake3-render-${crypto.randomUUID()}`, ownership: new SharedArrayBuffer(4) };
    const state = new Int32Array(transfer.ownership), key = cString(transfer.key), ownerKey = cString(`${transfer.key}-owner`);
    api.SDL_SetWindowData(window, key, context);
    api.SDL_SetWindowData(window, ownerKey, ptr(transfer.ownership));
    try {
      if (api.SDL_GetWindowData(window, key) !== context || api.SDL_GetWindowData(window, ownerKey) !== ptr(transfer.ownership))
        throw new Error("SDL context transfer registration failed");
      checked(api.SDL_GL_MakeCurrent(window, null), "SDL_GL_MakeCurrent detach");
      Atomics.store(state, 0, offered);
      return new SdlRenderContextLease(window, context, transfer, state);
    } catch (error) {
      api.SDL_SetWindowData(window, key, null); api.SDL_SetWindowData(window, ownerKey, null);
      throw error;
    }
  }

  /** Cancels an unadopted token, or restores after the worker cleared current. */
  restore(): void {
    if (!isMainThread) throw new Error("SDL context restoration belongs to the main thread");
    const current = Atomics.load(this.state, 0);
    if (current === restored) return;
    if ((current !== offered && current !== released) || Atomics.compareExchange(this.state, 0, current, restoring) !== current)
      throw new Error("SDL render context is still owned by the worker");
    try {
      checked(sdl().SDL_GL_MakeCurrent(this.window, this.context), "SDL_GL_MakeCurrent restore");
    } catch (error) {
      Atomics.store(this.state, 0, released);
      throw error;
    }
    sdl().SDL_SetWindowData(this.window, cString(this.transfer.key), null);
    sdl().SDL_SetWindowData(this.window, cString(`${this.transfer.key}-owner`), null);
    Atomics.store(this.state, 0, restored);
  }
}

function parseTransfer(value: unknown): SdlRenderContextTransfer {
  if (typeof value !== "object" || value === null || !("windowId" in value) || !("key" in value) || !("ownership" in value)
    || typeof value.windowId !== "number" || !Number.isInteger(value.windowId) || value.windowId <= 0 || value.windowId > 0xffffffff
    || typeof value.key !== "string" || !/^quake3-render-[0-9a-f-]{36}$/.test(value.key)
    || !(value.ownership instanceof SharedArrayBuffer) || value.ownership.byteLength !== 4)
    throw new Error("Invalid SDL render context transfer");
  return { windowId: value.windowId, key: value.key, ownership: value.ownership };
}

/** Borrows the main thread's existing window and context, never SDL video lifetime. */
export class SdlWorkerRenderContext implements SdlRenderContext {
  private closed = false;
  private renderEnabled = true;
  private constructor(private readonly window: Pointer, private readonly context: Pointer, private readonly state: Int32Array) {}

  static adopt(value: unknown): SdlWorkerRenderContext {
    const transfer = parseTransfer(value);
    if (isMainThread) throw new Error("SDL render context adoption requires a worker thread");
    const state = new Int32Array(transfer.ownership);
    if (Atomics.compareExchange(state, 0, offered, adopted) !== offered)
      throw new Error("SDL render context transfer was already consumed");
    try {
      const api = sdl();
      if (api.SDL_GL_GetCurrentContext() !== null) throw new Error("Worker already has a current SDL context");
      const window = pointer(api.SDL_GetWindowFromID(transfer.windowId), "SDL_GetWindowFromID");
      if (api.SDL_GetWindowData(window, cString(`${transfer.key}-owner`)) !== ptr(transfer.ownership))
        throw new Error("SDL render context ownership does not match the registered transfer");
      const context = pointer(api.SDL_GetWindowData(window, cString(transfer.key)), "SDL_GetWindowData context");
      checked(api.SDL_GL_MakeCurrent(window, context), "SDL_GL_MakeCurrent adopt");
      return new SdlWorkerRenderContext(window, context, state);
    } catch (error) {
      Atomics.store(state, 0, released);
      throw error;
    }
  }

  makeCurrent(): void {
    if (this.closed || Atomics.load(this.state, 0) !== adopted) throw new Error("SDL worker render context is released");
    checked(sdl().SDL_GL_MakeCurrent(this.window, this.renderEnabled ? this.context : null), "SDL_GL_MakeCurrent worker");
  }

  get renderingEnabled(): boolean { return this.renderEnabled; }

  setRenderingEnabled(enabled: boolean): void {
    if (this.closed || Atomics.load(this.state, 0) !== adopted) throw new Error("SDL worker render context is released");
    checked(sdl().SDL_GL_MakeCurrent(this.window, enabled ? this.context : null), "SDL_GL_MakeCurrent worker diagnostic");
    this.renderEnabled = enabled;
  }

  get drawableSize(): { readonly width: number; readonly height: number } {
    this.makeCurrent();
    const width = new Int32Array(1), height = new Int32Array(1);
    sdl().SDL_GL_GetDrawableSize(this.window, width, height);
    const w = width[0], h = height[0];
    if (w === undefined || h === undefined || w <= 0 || h <= 0) throw new Error("SDL returned invalid drawable dimensions");
    return { width: w, height: h };
  }

  getGlProcAddress(name: string): Pointer {
    if (name.length === 0 || name.includes("\0")) throw new Error("Invalid GL procedure name");
    this.makeCurrent();
    return pointer(sdl().SDL_GL_GetProcAddress(cString(name)), `SDL_GL_GetProcAddress ${name}`);
  }

  swap(): void {
    this.makeCurrent();
    // SDL requires a current window to swap; Mac flushBuffer did not.
    if (!this.renderEnabled) checked(sdl().SDL_GL_MakeCurrent(this.window, this.context), "SDL_GL_MakeCurrent worker swap");
    sdl().SDL_GL_SwapWindow(this.window);
    if (!this.renderEnabled) checked(sdl().SDL_GL_MakeCurrent(this.window, null), "SDL_GL_MakeCurrent worker restore diagnostic");
  }

  release(): void {
    if (this.closed) return;
    checked(sdl().SDL_GL_MakeCurrent(this.window, null), "SDL_GL_MakeCurrent worker release");
    this.closed = true;
    Atomics.store(this.state, 0, released);
    Atomics.notify(this.state, 0);
  }
}
