// SPDX-License-Identifier: GPL-2.0-or-later
// Windows replacement for the source filesystem's descriptor operations.
// ABI: Microsoft ntdef.h/winternl.h, NtCreateFile and NtSetInformationFile.
// Bun 1.3.14 src/sys_jsc/fd_jsc.zig and src/symbols.def define the fd bridge.
import { dlopen, linkSymbols, ptr } from "bun:ffi";
import type { Pointer } from "bun:ffi";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { endianness } from "node:os";
import { win32 } from "node:path";
import type { FileChildInformation, FileNativeOperations } from "./file-native-types.ts";

const FILE_READ_DATA = 0x0001;
const FILE_WRITE_DATA = 0x0002;
const FILE_APPEND_DATA = 0x0004;
const FILE_TRAVERSE = 0x0020;
const FILE_READ_ATTRIBUTES = 0x0080;
const DELETE = 0x00010000;
const SYNCHRONIZE = 0x00100000;
const FILE_DIRECTORY_FILE = 0x0001;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x0020;
const FILE_NON_DIRECTORY_FILE = 0x0040;
const FILE_OPEN_REPARSE_POINT = 0x00200000;
const FILE_ATTRIBUTE_DIRECTORY = 0x0010;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x0400;
const FILE_OPEN = 1;
const FILE_CREATE = 2;
const FILE_OPEN_IF = 3;
const FILE_SHARE_ALL = 7;

function loadKernel() {
  return dlopen("kernel32.dll", {
    GetModuleHandleW: { args: ["ptr"], returns: "ptr" },
    GetProcAddress: { args: ["ptr", "ptr"], returns: "ptr" },
    GetFinalPathNameByHandleW: { args: ["u64", "buffer", "u32", "u32"], returns: "u32" },
    GetLastError: { args: [], returns: "u32" },
    GetCurrentProcess: { args: [], returns: "u64" },
    DuplicateHandle: { args: ["u64", "u64", "u64", "buffer", "u32", "i32", "u32"], returns: "i32" },
  });
}

function loadNt() {
  // Windows x64/arm64 pass HANDLE and uint64 through the same integer ABI.
  // Out handles stay uint64 values; no unbranded number becomes a Bun Pointer.
  return dlopen("ntdll.dll", {
    NtCreateFile: {
      args: ["buffer", "u32", "buffer", "buffer", "ptr", "u32", "u32", "u32", "u32", "ptr", "u32"],
      returns: "i32",
    },
    NtQueryInformationFile: { args: ["u64", "buffer", "buffer", "u32", "u32"], returns: "i32" },
    NtSetInformationFile: { args: ["u64", "buffer", "buffer", "u32", "u32"], returns: "i32" },
    NtClose: { args: ["u64"], returns: "i32" },
    RtlNtStatusToDosError: { args: ["i32"], returns: "u32" },
  });
}

function loadBunDescriptors(kernel: ReturnType<typeof loadKernel>) {
  const executable = kernel.symbols.GetModuleHandleW(null);
  if (executable === null) throw new Error("Cannot resolve the running Bun executable");
  function symbol(name: string): Pointer {
    const address = kernel.symbols.GetProcAddress(executable, Buffer.from(`${name}\0`));
    if (address === null) throw new Error(`Bun does not export the required Windows file service ${name}`);
    return address;
  }
  // Resolve Bun's own libuv, which owns its CRT descriptor table. Loading a
  // different CRT DLL would associate handles with a different table.
  return linkSymbols({
    uv_get_osfhandle: { args: ["i32"], returns: "u64", ptr: symbol("uv_get_osfhandle") },
    uv_open_osfhandle: { args: ["u64"], returns: "i32", ptr: symbol("uv_open_osfhandle") },
    uv_translate_sys_error: { args: ["i32"], returns: "i32", ptr: symbol("uv_translate_sys_error") },
    uv_err_name: { args: ["i32"], returns: "cstring", ptr: symbol("uv_err_name") },
  });
}

class WindowsFileError extends Error {
  constructor(readonly code: string, readonly errno: number, readonly syscall: string) {
    super(`${code}: Windows file operation ${syscall} failed`);
  }
}

class WindowsFileOperations implements FileNativeOperations {
  private readonly kernel;
  private readonly nt;
  private readonly descriptors;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  constructor() {
    const kernel = loadKernel();
    try {
      const nt = loadNt();
      try {
        this.descriptors = loadBunDescriptors(kernel);
        this.nt = nt;
        this.kernel = kernel;
      } catch (error) { nt.close(); throw error; }
    } catch (error) { kernel.close(); throw error; }
  }

  private failure(win32Error: number, syscall: string, code?: string): WindowsFileError {
    const errno = this.descriptors.symbols.uv_translate_sys_error(win32Error);
    return new WindowsFileError(code ?? String(this.descriptors.symbols.uv_err_name(errno)), errno, syscall);
  }

  private check(status: number, syscall: string): void {
    if (status < 0) throw this.failure(this.nt.symbols.RtlNtStatusToDosError(status), syscall);
  }

  private handle(descriptor: number): bigint {
    if (!Number.isInteger(descriptor) || descriptor < 0 || descriptor > 0x7fffffff) {
      throw this.failure(6, "uv_get_osfhandle");
    }
    const handle = this.descriptors.symbols.uv_get_osfhandle(descriptor);
    if (handle === 0n || handle >= 0xfffffffffffffffen) throw this.failure(6, "uv_get_osfhandle");
    return handle;
  }

  private publish(handle: bigint): number {
    const descriptor = this.descriptors.symbols.uv_open_osfhandle(handle);
    if (descriptor < 0) {
      this.nt.symbols.NtClose(handle);
      throw this.failure(4, "uv_open_osfhandle");
    }
    return descriptor;
  }

  private decode(bytes: Buffer): string {
    let name: string;
    try { name = this.decoder.decode(bytes); }
    catch { throw this.failure(87, "decodePath"); }
    if (name.includes("\0")) throw this.failure(87, "decodePath");
    return name;
  }

  private childName(bytes: Buffer): string {
    const name = this.decode(bytes);
    // One NT component only. Colons would select an alternate data stream;
    // trailing spaces/dots and DOS devices alias ordinary Win32 filenames.
    if (name.length === 0 || name === "." || name === ".." || /[\\/:<>"|?*\x00-\x1f]/.test(name)
      || /[ .]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) {
      throw this.failure(87, "childName");
    }
    return name;
  }

  private openHandle(parent: bigint, name: string, access: number, disposition: number, options: number): bigint {
    const bytes = Buffer.from(name, "utf16le");
    if (bytes.byteLength === 0 || bytes.byteLength > 0xfffe) throw this.failure(206, "NtCreateFile");
    const unicode = Buffer.alloc(16);
    unicode.writeUInt16LE(bytes.byteLength, 0);
    unicode.writeUInt16LE(bytes.byteLength, 2);
    unicode.writeBigUInt64LE(BigInt(ptr(bytes)), 8);
    const attributes = Buffer.alloc(48);
    attributes.writeUInt32LE(48, 0);
    attributes.writeBigUInt64LE(parent, 8);
    attributes.writeBigUInt64LE(BigInt(ptr(unicode)), 16);
    attributes.writeUInt32LE(0x40, 24); // OBJ_CASE_INSENSITIVE
    const result = Buffer.alloc(8);
    const io = Buffer.alloc(16);
    this.check(this.nt.symbols.NtCreateFile(result, access | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      attributes, io, null, 0x80, FILE_SHARE_ALL, disposition,
      options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT, null, 0), "NtCreateFile");
    const handle = result.readBigUInt64LE(0);
    if (handle === 0n || handle >= 0xfffffffffffffffen) throw this.failure(6, "NtCreateFile");
    // Referencing both nested buffers after the foreign call retains backing
    // storage while Windows reads pointers embedded in OBJECT_ATTRIBUTES.
    if (unicode.readUInt16LE(0) !== bytes.byteLength) {
      this.nt.symbols.NtClose(handle);
      throw this.failure(87, "NtCreateFile");
    }
    return handle;
  }

  private attributes(handle: bigint): number {
    const result = Buffer.alloc(8);
    this.check(this.nt.symbols.NtQueryInformationFile(handle, Buffer.alloc(16), result, 8, 35),
      "NtQueryInformationFile");
    return result.readUInt32LE(0);
  }

  private rejectReparse(handle: bigint): void {
    if ((this.attributes(handle) & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
      throw this.failure(1921, "openChild", "ELOOP");
    }
  }

  private acquire(parent: bigint, name: string, access: number, disposition: number, options: number): bigint {
    const handle = this.openHandle(parent, name, access, disposition, options);
    try { this.rejectReparse(handle); return handle; }
    catch (error) { this.nt.symbols.NtClose(handle); throw error; }
  }

  descriptorPath(descriptor: number): Buffer {
    const result = Buffer.alloc(0x10000);
    const length = this.kernel.symbols.GetFinalPathNameByHandleW(this.handle(descriptor), result, result.length / 2, 0);
    if (length === 0) throw this.failure(this.kernel.symbols.GetLastError(), "GetFinalPathNameByHandleW");
    if (length >= result.length / 2) throw this.failure(206, "GetFinalPathNameByHandleW");
    let path = result.toString("utf16le", 0, length * 2);
    if (path.startsWith("\\\\?\\UNC\\")) path = `\\\\${path.slice(8)}`;
    else if (/^\\\\\?\\[a-z]:\\/i.test(path)) path = path.slice(4);
    else throw this.failure(87, "GetFinalPathNameByHandleW");
    return Buffer.from(path.replaceAll("\\", "/"));
  }

  descriptorPosition(descriptor: number): number {
    // FileAllInformation, also used by libuv's fstat, includes the position
    // without FilePositionInformation's read/write-data access requirement.
    // That matters for handles granted FILE_APPEND_DATA without WRITE_DATA.
    const result = Buffer.alloc(104);
    const io = Buffer.alloc(16);
    const status = this.nt.symbols.NtQueryInformationFile(this.handle(descriptor), io, result, result.length, 18);
    // STATUS_BUFFER_OVERFLOW only truncates the trailing variable-length name.
    if (status !== -2147483643) this.check(status, "NtQueryInformationFile");
    if (io.readBigUInt64LE(8) < 88n) throw this.failure(87, "descriptorPosition");
    const position = result.readBigInt64LE(80);
    if (position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER)) throw this.failure(87, "descriptorPosition");
    return Number(position);
  }

  openDirectory(path: Buffer): number {
    const absolute = win32.resolve(this.decode(path));
    let native: string;
    if (/^[a-z]:\\/i.test(absolute)) native = `\\??\\${absolute}`;
    else if (/^\\\\[^\\?.][^\\]*\\[^\\]+/.test(absolute)) native = `\\??\\UNC\\${absolute.slice(2)}`;
    else throw this.failure(87, "openDirectory");
    return this.publish(this.acquire(0n, native, FILE_READ_DATA | FILE_TRAVERSE, FILE_OPEN, FILE_DIRECTORY_FILE));
  }

  duplicateDirectory(descriptor: number): number {
    const source = this.handle(descriptor);
    this.rejectReparse(source);
    if ((this.attributes(source) & FILE_ATTRIBUTE_DIRECTORY) === 0) throw this.failure(267, "duplicateDirectory");
    const processHandle = this.kernel.symbols.GetCurrentProcess();
    const result = Buffer.alloc(8);
    if (this.kernel.symbols.DuplicateHandle(processHandle, source, processHandle, result, 0, 0, 2) === 0) {
      throw this.failure(this.kernel.symbols.GetLastError(), "DuplicateHandle");
    }
    return this.publish(result.readBigUInt64LE(0));
  }

  openChildDirectory(parent: number, name: Buffer): number {
    return this.publish(this.acquire(this.handle(parent), this.childName(name), FILE_READ_DATA | FILE_TRAVERSE,
      FILE_OPEN, FILE_DIRECTORY_FILE));
  }

  inspectChild(parent: number, name: Buffer): FileChildInformation {
    const handle = this.openHandle(this.handle(parent), this.childName(name), 0, FILE_OPEN, 0);
    try {
      const attributes = this.attributes(handle);
      const symbolic = (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0;
      const directory = (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0;
      return { isFile: () => !symbolic && !directory, isDirectory: () => !symbolic && directory,
        isSymbolicLink: () => symbolic };
    } finally { this.nt.symbols.NtClose(handle); }
  }

  openChild(parent: number, name: Buffer, flags: number, mode: number): number {
    if (!Number.isInteger(flags) || !Number.isInteger(mode)) throw this.failure(87, "openChild");
    const supported = constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_EXCL
      | constants.O_TRUNC | constants.O_APPEND | constants.O_DIRECTORY | constants.O_NOFOLLOW
      | constants.O_NONBLOCK | constants.O_SYNC | constants.O_DSYNC;
    if ((flags & ~supported) !== 0) throw this.failure(50, "openChild");
    if ((flags & constants.O_DIRECTORY) !== 0) return this.openChildDirectory(parent, name);
    const accessMode = flags & 3;
    if (accessMode === 3) throw this.failure(87, "openChild");
    const writable = accessMode !== constants.O_RDONLY;
    const readable = accessMode !== constants.O_WRONLY;
    const append = (flags & constants.O_APPEND) !== 0;
    const truncate = (flags & constants.O_TRUNC) !== 0;
    if (truncate && (!writable || append)) throw this.failure(87, "openChild");
    const access = (readable ? FILE_READ_DATA : 0) | (writable ? append ? FILE_APPEND_DATA : FILE_WRITE_DATA : 0);
    const disposition = (flags & constants.O_CREAT) === 0 ? FILE_OPEN
      : (flags & constants.O_EXCL) !== 0 ? FILE_CREATE : FILE_OPEN_IF;
    const writeThrough = (flags & (constants.O_SYNC | constants.O_DSYNC)) !== 0 ? 2 : 0;
    const handle = this.acquire(this.handle(parent), this.childName(name), access, disposition, FILE_NON_DIRECTORY_FILE | writeThrough);
    if (truncate) {
      try { this.check(this.nt.symbols.NtSetInformationFile(handle, Buffer.alloc(16), Buffer.alloc(8), 8, 20),
        "NtSetInformationFile"); }
      catch (error) { this.nt.symbols.NtClose(handle); throw error; }
    }
    return this.publish(handle);
  }

  mkdirChild(parent: number, name: Buffer): void {
    const handle = this.acquire(this.handle(parent), this.childName(name), FILE_TRAVERSE, FILE_CREATE, FILE_DIRECTORY_FILE);
    this.check(this.nt.symbols.NtClose(handle), "NtClose");
  }

  private moveOrLink(sourceParent: number, sourceName: Buffer, destinationParent: number,
    destinationName: Buffer, informationClass: 10 | 11): void {
    const destination = this.handle(destinationParent);
    const name = Buffer.from(this.childName(destinationName), "utf16le");
    const information = Buffer.alloc(Math.max(24, 20 + name.length));
    information.writeUInt8(informationClass === 10 ? 1 : 0, 0);
    information.writeBigUInt64LE(destination, 8);
    information.writeUInt32LE(name.length, 16);
    name.copy(information, 20);
    const source = this.acquire(this.handle(sourceParent), this.childName(sourceName), informationClass === 10 ? DELETE : 0,
      FILE_OPEN, FILE_NON_DIRECTORY_FILE);
    try { this.check(this.nt.symbols.NtSetInformationFile(source, Buffer.alloc(16), information, information.length,
      informationClass), "NtSetInformationFile"); }
    finally { this.nt.symbols.NtClose(source); }
  }

  renameChild(sourceParent: number, sourceName: Buffer, destinationParent: number, destinationName: Buffer): void {
    this.moveOrLink(sourceParent, sourceName, destinationParent, destinationName, 10);
  }

  linkChild(sourceParent: number, sourceName: Buffer, destinationParent: number, destinationName: Buffer): void {
    this.moveOrLink(sourceParent, sourceName, destinationParent, destinationName, 11);
  }

  unlinkChild(parent: number, name: Buffer): void {
    const handle = this.acquire(this.handle(parent), this.childName(name), DELETE, FILE_OPEN, FILE_NON_DIRECTORY_FILE);
    try { this.check(this.nt.symbols.NtSetInformationFile(handle, Buffer.alloc(16), Buffer.from([1]), 1, 13),
      "NtSetInformationFile"); }
    finally { this.nt.symbols.NtClose(handle); }
  }
}

let operations: FileNativeOperations | null = null;

export function createWindowsFileOperations(): FileNativeOperations {
  if (process.platform !== "win32" || (process.arch !== "x64" && process.arch !== "arm64") || endianness() !== "LE") {
    throw new Error("Windows file services require a Windows x64 or arm64 Bun runtime");
  }
  operations ??= new WindowsFileOperations();
  return operations;
}
