// Source cases from id Software renderer/tr_image.c. GPL-2.0-or-later.
import { expect, test } from "bun:test";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { finishImplicitShader } from "../src/render/material-finish.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import { SceneModelRegistry } from "../src/render/scene-models.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

async function fixture(text = "Body,model/body\n", sync: () => void = () => undefined) {
  const events: string[] = [];
  const images = new RendererImageCatalog(), builtins = new BuiltinImages(images, identityImageUploadProfile);
  const profile = createRendererSettings().registrationProfile(), image = builtins.defaultImage;
  const materials = new MaterialRegistry(async name => ({ definition: null, image, whiteImage: image,
    defaulted: false, sky: null, finished: finishImplicitShader({ name, profile, kind: "default",
      baseImage: { kind: "loaded", tmu: 0, binding: { kind: "images", playback: { kind: "single", image: { image } } } } }) }),
  message => { throw new Error(message); });
  const defaultMaterial = await materials.register("*default", { kind: "none" });
  const backing = withRetainedFiles({ readFileOptional: async (name: string) => {
    events.push(`read:${name}`); return Uint8Array.from(text, character => character.charCodeAt(0));
  } });
  const registry = new SceneModelRegistry({ ...backing, freeFile: file => {
    events.push("free"); backing.freeFile(file);
  } }, async name => { events.push(`shader:${name}`); return materials.register(name, { kind: "none" }); },
  { kind: "unaccounted" }, defaultMaterial, message => { events.push(message); },
  index => materials.findByHandle(index), () => { events.push("sync"); sync(); });
  registry.initializeSkins();
  return { registry, events };
}

test("NULL model registration returns source handle zero before allocation or rendering callbacks", async () => {
  const input = await fixture();
  const model = await input.registry.registerModel(null);
  expect(input.registry.modelHandle(model)).toBe(0);
  expect(input.events).toEqual(["RE_RegisterModel: NULL name\n"]);
});

test("skin registration publishes its empty record before the rendering barrier and reads afterward", async () => {
  let inspect = () => undefined;
  const input = await fixture(undefined, () => inspect());
  inspect = () => {
    const listing: string[] = [];
    input.registry.listSkins(line => { listing.push(line); });
    expect(listing.slice(-2)).toEqual(["  1:player.skin\n", "------------------\n"]);
    expect(input.events).toEqual(["sync"]);
  };
  const skin = await input.registry.registerSkin("player.skin");
  expect(skin?.surfaces).toEqual([{ name: "body", shader: "model/body" }]);
  expect(input.events).toEqual(["sync", "read:player.skin", "shader:model/body", "free"]);
  expect(await input.registry.registerSkin("PLAYER.SKIN")).toBe(skin);
  expect(input.events).toHaveLength(4);
});

test("a failed rendering barrier retains an empty skin cache entry without reading", async () => {
  const input = await fixture(undefined, () => { throw new Error("queued rendering failed"); });
  await expect(input.registry.registerSkin("player.skin")).rejects.toThrow("queued rendering failed");
  expect(await input.registry.registerSkin("player.skin")).toBeNull();
  expect(input.events).toEqual(["sync"]);
});

test("skin parsing preserves prior registrations when a later token exceeds source storage", async () => {
  const input = await fixture(`Body,first\nHead,"${"x".repeat(1024)}"`);
  await expect(input.registry.registerSkin("player.skin")).rejects.toThrow("source allocation");
  expect(input.events).toEqual(["sync", "read:player.skin", "shader:first"]);
  expect((await input.registry.registerSkin("player.skin"))?.surfaces).toEqual([{ name: "body", shader: "first" }]);
});

test("skin EOF shaders and byte names reach material registration", async () => {
  const input = await fixture('"ÄBODY","shader/Ä"\nHead,');
  const skin = await input.registry.registerSkin("player.skin");
  expect(skin?.surfaces).toEqual([{ name: "Äbody", shader: "shader/Ä" }, { name: "head", shader: "" }]);
  expect(input.events).toEqual(["sync", "read:player.skin", "shader:shader/Ä", "shader:", "free"]);
});

test("skin boundary diagnostics precede barriers and capacity still permits cache hits", async () => {
  const input = await fixture();
  expect(await input.registry.registerSkin("")).toBeNull();
  expect(await input.registry.registerSkin("x".repeat(64))).toBeNull();
  expect(input.events).toEqual(["Empty name passed to RE_RegisterSkin\n", "Skin name exceeds MAX_QPATH\n"]);
  for (let index = 0; index < 1023; index++) await input.registry.registerSkin(`skin/${index}`);
  const before = input.events.length;
  expect(await input.registry.registerSkin("overflow")).toBeNull();
  expect(input.events.slice(before)).toEqual(["WARNING: RE_RegisterSkin( 'overflow' ) MAX_SKINS hit\n"]);
  expect(await input.registry.registerSkin("skin/0")).not.toBeNull();
  expect(input.events).toHaveLength(before + 1);
});
