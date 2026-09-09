// Interpolation/freefall/threshold goldens recorded from upstream cg_predict.c
// in native i386 and q3lcc vm_game=1: /tmp/quake3-cgame-reference-sSvF61.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import type { Bounds } from "../src/core/math.ts";
import { float32ToBits } from "../src/core/numeric.ts";
import type { RetailSnapshot } from "../src/cgame/retail-snapshot.ts";
import { buildSolidList, ClientCommandHistory, PredictionRuntime } from "../src/cgame/prediction.ts";
import type { PredictionSettings } from "../src/cgame/prediction.ts";
import { ClientGameState } from "../src/cgame/state.ts";
import { EntityEvent, EntityType, GameType, MoveType, PersistentIndex, Powerup, Team, Weapon, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { itemList } from "../src/shared/items.ts";
import { movePlayer } from "../src/shared/movement.ts";
import { createPlayerState, MoveFlags } from "../src/shared/player-state.ts";
import type { UserCommand } from "../src/shared/player-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";

const products: readonly Product[] = ["baseq3", "missionpack"];
const zero = vec3(0, 0, 0), point: Bounds = { min: zero, max: zero };
function map(): BspMap {
  const bounds = { min: vec3(-1000, -1000, -1000), max: vec3(1000, 1000, 1000) };
  const planes = [{ normal: vec3(-1, 0, 0), distance: 10 }, { normal: vec3(1, 0, 0), distance: 10 },
    { normal: vec3(0, -1, 0), distance: 10 }, { normal: vec3(0, 1, 0), distance: 10 },
    { normal: vec3(0, 0, -1), distance: 10 }, { normal: vec3(0, 0, 1), distance: 10 }];
  return { entities: "", entityRecords: [], shaders: [{ name: "trigger", surfaceFlags: 0, contentFlags: 0x40000000 }], planes, nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [
      { bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 },
      { bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_, plane) => ({ plane, shader: 0 })),
    vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}
function snapshot(product: Product, time: number): RetailSnapshot {
  const ps = createPlayerState(product); ps.health = 100; ps.speed = 320; ps.gravity = 800; ps.groundEntityNum = 1023;
  ps.stats.set(statSchema(product).maxHealth, 100);
  return { messageNumber: 1, serverTime: time, deltaNumber: -1, flags: 0, serverCommandNumber: 0,
    parseEntitiesNumber: 0, areaMask: new Uint8Array(32), playerState: ps, entities: [] };
}
function command(time: number): UserCommand {
  return { serverTime: time, angles: zero, weapon: Weapon.WP_NONE, buttons: 0, forwardmove: 0, rightmove: 0, upmove: 0 };
}
function fixture(product: Product) {
  const state = new ClientGameState(product, 0, 0), commands = new ClientCommandHistory(), calls: string[] = [];
  let settings: PredictionSettings = { gameType: GameType.GT_FFA, dmFlags: 0, demoPlayback: false, noPredict: false, synchronousClients: false,
    predictItems: true, pmoveFixed: false, pmoveMsec: 8, errorDecayInteger: 100, errorDecayValue: 100, showMiss: 1 };
  const runtime = new PredictionRuntime(state, new CollisionWorld(map(), { kind: "unaccounted" }, { kind: "disabled" }), { commands, settings: () => settings,
    setPmoveMsec: value => { calls.push(`msec:${value}`); }, warn: message => { calls.push(message); },
    transitionPlayerState: async (current, previous) => { calls.push(`transition:${previous.commandTime}:${current.commandTime}`); } });
  state.snap = snapshot(product, 0); state.predictedPlayerState = state.snap.playerState.copy();
  return { state, commands, runtime, calls, configure: (changes: Partial<PredictionSettings>) => { settings = { ...settings, ...changes }; }, settings: () => settings };
}

test("CL_GetUserCmd owns commands, allows initial negative slots, and rejects future/expired commands", () => {
  const commands = new ClientCommandHistory(); expect(commands.read(-63)?.serverTime).toBe(0); expect(commands.read(-64)).toBeNull();
  const input = command(10); commands.append(input); input.serverTime = 999; expect(commands.read(1)?.serverTime).toBe(10);
  const copy = commands.read(1); if (copy === null) throw new Error("Missing command"); copy.serverTime = 888;
  expect(commands.read(1)?.serverTime).toBe(10); expect(() => commands.read(2)).toThrow("CL_GetUserCmd: 2 >= 1");
  for (let i = 0; i < 64; i++) commands.append(command(i)); expect(commands.read(1)).toBeNull();
});

for (const product of products) describe(`${product} source client prediction`, () => {
  test("a newly visible next-snapshot body keeps its zero current solid during source prediction", () => {
    const f = fixture(product), cent = f.state.entityAt(0);
    cent.nextState.number = 0; cent.nextState.eType = EntityType.ET_PLAYER; cent.nextState.solid = 4200463;
    f.state.nextSnap = { ...snapshot(product, 100), entities: [cent.nextState.copy()] };
    buildSolidList(f.state);
    expect(f.state.solidEntities).toEqual([cent]); expect(cent.currentValid).toBe(false);
    const start = vec3(-380, 3480, 352.125), end = vec3(-380, 3480, 351.875);
    const result = f.runtime.trace(start, end, { min: vec3(-15, -15, -24), max: vec3(15, 15, 32) }, 1, 33619969);
    expect(result.fraction).toBe(1); expect(result.end).toEqual(end); expect(result.solidity).toBe("clear");
    expect(cent.currentState.solid).toBe(0); expect(cent.nextState.solid).toBe(4200463);
  });
  for (const fail of [false, true]) test(`prediction ${fail ? "rejects before" : "awaits before"} double-event repair`, async () => {
    const f = fixture(product), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const runtime = new PredictionRuntime(f.state, new CollisionWorld(map(), { kind: "unaccounted" }, { kind: "disabled" }), { ...f.runtime.host,
      transitionPlayerState: async () => { entered.resolve(); await gate.promise; }
    });
    f.state.eventSequence = 10; f.state.time = 100; f.commands.append(command(100));
    const work = runtime.predictPlayerState(); await entered.promise;
    expect(f.state.predictedPlayerState.commandTime).toBe(100); expect(f.state.eventSequence).toBe(10);
    expect(f.calls).not.toContain("WARNING: double event\n");
    if (fail) {
      gate.reject(new Error("event failed")); await expect(work).rejects.toThrow("event failed");
      expect(f.state.eventSequence).toBe(10); expect(f.calls).not.toContain("WARNING: double event\n");
    } else {
      gate.resolve(); await work;
      expect(f.state.eventSequence).toBe(f.state.predictedPlayerState.eventSequence); expect(f.calls).toContain("WARNING: double event\n");
    }
  });
  test("interpolates bob wrap and shortest angles, and captures angles before teleport early return", () => {
    const f = fixture(product), a = snapshot(product, 100), b = snapshot(product, 200);
    a.playerState.origin = vec3(1, 2, 3); b.playerState.origin = vec3(11, 22, 33);
    a.playerState.bobCycle = 250; b.playerState.bobCycle = 10;
    a.playerState.viewangles = vec3(350, 10, -170); b.playerState.viewangles = vec3(10, 350, 170);
    f.state.snap = a; f.state.nextSnap = b; f.state.time = 125;
    f.runtime.interpolatePlayerState(false);
    expect(f.state.predictedPlayerState.origin).toEqual(vec3(3.5, 7, 10.5)); expect(f.state.predictedPlayerState.bobCycle).toBe(254);
    expect(f.state.predictedPlayerState.viewangles).toEqual(vec3(355, 5, -175));
    f.commands.append({ ...command(125), angles: vec3(0, 16384, 0) }); f.state.nextFrameTeleport = true;
    f.runtime.interpolatePlayerState(true); expect(f.state.predictedPlayerState.origin).toEqual(a.playerState.origin);
    expect(f.state.predictedPlayerState.viewangles.y).toBe(90); expect(a.playerState.viewangles.y).toBe(10);
  });
  test("real encoded bodies trace with source merge replacement, skip and mask behavior", () => {
    const f = fixture(product), first = f.state.entityAt(2), second = f.state.entityAt(3);
    for (const cent of [first, second]) { cent.currentState.number = cent === first ? 2 : 3; cent.currentState.solid = 8 | (8 << 8) | (40 << 16); }
    second.lerpOrigin = vec3(40, 0, 0); f.state.solidEntities.push(first, second);
    const trace = f.runtime.trace(zero, vec3(80, 0, 0), point, -1, 0x2000000);
    expect(trace.entityNum).toBe(3); expect(trace.solidity).toBe("clear"); expect(trace.end.x).toBe(31.875);
    expect(f.runtime.trace(zero, vec3(80, 0, 0), point, 3, 0x2000000).solidity).toBe("start-solid");
    expect(f.runtime.trace(zero, vec3(80, 0, 0), point, -1, 1).fraction).toBe(1);
    expect(f.runtime.pointContents(zero, -1)).toBe(0);
  });
  test("inline traces use trajectory and lerp angles; point contents uses network origin/angles", () => {
    const f = fixture(product), cent = f.state.entityAt(5);
    cent.currentState.number = 5; cent.currentState.solid = 0xffffff; cent.currentState.modelindex = 1;
    cent.currentState.pos = { type: TrajectoryType.TR_LINEAR, base: vec3(100, 0, 0), delta: vec3(10, 0, 0), time: 0, duration: 0 };
    cent.currentState.origin = vec3(200, 0, 0); f.state.physicsTime = 1000; f.state.solidEntities.push(cent);
    const trace = f.runtime.trace(vec3(130, 0, 0), vec3(100, 0, 0), point, -1, 0x40000000);
    expect(trace.entityNum).toBe(5); expect(trace.end.x).toBe(120.125);
    expect(f.runtime.pointContents(vec3(200, 0, 0), -1)).toBe(0x40000000);
    expect(f.runtime.pointContents(vec3(110, 0, 0), -1)).toBe(0); expect(f.runtime.pointContents(vec3(200, 0, 0), 5)).toBe(0);
  });
  test("real trigger overlap predicts jump-pad events once, flight/spectator gates, and teleport hyperspace", () => {
    const f = fixture(product), jump = f.state.entityAt(5), portal = f.state.entityAt(6);
    for (const cent of [jump, portal]) { cent.currentState.number = cent === jump ? 5 : 6; cent.currentState.solid = 0xffffff; cent.currentState.modelindex = 1; }
    jump.currentState.eType = EntityType.ET_PUSH_TRIGGER; jump.currentState.origin2 = vec3(100, 0, 200);
    portal.currentState.eType = EntityType.ET_TELEPORT_TRIGGER; f.state.triggerEntities.push(jump, portal);
    f.state.predictedPlayerState.pmoveFramecount = 7;
    f.runtime.touchTriggerPrediction(point, f.settings()); f.runtime.touchTriggerPrediction(point, f.settings());
    expect(f.state.hyperspace).toBe(true); expect(f.state.predictedPlayerState.velocity).toEqual(vec3(100, 0, 200));
    expect(f.state.predictedPlayerState.eventSequence).toBe(1); expect(f.state.predictedPlayerState.events.get(0)).toBe(EntityEvent.EV_JUMP_PAD);
    expect(f.state.predictedPlayerState.jumppadFrame).toBe(7);
    f.state.predictedPlayerState.origin = vec3(100, 0, 0); f.state.predictedPlayerState.pmoveFramecount = 8;
    f.runtime.touchTriggerPrediction(point, f.settings()); expect(f.state.predictedPlayerState.jumppadEnt).toBe(0);
    f.state.predictedPlayerState.origin = zero; f.state.predictedPlayerState.pmType = MoveType.PM_SPECTATOR;
    f.runtime.touchTriggerPrediction(point, f.settings()); expect(f.state.predictedPlayerState.eventSequence).toBe(1);
  });
  test("predicts weapon event and minimal autoswitch ammo but does not apply full pickup", () => {
    const f = fixture(product), cent = f.state.entityAt(10);
    const index = itemList(product).findIndex(item => item.className === "weapon_rocketlauncher");
    cent.currentState.modelindex = index; cent.currentState.eType = EntityType.ET_ITEM;
    f.state.time = 100; f.runtime.touchItem(cent, f.settings()); f.runtime.touchItem(cent, f.settings());
    expect(f.state.predictedPlayerState.eventSequence).toBe(1); expect(f.state.predictedPlayerState.ammo.get(Weapon.WP_ROCKET_LAUNCHER)).toBe(1);
    expect(cent.currentState.eFlags & 0x80).toBe(0x80); expect(f.state.predictedPlayerState.health).toBe(100);
    f.state.time++; f.configure({ gameType: GameType.GT_1FCTF }); f.runtime.touchItem(cent, f.settings());
    expect(f.state.predictedPlayerState.eventSequence).toBe(product === "missionpack" ? 1 : 2);
  });
  test("CTF source tag-only own-flag check also skips the equal-tag railgun", () => {
    const f = fixture(product), cent = f.state.entityAt(10);
    cent.currentState.modelindex = itemList(product).findIndex(item => item.className === "weapon_railgun");
    f.state.predictedPlayerState.persistant.set(PersistentIndex.PERS_TEAM, Team.TEAM_RED);
    f.state.time = 100; f.configure({ gameType: GameType.GT_CTF }); f.runtime.touchItem(cent, f.settings());
    expect(f.state.predictedPlayerState.eventSequence).toBe(0); expect(cent.currentState.eFlags).toBe(0);
    f.configure({ gameType: GameType.GT_FFA }); f.runtime.touchItem(cent, f.settings());
    expect(f.state.predictedPlayerState.eventSequence).toBe(1);
  });
  test("commands replay actual movement, map restart rejects old commands, and exhaustion freezes", async () => {
    const f = fixture(product); f.commands.append(command(100)); f.state.time = 100; await f.runtime.predictPlayerState();
    expect(f.state.predictedPlayerState.commandTime).toBe(100); expect(f.state.predictedPlayerState.velocity.z).toBe(-80);
    // q3lcc + pinned vm_game=1: original CG_PredictPlayerState/Pmove, empty world.
    expect(float32ToBits(f.state.predictedPlayerState.origin.z)).toBe(49280 * 65536 + 14260);
    expect(f.calls).toContain("transition:0:100");
    const restart = snapshot(product, 0); f.state.snap = restart; f.state.nextFrameTeleport = true;
    f.commands.append(command(20)); f.state.time = 20; await f.runtime.predictPlayerState();
    expect(f.state.predictedPlayerState.commandTime).toBe(20); expect(f.state.predictedPlayerState.velocity.z).toBe(-16);
    const origin = f.state.predictedPlayerState.origin;
    for (let i = 0; i < 64; i++) f.commands.append(command(30 + i));
    f.state.time = 200; await f.runtime.predictPlayerState(); expect(f.state.predictedPlayerState.origin).toEqual(origin);
    expect(f.calls).toContain("exceeded PACKET_BACKUP on commands\n");
  });
  test("error decay accumulates at command-time reconciliation and teleports clear it only there", async () => {
    const f = fixture(product); f.state.validPPS = true; f.state.predictedPlayerState.origin = vec3(10, 0, 0);
    f.state.predictedError = vec3(4, 0, 0); f.state.predictedErrorTime = 50; f.state.time = 100; f.state.oldTime = 90;
    f.commands.append(command(10)); await f.runtime.predictPlayerState();
    expect(f.state.predictedError).toEqual(vec3(12, 0, 0)); expect(f.state.predictedErrorTime).toBe(90);
    f.state.thisFrameTeleport = true; await f.runtime.predictPlayerState(); expect(f.state.thisFrameTeleport).toBe(true);
    f.commands.append(command(20)); await f.runtime.predictPlayerState(); expect(f.state.thisFrameTeleport).toBe(false);
    expect(f.state.predictedError).toEqual(zero);
  });
  test("QVM prediction-error threshold compares binary32 0.1, not a JavaScript double", async () => {
    const f = fixture(product); f.state.validPPS = true; f.state.predictedPlayerState.origin = vec3(0.1, 0, 0);
    f.commands.append(command(10)); await f.runtime.predictPlayerState();
    expect(f.state.predictedError).toEqual(zero);
    expect(f.calls.some(message => message.startsWith("Prediction miss:"))).toBe(false);
  });
  test("fixed command rounding uses cached cvar and spectator/dead traces ignore bodies", async () => {
    const f = fixture(product); f.configure({ pmoveFixed: true, pmoveMsec: 4 }); f.commands.append(command(9));
    await f.runtime.predictPlayerState(); expect(f.calls).toContain("msec:8"); expect(f.state.predictedPlayerState.commandTime).toBe(12);
    const snap = snapshot(product, 0); snap.playerState.persistant.set(PersistentIndex.PERS_TEAM, Team.TEAM_SPECTATOR);
    snap.playerState.pmType = MoveType.PM_SPECTATOR; f.state.snap = snap; f.state.nextSnap = null;
    f.state.predictedPlayerState = snap.playerState.copy(); f.configure({ pmoveFixed: false });
    const body = f.state.entityAt(4); body.currentState.number = 4; body.currentState.solid = 8 | (8 << 8) | (40 << 16); f.state.solidEntities.push(body);
    f.commands.append({ ...command(100), forwardmove: 127 }); await f.runtime.predictPlayerState(); expect(f.state.predictedPlayerState.origin.x).toBeGreaterThan(0);
  });
  test("fixed prediction consumes cached intervals above 200 before the next cvar refresh", async () => {
    // cg_predict.c:492-500,580-584 writes 33 but rounds with the cached value.
    // bg_pmove.c:1895-1901 caps local simulation at 200, not commandTime.
    for (const row of [
      { cached: 201, nextTime: 231, remaining: 770 },
      { cached: 250, nextTime: 264, remaining: 786 },
      { cached: 1500, nextTime: 1518, remaining: 782 },
    ]) {
      const f = fixture(product), initial = snapshot(product, 0);
      initial.playerState.pmType = MoveType.PM_NOCLIP;
      initial.playerState.pmTime = 1000;
      f.state.snap = initial;
      f.configure({ pmoveFixed: true, pmoveMsec: row.cached });
      f.commands.append(command(1));
      await f.runtime.predictPlayerState();
      expect(f.calls).toContain("msec:33");
      expect(f.settings().pmoveMsec).toBe(row.cached);
      expect(f.state.predictedPlayerState.commandTime).toBe(row.cached);
      expect(f.state.predictedPlayerState.pmTime).toBe(800);
      expect(f.state.predictedPlayerState.pmoveFramecount).toBe(1);
      f.state.snap = { ...snapshot(product, row.cached), playerState: f.state.predictedPlayerState.copy() };
      f.configure({ pmoveMsec: 33 });
      f.commands.append(command(row.cached + 1));
      await f.runtime.predictPlayerState();
      expect(f.state.predictedPlayerState.commandTime).toBe(row.nextTime);
      expect(f.state.predictedPlayerState.pmTime).toBe(row.remaining);
      expect(f.state.predictedPlayerState.pmoveFramecount).toBe(2);
      expect(f.calls.filter(call => call.startsWith("msec:"))).toEqual(["msec:33"]);
    }
  });
  test("follow interpolates without local angles, while no-predict keeps local input", async () => {
    const f = fixture(product), snap = snapshot(product, 0); snap.playerState.pmFlags = MoveFlags.FOLLOW; f.state.snap = snap;
    f.commands.append({ ...command(50), angles: vec3(0, 16384, 0) }); await f.runtime.predictPlayerState();
    expect(f.state.predictedPlayerState.viewangles.y).toBe(0); snap.playerState.pmFlags = 0; f.configure({ noPredict: true });
    await f.runtime.predictPlayerState(); expect(f.state.predictedPlayerState.viewangles.y).toBe(90);
  });
  test("signed snapshot times interpolate, and future snapshots seed prediction unless a teleport blocks them", async () => {
    const f = fixture(product), previous = snapshot(product, -200), next = snapshot(product, -100);
    previous.playerState.origin = vec3(-10, 0, 0); next.playerState.origin = vec3(10, 0, 0);
    f.state.snap = previous; f.state.nextSnap = next; f.state.time = -150; f.runtime.interpolatePlayerState(false);
    expect(f.state.predictedPlayerState.origin.x).toBe(0);
    const current = snapshot(product, 100), future = snapshot(product, 200);
    future.playerState.origin = vec3(100, 0, 0); future.playerState.commandTime = 20;
    f.state.snap = current; f.state.nextSnap = future; f.state.time = 150;
    await f.runtime.predictPlayerState(); expect(f.state.physicsTime).toBe(200); expect(f.state.predictedPlayerState.origin.x).toBe(100);
    f.state.nextFrameTeleport = true; await f.runtime.predictPlayerState(); expect(f.state.physicsTime).toBe(100);
    expect(f.state.predictedPlayerState.origin.x).toBe(0);
  });
  test("moving ground adjustment follows source physics and render clocks", async () => {
    const f = fixture(product), mover = f.state.entityAt(10), snap = snapshot(product, 0);
    mover.currentState.eType = EntityType.ET_MOVER;
    mover.currentState.pos = { type: TrajectoryType.TR_LINEAR, base: zero, delta: vec3(50, 0, 0), time: 0, duration: 0 };
    snap.playerState.pmType = MoveType.PM_FREEZE; snap.playerState.groundEntityNum = 10;
    f.state.snap = snap; f.state.time = 100; f.commands.append(command(10)); await f.runtime.predictPlayerState();
    expect(f.state.predictedPlayerState.origin).toEqual(vec3(5, 0, 0)); expect(snap.playerState.origin).toEqual(zero);
  });
  test("flight and dead state do not fire jump pads, and disabled item prediction does not hide items", () => {
    const f = fixture(product), jump = f.state.entityAt(5);
    jump.currentState.number = 5; jump.currentState.eType = EntityType.ET_PUSH_TRIGGER; jump.currentState.solid = 0xffffff;
    jump.currentState.modelindex = 1; jump.currentState.origin2 = vec3(0, 0, 500); f.state.triggerEntities.push(jump);
    f.state.predictedPlayerState.powerups.set(Powerup.PW_FLIGHT, 1);
    f.runtime.touchTriggerPrediction(point, f.settings()); expect(f.state.predictedPlayerState.velocity).toEqual(zero);
    f.state.predictedPlayerState.powerups.set(Powerup.PW_FLIGHT, 0); f.state.predictedPlayerState.health = 0;
    f.runtime.touchTriggerPrediction(point, f.settings()); expect(f.state.predictedPlayerState.eventSequence).toBe(0);
    const item = f.state.entityAt(6); item.currentState.modelindex = itemList(product).findIndex(entry => entry.className === "weapon_rocketlauncher");
    f.state.time = 100; f.configure({ predictItems: false }); f.runtime.touchItem(item, f.settings()); expect(item.currentState.eFlags).toBe(0);
  });
});

const dataPath = Bun.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
for (const product of products) test.skipIf(!existsSync(join(dataPath, product, "pak0.pk3")))(`${product} unacknowledged commands replay through retail BSP collision`, async () => {
  const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
  const bsp = parseBsp(await vfs.read(`maps/${product === "baseq3" ? "q3dm1" : "mpteam1"}.bsp`));
  const originText = bsp.entityRecords.find(entity => entity.get("classname") === "info_player_deathmatch")?.get("origin");
  if (originText === undefined) throw new Error("Retail fixture requires deathmatch spawn");
  const [x, y, z] = originText.split(/\s+/).map(Number);
  if (x === undefined || y === undefined || z === undefined) throw new Error("Invalid retail spawn");
  const state = new ClientGameState(product, 0, 0), commands = new ClientCommandHistory(), transitions: number[] = [];
  const initial = snapshot(product, 0); initial.playerState.origin = vec3(x, y, z + 1); state.snap = initial;
  const collision = new CollisionWorld(bsp, { kind: "unaccounted" }, { kind: "disabled" }), settings: PredictionSettings = {
    gameType: GameType.GT_FFA, dmFlags: 0, demoPlayback: false, noPredict: false, synchronousClients: false,
    predictItems: true, pmoveFixed: false, pmoveMsec: 8, errorDecayInteger: 100, errorDecayValue: 100, showMiss: 0 };
  const runtime = new PredictionRuntime(state, collision, { commands, settings: () => settings,
    setPmoveMsec: () => { throw new Error("Fixture uses valid cvar"); }, warn: message => { throw new Error(message); },
    transitionPlayerState: async current => { transitions.push(current.commandTime); } });
  const authoritative = initial.playerState.copy();
  for (let index = 1; index <= 10; index++) {
    const cmd = { ...command(index * 40), forwardmove: 127 };
    commands.append(cmd);
    movePlayer(authoritative, cmd, { trace: (start, end, bounds, skip, mask) => runtime.trace(start, end, bounds, skip, mask),
      pointContents: (position, skip) => runtime.pointContents(position, skip) });
    state.oldTime = state.time; state.time = cmd.serverTime; await runtime.predictPlayerState();
    expect(state.predictedPlayerState.origin).toEqual(authoritative.origin);
    expect(state.predictedPlayerState.velocity).toEqual(authoritative.velocity);
  }
  expect(transitions).toEqual([40, 80, 120, 160, 200, 240, 280, 320, 360, 400]);
  expect(state.predictedPlayerState.origin).not.toEqual(initial.playerState.origin);
  expect(initial.playerState.commandTime).toBe(0);
});
