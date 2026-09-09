import { expect, test } from "bun:test";
import { BotMemory } from "../src/botlib/memory.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { ZoneArena, ZoneTag } from "../src/core/zone.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";

test("AvailableMemory reads the shared source zone with release32 allocation overhead", () => {
  const zone = new ZoneArena(1024), memory = new BotMemory(undefined, zone);
  expect(memory.availableMemory()).toBe(1024);
  const allocation = memory.allocate(5, "heap", true);
  // Five payload bytes, four-byte bot ID, 20-byte block, four-byte tail, aligned to four.
  expect(memory.availableMemory()).toBe(1024 - 36);
  const external = zone.allocate(9, ZoneTag.General);
  expect(memory.availableMemory()).toBe(1024 - 72);
  memory.free(allocation);
  expect(memory.availableMemory()).toBe(1024 - 36);
  zone.free(external);
  expect(memory.availableMemory()).toBe(1024);
  const tagged = memory.allocate(0, "heap", false);
  expect(memory.availableMemory()).toBe(1024 - 28);
  zone.freeTags(ZoneTag.Botlib);
  expect(memory.availableMemory()).toBe(1024);
  expect(() => tagged.bytes).toThrow("no longer valid");
  zone.checkHeap();
  zone.dispose();
  expect(() => memory.availableMemory()).toThrow("zone has been disposed");
});

test("AvailableMemory includes unsplittable fragments and preserves the source zone header convention", () => {
  const zone = new ZoneArena(128), memory = new BotMemory(undefined, zone);
  const allocation = memory.allocate(5, "heap", false);
  // The 96-byte free block leaves only 60 bytes, at most MINFRAGMENT, so all 96 are used.
  expect(memory.availableMemory()).toBe(32);
  memory.free(allocation);
  expect(memory.availableMemory()).toBe(128);
  zone.checkHeap(); zone.dispose();
});

test("AvailableMemory excludes the separately owned hunk and rejects unaccounted heap owners", () => {
  const arena = new HunkArena(1024, () => undefined), accounting = new SourceHunkAccounting(arena);
  const zone = new ZoneArena(1024), memory = new BotMemory({ kind: "source-hunk", accounting }, zone);
  const allocation = memory.allocate(5, "hunk", true);
  expect(memory.availableMemory()).toBe(1024);
  memory.free(allocation);
  expect(memory.availableMemory()).toBe(1024);
  expect(allocation.bytes.length).toBe(5);
  for (const diagnostic of [new BotMemory(), new BotMemory({ kind: "source-hunk", accounting })]) {
    expect(() => diagnostic.availableMemory()).toThrow("unaccounted heap storage");
  }
  arena.clear(null); zone.dispose();
});

test("selected source memory print functions are callable empty operations", () => {
  const zone = new ZoneArena(1024), memory = new BotMemory(undefined, zone);
  const allocation = memory.allocate(5, "heap", true), bytes = allocation.bytes;
  bytes[0] = 97;
  for (const owner of [memory, new BotMemory()]) {
    expect(owner.printUsedMemorySize()).toBeUndefined();
    expect(owner.printMemoryLabels()).toBeUndefined();
  }
  expect(memory.availableMemory()).toBe(988);
  expect(allocation.bytes).toBe(bytes);
  expect([...bytes]).toEqual([97, 0, 0, 0, 0]);
  memory.free(allocation); zone.dispose();
  expect(memory.printUsedMemorySize()).toBeUndefined();
  expect(memory.printMemoryLabels()).toBeUndefined();
});
