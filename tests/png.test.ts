import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { encodePng } from "../src/core/png.ts";

test("PNG retains RGBA bytes in independent zlib readback", () => {
  const image = encodePng(1, 2, new Uint8Array([255, 0, 0, 128, 0, 255, 0, 255]));
  const view = new DataView(image.buffer);
  expect([...image.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(view.getUint32(16)).toBe(1);
  expect(view.getUint32(20)).toBe(2);
  const dataLength = view.getUint32(33);
  expect([...inflateSync(image.subarray(41, 41 + dataLength))]).toEqual([0, 255, 0, 0, 128, 0, 0, 255, 0, 255]);
  expect([...image.subarray(image.length - 4)]).toEqual([174, 66, 96, 130]);
});

test("PNG rejects invalid dimensions and mismatched data", () => {
  expect(() => encodePng(1, 1, new Uint8Array(3))).toThrow(RangeError);
  expect(() => encodePng(0, 0, new Uint8Array())).toThrow(RangeError);
});
