// SPDX-License-Identifier: GPL-2.0-or-later
import { deepStrictEqual, strictEqual } from "node:assert";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceFileHandles } from "../src/assets/file-handles.ts";
import { NativeRoot } from "../src/assets/native-root.ts";
import { WritableFileSystem } from "../src/assets/writable-files.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { nativeFileOperations } from "../src/platform/file-native.ts";
import { localTime } from "../src/platform/local-time.ts";
import { UdpTransport } from "../src/platform/network.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { runAudioSmoke } from "./audio-smoke.ts";

// Run with stdin redirected from the null device, or a pipe, never a terminal.
if (process.stdin.isTTY === true) throw new Error("Platform smoke requires non-interactive stdin");
if (process.env["SDL_VIDEODRIVER"] !== "dummy" || process.env["SDL_AUDIODRIVER"] !== "dummy"
  || process.env["WAYLAND_DISPLAY"] !== undefined || process.env["DISPLAY"] !== undefined
  || process.env["TZ"] !== "UTC0") {
  throw new Error("Start with SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy TZ=UTC0 and unset DISPLAY/WAYLAND_DISPLAY");
}

function filesSmoke(): void {
  const directory = mkdtempSync(join(tmpdir(), "quake3-platform-"));
  const home = join(directory, "home-游戏-é");
  const handles = new SourceFileHandles();
  const files = new WritableFileSystem({ homePath: NativeRoot.fromHost(home), product: "baseq3", handles,
    print: text => { process.stdout.write(text); } });
  try {
    const writer = files.openBinaryWrite("nested/check.tmp");
    if (writer === null) throw new Error("Native writable file startup failed");
    try {
      strictEqual(writer.writeBytes(Uint8Array.of(10, 20, 30)), 3);
      strictEqual(writer.tell(), 3);
      strictEqual(writer.seek(1, "set"), 0);
      strictEqual(writer.writeBytes(Uint8Array.of(40)), 1);
    } finally { writer.close(); }
    const append = files.openByMode("nested/check.tmp", "append");
    if (append === null) throw new Error("Native append startup failed");
    try {
      strictEqual(files.writeBytes(append, Uint8Array.of(50)), 1);
      strictEqual(handles.tellWrite(append), 4);
      strictEqual(nativeFileOperations().descriptorPosition(handles.writeDescriptor(append)), 4);
    } finally { handles.closeFile(append); }
    files.renameFile("nested/check.tmp", "nested/check.bin", () => {});
    strictEqual(files.fileExists("nested/check.tmp"), false);
    strictEqual(files.fileExists("nested/check.bin"), true);
    const path = join(home, "baseq3", "nested", "check.bin");
    deepStrictEqual(new Uint8Array(readFileSync(path)), Uint8Array.of(10, 40, 30, 50));
    const reader = handles.selectFree();
    handles.attachLooseRead(reader, openSync(path, "r"));
    try {
      strictEqual(handles.captureLooseLength(reader), 4);
      handles.setReadMode(reader, 4);
      const bytes = new Uint8Array(4);
      strictEqual(handles.readInto(reader, bytes), 4);
      deepStrictEqual(bytes, Uint8Array.of(10, 40, 30, 50));
      strictEqual(handles.seek(reader, 1, 2), 0);
      strictEqual(handles.readInto(reader, bytes.subarray(0, 1)), 1);
      strictEqual(bytes[0], 40);
    } finally { handles.closeFile(reader); }
  } finally {
    try { files.closeAll(); } finally {
      try { handles.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  }
  process.stdout.write("PASS native files: Unicode root, write, seek, append position, rename, reopen, source reads\n");
}

function consoleSmoke(): void {
  const io = new UnixIo(text => { process.stdout.write(text); }, { milliseconds: () => performance.now() });
  try {
    io.initializeConsole(new CvarRegistry());
    strictEqual(io.consoleProfile, "line-latin1");
    io.initializeSignals(null);
    io.pollConsoleEvent();
  } finally { io.close(); io.close(); }
  process.stdout.write("PASS console: native signal setup and cleanup, non-TTY startup\n");
}

async function networkSmoke(): Promise<void> {
  const sender = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
  try {
    const receiver = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    try {
      const payload = Uint8Array.of(0, 127, 128, 255);
      sender.send(receiver.address, payload);
      const deadline = performance.now() + 5000;
      while (receiver.statistics.pending === 0 && performance.now() < deadline) await Bun.sleep(5);
      const event = receiver.poll();
      if (event === null) throw new Error("Native UDP loopback delivery timed out");
      if (event.kind === "error") throw event.error;
      deepStrictEqual(event.payload, payload);
      deepStrictEqual(event.from, sender.address);
    } finally { receiver.close(); }
  } finally { sender.close(); }
  process.stdout.write("PASS UDP: native loopback datagram and sender address\n");
}

function videoSmoke(): void {
  const window = SdlWindow.open({ title: "Quake 3 platform smoke", width: 8, height: 8, backend: "cpu", hidden: true });
  try {
    const pixels = new Uint8Array(8 * 8 * 4);
    for (let index = 0; index < pixels.length; index += 4) {
      pixels[index] = 17; pixels[index + 1] = 83; pixels[index + 2] = 191; pixels[index + 3] = 255;
    }
    window.present(pixels);
    deepStrictEqual(window.readPixels(), pixels);
    window.pollEvents();
  } finally { window.close(); window.close(); }
  process.stdout.write("PASS SDL: dummy CPU presentation and native pixel readback\n");
}

process.stdout.write(`Platform services: ${process.platform}/${process.arch}, Bun ${Bun.version}\n`);
filesSmoke();
consoleSmoke();
deepStrictEqual(localTime(2147483648), { second: 8, minute: 14, hour: 3, day: 19, month: 0,
  year: 138, weekday: 2, yearDay: 18, isDst: 0 });
process.stdout.write("PASS calendar: native UTC conversion after 2038\n");
await networkSmoke();
videoSmoke();
process.stdout.write(`PASS ${await runAudioSmoke()}\n`);
process.stdout.write("PASS platform services; retail gameplay and OpenGL are outside this check\n");
