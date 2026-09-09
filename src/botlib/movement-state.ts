// Port of id Software's botlib/be_ai_move.c state lifetime and game/be_ai_move.h.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { BotMemory } from "./memory.ts";
import type { BotMemoryAllocation } from "./memory.ts";

export const MAX_MOVE_STATES = 64;
export const MAX_AVOID_REACH = 1;
export const MAX_AVOID_SPOTS = 32;
// Release32: 64 input bytes + 52 state bytes + 3 * 4 avoid-reach bytes
// + 32 * (vec3_t 12 + float 4 + int 4) + int 4. No pointer fields.
const MOVE_STATE_BYTES = 772;
const AVOID_SPOT_BYTES = 20;

interface MoveStorage {
  readonly allocation: BotMemoryAllocation;
  data: { readonly view: DataView; readonly byteOffset: number; readonly byteLength: number } | null;
}

function moveData(storage: MoveStorage): DataView {
  const bytes = storage.allocation.bytes;
  let data = storage.data;
  if (data === null || data.view.buffer !== bytes.buffer || data.byteOffset !== bytes.byteOffset || data.byteLength !== bytes.byteLength) {
    data = { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      byteOffset: bytes.byteOffset, byteLength: bytes.byteLength };
    storage.data = data;
  }
  return data.view;
}

function moveVector(allocation: MoveStorage, offset: number) {
  return {
    get x(): number { return moveData(allocation).getFloat32(offset, true); },
    set x(value: number) { moveData(allocation).setFloat32(offset, value, true); },
    get y(): number { return moveData(allocation).getFloat32(offset + 4, true); },
    set y(value: number) { moveData(allocation).setFloat32(offset + 4, value, true); },
    get z(): number { return moveData(allocation).getFloat32(offset + 8, true); },
    set z(value: number) { moveData(allocation).setFloat32(offset + 8, value, true); },
  };
}

function writeMoveVector(allocation: MoveStorage, offset: number, value: Vec3): void {
  const data = moveData(allocation);
  data.setFloat32(offset, value.x, true);
  data.setFloat32(offset + 4, value.y, true);
  data.setFloat32(offset + 8, value.z, true);
}

function moveWord(allocation: MoveStorage, offset: number, kind: "int" | "float"): [number] {
  const values: [number] = [0];
  Object.defineProperty(values, "0", {
    enumerable: true, configurable: false,
    get(): number {
      const data = moveData(allocation);
      return kind === "int" ? data.getInt32(offset, true) : data.getFloat32(offset, true);
    },
    set(value: number): void {
      const data = moveData(allocation);
      if (kind === "int") data.setInt32(offset, value, true);
      else data.setFloat32(offset, value, true);
    },
  });
  return values;
}

function moveSpot(allocation: MoveStorage, offset: number): BotAvoidSpot {
  const origin = moveVector(allocation, offset);
  return {
    get origin() { return origin; },
    set origin(value: Vec3) { writeMoveVector(allocation, offset, value); },
    get radius(): number { return moveData(allocation).getFloat32(offset + 12, true); },
    set radius(value: number) { moveData(allocation).setFloat32(offset + 12, value, true); },
    get type(): number { return moveData(allocation).getInt32(offset + 16, true); },
    set type(value: number) { moveData(allocation).setInt32(offset + 16, value, true); },
  };
}
export enum BotMoveType { WALK = 1, CROUCH = 2, JUMP = 4, GRAPPLE = 8, ROCKETJUMP = 16, BFGJUMP = 32 }
export enum BotMoveFlag {
  BARRIERJUMP = 1, ONGROUND = 2, SWIMMING = 4, AGAINSTLADDER = 8, WATERJUMP = 16,
  TELEPORTED = 32, GRAPPLEPULL = 64, ACTIVEGRAPPLE = 128, GRAPPLERESET = 256, WALK = 512,
}
export enum BotMoveResultFlag {
  MOVEMENTVIEW = 1, SWIMVIEW = 2, WAITING = 4, MOVEMENTVIEWSET = 8, MOVEMENTWEAPON = 16,
  ONTOPOFOBSTACLE = 32, ONTOPOF_FUNCBOB = 64, ONTOPOF_ELEVATOR = 128, BLOCKEDBYAVOIDSPOT = 256,
}
export enum BotMoveResultType { ELEVATORUP = 1, WAITFORFUNCBOBBING = 2, BADGRAPPLEPATH = 4, INSOLIDAREA = 8 }
export enum BotAvoidSpotType { CLEAR = 0, ALWAYS = 1, DONTBLOCK = 2 }

export interface BotInitMove {
  readonly origin: Vec3;
  readonly velocity: Vec3;
  readonly viewOffset: Vec3;
  readonly entityNum: number;
  readonly client: number;
  readonly thinkTime: number;
  readonly presenceType: number;
  readonly viewAngles: Vec3;
  readonly orMoveFlags: number;
}
export class BotMoveResult {
  failure = false;
  type = 0;
  blocked = false;
  blockEntity = 0;
  travelType = 0;
  flags = 0;
  weapon = 0;
  moveDirection = vec3(0, 0, 0);
  idealViewAngles = vec3(0, 0, 0);
}
export class BotAvoidSpot {
  origin = vec3(0, 0, 0);
  radius = 0;
  type = 0;
}

/** The source bot_movestate_t record, shared with subsequent travel execution. */
export class BotMoveState {
  readonly #memory: BotMemory;
  readonly #allocation: MoveStorage;
  readonly #origin;
  readonly #velocity;
  readonly #viewOffset;
  readonly #viewAngles;
  readonly #lastOrigin;
  readonly avoidReach: [number];
  readonly avoidReachTimes: [number];
  readonly avoidReachTries: [number];
  readonly avoidSpots: readonly BotAvoidSpot[];

  constructor(memory: BotMemory = new BotMemory()) {
    this.#memory = memory;
    this.#allocation = { allocation: memory.allocate(MOVE_STATE_BYTES, "heap", true), data: null };
    this.#origin = moveVector(this.#allocation, 0);
    this.#velocity = moveVector(this.#allocation, 12);
    this.#viewOffset = moveVector(this.#allocation, 24);
    this.#viewAngles = moveVector(this.#allocation, 52);
    this.#lastOrigin = moveVector(this.#allocation, 80);
    this.avoidReach = moveWord(this.#allocation, 116, "int");
    this.avoidReachTimes = moveWord(this.#allocation, 120, "float");
    this.avoidReachTries = moveWord(this.#allocation, 124, "int");
    this.avoidSpots = Array.from({ length: MAX_AVOID_SPOTS }, (_, index) => moveSpot(this.#allocation, 128 + index * AVOID_SPOT_BYTES));
  }

  get origin(): ReturnType<typeof moveVector> { return this.#origin; }
  set origin(value: Vec3) { writeMoveVector(this.#allocation, 0, value); }
  get velocity(): ReturnType<typeof moveVector> { return this.#velocity; }
  set velocity(value: Vec3) { writeMoveVector(this.#allocation, 12, value); }
  get viewOffset(): ReturnType<typeof moveVector> { return this.#viewOffset; }
  set viewOffset(value: Vec3) { writeMoveVector(this.#allocation, 24, value); }
  get entityNum(): number { return moveData(this.#allocation).getInt32(36, true); }
  set entityNum(value: number) { moveData(this.#allocation).setInt32(36, value, true); }
  get client(): number { return moveData(this.#allocation).getInt32(40, true); }
  set client(value: number) { moveData(this.#allocation).setInt32(40, value, true); }
  get thinkTime(): number { return moveData(this.#allocation).getFloat32(44, true); }
  set thinkTime(value: number) { moveData(this.#allocation).setFloat32(44, value, true); }
  get presenceType(): number { return moveData(this.#allocation).getInt32(48, true); }
  set presenceType(value: number) { moveData(this.#allocation).setInt32(48, value, true); }
  get viewAngles(): ReturnType<typeof moveVector> { return this.#viewAngles; }
  set viewAngles(value: Vec3) { writeMoveVector(this.#allocation, 52, value); }
  get area(): number { return moveData(this.#allocation).getInt32(64, true); }
  set area(value: number) { moveData(this.#allocation).setInt32(64, value, true); }
  get lastArea(): number { return moveData(this.#allocation).getInt32(68, true); }
  set lastArea(value: number) { moveData(this.#allocation).setInt32(68, value, true); }
  get lastGoalArea(): number { return moveData(this.#allocation).getInt32(72, true); }
  set lastGoalArea(value: number) { moveData(this.#allocation).setInt32(72, value, true); }
  get lastReachability(): number { return moveData(this.#allocation).getInt32(76, true); }
  set lastReachability(value: number) { moveData(this.#allocation).setInt32(76, value, true); }
  get lastOrigin(): ReturnType<typeof moveVector> { return this.#lastOrigin; }
  set lastOrigin(value: Vec3) { writeMoveVector(this.#allocation, 80, value); }
  get reachArea(): number { return moveData(this.#allocation).getInt32(92, true); }
  set reachArea(value: number) { moveData(this.#allocation).setInt32(92, value, true); }
  get moveFlags(): number { return moveData(this.#allocation).getInt32(96, true); }
  set moveFlags(value: number) { moveData(this.#allocation).setInt32(96, value, true); }
  get jumpReach(): number { return moveData(this.#allocation).getInt32(100, true); }
  set jumpReach(value: number) { moveData(this.#allocation).setInt32(100, value, true); }
  get grappleVisibleTime(): number { return moveData(this.#allocation).getFloat32(104, true); }
  set grappleVisibleTime(value: number) { moveData(this.#allocation).setFloat32(104, value, true); }
  get lastGrappleDistance(): number { return moveData(this.#allocation).getFloat32(108, true); }
  set lastGrappleDistance(value: number) { moveData(this.#allocation).setFloat32(108, value, true); }
  get reachabilityTime(): number { return moveData(this.#allocation).getFloat32(112, true); }
  set reachabilityTime(value: number) { moveData(this.#allocation).setFloat32(112, value, true); }
  get numAvoidSpots(): number { return moveData(this.#allocation).getInt32(768, true); }
  set numAvoidSpots(value: number) { moveData(this.#allocation).setInt32(768, value, true); }

  /** Memset of the existing record preserves slot/array ownership. */
  reset(): void {
    this.#allocation.allocation.bytes.fill(0);
  }

  free(): void { this.#memory.free(this.#allocation.allocation); }

  /** i386 source reads tries[1], the adjacent avoidspots[0].origin.x word.
   * Compatibility for that source layout, not defined universal C behavior. */
  nativeResetLastAvoidProbe(): number { return moveData(this.#allocation).getInt32(128, true); }
}

/** Read-only access can use live getters on the actual botlib LibVar record. */
export interface BotMoveVariable { readonly string: string; readonly value: number }
export interface BotMoveStateHost {
  time(): number;
  print(severity: 1 | 3 | 4, text: string): void;
  libVar(name: string, defaultValue: string): BotMoveVariable;
  setBrushModelTypes(): void;
}

export class BotMoveStateStore {
  private readonly states: (BotMoveState | null)[] = Array.from({ length: MAX_MOVE_STATES + 1 }, () => null);
  svMaxStep: BotMoveVariable | null = null;
  svMaxBarrier: BotMoveVariable | null = null;
  svGravity: BotMoveVariable | null = null;
  rocketLauncherIndex: BotMoveVariable | null = null;
  bfgIndex: BotMoveVariable | null = null;
  grappleIndex: BotMoveVariable | null = null;
  missileEntityType: BotMoveVariable | null = null;
  offhandGrapple: BotMoveVariable | null = null;
  grappleOnCommand: BotMoveVariable | null = null;
  grappleOffCommand: BotMoveVariable | null = null;

  constructor(readonly host: BotMoveStateHost, private readonly memory: BotMemory = new BotMemory()) {}
  allocate(): number {
    for (let index = 1; index <= MAX_MOVE_STATES; index++) {
      if (this.states[index] === null) { this.states[index] = new BotMoveState(this.memory); return index; }
    }
    return 0;
  }
  fromHandle(handle: number): BotMoveState | null {
    if (!Number.isInteger(handle) || handle <= 0 || handle > MAX_MOVE_STATES) {
      this.host.print(4, `move state handle ${handle} out of range\n`); return null;
    }
    const state = this.states[handle];
    if (state === undefined || state === null) { this.host.print(4, `invalid move state ${handle}\n`); return null; }
    return state;
  }
  free(handle: number): void {
    const state = this.fromHandle(handle);
    if (state !== null) { state.free(); this.states[handle] = null; }
  }
  initialize(handle: number, input: BotInitMove): void {
    const state = this.fromHandle(handle); if (state === null) return;
    state.origin = vec3(input.origin.x, input.origin.y, input.origin.z);
    state.velocity = vec3(input.velocity.x, input.velocity.y, input.velocity.z);
    state.viewOffset = vec3(input.viewOffset.x, input.viewOffset.y, input.viewOffset.z);
    state.entityNum = input.entityNum; state.client = input.client; state.thinkTime = Math.fround(input.thinkTime); state.presenceType = input.presenceType;
    state.viewAngles = vec3(input.viewAngles.x, input.viewAngles.y, input.viewAngles.z);
    const mask = BotMoveFlag.ONGROUND | BotMoveFlag.TELEPORTED | BotMoveFlag.WATERJUMP | BotMoveFlag.WALK | BotMoveFlag.GRAPPLEPULL;
    state.moveFlags = (state.moveFlags & ~mask) | (input.orMoveFlags & mask);
  }
  reset(handle: number): void { this.fromHandle(handle)?.reset(); }
  resetAvoidReach(handle: number): void {
    const state = this.fromHandle(handle); if (state === null) return;
    state.avoidReach[0] = 0; state.avoidReachTimes[0] = 0; state.avoidReachTries[0] = 0;
  }
  resetLastAvoidReach(handle: number): void {
    const state = this.fromHandle(handle); if (state === null) return;
    if (state.avoidReachTimes[0] > 0) {
      state.avoidReachTimes[0] = 0;
      if (state.nativeResetLastAvoidProbe() > 0) state.avoidReachTries[0] = (state.avoidReachTries[0] - 1) | 0;
    }
  }
  addToAvoidReach(state: BotMoveState, number: number, avoidTime: number): void {
    avoidTime = Math.fround(avoidTime);
    if (state.avoidReach[0] === number) {
      state.avoidReachTries[0] = state.avoidReachTimes[0] > Math.fround(this.host.time()) ? (state.avoidReachTries[0] + 1) | 0 : 1;
      state.avoidReachTimes[0] = Math.fround(Math.fround(this.host.time()) + avoidTime); return;
    }
    if (state.avoidReachTimes[0] < Math.fround(this.host.time())) {
      state.avoidReach[0] = number; state.avoidReachTimes[0] = Math.fround(Math.fround(this.host.time()) + avoidTime); state.avoidReachTries[0] = 1;
    }
  }
  addAvoidSpot(handle: number, origin: Vec3, radius: number, type: number): void {
    const state = this.fromHandle(handle); if (state === null) return;
    if (type === BotAvoidSpotType.CLEAR) { state.numAvoidSpots = 0; return; }
    if (state.numAvoidSpots >= MAX_AVOID_SPOTS) return;
    const spot = state.avoidSpots[state.numAvoidSpots];
    if (spot === undefined) throw new Error("Invalid move-state avoid-spot count");
    spot.origin = vec3(origin.x, origin.y, origin.z); spot.radius = Math.fround(radius); spot.type = type; state.numAvoidSpots++;
  }
  setup(): number {
    this.host.setBrushModelTypes();
    this.svMaxStep = this.host.libVar("sv_step", "18");
    this.svMaxBarrier = this.host.libVar("sv_maxbarrier", "32");
    this.svGravity = this.host.libVar("sv_gravity", "800");
    this.rocketLauncherIndex = this.host.libVar("weapindex_rocketlauncher", "5");
    this.bfgIndex = this.host.libVar("weapindex_bfg10k", "9");
    this.grappleIndex = this.host.libVar("weapindex_grapple", "10");
    this.missileEntityType = this.host.libVar("entitytypemissile", "3");
    this.offhandGrapple = this.host.libVar("offhandgrapple", "0");
    this.grappleOnCommand = this.host.libVar("cmd_grappleon", "grappleon");
    this.grappleOffCommand = this.host.libVar("cmd_grappleoff", "grappleoff");
    return 0;
  }
  shutdown(): void {
    for (let index = 1; index <= MAX_MOVE_STATES; index++) {
      const state = this.states[index];
      if (state !== undefined && state !== null) { state.free(); this.states[index] = null; }
    }
  }
}
