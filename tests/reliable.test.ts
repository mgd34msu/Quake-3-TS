import { describe, expect, test } from "bun:test";
import { ClientReliableCommands, ReliableOverflowError, ServerReliableCommands } from "../src/protocol/reliable.ts";

describe("client reliable command ring", () => {
  test("starts empty and returns pending sequence-tagged commands", () => {
    const queue = new ClientReliableCommands();
    expect(queue.lookup(0)).toBe("");
    expect(queue.pending()).toEqual([]);
    expect(queue.add("first")).toEqual({ sequence: 1, text: "first" });
    queue.add("second");
    expect(queue.pending()).toEqual([{ sequence: 1, text: "first" }, { sequence: 2, text: "second" }]);
    expect(queue.acknowledgeThrough(1)).toEqual({ kind: "acknowledged", sequence: 1 });
    expect(queue.pending()).toEqual([{ sequence: 2, text: "second" }]);
    expect(queue.lookup(1)).toBe("first");
  });

  test("source permits65 outstanding and overwrites command1, then66 fails without increment", () => {
    const queue = new ClientReliableCommands();
    for (let i = 1; i <= 65; i++) queue.add(`command ${i}`);
    expect(queue.sequence).toBe(65);
    expect(queue.outstanding).toBe(65);
    expect(queue.lookup(1)).toBe("command 65");
    expect(queue.pending()[0]).toEqual({ sequence: 1, text: "command 65" });
    expect(() => queue.add("disconnect")).toThrow(ReliableOverflowError);
    expect(queue.sequence).toBe(65);
    expect(queue.lookup(65)).toBe("command 65");
    queue.acknowledgeThrough(1);
    expect(queue.add("now room").sequence).toBe(66);
  });

  test("stale server ack clamps to current sequence; exact64 boundary does not", () => {
    const queue = new ClientReliableCommands();
    for (let i = 0; i < 64; i++) queue.add("command");
    expect(queue.acknowledgeThrough(0)).toEqual({ kind: "acknowledged", sequence: 0 });
    queue.add("65");
    expect(queue.acknowledgeThrough(0)).toEqual({ kind: "clamped", sequence: 65 });
    expect(queue.outstanding).toBe(0);
    expect(queue.pending()).toEqual([]);
  });

  test("Q_strncpyz retains at most1023 characters and stops at NUL", () => {
    const queue = new ClientReliableCommands();
    expect(queue.add("hello\0ignored").text).toBe("hello");
    expect(queue.add("x".repeat(2000)).text.length).toBe(1023);
    expect(queue.add("").text).toBe("");
  });
});

describe("server reliable command ring", () => {
  test("pending configstring replacement scans only unsent rows and changes the first matching index", () => {
    const queue = new ServerReliableCommands();
    queue.add('cs 16 "sent"');
    queue.add('print "skip"');
    queue.add('cs 020 "first"');
    queue.add('cs 16 "second"');
    expect(queue.replacePending(1, 'cs +0x10 "new"')).toBe(true);
    expect(queue.lookup(1)).toBe('cs 16 "sent"');
    expect(queue.lookup(3)).toBe('cs +0x10 "new"');
    expect(queue.lookup(4)).toBe('cs 16 "second"');
    expect(queue.sequence).toBe(4);
    expect(queue.acknowledge).toBe(0);
    expect(queue.replacePending(4, 'cs 16 "late"')).toBe(false);
    expect(queue.replacePending(0, 'cs 17 "missing"')).toBe(false);
  });

  test("replacement retains source decimal octal signs, truncation and masked ring indexing", () => {
    const queue = new ServerReliableCommands();
    for (let index = 0; index < 64; index++) queue.add('cs-8 "old"');
    const replacement = 'cs -010 "' + "x".repeat(1200);
    expect(queue.replacePending(-2, replacement)).toBe(true);
    expect(queue.lookupMasked(-1)).toBe(replacement.slice(0, 1023));
    expect(queue.replacePending(63, 'cs-8 "nul"\0ignored')).toBe(true);
    expect(queue.lookup(64)).toBe('cs-8 "nul"');
    expect(queue.sequence).toBe(64);
  });

  test("failed scanf is explicit only when the source prefix comparison reaches it", () => {
    const queue = new ServerReliableCommands();
    queue.add('print "old"');
    expect(queue.replacePending(0, "cs invalid")).toBe(false);
    expect(() => queue.replacePending(0, 'print "new"')).toThrow("indeterminate sscanf");
    queue.add('cs 1 "old"');
    expect(() => queue.replacePending(1, "cs invalid")).toThrow("indeterminate sscanf");
    expect(() => queue.replacePending(1, "cs 2147483648")).toThrow("signed int32");
    expect(queue.lookup(2)).toBe('cs 1 "old"');
  });

  test("raw source lookup masks signed/future wire sequences before acknowledgement admission", () => {
    const queue = new ServerReliableCommands();
    expect(queue.lookupMasked(-1)).toBe(""); expect(queue.lookupMasked(0x7fffffff)).toBe("");
    for (let i = 1; i <= 64; i++) queue.add(`slot${i & 63}`);
    expect(queue.lookupMasked(-1)).toBe("slot63"); expect(queue.lookupMasked(-64)).toBe("slot0");
    expect(queue.lookupMasked(-0x80000000)).toBe("slot0"); expect(queue.lookupMasked(0x7fffffff)).toBe("slot63");
    expect(queue.lookupMasked(129)).toBe("slot1");
    expect(() => queue.lookup(-1)).toThrow("nonnegative"); expect(() => queue.lookup(129)).toThrow("ahead");
    expect(queue.sequence).toBe(64); expect(queue.acknowledge).toBe(0);
    for (const value of [0.5, NaN, Infinity, 0x80000000, -0x80000001]) expect(() => queue.lookupMasked(value)).toThrow("signed int32");
  });

  test("source acknowledgement assignment precedes admission and leaves strict convenience checks intact", () => {
    const queue = new ServerReliableCommands(); queue.add("first");
    queue.assignAcknowledgement(-7); expect(queue.acknowledge).toBe(-7);
    queue.assignAcknowledgement(100); expect(queue.acknowledge).toBe(100); expect(queue.pending()).toEqual([]);
    queue.assignAcknowledgement(0); queue.add("drop command"); queue.assignAcknowledgement(queue.sequence);
    expect(queue.acknowledge).toBe(2); expect(queue.lookupMasked(2)).toBe("drop command");
    expect(() => queue.acknowledgeThrough(-1)).toThrow("nonnegative"); expect(() => queue.acknowledgeThrough(3)).toThrow("ahead");
    for (const value of [0.5, NaN, Infinity, 0x80000000, -0x80000001]) expect(() => queue.assignAcknowledgement(value)).toThrow("signed int32");
  });

  test("source pending loop retains signed sequences and masks slots after raw acknowledgement admission", () => {
    const queue = new ServerReliableCommands(); queue.add("first");
    queue.assignAcknowledgement(-2);
    expect(queue.pending()).toEqual([
      { sequence: -1, text: "" }, { sequence: 0, text: "" }, { sequence: 1, text: "first" },
    ]);
    expect(() => queue.lookup(-1)).toThrow("nonnegative");
    expect(() => queue.acknowledgeThrough(-2)).toThrow("nonnegative");
    queue.assignAcknowledgement(2); expect(queue.pending()).toEqual([]);
  });

  test("source exact64 pending boundary at sequence0 emits signed commands -63 through0", () => {
    const queue = new ServerReliableCommands(); queue.assignAcknowledgement(-64);
    expect(queue.outstanding).toBe(64);
    const commands = queue.pending();
    expect(commands).toHaveLength(64);
    for (let index = 0; index < 64; index++) expect(commands[index]).toEqual({ sequence: index - 63, text: "" });
    queue.assignAcknowledgement(0x7fffffff); expect(queue.pending()).toEqual([]);
  });

  test("command65 reports overflow after increment without overwriting its slot", () => {
    const queue = new ServerReliableCommands();
    for (let i = 1; i <= 64; i++) expect(queue.add(`command ${i}`).kind).toBe("queued");
    expect(queue.add("lost command65")).toEqual({ kind: "overflow", sequence: 65, acknowledge: 0 });
    expect(queue.sequence).toBe(65);
    expect(queue.lookup(65)).toBe("command 1");
    expect(queue.lookup(1)).toBe("command 1");
    expect(queue.add("disconnect overflow")).toEqual({ kind: "queued", command: { sequence: 66, text: "disconnect overflow" } });
    expect(queue.lookup(2)).toBe("disconnect overflow");
  });

  test("source recursion guard depends on outstanding count, not command text", () => {
    const queue = new ServerReliableCommands();
    for (let i = 0; i < 64; i++) queue.add("ordinary");
    expect(queue.add("disconnect").kind).toBe("overflow");
    expect(queue.add("ordinary broadcast").kind).toBe("queued");
    expect(queue.sequence).toBe(66);
    expect(queue.acknowledgeThrough(0)).toEqual({ kind: "rejected-stale", sequence: 66 });
    expect(queue.pending()).toEqual([]);
  });

  test("acknowledgements may move backwards but future/negative values leave state untouched", () => {
    for (const queue of [new ClientReliableCommands(), new ServerReliableCommands()]) {
      for (let i = 1; i <= 5; i++) queue.add(`c${i}`);
      queue.acknowledgeThrough(5);
      expect(queue.acknowledgeThrough(3)).toEqual({ kind: "acknowledged", sequence: 3 });
      expect(queue.pending()).toEqual([{ sequence: 4, text: "c4" }, { sequence: 5, text: "c5" }]);
      for (const bad of [-1, 6, 1.5, NaN]) expect(() => queue.acknowledgeThrough(bad)).toThrow(RangeError);
      expect(queue.acknowledge).toBe(3);
      expect(() => queue.lookup(6)).toThrow("ahead");
      expect(() => queue.lookup(-1)).toThrow("nonnegative");
    }
  });

  test("ring ownership is per endpoint and pending arrays can be discarded independently", () => {
    const first = new ServerReliableCommands(); const second = new ServerReliableCommands();
    first.add("one"); second.add("two");
    const pending = first.pending(); pending.length = 0;
    expect(first.pending()).toEqual([{ sequence: 1, text: "one" }]);
    expect(second.lookup(1)).toBe("two");
  });
});
