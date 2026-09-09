import { expect, test } from "bun:test";
import { HunkArena } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { ImageUploadSource } from "../src/render/image-resource.ts";
import type { ImageUploadSteps } from "../src/render/image-upload.ts";

const descriptor: ImageUploadSource = { name: "partial", sourceWidth: 4, sourceHeight: 4,
  mipmap: true, allowPicmip: true, sampling: { wrap: "clamp", filter: "linear" }, registrationUnit: 1 };

test("image listing retains allocations before upload and after descriptor publication", () => {
  const catalog = new RendererImageCatalog(), failure = new Error("upload interrupted");
  expect(() => catalog.createUploaded(descriptor, function* (): ImageUploadSteps { throw failure; })).toThrow(failure);
  expect(() => catalog.createUploaded({ ...descriptor, name: "sized" }, function* (): ImageUploadSteps {
    yield { kind: "set-upload-descriptor", width: 2, height: 2, internalFormat: "rgba" };
    throw failure;
  })).toThrow(failure);
  const calls: string[] = [];
  catalog.listImages(text => { calls.push(text); });
  expect(calls).toEqual([
    "\n      -w-- -h-- -mm- -TMU- -if-- wrap --name-------\n",
    "   0:    0    0  yes   1   ", "???? ", "clmp ", " partial\n",
    "   1:    2    2  yes   1   ", "RGBA ", "clmp ", " sized\n",
    " ---------\n", " 4 total texels (not including mipmaps)\n", " 2 total images\n\n",
  ]);
});

test("image allocation copies byte names through NUL without UTF8 expansion", () => {
  const arena = new HunkArena(1024, () => {}), accounting = new SourceHunkAccounting(arena);
  const catalog = new RendererImageCatalog("linear", { kind: "source-hunk", accounting });
  catalog.openSession().attach({ images: catalog, applyImageResource: () => undefined });
  const failure = new Error("stop after allocation"), name = "Ä".repeat(40);
  expect(() => catalog.createUploaded({ ...descriptor, name: name + "\0ignored" }, function* (): ImageUploadSteps { throw failure; })).toThrow(failure);
  const [image] = catalog.registeredImages();
  expect(image?.name).toBe(name);
  expect(() => catalog.createUploaded({ ...descriptor, name: "Ā" }, function* (): ImageUploadSteps { throw failure; })).toThrow("source bytes");
});
