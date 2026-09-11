// Legacy hardware branches from id Software renderer/tr_scene.c, tr_shader.c and tr_image.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { CvarRegistry } from "../src/core/cvar.ts";
import type { Vec3 } from "../src/core/math.ts";
import { SourceBackendMemory } from "../src/render/backend-memory.ts";
import { emptyRendererConfiguration, printRendererGfxInfo } from "../src/render/configuration.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { finishShader } from "../src/render/material-finish.ts";
import type { FinishImageMetadata } from "../src/render/material-finish.ts";
import { parseShaderScript, SourceColorGenerator } from "../src/render/material.ts";
import type { DynamicLight } from "../src/render/lighting.ts";
import type { RefPolyVertex } from "../src/render/ref-entity.ts";
import { SourceSceneEntities } from "../src/render/scene-entities.ts";
import { SourceSceneSubmission } from "../src/render/scene-submission.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import type { SourceRendererDriver, SourceRendererHardware } from "../src/render/settings.ts";
import { publishTexture } from "./render-target-fixture.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { RendererResources } from "../src/render/world.ts";
import { QVM_GL_CONFIG_BYTES, writeQvmGlConfig } from "../src/vm/client-record.ts";

function settings(hardware: SourceRendererHardware = "generic", driver: SourceRendererDriver = "icd") {
  const cvars = new CvarRegistry(), printed: string[] = [];
  cvars.set("r_hardwareProfile", hardware); cvars.set("r_driverProfile", driver);
  const registered = new RegisteredRendererCvars(cvars, "linux", null, text => { printed.push(text); });
  return { cvars, printed, value: new SourceRendererSettings(registered, { textureUnits: 2, textureEnvAdd: true }) };
}

function scene(hardware: SourceRendererHardware, maxPolyVertices = 8) {
  const limits = { maxPolys: 4, maxPolyVertices }, backend = SourceBackendMemory.local(limits);
  const entities = new SourceSceneEntities(backend);
  const value = new SourceSceneSubmission(entities, limits, {
    fogBounds: () => [], developerEnabled: () => false, print: () => undefined,
  }, { kind: "source", backend, shaderHandle: () => 1 }, hardware);
  return { value, backend };
}

function vertex(color = 17): RefPolyVertex {
  return { position: { x: 1, y: 2, z: 3 }, texCoord: { x: .25, y: .75 },
    color: { x: color, y: color + 1, z: color + 2, w: color + 3 } };
}

function light(): DynamicLight {
  return { origin: { x: 1, y: 2, z: 3 }, color: { x: 1, y: .5, z: .25 }, radius: 64, additive: true };
}

describe("explicit legacy renderer profiles", () => {
  test("selected RagePro reaches RendererResources and the actual CPU vertex colors", async () => {
    const hardwareProfiles: readonly SourceRendererHardware[] = ["generic", "ragepro"];
    const maximumGreen: number[] = [];
    for (const hardware of hardwareProfiles) {
      const script = new TextEncoder().encode("legacy { cull none { map $whiteimage rgbGen exactVertex } }");
      const files = new Map([["scripts/legacy.shader", script]]);
      const assets = withRetainedFiles({ has: (path: string) => files.has(path),
        list: (prefix?: string) => [...files.keys()].filter(path => prefix === undefined || path.startsWith(prefix)),
        read: async (path: string) => { const bytes = files.get(path); if (bytes === undefined) throw new Error(`Missing ${path}`); return bytes; },
        readFileOptional: async (path: string) => files.get(path), readFileLength: (path: string) => files.get(path)?.length ?? -1 });
      const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(32, 24, images);
      const target = new RenderTarget(images, [cpu]), builtins = new BuiltinImages(images, identityImageUploadProfile);
      const selected = settings(hardware).value;
      let commands: RenderCommandBuffer | null = null;
      try {
        const resources = await RendererResources.create(assets, { kind: "unaccounted" }, selected, {
          patchMemory: { kind: "diagnostic" }, images, builtins, target, imageProfile: identityImageUploadProfile,
          print: () => undefined, drawDebugSurface: () => undefined,
          shaderCinematics: { playShaderCinematic: async () => { throw new Error("Authored scene has no cinematic"); } },
        });
        commands = new RenderCommandBuffer(target, { clock: { milliseconds: () => 0 }, identityLight: 1,
          tess: resources.tess, runtime: selected.runtime, print: () => undefined });
        const shader = await resources.registerShader("legacy");
        if (shader === null) throw new Error("Authored shader did not register");
        const vertices: RefPolyVertex[] = [{ y: -8, z: -8 }, { y: 8, z: -8 }, { y: 0, z: 8 }].map(position => ({
          position: { x: 32, ...position }, texCoord: { x: 0, y: 0 }, color: { x: 255, y: 0, z: 0, w: 255 },
        }));
        resources.addPoly({ shader, vertices });
        resources.renderScene({ ...cameraRefdef({ origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 32, 24),
          renderFlags: RDF_NOWORLDMODEL });
        const submitted = commands.submitFrame();
        if (submitted === null) throw new Error("Authored scene did not submit");
        expect(submitted.views).toBe(1);
        maximumGreen.push(Math.max(...cpu.pixels.filter((_, index) => index % 4 === 1)));
        expect(cpu.pixels.some((value, index) => index % 4 === 0 && value > 0)).toBe(true);
      } finally { commands?.close("discard"); target.close(); }
    }
    expect(maximumGreen[0]).toBe(0);
    expect(maximumGreen[1]).toBeGreaterThan(100);
  });

  test("RagePro changes only each polygon's first copied vertex", () => {
    const input = [vertex(), vertex(33), vertex(49)];
    const first = input[0];
    if (first === undefined) throw new Error("Missing authored first vertex");
    const { value, backend } = scene("ragepro");
    value.addPolysByHandle(1, 3, 2, () => input);
    const polys = value.captureScene().polys;
    expect(polys).toHaveLength(2);
    for (const poly of polys) {
      expect(poly.vertices[0]).toEqual({ ...first, color: { x: 255, y: 255, z: 255, w: 255 } });
      expect(poly.vertices.slice(1)).toEqual(input.slice(1));
    }
    expect(backend.polyVertexData(0).getUint32(20, true)).toBe(0xffffffff);
    expect(backend.polyVertexData(3).getUint32(20, true)).toBe(0xffffffff);
    expect(input[0]?.color).toEqual({ x: 17, y: 18, z: 19, w: 20 });
  });

  test("zero-count RagePro polygons still write the retained first-vertex bytes", () => {
    const { value, backend } = scene("ragepro");
    backend.polyVertexData(0).setFloat32(0, 72, true);
    value.addPolysByHandle(1, 0, 1, () => []);
    expect(value.captureScene().polys[0]?.vertices).toEqual([]);
    expect(backend.polyVertexData(0).getFloat32(0, true)).toBe(72);
    expect(backend.polyVertexData(0).getUint32(20, true)).toBe(0xffffffff);
    value.addPolysByHandle(1, 1, 1, () => [vertex()]);
    expect(backend.polyVertexData(0).getFloat32(0, true)).toBe(1);
    expect(value.captureScene().polys).toHaveLength(2);
  });

  test("RagePro rejects an out-of-allocation zero-count write before publishing counters", () => {
    const { value, backend } = scene("ragepro", 1);
    value.addPolysByHandle(1, 1, 1, () => [vertex()]);
    expect(() => value.addPolysByHandle(2, 0, 1, () => [])).toThrow("outside its allocation");
    expect(backend.polyData(1).getInt32(4, true)).toBe(2);
    expect(value.captureScene().polys).toHaveLength(1);
  });

  test("other hardware preserves poly color and supports source light rules", () => {
    const profiles: readonly SourceRendererHardware[] = ["generic", "3dfx2d3d", "riva128", "permedia2"];
    for (const hardware of profiles) {
      const { value } = scene(hardware), input = vertex();
      value.addPolysByHandle(1, 1, 1, () => [input]); value.addLight(light());
      expect(value.captureScene().polys[0]?.vertices[0]).toEqual(input);
      expect(value.captureScene().dynamicLights).toHaveLength(hardware === "riva128" || hardware === "permedia2" ? 0 : 1);
    }
    const rage = scene("ragepro").value; rage.addLight(light());
    expect(rage.captureScene().dynamicLights).toHaveLength(1);
  });

  test("Riva128 and Permedia2 reject both light entrypoints after radius and before source reads", () => {
    const profiles: readonly SourceRendererHardware[] = ["riva128", "permedia2"];
    for (const hardware of profiles) {
      const { value } = scene(hardware); let radiusReads = 0;
      const unreadable = (): Vec3 => { throw new Error("Rejected light was read"); };
      value.addLight({ get radius() { radiusReads++; return 64; }, get origin() { return unreadable(); },
        get color() { return unreadable(); }, get additive(): boolean { throw new Error("Rejected additive was read"); } });
      value.addLightRecord(64, { x: 1, y: 1, z: 1 }, true, unreadable);
      expect(radiusReads).toBe(1); expect(value.captureScene().dynamicLights).toEqual([]);
    }
  });

  test("profile cvars latch until renderer registration and invalid selection rejects", () => {
    const { cvars, value } = settings();
    cvars.set("r_hardwareProfile", "ragepro"); cvars.set("r_driverProfile", "voodoo");
    expect(value.hardwareType).toBe("generic"); expect(value.driverType).toBe("icd");
    const restarted = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    expect(restarted.hardwareType).toBe("ragepro"); expect(restarted.driverType).toBe("voodoo");
    cvars.set("r_hardwareProfile", "invented", true);
    expect(() => new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true })).toThrow("Unknown r_hardwareProfile");
  });

  test("Permedia2 retains vertex lighting through fullscreen UI and suppresses scene lights", () => {
    const permedia = settings("permedia2"), generic = settings();
    for (const fixture of [permedia, generic]) {
      fixture.cvars.set("r_uifullscreen", "1"); fixture.cvars.set("r_vertexLight", "2", true);
    }
    expect(permedia.value.runtime.vertexLighting).toBe(true);
    expect(permedia.value.runtime.dynamicLights).toBe(false);
    expect(generic.value.runtime.vertexLighting).toBe(false);
    expect(generic.value.runtime.dynamicLights).toBe(true);
    expect(permedia.value.registrationProfile().hardware).toBe("permedia2");
    expect(generic.value.registrationProfile().hardware).toBe("generic");
  });

  test("3dfx refuses only trilinear and preserves requested cvar text", () => {
    const selected = settings("3dfx2d3d"), images = new RendererImageCatalog();
    selected.cvars.set("r_textureMode", "gl_linear_mipmap_linear");
    expect(images.setTextureMode(selected.value.textureMode.value, selected.value.textureModeProfile())).toBe(true);
    expect(images.textureFilter).toBe("linear-mipmap-nearest");
    expect(selected.value.textureMode.value).toBe("gl_linear_mipmap_linear");
    expect(selected.printed).toEqual(["Refusing to set trilinear on a voodoo.\n"]);
    expect(images.setTextureMode("GL_NEAREST_MIPMAP_LINEAR", selected.value.textureModeProfile())).toBe(true);
    expect(images.textureFilter).toBe("nearest-mipmap-linear");
    expect(images.setTextureMode("GL_LINEAR_MIPMAP_LINEAR", settings("ragepro").value.textureModeProfile())).toBe(true);
    expect(images.textureFilter).toBe("linear-mipmap-linear");
    expect(selected.printed).toHaveLength(1);
  });

  test("actual shader finishing selects Permedia2 approximation and Voodoo TMU restriction", () => {
    const definition = parseShaderScript("legacy { { map $lightmap rgbGen identity } { map image blendFunc filter rgbGen identity } }")[0];
    if (definition === undefined) throw new Error("Missing authored shader");
    const images = new RendererImageCatalog(), image = publishTexture(images, { name: "white", width: 1, height: 1,
      pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 });
    const metadata = (tmu: 0 | 1): FinishImageMetadata => ({ kind: "loaded", tmu,
      binding: { kind: "images", playback: { kind: "single", image: { image } } } });
    const finish = (hardware: SourceRendererHardware, driver: SourceRendererDriver, tmu: 0 | 1) => finishShader({
      definition, lightmapIndex: 0, images: [metadata(0), metadata(tmu)], profile: settings(hardware, driver).value.registrationProfile(),
    });
    expect(finish("generic", "icd", 0).numUnfoggedPasses).toBe(1);
    expect(finish("generic", "voodoo", 0).numUnfoggedPasses).toBe(2);
    expect(finish("generic", "voodoo", 1).numUnfoggedPasses).toBe(1);
    const permedia = finish("permedia2", "icd", 0);
    expect(permedia.numUnfoggedPasses).toBe(1);
    expect(permedia.sourceStages[0]?.rgbGen).toBe(SourceColorGenerator.ExactVertex);
  });

  test("gfxinfo reports the selected source hardware workaround", () => {
    const profiles: readonly (readonly [SourceRendererHardware, string])[] = [
      ["generic", ""], ["ragepro", "HACK: ragePro approximations\n"],
      ["riva128", "HACK: riva128 approximations\n"], ["permedia2", "HACK: using vertex lightmap approximation\n"],
    ];
    for (const [hardware, expected] of profiles) {
      const selected = settings(hardware), printed: string[] = [];
      printRendererGfxInfo(selected.cvars, { configuration: () => ({ ...emptyRendererConfiguration("cpu"), hardwareType: hardware }),
        overbrightBits: () => 0, assertCurrent: () => {} }, text => { printed.push(text); });
      expect(printed.filter(line => line.startsWith("HACK:")).join("")).toBe(expected);
    }
  });

  test("QVM glconfig publishes the exact source hardware and driver enum values", () => {
    const hardware: readonly SourceRendererHardware[] = ["generic", "3dfx2d3d", "riva128", "ragepro", "permedia2"];
    const drivers: readonly SourceRendererDriver[] = ["icd", "standalone", "voodoo"];
    for (const [hardwareValue, hardwareType] of hardware.entries()) {
      for (const [driverValue, driverType] of drivers.entries()) {
        const view = new DataView(new ArrayBuffer(QVM_GL_CONFIG_BYTES));
        writeQvmGlConfig(view, { ...emptyRendererConfiguration("gl"), backend: "gl", depthStorage: "driver",
          maxTextureSize: 4096, hardwareType, driverType });
        expect(view.getInt32(11284, true)).toBe(driverValue);
        expect(view.getInt32(11288, true)).toBe(hardwareValue);
      }
    }
    const view = new DataView(new ArrayBuffer(QVM_GL_CONFIG_BYTES));
    writeQvmGlConfig(view, { ...emptyRendererConfiguration("cpu"), backend: "cpu", depthStorage: "binary64",
      maxTextureSize: null, hardwareType: "ragepro", driverType: "voodoo" });
    expect(view.getInt32(11264, true)).toBe(0x7fffffff);
    expect(view.getInt32(11284, true)).toBe(2);
    expect(view.getInt32(11288, true)).toBe(3);
  });
});
