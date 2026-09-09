// R_ShaderList_f output chunks and SortNewShader ordering, id Software tr_shader.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { finishFailedShader, finishImplicitShader, finishShader } from "../src/render/material-finish.ts";
import type { FinishLoadedImageMetadata, FinishShaderProfile } from "../src/render/material-finish.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import type { MaterialContent, MaterialLighting } from "../src/render/material-registry.ts";
import { inspectShaderScript, normalizeShaderName, sameShaderName, shaderNameHash, stripShaderExtension } from "../src/render/material.ts";
import type { RegisteredImage, ShaderRegistrationHost } from "../src/render/material.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";
import { publishTexture } from "./render-target-fixture.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import type { HunkAccountingProfile } from "../src/render/hunk-accounting.ts";
import { ShaderTextPrograms } from "../src/render/shader-text.ts";
import { ReadFileMemory } from "../src/assets/read-file-memory.ts";

const profile: FinishShaderProfile = {
  detailTextures: true, vertexLight: false, uiFullscreen: false, hardware: "generic",
  iterator: { ignoreFastPath: false, multitexture: true, textureEnvAdd: true, driver: "generic" },
};

function fixture(script = "", finishProfile = profile, memory: HunkAccountingProfile = { kind: "unaccounted" }) {
  const image = publishTexture(new RendererImageCatalog(), { name: "shader-list-fixture", width: 1, height: 1,
    pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgba8",
    sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 });
  const registeredImage: RegisteredImage = { frame: { image }, tmu: 0 };
  const loaded: FinishLoadedImageMetadata = { kind: "loaded", tmu: 0,
    binding: { kind: "images", playback: { kind: "single", image: { image } } } };
  const programs = inspectShaderScript(script).entries;
  async function prepare(name: string, lighting: MaterialLighting): Promise<MaterialContent> {
    if (name === "throws") throw new Error("registration failed before publication");
    const lightmapIndex = lighting.kind === "lightmap" ? lighting.index : lighting.kind === "none" ? -1
      : lighting.kind === "white" ? -2 : lighting.kind === "vertex" ? -3 : -4;
    const program = programs.find(entry => sameShaderName(entry.name, stripShaderExtension(name)))?.program;
    if (program !== undefined) {
      const registered = await program.register({ whiteImage: registeredImage, defaultImage: registeredImage, lightmapImage: registeredImage,
        findImage: async request => request.name === "missing.tga" ? null : registeredImage,
        playShaderCinematic: async () => null, applySun() {}, printWarning() {}, initializeSkyTexCoords() {} });
      return { definition: registered.definition, image, whiteImage: image, sky: registered.sky, defaulted: registered.kind === "defaulted",
        finished: finishShader({ definition: registered.definition, images: registered.stages, lightmapIndex, profile: finishProfile }) };
    }
    const defaulted = normalizeShaderName(name) === "missing";
    const fields = { name, baseImage: loaded, profile: finishProfile };
    const finished = defaulted ? finishFailedShader({ name, lightmapIndex, profile: finishProfile })
      : name === "*default" ? finishImplicitShader({ ...fields, kind: "default" })
        : lighting.kind === "lightmap" ? finishImplicitShader({ ...fields, kind: "lightmap", lightmapIndex: lighting.index,
          lightmapImage: { ...loaded, tmu: 1 } })
          : lighting.kind === "white" ? finishImplicitShader({ ...fields, kind: "white", whiteImage: loaded })
            : finishImplicitShader({ ...fields, kind: lighting.kind === "none" ? "dynamic" : lighting.kind });
    return { definition: null, image, whiteImage: image, sky: null, defaulted, finished };
  }
  return { registry: new MaterialRegistry(prepare, text => { throw new Error(text); }, memory), image };
}

function chunks(registry: MaterialRegistry, sorted = false): readonly string[] {
  const result: string[] = [];
  registry.listShaders(sorted, text => { result.push(text); });
  return result;
}

function lightmaps(image: ReturnType<typeof fixture>["image"]): readonly [MaterialLighting, MaterialLighting] {
  const owner = parseBsp(renderBspFixture([{ shader: "same", lightmap: 0 }, { shader: "same", lightmap: 1 }], [[255, 255, 255], [127, 127, 127]]));
  return [{ kind: "lightmap", owner, index: 0, image }, { kind: "lightmap", owner, index: 1, image }];
}

test("empty listing has the exact source header, signed count and footer calls", () => {
  expect(chunks(fixture().registry)).toEqual(["-----------------------\n", "0 total shaders\n", "------------------\n"]);
});

test("supplied-image shaders bypass lookup preparation, preserve extension spelling, and synchronize only a new shader", async () => {
  const { image } = fixture();
  let prepared = 0, synchronized = 0;
  const registry = new MaterialRegistry(async () => { prepared++; throw new Error("Supplied image must not load shader text"); }, () => {});
  const context = { whiteImage: image, profile, smp: () => 1, synchronize: () => { synchronized++; } };
  const first = await registry.registerFromImage("Font/Page.TGA", { kind: "picture" }, image, false, context);
  expect(first.name).toBe("Font/Page.TGA");
  expect(first.image).toBe(image);
  expect(first.finished.lightmapIndex).toBe(-4);
  expect(first.finished.sourceStages[0]?.stage.blend).toEqual({ source: "src-alpha", destination: "one-minus-src-alpha" });
  expect(await registry.registerFromImage("font/page.tga", { kind: "picture" }, image, true, context)).toBe(first);
  const vertex = await registry.registerFromImage("Font/Page.TGA", { kind: "vertex" }, image, false, context);
  expect(vertex).not.toBe(first);
  expect(vertex.finished.lightmapIndex).toBe(-3);
  expect(synchronized).toBe(2); expect(prepared).toBe(0);
  const noExtension = await registry.registerFromImage("Font/Page", { kind: "picture" }, image, false, { ...context, smp: () => 0 });
  expect(noExtension).not.toBe(first); expect(synchronized).toBe(2);
});

test("source name hash uses signed bytes, first-dot termination and separator-only bucket folding", () => {
  expect(shaderNameHash("a", 1024)).toBe(284);
  expect(shaderNameHash("Ä", 1024)).toBe(26);
  expect(shaderNameHash("A.extra/path", 1024)).toBe(284);
  expect(shaderNameHash("a\0ignored", 1024)).toBe(284);
  expect(shaderNameHash("Path\\Stone", 2048)).toBe(shaderNameHash("path/stone", 2048));
});

test("internal default and stencil records keep their actual pass and iterator metadata", async () => {
  const { registry } = fixture();
  const fallback = await registry.register("*default", { kind: "none" });
  registry.registerStencilShadow(fallback);
  expect(chunks(registry)).toEqual([
    "-----------------------\n",
    "1 ", "  ", "      ", "  ", "gen ", ": <default>\n",
    "1 ", "  ", "      ", "  ", "gen ", ": <stencil shadow>\n",
    "2 total shaders\n", "------------------\n",
  ]);
});

test("listing prints exact source columns for all reachable iterators and texture environments", async () => {
  const { registry, image } = fixture(`
    Generic { { map first rgbGen identity } { map second blendFunc blend } }
    Additive { { map first rgbGen identity } { map second rgbGen identity blendFunc add } }
    Sky { skyParms - 512 - }
  `);
  await registry.register("Generic", { kind: "none" });
  await registry.register("Additive", { kind: "none" });
  await registry.register("Sky", { kind: "none" });
  await registry.register("Diffuse", { kind: "none" });
  await registry.register("Lightmapped", lightmaps(image)[0]);
  expect(chunks(registry)).toEqual([
    "-----------------------\n",
    "2 ", "  ", "      ", "E ", "gen ", ": Generic\n",
    "1 ", "  ", "MT(a) ", "E ", "gen ", ": Additive\n",
    "0 ", "  ", "      ", "E ", "sky ", ": Sky\n",
    "1 ", "  ", "      ", "  ", "vlt ", ": Diffuse\n",
    "1 ", "L ", "MT(m) ", "  ", "lmmt", ": Lightmapped\n",
    "5 total shaders\n", "------------------\n",
  ]);
});

test("registration order and source stable sort retain duplicate lighting variants and original remapped records", async () => {
  const { registry, image } = fixture("Later { sort additive { map first } } Earlier { sort portal { map first } }");
  const [firstLightmap, secondLightmap] = lightmaps(image);
  const later = await registry.register("Later", { kind: "none" });
  const first = await registry.register("Same", firstLightmap);
  const earlier = await registry.register("Earlier", { kind: "none" });
  const second = await registry.register("same.TGA", secondLightmap);
  expect(await registry.register("SAME.jpg", firstLightmap)).toBe(first);
  registry.remap("same", later, "2");
  registry.remap("Later", earlier, null);
  expect(first.remapped).toBe(later);
  expect(second.remapped).toBe(later);
  const rows = (sorted: boolean) => chunks(registry, sorted).filter(text => text.startsWith(": "));
  expect(rows(false)).toEqual([": Later\n", ": Same\n", ": Earlier\n", ": same\n"]);
  expect(rows(true)).toEqual([": Earlier\n", ": Same\n", ": same\n", ": Later\n"]);
  expect(rows(false)).toEqual([": Later\n", ": Same\n", ": Earlier\n", ": same\n"]);
  expect(chunks(registry, true).filter(text => text === "MT(m) ")).toHaveLength(2);
});

test("source lookup strips the first dot and NUL while retaining spelling and distinct path separators", async () => {
  const { registry } = fixture();
  const original = await registry.register("Textures\\MiXeD.TGA", { kind: "none" });
  expect(await registry.register("textures\\mixed.jpg", { kind: "none" })).toBe(original);
  const forward = await registry.register("textures/mixed.jpg", { kind: "none" });
  expect(forward).not.toBe(original);
  expect(registry.find("TEXTURES\\mixed.more.tga")).toBe(original);
  expect(registry.find("TEXTURES/mixed")).toBe(forward);
  const dotted = await registry.register("First.Dot/More.tga", { kind: "none" });
  expect(await registry.register("first.jpg", { kind: "none" })).toBe(dotted);
  expect(registry.find("first.dot.more.tga")).toBe(dotted);
  const terminated = await registry.register("Before\0After", { kind: "none" });
  expect(await registry.register("BEFORE.tga", { kind: "none" })).toBe(terminated);
  expect(chunks(registry).filter(text => text.startsWith(": "))).toEqual([
    ": Textures\\MiXeD\n", ": textures/mixed\n", ": First\n", ": Before\n",
  ]);
});

test("shader name comparison folds ASCII alone and remaps only matching names in a shared hash bucket", async () => {
  const { registry, image } = fixture(), [firstLightmap, secondLightmap] = lightmaps(image);
  const backward = await registry.register("Path\\Stone", firstLightmap);
  const otherLighting = await registry.register("PATH\\STONE.jpg", secondLightmap);
  const forward = await registry.register("Path/Stone", firstLightmap);
  const upper = await registry.register("Ä", { kind: "none" });
  const lower = await registry.register("ä", { kind: "none" });
  expect(lower).not.toBe(upper);
  expect(registry.find("Ä.tga")).toBe(upper);
  expect(registry.find("ä.jpg")).toBe(lower);
  expect(registry.find("path\\stone")).toBe(otherLighting);
  registry.remap("path\\stone.first.second\0tail", lower, "2");
  expect(backward.remapped).toBe(lower);
  expect(otherLighting.remapped).toBe(lower);
  expect(forward.remapped).toBeNull();
  expect(upper.remapped).toBeNull();
  expect(lower.timeOffset).toBe(2);
});

test("permanent internal names own their hash entries and empty requests return the actual default", async () => {
  const { registry } = fixture();
  const fallback = await registry.register("*default", { kind: "none" });
  expect(registry.find("<DEFAULT>.tga")).toBe(fallback);
  expect(registry.find("*default")).toBeNull();
  expect(registry.find("")).toBe(fallback);
  expect(await registry.register("\0ignored", { kind: "picture" })).toBe(fallback);
  expect(chunks(registry).at(-2)).toBe("1 total shaders\n");
});

test("source MAX_QPATH accepts 63 characters before a dot or NUL and explicitly rejects a reached stack overflow", async () => {
  const { registry } = fixture(), longest = "x".repeat(63), overflow = `${longest}x`;
  const record = await registry.register(`${longest}.ignored${overflow}`, { kind: "none" });
  expect(record.name).toBe(longest);
  expect(await registry.register(`${longest}\0${overflow}`, { kind: "none" })).toBe(record);
  expect(registry.find(`${longest}.jpg`)).toBe(record);
  await expect(registry.register(overflow, { kind: "none" })).rejects.toThrow("COM_StripExtension MAX_QPATH");
  expect(() => registry.find(overflow)).toThrow("COM_StripExtension MAX_QPATH");
  expect(() => registry.remap(overflow, record, null)).toThrow("COM_StripExtension MAX_QPATH");
  expect(chunks(registry).at(-2)).toBe("1 total shaders\n");
});

test("named image and parse failures remain listed without the successful explicit flag", async () => {
  const { registry } = fixture(`
    BadImage { { map first } { map missing.tga } }
    BadText { { map first } invalidDirective }
    Video { { videoMap absent.roq } }
  `);
  const missing = await registry.register("Missing.TGA", { kind: "picture" });
  expect(await registry.register("missing", { kind: "none" })).toBe(missing);
  await registry.register("BadImage", { kind: "none" });
  await registry.register("BadText", { kind: "none" });
  await registry.register("Video", { kind: "none" });
  expect(chunks(registry)).toEqual([
    "-----------------------\n",
    "0 ", "  ", "      ", "  ", "gen ", ": Missing (DEFAULTED)\n",
    "2 ", "  ", "      ", "  ", "gen ", ": BadImage (DEFAULTED)\n",
    "1 ", "  ", "      ", "  ", "gen ", ": BadText (DEFAULTED)\n",
    "1 ", "  ", "      ", "E ", "gen ", ": Video\n",
    "4 total shaders\n", "------------------\n",
  ]);
});

test("lightmap column reflects FinishShader clearing after vertex-light collapse", async () => {
  const { registry, image } = fixture("Vertex { { map $lightmap } { map first blendFunc filter } }", { ...profile, vertexLight: true });
  await registry.register("Vertex", lightmaps(image)[0]);
  expect(chunks(registry)).toEqual([
    "-----------------------\n", "1 ", "  ", "      ", "E ", "gen ", ": Vertex\n",
    "1 total shaders\n", "------------------\n",
  ]);
});

test("failed preparation publishes no row and does not prevent later registration or synchronous print failure", async () => {
  const { registry } = fixture();
  await expect(registry.register("throws", { kind: "none" })).rejects.toThrow("registration failed before publication");
  const later = await registry.register("Later", { kind: "none" });
  expect(later.order).toBe(0);
  const received: string[] = [];
  expect(() => registry.listShaders(false, text => {
    received.push(text);
    if (text === "1 ") throw new Error("print lifetime ended");
  })).toThrow("print lifetime ended");
  expect(received).toEqual(["-----------------------\n", "1 "]);
  expect(chunks(registry)).toEqual([
    "-----------------------\n", "1 ", "  ", "      ", "  ", "vlt ", ": Later\n",
    "1 total shaders\n", "------------------\n",
  ]);
});

function memoryFixture(bytes = 65536) {
  const arena = new HunkArena(bytes, () => {}), accounting = new SourceHunkAccounting(arena);
  const memory: HunkAccountingProfile = { kind: "source-hunk", accounting };
  return { arena, accounting, memory };
}

test("permanent shader allocation follows collapsed stages and both actual texture bundles", async () => {
  const { arena, accounting, memory } = memoryFixture();
  const { registry } = fixture(`Merged {
    { map first rgbGen identity
      tcMod scroll 1 2
    }
    { map second rgbGen identity blendFunc filter
      tcMod scale 3 4
      tcMod rotate 10
    }
  }`, profile, memory);
  const material = await registry.register("Merged", { kind: "none" });
  expect(material.finished.iterator.multitextureEnv).toBe("modulate");
  expect(material.finished.numUnfoggedPasses).toBe(1);
  expect(accounting.report().trace.map(event => [event.source, event.bytes])).toEqual([
    ["GeneratePermanentShader", 580], ["GeneratePermanentShader:stage", 252],
    ["GeneratePermanentShader:texMods", 68], ["GeneratePermanentShader:texMods", 136],
  ]);
  expect(arena.memoryRemaining()).toBe(65536 - 608 - 256 - 96 - 160);
  expect(await registry.register("merged", { kind: "none" })).toBe(material);
  expect(accounting.report().trace.length).toBe(4);
});

test("internal shader records allocate their active stage and zero-sized bundles independently", async () => {
  const { accounting, memory } = memoryFixture();
  const { registry } = fixture("", profile, memory);
  const fallback = await registry.register("*default", { kind: "none" });
  registry.registerStencilShadow(fallback);
  await registry.register("missing", { kind: "none" });
  expect(accounting.report().trace.map(event => event.bytes)).toEqual([580, 252, 0, 0, 580, 252, 0, 0, 580]);
});

test("missing texMod parameters retain the source slot and continue later stage directives", async () => {
  const { accounting, memory } = memoryFixture();
  const { registry } = fixture("Partial {\n{\nmap first\ntcMod scale 2\nrgbGen vertex\ntcMod scroll 1 2\n}\n}", profile, memory);
  const result = await registry.register("Partial", { kind: "none" });
  expect(result.defaulted).toBeFalse();
  expect(result.definition?.stages[0]?.tcMods).toEqual([{ kind: "none" }, { kind: "scroll", amount: { x: 1, y: 2 } }]);
  expect(result.definition?.stages[0]?.rgbGen.kind).toBe("vertex");
  expect(accounting.report().trace.map(event => event.bytes)).toEqual([580, 252, 136, 0]);
});

test("excess texMods drop registration after image work and before permanent shader publication", async () => {
  const { accounting, memory } = memoryFixture();
  const { registry } = fixture(`Overflow {\n{\nmap first\n${"tcMod scale 1 1\n".repeat(5)}}\n}`, profile, memory);
  await expect(registry.register("Overflow", { kind: "none" })).rejects.toThrow("ERROR: too many tcMod stages in shader 'Overflow'");
  expect(registry.findByHandle(0)).toBeNull();
  expect(accounting.report().trace).toEqual([]);
});

test("stage allocation failure preserves the source handle publication before name-hash insertion", async () => {
  const { accounting, memory } = memoryFixture(608);
  const { registry } = fixture("", profile, memory);
  await expect(registry.register("partial", { kind: "none" })).rejects.toThrow();
  expect(registry.find("partial")).toBeNull();
  expect(registry.findByHandle(0)?.name).toBe("partial");
  expect(accounting.report().trace.map(event => event.bytes)).toEqual([580]);
  expect(chunks(registry).at(-2)).toBe("1 total shaders\n");
});

test("failed stage allocations retain the unsorted source shader-array publication", async () => {
  const { memory } = memoryFixture(1472);
  const { registry } = fixture("Earlier { sort portal { map image } }", profile, memory);
  await registry.register("Later", { kind: "none" });
  await expect(registry.register("Earlier", { kind: "none" })).rejects.toThrow();
  expect(registry.findByHandle(1)?.sort).toBe(1);
  expect(chunks(registry, true).filter(text => text.startsWith(": "))).toEqual([": Later\n", ": Earlier\n"]);
});

test("inactive first stages stop permanent stage allocations even with a later finished pass", async () => {
  const { accounting, memory } = memoryFixture();
  const { registry } = fixture("Inactive { { map missing.tga } { map later } }", profile, memory);
  const result = await registry.register("Inactive", { kind: "none" });
  expect(result.defaulted).toBeTrue();
  expect(accounting.report().trace.map(event => event.bytes)).toEqual([580]);
});

async function firstMap(programs: ShaderTextPrograms, name: string): Promise<string | undefined> {
  const image: RegisteredImage = { frame: { image: fixture().image }, tmu: 0 };
  const program = programs.find(name);
  if (program === undefined) return undefined;
  const registered = await program.register({ defaultImage: image, whiteImage: image, lightmapImage: image,
    findImage: async () => image, playShaderCinematic: async () => null, applySun() {}, printWarning() {}, initializeSkyTexCoords() {} });
  const map = registered.definition.stages[0]?.map;
  return map?.kind === "image" ? map.name : undefined;
}

test("shader text retains dotted labels and separates equal-hash paths with ASCII-only NUL-terminated comparison", async () => {
  const programs = new ShaderTextPrograms();
  const text = 'Textures\\Mixed { { map backward } } textures/mixed { { map forward } } First.Dot { { map dotted } } "Ä" { { map upper } } "ä" { { map lower } }';
  const bytes = new Uint8Array(Array.from(text, letter => letter.charCodeAt(0)));
  await programs.load({ kind: "detached", source: { list: () => ["scripts/names.shader"], readFileOptional: async () => bytes } },
    { kind: "unaccounted" }, () => {});
  expect(await firstMap(programs, "TEXTURES\\mixed")).toBe("backward");
  expect(await firstMap(programs, "TEXTURES/mixed\0ignored")).toBe("forward");
  expect(await firstMap(programs, "first.dot")).toBe("dotted");
  expect(programs.find("first")).toBeUndefined();
  expect(await firstMap(programs, "Ä")).toBe("upper");
  expect(await firstMap(programs, "ä")).toBe("lower");
});

test("matched shader text uses the requested spelling for the definition and reached registration diagnostics", async () => {
  const programs = new ShaderTextPrograms(), image: RegisteredImage = { frame: { image: fixture().image }, tmu: 0 };
  const bytes = new TextEncoder().encode(`MiXeD { { map first } } Overflow {\n{\nmap first\n${"tcMod scale 1 1\n".repeat(5)}}\n}`);
  await programs.load({ kind: "detached", source: { list: () => ["scripts/names.shader"], readFileOptional: async () => bytes } },
    { kind: "unaccounted" }, () => {});
  const host = { defaultImage: image, whiteImage: image, lightmapImage: image,
    findImage: async () => image, playShaderCinematic: async () => null, applySun() {}, printWarning() {}, initializeSkyTexCoords() {} };
  const matched = programs.find("MIXED\0ignored"), overflow = programs.find("OVERFLOW");
  if (matched === undefined || overflow === undefined) throw new Error("Missing source lookup fixture programs");
  expect((await matched.register(host)).definition.name).toBe("MIXED");
  await expect(overflow.register(host)).rejects.toThrow("ERROR: too many tcMod stages in shader 'OVERFLOW'");
});

test("matched shader lookup defers body parsing and retains the reached prefix on a source token overflow", async () => {
  const programs = new ShaderTextPrograms(), events: string[] = [];
  const image: RegisteredImage = { frame: { image: fixture().image }, tmu: 0 };
  const bytes = new TextEncoder().encode(`MiXeD { { map first } { map ${"x".repeat(1024)} } { map later } }`);
  await programs.load({ kind: "detached", source: { list: () => ["scripts/overflow.shader"], readFileOptional: async () => bytes } },
    { kind: "unaccounted" }, () => {});
  const program = programs.find("MIXED");
  if (program === undefined) throw new Error("Missing source lookup fixture program");
  expect(events).toEqual([]);
  events.push("*SHADER* MIXED");
  const result = await program.register({ defaultImage: image, whiteImage: image, lightmapImage: image,
    async findImage(request) { events.push(request.name); return image; },
    playShaderCinematic: async () => null, applySun() {}, printWarning() {}, initializeSkyTexCoords() {} });
  expect(events).toEqual(["*SHADER* MIXED", "first"]);
  expect(result.kind).toBe("defaulted");
  expect(result.definition.name).toBe("MIXED");
  expect(result.definition.stages.map(stage => stage.depthWrite)).toEqual([true, false]);
  expect(result.stages.map(stage => stage.kind)).toEqual(["loaded", "missing"]);
  if (result.kind !== "defaulted") throw new Error("Expected source parameter rejection");
  expect(result.failure.kind).toBe("source-text");
});

test("source animation parsing registers each frame before reading its next token", async () => {
  const programs = new ShaderTextPrograms(), events: string[] = [];
  const image: RegisteredImage = { frame: { image: fixture().image }, tmu: 0 };
  const bytes = new TextEncoder().encode(`animated { { animMap 4 first ${"x".repeat(1024)}\n map last } }`);
  await programs.load({ kind: "detached", source: { list: () => ["scripts/animation.shader"], readFileOptional: async () => bytes } },
    { kind: "unaccounted" }, () => {});
  const program = programs.find("animated");
  if (program === undefined) throw new Error("Missing source animation fixture program");
  const stopped = new Error("first image interrupted parsing");
  await expect(program.register({ defaultImage: image, whiteImage: image, lightmapImage: image,
    async findImage(request) { events.push(request.name); throw stopped; },
    playShaderCinematic: async () => null, applySun() {}, printWarning() {}, initializeSkyTexCoords() {} })).rejects.toThrow(stopped);
  expect(events).toEqual(["first"]);
  events.length = 0;
  const result = await program.register({ defaultImage: image, whiteImage: image, lightmapImage: image,
    async findImage(request) { events.push(request.name); return image; },
    playShaderCinematic: async () => null, applySun() {}, printWarning() {}, initializeSkyTexCoords() {} });
  expect(events).toEqual(["first", "last"]);
  expect(result.kind).toBe("defined");
  const stage = result.stages[0];
  if (stage?.kind !== "loaded" || stage.binding.kind !== "images" || stage.binding.playback.kind !== "animation") {
    throw new Error("Expected retained animation storage");
  }
  expect(stage.binding.playback.frequency).toBe(4);
  expect(stage.binding.playback.frames).toHaveLength(1);
});

test("source sky image work precedes an oversized cloud-height token", async () => {
  const programs = new ShaderTextPrograms(), events: string[] = [];
  const image: RegisteredImage = { frame: { image: fixture().image }, tmu: 0 };
  const bytes = new TextEncoder().encode(`sky { skyParms env/outer ${"x".repeat(1024)}\n { map later } }`);
  await programs.load({ kind: "detached", source: { list: () => ["scripts/sky.shader"], readFileOptional: async () => bytes } },
    { kind: "unaccounted" }, () => {});
  const program = programs.find("sky");
  if (program === undefined) throw new Error("Missing source sky fixture program");
  const result = await program.register({ defaultImage: image, whiteImage: image, lightmapImage: image,
    async findImage(request) { events.push(request.name); return image; },
    playShaderCinematic: async () => null, applySun() {}, printWarning() {}, initializeSkyTexCoords(height) { events.push(`sky:${height}`); } });
  expect(events).toEqual(["env/outer_rt.tga", "env/outer_bk.tga", "env/outer_lf.tga", "env/outer_ft.tga",
    "env/outer_up.tga", "env/outer_dn.tga", "later"]);
  expect(result.definition.sky).toBeNull();
  expect(result.sky?.outer?.image("rt")).toBe(image.frame);
  expect(result.sky?.cloudHeight).toBe(0);
});

test("shader image callbacks can look up another match without moving the caller's text pointer", async () => {
  const programs = new ShaderTextPrograms(), events: string[] = [];
  const image: RegisteredImage = { frame: { image: fixture().image }, tmu: 0 };
  const bytes = new TextEncoder().encode("outer { { map first map last } } inner { { map nested } }");
  await programs.load({ kind: "detached", source: { list: () => ["scripts/nested.shader"], readFileOptional: async () => bytes } },
    { kind: "unaccounted" }, () => {});
  const program = programs.find("outer");
  if (program === undefined) throw new Error("Missing outer shader fixture program");
  const host: ShaderRegistrationHost = { defaultImage: image, whiteImage: image, lightmapImage: image,
    async findImage(request) {
      events.push(request.name);
      if (request.name === "first") {
        const nested = programs.find("inner");
        if (nested === undefined) throw new Error("Missing inner shader fixture program");
        events.push("lookup:inner");
      }
      return image;
    }, playShaderCinematic: async () => null, applySun() {}, printWarning() {}, initializeSkyTexCoords() {} };
  const result = await program.register(host);
  expect(result.kind).toBe("defined");
  expect(result.definition.name).toBe("outer");
  expect(events).toEqual(["first", "lookup:inner", "last"]);
});

test("shader scan reads first, frees in reverse, and consumes the source reverse-buffer hash order", async () => {
  const { accounting, memory } = memoryFixture();
  const first = new TextEncoder().encode("// first file\nsame { { map first } } second { { map firstSecond } }\n");
  const second = new TextEncoder().encode("same { { map other } } second { { map otherSecond } }\n");
  const programs = new ShaderTextPrograms(), reads: string[] = [], printed: string[] = [];
  await programs.load({ kind: "detached", source: { list: () => ["scripts/a.shader", "scripts/b.shader"], async readFileOptional(path) {
    reads.push(path);
    return path === "scripts/a.shader" ? first : second;
  } } }, memory, text => { printed.push(text); });
  expect(reads).toEqual(["scripts/a.shader", "scripts/b.shader"]);
  expect(printed).toEqual(["...loading 'scripts/a.shader'\n", "...loading 'scripts/b.shader'\n"]);
  expect(accounting.report().trace.map(event => [event.source, event.resource, event.bytes])).toEqual([
    ["FS_ReadFile", "scripts/a.shader", first.length + 1], ["FS_ReadFile", "scripts/b.shader", second.length + 1],
    ["ScanAndLoadShaderFiles:shaderText", "scripts/*.shader", first.length + second.length + 4],
    ["FS_FreeFile", "scripts/b.shader", second.length + 1], ["FS_FreeFile", "scripts/a.shader", first.length + 1],
    ["ScanAndLoadShaderFiles:hashMem", "scripts/*.shader", (2048 + 5) * 4],
  ]);
  expect(await firstMap(programs, "SAME")).toBe("first");
  expect(await firstMap(programs, "second")).toBe("othersecond");
  expect(programs.find("absent")).toBeUndefined();
});

test("shader text consumes compressed bytes with embedded NUL while retaining source read lengths", async () => {
  const { accounting, memory } = memoryFixture();
  const bytes = new TextEncoder().encode(" /* before */ valid {\n { map retained }\n }\0ignored { { map hidden } }");
  const programs = new ShaderTextPrograms();
  await programs.load({ kind: "detached", source: { list: () => ["scripts/a.shader"], readFileOptional: async () => bytes } }, memory, () => {});
  expect(await firstMap(programs, "valid")).toBe("retained");
  expect(programs.find("ignored")).toBeUndefined();
  expect(accounting.report().trace.find(event => event.source === "ScanAndLoadShaderFiles:shaderText")?.bytes).toBe(bytes.length + 2);
  expect(accounting.report().trace.at(-1)?.bytes).toBe((2048 + 1) * 4);
});

test("retained shader reads use one common FS allocation and free actual buffers in reverse", async () => {
  const { arena, accounting, memory } = memoryFixture();
  const files = new ReadFileMemory(() => arena), programs = new ShaderTextPrograms(), freed: string[] = [];
  const records = new Map<string, ReturnType<ReadFileMemory["read"]>>();
  const source = {
    list: () => ["scripts/a.shader", "scripts/b.shader"],
    readFileRetainedSync(path: string) {
      const bytes = new TextEncoder().encode(path === "scripts/a.shader" ? "same { { map first } }" : "same { { map other } }");
      const buffer = files.read(bytes.length, storage => { storage.set(bytes); });
      records.set(path, buffer);
      return buffer;
    },
    async readFileRetained(path: string) { return this.readFileRetainedSync(path); },
    freeFile(buffer: ReturnType<ReadFileMemory["read"]>) {
      for (const [name, record] of records) if (record === buffer) freed.push(name);
      files.freeFile(buffer);
    },
  };
  await programs.load({ kind: "retained", source }, memory, () => {});
  expect(files.loadCount).toBe(2);
  expect(files.loadStack).toBe(0);
  expect(freed).toEqual(["scripts/b.shader", "scripts/a.shader"]);
  expect(accounting.report().trace.map(event => event.source)).toEqual(["ScanAndLoadShaderFiles:shaderText", "ScanAndLoadShaderFiles:hashMem"]);
  expect(await firstMap(programs, "same")).toBe("first");
  for (const buffer of records.values()) expect(() => buffer.bytes).toThrow("no longer valid");
});

test("failed shader reads retain earlier temporary files and never publish a text allocation", async () => {
  const { accounting, memory } = memoryFixture();
  const programs = new ShaderTextPrograms(), bytes = new TextEncoder().encode("good { { map first } }");
  await expect(programs.load({ kind: "detached", source: { list: () => ["scripts/a.shader", "scripts/missing.shader"],
    readFileOptional: async path => path === "scripts/a.shader" ? bytes : undefined } }, memory, () => {})).rejects.toThrow("Couldn't load scripts/missing.shader");
  expect(accounting.report().trace.map(event => event.source)).toEqual(["FS_ReadFile"]);
  expect(programs.find("good")).toBeUndefined();
});

test("empty shader scan warns without allocating and hunk reset invalidates a loaded text owner", async () => {
  const { arena, accounting, memory } = memoryFixture();
  const empty = new ShaderTextPrograms(), printed: string[] = [];
  await empty.load({ kind: "detached", source: { list: () => [], readFileOptional: async () => undefined } }, memory, text => { printed.push(text); });
  expect(printed).toEqual(["WARNING: no shader files found\n"]);
  expect(accounting.report().trace).toEqual([]);
  const programs = new ShaderTextPrograms();
  await programs.load({ kind: "detached", source: { list: () => ["scripts/a.shader"], readFileOptional: async () => new TextEncoder().encode("present { { map image } }") } }, memory, () => {});
  arena.clear({ kind: "dedicated", shutdownGameProgs() {}, clearVm() {} });
  expect(() => programs.find("present")).toThrow();
});
