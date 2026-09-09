import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { parseAas } from "../src/botlib/aas.ts";
import type { AasReachability, AasWorld } from "../src/botlib/aas.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import { BotActionBuffer, BotActionFlag } from "../src/botlib/actions.ts";
import { BotMovement } from "../src/botlib/movement.ts";
import type { BotMovementHost, BotTravelContext } from "../src/botlib/movement.ts";
import { BotMovementRouting } from "../src/botlib/movement-routing.ts";
import { BotMoveFlag, BotMoveResult, BotMoveResultFlag, BotMoveStateStore } from "../src/botlib/movement-state.ts";
import { finishTravelElevator, finishTravelFuncBobbing, finishTravelWeaponJump, resetGrapple, resetGrappleCalls,
  travelBFGJump, travelElevator, travelFuncBobbing, travelGrapple, travelGrappleCalls, travelRocketJump } from "../src/botlib/movement-travel-special.ts";
import { AasRouting, TravelFlags, TravelType } from "../src/botlib/routing.ts";
import { AasSpatial, BotBrushModelTypes } from "../src/botlib/spatial.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import type { AasSpatialHost } from "../src/botlib/spatial.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { add3, vec3 } from "../src/core/math.ts";
import type { Bounds, Vec3 } from "../src/core/math.ts";
import { runCalls, waitForCall } from "../src/core/call-steps.ts";
import type { CallSteps } from "../src/core/call-steps.ts";

function linkHeap(): AasLinkHeap {
  const heap = new AasLinkHeap(() => { throw new Error("Unexpected empty AAS fixture link heap"); });
  heap.initialize(() => 6144);
  return heap;
}

const f32 = Math.fround, zero = vec3(0, 0, 0);
const outer: Bounds = { min: vec3(-10000, -10000, -10000), max: vec3(10000, 10000, 10000) };
function at<T>(values: readonly T[], index: number): T { const value = values[index]; if (value === undefined) throw new Error(`Missing special fixture ${index}`); return value; }
function bits(value: number): number { const bytes = new DataView(new ArrayBuffer(4)); bytes.setFloat32(0, value, true); return bytes.getUint32(0, true); }
function fromBits(value: number): number { const bytes = new DataView(new ArrayBuffer(4)); bytes.setUint32(0, value, true); return bytes.getFloat32(0, true); }
function vectorBits(value: Vec3): string { return `${bits(value.x)} ${bits(value.y)} ${bits(value.z)}`; }

// This boundary supplies the native math contract. Owner integration below and
// bot-movement.test.ts exercise the single production implementation separately.
function nativeAngles(value: Vec3): Vec3 {
  let yaw: number, pitch: number;
  if (value.x === 0 && value.y === 0) { yaw = 0; pitch = value.z > 0 ? 90 : 270; }
  else {
    yaw = value.x !== 0 ? f32(Math.atan2(value.y, value.x) * 180 / Math.PI) : value.y > 0 ? 90 : 270;
    if (yaw < 0) yaw = f32(yaw + 360);
    const forward = f32(Math.sqrt(f32(f32(value.x * value.x) + f32(value.y * value.y))));
    pitch = f32(Math.atan2(value.z, forward) * 180 / Math.PI);
    if (pitch < 0) pitch = f32(pitch + 360);
  }
  return vec3(-pitch, yaw, 0);
}

function emptyBsp(): BspMap {
  const model = { bounds: outer, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 };
  return { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds: outer, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [model, model], brushes: [], brushSides: [], vertices: [], indices: [],
    fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}
function reachability(): AasReachability {
  return { area: 2, face: 1, edge: 0, start: vec3(0, 0, 24), end: vec3(100, 0, 128), travelType: 0, travelTime: 10, padding: 0 };
}
function fixture() {
  const calls: string[] = [], helpers: string[] = [], actionCalls: string[] = [];
  const control = { onMover: false, modelPresent: true, hook: false, pointArea: 1, blocked: false, wall: false, time: 10,
    moverOrigin: zero, modelMin: vec3(-32, -24, -8), modelMax: vec3(32, 24, 0), offhand: 0, barrier: false,
    air: { controlled: true, direction: vec3(fromBits(1065061267), fromBits(3191747372), 0), speed: fromBits(1137704960) } };
  const map = emptyBsp(), collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const reaches = Array.from({ length: 8 }, reachability);
  const areaSettings = Array.from({ length: 3 }, (_, area) => ({ contents: 0, flags: area === 0 ? 0 : 1, presenceType: area === 0 ? 0 : 6,
    cluster: area === 0 ? 0 : 1, clusterAreaNumber: area - 1, reachableAreaCount: area === 1 ? 1 : 0, firstReachableArea: area === 1 ? 7 : 0 }));
  const areas = areaSettings.map((_, area) => ({ areaNumber: area, faceCount: 0, firstFace: 0, bounds: outer, center: zero }));
  const world: AasWorld = { source: "special-travel-boundary", version: 5, bspChecksum: 0, bboxes: [], vertices: [],
    planes: [{ normal: vec3(0, 0, 1), distance: 0, type: 2 }, { normal: vec3(0, 0, -1), distance: -0, type: 2 }], edges: [], edgeIndexes: [],
    faces: [], faceIndexes: [], areas, areaSettings, reachability: reaches,
    nodes: [{ plane: 0, children: [0, 0] }, { plane: 0, children: [-1, -1] }], portals: [], portalIndex: [],
    clusters: [{ areaCount: 0, reachabilityAreaCount: 0, portalCount: 0, firstPortal: 0 }, { areaCount: 2, reachabilityAreaCount: 2, portalCount: 0, firstPortal: 0 }],
    pointArea: point => { calls.push(`POINT ${vectorBits(point)}`); return control.pointArea; },
    areaReachabilities: area => area === 1 ? [at(reaches, 7)] : [], areaBounds: area => at(areas, area).bounds };
  const spatialHost: AasSpatialHost = {
    print: text => { calls.push(`PRINT 1 ${text.trimEnd()}`); },
    trace: (start, end, box, pass, mask) => {
      calls.push(`TRACE ${pass} ${mask} ${box === null ? 0 : 1} ${vectorBits(start)} ${vectorBits(end)}${box === null ? "" : ` ${vectorBits(box.min)} ${vectorBits(box.max)}`}`);
      const trace = collision.trace({ start, end, shape: box === null ? { kind: "point" } : { kind: "box", mins: box.min, maxs: box.max }, mask });
      if (box === null && control.wall) return { ...trace, fraction: 0.5, end: vec3((start.x + end.x) * 0.5, (start.y + end.y) * 0.5, (start.z + end.z) * 0.5), entityNum: 1022 };
      return { ...trace, entityNum: box !== null && box.min.z === -8 && control.onMover ? 42 : 1023 };
    },
    pointContents: point => collision.pointContents(point),
    entityTrace: (entity, start, end, box, mask) => ({ ...collision.trace({ start, end, shape: { kind: "box", mins: box.min, maxs: box.max }, mask }), entityNum: entity }),
    entityModelIndex: entity => { calls.push(`MODEL ${entity}`); return entity === 42 ? 1 : 0; },
    modelBounds: model => { calls.push(`BOUNDS ${model}`); return { bounds: { min: control.modelMin, max: control.modelMax }, origin: vec3(50, 60, 70) }; },
  };
  const bspEntities = new AasBspEntities((_severity, text) => { spatialHost.print(text); });
  bspEntities.load(map.entities);
  const spatial = new AasSpatial(world, bspEntities, spatialHost, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), linkHeap(), { kind: "disabled" }, () => 0);
  const states = new BotMoveStateStore({ time: () => { calls.push(`TIME ${bits(control.time)}`); return control.time; },
    print: (severity, text) => { calls.push(`PRINT ${severity} ${text.trimEnd()}`); },
    libVar: (name, value) => name === "offhandgrapple" ? { get value() { return control.offhand; }, string: "0" }
      : { value: f32(Number(value)), string: name === "cmd_grappleon" ? "hook-on" : name === "cmd_grappleoff" ? "hook-off" : value },
    setBrushModelTypes: () => spatial.setBrushModelTypes(spatialHost.print) });
  states.setup();
  const handle = states.allocate(), state = states.fromHandle(handle);
  if (state === null) throw new Error("Missing special move state");
  state.entityNum = 7; state.presenceType = 2; state.thinkTime = f32(0.1); state.lastReachability = 7;
  state.reachArea = 1; state.area = 1; state.reachabilityTime = 15;
  const aasRouting = new AasRouting(world);
  aasRouting.initializeRouting(spatial, () => 16 * 1024 * 1024, () => control.time);
  const routing = new BotMovementRouting(states, spatial, aasRouting, {
    originOfMoverWithModelNum: model => { calls.push(`ORIGIN ${model}`); return control.modelPresent ? control.moverOrigin : null; },
    entityModelNum: spatialHost.entityModelIndex,
  });
  const actions = new class extends BotActionBuffer {
    override jump(client: number): void { actionCalls.push(`ACTION jump ${client}`); super.jump(client); }
    override attack(client: number): void { actionCalls.push(`ACTION attack ${client}`); super.attack(client); }
    override move(client: number, direction: Vec3, speed: number): void { actionCalls.push(`ACTION move ${client} ${bits(speed)} ${vectorBits(direction)}`); super.move(client, direction, speed); }
    override view(client: number, angles: Vec3): void { actionCalls.push(`ACTION view ${client} ${vectorBits(angles)}`); super.view(client, angles); }
    override selectWeapon(client: number, weapon: number): void { actionCalls.push(`ACTION weapon ${client} ${weapon}`); super.selectWeapon(client, weapon); }
  }(2, { *clientCommand(client, command): ReturnType<BotActionBuffer["commandCalls"]> { calls.push(`COMMAND ${client} ${command}`); } });
  const host: BotMovementHost = {
    random: { nextInt: () => { throw new Error("Special travel must not consume random"); } }, developer: () => false,
    nextEntity: after => { calls.push(`NEXT ${after}`); return after < 3 ? after + 1 : 0; },
    entityType: entity => { calls.push(`TYPE ${entity}`); return entity === 1 ? 1 : 3; },
    entityWeapon: entity => { calls.push(`WEAPON ${entity}`); return entity === 3 && control.hook ? 10 : 5; },
  };
  // Recorded helper boundaries isolate these handlers. They do not claim to
  // verify owner-private barrier, blocked or air-control algorithms.
  const context: BotTravelContext = { routing, actions, host, vectorToAngles: nativeAngles,
    variable: name => { const value = states[name]; if (value === null) throw new Error(`Unset special variable ${name}`); return value; },
    gapDistance: () => { throw new Error("Special travel does not query gap distance"); },
    checkBarrierJump: (current, direction, speed) => {
      helpers.push(`BARRIER ${vectorBits(direction)} ${bits(speed)}`);
      if (control.barrier) { actions.jump(current.client); actions.move(current.client, direction, speed); current.moveFlags |= BotMoveFlag.BARRIERJUMP; }
      return control.barrier;
    },
    checkBlocked: (_current, direction, checkBottom, result) => {
      helpers.push(`BLOCKED ${vectorBits(direction)} ${checkBottom ? 1 : 0}`);
      if (control.blocked) { result.blocked = true; result.blockEntity = 43; }
    },
    airControl: (origin, velocity, goal) => { helpers.push(`CONTROL ${vectorBits(origin)} ${vectorBits(velocity)} ${vectorBits(goal)}`); return control.air; },
  };
  return { context, control, state, handle, calls, helpers, actionCalls, reaches, actions, routing, world, collision, spatial, states, host };
}

function runNativeCase(id: number) {
  const env = fixture(), { state, control, context } = env;
  let reach = reachability(), result: BotMoveResult;
  if (id < 9) {
    reach = { ...reach, travelType: TravelType.ELEVATOR };
    if (id < 3) { control.onMover = true; state.origin = vec3(id === 2 ? 5 : 20, 0, id === 0 ? 96.5 : 24); }
    if (id === 3) state.origin = vec3(99, 0, 120);
    if (id >= 4 && id <= 6) { state.origin = vec3(-80, 0, 24); control.moverOrigin = vec3(0, 0, id === 4 ? 64 : 0); }
    if (id === 6) state.moveFlags = BotMoveFlag.SWIMMING;
    if (id === 7) { state.origin = vec3(20, 0, 48); control.modelPresent = false; }
    if (id === 8) state.origin = vec3(20, 0, 120);
    result = id >= 7 ? finishTravelElevator(context, state, reach) : travelElevator(context, state, reach);
  } else if (id < 18) {
    reach = { ...reach, travelType: TravelType.FUNCBOB, face: 0x10001, edge: ((-64 & 0xffff) << 16) | 64 };
    if (id === 9) { control.onMover = true; control.moverOrigin = vec3(64, 0, 0); state.origin = vec3(64, 0, 24); }
    if (id === 10) { control.onMover = true; state.origin = vec3(20, 0, 24); }
    if (id === 11) state.origin = vec3(99, 0, 120);
    if (id === 12 || id === 13) { state.origin = vec3(-80, 0, 24); control.moverOrigin = vec3(id === 12 ? 0 : -64, 0, 0); }
    if (id === 14) { control.moverOrigin = vec3(60, 0, 0); state.origin = vec3(60, 0, 24); }
    if (id === 15) { reach = { ...reach, face: 0x20001 }; control.moverOrigin = vec3(0, -10, 0); state.origin = vec3(20, -10, 24); }
    if (id === 16) { reach = { ...reach, face: 1 }; control.moverOrigin = vec3(0, 0, 64); state.origin = vec3(20, 0, 48); }
    if (id === 17) { control.modelPresent = false; state.origin = vec3(99, 0, 120); }
    result = id >= 14 && id <= 16 ? finishTravelFuncBobbing(context, state, reach) : travelFuncBobbing(context, state, reach);
  } else if (id < 29 || id >= 39) {
    reach = { ...reach, travelType: TravelType.GRAPPLEHOOK, start: zero, end: vec3(100, 0, 0) };
    if (id === 18) { state.moveFlags = BotMoveFlag.GRAPPLERESET | BotMoveFlag.ACTIVEGRAPPLE; control.offhand = 1; }
    if (id === 19) state.origin = vec3(-100, -20, 0);
    if (id === 20) control.wall = true;
    if (id === 21) control.offhand = 1;
    if ((id >= 22 && id <= 27) || id >= 40) { state.moveFlags = BotMoveFlag.ACTIVEGRAPPLE; state.grappleVisibleTime = 10; state.lastGrappleDistance = 110; }
    if (id === 22 || id === 27) control.hook = true;
    if (id === 23) { state.grappleVisibleTime = 9; control.offhand = 1; }
    if (id === 24) { state.moveFlags |= BotMoveFlag.GRAPPLEPULL; state.lastGrappleDistance = 100; state.grappleVisibleTime = 9; }
    if (id === 25 || id === 26) { state.moveFlags |= BotMoveFlag.GRAPPLEPULL; state.origin = vec3(80, 0, 0); state.lastGrappleDistance = id === 25 ? 20 : 30; }
    if (id === 27) state.lastGrappleDistance = 90;
    if (id === 28) { control.pointArea = 2; control.blocked = true; state.origin = vec3(-10, 0, 0); }
    if (id === 39) control.offhand = 0.5;
    if (id === 40 || id === 41) state.grappleVisibleTime = f32(id === 40 ? 9.6 : 9.599999);
    result = travelGrapple(context, state, reach);
  } else if (id < 33) {
    reach = { ...reach, start: vec3(id === 29 ? 2 : 30, id === 30 ? 20 : 0, 24), end: vec3(100, 50, 200) };
    state.viewAngles = vec3(90, 0, 0);
    result = id === 31 ? travelBFGJump(context, state, reach) : travelRocketJump(context, state, reach);
  } else if (id < 35) {
    state.jumpReach = id === 33 ? 0 : 7; state.origin = vec3(0, 0, 100); state.velocity = vec3(30, 20, 200); reach = { ...reach, end: vec3(100, 0, 0) };
    result = finishTravelWeaponJump(context, state, reach);
  } else {
    state.lastReachability = id === 35 ? 0 : 7; state.moveFlags = id === 37 ? 0 : BotMoveFlag.ACTIVEGRAPPLE; state.grappleVisibleTime = 9;
    control.offhand = id === 38 ? 0 : 1;
    env.reaches[state.lastReachability] = { ...reach, travelType: id === 36 ? TravelType.GRAPPLEHOOK : 0 };
    resetGrapple(context, state); result = new BotMoveResult();
  }
  const input = env.actions.getInput(0, 0.1);
  const output = [`RESULT ${result.failure ? 1 : 0} ${result.type} ${result.blocked ? 1 : 0} ${result.blockEntity} ${result.travelType} ${result.flags}`
    + ` INPUT ${bits(input.speed)} ${input.actionFlags} ${input.weapon} ${vectorBits(input.direction)} ${vectorBits(input.viewAngles)}`
    + ` STATE ${state.moveFlags} ${state.jumpReach} ${bits(state.grappleVisibleTime)} ${bits(state.lastGrappleDistance)} ${bits(state.reachabilityTime)}`];
  if (result.flags & (BotMoveResultFlag.MOVEMENTVIEW | BotMoveResultFlag.MOVEMENTVIEWSET)) output.push(`ANGLE ${vectorBits(result.idealViewAngles)}`);
  if (result.flags & BotMoveResultFlag.MOVEMENTWEAPON) output.push(`WEAPONRESULT ${result.weapon}`);
  if ((id <= 17 && id !== 2 && id !== 7 && id !== 8) || id === 19 || id === 28 || (id >= 29 && id <= 34 && id !== 33)) output.push(`DIRECTION ${vectorBits(result.moveDirection)}`);
  return { ...env, reach, result, record: [...env.calls, ...output].join("|") };
}

// Untouched be_ai_move.c + be_ea.c/q_math.c, x64 GCC -O0, no fast math,
// no contraction, standard excess precision. Both products yielded these rows.
// Lower helper-internal AAS calls are excluded from the isolated-handler tape.
const nativeRecords: readonly string[] = [
  "BOUNDS 1|ORIGIN 1|TRACE 7 65537 1 1101004800 0 1123090432 1101004800 0 1111621632 3246391296 3246391296 3238002688 1098907648 1098907648 1090519040|MODEL 42|RESULT 0 0 0 0 0 0 INPUT 1137180672 0 0 1065353216 0 0 0 0 0 STATE 0 0 0 0 1097859072|DIRECTION 1065353216 0 0",
  "BOUNDS 1|ORIGIN 1|TRACE 7 65537 1 1101004800 0 1111490560 1101004800 0 3250585600 3246391296 3246391296 3238002688 1098907648 1098907648 1090519040|MODEL 42|BOUNDS 1|ORIGIN 1|RESULT 0 0 0 0 0 0 INPUT 1117782016 0 0 3212836864 0 0 0 0 0 STATE 0 0 0 0 1097859072|DIRECTION 3212836864 0 0",
  "BOUNDS 1|ORIGIN 1|TRACE 7 65537 1 1084227584 0 1111490560 1084227584 0 3250585600 3246391296 3246391296 3238002688 1098907648 1098907648 1090519040|MODEL 42|BOUNDS 1|ORIGIN 1|RESULT 0 0 0 0 0 0 INPUT 0 0 0 0 0 0 0 0 0 STATE 0 0 0 0 1097859072",
  "BOUNDS 1|ORIGIN 1|RESULT 0 0 0 0 0 0 INPUT 1111588480 0 0 1065353216 0 1090519040 0 0 0 STATE 0 0 0 0 0|DIRECTION 1065353216 0 1090519040",
  "BOUNDS 1|ORIGIN 1|BOUNDS 1|ORIGIN 1|RESULT 0 1 0 0 0 4 INPUT 1135869952 0 0 1065353216 0 0 0 0 0 STATE 0 0 0 0 1097859072|DIRECTION 1065353216 0 0",
  "BOUNDS 1|ORIGIN 1|BOUNDS 1|ORIGIN 1|BOUNDS 1|ORIGIN 1|RESULT 0 0 0 0 0 0 INPUT 1135869952 0 0 1065353216 0 0 0 0 0 STATE 0 0 0 0 1097859072|DIRECTION 1065353216 0 0",
  "BOUNDS 1|ORIGIN 1|BOUNDS 1|ORIGIN 1|BOUNDS 1|ORIGIN 1|RESULT 0 0 0 0 0 2 INPUT 0 0 0 0 0 0 0 0 0 STATE 4 0 0 0 1097859072|DIRECTION 1065353216 0 0",
  "BOUNDS 1|ORIGIN 1|PRINT 1 no entity with model 1|RESULT 0 0 0 0 0 0 INPUT 1133903872 0 0 1054316356 1062704964 3198974211 0 0 0 STATE 0 0 0 0 1097859072",
  "BOUNDS 1|ORIGIN 1|RESULT 0 0 0 0 0 0 INPUT 1133903872 0 0 1065269955 0 1036765340 0 0 0 STATE 0 0 0 0 1097859072",
  "ORIGIN 1|BOUNDS 1|BOUNDS 1|ORIGIN 1|TRACE 7 65537 1 1115684864 0 1111490560 1115684864 0 3250585600 3246391296 3246391296 3238002688 1098907648 1098907648 1090519040|MODEL 42|RESULT 0 0 0 0 0 0 INPUT 1137180672 0 0 1065353216 0 0 0 0 0 STATE 0 0 0 0 1097859072|DIRECTION 1065353216 0 0",
  "ORIGIN 1|BOUNDS 1|BOUNDS 1|ORIGIN 1|TRACE 7 65537 1 1101004800 0 1111490560 1101004800 0 3250585600 3246391296 3246391296 3238002688 1098907648 1098907648 1090519040|MODEL 42|BOUNDS 1|ORIGIN 1|RESULT 0 0 0 0 0 0 INPUT 1117782016 0 0 3212836864 0 0 0 0 0 STATE 0 0 0 0 1097859072|DIRECTION 3212836864 0 0",
  "ORIGIN 1|BOUNDS 1|BOUNDS 1|ORIGIN 1|RESULT 0 0 0 0 0 0 INPUT 1111588480 0 0 1065353216 0 1090519040 0 0 0 STATE 0 0 0 0 0|DIRECTION 1065353216 0 1090519040",
  "ORIGIN 1|BOUNDS 1|BOUNDS 1|ORIGIN 1|RESULT 0 2 0 0 0 4 INPUT 1135869952 0 0 1065353216 0 0 0 0 0 STATE 0 0 0 0 1097859072|DIRECTION 1065353216 0 0",
  "ORIGIN 1|BOUNDS 1|BOUNDS 1|ORIGIN 1|TRACE 7 65537 1 3265265664 0 1111490560 3265265664 0 3250585600 3246391296 3246391296 3238002688 1098907648 1098907648 1090519040|BOUNDS 1|ORIGIN 1|RESULT 0 0 0 0 0 0 INPUT 1119879168 0 0 1065353216 0 0 0 0 0 STATE 0 0 0 0 1097859072|DIRECTION 1065353216 0 0",
  "ORIGIN 1|BOUNDS 1|RESULT 0 0 0 0 0 0 INPUT 1131413504 0 0 3229614080 0 0 0 0 0 STATE 0 0 0 0 1097859072|DIRECTION 3229614080 0 0",
  "ORIGIN 1|BOUNDS 1|BOUNDS 1|ORIGIN 1|RESULT 0 0 0 0 0 0 INPUT 1117782016 0 0 3212836864 0 0 0 0 0 STATE 0 0 0 0 1097859072|DIRECTION 3212836864 0 0",
  "ORIGIN 1|BOUNDS 1|RESULT 0 0 0 0 0 0 INPUT 1135869952 0 0 0 0 3229614080 0 0 0 STATE 0 0 0 0 1097859072|DIRECTION 0 0 3229614080",
  "ORIGIN 1|PRINT 1 BotFuncBobStartEnd: no entity with model 1|BOUNDS 1|ORIGIN 1|PRINT 1 no entity with model 1|RESULT 0 0 0 0 0 0 INPUT 1111588480 0 0 1065353216 0 1090519040 0 0 0 STATE 0 0 0 0 0|DIRECTION 1065353216 0 1090519040",
  "COMMAND 0 hook-off|RESULT 0 0 0 0 0 0 INPUT 0 0 0 0 0 0 0 0 0 STATE 256 0 0 0 1097859072",
  "TIME 1092616192|POINT 3267887104 3248488448 0|RESULT 0 0 0 0 0 17 INPUT 1137180672 0 0 1065027414 1044959915 0 0 0 0 STATE 0 0 1092616192 0 1097859072|ANGLE 2147483648 1085717806 0|WEAPONRESULT 10|DIRECTION 1065027414 1044959915 0",
  "TIME 1092616192|TRACE 7 1 0 0 0 0 1120403456 0 0|RESULT 1 0 0 0 0 17 INPUT 0 0 0 0 0 0 0 0 0 STATE 0 0 1092616192 0 1097859072|ANGLE 2147483648 0 0|WEAPONRESULT 10",
  "TIME 1092616192|TRACE 7 1 0 0 0 0 1120403456 0 0|COMMAND 0 hook-on|POINT 0 0 0|RESULT 0 0 0 0 0 1 INPUT 0 0 0 0 0 0 0 0 0 STATE 128 0 1092616192 1232348144 1097859072|ANGLE 2147483648 0 0",
  "NEXT 0|TYPE 1|NEXT 1|TYPE 2|WEAPON 2|NEXT 2|TYPE 3|WEAPON 3|TIME 1092616192|RESULT 0 0 0 0 0 16 INPUT 0 1 0 0 0 0 0 0 0 STATE 128 0 1092616192 1120403456 1097859072|WEAPONRESULT 10",
  "NEXT 0|TYPE 1|NEXT 1|TYPE 2|WEAPON 2|NEXT 2|TYPE 3|WEAPON 3|NEXT 3|TIME 1092616192|COMMAND 0 hook-off|RESULT 0 0 0 0 0 0 INPUT 0 0 0 0 0 0 0 0 0 STATE 256 0 1091567616 1121714176 0",
  "TIME 1092616192|RESULT 0 0 0 0 0 16 INPUT 0 0 0 0 0 0 0 0 0 STATE 320 0 1091567616 1120403456 0|WEAPONRESULT 10",
  "RESULT 0 0 0 0 0 16 INPUT 0 0 0 0 0 0 0 0 0 STATE 320 0 1092616192 1101004800 0|WEAPONRESULT 10",
  "RESULT 0 0 0 0 0 16 INPUT 0 1 0 0 0 0 0 0 0 STATE 192 0 1092616192 1101004800 1097859072|WEAPONRESULT 10",
  "NEXT 0|TYPE 1|NEXT 1|TYPE 2|WEAPON 2|NEXT 2|TYPE 3|WEAPON 3|TIME 1092616192|RESULT 0 0 0 0 0 16 INPUT 0 1 0 0 0 0 0 0 0 STATE 128 0 1092616192 1120403456 1097859072|WEAPONRESULT 10",
  "TIME 1092616192|POINT 3240099840 0 0|RESULT 0 0 1 43 0 17 INPUT 1109393408 0 0 1065353216 0 0 0 0 0 STATE 0 0 1092616192 0 0|ANGLE 2147483648 0 0|WEAPONRESULT 10|DIRECTION 1065353216 0 0",
  "RESULT 0 0 0 0 0 24 INPUT 1137180672 17 5 1063581998 1055193390 0 1119092736 1104446778 0 STATE 0 7 0 0 1097859072|ANGLE 1119092736 1104446778 0|WEAPONRESULT 5|DIRECTION 1063581998 1055193390 0",
  "RESULT 0 0 0 0 0 24 INPUT 1127499534 0 5 1062535488 1057882326 0 1119092736 1107739298 0 STATE 0 0 0 0 1097859072|ANGLE 1119092736 1107739298 0|WEAPONRESULT 5|DIRECTION 1062535488 1057882326 0",
  "RESULT 0 0 0 0 0 24 INPUT 1125515264 0 9 1065353216 0 0 1119092736 0 0 STATE 0 0 0 0 1097859072|ANGLE 1119092736 0 0|WEAPONRESULT 9|DIRECTION 1065353216 0 0",
  "RESULT 0 0 0 0 0 24 INPUT 1125515264 0 5 1065353216 0 0 1119092736 0 0 STATE 0 0 0 0 1097859072|ANGLE 1119092736 0 0|WEAPONRESULT 5|DIRECTION 1065353216 0 0",
  "RESULT 0 0 0 0 0 0 INPUT 0 0 0 0 0 0 0 0 0 STATE 0 0 0 0 1097859072",
  "RESULT 0 0 0 0 0 0 INPUT 1137180672 0 0 1065061267 3191747372 0 0 0 0 STATE 0 7 0 0 1097859072|DIRECTION 1065061267 3191747372 0",
  "COMMAND 0 hook-off|RESULT 0 0 0 0 0 0 INPUT 0 0 0 0 0 0 0 0 0 STATE 0 0 0 0 1097859072",
  "RESULT 0 0 0 0 0 0 INPUT 0 0 0 0 0 0 0 0 0 STATE 128 0 1091567616 0 1097859072",
  "COMMAND 0 hook-off|RESULT 0 0 0 0 0 0 INPUT 0 0 0 0 0 0 0 0 0 STATE 0 0 0 0 1097859072",
  "RESULT 0 0 0 0 0 0 INPUT 0 0 0 0 0 0 0 0 0 STATE 0 0 0 0 1097859072",
  "TIME 1092616192|TRACE 7 1 0 0 0 0 1120403456 0 0|COMMAND 0 hook-on|POINT 0 0 0|RESULT 0 0 0 0 0 17 INPUT 0 0 0 0 0 0 0 0 0 STATE 128 0 1092616192 1232348144 1097859072|ANGLE 2147483648 0 0|WEAPONRESULT 10",
  "NEXT 0|TYPE 1|NEXT 1|TYPE 2|WEAPON 2|NEXT 2|TYPE 3|WEAPON 3|NEXT 3|TIME 1092616192|RESULT 0 0 0 0 0 16 INPUT 0 1 0 0 0 0 0 0 0 STATE 128 0 1092196762 1120403456 1097859072|WEAPONRESULT 10",
  "NEXT 0|TYPE 1|NEXT 1|TYPE 2|WEAPON 2|NEXT 2|TYPE 3|WEAPON 3|NEXT 3|TIME 1092616192|RESULT 0 0 0 0 0 16 INPUT 0 0 0 0 0 0 0 0 0 STATE 256 0 1092196761 1121714176 0|WEAPONRESULT 10",
];

describe("native special-travel branch recordings", () => {
  for (let id = 0; id < nativeRecords.length; id++) {
    test(`matches source case ${id} actions, state and ordered direct boundaries`, () => {
      expect(runNativeCase(id).record).toBe(at(nativeRecords, id));
    });
  }
});

test("1000 defined weapon approaches match native words through the actual movement owner", () => {
  let seed = 12345;
  function random(): number { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return f32((seed / 4294967296 - 0.5) * 4000); }
  function randomVector(): Vec3 { return vec3(random(), random(), random()); }
  const lines: string[] = [];
  for (let index = 0; index < 1000; index++) {
    const env = fixture(), { state } = env;
    state.origin = randomVector();
    const reach = { ...reachability(), start: randomVector(), end: randomVector(), travelType: index % 2 === 0 ? TravelType.ROCKETJUMP : TravelType.BFGJUMP };
    state.viewAngles = vec3(90, random(), 0);
    state.moveFlags = BotMoveFlag.ONGROUND; state.lastArea = 1; state.lastGoalArea = 2;
    env.reaches[7] = reach;
    const owner = new BotMovement(env.routing, env.actions, env.host), result = new BotMoveResult();
    owner.moveToGoal(result, env.handle, { area: 2, origin: reach.end, mins: zero, maxs: zero, entity: 0, number: 0, flags: 0, itemInfo: 0 },
      TravelFlags.DEFAULT | TravelFlags.ROCKETJUMP | TravelFlags.BFGJUMP);
    const input = env.actions.getInput(0, 0.1);
    expect(result.failure).toBe(false);
    expect(result.travelType).toBe(reach.travelType);
    lines.push(`${result.flags} ${input.weapon} ${input.actionFlags} ${bits(input.speed)} ${vectorBits(input.direction)} ${vectorBits(input.viewAngles)}`);
  }
  expect(createHash("sha256").update(lines.join("\n") + "\n").digest("hex"))
    .toBe("71b76f03b695483a24cc43cb1bc6a3ab642f069533ac4a504a35b78ca8e96e77");
});

describe("approved undefined-source policies", () => {
  test("corrected BFG aim uses the initialized downward view and keeps the original post-action aim", () => {
    for (const view of [vec3(90, 0, 0), vec3(85, 0, 0), vec3(90, 5, 0), vec3(90, 359, 0)]) {
      const env = fixture(); env.state.viewAngles = view;
      const result = travelBFGJump(env.context, env.state, { ...reachability(), start: vec3(2, 0, 0), end: vec3(0, 100, 200) });
      const jumped = view.x === 90 && view.y !== 5, input = env.actions.getInput(0, 0.1);
      expect(input.actionFlags).toBe(jumped ? BotActionFlag.JUMP | BotActionFlag.ATTACK : 0);
      expect(input.speed).toBe(jumped ? 400 : 10);
      expect(env.state.jumpReach).toBe(jumped ? 7 : 0);
      expect(result.idealViewAngles).toEqual(vec3(90, jumped ? 90 : 0, 0));
      expect(input.viewAngles).toEqual(result.idealViewAngles);
      expect(input.weapon).toBe(9);
    }
  });
  test("missing bob origin rejects at consumption, retaining diagnostics and the defined near-end return", () => {
    const env = fixture(); env.control.modelPresent = false;
    expect(() => travelFuncBobbing(env.context, env.state, reachability())).toThrow("consumes an undefined mover origin");
    expect(env.calls).toEqual(["ORIGIN 1", "PRINT 1 BotFuncBobStartEnd: no entity with model 1", "BOUNDS 1", "ORIGIN 1", "PRINT 1 no entity with model 1"]);
    expect(env.state.reachabilityTime).toBe(15); expect(env.actions.getInput(0, 0.1).speed).toBe(0);
    env.calls.length = 0;
    expect(() => finishTravelFuncBobbing(env.context, env.state, reachability())).toThrow("consumes an undefined mover origin");
    expect(env.calls).toEqual(["ORIGIN 1", "PRINT 1 BotFuncBobStartEnd: no entity with model 1"]);
    env.state.origin = vec3(99, 0, 120);
    expect(travelFuncBobbing(env.context, env.state, reachability()).failure).toBe(false);
    expect(env.state.reachabilityTime).toBe(0);
    expect(vectorBits(env.actions.getInput(0, 0.1).direction)).toBe("1065353216 0 1090519040");
  });
});

describe("special travel boundaries and ownership", () => {
  test("each offhand command suspends before its following grapple state writes", async () => {
    for (const branch of ["reset", "travel-reset", "close", "invisible", "launch"]) {
      const env = fixture(), { state } = env;
      const reach = { ...reachability(), start: zero, end: vec3(100, 0, 0), travelType: TravelType.GRAPPLEHOOK };
      env.control.offhand = 1;
      state.grappleVisibleTime = 9;
      state.moveFlags = branch === "launch" ? 0 : BotMoveFlag.ACTIVEGRAPPLE;
      if (branch === "travel-reset") state.moveFlags |= BotMoveFlag.GRAPPLERESET;
      if (branch === "close") {
        state.origin = vec3(80, 0, 0); state.lastGrappleDistance = 20; state.moveFlags |= BotMoveFlag.GRAPPLEPULL;
      }
      const beforeFlags = state.moveFlags, beforeDistance = state.lastGrappleDistance;
      const gate = Promise.withResolvers<undefined>(), commands: string[] = [];
      const actions = new BotActionBuffer(2, {
        *clientCommand(client, command): CallSteps<undefined> {
          expect(client).toBe(state.client);
          commands.push(command);
          yield* waitForCall(() => gate.promise);
        },
      });
      const context: BotTravelContext = { ...env.context, actions };
      const result = branch === "reset" ? runCalls(resetGrappleCalls(context, state)) : runCalls(travelGrappleCalls(context, state, reach));
      expect(result).toBeInstanceOf(Promise);
      expect(commands).toEqual([branch === "launch" ? "hook-on" : "hook-off"]);
      expect(state.moveFlags).toBe(beforeFlags);
      expect(state.reachabilityTime).toBe(15);
      expect(state.lastGrappleDistance).toBe(beforeDistance);
      expect(env.calls.some(call => call.startsWith("POINT"))).toBe(false);
      gate.resolve(undefined);
      await result;
      expect(commands).toHaveLength(1);
      expect(state.moveFlags & BotMoveFlag.ACTIVEGRAPPLE).toBe(branch === "launch" ? BotMoveFlag.ACTIVEGRAPPLE : 0);
      if (branch === "reset") expect(state.grappleVisibleTime).toBe(0);
      if (branch === "close" || branch === "invisible") {
        expect(state.moveFlags & BotMoveFlag.GRAPPLERESET).toBe(BotMoveFlag.GRAPPLERESET);
        expect(state.reachabilityTime).toBe(0);
      }
      if (branch === "launch") {
        expect(state.lastGrappleDistance).toBe(999999);
        expect(env.calls.at(-1)).toBe("POINT 0 0 0");
      }
    }
  });

  test("rejected offhand launch retains pre-command writes without activating or querying the area", async () => {
    const env = fixture(), failure = new Error("GAME_CLIENT_COMMAND failed");
    env.control.offhand = 1;
    const actions = new BotActionBuffer(2, {
      *clientCommand(): CallSteps<undefined> { yield* waitForCall(() => Promise.reject(failure)); },
    });
    const result = runCalls(travelGrappleCalls({ ...env.context, actions }, env.state,
      { ...reachability(), start: zero, end: vec3(100, 0, 0), travelType: TravelType.GRAPPLEHOOK }));
    await expect(result).rejects.toBe(failure);
    expect(env.state.grappleVisibleTime).toBe(10);
    expect(env.state.moveFlags).toBe(0);
    expect(env.state.lastGrappleDistance).toBe(0);
    expect(env.calls.some(call => call.startsWith("POINT"))).toBe(false);
  });

  test("grapple reset zeroes absent reach numbers but respects an existing slot zero", () => {
    for (const number of [-1, 42]) {
      const env = fixture(); env.state.lastReachability = number; env.state.moveFlags = BotMoveFlag.ACTIVEGRAPPLE; env.state.grappleVisibleTime = 9; env.control.offhand = 1;
      resetGrapple(env.context, env.state);
      expect(env.calls).toEqual(["COMMAND 0 hook-off"]); expect(env.state.moveFlags).toBe(0); expect(env.state.grappleVisibleTime).toBe(0);
    }
    const env = fixture(); env.state.lastReachability = 0; env.state.moveFlags = BotMoveFlag.ACTIVEGRAPPLE;
    env.reaches[0] = { ...reachability(), travelType: TravelType.GRAPPLEHOOK };
    resetGrapple(env.context, env.state);
    expect(env.state.moveFlags).toBe(BotMoveFlag.ACTIVEGRAPPLE); expect(env.calls).toEqual([]);
  });
  test("elevator barrier action is not overwritten and the integer height threshold is strict", () => {
    const env = fixture(); env.control.onMover = true; env.control.barrier = true; env.state.origin = vec3(20, 0, 96.5);
    const result = travelElevator(env.context, env.state, reachability());
    expect(env.actions.getInput(0, 0.1).speed).toBe(100);
    expect(env.state.moveFlags).toBe(BotMoveFlag.BARRIERJUMP); expect(result.moveDirection).toEqual(vec3(1, 0, 0));
    env.actions.resetInput(0); env.helpers.length = 0; env.state.origin = vec3(20, 0, 96);
    travelElevator(env.context, env.state, reachability());
    expect(env.helpers).toEqual([]); expect(env.actions.getInput(0, 0.1).speed).toBe(80);
  });
  test("weapon finish does nothing before jump and falls back to horizontal end direction when control fails", () => {
    const env = fixture();
    finishTravelWeaponJump(env.context, env.state, reachability()); expect(env.helpers).toEqual([]);
    env.state.jumpReach = 7; env.control.air = { controlled: false, direction: zero, speed: 1 };
    const result = finishTravelWeaponJump(env.context, env.state, { ...reachability(), end: vec3(0, 100, 200) });
    expect(result.moveDirection).toEqual(vec3(0, 1, 0)); expect(env.actions.getInput(0, 0.1).speed).toBe(400);
  });
  test("signed bob endpoints and source finish direction survive all three spawn axes", () => {
    for (const axis of [0, 1, 2]) {
      const env = fixture(); env.control.modelMin = zero; env.control.modelMax = zero;
      env.control.moverOrigin = axis === 0 ? vec3(-14, 0, 0) : axis === 1 ? vec3(0, -14, 0) : vec3(0, 0, -14);
      const result = finishTravelFuncBobbing(env.context, env.state,
        { ...reachability(), face: ((axis === 0 ? 1 : axis === 1 ? 2 : 0) << 16) | 1, edge: ((-100 & 0xffff) << 16) | (-10 & 0xffff) });
      expect(result.moveDirection).toEqual(axis === 0 ? vec3(-4, 0, 0) : axis === 1 ? vec3(0, -4, 0) : vec3(0, 0, -4));
      expect(env.actions.getInput(0, 0.1).speed).toBe(360);
    }
  });
  test("client action storage remains independent across repeated weapon jumps and live indexes", () => {
    const env = fixture(), other = fixture();
    env.state.client = 1; env.state.viewAngles = vec3(90, 0, 0);
    env.states.rocketLauncherIndex = { value: 6.75, string: "6.75" };
    const reach = { ...reachability(), start: vec3(2, 0, 0) };
    travelRocketJump(env.context, env.state, reach);
    expect(env.actions.getInput(1, 0.1).weapon).toBe(6);
    expect(env.actions.getInput(0, 0.1).weapon).toBe(0); expect(other.actions.getInput(1, 0.1).weapon).toBe(0);
    env.actions.resetInput(1); travelRocketJump(env.context, env.state, reach);
    expect(env.actions.getInput(1, 0.1).actionFlags & BotActionFlag.JUMP).toBe(0);
    expect(env.actions.getInput(1, 0.1).actionFlags & BotActionFlag.ATTACK).toBe(BotActionFlag.ATTACK);
    env.states.rocketLauncherIndex = { value: -0.5, string: "-0.5" };
    expect(travelRocketJump(env.context, env.state, reach).weapon).toBe(0);
    expect(env.actions.getInput(1, 0.1).weapon).toBe(0);
  });
});

const retailPath = Bun.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";

// Linker wrappers logged calls before forwarding to untouched original EA.
const nativeActionRecords: readonly string[] = [
  "ACTION move 0 1137180672 1065353216 0 0",
  "ACTION move 0 1117782016 3212836864 0 0",
  "",
  "ACTION move 0 1111588480 1065353216 0 1090519040",
  "ACTION move 0 1135869952 1065353216 0 0",
  "ACTION move 0 1135869952 1065353216 0 0",
  "",
  "ACTION move 0 1133903872 1054316356 1062704964 3198974211",
  "ACTION move 0 1133903872 1065269955 0 1036765340",
  "ACTION move 0 1137180672 1065353216 0 0",
  "ACTION move 0 1117782016 3212836864 0 0",
  "ACTION move 0 1111588480 1065353216 0 1090519040",
  "ACTION move 0 1135869952 1065353216 0 0",
  "ACTION move 0 1119879168 1065353216 0 0",
  "ACTION move 0 1131413504 3229614080 0 0",
  "ACTION move 0 1117782016 3212836864 0 0",
  "ACTION move 0 1135869952 0 0 3229614080",
  "ACTION move 0 1111588480 1065353216 0 1090519040",
  "",
  "ACTION move 0 1137180672 1065027414 1044959915 0",
  "",
  "",
  "ACTION attack 0",
  "",
  "",
  "",
  "ACTION attack 0",
  "ACTION attack 0",
  "ACTION move 0 1109393408 1065353216 0 0",
  "ACTION jump 0|ACTION attack 0|ACTION move 0 1145569280 1063581998 1055193390 0|ACTION view 0 1119092736 1104446778 0|ACTION weapon 0 5",
  "ACTION move 0 1127499534 1062535488 1057882326 0|ACTION view 0 1119092736 1107739298 0|ACTION weapon 0 5",
  "ACTION move 0 1125515264 1065353216 0 0|ACTION view 0 1119092736 0 0|ACTION weapon 0 9",
  "ACTION move 0 1125515264 1065353216 0 0|ACTION view 0 1119092736 0 0|ACTION weapon 0 5",
  "",
  "ACTION move 0 1137704960 1065061267 3191747372 0",
  "",
  "",
  "",
  "",
  "",
  "ACTION attack 0",
  "",
];

test("all42 native action sequences preserve call order and raw pre-clamp speed", () => {
  for (let id = 0; id < nativeActionRecords.length; id++) {
    expect(runNativeCase(id).actionCalls.join("|")).toBe(at(nativeActionRecords, id));
  }
});

test.skipIf(!existsSync(join(retailPath, "missionpack/pak0.pk3")))("retail AAS and BSP host grapple traces and the original mission-pack rocket route", async () => {
  const files = await VirtualFileSystem.openInspection({ dataPath: retailPath, homePath: retailPath, cdPath: null, product: "missionpack" });
  for (const mapName of ["q3dm1", "mpteam1"]) {
    const world = parseAas(await files.read(`maps/${mapName}.aas`)), map = parseBsp(await files.read(`maps/${mapName}.bsp`));
    const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" }), traces: number[] = [];
    const host: AasSpatialHost = {
      print: text => { throw new Error(text); },
      trace: (start, end, box, _pass, mask) => {
        traces.push(mask);
        const result = collision.trace({ start, end, shape: box === null ? { kind: "point" } : { kind: "box", mins: box.min, maxs: box.max }, mask });
        return { ...result, entityNum: result.fraction < 1 || result.solidity !== "clear" ? 1022 : 1023 };
      },
      pointContents: point => collision.pointContents(point),
      entityTrace: () => { throw new Error("Static retail fixture has no linked dynamic entities"); },
      entityModelIndex: () => { throw new Error("Static retail fixture must not query an entity model"); },
      modelBounds: model => ({ bounds: collision.modelBounds(model), origin: zero }),
    };
    const bspEntities = new AasBspEntities((_severity, text) => { host.print(text); });
    bspEntities.load(map.entities);
    const spatial = new AasSpatial(world, bspEntities, host, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), linkHeap(), { kind: "disabled" }, () => 0);
    const states = new BotMoveStateStore({ time: () => 10, print: (_severity, text) => { throw new Error(text); },
      libVar: (_name, value) => ({ value: f32(Number(value)), string: value }), setBrushModelTypes: () => spatial.setBrushModelTypes(host.print) });
    states.setup();
    const handle = states.allocate(), state = states.fromHandle(handle); if (state === null) throw new Error("Missing retail move state");
    const actions = new BotActionBuffer(1, { clientCommand: () => { throw new Error("No offhand command expected"); } });
    const aasRouting = new AasRouting(world);
    aasRouting.initializeRouting(spatial, () => 16 * 1024 * 1024, () => 10);
    const routing = new BotMovementRouting(states, spatial, aasRouting, { originOfMoverWithModelNum: () => null, entityModelNum: host.entityModelIndex });
    const movementHost: BotMovementHost = { random: { nextInt: () => { throw new Error("No random action expected"); } },
      developer: () => false, nextEntity: () => 0, entityType: () => { throw new Error("No dynamic entities"); }, entityWeapon: () => { throw new Error("No dynamic entities"); } };
    if (mapName === "q3dm1") {
      // This retail map has no special-travel reachabilities. Exercise the real
      // BSP grapple query without representing a fabricated route as map data.
      state.origin = at(world.areas, 175).center; state.entityNum = -1; state.presenceType = 2; state.reachArea = world.pointArea(state.origin);
      const context: BotTravelContext = { routing, actions, host: movementHost, vectorToAngles: nativeAngles,
        variable: name => { const value = states[name]; if (value === null) throw new Error(`Unset retail variable ${name}`); return value; },
        gapDistance: () => { throw new Error("No gap query on grapple launch"); },
        checkBarrierJump: () => { throw new Error("No barrier query on grapple launch"); },
        checkBlocked: () => { throw new Error("No blocked check on aligned grapple launch"); },
        airControl: () => { throw new Error("No air-control query on grapple launch"); } };
      const result = travelGrapple(context, state, { ...reachability(), start: state.origin, end: add3(state.origin, vec3(1, 0, 0)), travelType: TravelType.GRAPPLEHOOK });
      expect(result.failure).toBe(false); expect(state.moveFlags).toBe(BotMoveFlag.ACTIVEGRAPPLE);
      expect(actions.getInput(0, 0.1).actionFlags).toBe(BotActionFlag.ATTACK); expect(traces).toEqual([1]);
    } else {
      const number = world.reachability.findIndex(reach => reach.travelType === TravelType.ROCKETJUMP);
      expect(number).toBe(414);
      const reach = at(world.reachability, number);
      const area = world.areaSettings.findIndex(settings => number >= settings.firstReachableArea && number < settings.firstReachableArea + settings.reachableAreaCount);
      expect(area).toBe(337);
      states.initialize(handle, { origin: at(world.areas, area).center, velocity: zero, viewOffset: zero, entityNum: -1, client: 0, thinkTime: 0.1,
        presenceType: 2, viewAngles: zero, orMoveFlags: BotMoveFlag.ONGROUND });
      state.lastReachability = number; state.reachabilityTime = 20; state.lastGoalArea = reach.area; state.lastArea = area;
      const owner = new BotMovement(routing, actions, movementHost), result = new BotMoveResult();
      const goal = { area: reach.area, origin: reach.end, mins: zero, maxs: zero, entity: 0, number: 0, flags: 0, itemInfo: 0 };
      owner.moveToGoal(result, handle, goal, TravelFlags.DEFAULT | TravelFlags.ROCKETJUMP);
      expect(result.failure).toBe(false); expect(result.travelType).toBe(TravelType.ROCKETJUMP);
      expect(actions.getInput(0, 0.1).weapon).toBe(5); expect(state.lastReachability).toBe(number);
      state.viewAngles = result.idealViewAngles; actions.resetInput(0);
      owner.moveToGoal(result, handle, goal, TravelFlags.DEFAULT | TravelFlags.ROCKETJUMP);
      expect(state.jumpReach).toBe(number); expect(actions.getInput(0, 0.1).actionFlags).toBe(BotActionFlag.JUMP | BotActionFlag.ATTACK);
      expect(actions.getInput(0, 0.1).speed).toBe(400); expect(traces.length).toBeGreaterThan(0);
      expect(owner.routing.spatial).toBe(spatial); expect(owner.actions).toBe(actions);
    }
  }
}, 60_000);
