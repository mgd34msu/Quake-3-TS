import { describe, expect, test } from "bun:test";
import { writeSync } from "node:fs";
import { CvarRegistry } from "../src/core/cvar.ts";
import { consolePlatform, consoleTermios, signalActionSize, termiosSize } from "../src/platform/portable-console-abi.ts";
import { UnixIo } from "../src/platform/unix-io.ts";

async function runChild(): Promise<void> {
  const io = new UnixIo(text => { writeSync(1, text); }, { milliseconds: () => 0 });
  io.bindConsoleCompletion(field => { field.setText("completed"); });
  io.initializeConsole(new CvarRegistry());
  io.initializeSignals(() => { writeSync(1, "graphics-shutdown\n"); });
  writeSync(1, `console-ready:${io.consoleProfile}\n`);
  if (process.argv.includes("--portable-console-signal")) {
    process.on("exit", () => { writeSync(1, "unexpected-exit-callback\n"); });
    process.emit(process.platform === "win32" ? "SIGINT" : "SIGBUS");
    throw new Error("Signal did not exit");
  }
  try {
    for (let frame = 0; frame < 3000; frame++) {
      io.pollConsoleEvent();
      const event = io.takeQueuedEvent();
      if (event?.kind === "console") {
        writeSync(1, `command:${event.text}\n`);
        if (event.text === "quit") return;
      }
      await Bun.sleep(1);
    }
    throw new Error("Console input deadline expired");
  } finally {
    io.close();
    writeSync(1, "console-closed\n");
    // Keep the private slave open while the parent inspects restored settings.
    if (process.stdin.isTTY) await Bun.sleep(100);
  }
}

if (process.argv.includes("--portable-console-child")) {
  await runChild();
} else describe("portable runtime console", () => {
  test("every release target selects a known ABI and other targets reject", () => {
    const platforms: readonly ("linux" | "darwin")[] = ["linux", "darwin"];
    for (const platform of platforms) {
      for (const architecture of ["x64", "arm64"]) expect(consolePlatform(platform, architecture)).toBe(platform);
    }
    expect(consolePlatform("win32", "x64")).toBe("win32");
    expect(() => consolePlatform("linux", "ia32")).toThrow("Unsupported console platform");
    expect(() => consolePlatform("freebsd", "x64")).toThrow("Unsupported console platform");
    expect(signalActionSize("linux")).toBe(152);
    expect(signalActionSize("darwin")).toBe(16);
  });

  test("glibc terminal configuration retains signal bytes and all unrelated fields", () => {
    const saved = new Uint8Array(60).fill(255);
    saved[19] = 8;
    const expected = new Uint8Array(saved);
    expected[0] = 207; expected[12] = 245; expected[22] = 0; expected[23] = 1;
    const configured = consoleTermios(saved, "linux");
    expect(configured.erase).toBe(8);
    expect(configured.bytes).toEqual(expected);
    expect(saved[0]).toBe(255);
    expect(termiosSize("linux")).toBe(60);
    expect(() => consoleTermios(new Uint8Array(59), "linux")).toThrow("ABI record length");
  });

  test("Darwin LP64 preserves high flag words, speeds, padding and signal bytes", () => {
    const saved = new Uint8Array(72).fill(255);
    saved[35] = 127;
    const expected = new Uint8Array(saved);
    expected[0] = 207; expected[24] = 247; expected[25] = 254; expected[48] = 1; expected[49] = 0;
    const configured = consoleTermios(saved, "darwin");
    expect(configured.erase).toBe(127);
    expect(configured.bytes).toEqual(expected);
    expect(saved[24]).toBe(255);
    expect(termiosSize("darwin")).toBe(72);
    expect(() => consoleTermios(new Uint8Array(60), "darwin")).toThrow("ABI record length");
  });

  test("native process console startup accepts piped commands and releases its resources", async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, "--portable-console-child"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 5000,
    });
    child.stdin.write("status\r\nquit\n"); child.stdin.end();
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(status).toBe(0);
    expect(stdout).toContain("console-ready:line-latin1\ncommand:status\ncommand:quit\nconsole-closed\n");
  });

  test("native signal event dispatch shuts down graphics and bypasses JavaScript exit callbacks", async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, "--portable-console-child", "--portable-console-signal"], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000,
    });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(status).toBe(0); expect(stderr).toBe("");
    const signal = process.platform === "win32" ? 2 : process.platform === "darwin" ? 10 : 7;
    expect(stdout).toContain(`Received signal ${signal}, exiting...\ngraphics-shutdown\n`);
    expect(stdout).not.toContain("unexpected-exit-callback");
  });

  test("private native terminal edits, completes, submits Enter and restores its flags", async () => {
    let output = "", sent = false;
    const inspection: { restored: readonly number[] | null } = { restored: null };
    const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (owned, bytes) => {
      output += new TextDecoder().decode(bytes);
      if (!sent && output.includes("console-ready:")) {
        sent = true;
        owned.write("staX\btus\r\t\rquit\r");
      }
      if (output.includes("console-closed") && process.platform !== "win32") {
        inspection.restored = [owned.inputFlags, owned.outputFlags, owned.localFlags, owned.controlFlags];
      }
    } });
    const before = [terminal.inputFlags, terminal.outputFlags, terminal.localFlags, terminal.controlFlags];
    const child = Bun.spawn([process.execPath, import.meta.path, "--portable-console-child"], { terminal, timeout: 5000 });
    try {
      expect({ status: await child.exited, output }).toMatchObject({ status: 0 });
      // Terminal data may be dispatched just after process exit.
      for (let i = 0; i < 100 && !output.includes("console-closed"); i++) await Bun.sleep(1);
      expect(output).toContain("command:status");
      expect(output).toContain("command:completed");
      expect(output).toContain("command:quit");
      expect(output).toContain("console-closed");
      const profile = process.platform === "win32" ? "tty-windows" : process.platform === "darwin" ? "tty-darwin" : "tty-linux-glibc";
      expect(output).toContain(`console-ready:${profile}`);
      if (process.platform !== "win32") expect(inspection.restored).toEqual(before);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      terminal.close();
    }
  });

  test("private native terminal receives a real shutdown signal and closes its editor", async () => {
    let output = "";
    const ready = Promise.withResolvers<void>();
    const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_owned, bytes) => {
      output += new TextDecoder().decode(bytes);
      if (output.includes("console-ready:")) ready.resolve();
    } });
    const child = Bun.spawn([process.execPath, import.meta.path, "--portable-console-child"], { terminal, timeout: 5000 });
    try {
      await Promise.race([ready.promise, child.exited]);
      expect(output).toContain("console-ready:");
      // ConPTY supplies an actual console key. Windows process.kill cannot
      // deliver SIGINT, whereas POSIX can send SIGTERM to our owned child.
      if (process.platform === "win32") terminal.write("\x03");
      else child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      for (let i = 0; i < 100 && !output.includes("Shutdown tty console"); i++) await Bun.sleep(1);
      expect(output).toContain(`Received signal ${process.platform === "win32" ? 2 : 15}, exiting...`);
      expect(output).toContain("graphics-shutdown");
      expect(output).toContain("Shutdown tty console");
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      terminal.close();
    }
  });
});
