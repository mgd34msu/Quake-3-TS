// Ported from id Software's code/unix/linux_qgl.c and linux_glimp.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CvarFlag } from "../../core/cvar.ts";
import type { CvarRegistry } from "../../core/cvar.ts";
import { float32ToBits } from "../../core/numeric.ts";
import type { WritableLog } from "../../assets/writable-files.ts";
import type { loadGl } from "../../platform/gl.ts";
import type { SourceCalendarTime } from "../../platform/system-clock.ts";

export interface GlCallLoggingOptions {
  readonly cvars: CvarRegistry;
  readonly openLog: (basePath: string) => WritableLog | null;
  readonly localCalendar: () => SourceCalendarTime;
  readonly print: (text: string) => undefined;
}

type LogState = { readonly kind: "unopened" } | { readonly kind: "closed" }
  | { readonly kind: "open"; readonly file: WritableLog; enabled: boolean };

function header(calendar: SourceCalendarTime): string {
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][calendar.weekday];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][calendar.month];
  if (weekday === undefined || month === undefined) throw new RangeError("GL log header requires a valid local calendar");
  const time = [calendar.hour, calendar.minute, calendar.second].map(value => String(value).padStart(2, "0")).join(":");
  return `${weekday} ${month} ${String(calendar.day).padStart(2, " ")} ${time} ${calendar.year + 1900}\n\n`;
}

/** Linux keeps FILE open when logging disables; GLimp_LogComment still uses it. */
export class GlCallLogging {
  private state: LogState = { kind: "unopened" };
  private callsLogged = false;

  constructor(private readonly options: GlCallLoggingOptions) {}

  get enabled(): boolean { return this.callsLogged; }

  /** QGL_Init restores direct entry points without clearing the retained FILE or countdown. */
  resetCalls(): void { this.callsLogged = false; }

  private requestedFrames(): number {
    const value = this.options.cvars.get("r_logFile");
    if (value === undefined) throw new Error("GL logging requires registered r_logFile");
    return value.integerValue;
  }

  /** GLimp_EndFrame reaches QGL_EnableLogging after the conditional swap. */
  endFrame(): void {
    const state = this.state;
    if (state.kind === "closed") throw new Error("GL logging owner is closed");
    let enable = this.requestedFrames() !== 0;
    if (state.kind === "open" && state.enabled && enable) {
      const frames = this.requestedFrames();
      if (frames === -2147483648) throw new RangeError("QGL_EnableLogging: source countdown subtraction would overflow");
      this.options.cvars.set("r_logFile", String(frames - 1), true);
      if (this.requestedFrames() !== 0) return;
      enable = false;
    }
    if (state.kind === "open") { state.enabled = enable; this.callsLogged = enable; return; }
    if (!enable) return;
    const calendar = this.options.localCalendar();
    const basePath = this.options.cvars.register("fs_basepath", "", CvarFlag.None).value;
    const path = `${basePath}/gl.log`;
    // A truncated Com_sprintf destination could name a different file.
    if (path.length >= 1024) throw new RangeError("GL log path exceeds the source 1024-byte path buffer");
    const file = this.options.openLog(basePath);
    if (file === null) throw new Error(`QGL_EnableLogging: cannot open ${path}`);
    const opened: LogState = { kind: "open", file, enabled: true };
    this.state = opened;
    this.options.print(`QGL_EnableLogging(${this.requestedFrames()}): writing ${path}\n`);
    if (this.state !== opened) throw new Error("GL logging owner changed while opening its file");
    file.write(header(calendar));
    this.callsLogged = true;
  }

  call(text: string): void { if (this.enabled) this.comment(text); }

  comment(text: string): void {
    if (this.state.kind !== "open") return;
    const end = text.indexOf("\0");
    this.state.file.write(end < 0 ? text : text.slice(0, end));
  }

  /** Final owner disposal closes the retained FILE; Linux adds no closing marker. */
  close(): void {
    const state = this.state;
    if (state.kind === "closed") return;
    this.state = { kind: "closed" };
    this.callsLogged = false;
    if (state.kind === "open") state.file.close();
  }
}

type NativeGlCalls = ReturnType<typeof loadGl>["symbols"];
/** Ordinary calls deliberately omit Bun's native-function identity brand. */
export type GlCalls = {
  [Name in keyof NativeGlCalls]: NativeGlCalls[Name] extends (...args: infer Arguments) => infer Result
    ? (...args: Arguments) => Result : never;
};

function hex(value: number): string { return (value >>> 0).toString(16); }

/** A GLfloat reaches printf after binary32 conversion; %f uses ties to even. */
function decimal(value: number): string {
  const bits = float32ToBits(value), exponent = (bits >>> 23) & 255, fraction = bits & 0x7fffff;
  const sign = bits >>> 31 === 0 ? "" : "-";
  if (exponent === 255) return `${sign}${fraction === 0 ? "inf" : "nan"}`;
  const significand = BigInt(exponent === 0 ? fraction : fraction + 0x800000);
  const shift = exponent === 0 ? -149 : exponent - 150, scaled = significand * 1000000n;
  let rounded: bigint;
  if (shift >= 0) rounded = scaled << BigInt(shift);
  else {
    const divisor = 1n << BigInt(-shift), lower = scaled / divisor, remainder = scaled % divisor;
    rounded = remainder * 2n > divisor || remainder * 2n === divisor && lower % 2n !== 0n ? lower + 1n : lower;
  }
  return `${sign}${rounded / 1000000n}.${String(rounded % 1000000n).padStart(6, "0")}`;
}

/** Each wrapper forwards its exact typed arguments to the actual loaded symbol. */
export function createLoggedGlCalls(gl: NativeGlCalls, log: GlCallLogging | null): GlCalls {
  if (log === null) return gl;
  return {
    glCallList(list) { if (log.enabled) log.comment(`glCallList( ${list >>> 0} )\n`); return gl.glCallList(list); },
    glNewList(list, mode) { log.call("glNewList\n"); return gl.glNewList(list, mode); },
    glEndList() { log.call("glEndList\n"); return gl.glEndList(); },
    glDeleteLists(list, range) { log.call("glDeleteLists\n"); return gl.glDeleteLists(list, range); },
    glGetString(name) { log.call("glGetString\n"); return gl.glGetString(name); },
    glGetError() { log.call("glGetError\n"); return gl.glGetError(); },
    glIsEnabled(cap) { log.call("glIsEnabled\n"); return gl.glIsEnabled(cap); },
    glGetIntegerv(name, values) { log.call("glGetIntegerv\n"); return gl.glGetIntegerv(name, values); },
    glGetFloatv(name, values) { log.call("glGetFloatv\n"); return gl.glGetFloatv(name, values); },
    glGetTexParameterfv(target, name, values) { log.call("glGetTexParameterfv\n"); return gl.glGetTexParameterfv(target, name, values); },
    glGetTexLevelParameteriv(target, level, name, values) { log.call("glGetTexLevelParameteriv\n"); return gl.glGetTexLevelParameteriv(target, level, name, values); },
    glGetTexImage(target, level, format, type, pixels) { log.call("glGetTexImage\n"); return gl.glGetTexImage(target, level, format, type, pixels); },
    // The Unix QGL_EnableLogging table leaves ARB extension entry points direct.
    glActiveTexture: gl.glActiveTexture,
    glClientActiveTexture: gl.glClientActiveTexture,
    glDrawBuffer(mode) { log.call("glDrawBuffer\n"); return gl.glDrawBuffer(mode); },
    glViewport(x, y, width, height) { log.call("glViewport\n"); return gl.glViewport(x, y, width, height); },
    glScissor(x, y, width, height) { log.call("glScissor\n"); return gl.glScissor(x, y, width, height); },
    glClearColor(red, green, blue, alpha) { log.call("glClearColor\n"); return gl.glClearColor(red, green, blue, alpha); },
    glClearDepth(depth) { log.call("glClearDepth\n"); return gl.glClearDepth(depth); },
    glClearStencil(value) { log.call("glClearStencil\n"); return gl.glClearStencil(value); },
    glClear(mask) { log.call("glClear\n"); return gl.glClear(mask); },
    glEnable(cap) { if (log.enabled) log.comment(`glEnable( 0x${hex(cap)} )\n`); return gl.glEnable(cap); },
    glDisable(cap) { if (log.enabled) log.comment(`glDisable( 0x${hex(cap)} )\n`); return gl.glDisable(cap); },
    glClipPlane(plane, equation) { log.call("glClipPlane\n"); return gl.glClipPlane(plane, equation); },
    glDepthFunc(func) { log.call("glDepthFunc\n"); return gl.glDepthFunc(func); },
    glDepthMask(flag) { log.call("glDepthMask\n"); return gl.glDepthMask(flag); },
    glColorMask(red, green, blue, alpha) { log.call("glColorMask\n"); return gl.glColorMask(red, green, blue, alpha); },
    glStencilFunc(func, reference, mask) { log.call("glStencilFunc\n"); return gl.glStencilFunc(func, reference, mask); },
    glStencilOp(fail, depthFail, depthPass) { log.call("glStencilOp\n"); return gl.glStencilOp(fail, depthFail, depthPass); },
    glStencilMask(mask) { log.call("glStencilMask\n"); return gl.glStencilMask(mask); },
    glDepthRange(near, far) { log.call("glDepthRange\n"); return gl.glDepthRange(near, far); },
    glPolygonMode(face, mode) {
      if (log.enabled) log.comment(`glPolygonMode( 0x${hex(face)}, 0x${hex(mode)} )\n`);
      return gl.glPolygonMode(face, mode);
    },
    glShadeModel(mode) { log.call("glShadeModel\n"); return gl.glShadeModel(mode); },
    glPolygonOffset(factor, units) { log.call("glPolygonOffset\n"); return gl.glPolygonOffset(factor, units); },
    glLineWidth(width) { log.call("glLineWidth\n"); return gl.glLineWidth(width); },
    glBlendFunc(source, destination) {
      if (log.enabled) log.comment(`glBlendFunc( 0x${hex(source)}, 0x${hex(destination)} )\n`);
      return gl.glBlendFunc(source, destination);
    },
    glAlphaFunc(func, reference) {
      if (log.enabled) log.comment(`glAlphaFunc( 0x${hex(func)}, ${decimal(reference)} )\n`);
      return gl.glAlphaFunc(func, reference);
    },
    glCullFace(mode) { log.call("glCullFace\n"); return gl.glCullFace(mode); },
    glFrontFace(mode) { log.call("glFrontFace\n"); return gl.glFrontFace(mode); },
    glMatrixMode(mode) { log.call("glMatrixMode\n"); return gl.glMatrixMode(mode); },
    glLoadIdentity() { log.call("glLoadIdentity\n"); return gl.glLoadIdentity(); },
    glOrtho(left, right, bottom, top, near, far) { log.call("glOrtho\n"); return gl.glOrtho(left, right, bottom, top, near, far); },
    glBegin(mode) { if (log.enabled) log.comment(`glBegin( 0x${hex(mode)} )\n`); return gl.glBegin(mode); },
    glEnd() { log.call("glEnd\n"); return gl.glEnd(); },
    glColor3f(red, green, blue) { log.call("glColor3f\n"); return gl.glColor3f(red, green, blue); },
    glColor4f(red, green, blue, alpha) {
      if (log.enabled) log.comment(`glColor4f( ${decimal(red)},${decimal(green)},${decimal(blue)},${decimal(alpha)} )\n`);
      return gl.glColor4f(red, green, blue, alpha);
    },
    glColor4b(red, green, blue, alpha) { log.call("glColor4b\n"); return gl.glColor4b(red, green, blue, alpha); },
    glColor4ub(red, green, blue, alpha) {
      if (!log.enabled) return gl.glColor4ub(red, green, blue, alpha);
      // linux_qgl.c:logColor4ub calls the signed entry point, including its label.
      log.comment("glColor4b\n");
      return gl.glColor4b(red << 24 >> 24, green << 24 >> 24, blue << 24 >> 24, alpha << 24 >> 24);
    },
    glTexCoord2f(s, t) { log.call("glTexCoord2f\n"); return gl.glTexCoord2f(s, t); },
    glVertex2f(x, y) { log.call("glVertex2f\n"); return gl.glVertex2f(x, y); },
    glVertex4f(x, y, z, w) { log.call("glVertex4f\n"); return gl.glVertex4f(x, y, z, w); },
    glEnableClientState(array) { log.call("glEnableClientState\n"); return gl.glEnableClientState(array); },
    glDisableClientState(array) { log.call("glDisableClientState\n"); return gl.glDisableClientState(array); },
    glVertexPointer(size, type, stride, pointer) { log.call("glVertexPointer\n"); return gl.glVertexPointer(size, type, stride, pointer); },
    glColorPointer(size, type, stride, pointer) { log.call("glColorPointer\n"); return gl.glColorPointer(size, type, stride, pointer); },
    glTexCoordPointer(size, type, stride, pointer) { log.call("glTexCoordPointer\n"); return gl.glTexCoordPointer(size, type, stride, pointer); },
    glDrawElements(mode, count, type, indices) { log.call("glDrawElements\n"); return gl.glDrawElements(mode, count, type, indices); },
    glArrayElement(index) { log.call("glArrayElement\n"); return gl.glArrayElement(index); },
    glGenTextures(count, textures) { log.call("glGenTextures\n"); return gl.glGenTextures(count, textures); },
    glDeleteTextures(count, textures) { log.call("glDeleteTextures\n"); return gl.glDeleteTextures(count, textures); },
    glBindTexture(target, texture) {
      if (log.enabled) log.comment(`glBindTexture( 0x${hex(target)}, ${texture >>> 0} )\n`);
      return gl.glBindTexture(target, texture);
    },
    glTexParameteri(target, name, parameter) {
      if (log.enabled) log.comment(`glTexParameteri( 0x${hex(target)}, 0x${hex(name)}, 0x${hex(parameter)} )\n`);
      return gl.glTexParameteri(target, name, parameter);
    },
    glTexParameterfv(target, name, parameters) { log.call("glTexParameterfv\n"); return gl.glTexParameterfv(target, name, parameters); },
    glTexEnvi(target, name, parameter) {
      if (log.enabled) log.comment(`glTexEnvi( 0x${hex(target)}, 0x${hex(name)}, 0x${hex(parameter)} )\n`);
      return gl.glTexEnvi(target, name, parameter);
    },
    glTexEnvf(target, name, parameter) {
      if (log.enabled) log.comment(`glTexEnvf( 0x${hex(target)}, 0x${hex(name)}, ${decimal(parameter)} )\n`);
      return gl.glTexEnvf(target, name, parameter);
    },
    glTexImage2D(target, level, format, width, height, border, pixelFormat, type, pixels) {
      log.call("glTexImage2D\n"); return gl.glTexImage2D(target, level, format, width, height, border, pixelFormat, type, pixels);
    },
    glTexSubImage2D(target, level, x, y, width, height, format, type, pixels) {
      log.call("glTexSubImage2D\n"); return gl.glTexSubImage2D(target, level, x, y, width, height, format, type, pixels);
    },
    glFinish() { log.call("glFinish\n"); return gl.glFinish(); },
    glPixelStorei(name, parameter) { log.call("glPixelStorei\n"); return gl.glPixelStorei(name, parameter); },
    glReadPixels(x, y, width, height, format, type, pixels) {
      log.call("glReadPixels\n"); return gl.glReadPixels(x, y, width, height, format, type, pixels);
    },
  };
}
