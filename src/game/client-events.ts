// Ported from id Software's code/game/g_active.c: ClientEvents.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { ServerWorld } from "../server/world.ts";
import { EntityEvent, EntityType, GameType, Powerup, Team, statSchema } from "../shared/definitions.ts";
import { findItem, findItemForPowerup } from "../shared/items.ts";
import type { ClientSpawnRuntime } from "./client-spawn.ts";
import { damage } from "./combat.ts";
import type { CombatContext } from "./combat.ts";
import { dropItem } from "./item-motion.ts";
import type { DropItemContext } from "./item-motion.ts";
import { teleportPlayer } from "./misc.ts";
import type { PersonalPortalRuntime } from "./personal-portal.ts";
import type { GameEntity } from "./state.ts";
import type { WeaponRuntime } from "./weapon.ts";

interface ClientEventServices {
  readonly world: ServerWorld;
  readonly weapons: WeaponRuntime;
  readonly spawns: ClientSpawnRuntime;
  readonly drops: DropItemContext;
  readonly dmflags: number;
}

/** Time, gameType, drop timing and dmflags may be live getters during dispatch. */
export type ClientEventsContext = ClientEventServices & (
  | { readonly product: "baseq3"; readonly combat: Extract<CombatContext, { product: "baseq3" }> }
  | { readonly product: "missionpack"; readonly combat: Extract<CombatContext, { product: "missionpack" }>;
    readonly personalPortal: PersonalPortalRuntime }
);

/** Executes server effects from the two-slot predictable-event ring, without consuming it. */
export function clientEvents(context: ClientEventsContext, entity: GameEntity, oldEventSequence: number): void {
  const client = entity.client;
  if (client === null) throw new Error("ClientEvents requires a client entity");
  oldEventSequence |= 0;
  const oldest = (client.ps.eventSequence - 2) | 0;
  if (oldEventSequence < oldest) oldEventSequence = oldest;
  // Both the sequence bound and ring slot remain live after gameplay callbacks.
  for (let index = oldEventSequence; index < client.ps.eventSequence; index = (index + 1) | 0) {
    const event = client.ps.events.get(index & 1);
    switch (event) {
      case EntityEvent.EV_FALL_MEDIUM:
      case EntityEvent.EV_FALL_FAR:
        if (entity.s.eType !== EntityType.ET_PLAYER || (context.dmflags & 8)) break;
        entity.painDebounceTime = (context.combat.time + 200) | 0;
        damage(context.combat, entity, null, null, null, null, event === EntityEvent.EV_FALL_FAR ? 10 : 5, 0, 19);
        break;
      case EntityEvent.EV_FIRE_WEAPON:
        context.weapons.fire(entity);
        break;
      case EntityEvent.EV_USE_ITEM1: {
        const powerup = client.ps.powerups.get(Powerup.PW_REDFLAG) ? Powerup.PW_REDFLAG :
          client.ps.powerups.get(Powerup.PW_BLUEFLAG) ? Powerup.PW_BLUEFLAG :
            client.ps.powerups.get(Powerup.PW_NEUTRALFLAG) ? Powerup.PW_NEUTRALFLAG : Powerup.PW_NONE;
        const flag = powerup === Powerup.PW_NONE ? null : findItemForPowerup(context.product, powerup);
        if (flag !== null) {
          const dropped = dropItem(context.drops, entity, flag, 0);
          dropped.count = Math.max(1, Math.trunc(((client.ps.powerups.get(powerup) - context.combat.time) | 0) / 1000));
          client.ps.powerups.set(powerup, 0);
        }
        if (context.product === "missionpack" && context.combat.gameType === GameType.GT_HARVESTER && client.ps.generic1 > 0) {
          const cube = findItem(context.product, client.sess.sessionTeam === Team.TEAM_RED ? "Blue Cube" : "Red Cube");
          if (cube !== null) {
            for (let count = 0; count < client.ps.generic1; count = (count + 1) | 0) {
              const dropped = dropItem(context.drops, entity, cube, 0);
              dropped.spawnflags = client.sess.sessionTeam === Team.TEAM_RED ? Team.TEAM_BLUE : Team.TEAM_RED;
            }
          }
          client.ps.generic1 = 0;
        }
        const spawn = context.spawns.selectSpawnPoint(client.ps.origin);
        teleportPlayer({ combat: context.combat, world: context.world }, entity, spawn.origin, spawn.angles);
        break;
      }
      case EntityEvent.EV_USE_ITEM2:
        // Source updates gentity health here; ClientEndFrame later copies it into ps.
        entity.health = (client.ps.stats.get(statSchema(context.product).maxHealth) + 25) | 0;
        break;
      case EntityEvent.EV_USE_ITEM3:
        if (context.product === "missionpack") {
          client.invulnerabilityTime = 0;
          context.weapons.startKamikaze(entity);
        }
        break;
      case EntityEvent.EV_USE_ITEM4:
        if (context.product === "missionpack") {
          if (client.portalID !== 0) context.personalPortal.dropPortalSource(entity);
          else context.personalPortal.dropPortalDestination(entity);
        }
        break;
      case EntityEvent.EV_USE_ITEM5:
        if (context.product === "missionpack") client.invulnerabilityTime = (context.combat.time + 10000) | 0;
        break;
      default:
        break;
    }
  }
}
