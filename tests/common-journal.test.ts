import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { ReadFileMemory } from "../src/assets/read-file-memory.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { ZoneArena } from "../src/core/zone.ts";
import { CommonJournal } from "../src/engine/common-journal.ts";
import { CommonEventMemory } from "../src/engine/event-memory.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";

const directories: string[] = [], owners: CommonFileState[] = [];
afterEach(() => {
  for (const files of owners.splice(0)) files.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

async function replay(data: Uint8Array) {
  const directory = mkdtempSync(join(tmpdir(), "q3-journal-boundary-")); directories.push(directory);
  const product = join(directory, "baseq3"); mkdirSync(product);
  writeFileSync(join(product, "journaldata.dat"), data);
  writeFileSync(join(product, "journal.dat"), new Uint8Array());
  const cvars = new CvarRegistry(); cvars.set("journal", "2");
  const files = new CommonFileState({ dataPath: directory, homePath: directory, cdPath: null, product: "baseq3" },
    () => undefined, new SoundOutput(), cvars);
  owners.push(files);
  await files.initialize({ checksumFeed: 0, random: () => 0 }, () => undefined);
  const zone = new ZoneArena(1024), eventMemory = new CommonEventMemory(() => zone);
  const journal = new CommonJournal(cvars, () => files, () => undefined, () => undefined, () => undefined, eventMemory);
  journal.initialize();
  return journal;
}

function lengths(...values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4), view = new DataView(bytes.buffer);
  for (const [index, value] of values.entries()) view.setInt32(index * 4, value, true);
  return bytes;
}

test("large journal config lengths reach actual hunk allocation after consuming only the header", async () => {
  const journal = await replay(lengths(128 * 1024 * 1024 + 1, 73));
  const hunk = new HunkArena(1024, () => undefined), memory = new ReadFileMemory(() => hunk);
  expect(() => journal.readFileRetained("large.cfg", memory)).toThrow("Hunk_AllocateTempMemory: failed on 134217740");
  expect(memory.loadCount).toBe(0); expect(memory.loadStack).toBe(0);
  expect(journal.readLength("next.cfg")).toBe(73);
});

test("journal config allocation still rejects signed length plus terminator overflow", async () => {
  const journal = await replay(lengths(0x7fffffff, 0x7fffffff, 73));
  const hunk = new HunkArena(1024, () => undefined), memory = new ReadFileMemory(() => hunk);
  expect(() => journal.readFileRetained("overflow.cfg", memory)).toThrow("Invalid FS_ReadFile allocation length");
  expect(() => journal.readFile("overflow.cfg")).toThrow("Invalid journal config length: 2147483647");
  expect(journal.readLength("next.cfg")).toBe(73);
  expect(memory.loadCount).toBe(0); expect(memory.loadStack).toBe(0);
});
