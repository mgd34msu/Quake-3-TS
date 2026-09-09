import { expect, test } from "bun:test";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { finishImplicitShader } from "../src/render/material-finish.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import { RendererFontRegistry } from "../src/render/font-registry.ts";
import { parseFontData } from "../src/render/font.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

test("source DAT registration publishes unchecked metric words before registering shaders", async () => {
  const bytes = new Uint8Array(20548), words = new DataView(bytes.buffer);
  words.setInt32(0, -17, true); words.setInt32(12, -3, true);
  words.setInt32(20, -5, true); words.setInt32(24, -7, true);
  words.setUint32(28, 0x7fc01234, true); words.setFloat32(32, Number.POSITIVE_INFINITY, true);
  words.setFloat32(20480, -0, true);
  words.setInt32(255 * 80 + 44, 0x76543210, true);
  expect(() => parseFontData(bytes)).toThrow();
  const images = new RendererImageCatalog(), builtins = new BuiltinImages(images, identityImageUploadProfile);
  const image = builtins.defaultImage, profile = createRendererSettings().registrationProfile();
  const materials = new MaterialRegistry(async name => ({ definition: null, image, whiteImage: image,
    defaulted: false, sky: null, finished: finishImplicitShader({ name, profile, kind: "default",
      baseImage: { kind: "loaded", tmu: 0, binding: { kind: "images", playback: { kind: "single", image: { image } } } } }) }),
  message => { throw new Error(message); });
  const material = await materials.register("*default", { kind: "none" });
  const destination = new Uint8Array(20548), output = new DataView(destination.buffer);
  let shaderCalls = 0, frees = 0;
  const reader = withRetainedFiles({ readFileLength: () => bytes.length, readFileOptional: async () => bytes });
  const registry = new RendererFontRegistry({ ...reader, freeFile: file => { frees++; reader.freeFile(file); } }, async () => {
    if (shaderCalls++ === 0) {
      expect(output.getInt32(0, true)).toBe(-17);
      expect(output.getUint32(28, true)).toBe(0x7fc01234);
      expect(output.getUint32(20480, true)).toBe(0x80000000);
    }
    return { kind: "material", name: "*default", material };
  }, () => undefined);
  const font = await registry.registerFont(null, 12, () => undefined, () => destination);
  expect(shaderCalls).toBe(255); expect(frees).toBe(0);
  expect(font?.glyphs[0]?.height).toBe(-17); expect(font?.glyphs[0]?.pitch).toBe(-3);
  expect(font?.glyphs[0]?.s).toBeNaN(); expect(font?.glyphs[0]?.t).toBe(Number.POSITIVE_INFINITY);
  expect(Object.is(font?.glyphScale, -0)).toBe(true);
  expect(output.getInt32(255 * 80 + 44, true)).toBe(0x76543210);
  const cached = new Uint8Array(20548);
  expect(await registry.registerFont("another.ttf", 12, () => undefined, () => cached)).toBe(font);
  expect(cached).toEqual(destination); expect(shaderCalls).toBe(255);
});
