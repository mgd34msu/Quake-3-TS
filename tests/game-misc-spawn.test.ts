import { describe, expect, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { Pk3Archive } from "../src/assets/pk3.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import type { Bounds } from "../src/core/math.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { EntityPool, runThink } from "../src/game/entities.ts";
import { ItemRegistry } from "../src/game/item-lifecycle.ts";
import { GameMemory } from "../src/game/memory.ts";
import { miscSpawnHandlers } from "../src/game/misc-spawn.ts";
import type { MiscSpawnHost } from "../src/game/misc-spawn.ts";
import { MissileRuntime } from "../src/game/missile.ts";
import type { MissileHost, MissionpackMissileServices } from "../src/game/missile.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { SpawnVariables, spawnEntity } from "../src/game/spawn.ts";
import type { SpawnPair } from "../src/game/spawn.ts";
import type { GameEntity } from "../src/game/state.ts";
import { ServerWorld } from "../src/server/world.ts";
import { EntityEvent, EntityType, GameType, Weapon } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { findItemForWeapon } from "../src/shared/items.ts";
import { ENTITYNUM_WORLD } from "../src/shared/player-state.ts";

const bounds: Bounds = { min: vec3(-2_048, -2_048, -2_048), max: vec3(2_048, 2_048, 2_048) };

function emptyMap(): BspMap {
  return { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}

function wallMap(): BspMap {
  const map = emptyMap();
  const planes = [
    { normal: vec3(1, 0, 0), distance: 110 }, { normal: vec3(-1, 0, 0), distance: -100 },
    { normal: vec3(0, 1, 0), distance: 1_000 }, { normal: vec3(0, -1, 0), distance: 1_000 },
    { normal: vec3(0, 0, 1), distance: 1_000 }, { normal: vec3(0, 0, -1), distance: 1_000 },
  ];
  return { ...map, shaders: [{ name: "wall", surfaceFlags: 0, contentFlags: 1 }], planes,
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    leafBrushes: [0], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }],
    brushSides: planes.map((_plane, plane) => ({ plane, shader: 0 })) };
}

function fixture(product: Product = "baseq3", map = emptyMap()) {
  const clock = { now: 1_000, previous: 900 };
  const values = { integer: 0, centered: 0 };
  const warnings: string[] = [];
  const memory = new GameMemory(() => 0, text => { warnings.push(text); });
  let activeWorld: ServerWorld | null = null;
  const world = (): ServerWorld => {
    if (activeWorld === null) throw new Error("Misc spawn fixture world is unavailable");
    return activeWorld;
  };
  const pool = new EntityPool({ print: text => { worldPrints.push(text); }, product, maxClients: 1, mapStartTime: 0, time: () => clock.now,
    link: entity => { world().link(entity); }, unlink: entity => { world().unlink(entity.slot); } });
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const worldPrints: string[] = [];
  activeWorld = new ServerWorld(collision, collision.modelBounds(0), number => pool.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  pool.at(ENTITYNUM_WORLD).s.number = ENTITYNUM_WORLD;
  const common = { get time() { return clock.now; }, intermissionQueued: 0, gameType: GameType.GT_FFA,
    friendlyFire: false, knockback: 1_000, entities: pool, world: world(), debugDamage: null,
    checkHurtCarrier: () => {}, logAccuracyHit: () => false };
  const baseCombat: Extract<CombatContext, { product: "baseq3" }> = { ...common, product: "baseq3",
    get time() { return clock.now; } };
  const missionCombat: Extract<CombatContext, { product: "missionpack" }> = { ...common, product: "missionpack",
    get time() { return clock.now; }, checkObeliskAttack: () => false, invulnerabilityEffect: () => {} };
  const missionServices: MissionpackMissileServices = { proxMineTimeout: 30_000, random: new GameRandom(1),
    soundIndex: () => 1, invulnerabilityImpact: () => ({ kind: "miss" }) };
  const missileHost: MissileHost = product === "baseq3"
    ? { combat: baseCombat, world: world(), get previousTime() { return clock.previous; }, missionpack: null }
    : { combat: missionCombat, world: world(), get previousTime() { return clock.previous; }, missionpack: missionServices };
  const missiles = new MissileRuntime(missileHost);
  const itemRegistry = new ItemRegistry(product);
  itemRegistry.clear(GameType.GT_FFA);
  const host: MiscSpawnHost = { missiles, itemRegistry,
    random: { rand: () => values.integer, crandom: () => values.centered },
    warn: message => { warnings.push(message); } };
  const handlers = miscSpawnHandlers(host);
  return { clock, values, warnings, pool, memory, world: world(), missiles, itemRegistry, host, handlers, product };
}

function spawn(setup: ReturnType<typeof fixture>, classname: string,
  entries: readonly SpawnPair[] = []): GameEntity {
  const outcome = spawnEntity(new SpawnVariables([{ key: "classname", value: classname }, ...entries]), {
    pool: setup.pool, memory: setup.memory, product: setup.product, gameType: GameType.GT_FFA, handlers: setup.handlers,
    spawnItem: () => { throw new Error("Unexpected misc item spawn"); }, warn: setup.host.warn,
  });
  if (outcome.kind !== "dispatched") throw new Error(`Misc spawn failed: ${outcome.kind}`);
  return outcome.entity;
}

function use(entity: GameEntity): void {
  if (entity.use === null) throw new Error("Shooter has no use callback");
  entity.use(entity, null, null);
}

describe("g_misc spawn wrappers", () => {
  test("publishes exactly the eleven concrete remaining source routes", () => {
    expect([...fixture().handlers.keys()]).toEqual([
      "info_camp", "info_null", "info_notnull", "light", "misc_teleporter_dest", "misc_model",
      "misc_portal_surface", "misc_portal_camera", "shooter_rocket", "shooter_plasma", "shooter_grenade",
    ]);
  });

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product} marker, freeing and intentional empty handlers preserve their source state`, () => {
      const setup = fixture(product);
      const camp = spawn(setup, "info_camp", [{ key: "origin", value: "1.75 -2.5 3" }]);
      const notnull = spawn(setup, "info_notnull", [{ key: "origin", value: "4 5 6" }]);
      expect(camp.s.pos.base).toEqual(vec3(1.75, -2.5, 3));
      expect(camp.r.currentOrigin).toEqual(camp.s.pos.base);
      expect(notnull.s.pos.base).toEqual(vec3(4, 5, 6));
      for (const classname of ["info_null", "light", "misc_model"]) {
        const freed = spawn(setup, classname);
        expect(freed.inuse).toBe(false);
        expect(freed.classname).toBe("freed");
      }
      const destination = spawn(setup, "misc_teleporter_dest", [{ key: "origin", value: "7 8 9" }]);
      expect(destination.inuse).toBe(true);
      expect(destination.s.pos.base).toEqual(vec3(7, 8, 9));
      expect(setup.world.linkState(destination.slot)).toBeUndefined();
    });
  }

  test("portal wrappers call the real surface and camera implementations", () => {
    const setup = fixture();
    const surface = spawn(setup, "misc_portal_surface", [{ key: "origin", value: "1 2 3" }]);
    expect(surface.s.eType).toBe(EntityType.ET_PORTAL);
    expect(surface.s.origin2).toEqual(vec3(1, 2, 3));
    expect(setup.world.linkState(surface.slot)?.linked).toBe(true);
    const camera = spawn(setup, "misc_portal_camera", [{ key: "roll", value: "90" }]);
    expect(camera.s.clientNum).toBe(64);
    expect(camera.r.mins).toEqual(vec3(0, 0, 0));
    expect(setup.world.linkState(camera.slot)?.linked).toBe(true);
  });
});

describe("g_misc shooters", () => {
  test("all source shooter classes register weapons, convert angles and fire actual missiles", () => {
    const cases = [
      ["shooter_rocket", Weapon.WP_ROCKET_LAUNCHER, "rocket"],
      ["shooter_plasma", Weapon.WP_PLASMAGUN, "plasma"],
      ["shooter_grenade", Weapon.WP_GRENADE_LAUNCHER, "grenade"],
    ] satisfies readonly (readonly [string, Weapon, string])[];
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      for (const [classname, weapon, projectileName] of cases) {
        const setup = fixture(product);
        const shooter = spawn(setup, classname, [
          { key: "origin", value: "0 0 100" }, { key: "angles", value: "0 0 0" },
        ]);
        expect(shooter.s.weapon).toBe(weapon);
        expect(shooter.movedir.x).toBe(1);
        expect(shooter.movedir.y).toBe(0);
        expect(shooter.movedir.z).toBe(-0);
        expect(shooter.s.angles).toEqual(vec3(0, 0, 0));
        expect(shooter.random).toBe(Math.fround(Math.sin(Math.fround(Math.fround(Math.fround(Math.PI) * 1) / 180))));
        expect(setup.itemRegistry.isRegistered(findItemForWeapon(product, weapon))).toBe(true);
        expect(setup.world.linkState(shooter.slot)?.linked).toBe(true);
        use(shooter);
        const projectile = setup.pool.at(shooter.slot + 1);
        expect(projectile.classname).toBe(projectileName);
        expect(projectile.s.pos.delta.x).toBeGreaterThan(0);
        expect(shooter.s.event & 255).toBe(EntityEvent.EV_FIRE_WEAPON);
      }
    }
  });

  test("deferred targets use their live linked origin and inclusive crandom endpoints", () => {
    const setup = fixture();
    const target = setup.pool.spawn();
    target.targetname = "aim";
    target.r.currentOrigin = vec3(100, 0, 100);
    const shooter = spawn(setup, "shooter_rocket", [
      { key: "origin", value: "0 0 100" }, { key: "target", value: "aim" }, { key: "random", value: "90" },
    ]);
    expect(shooter.nextthink).toBe(1_500);
    runThink(shooter, 1_499);
    expect(shooter.enemy).toBeNull();
    runThink(shooter, 1_500);
    expect(shooter.enemy).toBe(target);
    target.r.currentOrigin = vec3(0, 100, 100);
    setup.values.centered = 1;
    use(shooter);
    const projectile = setup.pool.at(shooter.slot + 1);
    expect(projectile.s.pos.delta.z).toBeGreaterThan(0);
    setup.values.centered = -1;
    use(shooter);
    expect(setup.pool.at(projectile.slot + 1).s.pos.delta.z).toBeLessThan(0);
  });

  test("a shooter rocket crosses a frame and impacts a real BSP wall", () => {
    const setup = fixture("baseq3", wallMap());
    const shooter = spawn(setup, "shooter_rocket", [
      { key: "origin", value: "0 0 100" }, { key: "angles", value: "0 0 0" }, { key: "random", value: "0.00001" },
    ]);
    use(shooter);
    const rocket = setup.pool.at(shooter.slot + 1);
    setup.clock.previous = setup.clock.now;
    setup.clock.now = 1_100;
    setup.missiles.run(rocket);
    expect(rocket.r.currentOrigin.x).toBe(99);
    expect(rocket.s.eType).toBe(EntityType.ET_GENERAL);
    expect(rocket.s.event & 255).toBe(EntityEvent.EV_MISSILE_MISS);
  });

  test("rejects non-source random providers at the shooter use boundary", () => {
    const setup = fixture();
    const shooter = spawn(setup, "shooter_rocket");
    setup.values.centered = 1.0001;
    expect(() => use(shooter)).toThrow("[-1, 1]");
  });
});

const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const basePak = `${retailRoot}/baseq3/pak0.pk3`;
const missionPak = `${retailRoot}/missionpack/pak0.pk3`;

test.skipIf(!(await Bun.file(basePak).exists()) || !(await Bun.file(missionPak).exists()))(
  "dispatches every shipped misc route from both retail products",
  async () => {
    for (const scenario of [
      { product: "baseq3", archive: basePak, records: [
        ["maps/q3dm10.bsp", "info_camp"], ["maps/q3ctf2.bsp", "info_null"], ["maps/q3ctf3.bsp", "info_notnull"],
        ["maps/q3ctf1.bsp", "light"], ["maps/q3dm0.bsp", "misc_teleporter_dest"], ["maps/q3ctf1.bsp", "misc_model"],
        ["maps/q3ctf2.bsp", "misc_portal_surface"], ["maps/q3dm0.bsp", "misc_portal_camera"],
        ["maps/q3dm11.bsp", "shooter_grenade"],
      ] },
      { product: "missionpack", archive: missionPak, records: [
        ["maps/mpteam3.bsp", "info_camp"], ["maps/mpq3ctf2.bsp", "info_null"], ["maps/mpq3ctf3.bsp", "info_notnull"],
        ["maps/mpq3ctf1.bsp", "light"], ["maps/mpteam4.bsp", "misc_teleporter_dest"], ["maps/mpq3ctf1.bsp", "misc_model"],
        ["maps/mpq3ctf2.bsp", "misc_portal_surface"], ["maps/mpteam4.bsp", "misc_portal_camera"],
        ["maps/mpteam8.bsp", "shooter_rocket"], ["maps/mpterra2.bsp", "shooter_grenade"],
      ] },
    ] satisfies readonly { product: Product; archive: string; records: readonly (readonly [string, string])[] }[]) {
      using archive = await Pk3Archive.open(scenario.archive);
      for (const [path, classname] of scenario.records) {
        const map = parseBsp(await archive.read(path), path);
        const record = map.entityRecords.find(candidate => candidate.get("classname") === classname);
        if (record === undefined) throw new Error(`${path} lacks ${classname}`);
        const setup = fixture(scenario.product, map);
        const variables = new SpawnVariables([...record].map(([key, value]) => ({ key, value })));
        const outcome = spawnEntity(variables, { pool: setup.pool, memory: setup.memory, product: scenario.product, gameType: GameType.GT_FFA,
          handlers: setup.handlers, spawnItem: () => { throw new Error("Unexpected retail item"); }, warn: setup.host.warn });
        expect(outcome.kind).toBe("dispatched");
      }
    }
  },
  30_000,
);
