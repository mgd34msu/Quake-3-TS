import { describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { parseAas } from "../src/botlib/aas.ts";
import type { AasWorld, AasReachability } from "../src/botlib/aas.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import { BotActionBuffer, BotActionFlag } from "../src/botlib/actions.ts";
import type { BotInput } from "../src/botlib/actions.ts";
import { BotMoveFlag, BotMoveResult, BotMoveStateStore } from "../src/botlib/movement-state.ts";
import type { BotMoveState } from "../src/botlib/movement-state.ts";
import { BotMovementRouting } from "../src/botlib/movement-routing.ts";
import type { BotTravelContext } from "../src/botlib/movement.ts";
import { travelWalk, finishTravelWalk, travelCrouch, travelBarrierJump, finishTravelBarrierJump,
  travelSwim, travelWaterJump, finishTravelWaterJump, travelWalkOffLedge, finishTravelWalkOffLedge,
  travelJump, finishTravelJump, travelLadder, travelTeleport, travelJumpPad, finishTravelJumpPad } from "../src/botlib/movement-travel-ground.ts";
import { AasRouting, TravelType } from "../src/botlib/routing.ts";
import { AasSpatial, BotBrushModelTypes } from "../src/botlib/spatial.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import type { AasSpatialHost } from "../src/botlib/spatial.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import type { Bounds, Vec3 } from "../src/core/math.ts";

function linkHeap(): AasLinkHeap {
  const heap = new AasLinkHeap(() => { throw new Error("Unexpected empty AAS fixture link heap"); });
  heap.initialize(() => 6144);
  return heap;
}

const zero = vec3(0, 0, 0), f = Math.fround;
function at<T>(values: readonly T[], index: number): T {
  const value = values[index]; if (value === undefined) throw new Error(`Missing ground fixture index ${index}`); return value;
}
function bits(value: number): number { const bytes = new DataView(new ArrayBuffer(4)); bytes.setFloat32(0, value, true); return bytes.getUint32(0, true); }
function vectorBits(value: Vec3): number[] { return [bits(value.x), bits(value.y), bits(value.z)]; }
function pack(result: BotMoveResult, state: BotMoveState, input: BotInput, randomDraws: number, tape: readonly number[]): number[] {
  return [Number(result.failure), result.type, Number(result.blocked), result.blockEntity, result.travelType, result.flags,
    state.moveFlags, state.jumpReach, input.actionFlags, bits(input.speed), ...vectorBits(input.direction),
    ...vectorBits(result.moveDirection), ...vectorBits(result.idealViewAngles), randomDraws, ...tape];
}
type Handler = (context: BotTravelContext, state: BotMoveState, reach: AasReachability) => BotMoveResult;
const handlers: readonly Handler[] = [travelWalk, finishTravelWalk, travelCrouch, travelBarrierJump, finishTravelBarrierJump,
  travelSwim, travelWaterJump, finishTravelWaterJump, travelWalkOffLedge, finishTravelWalkOffLedge, travelJump,
  finishTravelJump, travelLadder, travelTeleport, travelJumpPad, finishTravelJumpPad];

// This callback is a controlled common-helper boundary. Full results are checked
// against native q_math.c recordings; owner tests exercise its production helper.
function nativeAngles(value: Vec3): Vec3 {
  let yaw: number, pitch: number;
  if (value.x === 0 && value.y === 0) { yaw = 0; pitch = value.z > 0 ? 90 : 270; }
  else {
    yaw = value.x !== 0 ? f(Math.atan2(value.y, value.x) * 180 / Math.PI) : value.y > 0 ? 90 : 270;
    if (yaw < 0) yaw = f(yaw + 360);
    const forward = f(Math.sqrt(f(f(value.x * value.x) + f(value.y * value.y))));
    pitch = f(Math.atan2(value.z, forward) * 180 / Math.PI);
    if (pitch < 0) pitch = f(pitch + 360);
  }
  return vec3(-pitch, yaw, 0);
}
const largeBounds: Bounds = { min: vec3(-10000, -10000, -10000), max: vec3(10000, 10000, 10000) };
function floorBsp(): BspMap {
  return {
    entities: "", entityRecords: [], shaders: [{ name: "floor", surfaceFlags: 0, contentFlags: 1 }],
    planes: [
      { normal: vec3(1, 0, 0), distance: 10000 }, { normal: vec3(-1, 0, 0), distance: 10000 },
      { normal: vec3(0, 1, 0), distance: 10000 }, { normal: vec3(0, -1, 0), distance: 10000 },
      { normal: vec3(0, 0, 1), distance: 0 }, { normal: vec3(0, 0, -1), distance: 10000 },
    ], nodes: [], leaves: [{ cluster: 0, area: 0, bounds: largeBounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    leafSurfaces: [], leafBrushes: [0], models: [{ bounds: largeBounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: Array.from({ length: 6 }, (_, plane) => ({ plane, shader: 0 })),
    vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null,
  };
}
function floorWorld(presence: () => number, pointArea: (point: Vec3) => number): AasWorld {
  const settings = [0, 1, 2].map(area => ({ contents: 0, flags: area === 0 ? 0 : 1,
    get presenceType() { return area === 2 ? presence() : area === 0 ? 0 : 6; }, cluster: 0, clusterAreaNumber: 0,
    reachableAreaCount: 0, firstReachableArea: 0 }));
  return { source: "ground-travel-floor", version: 5, bspChecksum: 0, vertices: [], edges: [], edgeIndexes: [], faces: [], faceIndexes: [],
    planes: [{ normal: vec3(0, 0, 1), distance: 0, type: 2 }, { normal: vec3(0, 0, -1), distance: -0, type: 2 }],
    nodes: [{ plane: 0, children: [0, 0] }, { plane: 0, children: [-1, 0] }],
    areas: [0, 1, 2].map(areaNumber => ({ areaNumber, faceCount: 0, firstFace: 0, bounds: largeBounds, center: vec3(0, 0, 24) })),
    areaSettings: settings, reachability: [], portals: [], portalIndex: [], clusters: [], bboxes: [], pointArea,
    areaReachabilities: () => [], areaBounds: () => largeBounds };
}
function fixture(world: AasWorld, map: BspMap, randomOffset = 0) {
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" }), tape: number[] = [], diagnostics: string[] = [];
  let randomCalls = randomOffset, traceCount = 0, contentsCount = 0;
  const host: AasSpatialHost = {
    print: text => { diagnostics.push(text); },
    trace(start, end, bounds, _pass, mask) {
      traceCount++;
      const result = collision.trace({ start, end, shape: bounds === null ? { kind: "point" } : { kind: "box", mins: bounds.min, maxs: bounds.max }, mask });
      return { ...result, entityNum: result.fraction < 1 || result.solidity !== "clear" ? 1022 : 1023 };
    },
    pointContents(point) { contentsCount++; return collision.pointContents(point); },
    entityTrace: () => { throw new Error("No entities are linked in ground travel fixtures"); },
    entityModelIndex: () => 0,
    modelBounds: model => ({ bounds: collision.modelBounds(model), origin: zero }),
  };
  const bspEntities = new AasBspEntities((_severity, text) => { host.print(text); });
  bspEntities.load(map.entities);
  const spatial = new AasSpatial(world, bspEntities, host, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), linkHeap(), { kind: "disabled" }, () => 0);
  const states = new BotMoveStateStore({ time: () => 10, print: (severity, text) => { diagnostics.push(`${severity}:${text}`); },
    libVar: (_name, value) => ({ string: value, value: f(Number(value)) }), setBrushModelTypes: () => spatial.setBrushModelTypes(host.print) });
  states.setup();
  const handle = states.allocate(), state = states.fromHandle(handle);
  if (state === null) throw new Error("Missing allocated movement state");
  states.initialize(handle, { origin: zero, velocity: zero, viewOffset: zero, entityNum: 7, client: 0,
    thinkTime: f(0.1), presenceType: 2, viewAngles: zero, orMoveFlags: 0 });
  const aasRouting = new AasRouting(world);
  aasRouting.initializeRouting(spatial, () => 16 * 1024 * 1024, () => 10);
  const routing = new BotMovementRouting(states, spatial, aasRouting, { originOfMoverWithModelNum: () => null, entityModelNum: host.entityModelIndex });
  const actions = new BotActionBuffer(2, { clientCommand: () => { throw new Error("Ground travel does not issue client commands"); } });
  const context: BotTravelContext = {
    routing, actions,
    host: { random: { nextInt: () => at([0, 16384, 32767, 0x10007, 8192], randomCalls++ % 5) },
      developer: () => false, nextEntity: () => 0, entityType: () => 0, entityWeapon: () => 0 },
    variable(name) { const value = states[name]; if (value === null) throw new Error("Movement variables not initialized"); return value; },
    vectorToAngles: nativeAngles,
    gapDistance: () => { throw new Error("No controlled gap boundary configured"); },
    checkBarrierJump: () => { throw new Error("These travel handlers do not query barrier jumps"); },
    checkBlocked: () => { throw new Error("No controlled obstruction boundary configured"); },
    airControl: () => { throw new Error("No controlled air-control boundary configured"); },
  };
  return { context, spatial, actions, states, state, handle, host, collision, tape, diagnostics,
    counts: () => ({ random: randomCalls - randomOffset, trace: traceCount, contents: contentsCount }) };
}

const v = vec3;
interface GroundCase {
  readonly name: string; readonly handler: number;
  readonly directionDefined: boolean; readonly anglesDefined: boolean;
  readonly moveFlags: number; readonly jumpReach: number; readonly seedFlags: number; readonly randomOffset: number;
  readonly origin: Vec3; readonly velocity: Vec3; readonly start: Vec3; readonly end: Vec3;
  readonly presence: number; readonly gap: number; readonly blockedEntity: number; readonly contents: number;
  readonly horizontalSuccess: boolean; readonly horizontalSpeed: number;
  readonly airSuccess: boolean; readonly airSpeed: number; readonly areaBreak: number;
  readonly airDirection: Vec3; readonly runStart: Vec3;
}
function c(name: string, handler: number, changes: Partial<GroundCase> = {}): GroundCase {
  return {name, handler, directionDefined:true, anglesDefined:false, moveFlags:0, jumpReach:0, seedFlags:0,randomOffset:0,
    origin:v(0,0,24), velocity:v(0,0,0), start:v(90,30,24), end:v(160,-20,24), presence:6,
    gap:0, blockedEntity:-1, contents:0, horizontalSuccess:true, horizontalSpeed:231.75,
    airSuccess:false, airSpeed:100, areaBreak:8, airDirection:v(.3,.4,.5), runStart:v(10,30,24), ...changes};
}
const groundCases: readonly GroundCase[] = [
  c('walk-far',0),
  c('walk-near-switches-end-after-block-check',0,{start:v(3,4,90),end:v(-6,8,24),presence:4,blockedEntity:17}),
  c('walk-gap-run',0,{gap:8}), c('walk-gap-walk',0,{gap:24,moveFlags:512}),
  c('walk-walking',0,{moveFlags:512}), c('walk-crouch-distance-20',0,{start:v(20,0,24),presence:4}),
  c('walk-zero-direction',0,{start:v(0,0,24),end:v(0,0,24)}),
  c('finish-walk-near',1,{end:v(23.375,-11.125,80)}), c('finish-walk-cap',1),
  c('crouch',2,{blockedEntity:23}),
  c('barrier-jump-near',3,{start:v(8.999,0,24)}),
  c('barrier-jump-exact-nine',3,{start:v(9,0,24)}), c('barrier-jump-speed-cap',3),
  c('barrier-jump-after-jump-reset',3,{start:v(3,4,24),seedFlags:128}),
  c('finish-barrier-ascending',4,{velocity:v(0,0,250),directionDefined:false}),
  c('finish-barrier-descending',4,{velocity:v(0,0,249.999),blockedEntity:11}),
  c('swim',5,{start:v(15.125,-20.375,67.125),anglesDefined:true}),
  c('swim-vertical',5,{start:v(0,0,-5),anglesDefined:true}),
  c('water-jump-near',6,{end:v(12,8,50),anglesDefined:true}),
  c('water-jump-distance-40',6,{end:v(40,0,50),anglesDefined:true}),
  c('water-jump-middle-random',6,{end:v(12,8,50),anglesDefined:true,randomOffset:1}),
  c('water-jump-masked-random',6,{end:v(12,8,50),anglesDefined:true,randomOffset:3}),
  c('finish-water-jumping',7,{moveFlags:16,directionDefined:false}),
  c('finish-water-dry',7,{directionDefined:false}),
  c('finish-water-wet',7,{contents:32,anglesDefined:true}),
  c('finish-water-lava',7,{contents:8,anglesDefined:true}),
  c('finish-water-shifted-random',7,{contents:16,anglesDefined:true,randomOffset:3}),
  c('ledge-close-vertical',8,{start:v(10,5,24),end:v(10,5,-100)}),
  c('ledge-close-horizontal',8,{start:v(10,5,24),end:v(90,10,-100)}),
  c('ledge-no-jump-velocity',8,{start:v(10,5,24),horizontalSuccess:false}),
  c('ledge-far-vertical',8,{start:v(55,0,24),end:v(55,0,-100)}),
  c('ledge-far-vertical-cap',8,{start:v(90,30,24),end:v(90,30,-100)}),
  c('ledge-far-horizontal',8),
  c('finish-ledge-air-control',9,{airSuccess:true,airSpeed:416,end:v(120,20,-100)}),
  c('finish-ledge-fallback',9,{end:v(10,5,-100)}),
  c('jump-run-start',10,{origin:v(120,60,24)}),
  c('jump-now',10,{start:v(80,0,24),end:v(180,0,24),runStart:v(0,0,24),origin:v(60,0,24)}),
  c('jump-delayed',10,{start:v(80,0,24),end:v(180,0,24),runStart:v(0,0,24),origin:v(52,0,24)}),
  c('jump-running',10,{start:v(80,0,24),end:v(180,0,24),runStart:v(0,0,24),origin:v(20,0,24)}),
  c('jump-at-run-start',10,{start:v(80,0,24),end:v(180,0,24),runStart:v(0,0,24),origin:v(0,0,24)}),
  c('jump-run-gap',10,{areaBreak:2}),
  c('finish-jump-not-jumped',11,{directionDefined:false}),
  c('finish-jump-overshot',11,{jumpReach:23,origin:v(170,-20,24),start:v(80,-20,24),directionDefined:false}),
  c('finish-jump-airborne',11,{jumpReach:23}),
  c('ladder-up',12,{anglesDefined:true,end:v(15.125,-20.375,167.125)}),
  c('ladder-down',12,{anglesDefined:true,end:v(0,0,-40)}),
  c('teleport-far',13),c('teleport-near',13,{start:v(10,20,100)}),
  c('teleport-swim',13,{start:v(10,20,100),moveFlags:4}),
  c('teleport-complete',13,{moveFlags:32,directionDefined:false}),
  c('jump-pad',14,{blockedEntity:29}),
  c('finish-jump-pad-control',15,{airSuccess:true,airSpeed:416}),
  c('finish-jump-pad-fallback',15),
];
function input(c: GroundCase): string {
  const vector = (value: Vec3) => [value.x,value.y,value.z];
  return [c.handler,Number(c.directionDefined),Number(c.anglesDefined),c.moveFlags,c.jumpReach,c.seedFlags,c.randomOffset,
    ...vector(c.origin),...vector(c.velocity),...vector(c.start),...vector(c.end),c.presence,c.gap,c.blockedEntity,c.contents,
    Number(c.horizontalSuccess),c.horizontalSpeed,Number(c.airSuccess),c.airSpeed,c.areaBreak,...vector(c.airDirection),...vector(c.runStart)].join(' ');
}

// GCC x86_64 native profile, 53 unchanged-handler recordings, identical for both products.
// be_ai_move.c SHA256 1e97578259e1a00b815252dd73b1625024df0b062d0bae0a89246a1d0f7b24e1.
// AAS/common-helper boundaries are controlled; EA and q_math are original source.
// Unassigned native result vectors are masked to the canonical result's zero value;
// those zero words document deterministic representation, not defined C outputs.
const nativeWords: readonly (readonly number[])[] = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1137180672, 1064492264, 1050798234, 0, 1064492264, 1050798234, 0, 0, 0, 0, 0, 2, 1064492264, 1050798234, 0, 1, 4, 2, 1, 0, 0, 1103101952, 1064492264, 1050798234, 0, 7],
  [0, 0, 1, 17, 0, 0, 0, 0, 128, 1137180672, 3206125978, 1061997773, 0, 3206125978, 1061997773, 0, 0, 0, 0, 0, 2, 1058642330, 1061997773, 0, 1, 4, 2, 1, 0, 0, 1103101952, 3206125978, 1061997773, 0, 7],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1113587712, 1064492264, 1050798234, 0, 1064492264, 1050798234, 0, 0, 0, 0, 0, 2, 1064492264, 1050798234, 0, 1, 4, 2, 1, 0, 0, 1103101952, 1064492264, 1050798234, 0, 7],
  [0, 0, 0, 0, 0, 0, 512, 0, 524288, 1110441984, 1064492264, 1050798234, 0, 1064492264, 1050798234, 0, 0, 0, 0, 0, 2, 1064492264, 1050798234, 0, 1, 4, 2, 1, 0, 0, 1103101952, 1064492264, 1050798234, 0, 7],
  [0, 0, 0, 0, 0, 0, 512, 0, 524288, 1128792064, 1064492264, 1050798234, 0, 1064492264, 1050798234, 0, 0, 0, 0, 0, 2, 1064492264, 1050798234, 0, 1, 4, 2, 1, 0, 0, 1103101952, 1064492264, 1050798234, 0, 7],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1137180672, 1065353216, 0, 0, 1065353216, 0, 0, 0, 0, 0, 0, 2, 1065353216, 0, 0, 1, 4, 2, 1, 0, 0, 1103101952, 1065353216, 0, 0, 7],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1137180672, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 1, 4, 2, 1, 0, 0, 1103101952, 0, 0, 0, 7],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1117475588, 1063724982, 3202090927, 0, 1063724982, 3202090927, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1133903872, 1065223661, 3187541485, 0, 1065223661, 3187541485, 0, 0, 0, 0, 0],
  [0, 0, 1, 23, 0, 0, 0, 0, 128, 1137180672, 1065223661, 3187541485, 0, 1065223661, 3187541485, 0, 0, 0, 0, 0, 2, 1065223661, 3187541485, 0, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0, 1065353216, 0, 0, 0, 0, 0, 0, 2, 1065353216, 0, 0, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1113063424, 1065353216, 0, 0, 1065353216, 0, 0, 0, 0, 0, 0, 2, 1065353216, 0, 0, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1135869952, 1064492264, 1050798234, 0, 1064492264, 1050798234, 0, 0, 0, 0, 0, 2, 1064492264, 1050798234, 0, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 0, 1058642330, 1061997773, 0, 0, 0, 0, 0, 2, 1058642330, 1061997773, 0, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 1, 11, 0, 0, 0, 0, 0, 1137180672, 1065223661, 3187541485, 0, 1065223661, 3187541485, 0, 0, 0, 0, 0, 2, 1065223661, 3187541485, 0, 1],
  [0, 0, 0, 0, 0, 2, 0, 0, 0, 1137180672, 1050330162, 3201334441, 1063035734, 1050330162, 3201334441, 1063035734, 3261995914, 1134119736, 0, 0, 2, 1050330162, 3201334441, 1063035734, 1],
  [0, 0, 0, 0, 0, 2, 0, 0, 0, 1137180672, 0, 0, 3212836864, 0, 0, 3212836864, 3280404480, 0, 0, 0, 2, 0, 0, 3212836864, 1],
  [0, 0, 0, 0, 0, 1, 0, 0, 544, 0, 0, 0, 0, 1062502052, 1057860035, 1032694211, 3229473148, 1107739297, 0, 1],
  [0, 0, 0, 0, 0, 1, 0, 0, 512, 0, 0, 0, 0, 1065347976, 0, 1020050541, 3216461550, 0, 0, 1],
  [0, 0, 0, 0, 0, 1, 0, 0, 544, 0, 0, 0, 0, 1049451501, 1044150929, 1064402657, 3264036293, 1107739297, 0, 1],
  [0, 0, 0, 0, 0, 1, 0, 0, 544, 0, 0, 0, 0, 1062500904, 1057859269, 1032852099, 3229685308, 1107739297, 0, 1],
  [0, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 3238002688],
  [0, 0, 0, 0, 0, 1, 0, 0, 0, 1137180672, 1063278034, 3186575755, 1055869562, 1063278034, 3186575755, 1055869562, 3252611132, 1135621094, 0, 3, 5, 0, 0, 3238002688],
  [0, 0, 0, 0, 0, 1, 0, 0, 0, 1137180672, 1063278034, 3186575755, 1055869562, 1063278034, 3186575755, 1055869562, 3252611132, 1135621094, 0, 3, 5, 0, 0, 3238002688],
  [0, 0, 0, 0, 0, 1, 0, 0, 0, 1137180672, 1063970101, 3189544811, 1052502322, 1063970101, 3189544811, 1052502322, 3249291421, 1135559901, 0, 3, 5, 0, 0, 3238002688],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1120403456, 1063581999, 1055193391, 0, 1063581999, 1055193391, 0, 0, 0, 0, 0, 2, 1063581999, 1055193391, 0, 1, 2, 1063581999, 1055193391, 0, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1130872832, 1065250602, 1038232045, 0, 1065250602, 1038232045, 0, 0, 0, 0, 0, 2, 1063581999, 1055193391, 0, 1, 6, 0, 1092616192, 1084227584, 1103101952, 1119092736, 1092616192, 3267887104, 2, 1065250602, 1038232045, 0, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1137180672, 1065223661, 3187541485, 0, 1065223661, 3187541485, 0, 0, 0, 0, 0, 2, 1063581999, 1055193391, 0, 1, 6, 0, 1092616192, 1084227584, 1103101952, 1126170624, 3248488448, 1103101952, 2, 1065223661, 3187541485, 0, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1136001024, 1065353215, 0, 0, 1065353215, 0, 0, 0, 0, 0, 0, 2, 1065353215, 0, 0, 1, 2, 1065353215, 0, 0, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1137180672, 1064492264, 1050798234, 0, 1064492264, 1050798234, 0, 0, 0, 0, 0, 2, 1064492264, 1050798234, 0, 1, 2, 1064492264, 1050798234, 0, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1137180672, 1064492264, 1050798234, 0, 1064492264, 1050798234, 0, 0, 0, 0, 0, 2, 1064492264, 1050798234, 0, 1, 2, 1064492264, 1050798234, 0, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1137180672, 1050253722, 1053609165, 1056964608, 1050253722, 1053609165, 1056964608, 0, 0, 0, 0, 2, 1123024896, 1101004800, 3271032832, 1, 3, 0, 0, 1103101952, 0, 0, 0, 1124583493, 1102383879, 3267887104],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1137180672, 1063581999, 1055193391, 0, 1063581999, 1055193391, 0, 0, 0, 0, 0, 2, 1092616192, 1084227584, 3271032832, 1, 3, 0, 0, 1103101952, 0, 0, 0, 1092616192, 1084227584, 3267887104],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1137180672, 3212245699, 3196499795, 0, 3212245699, 3196499795, 0, 0, 0, 0, 0, 7, 1119092736, 1106247680, 1103101952, 1126170624, 3248488448, 1103101952, 8, 1117782016, 1106247680, 1104150528, 8, 1116471296, 1106247680, 1104150528, 8, 1114636288, 1106247680, 1104150528, 8, 1112014848, 1106247680, 1104150528, 8, 1109393408, 1106247680, 1104150528, 8, 1106247680, 1106247680, 1104150528, 8, 1101004800, 1106247680, 1104150528, 8, 1092616192, 1106247680, 1104150528],
  [0, 0, 0, 0, 0, 0, 0, 23, 16, 1137180672, 1065353216, 0, 0, 1065353216, 0, 0, 0, 0, 0, 0, 7, 1117782016, 0, 1103101952, 1127481344, 0, 1103101952, 8, 1116471296, 0, 1104150528, 8, 1114636288, 0, 1104150528, 8, 1112014848, 0, 1104150528, 8, 1109393408, 0, 1104150528, 8, 1106247680, 0, 1104150528, 8, 1101004800, 0, 1104150528, 8, 1092616192, 0, 1104150528, 8, 0, 0, 1104150528],
  [0, 0, 0, 0, 0, 0, 0, 23, 32768, 1137180672, 1065353216, 0, 0, 1065353216, 0, 0, 0, 0, 0, 0, 7, 1117782016, 0, 1103101952, 1127481344, 0, 1103101952, 8, 1116471296, 0, 1104150528, 8, 1114636288, 0, 1104150528, 8, 1112014848, 0, 1104150528, 8, 1109393408, 0, 1104150528, 8, 1106247680, 0, 1104150528, 8, 1101004800, 0, 1104150528, 8, 1092616192, 0, 1104150528, 8, 0, 0, 1104150528],
  [0, 0, 0, 0, 0, 0, 0, 23, 0, 1137180672, 1065353216, 0, 0, 1065353216, 0, 0, 0, 0, 0, 0, 7, 1117782016, 0, 1103101952, 1127481344, 0, 1103101952, 8, 1116471296, 0, 1104150528, 8, 1114636288, 0, 1104150528, 8, 1112014848, 0, 1104150528, 8, 1109393408, 0, 1104150528, 8, 1106247680, 0, 1104150528, 8, 1101004800, 0, 1104150528, 8, 1092616192, 0, 1104150528, 8, 0, 0, 1104150528],
  [0, 0, 0, 0, 0, 0, 0, 23, 0, 1137180672, 1065353216, 0, 0, 1065353216, 0, 0, 0, 0, 0, 0, 7, 1117782016, 0, 1103101952, 1127481344, 0, 1103101952, 8, 1116471296, 0, 1104150528, 8, 1114636288, 0, 1104150528, 8, 1112014848, 0, 1104150528, 8, 1109393408, 0, 1104150528, 8, 1106247680, 0, 1104150528, 8, 1101004800, 0, 1104150528, 8, 1092616192, 0, 1104150528, 8, 0, 0, 1104150528],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1136551154, 1063996695, 1053405130, 0, 1063996695, 1053405130, 0, 0, 0, 0, 0, 7, 1119092736, 1106247680, 1103101952, 1126170624, 3248488448, 1103101952, 8, 1117782016, 1106247680, 1104150528, 8, 1116471296, 1106247680, 1104150528, 8, 1114636288, 1106247680, 1104150528],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 23, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 23, 0, 1137180672, 1065223661, 3187541485, 0, 1065223661, 3187541485, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 1, 0, 0, 512, 0, 0, 0, 0, 1037376083, 3188689221, 1065095590, 3266133079, 1134119736, 0, 0],
  [0, 0, 0, 0, 0, 1, 0, 0, 512, 0, 0, 0, 0, 0, 0, 3212836864, 3280404480, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1137180672, 1064492264, 1050798234, 0, 1064492264, 1050798234, 0, 0, 0, 0, 0, 2, 1064492264, 1050798234, 0, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1128792064, 1055193391, 1063581999, 0, 1055193391, 1063581999, 0, 0, 0, 0, 0, 2, 1055193391, 1063581999, 0, 1],
  [0, 0, 0, 0, 0, 2, 4, 0, 0, 1137180672, 1040269857, 1048658465, 1064671039, 1040269857, 1048658465, 1064671039, 0, 0, 0, 0, 2, 1040269857, 1048658465, 1064671039, 1],
  [0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 1, 29, 0, 0, 0, 0, 0, 1137180672, 1064492264, 1050798234, 0, 1064492264, 1050798234, 0, 0, 0, 0, 0, 2, 1064492264, 1050798234, 0, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1137180672, 1050253722, 1053609165, 1056964608, 1050253722, 1053609165, 1056964608, 0, 0, 0, 0, 3, 0, 0, 1103101952, 0, 0, 0, 1126170624, 3248488448, 1103101952, 2, 1050253722, 1053609165, 1056964608, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1137180672, 1065223661, 3187541485, 0, 1065223661, 3187541485, 0, 0, 0, 0, 0, 3, 0, 0, 1103101952, 0, 0, 0, 1126170624, 3248488448, 1103101952, 2, 1065223661, 3187541485, 0, 1],
];

function controlled(data: GroundCase): readonly number[] {
  const tape: number[] = [];
  let areaCalls = 0;
  const world = floorWorld(() => { tape.push(4, 2); return data.presence; }, point => {
    tape.push(8, ...vectorBits(point)); return areaCalls++ < data.areaBreak ? 1 : 0;
  });
  const setup = fixture(world, floorBsp(), data.randomOffset), state = setup.state;
  state.origin = data.origin; state.velocity = data.velocity; state.moveFlags = data.moveFlags;
  state.jumpReach = data.jumpReach; state.lastReachability = 23; state.reachArea = 1;
  const reach: AasReachability = { area: 2, start: data.start, end: data.end, face: 0, edge: 0, travelType: 0, travelTime: 0, padding: 0 };
  setup.actions.action(0, data.seedFlags);
  const pointContents = spyOn(setup.host, "pointContents").mockImplementation(point => { tape.push(5, ...vectorBits(point)); return data.contents; });
  const horizontalVelocity = spyOn(setup.spatial.movement, "horizontalVelocityForJump").mockImplementation((z, start, end) => {
    tape.push(6, bits(z), ...vectorBits(start), ...vectorBits(end));
    return { success: data.horizontalSuccess, velocity: data.horizontalSpeed };
  });
  const runStart = spyOn(setup.spatial.movement, "jumpReachRunStart").mockImplementation(reach => {
    tape.push(7, ...vectorBits(reach.start), ...vectorBits(reach.end)); return data.runStart;
  });
  const context: BotTravelContext = { ...setup.context,
    gapDistance(origin, direction, entity) { tape.push(1, ...vectorBits(origin), ...vectorBits(direction), entity); return data.gap; },
    checkBlocked(_state, direction, bottom, result) {
      tape.push(2, ...vectorBits(direction), Number(bottom));
      if (data.blockedEntity >= 0) { result.blocked = true; result.blockEntity = data.blockedEntity; }
    },
    airControl(origin, velocity, goal) {
      tape.push(3, ...vectorBits(origin), ...vectorBits(velocity), ...vectorBits(goal));
      return { controlled: data.airSuccess, direction: data.airDirection, speed: data.airSpeed };
    },
  };
  tape.length = 0;
  try {
    const result = at(handlers, data.handler)(context, state, reach);
    return pack(result, state, setup.actions.getInput(0, f(0.1)), setup.counts().random, tape);
  } finally { pointContents.mockRestore(); horizontalVelocity.mockRestore(); runStart.mockRestore(); }
}

async function recordNative(executable: string, cases: readonly GroundCase[]): Promise<readonly unknown[]> {
  const child = Bun.spawn([executable], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(cases.map(input).join("\n") + "\n"); child.stdin.end();
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(""); expect(status).toBe(0);
  const lines = stdout.trim().split("\n"); expect(lines.length).toBe(cases.length);
  return lines.map(line => { const row: unknown = JSON.parse(line); return row; });
}

function variedCases(): readonly GroundCase[] {
  let seed = 0x58398fe2;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const coordinate = () => f((next() & 0xffff) / 16 - 2048);
  return Array.from({ length: 512 }, (_, index) => {
    const handler = index % 16;
    return c(`varied-${index}`, handler, {
      origin: vec3(-4096 + coordinate(), -4096 + coordinate(), coordinate()),
      velocity: vec3(coordinate(), coordinate(), f((next() % 400) - 200)),
      start: vec3(coordinate(), coordinate(), coordinate()), end: vec3(4096 + coordinate(), 4096 + coordinate(), coordinate()),
      moveFlags: handler === 0 && (index & 16) !== 0 ? BotMoveFlag.WALK : 0,
      jumpReach: 23, presence: next() % 2 === 0 ? 4 : 6, gap: next() % 13 * 8, blockedEntity: next() % 2 === 0 ? -1 : 15,
      contents: 32, horizontalSuccess: next() % 2 === 0, horizontalSpeed: f(next() % 32000 / 100),
      airSuccess: next() % 2 === 0, airSpeed: f(next() % 41600 / 100), areaBreak: next() % 9,
      runStart: vec3(coordinate(), coordinate(), coordinate()),
      anglesDefined: [5, 6, 7, 12].includes(handler), randomOffset: next() % 5,
    });
  });
}

describe("ground travel original-C boundary recordings", () => {
  for (let index = 0; index < groundCases.length; index++) {
    const data = at(groundCases, index);
    test(data.name, () => { expect(controlled(data)).toEqual(at(nativeWords, index)); });
  }
  const native = process.env["Q3_GROUND_TRAVEL_NATIVE"];
  test.skipIf(native === undefined)("live unchanged native recorder agrees with embedded words", async () => {
    if (native === undefined) throw new Error("Set Q3_GROUND_TRAVEL_NATIVE to the external original-C recorder");
    const records = await recordNative(native, groundCases);
    for (let index = 0; index < records.length; index++) {
      const words = at(records, index);
      expect(words).toEqual(at(nativeWords, index));
      expect(words).toEqual(controlled(at(groundCases, index)));
    }
  });
  test.skipIf(native === undefined)("512 varied float32 inputs match the unchanged native handlers", async () => {
    if (native === undefined) throw new Error("Set Q3_GROUND_TRAVEL_NATIVE to the external original-C recorder");
    const cases = variedCases(), records = await recordNative(native, cases);
    for (let index = 0; index < cases.length; index++) {
      expect(at(records, index)).toEqual(controlled(at(cases, index)));
    }
  });
});

function simpleReach(start = vec3(80, 0, 24), end = vec3(180, 0, 24)): AasReachability {
  return { area: 2, start, end, face: 0, edge: 0, travelType: TravelType.JUMP, travelTime: 1, padding: 0 };
}
function actualFloorFixture() { return fixture(floorWorld(() => 6, point => point.z > 0 ? 1 : 0), floorBsp()); }

describe("ground travel real dependency integration", () => {
  test("uses actual AAS prediction to find the jump run start", () => {
    const setup = actualFloorFixture(), reach = simpleReach();
    setup.state.origin = vec3(60, 0, 24); setup.state.lastReachability = 23; setup.state.reachArea = 1;
    const sampling = spyOn(setup.spatial, "traceClientBBox");
    try {
      const result = travelJump(setup.context, setup.state, reach);
      expect(sampling).toHaveBeenCalled();
      expect(setup.counts().contents).toBeGreaterThan(0);
      expect(setup.state.jumpReach).toBe(23);
      expect(setup.actions.getInput(0, f(0.1)).actionFlags).toBe(BotActionFlag.JUMP);
      expect(setup.actions.getInput(0, f(0.1)).speed).toBe(400);
      expect(result.moveDirection).toEqual(vec3(1, 0, 0));
    } finally { sampling.mockRestore(); }
  });
  test("uses real AAS horizontal-jump velocity and canonical accumulated actions", () => {
    const setup = actualFloorFixture(), reach = simpleReach(vec3(10, 0, 24), vec3(100, 0, -100));
    setup.state.origin = vec3(0, 0, 24);
    const checked: Vec3[] = [];
    const context: BotTravelContext = { ...setup.context, checkBlocked: (_state, direction) => { checked.push(direction); } };
    const result = travelWalkOffLedge(context, setup.state, reach);
    const velocity = setup.spatial.movement.horizontalVelocityForJump(0, reach.start, reach.end);
    expect(velocity.success).toBe(true);
    expect(setup.actions.getInput(0, f(0.1)).speed).toBe(velocity.velocity);
    expect(checked).toEqual([vec3(1, 0, 0), vec3(1, 0, 0)]);
    expect(result.moveDirection).toEqual(vec3(1, 0, 0));
  });
  test("queries actual BSP contents before drawing finish-water randomness", () => {
    const setup = actualFloorFixture();
    setup.state.origin = vec3(0, 0, 24);
    const result = finishTravelWaterJump(setup.context, setup.state, simpleReach());
    expect(setup.counts().contents).toBe(1);
    expect(setup.counts().random).toBe(0);
    expect(result.flags).toBe(0);
    expect(setup.actions.getInput(0, f(0.1)).speed).toBe(0);
  });
  test("leaves existing actions intact on no-action finishes and jump-only travel", () => {
    const setup = actualFloorFixture(), reach = simpleReach(vec3(3, 4, 24));
    setup.state.origin = vec3(0, 0, 24);
    setup.actions.move(0, vec3(.25, -.5, .75), 123.5); setup.actions.attack(0);
    const prior = setup.actions.getInput(0, f(0.1));
    finishTravelJump(setup.context, setup.state, reach);
    expect(setup.actions.getInput(0, f(0.1))).toEqual(prior);
    const context: BotTravelContext = { ...setup.context, checkBlocked: () => {} };
    travelBarrierJump(context, setup.state, reach);
    expect(setup.actions.getInput(0, f(0.1))).toEqual({ ...prior, actionFlags: BotActionFlag.ATTACK | BotActionFlag.JUMP });
    expect(setup.actions.getInput(1, f(0.1)).actionFlags).toBe(0);
    expect(setup.actions.getInput(1, f(0.1)).speed).toBe(0);
  });
  test("shares one random stream across travel and finish, without dry-path draws", () => {
    const setup = actualFloorFixture(), reach = simpleReach();
    const pointContents = spyOn(setup.host, "pointContents").mockReturnValue(32);
    try {
      travelWaterJump(setup.context, setup.state, reach);
      expect(setup.counts().random).toBe(1);
      finishTravelWaterJump(setup.context, setup.state, reach);
      expect(setup.counts().random).toBe(4);
      setup.state.moveFlags |= BotMoveFlag.WATERJUMP;
      finishTravelWaterJump(setup.context, setup.state, reach);
      expect(setup.counts().random).toBe(4);
      expect(pointContents).toHaveBeenCalledTimes(1);
    } finally { pointContents.mockRestore(); }
  });
  test("invalid destination area preserves source presence diagnostic and zero result", () => {
    const setup = actualFloorFixture(); setup.state.origin = vec3(0, 0, 24);
    const context: BotTravelContext = { ...setup.context, checkBlocked: () => {}, gapDistance: () => 0 };
    travelWalk(context, setup.state, { ...simpleReach(vec3(3, 4, 24), vec3(5, 0, 24)), area: 0 });
    expect(setup.diagnostics).toEqual(["3:AAS_AreaPresenceType: invalid area number\n"]);
    expect(setup.actions.getInput(0, f(0.1)).actionFlags).toBe(BotActionFlag.CROUCH);
  });
});

const retailData = process.env["Q3_DATA"];
test.skipIf(retailData === undefined)("retail ledge velocity on both maps and Team Arena jump prediction feed actual actions", async () => {
  if (retailData === undefined) throw new Error("Set Q3_DATA to the installed retail data root");
  for (const product of ["baseq3", "missionpack"] satisfies readonly ("baseq3" | "missionpack")[]) {
    const mapName = product === "baseq3" ? "q3dm1" : "mpteam1";
    expect(existsSync(join(retailData, product))).toBe(true);
    const files = await VirtualFileSystem.openInspection({ dataPath: retailData, homePath: retailData, cdPath: null, product });
    const bspBytes = await files.read(`maps/${mapName}.bsp`), aasBytes = await files.read(`maps/${mapName}.aas`);
    const map = parseBsp(bspBytes), world = parseAas(aasBytes), setup = fixture(world, map);
    const ledge = world.reachability.find(reach => (reach.travelType & TravelType.MASK) === TravelType.WALKOFFLEDGE);
    if (ledge === undefined) throw new Error(`No retail ledge reachability in ${mapName}`);
    setup.state.origin = ledge.start;
    const checked: Vec3[] = [];
    const context: BotTravelContext = { ...setup.context, checkBlocked: (_state, direction) => { checked.push(direction); } };
    const ledgeResult = travelWalkOffLedge(context, setup.state, ledge);
    expect(checked.length).toBe(2);
    expect(setup.actions.getInput(0, f(0.1)).direction).toEqual(ledgeResult.moveDirection);
    expect(setup.actions.getInput(0, f(0.1)).speed).toBeGreaterThan(0);
    if (product === "baseq3") {
      expect(world.reachability.some(reach => (reach.travelType & TravelType.MASK) === TravelType.JUMP)).toBe(false);
      continue;
    }
    const index = world.reachability.findIndex(reach => (reach.travelType & TravelType.MASK) === TravelType.JUMP);
    if (index < 0) throw new Error(`No retail jump reachability in ${mapName}`);
    const reach = at(world.reachability, index);
    setup.actions.resetInput(0);
    setup.state.origin = reach.start; setup.state.reachArea = world.pointArea(reach.start); setup.state.lastReachability = index;
    const sampling = spyOn(setup.spatial, "traceClientBBox");
    try {
      const result = travelJump(setup.context, setup.state, reach), action = setup.actions.getInput(0, f(0.1));
      expect(sampling).toHaveBeenCalled();
      expect(setup.counts().contents).toBeGreaterThan(0);
      expect(action.speed).toBeGreaterThanOrEqual(0); expect(action.speed).toBeLessThanOrEqual(400);
      expect([result.moveDirection.x, result.moveDirection.y, result.moveDirection.z].every(Number.isFinite)).toBe(true);
      expect(action.direction).toEqual(result.moveDirection);
      expect(setup.actions.getInput(1, f(0.1)).speed).toBe(0);
    } finally { sampling.mockRestore(); }
  }
});
