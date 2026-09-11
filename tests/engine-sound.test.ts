// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileHandle } from "../src/assets/file-handles.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { EngineSound } from "../src/engine/sound.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { DedicatedEventSource } from "../src/platform/dedicated-input.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";
import { CommonError } from "../src/core/common-error.ts";
import { vec3 } from "../src/core/math.ts";
import type { Axis } from "../src/core/math.ts";
import { CvarFlag } from "../src/core/cvar.ts";
import { SdlAudioDevice } from "../src/platform/audio.ts";

if (process.env["QUAKE_ENGINE_SOUND_CHILD"] !== "1") {
  test("engine sound commands with retail PCM and actual SDL output", async () => {
    const child = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, DISPLAY: undefined, WAYLAND_DISPLAY: undefined,
        SDL_AUDIODRIVER: "dummy", SDL_AUDIO_FREQUENCY: "48000", QUAKE_ENGINE_SOUND_CHILD: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`Engine sound child failed (${exitCode})\n${stdout}${stderr}`);
    expect(exitCode).toBe(0);
  }, 15000);
} else {
  test("unsupported output-rate accounting leaves startup retryable without changing the selected rate", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "quake3-unavailable-sound-rate-"));
    const printed: string[] = [];
    const io = new UnixIo(() => undefined, new UnixSystemClock(), { signals: "none" });
    const events = new CommonEvents(new DedicatedEventSource(io), () => undefined);
    const common = await CommonConsole.open({
      roots: { dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath, cdPath: null, product: "baseq3" },
      startup: new StartupCommands("+set sndspeed 22050"), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
      platformPrint: text => { printed.push(text); }, resolveCommand: () => undefined,
      assertCommandEntry: () => undefined, assertOwnerEntry: () => undefined,
    }, () => undefined);
    const sound = new EngineSound(common, events);
    try {
      for (const rate of [22050, 11025]) {
        common.cvars.set("sndspeed", String(rate));
        printed.length = 0;
        expect(() => sound.initialize({ sampleRate: 48000, bufferFrames: 256 })).not.toThrow();
        expect(common.cvars.get("sndspeed")?.value).toBe(String(rate));
        if (sound.started) {
          // Native SDL2 can provide exact queues here; sdl2-compat's resampling
          // profile rejects these rates with the child's fixed 48000 Hz driver.
          expect(sound.mixer?.outputRate).toBe(rate);
          sound.shutdown();
        } else {
          expect(common.sound.mixer).toBeNull();
          expect(printed.some(text => text.includes("cannot report exact queued input frames at this sample rate"))).toBe(true);
        }
        common.cvars.set("sndspeed", "48000");
        sound.initialize({ sampleRate: 22050, bufferFrames: 256 });
        expect(sound.started).toBe(true);
        expect(sound.mixer?.outputRate).toBe(48000);
        common.sound.pause();
        common.sound.submit(5);
        expect(common.sound.queuedFrames).toBe(5);
        sound.shutdown();
        expect(common.sound.mixer).toBeNull();
      }
    } finally {
      try { sound.close(); } finally {
        try { common.close(); } finally { io.close(); await rm(homePath, { recursive: true, force: true }); }
      }
    }
  });

  test("archived Linux output cvars select actual SDL format, rate and device across sound restart", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "quake3-selected-sound-"));
    const printed: string[] = [];
    const io = new UnixIo(() => undefined, new UnixSystemClock(), { signals: "none" });
    const events = new CommonEvents(new DedicatedEventSource(io), () => undefined);
    const common = await CommonConsole.open({
      roots: { dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath, cdPath: null, product: "baseq3" },
      startup: new StartupCommands("+set sndbits 8 +set sndchannels 1 +set sndspeed 48000 +set s_khz 11"),
      random: new LinuxNativeRandom(1), build: { kind: "dedicated" }, platformPrint: text => { printed.push(text); },
      resolveCommand: () => undefined, assertCommandEntry: () => undefined, assertOwnerEntry: () => undefined,
    }, () => undefined);
    const sound = new EngineSound(common, events);
    try {
      const deviceName = SdlAudioDevice.outputDeviceNames()[0];
      if (deviceName === undefined) throw new Error("Missing dummy output device");
      common.cvars.set("snddevice", deviceName);
      sound.initialize({ sampleRate: 22050, bufferFrames: 256 });
      common.sound.pause();
      expect(sound.started).toBe(true);
      expect(sound.mixer?.outputRate).toBe(48000);
      expect(sound.mixer?.outputChannels).toBe(1);
      expect(common.sound.sampleBits).toBe(8);
      expect(common.sound.channels).toBe(1);
      expect(common.sound.deviceName).toBe(deviceName);
      expect(common.cvars.get("s_khz")?.value).toBe("11");
      for (const name of ["sndbits", "sndspeed", "sndchannels", "snddevice"]) {
        const cvar = common.cvars.get(name);
        if (cvar === undefined) throw new Error(`Missing source output cvar ${name}`);
        expect(cvar.flags & CvarFlag.Archive).toBe(CvarFlag.Archive);
      }
      expect(printed.some(text => text.includes("SDL2 queued U8 mono: 48000 Hz"))).toBe(true);
      common.sound.submit(4);
      expect(common.sound.queuedFrames).toBe(4);
      expect(common.sound.pendingOutput.samples).toEqual(new Uint8Array(4).fill(128));
      common.cvars.set("sndbits", "24");
      common.cvars.set("sndchannels", "7");
      common.cvars.set("sndspeed", "0");
      common.cvars.set("snddevice", "");
      expect(common.sound.sampleBits).toBe(8);
      expect(common.sound.channels).toBe(1);
      sound.shutdown();
      sound.initialize({ sampleRate: 48000, bufferFrames: 256 });
      common.sound.pause();
      expect(sound.started).toBe(true);
      expect(common.sound.sampleBits).toBe(16);
      expect(common.sound.channels).toBe(2);
      expect(common.sound.deviceName).toBeNull();
      expect(sound.mixer?.outputRate).toBe(48000);
      sound.shutdown();
      common.cvars.set("snddevice", "quake3-missing-dummy-output");
      sound.initialize({ sampleRate: 48000 });
      expect(sound.started).toBe(false);
      expect(common.sound.mixer).toBeNull();
      common.cvars.set("snddevice", deviceName);
      sound.initialize({ sampleRate: 48000 });
      expect(sound.started).toBe(true);
      expect(common.sound.deviceName).toBe(deviceName);
    } finally {
      try { sound.close(); } finally {
        try { common.close(); } finally { io.close(); await rm(homePath, { recursive: true, force: true }); }
      }
    }
  });

  test("actual sound owner records source whole-file reads and replays bytes, misses and registration retirement", async () => {
    const root = await mkdtemp(join(tmpdir(), "quake3-source-sound-journal-"));
    const dataPath = join(root, "data"), homePath = join(root, "home"), game = join(homePath, "baseq3");
    await mkdir(join(dataPath, "baseq3"), { recursive: true });
    await mkdir(join(game, "sound/feedback"), { recursive: true });
    await writeFile(join(dataPath, "baseq3/default.cfg"), "set fixture_journal 1\n");
    await writeFile(join(dataPath, "baseq3/productid.txt"), SOURCE_PRODUCT_ID);
    const bytes = new Uint8Array(48), view = new DataView(bytes.buffer);
    for (const [offset, text] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] satisfies readonly (readonly [number, string])[]) {
      for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
    }
    view.setUint32(4, 40, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 22050, true); view.setUint32(28, 44100, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    view.setUint32(40, 4, true); view.setInt16(44, 101, true); view.setInt16(46, -202, true);
    for (const name of ["sound/feedback/hit.wav", "recorded.cfg.wav", "async.cfg.wav", "plain.CFG.wav", "retire.cfg.wav"]) {
      await writeFile(join(game, name), bytes);
    }
    const shortBytes = bytes.slice(0, 46), shortView = new DataView(shortBytes.buffer);
    shortView.setUint32(4, 38, true); shortView.setUint32(24, 96000, true);
    shortView.setUint32(28, 192000, true); shortView.setUint32(40, 2, true);
    await writeFile(join(game, "short.wav"), shortBytes);
    const lowQuality = bytes.slice(), lowQualityView = new DataView(lowQuality.buffer);
    lowQualityView.setUint32(24, 11025, true); lowQualityView.setUint32(28, 11025, true);
    lowQualityView.setUint16(32, 1, true); lowQualityView.setUint16(34, 8, true);
    for (const name of ["debug-quiet.wav", "debug-enabled.wav", "debug-switch.wav"]) await writeFile(join(game, name), lowQuality);
    const io = new UnixIo(() => undefined, new UnixSystemClock(), { signals: "none" });
    const events = new CommonEvents(new DedicatedEventSource(io), () => undefined);
    const commons: CommonConsole[] = [], sounds: EngineSound[] = [], printed: string[] = [];
    let onPrint: (text: string) => void = () => undefined;
    async function open(mode: number) {
      const common = await CommonConsole.open({ roots: { dataPath, homePath, cdPath: null, product: "baseq3" },
        startup: new StartupCommands(`+set journal ${mode} +set developer 1`), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
        platformPrint: text => { printed.push(text); onPrint(text); }, resolveCommand: () => undefined,
        assertCommandEntry: () => undefined, assertOwnerEntry: () => undefined }, owner => { commons.push(owner); });
      common.registerRuntimeCvars("source-sound-journal", async () => undefined);
      const sound = new EngineSound(common, events); sounds.push(sound);
      sound.initialize({ sampleRate: 48000, bufferFrames: 256 }); await sound.beginRegistration();
      return { common, sound };
    }
    try {
      const record = await open(1), journalPath = join(game, "journaldata.dat"), offset = (await readFile(journalPath)).byteLength;
      const mixer = record.sound.mixer;
      if (mixer === null) throw new Error("Missing actual sound mixer");
      record.common.sound.pause();
      const short = record.sound.bank.sound("short.wav", false);
      if (short === null) throw new Error("Missing registered zero-resampled sound");
      expect(record.sound.bank.frameCount(short)).toBe(0);
      const axis: Axis = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
      mixer.setEffectsVolume(1);
      for (const persistent of [false, true]) {
        record.sound.updateEntityPosition(4, vec3(0, 100, 0));
        let originReads = 0;
        const options = { entity: 4, frameNumber: 1, velocity: vec3(0, 0, 0),
          get origin() { originReads++; return vec3(0, -100, 0); } };
        let failure: unknown;
        try {
          if (persistent) record.sound.updateRealLoopingSound(short, options);
          else record.sound.updateLoopingSound(short, options);
        } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(CommonError);
        if (!(failure instanceof CommonError)) throw new Error("Loop failure did not enter common error dispatch");
        expect(failure.code).toBe("drop");
        expect(failure.message).toBe("short.wav has length 0");
        expect(originReads).toBe(0);
        const audible = record.sound.bank.resolveForPlayback(null);
        if (audible === null) throw new Error("Missing audible sound fixture");
        expect(record.sound.startSound(audible, { entity: 4, channel: -1, volume: 127, origin: { kind: "entity", entity: 4 } })).toBe(true);
        record.sound.setListener(-1, vec3(0, 0, 0), axis);
        expect(Array.from(mixer.channelVolumes()).map(channel => [channel.left, channel.right])).toEqual([[124, 0]]);
        mixer.clearSoundBuffer();
      }
      record.common.cvars.set("developer", "0.5", true);
      printed.length = 0;
      expect(record.sound.mixer?.outputRate).toBe(48000);
      expect(record.sound.bank.sound("debug-quiet.wav", false)?.sampleRate).toBe(48000);
      expect(printed).toEqual([]);
      record.common.cvars.set("developer", "-1", true);
      expect((await record.sound.bank.registerSound("debug-enabled.wav", false))?.sampleRate).toBe(48000);
      expect(printed).toEqual([
        "^3WARNING: debug-enabled.wav is a 8 bit wav file\n",
        "^3WARNING: debug-enabled.wav is not a 22kHz wav file\n",
      ]);
      printed.length = 0;
      onPrint = text => {
        if (text === "^3WARNING: debug-switch.wav is a 8 bit wav file\n") record.common.cvars.set("developer", "0", true);
      };
      const switched = record.sound.bank.sound("debug-switch.wav", false);
      expect(switched?.sampleRate).toBe(48000);
      expect(printed).toEqual(["^3WARNING: debug-switch.wav is a 8 bit wav file\n", "Cvar_Set2: developer 0\n"]);
      onPrint = () => undefined;
      record.common.cvars.set("developer", "1", true);
      expect(record.sound.bank.sound("debug-switch.wav", false)).toBe(switched);
      expect(printed).toEqual(["^3WARNING: debug-switch.wav is a 8 bit wav file\n", "Cvar_Set2: developer 0\n"]);
      // ResampleSfx at 22050 -> 48000 uses step 117, selecting source frames 0, 0, 0, 1.
      expect(record.sound.bank.sound("recorded.cfg.wav", false)?.samples).toEqual(new Int16Array([101, 101, 101, -202]));
      expect((await record.sound.bank.registerSound("async.cfg.wav", false))?.samples).toEqual(new Int16Array([101, 101, 101, -202]));
      expect(record.sound.bank.sound("absent.cfg.wav", false)).toBeNull();
      expect(record.sound.bank.sound("plain.CFG.wav", false)?.samples).toEqual(new Int16Array([101, 101, 101, -202]));
      onPrint = text => { if (text === "Writing retire.cfg.wav to journal file.\n") record.sound.close(); };
      expect(() => record.sound.bank.sound("retire.cfg.wav", false)).toThrow("Sound registration lifetime ended");
      expect(record.sound.bank.registeredSounds().find(entry => entry.name === "retire.cfg.wav")?.sound).toBeNull();
      onPrint = () => undefined;
      const recorded = await readFile(journalPath), journal = new DataView(recorded.buffer, recorded.byteOffset, recorded.byteLength);
      expect(recorded.byteLength).toBe(offset + 52 + 52 + 4 + 52);
      expect([journal.getInt32(offset, true), journal.getInt32(offset + 52, true), journal.getInt32(offset + 104, true), journal.getInt32(offset + 108, true)])
        .toEqual([48, 48, 0, 48]);
      expect(new Uint8Array(recorded.subarray(offset + 4, offset + 52))).toEqual(bytes);
      record.common.close();
      await unlink(join(game, "recorded.cfg.wav")); await unlink(join(game, "async.cfg.wav"));
      await writeFile(join(game, "absent.cfg.wav"), bytes);
      const changed = bytes.slice(); new DataView(changed.buffer).setInt16(44, 555, true); await writeFile(join(game, "plain.CFG.wav"), changed);
      const replay = await open(2);
      expect(replay.common.files.current.has("recorded.cfg.wav")).toBe(false);
      expect(replay.common.files.current.has("absent.cfg.wav")).toBe(true);
      expect(replay.sound.bank.sound("recorded.cfg.wav", false)?.samples).toEqual(new Int16Array([101, 101, 101, -202]));
      expect((await replay.sound.bank.registerSound("async.cfg.wav", false))?.samples).toEqual(new Int16Array([101, 101, 101, -202]));
      expect(replay.sound.bank.sound("absent.cfg.wav", false)).toBeNull();
      expect(replay.sound.bank.sound("plain.CFG.wav", false)?.samples).toEqual(new Int16Array([555, 555, 555, -202]));
      onPrint = text => { if (text === "Loading retire.cfg.wav from journal file.\n") replay.sound.close(); };
      expect(() => replay.sound.bank.sound("retire.cfg.wav", false)).toThrow("Sound registration lifetime ended");
      expect(replay.sound.bank.registeredSounds().find(entry => entry.name === "retire.cfg.wav")?.sound).toBeNull();
      expect(printed).toContain("^3WARNING: could not find absent.cfg.wav - using default\n");
    } finally {
      onPrint = () => undefined;
      try { for (const sound of sounds.reverse()) sound.close(); }
      finally { try { for (const common of commons.reverse()) common.close(); } finally { io.close(); await rm(root, { recursive: true }); } }
    }
  });

  for (const filesystemFirst of [false, true]) test(`final sound disposal ${filesystemFirst ? "after" : "before"} common filesystem shutdown`, async () => {
    const homePath = await mkdtemp(join(tmpdir(), "quake3-music-retirement-"));
    const io = new UnixIo(() => {}, new UnixSystemClock(), { signals: "none" });
    const events = new CommonEvents(new DedicatedEventSource(io), () => {});
    const common = await CommonConsole.open({
      roots: { dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath, cdPath: null, product: "missionpack" },
      startup: new StartupCommands("+set s_initsound 0"), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
      platformPrint: () => {}, resolveCommand: () => undefined, assertCommandEntry: () => {}, assertOwnerEntry: () => {},
    }, () => {});
    const sound = new EngineSound(common, events), files = common.files.current;
    const retained: { file: FileHandle | null } = { file: null };
    const open = files.openUniqueRead.bind(files);
    files.openUniqueRead = (path, selected) => { const opened = open(path, selected); retained.file = opened?.file ?? null; return opened; };
    try {
      sound.initialize({ sampleRate: 48000 });
      await sound.startBackgroundTrack("music/fla22k_01_intro.wav", "music/fla22k_01_loop.wav");
      expect(sound.started).toBe(false); expect(sound.music.isPlaying).toBe(true);
      files.openUniqueRead = open;
      const file = retained.file;
      if (file === null) throw new Error("Missing common-owned music handle");
      if (filesystemFirst) common.shutdownFileSystem();
      sound.close();
      expect(sound.music.isPlaying).toBe(false); expect(sound.music.mixer).toBeNull();
      expect(() => sound.music.start("music/fla22k_01_intro.wav")).toThrow("retired");
      sound.music.update(); sound.music.stop(); sound.close();
      if (!filesystemFirst) {
        // Final sound retirement forgets its borrow; only common owns cleanup.
        expect(files.readInto(file, new Uint8Array(4))).toBe(4);
        common.shutdownFileSystem();
      }
    expect(() => common.files).toThrow(new CommonError("fatal", "Filesystem call made without initialization\n"));
      expect(() => files.readInto(file, new Uint8Array(1))).toThrow("retired");
    } finally {
      try { sound.close(); } finally {
        try { common.close(); } finally { io.close(); await rm(homePath, { recursive: true, force: true }); }
      }
    }
  });

  test("disabled startup, registration, play/music, disable and source shutdown", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "quake3-engine-sound-"));
    const printed: string[] = [];
    const io = new UnixIo(text => { printed.push(text); }, new UnixSystemClock(), { signals: "none" });
    const events = new CommonEvents(new DedicatedEventSource(io), text => { printed.push(text); });
    // This isolates the common core without a window; sound is explicitly started by its real owner.
    const common = await CommonConsole.open({
      roots: { dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath, cdPath: null, product: "baseq3" },
      startup: new StartupCommands("+set s_initsound 0"), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
      platformPrint: text => { printed.push(text); }, resolveCommand: () => undefined,
      assertCommandEntry: () => {}, assertOwnerEntry: () => {},
    }, () => {});
    common.registerRuntimeCvars("engine-sound-fixture", async () => undefined);
    const sound = new EngineSound(common, events);
    try {
      expect(sound.bank.sound("", false)).toBeNull();
      sound.initialize({ sampleRate: 0 });
      expect(sound.started).toBe(false);
      expect(common.sound.mixer).toBeNull();
      common.cvars.set("developer", "1", true);
      printed.length = 0;
      sound.update();
      expect(printed).toEqual(["not started or muted\n"]);
      common.cvars.set("developer", "0.5", true);
      printed.length = 0;
      sound.update();
      expect(printed).toEqual([]);
      common.cvars.set("developer", "0", true);
      expect(common.commands.registeredNames()).not.toContain("play");
      expect(sound.startLocalSound(null, -1)).toBe(false);
      expect(sound.startSound(null, { entity: -1, channel: -1, volume: -1, origin: { kind: "entity", entity: -1 } })).toBe(false);
      sound.updateLoopingSound(null, { entity: -1, origin: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, frameNumber: NaN });
      sound.updateRealLoopingSound(null, { entity: -1, origin: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } });
      sound.setListener(-1, { x: 0, y: 0, z: 0 }, [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }]);
      expect(() => sound.updateEntityPosition(-1, { x: 0, y: 0, z: 0 })).toThrow("entity");
      sound.updateEntityPosition(0, { x: 10, y: 20, z: 30 });
      sound.clearLoopingSounds(true);
      sound.stopLoopingSound(0);
      await sound.startBackgroundTrack("sound/feedback/hit.wav", "sound/feedback/hit.wav");
      expect(sound.music.isPlaying).toBe(true);
      sound.update();
      sound.stopAllSounds();
      expect(sound.music.isPlaying).toBe(true);
      sound.stopBackgroundTrack();
      expect(sound.music.isPlaying).toBe(false);
      expect(common.sound.mixer).toBeNull();
      expect(common.cvars.get("s_mixPreStep")?.value).toBe("0.05");
      common.cvars.set("s_initsound", "1");
      expect(() => sound.initialize({ sampleRate: 0 })).toThrow("sample rate");
      expect(common.commands.registeredNames()).toContain("play");
      expect(sound.started).toBe(false);

      sound.initialize({ sampleRate: 48000, bufferFrames: 256 });
      expect(sound.started).toBe(true);
      expect(sound.muted).toBe(true);
      common.cvars.set("developer", "1", true);
      printed.length = 0;
      sound.update();
      expect(printed).toEqual(["not started or muted\n"]);
      common.cvars.set("developer", "0", true);
      const mixer = sound.mixer;
      if (mixer === null) throw new Error("Missing actual started mixer");
      expect(common.sound.mixer).toBe(mixer);
      expect(mixer.playbackEnabled).toBe(false);
      await sound.beginRegistration();
      expect(await sound.bank.registerSound("sound/feedback/hit.wav", false)).toBeNull();
      const hit = sound.bank.resolveForPlayback(null);
      if (hit === null) throw new Error("Retail hit.wav did not load");
      common.sound.pause();
      common.cvars.set("s_show", "1", true);
      printed.length = 0;
      common.commands.append("play sound/misc/menu1 sound/misc/menu2\n");
      await common.commands.executeAsync();
      expect(printed.filter(line => line.includes(" : sound/"))).toEqual(["0 : sound/misc/menu1.wav\n", "0 : sound/misc/menu1.wav\n"]);
      expect(sound.bank.registeredSounds().map(entry => entry.name)).toContain("sound/misc/menu1.wav");
      expect(sound.bank.registeredSounds().map(entry => entry.name)).not.toContain("sound/misc/menu2.wav");
      sound.startSound(hit, { entity: 3, channel: 1, volume: 127, origin: { kind: "fixed", position: { x: 0, y: 100, z: 0 } } });
      sound.startSound(hit, { entity: 4, channel: 1, volume: 127, origin: { kind: "fixed", position: { x: 0, y: 2000, z: 0 } } });
      sound.updateRealLoopingSound(hit, { entity: 5, origin: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } });
      sound.setListener(0, { x: 0, y: 0, z: 0 }, [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }]);
      common.cvars.set("s_show", "2", true);
      const printSound = common.output.print.bind(common.output);
      common.output.print = text => {
        printSound(text);
        if (text.startsWith("----(")) common.cvars.set("s_testsound", "1", true);
      };
      printed.length = 0;
      const musicUpdate = sound.music.update.bind(sound.music);
      sound.music.update = () => { printed.push("music update"); musicUpdate(); };
      sound.update();
      expect(printed).toEqual([
        "124.000000 0.000000 sound/feedback/hit.wav\n",
        "127.000000 127.000000 sound/misc/menu1.wav\n",
        "----(2)---- painted: 0\n", "music update",
      ]);
      // Show precedes background work even when paused delivery makes the next scan skip.
      printed.length = 0;
      const clockBeforeUpdate = mixer.sampleClock;
      sound.update();
      expect(printed.at(-2)).toBe(`----(2)---- painted: ${clockBeforeUpdate}\n`);
      expect(printed.at(-1)).toBe("music update");
      sound.music.update = musicUpdate;
      common.output.print = printSound;
      expect(common.sound.queuedFrames).toBeGreaterThan(0);
      expect(common.sound.pendingOutput.samples.some(sample => sample !== 0)).toBe(true);
      const pending = common.sound.pendingOutput;
      const paintedOffset = (mixer.sampleClock - pending.startFrame) * 2;
      expect(Array.from(pending.samples.subarray(paintedOffset, paintedOffset + 8))).toEqual(Array.from({ length: 8 }, (_, index) =>
        Math.trunc(Math.sin((mixer.sampleClock + Math.floor(index / 2)) * 0.1) * 20000 * 256) >> 8));
      common.cvars.set("s_show", "0", true);
      common.cvars.set("s_testsound", "0", true);

      sound.disableSounds();
      expect(sound.muted).toBe(true);
      expect(common.sound.queuedFrames).toBe(0);
      expect(sound.startLocalSound(hit, -1)).toBe(false);
      sound.updateLoopingSound(hit, { entity: -1, origin: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, frameNumber: NaN });
      expect(mixer.rawEnd).toBe(0);
      expect(mixer.startLocalSound(hit, -1)).toBe(false);
      expect(sound.bank.sound("sound/misc/menu1.wav", false)).not.toBeNull();
      await sound.beginRegistration();
      common.commands.append("music sound/feedback/hit.wav\n");
      await common.commands.executeAsync();
      const music = sound.music;
      if (music === null) throw new Error("Missing actual background owner");
      expect(music.isPlaying).toBe(true);
      common.sound.resume();
      sound.update();
      common.sound.pause();
      expect(music.isPlaying).toBe(false);
      expect(mixer.rawEnd).toBeGreaterThan(0);
      common.commands.append("s_stop\nmusic sound/feedback/hit.wav sound/feedback/hit.wav\n");
      await common.commands.executeAsync();
      sound.update();
      expect(music.isPlaying).toBe(true);

      sound.shutdown();
      expect(common.sound.mixer).toBeNull();
      expect(music.isPlaying).toBe(true);
      expect(mixer.startLocalSound(hit, -1)).toBe(false);
      expect(sound.bank.sound("", false)).toBeNull();
      expect(common.commands.registeredNames()).not.toContain("play");
      expect(common.commands.registeredNames()).not.toContain("music");
      for (const name of ["s_info", "s_list", "s_stop"]) expect(common.commands.registeredNames()).toContain(name);
      common.commands.append("s_info\ns_list\ns_stop\n");
      await common.commands.executeAsync();
      expect(printed.join("")).toContain("sound system not started");
      expect(printed.join("")).toContain("bytes free sound buffer memory,");
      expect(music.isPlaying).toBe(true);

      const registeredBeforeRestart = sound.bank.registeredSounds().length;
      sound.initialize({ sampleRate: 48000, bufferFrames: 256 });
      expect(sound.music).toBe(music);
      expect(sound.mixer).not.toBe(mixer);
      expect(music.isPlaying).toBe(false);
      expect(sound.muted).toBe(true);
      await sound.bank.registerSound("sound/misc/menu1.wav", false);
      expect(sound.bank.registeredSounds().length).toBe(registeredBeforeRestart + 1);
      await sound.beginRegistration();
      common.sound.pause();
      const retailMixer = sound.mixer;
      if (retailMixer === null) throw new Error("Missing replacement SDL mixer");
      const files = common.files.current;
      const openMusic = files.openUniqueRead.bind(files), readMusic = files.readInto.bind(files);
      const openedMusic: string[] = [], musicReads: number[] = [];
      files.openUniqueRead = (path, selected) => { openedMusic.push(path); return openMusic(path, selected); };
      files.readInto = (file, bytes) => { musicReads.push(bytes.byteLength); return readMusic(file, bytes); };
      try {
        common.commands.append("music music/fla22k_01_intro.wav music/fla22k_01_loop.wav\n");
        await common.commands.executeAsync();
        expect(openedMusic).toEqual(["music/fla22k_01_intro.wav"]);
        expect(musicReads).toEqual([12, 4, 4, 2, 2, 4, 4, 2, 2, 4, 4]);
        let audible = false;
        for (let update = 0; update < 1000 && openedMusic.length < 2; update++) {
          music.update();
          const samples = retailMixer.mix(retailMixer.rawCapacity);
          audible ||= samples.some(sample => sample !== 0);
        }
        expect(openedMusic).toEqual(["music/fla22k_01_intro.wav", "music/fla22k_01_loop.wav"]);
        expect(Math.max(...musicReads)).toBe(30000);
        expect(audible).toBe(true);
        expect(music.isPlaying).toBe(true);
      } finally {
        files.openUniqueRead = openMusic;
        files.readInto = readMusic;
      }
      sound.close();
      expect(common.sound.mixer).toBeNull();
      for (const name of ["play", "music", "s_info", "s_list", "s_stop"]) expect(common.commands.registeredNames()).not.toContain(name);
      expect(() => sound.initialize({ sampleRate: 48000 })).toThrow("closed");
    } finally {
      try { sound.close(); } finally {
        try { common.close(); } finally { io.close(); await rm(homePath, { recursive: true, force: true }); }
      }
    }
  });
}
