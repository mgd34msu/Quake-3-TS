// Ported from id Software's code/game/bg_misc.c, bg_itemlist and BG_* item functions.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { GameType, Holdable, ItemType, Powerup, Team, Weapon } from "./definitions.ts";
import type { Product } from "./definitions.ts";
import { CommonError } from "../core/common-error.ts";
import type { Vec3 } from "../core/math.ts";
import { evaluateTrajectory } from "./trajectory.ts";
import type { Trajectory } from "./trajectory.ts";

interface ItemAssets {
  readonly className: string | null;
  readonly pickupSound: string | null;
  readonly worldModels: readonly [string | null, string | null, string | null, string | null];
  readonly icon: string | null;
  readonly pickupName: string | null;
  readonly quantity: number;
  readonly precaches: string;
  readonly sounds: string;
}

export type ItemDefinition = ItemAssets & (
  | { readonly type: ItemType.IT_WEAPON | ItemType.IT_AMMO; readonly tag: Weapon }
  | { readonly type: ItemType.IT_POWERUP | ItemType.IT_PERSISTANT_POWERUP | ItemType.IT_TEAM; readonly tag: Powerup }
  | { readonly type: ItemType.IT_HOLDABLE; readonly tag: Holdable }
  | { readonly type: ItemType.IT_BAD | ItemType.IT_ARMOR | ItemType.IT_HEALTH; readonly tag: 0 }
);

// Index zero is the source's reserved empty item. The terminal C marker is excluded.
const definitions: readonly ItemDefinition[] = [
  {
    className: null, pickupSound: null,
    worldModels: [null, null, null, null],
    icon: null, pickupName: null,
    quantity: 0, type: ItemType.IT_BAD, tag: 0,
    precaches: "", sounds: "",
  },
  {
    className: "item_armor_shard", pickupSound: "sound/misc/ar1_pkup.wav",
    worldModels: ["models/powerups/armor/shard.md3", "models/powerups/armor/shard_sphere.md3", null, null],
    icon: "icons/iconr_shard", pickupName: "Armor Shard",
    quantity: 5, type: ItemType.IT_ARMOR, tag: 0,
    precaches: "", sounds: "",
  },
  {
    className: "item_armor_combat", pickupSound: "sound/misc/ar2_pkup.wav",
    worldModels: ["models/powerups/armor/armor_yel.md3", null, null, null],
    icon: "icons/iconr_yellow", pickupName: "Armor",
    quantity: 50, type: ItemType.IT_ARMOR, tag: 0,
    precaches: "", sounds: "",
  },
  {
    className: "item_armor_body", pickupSound: "sound/misc/ar2_pkup.wav",
    worldModels: ["models/powerups/armor/armor_red.md3", null, null, null],
    icon: "icons/iconr_red", pickupName: "Heavy Armor",
    quantity: 100, type: ItemType.IT_ARMOR, tag: 0,
    precaches: "", sounds: "",
  },
  {
    className: "item_health_small", pickupSound: "sound/items/s_health.wav",
    worldModels: ["models/powerups/health/small_cross.md3", "models/powerups/health/small_sphere.md3", null, null],
    icon: "icons/iconh_green", pickupName: "5 Health",
    quantity: 5, type: ItemType.IT_HEALTH, tag: 0,
    precaches: "", sounds: "",
  },
  {
    className: "item_health", pickupSound: "sound/items/n_health.wav",
    worldModels: ["models/powerups/health/medium_cross.md3", "models/powerups/health/medium_sphere.md3", null, null],
    icon: "icons/iconh_yellow", pickupName: "25 Health",
    quantity: 25, type: ItemType.IT_HEALTH, tag: 0,
    precaches: "", sounds: "",
  },
  {
    className: "item_health_large", pickupSound: "sound/items/l_health.wav",
    worldModels: ["models/powerups/health/large_cross.md3", "models/powerups/health/large_sphere.md3", null, null],
    icon: "icons/iconh_red", pickupName: "50 Health",
    quantity: 50, type: ItemType.IT_HEALTH, tag: 0,
    precaches: "", sounds: "",
  },
  {
    className: "item_health_mega", pickupSound: "sound/items/m_health.wav",
    worldModels: ["models/powerups/health/mega_cross.md3", "models/powerups/health/mega_sphere.md3", null, null],
    icon: "icons/iconh_mega", pickupName: "Mega Health",
    quantity: 100, type: ItemType.IT_HEALTH, tag: 0,
    precaches: "", sounds: "",
  },
  {
    className: "weapon_gauntlet", pickupSound: "sound/misc/w_pkup.wav",
    worldModels: ["models/weapons2/gauntlet/gauntlet.md3", null, null, null],
    icon: "icons/iconw_gauntlet", pickupName: "Gauntlet",
    quantity: 0, type: ItemType.IT_WEAPON, tag: Weapon.WP_GAUNTLET,
    precaches: "", sounds: "",
  },
  {
    className: "weapon_shotgun", pickupSound: "sound/misc/w_pkup.wav",
    worldModels: ["models/weapons2/shotgun/shotgun.md3", null, null, null],
    icon: "icons/iconw_shotgun", pickupName: "Shotgun",
    quantity: 10, type: ItemType.IT_WEAPON, tag: Weapon.WP_SHOTGUN,
    precaches: "", sounds: "",
  },
  {
    className: "weapon_machinegun", pickupSound: "sound/misc/w_pkup.wav",
    worldModels: ["models/weapons2/machinegun/machinegun.md3", null, null, null],
    icon: "icons/iconw_machinegun", pickupName: "Machinegun",
    quantity: 40, type: ItemType.IT_WEAPON, tag: Weapon.WP_MACHINEGUN,
    precaches: "", sounds: "",
  },
  {
    className: "weapon_grenadelauncher", pickupSound: "sound/misc/w_pkup.wav",
    worldModels: ["models/weapons2/grenadel/grenadel.md3", null, null, null],
    icon: "icons/iconw_grenade", pickupName: "Grenade Launcher",
    quantity: 10, type: ItemType.IT_WEAPON, tag: Weapon.WP_GRENADE_LAUNCHER,
    precaches: "", sounds: "sound/weapons/grenade/hgrenb1a.wav sound/weapons/grenade/hgrenb2a.wav",
  },
  {
    className: "weapon_rocketlauncher", pickupSound: "sound/misc/w_pkup.wav",
    worldModels: ["models/weapons2/rocketl/rocketl.md3", null, null, null],
    icon: "icons/iconw_rocket", pickupName: "Rocket Launcher",
    quantity: 10, type: ItemType.IT_WEAPON, tag: Weapon.WP_ROCKET_LAUNCHER,
    precaches: "", sounds: "",
  },
  {
    className: "weapon_lightning", pickupSound: "sound/misc/w_pkup.wav",
    worldModels: ["models/weapons2/lightning/lightning.md3", null, null, null],
    icon: "icons/iconw_lightning", pickupName: "Lightning Gun",
    quantity: 100, type: ItemType.IT_WEAPON, tag: Weapon.WP_LIGHTNING,
    precaches: "", sounds: "",
  },
  {
    className: "weapon_railgun", pickupSound: "sound/misc/w_pkup.wav",
    worldModels: ["models/weapons2/railgun/railgun.md3", null, null, null],
    icon: "icons/iconw_railgun", pickupName: "Railgun",
    quantity: 10, type: ItemType.IT_WEAPON, tag: Weapon.WP_RAILGUN,
    precaches: "", sounds: "",
  },
  {
    className: "weapon_plasmagun", pickupSound: "sound/misc/w_pkup.wav",
    worldModels: ["models/weapons2/plasma/plasma.md3", null, null, null],
    icon: "icons/iconw_plasma", pickupName: "Plasma Gun",
    quantity: 50, type: ItemType.IT_WEAPON, tag: Weapon.WP_PLASMAGUN,
    precaches: "", sounds: "",
  },
  {
    className: "weapon_bfg", pickupSound: "sound/misc/w_pkup.wav",
    worldModels: ["models/weapons2/bfg/bfg.md3", null, null, null],
    icon: "icons/iconw_bfg", pickupName: "BFG10K",
    quantity: 20, type: ItemType.IT_WEAPON, tag: Weapon.WP_BFG,
    precaches: "", sounds: "",
  },
  {
    className: "weapon_grapplinghook", pickupSound: "sound/misc/w_pkup.wav",
    worldModels: ["models/weapons2/grapple/grapple.md3", null, null, null],
    icon: "icons/iconw_grapple", pickupName: "Grappling Hook",
    quantity: 0, type: ItemType.IT_WEAPON, tag: Weapon.WP_GRAPPLING_HOOK,
    precaches: "", sounds: "",
  },
  {
    className: "ammo_shells", pickupSound: "sound/misc/am_pkup.wav",
    worldModels: ["models/powerups/ammo/shotgunam.md3", null, null, null],
    icon: "icons/icona_shotgun", pickupName: "Shells",
    quantity: 10, type: ItemType.IT_AMMO, tag: Weapon.WP_SHOTGUN,
    precaches: "", sounds: "",
  },
  {
    className: "ammo_bullets", pickupSound: "sound/misc/am_pkup.wav",
    worldModels: ["models/powerups/ammo/machinegunam.md3", null, null, null],
    icon: "icons/icona_machinegun", pickupName: "Bullets",
    quantity: 50, type: ItemType.IT_AMMO, tag: Weapon.WP_MACHINEGUN,
    precaches: "", sounds: "",
  },
  {
    className: "ammo_grenades", pickupSound: "sound/misc/am_pkup.wav",
    worldModels: ["models/powerups/ammo/grenadeam.md3", null, null, null],
    icon: "icons/icona_grenade", pickupName: "Grenades",
    quantity: 5, type: ItemType.IT_AMMO, tag: Weapon.WP_GRENADE_LAUNCHER,
    precaches: "", sounds: "",
  },
  {
    className: "ammo_cells", pickupSound: "sound/misc/am_pkup.wav",
    worldModels: ["models/powerups/ammo/plasmaam.md3", null, null, null],
    icon: "icons/icona_plasma", pickupName: "Cells",
    quantity: 30, type: ItemType.IT_AMMO, tag: Weapon.WP_PLASMAGUN,
    precaches: "", sounds: "",
  },
  {
    className: "ammo_lightning", pickupSound: "sound/misc/am_pkup.wav",
    worldModels: ["models/powerups/ammo/lightningam.md3", null, null, null],
    icon: "icons/icona_lightning", pickupName: "Lightning",
    quantity: 60, type: ItemType.IT_AMMO, tag: Weapon.WP_LIGHTNING,
    precaches: "", sounds: "",
  },
  {
    className: "ammo_rockets", pickupSound: "sound/misc/am_pkup.wav",
    worldModels: ["models/powerups/ammo/rocketam.md3", null, null, null],
    icon: "icons/icona_rocket", pickupName: "Rockets",
    quantity: 5, type: ItemType.IT_AMMO, tag: Weapon.WP_ROCKET_LAUNCHER,
    precaches: "", sounds: "",
  },
  {
    className: "ammo_slugs", pickupSound: "sound/misc/am_pkup.wav",
    worldModels: ["models/powerups/ammo/railgunam.md3", null, null, null],
    icon: "icons/icona_railgun", pickupName: "Slugs",
    quantity: 10, type: ItemType.IT_AMMO, tag: Weapon.WP_RAILGUN,
    precaches: "", sounds: "",
  },
  {
    className: "ammo_bfg", pickupSound: "sound/misc/am_pkup.wav",
    worldModels: ["models/powerups/ammo/bfgam.md3", null, null, null],
    icon: "icons/icona_bfg", pickupName: "Bfg Ammo",
    quantity: 15, type: ItemType.IT_AMMO, tag: Weapon.WP_BFG,
    precaches: "", sounds: "",
  },
  {
    className: "holdable_teleporter", pickupSound: "sound/items/holdable.wav",
    worldModels: ["models/powerups/holdable/teleporter.md3", null, null, null],
    icon: "icons/teleporter", pickupName: "Personal Teleporter",
    quantity: 60, type: ItemType.IT_HOLDABLE, tag: Holdable.HI_TELEPORTER,
    precaches: "", sounds: "",
  },
  {
    className: "holdable_medkit", pickupSound: "sound/items/holdable.wav",
    worldModels: ["models/powerups/holdable/medkit.md3", "models/powerups/holdable/medkit_sphere.md3", null, null],
    icon: "icons/medkit", pickupName: "Medkit",
    quantity: 60, type: ItemType.IT_HOLDABLE, tag: Holdable.HI_MEDKIT,
    precaches: "", sounds: "sound/items/use_medkit.wav",
  },
  {
    className: "item_quad", pickupSound: "sound/items/quaddamage.wav",
    worldModels: ["models/powerups/instant/quad.md3", "models/powerups/instant/quad_ring.md3", null, null],
    icon: "icons/quad", pickupName: "Quad Damage",
    quantity: 30, type: ItemType.IT_POWERUP, tag: Powerup.PW_QUAD,
    precaches: "", sounds: "sound/items/damage2.wav sound/items/damage3.wav",
  },
  {
    className: "item_enviro", pickupSound: "sound/items/protect.wav",
    worldModels: ["models/powerups/instant/enviro.md3", "models/powerups/instant/enviro_ring.md3", null, null],
    icon: "icons/envirosuit", pickupName: "Battle Suit",
    quantity: 30, type: ItemType.IT_POWERUP, tag: Powerup.PW_BATTLESUIT,
    precaches: "", sounds: "sound/items/airout.wav sound/items/protect3.wav",
  },
  {
    className: "item_haste", pickupSound: "sound/items/haste.wav",
    worldModels: ["models/powerups/instant/haste.md3", "models/powerups/instant/haste_ring.md3", null, null],
    icon: "icons/haste", pickupName: "Speed",
    quantity: 30, type: ItemType.IT_POWERUP, tag: Powerup.PW_HASTE,
    precaches: "", sounds: "",
  },
  {
    className: "item_invis", pickupSound: "sound/items/invisibility.wav",
    worldModels: ["models/powerups/instant/invis.md3", "models/powerups/instant/invis_ring.md3", null, null],
    icon: "icons/invis", pickupName: "Invisibility",
    quantity: 30, type: ItemType.IT_POWERUP, tag: Powerup.PW_INVIS,
    precaches: "", sounds: "",
  },
  {
    className: "item_regen", pickupSound: "sound/items/regeneration.wav",
    worldModels: ["models/powerups/instant/regen.md3", "models/powerups/instant/regen_ring.md3", null, null],
    icon: "icons/regen", pickupName: "Regeneration",
    quantity: 30, type: ItemType.IT_POWERUP, tag: Powerup.PW_REGEN,
    precaches: "", sounds: "sound/items/regen.wav",
  },
  {
    className: "item_flight", pickupSound: "sound/items/flight.wav",
    worldModels: ["models/powerups/instant/flight.md3", "models/powerups/instant/flight_ring.md3", null, null],
    icon: "icons/flight", pickupName: "Flight",
    quantity: 60, type: ItemType.IT_POWERUP, tag: Powerup.PW_FLIGHT,
    precaches: "", sounds: "sound/items/flight.wav",
  },
  {
    className: "team_CTF_redflag", pickupSound: null,
    worldModels: ["models/flags/r_flag.md3", null, null, null],
    icon: "icons/iconf_red1", pickupName: "Red Flag",
    quantity: 0, type: ItemType.IT_TEAM, tag: Powerup.PW_REDFLAG,
    precaches: "", sounds: "",
  },
  {
    className: "team_CTF_blueflag", pickupSound: null,
    worldModels: ["models/flags/b_flag.md3", null, null, null],
    icon: "icons/iconf_blu1", pickupName: "Blue Flag",
    quantity: 0, type: ItemType.IT_TEAM, tag: Powerup.PW_BLUEFLAG,
    precaches: "", sounds: "",
  },
  {
    className: "holdable_kamikaze", pickupSound: "sound/items/holdable.wav",
    worldModels: ["models/powerups/kamikazi.md3", null, null, null],
    icon: "icons/kamikaze", pickupName: "Kamikaze",
    quantity: 60, type: ItemType.IT_HOLDABLE, tag: Holdable.HI_KAMIKAZE,
    precaches: "", sounds: "sound/items/kamikazerespawn.wav",
  },
  {
    className: "holdable_portal", pickupSound: "sound/items/holdable.wav",
    worldModels: ["models/powerups/holdable/porter.md3", null, null, null],
    icon: "icons/portal", pickupName: "Portal",
    quantity: 60, type: ItemType.IT_HOLDABLE, tag: Holdable.HI_PORTAL,
    precaches: "", sounds: "",
  },
  {
    className: "holdable_invulnerability", pickupSound: "sound/items/holdable.wav",
    worldModels: ["models/powerups/holdable/invulnerability.md3", null, null, null],
    icon: "icons/invulnerability", pickupName: "Invulnerability",
    quantity: 60, type: ItemType.IT_HOLDABLE, tag: Holdable.HI_INVULNERABILITY,
    precaches: "", sounds: "",
  },
  {
    className: "ammo_nails", pickupSound: "sound/misc/am_pkup.wav",
    worldModels: ["models/powerups/ammo/nailgunam.md3", null, null, null],
    icon: "icons/icona_nailgun", pickupName: "Nails",
    quantity: 20, type: ItemType.IT_AMMO, tag: Weapon.WP_NAILGUN,
    precaches: "", sounds: "",
  },
  {
    className: "ammo_mines", pickupSound: "sound/misc/am_pkup.wav",
    worldModels: ["models/powerups/ammo/proxmineam.md3", null, null, null],
    icon: "icons/icona_proxlauncher", pickupName: "Proximity Mines",
    quantity: 10, type: ItemType.IT_AMMO, tag: Weapon.WP_PROX_LAUNCHER,
    precaches: "", sounds: "",
  },
  {
    className: "ammo_belt", pickupSound: "sound/misc/am_pkup.wav",
    worldModels: ["models/powerups/ammo/chaingunam.md3", null, null, null],
    icon: "icons/icona_chaingun", pickupName: "Chaingun Belt",
    quantity: 100, type: ItemType.IT_AMMO, tag: Weapon.WP_CHAINGUN,
    precaches: "", sounds: "",
  },
  {
    className: "item_scout", pickupSound: "sound/items/scout.wav",
    worldModels: ["models/powerups/scout.md3", null, null, null],
    icon: "icons/scout", pickupName: "Scout",
    quantity: 30, type: ItemType.IT_PERSISTANT_POWERUP, tag: Powerup.PW_SCOUT,
    precaches: "", sounds: "",
  },
  {
    className: "item_guard", pickupSound: "sound/items/guard.wav",
    worldModels: ["models/powerups/guard.md3", null, null, null],
    icon: "icons/guard", pickupName: "Guard",
    quantity: 30, type: ItemType.IT_PERSISTANT_POWERUP, tag: Powerup.PW_GUARD,
    precaches: "", sounds: "",
  },
  {
    className: "item_doubler", pickupSound: "sound/items/doubler.wav",
    worldModels: ["models/powerups/doubler.md3", null, null, null],
    icon: "icons/doubler", pickupName: "Doubler",
    quantity: 30, type: ItemType.IT_PERSISTANT_POWERUP, tag: Powerup.PW_DOUBLER,
    precaches: "", sounds: "",
  },
  {
    className: "item_ammoregen", pickupSound: "sound/items/ammoregen.wav",
    worldModels: ["models/powerups/ammo.md3", null, null, null],
    icon: "icons/ammo_regen", pickupName: "Ammo Regen",
    quantity: 30, type: ItemType.IT_PERSISTANT_POWERUP, tag: Powerup.PW_AMMOREGEN,
    precaches: "", sounds: "",
  },
  {
    className: "team_CTF_neutralflag", pickupSound: null,
    worldModels: ["models/flags/n_flag.md3", null, null, null],
    icon: "icons/iconf_neutral1", pickupName: "Neutral Flag",
    quantity: 0, type: ItemType.IT_TEAM, tag: Powerup.PW_NEUTRALFLAG,
    precaches: "", sounds: "",
  },
  {
    className: "item_redcube", pickupSound: "sound/misc/am_pkup.wav",
    worldModels: ["models/powerups/orb/r_orb.md3", null, null, null],
    icon: "icons/iconh_rorb", pickupName: "Red Cube",
    quantity: 0, type: ItemType.IT_TEAM, tag: 0,
    precaches: "", sounds: "",
  },
  {
    className: "item_bluecube", pickupSound: "sound/misc/am_pkup.wav",
    worldModels: ["models/powerups/orb/b_orb.md3", null, null, null],
    icon: "icons/iconh_borb", pickupName: "Blue Cube",
    quantity: 0, type: ItemType.IT_TEAM, tag: 0,
    precaches: "", sounds: "",
  },
  {
    className: "weapon_nailgun", pickupSound: "sound/misc/w_pkup.wav",
    worldModels: ["models/weapons/nailgun/nailgun.md3", null, null, null],
    icon: "icons/iconw_nailgun", pickupName: "Nailgun",
    quantity: 10, type: ItemType.IT_WEAPON, tag: Weapon.WP_NAILGUN,
    precaches: "", sounds: "",
  },
  {
    className: "weapon_prox_launcher", pickupSound: "sound/misc/w_pkup.wav",
    worldModels: ["models/weapons/proxmine/proxmine.md3", null, null, null],
    icon: "icons/iconw_proxlauncher", pickupName: "Prox Launcher",
    quantity: 5, type: ItemType.IT_WEAPON, tag: Weapon.WP_PROX_LAUNCHER,
    precaches: "", sounds: "sound/weapons/proxmine/wstbtick.wav sound/weapons/proxmine/wstbactv.wav sound/weapons/proxmine/wstbimpl.wav sound/weapons/proxmine/wstbimpm.wav sound/weapons/proxmine/wstbimpd.wav sound/weapons/proxmine/wstbactv.wav",
  },
  {
    className: "weapon_chaingun", pickupSound: "sound/misc/w_pkup.wav",
    worldModels: ["models/weapons/vulcan/vulcan.md3", null, null, null],
    icon: "icons/iconw_chaingun", pickupName: "Chaingun",
    quantity: 80, type: ItemType.IT_WEAPON, tag: Weapon.WP_CHAINGUN,
    precaches: "", sounds: "sound/weapons/vulcan/wvulwind.wav",
  },
];

for (const definition of definitions) {
  Object.freeze(definition.worldModels);
  Object.freeze(definition);
}
const missionpackItems = Object.freeze(definitions);
const baseItems = Object.freeze(definitions.slice(0, 36));

export function itemList(product: Product): readonly ItemDefinition[] {
  return product === "baseq3" ? baseItems : missionpackItems;
}

export function itemAt(product: Product, index: number): ItemDefinition {
  const item = itemList(product)[index];
  if (item === undefined) throw new RangeError(`Item index out of range: ${index}`);
  return item;
}

export function findItem(product: Product, pickupName: string): ItemDefinition | null {
  const fold = (text: string): string => text.replace(/[A-Z]/g, letter => String.fromCharCode(letter.charCodeAt(0) + 32));
  const folded = fold(pickupName);
  return itemList(product).find(item => item.pickupName !== null && fold(item.pickupName) === folded) ?? null;
}

export function findItemForPowerup(product: Product, powerup: Powerup): ItemDefinition | null {
  return itemList(product).find(item =>
    (item.type === ItemType.IT_POWERUP || item.type === ItemType.IT_TEAM || item.type === ItemType.IT_PERSISTANT_POWERUP)
    && item.tag === powerup) ?? null;
}

export function findItemForHoldable(product: Product, holdable: Holdable): ItemDefinition {
  const item = itemList(product).find(item => item.type === ItemType.IT_HOLDABLE && item.tag === holdable);
  if (item === undefined) throw new CommonError("drop", "HoldableItem not found");
  return item;
}

export function findItemForWeapon(product: Product, weapon: Weapon): ItemDefinition {
  const item = itemList(product).find(item => item.type === ItemType.IT_WEAPON && item.tag === weapon);
  if (item === undefined) throw new CommonError("drop", `Couldn't find item for weapon ${weapon}`);
  return item;
}

export interface PickupEntity {
  readonly modelIndex: number;
  readonly modelIndex2: number;
  readonly generic1: number;
}

interface Inventory {
  readonly health: number;
  readonly armor: number;
  readonly maxHealth: number;
  readonly holdableItem: number;
  readonly team: number;
  ammo(weapon: Weapon): number;
  powerup(powerup: Powerup): number;
}

export type PlayerInventory = Inventory & (
  | { readonly product: "baseq3" }
  | { readonly product: "missionpack"; readonly persistentPowerupIndex: number }
);

export function canItemBeGrabbed(gametype: number, ent: PickupEntity, ps: PlayerInventory): boolean {
  if (ent.modelIndex < 1 || ent.modelIndex >= itemList(ps.product).length) {
    throw new CommonError("drop", "BG_CanItemBeGrabbed: index out of range");
  }
  const item = itemAt(ps.product, ent.modelIndex);
  switch (item.type) {
    case ItemType.IT_WEAPON:
      return true;
    case ItemType.IT_AMMO:
      return ps.ammo(item.tag) < 200;
    case ItemType.IT_ARMOR: {
      if (ps.product === "missionpack") {
        if (itemAt(ps.product, ps.persistentPowerupIndex).tag === Powerup.PW_SCOUT) return false;
        const upperBound = itemAt(ps.product, ps.persistentPowerupIndex).tag === Powerup.PW_GUARD
          ? ps.maxHealth : ps.maxHealth * 2;
        return ps.armor < upperBound;
      }
      return ps.armor < ps.maxHealth * 2;
    }
    case ItemType.IT_HEALTH:
      if (ps.product === "missionpack" && itemAt(ps.product, ps.persistentPowerupIndex).tag === Powerup.PW_GUARD) return ps.health < ps.maxHealth;
      return ps.health < ps.maxHealth * (item.quantity === 5 || item.quantity === 100 ? 2 : 1);
    case ItemType.IT_POWERUP:
      return true;
    case ItemType.IT_PERSISTANT_POWERUP:
      if (ps.product === "baseq3" || ps.persistentPowerupIndex !== 0) return false;
      if ((ent.generic1 & 2) !== 0 && ps.team !== Team.TEAM_RED) return false;
      if ((ent.generic1 & 4) !== 0 && ps.team !== Team.TEAM_BLUE) return false;
      return true;
    case ItemType.IT_TEAM:
      if (ps.product === "missionpack" && gametype === GameType.GT_1FCTF) {
        if (item.tag === Powerup.PW_NEUTRALFLAG) return true;
        if (ps.team === Team.TEAM_RED && item.tag === Powerup.PW_BLUEFLAG && ps.powerup(Powerup.PW_NEUTRALFLAG) !== 0) return true;
        if (ps.team === Team.TEAM_BLUE && item.tag === Powerup.PW_REDFLAG && ps.powerup(Powerup.PW_NEUTRALFLAG) !== 0) return true;
      }
      if (gametype === GameType.GT_CTF) {
        if (ps.team === Team.TEAM_RED) {
          return item.tag === Powerup.PW_BLUEFLAG ||
            (item.tag === Powerup.PW_REDFLAG && (ent.modelIndex2 !== 0 || ps.powerup(Powerup.PW_BLUEFLAG) !== 0));
        }
        if (ps.team === Team.TEAM_BLUE) {
          return item.tag === Powerup.PW_REDFLAG ||
            (item.tag === Powerup.PW_BLUEFLAG && (ent.modelIndex2 !== 0 || ps.powerup(Powerup.PW_REDFLAG) !== 0));
        }
      }
      return ps.product === "missionpack" && gametype === GameType.GT_HARVESTER;
    case ItemType.IT_HOLDABLE:
      return ps.holdableItem === 0;
    case ItemType.IT_BAD:
      throw new CommonError("drop", "BG_CanItemBeGrabbed: IT_BAD");
  }
}

export function playerTouchesItem(playerOrigin: Vec3, itemPosition: Trajectory<number>, atTime: number): boolean {
  const origin = evaluateTrajectory(itemPosition, atTime);
  const x = Math.fround(playerOrigin.x - origin.x);
  const y = Math.fround(playerOrigin.y - origin.y);
  const z = Math.fround(playerOrigin.z - origin.z);
  return !(x > 44 || x < -50 || y > 36 || y < -36 || z > 36 || z < -36);
}
