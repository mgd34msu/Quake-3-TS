// BUILD_FREETYPE tr_font.c source behavior. Authored TrueType data, no retail assets.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ReadFileMemory } from "../src/assets/read-file-memory.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { FreeTypeFontLibrary } from "../src/platform/freetype.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RendererResources } from "../src/render/world.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** One unhinted 640-unit square, 768-unit advance, 1024 units per em. */
function squareFont(side = 640): Uint8Array {
  const table = (length: number) => new DataView(new ArrayBuffer(length));
  const head = table(54), hhea = table(36), maxp = table(32), hmtx = table(4), loca = table(4), glyf = table(34), cmap = table(274);
  head.setUint32(0, 0x10000); head.setUint32(12, 0x5f0f3cf5); head.setUint16(18, 1024);
  head.setInt16(40, side); head.setInt16(42, side); head.setUint16(46, 8);
  hhea.setUint32(0, 0x10000); hhea.setInt16(4, 800); hhea.setInt16(6, -200);
  hhea.setUint16(10, 768); hhea.setInt16(16, side); hhea.setInt16(18, 1); hhea.setUint16(34, 1);
  maxp.setUint32(0, 0x10000); maxp.setUint16(4, 1); maxp.setUint16(6, 4); maxp.setUint16(8, 1); maxp.setUint16(14, 1);
  hmtx.setUint16(0, 768); loca.setUint16(2, 17);
  glyf.setInt16(0, 1); glyf.setInt16(6, side); glyf.setInt16(8, side); glyf.setUint16(10, 3);
  for (let i = 14; i < 18; i++) glyf.setUint8(i, 1);
  glyf.setInt16(20, side); glyf.setInt16(24, -side); glyf.setInt16(30, side);
  cmap.setUint16(2, 1); cmap.setUint16(4, 3); cmap.setUint16(6, 1); cmap.setUint32(8, 12); cmap.setUint16(14, 262);
  const tables = new Map([['cmap', cmap], ['glyf', glyf], ['head', head], ['hhea', hhea], ['hmtx', hmtx], ['loca', loca], ['maxp', maxp]]);
  const bytes = new Uint8Array(12 + tables.size * 16 + [...tables.values()].reduce((sum, view) => sum + ((view.byteLength + 3) & -4), 0));
  const view = new DataView(bytes.buffer); view.setUint32(0, 0x10000); view.setUint16(4, tables.size);
  view.setUint16(6, 64); view.setUint16(8, 2); view.setUint16(10, 48);
  let index = 0, offset = 12 + tables.size * 16;
  for (const [tag, content] of tables) {
    const start = 12 + index++ * 16;
    bytes.set(new TextEncoder().encode(tag), start); view.setUint32(start + 8, offset); view.setUint32(start + 12, content.byteLength);
    bytes.set(new Uint8Array(content.buffer), offset); offset += (content.byteLength + 3) & -4;
  }
  return bytes;
}

const nativeFonts = FreeTypeFontLibrary.open(() => undefined);
if (nativeFonts.kind === "ready") nativeFonts.library.close();
const fontTest = nativeFonts.kind === "ready" ? test : test.skip;

fontTest("native parser and rasterizer preserve exact authored metrics, pixels and rejection", () => {
  const printed: string[] = [], opened = FreeTypeFontLibrary.open(text => { printed.push(text); });
  if (opened.kind !== "ready") throw new Error("Font tests require the optional system FreeType library");
  const library = opened.library;
  cleanup.push(() => library.close());
  const bytes = squareFont(), face = library.createFace(bytes, 16, text => { printed.push(text); });
  if (face === null) throw new Error("Authored square font did not load");
  const glyph = library.renderGlyph(face, 65, text => { printed.push(text); });
  if (glyph === null) throw new Error("Authored square outline did not render");
  expect({ ...glyph, pixels: undefined }).toEqual({ height: 10, pitch: 12, top: 11, bottom: 0, xSkip: 13, pixels: undefined });
  const expected = new Uint8Array(120);
  for (let row = 0; row < 10; row++) expected.fill(255, row * 12, row * 12 + 10);
  expect(glyph.pixels).toEqual(expected);
  expect(library.renderGlyph(face, 65, () => undefined)?.pixels).toEqual(expected);
  library.releaseFace(face);
  expect(library.createFace(bytes.subarray(0, 12), 16, text => { printed.push(text); })).toBeNull();
  expect(library.createFace(new Uint8Array(16).fill(255), 16, text => { printed.push(text); })).toBeNull();
  expect(printed).toEqual(Array.from({ length: 2 }, () => "RE_RegisterFont: FreeType2, unable to allocate new face.\n"));
  library.close(); library.close();
  expect(() => library.createFace(bytes, 16, () => undefined)).toThrow("closed");
});

async function fixture(save: boolean) {
  const root = await mkdtemp(join(tmpdir(), "quake3-font-export-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const files = new Map<string, Uint8Array>([["square.ttf", squareFont()]]), reads: string[] = [], writes: string[] = [], printed: string[] = [];
  const memory = new ReadFileMemory(); cleanup.push(() => memory.disposeResources());
  const read = (path: string) => { reads.push(path); const bytes = files.get(path); return bytes === undefined ? undefined : memory.read(bytes.length, target => target.set(bytes)); };
  const reader = {
    has: (path: string) => files.has(path), list: () => [],
    readFileLength: (path: string) => files.get(path)?.length ?? -1,
    readFileOptional: async (path: string) => files.get(path),
    read: async (path: string) => { const bytes = files.get(path); if (bytes === undefined) throw new Error(`Missing fixture ${path}`); return bytes; },
    readFileRetained: async (path: string) => read(path), readFileRetainedSync: read,
    freeFile: (bytes: Parameters<ReadFileMemory["freeFile"]>[0]) => memory.freeFile(bytes),
  };
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(32, 32, images), target = new RenderTarget(images, [cpu]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), settings = createRendererSettings();
  const movies = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined,
    print: () => undefined, files: { kind: "diagnostic-bytes", reader }, sound: { kind: "diagnostic", readMixer: () => null },
    clock: { sample: () => 0 }, scratchImages: builtins, console: { kind: "absent" },
    settings: { inGameVideo: () => 0, hardware: "generic", maxTextureSize: 4096 } });
  cleanup.push(() => { target.close(); movies.dispose(); });
  const resources = await RendererResources.create(reader, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, target, images, builtins, imageProfile: identityImageUploadProfile,
      shaderCinematics: movies.shaderCinematics, print: text => { printed.push(text); }, drawDebugSurface: () => undefined,
      fontGeneration: { saveFontData: () => save, async writeFile(name, bytes) {
        const path = join(root, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
        writes.push(name); files.set(name, new Uint8Array(await readFile(path)));
      } } });
  cleanup.push(() => resources.fonts.close());
  const commands = new RenderCommandBuffer(target, { print: text => { printed.push(text); }, clock: { milliseconds: () => 0 },
    identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => commands.close("discard"));
  printed.length = 0; reads.length = 0;
  return { root, files, reads, writes, printed, memory, resources, commands, cpu };
}

fontTest("font generation registers a real CPU texture, exports files and reloads DAT before reading the font", async () => {
  const f = await fixture(true), record = new Uint8Array(20548), view = new DataView(record.buffer);
  view.setInt32(255 * 80, 999, true); view.setInt32(255 * 80 + 44, 123, true);
  const last = record.slice(255 * 80, 256 * 80);
  const font = await f.resources.fonts.registerFont("square.ttf", 16, text => { f.printed.push(text); }, () => record);
  expect(font?.glyphScale).toBe(3); expect(font?.name).toBe("");
  expect(record.slice(255 * 80, 256 * 80)).toEqual(last);
  expect(f.memory.loadStack).toBe(0); expect(f.writes).toEqual(["fonts/fontImage_0_16.tga", "fonts/fontImage_16.dat"]);
  expect(new Uint8Array(await readFile(join(f.root, "fonts/fontImage_16.dat")))).toEqual(record);
  const page = f.files.get("fonts/fontImage_0_16.tga");
  if (page === undefined) throw new Error("Generated TGA missing");
  expect([...page.subarray(0, 18)]).toEqual([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 32, 0]);
  expect([...page.subarray(18, 22)]).toEqual([255, 255, 255, 255]);
  expect(page[18 + 10 * 4 + 3]).toBe(0);
  const glyph = font?.glyphs[0];
  if (glyph === undefined || glyph.picture === null) throw new Error("Generated glyph has no registered material");
  f.commands.setColor(null); f.commands.stretchPixels({ x: 0, y: 0, width: 12, height: 10 }, glyph, glyph.picture); f.commands.submitFrame();
  expect([...f.cpu.pixels.subarray((4 * 32 + 4) * 4, (4 * 32 + 4) * 4 + 4)]).toEqual([255, 255, 255, 255]);
  const loaded = await f.resources.fonts.registerFont("missing.ttf", 16, text => { f.printed.push(text); });
  expect(loaded?.name).toBe("fonts/fontImage_16.dat");
  expect(f.reads).toEqual(["square.ttf", "fonts/fontImage_16.dat"]); expect(f.memory.loadStack).toBe(1);
  expect(await f.resources.fonts.registerFont("another.ttf", 16, () => undefined)).toBe(loaded);
  expect(f.reads).toHaveLength(2); expect(f.printed).toEqual([]);
});

fontTest("source page overflow skips its glyph, retains destination metrics and excludes glyph 255", async () => {
  const f = await fixture(false), record = new Uint8Array(20548), view = new DataView(record.buffer);
  view.setInt32(57 * 80, 777, true); view.setInt32(255 * 80, 999, true);
  record.set(new TextEncoder().encode("source-name\0"), 20484);
  const font = await f.resources.fonts.registerFont("square.ttf", 48, () => undefined, () => record);
  expect(font?.name).toBe("source-name"); expect(font?.glyphScale).toBe(1);
  expect(font?.glyphs[56]?.t).toBe(248 / 256); expect(font?.glyphs[56]?.t2).toBe(278 / 256);
  expect(font?.glyphs[57]?.height).toBe(777); expect(font?.glyphs[57]?.pitch).toBe(0);
  expect(font?.glyphs[57]?.shaderName).toBe("fonts/fontImage_1_48.tga");
  expect(font?.glyphs[58]?.s).toBe(0); expect(font?.glyphs[58]?.t).toBe(0);
  expect(font?.glyphs[254]?.shaderName).toBe("fonts/fontImage_4_48.tga");
  expect(font?.glyphs[255]?.height).toBe(999); expect(font?.glyphs[255]?.shaderName).toBe("");
  expect(f.memory.loadStack).toBe(0); expect(f.writes).toEqual([]);
});

fontTest("missing, empty and malformed source fonts leave output intact and retain source failure allocations", async () => {
  const f = await fixture(false), record = new Uint8Array(20548).fill(0x55), before = record.slice();
  f.files.set("empty.ttf", new Uint8Array()); f.files.set("bad.ttf", new Uint8Array(16));
  for (const path of ["missing.ttf", "empty.ttf", "bad.ttf"])
    expect(await f.resources.fonts.registerFont(path, 12, text => { f.printed.push(text); }, () => record)).toBeNull();
  expect(record).toEqual(before); expect(f.memory.loadStack).toBe(2); expect(f.writes).toEqual([]);
  expect(f.printed).toEqual(["RE_RegisterFont: Unable to read font file\n", "RE_RegisterFont: Unable to read font file\n",
    "RE_RegisterFont: FreeType2, unable to allocate new face.\n"]);
});

fontTest("alpha is normalized across each page before registration and export", async () => {
  const f = await fixture(true); f.files.set("tiny.ttf", squareFont(24));
  const opened = FreeTypeFontLibrary.open(() => undefined);
  if (opened.kind !== "ready") throw new Error("FreeType became unavailable");
  cleanup.push(() => opened.library.close());
  const face = opened.library.createFace(squareFont(24), 16, () => undefined);
  if (face === null) throw new Error("Tiny authored face did not load");
  const glyph = opened.library.renderGlyph(face, 65, () => undefined);
  expect(glyph?.pixels[0]).toBeGreaterThan(0); expect(glyph?.pixels[0]).toBeLessThan(255);
  await f.resources.fonts.registerFont("tiny.ttf", 16, () => undefined);
  expect(f.files.get("fonts/fontImage_0_16.tga")?.[21]).toBe(255);
});

fontTest("default size and generated name cache still check six-slot capacity before a hit", async () => {
  const f = await fixture(false), record = new Uint8Array(20548);
  record.set(new TextEncoder().encode("fonts/fontImage_12.dat\0"), 20484);
  const first = await f.resources.fonts.registerFont("square.ttf", 0, () => undefined, () => record);
  expect(first?.glyphScale).toBe(4);
  expect(await f.resources.fonts.registerFont("missing.ttf", 12, () => undefined)).toBe(first);
  for (let size = 13; size <= 17; size++) expect(await f.resources.fonts.registerFont("square.ttf", size, () => undefined)).not.toBeNull();
  expect(await f.resources.fonts.registerFont("square.ttf", 12, text => { f.printed.push(text); })).toBeNull();
  expect(f.reads).toEqual(Array.from({ length: 6 }, () => "square.ttf"));
  expect(f.printed).toEqual(["RE_RegisterFont: Too many fonts registered already.\n"]);
});
