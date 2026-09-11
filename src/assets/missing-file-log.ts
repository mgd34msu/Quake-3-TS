// FS_MISSING from id Software's code/qcommon/files.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { closeSync, openSync, writeSync } from "node:fs";

/** Common-lived optional diagnostic file; mounts borrow it across FS_Restart. */
export class MissingFileLog {
  private descriptor: number | null = null;
  private closed = false;

  constructor(private readonly destination: string | null) {}

  startup(): void {
    if (this.closed || this.descriptor !== null || this.destination === null) return;
    try { this.descriptor = openSync(this.destination, "a"); }
    catch { /* Source fopen failure leaves diagnostics disabled until the next startup. */ }
  }

  record(path: string): void {
    if (this.descriptor === null) return;
    const bytes = Buffer.from(`${path}\n`, "latin1");
    let offset = 0;
    // Direct writes have no stdio buffer to flush; source does not request fsync.
    try {
      while (offset < bytes.length) {
        const written = writeSync(this.descriptor, bytes, offset, bytes.length - offset);
        if (written === 0) return;
        offset += written;
      }
    } catch { /* Source ignores fprintf errors; missing assets retain their ordinary result. */ }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const descriptor = this.descriptor;
    this.descriptor = null;
    if (descriptor !== null) {
      try { closeSync(descriptor); }
      catch { /* Source ignores fclose errors. */ }
    }
  }
}
