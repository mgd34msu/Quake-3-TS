// Synthetic VM_LogSyscalls memory and private file checks. GPL-2.0-or-later.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VmSyscallLog } from "../src/vm/syscall-log.ts";

function inPrivateDirectory(run: () => void): void {
  const previous = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "quake3-vm-syscall-log-"));
  try { process.chdir(directory); run(); }
  finally { process.chdir(previous); rmSync(directory, { recursive: true, force: true }); }
}

function syntheticArgs(data: Uint8Array, offset: number): DataView {
  const view = new DataView(data.buffer, data.byteOffset + offset, 20);
  for (const [index, word] of [-7, -2147483648, 2147483647, 0, -1].entries()) {
    view.setInt32(index * 4, word, true);
  }
  return view;
}

test("VM_LogSyscalls lazily truncates once and logs live signed words at allocation-relative int offsets", () => {
  inPrivateDirectory(() => {
    writeFileSync("syscalls.log", "old contents");
    const logger = new VmSyscallLog();
    try {
      expect(readFileSync("syscalls.log", "utf8")).toBe("old contents");
      const backing = new Uint8Array(128);
      const data = backing.subarray(16, 112);
      const args = syntheticArgs(data, 12);
      logger.log(data, args);
      expect(readFileSync("syscalls.log", "utf8")).toBe("");
      args.setInt32(0, 42, true);
      args.setInt32(16, 123, true);
      logger.log(data, args);
    } finally { logger.close(); }
    expect(readFileSync("syscalls.log", "utf8")).toBe(
      "1: 3 (-7) = -2147483648 2147483647 0 -1\n2: 3 (42) = -2147483648 2147483647 0 123\n",
    );
    logger.close();
  });
});

test("VM_LogSyscalls remains inert until invoked and explicit disposal forbids reopening", () => {
  inPrivateDirectory(() => {
    const logger = new VmSyscallLog();
    logger.close();
    expect(existsSync("syscalls.log")).toBe(false);
    const data = new Uint8Array(32);
    expect(() => logger.log(data, syntheticArgs(data, 0))).toThrow("owner is closed");
    expect(existsSync("syscalls.log")).toBe(false);
  });
});

test("VM_LogSyscalls opens and advances callnum before rejecting undefined pointer and short-read cases", () => {
  inPrivateDirectory(() => {
    const logger = new VmSyscallLog();
    const backing = new Uint8Array(96);
    const data = backing.subarray(16, 64);
    const invalid = [
      new DataView(new ArrayBuffer(20)),
      new DataView(backing.buffer, 0, 20),
      new DataView(backing.buffer, 17, 20),
      new DataView(backing.buffer, 48, 20),
      new DataView(backing.buffer, 16, 19),
    ];
    try {
      for (const args of invalid) expect(() => logger.log(data, args)).toThrow("same data allocation");
      expect(existsSync("syscalls.log")).toBe(true);
      logger.log(data, syntheticArgs(data, 28));
    } finally { logger.close(); }
    expect(readFileSync("syscalls.log", "utf8")).toBe("6: 7 (-7) = -2147483648 2147483647 0 -1\n");
  });
});

test("VM_LogSyscalls rejects null FILE after advancing callnum and retries the lazy open", () => {
  inPrivateDirectory(() => {
    mkdirSync("syscalls.log");
    const logger = new VmSyscallLog();
    const data = new Uint8Array(32);
    const args = syntheticArgs(data, 0);
    try {
      expect(() => logger.log(data, args)).toThrow("source fprintf would use a null FILE");
      rmdirSync("syscalls.log");
      logger.log(data, args);
    } finally { logger.close(); }
    expect(readFileSync("syscalls.log", "utf8")).toBe("2: 0 (-7) = -2147483648 2147483647 0 -1\n");
  });
});

test("VM_LogSyscalls retains one descriptor across cwd changes", () => {
  inPrivateDirectory(() => {
    const logger = new VmSyscallLog();
    const data = new Uint8Array(32);
    const args = syntheticArgs(data, 0);
    const directory = process.cwd();
    mkdirSync("other");
    try {
      logger.log(data, args);
      process.chdir("other");
      logger.log(data, args);
      expect(existsSync("syscalls.log")).toBe(false);
    } finally { process.chdir(directory); logger.close(); }
    expect(readFileSync("syscalls.log", "utf8")).toBe(
      "1: 0 (-7) = -2147483648 2147483647 0 -1\n2: 0 (-7) = -2147483648 2147483647 0 -1\n",
    );
  });
});
