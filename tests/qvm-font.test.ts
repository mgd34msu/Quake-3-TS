import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
// Font registration ABI from id Software tr_font.c, cl_ui.c and cl_cgame.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, test } from "bun:test";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RendererResources } from "../src/render/world.ts";
import { QVM_FONT_INFO_BYTES, qvmFontSyscall } from "../src/vm/font-syscalls.ts";
import type { QvmFontServices } from "../src/vm/font-syscalls.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { solidTga } from "./render-bsp-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function fixtureBytes(): Uint8Array {
  const bytes = new Uint8Array(20548), view = new DataView(bytes.buffer);
  for (let index = 0; index < 256; index++) {
    const offset = index * 80;
    for (const [field, value] of [9, -5, -2, 8, 7, 2, 2].entries()) view.setInt32(offset + field * 4, value, true);
    for (const [field, value] of [-0, 0.125, 0.75, 1].entries()) view.setFloat32(offset + 28 + field * 4, value, true);
    view.setInt32(offset + 44, 0x12000000 + index, true);
    const name = index === 1 ? "second.tga" : index === 2 ? "" : index === 3 ? "missing.tga" : "first.tga";
    bytes.fill(0xa5, offset + 48, offset + 80);
    bytes.set(new TextEncoder().encode(name + "\0"), offset + 48);
  }
  view.setUint32(255 * 80 + 44, 0x87654321, true);
  bytes.set([0xff, 0], 255 * 80 + 48);
  view.setFloat32(20480, 4, true);
  bytes.fill(0xee, 20484);
  bytes.set(new TextEncoder().encode("saved-name\0"), 20484);
  return bytes;
}

function words(trap: number, pointSize = 12, destination = 1024, name = 0): DataView {
  const result = new DataView(new ArrayBuffer(16));
  for (const [index, value] of [trap, name, pointSize, destination].entries()) result.setInt32(index * 4, value, true);
  return result;
}

async function fixture() {
  const files = new Map<string, Uint8Array>([
    ["first.tga", solidTga(255, 255, 255)], ["second.tga", solidTga(0, 255, 0)],
    ["prior.tga", solidTga(255, 0, 0)], ["fonts/fontImage_12.dat", fixtureBytes()],
  ]);
  const reads: string[] = [], lengths: string[] = [], printed: string[] = [], clears: number[] = [];
  const observers: ((path: string) => undefined | Promise<undefined>)[] = [];
  const reader: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
    has: path => files.has(path), list: () => [],
    readFileLength: path => { lengths.push(path); return files.get(path)?.byteLength ?? -1; },
    async readFileOptional(path) {
      reads.push(path);
      for (const observe of observers) await observe(path);
      return files.get(path);
    },
    async read(path) {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`Missing authored file ${path}`);
      return bytes;
    },
  });
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(8, 8, images), target = new RenderTarget(images, [cpu]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), settings = createRendererSettings();
  const movies = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader },
    sound: { kind: "diagnostic", readMixer: () => null }, clock: { sample: () => 0 }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 0, hardware: "generic", maxTextureSize: 4096 } });
  cleanup.push(() => { target.close(); movies.dispose(); });
  const resources = await RendererResources.create(reader, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, target, images, builtins, imageProfile: identityImageUploadProfile, shaderCinematics: movies.shaderCinematics,
      print: text => { printed.push(text); }, drawDebugSurface: () => { throw new Error("Unexpected debug surface"); } });
  const commands = new RenderCommandBuffer(target, { print: text => { printed.push(text); },
    clock: { milliseconds: () => 0 }, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => { commands.close("discard"); });
  const memory = new QvmMemory(new Uint8Array(65536).fill(0x77));
  const services: QvmFontServices = { fonts: resources.fonts,
    print: text => { printed.push(text); }, clearScene: () => { resources.clearScene(); clears.push(reads.length); } };
  reads.length = 0; lengths.length = 0; printed.length = 0;
  return { resources, commands, memory, services, files, reads, lengths, printed, clears, observers };
}

test("UI writes the complete 256-glyph ABI using actual material handles and retained source tails", async () => {
  const f = await fixture();
  await f.resources.registerShaderNoMip("prior.tga");
  expect(QVM_FONT_INFO_BYTES).toBe(20548);
  expect(await qvmFontSyscall("ui", words(55), f.memory, f.services)).toBe(0);
  const first = f.resources.shaderHandle(await f.resources.registerShaderNoMip("first.tga"));
  const second = f.resources.shaderHandle(await f.resources.registerShaderNoMip("second.tga"));
  expect(first).toBeGreaterThan(0); expect(second).toBeGreaterThan(first);
  const expected = fixtureBytes(), view = new DataView(expected.buffer);
  for (let index = 0; index < 255; index++) view.setInt32(index * 80 + 44, index === 1 ? second : index === 2 || index === 3 ? 0 : first, true);
  expected.fill(0, 20484); expected.set(new TextEncoder().encode("fonts/fontImage_12.dat"), 20484);
  expect(f.memory.span(1024, 20548)).toEqual(expected);
  expect(f.memory.bytes[1023]).toBe(0x77); expect(f.memory.bytes[1024 + 20548]).toBe(0x77);
  expect(f.clears).toEqual([]);
  expect(f.reads.filter(path => path.startsWith("fonts/"))).toEqual(["fonts/fontImage_12.dat"]);
  const font = await f.resources.fonts.registerFont("ignored", 12, text => { f.printed.push(text); });
  expect(font?.glyphs[255]?.shaderName).toBe("\xff");
});

test("shader-name reads continue into the following glyph inside the owned source record", async () => {
  const f = await fixture(), bytes = fixtureBytes(), shaderName = "a".repeat(32) + "!";
  bytes.fill(97, 48, 80); new DataView(bytes.buffer).setInt32(80, 33, true);
  f.files.set("fonts/fontImage_12.dat", bytes);
  f.files.set(`${shaderName}.tga`, solidTga(255, 0, 255));
  expect(await qvmFontSyscall("ui", words(55), f.memory, f.services)).toBe(0);
  expect(f.reads).toContain(`${shaderName}.tga`);
  const handle = f.resources.shaderHandle(await f.resources.registerShaderNoMip(shaderName));
  expect(handle).toBeGreaterThan(0);
  expect(f.memory.view(1024, 20548).getInt32(44, true)).toBe(handle);
  expect(f.memory.span(1024 + 48, 32)).toEqual(new Uint8Array(32).fill(97));
});

test("font registration drains actual queued commands before file reads, cache and capacity returns", async () => {
  const f = await fixture(), order: string[] = [];
  f.observers.push((path): undefined => { if (path.startsWith("fonts/")) order.push("read"); });
  f.commands.addPreparedViews(() => { order.push("fresh"); return []; });
  await qvmFontSyscall("ui", words(55), f.memory, f.services);
  expect(order).toEqual(["fresh", "read"]);
  f.commands.addPreparedViews(() => { order.push("cached"); return []; });
  await qvmFontSyscall("ui", words(55), f.memory, f.services);
  expect(order).toEqual(["fresh", "read", "cached"]);
  for (let size = 13; size < 18; size++) {
    f.files.set(`fonts/fontImage_${size}.dat`, fixtureBytes());
    await qvmFontSyscall("ui", words(55, size), f.memory, f.services);
  }
  f.commands.addPreparedViews(() => { order.push("full"); return []; });
  expect(await qvmFontSyscall("ui", words(55, 12, 0), f.memory, f.services)).toBe(0);
  expect(order.at(-1)).toBe("full");
  expect(f.printed.at(-1)).toBe("RE_RegisterFont: Too many fonts registered already.\n");
});

test("UI and cgame cache copies share actual renderer slots, detached from VM and file mutations", async () => {
  const f = await fixture();
  expect(await qvmFontSyscall("ui", words(55, -20), f.memory, f.services)).toBe(0);
  const expected = f.memory.span(1024, 20548).slice(), reads = f.reads.length;
  f.memory.span(1024, 20548).fill(0x88);
  f.files.set("fonts/fontImage_12.dat", new Uint8Array());
  expect(await qvmFontSyscall("cgame", words(59, 0, 32768, -1), f.memory, f.services)).toBe(0);
  expect(f.memory.span(32768, 20548)).toEqual(expected);
  expect(f.reads).toHaveLength(reads); expect(f.clears).toHaveLength(1);
});

test("no-FreeType failures retain destinations and do not dereference null or out-of-range output", async () => {
  const f = await fixture(), before = f.memory.bytes.slice();
  f.files.set("fonts/fontImage_14.dat", new Uint8Array(20547));
  for (const [size, destination] of [[13, 0], [14, 65535], [15, 1024]] satisfies readonly (readonly [number, number])[]) {
    expect(await qvmFontSyscall("cgame", words(59, size, destination, 65535), f.memory, f.services)).toBe(0);
  }
  expect(f.memory.bytes).toEqual(before); expect(f.reads).toEqual([]); expect(f.clears).toHaveLength(3);
  expect(f.printed).toEqual(Array.from({ length: 3 }, () => "RE_RegisterFont: FreeType code not available\n"));
});

test("six shared slots gate cached copies before touching the output pointer", async () => {
  const f = await fixture();
  for (let size = 12; size < 18; size++) f.files.set(`fonts/fontImage_${size}.dat`, fixtureBytes());
  const pending: (number | Promise<number> | null)[] = [];
  for (let size = 12; size < 18; size++) pending.push(qvmFontSyscall("ui", words(55, size), f.memory, f.services));
  pending.push(qvmFontSyscall("cgame", words(59, 12, 0), f.memory, f.services));
  expect(await Promise.all(pending)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  expect(f.reads.filter(path => path.startsWith("fonts/"))).toHaveLength(6);
  expect(f.printed.at(-1)).toBe("RE_RegisterFont: Too many fonts registered already.\n");
  expect(f.clears).toHaveLength(1);
});

test("scalar arguments are captured before asynchronous reads can overwrite live syscall words", async () => {
  const f = await fixture(), call = words(59, 12, 1024);
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>();
  f.observers.push(async path => {
    if (path !== "fonts/fontImage_12.dat") return;
    entered.resolve(undefined); await release.promise;
  });
  const pending = qvmFontSyscall("cgame", call, f.memory, f.services);
  await entered.promise;
  call.setInt32(0, 55, true); call.setInt32(8, 999, true); call.setInt32(12, 32768, true);
  release.resolve(undefined);
  expect(await pending).toBe(0);
  expect(f.memory.readString(1024 + 20484)).toBe("fonts/fontImage_12.dat");
  expect(f.memory.span(32768, 20548)).toEqual(new Uint8Array(20548).fill(0x77));
  expect(f.clears).toHaveLength(1);
});

test("fresh registration publishes DAT fields before shader callbacks and retains patches on failure", async () => {
  const f = await fixture(), initial = fixtureBytes(), snapshots: Uint8Array[] = [];
  f.observers.push((path): undefined => {
    if (path === "first.tga" || path === "second.tga") snapshots.push(f.memory.span(1024, 20548).slice());
    if (path === "second.tga") throw new Error("authored atlas read failure");
  });
  await expect(Promise.resolve(qvmFontSyscall("cgame", words(59), f.memory, f.services))).rejects.toThrow("authored atlas read failure");
  initial.fill(0, 20484); initial.set(new TextEncoder().encode("fonts/fontImage_12.dat"), 20484);
  expect(snapshots[0]).toEqual(initial);
  const first = f.resources.shaderHandle(await f.resources.registerShaderNoMip("first.tga"));
  new DataView(initial.buffer).setInt32(44, first, true);
  expect(snapshots[1]).toEqual(initial); expect(f.memory.span(1024, 20548)).toEqual(initial);
  expect(f.clears).toEqual([]);
  f.observers.length = 0;
  const retry = fixtureBytes(); retry.fill(0, 80 + 48, 80 + 80);
  f.files.set("fonts/fontImage_12.dat", retry);
  expect(await qvmFontSyscall("ui", words(55), f.memory, f.services)).toBe(0);
  expect(f.reads.filter(path => path === "fonts/fontImage_12.dat")).toHaveLength(2);
});

test("reached callback mutations of remaining glyph names and metrics survive registration and cache copy", async () => {
  const f = await fixture();
  f.observers.push((path): undefined => {
    if (path !== "first.tga") return;
    f.memory.view(1024, 20548).setInt32(80, 123, true);
    f.memory.span(1024 + 80 + 48, 32).fill(0);
    f.memory.view(1024, 20548).setUint32(255 * 80 + 44, 0xfedcba98, true);
  });
  expect(await qvmFontSyscall("ui", words(55), f.memory, f.services)).toBe(0);
  expect(f.reads).not.toContain("second.tga");
  const font = await f.resources.fonts.registerFont("ignored", 12, text => { f.printed.push(text); });
  expect(font?.glyphs[1]?.height).toBe(123); expect(font?.glyphs[1]?.shaderName).toBe("");
  expect(f.memory.view(1024, 20548).getInt32(80 + 44, true)).toBe(0);
  expect(await qvmFontSyscall("ui", words(55, 12, 32768), f.memory, f.services)).toBe(0);
  expect(f.memory.span(32768, 20548)).toEqual(f.memory.span(1024, 20548));
  expect(f.memory.view(32768, 20548).getUint32(255 * 80 + 44, true)).toBe(0xfedcba98);
});

test("successful copies check complete output bounds, apply start masking and respect backing offsets", async () => {
  const f = await fixture(), before = f.memory.bytes.slice();
  for (const destination of [0, 65536 - 20548 + 1]) {
    await expect(Promise.resolve(qvmFontSyscall("cgame", words(59, 12, destination), f.memory, f.services))).rejects.toThrow(RangeError);
  }
  expect(f.memory.bytes).toEqual(before); expect(f.clears).toEqual([]);
  const backing = new Uint8Array(65536 + 14).fill(0x77), memory = new QvmMemory(backing.subarray(7, 65536 + 7));
  expect(await qvmFontSyscall("ui", words(55, 12, -65536), memory, f.services)).toBe(0);
  expect(memory.readString(20484)).toBe("fonts/fontImage_12.dat");
  expect(backing.subarray(0, 7)).toEqual(new Uint8Array(7).fill(0x77));
  expect(backing[7 + 20548]).toBe(0x77);
  await expect(Promise.resolve(qvmFontSyscall("ui", words(55, 12, 0), memory, f.services))).rejects.toThrow("nonnull");
});

test("admitted DAT preserves nonfinite words and reaches cgame scene fallthrough", async () => {
  const f = await fixture(), before = f.memory.bytes.slice(), malformed = fixtureBytes();
  new DataView(malformed.buffer).setUint32(28, 0x7fc01234, true);
  f.files.set("fonts/fontImage_12.dat", malformed);
  expect(await qvmFontSyscall("cgame", words(59), f.memory, f.services)).toBe(0);
  expect(new DataView(f.memory.bytes.buffer, f.memory.bytes.byteOffset).getUint32(1024 + 28, true)).toBe(0x7fc01234);
  expect(f.memory.readString(1024 + 20484)).toBe("fonts/fontImage_12.dat");
  expect(f.memory.bytes.subarray(0, 1024)).toEqual(before.subarray(0, 1024));
  expect(f.memory.bytes.subarray(1024 + 20548)).toEqual(before.subarray(1024 + 20548));
  expect(f.clears).toEqual([f.reads.length]);
});

test("game and unmatched traps return null without reading arguments or touching services", async () => {
  const f = await fixture();
  expect(qvmFontSyscall("game", new DataView(new ArrayBuffer(0)), f.memory, f.services)).toBeNull();
  for (const role of ["ui", "cgame"] satisfies readonly ("ui" | "cgame")[]) {
    const call = new DataView(new ArrayBuffer(4)); call.setInt32(0, role === "ui" ? 59 : 55, true);
    expect(qvmFontSyscall(role, call, f.memory, f.services)).toBeNull();
  }
  expect(f.reads).toEqual([]); expect(f.lengths).toEqual([]); expect(f.clears).toEqual([]);
});
