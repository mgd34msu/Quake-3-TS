// win32/win_input.c IN_StartupMIDI, IN_ShutdownMIDI and MidiInfo_f.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
// Linux ALSA raw MIDI supplies the system byte stream in place of WinMM.
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { SourceMidiDecoder } from "./source-midi.ts";

export interface MidiDevice {
  readonly name: string;
  readonly path: string;
}

export interface MidiInputHandle {
  /** Zero means no input is ready. The caller owns and reuses the destination. */
  read(bytes: Uint8Array): number;
  close(): void;
}

export interface MidiInputBoundary {
  list(): readonly MidiDevice[];
  open(device: MidiDevice): MidiInputHandle;
}

/** The file boundary can be exercised without enumerating or opening real devices. */
export interface MidiFileIo {
  readDirectory(): readonly string[];
  open(path: string, flags: number): number;
  isCharacterDevice(fd: number): boolean;
  read(fd: number, bytes: Uint8Array): number;
  close(fd: number): void;
}

const systemMidiFiles: MidiFileIo = {
  readDirectory: () => readdirSync("/dev/snd"),
  open: (path, flags) => openSync(path, flags),
  isCharacterDevice: fd => fstatSync(fd).isCharacterDevice(),
  read: (fd, bytes) => readSync(fd, bytes, 0, bytes.length, null),
  close: fd => { closeSync(fd); },
};

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : null;
}

class RawMidiHandle implements MidiInputHandle {
  private closed = false;
  private pending: number | null = null;
  constructor(private readonly fd: number, private readonly io: MidiFileIo) {}

  start(): void {
    const first = new Uint8Array(1);
    if (this.read(first) === 0) return;
    const byte = first[0];
    if (byte === undefined) throw new Error("Missing initial MIDI input byte");
    this.pending = byte;
  }

  read(bytes: Uint8Array): number {
    if (this.closed) throw new Error("MIDI input handle is closed");
    if (bytes.length === 0) throw new RangeError("MIDI read requires a nonempty buffer");
    if (this.pending !== null) { bytes[0] = this.pending; this.pending = null; return 1; }
    let count: number;
    try { count = this.io.read(this.fd, bytes); }
    catch (error) {
      const code = errorCode(error);
      if (code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EINTR") return 0;
      throw error;
    }
    if (!Number.isInteger(count) || count < 0 || count > bytes.length) throw new Error("Invalid MIDI read length");
    if (count === 0) throw new Error("MIDI input reached end of stream");
    return count;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.io.close(this.fd);
  }
}

/** Hardware MIDI 1.0 nodes only; sequencer ports and UMP require other interfaces. */
export class LinuxMidiInputBoundary implements MidiInputBoundary {
  constructor(private readonly io: MidiFileIo = systemMidiFiles) {}

  list(): readonly MidiDevice[] {
    if (process.platform !== "linux") throw new Error("MIDI input currently requires Linux ALSA raw MIDI");
    let names: readonly string[];
    try { names = this.io.readDirectory(); }
    catch (error) { if (errorCode(error) === "ENOENT") return []; throw error; }
    const devices: { readonly card: number; readonly device: number; readonly name: string }[] = [];
    for (const name of names) {
      const match = /^midiC([0-9]+)D([0-9]+)$/.exec(name);
      if (match === null) continue;
      const cardText = match[1], deviceText = match[2];
      if (cardText === undefined || deviceText === undefined) throw new Error("Missing MIDI device coordinates");
      const card = Number(cardText), device = Number(deviceText);
      if (!Number.isSafeInteger(card) || !Number.isSafeInteger(device)) continue;
      devices.push({ card, device, name });
    }
    devices.sort((a, b) => a.card - b.card || a.device - b.device);
    return devices.map(device => ({ name: `ALSA ${device.name}`, path: `/dev/snd/${device.name}` }));
  }

  open(device: MidiDevice): MidiInputHandle {
    if (process.platform !== "linux") throw new Error("MIDI input currently requires Linux ALSA raw MIDI");
    if (!/^\/dev\/snd\/midiC[0-9]+D[0-9]+$/.test(device.path)) throw new Error("Invalid ALSA MIDI device path");
    // Linux sound/core/rawmidi.c: O_NONBLOCK applies to both open and read;
    // read starts input capture. O_RDONLY never opens a MIDI output substream.
    const fd = this.io.open(device.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      if (!this.io.isCharacterDevice(fd)) throw new Error("ALSA MIDI path is not a character device");
      const handle = new RawMidiHandle(fd, this.io);
      handle.start();
      return handle;
    } catch (error) { this.io.close(fd); throw error; }
  }
}

export interface SourceMidiOptions {
  readonly cvars: CvarRegistry;
  readonly print: (text: string) => undefined;
}

export class SourceMidiInput {
  private readonly decoder = new SourceMidiDecoder();
  private readonly buffer = new Uint8Array(4096);
  private devices: readonly MidiDevice[] = [];
  private handle: MidiInputHandle | null = null;
  private closed = false;

  /** Construction performs no device access, including enumeration. */
  constructor(private readonly options: SourceMidiOptions,
    private readonly boundary: MidiInputBoundary = new LinuxMidiInputBoundary()) {}

  initialize(): void {
    this.requireOpen();
    const cvars = this.options.cvars;
    cvars.register("in_midi", "0", CvarFlag.Archive);
    cvars.register("in_midiport", "1", CvarFlag.Archive);
    cvars.register("in_midichannel", "1", CvarFlag.Archive);
    cvars.register("in_mididevice", "0", CvarFlag.Archive);
    this.stop();
    if (this.cvar("in_midi").numericValue === 0) return;
    const selected = this.cvar("in_mididevice").integerValue;
    try {
      this.devices = this.boundary.list();
      const device = this.devices[selected];
      if (device === undefined) throw new Error(`device index is outside ${this.devices.length} available devices`);
      this.handle = this.boundary.open(device);
    } catch (error) {
      this.options.print(`WARNING: could not open MIDI device ${selected}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  restart(): void { this.initialize(); }

  frame(queueKey: (key: number, down: boolean, time: number) => undefined, time = 0): void {
    this.requireOpen();
    // Bound one frame's reads even when a virtual MIDI producer never becomes idle.
    for (let reads = 0; reads < 16; reads++) {
      const handle = this.handle;
      if (handle === null) return;
      let count: number;
      try { count = handle.read(this.buffer); }
      catch (error) {
        this.stop();
        this.options.print(`WARNING: MIDI input stopped: ${error instanceof Error ? error.message : String(error)}\n`);
        return;
      }
      if (!Number.isInteger(count) || count < 0 || count > this.buffer.length) throw new Error("Invalid MIDI input boundary read length");
      if (count === 0) return;
      this.decoder.feed(this.buffer.subarray(0, count), this.cvar("in_midichannel").integerValue, time, queueKey);
    }
  }

  info(): void {
    this.requireOpen();
    const { print } = this.options;
    print(`\nMIDI control:       ${this.cvar("in_midi").integerValue !== 0 ? "enabled" : "disabled"}\n`);
    print(`port:               ${this.cvar("in_midiport").integerValue}\n`);
    print(`channel:            ${this.cvar("in_midichannel").integerValue}\n`);
    print(`current device:     ${this.cvar("in_mididevice").integerValue}\n`);
    print(`number of devices:  ${this.devices.length}\n`);
    for (const [index, device] of this.devices.entries()) {
      print(`${index === this.cvar("in_mididevice").numericValue ? "***" : "..."}device ${String(index).padStart(2)}:       ${device.name}\n`);
      print(`...system path:     ${device.path}\n...manufacturer/product IDs: unavailable through Linux raw MIDI\n\n`);
    }
  }

  private cvar(name: string) {
    const value = this.options.cvars.get(name);
    if (value === undefined) throw new Error(`MIDI cvar ${name} no longer exists`);
    return value;
  }

  private requireOpen(): void { if (this.closed) throw new Error("Source MIDI input is closed"); }

  private stop(): void {
    const handle = this.handle;
    this.handle = null;
    this.devices = [];
    this.decoder.reset();
    handle?.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop();
  }
}
