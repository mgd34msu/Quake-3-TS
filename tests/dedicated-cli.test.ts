import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../src/main.ts");
const dataPath = process.env["Q3_DATA"];

async function invoke(args: readonly string[]) {
  const child = Bun.spawn([process.execPath, entry, "server", ...args], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15000, killSignal: "SIGKILL",
    env: { ...process.env, QUAKE_SDL2_LIBRARY: "/nonexistent/quake3-dedicated-must-not-load-sdl.so" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("dedicated CLI help needs neither retail data nor a writable home", async () => {
  const result = await invoke(["--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Dedicated server");
  expect(result.stdout).toContain("--home");
  expect(result.stderr).toBe("");
});

test("dedicated CLI rejects missing homes and invalid controls before initialization", async () => {
  for (const item of [
    { args: [], error: "--home is required" },
    { args: ["--home", ""], error: "--home is required" },
    { args: ["--home", "/nonexistent/unused", "--product", "other"], error: "Product must be" },
    { args: ["--home", "/nonexistent/unused", "--frames", "0"], error: "frames must be" },
    { args: ["--home", "/nonexistent/unused", "--frames", "1.5"], error: "frames must be" },
    { args: ["--home", "/nonexistent/unused", "+map", "q3dm1"], error: "Unexpected argument" },
  ]) {
    const result = await invoke(item.args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(item.error);
    expect(result.stdout).not.toContain("FS_Startup");
  }
});

for (const product of ["baseq3", "missionpack"]) {
  test.skipIf(dataPath === undefined)(`${product}: dedicated CLI queues a real map and exits by common-frame limit without SDL`, async () => {
    if (dataPath === undefined) throw new Error("Q3_DATA required");
    const homePath = mkdtempSync(join(tmpdir(), "q3-dedicated-cli-"));
    const map = product === "baseq3" ? "q3dm1" : "mpteam1";
    const result = await invoke(["--data", dataPath, "--home", homePath, "--product", product, "--frames", "2", "--",
      "+set", "dedicated", "1", "+set", "net_noudp", "1", "+set", "bot_enable", "0", "+set", "sv_pure", "0",
      "+set", "logfile", "2", "+map", map, "+echo", "__CLI_MAP_READY__"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Server: ${map}`);
    expect(result.stdout).toContain("__CLI_MAP_READY__ \n");
    expect(result.stdout).toContain("Server Shutdown");
    expect(readFileSync(join(homePath, product, "qconsole.log"), "latin1")).toContain("Common Initialization Complete");
    expect(readFileSync(join(homePath, product, "games.log"), "latin1")).toContain("ShutdownGame:");
  }, 30000);
}

test.skipIf(dataPath === undefined)("native startup roots override CLI defaults and quoted plus survives argv joining", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const homePath = mkdtempSync(join(tmpdir(), "q3-dedicated-cli-roots-"));
  const result = await invoke(["--data", "/nonexistent/overridden-retail", "--home", homePath, "--frames", "1", "--",
    "+set", "fs_basepath", `"${dataPath}"`, "+set", "net_noudp", "1", "+set", "logfile", "2",
    "+set", "cli_quoted", '"value+with spaces"', "+cli_quoted", "+quit", "+echo", "__MUST_NOT_RUN__"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain('"cli_quoted" is:"value+with spaces^7"');
  expect(result.stdout).not.toContain("__MUST_NOT_RUN__");
  expect(readFileSync(join(homePath, "baseq3", "qconsole.log"), "latin1")).toContain("value+with spaces");
});
