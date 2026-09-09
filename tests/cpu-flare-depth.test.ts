import { expect, test } from "bun:test";
import { RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import type { DrawBatch, RenderVertex } from "../src/render/types.ts";
import { executeStaticBatch, publishTexture } from "./render-target-fixture.ts";

function fixture() {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(8, 6, images);
  const target = new RenderTarget(images, [cpu]);
  const image = publishTexture(images, { name: "flare-depth-white", width: 1, height: 1,
    pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgb8",
    sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 1 });
  return { cpu, target, image };
}

function triangle(image: RendererImage, z: number): DrawBatch {
  const vertex = (x: number, y: number): RenderVertex => ({ position: { x, y, z, w: 1 },
    color: { x: 1, y: 1, z: 1, w: 1 }, texCoord: { x: 0, y: 0 } });
  return { texturing: "single", primitive: "triangles", texture: { kind: "bind-image", image },
    vertices: [vertex(-1, 1), vertex(1, 1), vertex(-1, -1)], indices: [0, 1, 2],
    state: { ...OPAQUE_STATE, cull: "none" } };
}

test("flare depth reads actual clears and triangle writes in absolute bottom-left coordinates", () => {
  const { cpu, target, image } = fixture();
  try {
    expect(cpu.readDepthPixel(0, 0)).toBe(1);
    cpu.beginView({ viewport: { x: 2, y: 1, width: 4, height: 3 },
      clear: { color: null, depth: 0.9, stencil: false } });
    expect(cpu.readDepthPixel(2, 4)).toBe(Math.fround(0.9));
    expect(cpu.readDepthPixel(2, 5)).toBe(1);
    expect(cpu.readDepthPixel(2, 1)).toBe(1);
    executeStaticBatch(cpu, triangle(image, -0.4));
    expect(cpu.readDepthPixel(2, 4)).toBe(Math.fround(0.3));
    expect(cpu.readDepthPixel(5, 2)).toBe(Math.fround(0.9));
    executeStaticBatch(cpu, triangle(image, 0));
    expect(cpu.readDepthPixel(2, 4)).toBe(Math.fround(0.3));
    executeStaticBatch(cpu, triangle(image, -0.8));
    expect(cpu.readDepthPixel(2, 4)).toBe(Math.fround(0.1));
    cpu.beginView({ viewport: { x: 2, y: 1, width: 4, height: 3 },
      clear: { color: null, depth: 0.7, stencil: false } });
    expect(cpu.readDepthPixel(2, 4)).toBe(Math.fround(0.7));
  } finally { target.close(); }
});

test("flare depth rejects invalid coordinates and reads after close", () => {
  const { cpu, target } = fixture();
  for (const value of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER]) {
    expect(() => cpu.readDepthPixel(value, 0)).toThrow(RangeError);
    expect(() => cpu.readDepthPixel(0, value)).toThrow(RangeError);
  }
  expect(() => cpu.readDepthPixel(8, 0)).toThrow(RangeError);
  expect(() => cpu.readDepthPixel(0, 6)).toThrow(RangeError);
  expect(cpu.readDepthPixel(7, 5)).toBe(1);
  target.close();
  expect(() => cpu.readDepthPixel(0, 0)).toThrow("CPU renderer is closed");
  expect(() => cpu.drawImmediate({ kind: "disable-portal-clip" })).toThrow("CPU renderer is closed");
});

test("flare clip disable preserves depth and viewport while allowing previously clipped fragments", () => {
  const { cpu, target, image } = fixture();
  try {
    cpu.beginView({ viewport: { x: 2, y: 1, width: 4, height: 3 },
      clear: { color: null, depth: 0.9, stencil: false },
      clipPlane: { kind: "portal", eyePlane: { x: 1, y: 0, z: 0, w: 0 }, projection: [1, 1, 0, 1] } });
    executeStaticBatch(cpu, triangle(image, -0.4));
    expect(cpu.readDepthPixel(2, 4)).toBe(Math.fround(0.9));
    expect(cpu.readDepthPixel(4, 4)).toBe(Math.fround(0.3));
    cpu.drawImmediate({ kind: "disable-portal-clip" });
    expect(cpu.readDepthPixel(4, 4)).toBe(Math.fround(0.3));
    executeStaticBatch(cpu, triangle(image, 0));
    expect(cpu.readDepthPixel(2, 4)).toBe(0.5);
    expect(cpu.readDepthPixel(4, 4)).toBe(Math.fround(0.3));
    expect(cpu.readDepthPixel(0, 5)).toBe(1);
    cpu.beginView({ viewport: { x: 2, y: 1, width: 4, height: 3 },
      clear: { color: null, depth: 0.9, stencil: false },
      clipPlane: { kind: "retain", projection: [1, 1, 0, 1] } });
    executeStaticBatch(cpu, triangle(image, 0));
    expect(cpu.readDepthPixel(2, 4)).toBe(0.5);
  } finally { target.close(); }
});
