import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import type { Bounds, Vec3 } from "../src/core/math.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { EntityPool, initGameEntity, runThink, setOrigin } from "../src/game/entities.ts";
import { PersonalPortalRuntime } from "../src/game/personal-portal.ts";
import type { PersonalPortalHost } from "../src/game/personal-portal.ts";
import type { GameEntity } from "../src/game/state.ts";
import { ConfigStringRegistry, findEntity } from "../src/game/utilities.ts";
import { ServerWorld } from "../src/server/world.ts";
import type { LinkState } from "../src/server/world.ts";
import { EntityType, GameType, Powerup, Team, statSchema } from "../src/shared/definitions.ts";
import { findItem, itemList } from "../src/shared/items.ts";
import { ENTITYNUM_WORLD } from "../src/shared/player-state.ts";
import type { SharedEntity } from "../src/shared/entity-shared.ts";
import type { MovementTrace } from "../src/shared/slide-move.ts";

const bounds: Bounds = { min: vec3(-2_048, -2_048, -2_048), max: vec3(2_048, 2_048, 2_048) };

function emptyMap(): BspMap {
  return { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}

const touchTrace: MovementTrace = { fraction: 1, end: vec3(0, 0, 0), solidity: "clear",
  contact: { kind: "none" }, contents: 0, surfaceFlags: 0, entityNum: ENTITYNUM_WORLD };

class PortalWorld extends ServerWorld {
  beforeLink: (() => void) | null = null;

  override link(entity: SharedEntity): LinkState {
    this.beforeLink?.();
    return super.link(entity);
  }
}

function fixture(gameType = GameType.GT_CTF) {
  const clock = { now: 1_000 };
  const effects: string[] = [];
  const random = { value: 0.5 };
  let activeWorld: PortalWorld | null = null;
  const world = (): PortalWorld => {
    if (activeWorld === null) throw new Error("Personal portal fixture world is unavailable");
    return activeWorld;
  };
  const pool = new EntityPool({ print: text => { worldPrints.push(text); }, product: "missionpack", maxClients: 3, mapStartTime: 0, time: () => clock.now,
    link: entity => { world().link(entity); effects.push(`link:${entity.slot}`); },
    unlink: entity => { world().unlink(entity.slot); effects.push(`unlink:${entity.slot}`); } });
  const collision = new CollisionWorld(emptyMap(), { kind: "unaccounted" }, { kind: "disabled" });
  const worldPrints: string[] = [];
  activeWorld = new PortalWorld(collision, collision.modelBounds(0), number => pool.get(number), {
    loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); },
  });
  pool.at(ENTITYNUM_WORLD).s.number = ENTITYNUM_WORLD;
  const combat: Extract<CombatContext, { product: "missionpack" }> = {
    product: "missionpack", get time() { return clock.now; }, intermissionQueued: 0, gameType,
    friendlyFire: false, knockback: 1_000, entities: pool, world: world(), debugDamage: null,
    checkHurtCarrier: () => { effects.push("hurt-carrier"); }, logAccuracyHit: () => false,
    checkObeliskAttack: () => false, invulnerabilityEffect: () => { effects.push("invulnerable"); },
  };
  const strings = new Map<number, string>();
  const models = new ConfigStringRegistry({ get: index => strings.get(index) ?? "",
    set: (index, value) => { strings.set(index, value); effects.push(`model:${value}`); } });
  const host: PersonalPortalHost = { combat, world: world(), models,
    random: { random: () => random.value }, items: {
      touchItem: self => { effects.push(`item-touch:${self.slot}`); },
      droppedFlagThink: self => { effects.push(`flag-expire:${self.slot}`); },
      checkDroppedTeamItem: self => { effects.push(`flag-check:${self.slot}`); },
    } };
  const runtime = new PersonalPortalRuntime(host);
  return { clock, effects, random, pool, world: world(), combat, models, host, runtime };
}

function player(setup: ReturnType<typeof fixture>, slot: number, origin: Vec3): GameEntity {
  const entity = setup.pool.at(slot);
  initGameEntity(entity);
  if (entity.client === null) throw new Error("Portal fixture client is unavailable");
  entity.s.eType = EntityType.ET_PLAYER;
  entity.s.clientNum = slot;
  entity.health = 100;
  entity.takedamage = true;
  entity.r.mins = vec3(-15, -15, -24);
  entity.r.maxs = vec3(15, 15, 32);
  entity.r.contents = 0x2000000;
  entity.client.ps.clientNum = slot;
  entity.client.ps.health = 100;
  entity.client.ps.origin = vec3(origin.x, origin.y, origin.z);
  entity.client.ps.stats.set(statSchema("missionpack").maxHealth, 100);
  entity.client.sess.sessionTeam = Team.TEAM_RED;
  setOrigin(entity, origin);
  entity.die = (self, _inflictor, _attacker, amount, method) => {
    setup.effects.push(`die:${self.slot}:${amount}:${method}:${entity.client?.ps.origin.x}`);
  };
  setup.world.link(entity);
  return entity;
}

function portal(setup: ReturnType<typeof fixture>, classname: string): GameEntity {
  const entity = findEntity(setup.pool, null, "classname", classname);
  if (entity === null) throw new Error(`Missing ${classname}`);
  return entity;
}

function touch(source: GameEntity, other: GameEntity): void {
  if (source.touch === null) throw new Error("Portal source is not enabled");
  source.touch(source, other, touchTrace);
}

describe("personal portal destination", () => {
  test("creates the exact linked destination, increments the level sequence and returns the holdable", () => {
    const setup = fixture();
    const owner = player(setup, 0, vec3(10.9, -20.9, 30.9));
    owner.s.apos = { ...owner.s.apos, base: vec3(11, 22, 33) };
    setup.effects.length = 0;
    setup.world.beforeLink = () => { setup.effects.push(`portal-id-at-link:${owner.client?.portalID}`); };
    setup.runtime.dropPortalDestination(owner);
    setup.world.beforeLink = null;
    const destination = portal(setup, "hi_portal destination");
    if (owner.client === null) throw new Error("Portal owner lost its client");
    expect(destination.s.modelindex).toBe(1);
    expect(destination.s.pos.base).toEqual(vec3(10, -20, 30));
    expect(destination.r.currentOrigin).toEqual(vec3(10, -20, 30));
    expect(destination.r.mins).toEqual(owner.r.mins);
    expect(destination.r.maxs).toEqual(owner.r.maxs);
    expect(destination.r.mins).not.toBe(owner.r.mins);
    expect(destination.r.contents).toBe(0x4000000);
    expect(destination.takedamage).toBe(true);
    expect(destination.health).toBe(200);
    expect(destination.s.angles).toEqual(vec3(11, 22, 33));
    expect(destination.nextthink).toBe(121_000);
    expect(destination.count).toBe(1);
    expect(owner.client.portalID).toBe(1);
    const item = findItem("missionpack", "Portal");
    if (item === null) throw new Error("Missionpack portal item is unavailable");
    expect(owner.client.ps.stats.get(statSchema("missionpack").holdableItem)).toBe(itemList("missionpack").indexOf(item));
    expect(setup.world.linkState(destination.slot)?.linked).toBe(true);
    expect(setup.effects).toEqual([
      "model:models/powerups/teleporter/tele_exit.md3", "portal-id-at-link:0",
    ]);
  });

  test("sequence is instance-owned and source callbacks free the destination at exactly two minutes", () => {
    const setup = fixture();
    const owner = player(setup, 0, vec3(0, 0, 0));
    setup.runtime.dropPortalDestination(owner);
    const first = portal(setup, "hi_portal destination");
    setup.runtime.dropPortalDestination(owner);
    const second = findEntity(setup.pool, first, "classname", "hi_portal destination");
    if (second === null || owner.client === null) throw new Error("Second portal destination is unavailable");
    expect([first.count, second.count, owner.client.portalID]).toEqual([1, 2, 2]);
    const restarted = new PersonalPortalRuntime(setup.host);
    restarted.dropPortalDestination(owner);
    expect(owner.client.portalID).toBe(1);
    runThink(first, 120_999);
    expect(first.inuse).toBe(true);
    setup.clock.now = 121_000;
    runThink(first, 121_000);
    expect(first.inuse).toBe(false);
    expect(setup.world.linkState(first.slot)?.linked).toBe(false);
  });

  test("taking lethal damage invokes PortalDie and frees the linked record", () => {
    const setup = fixture();
    const owner = player(setup, 0, vec3(0, 0, 0));
    setup.runtime.dropPortalDestination(owner);
    const destination = portal(setup, "hi_portal destination");
    if (destination.die === null) throw new Error("Destination has no die callback");
    destination.die(destination, owner, owner, 200, 5);
    expect(destination.inuse).toBe(false);
    expect(setup.world.linkState(destination.slot)?.linked).toBe(false);
  });
});

describe("personal portal source and touch", () => {
  test("links before consuming portalID, waits one second, then enables for two minutes", () => {
    const setup = fixture();
    const owner = player(setup, 0, vec3(10, 20, 30));
    if (owner.client === null) throw new Error("Portal owner has no client");
    owner.client.portalID = 41;
    setup.effects.length = 0;
    setup.world.beforeLink = () => { setup.effects.push(`portal-id-at-link:${owner.client?.portalID}`); };
    setup.runtime.dropPortalSource(owner);
    setup.world.beforeLink = null;
    const source = portal(setup, "hi_portal source");
    expect(source.s.modelindex).toBe(1);
    expect(source.count).toBe(41);
    expect(owner.client.portalID).toBe(0);
    expect(source.r.contents).toBe(0x44000000);
    expect(source.health).toBe(200);
    expect(source.touch).toBeNull();
    expect(source.nextthink).toBe(2_000);
    expect(setup.effects).toEqual([
      "model:models/powerups/teleporter/tele_enter.md3", "portal-id-at-link:41",
    ]);
    runThink(source, 1_999);
    expect(source.touch).toBeNull();
    setup.clock.now = 2_000;
    runThink(source, 2_000);
    expect(source.touch).not.toBeNull();
    expect(source.nextthink).toBe(122_000);
    runThink(source, 121_999);
    expect(source.inuse).toBe(true);
    setup.clock.now = 122_000;
    runThink(source, 122_000);
    expect(source.inuse).toBe(false);
  });

  test("finds its matching destination and teleports through the real server world", () => {
    const setup = fixture();
    const owner = player(setup, 0, vec3(300, 0, 40));
    const traveler = player(setup, 1, vec3(-300, 0, 40));
    setup.runtime.dropPortalDestination(owner);
    setOrigin(owner, vec3(600, 0, 40));
    if (owner.client === null || traveler.client === null) throw new Error("Portal fixture clients are unavailable");
    owner.client.ps.origin = vec3(600, 0, 40);
    setup.world.link(owner);
    setup.runtime.dropPortalSource(owner);
    const source = portal(setup, "hi_portal source");
    expect(source.pos1).toEqual(vec3(300, 0, 40));
    setup.clock.now = 2_000;
    runThink(source, 2_000);
    touch(source, traveler);
    expect(traveler.client.ps.origin).toEqual(vec3(300, 0, 41));
    expect(traveler.client.ps.pmTime).toBe(160);
    expect(traveler.client.ps.velocity.x).toBe(400);
    expect(setup.world.linkState(traveler.slot)?.linked).toBe(true);
    expect(setup.pool.numEntities).toBeGreaterThan(source.slot + 1);
  });

  test("drops exactly one carried flag in neutral-red-blue priority before teleporting", () => {
    const setup = fixture(GameType.GT_1FCTF);
    const owner = player(setup, 0, vec3(300, 0, 40));
    const traveler = player(setup, 1, vec3(-300, 0, 40));
    if (traveler.client === null || owner.client === null) throw new Error("Portal fixture clients are unavailable");
    setup.runtime.dropPortalDestination(owner);
    setOrigin(owner, vec3(600, 0, 40)); owner.client.ps.origin = vec3(600, 0, 40); setup.world.link(owner);
    setup.runtime.dropPortalSource(owner);
    const source = portal(setup, "hi_portal source");
    setup.clock.now = 2_000; runThink(source, 2_000);
    traveler.client.ps.powerups.set(Powerup.PW_NEUTRALFLAG, 9_000);
    traveler.client.ps.powerups.set(Powerup.PW_REDFLAG, 9_000);
    traveler.client.ps.powerups.set(Powerup.PW_BLUEFLAG, 9_000);
    setup.effects.length = 0;
    touch(source, traveler);
    expect(traveler.client.ps.powerups.get(Powerup.PW_NEUTRALFLAG)).toBe(0);
    expect(traveler.client.ps.powerups.get(Powerup.PW_REDFLAG)).toBe(9_000);
    expect(traveler.client.ps.powerups.get(Powerup.PW_BLUEFLAG)).toBe(9_000);
    const dropped = findEntity(setup.pool, null, "classname", "team_CTF_neutralflag");
    if (dropped === null) throw new Error("Portal touch did not drop the neutral flag");
    expect(dropped.s.pos.base).toEqual(vec3(-300, 0, 40));
    expect(setup.effects[0]).toBe(`flag-check:${dropped.slot}`);
    expect(setup.effects[1]).toBe(`link:${dropped.slot}`);
    expect(dropped.nextthink).toBe(32_000);
  });

  test("a missing destination uses remembered pos1 before unavoidable self telefrag damage", () => {
    const setup = fixture();
    const owner = player(setup, 0, vec3(250, 0, 40));
    const traveler = player(setup, 1, vec3(-250, 0, 40));
    if (owner.client === null || traveler.client === null) throw new Error("Portal fixture clients are unavailable");
    setup.runtime.dropPortalDestination(owner);
    const destination = portal(setup, "hi_portal destination");
    setOrigin(owner, vec3(600, 0, 40)); owner.client.ps.origin = vec3(600, 0, 40); setup.world.link(owner);
    setup.runtime.dropPortalSource(owner);
    const source = portal(setup, "hi_portal source");
    setup.pool.free(destination);
    setup.clock.now = 2_000; runThink(source, 2_000);
    setup.effects.length = 0;
    touch(source, traveler);
    expect(traveler.client.ps.origin).toEqual(vec3(250, 0, 41));
    expect(traveler.health).toBe(-999);
    expect(setup.effects).toContain("die:1:50000:18:250");
  });

  test("a missing destination and zero fallback kills without teleport, while dead and nonclients are ignored", () => {
    const setup = fixture();
    const owner = player(setup, 0, vec3(0, 0, 40));
    const traveler = player(setup, 1, vec3(100, 0, 40));
    if (owner.client === null || traveler.client === null) throw new Error("Portal fixture clients are unavailable");
    owner.client.portalID = 77;
    setup.runtime.dropPortalSource(owner);
    const source = portal(setup, "hi_portal source");
    setup.clock.now = 2_000; runThink(source, 2_000);
    const before = vec3(traveler.client.ps.origin.x, traveler.client.ps.origin.y, traveler.client.ps.origin.z);
    touch(source, traveler);
    expect(traveler.client.ps.origin).toEqual(before);
    expect(traveler.health).toBe(-999);
    const dead = player(setup, 2, vec3(200, 0, 40));
    dead.health = 0;
    touch(source, dead);
    expect(dead.health).toBe(0);
    const nonclient = setup.pool.spawn();
    nonclient.health = 100;
    touch(source, nonclient);
    expect(nonclient.health).toBe(100);
  });
});

test("constructor rejects a collision world that is not the combat world's instance", () => {
  const setup = fixture();
  const collision = new CollisionWorld(emptyMap(), { kind: "unaccounted" }, { kind: "disabled" });
  const worldPrints: string[] = [];
  const otherWorld = new ServerWorld(collision, collision.modelBounds(0), number => setup.pool.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  const mismatched: PersonalPortalHost = { ...setup.host, world: otherWorld };
  expect(() => new PersonalPortalRuntime(mismatched)).toThrow("must match");
});
