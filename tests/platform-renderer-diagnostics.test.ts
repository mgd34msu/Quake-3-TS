import { describe, expect, test } from "bun:test";
import { applyAppleTransformHint, GlCallErrorDiagnostics } from "../src/render/platform-diagnostics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { finishImplicitShader } from "../src/render/material-finish.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import { SceneModelRegistry } from "../src/render/scene-models.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { loadGl } from "../src/platform/gl.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { createCheckedGlCalls } from "../src/render/gl/logging.ts";

function fixture() {
  const diagnostics: string[] = [], printed: string[] = [], calls: string[] = [];
  let enabled = true;
  const errors = new GlCallErrorDiagnostics({ enabled: () => enabled,
    print: text => { printed.push(text); }, writeDiagnostic: text => { diagnostics.push(text); } });
  return { diagnostics, printed, calls, errors, setEnabled(value: boolean) { enabled = value; } };
}

describe("Mac per-call GL diagnostics", () => {
  test("forwards arguments and results before reading one error", () => {
    const state = fixture(), returned = { value: 7 };
    const call = state.errors.wrap("glExample", (value: number, flag: boolean) => {
      state.calls.push(`call:${value}:${flag}`); return returned;
    }, () => { state.calls.push("error"); return 0x0502; });
    expect(call(41, true)).toBe(returned);
    expect(state.calls).toEqual(["call:41:true", "error"]);
    expect(state.diagnostics).toEqual(["BREAK ON QGLErrorBreak to stop at the GL errors\n",
      "OpenGL Error(glExample): 0x0502 -- invalid operation\n"]);
  });

  test("defers error reads inside Begin and checks after End", () => {
    const state = fixture();
    const getError = () => { state.calls.push("error"); return 0; };
    const begin = state.errors.wrap("glBegin", () => { state.calls.push("begin"); }, getError);
    const vertex = state.errors.wrap("glVertex2f", () => { state.calls.push("vertex"); }, getError);
    const end = state.errors.wrap("glEnd", () => { state.calls.push("end"); }, getError);
    begin(); vertex(); end();
    expect(state.calls).toEqual(["begin", "vertex", "end", "error"]);
    expect(state.diagnostics).toEqual([]);
  });

  test("runtime enable changes retain Begin nesting", () => {
    const state = fixture();
    const getError = () => { state.calls.push("error"); return 0; };
    state.setEnabled(false);
    state.errors.wrap("glBegin", () => undefined, getError)();
    state.setEnabled(true);
    state.errors.wrap("glVertex2f", () => undefined, getError)();
    expect(state.calls).toEqual([]);
    state.errors.wrap("glEnd", () => undefined, getError)();
    expect(state.calls).toEqual(["error"]);
  });

  test("the explicit EndFrame check reads even inside an unmatched Begin", () => {
    const state = fixture();
    const getError = () => { state.calls.push("error"); return 0x0502; };
    state.errors.wrap("glBegin", () => undefined, getError)();
    expect(state.calls).toEqual([]);
    state.errors.check("GLimp_EndFrame", getError);
    expect(state.calls).toEqual(["error"]);
    expect(state.diagnostics[1]).toBe("OpenGL Error(GLimp_EndFrame): 0x0502 -- invalid operation\n");
  });

  test("reports 100 errors and one suppression while continuing to consume", () => {
    const state = fixture();
    let reads = 0;
    const call = state.errors.wrap("glEnable", () => undefined, () => { reads++; return 0x0500; });
    for (let index = 0; index < 103; index++) call();
    expect(reads).toBe(103);
    expect(state.diagnostics.length).toBe(101);
    expect(state.diagnostics[100]).toBe("OpenGL Error(glEnable): 0x0500 -- invalid enumerant\n");
    expect(state.printed).toEqual(["100 GL errors printed ... disabling further error reporting.\n"]);
    state.setEnabled(false); call();
    expect(reads).toBe(103);
  });

  test("forwarded errors share the retained report limit without a second enable sample", () => {
    const state = fixture();
    state.setEnabled(false);
    state.errors.report("worker", 0);
    expect(state.diagnostics).toEqual([]);
    for (let index = 0; index < 99; index++) state.errors.report("worker", 0x0500);
    state.setEnabled(true);
    state.errors.check("main", () => 0x0502);
    state.setEnabled(false);
    state.errors.report("replacement-worker", 0x0500);
    expect(state.diagnostics.length).toBe(101);
    expect(state.diagnostics[100]).toBe("OpenGL Error(main): 0x0502 -- invalid operation\n");
    expect(state.printed).toEqual(["100 GL errors printed ... disabling further error reporting.\n"]);
  });

  test("preserves unsigned End underflow and does not inspect failed calls", () => {
    const state = fixture();
    const getError = () => { state.calls.push("error"); return 0; };
    state.errors.wrap("glEnd", () => undefined, getError)();
    state.errors.wrap("glClear", () => undefined, getError)();
    expect(state.calls).toEqual([]);
    state.errors.wrap("glBegin", () => undefined, getError)();
    expect(state.calls).toEqual(["error"]);
    const failure = new Error("native boundary failed");
    const call = state.errors.wrap("glClear", () => { throw failure; }, getError);
    expect(call).toThrow(failure);
    expect(state.calls).toEqual(["error"]);
  });
});

async function modelFixture(debugBuild: boolean, files: ReadonlyMap<string, Uint8Array> = new Map<string, Uint8Array>()) {
  const events: string[] = [];
  const images = new RendererImageCatalog(), builtins = new BuiltinImages(images, identityImageUploadProfile);
  const profile = createRendererSettings().registrationProfile(), image = builtins.defaultImage;
  const materials = new MaterialRegistry(async name => ({ definition: null, image, whiteImage: image,
    defaulted: false, sky: null, finished: finishImplicitShader({ name, profile, kind: "default",
      baseImage: { kind: "loaded", tmu: 0, binding: { kind: "images", playback: { kind: "single", image: { image } } } } }) }),
  message => { throw new Error(message); });
  const defaultMaterial = await materials.register("*default", { kind: "none" });
  const backing = withRetainedFiles({ readFileOptional: async (name: string) => {
    events.push(`read:${name}`); return files.get(name);
  } });
  const registry = new SceneModelRegistry({ ...backing, freeFile: file => {
    events.push("free"); backing.freeFile(file);
  } }, name => materials.register(name, { kind: "none" }), { kind: "unaccounted" }, defaultMaterial,
  text => { events.push(text); }, index => materials.findByHandle(index), () => { events.push("sync"); }, debugBuild);
  return { events, registry };
}

test("DEBUG failed-model warning follows the final missing LOD and is not repeated for cached failures", async () => {
  const state = await modelFixture(true);
  const model = await state.registry.registerModel("Models/Missing.md3");
  expect(state.registry.modelHandle(model)).toBe(0);
  expect(state.events).toEqual(["sync", "read:Models/Missing_2.md3", "read:Models/Missing_1.md3", "read:Models/Missing.md3",
    "^3RE_RegisterModel: couldn't load Models/Missing.md3\n"]);
  state.events.length = 0;
  expect(await state.registry.registerModel("Models/Missing.md3")).toBe(model);
  expect(state.events).toEqual([]);
  const release = await modelFixture(false);
  await release.registry.registerModel("missing.md3");
  expect(release.events).toEqual(["sync", "read:missing_2.md3", "read:missing_1.md3", "read:missing.md3"]);
});

test("DEBUG failed-model warning follows a rejected higher LOD but source goto-fail branches bypass it", async () => {
  const wrongVersion = new Uint8Array(8), header = new DataView(wrongVersion.buffer);
  header.setUint32(0, 0x33504449, true); header.setInt32(4, 14, true);
  const high = await modelFixture(true, new Map([["broken_2.md3", wrongVersion]]));
  await high.registry.registerModel("broken.md3");
  expect(high.events).toEqual(["sync", "read:broken_2.md3", "R_LoadMD3: broken.md3 has wrong version (14 should be 15)\n",
    "free", "^3RE_RegisterModel: couldn't load broken.md3\n"]);
  const low = await modelFixture(true, new Map([["broken.md3", wrongVersion]]));
  await low.registry.registerModel("broken.md3");
  expect(low.events).toEqual(["sync", "read:broken_2.md3", "read:broken_1.md3", "read:broken.md3",
    "R_LoadMD3: broken.md3 has wrong version (14 should be 15)\n", "free"]);
  const invalid = await modelFixture(true, new Map([["unknown_2.md3", new Uint8Array(4)]]));
  await invalid.registry.registerModel("unknown.md3");
  expect(invalid.events).toEqual(["sync", "read:unknown_2.md3", "RE_RegisterModel: unknown fileid for unknown.md3\n"]);
});

test("Apple transform hint registers its selector only for an advertised extension and preserves call order", () => {
  const events: string[] = [];
  let enabled = true;
  const options = {
    extensions: "GL_APPLE_transform_hint",
    enabled: () => { events.push("selector"); return enabled; },
    print: (text: string): undefined => { events.push(text); },
    gl: {
      glHint(target: number, mode: number): undefined { events.push(`hint:${target.toString(16)}:${mode.toString(16)}`); },
      glGetError(): number { events.push("error"); return 0; },
    },
  };
  applyAppleTransformHint({ ...options, extensions: "GL_ARB_multitexture" });
  expect(events).toEqual(["...GL_APPLE_transform_hint not found\n"]);
  events.length = 0;
  enabled = false;
  applyAppleTransformHint(options);
  expect(events).toEqual(["selector", "...ignoring using GL_APPLE_transform_hint\n"]);
  events.length = 0;
  enabled = true;
  applyAppleTransformHint(options);
  expect(events).toEqual(["selector", "...using GL_APPLE_transform_hint\n", "hint:85b1:1101", "error"]);
  expect(() => applyAppleTransformHint({ ...options, gl: { ...options.gl, glGetError: () => 0x0500 } }))
    .toThrow("glGetError: 0x500\n");
});

test.skipIf(process.env["QUAKE_SDL_RENDER_CONTEXT_TEST"] !== "1")("actual SDL context stays detached through backend calls and swaps while disabled", () => {
  if (process.env["SDL_VIDEODRIVER"] !== "x11" || process.env["WAYLAND_DISPLAY"] !== undefined
    || process.env["DISPLAY"] !== process.env["QUAKE_OWNED_DISPLAY"] || process.env["SDL_AUDIODRIVER"] !== "dummy")
    throw new Error("Native diagnostics require an explicitly owned Xvfb child environment");
  const window = SdlWindow.open({ title: "Renderer diagnostics", width: 8, height: 8, backend: "gl", hidden: true });
  let renderer: GlRenderer | null = null;
  let library: ReturnType<typeof loadGl> | null = null;
  const messages: string[] = [];
  const print = (text: string): undefined => { messages.push(text); };
  try {
    renderer = new GlRenderer(window, new RendererImageCatalog());
    library = loadGl(window);
    const gl = library.symbols;
    const errors = fixture(), checked = createCheckedGlCalls(gl, errors.errors, () => gl.glGetError());
    checked.glEnable(0xffffffff);
    expect(errors.diagnostics[1]).toBe("OpenGL Error(glEnable): 0x0500 -- invalid enumerant\n");
    expect(gl.glGetError()).toBe(0);
    checked.glBegin(0);
    checked.glEnable(0xffffffff);
    expect(errors.diagnostics.length).toBe(2);
    checked.glEnd();
    expect(errors.diagnostics[2]).toBe("OpenGL Error(glEnd): 0x0502 -- invalid operation\n");
    const hintMessages: string[] = [];
    let hintRequests = 0;
    renderer.initializeAppleTransformHint(() => { hintRequests++; return true; }, text => { hintMessages.push(text); });
    const appleSupported = renderer.extensions.includes("GL_APPLE_transform_hint");
    expect(hintRequests).toBe(appleSupported ? 1 : 0);
    expect(hintMessages).toEqual([appleSupported ? "...using GL_APPLE_transform_hint\n" : "...GL_APPLE_transform_hint not found\n"]);
    if (appleSupported) {
      const hint = new Int32Array(1);
      gl.glGetIntegerv(0x85b1, hint);
      expect(hint[0]).toBe(0x1101);
    }
    expect(gl.glGetError()).toBe(0);
    gl.glClearColor(0, 0, 1, 1);
    renderer.updateRenderingEnabled(0, print);
    expect(window.renderingEnabled).toBe(false);
    renderer.finish();
    gl.glClearColor(1, 0, 0, 1);
    window.swap();
    gl.glClearColor(0, 1, 0, 1);
    expect(window.renderingEnabled).toBe(false);
    renderer.updateRenderingEnabled(1, print);
    const color = new Float32Array(4);
    gl.glGetFloatv(0x0c22, color);
    expect(Array.from(color)).toEqual([0, 0, 1, 1]);
    renderer.updateRenderingEnabled(2, print);
    renderer.updateRenderingEnabled(2, print);
    expect(messages).toEqual(["--- Disabling Renderer ---\n", "--- Enabling Renderer ---\n",
      "--- Enabling Renderer ---\n", "--- Enabling Renderer ---\n"]);
    expect(gl.glGetError()).toBe(0);
  } finally {
    window.setRenderingEnabled(true);
    library?.close(); renderer?.close(); window.close();
  }
});
