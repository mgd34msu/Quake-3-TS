// Unix filesystem root bytes for code/qcommon/files.c:FS_BuildOSPath.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { Buffer } from "node:buffer";
import { posix } from "node:path";

/** Owns native root spelling. Host Unicode enters only through fromHost. */
export class NativeRoot {
  readonly #bytes: Buffer;

  private constructor(bytes: Buffer) { this.#bytes = bytes; }

  static fromHost(text: string): NativeRoot {
    for (let index = 0; index < text.length; index++) {
      const unit = text.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new RangeError("Host filesystem root contains an unpaired surrogate");
      } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new RangeError("Host filesystem root contains an unpaired surrogate");
    }
    if (text.includes("\0")) throw new RangeError("Filesystem root contains NUL");
    return new NativeRoot(Buffer.from(text, "utf8"));
  }

  static fromSource(text: string): NativeRoot {
    for (let index = 0; index < text.length; index++) {
      const byte = text.charCodeAt(index);
      if (byte === 0 || byte > 255) throw new RangeError("Filesystem root requires non-NUL source bytes");
    }
    return new NativeRoot(Buffer.from(text, "latin1"));
  }

  get sourceText(): string { return this.#bytes.toString("latin1"); }

  /** Resolve in the byte domain; callers receive an independent native buffer. */
  resolvedBytes(): Buffer {
    const spelling = this.sourceText;
    const cwd = NativeRoot.fromHost(process.cwd()).sourceText;
    return Buffer.from(posix.resolve(cwd, spelling === "" ? "/" : spelling), "latin1");
  }
}

/** A plain string is host Unicode at documented external filesystem entrypoints. */
export type RootInput = string | NativeRoot;

export function hostRootInput(input: RootInput): NativeRoot {
  return typeof input === "string" ? NativeRoot.fromHost(input) : input;
}
