// Port of id Software's common.c Com_Printf and redirect buffer operations.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { sourceCommandText } from "./text.ts";

interface Redirect {
  readonly capacity: number;
  readonly flush: (text: string) => undefined;
  text: string;
}

/** One engine's already-formatted console stream; the normal sink owns platform/log fan-out. */
export class ConsoleOutput {
  private active: Redirect | null = null;

  constructor(private readonly normalSink: (text: string) => undefined) {}

  get redirecting(): boolean { return this.active !== null; }

  print(formatted: string): void {
    // Linux Q_vsnprintf(msg, MAXPRINTMSG, ...) leaves at most 4095 source bytes.
    const text = sourceCommandText(formatted).slice(0, 4095);
    let redirect = this.active;
    if (redirect === null) { this.normalSink(text); return; }
    if (redirect.text.length + text.length > redirect.capacity - 1) {
      redirect.flush(redirect.text);
      redirect = this.active;
      if (redirect === null) throw new RangeError("Source redirect callback cleared the buffer before append");
      redirect.text = "";
    }
    // Q_strcat truncates one oversized print after flushing; it never splits it into packets.
    redirect.text += text.slice(0, redirect.capacity - 1 - redirect.text.length);
  }

  /** Com_BeginRedirect replaces globals; zero capacity or a null callback leaves them unchanged. */
  beginRedirect(capacity: number, flush: ((text: string) => undefined) | null): void {
    if (capacity === 0 || flush === null) return;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 0x7fffffff) throw new RangeError("Console redirect requires a positive signed-int buffer size");
    this.active = { capacity, flush, text: "" };
  }

  endRedirect(): void {
    const redirect = this.active;
    if (redirect !== null) redirect.flush(redirect.text);
    this.active = null;
  }

  /** An abort does not reach Com_EndRedirect. Managed storage survives the native dangling-stack case. */
  async redirect(capacity: number, flush: (text: string) => undefined, operation: () => Promise<void>): Promise<void> {
    this.beginRedirect(capacity, flush);
    await operation();
    this.endRedirect();
  }
}
