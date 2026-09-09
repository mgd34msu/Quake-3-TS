import { describe, expect, test } from "bun:test";
import { compressAdaptive, createMessageHuffman, decompressAdaptive, HuffmanTree } from "../src/protocol/huffman.ts";

describe("Quake III Huffman", () => {
  test("trained codes match untouched upstream huffman.c/msg.c at dbe4ddb", () => {
    const fixtures: readonly [number, string][] = [[0, "01"], [1, "11011"], [65, "0000101"], [97, "00111100"], [208, "000000000"], [247, "00000000101"], [255, "001001"]];
    for (const [symbol, expected] of fixtures) {
      const bits: number[] = [];
      createMessageHuffman().encodeSymbol(symbol, (bit) => { bits.push(bit); });
      expect(bits.join("")).toBe(expected);
    }
  });

  test("the frozen message tree returns its NYT prefix without adaptive literal reads", () => {
    const bits = "00000000100";
    let position = 0;
    expect(createMessageHuffman().decodeSymbol(() => {
      const bit = bits[position++];
      if (bit === undefined) throw new Error("Read beyond NYT prefix");
      return Number(bit);
    })).toBe(256);
    expect(position).toBe(11);
  });

  test("adaptive packet matches source-reference abracadabra fixture", () => {
    const original = new TextEncoder().encode("abracadabra");
    const fixture = Buffer.from("000b868c701263636203", "hex");
    expect(Buffer.from(compressAdaptive(original))).toEqual(fixture);
    expect(decompressAdaptive(fixture)).toEqual(original);
  });

  test("first unseen byte is sent MSB first, then its leaf updates", () => {
    const tree = new HuffmanTree();
    const first: number[] = [];
    tree.encodeSymbol(65, (bit) => { first.push(bit); });
    expect(first.join("")).toBe("01000001");
    tree.addReference(65);
    const second: number[] = [];
    tree.encodeSymbol(65, (bit) => { second.push(bit); });
    expect(second).toEqual([1]);
  });

  test("adaptive trees remain independent and handle every byte", () => {
    const data = Uint8Array.from({ length: 1024 }, (_, i) => i & 255);
    const a = compressAdaptive(data);
    compressAdaptive(new TextEncoder().encode("other connection"));
    expect(compressAdaptive(data)).toEqual(a);
    expect(decompressAdaptive(a)).toEqual(data);
    expect(compressAdaptive(new Uint8Array())).toEqual(new Uint8Array());
    expect(decompressAdaptive(new Uint8Array())).toEqual(new Uint8Array());
  });

  test("declared output clamps to capacity before decoding the retained prefix", () => {
    const fixture = Buffer.from("000b868c701263636203", "hex");
    expect(decompressAdaptive(fixture, 10)).toEqual(new TextEncoder().encode("abracadabr"));
    expect(decompressAdaptive(Uint8Array.of(255, 255), 0)).toEqual(new Uint8Array());
    expect(decompressAdaptive(fixture.subarray(0, 3), 1)).toEqual(Uint8Array.of(97));
  });

  test("repeated NYT literals increment the existing leaf without changing allocation", () => {
    // NYT A = 10000010 in packed LSB bits; then NYT path 0 + literal A + existing leaf 1.
    expect(decompressAdaptive(Uint8Array.of(0, 3, 0x82, 0x04, 0x03))).toEqual(Uint8Array.of(65, 65, 65));
    const tree = new HuffmanTree();
    tree.addReference(65);
    const bits = [0, 0, 1, 0, 0, 0, 0, 0, 1];
    let position = 0;
    expect(tree.decodeSymbol(() => {
      const bit = bits[position++];
      if (bit === undefined) throw new Error("Fixture exhausted");
      return bit;
    })).toBe(65);
    tree.addReference(65);
    const code: number[] = [];
    tree.encodeSymbol(65, (bit) => { code.push(bit); });
    expect(code).toEqual([1]);
  });

  test("rejects truncated lengths and truncated symbols", () => {
    expect(() => decompressAdaptive(Uint8Array.of(0))).toThrow("length");
    expect(() => decompressAdaptive(Uint8Array.of(0, 1))).toThrow("symbol");
    expect(() => decompressAdaptive(Buffer.from("000b868c70", "hex"))).toThrow();
    expect(() => compressAdaptive(new Uint8Array(65536))).toThrow("16 bits");
    expect(() => new HuffmanTree().addReference(256)).toThrow("byte");
  });
});
