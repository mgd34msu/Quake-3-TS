// Source command references cross the renderer thread as owned values and handles.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { IssuedRendererCommands, RendererCommandReference } from "./commands.ts";
import { SOURCE_COMMAND_RELEASE32 } from "./command-memory.ts";
import type { RendererResourceSender, RendererResourceReceiver } from "./renderer-resource-transport.ts";
import type { WorldBackendView } from "./world-backend.ts";
import { parseWorldBackendView } from "./world-backend.ts";
import type { SourceScreenshotParameters } from "./screenshot.ts";
import type { RendererBackEndCounters } from "./performance.ts";
import type { ImagePicture } from "./picture-material.ts";
import type { BackendWireResources, BackendWireSender } from "./threaded-backend-protocol.ts";
import { captureBinding, decodeBinding, decodeRenderState } from "./threaded-backend-protocol.ts";

function isObject(input: unknown): input is Record<string, unknown> { return typeof input === "object" && input !== null; }
function isUnknownArray(input: unknown): input is readonly unknown[] { return Array.isArray(input); }

export function object(input: unknown): Record<string, unknown> {
  if (!isObject(input)) throw new TypeError("Renderer thread value must be an object");
  return input;
}
export function list(input: unknown): readonly unknown[] {
  if (!isUnknownArray(input)) throw new TypeError("Renderer thread value must be an array");
  return input;
}
export function numeric(input: unknown): number {
  if (typeof input !== "number") throw new TypeError("Renderer thread value must be a number");
  return input;
}
export function integer(input: unknown): number {
  const value = numeric(input);
  if (!Number.isSafeInteger(value)) throw new RangeError("Renderer thread integer is invalid");
  return value;
}
export function boolean(input: unknown): boolean {
  if (typeof input !== "boolean") throw new TypeError("Renderer thread value must be a boolean");
  return input;
}
export function string(input: unknown): string {
  if (typeof input !== "string") throw new TypeError("Renderer thread value must be a string");
  return input;
}

type CommandReferenceTransfer =
  | { readonly kind: "screenshot"; readonly token: number }
  | { readonly kind: "resolving-stretch-pic" }
  | { readonly kind: "stretch-pic"; readonly name: string; readonly material: number }
  | { readonly kind: "image-pic"; readonly name: string; readonly binding: unknown;
      readonly state: ImagePicture["state"]; readonly color: ImagePicture["color"] }
  | { readonly kind: "prepared-views"; readonly view: WorldBackendView }
  | { readonly kind: "swap-buffers"; readonly token: number | null };
export interface CommandTransfer extends Omit<IssuedRendererCommands, "references"> {
  readonly references: readonly { readonly offset: number; readonly reference: CommandReferenceTransfer }[];
}
export interface CommandReferenceSender {
  readonly resources: RendererResourceSender;
  readonly bindings: BackendWireSender;
  screenshot(command: Extract<RendererCommandReference, { readonly kind: "screenshot" }>["command"]): number;
  present(callback: () => undefined): number;
}
export interface CommandReferenceReceiver {
  readonly resources: RendererResourceReceiver;
  readonly bindings: BackendWireResources;
  prepare(view: WorldBackendView): Extract<RendererCommandReference, { readonly kind: "prepared-views" }>["execute"];
  screenshot(token: number): Extract<RendererCommandReference, { readonly kind: "screenshot" }>["command"];
  present(token: number): () => undefined;
}

export function captureCommands(input: IssuedRendererCommands, sender: CommandReferenceSender): CommandTransfer {
  const references = input.references.map(({ offset, reference }): CommandTransfer["references"][number] => {
    switch (reference.kind) {
      case "resolving-stretch-pic": return { offset, reference };
      case "screenshot": return { offset, reference: { kind: "screenshot", token: sender.screenshot(reference.command) } };
      case "swap-buffers": return { offset, reference: { kind: "swap-buffers", token: reference.present === null ? null : sender.present(reference.present) } };
      case "stretch-pic": {
        if (reference.picture.kind === "image") return { offset, reference: { kind: "image-pic", name: reference.picture.name,
          binding: captureBinding(reference.picture.texture, sender.bindings), state: structuredClone(reference.picture.state), color: { ...reference.picture.color } } };
        return { offset, reference: { kind: "stretch-pic", name: reference.picture.name, material: sender.resources.materialHandle(reference.picture.material) } };
      }
      case "prepared-views": {
        const capture = reference.execute.captureThreadedView;
        if (capture === undefined) throw new Error("Threaded renderer cannot execute a frontend-owned view generator");
        return { offset, reference: { kind: "prepared-views", view: capture(reference.drawSurfs ?? undefined) } };
      }
      case "view": throw new Error("Threaded renderer requires source view packets rather than diagnostic views");
    }
  });
  return { ...input, references };
}

export function decodeCommands(input: unknown): CommandTransfer {
  const value = object(input), bytes = value["bytes"], smpFrame = value["smpFrame"];
  if (!(bytes instanceof Uint8Array) || bytes.buffer instanceof SharedArrayBuffer
    || bytes.byteLength !== SOURCE_COMMAND_RELEASE32.capacity + 4) throw new RangeError("Invalid owned renderer command allocation");
  if (smpFrame !== 0 && smpFrame !== 1) throw new RangeError("Invalid renderer SMP frame");
  const references = list(value["references"]).map((input): CommandTransfer["references"][number] => {
    const entry = object(input), offset = integer(entry["offset"]), source = object(entry["reference"]), kind = source["kind"];
    if (offset < 0 || offset >= SOURCE_COMMAND_RELEASE32.capacity || offset % 4 !== 0) throw new RangeError("Invalid renderer command reference offset");
    switch (kind) {
      case "resolving-stretch-pic": return { offset, reference: { kind } };
      case "screenshot": return { offset, reference: { kind, token: integer(source["token"]) } };
      case "swap-buffers": return { offset, reference: { kind, token: source["token"] === null ? null : integer(source["token"]) } };
      case "stretch-pic": return { offset, reference: { kind, name: string(source["name"]), material: integer(source["material"]) } };
      case "image-pic": {
        const color = object(source["color"]), rgb = color["rgb"], alpha = color["alpha"];
        if (rgb !== "vertex" && rgb !== "exactvertex" && rgb !== "identity" && rgb !== "identitylighting") throw new TypeError("Invalid renderer picture RGB mode");
        if (alpha !== "vertex" && alpha !== "identity" && alpha !== "identitylighting") throw new TypeError("Invalid renderer picture alpha mode");
        return { offset, reference: { kind, name: string(source["name"]), binding: source["binding"], state: decodeRenderState(source["state"]), color: { rgb, alpha } } };
      }
      case "prepared-views": return { offset, reference: { kind, view: parseWorldBackendView(source["view"]) } };
      default: throw new Error("Invalid renderer command reference kind");
    }
  });
  return { bytes, references, smpFrame, beginFrame: boolean(value["beginFrame"]), identityLight: numeric(value["identityLight"]),
    resetPerformanceCounters: boolean(value["resetPerformanceCounters"]) };
}

export function restoreCommands(input: CommandTransfer, receiver: CommandReferenceReceiver): IssuedRendererCommands {
  const references = input.references.map(({ offset, reference }): IssuedRendererCommands["references"][number] => {
    switch (reference.kind) {
      case "resolving-stretch-pic": return { offset, reference };
      case "screenshot": return { offset, reference: { kind: reference.kind, command: receiver.screenshot(reference.token) } };
      case "swap-buffers": return { offset, reference: { kind: reference.kind, present: reference.token === null ? null : receiver.present(reference.token) } };
      case "stretch-pic": return { offset, reference: { kind: reference.kind, picture: {
        kind: "material", name: reference.name, material: receiver.resources.resolveMaterial(reference.material),
      } } };
      case "image-pic": return { offset, reference: { kind: "stretch-pic", picture: { kind: "image", name: reference.name,
        texture: decodeBinding(reference.binding, receiver.bindings), state: reference.state, color: reference.color } } };
      case "prepared-views": return { offset, reference: { kind: reference.kind, execute: receiver.prepare(reference.view), drawSurfs: null } };
    }
  });
  return { ...input, references };
}

export function decodeScreenshotParameters(input: unknown): SourceScreenshotParameters {
  const value = object(input);
  return { x: integer(value["x"]), y: integer(value["y"]), width: integer(value["width"]), height: integer(value["height"]), jpeg: boolean(value["jpeg"]) };
}

export function decodeBackendCounters(input: unknown): RendererBackEndCounters {
  const value = object(input);
  return {
    c_surfaces: numeric(value["c_surfaces"]), c_shaders: numeric(value["c_shaders"]), c_vertexes: numeric(value["c_vertexes"]),
    c_indexes: numeric(value["c_indexes"]), c_totalIndexes: numeric(value["c_totalIndexes"]), c_overDraw: numeric(value["c_overDraw"]),
    c_dlightVertexes: numeric(value["c_dlightVertexes"]), c_dlightIndexes: numeric(value["c_dlightIndexes"]),
    c_flareAdds: numeric(value["c_flareAdds"]), c_flareTests: numeric(value["c_flareTests"]), c_flareRenders: numeric(value["c_flareRenders"]),
    msec: numeric(value["msec"]),
  };
}
