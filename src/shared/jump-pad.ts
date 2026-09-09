// BG_TouchJumpPad from id Software's code/game/bg_misc.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { angleNormalize180, vec3, vectorToAngles } from "../core/math.ts";
import { EntityEvent, MoveType, Powerup } from "./definitions.ts";
import type { EntityState } from "./entity-state.ts";
import type { SourcePlayerState } from "./player-state.ts";

export function touchJumpPad(state: SourcePlayerState, jumpPad: EntityState): void {
  if (state.pmType !== MoveType.PM_NORMAL || state.powerups.get(Powerup.PW_FLIGHT) !== 0) return;
  if (state.jumppadEnt !== jumpPad.number) {
    const pitch = Math.abs(angleNormalize180(vectorToAngles(jumpPad.origin2).x));
    state.addEvent(EntityEvent.EV_JUMP_PAD, pitch < 45 ? 0 : 1);
  }
  state.jumppadEnt = jumpPad.number;
  state.jumppadFrame = state.pmoveFramecount;
  state.velocity = vec3(jumpPad.origin2.x, jumpPad.origin2.y, jumpPad.origin2.z);
}
