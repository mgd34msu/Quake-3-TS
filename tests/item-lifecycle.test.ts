import { describe, expect, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap, BspPlane } from "../src/assets/bsp.ts";
import { Pk3Archive } from "../src/assets/pk3.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import type { Bounds } from "../src/core/math.ts";
import { EntityPool, initGameEntity, runThink } from "../src/game/entities.ts";
import { finishSpawningItem, ItemRegistry, respawnItem, spawnItem, touchItem } from "../src/game/item-lifecycle.ts";
import type { ItemLifecycleContext } from "../src/game/item-lifecycle.ts";
import { GameEntity, GameFlags } from "../src/game/state.ts";
import type { GameClient } from "../src/game/state.ts";
import { SpawnVariables } from "../src/game/spawn.ts";
import { ServerWorld } from "../src/server/world.ts";
import { EntityEvent, EntityType, GameType, MissionpackStatIndex, PersistentIndex, Powerup, Team, Weapon, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ServerEntityFlags } from "../src/shared/entity-shared.ts";
import { findItem, findItemForPowerup, findItemForWeapon, itemList } from "../src/shared/items.ts";
import type { ItemDefinition } from "../src/shared/items.ts";
import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from "../src/shared/player-state.ts";
import type { MovementTrace } from "../src/shared/slide-move.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";

const worldBounds: Bounds = { min: vec3(-1024, -1024, -1024), max: vec3(1024, 1024, 1024) };

function floorMap(): BspMap {
  const floor: Bounds = { min: vec3(-512, -512, -512), max: vec3(512, 512, 0) };
  const planes: BspPlane[] = [
    { normal: vec3(1, 0, 0), distance: floor.max.x }, { normal: vec3(-1, 0, 0), distance: -floor.min.x },
    { normal: vec3(0, 1, 0), distance: floor.max.y }, { normal: vec3(0, -1, 0), distance: -floor.min.y },
    { normal: vec3(0, 0, 1), distance: floor.max.z }, { normal: vec3(0, 0, -1), distance: -floor.min.z },
  ];
  return {
    entities: "", entityRecords: [], shaders: [{ name: "floor", surfaceFlags: 0, contentFlags: 1 }], planes, nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds: worldBounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    leafSurfaces: [], leafBrushes: [0], models: [{ bounds: worldBounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    brushes: [{ firstSide: 0, sideCount: planes.length, shader: 0 }],
    brushSides: planes.map((_plane, index) => ({ plane: index, shader: 0 })),
    vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null,
  };
}

function clientOf(entity: GameEntity): GameClient {
  if (entity.client === null) throw new Error("Fixture requires a client");
  return entity.client;
}

function requiredPowerup(product: Product, powerup: Powerup): ItemDefinition {
  const item = findItemForPowerup(product, powerup);
  if (item === null) throw new Error(`Fixture powerup ${powerup} is unavailable`);
  return item;
}

function fixture(product: Product = "baseq3", gameType = GameType.GT_FFA, map = floorMap()) {
  const clock = { now: 1_000 };
  const effects: string[] = [];
  let activeWorld: ServerWorld | null = null;
  const currentWorld = (): ServerWorld => {
    if (activeWorld === null) throw new Error("Fixture world is not initialized");
    return activeWorld;
  };
  const pool = new EntityPool({ print: text => { effects.push(`warn:${text}`); }, product, maxClients: 2, mapStartTime: 0, time: () => clock.now,
    link: entity => { currentWorld().link(entity); effects.push(`link:${entity.slot}`); },
    unlink: entity => { currentWorld().unlink(entity.slot); effects.push(`unlink:${entity.slot}`); } });
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const worldPrints: string[] = [];
  activeWorld = new ServerWorld(collision, collision.modelBounds(0), number => pool.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  pool.at(ENTITYNUM_WORLD).s.number = ENTITYNUM_WORLD;
  const registry = new ItemRegistry(product);
  registry.clear(gameType);
  const randomState = { integer: 0, unit: 0.5 };
  const context: ItemLifecycleContext = {
    entities: pool, world: currentWorld(), product, gameType,
    weaponRespawnSeconds: 5, teamWeaponRespawnSeconds: 30,
    handicapForClient: () => "100",
    teamPickup: (item, player) => { effects.push(`team:${item.slot}:${player.slot}`); return 30; },
    useTargets: (item, player) => { effects.push(`targets:${item.slot}:${player.slot}`); },
    soundIndex: path => { effects.push(`sound:${path}`); return 77; },
    random: { rand: () => randomState.integer, random: () => randomState.unit },
    registry,
    log: message => { effects.push(`log:${message}`); },
    warn: message => { effects.push(`warn:${message}`); },
  };
  return { clock, effects, pool, world: currentWorld(), registry, randomState, context };
}

function player(setup: ReturnType<typeof fixture>, number = 0): GameEntity {
  const entity = setup.pool.at(number);
  initGameEntity(entity);
  entity.health = 100;
  const client = clientOf(entity);
  client.ps.clientNum = number;
  client.ps.health = 100;
  client.ps.stats.set(statSchema(client.ps.product).maxHealth, 100);
  client.sess.sessionTeam = Team.TEAM_FREE;
  return entity;
}

function itemEntity(setup: ReturnType<typeof fixture>, item: ItemDefinition, origin = vec3(0, 0, 40)): GameEntity {
  const entity = setup.pool.spawn();
  const index = itemList(setup.context.product).indexOf(item);
  if (index < 1) throw new Error("Fixture item does not belong to its product");
  entity.item = item;
  entity.s.modelindex = index;
  entity.s.pos = { type: TrajectoryType.TR_STATIONARY, time: 0, duration: 0, base: origin, delta: vec3(0, 0, 0) };
  entity.r.currentOrigin = origin;
  entity.r.mins = vec3(-15, -15, -15);
  entity.r.maxs = vec3(15, 15, 15);
  entity.r.contents = 0x40000000;
  setup.pool.options.link(entity);
  setup.effects.length = 0;
  return entity;
}

function contact(): MovementTrace {
  return { fraction: 1, end: vec3(0, 0, 0), solidity: "clear", contact: { kind: "none" },
    contents: 0, surfaceFlags: 0, entityNum: ENTITYNUM_NONE };
}

describe("item registration", () => {
  test("clear seeds source weapons and Team Arena Harvester cubes, then saves CS_ITEMS", () => {
    for (const scenario of [
      { product: "baseq3", gameType: GameType.GT_FFA, expected: 2 },
      { product: "missionpack", gameType: GameType.GT_HARVESTER, expected: 4 },
    ] satisfies readonly { product: Product; gameType: GameType; expected: number }[]) {
      const registry = new ItemRegistry(scenario.product);
      registry.clear(scenario.gameType);
      const effects: string[] = [];
      const count = registry.save((index, value) => { effects.push(`config:${index}:${value}`); }, message => { effects.push(`log:${message}`); });
      expect(count).toBe(scenario.expected);
      expect(effects[0]).toBe(`log:${scenario.expected} items registered\n`);
      const config = effects[1];
      if (config === undefined) throw new Error("Missing item configstring effect");
      const bits = config.slice(config.lastIndexOf(":") + 1);
      expect(bits.length).toBe(itemList(scenario.product).length);
      expect(bits.charAt(itemList(scenario.product).indexOf(findItemForWeapon(scenario.product, Weapon.WP_MACHINEGUN)))).toBe("1");
      expect(bits.charAt(itemList(scenario.product).indexOf(findItemForWeapon(scenario.product, Weapon.WP_GAUNTLET)))).toBe("1");
      if (scenario.product === "missionpack") {
        const redCube = findItem("missionpack", "Red Cube");
        if (redCube === null) throw new Error("Red Cube missing");
        expect(bits.charAt(itemList("missionpack").indexOf(redCube))).toBe("1");
      }
    }
  });
});

describe("Touch_Item", () => {
  test("passes raw team and unused persistent index through weapon eligibility", () => {
    const setup = fixture("missionpack");
    const other = player(setup);
    const client = clientOf(other);
    client.ps.persistant.set(PersistentIndex.PERS_TEAM, 4);
    client.ps.stats.set(MissionpackStatIndex.STAT_PERSISTANT_POWERUP, 999);
    const weapon = itemEntity(setup, findItemForWeapon("missionpack", Weapon.WP_SHOTGUN));
    touchItem(weapon, other, contact(), setup.context);
    expect(client.ps.ammo.get(Weapon.WP_SHOTGUN)).toBe(10);
    expect(weapon.r.contents).toBe(0);
    const scout = itemEntity(setup, requiredPowerup("missionpack", Powerup.PW_SCOUT));
    touchItem(scout, other, contact(), setup.context);
    expect(client.persistantPowerup).toBeNull();
    expect(scout.r.contents).toBe(0x40000000);
    expect(client.ps.stats.get(MissionpackStatIndex.STAT_PERSISTANT_POWERUP)).toBe(999);
  });

  test("uses player-state team for flag and persistent-powerup eligibility", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      for (const playerTeam of [Team.TEAM_RED, Team.TEAM_BLUE]) {
        const setup = fixture(product, GameType.GT_CTF);
        const other = player(setup);
        const client = clientOf(other);
        client.ps.persistant.set(PersistentIndex.PERS_TEAM, playerTeam);
        client.sess.sessionTeam = playerTeam === Team.TEAM_RED ? Team.TEAM_BLUE : Team.TEAM_RED;
        const flag = itemEntity(setup, requiredPowerup(product, Powerup.PW_REDFLAG));
        touchItem(flag, other, contact(), setup.context);
        expect(setup.effects.some(effect => effect.startsWith("team:"))).toBe(playerTeam === Team.TEAM_BLUE);
        expect(flag.r.contents).toBe(playerTeam === Team.TEAM_BLUE ? 0 : 0x40000000);
      }
    }
    for (const playerTeam of [Team.TEAM_RED, Team.TEAM_BLUE]) {
      const setup = fixture("missionpack", GameType.GT_TEAM);
      const other = player(setup);
      const client = clientOf(other);
      client.ps.persistant.set(PersistentIndex.PERS_TEAM, playerTeam);
      client.sess.sessionTeam = playerTeam === Team.TEAM_RED ? Team.TEAM_BLUE : Team.TEAM_RED;
      const scout = itemEntity(setup, requiredPowerup("missionpack", Powerup.PW_SCOUT));
      scout.s.generic1 = 2;
      touchItem(scout, other, contact(), setup.context);
      expect(client.persistantPowerup).toBe(playerTeam === Team.TEAM_RED ? scout : null);
    }
  });

  test("converts wait and random float results before deciding whether to respawn", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const noRespawn = fixture(product);
      const other = player(noRespawn);
      const item = itemEntity(noRespawn, findItemForWeapon(product, Weapon.WP_SHOTGUN));
      item.wait = 4_294_967_296;
      touchItem(item, other, contact(), noRespawn.context);
      expect(item.nextthink).toBe(0);
      expect(item.think).toBeNull();

      const randomized = fixture(product);
      const randomPlayer = player(randomized);
      const randomItem = itemEntity(randomized, findItemForWeapon(product, Weapon.WP_SHOTGUN));
      randomItem.wait = 1;
      randomItem.random = 4_294_967_296;
      randomized.randomState.unit = 1;
      touchItem(randomItem, randomPlayer, contact(), randomized.context);
      expect(randomItem.nextthink).toBe(2_000);
      expect(randomItem.think).not.toBeNull();
    }
  });

  test("uses shared pickup eligibility and schedules wait/random respawn after a predictable event", () => {
    const setup = fixture();
    const other = player(setup);
    const item = itemEntity(setup, findItemForWeapon("baseq3", Weapon.WP_SHOTGUN));
    item.wait = 10;
    item.random = 2;
    setup.randomState.unit = 1;
    clientOf(other).pers.predictItemPickup = true;
    touchItem(item, other, contact(), setup.context);
    expect(clientOf(other).ps.ammo.get(Weapon.WP_SHOTGUN)).toBe(10);
    expect(clientOf(other).ps.events.get(0)).toBe(EntityEvent.EV_ITEM_PICKUP);
    expect(clientOf(other).ps.eventParms.get(0)).toBe(item.s.modelindex);
    expect(item.nextthink).toBe(13_000);
    expect(item.think).not.toBeNull();
    expect(item.r.svFlags & ServerEntityFlags.NOCLIENT).toBe(ServerEntityFlags.NOCLIENT);
    expect(item.s.eFlags & 0x80).toBe(0x80);
    expect(item.r.contents).toBe(0);
    expect(setup.effects).toEqual([
      `log:Item: 0 ${item.item?.className}\n`,
      `targets:${item.slot}:0`,
      `link:${item.slot}`,
    ]);
  });

  test("rejects dead and ineligible players without pickup side effects", () => {
    const setup = fixture();
    const other = player(setup);
    const ammo = itemEntity(setup, findItem("baseq3", "Shells") ?? findItemForWeapon("baseq3", Weapon.WP_SHOTGUN));
    clientOf(other).ps.ammo.set(Weapon.WP_SHOTGUN, 200);
    touchItem(ammo, other, contact(), setup.context);
    expect(setup.effects).toEqual([]);
    other.health = 0;
    clientOf(other).ps.ammo.set(Weapon.WP_SHOTGUN, 0);
    touchItem(ammo, other, contact(), setup.context);
    expect(setup.effects).toEqual([]);
  });

  test("powerups force an authoritative pickup and broadcast a global item event before targets", () => {
    const setup = fixture();
    const other = player(setup);
    clientOf(other).pers.predictItemPickup = true;
    const item = itemEntity(setup, requiredPowerup("baseq3", Powerup.PW_QUAD), vec3(1.9, 2.9, 40.9));
    touchItem(item, other, contact(), setup.context);
    expect(clientOf(other).ps.externalEvent & 0xff).toBe(EntityEvent.EV_ITEM_PICKUP);
    expect(clientOf(other).ps.eventSequence).toBe(0);
    const temporary = setup.pool.at(item.slot + 1);
    expect(temporary.s.eType).toBe(EntityType.ET_EVENTS + EntityEvent.EV_GLOBAL_ITEM_PICKUP);
    expect(temporary.s.eventParm).toBe(item.s.modelindex);
    expect(temporary.s.pos.base).toEqual(vec3(1, 2, 40));
    expect(temporary.r.svFlags & ServerEntityFlags.BROADCAST).toBe(ServerEntityFlags.BROADCAST);
    expect(setup.effects).toEqual([
      `log:Item: 0 ${item.item?.className}\n`,
      `link:${temporary.slot}`,
      `targets:${item.slot}:0`,
      `link:${item.slot}`,
    ]);
  });

  test("wait -1 defers unlink through the event lifetime and dropped items become free-after-event", () => {
    const noRespawn = fixture();
    const other = player(noRespawn);
    const item = itemEntity(noRespawn, findItemForWeapon("baseq3", Weapon.WP_SHOTGUN));
    item.wait = -1;
    touchItem(item, other, contact(), noRespawn.context);
    expect(item.unlinkAfterEvent).toBe(true);
    expect(noRespawn.world.linkState(item.slot)?.linked).toBe(true);
    noRespawn.clock.now = 1_301;
    expect(noRespawn.pool.expireEvents(item)).toBe("active");
    expect(noRespawn.world.linkState(item.slot)?.linked).toBe(false);

    const droppedSetup = fixture();
    const droppedPlayer = player(droppedSetup);
    const dropped = itemEntity(droppedSetup, findItemForWeapon("baseq3", Weapon.WP_SHOTGUN));
    dropped.flags = GameFlags.DROPPED_ITEM;
    touchItem(dropped, droppedPlayer, contact(), droppedSetup.context);
    expect(dropped.freeAfterEvent).toBe(true);
    droppedSetup.clock.now = 1_301;
    expect(droppedSetup.pool.expireEvents(dropped)).toBe("freed");
    expect(dropped.inuse).toBe(false);
  });

  test("team pickup zero stops before event, target, and hide side effects", () => {
    const setup = fixture("baseq3", GameType.GT_CTF);
    const other = player(setup);
    clientOf(other).sess.sessionTeam = Team.TEAM_BLUE;
    clientOf(other).ps.persistant.set(PersistentIndex.PERS_TEAM, Team.TEAM_BLUE);
    const item = itemEntity(setup, requiredPowerup("baseq3", Powerup.PW_REDFLAG));
    const context: ItemLifecycleContext = { ...setup.context,
      teamPickup: (picked, carrier) => { setup.effects.push(`team:${picked.slot}:${carrier.slot}`); return 0; } };
    touchItem(item, other, contact(), context);
    expect(setup.effects).toEqual([`log:Item: 0 ${item.item?.className}\n`, `team:${item.slot}:0`]);
    expect(item.r.contents).toBe(0x40000000);
    expect(clientOf(other).ps.eventSequence).toBe(0);
    expect(clientOf(other).ps.externalEvent).toBe(0);
  });

  test("successful team pickup keeps prediction and scopes the global event when requested", () => {
    const setup = fixture("baseq3", GameType.GT_CTF);
    const other = player(setup);
    clientOf(other).sess.sessionTeam = Team.TEAM_BLUE;
    clientOf(other).ps.persistant.set(PersistentIndex.PERS_TEAM, Team.TEAM_BLUE);
    clientOf(other).pers.predictItemPickup = true;
    const item = itemEntity(setup, requiredPowerup("baseq3", Powerup.PW_REDFLAG));
    item.speed = 1;
    touchItem(item, other, contact(), setup.context);
    expect(clientOf(other).ps.events.get(0)).toBe(EntityEvent.EV_ITEM_PICKUP);
    const temporary = setup.pool.at(item.slot + 1);
    expect(temporary.s.eType).toBe(EntityType.ET_EVENTS + EntityEvent.EV_GLOBAL_ITEM_PICKUP);
    expect(temporary.r.svFlags & ServerEntityFlags.SINGLECLIENT).toBe(ServerEntityFlags.SINGLECLIENT);
    expect(temporary.r.svFlags & ServerEntityFlags.BROADCAST).toBe(0);
    expect(temporary.r.singleClient).toBe(other.s.number);
    expect(setup.effects).toEqual([
      `log:Item: 0 ${item.item?.className}\n`,
      `team:${item.slot}:0`,
      `link:${temporary.slot}`,
      `targets:${item.slot}:0`,
      `link:${item.slot}`,
    ]);
  });

  test("missionpack persistent pickup uses shared rules and remains hidden without a respawn think", () => {
    const setup = fixture("missionpack", GameType.GT_TEAM);
    const other = player(setup);
    clientOf(other).sess.sessionTeam = Team.TEAM_RED;
    clientOf(other).ps.persistant.set(PersistentIndex.PERS_TEAM, Team.TEAM_RED);
    const scout = itemEntity(setup, requiredPowerup("missionpack", Powerup.PW_SCOUT));
    scout.s.generic1 = 2;
    touchItem(scout, other, contact(), setup.context);
    expect(clientOf(other).persistantPowerup).toBe(scout);
    expect(scout.nextthink).toBe(0);
    expect(scout.think).toBeNull();
    expect(scout.r.contents).toBe(0);
    expect(scout.s.eFlags & 0x80).toBe(0x80);
  });
});

describe("RespawnItem", () => {
  test("restores a powerup, links before its broadcast sound, and adds item respawn", () => {
    const setup = fixture();
    const item = itemEntity(setup, requiredPowerup("baseq3", Powerup.PW_QUAD), vec3(1.9, 2.9, 40.9));
    item.r.contents = 0;
    item.s.eFlags |= 0x80;
    item.r.svFlags |= ServerEntityFlags.NOCLIENT;
    item.nextthink = 1_000;
    setup.world.unlink(item.slot);
    setup.effects.length = 0;
    respawnItem(item, setup.context);
    expect(item.r.contents).toBe(0x40000000);
    expect(item.s.eFlags & 0x80).toBe(0);
    expect(item.r.svFlags & ServerEntityFlags.NOCLIENT).toBe(0);
    expect(item.s.event & 0xff).toBe(EntityEvent.EV_ITEM_RESPAWN);
    expect(item.nextthink).toBe(0);
    const sound = setup.pool.at(item.slot + 1);
    expect(sound.s.eType).toBe(EntityType.ET_EVENTS + EntityEvent.EV_GLOBAL_SOUND);
    expect(sound.s.eventParm).toBe(77);
    expect(sound.r.svFlags & ServerEntityFlags.BROADCAST).toBe(ServerEntityFlags.BROADCAST);
    expect(setup.effects).toEqual([
      `link:${item.slot}`,
      `link:${sound.slot}`,
      "sound:sound/items/poweruprespawn.wav",
    ]);
  });

  test("selects rand modulo item-team member and uses local kamikaze respawn sound", () => {
    const setup = fixture("missionpack");
    const kamikaze = findItem("missionpack", "Kamikaze");
    if (kamikaze === null) throw new Error("Kamikaze missing");
    const members = [itemEntity(setup, kamikaze), itemEntity(setup, kamikaze), itemEntity(setup, kamikaze)];
    const master = members[0], middle = members[1], last = members[2];
    if (master === undefined || middle === undefined || last === undefined) throw new Error("Fixture team member missing");
    master.team = "items";
    middle.team = "items";
    last.team = "items";
    master.teammaster = master;
    middle.teammaster = master;
    last.teammaster = master;
    master.teamchain = middle;
    middle.teamchain = last;
    for (const member of members) {
      member.r.contents = 0;
      member.s.eFlags |= 0x80;
      member.r.svFlags |= ServerEntityFlags.NOCLIENT;
      setup.world.unlink(member.slot);
    }
    last.speed = 1;
    setup.randomState.integer = 2;
    setup.effects.length = 0;
    respawnItem(middle, setup.context);
    expect(master.r.contents).toBe(0);
    expect(middle.r.contents).toBe(0);
    expect(last.r.contents).toBe(0x40000000);
    const sound = setup.pool.at(last.slot + 1);
    expect(sound.s.eType).toBe(EntityType.ET_EVENTS + EntityEvent.EV_GENERAL_SOUND);
    expect(setup.effects).toEqual([
      `link:${last.slot}`,
      `link:${sound.slot}`,
      "sound:sound/items/kamikazerespawn.wav",
    ]);
  });
});

describe("FinishSpawningItem", () => {
  test("converts the powerup float schedule at the signed-clock limit", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const setup = fixture(product);
      setup.clock.now = 2_147_483_647;
      setup.randomState.unit = 0;
      const powerup = setup.pool.spawn();
      powerup.item = requiredPowerup(product, Powerup.PW_QUAD);
      powerup.spawnflags = 1;
      finishSpawningItem(powerup, setup.context);
      expect(powerup.nextthink).toBe(-2_147_483_648);
    }
  });

  test("plants an ordinary item through a real ServerWorld trace and installs touch/use callbacks", () => {
    const setup = fixture();
    const item = findItemForWeapon("baseq3", Weapon.WP_SHOTGUN);
    const entity = setup.pool.spawn();
    entity.s.origin = vec3(0, 0, 40);
    entity.classname = item.className;
    entity.item = item;
    entity.s.origin = vec3(10, 20, 40);
    setup.effects.length = 0;
    finishSpawningItem(entity, setup.context);
    expect(entity.s.eType).toBe(EntityType.ET_ITEM);
    expect(entity.s.modelindex).toBe(itemList("baseq3").indexOf(item));
    expect(entity.s.modelindex2).toBe(0);
    expect(entity.r.mins).toEqual(vec3(-15, -15, -15));
    expect(entity.r.maxs).toEqual(vec3(15, 15, 15));
    expect(entity.r.currentOrigin).toEqual(vec3(10, 20, 15.125));
    expect(entity.s.groundEntityNum).toBe(ENTITYNUM_WORLD);
    expect(entity.touch).not.toBeNull();
    expect(entity.use).not.toBeNull();
    expect(setup.world.linkState(entity.slot)?.linked).toBe(true);
    expect(setup.effects).toEqual([`link:${entity.slot}`]);

    entity.r.contents = 0;
    entity.s.eFlags |= 0x80;
    entity.r.svFlags |= ServerEntityFlags.NOCLIENT;
    setup.world.unlink(entity.slot);
    const use = entity.use;
    if (use === null) throw new Error("FinishSpawningItem did not install Use_Item");
    setup.effects.length = 0;
    use(entity, null, null);
    expect(entity.r.contents).toBe(0x40000000);
    expect(entity.s.eFlags & 0x80).toBe(0);
    expect(setup.effects[0]).toBe(`link:${entity.slot}`);
  });

  test("suspended, team-slave, and targeted items retain source visibility and linking rules", () => {
    const suspended = fixture();
    const item = findItemForWeapon("baseq3", Weapon.WP_SHOTGUN);
    const floating = suspended.pool.spawn();
    floating.item = item;
    floating.spawnflags = 1;
    floating.s.origin = vec3(1, 2, 300);
    finishSpawningItem(floating, suspended.context);
    expect(floating.r.currentOrigin).toEqual(vec3(1, 2, 300));
    expect(suspended.world.linkState(floating.slot)?.linked).toBe(true);

    for (const mode of ["team", "target"] satisfies readonly string[]) {
      const setup = fixture();
      const hidden = setup.pool.spawn();
      hidden.item = item;
      hidden.spawnflags = 1;
      hidden.s.origin = vec3(0, 0, 100);
      if (mode === "team") hidden.flags |= GameFlags.TEAMSLAVE;
      else hidden.targetname = "";
      finishSpawningItem(hidden, setup.context);
      expect(hidden.s.eFlags & 0x80).toBe(0x80);
      expect(hidden.r.contents).toBe(0);
      expect(setup.world.linkState(hidden.slot)).toBeUndefined();
    }
  });

  test("frees startsolid items after warning and delays powerups over the inclusive random range", () => {
    const blocked = fixture();
    const weapon = findItemForWeapon("baseq3", Weapon.WP_SHOTGUN);
    const stuck = blocked.pool.spawn();
    stuck.classname = weapon.className;
    stuck.item = weapon;
    stuck.s.origin = vec3(0, 0, -20);
    finishSpawningItem(stuck, blocked.context);
    expect(blocked.effects[0]).toContain("startsolid at (0 0 -20)");
    expect(stuck.inuse).toBe(false);

    for (const scenario of [{ unit: 0, delay: 30_000 }, { unit: 1, delay: 60_000 }]) {
      const setup = fixture();
      setup.randomState.unit = scenario.unit;
      const powerup = setup.pool.spawn();
      powerup.item = requiredPowerup("baseq3", Powerup.PW_QUAD);
      powerup.spawnflags = 1;
      powerup.s.origin = vec3(0, 0, 100);
      finishSpawningItem(powerup, setup.context);
      expect(powerup.nextthink).toBe(1_000 + scenario.delay);
      expect(powerup.think).not.toBeNull();
      expect(powerup.s.eFlags & 0x80).toBe(0x80);
      expect(powerup.r.contents).toBe(0);
      expect(setup.world.linkState(powerup.slot)).toBeUndefined();
    }
  });
});

describe("G_SpawnItem", () => {
  test("reads the disable cvar after spawn fields and registration and preserves that prefix on failure", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const setup = fixture(product);
      const item = findItemForWeapon(product, Weapon.WP_SHOTGUN);
      const entity = setup.pool.spawn();
      const retainedItem = findItemForWeapon(product, Weapon.WP_MACHINEGUN);
      const retainedThink = (): void => {};
      entity.item = retainedItem;
      entity.think = retainedThink;
      entity.nextthink = 17;
      entity.physicsBounce = 0.75;
      const variables = new SpawnVariables([{ key: "random", value: "2.5" }, { key: "wait", value: "7.25" }]);
      let reads = 0;
      expect(() => spawnItem(entity, item, variables, () => {
        reads++;
        expect(entity.random).toBe(2.5);
        expect(entity.wait).toBe(7.25);
        expect(setup.registry.isRegistered(item)).toBe(true);
        throw new Error("disable cvar unavailable");
      }, setup.context)).toThrow("disable cvar unavailable");
      expect(reads).toBe(1);
      expect(entity.random).toBe(2.5);
      expect(entity.wait).toBe(7.25);
      expect(setup.registry.isRegistered(item)).toBe(true);
      expect(entity.item).toBe(retainedItem);
      expect(entity.think).toBe(retainedThink);
      expect(entity.nextthink).toBe(17);
      expect(entity.physicsBounce).toBe(0.75);
    }
  });

  test("finishes a nested item spawn at the disable read before continuing the outer item", () => {
    const setup = fixture();
    const outerItem = findItemForWeapon("baseq3", Weapon.WP_SHOTGUN);
    const innerItem = findItemForWeapon("baseq3", Weapon.WP_RAILGUN);
    const outer = setup.pool.spawn();
    let reads = 0;
    spawnItem(outer, outerItem, new SpawnVariables([{ key: "wait", value: "7" }]), () => {
      reads++;
      expect(setup.registry.isRegistered(outerItem)).toBe(true);
      expect(outer.wait).toBe(7);
      expect(outer.item).toBeNull();
      const inner = setup.pool.spawn();
      spawnItem(inner, innerItem, new SpawnVariables([]), () => {
        reads++;
        expect(setup.registry.isRegistered(innerItem)).toBe(true);
        expect(outer.item).toBeNull();
        return false;
      }, setup.context);
      expect(inner.item).toBe(innerItem);
      expect(inner.nextthink).toBe(1_200);
      expect(outer.item).toBeNull();
      setup.clock.now = 2_000;
      return false;
    }, setup.context);
    expect(reads).toBe(2);
    expect(outer.item).toBe(outerItem);
    expect(outer.nextthink).toBe(2_200);
    expect(outer.wait).toBe(7);
  });

  test("reads explicit spawn floats, registers before disabled return, and schedules third-frame placement", () => {
    const setup = fixture();
    const item = findItemForWeapon("baseq3", Weapon.WP_SHOTGUN);
    const entity = setup.pool.spawn();
    entity.s.origin = vec3(0, 0, 40);
    const variables = new SpawnVariables([
      { key: "random", value: "2.5tail" }, { key: "wait", value: "7.25" },
      { key: "random", value: "99" },
    ]);
    spawnItem(entity, item, variables, () => false, setup.context);
    expect(entity.random).toBe(2.5);
    expect(entity.wait).toBe(7.25);
    expect(entity.item).toBe(item);
    expect(entity.nextthink).toBe(1_200);
    expect(entity.physicsBounce).toBe(0.5);
    expect(entity.think).not.toBeNull();
    setup.clock.now = 1_200;
    runThink(entity, 1_200);
    expect(entity.s.eType).toBe(EntityType.ET_ITEM);
    expect(setup.world.linkState(entity.slot)?.linked).toBe(true);

    const disabled = setup.pool.spawn();
    spawnItem(disabled, findItemForWeapon("baseq3", Weapon.WP_RAILGUN), new SpawnVariables([]), () => true, setup.context);
    expect(disabled.item).toBeNull();
    expect(disabled.think).toBeNull();
    const saved: string[] = [];
    setup.registry.save((_index, value) => { saved.push(value); }, () => {});
    const config = saved[0];
    if (config === undefined) throw new Error("Missing item registry configstring");
    expect(config.charAt(itemList("baseq3").indexOf(item))).toBe("1");
    expect(config.charAt(itemList("baseq3").indexOf(findItemForWeapon("baseq3", Weapon.WP_RAILGUN)))).toBe("1");
  });

  test("preloads powerup respawn sound and copies missionpack persistent spawn flags", () => {
    const powerupSetup = fixture();
    const powerup = powerupSetup.pool.spawn();
    spawnItem(powerup, requiredPowerup("baseq3", Powerup.PW_QUAD),
      new SpawnVariables([{ key: "noglobalsound", value: "1" }]), () => false, powerupSetup.context);
    expect(powerup.speed).toBe(1);
    expect(powerupSetup.effects).toContain("sound:sound/items/poweruprespawn.wav");

    const missionpack = fixture("missionpack");
    const persistent = missionpack.pool.spawn();
    persistent.spawnflags = 6;
    const scout = requiredPowerup("missionpack", Powerup.PW_SCOUT);
    spawnItem(persistent, scout, new SpawnVariables([]), () => false, missionpack.context);
    expect(persistent.s.generic1).toBe(6);
  });
});

test("lifecycle boundaries reject foreign entities, product tables, registries, and RNG results", () => {
  const base = fixture();
  const playerEntity = player(base);
  const item = itemEntity(base, findItemForWeapon("baseq3", Weapon.WP_SHOTGUN));
  expect(() => touchItem(new GameEntity(item.slot), playerEntity, contact(), base.context)).toThrow("does not belong");
  const missionItem = findItemForWeapon("missionpack", Weapon.WP_CHAINGUN);
  expect(() => spawnItem(base.pool.spawn(), missionItem, new SpawnVariables([]), () => false, base.context)).toThrow("item table");
  item.s.modelindex++;
  expect(() => touchItem(item, playerEntity, contact(), base.context)).toThrow("model index");
  item.s.modelindex--;
  expect(() => respawnItem(item, { ...base.context, registry: new ItemRegistry("missionpack") })).toThrow("product");
  item.team = "bad";
  item.teammaster = item;
  const brokenRandom: ItemLifecycleContext = { ...base.context, random: { rand: () => -1, random: () => 0.5 } };
  expect(() => respawnItem(item, brokenRandom)).toThrow(RangeError);
});

const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retailPak = `${retailRoot}/baseq3/pak0.pk3`;
test.skipIf(!(await Bun.file(retailPak).exists()))("plants a shipped q3dm1 item on retail collision", async () => {
  using archive = await Pk3Archive.open(retailPak);
  const map = parseBsp(await archive.read("maps/q3dm1.bsp"), "maps/q3dm1.bsp");
  const record = map.entityRecords.find(candidate => candidate.get("classname") === "item_armor_body");
  if (record === undefined) throw new Error("q3dm1 item_armor_body is missing");
  const variables = new SpawnVariables([...record].map(([key, value]) => ({ key, value })));
  const setup = fixture("baseq3", GameType.GT_FFA, map);
  const entity = setup.pool.spawn();
  const item = findItem("baseq3", "Heavy Armor");
  if (item === null) throw new Error("Heavy Armor item definition is missing");
  entity.classname = item.className;
  entity.item = item;
  entity.s.origin = variables.vector("origin", "0 0 0").value;
  finishSpawningItem(entity, setup.context);
  expect(entity.inuse).toBe(true);
  expect(entity.s.groundEntityNum).toBe(ENTITYNUM_WORLD);
  expect(entity.r.currentOrigin.z).toBeLessThan(entity.s.origin.z);
  expect(setup.world.linkState(entity.slot)?.linked).toBe(true);
});
