// Ported from id Software's code/game/g_misc.c teleport and portal handlers,
// and code/game/g_utils.c:G_KillBox. GPL-2.0-or-later, id Software 1999-2005.
import { add3, normalize3, scale3, sub3, vec3 } from "../core/math.ts";
import { qvmAngleVectors } from "../core/qvm-math.ts";
import type { Vec3 } from "../core/math.ts";
import type { ServerWorld } from "../server/world.ts";
import { EntityEvent, EntityType, Team } from "../shared/definitions.ts";
import { directionToByte } from "../shared/direction-byte.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import { MoveFlags } from "../shared/player-state.ts";
import { playerStateToEntityState } from "../shared/snapshot-state.ts";
import { setClientViewAngle } from "./client-spawn.ts";
import { damage, DamageFlags } from "./combat.ts";
import type { CombatContext } from "./combat.ts";
import type { GameEntity } from "./state.ts";
import { moveDirection, pickTarget } from "./utilities.ts";
import type { TargetSelectionContext } from "./utilities.ts";

const MOD_TELEFRAG = 18;
const EF_TELEPORT_BIT = 4;

/** The caller unlinks the player before querying its proposed destination. */
export function killBox(context: CombatContext, entity: GameEntity): void {
  if (entity.client === null) throw new Error("G_KillBox requires a client entity");
  const origin = entity.client.ps.origin;
  const contacts = context.world.areaEntities({ min: add3(origin, entity.r.mins), max: add3(origin, entity.r.maxs) });
  for (const number of contacts) {
    const hit = context.entities.at(number);
    if (hit.client === null) continue;
    damage(context, hit, entity, entity, null, null, 100000, DamageFlags.NO_PROTECTION, MOD_TELEFRAG);
  }
}

export interface TeleportContext {
  readonly combat: CombatContext;
  readonly world: ServerWorld;
}

export function teleportPlayer(context: TeleportContext, player: GameEntity, origin: Vec3, angles: Vec3): void {
  const client = player.client;
  if (client === null) throw new Error("TeleportPlayer requires a client entity");
  if (client.sess.sessionTeam !== Team.TEAM_SPECTATOR) {
    const out = context.combat.entities.tempEntity(client.ps.origin, EntityEvent.EV_PLAYER_TELEPORT_OUT);
    out.s.clientNum = player.s.clientNum;
    const incoming = context.combat.entities.tempEntity(origin, EntityEvent.EV_PLAYER_TELEPORT_IN);
    incoming.s.clientNum = player.s.clientNum;
  }
  context.world.unlink(player.s.number);
  client.ps.origin = vec3(origin.x, origin.y, Math.fround(origin.z) + 1);
  client.ps.velocity = scale3(qvmAngleVectors(angles).forward, 400);
  client.ps.pmTime = 160;
  client.ps.pmFlags |= MoveFlags.TIME_KNOCKBACK;
  client.ps.eFlags ^= EF_TELEPORT_BIT;
  setClientViewAngle(player, angles);
  if (client.sess.sessionTeam !== Team.TEAM_SPECTATOR) killBox(context.combat, player);
  playerStateToEntityState(client.ps, player.s, true);
  player.r.currentOrigin = { ...client.ps.origin };
  if (client.sess.sessionTeam !== Team.TEAM_SPECTATOR) context.world.link(player);
}

export interface PortalContext extends TargetSelectionContext {
  readonly world: ServerWorld;
  readonly time: number;
}

export function locateCamera(context: PortalContext, entity: GameEntity): void {
  const owner = pickTarget(context, entity.target);
  if (owner === null) {
    context.warn("Couldn't find target for misc_partal_surface\n");
    context.pool.free(entity);
    return;
  }
  entity.r.ownerNum = owner.s.number;
  if ((owner.spawnflags & 1) !== 0) entity.s.frame = 25;
  else if ((owner.spawnflags & 2) !== 0) entity.s.frame = 75;
  entity.s.powerups = (owner.spawnflags & 4) !== 0 ? 0 : 1;
  entity.s.clientNum = owner.s.clientNum;
  entity.s.origin2 = { ...owner.s.origin };
  const target = pickTarget(context, owner.target);
  let direction: Vec3;
  if (target !== null) direction = normalize3(sub3(target.s.origin, owner.s.origin));
  else {
    const result = moveDirection(owner.s.angles);
    direction = result.direction;
    owner.s.angles = result.angles;
  }
  entity.s.eventParm = directionToByte(direction);
}

export function spawnPortalSurface(context: PortalContext, entity: GameEntity): void {
  entity.r.mins = vec3(0, 0, 0);
  entity.r.maxs = vec3(0, 0, 0);
  context.world.link(entity);
  entity.r.svFlags = ServerEntityFlags.PORTAL;
  entity.s.eType = EntityType.ET_PORTAL;
  if (entity.target === null) entity.s.origin2 = { ...entity.s.origin };
  else {
    entity.think = self => locateCamera(context, self);
    entity.nextthink = (context.time + 100) | 0;
  }
}

/** roll is G_SpawnFloat("roll", "0") parsed by the map-spawn boundary. */
export function spawnPortalCamera(world: ServerWorld, entity: GameEntity, roll: number): void {
  entity.r.mins = vec3(0, 0, 0);
  entity.r.maxs = vec3(0, 0, 0);
  world.link(entity);
  const packed = Math.fround(Math.fround(Math.fround(roll) / 360) * 256);
  // QVM CVFI4 produces the x86 indefinite integer outside the signed range.
  entity.s.clientNum = packed >= -2147483648 && packed < 2147483648 ? Math.trunc(packed) + 0 : -2147483648;
}
