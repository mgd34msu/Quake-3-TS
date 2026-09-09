/*
 * Sound runtime and console commands from id Software's code/client/snd_dma.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { PcmSound } from "../assets/wav.ts";
import type { CommonFileState } from "../assets/filesystem-state.ts";
import type { AudioMixer, StartSoundOptions, FrameLoopingSoundOptions, RealLoopingSoundOptions } from "../audio/mixer.ts";
import { BackgroundMusic } from "../audio/music.ts";
import { ClientSoundBank } from "../cgame/sound-bank.ts";
import type { RetainedFileBuffer, RetainedFileReader } from "../assets/read-file-memory.ts";
import { CvarFlag } from "../core/cvar.ts";
import { CommonError } from "../core/common-error.ts";
import type { CommandContext, ResolvedCommandHandler } from "../core/commands.ts";
import type { Axis, Vec3 } from "../core/math.ts";
import { SdlAudioUnavailableError } from "../platform/audio.ts";
import { CommonConsole } from "./common-console.ts";
import { CommonEvents } from "./common-events.ts";
import { SoundFrame } from "./sound-frame.ts";
import type { SoundOutputOptions } from "./sound-output.ts";

/** Reads the current common mount, including after a real filesystem restart. */
class SoundAssets implements RetainedFileReader {
  constructor(private readonly files: CommonFileState) {}
  readFileRetained(path: string): Promise<RetainedFileBuffer | undefined> { return this.files.current.readFileRetained(path); }
  readFileRetainedSync(path: string): RetainedFileBuffer | undefined { return this.files.current.readFileRetainedSync(path); }
  freeFile(buffer: RetainedFileBuffer): void {
    this.files.assertInitialized();
    this.files.fileMemory.freeFile(buffer);
  }
}

type SoundState =
  | { readonly kind: "idle" }
  | { readonly kind: "opening"; readonly mixer: AudioMixer }
  | { readonly kind: "started"; readonly mixer: AudioMixer; readonly frame: SoundFrame }
  | { readonly kind: "closed" };

/** Source startup/mute/registration ownership over common's real SDL output and decoded assets. */
export class EngineSound {
  readonly bank: ClientSoundBank;
  private readonly assets: SoundAssets;
  private state: SoundState = { kind: "idle" };
  private soundMuted = false;
  private readonly background: BackgroundMusic;
  private readonly ownedCommands = new Set<string>();

  constructor(private readonly common: CommonConsole, private readonly events: CommonEvents) {
    this.assets = new SoundAssets(common.files);
    const debugPrint = (text: string): undefined => {
      this.opened(); common.commands.assertCurrentExecution();
      const developer = common.cvars.get("developer");
      if (developer !== undefined && developer.integerValue !== 0) common.output.print(text);
      return undefined;
    };
    this.background = new BackgroundMusic(() => common.sound.mixer, () => common.files.current,
      text => { common.output.print(text); }, debugPrint);
    this.bank = new ClientSoundBank(this.assets, {
      print: text => { common.output.print(text); },
      debugPrint,
    }, { kind: "source-hunk", get accounting() { return common.hunk.accounting; } });
    this.bank.setRegistrationEnabled(false);
  }

  get started(): boolean { return this.state.kind === "started"; }
  get muted(): boolean { return this.soundMuted; }
  get mixer(): AudioMixer | null { return this.state.kind === "started" ? this.state.mixer : null; }
  get music(): BackgroundMusic { return this.background; }

  /** SDL rate/buffer selection is explicit; this backend does not use Linux OSS's sndspeed probing. */
  initialize(options: SoundOutputOptions): void {
    this.opened();
    if (this.state.kind !== "idle" || this.common.sound.mixer !== null) throw new Error("Sound runtime must shut down before initialization");
    this.common.output.print("\n------- sound initialization -------\n");
    const cvars = this.common.cvars;
    cvars.register("s_volume", "0.8", CvarFlag.Archive);
    cvars.register("s_musicvolume", "0.25", CvarFlag.Archive);
    cvars.register("s_separation", "0.5", CvarFlag.Archive);
    cvars.register("s_doppler", "1", CvarFlag.Archive);
    cvars.register("s_khz", "22", CvarFlag.Archive);
    cvars.register("s_mixahead", "0.2", CvarFlag.Archive);
    cvars.register("s_mixPreStep", "0.05", CvarFlag.Archive);
    cvars.register("s_show", "0", CvarFlag.Cheat);
    cvars.register("s_testsound", "0", CvarFlag.Cheat);
    if (cvars.register("s_initsound", "1").integerValue === 0) {
      this.common.output.print("not initializing.\n------------------------------------\n");
      return;
    }

    this.addCommand("play", { kind: "async", handler: context => this.play(context) });
    this.addCommand("music", { kind: "async", handler: context => this.musicCommand(context) });
    this.addCommand("s_list", { kind: "sync", handler: () => { this.soundList(); } });
    this.addCommand("s_info", { kind: "sync", handler: () => { this.soundInfo(); } });
    this.addCommand("s_stop", { kind: "sync", handler: () => { this.stopAllSounds(); } });

    let mixer: AudioMixer;
    try { mixer = this.common.sound.start(options, () => this.events.milliseconds()); }
    catch (error) {
      this.common.output.print("------------------------------------\n");
      if (error instanceof SdlAudioUnavailableError) {
        this.common.output.print(`${error.message}\n`);
        return;
      }
      throw error;
    }
    mixer.setPlaybackEnabled(false);
    mixer.bindSoundCvars(cvars);
    mixer.bindConsoleOutput(this.common.output);
    mixer.bindSoundMemory(this.bank);
    this.state = { kind: "opening", mixer };
    this.common.sound.resume();
    this.common.output.print("------------------------------------\n");
    this.opened();
    const frame = new SoundFrame(this.common.sound, this.background, this.events, cvars, () => { this.stopAllSounds(); });
    this.state = { kind: "started", mixer, frame };
    this.soundMuted = true;
    this.bank.setRegistrationEnabled(true);
    this.bank.resetLookup();
    this.stopAllSounds();
    this.soundInfo();
  }

  async beginRegistration(): Promise<void> {
    this.opened();
    this.soundMuted = false;
    if (this.state.kind === "started") this.state.mixer.setPlaybackEnabled(true);
    if (this.state.kind === "started" && !this.bank.memoryStarted) {
      const megs = this.common.cvars.register("com_soundMegs", "8", CvarFlag.Latch | CvarFlag.Archive);
      this.bank.initializeMemory({
        chunkCount: Math.imul(megs.integerValue, 1536),
        sampleRate: () => {
          const mixer = this.common.sound.mixer;
          if (mixer === null) throw new Error("Sound output ended before sound allocation");
          return mixer.outputRate;
        },
        milliseconds: () => this.events.milliseconds(),
      });
    }
    await this.bank.beginRegistration();
  }

  disableSounds(): void {
    this.stopAllSounds();
    this.soundMuted = true;
    if (this.state.kind === "started") this.state.mixer.setPlaybackEnabled(false);
  }

  stopAllSounds(): void {
    if (this.state.kind !== "started") return;
    this.background.stop();
    this.common.sound.clearSoundBuffer();
  }

  startLocalSound(sound: PcmSound | null, channel: number): boolean {
    if (this.state.kind !== "started" || this.soundMuted) return false;
    const pcm = this.bank.resolveForPlayback(sound);
    return pcm !== null && this.state.mixer.startLocalSound(pcm, channel, this.soundName(pcm));
  }

  startSound(sound: PcmSound | null, options: StartSoundOptions): boolean {
    if (this.state.kind !== "started" || this.soundMuted) return false;
    const pcm = this.bank.resolveForPlayback(sound);
    return pcm !== null && this.state.mixer.startSound(pcm, options, this.soundName(pcm));
  }

  updateLoopingSound(sound: PcmSound | null, options: FrameLoopingSoundOptions): void {
    if (this.state.kind !== "started" || this.soundMuted) return;
    const pcm = this.resolveLoopingSound(sound);
    if (pcm !== null) this.state.mixer.updateLoopingSound(pcm, options);
  }

  updateRealLoopingSound(sound: PcmSound | null, options: RealLoopingSoundOptions): void {
    if (this.state.kind !== "started" || this.soundMuted) return;
    const pcm = this.resolveLoopingSound(sound);
    if (pcm !== null) this.state.mixer.updateRealLoopingSound(pcm, options);
  }

  private resolveLoopingSound(sound: PcmSound | null): PcmSound | null {
    const pcm = this.bank.resolveForPlayback(sound);
    if (pcm !== null && this.bank.frameCount(pcm) === 0) {
      const name = this.soundName(pcm);
      if (name === null) throw new Error("Loop sound requires a registered sound name");
      throw new CommonError("drop", `${name} has length 0`);
    }
    return pcm;
  }

  clearLoopingSounds(killAll: boolean): void {
    if (this.state.kind === "started") this.state.mixer.clearLoopingSounds(killAll);
  }

  stopLoopingSound(entity: number): void {
    this.requireEntity(entity);
    if (this.state.kind === "started") this.state.mixer.stopLoopingSound(entity);
  }

  updateEntityPosition(entity: number, origin: Vec3): void {
    this.requireEntity(entity);
    // S_Init clears every loopSounds cell before enabling playback. Positions
    // written without output cannot survive that reset or reach a sound reader.
    if (this.state.kind === "started") this.state.mixer.updateEntityPosition(entity, origin);
  }

  setListener(entity: number, origin: Vec3, axis: Axis): void {
    if (this.state.kind !== "started" || this.soundMuted) return;
    this.state.mixer.setListener(entity, origin, axis);
  }

  async startBackgroundTrack(intro: string | null, loop: string | null): Promise<void> {
    this.background.start(intro, loop);
  }

  stopBackgroundTrack(): void { this.background.stop(); }

  update(): void {
    if (this.state.kind === "closed") return;
    if (this.state.kind !== "started" || !this.state.mixer.playbackEnabled) {
      const developer = this.common.cvars.get("developer");
      if (developer !== undefined && developer.integerValue !== 0) this.common.output.print("not started or muted\n");
      return;
    }
    const state = this.state;
    if (this.setting("s_show") === 2) {
      let total = 0;
      for (const channel of state.mixer.channelVolumes()) {
        const name = this.soundName(channel.sound);
        if (name === null) throw new Error("Channel diagnostics require a registered sound name");
        // Native S_Update passes int volumes to %f through vsnprintf: undefined
        // varargs, not portable output bytes. Print the intended numeric values
        // with the format's six decimals as a deliberate defined correction.
        this.common.output.print(`${channel.left.toFixed(6)} ${channel.right.toFixed(6)} ${name}\n`);
        this.common.commands.assertCurrentExecution();
        if (this.state !== state || this.common.sound.mixer !== state.mixer) throw new Error("Sound output lifetime ended during channel diagnostics");
        total++;
      }
      this.common.output.print(`----(${total})---- painted: ${state.mixer.sampleClock}\n`);
      this.common.commands.assertCurrentExecution();
      if (this.state !== state || this.common.sound.mixer !== state.mixer) throw new Error("Sound output lifetime ended during channel diagnostics");
    }
    state.frame.update();
  }

  private soundName(sound: PcmSound): string | null {
    return this.bank.nameForSound(sound);
  }

  shutdown(): void {
    if (this.state.kind !== "started") return;
    if (this.common.sound.mixer !== this.state.mixer) throw new Error("Sound output lifetime has changed");
    this.common.sound.shutdown();
    this.bank.setRegistrationEnabled(false);
    this.state = { kind: "idle" };
    // Preserve the original mismatches: s_stop/s_list/s_info survive S_Shutdown.
    for (const name of ["play", "music", "stopsound", "soundlist", "soundinfo"]) {
      this.common.commands.unregister(name);
      this.ownedCommands.delete(name);
    }
  }

  /** Final disposal releases partial startup and residual commands without replaying source shutdown. */
  close(): void {
    if (this.state.kind === "closed") return;
    const previous = this.state;
    this.state = { kind: "closed" };
    this.bank.setRegistrationEnabled(false);
    if (previous.kind === "started" || previous.kind === "opening") previous.mixer.setPlaybackEnabled(false);
    const errors: unknown[] = [];
    this.background.retire();
    if ((previous.kind === "started" || previous.kind === "opening") && this.common.sound.mixer === previous.mixer) {
      try { this.common.sound.shutdown(); } catch (error) { errors.push(error); }
    }
    for (const name of this.ownedCommands) {
      try { this.common.commands.unregister(name); } catch (error) { errors.push(error); }
    }
    this.ownedCommands.clear();
    if (errors.length !== 0) throw new AggregateError(errors, "Sound runtime disposal failed");
  }

  private addCommand(name: string, command: ResolvedCommandHandler): void {
    if (this.common.commands.registeredNames().includes(name)) {
      this.common.output.print(`Cmd_AddCommand: ${name} already defined\n`);
      return;
    }
    if (command.kind === "async") this.common.commands.registerAsync(name, command.handler);
    else if (command.kind === "calls") this.common.commands.registerCalls(name, command.handler);
    else this.common.commands.register(name, command.handler);
    this.ownedCommands.add(name);
  }

  private async play(context: CommandContext): Promise<void> {
    for (const argument of context.argv.slice(1)) {
      const first = context.argv[1];
      if (first === undefined) throw new Error("Missing first play argument");
      const name = (argument.includes(".") ? argument : `${first}.wav`).slice(0, 255);
      const sound = await this.bank.registerSound(name, false);
      context.assertActive();
      if (sound !== null) this.startLocalSound(sound, 6);
    }
  }

  private async musicCommand(context: CommandContext): Promise<void> {
    const intro = context.argv[1];
    if ((context.argv.length !== 2 && context.argv.length !== 3) || intro === undefined) {
      this.common.output.print("music <musicfile> [loopfile]\n");
      return;
    }
    const music = this.background;
    const loop = context.argv[2];
    music.start(intro, loop ?? intro);
    if (loop === undefined) music.clearLoop();
    context.assertActive();
  }

  private soundInfo(): void {
    this.common.output.print("----- Sound Info -----\n");
    if (this.state.kind !== "started") this.common.output.print("sound system not started\n");
    else {
      if (this.soundMuted) this.common.output.print("sound system is muted\n");
      this.common.output.print(`SDL2 queued S16 stereo: ${this.state.mixer.outputRate} Hz, ${this.common.sound.queuedFrames} queued frames\n`);
      this.common.output.print("SDL queued output replaces the DMA buffer; no DMA address or native page allocator.\n");
      this.common.output.print(this.background.isPlaying ? `Background file: ${this.background.loopName}\n` : "No background file.\n");
    }
    this.common.output.print("----------------------\n");
  }

  private soundList(): void {
    if (this.bank.memoryStarted) {
      let total = 0;
      for (const entry of this.bank.registeredSounds()) {
        total = (total + entry.soundLength) | 0;
        this.common.output.print(`${entry.soundLength.toString().padStart(6)}[16bit] : ${entry.name}[${entry.inMemory ? "resident " : "paged out"}]\n`);
      }
      this.common.output.print(`Total resident: ${total}\n`);
      const memory = this.bank.memoryUsage();
      if (memory === null) throw new Error("Source sound memory ended during sound listing");
      this.common.output.print(`${memory.freeBytes} bytes free sound buffer memory, ${memory.totalAllocatedBytes} total used\n`);
      return;
    }
    let bytes = 0;
    for (const entry of this.bank.registeredSounds()) {
      if (entry.sound === null) this.common.output.print(`unavailable : ${entry.name}\n`);
      else {
        bytes += entry.sound.samples.byteLength;
        this.common.output.print(`${entry.sound.frameCount} decoded PCM frames at ${entry.sound.sampleRate} Hz : ${entry.name}\n`);
      }
    }
    this.common.output.print(`Decoded PCM storage: ${bytes} bytes. Native sound-page metrics are not applicable.\n`);
  }

  private setting(name: string): number {
    const cvar = this.common.cvars.get(name);
    if (cvar === undefined) throw new Error(`Missing sound cvar ${name}`);
    return cvar.integerValue;
  }

  private requireEntity(entity: number): void {
    if (!Number.isSafeInteger(entity) || entity < 0 || entity >= 1024) throw new RangeError("entity must be an integer from 0 through 1023");
  }

  private opened(): void { if (this.state.kind === "closed") throw new Error("Sound runtime is closed"); }
}
