import { describe, expect, test } from "bun:test";
import type { BspLightGridPoint, BspMap } from "../src/assets/bsp.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import type { Axis, Bounds, Vec3 } from "../src/core/math.ts";
import { vec3 } from "../src/core/math.ts";
import type { EntityLightingState, LightGrid, LightingEntity, LightingSample } from "../src/render/lighting.ts";
import { lightForPoint, prepareLightGrid, RF_LIGHTING_ORIGIN, RF_MINLIGHT, setupEntityLighting } from "../src/render/lighting.ts";
import { createModelEntity, RF_FIRST_PERSON } from "../src/render/ref-entity.ts";
import { SourceSceneEntities } from "../src/render/scene-entities.ts";

const zero = vec3(0, 0, 0);
const identityAxis: Axis = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
const sourceBounds: Bounds = { min: zero, max: vec3(64, 64, 128) };
const scales = { ambientScale: 0.75, directedScale: 1.25 };
const unitScales = { ambientScale: 1, directedScale: 1 };
const point = vec3(16, 24, 40);
const unchangedOverbright = { mapOverbrightBits: 2, overbrightBits: 2 };

function sourceSamples(): BspLightGridPoint[] {
  return Array.from({ length: 8 }, (_, i) => ({
    ambient: vec3(10 + 7 * i, 20 + 5 * i, 30 + 3 * i),
    directed: vec3(40 + 2 * i, 50 + 4 * i, 60 + 6 * i), latLong: { x: i * 23, y: i * 31 },
  }));
}

function fixture(samples = sourceSamples(), bounds = sourceBounds, entityRecords: BspMap["entityRecords"] = []): BspMap {
  return {
    entities: "", entityRecords, shaders: [], planes: [], nodes: [], leaves: [], leafSurfaces: [], leafBrushes: [],
    models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: samples, visibility: null,
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required lighting fixture value missing");
  return value;
}

function grid(map = fixture()): LightGrid { return required(prepareLightGrid(map, unchangedOverbright).grid); }
function sample(lightGrid: LightGrid, position = point): LightingSample { return required(lightForPoint(lightGrid, position, scales)); }
function state(lightGrid: LightGrid | null = null): EntityLightingState {
  return { grid: lightGrid, noWorldModel: false, ...scales, identityLight: 1, identityLightByte: 255, sunDirection: vec3(0, 0, 1), dynamicLights: [] };
}
function entity(origin = point, renderFlags = 0, lightingOrigin = zero): LightingEntity {
  return { origin, lightingOrigin, renderFlags, axis: identityAxis };
}
function nativeVec(x: number, y: number, z: number): Vec3 { return vec3(x, y, z); }

describe("source BSP light-grid preparation", () => {
  test("derives default grid origin and extents from world model zero", () => {
    const lightGrid = grid(fixture(sourceSamples(), { min: vec3(-70, 1, -130), max: vec3(1, 130, 1) }));
    expect(lightGrid.origin).toEqual(vec3(-64, 64, -128));
    expect(lightGrid.bounds).toEqual(vec3(2, 2, 2));
    expect(lightGrid.size).toEqual(vec3(64, 64, 128));
    expect(lightGrid.inverseSize).toEqual(vec3(1 / 64, 1 / 64, 1 / 128));
  });
  test("only the first entity defines case-insensitive gridsize and partial scanf values", () => {
    const records = [new Map([["GRIDsize", "32 16 64 ignored"]]), new Map([["gridsize", "1 1 1"]])];
    const custom = grid(fixture(sourceSamples(), { min: zero, max: vec3(32, 16, 64) }, records));
    expect(custom.size).toEqual(vec3(32, 16, 64));
    const hex = grid(fixture(sourceSamples(), { min: zero, max: vec3(32, 16, 64) }, [new Map([["gridsize", "0x20 0x1.0p4 +0x.8p7"]])]));
    expect(hex.size).toEqual(custom.size);
    const partial = grid(fixture(sourceSamples(), { min: zero, max: vec3(32, 64, 128) }, [new Map([["gridsize", "32 invalid 4"]])]));
    expect(partial.size).toEqual(vec3(32, 64, 128));
    expect(grid(fixture(sourceSamples(), sourceBounds, [new Map([["gridsize", "bad"]])])).size).toEqual(vec3(64, 64, 128));
  });
  test("normalizes overbright colors using integer ratios without mutating BSP samples", () => {
    const sample: BspLightGridPoint = { ambient: vec3(100, 75, 25), directed: vec3(15, 30, 63), latLong: { x: 137, y: 251 } };
    const map = fixture(Array.from({ length: 8 }, () => sample));
    const prepared = required(prepareLightGrid(map, { mapOverbrightBits: 2, overbrightBits: 0 }).grid);
    expect(prepared.samples[0]).toEqual({ ambient: vec3(255, 191, 63), directed: vec3(60, 120, 252), latLong: sample.latLong });
    expect(map.lightGrid[0]).toEqual(sample);
    expect(prepared.samples).not.toBe(map.lightGrid);
    expect(prepared.samples[0]).not.toBe(sample);
    expect(required(prepared.samples[0]).latLong).not.toBe(sample.latLong);
    expect(() => prepareLightGrid(map, { mapOverbrightBits: 0, overbrightBits: 2 })).toThrow("undefined source C");
    expect(() => prepareLightGrid(map, { mapOverbrightBits: 16, overbrightBits: 0 })).toThrow("undefined source C");
  });
  test("disables mismatched or invalid grids explicitly, including no-light maps", () => {
    const missing = prepareLightGrid(fixture([]), unchangedOverbright);
    expect(missing.grid).toBeNull();
    expect(missing.diagnostics).toEqual(["Light grid mismatch: expected 8 samples, found 0"]);
    expect(lightForPoint(missing.grid, point, scales)).toBeNull();
    for (const value of ["0 64 128", "-1 64 128", "nan 64 128", "1e99 64 128"]) {
      const invalid = prepareLightGrid(fixture(sourceSamples(), sourceBounds, [new Map([["gridsize", value]])]), unchangedOverbright);
      expect(invalid.grid).toBeNull();
      expect(invalid.diagnostics).toEqual(["Invalid worldspawn gridsize: dimensions must be finite and positive"]);
    }
    const invalidBounds = prepareLightGrid(fixture([], { min: vec3(1, 1, 1), max: vec3(2, 2, 2) }), unchangedOverbright);
    expect(invalidBounds.grid).toBeNull();
    expect(invalidBounds.diagnostics[0]).toContain("bounds");
  });
});

describe("R_SetupEntityLightingGrid and R_LightForPoint", () => {
  test("ordinary in-bounds interpolation matches unchanged native source float values", () => {
    // External fixture links original tr_light.c and q_math.c with tr_local.h,
    // gcc -std=gnu99 -O0, and the exact tr_init.c sine-table expression.
    // Native output uses nine significant decimal digits, enough to recover f32.
    expect(sample(grid())).toEqual({
      ambientLight: nativeVec(19.3125, 23.4375, 27.5625),
      directedLight: nativeVec(55.625, 73.75, 91.875),
      lightDir: nativeVec(-0.309157342, 0.742938876, 0.593686402),
    });
  });
  test("wall samples are excluded and surviving contributions normalize in source order", () => {
    const samples = sourceSamples();
    samples[0] = { ...required(samples[0]), ambient: zero };
    expect(sample(grid(fixture(samples)))).toEqual({
      ambientLight: nativeVec(24.9293938, 27.4495659, 29.969738),
      directedLight: nativeVec(58.2997093, 79.0994186, 99.8991318),
      lightDir: nativeVec(-0.373180002, 0.896792293, -0.237697914),
    });
    const walls = grid(fixture(samples.map(value => ({ ...value, ambient: zero }))));
    expect(sample(walls)).toEqual({ ambientLight: zero, directedLight: zero, lightDir: zero });
    const constant = samples.map(value => ({ ...value, ambient: vec3(100, 100, 100) }));
    constant[0] = { ...required(constant[0]), ambient: zero };
    const threshold = grid(fixture(constant));
    expect(required(lightForPoint(threshold, vec3(63.5, 0, 0), unitScales)).ambientLight.x).toBe(99.21875);
    expect(required(lightForPoint(threshold, vec3(63, 0, 0), unitScales)).ambientLight.x).toBe(Math.fround(98.4375 * Math.fround(64 / 63)));
  });
  test("retains the source fractional coordinate below the lower boundary", () => {
    const lightGrid = grid();
    expect(sample(lightGrid, vec3(-16, 24, 40))).toEqual(sample(lightGrid, vec3(48, 24, 40)));
  });
  test("upper X and Y corners use source linear aliases within the sample allocation", () => {
    const samples = Array.from({ length: 27 }, (_, index) => ({
      ambient: vec3(index + 1, (index + 1) * 2, (index + 1) * 3),
      directed: vec3((index + 1) * 4, (index + 1) * 5, (index + 1) * 6), latLong: { x: 0, y: 0 },
    }));
    const lightGrid = grid(fixture(samples, { min: zero, max: vec3(128, 128, 256) }));
    expect(required(lightForPoint(lightGrid, vec3(160, 16, 32), unitScales))).toEqual({
      ambientLight: vec3(6.5, 13, 19.5), directedLight: vec3(26, 32.5, 39), lightDir: vec3(0, 0, 1),
    });
    expect(required(lightForPoint(lightGrid, vec3(0, 160, 32), unitScales)).ambientLight).toEqual(vec3(10.75, 21.5, 32.25));
    const reads: number[] = [];
    const observed = { ...lightGrid, samples: lightGrid.samples.map((value, index) => ({
      get ambient() { reads.push(index); return value.ambient; }, directed: value.directed, latLong: value.latLong,
    })) };
    expect(required(lightForPoint(observed, vec3(128, 0, 0), unitScales)).ambientLight).toEqual(vec3(3, 6, 9));
    expect([...new Set(reads)]).toEqual([2, 3, 5, 6, 11, 12, 14, 15]);
  });
  test("only out-of-allocation corners retain the replicated-edge safety profile", () => {
    const lightGrid = grid();
    for (const x of [64, 128]) {
      expect(required(lightForPoint(lightGrid, vec3(x, 0, 0), unitScales)).ambientLight).toEqual(required(lightGrid.samples[1]).ambient);
    }
    expect(required(lightForPoint(lightGrid, vec3(96, 0, 0), unitScales)).ambientLight).toEqual(vec3(20.5, 27.5, 34.5));
    expect(required(lightForPoint(lightGrid, vec3(64, 64, 128), unitScales)).ambientLight).toEqual(required(lightGrid.samples[7]).ambient);
    expect(required(lightForPoint(lightGrid, vec3(96, 96, 192), unitScales)).ambientLight).toEqual(required(lightGrid.samples[7]).ambient);
    const singleton = grid(fixture([required(sourceSamples()[0])], { min: zero, max: zero }));
    expect(sample(singleton, zero)).toEqual(sample(singleton, vec3(150, -300, 1024)));
    expect(() => sample(lightGrid, vec3(Number.NaN, 0, 0))).toThrow("finite");
  });
});

describe("R_SetupEntityLighting", () => {
  test("LogLight preserves integer comparisons, the skipped blue branch and first-person gating", () => {
    const messages: string[] = [];
    const diagnostics = { enabled: true, print: (text: string): undefined => { messages.push(text); } };
    for (const [ambient, directed, expected] of [
      [vec3(10.8, 20.2, 100), vec3(20.8, 30.2, 200), "amb:52  dir:30\n"],
      [vec3(10.8, 10.2, 100), vec3(20.8, 20.2, 200), "amb:42  dir:20\n"],
      [vec3(10.8, 9.2, 100), vec3(20.8, 19.2, 200), "amb:132  dir:200\n"],
    ] satisfies readonly (readonly [Vec3, Vec3, string])[]) {
      const lightGrid = { ...grid(), samples: Array.from({ length: 8 }, () => ({ ambient, directed, latLong: { x: 0, y: 0 } })) };
      const input = { ...state(lightGrid), ...unitScales };
      setupEntityLighting(entity(zero, RF_FIRST_PERSON), input, undefined, diagnostics);
      expect(messages.at(-1)).toBe(expected);
      const count = messages.length;
      setupEntityLighting(entity(zero), input, undefined, diagnostics);
      setupEntityLighting(entity(zero, RF_FIRST_PERSON), input, undefined, { ...diagnostics, enabled: false });
      expect(messages).toHaveLength(count);
    }
  });

  test("LogLight exposes retained partial state, preserves an interrupted packet and does not repeat for cached cells", () => {
    const owner = new SourceSceneEntities(), model = createModelEntity();
    model.axis = identityAxis;
    owner.addRefEntity(model);
    const cell = owner.sceneRange().entity(0);
    cell.setupLighting({ ...state(), identityLight: 0.5 });
    owner.rolloverFrame();
    owner.addRefEntity(model);
    cell.entity.renderFlags = RF_FIRST_PERSON;
    let prints = 0;
    const failure = new Error("lighting print stopped");
    const diagnostics = { enabled: true, print(text: string): undefined {
      prints++;
      expect(text).toBe("amb:128  dir:150\n");
      expect(cell.lightingCalculated).toBe(true);
      expect(cell.lighting.ambientLight).toEqual(vec3(128, 128, 128));
      expect(cell.lighting.directedLight).toEqual(vec3(150, 150, 150));
      expect(cell.lighting.lightDir).toEqual(vec3(0, 1, 0));
      expect(cell.lighting.ambientLightInt).toBe(0xff5b5b5b);
      throw failure;
    } };
    expect(() => cell.setupLighting({ ...state(), identityLightByte: 128, sunDirection: vec3(0, 1, 0) }, diagnostics)).toThrow(failure);
    expect(cell.lighting.ambientLightInt).toBe(0xff5b5b5b);
    expect(cell.setupLighting(state(), diagnostics)).toBe(cell.lighting);
    expect(prints).toBe(1);
  });

  test("the lighting tail reads callback changes to retained ambient and entity axes", () => {
    const owner = new SourceSceneEntities(), model = createModelEntity();
    model.axis = identityAxis;
    model.renderFlags = RF_FIRST_PERSON;
    owner.addRefEntity(model);
    const cell = owner.sceneRange().entity(0);
    const result = cell.setupLighting(state(), { enabled: true, print(): undefined {
      owner.backendMemory.entityData(0).setFloat32(164, 7.75, true);
      if (cell.entity.kind !== "model") throw new Error("Expected model entity");
      cell.entity.axis = [vec3(0, 0, 1), vec3(0, 1, 0), vec3(1, 0, 0)];
    } });
    expect(result.ambientLightInt).toBe(0xffb6b607);
    expect(result.lightDir).toEqual(vec3(1, 0, 0));
  });

  test("native fixture matches minimum add, dynamic attenuation, local axis and byte packet", () => {
    const axis: Axis = [vec3(0, 1, 0), vec3(-1, 0, 0), vec3(0, 0, 1)];
    const result = setupEntityLighting({ ...entity(), axis }, {
      ...state(grid()), dynamicLights: [{ origin: vec3(80, 56, 72), radius: 128, color: vec3(1, 0.5, 0.25) }],
    });
    expect(result).toEqual({
      ambientLight: nativeVec(51.3125, 55.4375, 59.5625), directedLight: nativeVec(98.2916641, 95.0833282, 102.541664),
      lightDir: nativeVec(0.769061327, 0.0366403572, 0.63812387), ambientLightInt: 4282070835,
    });
  });
  test("minimum lighting is unconditional and only ambient is upper-clamped", () => {
    const lightGrid = grid();
    expect(setupEntityLighting(entity(), state(lightGrid))).toEqual(setupEntityLighting(entity(point, RF_MINLIGHT), state(lightGrid)));
    const result = setupEntityLighting(entity(), { ...state(lightGrid), ambientScale: 100, directedScale: 100, identityLightByte: 128 });
    expect(result.ambientLight).toEqual(vec3(128, 128, 128));
    expect(result.ambientLightInt).toBe(0xff808080);
    expect(result.directedLight.x).toBeGreaterThan(255);
    const negative = setupEntityLighting(entity(), { ...state(lightGrid), ambientScale: -10 });
    expect(negative.ambientLight.x).toBeLessThan(0);
    expect(negative.ambientLightInt & 255).toBe(Math.trunc(negative.ambientLight.x) & 255);
  });
  test("lightingOrigin affects both grid and dynamic lighting, without changing the entity", () => {
    const lightState = { ...state(grid()), dynamicLights: [{ origin: vec3(128, 0, 0), radius: 128, color: vec3(1, 1, 1) }] };
    const alternate = entity(vec3(-500, -500, -500), RF_LIGHTING_ORIGIN, point);
    expect(setupEntityLighting(alternate, lightState)).toEqual(setupEntityLighting(entity(), lightState));
    expect(alternate.origin).toEqual(vec3(-500, -500, -500));
    expect(setupEntityLighting(entity(point, 0, vec3(32, 32, 64)), lightState)).toEqual(setupEntityLighting(entity(), lightState));
  });
  test("no-world and absent-grid paths use identity light and sun direction, not cvar scales", () => {
    const settings = { ...state(grid()), noWorldModel: true, identityLight: 0.5, identityLightByte: 127, ambientScale: 100, directedScale: 0 };
    const result = setupEntityLighting(entity(), settings);
    expect(result.ambientLight).toEqual(vec3(91, 91, 91));
    expect(result.directedLight).toEqual(vec3(75, 75, 75));
    expect(result.lightDir).toEqual(vec3(0, 0, 1));
    expect(result.ambientLightInt).toBe(0xff5b5b5b);
    expect(result).toEqual(setupEntityLighting(entity(), { ...settings, noWorldModel: false, grid: null }));
    const scaledAxis: Axis = [vec3(0, 0, 2), vec3(0, 1, 0), vec3(-1, 0, 0)];
    expect(setupEntityLighting({ ...entity(), axis: scaledAxis }, settings).lightDir).toEqual(vec3(2, 0, 0));
  });
  test("dynamic inverse-square lighting has a 16-unit floor and no entity radius cutoff", () => {
    for (const [distance, expected] of [[0, 1024], [8, 1024], [16, 1024], [128, 16], [256, 4]]) {
      if (distance === undefined || expected === undefined) throw new Error("Invalid dynamic-light fixture");
      const result = setupEntityLighting(entity(zero), {
        ...state(), identityLight: 0,
        dynamicLights: [{ origin: vec3(distance, 0, 0), radius: 128, color: vec3(1, 0.5, 0.25) }],
      });
      expect(result.directedLight).toEqual(vec3(expected, expected / 2, expected / 4));
      expect(result.lightDir).toEqual(distance === 0 ? zero : vec3(1, 0, 0));
    }
  });
});

const dataPath = process.env["Q3_DATA"];
test.skipIf(dataPath === undefined)("all mounted retail maps prepare independent grids and sample their full layouts safely", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const products: readonly ("baseq3" | "missionpack")[] = ["baseq3", "missionpack"];
  for (const product of products) {
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    let mapCount = 0, sampleCount = 0;
    for (const path of vfs.list("maps/").filter(path => path.endsWith(".bsp"))) {
      const map = parseBsp(await vfs.read(path), path);
      const prepared = prepareLightGrid(map, { mapOverbrightBits: 2, overbrightBits: 0 });
      if (prepared.grid === null) {
        // Shipped missionpack/texturegrab has no light-grid lump. The source
        // warns about its 320-point mismatch and uses identity/sun lighting.
        expect(map.lightGrid.length).toBe(0);
        expect(prepared.diagnostics.length).toBe(1);
        expect(required(prepared.diagnostics[0])).toStartWith("Light grid mismatch:");
        expect(setupEntityLighting(entity(), state(prepared.grid))).toEqual(setupEntityLighting(entity(), state(null)));
        mapCount++;
        continue;
      }
      expect(prepared.diagnostics).toEqual([]);
      const lightGrid = required(prepared.grid);
      expect(lightGrid.samples.length).toBe(map.lightGrid.length);
      expect(lightGrid.bounds.x * lightGrid.bounds.y * lightGrid.bounds.z).toBe(map.lightGrid.length);
      expect(lightGrid.samples).not.toBe(map.lightGrid);
      // Every stored color/direction byte must remain valid after preparation.
      for (const [i, shifted] of lightGrid.samples.entries()) {
        const original = required(map.lightGrid[i]);
        if (shifted.latLong.x !== original.latLong.x || shifted.latLong.y !== original.latLong.y) throw new Error(`${path}: changed grid direction bytes`);
        for (const channel of [shifted.ambient.x, shifted.ambient.y, shifted.ambient.z, shifted.directed.x, shifted.directed.y, shifted.directed.z]) {
          if (!Number.isInteger(channel) || channel < 0 || channel > 255) throw new Error(`${path}: invalid prepared grid color ${channel}`);
        }
      }
      // Visit interior cells across each axis, all corners, and beyond both
      // boundaries. Upper samples exercise the explicit safety correction.
      for (const fraction of [-0.25, 0, 0.125, 0.5, 0.875, 1, 1.25]) {
        const position = vec3(
          lightGrid.origin.x + fraction * (lightGrid.bounds.x - 1) * lightGrid.size.x,
          lightGrid.origin.y + fraction * (lightGrid.bounds.y - 1) * lightGrid.size.y,
          lightGrid.origin.z + fraction * (lightGrid.bounds.z - 1) * lightGrid.size.z,
        );
        const result = required(lightForPoint(lightGrid, position, unitScales));
        for (const value of [result.ambientLight, result.directedLight, result.lightDir]) {
          expect([value.x, value.y, value.z].every(Number.isFinite)).toBe(true);
        }
      }
      for (const x of [0, lightGrid.bounds.x - 1]) for (const y of [0, lightGrid.bounds.y - 1]) for (const z of [0, lightGrid.bounds.z - 1]) {
        const result = required(lightForPoint(lightGrid, vec3(lightGrid.origin.x + x * lightGrid.size.x, lightGrid.origin.y + y * lightGrid.size.y, lightGrid.origin.z + z * lightGrid.size.z), unitScales));
        expect([result.ambientLight.x, result.directedLight.x, result.lightDir.x].every(Number.isFinite)).toBe(true);
      }
      mapCount++;
      sampleCount += lightGrid.samples.length;
    }
    expect(mapCount).toBeGreaterThan(30);
    expect(sampleCount).toBeGreaterThan(10000);
  }
}, 30000);
