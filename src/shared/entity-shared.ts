// Port of id Software's code/game/g_public.h entityShared_t/sharedEntity_t.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { vec3 } from "../core/math.ts";
import type { EntityStateFields } from "./entity-state.ts";

export type EntityCollisionModel =
  | { readonly kind: "inline"; readonly index: number }
  | { readonly kind: "box" }
  | { readonly kind: "capsule" };

export enum ServerEntityFlags {
  NOCLIENT = 0x00000001,
  CLIENTMASK = 0x00000002,
  BOT = 0x00000008,
  BROADCAST = 0x00000020,
  PORTAL = 0x00000040,
  USE_CURRENT_ORIGIN = 0x00000080,
  SINGLECLIENT = 0x00000100,
  NOSERVERINFO = 0x00000200,
  NOTSINGLECLIENT = 0x00000800,
}

/** Game-owned source records shared with ServerWorld.
 * The model discriminant replaces bmodel and SVF_CAPSULE. */
export class EntityShared {
  linked = false;
  linkcount = 0;
  svFlags = 0;
  singleClient = 0;
  model: EntityCollisionModel = { kind: "box" };
  mins = vec3(0, 0, 0);
  maxs = vec3(0, 0, 0);
  contents = 0;
  absmin = vec3(0, 0, 0);
  absmax = vec3(0, 0, 0);
  currentOrigin = vec3(0, 0, 0);
  currentAngles = vec3(0, 0, 0);
  ownerNum = 0;
}

export type SharedEntityState =
  Omit<Readonly<EntityStateFields>, "number" | "solid" | "modelindex"> &
  Pick<EntityStateFields, "number" | "solid" | "modelindex">;

export interface SharedEntity {
  readonly s: SharedEntityState;
  readonly r: EntityShared;
}
