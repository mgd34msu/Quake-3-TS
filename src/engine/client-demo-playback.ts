// Ported from id Software's client/cl_main.c:CL_ReadDemoMessage,
// CL_PlayDemo_f/CL_WalkDemoExt and qcommon/common.c:demo_protocols.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { FileHandle } from "../assets/file-handles.ts";
import type { CommonFileState } from "../assets/filesystem-state.ts";
import { CommonError } from "../core/common-error.ts";
import { nativeAtoi } from "../core/native-numeric.ts";
import type { DemoEnd, DemoMessage, DemoMessageReader } from "../protocol/demo.ts";
import { MAX_MESSAGE_LENGTH } from "../protocol/message.ts";

const DEMO_PROTOCOLS: readonly number[] = [66, 67, 68];
// q_shared.h selects PATH_MAX on the Linux source target, otherwise 256.
const MAX_OSPATH = 4096;

function demoPath(text: string, print: (text: string) => undefined): string {
  // q_shared.c:Com_sprintf checks its scratch buffer before the destination.
  if (text.length >= 32000) throw new CommonError("fatal", "Com_sprintf: overflowed bigbuffer");
  if (text.length >= MAX_OSPATH) print(`Com_sprintf: overflow of ${text.length} in ${MAX_OSPATH}\n`);
  return text.slice(0, MAX_OSPATH - 1);
}

/** The connection retains its unique file through gamestate filesystem restarts. */
export class ClientDemoPlayback implements DemoMessageReader {
  private position = 0;
  private ended: DemoEnd | null = null;
  private file: FileHandle | null;
  private demoName = "";

  private constructor(
    private readonly files: CommonFileState,
    readonly source: string,
    file: FileHandle,
    private readonly print: (text: string) => undefined,
  ) {
    this.file = file;
  }

  static open(files: CommonFileState, name: string, print: (text: string) => undefined,
    publish: (playback: ClientDemoPlayback) => undefined): ClientDemoPlayback {
    const nul = name.indexOf("\0");
    if (nul !== -1) name = name.slice(0, nul);
    if (/[^\x00-\xff]/.test(name)) throw new RangeError("Demo names require source byte characters");
    const extension = name.slice(-6);
    let stem = name;
    if (name.length > 6 && /^\.dm_/i.test(extension)) {
      const protocol = nativeAtoi(extension.slice(4));
      if (DEMO_PROTOCOLS.includes(protocol)) {
        const source = demoPath(`demos/${name}`, print);
        const opened = files.current.openUniqueRead(source);
        if (opened === undefined) throw new CommonError("drop", `couldn't open ${source}`);
        const playback = new ClientDemoPlayback(files, source, opened.file, print);
        publish(playback);
        playback.demoName = name.slice(0, 63);
        return playback;
      }
      print(`Protocol ${protocol} not supported for demos\n`);
      const retry = name.slice(0, MAX_OSPATH - 1);
      stem = retry.slice(0, retry.length - 6);
    }
    let source = "";
    for (const protocol of DEMO_PROTOCOLS) {
      source = demoPath(`demos/${stem}.dm_${protocol}`, print);
      const opened = files.current.openUniqueRead(source);
      if (opened !== undefined) {
        const playback = new ClientDemoPlayback(files, source, opened.file, print);
        // CL_WalkDemoExt publishes clc.demofile before printing; CL_Disconnect owns cleanup.
        publish(playback);
        print(`Demo file: ${source}\n`);
        playback.demoName = name.slice(0, 63);
        return playback;
      }
      print(`Not found: ${source}\n`);
    }
    throw new CommonError("drop", `couldn't open ${source}`);
  }

  get name(): string { return this.demoName; }
  get offset(): number { return this.position; }

  next(onSequence: (sequence: number) => undefined): DemoMessage | DemoEnd {
    if (this.ended !== null) return this.ended;
    const start = this.position;
    const file = this.file;
    if (file === null) return this.end("eof", start);
    const word = new Uint8Array(4);
    const sequenceCount = this.read(file, word);
    if (sequenceCount !== 4) return this.end(sequenceCount === 0 ? "eof" : "truncated-header", start);
    const view = new DataView(word.buffer);
    const sequence = view.getInt32(0, true);
    onSequence(sequence);
    if (this.read(file, word) !== 4) return this.end("truncated-header", start);
    const length = view.getInt32(0, true);
    if (length === -1) return this.end("terminator", start);
    if (length > MAX_MESSAGE_LENGTH) throw new CommonError("drop", "CL_ReadDemoMessage: demoMsglen > MAX_MSGLEN");
    // Other negative lengths reach an invalid native read in the source.
    if (length < 0) throw new CommonError("drop", `CL_ReadDemoMessage: invalid negative demoMsglen ${length}`);
    const payload = new Uint8Array(length);
    if (this.read(file, payload) !== length) {
      this.print("Demo file was truncated.\n");
      return this.end("truncated-payload", start);
    }
    return { kind: "message", sequence, payload };
  }

  private read(file: FileHandle, destination: Uint8Array): number {
    const count = this.files.current.readInto(file, destination);
    this.position += count;
    return count;
  }

  private end(reason: DemoEnd["reason"], offset: number): DemoEnd {
    this.ended = { kind: "end", reason, offset };
    return this.ended;
  }

  /** CL_Disconnect closes after the completion callback has reported timedemo. */
  close(): void {
    const file = this.file;
    this.file = null;
    if (file !== null) this.files.current.closeFile(file);
  }
}
