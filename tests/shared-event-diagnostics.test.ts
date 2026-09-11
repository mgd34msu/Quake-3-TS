// id Software bg_misc.c:BG_AddPredictableEventToPlayerstate _DEBUG branch.
import { expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { ClientCommandHistory, PredictionRuntime } from "../src/cgame/prediction.ts";
import { ClientGameState } from "../src/cgame/state.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import { EntityPool } from "../src/game/entities.ts";
import { EntityEvent, GameType, Weapon, statSchema } from "../src/shared/definitions.ts";
import { EntityState } from "../src/shared/entity-state.ts";
import { touchJumpPad } from "../src/shared/jump-pad.ts";
import { movePlayer } from "../src/shared/movement.ts";
import { CommandButtons, createPlayerState } from "../src/shared/player-state.ts";
import type { PredictableEventDebug } from "../src/shared/player-state.ts";

test("game producer logs before writes, retains live showevents and wraps the event ring", () => {
  let value = "0", reads = 0;
  const lines: string[] = [], before: number[] = [];
  const debug: PredictableEventDebug = { kind: "source-debug", module: "game",
    showEvents: () => { reads++; return value; },
    print: message => { lines.push(message); before.push(pool.clientAt(0).ps.eventSequence); } };
  const pool = new EntityPool({ product: "baseq3", maxClients: 1, mapStartTime: 0,
    time: () => 0, print: () => {}, link: () => {}, unlink: () => {}, eventDebug: debug });
  const ps = pool.clientAt(0).ps, player = pool.at(0);
  ps.pmoveFramecount = 17;
  pool.addPredictableEvent(player, EntityEvent.EV_ITEM_PICKUP, 9);
  expect(lines).toEqual([]);
  value = " .25suffix";
  pool.addPredictableEvent(player, EntityEvent.EV_ITEM_PICKUP, 10);
  pool.addPredictableEvent(player, EntityEvent.EV_ITEM_PICKUP, 11);
  pool.addPredictableEvent(player, EntityEvent.EV_FIRE_WEAPON);
  expect(before).toEqual([1, 2, 3]);
  expect(lines).toEqual([
    " game event svt    17 ->     1: num =       EV_ITEM_PICKUP parm 10\n",
    " game event svt    17 ->     2: num =       EV_ITEM_PICKUP parm 11\n",
    " game event svt    17 ->     3: num =       EV_FIRE_WEAPON parm 0\n",
  ]);
  expect(ps.eventSequence).toBe(4);
  expect(ps.events.copy()).toEqual(new Int32Array([19, 23]));
  expect(ps.eventParms.copy()).toEqual(new Int32Array([11, 0]));
  pool.initializeClients(1);
  pool.addPredictableEvent(player, EntityEvent.EV_FIRE_WEAPON);
  expect(lines.at(-1)).toBe(" game event svt     0 ->     0: num =       EV_FIRE_WEAPON parm 0\n");
  expect(reads).toBe(5);
});

test("movement and jump-pad events reach the bound diagnostic and copies stay unbound", () => {
  const ps = createPlayerState("missionpack"), lines: string[] = [];
  ps.health = 100; ps.weapon = Weapon.WP_MACHINEGUN; ps.ammo.set(Weapon.WP_MACHINEGUN, 5);
  ps.stats.set(statSchema("missionpack").weapons, 1 << Weapon.WP_MACHINEGUN);
  ps.setEventDebug({ kind: "source-debug", module: "cgame", showEvents: () => "1", print: text => { lines.push(text); } });
  movePlayer(ps, { serverTime: 10, angles: vec3(0, 0, 0), buttons: CommandButtons.ATTACK,
    weapon: Weapon.WP_MACHINEGUN, forwardmove: 0, rightmove: 0, upmove: 0 }, {
    trace: (_start, end) => ({ fraction: 1, end, solidity: "clear", contact: { kind: "none" }, surfaceFlags: 0, contents: 0, entityNum: 1023 }),
    pointContents: () => 0,
  });
  const pad = new EntityState(); pad.number = 4; pad.origin2 = vec3(0, 0, 500);
  touchJumpPad(ps, pad);
  expect(lines).toEqual([
    "Cgame event svt     1 ->     0: num =       EV_FIRE_WEAPON parm 0\n",
    "Cgame event svt     1 ->     1: num =          EV_JUMP_PAD parm 1\n",
  ]);
  const copy = ps.copy(); copy.addEvent(EntityEvent.EV_FIRE_WEAPON);
  expect(lines.length).toBe(2);
  ps.copyFrom(copy); ps.addEvent(EntityEvent.EV_FIRE_WEAPON);
  expect(lines.at(-1)).toBe("Cgame event svt     1 ->     3: num =       EV_FIRE_WEAPON parm 0\n");
});

test("source name-table quirks and undefined entries affect only enabled diagnostics", () => {
  const ps = createPlayerState("missionpack"), lines: string[] = [];
  ps.addEvent(EntityEvent.EV_TAUNT_PATROL);
  let value = "";
  ps.setEventDebug({ kind: "source-debug", module: "game", showEvents: () => value, print: text => { lines.push(text); } });
  ps.addEvent(EntityEvent.EV_TAUNT_PATROL);
  value = "1";
  ps.addEvent(EntityEvent.EV_OBELISKPAIN);
  expect(lines[0]).toContain("num =      EV_INVUL_IMPACT parm 0");
  expect(() => ps.addEvent(EntityEvent.EV_TAUNT_PATROL)).toThrow("bg_misc.c eventnames has no entry for 82");
  expect(ps.eventSequence).toBe(3);
  ps.setEventDebug(null); ps.addEvent(EntityEvent.EV_TAUNT_PATROL);
  expect(ps.eventSequence).toBe(4);
});

test("prediction binds each copied snapshot player before actual firing", async () => {
  const bounds = { min: vec3(-1000, -1000, -1000), max: vec3(1000, 1000, 1000) };
  const map: BspMap = { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
  const state = new ClientGameState("baseq3", 0, 0), commands = new ClientCommandHistory(), lines: string[] = [];
  const ps = createPlayerState("baseq3");
  ps.health = 100; ps.weapon = Weapon.WP_MACHINEGUN; ps.ammo.set(Weapon.WP_MACHINEGUN, 5);
  ps.stats.set(statSchema("baseq3").weapons, 1 << Weapon.WP_MACHINEGUN);
  state.snap = { messageNumber: 1, serverTime: 0, deltaNumber: -1, flags: 0, serverCommandNumber: 0,
    parseEntitiesNumber: 0, areaMask: new Uint8Array(32), playerState: ps, entities: [] };
  commands.append({ serverTime: 10, angles: vec3(0, 0, 0), buttons: CommandButtons.ATTACK,
    weapon: Weapon.WP_MACHINEGUN, forwardmove: 0, rightmove: 0, upmove: 0 });
  const prediction = new PredictionRuntime(state, new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" }), {
    commands, eventDebug: { kind: "source-debug", module: "cgame", showEvents: () => "1", print: text => { lines.push(text); } },
    settings: () => ({ gameType: GameType.GT_FFA, dmFlags: 0, demoPlayback: false, noPredict: false, synchronousClients: false,
      predictItems: true, pmoveFixed: false, pmoveMsec: 8, errorDecayInteger: 100, errorDecayValue: 100, showMiss: 0 }),
    setPmoveMsec: () => {}, transitionPlayerState: async () => {}, warn: () => {},
  });
  await prediction.predictPlayerState();
  await prediction.predictPlayerState();
  expect(lines).toEqual([
    "Cgame event svt     1 ->     0: num =       EV_FIRE_WEAPON parm 0\n",
    "Cgame event svt     1 ->     0: num =       EV_FIRE_WEAPON parm 0\n",
  ]);
  expect(ps.eventSequence).toBe(0);
  expect(state.predictedPlayerState.eventSequence).toBe(1);
});
