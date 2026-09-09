import { describe, expect, test } from "bun:test";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { CommonEvents, MAX_COMMON_PUSHED_EVENTS } from "../src/engine/common-events.ts";
import type { CommonEventSource, CommonSystemEvent } from "../src/engine/common-events.ts";
import { DedicatedEventSource } from "../src/platform/dedicated-input.ts";
import { MAX_UNIX_SYSTEM_EVENTS, UnixIo } from "../src/platform/unix-io.ts";
import { ZoneArena } from "../src/core/zone.ts";
import { CommonError } from "../src/core/common-error.ts";
import { CommonEventMemory } from "../src/engine/event-memory.ts";

describe("source common pushed events and clocks", () => {
  test("shared event payloads use actual zone bytes and retain one pointer through value copies", () => {
    const zone = new ZoneArena(512);
    let zoneReads = 0;
    const memory = new CommonEventMemory(() => { zoneReads++; return zone; });
    expect(zoneReads).toBe(0);
    try {
      const console = memory.console(1, "echo"), copy = memory.copy(console, 7);
      const packet = memory.packet(2, { kind: "ipv4", host: [127, 0, 0, 1], port: 27960 }, Uint8Array.of(3, 4, 5));
      const text = memory.payload(console), bytes = memory.payload(packet);
      if (text === null || bytes === null) throw new Error("Event payload did not enter the source zone");
      expect(zoneReads).toBe(2); expect(zone.memoryRemaining()).toBe(512 - 32 - 48);
      expect(text).toEqual(Uint8Array.of(101, 99, 104, 111, 0));
      expect(bytes).toEqual(Uint8Array.of(4, 0, 0, 0, 127, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 109, 56, 3, 4, 5));
      expect(text.buffer).toBe(bytes.buffer); expect(memory.payload(copy)).toBe(text);
      text[0] = 110; bytes[7] = 9; bytes[19] = 57; bytes[20] = 8;
      expect(copy).toEqual({ kind: "console", time: 7, text: "ncho" });
      expect(packet.from).toEqual({ kind: "ipv4", host: [127, 0, 0, 9], port: 27961 });
      expect(packet.payload).toEqual(Uint8Array.of(8, 4, 5));
      memory.free(copy); expect(zone.memoryRemaining()).toBe(512 - 48);
      expect(() => console.text).toThrow("no longer valid");
      expect(() => memory.free(console)).toThrow("freed a freed pointer");
      memory.free(packet); expect(zone.memoryRemaining()).toBe(512); zone.checkHeap();
    } finally { zone.dispose(); }
  });

  test("pushed overflow frees the old zone block after warning without reallocating retained events", () => {
    const zone = new ZoneArena(65536), memory = new CommonEventMemory(() => zone), queued: CommonSystemEvent[] = [];
    const first = memory.console(1, "old"); queued.push(first);
    for (let index = 1; index < MAX_COMMON_PUSHED_EVENTS; index++) queued.push(memory.console(1, "new"));
    const common = new CommonEvents({ getEvent: () => queued.shift() ?? { kind: "none", time: 2 } }, () => {
      expect(first.text).toBe("old"); expect(zone.memoryRemaining()).toBe(65536 - 28 * (MAX_COMMON_PUSHED_EVENTS + 1));
    }, memory);
    try {
      common.milliseconds(); expect(zone.memoryRemaining()).toBe(65536 - 28 * MAX_COMMON_PUSHED_EVENTS);
      queued.push(memory.console(1, "end")); common.milliseconds();
      expect(() => first.text).toThrow("no longer valid");
      expect(zone.memoryRemaining()).toBe(65536 - 28 * MAX_COMMON_PUSHED_EVENTS);
      for (let event = common.getEvent(); event.kind !== "none"; event = common.getEvent()) memory.free(event);
      expect(zone.memoryRemaining()).toBe(65536); zone.checkHeap();
    } finally { zone.dispose(); }
  });

  test("an aborted pushed-overflow warning retains both old and newly acquired zone allocations", () => {
    const zone = new ZoneArena(65536), memory = new CommonEventMemory(() => zone), queued: CommonSystemEvent[] = [];
    const first = memory.console(1, "old"), failure = new CommonError("drop", "pushed warning aborted");
    queued.push(first);
    for (let index = 1; index < MAX_COMMON_PUSHED_EVENTS; index++) queued.push(memory.console(1, "old"));
    const common = new CommonEvents({ getEvent: () => queued.shift() ?? { kind: "none", time: 2 } }, () => { throw failure; }, memory);
    try {
      common.milliseconds(); const abandoned = memory.console(1, "new"); queued.push(abandoned);
      expect(() => common.milliseconds()).toThrow(failure);
      expect(first.text).toBe("old"); expect(abandoned.text).toBe("new");
      expect(zone.memoryRemaining()).toBe(65536 - 28 * (MAX_COMMON_PUSHED_EVENTS + 1));
      for (let event = common.getEvent(); event.kind !== "none"; event = common.getEvent()) memory.free(event);
      expect(zone.memoryRemaining()).toBe(65536 - 28);
    } finally { zone.dispose(); }
  });

  test("pushing journal payloads copies their pointers before any console decoding", () => {
    const zone = new ZoneArena(512), memory = new CommonEventMemory(() => zone), header = new DataView(new ArrayBuffer(32));
    header.setInt32(4, 5, true);
    const pointer = memory.allocatePayload(2); pointer.block.bytes.fill(101);
    const unterminated = memory.journalEvent(header, pointer), missing = memory.journalEvent(header, null);
    const queued = [unterminated, missing], common = new CommonEvents({ getEvent: () => queued.shift() ?? { kind: "none", time: 3 } }, () => undefined, memory);
    try {
      expect(common.milliseconds()).toBe(3);
      const first = common.getEvent(), second = common.getEvent();
      if (first.kind !== "console" || second.kind !== "console") throw new Error("Missing journal console event");
      expect(() => first.text).toThrow("no terminating NUL"); expect(() => second.text).toThrow("no payload pointer");
      memory.free(first); memory.free(second); expect(zone.memoryRemaining()).toBe(512);
    } finally { zone.dispose(); }
  });

  test("the common owner retains client key, character, mouse and joystick events without dispatching them", () => {
    const queued: CommonSystemEvent[] = [
      { kind: "key", time: 1, key: 13, down: true }, { kind: "character", time: 2, character: 97 },
      { kind: "mouse", time: 3, dx: -2, dy: 4 }, { kind: "joystick", time: 4, axis: 1, value: -127 },
    ];
    const source: CommonEventSource = { getEvent: () => queued.shift() ?? { kind: "none", time: 5 } };
    const common = new CommonEvents(source, () => undefined);
    expect(common.milliseconds()).toBe(5);
    expect(common.getEvent()).toEqual({ kind: "key", time: 1, key: 13, down: true });
    expect(common.getEvent()).toEqual({ kind: "character", time: 2, character: 97 });
    expect(common.getEvent()).toEqual({ kind: "mouse", time: 3, dx: -2, dy: 4 });
    expect(common.getEvent()).toEqual({ kind: "joystick", time: 4, axis: 1, value: -127 });
  });

  test("milliseconds retains system input without dispatching or replacing comFrameTime", () => {
    let wall = 1234567;
    const input = new UnixIo(() => undefined, new UnixSystemClock(() => wall), { signals: "none" });
    const common = new CommonEvents(new DedicatedEventSource(input), () => undefined), bytes = new Uint8Array([1, 2, 3]);
    try {
      common.captureFrameTime(100);
      input.queueEvent({ kind: "console", time: 17, text: "echo first" });
      input.queueEvent({ kind: "packet", time: 18, from: { kind: "ipv4", host: [127, 0, 0, 1], port: 27960 }, payload: bytes });
      bytes.fill(9);
      expect(common.milliseconds()).toBe(567);
      expect(common.comFrameTime).toBe(100);
      input.queueEvent({ kind: "console", time: 19, text: "echo newer" });
      wall += 41;
      expect(common.milliseconds()).toBe(608);
      expect(common.getEvent()).toEqual({ kind: "console", time: 17, text: "echo first" });
      const packet = common.getEvent();
      expect(packet.kind).toBe("packet");
      if (packet.kind !== "packet") throw new Error("Missing retained packet");
      expect(packet.payload).toEqual(new Uint8Array([1, 2, 3]));
      expect(common.getEvent()).toEqual({ kind: "console", time: 19, text: "echo newer" });
      expect(common.getEvent()).toEqual({ kind: "none", time: 608 });
      expect(common.comFrameTime).toBe(100);
    } finally { input.close(); }
  });

  test("the independent 1024 ring drops oldest and warns once until a nonoverflow push", () => {
    const printed: string[] = [];
    const input = new UnixIo(text => { printed.push(`system:${text}`); }, new UnixSystemClock(() => 1234567), { signals: "none" });
    const common = new CommonEvents(new DedicatedEventSource(input), text => { printed.push(text); });
    try {
      for (let index = 0; index < MAX_COMMON_PUSHED_EVENTS + 2; index++) {
        input.queueEvent({ kind: "console", time: 1, text: String(index) });
        if ((index + 1) % MAX_UNIX_SYSTEM_EVENTS === 0) common.milliseconds();
      }
      common.milliseconds();
      expect(printed).toEqual(["WARNING: Com_PushEvent overflow\n"]);
      expect(common.getEvent()).toEqual({ kind: "console", time: 1, text: "2" });
      input.queueEvent({ kind: "console", time: 1, text: "accepted" }); common.milliseconds();
      input.queueEvent({ kind: "console", time: 1, text: "overflow again" }); common.milliseconds();
      expect(printed).toEqual(["WARNING: Com_PushEvent overflow\n", "WARNING: Com_PushEvent overflow\n"]);
      const retained: string[] = [];
      for (let event = common.getEvent(); event.kind !== "none"; event = common.getEvent()) {
        if (event.kind !== "console") throw new Error("Unexpected packet");
        retained.push(event.text);
      }
      expect(retained.length).toBe(MAX_COMMON_PUSHED_EVENTS);
      expect(retained[0]).toBe("4");
      expect(retained.slice(-2)).toEqual(["accepted", "overflow again"]);
    } finally { input.close(); }
  });

  test("independent common clocks preserve signed backward/wrapped input values and reject invalid frame capture", () => {
    let wall = 1000999;
    const input = new UnixIo(() => undefined, new UnixSystemClock(() => wall), { signals: "none" });
    const second = new UnixIo(() => undefined, new UnixSystemClock(() => 1234001), { signals: "none" });
    const common = new CommonEvents(new DedicatedEventSource(input), () => undefined);
    const other = new CommonEvents(new DedicatedEventSource(second), () => undefined);
    try {
      expect(common.milliseconds()).toBe(999); expect(other.milliseconds()).toBe(1);
      wall -= 1000; expect(common.milliseconds()).toBe(-1);
      wall = 1000000 + 2147483648; expect(common.milliseconds()).toBe(-2147483648);
      common.captureFrameTime(-2147483648); expect(common.comFrameTime).toBe(-2147483648);
      expect(other.comFrameTime).toBe(0);
      expect(() => common.captureFrameTime(2147483648)).toThrow("signed-int");
      expect(() => common.captureFrameTime(NaN)).toThrow("signed-int");
      expect(() => common.captureFrameTime(1.2)).toThrow("signed-int");
    } finally { input.close(); second.close(); }
  });
});
