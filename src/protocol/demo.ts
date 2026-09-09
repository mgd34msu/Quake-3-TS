// Port of id Software's client/cl_main.c demo framing. GPL-2.0-or-later.
// Copyright (C) 1999-2005 Id Software, Inc.
import { BinaryError } from "../core/binary.ts";
import { MAX_MESSAGE_LENGTH } from "./message.ts";

export interface DemoMessage {
  readonly kind: "message";
  readonly sequence: number;
  readonly payload: Uint8Array;
}

export interface DemoEnd {
  readonly kind: "end";
  readonly reason: "terminator" | "eof" | "truncated-header" | "truncated-payload";
  readonly offset: number;
}

export interface DemoMessageReader {
  /** Publish a complete sequence word synchronously before reading its length. */
  next(onSequence: (sequence: number) => undefined): DemoMessage | DemoEnd;
}

/** CL_ReadDemoMessage completion reasons are observable without treating partial files as complete recordings. */
export class DemoReader implements DemoMessageReader {
  private readonly view: DataView;
  private position = 0;
  private ended: DemoEnd | null = null;

  constructor(private readonly bytes: Uint8Array, readonly source = "<demo>") {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get offset(): number { return this.position; }

  next(onSequence: (sequence: number) => undefined): DemoMessage | DemoEnd {
    if (this.ended !== null) return this.ended;
    const start = this.position;
    const remaining = this.bytes.length - start;
    if (remaining === 0) return this.end("eof", start);
    if (remaining < 4) { this.position = this.bytes.length; return this.end("truncated-header", start); }
    const sequence = this.view.getInt32(start, true);
    this.position += 4;
    onSequence(sequence);
    if (remaining < 8) { this.position = this.bytes.length; return this.end("truncated-header", start); }
    const length = this.view.getInt32(start + 4, true);
    this.position += 4;
    if (length === -1) return this.end("terminator", start);
    if (length < 0 || length > MAX_MESSAGE_LENGTH) throw new BinaryError(this.source, start + 4, `Invalid demo message length ${length}`);
    if (length > this.bytes.length - this.position) { this.position = this.bytes.length; return this.end("truncated-payload", start); }
    const payload = new Uint8Array(this.bytes.subarray(this.position, this.position + length));
    this.position += length;
    return { kind: "message", sequence, payload };
  }

  private end(reason: DemoEnd["reason"], offset: number): DemoEnd {
    this.ended = { kind: "end", reason, offset };
    return this.ended;
  }
}

/** Recording payloads exclude the netchannel header, as CL_WriteDemoMessage does. */
export function encodeDemo(messages: readonly DemoMessage[]): Uint8Array {
  let length = 8;
  for (const message of messages) {
    if (!Number.isInteger(message.sequence) || message.sequence < -0x80000000 || message.sequence > 0x7fffffff) throw new RangeError("Demo sequence must be int32");
    if (message.payload.length > MAX_MESSAGE_LENGTH) throw new RangeError("Demo message exceeds MAX_MSGLEN");
    length += 8 + message.payload.length;
    if (!Number.isSafeInteger(length)) throw new RangeError("Demo size exceeds safe integer range");
  }
  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const message of messages) {
    view.setInt32(offset, message.sequence, true);
    view.setInt32(offset + 4, message.payload.length, true);
    output.set(message.payload, offset + 8);
    offset += 8 + message.payload.length;
  }
  view.setInt32(offset, -1, true);
  view.setInt32(offset + 4, -1, true);
  return output;
}
