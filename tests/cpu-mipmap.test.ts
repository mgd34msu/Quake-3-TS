// Q3 tr_image.c GL_TextureMode/Upload32/R_CreateImage and tr_backend.c
// RE_UploadCinematic, copyright (C) 1999-2005 Id Software, Inc.
// Analytic sampling fixtures use OpenGL 2.1 sections 3.8.8-3.8.10,
// https://registry.khronos.org/OpenGL/specs/gl/glspec21.pdf .
// Ideal rho and exact requested CPU storage bits are deterministic profiles;
// the specification permits native driver LOD and storage precision differences.
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import type { Vec4 } from "../src/core/math.ts";
import { RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { rasterizeAliasedLine } from "../src/render/cpu/lines.ts";
import type { LineFragment } from "../src/render/cpu/lines.ts";
import { RendererImageCatalog, RgbaSnapshot } from "../src/render/image-resource.ts";
import type { ImageInternalFormat, ImageLevel, RendererImage } from "../src/render/image-resource.ts";
import type { DrawBatch, MultitextureBatch, MultitextureVertex, RenderVertex, SingleTextureBatch, TextureBinding, TextureFilter, TextureSampling } from "../src/render/types.ts";
import { executeStaticBatch } from "./render-target-fixture.ts";

const WHITE: Vec4 = { x: 1, y: 1, z: 1, w: 1 };
type Rgba = readonly [number, number, number, number];
const RED: Rgba = [255, 0, 0, 255], GREEN: Rgba = [0, 255, 0, 255], BLUE: Rgba = [0, 0, 255, 255];
const FILTERS: readonly TextureFilter[] = ["nearest", "linear", "nearest-mipmap-nearest", "linear-mipmap-nearest", "nearest-mipmap-linear", "linear-mipmap-linear"];

function solid(width: number, height: number, color: Rgba): ImageLevel {
  const pixels = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(color, offset);
  return { width, height, pixels };
}

function levels(width: number, height: number, colors: readonly [Rgba, ...Rgba[]]): readonly [ImageLevel, ...ImageLevel[]] {
  const first = solid(width, height, colors[0]), children: ImageLevel[] = [];
  for (const color of colors.slice(1)) {
    width = Math.max(1, Math.floor(width / 2)); height = Math.max(1, Math.floor(height / 2));
    children.push(solid(width, height, color));
  }
  return [first, ...children];
}

function fixture() {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(8, 8, images), target = new RenderTarget(images, [cpu]);
  return { images, cpu, target };
}

interface CreationOptions {
  readonly format?: ImageInternalFormat;
  readonly filter?: TextureFilter;
  readonly wrap?: TextureSampling["wrap"];
  readonly unit?: 0 | 1;
  readonly mipmap?: boolean;
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
}

function image(images: RendererImageCatalog, chain: readonly [ImageLevel, ...ImageLevel[]], options: CreationOptions = {}): RendererImage {
  return images.create({ name: "analytic mip chain", sourceWidth: options.sourceWidth ?? chain[0].width,
    sourceHeight: options.sourceHeight ?? chain[0].height, levels: chain, internalFormat: options.format ?? "rgba8",
    mipmap: options.mipmap ?? true, sampling: { wrap: options.wrap ?? "repeat", filter: options.filter ?? "nearest-mipmap-nearest" },
    registrationUnit: options.unit ?? 1 });
}

function vertex(x: number, y: number, s: number, t: number, w = 1, color: Vec4 = WHITE): RenderVertex {
  return { position: { x: (x / 4 - 1) * w, y: (1 - y / 4) * w, z: 0, w }, color, texCoord: { x: s, y: t } };
}

function quad(texture: TextureBinding, dsDx = 0, dtDy = 0, s = .5, t = .5, color: Vec4 = WHITE): SingleTextureBatch {
  return { texturing: "single", primitive: "triangles", texture,
    vertices: [[0, 0], [8, 0], [8, 8], [0, 8]].map(point => {
      const [x, y] = point;
      if (x === undefined || y === undefined) throw new Error("Missing quad point");
      return vertex(x, y, s + (x - .5) * dsDx, t + (y - .5) * dtDy, 1, color);
    }), indices: [0, 1, 2, 0, 2, 3],
    state: { blend: { source: "one", destination: "zero" }, depthTest: "always", depthWrite: false, alphaTest: "none", cull: "none" } };
}

function pixel(cpu: SoftwareRenderer, x = 0, y = 0): number[] {
  const offset = (y * cpu.width + x) * 4;
  return [...cpu.pixels.subarray(offset, offset + 4)];
}

function draw(cpu: SoftwareRenderer, texture: RendererImage, rho = 0, baseWidth = 1, s = .5, t = .5, color: Vec4 = WHITE): void {
  executeStaticBatch(cpu, quad({ kind: "bind-image", image: texture }, rho / baseWidth, 0, s, t, color));
}

function upload(cpu: SoftwareRenderer, texture: RendererImage, content: ImageLevel, dirty = true): void {
  const prepared = cpu.prepareGeometry(quad({ kind: "retain-current-texture" }));
  prepared.begin();
  prepared.applyTexture(0, { kind: "cinematic-upload", upload: { image: texture, sourceWidth: content.width, sourceHeight: content.height,
    uploadWidth: content.width, uploadHeight: content.height, content: new RgbaSnapshot(content.width, content.height, content.pixels), dirty } });
  prepared.draw(); prepared.cleanup();
}

function stripedChain(): readonly [ImageLevel, ...ImageLevel[]] {
  const row = [255, 0, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255];
  return [{ width: 4, height: 4, pixels: new Uint8Array([...row, ...row, ...row, ...row]) },
    { width: 2, height: 2, pixels: new Uint8Array([0, 255, 0, 255, 0, 255, 255, 255, 0, 255, 0, 255, 0, 255, 255, 255]) }, solid(1, 1, RED)];
}

test("all six source filter pairs select base, nearest mip, or two filtered mips", () => {
  const cases: readonly [TextureFilter, Rgba][] = [
    ["nearest", [255, 255, 0, 255]], ["linear", [128, 128, 128, 255]],
    ["nearest-mipmap-nearest", [0, 255, 255, 255]], ["linear-mipmap-nearest", [0, 255, 128, 255]],
    ["nearest-mipmap-linear", [64, 191, 191, 255]], ["linear-mipmap-linear", [64, 191, 96, 255]],
  ];
  for (const [filter, expected] of cases) {
    const { images, cpu, target } = fixture(), texture = image(images, stripedChain(), { filter });
    draw(cpu, texture, 2 ** 1.25, 4);
    expect(pixel(cpu)).toEqual([...expected]);
    target.close();
  }
});

test("zero rho and lambda at zero use each source pair's base magnification filter", () => {
  for (const filter of FILTERS) for (const rho of [0, .5, 1]) {
    const { images, cpu, target } = fixture(), texture = image(images, stripedChain(), { filter });
    draw(cpu, texture, rho, 4);
    expect(pixel(cpu)).toEqual(filter.startsWith("nearest") ? [255, 255, 0, 255] : [128, 128, 128, 255]);
    target.close();
  }
});

test("nearest mip half ties select the lower level, including level zero and the final level", () => {
  for (const filter of ["nearest-mipmap-nearest", "linear-mipmap-nearest"] satisfies readonly TextureFilter[]) {
    const { images, cpu, target } = fixture(), texture = image(images, levels(8, 8, [RED, GREEN, BLUE, [255, 255, 255, 255]]), { filter });
    const cases: readonly { readonly lambda: number; readonly expected: Rgba }[] = [
      { lambda: .5, expected: RED }, { lambda: .5 + 1e-7, expected: GREEN },
      { lambda: 1.5, expected: GREEN }, { lambda: 1.5 + 1e-7, expected: BLUE },
      { lambda: 2.5, expected: BLUE }, { lambda: 2.5 + 1e-7, expected: [255, 255, 255, 255] },
      { lambda: 100, expected: [255, 255, 255, 255] },
    ];
    for (const entry of cases) {
      const rho = 2 ** entry.lambda;
      // Endpoints s=0 and s=rho avoid cancellation from an arbitrary UV offset.
      executeStaticBatch(cpu, { ...quad({ kind: "bind-image", image: texture }),
        vertices: [vertex(0, 0, 0, .5), vertex(8, 0, rho, .5), vertex(8, 8, rho, .5), vertex(0, 8, 0, .5)] });
      expect(pixel(cpu)).toEqual([...entry.expected]);
    }
    target.close();
  }
});

test("child wrap and GL_CLAMP border taps are evaluated at each selected level", () => {
  const { images, cpu, target } = fixture();
  for (const [filter, wrap, expected] of [
    ["linear-mipmap-nearest", "clamp", [0, 143, 0, 143]],
    ["linear-mipmap-linear", "clamp", [0, 108, 25, 132]],
    ["linear-mipmap-linear", "repeat", [0, 191, 64, 255]],
  ] satisfies readonly [TextureFilter, TextureSampling["wrap"], readonly number[]][]) {
    const texture = image(images, levels(4, 4, [[0, 0, 0, 255], GREEN, BLUE]), { filter, wrap });
    draw(cpu, texture, 2 ** 1.25, 4, .125, .125); expect(pixel(cpu)).toEqual(expected);
  }
  const texture = image(images, levels(4, 4, [RED, GREEN, BLUE]), { filter: "linear-mipmap-nearest", wrap: "clamp" });
  draw(cpu, texture, 2, 4, -20, -20); expect(pixel(cpu)).toEqual([0, 64, 0, 64]);
  target.close();
});

test("both triangle units derive perspective LOD from their own UV planes and base dimensions", () => {
  const { images, cpu, target } = fixture();
  const first = image(images, levels(16, 4, [[11, 0, 0, 255], [22, 0, 0, 255], [33, 0, 0, 255], [44, 0, 0, 255], [55, 0, 0, 255]]));
  const second = image(images, levels(2, 8, [[0, 101, 0, 255], [0, 102, 0, 255], [0, 103, 0, 255], [0, 104, 0, 255]]));
  image(images, [solid(1, 1, BLUE)], { mipmap: false });
  const vertices: readonly MultitextureVertex[] = [
    { ...vertex(0, 0, 0, 0), texCoord2: { x: 0, y: 0 } },
    { ...vertex(8, 0, 4, 0, 4), texCoord2: { x: 0, y: 2 } },
    { ...vertex(0, 8, 0, 0), texCoord2: { x: 0, y: 0 } },
  ];
  const batch: DrawBatch = { ...quad({ kind: "bind-image", image: first }), texturing: "pair", vertices, indices: [0, 1, 2],
    secondTexture: { binding: { kind: "bind-image", image: second }, environment: "add" } };
  // Q=1-3*x/32, rho0=2/Q^2, rho1=.5/Q^2. An affine or U'/Q
  // approximation picks different levels. Secondary LOD uses height, not width.
  for (const indices of [[0, 1, 2], [2, 1, 0]]) {
    executeStaticBatch(cpu, { ...batch, indices });
    expect(pixel(cpu, 0, 0)).toEqual([22, 101, 0, 255]);
    expect(pixel(cpu, 4, 0)).toEqual([44, 102, 0, 255]);
    expect(pixel(cpu, 6, 0)).toEqual([55, 103, 0, 255]);
  }
  target.close();
});

test("triangle rho takes the larger screen-axis length after combining both texture components", () => {
  const { images, cpu, target } = fixture(), texture = image(images, levels(4, 4, [RED, GREEN, BLUE]));
  executeStaticBatch(cpu, quad({ kind: "bind-image", image: texture }, .25, .75));
  expect(pixel(cpu)).toEqual([...BLUE]); // max(1,3)=3, selected level 2.
  const diagonal = quad({ kind: "bind-image", image: texture }, .3);
  executeStaticBatch(cpu, { ...diagonal, vertices: diagonal.vertices.map(entry => ({ ...entry, texCoord: { x: entry.texCoord.x, y: entry.texCoord.x } })) });
  expect(pixel(cpu)).toEqual([...GREEN]); // One screen-axis vector has length sqrt(1.2^2+1.2^2).
  executeStaticBatch(cpu, quad({ kind: "bind-image", image: texture }, .3, .3));
  expect(pixel(cpu)).toEqual([...RED]); // Separate x and y vectors each have length 1.2.
  target.close();
});

function constantCoordinatePair(images: RendererImageCatalog, coordinate: number): MultitextureBatch {
  const red: [Rgba, ...Rgba[]] = [[10, 0, 0, 255]], green: [Rgba, ...Rgba[]] = [[0, 10, 0, 255]];
  for (let index = 1; index <= 10; index++) {
    red.push([10 + index * 10, 0, 0, 255]); green.push([0, 10 + index * 10, 0, 255]);
  }
  const first = image(images, levels(1024, 1, red)), second = image(images, levels(1, 1024, green));
  image(images, [solid(1, 1, BLUE)], { mipmap: false });
  return { ...quad({ kind: "bind-image", image: first }), texturing: "pair", indices: [0, 1, 2],
    vertices: [vertex(0, 0, coordinate, -coordinate), vertex(8, 0, coordinate, -coordinate, 4), vertex(0, 8, coordinate, -coordinate)]
      .map(entry => ({ ...entry, texCoord2: { x: -coordinate, y: coordinate } })),
    secondTexture: { binding: { kind: "bind-image", image: second }, environment: "add" } };
}

test("constant UVs have zero triangle rho despite large common offsets and perspective W", () => {
  for (const coordinate of [1e14, 1e15, 1e30].map(Math.fround)) {
    const { images, cpu, target } = fixture(), base = constantCoordinatePair(images, coordinate);
    for (const indices of [[0, 1, 2], [2, 1, 0]]) for (const clipping of ["none", "side", "near"]) {
      const vertices = base.vertices.map((entry, index) => {
        const point = clipping === "side" ? [vertex(-8, 0, 0, 0), vertex(8, 0, 0, 0, 4), vertex(-8, 32, 0, 0)][index] : undefined;
        return { ...entry, position: point?.position ?? (clipping === "near" && index === 0 ? { ...entry.position, z: -2 } : entry.position) };
      });
      cpu.beginView({ viewport: { x: 0, y: 0, width: 8, height: 8 }, clear: { color: { x: 0, y: 0, z: 0, w: 0 }, depth: 1, stencil: false } });
      executeStaticBatch(cpu, { ...base, vertices, indices });
      let covered = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const sample = pixel(cpu, x, y);
        if (sample[3] !== 0) { expect(sample).toEqual([10, 10, 0, 255]); covered++; }
      }
      expect(covered).toBeGreaterThan(0);
    }
    target.close();
  }
});

test("constant UVs have zero line rho after clipping and wide-line replication", () => {
  for (const coordinate of [1e14, 1e15, 1e30].map(Math.fround)) {
    const { images, cpu, target } = fixture(), base = constantCoordinatePair(images, coordinate);
    for (const left of [0, -8]) for (const lineWidth of [1, 3]) {
      const vertices = [vertex(left, 3.5, coordinate, -coordinate), vertex(8, 3.5, coordinate, -coordinate, 4)]
        .map(entry => ({ ...entry, texCoord2: { x: -coordinate, y: coordinate } }));
      executeStaticBatch(cpu, { ...base, primitive: "lines", lineWidth, vertices, indices: [0, 1] });
      for (const y of lineWidth === 1 ? [3] : [2, 3, 4]) for (let x = 0; x < 7; x++) expect(pixel(cpu, x, y)).toEqual([10, 10, 0, 255]);
    }
    target.close();
  }
});

test("offscreen triangle LOD retains the same pre-clip interpolation plane as its UVs", () => {
  const { images, cpu, target } = fixture();
  const texture = image(images, levels(16, 4, [[11, 0, 0, 255], [22, 0, 0, 255], [33, 0, 0, 255], [44, 0, 0, 255], [55, 0, 0, 255]]));
  executeStaticBatch(cpu, { ...quad({ kind: "bind-image", image: texture }),
    vertices: [vertex(-8, 0, 0, 0), vertex(8, 0, 4, 0, 4), vertex(-8, 32, 0, 0)], indices: [0, 1, 2] });
  // Original Q=1-3*(x+8)/64 and rho=1/Q^2 after side clipping.
  expect(pixel(cpu, 0, 0)).toEqual([22, 0, 0, 255]);
  expect(pixel(cpu, 4, 0)).toEqual([44, 0, 0, 255]);
  expect(pixel(cpu, 6, 0)).toEqual([44, 0, 0, 255]);
  target.close();
});

test("line and wide-line fragments consume both perspective derivatives with independent dimensions", () => {
  const { images, cpu, target } = fixture();
  const first = image(images, levels(16, 4, [[11, 0, 0, 255], [22, 0, 0, 255], [33, 0, 0, 255], [44, 0, 0, 255], [55, 0, 0, 255]]));
  const second = image(images, levels(2, 8, [[0, 101, 0, 255], [0, 102, 0, 255], [0, 103, 0, 255], [0, 104, 0, 255]]));
  image(images, [solid(1, 1, BLUE)], { mipmap: false });
  const vertices: readonly MultitextureVertex[] = [
    { ...vertex(0, 3.5, 0, 0), texCoord2: { x: 0, y: 0 } },
    { ...vertex(8, 3.5, 4, 0, 4), texCoord2: { x: 0, y: 2 } },
  ];
  for (const lineWidth of [1, 3]) {
    executeStaticBatch(cpu, { ...quad({ kind: "bind-image", image: first }), primitive: "lines", lineWidth,
      texturing: "pair", vertices, indices: [0, 1], secondTexture: { binding: { kind: "bind-image", image: second }, environment: "add" } });
    for (const y of lineWidth === 1 ? [3] : [2, 3, 4]) {
      expect(pixel(cpu, 0, y)).toEqual([22, 101, 0, 255]);
      expect(pixel(cpu, 4, y)).toEqual([44, 102, 0, 255]);
      expect(pixel(cpu, 6, y)).toEqual([55, 103, 0, 255]);
    }
  }
  target.close();
});

test("clipped lines normalize quotient derivatives by the clipped window length", () => {
  const { images, cpu, target } = fixture();
  const texture = image(images, levels(16, 4, [[11, 0, 0, 255], [22, 0, 0, 255], [33, 0, 0, 255], [44, 0, 0, 255], [55, 0, 0, 255]]));
  executeStaticBatch(cpu, { ...quad({ kind: "bind-image", image: texture }), primitive: "lines", lineWidth: 1,
    vertices: [vertex(-8, 3.5, 0, 0), vertex(8, 3.5, 4, 0, 4)], indices: [0, 1] });
  expect(pixel(cpu, 0, 3)).toEqual([22, 0, 0, 255]);
  expect(pixel(cpu, 4, 3)).toEqual([44, 0, 0, 255]);
  expect(pixel(cpu, 6, 3)).toEqual([44, 0, 0, 255]);
  target.close();
});

test("diagonal line rho uses Euclidean window length and wide fragments retain one derivative", () => {
  const fragments: LineFragment[] = [];
  const first = { ...vertex(0, 8, 0, 0), texCoord2: { x: 0, y: 0 } };
  const second = { ...vertex(8, 0, 2, 4), texCoord2: { x: 6, y: 8 } };
  rasterizeAliasedLine(first, second, 8, 8, 3, { minX: 0, minY: 0, maxX: 7, maxY: 7 }, fragment => fragments.push(fragment));
  expect(fragments.length).toBeGreaterThan(8);
  for (const fragment of fragments) {
    expect(fragment.texCoordDerivative.dsPerPixel).toBeCloseTo(2 / Math.sqrt(128), 14);
    expect(fragment.texCoordDerivative.dtPerPixel).toBeCloseTo(4 / Math.sqrt(128), 14);
    expect(fragment.texCoord2Derivative.dsPerPixel).toBeCloseTo(6 / Math.sqrt(128), 14);
    expect(fragment.texCoord2Derivative.dtPerPixel).toBeCloseTo(8 / Math.sqrt(128), 14);
  }
});

test("all uncompressed source internal formats convert independently at every uploaded level", () => {
  const cases: readonly [ImageInternalFormat, Rgba][] = [
    ["rgb", [18, 128, 249, 255]], ["rgb8", [18, 128, 249, 255]], ["rgb5", [16, 132, 247, 255]],
    ["rgba", [18, 128, 249, 128]], ["rgba8", [18, 128, 249, 128]], ["rgba4", [17, 136, 255, 136]],
  ];
  for (const [format, expected] of cases) {
    const { images, cpu, target } = fixture();
    const texture = image(images, levels(4, 4, [RED, [18, 128, 249, 128], BLUE]), { format });
    draw(cpu, texture, 2, 4); expect(pixel(cpu)).toEqual([...expected]); target.close();
  }
});

test("CPU rejects compressed diagnostic uploads without changing the framebuffer", () => {
  const { images, cpu, target } = fixture();
  try {
    const texture = image(images, [solid(1, 1, RED)], { filter: "nearest", mipmap: false });
    draw(cpu, texture);
    expect(() => image(images, [solid(1, 1, GREEN)], { format: "rgb4-s3tc", filter: "nearest", mipmap: false }))
      .toThrow("CPU texture storage does not support the rgb4-s3tc compressed diagnostic profile");
    expect(pixel(cpu)).toEqual([...RED]);
  } finally { target.close(); }
});

test("RGB5 codes are normalized before interpolation and vertex modulation, without byte expansion", () => {
  const { images, cpu, target } = fixture();
  const texture = image(images, levels(4, 4, [[4, 4, 4, 0], [16, 16, 16, 0], [25, 25, 25, 0]]),
    { format: "rgb5", filter: "nearest-mipmap-linear" });
  draw(cpu, texture, 2 ** 1.25, 4); expect(pixel(cpu)).toEqual([19, 19, 19, 255]); // 2.25/31, not a blend of bytes 16 and 25.
  draw(cpu, texture, 2, 4, .5, .5, { x: .7, y: .7, z: .7, w: .5 });
  expect(pixel(cpu)).toEqual([12, 12, 12, 128]); // 2/31 * .7, not 16/255 * .7.
  const bilinear = image(images, [{ width: 2, height: 1, pixels: new Uint8Array([16, 16, 16, 0, 25, 25, 25, 0]) }, solid(1, 1, RED)],
    { format: "rgb5", filter: "linear" });
  draw(cpu, bilinear, 0, 2, .375, .5); expect(pixel(cpu)).toEqual([19, 19, 19, 255]);
  target.close();
});

test("RGB formats retain incoming alpha in both units and every secondary environment", () => {
  for (const format of ["rgb", "rgb5", "rgb8"] satisfies readonly ImageInternalFormat[]) {
    const { images, cpu, target } = fixture();
    const texture = image(images, levels(2, 2, [[128, 128, 128, 0], [128, 128, 128, 0]]), { format });
    image(images, [solid(1, 1, RED)], { mipmap: false });
    for (const environment of ["modulate", "add", "replace"] satisfies readonly ("modulate" | "add" | "replace")[]) {
      const base = quad({ kind: "bind-image", image: texture }, 1, 0, .5, .5, { ...WHITE, w: .25 });
      executeStaticBatch(cpu, { ...base, texturing: "pair", vertices: base.vertices.map(entry => ({ ...entry, texCoord2: entry.texCoord })),
        secondTexture: { binding: { kind: "bind-image", image: texture }, environment } });
      expect(pixel(cpu)[3]).toBe(64);
    }
    target.close();
  }
});

test("paired triangle environments classify each reached RGB or RGBA image independently", () => {
  const { images, cpu, target } = fixture();
  const environments: readonly (readonly ["modulate" | "add" | "replace", readonly number[]])[] = [
    ["modulate", [32, 24, 36]], ["add", [192, 176, 240]], ["replace", [128, 128, 192]],
  ];
  for (const filter of ["nearest", "linear"] satisfies readonly TextureFilter[]) for (const primaryFormat of ["rgb8", "rgba8"] satisfies readonly ImageInternalFormat[]) {
    const first = image(images, [solid(1, 1, [128, 192, 64, 128])], { format: primaryFormat, filter });
    for (const secondaryFormat of ["rgb8", "rgba8"] satisfies readonly ImageInternalFormat[]) {
      const second = image(images, [solid(1, 1, [128, 128, 192, 96])], { format: secondaryFormat, filter });
      image(images, [solid(1, 1, RED)], { mipmap: false });
      for (const [environment, rgb] of environments) {
        const base = quad({ kind: "bind-image", image: first }, 0, 0, .5, .5, { x: .5, y: .25, z: .75, w: .5 });
        executeStaticBatch(cpu, { ...base, texturing: "pair", vertices: base.vertices.map(entry => ({ ...entry, texCoord2: entry.texCoord })),
          secondTexture: { binding: { kind: "bind-image", image: second }, environment } });
        const alpha = secondaryFormat === "rgb8" ? primaryFormat === "rgb8" ? 128 : 64
          : environment === "replace" ? 96 : primaryFormat === "rgb8" ? 48 : 24;
        expect(pixel(cpu)).toEqual([...rgb, alpha]);
      }
    }
  }
  target.close();
});

test("dirty cinematic writes convert into the actual level-zero format and preserve children", () => {
  const { images, cpu, target } = fixture();
  const texture = image(images, levels(2, 2, [RED, GREEN]), { format: "rgba4" });
  draw(cpu, texture);
  upload(cpu, texture, solid(2, 2, [18, 128, 249, 128]));
  draw(cpu, texture); expect(pixel(cpu)).toEqual([17, 136, 255, 136]);
  draw(cpu, texture, 2, 2); expect(pixel(cpu)).toEqual([0, 255, 0, 255]);
  target.close();
});

test("cinematic resize retains stale children, completeness follows actual dimensions, and a later resize restores them", () => {
  const { images, cpu, target } = fixture(), texture = image(images, levels(4, 4, [RED, GREEN, BLUE]), { format: "rgb8" });
  draw(cpu, texture); upload(cpu, texture, solid(2, 2, [100, 110, 120, 0]));
  draw(cpu, texture); expect(pixel(cpu)).toEqual([100, 110, 120, 255]);
  images.setTextureMode("GL_NEAREST_MIPMAP_NEAREST");
  draw(cpu, texture, 0, 2, .5, .5, { x: .25, y: .5, z: .75, w: .5 });
  expect(pixel(cpu)).toEqual([64, 128, 191, 128]); // Incomplete even during magnification.
  upload(cpu, texture, solid(4, 4, [100, 110, 120, 0])); images.setTextureMode("GL_NEAREST_MIPMAP_NEAREST");
  draw(cpu, texture, 2, 4); expect(pixel(cpu)).toEqual([0, 255, 0, 255]);
  draw(cpu, texture, 4, 4); expect(pixel(cpu)).toEqual([0, 0, 255, 255]);
  upload(cpu, texture, solid(1, 1, [70, 80, 90, 0])); images.setTextureMode("GL_NEAREST_MIPMAP_NEAREST");
  draw(cpu, texture, 100, 1); expect(pixel(cpu)).toEqual([70, 80, 90, 255]); // Children beyond q are irrelevant.
  target.close();
});

test("same-dimensional cinematic replacement still makes a chain incomplete when its internal format changes", () => {
  const { images, cpu, target } = fixture();
  const texture = image(images, levels(4, 4, [RED, GREEN, BLUE]), { format: "rgba8", sourceWidth: 8, sourceHeight: 8 });
  draw(cpu, texture); upload(cpu, texture, solid(4, 4, [70, 80, 90, 0]));
  images.setTextureMode("GL_LINEAR_MIPMAP_LINEAR");
  draw(cpu, texture); expect(pixel(cpu)).toEqual([255, 255, 255, 255]);
  images.setTextureMode("GL_NEAREST"); draw(cpu, texture); expect(pixel(cpu)).toEqual([70, 80, 90, 255]);
  target.close();
});

test("oversized same-source-size cinematic subimages preserve level zero and every child", () => {
  const { images, cpu, target } = fixture();
  const texture = image(images, levels(4, 4, [RED, GREEN, BLUE]), { sourceWidth: 8, sourceHeight: 8 });
  draw(cpu, texture); upload(cpu, texture, solid(8, 8, [100, 100, 100, 255]));
  draw(cpu, texture); expect(pixel(cpu)).toEqual([...RED]);
  draw(cpu, texture, 2, 4); expect(pixel(cpu)).toEqual([...GREEN]);
  draw(cpu, texture, 4, 4); expect(pixel(cpu)).toEqual([...BLUE]);
  target.close();
});

test("texture mode applies to the actual cached-bind target, including shared zero", () => {
  const { images, cpu, target } = fixture();
  const texture = image(images, levels(2, 1, [RED, GREEN]), { unit: 0 });
  upload(cpu, texture, { width: 4, height: 1, pixels: new Uint8Array([0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255, 255, 255, 255, 255, 255]) });
  executeStaticBatch(cpu, quad({ kind: "retain-current-texture" }, 0, 0, .25, .5)); expect(pixel(cpu)).toEqual([128, 128, 255, 255]);
  images.setTextureMode("GL_NEAREST");
  executeStaticBatch(cpu, quad({ kind: "retain-current-texture" }, 0, 0, .25, .5)); expect(pixel(cpu)).toEqual([255, 255, 255, 255]);
  images.setTextureMode("GL_NEAREST_MIPMAP_NEAREST");
  executeStaticBatch(cpu, quad({ kind: "retain-current-texture" }, 0, 0, .25, .5, { x: .25, y: .5, z: .75, w: 1 }));
  expect(pixel(cpu)).toEqual([64, 128, 191, 255]); // Zero has no child chain.
  const other = image(images, [solid(1, 1, BLUE)], { mipmap: false }); draw(cpu, other);
  draw(cpu, texture, 2, 2); expect(pixel(cpu)).toEqual([...GREEN]);
  target.close();
});

test("texture mode visits creation order on the actual current TMU and ignores nonmip metadata", () => {
  const { images, cpu, target } = fixture();
  image(images, [solid(1, 1, RED)], { unit: 0 });
  const lastMip = image(images, [solid(1, 1, GREEN)], { unit: 0, wrap: "clamp" });
  const nonmip = image(images, [solid(1, 1, BLUE)], { unit: 1, mipmap: false, filter: "nearest" });
  const white = image(images, [solid(1, 1, [255, 255, 255, 255])], { mipmap: false });
  image(images, [solid(1, 1, RED)], { mipmap: false });
  const base = quad({ kind: "bind-image", image: white });
  const pair: DrawBatch = { ...base, texturing: "pair", vertices: base.vertices.map(entry => ({ ...entry, texCoord2: { x: 0, y: 0 } })),
    secondTexture: { binding: { kind: "bind-image", image: nonmip }, environment: "modulate" } };
  const prepared = cpu.prepareGeometry(pair); prepared.begin();
  prepared.applyTexture(0, { kind: "bind-image", image: white }); prepared.applyTexture(1, { kind: "bind-image", image: nonmip });
  images.setTextureMode("GL_LINEAR"); prepared.draw(); prepared.cleanup();
  expect(pixel(cpu)).toEqual([0, 64, 0, 64]); // Last mip's retained clamp wrap, on unit 1.
  executeStaticBatch(cpu, quad({ kind: "retain-current-texture" })); expect(pixel(cpu)).toEqual([255, 255, 255, 255]);
  draw(cpu, lastMip, 0, 1, 0, 0); expect(pixel(cpu)).toEqual([0, 64, 0, 64]);
  draw(cpu, nonmip, 0, 1, 0, 0); expect(pixel(cpu)).toEqual([...BLUE]);
  target.close();
});

test("nonmip metadata leaves a one-level incomplete mip sampler outside later mode loops", () => {
  const { images, cpu, target } = fixture();
  const texture = image(images, [solid(4, 4, RED)], { mipmap: false, filter: "linear-mipmap-linear" });
  draw(cpu, texture); expect(pixel(cpu)).toEqual([255, 255, 255, 255]);
  images.setTextureMode("GL_NEAREST"); draw(cpu, texture); expect(pixel(cpu)).toEqual([255, 255, 255, 255]);
  target.close();
});

test("bad modes preserve active bindings and valid interleaved modes replay into a new backend", () => {
  const { images, cpu, target } = fixture();
  const first = image(images, levels(2, 2, [RED, GREEN]), { unit: 0, wrap: "clamp" });
  images.setTextureMode("GL_LINEAR"); // Changes raw-bound zero while cache still names first.
  const second = image(images, levels(2, 2, [BLUE, GREEN]), { unit: 0, wrap: "clamp" });
  images.setTextureMode("GL_LINEAR"); // First binds, then second binds in creation order.
  expect(images.setTextureMode("bad mode")).toBe(false);
  executeStaticBatch(cpu, quad({ kind: "retain-current-texture" }, 0, 0, 0, 0)); expect(pixel(cpu)).toEqual([0, 0, 64, 64]);
  target.close();
  const replayed = new SoftwareRenderer(8, 8, images), replayTarget = new RenderTarget(images, [replayed]);
  executeStaticBatch(replayed, quad({ kind: "retain-current-texture" }, 0, 0, 0, 0)); expect(pixel(replayed)).toEqual([0, 0, 64, 64]);
  draw(replayed, first, 0, 2, 0, 0); expect(pixel(replayed)).toEqual([64, 0, 0, 64]);
  draw(replayed, second, 0, 2, 0, 0); expect(pixel(replayed)).toEqual([0, 0, 64, 64]);
  replayTarget.close();
});

test("source-indeterminate current coordinates require a uniform proof over the whole converted chain", () => {
  const { images, cpu, target } = fixture();
  const varying = image(images, levels(4, 4, [RED, GREEN, BLUE]));
  draw(cpu, varying);
  const positions: readonly [Vec4, Vec4, Vec4, Vec4, Vec4, Vec4] = [vertex(0, 2, 0, 0).position, vertex(8, 2, 0, 0).position,
    vertex(0, 4, 0, 0).position, vertex(8, 4, 0, 0).position, vertex(0, 6, 0, 0).position, vertex(8, 6, 0, 0).position];
  expect(() => cpu.drawImmediate({ kind: "entity-axis", positions, whiteImage: varying })).toThrow("source-indeterminate");
  const converted = image(images, levels(4, 4, [[15, 15, 15, 0], [16, 16, 16, 100], [17, 17, 17, 255]]), { format: "rgb5" });
  draw(cpu, converted);
  expect(() => cpu.drawImmediate({ kind: "entity-axis", positions, whiteImage: converted })).not.toThrow();
  target.close();
});

test("catalog snapshots own every prepared mip before CPU storage conversion", () => {
  const { images, cpu, target } = fixture(), chain = levels(4, 4, [RED, GREEN, BLUE]);
  const texture = image(images, chain);
  for (const level of chain) level.pixels.fill(255);
  draw(cpu, texture, 2, 4); expect(pixel(cpu)).toEqual([...GREEN]);
  draw(cpu, texture, 4, 4); expect(pixel(cpu)).toEqual([...BLUE]);
  target.close();
});
