import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BspVertex } from "../src/assets/bsp.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { ReadFileMemory } from "../src/assets/read-file-memory.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { vec3 } from "../src/core/math.ts";
import { ZoneArena, ZoneTag } from "../src/core/zone.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import { SourceBspResource } from "../src/render/bsp-resource.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { finishImplicitShader } from "../src/render/material-finish.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import { createPatchGrid, preparePatchGrids, selectPatchLod } from "../src/render/patch-lod.ts";
import type { PatchGrid } from "../src/render/patch-lod.ts";
import { insertPatchStrip, tessellatePatch, TemporaryPatchMesh } from "../src/render/patch.ts";
import type { PatchMesh } from "../src/render/patch.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError("fixture index");
  return value;
}

function vertex(x: number, y: number, z = 0): BspVertex {
  return { position: vec3(x, y, z), normal: vec3(0, 0, 1), texCoord: { x, y },
    lightmapCoord: { x: x * 0.5, y: y * 0.5 }, color: { x: x * 10, y: 20, z: 30, w: 255 } };
}

function mesh(xs: readonly number[], ys: readonly number[], widthLodError: readonly number[],
  heightLodError: readonly number[] = ys.map(() => 0)): PatchMesh {
  const width = xs.length, height = ys.length, indices: number[] = [];
  for (let y = 0; y < height - 1; y++) for (let x = 0; x < width - 1; x++) {
    const a = y * width + x, b = a + width;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return { width, height, vertices: ys.flatMap(y => xs.map(x => vertex(x, y))), indices, widthLodError, heightLodError };
}

function grid(value: PatchMesh): PatchGrid { return createPatchGrid(value, [vec3(-10, 0, 0), vec3(10, 0, 0)]); }

describe("source patch stitching and shared errors", () => {
  test("inserts one missing edge vertex, interpolates attributes and synchronizes the source error", () => {
    const source = mesh([0, 1, 2], [0, 2], [0, 0.25, 0]);
    const target = mesh([0, 2], [0, -2], [0, 0]);
    const result = preparePatchGrids([grid(source), grid(target)]);
    const stitched = at(result, 1).mesh;
    expect(stitched.width).toBe(3);
    expect(stitched.height).toBe(2);
    expect(at(stitched.vertices, 1)).toEqual({ ...vertex(1, 0), normal: vec3(0, 0, -1) });
    expect(at(stitched.vertices, 4).position).toEqual(vec3(1, -2, 0));
    expect(stitched.widthLodError).toEqual([0, 0.25, 0]);
    expect(stitched.indices).toEqual([0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5]);
    expect(target.width).toBe(2);
  });

  test("column and row insertions anchor only the matched edge and rebuild normals", () => {
    const source = mesh([0, 2], [0, 2], [0, 0]);
    const column = insertPatchStrip(source, "width", 1, 0, vec3(1, 0, 2), 0.125);
    expect(at(column.vertices, 1).position).toEqual(vec3(1, 0, 2));
    expect(at(column.vertices, 4).position).toEqual(vec3(1, 2, 0));
    expect(at(column.vertices, 1).normal.z).toBeGreaterThan(0);
    const row = insertPatchStrip(source, "height", 1, 1, vec3(2, 1, 3), 0.25);
    expect(at(row.vertices, 2).position).toEqual(vec3(0, 1, 0));
    expect(at(row.vertices, 3).position).toEqual(vec3(2, 1, 3));
    expect(row.heightLodError).toEqual([0, 0.25, 0]);
    expect(() => insertPatchStrip(source, "height", 0, 1, vec3(0, 0, 0), 1)).toThrow(RangeError);
  });

  test("error propagation follows surface order and recurses across the group", () => {
    const a = grid(mesh([0, 1, 2], [0, 2], [0, 0.125, 0]));
    const b = grid(mesh([0, 1, 2], [0, -2], [0, 8, 0]));
    const c = grid(mesh([0, 1, 2], [-2, -4], [0, 16, 0]));
    const result = preparePatchGrids([a, b, c]);
    expect(result.map(value => value.mesh.widthLodError)).toEqual([[0, 0.125, 0], [0, 0.125, 0], [0, 0.125, 0]]);
    expect(b.mesh.widthLodError).toEqual([0, 8, 0]);
    const reversed = preparePatchGrids([c, b, a]);
    expect(reversed.map(value => value.mesh.widthLodError)).toEqual([[0, 16, 0], [0, 16, 0], [0, 16, 0]]);
  });

  test("stitches width edges to height edges and copies their LOD errors", () => {
    const source = grid(mesh([0, 1, 2], [0, 2], [0, 0.125, 0]));
    const targetMesh = mesh([0, 2], [0, 2], [0, 0]);
    const target = grid({ ...targetMesh, vertices: targetMesh.vertices.map(v => ({ ...v, position: vec3(v.position.y, -v.position.x, 0) })) });
    const result = at(preparePatchGrids([source, target]), 1).mesh;
    expect([result.width, result.height]).toEqual([2, 3]);
    expect(at(result.vertices, 2).position).toEqual(vec3(1, 0, 0));
    expect(result.heightLodError).toEqual([0, 0.125, 0]);
  });

  test("honors the 65-column cap and includes a 0.1 coordinate match only within tolerance", () => {
    const source = grid(mesh([0, 1, 2], [0, 2], [0, 0.125, 0]));
    const capped = grid(mesh(Array.from({ length: 65 }, (_, i) => i * 2), [0, -2], new Array<number>(65).fill(0)));
    expect(at(preparePatchGrids([source, capped]), 1).mesh.width).toBe(65);
    const near = grid(mesh([0, 2], [Math.fround(0.099), -2], [0, 0]));
    expect(at(preparePatchGrids([source, near]), 1).mesh.width).toBe(3);
    const beyond = grid(mesh([0, 2], [Math.fround(0.101), -2], [0, 0]));
    expect(at(preparePatchGrids([source, beyond]), 1).mesh.width).toBe(2);
  });

  test("does not synchronize merged interior points or distinct LOD groups", () => {
    const source = grid(mesh([0, 1, 1, 2], [0, 2], [0, 0.25, 0.25, 0]));
    const target = grid(mesh([0, 1, 2], [0, -2], [0, 8, 0]));
    expect(at(preparePatchGrids([source, target]), 1).mesh.widthLodError).toEqual([0, 8, 0]);
    const group = { ...target, lodRadius: 11 };
    expect(at(preparePatchGrids([grid(mesh([0, 1, 2], [0, 2], [0, 0.25, 0])), group]), 1).mesh.widthLodError).toEqual([0, 8, 0]);
  });

  test("repairs only the undefined reverse lookup using its matched geometric midpoint", () => {
    const result = preparePatchGrids([grid(mesh([0, 1, 2], [0, 2], [0, 0.25, 0])),
      grid(mesh([2, 0], [0, -2], [0, 0]))]);
    const target = at(result, 1);
    expect(target.mesh.widthLodError).toEqual([0, 0.25, 0]);
    expect(target.mesh.vertices.slice(0, 3).map(v => v.position)).toEqual([vec3(2, 0, 0), vec3(1, 0, 0), vec3(0, 0, 0)]);
    expect(selectPatchLod(target, target.lodOrigin, vec3(0, 0, 0), vec3(1, 0, 0), 250).width).toBe(3);
  });

  test("preserves the source k+1 error for an in-bounds reversed triple", () => {
    const result = preparePatchGrids([grid(mesh([2, 0], [0, -2], [0, 0])),
      grid(mesh([0, 1, 2, 3, 4], [0, 2], [0, 0.125, 0, 0.5, 0]))]);
    const target = at(result, 0).mesh;
    expect(target.vertices.slice(0, 3).map(v => v.position)).toEqual([vec3(2, 0, 0), vec3(1, 0, 0), vec3(0, 0, 0)]);
    expect(target.widthLodError).toEqual([0, 0.5, 0]);
    expect(at(result, 1).mesh.widthLodError).toEqual([0, 0.5, 0, 0.5, 0]);
  });

  test("repaired reverse seams select the same edge points at different distances", () => {
    const result = preparePatchGrids([grid(mesh([2, 0], [0, -2], [0, 0])),
      grid(mesh([0, 1, 2], [0, 2], [0, 0.25, 0]))]);
    expect(result.map(value => value.mesh.widthLodError)).toEqual([[0, 0.25, 0], [0, 0.25, 0]]);
    for (const distance of [0, 1010, 2010]) {
      const selected = result.map(value => selectPatchLod(value, value.lodOrigin, vec3(distance, 0, 0), vec3(1, 0, 0), 250));
      const target = at(selected, 0), source = at(selected, 1);
      expect(target.vertices.slice(0, target.width).map(v => v.position).reverse())
        .toEqual(source.vertices.slice(0, source.width).map(v => v.position));
      expect(target.width).toBe(distance > 1010 ? 2 : 3);
    }
  });

  test("source subdivision transposes and reverses a taller grid before calculating normals", () => {
    const points = Array.from({ length: 9 }, (_, i) => vertex(i % 3 * 2, Math.floor(i / 3) * 2, Math.floor(i / 3) === 1 ? 8 : 0));
    const result = tessellatePatch(points, 3, 3);
    expect([result.width, result.height]).toEqual([3, 2]);
    expect(result.vertices.map(value => value.position)).toEqual([
      vec3(0, 4, 0), vec3(0, 2, 4), vec3(0, 0, 0), vec3(4, 4, 0), vec3(4, 2, 4), vec3(4, 0, 0),
    ]);
    expect(result.widthLodError).toEqual([0, 0.25, 0]);
  });
});

describe("source distance LOD selection", () => {
  const value = grid(mesh([0, 1, 2, 3, 4], [0, 1, 2], [0, 0.5, 0, 0.25, 0], [0, 0.25, 0]));
  test("uses absolute forward distance minus radius and includes equality", () => {
    const result = selectPatchLod(value, vec3(0, 0, 0), vec3(1010, 9000, 0), vec3(1, 0, 0), 250);
    expect([result.width, result.height]).toEqual([4, 3]);
    expect(result.vertices.slice(0, 4).map(v => v.position.x)).toEqual([0, 2, 3, 4]);
    expect(result.indices.slice(0, 6)).toEqual([0, 4, 1, 1, 4, 5]);
    expect(selectPatchLod(value, vec3(0, 0, 0), vec3(-1010, 0, 0), vec3(1, 0, 0), 250)).toEqual(result);
  });
  test("clamps distances inside the volume and negative cvars retain zero-error rows", () => {
    expect(selectPatchLod(value, value.lodOrigin, vec3(0, 0, 0), vec3(1, 0, 0), 250)).toBe(value.mesh);
    const result = selectPatchLod(value, value.lodOrigin, vec3(0, 0, 0), vec3(1, 0, 0), -1);
    expect([result.width, result.height]).toEqual([3, 2]);
    expect(result.vertices.map(v => v.position)).toEqual([vec3(0, 0, 0), vec3(2, 0, 0), vec3(4, 0, 0), vec3(0, 2, 0), vec3(2, 2, 0), vec3(4, 2, 0)]);
  });
  test("uses the supplied transformed volume center", () => {
    expect(selectPatchLod(value, vec3(1010, 0, 0), vec3(0, 0, 0), vec3(1, 0, 0), 250).width).toBe(4);
  });
  test("rounds the volume and division at the source float32 storage boundaries", () => {
    const third = grid(mesh([0, 1, 2], [0, 2], [0, Math.fround(1 / 3), 0]));
    expect(selectPatchLod(third, third.lodOrigin, vec3(13, 0, 0), vec3(1, 0, 0), 1).width).toBe(3);
    const volume = createPatchGrid(third.mesh, [vec3(16777216, 0, 0), vec3(16777218, 0, 0)]);
    expect(volume.lodOrigin).toEqual(vec3(16777216, 0, 0));
    expect(volume.lodRadius).toBe(0);
  });
});

describe("source zone patch records", () => {
  test("self-stitching retains its selected LOD group after retiring the original allocation", () => {
    const zone = new ZoneArena(8192), profile = { kind: "source-zone", zone } satisfies Parameters<typeof TemporaryPatchMesh.create>[1];
    const folded = { ...mesh([0, 1, 2], [0, 2], [0, 0.25, 0]),
      vertices: [vertex(0, 0), vertex(1, 1), vertex(2, 0), vertex(2, 0), vertex(3, 2), vertex(4, 0)] };
    const source = grid(TemporaryPatchMesh.create(folded, profile));
    const targetMesh = mesh([0, 2], [0, -2], [0, 0]);
    const target = grid(TemporaryPatchMesh.create(targetMesh, profile));
    const other = createPatchGrid(TemporaryPatchMesh.create(targetMesh, profile), [vec3(-20, 0, 0), vec3(20, 0, 0)]);
    const oldOrigin = source.lodOrigin, oldVertex = at(source.mesh.vertices, 0), publications: string[] = [];
    try {
      const prepared = preparePatchGrids([source, target, other], count => { publications.push(`stitched ${count}`); }, (index, replacement) => {
        publications.push(`replace ${index}`);
        expect(replacement.lodOrigin).toEqual(vec3(0, 0, 0));
        expect(replacement.lodRadius).toBe(10);
        expect(() => source.lodRadius).toThrow("no longer valid");
        expect(() => oldOrigin.x).toThrow("no longer valid");
        expect(() => oldVertex.position.x).toThrow("no longer valid");
      });
      expect(publications).toEqual(["replace 0", "replace 1", "stitched 2"]);
      const stitched = at(prepared, 0).mesh, joined = at(prepared, 1).mesh;
      expect([stitched.width, stitched.height]).toEqual([3, 3]);
      expect(stitched.vertices.map(value => value.position)).toEqual([
        vec3(0, 0, 0), vec3(1, 1, 0), vec3(2, 0, 0),
        vec3(1, 1, 0), vec3(2, 1.5, 0), vec3(3, 0, 0),
        vec3(2, 0, 0), vec3(3, 2, 0), vec3(4, 0, 0),
      ]);
      expect([...stitched.widthLodError]).toEqual([0, 0.25, 0]);
      expect([...stitched.heightLodError]).toEqual([0, 0.25, 0]);
      expect([joined.width, joined.height]).toEqual([3, 2]);
      expect(joined.vertices.slice(0, 3).map(value => value.position)).toEqual([vec3(0, 0, 0), vec3(1, 1, 0), vec3(2, 0, 0)]);
      expect([...joined.widthLodError]).toEqual([0, 0.25, 0]);
      expect(at(prepared, 2)).toBe(other);
      expect(other.mesh.width).toBe(2);
      zone.checkHeap(); zone.freeTags(ZoneTag.Renderer);
      expect(zone.memoryRemaining()).toBe(8192);
    } finally { zone.dispose(); }
  });

  test("the BSP loader publishes temporary stitched grids and transfers their actual records to hunk memory", async () => {
    const zone = new ZoneArena(8192), arena = new HunkArena(8192, () => undefined), accounting = new SourceHunkAccounting(arena);
    const bytes = new Uint8Array(144 + 72 + 18 * 44 + 2 * 104), disk = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode("IBSP")); disk.setInt32(4, 46, true);
    function lump(index: number, offset: number, length: number): void {
      disk.setInt32(8 + index * 8, offset, true); disk.setInt32(12 + index * 8, length, true);
    }
    lump(1, 144, 72); bytes.set(new TextEncoder().encode("fixture/patch"), 144);
    lump(10, 216, 18 * 44); lump(13, 216 + 18 * 44, 2 * 104);
    for (let surface = 0; surface < 2; surface++) {
      const output = 216 + 18 * 44 + surface * 104;
      disk.setInt32(output + 4, -1, true); disk.setInt32(output + 8, 2, true);
      disk.setInt32(output + 12, surface * 9, true); disk.setInt32(output + 16, 9, true); disk.setInt32(output + 28, -1, true);
      disk.setFloat32(output + 60, -10, true); disk.setFloat32(output + 72, 10, true);
      disk.setInt32(output + 96, 3, true); disk.setInt32(output + 100, 3, true);
      for (let point = 0; point < 9; point++) {
        const offset = 216 + (surface * 9 + point) * 44;
        disk.setFloat32(offset, point % 3, true);
        disk.setFloat32(offset + 4, Math.floor(point / 3) * (surface === 0 ? 1 : -1), true);
        disk.setFloat32(offset + 8, surface === 0 && point % 3 === 1 ? 8 : 0, true);
        disk.setFloat32(offset + 36, 1, true); bytes.fill(255, offset + 40, offset + 44);
      }
    }
    const files = new ReadFileMemory(() => arena), file = files.read(bytes.length, target => { target.set(bytes); });
    const settings = createRendererSettings(), images = new RendererImageCatalog(), builtins = new BuiltinImages(images, identityImageUploadProfile);
    const materials = new MaterialRegistry(async name => ({ definition: null, image: builtins.defaultImage, whiteImage: builtins.defaultImage,
      defaulted: false, sky: null, finished: finishImplicitShader({ name, profile: settings.registrationProfile(), kind: "default",
        baseImage: { kind: "loaded", tmu: 0, binding: { kind: "images", playback: { kind: "single", image: { image: builtins.defaultImage } } } } }) }),
    () => undefined);
    const material = await materials.register("fixture/patch", { kind: "none" });
    const before = zone.memoryRemaining(), prints: string[] = [];
    const source = new SourceBspResource(file, "fixture.bsp", { kind: "source-hunk", accounting }, text => {
      prints.push(text);
      if (text.startsWith("stitched")) {
        expect(zone.memoryRemaining()).toBeLessThan(before);
        expect([...source.patches.values()].map(value => value.mesh.width)).toEqual([3, 3]);
        const patch = source.patches.get(1);
        if (patch === undefined) throw new Error("BSP stitching did not publish its replacement patch");
        expect(at(source.geometry, 1) === patch.mesh).toBe(true);
        expect(at(at(source.geometry, 1).vertices, 1).position).toEqual(vec3(1, 0, 4));
        expect(accounting.report().trace.some(row => row.source === "R_MovePatchSurfacesToHunk:grid")).toBe(false);
      }
      return undefined;
    }, { kind: "source-zone", zone });
    source.begin(); source.loadShaders();
    await source.loadSurfaces({ defaultMaterial: material, findShader: async () => material, profile: () => settings.bspProfile(), colorShift: () => 0 });
    expect(prints).toEqual(["stitched 1 LoD cracks\n", "...loaded 0 faces, 2 meshes, 0 trisurfs, 0 flares\n"]);
    expect(zone.memoryRemaining()).toBe(before);
    expect(accounting.report().trace.filter(row => row.source === "R_MovePatchSurfacesToHunk:grid").map(row => row.bytes)).toEqual([356, 356]);
    source.setSurfaceDlightBits(1, 0, 37); source.setSurfaceDlightBits(1, 1, 91);
    expect(source.surfaceDlightBits(1, 0)).toBe(37); expect(source.surfaceDlightBits(1, 1)).toBe(91);
    files.freeFile(file);
    const point = at(at(source.geometry, 1).vertices, 1);
    expect(point.position).toEqual(vec3(1, 0, 4));
    arena.clear(null);
    expect(() => point.position.x).toThrow("no longer valid");
    zone.dispose();
  });

  test("subdivision results and shared errors read the actual TAG_RENDERER allocations", () => {
    const zone = new ZoneArena(4096), general = zone.allocate(32, ZoneTag.General);
    const before = zone.memoryRemaining();
    const points = Array.from({ length: 9 }, (_, i) => vertex(i % 3 * 2, Math.floor(i / 3) * 2, i % 3 === 1 ? 8 : 0));
    const detached = tessellatePatch(points, 3, 3);
    const allocated = TemporaryPatchMesh.create(detached, { kind: "source-zone", zone });
    expect(allocated.vertices).toEqual(detached.vertices);
    expect([...allocated.widthLodError]).toEqual([...detached.widthLodError]);
    expect(allocated.block.bytes.length).toBe(92 + 44 * 6);
    expect(before - zone.memoryRemaining()).toBe(448);
    const words = new DataView(allocated.block.bytes.buffer), errorAddress = allocated.block.view.getInt32(84, true);
    words.setFloat32(errorAddress + 4, 0.75, true);
    expect([...allocated.widthLodError]).toEqual([0, 0.75, 0]);
    allocated.widthLodError[1] = 0.125;
    expect(words.getFloat32(errorAddress + 4, true)).toBe(0.125);
    allocated.block.view.setFloat32(92, 27, true);
    expect(at(allocated.vertices, 0).position.x).toBe(27);
    const borrowed = at(allocated.vertices, 0);
    zone.freeTags(ZoneTag.Renderer);
    expect(zone.memoryRemaining()).toBe(before);
    expect(general.bytes.length).toBe(32);
    expect(() => allocated.width).toThrow("no longer valid");
    expect(() => borrowed.position.x).toThrow("no longer valid");
    expect(() => allocated.widthLodError[1]).toThrow("no longer valid");
    zone.dispose();
  });

  test("a stitched replacement frees the old three blocks before requesting the new grid", () => {
    const zone = new ZoneArena(544);
    const old = TemporaryPatchMesh.create(mesh([0, 2], [0, 2], [0, 0]), { kind: "source-zone", zone });
    old.setLodVolume(vec3(12, 24, 36), 48); old.lodFixed = 2; old.lodStitched = true;
    const borrowed = at(old.vertices, 0);
    const replacement = insertPatchStrip(old, "width", 1, 0, vec3(1, 0, 2), 0.125);
    if (!(replacement instanceof TemporaryPatchMesh)) throw new Error("Stitch lost its source zone owner");
    expect(replacement.width).toBe(3);
    expect(replacement.lodOrigin).toEqual(vec3(12, 24, 36));
    expect(replacement.lodRadius).toBe(48);
    expect(replacement.lodFixed).toBe(0); expect(replacement.lodStitched).toBe(false);
    expect([...replacement.widthLodError]).toEqual([0, 0.125, 0]);
    expect(at(replacement.vertices, 1).position).toEqual(vec3(1, 0, 2));
    expect(at(replacement.vertices, 4).position).toEqual(vec3(1, 2, 0));
    expect(() => borrowed.position.x).toThrow("no longer valid");
    expect(() => old.heightLodError[0]).toThrow("no longer valid");
    zone.checkHeap(); zone.freeTags(ZoneTag.Renderer);
    expect(zone.memoryRemaining()).toBe(544);
    zone.dispose();
  });

  test("a failed error-array request retains the preceding source grid allocation", () => {
    const zone = new ZoneArena(352);
    expect(() => TemporaryPatchMesh.create(mesh([0, 2], [0, 2], [0, 0]), { kind: "source-zone", zone }))
      .toThrow("allocation of 32 bytes from the main zone");
    expect(zone.memoryRemaining()).toBe(32);
    zone.checkHeap(); zone.freeTags(ZoneTag.Renderer);
    expect(zone.memoryRemaining()).toBe(352);
    zone.dispose();
  });

  test("stitch publication and recursive error propagation mutate the reached source records", () => {
    const zone = new ZoneArena(8192), profile = { kind: "source-zone", zone } satisfies Parameters<typeof TemporaryPatchMesh.create>[1];
    const source = grid(TemporaryPatchMesh.create(mesh([0, 1, 2], [0, 2], [0, 0.25, 0]), profile));
    const target = grid(TemporaryPatchMesh.create(mesh([0, 2], [0, -2], [0, 0]), profile));
    const joined = grid(TemporaryPatchMesh.create(mesh([0, 1, 2], [-2, -4], [0, 16, 0]), profile));
    const publications: string[] = [];
    const prepared = preparePatchGrids([source, target, joined], count => { publications.push(`stitched ${count}`); }, (index, replacement) => {
      publications.push(`replace ${index}`);
      expect(replacement.mesh.width).toBe(3);
      expect(() => at(target.mesh.vertices, 0).position.x).toThrow("no longer valid");
    });
    expect(publications).toEqual(["replace 1", "stitched 1"]);
    expect(prepared.map(value => [...value.mesh.widthLodError])).toEqual([[0, 0.25, 0], [0, 0.25, 0], [0, 0.25, 0]]);
    expect([...joined.mesh.widthLodError]).toEqual([0, 0.25, 0]);
    for (const value of prepared) {
      if (!(value.mesh instanceof TemporaryPatchMesh)) throw new Error("Preparation detached its source grid");
      expect(value.mesh.block.view.getInt32(68, true)).toBe(2);
      expect(value.mesh.block.view.getInt32(72, true)).toBe(1);
    }
    zone.dispose();
  });

  test("the final source hunk move copies the grid and width errors, keeps height errors zero, and frees zone borrows", () => {
    const zone = new ZoneArena(4096), arena = new HunkArena(4096, () => undefined), accounting = new SourceHunkAccounting(arena);
    const temporary = TemporaryPatchMesh.create(mesh([0, 1, 2], [0, 1, 2], [0, 0.25, 0], [0, 0.5, 0]), { kind: "source-zone", zone });
    temporary.setLodVolume(vec3(12, 24, 36), 48); temporary.lodFixed = 2; temporary.lodStitched = true;
    const oldVertex = at(temporary.vertices, 4);
    const owned = temporary.moveToHunk((call, length) => {
      const allocation = accounting.reserve(call, "fixture#0", length, "low"), bytes = allocation.bytes;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { get bytes() { return allocation.bytes; }, get view() { void allocation.bytes; return view; }, address: allocation.byteOffset };
    });
    expect(accounting.report().trace.map(row => [row.source, row.bytes])).toEqual([
      ["R_MovePatchSurfacesToHunk:grid", 488], ["R_MovePatchSurfacesToHunk:widthLodError", 12], ["R_MovePatchSurfacesToHunk:heightLodError", 12],
    ]);
    expect([...owned.widthLodError]).toEqual([0, 0.25, 0]);
    expect([...owned.heightLodError]).toEqual([0, 0, 0]);
    expect(owned.lodOrigin).toEqual(vec3(12, 24, 36)); expect(owned.lodRadius).toBe(48);
    expect(owned.lodFixed).toBe(2); expect(owned.lodStitched).toBe(true);
    expect(selectPatchLod(owned, owned.lodOrigin, vec3(0, 0, 0), vec3(1, 0, 0), -1).height).toBe(3);
    expect(zone.memoryRemaining()).toBe(4096);
    expect(() => oldVertex.position.x).toThrow("no longer valid");
    const newVertex = at(owned.vertices, 4);
    expect(newVertex.position).toEqual(vec3(1, 1, 0));
    arena.clear(null);
    expect(() => newVertex.position.x).toThrow("no longer valid");
    expect(() => owned.heightLodError[1]).toThrow("no longer valid");
    zone.dispose();
  });
});

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
test.skipIf(!existsSync(join(dataPath, "baseq3/pak0.pk3")))("all installed retail patch groups stitch and select their actual vertices at near, middle and far distances", async () => {
  const visited = new Set<string>();
  let fullVertices = 0, farVertices = 0;
  for (const product of ["baseq3", "missionpack"] satisfies readonly ("baseq3" | "missionpack")[]) {
    if (!existsSync(join(dataPath, product, "pak0.pk3"))) continue;
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    for (const name of vfs.list("maps").filter(name => name.startsWith("maps/") && name.endsWith(".bsp"))) {
      if (visited.has(name)) continue;
      visited.add(name);
      const bsp = parseBsp(await vfs.read(name), name), patches: PatchGrid[] = [];
      for (const surface of bsp.surfaces) {
        if (surface.type !== "patch" || (at(bsp.shaders, surface.shader).surfaceFlags & 0x80) !== 0) continue;
        patches.push(createPatchGrid(tessellatePatch(bsp.vertices.slice(surface.firstVertex, surface.firstVertex + surface.vertexCount),
          surface.patchWidth, surface.patchHeight), [surface.lightmapVectors[0], surface.lightmapVectors[1]]));
      }
      const prepared = preparePatchGrids(patches);
      for (const patch of prepared) {
        const members = new Set(patch.mesh.vertices);
        let previousCount = patch.mesh.vertices.length;
        for (const distance of [0, 256, 1024, 4096, 100000]) {
          const viewOrigin = vec3(patch.lodOrigin.x + distance, patch.lodOrigin.y, patch.lodOrigin.z);
          const selected = selectPatchLod(patch, patch.lodOrigin, viewOrigin, vec3(1, 0, 0), 250);
          expect(selected.vertices.length).toBeLessThanOrEqual(previousCount);
          expect(selected.indices.length).toBe((selected.width - 1) * (selected.height - 1) * 6);
          expect(selected.vertices.every(vertex => members.has(vertex))).toBe(true);
          previousCount = selected.vertices.length;
        }
        fullVertices += patch.mesh.vertices.length; farVertices += previousCount;
      }
    }
  }
  expect(visited.has("maps/q3dm1.bsp")).toBe(true);
  expect(farVertices).toBeLessThan(fullVertices);
}, 30000);
