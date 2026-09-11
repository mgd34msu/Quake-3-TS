import { describe, expect, test } from "bun:test";
import type { Bounds, Vec3 } from "../src/core/math.ts";
import { add3, dot3, scale3, sub3, vec3 } from "../src/core/math.ts";
import type { AasArea, AasEdge, AasFace, AasNode, AasPlane, AasWorld } from "../src/botlib/aas.ts";
import { AasWorldState } from "../src/botlib/aas-world.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { BotLibVars } from "../src/botlib/libvars.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import { AasDebugLines } from "../src/botlib/aas-debug.ts";
import { AasSpatial, BotBrushModelTypes } from "../src/botlib/spatial.ts";
import type { AasSpatialHost } from "../src/botlib/spatial.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import { AasLinkedReachability, AasReachabilityDebugState } from "../src/botlib/aas-reachability.ts";
import type { AasReachabilityContext } from "../src/botlib/aas-reachability.ts";
import { AasReachabilitySpecial } from "../src/botlib/aas-reachability-special.ts";
import { TravelType } from "../src/botlib/routing.ts";
import { BotDebugPolygons } from "../src/server/bot-debug.ts";

const f = Math.fround, ZERO = vec3(0, 0, 0);
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing special-reachability fixture cell ${index}`);
  return value;
}
function required<T>(value: T | null): T {
  if (value === null) throw new Error("Missing special reachability");
  return value;
}
function reaches(head: AasLinkedReachability | null): readonly AasLinkedReachability[] {
  const result: AasLinkedReachability[] = [];
  for (let link = head; link !== null; link = link.next) result.push(link);
  return result;
}
function fixtureWorld(rightFloor: number, wall: boolean, padCeiling: number | undefined): AasWorldState {
  const planes: AasPlane[] = [
    { normal: vec3(0, 0, 1), distance: 0, type: 2 }, { normal: vec3(0, 0, -1), distance: 0, type: 2 },
    { normal: vec3(1, 0, 0), distance: 0, type: 0 }, { normal: vec3(-1, 0, 0), distance: 0, type: 0 },
    { normal: vec3(0, 0, 1), distance: rightFloor, type: 2 }, { normal: vec3(0, 0, -1), distance: -rightFloor, type: 2 },
    { normal: vec3(-1, 0, 0), distance: -240, type: 0 }, { normal: vec3(1, 0, 0), distance: 240, type: 0 },
  ];
  const nodes: AasNode[] = [{ plane: 0, children: [0, 0] }, { plane: 2, children: [3, 2] },
    { plane: 0, children: [padCeiling === undefined ? -1 : 5, 0] }, { plane: 4, children: [wall ? 4 : -2, 0] }, { plane: 6, children: [-2, 0] }];
  if (padCeiling !== undefined) {
    planes.push({ normal: vec3(0, 0, 1), distance: padCeiling, type: 2 }, { normal: vec3(0, 0, -1), distance: -padCeiling, type: 2 });
    nodes.push({ plane: 8, children: [-3, -1] });
  }
  const vertices: Vec3[] = [], edges: AasEdge[] = [], edgeIndexes: number[] = [];
  const faces: AasFace[] = [{ plane: 0, flags: 0, firstEdge: 0, edgeCount: 0, frontArea: 0, backArea: 0 }];
  const faceIndexes: number[] = [];
  function face(points: readonly [Vec3, Vec3, Vec3, Vec3], plane: number, area: number, flags: number): void {
    const firstVertex = vertices.length, firstEdge = edges.length;
    vertices.push(...points);
    for (let i = 0; i < 4; i++) { edgeIndexes.push(edges.length); edges.push({ vertices: [firstVertex + i, firstVertex + (i + 1) % 4] }); }
    faceIndexes.push(faces.length);
    faces.push({ plane, flags, firstEdge, edgeCount: 4, frontArea: area, backArea: 0 });
  }
  face([vec3(-256, -64, 0), vec3(-256, 64, 0), vec3(0, 64, 0), vec3(0, -64, 0)], 0, 1, 5);
  face([vec3(0, -64, rightFloor), vec3(0, 64, rightFloor), vec3(256, 64, rightFloor), vec3(256, -64, rightFloor)], 4, 2, 5);
  if (wall) face([vec3(240, -64, rightFloor), vec3(240, 64, rightFloor), vec3(240, 64, 512), vec3(240, -64, 512)], 6, 2, 1);
  const areas: AasArea[] = [
    { areaNumber: 0, firstFace: 0, faceCount: 0, bounds: { min: ZERO, max: ZERO }, center: ZERO },
    { areaNumber: 1, firstFace: 0, faceCount: 1, bounds: { min: vec3(-256, -64, 0), max: vec3(0, 64, 512) }, center: vec3(wall ? -192 : -128, 0, 64) },
    { areaNumber: 2, firstFace: 1, faceCount: wall ? 2 : 1, bounds: { min: vec3(0, -64, rightFloor), max: vec3(256, 64, 512) }, center: vec3(128, 0, rightFloor + 64) },
  ];
  if (padCeiling !== undefined) areas.push({ areaNumber: 3, firstFace: faceIndexes.length, faceCount: 0,
    bounds: { min: vec3(-256, -64, padCeiling), max: vec3(0, 64, 512) }, center: vec3(-128, 0, 256) });
  const parsed: AasWorld = {
    source: "special-reachability-fixture", version: 5, bspChecksum: 0, vertices, edges, edgeIndexes, faces, faceIndexes, planes, nodes, areas,
    areaSettings: areas.map(area => ({ contents: 0, flags: area.faceCount === 0 ? 0 : 1, presenceType: area.areaNumber === 0 ? 0 : 6,
      cluster: 0, clusterAreaNumber: 0, reachableAreaCount: 0, firstReachableArea: 0 })),
    reachability: [], portals: [], portalIndex: [], clusters: [], bboxes: [],
    pointArea(point) {
      let number = 1;
      while (number > 0) { const node = at(nodes, number), plane = at(planes, node.plane); number = node.children[f(dot3(point, plane.normal) - plane.distance) > 0 ? 0 : 1]; }
      return -number;
    },
    areaBounds: area => at(areas, area).bounds,
    areaReachabilities: () => [],
  };
  return new AasWorldState(parsed);
}
interface FixtureOptions {
  readonly debugState?: AasReachabilityDebugState;
  readonly entities: string;
  readonly models: readonly { readonly bounds: Bounds; readonly origin: Vec3 }[];
  readonly rightFloor?: number;
  readonly wall?: boolean;
  readonly capacity?: number;
  readonly padCeiling?: number;
}
function fixture(options: FixtureOptions) {
  const rightFloor = options.rightFloor ?? 0, wall = options.wall ?? false;
  const world = fixtureWorld(rightFloor, wall, options.padCeiling), variables = new BotLibVars(), settings = { ...DEFAULT_AAS_MOVEMENT_SETTINGS };
  const messages: { readonly severity: number; readonly text: string }[] = [], logs: string[] = [];
  const traceCalls: { readonly start: Vec3; readonly end: Vec3; readonly bounds: Bounds | null }[] = [];
  const lines: { readonly start: Vec3; readonly end: Vec3; readonly color: number }[] = [], modelCalls: number[] = [];
  const print: AasReachabilityContext["print"] = (severity, text) => { messages.push({ severity, text }); };
  const bspEntities = new AasBspEntities(print); bspEntities.load(options.entities);
  const areaLinks = new AasLinkHeap(() => { throw new Error("Unexpected exhausted fixture area-link heap"); }); areaLinks.initialize(() => 128);
  const host: AasSpatialHost = {
    print: (text, severity = 1) => { print(severity, text); },
    pointContents: () => 0,
    trace(start, end, bounds) {
      traceCalls.push({ start, end, bounds });
      const floor = (start.x > 0 ? rightFloor : 0) - 24 - (bounds === null ? 0 : bounds.min.z);
      const solid = start.z < floor;
      let fraction = solid ? 0 : end.z < floor ? f(f(start.z - floor) / f(start.z - end.z)) : 1;
      if (wall && start.x < 255 && end.x >= 255) fraction = Math.min(fraction, f(f(255 - start.x) / f(end.x - start.x)));
      return { fraction, end: solid ? start : add3(start, scale3(sub3(end, start), fraction)),
        solidity: solid ? "start-solid" : "clear", contact: { kind: "none" }, entityNum: 0, contents: 0, surfaceFlags: 0 };
    },
    entityTrace: () => { throw new Error("No entity trace in special reachability fixture"); },
    entityModelIndex: () => { throw new Error("No entity model lookup in special reachability fixture"); },
    modelBounds: index => { modelCalls.push(index); return at(options.models, index - 1); },
  };
  const polygons = new BotDebugPolygons(); polygons.initialize(128);
  const debugLines = new AasDebugLines(polygons, text => { print(1, text); });
  const spatial = new AasSpatial(world, bspEntities, host, settings, new BotBrushModelTypes(), areaLinks,
    debugLines.movement, () => variables.value("bot_visualizejumppads", "0"));
  const active = new Set<AasLinkedReachability>(), heads: (AasLinkedReachability | null)[] = world.areas.map(() => null);
  const context: AasReachabilityContext = {
    debugState: options.debugState ?? new AasReachabilityDebugState(),
    world, spatial, settings, variables, bspEntities, heads, print,
    log: text => { logs.push(text); },
    permanentLine: (start, end, color) => { lines.push({ start, end, color }); polygons.permanentLine(start, end, color); },
    allocate() { if (active.size >= (options.capacity ?? 128)) return null; const value = new AasLinkedReachability(); active.add(value); return value; },
    free(link) { if (!active.delete(link)) throw new Error("Freeing a missing fixture reachability"); },
    exists(from, to) { for (let link = at(heads, from); link !== null; link = link.next) if (link.area === to) return true; return false; },
  };
  return { special: new AasReachabilitySpecial(context), context, world, areaLinks, messages, logs, lines, modelCalls, traceCalls, active, debugLines, polygons };
}
const triggerBounds: Bounds = { min: vec3(-8, -8, 0), max: vec3(8, 8, 20) };

describe("compiled special reachability source paths", () => {
  test("REACH_DEBUG elevator messages use source ordering independently from DEBUG counts", () => {
    const options: FixtureOptions = { entities: '{ "classname" "func_plat" "model" "*1" "origin" "-32 0 0" }',
      models: [{ bounds: { min: vec3(-16, -16, 0), max: vec3(16, 16, 128) }, origin: ZERO }], rightFloor: 128 };
    const plain = fixture(options); plain.special.elevator(); expect(plain.logs).toEqual([]);
    const debugState = new AasReachabilityDebugState({ reachDebug: true, debug: false });
    const run = fixture({ ...options, debugState }); run.special.elevator();
    expect(run.logs).toEqual(["AAS_Reachability_Elevator\r\n", "found func plat\r\n", "elevator reach from 1 to 2\r\n"]);
    expect(run.context.heads.flatMap(reaches).map(link => [link.area, link.start, link.end, link.travelTime]))
      .toEqual(plain.context.heads.flatMap(reaches).map(link => [link.area, link.start, link.end, link.travelTime]));
    debugState.printCounts(run.context.print); expect(run.messages).toEqual([]);
    const invalid = fixture({ entities: '{ "classname" "func_plat" }', models: [], debugState });
    invalid.special.elevator();
    expect(invalid.logs).toEqual(["AAS_Reachability_Elevator\r\n", "found func plat\r\n"]);
    expect(invalid.messages).toEqual([{ severity: 3, text: "func_plat without model\n" }]);
  });

  test("reach DEBUG excludes temporary bobbing records and counts published records on allocation failure", () => {
    for (const capacity of [128, 3]) {
      const debugState = new AasReachabilityDebugState({ reachDebug: false, debug: true });
      const run = fixture({ entities: '{ "classname" "func_bobbing" "model" "*1" "height" "64" "spawnflags" "1" }',
        models: [{ bounds: { min: vec3(-16, -16, -28), max: vec3(16, 16, -20) }, origin: ZERO }], capacity, debugState });
      if (capacity === 3) expect(() => run.special.funcBobbing()).toThrow("failed reachability allocation");
      else run.special.funcBobbing();
      debugState.printCounts(run.context.print);
      expect(run.messages).toContainEqual({ severity: 1, text: capacity === 3 ? "     1 reach funcbob\n" : "     2 reach funcbob\n" });
      expect(run.context.heads.flatMap(reaches)).toHaveLength(capacity === 3 ? 1 : 2);
    }
  });

  test("teleport relay lookup, team flags, prepend order and allocation failure retain source writes", () => {
    const options: FixtureOptions = { entities: `
      { "classname" "trigger_multiple" "model" "*1" "target" "relay" "bot_notteam" "1" }
      { "classname" "target_teleporter" "targetname" "relay" "target" "finish" }
      { "classname" "target_position" "targetname" "finish" "origin" "128 0 60" }
      { "classname" "trigger_teleport" "model" "*2" "target" "finish" "bot_notteam" "2" }`,
      models: [{ bounds: triggerBounds, origin: vec3(-128, 0, 0) }, { bounds: triggerBounds, origin: vec3(-64, 0, 0) }] };
    const run = fixture(options); run.world.areaSettingsRecord(1).contents = 64; run.world.areaSettingsRecord(2).contents = 128;
    run.special.teleport();
    const links = reaches(at(run.context.heads, 1));
    expect(links.map(link => [link.area, link.travelType, link.travelTime, link.start, link.end])).toEqual([
      [2, TravelType.TELEPORT | TravelType.NOTTEAM2, 50, vec3(-64, 0, 10), vec3(128, 0, 60)],
      [2, TravelType.TELEPORT | TravelType.NOTTEAM1, 50, vec3(-128, 0, 10), vec3(128, 0, 60)],
    ]);
    expect(run.areaLinks.freeCount).toBe(128);
    const limited = fixture({ ...options, capacity: 1 });
    limited.world.areaSettingsRecord(1).contents = 64; limited.world.areaSettingsRecord(2).contents = 128;
    limited.special.teleport();
    expect(reaches(at(limited.context.heads, 1)).length).toBe(1); expect(limited.areaLinks.freeCount).toBe(128);
  });

  test("teleport missing model reads a retained suffix and rejects the initial undefined suffix", () => {
    const options: FixtureOptions = { entities: `
      { "classname" "trigger_teleport" "model" "*1" }
      { "classname" "trigger_teleport" }`, models: [{ bounds: triggerBounds, origin: vec3(0.5, -1.5, -0) }] };
    const run = fixture(options); run.special.teleport();
    expect(run.modelCalls).toEqual([1, 1]);
    expect(run.messages.map(message => message.text)).toEqual([
      'trigger_teleport model = "*1"\n', "trigger_teleport at 0 -2 -0 without target\n",
      'trigger_teleport model = ""\n', "trigger_teleport at 0 -2 -0 without target\n",
    ]);
    const initial = fixture({ ...options, entities: '{ "classname" "trigger_teleport" }' });
    expect(() => initial.special.teleport()).toThrow("uninitialized model suffix");
    expect(initial.messages.map(message => message.text)).toEqual(['trigger_teleport model = ""\n']);
  });

  test("elevator top searches retain expanded bounds between bottom candidates", () => {
    const run = fixture({ entities: '{ "classname" "func_plat" "model" "*1" "origin" "-32 0 0" "bot_notteam" "1" }',
      models: [{ bounds: { min: vec3(-16, -16, 0), max: vec3(16, 16, 128) }, origin: ZERO }], rightFloor: 128 });
    run.special.elevator();
    const reach = required(at(run.context.heads, 1));
    expect(reach.area).toBe(2); expect(reach.face).toBe(1); expect(reach.edge).toBe(120);
    expect(reach.travelType).toBe(TravelType.ELEVATOR | TravelType.NOTTEAM1); expect(reach.travelTime).toBe(110);
    expect(reach.start.x).toBe(-32); expect(reach.start.z).toBe(26); expect(reach.end).toEqual(vec3(1, 0, 146));
    expect(reach.next).toBeNull();
  });

  test("bobbing platform builds both directions, packs signed endpoints and releases temporary reaches", () => {
    const options: FixtureOptions = { entities: '{ "classname" "func_bobbing" "model" "*1" "height" "64" "spawnflags" "1" }',
      models: [{ bounds: { min: vec3(-16, -16, -28), max: vec3(16, 16, -20) }, origin: ZERO }] };
    const run = fixture(options);
    run.special.funcBobbing();
    const links = run.context.heads.flatMap(reaches);
    expect(links.map(link => [link.area, link.edge])).toEqual([[2, -4194240], [1, 4259776]]);
    expect(run.lines.length).toBe(4); expect(run.active.size).toBe(2);
    expect(new Set(links.map(link => link.edge))).toEqual(new Set([-4194240, 4259776]));
    expect(links.every(link => link.face === 65537 && link.travelType === TravelType.FUNCBOB && link.travelTime === 300)).toBe(true);
    expect(run.logs[0]).toBe("funcbob model 1, start = {-64.0, 0.0, -24.0} end = {64.0, 0.0, -24.0}\n");
    expect(run.lines.map(line => line.color)).toEqual([1, 2, 1, 2]);
    const limited = fixture({ ...options, capacity: 3 });
    expect(() => limited.special.funcBobbing()).toThrow("failed reachability allocation");
    expect(limited.context.heads.flatMap(reaches).length).toBe(1);
    expect(limited.active.size).toBe(3); expect(limited.lines.length).toBe(4);
  });

  test("jump pads retain source links and publish real debug polygons when visualization is enabled", () => {
    const run = fixture({ entities: `
      { "classname" "trigger_push" "model" "*1" "target" "apex" }
      { "targetname" "apex" "origin" "256 0 210" }`,
      models: [{ bounds: triggerBounds, origin: vec3(-64, 0, 0) }] });
    run.world.areaSettingsRecord(1).contents = 128;
    run.context.variables.set("bot_visualizejumppads", "1");
    run.special.jumpPad();
    const reach = required(at(run.context.heads, 1));
    expect(reach.area).toBe(2); expect(reach.travelType).toBe(TravelType.JUMPPAD); expect(reach.travelTime).toBe(250);
    expect(reach.face).toBe(405); expect(reach.edge).toBe(497);
    expect(reach.start.x).toBeGreaterThan(-64); expect(reach.start.x).toBeLessThan(0);
    expect(run.areaLinks.freeCount).toBe(127);
    const visible = run.polygons.rows.filter(polygon => polygon.inuse);
    expect(visible.length).toBeGreaterThan(0);
    expect(run.debugLines.numDebugLines).toBe(visible.length);
    expect(visible.every(polygon => polygon.color === 1 && polygon.numPoints === 4)).toBe(true);
    const firstPoints = at(visible, 0).points.slice(0, 2);
    expect(firstPoints.map(point => [point.x, point.z])).toEqual([[-64, 10.375], [-64, 10.375]]);
    expect(at(firstPoints, 0).y).toBeCloseTo(-2, 6); expect(at(firstPoints, 1).y).toBeCloseTo(2, 6);
    const vertical = fixture({ entities: `
      { "classname" "trigger_push" "model" "*1" "target" "apex" }
      { "targetname" "apex" "origin" "-64 0 410" }`,
      models: [{ bounds: triggerBounds, origin: vec3(-64, 0, 0) }], rightFloor: 128, padCeiling: 64 });
    vertical.world.areaSettingsRecord(1).contents = 128;
    vertical.special.jumpPad();
    const controlled = required(at(vertical.context.heads, 1));
    expect(controlled.area).toBe(2); expect(controlled.travelTime).toBe(300); expect(controlled.end).toEqual(vec3(128, 0, 128));
    expect(vertical.areaLinks.freeCount).toBe(128);
  });

  test("weapon flags use the source item membership and allow the compiled rocket-jump branch", () => {
    const run = fixture({ entities: `
      { "classname" "weapon_rocketlauncher" "origin" "128 0 160" "spawnflags" "1" }
      { "classname" "weapon_shotgun" "origin" "-128 0 30" "spawnflags" "1" }
      { "classname" "item_haste" "origin" "-128 0 30" "spawnflags" "1" }
      { "classname" "item_invulnerability" "origin" "128 0 160" "spawnflags" "1" }`, models: [], rightFloor: 128 });
    run.special.setWeaponJumpAreaFlags();
    expect(run.world.areaSettingsRecord(1).flags & 8192).toBe(0); expect(run.world.areaSettingsRecord(2).flags & 8192).toBe(8192);
    expect(run.messages.at(-1)?.text).toBe("2 weapon jump areas\n");
    expect(run.special.weaponJump(1, 2)).toBe(true);
    const reach = required(at(run.context.heads, 1));
    expect(reach.area).toBe(2); expect(reach.travelType).toBe(TravelType.ROCKETJUMP); expect(reach.travelTime).toBe(500);
    expect(reach.end).toEqual(vec3(128, 0, 128));
    run.world.areaSettingsRecord(1).contents = 128;
    run.special.setWeaponJumpAreaFlags();
    expect(run.world.areaSettingsRecord(1).flags & 8192).toBe(8192); expect(run.messages.at(-1)?.text).toBe("3 weapon jump areas\n");
  });

  test("grapple publishes a valid wall reach while preserving the source false return", () => {
    const run = fixture({ entities: "", models: [], rightFloor: 128, wall: true });
    expect(run.special.grapple(1, 2)).toBe(false);
    expect(run.traceCalls).toEqual([{ start: vec3(240, 0, 320), end: vec3(740, 0, 320), bounds: null }]);
    const reach = required(at(run.context.heads, 1));
    expect(reach.area).toBe(2); expect(reach.face).toBe(3); expect(reach.travelType).toBe(TravelType.GRAPPLEHOOK);
    expect(reach.end).toEqual(vec3(255, 0, 320));
    expect(reach.travelTime).toBe(637);
    expect(run.special.grapple(1, 2)).toBe(false); expect(reach.next).toBeNull(); expect(run.active.size).toBe(1);
  });
});
