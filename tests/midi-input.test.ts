// Source expectations: win32/win_input.c MIDI_NoteOn/Off and MidiInProc.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { expect, test } from "bun:test";
import { constants } from "node:fs";
import { CommandBuffer } from "../src/core/commands.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { ClientKeys } from "../src/engine/client-keys.ts";
import { LinuxMidiInputBoundary, SourceMidiInput } from "../src/platform/midi.ts";
import type { MidiDevice, MidiFileIo, MidiInputBoundary, MidiInputHandle } from "../src/platform/midi.ts";
import { SourceMidiDecoder } from "../src/platform/source-midi.ts";

function events() {
  const values: { readonly key: number; readonly down: boolean; readonly time: number }[] = [];
  const queue = (key: number, down: boolean, time: number): undefined => { values.push({ key, down, time }); };
  return { values, queue };
}

test("MIDI notes 60..98 map to every source key 217..255, with source zero velocity ordering", () => {
  const decoder = new SourceMidiDecoder(), result = events();
  for (let note = 0; note < 128; note++) {
    decoder.feed(Uint8Array.of(0x90, note, 127, 0x80, note, 30, 0x90, note, 0), 1, 123, result.queue);
  }
  expect(result.values).toEqual(Array.from({ length: 39 }, (_, index) => [
    { key: 217 + index, down: true, time: 123 }, { key: 217 + index, down: false, time: 123 },
    { key: 217 + index, down: false, time: 123 }, { key: 217 + index, down: true, time: 123 },
  ]).flat());
});

test("MIDI framing spans reads, retains running status and ignores interleaved realtime", () => {
  const decoder = new SourceMidiDecoder(), result = events();
  decoder.feed(Uint8Array.of(0x90, 60, 0xf8), 1, 1, result.queue);
  expect(result.values).toEqual([]);
  decoder.feed(Uint8Array.of(1, 61, 0xfe, 0, 0xff, 62), 1, 2, result.queue);
  decoder.feed(Uint8Array.of(127, 0x80, 60, 0xfc, 100, 61, 0), 1, 3, result.queue);
  expect(result.values).toEqual([
    { key: 217, down: true, time: 2 },
    { key: 218, down: false, time: 2 }, { key: 218, down: true, time: 2 },
    { key: 219, down: true, time: 3 },
    { key: 217, down: false, time: 3 }, { key: 218, down: false, time: 3 },
  ]);
});

test("MIDI note events reach real client bindings, including velocity-zero release then press", async () => {
  const cvars = new CvarRegistry(), commands = new CommandBuffer(), result = events();
  const unused = (): never => { throw new Error("Unexpected client service during MIDI binding"); };
  const keys = new ClientKeys({ cvars, commands, print: unused, host: {
    readConnection: () => ({ kind: "active", demoPlayback: false }), readUi: () => null, readCgame: () => null,
    assertCurrentOperation: () => { commands.assertCurrentExecution(); }, disconnect: unused, stopAllSounds: unused,
    addReliableCommand: unused, toggleConsole: unused, updateScreen: unused, consoleScroll: unused,
    readConsoleWidth: () => 78, clipboard: { kind: "native-unix-unavailable" },
  } });
  keys.setBinding(217, "+attack"); keys.setBinding(255, "+forward");
  const decoder = new SourceMidiDecoder();
  decoder.feed(Uint8Array.of(0x90, 60, 100, 60, 0, 0x80, 60, 0, 0x90, 98, 1, 0x80, 98, 1), 1, 42, result.queue);
  for (const event of result.values) await keys.keyEvent(event.key, event.down, event.time);
  expect(commands.pendingText).toBe("+attack 217 42\n-attack 217 42\n+attack 217 42\n-attack 217 42\n+forward 255 42\n-forward 255 42\n");
  expect(keys.inputState.anyKeyDown).toBe(0);
});

test("MIDI channel comparison is one-based and out-of-range cvars match no channel", () => {
  for (const channel of [0, 1, 6, 16, 17, -1]) {
    const decoder = new SourceMidiDecoder(), result = events();
    for (let input = 0; input < 16; input++) decoder.feed(Uint8Array.of(0x90 + input, 60, 1), channel, 0, result.queue);
    expect(result.values).toEqual(channel >= 1 && channel <= 16 ? [{ key: 217, down: true, time: 0 }] : []);
  }
});

test("unsupported MIDI messages and interrupted messages cannot become note events", () => {
  const decoder = new SourceMidiDecoder(), result = events();
  decoder.feed(Uint8Array.of(60, 127, 0x90, 60, 0xb0, 60, 127, 61, 1,
    0xc0, 60, 61, 0xd0, 60, 61, 0xa0, 60, 127, 0xe0, 60, 127,
    0x90, 60, 0xf0, 60, 127, 0xf8), 1, 1, result.queue);
  decoder.feed(Uint8Array.of(61, 1, 0xf7, 62, 1, 0x90, 63, 127), 1, 2, result.queue);
  expect(result.values).toEqual([{ key: 220, down: true, time: 2 }]);
  for (const status of [0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7]) {
    decoder.feed(Uint8Array.of(0x90, 60, status, 61, 127, 62, 1), 1, 3, result.queue);
  }
  expect(result.values).toHaveLength(1);
  decoder.feed(Uint8Array.of(0x90, 60), 1, 4, result.queue);
  decoder.reset();
  decoder.feed(Uint8Array.of(127, 61, 1), 1, 5, result.queue);
  expect(result.values).toHaveLength(1);
});

class FixtureHandle implements MidiInputHandle {
  readonly chunks: (Uint8Array | Error)[] = [];
  closed = 0;
  reads = 0;
  read(bytes: Uint8Array): number {
    this.reads++;
    const next = this.chunks.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) return 0;
    bytes.set(next);
    return next.length;
  }
  close(): void { this.closed++; }
}

class FixtureBoundary implements MidiInputBoundary {
  enumerations = 0;
  readonly opened: MidiDevice[] = [];
  readonly handles: FixtureHandle[] = [];
  readonly devices: readonly MidiDevice[] = [
    { name: "Authored keyboard", path: "/dev/snd/midiC0D0" },
    { name: "Authored controller", path: "/dev/snd/midiC2D0" },
  ];
  list(): readonly MidiDevice[] { this.enumerations++; return this.devices; }
  open(device: MidiDevice): FixtureHandle {
    this.opened.push(device);
    const handle = new FixtureHandle();
    this.handles.push(handle);
    return handle;
  }
  handle(): FixtureHandle {
    const handle = this.handles.at(-1);
    if (handle === undefined) throw new Error("Fixture MIDI was not opened");
    return handle;
  }
}

function inputFixture() {
  const cvars = new CvarRegistry(), boundary = new FixtureBoundary(), output: string[] = [];
  const input = new SourceMidiInput({ cvars, print: text => { output.push(text); } }, boundary);
  return { cvars, boundary, output, input };
}

test("disabled MIDI registers archived defaults without any device access, including midiinfo", () => {
  const f = inputFixture();
  expect(f.boundary.enumerations).toBe(0);
  f.input.initialize();
  f.input.frame(events().queue);
  f.input.info();
  expect(f.boundary.enumerations).toBe(0);
  expect(f.boundary.opened).toEqual([]);
  for (const [name, value] of [["in_midi", "0"], ["in_midiport", "1"], ["in_midichannel", "1"], ["in_mididevice", "0"]]) {
    if (name === undefined || value === undefined) throw new Error("Missing cvar fixture");
    const cvar = f.cvars.get(name);
    expect(cvar?.value).toBe(value);
    expect(cvar?.flags).toBe(CvarFlag.Archive);
  }
  expect(f.output.join("")).toContain("MIDI control:       disabled\n");
  f.input.close(); f.input.close();
  expect(() => f.input.restart()).toThrow("closed");
});

test("MIDI startup selects device, reads live channel, preserves source inert port and enable behavior", () => {
  const f = inputFixture(), result = events();
  f.cvars.set("in_midi", "1"); f.cvars.set("in_mididevice", "1"); f.cvars.set("in_midiport", "99");
  f.input.initialize();
  expect(f.boundary.opened).toEqual([{ name: "Authored controller", path: "/dev/snd/midiC2D0" }]);
  const handle = f.boundary.handle();
  handle.chunks.push(Uint8Array.of(0x90, 60));
  f.input.frame(result.queue, 10);
  f.cvars.set("in_midichannel", "2");
  handle.chunks.push(Uint8Array.of(1, 0x91, 61, 1));
  f.input.frame(result.queue, 20);
  f.cvars.set("in_midi", "0");
  handle.chunks.push(Uint8Array.of(62, 1));
  f.input.frame(result.queue, 30);
  expect(result.values).toEqual([{ key: 218, down: true, time: 20 }, { key: 219, down: true, time: 30 }]);
  f.input.info();
  expect(f.output.join("")).toContain("port:               99\n");
  expect(f.output.join("")).toContain("***device  1:       Authored controller\n");
  expect(f.boundary.enumerations).toBe(1);
  f.input.restart();
  expect(handle.closed).toBe(1);
  expect(f.boundary.enumerations).toBe(1);
  f.input.close();
});

test("MIDI restart closes the prior device and discards only its partial stream", () => {
  const f = inputFixture(), result = events();
  f.cvars.set("in_midi", "1");
  f.input.initialize();
  const first = f.boundary.handle();
  first.chunks.push(Uint8Array.of(0x90, 60));
  f.input.frame(result.queue);
  f.cvars.set("in_mididevice", "1");
  f.input.restart();
  const second = f.boundary.handle();
  expect(first.closed).toBe(1);
  second.chunks.push(Uint8Array.of(127, 61, 127, 0x90, 62, 1));
  f.input.frame(result.queue, 77);
  expect(result.values).toEqual([{ key: 219, down: true, time: 77 }]);
  f.input.close(); f.input.close();
  expect(second.closed).toBe(1);
});

test("invalid MIDI device selection warns without opening and read failure releases its handle", () => {
  const f = inputFixture();
  f.cvars.set("in_midi", "1"); f.cvars.set("in_mididevice", "-1");
  f.input.initialize();
  expect(f.boundary.opened).toEqual([]);
  expect(f.output.join("")).toContain("WARNING: could not open MIDI device -1");
  f.cvars.set("in_mididevice", "0");
  f.input.restart();
  const handle = f.boundary.handle();
  handle.chunks.push(new Error("authored disconnect"));
  f.input.frame(events().queue);
  f.input.frame(events().queue);
  expect(handle.closed).toBe(1);
  expect(handle.reads).toBe(1);
  expect(f.output.join("")).toContain("WARNING: MIDI input stopped: authored disconnect\n");
  f.input.close();
  expect(handle.closed).toBe(1);
});

test("MIDI frame work is bounded while pending bytes survive for the following frame", () => {
  const f = inputFixture(), result = events();
  f.cvars.set("in_midi", "1"); f.input.initialize();
  const handle = f.boundary.handle();
  for (let index = 0; index < 20; index++) handle.chunks.push(Uint8Array.of(0x90, 60 + index, 1));
  f.input.frame(result.queue, 10);
  expect(handle.reads).toBe(16); expect(result.values).toHaveLength(16);
  f.input.frame(result.queue, 20);
  expect(result.values).toHaveLength(20);
  expect(result.values.at(-1)).toEqual({ key: 236, down: true, time: 20 });
  f.input.close();
});

class FixtureFileIo implements MidiFileIo {
  names = ["midiC10D0", "pcmC0D0c", "midiC2D10", "midiC2D1", "seq", "umpC0D0", "midiC../D0"];
  readonly opens: { readonly path: string; readonly flags: number }[] = [];
  readonly closed: number[] = [];
  readonly stream: number[] = [];
  character = true;
  failure: string | null = "EAGAIN";
  readDirectory(): readonly string[] { return this.names; }
  open(path: string, flags: number): number { this.opens.push({ path, flags }); return 12; }
  isCharacterDevice(): boolean { return this.character; }
  read(_fd: number, bytes: Uint8Array): number {
    if (this.failure !== null) throw Object.assign(new Error(this.failure), { code: this.failure });
    let count = 0;
    while (count < bytes.length) {
      const byte = this.stream.shift();
      if (byte === undefined) return count;
      bytes[count++] = byte;
    }
    return count;
  }
  close(fd: number): void { this.closed.push(fd); }
}

test("Linux raw MIDI boundary enumerates authored paths numerically and opens read-only nonblocking", () => {
  const io = new FixtureFileIo(), boundary = new LinuxMidiInputBoundary(io);
  expect(boundary.list()).toEqual([
    { name: "ALSA midiC2D1", path: "/dev/snd/midiC2D1" },
    { name: "ALSA midiC2D10", path: "/dev/snd/midiC2D10" },
    { name: "ALSA midiC10D0", path: "/dev/snd/midiC10D0" },
  ]);
  const handle = boundary.open({ name: "fixture", path: "/dev/snd/midiC2D1" });
  expect(io.opens).toEqual([{ path: "/dev/snd/midiC2D1", flags: constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW }]);
  const bytes = new Uint8Array(4);
  for (const code of ["EAGAIN", "EWOULDBLOCK", "EINTR"]) { io.failure = code; expect(handle.read(bytes)).toBe(0); }
  io.failure = null; io.stream.push(0x90, 60, 1);
  expect(handle.read(bytes)).toBe(3); expect([...bytes]).toEqual([0x90, 60, 1, 0]);
  expect(() => handle.read(bytes)).toThrow("end of stream");
  io.failure = "ENODEV"; expect(() => handle.read(bytes)).toThrow("ENODEV");
  handle.close(); handle.close();
  expect(io.closed).toEqual([12]);
  expect(() => handle.read(bytes)).toThrow("closed");
});

test("Linux MIDI open starts capture without discarding an already available first byte", () => {
  const io = new FixtureFileIo(), boundary = new LinuxMidiInputBoundary(io);
  io.failure = null; io.stream.push(0x90, 60, 127);
  const handle = boundary.open({ name: "fixture", path: "/dev/snd/midiC0D0" });
  const bytes = new Uint8Array(8), decoder = new SourceMidiDecoder(), result = events();
  const first = handle.read(bytes);
  decoder.feed(bytes.subarray(0, first), 1, 10, result.queue);
  const second = handle.read(bytes);
  decoder.feed(bytes.subarray(0, second), 1, 20, result.queue);
  expect(first).toBe(1); expect(second).toBe(2);
  expect(result.values).toEqual([{ key: 217, down: true, time: 20 }]);
  handle.close();
});

test("Linux MIDI rejects invalid nodes and closes after failed startup", () => {
  const io = new FixtureFileIo(), boundary = new LinuxMidiInputBoundary(io);
  expect(() => boundary.open({ name: "bad", path: "/tmp/midiC0D0" })).toThrow("Invalid ALSA");
  expect(io.opens).toEqual([]);
  io.character = false;
  expect(() => boundary.open({ name: "bad", path: "/dev/snd/midiC0D0" })).toThrow("character device");
  expect(io.closed).toEqual([12]);
  io.character = true; io.failure = "ENODEV";
  expect(() => boundary.open({ name: "gone", path: "/dev/snd/midiC0D0" })).toThrow("ENODEV");
  expect(io.closed).toEqual([12, 12]);
});
