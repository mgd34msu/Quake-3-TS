// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { ImageResourceOperation } from "../src/render/image-resource.ts";
import { RendererResourceReceiver, RendererResourceSender } from "../src/render/renderer-resource-transport.ts";
import { finishImplicitShader } from "../src/render/material-finish.ts";
import type { MaterialRecord } from "../src/render/material-registry.ts";
import { createRendererSettings } from "./renderer-settings-fixture.ts";
import { captureMd3Surface, md3SurfaceSource, parseMd3SurfaceTransfer, restoreMd3Surface } from "../src/render/md3-resource.ts";
import { captureMd4Surface, parseMd4SurfaceTransfer, restoreMd4Surface } from "../src/render/md4-resource.ts";

function fixture() {
  const main = new RendererImageCatalog(), worker = new RendererImageCatalog();
  const barriers: number[] = [], operations: ImageResourceOperation[] = [];
  const sender = new RendererResourceSender(main, () => { barriers.push(main.registeredImages().length); }, () => 7);
  const receiver = new RendererResourceReceiver(worker,
    () => { throw new Error("Unexpected cinematic"); }, () => { throw new Error("Unexpected lightmap"); });
  worker.openSession().attach({ images: worker, applyImageResource(operation) { operations.push(operation); return undefined; } });
  const create = (name: string, color = 10) => main.create({ name, sourceWidth: 1, sourceHeight: 1, mipmap: false,
    levels: [{ width: 1, height: 1, pixels: new Uint8Array([color, 20, 30, 255]) }], internalFormat: "rgba8",
    sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 });
  return { main, worker, sender, receiver, barriers, operations, create };
}

function material(image: ReturnType<ReturnType<typeof fixture>["create"]>, order: number): MaterialRecord {
  const finished = finishImplicitShader({ name: `material${order}`, kind: "picture",
    profile: createRendererSettings().registrationProfile(),
    baseImage: { kind: "loaded", tmu: 0, binding: { kind: "images", playback: { kind: "single", image: { image } } } } });
  return { kind: "ordinary", name: `material${order}`, order, sortedIndex: order, sort: finished.sort, lighting: { kind: "picture" },
    definition: null, image, whiteImage: image, defaulted: false, finished, sky: null, mip: false, remapped: null, timeOffset: 0 };
}

test("structured clone recreates owned image identities and ordered immutable pixel uploads", () => {
  const context = fixture(), first = context.create("first");
  context.main.setCurrentBorderColor({ x: 1, y: 0, z: 0, w: 1 });
  context.main.setTextureMode("GL_LINEAR_MIPMAP_LINEAR", { hardware: "3dfx2d3d", print: () => {} });
  context.main.setDlightImage(first);
  const journal = context.sender.takeJournal();
  const transferred: typeof journal = structuredClone(journal);
  context.receiver.applyJournal(transferred);
  const image = context.receiver.resolveImage(first.ordinal);
  expect(image).not.toBe(first);
  expect(image.belongsTo(context.worker)).toBe(true);
  expect(() => context.main.requireOwned(image)).toThrow("another catalog");
  expect(context.operations.map(operation => operation.kind)).toEqual(["create-image", "current-border-color", "texture-mode", "dlight-image"]);
  const creation = context.operations[0];
  if (creation?.kind !== "create-image") throw new Error("Missing creation");
  expect(creation.creation.levels[0].copyPixels()).toEqual(new Uint8Array([10, 20, 30, 255]));
  const upload = transferred.entries.find(entry => entry.kind === "image-operation" && entry.operation.kind === "create-image");
  if (upload?.kind !== "image-operation" || upload.operation.kind !== "create-image") throw new Error("Missing transfer creation");
  upload.operation.levels[0].pixels.fill(99);
  expect(creation.creation.levels[0].copyPixels()[0]).toBe(10);
  expect(context.worker.textureFilter).toBe("linear-mipmap-nearest");
  expect(context.sender.takeJournal().entries).toEqual([]);
  expect(() => context.receiver.applyJournal(journal)).toThrow("out of order");
  const second = context.create("second", 50);
  context.receiver.applyJournal(structuredClone(context.sender.takeJournal()));
  expect(context.receiver.resolveImage(second.ordinal).ordinal).toBe(1);
  expect(context.operations.filter(operation => operation.kind === "create-image")).toHaveLength(2);
});

test("phased uploads reach the worker at each source creation callback", () => {
  const context = fixture();
  context.main.openSession().attach({ images: context.main, applyImageResource() {
    context.receiver.applyJournal(structuredClone(context.sender.takeJournal()));
    return undefined;
  } });
  context.main.createUploaded({ name: "phased", sourceWidth: 1, sourceHeight: 1, mipmap: false, allowPicmip: false,
    sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 }, function* () {
    expect(context.operations.map(operation => operation.kind)).toEqual(["begin-image"]);
    yield { kind: "upload-level", index: 0, internalFormat: "rgba8", level: { width: 1, height: 1, pixels: new Uint8Array([1, 2, 3, 4]) } };
    expect(context.operations.at(-1)?.kind).toBe("upload-image-level");
    yield { kind: "set-upload-descriptor", width: 1, height: 1, internalFormat: "rgba8" };
    yield { kind: "finish-upload" };
    return undefined;
  });
  expect(context.operations.map(operation => operation.kind)).toEqual(["begin-image", "upload-image-level", "set-image-upload-descriptor", "finish-image-upload", "create-image"]);
  expect(context.receiver.resolveImage(0).uploadWidth).toBe(1);
  expect(context.barriers).toEqual([0, 0]);
});

test("frame usage and dynamic scratch dimensions return without replaying dynamic uploads", () => {
  const context = fixture(), image = context.create("scratch");
  context.receiver.applyJournal(context.sender.takeJournal());
  const beforeFrame = context.barriers.length;
  context.main.beginFrame();
  expect(context.barriers).toHaveLength(beforeFrame);
  context.main.setBindingSettings({ noBind: true });
  context.receiver.applyState(context.sender.captureState());
  const remote = context.receiver.resolveImage(image.ordinal);
  context.worker.markUsed(remote);
  context.worker.resizeCinematic(remote, 8, 4);
  context.sender.applyUsage(context.receiver.captureUsage());
  expect([image.frameUsed, image.uploadWidth, image.uploadHeight]).toEqual([1, 8, 4]);
  expect(context.main.sumOfUsedImages()).toBe(32);
  expect(context.worker.noBind).toBe(true);
  expect(context.sender.takeJournal().entries).toEqual([]);
  expect(context.operations).toHaveLength(1);
});

test("material stages retain shared image identities, remap cycles and incremental sort updates", () => {
  const context = fixture(), image = context.create("material-image"), first = material(image, 0), second = material(image, 1);
  first.remapped = second; second.remapped = first; second.timeOffset = 2.5;
  context.sender.materialHandle(first);
  context.receiver.applyJournal(structuredClone(context.sender.takeJournal()));
  const restored = context.receiver.resolveMaterial(0), replacement = context.receiver.resolveMaterial(1);
  expect(restored.remapped).toBe(replacement);
  expect(replacement.remapped).toBe(restored);
  expect(replacement.timeOffset).toBe(2.5);
  const binding = restored.finished.iterator.passes[0]?.bundles[0].binding;
  if (binding?.kind !== "images" || binding.playback.kind !== "single") throw new Error("Missing restored material image");
  expect(binding.playback.image.image).toBe(restored.image);
  expect(restored.whiteImage).toBe(restored.image);
  first.sortedIndex = 1; second.sortedIndex = 0; first.remapped = null;
  const delta = context.sender.takeJournal();
  expect(delta.entries.every(entry => entry.kind === "material-state")).toBe(true);
  context.receiver.applyJournal(structuredClone(delta));
  expect(context.receiver.materialBySortedIndex(0)).toBe(replacement);
  expect(context.receiver.resolveMaterial(0)).toBe(restored);
  expect(restored.remapped).toBeNull();
});

test("unknown ordinals and foreign nominal objects cannot enter the worker catalog", () => {
  const context = fixture(), foreign = fixture().create("foreign");
  expect(() => context.sender.sourceImageHandle(foreign)).toThrow("another catalog");
  expect(() => context.receiver.resolveImage(2)).toThrow("Unregistered");
  expect(() => context.receiver.applyJournal({ first: 0, entries: [{ kind: "image-identity", identity: {
    ordinal: 2, name: "out-of-order", sourceWidth: 1, sourceHeight: 1, mipmap: false, wrap: "repeat", registrationUnit: 0,
  } }] })).toThrow("out of order");
});

test("animation, sky faces, lightmap identity and video callbacks survive registration without early execution", () => {
  const context = fixture(), firstImage = context.create("first"), secondImage = context.create("second");
  const base = material(firstImage, 0), original = base.finished.sourceStages[0], pass = base.finished.iterator.passes[0];
  if (original === undefined || !original.active || pass === undefined) throw new Error("Fixture requires active stage");
  const owner = {}, remoteOwner = {}, videoCalls: number[] = [];
  const animated = { ...original, binding: { kind: "images", playback: { kind: "animation", frequency: 2,
    frames: [{ image: firstImage }, { image: secondImage }] } } } satisfies typeof original;
  const videoSource = { image: secondImage, prepareAtExecution: () => { throw new Error("Main cinematic evaluated early"); } };
  const video = { ...original, binding: { kind: "video", source: videoSource } } satisfies typeof original;
  const shader: MaterialRecord = { ...base, lighting: { kind: "lightmap", owner, index: 3, image: secondImage },
    sky: { outer: { image: face => ({ image: face === "rt" ? firstImage : secondImage }) }, inner: null, cloudHeight: 512 },
    finished: { ...base.finished, sourceStages: [animated, video], iterator: { ...base.finished.iterator,
      passes: [{ ...pass, bundles: [animated] }, { ...pass, bundles: [video] }] } } };
  context.sender.registerLightmapOwner(owner, 17);
  context.sender.materialHandle(shader);
  const receiver: RendererResourceReceiver = new RendererResourceReceiver(context.worker, id => ({ image: receiver.resolveImage(secondImage.ordinal),
    prepareAtExecution() { videoCalls.push(id); return null; } }), id => {
      expect(id).toBe(17);
      return remoteOwner;
    });
  receiver.applyJournal(structuredClone(context.sender.takeJournal()));
  const restored = receiver.resolveMaterial(0), remoteSecond = receiver.resolveImage(secondImage.ordinal);
  expect(restored.lighting.kind === "lightmap" ? restored.lighting.owner : null).toBe(remoteOwner);
  expect(restored.sky?.outer?.image("bk").image).toBe(remoteSecond);
  const animation = restored.finished.sourceStages[0]?.binding;
  if (animation?.kind !== "images" || animation.playback.kind !== "animation") throw new Error("Missing animation");
  expect(animation.playback.frames[1]?.image).toBe(remoteSecond);
  expect(animation.playback.frequency).toBe(2);
  const cinematic = restored.finished.iterator.passes[1]?.bundles[0].binding;
  if (cinematic?.kind !== "video") throw new Error("Missing cinematic callback");
  expect(videoCalls).toEqual([]);
  expect(cinematic.source.prepareAtExecution()).toBeNull();
  expect(videoCalls).toEqual([7]);
  expect(context.sender.takeJournal().entries).toEqual([]);
});

test("MD3 transfer preserves retained byte reads and copies allocation ownership", () => {
  const bytes = new Uint8Array(256), view = new DataView(bytes.buffer), offset = 108;
  view.setInt32(offset, 6, true); view.setInt32(offset + 72, 1, true); view.setInt32(offset + 80, 1, true);
  view.setInt32(offset + 84, 1, true); view.setInt32(offset + 88, 108, true);
  view.setInt32(offset + 96, 120, true); view.setInt32(offset + 100, 128, true);
  view.setFloat32(offset + 120, 0.25, true); view.setFloat32(offset + 124, -0.5, true);
  view.setInt16(offset + 128, 96, true); view.setInt16(offset + 130, -64, true); view.setInt16(offset + 132, 32, true);
  const source = restoreMd3Surface({ kind: "allocation", bytes, source: "retained.md3", offset });
  const transfer = captureMd3Surface(source), remote = restoreMd3Surface(parseMd3SurfaceTransfer(structuredClone(transfer)));
  bytes.fill(255);
  const reader = md3SurfaceSource(remote);
  expect([reader.vertexFrame(0).xyz(0, 0), reader.vertexFrame(0).xyz(0, 1), reader.vertexFrame(0).xyz(0, 2)]).toEqual([96, -64, 32]);
  expect([reader.textureCoordinates().at(0), reader.textureCoordinates().at(1)]).toEqual([0.25, -0.5]);
  expect(() => reader.vertexFrame(10).xyz(0, 0)).toThrow("exceeds copied MD3 allocation");
  expect(() => restoreMd3Surface({ kind: "allocation", bytes, source: "invalid", offset: 200 })).toThrow("outside");
  expect(() => parseMd3SurfaceTransfer({ kind: "allocation", bytes, source: "invalid", offset: -1 })).toThrow("Invalid");
  expect(() => parseMd3SurfaceTransfer({ kind: "decoded", surface: { name: "invalid", flags: 0, shaders: [], triangles: [{ indices: [0, 1] }], texCoords: [], frames: [] } })).toThrow("three indices");
});

test("MD4 transfer recreates actual bone animation and material owner without registration side effects", () => {
  const context = fixture(), shader = material(context.create("md4"), 0), bytes = new Uint8Array(424), view = new DataView(bytes.buffer);
  const offset = 200;
  view.setInt32(72, 1, true); view.setInt32(76, 1, true); view.setInt32(84, 100, true);
  for (const [index, value] of [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30].entries()) view.setFloat32(140 + index * 4, value, true);
  view.setInt32(offset, 7, true); view.setInt32(offset + 136, -offset, true);
  view.setInt32(offset + 140, 1, true); view.setInt32(offset + 144, 180, true);
  view.setInt32(offset + 148, 1, true); view.setInt32(offset + 152, 168, true);
  const vertex = offset + 180;
  view.setFloat32(vertex + 8, 1, true); view.setFloat32(vertex + 12, 0.25, true);
  view.setInt32(vertex + 20, 1, true); view.setFloat32(vertex + 28, 1, true);
  view.setFloat32(vertex + 32, 2, true); view.setFloat32(vertex + 36, 3, true); view.setFloat32(vertex + 40, 4, true);
  const printed: string[] = [], host = { shaderForHandle: (handle: number) => handle === 0 ? shader : null, print: (text: string): undefined => { printed.push(text); } };
  const original = restoreMd4Surface({ bytes, source: "retained.md4", offset, defaultMaterial: 0, lodOffsets: [[offset]] }, host);
  const restored = restoreMd4Surface(parseMd4SurfaceTransfer(structuredClone(captureMd4Surface(original))), host);
  bytes.fill(255);
  expect(restored.material).toBe(shader);
  expect(restored.owner.lods[0]?.[0]).toBe(restored);
  expect(restored.animate({ frame: 0, oldFrame: 0, backLerp: 0 })[0]).toEqual({ position: { x: 12, y: 23, z: 34 }, normal: { x: 0, y: 0, z: 1 }, texCoord: { x: 0.25, y: 0 } });
  expect(printed).toEqual([]);
  expect(() => restored.animate({ frame: 99, oldFrame: 0, backLerp: 0 })).toThrow("exceeds copied MD4 allocation");
  expect(() => parseMd4SurfaceTransfer({ bytes, source: "invalid", offset, defaultMaterial: 0, lodOffsets: [[999]] })).toThrow("surface offset");
});
