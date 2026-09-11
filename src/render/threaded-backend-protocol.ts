// Owned backend RPC values for tr_backend.c and tr_shade.c execution phases.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import type { Vec2, Vec4 } from "../core/math.ts";
import type { RendererImage } from "./image-resource.ts";
import { RgbaSnapshot } from "./image-resource.ts";
import type { CinematicUpload, ShaderCinematicSource } from "./cinematic-command.ts";
import type { RawGeometry, RenderViewState, ResolvedTextureOperation } from "./commands.ts";
import type { Rect2D } from "./draw2d.ts";
import type { BlendFactor, DrawBatch, ImmediateViewOperation, RenderClipPlane, RenderState, RenderVertex, SourceDebugNormals, SourceDebugTris, SourceGeometryAllocation, SourceStageCell, SourceStageData, TextureBinding } from "./types.ts";

function isWireRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function wireRecord(value: unknown): Record<string, unknown> {
  if (!isWireRecord(value)) throw new TypeError("Expected backend wire record");
  return value;
}
export function wireNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("Expected finite backend wire number");
  return value;
}
export function wireInteger(value: unknown): number {
  const result = wireNumber(value);
  if (!Number.isSafeInteger(result)) throw new TypeError("Expected backend wire integer");
  return result;
}
export function wireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("Expected backend wire boolean");
  return value;
}
export function wireString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected backend wire string");
  return value;
}
function isWireArray(value: unknown): value is readonly unknown[] { return Array.isArray(value); }
export function wireArray<T>(value: unknown, decode: (value: unknown) => T): T[] {
  if (!isWireArray(value)) throw new TypeError("Expected backend wire array");
  const result: T[] = [];
  for (const entry of value) result.push(decode(entry));
  return result;
}
export function wireBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError("Expected backend wire byte array");
  return new Uint8Array(value);
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  for (const candidate of choices) if (value === candidate) return candidate;
  throw new TypeError(`Invalid backend wire choice ${String(value)}`);
}
export function wirePair(value: unknown): readonly [number, number] {
  const result = wireArray(value, wireNumber), a = result[0], b = result[1];
  if (result.length !== 2 || a === undefined || b === undefined) throw new TypeError("Expected backend wire pair");
  return [a, b];
}
export function wireVec2(value: unknown): Vec2 { const v = wireRecord(value); return { x: wireNumber(v["x"]), y: wireNumber(v["y"]) }; }
export function wireVec4(value: unknown): Vec4 { const v = wireRecord(value); return { x: wireNumber(v["x"]), y: wireNumber(v["y"]), z: wireNumber(v["z"]), w: wireNumber(v["w"]) }; }
export function wireRect(value: unknown): Rect2D {
  const v = wireRecord(value);
  return { x: wireNumber(v["x"]), y: wireNumber(v["y"]), width: wireNumber(v["width"]), height: wireNumber(v["height"]) };
}
function offset(value: unknown): { factor: number; units: number } { const v = wireRecord(value); return { factor: wireNumber(v["factor"]), units: wireNumber(v["units"]) }; }
function cull(value: unknown): RenderState["cull"] { return choice(value, ["none", "back", "front"]); }
export function decodeRenderState(value: unknown): RenderState {
  const v = wireRecord(value), blend = wireRecord(v["blend"]);
  const factors: readonly BlendFactor[] = ["zero", "one", "src-color", "one-minus-src-color", "dst-color", "one-minus-dst-color", "src-alpha", "one-minus-src-alpha", "dst-alpha", "one-minus-dst-alpha", "src-alpha-saturate"];
  return { blend: { source: choice(blend["source"], factors), destination: choice(blend["destination"], factors) },
    depthTest: choice(v["depthTest"], ["less-equal", "equal", "always"]), depthWrite: wireBoolean(v["depthWrite"]),
    alphaTest: choice(v["alphaTest"], ["none", "gt0", "lt128", "ge128"]), cull: cull(v["cull"]),
    ...(v["depthRange"] === undefined ? {} : { depthRange: wirePair(v["depthRange"]) }),
    ...(v["polygonOffset"] === undefined ? {} : { polygonOffset: offset(v["polygonOffset"]) }) };
}
export interface BackendWireResources {
  image(id: number): RendererImage;
  cinematic(id: number): ShaderCinematicSource;
}
export interface BackendWireSender {
  image(image: RendererImage): number;
  cinematic(source: ShaderCinematicSource): number;
}
export function captureBinding(value: TextureBinding, resources: BackendWireSender): unknown {
  switch (value.kind) {
    case "retain-current-texture": return { kind: value.kind };
    case "bind-image": return { kind: value.kind, image: resources.image(value.image) };
    case "shader-cinematic": return { kind: value.kind, source: resources.cinematic(value.source) };
  }
}
export function decodeBinding(value: unknown, resources: BackendWireResources): TextureBinding {
  const v = wireRecord(value);
  switch (v["kind"]) {
    case "retain-current-texture": return { kind: "retain-current-texture" };
    case "bind-image": return { kind: "bind-image", image: resources.image(wireInteger(v["image"])) };
    case "shader-cinematic": return { kind: "shader-cinematic", source: resources.cinematic(wireInteger(v["source"])) };
    default: throw new TypeError("Invalid backend texture binding");
  }
}
export function captureBatch(value: DrawBatch, resources: BackendWireSender): unknown {
  return { ...value, vertices: value.vertices.map(v => ({ ...v })), indices: [...value.indices], texture: captureBinding(value.texture, resources),
    ...(value.texturing === "pair" ? { secondTexture: { environment: value.secondTexture.environment, binding: captureBinding(value.secondTexture.binding, resources) } } : {}) };
}
function vertex(value: unknown): RenderVertex {
  const v = wireRecord(value); return { position: wireVec4(v["position"]), color: wireVec4(v["color"]), texCoord: wireVec2(v["texCoord"]) };
}
export function decodeBatch(value: unknown, resources: BackendWireResources): DrawBatch {
  const v = wireRecord(value), primitive = choice(v["primitive"], ["triangles", "lines"]);
  const base = { indices: wireArray(v["indices"], wireInteger), texture: decodeBinding(v["texture"], resources), state: decodeRenderState(v["state"]) };
  const shape = primitive === "triangles" ? { primitive } : { primitive, lineWidth: wireNumber(v["lineWidth"]) };
  if (v["texturing"] === "single") return { ...base, ...shape, texturing: "single", vertices: wireArray(v["vertices"], vertex) };
  if (v["texturing"] !== "pair") throw new TypeError("Invalid backend texturing mode");
  const second = wireRecord(v["secondTexture"]);
  return { ...base, ...shape, texturing: "pair", vertices: wireArray(v["vertices"], item => ({ ...vertex(item), texCoord2: wireVec2(wireRecord(item)["texCoord2"]) })),
    secondTexture: { binding: decodeBinding(second["binding"], resources), environment: choice(second["environment"], ["modulate", "add", "replace"]) } };
}
export function decodeStageCell(value: unknown): SourceStageCell {
  const v = wireRecord(value); return { color: wireVec4(v["color"]), texCoord: wireVec2(v["texCoord"]), texCoord2: wireVec2(v["texCoord2"]), rawTexCoord: wireVec2(v["rawTexCoord"]), rawTexCoord2: wireVec2(v["rawTexCoord2"]) };
}
export function captureStage(value: SourceStageData, resources: BackendWireSender): unknown { return { ...value, batch: captureBatch(value.batch, resources) }; }
export function decodeStage(value: unknown, resources: BackendWireResources): SourceStageData {
  const v = wireRecord(value), batch = decodeBatch(v["batch"], resources), stateBits = wireInteger(v["stateBits"]), scratch = wireArray(v["scratch"], decodeStageCell);
  if (batch.primitive !== "triangles") throw new TypeError("Source stage requires triangles");
  if (batch.texturing === "single") return { kind: choice(v["kind"], ["generic-single", "vertex-lit", "dlight", "fog"]), batch, stateBits, scratch };
  return { kind: choice(v["kind"], ["generic-pair", "lightmapped-pair"]), batch, stateBits, scratch };
}
export function decodeAllocation(value: unknown): SourceGeometryAllocation {
  const v = wireRecord(value);
  if (v["kind"] === "standalone") return { kind: "standalone" };
  if (v["kind"] === "tess") return { kind: "tess", slots: wireArray(v["slots"], wireInteger), vertexCount: wireInteger(v["vertexCount"]) };
  throw new TypeError("Invalid source geometry allocation");
}
export function captureDebugTris(value: SourceDebugTris, resources: BackendWireSender): unknown { return { ...value, whiteImage: resources.image(value.whiteImage) }; }
export function decodeDebugTris(value: unknown, resources: BackendWireResources): SourceDebugTris {
  const v = wireRecord(value); return { allocation: decodeAllocation(v["allocation"]), whiteImage: resources.image(wireInteger(v["whiteImage"])), positions: wireArray(v["positions"], wireVec4), indices: wireArray(v["indices"], wireInteger), scratch: wireArray(v["scratch"], decodeStageCell) };
}
export function captureDebugNormals(value: SourceDebugNormals, resources: BackendWireSender): unknown { return { ...value, whiteImage: resources.image(value.whiteImage) }; }
export function decodeDebugNormals(value: unknown, resources: BackendWireResources): SourceDebugNormals {
  const v = wireRecord(value); return { whiteImage: resources.image(wireInteger(v["whiteImage"])), segments: wireArray(v["segments"], value => {
    const cells = wireArray(value, wireVec4), a = cells[0], b = cells[1];
    if (cells.length !== 2 || a === undefined || b === undefined) throw new TypeError("Normal requires two endpoints");
    return [a, b];
  }) };
}
function projection(value: unknown): readonly [number, number, number, number] {
  const v = wireArray(value, wireNumber), a = v[0], b = v[1], c = v[2], d = v[3];
  if (v.length !== 4 || a === undefined || b === undefined || c === undefined || d === undefined) throw new TypeError("Invalid clip projection");
  return [a, b, c, d];
}
function clip(value: unknown): RenderClipPlane {
  const v = wireRecord(value);
  if (v["kind"] === "portal") return { kind: "portal", eyePlane: wireVec4(v["eyePlane"]), projection: projection(v["projection"]) };
  if (v["kind"] === "retain") return { kind: "retain", projection: projection(v["projection"]) };
  if (v["kind"] !== undefined) throw new TypeError("Invalid clip plane kind");
  return wireVec4(v);
}
export function decodeViewState(value: unknown): RenderViewState {
  const v = wireRecord(value), clear = v["clear"] === null ? null : wireRecord(v["clear"]);
  return { viewport: wireRect(v["viewport"]), clear: clear === null ? null : { depth: wireNumber(clear["depth"]), color: clear["color"] === null ? null : wireVec4(clear["color"]), stencil: wireBoolean(clear["stencil"]) },
    ...(v["clipPlane"] === undefined ? {} : { clipPlane: clip(v["clipPlane"]) }) };
}
export function captureUpload(value: CinematicUpload, resources: BackendWireSender): unknown {
  return { ...value, image: resources.image(value.image), content: { width: value.content.width, height: value.content.height, pixels: value.content.copyPixels() } };
}
export function decodeUpload(value: unknown, resources: BackendWireResources): CinematicUpload {
  const v = wireRecord(value), content = wireRecord(v["content"]);
  return { image: resources.image(wireInteger(v["image"])), sourceWidth: wireInteger(v["sourceWidth"]), sourceHeight: wireInteger(v["sourceHeight"]), uploadWidth: wireInteger(v["uploadWidth"]), uploadHeight: wireInteger(v["uploadHeight"]), dirty: wireBoolean(v["dirty"]),
    content: new RgbaSnapshot(wireInteger(content["width"]), wireInteger(content["height"]), wireBytes(content["pixels"])) };
}
export function captureTextureOperation(value: ResolvedTextureOperation, resources: BackendWireSender): unknown {
  if (value.kind === "cinematic-upload") return { kind: value.kind, upload: captureUpload(value.upload, resources) };
  return captureBinding(value, resources);
}
export function decodeTextureOperation(value: unknown, resources: BackendWireResources): ResolvedTextureOperation {
  const v = wireRecord(value);
  if (v["kind"] === "cinematic-upload") return { kind: "cinematic-upload", upload: decodeUpload(v["upload"], resources) };
  const result = decodeBinding(value, resources);
  if (result.kind === "shader-cinematic") throw new TypeError("Unresolved shader cinematic in prepared backend call");
  return result;
}
export function decodeRawGeometry(value: unknown): RawGeometry {
  const v = wireRecord(value); return { rect: wireRect(v["rect"]), uploadWidth: wireInteger(v["uploadWidth"]), uploadHeight: wireInteger(v["uploadHeight"]), identityLight: wireNumber(v["identityLight"]) };
}
export function captureImmediate(value: ImmediateViewOperation, resources: BackendWireSender): unknown {
  if ("whiteImage" in value) return { ...value, whiteImage: resources.image(value.whiteImage) };
  if (value.kind === "sky-side") return { ...value, image: resources.image(value.image) };
  return value;
}
export function decodeImmediate(value: unknown, resources: BackendWireResources): ImmediateViewOperation {
  const v = wireRecord(value), kind = v["kind"];
  switch (kind) {
    case "disable-portal-clip": case "end-source-arrays": return { kind };
    case "display-list": return { kind, listNum: wireInteger(v["listNum"]) };
    case "log-comment": return { kind, text: wireString(v["text"]) };
    case "depth-range": return { kind, range: wirePair(v["range"]) };
    case "cull": return { kind, cull: cull(v["cull"]) };
    case "sky-box-state": return { kind, identityLight: wireNumber(v["identityLight"]) };
    case "polygon-offset": return { kind, value: v["value"] === null ? null : offset(v["value"]) };
    case "begin-source-arrays": return { kind, positions: wireArray(v["positions"], wireVec4), slots: wireArray(v["slots"], wireInteger), vertexCount: wireInteger(v["vertexCount"]) };
    case "begin-generic-iterator": return { kind, setArraysOnce: wireBoolean(v["setArraysOnce"]), scratch: wireArray(v["scratch"], decodeStageCell) };
    case "begin-debug-surface": return { kind, whiteImage: resources.image(wireInteger(v["whiteImage"])), cull: cull(v["cull"]) };
    case "debug-polygon": return { kind, color: wireInteger(v["color"]), positions: wireArray(v["positions"], wireVec4) };
    case "entity-beam": return { kind, whiteImage: resources.image(wireInteger(v["whiteImage"])), positions: wireArray(v["positions"], wireVec4) };
    case "shadow-volume": return { kind, whiteImage: resources.image(wireInteger(v["whiteImage"])), positions: wireArray(v["positions"], wireVec4), indices: wireArray(v["indices"], wireInteger), mirror: wireBoolean(v["mirror"]) };
    case "shadow-finish": {
      const p = wireArray(v["positions"], wireVec4), a = p[0], b = p[1], c = p[2], d = p[3];
      if (p.length !== 4 || a === undefined || b === undefined || c === undefined || d === undefined) throw new TypeError("Shadow finish requires four positions");
      return { kind, whiteImage: resources.image(wireInteger(v["whiteImage"])), positions: [a, b, c, d] };
    }
    case "entity-axis": {
      const p = wireArray(v["positions"], wireVec4), a = p[0], b = p[1], c = p[2], d = p[3], e = p[4], f = p[5];
      if (p.length !== 6 || a === undefined || b === undefined || c === undefined || d === undefined || e === undefined || f === undefined) throw new TypeError("Entity axis requires six positions");
      return { kind, whiteImage: resources.image(wireInteger(v["whiteImage"])), positions: [a, b, c, d, e, f] };
    }
    case "sky-side": return { kind, image: resources.image(wireInteger(v["image"])), strips: wireArray(v["strips"], row => wireArray(row, value => { const cell = wireRecord(value); return { position: wireVec4(cell["position"]), texCoord: wireVec2(cell["texCoord"]) }; })) };
    default: throw new TypeError("Invalid immediate backend operation");
  }
}
