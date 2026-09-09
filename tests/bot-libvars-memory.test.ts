import { expect, test } from "bun:test";
import { BotLibVars } from "../src/botlib/libvars.ts";
import { BotMemory } from "../src/botlib/memory.ts";
import type { BotMemoryAllocation } from "../src/botlib/memory.ts";
import { ZoneArena, ZoneTag } from "../src/core/zone.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";

test("bot payload views are reused while writes and heap lifetime checks stay live", () => {
  const zone = new ZoneArena(1024);
  for (const memory of [new BotMemory(), new BotMemory(undefined, zone)]) {
    const allocation = memory.allocate(8, "heap", true), bytes = allocation.bytes;
    expect(allocation.bytes).toBe(bytes);
    expect(bytes).toEqual(new Uint8Array(8));
    bytes[3] = 71;
    expect(allocation.bytes[3]).toBe(71);
    memory.free(allocation);
    expect(() => allocation.bytes).toThrow("freed");
    expect(bytes).toEqual(new Uint8Array(8).fill(0xaa));
  }
  expect(zone.memoryRemaining()).toBe(1024);
  zone.checkHeap(); zone.dispose();
});

test("cached bot payloads still reject external zone reclamation", () => {
  const zone = new ZoneArena(1024), memory = new BotMemory(undefined, zone);
  const tagged = memory.allocate(8, "heap", true), bytes = tagged.bytes;
  expect(tagged.bytes).toBe(bytes);
  zone.freeTags(ZoneTag.Botlib);
  expect(() => tagged.bytes).toThrow("no longer valid");
  expect(bytes).toEqual(new Uint8Array(8).fill(0xaa));
  const disposed = memory.allocate(8, "heap", true);
  expect(disposed.bytes).toBe(disposed.bytes);
  zone.dispose();
  expect(() => disposed.bytes).toThrow("no longer valid");
});

test("cached bot hunk payload survives FreeMemory but rejects arena reset", () => {
  const arena = new HunkArena(1024, () => undefined), accounting = new SourceHunkAccounting(arena);
  const memory = new BotMemory({ kind: "source-hunk", accounting });
  const allocation = memory.allocate(8, "hunk", true), bytes = allocation.bytes;
  expect(allocation.bytes).toBe(bytes);
  bytes[2] = 91;
  memory.free(allocation);
  expect(allocation.bytes).toBe(bytes);
  expect(allocation.bytes[2]).toBe(91);
  arena.setMark();
  expect(() => memory.allocate(8, "hunk", true)).toThrow("marks already set");
  arena.clear(null);
  expect(() => allocation.bytes).toThrow("no longer valid");
});

class VariableMemory extends BotMemory {
  readonly blocks: BotMemoryAllocation[] = [];
  readonly events: string[] = [];
  override allocate(size: number, kind: "heap" | "hunk", clear: boolean): BotMemoryAllocation {
    this.events.push(`allocate ${size}`);
    const allocation = super.allocate(size, kind, clear);
    this.blocks.push(allocation);
    return allocation;
  }
  override free(allocation: BotMemoryAllocation): void {
    this.events.push(`free ${allocation.bytes.length}`);
    super.free(allocation);
  }
}

test("libvar comparison reads the retained name bytes at each reached comparison", () => {
  const memory = new VariableMemory(), vars = new BotLibVars(memory);
  vars.getOrCreate("ab", "value");
  const record = memory.blocks[0];
  if (record === undefined) throw new Error("Missing libvar allocation");
  const reads: number[] = [];
  expect(vars.getStringByNameBytes(index => {
    reads.push(index);
    if (index === 0) { record.bytes[25] = 99; return 97; }
    return index === 1 ? 99 : 0;
  })).toBe("value");
  expect(reads).toEqual([0, 1, 2]);
  record.bytes.fill(97, 24);
  expect(vars.getStringByNameBytes(() => 98)).toBe("");
});

test("libvar fields, inline name and current string read the actual zone allocations", () => {
  const zone = new ZoneArena(1024), memory = new VariableMemory(undefined, zone), vars = new BotLibVars(memory);
  const variable = vars.getOrCreate("Speed", "1.5");
  const [record, string] = memory.blocks;
  if (record === undefined || string === undefined) throw new Error("Missing libvar allocations");
  expect(record.bytes.length).toBe(30);
  expect([...record.bytes.subarray(24)]).toEqual([83, 112, 101, 101, 100, 0]);
  expect([...string.bytes]).toEqual([49, 46, 53, 0]);
  const view = new DataView(record.bytes.buffer, record.bytes.byteOffset, 24);
  expect(view.getUint32(20, true)).toBe(0);
  expect(view.getFloat32(16, true)).toBe(1.5);
  view.setFloat32(16, 17.25, true); view.setInt32(8, 7, true); view.setInt32(12, 0, true);
  string.bytes[0] = 50; record.bytes[24] = 115;
  expect(variable.value).toBe(17.25); expect(variable.flags).toBe(7); expect(variable.modified).toBe(false);
  expect(variable.name).toBe("speed"); expect(variable.string).toBe("2.5");
  expect(vars.get("SPEED")).toBe(variable);
  vars.clear(); expect(zone.memoryRemaining()).toBe(1024); expect(() => variable.value).toThrow();
  zone.dispose();
});

test("replacement frees before allocation and shutdown frees strings before records in list order", () => {
  const zone = new ZoneArena(1024), memory = new VariableMemory(undefined, zone), vars = new BotLibVars(memory);
  const old = vars.getOrCreate("x", "1");
  const previous = memory.blocks[1];
  if (previous === undefined) throw new Error("Missing original string");
  const bytes = previous.bytes;
  vars.setNotModified("x"); memory.events.length = 0; vars.set("X", ".x");
  expect(memory.events).toEqual(["free 2", "allocate 3"]);
  expect(() => previous.bytes).toThrow("freed");
  const replacement = memory.blocks[2];
  if (replacement === undefined) throw new Error("Missing replacement string");
  expect(replacement.bytes.byteOffset).toBe(bytes.byteOffset);
  expect(old.string).toBe(".x"); expect(old.value).toBe(Math.fround(7.2)); expect(old.modified).toBe(true);
  vars.getOrCreate("y", "2");
  const secondRecord = memory.blocks[3];
  if (secondRecord === undefined) throw new Error("Missing second record");
  expect(new DataView(secondRecord.bytes.buffer, secondRecord.bytes.byteOffset, 24).getUint32(20, true)).not.toBe(0);
  memory.events.length = 0; vars.clear();
  expect(memory.events).toEqual(["free 2", "free 26", "free 3", "free 26"]);
  expect(zone.memoryRemaining()).toBe(1024); zone.checkHeap(); zone.dispose();
});

test("allocation abort retains source partial records and dangling replacement strings", () => {
  const zone = new ZoneArena(256), vars = new BotLibVars(new BotMemory(undefined, zone));
  expect(() => vars.getOrCreate("new", "1".repeat(512))).toThrow("Z_Malloc");
  expect(vars.get("new")?.modified).toBe(false); expect(vars.getValue("new")).toBe(0);
  vars.clear(); expect(zone.memoryRemaining()).toBe(256);
  const existing = vars.getOrCreate("old", "17"); vars.setNotModified("old");
  expect(() => vars.set("old", "1".repeat(512))).toThrow("Z_Malloc");
  expect(existing.value).toBe(17); expect(existing.modified).toBe(false);
  expect(() => existing.string).toThrow("freed"); expect(() => vars.clear()).toThrow("freed");
  zone.dispose();
});
