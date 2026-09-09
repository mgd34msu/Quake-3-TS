import { describe, expect, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap, BspNode, BspPlane } from "../src/assets/bsp.ts";
import { Pk3Archive } from "../src/assets/pk3.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import type { TraceQuery, TraceShape } from "../src/collision/world.ts";
import { radiusFromBounds, vec3 } from "../src/core/math.ts";
import type { Bounds, Vec3 } from "../src/core/math.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { ServerWorld, ServerWorldSectors } from "../src/server/world.ts";
import { EntityShared } from "../src/shared/entity-shared.ts";
import type { SharedEntity } from "../src/shared/entity-shared.ts";
import { EntityState } from "../src/shared/entity-state.ts";
import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from "../src/shared/player-state.ts";
import { EntityPool } from "../src/game/entities.ts";
import type { Product } from "../src/shared/definitions.ts";
import { borrowQvmSharedEntity, QVM_SHARED_ENTITY_BYTES } from "../src/vm/shared-entity-record.ts";

const BODY = 0x2000000;
const worldBounds: Bounds = { min: vec3(-1024, -1024, -1024), max: vec3(1024, 1024, 1024) };

function emptyMap(): BspMap {
  return {
    entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds: worldBounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds: worldBounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null,
  };
}

function entity(number: number, origin = vec3(0, 0, 0), bounds: Bounds = { min: vec3(-10, -10, -10), max: vec3(10, 10, 10) }): { readonly s: EntityState; readonly r: EntityShared } {
  const s = new EntityState(), r = new EntityShared();
  s.number = number;
  s.origin = origin;
  r.currentOrigin = origin;
  r.mins = bounds.min;
  r.maxs = bounds.max;
  r.contents = BODY;
  r.ownerNum = ENTITYNUM_NONE;
  return { s, r };
}

function setup(map = emptyMap()): { world: ServerWorld; entities: Map<number, SharedEntity>; collision: CollisionWorld } {
  const entities = new Map<number, SharedEntity>();
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const worldPrints: string[] = [];
  const world = new ServerWorld(collision, collision.modelBounds(0), number => entities.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  return { world, entities, collision };
}

function inlineMap(): BspMap {
  const map = emptyMap();
  const bounds = { min: vec3(-10, -2, -3), max: vec3(10, 2, 3) };
  const planes: BspPlane[] = [
    { normal: vec3(1, 0, 0), distance: 10 }, { normal: vec3(-1, 0, 0), distance: 10 },
    { normal: vec3(0, 1, 0), distance: 2 }, { normal: vec3(0, -1, 0), distance: 2 },
    { normal: vec3(0, 0, 1), distance: 3 }, { normal: vec3(0, 0, -1), distance: 3 },
  ];
  return { ...map, shaders: [{ name: "inline", surfaceFlags: 8, contentFlags: 1 }], planes,
    models: [...map.models, { bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_, plane) => ({ plane, shader: 0 })) };
}

function areaMap(areas: readonly number[]): BspMap {
  const map = emptyMap(), leaf = map.leaves[0];
  if (leaf === undefined) throw new Error("missing area leaf fixture");
  const planes: BspPlane[] = [], nodes: BspNode[] = [];
  for (let index = 0; index < areas.length - 1; index++) {
    planes.push({ normal: vec3(1, 0, 0), distance: 1 });
    nodes.push({ plane: index, children: [-index - 1, index === areas.length - 2 ? -areas.length : index + 1], bounds: worldBounds });
  }
  return { ...map, planes, nodes, leaves: areas.map(area => ({ ...leaf, area })) };
}

describe("engine-owned source sector membership", () => {
  test("64 slots retain source parent/front/back allocation and actual linked heads across clears", () => {
    const sectors = new ServerWorldSectors(), entities = new Map<number, SharedEntity>();
    expect(sectors.sectorCounts()).toEqual(Array<number>(64).fill(0));
    const collision = new CollisionWorld(emptyMap(), { kind: "unaccounted" }, { kind: "disabled" });
    const worldPrints: string[] = [];
    const world = new ServerWorld(collision, worldBounds, number => entities.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } }, sectors);
    let number = 0;
    for (const y of [768, 256, -256, -768]) for (const x of [768, 256, -256, -768]) {
      const target = entity(number++, vec3(x, y, 0)); entities.set(target.s.number, target); world.link(target);
    }
    const expected = Array<number>(64).fill(0);
    for (const slot of [4, 5, 7, 8, 11, 12, 14, 15, 19, 20, 22, 23, 26, 27, 29, 30]) expected[slot] = 1;
    expect(sectors.sectorCounts()).toEqual(expected);
    for (const slot of [20, 21, 22]) { const target = entity(slot); entities.set(slot, target); world.link(target); }
    expected[0] = 3; expect(sectors.sectorCounts()).toEqual(expected);
    expect(world.areaEntities(worldBounds).slice(0, 3)).toEqual([22, 21, 20]);
    world.unlink(21); world.unlink(22); world.unlink(22);
    expected[0] = 1; expect(sectors.sectorCounts()).toEqual(expected);
    const middle = entities.get(21); if (middle === undefined) throw new Error("Missing real linked entity");
    world.link(middle); expected[0] = 2; expect(sectors.sectorCounts()).toEqual(expected);
    sectors.clearServer(); expected[0] = 1; expect(sectors.sectorCounts()).toEqual(expected);
    sectors.clearServer(); expect(sectors.sectorCounts()).toEqual(expected);

    // Reusing the retained head cell changes the old head's chain too, proving identity.
    middle.r.currentOrigin = vec3(768, 768, 0); world.link(middle);
    expected[0] = 2; expected[4] = 2; expect(sectors.sectorCounts()).toEqual(expected);
    sectors.clearServer(); expected[0] = 1; expected[4] = 1; expect(sectors.sectorCounts()).toEqual(expected);
    sectors.clearWorld(worldBounds); expect(sectors.sectorCounts()).toEqual(Array<number>(64).fill(0));
    world.clear(); expect(world.linkState(21)).toBeUndefined();
    expect(world.areaEntities(worldBounds)).toEqual([]);
    expect(new ServerWorldSectors().sectorCounts()).toEqual(Array<number>(64).fill(0));
  });

  test("capacity stops only the current sector and still resolves a parent's next sibling", () => {
    const entities = new Map<number, SharedEntity>(), calls: number[] = [];
    const collision = new CollisionWorld(emptyMap(), { kind: "unaccounted" }, { kind: "disabled" });
    const worldPrints: string[] = [];
    const world = new ServerWorld(collision, worldBounds, number => { calls.push(number); return entities.get(number); }, { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
    for (const [number, origin] of [[1, vec3(0, 500, 0)], [2, vec3(0, 500, 0)],
      [3, vec3(0, 500, 0)], [4, vec3(0, -500, 0)], [5, vec3(0, -500, 0)]] satisfies readonly (readonly [number, Vec3])[]) {
      const target = entity(number, origin); entities.set(number, target); world.link(target);
    }
    calls.length = 0;
    expect(world.areaEntities(worldBounds, 1)).toEqual([3]);
    expect(calls).toEqual([3, 2, 5]);
    expect(worldPrints).toEqual(["SV_AreaEntities: MAXCOUNT\n", "SV_AreaEntities: MAXCOUNT\n"]);
    calls.length = 0;
    worldPrints.length = 0;
    expect(world.areaEntities(worldBounds, 0)).toEqual([]);
    expect(calls).toEqual([3, 5]);
    expect(worldPrints).toEqual(["SV_AreaEntities: MAXCOUNT\n", "SV_AreaEntities: MAXCOUNT\n"]);
  });

  test("MAXCOUNT follows intersection and overflow lookup, with no print at exact capacity", () => {
    const entities = new Map<number, SharedEntity>(), events: (number | string)[] = [];
    const collision = new CollisionWorld(emptyMap(), { kind: "unaccounted" }, { kind: "disabled" });
    const world = new ServerWorld(collision, worldBounds,
      number => { events.push(number); return entities.get(number); }, { loading: false, print: text => { events.push(text); }, developerPrint: text => { events.push(text); } });
    const query = { min: vec3(-1024, -1024, -10), max: vec3(1024, 1024, 10) };
    expect(world.areaEntities(query, 0)).toEqual([]); expect(events).toEqual([]);
    const excluded = entity(2, vec3(0, 0, 100)), accepted = entity(3);
    entities.set(2, excluded); world.link(excluded); entities.set(3, accepted); world.link(accepted);
    events.length = 0;
    expect(world.areaEntities(query, 1)).toEqual([3]); expect(events).toEqual([3, 2]);
    const overflow = entity(1), child = entity(4, vec3(0, 500, 0));
    world.clear(); entities.set(1, overflow); entities.set(4, child);
    world.link(overflow); world.link(excluded); world.link(accepted); world.link(child);
    events.length = 0;
    expect(world.areaEntities(query, 1)).toEqual([3]);
    expect(events).toEqual([3, 2, 1, "SV_AreaEntities: MAXCOUNT\n"]);
  });

  test("candidate traversal captures the next actual cell before an unlinking visitor", () => {
    const sectors = new ServerWorldSectors(), bounds = { min: vec3(-1, -1, -1), max: vec3(1, 1, 1) };
    sectors.clearWorld(worldBounds); sectors.link(1, bounds); sectors.link(2, bounds); sectors.link(3, bounds);
    const seen: number[] = [];
    sectors.visitCandidates(worldBounds, number => { seen.push(number); sectors.unlink(number); return "continue"; });
    expect(seen).toEqual([3, 2, 1]); expect(sectors.sectorCounts()).toEqual(Array<number>(64).fill(0));
  });

  test("area publication precedes later shared reads and keeps prior writes on output failure", () => {
    const { world, entities } = setup();
    const storage = new DataView(new ArrayBuffer(QVM_SHARED_ENTITY_BYTES));
    const second = borrowQvmSharedEntity(storage);
    second.s.number = 2; second.r.mins = vec3(-10, -10, -10); second.r.maxs = vec3(10, 10, 10);
    for (const target of [entity(1), second, entity(3)]) {
      entities.set(target.s.number, target); world.link(target);
    }
    const point = { min: vec3(0, 0, 0), max: vec3(0, 0, 0) };
    const aliased = new DataView(storage.buffer, 464, 8);
    expect(world.areaEntitiesInto(point, 2, (number, index) => { aliased.setInt32(index * 4, number, true); })).toBe(2);
    expect(aliased.getInt32(0, true)).toBe(3); expect(aliased.getInt32(4, true)).toBe(1);
    expect(second.r.absmin.x).toBeGreaterThan(0);
    second.r.absmin = vec3(-11, -11, -11);
    const shortOutput = new DataView(new ArrayBuffer(8));
    expect(() => world.areaEntitiesInto(point, 3,
      (number, index) => { shortOutput.setInt32(index * 4, number, true); })).toThrow(RangeError);
    expect(shortOutput.getInt32(0, true)).toBe(3); expect(shortOutput.getInt32(4, true)).toBe(2);
    const unbounded: number[] = [];
    expect(world.areaEntitiesInto(point, -1, number => { unbounded.push(number); })).toBe(3);
    expect(unbounded).toEqual([3, 2, 1]);
  });

  test("world-only clear preserves game fields and warns before relinking retained membership", () => {
    const sectors = new ServerWorldSectors(), target = entity(7), prints: string[] = [];
    const collision = new CollisionWorld(emptyMap(), { kind: "unaccounted" }, { kind: "disabled" });
    let reentered = false;
    const world: ServerWorld = new ServerWorld(collision, worldBounds, number => number === 7 ? target : undefined, { loading: false, print: text => {
      prints.push(text);
      expect(target.r.linked).toBe(false); expect(target.r.linkcount).toBe(1);
      expect(target.r.absmin).toEqual(vec3(-11, -11, -11));
      if (!reentered) {
        reentered = true;
        target.r.currentOrigin = vec3(768, 768, 0); world.link(target);
        target.r.currentOrigin = vec3(-768, -768, 0);
      }
    }, developerPrint: text => { prints.push(text); } }, sectors);
    world.link(target);
    sectors.clearWorld(worldBounds);
    expect(target.r.linked).toBe(true); expect(target.r.linkcount).toBe(1);
    expect(world.areaEntities(worldBounds)).toEqual([]);
    target.r.currentOrigin = vec3(100, 100, 100);
    const linked = world.link(target);
    expect(prints).toEqual(["WARNING: SV_UnlinkEntity: not found in worldSector\n"]);
    expect(linked.linked).toBe(true); expect(linked.linkcount).toBe(3);
    expect(target.r.absmin).toEqual(vec3(-779, -779, -11));
    expect(sectors.sectorCounts()[4]).toBe(1); expect(sectors.sectorCounts()[30]).toBe(1);
    expect(world.areaEntities(worldBounds)).toEqual([7, 7]);
    expect(world.areaEntities(linked.absbounds)).toEqual([7]);
  });
});

describe("SV_ClipToEntity standalone source operation", () => {
  const query: Omit<TraceQuery, "modelIndex"> = {
    start: vec3(20, 0, 0), end: vec3(0, 0, 0), shape: { kind: "point" }, mask: BODY,
  };

  test("validates slot indices before lookup and unavailable storage after one lookup", () => {
    const calls: number[] = [], collision = new CollisionWorld(emptyMap(), { kind: "unaccounted" }, { kind: "disabled" });
    const worldPrints: string[] = [];
    const world = new ServerWorld(collision, worldBounds, number => { calls.push(number); return undefined; }, { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
    for (const number of [-1, 1024, 1.5, NaN, Infinity]) {
      expect(() => world.traceEntity(number, query)).toThrow(RangeError);
      expect(calls).toEqual([]);
    }
    expect(() => world.traceEntity(7, query)).toThrow(RangeError);
    expect(calls).toEqual([7]);
  });

  test("mask rejection publishes source zero fields before invalid geometry is visited", () => {
    const { world, entities } = setup(), target = entity(7);
    entities.set(7, target); target.s.modelindex = 99; target.r.model = { kind: "inline", index: 99 }; target.r.contents = 1;
    const invalid: Omit<TraceQuery, "modelIndex"> = { ...query, start: vec3(NaN, 0, 0),
      shape: { kind: "box", mins: vec3(2, 0, 0), maxs: vec3(1, 0, 0) } };
    const rejected = world.traceEntity(7, invalid);
    expect(rejected).toEqual({ fraction: 1, end: vec3(0, 0, 0), solidity: "clear", contact: { kind: "none" },
      entityNum: 0, contents: 0, surfaceFlags: 0 });
    expect(rejected.end).not.toBe(query.end);
    expect(world.traceEntity(7, invalid)).not.toBe(rejected);
    expect(() => world.traceEntity(7, { ...query, mask: 1 })).toThrow();
    target.r.model = { kind: "box" }; target.r.mins = vec3(20, 0, 0);
    expect(world.traceEntity(7, { ...query, mask: BODY | 1 })).toEqual(rejected);
    target.r.mins = vec3(NaN, 0, 0);
    expect(world.traceEntity(7, invalid)).toEqual(rejected);
    expect(() => world.traceEntity(7, { ...query, mask: BODY | 1 })).toThrow();
  });

  test("unlinked point, asymmetric box and capsule sweeps retain existing source endpoints", () => {
    const { world, entities } = setup(), target = entity(91); entities.set(7, target);
    const cases: readonly { shape: TraceShape; end: number }[] = [
      { shape: { kind: "point" }, end: 10.125 },
      { shape: { kind: "box", mins: vec3(-3, -2, -2), maxs: vec3(1, 2, 2) }, end: 13.125 },
      { shape: { kind: "capsule", mins: vec3(-2, -2, -6), maxs: vec3(2, 2, 6) }, end: 12.125 },
    ];
    for (const entry of cases) {
      const hit = world.traceEntity(7, { ...query, shape: entry.shape });
      expect(hit.end.x).toBe(entry.end); expect(hit.entityNum).toBe(91);
      expect(hit.contents).toBe(BODY); expect(hit.contact.kind).toBe("plane");
    }
    expect(world.linkState(7)).toBeUndefined();
    for (const slot of [ENTITYNUM_WORLD, ENTITYNUM_NONE]) {
      entities.set(slot, target); expect(world.traceEntity(slot, query).entityNum).toBe(91);
    }
  });

  test("standalone miss/exit remain entity zero while all-solid has no invented plane", () => {
    const { world, entities } = setup(); entities.set(7, entity(7));
    const end = { x: 30, y: 0, z: 0 }, miss = world.traceEntity(7, { ...query, end });
    expect(miss).toEqual({ fraction: 1, end, solidity: "clear", contact: { kind: "none" },
      contents: 0, surfaceFlags: 0, entityNum: 0 });
    end.x = 40; expect(miss.end.x).toBe(30);
    const exit = world.traceEntity(7, { ...query, start: vec3(0, 0, 0), end: vec3(30, 0, 0) });
    expect(exit.fraction).toBe(1); expect(exit.solidity).toBe("start-solid"); expect(exit.entityNum).toBe(0);
    expect(exit.contact).toEqual({ kind: "none" });
    const trapped = world.traceEntity(7, { ...query, start: vec3(0, 0, 0) });
    expect(trapped.fraction).toBe(0); expect(trapped.solidity).toBe("all-solid"); expect(trapped.entityNum).toBe(7);
    expect(trapped.contact).toEqual({ kind: "none" });
    const hit = world.traceEntity(7, query), second = world.traceEntity(7, query);
    expect(hit.end).not.toBe(second.end); expect(hit.contact).not.toBe(second.contact);
    if (hit.contact.kind !== "plane" || second.contact.kind !== "plane") throw new Error("Expected brush plane");
    expect(hit.contact.plane).not.toBe(second.contact.plane);
    expect(hit.contact.plane.normal).not.toBe(second.contact.plane.normal);
    expect(second.contact.plane.normal.x).toBe(1);
  });

  test("current shared state is read anew without relinking or storing hulls", () => {
    const { world, entities } = setup(), initial = entity(7), slot = { s: initial.s, r: initial.r };
    entities.set(7, slot); const linked = world.link(slot);
    expect(world.traceEntity(7, query).end.x).toBe(10.125);
    slot.r.currentOrigin = vec3(-100, 0, 0);
    expect(world.traceEntity(7, query).fraction).toBe(1);
    slot.r = entity(7, vec3(5, 0, 0)).r;
    expect(world.traceEntity(7, query).end.x).toBe(15.125);
    expect(linked.absbounds).toEqual({ min: vec3(-11, -11, -11), max: vec3(11, 11, 11) });
  });

  test("outer entity contents and inner temporary BODY contents are both enforced", () => {
    const { world, entities } = setup(), target = entity(7); target.r.contents = 1; entities.set(7, target);
    expect(world.traceEntity(7, { ...query, mask: BODY }).end).toEqual(vec3(0, 0, 0));
    const innerMiss = world.traceEntity(7, { ...query, end: vec3(1, 0, 0), mask: 1 });
    expect(innerMiss.fraction).toBe(1); expect(innerMiss.end).toEqual(vec3(1, 0, 0)); expect(innerMiss.entityNum).toBe(0);
    expect(world.traceEntity(7, { ...query, mask: BODY | 1 }).end.x).toBe(10.125);
  });

  test("inline brush transforms use current origin and angles", () => {
    const { world, entities } = setup(inlineMap()), target = entity(7);
    target.s.modelindex = 1; target.r.model = { kind: "inline", index: 1 }; target.r.contents = 1;
    target.r.currentOrigin = vec3(100, 0, 0); target.r.currentAngles = vec3(0, 90, 0);
    target.s.origin = vec3(-500, 0, 0); target.s.angles = vec3(90, 0, 0); entities.set(7, target);
    const hit = world.traceEntity(7, { ...query, start: vec3(100, 20, 0), end: vec3(100, 0, 0), mask: 1 });
    expect(hit.end.y).toBe(10.125); expect(hit.entityNum).toBe(7); expect(hit.surfaceFlags).toBe(8); expect(hit.contents).toBe(1);
  });

  test("inline collision reads the live network model index without relinking", () => {
    const { world, entities, collision } = setup(inlineMap());
    const target = entity(7, vec3(100, 0, 0), collision.modelBounds(1));
    target.r.model = { kind: "inline", index: 0 }; target.r.contents = 1;
    target.s.modelindex = 1; entities.set(7, target); world.link(target);
    const move = { start: vec3(120, 0, 0), end: vec3(100, 0, 0),
      shape: { kind: "point" }, mask: 1, passEntityNum: ENTITYNUM_NONE } satisfies Parameters<ServerWorld["trace"]>[0];
    const contact = { min: vec3(104, -1, -1), max: vec3(106, 1, 1) };
    expect(world.traceEntity(7, move).end.x).toBe(110.125);
    expect(world.trace(move).entityNum).toBe(7);
    expect(world.entityContact(contact, target)).toBe(true);
    expect(world.pointContents(vec3(105, 0, 0), ENTITYNUM_NONE)).toBe(1);
    target.s.modelindex = 0;
    expect(world.traceEntity(7, move).fraction).toBe(1);
    expect(world.trace(move).entityNum).toBe(ENTITYNUM_NONE);
    expect(world.entityContact(contact, target)).toBe(false);
    expect(world.pointContents(vec3(105, 0, 0), ENTITYNUM_NONE)).toBe(0);
    expect(target.r.linkcount).toBe(1); expect(target.r.model).toEqual({ kind: "inline", index: 0 });
    target.s.modelindex = 1;
    expect(world.traceEntity(7, move).end.x).toBe(110.125);
    expect(world.entityContact(contact, target)).toBe(true);
    expect(world.pointContents(vec3(105, 0, 0), ENTITYNUM_NONE)).toBe(1);
  });

  test("temporary box/capsule target angles are suppressed, preserving the owned capsule profile", () => {
    const { world, entities } = setup(), target = entity(7, vec3(0, 0, 0),
      { min: vec3(-5, -5, -20), max: vec3(5, 5, 20) }); entities.set(7, target);
    const moving: Omit<TraceQuery, "modelIndex"> = { ...query, start: vec3(30, 0, 0),
      shape: { kind: "capsule", mins: vec3(-2, -2, -6), maxs: vec3(2, 2, 6) } };
    for (const kind of ["box", "capsule"] satisfies readonly ("box" | "capsule")[]) {
      target.r.model = { kind }; target.r.currentAngles = vec3(0, 0, 0);
      const upright = world.traceEntity(7, moving); target.r.currentAngles = vec3(90, 0, 0);
      expect(world.traceEntity(7, moving)).toEqual(upright);
      expect(upright.entityNum).toBe(7); expect(upright.fraction).toBeLessThan(1);
      world.link(target);
      expect(world.trace({ ...moving, passEntityNum: ENTITYNUM_NONE })).toEqual(upright);
    }
  });

  test("full-world trace retains one broadphase and one narrow-phase resolver observation", () => {
    const target = entity(7), observations: number[] = [];
    const collision = new CollisionWorld(emptyMap(), { kind: "unaccounted" }, { kind: "disabled" });
    const worldPrints: string[] = [];
    const world = new ServerWorld(collision, worldBounds, number => { observations.push(number); return number === 7 ? target : undefined; }, { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
    world.link(target); observations.length = 0;
    expect(world.trace({ ...query, passEntityNum: ENTITYNUM_NONE }).entityNum).toBe(7);
    expect(observations).toEqual([7, 7]); observations.length = 0;
    expect(world.traceEntity(7, query).entityNum).toBe(7); expect(observations).toEqual([7]);
  });

  test("shared clipping preserves newest-first equal impacts and filtered aggregate NONE", () => {
    const { world, entities } = setup();
    for (const number of [7, 8]) {
      const target = entity(number); entities.set(number, target); world.link(target);
    }
    const hit = world.trace({ ...query, passEntityNum: ENTITYNUM_NONE });
    expect(hit.entityNum).toBe(8); expect(hit.end.x).toBe(10.125);
    const end = vec3(3, 0, 0);
    expect(world.trace({ ...query, end, mask: 1, passEntityNum: ENTITYNUM_NONE }))
      .toEqual({ fraction: 1, end, entityNum: ENTITYNUM_NONE, solidity: "clear", contact: { kind: "none" }, contents: 0, surfaceFlags: 0 });
  });

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product} real stable entity pool resolves freed/reused shared records`, () => {
      const collision = new CollisionWorld(emptyMap(), { kind: "unaccounted" }, { kind: "disabled" });
      const pool = new EntityPool({ print: text => { worldPrints.push(text); }, product, maxClients: 1, mapStartTime: 0, time: () => 0,
        link: entity => { world.link(entity); }, unlink: entity => { world.unlink(entity.slot); } });
      const worldPrints: string[] = [];
      const world = new ServerWorld(collision, worldBounds, number => pool.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
      const target = pool.spawn(); target.r = entity(target.slot).r; world.link(target);
      const first = world.traceEntity(target.slot, query); expect(first.entityNum).toBe(target.slot);
      const shared = target.r;
      pool.free(target); expect(world.traceEntity(target.slot, query).entityNum).toBe(0);
      expect(shared.linked).toBe(false); expect(shared.linkcount).toBe(1);
      expect(target.r.linked).toBe(false); expect(target.r.linkcount).toBe(0);
      expect(target.r.absmin).toEqual(vec3(0, 0, 0)); expect(target.r.absmax).toEqual(vec3(0, 0, 0));
      const reused = pool.spawn(); expect(reused).toBe(target);
      reused.r = entity(reused.slot, vec3(5, 0, 0)).r;
      expect(world.traceEntity(reused.slot, query).end.x).toBe(15.125);
      expect(first.end.x).toBe(10.125); expect(world.linkState(reused.slot)?.linked).toBe(false);
    });
  }
});

describe("SV_LinkEntity and source area sectors", () => {
  test("third-area warnings respect live loading and developer integer gates with source area replacement", () => {
    const target = entity(7), prints: string[] = [], developerCalls: string[] = [], cvars = new CvarRegistry();
    const collision = new CollisionWorld(areaMap([-1, 1, 1, 2, 2, 1, 3, 3, 2, 4]), { kind: "unaccounted" }, { kind: "disabled" });
    let loading = false;
    const world = new ServerWorld(collision, worldBounds, number => number === 7 ? target : undefined, {
      get loading() { return loading; }, print: text => { prints.push(text); },
      developerPrint: text => {
        developerCalls.push(text);
        const developer = cvars.get("developer");
        if (developer !== undefined && developer.integerValue !== 0) prints.push(text);
      },
    });
    const warning = "Object 7 touching 3 areas at -11.000000 -11.000000 -11.000000\n";
    for (const active of [false, true, false, true]) for (const developer of ["0", "0.5", "1", "-1"]) {
      loading = active; cvars.set("developer", developer); prints.length = 0; developerCalls.length = 0;
      const linked = world.link(target);
      expect(linked.areanum).toBe(1); expect(linked.areanum2).toBe(4); expect(linked.linked).toBe(true);
      expect(developerCalls).toEqual(active ? [warning, warning, warning] : []);
      expect(prints).toEqual(active && (developer === "1" || developer === "-1") ? [warning, warning, warning] : []);
    }
  });

  test("third-area callbacks observe prior metadata and an abort prevents the overwrite and final link", () => {
    const target = entity(7), prints: string[] = [];
    const collision = new CollisionWorld(areaMap([1, 2, 3]), { kind: "unaccounted" }, { kind: "disabled" });
    const world: ServerWorld = new ServerWorld(collision, worldBounds, number => number === 7 ? target : undefined, {
      loading: true, print: text => { prints.push(text); }, developerPrint: text => {
        prints.push(text);
        expect(world.linkState(7)?.areanum).toBe(1); expect(world.linkState(7)?.areanum2).toBe(2);
        expect(world.linkState(7)?.clusters).toEqual([]); expect(target.r.linked).toBe(false); expect(target.r.linkcount).toBe(0);
        expect(target.r.absmin).toEqual(vec3(-11, -11, -11));
        throw new Error("source diagnostic abort");
      },
    });
    expect(() => world.link(target)).toThrow("source diagnostic abort");
    expect(prints).toEqual(["Object 7 touching 3 areas at -11.000000 -11.000000 -11.000000\n"]);
    expect(world.linkState(7)?.areanum2).toBe(2); expect(world.areaEntities(worldBounds)).toEqual([]);
  });

  test("third-area loading is sampled again after a diagnostic changes host state", () => {
    const target = entity(7), prints: string[] = [];
    const collision = new CollisionWorld(areaMap([1, 2, 3, 4]), { kind: "unaccounted" }, { kind: "disabled" });
    let loading = true, samples = 0;
    const world = new ServerWorld(collision, worldBounds, number => number === 7 ? target : undefined, {
      get loading() { samples++; return loading; }, print: text => { prints.push(text); },
      developerPrint: text => { prints.push(text); loading = false; },
    });
    const linked = world.link(target);
    expect(samples).toBe(2); expect(prints).toEqual(["Object 7 touching 3 areas at -11.000000 -11.000000 -11.000000\n"]);
    expect(linked.areanum).toBe(1); expect(linked.areanum2).toBe(4); expect(linked.linkcount).toBe(1);
  });

  test("third-area diagnostic reads current shared fields and formats source binary32 ties to even", () => {
    const target = entity(7, vec3(11.0078125, 11.0234375, 10.9921875)), prints: string[] = [];
    const collision = new CollisionWorld(areaMap([1, 2, 3, 4]), { kind: "unaccounted" }, { kind: "disabled" });
    const world = new ServerWorld(collision, worldBounds, number => number === 7 ? target : undefined, {
      loading: true, print: text => { prints.push(text); }, developerPrint: text => {
        prints.push(text);
        target.s.number = 8; target.r.absmin = vec3(-0, 0.0234375, -0.0234375);
      },
    });
    world.link(target);
    expect(prints).toEqual([
      "Object 7 touching 3 areas at 0.007812 0.023438 -0.007812\n",
      "Object 8 touching 3 areas at -0.000000 0.023438 -0.023438\n",
    ]);
  });

  test("area portals use passed entity numbers and retained server metadata", () => {
    const map = emptyMap(), leaf = map.leaves[0];
    if (leaf === undefined) throw new Error("missing portal leaf fixture");
    const { world, entities, collision } = setup({ ...map,
      planes: [{ normal: vec3(1, 0, 0), distance: 0 }],
      nodes: [{ plane: 0, children: [-1, -2], bounds: worldBounds }],
      leaves: [{ ...leaf, area: 0 }, { ...leaf, area: 1 }] });
    const door = entity(7); entities.set(7, door); world.link(door);
    entities.delete(7);
    expect(collision.areasConnected(0, 1)).toBe(false);
    world.adjustAreaPortalState(entity(7), true);
    expect(collision.areasConnected(0, 1)).toBe(true);
    world.adjustAreaPortalState(entity(7), false);
    expect(collision.areasConnected(0, 1)).toBe(false);
    const singleArea = entity(8, vec3(100, 0, 0)); world.link(singleArea);
    expect(() => world.adjustAreaPortalState(singleArea, false)).not.toThrow();
    const untouched = entity(9);
    expect(() => world.adjustAreaPortalState(untouched, false)).toThrow("negative reference count");
    // The failed source close retains both writes to the same area-pair cell.
    world.adjustAreaPortalState(untouched, true);
    world.adjustAreaPortalState(untouched, true); world.adjustAreaPortalState(untouched, false);
    expect(world.linkState(9)).toBeUndefined();
  });

  test("passed shared records retain their storage after the numbered game table relocates", () => {
    const bytes = new Uint8Array(2 * QVM_SHARED_ENTITY_BYTES);
    const originalView = new DataView(bytes.buffer, 0, QVM_SHARED_ENTITY_BYTES);
    const currentView = new DataView(bytes.buffer, QVM_SHARED_ENTITY_BYTES, QVM_SHARED_ENTITY_BYTES);
    const original = borrowQvmSharedEntity(originalView), replacement = borrowQvmSharedEntity(currentView);
    original.s.number = 7; original.r.mins = vec3(-10, -10, -10); original.r.maxs = vec3(10, 10, 10);
    original.r.contents = BODY;
    replacement.s.number = 7; replacement.r.linked = true; replacement.r.linkcount = 90;
    replacement.r.absmin = vec3(300, 300, 300); replacement.r.absmax = vec3(302, 302, 302);
    let current = original;
    const lookups: number[] = [], collision = new CollisionWorld(emptyMap(), { kind: "unaccounted" }, { kind: "disabled" });
    const world = new ServerWorld(collision, worldBounds, number => {
      lookups.push(number); return number === 7 ? current : undefined;
    }, { loading: false, print: () => undefined, developerPrint: () => undefined });
    world.link(original);
    current = replacement;
    const linked = world.link(original);
    expect(lookups).toEqual([]);
    expect(originalView.getInt32(416, true)).toBe(1); expect(originalView.getInt32(420, true)).toBe(2);
    expect(originalView.getFloat32(464, true)).toBe(-11); expect(original.s.solid).toBe((42 << 16) | (10 << 8) | 10);
    expect(currentView.getInt32(416, true)).toBe(1); expect(currentView.getInt32(420, true)).toBe(90);
    expect(currentView.getFloat32(464, true)).toBe(300); expect(replacement.s.solid).toBe(0);
    expect(linked.linkcount).toBe(2); expect(world.linkState(7)?.linkcount).toBe(90);
    expect(world.areaEntities(linked.absbounds)).toEqual([]);
    expect(world.areaEntities({ min: replacement.r.absmin, max: replacement.r.absmax })).toEqual([7]);
    lookups.length = 0;
    world.unlinkEntity(original);
    expect(lookups).toEqual([]); expect(originalView.getInt32(416, true)).toBe(0);
    expect(currentView.getInt32(416, true)).toBe(1); expect(world.areaEntities(worldBounds)).toEqual([]);
    world.link(original); replacement.s.number = 8;
    lookups.length = 0;
    world.unlink(7);
    expect(lookups).toEqual([7]); expect(currentView.getInt32(416, true)).toBe(0);
    expect(originalView.getInt32(416, true)).toBe(1);
    expect(world.areaEntities(worldBounds)).toEqual([7]);
    world.unlinkEntity(original); expect(world.areaEntities(worldBounds)).toEqual([]);
  });

  test("source shared numbers accept WORLD and NONE and reject numbers outside the fixed table", () => {
    const { world, entities } = setup();
    for (const number of [ENTITYNUM_WORLD, ENTITYNUM_NONE]) {
      const target = entity(number); entities.set(number, target);
      expect(world.link(target).linked).toBe(true); expect(world.areaEntities(worldBounds)).toEqual([number]);
      world.unlinkEntity(target); expect(target.r.linked).toBe(false);
      expect(world.areaEntities(worldBounds)).toEqual([]);
    }
    for (const number of [-1, 1024, 1.5, NaN, Infinity]) {
      const target = entity(number); target.r.linked = true;
      expect(() => world.link(target)).toThrow("SV_SvEntityForGentity: bad gEnt");
      expect(() => world.unlinkEntity(target)).toThrow("SV_SvEntityForGentity: bad gEnt");
      let failure: unknown;
      try { world.link(target); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "drop", message: "SV_SvEntityForGentity: bad gEnt" });
      expect(target.r.linked).toBe(true); expect(target.r.linkcount).toBe(0);
    }
  });

  test("linking keeps inline model indexes unused until collision consumes them", () => {
    const { world, entities } = setup(), target = entity(7);
    entities.set(7, target);
    const query: Omit<TraceQuery, "modelIndex"> = {
      start: vec3(20, 0, 0), end: vec3(0, 0, 0), shape: { kind: "point" }, mask: BODY,
    };
    for (const index of [0, 99]) {
      target.s.modelindex = index;
      target.r.model = { kind: "inline", index };
      const linked = world.link(target);
      expect(linked.linked).toBe(true); expect(target.s.solid).toBe(0xffffff);
      expect(target.r.absmin).toEqual(vec3(-11, -11, -11));
      expect(world.areaEntities(worldBounds)).toEqual([7]);
      expect(world.traceEntity(7, { ...query, mask: 1 }).fraction).toBe(1);
      if (index === 0) expect(world.traceEntity(7, query).fraction).toBe(1);
      else expect(() => world.traceEntity(7, query)).toThrow(RangeError);
    }
    expect(target.r.linkcount).toBe(2);
  });

  test("linking an inline model preserves game-owned network model state", () => {
    const { world, entities } = setup(), target = entity(7);
    target.r.model = { kind: "inline", index: 99 };
    target.s.modelindex = 42; target.s.modelindex2 = 73;
    entities.set(7, target);
    world.link(target);
    expect(target.s.solid).toBe(0xffffff);
    expect(target.s.modelindex).toBe(42); expect(target.s.modelindex2).toBe(73);
    target.s.modelindex = 43; target.r.currentOrigin = vec3(200, 0, 0);
    world.link(target);
    expect(target.s.modelindex).toBe(43); expect(target.s.modelindex2).toBe(73);
    expect(world.areaEntities({ min: vec3(199, -1, -1), max: vec3(201, 1, 1) })).toEqual([7]);
  });

  test("reads current shared fields and unlinks even without a sector", () => {
    const { world, entities } = setup(), target = entity(7);
    entities.set(7, target);
    expect(target.r.linked).toBe(false); expect(target.r.linkcount).toBe(0);
    expect(target.r.absmin).toEqual(vec3(0, 0, 0)); expect(target.r.absmax).toEqual(vec3(0, 0, 0));
    target.r.linked = true; target.r.linkcount = 40;
    world.unlink(7);
    expect(target.r.linked).toBe(false); expect(target.r.linkcount).toBe(40);
    expect(world.linkState(7)).toBeUndefined();
    const linked = world.link(target);
    expect(target.r.linked).toBe(true); expect(target.r.linkcount).toBe(41);
    expect(target.r.absmin).toEqual(linked.absbounds.min); expect(target.r.absmax).toEqual(linked.absbounds.max);
    const min = { x: 400, y: 400, z: 400 }, max = { x: 402, y: 402, z: 402 };
    target.r.absmin = min; target.r.absmax = max; target.r.linked = false; target.r.linkcount = 73;
    const changed = world.linkState(7);
    expect(changed?.linked).toBe(false); expect(changed?.linkcount).toBe(73);
    expect(changed?.absbounds).toEqual({ min, max });
    expect(changed?.absbounds.min).not.toBe(min); expect(changed?.absbounds.max).not.toBe(max);
    expect(world.areaEntities(linked.absbounds)).toEqual([]);
    expect(world.areaEntities({ min, max })).toEqual([7]);
    min.x = 399; expect(changed?.absbounds.min.x).toBe(400);
    expect(world.linkState(7)?.absbounds.min.x).toBe(399);
    expect(linked.linkcount).toBe(41); expect(linked.linked).toBe(true);
    expect(world.link(target).linkcount).toBe(74);
    target.r.linkcount = 0x7fffffff;
    expect(world.link(target).linkcount).toBe(-0x80000000);
  });

  test("publishes shared bounds before leaf selection and preserves no-leaves link state", () => {
    const { world, entities, collision } = setup(), target = entity(7);
    entities.set(7, target); world.link(target);
    target.r.currentOrigin = vec3(100, 100, 100); target.r.contents = 0;
    const queryLeaves = collision.boxLeafnums.bind(collision);
    const expected = { min: vec3(89, 89, 89), max: vec3(111, 111, 111) };
    collision.boxLeafnums = (bounds, capacity) => {
      expect(capacity).toBe(128); expect(target.s.solid).toBe(0);
      expect(target.r.absmin).toEqual(expected.min); expect(target.r.absmax).toEqual(expected.max);
      expect(bounds).toEqual(expected);
      expect(world.linkState(7)?.clusters).toEqual([]); expect(world.linkState(7)?.areanum).toBe(-1);
      return queryLeaves(bounds, 0);
    };
    const outside = world.link(target);
    expect(outside.linked).toBe(false); expect(outside.linkcount).toBe(1);
    expect(target.r.linked).toBe(false); expect(target.r.linkcount).toBe(1);
    expect(world.areaEntities(worldBounds)).toEqual([]);
    target.r.linked = true; target.r.linkcount = 28;
    expect(world.link(target).linked).toBe(true); expect(target.r.linkcount).toBe(28);
    expect(world.areaEntities(worldBounds)).toEqual([]);
    world.unlink(7); expect(target.r.linked).toBe(false);
    collision.boxLeafnums = (bounds, capacity) => {
      const leaves = queryLeaves(bounds, capacity);
      target.r.linkcount = 50;
      return leaves;
    };
    expect(world.link(target).linkcount).toBe(51); expect(target.r.linked).toBe(true);
  });

  test("source shared-state memset resets link lifetime without replacing the stable game record", () => {
    const { world, entities } = setup();
    const initial = entity(7, vec3(100, 100, 100));
    const slot = { s: initial.s, r: initial.r }; entities.set(7, slot);
    const published = world.link(slot); expect(world.link(slot).linkcount).toBe(2);
    const oldShared = slot.r; world.unlink(7);
    const unlinked = world.linkState(7);
    expect(unlinked?.linkcount).toBe(2); expect(unlinked?.absbounds).toEqual(published.absbounds);
    slot.s = new EntityState(); slot.r = new EntityShared();
    const freed = world.linkState(7);
    expect(freed?.linked).toBe(false); expect(freed?.linkcount).toBe(0);
    expect(freed?.absbounds).toEqual({ min: vec3(0, 0, 0), max: vec3(0, 0, 0) });
    expect(freed?.clusters).toEqual(published.clusters); expect(freed?.areanum).toBe(published.areanum);
    expect(freed?.clusters).not.toBe(published.clusters);
    expect(world.areaEntities(worldBounds)).toEqual([]);
    expect(published.linkcount).toBe(1); expect(published.linked).toBe(true);
    expect(published.absbounds.min).toEqual(vec3(89, 89, 89));
    slot.s.number = 7; slot.r.currentOrigin = vec3(-100, 0, 0);
    expect(slot.r).not.toBe(oldShared); expect(world.link(slot).linkcount).toBe(1);
    world.unlink(7); expect(world.link(slot).linkcount).toBe(2);
    expect(world.linkState(7)?.linkcount).toBe(2);
  });

  test("links padded absolute bounds, relinks in new sector, unlinks and allows game deletion", () => {
    const { world, entities } = setup();
    const box = entity(7, vec3(100, 100, 0));
    entities.set(7, box);
    const first = world.link(box);
    expect(first.linked).toBe(true);
    expect(first.linkcount).toBe(1);
    expect(first.absbounds).toEqual({ min: vec3(89, 89, -11), max: vec3(111, 111, 11) });
    expect(world.areaEntities({ min: vec3(111, 111, 11), max: vec3(111, 111, 11) })).toEqual([7]);
    const oldRegion = first.absbounds;
    box.r.currentOrigin = vec3(-700, -700, 0);
    const second = world.link(box);
    expect(second.linkcount).toBe(2);
    expect(second.absbounds.min.x).toBe(-711);
    expect(second.absbounds.max.x).toBe(-689);
    expect(world.areaEntities(oldRegion)).toEqual([]);
    expect(world.areaEntities(second.absbounds)).toEqual([7]);
    world.unlink(7);
    world.unlink(7);
    expect(box.r.linked).toBe(false);
    entities.delete(7);
    expect(world.linkState(7)).toBeUndefined();
    expect(world.areaEntities(worldBounds)).toEqual([]);
    const replacement = entity(7);
    entities.set(7, replacement);
    expect(world.link(replacement).linkcount).toBe(1);
    world.clear();
    expect(world.linkState(7)).toBeUndefined();
    expect(replacement.r.linked).toBe(true); expect(replacement.r.linkcount).toBe(1);
    expect(replacement.r.absmin).toEqual(vec3(-11, -11, -11));
    expect(world.areaEntities(worldBounds)).toEqual([]);
    expect(world.link(replacement).linkcount).toBe(2);
  });

  test("sector order preserves newest-first lists and front-before-back recursion", () => {
    const { world, entities } = setup();
    for (const [number, position] of [[1, vec3(500, 500, 0)], [2, vec3(-500, -500, 0)], [3, vec3(0, 0, 0)], [4, vec3(0, 0, 0)]] satisfies readonly (readonly [number, Vec3])[]) {
      const box = entity(number, position); entities.set(number, box); world.link(box);
    }
    expect(world.areaEntities(worldBounds)).toEqual([4, 3, 1, 2]);
    expect(world.areaEntities(worldBounds, 2)).toEqual([4, 3]);
    expect(world.areaEntities(worldBounds, 0)).toEqual([]);
    expect(() => world.areaEntities(worldBounds, -1)).toThrow();
    expect(() => world.areaEntities({ min: vec3(2, 0, 0), max: vec3(1, 0, 0) })).toThrow();
  });

  test("source solid encoding truncates and clamps dimensions; trigger boxes stay zero", () => {
    const { world, entities } = setup();
    const box = entity(1, vec3(0, 0, 0), { min: vec3(-400, -400, -2.9), max: vec3(400, 400, 400) });
    entities.set(1, box); world.link(box);
    expect(box.s.solid).toBe((255 << 16) | (2 << 8) | 255);
    expect(box.s.solid).toBe(16712447);
    box.r.mins = vec3(-1, -1, -40); box.r.maxs = vec3(0.9, 1, -35);
    world.link(box);
    expect(box.s.solid).toBe((1 << 16) | (40 << 8) | 1);
    box.r.contents = 0x40000000;
    world.link(box);
    expect(box.s.solid).toBe(0);
  });

  test("rotated inline bounds use RadiusFromBounds while ordinary boxes ignore angles", () => {
    const map = inlineMap(), { world, entities } = setup(map);
    const bounds = map.models[1]?.bounds;
    if (bounds === undefined) throw new Error("missing inline fixture");
    const inline = entity(1, vec3(100, 0, 0), bounds);
    inline.s.modelindex = 1;
    inline.r.model = { kind: "inline", index: 1 };
    inline.r.currentAngles = vec3(0, 90, 0);
    entities.set(1, inline);
    const linked = world.link(inline), radius = radiusFromBounds(bounds);
    expect(linked.absbounds.min.x).toBe(Math.fround(Math.fround(100 - radius) - 1));
    expect(linked.absbounds.max.z).toBe(Math.fround(radius + 1));
    // Untouched sv_world.c + q_math.c, GCC -O0 native fixture on this source commit.
    expect(linked.absbounds.min.x).toBe(Math.fround(88.3698578));
    expect(linked.absbounds.max.z).toBe(Math.fround(11.630146));
    expect(inline.s.solid).toBe(0xffffff);
    expect(inline.s.modelindex).toBe(1);
    inline.r.model = { kind: "box" };
    expect(world.link(inline).absbounds).toEqual({ min: vec3(89, -3, -4), max: vec3(111, 3, 4) });
  });

  test("cluster lists preserve duplicates, both areas and source last-cluster overflow", () => {
    const original = emptyMap();
    const leaf = original.leaves[0];
    if (leaf === undefined) throw new Error("missing leaf fixture");
    const leaves = Array.from({ length: 140 }, (_, i) => ({ ...leaf, cluster: i === 0 ? 0 : i - 1, area: i === 0 ? 1 : 2 }));
    const planes: BspPlane[] = [], nodes: BspNode[] = [];
    // Every plane splits the same broad entity bounds. Leaves visit in index order.
    for (let i = 0; i < 139; i++) {
      planes.push({ normal: vec3(1, 0, 0), distance: 0 });
      nodes.push({ plane: i, children: [-1 - i, i === 138 ? -140 : i + 1], bounds: worldBounds });
    }
    const { world, entities } = setup({ ...original, leaves, planes, nodes });
    const box = entity(1); entities.set(1, box);
    const state = world.link(box);
    expect(state.clusters).toEqual([0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(state.lastCluster).toBe(138);
    expect(state.areanum).toBe(1); expect(state.areanum2).toBe(2);
    expect(state.topnode).toBe(0); expect(state.leafOverflowed).toBe(true);
    expect(world.linkState(1)?.clusters).not.toBe(state.clusters);
    expect(world.linkState(1)?.absbounds.min).not.toBe(state.absbounds.min);
  });

  test("all-solid-cluster leaves still link and separate world instances own independent links", () => {
    const map = emptyMap(), leaf = map.leaves[0];
    if (leaf === undefined) throw new Error("missing leaf fixture");
    const { world, entities, collision } = setup({ ...map, leaves: [{ ...leaf, cluster: -1 }] });
    const box = entity(1); entities.set(1, box);
    expect(world.link(box).clusters).toEqual([]);
    expect(world.linkState(1)?.linked).toBe(true);
    const worldPrints: string[] = [];
    const other = new ServerWorld(collision, worldBounds, number => entities.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
    expect(other.areaEntities(worldBounds)).toEqual([]);
    expect(world.areaEntities(worldBounds)).toEqual([1]);
  });
});

describe("SV_Trace and exact linked-entity queries", () => {
  test("source traces copy the endpoint before the entity table is queried", () => {
    const end = { x: 100, y: 0, z: 0 }, target = entity(7, vec3(60, 0, 0));
    const collision = new CollisionWorld(emptyMap(), { kind: "unaccounted" }, { kind: "disabled" });
    const world = new ServerWorld(collision, worldBounds, number => {
      end.x = 30; return number === 7 ? target : undefined;
    }, { loading: false, print: () => undefined, developerPrint: () => undefined });
    world.link(target);
    const source = world.traceSource({ start: vec3(0, 0, 0), end, shape: { kind: "point" },
      mask: BODY, passEntityNum: ENTITYNUM_NONE });
    expect(end.x).toBe(30); expect(source.entityNum).toBe(7); expect(source.end.x).toBe(49.875);
    expect(source.plane).toEqual({ normal: vec3(-1, 0, 0), distance: 10, type: 3, signbits: 1 });
  });

  test("point, asymmetric box and capsule sweeps use temporary BODY hulls", () => {
    const { world, entities } = setup();
    const box = entity(9); entities.set(9, box); world.link(box);
    const shapes: readonly TraceShape[] = [{ kind: "point" },
      { kind: "box", mins: vec3(-3, -2, -2), maxs: vec3(1, 2, 2) },
      { kind: "capsule", mins: vec3(-2, -2, -6), maxs: vec3(2, 2, 6) }];
    for (const [index, shape] of shapes.entries()) {
      const hit = world.trace({ start: vec3(20, 0, 0), end: vec3(0, 0, 0), shape, mask: BODY, passEntityNum: ENTITYNUM_NONE });
      expect(hit.entityNum).toBe(9);
      expect(hit.end.x).toBe(index === 0 ? 10.125 : index === 1 ? 13.125 : 12.125);
      expect(hit.contact.kind).toBe("plane");
      expect(hit.contents).toBe(BODY);
    }
    box.r.contents = 1; world.link(box);
    const query = { start: vec3(20, 0, 0), end: vec3(0, 0, 0), shape: { kind: "point" }, passEntityNum: ENTITYNUM_NONE } satisfies Omit<Parameters<ServerWorld["trace"]>[0], "mask">;
    expect(world.trace({ ...query, mask: 1 }).fraction).toBe(1);
    expect(world.trace({ ...query, mask: BODY }).fraction).toBe(1);
    expect(world.trace({ ...query, mask: 1 | BODY }).entityNum).toBe(9);
  });

  test("AAS minus-one pass entity traces linked solids without owner exclusion", () => {
    const { world, entities } = setup();
    const target = entity(7); target.r.ownerNum = -1;
    entities.set(7, target); world.link(target);
    const query = { start: vec3(20, 0, 0), end: vec3(0, 0, 0), shape: { kind: "point" }, mask: BODY,
      passEntityNum: -1 } satisfies Parameters<ServerWorld["trace"]>[0];
    const hit = world.trace(query);
    expect(hit.entityNum).toBe(7); expect(hit.end).toEqual(vec3(10.125, 0, 0));
    expect(hit).toEqual(world.trace({ ...query, passEntityNum: ENTITYNUM_NONE }));
    expect(query.passEntityNum).toBe(-1);
    expect(() => world.trace({ ...query, passEntityNum: -2 })).toThrow("server entity -2 is unavailable");
  });

  test("owner skip matches source own missiles and siblings, but still hits the owner", () => {
    const { world, entities } = setup();
    const owner = entity(1, vec3(60, 0, 0)), missile = entity(2, vec3(0, 0, 0));
    const sibling = entity(3, vec3(25, 0, 0));
    missile.r.ownerNum = 1; sibling.r.ownerNum = 1;
    for (const item of [owner, missile, sibling]) { entities.set(item.s.number, item); world.link(item); }
    const query = { start: vec3(0, 0, 0), end: vec3(100, 0, 0), shape: { kind: "point" }, mask: BODY } satisfies Omit<Parameters<ServerWorld["trace"]>[0], "passEntityNum">;
    expect(world.trace({ ...query, passEntityNum: 2 }).entityNum).toBe(1);
    expect(world.trace({ ...query, passEntityNum: 1 }).fraction).toBe(1);
    expect(world.trace({ ...query, passEntityNum: ENTITYNUM_NONE }).solidity).toBe("start-solid");
    sibling.r.ownerNum = ENTITYNUM_NONE;
    expect(world.trace({ ...query, passEntityNum: 1 }).entityNum).toBe(3);
  });

  test("start-solid survives a later hit, all-solid has no plane, and clear traces use NONE", () => {
    const { world, entities } = setup();
    const containing = entity(1), obstacle = entity(2, vec3(60, 0, 0));
    for (const item of [containing, obstacle]) { entities.set(item.s.number, item); world.link(item); }
    const query = { start: vec3(0, 0, 0), end: vec3(100, 0, 0), shape: { kind: "point" }, mask: BODY, passEntityNum: ENTITYNUM_NONE } satisfies Parameters<ServerWorld["trace"]>[0];
    const hit = world.trace(query);
    expect(hit.solidity).toBe("start-solid"); expect(hit.entityNum).toBe(2); expect(hit.end.x).toBe(49.875);
    const trapped = world.trace({ ...query, end: vec3(1, 0, 0) });
    expect(trapped.solidity).toBe("all-solid"); expect(trapped.fraction).toBe(0); expect(trapped.contact.kind).toBe("none"); expect(trapped.entityNum).toBe(1);
    world.unlink(2);
    const exited = world.trace(query);
    expect(exited.solidity).toBe("start-solid"); expect(exited.fraction).toBe(1); expect(exited.entityNum).toBe(ENTITYNUM_NONE);
    world.unlink(1);
    expect(world.trace(query).entityNum).toBe(ENTITYNUM_NONE);
  });

  test("inline traces use current transforms while point contents uses network transforms", () => {
    const map = inlineMap(), { world, entities } = setup(map);
    const bounds = map.models[1]?.bounds;
    if (bounds === undefined) throw new Error("missing inline fixture");
    const inline = entity(1, vec3(100, 0, 0), bounds);
    inline.s.modelindex = 1; inline.r.model = { kind: "inline", index: 1 }; inline.r.contents = 1;
    inline.r.currentAngles = vec3(0, 90, 0);
    inline.s.origin = vec3(105, 0, 0); inline.s.angles = vec3(0, 0, 0);
    entities.set(1, inline); world.link(inline);
    const hit = world.trace({ start: vec3(100, 20, 0), end: vec3(100, 0, 0), shape: { kind: "point" }, mask: 1, passEntityNum: ENTITYNUM_NONE });
    expect(hit.end.y).toBe(10.125); expect(hit.entityNum).toBe(1);
    expect(world.pointContents(vec3(100, 8, 0), ENTITYNUM_NONE)).toBe(0);
    expect(world.pointContents(vec3(109, 0, 0), ENTITYNUM_NONE)).toBe(1);
    expect(world.pointContents(vec3(109, 0, 0), 1)).toBe(0);
    expect(world.entityContact({ min: vec3(99, 7, -1), max: vec3(101, 9, 1) }, inline)).toBe(true);
    expect(world.entityContact({ min: vec3(108, -1, -1), max: vec3(110, 1, 1) }, inline)).toBe(false);
  });

  test("equal zero fractions retain the source plane while gameplay hides it", () => {
    const { world, entities } = setup();
    const enclosing = entity(1, vec3(0, 0, 0), { min: vec3(-20, -20, -20), max: vec3(20, 20, 20) });
    const face = entity(2);
    for (const item of [enclosing, face]) { entities.set(item.s.number, item); world.link(item); }
    const query = { start: vec3(10.05, 0, 0), end: vec3(0, 0, 0), shape: { kind: "point" },
      mask: BODY, passEntityNum: ENTITYNUM_NONE } satisfies Parameters<ServerWorld["traceSource"]>[0];
    const source = world.traceSource(query);
    expect(source.allSolid).toBe(true); expect(source.startSolid).toBe(false);
    expect(source.plane).toEqual({ normal: vec3(1, 0, 0), distance: 10, type: 0, signbits: 0 });
    const hit = world.trace(query);
    expect(hit.fraction).toBe(0); expect(hit.solidity).toBe("all-solid");
    expect(hit.entityNum).toBe(2);
    expect(hit.contact.kind).toBe("none");
  });

  test("capsule entities ignore rotation for sweeps but honor it for contact queries", () => {
    const { world, entities } = setup();
    const target = entity(1, vec3(0, 0, 0), { min: vec3(-5, -5, -20), max: vec3(5, 5, 20) });
    target.r.model = { kind: "capsule" };
    entities.set(1, target); world.link(target);
    const query = { start: vec3(30, 0, 0), end: vec3(0, 0, 0),
      shape: { kind: "capsule", mins: vec3(-2, -2, -6), maxs: vec3(2, 2, 6) }, mask: BODY, passEntityNum: ENTITYNUM_NONE } satisfies Parameters<ServerWorld["trace"]>[0];
    const upright = world.trace(query);
    expect(upright.entityNum).toBe(1);
    // CM_TraceThroughVerticalCylinder expands the combined radius by one unit.
    expect(upright.end.x).toBeCloseTo(8, 3);
    const contactBounds = { min: vec3(17, -1, -1), max: vec3(19, 1, 1) };
    expect(world.entityContact(contactBounds, target)).toBe(false);
    expect(world.entityContact(contactBounds, target, "capsule")).toBe(false);
    target.r.currentAngles = vec3(90, 0, 0); world.link(target);
    expect(world.trace(query)).toEqual(upright);
    // Native CM_TestBoundingBoxInCapsule retains the original query bounds
    // after swapping hulls, so this stationary box query still reports clear.
    expect(world.entityContact(contactBounds, target)).toBe(false);
    expect(world.entityContact(contactBounds, target, "capsule")).toBe(true);
    // Source capsule point contents uses the temporary box brush, including corners.
    expect(world.pointContents(vec3(4.5, 4.5, 19), ENTITYNUM_NONE)).toBe(BODY);
  });

  test("entity contact can test an unlinked trigger and ignores its contents prefilter", () => {
    const { world } = setup();
    const trigger = entity(2, vec3(100, 0, 0)); trigger.r.contents = 0;
    const touching = { min: vec3(99, -1, -1), max: vec3(101, 1, 1) };
    expect(world.entityContact(touching, trigger)).toBe(true);
    expect(world.entityContact(touching, trigger, "capsule")).toBe(true);
    expect(world.entityContact({ min: vec3(120, -1, -1), max: vec3(121, 1, 1) }, trigger)).toBe(false);
  });

  test("invalid entity geometry fails before altering existing links", () => {
    const { world, entities } = setup();
    const box = entity(1); entities.set(1, box); world.link(box);
    box.r.mins = vec3(NaN, 0, 0);
    expect(() => world.link(box)).toThrow();
    expect(world.areaEntities(worldBounds)).toEqual([1]);
  });
});

const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retailPath = `${retailRoot}/baseq3/pak0.pk3`;
test.skipIf(!(await Bun.file(retailPath).exists()))("retail q3dm1 floor plus a moving linked entity", async () => {
  using archive = await Pk3Archive.open(retailPath);
  const map = parseBsp(await archive.read("maps/q3dm1.bsp"));
  const { world, entities } = setup(map);
  const spawn = map.entityRecords.find(record => record.get("classname") === "info_player_deathmatch");
  const origin = spawn?.get("origin");
  if (origin === undefined) throw new Error("retail spawn missing");
  const [x, y, z] = origin.split(/\s+/).map(Number);
  if (x === undefined || y === undefined || z === undefined) throw new Error("invalid retail spawn");
  const query = { start: vec3(x, y, z + 9), end: vec3(x, y, z - 4096), shape: { kind: "point" }, mask: 1 | BODY, passEntityNum: ENTITYNUM_NONE } satisfies Parameters<ServerWorld["trace"]>[0];
  const floor = world.trace(query);
  expect(floor.entityNum).toBe(ENTITYNUM_WORLD); expect(floor.contact.kind).toBe("plane");
  const box = entity(7, vec3(x, y, (query.start.z + floor.end.z) * 0.5), { min: vec3(-2, -2, -1), max: vec3(2, 2, 1) });
  entities.set(7, box); world.link(box);
  const movingHit = world.trace(query);
  expect(movingHit.entityNum).toBe(7); expect(movingHit.fraction).toBeLessThan(floor.fraction);
  box.r.currentOrigin = vec3(x + 100, y, box.r.currentOrigin.z); world.link(box);
  expect(world.trace(query)).toEqual(floor);
  world.unlink(7); entities.delete(7);
  expect(world.trace(query)).toEqual(floor);
});
