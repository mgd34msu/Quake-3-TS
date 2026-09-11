import { afterEach, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WritableFileSystem } from "../src/assets/writable-files.ts";
import { NativeRoot } from "../src/assets/native-root.ts";
import { openDownloadDescriptor, ServerDownloadFile } from "../src/assets/download-file.ts";
import { SourceFileHandles } from "../src/assets/file-handles.ts";
import { containedNativePath, nativeFileOperations, sourceNativeComponent } from "../src/platform/file-native.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "q3-portable-files-"));
  roots.push(root);
  return root;
}

test("portable native files write, seek, append and download beneath a Unicode host home", () => {
  const home = join(temporaryRoot(), "home-é-目录");
  const handles = new SourceFileHandles();
  const files = new WritableFileSystem({ homePath: home, product: "baseq3", handles, print: () => undefined });
  try {
    const file = files.openBinaryWrite("nested/state.cfg");
    if (file === null) throw new Error("Expected writable file");
    expect(file.writeBytes(Buffer.from("abcdef"))).toBe(6);
    expect(file.tell()).toBe(6);
    expect(file.seek(2, "set")).toBe(0);
    expect(file.writeBytes(Buffer.from("XY"))).toBe(2);
    file.close();
    const append = files.openAppend("nested/state.cfg", false);
    if (append === null) throw new Error("Expected append file");
    append.write("!");
    append.close();
    expect(files.fileExists("nested/state.cfg")).toBe(true);
    expect(readFileSync(join(home, "baseq3/nested/state.cfg"), "utf8")).toBe("abXYef!");
    const download = openDownloadDescriptor(NativeRoot.fromHost(home), "baseq3/nested/state.cfg");
    if (download === undefined) throw new Error("Expected download descriptor");
    try { expect(readFileSync(download.descriptor, "utf8")).toBe("abXYef!"); }
    finally { closeSync(download.descriptor); }
  } finally { files.closeAll(); handles.close(); }
});

test("portable descriptor position observes actual unpositioned reads and writes", () => {
  const path = join(temporaryRoot(), "cursor.bin");
  const descriptor = openSync(path, "w+");
  try {
    writeSync(descriptor, Buffer.from("abcd"));
    expect(nativeFileOperations().descriptorPosition(descriptor)).toBe(4);
  } finally { closeSync(descriptor); }
  const reader = openSync(path, "r");
  try {
    expect(readSync(reader, new Uint8Array(2), 0, 2, null)).toBe(2);
    expect(nativeFileOperations().descriptorPosition(reader)).toBe(2);
  } finally { closeSync(reader); }
});

test.skipIf(process.platform === "win32")("POSIX write-only files allow contained truncate and append without read permission", () => {
  const home = temporaryRoot(), path = join(home, "baseq3/write-only.cfg");
  mkdirSync(join(home, "baseq3"));
  writeFileSync(path, "original");
  chmodSync(path, 0o200);
  const handles = new SourceFileHandles();
  const files = new WritableFileSystem({ homePath: home, product: "baseq3", handles, print: () => undefined });
  try {
    // This fixture must run without a superuser read-permission bypass.
    expect(() => {
      const readable = openSync(path, "r");
      closeSync(readable);
    }).toThrow("EACCES");
    const write = files.openWrite("write-only.cfg", false);
    if (write === null) throw new Error("Expected write-only truncate open");
    write.write("new");
    write.close();
    const append = files.openAppend("write-only.cfg", false);
    if (append === null) throw new Error("Expected write-only append open");
    append.write("+");
    append.close();
    chmodSync(path, 0o600);
    expect(readFileSync(path, "utf8")).toBe("new+");
  } finally {
    chmodSync(path, 0o600);
    files.closeAll();
    handles.close();
  }
});

test("portable directory operations retain pinned parents through a path replacement", () => {
  const root = temporaryRoot(), parentPath = join(root, "parent"), movedPath = join(root, "moved");
  mkdirSync(parentPath);
  const native = nativeFileOperations();
  const parent = native.openDirectory(realpathSync(parentPath, { encoding: "buffer" }));
  try {
    renameSync(parentPath, movedPath);
    mkdirSync(parentPath);
    native.mkdirChild(parent, sourceNativeComponent("child"));
    const child = native.openChildDirectory(parent, sourceNativeComponent("child"));
    try {
      const descriptor = native.openChild(child, sourceNativeComponent("data.bin"),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        writeSync(descriptor, Buffer.from("pinned"));
        expect(fstatSync(descriptor).isFile()).toBe(true);
        expect(containedNativePath(native.descriptorPath(parent), native.descriptorPath(descriptor))).toBe(true);
      } finally { closeSync(descriptor); }
      expect(native.inspectChild(child, sourceNativeComponent("data.bin")).isFile()).toBe(true);
      native.linkChild(child, sourceNativeComponent("data.bin"), child, sourceNativeComponent("linked.bin"));
      expect(() => native.linkChild(child, sourceNativeComponent("data.bin"), child, sourceNativeComponent("linked.bin"))).toThrow();
      native.renameChild(child, sourceNativeComponent("linked.bin"), child, sourceNativeComponent("renamed.bin"));
      native.unlinkChild(child, sourceNativeComponent("data.bin"));
    } finally { closeSync(child); }
    expect(readFileSync(join(movedPath, "child/renamed.bin"), "utf8")).toBe("pinned");
    expect(existsSync(join(parentPath, "child"))).toBe(false);
  } finally { closeSync(parent); }
});

test("portable writable containment rejects a linked child directory and traversal", () => {
  const root = temporaryRoot(), home = join(root, "home"), outside = join(root, "outside");
  mkdirSync(join(home, "baseq3"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.cfg"), "preserve");
  symlinkSync(outside, join(home, "baseq3/escape"), process.platform === "win32" ? "junction" : "dir");
  const files = new WritableFileSystem({ homePath: home, product: "baseq3", print: () => undefined });
  try {
    expect(() => files.openWrite("escape/keep.cfg", false)).toThrow();
    expect(() => files.openWrite("../outside/keep.cfg", false)).toThrow();
    expect(readFileSync(join(outside, "keep.cfg"), "utf8")).toBe("preserve");
  } finally { files.closeAll(); }
});

test("portable download revalidation rejects a descriptor moved outside its root", () => {
  const root = temporaryRoot(), home = join(root, "home");
  mkdirSync(home);
  const path = join(home, "data.bin");
  writeFileSync(path, "download");
  const opened = openDownloadDescriptor(NativeRoot.fromHost(home), "data.bin");
  if (opened === undefined) throw new Error("Expected download");
  const handles = new SourceFileHandles(), handle = handles.selectFree();
  handles.assignServerRead(handle, opened.descriptor, opened.root);
  const file = new ServerDownloadFile(handles.borrowLooseRead(handle), 8, "data.bin");
  try {
    renameSync(path, join(root, "moved.bin"));
    expect(() => file.read(new Uint8Array(1))).toThrow("escapes configured root");
    expect(() => file.read(new Uint8Array(1))).toThrow("closed");
  } finally { file.close(); handles.close(); }
});
