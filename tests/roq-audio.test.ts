import { expect, test } from "bun:test";
import { SourceRoqAudio } from "../src/cinematic/roq-audio.ts";

test("RoQ audio square table begins zero and has both signed square halves", () => {
  const audio = new SourceRoqAudio();
  const input = new Uint8Array([1, 127, 129, 255]);
  const output = new Int16Array(4);
  audio.decodeMonoToMono(input, output, 4, false, 100);
  expect([...output]).toEqual([100, 100, 100, 100]);
  audio.setupTable();
  expect(audio.decodeMonoToMono(input, output, 4, false, 100)).toBe(4);
  expect([...output]).toEqual([101, 16230, 16229, 100]);
  audio.decodeMonoToMono(input, output, 4, true, 100);
  expect([...output]).toEqual([-32667, -16538, -16539, -32668]);
});

test("RoQ mono expansion duplicates source shorts including signed wrap", () => {
  const audio = new SourceRoqAudio(); audio.setupTable();
  const output = new Int16Array(6).fill(9);
  expect(audio.decodeMonoToStereo(new Uint8Array([127, 127]), output, 2, false, 32760)).toBe(2);
  expect([...output]).toEqual([-16647, -16647, -518, -518, 9, 9]);
  audio.decodeMonoToStereo(new Uint8Array([0]), output, 1, true, 0);
  expect([...output.subarray(0, 2)]).toEqual([-32768, -32768]);
});

test("RoQ stereo expansion counts input bytes and retains independent predictors", () => {
  const audio = new SourceRoqAudio(); audio.setupTable();
  const output = new Int16Array(4);
  expect(audio.decodeStereoToStereo(new Uint8Array([1, 2, 129, 130]), output, 4, false, 0x1234)).toBe(2);
  expect([...output]).toEqual([4609, 13316, 4608, 13312]);
  audio.decodeStereoToStereo(new Uint8Array([0, 0]), output, 2, true, 0x1234);
  expect([...output.subarray(0, 2)]).toEqual([-28160, -19456]);
  // A size of one still consumes and writes a whole stereo pair in the C loop.
  expect(audio.decodeStereoToStereo(new Uint8Array([1, 2]), output, 1, false, 0)).toBe(0);
  expect([...output.subarray(0, 2)]).toEqual([1, 4]);
});

test("RoQ stereo reduction averages unnarrowed predictors and truncates negative halves", () => {
  const audio = new SourceRoqAudio(); audio.setupTable();
  const output = new Int16Array(3);
  expect(audio.decodeStereoToMono(new Uint8Array([127, 0, 127, 0, 129, 0]), output, 3, false, 0x7f00)).toBe(3);
  expect([...output]).toEqual([24320, 32385, 32384]);
  audio.decodeStereoToMono(new Uint8Array([129, 0]), output, 1, true, 0x8080);
  expect(output[0]).toBe(0);
});

test("RoQ audio reports truncated allocations at the reached sample", () => {
  const audio = new SourceRoqAudio(); audio.setupTable();
  const output = new Int16Array(2).fill(9);
  expect(() => audio.decodeMonoToMono(new Uint8Array([1]), output, 2, false, 0)).toThrow("input is truncated");
  expect([...output]).toEqual([1, 9]);
  expect(() => audio.decodeMonoToStereo(new Uint8Array([1]), new Int16Array(1), 1, false, 0)).toThrow("output is truncated");
  expect(() => audio.decodeStereoToMono(new Uint8Array([1]), output, 1, false, 0)).toThrow("input is truncated");
});
