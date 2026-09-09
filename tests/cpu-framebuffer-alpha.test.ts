// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import type { Vec4 } from "../src/core/math.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { DrawBatch, RenderState } from "../src/render/types.ts";
import { executeStaticBatch, publishTexture } from "./render-target-fixture.ts";

const white: Vec4 = { x: 1, y: 1, z: 1, w: 1 };
const state: RenderState = { blend: { source: "one", destination: "zero" }, depthTest: "always", depthWrite: false,
  alphaTest: "none", cull: "none" };

function fixture(alphaBits?: 0 | 8, textureAlpha = 255) {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(4, 4, images, 8, 8, alphaBits);
  const session = images.openSession(); session.attach(cpu); session.beginExecution();
  const image = publishTexture(images, { name: "framebuffer-alpha", width: 1, height: 1,
    pixels: new Uint8Array([255, 255, 255, textureAlpha]), internalFormat: "rgba8",
    sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 1 });
  function draw(primitive: "triangles" | "lines", color: Vec4, renderState = state): void {
    const positions = primitive === "triangles" ? [{ x: -1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: -1 }]
      : [{ x: -1, y: 0.25 }, { x: 1, y: 0.25 }];
    const batch = { texturing: "single", texture: { kind: "bind-image", image }, state: renderState,
      vertices: positions.map(position => ({ position: { ...position, z: 0, w: 1 }, color, texCoord: { x: 0.5, y: 0.5 } })) };
    const geometry: DrawBatch = primitive === "triangles"
      ? { ...batch, texturing: "single", texture: { kind: "bind-image", image }, primitive, indices: [0, 1, 2, 0, 2, 3] }
      : { ...batch, texturing: "single", texture: { kind: "bind-image", image }, primitive, lineWidth: 1, indices: [0, 1] };
    executeStaticBatch(cpu, geometry);
  }
  function clear(color: Vec4): void {
    cpu.beginView({ viewport: { x: 0, y: 0, width: 4, height: 4 }, clear: { color, depth: 1, stencil: true } });
  }
  return { cpu, image, draw, clear, pixel: () => [...cpu.pixels.slice(20, 24)],
    close: () => { session.close(); cpu.close(); } };
}

test("RGB framebuffer initializes and clears opaque while the default RGBA buffer retains alpha", () => {
  for (const alphaBits of [0, undefined] satisfies readonly (0 | undefined)[]) {
    const f = fixture(alphaBits);
    try {
      expect(f.cpu.alphaBits).toBe(alphaBits ?? 8);
      expect(f.pixel()).toEqual([0, 0, 0, alphaBits === 0 ? 255 : 0]);
      f.clear({ x: 0.25, y: 0.5, z: 0.75, w: 0.25 });
      expect(f.pixel()).toEqual([64, 128, 191, alphaBits === 0 ? 255 : 64]);
    } finally { f.close(); }
  }
});

test("destination-alpha lightmap blend depends on framebuffer storage, including externally modified alpha", () => {
  for (const alphaBits of [0, 8] satisfies readonly (0 | 8)[]) for (const primitive of ["triangles", "lines"] satisfies readonly ("triangles" | "lines")[]) {
    const f = fixture(alphaBits);
    try {
      f.clear({ x: 0.5, y: 0.25, z: 0, w: 0.25 });
      f.cpu.pixels[23] = 64;
      f.draw(primitive, { x: 0.5, y: 0.5, z: 0.5, w: 1 },
        { ...state, blend: { source: "dst-color", destination: "one-minus-dst-alpha" } });
      // RGB: .5*D. RGBA: .5*D + D*(1-64/255), with D=[128,64,0]/255.
      expect(f.pixel()).toEqual(alphaBits === 0 ? [64, 32, 0, 255] : [160, 80, 0, 112]);
    } finally { f.close(); }
  }
});

test("RGB storage keeps incoming texture alpha for blending and alpha rejection on triangles and lines", () => {
  for (const primitive of ["triangles", "lines"] satisfies readonly ("triangles" | "lines")[]) {
    const f = fixture(0, 128);
    try {
      f.clear({ x: 0, y: 0, z: 1, w: 0 });
      f.draw(primitive, { x: 1, y: 0, z: 0, w: 1 },
        { ...state, blend: { source: "src-alpha", destination: "one-minus-src-alpha" } });
      expect(f.pixel()).toEqual([128, 0, 127, 255]);
      f.draw(primitive, { x: 0, y: 1, z: 0, w: 0.5 }, { ...state, alphaTest: "ge128" });
      expect(f.pixel()).toEqual([128, 0, 127, 255]);
      f.draw(primitive, { x: 0, y: 1, z: 0, w: 0.5 });
      expect(f.pixel()).toEqual([0, 255, 0, 255]);
      f.cpu.pixels[23] = 0;
      f.draw(primitive, white, { ...state, blend: { source: "src-alpha-saturate", destination: "one" } });
      expect(f.pixel()).toEqual([0, 255, 0, 255]);
    } finally { f.close(); }
  }
});

test("RGB triangle fast blends and general destination-alpha factors store opaque results", () => {
  const cases: readonly { readonly blend: RenderState["blend"]; readonly rgb: readonly number[] }[] = [
    { blend: { source: "one", destination: "zero" }, rgb: [128, 128, 128] },
    { blend: { source: "one", destination: "one" }, rgb: [192, 192, 192] },
    { blend: { source: "dst-color", destination: "zero" }, rgb: [32, 32, 32] },
    { blend: { source: "zero", destination: "src-color" }, rgb: [32, 32, 32] },
    { blend: { source: "dst-alpha", destination: "zero" }, rgb: [128, 128, 128] },
    { blend: { source: "one-minus-dst-alpha", destination: "zero" }, rgb: [0, 0, 0] },
  ];
  const f = fixture(0);
  try {
    for (const value of cases) {
      f.clear({ x: 0.25, y: 0.25, z: 0.25, w: 0 });
      f.cpu.pixels[23] = 0;
      f.draw("triangles", { x: 0.5, y: 0.5, z: 0.5, w: 0.25 }, { ...state, blend: value.blend });
      expect(f.pixel()).toEqual([...value.rgb, 255]);
    }
  } finally { f.close(); }
});

test("stencil volume color masking preserves the RGB framebuffer", () => {
  const f = fixture(0);
  try {
    f.clear({ x: 0.25, y: 0.5, z: 0.75, w: 0 });
    const before = f.cpu.pixels.slice();
    f.cpu.drawImmediate({ kind: "shadow-volume", whiteImage: f.image, mirror: false,
      positions: [{ x: -1, y: 1, z: 0, w: 1 }, { x: 1, y: 1, z: 0, w: 1 }, { x: -1, y: -1, z: 0, w: 1 }],
      indices: [0, 1, 2] });
    expect(f.cpu.pixels).toEqual(before);
  } finally { f.close(); }
});
