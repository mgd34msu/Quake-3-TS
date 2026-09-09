// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { loadGl } from "../src/platform/gl.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { CommonError } from "../src/core/common-error.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog, RgbaSnapshot } from "../src/render/image-resource.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import type { RendererImage, ImageSource } from "../src/render/image-resource.ts";
import type { CinematicUpload } from "../src/render/cinematic-command.ts";
import type { DrawBatch, TextureBinding, TextureSampling } from "../src/render/types.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import { executeStaticBatch as draw } from "./render-target-fixture.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";

const white = { x: 1, y: 1, z: 1, w: 1 }, black = { x: 0, y: 0, z: 0, w: 0 };
function pixels(width: number, height: number, color: readonly number[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < result.length; offset += 4) result.set(color, offset);
  return result;
}
function source(name: string, width = 2, height = 2, color: readonly number[] = [255, 0, 0, 64]): ImageSource {
  return { name, sourceWidth: width, sourceHeight: height, mipmap: false,
    levels: [{ width, height, pixels: pixels(width, height, color) }], internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 };
}
function upload(image: RendererImage, width: number, height: number, color: readonly number[], dirty: boolean): CinematicUpload {
  return { image, sourceWidth: width, sourceHeight: height, uploadWidth: width, uploadHeight: height,
    content: new RgbaSnapshot(width, height, pixels(width, height, color)), dirty };
}
function quad(texture: TextureBinding, alpha = 1, uv = 0.5): DrawBatch {
  return { primitive: "triangles", texturing: "single", texture, state: { ...OPAQUE_STATE, cull: "none", depthTest: "always" },
    indices: [0, 1, 2, 0, 2, 3], vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(point => {
      const [x, y] = point; if (x === undefined || y === undefined) throw new Error("Missing point");
      return { position: { x, y, z: 0, w: 1 }, color: { ...white, w: alpha }, texCoord: { x: uv, y: uv } };
    }) };
}
function pairedQuad(first: TextureBinding, second: TextureBinding): DrawBatch {
  const single = quad(first);
  return { ...single, texturing: "pair", vertices: single.vertices.map(vertex => ({ ...vertex, texCoord2: { x: 0.5, y: 0.5 } })),
    secondTexture: { binding: second, environment: "replace" } };
}
function applyUpload(renderer: GlRenderer, call: CinematicUpload): void {
  const raw = renderer.prepareRawGeometry({ rect: { x: 0, y: 0, width: 8, height: 8 }, uploadWidth: call.uploadWidth, uploadHeight: call.uploadHeight, identityLight: 1 });
  raw.uploadCurrent(call);
}
function center(renderer: GlRenderer): number[] { return Array.from(renderer.readPixels().slice((4 * 8 + 4) * 4, (4 * 8 + 5) * 4)); }
function initialize(renderer: GlRenderer): void {
  const settings = new SourceRendererSettings(new RegisteredRendererCvars(new CvarRegistry(), "linux"), renderer.capabilities);
  renderer.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
    if (!renderer.images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
}
function fixture(images = new RendererImageCatalog()) {
  const window = SdlWindow.open({ title: "Explicit GL image state", width: 8, height: 8, backend: "gl", hidden: true });
  const renderer = new GlRenderer(window, images), session = images.openSession();
  initialize(renderer);
  session.attach(renderer); session.beginExecution();
  const native = loadGl(window), gl = native.symbols;
  const integer = (name: number): number => {
    const values = new Int32Array(1); gl.glGetIntegerv(name, values);
    const value = values[0]; if (value === undefined) throw new Error("Missing GL integer"); return value;
  };
  const inspect = (name: number) => {
    window.makeCurrent(); const previous = integer(0x8069); gl.glBindTexture(0xde1, name);
    try {
      const level = (parameter: number): number => {
        const values = new Int32Array(1); gl.glGetTexLevelParameteriv(0xde1, 0, parameter, values);
        const value = values[0]; if (value === undefined) throw new Error("Missing GL level"); return value;
      };
      const parameter = (key: number): number[] => {
        const values = new Float32Array(4); gl.glGetTexParameterfv(0xde1, key, values); return Array.from(values);
      };
      const width = level(0x1000), height = level(0x1001), data = new Uint8Array(width * height * 4);
      if (data.length > 0) gl.glGetTexImage(0xde1, 0, 0x1908, 0x1401, data);
      return { width, height, format: level(0x1003), border: parameter(0x1004), wrap: parameter(0x2802)[0], filter: parameter(0x2801)[0], pixels: data };
    } finally { gl.glBindTexture(0xde1, previous); }
  };
  renderer.beginView({ viewport: { x: 0, y: 0, width: 8, height: 8 }, clear: { stencil: false, depth: 1, color: black } });
  const bits = renderer.alphaBits, maximum = 2 ** bits - 1;
  const alpha = (value: number): number => bits === 0 ? 255 : Math.round(Math.round(value * maximum / 255) * 255 / maximum);
  return { images, renderer, window, gl, integer, inspect, alpha,
    close: () => { session.close(); native.close(); renderer.close(); window.close(); } };
}
function bindingCvars(f: ReturnType<typeof fixture>, initial = "0"): CvarRegistry {
  const cvars = new CvarRegistry();
  const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), f.renderer.capabilities);
  cvars.set("r_nobind", initial, true);
  f.images.setBindingSettings(settings);
  return cvars;
}

describe.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("explicit native GL image state", () => {
  test("Upload32 consumes ignored errors, skips the flag read for zero, and leaves cinematic errors pending", () => {
    const f = fixture();
    try {
      expect(f.images.ignoreGLErrors).toBe(true);
      f.gl.glEnable(0xffffffff);
      f.images.create(source("default ignored error"));
      expect(f.gl.glGetError()).toBe(0);
      const cvars = new CvarRegistry();
      const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), f.renderer.capabilities);
      let reads = 0;
      f.images.setErrorSettings({ get ignoreGLErrors(): boolean {
        reads++;
        expect(f.gl.glGetError()).toBe(0);
        return settings.ignoreGLErrors;
      } });
      f.images.create(source("clean upload")); expect(reads).toBe(0);
      f.gl.glViewport(0, 0, -1, 8);
      const scratch = f.images.create(source("ignored invalid value"));
      expect(reads).toBe(1); expect(f.gl.glGetError()).toBe(0);
      cvars.set("r_ignoreGLErrors", "0");
      expect(() => applyUpload(f.renderer, upload(scratch, 2, 2, [0, 255, 0, 255], true))).not.toThrow();
      expect(f.gl.glGetError()).toBe(0x501); expect(reads).toBe(1);
      f.gl.glEnable(0xffffffff);
      expect(() => applyUpload(f.renderer, upload(scratch, 4, 4, [0, 0, 255, 255], false))).not.toThrow();
      expect(f.gl.glGetError()).toBe(0x500); expect(reads).toBe(1);
    } finally { f.close(); }
  });

  test("Upload32 emits source symbolic fatal errors after filtering and before wrap, unbind or unit restoration", () => {
    const cases: readonly { readonly code: number; readonly name: string; readonly unit: 0 | 1 }[] = [
      { code: 0x500, name: "GL_INVALID_ENUM", unit: 0 },
      { code: 0x501, name: "GL_INVALID_VALUE", unit: 1 },
      { code: 0x502, name: "GL_INVALID_OPERATION", unit: 0 },
    ];
    for (const expected of cases) {
      const f = fixture();
      try {
        const cvars = new CvarRegistry();
        const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), f.renderer.capabilities);
        f.images.setErrorSettings(settings); cvars.set("r_ignoreGLErrors", "0.5");
        switch (expected.code) {
          case 0x500: f.gl.glEnable(0xffffffff); break;
          case 0x501: f.gl.glViewport(0, 0, -1, 8); break;
          case 0x502: f.gl.glBegin(0); f.gl.glBegin(0); f.gl.glEnd(); break;
          default: throw new Error("Missing native error generator");
        }
        let failure: unknown = null;
        try { f.images.create({ ...source("fatal upload"), sampling: { wrap: "clamp", filter: "nearest" }, registrationUnit: expected.unit }); }
        catch (error: unknown) { failure = error; }
        expect(failure).toBeInstanceOf(CommonError);
        if (!(failure instanceof CommonError)) throw new Error("Missing source GL upload failure");
        expect(failure.code).toBe("fatal"); expect(failure.message).toBe(`GL_CheckErrors: ${expected.name}`);
        expect(f.integer(0x84e0)).toBe(0x84c0 + expected.unit);
        expect(f.integer(0x8069)).toBe(1024);
        const actual = f.inspect(1024);
        expect([actual.width, actual.height, actual.filter, actual.wrap]).toEqual([2, 2, 0x2600, 0x2901]);
        expect(Array.from(actual.pixels.slice(0, 4))).toEqual([255, 0, 0, 64]);
        expect(f.gl.glGetError()).toBe(0);
        expect(() => f.images.create(source("after fatal"))).toThrow("poisoned");
      } finally { f.close(); }
    }
  });

  test("r_nobind uses the live source integer at binding and waits for the dlight marker", () => {
    const f = fixture();
    try {
      const cvars = bindingCvars(f, "1");
      const requested = f.images.create(source("requested", 2, 2, [255, 0, 0, 255]));
      f.images.create(source("sentinel"));
      draw(f.renderer, quad({ kind: "bind-image", image: requested }));
      expect(f.integer(0x8069)).toBe(1024 + requested.ordinal); expect(center(f.renderer)).toEqual([255, 0, 0, 255]);
      const dlight = f.images.create(source("*dlight", 2, 2, [0, 255, 0, 255]));
      f.images.setDlightImage(dlight);
      expect(f.integer(0x8069)).toBe(0);
      draw(f.renderer, quad({ kind: "bind-image", image: requested }));
      expect(f.integer(0x8069)).toBe(0); expect(f.inspect(0).width).toBe(0);
      const prepared = f.renderer.prepareGeometry(quad({ kind: "bind-image", image: requested }));
      cvars.set("r_nobind", "0.75", true);
      prepared.begin(); prepared.applyTexture(0, { kind: "bind-image", image: requested }); prepared.draw(); prepared.cleanup();
      expect(f.integer(0x8069)).toBe(1024 + requested.ordinal); expect(center(f.renderer)).toEqual([255, 0, 0, 255]);
      for (const value of ["1", "0", "-1", "0"]) {
        cvars.set("r_nobind", value, true);
        draw(f.renderer, quad({ kind: "bind-image", image: requested }));
        expect(f.integer(0x8069)).toBe(1024 + (value === "0" ? requested : dlight).ordinal);
        expect(center(f.renderer)).toEqual(value === "0" ? [255, 0, 0, 255] : [0, 255, 0, 255]);
      }
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("startup r_nobind preserves built-in creation order in live delivery and replay", () => {
    const images = new RendererImageCatalog(), first = fixture(images);
    bindingCvars(first, "1");
    let builtins: BuiltinImages;
    try {
      builtins = new BuiltinImages(images, identityImageUploadProfile);
      const dlight = builtins.find("*dlight");
      if (dlight === undefined) throw new Error("Missing built-in dlight");
      expect(first.integer(0x8069)).toBe(0);
      expect([first.inspect(1024 + builtins.defaultImage.ordinal).width, first.inspect(1024 + dlight.image.ordinal).width]).toEqual([16, 16]);
      expect(first.inspect(1024 + builtins.fogImage.ordinal).width).toBe(0);
      const zero = first.inspect(0);
      expect([zero.width, zero.height, zero.format]).toEqual([256, 32, 0x8058]);
      expect(zero.border).toEqual([1, 1, 1, 1]); expect(Array.from(zero.pixels.slice(0, 4))).toEqual([255, 255, 255, 0]);
      expect(Array.from(first.inspect(1024 + dlight.image.ordinal).pixels.slice(0, 4))).toEqual([0, 0, 0, 255]);
      expect(first.gl.glGetError()).toBe(0);
    } finally { first.close(); }
    const replay = fixture(images);
    try {
      const dlight = builtins.find("*dlight");
      if (dlight === undefined) throw new Error("Missing built-in dlight");
      expect(replay.integer(0x8069)).toBe(0);
      expect([replay.inspect(1024 + builtins.defaultImage.ordinal).width, replay.inspect(1024 + dlight.image.ordinal).width]).toEqual([16, 16]);
      expect(replay.inspect(1024 + builtins.fogImage.ordinal).width).toBe(0);
      const zero = replay.inspect(0);
      expect([zero.width, zero.height, zero.format]).toEqual([256, 32, 0x8058]);
      expect(zero.border).toEqual([1, 1, 1, 1]); expect(Array.from(zero.pixels.slice(0, 4))).toEqual([255, 255, 255, 0]);
      expect(Array.from(replay.inspect(1024 + dlight.image.ordinal).pixels.slice(0, 4))).toEqual([0, 0, 0, 255]);
      expect(replay.gl.glGetError()).toBe(0);
    } finally { replay.close(); }
  });

  for (const registrationUnit of [0, 1] satisfies readonly (0 | 1)[]) test(`r_nobind creation on unit ${registrationUnit} changes dlight storage and leaves the requested object incomplete`, () => {
    const f = fixture();
    try {
      const cvars = bindingCvars(f), dlight = f.images.create(source("*dlight", 2, 2, [0, 0, 255, 255]));
      f.images.setDlightImage(dlight); f.images.create(source("sentinel"));
      cvars.set("r_nobind", "1", true);
      const requested = f.images.create({ ...source("requested", 1, 1, [0, 255, 0, 255]), mipmap: true,
        sampling: { wrap: "clamp", filter: "nearest" }, registrationUnit });
      expect(f.integer(0x84e0)).toBe(0x84c0); expect(f.integer(0x8069)).toBe(0);
      const selected = f.inspect(1024 + dlight.ordinal);
      expect([selected.width, selected.height, selected.format, selected.wrap, selected.filter]).toEqual([1, 1, 0x8058, 0x2900, 0x2600]);
      expect(Array.from(selected.pixels)).toEqual([0, 255, 0, 255]);
      expect(f.inspect(1024 + requested.ordinal).width).toBe(0);
      const batch = registrationUnit === 0 ? quad({ kind: "retain-current-texture" })
        : pairedQuad({ kind: "retain-current-texture" }, { kind: "retain-current-texture" });
      const prepared = f.renderer.prepareGeometry(batch);
      prepared.begin(); prepared.applyTexture(0, { kind: "retain-current-texture" });
      if (registrationUnit === 1) prepared.applyTexture(1, { kind: "retain-current-texture" });
      f.images.setTextureMode("GL_LINEAR");
      expect(f.integer(0x84e0)).toBe(0x84c0 + registrationUnit); expect(f.integer(0x8069)).toBe(0);
      expect(f.inspect(0).filter).toBe(0x2601); expect(f.inspect(1024 + dlight.ordinal).filter).toBe(0x2600);
      applyUpload(f.renderer, upload(requested, 1, 1, [255, 0, 0, 255], true));
      expect(f.integer(0x8069)).toBe(0); expect(f.inspect(0).width).toBe(0); expect(f.gl.glGetError()).toBe(0x501);
      expect(Array.from(f.inspect(1024 + dlight.ordinal).pixels)).toEqual([0, 255, 0, 255]);
      prepared.draw(); prepared.cleanup(); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("r_nobind raw resize retains requested scratch dimensions while changing selected storage", () => {
    const f = fixture();
    try {
      const cvars = bindingCvars(f), dlight = f.images.create(source("*dlight", 2, 2, [0, 0, 255, 255]));
      f.images.setDlightImage(dlight);
      const scratch = f.images.create(source("scratch", 4, 4, [255, 0, 0, 64]));
      f.images.create(source("sentinel")); cvars.set("r_nobind", "1", true);
      applyUpload(f.renderer, upload(scratch, 2, 2, [0, 255, 0, 0], false));
      const selected = f.inspect(1024 + dlight.ordinal);
      expect([selected.width, selected.height, selected.format]).toEqual([2, 2, 0x8051]);
      expect(Array.from(selected.pixels.slice(0, 4))).toEqual([0, 255, 0, 255]);
      expect(f.inspect(1024 + scratch.ordinal).pixels).toEqual(pixels(4, 4, [255, 0, 0, 64]));
      cvars.set("r_nobind", "0", true);
      applyUpload(f.renderer, upload(scratch, 2, 2, [255, 255, 0, 32], true));
      const requested = f.inspect(1024 + scratch.ordinal);
      expect([requested.width, requested.height, requested.format]).toEqual([4, 4, 0x8058]);
      expect(Array.from(requested.pixels.slice(0, 4))).toEqual([255, 255, 0, 32]);
      expect(Array.from(requested.pixels.slice(8, 12))).toEqual([255, 0, 0, 64]);
      cvars.set("r_nobind", "1", true);
      applyUpload(f.renderer, upload(scratch, 2, 2, [0, 0, 255, 255], false));
      expect(f.inspect(1024 + dlight.ordinal).pixels).toEqual(selected.pixels);
      cvars.set("r_nobind", "0", true);
      applyUpload(f.renderer, upload(dlight, 4, 4, [255, 255, 255, 0], false));
      expect(f.inspect(1024 + dlight.ordinal).pixels).toEqual(pixels(4, 4, [255, 255, 255, 255]));
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("r_nobind is sampled by both texture slots and cinematic uploads retain each requested image", () => {
    const f = fixture();
    try {
      const cvars = bindingCvars(f), dlight = f.images.create(source("*dlight", 2, 2, [0, 255, 0, 255]));
      f.images.setDlightImage(dlight);
      const a = f.images.create({ ...source("a", 1, 1, [255, 0, 0, 255]), mipmap: true });
      const b = f.images.create({ ...source("b", 1, 1, [0, 0, 255, 255]), mipmap: true });
      const pair = pairedQuad({ kind: "bind-image", image: a }, { kind: "bind-image", image: b });
      const mixed = f.renderer.prepareGeometry(pair); mixed.begin();
      cvars.set("r_nobind", "1", true); mixed.applyTexture(0, { kind: "bind-image", image: a });
      expect(f.integer(0x8069)).toBe(1024 + dlight.ordinal);
      cvars.set("r_nobind", "0", true); mixed.applyTexture(1, { kind: "bind-image", image: b });
      expect(f.integer(0x84e0)).toBe(0x84c1); expect(f.integer(0x8069)).toBe(1024 + b.ordinal);
      mixed.draw(); expect(center(f.renderer)).toEqual([0, 0, 255, 255]); mixed.cleanup();
      const cinematic = f.renderer.prepareGeometry(pair); cinematic.begin(); cvars.set("r_nobind", "1", true);
      cinematic.applyTexture(0, { kind: "cinematic-upload", upload: upload(a, 2, 2, [255, 0, 0, 0], false) });
      expect(f.integer(0x8069)).toBe(1024 + dlight.ordinal);
      cinematic.applyTexture(1, { kind: "cinematic-upload", upload: upload(b, 1, 1, [0, 0, 255, 0], true) });
      expect(f.integer(0x84e0)).toBe(0x84c1); expect(f.integer(0x8069)).toBe(1024 + dlight.ordinal);
      const selected = f.inspect(1024 + dlight.ordinal);
      expect([selected.width, selected.height, selected.format]).toEqual([2, 2, 0x8051]);
      expect(Array.from(selected.pixels)).toEqual([0, 0, 255, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
      f.images.setTextureMode("GL_LINEAR");
      expect(f.integer(0x84e0)).toBe(0x84c1); expect(f.integer(0x8069)).toBe(1024 + dlight.ordinal);
      expect(f.inspect(1024 + dlight.ordinal).filter).toBe(0x2601);
      expect(f.inspect(1024 + a.ordinal).filter).toBe(0x2600); expect(f.inspect(1024 + b.ordinal).filter).toBe(0x2600);
      cinematic.draw(); cinematic.cleanup(); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("r_nobind applies to immediate source white-image binding", () => {
    const f = fixture();
    try {
      const cvars = bindingCvars(f), dlight = f.images.create(source("*dlight", 2, 2, [0, 255, 0, 255]));
      f.images.setDlightImage(dlight);
      const requested = f.images.create(source("white", 2, 2, [255, 255, 255, 255]));
      for (const value of ["1", "0"]) {
        cvars.set("r_nobind", value, true);
        f.renderer.drawImmediate({ kind: "entity-axis", whiteImage: requested, positions: [
          { x: -1, y: 0, z: 0, w: 1 }, { x: 1, y: 0, z: 0, w: 1 },
          { x: 0, y: -1, z: 0, w: 1 }, { x: 0, y: 1, z: 0, w: 1 },
          { x: 0, y: 0, z: -1, w: 1 }, { x: 0, y: 0, z: 1, w: 1 },
        ] });
        expect(f.integer(0x8069)).toBe(1024 + (value === "0" ? requested : dlight).ordinal);
        draw(f.renderer, quad({ kind: "retain-current-texture" }));
        expect(center(f.renderer)).toEqual(value === "0" ? [255, 255, 255, 255] : [0, 255, 0, 255]);
      }
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("one catalog mirrors creations into distinct contexts without cloning dynamic object-zero storage", () => {
    const images = new RendererImageCatalog();
    const firstWindow = SdlWindow.open({ title: "Image mirror first", width: 8, height: 8, backend: "gl", hidden: true });
    const secondWindow = SdlWindow.open({ title: "Image mirror second", width: 8, height: 8, backend: "gl", hidden: true });
    const first = new GlRenderer(firstWindow, images), second = new GlRenderer(secondWindow, images), session = images.openSession();
    initialize(first); initialize(second);
    session.attach(first); session.attach(second); session.beginExecution();
    try {
      const a = images.create(source("a", 2, 2, [255, 0, 0, 255])), b = images.create(source("b"));
      draw(first, quad({ kind: "bind-image", image: a }));
      applyUpload(second, upload(b, 1, 1, [0, 0, 255, 0], false));
      draw(second, quad({ kind: "retain-current-texture" }));
      expect(center(first)).toEqual([255, 0, 0, 255]); expect(center(second)).toEqual([0, 0, 255, 255]);
      images.create(source("later"));
      draw(first, quad({ kind: "retain-current-texture" })); draw(second, quad({ kind: "retain-current-texture" }));
      expect(center(first)).toEqual([255, 255, 255, 255]); expect(center(second)).toEqual([0, 0, 255, 255]);
    } finally { session.close(); first.close(); second.close(); firstWindow.close(); secondWindow.close(); }
  });

  test("fog border and cinematic resize target object zero while named creation remains unchanged", () => {
    const f = fixture();
    try {
      const image = f.images.create(source("fog"));
      f.images.setCurrentBorderColor(white);
      expect(f.integer(0x8069)).toBe(0);
      expect(f.inspect(1024 + image.ordinal).border).toEqual([0, 0, 0, 0]);
      expect(f.inspect(0).border).toEqual([1, 1, 1, 1]);
      applyUpload(f.renderer, upload(image, 4, 4, [0, 255, 0, 0], false));
      const zero = f.inspect(0), named = f.inspect(1024 + image.ordinal);
      expect([zero.width, zero.height, zero.format, zero.wrap, zero.filter]).toEqual([4, 4, 0x8051, 0x2900, 0x2601]);
      expect(zero.border).toEqual([1, 1, 1, 1]); expect(Array.from(zero.pixels.slice(0, 4))).toEqual([0, 255, 0, 255]);
      expect([named.width, named.height, named.format]).toEqual([2, 2, 0x8058]);
      expect(Array.from(named.pixels.slice(0, 4))).toEqual([255, 0, 0, 64]);
      draw(f.renderer, quad({ kind: "bind-image", image }));
      expect(f.integer(0x8069)).toBe(0); expect(center(f.renderer)).toEqual([0, 255, 0, 255]);
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("clean cinematic is bind-only and dirty subimage preserves existing object format and parameters", () => {
    const f = fixture();
    try {
      const a = f.images.create(source("a")), b = f.images.create(source("b", 2, 2, [0, 0, 255, 255]));
      draw(f.renderer, quad({ kind: "bind-image", image: a }));
      f.images.setCurrentBorderColor({ x: 0.25, y: 0.5, z: 0.75, w: 1 });
      applyUpload(f.renderer, upload(a, 2, 2, [0, 255, 0, 32], false));
      expect(Array.from(f.inspect(1024 + a.ordinal).pixels.slice(0, 4))).toEqual([255, 0, 0, 64]);
      applyUpload(f.renderer, upload(a, 2, 2, [0, 255, 0, 32], true));
      const actual = f.inspect(1024 + a.ordinal);
      expect([actual.format, actual.wrap, actual.filter]).toEqual([0x8058, 0x2901, 0x2600]);
      expect(actual.border).toEqual([0.25, 0.5, 0.75, 1]); expect(Array.from(actual.pixels.slice(0, 4))).toEqual([0, 255, 0, 32]);
      draw(f.renderer, quad({ kind: "bind-image", image: b })); expect(center(f.renderer)).toEqual([0, 0, 255, 255]);
      draw(f.renderer, quad({ kind: "bind-image", image: a })); expect(center(f.renderer)).toEqual([0, 255, 0, f.alpha(32)]);
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("incomplete and undersized current object reject dirty subimages without consuming native errors", () => {
    const f = fixture();
    try {
      const first = f.images.create(source("first"));
      expect(() => applyUpload(f.renderer, upload(first, 2, 2, [0, 255, 0, 255], true))).not.toThrow();
      expect(f.gl.glGetError()).toBe(0x501); expect(f.inspect(0).width).toBe(0);
      applyUpload(f.renderer, upload(first, 1, 1, [1, 2, 3, 4], false));
      const large = f.images.create(source("large", 4, 4));
      expect(() => applyUpload(f.renderer, upload(large, 4, 4, [255, 255, 255, 255], true))).not.toThrow();
      expect(f.gl.glGetError()).toBe(0x501);
      const zero = f.inspect(0);
      expect([zero.width, zero.height]).toEqual([1, 1]); expect(Array.from(zero.pixels)).toEqual([1, 2, 3, 255]);
      expect(Array.from(f.inspect(1024 + large.ordinal).pixels.slice(0, 4))).toEqual([255, 0, 0, 64]);
    } finally { f.close(); }
  });

  test("unit-one creation restores unit zero and raw upload retains current unit one", () => {
    const f = fixture();
    try {
      const a = f.images.create(source("a")), sentinel = f.images.create(source("sentinel"));
      draw(f.renderer, quad({ kind: "bind-image", image: a }));
      const b = f.images.create({ ...source("lightmap"), registrationUnit: 1 });
      expect(f.integer(0x84e0)).toBe(0x84c0); expect(f.integer(0x8069)).toBe(1024 + a.ordinal);
      const single = quad({ kind: "retain-current-texture" });
      const pair: DrawBatch = { ...single, texturing: "pair", vertices: single.vertices.map(vertex => ({ ...vertex, texCoord2: { x: 0.5, y: 0.5 } })),
        secondTexture: { binding: { kind: "retain-current-texture" }, environment: "modulate" } };
      const prepared = f.renderer.prepareGeometry(pair); prepared.begin();
      prepared.applyTexture(0, { kind: "retain-current-texture" }); prepared.applyTexture(1, { kind: "retain-current-texture" });
      expect(f.integer(0x84e0)).toBe(0x84c1); expect(f.integer(0x8069)).toBe(0);
      applyUpload(f.renderer, upload(b, 1, 1, [7, 8, 9, 0], false));
      expect(f.integer(0x84e0)).toBe(0x84c1); expect(f.integer(0x8069)).toBe(0);
      expect(Array.from(f.inspect(0).pixels)).toEqual([7, 8, 9, 255]);
      prepared.draw(); prepared.cleanup(); expect(f.integer(0x84e0)).toBe(0x84c0);
      draw(f.renderer, quad({ kind: "bind-image", image: sentinel }));
      expect(Array.from(f.inspect(0).pixels)).toEqual([7, 8, 9, 255]);
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("RGB8 clamp borders ignore border alpha and secondary REPLACE retains previous alpha", () => {
    const f = fixture();
    try {
      const sampling: TextureSampling = { wrap: "clamp", filter: "linear" };
      const rgb = f.images.create({ ...source("rgb", 1, 1, [255, 0, 0, 0]), internalFormat: "rgb8", sampling });
      f.images.create(source("other"));
      draw(f.renderer, quad({ kind: "bind-image", image: rgb }, 0.5, 0));
      const edge = center(f.renderer); expect(edge[0]).toBeGreaterThanOrEqual(63); expect(edge[0]).toBeLessThanOrEqual(65);
      expect(edge[3]).toBeGreaterThanOrEqual(f.alpha(127)); expect(edge[3]).toBeLessThanOrEqual(f.alpha(128));
      const single = quad({ kind: "retain-current-texture" }, 0.5);
      const pair: DrawBatch = { ...single, texturing: "pair", vertices: single.vertices.map(vertex => ({ ...vertex, texCoord2: { x: 0.5, y: 0.5 } })),
        secondTexture: { binding: { kind: "bind-image", image: rgb }, environment: "replace" } };
      draw(f.renderer, pair);
      const replaced = center(f.renderer);
      expect(replaced.slice(0, 3)).toEqual([255, 0, 0]);
      expect(replaced[3]).toBeGreaterThanOrEqual(f.alpha(127)); expect(replaced[3]).toBeLessThanOrEqual(f.alpha(128)); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("preparation is device-state free and owns geometry until its one-shot draw", () => {
    const f = fixture();
    try {
      const image = f.images.create(source("image", 1, 1, [0, 255, 0, 255])); f.images.create(source("other"));
      const batch = quad({ kind: "bind-image", image }), before = f.integer(0x8069), prepared = f.renderer.prepareGeometry(batch);
      expect(f.integer(0x8069)).toBe(before);
      for (const vertex of batch.vertices) Object.assign(vertex.position, { x: 100, y: 100 });
      prepared.begin(); prepared.applyTexture(0, { kind: "bind-image", image }); prepared.draw(); prepared.cleanup();
      expect(center(f.renderer)).toEqual([0, 255, 0, 255]); expect(() => prepared.begin()).toThrow("already begun");
      const foreign = new RendererImageCatalog().create(source("foreign"));
      expect(() => f.renderer.prepareGeometry(quad({ kind: "bind-image", image: foreign }))).toThrow("another catalog");
      let preparations = 0;
      const cinematic = { image, prepareAtExecution: () => { preparations++; return null; } };
      f.renderer.prepareGeometry(quad({ kind: "shader-cinematic", source: cinematic }));
      expect(preparations).toBe(0);
      expect(() => f.renderer.prepareGeometry(quad({ kind: "shader-cinematic", source: { ...cinematic, image: foreign } }))).toThrow("another catalog");
      expect(preparations).toBe(0);
      expect(() => f.renderer.prepareGeometry({ ...quad({ kind: "bind-image", image }), indices: [0, 1, 9] })).toThrow("out of range");
      expect(f.integer(0x8069)).toBe(1024 + image.ordinal); expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("raw draw restores full 2D viewport every time and leaves the window owned by its caller", () => {
    const f = fixture();
    try {
      const image = f.images.create(source("raw"));
      f.renderer.beginView({ viewport: { x: 3, y: 3, width: 1, height: 1 }, clear: null });
      const raw = f.renderer.prepareRawGeometry({ rect: { x: 0, y: 0, width: 8, height: 8 }, uploadWidth: 1, uploadHeight: 1, identityLight: 0.5 });
      f.renderer.finish(); raw.uploadCurrent(upload(image, 1, 1, [255, 0, 0, 0], true)); raw.draw();
      for (const value of [center(f.renderer), Array.from(f.renderer.readPixels().slice(0, 4))]) {
        expect(value[0]).toBeGreaterThanOrEqual(127); expect(value[0]).toBeLessThanOrEqual(128);
        expect(value.slice(1)).toEqual([0, 0, 255]);
      }
      expect(f.gl.glGetError()).toBe(0);
      f.renderer.close(); expect(f.window.drawableSize).toEqual({ width: 8, height: 8 });
      const replacement = new GlRenderer(f.window, new RendererImageCatalog());
      initialize(replacement);
      replacement.close();
      f.window.swap();
    } finally { f.close(); }
  });

  test("same-window restart resets native selectors and state, preserves object zero, and rejects retired work", () => {
    const f = fixture();
    const images = new RendererImageCatalog(), session = images.openSession();
    let replacement: GlRenderer | null = null;
    try {
      expect(() => new GlRenderer(f.window, images)).toThrow("active GL renderer");
      const image = f.images.create(source("old"));
      f.images.setCurrentBorderColor({ x: 0.25, y: 0.5, z: 0.75, w: 1 });
      applyUpload(f.renderer, upload(image, 1, 1, [0, 255, 0, 0], false));
      const zero = f.inspect(0);
      const stale = f.renderer.prepareGeometry(quad({ kind: "retain-current-texture" }));
      const single = quad({ kind: "retain-current-texture" });
      const pair: DrawBatch = { ...single, texturing: "pair", vertices: single.vertices.map(vertex => ({ ...vertex, texCoord2: { x: 0.5, y: 0.5 } })),
        secondTexture: { binding: { kind: "retain-current-texture" }, environment: "replace" } };
      const begun = f.renderer.prepareGeometry(pair);
      begun.begin(); begun.applyTexture(0, { kind: "retain-current-texture" }); begun.applyTexture(1, { kind: "retain-current-texture" });
      begun.draw();
      expect(f.integer(0x84e0)).toBe(0x84c1); expect(f.integer(0x84e1)).toBe(0x84c1);
      const raw = f.renderer.prepareRawGeometry({ rect: { x: 0, y: 0, width: 8, height: 8 }, uploadWidth: 1, uploadHeight: 1, identityLight: 1 });
      f.renderer.close();
      expect(f.integer(0x84e0)).toBe(0x84c0); expect(f.integer(0x84e1)).toBe(0x84c0);
      expect(f.inspect(1024 + image.ordinal).width).toBe(0);
      replacement = new GlRenderer(f.window, images);
      initialize(replacement);
      session.attach(replacement); session.beginExecution();
      expect(f.integer(0x84e0)).toBe(0x84c0); expect(f.integer(0x84e1)).toBe(0x84c0);
      expect(f.inspect(0)).toEqual(zero);
      expect(() => stale.begin()).toThrow("closed");
      expect(() => begun.cleanup()).toThrow("closed");
      expect(() => raw.uploadCurrent(upload(image, 1, 1, [0, 0, 255, 255], true))).toThrow("closed");
      expect(() => f.renderer.applyImageResource({ kind: "current-border-color", color: white })).toThrow("closed");
      f.renderer.close();
      expect(() => new GlRenderer(f.window, images)).toThrow("active GL renderer");
      replacement.beginView({ viewport: { x: 0, y: 0, width: 8, height: 8 }, clear: { stencil: false, depth: 1, color: black } });
      draw(replacement, quad({ kind: "retain-current-texture" }));
      expect(center(replacement)).toEqual([0, 255, 0, 255]);
      const fresh = images.create(source("new", 1, 1, [0, 0, 255, 255]));
      expect(fresh.ordinal).toBe(image.ordinal);
      draw(replacement, quad({ kind: "bind-image", image: fresh }));
      expect(f.integer(0x8069)).toBe(0); expect(center(replacement)).toEqual([0, 255, 0, 255]);
      images.create(source("next"));
      draw(replacement, quad({ kind: "bind-image", image: fresh }));
      expect(center(replacement)).toEqual([0, 0, 255, 255]);
      expect(f.gl.glGetError()).toBe(0);
    } finally { session.close(); replacement?.close(); f.close(); }
  });

  test("constructor failures release the context claim before a later attempt", () => {
    const window = SdlWindow.open({ title: "GL restart after failed initialization", width: 8, height: 8, backend: "gl", hidden: true });
    Object.defineProperty(window, "drawableSize", { configurable: true, get: () => { throw new Error("attribute query failed"); } });
    try {
      expect(() => new GlRenderer(window, new RendererImageCatalog())).toThrow("attribute query failed");
      Reflect.deleteProperty(window, "drawableSize");
      const renderer = new GlRenderer(window, new RendererImageCatalog());
      initialize(renderer);
      renderer.close(); window.close();
      expect(() => new GlRenderer(window, new RendererImageCatalog())).toThrow("closed");
      expect(() => new GlRenderer(window, new RendererImageCatalog())).toThrow("closed");
    } finally { Reflect.deleteProperty(window, "drawableSize"); window.close(); }
  });
});
