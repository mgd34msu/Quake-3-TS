import { describe, expect, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { Pk3Archive } from "../src/assets/pk3.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import type { Bounds } from "../src/core/math.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { EntityPool, initGameEntity, runThink, setOrigin } from "../src/game/entities.ts";
import { ItemRegistry } from "../src/game/item-lifecycle.ts";
import { GameMemory } from "../src/game/memory.ts";
import type { ItemLifecycleContext } from "../src/game/item-lifecycle.ts";
import { SpawnVariables, spawnEntity } from "../src/game/spawn.ts";
import type { SpawnPair } from "../src/game/spawn.ts";
import { ConnectionState, GameEntity } from "../src/game/state.ts";
import { TargetLocationState, targetSpawnHandlers } from "../src/game/targets.ts";
import type { TargetRuntime } from "../src/game/targets.ts";
import { EntityEvent, EntityType, GameType, MissionpackStatIndex, MoveType, PersistentIndex, Powerup, Team, Weapon,
  statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { findItemForWeapon, itemList } from "../src/shared/items.ts";
import type { ItemDefinition } from "../src/shared/items.ts";
import { ENTITYNUM_WORLD } from "../src/shared/player-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";
import { ServerWorld } from "../src/server/world.ts";

const worldBounds: Bounds = { min: vec3(-2_048, -2_048, -2_048), max: vec3(2_048, 2_048, 2_048) };

function emptyMap(): BspMap {
  return { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds: worldBounds, firstSurface: 0, surfaceCount: 0,
      firstBrush: 0, brushCount: 0 }], leafSurfaces: [], leafBrushes: [],
    models: [{ bounds: worldBounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [],
    lightGrid: [], visibility: null };
}

function fixture(product: Product = "baseq3", gameType = GameType.GT_FFA) {
  const clock = { now: 1_000 };
  const random = { integer: 0, centered: 0 };
  const effects: string[] = [];
  const memory = new GameMemory(() => 0, text => { effects.push(text); });
  let activeWorld: ServerWorld | null = null;
  const currentWorld = (): ServerWorld => {
    if (activeWorld === null) throw new Error("Target fixture world is unavailable");
    return activeWorld;
  };
  const pool = new EntityPool({ print: text => { effects.push(`warn:${text}`); }, product, maxClients: 3, mapStartTime: 0, time: () => clock.now,
    link: entity => { currentWorld().link(entity); effects.push(`link:${entity.slot}`); },
    unlink: entity => { currentWorld().unlink(entity.slot); effects.push(`unlink:${entity.slot}`); } });
  const collision = new CollisionWorld(emptyMap(), { kind: "unaccounted" }, { kind: "disabled" });
  const worldPrints: string[] = [];
  activeWorld = new ServerWorld(collision, collision.modelBounds(0), number => pool.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  pool.at(ENTITYNUM_WORLD).s.number = ENTITYNUM_WORLD;
  const registry = new ItemRegistry(product);
  registry.clear(gameType);
  const itemLifecycle: ItemLifecycleContext = {
    entities: pool, world: currentWorld(), product, gameType, weaponRespawnSeconds: 5,
    teamWeaponRespawnSeconds: 30, handicapForClient: () => "100",
    teamPickup: () => { throw new Error("Unexpected team pickup"); },
    useTargets: (item, activator) => { effects.push(`item-targets:${item.slot}:${activator.slot}`); },
    soundIndex: path => { effects.push(`sound-index:${path}`); return 71; },
    random: { rand: () => random.integer, random: () => Math.fround((random.centered + 1) * 0.5) },
    registry, log: message => { effects.push(`log:${message}`); },
    warn: message => { effects.push(`warn:${message}`); },
  };
  const combat = (): CombatContext => {
    const common = { time: clock.now, intermissionQueued: 0, gameType, friendlyFire: false, knockback: 1_000,
      entities: pool, world: currentWorld(), debugDamage: null,
      checkHurtCarrier: () => {}, logAccuracyHit: () => false };
    return product === "baseq3" ? { ...common, product: "baseq3" }
      : { ...common, product: "missionpack", checkObeliskAttack: () => false,
        invulnerabilityEffect: () => {} };
  };
  const locations = new TargetLocationState();
  const runtime: TargetRuntime = {
    entities: pool, world: currentWorld(), itemLifecycle, combat, locations,
    random: { rand: () => random.integer, crandom: () => Math.fround(random.centered) },
    gravity: () => 800,
    soundIndex: path => { effects.push(`sound-index:${path}`); return 71; },
    addScore: (playerEntity, origin, points) => {
      effects.push(`score:${playerEntity.slot}:${origin.x},${origin.y},${origin.z}:${points}`);
      const client = playerEntity.client;
      if (client === null) throw new Error("Score fixture requires a client");
      const scores = client.ps.persistant;
      scores.set(PersistentIndex.PERS_SCORE, scores.get(PersistentIndex.PERS_SCORE) + points);
    },
    returnFlag: team => { effects.push(`return:${team}`); },
    sendServerCommand: (clientNum, command) => { effects.push(`command:${clientNum}:${command}`); },
    remapShader: (oldName, newName, time) => { effects.push(`remap:${oldName}:${newName}:${time}`); },
    setConfigstring: (index, value) => { effects.push(`config:${index}:${value}`); },
    warn: message => { effects.push(`warn:${message}`); },
  };
  return { clock, random, effects, pool, memory, world: currentWorld(), runtime, product, gameType };
}

function player(setup: ReturnType<typeof fixture>, slot: number, team = Team.TEAM_FREE): GameEntity {
  const entity = setup.pool.at(slot);
  initGameEntity(entity);
  entity.client?.ps.stats.set(statSchema(setup.product).maxHealth, 100);
  if (entity.client === null) throw new Error("Player fixture has no client");
  entity.client.ps.pmType = MoveType.PM_NORMAL;
  entity.client.sess.sessionTeam = team;
  entity.client.pers.connected = ConnectionState.CONNECTED;
  entity.health = 100;
  entity.s.eType = EntityType.ET_PLAYER;
  return entity;
}

function spawnTarget(setup: ReturnType<typeof fixture>, classname: string,
  entries: readonly SpawnPair[] = []): GameEntity {
  const variables = new SpawnVariables([{ key: "classname", value: classname }, ...entries]);
  const outcome = spawnEntity(variables, { pool: setup.pool, memory: setup.memory, product: setup.product, gameType: setup.gameType,
    handlers: targetSpawnHandlers(setup.runtime), spawnItem: () => { throw new Error("Unexpected item spawn"); },
    warn: setup.runtime.warn });
  if (outcome.kind !== "dispatched") throw new Error(`Target fixture spawn failed: ${outcome.kind}`);
  return outcome.entity;
}

function targetItem(setup: ReturnType<typeof fixture>, item: ItemDefinition, targetname: string): GameEntity {
  const entity = setup.pool.spawn();
  const index = itemList(setup.product).indexOf(item);
  if (index < 1) throw new Error("Target fixture item table mismatch");
  entity.item = item;
  entity.targetname = targetname;
  entity.s.modelindex = index;
  entity.s.pos = { type: TrajectoryType.TR_STATIONARY, time: 0, duration: 0,
    base: vec3(0, 0, 0), delta: vec3(0, 0, 0) };
  entity.r.contents = 0x40000000;
  setup.pool.options.link(entity);
  return entity;
}

function invoke(entity: GameEntity, activator: GameEntity | null): void {
  const use = entity.use;
  if (use === null) throw new Error("Target fixture entity has no use callback");
  use(entity, null, activator);
}

describe("target give and powerup removal", () => {
  test("target_give touches every matching item then cancels its think and unlinks it", () => {
    const setup = fixture();
    const activator = player(setup, 0);
    const shotgun = targetItem(setup, findItemForWeapon("baseq3", Weapon.WP_SHOTGUN), "loot");
    shotgun.nextthink = 20_000;
    const nonItem = setup.pool.spawn();
    nonItem.targetname = "loot";
    const give = spawnTarget(setup, "target_give", [{ key: "target", value: "loot" }]);
    setup.effects.length = 0;
    invoke(give, activator);
    expect(activator.client?.ps.ammo.get(Weapon.WP_SHOTGUN)).toBe(10);
    expect(shotgun.nextthink).toBe(0);
    expect(setup.world.linkState(shotgun.slot)?.linked).toBe(false);
    expect(nonItem.inuse).toBe(true);
    expect(setup.effects.at(-1)).toBe(`unlink:${shotgun.slot}`);
  });

  test("target_remove_powerups returns one flag by source precedence and leaves persistent stats alone", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const setup = fixture(product);
      const activator = player(setup, 0);
      if (activator.client === null) throw new Error("Player fixture has no client");
      activator.client.ps.powerups.set(Powerup.PW_REDFLAG, 11);
      activator.client.ps.powerups.set(Powerup.PW_BLUEFLAG, 12);
      activator.client.ps.powerups.set(Powerup.PW_QUAD, 13);
      if (product === "missionpack") {
        activator.client.ps.stats.set(MissionpackStatIndex.STAT_PERSISTANT_POWERUP, 9);
      }
      const remove = spawnTarget(setup, "target_remove_powerups");
      setup.effects.length = 0;
      invoke(remove, activator);
      expect(setup.effects).toEqual([`return:${Team.TEAM_RED}`]);
      for (let index = 0; index < activator.client.ps.powerups.length; index++) {
        expect(activator.client.ps.powerups.get(index)).toBe(0);
      }
      if (product === "missionpack") {
        expect(activator.client.ps.stats.get(MissionpackStatIndex.STAT_PERSISTANT_POWERUP)).toBe(9);
      }
    }
  });
});

describe("target delay, score, print, relay, and position", () => {
  test("target_delay prefers delay, uses inclusive crandom at float32 boundaries, then dispatches", () => {
    const setup = fixture();
    setup.random.centered = 1;
    const receiver = setup.pool.spawn();
    receiver.targetname = "after";
    receiver.use = (_self, other, activator) => { setup.effects.push(`used:${other?.slot}:${activator?.slot}`); };
    const delay = spawnTarget(setup, "target_delay", [
      { key: "delay", value: "2.5" }, { key: "wait", value: "99" },
      { key: "random", value: "0.25" }, { key: "target", value: "after" },
    ]);
    delay.targetShaderName = "old";
    delay.targetShaderNewName = "new";
    const activator = player(setup, 0);
    invoke(delay, activator);
    expect(delay.wait).toBe(2.5);
    expect(delay.nextthink).toBe(3_750);
    expect(delay.activator).toBe(activator);
    setup.clock.now = 3_750;
    runThink(delay, setup.clock.now);
    expect(setup.effects.slice(-2)).toEqual(["remap:old:new:3.750000238418579", `used:${delay.slot}:0`]);

    const fallback = spawnTarget(setup, "target_delay", [{ key: "wait", value: "0" }]);
    expect(fallback.wait).toBe(1);
  });

  test("target_score defaults to one and passes the target's current origin to the score service", () => {
    const setup = fixture();
    const activator = player(setup, 0);
    const score = spawnTarget(setup, "target_score");
    setOrigin(score, vec3(3, 4, 5));
    invoke(score, activator);
    expect(score.count).toBe(1);
    expect(activator.client?.ps.persistant.get(PersistentIndex.PERS_SCORE)).toBe(1);
    expect(setup.effects.at(-1)).toBe("score:0:3,4,5:1");
  });

  test("target_delay converts an out-of-range float schedule to the source integer result", () => {
    const setup = fixture();
    const delay = spawnTarget(setup, "target_delay", [{ key: "wait", value: "5000000" }]);
    invoke(delay, null);
    expect(delay.nextthink).toBe(-2_147_483_648);
    runThink(delay, setup.clock.now);
    expect(delay.nextthink).toBe(-2_147_483_648);
  });

  test("target_print preserves private, team, and broadcast command routing", () => {
    const setup = fixture();
    const red = player(setup, 0, Team.TEAM_RED);
    player(setup, 1, Team.TEAM_BLUE);
    const privatePrint = spawnTarget(setup, "target_print", [
      { key: "spawnflags", value: "4" }, { key: "message", value: "private" },
    ]);
    invoke(privatePrint, red);
    const teamPrint = spawnTarget(setup, "target_print", [
      { key: "spawnflags", value: "3" }, { key: "message", value: "teams" },
    ]);
    invoke(teamPrint, red);
    const allPrint = spawnTarget(setup, "target_print", [{ key: "message", value: "all" }]);
    invoke(allPrint, red);
    expect(setup.effects.filter(effect => effect.startsWith("command:"))).toEqual([
      'command:0:cp "private"', 'command:0:cp "teams"', 'command:1:cp "teams"', 'command:-1:cp "all"',
    ]);
  });

  test("target_relay applies client team gates and random selection before ordinary target dispatch", () => {
    const setup = fixture("baseq3", GameType.GT_TEAM);
    const red = player(setup, 0, Team.TEAM_RED);
    const blue = player(setup, 1, Team.TEAM_BLUE);
    for (const label of ["first", "second"]) {
      const receiver = setup.pool.spawn();
      receiver.targetname = "branch";
      receiver.use = (_self, other, activator) => { setup.effects.push(`${label}:${other?.slot}:${activator?.slot}`); };
    }
    const relay = spawnTarget(setup, "target_relay", [
      { key: "spawnflags", value: "5" }, { key: "target", value: "branch" },
    ]);
    invoke(relay, blue);
    expect(setup.effects.some(effect => effect.startsWith("first:") || effect.startsWith("second:"))).toBe(false);
    setup.random.integer = 32_767;
    invoke(relay, red);
    expect(setup.effects.at(-1)).toBe(`second:${relay.slot}:0`);

    relay.spawnflags = 0;
    invoke(relay, red);
    expect(setup.effects.slice(-2)).toEqual([`first:${relay.slot}:0`, `second:${relay.slot}:0`]);
  });

  test("target_position performs the source G_SetOrigin state update", () => {
    const setup = fixture();
    const position = spawnTarget(setup, "target_position", [{ key: "origin", value: "1 2 3" }]);
    expect(position.s.pos.base).toEqual(vec3(1, 2, 3));
    expect(position.r.currentOrigin).toEqual(vec3(1, 2, 3));
    expect(position.s.pos.type).toBe(TrajectoryType.TR_STATIONARY);
  });
});

describe("target speaker and push", () => {
  test("target_speaker registers source paths, publishes state, and toggles looped sound", () => {
    const setup = fixture();
    const speaker = spawnTarget(setup, "target_speaker", [
      { key: "noise", value: "sound/world/klaxon" }, { key: "wait", value: "1.25" },
      { key: "random", value: "0.75" }, { key: "spawnflags", value: "5" },
      { key: "origin", value: "10 20 30" },
    ]);
    expect(speaker.s.eType).toBe(EntityType.ET_SPEAKER);
    expect(speaker.s.eventParm).toBe(71);
    expect(speaker.s.frame).toBe(12);
    expect(speaker.s.clientNum).toBe(7);
    expect(speaker.s.loopSound).toBe(71);
    expect(speaker.s.pos.base).toEqual(vec3(10, 20, 30));
    expect(setup.effects).toContain("sound-index:sound/world/klaxon.wav");
    expect(setup.world.linkState(speaker.slot)?.linked).toBe(true);
    invoke(speaker, null);
    expect(speaker.s.loopSound).toBe(0);
    invoke(speaker, null);
    expect(speaker.s.loopSound).toBe(71);
  });

  test("target_speaker preserves activator and global one-shot event routing", () => {
    const setup = fixture();
    const activator = player(setup, 0);
    const relative = spawnTarget(setup, "target_speaker", [{ key: "noise", value: "*jump1.wav" }]);
    invoke(relative, activator);
    if (activator.client === null) throw new Error("Player fixture has no client");
    expect(activator.client.ps.externalEvent & 0xff).toBe(EntityEvent.EV_GENERAL_SOUND);
    expect(activator.client.ps.externalEventParm).toBe(71);

    const global = spawnTarget(setup, "target_speaker", [
      { key: "noise", value: "sound/test.wav" }, { key: "spawnflags", value: "4" },
    ]);
    invoke(global, activator);
    expect(global.s.event & 0xff).toBe(EntityEvent.EV_GLOBAL_SOUND);
    expect(global.s.eventParm).toBe(71);
  });

  test("target_speaker stores source CVFI results for out-of-range repeat fields", () => {
    const setup = fixture();
    const speaker = spawnTarget(setup, "target_speaker", [
      { key: "noise", value: "sound/world/klaxon" }, { key: "wait", value: "500000000" },
      { key: "random", value: "-500000000" },
    ]);
    expect(speaker.s.frame).toBe(-2_147_483_648);
    expect(speaker.s.clientNum).toBe(-2_147_483_648);
    expect(speaker.r.linked).toBe(true);
  });

  test("target_speaker rejects a missing noise key before registering or linking", () => {
    const setup = fixture();
    expect(() => spawnTarget(setup, "target_speaker", [{ key: "origin", value: "1 2 3" }]))
      .toThrow("target_speaker without a noise key at (1 2 3)");
    expect(setup.effects.some(effect => effect.startsWith("sound-index:"))).toBe(false);
    expect(() => spawnTarget(setup, "target_speaker", [{ key: "origin", value: "5000000000 -5000000000 0" }]))
      .toThrow("target_speaker without a noise key at (-./,),(-*,( -./,),(-*,( 0)");
    setup.effects.length = 0;
    expect(() => spawnTarget(setup, "target_speaker", [{ key: "origin", value: "1000000000 1000000000 1000000000" }]))
      .toThrow("target_speaker without a noise key at (1000000000 1000000000 10000000");
    expect(setup.effects).toEqual(["warn:Com_sprintf: overflow of 34 in 32\n"]);
  });

  test("target_push uses source direction, gating, debounce, and temporary sound event", () => {
    const setup = fixture();
    const activator = player(setup, 0);
    const push = spawnTarget(setup, "target_push", [{ key: "angle", value: "90" }]);
    expect(push.speed).toBe(1_000);
    expect(push.s.origin2.x).toBeCloseTo(0, 4);
    expect(push.s.origin2.y).toBe(1_000);
    expect(Object.is(push.s.origin2.z, -0)).toBe(true);
    expect(setup.effects).toContain("sound-index:sound/misc/windfly.wav");
    invoke(push, activator);
    expect(activator.client?.ps.velocity).toEqual(push.s.origin2);
    expect(activator.flySoundDebounceTime).toBe(2_500);
    const sound = setup.pool.at(push.slot + 1);
    expect(sound.s.eType).toBe(EntityType.ET_EVENTS + EntityEvent.EV_GENERAL_SOUND);
    expect(sound.s.eventParm).toBe(71);

    if (activator.client === null) throw new Error("Player fixture has no client");
    activator.client.ps.velocity = vec3(1, 2, 3);
    activator.client.ps.pmType = MoveType.PM_DEAD;
    invoke(push, activator);
    expect(activator.client.ps.velocity).toEqual(vec3(1, 2, 3));
    activator.client.ps.pmType = MoveType.PM_NORMAL;
    activator.client.ps.powerups.set(Powerup.PW_FLIGHT, 1);
    invoke(push, activator);
    expect(activator.client.ps.velocity).toEqual(vec3(1, 2, 3));
  });

  test("target_push AimAtTarget uses the requested apex and frees missing or level targets", () => {
    const setup = fixture();
    const apex = setup.pool.spawn();
    apex.targetname = "apex";
    apex.s.origin = vec3(300, 400, 100);
    const push = spawnTarget(setup, "target_push", [
      { key: "target", value: "apex" }, { key: "origin", value: "0 0 0" },
      { key: "spawnflags", value: "1" },
    ]);
    expect(push.nextthink).toBe(1_100);
    expect(setup.effects).toContain("sound-index:sound/world/jumppad.wav");
    setup.clock.now = 1_100;
    runThink(push, setup.clock.now);
    expect(push.s.origin2).toEqual(vec3(600, 800, 400));

    const missing = spawnTarget(setup, "target_push", [{ key: "target", value: "missing" }]);
    setup.clock.now = 1_200;
    runThink(missing, setup.clock.now);
    expect(missing.inuse).toBe(false);
    const level = setup.pool.spawn();
    level.targetname = "level";
    level.s.origin = vec3(10, 10, 0);
    const flat = spawnTarget(setup, "target_push", [{ key: "target", value: "level" }]);
    flat.s.origin = vec3(0, 0, 0);
    setup.clock.now = 1_300;
    runThink(flat, setup.clock.now);
    expect(flat.inuse).toBe(false);
  });

  test("target_push saves its spawn bounds and aims from the live shared bounds at think time", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const setup = fixture(product);
      const apex = setup.pool.spawn();
      apex.targetname = "apex";
      apex.s.origin = vec3(310, 420, 130);
      const push = spawnTarget(setup, "target_push", [
        { key: "target", value: "apex" }, { key: "origin", value: "10 20 30" },
      ]);
      expect(push.r.absmin).toEqual(vec3(10, 20, 30));
      expect(push.r.absmax).toEqual(vec3(10, 20, 30));
      expect(push.r.linked).toBe(false);
      expect(setup.world.linkState(push.slot)).toBeUndefined();
      push.s.origin = vec3(100, 200, 300);
      setup.clock.now = 1_100;
      runThink(push, setup.clock.now);
      expect(push.s.origin2).toEqual(vec3(600, 800, 400));

      const shifted = spawnTarget(setup, "target_push", [{ key: "target", value: "apex" }]);
      shifted.r.absmin = vec3(0, 10, 20);
      shifted.r.absmax = vec3(20, 30, 40);
      setup.clock.now = 1_200;
      runThink(shifted, setup.clock.now);
      expect(shifted.s.origin2).toEqual(vec3(600, 800, 400));
      const activator = player(setup, 0);
      invoke(shifted, activator);
      expect(activator.client?.ps.velocity).toEqual(vec3(600, 800, 400));
    }
  });
});

describe("target laser", () => {
  test("target tracking uses the engine square-root syscall and rereads the enemy each frame", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const setup = fixture(product);
      const target = setup.pool.spawn();
      target.targetname = "aim";
      target.s.origin = vec3(1, 2, 0);
      target.r.mins = vec3(-1, -2, -3);
      target.r.maxs = vec3(1, 4, 3);
      const laser = spawnTarget(setup, "target_laser", [
        { key: "target", value: "aim" }, { key: "spawnflags", value: "1" },
      ]);
      setup.clock.now = 1_100;
      runThink(laser, setup.clock.now);
      // VectorNormalize(1, 3, 0), with sqrt(10) rounded by TRAP_SQRT.
      expect(laser.movedir).toEqual(vec3(0.3162277638912201, 0.9486832618713379, 0));
      expect(laser.enemy).toBe(target);
      expect(laser.r.linked).toBe(true);
      target.s.origin = vec3(4, 2, 0);
      setup.clock.now = 1_200;
      runThink(laser, setup.clock.now);
      expect(laser.movedir).toEqual(vec3(0.800000011920929, 0.6000000238418579, 0));
      expect(laser.nextthink).toBe(1_300);
    }
  });

  test("START_ON traces through ServerWorld, damages a nonzero body, links, and toggles off", () => {
    const setup = fixture();
    const victim = player(setup, 1);
    victim.takedamage = true;
    victim.r.contents = 0x2000000;
    victim.r.mins = vec3(-15, -15, -24);
    victim.r.maxs = vec3(15, 15, 32);
    setOrigin(victim, vec3(100, 0, 0));
    setup.pool.options.link(victim);
    const laser = spawnTarget(setup, "target_laser", [
      { key: "spawnflags", value: "1" }, { key: "dmg", value: "5" },
      { key: "origin", value: "0 0 0" }, { key: "angle", value: "0" },
    ]);
    setup.effects.length = 0;
    setup.clock.now = 1_100;
    runThink(laser, setup.clock.now);
    expect(laser.s.eType).toBe(EntityType.ET_BEAM);
    expect(victim.health).toBe(95);
    expect(victim.client?.ps.health).toBe(95);
    expect(laser.s.origin2.x).toBeGreaterThan(80);
    expect(laser.s.origin2.x).toBeLessThan(90);
    expect(laser.nextthink).toBe(1_200);
    expect(setup.world.linkState(laser.slot)?.linked).toBe(true);
    expect(setup.effects.at(-1)).toBe(`link:${laser.slot}`);

    invoke(laser, victim);
    expect(laser.nextthink).toBe(0);
    expect(setup.world.linkState(laser.slot)?.linked).toBe(false);
    expect(setup.effects.at(-1)).toBe(`unlink:${laser.slot}`);
  });

  test("preserves source entityNum-zero damage omission and bad-target startup", () => {
    const setup = fixture();
    const slotZero = player(setup, 0);
    slotZero.takedamage = true;
    slotZero.r.contents = 0x2000000;
    slotZero.r.mins = vec3(-15, -15, -24);
    slotZero.r.maxs = vec3(15, 15, 32);
    setOrigin(slotZero, vec3(100, 0, 0));
    setup.pool.options.link(slotZero);
    const laser = spawnTarget(setup, "target_laser", [
      { key: "spawnflags", value: "1" }, { key: "dmg", value: "50" }, { key: "angle", value: "0" },
    ]);
    setup.clock.now = 1_100;
    runThink(laser, setup.clock.now);
    expect(slotZero.health).toBe(100);

    const bad = spawnTarget(setup, "target_laser", [
      { key: "target", value: "missing" }, { key: "origin", value: "3 4 5" },
    ]);
    setup.clock.now = 1_200;
    runThink(bad, setup.clock.now);
    expect(bad.enemy).toBeNull();
    expect(bad.nextthink).toBe(0);
    expect(setup.effects.some(effect => effect.includes("missing is a bad target"))).toBe(true);
  });
});

describe("target teleporter and kill", () => {
  test("target_teleporter selects a destination and runs the real TeleportPlayer path in both products", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const setup = fixture(product);
      const activator = player(setup, 0);
      if (activator.client === null) throw new Error("Player fixture has no client");
      activator.client.ps.origin = vec3(1, 2, 3);
      setOrigin(activator, activator.client.ps.origin);
      setup.pool.options.link(activator);
      const destination = setup.pool.spawn();
      destination.targetname = "arrival";
      destination.s.origin = vec3(100, 200, 300);
      destination.s.angles = vec3(0, 90, 0);
      const teleporter = spawnTarget(setup, "target_teleporter", [
        { key: "targetname", value: "entry" }, { key: "target", value: "arrival" },
      ]);
      invoke(teleporter, activator);
      expect(activator.client.ps.origin).toEqual(vec3(100, 200, 301));
      expect(activator.client.ps.velocity.x).toBeCloseTo(0, 4);
      expect(activator.client.ps.velocity.y).toBe(400);
      expect(activator.client.ps.pmTime).toBe(160);
      expect(setup.world.linkState(activator.slot)?.linked).toBe(true);
      const out = setup.pool.at(teleporter.slot + 1);
      const incoming = setup.pool.at(teleporter.slot + 2);
      expect(out.s.eType).toBe(EntityType.ET_EVENTS + EntityEvent.EV_PLAYER_TELEPORT_OUT);
      expect(incoming.s.eType).toBe(EntityType.ET_EVENTS + EntityEvent.EV_PLAYER_TELEPORT_IN);
    }
  });

  test("target_teleporter warns for untargeted and missing destination cases", () => {
    const setup = fixture();
    const activator = player(setup, 0);
    const teleporter = spawnTarget(setup, "target_teleporter", [
      { key: "target", value: "missing" }, { key: "origin", value: "7 8 9" },
    ]);
    expect(setup.effects.some(effect => effect.includes("untargeted target_teleporter at (7 8 9)"))).toBe(true);
    invoke(teleporter, activator);
    expect(setup.effects.some(effect => effect.includes("Couldn't find teleporter destination"))).toBe(true);
  });

  test("target_kill routes source telefrag damage through combat", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const setup = fixture(product);
      const activator = player(setup, 0);
      activator.takedamage = true;
      const deaths: string[] = [];
      activator.die = (_self, inflictor, attacker, amount, method) => {
        deaths.push(`${inflictor.slot}:${attacker.slot}:${amount}:${method}`);
      };
      const kill = spawnTarget(setup, "target_kill");
      invoke(kill, activator);
      expect(activator.health).toBe(-999);
      expect(deaths).toEqual([`${ENTITYNUM_WORLD}:${ENTITYNUM_WORLD}:100000:18`]);
    }
  });
});

describe("target location", () => {
  test("first scheduled location links all records in slot order and later thinks are inert", () => {
    const setup = fixture();
    const first = spawnTarget(setup, "target_location", [
      { key: "message", value: "Atrium" }, { key: "origin", value: "1 2 3" },
    ]);
    const second = spawnTarget(setup, "target_location", [{ key: "message", value: "Rail" }]);
    const mixedCase = spawnTarget(setup, "target_location", [{ key: "message", value: "Upper" }]);
    mixedCase.classname = "TARGET_LOCATION";
    expect(first.nextthink).toBe(1_200);
    expect(first.r.currentOrigin).toEqual(vec3(1, 2, 3));
    setup.clock.now = 1_200;
    runThink(first, setup.clock.now);
    expect(setup.effects.filter(effect => effect.startsWith("config:"))).toEqual([
      "config:608:unknown", "config:609:Atrium", "config:610:Rail", "config:611:Upper",
    ]);
    expect(first.health).toBe(1);
    expect(second.health).toBe(2);
    expect(mixedCase.health).toBe(3);
    expect(setup.runtime.locations.head).toBe(mixedCase);
    expect(mixedCase.nextTrain).toBe(second);
    expect(second.nextTrain).toBe(first);
    const count = setup.effects.length;
    runThink(second, setup.clock.now);
    expect(setup.effects.length).toBe(count);
    setup.runtime.locations.reset();
    expect(setup.runtime.locations.linked).toBe(false);
    expect(setup.runtime.locations.head).toBeNull();
  });

  test("the 64th named location continues into CS_PARTICLES in source order", () => {
    const setup = fixture();
    const locations: GameEntity[] = [];
    for (let index = 0; index < 64; index++) {
      locations.push(spawnTarget(setup, "target_location", [{ key: "message", value: `L${index + 1}` }]));
    }
    const first = locations[0];
    const sixtyThird = locations[62];
    const last = locations[63];
    if (first === undefined || sixtyThird === undefined || last === undefined) {
      throw new Error("Location capacity fixture is incomplete");
    }
    setup.effects.length = 0;
    setup.clock.now = 1_200;
    runThink(first, setup.clock.now);
    const configs = setup.effects.filter(effect => effect.startsWith("config:"));
    expect(configs.length).toBe(65);
    expect(configs.at(-1)).toBe("config:672:L64");
    expect(sixtyThird.health).toBe(63);
    expect(last.health).toBe(64);
    expect(last.nextTrain).toBe(sixtyThird);
    expect(setup.runtime.locations.head).toBe(last);
  });
});

test("target handler boundaries reject foreign entities and missing required activators", () => {
  const setup = fixture();
  const handlers = targetSpawnHandlers(setup.runtime);
  expect([...handlers.keys()]).toEqual([
    "target_give", "target_remove_powerups", "target_delay", "target_score", "target_print",
    "target_speaker", "target_laser", "target_teleporter", "target_relay", "target_position",
    "target_push", "target_kill", "target_location",
  ]);
  const giveHandler = handlers.get("target_give");
  if (giveHandler === undefined) throw new Error("target_give handler missing");
  expect(() => giveHandler(new GameEntity(64), new SpawnVariables([]))).toThrow("does not belong");
  const print = spawnTarget(setup, "target_print");
  expect(() => invoke(print, null)).toThrow("requires an activator");
  const foreign = fixture();
  expect(() => targetSpawnHandlers({ ...setup.runtime, itemLifecycle: foreign.runtime.itemLifecycle }))
    .toThrow("does not match");
});

const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const baseRetailPak = `${retailRoot}/baseq3/pak0.pk3`;
const missionpackRetailPak = `${retailRoot}/missionpack/pak0.pk3`;
test.skipIf(!(await Bun.file(baseRetailPak).exists()) || !(await Bun.file(missionpackRetailPak).exists()))(
  "spawns shipped speaker, position, and location records for both products",
  async () => {
    for (const scenario of [
      { product: "baseq3", archive: baseRetailPak, map: "maps/q3ctf1.bsp" },
      { product: "missionpack", archive: missionpackRetailPak, map: "maps/mpq3ctf1.bsp" },
    ] satisfies readonly { product: Product; archive: string; map: string }[]) {
      using archive = await Pk3Archive.open(scenario.archive);
      const map = parseBsp(await archive.read(scenario.map), scenario.map);
      const setup = fixture(scenario.product, GameType.GT_CTF);
      for (const classname of ["target_speaker", "target_position", "target_location"]) {
        const record = map.entityRecords.find(candidate => candidate.get("classname") === classname);
        if (record === undefined) throw new Error(`${scenario.map} lacks ${classname}`);
        const variables = new SpawnVariables([...record].map(([key, value]) => ({ key, value })));
        const outcome = spawnEntity(variables, { pool: setup.pool, memory: setup.memory, product: setup.product,
          gameType: setup.gameType, handlers: targetSpawnHandlers(setup.runtime),
          spawnItem: () => { throw new Error("Unexpected retail item spawn"); }, warn: setup.runtime.warn });
        expect(outcome.kind).toBe("dispatched");
      }
      expect(setup.effects).toContain("sound-index:sound/world/firesoft.wav");
    }
  },
);
