import { expect, test } from "bun:test";
import type { Vec4 } from "../src/core/math.ts";
import { RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import type { SingleTextureBatch, RenderState, RenderVertex } from "../src/render/types.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { refresh } from "../src/ui/base/framework.ts";
import { BaseSpecifyServerMenu } from "../src/ui/base/specify-server.ts";
import { baseFixture } from "./base-ui-fixture.ts";
import { executeStaticBatch, publishTexture } from "./render-target-fixture.ts";

const white: Vec4 = { x: 1, y: 1, z: 1, w: 1 }, black: Vec4 = { x: 0, y: 0, z: 0, w: 1 };
const state: RenderState = { ...OPAQUE_STATE, cull: "none" };
type Point = readonly [number, number, number];
interface Shape { readonly name: string; readonly width: number; readonly height: number; readonly points: readonly [Point, Point, Point] }
const shapes: readonly Shape[] = [
  { name: "small", width: 7, height: 11, points: [[-1, 1, 1], [1, 1, 1], [-1, -1, 1]] },
  { name: "oblique", width: 67, height: 53, points: [[-0.875, 0.75, 1], [0.9375, 0.5, 1], [-0.25, -0.875, 1]] },
  { name: "reversed", width: 67, height: 53, points: [[-0.875, 0.75, 1], [-0.25, -0.875, 1], [0.9375, 0.5, 1]] },
  { name: "different homogeneous w", width: 67, height: 53, points: [[-0.875, 0.75, 0.5], [0.9375, 0.5, 2], [-0.25, -0.875, 4]] },
  { name: "XY clipped original interpolation plane", width: 67, height: 53, points: [[-2, 1.5, 1], [1.5, 0.75, 2], [-0.25, -1.5, 0.5]] },
  { name: "long thin highlight triangle", width: 640, height: 480, points: [[-0.58125, 1 / 12, 1], [0.621875, 1 / 12, 1], [0.621875, 0.0125, 1]] },
];
function fixture(width: number, height: number) {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(width, height, images), target = new RenderTarget(images, [cpu]);
  const image = publishTexture(images, { name: "constant-depth-white", width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]),
    internalFormat: "rgb8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 1 });
  return { cpu, target, image };
}
function triangle(shape: Shape, image: RendererImage, z: number, drawState: RenderState): SingleTextureBatch {
  const vertices: RenderVertex[] = shape.points.map(([x, y, w]) => ({ position: { x: x * w, y: y * w, z: z * w, w }, color: white, texCoord: { x: 0, y: 0 } }));
  return { texturing: "single", primitive: "triangles", texture: { kind: "bind-image", image }, vertices, indices: [0, 1, 2], state: drawState };
}
function clear(cpu: SoftwareRenderer, depth: number): void {
  cpu.beginView({ viewport: { x: 0, y: 0, width: cpu.width, height: cpu.height }, clear: { stencil: false, color: black, depth } });
}
function differences(actual: Uint8Array, expected: Uint8Array): number {
  return actual.reduce((count, value, index) => count + (value === expected[index] ? 0 : 1), 0);
}

for (const depthTest of ["less-equal", "equal"] satisfies readonly RenderState["depthTest"][]) {
  for (const z of [-1, -0.5, 0, 0.5, 1]) test(`constant projected z=${z} passes ${depthTest} at every covered sample`, () => {
    for (const shape of shapes) {
      const f = fixture(shape.width, shape.height);
      try {
        clear(f.cpu, 1);
        executeStaticBatch(f.cpu, triangle(shape, f.image, z, { ...state, depthTest: "always", depthWrite: false }));
        const covered = f.cpu.pixels.slice(); expect(covered.some((value, index) => index % 4 === 0 && value === 255)).toBe(true);
        for (const depthRange of [[0, 1], [0.25, 0.75], [0.75, 0.25], [0.5, 0.5]] satisfies readonly (readonly [number, number])[]) {
          const expectedDepth = (z * 0.5 + 0.5) * (depthRange[1] - depthRange[0]) + depthRange[0];
          clear(f.cpu, expectedDepth);
          executeStaticBatch(f.cpu, triangle(shape, f.image, z, { ...state, depthTest, depthRange }));
          expect({ shape: shape.name, z, depthRange, differingBytes: differences(f.cpu.pixels, covered) }).toEqual({ shape: shape.name, z, depthRange, differingBytes: 0 });
        }
      } finally { f.target.close(); }
    }
  });
}

test("constant depth preserves polygon offset units and strict rejection of a genuinely farther plane", () => {
  for (const depthTest of ["less-equal", "equal"] satisfies readonly RenderState["depthTest"][]) for (const z of [-1, -0.5, 0, 0.5]) {
    const shape = shapes[1]; if (shape === undefined) throw new Error("Missing oblique fixture");
    const f = fixture(shape.width, shape.height);
    try {
      clear(f.cpu, 1); executeStaticBatch(f.cpu, triangle(shape, f.image, z, { ...state, depthTest: "always", depthWrite: false }));
      const covered = f.cpu.pixels.slice(), exactDepth = z * 0.5 + 0.5, offset = 16 * 2 ** -24;
      clear(f.cpu, exactDepth + offset);
      executeStaticBatch(f.cpu, triangle(shape, f.image, z, { ...state, depthTest, polygonOffset: { factor: 0, units: 16 } }));
      expect(differences(f.cpu.pixels, covered)).toBe(0);
      clear(f.cpu, exactDepth); const empty = f.cpu.pixels.slice();
      executeStaticBatch(f.cpu, triangle(shape, f.image, z + 2 ** -23, { ...state, depthTest }));
      expect(differences(f.cpu.pixels, empty)).toBe(0);
      executeStaticBatch(f.cpu, triangle(shape, f.image, z, { ...state, depthTest, polygonOffset: { factor: 0, units: 16 } }));
      expect(differences(f.cpu.pixels, empty)).toBe(0);
    } finally { f.target.close(); }
  }
});

test("coplanar draws with different triangle geometry preserve exact equal depth", () => {
  const f = fixture(67, 53), shape = shapes[1]; if (shape === undefined) throw new Error("Missing oblique fixture");
  try {
    for (const z of [-1, -0.5, 0.5]) {
      clear(f.cpu, 1);
      executeStaticBatch(f.cpu, triangle(shape, f.image, z, { ...state, depthTest: "always", depthWrite: false }));
      const covered = f.cpu.pixels.slice();
      clear(f.cpu, 1);
      const background: Shape = { name: "fullscreen", width: 67, height: 53, points: [[-1, 1, 1], [3, 1, 1], [-1, -3, 1]] };
      const draw = triangle(background, f.image, z, state);
      executeStaticBatch(f.cpu, { ...draw, vertices: draw.vertices.map(vertex => ({ ...vertex, color: black })) });
      for (let repeat = 0; repeat < 3; repeat++) executeStaticBatch(f.cpu, triangle(shape, f.image, z, { ...state, depthTest: "equal" }));
      expect(differences(f.cpu.pixels, covered)).toBe(0);
    }
  } finally { f.target.close(); }
});

test("depth comparisons reject a representably farther plane without an epsilon", () => {
  const shape = shapes[1]; if (shape === undefined) throw new Error("Missing oblique fixture");
  const f = fixture(shape.width, shape.height);
  try {
    for (const depthTest of ["less-equal", "equal"] satisfies readonly RenderState["depthTest"][]) for (const z of [-1, -0.5, 0, 0.5]) {
      clear(f.cpu, z * 0.5 + 0.5); const empty = f.cpu.pixels.slice();
      executeStaticBatch(f.cpu, triangle(shape, f.image, z + 2 ** -23, { ...state, depthTest }));
      expect(differences(f.cpu.pixels, empty)).toBe(0);
    }
  } finally { f.target.close(); }
});

test("actual Specify Server CPU address highlight remains amber across its blank region", async () => {
  const f = await baseFixture(640, 480);
  try {
    await cacheMenu(f.state); const menu = new BaseSpecifyServerMenu(f.state); await menu.show();
    await refresh(f.state, 1000); f.commands.submit();
    const samples = [[400, 225], [500, 230], [300, 235]].map(([x, y]) => {
      if (x === undefined || y === undefined) throw new Error("Missing regression point");
      return { x, y, rgb: Array.from(f.cpu.pixels.slice((y * 640 + x) * 4, (y * 640 + x) * 4 + 3)) };
    });
    let amber = 0;
    for (let y = 220; y <= 236; y++) for (let x = 260; x <= 518; x++) {
      const offset = (y * 640 + x) * 4;
      if (f.cpu.pixels[offset] === 76 && f.cpu.pixels[offset + 1] === 32 && f.cpu.pixels[offset + 2] === 0) amber++;
    }
    expect({ samples, amber }).toEqual({ samples: [{ x: 400, y: 225, rgb: [76, 32, 0] }, { x: 500, y: 230, rgb: [76, 32, 0] }, { x: 300, y: 235, rgb: [76, 32, 0] }], amber: 4403 });
  } finally { f.close(); }
});
