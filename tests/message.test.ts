import { describe, expect, test } from "bun:test";
import { MessageReader, MessageWriter, SourceMessageState, readDeltaUserCommand, writeDeltaUserCommand } from "../src/protocol/message.ts";
import type { WireUserCommand } from "../src/protocol/message.ts";

// Recorded by compiling untouched msg.c and huffman.c from reference dbe4ddb outside the project.
const ALL_SYMBOLS = "6e243b3402f2575a7a3169735895b0c0c7dfddfc2b8e4cafb155c65e6fe809f53d0d91668bcfbfe1e629b136030571c24b1fef34fc7e792ab641d803f1324736122fa2f33d43f984902840707a8e716ddc9d573d6e66969dacb5f674718d37e335cbc24575ace03aec793cab1f5f82053de5507a11c37cc4305bc8789497055e642c858fcebda111e52fc5ec3f0c061c9e9d5fd12d271ea849ccb1005fbf42516bf4b0723ee314b9520cebe74631bf9958e836b88ea3c319c6b845afd9cc324de108be47de8b617dfc4ca7a77040de3a0d7ccc46a806768189e30fc68dcf62110374545cd31d00c8bd9bc01acaa539ca7ba3ac71ac7a0fa67b7ca245ca04df11e29836f2648c078539224681c15e074fb100478f7a87002d00eb7c51cbb5d11709";

describe("Quake III messages", () => {
  test("source counters retain attempted bits across clears and copies, with explicit undefined arithmetic", () => {
    const prints: string[] = [], state = new SourceMessageState(text => { prints.push(text); });
    const writer = new MessageWriter("oob", 8, state);
    writer.writeByte(-1); writer.writeShort(65536); writer.writeLong(0);
    expect([state.oldsize, state.overflows]).toEqual([56, 2]);
    writer.writeBits(0, -16);
    expect([state.oldsize, state.overflows, writer.overflowed]).toEqual([40, 2, true]);
    writer.clear();
    const copy = writer.copy(); copy.writeBits(0, -16);
    expect(copy.sourceState).toBe(state);
    expect([state.oldsize, state.overflows]).toEqual([24, null]);
    state.oldsize = 0x7ffffff8; writer.writeByte(0);
    expect(state.oldsize).toBeNull();
    state.newsize = 0x7fffffff; state.addNewsize(1);
    expect(state.newsize).toBeNull();
    state.oldsize = 0;
    writeDeltaUserCommand(new MessageWriter("bitstream", 32, state), from, from, 0);
    expect(state.oldsize).toBe(17);
    expect(prints).toEqual([]);
  });

  test("overlong source string diagnostics precede the empty-string write", () => {
    const prints: string[] = [];
    const state = new SourceMessageState(text => { prints.push(text); expect(state.oldsize).toBe(prints.length === 1 ? 0 : 8); });
    const writer = new MessageWriter("oob", 16, state);
    writer.writeString("a".repeat(1024)); writer.writeBigString("b".repeat(8192));
    expect(prints).toEqual(["MSG_WriteString: MAX_STRING_CHARS", "MSG_WriteString: BIG_INFO_STRING"]);
    expect(writer.toBytes()).toEqual(Uint8Array.of(0, 0));
    writer.writeString("short\0" + "x".repeat(1024));
    expect(prints).toHaveLength(2);
  });

  test("mode changes retain the source cursors and copies own their storage", () => {
    const writer = new MessageWriter("oob", 32);
    writer.writeLong(0x12345678);
    writer.bitstream();
    expect([writer.mode, writer.bitPosition, writer.byteLength]).toEqual(["bitstream", 8, 4]);
    const copy = writer.copy();
    copy.writeByte(0);
    expect(copy.toBytes()).toEqual(Uint8Array.of(0x78, 2));
    expect(writer.toBytes()).toEqual(Uint8Array.of(0x78, 0x56, 0x34, 0x12));
    expect(copy.capacity).toBe(32);
    const reader = new MessageReader(Uint8Array.of(0xff, 0xaa, 0), "oob", "retained");
    expect(reader.readByte()).toBe(255);
    reader.bitstream();
    const fork = reader.copy();
    expect([fork.mode, fork.bitPosition, fork.readCount, fork.source]).toEqual(["bitstream", 8, 1, "retained"]);
    reader.data[1] = 0;
    expect(fork.readLong()).toBe(0);
    expect(reader.bitPosition).toBe(8);
    fork.beginReadingOob();
    expect([fork.bitPosition, fork.readCount, fork.mode]).toEqual([0, 0, "oob"]);
    expect(fork.readByte()).toBe(255);
    fork.beginReading();
    expect([fork.bitPosition, fork.readCount, fork.mode]).toEqual([0, 0, "bitstream"]);
  });

  test("scalar deltas retain change flags, signed values and the source keyed mask", () => {
    const writer = new MessageWriter();
    writer.writeDelta(17, 17, 8);
    writer.writeDelta(17, -32768, -16);
    writer.writeDeltaKey(0x100, 0, 0x7f, 8);
    writer.writeDeltaKey(0x80000000, 0, 1, 31);
    const reader = new MessageReader(writer.toBytes());
    expect(reader.readDelta(17, 8)).toBe(17);
    expect(reader.readDelta(17, -16)).toBe(-32768);
    expect(reader.readDeltaKey(0x100, 0, 8)).toBe(0x17f);
    expect(reader.readDeltaKey(0x80000000, 0, 31)).toBe(-2147483647);
    expect(reader.bitPosition).toBe(writer.bitPosition);
    const invalid = new MessageWriter();
    invalid.writeDeltaKey(0, 0, 1, 32);
    expect(() => new MessageReader(invalid.toBytes()).readDeltaKey(0, 0, 32)).toThrow("kbitmask");
    const zeroWidth = new MessageReader(Uint8Array.of(1));
    expect(zeroWidth.readDeltaKey(3, 0, 0)).toBe(1);
    expect([zeroWidth.bitPosition, zeroWidth.readCount]).toEqual([1, 1]);
  });

  test("float deltas compare binary32 values, preserve unchanged signed zero and decode raw bits", () => {
    const writer = new MessageWriter();
    writer.writeDeltaFloat(1, 1 + 2 ** -25);
    writer.writeDeltaFloat(-0, 0);
    writer.writeDeltaFloat(0, -1.5);
    writer.writeDeltaKeyFloat(0x12345678, 0, Infinity);
    writer.writeDeltaKeyFloat(0x12345678, NaN, NaN);
    const reader = new MessageReader(writer.toBytes());
    expect(reader.readDeltaFloat(1)).toBe(1);
    expect(reader.readDeltaFloat(-0)).toBe(-0);
    expect(reader.readDeltaFloat(0)).toBe(-1.5);
    expect(reader.readDeltaKeyFloat(0x12345678, 0)).toBe(Infinity);
    expect(reader.readDeltaKeyFloat(0x12345678, NaN)).toBeNaN();
    expect(reader.bitPosition).toBe(writer.bitPosition);
    // Seven low bits, a change bit, then four zero Huffman symbols end at bit 16.
    const boundary = new MessageReader(Uint8Array.of(0x80, 0xaa));
    boundary.readBits(7);
    expect(boundary.readDeltaFloat(0)).toBe(0);
    expect(boundary.readCount).toBe(3);
  });

  test("angle writers wrap source byte/short angles after float32 argument storage", () => {
    const writer = new MessageWriter("oob");
    for (const angle of [90, -90, 360, 359.999999]) { writer.writeAngle(angle); writer.writeAngle16(angle); }
    expect(writer.toBytes()).toEqual(Uint8Array.of(64, 0, 64, 192, 0, 192, 0, 0, 0, 0, 0, 0));
    for (const angle of [NaN, Infinity, -Infinity, 1e30]) {
      expect(() => writer.writeAngle(angle)).toThrow("float-to-int");
      expect(() => writer.writeAngle16(angle)).toThrow("float-to-int");
    }
  });

  test("MSG_Clear resets overflow and cursors while retaining mode and reusable storage", () => {
    for (const mode of ["bitstream", "oob"] satisfies readonly ("bitstream" | "oob")[]) {
      const writer = new MessageWriter(mode, 16);
      for (let index = 0; index < 40; index++) writer.writeByte(255);
      expect(writer.overflowed).toBe(true);
      writer.clear();
      expect([writer.byteLength, writer.bitPosition, writer.overflowed]).toEqual([0, 0, false]);
      expect(writer.mode).toBe(mode); expect(writer.capacity).toBe(16);
      writer.writeByte(0); writer.writeShort(73);
      const fresh = new MessageWriter(mode, 16); fresh.writeByte(0); fresh.writeShort(73);
      expect(writer.toBytes()).toEqual(fresh.toBytes());
    }
  });
  test("all 256 Huffman symbols match original bytes and bit count", () => {
    const writer = new MessageWriter();
    for (let i = 0; i < 256; i++) writer.writeByte(i);
    expect(writer.bitPosition).toBe(2308);
    expect(Buffer.from(writer.toBytes()).toString("hex")).toBe(ALL_SYMBOLS);
    const reader = new MessageReader(Buffer.from(ALL_SYMBOLS, "hex"));
    for (let i = 0; i < 256; i++) expect(reader.readByte()).toBe(i);
    expect(reader.bitPosition).toBe(2308);
  });

  test("mixed low bits, integers, float and string match source bytes", () => {
    const fixture = "95a48fdad27853f0956a3e46200f3158fe02";
    const writer = new MessageWriter();
    writer.writeBits(5, 3);
    writer.writeByte(0);
    writer.writeByte(255);
    writer.writeShort(-1234);
    writer.writeLong(0x12345678);
    writer.writeFloat(1.5);
    writer.writeString("quake%");
    expect(Buffer.from(writer.toBytes()).toString("hex")).toBe(fixture);
    expect(writer.bitPosition).toBe(138);
    const reader = new MessageReader(Buffer.from(fixture, "hex"));
    expect(reader.readBits(3)).toBe(5);
    expect(reader.readByte()).toBe(0);
    expect(reader.readByte()).toBe(255);
    expect(reader.readShort()).toBe(-1234);
    expect(reader.readLong()).toBe(0x12345678);
    expect(reader.readFloat()).toBe(1.5);
    expect(reader.readString()).toBe("quake.");
  });

  test("byte-aligned compressed messages retain their extra byte", () => {
    const writer = new MessageWriter();
    writer.writeData(Uint8Array.of(0, 0, 0, 0));
    expect(writer.toBytes()).toEqual(Uint8Array.of(0xaa, 0));
    expect(new MessageReader(writer.toBytes()).readData(4)).toEqual(Uint8Array.of(0, 0, 0, 0));
    expect(new MessageReader(Uint8Array.of(0xaa)).readData(4)).toEqual(Uint8Array.of(0, 0, 0, 255));
  });

  test("an in-bounds NYT prefix is a raw 256 and an unsigned byte zero", () => {
    const bytes = Uint8Array.of(0, 1);
    const bits = new MessageReader(bytes);
    expect(bits.readBits(8)).toBe(256);
    expect(bits.bitPosition).toBe(11);
    const scalar = new MessageReader(bytes);
    expect(scalar.readByte()).toBe(0);
    expect(scalar.bitPosition).toBe(11);
  });

  test("fully decoded bits retain their value while scalar reads expose source exhaustion", () => {
    // Each pair encodes the native zero Huffman symbol, so no read leaves this byte.
    const bits = new MessageReader(Uint8Array.of(0xaa));
    expect(bits.readBits(32)).toBe(0);
    expect([bits.bitPosition, bits.readCount]).toEqual([8, 2]);
    expect(() => bits.readBits(1)).toThrow("truncated");
    expect(new MessageReader(Uint8Array.of(0xaa)).readLong()).toBe(-1);
    expect(new MessageReader(Uint8Array.of(0xaa)).readFloat()).toBe(-1);
    const short = new MessageReader(Uint8Array.of(0xaa));
    expect(short.readShort()).toBe(0);
    expect(short.readShort()).toBe(-1);
    const char = new MessageReader(Uint8Array.of(0xaa));
    expect(char.readData(3)).toEqual(Uint8Array.of(0, 0, 0));
    expect(char.readChar()).toBe(-1);
  });

  test("strings stop at an in-bounds scalar sentinel and keep its consumed cursor", () => {
    const writer = new MessageWriter();
    for (let i = 0; i < 8; i++) writer.writeByte(65);
    expect(writer.bitPosition % 8).toBe(0);
    const bytes = writer.toBytes().subarray(0, writer.byteLength - 1);
    for (const read of ["readString", "readBigString", "readStringLine"] satisfies readonly ("readString" | "readBigString" | "readStringLine")[]) {
      const reader = new MessageReader(bytes);
      expect(reader[read]()).toBe("A".repeat(7));
      expect([reader.bitPosition, reader.readCount]).toEqual([bytes.length * 8, bytes.length + 1]);
    }
  });

  test("OOB integers and floats are little endian", () => {
    const writer = new MessageWriter("oob");
    writer.writeChar(-1);
    writer.writeShort(-1234);
    writer.writeLong(0x12345678);
    writer.writeFloat(1.5);
    expect(writer.toBytes()).toEqual(Uint8Array.of(255, 46, 251, 120, 86, 52, 18, 0, 0, 192, 63));
    expect(writer.bitPosition).toBe(40);
    const reader = new MessageReader(writer.toBytes(), "oob");
    expect(reader.readChar()).toBe(-1);
    expect(reader.readShort()).toBe(-1234);
    expect(reader.readLong()).toBe(0x12345678);
    expect(reader.readFloat()).toBe(1.5);
    expect(reader.bitPosition).toBe(88);
  });

  test("signed widths retain original byte and non-byte behavior", () => {
    for (const mode of ["oob", "bitstream"]) {
      if (mode !== "oob" && mode !== "bitstream") throw new Error("Invalid test mode");
      const writer = new MessageWriter(mode);
      writer.writeBits(-117, -8);
      writer.writeBits(-17000, -16);
      const reader = new MessageReader(writer.toBytes(), mode);
      expect(reader.readBits(-8)).toBe(-117);
      expect(reader.readBits(-16)).toBe(-17000);
    }
    const writer = new MessageWriter();
    writer.writeBits(-300, -13);
    expect(Buffer.from(writer.toBytes()).toString("hex")).toBe("b443");
    expect(new MessageReader(writer.toBytes()).readBits(-13)).toBe(-44);
  });

  test("strings preserve limits, percent replacement and high byte rules", () => {
    const writer = new MessageWriter("oob");
    writer.writeString("a\x80%\0ignored");
    writer.writeString("x".repeat(1024));
    writer.writeString(null);
    writer.writeBigString(null);
    expect(writer.toBytes()).toEqual(Uint8Array.of(97, 46, 37, 0, 0, 0, 0));
    const reader = new MessageReader(writer.toBytes(), "oob");
    expect(reader.readString()).toBe("a..");
    expect(reader.readString()).toBe("");
    expect(new MessageReader(Uint8Array.of(128, 37, 0), "oob").readString()).toBe("..");
    expect(new MessageReader(Uint8Array.of(128, 37, 0), "oob").readBigString()).toBe("\x80.");
    expect(new MessageReader(Uint8Array.of(97, 10, 98, 0), "oob").readStringLine()).toBe("a");
  });

  test("bounds and invalid widths fail explicitly; writer reports source reserve overflow", () => {
    const zeroWidth = new MessageReader(new Uint8Array());
    expect(zeroWidth.readBits(0)).toBe(0);
    expect([zeroWidth.bitPosition, zeroWidth.readCount]).toEqual([0, 1]);
    expect(() => new MessageReader(new Uint8Array(), "oob").readBits(0)).toThrow("width");
    expect(() => new MessageReader(new Uint8Array()).readByte()).toThrow();
    expect(() => new MessageReader(Uint8Array.of(1, 2, 3), "oob").readLong()).toThrow("truncated");
    expect(() => new MessageReader(Uint8Array.of(97), "oob").readString()).toThrow("truncated");
    for (const bits of [0, -32, 33, 1.5]) expect(() => new MessageWriter().writeBits(0, bits)).toThrow("width");
    expect(() => new MessageWriter("oob").writeBits(0, 3)).toThrow("OOB");
    const writer = new MessageWriter("oob", 4);
    writer.writeByte(1);
    writer.writeByte(2);
    expect(writer.overflowed).toBe(true);
    expect(writer.toBytes()).toEqual(Uint8Array.of(1));
    expect(() => writer.writeBits(0, 0)).not.toThrow();
    const copied = writer.copy();
    expect([copied.overflowed, copied.byteLength, copied.bitPosition, copied.capacity]).toEqual([true, 1, 8, 4]);
    expect(() => new MessageReader(new Uint8Array(16385))).toThrow("maximum");
  });
});

const from: WireUserCommand = { serverTime: 1000, angles: [0, 0, 0], forwardmove: 0, rightmove: 0, upmove: 0, buttons: 0, weapon: 0 };
const to: WireUserCommand = { serverTime: 1017, angles: [12345, 32768, 65535], forwardmove: -127, rightmove: 127, upmove: -1, buttons: 129, weapon: 7 };

describe("usercmd delta source fixtures", () => {
  test("unkeyed and keyed fixtures are exact", () => {
    const fixtures: readonly [number | null, string, number][] = [[null, "b18c77ea9724a7969353fe01", 89], [0x12345678, "b13c3d6c2a978871fb15d1b80600", 106]];
    for (const [key, hex, bits] of fixtures) {
      const writer = new MessageWriter();
      writeDeltaUserCommand(writer, from, to, key);
      expect(Buffer.from(writer.toBytes()).toString("hex")).toBe(hex);
      expect(writer.bitPosition).toBe(bits);
      expect(readDeltaUserCommand(new MessageReader(Buffer.from(hex, "hex")), from, key)).toEqual(to);
    }
  });

  test("key mask preserves original extra bit in int fields", () => {
    const writer = new MessageWriter();
    writeDeltaUserCommand(writer, from, to, 0x10000);
    expect(Buffer.from(writer.toBytes()).toString("hex")).toBe("b14c7539d6fd905c2f0d08b9c4fe02");
    expect(readDeltaUserCommand(new MessageReader(writer.toBytes()), from, 0x10000)).toEqual({ ...to, angles: [77881, 98304, 131071], buttons: 65665 });
  });

  test("unchanged fields, full timestamps and signed wrap", () => {
    for (const serverTime of [1000, 1255, 1256, 200000]) {
      const writer = new MessageWriter();
      writeDeltaUserCommand(writer, from, { ...from, serverTime }, 99);
      expect(readDeltaUserCommand(new MessageReader(writer.toBytes()), from, 99)).toEqual({ ...from, serverTime });
    }
    const writer = new MessageWriter();
    writeDeltaUserCommand(writer, from, { ...from, serverTime: 999 });
    expect(readDeltaUserCommand(new MessageReader(writer.toBytes()), from).serverTime).toBe(1255);
  });
});
