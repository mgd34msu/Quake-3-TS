import { withRetainedFiles } from "./retained-file-fixture.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioMixer } from "../src/audio/mixer.ts";
import { decodeWav } from "../src/assets/wav.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import { CommonError } from "../src/core/common-error.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { EngineSound } from "../src/engine/sound.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { qvmSoundSyscall } from "../src/vm/sound-syscalls.ts";
import type { QvmSoundServices } from "../src/vm/sound-syscalls.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function wav(channels = 1): Uint8Array {
  const bytes = new Uint8Array(44 + 8 * channels), view = new DataView(bytes.buffer);
  for (const [offset, text] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] satisfies readonly (readonly [number, string])[]) {
    for (let index = 0; index < text.length; index++) bytes[offset + index] = text.charCodeAt(index);
  }
  view.setUint32(4, bytes.length - 8, true); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, 22050, true); view.setUint32(28, 44100 * channels, true);
  view.setUint16(32, 2 * channels, true); view.setUint16(34, 16, true);
  view.setUint32(40, bytes.length - 44, true);
  for (let offset = 44; offset < bytes.length; offset += 2) view.setInt16(offset, 256, true);
  return bytes;
}

function words(...values: number[]): DataView {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return view;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quake3-qvm-sound-")), game = join(root, "data/baseq3");
  cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(game, "sound/feedback"), { recursive: true });
  writeFileSync(join(game, "default.cfg"), "set authored_sound_fixture 1\n");
  writeFileSync(join(game, "productid.txt"), SOURCE_PRODUCT_ID);
  for (const name of ["sound/feedback/hit.wav", "one.wav", "two.wav", "three.wav"]) writeFileSync(join(game, name), wav());
  writeFileSync(join(game, "music.wav"), wav(2));
  const printed: string[] = [], callbacks: { onPrint(text: string): void } = { onPrint: () => undefined };
  const common = await CommonConsole.open({
    roots: { dataPath: join(root, "data"), homePath: join(root, "home"), cdPath: null, product: "baseq3" },
    startup: new StartupCommands(""), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
    platformPrint: text => { printed.push(text); callbacks.onPrint(text); }, resolveCommand: () => undefined,
    assertCommandEntry: () => undefined, assertOwnerEntry: () => undefined,
  }, () => undefined);
  cleanup.push(() => { common.close(); });
  common.registerRuntimeCvars("authored-sound-adapter", async () => undefined);
  const engine = new EngineSound(common, new CommonEvents({ getEvent: () => ({ kind: "none", time: 0 }) }, () => undefined));
  cleanup.push(() => { engine.close(); });
  const bank = engine.bank, mixer = new AudioMixer(22050, () => 100);
  mixer.setEffectsVolume(1);
  // This authored adapter supplies a pure mixer; EngineSound is never initialized.
  const sound: QvmSoundServices["sound"] = {
    bank, started: true, muted: false,
    startLocalSound: (pcm, channel) => {
      const resolved = bank.resolveForPlayback(pcm);
      return resolved !== null && mixer.startLocalSound(resolved, channel, bank.nameForSound(resolved));
    },
    startSound: (pcm, options) => {
      const resolved = bank.resolveForPlayback(pcm);
      return resolved !== null && mixer.startSound(resolved, options, bank.nameForSound(resolved));
    },
    updateLoopingSound: (pcm, options) => { const resolved = bank.resolveForPlayback(pcm); if (resolved !== null) mixer.updateLoopingSound(resolved, options); },
    updateRealLoopingSound: (pcm, options) => { const resolved = bank.resolveForPlayback(pcm); if (resolved !== null) mixer.updateRealLoopingSound(resolved, options); },
    clearLoopingSounds: kill => { mixer.clearLoopingSounds(kill); },
    stopLoopingSound: entity => { mixer.stopLoopingSound(entity); },
    updateEntityPosition: (entity, origin) => { mixer.updateEntityPosition(entity, origin); },
    setListener: (entity, origin, axis) => { mixer.setListener(entity, origin, axis); },
    startBackgroundTrack: (intro, loop) => engine.startBackgroundTrack(intro, loop),
    stopBackgroundTrack: () => { engine.stopBackgroundTrack(); },
  };
  const memory = new QvmMemory(new Uint8Array(1024));
  const services: QvmSoundServices = { sound, frameNumber: () => 17 };
  const call = (role: "game" | "cgame" | "ui", ...args: number[]) => qvmSoundSyscall(role, words(...args), memory, services);
  function vector(pointer: number, x: number, y: number, z: number): void {
    const view = memory.view(pointer, 12);
    view.setFloat32(0, x, true); view.setFloat32(4, y, true); view.setFloat32(8, z, true);
  }
  bank.setRegistrationEnabled(true);
  await bank.beginRegistration();
  memory.writeString(32, "one.wav", 32);
  vector(128, 0, 0, 0); vector(144, 0, 0, 0);
  vector(192, 1, 0, 0); vector(204, 0, 1, 0); vector(216, 0, 0, 1);
  printed.length = 0;
  return { bank, mixer, engine, common, game, sound, memory, services, call, vector, printed, callbacks };
}

test("UI and cgame registrations share actual slots, failed rows and retained lookup lifetimes", async () => {
  const f = await fixture(), typed = f.bank.sound("two.wav", false);
  expect(f.bank.indexForSound(typed)).toBe(1);
  expect(await f.call("cgame", 34, 32, 1)).toBe(2);
  expect(await f.call("ui", 31, 32, 0)).toBe(2);
  const first = f.bank.soundForIndex(2);
  if (first === undefined) throw new Error("Missing registered sound slot");
  expect(first).toBe(f.bank.sound("ONE.WAV", false));
  expect(f.bank.soundForIndex(0)).toBeNull();
  expect(f.bank.indexForSound(f.bank.resolveForPlayback(null))).toBe(0);
  f.memory.writeString(32, "missing.wav", 32);
  expect(await f.call("ui", 31, 32, 0)).toBe(0);
  expect(() => f.bank.soundForIndex(3)).toThrow("no decoded PCM");
  f.bank.resetLookup();
  await f.bank.beginRegistration();
  f.memory.writeString(32, "one.wav", 32);
  expect(await f.call("cgame", 34, 32, 0)).toBe(4);
  expect(f.bank.soundForIndex(2)).toBe(first);
  expect(f.bank.indexForSound(first)).toBe(2);
  expect(f.bank.soundForIndex(4)).not.toBe(first);
  f.printed.length = 0;
  for (const index of [-1, 5, 4096]) expect(f.bank.soundForIndex(index)).toBeUndefined();
  expect(f.printed).toEqual(["^3", "^3", "^3"]);
  expect(() => f.bank.soundForIndex(0.5)).toThrow("must be an integer");
  expect(() => f.bank.indexForSound(decodeWav(wav()))).toThrow("does not belong");
});

test("sticky default registrations remain zero while raw retained slots expose recovered PCM", async () => {
  const f = await fixture();
  f.memory.writeString(32, "missing.wav", 32);
  expect(await f.call("cgame", 34, 32, 0)).toBe(0);
  writeFileSync(join(f.game, "missing.wav"), wav());
  expect(await f.call("cgame", 34, 32, 0)).toBe(0);
  const recovered = f.bank.soundForIndex(1);
  if (recovered === undefined) throw new Error("Missing recovered sound slot");
  expect(recovered?.samples).toEqual(new Int16Array([256, 256, 256, 256]));
  expect(f.bank.indexForSound(recovered)).toBe(1);
  f.bank.setRegistrationEnabled(false);
  expect(await f.call("cgame", 34, 32, 0)).toBe(0);
  expect(f.bank.soundForIndex(1)).toBe(recovered);
});

test("registration copies VM arguments before its awaited read and rejects a retired bank lifetime", async () => {
  const f = await fixture();
  const callWords = words(34, 32, 1);
  const first = qvmSoundSyscall("cgame", callWords, f.memory, f.services);
  f.memory.writeString(32, "two.wav", 32); callWords.setInt32(4, 0, true);
  expect(await first).toBe(1);
  const pcm = f.bank.soundForIndex(1);
  if (pcm === null || pcm === undefined) throw new Error("Missing PCM");
  expect(f.bank.nameForSound(pcm)).toBe("one.wav");
  const second = f.call("cgame", 34, 32, 0);
  f.bank.setRegistrationEnabled(false);
  await expect(second).rejects.toThrow("Sound registration lifetime ended");
  expect(() => f.bank.soundForIndex(2)).toThrow("no decoded PCM");
});

test("nonresident registered slots reload through actual local, start and looping traps", async () => {
  for (const trap of [29, 28, 31, 80]) {
    const f = await fixture();
    writeFileSync(join(f.game, "one.wav"), new Uint8Array(1));
    await expect(Promise.resolve(f.call("cgame", 34, 32, 0))).rejects.toThrow("truncated");
    expect(f.bank.registeredSounds()).toHaveLength(2);
    const muted: QvmSoundServices = { ...f.services, sound: { ...f.sound, muted: true } };
    expect(qvmSoundSyscall("cgame", words(trap), f.memory, muted)).toBe(0);
    expect(() => f.call("cgame", 28, 0, -1, 2, 1)).toThrow("S_StartSound: bad entitynum -1");
    writeFileSync(join(f.game, "one.wav"), wav());
    f.vector(128, 0, 40, 0);
    if (trap === 29) expect(f.call("cgame", trap, 1, 2)).toBe(0);
    else if (trap === 28) expect(f.call("cgame", trap, 128, 2, 3, 1)).toBe(0);
    else expect(f.call("cgame", trap, 2, 128, 144, 1)).toBe(0);
    if (trap !== 29) expect(f.call("cgame", 33, 0, 144, 192, 0)).toBe(0);
    const pcm = f.bank.soundForIndex(1);
    if (pcm === null || pcm === undefined) throw new Error("Playback must load the retained source slot");
    expect(f.bank.indexForSound(pcm)).toBe(1);
    expect(f.bank.nameForSound(pcm)).toBe("one.wav");
    expect(f.bank.registeredSounds()).toHaveLength(2);
    expect(f.printed).toEqual([]);
    expect(f.mixer.mix(1)).toEqual(new Int16Array(trap === 29 ? [126, 126] : trap === 80 ? [89, 0] : [126, 0]));
    expect(f.engine.started).toBe(false);
    expect(f.common.sound.mixer).toBeNull();
  }
});

test("local zero playback and fixed or entity origins reach actual PCM and spatialized channels", async () => {
  const f = await fixture();
  expect(f.call("ui", 32, 0, 2)).toBe(0);
  expect(f.mixer.mix(1)).toEqual(new Int16Array([126, 126]));
  const zero = f.bank.resolveForPlayback(null);
  if (zero === null) throw new Error("Missing sound zero");
  expect(Array.from(f.mixer.channelVolumes())[0]?.sound).toBe(zero);
  f.mixer.clearSoundBuffer();
  const index = await f.call("cgame", 34, 32, 0);
  if (typeof index !== "number") throw new Error("Missing registered index");
  f.vector(128, 0, 40, 0);
  expect(f.call("cgame", 28, 128, 2, 3, index)).toBe(0);
  f.vector(128, 0, -40, 0);
  expect(f.call("cgame", 33, 0, 144, 192, 123)).toBe(0);
  expect(f.mixer.mix(1)).toEqual(new Int16Array([126, 0]));
  f.mixer.clearSoundBuffer();
  expect(f.call("cgame", 32, 2, 128)).toBe(0);
  expect(f.call("cgame", 28, 0, 2, 3, index)).toBe(0);
  expect(f.call("cgame", 33, 0, 144, 192, 0)).toBe(0);
  expect(f.mixer.mix(1)).toEqual(new Int16Array([0, 126]));
});

test("frame and real loops use source clear and stop lifetimes with copied inputs before owner callbacks", async () => {
  const f = await fixture();
  const index = await f.call("cgame", 34, 32, 0);
  if (typeof index !== "number") throw new Error("Missing registered index");
  f.vector(128, 0, 40, 0);
  let frames = 0;
  f.services.frameNumber = () => { frames++; f.vector(128, 0, -40, 0); f.vector(144, 10000, 0, 0); return 19; };
  expect(f.call("cgame", 31, 2, 128, 144, index)).toBe(0);
  expect(frames).toBe(1);
  f.vector(160, 0, 0, 0);
  expect(f.call("cgame", 33, 0, 160, 192, 0)).toBe(0);
  expect(f.mixer.mix(1)).toEqual(new Int16Array([126, 0]));
  expect(f.call("cgame", 30, 0)).toBe(0);
  expect(f.mixer.mix(1)).toEqual(new Int16Array([0, 0]));
  expect(f.call("cgame", 80, 3, 128, 144, index)).toBe(0);
  expect(frames).toBe(1);
  expect(f.call("cgame", 30, 0)).toBe(0);
  expect(f.call("cgame", 33, 0, 160, 192, 0)).toBe(0);
  expect(f.mixer.mix(1)).toEqual(new Int16Array([0, 89]));
  expect(f.call("cgame", 81, 3)).toBe(0);
  expect(f.call("cgame", 33, 0, 160, 192, 0)).toBe(0);
  expect(f.mixer.mix(1)).toEqual(new Int16Array([0, 0]));
  f.call("cgame", 80, 3, 128, 144, index);
  f.call("cgame", 30, -1);
  expect(f.mixer.mix(1)).toEqual(new Int16Array([0, 0]));
});

test("UI and cgame music use the actual retained owner and nullable source strings", async () => {
  const f = await fixture();
  f.memory.writeString(32, "music.wav", 32); f.memory.writeString(64, "loop.wav", 32);
  expect(await f.call("ui", 63, 32, 64)).toBe(0);
  expect(f.engine.music.isPlaying).toBe(true); expect(f.engine.music.loopName).toBe("loop.wav");
  expect(await f.call("cgame", 35, 0, 0)).toBe(0);
  expect(f.engine.music.isPlaying).toBe(true);
  expect(f.call("cgame", 69)).toBe(0); expect(f.engine.music.isPlaying).toBe(false);
  expect(await f.call("cgame", 35, 32, 0)).toBe(0);
  expect(f.engine.music.loopName).toBe("music.wav");
  expect(f.call("ui", 62)).toBe(0); expect(f.engine.music.isPlaying).toBe(false);
  expect(f.common.sound.mixer).toBeNull(); expect(f.engine.started).toBe(false);
});

test("disabled actual EngineSound and muted playback return before pointer and index reads", async () => {
  const f = await fixture(), services: QvmSoundServices = { sound: f.engine, frameNumber: () => { throw new Error("Must not sample frame"); } };
  f.bank.setRegistrationEnabled(false);
  for (const [role, trap] of [["ui", 31], ["ui", 32], ["cgame", 28], ["cgame", 29], ["cgame", 31], ["cgame", 33], ["cgame", 34], ["cgame", 80]] satisfies readonly (readonly ["ui" | "cgame", number])[]) {
    expect(qvmSoundSyscall(role, words(trap), f.memory, services)).toBe(0);
  }
  expect(() => qvmSoundSyscall("cgame", words(32, 1024, 128), f.memory, services)).toThrow("entity must");
  expect(f.engine.started).toBe(false); expect(f.common.sound.mixer).toBeNull();
  const muted: QvmSoundServices = { sound: { ...f.sound, muted: true }, frameNumber: services.frameNumber };
  for (const trap of [28, 29, 31, 33, 80]) expect(qvmSoundSyscall("cgame", words(trap), f.memory, muted)).toBe(0);
});

test("unknown role traps, null required pointers and truncated vectors never publish playback", async () => {
  const f = await fixture();
  expect(f.call("game", 28)).toBeNull(); expect(f.call("ui", 28)).toBeNull(); expect(f.call("cgame", 99)).toBeNull();
  expect(() => f.call("cgame", 34, 0, 0)).toThrow("nonnull");
  expect(() => f.call("cgame", 31, 2, 0, 144, 0)).toThrow("nonnull");
  expect(() => f.call("cgame", 80, 2, 128, 1016, 0)).toThrow("exceeds");
  expect(() => f.call("cgame", 33, 0, 128, 1000, 0)).toThrow("exceeds");
  expect(f.call("ui", 32, -1, 2)).toBe(0);
  expect(f.call("cgame", 28, 0, 2, 3, 4096)).toBe(0);
  expect(f.printed).toEqual(["^3", "^3"]);
  expect(f.mixer.mix(1)).toEqual(new Int16Array([0, 0]));
});

test("invalid source handles print only the source color format before touching pointed data or playback", async () => {
  const f = await fixture();
  f.services.frameNumber = () => { throw new Error("Invalid handle must not read frame clock"); };
  const calls: readonly (readonly ["cgame" | "ui", readonly number[]])[] = [
    ["ui", [32, -1, 2]], ["cgame", [29, 1, 2]],
    ["cgame", [28, 1016, -1, 2, -1]], ["cgame", [28, 0, 1024, 2, 1]],
    ["cgame", [31, -1, 0, 1016, 1]], ["cgame", [80, 2048, 1016, 0, -1]],
  ];
  f.callbacks.onPrint = text => {
    expect(text).toBe("^3");
    expect(Array.from(f.mixer.channelVolumes())).toEqual([]);
    f.memory.bytes.fill(0xff);
  };
  for (const [role, args] of calls) expect(f.call(role, ...args)).toBe(0);
  expect(f.printed).toEqual(["^3", "^3", "^3", "^3", "^3", "^3"]);
  expect(f.mixer.mix(1)).toEqual(new Int16Array([0, 0]));
  const callbackFailure = new Error("Authored print abort");
  f.callbacks.onPrint = () => { throw callbackFailure; };
  expect(() => f.call("cgame", 31, -1, 0, 0, -1)).toThrow(callbackFailure);
});

test("null-origin entity errors precede invalid-handle diagnostics and disabled or muted calls skip both", async () => {
  const f = await fixture();
  for (const entity of [-1, 1025]) {
    try { f.call("cgame", 28, 0, entity, 2, -1); throw new Error("Expected entity drop"); }
    catch (error) {
      if (!(error instanceof CommonError)) throw error;
      expect(error.code).toBe("drop"); expect(error.message).toBe(`S_StartSound: bad entitynum ${entity}`);
    }
  }
  expect(f.printed).toEqual([]);
  for (const sound of [f.engine, { ...f.sound, muted: true }]) {
    const services: QvmSoundServices = { sound, frameNumber: () => { throw new Error("Unexpected frame read"); } };
    for (const args of [[28, 0, -1, 2, -1], [29, -1, 2], [31, -1, 0, 0, -1], [80, -1, 0, 0, -1]]) {
      expect(qvmSoundSyscall("cgame", words(...args), f.memory, services)).toBe(0);
    }
  }
  expect(f.printed).toEqual([]);
});

test("numeric zero is invalid until the actual source slot is reserved", async () => {
  const printed: string[] = [];
  const bank = new ClientSoundBank(withRetainedFiles({ readFileOptional: async () => wav(), readFileOptionalSync: () => wav() }), {
    print: text => { printed.push(text); }, debugPrint: () => undefined,
  });
  expect(bank.soundForIndex(0)).toBeUndefined(); expect(printed).toEqual(["^3"]);
  await bank.beginRegistration();
  expect(bank.soundForIndex(0)).toBeNull(); expect(printed).toEqual(["^3"]);
});
