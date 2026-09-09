import { describe, expect, test } from "bun:test";

import type { PcmSound } from "../src/assets/wav.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import type { FrameLoopingSoundOptions, RealLoopingSoundOptions, StartSoundOptions } from "../src/audio/mixer.ts";
import { vec3 } from "../src/core/math.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { ConsoleOutput } from "../src/core/console-output.ts";
import type { Axis } from "../src/core/math.ts";

const DEFAULT_AXIS: Axis = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];

function mono(samples: readonly number[], sampleRate = 100): PcmSound {
  return {
    sampleRate,
    channels: 1,
    samples: new Int16Array(samples),
    frameCount: samples.length,
    loopStart: null,
  };
}

function stereo(samples: readonly number[], sampleRate = 100): PcmSound {
  if (samples.length % 2 !== 0) throw new Error("stereo fixture needs sample pairs");
  return {
    sampleRate,
    channels: 2,
    samples: new Int16Array(samples),
    frameCount: samples.length / 2,
    loopStart: null,
  };
}

function values(samples: Int16Array): number[] {
  return Array.from(samples);
}

function frameLoop(entity: number, frameNumber = 1): FrameLoopingSoundOptions {
  return { entity, origin: vec3(0, 0, 0), velocity: vec3(0, 0, 0), frameNumber };
}

function realLoop(entity: number): RealLoopingSoundOptions {
  return { entity, origin: vec3(0, 0, 0), velocity: vec3(0, 0, 0) };
}

describe("snd_mix.c integer paint path", () => {
  test("s_testsound replaces completed paint at absolute phase and reads the live integer cvar", () => {
    const cvars = new CvarRegistry();
    cvars.register("s_show", "0");
    cvars.register("s_testsound", "1");
    const mixer = new AudioMixer(100, () => 0);
    mixer.bindSoundCvars(cvars);
    mixer.setEffectsVolume(1);
    mixer.queueRaw(stereo([111, 222, 333, 444]), 1);
    mixer.startLocalSound(mono([256, 512]), 1);
    mixer.updateRealLoopingSound(mono([1024]), realLoop(3));
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix({ startFrame: 0, endFrame: 2 }))).toEqual([0, 0, 1996, 1996]);
    expect(mixer.rawEnd).toBe(2);
    expect(Array.from(mixer.channelVolumes())).toHaveLength(1);
    cvars.set("s_testsound", "0.9"); // integer zero, not a floating truthiness test
    // Raw + master_vol 127 one-shot + the real loop's spatialized volume 45.
    expect(values(mixer.mix({ startFrame: 0, endFrame: 2 }))).toEqual([416, 527, 765, 876]);
    mixer.clearSoundBuffer();
    cvars.set("s_testsound", "-1");
    expect(values(mixer.mix({ startFrame: -1, endFrame: 1 }))).toEqual([-1997, -1997, 0, 0]);
    expect(values(mixer.mix({ startFrame: 1, endFrame: 5 }))).toEqual([1996, 1996, 3973, 3973, 5910, 5910, 7788, 7788]);
    mixer.updateRealLoopingSound(mono([256, 512, 768]), realLoop(3));
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(() => mixer.mix({ startFrame: -1, endFrame: 0 })).toThrow("invalid negative sample");
  });

  test("s_show 1 prints prepared sound starts before clock sampling and duplicate rejection", () => {
    const calls: string[] = [];
    const cvars = new CvarRegistry();
    cvars.register("s_show", "1");
    const mixer = new AudioMixer(100, () => { calls.push("clock"); return 0; });
    mixer.bindSoundCvars(cvars);
    mixer.bindConsoleOutput(new ConsoleOutput(text => { calls.push(text); }));
    const sound = mono([256]);
    expect(mixer.startLocalSound(sound, 1, "sound/test.wav")).toBe(true);
    expect(mixer.startLocalSound(sound, 1, "sound/test.wav")).toBe(false);
    expect(calls).toEqual(["0 : sound/test.wav\n", "clock", "clock", "0 : sound/test.wav\n", "clock"]);
    calls.length = 0;
    expect(() => mixer.startLocalSound(mono([]), 1, "invalid.wav")).toThrow();
    expect(() => mixer.startLocalSound(sound, 1)).toThrow("registered name");
    expect(calls).toEqual([]);
    mixer.setPlaybackEnabled(false);
    expect(mixer.startLocalSound(sound, -1)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("applies both source gain shifts to a local mono sound", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    expect(mixer.startSound(mono([256]), {
      entity: 1,
      channel: 1,
      origin: { kind: "local" },
      volume: 128,
    })).toBe(true);

    // ((256 * (128 * 255)) >> 8) >> 8, exactly as S_PaintChannelFrom16
    // followed by S_WriteLinearBlastStereo16.
    expect(values(mixer.mix(1))).toEqual([127, 127]);
    expect(values(mixer.mix(1))).toEqual([0, 0]);
  });

  test("sums before clamping to signed 16-bit output", () => {
    const positive = new AudioMixer(100, () => 0);
    positive.queueRaw(stereo([32767, -32768]), 2);
    expect(values(positive.mix(1))).toEqual([32767, -32768]);

    const mixed = new AudioMixer(100, () => 0);
    mixed.setEffectsVolume(1);
    const loud = mono([32767]);
    expect(mixed.startSound(loud, {
      entity: 1,
      channel: 1,
      origin: { kind: "local" },
      volume: 255,
    })).toBe(true);
    expect(mixed.startSound(loud, {
      entity: 2,
      channel: 1,
      origin: { kind: "local" },
      volume: 255,
    })).toBe(true);
    expect(values(mixed.mix(1))).toEqual([32767, 32767]);
  });
});

describe("snd_dma.c spatialization", () => {
  test("keeps source float32 attenuation and integer channel-volume rounding", () => {
    for (const [distance, left] of [[326.063, 102], [837.874, 50], [857.559, 48], [1310.315, 2]] satisfies readonly (readonly [number, number])[]) {
      const mixer = new AudioMixer(100, () => 0);
      mixer.setEffectsVolume(1);
      mixer.startSound(mono([256]), {
        entity: 4, channel: 1, volume: 127, origin: { kind: "fixed", position: vec3(0, distance, 0) },
      });
      mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
      expect(Array.from(mixer.channelVolumes(), channel => [channel.left, channel.right])).toEqual([[left, 0]]);
      expect(values(mixer.mix(1))).toEqual([left - 1, 0]);
    }
  });

  test("copies a fixed origin at allocation before later caller mutations", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    const position = { x: 0, y: 100, z: 0 };
    mixer.startSound(mono([256]), { entity: 4, channel: 1, volume: 127, origin: { kind: "fixed", position } });
    position.y = -100;
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([123, 0]);
  });

  test("publishes loop channels only at respatialization and clears the published count independently", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    const sound = mono([256]);
    mixer.updateLoopingSound(sound, {
      entity: 4, origin: vec3(0, -100, 0), velocity: vec3(0, 0, 0), frameNumber: 1,
    });
    expect(values(mixer.mix(1))).toEqual([0, 0]);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([0, 123]);
    mixer.updateEntityPosition(4, vec3(0, 100, 0));
    expect(values(mixer.mix(1))).toEqual([0, 123]);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([123, 0]);
    mixer.stopLoopingSound(4);
    expect(values(mixer.mix(1))).toEqual([123, 0]);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([0, 0]);

    mixer.updateRealLoopingSound(sound, realLoop(5));
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([44, 44]);
    mixer.clearLoopingSounds(false);
    expect(values(mixer.mix(1))).toEqual([0, 0]);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([44, 44]);
    mixer.clearSoundBuffer();
    expect(values(mixer.mix(1))).toEqual([0, 0]);
  });

  test("one-shot volumes change only at allocation and respatialization", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    mixer.startSound(mono([256, 256, 256, 256]), {
      entity: 4, channel: 1, volume: 127, origin: { kind: "entity", entity: 4 },
    });
    mixer.updateEntityPosition(4, vec3(0, -100, 0));
    expect(values(mixer.mix(1))).toEqual([126, 126]);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([0, 123]);
    mixer.updateEntityPosition(4, vec3(0, 100, 0));
    expect(values(mixer.mix(1))).toEqual([0, 123]);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([123, 0]);
    mixer.clearSoundBuffer();
    mixer.startLocalSound(mono([256]), 1);
    mixer.updateEntityPosition(0, vec3(0, -100, 0));
    mixer.setListener(8, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([0, 123]);
  });

  test("pans against Quake's listener-left axis and attenuates beyond 80 units", () => {
    const right = new AudioMixer(100, () => 0);
    right.setEffectsVolume(1);
    right.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(right.startSound(mono([256]), {
      entity: 1,
      channel: 1,
      origin: { kind: "fixed", position: vec3(0, -100, 0) },
      volume: 127,
    })).toBe(true);
    right.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(right.mix(1))).toEqual([0, 123]);

    const left = new AudioMixer(100, () => 0);
    left.setEffectsVolume(1);
    left.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(left.startSound(mono([256]), {
      entity: 1,
      channel: 1,
      origin: { kind: "fixed", position: vec3(0, 100, 0) },
      volume: 127,
    })).toBe(true);
    left.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(left.mix(1))).toEqual([123, 0]);
  });

  test("fixed-origin sounds keep signed entity identities and audible spatialization", () => {
    const sound = mono([256]);
    for (const entity of [-1, -2147483648, 1024, 2147483647]) {
      const mixer = new AudioMixer(100, () => 0);
      mixer.setEffectsVolume(1);
      const options = {
        entity, channel: 2, volume: 127,
        origin: { kind: "fixed", position: vec3(0, 100, 0) },
      } satisfies StartSoundOptions;
      expect(mixer.startSound(sound, options)).toBe(true);
      expect(mixer.startSound(sound, options)).toBe(false);
      expect(mixer.startSound(sound, {
        ...options, entity: 1,
        origin: { kind: "fixed", position: vec3(0, -100, 0) },
      })).toBe(true);
      mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
      expect(values(mixer.mix(1))).toEqual([123, 123]);
      expect(() => mixer.startSound(sound, {
        ...options, origin: { kind: "entity", entity },
      })).toThrow("entity must be an integer from 0 through 1023");
    }
    const mixer = new AudioMixer(100, () => 0);
    for (const entity of [-2147483649, 2147483648, 0.5, NaN, Infinity]) {
      expect(() => mixer.startSound(sound, {
        entity, channel: 2, volume: 127,
        origin: { kind: "fixed", position: vec3(0, 100, 0) },
      })).toThrow("fixed-origin entity must be a signed 32-bit integer");
    }
  });

  test("keeps listener and local voices at full volume", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    mixer.setListener(7, vec3(500, 500, 500), DEFAULT_AXIS);
    expect(mixer.startSound(mono([256]), {
      entity: 7,
      channel: 1,
      origin: { kind: "entity", entity: 7 },
      volume: 127,
    })).toBe(true);
    expect(values(mixer.mix(1))).toEqual([126, 126]);
  });

  test("updates moving entity origins in source-owned persistent cells", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    const packetOrigin = { x: 0, y: -100, z: 0 };
    mixer.updateEntityPosition(4, packetOrigin);
    packetOrigin.y = 100;
    expect(mixer.startSound(mono([256, 256]), {
      entity: 4,
      channel: 1,
      origin: { kind: "entity", entity: 4 },
      volume: 127,
    })).toBe(true);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([0, 123]);

    mixer.updateEntityPosition(4, vec3(0, 100, 0));
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([123, 0]);
  });

  test("zero-initializes entity origins and retains updates across loop clears", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(mixer.startSound(mono([256]), {
      entity: 4,
      channel: 1,
      origin: { kind: "entity", entity: 4 },
      volume: 127,
    })).toBe(true);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([62, 62]);

    mixer.updateEntityPosition(4, vec3(0, 100, 0));
    mixer.clearLoopingSounds(true);
    expect(mixer.startSound(mono([256]), {
      entity: 4,
      channel: 1,
      origin: { kind: "entity", entity: 4 },
      volume: 127,
    })).toBe(true);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([123, 0]);

    mixer.stopAll();
    expect(mixer.startSound(mono([256]), {
      entity: 4,
      channel: 1,
      origin: { kind: "entity", entity: 4 },
      volume: 127,
    })).toBe(true);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([62, 62]);
  });

  test("loop registration writes the position later used by entity one-shots", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    mixer.updateLoopingSound(mono([256]), {
      entity: 4,
      origin: vec3(0, -100, 0),
      velocity: vec3(0, 0, 0),
      frameNumber: 1,
    });
    mixer.clearLoopingSounds(true);
    expect(mixer.startSound(mono([256]), {
      entity: 4,
      channel: 1,
      origin: { kind: "entity", entity: 4 },
      volume: 127,
    })).toBe(true);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([0, 123]);

    mixer.updateRealLoopingSound(mono([256]), {
      entity: 4,
      origin: vec3(0, 100, 0),
      velocity: vec3(0, 0, 0),
    });
    mixer.clearLoopingSounds(true);
    expect(mixer.startSound(mono([256]), {
      entity: 4,
      channel: 1,
      origin: { kind: "entity", entity: 4 },
      volume: 127,
    })).toBe(true);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([123, 0]);
  });

  test("respatialization reads updated entity positions from the active loop's shared source cell", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    mixer.updateLoopingSound(mono([256]), {
      entity: 4,
      origin: vec3(0, -100, 0),
      velocity: vec3(0, 0, 0),
      frameNumber: 1,
    });
    mixer.updateEntityPosition(4, vec3(0, 100, 0));
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([123, 0]);
  });

  test("rejects the source array's unsafe MAX_GENTITIES index", () => {
    const mixer = new AudioMixer(100, () => 0);
    expect(() => mixer.updateEntityPosition(-1, vec3(0, 0, 0))).toThrow("entity must be an integer from 0 through 1023");
    expect(() => mixer.updateEntityPosition(1024, vec3(0, 0, 0))).toThrow("entity must be an integer from 0 through 1023");
    expect(() => mixer.updateEntityPosition(1.5, vec3(0, 0, 0))).toThrow("entity must be an integer from 0 through 1023");
    mixer.setListener(1024, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(() => mixer.updateLoopingSound(mono([256]), {
      ...frameLoop(4), velocity: vec3(1, 0, 0),
    })).toThrow("Missing source sound position for entity 1024");
    expect(() => mixer.startSound(mono([256]), {
      entity: 1,
      channel: 1,
      origin: { kind: "entity", entity: 1024 },
      volume: 127,
    })).toThrow("entity must be an integer from 0 through 1023");
    expect(() => mixer.updateEntityPosition(1023, vec3(1, 2, 3))).not.toThrow();
  });

  test("falls silent after source attenuation reaches zero", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    expect(mixer.startSound(mono([32767]), {
      entity: 1,
      channel: 1,
      origin: { kind: "fixed", position: vec3(0, -1330, 0) },
      volume: 127,
    })).toBe(true);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([0, 0]);
  });
});

describe("voices and fixed-point resampling", () => {
  test("stores signed channel labels and only protects channel seven from replacement", () => {
    for (const channel of [-2147483648, -1, 0, 2147483647]) {
      let time = 0;
      const mixer = new AudioMixer(100, () => time, 1);
      mixer.setEffectsVolume(1);
      expect(mixer.startLocalSound(mono([256]), channel)).toBe(true);
      expect(values(mixer.mix(1))).toEqual([126, 126]);
      mixer.clearSoundBuffer();
      mixer.startSound(mono([256]), { entity: 1, channel, origin: { kind: "local" }, volume: 127 });
      time = 1;
      expect(mixer.startSound(mono([512]), { entity: 1, channel: 7, origin: { kind: "local" }, volume: 127 })).toBe(true);
      expect(values(mixer.mix(1))).toEqual([253, 253]);
      time = 2;
      expect(() => mixer.startSound(mono([1024]), { entity: 1, channel, origin: { kind: "local" }, volume: 127 }))
        .toThrow("undefined native listener fallback");
    }
    const mixer = new AudioMixer(100, () => 0);
    for (const channel of [-2147483649, 2147483648, 0.5, NaN, Infinity]) {
      expect(() => mixer.startLocalSound(mono([256]), channel)).toThrow("channel must be a signed 32-bit integer");
    }
  });

  test("rounds the source float32 resampled length before retiring its final frame", () => {
    const mixer = new AudioMixer(44100, () => 0, 1);
    mixer.setEffectsVolume(1);
    mixer.startLocalSound(mono(new Array<number>(160).fill(256), 48000), 1);
    // float32(160 / float32(48000 / 44100)) is exactly 147.
    const output = mixer.mix({ startFrame: 0, endFrame: 147 });
    expect(output.length).toBe(294);
    expect(output.at(-1)).toBe(126);
    expect(values(mixer.mix({ startFrame: 146, endFrame: 147 }))).toEqual([126, 126]);
    mixer.mix({ startFrame: 147, endFrame: 147 });
    expect(mixer.startLocalSound(mono([256], 44100), 1)).toBe(true);
  });

  test("uses snd_mem.c 8.8 nearest-neighbor resampling", () => {
    const mixer = new AudioMixer(4, () => 0);
    mixer.setEffectsVolume(1);
    expect(mixer.startSound(mono([256, 512], 2), {
      entity: 1,
      channel: 1,
      origin: { kind: "local" },
      volume: 128,
    })).toBe(true);
    expect(values(mixer.mix(4))).toEqual([
      127, 127,
      127, 127,
      255, 255,
      255, 255,
    ]);
  });

  test("layers different sounds on both nonzero and zero entity channels", () => {
    const replaced = new AudioMixer(100, () => 0);
    replaced.setEffectsVolume(1);
    expect(replaced.startSound(mono([256]), {
      entity: 3,
      channel: 2,
      origin: { kind: "local" },
      volume: 128,
    })).toBe(true);
    expect(replaced.startSound(mono([1024]), {
      entity: 3,
      channel: 2,
      origin: { kind: "local" },
      volume: 128,
    })).toBe(true);
    expect(values(replaced.mix(1))).toEqual([637, 637]);

    const layered = new AudioMixer(100, () => 0);
    layered.setEffectsVolume(1);
    expect(layered.startSound(mono([256]), {
      entity: 3,
      channel: 0,
      origin: { kind: "local" },
      volume: 128,
    })).toBe(true);
    expect(layered.startSound(mono([1024]), {
      entity: 3,
      channel: 0,
      origin: { kind: "local" },
      volume: 128,
    })).toBe(true);
    expect(values(layered.mix(1))).toEqual([637, 637]);
  });

  test("evicts the oldest eligible voice at channel capacity", () => {
    let time = 0;
    const mixer = new AudioMixer(100, () => time, 1);
    mixer.setEffectsVolume(1);
    expect(mixer.startSound(mono([256]), {
      entity: 1,
      channel: 1,
      origin: { kind: "local" },
      volume: 128,
    })).toBe(true);
    time = 1;
    expect(mixer.startSound(mono([1024]), {
      entity: 2,
      channel: 1,
      origin: { kind: "local" },
      volume: 128,
    })).toBe(true);
    expect(values(mixer.mix(1))).toEqual([510, 510]);
  });
});

describe("source channel clocks and repaint ranges", () => {
  test("starts zero-frame resampled effects before later retirement and rejects zero loops before origin writes", () => {
    const mixer = new AudioMixer(22050, () => 0, 1);
    mixer.setEffectsVolume(1);
    const short = mono([256], 48000);
    expect(mixer.startLocalSound(short, 1)).toBe(true);
    expect(values(mixer.mix({ startFrame: 0, endFrame: 1 }))).toEqual([0, 0]);
    expect(Array.from(mixer.channelVolumes())).toHaveLength(1);
    expect(() => mixer.startLocalSound(mono([256], 22050), 1)).toThrow("undefined native listener fallback");
    mixer.mix({ startFrame: 1, endFrame: 1 });
    expect(Array.from(mixer.channelVolumes())).toHaveLength(0);
    expect(mixer.startLocalSound(mono([256], 22050), 1)).toBe(true);
    expect(values(mixer.mix(1))).toEqual([126, 126]);

    mixer.clearSoundBuffer();
    mixer.updateEntityPosition(4, vec3(0, 100, 0));
    expect(() => mixer.updateLoopingSound(short, {
      entity: 4, origin: vec3(0, -100, 0), velocity: vec3(0, 0, 0), frameNumber: 1,
    })).toThrow("length 0");
    expect(() => mixer.updateRealLoopingSound(short, {
      entity: 4, origin: vec3(0, -100, 0), velocity: vec3(0, 0, 0),
    })).toThrow("length 0");
    mixer.startSound(mono([256], 22050), { entity: 4, channel: 1, volume: 127, origin: { kind: "entity", entity: 4 } });
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([123, 0]);
  });

  test("paints signed initial silence and starts one-shots at the actual negative paint beginning", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.selectTime(0, -2);
    expect(values(mixer.mix({ startFrame: -2, endFrame: 0 }))).toEqual([0, 0, 0, 0]);
    expect(mixer.soundClock).toBe(0);
    mixer.setEffectsVolume(1);
    mixer.startSound(mono([256, 512, 768]), { entity: 1, channel: 1, origin: { kind: "local" }, volume: 128 });
    expect(values(mixer.mix({ startFrame: -2, endFrame: 1 }))).toEqual([127, 127, 255, 255, 382, 382]);
    expect(mixer.soundClock).toBe(0);
    expect(values(mixer.mix({ startFrame: 0, endFrame: 1 }))).toEqual([382, 382]);
  });

  test("negative raw positions read the current source masked slots, including after raw-end clear", () => {
    const mixer = new AudioMixer(100, () => 0);
    const samples = new Int16Array(mixer.rawCapacity);
    samples[0] = 100;
    samples[mixer.rawCapacity - 2] = 200;
    samples[mixer.rawCapacity - 1] = 300;
    mixer.queueRaw({ sampleRate: 100, channels: 1, frameCount: samples.length, samples, loopStart: null }, 1);
    expect(values(mixer.mix({ startFrame: -2, endFrame: 1 }))).toEqual([200, 200, 300, 300, 100, 100]);
    mixer.clearSoundBuffer();
    expect(values(mixer.mix({ startFrame: -2, endFrame: 1 }))).toEqual([200, 200, 300, 300, 0, 0]);
  });

  test("rejects an actual ordinary negative loop read but preserves zero remainder and Doppler masking", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    mixer.updateLoopingSound(mono([256, 512]), frameLoop(1));
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix({ startFrame: -2, endFrame: -1 }))).toEqual([62, 62]);
    expect(() => mixer.mix({ startFrame: -1, endFrame: 0 })).toThrow("invalid negative sample access");
    mixer.clearSoundBuffer();
    const samples = new Int16Array(2048).fill(256);
    samples.fill(512, 1024);
    mixer.updateLoopingSound({ sampleRate: 100, channels: 1, frameCount: samples.length, samples, loopStart: null }, {
      entity: 1, origin: vec3(1, 0, 0), velocity: vec3(19, 0, 0), frameNumber: 1,
    });
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix({ startFrame: -1, endFrame: 0 }))).toEqual([62, 62]);
  });

  test("separates delivered sound time from reversible painting while raw writes wrap", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.queueRaw(mono(Array.from({ length: mixer.rawCapacity }, () => 1234)), 1);
    mixer.mix({ startFrame: 100, endFrame: 1000 });
    expect(mixer.sampleClock).toBe(1000);
    expect(mixer.soundClock).toBe(0);
    mixer.queueRaw(mono([1]), 1);
    expect(values(mixer.mix({ startFrame: 0, endFrame: 1 }))).toEqual([1, 1]);
    mixer.selectTime(100, 200);
    mixer.queueRaw(mono(Array.from({ length: 100 }, () => 5678)), 1);
    expect(mixer.rawEnd).toBe(mixer.rawCapacity + 101);
    expect(mixer.soundClock).toBe(100);
    expect(mixer.sampleClock).toBe(200);
    expect(() => mixer.selectTime(99, 200)).toThrow("monotonically");
    mixer.mix(1);
    expect(mixer.soundClock).toBe(201);
    mixer.clearSoundBuffer();
    expect(mixer.soundClock).toBe(201);
    expect(mixer.sampleClock).toBe(201);
    expect(mixer.rawEnd).toBe(0);
  });

  test("rebases a stopped sound epoch without retaining old raw history tags or discarding its PCM", () => {
    const mixer = new AudioMixer(100, () => 0, 2);
    mixer.selectTime(0x40000005, 0x40000006);
    mixer.queueRaw(mono([1000, 2000]), 1);
    mixer.startLocalSound(mono([256, 512, 768, 1024]), 1);
    mixer.updateRealLoopingSound(mono([256, 512]), realLoop(1));
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    mixer.mix({ startFrame: 0x40000005, endFrame: 0x40000006 });

    mixer.clearSoundBuffer();
    expect(mixer.rebaseTime(0x40000008)).toBe(8);
    expect(mixer.soundClock).toBe(8);
    expect(mixer.sampleClock).toBe(6);
    expect(mixer.rawEnd).toBe(0);
    expect(values(mixer.mix({ startFrame: 6, endFrame: 8 }))).toEqual([0, 0, 0, 0]);

    mixer.queueRaw(mono([9000]), 1);
    // The source retains ring bytes across S_StopAllSounds. A later raw write
    // exposes the old bytes in its gap, now at the rebased absolute positions.
    expect(values(mixer.mix({ startFrame: 5, endFrame: 9 })))
      .toEqual([1000, 1000, 2000, 2000, 0, 0, 9000, 9000]);
    expect(() => mixer.selectTime(7, 9)).toThrow("monotonically");
    expect(mixer.startLocalSound(mono([256]), 1)).toBe(true);
  });

  test("rebases the delivered remainder when the prior sound clock precedes the epoch and across later epochs", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.selectTime(0x3fffffff, 0x40000006);
    mixer.clearSoundBuffer();
    expect(mixer.rebaseTime(0x40000008)).toBe(8);
    expect(mixer.soundClock).toBe(8);
    expect(mixer.sampleClock).toBe(6);
    mixer.selectTime(9, 12);
    mixer.selectTime(0x8000000b, 0x8000000c);
    mixer.clearSoundBuffer();
    expect(mixer.rebaseTime(0x8000000d)).toBe(13);
    expect(mixer.soundClock).toBe(13);
    expect(mixer.sampleClock).toBe(12);
    expect(() => mixer.selectTime(12, 14)).toThrow("monotonically");
    mixer.selectTime(14, 15);
    expect(values(mixer.mix(1))).toEqual([0, 0]);
    expect(mixer.soundClock).toBe(16);
  });

  test("rejects an invalid sound epoch before changing either clock", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.selectTime(0x40000005, 0x40000006);
    for (const delivery of [NaN, Infinity, 0.5, 0x3fffffff, 0x40000004, 0x40000005]) {
      expect(() => mixer.rebaseTime(delivery)).toThrow("sound epoch rebase");
      expect(mixer.soundClock).toBe(0x40000005);
      expect(mixer.sampleClock).toBe(0x40000006);
    }
  });

  test("defers new channels to the selected paint beginning and retains earlier painted effects", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    mixer.startSound(mono([256, 512, 768, 1024]), { entity: 1, channel: 1, origin: { kind: "local" }, volume: 128 });
    expect(values(mixer.mix({ startFrame: 0, endFrame: 8 }))).toEqual([127, 127, 255, 255, 382, 382, 510, 510, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(mixer.sampleClock).toBe(8);
    expect(values(mixer.mix({ startFrame: 1, endFrame: 3 }))).toEqual([255, 255, 382, 382]);
    mixer.startSound(mono([256, 256]), { entity: 2, channel: 1, origin: { kind: "local" }, volume: 128 });
    expect(values(mixer.mix({ startFrame: 2, endFrame: 4 }))).toEqual([510, 510, 637, 637]);
    expect(mixer.sampleClock).toBe(4);
    expect(values(mixer.mix(1))).toEqual([0, 0]);
  });

  test("retires channels at the next scan beginning, including an empty paint range", () => {
    const mixer = new AudioMixer(100, () => 0, 1);
    mixer.setEffectsVolume(1);
    mixer.startLocalSound(mono([256, 512]), 1);
    mixer.mix({ startFrame: 0, endFrame: 8 });
    expect(() => mixer.startLocalSound(mono([1024]), 1)).toThrow("undefined native listener fallback");
    expect(values(mixer.mix({ startFrame: 1, endFrame: 2 }))).toEqual([253, 253]);
    expect(values(mixer.mix({ startFrame: 2, endFrame: 2 }))).toEqual([]);
    expect(mixer.startLocalSound(mono([1024]), 1)).toBe(true);
    expect(values(mixer.mix(1))).toEqual([506, 506]);
  });

  test("samples allocation milliseconds twice for free slots and gates every channel at 50ms", () => {
    const times = [10, 20, 69, 70, 80];
    let reads = 0;
    const mixer = new AudioMixer(100, () => {
      const time = times[reads++];
      if (time === undefined) throw new Error("Unexpected allocation clock read");
      return time;
    });
    mixer.setEffectsVolume(1);
    const sound = mono([256]);
    expect(mixer.startSound(sound, { entity: 1, channel: 1, origin: { kind: "local" }, volume: 127 })).toBe(true);
    expect(reads).toBe(2);
    expect(mixer.startSound(sound, { entity: 1, channel: 2, origin: { kind: "local" }, volume: 127 })).toBe(false);
    expect(reads).toBe(3);
    expect(mixer.startSound(sound, { entity: 1, channel: 2, origin: { kind: "local" }, volume: 127 })).toBe(true);
    expect(reads).toBe(5);
    expect(values(mixer.mix(1))).toEqual([253, 253]);
  });

  test("painting ahead does not stand in for elapsed milliseconds", () => {
    const mixer = new AudioMixer(100, () => 100);
    const sound = mono([256]);
    expect(mixer.startLocalSound(sound, 1)).toBe(true);
    mixer.mix(1000);
    expect(mixer.startLocalSound(sound, 2)).toBe(false);
    mixer.mix(0);
    expect(mixer.startLocalSound(sound, 2)).toBe(true);
  });

  test("retains the source greater-than voice limit for listener and other entities", () => {
    for (const [entity, count] of [[0, 9], [1, 5]]) {
      if (entity === undefined || count === undefined) throw new Error("Missing voice-limit fixture");
      let time = 0;
      const mixer = new AudioMixer(100, () => time);
      const sound = mono([256]);
      for (let index = 0; index < count; index++) {
        time = index * 50;
        expect(mixer.startSound(sound, { entity, channel: index, origin: { kind: "local" }, volume: 127 })).toBe(true);
      }
      time = count * 50;
      expect(mixer.startSound(sound, { entity, channel: count, origin: { kind: "local" }, volume: 127 })).toBe(false);
    }
  });

  test("uses strict allocation ages and ascending slot order for equal-age victims", () => {
    let time = 0, reads = 0;
    const mixer = new AudioMixer(100, () => { reads++; return time; }, 2);
    mixer.setEffectsVolume(1);
    mixer.startSound(mono([256]), { entity: 1, channel: 1, origin: { kind: "local" }, volume: 128 });
    mixer.startSound(mono([512]), { entity: 2, channel: 1, origin: { kind: "local" }, volume: 128 });
    expect(reads).toBe(4);
    expect(() => mixer.startSound(mono([1024]), { entity: 3, channel: 1, origin: { kind: "local" }, volume: 128 })).toThrow("undefined native listener fallback");
    expect(reads).toBe(5);
    time = 1;
    expect(mixer.startSound(mono([1024]), { entity: 3, channel: 1, origin: { kind: "local" }, volume: 128 })).toBe(true);
    expect(reads).toBe(6);
    expect(values(mixer.mix(1))).toEqual([637, 637]);
  });

  test("prefers an eligible matching entity and protects announcer channels", () => {
    let time = 0;
    const mixer = new AudioMixer(100, () => time, 3);
    mixer.setEffectsVolume(1);
    mixer.startSound(mono([256]), { entity: 2, channel: 1, origin: { kind: "local" }, volume: 128 });
    time = 1;
    mixer.startSound(mono([512]), { entity: 1, channel: 1, origin: { kind: "local" }, volume: 128 });
    time = 2;
    mixer.startSound(mono([1024]), { entity: 1, channel: 7, origin: { kind: "local" }, volume: 128 });
    time = 3;
    mixer.startSound(mono([2048]), { entity: 1, channel: 1, origin: { kind: "local" }, volume: 128 });
    expect(values(mixer.mix(1))).toEqual([1657, 1657]);
    const protectedMixer = new AudioMixer(100, () => time, 1);
    protectedMixer.startSound(mono([256]), { entity: 1, channel: 7, origin: { kind: "local" }, volume: 127 });
    time = 4;
    expect(() => protectedMixer.startLocalSound(mono([512]), 1)).toThrow("undefined native listener fallback");
  });

  test("reuses channels in source LIFO order after an ascending scan frees them", () => {
    let time = 0;
    const mixer = new AudioMixer(100, () => time, 3);
    mixer.setEffectsVolume(1);
    mixer.startSound(mono([256]), { entity: 1, channel: 1, origin: { kind: "local" }, volume: 128 });
    mixer.startSound(mono([512]), { entity: 2, channel: 1, origin: { kind: "local" }, volume: 128 });
    mixer.startSound(mono([1024, 1024, 1024]), { entity: 0, channel: 1, origin: { kind: "local" }, volume: 128 });
    mixer.mix(1);
    mixer.mix(0);
    time = 1;
    mixer.startSound(mono([2048]), { entity: 1, channel: 1, origin: { kind: "local" }, volume: 128 });
    mixer.startSound(mono([4096]), { entity: 2, channel: 1, origin: { kind: "local" }, volume: 128 });
    time = 2;
    mixer.startSound(mono([8192]), { entity: 3, channel: 1, origin: { kind: "local" }, volume: 128 });
    expect(values(mixer.mix(1))).toEqual([5610, 5610]);
  });

  test("uses signed-int millisecond differences across clock wrap", () => {
    let time = 2147483620;
    const mixer = new AudioMixer(100, () => time);
    const sound = mono([256]);
    expect(mixer.startLocalSound(sound, 1)).toBe(true);
    time = -2147483640;
    expect(mixer.startLocalSound(sound, 2)).toBe(false);
    time = -2147483600;
    expect(mixer.startLocalSound(sound, 2)).toBe(true);
  });

  test("repaints raw samples and absolute loop phases using current masked ring slots", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    mixer.queueRaw(mono([1000, 2000, 3000, 4000]), 1);
    mixer.updateLoopingSound(mono([256, 512]), frameLoop(1));
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(4))).toEqual([1062, 1062, 2125, 2125, 3062, 3062, 4125, 4125]);
    expect(values(mixer.mix({ startFrame: 1, endFrame: 3 }))).toEqual([2125, 2125, 3062, 3062]);
    mixer.clearSoundBuffer();
    expect(values(mixer.mix({ startFrame: 0, endFrame: 4 }))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

    const ring = new AudioMixer(100, () => 0);
    const samples = new Int16Array(ring.rawCapacity).fill(1234);
    ring.queueRaw({ sampleRate: 100, channels: 1, samples, frameCount: samples.length, loopStart: null }, 1);
    ring.mix(ring.rawCapacity);
    ring.queueRaw(mono([5678]), 1);
    expect(values(ring.mix({ startFrame: 0, endFrame: 1 }))).toEqual([5678, 5678]);
    expect(ring.sampleClock).toBe(1);
    expect(values(ring.mix({ startFrame: 1, endFrame: 2 }))).toEqual([1234, 1234]);
    expect(values(ring.mix({ startFrame: ring.rawCapacity, endFrame: ring.rawCapacity + 1 }))).toEqual([5678, 5678]);
    ring.mix({ startFrame: 0, endFrame: 0 });
    ring.queueRaw(mono([1]), 1);
    expect(ring.soundClock).toBe(ring.rawCapacity);

    const gap = new AudioMixer(100, () => 0);
    gap.queueRaw(mono([1000, 2000]), 1);
    gap.mix(4);
    gap.queueRaw(mono([5000]), 1);
    expect(values(gap.mix({ startFrame: 0, endFrame: 5 }))).toEqual([1000, 1000, 2000, 2000, 0, 0, 0, 0, 5000, 5000]);

    const stale = new AudioMixer(100, () => 0);
    stale.queueRaw({ sampleRate: 100, channels: 1, samples, frameCount: samples.length, loopStart: null }, 1);
    stale.mix(stale.rawCapacity + 2);
    stale.queueRaw(mono([5678]), 1);
    // S_PaintChannels reads old ring bytes in an underrun gap once rawEnd advances.
    expect(values(stale.mix({ startFrame: stale.rawCapacity, endFrame: stale.rawCapacity + 3 }))).toEqual([1234, 1234, 1234, 1234, 5678, 5678]);
  });

  test("rejects invalid paint ranges and allocation clocks before consuming channels", () => {
    let time = 0;
    const mixer = new AudioMixer(100, () => time, 1);
    for (const range of [{ startFrame: -Infinity, endFrame: 0 }, { startFrame: 2, endFrame: 1 }, { startFrame: 0, endFrame: NaN }, { startFrame: 0.5, endFrame: 1 }]) {
      expect(() => mixer.mix(range)).toThrow(RangeError);
      expect(mixer.sampleClock).toBe(0);
    }
    for (time of [NaN, Infinity, 0.5, 2147483648]) expect(() => mixer.startLocalSound(mono([256]), 1)).toThrow("signed-int milliseconds");
    time = 0;
    expect(mixer.startLocalSound(mono([256]), 1)).toBe(true);
    const large = new AudioMixer(100, () => 0);
    large.selectTime(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    expect(() => large.queueRaw(mono([1]), 1)).toThrow("raw PCM end frame");
  });

  test("retains source partial allocation if the second clock read fails, until channel setup", () => {
    let reads = 0, fail = true;
    const mixer = new AudioMixer(100, () => {
      reads++;
      return fail && reads === 2 ? NaN : 0;
    }, 1);
    expect(() => mixer.startLocalSound(mono([256]), 1)).toThrow("signed-int milliseconds");
    fail = false;
    expect(() => mixer.startLocalSound(mono([256]), 1)).toThrow("undefined native listener fallback");
    mixer.clearSoundBuffer();
    expect(mixer.startLocalSound(mono([256]), 1)).toBe(true);
  });
});

describe("looping and raw timelines", () => {
  test("signed listeners spatialize fixed origins and only reject a reached Doppler position read", () => {
    for (const entity of [-1, -2147483648, 1024, 2147483647]) {
      const mixer = new AudioMixer(100, () => 0);
      mixer.setEffectsVolume(1);
      mixer.setListener(entity, vec3(0, 0, 0), DEFAULT_AXIS);
      mixer.startSound(mono([256]), { entity, channel: -1, volume: 127,
        origin: { kind: "fixed", position: vec3(0, 2000, 0) } });
      mixer.startSound(mono([256]), { entity: 4, channel: -1, volume: 127,
        origin: { kind: "fixed", position: vec3(0, 100, 0) } });
      mixer.setListener(entity, vec3(0, 0, 0), DEFAULT_AXIS);
      expect(values(mixer.mix(1))).toEqual([250, 126]);
      mixer.clearSoundBuffer();
      mixer.updateRealLoopingSound(mono([256]), realLoop(4));
      mixer.updateLoopingSound(mono([256]), frameLoop(5));
      mixer.setListener(entity, vec3(0, 0, 0), DEFAULT_AXIS);
      expect(values(mixer.mix(1))).toEqual([107, 107]);
      mixer.clearSoundBuffer();
      mixer.setDopplerEnabled(false);
      mixer.updateLoopingSound(mono([256]), { ...frameLoop(4), velocity: vec3(1, 0, 0) });
      mixer.setDopplerEnabled(true);
      expect(() => mixer.updateLoopingSound(mono([256]), {
        entity: 4, origin: vec3(0, 100, 0), velocity: vec3(1, 0, 0), frameNumber: 2,
      })).toThrow(`Missing source sound position for entity ${entity}`);
      mixer.clearLoopingSounds(true);
      mixer.startSound(mono([256]), { entity: 4, channel: 1, volume: 127, origin: { kind: "entity", entity: 4 } });
      mixer.setListener(entity, vec3(0, 0, 0), DEFAULT_AXIS);
      expect(values(mixer.mix(1))).toEqual([123, 0]);
    }
    const mixer = new AudioMixer(100, () => 0);
    for (const entity of [-2147483649, 2147483648, 0.5, NaN, Infinity]) {
      expect(() => mixer.setListener(entity, vec3(0, 0, 0), DEFAULT_AXIS)).toThrow("listener entity must be a signed 32-bit integer");
    }
  });

  test("empty decoded raw audio retains minimum reset and overflow side effects without PCM writes", () => {
    for (const empty of [mono([], 22050), stereo([], 22050)]) {
      const mixer = new AudioMixer(22050, () => 0), cvars = new CvarRegistry();
      cvars.register("developer", "1");
      mixer.bindSoundCvars(cvars);
      const calls: { readonly text: string; readonly rawEnd: number }[] = [];
      let rejectPrint = true;
      mixer.bindConsoleOutput(new ConsoleOutput(text => {
        calls.push({ text, rawEnd: mixer.rawEnd });
        if (rejectPrint) throw new Error("raw diagnostic abort");
      }));
      mixer.selectTime(20, 20);
      expect(() => mixer.queueRaw(empty, 1)).toThrow("raw diagnostic abort");
      expect(mixer.rawEnd).toBe(0);
      rejectPrint = false;
      mixer.queueRaw(empty, 1);
      expect(mixer.rawEnd).toBe(20);
      expect(calls).toEqual([
        { text: "S_RawSamples: resetting minimum: 0 < 20\n", rawEnd: 0 },
        { text: "S_RawSamples: resetting minimum: 0 < 20\n", rawEnd: 0 },
      ]);
      mixer.queueRaw(mono(new Array<number>(16385).fill(1000), 22050), 1);
      const retained = mixer.getRawSamplePointer().slice();
      calls.length = 0;
      rejectPrint = true;
      expect(() => mixer.queueRaw(empty, 1)).toThrow("raw diagnostic abort");
      expect(mixer.rawEnd).toBe(16405);
      expect(calls).toEqual([{ text: "S_RawSamples: overflowed 16405 > 20\n", rawEnd: 16405 }]);
      expect(mixer.getRawSamplePointer()).toEqual(retained);
      expect(() => mixer.queueRaw({ ...empty, frameCount: -1 }, 1)).toThrow("PCM frame count");
      expect(() => mixer.queueRaw({ ...empty, samples: new Int16Array([1]) }, 1)).toThrow("expected 0");
      expect(() => mixer.queueRaw({ ...empty, loopStart: 0 }, 1)).toThrow("PCM loop start");
    }
  });

  test("retained runtime mixers gate playback before validation and read the live Doppler cvar", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setPlaybackEnabled(false);
    expect(mixer.startSound(mono([]), { entity: -1, channel: -1, volume: -1, origin: { kind: "local" } })).toBe(false);
    mixer.queueRaw(mono([]), -1);
    mixer.updateLoopingSound(mono([]), frameLoop(-1));
    expect(mixer.rawEnd).toBe(0);
    const cvars = new CvarRegistry();
    cvars.register("s_doppler", "0");
    cvars.register("s_testsound", "0");
    mixer.bindSoundCvars(cvars);
    mixer.setPlaybackEnabled(true);
    mixer.setEffectsVolume(1);
    const sound = mono([256, 512, 768, 1024]);
    const options = { entity: 1, origin: vec3(1, 0, 0), velocity: vec3(19, 0, 0), frameNumber: 1 };
    mixer.updateLoopingSound(sound, options);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix({ startFrame: 0, endFrame: 1 }))).toEqual([62, 62]);
    cvars.set("s_doppler", "1");
    mixer.updateLoopingSound(sound, { ...options, frameNumber: 2 });
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix({ startFrame: 0, endFrame: 1 }))).toEqual([156, 156]);
  });

  test("buffer clear resets channel capacity and loop origins while retaining listener and gain", () => {
    const mixer = new AudioMixer(100, () => 0, 2);
    mixer.setEffectsVolume(1);
    mixer.setListener(7, vec3(0, 0, 0), DEFAULT_AXIS);
    const sound = mono([256, 512, 768]);
    mixer.startSound(sound, { entity: 7, channel: 0, origin: { kind: "local" }, volume: 127 });
    mixer.startSound(sound, { entity: 8, channel: 0, origin: { kind: "local" }, volume: 127 });
    mixer.updateEntityPosition(4, vec3(0, 100, 0));
    mixer.mix(1);
    mixer.clearSoundBuffer();
    expect(mixer.sampleClock).toBe(1);
    expect(mixer.rawEnd).toBe(0);
    expect(mixer.startSound(sound, { entity: 7, channel: 0, origin: { kind: "local" }, volume: 127 })).toBe(true);
    expect(mixer.startSound(sound, { entity: 8, channel: 0, origin: { kind: "local" }, volume: 127 })).toBe(true);
    expect(values(mixer.mix(1))).toEqual([253, 253]);
    mixer.clearSoundBuffer();
    expect(mixer.startSound(mono([256]), { entity: 4, channel: 1, origin: { kind: "entity", entity: 4 }, volume: 127 })).toBe(true);
    mixer.setListener(7, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([62, 62]);
    mixer.clearSoundBuffer();
    expect(mixer.startSound(mono([256]), { entity: 7, channel: 1, origin: { kind: "fixed", position: vec3(0, -2000, 0) }, volume: 127 })).toBe(true);
    expect(values(mixer.mix(1))).toEqual([126, 126]);
  });

  test("frame loop clearing preserves one-shots and raw audio", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    mixer.startSound(mono([256, 512]), { entity: 1, channel: 1, origin: { kind: "local" }, volume: 128 });
    mixer.queueRaw(stereo([1000, -1000, 2000, -2000]), 1);
    mixer.updateLoopingSound(mono([2048]), frameLoop(2));
    mixer.clearLoopingSounds(false);
    expect(values(mixer.mix(2))).toEqual([1127, -873, 2255, -1745]);
  });

  test("real loops persist across frame clears and explicit kill-all preserves raw audio", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    mixer.updateRealLoopingSound(mono([256, 512]), realLoop(2));
    mixer.clearLoopingSounds(false);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([44, 44]);
    mixer.clearLoopingSounds(false);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([89, 89]);
    mixer.queueRaw(stereo([321, -321]), 1);
    mixer.clearLoopingSounds(true);
    expect(values(mixer.mix(1))).toEqual([321, -321]);
  });

  test("latest loop registration replaces the same entity's frame lifetime", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    const sound = mono([256]);
    mixer.updateRealLoopingSound(sound, realLoop(2));
    mixer.updateLoopingSound(sound, frameLoop(2));
    mixer.clearLoopingSounds(false);
    expect(values(mixer.mix(1))).toEqual([0, 0]);
    mixer.updateLoopingSound(sound, frameLoop(2, 2));
    mixer.updateRealLoopingSound(sound, realLoop(2));
    mixer.clearLoopingSounds(false);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([44, 44]);
    mixer.stopLoopingSound(2);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([0, 0]);
  });

  test("keeps loop sounds on the global painted-time cycle across mix calls", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    mixer.updateLoopingSound(mono([256, 512]), frameLoop(1));
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(3))).toEqual([62, 62, 125, 125, 62, 62]);
    expect(mixer.sampleClock).toBe(3);
    expect(values(mixer.mix(3))).toEqual([125, 125, 62, 62, 125, 125]);
    expect(mixer.sampleClock).toBe(6);
  });

  test("merges identical loop sounds and caps their spatial volumes at 255", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    const sound = mono([256]);
    for (let entity = 1; entity <= 5; entity++) mixer.updateLoopingSound(sound, frameLoop(entity));
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([254, 254]);
  });

  test("merges later duplicate loops before applying the loop-channel capacity", () => {
    const mixer = new AudioMixer(100, () => 0, 2);
    mixer.setEffectsVolume(1);
    const first = mono([256]);
    mixer.updateLoopingSound(first, frameLoop(1));
    mixer.updateLoopingSound(mono([256]), frameLoop(2));
    mixer.updateLoopingSound(mono([2048]), frameLoop(3));
    mixer.updateLoopingSound(first, frameLoop(4));
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([188, 188]);
  });

  test("updates and explicitly stops the loop owned by an entity", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    mixer.updateLoopingSound(mono([256]), frameLoop(9));
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([62, 62]);
    mixer.updateLoopingSound(mono([512]), frameLoop(9, 2));
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([125, 125]);
    mixer.stopLoopingSound(9);
    mixer.setListener(0, vec3(0, 0, 0), DEFAULT_AXIS);
    expect(values(mixer.mix(1))).toEqual([0, 0]);
  });

  test("resamples stereo raw PCM and applies music volume", () => {
    const raw = new AudioMixer(4, () => 0);
    raw.queueRaw(stereo([100, -100, 200, -200], 2), 1);
    expect(values(raw.mix(4))).toEqual([
      100, -100,
      100, -100,
      200, -200,
      200, -200,
    ]);

    const music = new AudioMixer(100, () => 0);
    music.setMusicVolume(0.5);
    music.queueMusic(stereo([1000, -1000]));
    expect(values(music.mix(1))).toEqual([500, -500]);
  });

  test("converts raw gain through the source float parameter before integer volume", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.queueRaw(stereo([1000, -1000]), 0.499999999);
    expect(values(mixer.mix(1))).toEqual([500, -500]);
    expect(() => mixer.queueRaw(mono([256]), 8388608)).toThrow("signed-int gain conversion");
    expect(mixer.rawEnd).toBe(1);
  });

  test("writes oversized resampled PCM completely and paints the wrapped slots", () => {
    const mixer = new AudioMixer(2, () => 0);
    const input = Int16Array.from({ length: 9000 }, (_, index) => index - 4500);
    const sound: PcmSound = { sampleRate: 1, channels: 1, samples: input, frameCount: input.length, loopStart: null };
    mixer.queueRaw(sound, 1);
    expect(mixer.rawEnd).toBe(18000);
    const firstOutput = mixer.mix(mixer.rawCapacity);
    expect(values(firstOutput.slice(0, 6))).toEqual([3692, 3692, 3692, 3692, 3693, 3693]);
    const secondOutput = mixer.mix(18000 - mixer.rawCapacity);
    expect(values(secondOutput.slice(0, 4))).toEqual([3692, 3692, 3692, 3692]);
    expect(values(secondOutput.slice(-4))).toEqual([4499, 4499, 4499, 4499]);
  });

  test("stops entity-owned voices, loops, raw audio, and all audio", () => {
    const mixer = new AudioMixer(100, () => 0);
    mixer.setEffectsVolume(1);
    expect(mixer.startSound(mono([256]), {
      entity: 1,
      channel: 1,
      origin: { kind: "local" },
      volume: 128,
    })).toBe(true);
    mixer.updateLoopingSound(mono([512]), frameLoop(1));
    mixer.stopEntity(1);
    expect(values(mixer.mix(1))).toEqual([0, 0]);

    mixer.queueRaw(stereo([1000, 1000]), 1);
    mixer.stopAll();
    expect(values(mixer.mix(1))).toEqual([0, 0]);
  });
});

describe("mixer boundaries", () => {
  test("rejects stereo effects and malformed construction or mix sizes", () => {
    expect(() => new AudioMixer(0, () => 0)).toThrow(RangeError);
    expect(() => new AudioMixer(100, () => 0, 0)).toThrow(RangeError);
    const mixer = new AudioMixer(100, () => 0);
    expect(() => mixer.startSound(stereo([1, 2]), {
      entity: 1,
      channel: 1,
      origin: { kind: "local" },
      volume: 127,
    })).toThrow("sound effects must be mono");
    expect(() => mixer.mix(-1)).toThrow(RangeError);
  });

  test("raw diagnostics retain source reset, gain validation and completed overflow ordering", () => {
    const mixer = new AudioMixer(100, () => 0), cvars = new CvarRegistry();
    cvars.register("developer", "1");
    cvars.register("s_testsound", "0");
    mixer.bindSoundCvars(cvars);
    const calls: { readonly text: string; readonly rawEnd: number }[] = [];
    let rejectOverflow = false;
    mixer.bindConsoleOutput(new ConsoleOutput(text => {
      calls.push({ text, rawEnd: mixer.rawEnd });
      if (rejectOverflow && text.includes("overflowed")) throw new Error("overflow print abort");
    }));
    mixer.selectTime(20, 20);
    expect(() => mixer.queueRaw(mono([256]), 8388608)).toThrow("signed-int gain conversion");
    expect(calls).toEqual([]); expect(mixer.rawEnd).toBe(0);
    mixer.queueRaw(mono(new Array<number>(16385).fill(1000)), 1);
    expect(calls).toEqual([
      { text: "S_RawSamples: resetting minimum: 0 < 20\n", rawEnd: 0 },
      { text: "S_RawSamples: overflowed 16405 > 20\n", rawEnd: 16405 },
    ]);
    calls.length = 0;
    cvars.set("developer", "0.5", true);
    mixer.queueRaw(mono([2000]), 1);
    expect(calls).toEqual([]);
    cvars.set("developer", "-1", true); rejectOverflow = true;
    expect(() => mixer.queueRaw(mono([3000]), 1)).toThrow("overflow print abort");
    expect(mixer.rawEnd).toBe(16407);
    expect(values(mixer.mix({ startFrame: 22, endFrame: 23 }))).toEqual([3000, 3000]);
    expect(calls).toEqual([{ text: "S_RawSamples: overflowed 16407 > 20\n", rawEnd: 16407 }]);
    mixer.setPlaybackEnabled(false);
    mixer.queueRaw(mono([256]), 8388608);
    expect(mixer.rawEnd).toBe(16407);
  });

  test("raw ring overflow overwrites earlier slots without moving sound time", () => {
    const mixer = new AudioMixer(100, () => 0);
    const oversized: PcmSound = {
      sampleRate: 100,
      channels: 1,
      samples: Int16Array.from({ length: mixer.rawCapacity + 1 }, (_, index) => index),
      frameCount: mixer.rawCapacity + 1,
      loopStart: null,
    };
    mixer.queueRaw(oversized, 1);
    expect(mixer.rawEnd).toBe(mixer.rawCapacity + 1);
    expect(mixer.soundClock).toBe(0);
    expect(values(mixer.mix({ startFrame: 0, endFrame: 2 }))).toEqual([16384, 16384, 1, 1]);

    const exact: PcmSound = {
      sampleRate: 100,
      channels: 1,
      samples: new Int16Array(mixer.rawCapacity),
      frameCount: mixer.rawCapacity,
      loopStart: null,
    };
    mixer.queueRaw(exact, 1);
    expect(mixer.rawEnd).toBe(mixer.rawCapacity * 2 + 1);
    mixer.queueRaw(mono([1]), 1);
    mixer.mix(1);
    mixer.queueRaw(mono([1]), 1);
    expect(mixer.rawEnd).toBe(mixer.rawCapacity * 2 + 3);
    mixer.clearRaw();
    expect(mixer.rawEnd).toBe(mixer.sampleClock);
  });
});
