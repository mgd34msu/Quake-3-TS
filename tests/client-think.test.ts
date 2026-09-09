import { expect, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { ClientThinkRuntime } from "../src/game/client-think.ts";
import type { ClientThinkHost } from "../src/game/client-think.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { EntityPool, initGameEntity, setOrigin } from "../src/game/entities.ts";
import { ConnectionState, GameFlags, SpectatorState } from "../src/game/state.ts";
import type { GameEntity } from "../src/game/state.ts";
import { ServerWorld } from "../src/server/world.ts";
import { EntityType, GameType, MoveType, Powerup, Team, Weapon, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ServerEntityFlags } from "../src/shared/entity-shared.ts";
import { itemList } from "../src/shared/items.ts";
import { MovementDiagnostics } from "../src/shared/movement.ts";
import { CommandButtons, ENTITYNUM_WORLD, MoveFlags } from "../src/shared/player-state.ts";
import type { UserCommand } from "../src/shared/player-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";

function emptyMap(): BspMap {
  const bounds = { min: vec3(-4096, -4096, -4096), max: vec3(4096, 4096, 4096) };
  return { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}

function volumeMap(contents: number, min = vec3(30, -100, -1000), max = vec3(50, 100, 1000)): BspMap {
  const map = emptyMap(), leaf = map.leaves[0], model = map.models[0];
  if (leaf === undefined || model === undefined) throw new Error("Fixture needs world model and leaf");
  const planes = [
    { normal: vec3(1, 0, 0), distance: max.x }, { normal: vec3(-1, 0, 0), distance: -min.x },
    { normal: vec3(0, 1, 0), distance: max.y }, { normal: vec3(0, -1, 0), distance: -min.y },
    { normal: vec3(0, 0, 1), distance: max.z }, { normal: vec3(0, 0, -1), distance: -min.z },
  ];
  return { ...map, planes, shaders: [{ name: "fixture", surfaceFlags: 0, contentFlags: contents }],
    leaves: [{ ...leaf, brushCount: 1 }], leafBrushes: [0], models: [{ ...model, brushCount: 1 }],
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_, plane) => ({ plane, shader: 0 })) };
}

function command(serverTime: number, buttons = 0, forwardmove = 0, upmove = 0): UserCommand {
  return { serverTime, angles: vec3(0, 0, 0), buttons, weapon: Weapon.WP_MACHINEGUN, forwardmove, rightmove: 0, upmove };
}

function fixture(product: Product = "baseq3", map = emptyMap()) {
  const frame = { time: 0, intermissionTime: 0, intermissionQueued: 0 };
  const settings = { debugMove: 0, synchronousClients: false, pmoveFixed: false, pmoveMsec: 8, gravity: 800,
    speed: 320, dmflags: 0, smoothClients: false, forceRespawnSeconds: 0, singlePlayer: false };
  const calls: string[] = [], aasOrigins: Vec3[] = [];
  const rules = { active: true, gauntletHit: true };
  const pool = new EntityPool({ print: text => { calls.push(text); }, product, maxClients: 2, mapStartTime: 0, time: () => frame.time,
    link: entity => { world.link(entity); }, unlink: entity => { world.unlink(entity.slot); } });
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const worldPrints: string[] = [];
  const world = new ServerWorld(collision, collision.modelBounds(0), number => pool.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  const services = { get time() { return frame.time; }, get intermissionQueued() { return frame.intermissionQueued; },
    gameType: GameType.GT_FFA, friendlyFire: false, knockback: 1000, entities: pool, world, debugDamage: null,
    checkHurtCarrier: () => { throw new Error("Unexpected carrier combat"); },
    logAccuracyHit: () => { throw new Error("Unexpected accuracy combat"); } };
  const combat: CombatContext = product === "baseq3" ? { ...services, product } : { ...services, product,
    checkObeliskAttack: () => { throw new Error("Unexpected obelisk combat"); },
    invulnerabilityEffect: () => { throw new Error("Unexpected invulnerability combat"); } };
  // Preserve live time after the product-specific record construction.
  Object.defineProperty(combat, "time", { get: () => frame.time });
  Object.defineProperty(combat, "intermissionQueued", { get: () => frame.intermissionQueued });
  const host: ClientThinkHost = { pool, world, movementDiagnostics: new MovementDiagnostics(text => { calls.push(text); }),
    effects: { combat }, frame: () => frame, settings: () => settings,
    setPmoveMsec: msec => { calls.push(`msec:${msec}`); settings.pmoveMsec = msec; },
    intermissionThink: () => { calls.push("intermission"); }, spectatorThink: () => { calls.push("spectator"); },
    checkInactivity: () => { calls.push("inactivity"); return rules.active; },
    freeHook: hook => { calls.push("hook"); pool.free(hook); pool.clientAt(0).hook = null; },
    checkGauntletAttack: () => { calls.push("gauntlet"); return rules.gauntletHit; },
    clientEvents: () => { calls.push("events"); }, respawn: () => { calls.push("respawn"); },
    botTestAas: origin => { calls.push("testAas"); aasOrigins.push({ ...origin }); },
    appendConsoleCommand: text => { calls.push(text); }, isDoorTrigger: entity => entity.classname === "door_trigger" };
  const runtime = new ClientThinkRuntime(host);
  function activate(index = 0) {
    const entity = pool.at(index), client = pool.clientAt(index), ps = client.ps;
    initGameEntity(entity);
    client.pers.connected = ConnectionState.CONNECTED;
    ps.clientNum = index;
    ps.origin = vec3(index * 200, 0, 100);
    ps.health = entity.health = 100;
    ps.weapon = Weapon.WP_MACHINEGUN;
    ps.stats.set(statSchema(product).maxHealth, 100);
    ps.stats.set(statSchema(product).weapons, (1 << Weapon.WP_MACHINEGUN) | (1 << Weapon.WP_GAUNTLET));
    ps.ammo.set(Weapon.WP_MACHINEGUN, 100);
    ps.ammo.set(Weapon.WP_GAUNTLET, -1);
    entity.r.currentOrigin = { ...ps.origin };
    entity.r.mins = vec3(-15, -15, -24); entity.r.maxs = vec3(15, 15, 32);
    entity.r.contents = 0x2000000;
    world.link(entity);
    return { entity, client, ps };
  }
  const player = activate();
  function advance(cmd: UserCommand): void { frame.time = cmd.serverTime; runtime.clientThink(0, cmd); }
  function trigger(origin = player.ps.origin, contents = 0x40000000): GameEntity {
    const entity = pool.spawn(); setOrigin(entity, origin);
    entity.r.mins = vec3(-10, -10, -10); entity.r.maxs = vec3(10, 10, 10); entity.r.contents = contents;
    world.link(entity); return entity;
  }
  return { ...player, frame, settings, calls, aasOrigins, rules, pool, world, host, runtime, activate, advance, trigger };
}

test("g_debugMove reports source movement diagnostics after counting silent moves", () => {
  const f = fixture("baseq3", volumeMap(1, vec3(-100, -100, -100), vec3(100, 100, 200)));
  f.advance(command(8));
  expect(f.host.movementDiagnostics.count).toBe(1);
  expect(f.calls.some(text => text.includes("allsolid"))).toBe(false);
  f.settings.debugMove = 1;
  f.advance(command(16));
  expect(f.calls).toContain("2:allsolid\n");
});

test("arrival records commands, async clients move now, bots and synchronous clients move on server frames", () => {
  for (const mode of ["async", "bot", "sync"]) {
    const f = fixture();
    if (mode === "bot") f.entity.r.svFlags |= ServerEntityFlags.BOT;
    if (mode === "sync") f.settings.synchronousClients = true;
    f.frame.time = 24;
    const cmd = command(8, 0, 127);
    f.runtime.clientThink(0, cmd);
    expect(f.client.lastCmdTime).toBe(24);
    expect(f.ps.commandTime).toBe(mode === "async" ? 8 : 0);
    expect(f.client.pers.cmd).not.toBe(cmd);
    expect(f.client.pers.cmd.angles).not.toBe(cmd.angles);
    f.runtime.runClient(f.entity);
    expect(f.ps.commandTime).toBe(mode === "async" ? 8 : 24);
    expect(f.ps.origin.x).toBeGreaterThan(0);
    expect(f.aasOrigins).toEqual([f.ps.origin]);
    expect(f.aasOrigins[0]).not.toBe(f.ps.origin);
    expect(cmd.serverTime).toBe(8);
  }
  const f = fixture(); f.client.pers.connected = ConnectionState.CONNECTING;
  f.advance(command(8));
  expect(f.client.lastCmdTime).toBe(8); expect(f.ps.commandTime).toBe(0); expect(f.calls).toEqual([]);
});

test("source command clamps and fixed rounding preserve pre-round timer msec and cached cvars", () => {
  const f = fixture(); f.frame.time = 1000;
  f.runtime.clientThink(0, command(9000));
  expect(f.client.pers.cmd.serverTime).toBe(1200); expect(f.ps.commandTime).toBe(1200);
  expect(f.client.timeResidual).toBe(200);
  f.frame.time = 3000; f.runtime.clientThink(0, command(-500));
  expect(f.ps.commandTime).toBe(2000); expect(f.client.timeResidual).toBe(400);
  const fixed = fixture(); fixed.settings.pmoveFixed = true; fixed.settings.pmoveMsec = 5;
  fixed.advance(command(9));
  expect(fixed.calls[0]).toBe("msec:8"); expect(fixed.ps.commandTime).toBe(10);
  expect(fixed.client.timeResidual).toBe(9); expect(fixed.settings.pmoveMsec).toBe(8);
  fixed.advance(command(11)); expect(fixed.ps.commandTime).toBe(16); expect(fixed.client.timeResidual).toBe(10);
  fixed.advance(command(12)); expect(fixed.ps.commandTime).toBe(16); expect(fixed.client.timeResidual).toBe(10);
});

test("untouched g_active.c and Pmove native fixtures match both products including backlog and noclip", () => {
  // Native g_active.c/bg_pmove.c/bg_slidemove.c/bg_misc.c/q_math.c/q_shared.c,
  // upstream dbe4ddb, gnu99 -O0, empty trace world, rintf SnapVector; both MISSIONPACK builds agree.
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const f = fixture(product); f.frame.time = 1000; f.runtime.clientThink(0, command(9000));
    expect(f.ps.origin.z).toBe(Math.fround(-301.415985)); expect(f.ps.velocity.z).toBe(-803);
    f.frame.time = 3000; f.runtime.clientThink(0, command(-500));
    expect(f.ps.origin.z).toBe(Math.fround(-1200.70642)); expect(f.ps.velocity.z).toBe(-1445);
    const fixed = fixture(product); fixed.settings.pmoveFixed = true; fixed.settings.pmoveMsec = 5;
    fixed.advance(command(9)); expect(fixed.ps.origin.z).toBe(Math.fround(99.9599991)); expect(fixed.ps.velocity.z).toBe(-8);
    fixed.advance(command(11)); expect(fixed.ps.origin.z).toBe(Math.fround(99.8975983)); expect(fixed.ps.velocity.z).toBe(-13);
    const async = fixture(product); async.frame.time = 24; async.runtime.clientThink(0, command(8, 0, 127));
    expect(async.ps.origin).toEqual(vec3(0.0204800032, 0, 99.9744034)); expect(async.ps.velocity).toEqual(vec3(3, 0, -6));
    const bot = fixture(product); bot.entity.r.svFlags |= ServerEntityFlags.BOT;
    bot.frame.time = 24; bot.runtime.clientThink(0, command(8, 0, 127)); bot.runtime.runClient(bot.entity);
    expect(bot.ps.origin).toEqual(vec3(0.184320003, 0, 99.7695999)); expect(bot.ps.velocity).toEqual(vec3(8, 0, -19));
    const noclip = fixture(product); noclip.client.noclip = true; noclip.advance(command(8, 0, 127));
    expect(noclip.ps.origin).toEqual(vec3(0.204800025, 0, 100)); expect(noclip.ps.velocity).toEqual(vec3(25.6000023, 0, 0));
    expect(noclip.entity.r.mins).toEqual(vec3(0, 0, 0)); expect(noclip.entity.r.maxs).toEqual(vec3(0, 0, 0));
  }
});

test("real BSP brushes apply botclip only to bots and body collision only to living movement", () => {
  for (const bot of [false, true]) {
    const f = fixture("baseq3", volumeMap(0x400000)); f.settings.gravity = 0;
    if (bot) f.entity.r.svFlags |= ServerEntityFlags.BOT;
    for (let time = 8; time <= 1000; time += 8) { f.advance(command(time, 0, 127)); if (bot) f.runtime.runClient(f.entity); }
    if (bot) expect(f.ps.origin.x).toBe(14.875); else expect(f.ps.origin.x).toBeGreaterThan(100);
  }
  for (const dead of [false, true]) {
    const f = fixture("baseq3", volumeMap(0x2000000)); f.settings.gravity = 0; f.ps.velocity = vec3(100, 0, 0);
    if (dead) f.ps.health = f.entity.health = 0;
    for (let time = 8; time <= 1000; time += 8) f.advance(command(time));
    if (dead) expect(f.ps.origin.x).toBeCloseTo(100, 3); else expect(f.ps.origin.x).toBe(14.875);
  }
});

test("world water contents propagate through authoritative movement without running end-frame world damage", () => {
  const f = fixture("baseq3", volumeMap(32, vec3(-100, -100, 0), vec3(100, 100, 200)));
  f.advance(command(8)); expect(f.entity.waterlevel).toBe(3); expect(f.entity.watertype).toBe(32);
  expect(f.entity.health).toBe(100); expect(f.client.airOutTime).toBe(0);
});

test("intermission, following stale commands, scoreboard and inactivity stop at source branch boundaries", () => {
  const f = fixture(); f.frame.intermissionTime = 1; f.advance(command(8));
  expect(f.calls).toEqual(["intermission"]); expect(f.ps.commandTime).toBe(0);
  f.calls.length = 0; f.frame.intermissionTime = 0; f.client.sess.sessionTeam = Team.TEAM_SPECTATOR;
  f.client.sess.spectatorState = SpectatorState.FOLLOW; f.advance(command(-8));
  expect(f.calls).toEqual(["spectator"]);
  f.calls.length = 0; f.client.sess.spectatorState = SpectatorState.SCOREBOARD; f.advance(command(8));
  expect(f.calls).toEqual([]);
  f.client.sess.sessionTeam = Team.TEAM_FREE; f.rules.active = false; f.advance(command(8));
  expect(f.calls).toEqual(["inactivity"]); expect(f.ps.commandTime).toBe(0);
});

test("snapshots link rounded coordinates before triggers then retain exact coordinates for impacts", () => {
  const f = fixture(); f.settings.smoothClients = true;
  const trigger = f.trigger();
  f.host.clientEvents = () => { f.calls.push("events"); expect(f.world.linkState(0)?.linkcount).toBe(1); };
  trigger.touch = (_self, other, trace) => {
    f.calls.push("trigger"); expect(f.world.linkState(0)?.linkcount).toBe(2);
    expect(other.r.currentOrigin).toEqual(other.s.pos.base);
    expect(trace.fraction).toBe(0); expect(trace.entityNum).toBe(0);
    f.pool.addPredictableEvent(other, 14, 7);
  };
  f.advance(command(8, CommandButtons.ATTACK, 127));
  expect(f.calls).toEqual(["inactivity", "events", "trigger", "testAas"]);
  expect(f.client.oldOrigin).toEqual(vec3(0, 0, 100));
  expect(f.entity.s.pos.type).toBe(TrajectoryType.TR_LINEAR_STOP); expect(f.entity.s.pos.duration).toBe(50);
  expect(f.entity.s.pos.base.z).toBe(99); expect(f.entity.r.currentOrigin.z).toBeGreaterThan(99);
  expect(f.entity.r.currentOrigin).toEqual(f.ps.origin); expect(f.entity.eventTime).toBe(8);
  expect(f.client.latchedButtons).toBe(CommandButtons.ATTACK); expect(f.client.timeResidual).toBe(8);
});

test("pending predictable events publish before client events and teleporter callbacks affect linking and trigger selection", () => {
  const f = fixture();
  f.pool.addPredictableEvent(f.entity, 14, 2); f.pool.addPredictableEvent(f.entity, 15, 3);
  const destination = f.trigger(vec3(500, 0, 100));
  destination.touch = () => { f.calls.push("destination"); };
  f.host.clientEvents = (_entity, oldSequence) => {
    expect(oldSequence).toBe(2); expect(f.ps.entityEventSequence).toBe(2);
    const event = f.pool.at(65);
    expect(event.s.eType).toBe(EntityType.ET_EVENTS + (15 | 256));
    expect(event.r.svFlags & ServerEntityFlags.NOTSINGLECLIENT).not.toBe(0);
    expect(event.r.singleClient).toBe(0); expect(event.eventTime).toBe(8);
    expect(f.world.linkState(event.slot)?.linked).toBe(true);
    expect(f.world.linkState(0)?.linkcount).toBe(1);
    f.calls.push("events");
    f.ps.origin = vec3(500, 0, 100); f.entity.r.currentOrigin = { ...f.ps.origin };
  };
  f.advance(command(8));
  expect(f.calls).toEqual(["inactivity", "events", "destination", "testAas"]);
  expect(f.world.linkState(0)?.absbounds.min.x).toBe(484);
  expect(f.entity.r.currentOrigin).toEqual(vec3(500, 0, 100));
});

test("actual movement contacts run after triggers and exact-origin restoration but before button latching", () => {
  const f = fixture(); f.settings.gravity = 0; f.ps.velocity = vec3(200, 0, 0);
  const wall = f.trigger(vec3(30, 0, 100), 0x2000000);
  const trigger = f.trigger(); trigger.touch = () => { f.calls.push("trigger"); };
  wall.touch = (_wall, player) => {
    f.calls.push("impact"); expect(player.r.currentOrigin).toEqual(f.ps.origin);
    expect(f.client.buttons).toBe(0); expect(f.client.timeResidual).toBe(0);
  };
  f.advance(command(66, CommandButtons.ATTACK));
  expect(f.calls).toEqual(["inactivity", "events", "trigger", "testAas", "impact"]);
  expect(f.client.buttons).toBe(CommandButtons.ATTACK); expect(f.client.timeResidual).toBe(66);
});

test("bot trigger and impact touch orders differ, impact contacts deduplicate, item reach ignores its collision box", () => {
  const f = fixture(); f.entity.r.svFlags |= ServerEntityFlags.BOT;
  const hit = f.trigger(); hit.touch = () => { f.calls.push("other"); };
  f.entity.touch = () => { f.calls.push("self"); };
  f.ps.jumppadFrame = 3; f.ps.jumppadEnt = 80; f.ps.pmoveFramecount = 4;
  f.runtime.touchTriggers(f.entity); expect(f.calls).toEqual(["other", "self"]);
  expect(f.ps.jumppadFrame).toBe(0); expect(f.ps.jumppadEnt).toBe(0);
  f.calls.length = 0; f.runtime.clientImpacts(f.entity, [hit.slot, hit.slot]);
  expect(f.calls).toEqual(["self", "other"]);
  f.calls.length = 0; f.world.unlink(hit.slot);
  const item = f.trigger(vec3(35, 0, 100)); item.s.eType = EntityType.ET_ITEM;
  item.r.mins = vec3(0, 0, 0); item.r.maxs = vec3(0, 0, 0); f.world.link(item);
  item.touch = () => { f.calls.push("item"); };
  f.runtime.touchTriggers(f.entity); expect(f.calls).toEqual(["item", "self"]);
  f.calls.length = 0; f.ps.health = 0; f.runtime.touchTriggers(f.entity); expect(f.calls).toEqual([]);
});

test("spectators touch only teleports and door triggers", () => {
  const f = fixture(); f.client.sess.sessionTeam = Team.TEAM_SPECTATOR;
  const ordinary = f.trigger(), teleport = f.trigger(), door = f.trigger();
  ordinary.touch = () => { throw new Error("Spectator touched ordinary trigger"); };
  teleport.s.eType = EntityType.ET_TELEPORT_TRIGGER; teleport.touch = () => { f.calls.push("teleport"); };
  door.classname = "door_trigger"; door.touch = () => { f.calls.push("door"); };
  f.runtime.touchTriggers(f.entity); expect(f.calls.sort()).toEqual(["door", "teleport"]);
});

test("gauntlet, grapple release, forced gestures and strict reward expiration use command state", () => {
  const f = fixture(); f.ps.weapon = Weapon.WP_GAUNTLET;
  f.entity.flags |= GameFlags.FORCE_GESTURE; f.client.rewardTime = 8; f.ps.eFlags = 0x8;
  f.advance({ ...command(8, CommandButtons.ATTACK), weapon: Weapon.WP_GAUNTLET });
  expect(f.calls).toContain("gauntlet"); expect(f.client.buttons & CommandButtons.GESTURE).not.toBe(0);
  expect(f.entity.flags & GameFlags.FORCE_GESTURE).toBe(0); expect(f.ps.eFlags & 8).toBe(8);
  f.advance({ ...command(16, CommandButtons.TALK | CommandButtons.ATTACK), weapon: Weapon.WP_GAUNTLET });
  expect(f.calls.filter(call => call === "gauntlet")).toHaveLength(1); expect(f.ps.eFlags & 8).toBe(0);
  f.ps.weapon = Weapon.WP_GRAPPLING_HOOK; f.client.hook = f.pool.spawn();
  f.advance({ ...command(24), weapon: Weapon.WP_GRAPPLING_HOOK });
  expect(f.calls).toContain("hook"); expect(f.client.hook).toBeNull(); expect(f.client.fireHeld).toBe(false);
});

test("respawn rules use strict deadlines, current buttons and skip living-client timer actions", () => {
  const f = fixture(); f.ps.health = f.entity.health = 0; f.client.respawnTime = 8;
  f.advance(command(8, CommandButtons.ATTACK)); expect(f.calls).not.toContain("respawn");
  f.advance(command(16, CommandButtons.USE_HOLDABLE)); expect(f.calls).toContain("respawn");
  expect(f.client.timeResidual).toBe(0); expect(f.ps.pmType).toBe(MoveType.PM_DEAD);
  f.calls.length = 0; f.settings.forceRespawnSeconds = 1; f.advance(command(1008));
  expect(f.calls).not.toContain("respawn"); f.advance(command(1009)); expect(f.calls).toContain("respawn");
});

test("haste scales the integer speed through the source binary32 product", () => {
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const f = fixture(product);
    f.settings.speed = 90;
    f.ps.powerups.set(Powerup.PW_HASTE, 10000);
    f.advance(command(8));
    expect(f.ps.speed).toBe(116);
  }
});

test("missionpack scout overrides haste and invulnerability expands only without another living client", () => {
  for (const blocked of [false, true]) {
    const f = fixture("missionpack"); const schema = statSchema("missionpack");
    if (schema.product !== "missionpack") throw new Error("Wrong product schema");
    const scout = itemList("missionpack").findIndex(item => item.tag === Powerup.PW_SCOUT && item.className === "item_scout");
    expect(scout).toBeGreaterThan(0); f.ps.stats.set(schema.persistentPowerup, scout);
    f.ps.powerups.set(Powerup.PW_HASTE, 10000); f.advance(command(8)); expect(f.ps.speed).toBe(480);
    f.ps.powerups.set(Powerup.PW_INVULNERABILITY, 10000);
    if (blocked) { const other = f.activate(1); other.ps.origin = vec3(40, 0, 100); other.entity.r.currentOrigin = other.ps.origin; f.world.link(other.entity); }
    f.advance(command(16)); expect(Boolean(f.ps.pmFlags & MoveFlags.INVULEXPAND)).toBe(!blocked);
    expect(f.world.linkState(0)?.linkcount).toBe(5);
    expect(f.entity.r.maxs.x).toBe(blocked ? 15 : 42);
  }
});

test("missionpack queued singleplayer intermission clears only the movement command and leaves zero bounds", () => {
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const f = fixture(product); f.frame.intermissionQueued = 1; f.settings.singlePlayer = true;
    f.advance(command(2001, CommandButtons.ATTACK, 127, 127));
    expect(f.client.pers.cmd.forwardmove).toBe(127); expect(f.client.buttons).toBe(CommandButtons.ATTACK);
    expect(f.ps.pmType).toBe(product === "missionpack" ? MoveType.PM_SPINTERMISSION : MoveType.PM_NORMAL);
    if (product === "missionpack") {
      expect(f.calls).toContain("centerview\n"); expect(f.entity.r.mins).toEqual(vec3(0, 0, 0));
      expect(f.entity.r.maxs).toEqual(vec3(0, 0, 0)); expect(f.ps.origin).toEqual(vec3(0, 0, 100));
    } else expect(f.calls).not.toContain("centerview\n");
  }
});

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retail = await Bun.file(`${dataPath}/baseq3/pak0.pk3`).exists();
test.skipIf(!retail)("both authoritative products settle, jump and land through retail BSP and ServerWorld", async () => {
  const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "baseq3" });
  const map = parseBsp(await vfs.read("maps/q3dm1.bsp"));
  const spawn = map.entityRecords.find(record => record.get("classname") === "info_player_deathmatch");
  if (spawn === undefined) throw new Error("Missing retail spawn");
  const origin = spawn.get("origin"); if (origin === undefined) throw new Error("Missing spawn origin");
  const [x, y, z] = origin.split(/\s+/).map(Number);
  if (x === undefined || y === undefined || z === undefined) throw new Error("Malformed spawn origin");
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const f = fixture(product, map); f.ps.origin = vec3(x, y, z + 9); f.entity.r.currentOrigin = { ...f.ps.origin };
    f.world.link(f.entity); f.ps.commandTime = -100; f.ps.pmTime = 100;
    f.ps.pmFlags = MoveFlags.RESPAWNED | MoveFlags.TIME_KNOCKBACK; f.advance(command(0));
    expect(f.ps.origin.z).toBe(Math.fround(28.9932003)); expect(f.ps.velocity.z).toBe(-80);
    for (let time = 8; time <= 1000; time += 8) f.advance(command(time));
    expect(f.ps.groundEntityNum).toBe(ENTITYNUM_WORLD); expect(f.ps.velocity.z).toBe(0);
    const floor = f.ps.origin.z; f.advance(command(1008, 0, 0, 127)); expect(f.ps.velocity.z).toBeGreaterThan(250);
    let highest = f.ps.origin.z;
    for (let time = 1016; time <= 2208; time += 8) { f.advance(command(time)); highest = Math.max(highest, f.ps.origin.z); }
    expect(highest - floor).toBeGreaterThan(40); expect(f.ps.groundEntityNum).toBe(ENTITYNUM_WORLD);
    expect(f.ps.origin.z).toBe(floor); expect(f.world.linkState(0)?.linked).toBe(true);
  }
}, 20000);
