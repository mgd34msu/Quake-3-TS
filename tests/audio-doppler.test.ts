// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import type { PcmSound } from "../src/assets/wav.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { PacketEntityPresenter } from "../src/cgame/entities.ts";
import type { PacketEntityImports, PacketEntityMedia, PacketWeaponInfo } from "../src/cgame/entities.ts";
import { ClientGameState } from "../src/cgame/state.ts";
import { vec3 } from "../src/core/math.ts";
import { DEFAULT_MODEL } from "../src/render/ref-entity.ts";
import { EntityType, GameType, Weapon } from "../src/shared/definitions.ts";
import { itemList } from "../src/shared/items.ts";
import { createPlayerState } from "../src/shared/player-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";

function mono(samples: readonly number[], sampleRate = 100): PcmSound {
  return { sampleRate, channels: 1, samples: Int16Array.from(samples), frameCount: samples.length, loopStart: null };
}

function values(samples: Int16Array): number[] { return Array.from(samples); }

// Independent native fixtures include untouched snd_dma.c and snd_mix.c directly:
// /tmp/quake3-audio-doppler-oracle/{loop-state.c,fixture.c,loop-state,oracle}.
// The source state capture produced scale/old-scale bits 3f9ae148/3f800000 for
// frames 40 and 41; the PCM capture produced 62,125,188,251,345 after transfer.
// The updated-listener capture (source sha256 451dfd24faf367c04d26ed1fb5a808e37e5c1ca40067fdffef53fc0cb9293dee)
// produced listener/emitter bits 447a0000/41200000, scale 3c0469a5,
// doppler false, volume 17/17, and retained listener bits after S_ClearLoopingSounds.

test("frame loops spatialize their explicit origin even when they use the listener entity number", () => {
  const mixer = new AudioMixer(100, () => 0);
  mixer.setEffectsVolume(1);
  mixer.setListener(7, vec3(0, 0, 0), [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]);
  mixer.updateLoopingSound(mono([256]), {
    entity: 7,
    origin: vec3(0, -1330, 0),
    velocity: vec3(0, 0, 0),
    frameNumber: 1,
  });
  mixer.setListener(7, vec3(0, 0, 0), [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]);
  expect(values(mixer.mix(1))).toEqual([0, 0]);
});

test("S_StartLocalSound uses the current listener entity and source volume 127", () => {
  const mixer = new AudioMixer(100, () => 0);
  mixer.setEffectsVolume(1);
  mixer.setListener(19, vec3(5000, 0, 0), [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]);
  mixer.updateEntityPosition(19, vec3(-5000, 0, 0));
  expect(mixer.startLocalSound(mono([256]), 7)).toBe(true);
  expect(values(mixer.mix(1))).toEqual([126, 126]);
});

test("frame-loop Doppler averages every crossed source sample with source float32 offsets", () => {
  const mixer = new AudioMixer(100, () => 0);
  mixer.setEffectsVolume(1);
  const samples = Array.from({ length: 32 }, (_, index) => (index + 1) * 256);
  mixer.updateLoopingSound(mono(samples), {
    entity: 3,
    origin: vec3(10, 0, 0),
    velocity: vec3(100, 0, 0),
    frameNumber: 40,
  });
  mixer.setListener(0, vec3(0, 0, 0), [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]);
  // scale = 12100 / (100 * 100) = float32(1.21). The fifth output spans
  // source samples 4 and 5, matching S_PaintChannelFrom16's averaging branch.
  expect(values(mixer.mix(5))).toEqual([62, 62, 125, 125, 188, 188, 251, 251, 345, 345]);
  mixer.clearLoopingSounds(false);
  mixer.updateLoopingSound(mono(samples), {
    entity: 3,
    origin: vec3(10, 0, 0),
    velocity: vec3(100, 0, 0),
    frameNumber: 41,
  });
  mixer.setListener(0, vec3(0, 0, 0), [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]);
  // Untouched S_AddLoopingSound stores scale bits 3f9ae148 but resets the old
  // scale to 3f800000 even on consecutive frames. See the native fixture below.
  expect(values(mixer.mix(1))).toEqual([376, 376]);
});

test("Doppler resets local float32 offsets at source chunk and paint boundaries", () => {
  const mixer = new AudioMixer(100, () => 0);
  mixer.setEffectsVolume(1);
  mixer.updateLoopingSound(mono(Array.from({ length: 8192 }, (_, index) => (index % 64) * 256)), {
    entity: 3, origin: vec3(10, 0, 0), velocity: vec3(100, 0, 0), frameNumber: 1,
  });
  mixer.setListener(0, vec3(0, 0, 0), [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]);
  const output = mixer.mix(4100);
  // After the first 1024-sample chunk wraps, float32 offset 305 advances
  // through 307.0082702636719 at output 1099, averaging samples 1329/1330.
  expect(values(output.slice(1099 * 2, 1101 * 2))).toEqual([3106, 3106, 3200, 3200]);
  // The next 4096-frame paint starts again at absolute sample 4096.
  expect(values(output.slice(4096 * 2))).toEqual([0, 0, 62, 62, 125, 125, 188, 188]);
  expect(mixer.soundClock).toBe(4100);
  expect(mixer.sampleClock).toBe(4100);
});

test("packet-updated listener position controls Doppler without an active listener loop", () => {
  const mixer = new AudioMixer(100, () => 0);
  mixer.setEffectsVolume(1);
  mixer.setListener(7, vec3(1000, 0, 0), [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]);
  mixer.updateEntityPosition(7, vec3(1000, 0, 0));
  const samples = mono(Array.from({ length: 32 }, (_, index) => (index + 1) * 256));
  mixer.updateLoopingSound(samples, {
    entity: 3,
    origin: vec3(10, 0, 0),
    velocity: vec3(100, 0, 0),
    frameNumber: 1,
  });
  mixer.setListener(7, vec3(1000, 0, 0), [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]);
  expect(values(mixer.mix(5))).toEqual([16, 16, 33, 33, 50, 50, 67, 67, 84, 84]);
});

test("live s_doppler disable and real loops retain ordinary source stepping", () => {
  const samples = mono([256, 512, 768, 1024]);
  const disabled = new AudioMixer(100, () => 0); disabled.setEffectsVolume(1); disabled.setDopplerEnabled(false);
  disabled.updateLoopingSound(samples, { entity: 2, origin: vec3(10, 0, 0), velocity: vec3(100, 0, 0), frameNumber: 1 });
  disabled.setListener(0, vec3(0, 0, 0), [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]);
  expect(values(disabled.mix(4))).toEqual([62, 62, 125, 125, 188, 188, 251, 251]);

  const real = new AudioMixer(100, () => 0); real.setEffectsVolume(1); real.setDopplerEnabled(true);
  real.updateRealLoopingSound(samples, { entity: 2, origin: vec3(10, 0, 0), velocity: vec3(100, 0, 0) });
  real.setListener(0, vec3(0, 0, 0), [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]);
  expect(values(real.mix(4))).toEqual([44, 44, 89, 89, 134, 134, 179, 179]);
});

test("Doppler tail reads use deterministic zeroes for source undefined sndBuffer padding", () => {
  const mixer = new AudioMixer(100, () => 0); mixer.setEffectsVolume(1);
  const samples = mono(Array.from({ length: 32 }, (_, index) => (index + 1) * 256));
  mixer.updateLoopingSound(samples, { entity: 3, origin: vec3(10, 0, 0), velocity: vec3(100, 0, 0), frameNumber: 1 });
  mixer.setListener(0, vec3(0, 0, 0), [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]);
  expect(values(mixer.mix(32)).slice(-16)).toEqual([
    1882, 1882, 1945, 1945, 2008, 2008, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
});

test("packet missile presentation feeds trajectory velocity and engine frame number into the mixer", () => {
  const sound = mono(Array.from({ length: 32 }, (_, index) => (index + 1) * 256));
  const mixer = new AudioMixer(100, () => 0); mixer.setEffectsVolume(1);
  const state = new ClientGameState("baseq3", 0, 0); state.time = 0; state.clientFrame = 5;
  const playerState = createPlayerState("baseq3");
  state.snap = { messageNumber: 1, serverTime: 0, deltaNumber: -1, flags: 0, serverCommandNumber: 0,
    parseEntitiesNumber: 0, areaMask: new Uint8Array(32), playerState, entities: [] };
  const weapon: PacketWeaponInfo = { weaponModel: DEFAULT_MODEL, weaponMidpoint: vec3(0, 0, 0), barrelModel: null,
    missileModel: DEFAULT_MODEL, missileRenderfx: 0, missileSound: sound, missileDlight: 0,
    missileDlightColor: vec3(0, 0, 0), missileTrail: null, trailRadius: 0, trailTime: 0 };
  const media: PacketEntityMedia = {
    gameModels: [DEFAULT_MODEL], gameSounds: [null], inlineModels: [{ model: DEFAULT_MODEL, midpoint: vec3(0, 0, 0) }],
    items: itemList("baseq3").map(() => ({ models: [DEFAULT_MODEL, null], icon: null })),
    weapons: Array.from({ length: 16 }, () => weapon), plasmaBallShader: null,
    redFlagBaseModel: DEFAULT_MODEL, blueFlagBaseModel: DEFAULT_MODEL, neutralFlagBaseModel: DEFAULT_MODEL,
    variant: { product: "baseq3" },
  };
  let deliveredVelocity = vec3(0, 0, 0);
  const imports: PacketEntityImports = {
    addRefEntity: () => undefined, addLight: () => undefined, updateSoundPosition: () => undefined,
    addLoopSound: (entity, origin, velocity, pcm, realLoop) => {
      if (pcm === null || realLoop) throw new Error("Expected a frame missile loop");
      deliveredVelocity = velocity;
      mixer.updateLoopingSound(pcm, { entity, origin, velocity, frameNumber: 77 });
    },
    startSound: () => undefined, randomInteger: () => 0, player: () => undefined,
    missileTrail: () => undefined, grappleTrail: () => undefined, addEntityWithPowerups: () => undefined,
  };
  const missile = state.entityAt(80); missile.currentState.number = 80; missile.currentState.eType = EntityType.ET_MISSILE;
  missile.currentState.weapon = Weapon.WP_ROCKET_LAUNCHER;
  missile.currentState.pos = { type: TrajectoryType.TR_LINEAR, time: 0, duration: 0,
    base: vec3(10, 0, 0), delta: vec3(100, 0, 0) };
  new PacketEntityPresenter(state, media, imports).addEntity(missile,
    { gameType: GameType.GT_FFA, smoothClients: false, simpleItems: false, obeliskRespawnDelay: 0 });
  expect(deliveredVelocity).toEqual(vec3(100, 0, 0));
  mixer.setListener(0, vec3(0, 0, 0), [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]);
  expect(values(mixer.mix(5))).toEqual([62, 62, 125, 125, 188, 188, 251, 251, 345, 345]);
});
