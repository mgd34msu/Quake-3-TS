import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileBuffer, RetainedFileReader } from "../src/assets/read-file-memory.ts";
// Synthetic registration cases follow id Software renderer/tr_model.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import type { ConfigFileJournal } from "../src/assets/vfs.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { CommonError } from "../src/core/common-error.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { finishFailedShader, finishImplicitShader } from "../src/render/material-finish.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import { Md4AllocationReadError } from "../src/render/md4-resource.ts";
import { Md3AllocationReadError, md3SurfaceSource, md3TagCount } from "../src/render/md3-resource.ts";
import { modelBounds } from "../src/render/model-bounds.ts";
import { lerpModelTag } from "../src/render/model-tags.ts";
import { createModelEntity, DEFAULT_MODEL } from "../src/render/ref-entity.ts";
import type { SceneModel } from "../src/render/ref-entity.ts";
import { SceneModelRegistry } from "../src/render/scene-models.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";

function md4(shader = "model/first"): Uint8Array {
  // Header100 + frame40 + two LODs, each12 + surface168; nine trailing bytes.
  const bytes = new Uint8Array(509), view = new DataView(bytes.buffer), encoder = new TextEncoder();
  view.setInt32(0, 0x34504449, true); view.setInt32(4, 1, true);
  view.setInt32(72, 1, true); view.setInt32(84, 100, true);
  view.setInt32(88, 2, true); view.setInt32(92, 140, true); view.setInt32(96, 500, true);
  for (const [index, value] of [-5, -6, -7, 5, 6, 7, 0, 0, 0, 9].entries()) view.setFloat32(100 + index * 4, value, true);
  for (const [index, name] of [shader, "model/second"].entries()) {
    const lod = 140 + index * 180, surface = lod + 12;
    view.setInt32(lod, 1, true); view.setInt32(lod + 4, 12, true); view.setInt32(lod + 8, 180, true);
    bytes.set(encoder.encode(`SURFACE_${index}`), surface + 4); bytes.set(encoder.encode(name), surface + 68);
    view.setInt32(surface + 136, -surface, true); view.setInt32(surface + 164, 168, true);
  }
  bytes.fill(255, 500);
  return bytes;
}

function md3(frameCount = 1): Uint8Array {
  const tagStart = 108 + frameCount * 56, end = tagStart + frameCount * 112;
  const bytes = new Uint8Array(end), view = new DataView(bytes.buffer);
  view.setInt32(0, 0x33504449, true); view.setInt32(4, 15, true);
  view.setInt32(76, frameCount, true); view.setInt32(80, 1, true);
  view.setInt32(92, 108, true); view.setInt32(96, tagStart, true);
  view.setInt32(100, end, true); view.setInt32(104, end, true);
  for (let frame = 0; frame < frameCount; frame++) {
    for (const [index, value] of [-1, -2, -3, 4, 5, 6, 0, 0, 0, 7].entries()) view.setFloat32(108 + frame * 56 + index * 4, value, true);
    const tag = tagStart + frame * 112;
    bytes.set(new TextEncoder().encode("tag_weapon"), tag);
    for (const [index, value] of [2 + frame, 3, 4, 1, 0, 0, 0, 1, 0, 0, 0, 1].entries()) view.setFloat32(tag + 64 + index * 4, value, true);
  }
  return bytes;
}

function change(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  new DataView(copy.buffer).setInt32(offset, value, true);
  return copy;
}

async function fixture(files: ReadonlyMap<string, Uint8Array>, sourceReader?: RetainedFileReader, syncRenderThread: () => void = () => undefined) {
  const read: string[] = [], registered: string[] = [], printed: string[] = [];
  const loaded: string[] = [], freed: string[] = [], retained = new Map<RetainedFileBuffer, string>();
  const observe = (name: string, buffer: RetainedFileBuffer | undefined): RetainedFileBuffer | undefined => {
    if (buffer !== undefined) { loaded.push(name); retained.set(buffer, name); }
    return buffer;
  };
  const backing = sourceReader ?? withRetainedFiles({ readFileOptional: async name => files.get(name) });
  const assets: RetainedFileReader = {
    readFileRetained: async name => { read.push(name); return observe(name, await backing.readFileRetained(name)); },
    readFileRetainedSync: name => { read.push(name); return observe(name, backing.readFileRetainedSync(name)); },
    freeFile: buffer => {
      const name = retained.get(buffer);
      if (name === undefined) throw new Error("Model freed a buffer it did not read");
      backing.freeFile(buffer); retained.delete(buffer); freed.push(name);
    },
  };
  const images = new RendererImageCatalog(), builtins = new BuiltinImages(images, identityImageUploadProfile);
  const profile = createRendererSettings().registrationProfile(), image = builtins.defaultImage;
  const materials = new MaterialRegistry(async name => {
    const defaulted = name === "missing";
    const finished = defaulted ? finishFailedShader({ name, lightmapIndex: -1, profile })
      : finishImplicitShader({ name, profile, kind: "default",
        baseImage: { kind: "loaded", tmu: 0, binding: { kind: "images", playback: { kind: "single", image: { image } } } } });
    return { definition: null, image, whiteImage: image, defaulted, finished, sky: null };
  }, text => { throw new Error(text); });
  const defaultMaterial = await materials.register("*default", { kind: "none" });
  const accounting = new SourceHunkAccounting(new HunkArena(1024 * 1024, () => {}));
  const registry = new SceneModelRegistry(assets, async name => {
    registered.push(name); return materials.register(name, { kind: "none" });
  }, { kind: "source-hunk", accounting }, defaultMaterial, text => { printed.push(text); }, index => materials.findByHandle(index), syncRenderThread);
  registry.initializeSkins(); registry.initializeModels();
  return { registry, accounting, read, registered, defaultMaterial, loaded, freed, retained, printed };
}

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function sourceFixture(files: ReadonlyMap<string, Uint8Array>) {
  const directory = await mkdtemp(join(tmpdir(), "q3-model-source-reads-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "baseq3"));
  for (const [name, bytes] of files) {
    const filename = join(directory, "baseq3", name);
    await mkdir(dirname(filename), { recursive: true });
    await Bun.write(filename, bytes);
  }
  const journal: { readonly path: string; readonly length: number }[] = [];
  const configJournal: ConfigFileJournal = {
    mode: 1,
    readLength() { throw new Error("Unexpected model or skin journal length read"); },
    readFile() { throw new Error("Unexpected model or skin journal replay"); },
    readFileRetained() { throw new Error("Unexpected model or skin journal replay"); },
    writeLength() { throw new Error("Unexpected model or skin length probe"); },
    writeFile(path, bytes) { journal.push({ path, length: bytes === undefined ? -1 : bytes.length }); },
  };
  const vfs = await VirtualFileSystem.openTracked({ dataPath: directory, homePath: directory, cdPath: null,
    product: "baseq3", references: { checksumFeed: 0, random: () => 0 }, configJournal });
  cleanup.push(() => vfs.close());
  return { ...await fixture(new Map<string, Uint8Array>(), vfs), journal };
}

test("real source model reads attempt missing LODs and preserve filename case before cfg journal selection", async () => {
  const bytes = md3();
  const input = await sourceFixture(new Map([["Models.cfg/Robot.MESH", bytes], ["Models.CFG/Robot.MESH", bytes]]));
  const lower = await input.registry.registerModel("Models.cfg/Robot.MESH");
  const upper = await input.registry.registerModel("Models.CFG/Robot.MESH");
  if (lower.kind !== "md3" || upper.kind !== "md3") throw new Error("Expected both original-case loose model reads");
  expect(lower.path).toBe("models.cfg/robot.mesh"); expect(upper.path).toBe(lower.path);
  expect(upper).not.toBe(lower); expect(lower.numLods).toBe(1); expect(lower.md3.slice(1)).toEqual([null, null]);
  expect(input.read).toEqual(["Models.cfg/Robot_2.md3", "Models.cfg/Robot_1.md3", "Models.cfg/Robot.MESH",
    "Models.CFG/Robot_2.md3", "Models.CFG/Robot_1.md3", "Models.CFG/Robot.MESH"]);
  expect(input.journal).toEqual([{ path: "Models.cfg/Robot_2.md3", length: -1 },
    { path: "Models.cfg/Robot_1.md3", length: -1 }, { path: "Models.cfg/Robot.MESH", length: bytes.length }]);
  const report = input.accounting.report();
  expect(input.loaded).toHaveLength(2);
  expect(input.freed).toHaveLength(2);
  expect(await input.registry.registerModel("Models.cfg/Robot.MESH")).toBe(lower);
  expect(input.read).toHaveLength(6); expect(input.accounting.report()).toEqual(report);

  expect(await input.registry.registerModel("Models.cfg/Missing.md3")).toBe(DEFAULT_MODEL);
  expect(input.read.slice(6)).toEqual(["Models.cfg/Missing_2.md3", "Models.cfg/Missing_1.md3", "Models.cfg/Missing.md3"]);
  expect(input.journal.slice(3)).toEqual([{ path: "Models.cfg/Missing_2.md3", length: -1 },
    { path: "Models.cfg/Missing_1.md3", length: -1 }, { path: "Models.cfg/Missing.md3", length: -1 }]);
  const failedReport = input.accounting.report();
  expect(input.loaded).toHaveLength(2);
  expect(await input.registry.registerModel("Models.cfg/Missing.md3")).toBe(DEFAULT_MODEL);
  expect(input.read).toHaveLength(9); expect(input.accounting.report()).toEqual(failedReport);
});

test("real skin reads use source case-sensitive suffix and cfg matching while retaining cache and file lifetimes", async () => {
  const bytes = new TextEncoder().encode("Body,model/first\n");
  const input = await sourceFixture(new Map([["Skins.cfg/Hero.skin", bytes], ["Skins.CFG/Other.skin", bytes],
    ["Skins.cfg/Empty.skin", new Uint8Array()], ["Skins.cfg/Shader.SKIN", bytes]]));
  const skin = await input.registry.registerSkin("Skins.cfg/Hero.skin");
  expect(skin).toEqual({ path: "skins.cfg/hero.skin", surfaces: [{ name: "body", shader: "model/first" }] });
  expect(await input.registry.registerSkin("Skins.cfg/HERO.SKIN")).toBe(skin);
  expect(await input.registry.registerSkin("Skins.CFG/Other.skin")).not.toBeNull();
  expect(await input.registry.registerSkin("Skins.cfg/Empty.skin")).toBeNull();
  expect(await input.registry.registerSkin("Skins.cfg/Missing.skin")).toBeNull();
  const report = input.accounting.report();
  expect(await input.registry.registerSkin("Skins.cfg/MISSING.SKIN")).toBeNull();
  expect(input.accounting.report()).toEqual(report);
  const shader = await input.registry.registerSkin("Skins.cfg/Shader.SKIN");
  expect(shader).toEqual({ path: "skins.cfg/shader.skin", surfaces: [{ name: "", shader: "skins.cfg/shader.skin" }] });
  expect(await input.registry.registerSkin("Skins.cfg/Shader.skin")).toBe(shader);
  expect(input.read).toEqual(["Skins.cfg/Hero.skin", "Skins.CFG/Other.skin", "Skins.cfg/Empty.skin", "Skins.cfg/Missing.skin"]);
  expect(input.journal).toEqual([{ path: "Skins.cfg/Hero.skin", length: bytes.length },
    { path: "Skins.cfg/Empty.skin", length: 0 }, { path: "Skins.cfg/Missing.skin", length: -1 }]);
  expect(input.registered).toEqual(["model/first", "model/first", "Skins.cfg/Shader.SKIN"]);
  expect(input.loaded).toHaveLength(3);
  expect(input.freed).toHaveLength(3);
});

test("identifier dispatch searches external 2,1,0 names and retains only latest MD4 pointer but every allocation", async () => {
  const input = await fixture(new Map([["robot_2.md3", md4("model/coarse")], ["robot_1.md3", md4("model/middle")], ["robot.mesh", md4("model/base")]]));
  const model = await input.registry.registerModel("robot.mesh");
  if (model.kind !== "md4") throw new Error("Expected MD4");
  expect(input.read).toEqual(["robot_2.md3", "robot_1.md3", "robot.mesh"]);
  expect(model.numLods).toBe(3); expect(model.md3).toEqual([null, null, null]);
  expect(model.md4.lods).toHaveLength(2);
  expect(model.md4.firstLodSurfaces()[0]?.material.name).toBe("model/base");
  expect(input.registered).toEqual(["model/coarse", "model/second", "model/middle", "model/second", "model/base", "model/second"]);
  expect(input.accounting.report().trace.filter(row => row.source === "R_LoadMD4").map(row => row.bytes)).toEqual([500, 500, 500]);
  const report = input.accounting.report();
  expect(await input.registry.registerModel("robot.mesh")).toBe(model);
  expect(input.accounting.report()).toEqual(report);
});

test("filename suffix does not choose decoder; MD3 and MD4 pointers survive mixed registration", async () => {
  const input = await fixture(new Map([["mixed_2.md3", md4()], ["mixed.md4", md3(2)]]));
  const model = await input.registry.registerModel("mixed.md4");
  if (model.kind !== "md3") throw new Error("Expected final MD3");
  expect(model.md4).not.toBeNull(); expect(model.numLods).toBe(2);
  expect(model.md3[0]?.frames).toHaveLength(2); expect(model.md3[1]).toBeNull(); expect(model.md3[2]).toBeNull();
  expect(modelBounds(model)).toEqual({ min: { x: -1, y: -2, z: -3 }, max: { x: 4, y: 5, z: 6 } });
  expect(lerpModelTag(model, "tag_weapon", 0, 1, 0.25)?.origin).toEqual({ x: 2.25, y: 3, z: 4 });
  expect(lerpModelTag(model, "tag_weapon", 100, 100, 0)?.origin).toEqual({ x: 3, y: 3, z: 4 });
  const reverse = await fixture(new Map([["reverse_2.md3", md3()], ["reverse.md3", md4()]]));
  const finalMd4 = await reverse.registry.registerModel("reverse.md3");
  if (finalMd4.kind !== "md4") throw new Error("Expected final MD4");
  expect(finalMd4.md3[2]).not.toBeNull(); expect(finalMd4.md3[0]).toBeNull(); expect(finalMd4.numLods).toBe(2);
});

test("pure MD4 bounds and tags follow absent MD3 slot zero", async () => {
  const input = await fixture(new Map([["pure", md4("missing")]]));
  const model = await input.registry.registerModel("pure");
  if (model.kind !== "md4") throw new Error("Expected MD4");
  expect(model.md4.model.frames[0]?.bounds.min).toEqual({ x: -5, y: -6, z: -7 });
  expect(modelBounds(model)).toEqual(modelBounds(DEFAULT_MODEL));
  expect(lerpModelTag(model, "tag_weapon", -1, 100, 0)).toBeNull();
  expect(model.md4.firstLodSurfaces()[0]?.material).toBe(input.defaultMaterial);
  const entity = createModelEntity(model);
  entity.customSkin = { path: "foreign", surfaces: [] }; entity.customShader = { name: "unregistered" };
  expect(() => input.registry.validate(entity)).not.toThrow();
  const other = await fixture(new Map<string, Uint8Array>());
  expect(() => other.registry.validate(entity)).toThrow("another renderer");
});

test("missing base/interior MD3 slots and differing frame counts survive registration", async () => {
  const input = await fixture(new Map([["gap_2.md3", md3(2)], ["gap.md3", md3()], ["coarse_2.md3", md3()]]));
  const model = await input.registry.registerModel("gap.md3");
  if (model.kind !== "md3") throw new Error("Expected MD3");
  expect(model.numLods).toBe(2); expect(model.md3[1]).toBeNull();
  expect(model.md3[0]?.frames).toHaveLength(1); expect(model.md3[2]?.frames).toHaveLength(2);
  const coarse = await input.registry.registerModel("coarse.md3");
  if (coarse.kind !== "md3") throw new Error("Expected retained coarse MD3");
  expect(coarse.numLods).toBe(1); expect(coarse.md3[0]).toBeNull();
  expect(modelBounds(coarse)).toEqual(modelBounds(DEFAULT_MODEL)); expect(lerpModelTag(coarse, "tag_weapon", 0, 0, 0)).toBeNull();
});

test("version failures break search, duplicate source slots and free files before returning", async () => {
  const input = await fixture(new Map([["version_2.md3", md4()], ["version_1.md3", change(md3(), 4, 14)], ["version.md4", md3()]]));
  const model = await input.registry.registerModel("version.md4");
  if (model.kind !== "md4") throw new Error("Expected prior MD4 type");
  expect(input.read).toEqual(["version_2.md3", "version_1.md3"]);
  expect(model.numLods).toBe(2); expect(model.md3).toEqual([null, null, null]);
  expect(input.accounting.report().trace.filter(row => row.source === "R_LoadMD3")).toEqual([]);
  expect(input.freed).toEqual(["version_2.md3", "version_1.md3"]);
  expect(input.retained.size).toBe(0);
  const firstFailed = await fixture(new Map([["fail_2.md3", change(md4(), 4, 2)], ["fail.md3", md3()]]));
  expect(await firstFailed.registry.registerModel("fail.md3")).toBe(DEFAULT_MODEL); expect(firstFailed.read).toEqual(["fail_2.md3"]);
  const baseFailed = await fixture(new Map([["bad_2.md3", md4()], ["bad.md3", change(md3(), 4, 14)]]));
  expect(await baseFailed.registry.registerModel("bad.md3")).toBe(DEFAULT_MODEL);
});

test("MD3 and MD4 zero-frame false returns retain their latest allocation and original LOD duplication", async () => {
  for (const [format, bytes, frameField] of [["md4", md4(), 72], ["md3", md3(), 76]] satisfies readonly (readonly ["md3" | "md4", Uint8Array, number])[]) {
    const input = await fixture(new Map([["empty_2.md3", md4()], ["empty_1.md3", change(bytes, frameField, 0)], ["empty.md3", md3()]]));
    const pending = input.registry.registerModel("empty.md3");
    const model = await pending;
    if (format === "md3") {
      if (model.kind !== "md3") throw new Error("The rejected MD3 allocation must retain MOD_MESH");
      expect(model.numLods).toBe(2);
      expect(model.md3[0]).toBe(model.md3[1]); expect(model.md3[0]?.frames).toEqual([]);
      expect(modelBounds(model)).toEqual({ min: { x: -1, y: -2, z: -3 }, max: { x: 4, y: 5, z: 6 } });
      expect(input.printed).toEqual(["R_LoadMD3: empty.md3 has no frames\n"]);
    } else {
      if (model.kind !== "md4") throw new Error("Prior successful LOD must retain the later rejected MD4 type and pointer");
      expect(model.numLods).toBe(2);
      expect(model.md4.model.frames).toEqual([]);
      expect(model.md4.lods).toEqual([]);
      expect(input.printed).toEqual(["R_LoadMD4: empty.md3 has no frames\n"]);
    }
    expect(input.read).toEqual(["empty_2.md3", "empty_1.md3"]);
    expect(input.accounting.report().trace.filter(row => row.source === `R_Load${format.toUpperCase()}`).at(-1)?.resource).toBe("empty_1.md3");
    expect(input.freed).toEqual(["empty_2.md3", "empty_1.md3"]);
    expect(input.retained.size).toBe(0);
    expect(await input.registry.registerModel("empty.md3")).toBe(model);
  }
});

test("failed nonzero model handles retain actual MD3 bounds and tags alongside the prior MD4 allocation", async () => {
  const original = md3(), zeroFrames = change(change(original, 76, 0), 96, original.length);
  const files = new Map([["Models/Retained_2.md3", md4()], ["Models/Retained.md3", zeroFrames]]);
  const previous: SceneModel[] = [];
  let registry: SceneModelRegistry | null = null;
  const input = await fixture(files, withRetainedFiles({ readFileOptional: async name => {
    if (name === "Models/Retained.md3" && registry !== null) previous.push(registry.modelForHandle(1));
    return files.get(name);
  } }));
  registry = input.registry;
  const registered = await registry.registerModel("Models/Retained.md3");
  expect(registered).toBe(DEFAULT_MODEL);
  expect(registry.modelHandle(registered)).toBe(0);
  const retained = registry.modelForHandle(1), beforeFailure = previous[0];
  expect(retained.kind).toBe("bad");
  if (retained.kind !== "bad" || beforeFailure?.kind !== "md4") throw new Error("Expected the actual failed row and earlier MD4 allocation");
  expect(retained.path).toBe("Models/Retained.md3");
  expect(retained.numLods).toBe(1);
  expect(retained.md3).toBe(beforeFailure.md3);
  expect(retained.md4).toBe(beforeFailure.md4);
  expect(retained.md3[0]?.frames).toEqual([]);
  const base = retained.md3[0];
  if (base === null) throw new Error("Expected the failed MD3 allocation");
  expect(md3TagCount(base)).toBe(1);
  expect(modelBounds(retained)).toEqual({ min: { x: -1, y: -2, z: -3 }, max: { x: 4, y: 5, z: 6 } });
  // R_GetTag clamps frame zero to -1, which reaches the retained tag before ofsTags.
  expect(lerpModelTag(retained, "tag_weapon", 0, 99, 0.25)?.origin).toEqual({ x: 2, y: 3, z: 4 });
  expect(registry.modelForHandle(1)).toBe(retained);
  expect(registry.modelHandle(retained)).toBe(1);
  expect(() => input.registry.validateModel(retained)).not.toThrow();
  const foreign = await fixture(new Map<string, Uint8Array>());
  expect(() => foreign.registry.validateModel(retained)).toThrow("another renderer or is unregistered");
  expect(await registry.registerModel("Models/Retained.md3")).toBe(DEFAULT_MODEL);
  expect(input.read).toEqual(["Models/Retained_2.md3", "Models/Retained_1.md3", "Models/Retained.md3"]);
  expect(input.freed).toEqual(["Models/Retained_2.md3", "Models/Retained.md3"]);
  expect(input.retained.size).toBe(0);
  expect(input.printed).toEqual(["R_LoadMD3: Models/Retained.md3 has no frames\n"]);
  expect(registry.modelForHandle(0)).toBe(DEFAULT_MODEL);
  expect(registry.modelForHandle(2)).toBe(DEFAULT_MODEL);
});

test("a late MD3 triangle failure retains its shader registration, surface writes, source file and model handle", async () => {
  const prefix = md3(), start = prefix.length, bytes = new Uint8Array(start + 176), view = new DataView(bytes.buffer);
  bytes.set(prefix); view.setInt32(84, 1, true); view.setInt32(104, bytes.length, true);
  bytes.set(new TextEncoder().encode("BODY_1"), start + 4);
  bytes.set(new TextEncoder().encode("model/first"), start + 108);
  for (const [offset, value] of [[72, 1], [76, 1], [84, 1], [88, 176], [92, 108], [96, 176], [100, 176], [104, 176]] satisfies readonly (readonly [number, number])[]) view.setInt32(start + offset, value, true);
  const input = await fixture(new Map([["partial.md3", bytes]]));
  await expect(input.registry.registerModel("partial.md3")).rejects.toBeInstanceOf(Md3AllocationReadError);
  expect(input.registered).toEqual(["model/first"]); expect(input.freed).toEqual([]);
  expect([...input.retained.values()]).toEqual(["partial.md3"]);
  const model = input.registry.modelForHandle(1);
  if (model.kind !== "md3") throw new Error("Partial source allocation must remain MOD_MESH");
  expect(model.numLods).toBe(0);
  expect(model.md3[0]?.surfaces[0]?.name).toBe("body");
  expect(model.md3[0]?.surfaces[0]?.shaders[0]?.index).toBe(1);
  const surface = model.md3[0]?.surfaces[0];
  if (surface === undefined) throw new Error("Expected the partially loaded source surface");
  const source = md3SurfaceSource(surface);
  expect([source.surfaceType, source.numVerts, source.numTriangles]).toEqual([6, 0, 1]);
  const frame = source.vertexFrame(999), triangles = source.triangleIndices(), coordinates = source.textureCoordinates();
  expect(() => frame.xyz(0, 0)).toThrow(Md3AllocationReadError);
  expect(() => frame.normal(0)).toThrow(Md3AllocationReadError);
  expect(() => triangles.at(0)).toThrow(Md3AllocationReadError);
  expect(() => coordinates.at(0)).toThrow(Md3AllocationReadError);
  expect(await input.registry.registerModel("partial.md3")).toBe(model);
});

test("unknown IDs cache MOD_BAD and preserve the source goto-fail temporary allocation", async () => {
  const files = new Map([["unknown_2.md3", md4()], ["unknown_1.md3", change(md3(), 0, 123)], ["unknown.md3", md3()]]);
  const input = await fixture(files);
  expect(await input.registry.registerModel("unknown.md3")).toBe(DEFAULT_MODEL);
  expect(input.read).toEqual(["unknown_2.md3", "unknown_1.md3"]);
  const report = input.accounting.report();
  expect(input.loaded.at(-1)).toBe("unknown_1.md3");
  expect(input.freed).toEqual(["unknown_2.md3"]);
  expect([...input.retained.values()]).toEqual(["unknown_1.md3"]);
  files.set("unknown_1.md3", md4());
  expect(await input.registry.registerModel("unknown.md3")).toBe(DEFAULT_MODEL); expect(input.accounting.report()).toEqual(report);
});

test("MD4 loader copies exactly ofsEnd into the hunk and rejects versions before allocating", async () => {
  const bytes = md4(), input = await fixture(new Map([["copy.md4", bytes], ["version.md4", change(md4().subarray(0, 8), 4, 2)],
    ["bad.md4", change(md4(), 96, 76)]]));
  const model = await input.registry.registerModel("copy.md4");
  if (model.kind !== "md4") throw new Error("Expected allocated MD4");
  expect(model.md4.byteLength).toBe(500); bytes.fill(99);
  expect(model.md4.firstLodSurfaces()[0]?.source.name).toBe("surface_0");
  expect(await input.registry.registerModel("version.md4")).toBe(DEFAULT_MODEL);
  expect(input.accounting.report().trace.filter(row => row.source === "R_LoadMD4").map(row => row.bytes)).toEqual([500]);
  await expect(input.registry.registerModel("bad.md4")).rejects.toBeInstanceOf(Md4AllocationReadError);
  expect(input.accounting.report().trace.filter(row => row.source === "R_LoadMD4").map(row => row.bytes)).toEqual([500, 76]);
  const partial = input.registry.modelForHandle(3);
  if (partial.kind !== "md4") throw new Error("Allocated failing MD4 must remain published");
  expect(partial.md4.byteLength).toBe(76);
  expect([...input.retained.values()]).toEqual(["bad.md4"]);
  expect(await input.registry.registerModel("bad.md4")).toBe(partial);
});

function modelList(registry: SceneModelRegistry): string[] {
  const lines: string[] = [];
  registry.listModels(text => { lines.push(text); });
  return lines;
}

function skinList(registry: SceneModelRegistry): string[] {
  const lines: string[] = [];
  registry.listSkins(text => { lines.push(text); });
  return lines;
}

test("model listing preserves allocation order, original case, failed records and inline zero sizes", async () => {
  const bytes = md3(), padded = new Uint8Array(bytes.length + 17);
  padded.set(bytes);
  const input = await fixture(new Map([["Models/Upper.md3", padded], ["models/upper.md3", bytes]]));
  expect(modelList(input.registry)).toEqual(["       0 : Total models\n"]);
  await input.registry.registerModel("Models/Upper.md3");
  await input.registry.registerModel("Missing.md3");
  const parsed = parseBsp(renderBspFixture([{ shader: "model/first", lightmap: -1 }, { shader: "model/first", lightmap: -1 }], []));
  const model = parsed.models[0];
  if (model === undefined) throw new Error("Missing authored BSP model");
  const map = { ...parsed, models: [model, model] };
  input.registry.allocateInlineModels(map.models.map((_, index) => ({ kind: "inline", path: `*${index}`, index, map })));
  await input.registry.registerModel("models/upper.md3");
  await input.registry.registerModel("Models/Upper.md3");
  await input.registry.registerModel("Missing.md3");
  expect(modelList(input.registry)).toEqual([
    "     276 : (1) Models/Upper.md3\n", "       0 : (1) Missing.md3\n",
    "       0 : (1) *0\n", "       0 : (1) *1\n", "     276 : (1) models/upper.md3\n",
    "     552 : Total models\n",
  ]);
});

test("model listing counts distinct adjacent MD3 allocations and all MD4 bytes across failed LODs", async () => {
  const input = await fixture(new Map([
    ["all_2.md3", md3()], ["all_1.md3", md3()], ["all.md3", md3()],
    ["gap_2.md3", md3()], ["gap.md3", md3()],
    ["alias_2.md3", md3()], ["alias_1.md3", change(md3(), 4, 14)],
    ["bad_2.md3", md3()], ["bad.md3", change(md3(), 0, 123)],
    ["skeletal_2.md3", md4()], ["skeletal_1.md3", md4()], ["skeletal.md4", md4()],
    ["mixed_2.md3", md3()], ["mixed.md4", md4()],
  ]));
  for (const name of ["all.md3", "gap.md3", "alias.md3", "bad.md3", "skeletal.md4", "mixed.md4"]) await input.registry.registerModel(name);
  expect(modelList(input.registry)).toEqual([
    "     828 : (3) all.md3\n", "     552 : (2) gap.md3\n", "     276 : (2) alias.md3\n",
    "     276 : (2) bad.md3\n", "    1500 : (1) skeletal.md4\n", "     776 : (2) mixed.md4\n",
    "    4208 : Total models\n",
  ]);
});

test("skin listing includes default and failed rows with retained shader names and source name matching", async () => {
  const input = await fixture(new Map([
    ["Skins/Hero.skin", new TextEncoder().encode("Body,Textures/First.TGA\nHead,missing\n")],
    ["Skins/Empty.skin", new Uint8Array()],
  ]));
  expect(skinList(input.registry)).toEqual(["------------------\n", "  0:<default skin>\n", "        = <default>\n", "------------------\n"]);
  const skin = await input.registry.registerSkin("Skins/Hero.skin");
  expect(await input.registry.registerSkin("SKINS/HERO.SKIN")).toBe(skin);
  await input.registry.registerSkin("Skins/Empty.skin");
  await input.registry.registerSkin("Skins/Missing.skin");
  await input.registry.registerSkin("Textures/Single.TGA");
  await input.registry.registerSkin("Textures\\Single.TGA");
  await input.registry.registerSkin("Textures/Ä.TGA");
  await input.registry.registerSkin("Textures/ä.TGA");
  input.defaultMaterial.remapped = { ...input.defaultMaterial, name: "remapped/default" };
  expect(skinList(input.registry)).toEqual([
    "------------------\n", "  0:<default skin>\n", "        = <default>\n",
    "  1:Skins/Hero.skin\n", "       body = Textures/First\n", "       head = missing\n",
    "  2:Skins/Empty.skin\n", "  3:Skins/Missing.skin\n",
    "  4:Textures/Single.TGA\n", "        = Textures/Single\n",
    "  5:Textures\\Single.TGA\n", "        = Textures\\Single\n",
    "  6:Textures/Ä.TGA\n", "        = Textures/Ä\n",
    "  7:Textures/ä.TGA\n", "        = Textures/ä\n", "------------------\n",
  ]);
});

test("listing synchronously exposes allocated records while registration awaits source reads", async () => {
  let release: (bytes: Uint8Array | undefined) => void = () => { throw new Error("No pending read"); };
  const input = await fixture(new Map<string, Uint8Array>(), withRetainedFiles({
    readFileOptional: () => new Promise(resolve => { release = resolve; }),
  }));
  const pending = input.registry.registerModel("pending.md3");
  expect(input.read).toEqual(["pending_2.md3"]);
  expect(modelList(input.registry)).toEqual(["       0 : (1) pending.md3\n", "       0 : Total models\n"]);
  release(change(md3(), 4, 14));
  expect(await pending).toBe(DEFAULT_MODEL);
  const pendingSkin = input.registry.registerSkin("pending.skin");
  expect(input.read).toEqual(["pending_2.md3", "pending.skin"]);
  expect(skinList(input.registry).slice(-2)).toEqual(["  1:pending.skin\n", "------------------\n"]);
  release(undefined);
  expect(await pendingSkin).toBeNull();
});

test("model registration prints source boundary diagnostics before file reads or hunk allocation", async () => {
  let synchronizations = 0;
  const input = await fixture(new Map<string, Uint8Array>(), undefined, () => { synchronizations++; });
  const initialized = input.accounting.report();
  expect(await input.registry.registerModel("")).toBe(DEFAULT_MODEL);
  expect(await input.registry.registerModel("x".repeat(64))).toBe(DEFAULT_MODEL);
  expect(input.printed).toEqual(["RE_RegisterModel: NULL name\n", "Model name exceeds MAX_QPATH\n"]);
  expect(input.read).toEqual([]);
  expect(input.accounting.report()).toEqual(initialized);
  expect(synchronizations).toBe(0);

  for (let index = 0; index < 1023; index++) await input.registry.registerModel(`missing${index}.md3`);
  const full = input.accounting.report(), reads = input.read.length;
  expect(await input.registry.registerModel("overflow.md3")).toBe(DEFAULT_MODEL);
  expect(input.printed.at(-1)).toBe("RE_RegisterModel: R_AllocModel() failed for 'overflow.md3'\n");
  expect(input.read.length).toBe(reads);
  expect(input.accounting.report()).toEqual(full);
  expect(await input.registry.registerModel("missing0.md3")).toBe(DEFAULT_MODEL);
  expect(input.printed).toHaveLength(3);
  expect(input.read.length).toBe(reads);
  expect(input.accounting.report()).toEqual(full);
  expect(synchronizations).toBe(1023);
});

test("model render synchronization publishes the named bad row and caches zero after a source drop", async () => {
  let synchronize: () => void = () => undefined;
  const input = await fixture(new Map([["Models/Dropped.md3", md3()]]), undefined, () => synchronize());
  const failure = new CommonError("drop", "authored render command failure"), prefix: SceneModel[] = [], rows: string[] = [];
  const nested: Promise<SceneModel>[] = [];
  synchronize = () => {
    prefix.push(input.registry.modelForHandle(1));
    rows.push(...modelList(input.registry));
    nested.push(input.registry.registerModel("Models/Dropped.md3"));
    throw failure;
  };
  await expect(input.registry.registerModel("Models/Dropped.md3")).rejects.toBe(failure);
  expect(rows).toEqual(["       0 : (1) Models/Dropped.md3\n", "       0 : Total models\n"]);
  expect(prefix).toEqual([{ kind: "bad", path: "Models/Dropped.md3", md3: [null, null, null], md4: null, numLods: 0 }]);
  expect(prefix[0]).toBe(input.registry.modelForHandle(1));
  expect(await Promise.all(nested)).toEqual([DEFAULT_MODEL]);
  expect(await input.registry.registerModel("Models/Dropped.md3")).toBe(DEFAULT_MODEL);
  expect(rows).toHaveLength(2);
  expect(input.read).toEqual([]);
  expect(input.loaded).toEqual([]);
  expect(input.retained.size).toBe(0);
});
