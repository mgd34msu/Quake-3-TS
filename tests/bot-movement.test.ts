import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BspMap } from "../src/assets/bsp.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import type { AasReachability, AasWorld } from "../src/botlib/aas.ts";
import { parseAas } from "../src/botlib/aas.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import { BotActionBuffer, BotActionFlag } from "../src/botlib/actions.ts";
import type { BotGoal } from "../src/botlib/goals.ts";
import { BotMovement, movementIntersection } from "../src/botlib/movement.ts";
import { BotMovementRouting } from "../src/botlib/movement-routing.ts";
import { BotMoveFlag, BotMoveResult, BotMoveResultFlag, BotMoveResultType, BotMoveStateStore, BotMoveType } from "../src/botlib/movement-state.ts";
import { AasRouting, TravelFlags, TravelType } from "../src/botlib/routing.ts";
import { AasSpatial, BotBrushModelTypes } from "../src/botlib/spatial.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import type { AasSpatialHost } from "../src/botlib/spatial.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { add3, dot3, scale3, sub3, vec2, vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { float32ToBits } from "../src/core/numeric.ts";

function linkHeap(): AasLinkHeap {
  const heap = new AasLinkHeap(() => { throw new Error("Unexpected empty AAS fixture link heap"); });
  heap.initialize(() => 6144);
  return heap;
}

const zero = vec3(0, 0, 0), f = Math.fround, bits = float32ToBits;
function required<T>(value: T | undefined): T { if (value === undefined) throw new Error("Missing movement test value"); return value; }
function vectorBits(value: Vec3): number[] { return [bits(value.x), bits(value.y), bits(value.z)]; }
function goal(area = 1, origin = vec3(100, 0, 24)): BotGoal { return { area, origin, mins: zero, maxs: zero, entity: 0, number: 0, flags: 0, itemInfo: 0 }; }
function emptyBsp(): BspMap {
  return { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [], leaves: [], leafSurfaces: [], leafBrushes: [], models: [], brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}
function floorWorld(reach: AasReachability | null = null, contents = 0): AasWorld {
  const bounds = { min: vec3(-10000, -10000, 0), max: vec3(10000, 10000, 10000) };
  const areas = [0, 1, 2].map(areaNumber => ({ areaNumber, faceCount: 0, firstFace: 0, bounds, center: vec3(0, 0, 24) }));
  const areaSettings = [0, 1, 2].map(area => ({ contents: area === 0 ? 0 : contents, flags: area === 0 ? 0 : 1,
    presenceType: area === 0 ? 0 : 6, cluster: area === 0 ? 0 : 1, clusterAreaNumber: area === 0 ? 0 : area - 1,
    reachableAreaCount: area === 1 && reach !== null ? 1 : 0, firstReachableArea: area === 1 && reach !== null ? 1 : 0 }));
  const reaches: readonly AasReachability[] = [{ area: 0, face: 0, edge: 0, start: zero, end: zero, travelType: 0, travelTime: 0, padding: 0 }, ...(reach === null ? [] : [reach])];
  return { source: "movement-owner-floor", version: 5, bspChecksum: 0, vertices: [], edges: [], edgeIndexes: [], faces: [], faceIndexes: [],
    planes: [{ normal: vec3(0, 0, 1), distance: 0, type: 2 }, { normal: vec3(0, 0, -1), distance: -0, type: 2 }],
    nodes: [{ plane: 0, children: [0, 0] }, { plane: 0, children: [-1, 0] }], areas, areaSettings,
    reachability: reaches, portals: [], portalIndex: [], bboxes: [],
    clusters: [{ areaCount: 0, reachabilityAreaCount: 0, portalCount: 0, firstPortal: 0 }, { areaCount: 2, reachabilityAreaCount: 2, portalCount: 0, firstPortal: 0 }],
    pointArea: point => point.z > 0 ? 1 : 0,
    areaReachabilities: area => area === 1 && reach !== null ? [reach] : [], areaBounds: area => required(areas[area]).bounds };
}
function shapedWorld(height: number, reach: AasReachability | null = null): AasWorld {
  const world = floorWorld(reach), planes: AasWorld["planes"] = [...world.planes,
    { normal: vec3(1,0,0), distance: 10, type: 0 }, { normal: vec3(-1,0,0), distance: -10, type: 0 },
    { normal: vec3(0,0,1), distance: height, type: 2 }, { normal: vec3(0,0,-1), distance: -height, type: 2 }];
  const nodes: AasWorld["nodes"] = [{ plane: 0, children: [0,0] }, { plane: 2, children: [2,3] }, { plane: 4, children: [-2,0] }, { plane: 0, children: [-1,0] }];
  return { ...world, planes, nodes, pointArea(point) {
    let node = 1;
    while (node > 0) { const record = required(nodes[node]), plane = required(planes[record.plane]); node = record.children[f(dot3(point, plane.normal) - plane.distance) > 0 ? 0 : 1]; }
    return -node;
  } };
}
function fixture(world = floorWorld(), map = emptyBsp(), retail = false) {
  const messages: string[] = [], commands: string[] = [], variables = new Map<string, { string: string; value: number }>();
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  let time = 0, contents = 0, blockingEntity = 1023;
  const host: AasSpatialHost = {
    print: text => { messages.push(text); }, pointContents: point => retail ? collision.pointContents(point) : contents,
    trace(start, end, bounds, _pass, mask) {
      if (retail) {
        const trace = collision.trace({ start, end, shape: bounds === null ? { kind: "point" } : { kind: "box", mins: bounds.min, maxs: bounds.max }, mask });
        return { ...trace, entityNum: trace.fraction < 1 ? 1022 : 1023 };
      }
      const floor = bounds === null ? 0 : -bounds.min.z, solid = start.z < floor;
      const fraction = solid ? 0 : end.z < floor ? f(f(start.z - floor) / f(start.z - end.z)) : 1;
      return { fraction, end: solid ? start : add3(start, scale3(sub3(end, start), fraction)), solidity: solid ? "start-solid" : "clear",
        contact: { kind: "none" }, entityNum: blockingEntity !== 1023 ? blockingEntity : fraction < 1 ? 1022 : 1023, contents: 0, surfaceFlags: 0 };
    },
    entityTrace: () => { throw new Error("No dynamic entities are linked"); }, entityModelIndex: () => 0,
    modelBounds: model => ({ bounds: collision.modelBounds(model), origin: zero }),
  };
  const bspEntities = new AasBspEntities((_severity, text) => { host.print(text); });
  bspEntities.load(map.entities);
  const spatial = new AasSpatial(world, bspEntities, host, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), linkHeap(), { kind: "disabled" }, () => 0);
  const states = new BotMoveStateStore({ time: () => time, print: (severity, text) => { messages.push(`${severity}:${text}`); },
    libVar(name, value) { const existing = variables.get(name); if (existing !== undefined) return existing;
      const created = { string: value, value: f(Number.isNaN(Number(value)) ? 0 : Number(value)) }; variables.set(name, created); return created; },
    setBrushModelTypes: () => spatial.setBrushModelTypes(host.print) });
  states.setup();
  const aasRouting = new AasRouting(world);
  aasRouting.initializeRouting(spatial, () => 16 * 1024 * 1024, () => time);
  const routing = new BotMovementRouting(states, spatial, aasRouting, { originOfMoverWithModelNum: () => null, entityModelNum: host.entityModelIndex });
  const random = new LinuxNativeRandom(1), movementHost = { random: { nextInt: () => random.next() }, developer: () => false,
    nextEntity: () => 0, entityType: () => { throw new Error("No grapple entity"); }, entityWeapon: () => { throw new Error("No grapple weapon"); } };
  const createExecution = () => { const actions = new BotActionBuffer(2, { *clientCommand(_client, text): ReturnType<BotActionBuffer["commandCalls"]> { commands.push(text); } });
    return { actions, movement: new BotMovement(routing, actions, movementHost) }; };
  const execution = createExecution(), handle = states.allocate(), state = states.fromHandle(handle);
  if (state === null) throw new Error("Missing allocated movement state");
  states.initialize(handle, { origin: vec3(0, 0, 24), velocity: zero, viewOffset: zero, entityNum: -1, client: 0,
    thinkTime: .1, presenceType: 2, viewAngles: zero, orMoveFlags: BotMoveFlag.ONGROUND });
  return { ...execution, createExecution, states, state, handle, routing, spatial, collision, host, messages, commands, variables,
    time: (value: number) => { time = f(value); }, contents: (value: number) => { contents = value; }, blockedBy: (entity: number) => { blockingEntity = entity; } };
}

describe("movement owner source ordering and ownership", () => {
  test("ground-hit gap probes clear zero-length prediction velocity", () => {
    for (const velocity of [vec3(-0, -0, -0), vec3(-1e-30, -1e-30, -1e-30)]) {
      const env = fixture(), starts: Vec3[] = [], originalVelocity = vectorBits(velocity);
      const trace = env.spatial.traceClientBBox.bind(env.spatial);
      let predicted = false;
      env.spatial.traceClientBBox = (start, end, presence, entity) => {
        if (predicted) starts.push(start);
        return trace(start, end, presence, entity);
      };
      env.spatial.movement.predictClientMovement = request => {
        const end = vec3(-0, -0, 24);
        const contact = trace(end, vec3(0, 0, 0), request.presence, request.entityNum);
        predicted = true;
        return { success: true, move: { end, endArea: 1, velocity, trace: contact,
          presence: request.presence, stopEvent: 1, endContents: 0, time: .1, frames: 1 } };
      };
      expect(env.movement.moveInDirection(env.handle, vec3(0, 1, 0), 0, BotMoveType.WALK)).toBe(true);
      expect(starts.length).toBe(26);
      for (const start of starts.slice(1, 13)) {
        expect([bits(start.x), bits(start.y)]).toEqual([0, 0]);
      }
      expect(vectorBits(velocity)).toEqual(originalVelocity);
    }
  });
  test("partial result clear precedes invalid handle without clearing caller view or weapon", () => {
    const env = fixture(), result = new BotMoveResult();
    result.failure = true; result.type = 99; result.blocked = true; result.blockEntity = 42; result.flags = 31; result.travelType = 18;
    result.weapon = 9; result.moveDirection = vec3(3, 4, 5); result.idealViewAngles = vec3(10, 20, 30);
    env.movement.moveToGoal(result, 0, null, TravelFlags.DEFAULT);
    expect(result).toEqual({ failure: false, type: 0, blocked: false, blockEntity: 0, flags: 0, travelType: 0,
      weapon: 9, moveDirection: vec3(3, 4, 5), idealViewAngles: vec3(10, 20, 30) });
    expect(env.messages).toEqual(["4:move state handle 0 out of range\n"]);
  });
  test("grapple reset precedes null goal and zero presence follows the airborne branch", () => {
    const env = fixture(), result = new BotMoveResult();
    const offhand = env.variables.get("offhandgrapple"); if (offhand === undefined) throw new Error("Missing offhand LibVar"); offhand.value = 1;
    env.state.presenceType = 0; env.state.moveFlags = BotMoveFlag.ACTIVEGRAPPLE;
    env.movement.moveToGoal(result, env.handle, null, TravelFlags.DEFAULT);
    expect(result.failure).toBe(true); expect(env.commands).toEqual(["grappleoff"]);
    expect(env.state.moveFlags & BotMoveFlag.ACTIVEGRAPPLE).toBe(0);
    // AAS_TraceClientBBox rejects area presence & 0 before entity bbox tracing.
    expect(env.spatial.traceClientBBox(env.state.origin, vec3(0, 0, 14), 0, -1).startSolid).toBe(true);
    env.movement.moveToGoal(result, env.handle, goal(), TravelFlags.DEFAULT);
    expect(result.failure).toBe(false); expect(result.travelType).toBe(0);
    expect(env.state.moveFlags & BotMoveFlag.ONGROUND).toBe(0);
    expect(env.state.lastOrigin).toEqual(env.state.origin);
    env.contents(32);
    expect(env.movement.moveInDirection(env.handle, vec3(3, 4, 0), 200, BotMoveType.WALK)).toBe(true);
    expect(env.actions.getInput(0, .1).speed).toBe(200);
  });
  test("same-area movement uses actual EA and resets only source route fields", () => {
    const env = fixture(), result = new BotMoveResult(); env.state.lastReachability = 42; env.state.lastArea = 8;
    env.state.reachabilityTime = 31; env.state.jumpReach = 7;
    env.movement.moveToGoal(result, env.handle, goal(1, vec3(30, 40, 1000)), TravelFlags.DEFAULT);
    expect(result.failure).toBe(false); expect(result.travelType).toBe(TravelType.WALK);
    expect(vectorBits(result.moveDirection)).toEqual([1058642329,1061997772,0]);
    expect(env.actions.getInput(0, .1).speed).toBe(200);
    expect([env.state.lastReachability, env.state.lastArea, env.state.lastGoalArea, env.state.reachabilityTime, env.state.jumpReach]).toEqual([0, 0, 1, 31, 7]);
    expect(env.state.lastOrigin).toEqual(env.state.origin);
    env.movement.moveToGoal(result, env.handle, goal(1, vec3(1, 0, 24)), TravelFlags.DEFAULT);
    expect(env.actions.getInput(0, .1).speed).toBe(0);
  });
  test("native swim view differs from QVM rounding by the recorded source bit", () => {
    const env = fixture(), result = new BotMoveResult(); env.contents(32);
    env.state.origin = zero;
    const offset = vec3(2.42, -.34, 3.87);
    env.movement.moveToGoal(result, env.handle, goal(1, add3(env.state.origin, offset)), TravelFlags.DEFAULT);
    expect(result.flags & BotMoveResultFlag.SWIMVIEW).toBe(BotMoveResultFlag.SWIMVIEW);
    expect(vectorBits(result.idealViewAngles)).toEqual([3261524619,1135607891,0]);
    expect(env.actions.getInput(0, .1).direction).toEqual(result.moveDirection);
  });
  test("solid-area early failure leaves last origin and timeout unchanged", () => {
    const env = fixture(), result = new BotMoveResult(); env.state.origin = vec3(0, 0, -100);
    env.state.lastOrigin = vec3(4, 5, 6); env.state.reachabilityTime = 9;
    env.movement.moveToGoal(result, env.handle, goal(), TravelFlags.DEFAULT);
    expect(result.failure).toBe(true); expect(result.type).toBe(BotMoveResultType.INSOLIDAREA);
    expect(env.state.lastOrigin).toEqual(vec3(4, 5, 6)); expect(env.state.reachabilityTime).toBe(9);
  });
  test("route selection/reuse/expiry shares actual state, route cache and action buffer", () => {
    const reach: AasReachability = { area: 2, face: 0, edge: 0, start: vec3(20, 0, 24), end: vec3(100, 0, 24), travelType: TravelType.WALK, travelTime: 10, padding: 0 };
    const env = fixture(floorWorld(reach)), result = new BotMoveResult(); env.time(10);
    env.movement.moveToGoal(result, env.handle, goal(2), TravelFlags.DEFAULT);
    expect(result.failure).toBe(false); expect(env.state.lastReachability).toBe(1);
    expect([env.state.reachabilityTime, env.state.avoidReachTimes[0], env.state.avoidReachTries[0]]).toEqual([15, 16, 1]);
    const routing = env.movement.routing, pool = routing.states, spatial = routing.spatial, actions = env.movement.actions;
    env.time(11); env.movement.moveToGoal(result, env.handle, goal(2), TravelFlags.DEFAULT);
    expect(env.state.reachabilityTime).toBe(15); expect(env.state.avoidReachTries[0]).toBe(1);
    env.time(15.25); env.movement.moveToGoal(result, env.handle, goal(2), TravelFlags.DEFAULT);
    expect(env.state.reachabilityTime).toBe(20.25); expect(env.state.avoidReachTries[0]).toBe(2);
    expect(env.movement.routing).toBe(routing); expect(routing.states).toBe(pool); expect(routing.spatial).toBe(spatial); expect(env.movement.actions).toBe(actions);
    expect(actions.getInput(0, .1).speed).toBeGreaterThan(0);
  });
  test("airborne crouch and teleport retain caller fields and emit no action", () => {
    for (const type of [TravelType.CROUCH, TravelType.TELEPORT]) {
      const reach: AasReachability = { area: 2, face: 0, edge: 0, start: zero, end: vec3(100, 0, 24), travelType: type, travelTime: 1, padding: 0 };
      const env = fixture(floorWorld(reach)), result = new BotMoveResult();
      env.state.moveFlags = 0; env.state.origin = vec3(0, 0, 100); env.state.lastReachability = 1;
      result.weapon = 9; result.moveDirection = vec3(2, 3, 4); result.idealViewAngles = vec3(10, 20, 30);
      env.movement.moveToGoal(result, env.handle, goal(2), TravelFlags.DEFAULT);
      expect(result.travelType).toBe(type); expect(result.weapon).toBe(9); expect(result.moveDirection).toEqual(vec3(2, 3, 4));
      expect(env.actions.getInput(0, .1).actionFlags).toBe(0); expect(env.actions.getInput(0, .1).speed).toBe(0);
    }
  });
  test("owners and clients retain independent canonical state and actions", () => {
    const first = fixture(), second = fixture(), result = new BotMoveResult();
    first.movement.moveToGoal(result, first.handle, goal(), TravelFlags.DEFAULT);
    expect(first.actions.getInput(0, .1).speed).toBe(400);
    expect(first.actions.getInput(1, .1).speed).toBe(0); expect(second.actions.getInput(0, .1).speed).toBe(0);
    expect(second.state.lastGoalArea).toBe(0);
  });
  test("blocked travel subtracts the source per-frame timeout after dispatch", () => {
    const reach: AasReachability = { area: 2, face: 0, edge: 0, start: vec3(100,0,24), end: vec3(200,0,24), travelType: TravelType.WALK, travelTime: 10, padding: 0 };
    const env = fixture(floorWorld(reach)), result = new BotMoveResult(), trace = env.host.trace;
    env.host.trace = (start,end,bounds,entity,mask) => ({ ...trace(start,end,bounds,entity,mask), entityNum: (mask & 0x2000000) !== 0 ? 42 : 1023 });
    env.time(10); env.state.thinkTime = f(.037);
    env.movement.moveToGoal(result,env.handle,goal(2),TravelFlags.DEFAULT);
    expect(result.blocked).toBe(true); expect(result.blockEntity).toBe(42);
    expect(env.state.reachabilityTime).toBe(f(15 - f(10 * f(.037))));
    expect(env.state.lastOrigin).toEqual(env.state.origin);
  });
  test("source-unsupported travel keeps error and fatal diagnostics without inventing a handler", () => {
    const reach: AasReachability = { area: 2, face: 0, edge: 0, start: vec3(100,0,24), end: vec3(200,0,24), travelType: TravelType.DOUBLEJUMP, travelTime: 10, padding: 0 };
    const env = fixture(floorWorld(reach)), result = new BotMoveResult();
    env.movement.moveToGoal(result,env.handle,goal(2),TravelFlags.DEFAULT | TravelFlags.DOUBLEJUMP);
    expect(env.messages).toEqual(["3:travel type 15 not implemented yet\n","4:travel type 15 not implemented yet\n"]);
    expect(result.failure).toBe(false); expect(result.travelType).toBe(TravelType.DOUBLEJUMP);
    expect(env.state.reachabilityTime).toBe(8); expect(env.actions.getInput(0,.1).speed).toBe(0);
  });
  test("compiled-unused Intersection keeps integer truncation and rejects undefined conversion", () => {
    expect(movementIntersection(vec2(0, 0), vec2(3, 3), vec2(0, 3), vec2(3, 0))).toEqual(vec2(1, 1));
    expect(movementIntersection(vec2(-3, -3), vec2(0, 0), vec2(-3, 0), vec2(0, -3))).toEqual(vec2(-1, -1));
    expect(movementIntersection(vec2(0, 0), vec2(2, 2), vec2(0, 1), vec2(2, 3))).toBeNull();
    expect(() => movementIntersection(vec2(0, 0), vec2(1, 1), vec2(3e10, 0), vec2(3e10, 1))).toThrow("defined source integer conversion");
  });
});

describe("unchanged-native movement direction recordings", () => {
  test("real AAS barrier traces emit the native jump and speed, respecting live step height", () => {
    const env = fixture(shapedWorld(24)); env.state.origin = vec3(0,0,1); env.state.moveFlags = 0;
    expect(env.movement.moveInDirection(env.handle, vec3(1,0,0), 300, BotMoveType.WALK)).toBe(true);
    const input = env.actions.getInput(0,.1);
    expect([env.state.moveFlags,bits(input.speed),input.actionFlags,...vectorBits(input.direction)]).toEqual([3,1133903872,16,1065353216,0,0]);
    const step = env.variables.get("sv_step"); if (step === undefined) throw new Error("Missing live step variable"); step.value = 40;
    env.actions.resetInput(0); env.actions.resetInput(0); env.state.moveFlags = 0;
    env.movement.moveInDirection(env.handle, vec3(1,0,0), 300, BotMoveType.WALK);
    expect(env.state.moveFlags & BotMoveFlag.BARRIERJUMP).toBe(0);
  });
  test("actual gap sampling slows walking at16 units and preserves water exception", () => {
    const reach: AasReachability = { area: 2, face: 0, edge: 0, start: vec3(100,0,24), end: vec3(200,0,-76), travelType: TravelType.WALK, travelTime: 10, padding: 0 };
    const env = fixture(shapedWorld(-100,reach)), result = new BotMoveResult(); env.time(1);
    env.movement.moveToGoal(result,env.handle,goal(2,reach.end),TravelFlags.DEFAULT);
    expect(env.actions.getInput(0,.1).speed).toBe(72);
    env.state.moveFlags |= BotMoveFlag.WALK; env.movement.moveToGoal(result,env.handle,goal(2,reach.end),TravelFlags.DEFAULT);
    expect(env.actions.getInput(0,.1).speed).toBe(36);
    expect(env.actions.getInput(0,.1).actionFlags & BotActionFlag.WALK).toBe(BotActionFlag.WALK);
    env.host.pointContents = point => point.z < -20 ? 32 : 0;
    env.movement.moveToGoal(result,env.handle,goal(2,reach.end),TravelFlags.DEFAULT);
    expect(env.actions.getInput(0,.1).speed).toBe(200);
  });
  test("actual owner AirControl drives airborne weapon finish with native words and EA cap", () => {
    const reach: AasReachability = { area: 2, face: 0, edge: 0, start: zero, end: vec3(100,0,0), travelType: TravelType.ROCKETJUMP, travelTime: 1, padding: 0 };
    const env = fixture(floorWorld(reach)), result = new BotMoveResult();
    env.state.moveFlags = 0; env.state.origin = vec3(0,0,100); env.state.velocity = vec3(30,20,200); env.state.lastReachability = 1; env.state.jumpReach = 1;
    env.movement.moveToGoal(result,env.handle,goal(2),TravelFlags.DEFAULT);
    expect(vectorBits(result.moveDirection)).toEqual([1065061267,3191747372,0]);
    expect(env.actions.getInput(0,.1).speed).toBe(400);
    const gravity = env.variables.get("sv_gravity"); if (gravity === undefined) throw new Error("Missing live gravity"); gravity.value = 0;
    env.actions.resetInput(0); env.movement.moveToGoal(result,env.handle,goal(2),TravelFlags.DEFAULT);
    expect(result.moveDirection).toEqual(vec3(1,0,0)); expect(env.actions.getInput(0,.1).speed).toBe(400);
  });
  test("actual AAS prediction and EA produce the source ground/air/liquid words", () => {
    const cases: readonly { readonly origin: Vec3; readonly velocity: Vec3; readonly direction: Vec3; readonly flags: number;
      readonly contents: number; readonly speed: number; readonly type: number; readonly expected: readonly number[] }[] = [
      { origin: vec3(0,0,24), velocity: zero, direction: vec3(1,0,0), flags: 0, contents: 0, speed: 300, type: 1, expected: [1,0,0,0,0,0,0,0] },
      { origin: vec3(0,0,100), velocity: vec3(0,0,49), direction: vec3(3,4,5), flags: 1, contents: 0, speed: 300, type: 1, expected: [1,1,1133903872,0,0,1077936128,1082130432,1084227584] },
      { origin: vec3(0,0,100), velocity: vec3(0,0,50), direction: vec3(3,4,5), flags: 1, contents: 0, speed: 300, type: 1, expected: [1,1,0,0,0,0,0,0] },
      { origin: vec3(0,0,100), velocity: zero, direction: vec3(3,4,5), flags: 0, contents: 32, speed: 300, type: 1, expected: [1,0,1133903872,0,0,1054423332,1058066627,1060439284] },
      { origin: vec3(0,0,24), velocity: zero, direction: vec3(1,0,0), flags: 0, contents: 8, speed: 300, type: 1, expected: [1,0,1133903872,0,0,1065353216,0,0] },
    ];
    for (const entry of cases) {
      const env = fixture(); env.state.origin = entry.origin; env.state.velocity = entry.velocity; env.state.moveFlags = entry.flags; env.contents(entry.contents);
      const success = env.movement.moveInDirection(env.handle, entry.direction, entry.speed, entry.type), input = env.actions.getInput(0, .1);
      expect([Number(success), env.state.moveFlags, bits(input.speed), input.actionFlags, input.weapon, ...vectorBits(input.direction)]).toEqual([...entry.expected]);
    }
  });
});

const dataPath = process.env["Q3_DATA"], oracle = process.env["Q3_BOT_MOVEMENT_OWNER_ORACLE"];
// Untouched native x64 GCC -O0 recordings: /tmp/quake3-movement-owner-ucvcEl.
// These hashes cover the specified q3dm1/mpteam1 cases, not every retail map.
test.skipIf(dataPath === undefined)("retail owner matches 1,180 native route, physics, collision and action recordings", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const maps: readonly { readonly product: "baseq3" | "missionpack"; readonly map: string; readonly count: number; readonly hash: string }[] = [
    { product: "baseq3", map: "q3dm1", count: 624, hash: "341d5bd76536139e8cdc4acd89c2339e476fda822f27799ecb9385db17a45b71" },
    { product: "missionpack", map: "mpteam1", count: 556, hash: "7be01541ca6a1a100bbc703d6b453b4f479f0ff2ef485f4436253b09e28ae281" },
  ];
  for (const entry of maps) {
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: entry.product });
    const aasBytes = await vfs.read(`maps/${entry.map}.aas`), bspBytes = await vfs.read(`maps/${entry.map}.bsp`);
    const world = parseAas(aasBytes), env = fixture(world, parseBsp(bspBytes), true), inputs: number[][] = [], outputs: number[][] = [];
    for (const area of world.areas.slice(1, 129)) {
      for (const type of [1, 2, 4]) inputs.push([0,0,2,2,type,.1,300,area.center.x,area.center.y,area.center.z,0,0,0,1,.2,0]);
      const settings = required(world.areaSettings[area.areaNumber]); if (settings.reachableAreaCount === 0) continue;
      const reach = required(world.reachability[settings.firstReachableArea]); if (reach.area === 0) continue;
      inputs.push([5,0,2,2,reach.area,.1,300,area.center.x,area.center.y,area.center.z,0,0,0,reach.end.x,reach.end.y,reach.end.z]);
      for (const time of [.1,5.01,11.02]) inputs.push([6,0,2,2,reach.area,.1,time,area.center.x,area.center.y,area.center.z,0,0,0,reach.end.x,reach.end.y,reach.end.z]);
    }
    let execution = env.createExecution();
    for (const row of inputs) {
      const mode = required(row[0]), type = required(row[4]), think = f(required(row[5])), speed = f(required(row[6]));
      if (mode === 6) { execution.actions.resetInput(0); env.time(speed); }
      else { env.states.reset(env.handle); execution = env.createExecution(); env.time(0); }
      const origin = vec3(required(row[7]), required(row[8]), required(row[9]));
      const velocity = vec3(required(row[10]), required(row[11]), required(row[12]));
      const direction = vec3(required(row[13]), required(row[14]), required(row[15]));
      env.states.initialize(env.handle, { origin, velocity, viewOffset: zero, entityNum: -1, client: 0, thinkTime: think,
        presenceType: 2, viewAngles: zero, orMoveFlags: required(row[2]) });
      if (mode === 0) {
        const success = execution.movement.moveInDirection(env.handle, direction, speed, type), input = execution.actions.getInput(0, think);
        outputs.push([Number(success), env.state.moveFlags, bits(input.speed), input.actionFlags, input.weapon, ...vectorBits(input.direction)]);
      } else {
        const result = new BotMoveResult(); execution.movement.moveToGoal(result, env.handle, goal(type, direction), TravelFlags.DEFAULT);
        const state = env.state, input = execution.actions.getInput(0, think);
        outputs.push([Number(result.failure), result.type, Number(result.blocked), result.blockEntity, result.travelType, result.flags,
          state.lastReachability, state.area, state.lastArea, state.lastGoalArea, bits(state.reachabilityTime), state.avoidReach[0], bits(state.avoidReachTimes[0]),
          state.avoidReachTries[0], bits(input.speed), input.actionFlags, ...vectorBits(state.lastOrigin), ...vectorBits(input.direction)]);
      }
    }
    expect(inputs.length).toBe(entry.count); expect(env.messages).toEqual([]);
    const text = outputs.map(row => JSON.stringify(row)).join("\n") + "\n";
    if (oracle !== undefined) {
      const directory = await mkdtemp(join(tmpdir(), "q3-bot-owner-retail-"));
      try {
        const aasPath = join(directory, "map.aas"), bspPath = join(directory, "map.bsp"); await writeFile(aasPath, aasBytes); await writeFile(bspPath, bspBytes);
        const recorded = Bun.spawnSync([oracle, aasPath, bspPath], { stdin: new TextEncoder().encode(inputs.map(row => row.join(" ")).join("\n") + "\n") });
        expect(recorded.exitCode).toBe(0); expect(new TextDecoder().decode(recorded.stderr)).toBe("");
        const lines = new TextDecoder().decode(recorded.stdout).trim().split("\n"); expect(lines.length).toBe(outputs.length);
        for (const [index, row] of outputs.entries()) expect(JSON.stringify(row), `${entry.map} case${index} input${JSON.stringify(inputs[index])}`).toBe(required(lines[index]));
      } finally { await rm(directory, { recursive: true }); }
    }
    expect(createHash("sha256").update(text).digest("hex"), entry.map).toBe(entry.hash);
  }
});

test.skipIf(dataPath === undefined)("retail zero-count jump-pad area retains its source first-link fallback", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "missionpack" });
  const aasBytes = await vfs.read("maps/mpq3ctf4.aas"), bspBytes = await vfs.read("maps/mpq3ctf4.bsp");
  const world = parseAas(aasBytes), map = parseBsp(bspBytes), area = 2207, settings = required(world.areaSettings[area]);
  expect(settings.reachableAreaCount).toBe(0); expect(settings.firstReachableArea).toBe(1715);
  const reach = required(world.reachability[1715]), rows: number[][] = [];
  for (let scenario = 0; scenario < 3; scenario++) {
    const env = fixture(world,map,true); env.state.moveFlags = 0; env.state.origin = required(world.areas[area]).center;
    const destination = goal(reach.area,reach.end), flags = scenario === 1 ? 0 : TravelFlags.DEFAULT;
    const selected = env.routing.getReachabilityToGoal({ origin: env.state.origin, area, lastGoalArea: 0, lastArea: 0,
      avoid: env.state, goal: destination, travelFlags: flags, moveTravelFlags: scenario === 2 ? TravelFlags.DEFAULT : TravelFlags.JUMPPAD,
      avoidSpots: env.state.avoidSpots, numAvoidSpots: 0, flags: 0 }).reachability;
    expect(env.spatial.movement.onGround(env.state.origin,2,-1)).toBe(false);
    const result = new BotMoveResult(); env.movement.moveToGoal(result,env.handle,destination,flags);
    const input = env.actions.getInput(0,.1);
    const row = [scenario,area,1715,selected,0,env.state.lastReachability,env.state.lastArea,Number(result.failure),result.travelType,
      result.flags,bits(input.speed),input.actionFlags,...vectorBits(input.direction),...vectorBits(env.state.origin)];
    expect(row).toEqual([scenario,2207,1715,scenario === 2 ? 1715 : 0,0,1715,2207,0,18,0,1137180672,0,
      1015683906,1065350833,0,1150287872,3274131721,1132078711]);
    expect(env.messages).toEqual([]); rows.push(row);
  }
  const zeroCountOracle = process.env["Q3_BOT_MOVEMENT_ZERO_COUNT_ORACLE"];
  if (zeroCountOracle !== undefined) {
    const directory = await mkdtemp(join(tmpdir(),"q3-bot-zero-count-"));
    try {
      const aasPath = join(directory,"map.aas"), bspPath = join(directory,"map.bsp"); await writeFile(aasPath,aasBytes); await writeFile(bspPath,bspBytes);
      const native = Bun.spawnSync([zeroCountOracle,aasPath,bspPath,String(area)]);
      expect(native.exitCode).toBe(0); expect(new TextDecoder().decode(native.stderr)).toBe("");
      expect(new TextDecoder().decode(native.stdout)).toBe(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    } finally { await rm(directory,{ recursive: true }); }
  }
});
