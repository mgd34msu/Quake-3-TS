import { withRetainedFiles } from "./retained-file-fixture.ts";
import { ReadFileMemory } from "../src/assets/read-file-memory.ts";
import type { RetainedFileBuffer, RetainedFileReader } from "../src/assets/read-file-memory.ts";
import { afterEach, expect, test } from "bun:test";
import { AudioMixer } from "../src/audio/mixer.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { SOURCE_HUNK_RELEASE32, SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import type { HunkAccountingProfile } from "../src/render/hunk-accounting.ts";
import { SceneModelRegistry } from "../src/render/scene-models.ts";
import { loadMd3Resource } from "../src/render/md3-resource.ts";
import type { SceneInlineModel } from "../src/render/ref-entity.ts";
import { RendererResources } from "../src/render/world.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import { finishImplicitShader } from "../src/render/material-finish.ts";

const shaderImages = new RendererImageCatalog(), shaderBuiltins = new BuiltinImages(shaderImages, identityImageUploadProfile);
const shaderProfile = createRendererSettings().registrationProfile();
const materials = new MaterialRegistry(async name => {
  const image = shaderBuiltins.defaultImage;
  const finished = finishImplicitShader({ name, profile: shaderProfile, kind: "default",
    baseImage: { kind: "loaded", tmu: 0, binding: { kind: "images", playback: { kind: "single", image: { image } } } } });
  return { definition: null, image, whiteImage: image, defaulted: false, finished, sky: null };
}, text => { throw new Error(text); });
const defaultMaterial = await materials.register("*default", { kind: "none" });

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function fixture() {
  const logs: string[] = [];
  const arena = new HunkArena(16 * 1048576, text => { logs.push(text); });
  return { arena, logs, accounting: new SourceHunkAccounting(arena) };
}
function mapBytes(): Uint8Array {
  return renderBspFixture([{ shader: "test/wall", lightmap: -1 }, { shader: "test/wall", lightmap: -1 }], []);
}
function inlineModels(count: number): readonly SceneInlineModel[] {
  const parsed = parseBsp(mapBytes()), model = parsed.models[0];
  if (model === undefined) throw new Error("Missing authored BSP model");
  const map = { ...parsed, models: Array.from({ length: count }, () => model) };
  return map.models.map((_, index) => ({ kind: "inline", path: `*${index}`, index, map }));
}
function reader(files: ReadonlyMap<string, Uint8Array>): RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> {
  return withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: name => files.get(name)?.byteLength ?? -1, readFileOptional: async name => files.get(name)?.slice(),
    has: name => files.has(name), list: prefix => [...files.keys()].filter(name => prefix === undefined || name.startsWith(prefix)),
    async read(name) { const bytes = files.get(name); if (bytes === undefined) throw new Error(`Missing test resource ${name}`); return new Uint8Array(bytes); } });
}
async function resourceFixture(files: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">, memory: HunkAccountingProfile) {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(8, 8, images), target = new RenderTarget(images, [cpu]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), settings = createRendererSettings(), clock = { milliseconds: () => 0 };
  if (memory.kind === "source-hunk") memory.accounting.initializeRendererBackend(settings.sceneLimits());
  const cinematicMixer = new AudioMixer(44100, () => 0);
  const cinematics = new EngineCinematics({ temporaryMemory: memory.kind === "source-hunk" ? memory.accounting.arena : new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  cleanup.push(() => { target.close(); cinematics.dispose(); });
  const resources = await RendererResources.create(files, memory, settings,
    { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => commands.close("discard"));
  return resources;
}
function md3(): Uint8Array {
  const bytes = new Uint8Array(164), view = new DataView(bytes.buffer);
  view.setInt32(0, 0x33504449, true); view.setInt32(4, 15, true); view.setInt32(76, 1, true);
  view.setInt32(92, 108, true); view.setInt32(96, 164, true); view.setInt32(100, 164, true); view.setInt32(104, 164, true);
  return bytes;
}

test("release32 profile equals independent gcc-m32 sizeof/offsetof of pinned native headers", () => {
  expect(SOURCE_HUNK_RELEASE32).toEqual({ pointer: 4, model: 100, skin: 196, skinSurface: 68, shader: 580, shaderStage: 252, texMod: 68, image: 112,
    diskShader: 72, collisionModel: 48, collisionNode: 12, brush: 44, leaf: 24, area: 8, plane: 20, brushSide: 12,
    collisionPatch: 16, patchCollide: 40, facet: 320, patchPlane: 20, surface: 16, facePointsOffset: 44, facePoint: 32,
    triangles: 68, flare: 40, grid: 136, drawVertex: 44, brushModel: 32, node: 64, fog: 72,
    refEntity: 140, trRefEntity: 192, dynamicLight: 44, drawSurface: 8, poly: 20, polyVertex: 24,
    backEndData: 984268 });
});

test("actual collision constructor allocations match the native fourteen-request fixture byte for byte", () => {
  const { arena, accounting } = fixture(), bytes = mapBytes(), source = "maps/fixture.bsp";
  const collision = new CollisionWorld(parseBsp(bytes), { kind: "source-hunk", accounting, source, fileBytes: bytes, fileLifetime: "detached", clientLoad: false }, { kind: "disabled" });
  expect(collision.areaCount).toBe(2);
  const report = accounting.report(), allocations = report.trace.filter(row => row.preference !== "temporary");
  // /tmp/q3-hunk-resources-oracle-0md9n1/collision: unchanged cm_load.c + cm_patch.c, gcc -m32.
  expect(allocations.map(row => row.bytes)).toEqual([72, 96, 16, 16, 4, 8, 260, 72, 44, 48, 12, 85, 10, 8]);
  expect(allocations.reduce((sum, row) => sum + row.reservedBytes, 0)).toBe(1024);
  expect(arena.byteLength - arena.memoryRemaining()).toBe(1024);
  expect(report.trace[0]?.bytes).toBe(bytes.length + 1);
  expect(report.trace.at(-1)?.action).toBe("free-file");
  expect(accounting.memoryRemaining()).toBe(arena.memoryRemaining());
  expect(report.budget).toBe("port-arena");
});

test("real renderer loading allocates source-ordered BSP records and its own visibility by default", async () => {
  const { accounting } = fixture(), bytes = mapBytes(), source = "maps/fixture.bsp";
  const files = new Map([[source, bytes], ["scripts/test.shader", new TextEncoder().encode("test/wall { { map $whiteimage } }")]]);
  new CollisionWorld(parseBsp(bytes), { kind: "source-hunk", accounting, source, fileBytes: bytes, fileLifetime: "detached", clientLoad: true }, { kind: "disabled" });
  const resources = await resourceFixture(reader(files), { kind: "source-hunk", accounting });
  const before = accounting.report().trace.length;
  const world = await resources.loadWorld(source);
  expect(world.map.surfaces.length).toBe(2); expect(resources.memoryProfile.kind).toBe("source-hunk");
  const requests = accounting.report().trace.slice(before).filter(row => row.preference !== "temporary");
  expect(requests.map(row => row.bytes)).toEqual([0, 72, 40, 72, 32, 580, 252, 0, 0, 196, 196, 8, 192, 32, 100, 64, 2, 86, 0]);
  expect(requests.filter(row => row.source === "R_LoadVisibility").map(row => row.bytes)).toEqual([2]);
  expect(requests.some(row => row.source === "R_LoadLightGrid")).toBe(false);
});

test("world BSP retained files free after publication and duplicate loads reject before a read", async () => {
  const { arena, accounting } = fixture(), memory = new ReadFileMemory(() => arena);
  const bytes = mapBytes(), files = new Map([["maps/fixture.bsp", bytes], ["maps/bad.bsp", new Uint8Array(4)]]);
  const acquired: RetainedFileBuffer[] = [], freed: { readonly stack: number; readonly world: string | null }[] = [];
  let resources: RendererResources | null = null;
  const source: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = {
    ...reader(files),
    async readFileRetained(path) {
      const data = files.get(path);
      if (data === undefined) return undefined;
      const file = memory.read(data.length, target => { target.set(data); });
      acquired.push(file);
      return file;
    },
    freeFile(file) {
      freed.push({ stack: memory.loadStack, world: resources?.worldBaseName ?? null });
      memory.freeFile(file);
    },
  };
  resources = await resourceFixture(source, { kind: "source-hunk", accounting });
  const world = await resources.loadWorld("fixture");
  expect(freed).toEqual([{ stack: 1, world: "fixture" }]);
  expect(memory.loadStack).toBe(0);
  expect(memory.loadCount).toBe(1);
  expect(accounting.report().trace.some(event => event.source === "FS_ReadFile")).toBe(false);
  const first = acquired[0];
  if (first === undefined) throw new Error("World did not acquire its BSP file");
  expect(() => first.bytes).toThrow("no longer valid");
  const overwrite = arena.allocateTemp(bytes.length + 1);
  overwrite.bytes.fill(255);
  arena.freeTemp(overwrite);
  expect(world.map.shaders[0]?.name).toBe("test/wall");
  expect(world.map.surfaces.length).toBe(2);
  await expect(resources.loadWorld("bad")).rejects.toThrow("attempted to redundantly load world map");
  expect(memory.loadStack).toBe(0);
  expect(memory.loadCount).toBe(1);
  expect(freed).toHaveLength(1);
  expect(resources.worldBaseName).toBe("fixture");
  expect(acquired).toHaveLength(1);
  memory.disposeResources();
});

test("model cache misses and all three actual LOD reads retain source header-sized permanent bytes", async () => {
  const { accounting, arena } = fixture();
  const registry = new SceneModelRegistry(reader(new Map([["m.md3", md3()], ["m_1.md3", md3()], ["m_2.md3", md3()]])), async () => defaultMaterial, { kind: "source-hunk", accounting }, defaultMaterial,
    () => undefined, index => index === defaultMaterial.order ? defaultMaterial : null, () => undefined);
  registry.initializeSkins(); registry.initializeModels();
  expect(arena.byteLength - arena.memoryRemaining()).toBe(384);
  const model = await registry.registerModel("m.md3"); expect(model.kind).toBe("md3");
  const report = accounting.report();
  expect(report.trace.filter(row => row.source === "R_LoadMD3").map(row => [row.resource, row.bytes])).toEqual([["m_2.md3", 164], ["m_1.md3", 164], ["m.md3", 164]]);
  expect(arena.byteLength - arena.memoryRemaining()).toBe(1088);
  expect(await registry.registerModel("m.md3")).toBe(model); expect(accounting.report()).toEqual(report);
  expect((await registry.registerModel("missing.md3")).kind).toBe("default");
  expect(arena.byteLength - arena.memoryRemaining()).toBe(1216);
  const missing = accounting.report(); await registry.registerModel("missing.md3"); expect(accounting.report()).toEqual(missing);
});

test("missing/empty skin records remain charged, tag rows do not allocate surfaces, shader-only keeps source sizeof(pointer)", async () => {
  const { accounting } = fixture(); const materials: string[] = [];
  const assets = reader(new Map([["empty.skin", new Uint8Array()], ["body.skin", new TextEncoder().encode("tag_head,\nbody,test/body\nlegs,test/legs\n")]]));
  const registry = new SceneModelRegistry(assets, async name => { materials.push(name); return defaultMaterial; }, { kind: "source-hunk", accounting }, defaultMaterial,
    () => undefined, index => index === defaultMaterial.order ? defaultMaterial : null, () => undefined);
  registry.initializeSkins(); registry.initializeModels();
  expect(await registry.registerSkin("missing.skin")).toBeNull(); expect(await registry.registerSkin("empty.skin")).toBeNull();
  const loaded = await registry.registerSkin("body.skin"); expect(loaded?.surfaces.length).toBe(2);
  await registry.registerSkin("test/shader");
  expect(accounting.report().trace.filter(row => row.source === "RE_RegisterSkin:surface").map(row => row.bytes)).toEqual([68, 68, 4]);
  expect(materials).toEqual(["test/body", "test/legs", "test/shader"]);
  const before = accounting.report(); await registry.registerSkin("BODY.SKIN"); expect(accounting.report()).toEqual(before);
});

for (const accounted of [false, true]) {
  test(`${accounted ? "accounted" : "unaccounted"} registry preserves strcmp model identity and default/inline slot limits`, async () => {
    const { accounting } = fixture();
    const profile: HunkAccountingProfile = accounted ? { kind: "source-hunk", accounting } : { kind: "unaccounted" };
    const registry = new SceneModelRegistry(reader(new Map([["m.md3", md3()], ["M.md3", md3()]])), async () => defaultMaterial, profile, defaultMaterial,
      () => undefined, index => index === defaultMaterial.order ? defaultMaterial : null, () => undefined);
    registry.initializeSkins(); registry.initializeModels();
    const first = await registry.registerModel("m.md3"), upper = await registry.registerModel("M.md3");
    expect(first.kind).toBe("md3"); expect(upper.kind).toBe("md3"); expect(upper).not.toBe(first);
    expect(await registry.registerModel("M.md3")).toBe(upper);
    registry.allocateInlineModels(inlineModels(1020));
    const last = await registry.registerModel("missing.md3"); expect(last.kind).toBe("default");
    const before = accounting.report();
    expect((await registry.registerModel("overflow.md3")).kind).toBe("default");
    expect(await registry.registerModel("m.md3")).toBe(first);
    expect(accounting.report()).toEqual(before);
    expect(() => registry.allocateInlineModels(inlineModels(1))).toThrow("MAX_MOD_KNOWN");
  });
  test(`${accounted ? "accounted" : "unaccounted"} skin slots include default and failed loads, but cache hits remain admitted at MAX_SKINS`, async () => {
    const { accounting } = fixture();
    const profile: HunkAccountingProfile = accounted ? { kind: "source-hunk", accounting } : { kind: "unaccounted" };
    const registry = new SceneModelRegistry(reader(new Map<string, Uint8Array>()), async () => defaultMaterial, profile, defaultMaterial,
      () => undefined, index => index === defaultMaterial.order ? defaultMaterial : null, () => undefined);
    registry.initializeSkins(); registry.initializeModels();
    const skin = await registry.registerSkin("test/shader"); expect(skin).not.toBeNull();
    for (let index = 0; index < 1022; index++) expect(await registry.registerSkin(`missing${index}.skin`)).toBeNull();
    const before = accounting.report();
    expect(await registry.registerSkin("test/overflow")).toBeNull();
    expect(await registry.registerSkin("TEST/SHADER")).toBe(skin);
    expect(accounting.report()).toEqual(before);
    if (accounted) expect(before.trace.filter(row => row.source === "RE_RegisterSkin").length).toBe(1023);
  });
}

test("actual world registration consumes inline model slots in the same resource registry", async () => {
  const { accounting } = fixture();
  const resources = await resourceFixture(reader(new Map([["maps/fixture.bsp", mapBytes()], ["m.md3", md3()]])), { kind: "source-hunk", accounting });
  for (let index = 0; index < 1022; index++) await resources.registerModel(`missing${index}.md3`);
  await resources.loadWorld("fixture");
  expect((await resources.registerModel("m.md3")).kind).toBe("default");
  expect((await resources.registerModel("*0")).kind).toBe("inline");
  // Untouched R_ModelInit/R_AllocModel, gcc-m32 model-cap oracle: 1024 requests, 131072 rounded bytes.
  const records = accounting.report().trace.filter(row => row.source.endsWith("R_AllocModel"));
  expect(records.length).toBe(1024);
  expect(records.reduce((sum, row) => sum + row.reservedBytes, 0)).toBe(131072);
});

test("MD3 permanent source copy is owned, malformed headers are bounded, and file leases cannot free another owner", async () => {
  const { accounting, arena } = fixture(), bytes = md3();
  const allocations: Uint8Array[] = [];
  const load = (bytes: Uint8Array) => loadMd3Resource({ bytes, source: "m.md3", material: async () => defaultMaterial,
    registration: { allocate: size => {
      const allocation = accounting.md3Allocation("m.md3", size); allocations.push(allocation); return allocation;
    }, publish: () => undefined, print: () => undefined } });
  expect(await load(bytes)).not.toBeNull();
  const stored = allocations[0];
  if (stored === undefined) throw new Error("MD3 loader did not allocate its source storage");
  bytes.fill(0); expect(new DataView(stored.buffer, stored.byteOffset).getInt32(0, true)).toBe(0x33504449);
  expect(stored.buffer.byteLength).toBe(arena.byteLength);
  await expect(load(new Uint8Array(4))).rejects.toThrow();
  const corrupt = md3(); new DataView(corrupt.buffer).setInt32(104, 1000, true);
  await expect(load(corrupt)).rejects.toThrow("MD3 copy exceeds source file allocation");
  const first = accounting.beginFile("a", Uint8Array.of(1)), second = accounting.beginFile("b", Uint8Array.of(2));
  expect(() => accounting.endFile("a", second)).toThrow("does not belong");
  accounting.endFile("a", first); accounting.endFile("b", second);
  expect(() => accounting.endFile("a", first)).toThrow("does not belong");
  arena.clear({ kind: "dedicated", shutdownGameProgs: () => undefined, clearVm: () => undefined });
  expect(() => accounting.modelRecord("stale")).toThrow("no longer valid");
});

test("an explicit unaccounted resource registry cannot accidentally claim a source arena", async () => {
  const resources = await resourceFixture(reader(new Map<string, Uint8Array>()), { kind: "unaccounted" });
  expect(resources.memoryProfile).toEqual({ kind: "unaccounted" });
});

const dataPath = process.env["Q3_DATA"];
for (const product of ["baseq3", "missionpack"] satisfies readonly ("baseq3" | "missionpack")[]) {
  test.skipIf(dataPath === undefined)(`${product}: actual retail collision allocations match the gcc-m32-O2 source trace`, async () => {
    if (dataPath === undefined) throw new Error("Q3_DATA required");
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    const source = product === "baseq3" ? "maps/q3dm1.bsp" : "maps/mpteam1.bsp", bytes = await vfs.read(source);
    const { accounting, arena } = fixture();
    new CollisionWorld(parseBsp(bytes), { kind: "source-hunk", accounting, source, fileBytes: bytes, fileLifetime: "detached", clientLoad: true }, { kind: "disabled" });
    expect(arena.memoryRemaining()).toBeLessThan(arena.byteLength);
    const requests = accounting.report().trace.filter(row => row.preference !== "temporary");
    // Compiler-specific native cm_load/cm_patch/cm_polylib capture, not a universal release numeric profile.
    expect(requests.length).toBe(product === "baseq3" ? 466 : 1700);
    const requestHash = new Bun.CryptoHasher("sha256").update(requests.map(row => row.bytes).join(",")).digest("hex");
    expect(requestHash).toBe(product === "baseq3"
      ? "b9308b88c1068b2ee0d517389685bcf6d093125a9087de8e3cd487f8b2bfbdce"
      : "e2eda8fb85b4ef75c0053abe5ef13c7350668d7ee046e9944e86b6153f21965e");
    expect(arena.byteLength - arena.memoryRemaining()).toBe(product === "baseq3" ? 790496 : 2648512);
    expect(requests.filter(row => row.source === "CM_PatchCollideFromGrid:planes").reduce((sum, row) => sum + row.bytes / 20, 0))
      .toBe(product === "baseq3" ? 4959 : 4777);
    expect(requests.filter(row => row.source === "CM_PatchCollideFromGrid:facets").reduce((sum, row) => sum + row.bytes / 320, 0))
      .toBe(product === "baseq3" ? 774 : 842);
    expect(requests.filter(row => row.source === "CMod_LoadShaders").map(row => row.bytes)).toEqual([product === "baseq3" ? 6768 : 8496]);
    const registry = new SceneModelRegistry(vfs, async () => defaultMaterial, { kind: "source-hunk", accounting }, defaultMaterial,
      () => undefined, index => index === defaultMaterial.order ? defaultMaterial : null, () => undefined);
    registry.initializeSkins(); registry.initializeModels();
    const before = arena.memoryRemaining(); expect((await registry.registerModel("models/players/sarge/lower.md3")).kind).toBe("md3");
    expect(arena.memoryRemaining()).toBeLessThan(before); expect(accounting.memoryRemaining()).toBe(arena.memoryRemaining());
  });
}
