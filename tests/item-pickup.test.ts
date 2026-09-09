import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/core/math.ts";
import { GameType, Holdable, MissionpackStatIndex, PersistentIndex, Powerup, statSchema, Team, Weapon } from "../src/shared/definitions.ts";
import { findItemForHoldable, findItemForPowerup, findItemForWeapon, itemAt, itemList } from "../src/shared/items.ts";
import { addAmmo, pickupAmmo, pickupArmor, pickupHealth, pickupHoldable,
  pickupItem, pickupPersistentPowerup, pickupPowerup, pickupWeapon } from "../src/game/item-pickup.ts";
import { ConnectionState, createGameClient, createGameEntity, GameFlags } from "../src/game/state.ts";
import type { ItemPickupContext, PowerupPickupContext } from "../src/game/item-pickup.ts";
import type { Product } from "../src/shared/definitions.ts";
import type { GameClient, GameEntity } from "../src/game/state.ts";

interface TestPlayer {
  readonly entity: GameEntity;
  readonly client: GameClient;
}

function player(product: Product, slot = 0): TestPlayer {
  const entity = createGameEntity(slot);
  const client = createGameClient(product);
  entity.client = client;
  return { entity, client };
}

describe("Add_Ammo", () => {
  test("adds exact counts and caps positive ammo at 200", () => {
    const other = player("baseq3");
    addAmmo(other.entity, Weapon.WP_ROCKET_LAUNCHER, 5);
    expect(other.client.ps.ammo.get(Weapon.WP_ROCKET_LAUNCHER)).toBe(5);
    other.client.ps.ammo.set(Weapon.WP_ROCKET_LAUNCHER, 198);
    addAmmo(other.entity, Weapon.WP_ROCKET_LAUNCHER, 5);
    expect(other.client.ps.ammo.get(Weapon.WP_ROCKET_LAUNCHER)).toBe(200);
  });

  test("retains source negative counts and requires a client", () => {
    const other = player("missionpack");
    addAmmo(other.entity, Weapon.WP_CHAINGUN, -1);
    expect(other.client.ps.ammo.get(Weapon.WP_CHAINGUN)).toBe(-1);
    expect(() => addAmmo(createGameEntity(1), Weapon.WP_MACHINEGUN, 1)).toThrow("requires a client");
  });
});

describe("Pickup_Ammo", () => {
  test("uses the shared item quantity, count override, cap, and fixed respawn", () => {
    const other = player("baseq3");
    const ammo = createGameEntity(64);
    ammo.item = itemAt("baseq3", 19);
    expect(pickupAmmo(ammo, other.entity)).toBe(40);
    expect(other.client.ps.ammo.get(Weapon.WP_MACHINEGUN)).toBe(50);

    ammo.count = 7;
    other.client.ps.ammo.set(Weapon.WP_MACHINEGUN, 198);
    expect(pickupAmmo(ammo, other.entity)).toBe(40);
    expect(other.client.ps.ammo.get(Weapon.WP_MACHINEGUN)).toBe(200);
  });

  test("rejects a missionpack-only item for a baseq3 player", () => {
    const other = player("baseq3");
    const ammo = createGameEntity(64);
    ammo.item = itemAt("missionpack", 45);
    expect(() => pickupAmmo(ammo, other.entity)).toThrow("does not belong to baseq3");
  });
});

const weaponContext = {
  gameType: GameType.GT_FFA,
  weaponRespawnSeconds: 5,
  teamWeaponRespawnSeconds: 30,
};

describe("Pickup_Weapon", () => {
  test("map weapons fill to their quantity, then add one shot", () => {
    const other = player("baseq3");
    const weapon = createGameEntity(64);
    weapon.item = findItemForWeapon("baseq3", Weapon.WP_SHOTGUN);
    other.client.ps.ammo.set(Weapon.WP_SHOTGUN, 4);
    expect(pickupWeapon(weapon, other.entity, weaponContext)).toBe(5);
    expect(other.client.ps.ammo.get(Weapon.WP_SHOTGUN)).toBe(10);
    expect(pickupWeapon(weapon, other.entity, weaponContext)).toBe(5);
    expect(other.client.ps.ammo.get(Weapon.WP_SHOTGUN)).toBe(11);
    expect(other.client.ps.stats.get(statSchema("baseq3").weapons) & (1 << Weapon.WP_SHOTGUN)).not.toBe(0);
  });

  test("dropped and team weapons grant full ammo and use the team respawn cvar", () => {
    const droppedPlayer = player("baseq3");
    const dropped = createGameEntity(64);
    dropped.item = findItemForWeapon("baseq3", Weapon.WP_ROCKET_LAUNCHER);
    dropped.flags = GameFlags.DROPPED_ITEM;
    droppedPlayer.client.ps.ammo.set(Weapon.WP_ROCKET_LAUNCHER, 4);
    expect(pickupWeapon(dropped, droppedPlayer.entity, weaponContext)).toBe(5);
    expect(droppedPlayer.client.ps.ammo.get(Weapon.WP_ROCKET_LAUNCHER)).toBe(14);

    const teamPlayer = player("missionpack");
    const teamWeapon = createGameEntity(65);
    teamWeapon.item = findItemForWeapon("missionpack", Weapon.WP_CHAINGUN);
    teamPlayer.client.ps.ammo.set(Weapon.WP_CHAINGUN, 50);
    expect(pickupWeapon(teamWeapon, teamPlayer.entity, { ...weaponContext, gameType: GameType.GT_TEAM })).toBe(30);
    expect(teamPlayer.client.ps.ammo.get(Weapon.WP_CHAINGUN)).toBe(130);
    expect(teamPlayer.client.ps.stats.get(statSchema("missionpack").weapons) & (1 << Weapon.WP_CHAINGUN)).not.toBe(0);
  });

  test("negative counts grant no ammo and the grapple remains unlimited", () => {
    const other = player("baseq3");
    const shotgun = createGameEntity(64);
    shotgun.item = findItemForWeapon("baseq3", Weapon.WP_SHOTGUN);
    shotgun.count = -1;
    expect(pickupWeapon(shotgun, other.entity, weaponContext)).toBe(5);
    expect(other.client.ps.ammo.get(Weapon.WP_SHOTGUN)).toBe(0);

    const grapple = createGameEntity(65);
    grapple.item = findItemForWeapon("baseq3", Weapon.WP_GRAPPLING_HOOK);
    expect(pickupWeapon(grapple, other.entity, weaponContext)).toBe(5);
    expect(other.client.ps.ammo.get(Weapon.WP_GRAPPLING_HOOK)).toBe(-1);
  });
});

function equipPersistent(other: TestPlayer, powerup: Powerup): void {
  const item = findItemForPowerup("missionpack", powerup);
  if (item === null) throw new Error(`Missing persistent item ${powerup}`);
  const itemIndex = itemList("missionpack").indexOf(item);
  if (itemIndex < 0) throw new Error(`Persistent item ${powerup} is not in the missionpack table`);
  other.client.ps.stats.set(MissionpackStatIndex.STAT_PERSISTANT_POWERUP, itemIndex);
}

describe("Pickup_Health", () => {
  test("small and mega health overstack while normal health does not", () => {
    const other = player("baseq3");
    const schema = statSchema("baseq3");
    other.client.ps.stats.set(schema.maxHealth, 100);

    const small = createGameEntity(64);
    small.item = itemAt("baseq3", 4);
    other.entity.health = 100;
    expect(pickupHealth(small, other.entity)).toBe(35);
    expect([other.entity.health, other.client.ps.stats.get(schema.health)]).toEqual([105, 105]);

    const normal = createGameEntity(65);
    normal.item = itemAt("baseq3", 5);
    other.entity.health = 90;
    expect(pickupHealth(normal, other.entity)).toBe(35);
    expect(other.entity.health).toBe(100);

    const mega = createGameEntity(66);
    mega.item = itemAt("baseq3", 7);
    other.entity.health = 150;
    expect(pickupHealth(mega, other.entity)).toBe(35);
    expect(other.entity.health).toBe(200);
  });

  test("count overrides quantity but not overstack class, and Guard caps at max health", () => {
    const base = player("baseq3");
    const baseSchema = statSchema("baseq3");
    base.client.ps.stats.set(baseSchema.maxHealth, 100);
    base.entity.health = 80;
    const normal = createGameEntity(64);
    normal.item = itemAt("baseq3", 5);
    normal.count = 50;
    pickupHealth(normal, base.entity);
    expect(base.entity.health).toBe(100);

    const guarded = player("missionpack");
    const missionSchema = statSchema("missionpack");
    guarded.client.ps.stats.set(missionSchema.maxHealth, 100);
    equipPersistent(guarded, Powerup.PW_GUARD);
    guarded.entity.health = 95;
    const small = createGameEntity(65);
    small.item = itemAt("missionpack", 4);
    pickupHealth(small, guarded.entity);
    expect([guarded.entity.health, guarded.client.ps.stats.get(missionSchema.health)]).toEqual([100, 100]);
  });
});

describe("Pickup_Armor", () => {
  test("uses item quantity, ignores count, and caps base armor at twice max health", () => {
    const other = player("baseq3");
    const schema = statSchema("baseq3");
    other.client.ps.stats.set(schema.maxHealth, 100);
    other.client.ps.stats.set(schema.armor, 190);
    const armor = createGameEntity(64);
    armor.item = itemAt("baseq3", 3);
    armor.count = 1000;
    expect(pickupArmor(armor, other.entity)).toBe(25);
    expect(other.client.ps.stats.get(schema.armor)).toBe(200);
  });

  test("Guard caps missionpack armor at max health", () => {
    const other = player("missionpack");
    const schema = statSchema("missionpack");
    other.client.ps.stats.set(schema.maxHealth, 100);
    other.client.ps.stats.set(schema.armor, 90);
    equipPersistent(other, Powerup.PW_GUARD);
    const armor = createGameEntity(64);
    armor.item = itemAt("missionpack", 2);
    expect(pickupArmor(armor, other.entity)).toBe(25);
    expect(other.client.ps.stats.get(schema.armor)).toBe(100);
  });
});

describe("Pickup_Holdable", () => {
  test("stores the baseq3 item-table index and returns the fixed respawn", () => {
    const other = player("baseq3");
    const holdable = createGameEntity(64);
    holdable.item = findItemForHoldable("baseq3", Holdable.HI_TELEPORTER);
    expect(pickupHoldable(holdable, other.entity)).toBe(60);
    expect(other.client.ps.stats.get(statSchema("baseq3").holdableItem)).toBe(26);
    expect(other.client.ps.eFlags).toBe(0);
  });

  test("stores the missionpack Kamikaze index and adds EF_KAMIKAZE", () => {
    const other = player("missionpack");
    other.client.ps.eFlags = 4;
    const holdable = createGameEntity(64);
    holdable.item = findItemForHoldable("missionpack", Holdable.HI_KAMIKAZE);
    expect(pickupHoldable(holdable, other.entity)).toBe(60);
    expect(other.client.ps.stats.get(statSchema("missionpack").holdableItem)).toBe(36);
    expect(other.client.ps.eFlags).toBe(0x204);
  });
});

function persistentEntity(powerup: Powerup, slot = 64): GameEntity {
  const item = findItemForPowerup("missionpack", powerup);
  if (item === null) throw new Error(`Missing persistent item ${powerup}`);
  const entity = createGameEntity(slot);
  entity.item = item;
  return entity;
}

describe("Pickup_PersistantPowerup", () => {
  test("QVM handicap parses exponent text as its digit prefix", () => {
    const other = player("missionpack");
    pickupPersistentPowerup(persistentEntity(Powerup.PW_GUARD), other.entity, "5e1");
    expect(other.entity.health).toBe(10);
    expect(other.client.pers.maxHealth).toBe(10);
  });

  test("QVM digit rounding precedes handicap range checks and integer assignment", () => {
    for (const [text, maximum] of [
      ["1.9999999", 2], ["\x80+50tail", 50], ["-0", 100], ["0x32", 100],
      ["100.000001", 100], ["101", 100], ["-1", 100],
    ] satisfies readonly (readonly [string, number])[]) {
      const other = player("missionpack");
      pickupPersistentPowerup(persistentEntity(Powerup.PW_DOUBLER), other.entity, text);
      expect(other.client.pers.maxHealth).toBe(maximum);
    }
    const other = player("missionpack");
    pickupPersistentPowerup(persistentEntity(Powerup.PW_GUARD), other.entity, "1.9999999");
    expect(other.entity.health).toBe(4);
  });
  test("Guard applies float32-rounded twice-handicap to every source field", () => {
    const other = player("missionpack");
    const guard = persistentEntity(Powerup.PW_GUARD);
    expect(pickupPersistentPowerup(guard, other.entity, " 50.4999999 trailing")).toBe(-1);
    expect(other.client.ps.stats.get(MissionpackStatIndex.STAT_PERSISTANT_POWERUP)).toBe(43);
    expect(other.client.persistantPowerup).toBe(guard);
    expect([
      other.entity.health,
      other.client.ps.stats.get(MissionpackStatIndex.STAT_HEALTH),
      other.client.ps.stats.get(MissionpackStatIndex.STAT_MAX_HEALTH),
      other.client.ps.stats.get(MissionpackStatIndex.STAT_ARMOR),
      other.client.pers.maxHealth,
    ]).toEqual([101, 101, 101, 101, 101]);
  });

  test("Scout removes armor without rewriting player-state max health", () => {
    const other = player("missionpack");
    other.client.ps.stats.set(MissionpackStatIndex.STAT_MAX_HEALTH, 100);
    other.client.ps.stats.set(MissionpackStatIndex.STAT_ARMOR, 80);
    expect(pickupPersistentPowerup(persistentEntity(Powerup.PW_SCOUT), other.entity, "80.9")).toBe(-1);
    expect(other.client.ps.stats.get(MissionpackStatIndex.STAT_PERSISTANT_POWERUP)).toBe(42);
    expect(other.client.ps.stats.get(MissionpackStatIndex.STAT_ARMOR)).toBe(0);
    expect(other.client.ps.stats.get(MissionpackStatIndex.STAT_MAX_HEALTH)).toBe(100);
    expect(other.client.pers.maxHealth).toBe(80);
  });

  test("Ammo Regen clears its timer slots and invalid handicap text defaults to 100", () => {
    const other = player("missionpack");
    for (let index = 0; index < other.client.ammoTimes.length; index++) other.client.ammoTimes.set(index, index + 1);
    expect(pickupPersistentPowerup(persistentEntity(Powerup.PW_AMMOREGEN), other.entity, "not-a-number")).toBe(-1);
    expect(other.client.ps.stats.get(MissionpackStatIndex.STAT_PERSISTANT_POWERUP)).toBe(45);
    expect(other.client.pers.maxHealth).toBe(100);
    expect([...other.client.ammoTimes.copy()]).toEqual(Array.from({ length: other.client.ammoTimes.length }, () => 0));
  });

  test("Doubler changes only persistent max health", () => {
    const other = player("missionpack");
    other.entity.health = 70;
    other.client.ps.stats.set(MissionpackStatIndex.STAT_MAX_HEALTH, 90);
    other.client.ps.stats.set(MissionpackStatIndex.STAT_ARMOR, 40);
    expect(pickupPersistentPowerup(persistentEntity(Powerup.PW_DOUBLER), other.entity, "80.9")).toBe(-1);
    expect(other.client.pers.maxHealth).toBe(80);
    expect(other.entity.health).toBe(70);
    expect(other.client.ps.stats.get(MissionpackStatIndex.STAT_MAX_HEALTH)).toBe(90);
    expect(other.client.ps.stats.get(MissionpackStatIndex.STAT_ARMOR)).toBe(40);
  });
});

function activePlayer(product: Product, slot: number, team: Team, x: number, y: number, yaw: number): TestPlayer {
  const result = player(product, slot);
  result.client.pers.connected = ConnectionState.CONNECTED;
  result.client.sess.sessionTeam = team;
  result.client.ps.stats.set(statSchema(product).health, 100);
  result.client.ps.origin = vec3(x, y, 0);
  result.client.ps.viewangles = vec3(0, yaw, 0);
  return result;
}

describe("Pickup_Powerup", () => {
  test("accepts the source signed clock and wraps timer addition for both products", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      for (const [time, expiration] of [[-12_345, 18_000], [-2_147_483_648, -2_147_453_000],
        [2_147_483_647, -2_147_454_296]] satisfies readonly (readonly [number, number])[]) {
        const other = player(product);
        const quad = createGameEntity(64);
        quad.item = findItemForPowerup(product, Powerup.PW_QUAD);
        const context: PowerupPickupContext = { time, gameType: GameType.GT_FFA,
          clients: [other.client], traceSolidLine: () => ({ fraction: 1 }) };
        expect(pickupPowerup(quad, other.entity, context)).toBe(120);
        expect(other.client.ps.powerups.get(Powerup.PW_QUAD)).toBe(expiration);
      }
    }
  });

  test("rounds a new timer down to seconds and stacks later quantities", () => {
    const other = player("baseq3");
    const quad = createGameEntity(64);
    quad.item = findItemForPowerup("baseq3", Powerup.PW_QUAD);
    if (quad.item === null) throw new Error("Missing Quad item");
    const context: PowerupPickupContext = {
      time: 12345,
      gameType: GameType.GT_FFA,
      clients: [other.client],
      traceSolidLine: () => ({ fraction: 1 }),
    };
    expect(pickupPowerup(quad, other.entity, context)).toBe(120);
    expect(other.client.ps.powerups.get(Powerup.PW_QUAD)).toBe(42000);
    quad.count = 5;
    expect(pickupPowerup(quad, other.entity, { ...context, time: 19999 })).toBe(120);
    expect(other.client.ps.powerups.get(Powerup.PW_QUAD)).toBe(47000);
  });

  test("toggles denial only for live visible opponents facing a nearby pickup", () => {
    const picker = activePlayer("missionpack", 0, Team.TEAM_RED, 100, 0, 0);
    const denied = activePlayer("missionpack", 1, Team.TEAM_BLUE, 0, 0, 0);
    const teammate = activePlayer("missionpack", 2, Team.TEAM_RED, 0, 1, 0);
    const blocked = activePlayer("missionpack", 3, Team.TEAM_BLUE, 0, 10, 0);
    const far = activePlayer("missionpack", 4, Team.TEAM_BLUE, -100, 0, 0);
    const away = activePlayer("missionpack", 5, Team.TEAM_BLUE, 0, 0, 180);
    const disconnected = activePlayer("missionpack", 6, Team.TEAM_BLUE, 0, 0, 0);
    disconnected.client.pers.connected = ConnectionState.DISCONNECTED;
    const dead = activePlayer("missionpack", 7, Team.TEAM_BLUE, 0, 0, 0);
    dead.client.ps.stats.set(statSchema("missionpack").health, 0);

    const quad = createGameEntity(64);
    quad.item = findItemForPowerup("missionpack", Powerup.PW_QUAD);
    if (quad.item === null) throw new Error("Missing Quad item");
    quad.s.pos = { ...quad.s.pos, base: vec3(100, 0, 0) };
    let traces = 0;
    const context: PowerupPickupContext = {
      time: 5000,
      gameType: GameType.GT_TEAM,
      clients: [picker.client, denied.client, teammate.client, blocked.client, far.client, away.client, disconnected.client, dead.client],
      traceSolidLine: (start) => {
        traces++;
        return { fraction: start.y === 10 ? 0.5 : 1 };
      },
    };
    pickupPowerup(quad, picker.entity, context);
    expect(denied.client.ps.persistant.get(PersistentIndex.PERS_PLAYEREVENTS)).toBe(1);
    expect(teammate.client.ps.persistant.get(PersistentIndex.PERS_PLAYEREVENTS)).toBe(0);
    expect(blocked.client.ps.persistant.get(PersistentIndex.PERS_PLAYEREVENTS)).toBe(0);
    expect(far.client.ps.persistant.get(PersistentIndex.PERS_PLAYEREVENTS)).toBe(0);
    expect(away.client.ps.persistant.get(PersistentIndex.PERS_PLAYEREVENTS)).toBe(0);
    expect(traces).toBe(2);
    pickupPowerup(quad, picker.entity, context);
    expect(denied.client.ps.persistant.get(PersistentIndex.PERS_PLAYEREVENTS)).toBe(0);

    pickupPowerup(quad, picker.entity, { ...context, gameType: GameType.GT_FFA, clients: [picker.client, teammate.client] });
    expect(teammate.client.ps.persistant.get(PersistentIndex.PERS_PLAYEREVENTS)).toBe(1);
  });
});

function itemContext(clients: readonly GameClient[]): ItemPickupContext {
  return {
    time: 10000,
    gameType: GameType.GT_FFA,
    weaponRespawnSeconds: 5,
    teamWeaponRespawnSeconds: 30,
    clients,
    traceSolidLine: () => ({ fraction: 1 }),
    handicapForClient: () => "100",
  };
}

describe("pickup dispatcher", () => {
  test("publishes persistent ownership before the reached handicap read, including a failed read", () => {
    for (const powerup of [Powerup.PW_GUARD, Powerup.PW_SCOUT, Powerup.PW_DOUBLER, Powerup.PW_AMMOREGEN]) {
      const other = player("missionpack");
      const item = persistentEntity(powerup);
      if (item.item === null) throw new Error("Persistent pickup fixture has no item");
      const itemIndex = itemList("missionpack").indexOf(item.item);
      let reads = 0;
      const context: ItemPickupContext = { ...itemContext([other.client]), handicapForClient: () => {
        reads++;
        expect(other.client.persistantPowerup).toBe(item);
        expect(other.client.ps.stats.get(MissionpackStatIndex.STAT_PERSISTANT_POWERUP)).toBe(itemIndex);
        return "50";
      } };
      expect(pickupItem(item, other.entity, context)).toBe(-1);
      expect(reads).toBe(1);
    }
    const other = player("missionpack");
    const guard = persistentEntity(Powerup.PW_GUARD);
    const context: ItemPickupContext = { ...itemContext([other.client]), handicapForClient: () => {
      throw new Error("userinfo read failed");
    } };
    expect(() => pickupItem(guard, other.entity, context)).toThrow("userinfo read failed");
    expect(other.client.persistantPowerup).toBe(guard);
    expect(other.client.ps.stats.get(MissionpackStatIndex.STAT_PERSISTANT_POWERUP)).toBe(43);
    expect(other.entity.health).toBe(0);
  });

  test("routes tested item kinds and reads handicap only for persistent powerups", () => {
    const base = player("baseq3");
    const ammo = createGameEntity(64);
    ammo.item = itemAt("baseq3", 19);
    let handicapReads = 0;
    const context: ItemPickupContext = {
      ...itemContext([base.client]),
      handicapForClient: () => {
        handicapReads++;
        return "75";
      },
    };
    expect(pickupItem(ammo, base.entity, context)).toBe(40);
    expect(handicapReads).toBe(0);

    const mission = player("missionpack");
    mission.client.ps.clientNum = 7;
    const scout = persistentEntity(Powerup.PW_SCOUT, 65);
    const missionContext: ItemPickupContext = {
      ...itemContext([mission.client]),
      handicapForClient: (clientNum) => {
        expect(clientNum).toBe(7);
        handicapReads++;
        return "75";
      },
    };
    expect(pickupItem(scout, mission.entity, missionContext)).toBe(-1);
    expect(handicapReads).toBe(1);
    expect(mission.client.pers.maxHealth).toBe(75);
  });

  test("explicitly rejects team objectives, bad items, and missing definitions", () => {
    const other = player("baseq3");
    const teamItem = createGameEntity(64);
    teamItem.item = itemAt("baseq3", 34);
    expect(() => pickupItem(teamItem, other.entity, itemContext([other.client]))).toThrow(
      "IT_TEAM requires the team objective pickup handler",
    );

    const badItem = createGameEntity(65);
    badItem.item = itemAt("baseq3", 0);
    expect(() => pickupItem(badItem, other.entity, itemContext([other.client]))).toThrow("IT_BAD cannot be picked up");
    expect(() => pickupItem(createGameEntity(66), other.entity, itemContext([other.client]))).toThrow(
      "requires an item definition",
    );
  });
});
