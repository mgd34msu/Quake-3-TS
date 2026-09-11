import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { CommonError } from "../src/core/common-error.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { sourceZip } from "./pk3-source-fixture.ts";

const fixtures: { readonly directory: string; readonly files: CommonFileState; readonly sound: SoundOutput }[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    try { fixture.files.close(); } finally { fixture.sound.close(); }
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function create(): Promise<CommonFileState> {
  const directory = await mkdtemp(join(tmpdir(), "quake3-fs-lifetime-"));
  await mkdir(join(directory, "baseq3"));
  await writeFile(join(directory, "baseq3", "default.cfg"), "set test 1\n");
  await writeFile(join(directory, "baseq3", "state.arena"), "abcdef");
  await writeFile(join(directory, "baseq3", "empty.cfg"), "");
  const sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: directory, homePath: directory, cdPath: null, product: "baseq3" }, () => {}, sound, new CvarRegistry());
  fixtures.push({ directory, files, sound });
  await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
  return files;
}

test("common restart preserves its writer and zero-size rows, retires old mounts and reuses source slots", async () => {
  const files = await create();
  const before = files.current;
  const positive = before.openRead("state.arena");
  const empty = before.openRead("empty.cfg");
  const log = files.writable.openAppend("common.log", false);
  if (positive === undefined || empty === undefined || log === null) throw new Error("Expected real filesystem resources");
  expect(positive.length).toBe(6);
  expect(empty.length).toBe(0);
  log.write("before\n");
  expect(new TextDecoder().decode(before.readSync("default.cfg"))).toBe("set test 1\n");
  await files.restart({ checksumFeed: 17, random: () => 0 }, () => {});
  expect(files.current).not.toBe(before);
  expect(() => before.has("default.cfg")).toThrow();
  expect(() => before.list()).toThrow();
  expect(() => before.openRead("state.arena")).toThrow();
  expect(() => files.current.readInto(positive.file, new Uint8Array(1))).toThrow();
  const poison = new Uint8Array(3).fill(126);
  expect(files.current.readInto(empty.file, poison)).toBe(0);
  expect(poison).toEqual(new Uint8Array([126, 126, 126]));
  const replacement = files.current.openRead("default.cfg");
  if (replacement === undefined) throw new Error("Expected replacement open");
  expect(replacement.file).toBe(positive.file);
  expect(files.current.readInto(positive.file, poison)).toBe(3);
  expect(new TextDecoder().decode(poison)).toBe("set");
  log.write("after\n");
  expect(new TextDecoder().decode(files.current.readSync("common.log"))).toBe("before\nafter\n");
  files.current.closeFile(replacement.file);
  files.current.closeFile(empty.file);
  files.close();
  files.close();
  expect(() => log.write("closed")).toThrow();
  log.close();
  expect(() => files.current).toThrow();
  expect(() => files.writable.openBotLog("late.log")).toThrow("closed");
  expect(await Bun.file(Buffer.concat([files.roots.homePath.resolvedBytes(), Buffer.from("/baseq3/late.log")])).exists()).toBe(false);
});

test("a rejected remount retains the reached new mount without restoring old mounts", async () => {
  const files = await create();
  const before = files.current;
  const log = files.writable.openWrite("survivor.log", false);
  if (log === null) throw new Error("Expected writer");
  let calls = 0;
  const failure = new CommonError("drop", "retired caller");
  const remount = files.restart({ checksumFeed: 1, random: () => 0 }, () => {
    calls++;
    if (calls === 3) throw failure;
  });
  const reached = files.current;
  expect(reached === before).toBe(false);
  expect(() => before.has("default.cfg")).toThrow();
  await expect(remount).rejects.toBe(failure);
  expect(calls).toBe(3);
  expect(files.current === reached).toBe(true);
  log.write("still common-owned\n");
  files.close();
  expect(() => log.write("closed")).toThrow();
});

test("unique direct reads retain independent packed and loose cursors across common restart", async () => {
  const files = await create();
  const encoder = new TextEncoder();
  await writeFile(Buffer.concat([files.roots.dataPath.resolvedBytes(), Buffer.from("/baseq3/streams.pk3")]), sourceZip([
    { name: encoder.encode("music/intro.wav"), data: encoder.encode("01234567"), method: 8, utf8: false },
    { name: encoder.encode("demos/run.dm_68"), data: encoder.encode("abcdefgh"), method: 0, utf8: false },
  ]));
  await files.restart({ checksumFeed: 1, random: () => 0 }, () => {});
  const before = files.current;
  const retained = ["music/intro.wav", "music/intro.wav", "demos/run.dm_68", "state.arena"].map(path => {
    const opened = before.openUniqueRead(path);
    if (opened === undefined) throw new Error(`Missing unique fixture ${path}`);
    const prefix = new Uint8Array(2);
    expect(before.readInto(opened.file, prefix)).toBe(2);
    return { ...opened, prefix: new TextDecoder().decode(prefix) };
  });
  expect(retained.map(opened => opened.prefix)).toEqual(["01", "01", "ab", "ab"]);
  expect(retained.map(opened => opened.length)).toEqual([8, 8, 8, 6]);
  const sized = before.openRead("music/intro.wav");
  if (sized === undefined) throw new Error("Missing mode fixture");
  expect(before.readSync("demos/run.dm_68")).toEqual(encoder.encode("abcdefgh"));
  await files.restart({ checksumFeed: 17, random: () => 0 }, () => {});
  expect(() => before.openUniqueRead("state.arena")).toThrow("retired");
  expect(() => files.current.readInto(sized.file, new Uint8Array(1))).toThrow("not readable");
  const tails = retained.map(opened => {
    const tail = new Uint8Array(9).fill(126);
    const copied = files.current.readInto(opened.file, tail);
    expect(files.current.readInto(opened.file, new Uint8Array(1))).toBe(0);
    files.current.closeFile(opened.file);
    return { copied, text: new TextDecoder().decode(tail) };
  });
  expect(tails).toEqual([
    { copied: 6, text: "234567~~~" }, { copied: 6, text: "234567~~~" },
    { copied: 6, text: "cdefgh~~~" }, { copied: 4, text: "cdef~~~~~" },
  ]);
  expect(files.current.openUniqueRead("missing.wav")).toBeUndefined();
});

test("closing during an actual remount prevents late publication and releases shared writers", async () => {
  const files = await create();
  const log = files.writable.openWrite("closing.log", false);
  if (log === null) throw new Error("Expected writer");
  const pending = files.restart({ checksumFeed: 5, random: () => 0 }, () => {});
  await expect(files.restart({ checksumFeed: 6, random: () => 0 }, () => {})).rejects.toThrow("awaited");
  files.close();
  await expect(pending).rejects.toThrow("retired");
  expect(() => files.current).toThrow();
  expect(() => log.write("closed")).toThrow();
});
