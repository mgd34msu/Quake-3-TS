// Ported from id Software's macosx/macosx_glimp.m and GenerateQGL.pl.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CommonError } from "../core/common-error.ts";
import type { GlCalls } from "./gl/logging.ts";

/** GL_APPLE_transform_hint adds a target to the standard glHint entrypoint. */
export function applyAppleTransformHint(options: {
  readonly extensions: string;
  readonly enabled: () => boolean;
  readonly print: (text: string) => undefined;
  readonly gl: Pick<GlCalls, "glHint" | "glGetError">;
}): void {
  if (!options.extensions.includes("GL_APPLE_transform_hint")) {
    options.print("...GL_APPLE_transform_hint not found\n");
    return;
  }
  if (!options.enabled()) {
    options.print("...ignoring using GL_APPLE_transform_hint\n");
    return;
  }
  options.print("...using GL_APPLE_transform_hint\n");
  // Khronos APPLE_transform_hint target 0x85B1; GL_FASTEST is 0x1101.
  options.gl.glHint(0x85b1, 0x1101);
  const error = options.gl.glGetError();
  // Original CheckErrors formats glGetString(error), an invalid string query.
  if (error !== 0) throw new CommonError("fatal", `glGetError: 0x${error.toString(16)}\n`);
}

export interface GlCallErrorOptions {
  readonly enabled: () => boolean;
  readonly print: (text: string) => undefined;
  readonly writeDiagnostic: (text: string) => undefined;
}

function errorDescription(error: number): string {
  switch (error) {
    case 0x0500: return "invalid enumerant";
    case 0x0501: return "invalid value";
    case 0x0502: return "invalid operation";
    case 0x0503: return "stack overflow";
    case 0x0504: return "stack underflow";
    case 0x0505: return "out of memory";
    case 0x0506: return "invalid framebuffer operation";
    case 0x8031: return "table too large";
    default: return "unknown error";
  }
}

/** Retained Mac QGL error count and unsigned Begin/End nesting. */
export class GlCallErrorDiagnostics {
  private beginDepth = 0;
  private errorCount = 0;

  constructor(private readonly options: GlCallErrorOptions) {}

  check(name: string, getError: () => number): void {
    if (!this.options.enabled()) return;
    this.report(name, getError());
  }

  report(name: string, error: number): void {
    if (error === 0) return;
    if (this.errorCount === 100) {
      this.options.print("100 GL errors printed ... disabling further error reporting.\n");
    } else if (this.errorCount < 100) {
      if (this.errorCount === 0) this.options.writeDiagnostic("BREAK ON QGLErrorBreak to stop at the GL errors\n");
      this.options.writeDiagnostic(`OpenGL Error(${name}): 0x${error.toString(16).padStart(4, "0")} -- ${errorDescription(error)}\n`);
    }
    this.errorCount = (this.errorCount + 1) >>> 0;
  }

  wrap<Arguments extends unknown[], Result>(name: string, call: (...args: Arguments) => Result,
    getError: () => number): (...args: Arguments) => Result {
    return (...args: Arguments): Result => {
      const result = call(...args);
      if (name === "glBegin") this.beginDepth = (this.beginDepth + 1) >>> 0;
      else if (name === "glEnd") this.beginDepth = (this.beginDepth - 1) >>> 0;
      if (this.beginDepth === 0) this.check(name, getError);
      return result;
    };
  }
}
