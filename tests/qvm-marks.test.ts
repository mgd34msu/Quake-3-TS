import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
// Cgame mark ABI and R_AddMarkFragments ordering, id Software cl_cgame.c/tr_marks.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, test } from "bun:test";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { BspMarkProjector } from "../src/render/marks.ts";
import { RendererResources } from "../src/render/world.ts";
import { qvmMarkSyscall } from "../src/vm/mark-syscalls.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { markSquare } from "./marks-fixture.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function words(...values: number[]): DataView {
  const result = new DataView(new ArrayBuffer(values.length * 4));
  for (const [index, value] of values.entries()) result.setInt32(index * 4, value, true);
  return result;
}

function writeVectors(memory: QvmMemory, pointer: number, points: readonly Vec3[]): void {
  const view = memory.view(pointer, points.length * 12);
  for (const [index, point] of points.entries()) {
    view.setFloat32(index * 12, point.x, true);
    view.setFloat32(index * 12 + 4, point.y, true);
    view.setFloat32(index * 12 + 8, point.z, true);
  }
}

function readVectors(memory: QvmMemory, pointer: number, count: number): readonly Vec3[] {
  const view = memory.view(pointer, count * 12);
  return Array.from({ length: count }, (_, index) => ({
    x: view.getFloat32(index * 12, true), y: view.getFloat32(index * 12 + 4, true), z: view.getFloat32(index * 12 + 8, true),
  }));
}

function inputSquare(): readonly Vec3[] {
  return markSquare().map(point => vec3(32 - point.z, point.x - 12, -point.y));
}

const facePoints: readonly Vec3[] = [
  vec3(32, -16, -4), vec3(32, -8, -4), vec3(32, -8, 4),
  vec3(32, -16, -4), vec3(32, -8, 4), vec3(32, -16, 4),
];

function patchBytes(source: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(source.byteLength + 13 * 44);
  bytes.set(source);
  const header = new DataView(bytes.buffer), originalVertices = header.getInt32(8 + 10 * 8, true);
  // Replace the first four authored vertices with a flat 3x3 control grid.
  for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
    const offset = source.byteLength + (row * 3 + column) * 44;
    bytes.set(source.subarray(originalVertices, originalVertices + 44), offset);
    header.setFloat32(offset + 4, -16 + row * 4, true);
    header.setFloat32(offset + 8, -4 + column * 4, true);
  }
  bytes.set(source.subarray(originalVertices + 4 * 44, originalVertices + 8 * 44), source.byteLength + 9 * 44);
  header.setInt32(8 + 10 * 8, source.byteLength, true);
  header.setInt32(12 + 10 * 8, 13 * 44, true);
  const surfaces = header.getInt32(8 + 13 * 8, true);
  header.setInt32(surfaces + 8, 2, true);
  header.setInt32(surfaces + 16, 9, true);
  header.setInt32(surfaces + 24, 0, true);
  header.setInt32(surfaces + 96, 3, true);
  header.setInt32(surfaces + 100, 3, true);
  header.setInt32(surfaces + 104 + 12, 9, true);
  return bytes;
}

async function fixture(load = true) {
  const bytes = renderBspFixture([{ shader: "marks", lightmap: -1 }, { shader: "marks", lightmap: -1 }], []);
  const files = new Map<string, Uint8Array>([
    ["scripts/test.shader", new TextEncoder().encode("marks { { map $whiteimage } }")], ["maps/marks.bsp", bytes],
  ]);
  const reads: string[] = [];
  const reader: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
    has: path => files.has(path), list: prefix => [...files.keys()].filter(path => prefix === undefined || path.startsWith(prefix)),
    readFileLength: path => files.get(path)?.byteLength ?? -1,
    readFileOptional: async path => { reads.push(path); return files.get(path); },
    async read(path) {
      const value = files.get(path);
      if (value === undefined) throw new Error(`Missing authored asset ${path}`);
      return value;
    },
  });
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(8, 8, images), target = new RenderTarget(images, [cpu]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile);
  cleanup.push(() => target.close());
  const resources = await RendererResources.create(reader, { kind: "unaccounted" }, createRendererSettings(), { patchMemory: { kind: "diagnostic" },
    target, images, builtins, imageProfile: identityImageUploadProfile, print: () => undefined,
    shaderCinematics: { async playShaderCinematic() { throw new Error("Authored marks have no cinematic shaders"); } },
    drawDebugSurface: () => { throw new Error("Mark projection must not draw debug surfaces"); },
  });
  if (load) await resources.loadWorld("marks");
  const memory = new QvmMemory(new Uint8Array(4096));
  memory.bytes.fill(0xa5);
  writeVectors(memory, 64, inputSquare());
  writeVectors(memory, 128, [vec3(20, 0, 0)]);
  function call(pointCount = 4, input = 64, projection = 128, maxPoints = 384, output = 256, maxFragments = 128, fragments = 512): number | null {
    return qvmMarkSyscall("cgame", words(27, pointCount, input, projection, maxPoints, output, maxFragments, fragments), memory, resources);
  }
  return { resources, memory, files, reads, bytes, call };
}

test("trap 27 projects the active renderer BSP into source point and fragment records", async () => {
  const f = await fixture(), reads = f.reads.length;
  expect(f.call()).toBe(2);
  expect(readVectors(f.memory, 256, 6)).toEqual(facePoints);
  expect([...f.memory.span(512, 16)]).toEqual([0, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0]);
  expect(f.memory.span(328, 16).every(byte => byte === 0xa5)).toBe(true);
  expect(f.memory.span(528, 16).every(byte => byte === 0xa5)).toBe(true);
  expect(f.reads).toHaveLength(reads);
  // Neither command capacity nor device access is needed for projection.
  expect(f.resources.sceneEntities.sceneRange().length).toBe(0);
});

test("only cgame trap 27 reads the syscall words or requires an active world", async () => {
  const f = await fixture(false);
  for (const role of ["game", "ui"] satisfies readonly ("game" | "ui")[]) {
    expect(qvmMarkSyscall(role, words(), f.memory, f.resources)).toBeNull();
    expect(qvmMarkSyscall(role, words(27), f.memory, f.resources)).toBeNull();
  }
  for (const trap of [26, 28, 0x7fffffff]) expect(qvmMarkSyscall("cgame", words(trap), f.memory, f.resources)).toBeNull();
  expect(() => qvmMarkSyscall("cgame", words(27, 4), f.memory, f.resources)).toThrow(RangeError);
  expect(() => f.call()).toThrow("R_MarkFragments: NULL worldmodel");
});

test("VM marks use the active world's prepared patch grid and its source triangle order", async () => {
  const f = await fixture();
  f.files.set("maps/patch.bsp", patchBytes(f.bytes));
  const world = await f.resources.loadWorld("patch"), surface = world.markGeometry.surfaces[0];
  if (surface?.kind !== "grid") throw new Error("Authored patch must produce the renderer's actual mark grid");
  expect([surface.mesh.width, surface.mesh.height]).toEqual([2, 2]);
  expect(f.call()).toBe(2);
  expect(readVectors(f.memory, 256, 6)).toEqual([
    vec3(32, -16, -4), vec3(32, -8, -4), vec3(32, -16, 4),
    vec3(32, -16, 4), vec3(32, -8, -4), vec3(32, -8, 4),
  ]);
  expect([...f.memory.span(512, 16)]).toEqual([0, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0]);
  expect(f.call(4, 64, 128, 384, 256, 1, 512)).toBe(1);
});

test("VM mark bases mask once and unused capacity does not require storage", async () => {
  const f = await fixture();
  expect(f.call(4, 4096 + 64, -4096 + 128, 1_000_000, 4096 + 256, 1_000_000, -4096 + 512)).toBe(2);
  expect(readVectors(f.memory, 256, 6)).toEqual(facePoints);
  writeVectors(f.memory, 4096, inputSquare());
  expect(f.call(4, 4096)).toBe(2);
  expect(f.call(4, 64, 128, 3, 4096 - 36, 1, 4096 - 44)).toBe(1);
  expect(readVectors(f.memory, 4096 - 36, 3)).toEqual(facePoints.slice(0, 3));
  // The second fragment must advance past the resolved base, never wrap into offset zero.
  f.memory.span(1, 32).fill(0x5a);
  expect(() => f.call(4, 64, 128, 6, 4096 + 4096 - 36, 2, 512)).toThrow("output points exceeds allocation");
  expect(readVectors(f.memory, 4096 - 36, 3)).toEqual(facePoints.slice(0, 3));
  expect(f.memory.span(1, 32).every(byte => byte === 0x5a)).toBe(true);
  expect(f.memory.view(520, 8).getInt32(0, true)).toBe(3);
  expect(f.memory.view(520, 8).getInt32(4, true)).toBe(3);
});

test("fragment metadata publishes before points and keeps each reached scalar store", async () => {
  const f = await fixture();
  expect(() => f.call(4, 64, 128, 384, 0, 128, 512)).toThrow("output points requires a nonnull pointer");
  expect([...f.memory.span(512, 8)]).toEqual([0, 0, 0, 0, 3, 0, 0, 0]);
  expect(f.memory.span(520, 8).every(byte => byte === 0xa5)).toBe(true);
  expect(() => f.call(4, 64, 128, 384, 256, 128, 4096 + 4092)).toThrow("fragments exceeds allocation");
  expect(f.memory.view(4092, 4).getInt32(0, true)).toBe(0);
  expect(f.memory.span(256, 72).every(byte => byte === 0xa5)).toBe(true);
  expect(() => f.call(4, 64, 128, 384, 256, 128, 4084)).toThrow("fragments exceeds allocation");
  expect([...f.memory.span(4084, 12)]).toEqual([0, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0]);
  expect(readVectors(f.memory, 256, 3)).toEqual(facePoints.slice(0, 3));
  expect(f.memory.span(292, 36).every(byte => byte === 0xa5)).toBe(true);
});

test("overlapping output records preserve metadata-before-copy source ordering", async () => {
  const f = await fixture();
  expect(f.call(4, 64, 128, 3, 256, 1, 256)).toBe(1);
  expect(readVectors(f.memory, 256, 3)).toEqual(facePoints.slice(0, 3));
  // Inputs may overlap outputs because the source has prepared its clipping planes before publication.
  expect(f.call(4, 64, 128, 6, 64, 2, 128)).toBe(2);
  expect(readVectors(f.memory, 64, 6)).toEqual(facePoints);
  expect(f.memory.view(136, 8).getInt32(0, true)).toBe(3);
  expect(f.memory.view(136, 8).getInt32(4, true)).toBe(3);
});

test("point and fragment limits leave unproduced output and invalid output pointers untouched", async () => {
  const f = await fixture();
  expect(f.call(4, 64, 128, 2, 0, 128, 0)).toBe(0);
  expect(f.call(4, 64, 128, 0, 0, 128, 0)).toBe(0);
  expect(f.call(4, 64, 128, 384, 0, 0, 0)).toBe(0);
  expect(f.call(4, 64, 128, 5, 256, 128, 512)).toBe(1);
  expect(readVectors(f.memory, 256, 3)).toEqual(facePoints.slice(0, 3));
  expect(f.memory.span(292, 36).every(byte => byte === 0xa5)).toBe(true);
  expect(f.memory.span(520, 8).every(byte => byte === 0xa5)).toBe(true);
  writeVectors(f.memory, 128, [vec3(-20, 0, 0)]);
  expect(f.call(4, 64, 128, 384, 0, 128, 0)).toBe(0);
  writeVectors(f.memory, 128, [vec3(0, 0, 0)]);
  expect(f.call(4, 64, 128, 384, 0, 128, 0)).toBe(0);
});

test("projection is consumed first, bounds precede the 64-point clamp, and unused input tails are not read", async () => {
  const f = await fixture();
  expect(() => f.call(4, 0, 4090)).toThrow("projection exceeds allocation");
  f.memory.view(128, 12).setFloat32(0, Infinity, true);
  expect(() => f.call(4, 0)).toThrow("finite float32");
  writeVectors(f.memory, 128, [vec3(20, 0, 0)]);
  writeVectors(f.memory, 4048, inputSquare());
  expect(f.call(4, 4096 + 4048)).toBe(2);
  expect(() => f.call(5, 4096 + 4048)).toThrow("input points exceeds allocation");
  const ring = Array.from({ length: 64 }, (_, index) => {
    const angle = index * Math.PI / 32;
    return vec3(31, -12 + Math.cos(angle) * 16, Math.sin(angle) * 16);
  });
  writeVectors(f.memory, 3328, ring);
  expect(f.call(64, 3328)).toBe(2);
  expect(() => f.call(65, 3328)).toThrow("input points exceeds allocation");
  writeVectors(f.memory, 1024, [...ring, vec3(Number.NaN, 0, 0)]);
  expect(f.call(64, 1024)).toBe(2);
  expect(() => f.call(65, 1024)).toThrow("finite float32");
  writeVectors(f.memory, 1024 + 64 * 12, [vec3(31, -12, 0)]);
  expect(f.call(65, 1024)).toBe(2);
  expect(readVectors(f.memory, 256, 6)).toEqual(facePoints);
});

test("managed finite and storage qualifications reject explicitly", async () => {
  const f = await fixture();
  for (const count of [0, -1]) expect(() => f.call(count)).toThrow("at least one input point");
  for (const maxPoints of [-1, 1_000_001]) expect(() => f.call(4, 64, 128, maxPoints)).toThrow("capacity");
  for (const maxFragments of [-1, 1_000_001]) expect(() => f.call(4, 64, 128, 384, 256, maxFragments)).toThrow("capacity");
  f.memory.view(64, 12).setFloat32(8, Number.NaN, true);
  expect(() => f.call()).toThrow("finite float32");
  expect(f.memory.span(256, 72).every(byte => byte === 0xa5)).toBe(true);
});

test("marks follow the active world and retain existing prepared geometry after a failed load", async () => {
  const f = await fixture(), firstWorld = await f.resources.loadWorld("marks");
  const shifted = f.bytes.slice(), header = new DataView(shifted.buffer);
  const vertices = header.getInt32(8 + 10 * 8, true);
  for (let index = 0; index < 4; index++) header.setFloat32(vertices + index * 44, 40, true);
  f.files.set("maps/shifted.bsp", shifted);
  await f.resources.loadWorld("shifted");
  expect(f.call()).toBe(2);
  expect(readVectors(f.memory, 256, 6)).toEqual(facePoints.map(point => vec3(40, point.y, point.z)));
  const old = new BspMarkProjector(firstWorld.markGeometry).markFragments({
    points: inputSquare(), projection: vec3(20, 0, 0), maxPoints: 384, maxFragments: 128,
  });
  expect(old.points).toEqual(facePoints);
  await expect(f.resources.loadWorld("missing")).rejects.toThrow("not found");
  expect(f.call()).toBe(2);
  expect(readVectors(f.memory, 256, 6)).toEqual(facePoints.map(point => vec3(40, point.y, point.z)));
  const other = await fixture();
  expect(other.call()).toBe(2);
  expect(readVectors(other.memory, 256, 6)).toEqual(facePoints);
});
