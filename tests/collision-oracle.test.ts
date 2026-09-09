import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pk3Archive } from "../src/assets/pk3.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import type { TraceResult, TraceShape } from "../src/collision/world.ts";
import { createBoxModel, createCapsuleModel } from "../src/collision/model.ts";
import type { TemporaryTraceQuery } from "../src/collision/model.ts";
import type { Bounds, Vec3 } from "../src/core/math.ts";
import { vec3 } from "../src/core/math.ts";

interface OracleCase {
  readonly kind: "world" | "box" | "capsule" | "patches";
  readonly query: TemporaryTraceQuery;
  readonly bounds: Bounds;
  readonly origin: Vec3;
  readonly angles: Vec3;
}

function oracleLine(value: OracleCase): string {
  const shape = value.query.shape;
  const vectors = [value.query.start, value.query.end, shape.kind === "point" ? vec3(0, 0, 0) : shape.mins,
    shape.kind === "point" ? vec3(0, 0, 0) : shape.maxs, value.bounds.min, value.bounds.max, value.origin, value.angles];
  return [value.kind === "world" ? 0 : value.kind === "box" ? 1 : value.kind === "capsule" ? 2 : 3, shape.kind === "capsule" ? 1 : 0,
    value.query.mask, ...vectors.flatMap(vector => [vector.x, vector.y, vector.z])].join(" ");
}

function compareOracle(executable: string, mapPath: string, cases: readonly OracleCase[], world: CollisionWorld, patchWorld = world): number {
  const processResult = Bun.spawnSync([executable, mapPath], { stdin: new TextEncoder().encode(cases.map(oracleLine).join("\n") + "\n"), stdout: "pipe", stderr: "pipe" });
  if (processResult.exitCode !== 0) throw new Error(`original collision oracle failed: ${new TextDecoder().decode(processResult.stderr)}`);
  expect(processResult.exitCode).toBe(0);
  const lines = new TextDecoder().decode(processResult.stdout).trim().split("\n");
  expect(lines.length).toBe(cases.length);
  const mismatches: string[] = [];
  let patchHits = 0;
  for (const [index, candidate] of cases.entries()) {
    const line = lines[index];
    if (line === undefined) throw new Error(`oracle missing output ${index}`);
    const values = line.split(" ").map(Number);
    const [fraction, startSolid, allSolid, contents, surfaceFlags, x, y, z, nx, ny, nz, distance] = values;
    if (values.length !== 12 || fraction === undefined || startSolid === undefined || allSolid === undefined || contents === undefined || surfaceFlags === undefined || x === undefined || y === undefined || z === undefined || nx === undefined || ny === undefined || nz === undefined || distance === undefined || values.some(value => !Number.isFinite(value))) throw new Error(`malformed oracle output ${line}`);
    const actual: TraceResult = candidate.kind === "world" || candidate.kind === "patches" ? (candidate.kind === "world" ? world : patchWorld).transformedTrace(candidate.query, candidate.origin, candidate.angles)
      : (candidate.kind === "box" ? createBoxModel(candidate.bounds) : createCapsuleModel(candidate.bounds)).transformedTrace(candidate.query, candidate.origin, candidate.angles);
    const solidity = allSolid !== 0 ? "all-solid" : startSolid !== 0 ? "start-solid" : "clear";
    if (candidate.kind === "patches" && fraction < 1) patchHits++;
    // cm_trace.c invalidates the impact plane for all-solid and fraction-one results.
    const hasPlane = allSolid === 0 && fraction < 1 && (nx !== 0 || ny !== 0 || nz !== 0);
    const badPlane = (actual.contact.kind === "plane") !== hasPlane || (actual.contact.kind === "plane" && (Math.abs(actual.contact.plane.normal.x - nx) > 0.001 || Math.abs(actual.contact.plane.normal.y - ny) > 0.001 || Math.abs(actual.contact.plane.normal.z - nz) > 0.001 || Math.abs(actual.contact.plane.distance - distance) > 0.05));
    // Bound endpoint error by the existing fraction tolerance over each axis of travel,
    // plus binary32 storage and the oracle's nine-significant-digit output rounding.
    const endTolerance = (start: number, end: number): number => Math.abs(end - start) * 0.00001 + Math.max(1, Math.abs(start), Math.abs(end)) * 0.0000002;
    const badEnd = Math.abs(actual.end.x - x) > endTolerance(candidate.query.start.x, candidate.query.end.x)
      || Math.abs(actual.end.y - y) > endTolerance(candidate.query.start.y, candidate.query.end.y)
      || Math.abs(actual.end.z - z) > endTolerance(candidate.query.start.z, candidate.query.end.z);
    if (Math.abs(actual.fraction - fraction) > 0.00001 || actual.solidity !== solidity || actual.contents !== contents || actual.surfaceFlags !== surfaceFlags || badPlane || badEnd) {
      mismatches.push(JSON.stringify({ index, case: candidate, expected: { fraction, solidity, contents, surfaceFlags, end: [x, y, z], hasPlane, normal: [nx, ny, nz], distance }, actual }));
    }
  }
  expect(mismatches.slice(0, 12)).toEqual([]);
  return patchHits;
}

test.skipIf(process.env["QUAKE3_COLLISION_ORACLE"] === undefined)("differential collision against separately built original C oracle", async () => {
  const executable = process.env["QUAKE3_COLLISION_ORACLE"];
  if (executable === undefined) throw new Error("missing explicit original collision oracle");
  const directory = await mkdtemp(join(tmpdir(), "quake3-collision-differential-"));
  try {
    const root = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
    using archive = await Pk3Archive.open(`${root}/baseq3/pak0.pk3`);
    const data = await archive.read("maps/q3dm1.bsp");
    const mapPath = join(directory, "q3dm1.bsp");
    await Bun.write(mapPath, data);
    const map = parseBsp(data);
    const world = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
    const patchWorld = new CollisionWorld({ ...map, shaders: [...map.shaders, { name: "disabled-brushes", contentFlags: 0, surfaceFlags: 0 }],
      brushes: map.brushes.map(brush => ({ ...brush, shader: map.shaders.length })) }, { kind: "unaccounted" }, { kind: "disabled" });
    const cases: OracleCase[] = [];
    let seed = 0x5132;
    const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
    const zero = vec3(0, 0, 0);
    const bounds = { min: vec3(-10, -10, -20), max: vec3(10, 10, 20) };
    const shapes: TraceShape[] = [{ kind: "point" }, { kind: "box", mins: vec3(-2, -2, -4), maxs: vec3(2, 2, 4) },
      { kind: "capsule", mins: vec3(-2, -2, -4), maxs: vec3(2, 2, 4) }];
    for (const kind of ["world", "box", "capsule", "patches"] satisfies OracleCase["kind"][]) {
      for (const shape of shapes) for (let i = 0; i < 64; i++) {
        const start = kind === "world" || kind === "patches" ? vec3(100 + random() * 1100, 500 + random() * 1900, -50 + random() * 550)
          : vec3(random() * 60 - 30, random() * 60 - 30, random() * 80 - 40);
        const end = i % 8 === 0 ? start : kind === "world" || kind === "patches" ? vec3(start.x + random() * 1024 - 512, start.y + random() * 1024 - 512, start.z + random() * 1024 - 512)
          : vec3(random() * 60 - 30, random() * 60 - 30, random() * 80 - 40);
        cases.push({ kind, query: { start, end, shape, mask: -1 }, bounds, origin: zero, angles: zero });
      }
    }
    for (const kind of ["box", "capsule"] satisfies OracleCase["kind"][]) for (const shape of shapes) for (let i = 0; i < 32; i++) {
      const start = vec3(random() * 60 - 30, random() * 60 - 30, random() * 80 - 40);
      const end = i % 8 === 0 ? start : vec3(random() * 60 - 30, random() * 60 - 30, random() * 80 - 40);
      cases.push({ kind, query: { start, end, shape, mask: -1 }, bounds: { min: vec3(-7, -12, -16), max: vec3(13, 8, 24) },
        origin: vec3(5, 3, -2), angles: vec3(i % 2 === 0 ? 45 : 0, i % 3 === 0 ? 90 : 0, i % 4 === 0 ? 30 : 0) });
    }
    cases.push({ kind: "capsule", query: { start: zero, end: zero, shape: { kind: "box", mins: vec3(17, -1, -1), maxs: vec3(19, 1, 1) }, mask: -1 },
      bounds: { min: vec3(-5, -5, -20), max: vec3(5, 5, 20) }, origin: zero, angles: vec3(90, 0, 0) });
    const patchHits = compareOracle(executable, mapPath, cases, world, patchWorld);
    expect(patchHits).toBeGreaterThan(10);
  } finally {
    await rm(directory, { recursive: true });
  }
}, 30_000);

for (const mapName of ["q3dm1", "q3dm2"]) {
  test.skipIf(process.env["QUAKE3_COLLISION_ORACLE"] === undefined)(`retail ${mapName} ${mapName === "q3dm1" ? "stairs" : "water"} point/box/capsule sweeps against original C`, async () => {
    const executable = process.env["QUAKE3_COLLISION_ORACLE"];
    if (executable === undefined) throw new Error("missing explicit original collision oracle");
    const directory = await mkdtemp(join(tmpdir(), "quake3-collision-retail-"));
    try {
      const root = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
      using archive = await Pk3Archive.open(`${root}/baseq3/pak0.pk3`);
      const data = await archive.read(`maps/${mapName}.bsp`);
      const mapPath = join(directory, `${mapName}.bsp`);
      await Bun.write(mapPath, data);
      const map = parseBsp(data);
      const world = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
      const zero = vec3(0, 0, 0);
      const shapes: TraceShape[] = [{ kind: "point" },
        { kind: "box", mins: vec3(-2, -2, -4), maxs: vec3(2, 2, 4) },
        { kind: "capsule", mins: vec3(-2, -2, -4), maxs: vec3(2, 2, 4) }];
      const cases: OracleCase[] = [];
      const trace = (query: TemporaryTraceQuery): TraceResult => {
        cases.push({ kind: "world", query, bounds: { min: zero, max: zero }, origin: zero, angles: zero });
        return world.transformedTrace(query, zero, zero);
      };
      for (const shape of shapes) {
        const verticalExtent = shape.kind === "point" ? 0 : 4;
        const horizontalExtent = shape.kind === "point" ? 0 : 2;
        if (mapName === "q3dm1") {
          // pak0 q3dm1 brushes 847-849: real adjacent 16-wide treads rising 8 units.
          for (const step of [{ brush: 847, y: 2216, z: 8 }, { brush: 848, y: 2232, z: 16 }, { brush: 849, y: 2248, z: 24 }]) {
            const brush = map.brushes[step.brush];
            if (brush === undefined) throw new Error(`missing retail stair brush ${step.brush}`);
            expect(map.shaders[brush.shader]?.name).toBe("textures/gothic_floor/xstairtop4");
            const tread = trace({ start: vec3(1116, step.y, 64), end: vec3(1116, step.y, -16), shape, mask: 1 });
            expect(tread.solidity).toBe("clear");
            expect(tread.contents).toBe(1);
            expect(tread.contact).toEqual({ kind: "plane", plane: { normal: vec3(0, 0, 1), distance: step.z } });
            expect(tread.end).toEqual(vec3(1116, step.y, step.z + verticalExtent + 0.125));
            const riser = trace({ start: vec3(1116, step.y - 20, step.z - 2), end: vec3(1116, step.y + 2, step.z - 2), shape, mask: 1 });
            expect(riser.solidity).toBe("clear");
            expect(riser.contents).toBe(1);
            expect(riser.contact).toEqual({ kind: "plane", plane: { normal: vec3(0, -1, 0), distance: -(step.y - 8) } });
            expect(riser.end).toEqual(vec3(1116, step.y - 8 - horizontalExtent - 0.125, step.z - 2));
          }
        } else {
          // pak0 q3dm2 brush 1155 is calm_poollight WATER, with its top at z=-122.
          const brush = map.brushes[1155];
          if (brush === undefined) throw new Error("missing retail water brush");
          expect(map.shaders[brush.shader]).toEqual({ name: "textures/liquids/calm_poollight", contentFlags: 536870944, surfaceFlags: 17408 });
          const above = vec3(-2048, -1800, -100);
          const inside = vec3(-2048, -1800, -138);
          expect(world.pointContents(above)).toBe(0);
          expect(world.pointContents(inside)).toBe(536870944);
          const entry = trace({ start: above, end: inside, shape, mask: 32 });
          expect(entry.solidity).toBe("clear");
          expect(entry.contents).toBe(536870944);
          expect(entry.surfaceFlags).toBe(17408);
          expect(entry.contact).toEqual({ kind: "plane", plane: { normal: vec3(0, 0, 1), distance: -122 } });
          expect(entry.end).toEqual(vec3(inside.x, inside.y, -122 + verticalExtent + 0.125));
          const exit = trace({ start: inside, end: above, shape, mask: 32 });
          expect(exit).toEqual({ fraction: 1, end: above, solidity: "start-solid", contact: { kind: "none" }, contents: 0, surfaceFlags: 0 });
          for (const end of [inside, vec3(inside.x + 16, inside.y, inside.z)]) {
            const submerged = trace({ start: inside, end, shape, mask: 32 });
            expect(submerged).toEqual({ fraction: 0, end: inside, solidity: "all-solid", contact: { kind: "none" }, contents: 536870944, surfaceFlags: 0 });
          }
          const ignoreWater = trace({ start: above, end: inside, shape, mask: 1 });
          expect(ignoreWater).toEqual({ fraction: 1, end: inside, solidity: "clear", contact: { kind: "none" }, contents: 0, surfaceFlags: 0 });
          expect(trace({ start: above, end: inside, shape, mask: 33 })).toEqual(entry);
        }
      }
      expect(cases.length).toBe(18);
      compareOracle(executable, mapPath, cases, world);
    } finally {
      await rm(directory, { recursive: true });
    }
  }, 30_000);
}
