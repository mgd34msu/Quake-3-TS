// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { RendererImageCatalog, RgbaSnapshot } from "../src/render/image-resource.ts";
import type { CreateImageOperation, ImageCreationTarget, ImageResourceOperation, ImageSource, RendererImage, RendererImageSession } from "../src/render/image-resource.ts";
import type { TextureFilter } from "../src/render/types.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import { createImageColorMappings, imageUploadSteps } from "../src/render/image-upload.ts";
import type { ImageUploadProfile, ImageUploadSteps } from "../src/render/image-upload.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";

function neutralUploadProfile(): ImageUploadProfile {
  return { picmip: 0, roundImagesDown: false, simpleMipMaps: true, colorMipLevels: false,
    textureBits: 0, textureCompression: "none", maxTextureSize: null,
    colorMappings: createImageColorMappings({ gamma: 1, intensity: 1, requestedOverbrightBits: 0,
      deviceSupportsGamma: false, isFullscreen: false, colorBits: 24 }) };
}

describe("R_CreateImage common hunk ownership", () => {
  test("record allocation and issued identity precede upload, and actual upload completion frees before wrap", () => {
    const arena = new HunkArena(256, () => {}), accounting = new SourceHunkAccounting(arena);
    const catalog = new RendererImageCatalog("linear-mipmap-nearest", { kind: "source-hunk", accounting });
    const session = catalog.openSession(), calls: string[] = [];
    session.attach({ images: catalog, applyImageResource(operation): undefined {
      if (operation.kind === "upload-image-level") calls.push(`upload:${arena.memoryRemaining()}`);
      else if (operation.kind === "create-image") calls.push(`wrap:${arena.memoryRemaining()}`);
    } });
    const pixels = new Uint8Array([20, 30, 40, 255]);
    const image = catalog.createUploaded({ name: "fixture", sourceWidth: 1, sourceHeight: 1,
      mipmap: false, allowPicmip: false, sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 }, () => {
      calls.push(`prepare:${arena.memoryRemaining()}:${catalog.registeredImages().length}`);
      return imageUploadSteps({ width: 1, height: 1, pixels }, { name: "fixture", mipmap: false, allowPicmip: false }, neutralUploadProfile(), catalog.hunk);
    });
    expect(calls).toEqual(["prepare:128:1", "upload:116", "wrap:128"]);
    expect(accounting.report().trace.map(event => [event.action, event.source, event.bytes])).toEqual([
      ["allocate", "R_CreateImage", 112], ["allocate", "Upload32:scaledBuffer", 4], ["free-temporary", "Upload32:scaledBuffer", 4],
    ]);
    expect(image.ordinal).toBe(0);
    session.close();
    const beforeReplay = accounting.report().trace.length;
    const replay = catalog.openSession();
    replay.attach(new RecordingTarget(catalog));
    expect(accounting.report().trace.length).toBe(beforeReplay);
  });

  test("upload exhaustion retains the published record and preceding scratch allocation", () => {
    const arena = new HunkArena(256, () => {}), accounting = new SourceHunkAccounting(arena);
    const catalog = new RendererImageCatalog("linear-mipmap-nearest", { kind: "source-hunk", accounting });
    catalog.openSession().attach(new RecordingTarget(catalog));
    expect(() => catalog.createUploaded({ name: "full", sourceWidth: 3, sourceHeight: 3,
      mipmap: false, allowPicmip: false, sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 },
    () => imageUploadSteps({ width: 3, height: 3, pixels: new Uint8Array(36) },
      { name: "full", mipmap: false, allowPicmip: false }, neutralUploadProfile(), catalog.hunk))).toThrow("failed");
    expect(catalog.registeredImages().length).toBe(1);
    const partial = catalog.registeredImages()[0];
    if (partial === undefined) throw new Error("Source retained image allocation is missing");
    expect([partial.uploadWidth, partial.uploadHeight]).toEqual([0, 0]);
    expect(arena.memoryRemaining()).toBe(56);
    expect(accounting.report().trace.map(event => event.source)).toEqual(["R_CreateImage", "Upload32:resampledBuffer"]);
  });

  test("an actual upload abort retains its temporary and forbids replay", () => {
    const arena = new HunkArena(256, () => {}), accounting = new SourceHunkAccounting(arena);
    const catalog = new RendererImageCatalog("linear-mipmap-nearest", { kind: "source-hunk", accounting });
    const failure = new Error("GL_CheckErrors failure");
    catalog.openSession().attach({ images: catalog, applyImageResource(operation): undefined {
      if (operation.kind === "finish-image-upload") throw failure;
    } });
    expect(() => catalog.createUploaded({ name: "failure", sourceWidth: 1, sourceHeight: 1,
      mipmap: false, allowPicmip: false, sampling: { wrap: "clamp", filter: "linear" }, registrationUnit: 0 },
    () => imageUploadSteps({ width: 1, height: 1, pixels: new Uint8Array(4) },
      { name: "failure", mipmap: false, allowPicmip: false }, neutralUploadProfile(), catalog.hunk))).toThrow(failure);
    expect(arena.memoryRemaining()).toBe(116);
    expect(accounting.report().trace.some(event => event.action === "free-temporary")).toBe(false);
    expect(() => catalog.openSession()).toThrow("poisoned");
  });

  test("base-upload failure leaves direct descriptors unwritten but retains scaled and mipmapped descriptors", () => {
    for (const [mipmap, picmip, expectedWidth] of [[false, 0, 0], [false, 1, 1], [true, 0, 2]] satisfies readonly (readonly [boolean, number, number])[]) {
      const arena = new HunkArena(256, () => {}), backing = arena.allocateTemp(0).bytes.buffer;
      const accounting = new SourceHunkAccounting(arena), catalog = new RendererImageCatalog("linear-mipmap-nearest", { kind: "source-hunk", accounting });
      const failure = new Error("base upload failed"), calls: string[] = [];
      let retained: RendererImage | null = null;
      catalog.openSession().attach({ images: catalog, applyImageResource(operation): undefined {
        calls.push(operation.kind);
        if (operation.kind === "begin-image") retained = operation.creation.image;
        if (operation.kind === "upload-image-level") throw failure;
      } });
      const descriptor = { name: "base", sourceWidth: 2, sourceHeight: 2, mipmap, allowPicmip: true,
        sampling: { wrap: "clamp", filter: "linear" }, registrationUnit: 0 } satisfies Parameters<RendererImageCatalog["createUploaded"]>[0];
      expect(() => catalog.createUploaded(descriptor, () => imageUploadSteps({ width: 2, height: 2, pixels: new Uint8Array(16) },
        descriptor, { ...neutralUploadProfile(), picmip }, catalog.hunk))).toThrow(failure);
      const allocation = accounting.report().trace[0];
      if (allocation === undefined) throw new Error("Missing source image record");
      expect(retained).not.toBeNull();
      const record = new DataView(backing, allocation.offset, allocation.bytes);
      expect([record.getInt32(72, true), record.getInt32(76, true), record.getInt32(88, true)]).toEqual([expectedWidth, expectedWidth, expectedWidth === 0 ? 0 : 4]);
      expect(calls).toEqual(expectedWidth === 0 ? ["begin-image", "upload-image-level"]
        : ["begin-image", "set-image-upload-descriptor", "upload-image-level"]);
      expect(accounting.report().trace.some(event => event.action === "free-temporary")).toBe(false);
    }
  });

  test("source-hunk profiles reject detached preparation and streams missing the upload check", () => {
    const arena = new HunkArena(256, () => {}), accounting = new SourceHunkAccounting(arena);
    const catalog = new RendererImageCatalog("linear-mipmap-nearest", { kind: "source-hunk", accounting });
    expect(() => catalog.create(source())).toThrow("createUploaded");
    const descriptor = { name: "missing", sourceWidth: 1, sourceHeight: 1, mipmap: false, allowPicmip: false,
      sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 } satisfies Parameters<RendererImageCatalog["createUploaded"]>[0];
    const prepare = () => imageUploadSteps({ width: 1, height: 1, pixels: new Uint8Array(4) },
      descriptor, neutralUploadProfile(), catalog.hunk);
    expect(() => catalog.createUploaded(descriptor, prepare)).toThrow("attached creation target");
    expect(arena.memoryRemaining()).toBe(256);
    catalog.openSession().attach(new RecordingTarget(catalog));
    expect(() => catalog.createUploaded(descriptor, function* (): ImageUploadSteps {
      for (const step of prepare()) {
        if (step.kind === "finish-upload") return undefined;
        yield step;
      }
      return undefined;
    })).toThrow("completion boundary");
    expect(arena.memoryRemaining()).toBe(116);
  });

  test("built-in fog uses real temporary storage across its image upload and frees before border state", () => {
    const arena = new HunkArena(131072, () => {}), accounting = new SourceHunkAccounting(arena);
    const catalog = new RendererImageCatalog("linear-mipmap-nearest", { kind: "source-hunk", accounting });
    const counts: number[] = [];
    catalog.openSession().attach({ images: catalog, applyImageResource(operation): undefined {
      if (operation.kind === "upload-image-level" && operation.image.name === "*fog") counts.push(arena.byteLength - arena.memoryRemaining());
      else if (operation.kind === "create-image" && operation.creation.image.name === "*fog") counts.push(arena.byteLength - arena.memoryRemaining());
      else if (operation.kind === "current-border-color") counts.push(arena.byteLength - arena.memoryRemaining());
    } });
    new BuiltinImages(catalog, neutralUploadProfile);
    expect(catalog.registeredImages().length).toBe(37);
    expect(counts).toEqual([37 * 128 + 2 * 32776, 37 * 128 + 32776, 37 * 128]);
    const snapshot = arena.snapshot();
    expect(snapshot.high.tempHighwater - snapshot.high.permanent).toBe(65552);
    expect(accounting.report().trace.slice(-4).map(event => [event.action, event.source])).toEqual([
      ["allocate", "R_CreateImage"], ["allocate", "Upload32:scaledBuffer"],
      ["free-temporary", "Upload32:scaledBuffer"], ["free-temporary", "R_CreateFogImage"],
    ]);
  });
});

function source(name = "fixture", pixels = new Uint8Array([1, 2, 3, 4])): ImageSource {
  return { name, sourceWidth: 4, sourceHeight: 2, levels: [{ width: 1, height: 1, pixels }], mipmap: false,
    internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 };
}

class RecordingTarget implements ImageCreationTarget {
  readonly operations: CreateImageOperation[] = [];
  readonly resources: ImageResourceOperation[] = [];
  constructor(readonly images: RendererImageCatalog, private readonly events: string[] = [], private readonly label = "target") {}
  applyImageResource(resource: ImageResourceOperation): undefined {
    this.resources.push(resource);
    if (resource.kind === "texture-mode") { this.events.push(`${this.label}:mode:${resource.filter}`); return; }
    if (resource.kind === "current-border-color") { this.events.push(`${this.label}:border`); return; }
    if (resource.kind === "dlight-image") { this.events.push(`${this.label}:dlight:${resource.image.name}`); return; }
    if (resource.kind !== "create-image") return;
    const operation = resource.creation;
    this.images.requireOwned(operation.image);
    this.operations.push(operation);
    this.events.push(`${this.label}:${operation.image.name}`);
  }
}

function first(target: RecordingTarget): CreateImageOperation {
  const operation = target.operations[0];
  if (operation === undefined) throw new Error("Missing delivered creation");
  return operation;
}

describe("R_ImageList_f", () => {
  const header = "\n      -w-- -h-- -mm- -TMU- -if-- wrap --name-------\n";

  test("empty catalogs print the source header and totals as separate calls", () => {
    const calls: string[] = [];
    new RendererImageCatalog().listImages(text => { calls.push(text); });
    expect(calls).toEqual([header, " ---------\n", " 0 total texels (not including mipmaps)\n", " 0 total images\n\n"]);
  });

  test("lists immutable upload descriptors in creation order with all produced source format labels", () => {
    const catalog = new RendererImageCatalog(), calls: string[] = [];
    const formats: readonly ImageSource["internalFormat"][] = ["rgb", "rgba", "rgb5", "rgba4", "rgb8", "rgba8"];
    for (const internalFormat of formats) catalog.create({ ...source(internalFormat), internalFormat });
    catalog.setDlightImage(catalog.create({ ...source("*lightmap"), registrationUnit: 1, mipmap: true,
      levels: [{ width: 2, height: 1, pixels: new Uint8Array(8) }, { width: 1, height: 1, pixels: new Uint8Array(4) }],
      sampling: { wrap: "clamp", filter: "linear" } }));
    catalog.setTextureMode("GL_NEAREST");
    catalog.setCurrentBorderColor({ x: 1, y: 1, z: 1, w: 1 });
    catalog.setBindingSettings({ get noBind(): boolean { throw new Error("Listing must not read GL binding state"); } });
    catalog.listImages(text => { calls.push(text); });
    expect(calls).toEqual([
      header,
      "   0:    1    1  no    0   ", "RGB  ", "rept ", " rgb\n",
      "   1:    1    1  no    0   ", "RGBA ", "rept ", " rgba\n",
      "   2:    1    1  no    0   ", "RGB5 ", "rept ", " rgb5\n",
      "   3:    1    1  no    0   ", "RGBA4", "rept ", " rgba4\n",
      "   4:    1    1  no    0   ", "RGB8", "rept ", " rgb8\n",
      "   5:    1    1  no    0   ", "RGBA8", "rept ", " rgba8\n",
      "   6:    2    1  yes   1   ", "RGBA8", "clmp ", " *lightmap\n",
      " ---------\n", " 8 total texels (not including mipmaps)\n", " 7 total images\n\n",
    ]);
  });

  test("print-created images enter the live loop and trailing image count is read at its source call", () => {
    const catalog = new RendererImageCatalog(), calls: string[] = [];
    catalog.create(source("first"));
    catalog.listImages(text => {
      calls.push(text);
      if (text === " first\n") catalog.create(source("second\0ignored"));
      if (text === " ---------\n") catalog.create(source("after-loop"));
    });
    expect(calls).toEqual([
      header, "   0:    1    1  no    0   ", "RGBA8", "rept ", " first\n",
      "   1:    1    1  no    0   ", "RGBA8", "rept ", " second\n",
      " ---------\n", " 2 total texels (not including mipmaps)\n", " 3 total images\n\n",
    ]);
  });

  test("callback failure, session retirement and swallowed catalog poisoning stop output", () => {
    const failure = new Error("print stopped");
    const catalog = new RendererImageCatalog(), calls: string[] = [];
    catalog.create(source());
    expect(() => catalog.listImages(text => { calls.push(text); throw failure; })).toThrow(failure);
    expect(calls).toEqual([header]);
    const session = catalog.openSession(); session.attach(new RecordingTarget(catalog)); session.beginExecution();
    calls.length = 0;
    expect(() => catalog.listImages(text => { calls.push(text); session.close(); })).toThrow("session is closed");
    expect(calls).toEqual([header]);
    const replacement = catalog.openSession(); replacement.attach(new RecordingTarget(catalog)); replacement.beginExecution();
    calls.length = 0;
    expect(() => catalog.listImages(text => {
      calls.push(text);
      try { replacement.poison(failure); } catch { /* The listing must still observe the poisoned owner. */ }
    })).toThrow(failure);
    expect(calls).toEqual([header]);
    expect(() => catalog.listImages(text => { calls.push(text); })).toThrow("poisoned");
    expect(calls).toEqual([header]); replacement.close();
  });
});

describe("source binding settings and dlight identity", () => {
  test("settings are borrowed without evaluating or snapshotting the live getter", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession(), target = new RecordingTarget(catalog);
    session.attach(target);
    let noBind = false, reads = 0;
    catalog.setBindingSettings({ get noBind(): boolean { reads++; return noBind; } });
    expect(reads).toBe(0); expect(catalog.noBind).toBe(false); expect(reads).toBe(1);
    noBind = true; expect(catalog.noBind).toBe(true); expect(reads).toBe(2);
    expect(target.resources).toHaveLength(0);
    session.close();
    const replacement = catalog.openSession(), other = new RecordingTarget(catalog);
    replacement.attach(other);
    expect(catalog.noBind).toBe(true); expect(reads).toBe(3); expect(other.resources).toHaveLength(0);
    replacement.close();
  });

  test("dlight assignment follows its creation and replays at the same point without allocating an image", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession(), events: string[] = [];
    const firstTarget = new RecordingTarget(catalog, events, "first"), secondTarget = new RecordingTarget(catalog, events, "second");
    session.attach(firstTarget); session.attach(secondTarget); session.beginExecution();
    const dlight = catalog.create(source("light"));
    catalog.setDlightImage(dlight);
    const fog = catalog.create(source("fog"));
    expect([dlight.ordinal, fog.ordinal]).toEqual([0, 1]);
    expect(events).toEqual(["first:light", "second:light", "first:dlight:light", "second:dlight:light", "first:fog", "second:fog"]);
    const assignment = firstTarget.resources[1];
    expect(assignment).toEqual({ kind: "dlight-image", image: dlight });
    expect(assignment).toBe(secondTarget.resources[1]); expect(Object.isFrozen(assignment)).toBe(true);
    session.close();
    const replay = catalog.openSession(), fresh = new RecordingTarget(catalog); replay.attach(fresh);
    expect(fresh.resources).toEqual(firstTarget.resources); replay.close();
  });

  test("foreign dlight identities reject before publication and leave the catalog usable", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession(), target = new RecordingTarget(catalog);
    session.attach(target);
    const foreign = new RendererImageCatalog().create(source("foreign"));
    expect(() => catalog.setDlightImage(foreign)).toThrow("another catalog");
    expect(target.resources).toHaveLength(0);
    const owned = catalog.create(source()); catalog.setDlightImage(owned);
    expect(target.resources[1]).toEqual({ kind: "dlight-image", image: owned }); session.close();
  });

  test("partial dlight delivery poisons later binding reads, setting loans and replay", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession(), target = new RecordingTarget(catalog);
    const failure = new Error("second dlight assignment failed");
    session.attach(target);
    session.attach({ images: catalog, applyImageResource: operation => { if (operation.kind === "dlight-image") throw failure; } });
    const image = catalog.create(source());
    expect(() => catalog.setDlightImage(image)).toThrow(failure);
    expect(target.resources[1]).toEqual({ kind: "dlight-image", image });
    expect(session.phase).toBe("poisoned");
    expect(() => catalog.noBind).toThrow("poisoned");
    expect(() => catalog.setBindingSettings({ noBind: true })).toThrow("poisoned");
    session.close(); expect(() => catalog.openSession()).toThrow("poisoned");
  });

  test("setting replacement and dlight assignment cannot reenter consuming execution", () => {
    for (const operation of ["settings", "dlight"]) {
      const catalog = new RendererImageCatalog(), image = catalog.create(source());
      const session = catalog.openSession(); session.attach(new RecordingTarget(catalog)); session.beginExecution();
      expect(() => session.execute(() => {
        if (operation === "settings") catalog.setBindingSettings({ noBind: true });
        else catalog.setDlightImage(image);
        return undefined;
      })).toThrow("Reentrant");
      expect(session.phase).toBe("poisoned"); session.close();
    }
  });
});

describe("immutable renderer image resources", () => {
  test("changing source getters are read once before validation and publication", () => {
    const reads = { sourceWidth: 0, sourceHeight: 0, uploadWidth: 0, uploadHeight: 0, sampling: 0, wrap: 0, filter: 0 };
    const input: ImageSource = {
      ...source(),
      get sourceWidth() { return ++reads.sourceWidth === 1 ? 4 : -1; },
      get sourceHeight() { return ++reads.sourceHeight === 1 ? 2 : -1; },
      levels: [{
        get width() { return ++reads.uploadWidth === 1 ? 1 : -1; },
        get height() { return ++reads.uploadHeight === 1 ? 1 : -1; },
        pixels: new Uint8Array([1, 2, 3, 4]),
      }],
      get sampling(): ImageSource["sampling"] {
        reads.sampling++;
        return {
          get wrap(): ImageSource["sampling"]["wrap"] { reads.wrap++; return "repeat"; },
          get filter(): ImageSource["sampling"]["filter"] { reads.filter++; return "linear"; },
        };
      },
    };
    const catalog = new RendererImageCatalog(), session = catalog.openSession(), target = new RecordingTarget(catalog);
    session.attach(target);
    const image = catalog.create(input), operation = first(target);
    expect([image.sourceWidth, image.sourceHeight, operation.levels[0].width, operation.levels[0].height]).toEqual([4, 2, 1, 1]);
    expect(reads).toEqual({ sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1, sampling: 1, wrap: 1, filter: 1 });
    session.close();
  });

  test("snapshots own their bytes on input and on every read", () => {
    const input = new Uint8Array([10, 20, 30, 40]), snapshot = new RgbaSnapshot(1, 1, input);
    input.fill(255);
    const first = snapshot.copyPixels(); first.fill(0);
    expect(snapshot.copyPixels()).toEqual(new Uint8Array([10, 20, 30, 40]));
    expect(snapshot.width).toBe(1); expect(snapshot.height).toBe(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test("creation copies sampling while retaining source versus upload dimensions and format", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession(), target = new RecordingTarget(catalog);
    session.attach(target);
    const input = { ...source(), registrationUnit: 1 } satisfies ImageSource;
    const image = catalog.create(input);
    input.levels[0].pixels.fill(255);
    Object.assign(input.sampling, { wrap: "clamp", filter: "nearest" });
    const operation = first(target);
    expect(operation.image).toBe(image);
    expect([image.sourceWidth, image.sourceHeight, operation.levels[0].width, operation.levels[0].height]).toEqual([4, 2, 1, 1]);
    expect(operation.levels[0].copyPixels()).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(operation.sampling).toEqual({ wrap: "repeat", filter: "linear" });
    expect(operation.internalFormat).toBe("rgba8"); expect(operation.registrationUnit).toBe(1);
    for (const value of [image, operation, operation.sampling]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => Object.assign(operation.sampling, { wrap: "clamp" })).toThrow(TypeError);
    session.close();
  });

  test("source repeated scratch names create distinct nominal images, not name caches or sampler variants", () => {
    const catalog = new RendererImageCatalog(), images = Array.from({ length: 32 }, () => catalog.create(source("*scratch")));
    expect(new Set(images).size).toBe(32);
    expect(images.map(image => image.ordinal)).toEqual(Array.from({ length: 32 }, (_, index) => index));
    const structuralImageIsAssignable: { readonly ordinal: number; readonly name: string; readonly sourceWidth: number; readonly sourceHeight: number } extends RendererImage ? true : false = false;
    expect(structuralImageIsAssignable).toBe(false);
    const foreign = new RendererImageCatalog().create(source("*scratch"));
    expect(() => catalog.requireOwned(foreign)).toThrow("another catalog");
    const image = images[0]; if (image === undefined) throw new Error("Missing scratch image");
    expect(() => catalog.requireOwned(image)).not.toThrow();
  });

  test("RGB8 metadata does not destroy the immutable input alpha before actual device upload", () => {
    const catalog = new RendererImageCatalog();
    catalog.create({ ...source(), internalFormat: "rgb8" });
    const session = catalog.openSession(), target = new RecordingTarget(catalog); session.attach(target);
    expect(first(target).internalFormat).toBe("rgb8");
    expect(first(target).levels[0].copyPixels()).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect("borderColor" in first(target)).toBe(false);
    session.close();
  });

  test("invalid dimensions and byte counts reject before publication", () => {
    const invalid: readonly ImageSource[] = [
      { ...source(), sourceWidth: 0 }, { ...source(), sourceHeight: Number.NaN },
      { ...source(), levels: [{ width: -1, height: 1, pixels: new Uint8Array(4) }] },
      { ...source(), levels: [{ width: 1, height: 1.5, pixels: new Uint8Array(4) }] },
      { ...source(), sourceWidth: 0x80000000 }, { ...source(), levels: [{ width: 1, height: 1, pixels: new Uint8Array(3) }] },
    ];
    const catalog = new RendererImageCatalog(), session = catalog.openSession(), target = new RecordingTarget(catalog); session.attach(target);
    for (const input of invalid) expect(() => catalog.create(input)).toThrow(RangeError);
    expect(target.operations).toHaveLength(0);
    expect(catalog.create(source()).ordinal).toBe(0);
    session.beginExecution(); expect(() => session.assertExecutable()).not.toThrow(); session.close();
    expect(() => new RgbaSnapshot(0, 1, new Uint8Array())).toThrow(RangeError);
    expect(() => new RgbaSnapshot(0x7fffffff, 0x7fffffff, new Uint8Array())).toThrow(RangeError);
  });
});

describe("mip creation and texture-mode publication", () => {
  test("every mip is snapshotted and the complete chain preserves original dimensions", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession(), target = new RecordingTarget(catalog);
    session.attach(target);
    const base = new Uint8Array(16).fill(20), child = new Uint8Array(4).fill(30);
    const levels: ImageSource["levels"] = [{ width: 2, height: 2, pixels: base }, { width: 1, height: 1, pixels: child }];
    const image = catalog.create({ ...source(), mipmap: true, levels, sampling: { wrap: "clamp", filter: catalog.textureFilter }, internalFormat: "rgba4" });
    base.fill(0); child.fill(0);
    const creation = first(target);
    expect([image.sourceWidth, image.sourceHeight]).toEqual([4, 2]);
    expect(creation.levels.map(level => [level.width, level.height, [...level.copyPixels()]])).toEqual([
      [2, 2, new Array<number>(16).fill(20)], [1, 1, new Array<number>(4).fill(30)],
    ]);
    creation.levels[1]?.copyPixels().fill(0);
    expect(creation.levels[1]?.copyPixels()).toEqual(new Uint8Array(4).fill(30));
    expect(creation.mipmap).toBe(true); expect(creation.internalFormat).toBe("rgba4");
    expect(Object.isFrozen(creation.levels)).toBe(true);
    session.close();
  });

  test("missing, surplus and incorrectly sized mip levels reject before publishing", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession(), target = new RecordingTarget(catalog);
    session.attach(target);
    const one = { width: 1, height: 1, pixels: new Uint8Array(4) }, two = { width: 2, height: 2, pixels: new Uint8Array(16) };
    const invalid: readonly ImageSource[] = [
      { ...source(), mipmap: true, levels: [two] },
      { ...source(), mipmap: true, levels: [two, two, one] },
      { ...source(), mipmap: true, levels: [one, one] },
      { ...source(), mipmap: false, levels: [two, one] },
    ];
    for (const input of invalid) expect(() => catalog.create(input)).toThrow(RangeError);
    expect(target.resources).toHaveLength(0);
    expect(catalog.create({ ...source(), mipmap: true }).ordinal).toBe(0);
    expect(first(target).mipmap).toBe(true);
    session.close();
  });

  test("all six case-insensitive modes publish after global state changes and invalid names do nothing", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession(), target = new RecordingTarget(catalog);
    expect(catalog.textureFilter).toBe("linear-mipmap-nearest");
    session.attach(target);
    const observed: string[] = [];
    session.attach({ images: catalog, applyImageResource: operation => {
      if (operation.kind === "texture-mode") { expect(catalog.textureFilter).toBe(operation.filter); observed.push(operation.filter); }
    } });
    for (const filter of ["nearest", "linear", "nearest-mipmap-nearest", "linear-mipmap-nearest", "nearest-mipmap-linear", "linear-mipmap-linear"] satisfies readonly TextureFilter[]) {
      expect(catalog.setTextureMode(`gl_${filter.replaceAll("-", "_")}`)).toBe(true);
      expect(catalog.textureFilter).toBe(filter);
    }
    expect(observed).toHaveLength(6);
    expect(catalog.setTextureMode("GL_LINEAR ")).toBe(false);
    expect(catalog.setTextureMode("unknown")).toBe(false);
    expect(catalog.setTextureMode("gl_lınear")).toBe(false);
    expect(catalog.setTextureMode("gl_lİnear")).toBe(false);
    expect(catalog.setTextureMode("GL_NEAREſT")).toBe(false);
    expect(catalog.textureFilter).toBe("linear-mipmap-linear"); expect(target.resources).toHaveLength(6);
    expect(catalog.setTextureMode("gl_linear\0ignored suffix")).toBe(true);
    expect(catalog.textureFilter).toBe("linear"); expect(target.resources).toHaveLength(7);
    expect(catalog.setTextureMode("GL_LIN\0EAR")).toBe(false);
    expect(catalog.textureFilter).toBe("linear"); expect(target.resources).toHaveLength(7);
    session.close();
  });

  test("constructor seeds the retained valid filter without publishing a texture-mode operation", () => {
    const catalog = new RendererImageCatalog("nearest-mipmap-linear"), session = catalog.openSession();
    const target = new RecordingTarget(catalog); session.attach(target);
    expect(catalog.textureFilter).toBe("nearest-mipmap-linear"); expect(target.resources).toHaveLength(0);
    expect(catalog.setTextureMode("invalid restart value")).toBe(false);
    expect(catalog.textureFilter).toBe("nearest-mipmap-linear"); expect(target.resources).toHaveLength(0);
    catalog.create({ ...source(), mipmap: true, sampling: { wrap: "repeat", filter: catalog.textureFilter } });
    expect(first(target).sampling.filter).toBe("nearest-mipmap-linear"); expect(target.resources).toHaveLength(1);
    session.close();
  });

  test("mode, creation and border operations replay interleaved without changing immutable creation sampling", () => {
    const catalog = new RendererImageCatalog();
    catalog.create({ ...source("one-pixel-mip"), mipmap: true, sampling: { wrap: "repeat", filter: catalog.textureFilter } });
    catalog.setTextureMode("GL_NEAREST");
    catalog.create(source("nonmip")); catalog.setCurrentBorderColor({ x: 1, y: 1, z: 1, w: 1 });
    catalog.setTextureMode("GL_LINEAR_MIPMAP_LINEAR");
    const firstSession = catalog.openSession(), original = new RecordingTarget(catalog); firstSession.attach(original);
    expect(original.resources.map(operation => operation.kind)).toEqual(["create-image", "texture-mode", "create-image", "current-border-color", "texture-mode"]);
    expect(first(original).sampling.filter).toBe("linear-mipmap-nearest"); expect(first(original).mipmap).toBe(true);
    expect(original.operations[1]?.mipmap).toBe(false);
    firstSession.close();
    const secondSession = catalog.openSession(), fresh = new RecordingTarget(catalog); secondSession.attach(fresh);
    expect(fresh.resources).toEqual(original.resources); secondSession.close();
  });

  test("partial mode broadcast poisons the entire catalog with its first failure", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession(), target = new RecordingTarget(catalog);
    const failure = new Error("second backend mode failed");
    session.attach(target); session.attach({ images: catalog, applyImageResource: operation => {
      if (operation.kind === "texture-mode") throw failure;
    } });
    expect(() => catalog.setTextureMode("GL_LINEAR")).toThrow(failure);
    expect(target.resources).toEqual([{ kind: "texture-mode", filter: "linear" }]);
    expect(session.phase).toBe("poisoned"); expect(() => catalog.textureFilter).toThrow("poisoned");
    session.close(); expect(() => catalog.openSession()).toThrow("poisoned");
  });
});

describe("source-ordered image catalog sessions", () => {
  test("swallowed poison stops delivery immediately and preserves the original failure", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession();
    const failure = new Error("partial backend mutation");
    let laterCalls = 0;
    session.attach({ images: catalog, applyImageResource: () => {
      expect(() => session.poison(failure)).toThrow(failure);
    } });
    session.attach({ images: catalog, applyImageResource: () => { laterCalls++; } }); session.beginExecution();
    expect(() => catalog.create(source())).toThrow(failure);
    expect(laterCalls).toBe(0); expect(session.phase).toBe("poisoned");
    session.close(); expect(() => catalog.openSession()).toThrow("poisoned");
  });

  test("target ownership getters cannot begin execution during admission", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession(), firstTarget = new RecordingTarget(catalog);
    session.attach(firstTarget);
    const target: ImageCreationTarget = {
      get images() { session.beginExecution(); return catalog; },
      applyImageResource: () => undefined,
    };
    expect(() => session.attach(target)).toThrow("Reentrant");
    expect(session.phase).toBe("attaching");
    const later = new RecordingTarget(catalog); session.attach(later); session.beginExecution();
    catalog.create(source()); expect(later.operations).toHaveLength(1); session.close();
  });

  test("poison from a method getter prevents invocation of the returned callback", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession(), failure = new Error("getter failure");
    let calls = 0;
    session.attach({ images: catalog, get applyImageResource() {
      expect(() => session.poison(failure)).toThrow(failure);
      return () => { calls++; return undefined; };
    } });
    expect(() => catalog.create(source())).toThrow(failure);
    expect(calls).toBe(0); expect(session.phase).toBe("poisoned"); session.close();
  });

  test("source getter poison takes precedence over subsequent validation and never publishes", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession(), target = new RecordingTarget(catalog);
    session.attach(target);
    const failure = new Error("source getter failure");
    const input: ImageSource = { ...source(), get sourceWidth() {
      expect(() => session.poison(failure)).toThrow(failure);
      return 0;
    } };
    expect(() => catalog.create(input)).toThrow(failure);
    expect(target.operations).toHaveLength(0); expect(session.phase).toBe("poisoned"); session.close();
  });

  test("source getters cannot recursively publish another creation", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession(), target = new RecordingTarget(catalog);
    session.attach(target);
    let entered = false;
    const input: ImageSource = { ...source(), get sourceWidth() {
      if (!entered) { entered = true; catalog.create(source("inner")); }
      return 1;
    } };
    expect(() => catalog.create(input)).toThrow("Reentrant");
    expect(target.operations).toHaveLength(0);
    expect(catalog.create(source("valid")).ordinal).toBe(0); session.close();
  });

  test("fresh targets replay static creation order and later creations broadcast synchronously without queue access", () => {
    const catalog = new RendererImageCatalog(); catalog.create(source("before"));
    const session = catalog.openSession(), events: string[] = [];
    const cpu = new RecordingTarget(catalog, events, "cpu"), gl = new RecordingTarget(catalog, events, "gl");
    session.attach(cpu); session.attach(gl); session.beginExecution();
    const queued = ["older-view"];
    events.push("create-call"); catalog.create(source("after")); events.push("create-return");
    expect(events).toEqual(["cpu:before", "gl:before", "create-call", "cpu:after", "gl:after", "create-return"]);
    expect(queued).toEqual(["older-view"]);
    expect(cpu.operations[0]).toBe(gl.operations[0]); expect(cpu.operations[1]).toBe(gl.operations[1]);
    session.close();
  });

  test("the backend set is nonempty and fixed before dynamic execution", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession();
    expect(session.phase).toBe("attaching");
    expect(() => session.beginExecution()).toThrow("at least one");
    expect(() => session.assertExecutable()).toThrow("not begun");
    expect(() => catalog.openSession()).toThrow("active session");
    const target = new RecordingTarget(catalog); session.attach(target);
    expect(() => session.attach(target)).toThrow("fresh backend");
    session.beginExecution(); expect(session.phase).toBe("executing");
    expect(() => session.attach(new RecordingTarget(catalog))).toThrow("fixed");
    expect(() => session.assertExecutable()).not.toThrow();
    session.close(); session.close();
    expect(session.phase).toBe("closed"); expect(() => session.assertExecutable()).toThrow("closed");
  });

  test("clean close permits a fresh epoch that replays only creation, never an old backend object", () => {
    const catalog = new RendererImageCatalog(), image = catalog.create(source("initial"));
    const firstSession = catalog.openSession(), firstTarget = new RecordingTarget(catalog);
    firstSession.attach(firstTarget); firstSession.beginExecution(); firstSession.close();
    catalog.create(source("between-epochs"));
    const secondSession = catalog.openSession(), secondTarget = new RecordingTarget(catalog);
    expect(secondSession.epoch).toBe(firstSession.epoch + 1);
    expect(() => secondSession.attach(firstTarget)).toThrow("fresh backend");
    secondSession.attach(secondTarget); secondSession.beginExecution();
    expect(secondTarget.operations.map(operation => operation.image.name)).toEqual(["initial", "between-epochs"]);
    expect(first(secondTarget).image).toBe(image);
    expect(() => firstSession.poison(new Error("stale session"))).toThrow("closed");
    expect(() => secondSession.assertExecutable()).not.toThrow(); secondSession.close();
  });

  test("foreign target rejection leaves the catalog usable", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession();
    expect(() => session.attach(new RecordingTarget(new RendererImageCatalog()))).toThrow("another catalog");
    session.attach(new RecordingTarget(catalog)); session.beginExecution();
    expect(() => catalog.create(source())).not.toThrow(); session.close();
  });

  test("partial broadcast permanently poisons the catalog and every future execution path", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession(), firstTarget = new RecordingTarget(catalog);
    const failure = new Error("native creation failed");
    session.attach(firstTarget);
    session.attach({ images: catalog, applyImageResource: () => { throw failure; } });
    session.beginExecution();
    expect(() => catalog.create(source("partially-delivered"))).toThrow(failure);
    expect(firstTarget.operations).toHaveLength(1); expect(session.phase).toBe("poisoned");
    expect(() => catalog.create(source("not-delivered"))).toThrow("poisoned");
    expect(() => session.assertExecutable()).toThrow("poisoned");
    expect(() => session.attach(new RecordingTarget(catalog))).toThrow("poisoned");
    expect(() => catalog.requireOwned(first(firstTarget).image)).toThrow("poisoned");
    session.close(); expect(() => catalog.openSession()).toThrow("poisoned");
    expect(firstTarget.operations).toHaveLength(1);
  });

  test("failed static replay also poisons permanently, with no retry to that or another target", () => {
    const catalog = new RendererImageCatalog(); catalog.create(source("first")); catalog.create(source("second"));
    const session = catalog.openSession(), delivered: string[] = [];
    expect(() => session.attach({ images: catalog, applyImageResource: operation => {
      if (operation.kind === "create-image") {
        delivered.push(operation.creation.image.name); if (operation.creation.image.name === "second") throw new Error("replay failed");
      }
    } })).toThrow("replay failed");
    expect(delivered).toEqual(["first", "second"]);
    expect(() => session.attach(new RecordingTarget(catalog))).toThrow("poisoned");
    session.close(); expect(() => catalog.openSession()).toThrow("poisoned");
  });

  test("dynamic target failure poisons the catalog before any later registration", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession();
    session.attach(new RecordingTarget(catalog)); session.beginExecution();
    const failure = new Error("second mirror failed");
    expect(() => session.poison(failure)).toThrow(failure);
    expect(() => session.beginExecution()).toThrow("poisoned");
    expect(() => catalog.create(source())).toThrow("poisoned");
    session.close(); expect(() => catalog.openSession()).toThrow("poisoned");
  });

  test("reentrant delivery cannot reorder registration or begin a partially initialized mirror", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession();
    session.attach({ images: catalog, applyImageResource: () => { catalog.create(source("recursive")); } });
    expect(() => catalog.create(source("outer"))).toThrow("Reentrant");
    expect(session.phase).toBe("poisoned"); session.close();
    const other = new RendererImageCatalog(), otherSession = other.openSession();
    otherSession.attach({ images: other, applyImageResource: () => { otherSession.beginExecution(); } });
    expect(() => other.create(source())).toThrow("Reentrant");
    expect(otherSession.phase).toBe("poisoned"); otherSession.close();
  });
});

describe("current-object border resource journal", () => {
  test("create, border, create replay preserves order without consuming an image ordinal", () => {
    const catalog = new RendererImageCatalog(), firstImage = catalog.create(source("fog"));
    catalog.setCurrentBorderColor({ x: 1, y: 1, z: 1, w: 1 });
    const nextImage = catalog.create(source("after-fog"));
    expect([firstImage.ordinal, nextImage.ordinal]).toEqual([0, 1]);
    const session = catalog.openSession(), events: string[] = [];
    const firstTarget = new RecordingTarget(catalog, events, "first"), secondTarget = new RecordingTarget(catalog, events, "second");
    session.attach(firstTarget); session.attach(secondTarget); session.beginExecution();
    expect(events).toEqual(["first:fog", "first:border", "first:after-fog", "second:fog", "second:border", "second:after-fog"]);
    const border = firstTarget.resources[1];
    expect(border).toEqual({ kind: "current-border-color", color: { x: 1, y: 1, z: 1, w: 1 } });
    expect(border).toBe(secondTarget.resources[1]);
    catalog.setCurrentBorderColor({ x: 0, y: 0, z: 0, w: 0 });
    expect(events.slice(-2)).toEqual(["first:border", "second:border"]);
    session.close();
    const fresh = catalog.openSession(), freshTarget = new RecordingTarget(catalog); fresh.attach(freshTarget);
    expect(freshTarget.resources).toEqual(firstTarget.resources); fresh.close();
  });

  test("border-only preparation does not allocate an image and snapshots each color component once", () => {
    const catalog = new RendererImageCatalog(), reads = { x: 0, y: 0, z: 0, w: 0 };
    const color = {
      get x() { return ++reads.x === 1 ? 0.1 : -1; },
      get y() { return ++reads.y === 1 ? 0.2 : -1; },
      get z() { return ++reads.z === 1 ? 0.3 : -1; },
      get w() { return ++reads.w === 1 ? 0.4 : -1; },
    };
    expect(catalog.setCurrentBorderColor(color)).toBeUndefined();
    expect(reads).toEqual({ x: 1, y: 1, z: 1, w: 1 });
    expect(catalog.create(source()).ordinal).toBe(0);
    const session = catalog.openSession(), target = new RecordingTarget(catalog); session.attach(target);
    const operation = target.resources[0];
    if (operation === undefined || operation.kind !== "current-border-color") throw new Error("Missing border operation");
    expect(operation.color).toEqual({ x: 0.1, y: 0.2, z: 0.3, w: 0.4 });
    expect(Object.isFrozen(operation)).toBe(true); expect(Object.isFrozen(operation.color)).toBe(true);
    const mutable = { x: 0.2, y: 0.3, z: 0.4, w: 0.5 };
    catalog.setCurrentBorderColor(mutable); mutable.x = 1;
    expect(target.resources[2]).toEqual({ kind: "current-border-color", color: { x: 0.2, y: 0.3, z: 0.4, w: 0.5 } });
    session.close();
  });

  test("invalid and reentrant color getters cannot publish a resource", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession(), target = new RecordingTarget(catalog);
    session.attach(target);
    for (const x of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1]) {
      expect(() => catalog.setCurrentBorderColor({ x, y: 0, z: 0, w: 0 })).toThrow(RangeError);
    }
    const color = { get x() { catalog.create(source()); return 1; }, y: 1, z: 1, w: 1 };
    expect(() => catalog.setCurrentBorderColor(color)).toThrow("Reentrant");
    expect(target.resources).toHaveLength(0);
    expect(catalog.create(source()).ordinal).toBe(0); session.close();
  });

  test("partial current-object parameter broadcast is permanently terminal", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession(), target = new RecordingTarget(catalog);
    const failure = new Error("second device border failed");
    session.attach(target);
    session.attach({ images: catalog, applyImageResource: operation => {
      if (operation.kind === "current-border-color") throw failure;
    } });
    catalog.create(source());
    expect(() => catalog.setCurrentBorderColor({ x: 1, y: 1, z: 1, w: 1 })).toThrow(failure);
    expect(target.resources).toHaveLength(2); expect(session.phase).toBe("poisoned");
    expect(() => catalog.setCurrentBorderColor({ x: 0, y: 0, z: 0, w: 0 })).toThrow("poisoned");
    session.close(); expect(() => catalog.openSession()).toThrow("poisoned");
  });
});

describe("guarded synchronous image execution", () => {
  test("execution requires a begun session and allows ownership/health reads", () => {
    const catalog = new RendererImageCatalog(), image = catalog.create(source()), session = catalog.openSession();
    let calls = 0;
    expect(() => session.execute(() => { calls++; })).toThrow("not begun");
    expect(calls).toBe(0); expect(session.phase).toBe("attaching");
    session.attach(new RecordingTarget(catalog)); session.beginExecution();
    expect(session.execute(() => { catalog.requireOwned(image); session.assertExecutable(); calls++; })).toBeUndefined();
    expect(calls).toBe(1); expect(session.phase).toBe("executing");
    catalog.create(source("after-execution")); session.close();
    expect(() => session.execute(() => undefined)).toThrow("closed");
    const acceptsAsync: (() => Promise<undefined>) extends Parameters<RendererImageSession["execute"]>[0] ? true : false = false;
    expect(acceptsAsync).toBe(false);
  });

  test("every forbidden mutation poisons before throwing even when the callback catches it", () => {
    const actions: readonly ((catalog: RendererImageCatalog, session: RendererImageSession) => undefined)[] = [
      catalog => { catalog.create(source()); },
      catalog => { catalog.setCurrentBorderColor({ x: 1, y: 1, z: 1, w: 1 }); },
      catalog => { catalog.openSession(); },
      catalog => { catalog.setTextureMode("GL_LINEAR"); },
      (catalog, session) => { session.attach(new RecordingTarget(catalog)); },
      (_catalog, session) => { session.beginExecution(); },
      (_catalog, session) => { session.close(); },
      (_catalog, session) => { session.execute(() => undefined); },
    ];
    for (const action of actions) {
      const catalog = new RendererImageCatalog(), session = catalog.openSession(), target = new RecordingTarget(catalog);
      session.attach(target); session.beginExecution();
      expect(() => session.execute(() => {
        expect(() => action(catalog, session)).toThrow("Reentrant");
        expect(session.phase).toBe("poisoned");
        expect(() => session.assertExecutable()).toThrow("poisoned");
      })).toThrow("Reentrant");
      expect(target.resources).toHaveLength(0);
      session.close(); expect(() => catalog.openSession()).toThrow("poisoned");
    }
  });

  test("execution failures and swallowed explicit poison preserve the first cause", () => {
    for (const swallowed of [false, true]) {
      const catalog = new RendererImageCatalog(), session = catalog.openSession(), failure = new Error("first upload failed");
      session.attach(new RecordingTarget(catalog)); session.beginExecution();
      expect(() => session.execute(() => {
        if (swallowed) {
          expect(() => session.poison(failure)).toThrow(failure);
          throw new Error("later cleanup failure");
        }
        throw failure;
      })).toThrow(failure);
      expect(session.phase).toBe("poisoned");
      expect(() => session.execute(() => undefined)).toThrow("poisoned"); session.close();
      expect(() => catalog.openSession()).toThrow("poisoned");
    }
  });

  test("a rejected registration during execution cannot even read an input getter", () => {
    const catalog = new RendererImageCatalog(), session = catalog.openSession();
    session.attach(new RecordingTarget(catalog)); session.beginExecution();
    let reads = 0;
    const input: ImageSource = { ...source(), get sourceWidth() { reads++; return 1; } };
    expect(() => session.execute(() => { catalog.create(input); })).toThrow("Reentrant");
    expect(reads).toBe(0); session.close();
  });
});
