// SPDX-License-Identifier: GPL-2.0-or-later
// tr_surface.c RB_SurfaceDisplayList and tr_local.h srfDisplayList_t.
import { expect, test } from "bun:test";
import { SdlWindow } from "../src/platform/sdl.ts";
import { loadGl } from "../src/platform/gl.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { SourceTessState, sourceSurfaceDisplayList } from "../src/render/tess-state.ts";
import type { SourceDisplayListSurface } from "../src/render/tess-state.ts";
import type { SurfaceViewOperation } from "../src/render/types.ts";
import { createRendererSettings } from "./renderer-settings-fixture.ts";

const viewport = { x: 0, y: 0, width: 8, height: 8 };
const clear = { depth: 0.75, stencil: false, color: { x: 0.25, y: 0.5, z: 0.75, w: 1 } };

function commandOwner(target: RenderTarget): RenderCommandBuffer {
  return new RenderCommandBuffer(target, { clock: { milliseconds: () => 0 }, identityLight: 1,
    tess: new SourceTessState(), runtime: createRendererSettings().runtime,
    print: text => { throw new Error(`Unexpected renderer diagnostic: ${text}`); } });
}

test("display-list surface preserves the source signed-int to GLuint conversion", () => {
  for (const [input, expected] of [[0, 0], [1, 1], [-1, 0xffffffff], [-0x80000000, 0x80000000], [0x7fffffff, 0x7fffffff]]) {
    if (input === undefined || expected === undefined) throw new Error("Missing conversion fixture");
    expect(sourceSurfaceDisplayList({ kind: "display-list", listNum: input })).toEqual({ kind: "display-list", listNum: expected });
  }
  for (const listNum of [NaN, Infinity, 0.5, 0x80000000, -0x80000001])
    expect(() => sourceSurfaceDisplayList({ kind: "display-list", listNum })).toThrow("signed int32");
});

test("CPU source list namespace is empty and calls preserve pixels and depth in the reached operation order", () => {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(8, 8, images);
  const target = new RenderTarget(images, [cpu]), commands = commandOwner(target), events: string[] = [];
  const immediate = cpu.drawImmediate.bind(cpu);
  cpu.drawImmediate = operation => { immediate(operation); events.push(operation.kind); };
  const readDepth = () => Array.from({ length: 64 }, (_, index) => cpu.readDepthPixel(index % 8, Math.floor(index / 8)));
  try {
    cpu.beginView({ viewport, clear });
    const pixels = cpu.pixels.slice(), depth = readDepth();
    function* operations(): Generator<SurfaceViewOperation, void, unknown> {
      for (const listNum of [0, 1, -1]) {
        yield sourceSurfaceDisplayList({ kind: "display-list", listNum });
        expect(events.at(-1)).toBe("display-list");
        expect(cpu.pixels).toEqual(pixels); expect(readDepth()).toEqual(depth);
        events.push("continued");
      }
    }
    target.executeSurfaceOperations(operations());
    expect(events).toEqual(["display-list", "continued", "display-list", "continued", "display-list", "continued"]);
    const operation = sourceSurfaceDisplayList({ kind: "display-list", listNum: -1 });
    commands.addView({ viewport, clear, beforeView: [operation], operations: [operation] });
    expect(commands.submit().batches).toBe(0);
    expect(cpu.pixels).toEqual(pixels); expect(readDepth()).toEqual(depth);
  } finally { target.close(); }
  expect(() => cpu.drawImmediate(sourceSurfaceDisplayList({ kind: "display-list", listNum: 0 }))).toThrow("closed");
});

test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("actual GL undefined lists preserve state; a diagnostic native list executes through the source command owner", () => {
  const window = SdlWindow.open({ title: "Display-list source test", width: 8, height: 8, backend: "gl", hidden: true });
  const images = new RendererImageCatalog(), renderer = new GlRenderer(window, images);
  const target = new RenderTarget(images, [renderer]), commands = commandOwner(target), library = loadGl(window), gl = library.symbols;
  const current = new Float32Array(4), range = new Float32Array(2);
  try {
    renderer.initializeDefaultState(renderer.capabilities.textureUnits > 1, () => {});
    renderer.beginView({ viewport, clear });
    gl.glColor4f(0.25, 0.5, 0.75, 1); gl.glDepthRange(0.125, 0.875);
    const pixels = renderer.readPixels(), depth = renderer.readDepthPixel(2, 2);
    expect(gl.glGetError()).toBe(0);
    for (const listNum of [0, 1, -1]) {
      gl.glCallList(listNum >>> 0);
      const nativeError = gl.glGetError();
      target.executeSurfaceOperations([sourceSurfaceDisplayList({ kind: "display-list", listNum })]);
      expect({ listNum, error: gl.glGetError() }).toEqual({ listNum, error: nativeError });
      expect(renderer.readPixels()).toEqual(pixels); expect(renderer.readDepthPixel(2, 2)).toBe(depth);
      gl.glGetFloatv(0xb00, current); expect([...current]).toEqual([0.25, 0.5, 0.75, 1]);
      gl.glGetFloatv(0xb70, range); expect([...range]).toEqual([0.125, 0.875]);
      expect(gl.glGetError()).toBe(0);
    }
    // Only this diagnostic defines a native list. The source game has no producer.
    gl.glNewList(27, 0x1300);
    gl.glColor4f(0.75, 0.25, 0.5, 1);
    gl.glClearColor(0, 1, 0, 1); gl.glClear(0x4000);
    gl.glEndList();
    gl.glGetFloatv(0xb00, current); expect([...current]).toEqual([0.25, 0.5, 0.75, 1]);
    const surface = { kind: "display-list", listNum: 27 } satisfies SourceDisplayListSurface;
    const operation = sourceSurfaceDisplayList(surface);
    commands.addView({ viewport, clear, operations: [operation] });
    surface.listNum = 1;
    expect(commands.submit().batches).toBe(0);
    expect([...renderer.readPixels().slice(0, 4)]).toEqual([0, 255, 0, 255]);
    gl.glGetFloatv(0xb00, current); expect([...current]).toEqual([0.75, 0.25, 0.5, 1]);
    expect(renderer.readDepthPixel(2, 2)).toBeCloseTo(0.75, 6);
    expect(gl.glGetError()).toBe(0);
    gl.glDeleteLists(27, 1);
    renderer.beginView({ viewport, clear });
    target.executeSurfaceOperations([operation]);
    expect(renderer.readPixels()).toEqual(pixels);
    expect(gl.glGetError()).toBe(0);
  } finally { library.close(); target.close(); window.close(); }
  expect(() => renderer.drawImmediate(sourceSurfaceDisplayList({ kind: "display-list", listNum: 0 }))).toThrow("closed");
});
