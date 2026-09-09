import { describe, expect, test } from "bun:test";
import { HunkArena, initializeHunk } from "../src/core/hunk.ts";
import type { HunkAllocation, HunkClearHost } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";

function fixture(size = 512) {
  const messages: string[] = [];
  return { arena: new HunkArena(size, text => messages.push(text)), messages };
}
function dedicated(log: string[]): HunkClearHost {
  return { kind: "dedicated", shutdownGameProgs: () => { log.push("game"); }, clearVm: () => { log.push("vm"); } };
}

describe("native release hunk bank fixtures", () => {
  test("offsets and every bank counter match untouched common.c across swaps, frees and marks", () => {
    // Native common.c dbe4ddb, non-HUNK_DEBUG, 512-byte initialized arena.
    // Captured by /tmp/q3-hunk-oracle-qTFpmD/oracle.c; offsets are relative to s_hunkData.
    const { arena, messages } = fixture();
    const rows: (number | string)[][] = [];
    function row(label: string, allocation: HunkAllocation | null = null): void {
      const s = arena.snapshot();
      rows.push([label, allocation === null ? -1 : allocation.byteOffset,
        s.low.mark, s.low.permanent, s.low.temp, s.low.tempHighwater,
        s.high.mark, s.high.permanent, s.high.temp, s.high.tempHighwater,
        s.permanentBank === "low" ? "L" : "H", arena.memoryRemaining()]);
    }
    row("clear"); row("high1", arena.allocate(1, "high"));
    const a = arena.allocateTemp(5); row("temp5", a);
    const b = arena.allocateTemp(9); row("temp9", b);
    arena.freeTemp(a); row("freeOlder"); arena.freeTemp(b); row("freeNewest");
    arena.clearTemp(); row("clearTemp"); row("dontcare33", arena.allocate(33, "dontcare"));
    arena.setMark(); row("mark"); const c = arena.allocateTemp(41); row("temp41", c);
    row("low17withTemp", arena.allocate(17, "low")); arena.freeTemp(c); row("free41");
    row("low2", arena.allocate(2, "low")); arena.clearToMark(); row("clearMark");
    row("high3", arena.allocate(3, "high"));
    expect(rows).toEqual([
      ["clear", -1, 0, 0, 0, 0, 0, 0, 0, 0, "L", 512],
      ["high1", 0, 0, 32, 32, 0, 0, 0, 0, 0, "L", 480],
      ["temp5", 40, 0, 32, 48, 48, 0, 0, 0, 0, "H", 464],
      ["temp9", 56, 0, 32, 68, 68, 0, 0, 0, 0, "H", 444],
      ["freeOlder", -1, 0, 32, 68, 68, 0, 0, 0, 0, "H", 444],
      ["freeNewest", -1, 0, 32, 48, 68, 0, 0, 0, 0, "H", 464],
      ["clearTemp", -1, 0, 32, 32, 68, 0, 0, 0, 0, "H", 480],
      ["dontcare33", 32, 0, 96, 96, 68, 0, 0, 0, 0, "L", 416],
      ["mark", -1, 96, 96, 96, 68, 0, 0, 0, 0, "L", 416],
      ["temp41", 104, 96, 96, 148, 148, 0, 0, 0, 0, "H", 364],
      ["low17withTemp", 480, 96, 96, 148, 148, 0, 32, 32, 0, "H", 332],
      ["free41", -1, 96, 96, 96, 148, 0, 32, 32, 0, "H", 384],
      ["low2", 96, 96, 128, 128, 148, 0, 32, 32, 0, "L", 352],
      ["clearMark", -1, 96, 96, 96, 148, 0, 0, 0, 0, "L", 416],
      ["high3", 96, 96, 128, 128, 148, 0, 0, 0, 0, "L", 384],
    ]);
    expect(messages).toEqual(["Hunk_FreeTempMemory: not the final block\n"]);
  });

  test("initial temp high-bank header bytes and four-byte padding are exact", () => {
    const { arena } = fixture(); const first = arena.allocateTemp(5);
    expect(first.byteOffset).toBe(504); expect(first.byteLength).toBe(5);
    expect(new Uint8Array(first.bytes.buffer, first.byteOffset - 8, 8)).toEqual(Uint8Array.of(0x92, 0x78, 0x53, 0x89, 16, 0, 0, 0));
    expect(arena.memoryRemaining()).toBe(496);
    arena.freeTemp(first);
    expect(new Uint8Array(arena.allocate(0, "low").bytes.buffer, 496, 4)).toEqual(Uint8Array.of(0x93, 0x78, 0x53, 0x89));
    expect(arena.memoryRemaining()).toBe(512);
    expect(arena.snapshot().high.tempHighwater).toBe(16);
  });
});

describe("actual hunk storage and lifetime", () => {
  test("touch memory reads permanent words at the source stride and retains the high-bank bound", () => {
    const { arena } = fixture();
    const low = arena.allocate(288, "low");
    const view = new DataView(low.bytes.buffer);
    view.setInt32(0, 0x7fffffff, true);
    view.setInt32(4, 123, true);
    view.setInt32(256, 1, true);
    arena.allocateTemp(64).bytes.fill(0x55);
    expect(arena.touchMemory()).toBe(-0x80000000);
    view.setInt32(256, 3, true);
    expect(arena.touchMemory()).toBe(-0x7ffffffe);
    for (const size of [128, 384]) {
      const highArena = fixture().arena;
      highArena.freeTemp(highArena.allocateTemp(8));
      const high = highArena.allocate(size, "high");
      expect(high.byteOffset).toBe(512 - size);
      const highView = new DataView(high.bytes.buffer);
      highView.setInt32(high.byteOffset, 7, true);
      highView.setInt32(384, 99, true);
      expect(highArena.touchMemory()).toBe(size === 384 ? 7 : 0);
    }
  });

  test("permanent allocations clear rounded padding while temporary reuse preserves old bytes", () => {
    const { arena } = fixture();
    const first = arena.allocateTemp(8); first.bytes.fill(0x5a);
    arena.clearTemp();
    const next = arena.allocate(1, "high");
    expect(next.byteOffset).toBe(480);
    expect(new Uint8Array(next.bytes.buffer, 480, 32)).toEqual(new Uint8Array(32));
    const anchor = arena.allocateTemp(8);
    const temp = arena.allocateTemp(8); temp.bytes.fill(0x42); arena.freeTemp(temp);
    const reused = arena.allocateTemp(8);
    expect(reused.byteOffset).toBe(temp.byteOffset); expect([...reused.bytes]).toEqual([66, 66, 66, 66, 66, 66, 66, 66]);
    expect(anchor.bytes.length).toBe(8);
    expect(() => first.bytes).toThrow("no longer valid"); expect(() => temp.bytes).toThrow("no longer valid");
  });

  test("foreign, permanent, double-free and expired handles fail without changing accounting", () => {
    const { arena } = fixture(); const other = fixture().arena;
    const permanent = arena.allocate(1, "low"), temporary = arena.allocateTemp(1), foreign = other.allocateTemp(1);
    const before = arena.snapshot();
    for (const invalid of [permanent, foreign]) expect(() => arena.freeTemp(invalid)).toThrow("invalid, foreign or expired");
    expect(arena.snapshot()).toEqual(before);
    arena.freeTemp(temporary); const after = arena.snapshot();
    expect(() => arena.freeTemp(temporary)).toThrow("invalid, foreign or expired"); expect(arena.snapshot()).toEqual(after);
    const expired = arena.allocateTemp(1); arena.clearTemp();
    expect(() => arena.freeTemp(expired)).toThrow("invalid, foreign or expired");
  });

  test("high-bank out-of-order free leaves a hole until clearTemp and never double-reclaims it", () => {
    const { arena, messages } = fixture(64);
    const older = arena.allocateTemp(5), newest = arena.allocateTemp(5);
    expect(older.byteOffset).toBe(56); expect(newest.byteOffset).toBe(40);
    arena.freeTemp(older); expect(arena.memoryRemaining()).toBe(32);
    arena.freeTemp(newest); expect(arena.memoryRemaining()).toBe(48);
    expect(arena.snapshot().high.tempHighwater).toBe(32);
    expect(() => arena.freeTemp(older)).toThrow("invalid, foreign or expired");
    arena.clearTemp(); expect(arena.memoryRemaining()).toBe(64);
    expect(messages).toEqual(["Hunk_FreeTempMemory: not the final block\n"]);
  });

  test("header corruption is diagnosed before freeing or trusting a corrupted size", () => {
    const { arena } = fixture(); const temp = arena.allocateTemp(7);
    const header = new DataView(temp.bytes.buffer); const before = arena.snapshot();
    header.setUint32(temp.byteOffset - 8, 0, true);
    expect(() => arena.freeTemp(temp)).toThrow("bad magic"); expect(arena.snapshot()).toEqual(before);
    header.setUint32(temp.byteOffset - 8, 0x89537892, true); header.setInt32(temp.byteOffset - 4, -1, true);
    expect(() => arena.freeTemp(temp)).toThrow("corrupt block size"); expect(arena.snapshot()).toEqual(before);
  });

  test("marks retain earlier allocations on both banks and highwater survives clearToMark", () => {
    const { arena } = fixture(); expect(arena.checkMark()).toBe(false);
    const low = arena.allocate(32, "low"); const scratch = arena.allocateTemp(80);
    const marked = arena.allocate(32, "dontcare"); arena.freeTemp(scratch); arena.setMark(); expect(arena.checkMark()).toBe(true);
    expect(arena.snapshot().low.mark).toBe(32); expect(arena.snapshot().high.mark).toBe(32);
    const later = arena.allocate(64, "dontcare"), temp = arena.allocateTemp(16);
    const before = arena.snapshot(); arena.clearToMark();
    expect(low.bytes.length).toBe(32); expect(marked.bytes.length).toBe(32);
    expect(() => later.bytes).toThrow("no longer valid"); expect(() => temp.bytes).toThrow("no longer valid");
    expect(arena.snapshot().low.tempHighwater).toBe(before.low.tempHighwater);
    expect(arena.snapshot().high.tempHighwater).toBe(before.high.tempHighwater);
    expect(arena.memoryRemaining()).toBe(448);
    const snapshot = arena.snapshot(); expect(snapshot.low).not.toBe(arena.snapshot().low);
  });

  test("capacity is real shared backing with independent arenas and exact exhaustion", () => {
    const { arena } = fixture(64), other = fixture(64);
    const permanent = arena.allocate(32, "low"), temp = arena.allocateTemp(24);
    expect(permanent.bytes.buffer).toBe(temp.bytes.buffer); expect(temp.bytes.buffer.byteLength).toBe(64);
    expect(other.arena.allocate(32, "low").bytes.buffer).not.toBe(permanent.bytes.buffer);
    expect(arena.memoryRemaining()).toBe(0);
    expect(() => arena.allocate(1, "dontcare")).toThrow("Hunk_Alloc failed");
    expect(() => arena.allocateTemp(1)).toThrow("Hunk_AllocateTempMemory: failed");
    arena.freeTemp(temp); expect(arena.memoryRemaining()).toBe(32);
    expect(arena.allocate(32, "dontcare").bytes.length).toBe(32); expect(arena.memoryRemaining()).toBe(0);
  });

  test("zero-byte allocations follow source rounding without inventing a minimum payload", () => {
    const { arena } = fixture(32);
    expect(arena.allocate(0, "low").bytes.length).toBe(0); expect(arena.memoryRemaining()).toBe(32);
    const temp = arena.allocateTemp(0); expect(temp.byteOffset).toBe(32); expect(temp.bytes.length).toBe(0);
    expect(arena.memoryRemaining()).toBe(24); arena.freeTemp(temp); expect(arena.memoryRemaining()).toBe(32);
  });

  test("negative, noninteger and overflowing sizes reject before allocation", () => {
    const { arena } = fixture(); const before = arena.snapshot();
    for (const size of [-1, 0.5, NaN, Infinity, 0x7fffffff, 0x80000000]) {
      expect(() => arena.allocate(size, "dontcare")).toThrow(RangeError);
      expect(() => arena.allocateTemp(size)).toThrow(RangeError);
    }
    expect(arena.snapshot()).toEqual(before);
    for (const capacity of [0, -32, 1, 33, 32.5, NaN, Infinity, 0x80000000]) expect(() => fixture(capacity)).toThrow(RangeError);
  });
});

describe("hunk initialization and source shutdown ordering", () => {
  test("client clear shuts down services before invalidating, then prints before VM clear", () => {
    const order: string[] = []; const arena = new HunkArena(64, text => { order.push(text); });
    const permanent = arena.allocate(1, "low"), temp = arena.allocateTemp(1); arena.setMark();
    arena.clear({ kind: "client",
      shutdownCGame: () => { expect(permanent.bytes.length).toBe(1); order.push("cgame"); arena.freeTemp(temp); },
      shutdownUi: () => { order.push("ui"); }, shutdownGameProgs: () => { order.push("game"); },
      closeAllVideos: () => { order.push("videos"); },
      clearVm: () => { expect(() => permanent.bytes).toThrow("no longer valid"); expect(arena.memoryRemaining()).toBe(64); order.push("vm"); },
    });
    expect(order).toEqual(["cgame", "ui", "game", "videos", "Hunk_Clear: reset the hunk ok\n", "vm"]);
    expect(arena.checkMark()).toBe(false); expect(arena.snapshot().permanentBank).toBe("low");
    expect(arena.snapshot().low.tempHighwater + arena.snapshot().high.tempHighwater).toBe(0);
  });

  test("failed shutdown preserves allocations; recursive clear explicitly rejects", () => {
    const { arena } = fixture(); const block = arena.allocate(1, "low");
    expect(() => arena.clear({ kind: "dedicated", shutdownGameProgs: () => { throw new Error("shutdown failed"); }, clearVm: () => { throw new Error("must not reach"); } })).toThrow("shutdown failed");
    expect(block.bytes.length).toBe(1);
    const order: string[] = [];
    arena.clear({ kind: "dedicated", shutdownGameProgs: () => { expect(() => arena.clear(dedicated(order))).toThrow("cannot reenter"); }, clearVm: () => { order.push("vm"); } });
    expect(order).toEqual(["vm"]);
  });

  test("async clear waits for the actual shutdown before invalidating storage", async () => {
    const order: string[] = [], release = Promise.withResolvers<void>();
    const arena = new HunkArena(64, text => { order.push(text); }), block = arena.allocate(32, "low");
    const clear = arena.clearAsync({ kind: "client",
      shutdownCGame: () => { order.push("cgame"); return release.promise; },
      shutdownUi: () => { expect(arena.ownsLiveAllocation(block)).toBe(true); order.push("ui"); },
      shutdownGameProgs: () => { order.push("game"); }, closeAllVideos: () => { order.push("videos"); },
      clearVm: () => { expect(arena.ownsLiveAllocation(block)).toBe(false); order.push("vm"); },
    });
    expect(order).toEqual(["cgame"]); expect(arena.memoryRemaining()).toBe(32);
    await expect(arena.clearAsync(dedicated([]))).rejects.toThrow("cannot reenter");
    release.resolve(); await clear;
    expect(order).toEqual(["cgame", "ui", "game", "videos", "Hunk_Clear: reset the hunk ok\n", "vm"]);
    expect(arena.memoryRemaining()).toBe(64);
  });

  test("async clear preserves source failures and runs synchronous callbacks without yielding", async () => {
    const order: string[] = [], arena = new HunkArena(64, text => { order.push(text); });
    const block = arena.allocate(32, "low"), failure = new Error("UI shutdown failed");
    await expect(arena.clearAsync({ kind: "client", shutdownCGame: () => { order.push("cgame"); },
      shutdownUi: () => Promise.reject(failure), shutdownGameProgs: () => { order.push("unreached game"); },
      closeAllVideos: () => { order.push("unreached videos"); }, clearVm: () => { order.push("unreached vm"); },
    })).rejects.toBe(failure);
    expect(order).toEqual(["cgame"]); expect(block.bytes.byteLength).toBe(32);
    const clear = arena.clearAsync(dedicated(order));
    expect(order).toEqual(["cgame", "game", "Hunk_Clear: reset the hunk ok\n", "vm"]);
    expect(arena.ownsLiveAllocation(block)).toBe(false);
    await clear;
  });

  test("renderer backend uses the common arena and reinitializes after the server mark", () => {
    const arena = new HunkArena(3 * 1048576, () => undefined), accounting = new SourceHunkAccounting(arena);
    const server = accounting.reserve("VM_Create:dataBase", "vm/qagame.qvm", 512, "high");
    server.bytes.fill(0x35); accounting.setMark();
    const remaining = arena.memoryRemaining(), limits = { maxPolys: 600, maxPolyVertices: 3000 };
    const backend = accounting.initializeRendererBackend(limits);
    accounting.defaultSkinRecord(); accounting.defaultSkinSurface(); accounting.defaultModelRecord();
    expect(backend.byteLength).toBe(1068268);
    expect(backend.bytes.buffer).toBe(server.bytes.buffer);
    expect(arena.memoryRemaining()).toBe(remaining - 1068288 - 384);
    const replacement = accounting.initializeRendererBackend(limits);
    accounting.defaultSkinRecord(); accounting.defaultSkinSurface(); accounting.defaultModelRecord();
    expect(replacement.byteOffset).not.toBe(backend.byteOffset);
    expect(backend.bytes.byteLength).toBe(1068268);
    expect(accounting.memoryRemaining()).toBe(remaining - 2 * (1068288 + 384));
    accounting.clearToMark();
    expect(arena.memoryRemaining()).toBe(remaining);
    expect(server.bytes).toEqual(new Uint8Array(512).fill(0x35));
    expect(() => backend.bytes).toThrow("no longer valid");
    expect(accounting.report().missingComponents).toContain("renderer backend initialization");
    expect(accounting.initializeRendererBackend(limits).byteLength).toBe(1068268);
    accounting.defaultSkinRecord(); accounting.defaultSkinSurface(); accounting.defaultModelRecord();
    expect(arena.memoryRemaining()).toBe(remaining - 1068288 - 384);
    expect(accounting.memoryRemaining()).toBe(arena.memoryRemaining());
    expect(accounting.report().budget).toBe("port-arena");
  });

  test("initialization enforces real client56/dedicated1 MiB floors and nonzero filesystem load stack", () => {
    const logs: string[] = [];
    const server = initializeHunk({ megs: 0, dedicated: true, filesystemLoadStack: 0 }, text => { logs.push(text); }, dedicated(logs));
    expect(server.memoryRemaining()).toBe(1048576);
    expect(logs).toEqual(["Minimum com_hunkMegs for a dedicated server is 1, allocating 1 megs.\n", "game", "Hunk_Clear: reset the hunk ok\n", "vm"]);
    const client = initializeHunk({ megs: -1, dedicated: false, filesystemLoadStack: 0 }, text => { logs.push(text); }, {
      kind: "client", shutdownCGame: () => { logs.push("cgame"); }, shutdownUi: () => { logs.push("ui"); },
      shutdownGameProgs: () => { logs.push("game"); }, closeAllVideos: () => { logs.push("videos"); }, clearVm: () => { logs.push("vm"); },
    });
    expect(client.memoryRemaining()).toBe(56 * 1048576); expect(logs).toContain("Minimum com_hunkMegs is 56, allocating 56 megs.\n");
    expect(() => initializeHunk({ megs: 1, dedicated: true, filesystemLoadStack: 1 }, text => { logs.push(text); }, dedicated(logs))).toThrow("load stack not zero");
    const clientBuildDedicated = initializeHunk({ megs: 0, dedicated: true, filesystemLoadStack: 0 }, text => { logs.push(text); }, {
      kind: "client", shutdownCGame: () => { logs.push("cgame"); }, shutdownUi: () => { logs.push("ui"); },
      shutdownGameProgs: () => { logs.push("game"); }, closeAllVideos: () => { logs.push("videos"); }, clearVm: () => { logs.push("vm"); },
    });
    expect(clientBuildDedicated.memoryRemaining()).toBe(1048576);
    expect(logs.slice(-6)).toEqual(["cgame", "ui", "game", "videos", "Hunk_Clear: reset the hunk ok\n", "vm"]);
  });

  test("real allocations cross the original four-million-byte deferred-player threshold", () => {
    const { arena } = fixture(4000032);
    arena.allocate(32, "low"); expect(arena.memoryRemaining() < 4000000).toBe(false);
    arena.allocate(1, "low"); expect(arena.memoryRemaining() < 4000000).toBe(true);
    arena.clear(dedicated([])); expect(arena.memoryRemaining()).toBe(4000032);
  });
});
