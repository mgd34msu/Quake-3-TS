/*
 * VM_LogSyscalls from code/qcommon/vm.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { openSync } from "node:fs";
import { BufferedLog } from "../assets/buffered-log.ts";

/** Dormant compiler diagnostic. The source interpreter call remains commented out. */
export class VmSyscallLog {
  private callnum = 0;
  private file: BufferedLog | null = null;
  private closed = false;

  log(dataBase: Uint8Array, args: DataView): void {
    if (this.closed) throw new Error("VM_LogSyscalls owner is closed");
    if (this.file === null) {
      try { this.file = new BufferedLog(openSync("syscalls.log", "w"), "syscalls.log", () => {}); }
      catch (cause) {
        this.callnum++;
        throw new Error("VM_LogSyscalls fopen failed; source fprintf would use a null FILE", { cause });
      }
    }
    this.callnum++;
    if (this.callnum > 0x7fffffff) throw new RangeError("VM_LogSyscalls signed call counter overflow");
    const offset = args.byteOffset - dataBase.byteOffset;
    if (args.buffer !== dataBase.buffer || offset < 0 || offset % 4 !== 0
      || dataBase.byteOffset % 4 !== 0 || offset + 20 > dataBase.byteLength || args.byteLength < 20) {
      throw new RangeError("VM_LogSyscalls requires five aligned int words in the same data allocation");
    }
    const text = `${this.callnum}: ${offset / 4} (${args.getInt32(0, true)}) = ${args.getInt32(4, true)} ${args.getInt32(8, true)} ${args.getInt32(12, true)} ${args.getInt32(16, true)}\n`;
    this.file.write(new TextEncoder().encode(text));
  }

  /** Managed process-owner disposal flushes the retained stdio buffer. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const result = this.file?.close();
    if (result?.kind === "failed") throw result.error;
  }
}
