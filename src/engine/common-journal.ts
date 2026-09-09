// Port of id Software's common.c Com_InitJournaling/Com_GetRealEvent and files.c FS_ReadFile.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { FileHandle } from "../assets/file-handles.ts";
import type { CommonFileState } from "../assets/filesystem-state.ts";
import type { ReadFileMemory, RetainedFileBuffer } from "../assets/read-file-memory.ts";
import type { ConfigFileJournal } from "../assets/vfs.ts";
import { CommonError } from "../core/common-error.ts";
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import type { CommonEventSource, CommonSystemEvent } from "./common-events.ts";
import type { CommonEventMemory } from "./event-memory.ts";

/** Native journals have no format header. Foreign ABI detection is not possible in general. */
export const COMMON_JOURNAL_ABI = "linux-x86_64-le-lp64";
const EVENT_BYTES = 32;
// Only authored replay data can exceed the bounded Unix console/packet producers.
const MAX_JOURNAL_EVENT_BYTES = 128 * 1024 * 1024;

function intBytes(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value, true);
  return bytes;
}

function eventHeader(event: CommonSystemEvent, payloadLength: number): Uint8Array {
  // LP64 aligns evPtr at 24. Padding and the unused saved pointer are zero in the TS producer.
  const bytes = new Uint8Array(EVENT_BYTES), view = new DataView(bytes.buffer);
  view.setInt32(0, event.time, true);
  view.setInt32(16, payloadLength, true);
  switch (event.kind) {
    case "none": break;
    case "key": view.setInt32(4, 1, true); view.setInt32(8, event.key, true); view.setInt32(12, Number(event.down), true); break;
    case "character": view.setInt32(4, 2, true); view.setInt32(8, event.character, true); break;
    case "mouse": view.setInt32(4, 3, true); view.setInt32(8, event.dx, true); view.setInt32(12, event.dy, true); break;
    case "joystick": view.setInt32(4, 4, true); view.setInt32(8, event.axis, true); view.setInt32(12, event.value, true); break;
    case "console": view.setInt32(4, 5, true); break;
    case "packet": view.setInt32(4, 6, true); break;
    default: { const exhaustive: never = event; return exhaustive; }
  }
  return bytes;
}

/** Common owns the journal borrows; the filesystem owns every actual descriptor, including failed-init orphans. */
export class CommonJournal implements ConfigFileJournal {
  private phase: "inert" | "initialized" | "retired" = "inert";
  private events: FileHandle | null = null;
  private data: FileHandle | null = null;

  constructor(private readonly cvars: CvarRegistry, private readonly files: () => CommonFileState,
    private readonly print: (text: string) => undefined, private readonly debugPrint: (text: string) => undefined,
    private readonly assertEntry: () => undefined, private readonly memory: CommonEventMemory) {}

  get mode(): number {
    this.entry();
    if (this.phase === "inert") return 0;
    const journal = this.cvars.find("journal");
    if (journal === undefined) throw new Error("Common journal cvar is not registered");
    return journal.integerValue;
  }

  initialize(): void {
    this.entry();
    if (this.phase !== "inert") throw new Error("Common journaling is already initialized");
    this.cvars.register("journal", "0", CvarFlag.Init);
    this.phase = "initialized";
    if (this.mode === 0) return;
    if (this.mode === 1) {
      this.print("Journaling events\n"); this.entry();
      this.events = this.files().writable.openByMode("journal.dat", "write");
      this.data = this.files().writable.openByMode("journaldata.dat", "write");
    } else if (this.mode === 2) {
      this.print("Replaying journaled events\n"); this.entry();
      const events = this.files().current.openUniqueRead("journal.dat", file => { this.events = file; });
      if (events === undefined) this.events = null;
      const data = this.files().current.openUniqueRead("journaldata.dat", file => { this.data = file; });
      if (data === undefined) this.data = null;
    }
    if (this.events === null || this.data === null) {
      // The source sets this distinct cvar, leaving journal's selected mode intact.
      this.cvars.set("com_journal", "0", true);
      this.events = null; this.data = null;
      this.print("Couldn't open journal files\n"); this.entry();
    }
  }

  getEvent(source: CommonEventSource): CommonSystemEvent {
    if (this.mode === 2) {
      const bytes = new Uint8Array(EVENT_BYTES);
      if (this.read(this.events, bytes) !== EVENT_BYTES) throw new CommonError("fatal", "Error reading from journal file");
      const header = new DataView(bytes.buffer), length = header.getInt32(16, true);
      if (length < 0 || length > MAX_JOURNAL_EVENT_BYTES) throw new CommonError("fatal", `Invalid journal event payload: ${length}`);
      const pointer = length === 0 ? null : this.memory.allocatePayload(length);
      if (pointer !== null && this.read(this.events, pointer.block.bytes) !== length) throw new CommonError("fatal", "Error reading from journal file");
      return this.memory.journalEvent(header, pointer);
    }
    const received = source.getEvent(); this.entry();
    const event = this.memory.own(received);
    if (this.mode === 1) {
      const payload = this.memory.payload(event), header = eventHeader(event, payload?.byteLength ?? 0);
      if (this.write(this.events, header) !== EVENT_BYTES) throw new CommonError("fatal", "Error writing to journal file");
      if (payload !== null && payload.byteLength !== 0 && this.write(this.events, payload) !== payload.byteLength) throw new CommonError("fatal", "Error writing to journal file");
    }
    return event;
  }

  readLength(path: string): number {
    const length = this.configLength(path);
    return length === null ? -1 : length === 0 ? 1 : length;
  }

  readFileRetained(path: string, memory: ReadFileMemory): RetainedFileBuffer | undefined {
    const length = this.configLength(path);
    if (length === null || length === 0) return undefined;
    if (length < 0) throw new CommonError("fatal", `Invalid journal config length: ${length}`);
    return memory.read(length, bytes => {
      if (this.read(this.data, bytes) !== length) throw new CommonError("fatal", "Read from journalDataFile failed");
    }, "journal");
  }

  readFile(path: string): Uint8Array | undefined {
    const length = this.configLength(path);
    if (length === null || length === 0) return undefined;
    const bytes = this.allocate(length, "config length");
    if (this.read(this.data, bytes) !== length) throw new CommonError("fatal", "Read from journalDataFile failed");
    return bytes;
  }

  private configLength(path: string): number | null {
    this.entry(); this.debugPrint(`Loading ${path} from journal file.\n`); this.entry();
    const bytes = new Uint8Array(4);
    return this.read(this.data, bytes) === 4 ? new DataView(bytes.buffer).getInt32(0, true) : null;
  }

  writeLength(path: string, length: number): void {
    this.entry();
    this.debugPrint(length === -1 ? `Writing zero for ${path} to journal file.\n` : `Writing len for ${path} to journal file.\n`);
    this.entry(); this.write(this.data, intBytes(length === -1 ? 0 : length));
    // FS_Flush is fflush, not fsync. Common binary descriptors are already unbuffered.
  }

  writeFile(path: string, bytes: Uint8Array | undefined): void {
    this.entry();
    this.debugPrint(bytes === undefined ? `Writing zero for ${path} to journal file.\n` : `Writing ${path} to journal file.\n`);
    this.entry(); this.write(this.data, intBytes(bytes === undefined ? 0 : bytes.byteLength));
    if (bytes !== undefined) this.write(this.data, bytes);
  }

  private allocate(length: number, field: string): Uint8Array {
    if (length < 0 || length >= 0x7fffffff) throw new CommonError("fatal", `Invalid journal ${field}: ${length}`);
    return new Uint8Array(length);
  }

  private read(file: FileHandle | null, bytes: Uint8Array): number {
    this.entry();
    return this.files().readFile(file?.slot ?? 0, bytes);
  }

  private write(file: FileHandle | null, bytes: Uint8Array): number {
    this.entry();
    const count = this.files().writeFile(file?.slot ?? 0, bytes); this.entry();
    return count;
  }

  /** Com_Shutdown closes only journal.dat. journaldata.dat survives until FS_Shutdown/disposal. */
  shutdown(): void {
    this.entry();
    const events = this.events;
    if (events === null) return;
    this.files().closeFile(events.slot);
    this.events = null;
  }

  /** Final disposal has no callbacks or file operations. CommonFileState releases all descriptors. */
  retire(): void { this.phase = "retired"; this.events = null; this.data = null; }

  private entry(): void {
    if (this.phase === "retired") throw new Error("Common journal is retired");
    this.assertEntry();
  }
}
