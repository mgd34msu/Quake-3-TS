// Ported from id Software's code/game/g_items.c: G_BounceItem, G_RunItem,
// LaunchItem, and Drop_Item. Copyright (C) 1999-2005 Id Software, Inc.
// GPL-2.0-or-later.

import type { ServerTraceResult } from "../server/world.ts";
import { add3, dot3, scale3, vec3 } from "../core/math.ts";
import { qvmAngleVectors } from "../core/qvm-math.ts";
import type { Vec3 } from "../core/math.ts";
import { qvmFloatToInt } from "../core/numeric.ts";
import { EntityType, GameType, ItemType } from "../shared/definitions.ts";
import type { Product } from "../shared/definitions.ts";
import { itemList } from "../shared/items.ts";
import type { ItemDefinition } from "../shared/items.ts";
import { evaluateTrajectory, evaluateTrajectoryDelta, TrajectoryType } from "../shared/trajectory.ts";
import type { EntityThink, EntityTouch, GameEntity } from "./state.ts";
import { GameFlags } from "./state.ts";
import { EntityPool, runThink, setOrigin } from "./entities.ts";
import type { ServerWorld } from "../server/world.ts";

const ITEM_RADIUS = 15;
const CONTENTS_SOLID = 0x1;
const CONTENTS_PLAYERCLIP = 0x10000;
const CONTENTS_TRIGGER = 0x40000000;
const CONTENTS_NODROP = 0x80000000;
const EF_BOUNCE_HALF = 0x20;
const DROPPED_ITEM_LIFETIME = 30_000;

export interface ItemFrameTime {
  readonly time: number;
  readonly previousTime: number;
}

export interface RunItemContext extends ItemFrameTime {
  readonly entities: EntityPool;
  readonly world: ServerWorld;
  /** Port of Team_FreeEntity for a team item entering CONTENTS_NODROP. */
  readonly freeTeamEntity: EntityThink;
}

export interface LaunchItemContext {
  readonly entities: EntityPool;
  readonly product: Product;
  readonly gameType: number;
  readonly time: number;
  readonly touchItem: EntityTouch;
  /** Port of Team_DroppedFlagThink for the 30-second expiry. */
  readonly droppedFlagThink: EntityThink;
  /** Port of Team_CheckDroppedItem, called immediately after team-item setup. */
  readonly checkDroppedTeamItem: EntityThink;
}

export interface DropItemContext extends LaunchItemContext {
  /** Game random(), whose (rand() & 0x7fff) / 32767 result is within [0, 1]. */
  readonly random: () => number;
}

function gameTime(value: number): number {
  if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    throw new RangeError("Item motion time must be a signed 32-bit millisecond value");
  }
  return value;
}

function itemIndex(context: LaunchItemContext, item: ItemDefinition): number {
  if (context.entities.options.product !== context.product) {
    throw new Error("Item motion product does not match its entity pool");
  }
  const index = itemList(context.product).indexOf(item);
  if (index < 1) throw new RangeError("Launched item does not belong to the selected product table");
  return index;
}

function requireOwnedEntity(entities: EntityPool, entity: GameEntity): void {
  if (entities.get(entity.slot) !== entity) {
    throw new Error("Item motion entity does not belong to its entity pool or was replaced");
  }
}

function collisionNormal(trace: ServerTraceResult): Vec3 {
  return trace.contact.kind === "plane" ? trace.contact.plane.normal : vec3(0, 0, 0);
}

/** Reflects one item trajectory at a trace impact and may settle it on the hit entity. */
export function bounceItem(entity: GameEntity, trace: ServerTraceResult, frame: ItemFrameTime): void {
  const time = gameTime(frame.time);
  const previousTime = gameTime(frame.previousTime);
  const fraction = Math.fround(trace.fraction);
  const elapsed = Math.fround((time - previousTime) | 0);
  const hitTime = qvmFloatToInt(Math.fround(Math.fround(previousTime) + Math.fround(elapsed * fraction)));
  const velocity = evaluateTrajectoryDelta(entity.s.pos, hitTime);
  const normal = collisionNormal(trace);
  const dot = dot3(velocity, normal);
  const reflected = add3(velocity, scale3(normal, Math.fround(-2 * dot)));
  const delta = scale3(reflected, entity.physicsBounce);
  entity.s.pos = { ...entity.s.pos, delta };

  if (normal.z > 0 && delta.z < 40) {
    const stopped = vec3(
      qvmFloatToInt(trace.end.x),
      qvmFloatToInt(trace.end.y),
      qvmFloatToInt(Math.fround(trace.end.z + 1)),
    );
    setOrigin(entity, stopped);
    entity.s.groundEntityNum = trace.entityNum;
    return;
  }

  entity.r.currentOrigin = add3(entity.r.currentOrigin, normal);
  entity.s.pos = {
    ...entity.s.pos,
    base: vec3(entity.r.currentOrigin.x, entity.r.currentOrigin.y, entity.r.currentOrigin.z),
    time,
  };
}

/** Advances, links, thinks, removes, or bounces an item for one server frame. */
export function runItem(entity: GameEntity, context: RunItemContext): void {
  requireOwnedEntity(context.entities, entity);
  const time = gameTime(context.time);
  const previousTime = gameTime(context.previousTime);
  if (entity.s.groundEntityNum === -1 && entity.s.pos.type !== TrajectoryType.TR_GRAVITY) {
    entity.s.pos = { ...entity.s.pos, type: TrajectoryType.TR_GRAVITY, time };
  }

  if (entity.s.pos.type === TrajectoryType.TR_STATIONARY) {
    runThink(entity, time);
    return;
  }

  const destination = evaluateTrajectory(entity.s.pos, time);
  const trace = context.world.trace({
    start: entity.r.currentOrigin,
    end: destination,
    shape: { kind: "box", mins: entity.r.mins, maxs: entity.r.maxs },
    passEntityNum: entity.r.ownerNum,
    mask: entity.clipmask !== 0 ? entity.clipmask : CONTENTS_SOLID | CONTENTS_PLAYERCLIP,
  });
  entity.r.currentOrigin = vec3(trace.end.x, trace.end.y, trace.end.z);
  context.entities.options.link(entity);
  runThink(entity, time);

  const fraction = trace.solidity === "clear" ? trace.fraction : 0;
  if (fraction === 1) return;
  if ((context.world.pointContents(entity.r.currentOrigin, -1) & CONTENTS_NODROP) !== 0) {
    if (entity.item !== null && entity.item.type === ItemType.IT_TEAM) context.freeTeamEntity(entity);
    else context.entities.free(entity);
    return;
  }
  bounceItem(entity, { ...trace, fraction }, { time, previousTime });
}

function isSpecialTeamDrop(product: Product, gameType: number, item: ItemDefinition): boolean {
  if (item.type !== ItemType.IT_TEAM) return false;
  return gameType === GameType.GT_CTF || (product === "missionpack" && gameType === GameType.GT_1FCTF);
}

/** Creates and links one dropped item with its source 30-second lifecycle. */
export function launchItem(context: LaunchItemContext, item: ItemDefinition, origin: Vec3, velocity: Vec3): GameEntity {
  const time = gameTime(context.time);
  const index = itemIndex(context, item);
  const dropped = context.entities.spawn();
  dropped.s.eType = EntityType.ET_ITEM;
  dropped.s.modelindex = index;
  dropped.s.modelindex2 = 1;
  dropped.classname = item.className;
  dropped.item = item;
  dropped.r.mins = vec3(-ITEM_RADIUS, -ITEM_RADIUS, -ITEM_RADIUS);
  dropped.r.maxs = vec3(ITEM_RADIUS, ITEM_RADIUS, ITEM_RADIUS);
  dropped.r.contents = CONTENTS_TRIGGER;
  dropped.touch = context.touchItem;
  setOrigin(dropped, origin);
  dropped.s.pos = {
    ...dropped.s.pos,
    type: TrajectoryType.TR_GRAVITY,
    time,
    delta: vec3(velocity.x, velocity.y, velocity.z),
  };
  dropped.s.eFlags |= EF_BOUNCE_HALF;
  dropped.nextthink = (time + DROPPED_ITEM_LIFETIME) | 0;
  if (isSpecialTeamDrop(context.product, context.gameType, item)) {
    dropped.think = context.droppedFlagThink;
    context.checkDroppedTeamItem(dropped);
  } else {
    dropped.think = self => { context.entities.free(self); };
  }
  dropped.flags = GameFlags.DROPPED_ITEM;
  context.entities.options.link(dropped);
  return dropped;
}

/** Tosses an item forward from an entity, preserving Drop_Item's angle and random lift. */
export function dropItem(context: DropItemContext, entity: GameEntity, item: ItemDefinition, angle: number): GameEntity {
  requireOwnedEntity(context.entities, entity);
  const forward = qvmAngleVectors(vec3(0, entity.s.apos.base.y + angle, entity.s.apos.base.z)).forward;
  const horizontal = scale3(forward, 150);
  const random = context.random();
  if (!Number.isFinite(random) || random < 0 || random > 1) {
    throw new RangeError("Drop_Item random value must be within [0, 1]");
  }
  const crandom = Math.fround(2 * Math.fround(Math.fround(random) - 0.5));
  const lift = Math.fround(200 + Math.fround(crandom * 50));
  const velocity = vec3(horizontal.x, horizontal.y, Math.fround(horizontal.z + lift));
  return launchItem(context, item, entity.s.pos.base, velocity);
}
