import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/core/math.ts";
import { clientEndFrame, clientTimerActions, damageFeedback, sendPendingPredictableEvents, setClientSound, worldEffects } from "../src/game/client-effects.ts";
import type { ClientEffectsContext } from "../src/game/client-effects.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { EntityPool, initGameEntity } from "../src/game/entities.ts";
import { GameFlags } from "../src/game/state.ts";
import { EntityEvent, EntityType, GameType, MoveType, Powerup, Team, Weapon, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ServerEntityFlags } from "../src/shared/entity-shared.ts";
import { ENTITYNUM_WORLD } from "../src/shared/player-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";

const products: readonly Product[] = ["baseq3", "missionpack"];

function setup(product: Product = "baseq3") {
  const frame = { time: 1000, intermission: 0, smooth: false, random: 1, randomCalls: 0 };
  const linked: number[] = [];
  const sounds: string[] = [];
  const calls: string[] = [];
  const pool = new EntityPool({ print: text => { calls.push(text); }, product, maxClients: 1, mapStartTime: 0,
    time: () => frame.time, link: entity => { linked.push(entity.slot); }, unlink: () => {} });
  const entity = pool.at(0);
  initGameEntity(entity);
  const client = pool.clientAt(0);
  entity.health = 100;
  entity.takedamage = true;
  entity.die = (_self, _source, _attacker, amount) => { calls.push(`die:${amount}`); client.ps.pmType = MoveType.PM_DEAD; };
  client.ps.health = 100;
  client.ps.stats.set(statSchema(product).maxHealth, 100);
  pool.at(ENTITYNUM_WORLD).s.number = ENTITYNUM_WORLD;
  const unexpected = (): never => { throw new Error("Unexpected spatial/team combat service"); };
  const common = {
    get time() { return frame.time; }, intermissionQueued: 0, gameType: GameType.GT_FFA,
    friendlyFire: false, knockback: 1000, entities: pool, debugDamage: null,
    world: { trace: unexpected, areaEntities: unexpected, linkState: unexpected },
    checkHurtCarrier: unexpected, logAccuracyHit: unexpected,
  };
  const combat: CombatContext = product === "baseq3" ? { ...common, get time() { return frame.time; }, product }
    : { ...common, get time() { return frame.time; }, product, checkObeliskAttack: unexpected, invulnerabilityEffect: unexpected };
  const context: ClientEffectsContext = {
    combat,
    get intermissionTime() { return frame.intermission; }, get smoothClients() { return frame.smooth; }, frySound: 55,
    randomInt: () => { frame.randomCalls++; return frame.random; },
    soundIndex: path => {
      sounds.push(path);
      switch (path) {
        case "sound/weapons/proxmine/wstbtick.wav": return 77;
        case "sound/player/gurp1.wav": return 78;
        case "sound/player/gurp2.wav": return 79;
        case "*drown.wav": return 80;
        default: throw new Error(`Unexpected sound ${path}`);
      }
    },
    sound: (target, channel, index) => { calls.push(`sound:${target.slot}:${channel}:${index}`); },
    spectatorEndFrame: () => { calls.push("spectator"); },
  };
  return { context, frame, entity, client, pool, linked, sounds, calls };
}

describe("damage feedback native C fixtures", () => {
  // Untouched g_active.c/g_combat.c/bg_misc.c/q_math.c, commit dbe4ddb10315479fc00086f08e25d968b4b43c49.
  // GCC -O0 -ffunction-sections -fdata-sections --gc-sections, both product builds.
  const fixtures = [
    { direction: vec3(1, 0, 0), pitch: 0, yaw: 0 }, { direction: vec3(0, 1, 0), pitch: 0, yaw: 64 },
    { direction: vec3(0, 0, 1), pitch: -64, yaw: 0 }, { direction: vec3(0, 0, -1), pitch: -192, yaw: 0 },
    { direction: vec3(-1, -1, -1), pitch: -230, yaw: 160 },
    { direction: vec3(13.37, -29.125, 41.875), pitch: -37, yaw: 209 },
  ];
  for (const product of products) for (const [index, fixture] of fixtures.entries()) test(`${product} direction ${index}`, () => {
    const { context, client, entity } = setup(product);
    client.damageBlood = 12;
    client.damageArmor = 7;
    client.damageKnockback = 99;
    client.damageFrom = fixture.direction;
    damageFeedback(context, entity);
    expect([client.ps.damagePitch, client.ps.damageYaw, client.ps.damageCount, client.ps.damageEvent,
      entity.painDebounceTime, client.ps.externalEvent & 255, client.ps.externalEventParm])
      .toEqual([fixture.pitch, fixture.yaw, 19, 1, 1700, 56, 100]);
    expect([client.damageBlood, client.damageArmor, client.damageKnockback]).toEqual([0, 0, 0]);
  });

  test("zero damage and PM_DEAD leave totals untouched; world feedback saturates count", () => {
    const { context, entity, client } = setup();
    client.damageKnockback = 99;
    damageFeedback(context, entity);
    expect(client.damageKnockback).toBe(99);
    client.ps.pmType = MoveType.PM_DEAD;
    client.damageBlood = 500;
    client.damageFromWorld = true;
    damageFeedback(context, entity);
    expect(client.damageBlood).toBe(500);
    expect(client.damageFromWorld).toBe(true);
    client.ps.pmType = MoveType.PM_NORMAL;
    damageFeedback(context, entity);
    expect([client.ps.damagePitch, client.ps.damageYaw, client.ps.damageCount]).toEqual([255, 255, 255]);
    expect(client.damageFromWorld).toBe(false);
  });

  test("pain debounce is strict and godmode suppresses events without suppressing feedback", () => {
    const { context, entity, client, frame } = setup();
    entity.painDebounceTime = 1000;
    client.damageBlood = 5;
    damageFeedback(context, entity);
    expect(client.ps.damageEvent).toBe(0);
    frame.time = 1001;
    entity.flags = GameFlags.GODMODE;
    client.damageBlood = 9;
    damageFeedback(context, entity);
    expect(client.ps.damageCount).toBe(9);
    expect(client.ps.damageEvent).toBe(0);
    entity.flags = 0;
    client.damageBlood = 7;
    damageFeedback(context, entity);
    expect([client.ps.damageEvent, entity.painDebounceTime]).toEqual([1, 1701]);
  });
});

describe("environmental effect state transitions", () => {
  for (const product of products) test(`${product} native drowning and mixed sizzle fixtures`, () => {
    const drowning = setup(product);
    drowning.entity.waterlevel = 3;
    drowning.entity.damage = 2;
    drowning.client.airOutTime = 999;
    worldEffects(drowning.context, drowning.entity);
    damageFeedback(drowning.context, drowning.entity);
    expect([drowning.entity.health, drowning.entity.damage, drowning.client.airOutTime, drowning.entity.painDebounceTime,
      drowning.client.ps.damageCount, drowning.client.ps.damagePitch, drowning.client.ps.damageEvent])
      .toEqual([96, 4, 1999, 1200, 4, 255, 0]);
    expect(drowning.calls).toEqual(["sound:0:3:78"]);
    const sizzle = setup(product);
    sizzle.entity.waterlevel = 2;
    sizzle.entity.watertype = 8 | 16;
    worldEffects(sizzle.context, sizzle.entity);
    damageFeedback(sizzle.context, sizzle.entity);
    setClientSound(sizzle.context, sizzle.entity);
    expect([sizzle.entity.health, sizzle.client.ps.damageCount, sizzle.client.ps.damagePitch,
      sizzle.client.ps.damageEvent, sizzle.client.ps.loopSound, sizzle.client.airOutTime]).toEqual([20, 80, 255, 1, 55, 13000]);
  });

  test("drowning ramps once per call, caps at fifteen, chooses lethal sound, and resets on surfacing", () => {
    const { context, entity, client, frame, sounds } = setup();
    entity.waterlevel = 3;
    entity.health = 1000;
    entity.damage = 2;
    client.airOutTime = 999;
    client.ps.stats.set(statSchema("baseq3").armor, 100);
    for (let step = 0; step < 7; step++) {
      worldEffects(context, entity);
      frame.time += 1000;
    }
    expect(entity.damage).toBe(15);
    expect(client.ps.stats.get(statSchema("baseq3").armor)).toBe(100);
    frame.random = 0;
    worldEffects(context, entity);
    expect(sounds.at(-1)).toBe("sound/player/gurp2.wav");
    frame.time += 1000;
    entity.health = 10;
    const randomCalls = frame.randomCalls;
    worldEffects(context, entity);
    expect(sounds.at(-1)).toBe("*drown.wav");
    expect(frame.randomCalls).toBe(randomCalls);
    expect(client.ps.pmType).toBe(MoveType.PM_DEAD);
    entity.waterlevel = 2;
    worldEffects(context, entity);
    expect([entity.damage, client.airOutTime]).toEqual([2, frame.time + 12000]);
  });

  test("noclip and suit replenish air; drowning uses a strict deadline and suppresses sizzle", () => {
    const { context, entity, client, frame } = setup();
    entity.waterlevel = 3;
    entity.watertype = 8 | 16;
    entity.damage = 9;
    client.noclip = true;
    worldEffects(context, entity);
    expect([entity.health, entity.damage, client.airOutTime]).toEqual([100, 9, 13000]);
    client.noclip = false;
    client.ps.powerups.set(Powerup.PW_BATTLESUIT, 1001);
    worldEffects(context, entity);
    expect([entity.health, client.airOutTime, client.ps.externalEvent & 255]).toEqual([100, 11000, EntityEvent.EV_POWERUP_BATTLESUIT]);
    client.ps.powerups.set(Powerup.PW_BATTLESUIT, 0);
    entity.watertype = 0;
    client.airOutTime = frame.time;
    worldEffects(context, entity);
    expect(entity.health).toBe(100);
    frame.time++;
    entity.watertype = 8 | 16;
    worldEffects(context, entity);
    expect(entity.health).toBe(89);
    expect(client.damageBlood).toBe(11);
  });

  test("missionpack ticking sound takes precedence over fry; base ignores ticking", () => {
    for (const product of products) {
      const { context, entity, client } = setup(product);
      entity.s.eFlags = 2;
      entity.waterlevel = 1;
      entity.watertype = 8;
      setClientSound(context, entity);
      expect(client.ps.loopSound).toBe(product === "missionpack" ? 77 : 55);
      entity.s.eFlags = 0;
      setClientSound(context, entity);
      expect(client.ps.loopSound).toBe(55);
      entity.waterlevel = 0;
      setClientSound(context, entity);
      expect(client.ps.loopSound).toBe(0);
    }
  });
});

describe("client timer native fixtures and product powerups", () => {
  for (const product of products) test(`${product} 3500ms regeneration and decay preserve residual`, () => {
    const { context, entity, client } = setup(product);
    const schema = statSchema(product);
    client.ps.powerups.set(Powerup.PW_REGEN, 1);
    entity.health = 99;
    client.ps.stats.set(schema.armor, 105);
    clientTimerActions(context, entity, 3500);
    expect([entity.health, client.ps.health, client.ps.stats.get(schema.armor), client.timeResidual]).toEqual([120, 100, 102, 500]);
    expect(client.ps.externalEvent & 255).toBe(EntityEvent.EV_POWERUP_REGEN);
    const decay = setup(product);
    decay.entity.health = 105;
    decay.client.ps.stats.set(schema.armor, 105);
    clientTimerActions(decay.context, decay.entity, 3500);
    expect([decay.entity.health, decay.client.ps.stats.get(schema.armor), decay.client.timeResidual]).toEqual([102, 102, 500]);
    clientTimerActions(decay.context, decay.entity, 499);
    expect(decay.entity.health).toBe(102);
    clientTimerActions(decay.context, decay.entity, 1);
    expect(decay.entity.health).toBe(101);
  });

  test("guard regeneration uses half max health; scout still decays overhealth and armor", () => {
    const { context, entity, client } = setup("missionpack");
    const schema = statSchema("missionpack");
    if (schema.product !== "missionpack") throw new Error("Expected missionpack schema");
    client.ps.stats.set(schema.persistentPowerup, 43);
    client.ps.stats.set(schema.maxHealth, 201);
    entity.health = 99;
    clientTimerActions(context, entity, 3500);
    expect([entity.health, client.timeResidual]).toEqual([120, 500]);
    client.ps.stats.set(schema.persistentPowerup, 42);
    entity.health = 205;
    client.ps.stats.set(schema.armor, 205);
    clientTimerActions(context, entity, 500);
    expect([entity.health, client.ps.stats.get(schema.armor)]).toEqual([204, 204]);
  });

  test("Ammo Regen consumes elapsed periods but grants one increment per invocation", () => {
    const { context, entity, client } = setup("missionpack");
    const schema = statSchema("missionpack");
    if (schema.product !== "missionpack") throw new Error("Expected missionpack schema");
    client.ps.stats.set(schema.persistentPowerup, 45);
    clientTimerActions(context, entity, 4500);
    const ammo: number[] = [], timers: number[] = [];
    for (let weapon = 2; weapon < 14; weapon++) { ammo.push(client.ps.ammo.get(weapon)); timers.push(client.ammoTimes.get(weapon)); }
    expect(ammo).toEqual([4, 1, 1, 1, 5, 1, 5, 1, 0, 1, 1, 5]);
    expect(timers).toEqual([500, 0, 500, 1000, 0, 1000, 0, 500, 0, 750, 500, 500]);
    client.ps.ammo.set(Weapon.WP_MACHINEGUN, 49);
    clientTimerActions(context, entity, 500);
    expect(client.ps.ammo.get(Weapon.WP_MACHINEGUN)).toBe(50);
    clientTimerActions(context, entity, 123);
    expect(client.ammoTimes.get(Weapon.WP_MACHINEGUN)).toBe(0);
    client.ps.stats.set(schema.persistentPowerup, 0);
    const before = client.ammoTimes.get(Weapon.WP_ROCKET_LAUNCHER);
    clientTimerActions(context, entity, 1000);
    expect(client.ammoTimes.get(Weapon.WP_ROCKET_LAUNCHER)).toBe(before);
  });
});

describe("end-frame and predictable event publication", () => {
  test("spectators delegate before expiry; intermission expires powerups without normal effects", () => {
    const { context, entity, client, frame, calls } = setup();
    client.ps.powerups.set(Powerup.PW_QUAD, 999);
    client.sess.sessionTeam = Team.TEAM_SPECTATOR;
    clientEndFrame(context, entity);
    expect(calls).toEqual(["spectator"]);
    expect(client.ps.powerups.get(Powerup.PW_QUAD)).toBe(999);
    client.sess.sessionTeam = Team.TEAM_FREE;
    frame.intermission = 1;
    entity.waterlevel = 2;
    entity.watertype = 8;
    client.ps.powerups.set(Powerup.PW_HASTE, 1000);
    clientEndFrame(context, entity);
    expect(client.ps.powerups.get(Powerup.PW_QUAD)).toBe(0);
    expect(client.ps.powerups.get(Powerup.PW_HASTE)).toBe(1000);
    expect(entity.health).toBe(100);
    expect(client.airOutTime).toBe(0);
  });

  test("all persistent powerups and invulnerability publish animation bits before intermission", () => {
    for (const [index, tag] of [[42, Powerup.PW_SCOUT], [43, Powerup.PW_GUARD], [44, Powerup.PW_DOUBLER], [45, Powerup.PW_AMMOREGEN]] satisfies readonly (readonly [number, Powerup])[]) {
      const { context, entity, client, frame } = setup("missionpack");
      const schema = statSchema("missionpack");
      if (schema.product !== "missionpack") throw new Error("Expected missionpack schema");
      client.ps.stats.set(schema.persistentPowerup, index);
      client.invulnerabilityTime = 1001;
      frame.intermission = 1;
      clientEndFrame(context, entity);
      expect(client.ps.powerups.get(tag)).toBe(1000);
      expect(client.ps.powerups.get(Powerup.PW_INVULNERABILITY)).toBe(1000);
    }
  });

  test("source connection flag overwrite and ticking loop precedence survive conversion", () => {
    for (const product of products) {
      const { context, entity, client, frame } = setup(product);
      entity.s.eFlags = 2;
      client.ps.eFlags = 4;
      client.lastCmdTime = -5000;
      client.ps.origin = vec3(1.75, -2.75, 3.75);
      client.ps.commandTime = 900;
      clientEndFrame(context, entity);
      expect([entity.s.eFlags, client.ps.eFlags, client.ps.loopSound, entity.s.loopSound]).toEqual(product === "missionpack" ? [4, 4, 77, 77] : [4, 4, 0, 0]);
      expect(entity.s.pos.base).toEqual(vec3(1, -2, 3));
      expect(entity.s.pos.type).toBe(TrajectoryType.TR_INTERPOLATE);
      frame.smooth = true;
      frame.time = 1100;
      clientEndFrame(context, entity);
      expect([entity.s.pos.type, entity.s.pos.time, entity.s.pos.duration]).toEqual([TrajectoryType.TR_LINEAR_STOP, 900, 50]);
      expect(client.airOutTime).toBe(13100);
    }
  });

  test("native stale ring event type is computed before converter clamps the event sequence", () => {
    const { context, client, pool, linked } = setup();
    const ps = client.ps;
    ps.clientNum = 2;
    ps.eventSequence = 5;
    ps.entityEventSequence = 0;
    ps.events.set(0, EntityEvent.EV_FIRE_WEAPON);
    ps.events.set(1, EntityEvent.EV_JUMP);
    ps.eventParms.set(1, 73);
    ps.externalEvent = 99;
    sendPendingPredictableEvents(context, ps);
    const temporary = pool.at(64);
    expect([temporary.s.number, temporary.s.eType, temporary.s.event, temporary.s.eventParm, temporary.s.eFlags,
      temporary.s.otherEntityNum, temporary.r.singleClient, ps.entityEventSequence, ps.externalEvent])
      .toEqual([64, 36, 782, 73, 16, 2, 2, 4, 99]);
    expect(temporary.r.svFlags & ServerEntityFlags.NOTSINGLECLIENT).toBe(ServerEntityFlags.NOTSINGLECLIENT);
    expect(temporary.freeAfterEvent).toBe(true);
    expect(linked).toEqual([64]);
  });

  test("end-frame consumes one entity event and externalizes one remaining event", () => {
    const { context, entity, client, pool, linked } = setup("missionpack");
    client.ps.addEvent(EntityEvent.EV_JUMP, 4);
    client.ps.addEvent(EntityEvent.EV_FIRE_WEAPON, 5);
    clientEndFrame(context, entity);
    expect([entity.s.event, entity.s.eventParm, client.ps.entityEventSequence]).toEqual([14, 4, 2]);
    expect([pool.at(64).s.eType, pool.at(64).s.event, pool.at(64).s.eventParm]).toEqual([EntityType.ET_EVENTS + 279, 279, 5]);
    expect(linked).toEqual([64]);
    clientEndFrame(context, entity);
    expect(linked).toEqual([64]);
  });

  test("world damage becomes one-frame feedback before state conversion and then debounces", () => {
    const { context, entity, client, frame } = setup();
    entity.waterlevel = 2;
    entity.watertype = 8;
    clientEndFrame(context, entity);
    expect([entity.health, client.ps.health, client.ps.damageCount, client.ps.damageEvent, entity.s.loopSound]).toEqual([40, 40, 60, 1, 55]);
    expect(client.damageBlood).toBe(0);
    frame.time += 100;
    clientEndFrame(context, entity);
    expect([entity.health, client.ps.damageEvent]).toEqual([40, 1]);
  });
});
