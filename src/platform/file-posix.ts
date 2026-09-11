import { dlopen, read } from "bun:ffi";
import { Buffer } from "node:buffer";
import { constants, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, unlinkSync } from "node:fs";
import { getSystemErrorName } from "node:util";
import type { FileNativeOperations } from "./file-native-types.ts";

function childPath(parent: number, name: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`/proc/self/fd/${parent}/`), name]);
}

export function createLinuxFileOperations(): FileNativeOperations {
  return {
    descriptorPath: descriptor => realpathSync(`/proc/self/fd/${descriptor}`, { encoding: "buffer" }),
    descriptorPosition(descriptor) {
      const position = /^pos:\s*(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${descriptor}`, "utf8"))?.[1];
      if (position === undefined) throw new Error("Cannot read file descriptor position");
      const offset = Number(position);
      if (!Number.isSafeInteger(offset)) throw new RangeError("File position exceeds safe integer range");
      return offset;
    },
    openDirectory: path => openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
    duplicateDirectory: descriptor => openSync(`/proc/self/fd/${descriptor}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK),
    inspectChild: (parent, name) => lstatSync(childPath(parent, name)),
    openChildDirectory: (parent, name) => openSync(childPath(parent, name),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
    openChild: (parent, name, flags, mode) => openSync(childPath(parent, name), flags, mode),
    mkdirChild: (parent, name) => { mkdirSync(childPath(parent, name)); },
    renameChild: (sourceParent, sourceName, destinationParent, destinationName) => {
      renameSync(childPath(sourceParent, sourceName), childPath(destinationParent, destinationName));
    },
    linkChild: (sourceParent, sourceName, destinationParent, destinationName) => {
      linkSync(childPath(sourceParent, sourceName), childPath(destinationParent, destinationName));
    },
    unlinkChild: (parent, name) => { unlinkSync(childPath(parent, name)); },
  };
}

function terminatedName(name: Buffer): Buffer {
  if (name.length === 0 || name.includes(0) || name.includes(47) || name.equals(Buffer.from(".."))) {
    throw new RangeError("Descriptor-relative operation requires one non-NUL path component");
  }
  return Buffer.concat([name, Buffer.from([0])]);
}

function loadDarwinFiles() {
  // Apple xnu libsyscall/wrappers/open-base.c and cancelable/fcntl-base.c
  // declare these fixed-argument entries. Public openat/fcntl are variadic;
  // their Apple arm64 ABI cannot be called with a fixed Bun FFI signature.
  return dlopen("/usr/lib/libSystem.B.dylib", {
    __openat_nocancel: { args: ["i32", "buffer", "i32", "u16"], returns: "i32" },
    __fcntl_nocancel: { args: ["i32", "i32", "buffer"], returns: "i32" },
    __error: { args: [], returns: "ptr" },
    lseek: { args: ["i32", "i64", "i32"], returns: "i64" },
    mkdirat: { args: ["i32", "buffer", "u16"], returns: "i32" },
    renameat: { args: ["i32", "buffer", "i32", "buffer"], returns: "i32" },
    linkat: { args: ["i32", "buffer", "i32", "buffer", "i32"], returns: "i32" },
    unlinkat: { args: ["i32", "buffer", "i32"], returns: "i32" },
  });
}

function loadDarwinMetadata() {
  // stat.h applies __DARWIN_INODE64; x86_64 requires the suffixed symbol.
  if (process.arch === "x64") {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      "fstatat$INODE64": { args: ["i32", "buffer", "buffer", "i32"], returns: "i32" },
    });
    return { library, stat: library.symbols["fstatat$INODE64"] };
  }
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    fstatat: { args: ["i32", "buffer", "buffer", "i32"], returns: "i32" },
  });
  return { library, stat: library.symbols.fstatat };
}

class DarwinFileError extends Error {
  readonly code: string;
  readonly errno: number;
  constructor(readonly syscall: string, errno: number) {
    const code = getSystemErrorName(-errno);
    super(`${code}: ${syscall}`);
    this.code = code;
    this.errno = -errno;
  }
}

export function createDarwinFileOperations(): FileNativeOperations {
  const library = loadDarwinFiles();
  let metadata: ReturnType<typeof loadDarwinMetadata>;
  try { metadata = loadDarwinMetadata(); }
  catch (error) { library.close(); throw error; }
  const native = library.symbols;
  function checked(result: number, syscall: string): number {
    if (result >= 0) return result;
    const pointer = native.__error();
    if (pointer === null) throw new Error(`Cannot obtain errno after ${syscall}`);
    throw new DarwinFileError(syscall, read.i32(pointer));
  }
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  return {
    descriptorPath(descriptor) {
      // xnu bsd/sys/fcntl.h F_GETPATH = 50; sys/param.h MAXPATHLEN = 1024.
      const path = Buffer.alloc(1024);
      checked(native.__fcntl_nocancel(descriptor, 50, path), "fcntl");
      const length = path.indexOf(0);
      if (length <= 0) throw new Error("F_GETPATH returned an invalid descriptor path");
      return Buffer.from(path.subarray(0, length));
    },
    descriptorPosition(descriptor) {
      const value = native.lseek(descriptor, 0n, 1);
      if (value < 0) checked(-1, "lseek");
      const position = Number(value);
      if (!Number.isSafeInteger(position)) throw new RangeError("File position exceeds safe integer range");
      return position;
    },
    openDirectory: path => openSync(path, directoryFlags),
    duplicateDirectory: descriptor => checked(native.__openat_nocancel(descriptor, terminatedName(Buffer.from(".")), directoryFlags, 0), "openat"),
    inspectChild(parent, name) {
      // Apple xnu bsd/sys/stat.h __DARWIN_STRUCT_STAT64 is 144 bytes on
      // x64/arm64, with uint16 st_mode at offset 4. fstatat queries metadata
      // without demanding read-data permission; 0x20 is AT_SYMLINK_NOFOLLOW.
      const information = Buffer.alloc(144);
      checked(metadata.stat(parent, terminatedName(name), information, 0x20), "fstatat");
      const type = information.readUInt16LE(4) & 0xf000;
      return { isFile: () => type === 0x8000, isDirectory: () => type === 0x4000,
        isSymbolicLink: () => type === 0xa000 };
    },
    openChild: (parent, name, flags, mode) => checked(native.__openat_nocancel(parent, terminatedName(name), flags, mode), "openat"),
    openChildDirectory: (parent, name) => checked(native.__openat_nocancel(parent, terminatedName(name), directoryFlags, 0), "openat"),
    mkdirChild: (parent, name) => { checked(native.mkdirat(parent, terminatedName(name), 0o777), "mkdirat"); },
    renameChild: (sourceParent, sourceName, destinationParent, destinationName) => {
      checked(native.renameat(sourceParent, terminatedName(sourceName), destinationParent, terminatedName(destinationName)), "renameat");
    },
    linkChild: (sourceParent, sourceName, destinationParent, destinationName) => {
      checked(native.linkat(sourceParent, terminatedName(sourceName), destinationParent, terminatedName(destinationName), 0), "linkat");
    },
    unlinkChild: (parent, name) => { checked(native.unlinkat(parent, terminatedName(name), 0), "unlinkat"); },
  };
}
