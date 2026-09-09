// Full upstream cg_playerstate.c native i386 and q3lcc/QVM fixtures:
// /tmp/quake3-playerstate-reference-Nf8SCZ, both products.
import { describe, expect, test } from "bun:test";
import type { PcmSound } from "../src/assets/wav.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { anglesToAxis, vec3 } from "../src/core/math.ts";
import { float32ToBits } from "../src/core/numeric.ts";
import { PlayerStateRuntime } from "../src/cgame/player-state.ts";
import type { MissionPlayerStateSound, PlayerStateHost, PlayerStateSound, RewardMedal } from "../src/cgame/player-state.ts";
import { ClientGameState, ClientGameStaticState } from "../src/cgame/state.ts";
import { SnapshotHistory } from "../src/cgame/snapshot-history.ts";
import { HistorySnapshotSource, SnapshotRuntime } from "../src/cgame/snapshots.ts";
import { EntityEvent, GameType, MoveType, PersistentIndex as P, Powerup, Team, Weapon, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { createPlayerState } from "../src/shared/player-state.ts";
import type { SceneShader } from "../src/render/ref-entity.ts";

const products: readonly Product[] = ["baseq3", "missionpack"];
function fixture(product: Product) {
  const state = new ClientGameState(product, 0, 0), staticState = new ClientGameStaticState(product);
  const calls: string[] = [], names = new Map<PcmSound, string>(), mixer = new AudioMixer(22050, () => 0);
  mixer.setEffectsVolume(1);
  const sound = (name: string): PcmSound => {
    const pcm: PcmSound = { sampleRate: 22050, channels: 1, frameCount: 16, samples: new Int16Array(16).fill(1024), loopStart: null };
    names.set(pcm, name); return pcm;
  };
  const sounds: Record<PlayerStateSound, PcmSound | null> = {
    noAmmoSound: sound("ammo"), hitSound: sound("hit"), hitTeamSound: sound("team-hit"), captureAwardSound: sound("capture"),
    impressiveSound: sound("impressive"), excellentSound: sound("excellent"), humiliationSound: sound("humiliation"),
    defendSound: sound("defend"), assistSound: sound("assist"), deniedSound: sound("denied"), holyShitSound: sound("holy"),
    youHaveFlagSound: sound("flag"), takenLeadSound: sound("lead"), tiedLeadSound: sound("tied"), lostLeadSound: sound("lost"),
    suddenDeathSound: sound("sudden"), oneMinuteSound: sound("minute"), fiveMinuteSound: sound("five"),
    oneFragSound: sound("one-frag"), twoFragSound: sound("two-frag"), threeFragSound: sound("three-frag"),
  };
  const missionSounds: Record<MissionPlayerStateSound, PcmSound | null> = {
    hitSoundHighArmor: sound("high-armor"), hitSoundLowArmor: sound("low-armor"), firstImpressiveSound: sound("first-impressive"),
    firstExcellentSound: sound("first-excellent"), firstHumiliationSound: sound("first-humiliation"),
  };
  const medals: Record<RewardMedal, SceneShader | null> = {
    medalCapture: { name: "capture" }, medalImpressive: { name: "impressive" }, medalExcellent: { name: "excellent" },
    medalGauntlet: { name: "gauntlet" }, medalDefend: { name: "defend" }, medalAssist: { name: "assist" },
  };
  const nameOf = (value: PcmSound | null): string => {
    if (value === null) return "zero";
    const name = names.get(value);
    if (name === undefined) throw new Error("Fixture sound is unregistered");
    return name;
  };
  const common = { staticState, sounds, medals, showMiss: true,
    events: { entityEvent: async (entity: Parameters<PlayerStateHost["events"]["entityEvent"]>[0]) => {
      calls.push(`event:${entity === state.predictedPlayerEntity ? "predicted" : entity.currentState.number}:${entity.currentState.event}:${entity.currentState.eventParm}`);
    }, painEvent: (_entity: Parameters<PlayerStateHost["events"]["painEvent"]>[0], health: number) => { calls.push(`pain:${health}`); } },
    startLocalSound: (pcm: PcmSound | null, channel: number) => {
      calls.push(`local:${nameOf(pcm)}:${channel}`);
      if (pcm !== null) mixer.startSound(pcm, { entity: 0, channel, origin: { kind: "local" }, volume: 127 });
    }, addBufferedSound: (pcm: PcmSound | null) => { calls.push(`buffer:${nameOf(pcm)}`); },
    print: (text: string) => { calls.push(text); } };
  const host: PlayerStateHost = product === "baseq3" ? { ...common, product } : { ...common, product, missionSounds };
  const ps = createPlayerState(product); ps.health = 100; ps.viewheight = 26;
  ps.stats.set(statSchema(product).weapons, 1 << Weapon.WP_MACHINEGUN); ps.ammo.set(Weapon.WP_MACHINEGUN, 50);
  state.snap = { messageNumber: 1, serverTime: 900, deltaNumber: -1, flags: 0, serverCommandNumber: 0, parseEntitiesNumber: 0,
    areaMask: new Uint8Array(32), playerState: ps, entities: [] };
  state.time = 1000; state.refdef.viewAxis = anglesToAxis(vec3(0, 0, 0));
  return { state, staticState, calls, mixer, ps, nameOf, runtime: new PlayerStateRuntime(state, host) };
}

for (const product of products) describe(`${product} CG_TransitionPlayerState`, () => {
  for (const fail of [false, true]) test(`awaited events ${fail ? "reject before" : "complete before"} predictable history and duck smoothing`, async () => {
    const f = fixture(product), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const runtime = new PlayerStateRuntime(f.state, { ...f.runtime.host, events: { ...f.runtime.host.events,
      entityEvent: async entity => { f.calls.push(`pending:${entity.currentState.event}`); entered.resolve(); await gate.promise; }
    } });
    const previous = f.ps.copy(), current = previous.copy(); current.addEvent(EntityEvent.EV_JUMP, 1); current.viewheight = 12;
    const work = runtime.transitionPlayerState(current, previous); await entered.promise;
    expect(f.state.predictedPlayerEntity.currentState.event).toBe(EntityEvent.EV_JUMP);
    expect([f.state.eventSequence, f.state.predictableEvents.get(0), f.state.duckChange, f.state.duckTime]).toEqual([0, 0, 0, 0]);
    if (fail) {
      gate.reject(new Error("event failed")); await expect(work).rejects.toThrow("event failed");
      expect([f.state.eventSequence, f.state.predictableEvents.get(0), f.state.duckTime]).toEqual([0, 0, 0]);
    } else {
      gate.resolve(); await work;
      expect([f.state.eventSequence, f.state.predictableEvents.get(0), f.state.duckChange, f.state.duckTime]).toEqual([1, EntityEvent.EV_JUMP, -14, 1000]);
    }
  });
  test("corrected predictable history is not replaced until its event completes", async () => {
    const f = fixture(product), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const runtime = new PlayerStateRuntime(f.state, { ...f.runtime.host, events: { ...f.runtime.host.events,
      entityEvent: async () => { entered.resolve(); await gate.promise; }
    } });
    f.state.eventSequence = 1; const ps = f.ps.copy(); ps.addEvent(EntityEvent.EV_JUMP, 1);
    const work = runtime.checkChangedPredictableEvents(ps); await entered.promise;
    expect(f.state.predictableEvents.get(0)).toBe(0); expect(f.calls).toEqual([]);
    gate.resolve(); await work;
    expect(f.state.predictableEvents.get(0)).toBe(EntityEvent.EV_JUMP); expect(f.calls).toEqual(["WARNING: changed predicted event\n"]);
  });
  test("low ammo uses snapshot weapons and source weighted milliseconds, including negative ammo", () => {
    const f = fixture(product);
    f.runtime.checkAmmo(); expect(f.state.lowAmmoWarning).toBe(0); expect(f.calls).toEqual([]);
    f.ps.ammo.set(Weapon.WP_MACHINEGUN, 24); f.runtime.checkAmmo(); f.runtime.checkAmmo();
    expect(f.state.lowAmmoWarning).toBe(1); expect(f.calls).toEqual(["local:ammo:6"]);
    expect(f.mixer.mix(4).some(sample => sample > 0)).toBe(true);
    f.ps.ammo.set(Weapon.WP_MACHINEGUN, 0); f.runtime.checkAmmo(); expect(f.state.lowAmmoWarning).toBe(2);
    f.ps.ammo.set(Weapon.WP_MACHINEGUN, -1); f.runtime.checkAmmo(); expect(f.state.lowAmmoWarning).toBe(1);
    f.ps.stats.set(statSchema(product).weapons, 1 << Weapon.WP_ROCKET_LAUNCHER); f.ps.ammo.set(Weapon.WP_ROCKET_LAUNCHER, 5);
    f.runtime.checkAmmo(); expect(f.state.lowAmmoWarning).toBe(0);
  });
  test("centered damage preserves distinct server-time feedback and float deadline", () => {
    const f = fixture(product); f.runtime.damageFeedback(255, 255, 1);
    expect([f.state.damageX, f.state.damageY, f.state.damagePitch, f.state.damageRoll, f.state.damageValue]).toEqual([0, 0, -5, 0, 5]);
    expect(f.state.attackerTime).toBe(1000); expect(f.state.damageTime).toBe(900); expect(f.state.damageKickEndTime).toBe(1500);
    f.ps.health = 20; f.runtime.damageFeedback(255, 255, 100); expect(f.state.damagePitch).toBe(-10);
    f.state.time = 2147483600; f.runtime.damageFeedback(255, 255, 1); expect(f.state.damageKickEndTime).toBe(Math.fround(-2147483196));
    if (f.state.snap === null) throw new Error("Fixture needs snapshot");
    f.state.snap = { ...f.state.snap, serverTime: 16777217 }; f.runtime.damageFeedback(255, 255, 1);
    expect(f.state.damageTime).toBe(16777216);
  });
  test("directional damage uses view basis, health kick, clamping and binary32 storage", () => {
    const f = fixture(product); f.runtime.damageFeedback(0, 0, 20);
    expect(f.state.damagePitch).toBe(8); expect(f.state.damageValue).toBe(8); expect(f.state.damageY).toBe(0);
    f.runtime.damageFeedback(64, 32, 20);
    expect(f.state.damageX).toBe(1); expect(f.state.damageY).toBe(1);
    // Full cg_playerstate.c, native i386 and q3lcc vm_game=1 agree for this direction.
    expect(float32ToBits(f.state.damageRoll)).toBe(49332 * 65536 + 29984);
    expect(float32ToBits(f.state.damagePitch)).toBe(48398 * 65536 + 19034);
    f.state.refdef.viewAxis = anglesToAxis(vec3(0, 90, 0)); f.runtime.damageFeedback(0, 0, 20);
    expect(f.state.damageX).toBe(-1); expect(f.state.damageRoll).toBe(8);
  });
  test("directional damage rounds the source AngleVectors constant before multiplying byte angles", () => {
    const f = fixture(product);
    // cg_playerstate.c calls q_math.c AngleVectors, whose Q3_VM radians constant is CNSTF4 1016003125.
    f.runtime.damageFeedback(5, 7, 20);
    expect(float32ToBits(f.state.damageRoll)).toBe(0xbf77f0e0);
    expect(float32ToBits(f.state.damagePitch)).toBe(0x40fa4a3c);
    f.runtime.damageFeedback(127, 64, 20);
    expect(float32ToBits(f.state.damageRoll)).toBe(0x3a1f278d);
    expect(float32ToBits(f.state.damagePitch)).toBe(0x3d49d61e);
    f.runtime.damageFeedback(200, 150, 20);
    expect(float32ToBits(f.state.damageRoll)).toBe(0xc0d49dd3);
    expect(float32ToBits(f.state.damagePitch)).toBe(0xbfba4146);
  });
  test("external and two-slot predictable events dispatch in source order and do not replay unchanged state", async () => {
    const f = fixture(product), previous = f.ps.copy(), current = previous.copy();
    current.externalEvent = EntityEvent.EV_PAIN; current.externalEventParm = 77;
    current.addEvent(EntityEvent.EV_JUMP, 1); current.addEvent(EntityEvent.EV_FIRE_WEAPON, 2); current.addEvent(EntityEvent.EV_NOAMMO, 3);
    await f.runtime.checkPlayerstateEvents(current, previous);
    expect(f.calls).toEqual(["event:0:56:77", "event:predicted:23:2", "event:predicted:21:3"]);
    expect(f.state.eventSequence).toBe(2); expect(f.state.predictableEvents.get(1)).toBe(23);
    f.calls.length = 0; await f.runtime.checkPlayerstateEvents(current, current.copy()); expect(f.calls).toEqual([]);
    const sameEvent = current.copy(); current.externalEventParm = 99;
    current.eventParms.set(0, 99); await f.runtime.checkPlayerstateEvents(current, sameEvent); expect(f.calls).toEqual([]);
  });
  test("changed predictable events honor strict history boundary and do not advance sequence", async () => {
    const f = fixture(product); f.state.eventSequence = 18;
    const ps = f.ps.copy(); ps.eventSequence = 4; ps.events.set(0, 7); ps.events.set(1, 8); ps.eventParms.set(1, 9);
    await f.runtime.checkChangedPredictableEvents(ps);
    expect(f.calls).toEqual(["event:predicted:8:9", "WARNING: changed predicted event\n"]);
    expect(f.state.eventSequence).toBe(18); expect(f.state.predictableEvents.get(2)).toBe(0); expect(f.state.predictableEvents.get(3)).toBe(8);
    f.calls.length = 0; await f.runtime.checkChangedPredictableEvents(ps); expect(f.calls).toEqual([]);
  });
  test("follow switch overwrites previous with a complete independent player-state copy", async () => {
    const f = fixture(product), current = f.ps.copy(), previous = f.ps.copy();
    current.clientNum = 1; current.origin = vec3(1, 2, 3); current.viewheight = 12; current.damageEvent = 1; current.damageCount = 50;
    current.stats.set(8, 89); current.persistant.set(10, 4); current.powerups.set(3, 123); current.ammo.set(7, 17);
    current.addEvent(19, 8); await f.runtime.transitionPlayerState(current, previous);
    expect(previous).toEqual(current); expect(f.state.thisFrameTeleport).toBe(true); expect(f.state.duckTime).toBe(0); expect(f.state.attackerTime).toBe(0);
    previous.stats.set(8, 1); previous.persistant.set(10, 1); previous.powerups.set(3, 1); previous.ammo.set(7, 1); previous.events.set(0, 1); previous.eventParms.set(0, 1);
    previous.origin = vec3(9, 9, 9);
    expect([current.stats.get(8), current.persistant.get(10), current.powerups.get(3), current.ammo.get(7), current.events.get(0), current.eventParms.get(0)]).toEqual([89, 4, 123, 17, 19, 8]);
    expect(current.origin).toEqual(vec3(1, 2, 3));
  });
  test("spawn/map-restart selects snapshot weapon, then pain/ammo/events and duck follow source order", async () => {
    const f = fixture(product), current = f.ps.copy(), previous = f.ps.copy();
    f.ps.weapon = Weapon.WP_RAILGUN; current.weapon = Weapon.WP_ROCKET_LAUNCHER;
    current.persistant.set(P.PERS_SPAWN_COUNT, 1); current.health = 80; current.viewheight = 12; current.addEvent(EntityEvent.EV_JUMP, 0);
    f.state.mapRestart = true; await f.runtime.transitionPlayerState(current, previous);
    expect(f.state.weaponSelect).toBe(Weapon.WP_RAILGUN); expect(f.state.weaponSelectTime).toBe(1000); expect(f.state.mapRestart).toBe(false);
    expect(f.calls).toEqual(["pain:80", "event:predicted:14:0"]); expect(f.state.duckChange).toBe(-14); expect(f.state.duckTime).toBe(1000);
  });
  test("hit feedback precedes pain and intermission suppresses only subsequent voices", () => {
    const f = fixture(product), current = f.ps.copy(), previous = f.ps.copy(); current.persistant.set(P.PERS_HITS, 1);
    current.persistant.set(P.PERS_ATTACKEE_ARMOR, (100 << 8) | 51); current.health = 98; current.persistant.set(P.PERS_CAPTURES, 1);
    f.state.intermissionStarted = true; f.runtime.checkLocalSounds(current, previous);
    expect(f.calls).toEqual([`local:${product === "missionpack" ? "high-armor" : "hit"}:6`, "pain:98"]); expect(f.state.rewardStack).toBe(0);
    f.calls.length = 0; current.persistant.set(P.PERS_HITS, -1); current.health = 99; f.runtime.checkLocalSounds(current, previous);
    expect(f.calls).toEqual(["local:team-hit:6"]);
    f.calls.length = 0; current.persistant.set(P.PERS_TEAM, Team.TEAM_RED); f.runtime.checkLocalSounds(current, previous); expect(f.calls).toEqual([]);
  });
  test("reward order, source first-humiliation old-count quirk, and full-stack behavior", () => {
    const f = fixture(product), current = f.ps.copy(), previous = f.ps.copy();
    for (const index of [P.PERS_CAPTURES, P.PERS_IMPRESSIVE_COUNT, P.PERS_EXCELLENT_COUNT, P.PERS_GAUNTLET_FRAG_COUNT, P.PERS_DEFEND_COUNT, P.PERS_ASSIST_COUNT]) current.persistant.set(index, 1);
    current.persistant.set(P.PERS_RANK, 1); f.runtime.checkLocalSounds(current, previous);
    expect(f.state.rewardStack).toBe(6); expect(f.state.rewards[0]?.count).toBe(0);
    expect(f.state.rewards.slice(1, 7).map(reward => f.nameOf(reward.sound))).toEqual(["capture", product === "missionpack" ? "first-impressive" : "impressive",
      product === "missionpack" ? "first-excellent" : "excellent", "humiliation", "defend", "assist"]);
    expect(f.calls).toEqual([]);
    previous.persistant.set(P.PERS_GAUNTLET_FRAG_COUNT, 1); current.persistant.set(P.PERS_GAUNTLET_FRAG_COUNT, 2);
    Object.assign(previous, current.copy()); previous.persistant.set(P.PERS_GAUNTLET_FRAG_COUNT, 1);
    f.runtime.checkLocalSounds(current, previous);
    const seventh = f.state.rewards[7]; if (seventh === undefined) throw new Error("Fixture requires reward slot7");
    expect(f.nameOf(seventh.sound)).toBe(product === "missionpack" ? "first-humiliation" : "humiliation");
    for (let i = 0; i < 5; i++) f.runtime.checkLocalSounds(current, previous); expect(f.state.rewardStack).toBe(9);
  });
  test("player event priority suppresses lead voices, flag pickup does not", () => {
    const f = fixture(product), current = f.ps.copy(), previous = f.ps.copy();
    previous.persistant.set(P.PERS_RANK, 1); current.persistant.set(P.PERS_PLAYEREVENTS, 7);
    f.runtime.checkLocalSounds(current, previous); expect(f.calls).toEqual(["local:denied:7"]);
    f.calls.length = 0; current.persistant.set(P.PERS_PLAYEREVENTS, 0); f.runtime.checkLocalSounds(current, previous); expect(f.calls).toEqual(["buffer:lead"]);
    f.calls.length = 0; f.staticState.gameType = GameType.GT_TEAM; current.powerups.set(Powerup.PW_NEUTRALFLAG, 1);
    f.runtime.checkLocalSounds(current, previous); expect(f.calls).toEqual(["local:flag:7"]);
  });
  test("time and frag warnings preserve strict thresholds, priorities and one-shot bits", () => {
    const f = fixture(product), previous = f.ps.copy(); f.staticState.timelimit = 10; f.state.time = 300000;
    f.runtime.checkLocalSounds(f.ps, previous); expect(f.calls).toEqual([]);
    f.state.time++; f.runtime.checkLocalSounds(f.ps, previous); expect(f.calls).toEqual(["local:five:7"]);
    f.state.time = 540001; f.runtime.checkLocalSounds(f.ps, previous); f.state.time = 602001; f.runtime.checkLocalSounds(f.ps, previous);
    expect(f.calls).toEqual(["local:five:7", "local:minute:7", "local:sudden:7"]); expect(f.state.timelimitWarnings).toBe(7);
    f.calls.length = 0; f.staticState.fraglimit = 10; f.staticState.scores1 = 8;
    f.runtime.checkLocalSounds(f.ps, previous); expect(f.calls).toEqual(["buffer:two-frag"]); expect(f.state.fraglimitWarnings).toBe(3);
    f.staticState.scores1 = 7; f.runtime.checkLocalSounds(f.ps, previous); expect(f.calls).toHaveLength(1);
    f.staticState.scores1 = 9; f.runtime.checkLocalSounds(f.ps, previous); expect(f.calls).toEqual(["buffer:two-frag", "buffer:one-frag"]);
    f.staticState.gameType = GameType.GT_CTF; f.state.fraglimitWarnings = 0; f.runtime.checkLocalSounds(f.ps, previous); expect(f.state.fraglimitWarnings).toBe(0);
  });
  test("intermission and spectator gates do not suppress ammo checks or predictable events", async () => {
    const f = fixture(product), current = f.ps.copy(), previous = f.ps.copy();
    f.ps.pmType = MoveType.PM_INTERMISSION; f.ps.ammo.set(Weapon.WP_MACHINEGUN, 0); current.health = 80; current.addEvent(EntityEvent.EV_JUMP, 0);
    await f.runtime.transitionPlayerState(current, previous); expect(f.calls).toEqual(["local:ammo:6", "event:predicted:14:0"]);
  });
  test("snapshot transition composes respawn, damage, events and mixer after awaited commands", async () => {
    const f = fixture(product), history = new SnapshotHistory(), first = f.state.snap;
    if (first === null) throw new Error("Fixture requires initial snapshot");
    const snapshots = new SnapshotRuntime(f.state, { source: new HistorySnapshotSource(history, () => 0, message => { f.calls.push(message); }),
      demoPlayback: true, noPredict: false, synchronousClients: false,
      executeServerCommands: async sequence => { f.calls.push(`command:${sequence}`); }, respawn: () => f.runtime.respawn(),
      resetPlayerEntity: entity => { f.calls.push(`reset:${entity.currentState.number}`); },
      checkEvents: async entity => { f.calls.push(`entity:${entity.currentState.number}`); },
      transitionPlayerState: async (current, previous) => await f.runtime.transitionPlayerState(current, previous),
      lagometerSnapshot: snapshot => { f.calls.push(snapshot === null ? "lost" : `received:${snapshot.messageNumber}`); },
      warn: message => { f.calls.push(message); } });
    const next = { ...first, messageNumber: 2, serverTime: 1100, serverCommandNumber: 2, playerState: first.playerState.copy() };
    next.playerState.damageEvent = 1; next.playerState.damageCount = 15; next.playerState.damageYaw = 255; next.playerState.damagePitch = 255;
    next.playerState.health = 85; next.playerState.ammo.set(Weapon.WP_MACHINEGUN, 0); next.playerState.addEvent(EntityEvent.EV_JUMP, 4);
    history.publish({ kind: "snapshot", validity: { kind: "valid" }, snapshot: next });
    f.state.processedSnapshotNum = 1; f.state.time = 1100; await snapshots.processSnapshots();
    expect(f.calls).toEqual(["received:2", "command:2", "pain:85", "local:ammo:6", "event:predicted:14:4"]);
    expect(f.state.damageTime).toBe(1100); expect(f.state.damagePitch).toBeCloseTo(-7.058823585510254, 6);
    expect(f.state.eventSequence).toBe(1); expect(f.mixer.mix(4).some(value => value > 0)).toBe(true);
    expect(history.latest?.playerState.entityEventSequence).toBe(0);
  });
  test("cg/cgs sibling instances independently own client records, scores, chat, rewards and resource slots", () => {
    const first = fixture(product), second = fixture(product);
    first.staticState.teamChatMsgs[0] = "hello"; first.staticState.teamVoteTime[0] = 99;
    const info = first.staticState.clientInfo[0], otherInfo = second.staticState.clientInfo[0];
    if (info === undefined || otherInfo === undefined) throw new Error("Fixture requires client info");
    expect(info).not.toBe(otherInfo); expect(second.staticState.teamChatMsgs[0]).toBe(""); expect(second.staticState.teamVoteTime[0]).toBe(0);
    expect(first.state.scores[0]).not.toBe(second.state.scores[0]); expect(first.state.rewards[0]).not.toBe(second.state.rewards[0]);
    expect(first.staticState.gameModels).not.toBe(second.staticState.gameModels); expect(first.staticState.gameSounds).not.toBe(second.staticState.gameSounds);
  });
});
