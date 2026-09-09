// Port of id Software code/client/cl_cin.c: the engine-wide cinematic state.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import type { AssetReader } from "../assets/reader.ts";
import type { VirtualFileSystem } from "../assets/vfs.ts";
import type { AudioMixer } from "../audio/mixer.ts";
import { RoqPlayback, type RoqPlaybackOptions } from "../cinematic/playback.ts";
import { RoqDecoderScratch } from "../cinematic/roq.ts";
import { RoqStream } from "../cinematic/roq-stream.ts";
import { BinaryError } from "../core/binary.ts";
import { CommonError } from "../core/common-error.ts";
import type { HunkArena } from "../core/hunk.ts";
import type { PreparedUiRawCall, ShaderCinematicCall, ShaderCinematicRegistry } from "../render/cinematic-command.ts";
import type { Draw2D } from "../render/draw2d.ts";
import { RgbaSnapshot, type RendererImage } from "../render/image-resource.ts";
import type { UiRect } from "../ui/menu.ts";
import type { UiCinematicAsset } from "../ui/runtime.ts";
import type { EngineSound } from "./sound.ts";

export interface EngineCinematicClock { sample(): number }
export type CinematicConsole = { readonly kind: "absent" } | { readonly kind: "available"; close(): undefined };
export interface EngineCinematicSettings {
  inGameVideo(): number;
  readonly hardware: "generic" | "ragepro";
  readonly maxTextureSize: number;
}
export interface NonSystemCinematicOptions {
  readonly looping: boolean;
  readonly holdAtEnd: boolean;
  readonly silent: boolean;
  readonly shader: boolean;
}
export interface EngineCinematicOptions {
  readonly temporaryMemory: HunkArena;
  readonly files: { readonly kind: "retained"; current(): VirtualFileSystem }
    | { readonly kind: "diagnostic-bytes"; readonly reader: AssetReader };
  readonly sound: { readonly kind: "engine"; readonly owner: EngineSound }
    | { readonly kind: "diagnostic"; readMixer(): AudioMixer | null };
  readonly clock: EngineCinematicClock;
  readonly scratchImages: { scratchImage(index: number): RendererImage };
  readonly console: CinematicConsole;
  readonly print: (text: string) => undefined;
  readonly developerPrint: (text: string) => undefined;
  readonly settings: EngineCinematicSettings;
}
export enum CinematicStatus { Idle, Playing, Eof, IdBlt, IdIdle, Looped, IdWait }

class CinematicHandle {
  constructor(private readonly owner: EngineCinematics, readonly index: number) { Object.freeze(this); }
  belongsTo(owner: EngineCinematics): boolean { return this.owner === owner; }
}
export type EngineCinematicHandle = CinematicHandle;

type Prepared = { readonly kind: "ready"; readonly bytes: Uint8Array }
  | { readonly kind: "path" }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly cause: unknown };
interface CinematicCell {
  readonly handle: EngineCinematicHandle;
  fileName: string;
  status: CinematicStatus;
  rect: UiRect;
  looping: boolean;
  holdAtEnd: boolean;
  silent: boolean;
  shader: boolean;
  dirty: boolean;
  playOnWalls: number;
  width: number;
  height: number;
  drawWidth: number;
  drawHeight: number;
  pointer: { readonly offset: number; readonly byteLength: number } | null;
  playback: RoqPlayback | null;
  stream: RoqStream | null;
  system: SystemState | null;
}
type CinematicStart = { readonly kind: "finished"; readonly handle: EngineCinematicHandle | undefined }
  | { readonly kind: "opened"; readonly cell: CinematicCell; readonly input: Uint8Array | RoqStream; readonly argument: string };
export interface SystemCinematicHost {
  state(): "cinematic" | "other";
  closeMenu(): Promise<void>;
  enterCinematic(): undefined;
  enterDisconnected(): undefined;
  nextMap(): string;
  clearNextMap(): undefined;
  appendCommand(text: string): undefined;
  stopAllSounds(): undefined;
}
interface SystemState { readonly host: SystemCinematicHost; handle: EngineCinematicHandle | null }
interface SystemOperations {
  developerPrint(text: string): undefined;
  prepare(path: string): Promise<UiCinematicAsset>;
  play(asset: UiCinematicAsset, options: NonSystemCinematicOptions): Promise<EngineCinematicHandle | undefined>;
  run(handle: EngineCinematicHandle): CinematicStatus;
  stop(handle: EngineCinematicHandle): CinematicStatus;
  hasFrame(handle: EngineCinematicHandle): boolean;
  draw(handle: EngineCinematicHandle, draw: Draw2D): undefined;
}

// q_shared.h selects limits.h PATH_MAX for the supported Unix engine build.
const cinematicPathCapacity = 4096;

function moviePath(path: string): string {
  const nul = path.indexOf("\0"), name = nul < 0 ? path : path.slice(0, nul);
  for (let index = 0; index < name.length; index++) {
    if (name.charCodeAt(index) > 255) throw new RangeError("Cinematic filename requires Latin-1 source bytes");
  }
  return name.includes("/") || name.includes("\\") ? name : `video/${name}`;
}
function integer(value: number): number {
  if (!Number.isFinite(value) || value < -2147483648 || value > 2147483647) throw new RangeError("Invalid cinematic extent");
  return Math.trunc(value);
}
function rectInts(rect: UiRect): UiRect {
  return { x: integer(rect.x), y: integer(rect.y), width: integer(rect.width), height: integer(rect.height) };
}
function once(operation: () => undefined): () => undefined {
  let used = false;
  return () => {
    if (used) throw new Error("Cinematic completion is one-shot");
    used = true;
    return operation();
  };
}

/** Sixteen persistent BSS cells share one decoder storage and one raw sound stream. */
export class EngineCinematics {
  readonly shaderCinematics: ShaderCinematicRegistry;
  private readonly assets = new Map<string, Promise<UiCinematicAsset>>();
  private prepared = new WeakMap<UiCinematicAsset, { readonly input: Prepared; readonly argument: string }>();
  private readonly scratch = new RoqDecoderScratch();
  private readonly cells: readonly CinematicCell[];
  private selectedHandle = -1;
  private decoderHandle = 0;
  private system: SystemState | null = null;
  private closed = false;

  constructor(private readonly options: EngineCinematicOptions) {
    if (!Number.isSafeInteger(options.settings.maxTextureSize) || options.settings.maxTextureSize < 256) throw new RangeError("Cinematic renderer must support 256-pixel textures");
    this.cells = Array.from({ length: 16 }, (_, index): CinematicCell => ({
      handle: new CinematicHandle(this, index), fileName: "", status: CinematicStatus.Idle,
      rect: { x: 0, y: 0, width: 0, height: 0 }, looping: false, holdAtEnd: false,
      silent: false, shader: false, dirty: false, playOnWalls: 0, width: 0, height: 0,
      drawWidth: 0, drawHeight: 0, pointer: null, playback: null, stream: null, system: null,
    }));
    this.shaderCinematics = Object.freeze({ playShaderCinematic: async (path: string) => {
      const asset = await this.prepare(path);
      const handle = this.playNonSystem(asset, { x: 0, y: 0, width: 256, height: 256 },
        { looping: true, holdAtEnd: false, silent: true, shader: true });
      return handle === undefined ? null : Object.freeze({ image: this.options.scratchImages.scratchImage(handle.index),
        prepareAtExecution: () => this.prepareShader(handle) });
    } });
  }

  prepare(path: string): Promise<UiCinematicAsset> {
    this.alive();
    const nul = path.indexOf("\0"), argument = nul < 0 ? path : path.slice(0, nul);
    const name = moviePath(argument), cached = this.assets.get(argument);
    if (cached !== undefined) return cached;
    const load = async (): Promise<UiCinematicAsset> => {
      const asset: UiCinematicAsset = Object.freeze({ path: name });
      const localName = name.slice(0, cinematicPathCapacity - 1);
      let result: Prepared;
      try {
        const files = this.options.files;
        result = files.kind === "retained" ? { kind: "path" } : files.reader.has(localName)
          ? { kind: "ready", bytes: new Uint8Array(await files.reader.read(localName)) } : { kind: "missing" };
      } catch (cause: unknown) {
        result = { kind: "failed", cause };
      }
      // Disposal is a lifecycle failure, not a deferred file-read result.
      this.alive();
      this.prepared.set(asset, { input: result, argument });
      return asset;
    };
    const result = load();
    this.assets.set(argument, result);
    return result;
  }

  playNonSystem(asset: UiCinematicAsset, rect: UiRect, options: NonSystemCinematicOptions): EngineCinematicHandle | undefined {
    const start = this.open(asset, rect, options, null);
    return start.kind === "finished" ? start.handle : this.startPlayback(start.cell, start.input, start.argument);
  }

  /** CIN_PlayCinematic uses the attached host without the CL_PlayCinematic_f wrapper. */
  play(asset: UiCinematicAsset, rect: UiRect, systemBits: number): EngineCinematicHandle | undefined | Promise<EngineCinematicHandle | undefined> {
    const flags: NonSystemCinematicOptions = { looping: (systemBits & 2) !== 0, holdAtEnd: (systemBits & 4) !== 0,
      silent: (systemBits & 8) !== 0, shader: (systemBits & 16) !== 0 };
    if ((systemBits & 1) === 0) return this.playNonSystem(asset, rect, flags);
    this.alive();
    if (this.system === null) throw new Error("System cinematic requires an attached client host");
    return this.playSystem(asset, rect, flags, this.system);
  }

  private async playSystem(asset: UiCinematicAsset, rect: UiRect, flags: NonSystemCinematicOptions, system: SystemState): Promise<EngineCinematicHandle | undefined> {
    const start = this.open(asset, rect, flags, system);
    if (start.kind === "finished") return start.handle;
    await system.host.closeMenu();
    this.alive();
    if (start.input instanceof RoqStream && start.cell.stream !== start.input) return undefined;
    return this.startPlayback(start.cell, start.input, start.argument);
  }

  private open(asset: UiCinematicAsset, rect: UiRect, flags: NonSystemCinematicOptions, system: SystemState | null): CinematicStart {
    this.alive();
    const name = moviePath(asset.path);
    if (name.length >= 32000) throw new CommonError("fatal", "Com_sprintf: overflowed bigbuffer");
    if (name.length >= cinematicPathCapacity) {
      this.options.print(`Com_sprintf: overflow of ${name.length} in ${cinematicPathCapacity}\n`);
      this.alive();
    }
    const localName = name.slice(0, cinematicPathCapacity - 1);
    if (system === null) for (const cell of this.cells) if (cell.fileName !== "" && cell.fileName === localName) return { kind: "finished", handle: cell.handle };
    const preparation = this.prepared.get(asset);
    if (preparation === undefined) throw new Error("Cinematic asset belongs to another owner or lifecycle");
    const { input: prepared, argument } = preparation;
    this.options.developerPrint(`SCR_PlayCinematic( ${argument} )\n`);
    this.alive();
    this.scratch.clearMovieState();
    this.decoderHandle = 0;
    const cell = this.cells.find(candidate => candidate.fileName === "");
    if (cell === undefined) throw new CommonError("drop", "CIN_HandleForVideo: none free");
    this.selectedHandle = cell.handle.index;
    this.decoderHandle = cell.handle.index;
    cell.fileName = localName;
    if (prepared.kind === "failed") {
      cell.fileName = "";
      throw prepared.cause;
    }
    if (prepared.kind === "missing" || (prepared.kind === "ready" && prepared.bytes.length === 0)) {
      this.options.developerPrint(`play(${argument}), ROQSize<=0\n`); this.alive();
      cell.fileName = ""; return { kind: "finished", handle: undefined };
    }
    let input: Uint8Array | RoqStream;
    if (prepared.kind === "path") {
      const files = this.options.files;
      if (files.kind !== "retained") throw new Error("Retained cinematic path has no file owner");
      let stream: RoqStream | undefined;
      try { stream = RoqStream.open(() => files.current(), cell.fileName, this.scratch.file); }
      catch (error) { cell.fileName = ""; throw error; }
      if (stream === undefined) {
        this.options.developerPrint(`play(${argument}), ROQSize<=0\n`); this.alive();
        cell.fileName = ""; return { kind: "finished", handle: undefined };
      }
      cell.stream = stream;
      cell.playback = null;
      input = stream;
    } else input = prepared.bytes;

    // These two source setters precede status=PLAY and ignore a retained EOF cell.
    this.setExtents(cell.handle, rect);
    this.setLooping(cell.handle, flags.looping);
    cell.width = 512; cell.height = 512;
    cell.holdAtEnd = flags.holdAtEnd; cell.silent = flags.silent; cell.shader = flags.shader;
    cell.system = system; cell.playOnWalls = 1;
    if (system === null) cell.playOnWalls = this.options.settings.inGameVideo();
    return { kind: "opened", cell, input, argument };
  }

  private startPlayback(cell: CinematicCell, input: Uint8Array | RoqStream, argument: string): EngineCinematicHandle | undefined {
    try {
      if (input instanceof RoqStream) input.beginPlayback();
      cell.playback = new RoqPlayback(input, this.playbackOptions(cell));
    } catch (error: unknown) {
      if (!(error instanceof BinaryError)) throw error;
      if (error.message === `${cell.fileName}:0: invalid RoQ magic`) {
        this.options.developerPrint("trFMV::play(), invalid RoQ ID\n"); this.alive();
      }
      this.shutdown();
      return undefined;
    }
    cell.status = CinematicStatus.Playing;
    this.options.developerPrint(`trFMV::play(), playing ${argument}\n`); this.alive();
    if (cell.system !== null) cell.system.host.enterCinematic();
    if (this.options.console.kind === "available") this.options.console.close();
    this.readMixer()?.resetRawToSoundTime();
    return cell.handle;
  }

  private playbackOptions(cell: CinematicCell): RoqPlaybackOptions {
    return { source: cell.fileName, loop: cell.looping, hold: cell.holdAtEnd,
      developerPrint: text => { this.alive(); this.options.developerPrint(text); this.alive(); },
      silent: cell.silent, shader: cell.shader, clock: this.options.clock, scratch: this.scratch,
      onInfo: (width, height) => {
        this.alive();
        this.updateDimensions(cell, width, height);
      },
      onFrame: (_frame, pointer) => {
        this.alive();
        cell.pointer = pointer; cell.dirty = true;
      },
      onAudio: event => {
        this.alive();
        this.readMixer()?.queueRaw({ sampleRate: event.sampleRate, channels: event.channels, samples: event.samples,
          frameCount: event.samples.length / event.channels, loopStart: null }, 1);
        this.alive();
      },
      beforeRawStreamReset: () => {
        const sound = this.options.sound;
        if (sound.kind === "diagnostic") throw new Error("Pre-INFO stereo cinematic requires engine sound update");
        // ZA_SOUND_STEREO updates sound before resetting rawend and decoding PCM.
        sound.owner.update();
        this.alive();
        sound.owner.mixer?.resetRawToSoundTime();
      } };
  }

  run(handle: EngineCinematicHandle): CinematicStatus {
    const cell = this.cell(handle);
    if (cell.status === CinematicStatus.Eof) return CinematicStatus.Eof;
    let playback = cell.playback;
    if (this.decoderHandle !== handle.index) {
      this.selectedHandle = handle.index; this.decoderHandle = handle.index;
      cell.status = CinematicStatus.Eof;
      if (playback === null) {
        // Empty filenames reach out-of-allocation suffix reads in source FS_FOpenFileRead.
        if (cell.stream === null) throw new Error("Cannot reset an uninitialized cinematic: unchecked retained RoQ header is unsupported without a retained file");
        playback = RoqPlayback.fromReset(cell.stream, this.playbackOptions(cell));
        cell.playback = playback;
      } else playback.restart(this.options.clock);
      cell.status = CinematicStatus.Looped;
    }
    if (playback === null) {
      if (cell.status === CinematicStatus.Idle) return cell.status;
      throw new Error("Cannot run a cinematic without a valid RoQ header");
    }
    if (cell.playOnWalls < -1) return cell.status;
    this.selectedHandle = handle.index;
    if (cell.system !== null && cell.system.host.state() !== "cinematic") return cell.status;
    if (cell.status === CinematicStatus.Idle) return cell.status;
    const result = playback.run(this.options.clock);
    switch (result.status) {
      case "playing": cell.status = CinematicStatus.Playing; break;
      case "held": cell.status = CinematicStatus.Idle; break;
      case "ended": cell.status = CinematicStatus.Eof; break;
      case "looped": cell.status = CinematicStatus.Looped; break;
    }
    if (cell.status === CinematicStatus.Eof) this.shutdown();
    return cell.status;
  }

  private updateDimensions(cell: CinematicCell, width: number, height: number): void {
    cell.width = width; cell.height = height;
    const limited = this.options.settings.hardware === "ragepro" || this.options.settings.maxTextureSize <= 256;
    cell.drawWidth = limited ? Math.min(256, width) : width;
    cell.drawHeight = limited ? Math.min(256, height) : height;
    if (limited && (width !== 256 || height !== 256)) {
      this.options.print("HACK: approxmimating cinematic for Rage Pro or Voodoo\n"); this.alive();
    }
  }

  setExtents(handle: EngineCinematicHandle, rect: UiRect): undefined {
    const cell = this.cell(handle);
    if (cell.status === CinematicStatus.Eof) return;
    cell.rect = rectInts(rect); cell.dirty = true;
  }

  private setLooping(handle: EngineCinematicHandle, looping: boolean): undefined {
    const cell = this.cell(handle);
    if (cell.status === CinematicStatus.Eof) return;
    cell.looping = looping;
  }

  prepareUiRaw(handle: EngineCinematicHandle): PreparedUiRawCall | null {
    const cell = this.cell(handle), pointer = cell.pointer;
    if (cell.status === CinematicStatus.Eof || pointer === null) return null;
    const image = this.options.scratchImages.scratchImage(handle.index);
    const dirty = cell.dirty;
    const resampled = dirty && (cell.width !== cell.drawWidth || cell.height !== cell.drawHeight);
    const width = resampled ? 256 : cell.drawWidth, height = resampled ? 256 : cell.drawHeight;
    const temporary = resampled ? this.options.temporaryMemory.allocateTemp(256 * 256 * 4) : null;
    const selected = temporary === null ? this.scratch.view(pointer.offset, width * height * 4)
      : this.resample(pointer.offset, cell.width, cell.height, temporary.bytes);
    let captured = false;
    return Object.freeze({ image, sourceWidth: width, sourceHeight: height, uploadWidth: width, uploadHeight: height, dirty,
      captureAfterBarrier: () => {
        this.alive();
        if (captured) throw new Error("Cinematic raw capture is one-shot");
        captured = true;
        return Object.freeze({ upload: Object.freeze({ image, sourceWidth: width, sourceHeight: height,
          uploadWidth: width, uploadHeight: height, content: new RgbaSnapshot(width, height, selected), dirty }),
        afterUiDraw: once(() => {
          this.alive(); cell.dirty = false;
          if (temporary !== null) this.options.temporaryMemory.freeTemp(temporary);
        }) });
      } });
  }

  draw(handle: EngineCinematicHandle, draw: Draw2D): undefined {
    const cell = this.cell(handle), call = this.prepareUiRaw(handle);
    if (call !== null) draw.stretchRawPixels(cinematicPixelRect(cell.rect, draw.width, draw.height), call);
  }

  private prepareShader(handle: EngineCinematicHandle): ShaderCinematicCall | null {
    this.run(handle);
    const cell = this.cell(handle), pointer = cell.pointer;
    if (pointer === null) return null;
    if (cell.playOnWalls <= 0 && cell.dirty) {
      if (cell.playOnWalls === 0) cell.playOnWalls = -1;
      else if (cell.playOnWalls === -1) cell.playOnWalls = -2;
      else cell.dirty = false;
    }
    const upload = Object.freeze({ image: this.options.scratchImages.scratchImage(handle.index),
      sourceWidth: 256, sourceHeight: 256, uploadWidth: 256, uploadHeight: 256,
      content: new RgbaSnapshot(256, 256, this.scratch.view(pointer.offset, 256 * 256 * 4)), dirty: cell.dirty });
    return Object.freeze({ upload, afterShaderUpload: once(() => {
      this.alive();
      if (this.options.settings.inGameVideo() === 0 && cell.playOnWalls === 1) cell.playOnWalls--;
    }) });
  }

  /** Source integer traps address these permanent cells, including idle and reused slots. */
  handleAtSlot(index: number): EngineCinematicHandle | undefined {
    this.alive();
    if (!Number.isInteger(index) || index < 0 || index >= 16) return undefined;
    const cell = this.cells[index];
    if (cell === undefined) throw new Error("Missing permanent cinematic cell");
    return cell.handle;
  }

  /** Integer trap boundary used by CG_StopCinematic and UI_StopCinematic; cells have no generations. */
  stopSlot(index: number): CinematicStatus {
    if (!Number.isInteger(index) || index < 0 || index >= 16) return CinematicStatus.Eof;
    const cell = this.cells[index];
    if (cell === undefined) throw new Error("Missing permanent cinematic cell");
    return this.stop(cell.handle);
  }

  stop(handle: EngineCinematicHandle): CinematicStatus {
    const cell = this.cell(handle);
    if (cell.status === CinematicStatus.Eof) return CinematicStatus.Eof;
    this.selectedHandle = handle.index;
    this.options.developerPrint(`trFMV::stop(), closing ${cell.fileName}\n`); this.alive();
    if (cell.pointer === null) return CinematicStatus.Eof;
    if (cell.system !== null && cell.system.host.state() !== "cinematic") return cell.status;
    cell.status = CinematicStatus.Eof;
    this.shutdown();
    return CinematicStatus.Eof;
  }

  closeAllVideos(): undefined {
    this.alive();
    for (const cell of this.cells) if (cell.fileName !== "") this.stop(cell.handle);
  }

  dispose(): undefined {
    if (this.closed) return;
    this.closed = true;
    for (const cell of this.cells) {
      cell.stream?.retire();
      cell.stream = null;
      cell.fileName = ""; cell.status = CinematicStatus.Idle; cell.dirty = false;
      cell.pointer = null; cell.playback = null; cell.system = null;
    }
    if (this.system !== null) this.system.handle = null;
    this.system = null; this.selectedHandle = -1; this.decoderHandle = 0;
    this.assets.clear(); this.prepared = new WeakMap(); this.scratch.clear();
  }

  attachSystem(host: SystemCinematicHost): EngineSystemCinematics {
    this.alive();
    if (this.system !== null) throw new Error("A system cinematic host is already attached");
    const state: SystemState = { host, handle: null };
    this.system = state;
    return new SystemCinematics(state, {
      developerPrint: text => { this.alive(); this.options.developerPrint(text); this.alive(); },
      prepare: path => this.prepare(path),
      play: (asset, flags) => this.playSystem(asset, { x: 0, y: 0, width: 640, height: 480 }, flags, state),
      run: handle => this.run(handle), stop: handle => this.stop(handle),
      hasFrame: handle => this.cell(handle).pointer !== null,
      draw: (handle, draw) => this.draw(handle, draw),
    });
  }

  private shutdown(): void {
    const cell = this.cells[this.selectedHandle];
    if (cell === undefined) throw new Error("RoQShutdown has no selected cinematic");
    if (cell.pointer === null || cell.status === CinematicStatus.Idle) return;
    this.options.developerPrint("finished cinematic\n"); this.alive();
    cell.status = CinematicStatus.Idle;
    cell.stream?.close(); cell.stream = null;
    const system = cell.system;
    if (system !== null) {
      system.host.enterDisconnected();
      const next = system.host.nextMap();
      if (next.length !== 0) { system.host.appendCommand(`${next}\n`); system.host.clearNextMap(); }
      system.handle = null;
    }
    cell.fileName = "";
    this.selectedHandle = -1;
  }

  private readMixer(): AudioMixer | null {
    const sound = this.options.sound;
    return sound.kind === "engine" ? sound.owner.mixer : sound.readMixer();
  }

  private resample(offset: number, width: number, height: number, result: Uint8Array): Uint8Array {
    const source = this.scratch.view(offset, 512 * 512 * 4);
    const xm = Math.trunc(width / 256), ym = Math.trunc(height / 256), shift = width === 512 ? 9 : 8;
    const read = (index: number): number => { const value = source[index]; if (value === undefined) throw new RangeError("Source cinematic resample exceeded linbuf"); return value; };
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) for (let channel = 0; channel < 4; channel++) {
      let value: number;
      if (xm === 2 && ym === 2) {
        const index = (y << 12) + x * 8 + channel;
        value = (read(index) + read(index + 4) + read(index + 2048) + read(index + 2052)) >> 2;
      } else if (xm === 2 && ym === 1) {
        const index = (y << 11) + x * 8 + channel;
        value = (read(index) + read(index + 4)) >> 1;
      } else value = read((((y * ym) << shift) + x * xm) * 4 + channel);
      result[(y * 256 + x) * 4 + channel] = value;
    }
    return result;
  }

  private alive(): void { if (this.closed) throw new Error("Engine cinematic owner is disposed"); }
  private cell(handle: EngineCinematicHandle): CinematicCell {
    this.alive();
    if (!handle.belongsTo(this)) throw new Error("Cinematic handle belongs to another owner");
    const cell = this.cells[handle.index];
    if (cell === undefined) throw new RangeError("Invalid cinematic handle");
    return cell;
  }
}

/** Source SCR_AdjustFrom640 stretches independently of the UI widescreen profile. */
export function cinematicPixelRect(rect: UiRect, width: number, height: number): UiRect {
  const f = Math.fround;
  return { x: Math.trunc(f(f(rect.x) * f(width / 640))), y: Math.trunc(f(f(rect.y) * f(height / 480))),
    width: Math.trunc(f(f(rect.width) * f(width / 640))), height: Math.trunc(f(f(rect.height) * f(height / 480))) };
}

class SystemCinematics {
  constructor(private readonly state: SystemState, private readonly operations: SystemOperations) {}

  async play(path: string, option = ""): Promise<EngineCinematicHandle | undefined> {
    this.operations.developerPrint("CL_PlayCinematic_f\n");
    const host = this.state.host;
    if (host.state() === "cinematic") this.stop();
    const name = path.toLowerCase();
    const flags = { looping: option.startsWith("2"), holdAtEnd: option.startsWith("1") || name === "end.roq" || name === "demoend.roq",
      silent: false, shader: false };
    host.stopAllSounds();
    const handle = await this.operations.play(await this.operations.prepare(path), flags);
    this.state.handle = handle ?? null;
    if (handle !== undefined) {
      let status: CinematicStatus;
      do { status = this.operations.run(handle); } while (!this.operations.hasFrame(handle) && status === CinematicStatus.Playing);
    }
    return handle;
  }
  run(): CinematicStatus {
    return this.state.handle === null ? CinematicStatus.Eof : this.operations.run(this.state.handle);
  }
  draw(draw: Draw2D): undefined {
    if (this.state.handle !== null) this.operations.draw(this.state.handle, draw);
  }
  stop(): undefined {
    const handle = this.state.handle;
    if (handle === null) return;
    this.operations.stop(handle);
    this.state.host.stopAllSounds();
    this.state.handle = null;
  }
}
export type EngineSystemCinematics = SystemCinematics;
