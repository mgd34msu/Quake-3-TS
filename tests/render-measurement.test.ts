import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog, RgbaSnapshot } from "../src/render/image-resource.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import { SourceStateBit } from "../src/render/source-state.ts";
import type { DrawBatch, SurfaceViewOperation } from "../src/render/types.ts";
import { MeasuredRendererBackend } from "../tools/render-measurement.ts";
import { executeStaticBatch, publishTexture } from "./render-target-fixture.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { createRendererSettings } from "./renderer-settings-fixture.ts";

const red = new Uint8Array([255, 0, 0, 255]);
const green = new Uint8Array([0, 255, 0, 255]);

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture(): {
  readonly cpu: SoftwareRenderer;
  readonly measured: MeasuredRendererBackend;
  readonly target: RenderTarget;
  readonly batch: DrawBatch;
  readonly upload: (dirty: boolean) => void;
} {
  const images = new RendererImageCatalog();
  const cpu = new SoftwareRenderer(2, 2, images);
  const measured = new MeasuredRendererBackend(cpu);
  const target = new RenderTarget(images, [measured]);
  const image = publishTexture(images, { name: "red", width: 1, height: 1, pixels: red, internalFormat: "rgba8",
    sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  publishTexture(images, { name: "sentinel", width: 1, height: 1, pixels: green, internalFormat: "rgba8",
    sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  const coordinates: readonly (readonly [number, number])[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const batch: DrawBatch = { texturing: "single", primitive: "triangles", texture: { kind: "bind-image", image }, state: OPAQUE_STATE,
    indices: [0, 1, 2, 0, 2, 3], vertices: coordinates.map(point => ({
      position: { x: point[0], y: point[1], z: 0, w: 1 }, texCoord: { x: 0.5, y: 0.5 },
      color: { x: 1, y: 1, z: 1, w: 1 },
    })) };
  measured.beginView({ viewport: { x: 0, y: 0, width: 2, height: 2 }, clear: { stencil: false, depth: 1, color: null } });
  const upload = (dirty: boolean): void => {
    const prepared = measured.prepareGeometry(batch);
    prepared.begin();
    prepared.applyTexture(0, { kind: "cinematic-upload", upload: { image, sourceWidth: 1, sourceHeight: 1,
      uploadWidth: 1, uploadHeight: 1, dirty, content: new RgbaSnapshot(1, 1, green) } });
    prepared.draw(); prepared.cleanup();
  };
  return { cpu, measured, target, batch, upload };
}

test("clean cinematic requests remain requests and retain immutable creation provenance", () => {
  const f = fixture();
  try {
    executeStaticBatch(f.measured, f.batch);
    f.measured.beginMeasurement();
    f.upload(false);
    const completed = f.measured.endMeasurement();
    expect(Array.from(f.cpu.pixels.subarray(0, 4))).toEqual(Array.from(red));
    expect(completed.checksumScope).toBe("successful backend-request inputs");
    expect(completed.successfulBatches).toHaveLength(1);
    const texture = completed.requests.find(request => request.kind === "texture-request");
    if (texture === undefined || texture.operation.kind !== "cinematic-upload-request") throw new Error("Missing cinematic request");
    expect(texture.unit).toBe(0);
    expect(texture.operation.dirty).toBeFalse();
    expect(texture.operation.payloadSha256).toBe(digest(green));
    expect(texture.operation.image.payloadSha256).toBe(digest(red));
    expect(texture.operation.image.ordinal).toBe(0);
  } finally { f.target.close(); }
});

test("completed measurement stays fixed after a later upload", () => {
  const f = fixture();
  try {
    f.measured.beginMeasurement();
    executeStaticBatch(f.measured, f.batch);
    const completed = f.measured.endMeasurement();
    const checksum = completed.inputChecksum;
    const serialized = JSON.stringify(completed.requests);
    f.upload(true);
    expect(completed.inputChecksum).toBe(checksum);
    expect(JSON.stringify(completed.requests)).toBe(serialized);
    const texture = completed.requests.find(request => request.kind === "texture-request");
    if (texture === undefined || texture.operation.kind !== "bind-image-request") throw new Error("Missing image bind request");
    expect(texture.operation.image.payloadSha256).toBe(digest(red));
  } finally { f.target.close(); }
});

test("records only successful backend calls and successful draws", () => {
  const f = fixture();
  try {
    f.measured.beginMeasurement();
    if (f.batch.texture.kind !== "bind-image") throw new Error("Expected static image binding");
    f.measured.images.setDlightImage(f.batch.texture.image);
    f.measured.images.setCurrentBorderColor({ x: 1, y: 0.5, z: 0.25, w: 1 });
    executeStaticBatch(f.measured, f.batch);
    const completed = f.measured.endMeasurement();
    expect(completed.successfulBatches).toHaveLength(1);
    expect(completed.requests.map(request => request.kind)).toEqual([
      "dlight-image-request", "current-border-color-request", "begin-draw-request", "texture-request", "draw-request", "cleanup-request",
    ]);
    const dlight = completed.requests[0];
    if (dlight?.kind !== "dlight-image-request") throw new Error("Missing dlight identity request");
    expect(dlight.image.ordinal).toBe(f.batch.texture.image.ordinal);
    expect(dlight.image.payloadSha256).toBe(digest(red));
    f.measured.beginMeasurement();
    expect(() => f.measured.prepareGeometry({ ...f.batch, indices: [99] })).toThrow();
    const failure = f.measured.endMeasurement();
    expect(failure.successfulBatches).toHaveLength(0);
    expect(failure.requests.some(request => request.kind === "draw-request")).toBeFalse();
  } finally { f.target.close(); }
});

test("records paired texture units in execution order", () => {
  const f = fixture();
  try {
    if (f.batch.texturing !== "single" || f.batch.texture.kind !== "bind-image") throw new Error("Expected static single-image fixture");
    const paired: DrawBatch = { ...f.batch, texturing: "pair",
      vertices: f.batch.vertices.map(vertex => ({ ...vertex, texCoord2: { ...vertex.texCoord } })),
      secondTexture: { binding: { kind: "bind-image", image: f.batch.texture.image }, environment: "modulate" } };
    f.measured.beginMeasurement();
    executeStaticBatch(f.measured, paired);
    const completed = f.measured.endMeasurement();
    const units = completed.requests.flatMap(request => request.kind === "texture-request" ? [request.unit] : []);
    expect(units).toEqual([0, 1]);
  } finally { f.target.close(); }
});

for (const source of [false, true]) test(`captures ${source ? "source" : "direct"} index count before backend preparation changes caller input`, () => {
  const f = fixture();
  try {
    const indices = [...f.batch.indices];
    if (f.batch.texturing !== "single" || f.batch.primitive !== "triangles") throw new Error("Expected triangle fixture");
    const batch = { ...f.batch, indices };
    const prepareDirect = f.cpu.prepareGeometry.bind(f.cpu), prepareSource = f.cpu.prepareSourceGeometry.bind(f.cpu);
    f.cpu.prepareGeometry = input => { const prepared = prepareDirect(input); indices.length = 0; return prepared; };
    f.cpu.prepareSourceGeometry = (input, allocation) => { const prepared = prepareSource(input, allocation); indices.length = 0; return prepared; };
    f.measured.beginMeasurement();
    if (batch.texture.kind !== "bind-image") throw new Error("Expected static image binding");
    if (source) {
      const prepared = f.measured.prepareSourceGeometry({ kind: "generic-single", stateBits: SourceStateBit.DEFAULT, batch,
        scratch: batch.vertices.map(vertex => ({ color: vertex.color, texCoord: vertex.texCoord, texCoord2: { x: 0, y: 0 },
          rawTexCoord: { ...vertex.texCoord }, rawTexCoord2: { x: 0, y: 0 } })) }, { kind: "standalone" });
      prepared.begin(); prepared.prepareTexture(0); prepared.applyTexture(0, batch.texture);
      prepared.finishTextures(); prepared.draw(1); prepared.cleanup();
    } else {
      const prepared = f.measured.prepareGeometry(batch);
      prepared.begin(); prepared.applyTexture(0, batch.texture); prepared.draw(); prepared.cleanup();
    }
    const completed = f.measured.endMeasurement();
    expect(indices).toHaveLength(0);
    expect(Array.from(f.cpu.pixels)).toEqual(Array.from(red).flatMap(() => Array.from(red)));
    expect(completed.successfulBatches).toHaveLength(1);
    expect(completed.successfulBatches[0]?.indexCount).toBe(6);
  } finally { f.target.close(); }
});

test("state-only requests keep their exact values without geometry or image provenance", () => {
  const f = fixture(), offset = { factor: 2, units: -3 };
  try {
    f.measured.beginMeasurement();
    f.measured.drawImmediate({ kind: "depth-range", range: [1, 1] });
    f.measured.drawImmediate({ kind: "cull", cull: "front" });
    f.measured.drawImmediate({ kind: "sky-box-state", identityLight: 0.5 });
    f.measured.drawImmediate({ kind: "polygon-offset", value: offset });
    offset.factor = 99;
    f.measured.drawImmediate({ kind: "polygon-offset", value: null });
    expect(() => f.measured.drawImmediate({ kind: "sky-box-state", identityLight: Infinity })).toThrow();
    const completed = f.measured.endMeasurement();
    expect(completed.successfulBatches).toHaveLength(0);
    expect(completed.requests).toEqual([
      { kind: "immediate-request", input: JSON.stringify({ kind: "depth-range", range: [1, 1] }) },
      { kind: "immediate-request", input: JSON.stringify({ kind: "cull", cull: "front" }) },
      { kind: "immediate-request", input: JSON.stringify({ kind: "sky-box-state", identityLight: 0.5 }) },
      { kind: "immediate-request", input: JSON.stringify({ kind: "polygon-offset", value: { factor: 2, units: -3 } }) },
      { kind: "immediate-request", input: JSON.stringify({ kind: "polygon-offset", value: null }) },
    ]);
  } finally { f.target.close(); }
});

test("empty source stages record executed bindings and cleanup while ordinary empty draws remain suppressed", () => {
  const f = fixture();
  const commands = new RenderCommandBuffer(f.target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
    tess: new SourceTessState(), runtime: createRendererSettings().runtime });
  try {
    if (f.batch.texture.kind !== "bind-image") throw new Error("Expected source-stage image");
    const image = f.batch.texture.image;
    let samples = 0, uploads = 0, environmentReads = 0;
    const source = { image, prepareAtExecution: () => { samples++; return {
      upload: { image, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1, dirty: true, content: new RgbaSnapshot(1, 1, green) },
      afterShaderUpload: () => { uploads++; return undefined; },
    }; } };
    const batch: DrawBatch = { ...f.batch, primitive: "triangles", texturing: "pair", vertices: [], indices: [], texture: { kind: "shader-cinematic", source },
      secondTexture: { binding: { kind: "bind-image", image }, environment: "replace" } };
    f.measured.beginMeasurement();
    f.target.executeSurfaceOperations([{ kind: "draw", batches: [batch] }]);
    expect(f.measured.endMeasurement().requests).toHaveLength(0); expect(samples).toBe(0);
    f.measured.beginMeasurement();
    f.target.executeSurfaceOperations((function* (): Generator<SurfaceViewOperation, void, unknown> {
      yield { kind: "source-stage", stage: { kind: "generic-pair", stateBits: SourceStateBit.DEFAULT, batch: { ...batch,
        secondTexture: { binding: { kind: "bind-image", image }, get environment(): "replace" {
          expect(uploads).toBe(1); environmentReads++; return "replace";
        } },
      }, scratch: [] } };
    })());
    const completed = f.measured.endMeasurement();
    expect(samples).toBe(1); expect(uploads).toBe(1);
    expect(environmentReads).toBe(1);
    expect(completed.successfulBatches).toHaveLength(0);
    expect(completed.requests.map(request => request.kind)).toEqual([
      "begin-draw-request", "texture-request", "texture-request", "draw-request", "cleanup-request",
    ]);
    const first = completed.requests[1], second = completed.requests[2], draw = completed.requests[3];
    if (first?.kind !== "texture-request" || first.operation.kind !== "cinematic-upload-request"
      || second?.kind !== "texture-request" || second.operation.kind !== "bind-image-request"
      || draw?.kind !== "draw-request") throw new Error("Missing source-stage execution requests");
    expect(first.unit).toBe(0); expect(first.operation.payloadSha256).toBe(digest(green));
    expect(first.operation.image.payloadSha256).toBe(digest(red)); expect(second.unit).toBe(1);
    expect(draw.indexCount).toBe(0); expect(draw.input).toContain('"vertices":[],"indices":[]');
    expect(draw.input).toContain('"secondTextureEnvironment":"replace"');
    expect(completed.checksumScope).toBe("successful backend-request inputs");
  } finally { commands.close("discard"); f.target.close(); }
});
