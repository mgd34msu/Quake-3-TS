import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BinaryWriter } from "../src/core/binary.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { RoqDecoder, RoqDecoderScratch } from "../src/cinematic/roq.ts";
import { RoqPlayback } from "../src/cinematic/playback.ts";
import { RoqStream } from "../src/cinematic/roq-stream.ts";
import type { RoqPlaybackAudio, RoqPlaybackFrame, RoqPlaybackOptions, RoqPlaybackTick } from "../src/cinematic/playback.ts";

class RecordedPlayback extends RoqPlayback {
  private readonly delivered: RoqPlaybackAudio[];
  readonly diagnostics: string[];
  constructor(data: Uint8Array | RoqStream, options: Omit<RoqPlaybackOptions, "onAudio" | "developerPrint">) {
    const delivered: RoqPlaybackAudio[] = [];
    const diagnostics: string[] = [];
    super(data, { ...options, onAudio: audio => { delivered.push(audio); }, developerPrint: text => { diagnostics.push(text); } });
    this.delivered = delivered;
    this.diagnostics = diagnostics;
  }
  drainAudio(): readonly RoqPlaybackAudio[] { return this.delivered.splice(0); }
}

class TestPlayback extends RecordedPlayback {
  constructor(data: Uint8Array | RoqStream, options: Omit<RoqPlaybackOptions, "clock" | "onAudio" | "developerPrint"> & { readonly startTime?: number } = {}) {
    super(data, { ...options, clock: { sample: () => options.startTime ?? 0 } });
  }
  at(time: number): RoqPlaybackTick { return this.run({ sample: () => time }); }
  restartAt(time: number): void { this.restart({ sample: () => time }); }
  resetAt(time: number): void { this.reset({ sample: () => time }); }
}

class ScriptClock {
  readonly observed: number[] = [];
  constructor(private readonly values: readonly number[]) {}
  sample(): number {
    const value = this.values[this.observed.length];
    if (value === undefined) throw new Error("Unexpected cinematic clock read");
    this.observed.push(value);
    return value;
  }
}

function chunk(id: number, data: readonly number[], flags = 0): Uint8Array {
  const writer = new BinaryWriter(data.length + 8);
  writer.u16(id);
  writer.u32(data.length);
  writer.u16(flags);
  writer.bytes(Uint8Array.from(data));
  return writer.finish();
}

function movie(chunks: readonly Uint8Array[], rate = 30): Uint8Array {
  // Native RoQ lookahead skips the final chunk, so playable fixtures end with HANG.
  const writer = new BinaryWriter(chunks.reduce((size, value) => size + value.length, 16));
  writer.u16(0x1084);
  writer.u32(0xffffffff);
  writer.u16(rate);
  for (const value of chunks) writer.bytes(value);
  writer.bytes(chunk(0x1013, []));
  return writer.finish();
}

const info = chunk(0x1001, [8, 0, 8, 0, 8, 0, 4, 0]);
const book = chunk(0x1002, [0, 0, 0, 0, 128, 128, 255, 255, 255, 255, 128, 128, 128, 128, 128, 128, 128, 128,
  0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2], 0x0303);
const frame0 = chunk(0x1011, [0, 128, 0]);
const frame1 = chunk(0x1011, [0, 128, 1]);
const frame2 = chunk(0x1011, [0, 128, 2]);
const clip = movie([info, book, frame0, frame1, frame2]);

function frame(tick: RoqPlaybackTick): RoqPlaybackFrame {
  if (tick.update.kind !== "frame") throw new Error("Expected newly published cinematic frame");
  return tick.update.frame;
}

describe("clock-driven RoQ playback", () => {
  test("invalid lookahead diagnostic follows immediate audio and frame publication without repeating at EOF", () => {
    const following = chunk(0x1084, []), effects: string[] = [];
    const clock = { time: 0, sample(): number { return this.time; } };
    const playback = new RoqPlayback(movie([info, book, chunk(0x1020, [1]), frame0, following]), {
      clock, onAudio: () => { effects.push("audio"); }, onFrame: () => { effects.push("frame"); },
      developerPrint: text => { effects.push(text); },
    });
    playback.run(clock); clock.time = 34;
    expect(playback.run(clock).status).toBe("ended");
    expect(effects).toEqual(["audio", "frame", "roq_size>65536||roq_id==0x1084\n"]);
    playback.run(clock);
    expect(effects).toHaveLength(3);
  });

  test("native stepped clock samples init, four first-INFO sites, then two no-decode sites", () => {
    // Unchanged cl_cin.c trace: /tmp/q3-image-cinematic-audit-ZF4F99/run.sh, cinematic_first_info_live_clock.
    const clock = new ScriptClock([2000, 2001, 2002, 2003, 2004, 2005, 2006]);
    const playback = new RecordedPlayback(clip, { clock });
    expect(clock.observed).toEqual([2000]);
    expect(playback.dimensions).toBeNull();
    expect(playback.run(clock).update.kind).toBe("unchanged");
    expect(clock.observed).toEqual([2000, 2001, 2002, 2003, 2004]);
    expect(playback.dimensions).toEqual({ width: 8, height: 8 });
    expect(playback.run(clock).update.kind).toBe("unchanged");
    expect(clock.observed).toEqual([2000, 2001, 2002, 2003, 2004, 2005, 2006]);
    const invalidClock = new ScriptClock([]);
    expect(() => new RecordedPlayback(new Uint8Array(0), { clock: invalidClock })).toThrow();
    expect(invalidClock.observed).toEqual([]);
  });

  test("INFO target is recomputed only if its unsigned epoch changed", () => {
    const clock = new ScriptClock([0, 0, 0, 0]);
    const playback = new RecordedPlayback(clip, { clock });
    playback.run(clock);
    expect(clock.observed).toEqual([0, 0, 0, 0]);
  });

  test("switch restart samples initialization then continues a no-decode run before the next INFO", () => {
    const playback = new TestPlayback(clip);
    playback.at(0);
    playback.at(67);
    expect(playback.currentPointer).toEqual({ offset: 256, byteLength: 256 });
    const clock = new ScriptClock([1000, 1001, 1002, 1003, 1004, 1005, 1006]);
    playback.restart(clock);
    expect(playback.currentPointer).toEqual({ offset: 256, byteLength: 256 });
    expect(playback.run(clock)).toEqual({ status: "playing", update: { kind: "unchanged" } });
    expect(clock.observed).toEqual([1000, 1001, 1002]);
    expect(playback.run(clock).update.kind).toBe("unchanged");
    expect(clock.observed).toEqual([1000, 1001, 1002, 1003, 1004, 1005, 1006]);
    expect(playback.currentPointer).toEqual({ offset: 256, byteLength: 256 });
  });

  test("natural EOF reset samples its new epoch and target before normalizing LOOPED", () => {
    const playback = new TestPlayback(clip, { loop: true });
    playback.at(0);
    const clock = new ScriptClock([1000, 1001, 1002, 1003]);
    const result = playback.run(clock);
    expect(result.status).toBe("playing");
    expect(frame(result).index).toBe(2);
    expect(clock.observed).toEqual([1000, 1001, 1002, 1003]);
    const next = new ScriptClock([1004, 1005, 1006, 1007]);
    expect(playback.run(next).update.kind).toBe("unchanged");
    expect(next.observed).toEqual([1004, 1005, 1006, 1007]);
  });

  test("pre-INFO audio completes before INFO samples its new epoch", () => {
    const clock = new ScriptClock([1000, 1001, 1002, 1003, 1004]);
    const data = movie([chunk(0x1020, [1]), chunk(0x1021, [2, 3]), info, book, frame0]);
    const observed: { readonly reset: boolean; readonly clocks: readonly number[] }[] = [];
    const diagnostics: string[] = [];
    const playback = new RoqPlayback(data, { clock, developerPrint: text => { diagnostics.push(text); }, onAudio: audio => { observed.push({ reset: audio.resetStream, clocks: [...clock.observed] }); } });
    expect(playback.run(clock).status).toBe("playing");
    expect(observed).toEqual([
      { reset: false, clocks: [1000, 1001, 1002] }, { reset: true, clocks: [1000, 1001, 1002] },
    ]);
    expect(clock.observed).toEqual([1000, 1001, 1002, 1003, 1004]);
  });

  test("post-INFO audio and frames complete in one source run without extra clock samples", () => {
    const playback = new TestPlayback(movie([info, book, chunk(0x1020, [1]), frame0, chunk(0x1020, [2]), frame1]));
    playback.at(0);
    const clock = new ScriptClock([100, 101]);
    expect(playback.run(clock).status).toBe("ended");
    expect(playback.drainAudio().map(event => Array.from(event.samples))).toEqual([[1], [4]]);
    expect(clock.observed).toEqual([100, 101]);
    expect(playback.currentPointer).toEqual({ offset: 256, byteLength: 256 });
  });

  test("shared restart retains another handle's scratch while public frames remain owned and reset hard-clears", () => {
    const scratch = new RoqDecoderScratch();
    const a = new TestPlayback(movie([info, chunk(0x1011, [0, 0]), book, frame1]), { scratch });
    a.at(0); a.at(34);
    const retained = a.currentFrame;
    expect(retained?.rgba[0]).toBe(0);
    const b = new TestPlayback(movie([info, book, frame1]), { scratch });
    b.at(0); b.at(34);
    a.restartAt(200); a.at(200);
    a.at(200);
    expect(frame(a.at(234)).rgba[0]).toBe(255);
    expect(retained?.rgba[0]).toBe(0);
    a.resetAt(400); a.at(400);
    expect(frame(a.at(434)).rgba[0]).toBe(0);
  });
  test("stereo before the first info requests a raw-stream reset, unlike mono or later stereo", () => {
    const stereo = chunk(0x1021, [1, 2], 0), mono = chunk(0x1020, [1], 0);
    const playback = new TestPlayback(movie([mono, stereo, info, stereo, book, frame0]), { loop: true });
    playback.at(0);
    expect(playback.drainAudio().map(event => event.resetStream)).toEqual([false, true]);
    playback.at(100);
    expect(playback.drainAudio().map(event => event.resetStream)).toEqual([false]);
    playback.at(200); playback.at(200);
    expect(playback.drainAudio().map(event => event.resetStream)).toEqual([false, true]);
  });
  // Measured with unchanged cl_cin.c in /tmp/q3-cinematic-schedule-uzDQ9r.
  test("first INFO rebases delayed startup to the first run, not construction", () => {
    const playback = new TestPlayback(movie([info, book, frame0, frame1, frame2], 30), { startTime: 1000 });
    expect(playback.at(1090).update.kind).toBe("unchanged");
    expect(playback.at(1123).update.kind).toBe("unchanged");
    expect(frame(playback.at(1124)).index).toBe(0);
    expect(playback.at(1156).update.kind).toBe("unchanged");
    expect(frame(playback.at(1157)).index).toBe(1);
  });

  test("native target arithmetic spills only the completed expression and epochs truncate without float32 rounding", () => {
    const long = movie([info, book, ...Array.from({ length: 5034 }, () => frame0)], 30);
    const playback = new TestPlayback(long, { silent: true });
    playback.at(16777215);
    expect(frame(playback.at(16944948.610000372)).index).toBe(5031);
    const epoch = new TestPlayback(movie([info, book, frame0, frame1], 30));
    epoch.at(16777217);
    expect(epoch.at(16777250).update.kind).toBe("unchanged");
    expect(frame(epoch.at(16777251)).index).toBe(0);
  });

  test("native signed thisTime spill differs from unsigned epoch conversion at the shader 100 ms boundary", () => {
    // Unchanged cl_cin.c, /tmp/q3-cinematic-schedule-uzDQ9r/oracle, i386 GCC O1 x87.
    // With CL_ScaledMilliseconds overridden to 16777219 and scale=1: epoch=16777219,
    // last=16777220. Next override 16777320 keeps epoch and produces numQuads=3.
    const playback = new TestPlayback(clip, { startTime: 16777219, shader: true, loop: true });
    expect(playback.at(16777219).update.kind).toBe("unchanged");
    const advanced = frame(playback.at(16777320));
    expect(advanced.index).toBe(2);
    expect(advanced.time).toBe(16777319);
    expect(advanced.loop).toBe(0);
  });

  test("backward clocks preserve the current bucket or drain forward when target count differs", () => {
    const data = movie([info, book, frame0, frame1, frame2], 30);
    const same = new TestPlayback(data, { shader: true, loop: true });
    same.at(1000);
    expect(frame(same.at(1035)).index).toBe(0);
    expect(same.at(1034).update.kind).toBe("unchanged");
    const crossing = new TestPlayback(data, { shader: true, loop: true });
    crossing.at(1000); crossing.at(1034);
    expect(frame(crossing.at(1033)).index).toBe(2);
    expect(crossing.at(1033).update.kind).toBe("unchanged");
    expect(frame(crossing.at(1067)).loop).toBe(1);
    const wrapped = new TestPlayback(data, { shader: true, loop: true });
    wrapped.at(1000); wrapped.at(1034);
    expect(frame(wrapped.at(0)).index).toBe(2);
    expect(wrapped.at(0).update.kind).toBe("unchanged");
    expect(wrapped.currentFrame?.index).toBe(2);
    expect(frame(wrapped.at(34)).index).toBe(0);
  });

  test("signed shader gaps shift only beyond 100 ms and retain phase without unsigned underflow", () => {
    const data = movie([info, book, frame0, frame1, frame2], 30);
    for (const nextTime of [1135, 933]) {
      const playback = new TestPlayback(data, { shader: true, loop: true });
      playback.at(1000); playback.at(1034);
      expect(playback.at(nextTime).update.kind).toBe("unchanged");
      expect(frame(playback.at(nextTime + 34)).index).toBe(1);
    }
    for (const nextTime of [1134, 934]) {
      const playback = new TestPlayback(data, { shader: true, loop: true });
      playback.at(1000); playback.at(1034);
      expect(frame(playback.at(nextTime)).index).toBe(2);
    }
  });

  test("source EOF lookahead skips a final frame but not a frame followed by HANG", () => {
    const data = movie([info, book, frame0, frame1, frame2], 30);
    for (const [bytes, expected] of [[data, 2], [data.subarray(0, -8), 1]] satisfies readonly [Uint8Array, number][]) {
      const playback = new TestPlayback(bytes, { hold: true });
      playback.at(0);
      const last = playback.at(134);
      expect(last.status).toBe("held");
      expect(frame(last).index).toBe(expected);
      expect(playback.at(0).update.kind).toBe("unchanged");
    }
  });

  test("packet frame batches finish atomically and target overshoot drains to held EOF", () => {
    const packet = chunk(0x1030, [...frame0, ...frame1, ...frame2], 3);
    const data = movie([info, book, packet], 30);
    const playback = new TestPlayback(data, { hold: true });
    playback.at(0);
    const tick = playback.at(34);
    expect(tick.status).toBe("held");
    expect(frame(tick).index).toBe(2);
    const finalPacket = new TestPlayback(data.subarray(0, -8), { hold: true });
    finalPacket.at(0);
    expect(finalPacket.at(34)).toEqual({ status: "held", update: { kind: "unchanged" } });
  });

  test("unknown cinematic chunks end or loop instead of holding, including packet children", () => {
    for (const packed of [false, true]) {
      const unknown = packed ? chunk(0x1030, [...chunk(0x7777, [1]), ...frame1], 2) : chunk(0x7777, [1]);
      const data = movie([info, book, frame0, unknown, frame1]);
      for (const loop of [false, true]) {
        const playback = new TestPlayback(data, { hold: true, loop });
        playback.at(0);
        expect(frame(playback.at(34)).index).toBe(0);
        const endingClock = new ScriptClock(loop ? [67, 67, 67] : [67, 67]);
        expect(playback.run(endingClock).status).toBe(loop ? "looped" : "ended");
        expect(endingClock.observed).toEqual(loop ? [67, 67, 67] : [67, 67]);
        expect(playback.currentFrame?.index).toBe(0);
        expect(playback.diagnostics).toEqual([]);
        if (loop) {
          const deferredClock = new ScriptClock([67, 67]);
          expect(playback.run(deferredClock)).toEqual({ status: "playing", update: { kind: "unchanged" } });
          expect(deferredClock.observed).toEqual([67, 67]);
          const infoClock = new ScriptClock([101, 101, 101, 101]);
          expect(playback.run(infoClock).update.kind).toBe("unchanged");
          expect(infoClock.observed).toEqual([101, 101, 101, 101]);
          if (packed) {
            // Reset at 67 retains inMemory=1, so INFO at 101 redumps the retained codebook.
            // Its zero header reaches an invalid following header at 135 and causes reset two.
            // INFO rebases at 168; only the run at 202 publishes this loop's first frame.
            for (const time of [135, 168]) {
              expect(playback.at(time)).toEqual({ status: "playing", update: { kind: "unchanged" } });
              expect(playback.currentFrame?.loop).toBe(0);
            }
            const next = frame(playback.at(202));
            expect([next.index, next.loop]).toEqual([0, 2]);
          } else {
            expect(frame(playback.at(135)).loop).toBe(1);
            expect(playback.at(168).status).toBe("looped");
          }
        } else expect(playback.at(1000).status).toBe("ended");
      }
    }
  });

  test("unknown chunks with invalid following headers reset inside the interrupt", () => {
    const oversized = chunk(0x1013, []);
    new DataView(oversized.buffer).setUint32(2, 65537, true);
    for (const following of [oversized, chunk(0x1084, [])]) {
      const children = [...chunk(0x7777, [1]), ...following];
      for (const unknown of [Uint8Array.from(children), chunk(0x1030, children, 1)]) {
        const playback = new TestPlayback(movie([info, book, frame0, unknown, frame1]), { hold: true, loop: true });
        playback.at(0); playback.at(34);
        const endingClock = new ScriptClock([67, 67, 67, 67]);
        expect(playback.run(endingClock).status).toBe("playing");
        expect(endingClock.observed).toEqual([67, 67, 67, 67]);
        expect(playback.diagnostics).toEqual(["roq_size>65536||roq_id==0x1084\n"]);
        const infoClock = new ScriptClock([67, 67, 67]);
        expect(playback.run(infoClock).update.kind).toBe("unchanged");
        expect(infoClock.observed).toEqual([67, 67, 67]);
        expect(frame(playback.at(101)).loop).toBe(1);
      }
    }
  });

  test("natural loops retain both physical frame buffers and codebooks", () => {
    const skip = chunk(0x1011, [0, 0]);
    for (const count of [2, 3]) {
      const data = movie(count === 2 ? [info, book, skip, frame1] : [info, book, skip, frame1, frame2]);
      const playback = new TestPlayback(data, { loop: true, silent: true });
      playback.at(0);
      playback.at(count * 1000 / 30);
      playback.at((count + 1) * 1000 / 30);
      playback.at((count + 1) * 1000 / 30);
      const loopFrame = frame(playback.at((count + 2) * 1000 / 30));
      expect([loopFrame.index, loopFrame.loop]).toEqual([0, 1]);
      expect(Array.from(loopFrame.rgba.subarray(0, 4))).toEqual(count === 2 ? [0, 0, 0, 0] : [129, 128, 129, 255]);
    }
    const books = new TestPlayback(movie([info, frame0, book, frame1, frame2]), { loop: true, silent: true });
    books.at(0);
    expect(Array.from(frame(books.at(34)).rgba.subarray(0, 4))).toEqual([0, 0, 0, 0]);
    books.at(100); books.at(134); books.at(134);
    expect(Array.from(frame(books.at(168)).rgba.subarray(0, 4))).toEqual([1, 0, 1, 255]);
  });

  test("source numQuads timing starts frame zero after one interval and EOF after its last interval", () => {
    const playback = new TestPlayback(clip);
    expect(playback.currentFrame).toBeNull();
    expect(playback.at(0)).toEqual({ status: "playing", update: { kind: "unchanged" } });
    expect(playback.at(33).update.kind).toBe("unchanged");
    const first = frame(playback.at(1000 / 30));
    expect([first.index, first.time, first.sourceTime, first.loop, first.width, first.height]).toEqual([0, 1000 / 30, 0, 0, 8, 8]);
    expect(playback.at(34).update.kind).toBe("unchanged");
    const last = frame(playback.at(117));
    expect([last.index, last.time, last.sourceTime]).toEqual([2, 100, 2000 / 30]);
    expect(playback.at(133).status).toBe("playing");
    expect(playback.at(134)).toEqual({ status: "ended", update: { kind: "unchanged" } });
    expect(playback.at(900)).toEqual({ status: "ended", update: { kind: "unchanged" } });
    expect(playback.currentFrame?.index).toBe(2);
  });

  test("header frame rates remain metadata while explicit epochs schedule source 30 fps", () => {
    for (const rate of [10, 24, 30, 60]) {
      const playback = new TestPlayback(movie([info, book, frame0, frame1], rate), { startTime: 500 });
      expect(playback.frameRate).toBe(rate);
      expect(playback.at(500).update.kind).toBe("unchanged");
      const firstTime = 500 + 1000 / 30;
      expect(playback.at(firstTime - 0.001).update.kind).toBe("unchanged");
      expect(frame(playback.at(firstTime)).time).toBe(firstTime);
    }
  });

  test("late fullscreen ticks catch up through each frame but publish only the latest", () => {
    const playback = new TestPlayback(clip);
    playback.at(0);
    const result = playback.at(10000);
    expect(result.status).toBe("ended");
    expect(frame(result).index).toBe(2);
    expect(Array.from(frame(result).rgba.subarray(0, 4))).toEqual([129, 128, 129, 255]);
  });

  test("hold wins over loop and repeated held ticks retain the final frame", () => {
    const playback = new TestPlayback(clip, { hold: true, loop: true });
    playback.at(0);
    const result = playback.at(10000);
    expect(result.status).toBe("held");
    expect(frame(result).index).toBe(2);
    expect(playback.at(20000)).toEqual({ status: "held", update: { kind: "unchanged" } });
    expect(playback.currentFrame?.loop).toBe(0);
  });

  test("loop EOF rebases to the observed clock and retains the last image until the next frame", () => {
    const playback = new TestPlayback(clip, { loop: true });
    playback.at(0);
    const result = playback.at(10000);
    expect(result.status).toBe("playing");
    expect(frame(result).loop).toBe(0);
    playback.at(10000); // The next source call reads the new loop's initial INFO.
    expect(playback.at(10033).update.kind).toBe("unchanged");
    expect(playback.currentFrame?.index).toBe(2);
    const next = frame(playback.at(10034));
    expect([next.loop, next.index, next.sourceTime, next.time]).toEqual([1, 0, 0, 10000 + 1000 / 30]);
  });

  test("shader gaps greater than 100 ms freeze elapsed time; exactly 100 ms advances", () => {
    const playback = new TestPlayback(clip, { shader: true });
    playback.at(0);
    expect(frame(playback.at(34)).index).toBe(0);
    expect(playback.at(135).update.kind).toBe("unchanged");
    const second = frame(playback.at(168));
    expect([second.index, second.time]).toEqual([1, 101 + 2000 / 30]);
    expect(playback.at(5000).update.kind).toBe("unchanged");
    expect(frame(playback.at(5100)).index).toBe(2);
  });

  test("PCM timestamps count sample frames across all chunks in one source run", () => {
    const data = movie([info, book, chunk(0x1021, [1, 2, 3, 4]), chunk(0x1020, [5, 6]), frame0,
      chunk(0x1021, [7, 8]), frame1]);
    const playback = new TestPlayback(data, { startTime: 1000 });
    playback.at(1000);
    const result = playback.at(1300);
    expect(result.status).toBe("ended");
    expect(frame(result).index).toBe(1);
    const first = playback.drainAudio();
    expect(first.map(event => [event.channels, event.sourceSample, event.sourceTime, event.time])).toEqual([
      [2, 0, 0, 1000], [1, 2, 2 * 1000 / 22050, 1000 + 2 * 1000 / 22050],
      [2, 4, 4 * 1000 / 22050, 1000 + 4 * 1000 / 22050],
    ]);
    expect(first.map(event => Array.from(event.samples))).toEqual([[1, 4, 10, 20], [25, 25], [49, 64]]);
    expect(playback.drainAudio()).toEqual([]);
  });

  test("looped PCM restarts source sample offsets and records its new clock epoch", () => {
    const playback = new TestPlayback(movie([info, book, chunk(0x1020, [1, 2]), frame0]), { loop: true });
    playback.at(0);
    playback.at(200);
    expect(playback.drainAudio().map(event => [event.loop, event.sourceSample, event.time])).toEqual([[0, 0, 0]]);
    playback.at(200);
    playback.at(300);
    expect(playback.drainAudio().map(event => [event.loop, event.sourceSample, event.time])).toEqual([[1, 0, 200]]);
  });

  test("silent playback does not deliver PCM", () => {
    const playback = new TestPlayback(movie([info, book, chunk(0x1020, [1]), chunk(0x1020, [2]), frame0]),
      { silent: true });
    playback.at(0);
    expect(playback.at(200).status).toBe("ended");
    expect(playback.drainAudio()).toEqual([]);
  });

  test("silent playback skips odd stereo payloads before and after INFO across reset", () => {
    const malformedStereo = chunk(0x1021, [1]);
    const data = movie([malformedStereo, info, book, malformedStereo, frame0, frame1]);
    let resets = 0;
    const playback = new TestPlayback(data, {
      silent: true, beforeRawStreamReset: () => { resets++; },
    });
    for (const epoch of [0, 200]) {
      if (epoch !== 0) playback.resetAt(epoch);
      expect(playback.at(epoch).update.kind).toBe("unchanged");
      expect(playback.dimensions).toEqual({ width: 8, height: 8 });
      const first = frame(playback.at(epoch + 34));
      expect([first.index, first.sourceTime, first.time]).toEqual([0, 0, epoch + 1000 / 30]);
      expect(Array.from(first.rgba.subarray(0, 4))).toEqual([1, 0, 1, 255]);
      expect(frame(playback.at(epoch + 67)).index).toBe(1);
      expect(playback.at(epoch + 100).status).toBe("ended");
      expect(playback.drainAudio()).toEqual([]);
    }
    expect(resets).toBe(0);
    const audible = new TestPlayback(data, { beforeRawStreamReset: () => { resets++; } });
    expect(() => audible.at(0)).toThrow("incomplete stereo sample pair");
    expect(resets).toBe(1);
  });

  test("owned input survives Buffer mutations and published frame mutations cannot alter current state", () => {
    const input = Buffer.from(clip);
    const playback = new TestPlayback(input, { loop: true });
    input.fill(0);
    playback.at(0);
    const first = frame(playback.at(34));
    first.rgba.fill(17);
    const current = playback.currentFrame;
    if (current === null) throw new Error("Missing current frame");
    expect(Array.from(current.rgba.subarray(0, 4))).toEqual([1, 0, 1, 255]);
    current.rgba.fill(18);
    expect(playback.currentFrame?.rgba[0]).toBe(1);
    playback.at(400);
    playback.at(400);
    expect(frame(playback.at(434)).index).toBe(0);
  });

  test("explicit reset clears frame, loops and deadlines after already delivering audio", () => {
    const playback = new TestPlayback(movie([info, book, chunk(0x1020, [1]), frame0]));
    playback.at(0);
    playback.at(100);
    expect(playback.drainAudio().length).toBe(1);
    playback.resetAt(0);
    expect(playback.currentFrame).toBeNull();
    expect(playback.drainAudio()).toEqual([]);
    expect(playback.at(0).status).toBe("playing");
    expect(frame(playback.at(100)).index).toBe(0);
  });

  test("invalid clocks, malformed inputs and empty loops terminate explicitly", () => {
    for (const time of [-1, Infinity, NaN]) {
      expect(() => new TestPlayback(clip, { startTime: time })).toThrow(RangeError);
      expect(() => new TestPlayback(clip).at(time)).toThrow(RangeError);
      expect(() => new TestPlayback(clip).resetAt(time)).toThrow(RangeError);
    }
    expect(() => new TestPlayback(new Uint8Array(0))).toThrow();
    const truncated = new TestPlayback(clip.subarray(0, -1));
    truncated.at(0);
    expect(() => truncated.at(10000)).toThrow();
    expect(new TestPlayback(movie([]), { loop: true }).at(100).status).toBe("playing");
  });
});

const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
test.skipIf(!existsSync(join(retailRoot, "missionpack/pak0.pk3")))("retail retained shader video advances on its clock and matches direct decoder frames", async () => {
  const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product: "missionpack" });
  const shader = new TextDecoder().decode(await vfs.read("scripts/proto2.shader"));
  expect(shader).toMatch(/videoMap\s+mpteam1\.roq/i);
  const data = await vfs.read("video/mpteam1.roq");
  const reference = new RoqDecoder(data);
  const scratch = new RoqDecoderScratch(), stream = RoqStream.open(() => vfs, "video/mpteam1.roq", scratch.file);
  if (stream === undefined) throw new Error("Retail RoQ file was not opened");
  const playback = new TestPlayback(stream, { shader: true, silent: true, loop: true, scratch });
  playback.at(0);
  expect(playback.frameRate).toBe(30);
  for (let index = 0; index < 6; index++) {
    const direct = reference.next();
    if (direct.kind !== "frame") throw new Error("Expected silent retail video frame");
    const published = frame(playback.at((index + 1) * 1000 / 30 + 0.001));
    expect(published.index).toBe(index);
    expect(Bun.hash(published.rgba)).toBe(Bun.hash(direct.rgba));
  }
  expect(playback.at(1000).update.kind).toBe("unchanged");
  expect(playback.currentFrame?.index).toBe(5);
  stream.close(); vfs.close();
});

test.skipIf(!existsSync(join(retailRoot, "missionpack/pak0.pk3")))("retail retained timescale freeze retains source frame 591, then primes the next loop", async () => {
  const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product: "missionpack" });
  const scratch = new RoqDecoderScratch(), stream = RoqStream.open(() => vfs, "video/mpteam1.roq", scratch.file);
  if (stream === undefined) throw new Error("Retail RoQ file was not opened");
  const playback = new TestPlayback(stream, { shader: true, silent: true, loop: true, scratch });
  playback.at(1000);
  expect(frame(playback.at(1034)).index).toBe(0);
  const frozen = frame(playback.at(0));
  expect(frozen.index).toBe(591);
  // Unchanged native source compiled with SSE2 byte copies. The x87 build quiets two NaN-shaped pairs.
  expect(Bun.CryptoHasher.hash("sha256", frozen.rgba, "hex")).toBe("c27ca6ed725687883c6499b5dbf6fa7efcccb761897a12f32819152162e245e1");
  expect(playback.at(0).update.kind).toBe("unchanged");
  expect(playback.currentFrame?.index).toBe(591);
  const restarted = frame(playback.at(34));
  expect([restarted.index, restarted.loop]).toEqual([0, 1]);
  stream.close(); vfs.close();
});
