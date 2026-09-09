import { expect, test } from "bun:test";
import { vec3 } from "../src/core/math.ts";
import { EntityEvent, EntityType, EV_EVENT_BITS } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from "../src/shared/player-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";
import { EntityPool, initGameEntity, runThink, setOrigin } from "../src/game/entities.ts";
import { GameEntity, MAX_CLIENTS } from "../src/game/state.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { ServerWorld } from "../src/server/world.ts";

function fixture(mapStartTime = 0, maxClients = 4) {
  const clock = { now: mapStartTime };
  const linked: GameEntity[] = [];
  const unlinked: GameEntity[] = [];
  const pool = new EntityPool({ print: () => {}, product: "baseq3", maxClients, mapStartTime, time: () => clock.now,
    link: entity => { linked.push(entity); }, unlink: entity => { unlinked.push(entity); } });
  return { pool, clock, linked, unlinked };
}

test("G_TempEntity preserves actual QVM overflow snapping and does not modify caller origin", () => {
  // Untouched g_utils.c via original vm_game=1, weapon reference VECTOR400.
  // Source emits [-822083584,-822083584,-822083584] float bits, all INT_MIN.
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const linked: GameEntity[] = [];
    const pool = new EntityPool({ print: () => {}, product, maxClients: 1, mapStartTime: 0, time: () => 1000,
      link: entity => { linked.push(entity); }, unlink: () => {} });
    const origin = vec3(4294967296, -4294967296, 2147483648);
    const event = pool.tempEntity(origin, EntityEvent.EV_BULLET_HIT_WALL);
    expect(event.s.pos.base).toEqual(vec3(-2147483648, -2147483648, -2147483648));
    expect(event.r.currentOrigin).toEqual(event.s.pos.base); expect(linked).toEqual([event]);
    expect(event.freeAfterEvent).toBe(true); expect(event.eventTime).toBe(1000);
    expect(origin).toEqual(vec3(4294967296, -4294967296, 2147483648));
  }
});

test("pool reserves all 64 client slots even when configured maxclients is four", () => {
  const { pool, linked, unlinked } = fixture();
  expect(pool.numEntities).toBe(MAX_CLIENTS);
  expect(pool.maxClients).toBe(4);
  expect(pool.clients).toHaveLength(64);
  expect(linked).toHaveLength(0);
  expect(unlinked).toHaveLength(0);
  expect(pool.at(0).client).toBe(pool.clientAt(0));
  expect(pool.at(3).client).toBe(pool.clientAt(3));
  expect(pool.at(4).client).toBeNull();
  expect(pool.at(63).client).toBeNull();
  expect(pool.at(0).inuse).toBe(false);
  expect(pool.entitiesFree()).toBe(false);
  const entity = pool.spawn();
  expect(entity.slot).toBe(64);
  expect(entity.s.number).toBe(64);
  expect(entity.classname).toBe("noclass");
  expect(entity.r.ownerNum).toBe(ENTITYNUM_NONE);
  expect(pool.numEntities).toBe(65);
  expect(pool.at(ENTITYNUM_WORLD).inuse).toBe(false);
  expect(pool.at(ENTITYNUM_NONE).inuse).toBe(false);
  expect(pool.get(1024)).toBeUndefined();
  expect(() => pool.at(1024)).toThrow(RangeError);
  expect(() => pool.clientAt(64)).toThrow(RangeError);
});

test("G_InitGentity preserves existing source fields", () => {
  const entity = new GameEntity(70);
  entity.health = 42;
  entity.freetime = 123;
  entity.r.contents = 7;
  initGameEntity(entity);
  expect(entity.inuse).toBe(true);
  expect(entity.classname).toBe("noclass");
  expect(entity.s.number).toBe(70);
  expect(entity.r.ownerNum).toBe(ENTITYNUM_NONE);
  expect(entity.health).toBe(42);
  expect(entity.freetime).toBe(123);
  expect(entity.r.contents).toBe(7);
});

test("native G_Spawn preserves held slot pointers and parent/enemy references across immediate and aged reuse", () => {
  // Untouched g_utils.c, dbe4ddb: at time1000 slot64 is the same pointer after free/spawn,
  // parent==current and held->inuse==current->inuse==1; later frees require the 1000ms cooldown.
  for (const freeTime of [1000, 3000]) {
    const { pool, clock } = fixture();
    const unopenedSlot = pool.at(64);
    const held = pool.spawn(), observer = pool.spawn();
    expect(held).toBe(unopenedSlot);
    observer.parent = held; observer.enemy = held;
    clock.now = freeTime; pool.free(held);
    expect(held.inuse).toBe(false); expect(observer.parent).toBe(held);
    if (freeTime === 3000) {
      expect(pool.spawn()).not.toBe(held);
      clock.now = 3999; expect(pool.spawn()).not.toBe(held);
      clock.now = 4000;
    }
    const current = pool.spawn();
    expect(current.slot).toBe(64); expect(current).toBe(held);
    expect(observer.parent).toBe(current); expect(observer.enemy).toBe(current);
    expect(held.inuse).toBe(true);
    current.health = 73; expect(observer.parent?.health).toBe(73);
    expect(() => pool.addEvent(held, EntityEvent.EV_GENERAL_SOUND)).not.toThrow();
  }
});

test("free unlinks and replaces cleared state while reuse preserves the game slot identity", () => {
  const { pool, clock, unlinked } = fixture();
  const first = pool.spawn();
  const state = first.s;
  const shared = first.r;
  first.health = 100;
  first.flags = 0x10;
  first.model = "models/test.md3";
  first.s.event = 55;
  const publishedState = first.s.copy();
  first.r.contents = 1;
  first.parent = pool.at(0);
  first.think = entity => { entity.count++; };
  clock.now = 100;
  pool.free(first);
  expect(unlinked).toEqual([first]);
  expect(first.inuse).toBe(false);
  expect(first.classname).toBe("freed");
  expect(first.freetime).toBe(100);
  expect(first.health).toBe(0);
  expect(first.flags).toBe(0);
  expect(first.model).toBeNull();
  expect(first.parent).toBeNull();
  expect(first.think).toBeNull();
  expect(first.s.number).toBe(0);
  expect(first.s.event).toBe(0);
  expect(first.r.contents).toBe(0);
  expect(first.s).not.toBe(state);
  expect(first.r).not.toBe(shared);
  expect(pool.entitiesFree()).toBe(true);
  const clearedState = first.s, clearedShared = first.r;
  const reused = pool.spawn();
  expect(reused.slot).toBe(64);
  expect(reused).toBe(first);
  expect(reused.s).toBe(clearedState);
  expect(reused.r).toBe(clearedShared);
  expect(reused.freetime).toBe(100);
  expect(first.inuse).toBe(true);
  reused.s.event = 99;
  expect(publishedState.number).toBe(64); expect(publishedState.event).toBe(55);
  expect(publishedState).not.toBe(reused.s);
  expect(() => pool.free(first)).not.toThrow();
});

test("neverFree only unlinks and preserves the whole game record", () => {
  const { pool, clock, unlinked } = fixture();
  const entity = pool.spawn();
  entity.neverFree = true;
  entity.health = 60;
  const shared = entity.r;
  clock.now = 5000;
  pool.free(entity);
  expect(unlinked).toEqual([entity]);
  expect(entity.inuse).toBe(true);
  expect(entity.health).toBe(60);
  expect(entity.classname).toBe("noclass");
  expect(entity.r).toBe(shared);
  expect(pool.entitiesFree()).toBe(false);
});

test("early-map reuse exception is based on free time, including the exact 2000ms boundary", () => {
  const { pool, clock } = fixture(10000);
  const first = pool.spawn();
  clock.now = 12000;
  pool.free(first);
  const reused = pool.spawn();
  expect(reused.slot).toBe(64);
  clock.now = 12001;
  pool.free(reused);
  expect(pool.spawn().slot).toBe(65);
  clock.now = 13000;
  expect(pool.spawn().slot).toBe(66);
  clock.now = 13001;
  expect(pool.spawn().slot).toBe(64);
});

test("source entity cooldown is 1000ms; free-slot query ignores it", () => {
  // Untouched g_utils.c native oracle, commit dbe4ddb10315479fc00086f08e25d968b4b43c49:
  // at free+500/free+999/free+1000, G_Spawn returns slots 65/66/64.
  const { pool, clock } = fixture();
  const first = pool.spawn();
  clock.now = 3000;
  pool.free(first);
  expect(pool.entitiesFree()).toBe(true);
  clock.now = 3500;
  expect(pool.spawn().slot).toBe(65);
  clock.now = 3999;
  expect(pool.spawn().slot).toBe(66);
  clock.now = 4000;
  expect(pool.spawn().slot).toBe(64);
});

test("allocation excludes WORLD/NONE and preserves source's unreachable force-reuse pass", () => {
  const { pool, clock } = fixture();
  for (let number = MAX_CLIENTS; number < ENTITYNUM_WORLD; number++) expect(pool.spawn().slot).toBe(number);
  expect(pool.numEntities).toBe(ENTITYNUM_WORLD);
  expect(() => pool.spawn()).toThrow("G_Spawn: no free entities");
  expect(pool.entitiesFree()).toBe(false);
  clock.now = 3000;
  pool.free(pool.at(64));
  expect(pool.entitiesFree()).toBe(true);
  // Native g_utils.c oracle confirms failure here. Its force loop checks 1024,
  // but normal capacity is only 1022.
  expect(() => pool.spawn()).toThrow("G_Spawn: no free entities");
  clock.now = 4000;
  expect(pool.spawn().slot).toBe(64);
  expect(pool.at(ENTITYNUM_WORLD).inuse).toBe(false);
  expect(pool.at(ENTITYNUM_NONE).inuse).toBe(false);
});

test("setOrigin resets only positional trajectory and current collision origin", () => {
  const { pool, linked } = fixture();
  const entity = pool.spawn();
  entity.s.pos = { type: TrajectoryType.TR_GRAVITY, time: 100, duration: 200,
    base: vec3(1, 2, 3), delta: vec3(4, 5, 6) };
  entity.s.origin = vec3(9, 8, 7);
  entity.s.apos = { ...entity.s.apos, base: vec3(45, 90, 0) };
  setOrigin(entity, vec3(1.25, -2.5, 3.75));
  expect(entity.s.pos).toEqual({ type: TrajectoryType.TR_STATIONARY, time: 0, duration: 0,
    base: vec3(1.25, -2.5, 3.75), delta: vec3(0, 0, 0) });
  expect(entity.r.currentOrigin).toEqual(vec3(1.25, -2.5, 3.75));
  expect(entity.s.origin).toEqual(vec3(9, 8, 7));
  expect(entity.s.apos.base).toEqual(vec3(45, 90, 0));
  expect(linked).toHaveLength(0);
});

test("temporary events truncate coordinates, link once, and expire strictly after 300ms", () => {
  const { pool, clock, linked, unlinked } = fixture();
  clock.now = 100;
  const entity = pool.tempEntity(vec3(1.9, -2.9, 3.5), EntityEvent.EV_GENERAL_SOUND);
  expect(entity.s.eType).toBe(EntityType.ET_EVENTS + EntityEvent.EV_GENERAL_SOUND);
  expect(entity.s.eType).toBe(58);
  expect(entity.classname).toBe("tempEntity");
  expect(entity.r.currentOrigin).toEqual(vec3(1, -2, 3));
  expect(entity.eventTime).toBe(100);
  expect(linked).toEqual([entity]);
  clock.now = 400;
  expect(pool.expireEvents(entity)).toBe("waiting");
  expect(entity.inuse).toBe(true);
  clock.now = 401;
  expect(pool.expireEvents(entity)).toBe("freed");
  expect(entity.inuse).toBe(false);
  expect(entity.freetime).toBe(401);
  expect(unlinked).toEqual([entity]);
  expect(pool.expireEvents(entity)).toBe("inactive");
  const nearZero = pool.tempEntity(vec3(-0.9, -0, 0.9), EntityEvent.EV_GENERAL_SOUND);
  expect(Object.is(nearZero.r.currentOrigin.x, 0)).toBe(true);
  expect(Object.is(nearZero.r.currentOrigin.y, 0)).toBe(true);
  expect(Object.is(nearZero.r.currentOrigin.z, 0)).toBe(true);
});

test("G_AddEvent cycles event bits while preserving predictable client events", () => {
  const { pool, clock } = fixture();
  const entity = pool.spawn();
  for (const bits of [256, 512, 768, 0, 256]) {
    pool.addEvent(entity, EntityEvent.EV_GENERAL_SOUND, 19);
    expect(entity.s.event & EV_EVENT_BITS).toBe(bits);
    expect(entity.s.event & ~EV_EVENT_BITS).toBe(EntityEvent.EV_GENERAL_SOUND);
    expect(entity.s.eventParm).toBe(19);
  }
  const client = pool.at(0);
  initGameEntity(client);
  clock.now = 100;
  pool.addEvent(client, EntityEvent.EV_FIRE_WEAPON, 2);
  expect(pool.clientAt(0).ps.externalEvent).toBe(EntityEvent.EV_FIRE_WEAPON | 256);
  expect(pool.clientAt(0).ps.externalEventParm).toBe(2);
  expect(pool.clientAt(0).ps.externalEventTime).toBe(100);
  expect(client.s.event).toBe(0);
  expect(client.eventTime).toBe(100);
  pool.addPredictableEvent(client, EntityEvent.EV_JUMP, 3);
  expect(pool.clientAt(0).ps.events.get(0)).toBe(EntityEvent.EV_JUMP);
  expect(pool.addPredictableEvent(entity, EntityEvent.EV_JUMP)).toBeNull();
  clock.now = 401;
  pool.expireEvents(client);
  // Source only clears externalEvent inside the nonzero entity-state event branch.
  expect(pool.clientAt(0).ps.externalEvent).not.toBe(0);
  client.s.event = pool.clientAt(0).ps.externalEvent;
  pool.expireEvents(client);
  expect(client.s.event).toBe(0);
  expect(pool.clientAt(0).ps.externalEvent).toBe(0);
  expect(pool.clientAt(0).ps.events.get(0)).toBe(EntityEvent.EV_JUMP);
});

test("event zero is a no-op and unlinkAfterEvent is consumed once", () => {
  const { pool, clock, unlinked } = fixture();
  const entity = pool.spawn();
  pool.addEvent(entity, EntityEvent.EV_ITEM_PICKUP, 4);
  const original = entity.s.event;
  clock.now = 100;
  pool.addEvent(entity, 0, 10);
  expect(entity.s.event).toBe(original);
  expect(entity.eventTime).toBe(0);
  expect(entity.s.eventParm).toBe(4);
  entity.unlinkAfterEvent = true;
  clock.now = 301;
  expect(pool.expireEvents(entity)).toBe("active");
  expect(entity.s.event).toBe(0);
  expect(entity.unlinkAfterEvent).toBe(false);
  expect(entity.inuse).toBe(true);
  pool.expireEvents(entity);
  expect(unlinked).toEqual([entity]);
});

test("source think timing is inclusive and clears nextthink before callback dispatch", () => {
  const { pool } = fixture();
  const entity = pool.spawn();
  let calls = 0;
  entity.nextthink = 100;
  entity.think = self => { expect(self.nextthink).toBe(0); calls++; self.nextthink = 200; };
  runThink(entity, 99);
  expect(calls).toBe(0);
  runThink(entity, 100);
  expect(calls).toBe(1);
  expect(entity.nextthink).toBe(200);
  runThink(entity, 200);
  expect(calls).toBe(2);
  entity.nextthink = 0;
  runThink(entity, 300);
  expect(calls).toBe(2);
  entity.nextthink = 300;
  entity.think = null;
  expect(() => runThink(entity, 300)).toThrow("NULL ent->think");
  expect(entity.nextthink).toBe(0);
});

test("G_RunThink preserves its source float thinktime storage boundary", () => {
  const { pool } = fixture();
  const entity = pool.spawn();
  entity.nextthink = 16777217;
  entity.think = self => { self.count++; };
  runThink(entity, 16777216);
  expect(entity.count).toBe(1);
  expect(entity.nextthink).toBe(0);
});

test("pool boundaries reject invalid configuration and foreign entities", () => {
  expect(() => fixture(0, 0)).toThrow(RangeError);
  expect(() => fixture(0, 65)).toThrow(RangeError);
  expect(() => fixture(Number.NaN)).toThrow(RangeError);
  const { pool, clock } = fixture();
  expect(() => pool.free(new GameEntity(64))).toThrow("does not belong");
  clock.now = Infinity;
  expect(() => pool.spawn()).toThrow(RangeError);
});

test("real ServerWorld linkcount resets on pool reuse and inactive clients are never linked", () => {
  const bounds = { min: vec3(-1024, -1024, -1024), max: vec3(1024, 1024, 1024) };
  const map: BspMap = {
    entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null,
  };
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const pool = new EntityPool({ print: text => { worldPrints.push(text); }, product: "baseq3", maxClients: 4, mapStartTime: 0, time: () => 100,
    link: entity => { world.link(entity); }, unlink: entity => { world.unlink(entity.slot); } });
  const worldPrints: string[] = [];
  const world = new ServerWorld(collision, bounds, number => pool.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  expect(world.areaEntities(bounds)).toEqual([]);
  const first = pool.tempEntity(vec3(0, 0, 0), EntityEvent.EV_GENERAL_SOUND);
  expect(world.linkState(first.slot)?.linkcount).toBe(1);
  const published = world.link(first);
  expect(published.linkcount).toBe(2);
  pool.free(first);
  expect(world.areaEntities(bounds)).toEqual([]);
  expect(world.linkState(first.slot)?.linkcount).toBe(0);
  expect(world.linkState(first.slot)?.absbounds).toEqual({ min: vec3(0, 0, 0), max: vec3(0, 0, 0) });
  expect(published.linkcount).toBe(2); expect(published.linked).toBe(true);
  const second = pool.tempEntity(vec3(0, 0, 0), EntityEvent.EV_GENERAL_SOUND);
  expect(second.slot).toBe(first.slot);
  expect(second).toBe(first);
  expect(world.linkState(second.slot)?.linkcount).toBe(1);
  expect(world.areaEntities(bounds)).toEqual([64]);
  expect(world.linkState(0)).toBeUndefined();
  const shared = second.r;
  second.neverFree = true; pool.free(second);
  expect(second.inuse).toBe(true); expect(second.r).toBe(shared);
  expect(world.linkState(second.slot)?.linked).toBe(false);
  expect(world.linkState(second.slot)?.linkcount).toBe(1);
  expect(world.link(second).linkcount).toBe(2);
});

test("neverFree temporary entities are unlinked after expiry but remain allocated", () => {
  const { pool, clock, unlinked } = fixture();
  const entity = pool.tempEntity(vec3(0, 0, 0), EntityEvent.EV_GENERAL_SOUND);
  entity.neverFree = true;
  clock.now = 301;
  expect(pool.expireEvents(entity)).toBe("waiting");
  expect(entity.inuse).toBe(true);
  expect(entity.freeAfterEvent).toBe(true);
  expect(unlinked).toEqual([entity]);
});
