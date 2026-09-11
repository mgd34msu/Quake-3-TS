import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissingFileLog } from "../src/assets/missing-file-log.ts";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "quake3-missing-files-"));
  cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
  return root;
}

test("FS_MISSING appends repeated source byte names and closes permanently", () => {
  const path = join(temporaryRoot(), "missing.txt");
  writeFileSync(path, "existing\n");
  const log = new MissingFileLog(path);
  cleanup.push(() => log.close());
  log.record("before-startup");
  log.startup();
  log.record("Textures/Missing.TGA");
  log.record("Textures/Missing.TGA");
  log.startup();
  log.record("caf\xe9.wav");
  const expected = Buffer.from("existing\nTextures/Missing.TGA\nTextures/Missing.TGA\ncaf\xe9.wav\n", "latin1");
  expect(readFileSync(path)).toEqual(expected);
  log.close();
  log.close();
  log.startup();
  log.record("after-close");
  expect(readFileSync(path)).toEqual(expected);
});

test("failed diagnostic opens remain silent and retry at the next startup", () => {
  const root = temporaryRoot(), directory = join(root, "later"), path = join(directory, "missing.txt");
  const log = new MissingFileLog(path);
  cleanup.push(() => log.close());
  expect(() => log.startup()).not.toThrow();
  log.record("unrecorded.cfg");
  expect(existsSync(path)).toBe(false);
  mkdirSync(directory);
  log.startup();
  log.record("recorded.cfg");
  log.close();
  expect(readFileSync(path, "latin1")).toBe("recorded.cfg\n");
});

test("disabled diagnostic lifetime performs no file operations", () => {
  const log = new MissingFileLog(null);
  log.startup();
  log.record("missing.cfg");
  log.close();
  expect(() => log.startup()).not.toThrow();
});

test("actual ordinary misses preserve spelling and repeat order across filesystem restart", async () => {
  const root = temporaryRoot(), dataPath = join(root, "data"), homePath = join(root, "home");
  mkdirSync(join(dataPath, "baseq3"), { recursive: true });
  mkdirSync(join(homePath, "baseq3"), { recursive: true });
  writeFileSync(join(homePath, "baseq3", "found.cfg"), "found");
  const missingFileLogPath = join(root, "missing.txt"), renamed = join(root, "retained.txt");
  const cvars = new CvarRegistry(), sound = new SoundOutput();
  cvars.register("developer", "1");
  const priorLog: string[] = [];
  const files = new CommonFileState({ dataPath, homePath, cdPath: null, product: "baseq3", missingFileLogPath },
    text => {
      if (text.startsWith("Can't find ")) {
        priorLog.push(readFileSync(existsSync(missingFileLogPath) ? missingFileLogPath : renamed, "latin1"));
      }
    }, sound, cvars);
  cleanup.push(() => { try { files.close(); } finally { sound.close(); } });
  const references = { checksumFeed: 0, random: () => 0.25 };
  await files.initialize(references, () => {});
  expect(files.openByMode("/Textures/Missing.TGA", "read")).toBeUndefined();
  expect(files.openByMode("Textures/Missing.TGA", "read")).toBeUndefined();
  expect(files.current.has("probe-only.cfg")).toBe(false);
  expect(files.openByMode("../rejected.cfg", "read")).toBeUndefined();
  expect(files.openByMode("q3key", "read")).toBeUndefined();
  const found = files.openByMode("found.cfg", "read");
  if (found === undefined) throw new Error("Expected the authored loose file");
  files.current.closeFile(found.file);
  expect(readFileSync(missingFileLogPath, "latin1")).toBe("Textures/Missing.TGA\nTextures/Missing.TGA\n");
  expect(priorLog).toEqual(["", "Textures/Missing.TGA\n"]);
  renameSync(missingFileLogPath, renamed);
  await files.restart(references, () => {});
  expect(files.openByMode("after-restart.cfg", "read")).toBeUndefined();
  files.close();
  expect(existsSync(missingFileLogPath)).toBe(false);
  expect(readFileSync(renamed, "latin1")).toBe("Textures/Missing.TGA\nTextures/Missing.TGA\nafter-restart.cfg\n");
  expect(() => files.openByMode("after-close.cfg", "read")).toThrow();
  expect(readFileSync(renamed, "latin1")).toBe("Textures/Missing.TGA\nTextures/Missing.TGA\nafter-restart.cfg\n");
});

test("failed opt-in sink never changes an ordinary missing-file result", async () => {
  const root = temporaryRoot(), dataPath = join(root, "data"), homePath = join(root, "home");
  mkdirSync(join(dataPath, "baseq3"), { recursive: true });
  mkdirSync(join(homePath, "baseq3"), { recursive: true });
  const directory = join(root, "diagnostics"), missingFileLogPath = join(directory, "missing.txt");
  const sound = new SoundOutput();
  const files = new CommonFileState({ dataPath, homePath, cdPath: null, product: "baseq3", missingFileLogPath },
    () => undefined, sound, new CvarRegistry());
  cleanup.push(() => { try { files.close(); } finally { sound.close(); } });
  const references = { checksumFeed: 0, random: () => 0.25 };
  await files.initialize(references, () => {});
  expect(files.openByMode("unrecorded.cfg", "read")).toBeUndefined();
  expect(existsSync(missingFileLogPath)).toBe(false);
  mkdirSync(directory);
  await files.restart(references, () => {});
  expect(files.openByMode("recorded.cfg", "read")).toBeUndefined();
  files.close();
  expect(readFileSync(missingFileLogPath, "latin1")).toBe("recorded.cfg\n");
});
