// win32/win_input.c MidiInProc, MIDI_NoteOn and MIDI_NoteOff.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { KeyCode } from "../core/key-codes.ts";

/** MIDI 1.0 byte framing replaces WinMM's complete short-message callbacks. */
export class SourceMidiDecoder {
  private status = 0;
  private first: number | null = null;

  reset(): void { this.status = 0; this.first = null; }

  /** Time is the host message time, not the MIDI driver's relative timestamp. */
  feed(bytes: Uint8Array, channel: number, time: number,
    queueKey: (key: number, down: boolean, time: number) => undefined): void {
    for (const byte of bytes) {
      // System realtime messages can interrupt either a message or running status.
      if (byte >= 0xf8) continue;
      if (byte >= 0x80) {
        this.status = byte < 0xf0 ? byte : 0;
        this.first = null;
        continue;
      }
      if (this.status === 0) continue;
      const command = this.status & 0xf0;
      // Program change and channel pressure each have one data byte.
      if (command === 0xc0 || command === 0xd0) continue;
      if (this.first === null) { this.first = byte; continue; }
      const note = this.first;
      this.first = null;
      if ((this.status & 0x0f) + 1 !== channel) continue;
      if (command !== 0x80 && command !== 0x90) continue;
      const key = note - 60 + KeyCode.Aux1;
      if (key < KeyCode.Aux1 || key > 255) continue;
      // The source has no return after velocity-zero NoteOff: retain both events.
      if (command === 0x80 || byte === 0) queueKey(key, false, time);
      if (command === 0x90) queueKey(key, true, time);
    }
  }
}
