import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { finishFailedShader, finishImplicitShader, finishShader } from "../src/render/material-finish.ts";
import type { FinishImageMetadata, FinishLoadedImageMetadata, FinishShaderProfile, FinishedShader } from "../src/render/material-finish.ts";
import { inspectShaderScript, parseShaderScript, SourceColorGenerator, SourceTexCoordGenerator } from "../src/render/material.ts";
import type { ShaderDefinition, ShaderScriptInspection } from "../src/render/material.ts";
import type { FinishedStageBinding } from "../src/render/material.ts";
import type { Product } from "../src/shared/definitions.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { publishTexture } from "./render-target-fixture.ts";

function definition(source: string): ShaderDefinition {
  const value = parseShaderScript(source)[0];
  if (value === undefined) throw new Error("Fixture has no shader definition");
  return value;
}

function acceptedDefinitions(inspection: ShaderScriptInspection): readonly ShaderDefinition[] {
  const result: ShaderDefinition[] = [];
  for (const entry of inspection.entries) {
    if (entry.textResult.kind === "accepted") result.push(entry.textResult.definition);
  }
  return result;
}

const profile: FinishShaderProfile = {
  detailTextures: true,
  vertexLight: false,
  uiFullscreen: false,
  hardware: "generic",
  iterator: { ignoreFastPath: false, multitexture: true, textureEnvAdd: true, driver: "generic" },
};

function loaded(count: number, tmu: 0 | 1 = 0): readonly FinishImageMetadata[] {
  const result: FinishImageMetadata[] = [];
  for (let index = 0; index < count; index++) result.push({ kind: "loaded", tmu, binding });
  return result;
}

const pixel = publishTexture(new RendererImageCatalog(), { name: "finish-white", width: 1, height: 1,
  pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 });
const binding: FinishedStageBinding = {
  kind: "images",
  playback: { kind: "single", image: { image: pixel } },
};
const baseImage: FinishLoadedImageMetadata = { kind: "loaded", tmu: 0, binding };

function finish(source: string, changes: Partial<FinishShaderProfile> = {}, lightmapIndex = -1): FinishedShader {
  const shader = definition(source);
  return finishShader({ definition: shader, lightmapIndex, images: loaded(shader.stages.length), profile: { ...profile, ...changes } });
}

describe("FinishShader stage processing", () => {
  test("matches the unchanged native FinishShader trace", () => {
    const detailShader = definition("oracle { { map first } { map removed detail } { map shifted } }");
    const detail = finishShader({ definition: detailShader, lightmapIndex: -1, images: loaded(3),
      profile: { ...profile, detailTextures: false, iterator: { ...profile.iterator, multitexture: false } } });
    const vertex = finish("oracle { { map $lightmap rgbGen identity } { map selected rgbGen identity } }", { vertexLight: true }, 3);
    const blend = finish("oracle { { map first blendFunc blend } { map second blendFunc add depthWrite } }",
      { iterator: { ...profile.iterator, multitexture: false } });
    expect({
      detail: { passes: detail.numUnfoggedPasses, maps: detail.sourceStages.map(stage => stage.stage.map), tcGen: detail.sourceStages[1]?.tcGen },
      vertex: { passes: vertex.numUnfoggedPasses, map: vertex.sourceStages[0]?.stage.map, rgbGen: vertex.sourceStages[0]?.rgbGen,
        alphaGen: vertex.sourceStages[0]?.alphaGen, lightmapIndex: vertex.lightmapIndex },
      blend: { sort: blend.sort, fog: blend.sourceStages.map(stage => stage.fogAdjustment), passes: blend.numUnfoggedPasses },
    }).toEqual({
      detail: { passes: 2, maps: [{ kind: "image", name: "first", clamp: false }, { kind: "image", name: "shifted", clamp: false }], tcGen: SourceTexCoordGenerator.Bad },
      vertex: { passes: 1, map: { kind: "image", name: "selected", clamp: false }, rgbGen: SourceColorGenerator.ExactVertex, alphaGen: "skip", lightmapIndex: -1 },
      blend: { sort: 9, fog: ["alpha", "rgb"], passes: 2 },
    });
  });

  test("applies source sort, tcGen, fog adjustment and fog-pass defaults", () => {
    const opaque = finish("opaque { { map test } }");
    expect(opaque.sort).toBe(3);
    expect(opaque.fogPass).toBe("equal");
    expect(opaque.sourceStages[0]?.tcGen).toBe(SourceTexCoordGenerator.Texture);
    expect(opaque.sourceStages[0]?.stage.tcGen).toEqual({ kind: "texture" });

    const blended = finish("mist { surfaceparm fog { map a blendFunc blend } { map b blendFunc add depthWrite } }");
    expect(blended.sort).toBe(9);
    expect(blended.fogPass).toBe("less-equal");
    expect(blended.sourceStages.map(stage => stage.fogAdjustment)).toEqual(["alpha", "rgb"]);
    const decal = finish("mark { polygonOffset { map test } }");
    expect(decal.sort).toBe(4);
  });

  test("preserves the source detail-stage memmove and clear target", () => {
    const shader = definition("detail-shift { { map first } { map removed detail } { map shifted tcGen vector ( 1 0 0 ) ( 0 1 0 ) } }");
    const result = finishShader({
      definition: shader,
      lightmapIndex: -1,
      images: loaded(3),
      profile: { ...profile, detailTextures: false },
    });
    expect(result.sourceStages.map(stage => stage.stage.map)).toEqual([
      { kind: "image", name: "first", clamp: false },
      { kind: "image", name: "shifted", clamp: false },
    ]);
    expect(result.sourceStages[1]?.tcGen).toBe(SourceTexCoordGenerator.Vector);
    expect(result.numUnfoggedPasses).toBe(2);

    const eight = definition(`last-detail { ${Array.from({ length: 8 }, (_, index) => `{ map image${index}${index === 7 ? " detail" : ""} }`).join(" ")} }`);
    const last = finishShader({ definition: eight, lightmapIndex: -1, images: loaded(8), profile: { ...profile, detailTextures: false, iterator: { ...profile.iterator, multitexture: false } } });
    expect(last.sourceStages).toHaveLength(8);
    expect(last.sourceStages[7]?.tcGen).toBe(SourceTexCoordGenerator.Bad);
  });

  test("FinishShader classifies incomplete raw blend masks without repairing them", () => {
    const incomplete = finish("raw { { map test\nblendFunc GL_ONE\n} }");
    expect(incomplete.sourceStages[0]?.stateBits).toBe(0x102);
    expect(incomplete.iterator.passes[0]?.stateBits).toBe(0x102);
    expect(incomplete.sourceStages[0]?.fogAdjustment).toBe("none");
    expect(incomplete.sort).toBe(5);
    expect(incomplete.fogPass).toBe("none");
    const retained = finish("raw { { map test\nblendFunc add\nblendFunc GL_SRC_ALPHA\n} }");
    expect(retained.sourceStages[0]?.stateBits).toBe(0x25);
    expect(retained.sort).toBe(9);
  });

  test("keeps missing-image holes and source pass count observable", () => {
    const shader = definition("movie-failure { { videoMap missing.roq } { map later } }");
    const result = finishShader({
      definition: shader,
      lightmapIndex: -1,
      images: [{ kind: "missing" }, { kind: "loaded", tmu: 0, binding }],
      profile: { ...profile, iterator: { ...profile.iterator, multitexture: false } },
    });
    expect(result.sourceStages).toHaveLength(2);
    expect(result.sourceStages[0]).toMatchObject({ active: false, imageTMU: null });
    expect(result.numUnfoggedPasses).toBe(2);
    expect(result.diagnostics).toEqual([{ kind: "missing-image", stage: 0, message: "Shader movie-failure has a stage with no image" }]);
  });

  test("collapses vertex lighting with source ranking and clears a positive lightmap", () => {
    const result = finish("vertex { { map $lightmap rgbGen identity } { map diffuse rgbGen identity } }", { vertexLight: true }, 3);
    expect(result.sourceStages).toHaveLength(1);
    expect(result.sourceStages[0]?.stage.map).toEqual({ kind: "image", name: "diffuse", clamp: false });
    expect(result.sourceStages[0]?.stage.rgbGen).toEqual({ kind: "exactvertex" });
    expect(result.sourceStages[0]?.alphaGen).toBe("skip");
    expect(result.sourceStages[0]?.stateBits).toBe(0x100);
    expect(result.lightmapIndex).toBe(-1);
    expect(result.hasLightmapStage).toBe(false);
    expect(result.diagnostics[0]?.kind).toBe("lightmap-cleared");
    const flags = finish(`flags { sort 3
      { map $lightmap rgbGen identity alphaFunc GT0 depthFunc equal blendFunc GL_ONE
      }
      { map diffuse rgbGen identity }
    }`, { vertexLight: true }, 3);
    expect(flags.sourceStages[0]?.stage.map).toEqual({ kind: "image", name: "diffuse", clamp: false });
    expect(flags.sourceStages[0]?.stateBits).toBe(0x10020100);
    expect(flags.iterator.passes[0]?.stateBits).toBe(0x10020100);
  });

  test("honors the UI vertex-light guard and Permedia2 override", () => {
    const shader = definition("guard { { map first } { map second blendFunc add } }");
    const iterator = { ...profile.iterator, multitexture: false };
    const ui = finishShader({ definition: shader, lightmapIndex: -1, images: loaded(2),
      profile: { ...profile, vertexLight: true, uiFullscreen: true, iterator } });
    expect(ui.numUnfoggedPasses).toBe(2);
    const permedia = finishShader({ definition: shader, lightmapIndex: -1, images: loaded(2),
      profile: { ...profile, vertexLight: false, uiFullscreen: true, hardware: "permedia2", iterator } });
    expect(permedia.numUnfoggedPasses).toBe(1);
    expect(permedia.sourceStages[0]?.stage.rgbGen).toEqual({ kind: "lightingdiffuse" });
    expect(permedia.sourceStages[0]?.alphaGen).toBe("skip");
  });

  test("uses the source translucent vertex-light collapse and zero-pass fog sort", () => {
    const translucent = finish(`crossfade { sort 9
      { map $lightmap rgbGen wave sawtooth 0 1 0 1 }
      { map visible rgbGen wave inversesawtooth 0 1 0 1 blendFunc add }
    }`, { vertexLight: true, iterator: { ...profile.iterator, multitexture: false } }, 2);
    expect(translucent.sourceStages).toHaveLength(1);
    expect(translucent.sourceStages[0]?.stage.map).toEqual({ kind: "image", name: "visible", clamp: false });
    expect(translucent.sourceStages[0]?.stage.rgbGen.kind).toBe("wave");
    expect(translucent.sourceStages[0]?.rgbGen).toBe(SourceColorGenerator.Waveform);
    expect(translucent.sourceStages[0]?.stateBits).toBe(0x22);

    const opposing = finish(`opposing { sort 9
      { map first rgbGen wave sawtooth 0 1 0 1 }
      { map second rgbGen wave inversesawtooth 0 1 0 1 blendFunc add }
    }`, { vertexLight: true, iterator: { ...profile.iterator, multitexture: false } });
    expect(opposing.sourceStages[0]?.stage.rgbGen).toEqual({ kind: "identitylighting" });
    expect(opposing.sourceStages[0]?.rgbGen).toBe(SourceColorGenerator.IdentityLighting);

    const fog = finish("fog-only { surfaceparm fog }");
    expect(fog).toMatchObject({ sort: 7, fogPass: "less-equal", numUnfoggedPasses: 0, sourceStages: [] });
    const sky = finish("sky { skyparms env/sky 512 - { map cloud } }");
    expect(sky.sort).toBe(2);
    expect(sky.iterator.kind).toBe("sky");
  });

  test("retains shader-wide portal range and raw overwritten waves for the enum collision", () => {
    const same = finish(`portal-collapse {
      { map a rgbGen identity alphaGen wave square 1 2 3 4 alphaGen portal 10 }
      { map b blendFunc filter rgbGen identity alphaGen wave square 1 2 3 4 alphaGen portal 99 }
    }`);
    expect(same.iterator.multitextureEnv).toBe("modulate");
    expect(same.numUnfoggedPasses).toBe(1);
    expect(same.iterator.passes[0]?.stage.alphaGen).toEqual({ kind: "portal", range: 99 });

    const different = finish(`portal-separate {
      { map a rgbGen identity alphaGen wave square 1 2 3 4 alphaGen portal 10 }
      { map b blendFunc filter rgbGen identity alphaGen wave square 1 2 3 5 alphaGen portal 99 }
    }`);
    expect(different.iterator.multitextureEnv).toBe("none");
    expect(different.numUnfoggedPasses).toBe(2);
    expect(different.sourceStages.map(stage => stage.stage.alphaGen)).toEqual([
      { kind: "portal", range: 99 },
      { kind: "portal", range: 99 },
    ]);
  });

  test("validates complete image metadata and source lightmap integer bounds", () => {
    const shader = definition("bad-input { { map test } }");
    expect(() => finishShader({ definition: shader, lightmapIndex: -1, images: [], profile })).toThrow("exactly one image");
    expect(() => finishShader({ definition: shader, lightmapIndex: 1.5, images: loaded(1), profile })).toThrow("lightmapIndex");
    expect(() => finishShader({ definition: shader, lightmapIndex: -5, images: loaded(1), profile })).toThrow("lightmapIndex");
  });

  test("finishes named missing-image shader records without fabricating a stage", () => {
    const lightmapped = finishFailedShader({ name: "textures/missing", lightmapIndex: 7, profile });
    expect(lightmapped).toMatchObject({ sort: 7, lightmapIndex: -1, numUnfoggedPasses: 0, sourceStages: [], fogPass: "none" });
    expect(lightmapped.diagnostics).toEqual([{ kind: "lightmap-cleared", stage: null, message: "Shader textures/missing has lightmap but no lightmap stage" }]);
    const picture = finishFailedShader({ name: "textures/missing", lightmapIndex: -4, profile });
    expect(picture).toMatchObject({ sort: 7, lightmapIndex: -4, numUnfoggedPasses: 0, sourceStages: [], diagnostics: [] });
  });

  test("constructs internal and all five implicit R_FindShader layouts with owned bindings", () => {
    const defaultShader = finishImplicitShader({ kind: "default", name: "<default>", baseImage, profile });
    expect(defaultShader.iterator.kind).toBe("generic");
    expect(defaultShader.iterator.passes[0]?.rgbGen).toBe(SourceColorGenerator.Bad);
    expect(defaultShader.iterator.passes[0]?.stage.rgbGen).toEqual({ kind: "identitylighting" });
    expect(defaultShader.iterator.passes[0]?.stateBits).toBe(0x100);
    const shadow = finishImplicitShader({ kind: "stencil-shadow", name: "<stencil shadow>", baseImage, profile });
    expect(shadow).toMatchObject({ sort: 14, fogPass: "none", numUnfoggedPasses: 1 });
    expect(shadow.iterator.passes[0]?.stateBits).toBe(0x100);

    const dynamic = finishImplicitShader({ kind: "dynamic", name: "textures/raw", baseImage, profile });
    expect(dynamic.iterator.kind).toBe("vertex-lit");
    expect(dynamic.iterator.passes[0]?.bundles[0].binding).toBe(binding);
    expect(dynamic.iterator.passes[0]?.stateBits).toBe(0x100);

    const vertex = finishImplicitShader({ kind: "vertex", name: "textures/raw", baseImage, profile });
    expect(vertex.iterator.passes[0]?.stage.rgbGen).toEqual({ kind: "exactvertex" });
    expect(vertex.iterator.passes[0]?.alphaGen).toBe("skip");
    expect(vertex.iterator.passes[0]?.stateBits).toBe(0x100);

    const picture = finishImplicitShader({ kind: "picture", name: "textures/raw", baseImage, profile });
    expect(picture.sort).toBe(9);
    expect(picture.iterator.passes[0]?.stateBits).toBe(0x10065);
    expect(picture.iterator.passes[0]?.stage).toMatchObject({
      blend: { source: "src-alpha", destination: "one-minus-src-alpha" },
      depthFunc: "always",
      depthWrite: false,
    });

    const whiteBinding: FinishedStageBinding = {
      kind: "images",
      playback: { kind: "single", image: { image: publishTexture(new RendererImageCatalog(), { name: "implicit-white", width: 1, height: 1,
        pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 1 }) } },
    };
    const whiteImage: FinishLoadedImageMetadata = { kind: "loaded", tmu: 1, binding: whiteBinding };
    const white = finishImplicitShader({ kind: "white", name: "textures/raw", baseImage, whiteImage, profile });
    expect(white.numUnfoggedPasses).toBe(2);
    expect(white.iterator.passes.map(pass => pass.bundles[0].binding)).toEqual([whiteBinding, binding]);
    expect(white.sourceStages.map(stage => stage.stateBits)).toEqual([0x100, 0x13]);

    const lightmapBinding: FinishedStageBinding = {
      kind: "images",
      playback: { kind: "single", image: { image: publishTexture(new RendererImageCatalog(), { name: "implicit-lightmap", width: 1, height: 1,
        pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgba8", sampling: { wrap: "clamp", filter: "linear" }, registrationUnit: 1 }) } },
    };
    const lightmapImage: FinishLoadedImageMetadata = { kind: "loaded", tmu: 1, binding: lightmapBinding };
    const lightmapped = finishImplicitShader({ kind: "lightmap", name: "textures/raw", baseImage, lightmapImage, lightmapIndex: 2, profile });
    expect(lightmapped.iterator.kind).toBe("lightmapped-multitexture");
    expect(lightmapped.iterator.passes[0]?.bundles.map(bundle => bundle.binding)).toEqual([binding, lightmapBinding]);
    expect(lightmapped.sourceStages.map(stage => stage.stateBits)).toEqual([0x100, 0x13]);
    expect(lightmapped.iterator.passes[0]?.stateBits).toBe(0x100);
    expect(() => finishImplicitShader({ kind: "lightmap", name: "bad", baseImage, lightmapImage, lightmapIndex: -1, profile })).toThrow("non-negative int32");
  });

  test("preserves each animation frame's registered sampling through stage copy and collapse", () => {
    const imageCatalog = new RendererImageCatalog();
    const red = publishTexture(imageCatalog, { name: "animation-red", width: 1, height: 1,
      pixels: new Uint8Array([255, 0, 0, 255]), internalFormat: "rgba8", sampling: { wrap: "clamp", filter: "linear" }, registrationUnit: 0 });
    const green = publishTexture(imageCatalog, { name: "animation-green", width: 1, height: 1,
      pixels: new Uint8Array([0, 255, 0, 255]), internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
    const animation: FinishedStageBinding = {
      kind: "images",
      playback: { kind: "animation", frequency: 2, frames: [
          { image: red },
          { image: green },
        ] },
    };
    const lightmap: FinishedStageBinding = {
      kind: "images",
      playback: { kind: "single", image: { image: publishTexture(imageCatalog, { name: "animation-lightmap", width: 1, height: 1,
        pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgba8", sampling: { wrap: "clamp", filter: "linear" }, registrationUnit: 1 }) } },
    };
    const shader = definition(`animated {
      {
        animMap 2 red green
        rgbGen identity
      }
      { map $lightmap blendFunc filter rgbGen identity }
    }`);
    const result = finishShader({
      definition: shader,
      lightmapIndex: 2,
      images: [
        { kind: "loaded", tmu: 0, binding: animation },
        { kind: "loaded", tmu: 1, binding: lightmap },
      ],
      profile,
    });
    expect(result.iterator.kind).toBe("lightmapped-multitexture");
    expect(result.iterator.passes).toHaveLength(1);
    expect(result.iterator.multitextureEnv).toBe("modulate");
    expect(result.iterator.passes[0]?.bundles[0].binding).toBe(animation);
    const finishedBinding = result.iterator.passes[0]?.bundles[0].binding;
    if (finishedBinding === undefined || finishedBinding === null || finishedBinding.kind !== "images" || finishedBinding.playback.kind !== "animation") {
      throw new Error("Expected the finished animation binding");
    }
    expect(finishedBinding.playback.frames[0].image).toBe(red);
    expect(finishedBinding.playback.frames[1]?.image).toBe(green);
    expect(result.iterator.passes[0]?.bundles[0].binding).toEqual({
      kind: "images",
      playback: { kind: "animation", frequency: 2, frames: [
          { image: red },
          { image: green },
        ] },
    });
  });
});

const dataPath = Bun.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  test.skipIf(!existsSync(join(dataPath, product, "pak0.pk3")))(`finishes every accepted merged retail ${product} shader with VFS image results`, async () => {
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    const hasRetailImage = (name: string): boolean => {
      try { return vfs.has(name); }
      catch (error: unknown) {
        if (error instanceof RangeError) return false;
        throw error;
      }
    };
    let finished = 0;
    for (const scriptPath of vfs.list("scripts").filter(path => path.endsWith(".shader"))) {
      const shaders = acceptedDefinitions(inspectShaderScript(new TextDecoder().decode(await vfs.read(scriptPath)), scriptPath));
      for (const shader of shaders) {
        const images: FinishImageMetadata[] = [];
        for (const stage of shader.stages) {
          switch (stage.map.kind) {
            case "video": case "none": images.push({ kind: "missing" }); break;
            case "whiteimage": case "lightmap": images.push({ kind: "loaded", tmu: 0, binding }); break;
            case "animation": case "image": {
              const names = stage.map.kind === "animation" ? stage.map.frames : [stage.map.name];
              const present = names.every(name => {
                const bare = name.replace(/\.(tga|jpg|jpeg)$/i, "");
                return hasRetailImage(name) || hasRetailImage(`${bare}.tga`) || hasRetailImage(`${bare}.jpg`);
              });
              images.push(present ? { kind: "loaded", tmu: 0, binding } : { kind: "missing" });
              break;
            }
          }
        }
        const result = finishShader({ definition: shader, lightmapIndex: -1, images, profile });
        expect(result.numUnfoggedPasses).toBeLessThanOrEqual(8);
        expect(result.iterator.passes.length).toBe(result.numUnfoggedPasses);
        finished++;
      }
    }
    expect(finished).toBeGreaterThan(1300);
  });
}
