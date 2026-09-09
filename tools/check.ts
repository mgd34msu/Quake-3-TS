import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { findDataPath } from "../src/engine/data-path.ts";
import { WorkspaceSnapshot } from "./workspace-snapshot.ts";
import { usesGlTestFlag } from "./test-selection.ts";

const args = process.argv.slice(2);
if (args.some(argument => argument !== "--portable") || args.length > 1) {
  throw new Error("Usage: bun tools/check.ts [--portable]");
}
const portable = args.includes("--portable");
const glDriver = process.env["Q3_TEST_GL_DRIVER"] ?? "offscreen";
const started = new Date().toISOString();
const workspace = process.cwd();
const dataPath = portable ? process.env["Q3_DATA"] : await findDataPath();
if (!portable && (dataPath === undefined || !await Bun.file(join(dataPath, "missionpack", "pak0.pk3")).exists())) {
  throw new Error("Full verification requires both baseq3 and missionpack retail data. Set Q3_DATA or use the explicitly incomplete --portable profile.");
}
const snapshot = await WorkspaceSnapshot.capture(workspace);
const snapshotPath = await snapshot.materialize(join(workspace, ".artifacts/snapshots"), "check-");
process.stdout.write(`Checking owned snapshot ${snapshot.manifest.sha256}: ${snapshotPath}\n`);
const baseEnvironment = {
  ...process.env,
  ...(dataPath === undefined ? {} : { Q3_DATA: resolve(dataPath) }),
  SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy",
  QUAKE_GL_TEST: "0",
  QUAKE3_COLLISION_CORPUS: portable ? "0" : "1",
};
const commands = [
  { argv: [process.execPath, "run", "typecheck"], env: baseEnvironment },
  { argv: [process.execPath, "run", "policy"], env: baseEnvironment },
  { argv: [process.execPath, "test"], env: baseEnvironment },
];
if (!portable) {
  const glTests: string[] = [];
  for (const relativePath of await readdir(join(snapshotPath, "tests"), { recursive: true })) {
    if (!relativePath.endsWith(".test.ts")) continue;
    const path = join("tests", relativePath);
    if (usesGlTestFlag(path, await Bun.file(join(snapshotPath, path)).text())) glTests.push(path);
  }
  if (glTests.length === 0) throw new Error("No native GL verification tests found");
  commands.push({
    argv: [process.execPath, "test", ...glTests.sort()],
    env: { ...baseEnvironment, SDL_VIDEODRIVER: glDriver, QUAKE_GL_TEST: "1" },
  });
}
const results: { readonly command: readonly string[]; readonly videoDriver: string; readonly exitCode: number; readonly milliseconds: number }[] = [];
let exitCode = 0;

for (const command of commands) {
  process.stdout.write(`$ SDL_VIDEODRIVER=${command.env.SDL_VIDEODRIVER} ${command.argv.join(" ")}\n`);
  const before = performance.now();
  const child = Bun.spawn(command.argv, { cwd: snapshotPath, env: command.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  exitCode = await child.exited;
  results.push({ command: command.argv, videoDriver: command.env.SDL_VIDEODRIVER, exitCode, milliseconds: performance.now() - before });
  if (exitCode !== 0) break;
}

const checkedSnapshot = await WorkspaceSnapshot.capture(snapshotPath);
const currentWorkspace = await WorkspaceSnapshot.capture(workspace);
const snapshotUnchanged = checkedSnapshot.manifest.sha256 === snapshot.manifest.sha256;
const workspaceMatchesSnapshot = currentWorkspace.manifest.sha256 === snapshot.manifest.sha256;
const commandsPassed = exitCode === 0;
if (!snapshotUnchanged || !workspaceMatchesSnapshot) exitCode = 1;
const archivePath = `.artifacts/checks/${started.replaceAll(":", "-")}.json`;
const report = `${JSON.stringify({ started, bun: Bun.version, executable: process.execPath, profile: portable ? "portable" : "full", dataPath: dataPath ?? null,
  snapshotPath, snapshot: snapshot.manifest, checkedSnapshotSha256: checkedSnapshot.manifest.sha256,
  currentWorkspaceSha256: currentWorkspace.manifest.sha256, snapshotUnchanged, workspaceMatchesSnapshot, commandsPassed, results, exitCode }, null, 2)}\n`;
await Bun.write(archivePath, report);
await Bun.write(".artifacts/check.json", report);
process.stdout.write(`Check evidence archived: ${archivePath}\n`);
if (exitCode !== 0) {
  if (!snapshotUnchanged) process.stderr.write("Verification inputs were modified inside the owned snapshot; results cannot be accepted.\n");
  if (!workspaceMatchesSnapshot) process.stderr.write("The workspace changed during verification. Results describe the archived snapshot, not the current workspace; rerun the check.\n");
  if (!commandsPassed) process.stderr.write("Verification command failed; see the failed command above. For an unavailable offscreen driver, set Q3_TEST_GL_DRIVER=x11 under Xvfb.\n");
} else if (portable) {
  process.stdout.write("PORTABLE CHECK ONLY: GL renderer and context-switch gates were not run. Run bun run check on a GL-capable host before accepting the change.\n");
} else {
  process.stdout.write("Full check passed, including native SDL CPU/audio and OpenGL gates. Evidence: .artifacts/check.json\n");
}
process.exitCode = exitCode;
