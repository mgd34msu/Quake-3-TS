import { expect, test } from "bun:test";
import { MASTER_SERVER_PORT, parseNetworkDefaults } from "../src/core/network-defaults.ts";
import { networkDefaultsPlugin } from "../tools/network-build-defaults.ts";
import { resolve } from "node:path";

test("source endpoint defaults and Construct lowercase overrides", () => {
  expect(parseNetworkDefaults({})).toEqual({ masterServer: "master.quake3arena.com", authorizeServer: "authorize.quake3arena.com", authorizePort: 27952 });
  expect(parseNetworkDefaults({ masterServer: "MASTER.Example", authorizeServer: "AUTH.Example", authorizePort: "65535" }))
    .toEqual({ masterServer: "master.example", authorizeServer: "auth.example", authorizePort: 65535 });
  expect(parseNetworkDefaults({ authorizePort: "1" }).authorizePort).toBe(1);
  expect(MASTER_SERVER_PORT).toBe(27950);
});

test("endpoint host input remains the resolver's responsibility", () => {
  for (const host of ["", " ", "EXAMPLE:123", "quoted\"host", "é"]) {
    expect(parseNetworkDefaults({ masterServer: host }).masterServer).toBe(host.toLowerCase());
  }
  for (const host of ["host\0suffix", "😀"]) expect(() => parseNetworkDefaults({ authorizeServer: host })).toThrow("source bytes");
});

test("authorization port rejects malformed values and overflow at configuration entry", () => {
  for (const authorizePort of ["", "0", "-1", "65536", "4294995248", "1.5", "NaN", "Infinity", "1e2", " 123", "123x"]) {
    expect(() => parseNetworkDefaults({ authorizePort })).toThrow("1 through 65535");
  }
});

test("raw Bun environment config reaches shared server registration", async () => {
  const child = Bun.spawn([process.execPath, "--eval", `
    import { NETWORK_DEFAULTS } from "./src/core/network-defaults.ts";
    import { CvarRegistry } from "./src/core/cvar.ts";
    import { registerServerCvars } from "./src/server/config.ts";
    const cvars = new CvarRegistry();
    registerServerCvars(cvars);
    process.stdout.write(JSON.stringify({ ...NETWORK_DEFAULTS, masterCvar: cvars.get("sv_master1")?.value }));
  `], { cwd: import.meta.dir + "/..", env: { ...process.env, Q3_MASTER_SERVER: "MASTER.invalid", Q3_AUTH_SERVER: "AUTH.invalid", Q3_AUTH_PORT: "12345" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(""); expect(status).toBe(0);
  const actual: unknown = JSON.parse(stdout);
  expect(actual).toEqual({ masterServer: "master.invalid", authorizeServer: "auth.invalid", authorizePort: 12345, masterCvar: "master.invalid" });
});

test("build rejects invalid options before creating a workspace snapshot", async () => {
  for (const args of [["--auth-port", "65536"], ["--master-server"], ["--master-port", "1234"]]) {
    const child = Bun.spawn([process.execPath, "run", "tools/build.ts", ...args], { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(status).not.toBe(0); expect(stdout).toBe(""); expect(stderr).toMatch(/auth-port requires|Missing value|Unknown build option/u);
  }
});

test("actual build plugin freezes endpoint values into the bundle", async () => {
  const workspace = import.meta.dir + "/..";
  const root = resolve(workspace);
  const defaults = parseNetworkDefaults({ masterServer: 'MASTER"$&.invalid', authorizeServer: "AUTH.invalid", authorizePort: "12345" });
  const result = await Bun.build({ entrypoints: [root + "/src/core/network-defaults.ts"], target: "bun",
    plugins: [networkDefaultsPlugin(root, defaults)] });
  expect(result.success).toBe(true);
  const output = result.outputs[0];
  if (output === undefined) throw new Error("Missing endpoint bundle");
  const contents = await output.text();
  expect(contents).not.toContain("process.env");
  const child = Bun.spawn([process.execPath, "--eval", contents + "\nprocess.stdout.write(JSON.stringify(NETWORK_DEFAULTS));"], {
    env: { ...process.env, Q3_MASTER_SERVER: "wrong.invalid", Q3_AUTH_SERVER: "wrong.invalid", Q3_AUTH_PORT: "999" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const actual: unknown = JSON.parse(stdout);
  expect(stderr).toBe(""); expect(status).toBe(0); expect(actual).toEqual(defaults);
});
