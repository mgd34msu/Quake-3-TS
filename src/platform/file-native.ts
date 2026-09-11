import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import type { FileNativeOperations } from "./file-native-types.ts";
import { createDarwinFileOperations, createLinuxFileOperations } from "./file-posix.ts";
import { createWindowsFileOperations } from "./file-windows.ts";

let operations: FileNativeOperations | undefined;

export function nativeFileOperations(): FileNativeOperations {
  if (operations !== undefined) return operations;
  switch (process.platform) {
    case "linux": operations = createLinuxFileOperations(); break;
    case "darwin": operations = createDarwinFileOperations(); break;
    case "win32": operations = createWindowsFileOperations(); break;
    default: throw new Error(`Secure file operations are unavailable on ${process.platform}`);
  }
  return operations;
}

/** Canonical descriptor paths use native bytes, with / separators on Windows. */
export function containedNativePath(root: Buffer, candidate: Buffer): boolean {
  return candidate.equals(root) || (candidate.subarray(0, root.length).equals(root)
    && (root.at(-1) === 47 || candidate[root.length] === 47));
}

/** Windows names are UTF-16; each source byte retains its code point there. */
export function sourceNativeComponent(source: string): Buffer {
  return Buffer.from(source, process.platform === "win32" ? "utf8" : "latin1");
}

/** Resolve Apple's system-owned root aliases before the no-follow home walk. */
export function writableHostPath(path: Buffer): Buffer {
  if (process.platform !== "darwin") return path;
  for (const alias of ["/var", "/tmp", "/etc"]) {
    const prefix = Buffer.from(alias);
    if (!containedNativePath(prefix, path)) continue;
    return Buffer.concat([realpathSync(prefix, { encoding: "buffer" }), path.subarray(prefix.length)]);
  }
  return path;
}
