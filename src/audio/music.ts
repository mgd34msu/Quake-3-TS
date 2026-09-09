/*
 * Background music from id Software's code/client/snd_dma.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { VirtualFileSystem } from "../assets/vfs.ts";
import type { AudioMixer } from "./mixer.ts";
import { MusicStream } from "./music-stream.ts";

function musicName(name: string): string {
  const end = name.indexOf("\0");
  return end < 0 ? name : name.slice(0, end);
}

function musicPath(intro: string): string {
  const truncated = intro.slice(0, 59);
  // COM_DefaultExtension does not inspect the first character or backslashes.
  for (let index = truncated.length - 1; index > 0 && truncated[index] !== "/"; index--) {
    if (truncated[index] === ".") return truncated;
  }
  return `${truncated}.wav`;
}

/** Retains the common FS handle. Unix's Sys_StreamedRead is a direct FS_Read. */
export class BackgroundMusic {
  private lifetime: "active" | "retired" = "active";
  private stream: MusicStream | null = null;
  private backgroundLoop = "";
  private targetVolume = Math.fround(0.25);
  private smoothedVolume = Math.fround(0.5);

  constructor(
    private readonly readMixer: () => AudioMixer | null,
    private readonly readFiles: () => VirtualFileSystem,
    private readonly print: (text: string) => void,
    private readonly debugPrint: (text: string) => void = () => undefined,
  ) {}

  get mixer(): AudioMixer | null { return this.lifetime === "retired" ? null : this.readMixer(); }
  get loopName(): string { return this.backgroundLoop; }
  get isPlaying(): boolean { return this.stream !== null && this.stream.isOpen; }
  get effectiveVolume(): number { return this.smoothedVolume; }

  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) throw new RangeError("music volume must be finite");
    this.targetVolume = Math.fround(volume);
  }

  start(intro: string | null, loop: string | null = null): void {
    this.requireActive();
    if (intro === null) intro = "";
    const requestedLoop = loop === null || loop.length === 0 || loop[0] === "\0" ? intro : loop;
    const introName = musicName(intro), loopName = musicName(requestedLoop);
    this.debugPrint(`S_StartBackgroundTrack( ${introName}, ${loopName} )\n`);
    this.requireActive();
    if (introName.length === 0) return;
    this.backgroundLoop = loopName.slice(0, 63);
    this.stream?.close();
    this.stream = null;
    // FS_FOpenFileRead publishes the selected slot before its own diagnostics.
    const opened = MusicStream.open(this.readFiles, musicPath(introName), this.print, stream => { this.stream = stream; });
    this.requireActive();
    this.stream = opened;
    this.stream?.readHeader(this.print);
    if (this.stream !== null && !this.stream.isOpen) this.stream = null;
  }

  /** S_Music_f clears the loop after its one-argument S_StartBackgroundTrack. */
  clearLoop(): void { this.backgroundLoop = ""; }

  stop(): void {
    if (this.stream === null || !this.stream.isOpen) return;
    this.stream.close();
    this.stream = null;
    this.readMixer()?.stopRaw();
  }

  /** Final disposal drops borrows without source callbacks. Common owns the
   * actual handles and may have already closed them during FS_Shutdown. */
  retire(): void {
    this.lifetime = "retired";
    this.stream = null;
  }

  private requireActive(): void {
    if (this.lifetime === "retired") throw new Error("Background music is retired");
  }

  update(): void {
    if (this.lifetime === "retired") return;
    const mixer = this.readMixer();
    if (mixer === null || !mixer.playbackEnabled || this.stream === null || !this.stream.isOpen) return;
    this.smoothedVolume = Math.fround(Math.fround(this.smoothedVolume + Math.fround(this.targetVolume * 2)) / 4);
    if (this.smoothedVolume <= 0) return;
    if (mixer.rawEnd < mixer.soundClock) mixer.resetRawToSoundTime();
    while (this.stream !== null) {
      // Reopen at the source end-of-chunk position, even when the ring is full.
      if (this.stream.remainingFrames === 0) {
        if (this.backgroundLoop.length === 0) {
          // The one-shot source drops this handle without FS_FCloseFile. The
          // common handle table retains it until filesystem disposal.
          this.stream = null;
          return;
        }
        this.stream.close();
        this.stream = null;
        this.start(this.backgroundLoop, this.backgroundLoop);
        if (this.stream === null) return;
      }

      const available = mixer.rawCapacity - (mixer.rawEnd - mixer.soundClock);
      if (available <= 0) return;
      const requested = Math.trunc(Math.imul(available, this.stream.sampleRate) / mixer.outputRate);
      // The original spins when its integer request is zero. Retain the
      // bounded one-frame accommodation.
      const sound = this.stream.readChunk(requested === 0 ? 1 : requested);
      if (sound === null) {
        this.print("StreamedRead failure on music track\n");
        this.stop();
        return;
      }
      mixer.queueRaw(sound, this.smoothedVolume);
    }
  }
}
