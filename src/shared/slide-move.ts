// Ported from id Software's code/game/bg_slidemove.c and PM_ClipVelocity.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { add3, cross3, dot3, normalize3, normalize3OrZero, scale3, vec3 } from "../core/math.ts";
import type { Bounds, Vec3 } from "../core/math.ts";
import type { TraceResult } from "../collision/world.ts";
import { EntityEvent } from "./definitions.ts";
import type { SourcePlayerState } from "./player-state.ts";

export type MovementTrace = TraceResult & { readonly entityNum: number };
export type MovementTraceFunction = (
  start: Vec3, end: Vec3, bounds: Bounds, passEntity: number, mask: number,
) => MovementTrace;

export interface SlideMoveContext {
  readonly state: SourcePlayerState;
  readonly frameTime: number;
  readonly bounds: Bounds;
  readonly mask: number;
  readonly trace: MovementTraceFunction;
  readonly groundNormal: Vec3 | null;
  impactSpeed: number;
  touch(entityNum: number): void;
  event(event: number): void;
  debug?(message: string): void;
}

export function clipVelocity(velocity: Vec3, normal: Vec3, overbounce = 1.001): Vec3 {
  const dot = Math.fround(dot3(velocity, normal));
  const bounce = Math.fround(overbounce);
  const backoff = Math.fround(dot < 0 ? dot * bounce : dot / bounce);
  return vec3(
    velocity.x - Math.fround(normal.x * backoff),
    velocity.y - Math.fround(normal.y * backoff),
    velocity.z - Math.fround(normal.z * backoff),
  );
}

export function slideMove(context: SlideMoveContext, gravity: boolean): boolean {
  const ps = context.state;
  let primalVelocity = ps.velocity;
  let endVelocity = ps.velocity;
  if (gravity) {
    endVelocity = vec3(ps.velocity.x, ps.velocity.y, ps.velocity.z - Math.fround(ps.gravity * context.frameTime));
    ps.velocity = vec3(ps.velocity.x, ps.velocity.y, (ps.velocity.z + endVelocity.z) * 0.5);
    primalVelocity = vec3(primalVelocity.x, primalVelocity.y, endVelocity.z);
    if (context.groundNormal !== null) ps.velocity = clipVelocity(ps.velocity, context.groundNormal);
  }
  let timeLeft = context.frameTime;
  const planes: Vec3[] = [];
  if (context.groundNormal !== null) planes.push(context.groundNormal);
  planes.push(normalize3OrZero(ps.velocity));
  let bumpCount = 0;
  for (; bumpCount < 4; bumpCount++) {
    const end = add3(ps.origin, scale3(ps.velocity, timeLeft));
    const trace = context.trace(ps.origin, end, context.bounds, ps.clientNum, context.mask);
    if (trace.solidity === "all-solid") {
      ps.velocity = vec3(ps.velocity.x, ps.velocity.y, 0);
      return true;
    }
    if (trace.fraction > 0) ps.origin = trace.end;
    if (trace.fraction === 1) break;
    context.touch(trace.entityNum);
    timeLeft = Math.fround(timeLeft - Math.fround(timeLeft * trace.fraction));
    if (planes.length >= 5) { ps.velocity = vec3(0, 0, 0); return true; }
    if (trace.contact.kind !== "plane") {
      throw new Error("Movement impact trace requires a collision plane");
    }
    const normal = trace.contact.plane.normal;
    if (planes.some(plane => dot3(normal, plane) > Math.fround(0.99))) {
      ps.velocity = add3(ps.velocity, normal);
      continue;
    }
    planes.push(normal);
    for (const [i, first] of planes.entries()) {
      const into = dot3(ps.velocity, first);
      if (into >= 0.1) continue;
      context.impactSpeed = Math.max(context.impactSpeed, -into);
      let clipped = clipVelocity(ps.velocity, first);
      let endClipped = clipVelocity(endVelocity, first);
      for (const [j, second] of planes.entries()) {
        if (j === i || dot3(clipped, second) >= 0.1) continue;
        clipped = clipVelocity(clipped, second);
        endClipped = clipVelocity(endClipped, second);
        if (dot3(clipped, first) >= 0) continue;
        const direction = normalize3(cross3(first, second));
        clipped = scale3(direction, dot3(direction, ps.velocity));
        endClipped = scale3(direction, dot3(direction, endVelocity));
        for (const [k, third] of planes.entries()) {
          if (k !== i && k !== j && dot3(clipped, third) < 0.1) {
            ps.velocity = vec3(0, 0, 0);
            return true;
          }
        }
      }
      ps.velocity = clipped;
      endVelocity = endClipped;
      break;
    }
  }
  if (gravity) ps.velocity = endVelocity;
  if (ps.pmTime !== 0) ps.velocity = primalVelocity;
  return bumpCount !== 0;
}

export function stepSlideMove(context: SlideMoveContext, gravity: boolean): void {
  const ps = context.state;
  const startOrigin = ps.origin;
  const startVelocity = ps.velocity;
  if (!slideMove(context, gravity)) return;
  const down = vec3(startOrigin.x, startOrigin.y, startOrigin.z - 18);
  const ground = context.trace(startOrigin, down, context.bounds, ps.clientNum, context.mask);
  if (ps.velocity.z > 0 && (ground.fraction === 1 ||
    ground.contact.kind !== "plane" || ground.contact.plane.normal.z < Math.fround(0.7))) return;
  const up = vec3(startOrigin.x, startOrigin.y, startOrigin.z + 18);
  const raised = context.trace(startOrigin, up, context.bounds, ps.clientNum, context.mask);
  if (raised.solidity === "all-solid") {
    context.debug?.("bend can't step");
    return;
  }
  const stepSize = Math.fround(raised.end.z - startOrigin.z);
  ps.origin = raised.end;
  ps.velocity = startVelocity;
  slideMove(context, gravity);
  const dropped = context.trace(ps.origin, vec3(ps.origin.x, ps.origin.y, ps.origin.z - stepSize),
    context.bounds, ps.clientNum, context.mask);
  if (dropped.solidity !== "all-solid") ps.origin = dropped.end;
  if (dropped.fraction < 1 && dropped.contact.kind === "plane") {
    ps.velocity = clipVelocity(ps.velocity, dropped.contact.plane.normal);
  }
  const delta = Math.fround(ps.origin.z - startOrigin.z);
  if (delta > 2) {
    context.event(delta < 7 ? EntityEvent.EV_STEP_4 : delta < 11 ? EntityEvent.EV_STEP_8 :
      delta < 15 ? EntityEvent.EV_STEP_12 : EntityEvent.EV_STEP_16);
  }
  context.debug?.("stepped");
}
