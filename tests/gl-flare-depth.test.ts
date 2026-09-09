// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { SdlWindow } from "../src/platform/sdl.ts";
import { loadGl } from "../src/platform/gl.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import type { SingleTextureBatch } from "../src/render/types.ts";
import { executeStaticBatch } from "./render-target-fixture.ts";

const viewport = { x: 0, y: 0, width: 16, height: 16 };
const clear = { depth: 1, stencil: false, color: { x: 0, y: 0, z: 0, w: 1 } };
const triangle: SingleTextureBatch = {
  primitive: "triangles", texturing: "single", texture: { kind: "retain-current-texture" },
  state: { ...OPAQUE_STATE, cull: "none" }, indices: [0, 1, 2],
  vertices: [
    { position: { x: -1, y: -1, z: -0.5, w: 1 }, color: { x: 1, y: 0, z: 0, w: 1 }, texCoord: { x: 0, y: 0 } },
    { position: { x: 1, y: -1, z: -0.5, w: 1 }, color: { x: 1, y: 0, z: 0, w: 1 }, texCoord: { x: 0, y: 0 } },
    { position: { x: -1, y: 1, z: -0.5, w: 1 }, color: { x: 1, y: 0, z: 0, w: 1 }, texCoord: { x: 0, y: 0 } },
  ],
};

function withRenderer(action: (renderer: GlRenderer, gl: ReturnType<typeof loadGl>["symbols"]) => void): void {
  const window = SdlWindow.open({ title: "Flare depth test", width: 16, height: 16, backend: "gl", hidden: true });
  const renderer = new GlRenderer(window, new RendererImageCatalog()), library = loadGl(window);
  try {
    renderer.initializeDefaultState(renderer.capabilities.textureUnits > 1, () => {});
    renderer.beginView({ viewport, clear });
    action(renderer, library.symbols);
  } finally { library.close(); renderer.close(); window.close(); }
}

describe.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("system GL flare depth", () => {
  test("reads actual depth at absolute bottom-left pixels with retained pack and draw state", () => withRenderer((renderer, gl) => {
    expect(renderer.readDepthPixel(2, 2)).toBe(1);
    renderer.beginView({ viewport: { x: 4, y: 3, width: 8, height: 8 }, clear });
    executeStaticBatch(renderer, triangle);
    expect(renderer.readDepthPixel(5, 6)).toBeCloseTo(0.25, 6);
    expect(renderer.readDepthPixel(5, 12)).toBe(1);
    expect(renderer.readDepthPixel(2, 2)).toBe(1);
    gl.glPixelStorei(0xd05, 8); gl.glPixelStorei(0xd02, 37);
    gl.glDepthRange(0.125, 0.75);
    expect(renderer.readDepthPixel(5, 6)).toBeCloseTo(0.25, 6);
    const integer = new Int32Array(1), range = new Float32Array(2);
    gl.glGetIntegerv(0xd05, integer); expect(integer[0]).toBe(8);
    gl.glGetIntegerv(0xd02, integer); expect(integer[0]).toBe(37);
    gl.glGetFloatv(0xb70, range); expect(Array.from(range)).toEqual([0.125, 0.75]);
    for (const name of [0xd03, 0xd04]) {
      gl.glPixelStorei(name, 1);
      expect(() => renderer.readDepthPixel(5, 6)).toThrow("pixel-pack state");
      gl.glGetIntegerv(name, integer); expect(integer[0]).toBe(1);
      gl.glPixelStorei(name, 0);
    }
    gl.glPixelStorei(0xd02, 0); gl.glPixelStorei(0xd05, 4);
    expect(() => renderer.readDepthPixel(-1, 0)).toThrow("coordinates");
    expect(() => renderer.readDepthPixel(16, 0)).toThrow("coordinates");
    expect(() => renderer.readDepthPixel(0, 0.5)).toThrow("coordinates");
    expect(gl.glGetError()).toBe(0);
    renderer.close(); expect(() => renderer.readDepthPixel(0, 0)).toThrow("closed");
  }));

  test("flare clip disable persists through retained views and a new portal enables clipping", () => withRenderer((renderer, gl) => {
    const portal = { kind: "portal", eyePlane: { x: 1, y: 0, z: 0, w: 0 }, projection: [1, 1, -1, -2] } satisfies NonNullable<Parameters<GlRenderer["beginView"]>[0]["clipPlane"]>;
    renderer.beginView({ viewport, clear, clipPlane: portal });
    executeStaticBatch(renderer, triangle);
    expect(renderer.readDepthPixel(2, 2)).toBe(1);
    expect(gl.glIsEnabled(0x3000)).toBe(1);
    renderer.drawImmediate({ kind: "disable-portal-clip" });
    expect(gl.glIsEnabled(0x3000)).toBe(0);
    renderer.beginView({ viewport, clear, clipPlane: { kind: "retain", projection: portal.projection } });
    expect(gl.glIsEnabled(0x3000)).toBe(0);
    executeStaticBatch(renderer, triangle);
    expect(renderer.readDepthPixel(2, 2)).toBeCloseTo(0.25, 6);
    renderer.beginView({ viewport, clear, clipPlane: portal });
    expect(gl.glIsEnabled(0x3000)).toBe(1);
    executeStaticBatch(renderer, triangle);
    expect(renderer.readDepthPixel(2, 2)).toBe(1);
    expect(gl.glGetError()).toBe(0);
  }));

  test("reads from its owned current context", () => withRenderer(first => {
    executeStaticBatch(first, triangle);
    withRenderer(second => {
      expect(first.readDepthPixel(2, 2)).toBeCloseTo(0.25, 6);
      expect(second.readDepthPixel(2, 2)).toBe(1);
      expect(first.readDepthPixel(2, 2)).toBeCloseTo(0.25, 6);
    });
  }));
});
