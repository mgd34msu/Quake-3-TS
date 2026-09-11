import { expect, spyOn, test } from "bun:test";
import { ZoneArena, ZoneTag } from "../src/core/zone.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { BotMemory } from "../src/botlib/memory.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";

test("zone managed debug reports real provenance and bytes without changing release layout", () => {
  const zone = new ZoneArena(256, "main", { onAllocationFailure: () => undefined });
  const release = new ZoneArena(256);
  const origin = { file: "caller.ts", line: 7, label: "text" };
  const allocation = zone.allocate(5, ZoneTag.General, true, origin);
  const ordinary = release.allocate(5, ZoneTag.General, true);
  allocation.bytes.set([65, 0, 31, 126, 127]);
  origin.line = 99;
  expect(allocation.bytes.byteOffset).toBe(ordinary.bytes.byteOffset);
  expect(zone.memoryRemaining()).toBe(release.memoryRemaining());
  let log = "";
  zone.logHeap("MAIN", text => { log += text; });
  expect(log).toContain("size =        5: caller.ts, line: 7 (text) [A__~_]\r\n");
  expect(log).toContain("32 MAIN memory in 1 blocks\r\n27 MAIN memory overhead\r\n");
  zone.free(allocation);
  expect(zone.ownsLiveAllocation(allocation)).toBe(false);
  log = "";
  zone.logHeap("MAIN", text => { log += text; });
  expect(log).not.toContain("caller.ts");
});

test("zone preserves last-block omission and logs allocation failure before fatal", () => {
  let failures = 0;
  const zone = new ZoneArena(128, "main", { onAllocationFailure: () => { failures++; } });
  zone.allocate(8, ZoneTag.General);
  let log = "";
  zone.logHeap("MAIN", text => { log += text; });
  expect(log).toContain("0 MAIN memory in 0 blocks");
  expect(() => zone.allocate(128, ZoneTag.General)).toThrow("Z_Malloc: failed on allocation of 152 bytes from the main zone");
  expect(failures).toBe(1);
});

test("hunk debug small log groups by file and line and omits expired allocations", () => {
  const arena = new HunkArena(256, () => undefined, { writeLog: () => undefined });
  const first = arena.allocate(3, "low", { file: "Caller.ts", line: 4, label: "first" });
  arena.setMark();
  arena.allocate(33, "low", { file: "CALLER.ts", line: 4, label: "second" });
  arena.allocate(1, "low");
  arena.allocateTemp(1);
  let log = "";
  arena.log(text => { log += text; }, true);
  expect(log).toContain("size =       96: CALLER.ts, line: 4 (second)");
  expect(log).toContain("memory-debug-profile.test.ts, line:");
  expect(log).toContain("(Hunk_Alloc)");
  expect(log).not.toContain("<unattributed>");
  expect(log).toContain("128 Hunk memory\r\n2 hunk blocks");
  arena.clearToMark();
  expect(arena.ownsLiveAllocation(first)).toBe(true);
  log = "";
  arena.log(text => { log += text; });
  expect(log).toContain("32 Hunk memory\r\n1 hunk blocks");
  expect(log).not.toContain("second");
  arena.clear(null);
  log = "";
  arena.log(text => { log += text; });
  expect(log).toContain("0 Hunk memory\r\n0 hunk blocks");
});

test("hunk debug OOM emits both logs before preserving drop and release reservations", () => {
  let log = "";
  const arena = new HunkArena(32, () => undefined, { writeLog: text => { log += text; } });
  arena.allocate(1, "low");
  expect(() => arena.allocate(1, "low")).toThrow("Hunk_Alloc failed on 32");
  expect(log).toContain("Hunk log\r\n");
  expect(log).toContain("Hunk Small log\r\n");
  expect(arena.memoryRemaining()).toBe(0);
});

test("bot debug counters and newest-first labels share actual zone and hunk lifetimes", () => {
  const printed: string[] = [], logged: string[] = [];
  const arena = new HunkArena(8192, () => undefined), zone = new ZoneArena(8192);
  const memory = new BotMemory({ kind: "source-hunk", accounting: new SourceHunkAccounting(arena) }, zone, {
    kind: "debug", print: (severity, text) => { printed.push(`${severity}:${text}`); }, writeLog: text => { logged.push(text); },
  });
  const heap = memory.allocate(1024, "heap", true, { file: "heap.ts", line: 9, label: "heap" });
  const hunk = memory.allocate(2048, "hunk", true, { file: "hunk.ts", line: 3, label: "hunk" });
  expect(memory.memoryByteSize(heap)).toBe(1028);
  memory.printMemoryLabels();
  expect(printed).toEqual(["message:total allocated memory: 3 KB\n", "message:total botlib memory: 3 KB\n", "message:total memory blocks: 2\n"]);
  expect(logged[2]).toContain("hunk,     2052:");
  expect(logged[3]).toContain("heap,     1028:");
  const remaining = arena.memoryRemaining();
  memory.free(hunk);
  expect(hunk.bytes.length).toBe(2048);
  expect(arena.memoryRemaining()).toBe(remaining);
  memory.dumpMemory();
  expect(() => heap.bytes).toThrow();
  expect(zone.memoryRemaining()).toBe(8192);
  printed.length = 0;
  memory.printUsedMemorySize();
  expect(printed.at(-1)).toBe("message:total memory blocks: 0\n");
});

test("bot manager source guards distinguish null, corrupt and foreign handles", () => {
  const errors: string[] = [];
  const memory = new BotMemory(undefined, undefined, { kind: "debug",
    print: (severity, text) => { if (severity === "fatal") errors.push(text); }, writeLog: () => undefined });
  memory.free(null);
  memory.free(new BotMemory().allocate(1, "heap", false));
  const allocation = memory.allocate(4, "heap", false);
  const payload = allocation.bytes;
  new DataView(payload.buffer).setUint32(payload.byteOffset - 4, 0, true);
  memory.free(allocation);
  expect(memory.memoryByteSize(allocation)).toBe(0);
  expect(errors).toEqual(["FreeMemory: NULL pointer\n", "FreeMemory: invalid memory block\n", "FreeMemory: invalid memory block\n", "MemoryByteSize: invalid memory block\n"]);
  const manager = new BotMemory(undefined, undefined, { kind: "manager",
    print: () => { throw new Error("manager null should be silent"); }, writeLog: () => undefined });
  expect(manager.memoryByteSize(null)).toBe(0);
  manager.free(null);
});

test("bot debug reports discard allocations retired by their real arena owners", () => {
  const printed: string[] = [];
  const arena = new HunkArena(256, () => undefined), zone = new ZoneArena(256);
  const memory = new BotMemory({ kind: "source-hunk", accounting: new SourceHunkAccounting(arena) }, zone, {
    kind: "manager", print: (_severity, text) => { printed.push(text); }, writeLog: () => undefined,
  });
  memory.allocate(4, "heap", false);
  memory.allocate(4, "hunk", false);
  zone.freeTags(ZoneTag.Botlib);
  arena.clear(null);
  memory.printUsedMemorySize();
  expect(printed.at(-1)).toBe("total memory blocks: 0\n");
});

test("automatic debug provenance records the reached TypeScript call sites and hunk source labels", async () => {
  const sourceLines = (await Bun.file(import.meta.path).text()).split("\n");
  const zone = new ZoneArena(1024, "main", { onAllocationFailure: () => undefined });
  const arena = new HunkArena(1024, () => undefined, { writeLog: () => undefined });
  const accounting = new SourceHunkAccounting(arena);
  let botLog = "";
  const memory = new BotMemory({ kind: "source-hunk", accounting }, zone, { kind: "debug",
    print: () => undefined, writeLog: text => { botLog += text; } });
  zone.allocate(7, ZoneTag.General);
  arena.allocate(9, "low");
  accounting.reserve("first resource", "first", 11, "low");
  accounting.reserve("second resource", "second", 13, "low");
  memory.allocate(15, "heap", true);
  memory.allocate(17, "hunk", false);
  let zoneLog = "", hunkLog = "";
  zone.logHeap("MAIN", text => { zoneLog += text; });
  arena.log(text => { hunkLog += text; }, true);
  memory.printMemoryLabels();
  for (const [log, statement, label] of [
    [zoneLog, "zone.allocate(7, ZoneTag.General);", "Z_TagMalloc"],
    [hunkLog, "arena.allocate(9, \"low\");", "Hunk_Alloc"],
    [hunkLog, "accounting.reserve(\"first resource\", \"first\", 11, \"low\");", "first resource"],
    [hunkLog, "accounting.reserve(\"second resource\", \"second\", 13, \"low\");", "second resource"],
  ] satisfies readonly [string, string, string][]) {
    const line = sourceLines.findIndex(value => value.trim() === statement) + 1;
    expect(line).toBeGreaterThan(0);
    expect(log).toContain(`${import.meta.path}, line: ${line} (${label})`);
  }
  for (const [statement, label] of [
    ["memory.allocate(15, \"heap\", true);", "GetClearedMemory"],
    ["memory.allocate(17, \"hunk\", false);", "GetHunkMemory"],
  ] satisfies readonly [string, string][]) {
    const line = sourceLines.findIndex(value => value.trim() === statement) + 1;
    expect(line).toBeGreaterThan(0);
    expect(botLog).toContain(`${import.meta.path.padStart(24)} line ${String(line).padStart(6)}: ${label}`);
  }
});

test("release, manager and explicit-provenance allocations never capture a stack", () => {
  const capture = spyOn(Error, "captureStackTrace");
  try {
    const zone = new ZoneArena(1024);
    const arena = new HunkArena(1024, () => undefined);
    zone.allocate(1, ZoneTag.General);
    arena.allocate(1, "low");
    new SourceHunkAccounting(arena).reserve("release", "resource", 1, "low");
    new BotMemory().allocate(1, "heap", false);
    new BotMemory(undefined, undefined, { kind: "manager", print: () => undefined,
      writeLog: () => undefined }).allocate(1, "hunk", false);
    const origin = { label: "explicit", file: "explicit.ts", line: 1 };
    new ZoneArena(256, "main", { onAllocationFailure: () => undefined }).allocate(1, ZoneTag.General, false, origin);
    new HunkArena(256, () => undefined, { writeLog: () => undefined }).allocate(1, "low", origin);
    new BotMemory(undefined, undefined, { kind: "debug", print: () => undefined,
      writeLog: () => undefined }).allocate(1, "heap", false, origin);
    expect(capture).not.toHaveBeenCalled();
  } finally { capture.mockRestore(); }
});
