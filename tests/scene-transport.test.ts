// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { HunkArena } from "../src/core/hunk.ts";
import { SourceBackendMemory, SOURCE_BACKEND_RELEASE32, sourceBackendByteLength } from "../src/render/backend-memory.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RendererResourceReceiver, RendererResourceSender } from "../src/render/renderer-resource-transport.ts";
import { createModelEntity } from "../src/render/ref-entity.ts";
import { SourceSceneEntities } from "../src/render/scene-entities.ts";
import { SourceSceneSubmission, sourceSceneCaptureAllocation } from "../src/render/scene-submission.ts";
import { parseFrameBackendSnapshots, parseFrameSceneSnapshot, parseWorldResourceJournal, SceneTransportReceiver, SceneTransportSender } from "../src/render/scene-transport.ts";
import { finishImplicitShader } from "../src/render/material-finish.ts";
import type { MaterialRecord } from "../src/render/material-registry.ts";
import type { WorldBackendSurface } from "../src/render/world-backend.ts";
import { createRendererSettings } from "./renderer-settings-fixture.ts";

function fixture() {
  const limits = { maxPolys: 4, maxPolyVertices: 12 }, hunk = new HunkArena(2 * 1024 * 1024, () => {});
  hunk.allocate(128, "low");
  const backend = SourceBackendMemory.fromAllocation(hunk.allocate(sourceBackendByteLength(limits), "low"), limits);
  const entities = new SourceSceneEntities(backend);
  const submission = new SourceSceneSubmission(entities, limits, {
    fogBounds: () => [], developerEnabled: () => false, print: () => undefined,
  }, { kind: "source", backend, shaderHandle: () => 0 });
  const imageSender = new RendererResourceSender(new RendererImageCatalog(), () => {}, () => 0);
  const imageReceiver = new RendererResourceReceiver(new RendererImageCatalog(),
    () => { throw new Error("Unexpected cinematic"); }, () => { throw new Error("Unexpected lightmap"); });
  return { backend, entities, submission, imageSender, imageReceiver,
    sender: new SceneTransportSender(imageSender), receiver: new SceneTransportReceiver(imageReceiver) };
}

const axis = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }] satisfies import("../src/core/math.ts").Axis;

test("whole release32 bytes survive snapshot ownership with source pointer base and stale cells", () => {
  const context = fixture(), { backend, entities, submission, sender, receiver } = context;
  entities.addRefEntity(createModelEntity());
  entities.sceneRange().entity(0).axisLength = 3.25;
  submission.addPolysByHandle(17, 1, 1, () => [{ position: { x: 2, y: 3, z: 4 }, texCoord: { x: 0.5, y: 0.75 }, color: { x: 1, y: 2, z: 3, w: 4 } }]);
  submission.addLight({ origin: { x: 9, y: 8, z: 7 }, color: { x: 1, y: 0, z: 0 }, radius: 40 });
  submission.completeScene(submission.captureScene());
  entities.addRefEntity(createModelEntity());
  const capture = submission.captureScene();
  backend.entityData(999).setFloat32(140, 23.5, true);
  backend.commandsData().setUint32(124, 0xfedcba98, true);
  backend.dlightData(31).setFloat32(28, 99, true);
  const snapshot = sender.scene(capture), original = snapshot.backend.allocation.bytes.slice();
  backend.bytes.fill(0);
  const restored = receiver.scene(structuredClone(snapshot));
  const memory = sourceSceneCaptureAllocation(restored).memory.backend;
  expect(memory.bytes).toEqual(original);
  expect(memory.byteOffset).toBe(128);
  expect(memory.bytes.byteOffset).toBe(0);
  expect(memory.polyVertexDataAtPointer(memory.polyData(0).getUint32(16, true)).getFloat32(0, true)).toBe(2);
  expect(restored.entities.length).toBe(1);
  expect(restored.entities.allocatedEntity(998).axisLength).toBe(23.5);
  expect(memory.dlightData(31).getFloat32(28, true)).toBe(99);
  expect(memory.commandsData().getUint32(124, true)).toBe(0xfedcba98);
  snapshot.backend.allocation.bytes.fill(255);
  expect(memory.bytes).toEqual(original);
  expect(restored.entities.entity(0).entity.origin).toEqual({ x: 0, y: 0, z: 0 });
});

test("restored transforms mutate actual dlight bytes and synchronize stable entity cells", () => {
  const { backend, entities, submission, sender, receiver } = fixture();
  entities.addRefEntity(createModelEntity());
  submission.addLight({ origin: { x: 9, y: 8, z: 7 }, color: { x: 1, y: 0, z: 0 }, radius: 40 });
  const capture = submission.captureScene(), restored = receiver.scene(sender.scene(capture));
  const cell = restored.entities.entity(0), record = cell.entity;
  const transformed = restored.transformDlights({ x: 1, y: 2, z: 3 }, axis);
  expect(transformed[0]?.origin).toEqual({ x: 8, y: 6, z: 4 });
  cell.axisLength = 17;
  sender.applyUpdates(receiver.captureUpdates());
  expect(backend.dlightData(0).getFloat32(28, true)).toBe(8);
  expect(capture.entities.entity(0).axisLength).toBe(17);
  submission.rolloverFrame();
  const next = createModelEntity(); next.frame = 12;
  entities.addRefEntity(next);
  const reused = receiver.scene(sender.scene(submission.captureScene()));
  expect(reused.entities.entity(0)).toBe(cell);
  expect(reused.entities.entity(0).entity).toBe(record);
  expect(record.frame).toBe(12);
  expect(cell.axisLength).toBe(17);
  expect(() => restored.entities.entity(0)).toThrow("completed frame");
});

test("checked scene decoders reject malformed fields and keep source allocation words", () => {
  const { submission, sender, receiver } = fixture(), snapshot = sender.scene(submission.captureScene());
  const parsed = parseFrameSceneSnapshot(structuredClone(snapshot));
  expect(receiver.scene(parsed).entities.length).toBe(0);
  expect(parseFrameBackendSnapshots([snapshot.backend])).toEqual([snapshot.backend]);
  expect(() => parseFrameSceneSnapshot(null)).toThrow();
  expect(() => parseFrameSceneSnapshot({ ...snapshot, firstLight: "0" })).toThrow("number");
  expect(() => parseFrameSceneSnapshot({ ...snapshot, backend: { id: 1, allocation: { ...snapshot.backend.allocation, bytes: [1, 2] } } })).toThrow("bytes");
  expect(() => parseWorldResourceJournal({ start: 0, entries: [{ kind: "unknown", id: 1 }] })).toThrow("registration");
});

test("surface and fog journal owns geometry and preserves registered material and image identities", () => {
  const { imageSender, imageReceiver, sender, receiver } = fixture();
  const image = imageSender.images.create({ name: "transport", sourceWidth: 1, sourceHeight: 1, mipmap: false,
    levels: [{ width: 1, height: 1, pixels: new Uint8Array([1, 2, 3, 255]) }], internalFormat: "rgba8",
    sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 });
  const finished = finishImplicitShader({ name: "transport", kind: "picture", profile: createRendererSettings().registrationProfile(),
    baseImage: { kind: "loaded", tmu: 0, binding: { kind: "images", playback: { kind: "single", image: { image } } } } });
  const material: MaterialRecord = { kind: "ordinary", name: "transport", order: 0, sortedIndex: 0, sort: finished.sort,
    lighting: { kind: "picture" }, definition: null, image, whiteImage: image, defaulted: false, finished,
    sky: null, mip: false, remapped: null, timeOffset: 0 };
  const position = { x: 1, y: 2, z: 3 };
  const vertices = [{ position, normal: { x: 0, y: 0, z: 1 }, texCoord: { x: 0, y: 0 },
    lightmapCoord: { x: Number.NaN, y: 0 }, color: { x: 1, y: 1, z: 1, w: 1 } }];
  const surface: WorldBackendSurface = { kind: "surface", material, entity: null, entityOrder: 1023, fog: -1,
    mesh: { vertices, indices: [0] }, plane: { kind: "triangle" }, grid: { lodOrigin: { x: 0, y: 0, z: 0 }, lodRadius: 8,
      mesh: { vertices, indices: [0], width: 1, height: 1, widthLodError: [0], heightLodError: [0] } }, writer: "bsp-normal", lighting: null };
  const id = sender.surface(surface);
  expect(sender.surface(surface)).toBe(id);
  const world = { fogs: [{ bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 5, z: 5 } },
    color: { x: 1, y: 0, z: 0, w: 1 }, tcScale: 0.5, surface: null }], fogTexture: image };
  const worldId = sender.world(world), journal = sender.takeJournal();
  position.x = 100;
  const firstFog = world.fogs[0];
  if (firstFog === undefined) throw new Error("Missing source fog");
  firstFog.color.x = 0;
  imageReceiver.applyJournal(imageSender.takeJournal());
  receiver.applyJournal(parseWorldResourceJournal(structuredClone(journal)));
  const restored = receiver.surface(id);
  if (restored.kind !== "surface") throw new Error("Expected mesh surface");
  expect(restored.mesh.vertices[0]?.position.x).toBe(1);
  expect(restored.grid?.mesh.vertices[0]?.position.x).toBe(1);
  expect(restored.mesh.vertices[0]?.lightmapCoord.x).toBeNaN();
  expect(restored.material).toBe(imageReceiver.resolveMaterial(0));
  expect(receiver.world(worldId).fogTexture).toBe(imageReceiver.resolveImage(image.ordinal));
  expect(receiver.world(worldId).fogs[0]?.color.x).toBe(1);
  expect(receiver.lightmapOwner(123)).toBe(receiver.lightmapOwner(123));
  expect(sender.takeJournal().entries).toEqual([]);
  expect(() => receiver.applyJournal(journal)).toThrow("out of order");
  expect(() => receiver.surface(999)).toThrow("Unregistered");
  expect(sender.surface({ ...surface })).toBe(id);
  const polyId = sender.surface({ ...surface, writer: "poly" });
  receiver.applyJournal(sender.takeJournal());
  expect(receiver.surface(polyId).kind).toBe("surface");
  receiver.applyJournal(sender.takeJournal());
  expect(() => receiver.surface(polyId)).toThrow("Unregistered");
});

test("one issue installs final frontend bytes once and preserves earlier view backend writes", () => {
  const { entities, submission, sender, receiver } = fixture();
  entities.addRefEntity(createModelEntity());
  const capture = submission.captureScene(), early = sender.scene(capture);
  capture.entities.entity(0).axisLength = 10;
  const late = sender.scene(capture);
  receiver.beginIssue([early, late]);
  const first = receiver.scene(early);
  expect(first.entities.entity(0).axisLength).toBe(10);
  first.entities.entity(0).axisLength = 20;
  expect(receiver.scene(late).entities.entity(0).axisLength).toBe(20);
  receiver.endIssue();
  sender.applyUpdates(receiver.captureUpdates());
  expect(capture.entities.entity(0).axisLength).toBe(20);
});

test("snapshot rejects truncated allocations, misaligned bases and impossible scene counters", () => {
  const { submission, sender, receiver } = fixture(), snapshot = sender.scene(submission.captureScene());
  expect(() => SourceBackendMemory.fromSnapshot({ ...snapshot.backend.allocation, bytes: new Uint8Array(12) })).toThrow("byte length");
  expect(() => SourceBackendMemory.fromSnapshot({ ...snapshot.backend.allocation, originalByteOffset: 1 })).toThrow("pointer base");
  expect(() => receiver.scene({ ...snapshot, firstLight: 31, lightCount: 2 })).toThrow("range");
  expect(() => receiver.scene({ ...snapshot, entityState: { generation: 0, count: SOURCE_BACKEND_RELEASE32.entityCount, firstSceneEntity: 0 } })).toThrow("counters");
});
