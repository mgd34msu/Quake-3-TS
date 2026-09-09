import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { LinuxNativeRandom } from "../../src/core/native-random.ts";

// Native i386 oracle: /tmp/quake3-native-random-oracle-20260905-a/run.sh.
// gcc 16.2.1 -m32 -O2 -DNDEBUG, glibc 2.44, fixture SHA-256
// a58e065376118ae25b1a42ec3183d88b7389bdcce9589b477d52f355a4e39dee.
// Primary sourceware HEAD SHA-256: random_r.c 4c8ffca50ab272e922a9287f8626e0d7cab096c2e1b013e3f7d68e0710148918,
// random.c a430dd68bddb40b2b3aadb46450a10bcb71594ca5c5f3078b4946904c53c8a97,
// rand.c dc8f91133be2a896a2ee938484fe5a4e26cc3de421603fb098fb205c9baec19a.
const seedOneVector: number[] = [
  1804289383, 846930886, 1681692777, 1714636915, 1957747793, 424238335,
  719885386, 1649760492, 596516649, 1189641421, 1025202362, 1350490027,
];
const unsignedMaxVector: number[] = [
  254925627, 1205188300, 366127624, 1401405153, 76053476, 1604170158,
  1302235366, 362229243, 334960208, 1882140968, 960816832, 627031785,
];
const vectors: readonly (readonly [number, number[]])[] = [
  [1, seedOneVector],
  [0, seedOneVector],
  [4294967295, unsignedMaxVector],
  [2147483648, [1336741213, 1210407648, 1447044896, 337392383, 82502902, 538660432,
    1313908778, 370221063, 344413073, 1896089129, 2044477265, 1711647701]],
];

function values(random: LinuxNativeRandom, count: number): number[] {
  return Array.from({ length: count }, () => random.next());
}

function sequenceHash(seed: number): string {
  const random = new LinuxNativeRandom(seed);
  const bytes = new Uint8Array(10_000 * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 10_000; index++) view.setUint32(index * 4, random.next(), true);
  return createHash("sha256").update(bytes).digest("hex");
}

describe("Linux glibc native rand", () => {
  test("matches native first-output vectors for ordinary and unsigned-high seeds", () => {
    for (const [seed, expected] of vectors) {
      const random = new LinuxNativeRandom(seed);
      expect(values(random, expected.length)).toEqual(expected);
    }
  });

  test("matches native 10,000-output binary sequence hashes", () => {
    const hashes: readonly (readonly [number, string])[] = [
      [0, "510767f04929cf7bbdae8217142280189ba6d259a11daee8dd600f8a6785812a"],
      [1, "510767f04929cf7bbdae8217142280189ba6d259a11daee8dd600f8a6785812a"],
      [2147483648, "460571d0b6501f9dd2f3652805fd52df2a2a80a15cb55f51d232d388abfffd9f"],
      [4294967295, "455b67fc8fb962113a10f81c27974a2475fe8faa4364d13653f08917a4c0c686"],
    ];
    for (const [seed, expected] of hashes) expect(sequenceHash(seed)).toBe(expected);
  });

  test("reseeding restarts the exact native sequence", () => {
    const random = new LinuxNativeRandom(1);
    expect(values(random, 3)).toEqual([1804289383, 846930886, 1681692777]);
    random.seed(4294967295);
    expect(values(random, 2)).toEqual([254925627, 1205188300]);
    random.seed(1);
    expect(values(random, 3)).toEqual([1804289383, 846930886, 1681692777]);
  });

  test("instances own their state when calls are interleaved", () => {
    const first = new LinuxNativeRandom(1);
    const second = new LinuxNativeRandom(4294967295);
    const firstValues: number[] = [];
    const secondValues: number[] = [];
    for (let index = 0; index < 12; index++) {
      firstValues.push(first.next());
      secondValues.push(second.next());
    }
    expect(firstValues).toEqual(seedOneVector);
    expect(secondValues).toEqual(unsignedMaxVector);
  });

  test("returns only source RAND_MAX integers and rejects non-uint32 seeds", () => {
    const random = new LinuxNativeRandom(7);
    for (let index = 0; index < 10_000; index++) {
      const value = random.next();
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(2147483647);
    }
    for (const seed of [-1, 4294967296, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => random.seed(seed)).toThrow("native random seed must be an unsigned 32-bit integer");
    }
    expect(() => new LinuxNativeRandom(-1)).toThrow("native random seed must be an unsigned 32-bit integer");
  });
});
