// TypeScript stdio-output adaptation for id Software's code/botlib/l_log.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { closeSync, writeSync } from "node:fs";
import type { BotLogIoResult, BotLogStream } from "../botlib/log.ts";

const ok: BotLogIoResult = { kind: "ok" };

function platformFailure(error: unknown, syscall: "write" | "close"): error is Error {
  return error instanceof Error && "syscall" in error && error.syscall === syscall
    && "code" in error && typeof error.code === "string"
    && "errno" in error && typeof error.errno === "number";
}

interface CloseFailure { readonly error: unknown; readonly expected: boolean }

/** Internal FD owner created only after WritableFileSystem's containment checks.
 * Its 4096-byte printf-output profile is not a general libc/fwrite emulation. */
export class BufferedLog implements BotLogStream {
  private readonly buffer = new Uint8Array(4096);
  private pending = 0;
  private closed = false;

  constructor(
    private readonly descriptor: number,
    private readonly path: string,
    private readonly unregister: () => void,
  ) {}

  write(bytes: Uint8Array): BotLogIoResult {
    this.opened();
    let offset = 0;
    while (offset < bytes.length) {
      if (this.pending === this.buffer.length) {
        const result = this.flushPending();
        if (result.kind === "failed") return result;
      }
      const count = Math.min(this.buffer.length - this.pending, bytes.length - offset);
      this.buffer.set(bytes.subarray(offset, offset + count), this.pending);
      this.pending += count;
      offset += count;
    }
    return ok;
  }

  flush(): BotLogIoResult {
    this.opened();
    return this.flushPending();
  }

  close(): BotLogIoResult {
    if (this.closed) return ok;
    this.closed = true;
    const failures: CloseFailure[] = [];
    try {
      const result = this.flushPending();
      if (result.kind === "failed") failures.push({ error: result.error, expected: true });
    } catch (error) { failures.push({ error, expected: false }); }
    try { closeSync(this.descriptor); }
    catch (error) { failures.push({ error, expected: platformFailure(error, "close") }); }
    try { this.unregister(); }
    catch (error) { failures.push({ error, expected: false }); }
    const first = failures.shift();
    if (first === undefined) return ok;
    const failure = failures.length === 0 ? first.error
      : new AggregateError([first.error, ...failures.map(item => item.error)], "Bot log flush/close failed", { cause: first.error });
    if (first.expected && failures.every(item => item.expected) && failure instanceof Error) {
      return { kind: "failed", error: failure };
    }
    throw failure;
  }

  private opened(): void {
    if (this.closed) throw new Error(`Cannot use closed bot log stream: ${this.path}`);
  }

  private flushPending(): BotLogIoResult {
    const length = this.pending;
    this.pending = 0;
    let offset = 0;
    while (offset < length) {
      let written: number;
      try { written = writeSync(this.descriptor, this.buffer, offset, length - offset, null); }
      catch (error) {
        if (!platformFailure(error, "write")) throw error;
        return { kind: "failed", error };
      }
      if (!Number.isInteger(written) || written < 0 || written > length - offset) {
        throw new Error(`Invalid bot log write result: ${written}`);
      }
      if (written === 0) return { kind: "failed", error: new Error(`Bot log write returned zero: ${this.path}`) };
      offset += written;
    }
    return ok;
  }
}
