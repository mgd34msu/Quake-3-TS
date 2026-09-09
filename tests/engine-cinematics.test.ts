import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceFileHandles } from "../src/assets/file-handles.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import type { AssetReader } from "../src/assets/reader.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { BinaryError, BinaryWriter } from "../src/core/binary.ts";
import { CommonError } from "../src/core/common-error.ts";
import { ConsoleOutput } from "../src/core/console-output.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { RoqPlayback } from "../src/cinematic/playback.ts";
import { RoqDecoderScratch } from "../src/cinematic/roq.ts";
import { RoqStream } from "../src/cinematic/roq-stream.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { EngineSound } from "../src/engine/sound.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { CinematicStatus, EngineCinematics, type EngineCinematicHandle, type NonSystemCinematicOptions, type SystemCinematicHost } from "../src/engine/cinematics.ts";
import type { EngineCinematicOptions } from "../src/engine/cinematics.ts";
import { EngineUiCinematics } from "../src/engine/ui-cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";

const rect = { x: 0, y: 0, width: 640, height: 480 };
const normal: NonSystemCinematicOptions = { looping: false, holdAtEnd: false, silent: false, shader: false };
function chunk(id: number, payload: readonly number[], flags = 0): Uint8Array {
  const out = new BinaryWriter(payload.length + 8);
  out.u16(id); out.u32(payload.length); out.u16(flags); out.bytes(Uint8Array.from(payload));
  return out.finish();
}
function header(id: number, size: number): Uint8Array {
  const out = new BinaryWriter(8); out.u16(id); out.u32(size); out.u16(0); return out.finish();
}
function stream(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new BinaryWriter(8 + chunks.reduce((sum, value) => sum + value.length, 0));
  out.u16(0x1084); out.u32(0xffffffff); out.u16(30);
  for (const value of chunks) out.bytes(value);
  return out.finish();
}
function movie(width = 16, height = 16, value = 255, audio: readonly Uint8Array[] = []): Uint8Array {
  const codes: number[] = [], blocks = width * height / 64;
  for (let index = 0; index < blocks; index += 8) {
    const count = Math.min(8, blocks - index);
    let bits = 0; for (let n = 0; n < count; n++) bits |= 2 << (14 - n * 2);
    codes.push(bits & 255, bits >>> 8, ...new Array<number>(count).fill(0));
  }
  return stream([...audio, chunk(0x1001, [width & 255, width >>> 8, height & 255, height >>> 8, 8, 0, 4, 0]),
    chunk(0x1002, [value, value, value, value, 128, 128, 0, 0, 0, 0], 0x0101), chunk(0x1011, codes), chunk(0x1013, [])]);
}
function fixture(data = movie(), maxTextureSize = 4096, customFiles?: AssetReader, sampleRate = 22050, profile?: EngineCinematicOptions["files"], print?: (text: string) => undefined,
  developerPrint?: (text: string) => undefined) {
  const clock = { time: 0, reads: 0, sample(): number { this.reads++; return this.time; } };
  const mixer = new AudioMixer(sampleRate, () => 0), images = new RendererImageCatalog(), builtins = new BuiltinImages(images, identityImageUploadProfile);
  const effects: string[] = [], diagnostics: string[] = [], settings = { enabled: 1, hardware: "generic", maxTextureSize } satisfies { enabled: number; hardware: "generic"; maxTextureSize: number };
  const files: AssetReader = customFiles ?? { has: path => path !== "video/missing", list: () => [], read: async () => data };
  const owner = new EngineCinematics({ files: profile ?? { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock, scratchImages: builtins,
    temporaryMemory: new HunkArena(1024 * 1024, () => undefined),
    print: print ?? (text => { effects.push(text); }),
    developerPrint: developerPrint ?? (text => { diagnostics.push(text); }),
    console: { kind: "available", close: () => { effects.push("console"); } },
    settings: { hardware: settings.hardware, maxTextureSize, inGameVideo: () => settings.enabled } });
  return { owner, clock, mixer, builtins, effects, diagnostics, settings };
}
async function playing(f: ReturnType<typeof fixture>, name = "a", flags = normal) {
  const asset = await f.owner.prepare(name), handle = f.owner.playNonSystem(asset, rect, flags);
  if (handle === undefined) throw new Error("Fixture movie did not open");
  f.owner.run(handle); f.clock.time += 34; f.owner.run(handle);
  return { asset, handle };
}

async function retainedFixture(data = movie()) {
  const directory = await mkdtemp(join(tmpdir(), "q3-roq-stream-"));
  const video = join(directory, "baseq3", "video"), path = join(video, "a.roq");
  await mkdir(video, { recursive: true });
  await writeFile(path, data);
  const handles = new SourceFileHandles();
  const vfs = await VirtualFileSystem.openTracked({ dataPath: directory, homePath: directory, cdPath: null, product: "baseq3",
    handles, references: { checksumFeed: 0, random: () => 0 } });
  const f = fixture(data, 4096, undefined, 22050, { kind: "retained", current: () => vfs });
  return { ...f, handles, path, vfs, async close(): Promise<void> {
    f.owner.dispose(); vfs.close(); handles.close(); await rm(directory, { recursive: true, force: true });
  } };
}

test("retained pre-INFO stereo uses actual engine sound before reset and decode", async () => {
  if (process.env["QUAKE_CINEMATIC_SOUND_CHILD"] !== "1") {
    const child = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url), "-t", "retained pre-INFO stereo uses actual"], {
      env: { ...process.env, SDL_AUDIODRIVER: "dummy", SDL_AUDIO_FREQUENCY: "48000", QUAKE_CINEMATIC_SOUND_CHILD: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Cinematic sound child failed (${code})\n${stdout}${stderr}`);
    expect(code).toBe(0);
    return;
  }
  const homePath = await mkdtemp(join(tmpdir(), "q3-cinematic-sound-"));
  const video = join(homePath, "baseq3", "video");
  await mkdir(video, { recursive: true });
  const common = await CommonConsole.open({
    roots: { dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath, cdPath: null, product: "baseq3" },
    startup: new StartupCommands(""), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
    platformPrint: () => {}, resolveCommand: () => undefined, assertCommandEntry: () => {}, assertOwnerEntry: () => {},
  }, () => {});
  const events = new CommonEvents({ getEvent: () => ({ kind: "none", time: 0 }) }, () => undefined);
  common.registerRuntimeCvars("cinematic-sound-fixture", async () => undefined);
  const sound = new EngineSound(common, events);
  try {
    sound.initialize({ sampleRate: 48000, bufferFrames: 256 });
    common.sound.pause();
    await sound.beginRegistration();
    const mixer = sound.mixer;
    if (mixer === null) throw new Error("Missing actual cinematic sound output");
    const soundTime = common.sound.deliveryTime;
    const updates: number[] = [], update = sound.update.bind(sound);
    sound.update = () => { updates.push(mixer.rawEnd); update(); };
    const stereo = chunk(0x1021, [1, 2]), mono = chunk(0x1020, [1], 1000);
    const scenarios = [
      { name: "overflow-before-info", bytes: movie(16, 16, 255, [chunk(0x1020, new Array<number>(15000).fill(0), 1000)]), silent: false },
      { name: "valid", bytes: movie(16, 16, 255, [mono, stereo, stereo]), silent: false },
      { name: "invalid-lookahead", bytes: stream([mono, stereo, header(0x1013, 65537)]), silent: false },
      { name: "malformed-stereo", bytes: movie(16, 16, 255, [mono, chunk(0x1021, [1])]), silent: false },
      { name: "silent", bytes: movie(16, 16, 255, [mono, stereo]), silent: true },
      { name: "post-info", bytes: stream([chunk(0x1001, [16, 0, 16, 0, 8, 0, 4, 0]), stereo, chunk(0x1013, [])]), silent: false },
    ];
    for (const scenario of scenarios) {
      await writeFile(join(video, `${scenario.name}.roq`), scenario.bytes);
      updates.length = 0;
      const clock = { time: 0, sample(): number { return this.time; } };
      const owner = new EngineCinematics({ files: { kind: "retained", current: () => common.files.current }, sound: { kind: "engine", owner: sound },
        temporaryMemory: common.hunk.accounting.arena,
        print: text => { common.output.print(text); },
        developerPrint: text => {
          const developer = common.cvars.get("developer");
          if (developer === undefined) throw new Error("Missing common developer cvar");
          if (developer.integerValue !== 0) common.output.print(text);
        },
        clock, scratchImages: new BuiltinImages(new RendererImageCatalog(), identityImageUploadProfile), console: { kind: "absent" },
        settings: { hardware: "generic", maxTextureSize: 4096, inGameVideo: () => 1 } });
      try {
        const handle = owner.playNonSystem(await owner.prepare(`${scenario.name}.roq`), rect, { ...normal, silent: scenario.silent });
        if (handle === undefined) throw new Error("Missing retained cinematic sound fixture");
        mixer.selectTime(soundTime, soundTime + 100);
        if (scenario.name === "malformed-stereo") {
          expect(() => owner.run(handle)).toThrow("incomplete stereo sample pair");
          expect(updates).toEqual([soundTime + 3]);
          expect(mixer.soundClock).toBe(soundTime); expect(mixer.rawEnd).toBe(soundTime);
        } else {
          const status = owner.run(handle);
          if (scenario.name === "overflow-before-info") {
            expect(mixer.rawEnd - soundTime).toBeGreaterThan(mixer.rawCapacity);
            expect(updates).toEqual([]);
            clock.time = 34; owner.run(handle);
            expect(owner.prepareUiRaw(handle)).not.toBeNull();
            sound.update();
            expect(common.sound.queuedFrames).toBeGreaterThan(0);
            expect(common.sound.pendingOutput.samples.some(sample => sample === 1000)).toBe(true);
          } else if (scenario.name === "silent" || scenario.name === "post-info") {
            clock.time = 34; owner.run(handle);
            expect(updates).toEqual([]);
          } else {
            expect(updates).toEqual(scenario.name === "valid" ? [soundTime + 3, soundTime + 3] : [soundTime + 3]);
            expect(mixer.soundClock).toBe(soundTime); expect(mixer.rawEnd).toBe(soundTime + 3);
            expect(Array.from(mixer.mix({ startFrame: soundTime, endFrame: soundTime + 1 }))).toEqual([1, 4]);
            expect(common.sound.queuedFrames).toBeGreaterThan(0);
            if (scenario.name === "invalid-lookahead") expect(status).toBe(CinematicStatus.Eof);
          }
        }
      } finally { owner.dispose(); }
    }
  } finally {
    try { sound.close(); } finally { common.close(); await rm(homePath, { recursive: true, force: true }); }
  }
}, 15000);

describe("retained cinematic files", () => {
  test("leading audio retains the complete final payload and lookahead until the source EOF counter catches up", async () => {
    const bytes = new Uint8Array([...movie(16, 16, 255, [chunk(0x1020, new Array<number>(40).fill(0))]).subarray(0, -8),
      ...chunk(0x1011, [0, 170, 0, 0, 0, 0])]);
    const f = await retainedFixture(bytes);
    try {
      const handle = f.owner.playNonSystem(await f.owner.prepare("a.roq"), rect, { ...normal, silent: true, holdAtEnd: true });
      if (handle === undefined) throw new Error("Missing retained EOF movie");
      f.owner.run(handle);
      // RoQPlayed starts at 24 despite the 40-byte first payload. The two real
      // 6-byte frames are followed by two retained dispatches before held EOF.
      const steps: readonly (readonly [number, number])[] = [[34, 112], [67, 126], [100, 140], [134, 154]];
      for (const [time, reads] of steps) {
        f.clock.time = time;
        expect(f.owner.run(handle)).toBe(CinematicStatus.Playing);
        expect(f.handles.readCount).toBe(reads);
        expect(f.owner.prepareUiRaw(handle)?.captureAfterBarrier().upload.content.copyPixels()[0]).toBe(255);
      }
      f.clock.time = 167;
      expect(f.owner.run(handle)).toBe(CinematicStatus.Idle);
      expect(f.handles.readCount).toBe(168);
    } finally { await f.close(); }
  });

  test("leading audio rejects partial reads but reuses retained bytes after a zero-byte EOF read", async () => {
    const bytes = new Uint8Array([...movie(16, 16, 255, [chunk(0x1020, new Array<number>(40).fill(0))]).subarray(0, -8),
      ...chunk(0x1011, [0, 170, 0, 0, 0, 0])]);
    const inputs = [...Array.from({ length: 6 }, (_, index) => bytes.subarray(0, -index - 1)),
      ...Array.from({ length: 7 }, (_, index) => new Uint8Array([...bytes, ...header(0x1013, 0).subarray(0, index + 1)]))];
    for (const data of inputs) {
      const f = await retainedFixture(data);
      try {
        const handle = f.owner.playNonSystem(await f.owner.prepare("a.roq"), rect, { ...normal, silent: true });
        if (handle === undefined) throw new Error("Missing malformed EOF movie");
        f.owner.run(handle); f.clock.time = 34; f.owner.run(handle); f.clock.time = 67;
        if (data.length === bytes.length - 6) {
          // At 34 the complete six-byte frame and next header filled cin.file through EOF.
          // Zero reads at 67 and 100 retain those bytes while RoQPlayed advances 86 -> 100 -> 114.
          for (const [time, reads] of [[67, 126], [100, 140]] satisfies readonly [number, number][]) {
            f.clock.time = time;
            expect(f.owner.run(handle)).toBe(CinematicStatus.Playing);
            expect(f.handles.readCount).toBe(reads);
            expect(f.owner.prepareUiRaw(handle)?.captureAfterBarrier().upload.content.copyPixels()[0]).toBe(255);
          }
          f.clock.time = 134;
          expect(f.owner.run(handle)).toBe(CinematicStatus.Idle);
          expect(f.handles.readCount).toBe(154); // The read still precedes the 114 >= 112 EOF guard.
        } else expect(() => f.owner.run(handle)).toThrow("truncated RoQ payload or lookahead header");
      } finally { await f.close(); }
    }
  });

  test("unknown retained cinematic chunks use source EOF and loop dispatch", async () => {
    const bytes = new Uint8Array([...movie().subarray(0, -8), ...chunk(0x7777, [1]), ...chunk(0x1013, [])]);
    for (const looping of [false, true]) {
      const f = await retainedFixture(bytes);
      try {
        const handle = f.owner.playNonSystem(await f.owner.prepare("a.roq"), rect, { ...normal, looping, holdAtEnd: true });
        if (handle === undefined) throw new Error("Missing unknown-chunk movie");
        f.owner.run(handle); f.clock.time = 34; f.owner.run(handle); f.clock.time = 67;
        expect(f.owner.run(handle)).toBe(looping ? CinematicStatus.Looped : CinematicStatus.Idle);
        expect(f.handles.selectFree().slot).toBe(looping ? 2 : 1);
        if (looping) {
          expect(f.handles.readCount).toBe(89);
          expect(f.owner.run(handle)).toBe(CinematicStatus.Playing);
          expect(f.handles.readCount).toBe(89);
          f.clock.time = 101; f.owner.run(handle);
          expect(f.handles.readCount).toBe(105);
          f.clock.time = 135; f.owner.run(handle);
          expect(f.handles.readCount).toBe(137);
          expect(f.owner.prepareUiRaw(handle)?.captureAfterBarrier().upload.content.copyPixels()[0]).toBe(255);
        }
      } finally { await f.close(); }
    }
  });

  test("new movies clear retained file bytes while keeping source EOF timing independent of the previous movie", async () => {
    const info = chunk(0x1001, [8, 0, 8, 0, 8, 0, 4, 0]);
    const poison = new Uint8Array(120);
    poison.set(header(0x1084, 0), 64);
    const warm = stream([info, chunk(0x1012, Array.from(poison)), chunk(0x1011, [0, 0]), chunk(0x1013, [])]);
    const target = stream([chunk(0x1020, new Array<number>(40).fill(0)), info, chunk(0x1011, new Array<number>(64).fill(0))]);
    for (const warmed of [false, true]) {
      const f = await retainedFixture(warm);
      try {
        if (warmed) {
          const warmHandle = f.owner.playNonSystem(await f.owner.prepare("a.roq"), rect, { ...normal, silent: true });
          if (warmHandle === undefined) throw new Error("Missing warm movie");
          f.owner.run(warmHandle); f.clock.time = 34; f.owner.run(warmHandle);
          f.owner.stop(warmHandle);
        }
        await writeFile(f.path.replace("a.roq", "b.roq"), target);
        const handle = f.owner.playNonSystem(await f.owner.prepare("b.roq"), rect, { ...normal, silent: true, holdAtEnd: true });
        if (handle === undefined) throw new Error("Missing target movie");
        f.owner.run(handle); f.clock.time += 34;
        expect(f.owner.run(handle)).toBe(CinematicStatus.Playing);
        expect(f.owner.prepareUiRaw(handle)).not.toBeNull();
        f.clock.time += 34;
        expect(f.owner.run(handle)).toBe(CinematicStatus.Idle);
      } finally { await f.close(); }
    }
  });

  test("prepare is inert, play reads 16 bytes, interrupts pull chunks, and loop reopens the actual pathname", async () => {
    const f = await retainedFixture();
    try {
      const asset = await f.owner.prepare("a.roq");
      expect(f.handles.readCount).toBe(0); expect(f.handles.selectFree().slot).toBe(1);
      const handle = f.owner.playNonSystem(asset, rect, { ...normal, looping: true });
      if (handle === undefined) throw new Error("Missing retained movie");
      expect(f.handles.readCount).toBe(16); expect(f.handles.selectFree().slot).toBe(2);
      await writeFile(`${f.path}.replacement`, movie(16, 16, 0));
      await rename(`${f.path}.replacement`, f.path);
      f.owner.run(handle); expect(f.handles.readCount).toBe(32);
      f.clock.time = 34; f.owner.run(handle);
      expect(f.handles.readCount).toBe(64);
      expect(f.owner.prepareUiRaw(handle)?.captureAfterBarrier().upload.content.copyPixels()[0]).toBe(255);
      f.clock.time = 68; f.owner.run(handle);
      expect(f.handles.readCount).toBe(88);
      f.owner.run(handle); f.clock.time = 102; f.owner.run(handle);
      expect(Array.from(f.owner.prepareUiRaw(handle)?.captureAfterBarrier().upload.content.copyPixels().subarray(0, 4) ?? [])).toEqual([1, 0, 1, 255]);
      f.owner.stop(handle); expect(f.handles.selectFree().slot).toBe(1);
    } finally { await f.close(); }
  });

  test("system opens before awaiting its menu and final retirement leaves the unread file to common", async () => {
    const f = await retainedFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    try {
      const system = f.owner.attachSystem({ state: () => "other", closeMenu: async () => { entered.resolve(); await release.promise; },
        enterCinematic: () => undefined, enterDisconnected: () => undefined, nextMap: () => "", clearNextMap: () => undefined,
        appendCommand: () => undefined, stopAllSounds: () => undefined });
      const pending = system.play("a.roq");
      await entered.promise;
      expect(f.handles.readCount).toBe(0); expect(f.handles.selectFree().slot).toBe(2);
      f.owner.dispose(); expect(f.handles.selectFree().slot).toBe(2);
      release.resolve(); await expect(pending).rejects.toThrow("disposed");
      expect(f.handles.readCount).toBe(0);
    } finally { release.resolve(); await f.close(); }
  });

  test("retained reset before awaited menu completion reopens synchronously and resumed play reads its live position", async () => {
    const data = movie(), nested = new Uint8Array(data.length + 16);
    nested.set(data.subarray(0, 16)); nested.set(data, 16);
    const f = await retainedFixture(nested), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    try {
      await writeFile(f.path.replace("a.roq", "b.roq"), data);
      f.owner.attachSystem({ state: () => "other", closeMenu: async () => {
        f.effects.push("menu-begin"); entered.resolve(); await release.promise; f.effects.push("menu-end");
      }, enterCinematic: () => { f.effects.push("cinematic"); }, enterDisconnected: () => { f.effects.push("disconnected"); },
      nextMap: () => "", clearNextMap: () => undefined, appendCommand: () => undefined, stopAllSounds: () => undefined });
      const asset = await f.owner.prepare("a.roq"), pending = f.owner.play(asset, rect, 1);
      expect(pending).toBeInstanceOf(Promise);
      await entered.promise;
      const a = f.owner.handleAtSlot(0);
      if (a === undefined) throw new Error("Missing pending system cell");
      expect(f.handles.readCount).toBe(0);
      const b = f.owner.playNonSystem(await f.owner.prepare("b.roq"), rect, normal);
      expect(b?.index).toBe(1);
      expect(f.handles.readCount).toBe(16);
      const clocks = f.clock.reads;
      expect(f.owner.run(a)).toBe(CinematicStatus.Looped);
      expect(f.clock.reads - clocks).toBe(1);
      expect(f.handles.readCount).toBe(32);
      expect(f.owner.prepareUiRaw(a)).toBeNull();
      expect(f.effects).toEqual(["menu-begin", "console"]);
      release.resolve();
      expect(await pending).toBe(a);
      expect(f.handles.readCount).toBe(48);
      expect(f.clock.reads - clocks).toBe(2);
      expect(f.effects).toEqual(["menu-begin", "console", "menu-end", "cinematic", "console"]);
    } finally { release.resolve(); await f.close(); }
  });

  test("retained reset initializes a rejected first-play header and decodes actual chunks without rechecking its magic", async () => {
    const data = movie(); data.fill(0, 0, 6);
    const f = await retainedFixture(data);
    try {
      await writeFile(f.path.replace("a.roq", "b.roq"), movie());
      const asset = await f.owner.prepare("a.roq");
      expect(f.owner.playNonSystem(asset, rect, normal)).toBeUndefined();
      const a = f.owner.handleAtSlot(0);
      if (a === undefined) throw new Error("Missing rejected cinematic cell");
      expect(f.owner.playNonSystem(await f.owner.prepare("b.roq"), rect, normal)?.index).toBe(1);
      const clocks = f.clock.reads, reads = f.handles.readCount;
      expect(f.owner.run(a)).toBe(CinematicStatus.Playing);
      expect(f.clock.reads - clocks).toBe(3);
      expect(f.handles.readCount - reads).toBe(16);
      expect(f.owner.prepareUiRaw(a)).toBeNull();
      expect(f.owner.run(a)).toBe(CinematicStatus.Playing);
      f.clock.time = 34;
      expect(f.owner.run(a)).toBe(CinematicStatus.Playing);
      expect(f.owner.prepareUiRaw(a)?.captureAfterBarrier().upload.content.copyPixels()[0]).toBe(255);
      expect(f.effects).toEqual(["console"]);
    } finally { await f.close(); }
  });

  test("retained reset of a reused cell selects its new acquisition while menu closure is pending", async () => {
    const f = await retainedFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    try {
      await writeFile(f.path.replace("a.roq", "b.roq"), movie());
      const a = await playing(f, "a.roq"), b = await playing(f, "b.roq");
      f.owner.stop(a.handle);
      f.owner.attachSystem({ state: () => "other", closeMenu: async () => { entered.resolve(); await release.promise; },
        enterCinematic: () => undefined, enterDisconnected: () => undefined, nextMap: () => "",
        clearNextMap: () => undefined, appendCommand: () => undefined, stopAllSounds: () => undefined });
      const pending = f.owner.play(a.asset, rect, 1);
      await entered.promise;
      f.owner.run(b.handle);
      const reads = f.handles.readCount;
      expect(f.owner.run(a.handle)).toBe(CinematicStatus.Looped);
      expect(f.handles.readCount - reads).toBe(16);
      f.owner.dispose();
      release.resolve();
      await expect(Promise.resolve(pending)).rejects.toThrow("disposed");
    } finally { release.resolve(); await f.close(); }
  });

  test("retained reset preserves short-read header residue and keeps the original file length", async () => {
    const f = await retainedFixture(), scratch = new RoqDecoderScratch();
    try {
      const stream = RoqStream.open(() => f.vfs, "video/a.roq", scratch.file);
      if (stream === undefined) throw new Error("Missing reset stream");
      stream.initialize();
      scratch.file[6] = 77;
      await writeFile(f.path, new Uint8Array([0, 0]));
      const playback = RoqPlayback.fromReset(stream, { clock: f.clock, scratch, silent: true, onAudio: () => undefined, developerPrint: text => { f.diagnostics.push(text); } });
      expect(playback.frameRate).toBe(77);
      expect(Array.from(scratch.file.subarray(0, 16))).toEqual([0, 0, 255, 255, 255, 255, 77, 0, 1, 16, 8, 0, 0, 0, 0, 0]);
      expect(playback.run(f.clock).status).toBe("playing");
      // The original length still exceeds RoQPlayed=24; the short replacement
      // cannot turn the next incomplete payload into a successful EOF.
      expect(() => playback.run(f.clock)).toThrow("truncated RoQ payload or lookahead header");
      stream.close();
    } finally { await f.close(); }
  });

  test("retained reset permits source header sizes until the next read reaches the scratch bound", async () => {
    const f = await retainedFixture(), scratch = new RoqDecoderScratch();
    try {
      const stream = RoqStream.open(() => f.vfs, "video/a.roq", scratch.file);
      if (stream === undefined) throw new Error("Missing reset stream");
      const data = movie(); data.set([1, 0, 1], 10);
      await writeFile(f.path, data);
      const playback = RoqPlayback.fromReset(stream, { clock: f.clock, scratch, silent: true, onAudio: () => undefined, developerPrint: text => { f.diagnostics.push(text); } });
      expect(playback.run(f.clock).status).toBe("playing");
      expect(() => playback.run(f.clock)).toThrow("RoQ chunk exceeds source scratch buffer");
      stream.close();
    } finally { await f.close(); }
  });

  test("retained reset of a removed path keeps the shared header and can reopen on the next reset", async () => {
    const f = await retainedFixture(), scratch = new RoqDecoderScratch();
    try {
      const stream = RoqStream.open(() => f.vfs, "video/a.roq", scratch.file);
      if (stream === undefined) throw new Error("Missing reset stream");
      stream.initialize();
      const retained = scratch.file.slice(0, 16), reads = f.handles.readCount;
      await rename(f.path, `${f.path}.saved`);
      const playback = RoqPlayback.fromReset(stream, { clock: f.clock, scratch, silent: true, onAudio: () => undefined, developerPrint: text => { f.diagnostics.push(text); } });
      expect(scratch.file.slice(0, 16)).toEqual(retained);
      expect(f.handles.readCount).toBe(reads);
      expect(f.handles.selectFree().slot).toBe(1);
      expect(playback.run(f.clock).status).toBe("playing");
      await rename(`${f.path}.saved`, f.path);
      playback.restart(f.clock);
      expect(f.handles.readCount).toBe(reads + 16);
      playback.run(f.clock); playback.run(f.clock);
      f.clock.time = 34;
      const result = playback.run(f.clock);
      expect(result.update.kind).toBe("frame");
      if (result.update.kind === "frame") expect(result.update.frame.rgba[0]).toBe(255);
      stream.close();
    } finally { await f.close(); }
  });

  test("menu source abort retains the unread cinematic acquisition until common disposal", async () => {
    const f = await retainedFixture(), abort = new CommonError("drop", "menu aborted");
    try {
      f.owner.attachSystem({ state: () => "other", closeMenu: async () => { throw abort; },
        enterCinematic: () => { f.effects.push("cinematic"); }, enterDisconnected: () => { f.effects.push("disconnected"); },
        nextMap: () => "", clearNextMap: () => undefined, appendCommand: () => undefined, stopAllSounds: () => undefined });
      const asset = await f.owner.prepare("a.roq");
      await expect(Promise.resolve(f.owner.play(asset, rect, 1))).rejects.toBe(abort);
      expect(f.handles.readCount).toBe(0);
      expect(f.handles.selectFree().slot).toBe(2);
      expect(f.owner.playNonSystem(asset, rect, normal)?.index).toBe(0);
      expect(f.effects).toEqual([]);
      f.owner.dispose();
      expect(f.handles.selectFree().slot).toBe(2);
      expect(f.effects).toEqual([]);
    } finally { await f.close(); }
  });

  test("truncated headers fail at play and source no-frame slots retain their file for common closure", async () => {
    const f = await retainedFixture(movie().subarray(0, 12));
    try {
      const asset = await f.owner.prepare("a.roq");
      expect(f.handles.readCount).toBe(0);
      expect(f.owner.playNonSystem(asset, rect, normal)).toBeUndefined();
      expect(f.handles.readCount).toBe(16); expect(f.handles.selectFree().slot).toBe(2);
      f.owner.dispose(); expect(f.handles.selectFree().slot).toBe(2);
    } finally { await f.close(); }
  });

  test("switching to a stopped slot cannot reopen its former movie pathname", async () => {
    const f = await retainedFixture();
    try {
      await writeFile(f.path.replace("a.roq", "b.roq"), movie());
      const a = await playing(f, "a.roq"), b = await playing(f, "b.roq");
      expect(a.handle.index).not.toBe(b.handle.index);
      f.owner.stop(a.handle);
      const reads = f.handles.readCount;
      expect(() => f.owner.run(a.handle)).toThrow("closed RoQ file");
      expect(f.handles.readCount).toBe(reads);
    } finally { await f.close(); }
  });

  test("valid mono reaches the mixer before invalid lookahead EOF or loop, which ignores hold", async () => {
    for (const trailer of [header(0x1013, 65537), header(0x1084, 0)]) for (const looping of [false, true]) {
      const f = await retainedFixture(stream([chunk(0x1020, [1, 2]), trailer]));
      try {
        const observed: { reads: number; rawEnd: number }[] = [];
        f.clock.sample = () => { observed.push({ reads: f.handles.readCount, rawEnd: f.mixer.rawEnd }); return 0; };
        const handle = f.owner.playNonSystem(await f.owner.prepare("a.roq"), rect, { ...normal, looping, holdAtEnd: true });
        if (handle === undefined) throw new Error("Missing retained audio");
        expect(f.owner.run(handle)).toBe(looping ? CinematicStatus.Playing : CinematicStatus.Eof);
        expect(f.mixer.rawEnd).toBe(2); expect(Array.from(f.mixer.mix(2))).toEqual([1, 1, 1, 1]);
        expect(f.handles.readCount).toBe(looping ? 42 : 26);
        if (looping) expect(observed).toContainEqual({ reads: 42, rawEnd: 2 });
      } finally { await f.close(); }
    }
  });

  test("invalid lookahead ends or loops in the same interrupt that publishes the target frame", async () => {
    for (const looping of [false, true]) {
      const bytes = movie(); bytes.set(header(0x1013, 65537), bytes.length - 8);
      const f = await retainedFixture(bytes);
      try {
        const handle = f.owner.playNonSystem(await f.owner.prepare("a.roq"), rect, { ...normal, looping, holdAtEnd: true });
        if (handle === undefined) throw new Error("Missing retained frame");
        f.owner.run(handle); f.clock.time = 34;
        expect(f.owner.run(handle)).toBe(looping ? CinematicStatus.Playing : CinematicStatus.Idle);
        expect(f.owner.prepareUiRaw(handle)?.captureAfterBarrier().upload.content.copyPixels()[0]).toBe(255);
        expect(f.handles.readCount).toBe(looping ? 80 : 64);
        expect(f.handles.selectFree().slot).toBe(looping ? 2 : 1);
      } finally { await f.close(); }
    }
  });

  test("zero-length acquisition remains in the common table after failed play and final retirement", async () => {
    const f = await retainedFixture(new Uint8Array());
    try {
      const asset = await f.owner.prepare("a.roq");
      expect(f.owner.playNonSystem(asset, rect, normal)).toBeUndefined();
      expect(f.handles.readCount).toBe(0); expect(f.handles.selectFree().slot).toBe(2);
      expect(f.owner.playNonSystem(asset, rect, normal)).toBeUndefined();
      expect(f.handles.selectFree().slot).toBe(3);
      f.owner.dispose(); expect(f.handles.selectFree().slot).toBe(3);
    } finally { await f.close(); }
  });

  test("final retirement after common table closure does not call the ended filesystem", async () => {
    const f = await retainedFixture();
    try {
      await playing(f, "a.roq");
      f.handles.close();
      expect(() => f.owner.dispose()).not.toThrow();
      expect(() => f.owner.dispose()).not.toThrow();
    } finally { await f.close(); }
  });
});

describe("one source cl_cin owner", () => {
  test("developer diagnostics retain original arguments and source duplicate and no-frame stop branches", async () => {
    const f = fixture();
    expect(f.owner.playNonSystem(await f.owner.prepare("missing"), rect, normal)).toBeUndefined();
    expect(f.diagnostics.splice(0)).toEqual(["SCR_PlayCinematic( missing )\n", "play(missing), ROQSize<=0\n"]);
    const handle = f.owner.playNonSystem(await f.owner.prepare("a"), rect, normal);
    if (handle === undefined) throw new Error("Missing movie");
    expect(f.diagnostics.splice(0)).toEqual(["SCR_PlayCinematic( a )\n", "trFMV::play(), playing a\n"]);
    expect(f.owner.playNonSystem(await f.owner.prepare("video/a"), rect, normal)).toBe(handle);
    expect(f.diagnostics).toEqual([]);
    expect(f.owner.stop(handle)).toBe(CinematicStatus.Eof);
    expect(f.diagnostics.splice(0)).toEqual(["trFMV::stop(), closing video/a\n"]);
    f.owner.run(handle); f.clock.time = 34; f.owner.run(handle); f.owner.stop(handle);
    expect(f.diagnostics.splice(0)).toEqual(["trFMV::stop(), closing video/a\n", "finished cinematic\n"]);
    f.owner.playNonSystem(await f.owner.prepare("video/a"), rect, normal);
    expect(f.diagnostics).toEqual(["SCR_PlayCinematic( video/a )\n", "trFMV::play(), playing video/a\n"]);
    f.owner.dispose();
    const invalid = fixture(new Uint8Array(8));
    invalid.owner.playNonSystem(await invalid.owner.prepare("bad"), rect, normal);
    expect(invalid.diagnostics).toEqual(["SCR_PlayCinematic( bad )\n", "trFMV::play(), invalid RoQ ID\n"]);
    invalid.owner.dispose();
  });

  test("reached developer start abort precedes allocation and RagePro print follows INFO dimensions", async () => {
    const abort = new Error("developer abort"), messages: string[] = [];
    let reject = true;
    const f = fixture(movie(), 256, undefined, 22050, undefined, text => { messages.push(text); }, text => {
      messages.push(text); if (reject) throw abort;
    });
    const asset = await f.owner.prepare("a");
    expect(() => f.owner.playNonSystem(asset, rect, normal)).toThrow(abort);
    expect(f.clock.reads).toBe(0);
    reject = false;
    const handle = f.owner.playNonSystem(asset, rect, normal);
    if (handle === undefined) throw new Error("Missing movie");
    expect(handle.index).toBe(0);
    f.owner.run(handle);
    expect(messages).toEqual(["SCR_PlayCinematic( a )\n", "SCR_PlayCinematic( a )\n", "trFMV::play(), playing a\n",
      "HACK: approxmimating cinematic for Rage Pro or Voodoo\n"]);
    f.owner.dispose();
  });
  test("filename formatting uses Unix MAX_OSPATH bytes and warns again before duplicate reuse", async () => {
    const reads: string[] = [], f = fixture(movie(), 4096, {
      has: () => true, list: () => [], read: async path => { reads.push(path); return movie(); },
    });
    try {
      const below = await f.owner.prepare("é".repeat(4089) + "\0ignored/λ");
      expect(below.path).toBe(`video/${"é".repeat(4089)}`);
      const first = f.owner.playNonSystem(below, rect, normal);
      expect(first?.index).toBe(0); expect(f.effects).toEqual(["console"]);
      const at = await f.owner.prepare("é".repeat(4090));
      expect(at.path.length).toBe(4096);
      expect(reads).toEqual([below.path, below.path]);
      f.effects.length = 0;
      expect(f.owner.playNonSystem(at, rect, normal)).toBe(first);
      expect(f.owner.playNonSystem(at, rect, normal)).toBe(first);
      expect(f.effects).toEqual(["Com_sprintf: overflow of 4096 in 4096\n", "Com_sprintf: overflow of 4096 in 4096\n"]);
      expect(() => f.owner.prepare("λ.roq")).toThrow("Latin-1 source bytes");
    } finally { f.owner.dispose(); }
  });

  test("filename warning precedes retained open and a throwing diagnostic preserves reached effects", async () => {
    const effects: string[] = [], abort = new CommonError("drop", "filename diagnostic aborted");
    let rejectPrint = true;
    const f = fixture(movie(), 4096, undefined, 22050, { kind: "retained", current: () => {
      effects.push("open"); throw new Error("retained open reached");
    } }, text => { effects.push(text); if (rejectPrint) throw abort; });
    try {
      const asset = await f.owner.prepare(`dir/${"x".repeat(4092)}`);
      expect(effects).toEqual([]);
      expect(() => f.owner.playNonSystem(asset, rect, normal)).toThrow(abort);
      expect(effects).toEqual(["Com_sprintf: overflow of 4096 in 4096\n"]);
      rejectPrint = false;
      expect(() => f.owner.playNonSystem(asset, rect, normal)).toThrow("retained open reached");
      expect(effects).toEqual(["Com_sprintf: overflow of 4096 in 4096\n", "Com_sprintf: overflow of 4096 in 4096\n", "open"]);
      expect(f.effects).toEqual([]); expect(f.clock.reads).toBe(0);
    } finally { f.owner.dispose(); }
  });

  test("filename diagnostic abort precedes scratch clearing and full-slot rejection", async () => {
    const effects: string[] = [], abort = new CommonError("drop", "filename warning stopped");
    let rejectPrint = true;
    const f = fixture(movie(), 4096, undefined, 22050, undefined,
      text => { effects.push(text); if (rejectPrint) throw abort; });
    try {
      const first = await playing(f);
      let last = first.handle;
      for (let index = 1; index < 16; index++) {
        const handle = f.owner.playNonSystem(await f.owner.prepare(`slot-${index}`), rect, normal);
        if (handle === undefined) throw new Error("Missing occupied cinematic slot");
        expect(handle.index).toBe(index); last = handle;
      }
      f.owner.run(last); f.clock.time += 34; f.owner.run(last);
      const before = f.owner.prepareUiRaw(first.handle)?.captureAfterBarrier().upload.content.copyPixels();
      expect(before?.[0]).toBe(255);
      const asset = await f.owner.prepare("x".repeat(4090));
      expect(() => f.owner.playNonSystem(asset, rect, normal)).toThrow(abort);
      expect(effects).toEqual(["Com_sprintf: overflow of 4096 in 4096\n"]);
      expect(f.owner.prepareUiRaw(first.handle)?.captureAfterBarrier().upload.content.copyPixels()).toEqual(before);
      expect(f.owner.playNonSystem(first.asset, rect, normal)).toBe(first.handle);
      rejectPrint = false;
      expect(() => f.owner.playNonSystem(asset, rect, normal)).toThrow("CIN_HandleForVideo: none free");
      expect(effects).toHaveLength(2);
    } finally { f.owner.dispose(); }
  });

  test("filename bigbuffer fatal precedes warning and the diagnostic can retire the owner", async () => {
    const f = fixture();
    try {
      const below = await f.owner.prepare(`dir\\${"x".repeat(31995)}`);
      expect(f.owner.playNonSystem(below, rect, normal)?.index).toBe(0);
      expect(f.effects).toEqual(["Com_sprintf: overflow of 31999 in 4096\n", "console"]);
      f.effects.length = 0;
      const at = await f.owner.prepare(`dir\\${"x".repeat(31996)}`);
      try { f.owner.playNonSystem(at, rect, normal); throw new Error("Missing bigbuffer fatal"); }
      catch (error) {
        expect(error).toBeInstanceOf(CommonError);
        if (!(error instanceof CommonError)) throw error;
        expect(error.code).toBe("fatal"); expect(error.message).toBe("Com_sprintf: overflowed bigbuffer");
      }
      expect(f.effects).toEqual([]);
    } finally { f.owner.dispose(); }
    const retired = fixture(movie(), 4096, undefined, 22050, undefined, () => { retired.owner.dispose(); });
    const asset = await retired.owner.prepare("x".repeat(4090));
    expect(() => retired.owner.playNonSystem(asset, rect, normal)).toThrow("Engine cinematic owner is disposed");
    expect(retired.effects).toEqual([]);
  });

  test("UI, cgame and shader duplicate names retain first flags, handle and raw stream", async () => {
    const f = fixture(movie(16, 16, 255, [chunk(0x1020, [1, 1], 1000)]));
    const cgame = new EngineUiCinematics(f.owner, "cgame"), ui = new EngineUiCinematics(f.owner, "ui");
    const asset = await f.owner.prepare("a"), a = cgame.play(asset, rect), b = ui.play(asset, rect);
    if (a === undefined || b === undefined) throw new Error("Missing instances");
    const before = f.clock.reads, shader = await f.owner.shaderCinematics.playShaderCinematic("a");
    expect(b.handle).toBe(a.handle); expect(a.handle.index).toBe(0);
    expect(shader?.image).toBe(f.builtins.scratchImage(0)); expect(f.clock.reads).toBe(before);
    expect(f.effects).toEqual(["console"]);
    cgame.run(a.handle.index, 900000); expect(f.mixer.rawEnd).toBe(2);
    expect(Array.from(f.mixer.mix(2))).toEqual([1001, 1001, 1001, 1001]);
    f.owner.dispose();
  });

  test("UI-first duplicates remain silent and case-sensitive names remain separate", async () => {
    const f = fixture(movie(16, 16, 255, [chunk(0x1020, [1], 1000)])), ui = new EngineUiCinematics(f.owner, "ui");
    const first = ui.play(await f.owner.prepare("A"), rect);
    if (first === undefined) throw new Error("Missing UI movie");
    const same = f.owner.playNonSystem(await f.owner.prepare("A"), rect, normal);
    expect(same).toBe(first.handle); f.owner.run(first.handle); expect(f.mixer.rawEnd).toBe(0);
    const different = f.owner.playNonSystem(await f.owner.prepare("a"), rect, normal);
    expect(different?.index).toBe(1);
    f.owner.dispose();
  });

  test("preparation owns bytes, normalizes source names, and duplicate scan precedes inspecting a new caller's flags", async () => {
    const data = movie(), f = fixture(data), asset = await f.owner.prepare("a\0ignored");
    expect(asset.path).toBe("video/a"); expect(await f.owner.prepare("a")).toBe(asset);
    expect((await f.owner.prepare("dir\\movie")).path).toBe("dir\\movie");
    expect((await f.owner.prepare("x".repeat(300))).path.length).toBe(306);
    data.fill(0);
    const handle = f.owner.playNonSystem(asset, rect, normal); if (handle === undefined) throw new Error("Prepared bytes were not owned");
    const flags: NonSystemCinematicOptions = {
      get looping(): boolean { throw new Error("Duplicate read new flags"); },
      get holdAtEnd(): boolean { throw new Error("Duplicate read new flags"); },
      get silent(): boolean { throw new Error("Duplicate read new flags"); },
      get shader(): boolean { throw new Error("Duplicate read new flags"); },
    };
    expect(f.owner.playNonSystem({ path: asset.path }, rect, flags)).toBe(handle);
    f.owner.run(handle); f.clock.time = 34; f.owner.run(handle);
    expect(f.owner.prepareUiRaw(handle)?.captureAfterBarrier().upload.content.copyPixels()[0]).toBe(255);
    f.owner.dispose();
  });

  test("diagnostic mixer rejects a reached pre-INFO stereo sound update", async () => {
    const f = fixture(movie(16, 16, 255, [chunk(0x1020, [1], 1000), chunk(0x1021, [1, 2])]));
    const handle = f.owner.playNonSystem(await f.owner.prepare("audio"), rect, normal);
    if (handle === undefined) throw new Error("Missing audio");
    f.mixer.selectTime(7, 100);
    expect(() => f.owner.run(handle)).toThrow("requires engine sound update");
    expect(f.mixer.rawEnd).toBe(8);
    expect(Array.from(f.mixer.mix({ startFrame: 7, endFrame: 8 }))).toEqual([1001, 1001]);
    f.owner.dispose();
  });

  test("no-frame source calls do not bind or provide completions; registration provides genuine scratch identity", async () => {
    const f = fixture(), shader = await f.owner.shaderCinematics.playShaderCinematic("a");
    if (shader === null) throw new Error("Missing shader movie");
    expect(shader.image).toBe(f.builtins.scratchImage(0));
    expect(shader.prepareAtExecution()).toBeNull();
    f.clock.time = 34;
    const call = shader.prepareAtExecution();
    if (call === null) throw new Error("Missing shader upload");
    expect(call.upload.image).toBe(shader.image);
    expect([call.upload.sourceWidth, call.upload.sourceHeight, call.upload.uploadWidth, call.upload.uploadHeight]).toEqual([256, 256, 256, 256]);
    const bytes = call.upload.content.copyPixels();
    expect(bytes.length).toBe(256 * 256 * 4); expect(bytes[0]).toBe(255); expect(bytes[4096]).toBe(0);
    bytes.fill(9); expect(call.upload.content.copyPixels()[0]).toBe(255);
    call.afterShaderUpload(); expect(() => call.afterShaderUpload()).toThrow("one-shot");
    expect(shader.prepareAtExecution()?.upload.dirty).toBe(true);
    f.owner.dispose();
  });

  test("wall-state shutdown uses live post-upload settings and clears dirty only on its third disabled upload", async () => {
    const f = fixture(), shader = await f.owner.shaderCinematics.playShaderCinematic("a");
    if (shader === null) throw new Error("Missing shader");
    shader.prepareAtExecution(); f.clock.time = 34;
    const first = shader.prepareAtExecution(); if (first === null) throw new Error("No frame");
    f.settings.enabled = 0; first.afterShaderUpload();
    expect(shader.prepareAtExecution()?.upload.dirty).toBe(true);
    expect(shader.prepareAtExecution()?.upload.dirty).toBe(true);
    const reads = f.clock.reads;
    expect(shader.prepareAtExecution()?.upload.dirty).toBe(false);
    expect(f.clock.reads).toBe(reads);
    f.owner.dispose();
  });

  test("direct raw captures selected backing after barrier, while resampling captures private bytes before it", async () => {
    for (const size of [16, 512]) {
      const f = fixture(movie(size, size), size === 512 ? 256 : 4096), { handle } = await playing(f);
      const prepared = f.owner.prepareUiRaw(handle); if (prepared === null) throw new Error("Missing raw call");
      // Native direct-vs-private alias oracle: q3-image-cinematic-audit-ZF4F99.
      f.owner.playNonSystem(await f.owner.prepare("another"), rect, normal);
      const captured = prepared.captureAfterBarrier();
      expect(captured.upload.content.copyPixels()[0]).toBe(size === 16 ? 0 : 255);
      expect(captured.upload.dirty).toBe(true);
      expect(() => prepared.captureAfterBarrier()).toThrow("one-shot");
      f.owner.setExtents(handle, rect); captured.afterUiDraw();
      expect(f.owner.prepareUiRaw(handle)?.dirty).toBe(false);
      expect(() => captured.afterUiDraw()).toThrow("one-shot");
      f.owner.dispose();
    }
  });

  test("source resampling retains zero alpha bytes rather than applying the backend RGB8 conversion early", async () => {
    const data = stream([chunk(0x1001, [0, 2, 0, 2, 8, 0, 4, 0]), chunk(0x1011, new Array<number>(1024).fill(0)), chunk(0x1013, [])]);
    const f = fixture(data, 256), { handle } = await playing(f);
    const call = f.owner.prepareUiRaw(handle)?.captureAfterBarrier();
    expect(call?.upload.content.copyPixels().every(value => value === 0)).toBe(true);
    f.owner.dispose();
  });

  test("stop and closeAll before first buffer do not free source slots", async () => {
    const f = fixture(), handles: EngineCinematicHandle[] = [];
    for (let index = 0; index < 16; index++) {
      const handle = f.owner.playNonSystem(await f.owner.prepare(`movie${index}`), rect, normal);
      if (handle === undefined) throw new Error("Missing movie");
      handles.push(handle); expect(f.owner.stop(handle)).toBe(CinematicStatus.Eof);
    }
    f.owner.closeAllVideos();
    const extra = await f.owner.prepare("extra");
    let failure: unknown;
    try { f.owner.playNonSystem(extra, rect, normal); } catch (error: unknown) { failure = error; }
    expect(failure).toBeInstanceOf(CommonError);
    if (!(failure instanceof CommonError)) throw new Error("Expected cinematic slot exhaustion to drop");
    expect(failure.code).toBe("drop");
    expect(failure.message).toBe("CIN_HandleForVideo: none free");
    expect(f.owner.playNonSystem(await f.owner.prepare("movie0"), rect, normal)).toBe(handles[0]);
    f.owner.dispose(); f.owner.dispose();
    expect(() => f.owner.closeAllVideos()).toThrow("disposed");
  });

  test("freed cells retain old physical pointers; stale numeric handles observe the next occupant", async () => {
    const f = fixture(), { handle } = await playing(f);
    expect(f.owner.stop(handle)).toBe(CinematicStatus.Eof);
    const replacement = f.owner.playNonSystem(await f.owner.prepare("b"), rect, normal);
    expect(replacement).toBe(handle);
    const oldPointer = f.owner.prepareUiRaw(handle); if (oldPointer === null) throw new Error("Old buf was incorrectly cleared");
    expect(oldPointer.captureAfterBarrier().upload.content.copyPixels().every(value => value === 0)).toBe(true);
    f.owner.run(handle); f.clock.time = 68; f.owner.run(handle);
    expect(f.owner.prepareUiRaw(handle)?.captureAfterBarrier().upload.content.copyPixels()[0]).toBe(255);
    f.owner.dispose();
  });

  test("integer stop trap rejects invalid slots and preserves source EOF cells without side effects", async () => {
    const f = fixture(stream([chunk(0x1001, [16, 0, 16, 0, 8, 0, 4, 0]), chunk(0x1013, [])]));
    const asset = await f.owner.prepare("empty"), handle = f.owner.playNonSystem(asset, rect, normal);
    if (handle === undefined) throw new Error("Missing empty movie");
    const before = f.clock.reads;
    expect(f.owner.handleAtSlot(0)).toBe(handle);
    const idle = f.owner.handleAtSlot(15);
    expect(idle?.index).toBe(15);
    expect(f.owner.handleAtSlot(15)).toBe(idle);
    for (const index of [-1, 16, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(f.owner.stopSlot(index)).toBe(CinematicStatus.Eof);
      expect(f.owner.handleAtSlot(index)).toBeUndefined();
    }
    expect(f.clock.reads).toBe(before);
    // Stop before buf does not mark EOF or free the occupied filename.
    expect(f.owner.stopSlot(0)).toBe(CinematicStatus.Eof);
    expect(f.owner.run(handle)).toBe(CinematicStatus.Playing);
    f.clock.time = 34; expect(f.owner.run(handle)).toBe(CinematicStatus.Eof);
    const endedReads = f.clock.reads;
    expect(f.owner.stopSlot(0)).toBe(CinematicStatus.Eof);
    expect(f.owner.run(handle)).toBe(CinematicStatus.Eof);
    expect(f.clock.reads).toBe(endedReads);
    expect(f.owner.playNonSystem(asset, rect, normal)).toBe(handle);
    f.owner.dispose();
    expect(() => f.owner.handleAtSlot(0)).toThrow("disposed");
    expect(() => f.owner.handleAtSlot(-1)).toThrow("disposed");
  });

  test("stale integer stop addresses the new occupant of the same canonical cell", async () => {
    const f = fixture(), { handle } = await playing(f);
    const staleIndex = handle.index;
    expect(f.owner.stopSlot(staleIndex)).toBe(CinematicStatus.Eof);
    const next = f.owner.playNonSystem(await f.owner.prepare("next"), rect, normal);
    expect(next).toBe(handle);
    // The old retained buf means even a pre-frame replacement can now be stopped.
    expect(f.owner.stopSlot(staleIndex)).toBe(CinematicStatus.Eof);
    expect(f.owner.playNonSystem(await f.owner.prepare("third"), rect, normal)).toBe(handle);
    f.owner.dispose();
  });

  test("missing and invalid plays retain distinct source failure effects, and pending reads cannot outlive disposal", async () => {
    const f = fixture(), { handle } = await playing(f);
    expect(f.owner.playNonSystem(await f.owner.prepare("missing"), rect, normal)).toBeUndefined();
    expect(f.owner.prepareUiRaw(handle)?.captureAfterBarrier().upload.content.copyPixels()[0]).toBe(0);
    expect(() => f.owner.playNonSystem({ path: "video/foreign" }, rect, normal)).toThrow("another owner");
    expect(() => f.owner.playNonSystem({ path: "" }, rect, normal)).toThrow("another owner");
    const invalid = fixture(new Uint8Array(8));
    const bad = await invalid.owner.prepare("bad");
    expect(invalid.owner.playNonSystem(bad, rect, normal)).toBeUndefined();
    // BSS IDLE + absent buf makes RoQShutdown a no-op: the invalid filename remains occupied.
    const retained = invalid.owner.playNonSystem(bad, rect, normal);
    expect(retained?.index).toBe(0); expect(invalid.effects).toEqual([]);
    const pending = Promise.withResolvers<Uint8Array>();
    const closing = fixture(movie(), 4096, { has: () => true, list: () => [], read: () => pending.promise });
    const load = closing.owner.prepare("pending"); closing.owner.dispose(); pending.resolve(movie());
    await expect(load).rejects.toThrow("disposed");
    f.owner.dispose(); invalid.owner.dispose();
  });

  test("failed read preparation is inert until new play clears shared storage and rethrows the original cause", async () => {
    const cause = new BinaryError("fixture.pk3", 12, "CRC mismatch"), data = movie();
    const f = fixture(data, 4096, { has: () => true, list: () => [], read: async path => {
      if (path === "video/failed") throw cause;
      return data;
    } });
    const { handle } = await playing(f);
    const failed = await f.owner.prepare("failed");
    expect(f.owner.prepareUiRaw(handle)?.captureAfterBarrier().upload.content.copyPixels()[0]).toBe(255);
    const reads = f.clock.reads, effects = [...f.effects];
    let caught: unknown;
    try { f.owner.playNonSystem(failed, rect, normal); } catch (error: unknown) { caught = error; }
    expect(caught).toBe(cause);
    expect(f.owner.prepareUiRaw(handle)?.captureAfterBarrier().upload.content.copyPixels()[0]).toBe(0);
    expect(f.clock.reads).toBe(reads); expect(f.effects).toEqual(effects);
    // The failed pathname is not published as a successful duplicate on retry.
    expect(() => f.owner.playNonSystem(failed, rect, normal)).toThrow(cause);
    const next = f.owner.playNonSystem(await f.owner.prepare("next"), rect, normal);
    expect(next?.index).toBe(1);
    f.owner.dispose();
  });

  test("deferred file failures do not bypass duplicate-first behavior or conceal disposal", async () => {
    const cause = new Error("Read rejected after disposal"), pending = Promise.withResolvers<Uint8Array>();
    const f = fixture(movie(), 4096, { has: () => true, list: () => [], read: () => pending.promise });
    const load = f.owner.prepare("pending"); f.owner.dispose(); pending.reject(cause);
    await expect(load).rejects.toThrow("disposed");
    const live = fixture(), { asset, handle } = await playing(live);
    const before = live.clock.reads;
    // A duplicate never consults a newly supplied preparation identity or flags.
    expect(live.owner.playNonSystem({ path: asset.path }, rect, normal)).toBe(handle);
    expect(live.clock.reads).toBe(before);
    expect(live.owner.prepareUiRaw(handle)?.captureAfterBarrier().upload.content.copyPixels()[0]).toBe(255);
    live.owner.dispose();
  });

  test("handle switch includes reset plus two same-call live samples, without decoding a frame", async () => {
    const f = fixture(), first = await playing(f, "a");
    await playing(f, "b"); f.clock.time = 200;
    const before = f.clock.reads;
    expect(f.owner.run(first.handle)).toBe(CinematicStatus.Playing);
    expect(f.clock.reads - before).toBe(3);
    f.owner.dispose();
  });

  test("hold takes precedence over loop; natural non-loop EOF frees filename but retains upload buffer", async () => {
    const held = fixture(), a = await playing(held, "hold", { ...normal, looping: true, holdAtEnd: true });
    held.clock.time = 1000; expect(held.owner.run(a.handle)).toBe(CinematicStatus.Idle);
    expect(held.owner.playNonSystem(a.asset, rect, normal)).toBe(a.handle);
    expect(held.owner.prepareUiRaw(a.handle)).not.toBeNull();
    const eof = fixture(), b = await playing(eof);
    eof.clock.time = 1000; expect(eof.owner.run(b.handle)).toBe(CinematicStatus.Idle);
    expect(eof.owner.playNonSystem(await eof.owner.prepare("next"), rect, normal)).toBe(b.handle);
    held.owner.dispose(); eof.owner.dispose();
  });

  test("pre-INFO PCM exceeding the raw ring completes and permits the first frame", async () => {
    // Mono duplication fits the source's 32768-short decode buffer; resampling still exceeds the raw ring.
    const f = fixture(movie(16, 16, 255, [chunk(0x1020, new Array<number>(15000).fill(1), 1000)]), 4096, undefined, 44100);
    const handle = f.owner.playNonSystem(await f.owner.prepare("audio"), rect, normal);
    if (handle === undefined) throw new Error("Missing audio");
    f.owner.run(handle);
    expect(f.mixer.rawEnd).toBe(30000);
    expect(f.mixer.soundClock).toBe(0);
    const pcm = f.mixer.mix({ startFrame: 0, endFrame: 30000 });
    for (let frame = 0; frame < 30000; frame++) {
      const sourceFrame = frame < 30000 - f.mixer.rawCapacity ? frame + f.mixer.rawCapacity : frame;
      const expected = 1001 + Math.trunc(sourceFrame / 4);
      expect(pcm[frame * 2]).toBe(expected); expect(pcm[frame * 2 + 1]).toBe(expected);
    }
    expect(f.clock.reads).toBe(4);
    f.clock.time = 34;
    expect(f.owner.run(handle)).toBe(CinematicStatus.Playing);
    expect(f.owner.prepareUiRaw(handle)).not.toBeNull();
    expect(f.mixer.soundClock).toBe(0);
    f.owner.dispose();
  });

  test("packet INFO publishes reused-slot dimensions before later raw diagnostics", async () => {
    let supplied = movie();
    const f = fixture(supplied, 4096, { has: () => true, list: () => [], read: async () => supplied }, 44100);
    try {
      const first = await playing(f, "old");
      f.owner.stop(first.handle);
      supplied = stream([chunk(0x1030, [
        ...chunk(0x1001, [16, 0, 16, 0, 8, 0, 4, 0]),
        ...chunk(0x1020, new Array<number>(15000).fill(0), 1000),
      ], 2), chunk(0x1013, [])]);
      const handle = f.owner.playNonSystem(await f.owner.prepare("new"), rect, normal);
      if (handle === undefined) throw new Error("Missing reused cinematic");
      const cvars = new CvarRegistry(); cvars.register("developer", "1");
      f.mixer.bindSoundCvars(cvars);
      let width = 0;
      f.mixer.bindConsoleOutput(new ConsoleOutput(text => {
        if (text.includes("overflowed")) width = f.owner.prepareUiRaw(handle)?.captureAfterBarrier().upload.sourceWidth ?? 0;
      }));
      f.owner.run(handle);
      expect(width).toBe(16);
    } finally { f.owner.dispose(); }
  });

  test("raw overflow diagnostics observe the earlier frame before aborting the same cinematic run", async () => {
    const bytes = new Uint8Array([...movie().subarray(0, -8),
      ...chunk(0x1020, new Array<number>(15000).fill(0), 1000), ...chunk(0x1013, [])]);
    const f = fixture(bytes, 4096, undefined, 44100);
    const handle = f.owner.playNonSystem(await f.owner.prepare("overflow"), rect, normal);
    if (handle === undefined) throw new Error("Missing overflow cinematic");
    const cvars = new CvarRegistry(); cvars.register("developer", "1");
    f.mixer.bindSoundCvars(cvars);
    let frameVisible = false;
    f.mixer.bindConsoleOutput(new ConsoleOutput(text => {
      if (!text.includes("overflowed")) return;
      frameVisible = f.owner.prepareUiRaw(handle) !== null;
      throw new Error("raw overflow diagnostic abort");
    }));
    try {
      f.owner.run(handle); f.clock.time = 100;
      expect(() => f.owner.run(handle)).toThrow("raw overflow diagnostic abort");
      expect(frameVisible).toBe(true);
      expect(f.owner.prepareUiRaw(handle)).not.toBeNull();
      expect(f.mixer.rawEnd).toBe(30000);
    } finally { f.owner.dispose(); }
  });

  test("system play awaits menu closure before decoder initialization and later source effects", async () => {
    for (const mode of ["valid", "invalid", "disposed"]) {
      const f = fixture(mode === "invalid" ? new Uint8Array(8) : movie());
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      let state: "cinematic" | "other" = "other";
      const system = f.owner.attachSystem({
        state: () => state, closeMenu: async () => {
          f.effects.push("menu-begin"); entered.resolve(); await release.promise; f.effects.push("menu-end");
        },
        enterCinematic: () => { f.effects.push("cinematic"); state = "cinematic"; },
        enterDisconnected: () => { f.effects.push("disconnected"); state = "other"; },
        nextMap: () => "map q3dm1", clearNextMap: () => { f.effects.push("clear-nextmap"); },
        appendCommand: text => { f.effects.push(text); }, stopAllSounds: () => { f.effects.push("stop-sounds"); },
      });
      f.clock.sample = () => { f.clock.reads++; return f.clock.time++; };
      f.mixer.selectTime(7, 100);
      const playing = system.play("awaited.roq");
      await entered.promise;
      expect(f.effects).toEqual(["stop-sounds", "menu-begin"]);
      expect(f.clock.reads).toBe(0); expect(f.mixer.rawEnd).toBe(0); expect(state).toBe("other");
      if (mode === "disposed") f.owner.dispose();
      release.resolve();
      if (mode === "disposed") await expect(playing).rejects.toThrow("disposed");
      else {
        const handle = await playing;
        expect(handle === undefined).toBe(mode === "invalid");
      }
      expect(f.effects).toEqual(mode === "valid"
        ? ["stop-sounds", "menu-begin", "menu-end", "cinematic", "console"]
        : ["stop-sounds", "menu-begin", "menu-end"]);
      expect(f.mixer.rawEnd).toBe(mode === "valid" ? 7 : 0);
      if (mode !== "valid") expect(f.clock.reads).toBe(0);
      f.owner.dispose();
    }
  });

  test("final disposal releases an active system movie without calling a closed host", async () => {
    const f = fixture(); let closedHost = false;
    const reached = (effect: string): undefined => {
      if (closedHost) throw new Error(`Closed host reached: ${effect}`);
      f.effects.push(effect);
    };
    const system = f.owner.attachSystem({
      state: () => { reached("state"); return "cinematic"; }, closeMenu: async () => reached("menu"),
      enterCinematic: () => reached("cinematic"), enterDisconnected: () => reached("disconnected"),
      nextMap: () => { reached("nextmap"); return "map q3dm1"; }, clearNextMap: () => reached("clear-nextmap"),
      appendCommand: text => reached(text), stopAllSounds: () => reached("stop-sounds"),
    });
    f.clock.sample = () => { f.clock.reads++; return f.clock.time++; };
    const handle = await system.play("active.roq");
    if (handle === undefined) throw new Error("Missing system movie");
    const prepared = f.owner.prepareUiRaw(handle);
    if (prepared === null) throw new Error("Missing decoded system frame");
    const asset = await f.owner.prepare("active.roq"), effects = [...f.effects], reads = f.clock.reads;
    closedHost = true;
    f.owner.dispose(); f.owner.dispose(); system.stop();
    expect(system.run()).toBe(CinematicStatus.Eof);
    expect(f.effects).toEqual(effects); expect(f.clock.reads).toBe(reads);
    expect(() => prepared.captureAfterBarrier()).toThrow("disposed");
    expect(() => f.owner.run(handle)).toThrow("disposed");
    expect(() => f.owner.playNonSystem(asset, rect, normal)).toThrow("disposed");
    expect(() => f.owner.prepare("active.roq")).toThrow("disposed");
  });

  test("system capability applies real host order and guards without being attached in production", async () => {
    const f = fixture(); let state: "cinematic" | "other" = "other";
    const host: SystemCinematicHost = {
      state: () => state, closeMenu: async () => { f.effects.push("menu"); },
      enterCinematic: () => { f.effects.push("cinematic"); state = "cinematic"; },
      enterDisconnected: () => { f.effects.push("disconnected"); state = "other"; },
      nextMap: () => { f.effects.push("nextmap"); return "map q3dm1"; },
      clearNextMap: () => { f.effects.push("clear-nextmap"); },
      appendCommand: text => { f.effects.push(text); }, stopAllSounds: () => { f.effects.push("stop-sounds"); },
    };
    const system = f.owner.attachSystem(host);
    // A genuinely live clock advances during the source synchronous wait-for-first-frame loop.
    f.clock.sample = () => { f.clock.reads++; return f.clock.time++; };
    const handle = await system.play("end.roq"); expect(handle?.index).toBe(0);
    expect(f.diagnostics).toEqual(["CL_PlayCinematic_f\n", "SCR_PlayCinematic( end.roq )\n", "trFMV::play(), playing end.roq\n"]);
    expect(f.effects).toEqual(["stop-sounds", "menu", "cinematic", "console"]);
    state = "other"; const before = f.clock.reads; expect(system.run()).toBe(CinematicStatus.Playing); expect(f.clock.reads).toBe(before);
    state = "cinematic"; system.stop();
    expect(f.effects.slice(4)).toEqual(["disconnected", "nextmap", "map q3dm1\n", "clear-nextmap", "stop-sounds"]);
    expect(system.run()).toBe(CinematicStatus.Eof); expect(() => f.owner.attachSystem(host)).toThrow("already attached");
    f.owner.dispose();
  });
});
