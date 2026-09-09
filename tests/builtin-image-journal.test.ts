import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { expect, test } from "bun:test";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { CreateImageOperation, ImageResourceOperation } from "../src/render/image-resource.ts";

function creations(operations: readonly ImageResourceOperation[]): readonly CreateImageOperation[] {
  return operations.flatMap(operation => operation.kind === "create-image" ? [operation.creation] : []);
}

function hash(bytes: Uint8Array): number {
  let value = 2166136261;
  for (const byte of bytes) value = Math.imul(value ^ byte, 16777619) >>> 0;
  return value;
}

test("all 37 built-in images publish in native order before the current-object fog border", () => {
  const images = new RendererImageCatalog();
  const operations: ImageResourceOperation[] = [];
  const session = images.openSession();
  session.attach({ images, applyImageResource(operation) { operations.push(operation); } });
  session.beginExecution();
  const builtins = new BuiltinImages(images, identityImageUploadProfile);
  const dlight = builtins.find("*dlight");
  if (dlight === undefined) throw new Error("Missing built-in dynamic-light identity");
  const created = creations(operations);
  expect(created).toHaveLength(37);
  expect(operations).toHaveLength(191);
  expect(created.map(operation => operation.image.name)).toEqual([
    "*default", "*white", "*identityLight", ...Array.from({ length: 32 }, () => "*scratch"), "*dlight", "*fog",
  ]);
  expect(created.map(operation => operation.image.ordinal)).toEqual(Array.from({ length: 37 }, (_, index) => index));
  expect(created.every(operation => operation.registrationUnit === 0)).toBe(true);
  expect(operations[184]).toEqual({ kind: "dlight-image", image: dlight.image });
  expect(operations.slice(185, 190).map(operation => operation.kind)).toEqual([
    "begin-image", "upload-image-level", "set-image-upload-descriptor", "finish-image-upload", "create-image",
  ]);
  expect(operations[190]).toEqual({ kind: "current-border-color", color: { x: 1, y: 1, z: 1, w: 1 } });
  expect(created[0]?.image).toBe(builtins.defaultImage);
  expect(created[36]?.image).toBe(builtins.fogImage);
  expect(created[0]?.internalFormat).toBe("rgba8");
  expect(created[36]?.internalFormat).toBe("rgba8");
  expect(created.slice(1, 36).every(operation => operation.internalFormat === "rgb8")).toBe(true);
  // Native five-image hashes; each 16x16 scratch is exactly 1024 white bytes.
  expect(created.map(operation => hash(operation.levels[0].copyPixels()))).toEqual([
    3473967445, 111364805, 111364805, ...Array.from({ length: 32 }, () => 1110397381), 1830504773, 1305453869,
  ]);
  for (let index = 0; index < 32; index++) {
    const image = builtins.scratchImage(index);
    expect(created[index + 3]?.image).toBe(image);
    expect([image.sourceWidth, image.sourceHeight]).toEqual([16, 16]);
    const metadata = builtins.forImage(image);
    if (metadata === undefined) throw new Error("Native scratch image metadata is missing");
    expect(metadata).toEqual({ image, mipmap: false, allowPicmip: true, wrap: "clamp" });
  }
  // R_CreateImage prepends each same-name image to the hash chain.
  expect(builtins.find("*scratch")?.image).toBe(builtins.scratchImage(31));
  expect(builtins.find("*WHITE")).toBeUndefined();
  expect(builtins.find("*identitylight")).toBeUndefined();
  for (const index of [-1, 32, 0.5, NaN]) expect(() => builtins.scratchImage(index)).toThrow(RangeError);
  session.close();
});

test("late target attachment replays built-ins and border without publishing a second image set", () => {
  const images = new RendererImageCatalog();
  const builtins = new BuiltinImages(images, identityImageUploadProfile);
  const dlight = builtins.find("*dlight");
  if (dlight === undefined) throw new Error("Missing built-in dynamic-light identity");
  const first: ImageResourceOperation[] = [], second: ImageResourceOperation[] = [];
  const session = images.openSession();
  session.attach({ images, applyImageResource(operation) { first.push(operation); } });
  session.attach({ images, applyImageResource(operation) { second.push(operation); } });
  session.beginExecution();
  expect(first).toEqual(second);
  expect(first).toHaveLength(191);
  expect(first[184]).toEqual({ kind: "dlight-image", image: dlight.image });
  expect(creations(first)[3]?.image).toBe(builtins.scratchImage(0));
  const fog = creations(first)[36];
  if (fog === undefined) throw new Error("Fog creation missing from the native built-in sequence");
  expect(fog.sampling).toEqual({ wrap: "clamp", filter: "linear" });
  expect(Object.hasOwn(fog, "borderColor")).toBe(false);
  session.close();
});
