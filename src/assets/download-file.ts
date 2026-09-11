// Server raw-file reads from id Software's code/qcommon/files.c:FS_SV_FOpenFileRead.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { closeSync, constants, fstatSync, openSync, realpathSync } from "node:fs";
import { Buffer } from "node:buffer";
import type { NativeRoot } from "./native-root.ts";
import type { BorrowedLooseRead } from "./file-handles.ts";

export type ServerDownloadErrorKind = "path" | "unsupported" | "io" | "size" | "changed";

export class ServerDownloadError extends Error {
  constructor(readonly kind: ServerDownloadErrorKind, readonly path: string, message: string, cause: unknown) {
    super(message, { cause }); this.name = "ServerDownloadError";
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isContained(root: Buffer, path: Buffer): boolean {
  return path.subarray(0, root.length).equals(root)
    && (path.length === root.length || root.at(-1) === 0x2f || path[root.length] === 0x2f);
}

function externalError(kind: ServerDownloadErrorKind, path: string, action: string, cause: unknown): ServerDownloadError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new ServerDownloadError(kind, path, `${action} ${JSON.stringify(path)}: ${detail}`, cause);
}

function descriptorPath(descriptor: number, requestedPath: string): Buffer {
  if (process.platform !== "linux") throw new ServerDownloadError("unsupported", requestedPath,
    "Secure server download descriptor containment requires Linux /proc/self/fd", undefined);
  try { return realpathSync(`/proc/self/fd/${descriptor}`, { encoding: "buffer" }); }
  catch (cause) { throw externalError("unsupported", requestedPath, "Cannot establish server download descriptor containment for", cause); }
}

function verifyDescriptorContainment(descriptor: number, root: Buffer, requestedPath: string): void {
  if (!isContained(root, descriptorPath(descriptor, requestedPath))) throw new ServerDownloadError("path", requestedPath,
    `Opened server download path escapes configured root: ${JSON.stringify(requestedPath)}`, undefined);
}

/** Descriptor acquisition only. ServerFileSystem supplies source search/handle/sound ordering. */
export function openDownloadDescriptor(root: NativeRoot, name: string): { readonly descriptor: number; readonly root: Buffer } | undefined {
  if (process.platform !== "linux") throw new ServerDownloadError("unsupported", name,
    "Secure server download descriptor containment requires Linux /proc/self/fd", undefined);
  for (let index = 0; index < name.length; index++) {
    const byte = name.charCodeAt(index);
    if (byte === 0 || byte > 255) throw new ServerDownloadError("path", name,
      "Server download filenames require non-NUL source bytes", undefined);
  }
  let rootBytes: Buffer, canonical: Buffer;
  try { rootBytes = realpathSync(root.resolvedBytes(), { encoding: "buffer" }); }
  catch (cause) { throw externalError("io", root.sourceText, "Cannot resolve server download root", cause); }
  const requested = Buffer.concat([rootBytes, Buffer.from("/"), Buffer.from(name.replaceAll("\\", "/"), "latin1")]);
  try { canonical = realpathSync(requested, { encoding: "buffer" }); }
  catch (cause) {
    if (isMissing(cause)) return undefined;
    throw externalError("io", name, "Cannot resolve server download path", cause);
  }
  if (!isContained(rootBytes, canonical)) throw new ServerDownloadError("path", name,
    `Server download path escapes configured root: ${JSON.stringify(name)}`, undefined);
  let descriptor: number;
  try { descriptor = openSync(canonical, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (cause) {
    if (isMissing(cause)) return undefined;
    throw externalError("io", name, "Cannot open server download file", cause);
  }
  try {
    verifyDescriptorContainment(descriptor, rootBytes, name);
    const information = fstatSync(descriptor);
    if (!information.isFile()) { closeSync(descriptor); return undefined; }
    if (!Number.isSafeInteger(information.size) || information.size < 0 || information.size > 0x7fffffff)
      throw new ServerDownloadError("size", name, `Server download file size ${information.size} is outside signed 32-bit protocol range`, undefined);
    return { descriptor, root: rootBytes };
  } catch (cause) {
    try { closeSync(descriptor); } catch { /* Preserve the validation error. */ }
    if (cause instanceof ServerDownloadError) throw cause;
    throw externalError("io", name, "Cannot inspect server download file", cause);
  }
}

/** A download borrows a common loose-read row; the common filesystem owns its descriptor. */
export class ServerDownloadFile {
  private closed = false;
  private readonly root: Buffer;

  constructor(private readonly resource: BorrowedLooseRead, readonly size: number,
    private readonly requestedPath: string) {
    try {
      resource.assertCurrent();
      this.root = Buffer.from(resource.root);
      verifyDescriptorContainment(resource.descriptor, this.root, requestedPath);
    } catch (cause) {
      this.closed = true;
      try { resource.close(); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], "Download borrow validation and release failed"); }
      throw cause;
    }
  }

  private closeForFailure(): unknown {
    if (this.closed) return undefined;
    this.closed = true;
    try { this.resource.close(); return undefined; } catch (cause) { return cause; }
  }

  private verifyUnchanged(): void {
    let observedSize: number;
    try {
      this.resource.assertCurrent();
      verifyDescriptorContainment(this.resource.descriptor, this.root, this.requestedPath);
      observedSize = fstatSync(this.resource.descriptor).size;
    } catch (cause) {
      this.closeForFailure();
      if (cause instanceof ServerDownloadError) throw cause;
      throw externalError("io", this.requestedPath, "Cannot inspect open server download file", cause);
    }
    if (observedSize !== this.size) {
      const closeCause = this.closeForFailure();
      throw new ServerDownloadError("changed", this.requestedPath,
        `Server download file changed size from ${this.size} to ${observedSize}`, closeCause);
    }
  }

  read(target: Uint8Array): number {
    if (this.closed) throw new Error("Server download file is closed");
    this.verifyUnchanged();
    let count: number;
    try { count = this.resource.readInto(target); }
    catch (cause) {
      this.closeForFailure();
      throw externalError("io", this.requestedPath, "Cannot read server download file", cause);
    }
    this.verifyUnchanged();
    return count;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.resource.close(); }
    catch (cause) { throw externalError("io", this.requestedPath, "Cannot close server download file", cause); }
  }
}
