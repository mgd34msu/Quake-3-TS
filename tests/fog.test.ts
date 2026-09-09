import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { attenuateFogColor, createFogTexture, fogAdjustment, fogCoordinates, fogFactor, fogPassState, prepareFogVolume, shaderFogPass, shaderSort } from "../src/render/fog.ts";
import { inspectShaderScript, normalizeShaderName, parseShaderScript } from "../src/render/material.ts";
import type { ShaderDefinition, ShaderStage } from "../src/render/material.ts";

function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`missing fog test entry ${index}`);
  return value;
}

function map(visibleSide = 5): BspMap {
  return {
    entities: "", entityRecords: [], shaders: [], nodes: [], leaves: [], leafSurfaces: [], leafBrushes: [], models: [],
    planes: [
      { normal: { x: -1, y: 0, z: 0 }, distance: 100 }, { normal: { x: 1, y: 0, z: 0 }, distance: 100 },
      { normal: { x: 0, y: -1, z: 0 }, distance: 200 }, { normal: { x: 0, y: 1, z: 0 }, distance: 200 },
      { normal: { x: 0, y: 0, z: -1 }, distance: 300 }, { normal: { x: 0, y: 0, z: 1 }, distance: 0 },
    ],
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }],
    brushSides: Array.from({ length: 6 }, (_, plane) => ({ plane, shader: 0 })),
    vertices: [], indices: [], fogs: [{ shader: "fog", brush: 0, visibleSide }], surfaces: [], lightmaps: [], lightGrid: [], visibility: null,
  };
}

const parameters = { color: { x: 0.5, y: 0.25, z: 1 }, depthForOpaque: 256 };
const forward = { x: 1, y: 0, z: 0 };

function shader(stages: string, directives = ""): ShaderDefinition {
  return at(parseShaderScript(`test/fog\n{\n${directives}\n${stages}\n}`), 0);
}
function stage(blend: string): ShaderStage { return at(shader(`{\nmap $whiteimage\nblendFunc ${blend}\n}`).stages, 0); }

describe("source BSP fog volumes and coordinates", () => {
  test("loads source axial bounds, inward plane and byte colors", () => {
    const fog = prepareFogVolume(map(), 0, parameters);
    expect(fog.bounds).toEqual({ min: { x: -100, y: -200, z: -300 }, max: { x: 100, y: 200, z: 0 } });
    expect(fog.surface).toEqual({ normal: { x: 0, y: 0, z: -1 }, distance: -0 });
    expect(fog.color).toEqual({ x: 127 / 255, y: 63 / 255, z: 1, w: 1 });
    expect(fog.tcScale).toBe(1 / 2048);
    expect(prepareFogVolume(map(), 0, { ...parameters, depthForOpaque: 0 }).tcScale).toBe(1 / 8);
  });
  test("inside camera fog depth switches at the actual volume plane", () => {
    const fog = prepareFogVolume(map(), 0, parameters), coordinates = fogCoordinates(fog, { x: 16, y: 0, z: -10 }, forward);
    expect(coordinates({ x: 144, y: 0, z: -20 })).toEqual({ x: 128 / 2048 + 1 / 512, y: 31 / 32 });
    expect(coordinates({ x: 144, y: 0, z: 0 }).y).toBe(31 / 32);
    expect(coordinates({ x: 144, y: 0, z: 1 }).y).toBe(1 / 32);
    expect(fogFactor(coordinates({ x: -100, y: 0, z: -10 }).x, 31 / 32)).toBe(0);
  });
  test("outside camera clips the ray length and preserves the source one-unit threshold", () => {
    const fog = prepareFogVolume(map(), 0, parameters), coordinates = fogCoordinates(fog, { x: 0, y: 0, z: 10 }, forward);
    expect(coordinates({ x: 256, y: 0, z: -10 })).toEqual({ x: 1 / 8 + 1 / 512, y: 0.5 });
    expect(coordinates({ x: 256, y: 0, z: -0.5 }).y).toBe(1 / 32);
    expect(coordinates({ x: 256, y: 0, z: 1 }).y).toBe(1 / 32);
    expect(coordinates({ x: 256, y: 0, z: -1 }).y).toBeCloseTo(1 / 32 + 30 / 32 / 11, 7);
    expect(fogFactor(1 / 8 + 1 / 512, 0.5)).toBe(Math.fround(Math.sqrt(Math.fround(127 / 255))));
  });
  test("non-surface fog defines the source's documented constant interior depth", () => {
    const fog = prepareFogVolume(map(-1), 0, parameters);
    for (const z of [-1000, 0, 1000]) {
      const coordinates = fogCoordinates(fog, { x: 0, y: 0, z }, forward);
      for (const pointZ of [-1000, 0, 1000]) expect(coordinates({ x: 128, y: 0, z: pointZ })).toEqual({ x: 128 / 2048 + 1 / 512, y: 31 / 32 });
    }
  });
  test("surface coordinates match the unchanged native RB_CalcFogTexCoords fixture", () => {
    // Original tr_shade_calc.c compiled outside the project against tr_local.h,
    // gcc -std=gnu99 -O0. Decimal output uses nine significant float digits.
    const fog = prepareFogVolume(map(), 0, parameters);
    const probes = [
      { cameraX: 16, cameraZ: -10, x: 144, z: -20, s: 0.064453125, t: 0.96875 },
      { cameraX: 16, cameraZ: -10, x: 144, z: 0, s: 0.064453125, t: 0.96875 },
      { cameraX: 16, cameraZ: -10, x: 144, z: 1, s: 0.064453125, t: 0.03125 },
      { cameraX: 0, cameraZ: 10, x: 256, z: -10, s: 0.126953125, t: 0.5 },
      { cameraX: 0, cameraZ: 10, x: 256, z: -0.5, s: 0.126953125, t: 0.03125 },
      { cameraX: 0, cameraZ: 10, x: 256, z: -1, s: 0.126953125, t: 0.116477273 },
    ];
    for (const probe of probes) {
      const coordinates = fogCoordinates(fog, { x: probe.cameraX, y: 0, z: probe.cameraZ }, forward);
      expect(coordinates({ x: probe.x, y: 0, z: probe.z })).toEqual({ x: Math.fround(probe.s), y: Math.fround(probe.t) });
    }
  });
});

describe("fog lookup and material passes", () => {
  test("quantizes source fog density and texture alpha independently", () => {
    expect(fogFactor(0, 1)).toBe(0);
    expect(fogFactor(1, 0)).toBe(0);
    expect(fogFactor(1 / 512 + 1 / 32, 31 / 32)).toBe(Math.fround(Math.sqrt(Math.fround(63 / 255))));
    expect(fogFactor(1 / 512 + 1 / 8, 31 / 32)).toBe(1);
    expect(fogFactor(8, 31 / 32)).toBe(1);
    const image = createFogTexture();
    expect([image.width, image.height]).toEqual([256, 32]);
    expect(image.pixels[3]).toBe(0);
    expect(image.pixels[((31 * 256) + 32) * 4 + 3]).toBe(255);
    expect(image.pixels[((31 * 256) + 8) * 4 + 3]).toBe(Math.trunc(Math.fround(255 * Math.fround(Math.sqrt(Math.fround(63 / 255))))));
  });
  test("attenuates only source-compatible transparent blend modes", () => {
    const opaque = at(shader("{\nmap $whiteimage\n}").stages, 0);
    const add = stage("add"), blend = stage("blend"), premultiplied = stage("GL_ONE GL_ONE_MINUS_SRC_ALPHA"), filter = stage("filter");
    expect(fogAdjustment(add, opaque)).toBe("none");
    expect(fogAdjustment(add, add)).toBe("rgb");
    expect(fogAdjustment(blend, blend)).toBe("alpha");
    expect(fogAdjustment(premultiplied, premultiplied)).toBe("rgba");
    expect(fogAdjustment(filter, filter)).toBe("none");
    const color = { x: 1, y: 128 / 255, z: 64 / 255, w: 200 / 255 }, coordinates = { x: 1, y: 31 / 32 };
    expect(attenuateFogColor(color, "rgb", coordinates)).toEqual({ x: 0, y: 0, z: 0, w: 200 / 255 });
    expect(attenuateFogColor(color, "alpha", coordinates)).toEqual({ ...color, w: 0 });
    expect(attenuateFogColor(color, "rgba", coordinates)).toEqual({ x: 0, y: 0, z: 0, w: 0 });
  });
  test("fog-only materials sort after banners and use less-equal depth without depth writes", () => {
    const fogOnly = shader("", "surfaceParm fog\nfogparms ( 0.5 0.25 1 ) 256");
    expect(shaderSort(fogOnly)).toBe(7);
    expect(shaderFogPass(fogOnly)).toBe("less-equal");
    expect(shaderFogPass(shader("{\nmap $whiteimage\n}"))).toBe("equal");
    expect(shaderFogPass(shader("{\nmap $whiteimage\nblendFunc add\n}"))).toBe("none");
    const state = fogPassState("less-equal", "none");
    expect(state).toEqual({ blend: { source: "src-alpha", destination: "one-minus-src-alpha" }, depthTest: "less-equal", depthWrite: false,
      alphaTest: "none", cull: "none" });
  });
});

const dataPath = process.env["Q3_DATA"];
test.skipIf(dataPath === undefined)("all mounted retail BSP fog volumes resolve their shader parameters", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const products: readonly ("baseq3" | "missionpack")[] = ["baseq3", "missionpack"];
  for (const product of products) {
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product }), definitions = new Map<string, ShaderDefinition>();
    for (const path of vfs.list("scripts/").filter(path => path.endsWith(".shader"))) {
      for (const entry of inspectShaderScript(new TextDecoder().decode(await vfs.read(path)), path).entries) {
        if (entry.textResult.kind === "accepted" && !definitions.has(entry.name)) {
          definitions.set(entry.name, entry.textResult.definition);
        }
      }
    }
    let count = 0;
    for (const path of vfs.list("maps/").filter(path => path.endsWith(".bsp"))) {
      const map = parseBsp(await vfs.read(path), path);
      for (const [index, entry] of map.fogs.entries()) {
        const parameters = definitions.get(normalizeShaderName(entry.shader))?.fog;
        if (parameters === null || parameters === undefined) throw new Error(`${path}: missing fogparms ${entry.shader}`);
        const fog = prepareFogVolume(map, index, parameters);
        expect(fog.bounds.min.x).toBeLessThanOrEqual(fog.bounds.max.x);
        expect(fog.bounds.min.y).toBeLessThanOrEqual(fog.bounds.max.y);
        expect(fog.bounds.min.z).toBeLessThanOrEqual(fog.bounds.max.z);
        expect(Number.isFinite(fog.tcScale)).toBe(true);
        count++;
      }
    }
    expect(count).toBeGreaterThan(0);
  }
}, 20000);
