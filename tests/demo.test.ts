import { describe, expect, test } from "bun:test";
import { DemoReader, encodeDemo } from "../src/protocol/demo.ts";
import { decodeServerMessage } from "../src/protocol/server-message.ts";
import type { DemoMessage } from "../src/protocol/demo.ts";
import type { ServerMessageContext } from "../src/protocol/server-message.ts";

describe("protocol68 demo framing", () => {
  test("only a complete sequence word publishes, before partial length handling", () => {
    const header = new Uint8Array(8);
    new DataView(header.buffer).setInt32(0, -2147483648, true);
    for (let length = 0; length < 8; length++) {
      const reader = new DemoReader(header.slice(0, length));
      const sequences: number[] = [], offsets: number[] = [];
      const observe = (sequence: number): undefined => { sequences.push(sequence); offsets.push(reader.offset); };
      const end = reader.next(observe);
      expect(end).toEqual({ kind: "end", reason: length === 0 ? "eof" : "truncated-header", offset: 0 });
      expect(sequences).toEqual(length < 4 ? [] : [-2147483648]);
      expect(offsets).toEqual(length < 4 ? [] : [4]);
      expect(reader.offset).toBe(length);
      expect(reader.next(observe)).toEqual(end);
      expect(sequences).toHaveLength(length < 4 ? 0 : 1);
    }
  });

  test("sequence publication precedes the length read and propagates callback errors once", () => {
    const bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
    view.setInt32(0, -7, true); view.setInt32(4, 16385, true);
    const reader = new DemoReader(bytes), seen: number[] = [];
    expect(reader.next(sequence => { seen.push(sequence); view.setInt32(4, -1, true); return undefined; }))
      .toEqual({ kind: "end", reason: "terminator", offset: 0 });
    expect(seen).toEqual([-7]); expect(reader.offset).toBe(8);
    const interrupted = new DemoReader(bytes), failure = new Error("retired sequence owner");
    let calls = 0;
    expect(() => interrupted.next(() => { calls++; throw failure; })).toThrow(failure);
    expect(calls).toBe(1); expect(interrupted.offset).toBe(4);
  });

  test("sequence and length are little endian, terminator is two minus-one words", () => {
    const messages: [DemoMessage] = [{ kind: "message", sequence: 0x12345678, payload: Uint8Array.of(0xaa, 0xbb, 0xcc) }];
    // CL_WriteDemoMessage's sequence/length/payload followed by CL_StopRecord_f's -1/-1.
    const fixture = Buffer.from("7856341203000000aabbccffffffffffffffff", "hex");
    expect(Buffer.from(encodeDemo(messages))).toEqual(fixture);
    const reader = new DemoReader(fixture);
    expect(reader.next(() => undefined)).toEqual(messages[0]);
    expect(reader.next(() => undefined)).toEqual({ kind: "end", reason: "terminator", offset: 11 });
    expect(reader.next(() => undefined)).toEqual({ kind: "end", reason: "terminator", offset: 11 });
  });

  test("zero, signed sequence and maximum payload records retain owned bytes", () => {
    const messages: [DemoMessage, DemoMessage] = [{ kind: "message", sequence: -1, payload: new Uint8Array() }, { kind: "message", sequence: -2147483648, payload: new Uint8Array(16384).fill(42) }];
    const data = encodeDemo(messages);
    const reader = new DemoReader(data);
    expect(reader.next(() => undefined)).toEqual(messages[0]);
    const second = reader.next(() => undefined);
    data.fill(0);
    expect(second).toEqual(messages[1]);
    expect(() => encodeDemo([{ kind: "message", sequence: 0, payload: new Uint8Array(16385) }])).toThrow("MAX_MSGLEN");
  });

  test("clean physical EOF, partial headers and partial payloads have distinct completion reasons", () => {
    expect(new DemoReader(new Uint8Array()).next(() => undefined)).toEqual({ kind: "end", reason: "eof", offset: 0 });
    for (let i = 1; i < 8; i++) expect(new DemoReader(new Uint8Array(i)).next(() => undefined)).toEqual({ kind: "end", reason: "truncated-header", offset: 0 });
    const partial = new DemoReader(Buffer.from("0100000004000000aabb", "hex"));
    expect(partial.next(() => undefined)).toEqual({ kind: "end", reason: "truncated-payload", offset: 0 });
    expect(partial.next(() => undefined)).toEqual({ kind: "end", reason: "truncated-payload", offset: 0 });
    const noTerminator = new DemoReader(Buffer.from("0100000001000000aa", "hex"));
    expect(noTerminator.next(() => undefined)).toEqual({ kind: "message", sequence: 1, payload: Uint8Array.of(0xaa) });
    expect(noTerminator.next(() => undefined)).toEqual({ kind: "end", reason: "eof", offset: 9 });
  });

  test("only length minus-one terminates; malformed other lengths fail at their byte offset", () => {
    const oddSequence = new DemoReader(Buffer.from("05000000ffffffffaabbcc", "hex"));
    expect(oddSequence.next(() => undefined)).toEqual({ kind: "end", reason: "terminator", offset: 0 });
    for (const length of [-2, -2147483648, 16385]) {
      const data = new Uint8Array(8); new DataView(data.buffer).setInt32(4, length, true);
      expect(() => new DemoReader(data, "broken.dm_68").next(() => undefined)).toThrow("broken.dm_68:4");
    }
  });

  test("demo records feed an independently generated native gamestate payload into parser", () => {
    const payload = Buffer.from("6c15f9ab6c3d967781cdcde66519781ec18e014259ca028f60b2b7c7f22eb0f3604717b023944bc786df2f1bba3e01c0480000ff15a92e8d3705bf02", "hex");
    const file = encodeDemo([{ kind: "message", sequence: 9, payload }]);
    const reader = new DemoReader(file);
    const record = reader.next(() => undefined);
    if (record.kind !== "message") throw new Error("Missing demo message");
    const context: ServerMessageContext = { product: "baseq3", messageNumber: record.sequence, reliableSequence: 3, serverCommandSequence: 6, parseEntitiesNumber: 0, baseline: () => null, history: () => null };
    const result = decodeServerMessage(record.payload, context);
    const gamestate = result.operations[0];
    if (gamestate?.kind !== "gamestate") throw new Error("Missing gamestate");
    expect(gamestate.clientNumber).toBe(2);
    expect(gamestate.checksumFeed).toBe(0x12345678);
    expect(gamestate.entries.length).toBe(3);
    expect(reader.next(() => undefined)).toEqual({ kind: "end", reason: "terminator", offset: 68 });
  });
});
