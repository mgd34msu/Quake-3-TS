import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
// Scene ABI and shared allocation from id Software cl_cgame.c/cl_ui.c/tr_scene.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, test } from "bun:test";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { CommonError } from "../src/core/common-error.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { createPortalEntity } from "../src/render/ref-entity.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { RendererResources } from "../src/render/world.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { qvmRenderSceneSyscall } from "../src/vm/render-scene-syscalls.ts";
import { qvmRenderWorldSyscall } from "../src/vm/render-world-syscalls.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function words(...args: number[]): DataView {
  const result = new DataView(new ArrayBuffer(args.length * 4));
  for (const [index, value] of args.entries()) result.setInt32(index * 4, value, true);
  return result;
}

async function fixture() {
  const files = new Map<string, Uint8Array>([["scripts/test.shader", new TextEncoder().encode(
    "red { cull none { map $whiteimage rgbGen const ( 1 0 0 ) } }")]]);
  const reader: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
    has: path => files.has(path), list: prefix => [...files.keys()].filter(path => prefix === undefined || path.startsWith(prefix)),
    readFileLength: path => files.get(path)?.byteLength ?? -1, readFileOptional: async path => files.get(path),
    read: async path => { const bytes = files.get(path); if (bytes === undefined) throw new Error(`Missing authored asset ${path}`); return bytes; },
  });
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(32, 32, images), target = new RenderTarget(images, [cpu]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), cvars = new CvarRegistry();
  const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader }, sound: { kind: "diagnostic", readMixer: () => null },
    clock: { sample: () => 0 }, scratchImages: builtins, console: { kind: "absent" },
    settings: { inGameVideo: () => 0, hardware: "generic", maxTextureSize: 4096 } });
  cleanup.push(() => { target.close(); cinematics.dispose(); });
  const printed: string[] = [];
  const resources = await RendererResources.create(reader, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" },
    target, images, builtins, imageProfile: identityImageUploadProfile, shaderCinematics: cinematics.shaderCinematics,
    print: text => { printed.push(text); }, drawDebugSurface: () => { throw new Error("Unexpected debug surface"); },
  });
  const commands = new RenderCommandBuffer(target, { clock: { milliseconds: () => 0 }, identityLight: 1, tess: resources.tess,
    runtime: settings.runtime, print: text => { printed.push(text); } });
  cleanup.push(() => commands.close("discard"));
  const memory = new QvmMemory(new Uint8Array(4096));
  const call = (role: "game" | "cgame" | "ui", ...args: number[]) => qvmRenderSceneSyscall(role, words(...args), memory, resources);
  // Source refdef_t with an identity view basis and zeroed, terminated render text.
  const view = memory.view(1024, 368);
  view.setInt32(8, 32, true); view.setInt32(12, 32, true);
  view.setFloat32(16, 90, true); view.setFloat32(20, 90, true);
  for (const offset of [36, 52, 68]) view.setFloat32(offset, 1, true);
  view.setInt32(76, RDF_NOWORLDMODEL, true);
  function polygon(pointer: number): void {
    const vertices = memory.view(pointer, 72);
    for (const [index, yz] of [[-12, -12], [12, -12], [0, 12]].entries()) {
      const y = yz[0], z = yz[1];
      if (y === undefined || z === undefined) throw new Error("Missing triangle coordinate");
      vertices.setFloat32(index * 24, 32, true);
      vertices.setFloat32(index * 24 + 4, y, true); vertices.setFloat32(index * 24 + 8, z, true);
      vertices.setUint32(index * 24 + 20, 0xffffffff, true);
    }
  }
  printed.length = 0;
  return { resources, commands, memory, cvars, cpu, files, printed, call, polygon };
}

test("VM entities copy into the typed scene's allocation and full capacity precedes pointer reads", async () => {
  const f = await fixture();
  f.memory.view(64, 140).setInt32(0, 7, true);
  expect(f.call("ui", 22, 64)).toBe(0);
  f.memory.view(64, 140).setFloat32(68, 123, true);
  expect(f.resources.sceneEntities.sceneRange().entity(0).entity.origin.x).toBe(0);
  f.resources.addRefEntity(createPortalEntity());
  expect(f.resources.sceneEntities.sceneRange().length).toBe(2);
  expect(f.call("cgame", 40)).toBe(0);
  for (let index = 2; index < 1022; index++) f.resources.addRefEntity(createPortalEntity());
  expect(f.call("cgame", 41, 0)).toBe(0);
  expect(f.call("ui", 22, 4095)).toBe(0);
  f.resources.rolloverFrame();
  expect(() => f.call("cgame", 41, 0)).toThrow("nonnull");
  expect(() => f.call("ui", 22, 4095)).toThrow("exceeds allocation");
  for (const type of [-1, 8]) {
    f.memory.view(4092, 4).setInt32(0, type, true);
    try {
      f.call("cgame", 41, 4092);
      throw new Error("Expected source bad reType drop");
    } catch (error) {
      if (!(error instanceof CommonError)) throw error;
      expect(error.code).toBe("drop");
      expect(error.message).toBe(`RE_AddRefEntityToScene: bad reType ${type}`);
    }
  }
});

test("VM polygon pointers mask once and retain earlier polygons when a later extent fails", async () => {
  const f = await fixture(), shader = f.resources.shaderHandle(await f.resources.registerShader("red"));
  expect(f.call("ui", 23, 0, 3, 0)).toBe(0);
  expect(f.printed).toEqual(["^3WARNING: RE_AddPolyToScene: NULL poly shader\n"]);
  f.polygon(4024);
  expect(() => f.call("cgame", 87, shader, 3, 4096 + 4024, 2)).toThrow("exceed allocation");
  expect(f.call("ui", 25, 1024)).toBe(0);
  f.commands.submitFrame();
  expect([...f.cpu.pixels.subarray((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 4)]).toEqual([255, 0, 0, 255]);
  f.resources.rolloverFrame();
  f.polygon(64);
  expect(f.call("cgame", 87, shader, 3, 64, 0)).toBe(0);
  for (let index = 0; index < 600; index++) f.call("ui", 23, shader, 3, 64);
  expect(f.call("cgame", 87, shader, 3, 0, 2)).toBe(0);
});

test("light capacity and no-refresh return before invalid VM pointers", async () => {
  const f = await fixture(), light = words(43, 0, 0, 0, 0, 0);
  expect(qvmRenderSceneSyscall("cgame", light, f.memory, f.resources)).toBe(0);
  light.setInt32(4, 64, true); light.setFloat32(8, 64, true); light.setFloat32(12, 1, true);
  for (let index = 0; index < 32; index++) qvmRenderSceneSyscall("cgame", light, f.memory, f.resources);
  light.setInt32(0, 85, true); light.setInt32(4, 0, true);
  expect(qvmRenderSceneSyscall("cgame", light, f.memory, f.resources)).toBe(0);
  f.resources.rolloverFrame();
  expect(() => qvmRenderSceneSyscall("cgame", light, f.memory, f.resources)).toThrow("nonnull");
  f.cvars.set("r_norefresh", "1");
  expect(f.call("ui", 25, 0)).toBe(0);
  f.cvars.set("r_norefresh", "0");
  // Only the initial 80 bytes fit. Missing-world drop must precede the complete record read.
  f.memory.view(4016, 80).setInt32(76, 0, true);
  expect(() => f.call("cgame", 44, 4016)).toThrow("NULL worldmodel");
});

test("LightForPoint keeps no-grid outputs untouched and publishes successful vectors in source order", async () => {
  const f = await fixture();
  const base = renderBspFixture([{ shader: "red", lightmap: -1 }, { shader: "red", lightmap: -1 }], []);
  f.files.set("maps/empty.bsp", base);
  await f.resources.loadWorld("empty");
  expect(f.call("cgame", 73, 0, 0, 0, 0)).toBe(0);
  const grid = new Uint8Array(base.byteLength + 48); grid.set(base);
  const header = new DataView(grid.buffer);
  header.setInt32(8 + 15 * 8, base.byteLength, true); header.setInt32(12 + 15 * 8, 48, true);
  for (let index = 0; index < 6; index++) grid.set([10, 20, 30, 40, 50, 60, 0, 0], base.byteLength + index * 8);
  f.files.set("maps/grid.bsp", grid);
  await f.resources.loadWorld("grid");
  f.memory.span(256, 36).fill(0xa5);
  expect(f.call("cgame", 73, 64, 256, 268, 280)).toBe(1);
  const first = f.memory.span(256, 12).slice();
  expect(new DataView(first.buffer).getFloat32(0, true)).toBeGreaterThan(0);
  f.memory.span(256, 12).fill(0xa5);
  expect(() => f.call("cgame", 73, 64, 256, 4090, 280)).toThrow("exceeds allocation");
  expect(f.memory.span(256, 12)).toEqual(first);
});

test("scene dispatch leaves game and unrelated role calls to their owners", async () => {
  const f = await fixture();
  expect(qvmRenderSceneSyscall("game", new DataView(new ArrayBuffer(0)), f.memory, f.resources)).toBeNull();
  for (const trap of [40, 41, 42, 43, 44, 73, 85, 87]) expect(f.call("ui", trap)).toBeNull();
  for (const trap of [21, 22, 23, 24, 25]) expect(f.call("cgame", trap)).toBeNull();
});

test("unused signed entity and refdef flag bits do not suppress actual VM sprite rendering", async () => {
  const f = await fixture(), shader = f.resources.shaderHandle(await f.resources.registerShader("red"));
  const entity = f.memory.view(64, 140);
  entity.setInt32(0, 2, true); entity.setInt32(4, -2147483648 | 1024, true);
  entity.setFloat32(68, 32, true); entity.setInt32(112, shader, true);
  entity.setUint32(116, 0xffffffff, true); entity.setFloat32(132, 16, true);
  f.memory.view(1024, 368).setInt32(76, -2147483648 | RDF_NOWORLDMODEL | 2, true);
  expect(f.call("cgame", 41, 64)).toBe(0);
  expect(f.call("cgame", 44, 1024)).toBe(0);
  f.commands.submitFrame();
  expect([...f.cpu.pixels.subarray((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 4)]).toEqual([255, 0, 0, 255]);
});

test("world VM calls share the renderer entity cursor and restart it only after publishing EOF", async () => {
  const f = await fixture();
  const bytes = renderBspFixture([{ shader: "red", lightmap: -1 }, { shader: "red", lightmap: -1 }], []);
  const collision = new CollisionWorld(parseBsp(bytes), { kind: "unaccounted" }, { kind: "disabled" });
  const call = (...args: number[]) => qvmRenderWorldSyscall("cgame", words(...args), f.memory, f.resources, collision);
  f.memory.span(256, 32).fill(0xa5);
  expect(call(86, 256, 32)).toBe(0);
  expect(f.memory.span(256, 32).every(byte => byte === 0)).toBe(true);
  f.files.set("maps/entity-test.bsp", bytes);
  f.memory.writeString(64, "maps/entity-test.bsp", 64);
  expect(await call(36, 64)).toBe(0);
  expect(f.resources.worldBaseName).toBe("entity-test");
  expect(call(86, 256, 32)).toBe(1);
  expect(f.memory.readString(256)).toBe("{");
  const typedTokens: string[] = [];
  expect(f.resources.getEntityToken(token => { typedTokens.push(token); })).toBe(true);
  expect(typedTokens).toEqual(["classname"]);
  expect(() => call(86, 256, 0)).toThrow("destsize");
  expect(call(86, 256, 32)).toBe(1);
  expect(f.memory.readString(256)).toBe("}");
  const remainder: string[] = [];
  for (let index = 0; index < 8; index++) {
    if (call(86, 256, 32) === 0) break;
    remainder.push(f.memory.readString(256));
  }
  expect(remainder).toEqual(["{", "classname", "info_player_start", "origin", "0 0 -26", "}"]);
  expect(f.memory.readString(256)).toBe("");
  expect(call(86, 256, 32)).toBe(1);
  expect(f.memory.readString(256)).toBe("{");
  f.memory.writeString(64, "maps/missing.bsp", 64);
  await expect(call(36, 64)).rejects.toThrow("not found");
  expect(call(86, 256, 32)).toBe(1);
  expect(f.memory.readString(256)).toBe("classname");
  for (const role of ["game", "ui"] satisfies readonly ("game" | "ui")[])
    expect(qvmRenderWorldSyscall(role, new DataView(new ArrayBuffer(0)), f.memory, f.resources, collision)).toBeNull();
});

test("world VM PVS uses renderer leaf splits and actual collision visibility, with null-world admission first", async () => {
  const f = await fixture();
  const bytes = renderBspFixture([{ shader: "red", lightmap: -1 }, { shader: "red", lightmap: -1 }], []);
  const map = parseBsp(bytes);
  const collision = new CollisionWorld({ ...map, visibility: { clusterCount: 2, bytesPerCluster: 1, bits: new Uint8Array([1, 2]) } },
    { kind: "unaccounted" }, { kind: "disabled" });
  const call = (...args: number[]) => qvmRenderWorldSyscall("cgame", words(...args), f.memory, f.resources, collision);
  expect(() => call(88, 0, 0)).toThrow("R_PointInLeaf: bad model");
  f.files.set("maps/pvs.bsp", bytes);
  await f.resources.loadWorld("pvs");
  expect(() => call(88, 0, 0)).toThrow("nonnull");
  f.memory.view(64, 12).setFloat32(0, 16, true);
  f.memory.view(80, 12).setFloat32(0, 64, true);
  expect(call(88, 64, 80)).toBe(0);
  expect(call(88, 64, 64)).toBe(1);
  f.memory.view(80, 12).setFloat32(0, 48, true);
  expect(call(88, 64, 80)).toBe(1);
  const visited: string[] = [];
  expect(f.resources.inPVS(() => { visited.push("first"); return { x: 16, y: 0, z: 0 }; },
    () => { visited.push("second"); return { x: 64, y: 0, z: 0 }; }, cluster => {
      visited.push(`collision:${cluster}`); return collision.clusterPVS(cluster);
    })).toBe(false);
  expect(visited).toEqual(["first", "collision:0", "second"]);
  const solid = bytes.slice(), header = new DataView(solid.buffer);
  header.setInt32(header.getInt32(8 + 4 * 8, true), -1, true);
  solid.set([0x80, 2], header.getInt32(8 + 16 * 8, true) + 8);
  f.files.set("maps/solid-pvs.bsp", solid);
  await f.resources.loadWorld("solid-pvs");
  const solidCollision = new CollisionWorld(parseBsp(solid), { kind: "unaccounted" }, { kind: "disabled" });
  f.memory.view(80, 12).setFloat32(0, 64, true);
  // The solid leaf's -1 cluster reaches byte -1 relative to row 1, inside CM storage.
  expect(qvmRenderWorldSyscall("cgame", words(88, 80, 64), f.memory, f.resources, solidCollision)).toBe(1);
});
