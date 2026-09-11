import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import type { AasReachability, AasWorld } from "../src/botlib/aas.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import { BotActionBuffer } from "../src/botlib/actions.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import type { BotGoal } from "../src/botlib/goals.ts";
import { BotMovement, BotMovementDebugState } from "../src/botlib/movement.ts";
import type { BotMovementDebugOptions, BotTravelContext } from "../src/botlib/movement.ts";
import { BotMovementRouting } from "../src/botlib/movement-routing.ts";
import { BotMoveFlag, BotMoveResult, BotMoveStateStore } from "../src/botlib/movement-state.ts";
import { resetGrapple, resetGrappleCalls, travelElevator, travelFuncBobbing, travelGrapple, travelGrappleCalls } from "../src/botlib/movement-travel-special.ts";
import { AasRouting, TravelFlags, TravelType } from "../src/botlib/routing.ts";
import { AasSpatial, BotBrushModelTypes } from "../src/botlib/spatial.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import { runCalls, waitForCall } from "../src/core/call-steps.ts";

const zero = vec3(0, 0, 0), bounds = { min: vec3(-1000, -1000, -1000), max: vec3(1000, 1000, 1000) };
const goal: BotGoal = { area: 2, origin: vec3(100, 0, 0), mins: zero, maxs: zero, entity: 0, number: 0, flags: 0, itemInfo: 0 };
function fixture(flags: Pick<BotMovementDebugOptions, "debug" | "aiMove" | "elevator" | "funcBob" | "grapple"> = {}) {
  const events: string[] = [];
  const control = { developer: true, time: 10, onMover: false, moverDown: true, moverOrigin: zero, ground: true, wall: false, createdLine: 71 };
  const reach = { area: 2, face: 1, edge: 100, start: vec3(20, 0, 0), end: vec3(100, 0, 100), travelType: Number(TravelType.TELEPORT), travelTime: 10, padding: 0 } satisfies AasReachability;
  const areas = [0, 1, 2].map(areaNumber => ({ areaNumber, faceCount: 0, firstFace: 0, bounds, center: zero }));
  const settings = [0, 1, 2].map(area => ({ contents: 0, flags: area === 0 ? 0 : 1, presenceType: area === 0 ? 0 : 6,
    cluster: area === 0 ? 0 : 1, clusterAreaNumber: area - 1, reachableAreaCount: area === 1 ? 1 : 0, firstReachableArea: area === 1 ? 1 : 0 }));
  const world: AasWorld = { source: "movement-debug", version: 5, bspChecksum: 0, bboxes: [], vertices: [], edges: [], edgeIndexes: [], faces: [], faceIndexes: [],
    planes: [{ normal: vec3(0, 0, 1), distance: -1000, type: 2 }], nodes: [{ plane: 0, children: [0, 0] }, { plane: 0, children: [-1, -1] }],
    areas, areaSettings: settings, reachability: [{ ...reach, area: 0, travelType: 0 }, reach], portals: [], portalIndex: [],
    clusters: [{ areaCount: 0, reachabilityAreaCount: 0, portalCount: 0, firstPortal: 0 }, { areaCount: 2, reachabilityAreaCount: 2, portalCount: 0, firstPortal: 0 }],
    pointArea: () => 1, areaReachabilities: area => area === 1 ? [reach] : [], areaBounds: () => bounds };
  const map: BspMap = { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const heap = new AasLinkHeap(() => { throw new Error("Unexpected link allocation"); }); heap.initialize(() => 64);
  const entities = new AasBspEntities(() => {}); entities.load("");
  const spatial = new AasSpatial(world, entities, {
    print: text => { events.push(`1:${text}`); }, pointContents: () => 0,
    trace: (start, end, box, _entity, mask) => {
      events.push("trace");
      return { ...collision.trace({ start, end, shape: box === null ? { kind: "point" } : { kind: "box", mins: box.min, maxs: box.max }, mask }),
        end: control.wall ? start : end, entityNum: 1023 };
    },
    entityTrace: () => { throw new Error("Unexpected entity trace"); }, entityModelIndex: () => 0,
    modelBounds: () => ({ bounds: { min: zero, max: zero }, origin: zero }),
  }, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), heap, { kind: "disabled" }, () => control.time);
  const states = new BotMoveStateStore({ time: () => control.time,
    print: (severity, text) => { events.push(`${severity}:${text}`); },
    libVar: (_name, value) => ({ string: value, value: Number.isNaN(Number(value)) ? 0 : Number(value) }), setBrushModelTypes: () => {} });
  states.setup();
  const routing = new BotMovementRouting(states, spatial, new AasRouting(world), {
    originOfMoverWithModelNum: () => control.moverOrigin, entityModelNum: () => 1,
  }, { debug: flags.debug === true, developer: () => control.developer });
  routing.routing.initializeRouting(spatial, () => 1024 * 1024, () => control.time);
  routing.onMover = () => control.onMover; routing.moverDown = () => control.moverDown; routing.onTopOfEntity = () => -1;
  spatial.fuzzyPointReachabilityArea = () => 1; spatial.traceAreas = () => [];
  spatial.movement.onGround = () => control.ground; spatial.movement.swimming = () => false; spatial.movement.againstLadder = () => false;
  const actions = new class extends BotActionBuffer {
    override move(client: number, direction: Parameters<BotActionBuffer["move"]>[1], speed: number): void { events.push("move"); super.move(client, direction, speed); }
    override attack(client: number): void { events.push("attack"); super.attack(client); }
  }(2, { *clientCommand(_client, command): ReturnType<BotActionBuffer["commandCalls"]> { events.push(`command:${command}`); } });
  const host = { random: { nextInt: () => 0 }, developer: () => control.developer, nextEntity: () => 0, entityType: () => 0, entityWeapon: () => 0 };
  const diagnostics: BotMovementDebugOptions = { ...flags,
    clearLines: () => { events.push("clear"); }, printTravelType: type => { events.push(`type:${type}`); },
    showReachability: value => { events.push(`reach:${value.travelType}`); },
    lineCreate: () => { events.push("create"); return control.createdLine; },
    lineShow: (line, start, end, color) => { events.push(`line:${line}:${color}:${start.x}:${end.x}`); },
  };
  const debugState = new BotMovementDebugState();
  const createMovement = (enabled = true) => new BotMovement(routing, actions, host, enabled ? diagnostics : undefined, debugState);
  const movement = createMovement(), handle = states.allocate(), state = states.fromHandle(handle);
  if (state === null) throw new Error("Missing move state");
  state.client = 0; state.entityNum = 7; state.presenceType = 2; state.thinkTime = 0.1; state.area = 1;
  state.lastArea = 1; state.lastGoalArea = 2; state.reachabilityTime = 15; state.lastReachability = 1;
  const context: BotTravelContext = { routing, actions, host,
    diagnostics: { elevator: flags.elevator === true, funcBob: flags.funcBob === true, grapple: flags.grapple === true,
      showGrapple: () => { events.push("grapple-line"); } },
    variable: name => { const variable = states[name]; if (variable === null) throw new Error(`Missing variable ${name}`); return variable; },
    vectorToAngles: () => zero, gapDistance: () => 0, checkBarrierJump: () => { events.push("barrier"); return false; },
    checkBlocked: () => { events.push("blocked"); }, airControl: () => ({ controlled: false, direction: zero, speed: 0 }),
  };
  events.length = 0;
  return { events, control, reach, settings, movement, createMovement, context, state, states, handle, routing, actions };
}

describe("be_ai_move explicit compile diagnostics", () => {
  test("null goal DEBUG print follows grapple reset and does not require developer", () => {
    const env = fixture({ debug: true, grapple: true }); env.control.developer = false;
    env.state.moveFlags = BotMoveFlag.ACTIVEGRAPPLE;
    env.movement.moveToGoal(new BotMoveResult(), env.handle, null, TravelFlags.DEFAULT);
    expect(env.events).toEqual(["1:reset grapple\n", "1:client 0: movetogoal -> no goal\n"]);
    env.events.length = 0; env.state.moveFlags = BotMoveFlag.ACTIVEGRAPPLE;
    env.createMovement(false).moveToGoal(new BotMoveResult(), env.handle, null, TravelFlags.DEFAULT);
    expect(env.events).toEqual([]);
  });

  test("avoid messages require both DEBUG and developer", () => {
    for (const enabled of [false, true]) for (const developer of [false, true]) {
      const env = fixture({ debug: enabled }); env.control.developer = developer;
      env.state.avoidReach[0] = 1; env.state.avoidReachTimes[0] = 10; env.state.avoidReachTries[0] = 5;
      const result = env.routing.getReachabilityToGoal({ origin: zero, area: 1, lastGoalArea: 2, lastArea: 1, avoid: env.state,
        goal, travelFlags: TravelFlags.DEFAULT, moveTravelFlags: TravelFlags.DEFAULT, avoidSpots: [], numAvoidSpots: 0, flags: 0 });
      expect(result.reachability).toBe(0);
      expect(env.events).toEqual(enabled && developer ? ["1:avoiding reachability 1\n"] : []);
    }
  });

  test("timeout, unreachable, previous-area and failure prints retain source ordering", () => {
    const env = fixture({ debug: true }); env.state.reachabilityTime = 9;
    env.state.lastArea = 0;
    const settings = env.settings[1]; if (settings === undefined) throw new Error("Missing area");
    settings.reachableAreaCount = 0; settings.firstReachableArea = 0;
    env.movement.moveToGoal(new BotMoveResult(), env.handle, goal, TravelFlags.DEFAULT);
    expect(env.events).toEqual(["1:client 0: reachability timeout in ", `type:${TravelType.TELEPORT}`, "1:\n",
      "1:area 1 no reachability\n", "1:goal not reachable\n", "1:same goal, going back to previous area\n",
      "1:client 0: movement failure in ", "type:0", "1:\n"]);
  });

  test("AI_MOVE clears, prints and draws before the selected travel handler", () => {
    const env = fixture({ aiMove: true }); env.control.developer = false;
    env.movement.moveToGoal(new BotMoveResult(), env.handle, goal, TravelFlags.DEFAULT);
    expect(env.events.slice(0, 3)).toEqual(["clear", `type:${TravelType.TELEPORT}`, `reach:${TravelType.TELEPORT}`]);
    expect(env.events.indexOf("move")).toBeGreaterThan(2);
  });

  test("grapple retained line precedes reset and survives replacement movement owners", () => {
    const env = fixture({ grapple: true }); env.reach.travelType = TravelType.GRAPPLEHOOK;
    env.control.ground = false; env.state.moveFlags = BotMoveFlag.GRAPPLERESET;
    env.movement.moveToGoal(new BotMoveResult(), env.handle, goal, TravelFlags.GRAPPLEHOOK);
    env.createMovement().moveToGoal(new BotMoveResult(), env.handle, goal, TravelFlags.GRAPPLEHOOK);
    expect(env.events).toEqual(["create", "line:71:3:20:100", "line:71:3:20:100"]);
  });

  test("zero grapple handles retry creation and independent owners allocate independently", () => {
    const env = fixture({ grapple: true }); env.reach.travelType = TravelType.GRAPPLEHOOK;
    env.control.ground = false; env.state.moveFlags = BotMoveFlag.GRAPPLERESET; env.control.createdLine = 0;
    env.movement.moveToGoal(new BotMoveResult(), env.handle, goal, TravelFlags.GRAPPLEHOOK);
    env.control.createdLine = 72;
    env.movement.moveToGoal(new BotMoveResult(), env.handle, goal, TravelFlags.GRAPPLEHOOK);
    expect(env.events).toEqual(["create", "line:0:3:20:100", "create", "line:72:3:20:100"]);
    const other = fixture({ grapple: true }); other.reach.travelType = TravelType.GRAPPLEHOOK;
    other.control.ground = false; other.state.moveFlags = BotMoveFlag.GRAPPLERESET;
    other.movement.moveToGoal(new BotMoveResult(), other.handle, goal, TravelFlags.GRAPPLEHOOK);
    expect(other.events).toEqual(["create", "line:71:3:20:100"]);
  });

  test("normal and finish failure diagnostics follow grapple activation failure", () => {
    for (const ground of [true, false]) {
      const env = fixture({ debug: true, grapple: true }); env.control.ground = ground; env.control.wall = true;
      env.reach.travelType = TravelType.GRAPPLEHOOK; env.reach.start = zero; env.reach.end = vec3(100, 0, 0);
      env.movement.moveToGoal(new BotMoveResult(), env.handle, goal, TravelFlags.GRAPPLEHOOK);
      expect(env.events).toEqual(["create", "line:71:3:0:100", "1:BotTravel_Grapple: inactive grapple\n",
        "1:BotTravel_Grapple: activating grapple\n", "trace",
        `1:client 0: movement failure in ${ground ? "" : "finish "}`, `type:${TravelType.GRAPPLEHOOK}`, "1:\n"]);
    }
  });

  test("grapple end, timeout, activation and reset print at source action boundaries", () => {
    const env = fixture({ grapple: true }); env.reach.travelType = TravelType.GRAPPLEHOOK;
    env.state.moveFlags = BotMoveFlag.ACTIVEGRAPPLE | BotMoveFlag.GRAPPLEPULL;
    env.reach.end = vec3(20, 0, 0); env.state.lastGrappleDistance = 20;
    travelGrapple(env.context, env.state, env.reach);
    expect(env.events).toEqual(["grapple-line", "1:BotTravel_Grapple: active grapple\n", "3:grapple normal end\n"]);
    env.events.length = 0; env.state.moveFlags = BotMoveFlag.ACTIVEGRAPPLE; env.state.grappleVisibleTime = 0;
    env.reach.end = vec3(100, 0, 0);
    travelGrapple(env.context, env.state, env.reach);
    expect(env.events).toEqual(["grapple-line", "1:BotTravel_Grapple: active grapple\n", "3:grapple not visible\n"]);
    env.events.length = 0; env.state.moveFlags = 0; env.reach.start = zero;
    travelGrapple(env.context, env.state, env.reach);
    expect(env.events).toEqual(["grapple-line", "1:BotTravel_Grapple: inactive grapple\n", "1:BotTravel_Grapple: activating grapple\n", "trace", "attack"]);
    env.events.length = 0; env.state.lastReachability = 0;
    resetGrapple(env.context, env.state);
    expect(env.events).toEqual(["1:reset grapple\n"]);
  });

  test("failed offhand commands retain only diagnostics reached before the call", async () => {
    const env = fixture({ grapple: true });
    const offhand = env.states.offhandGrapple; if (offhand === null) throw new Error("Missing offhand setting");
    env.states.offhandGrapple = { string: "1", value: 1 };
    const actions = new BotActionBuffer(2, { *clientCommand(_client, command): ReturnType<BotActionBuffer["commandCalls"]> {
      env.events.push(`command:${command}`);
      yield* waitForCall(async () => { throw new Error("command failed"); });
    } });
    const context: BotTravelContext = { ...env.context, actions };
    env.state.lastReachability = 0; env.state.moveFlags = BotMoveFlag.ACTIVEGRAPPLE;
    await expect(runCalls(resetGrappleCalls(context, env.state))).rejects.toThrow("command failed");
    expect(env.events).toEqual(["command:grappleoff"]);
    expect(env.state.moveFlags).toBe(BotMoveFlag.ACTIVEGRAPPLE);
    env.events.length = 0; env.state.moveFlags |= BotMoveFlag.GRAPPLEPULL;
    env.reach.end = vec3(20, 0, 0); env.state.lastGrappleDistance = 20;
    await expect(runCalls(travelGrappleCalls(context, env.state, env.reach))).rejects.toThrow("command failed");
    expect(env.events).toEqual(["grapple-line", "1:BotTravel_Grapple: active grapple\n", "3:grapple normal end\n", "command:grappleoff"]);
    expect(env.state.moveFlags).toBe(BotMoveFlag.ACTIVEGRAPPLE | BotMoveFlag.GRAPPLEPULL);
  });

  test("elevator and bobbing branch messages precede movement without developer", () => {
    for (const kind of ["elevator", "funcBob"] satisfies readonly ("elevator" | "funcBob")[]) {
      const env = fixture({ [kind]: true }); env.control.developer = false;
      const handler = kind === "elevator" ? travelElevator : travelFuncBobbing;
      const on = kind === "elevator" ? "bot on elevator" : "bot on func_bobbing";
      const off = kind === "elevator" ? "bot not on elevator" : "bot not ontop of func_bobbing";
      const center = kind === "elevator" ? "bot moving to center" : "bot moving to func_bobbing center";
      const end = kind === "elevator" ? "bot moving to end" : "bot moving to reachability end";
      env.control.onMover = true; env.state.origin = vec3(0, 0, 100); env.control.moverOrigin = vec3(0, 0, 100);
      handler(env.context, env.state, env.reach);
      expect(env.events).toEqual([`1:${on}\n`, `1:${end}\n`, "barrier", "move"]);
      env.events.length = 0; env.state.origin = vec3(30, 0, 0); env.control.moverOrigin = zero;
      handler(env.context, env.state, env.reach);
      expect(env.events).toEqual([`1:${on}\n`, `1:${center}\n`, "move"]);
      env.events.length = 0; env.control.onMover = false; env.state.origin = vec3(100, 0, 90);
      handler(env.context, env.state, env.reach);
      expect(env.events).toEqual([`1:${off}\n`, ...(kind === "funcBob" ? ["1:bot moving to end\n"] : []), "barrier", "move"]);
      env.events.length = 0; env.state.origin = zero; env.control.moverDown = false; env.control.moverOrigin = vec3(0, 0, 50);
      handler(env.context, env.state, env.reach);
      expect(env.events).toEqual([`1:${off}\n`, `1:${kind === "elevator" ? "elevator not down" : "func_bobbing not at start"}\n`, "blocked", "barrier", "move"]);
      env.events.length = 0; env.control.moverDown = true; env.control.moverOrigin = zero; env.state.origin = vec3(10, 0, 0);
      handler(env.context, env.state, env.reach);
      expect(env.events).toEqual([`1:${off}\n`, `1:${center}\n`, "blocked", "barrier", "move"]);
      env.events.length = 0; env.state.origin = vec3(100, 0, 0); env.reach.start = vec3(70, 0, 0);
      handler(env.context, env.state, env.reach);
      expect(env.events).toEqual([`1:${off}\n`, `1:${kind === "elevator" ? "bot moving to start" : "bot moving to reachability start"}\n`, "blocked", "barrier", "move"]);
    }
  });
});
