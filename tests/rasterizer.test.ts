import { describe, expect, test } from "bun:test";
import type { Vec4 } from "../src/core/math.ts";
import { RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import type { BlendFactor, DrawBatch, RenderState, RenderVertex, TextureSampling } from "../src/render/types.ts";
import { executeStaticBatch, publishTexture } from "./render-target-fixture.ts";

const WHITE: Vec4 = { x: 1, y: 1, z: 1, w: 1 };
const RED: Vec4 = { x: 1, y: 0, z: 0, w: 1 };
const GREEN: Vec4 = { x: 0, y: 1, z: 0, w: 1 };
const BLUE: Vec4 = { x: 0, y: 0, z: 1, w: 1 };
const BLACK: Vec4 = { x: 0, y: 0, z: 0, w: 0 };
const STATE: RenderState = { ...OPAQUE_STATE, cull: "none" };
const NEAREST: TextureSampling = { wrap: "repeat", filter: "nearest" };

interface CpuFixture {
  readonly renderer: SoftwareRenderer;
  readonly target: RenderTarget;
  readonly images: RendererImageCatalog;
  readonly white: RendererImage;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}
interface PixelTexture { readonly width: number; readonly height: number; readonly pixels: Uint8Array }

function createRenderer(width: number, height: number, subpixelBits = 8): CpuFixture {
  const images = new RendererImageCatalog(), renderer = new SoftwareRenderer(width, height, images, subpixelBits);
  const target = new RenderTarget(images, [renderer]);
  const white = publishTexture(images, { name: "raster-white", width: 1, height: 1,
    pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgb8", sampling: NEAREST, registrationUnit: 1 });
  renderer.beginView({ viewport: { x: 0, y: 0, width, height }, clear: { stencil: false, color: null, depth: 1 } });
  return { renderer, target, images, white, width, height, pixels: renderer.pixels };
}
function publish(renderer: CpuFixture, texture: PixelTexture, sampling: TextureSampling = NEAREST): RendererImage {
  return publishTexture(renderer.images, { name: "raster-texture", width: texture.width, height: texture.height,
    pixels: texture.pixels, internalFormat: "rgba8", sampling, registrationUnit: 1 });
}
function clear(renderer: CpuFixture, color: Vec4, depth = 1): void {
  renderer.renderer.beginView({ viewport: { x: 0, y: 0, width: renderer.width, height: renderer.height }, clear: { stencil: false, color, depth } });
}

function vertex(x: number, y: number, color: Vec4 = WHITE, z = 0, w = 1, u = 0, v = 0): RenderVertex {
  return { position: { x, y, z, w }, color, texCoord: { x: u, y: v } };
}

function batch(renderer: CpuFixture, vertices: readonly RenderVertex[], state: RenderState = STATE,
  texture: RendererImage = renderer.white, indices: readonly number[] = [0, 1, 2]): DrawBatch {
  return { texturing: "single", primitive: "triangles", vertices, indices,
    texture: { kind: "bind-image", image: texture }, state };
}

function triangle(renderer: CpuFixture, color: Vec4, z = 0, state: RenderState = STATE): DrawBatch {
  return batch(renderer, [vertex(-1, 1, color, z), vertex(1, 1, color, z), vertex(-1, -1, color, z)], state);
}

function pixel(renderer: CpuFixture, x: number, y: number): readonly number[] {
  const offset = (y * renderer.width + x) * 4;
  return Array.from(renderer.pixels.subarray(offset, offset + 4));
}

function quad(renderer: CpuFixture, color: Vec4, state: RenderState = STATE): DrawBatch {
  return batch(renderer, [vertex(-1, 1, color), vertex(1, 1, color), vertex(1, -1, color), vertex(-1, -1, color)],
    state, renderer.white, [0, 1, 2, 0, 2, 3]);
}

function textureAt(u: number, v: number, texture: PixelTexture, sampling: TextureSampling = NEAREST): readonly number[] {
  const renderer = createRenderer(2, 2), image = publish(renderer, texture, sampling);
  executeStaticBatch(renderer.renderer, batch(renderer, [vertex(-1, 1, WHITE, 0, 1, u, v), vertex(1, 1, WHITE, 0, 1, u, v),
    vertex(-1, -1, WHITE, 0, 1, u, v)], STATE, image, [0, 1, 2]));
  const result = pixel(renderer, 0, 0); renderer.target.close(); return result;
}

describe("CPU triangle coverage and clipping", () => {
  test("pixel-center barycentrics produce analytic vertex colors", () => {
    const renderer = createRenderer(4, 4);
    executeStaticBatch(renderer.renderer, batch(renderer, [vertex(-1, 1, RED), vertex(1, 1, GREEN), vertex(-1, -1, BLUE)]));
    expect(pixel(renderer, 0, 0)).toEqual([191, 32, 32, 255]);
    expect(pixel(renderer, 1, 0)).toEqual([128, 96, 32, 255]);
    expect(pixel(renderer, 0, 1)).toEqual([128, 32, 96, 255]);
    expect(pixel(renderer, 3, 3)).toEqual([0, 0, 0, 0]);
  });

  test("lower-left rule fills two shared-edge triangles once without cracks", () => {
    const renderer = createRenderer(8, 8);
    const additive: RenderState = { ...STATE, blend: { source: "one", destination: "one" } };
    executeStaticBatch(renderer.renderer, quad(renderer, { x: 0.25, y: 0.25, z: 0.25, w: 0.25 }, additive));
    expect(Array.from(renderer.pixels)).toEqual(new Array<number>(8 * 8 * 4).fill(64));
    clear(renderer, BLACK);
    const reversed = quad(renderer, { x: 0.25, y: 0.25, z: 0.25, w: 0.25 }, additive);
    executeStaticBatch(renderer.renderer, { ...reversed, indices: [2, 1, 0, 3, 2, 0] });
    expect(Array.from(renderer.pixels)).toEqual(new Array<number>(8 * 8 * 4).fill(64));
  });

  test("culling treats counterclockwise NDC vertices as front faces", () => {
    const renderer = createRenderer(4, 4);
    const front = { ...triangle(renderer, RED, 0, { ...STATE, cull: "back" }), indices: [0, 2, 1] };
    executeStaticBatch(renderer.renderer, front);
    expect(pixel(renderer, 0, 0)).toEqual([255, 0, 0, 255]);
    clear(renderer, BLACK);
    executeStaticBatch(renderer.renderer, { ...front, indices: [0, 1, 2] });
    expect(pixel(renderer, 0, 0)).toEqual([0, 0, 0, 0]);
    executeStaticBatch(renderer.renderer, { ...front, state: { ...STATE, cull: "front" } });
    expect(pixel(renderer, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  test("fractional shared edges have complementary coverage", () => {
    const renderer = createRenderer(7, 7);
    const color: Vec4 = { x: 0.25, y: 0.25, z: 0.25, w: 0.25 };
    const state: RenderState = { ...STATE, blend: { source: "one", destination: "one" } };
    executeStaticBatch(renderer.renderer, batch(renderer, [vertex(-0.99, 0.99, color), vertex(0.99, 0.99, color),
      vertex(0.99, -0.99, color), vertex(-0.99, -0.99, color)], state, renderer.white, [0, 1, 2, 0, 2, 3]));
    expect(Array.from(renderer.pixels)).toEqual(new Array<number>(7 * 7 * 4).fill(64));
  });

  test("near-plane clipping preserves color interpolation", () => {
    const renderer = createRenderer(4, 4);
    executeStaticBatch(renderer.renderer, batch(renderer, [vertex(-1, 1, RED, -2), vertex(1, 1, GREEN), vertex(-1, -1, BLUE)]));
    expect(pixel(renderer, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(renderer, 1, 0)).toEqual([128, 96, 32, 255]);
    expect(pixel(renderer, 0, 1)).toEqual([128, 32, 96, 255]);
    expect(pixel(renderer, 1, 1)).toEqual([64, 96, 96, 255]);
  });

  test("each homogeneous clip plane rejects triangles entirely outside", () => {
    const renderer = createRenderer(4, 4);
    const outside: readonly DrawBatch[] = [
      batch(renderer, [vertex(-3, 1), vertex(-2, 1), vertex(-3, -1)]),
      batch(renderer, [vertex(2, 1), vertex(3, 1), vertex(2, -1)]),
      batch(renderer, [vertex(-1, -2), vertex(1, -2), vertex(-1, -3)]),
      batch(renderer, [vertex(-1, 3), vertex(1, 3), vertex(-1, 2)]),
      triangle(renderer, WHITE, -2), triangle(renderer, WHITE, 2),
    ];
    for (const draw of outside) executeStaticBatch(renderer.renderer, draw);
    expect(renderer.pixels.every((value) => value === 0)).toBe(true);
  });

  test("clipped shared edges and fan diagonals retain exactly one coverage", () => {
    const renderer = createRenderer(8, 8);
    const color: Vec4 = { x: 0.25, y: 0.25, z: 0.25, w: 0.25 };
    const state: RenderState = { ...STATE, blend: { source: "one", destination: "one" } };
    executeStaticBatch(renderer.renderer, batch(renderer, [vertex(-2, 2, color), vertex(2, 2, color), vertex(2, -2, color), vertex(-2, -2, color)],
      state, renderer.white, [0, 1, 2, 0, 2, 3]));
    expect(Array.from(renderer.pixels)).toEqual(new Array<number>(8 * 8 * 4).fill(64));
  });

  test("zero w and geometry behind the eye do not divide by zero", () => {
    const renderer = createRenderer(4, 4);
    executeStaticBatch(renderer.renderer, batch(renderer, [vertex(0, 0, WHITE, 0, 0), vertex(1, 1), vertex(-1, -1)]));
    executeStaticBatch(renderer.renderer, batch(renderer, [vertex(-1, 1, WHITE, 0, -1), vertex(1, 1, WHITE, 0, -1), vertex(-1, -1, WHITE, 0, -1)]));
    expect(renderer.pixels.every((value) => value === 0)).toBe(true);
    executeStaticBatch(renderer.renderer, batch(renderer, [vertex(0, 2, RED, 0, -1), vertex(-1, -1, RED), vertex(1, -1, RED)]));
    expect(pixel(renderer, 1, 2)).toEqual([255, 0, 0, 255]);
  });

  test("very small positive w retains a visible triangle", () => {
    const renderer = createRenderer(4, 4);
    const w = 1e-310;
    executeStaticBatch(renderer.renderer, batch(renderer, [vertex(-w, w, RED, 0, w), vertex(w, w, RED, 0, w), vertex(-w, -w, RED, 0, w)]));
    expect(pixel(renderer, 0, 0)).toEqual([255, 0, 0, 255]);
  });

  test("large finite homogeneous coordinates clip without plane-sum overflow", () => {
    const renderer = createRenderer(4, 4);
    const scale = 8e307;
    executeStaticBatch(renderer.renderer, batch(renderer, [vertex(-scale, scale, RED, -2 * scale, scale),
      vertex(scale, scale, GREEN, 0, scale), vertex(-scale, -scale, BLUE, 0, scale)]));
    expect(pixel(renderer, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(renderer, 1, 1)).toEqual([64, 96, 96, 255]);
  });

  test("degenerate triangles do not write fragments", () => {
    const renderer = createRenderer(4, 4);
    executeStaticBatch(renderer.renderer, batch(renderer, [vertex(-1, 1), vertex(0, 0), vertex(1, -1)]));
    executeStaticBatch(renderer.renderer, batch(renderer, [vertex(0, 0), vertex(0, 0), vertex(0, 0)]));
    expect(renderer.pixels.every((value) => value === 0)).toBe(true);
  });

  test("one-subpixel-high triangles include lower and exclude upper horizontal pixel-center edges", () => {
    const renderer = createRenderer(8, 8);
    executeStaticBatch(renderer.renderer, batch(renderer, [vertex(-0.875, 0.875), vertex(0.875, 0.875), vertex(-0.875, 0.875 + 2 ** -10)]));
    for (let x = 0; x < 8; x++) {
      expect(pixel(renderer, x, 0)).toEqual(x < 7 ? [255, 255, 255, 255] : [0, 0, 0, 0]);
      expect(pixel(renderer, x, 1)).toEqual([0, 0, 0, 0]);
    }
    clear(renderer, BLACK);
    executeStaticBatch(renderer.renderer, batch(renderer, [vertex(-0.875, 0.875), vertex(0.875, 0.875), vertex(-0.875, 0.875 - 2 ** -10)]));
    expect(renderer.pixels.every(value => value === 0)).toBe(true);
  });
});

describe("depth, alpha and blending", () => {
  test("depth overlap, depth equality, writes and clear values", () => {
    const renderer = createRenderer(4, 4);
    executeStaticBatch(renderer.renderer, triangle(renderer, RED, -0.5));
    executeStaticBatch(renderer.renderer, triangle(renderer, BLUE, 0.5));
    expect(pixel(renderer, 0, 0)).toEqual([255, 0, 0, 255]);
    executeStaticBatch(renderer.renderer, triangle(renderer, GREEN, -0.5, { ...STATE, depthTest: "equal" }));
    expect(pixel(renderer, 0, 0)).toEqual([0, 255, 0, 255]);
    executeStaticBatch(renderer.renderer, triangle(renderer, BLUE, 0, { ...STATE, depthTest: "equal" }));
    expect(pixel(renderer, 0, 0)).toEqual([0, 255, 0, 255]);
    executeStaticBatch(renderer.renderer, triangle(renderer, BLUE, 0.5, { ...STATE, depthTest: "always", depthWrite: false }));
    executeStaticBatch(renderer.renderer, triangle(renderer, RED, 0));
    expect(pixel(renderer, 0, 0)).toEqual([0, 0, 255, 255]);
    clear(renderer, BLACK, 0.2);
    executeStaticBatch(renderer.renderer, triangle(renderer, RED, -0.5));
    expect(pixel(renderer, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  test("depth interpolates z/w in screen space without perspective division", () => {
    const renderer = createRenderer(4, 4);
    // At (0.5,0.5), screen weights are 3/4,1/8,1/8, so depth = 0.25.
    executeStaticBatch(renderer.renderer, batch(renderer, [vertex(-1, 1, RED, -1, 1), vertex(2, 2, RED, 2, 2), vertex(-4, -4, RED, 4, 4)]));
    executeStaticBatch(renderer.renderer, triangle(renderer, GREEN, -0.4)); // depth 0.3 is farther.
    expect(pixel(renderer, 0, 0)).toEqual([255, 0, 0, 255]);
    executeStaticBatch(renderer.renderer, triangle(renderer, BLUE, -0.6)); // depth 0.2 is nearer.
    expect(pixel(renderer, 0, 0)).toEqual([0, 0, 255, 255]);
  });

  test("alpha tests use the source GL thresholds, before depth writes", () => {
    const cases: readonly { readonly test: RenderState["alphaTest"]; readonly alpha: number; readonly passes: boolean }[] = [
      { test: "gt0", alpha: 0, passes: false }, { test: "gt0", alpha: 0.001, passes: true },
      { test: "lt128", alpha: 127 / 255, passes: true }, { test: "lt128", alpha: 0.5, passes: false },
      { test: "ge128", alpha: 0.5, passes: true }, { test: "ge128", alpha: 127 / 255, passes: false },
    ];
    for (const fixture of cases) {
      const renderer = createRenderer(4, 4);
      executeStaticBatch(renderer.renderer, triangle(renderer, { ...RED, w: fixture.alpha }, -0.5, { ...STATE, alphaTest: fixture.test }));
      executeStaticBatch(renderer.renderer, triangle(renderer, BLUE, 0.5));
      expect(pixel(renderer, 0, 0)).toEqual(fixture.passes ? [255, 0, 0, Math.round(fixture.alpha * 255)] : [0, 0, 255, 255]);
    }
  });

  test("alpha blending multiplies source and destination factors per channel", () => {
    const renderer = createRenderer(4, 4);
    clear(renderer, BLUE);
    executeStaticBatch(renderer.renderer, triangle(renderer, { ...RED, w: 0.5 }, 0,
      { ...STATE, blend: { source: "src-alpha", destination: "one-minus-src-alpha" } }));
    expect(pixel(renderer, 0, 0)).toEqual([128, 0, 128, 191]);
  });

  test("all eleven blend factors match independent numeric fixtures", () => {
    const source: Vec4 = { x: 0.2, y: 0.4, z: 0.8, w: 0.6 };
    const destination: Vec4 = { x: 51 / 255, y: 102 / 255, z: 153 / 255, w: 204 / 255 };
    // Each entry gives source-only and destination-only output for its factor.
    const cases: readonly { readonly factor: BlendFactor; readonly source: readonly number[]; readonly destination: readonly number[] }[] = [
      { factor: "zero", source: [0, 0, 0, 0], destination: [0, 0, 0, 0] },
      { factor: "one", source: [51, 102, 204, 153], destination: [51, 102, 153, 204] },
      { factor: "src-color", source: [10, 41, 163, 92], destination: [10, 41, 122, 122] },
      { factor: "one-minus-src-color", source: [41, 61, 41, 61], destination: [41, 61, 31, 82] },
      { factor: "dst-color", source: [10, 41, 122, 122], destination: [10, 41, 92, 163] },
      { factor: "one-minus-dst-color", source: [41, 61, 82, 31], destination: [41, 61, 61, 41] },
      { factor: "src-alpha", source: [31, 61, 122, 92], destination: [31, 61, 92, 122] },
      { factor: "one-minus-src-alpha", source: [20, 41, 82, 61], destination: [20, 41, 61, 82] },
      { factor: "dst-alpha", source: [41, 82, 163, 122], destination: [41, 82, 122, 163] },
      { factor: "one-minus-dst-alpha", source: [10, 20, 41, 31], destination: [10, 20, 31, 41] },
      { factor: "src-alpha-saturate", source: [10, 20, 41, 153], destination: [10, 20, 31, 204] },
    ];
    for (const fixture of cases) {
      const renderer = createRenderer(4, 4);
      clear(renderer, destination);
      executeStaticBatch(renderer.renderer, triangle(renderer, source, 0, { ...STATE, blend: { source: fixture.factor, destination: "zero" } }));
      expect(pixel(renderer, 0, 0)).toEqual(fixture.source);
      clear(renderer, destination);
      const destinationBatch = triangle(renderer, source, 0, { ...STATE, blend: { source: "zero", destination: fixture.factor } });
      if (fixture.factor === "src-alpha-saturate") {
        expect(() => executeStaticBatch(renderer.renderer, destinationBatch)).toThrow(RangeError);
      } else {
        executeStaticBatch(renderer.renderer, destinationBatch);
        expect(pixel(renderer, 0, 0)).toEqual(fixture.destination);
      }
    }
  });
});

describe("texture and perspective interpolation", () => {
  const checker: PixelTexture = { width: 2, height: 2, pixels: new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  ]) };

  test("nearest repeat wraps positive and negative coordinates", () => {
    expect(textureAt(0.25, 0.25, checker)).toEqual([255, 0, 0, 255]);
    expect(textureAt(1.75, -0.75, checker)).toEqual([0, 255, 0, 255]);
    expect(textureAt(-0.75, 1.75, checker)).toEqual([0, 0, 255, 255]);
    expect(textureAt(1, 1, checker)).toEqual([255, 0, 0, 255]);
  });

  test("nearest clamp clamps coordinates to the last interior texel", () => {
    const sampling: TextureSampling = { wrap: "clamp", filter: "nearest" };
    expect(textureAt(-2, -1, checker, sampling)).toEqual([255, 0, 0, 255]);
    expect(textureAt(2, 1, checker, sampling)).toEqual([255, 255, 255, 255]);
  });

  test("bilinear repeat uses texel centers and wraps all four contributors", () => {
    const sampling: TextureSampling = { wrap: "repeat", filter: "linear" };
    expect(textureAt(0.25, 0.25, checker, sampling)).toEqual([255, 0, 0, 255]);
    expect(textureAt(0.5, 0.5, checker, sampling)).toEqual([128, 128, 128, 255]);
    expect(textureAt(0, 0, checker, sampling)).toEqual([128, 128, 128, 255]);
    expect(textureAt(-1, 2, checker, sampling)).toEqual([128, 128, 128, 255]);
  });

  test("legacy GL_CLAMP bilinear filtering includes transparent border texels", () => {
    const sampling: TextureSampling = { wrap: "clamp", filter: "linear" };
    expect(textureAt(0.25, 0.25, checker, sampling)).toEqual([255, 0, 0, 255]);
    expect(textureAt(0, 0.25, checker, sampling)).toEqual([128, 0, 0, 128]);
    expect(textureAt(-3, -3, checker, sampling)).toEqual([64, 0, 0, 64]);
    expect(textureAt(3, -3, checker, sampling)).toEqual([0, 64, 0, 64]);
    expect(textureAt(-3, 3, checker, sampling)).toEqual([0, 0, 64, 64]);
    expect(textureAt(3, 3, checker, sampling)).toEqual([64, 64, 64, 64]);
    expect(textureAt(0.5, 0, checker, sampling)).toEqual([64, 64, 0, 128]);
    expect(textureAt(0.5, 1, checker, sampling)).toEqual([64, 64, 128, 128]);
  });

  test("texture alpha is multiplied by interpolated vertex alpha before testing", () => {
    const transparent: PixelTexture = { width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 127]) };
    const renderer = createRenderer(2, 2);
    const transparentImage = publish(renderer, transparent);
    executeStaticBatch(renderer.renderer, batch(renderer, [vertex(-1, 1, WHITE, 0, 1, 0.5, 0.5), vertex(1, 1, WHITE, 0, 1, 0.5, 0.5),
      vertex(-1, -1, WHITE, 0, 1, 0.5, 0.5)], { ...STATE, alphaTest: "ge128" }, transparentImage));
    expect(pixel(renderer, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  test("UV and color interpolate using independent reciprocal-w weights", () => {
    const renderer = createRenderer(4, 4);
    // Pixel (1,0) screen weights = 1/2,3/8,1/8. With w=1,4,1,
    // reciprocal sum = 23/32, so u=(3/32)/(23/32)=3/23, v=4/23.
    // Affine u=3/8 would instead sample the second column of this 4x1 image.
    const stripes: PixelTexture = { width: 4, height: 1, pixels: new Uint8Array([
      255, 255, 255, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255,
    ]) };
    const stripesImage = publish(renderer, stripes);
    executeStaticBatch(renderer.renderer, batch(renderer, [vertex(-1, 1, RED, 0, 1, 0, 0), vertex(4, 4, GREEN, 0, 4, 1, 0),
      vertex(-1, -1, BLUE, 0, 1, 0, 1)], STATE, stripesImage));
    expect(pixel(renderer, 1, 0)).toEqual([177, 33, 44, 255]);
  });

  test("perspective checker sampling differs from the affine texel", () => {
    const renderer = createRenderer(4, 4);
    const vertices = [vertex(-1, 1, WHITE, 0, 1, 0, 0), vertex(4, 4, WHITE, 0, 4, 2, 0),
      vertex(-1, -1, WHITE, 0, 1, 0, 1)];
    // Screen weights at (1,0) are 1/2,3/8,1/8. Perspective UV is
    // (6/23,4/23), in the red texel. Affine UV (3/4,1/8) is green.
    const nearestImage = publish(renderer, checker);
    executeStaticBatch(renderer.renderer, batch(renderer, vertices, STATE, nearestImage));
    expect(pixel(renderer, 1, 0)).toEqual([255, 0, 0, 255]);
    clear(renderer, BLACK);
    const linearImage = publish(renderer, checker, { wrap: "repeat", filter: "linear" });
    executeStaticBatch(renderer.renderer, batch(renderer, vertices, STATE, linearImage));
    // Bilinear fractional x is 1/46; the wrapped blue-row weight is 7/46.
    expect(pixel(renderer, 1, 0)).toEqual([212, 6, 39, 255]);
  });

  test("texture subarray offsets are honored", () => {
    const storage = new Uint8Array([1, 2, 3, 4, 20, 40, 60, 255, 7, 8, 9, 10]);
    const texture: PixelTexture = { width: 1, height: 1, pixels: storage.subarray(4, 8) };
    expect(textureAt(0.5, 0.5, texture)).toEqual([20, 40, 60, 255]);
  });

  test("unaligned texture storage retains nearest and bilinear channel order", () => {
    const storage = new Uint8Array([99, 20, 40, 60, 255, 100, 120, 140, 255, 99]);
    const texture: PixelTexture = { width: 2, height: 1, pixels: storage.subarray(1, 9) };
    expect(textureAt(0.25, 0.5, texture)).toEqual([20, 40, 60, 255]);
    expect(textureAt(0.5, 0.5, texture, { wrap: "repeat", filter: "linear" })).toEqual([60, 80, 100, 255]);
    expect(textureAt(0, 0.5, texture, { wrap: "clamp", filter: "linear" })).toEqual([10, 20, 30, 128]);
  });
});

describe("renderer input boundaries", () => {
  test("rejects invalid sizes and nonfinite clear values", () => {
    expect(() => createRenderer(0, 1)).toThrow(RangeError);
    expect(() => createRenderer(1.5, 1)).toThrow(RangeError);
    expect(() => createRenderer(1, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    const renderer = createRenderer(2, 2);
    expect(() => clear(renderer, { ...RED, x: Number.NaN })).toThrow(RangeError);
    expect(() => clear(renderer, RED, Number.NaN)).toThrow(RangeError);
  });

  test("rejects malformed indices and attributes before drawing", () => {
    const renderer = createRenderer(4, 4);
    const valid = triangle(renderer, RED);
    for (const indices of [[0, 1], [0, 1, 3], [0, 1, -1], [0, 1, 1.5], [0, 1, Number.NaN], [0, 1, 2, 0, 1, 99]]) {
      expect(() => executeStaticBatch(renderer.renderer, { ...valid, indices })).toThrow(RangeError);
    }
    expect(() => executeStaticBatch(renderer.renderer, batch(renderer, [vertex(-1, 1), vertex(1, 1), vertex(-1, Number.NaN)]))).toThrow(RangeError);
    expect(() => executeStaticBatch(renderer.renderer, batch(renderer, [vertex(-1, 1), vertex(1, 1), vertex(-1, -1, { ...WHITE, w: Number.POSITIVE_INFINITY })]))).toThrow(RangeError);
    expect(() => executeStaticBatch(renderer.renderer, batch(renderer, [vertex(-1, 1), vertex(1, 1), vertex(-1, -1, WHITE, 0, 1, Number.NaN)]))).toThrow(RangeError);
    expect(renderer.pixels.every((value) => value === 0)).toBe(true);
  });

  test("rejects malformed texture storage", () => {
    const renderer = createRenderer(4, 4);
    for (const texture of [{ width: 0, height: 1, pixels: new Uint8Array(0) },
      { width: 1, height: 1, pixels: new Uint8Array(3) }, { width: 1, height: 1, pixels: new Uint8Array(5) }]) {
      expect(() => publish(renderer, texture)).toThrow(RangeError);
    }
  });
});
