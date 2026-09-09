import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import type { CvarSnapshot } from "../src/core/cvar.ts";
import { SourceRendererSettings, RegisteredRendererCvars, rendererVideoMode, printRendererVideoModes } from "../src/render/settings.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { imageColorLighting } from "../src/render/image-upload.ts";
import { WritableFileSystem } from "../src/assets/writable-files.ts";
import { GlCallLogging } from "../src/render/gl/logging.ts";

type ExpectedRegistration = readonly [name: string, defaultValue: string, flags: number];

describe("Unix GL call logging", () => {
  test("uses the live cheat integer and retains the base-root file across countdown, disable and QGL reload", () => {
    const root = mkdtempSync(join(tmpdir(), "quake3-logfile-"));
    const base = join(root, "data"), home = join(root, "home");
    mkdirSync(base);
    const cvars = new CvarRegistry();
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    cvars.register("fs_basepath", base);
    const output: string[] = [], files = new WritableFileSystem({ homePath: home, product: "missionpack", print: () => {} });
    let clocks = 0;
    const logging = new GlCallLogging({ cvars, openLog: path => files.openGlLog(path), print: text => { output.push(text); },
      localCalendar: () => { clocks++; return { year: 126, month: 8, day: 9, hour: 1, minute: 2, second: 3, weekday: 3, yearDay: 251, isDst: 1 }; } });
    try {
      expect(cvars.get("r_logFile")).toMatchObject({ value: "0", resetValue: "0", flags: CvarFlag.Cheat });
      expect(settings.runtime.logFile).toBe(0);
      logging.endFrame(); logging.call("disabled call\n"); logging.comment("unopened comment\n");
      expect(existsSync(join(base, "gl.log"))).toBe(false);
      expect(clocks).toBe(0);
      cvars.set("r_logFile", "3.75", true);
      expect(settings.runtime.logFile).toBe(3);
      logging.endFrame();
      expect(cvars.get("r_logFile")?.value).toBe("3.75");
      logging.call("glFinish\n"); logging.endFrame();
      expect(settings.runtime.logFile).toBe(2);
      logging.resetCalls();
      logging.call("direct after QGL_Init\n"); logging.endFrame();
      expect(settings.runtime.logFile).toBe(1); expect(logging.enabled).toBe(false);
      logging.endFrame();
      expect(settings.runtime.logFile).toBe(0);
      logging.comment("retained comment\n");
      cvars.set("r_logFile", "1", true); logging.endFrame();
      expect(logging.enabled).toBe(true);
      logging.call("glGetError\n"); logging.endFrame();
      logging.call("disabled final call\n"); files.closeAll(); logging.comment("tail after FS_Shutdown\0discarded");
      logging.close(); logging.close();
      expect(readFileSync(join(base, "gl.log"), "latin1")).toBe("Wed Sep  9 01:02:03 2026\n\nglFinish\nretained comment\nglGetError\ntail after FS_Shutdown");
      expect(existsSync(home)).toBe(false);
      expect(clocks).toBe(1);
      expect(output).toEqual([`QGL_EnableLogging(3): writing ${base}/gl.log\n`]);
      expect(() => logging.endFrame()).toThrow("closed");
    } finally { logging.close(); files.closeAll(); rmSync(root, { recursive: true, force: true }); }
  });

  test("negative counts keep decrementing and reject the source signed-overflow boundary", () => {
    const cvars = new CvarRegistry();
    new RegisteredRendererCvars(cvars, "linux");
    const writes: string[] = [];
    const logging = new GlCallLogging({ cvars, print: () => {},
      openLog: () => ({ write: text => { writes.push(text); }, close: () => {} }),
      localCalendar: () => ({ year: 126, month: 8, day: 9, hour: 1, minute: 2, second: 3, weekday: 3, yearDay: 251, isDst: 1 }) });
    try {
      cvars.set("r_logFile", "-1", true); logging.endFrame(); logging.endFrame();
      expect(cvars.get("r_logFile")?.value).toBe("-2"); expect(logging.enabled).toBe(true);
      cvars.set("r_logFile", "-2147483648", true);
      expect(() => logging.endFrame()).toThrow("overflow");
      expect(cvars.get("r_logFile")?.value).toBe("-2147483648");
      cvars.set("r_logFile", "0", true); logging.endFrame();
      expect(logging.enabled).toBe(false); expect(writes).toHaveLength(1);
    } finally { logging.close(); }
  });

  test("base-root GL log acquisition refuses a symbolic-link target without changing the linked file", () => {
    const root = mkdtempSync(join(tmpdir(), "quake3-logfile-containment-"));
    const base = join(root, "data"), untouched = join(root, "untouched.log");
    mkdirSync(base); writeFileSync(untouched, "preserve these bytes"); symlinkSync(untouched, join(base, "gl.log"));
    const files = new WritableFileSystem({ homePath: join(root, "home"), product: "baseq3", print: () => {} });
    try {
      expect(() => files.openGlLog(base)).toThrow("symbolic link");
      expect(readFileSync(untouched, "utf8")).toBe("preserve these bytes");
    } finally { files.closeAll(); rmSync(root, { recursive: true, force: true }); }
  });
});

describe("source video modes", () => {
  test("prints the exact source mode list in fourteen synchronous chunks", () => {
    const chunks: string[] = [];
    expect(printRendererVideoModes(text => { chunks.push(text); })).toBeUndefined();
    expect(chunks).toEqual([
      "\n",
      "Mode  0: 320x240\n",
      "Mode  1: 400x300\n",
      "Mode  2: 512x384\n",
      "Mode  3: 640x480\n",
      "Mode  4: 800x600\n",
      "Mode  5: 960x720\n",
      "Mode  6: 1024x768\n",
      "Mode  7: 1152x864\n",
      "Mode  8: 1280x1024\n",
      "Mode  9: 1600x1200\n",
      "Mode 10: 2048x1536\n",
      "Mode 11: 856x480 (wide)\n",
      "\n",
    ]);
  });

  test("a print callback exception immediately stops the mode list", () => {
    const chunks: string[] = [];
    const failure = new Error("print stopped");
    expect(() => printRendererVideoModes(text => {
      chunks.push(text);
      if (chunks.length === 3) throw failure;
    })).toThrow(failure);
    expect(chunks).toEqual(["\n", "Mode  0: 320x240\n", "Mode  1: 400x300\n"]);
  });

  test("registers source defaults and preserves a matching initial host profile", () => {
    const cvars = new CvarRegistry();
    new RegisteredRendererCvars(cvars, "linux", { width: 320, height: 240 });
    expect(cvars.get("r_mode")).toMatchObject({ value: "0", resetValue: "3", flags: 33 });
    expect(cvars.get("r_fullscreen")).toMatchObject({ value: "0", resetValue: "1", flags: 33 });
    expect(cvars.get("r_customwidth")).toMatchObject({ value: "1600", resetValue: "1600", flags: 33 });
    expect(cvars.get("r_customheight")).toMatchObject({ value: "1024", resetValue: "1024", flags: 33 });
    expect(cvars.get("r_customaspect")).toMatchObject({ value: "1", resetValue: "1", flags: 33 });
    const dimensions = [[320, 240], [400, 300], [512, 384], [640, 480], [800, 600], [960, 720],
      [1024, 768], [1152, 864], [1280, 1024], [1600, 1200], [2048, 1536], [856, 480]];
    for (const [index, pair] of dimensions.entries()) {
      const width = pair[0], height = pair[1];
      if (width === undefined || height === undefined) throw new Error("Missing source mode fixture");
      expect(rendererVideoMode(cvars, index)).toEqual({ width, height, windowAspect: Math.fround(width / height) });
    }
    for (const invalid of [-2, 12, 1.5, NaN]) expect(rendererVideoMode(cvars, invalid)).toBeNull();
  });

  test("custom startup cvars win and consume integer and binary32 source fields", () => {
    const cvars = new CvarRegistry();
    for (const [name, value] of [["r_mode", "-1.8"], ["r_fullscreen", "-2"], ["r_customwidth", "411.9"],
      ["r_customheight", "267px"], ["r_customaspect", "1.17"]] satisfies readonly (readonly [string, string])[]) cvars.set(name, value);
    new RegisteredRendererCvars(cvars, "linux", { width: 320, height: 240 });
    expect(cvars.get("r_mode")).toMatchObject({ value: "-1.8", resetValue: "3", integerValue: -1, flags: 33 });
    expect(cvars.get("r_fullscreen")).toMatchObject({ value: "-2", resetValue: "1", flags: 33 });
    expect(rendererVideoMode(cvars, -1)).toEqual({ width: 411, height: 267, windowAspect: Math.fround(1.17) });
    cvars.set("r_customwidth", "0"); cvars.set("r_customaspect", "0");
    expect(rendererVideoMode(cvars, -1)?.width).toBe(411);
    new RegisteredRendererCvars(cvars, "linux", null);
    expect(rendererVideoMode(cvars, -1)).toEqual({ width: 0, height: 267, windowAspect: 0 });
    expect(cvars.get("r_customwidth")?.latchedValue).toBeUndefined();
  });

  test("an unmatched initial host profile becomes an actual custom mode", () => {
    const cvars = new CvarRegistry();
    new RegisteredRendererCvars(cvars, "linux", { width: 48, height: 32 });
    expect(cvars.get("r_mode")?.value).toBe("-1");
    expect(rendererVideoMode(cvars, -1)).toEqual({ width: 48, height: 32, windowAspect: 1.5 });
    expect(cvars.get("r_customwidth")?.resetValue).toBe("1600");
    for (const width of [0, -1, 1.5, NaN, Infinity, 16385])
      expect(() => new RegisteredRendererCvars(new CvarRegistry(), "linux", { width, height: 32 })).toThrow("dimensions");
  });

  test("custom host seeding preserves each independently supplied startup cvar", () => {
    const cases: readonly { readonly supplied: readonly (readonly [string, string])[];
      readonly expected: { readonly width: number; readonly height: number; readonly windowAspect: number } }[] = [
      { supplied: [["r_customwidth", "411"], ["r_customheight", "267"], ["r_customaspect", "1.17"]],
        expected: { width: 411, height: 267, windowAspect: Math.fround(1.17) } },
      { supplied: [["r_customwidth", "411"]], expected: { width: 411, height: 32, windowAspect: 1.5 } },
      { supplied: [["r_customheight", "267"]], expected: { width: 48, height: 267, windowAspect: 1.5 } },
      { supplied: [["r_customaspect", "1.17"]], expected: { width: 48, height: 32, windowAspect: Math.fround(1.17) } },
      { supplied: [["r_customwidth", "411"], ["r_customaspect", "1.17"]],
        expected: { width: 411, height: 32, windowAspect: Math.fround(1.17) } },
    ];
    for (const fixture of cases) {
      const cvars = new CvarRegistry();
      for (const [name, value] of fixture.supplied) cvars.set(name, value);
      new RegisteredRendererCvars(cvars, "linux", { width: 48, height: 32 });
      expect(cvars.get("r_mode")).toMatchObject({ value: "-1", resetValue: "3", flags: 33 });
      expect(rendererVideoMode(cvars, -1)).toEqual(fixture.expected);
      expect(cvars.get("r_customwidth")).toMatchObject({ resetValue: "1600", flags: 33 });
      expect(cvars.get("r_customheight")).toMatchObject({ resetValue: "1024", flags: 33 });
      expect(cvars.get("r_customaspect")).toMatchObject({ resetValue: "1", flags: 33 });
    }
    const latched = new CvarRegistry();
    latched.register("r_customwidth", "1600", CvarFlag.Archive | CvarFlag.Latch);
    latched.set("r_customwidth", "411");
    new RegisteredRendererCvars(latched, "linux", { width: 48, height: 32 });
    expect(latched.get("r_customwidth")).toMatchObject({ value: "411", latchedValue: undefined, resetValue: "1600", flags: 33 });
    expect(rendererVideoMode(latched, -1)).toEqual({ width: 411, height: 32, windowAspect: 1.5 });
  });
});

class RegistrationTrace extends CvarRegistry {
  readonly registrations: ExpectedRegistration[] = [];

  override register(name: string, defaultValue: string, flags = CvarFlag.None): CvarSnapshot {
    this.registrations.push([name, defaultValue, flags]);
    return super.register(name, defaultValue, flags);
  }
}

describe("source renderer settings", () => {
  test("draw entities uses the source cheat default and live integer gate", () => {
    const cvars = new CvarRegistry();
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    expect(cvars.get("r_drawentities")).toMatchObject({ value: "1", resetValue: "1", flags: CvarFlag.Cheat });
    expect(settings.runtime.drawEntities).toBe(true);
    for (const [input, enabled] of [["0", false], ["0.75", false], ["-2", true]] satisfies readonly (readonly [string, boolean])[]) {
      cvars.set("r_drawentities", input);
      expect(settings.runtime.drawEntities).toBe(enabled);
    }
  });

  test("diagnostic binding preserves the cheat default and samples live integer values", () => {
    const cvars = new CvarRegistry();
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    expect(cvars.get("r_nobind")).toMatchObject({ value: "0", resetValue: "0", flags: CvarFlag.Cheat });
    expect(settings.noBind).toBe(false);
    for (const [input, enabled] of [["1", true], ["0.75", false], ["-2", true], ["0", false]] satisfies readonly (readonly [string, boolean])[]) {
      cvars.set("r_nobind", input);
      expect(settings.noBind).toBe(enabled);
      expect(cvars.get("r_nobind")?.latchedValue).toBeUndefined();
    }
    const supplied = new CvarRegistry(); supplied.set("r_nobind", "-1");
    const retained = new SourceRendererSettings(new RegisteredRendererCvars(supplied, "linux"), { textureUnits: 2, textureEnvAdd: true });
    expect(retained.noBind).toBe(true);
    expect(supplied.get("r_nobind")).toMatchObject({ value: "-1", resetValue: "0", flags: CvarFlag.Cheat });
  });

  test("GL error checking preserves the archived default and reads the live integer field", () => {
    const cvars = new CvarRegistry();
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    expect(cvars.get("r_ignoreGLErrors")).toMatchObject({ value: "1", resetValue: "1", flags: CvarFlag.Archive });
    expect(settings.ignoreGLErrors).toBe(true);
    for (const [input, ignored] of [["0", false], ["0.5", false], ["-2", true], ["1e-2", true]] satisfies readonly (readonly [string, boolean])[]) {
      cvars.set("r_ignoreGLErrors", input);
      expect(settings.ignoreGLErrors).toBe(ignored);
      expect(cvars.get("r_ignoreGLErrors")?.latchedValue).toBeUndefined();
    }
    const supplied = new CvarRegistry(); supplied.set("r_ignoreGLErrors", "0");
    const retained = new SourceRendererSettings(new RegisteredRendererCvars(supplied, "linux"), { textureUnits: 2, textureEnvAdd: true });
    expect(retained.ignoreGLErrors).toBe(false);
    expect(supplied.get("r_ignoreGLErrors")).toMatchObject({ value: "0", resetValue: "1", flags: CvarFlag.Archive });
  });

  test("model LOD and near-plane cvars preserve source defaults, fields and live changes", () => {
    const cvars = new CvarRegistry(), settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"),
      { textureUnits: 2, textureEnvAdd: true });
    expect([settings.runtime.lodBias, settings.runtime.lodScale, settings.runtime.zNear]).toEqual([0, 5, 4]);
    expect(cvars.get("r_lodbias")).toMatchObject({ resetValue: "0", flags: CvarFlag.Archive });
    expect(cvars.get("r_lodscale")).toMatchObject({ resetValue: "5", flags: CvarFlag.Cheat });
    expect(cvars.get("r_znear")).toMatchObject({ resetValue: "4", flags: CvarFlag.Cheat });
    cvars.set("r_lodbias", "-1.75"); cvars.set("r_lodscale", "1.17"); cvars.set("r_znear", "2.75");
    expect([settings.runtime.lodBias, settings.runtime.lodScale, settings.runtime.zNear]).toEqual([-1, Math.fround(1.17), 2.75]);
    for (const name of ["r_lodbias", "r_lodscale", "r_znear"]) expect(cvars.get(name)?.latchedValue).toBeUndefined();
    cvars.set("r_znear", "201");
    expect(settings.runtime.zNear).toBe(201); // Range assertion runs only during R_Register.
  });

  test("near-plane registration applies source integral comparison and range checks at its own row", () => {
    const cases = [
      { input: "4.75", value: "4.75", warnings: [] },
      { input: "1e2", value: "1", warnings: ["^3WARNING: cvar 'r_znear' must be integral (100.000000)\n"] },
      { input: "0", value: "0.001000", warnings: ["^3WARNING: cvar 'r_znear' out of range (0.000000 < 0.001000)\n"] },
      { input: "201", value: "200.000000", warnings: ["^3WARNING: cvar 'r_znear' out of range (201.000000 > 200.000000)\n"] },
    ];
    for (const entry of cases) {
      const cvars = new CvarRegistry(), warnings: string[] = [];
      cvars.set("r_znear", entry.input);
      const registered = new RegisteredRendererCvars(cvars, "linux", null, text => {
        warnings.push(text); expect(cvars.get("r_flares")?.flags).toBe(CvarFlag.Archive);
        expect(cvars.get("r_fastsky")).toBeUndefined(); expect(cvars.get("r_lodscale")).toBeUndefined();
      });
      const settings = new SourceRendererSettings(registered, { textureUnits: 2, textureEnvAdd: true });
      expect(cvars.get("r_znear")?.value).toBe(entry.value);
      expect(settings.runtime.zNear).toBe(Math.fround(Number(entry.value))); expect(warnings).toEqual(entry.warnings);
    }
    const cvars = new CvarRegistry(); cvars.set("r_znear", "nan");
    expect(() => new RegisteredRendererCvars(cvars, "linux")).toThrow("float-to-int");
  });

  test("registration orders picmip before refresh and backend initialization preserves later warning mutations", () => {
    const cvars = new RegistrationTrace(), warnings: string[] = [];
    cvars.set("r_picmip", "17"); cvars.set("r_displayRefresh", "201");
    const print = (text: string): void => {
      warnings.push(text);
      if (text.includes("r_picmip")) {
        expect(cvars.get("r_displayRefresh")?.flags).toBe(CvarFlag.UserCreated);
        expect(cvars.get("r_mode")).toBeUndefined();
      } else {
        expect(cvars.get("r_mode")?.value).toBe("3");
        expect(cvars.get("r_intensity")).toBeUndefined();
        cvars.set("r_picmip", "99", true);
      }
    };
    const registered = new RegisteredRendererCvars(cvars, "linux", null, print);
    expect(warnings).toEqual(["^3WARNING: cvar 'r_picmip' out of range (17.000000 > 16.000000)\n",
      "^3WARNING: cvar 'r_displayRefresh' out of range (201.000000 > 200.000000)\n"]);
    expect(registered.cvars).toBe(cvars); expect(registered.print).toBe(print);
    expect(cvars.get("r_picmip")?.value).toBe("99");
    expect(cvars.get("r_displayRefresh")).toMatchObject({ value: "200.000000", resetValue: "0", flags: 32 });
    const registrations = [...cvars.registrations];
    const backend = new SoftwareRenderer(8, 8, new RendererImageCatalog());
    try {
      const settings = new SourceRendererSettings(registered, backend.capabilities);
      expect(settings.imageUploadSettings().picmip).toBe(99);
      expect(cvars.registrations).toEqual(registrations);
      expect(warnings).toHaveLength(2);
    } finally { backend.close(); }
  });

  test("the registration phase consumes latches once and preserves pending changes until a new registration", () => {
    const cvars = new RegistrationTrace();
    new RegisteredRendererCvars(cvars, "linux");
    cvars.set("r_picmip", "4"); cvars.set("r_displayRefresh", "60"); cvars.set("r_customwidth", "411");
    cvars.registrations.length = 0;
    const registered = new RegisteredRendererCvars(cvars, "linux");
    expect(cvars.get("r_picmip")).toMatchObject({ value: "4", latchedValue: undefined });
    expect(cvars.get("r_displayRefresh")).toMatchObject({ value: "60", latchedValue: undefined });
    expect(cvars.get("r_customwidth")).toMatchObject({ value: "411", latchedValue: undefined });
    for (const name of ["r_picmip", "r_displayRefresh", "r_customwidth", "r_stencilbits"])
      expect(cvars.registrations.filter(row => row[0] === name)).toHaveLength(1);
    cvars.set("r_picmip", "8"); cvars.set("r_displayRefresh", "75");
    const count = cvars.registrations.length;
    const settings = new SourceRendererSettings(registered, { textureUnits: 2, textureEnvAdd: true });
    expect(settings.imageUploadSettings().picmip).toBe(4);
    expect(cvars.get("r_displayRefresh")).toMatchObject({ value: "60", latchedValue: "75" });
    expect(cvars.get("r_picmip")?.latchedValue).toBe("8");
    expect(cvars.registrations).toHaveLength(count);
    const restarted = new RegisteredRendererCvars(cvars, "linux");
    expect(new SourceRendererSettings(restarted, { textureUnits: 2, textureEnvAdd: true }).imageUploadSettings().picmip).toBe(8);
    expect(cvars.get("r_displayRefresh")).toMatchObject({ value: "75", latchedValue: undefined });
  });

  test("host seeding at the video rows preserves values supplied by earlier and later warning callbacks", () => {
    const cvars = new CvarRegistry(); cvars.set("r_picmip", "17"); cvars.set("r_displayRefresh", "201");
    new RegisteredRendererCvars(cvars, "linux", { width: 48, height: 32 }, text => {
      if (text.includes("r_picmip")) cvars.set("r_customwidth", "411");
      else cvars.set("r_customheight", "267", true);
    });
    expect(rendererVideoMode(cvars, -1)).toEqual({ width: 411, height: 267, windowAspect: 1.5 });
    expect(cvars.get("r_customwidth")).toMatchObject({ resetValue: "1600", flags: 33 });
    expect(cvars.get("r_customheight")).toMatchObject({ resetValue: "1024", flags: 33 });
  });

  test("refresh registration preserves float32 diagnostics and the real print owner remains available after initialization", () => {
    const cvars = new CvarRegistry(), warnings: string[] = [];
    cvars.set("R_DisplayRefresh", "-1e-50");
    const registered = new RegisteredRendererCvars(cvars, "other", null, text => { warnings.push(text); });
    expect(warnings).toEqual(["^3WARNING: cvar 'R_DisplayRefresh' must be integral (-0.000000)\n",
      "^3WARNING: cvar 'R_DisplayRefresh' out of range (-1.000000 < 0.000000)\n"]);
    expect(cvars.get("r_displayRefresh")).toMatchObject({ value: "0.000000", resetValue: "0", flags: 32 });
    expect(cvars.get("r_stencilbits")).toMatchObject({ value: "8", resetValue: "8", flags: 33 });
    const settings = new SourceRendererSettings(registered, { textureUnits: 2, textureEnvAdd: true });
    settings.warnBadTextureMode();
    expect(warnings[2]).toBe("bad filter name\n");
  });

  test("image registrations retain source resets, flags, integer reads and restart latches", () => {
    const cvars = new CvarRegistry();
    cvars.set("r_picmip", "2.75"); cvars.set("r_roundImagesDown", "0.5");
    cvars.set("r_texturebits", "16");
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    expect(settings.imageUploadSettings()).toEqual({ picmip: 2, roundImagesDown: false, simpleMipMaps: true, colorMipLevels: false, textureBits: 16 });
    expect(cvars.get("r_picmip")).toMatchObject({ value: "2.75", resetValue: "1", flags: 33 });
    expect(cvars.get("r_textureMode")).toMatchObject({ value: "GL_LINEAR_MIPMAP_NEAREST", resetValue: "GL_LINEAR_MIPMAP_NEAREST", flags: 1 });
    expect(cvars.get("r_intensity")).toMatchObject({ value: "1", resetValue: "1", flags: 32 });
    expect(cvars.get("r_overBrightBits")).toMatchObject({ value: "1", resetValue: "1", flags: 33 });
    cvars.set("r_picmip", "4"); cvars.set("r_roundImagesDown", "-1");
    cvars.set("r_simpleMipMaps", "0"); cvars.set("r_colorMipLevels", "2"); cvars.set("r_texturebits", "32");
    expect(settings.imageUploadSettings()).toEqual({ picmip: 2, roundImagesDown: false, simpleMipMaps: true, colorMipLevels: false, textureBits: 16 });
    const replacement = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    expect(replacement.imageUploadSettings()).toEqual({ picmip: 4, roundImagesDown: true, simpleMipMaps: false, colorMipLevels: true, textureBits: 32 });
    expect(cvars.get("r_picmip")?.latchedValue).toBeUndefined();
  });

  test("AssertCvarRange preserves the source float-versus-atoi comparison and forced text", () => {
    const cases = [
      { input: "1.75", value: "1.75", integer: 1, warnings: [] },
      { input: "1e1", value: "1", integer: 1, warnings: ["^3WARNING: cvar 'r_picmip' must be integral (10.000000)\n"] },
      { input: "-0.5", value: "0.000000", integer: 0, warnings: ["^3WARNING: cvar 'r_picmip' out of range (-0.500000 < 0.000000)\n"] },
      { input: "16.9", value: "16.000000", integer: 16, warnings: ["^3WARNING: cvar 'r_picmip' out of range (16.900000 > 16.000000)\n"] },
      { input: "garbage", value: "garbage", integer: 0, warnings: [] },
    ];
    for (const fixture of cases) {
      const cvars = new CvarRegistry(), warnings: string[] = [];
      cvars.set("r_picmip", fixture.input);
      const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux", null, text => { warnings.push(text); }), { textureUnits: 2, textureEnvAdd: true });
      expect(cvars.get("r_picmip")?.value).toBe(fixture.value);
      expect(settings.imageUploadSettings().picmip).toBe(fixture.integer);
      expect(warnings).toEqual(fixture.warnings);
    }
    for (const input of ["nan", "inf", "2147483648", "-2147483904"]) {
      const cvars = new CvarRegistry(); cvars.set("r_picmip", input);
      expect(() => new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true })).toThrow("float-to-int");
    }
  });

  test("range warnings preserve native ties-even decimals, signed zero, source spelling and yellow print level", () => {
    const cases = [
      { input: "16.0078125", text: "out of range (16.007812 > 16.000000)", value: "16.000000" },
      { input: "16.0234375", text: "out of range (16.023438 > 16.000000)", value: "16.000000" },
      { input: "-0.0078125", text: "out of range (-0.007812 < 0.000000)", value: "0.000000" },
      { input: "-0.0234375", text: "out of range (-0.023438 < 0.000000)", value: "0.000000" },
      { input: "-2147483648", text: "out of range (-2147483648.000000 < 0.000000)", value: "0.000000" },
      { input: "2147483520", text: "out of range (2147483520.000000 > 16.000000)", value: "16.000000" },
    ];
    for (const fixture of cases) {
      const cvars = new CvarRegistry(), warnings: string[] = [];
      cvars.set("R_PiCmIp", fixture.input);
      new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux", null, text => { warnings.push(text); }), { textureUnits: 2, textureEnvAdd: true });
      expect(warnings).toEqual([`^3WARNING: cvar 'R_PiCmIp' ${fixture.text}\n`]);
      expect(cvars.get("r_picmip")?.value).toBe(fixture.value);
    }
    const cvars = new CvarRegistry(), warnings: string[] = [];
    cvars.set("R_PiCmIp", "-1e-50");
    expect(Object.is(cvars.get("r_picmip")?.numericValue, -0)).toBe(true);
    new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux", null, text => { warnings.push(text); }), { textureUnits: 2, textureEnvAdd: true });
    expect(warnings).toEqual(["^3WARNING: cvar 'R_PiCmIp' must be integral (-0.000000)\n",
      "^3WARNING: cvar 'R_PiCmIp' out of range (-1.000000 < 0.000000)\n"]);
    expect(cvars.get("r_picmip")?.value).toBe("0.000000");
    const redirected = new CvarRegistry(), redirectedWarnings: string[] = [];
    redirected.set("r_picmip", "1e1");
    new SourceRendererSettings(new RegisteredRendererCvars(redirected, "linux", null, text => {
      redirectedWarnings.push(text);
      if (redirectedWarnings.length === 1) redirected.set("r_picmip", "17", true);
    }), { textureUnits: 2, textureEnvAdd: true });
    expect(redirectedWarnings).toEqual(["^3WARNING: cvar 'r_picmip' must be integral (10.000000)\n",
      "^3WARNING: cvar 'r_picmip' out of range (17.000000 > 16.000000)\n"]);
    expect(redirected.get("r_picmip")?.value).toBe("16.000000");
  });

  test("color mapping clamps write intensity before gamma and retain binary32 inputs", () => {
    class Writes extends CvarRegistry {
      readonly writes: string[] = [];
      override set(name: string, value: string, force = false): CvarSnapshot {
        this.writes.push(`${name}=${value}:${force}`); return super.set(name, value, force);
      }
    }
    const cvars = new Writes(), settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    cvars.set("r_intensity", "0.75", true); cvars.set("r_gamma", "4", true);
    cvars.clearModified("r_intensity"); cvars.clearModified("r_gamma"); cvars.writes.length = 0;
    const device = { deviceSupportsGamma: true, isFullscreen: true, colorBits: 24 };
    expect(settings.colorMappingInputs(device)).toEqual({ ...device, gamma: 3, intensity: 1, requestedOverbrightBits: 1 });
    expect(cvars.writes).toEqual(["r_intensity=1:true", "r_gamma=3.0:true"]);
    expect(cvars.get("r_gamma")?.modified).toBe(true); expect(cvars.get("r_intensity")?.modified).toBe(true);
    cvars.set("r_gamma", "1.17", true); cvars.set("r_intensity", "1.3", true);
    expect(settings.colorMappingInputs(device)).toMatchObject({ gamma: Math.fround(1.17), intensity: Math.fround(1.3) });
    cvars.set("r_intensity", "0", true); cvars.set("r_gamma", "nan", true); cvars.writes.length = 0;
    expect(() => settings.colorMappingInputs(device)).toThrow("NaN gamma");
    expect(cvars.writes).toEqual(["r_intensity=1:true"]);
    expect(cvars.get("r_intensity")?.value).toBe("1");
  });

  test("color mapping snapshots overbright before actual clamp diagnostics can change its cvar", () => {
    let active = false;
    const messages: string[] = [];
    const cvars = new CvarRegistry(undefined, text => {
      if (!active) return;
      messages.push(text);
      if (text === "Cvar_Set2: r_intensity 1\n") cvars.set("r_overBrightBits", "2", true);
    });
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    cvars.set("r_intensity", "0.75", true); cvars.set("r_gamma", "4", true);
    const device = { deviceSupportsGamma: true, isFullscreen: true, colorBits: 24 };
    active = true;
    const inputs = settings.colorMappingInputs(device);
    expect(messages).toEqual(["Cvar_Set2: r_intensity 1\n", "Cvar_Set2: r_overBrightBits 2\n", "Cvar_Set2: r_gamma 3.0\n"]);
    expect(inputs.requestedOverbrightBits).toBe(1);
    expect(settings.requestedOverbrightBits).toBe(2);
    expect(imageColorLighting(inputs)).toEqual({ deviceSupportsGamma: true, overbrightBits: 1, identityLight: 0.5, identityLightByte: 127 });
  });

  test("color lighting scalars are available before a failing source gamma clamp", () => {
    let active = false;
    const failure = new Error("gamma clamp diagnostic stopped");
    const cvars = new CvarRegistry(undefined, text => {
      if (active && text === "Cvar_Set2: r_gamma 3.0\n") throw failure;
    });
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    cvars.set("r_intensity", "0.75", true); cvars.set("r_gamma", "4", true); cvars.set("r_overBrightBits", "2", true);
    const device = { deviceSupportsGamma: true, isFullscreen: true, colorBits: 24 };
    const lighting = imageColorLighting({ ...device, requestedOverbrightBits: settings.requestedOverbrightBits });
    expect(lighting).toEqual({ deviceSupportsGamma: true, overbrightBits: 2, identityLight: 0.25, identityLightByte: 63 });
    expect(cvars.get("r_intensity")?.value).toBe("0.75");
    expect(cvars.get("r_gamma")?.value).toBe("4");
    active = true;
    expect(() => settings.colorMappingInputs(device)).toThrow(failure);
    expect(cvars.get("r_intensity")?.value).toBe("1");
    expect(cvars.get("r_gamma")?.value).toBe("4");
  });

  test("Linux multitexture initialization reads the source float cvar field", () => {
    const cvars = new CvarRegistry();
    cvars.set("r_ext_multitexture", "0.5", true);
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    expect(cvars.get("r_ext_multitexture")?.integerValue).toBe(0);
    expect(settings.registrationProfile().iterator.multitexture).toBe(true);
  });
  test("registers the exact relevant tr_init cvar rows in source order", () => {
    const cvars = new RegistrationTrace();
    new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    const expected: readonly ExpectedRegistration[] = [
      ["r_glDriver", "libGL.so.1", 33],
      ["r_allowExtensions", "1", 33],
      ["r_ext_compressed_textures", "0", 33],
      ["r_ext_gamma_control", "1", 33],
      ["r_ext_multitexture", "1", 33],
      ["r_ext_compiled_vertex_array", "1", 33],
      ["r_ext_texture_env_add", "0", 33],
      ["r_picmip", "1", 33],
      ["r_roundImagesDown", "1", 33],
      ["r_colorMipLevels", "0", 32],
      ["r_detailtextures", "1", 33],
      ["r_texturebits", "0", 33],
      ["r_colorbits", "0", 33],
      ["r_stereo", "0", 33],
      ["r_stencilbits", "0", 33],
      ["r_depthbits", "0", 33],
      ["r_overBrightBits", "1", 33],
      ["r_ignorehwgamma", "0", 33],
      ["r_mode", "3", 33],
      ["r_fullscreen", "1", 33],
      ["r_customwidth", "1600", 33],
      ["r_customheight", "1024", 33],
      ["r_customaspect", "1", 33],
      ["r_simpleMipMaps", "1", 33],
      ["r_vertexLight", "0", 33],
      ["r_uifullscreen", "0", 0],
      ["r_subdivisions", "4", 33],
      ["r_smp", "0", 33],
      ["r_ignoreFastPath", "1", 33],
      ["r_displayRefresh", "0", 32],
      ["r_fullbright", "0", 544],
      ["r_mapOverBrightBits", "2", 32],
      ["r_intensity", "1", 32],
      ["r_singleShader", "0", 544],
      ["r_lodCurveError", "250", 513],
      ["r_lodbias", "0", 1],
      ["r_flares", "0", 1],
      ["r_znear", "4", 512],
      ["r_ignoreGLErrors", "1", 1],
      ["r_fastsky", "0", 1],
      ["r_inGameVideo", "1", 1],
      ["r_drawSun", "0", 1],
      ["r_dynamiclight", "1", 1],
      ["r_dlightBacks", "1", 1],
      ["r_finish", "0", 1],
      ["r_textureMode", "GL_LINEAR_MIPMAP_NEAREST", 1],
      ["r_swapInterval", "0", 1],
      ["r_gamma", "1", 1],
      ["r_facePlaneCull", "1", 1],
      ["r_railWidth", "16", 1],
      ["r_railCoreWidth", "6", 1],
      ["r_railSegmentLength", "32", 1],
      ["r_primitives", "0", 1],
      ["r_ambientScale", "0.6", 512],
      ["r_directedScale", "1", 512],
      ["r_showImages", "0", 256],
      ["r_debuglight", "0", 256],
      ["r_debugSort", "0", 512],
      ["r_printShaders", "0", 0],
      ["r_saveFontData", "0", 0],
      ["r_nocurves", "0", 512],
      ["r_drawworld", "1", 512],
      ["r_lightmap", "0", 0],
      ["r_portalOnly", "0", 512],
      ["r_flareSize", "40", 512],
      ["r_flareFade", "7", 512],
      ["r_showSmp", "0", 512],
      ["r_skipBackEnd", "0", 512],
      ["r_measureOverdraw", "0", 512],
      ["r_lodscale", "5", 512],
      ["r_norefresh", "0", 512],
      ["r_drawentities", "1", 512],
      ["r_ignore", "1", 512],
      ["r_nocull", "0", 512],
      ["r_novis", "0", 512],
      ["r_showcluster", "0", 512],
      ["r_speeds", "0", 512],
      ["r_verbose", "0", 512],
      ["r_logFile", "0", 512],
      ["r_debugSurface", "0", 512],
      ["r_nobind", "0", 512],
      ["r_showtris", "0", 512],
      ["r_showsky", "0", 512],
      ["r_shownormals", "0", 512],
      ["r_clear", "0", 512],
      ["r_offsetfactor", "-1", 512],
      ["r_offsetunits", "-2", 512],
      ["r_drawBuffer", "GL_BACK", 512],
      ["r_lockpvs", "0", 512],
      ["r_noportals", "0", 512],
      ["cg_shadows", "1", 0],
      ["r_maxpolys", "600", 0],
      ["r_maxpolyverts", "3000", 0],
    ];
    expect(cvars.registrations).toEqual([...expected]);
  });

  test("lighting and shader diagnostics retain source flags and live integer gates", () => {
    const cvars = new CvarRegistry();
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    expect(cvars.get("r_debuglight")).toMatchObject({ value: "0", resetValue: "0", flags: CvarFlag.Temporary });
    expect(cvars.get("r_printShaders")).toMatchObject({ value: "0", resetValue: "0", flags: CvarFlag.None });
    expect(settings.runtime.debugLight).toBe(false);
    expect(settings.runtime.printShaders).toBe(false);
    for (const value of ["-2", "1", "0.9", "0"]) {
      cvars.set("r_debuglight", value); cvars.set("r_printShaders", value);
      expect(settings.runtime.debugLight).toBe(Number.parseInt(value, 10) !== 0);
      expect(settings.runtime.printShaders).toBe(Number.parseInt(value, 10) !== 0);
    }
  });

  test("primitives preserves the archived default and live unclamped integer field", () => {
    const cvars = new CvarRegistry();
    const registered = new RegisteredRendererCvars(cvars, "linux");
    const settings = new SourceRendererSettings(registered, { textureUnits: 2, textureEnvAdd: true });
    const runtime = settings.runtime;
    expect(cvars.get("r_primitives")).toMatchObject({ value: "0", resetValue: "0", flags: CvarFlag.Archive });
    expect(runtime.primitives).toBe(0);
    for (const value of [0, 1, 2, 3, -1, 7, -27, 2147483647, -2147483648]) {
      cvars.set("r_primitives", String(value));
      expect(runtime.primitives).toBe(value);
      expect(cvars.get("r_primitives")?.latchedValue).toBeUndefined();
    }
    cvars.set("r_primitives", "-2.9");
    expect(runtime.primitives).toBe(-2);
    cvars.setCheatsEnabled(false);
    expect(runtime.primitives).toBe(-2);
    const replacement = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"),
      { textureUnits: 0, textureEnvAdd: false });
    expect(replacement.runtime.primitives).toBe(-2);
    cvars.set("r_primitives", "3");
    expect(runtime.primitives).toBe(3);
    expect(replacement.runtime.primitives).toBe(3);
    const independent = new SourceRendererSettings(new RegisteredRendererCvars(new CvarRegistry(), "linux"),
      { textureUnits: 0, textureEnvAdd: false });
    expect(independent.runtime.primitives).toBe(0);
  });

  test("debug sort, triangles and normals retain exact cheat defaults and live signed integers across replacement", () => {
    const cvars = new CvarRegistry();
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    const rows: readonly (readonly [string, "debugSort" | "showTris" | "showNormals"])[] = [
      ["r_debugSort", "debugSort"], ["r_showtris", "showTris"], ["r_shownormals", "showNormals"],
    ];
    for (const [name, field] of rows) {
      expect(cvars.get(name)).toMatchObject({ value: "0", resetValue: "0", flags: CvarFlag.Cheat });
      expect(settings.runtime[field]).toBe(0);
      for (const value of [-2, 0, 2, -2147483648, 2147483647]) {
        cvars.set(name, String(value));
        expect(settings.runtime[field]).toBe(value);
        expect(cvars.get(name)?.latchedValue).toBeUndefined();
      }
      cvars.set(name, "-2.9"); expect(settings.runtime[field]).toBe(-2);
    }
    const replacement = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 0, textureEnvAdd: false });
    for (const [name, field] of rows) {
      expect(replacement.runtime[field]).toBe(-2);
      cvars.set(name, "2");
      expect(settings.runtime[field]).toBe(2); expect(replacement.runtime[field]).toBe(2);
    }
    cvars.setCheatsEnabled(false);
    for (const [name, field] of rows) {
      expect(settings.runtime[field]).toBe(0); expect(replacement.runtime[field]).toBe(0);
      cvars.set(name, "-2"); expect(settings.runtime[field]).toBe(0);
    }
  });

  test("showsky retains the source cheat registration and live integer gate", () => {
    const cvars = new CvarRegistry();
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    expect(cvars.get("r_showsky")?.flags).toBe(CvarFlag.Cheat);
    expect(settings.runtime.showSky).toBe(0);
    cvars.set("r_showsky", "0.9"); expect(settings.runtime.showSky).toBe(0);
    cvars.set("r_showsky", "-2.9"); expect(settings.runtime.showSky).toBe(-2);
    cvars.setCheatsEnabled(false); expect(settings.runtime.showSky).toBe(0);
    cvars.set("r_showsky", "1"); expect(settings.runtime.showSky).toBe(0);
  });

  test("finish retains the live source integer for distinct zero, one, and other gates", () => {
    const cvars = new CvarRegistry();
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    expect(settings.runtime.finish).toBe(0);
    cvars.set("r_finish", "1.75");
    expect(settings.runtime.finish).toBe(1);
    cvars.set("r_finish", "2");
    expect(settings.runtime.finish).toBe(2);
    cvars.set("r_finish", "-1");
    expect(settings.runtime.finish).toBe(-1);
    expect(cvars.get("r_finish")?.latchedValue).toBeUndefined();
  });

  test("scene dynamic lights use exact integer gates independent of fullscreen UI", () => {
    const cvars = new CvarRegistry(), settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    expect(settings.runtime.dynamicLights).toBe(true);
    cvars.set("r_dynamiclight", "0", true); expect(settings.runtime.dynamicLights).toBe(false);
    cvars.set("r_dynamiclight", "1", true); cvars.set("r_vertexLight", "1", true); cvars.set("r_uifullscreen", "1", true);
    expect(settings.runtime.dynamicLights).toBe(false);
    cvars.set("r_vertexLight", "2", true); expect(settings.runtime.dynamicLights).toBe(true);
    cvars.set("r_dlightBacks", "0", true); expect(settings.runtime.dynamicLights).toBe(true);
    expect([settings.runtime.noCull, settings.runtime.facePlaneCull, settings.runtime.noCurves]).toEqual([false, true, false]);
    cvars.set("r_nocull", "1", true); cvars.set("r_facePlaneCull", "0", true); cvars.set("r_nocurves", "1", true);
    expect([settings.runtime.noCull, settings.runtime.facePlaneCull, settings.runtime.noCurves]).toEqual([true, false, true]);
  });

  test("uses the platform-specific env-add default and explicit actual capabilities", () => {
    const linux = new SourceRendererSettings(new RegisteredRendererCvars(new CvarRegistry(), "linux"), { textureUnits: 2, textureEnvAdd: true }).registrationProfile();
    expect(linux).toEqual({
      detailTextures: true, vertexLight: false, uiFullscreen: false, hardware: "generic",
      iterator: { ignoreFastPath: true, multitexture: true, textureEnvAdd: false, driver: "generic" },
    });

    const other = new SourceRendererSettings(new RegisteredRendererCvars(new CvarRegistry(), "other"), { textureUnits: 2, textureEnvAdd: true });
    expect(other.registrationProfile().iterator.textureEnvAdd).toBe(true);
    const limited = new SourceRendererSettings(new RegisteredRendererCvars(new CvarRegistry(), "other"), { textureUnits: 1, textureEnvAdd: false });
    expect(limited.registrationProfile().iterator).toMatchObject({ multitexture: false, textureEnvAdd: false });
  });

  test("keeps shader cvars live while extension initialization stays frozen until replacement", () => {
    const cvars = new CvarRegistry();
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "other"), { textureUnits: 4, textureEnvAdd: true });
    cvars.set("r_vertexLight", "1");
    cvars.set("r_detailtextures", "0");
    expect(settings.registrationProfile()).toMatchObject({ detailTextures: true, vertexLight: false });
    expect(cvars.get("r_vertexLight")?.latchedValue).toBe("1");

    cvars.applyLatched();
    expect(settings.registrationProfile()).toMatchObject({ detailTextures: false, vertexLight: true });
    cvars.set("r_ext_multitexture", "0", true);
    cvars.set("r_ext_texture_env_add", "0");
    cvars.applyLatched("r_ext_texture_env_add");
    expect(settings.registrationProfile().iterator).toMatchObject({ multitexture: true, textureEnvAdd: true });

    const replacement = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "other"), { textureUnits: 4, textureEnvAdd: true });
    expect(replacement.registrationProfile().iterator).toMatchObject({ multitexture: false, textureEnvAdd: false });
  });

  test("keeps unlatched runtime lightmap, vertex lighting, UI, and polygon offset live", () => {
    const cvars = new CvarRegistry();
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    expect(settings.runtime.lightmap).toBe(false);
    expect(settings.runtime.shadows).toBe(1);
    expect(settings.runtime.lodCurveError).toBe(250);
    cvars.set("r_lodCurveError", "12.375");
    expect(settings.runtime.lodCurveError).toBe(12.375);
    expect(cvars.get("r_shadows")).toBeUndefined();
    cvars.set("cg_shadows", "3.75");
    expect(settings.runtime.shadows).toBe(3);
    expect(settings.runtime.vertexLighting).toBe(false);
    expect(settings.runtime.polygonOffset).toEqual({ factor: -1, units: -2 });
    expect(settings.registrationProfile().uiFullscreen).toBe(false);
    cvars.set("r_lightmap", "2");
    cvars.set("r_vertexLight", "1", true);
    cvars.set("r_offsetfactor", "-0.5");
    cvars.set("r_offsetunits", "3.25");
    cvars.set("r_uifullscreen", "1");
    expect(settings.runtime.lightmap).toBe(true);
    expect(settings.runtime.vertexLighting).toBe(false);
    expect(settings.runtime.polygonOffset).toEqual({ factor: -0.5, units: 3.25 });
    expect(settings.registrationProfile().uiFullscreen).toBe(true);
    cvars.set("r_uifullscreen", "0");
    expect(settings.runtime.vertexLighting).toBe(true);
  });
});
