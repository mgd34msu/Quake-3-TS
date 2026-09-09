import { describe, expect, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { Pk3Archive } from "../src/assets/pk3.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import type { Bounds } from "../src/core/math.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { EntityPool, initGameEntity, runThink, setOrigin } from "../src/game/entities.ts";
import { gameAtoi } from "../src/game/numeric.ts";
import { GameMemory } from "../src/game/memory.ts";
import { spawnEntity, SpawnVariables } from "../src/game/spawn.ts";
import type { SpawnPair } from "../src/game/spawn.ts";
import { GameEntity, GameFlags } from "../src/game/state.ts";
import { triggerSpawnHandlers } from "../src/game/triggers.ts";
import type { TriggerHost } from "../src/game/triggers.ts";
import { EntityEvent, EntityType, GameType, MoveType, Powerup, Team } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ServerEntityFlags } from "../src/shared/entity-shared.ts";
import { ENTITYNUM_WORLD } from "../src/shared/player-state.ts";
import { ServerWorld } from "../src/server/world.ts";

const worldBounds: Bounds = { min: vec3(-4_096, -4_096, -4_096), max: vec3(4_096, 4_096, 4_096) };

function triggerMap(): BspMap {
  const box = { min: vec3(-16, -16, 0), max: vec3(16, 16, 16) };
  const planes = [
    { normal: vec3(-1, 0, 0), distance: -box.min.x }, { normal: vec3(1, 0, 0), distance: box.max.x },
    { normal: vec3(0, -1, 0), distance: -box.min.y }, { normal: vec3(0, 1, 0), distance: box.max.y },
    { normal: vec3(0, 0, -1), distance: -box.min.z }, { normal: vec3(0, 0, 1), distance: box.max.z },
  ];
  return { entities: "", entityRecords: [], shaders: [{ name: "trigger", contentFlags: 1, surfaceFlags: 0 }],
    planes, nodes: [], leaves: [{ cluster: 0, area: 0, bounds: worldBounds, firstSurface: 0,
      surfaceCount: 0, firstBrush: 0, brushCount: 0 }], leafSurfaces: [], leafBrushes: [],
    models: [{ bounds: worldBounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 },
      { bounds: box, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }],
    brushSides: planes.map((_, plane) => ({ plane, shader: 0 })), vertices: [], indices: [],
    fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}

function fixture(product: Product = "baseq3", map = triggerMap()) {
  const clock = { now: 1_000 }, random = { integer: 0, centered: 0 }, effects: string[] = [];
  const memory = new GameMemory(() => 0, text => { effects.push(text); });
  let activeWorld: ServerWorld | null = null;
  const currentWorld = (): ServerWorld => {
    if (activeWorld === null) throw new Error("Trigger fixture world is unavailable");
    return activeWorld;
  };
  const pool = new EntityPool({ print: text => { effects.push(`warn:${text}`); }, product, maxClients: 3, mapStartTime: 0, time: () => clock.now,
    link: entity => { currentWorld().link(entity); effects.push(`link:${entity.slot}`); },
    unlink: entity => { currentWorld().unlink(entity.slot); effects.push(`unlink:${entity.slot}`); } });
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const worldPrints: string[] = [];
  activeWorld = new ServerWorld(collision, collision.modelBounds(0), number => pool.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  pool.at(ENTITYNUM_WORLD).s.number = ENTITYNUM_WORLD;
  const combat = (): CombatContext => {
    const common = { time: clock.now, intermissionQueued: 0, gameType: GameType.GT_FFA,
      friendlyFire: false, knockback: 1_000, entities: pool, world: currentWorld(), debugDamage: null,
      checkHurtCarrier: () => {}, logAccuracyHit: () => false };
    return product === "baseq3" ? { ...common, product: "baseq3" }
      : { ...common, product: "missionpack", checkObeliskAttack: () => false,
        invulnerabilityEffect: () => {} };
  };
  const host: TriggerHost = {
    entities: pool, world: currentWorld(), combat, gravity: () => 800,
    random: { rand: () => random.integer, crandom: () => Math.fround(random.centered) },
    setBrushModel: (entity, name) => {
      if (name === null || !name.startsWith("*")) throw new Error("SV_SetBrushModel requires an inline model");
      const index = gameAtoi(name.slice(1));
      const bounds = collision.modelBounds(index);
      entity.s.modelindex = index;
      entity.r.mins = bounds.min;
      entity.r.maxs = bounds.max;
      entity.r.model = { kind: "inline", index };
      entity.r.contents = -1;
      currentWorld().link(entity);
      effects.push(`brush:${entity.slot}:${index}`);
    },
    soundIndex: path => { effects.push(`sound:${path}`); return 71; },
    remapShader: (oldName, newName, time) => { effects.push(`remap:${oldName}:${newName}:${time}`); },
    warn: message => { effects.push(`warn:${message}`); },
  };
  const handlers = triggerSpawnHandlers(host);
  function spawn(classname: string, entries: readonly SpawnPair[] = []): GameEntity {
    const outcome = spawnEntity(new SpawnVariables([{ key: "classname", value: classname }, ...entries]), {
      pool, memory, product, gameType: GameType.GT_FFA, handlers,
      spawnItem: () => { throw new Error("Unexpected trigger fixture item"); }, warn: host.warn,
    });
    if (outcome.kind !== "dispatched") throw new Error(`Trigger fixture spawn failed: ${outcome.kind}`);
    return outcome.entity;
  }
  function player(slot = 0, team = Team.TEAM_FREE): GameEntity {
    const entity = pool.at(slot);
    initGameEntity(entity);
    if (entity.client === null) throw new Error("Trigger fixture player has no client");
    entity.client.ps.pmType = MoveType.PM_NORMAL;
    entity.client.ps.health = 100;
    entity.client.sess.sessionTeam = team;
    entity.health = 100;
    entity.s.eType = EntityType.ET_PLAYER;
    entity.takedamage = true;
    entity.r.contents = 0x2000000;
    entity.r.mins = vec3(-15, -15, -24);
    entity.r.maxs = vec3(15, 15, 32);
    setOrigin(entity, vec3(200, 200, 200));
    entity.client.ps.origin = vec3(200, 200, 200);
    currentWorld().link(entity);
    return entity;
  }
  function receiver(targetname: string): GameEntity {
    const entity = pool.spawn();
    entity.targetname = targetname;
    entity.use = (_self, other, activator) => { effects.push(`used:${other?.slot}:${activator?.slot}`); };
    return entity;
  }
  function touch(entity: GameEntity, other: GameEntity): void {
    const callback = entity.touch;
    if (callback === null) throw new Error("Trigger fixture entity has no touch callback");
    callback(entity, other, { fraction: 1, end: other.r.currentOrigin, solidity: "clear",
      contact: { kind: "none" }, contents: 0, surfaceFlags: 0, entityNum: ENTITYNUM_WORLD });
  }
  function use(entity: GameEntity, activator: GameEntity | null): void {
    const callback = entity.use;
    if (callback === null) throw new Error("Trigger fixture entity has no use callback");
    callback(entity, null, activator);
  }
  return { clock, random, effects, pool, memory, world: currentWorld(), host, handlers, spawn, player, receiver, touch, use };
}

describe("trigger_multiple and trigger_always", () => {
  test("trigger_multiple initializes its brush, team-gates, debounces, and rearms", () => {
    const setup = fixture();
    const receiver = setup.receiver("after");
    const trigger = setup.spawn("trigger_multiple", [
      { key: "model", value: "*1" }, { key: "angle", value: "90" }, { key: "target", value: "after" },
      { key: "wait", value: "0.5" }, { key: "random", value: "0.25" }, { key: "spawnflags", value: "1" },
    ]);
    expect(trigger.r.contents).toBe(0x40000000);
    expect(trigger.r.svFlags).toBe(ServerEntityFlags.NOCLIENT);
    expect(trigger.movedir.x).toBeCloseTo(0, 5);
    expect(trigger.movedir.y).toBe(1);
    expect(trigger.s.angles).toEqual(vec3(0, 0, 0));
    expect(setup.world.linkState(trigger.slot)?.linked).toBe(true);
    expect(setup.world.entityContact({ min: vec3(-1, -1, 1), max: vec3(1, 1, 2) }, trigger)).toBe(true);

    const blue = setup.player(0, Team.TEAM_BLUE);
    setup.touch(trigger, blue);
    expect(trigger.activator).toBe(blue);
    expect(setup.effects).not.toContain(`used:${trigger.slot}:0`);
    const red = setup.player(1, Team.TEAM_RED);
    setup.random.centered = 1;
    setup.touch(trigger, red);
    expect(setup.effects).toContain(`used:${trigger.slot}:1`);
    expect(trigger.nextthink).toBe(1_750);
    setup.touch(trigger, blue);
    expect(trigger.activator).toBe(blue);
    expect(setup.effects.filter(value => value.startsWith("used:")).length).toBe(1);
    setup.use(trigger, null);
    expect(trigger.activator).toBeNull();
    expect(trigger.nextthink).toBe(1_750);
    setup.clock.now = 1_750;
    runThink(trigger, setup.clock.now);
    expect(trigger.nextthink).toBe(0);
    setup.touch(trigger, red);
    expect(setup.effects.filter(value => value.startsWith("used:")).length).toBe(2);
    expect(receiver.inuse).toBe(true);
  });

  test("trigger_multiple preserves the source random clamp and deferred one-shot free", () => {
    const setup = fixture();
    setup.receiver("once");
    const clamped = setup.spawn("trigger_multiple", [
      { key: "model", value: "*1" }, { key: "wait", value: "0.5" }, { key: "random", value: "0.5" },
    ]);
    expect(clamped.random).toBe(-99.5);
    expect(setup.effects).toContain("warn:trigger_multiple has random >= wait\n");
    const once = setup.spawn("trigger_multiple", [
      { key: "model", value: "*1" }, { key: "wait", value: "-1" }, { key: "target", value: "once" },
    ]);
    const activator = setup.player();
    setup.touch(once, activator);
    expect(once.touch).toBeNull();
    expect(once.nextthink).toBe(1_100);
    expect(once.inuse).toBe(true);
    setup.clock.now = 1_100;
    runThink(once, setup.clock.now);
    expect(once.inuse).toBe(false);
  });

  test("trigger_always dispatches with itself after 300ms and then frees", () => {
    const setup = fixture();
    setup.receiver("startup");
    const trigger = setup.spawn("trigger_always", [{ key: "target", value: "startup" }]);
    expect(trigger.nextthink).toBe(1_300);
    setup.clock.now = 1_300;
    runThink(trigger, setup.clock.now);
    expect(setup.effects).toContain(`used:${trigger.slot}:${trigger.slot}`);
    expect(trigger.inuse).toBe(false);
  });
});

describe("trigger_push and trigger_teleport", () => {
  test("trigger_push aims from real linked brush bounds and applies BG_TouchJumpPad once per pad", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const setup = fixture(product);
      const apex = setup.pool.spawn();
      apex.targetname = "apex";
      apex.s.origin = vec3(300, 400, 108);
      const trigger = setup.spawn("trigger_push", [
        { key: "model", value: "*1" }, { key: "target", value: "apex" },
      ]);
      expect(trigger.s.eType).toBe(EntityType.ET_PUSH_TRIGGER);
      expect(trigger.r.svFlags & ServerEntityFlags.NOCLIENT).toBe(0);
      expect(setup.effects).toContain("sound:sound/world/jumppad.wav");
      setup.clock.now = 1_100;
      runThink(trigger, setup.clock.now);
      expect(trigger.s.origin2).toEqual(vec3(600, 800, 400));

      const player = setup.player();
      if (player.client === null) throw new Error("Trigger fixture player has no client");
      player.client.ps.pmoveFramecount = 9;
      setup.touch(trigger, player);
      expect(player.client.ps.velocity).toEqual(vec3(600, 800, 400));
      expect(player.client.ps.events.get(0)).toBe(EntityEvent.EV_JUMP_PAD);
      expect(player.client.ps.eventParms.get(0)).toBe(0);
      expect(player.client.ps.jumppadEnt).toBe(trigger.s.number);
      expect(player.client.ps.jumppadFrame).toBe(9);
      setup.touch(trigger, player);
      expect(player.client.ps.eventSequence).toBe(1);
      const vertical = setup.spawn("trigger_push", [
        { key: "model", value: "*1" }, { key: "target", value: "apex" },
      ]);
      vertical.s.origin2 = vec3(0, 0, 1_000);
      setup.touch(vertical, player);
      expect(player.client.ps.eventParms.get(1)).toBe(1);
      player.client.ps.powerups.set(Powerup.PW_FLIGHT, 1);
      vertical.s.origin2 = vec3(1, 2, 3);
      setup.touch(vertical, player);
      expect(player.client.ps.velocity).toEqual(vec3(0, 0, 1_000));
    }
  });

  test("trigger_push frees itself when its apex is missing", () => {
    const setup = fixture();
    const trigger = setup.spawn("trigger_push", [
      { key: "model", value: "*1" }, { key: "target", value: "missing" },
    ]);
    setup.clock.now = 1_100;
    runThink(trigger, setup.clock.now);
    expect(trigger.inuse).toBe(false);
    expect(setup.effects.some(value => value.includes("target missing not found"))).toBe(true);
  });

  test("trigger_push uses the engine square-root syscall for a non-square flight time", () => {
    const setup = fixture();
    const apex = setup.pool.spawn();
    apex.targetname = "apex";
    apex.s.origin = vec3(1, 3, 15);
    const trigger = setup.spawn("trigger_push", [
      { key: "model", value: "*1" }, { key: "target", value: "apex" },
    ]);
    setup.clock.now = 1_100;
    runThink(trigger, setup.clock.now);
    // g_syscalls.asm sqrt -> TRAP_SQRT; flight time is float32(sqrt(float32(7 / 400))).
    expect(trigger.s.origin2).toEqual(vec3(7.559289932250977, 22.677867889404297, 105.83004760742188));
  });

  test("trigger_push retains source non-finite velocity for an apex below its center", () => {
    const setup = fixture();
    const apex = setup.pool.spawn();
    apex.targetname = "apex";
    apex.s.origin = vec3(1, 3, 7);
    const trigger = setup.spawn("trigger_push", [
      { key: "model", value: "*1" }, { key: "target", value: "apex" },
    ]);
    setup.clock.now = 1_100;
    runThink(trigger, setup.clock.now);
    expect(trigger.inuse).toBe(true);
    expect(trigger.s.origin2.x).toBeNaN();
    expect(trigger.s.origin2.y).toBeNaN();
    expect(trigger.s.origin2.z).toBeNaN();
  });

  test("trigger_teleport enforces dead and spectator gates before real teleportation", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const setup = fixture(product);
      const destination = setup.pool.spawn();
      destination.targetname = "arrival";
      destination.s.origin = vec3(100, 200, 300);
      destination.s.angles = vec3(0, 90, 0);
      const ordinary = setup.spawn("trigger_teleport", [
        { key: "model", value: "*1" }, { key: "target", value: "arrival" },
      ]);
      expect(ordinary.s.eType).toBe(EntityType.ET_TELEPORT_TRIGGER);
      expect(ordinary.r.svFlags & ServerEntityFlags.NOCLIENT).toBe(0);
      const player = setup.player();
      if (player.client === null) throw new Error("Trigger fixture player has no client");
      player.client.ps.pmType = MoveType.PM_DEAD;
      setup.touch(ordinary, player);
      expect(player.client.ps.origin).toEqual(vec3(200, 200, 200));
      player.client.ps.pmType = MoveType.PM_NORMAL;
      setup.touch(ordinary, player);
      expect(player.client.ps.origin).toEqual(vec3(100, 200, 301));

      const spectatorOnly = setup.spawn("trigger_teleport", [
        { key: "model", value: "*1" }, { key: "target", value: "arrival" }, { key: "spawnflags", value: "1" },
      ]);
      expect(spectatorOnly.r.svFlags & ServerEntityFlags.NOCLIENT).toBe(ServerEntityFlags.NOCLIENT);
      player.client.ps.origin = vec3(1, 2, 3);
      player.client.sess.sessionTeam = Team.TEAM_FREE;
      setup.touch(spectatorOnly, player);
      expect(player.client.ps.origin).toEqual(vec3(1, 2, 3));
      player.client.sess.sessionTeam = Team.TEAM_SPECTATOR;
      setup.touch(spectatorOnly, player);
      expect(player.client.ps.origin).toEqual(vec3(100, 200, 301));
    }
  });
});

describe("trigger_hurt and func_timer", () => {
  test("trigger_hurt preserves cadence, sound, damage flags, and source link toggling", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const setup = fixture(product);
      const hurt = setup.spawn("trigger_hurt", [{ key: "model", value: "*1" }, { key: "spawnflags", value: "2" }]);
      expect(hurt.damage).toBe(5);
      expect(setup.world.linkState(hurt.slot)?.linked).toBe(true);
      const player = setup.player();
      setup.touch(hurt, player);
      expect(player.health).toBe(95);
      expect(player.client?.lastHurtMod).toBe(22);
      expect(hurt.timestamp).toBe(1_100);
      const sound = setup.pool.at(hurt.slot + 1);
      expect(sound.s.eType).toBe(EntityType.ET_EVENTS + EntityEvent.EV_GENERAL_SOUND);
      expect(sound.s.eventParm).toBe(71);
      setup.touch(hurt, player);
      expect(player.health).toBe(95);
      setup.clock.now = 1_100;
      setup.touch(hurt, player);
      expect(player.health).toBe(90);
      setup.use(hurt, player);
      expect(setup.world.linkState(hurt.slot)?.linked).toBe(false);
      setup.use(hurt, player);
      expect(setup.world.linkState(hurt.slot)?.linked).toBe(true);

      const sourceStartOff = setup.spawn("trigger_hurt", [
        { key: "model", value: "*1" }, { key: "spawnflags", value: "1" },
      ]);
      // SV_SetBrushModel links immediately; g_trigger.c does not undo that link for START_OFF.
      expect(setup.world.linkState(sourceStartOff.slot)?.linked).toBe(true);
      const unprotected = setup.spawn("trigger_hurt", [
        { key: "model", value: "*1" }, { key: "spawnflags", value: "28" }, { key: "dmg", value: "7" },
      ]);
      player.flags |= GameFlags.GODMODE;
      const entitiesBefore = setup.pool.numEntities;
      setup.touch(unprotected, player);
      expect(player.health).toBe(83);
      expect(unprotected.timestamp).toBe(2_100);
      expect(setup.pool.numEntities).toBe(entitiesBefore);
    }
  });

  test("func_timer starts, stops, fires immediately, and uses inclusive crandom scheduling", () => {
    const setup = fixture();
    setup.receiver("pulse");
    setup.random.centered = 1;
    const timer = setup.spawn("func_timer", [
      { key: "spawnflags", value: "1" }, { key: "wait", value: "5" },
      { key: "random", value: "1" }, { key: "target", value: "pulse" },
    ]);
    expect(timer.r.svFlags).toBe(ServerEntityFlags.NOCLIENT);
    expect(timer.activator).toBe(timer);
    expect(timer.nextthink).toBe(1_100);
    setup.clock.now = 1_100;
    runThink(timer, setup.clock.now);
    expect(setup.effects).toContain(`used:${timer.slot}:${timer.slot}`);
    expect(timer.nextthink).toBe(7_100);
    const activator = setup.player();
    setup.use(timer, activator);
    expect(timer.activator).toBe(activator);
    expect(timer.nextthink).toBe(0);
    setup.use(timer, activator);
    expect(setup.effects.at(-1)).toBe(`used:${timer.slot}:0`);
    expect(timer.nextthink).toBe(7_100);

    const clamped = setup.spawn("func_timer", [{ key: "origin", value: "1 2 3" }]);
    expect(clamped.random).toBe(-99);
    expect(setup.effects).toContain("warn:func_timer at (1 2 3) has random >= wait\n");
    setup.spawn("func_timer", [{ key: "origin", value: "5000000000 -5000000000 0" }]);
    expect(setup.effects.at(-1)).toBe("warn:func_timer at (-./,),(-*,( -./,),(-*,( 0) has random >= wait\n");
    setup.spawn("func_timer", [{ key: "origin", value: "1000000000 1000000000 1000000000" }]);
    expect(setup.effects.slice(-2)).toEqual([
      "warn:Com_sprintf: overflow of 34 in 32\n",
      "warn:func_timer at (1000000000 1000000000 10000000 has random >= wait\n",
    ]);
    setup.effects.length = 0;
    setup.spawn("func_timer", [{ key: "origin", value: "1000000000 1000000000 1000000" }]);
    expect(setup.effects).toEqual(["warn:func_timer at (1000000000 1000000000 1000000) has random >= wait\n"]);
    setup.effects.length = 0;
    setup.spawn("func_timer", [{ key: "origin", value: "1000000000 1000000000 10000000" }]);
    expect(setup.effects).toEqual([
      "warn:Com_sprintf: overflow of 32 in 32\n",
      "warn:func_timer at (1000000000 1000000000 10000000 has random >= wait\n",
    ]);
  });
  test("func_timer schedules from its reused entity slot after target callbacks return", () => {
    const setup = fixture();
    const receiver = setup.receiver("pulse");
    const timer = setup.spawn("func_timer", [
      { key: "wait", value: "5" }, { key: "random", value: "0" }, { key: "target", value: "pulse" },
    ]);
    receiver.use = (_self, other) => {
      expect(other).toBe(timer);
      setup.pool.free(timer);
      const replacement = setup.pool.spawn();
      expect(replacement).toBe(timer);
      replacement.wait = 2;
      replacement.random = 0.5;
      replacement.nextthink = 100_000;
    };
    setup.random.centered = 1;
    setup.use(timer, null);
    expect(timer.inuse).toBe(true);
    expect(timer.nextthink).toBe(3_500);
    expect(timer.think).toBeNull();
    expect(timer.activator).toBeNull();
  });
});

test("trigger handler boundaries expose exactly the source classes", () => {
  const setup = fixture();
  expect([...setup.handlers.keys()]).toEqual([
    "trigger_multiple", "trigger_always", "trigger_push", "trigger_teleport", "trigger_hurt", "func_timer",
  ]);
  const handler = setup.handlers.get("trigger_multiple");
  if (handler === undefined) throw new Error("trigger_multiple handler missing");
  expect(() => handler(new GameEntity(64), new SpawnVariables([]))).toThrow("does not belong");
  const trigger = setup.spawn("trigger_multiple", [{ key: "model", value: "*1" }]);
  expect(() => setup.use(trigger, null)).toThrow("requires an activator");
  const staleHost: TriggerHost = { ...setup.host, combat: () => ({ ...setup.host.combat(), time: 999 }) };
  const stale = triggerSpawnHandlers(staleHost).get("trigger_hurt");
  if (stale === undefined) throw new Error("trigger_hurt handler missing");
  const hurt = setup.pool.spawn();
  hurt.model = "*1";
  stale(hurt, new SpawnVariables([]));
  const player = setup.player();
  expect(() => setup.touch(hurt, player)).toThrow("stale game time");
});

const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const baseRetailPak = `${retailRoot}/baseq3/pak0.pk3`;
const missionpackRetailPak = `${retailRoot}/missionpack/pak0.pk3`;

test.skipIf(!(await Bun.file(baseRetailPak).exists()) || !(await Bun.file(missionpackRetailPak).exists()))(
  "spawns every shipped trigger class from both retail products with real BSP brush models",
  async () => {
    for (const scenario of [
      { product: "baseq3", archive: baseRetailPak, records: [
        ["maps/q3ctf1.bsp", "trigger_push"], ["maps/q3ctf2.bsp", "func_timer"],
        ["maps/q3ctf3.bsp", "trigger_multiple"], ["maps/q3ctf3.bsp", "trigger_hurt"],
        ["maps/q3ctf4.bsp", "trigger_teleport"], ["maps/q3dm10.bsp", "trigger_always"],
      ] },
      { product: "missionpack", archive: missionpackRetailPak, records: [
        ["maps/mpq3ctf1.bsp", "trigger_push"], ["maps/mpq3ctf2.bsp", "func_timer"],
        ["maps/mpq3ctf3.bsp", "trigger_multiple"], ["maps/mpq3ctf3.bsp", "trigger_hurt"],
        ["maps/mpq3ctf4.bsp", "trigger_teleport"], ["maps/mpteam2.bsp", "trigger_always"],
      ] },
    ] satisfies readonly { product: Product; archive: string; records: readonly (readonly [string, string])[] }[]) {
      using archive = await Pk3Archive.open(scenario.archive);
      for (const [path, classname] of scenario.records) {
        const map = parseBsp(await archive.read(path), path);
        const record = map.entityRecords.find(candidate => candidate.get("classname") === classname);
        if (record === undefined) throw new Error(`${path} lacks ${classname}`);
        const setup = fixture(scenario.product, map);
        const outcome = spawnEntity(new SpawnVariables([...record].map(([key, value]) => ({ key, value }))), {
          pool: setup.pool, memory: setup.memory, product: scenario.product, gameType: GameType.GT_CTF,
          handlers: setup.handlers, spawnItem: () => { throw new Error("Unexpected retail item"); }, warn: setup.host.warn,
        });
        expect(outcome.kind).toBe("dispatched");
        if (outcome.kind === "dispatched" && outcome.entity.model !== null) {
          expect(setup.world.linkState(outcome.slot)?.linked).toBe(true);
        }
      }
    }
  },
);
