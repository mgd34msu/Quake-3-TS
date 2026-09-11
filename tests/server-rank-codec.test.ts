import { expect, test } from "bun:test";
import { rankAsciiDecode, rankAsciiEncode, rankDecodePlayerId, rankEncodeGameId } from "../src/server/rank-codec.ts";

const discardDebug = (_text: string): void => {};

test("ranking alphabet and unpadded encoding tails use the original six-bit mapping", () => {
  const fixtures: readonly [readonly number[], string][] = [
    [[], ""], [[0], "00"], [[255], "]M"], [[255, 255], "]]Y"],
    [[255, 255, 255], "]]]]"], [[0, 1, 2], "0042"],
    [[0, 1, 2, 3], "00420M"], [[0, 1, 2, 3, 4], "00420Mg"],
    [[0, 1, 2, 3, 4, 5], "00420Mg5"], [[251, 239, 190], "[[[["],
  ];
  for (const [bytes, text] of fixtures) {
    const encoded = new Uint8Array(text.length + 2).fill(0xaa);
    expect(rankAsciiEncode(encoded, Uint8Array.from(bytes))).toBe(text.length);
    expect([...encoded]).toEqual([...text].map(value => value.charCodeAt(0)).concat([0, 0xaa]));
    const decoded = new Uint8Array(bytes.length + 1).fill(0xaa);
    expect(rankAsciiDecode(decoded, text)).toBe(bytes.length);
    expect([...decoded]).toEqual([...bytes, 0xaa]);
  }
});

test("every alphabet position decodes and encodes independently", () => {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ[]";
  for (let value = 0; value < alphabet.length; value++) {
    const output = new Uint8Array(3);
    rankAsciiEncode(output, Uint8Array.of(value << 2));
    expect([...output]).toEqual([alphabet.charCodeAt(value), 48, 0]);
    const decoded = new Uint8Array(1);
    expect(rankAsciiDecode(decoded, alphabet.charAt(value) + "0")).toBe(1);
    expect(decoded[0]).toBe(value << 2);
  }
});

test("decoder accepts source noncanonical tails and ignores a valid one-character tail", () => {
  const output = new Uint8Array(5).fill(0xaa);
  expect(rankAsciiDecode(output, "0")).toBe(0);
  expect([...output]).toEqual([0xaa, 0xaa, 0xaa, 0xaa, 0xaa]);
  expect(rankAsciiDecode(output, "]]")).toBe(1);
  expect(output[0]).toBe(255);
  expect(rankAsciiDecode(output, "]]]")).toBe(2);
  expect(output[1]).toBe(255);
  expect(rankAsciiDecode(output, "0042]")).toBe(3);
  expect([...output]).toEqual([0, 1, 2, 0xaa, 0xaa]);
});

test("invalid groups return zero with previous writes and unwritten suffix intact", () => {
  for (const invalid of ["=", "+", "/", " ", "\0", "\x7f"]) {
    for (let position = 0; position < 4; position++) {
      const output = new Uint8Array(7).fill(0xaa);
      expect(rankAsciiDecode(output, "0042" + "0".repeat(position) + invalid + "0".repeat(3 - position))).toBe(0);
      expect([...output]).toEqual([0, 1, 2, 0xaa, 0xaa, 0xaa, 0xaa]);
    }
  }
  const output = new Uint8Array(3).fill(0xaa);
  expect(rankAsciiDecode(output, "0042!")).toBe(0);
  expect([...output]).toEqual([0, 1, 2]);
});

test("signed-char and non-byte boundaries reject only when source decoding reaches them", () => {
  for (const unsafe of ["\x80", "\xff", "\u0100", "\ud800"]) {
    for (let position = 0; position < 4; position++) {
      const output = new Uint8Array(7).fill(0xaa);
      expect(() => rankAsciiDecode(output, "0042" + "0".repeat(position) + unsafe + "0".repeat(3 - position))).toThrow(RangeError);
      expect([...output]).toEqual([0, 1, 2, 0xaa, 0xaa, 0xaa, 0xaa]);
    }
    const output = new Uint8Array(7).fill(0xaa);
    expect(rankAsciiDecode(output, "0042!" + unsafe + "00")).toBe(0);
    expect([...output]).toEqual([0, 1, 2, 0xaa, 0xaa, 0xaa, 0xaa]);
    expect(() => rankAsciiDecode(output, "0042" + unsafe + "!00")).toThrow(RangeError);
    expect([...output]).toEqual([0, 1, 2, 0xaa, 0xaa, 0xaa, 0xaa]);
    expect(rankDecodePlayerId("00420Mg51ws8!" + unsafe + "00", discardDebug)).toBe(0x0706050403020100n);
    expect(() => rankDecodePlayerId("00420Mg51ws8" + unsafe + "!00", discardDebug)).toThrow(RangeError);
    expect(rankDecodePlayerId("00420Mg51ws\0" + unsafe, discardDebug)).toBe(0x0706050403020100n);
  }
});

test("bounds reject at the reached write and honor byte view offsets", () => {
  const backing = new Uint8Array(8).fill(0xaa);
  const output = backing.subarray(2, 6);
  expect(() => rankAsciiEncode(output, Uint8Array.of(0, 1, 2))).toThrow(RangeError);
  expect([...backing]).toEqual([0xaa, 0xaa, 48, 48, 52, 50, 0xaa, 0xaa]);
  expect(() => rankAsciiDecode(output, "00420Mg5")).toThrow(RangeError);
  expect([...backing]).toEqual([0xaa, 0xaa, 0, 1, 2, 3, 0xaa, 0xaa]);
  const encoded = new Uint8Array(5);
  expect(rankAsciiEncode(encoded, Uint8Array.of(99, 0, 1, 2, 99).subarray(1, 4))).toBe(4);
  expect([...encoded]).toEqual([48, 48, 52, 50, 0]);
  expect(() => rankAsciiEncode(new Uint8Array(0), new Uint8Array(0))).toThrow(RangeError);
  expect(rankAsciiDecode(new Uint8Array(0), "0")).toBe(0);
});

test("game IDs encode all eight bytes in LittleLong64 order with NUL termination", () => {
  const fixtures: readonly [bigint, string][] = [
    [0n, "00000000000"], [1n, "0g000000000"],
    [0x0706050403020100n, "00420Mg51ws"], [0xffffffffffffffffn, "]]]]]]]]]]Y"],
  ];
  for (const [id, text] of fixtures) {
    const output = new Uint8Array(14).fill(0xaa);
    rankEncodeGameId(id, output.subarray(1, 13), discardDebug);
    expect([...output]).toEqual([0xaa, ...[...text].map(value => value.charCodeAt(0)), 0, 0xaa]);
    expect(rankDecodePlayerId(text, discardDebug)).toBe(id);
  }
  expect(() => rankEncodeGameId(-1n, new Uint8Array(12), discardDebug)).toThrow(RangeError);
  expect(() => rankEncodeGameId(1n << 64n, new Uint8Array(12), discardDebug)).toThrow(RangeError);
});

test("short game ID destinations get only their first byte cleared", () => {
  for (let length = 1; length < 12; length++) {
    const output = new Uint8Array(length).fill(0xaa);
    rankEncodeGameId(1n, output, text => {
      expect(text).toBe("SV_RankEncodeGameID: result buffer too small\n");
      expect(output[0]).toBe(0xaa);
    });
    expect([...output]).toEqual([0, ...new Array<number>(length - 1).fill(0xaa)]);
  }
  expect(() => rankEncodeGameId(1n, new Uint8Array(0), discardDebug)).toThrow(RangeError);
});

test("player IDs honor strlen and the nine-byte scratch without inventing uninitialized bytes", () => {
  expect(rankDecodePlayerId("00420Mg51ws\0ignored!", text => {
    expect(text).toBe("SV_RankDecodePlayerID: string length 11\n");
  })).toBe(0x0706050403020100n);
  for (const text of ["00420Mg51ws8", "00420Mg51ws80", "00420Mg51ws8!", "00420Mg51ws800!0"]) {
    expect(rankDecodePlayerId(text, discardDebug)).toBe(0x0706050403020100n);
  }
  for (const text of ["", "0", "0000000000", "00420Mg51w!", "0042!", "00420Mg51ws800"]) {
    expect(() => rankDecodePlayerId(text, discardDebug)).toThrow(RangeError);
  }
});
