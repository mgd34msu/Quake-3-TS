// Ported from id Software's code/botlib/l_log.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { BotLibVars } from "./libvars.ts";

export type BotLogIoResult =
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly error: Error };

export interface BotLogStream {
  write(bytes: Uint8Array): BotLogIoResult;
  flush(): BotLogIoResult;
  close(): BotLogIoResult;
}

export type BotLogOpenResult =
  | { readonly kind: "opened"; readonly stream: BotLogStream }
  | { readonly kind: "failed"; readonly error: Error };

export interface BotLogFile { write(formatted: string): number | void }
export interface BotLogGlobals { readonly time: number }
export interface BotLogOptions {
  readonly variables: BotLibVars;
  readonly globals: BotLogGlobals;
  readonly print: (severity: 1 | 3, text: string) => undefined;
  readonly openFile: (filename: string) => BotLogOpenResult;
}

interface OpenLog { stream: BotLogStream | null; readonly file: BotLogFile }
const ok: BotLogIoResult = { kind: "ok" };

function liveStream(entry: OpenLog): BotLogStream {
  if (entry.stream === null) throw new Error("Bot log source FILE is closed but its pointer is retained");
  return entry.stream;
}

function outputBytes(formatted: string): Uint8Array {
  const bytes = new Uint8Array(formatted.length);
  for (let index = 0; index < formatted.length; index++) {
    const byte = formatted.charCodeAt(index);
    if (byte > 255) throw new RangeError("Bot log output requires byte-valued characters");
    bytes[index] = byte;
  }
  return bytes;
}

function filenameString(filename: string): string {
  const nul = filename.indexOf("\0");
  const name = nul < 0 ? filename : filename.slice(0, nul);
  for (let index = 0; index < name.length; index++) {
    if (name.charCodeAt(index) > 255) throw new RangeError("Bot log filename requires byte-valued characters before NUL");
  }
  return name;
}

function sourceInteger(value: number): number {
  const integer = Math.trunc(value);
  if (!Number.isFinite(integer) || integer < -2147483648 || integer > 2147483647) {
    throw new RangeError("Log_WriteTimeStamped: source float-to-int conversion is undefined");
  }
  return integer;
}

function checkedIntegerArithmetic(value: number): number {
  if (value < -2147483648 || value > 2147483647) {
    throw new RangeError("Log_WriteTimeStamped: source signed arithmetic would overflow");
  }
  return value;
}

function twoDigits(value: number): string {
  return value < 0 ? `-${String(-value).padStart(1, "0")}` : String(value).padStart(2, "0");
}

/** One linked library's logger, independent of its setup and map allocations. */
export class BotLog {
  private current: OpenLog | null = null;
  private filename = "";
  private numwrites = 0;

  constructor(private readonly options: BotLogOptions) {}

  open(filename: string | null): BotLogIoResult {
    if (this.options.variables.value("log", "0") === 0) return ok;
    const name = filename === null ? "" : filenameString(filename);
    if (name.length === 0) {
      this.options.print(1, "openlog <filename>\n");
      return ok;
    }
    if (this.current !== null) {
      this.options.print(3, `log file ${this.storedFilename()} is already opened\n`);
      return ok;
    }
    const opened = this.options.openFile(name);
    if (opened.kind === "failed") {
      return this.printOutcome(3, `can't open the log file ${name}\n`, opened);
    }
    let entry: OpenLog;
    entry = {
      stream: opened.stream,
      file: { write: formatted => {
        if (this.current !== entry) throw new Error("Cannot write a closed bot log borrow");
        const result = liveStream(entry).write(outputBytes(formatted));
        return result.kind === "ok" ? formatted.length : -1;
      } },
    };
    this.current = entry;
    this.filename = name.slice(0, 1024);
    // The source has already opened/truncated and copied its fixed name buffer.
    this.options.print(1, `Opened log ${this.storedFilename()}\n`);
    return ok;
  }

  close(): BotLogIoResult {
    const entry = this.current;
    if (entry === null) return ok;
    const result = liveStream(entry).close();
    entry.stream = null;
    if (result.kind === "ok") this.current = null;
    try {
      const name = this.storedFilename();
      this.options.print(result.kind === "failed" ? 3 : 1,
        result.kind === "failed" ? `can't close log file ${name}\n` : `Closed log ${name}\n`);
    } catch (error) {
      if (result.kind === "failed") {
        throw new AggregateError([result.error, error], "Bot log close and diagnostic failed", { cause: result.error });
      }
      throw error;
    }
    return result;
  }

  shutdown(): BotLogIoResult { return this.close(); }

  disposeResources(): BotLogIoResult {
    const entry = this.current;
    if (entry === null) return ok;
    this.current = null;
    const stream = entry.stream;
    entry.stream = null;
    return stream === null ? ok : stream.close();
  }

  write(formatted: string): void {
    const entry = this.current;
    if (entry === null) return;
    liveStream(entry).write(outputBytes(formatted));
    liveStream(entry).flush();
  }

  writeTimeStamped(formatted: string): void {
    const entry = this.current;
    if (entry === null) return;
    const time = Math.fround(this.options.globals.time);
    const hours = sourceInteger(Math.fround(Math.fround(time / 60) / 60));
    const minutes = sourceInteger(Math.fround(time / 60));
    const seconds = sourceInteger(time);
    const centiseconds = sourceInteger(Math.fround(time * 100));
    const wholeCentiseconds = checkedIntegerArithmetic(seconds * 100);
    const fraction = checkedIntegerArithmetic(centiseconds - wholeCentiseconds);
    const prefix = `${this.numwrites}   ${twoDigits(hours)}:${twoDigits(minutes)}:${twoDigits(seconds)}:${twoDigits(fraction)}   `;
    liveStream(entry).write(outputBytes(prefix));
    liveStream(entry).write(outputBytes(formatted));
    liveStream(entry).write(new Uint8Array([13, 10]));
    if (this.numwrites === 2147483647) {
      throw new RangeError("Log_WriteTimeStamped: source numwrites increment would overflow");
    }
    this.numwrites++;
    liveStream(entry).flush();
  }

  filePointer(): BotLogFile | null { return this.current?.file ?? null; }
  flush(): void { if (this.current !== null) liveStream(this.current).flush(); }

  private storedFilename(): string {
    if (this.filename.length === 1024) {
      throw new RangeError("Log_Open: source stored filename is not NUL-terminated");
    }
    return this.filename;
  }

  private printOutcome(severity: 1 | 3, text: string, result: BotLogIoResult): BotLogIoResult {
    try { this.options.print(severity, text); }
    catch (error) {
      if (result.kind === "failed") {
        throw new AggregateError([result.error, error], "Bot log I/O and diagnostic failed", { cause: result.error });
      }
      throw error;
    }
    return result;
  }
}
