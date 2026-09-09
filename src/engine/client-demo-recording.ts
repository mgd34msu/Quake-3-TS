// Ported from id Software's client/cl_main.c:CL_Record_f/CL_StopRecord_f/
// CL_WriteDemoMessage and cl_scrn.c:SCR_DrawDemoRecording.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CommonFileState } from "../assets/filesystem-state.ts";
import type { WritableBinaryFile } from "../assets/writable-files.ts";
import type { CommandContext } from "../core/commands.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { MAX_MESSAGE_LENGTH, MessageWriter } from "../protocol/message.ts";
import { ServerOpcode } from "../protocol/server-message.ts";
import { writeDeltaEntity } from "../protocol/state-delta.ts";
import { EntityState } from "../shared/entity-state.ts";
import type { EngineClientSession } from "./client-session.ts";
import type { ClientConnectionState } from "./client-state.ts";

export interface ClientDemoRecordingOptions {
  readonly files: CommonFileState;
  readonly cvars: CvarRegistry;
  readonly connection: ClientConnectionState;
  readonly session: () => EngineClientSession | null;
  readonly print: (text: string) => undefined;
}

interface Recording {
  readonly file: WritableBinaryFile;
  readonly name: string;
  readonly singlePlayer: boolean;
}

function longBytes(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value, true);
  return bytes;
}

/** Connection-owned recording storage; playback owns a separate DemoReader. */
export class ClientDemoRecording {
  private recording: Recording | null = null;
  private closed = false;

  constructor(private readonly options: ClientDemoRecordingOptions) {
    if (options.connection.demoRecording !== null) throw new Error("Connection already owns a demo recorder");
    options.connection.demoRecording = this;
  }

  get active(): boolean { return this.recording !== null; }

  record(context: CommandContext): void {
    context.assertActive();
    if (this.closed) throw new Error("Demo recorder is closed");
    if (context.argv.length > 2) { this.options.print("record <demoname>\n"); return; }
    if (this.recording !== null) {
      if (!this.recording.singlePlayer) this.options.print("Already recording.\n");
      return;
    }
    const session = this.options.session();
    if (session === null || session.lifecycle.clientStatic.phase !== "active") {
      this.options.print("You must be in a level to record.\n");
      return;
    }
    if (session.lifecycle.clientConnection !== this.options.connection) throw new Error("Demo recorder belongs to another connection");
    session.lifecycle.assertCurrentOperation();
    if ((this.options.cvars.get("g_synchronousClients")?.numericValue ?? 0) === 0) {
      this.options.print("^3WARNING: You should set 'g_synchronousClients 1' for smoother demo recording\n");
    }
    let name = "demo0000";
    const requested = context.argv[1];
    if (requested !== undefined) {
      // CL_Record_f copies into demoName[MAX_QPATH] before formatting the path.
      const nul = requested.indexOf("\0");
      name = requested.slice(0, nul === -1 ? 63 : Math.min(nul, 63));
      if (/[^\x00-\xff]/.test(name)) throw new RangeError("Demo names require source byte characters");
    }
    else {
      for (let number = 0; number <= 9999; number++) {
        name = `demo${String(number).padStart(4, "0")}`;
        const length = this.options.files.current.readFileLength(`demos/${name}.dm_68`);
        context.assertActive(); session.lifecycle.assertCurrentOperation();
        if (length <= 0) break;
      }
    }
    const path = `demos/${name}.dm_68`;
    this.options.print(`recording to ${path}.\n`);
    const file = this.options.files.writable.openBinaryWrite(path);
    if (file === null) { this.options.print("ERROR: couldn't open.\n"); return; }
    this.recording = { file, name, singlePlayer: (this.options.cvars.get("ui_recordSPDemo")?.numericValue ?? 0) !== 0 };
    this.options.connection.demoWaiting = true;

    const gamestate = session.copyGamestate();
    const writer = new MessageWriter("bitstream", MAX_MESSAGE_LENGTH, session.lifecycle.sourceState);
    writer.writeLong(this.options.connection.reliable.sequence);
    writer.writeByte(ServerOpcode.Gamestate);
    writer.writeLong(gamestate.commandSequence);
    const nullState = new EntityState();
    for (const entry of gamestate.entries) {
      if (entry.kind === "configstring") {
        writer.writeByte(ServerOpcode.Configstring);
        writer.writeShort(entry.index);
        writer.writeBigString(entry.value);
      } else {
        writer.writeByte(ServerOpcode.Baseline);
        writeDeltaEntity(writer, nullState, entry.entity, true);
      }
    }
    writer.writeByte(ServerOpcode.Eof);
    writer.writeLong(gamestate.clientNumber);
    writer.writeLong(gamestate.checksumFeed);
    writer.writeByte(ServerOpcode.Eof);
    file.writeBytes(longBytes((session.serverMessageSequence - 1) | 0));
    file.writeBytes(longBytes(writer.byteLength));
    file.writeBytes(writer.toBytes());
  }

  /** receiveDatagram supplies decrypted bytes after parsing, with its channel header already removed. */
  writeMessage(session: EngineClientSession, bytes: Uint8Array): void {
    const recording = this.recording;
    if (recording === null || this.options.connection.demoWaiting) return;
    if (session !== this.options.session() || session.lifecycle.clientConnection !== this.options.connection) {
      throw new Error("Cannot record a packet from another client session");
    }
    recording.file.writeBytes(longBytes(session.serverMessageSequence));
    recording.file.writeBytes(longBytes(bytes.byteLength));
    recording.file.writeBytes(bytes);
  }

  stop(): void {
    const recording = this.recording;
    if (recording === null) { this.options.print("Not recording a demo.\n"); return; }
    recording.file.writeBytes(longBytes(-1));
    recording.file.writeBytes(longBytes(-1));
    try { recording.file.close(); }
    finally { this.recording = null; }
    this.options.print("Stopped demo.\n");
  }

  screenInfo(): { readonly name: string; readonly kibibytes: number } | null {
    const recording = this.recording;
    return recording === null || recording.singlePlayer ? null
      : { name: recording.name, kibibytes: Math.trunc(recording.file.tell() / 1024) };
  }

  /** Managed disposal consumes partial recording resources without replaying source stop commands. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const recording = this.recording;
    this.recording = null;
    if (this.options.connection.demoRecording === this) this.options.connection.demoRecording = null;
    recording?.file.close();
  }
}
