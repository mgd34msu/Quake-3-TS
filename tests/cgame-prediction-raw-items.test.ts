// Source branches: id Software cg_predict.c:CG_TouchItem and bg_misc.c:BG_CanItemBeGrabbed.
import { expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { ClientCommandHistory, PredictionRuntime } from "../src/cgame/prediction.ts";
import type { PredictionSettings } from "../src/cgame/prediction.ts";
import { SnapshotHistory } from "../src/cgame/snapshot-history.ts";
import { HistorySnapshotSource, SnapshotRuntime } from "../src/cgame/snapshots.ts";
import { ClientGameState } from "../src/cgame/state.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import { MessageReader, MessageWriter } from "../src/protocol/message.ts";
import type { Snapshot } from "../src/protocol/server-message.ts";
import { readDeltaPlayerState, writeDeltaPlayerState } from "../src/protocol/state-delta.ts";
import { EntityEvent, EntityType, GameType, PersistentIndex, Team, Weapon, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { EntityState } from "../src/shared/entity-state.ts";
import { itemList } from "../src/shared/items.ts";
import { createPlayerState } from "../src/shared/player-state.ts";

function emptyWorld(): CollisionWorld {
  const bounds = { min: vec3(-1000, -1000, -1000), max: vec3(1000, 1000, 1000) };
  const map: BspMap = {
    entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [],
    models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null,
  };
  return new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
}

async function fixture(product: Product, team: number, persistentIndex: number, className: string, gameType = GameType.GT_FFA) {
  const player = createPlayerState(product), schema = statSchema(product);
  player.health = 100; player.speed = 320; player.gravity = 800; player.groundEntityNum = 1023;
  player.stats.set(schema.maxHealth, 100);
  player.persistant.set(PersistentIndex.PERS_TEAM, team);
  if (schema.product === "missionpack") player.stats.set(schema.persistentPowerup, persistentIndex);
  const writer = new MessageWriter();
  writeDeltaPlayerState(writer, null, player);
  const item = new EntityState(); item.number = 10; item.eType = EntityType.ET_ITEM;
  item.modelindex = itemList(product).findIndex(entry => entry.className === className);
  if (item.modelindex < 1) throw new Error(`Missing item ${className}`);
  const snapshot: Snapshot = {
    messageNumber: 1, serverTime: 0, deltaNumber: -1, flags: 0, serverCommandNumber: 0, parseEntitiesNumber: 0,
    areaMask: new Uint8Array(32), playerState: readDeltaPlayerState(new MessageReader(writer.toBytes()), null, product), entities: [item],
  };
  const state = new ClientGameState(product, 0, 0), history = new SnapshotHistory(), calls: string[] = [];
  history.publish({ kind: "snapshot", validity: { kind: "valid" }, snapshot });
  const source = new HistorySnapshotSource(history, () => 0, message => { calls.push(message); });
  const snapshots = new SnapshotRuntime(state, {
    source, demoPlayback: false, noPredict: false, synchronousClients: false,
    executeServerCommands: async sequence => { calls.push(`commands:${sequence}`); },
    respawn: () => { calls.push("respawn"); },
    resetPlayerEntity: entity => { calls.push(`reset:${entity.currentState.number}`); },
    checkEvents: async entity => { calls.push(`events:${entity.currentState.number}`); },
    transitionPlayerState: async current => { calls.push(`snapshot-transition:${current.commandTime}`); },
    lagometerSnapshot: value => { calls.push(`snapshot:${value?.messageNumber}`); },
    warn: message => { calls.push(message); },
  });
  await snapshots.processSnapshots();
  history.publish({ kind: "snapshot", validity: { kind: "valid" }, snapshot: { ...snapshot, messageNumber: 2, serverTime: 1 } });
  state.time = 2;
  await snapshots.processSnapshots();
  const settings: PredictionSettings = {
    gameType, dmFlags: 0, demoPlayback: false, noPredict: false, synchronousClients: false,
    predictItems: true, pmoveFixed: false, pmoveMsec: 8, errorDecayInteger: 100, errorDecayValue: 100, showMiss: 0,
  };
  const commands = new ClientCommandHistory();
  commands.append({ serverTime: 2, angles: vec3(0, 0, 0), buttons: 0, weapon: Weapon.WP_NONE, forwardmove: 0, rightmove: 0, upmove: 0 });
  const runtime = new PredictionRuntime(state, emptyWorld(), {
    commands, settings: () => settings,
    setPmoveMsec: value => { calls.push(`msec:${value}`); },
    transitionPlayerState: async current => { calls.push(`prediction-transition:${current.commandTime}`); },
    warn: message => { calls.push(message); },
  });
  return { state, runtime, settings, calls, item: state.entityAt(item.number), snapshot };
}

const products: readonly Product[] = ["baseq3", "missionpack"];
for (const product of products) {
  test(`${product} predicts a wire snapshot weapon pickup with PERS_TEAM 4`, async () => {
    const f = await fixture(product, 4, 0, "weapon_rocketlauncher");
    expect(f.state.snap?.playerState.persistant.get(PersistentIndex.PERS_TEAM)).toBe(4);
    await f.runtime.predictPlayerState();
    const ps = f.state.predictedPlayerState;
    expect(ps.commandTime).toBe(2);
    expect(ps.persistant.get(PersistentIndex.PERS_TEAM)).toBe(4);
    expect(ps.eventSequence).toBe(1);
    expect(ps.events.get(0)).toBe(EntityEvent.EV_ITEM_PICKUP);
    expect(ps.eventParms.get(0)).toBe(f.item.currentState.modelindex);
    expect(ps.stats.get(statSchema(product).weapons) & (1 << Weapon.WP_ROCKET_LAUNCHER)).toBe(1 << Weapon.WP_ROCKET_LAUNCHER);
    expect(ps.ammo.get(Weapon.WP_ROCKET_LAUNCHER)).toBe(1);
    expect(f.item.currentState.eFlags & 0x80).toBe(0x80);
    expect(f.item.miscTime).toBe(2);
    expect(f.calls).toContain("prediction-transition:2");
    f.runtime.touchItem(f.item, f.settings);
    expect(ps.eventSequence).toBe(1);
    expect(f.snapshot.playerState.eventSequence).toBe(0);
    expect(f.snapshot.entities[0]?.eFlags).toBe(0);
  });

  test(`${product} unknown teams cannot predict a CTF flag pickup`, async () => {
    const f = await fixture(product, 4, 0, "team_CTF_redflag", GameType.GT_CTF);
    await f.runtime.predictPlayerState();
    expect(f.state.predictedPlayerState.eventSequence).toBe(0);
    expect(f.item.currentState.eFlags).toBe(0);
    expect(f.item.miscTime).toBe(0);
  });
}

test("missionpack predicts a weapon with a valid nonpersistent item in the persistent stat", async () => {
  const persistentIndex = itemList("missionpack").findIndex(item => item.className === "item_armor_shard");
  const f = await fixture("missionpack", Team.TEAM_FREE, persistentIndex, "weapon_rocketlauncher");
  expect(persistentIndex).toBe(1);
  await f.runtime.predictPlayerState();
  const ps = f.state.predictedPlayerState, schema = statSchema("missionpack");
  if (schema.product !== "missionpack") throw new Error("Expected missionpack stat schema");
  expect(ps.stats.get(schema.persistentPowerup)).toBe(persistentIndex);
  expect(ps.eventSequence).toBe(1);
  expect(ps.events.get(0)).toBe(EntityEvent.EV_ITEM_PICKUP);
  expect(ps.eventParms.get(0)).toBe(f.item.currentState.modelindex);
  expect(ps.ammo.get(Weapon.WP_ROCKET_LAUNCHER)).toBe(1);
  expect(f.item.currentState.eFlags & 0x80).toBe(0x80);
  expect(f.item.miscTime).toBe(2);
});
