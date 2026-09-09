import { describe, expect, test } from "bun:test";
import { AasEntityHistory } from "../src/botlib/entity.ts";
import type { AasEntityInfo, AasEntityMap, BotEntityUpdate } from "../src/botlib/entity.ts";
import { AasSpatial, BotBrushModelTypes } from "../src/botlib/spatial.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { AasLinkHeads, AasLinkHeap } from "../src/botlib/aas-links.ts";
import { BotMemory } from "../src/botlib/memory.ts";
import type { BotMemoryAllocation } from "../src/botlib/memory.ts";
import type { AasSpatialHost, AasBspTrace } from "../src/botlib/spatial.ts";
import type { AasWorld } from "../src/botlib/aas.ts";
import { parseAas } from "../src/botlib/aas.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { add3, length3, vec3 } from "../src/core/math.ts";
import type { Bounds, Vec3 } from "../src/core/math.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";

function linkHeap(memory = new BotMemory()): AasLinkHeap {
  const heap = new AasLinkHeap(() => { throw new Error("Unexpected empty AAS fixture link heap"); }, memory);
  heap.initialize(() => 6144);
  return heap;
}

const zero = vec3(0, 0, 0);
const tiny: Bounds = { min: vec3(-1, -1, -1), max: vec3(1, 1, 1) };

function required<T>(value: T | undefined): T { if (value === undefined) throw new Error("Missing entity test fixture value"); return value; }
function world(): AasWorld {
  const areas = [0, 1, 2].map(areaNumber => ({ areaNumber, faceCount: 0, firstFace: 0, center: zero,
    bounds: { min: vec3(-1000, -1000, -1000), max: vec3(1000, 1000, 1000) } }));
  return { source: "entity-oracle-split", version: 5, bspChecksum: 0, vertices: [],
    planes: [{ normal: vec3(1, 0, 0), distance: 0, type: 0 }, { normal: vec3(-1, 0, 0), distance: 0, type: 0 }],
    nodes: [{ plane: 0, children: [0, 0] }, { plane: 0, children: [-1, -2] }],
    edges: [], edgeIndexes: [], faces: [], faceIndexes: [], areas,
    areaSettings: areas.map(area => ({ contents: 0, flags: area.areaNumber === 1 ? 1 : 0,
      presenceType: area.areaNumber === 0 ? 0 : 6, cluster: 0, clusterAreaNumber: 0,
      reachableAreaCount: 0, firstReachableArea: 0 })),
    reachability: [], portals: [], portalIndex: [], clusters: [], bboxes: [],
    pointArea: point => point.x > 0 ? 1 : 2, areaReachabilities: () => [],
    areaBounds: area => required(areas[area]).bounds };
}
function bsp(): BspMap {
  return { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [], leaves: [], leafSurfaces: [], leafBrushes: [],
    models: [], brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}
function clear(end: Vec3): AasBspTrace { return { end, fraction: 1, entityNum: 1023, solidity: "clear", contact: { kind: "none" }, contents: 0, surfaceFlags: 0 }; }
function state(changes: Partial<BotEntityUpdate> = {}): BotEntityUpdate {
  return { type: 4, flags: 7, solid: 2, origin: vec3(100, 2, 3), angles: zero, oldOrigin: vec3(91, 92, 93),
    mins: tiny.min, maxs: tiny.max, groundEntity: 1022, modelIndex: 1, modelIndex2: 2, frame: 3,
    event: 4, eventParameter: 5, powerups: 6, weapon: 7, legsAnimation: 8, torsoAnimation: 9, ...changes };
}
function rotatedBounds(bounds: Bounds, angles: Vec3): Bounds {
  if (angles.x === 0 && angles.y === 0 && angles.z === 0) return bounds;
  const radius = length3(vec3(Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)),
    Math.max(Math.abs(bounds.min.y), Math.abs(bounds.max.y)), Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z))));
  return { min: vec3(-radius, -radius, -radius), max: vec3(radius, radius, radius) };
}
function fixture(maxEntities = 1024, memory = new BotMemory(), links = linkHeap(memory)) {
  const control: { phase: AasEntityMap; seconds: number; increment: number; frames: number; timeCalls: number;
    boundsCalls: number; boundsFailure: Error | null; traces: number[] } = {
      phase: { kind: "unloaded" }, seconds: 0, increment: 0, frames: 2, timeCalls: 0,
      boundsCalls: 0, boundsFailure: null, traces: [],
    };
  const messages: { severity: number; text: string }[] = [];
  const imports: AasSpatialHost = {
    print: text => { messages.push({ severity: 0, text }); },
    trace: (_start, end) => clear(end), pointContents: () => 0,
    entityTrace: (entity, _start, end) => { control.traces.push(entity); return clear(end); },
    entityModelIndex: entity => history.entityModelIndex(entity),
    modelBounds: (model, angles) => {
      control.boundsCalls++;
      if (control.boundsFailure !== null) throw control.boundsFailure;
      const bounds = { min: vec3(model === 2 ? -40 : -4, -5, -6), max: vec3(model === 2 ? 40 : 4, 5, 6) };
      return { bounds: rotatedBounds(bounds, angles), origin: zero };
    },
  };
  const bspEntities = new AasBspEntities((_severity, text) => { imports.print(text); }, memory), modelTypes = new BotBrushModelTypes();
  bspEntities.load(bsp().entities);
  const spatial = new AasSpatial(world(), bspEntities, imports, DEFAULT_AAS_MOVEMENT_SETTINGS, modelTypes, links, { kind: "disabled" }, () => 0);
  control.phase = { kind: "ready", spatial };
  const history = new AasEntityHistory(maxEntities, { maxEntities, map: () => control.phase, time: () => {
    const value = Math.fround(control.seconds + Math.fround(control.timeCalls * control.increment)); control.timeCalls++; return value;
  }, frameNumber: () => control.frames, print: (severity, text) => { messages.push({ severity, text }); } }, links, memory);
  function members(area: number): readonly number[] {
    control.traces.length = 0;
    spatial.traceClientBBox(vec3(area === 1 ? 100 : -100, 0, 0), vec3(area === 1 ? 100 : -100, 0, 1), 2, 999);
    return [...control.traces];
  }
  return { history, spatial, bspEntities, modelTypes, links, imports, control, messages, members };
}

class EntityMemory extends BotMemory {
  readonly blocks: { readonly size: number; readonly allocation: BotMemoryAllocation }[] = [];
  override allocate(size: number, kind: "heap" | "hunk", clear: boolean): BotMemoryAllocation {
    const block = super.allocate(size, kind, clear);
    this.blocks.push({ size, allocation: block });
    return block;
  }
}

describe("AAS entity source history and actual canonical spatial links", () => {
  test("link cells and heads retain live signed aliases and reject retired hunk storage", () => {
    const arena = new HunkArena(1024 * 1024, () => {});
    const memory = new EntityMemory({ kind: "source-hunk", accounting: new SourceHunkAccounting(arena) });
    const heap = new AasLinkHeap(() => {}, memory);
    heap.initialize(() => 2);
    const first = heap.decode(1), second = heap.decode(2);
    if (first === null || second === null) throw new Error("Missing link cells");
    const heads = heap.createAreaHeads(2);
    const bytes = required(memory.blocks[0]).allocation.bytes;
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    first.entity = 0xffffffff;
    expect(data.getInt32(0, true)).toBe(-1);
    data.setInt32(24 + 4, -17, true);
    expect(second.area).toBe(-17);
    first.nextArea = second;
    heads.set(1, first);
    expect(first.nextArea).toBe(second);
    expect(heads.get(1)).toBe(first);
    heap.initialize(() => { throw new Error("Retained heap reread its capacity"); });
    expect(heap.decode(1)).toBe(first);
    expect(first.entity).toBe(-1);
    expect(first.nextArea).toBe(second);
    arena.clear(null);
    expect(() => first.entity).toThrow("Bot hunk allocation is no longer valid");
    expect(() => { second.area = 1; }).toThrow("Bot hunk allocation is no longer valid");
    expect(() => heads.get(1)).toThrow("Bot hunk allocation is no longer valid");
    expect(() => heads.set(1, first)).toThrow("Bot hunk allocation is no longer valid");
  });
  test("link cell writes resolve bytes after encoding and refresh changed allocation windows", () => {
    const memory = new EntityMemory(), heap = new AasLinkHeap(() => {}, memory);
    heap.initialize(() => 2);
    const first = heap.decode(1), second = heap.decode(2);
    if (first === null || second === null) throw new Error("Missing link cells");
    const allocation = required(memory.blocks[0]).allocation;
    let bytes = allocation.bytes;
    const original = bytes, events: string[] = [];
    Object.defineProperty(allocation, "bytes", { get: () => { events.push("bytes"); return bytes; } });
    const encode = heap.encode.bind(heap);
    heap.encode = link => {
      events.push("encode");
      bytes = new Uint8Array(64).subarray(8, 56);
      return encode(link);
    };
    first.nextArea = second;
    expect(events).toEqual(["encode", "bytes"]);
    expect(new DataView(original.buffer, original.byteOffset, original.byteLength).getInt32(16, true)).toBe(0);
    expect(first.nextArea).toBe(second);
    bytes = new Uint8Array(bytes.buffer, 12, 48);
    first.entity = -19;
    expect(new DataView(bytes.buffer).getInt32(12, true)).toBe(-19);
    bytes = bytes.subarray(0, 4);
    expect(first.entity).toBe(-19);
    expect(() => first.area).toThrow(RangeError);
    expect(() => { first.area = 8; }).toThrow(RangeError);
    const resizable = new ArrayBuffer(48, { maxByteLength: 96 });
    bytes = new Uint8Array(resizable, 0, 48);
    first.entity = -23;
    resizable.resize(24);
    bytes = new Uint8Array(resizable, 0, 24);
    expect(first.entity).toBe(-23);
    expect(() => second.entity).toThrow(RangeError);
    events.length = 0;
    heap.encode = () => { events.push("encode failure"); throw new Error("encode failed"); };
    expect(() => { first.nextArea = second; }).toThrow("encode failed");
    expect(events).toEqual(["encode failure"]);
  });
  test("area head writes retain the pre-encode view across recursive storage replacement", () => {
    const memory = new EntityMemory(), events: string[] = [];
    let recurse = false;
    const heads = new AasLinkHeads(memory, 2, reference => { events.push(`decode ${reference}`); return null; }, () => {
      events.push("encode");
      if (!recurse) {
        recurse = true;
        bytes = new Uint8Array(16).subarray(4, 12);
        heads.set(1, null);
        return -7;
      }
      return -9;
    });
    const allocation = required(memory.blocks[0]).allocation;
    let bytes = allocation.bytes;
    const original = bytes;
    Object.defineProperty(allocation, "bytes", { get: () => { events.push("bytes"); return bytes; } });
    expect(events).toEqual([]);
    heads.set(0, null);
    expect(events).toEqual(["bytes", "encode", "bytes", "encode"]);
    expect(new DataView(original.buffer, original.byteOffset, original.byteLength).getInt32(0, true)).toBe(-7);
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(4, true)).toBe(-9);
    heads.get(1);
    expect(events.slice(-2)).toEqual(["bytes", "decode -9"]);
    heads.free();
    events.length = 0;
    expect(() => heads.set(0, null)).toThrow("AAS area link heads have been freed");
    expect(events).toEqual([]);
  });
  test("entity heads use the actual source record words and reset without freeing per-area links", () => {
    const arena = new HunkArena(1024 * 1024, () => {});
    const memory = new EntityMemory({ kind: "source-hunk", accounting: new SourceHunkAccounting(arena) });
    const { history, links, members } = fixture(4, memory);
    const bytes = required(memory.blocks.find(block => block.size === 4 * 148)).allocation.bytes;
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset = 3 * 148;
    history.update(3, state()); history.update(2, state({ origin: vec3(-100, 2, 3) }));
    expect(data.getInt32(offset + 140, true)).toBe(1);
    expect(data.getInt32(2 * 148 + 140, true)).toBe(2);
    expect(members(1)).toEqual([3]); expect(members(2)).toEqual([2]);
    data.setInt32(offset + 140, 0, true);
    expect(history.bestReachableEntityArea(3)).toBe(0);
    data.setInt32(offset + 140, 2, true);
    expect(history.bestReachableEntityArea(3)).toBe(2);
    history.update(3, null);
    expect(members(1)).toEqual([3]); expect(members(2)).toEqual([]);
    expect(data.getInt32(offset + 140, true)).toBe(0);
    data.setInt32(offset + 140, 6145, true);
    expect(() => history.bestReachableEntityArea(3)).toThrow("AAS link reference exceeds the retained heap");
    for (let entity = 0; entity < 4; entity++) data.setInt32(entity * 148 + 144, 0x10203040, true);
    history.resetEntityLinks();
    for (let entity = 0; entity < 4; entity++) {
      expect(data.getInt32(entity * 148 + 140, true)).toBe(0);
      expect(data.getInt32(entity * 148 + 144, true)).toBe(0);
    }
    expect(links.freeCount).toBe(6143);
    expect(members(1)).toEqual([3]); expect(members(2)).toEqual([]);
    expect(history.entityOrigin(3)).toEqual(vec3(100, 2, 3));
    arena.clear(null);
    expect(() => history.entityAreas(3)).toThrow("Bot hunk allocation is no longer valid");
    expect(() => history.resetEntityLinks()).toThrow("Bot hunk allocation is no longer valid");
  });
  test("BSP leaf null writes occur only after reached relink, null update, and invalid-entity unlink", () => {
    const memory = new EntityMemory(), { history } = fixture(1024, memory);
    const bytes = required(memory.blocks.find(block => block.size === 1024 * 148)).allocation.bytes;
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset = 3 * 148;
    data.setInt32(offset + 144, 17, true);
    history.update(3, state());
    expect(data.getInt32(offset + 144, true)).toBe(0);
    data.setInt32(offset + 144, 23, true);
    history.update(3, state());
    expect(data.getInt32(offset + 144, true)).toBe(23);
    history.update(3, null);
    expect(data.getInt32(offset + 140, true)).toBe(0);
    expect(data.getInt32(offset + 144, true)).toBe(0);
    history.update(3, state({ origin: vec3(-100, 2, 3) }));
    data.setInt32(offset + 144, 29, true);
    history.invalidateEntities(); history.unlinkInvalidEntities();
    expect(data.getInt32(offset + 140, true)).toBe(0);
    expect(data.getInt32(offset + 144, true)).toBe(0);
    data.setInt32(1022 * 148 + 144, 31, true);
    history.update(1022, state());
    expect(data.getInt32(1022 * 148 + 140, true)).toBe(0);
    expect(data.getInt32(1022 * 148 + 144, true)).toBe(31);
  });
  test("link exhaustion publishes a partial head only after return and retains both words on abort", () => {
    for (const abort of [false, true]) {
      const memory = new EntityMemory(), failure = new Error("source empty link heap abort");
      const observations: { readonly areas: number; readonly leaves: number }[] = [];
      const links = new AasLinkHeap(() => {
        observations.push({ areas: data.getInt32(3 * 148 + 140, true), leaves: data.getInt32(3 * 148 + 144, true) });
        if (abort) throw failure;
      }, memory);
      links.initialize(() => 2);
      const { history, members } = fixture(4, memory, links);
      const bytes = required(memory.blocks.find(block => block.size === 4 * 148)).allocation.bytes;
      const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      history.update(1, state()); data.setInt32(3 * 148 + 144, 17, true);
      const update = () => history.update(3, state({ origin: zero }));
      if (abort) expect(update).toThrow(failure);
      else expect(update()).toBe(0);
      expect(observations).toEqual([{ areas: 0, leaves: 17 }]);
      expect(data.getInt32(3 * 148 + 140, true)).toBe(abort ? 0 : 2);
      expect(data.getInt32(3 * 148 + 144, true)).toBe(abort ? 17 : 0);
      expect(history.entityAreas(3)).toEqual(abort ? [] : [2]);
      expect(members(1)).toEqual([1]); expect(members(2)).toEqual([3]);
      expect(links.freeCount).toBe(0); expect(history.info(3).valid).toBe(true);
    }
  });
  test("setup initializes slot numbers and Info is a copied full record", () => {
    const { history } = fixture(4);
    expect(history.info(3)).toEqual({ valid: false, number: 3, type: 0, flags: 0, origin: zero, angles: zero,
      oldOrigin: zero, lastVisibleOrigin: zero, mins: zero, maxs: zero, lastUpdateTime: 0, updateInterval: 0,
      groundEntity: 0, solid: 0, modelIndex: 0, modelIndex2: 0, frame: 0, event: 0, eventParameter: 0,
      powerups: 0, weapon: 0, legsAnimation: 0, torsoAnimation: 0 });
    const first = history.info(3), second = history.info(3);
    expect(first).not.toBe(second); expect(first.origin).not.toBe(second.origin);
    expect(history.entityBspData(3).modelNum).toBe(-1);
  });
  test("incoming oldOrigin differs from prior visible origin; time is read twice in source order", () => {
    const { history, control } = fixture(); control.seconds = 1; control.increment = 0.125;
    history.update(3, state());
    const first = history.info(3);
    expect(first.lastVisibleOrigin).toEqual(zero); expect(first.oldOrigin).toEqual(vec3(91, 92, 93));
    expect(first.updateInterval).toBe(1); expect(first.lastUpdateTime).toBe(1.125); expect(control.timeCalls).toBe(2);
    history.update(3, state({ origin: vec3(-100, 2, 3), oldOrigin: vec3(81, 82, 83) }));
    const second = history.info(3);
    expect(second.lastVisibleOrigin).toEqual(first.origin); expect(second.oldOrigin).toEqual(vec3(81, 82, 83));
    expect(second.updateInterval).toBe(0.125); expect(second.lastUpdateTime).toBe(1.375);
    expect(first.origin).toEqual(vec3(100, 2, 3)); expect(second.number).toBe(3);
  });
  test("null update unlinks but leaves validity and all history untouched; unchanged update does not relink", () => {
    const { history, control } = fixture(); history.update(3, state());
    const before = history.info(3); expect(history.entityAreas(3)).toEqual([1]);
    expect(history.update(3, null)).toBe(0); expect(history.info(3)).toEqual(before);
    expect(history.entityAreas(3)).toEqual([]); expect(history.nextEntity(0)).toBe(3);
    history.update(3, state()); expect(history.entityAreas(3)).toEqual([]);
    control.frames = 1; history.update(3, state()); expect(history.entityAreas(3)).toEqual([1]);
  });
  test("frame start unlinks previous-invalid before invalidating current info", () => {
    const { history, members } = fixture(); history.update(3, state());
    history.unlinkInvalidEntities(); history.invalidateEntities();
    expect(history.info(3).valid).toBe(false); expect(history.entityAreas(3)).toEqual([1]); expect(members(1)).toEqual([3]);
    history.unlinkInvalidEntities(); history.invalidateEntities();
    expect(history.entityAreas(3)).toEqual([]); expect(members(1)).toEqual([]);
    expect(history.info(3).origin).toEqual(vec3(100, 2, 3));
  });
  test("source relink conditions preserve bounds, angles, ordering and first-frame behavior", () => {
    const { history, control, members } = fixture();
    history.update(3, state()); history.update(4, state()); expect(members(1)).toEqual([4, 3]);
    history.update(3, state({ angles: vec3(0, 45, 0) })); expect(members(1)).toEqual([4, 3]);
    history.update(3, state({ mins: vec3(-2, -1, -1) })); expect(members(1)).toEqual([3, 4]);
    history.update(4, state({ solid: 3 })); expect(control.boundsCalls).toBe(1); expect(members(1)).toEqual([3, 4]);
    history.update(4, state({ solid: 3, angles: vec3(0, 90, 0) })); expect(members(1)).toEqual([4, 3]);
    expect(floatWord(history.info(4).maxs.x)).toBe("410c6641");
    history.update(3, state({ mins: vec3(-3, -1, -1) })); expect(members(1)).toEqual([3, 4]);
    history.update(4, state({ solid: 3, angles: vec3(0, 90, 0), modelIndex: 2 }));
    expect(floatWord(history.info(4).maxs.x)).toBe("4223057f"); expect(members(1)).toEqual([3, 4]);
    const before = history.info(4);
    history.update(4, state({ solid: 1, angles: vec3(1, 2, 3), mins: vec3(-99, -99, -99) }));
    expect(history.info(4).angles).toEqual(before.angles); expect(history.info(4).mins).toEqual(before.mins);
    expect(members(1)).toEqual([3, 4]); expect(control.boundsCalls).toBe(3);
  });
  test("input vector components have source float storage before comparisons", () => {
    const { history, members } = fixture();
    const input = state({ origin: { x: 100.1, y: 0.1, z: 0.1 } });
    history.update(3, input); history.update(4, input); expect(members(1)).toEqual([4, 3]);
    history.update(3, input); expect(members(1)).toEqual([4, 3]);
  });
  test("world updates info but only world is excluded from linking; last configured slot remains legal", () => {
    const { history } = fixture(1025);
    for (const entity of [1022, 1023, 1024]) expect(history.update(entity, state())).toBe(0);
    expect(history.entityAreas(1022)).toEqual([]); expect(history.info(1022).valid).toBe(true);
    expect(history.entityAreas(1023)).toEqual([1]); expect(history.entityAreas(1024)).toEqual([1]);
  });
  test("head reset retains old per-area links and duplicate detection but not entity heads", () => {
    const { history, members, control } = fixture(); history.update(3, state());
    expect(history.bestReachableEntityArea(3)).toBe(1); history.resetEntityLinks();
    expect(history.entityAreas(3)).toEqual([]); expect(history.bestReachableEntityArea(3)).toBe(0); expect(members(1)).toEqual([3]);
    control.frames = 1; history.update(3, state()); expect(history.entityAreas(3)).toEqual([]); expect(members(1)).toEqual([3]);
    history.update(3, state({ origin: vec3(-100, 2, 3) })); expect(history.entityAreas(3)).toEqual([2]);
    expect(members(1)).toEqual([3]); expect(members(2)).toEqual([3]);
    history.update(3, null); expect(members(1)).toEqual([3]); expect(members(2)).toEqual([]);
  });
  test("map replacement resets outgoing heads but retains history and does not reset source numframes", () => {
    const { history, bspEntities, modelTypes, links, imports, control } = fixture(); history.update(3, state()); const before = history.info(3);
    history.resetEntityLinks(); control.phase = { kind: "unloaded" };
    expect(history.entityOrigin(3)).toEqual(before.origin); expect(history.entityModelIndex(3)).toBe(1);
    bspEntities.load(bsp().entities);
    links.initialize(() => 6144);
    const replacement = new AasSpatial(world(), bspEntities, imports, DEFAULT_AAS_MOVEMENT_SETTINGS, modelTypes, links, { kind: "disabled" }, () => 0);
    control.phase = { kind: "loaded", spatial: replacement }; expect(history.update(3, state())).toBe(0);
    expect(history.entityAreas(3)).toEqual([]); control.phase = { kind: "ready", spatial: replacement };
    expect(history.info(3).lastVisibleOrigin).toEqual(before.origin); expect(history.entityAreas(3)).toEqual([]);
    history.update(3, state({ origin: vec3(101, 2, 3) })); expect(history.entityAreas(3)).toEqual([1]);
    expect(control.frames).toBe(2);
  });
  test("import failure retains preceding source mutations without committing later origin/bounds/link work", () => {
    const { history, control } = fixture(); history.update(3, state());
    const failure = new Error("actual model import failed"); control.boundsFailure = failure; control.seconds = 2;
    expect(() => history.update(3, state({ solid: 3, modelIndex: 2, origin: vec3(-100, 0, 0), angles: vec3(0, 90, 0) }))).toThrow(failure);
    const info = history.info(3); expect(info.valid).toBe(true); expect(info.modelIndex).toBe(2); expect(info.solid).toBe(3);
    expect(info.lastUpdateTime).toBe(2); expect(info.angles).toEqual(vec3(0, 90, 0)); expect(info.origin).toEqual(vec3(100, 2, 3));
    expect(info.mins).toEqual(tiny.min); expect(history.entityAreas(3)).toEqual([1]);
  });
});

describe("AAS entity query gates, enumeration and explicit undefined boundaries", () => {
  test("loaded and initialized gates differ and occur before index consumption", () => {
    const { history, control, spatial, messages } = fixture(4); control.phase = { kind: "unloaded" };
    expect(history.update(4, state())).toBe(3); expect(history.nextEntity(2147483647)).toBe(0);
    expect(history.info(4).number).toBe(0); expect(history.entityType(4)).toBe(0); expect(history.entityModelNum(4)).toBe(0);
    expect(history.entitySize(4)).toBeNull(); expect(history.entityModelIndex(4)).toBe(0); expect(history.entityOrigin(4)).toEqual(zero);
    expect(messages).toEqual([{ severity: 1, text: "AAS_UpdateEntity: not loaded\n" },
      { severity: 4, text: "AAS_EntityInfo: aasworld not initialized\n" },
      { severity: 4, text: "AAS_EntityModelindex: entnum 4 out of range\n" }, { severity: 4, text: "AAS_EntityOrigin: entnum 4 out of range\n" }]);
    control.phase = { kind: "loaded", spatial }; expect(history.update(3, state())).toBe(0);
    expect(history.entityOrigin(3)).toEqual(vec3(100, 2, 3)); expect(history.entityModelIndex(3)).toBe(1);
    expect(history.entityType(3)).toBe(0); expect(history.nextEntity(0)).toBe(3);
    control.phase = { kind: "ready", spatial }; expect(history.entityType(3)).toBe(4); expect(history.entityModelNum(3)).toBe(1);
  });
  test("initialized invalid queries preserve zero versus untouched-output results and exact diagnostics", () => {
    const { history, messages } = fixture(4);
    expect(history.info(-1).number).toBe(0); expect(history.entityOrigin(-1)).toEqual(zero);
    expect(history.entityModelIndex(-1)).toBe(0); expect(history.entityType(-1)).toBe(0); expect(history.entityModelNum(-1)).toBe(0);
    expect(history.entitySize(-1)).toBeNull(); expect(history.originOfMoverWithModelNum(9)).toBeNull();
    expect(messages.map(message => message.text)).toEqual(["AAS_EntityInfo: entnum -1 out of range\n", "AAS_EntityOrigin: entnum -1 out of range\n",
      "AAS_EntityModelindex: entnum -1 out of range\n", "AAS_EntityType: entnum -1 out of range\n", "AAS_EntityModelNum: entnum -1 out of range\n", "AAS_EntitySize: entnum -1 out of range\n"]);
  });
  test("enumeration starts after predecessor, includes source slot0 ambiguity and uses valid only", () => {
    const { history, control, spatial } = fixture(5); history.update(0, state()); history.update(2, state()); history.update(4, state());
    expect(history.nextEntity(-9)).toBe(0); expect(history.nextEntity(0)).toBe(2); expect(history.nextEntity(2)).toBe(4);
    expect(history.nextEntity(4)).toBe(0); expect(history.nextEntity(5)).toBe(0);
    history.update(2, null); expect(history.nextEntity(0)).toBe(2);
    history.invalidateEntities(); expect(history.nextEntity(0)).toBe(0);
    control.phase = { kind: "loaded", spatial }; expect(history.originOfMoverWithModelNum(1)).toEqual(vec3(100, 2, 3));
    control.phase = { kind: "unloaded" }; expect(history.originOfMoverWithModelNum(1)).toEqual(vec3(100, 2, 3));
  });
  test("nearest uses truncating int abs, full 3D distance, first tie, and no validity/readiness gate", () => {
    const { history, control } = fixture(4);
    history.update(2, state({ modelIndex: 7, origin: vec3(39.9, 0, 0) }));
    expect(history.nearestEntity(zero, 7)).toBe(2);
    history.update(1, state({ modelIndex: 7, origin: vec3(-39.9, 0, 0) }));
    expect(history.nearestEntity(zero, 7)).toBe(1);
    history.update(1, state({ modelIndex: 7, origin: vec3(-39.9, 0, 50) })); expect(history.nearestEntity(zero, 7)).toBe(2);
    history.update(2, state({ modelIndex: 7, origin: vec3(40, 0, 0) })); expect(history.nearestEntity(zero, 7)).toBe(1);
    history.invalidateEntities(); history.resetEntityLinks(); control.phase = { kind: "unloaded" };
    expect(history.nearestEntity(zero, 7)).toBe(1);
  });
  test("BSP data uses stored bounds and model index minus one, independently of initialization", () => {
    const { history, control } = fixture(4); history.update(3, state()); history.resetEntityLinks(); control.phase = { kind: "unloaded" };
    expect(history.entityBspData(3)).toEqual({ origin: vec3(100, 2, 3), angles: zero,
      absoluteBounds: { min: vec3(99, 1, 2), max: vec3(101, 3, 4) }, solid: 2, modelNum: 0 });
  });
  test("approved source-undefined indexes and preincrement reject only after source gates", () => {
    const { history } = fixture(4);
    expect(() => history.update(4, null)).toThrow("source entity allocation");
    expect(() => history.update(-1, state())).toThrow("source entity allocation");
    expect(() => history.entityBspData(4)).toThrow("source entity allocation");
    expect(() => history.bestReachableEntityArea(4)).toThrow("source entity allocation");
    expect(() => history.nextEntity(2147483647)).toThrow("overflow INT_MAX");
    history.update(3, state({ modelIndex: -2147483648 }));
    expect(history.entityModelIndex(3)).toBe(-2147483648);
    expect(() => history.entityBspData(3)).toThrow("overflow INT_MIN");
  });
  test("nearest UB guards follow model mismatch and prior-axis rejection", () => {
    const { history } = fixture(2);
    expect(history.nearestEntity(vec3(Infinity, NaN, 0), 99)).toBe(0);
    expect(history.nearestEntity(vec3(1000, NaN, 0), 0)).toBe(0);
    expect(() => history.nearestEntity(vec3(-2147483648, 0, 0), 0)).toThrow("float-to-int conversion");
    expect(() => history.nearestEntity(vec3(2147483648, 0, 0), 0)).toThrow("abs(INT_MIN)");
    expect(() => history.nearestEntity(vec3(0, Infinity, 0), 0)).toThrow("float-to-int conversion");
  });
  test("independent AAS setup owners never share history or link state", () => {
    const left = fixture(), right = fixture(); left.history.update(3, state());
    expect(right.history.info(3).valid).toBe(false); expect(right.history.entityAreas(3)).toEqual([]);
    left.history.resetEntityLinks(); expect(right.history.info(3).origin).toEqual(zero);
  });
});

function floatWord(value: number): string {
  const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true).toString(16).padStart(8, "0");
}
function infoWords(info: AasEntityInfo): string {
  const int = (value: number) => (value >>> 0).toString(16).padStart(8, "0");
  const fields = [int(info.valid ? 1 : 0), int(info.type), int(info.flags), floatWord(info.lastUpdateTime), floatWord(info.updateInterval), int(info.number)];
  for (const vector of [info.origin, info.angles, info.oldOrigin, info.lastVisibleOrigin, info.mins, info.maxs]) fields.push(floatWord(vector.x), floatWord(vector.y), floatWord(vector.z));
  fields.push(...[info.groundEntity, info.solid, info.modelIndex, info.modelIndex2, info.frame, info.event,
    info.eventParameter, info.powerups, info.weapon, info.legsAnimation, info.torsoAnimation].map(int));
  return fields.join(" ");
}
const nativePath = process.env["Q3_AAS_ENTITY_ORACLE"];
test.skipIf(nativePath === undefined)("unchanged original entity + AAS link functions agree on every info word and link trace", () => {
  if (nativePath === undefined) throw new Error("Q3_AAS_ENTITY_ORACLE is required");
  const native = Bun.spawnSync([nativePath], { stdout: "pipe", stderr: "pipe" });
  expect(native.exitCode).toBe(0); expect(native.stderr.toString()).toBe("");
  const { history, control, members } = fixture();
  const rows = ["profile int=4 char_min=-128 float=4 double=8 FLT_EVAL_METHOD=0 info=140"];
  const emit = (name: string, entity: number) => {
    const areas = history.entityAreas(entity);
    rows.push(`${name} ${infoWords(history.info(entity))} links${areas.map(area => ` ${area}`).join("")} calls ${control.boundsCalls} ${control.timeCalls}`);
  };
  const memberRow = (name: string, area: number) => rows.push(`${name}${members(area).map(entity => ` ${entity}`).join("")}`);
  let input = state(); emit("zero", 3); control.seconds = 1; control.increment = 0.125;
  history.update(3, input); emit("first", 3); history.update(3, null); emit("null", 3);
  history.update(3, input); emit("unchanged-unlinked", 3); control.frames = 1;
  history.update(3, input); emit("forced-first-frame", 3); control.frames = 2;
  history.invalidateEntities(); emit("invalid", 3); memberRow("invalid-still-linked", 1);
  history.unlinkInvalidEntities(); emit("missed-unlinked", 3);
  input = { ...input, origin: vec3(-100, 2, 3) }; history.update(3, input); emit("moved", 3);
  input = { ...input, solid: 3, angles: vec3(0, 90, 0) }; history.update(3, input); emit("rotated", 3);
  input = { ...input, modelIndex: 2 }; history.update(3, input); emit("model-only", 3);
  input = { ...input, solid: 1, mins: vec3(-99, -99, -99), angles: vec3(1, 2, 3) }; history.update(3, input); emit("trigger-retains", 3);
  input = state(); history.update(1023, input); emit("last-slot", 1023); history.update(1022, input); emit("world-slot", 1022);
  memberRow("before-head-reset", 1); history.resetEntityLinks(); memberRow("after-head-reset", 1);
  rows.push(`best-after-reset ${history.bestReachableEntityArea(1023)}`); control.frames = 1;
  history.update(1023, input); emit("duplicate-skip", 1023); memberRow("after-duplicate", 1);
  expect(rows).toEqual(native.stdout.toString().trimEnd().split("\n"));
});

test.skipIf(nativePath === undefined)("unchanged original query functions agree on gates, output preservation and nearest selection", () => {
  if (nativePath === undefined) throw new Error("Q3_AAS_ENTITY_ORACLE is required");
  const native = Bun.spawnSync([nativePath, "queries"], { stdout: "pipe", stderr: "pipe" });
  expect(native.exitCode).toBe(0); expect(native.stderr.toString()).toBe("");
  const { history, control, spatial, messages } = fixture();
  const rows: string[] = [];
  const vector = (value: Vec3) => [value.x, value.y, value.z].map(floatWord).join(" ");
  const emit = (row: string) => {
    rows.push(...messages.splice(0).map(message => `diagnostic ${message.severity} ${message.text.trimEnd()}`), row);
  };
  const queryRecord = (name: string, entity: number) => {
    emit(`${name}-info ${infoWords(history.info(entity))}`);
    emit(`${name}-origin ${vector(history.entityOrigin(entity))}`);
    emit(`${name}-index ${history.entityModelIndex(entity)}`);
    emit(`${name}-type ${history.entityType(entity)}`);
    emit(`${name}-model ${history.entityModelNum(entity)}`);
    const bounds = history.entitySize(entity) ?? { min: vec3(9, 9, 9), max: vec3(8, 8, 8) };
    emit(`${name}-size ${vector(bounds.min)} ${vector(bounds.max)}`);
  };
  const queryMover = (name: string, model: number) => {
    const origin = history.originOfMoverWithModelNum(model);
    emit(`${name} ${origin === null ? 0 : 1} ${vector(origin ?? vec3(9, 9, 9))}`);
  };
  let input = state(); history.update(3, input);
  input = { ...input, origin: vec3(-10, 2, 3) }; history.update(0, input);
  queryRecord("ready", 3); queryRecord("invalid", -1);
  queryMover("mover-first", 1); queryMover("mover-missing", 99);
  control.phase = { kind: "loaded", spatial };
  queryRecord("loading", 3); queryRecord("loading-invalid", -1);
  emit(`next-loaded ${history.nextEntity(-9)} ${history.nextEntity(0)} ${history.nextEntity(3)} ${history.nextEntity(1024)}`);
  history.update(3, null); emit(`next-null ${history.nextEntity(0)}`);
  history.invalidateEntities(); emit(`next-invalid ${history.nextEntity(0)}`); queryMover("mover-invalid", 1);
  control.phase = { kind: "unloaded" }; emit(`next-unloaded ${history.nextEntity(2147483647)}`);
  queryMover("mover-unloaded", 1); emit(`update-unloaded ${history.update(1024, input)}`);
  const data = history.entityBspData(3);
  emit(`bsp-unloaded ${[data.origin, data.angles, data.absoluteBounds.min, data.absoluteBounds.max].map(vector).join(" ")} ${data.solid} ${data.modelNum}`);
  emit(`bsp-zero-model ${history.entityBspData(1).modelNum}`);
  control.phase = { kind: "loaded", spatial };
  input = { ...input, modelIndex: 7, origin: vec3(39.9, 0, 0) }; history.update(2, input);
  emit(`nearest-fraction ${history.nearestEntity(zero, 7)}`);
  input = { ...input, origin: vec3(-39.9, 0, 0) }; history.update(1, input);
  emit(`nearest-tie ${history.nearestEntity(zero, 7)}`);
  input = { ...input, origin: vec3(-39.9, 0, 50) }; history.update(1, input);
  emit(`nearest-height ${history.nearestEntity(zero, 7)}`);
  input = { ...input, origin: vec3(40, 0, 0) }; history.update(2, input);
  emit(`nearest-integer ${history.nearestEntity(zero, 7)}`);
  history.invalidateEntities(); history.resetEntityLinks(); control.phase = { kind: "unloaded" };
  emit(`nearest-unloaded ${history.nearestEntity(zero, 7)}`);
  expect(rows).toEqual(native.stdout.toString().trimEnd().split("\n"));
});

const dataPath = process.env["Q3_DATA"];
test.skipIf(dataPath === undefined)("retail q3dm7/mpteam1 observations use canonical AAS links and real collision/model bounds", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const cases: ReadonlyArray<readonly ["baseq3" | "missionpack", string]> = [["baseq3", "q3dm7"], ["missionpack", "mpteam1"]];
  for (const [product, name] of cases) {
    const files = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    {
      const aas = parseAas(await files.read(`maps/${name}.aas`)), map = parseBsp(await files.read(`maps/${name}.bsp`));
      const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
      const traces: number[] = [];
      const host: AasSpatialHost = {
        print: text => { throw new Error(text); },
        trace: (start, end, bounds, _pass, mask) => ({ ...collision.trace({ start, end, mask,
          shape: bounds === null ? { kind: "point" } : { kind: "box", mins: bounds.min, maxs: bounds.max } }), entityNum: 1022 }),
        pointContents: point => collision.pointContents(point), entityModelIndex: entity => history.entityModelIndex(entity),
        entityTrace: (entity, start, end, bounds, mask) => {
          traces.push(entity); const current = history.info(entity);
          return { ...collision.transformedTrace({ start, end, mask, modelIndex: current.modelIndex,
            shape: { kind: "box", mins: bounds.min, maxs: bounds.max } }, current.origin, current.angles), entityNum: entity };
        },
        modelBounds: (model, angles) => ({ bounds: rotatedBounds(collision.modelBounds(model), angles), origin: zero }),
      };
      const bspEntities = new AasBspEntities((_severity, text) => { host.print(text); });
      bspEntities.load(map.entities);
      const links = linkHeap();
      const spatial = new AasSpatial(aas, bspEntities, host, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), links, { kind: "disabled" }, () => 0);
      const history = new AasEntityHistory(1024, { maxEntities: 1024, map: () => ({ kind: "ready", spatial }), time: () => 1, frameNumber: () => 1,
        print: (_severity, text) => { throw new Error(text); } }, links);
      const area = required(aas.areas.find(area => area.areaNumber > 0 && (required(aas.areaSettings[area.areaNumber]).presenceType & 2) !== 0));
      const center = area.center;
      const input = state({ solid: 3, modelIndex: 1, origin: center, angles: vec3(0, 45, 0) });
      history.update(70, input); const info = history.info(70), bounds = host.modelBounds(1, input.angles).bounds;
      expect(info.mins).toEqual(bounds.min); expect(info.maxs).toEqual(bounds.max);
      const expectedAreas = spatial.clientBBoxAreas({ min: add3(center, bounds.min), max: add3(center, bounds.max) }, 2);
      expect(history.entityAreas(70)).toEqual(expectedAreas); expect(expectedAreas.length).toBeGreaterThan(0);
      spatial.traceClientBBox(center, vec3(center.x, center.y, center.z + 1), 2, 0); expect(traces).toContain(70);
      history.update(70, null); traces.length = 0; spatial.traceClientBBox(center, vec3(center.x, center.y, center.z + 1), 2, 0);
      expect(traces).not.toContain(70); expect(history.info(70).valid).toBe(true);
    }
  }
});
