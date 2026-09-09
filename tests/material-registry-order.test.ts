import { expect, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import { finishFailedShader, finishImplicitShader, finishShader } from "../src/render/material-finish.ts";
import type { FinishLoadedImageMetadata } from "../src/render/material-finish.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import type { MaterialContent, MaterialLighting } from "../src/render/material-registry.ts";
import { createRendererSettings } from "./renderer-settings-fixture.ts";
import { parseShaderScript } from "../src/render/material.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { publishTexture } from "./render-target-fixture.ts";

function content(name: string, lighting: MaterialLighting, defaulted = false): MaterialContent {
  const image = publishTexture(new RendererImageCatalog(), { name, width: 1, height: 1,
    pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 });
  const profile = createRendererSettings().registrationProfile();
  const baseImage: FinishLoadedImageMetadata = { kind: "loaded", tmu: 0,
    binding: { kind: "images", playback: { kind: "single", image: { image } } } };
  const lightmapIndex = lighting.kind === "lightmap" ? lighting.index : lighting.kind === "none" ? -1
    : lighting.kind === "white" ? -2 : lighting.kind === "vertex" ? -3 : -4;
  const fields = { name, baseImage, profile };
  const finished = defaulted ? finishFailedShader({ name, lightmapIndex, profile })
    : lighting.kind === "lightmap" ? finishImplicitShader({ ...fields, kind: "lightmap", lightmapIndex, lightmapImage: baseImage })
      : lighting.kind === "white" ? finishImplicitShader({ ...fields, kind: "white", whiteImage: baseImage })
        : finishImplicitShader({ ...fields, kind: lighting.kind === "none" ? "dynamic" : lighting.kind });
  return { definition: null, image, whiteImage: image, defaulted, finished, sky: null };
}

test("different material names prepare in registration order, not async completion order", async () => {
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const calls: string[] = [];
  const registry = new MaterialRegistry(async (name, lighting) => {
    calls.push(`start ${name}`);
    if (name === "first") { entered.resolve(); await gate.promise; }
    calls.push(`end ${name}`);
    return content(name, lighting);
  }, text => { throw new Error(text); });
  const first = registry.register("first", { kind: "none" });
  const second = registry.register("second", { kind: "none" });
  await entered.promise;
  const whileBlocked = [...calls];
  gate.resolve();
  const records = await Promise.all([first, second]);
  expect(whileBlocked).toEqual(["start first"]);
  expect(calls).toEqual(["start first", "end first", "start second", "end second"]);
  expect(records.map(record => record.order)).toEqual([0, 1]);
});

test("queued lighting variants reuse an earlier named failure without replay or order allocation", async () => {
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const calls: string[] = [];
  const registry = new MaterialRegistry(async (name, lighting) => {
    calls.push(`${name}:${lighting.kind}`);
    if (name === "broken" && lighting.kind === "none") { entered.resolve(); await gate.promise; }
    return content(name, lighting, name === "broken");
  }, text => { throw new Error(text); });
  const first = registry.register("broken", { kind: "none" });
  const repeated = registry.register("broken.tga", { kind: "none" });
  const otherLighting = registry.register("BROKEN.jpg", { kind: "picture" });
  const later = registry.register("later", { kind: "picture" });
  await entered.promise;
  gate.resolve();
  const [record, repeatedRecord, otherRecord, laterRecord] = await Promise.all([first, repeated, otherLighting, later]);
  expect(repeatedRecord).toBe(record);
  expect(otherRecord).toBe(record);
  expect(laterRecord?.order).toBe(1);
  expect(calls).toEqual(["broken:none", "later:picture"]);
});

test("a rejected preparation does not poison later requests or reserve a shader order", async () => {
  const calls: string[] = [];
  let attempts = 0;
  const registry = new MaterialRegistry(async (name, lighting) => {
    calls.push(name);
    if (name === "retry" && attempts++ === 0) throw new Error("fixture read failure");
    return content(name, lighting);
  }, text => { throw new Error(text); });
  const failed = registry.register("retry", { kind: "none" });
  const later = registry.register("later", { kind: "none" });
  await expect(failed).rejects.toThrow("fixture read failure");
  expect((await later).order).toBe(0);
  expect((await registry.register("retry", { kind: "none" })).order).toBe(1);
  expect(calls).toEqual(["retry", "later", "retry"]);
});

test("independent material registries do not share their preparation queue", async () => {
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const blocked = new MaterialRegistry(async (name, lighting) => { entered.resolve(); await gate.promise; return content(name, lighting); }, text => { throw new Error(text); });
  const independent = new MaterialRegistry(async (name, lighting) => content(name, lighting), text => { throw new Error(text); });
  const first = blocked.register("first", { kind: "none" });
  await entered.promise;
  const other = await independent.register("other", { kind: "none" });
  gate.resolve();
  expect(other.order).toBe(0);
  expect((await first).order).toBe(0);
});

test("queued requests recheck the finished lightmap key instead of sharing an in-flight result", async () => {
  const definition = parseShaderScript("explicit { { map $whiteimage } }")[0];
  if (definition === undefined) throw new Error("Missing explicit fixture shader");
  const owner = parseBsp(renderBspFixture([{ shader: "explicit", lightmap: 0 }, { shader: "explicit", lightmap: 0 }], [[63, 63, 63]]));
  const image = publishTexture(new RendererImageCatalog(), { name: "lightmap", width: 1, height: 1,
    pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 1 });
  const lighting: MaterialLighting = { kind: "lightmap", owner, index: 0, image };
  let calls = 0;
  const registry = new MaterialRegistry(async (name, input) => {
    calls++;
    const finished = finishShader({ definition, lightmapIndex: 0, profile: createRendererSettings().registrationProfile(),
      images: [{ kind: "loaded", tmu: 0, binding: { kind: "images", playback: { kind: "single",
        image: { image } } } }] });
    return { ...content(name, input), definition, finished };
  }, text => { throw new Error(text); });
  const [first, second] = await Promise.all([registry.register("explicit", lighting), registry.register("explicit", lighting)]);
  expect(calls).toBe(2);
  expect(first).not.toBe(second);
  expect(first?.lighting.kind).toBe("none");
  expect(second?.order).toBe(1);
  expect(await registry.register("explicit", { kind: "none" })).toBe(second);
  expect(calls).toBe(2);
});
