import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { closeSync, constants, existsSync, fstatSync, ftruncateSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWindowsFileOperations } from "../src/platform/file-windows.ts";
import type { FileNativeOperations } from "../src/platform/file-native-types.ts";
import { openDownloadDescriptor } from "../src/assets/download-file.ts";
import { NativeRoot } from "../src/assets/native-root.ts";

function fixture(run: (files: FileNativeOperations, directory: number, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "quake3-windows-files-é-"));
  const files = createWindowsFileOperations();
  let directory: number | null = null;
  try {
    directory = files.openDirectory(Buffer.from(root));
    run(files, directory, root);
  } finally {
    if (directory !== null) closeSync(directory);
    rmSync(root, { recursive: true, force: true });
  }
}

function expectCode(run: () => void, code: string): void {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  if (!(caught instanceof Error) || !("code" in caught) || !("errno" in caught) || !("syscall" in caught)) {
    throw new Error("Expected a structured native file error");
  }
  expect(caught.code).toBe(code);
  expect(typeof caught.errno).toBe("number");
  expect(typeof caught.syscall).toBe("string");
}

describe.skipIf(process.platform !== "win32")("Windows handle-relative files", () => {
  test("shares descriptors with Bun and reports canonical paths through Unicode roots", () => {
    fixture((files, directory, root) => {
      expect(fstatSync(directory).isDirectory()).toBe(true);
      const nativeRoot = files.descriptorPath(directory);
      const aliasDirectory = files.openDirectory(Buffer.from(realpathSync(root)));
      try {
        expect(files.descriptorPath(aliasDirectory)).toEqual(nativeRoot);
        expect(fstatSync(aliasDirectory).ino).toBe(fstatSync(directory).ino);
        expect(fstatSync(aliasDirectory).dev).toBe(fstatSync(directory).dev);
      } finally { closeSync(aliasDirectory); }
      const duplicate = files.duplicateDirectory(directory);
      try {
        expect(fstatSync(duplicate).isDirectory()).toBe(true);
        expect(files.descriptorPath(duplicate)).toEqual(nativeRoot);
      }
      finally { closeSync(duplicate); }

      const name = "é-玩家.bin";
      writeFileSync(join(root, name), Buffer.from([0, 10, 13, 26, 255]));
      const fromBun = openSync(join(root, name), "r");
      try {
        expect(files.descriptorPath(fromBun).toString()).toBe(`${nativeRoot.toString()}/${name}`);
        expect(files.descriptorPosition(fromBun)).toBe(0);
        const bytes = Buffer.alloc(2);
        expect(readSync(fromBun, bytes, 0, 2, null)).toBe(2);
        expect(files.descriptorPosition(fromBun)).toBe(2);
      } finally { closeSync(fromBun); }
      const opened = files.openChild(directory, Buffer.from(name), constants.O_RDONLY, 0);
      try { expect(readFileSync(opened)).toEqual(Buffer.from([0, 10, 13, 26, 255])); }
      finally { closeSync(opened); }
    });
  });

  test("downloads retain the native root identity through a configured junction", () => {
    fixture((files, directory, root) => {
      const target = join(root, "downloads"), outside = join(root, "outside"), alias = join(root, "alias");
      mkdirSync(target);
      mkdirSync(outside);
      writeFileSync(join(target, "data.bin"), "contained");
      writeFileSync(join(outside, "data.bin"), "outside");
      symlinkSync(target, alias, "junction");
      symlinkSync(outside, join(target, "escape"), "junction");
      const targetDirectory = files.openChildDirectory(directory, Buffer.from("downloads"));
      try {
        const opened = openDownloadDescriptor(NativeRoot.fromHost(alias), "data.bin");
        if (opened === undefined) throw new Error("Expected configured junction download");
        try {
          expect(opened.root).toEqual(files.descriptorPath(targetDirectory));
          expect(readFileSync(opened.descriptor, "utf8")).toBe("contained");
        } finally { closeSync(opened.descriptor); }
        expect(() => openDownloadDescriptor(NativeRoot.fromHost(alias), "escape/data.bin")).toThrow("escapes configured root");
      } finally { closeSync(targetDirectory); }
    });
  });

  test("creates, truncates and appends through ordinary Bun reads and writes", () => {
    fixture((files, directory, root) => {
      const name = Buffer.from("save.bin");
      const fd = files.openChild(directory, name, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        expect(writeSync(fd, Buffer.from([1, 2, 3, 4]))).toBe(4);
        expect(files.descriptorPosition(fd)).toBe(4);
        ftruncateSync(fd, 2);
        expect(fstatSync(fd).size).toBe(2);
      } finally { closeSync(fd); }
      const append = files.openChild(directory, name, constants.O_WRONLY | constants.O_APPEND, 0o600);
      try {
        expect(files.descriptorPosition(append)).toBe(0);
        // An append-only NT handle appends even when libuv supplies an offset.
        expect(writeSync(append, Buffer.from([10, 13, 26, 255]), 0, 4, 0)).toBe(4);
        expect(writeSync(append, Buffer.from([99]))).toBe(1);
        expect(files.descriptorPosition(append)).toBe(7);
      } finally { closeSync(append); }
      expect(readFileSync(join(root, "save.bin"))).toEqual(Buffer.from([1, 2, 10, 13, 26, 255, 99]));
      const truncated = files.openChild(directory, name, constants.O_WRONLY | constants.O_TRUNC, 0o600);
      try { expect(fstatSync(truncated).size).toBe(0); }
      finally { closeSync(truncated); }
    });
  });

  test("returns native acquisition errors without altering existing files", () => {
    fixture((files, directory, root) => {
      writeFileSync(join(root, "existing"), "keep");
      expectCode(() => files.openChild(directory, Buffer.from("existing"),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600), "EEXIST");
      expectCode(() => files.openChild(directory, Buffer.from("missing"), constants.O_RDONLY, 0), "ENOENT");
      expect(readFileSync(join(root, "existing"), "utf8")).toBe("keep");
    });
  });

  test("rejects traversal, alternate streams, aliases and malformed UTF8", () => {
    fixture((files, directory) => {
      for (const name of ["", ".", "..", "../escape", "a/b", "a\\b", "a:stream", "a\0b", "CON", "nul.txt", "x.", "x "]) {
        expectCode(() => files.openChild(directory, Buffer.from(name), constants.O_WRONLY | constants.O_CREAT, 0o600), "EINVAL");
      }
      expectCode(() => files.openChild(directory, Buffer.from([0xc3, 0x28]), constants.O_RDONLY, 0), "EINVAL");
    });
  });

  test("creates directories and performs handle-relative hard links, replacement and deletion", () => {
    fixture((files, directory, root) => {
      files.mkdirChild(directory, Buffer.from("child"));
      expect(files.inspectChild(directory, Buffer.from("child")).isDirectory()).toBe(true);
      expectCode(() => files.mkdirChild(directory, Buffer.from("child")), "EEXIST");
      const child = files.openChildDirectory(directory, Buffer.from("child"));
      try {
        writeFileSync(join(root, "source"), "source");
        files.linkChild(directory, Buffer.from("source"), child, Buffer.from("linked"));
        expect(readFileSync(join(root, "child", "linked"), "utf8")).toBe("source");
        expectCode(() => files.linkChild(directory, Buffer.from("source"), child, Buffer.from("linked")), "EEXIST");
        writeFileSync(join(root, "child", "destination"), "old");
        files.renameChild(child, Buffer.from("linked"), child, Buffer.from("destination"));
        expect(readFileSync(join(root, "child", "destination"), "utf8")).toBe("source");
        expect(existsSync(join(root, "child", "linked"))).toBe(false);
        files.unlinkChild(child, Buffer.from("destination"));
        expect(existsSync(join(root, "child", "destination"))).toBe(false);
        expect(readFileSync(join(root, "source"), "utf8")).toBe("source");
        expect(files.inspectChild(directory, Buffer.from("source")).isFile()).toBe(true);
      } finally { closeSync(child); }
    });
  });

  test("rejects junction traversal and root junctions without touching their targets", () => {
    fixture((files, directory, root) => {
      mkdirSync(join(root, "target"));
      writeFileSync(join(root, "target", "sentinel"), "keep");
      symlinkSync(join(root, "target"), join(root, "junction"), "junction");
      expect(files.inspectChild(directory, Buffer.from("junction")).isSymbolicLink()).toBe(true);
      expectCode(() => files.openChildDirectory(directory, Buffer.from("junction")), "ELOOP");
      expectCode(() => files.openDirectory(Buffer.from(join(root, "junction"))), "ELOOP");
      expect(() => files.unlinkChild(directory, Buffer.from("junction"))).toThrow();
      expect(readFileSync(join(root, "target", "sentinel"), "utf8")).toBe("keep");
    });
  });

  test("retains the opened parent when its old path is replaced by a junction", () => {
    fixture((files, directory, root) => {
      files.mkdirChild(directory, Buffer.from("parent"));
      files.mkdirChild(directory, Buffer.from("outside"));
      const parent = files.openChildDirectory(directory, Buffer.from("parent"));
      try {
        renameSync(join(root, "parent"), join(root, "moved"));
        symlinkSync(join(root, "outside"), join(root, "parent"), "junction");
        const fd = files.openChild(parent, Buffer.from("saved"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try { writeSync(fd, Buffer.from("contained")); }
        finally { closeSync(fd); }
        expect(readFileSync(join(root, "moved", "saved"), "utf8")).toBe("contained");
        expect(existsSync(join(root, "outside", "saved"))).toBe(false);
        expect(files.descriptorPath(parent).toString().endsWith("/moved")).toBe(true);
      } finally { closeSync(parent); }
    });
  });
});
