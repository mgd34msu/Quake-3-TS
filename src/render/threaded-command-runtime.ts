// Source command execution and reached host callbacks for the Bun render thread.
// Original renderer copyright (C) 1999-2005 Id Software, Inc.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { HunkAllocation, HunkArena } from "../core/hunk.ts";
import type { Vec3 } from "../core/math.ts";
import { RenderCommandBuffer } from "./commands.ts";
import type { IssuedRendererCommands, RendererCommandReference, RendererCommandThread, SubmissionReceipt } from "./commands.ts";
import type { PreparedUiRawCall, UiRawCinematicCall } from "./cinematic-command.ts";
import type { Rect2D } from "./draw2d.ts";
import type { MaterialRecord } from "./material-registry.ts";
import type { PictureClock } from "./picture-material.ts";
import type { RendererSettings } from "./settings.ts";
import { SourceTessState } from "./tess-state.ts";
import { SceneTransportReceiver, SceneTransportSender, parseFrameBackendSnapshots, parseWorldResourceJournal } from "./scene-transport.ts";
import { createWorldBackendRuntime, captureWorldBackendView, parseWorldBackendView } from "./world-backend.ts";
import type { WorldBackendRuntime, WorldBackendTransport } from "./world-backend.ts";
import type { RenderThreadRuntime, ThreadedBackend } from "./threaded-backend.ts";
import type { ThreadedRendererBackend, ThreadedSourceContext } from "./threaded-backend-proxy.ts";
import { captureUpload, decodeUpload, wireBytes, wireRect } from "./threaded-backend-protocol.ts";
import { decodeImageFrameState, decodeImageUsageState, decodeResourceJournal } from "./renderer-resource-decode.ts";
import { boolean, captureCommands, decodeBackendCounters, decodeCommands, decodeScreenshotParameters, integer, list, numeric, object, restoreCommands, string } from "./threaded-command-codec.ts";

type BackendMaterials = { readonly defaultMaterial: MaterialRecord; readonly flareMaterial: MaterialRecord; readonly sunMaterial: MaterialRecord };
type BackendMaterialHandles = { readonly defaultMaterial: number; readonly flareMaterial: number; readonly sunMaterial: number };
type ScreenshotExecution = Extract<RendererCommandReference, { readonly kind: "screenshot" }>["command"];

export interface ThreadedCommandServices {
  readonly thread: ThreadedBackend;
  readonly backend: ThreadedRendererBackend;
  readonly settings: RendererSettings;
  readonly tess: SourceTessState;
  readonly clock: PictureClock;
  readonly performanceClock: PictureClock;
  readonly temporaryMemory: Pick<HunkArena, "allocateTemp" | "freeTemp">;
  readonly identityLight: () => number;
  readonly backendMaterials: () => BackendMaterials;
  readonly print: (text: string) => undefined;
  readonly debugBuild: boolean;
  readonly showSmp?: () => boolean;
}

function vector(input: unknown): Vec3 {
  const value = object(input);
  return { x: numeric(value["x"]), y: numeric(value["y"]), z: numeric(value["z"]) };
}

/** The frontend retains callbacks and allocation ownership; the worker receives values. */
export class ThreadedCommandBridge implements RendererCommandThread {
  readonly worldTransport: WorldBackendTransport;
  readonly scenes: SceneTransportSender;
  private readonly screenshots = new Map<number, ScreenshotExecution>();
  private readonly presentations = new Map<number, () => undefined>();
  private readonly rawCalls = new Map<number, PreparedUiRawCall>();
  private readonly rawCompletions = new Map<number, UiRawCinematicCall>();
  private readonly temporaries = new Map<number, HunkAllocation>();
  private nextToken = 1;
  private lastReceipt: SubmissionReceipt = { commands: 0, views: 0, batches: 0 };
  private closed = false;

  constructor(private readonly services: ThreadedCommandServices) {
    this.scenes = new SceneTransportSender(services.backend.resources);
    this.worldTransport = {
      capture: (view, range) => captureWorldBackendView(view, this.scenes, range),
      probe: (view, index) => {
        const packet = captureWorldBackendView(view, this.scenes);
        const result = this.call({ kind: "world-probe", view: packet, index });
        if (result === null) return null;
        const value = object(result), axis = list(value["axis"]), plane = object(value["plane"]);
        if (axis.length !== 3) throw new Error("Invalid threaded portal axis");
        return { origin: vector(value["origin"]), axis: [vector(axis[0]), vector(axis[1]), vector(axis[2])],
          pvsOrigin: vector(value["pvsOrigin"]), mirror: boolean(value["mirror"]),
          plane: { normal: vector(plane["normal"]), distance: numeric(plane["distance"]) } };
      },
      initializeSky: height => { this.call({ kind: "world-sky", height }); },
      drawSun: direction => { this.call({ kind: "world-sun", direction }); },
      beginDebugSurface: () => { this.call({ kind: "world-debug-begin" }); },
      debugPolygon: (color, numPoints, points) => { this.call({ kind: "world-debug-polygon", color, numPoints, points }); },
    };
  }

  synchronize(): void { this.services.thread.synchronize(); }
  get retired(): boolean { return this.services.thread.retired; }

  beforeIssue(): void {
    if (this.services.showSmp?.() === true) this.services.print(this.services.thread.active ? "R" : ".");
  }

  close(): undefined {
    if (this.closed) return;
    let failure: { readonly error: unknown } | null = null;
    try { if (!this.services.thread.retired) this.synchronize(); } catch (error: unknown) { failure = { error }; }
    if (!this.services.thread.settled) {
      if (failure !== null) throw failure.error;
      throw new Error("Renderer callback resources remain owned by an unfinished worker");
    }
    for (const [token, allocation] of [...this.temporaries].reverse()) {
      try { this.services.temporaryMemory.freeTemp(allocation); this.temporaries.delete(token); }
      catch (error: unknown) { failure ??= { error }; }
    }
    this.screenshots.clear(); this.presentations.clear(); this.rawCalls.clear(); this.rawCompletions.clear();
    this.closed = true;
    if (failure !== null) throw failure.error;
  }

  retireAfterFailure(): boolean {
    if (!this.services.thread.retireAfterFailure()) return false;
    this.close();
    return true;
  }

  issue(commands: IssuedRendererCommands): SubmissionReceipt {
    this.synchronize();
    this.screenshots.clear();
    this.presentations.clear();
    const captured = captureCommands(commands, {
      resources: this.services.backend.resources, bindings: this.services.backend.bindings,
      screenshot: command => { const token = this.nextToken++; this.screenshots.set(token, command); return token; },
      present: callback => { const token = this.nextToken++; this.presentations.set(token, callback); return token; },
    });
    this.services.thread.issue(this.packet({ kind: "source-commands", commands: captured }));
    return this.lastReceipt;
  }

  private packet(operation: Readonly<Record<string, unknown>>): unknown {
    const resources = this.services.backend.resources;
    const source = operation["kind"] === "world-sky" ? null : this.services.backendMaterials();
    const materials: BackendMaterialHandles | null = source === null ? null : {
      defaultMaterial: resources.materialHandle(source.defaultMaterial), flareMaterial: resources.materialHandle(source.flareMaterial),
      sunMaterial: resources.materialHandle(source.sunMaterial),
    };
    const journal = resources.takeJournal(), world = this.scenes.takeJournal();
    return { ...operation, journal, world, materials, state: resources.captureState() };
  }

  private call(operation: Readonly<Record<string, unknown>>): unknown {
    this.synchronize();
    const response = this.services.thread.call(this.packet(operation));
    this.completed(response);
    return object(response)["value"];
  }

  stretchRaw(rect: Rect2D, call: PreparedUiRawCall): undefined {
    const token = this.nextToken++;
    this.rawCalls.set(token, call);
    this.call({ kind: "source-raw", rect, token, image: this.services.backend.resources.sourceImageHandle(call.image),
      sourceWidth: call.sourceWidth, sourceHeight: call.sourceHeight, uploadWidth: call.uploadWidth, uploadHeight: call.uploadHeight, dirty: call.dirty });
    this.rawCalls.delete(token); this.rawCompletions.delete(token);
  }

  endRegistration(): undefined { this.call({ kind: "source-end-registration" }); }

  completed(payload: unknown): undefined {
    const value = object(payload);
    if (value["kind"] !== "source-result") throw new Error("Unexpected source renderer completion");
    this.services.backend.resources.applyUsage(decodeImageUsageState(value["images"]));
    this.scenes.applyUpdates(parseFrameBackendSnapshots(value["scenes"]));
    Object.assign(this.services.tess.performance.backEnd, decodeBackendCounters(value["counters"]));
    if (value["receipt"] !== null) {
      const receipt = object(value["receipt"]);
      this.lastReceipt = { commands: integer(receipt["commands"]), views: integer(receipt["views"]), batches: integer(receipt["batches"]) };
    }
  }

  request(payload: unknown): unknown {
    const value = object(payload);
    switch (value["kind"]) {
      case "source-clock": return (boolean(value["performance"]) ? this.services.performanceClock : this.services.clock).milliseconds();
      case "source-print": this.services.print(string(value["text"])); return undefined;
      case "source-identity-light": return this.services.identityLight();
      case "source-debug-build": return this.services.debugBuild;
      case "source-setting": {
        const scope = value["scope"], name = string(value["name"]);
        const settings = scope === "runtime" ? this.services.settings.runtime : scope === "rail" ? this.services.settings.rail
          : scope === "flares" ? this.services.settings.flares : null;
        if (settings === null || !Object.hasOwn(settings, name)) throw new Error(`Unknown renderer setting ${String(scope)}.${name}`);
        const result: unknown = Reflect.get(settings, name);
        return result;
      }
      case "source-partial-state": this.completed(value["state"]); return undefined;
      case "source-screenshot": {
        const command = this.screenshots.get(integer(value["token"]));
        if (command === undefined) throw new Error("Unknown renderer screenshot callback");
        command.execute(decodeScreenshotParameters(value["parameters"])); return undefined;
      }
      case "source-present": {
        const callback = this.presentations.get(integer(value["token"]));
        if (callback === undefined) throw new Error("Unknown renderer presentation callback");
        callback(); return undefined;
      }
      case "source-raw-capture": {
        const token = integer(value["token"]), call = this.rawCalls.get(token);
        if (call === undefined || this.rawCompletions.has(token)) throw new Error("Unknown or consumed raw cinematic capture");
        const captured = call.captureAfterBarrier(); this.rawCompletions.set(token, captured);
        return captureUpload(captured.upload, this.services.backend.bindings);
      }
      case "source-raw-complete": {
        const token = integer(value["token"]), call = this.rawCompletions.get(token);
        if (call === undefined) throw new Error("Unknown raw cinematic completion");
        call.afterUiDraw(); this.rawCompletions.delete(token); return undefined;
      }
      case "source-temp-allocate": {
        const token = this.nextToken++, allocation = this.services.temporaryMemory.allocateTemp(integer(value["bytes"]));
        this.temporaries.set(token, allocation); return { token, bytes: new Uint8Array(allocation.bytes) };
      }
      case "source-temp-free": {
        const token = integer(value["token"]), allocation = this.temporaries.get(token);
        if (allocation === undefined) throw new Error("Unknown renderer temporary allocation");
        const bytes = wireBytes(value["bytes"]);
        if (bytes.length !== allocation.bytes.length) throw new Error("Renderer temporary allocation size changed");
        allocation.bytes.set(bytes); this.services.temporaryMemory.freeTemp(allocation); this.temporaries.delete(token); return undefined;
      }
      default: throw new Error("Unknown renderer source callback");
    }
  }
}

function remoteSettings(request: (payload: unknown) => unknown): Pick<RendererSettings, "runtime" | "rail" | "flares"> {
  const get = (scope: string, name: string): unknown => request({ kind: "source-setting", scope, name });
  const n = (name: string): number => numeric(get("runtime", name));
  const b = (name: string): boolean => boolean(get("runtime", name));
  return {
    runtime: {
      get clear() { return b("clear"); }, get smpRequested() { return b("smpRequested"); }, get skipBackEnd() { return b("skipBackEnd"); },
      get finish() { return n("finish"); }, get primitives() { return n("primitives"); }, get debugSort() { return n("debugSort"); },
      get showTris() { return n("showTris"); }, get showNormals() { return n("showNormals"); }, get showImages() { return n("showImages"); },
      get speeds() { return n("speeds"); }, get logFile() { return n("logFile"); }, get measureOverdraw() { return n("measureOverdraw"); },
      get lightmap() { return b("lightmap"); }, get vertexLighting() { return b("vertexLighting"); },
      get polygonOffset() { const v = object(get("runtime", "polygonOffset")); return { factor: numeric(v["factor"]), units: numeric(v["units"]) }; },
      get debugSurface() { return n("debugSurface"); }, get shadows() { return n("shadows"); }, get lodCurveError() { return n("lodCurveError"); },
      get lodBias() { return n("lodBias"); }, get lodScale() { return n("lodScale"); }, get zNear() { return n("zNear"); },
      get noPortals() { return b("noPortals"); }, get portalOnly() { return b("portalOnly"); }, get fastSky() { return n("fastSky"); },
      get showSky() { return n("showSky"); }, get drawSun() { return n("drawSun"); }, get dynamicLights() { return b("dynamicLights"); },
      get noCull() { return b("noCull"); }, get facePlaneCull() { return b("facePlaneCull"); }, get noCurves() { return b("noCurves"); },
      get noRefresh() { return b("noRefresh"); }, get drawEntities() { return b("drawEntities"); }, get developerEnabled() { return b("developerEnabled"); },
      get debugLight() { return b("debugLight"); }, get printShaders() { return b("printShaders"); },
    },
    rail: { get coreWidth() { return numeric(get("rail", "coreWidth")); }, get ringWidth() { return numeric(get("rail", "ringWidth")); },
      get segmentLength() { return numeric(get("rail", "segmentLength")); } },
    flares: { get enabled() { return boolean(get("flares", "enabled")); }, get fade() { return numeric(get("flares", "fade")); },
      get size() { return numeric(get("flares", "size")); } },
  };
}

export function createThreadedCommandRuntime(context: ThreadedSourceContext): RenderThreadRuntime {
  const { resources, images, target, request } = context;
  const tess = new SourceTessState(), scenes = new SceneTransportReceiver(resources), settings = remoteSettings(request);
  const clock: PictureClock = { milliseconds: () => numeric(request({ kind: "source-clock", performance: false })) };
  const print = (text: string): undefined => { request({ kind: "source-print", text }); };
  const commands = new RenderCommandBuffer(target, { tess, runtime: settings.runtime, clock,
    performanceClock: { milliseconds: () => numeric(request({ kind: "source-clock", performance: true })) },
    print, identityLight: 0, temporaryBuffer: size => {
      const result = object(request({ kind: "source-temp-allocate", bytes: size })), token = integer(result["token"]), bytes = wireBytes(result["bytes"]);
      return { bytes, release: () => { request({ kind: "source-temp-free", token, bytes }); } };
    } });
  let backend: WorldBackendRuntime | null = null;
  let materialHandles: BackendMaterialHandles | null = null;
  const material = (name: keyof BackendMaterials): MaterialRecord => {
    if (materialHandles === null) throw new Error("Threaded world backend materials have not been registered");
    return resources.resolveMaterial(materialHandles[name]);
  };
  const worldBackend = (): WorldBackendRuntime => {
    if (backend !== null) return backend;
    const find = (name: string) => images.registeredImages().find(image => image.name === name);
    const fallback = find("*default");
    if (fallback === undefined) throw new Error("Threaded world requires its registered default image");
    backend = createWorldBackendRuntime({ tess, settings, target, print, identityLight: () => numeric(request({ kind: "source-identity-light" })),
      debugBuild: boolean(request({ kind: "source-debug-build" })),
      builtins: { defaultImage: fallback, find(name) {
        const image = find(name);
        return image === undefined ? undefined : { image, mipmap: image.mipmapEnabled, allowPicmip: false, wrap: image.wrapMode === 0x2900 ? "clamp" : "repeat" };
      } },
      get defaultMaterial() { return material("defaultMaterial"); }, get flareMaterial() { return material("flareMaterial"); },
      get sunMaterial() { return material("sunMaterial"); }, materialBySortedIndex: index => resources.materialBySortedIndex(index),
    });
    return backend;
  };
  const result = (receipt: SubmissionReceipt | null, value: unknown): unknown => ({
    kind: "source-result", receipt, value, counters: { ...tess.performance.backEnd },
    images: resources.captureUsage(), scenes: scenes.captureUpdates(),
  });
  return {
    description: null,
    dispatch(input) {
      try {
        const packet = object(input);
        if (packet["materials"] !== null) {
          const value = object(packet["materials"]);
          materialHandles = { defaultMaterial: integer(value["defaultMaterial"]), flareMaterial: integer(value["flareMaterial"]), sunMaterial: integer(value["sunMaterial"]) };
        }
        const journal = decodeResourceJournal(packet["journal"]), state = decodeImageFrameState(packet["state"]);
        resources.applyState(state);
        resources.applyJournal(journal);
        scenes.applyJournal(parseWorldResourceJournal(packet["world"]));
        let receipt: SubmissionReceipt | null = null, value: unknown;
        switch (packet["kind"]) {
          case "source-commands": {
            const source = decodeCommands(packet["commands"]);
            scenes.beginIssue(source.references.flatMap(entry => entry.reference.kind === "prepared-views" ? [entry.reference.view.sceneMemory] : []));
            try {
              receipt = commands.executeIssued(restoreCommands(source, { resources, bindings: context.bindings,
                prepare: view => () => worldBackend().prepare(view, scenes),
                screenshot: token => ({ execute(parameters) {
                  if (parameters === undefined) throw new Error("Worker screenshot requires its source command parameters");
                  request({ kind: "source-screenshot", token, parameters });
                } }),
                present: token => () => { request({ kind: "source-present", token }); },
              }));
            } finally { scenes.endIssue(); }
            break;
          }
          case "source-raw": {
            const token = integer(packet["token"]);
            commands.setIdentityLight(numeric(request({ kind: "source-identity-light" })));
            commands.stretchRaw(wireRect(packet["rect"]), { image: resources.resolveImage(integer(packet["image"])),
              sourceWidth: integer(packet["sourceWidth"]), sourceHeight: integer(packet["sourceHeight"]),
              uploadWidth: integer(packet["uploadWidth"]), uploadHeight: integer(packet["uploadHeight"]), dirty: boolean(packet["dirty"]),
              captureAfterBarrier: () => ({ upload: decodeUpload(request({ kind: "source-raw-capture", token }), context.bindings),
                afterUiDraw: () => { request({ kind: "source-raw-complete", token }); } }),
            });
            break;
          }
          case "source-end-registration": commands.setIdentityLight(numeric(request({ kind: "source-identity-light" }))); commands.endRegistration(); break;
          case "world-probe": {
            const view = parseWorldBackendView(packet["view"]); scenes.beginIssue([view.sceneMemory]);
            try { value = worldBackend().probe(view, integer(packet["index"]), scenes); }
            finally { scenes.endIssue(); }
            break;
          }
          case "world-sky": worldBackend().initializeSky(numeric(packet["height"])); break;
          case "world-sun": target.executeSurfaceOperations(worldBackend().drawSun(vector(packet["direction"]))); break;
          case "world-debug-begin": target.executeSurfaceOperations(worldBackend().beginDebugSurface()); break;
          case "world-debug-polygon": target.executeSurfaceOperations(worldBackend().debugPolygon(numeric(packet["color"]), integer(packet["numPoints"]), list(packet["points"]).map(vector))); break;
          default: throw new Error("Unknown threaded source command");
        }
        return result(receipt, value);
      } catch (error: unknown) {
        try { request({ kind: "source-partial-state", state: result(null, undefined) }); }
        catch { /* The first source failure remains authoritative after partial publication. */ }
        throw error;
      }
    },
    close() { commands.close("discard"); },
  };
}
