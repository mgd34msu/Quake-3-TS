// Ported from id Software's code/game/bg_pmove.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { add3, dot3, length3, normalize3, scale3, sub3, vec3 } from "../core/math.ts";
import { qvmAngleVectors } from "../core/qvm-math.ts";
import type { Bounds, Vec3 } from "../core/math.ts";
import { EntityEvent, Holdable, MoveType, PersistentIndex, Powerup, Team, Weapon, WeaponState,
  statSchema, weaponCount } from "./definitions.ts";
import { itemAt } from "./items.ts";
import { CommandButtons as B, ENTITYNUM_NONE, ENTITYNUM_WORLD, MoveFlags as F,
  PlayerAnimation as A } from "./player-state.ts";
import type { SourcePlayerState, PredictableEvent, UserCommand } from "./player-state.ts";
import { clipVelocity, slideMove, stepSlideMove } from "./slide-move.ts";
import type { MovementTrace, MovementTraceFunction, SlideMoveContext } from "./slide-move.ts";

export type { MovementTrace, MovementTraceFunction } from "./slide-move.ts";
export { createPlayerState } from "./player-state.ts";

const ALL_TIMES = F.TIME_WATERJUMP | F.TIME_LAND | F.TIME_KNOCKBACK;
const MASK_WATER = 32 | 16 | 8;
const CONTENTS_BODY = 0x2000000;
const SURF_SLICK = 2;
const SURF_NODAMAGE = 1;
const SURF_METALSTEPS = 0x1000;
const SURF_NOSTEPS = 0x2000;

/** One source c_pmove counter per game module, including silent spectator moves. */
export class MovementDiagnostics {
  count = 0;
  constructor(readonly print: (text: string) => undefined) {}
}

export interface MovementOptions {
  readonly trace: MovementTraceFunction;
  readonly pointContents: (point: Vec3, passEntity: number) => number;
  readonly traceMask?: number;
  readonly fixedMsec?: number | null;
  readonly noFootsteps?: boolean;
  readonly gauntletHit?: boolean;
  readonly diagnostics?: { readonly state: MovementDiagnostics; readonly level: number };
}

export interface MovementResult {
  /** Like pmove_t, contacts describe the final substep; events include every substep. */
  readonly contacts: readonly number[];
  readonly events: readonly PredictableEvent[];
  readonly bounds: Bounds;
  readonly waterlevel: number;
  readonly watertype: number;
  readonly xyspeed: number;
}

const standingBounds: Bounds = { min: vec3(-15, -15, -24), max: vec3(15, 15, 32) };
const zeroBounds: Bounds = { min: vec3(0, 0, 0), max: vec3(0, 0, 0) };

/** x87 fistp / C rint semantics used by the source engine's Sys_SnapVector. */
function snap(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  return fraction < 0.5 ? floor : fraction > 0.5 ? floor + 1 : (floor % 2 === 0 ? floor : floor + 1);
}

export function updateViewAngles(ps: SourcePlayerState, cmd: UserCommand): void {
  if (ps.pmType === MoveType.PM_INTERMISSION || ps.pmType === MoveType.PM_SPINTERMISSION ||
    (ps.pmType !== MoveType.PM_SPECTATOR && ps.health <= 0)) return;
  let pitch = ((cmd.angles.x + ps.deltaAngles.x) << 16) >> 16;
  if (pitch > 16000) {
    ps.deltaAngles = { ...ps.deltaAngles, x: (16000 - cmd.angles.x) | 0 };
    pitch = 16000;
  } else if (pitch < -16000) {
    ps.deltaAngles = { ...ps.deltaAngles, x: (-16000 - cmd.angles.x) | 0 };
    pitch = -16000;
  }
  const yaw = ((cmd.angles.y + ps.deltaAngles.y) << 16) >> 16;
  const roll = ((cmd.angles.z + ps.deltaAngles.z) << 16) >> 16;
  ps.viewangles = vec3(pitch * (360 / 65536), yaw * (360 / 65536), roll * (360 / 65536));
}

class MoveStep implements SlideMoveContext {
  readonly contacts: number[] = [];
  bounds: Bounds = zeroBounds;
  groundNormal: Vec3 | null = null;
  groundSurfaceFlags = 0;
  walking = false;
  impactSpeed = 0;
  waterlevel = 0;
  watertype = 0;
  xyspeed = 0;
  forward = vec3(0, 0, 0);
  right = vec3(0, 0, 0);
  readonly frameTime: number;
  readonly msec: number;
  readonly previousOrigin: Vec3;
  readonly previousVelocity: Vec3;
  readonly mask: number;
  readonly trace: MovementTraceFunction;

  constructor(readonly state: SourcePlayerState, readonly cmd: UserCommand,
    readonly options: MovementOptions, readonly events: PredictableEvent[]) {
    this.msec = Math.max(1, Math.min(200, cmd.serverTime - state.commandTime));
    this.frameTime = Math.fround(this.msec * Math.fround(0.001));
    this.previousOrigin = state.origin;
    this.previousVelocity = state.velocity;
    const mask = options.traceMask ?? (1 | 0x10000 | CONTENTS_BODY);
    this.mask = state.health <= 0 ? mask & ~CONTENTS_BODY : mask;
    this.trace = options.trace;
  }

  event(event: number): void { this.events.push(this.state.addEvent(event)); }
  debug(message: string): void {
    const diagnostics = this.options.diagnostics;
    if (diagnostics !== undefined && diagnostics.level !== 0) {
      diagnostics.state.print(`${diagnostics.state.count}:${message}\n`);
    }
  }
  touch(entityNum: number): void {
    if (entityNum !== ENTITYNUM_WORLD && this.contacts.length < 32 && !this.contacts.includes(entityNum)) {
      this.contacts.push(entityNum);
    }
  }
  private test(start: Vec3, end: Vec3): MovementTrace {
    return this.trace(start, end, this.bounds, this.state.clientNum, this.mask);
  }
  private contents(point: Vec3): number { return this.options.pointContents(point, this.state.clientNum); }

  private startTorso(animation: A): void {
    if (this.state.pmType < MoveType.PM_DEAD) this.state.torsoAnim = ((this.state.torsoAnim & 128) ^ 128) | animation;
  }
  private legs(animation: A, force = false): void {
    const ps = this.state;
    if (force) ps.legsTimer = 0;
    if (ps.pmType >= MoveType.PM_DEAD || ps.legsTimer > 0 || (!force && (ps.legsAnim & ~128) === animation)) return;
    ps.legsAnim = ((ps.legsAnim & 128) ^ 128) | animation;
  }
  private torso(animation: A): void {
    if ((this.state.torsoAnim & ~128) !== animation && this.state.torsoTimer <= 0) this.startTorso(animation);
  }
  private jumpAnimation(): void {
    if (this.cmd.forwardmove >= 0) {
      this.legs(A.LEGS_JUMP, true);
      this.state.pmFlags &= ~F.BACKWARDS_JUMP;
    } else {
      this.legs(A.LEGS_JUMPB, true);
      this.state.pmFlags |= F.BACKWARDS_JUMP;
    }
  }
  private friction(): void {
    const ps = this.state;
    const velocity = ps.velocity;
    const speed = Math.fround(length3(this.walking ? vec3(velocity.x, velocity.y, 0) : velocity));
    if (speed < 1) { ps.velocity = vec3(0, 0, velocity.z); return; }
    let drop = 0;
    if (this.waterlevel <= 1 && this.walking && !(this.groundSurfaceFlags & SURF_SLICK) &&
      !(ps.pmFlags & F.TIME_KNOCKBACK)) drop = Math.fround(Math.fround(Math.max(speed, 100) * 6) * this.frameTime);
    if (this.waterlevel) drop = Math.fround(drop + Math.fround(Math.fround(speed * this.waterlevel) * this.frameTime));
    if (ps.powerups.get(Powerup.PW_FLIGHT)) drop = Math.fround(drop + Math.fround(Math.fround(speed * 3) * this.frameTime));
    if (ps.pmType === MoveType.PM_SPECTATOR) drop = Math.fround(drop + Math.fround(Math.fround(speed * 5) * this.frameTime));
    ps.velocity = scale3(velocity, Math.fround(Math.max(0, Math.fround(speed - drop)) / speed));
  }
  private accelerate(direction: Vec3, speed: number, acceleration: number): void {
    speed = Math.fround(speed);
    const currentSpeed = Math.fround(dot3(this.state.velocity, direction));
    const addSpeed = Math.fround(speed - currentSpeed);
    if (addSpeed <= 0) return;
    const amount = Math.min(Math.fround(Math.fround(acceleration * this.frameTime) * speed), addSpeed);
    this.state.velocity = add3(this.state.velocity, scale3(direction, amount));
  }
  private commandScale(): number {
    const { forwardmove: f, rightmove: r, upmove: u } = this.cmd;
    const max = Math.max(Math.abs(f), Math.abs(r), Math.abs(u));
    const total = Math.fround(Math.sqrt(f * f + r * r + u * u));
    return max === 0 ? 0 : Math.fround(Math.fround(Math.fround(this.state.speed) * max) / Math.fround(127 * total));
  }
  private movementDirection(): void {
    const f = this.cmd.forwardmove;
    const r = this.cmd.rightmove;
    if (f || r) this.state.movementDir = f > 0 ? (r < 0 ? 1 : r > 0 ? 7 : 0) :
      f < 0 ? (r < 0 ? 3 : r > 0 ? 5 : 4) : r < 0 ? 2 : 6;
    else if (this.state.movementDir === 2) this.state.movementDir = 1;
    else if (this.state.movementDir === 6) this.state.movementDir = 7;
  }
  private checkJump(): boolean {
    const ps = this.state;
    if (ps.pmFlags & F.RESPAWNED || this.cmd.upmove < 10) return false;
    if (ps.pmFlags & F.JUMP_HELD) { this.cmd.upmove = 0; return false; }
    this.groundNormal = null;
    this.walking = false;
    ps.pmFlags |= F.JUMP_HELD;
    ps.groundEntityNum = ENTITYNUM_NONE;
    ps.velocity = vec3(ps.velocity.x, ps.velocity.y, 270);
    this.event(EntityEvent.EV_JUMP);
    this.jumpAnimation();
    return true;
  }
  private checkWaterJump(): boolean {
    const ps = this.state;
    if (ps.pmTime !== 0 || this.waterlevel !== 2) return false;
    const flat = normalize3(vec3(this.forward.x, this.forward.y, 0));
    const point = add3(ps.origin, scale3(flat, 30));
    if (!(this.contents(vec3(point.x, point.y, point.z + 4)) & 1) ||
      this.contents(vec3(point.x, point.y, point.z + 20)) !== 0) return false;
    const velocity = scale3(this.forward, 200);
    ps.velocity = vec3(velocity.x, velocity.y, 350);
    ps.pmFlags |= F.TIME_WATERJUMP;
    ps.pmTime = 2000;
    return true;
  }
  private waterJumpMove(): void {
    stepSlideMove(this, true);
    const ps = this.state;
    ps.velocity = vec3(ps.velocity.x, ps.velocity.y, ps.velocity.z - Math.fround(ps.gravity * this.frameTime));
    if (ps.velocity.z < 0) { ps.pmFlags &= ~ALL_TIMES; ps.pmTime = 0; }
  }
  private wishVelocity(scale: number): Vec3 {
    const component = (forward: number, right: number): number => Math.fround(
      Math.fround(Math.fround(scale * forward) * this.cmd.forwardmove) +
      Math.fround(Math.fround(scale * right) * this.cmd.rightmove));
    return vec3(component(this.forward.x, this.right.x), component(this.forward.y, this.right.y),
      component(this.forward.z, this.right.z) + Math.fround(scale * this.cmd.upmove));
  }
  private waterMove(): void {
    if (this.checkWaterJump()) { this.waterJumpMove(); return; }
    this.friction();
    const scale = this.commandScale();
    const wish = scale === 0 ? vec3(0, 0, -60) : this.wishVelocity(scale);
    this.accelerate(normalize3(wish), Math.min(length3(wish), this.state.speed * 0.5), 4);
    if (this.groundNormal !== null && dot3(this.state.velocity, this.groundNormal) < 0) {
      const speed = Math.fround(length3(this.state.velocity));
      this.state.velocity = scale3(normalize3(clipVelocity(this.state.velocity, this.groundNormal)), speed);
    }
    slideMove(this, false);
  }
  private flyMove(): void {
    this.friction();
    const wish = this.wishVelocity(this.commandScale());
    this.accelerate(normalize3(wish), length3(wish), 8);
    stepSlideMove(this, false);
  }
  private airMove(): void {
    this.friction();
    const scale = this.commandScale();
    this.movementDirection();
    this.forward = normalize3(vec3(this.forward.x, this.forward.y, 0));
    this.right = normalize3(vec3(this.right.x, this.right.y, 0));
    const wish = add3(scale3(this.forward, this.cmd.forwardmove), scale3(this.right, this.cmd.rightmove));
    this.accelerate(normalize3(wish), Math.fround(Math.fround(length3(wish)) * scale), 1);
    if (this.groundNormal !== null) this.state.velocity = clipVelocity(this.state.velocity, this.groundNormal);
    stepSlideMove(this, true);
  }
  private grappleMove(): void {
    const pull = sub3(add3(this.state.grapplePoint, scale3(this.forward, -16)), this.state.origin);
    const distance = Math.fround(length3(pull));
    this.state.velocity = scale3(normalize3(pull), distance <= 100 ? Math.fround(10 * distance) : 800);
    this.groundNormal = null;
  }
  private walkMove(): void {
    const normal = this.groundNormal;
    if (normal === null) throw new Error("Walking requires a ground plane");
    if (this.waterlevel > 2 && dot3(this.forward, normal) > 0) { this.waterMove(); return; }
    if (this.checkJump()) { if (this.waterlevel > 1) this.waterMove(); else this.airMove(); return; }
    this.friction();
    const ps = this.state;
    const scale = this.commandScale();
    this.movementDirection();
    this.forward = normalize3(clipVelocity(vec3(this.forward.x, this.forward.y, 0), normal));
    this.right = normalize3(clipVelocity(vec3(this.right.x, this.right.y, 0), normal));
    const wish = add3(scale3(this.forward, this.cmd.forwardmove), scale3(this.right, this.cmd.rightmove));
    let wishSpeed = Math.fround(Math.fround(length3(wish)) * scale);
    if (ps.pmFlags & F.DUCKED) wishSpeed = Math.min(wishSpeed, ps.speed * 0.25);
    if (this.waterlevel) {
      let waterScale = Math.fround(this.waterlevel / 3);
      waterScale = Math.fround(1 - 0.5 * waterScale);
      wishSpeed = Math.min(wishSpeed, Math.fround(ps.speed * waterScale));
    }
    const sliding = (this.groundSurfaceFlags & SURF_SLICK) !== 0 || (ps.pmFlags & F.TIME_KNOCKBACK) !== 0;
    this.accelerate(normalize3(wish), wishSpeed, sliding ? 1 : 10);
    if (sliding) ps.velocity = vec3(ps.velocity.x, ps.velocity.y, ps.velocity.z - Math.fround(ps.gravity * this.frameTime));
    const speed = Math.fround(length3(ps.velocity));
    ps.velocity = scale3(normalize3(clipVelocity(ps.velocity, normal)), speed);
    if (ps.velocity.x || ps.velocity.y) stepSlideMove(this, false);
  }
  private noclipMove(): void {
    const ps = this.state;
    ps.viewheight = 26;
    const speed = Math.fround(length3(ps.velocity));
    ps.velocity = speed < 1 ? vec3(0, 0, 0) : scale3(ps.velocity,
      Math.fround(Math.max(0, Math.fround(speed - Math.fround(Math.fround(Math.max(100, speed) * 9) * this.frameTime))) / speed));
    const wish = this.wishVelocity(1);
    this.accelerate(normalize3(wish), Math.fround(Math.fround(length3(wish)) * this.commandScale()), 10);
    ps.origin = add3(ps.origin, scale3(ps.velocity, this.frameTime));
  }
  private footstepForSurface(): number {
    return this.groundSurfaceFlags & SURF_NOSTEPS ? 0 :
      this.groundSurfaceFlags & SURF_METALSTEPS ? EntityEvent.EV_FOOTSTEP_METAL : EntityEvent.EV_FOOTSTEP;
  }
  private crashLand(): void {
    const ps = this.state;
    this.legs(ps.pmFlags & F.BACKWARDS_JUMP ? A.LEGS_LANDB : A.LEGS_LAND, true);
    ps.legsTimer = 130;
    const dist = Math.fround(ps.origin.z - this.previousOrigin.z);
    const velocity = this.previousVelocity.z;
    const acceleration = Math.fround((-ps.gravity) | 0);
    const a = Math.fround(acceleration / 2);
    const discriminant = Math.fround(Math.fround(velocity * velocity) - Math.fround(Math.fround(4 * a) * -dist));
    if (discriminant < 0) return;
    const t = Math.fround(Math.fround(-velocity - Math.fround(Math.sqrt(discriminant))) / Math.fround(2 * a));
    let delta = Math.fround(velocity + Math.fround(t * acceleration));
    delta = Math.fround(Math.fround(delta * delta) * Math.fround(0.0001));
    if (ps.pmFlags & F.DUCKED) delta = Math.fround(delta * 2);
    if (this.waterlevel === 3) return;
    if (this.waterlevel === 2) delta = Math.fround(delta * 0.25);
    if (this.waterlevel === 1) delta = Math.fround(delta * 0.5);
    if (delta < 1) return;
    if (!(this.groundSurfaceFlags & SURF_NODAMAGE)) {
      if (delta > 60) this.event(EntityEvent.EV_FALL_FAR);
      else if (delta > 40) { if (ps.health > 0) this.event(EntityEvent.EV_FALL_MEDIUM); }
      else if (delta > 7) this.event(EntityEvent.EV_FALL_SHORT);
      else this.event(this.footstepForSurface());
    }
    ps.bobCycle = 0;
  }
  private groundTrace(): void {
    const ps = this.state;
    const down = vec3(ps.origin.x, ps.origin.y, ps.origin.z - 0.25);
    let trace = this.test(ps.origin, down);
    if (trace.solidity === "all-solid") {
      this.debug("allsolid");
      let corrected = false;
      for (let i = -1; i <= 1 && !corrected; i++) {
        for (let j = -1; j <= 1 && !corrected; j++) {
          for (let k = -1; k <= 1; k++) {
            const point = add3(ps.origin, vec3(i, j, k));
            if (this.test(point, point).solidity !== "all-solid") {
              trace = this.test(ps.origin, down);
              corrected = true;
              break;
            }
          }
        }
      }
      if (!corrected) { this.leaveGround(); return; }
    }
    this.groundSurfaceFlags = trace.surfaceFlags;
    if (trace.fraction === 1) {
      if (ps.groundEntityNum !== ENTITYNUM_NONE) {
        this.debug("lift");
        if (this.test(ps.origin, vec3(ps.origin.x, ps.origin.y, ps.origin.z - 64)).fraction === 1) this.jumpAnimation();
      }
      this.leaveGround();
      return;
    }
    // An unresolved all-solid trace has no normal in the collision contract.
    if (trace.contact.kind !== "plane") { this.leaveGround(); return; }
    const normal = trace.contact.plane.normal;
    if (ps.velocity.z > 0 && dot3(ps.velocity, normal) > 10) {
      this.debug("kickoff");
      this.jumpAnimation(); this.leaveGround(); return;
    }
    this.groundNormal = normal;
    if (normal.z < Math.fround(0.7)) {
      this.debug("steep");
      ps.groundEntityNum = ENTITYNUM_NONE; this.walking = false; return;
    }
    this.walking = true;
    if (ps.pmFlags & F.TIME_WATERJUMP) { ps.pmFlags &= ~(F.TIME_WATERJUMP | F.TIME_LAND); ps.pmTime = 0; }
    if (ps.groundEntityNum === ENTITYNUM_NONE) {
      this.debug("Land");
      this.crashLand();
      if (this.previousVelocity.z < -200) { ps.pmFlags |= F.TIME_LAND; ps.pmTime = 250; }
    }
    ps.groundEntityNum = trace.entityNum;
    this.touch(trace.entityNum);
  }
  private leaveGround(): void {
    this.state.groundEntityNum = ENTITYNUM_NONE;
    this.groundNormal = null;
    this.walking = false;
  }
  private setWaterLevel(): void {
    this.waterlevel = 0;
    this.watertype = 0;
    const ps = this.state;
    const contents = this.contents(vec3(ps.origin.x, ps.origin.y, ps.origin.z - 23));
    if (!(contents & MASK_WATER)) return;
    this.watertype = contents;
    this.waterlevel = 1;
    const sample2 = ps.viewheight + 24;
    const sample1 = Math.trunc(sample2 / 2);
    if (!(this.contents(vec3(ps.origin.x, ps.origin.y, ps.origin.z - 24 + sample1)) & MASK_WATER)) return;
    this.waterlevel = 2;
    if (this.contents(vec3(ps.origin.x, ps.origin.y, ps.origin.z - 24 + sample2)) & MASK_WATER) this.waterlevel = 3;
  }
  private checkDuck(): void {
    const ps = this.state;
    if (ps.powerups.get(Powerup.PW_INVULNERABILITY)) {
      this.bounds = ps.pmFlags & F.INVULEXPAND ? { min: vec3(-42, -42, -42), max: vec3(42, 42, 42) } :
        { min: standingBounds.min, max: vec3(15, 15, 16) };
      ps.pmFlags |= F.DUCKED;
      ps.viewheight = 12;
      return;
    }
    ps.pmFlags &= ~F.INVULEXPAND;
    if (ps.pmType === MoveType.PM_DEAD) {
      this.bounds = { min: standingBounds.min, max: vec3(15, 15, -8) };
      ps.viewheight = -16;
      return;
    }
    if (this.cmd.upmove < 0) ps.pmFlags |= F.DUCKED;
    else if (ps.pmFlags & F.DUCKED) {
      this.bounds = standingBounds;
      if (this.test(ps.origin, ps.origin).solidity !== "all-solid") ps.pmFlags &= ~F.DUCKED;
    }
    this.bounds = ps.pmFlags & F.DUCKED ? { min: standingBounds.min, max: vec3(15, 15, 16) } : standingBounds;
    ps.viewheight = ps.pmFlags & F.DUCKED ? 12 : 26;
  }
  private footsteps(): void {
    const ps = this.state;
    const xSquared = Math.fround(ps.velocity.x * ps.velocity.x);
    const ySquared = Math.fround(ps.velocity.y * ps.velocity.y);
    this.xyspeed = Math.fround(Math.sqrt(Math.fround(xSquared + ySquared)));
    if (ps.groundEntityNum === ENTITYNUM_NONE) {
      if (ps.powerups.get(Powerup.PW_INVULNERABILITY)) this.legs(A.LEGS_IDLECR);
      if (this.waterlevel > 1) this.legs(A.LEGS_SWIM);
      return;
    }
    if (!this.cmd.forwardmove && !this.cmd.rightmove) {
      if (this.xyspeed < 5) { ps.bobCycle = 0; this.legs(ps.pmFlags & F.DUCKED ? A.LEGS_IDLECR : A.LEGS_IDLE); }
      return;
    }
    let bob: number;
    let footstep = false;
    const backwards = ps.pmFlags & F.BACKWARDS_RUN;
    if (ps.pmFlags & F.DUCKED) { bob = 0.5; this.legs(backwards ? A.LEGS_BACKCR : A.LEGS_WALKCR); }
    else if (!(this.cmd.buttons & B.WALKING)) {
      bob = 0.4; footstep = true; this.legs(backwards ? A.LEGS_BACK : A.LEGS_RUN);
    } else { bob = 0.3; this.legs(backwards ? A.LEGS_BACKWALK : A.LEGS_WALK); }
    const old = ps.bobCycle;
    ps.bobCycle = Math.trunc(Math.fround(Math.fround(old) + Math.fround(Math.fround(bob) * this.msec))) & 255;
    if (((old + 64) ^ (ps.bobCycle + 64)) & 128) {
      if (this.waterlevel === 0 && footstep && !this.options.noFootsteps) this.event(this.footstepForSurface());
      else if (this.waterlevel === 1) this.event(EntityEvent.EV_FOOTSPLASH);
      else if (this.waterlevel === 2) this.event(EntityEvent.EV_SWIM);
    }
  }
  private waterEvents(previous: number): void {
    if (!previous && this.waterlevel) this.event(EntityEvent.EV_WATER_TOUCH);
    if (previous && !this.waterlevel) this.event(EntityEvent.EV_WATER_LEAVE);
    if (previous !== 3 && this.waterlevel === 3) this.event(EntityEvent.EV_WATER_UNDER);
    if (previous === 3 && this.waterlevel !== 3) this.event(EntityEvent.EV_WATER_CLEAR);
  }
  private beginWeaponChange(weapon: number): void {
    const ps = this.state;
    if (weapon <= Weapon.WP_NONE || weapon >= weaponCount(ps.product) ||
      !(ps.stats.get(statSchema(ps.product).weapons) & (1 << weapon)) || ps.weaponState === WeaponState.WEAPON_DROPPING) return;
    this.event(EntityEvent.EV_CHANGE_WEAPON);
    ps.weaponState = WeaponState.WEAPON_DROPPING;
    ps.weaponTime += 200;
    this.startTorso(A.TORSO_DROP);
  }
  private finishWeaponChange(): void {
    const ps = this.state;
    const requestedWeapon = this.cmd.weapon;
    let weapon: Weapon;
    switch (requestedWeapon) {
      case Weapon.WP_NONE: case Weapon.WP_GAUNTLET: case Weapon.WP_MACHINEGUN: case Weapon.WP_SHOTGUN:
      case Weapon.WP_GRENADE_LAUNCHER: case Weapon.WP_ROCKET_LAUNCHER: case Weapon.WP_LIGHTNING:
      case Weapon.WP_RAILGUN: case Weapon.WP_PLASMAGUN: case Weapon.WP_BFG: case Weapon.WP_GRAPPLING_HOOK:
      case Weapon.WP_NAILGUN: case Weapon.WP_PROX_LAUNCHER: case Weapon.WP_CHAINGUN: weapon = requestedWeapon; break;
      default: weapon = Weapon.WP_NONE; break;
    }
    if (weapon >= weaponCount(ps.product)) weapon = Weapon.WP_NONE;
    if (!(ps.stats.get(statSchema(ps.product).weapons) & (1 << weapon))) weapon = Weapon.WP_NONE;
    ps.weapon = weapon;
    ps.weaponState = WeaponState.WEAPON_RAISING;
    ps.weaponTime += 250;
    this.startTorso(A.TORSO_RAISE);
  }
  private weapon(): void {
    const ps = this.state;
    const schema = statSchema(ps.product);
    if (ps.pmFlags & F.RESPAWNED || ps.persistant.get(PersistentIndex.PERS_TEAM) === Team.TEAM_SPECTATOR) return;
    if (ps.health <= 0) { ps.weapon = Weapon.WP_NONE; return; }
    if (this.cmd.buttons & B.USE_HOLDABLE) {
      if (!(ps.pmFlags & F.USE_ITEM_HELD)) {
        const item = itemAt(ps.product, ps.stats.get(schema.holdableItem));
        if (item.tag !== Holdable.HI_MEDKIT || ps.health < ps.stats.get(schema.maxHealth) + 25) {
          ps.pmFlags |= F.USE_ITEM_HELD;
          this.event(EntityEvent.EV_USE_ITEM0 + item.tag);
          ps.stats.set(schema.holdableItem, 0);
        }
        return;
      }
    } else ps.pmFlags &= ~F.USE_ITEM_HELD;
    if (ps.weaponTime > 0) ps.weaponTime -= this.msec;
    if (ps.weaponTime <= 0 || ps.weaponState !== WeaponState.WEAPON_FIRING) {
      if (ps.weapon !== this.cmd.weapon) this.beginWeaponChange(this.cmd.weapon);
    }
    if (ps.weaponTime > 0) return;
    if (ps.weaponState === WeaponState.WEAPON_DROPPING) { this.finishWeaponChange(); return; }
    if (ps.weaponState === WeaponState.WEAPON_RAISING) {
      ps.weaponState = WeaponState.WEAPON_READY;
      this.startTorso(ps.weapon === Weapon.WP_GAUNTLET ? A.TORSO_STAND2 : A.TORSO_STAND);
      return;
    }
    if (!(this.cmd.buttons & B.ATTACK) || (ps.weapon === Weapon.WP_GAUNTLET && !this.options.gauntletHit)) {
      ps.weaponTime = 0;
      ps.weaponState = WeaponState.WEAPON_READY;
      return;
    }
    this.startTorso(ps.weapon === Weapon.WP_GAUNTLET ? A.TORSO_ATTACK2 : A.TORSO_ATTACK);
    ps.weaponState = WeaponState.WEAPON_FIRING;
    const ammo = ps.ammo.get(ps.weapon);
    if (ammo === 0) { this.event(EntityEvent.EV_NOAMMO); ps.weaponTime += 500; return; }
    if (ammo !== -1) ps.ammo.set(ps.weapon, ammo - 1);
    this.event(EntityEvent.EV_FIRE_WEAPON);
    let addTime: number;
    switch (ps.weapon) {
      case Weapon.WP_LIGHTNING: addTime = 50; break;
      case Weapon.WP_SHOTGUN: addTime = 1000; break;
      case Weapon.WP_MACHINEGUN: case Weapon.WP_PLASMAGUN: addTime = 100; break;
      case Weapon.WP_GRENADE_LAUNCHER: case Weapon.WP_ROCKET_LAUNCHER: addTime = 800; break;
      case Weapon.WP_RAILGUN: addTime = 1500; break;
      case Weapon.WP_BFG: addTime = 200; break;
      case Weapon.WP_NAILGUN: addTime = ps.product === "missionpack" ? 1000 : 400; break;
      case Weapon.WP_PROX_LAUNCHER: addTime = ps.product === "missionpack" ? 800 : 400; break;
      case Weapon.WP_CHAINGUN: addTime = ps.product === "missionpack" ? 30 : 400; break;
      default: addTime = 400; break;
    }
    const persistent = schema.product === "missionpack" ? itemAt(ps.product, ps.stats.get(schema.persistentPowerup)).tag : 0;
    if (persistent === Powerup.PW_SCOUT) addTime = Math.trunc(addTime / 1.5);
    else if (persistent === Powerup.PW_AMMOREGEN || ps.powerups.get(Powerup.PW_HASTE)) addTime = Math.trunc(addTime / 1.3);
    ps.weaponTime += addTime;
  }
  private animate(): void {
    const ps = this.state;
    if (ps.torsoTimer !== 0) return;
    if (this.cmd.buttons & B.GESTURE) {
      this.startTorso(A.TORSO_GESTURE);
      ps.torsoTimer = 34 * 66 + 50;
      this.event(EntityEvent.EV_TAUNT);
    } else if (ps.product === "missionpack") {
      const gestures: readonly (readonly [B, A])[] = [
        [B.GETFLAG, A.TORSO_GETFLAG], [B.GUARDBASE, A.TORSO_GUARDBASE], [B.PATROL, A.TORSO_PATROL],
        [B.FOLLOWME, A.TORSO_FOLLOWME], [B.AFFIRMATIVE, A.TORSO_AFFIRMATIVE], [B.NEGATIVE, A.TORSO_NEGATIVE],
      ];
      for (const [button, animation] of gestures) {
        if (this.cmd.buttons & button) { this.startTorso(animation); ps.torsoTimer = 600; break; }
      }
    }
  }
  private dropTimers(): void {
    const ps = this.state;
    if (ps.pmTime) {
      if (this.msec >= ps.pmTime) { ps.pmFlags &= ~ALL_TIMES; ps.pmTime = 0; }
      else ps.pmTime -= this.msec;
    }
    if (ps.legsTimer > 0) ps.legsTimer = Math.max(0, ps.legsTimer - this.msec);
    if (ps.torsoTimer > 0) ps.torsoTimer = Math.max(0, ps.torsoTimer - this.msec);
  }
  run(): void {
    const ps = this.state;
    const cmd = this.cmd;
    const diagnostics = this.options.diagnostics;
    if (diagnostics !== undefined) diagnostics.state.count = (diagnostics.state.count + 1) | 0;
    if (Math.abs(cmd.forwardmove) > 64 || Math.abs(cmd.rightmove) > 64) cmd.buttons &= ~B.WALKING;
    if (cmd.buttons & B.TALK) ps.eFlags |= 0x1000; else ps.eFlags &= ~0x1000;
    if (!(ps.pmFlags & F.RESPAWNED) && ps.pmType !== MoveType.PM_INTERMISSION &&
      (cmd.buttons & B.ATTACK) && ps.ammo.get(ps.weapon)) ps.eFlags |= 0x100; else ps.eFlags &= ~0x100;
    if (ps.health > 0 && !(cmd.buttons & (B.ATTACK | B.USE_HOLDABLE))) ps.pmFlags &= ~F.RESPAWNED;
    if (cmd.buttons & B.TALK) { cmd.buttons = B.TALK; cmd.forwardmove = 0; cmd.rightmove = 0; cmd.upmove = 0; }
    ps.commandTime = cmd.serverTime;
    updateViewAngles(ps, cmd);
    const axes = qvmAngleVectors(ps.viewangles);
    this.forward = axes.forward;
    this.right = axes.right;
    if (cmd.upmove < 10) ps.pmFlags &= ~F.JUMP_HELD;
    if (cmd.forwardmove < 0) ps.pmFlags |= F.BACKWARDS_RUN;
    else if (cmd.forwardmove > 0 || (!cmd.forwardmove && cmd.rightmove)) ps.pmFlags &= ~F.BACKWARDS_RUN;
    if (ps.pmType >= MoveType.PM_DEAD) { cmd.forwardmove = 0; cmd.rightmove = 0; cmd.upmove = 0; }
    if (ps.pmType === MoveType.PM_SPECTATOR) { this.checkDuck(); this.flyMove(); this.dropTimers(); return; }
    if (ps.pmType === MoveType.PM_NOCLIP) { this.noclipMove(); this.dropTimers(); return; }
    if (ps.pmType === MoveType.PM_FREEZE || ps.pmType === MoveType.PM_INTERMISSION || ps.pmType === MoveType.PM_SPINTERMISSION) return;
    this.setWaterLevel();
    const previousWaterlevel = this.waterlevel;
    this.checkDuck();
    this.groundTrace();
    if (ps.pmType === MoveType.PM_DEAD && this.walking) {
      const speed = Math.fround(Math.fround(length3(ps.velocity)) - 20);
      ps.velocity = speed <= 0 ? vec3(0, 0, 0) : scale3(normalize3(ps.velocity), speed);
    }
    this.dropTimers();
    if (ps.product === "missionpack" && ps.powerups.get(Powerup.PW_INVULNERABILITY)) {
      cmd.forwardmove = 0; cmd.rightmove = 0; cmd.upmove = 0;
      ps.velocity = vec3(0, 0, 0);
    } else if (ps.powerups.get(Powerup.PW_FLIGHT)) this.flyMove();
    else if (ps.pmFlags & F.GRAPPLE_PULL) { this.grappleMove(); this.airMove(); }
    else if (ps.pmFlags & F.TIME_WATERJUMP) this.waterJumpMove();
    else if (this.waterlevel > 1) this.waterMove();
    else if (this.walking) this.walkMove();
    else this.airMove();
    this.animate();
    this.groundTrace();
    this.setWaterLevel();
    this.weapon();
    if (ps.weaponState === WeaponState.WEAPON_READY) this.torso(ps.weapon === Weapon.WP_GAUNTLET ? A.TORSO_STAND2 : A.TORSO_STAND);
    this.footsteps();
    this.waterEvents(previousWaterlevel);
    ps.velocity = vec3(snap(ps.velocity.x), snap(ps.velocity.y), snap(ps.velocity.z));
  }
}

/** Mutates only the supplied state; command input remains owned by the caller. */
export function movePlayer(state: SourcePlayerState, command: UserCommand, options: MovementOptions): MovementResult {
  if (!Number.isInteger(command.serverTime) || !Number.isFinite(command.serverTime)) throw new RangeError("Command time must be an integer");
  for (const axis of [command.forwardmove, command.rightmove, command.upmove]) {
    if (!Number.isInteger(axis) || axis < -128 || axis > 127) throw new RangeError("Command movement must be a signed byte");
  }
  const fixed = options.fixedMsec ?? 66;
  if (!Number.isInteger(fixed) || fixed < 1 || fixed > 0x7fffffff) throw new RangeError("Movement step must be a positive signed 32-bit integer");
  const events: PredictableEvent[] = [];
  let result: MovementResult = { contacts: [], events, bounds: zeroBounds, waterlevel: 0, watertype: 0, xyspeed: 0 };
  const finalTime = command.serverTime;
  if (finalTime < state.commandTime) return result;
  if (finalTime > state.commandTime + 1000) state.commandTime = finalTime - 1000;
  state.pmoveFramecount = (state.pmoveFramecount + 1) & 63;
  const cmd: UserCommand = { ...command };
  while (state.commandTime !== finalTime) {
    cmd.serverTime = state.commandTime + Math.min(finalTime - state.commandTime, fixed);
    const step = new MoveStep(state, cmd, options, events);
    step.run();
    result = { contacts: step.contacts, events, bounds: step.bounds,
      waterlevel: step.waterlevel, watertype: step.watertype, xyspeed: step.xyspeed };
    if (state.pmFlags & F.JUMP_HELD) cmd.upmove = 20;
  }
  return result;
}
