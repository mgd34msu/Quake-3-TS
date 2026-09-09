import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { vec3 } from "../src/core/math.ts";
import { float32ToBits, qRandom } from "../src/core/numeric.ts";
import { GameRandom, gameAtof, gameAtoi, scanGameFloat, scanGameVector } from "../src/game/numeric.ts";
import { SpawnParser } from "../src/game/spawn.ts";

interface NumericFixture {
  readonly text: string;
  readonly scalarBits: number;
  readonly integer: number;
  readonly scanBits: number;
  readonly nextOffset: number;
  readonly paddedVectorBits: readonly [number, number, number];
}

// Original bg_lib.c compiled by pinned lcc/q3asm, executed by the untouched
// 32-bit vm_game=1 interpreter. This is not native-compiled bg_lib arithmetic.
// Source dbe4ddb10315479fc00086f08e25d968b4b43c49; external verification sources:
// /tmp/quake3-qvm-numeric-0ZfvV4/{fixture.c,derive-retail.ts,verify.ts}.
// Actual VM log SHA-256: 6412b18c48df6b3d7da396ea6837ab8b1ea302d78953ba0ba1093826afda9463.
const fixtures: readonly NumericFixture[] = [
{"text":"2.67","scalarBits":1076552007,"integer":2,"scanBits":1076552007,"nextOffset":5,"paddedVectorBits":[1076552007,0,0]},
{"text":"7.3131313","scalarBits":1089078573,"integer":7,"scanBits":1089078573,"nextOffset":10,"paddedVectorBits":[1089078573,0,0]},
{"text":"3.12456789","scalarBits":1078458602,"integer":3,"scanBits":1078458602,"nextOffset":11,"paddedVectorBits":[1078458602,0,0]},
{"text":"1.345","scalarBits":1068247285,"integer":1,"scanBits":1068247285,"nextOffset":6,"paddedVectorBits":[1068247285,0,0]},
{"text":"3.134","scalarBits":1078498164,"integer":3,"scanBits":1078498164,"nextOffset":6,"paddedVectorBits":[1078498164,0,0]},
{"text":"0.1","scalarBits":1036831949,"integer":0,"scanBits":1036831949,"nextOffset":4,"paddedVectorBits":[1036831949,0,0]},
{"text":".5","scalarBits":1056964608,"integer":0,"scanBits":0,"nextOffset":0,"paddedVectorBits":[0,0,0]},
{"text":"-.5","scalarBits":3204448256,"integer":0,"scanBits":2147483648,"nextOffset":1,"paddedVectorBits":[2147483648,0,0]},
{"text":"1e2","scalarBits":1065353216,"integer":1,"scanBits":1065353216,"nextOffset":2,"paddedVectorBits":[1065353216,1073741824,0]},
{"text":"-1E-2","scalarBits":3212836864,"integer":-1,"scanBits":3212836864,"nextOffset":3,"paddedVectorBits":[3212836864,3221225472,0]},
{"text":"+3.5x","scalarBits":1080033280,"integer":3,"scanBits":1080033280,"nextOffset":5,"paddedVectorBits":[1080033280,0,0]},
{"text":"-0","scalarBits":2147483648,"integer":0,"scanBits":2147483648,"nextOffset":3,"paddedVectorBits":[2147483648,0,0]},
{"text":"-0.0","scalarBits":2147483648,"integer":0,"scanBits":2147483648,"nextOffset":5,"paddedVectorBits":[2147483648,0,0]},
{"text":"garbage","scalarBits":0,"integer":0,"scanBits":0,"nextOffset":1,"paddedVectorBits":[0,0,0]},
{"text":"","scalarBits":0,"integer":0,"scanBits":0,"nextOffset":0,"paddedVectorBits":[0,0,0]},
{"text":"2147483647","scalarBits":1325400063,"integer":2147483647,"scanBits":1325400063,"nextOffset":11,"paddedVectorBits":[1325400063,0,0]},
{"text":"2147483648","scalarBits":1325400063,"integer":-2147483648,"scanBits":1325400063,"nextOffset":11,"paddedVectorBits":[1325400063,0,0]},
{"text":"4294967295","scalarBits":1333788671,"integer":-1,"scanBits":1333788671,"nextOffset":11,"paddedVectorBits":[1333788671,0,0]},
{"text":"4294967296","scalarBits":1333788671,"integer":0,"scanBits":1333788671,"nextOffset":11,"paddedVectorBits":[1333788671,0,0]},
{"text":"9007199254740993","scalarBits":1509949439,"integer":1,"scanBits":1509949439,"nextOffset":17,"paddedVectorBits":[1509949439,0,0]},
{"text":"  -12x","scalarBits":3242196992,"integer":-12,"scanBits":3242196992,"nextOffset":6,"paddedVectorBits":[3242196992,0,0]},
{"text":"3.5","scalarBits":1080033280,"integer":3,"scanBits":1080033280,"nextOffset":5,"paddedVectorBits":[1080033280,0,0]},
{"text":"1,2,3","scalarBits":1065353216,"integer":1,"scanBits":1065353216,"nextOffset":2,"paddedVectorBits":[1065353216,1073741824,1077936128]},
{"text":"1x2y3","scalarBits":1065353216,"integer":1,"scanBits":1065353216,"nextOffset":2,"paddedVectorBits":[1065353216,1073741824,1077936128]},
{"text":"1 2","scalarBits":1065353216,"integer":1,"scanBits":1065353216,"nextOffset":2,"paddedVectorBits":[1065353216,1073741824,0]},
{"text":"1.5 2.5 3.5","scalarBits":1069547520,"integer":1,"scanBits":1069547520,"nextOffset":4,"paddedVectorBits":[1069547520,1075838976,1080033280]},
{"text":".5 2 3","scalarBits":1056964608,"integer":0,"scanBits":0,"nextOffset":0,"paddedVectorBits":[0,0,0]},
{"text":"1 .5 3","scalarBits":1065353216,"integer":1,"scanBits":1065353216,"nextOffset":2,"paddedVectorBits":[1065353216,0,0]},
{"text":"1e2 3 4","scalarBits":1065353216,"integer":1,"scanBits":1065353216,"nextOffset":2,"paddedVectorBits":[1065353216,1073741824,1077936128]},
{"text":"1 2 nope","scalarBits":1065353216,"integer":1,"scanBits":1065353216,"nextOffset":2,"paddedVectorBits":[1065353216,1073741824,0]},
{"text":"1.2.3 4","scalarBits":1067030938,"integer":1,"scanBits":1067030938,"nextOffset":4,"paddedVectorBits":[1067030938,1077936128,1082130432]},
];

describe("game QVM numeric boundary", () => {
  test("scalar, integer and cursor results match actual QVM bit patterns", () => {
    for (const fixture of fixtures) {
      expect(float32ToBits(gameAtof(fixture.text))).toBe(fixture.scalarBits);
      expect(gameAtoi(fixture.text)).toBe(fixture.integer);
      const scan = scanGameFloat(fixture.text);
      expect(float32ToBits(scan.value)).toBe(fixture.scanBits);
      expect(scan.nextOffset).toBe(fixture.nextOffset);
      const vector = scanGameVector(`${fixture.text}\0\0`);
      expect([vector.x, vector.y, vector.z].map(float32ToBits)).toEqual([...fixture.paddedVectorBits]);
    }
  });

  test("signed byte whitespace and signs preserve zero and prefix semantics", () => {
    for (let byte = 1; byte <= 255; byte++) {
      if (byte > 32 && byte < 128) continue;
      const prefix = String.fromCharCode(byte);
      expect(gameAtof(`${prefix}-3.5`)).toBe(-3.5);
      expect(gameAtoi(`${prefix}+12tail`)).toBe(12);
      expect(scanGameFloat(`${prefix}-3.5`)).toEqual({ value: -3.5, nextOffset: 6 });
    }
    for (const text of ["-0", "-0.0", "-", "-nope"]) expect(Object.is(gameAtof(text), -0)).toBe(true);
    expect(gameAtof("0x1p2")).toBe(0);
    expect(gameAtof("Infinity")).toBe(0);
    expect(gameAtof("NaN")).toBe(0);
    expect(gameAtof("9".repeat(50))).toBe(Infinity);
    expect(gameAtoi("-2147483649")).toBe(2147483647);
    expect(gameAtoi("18446744073709551617")).toBe(1);
    expect(gameAtof("\0ignored")).toBe(0);
  });

  test("scanner consumes delimiters and rejects unknown backing reads", () => {
    expect(scanGameVector("1,2,3")).toEqual(vec3(1, 2, 3));
    expect(scanGameVector("1e2 3 4")).toEqual(vec3(1, 2, 3));
    expect(scanGameVector("1 2 nope")).toEqual(vec3(1, 2, 0));
    expect(scanGameVector("1 2 ")).toEqual(vec3(1, 2, 0));
    expect(scanGameVector("1\0" + "2\0" + "3")).toEqual(vec3(1, 2, 3));
    expect(scanGameFloat("1", 1)).toEqual({ value: 0, nextOffset: 1 });
    for (const text of ["1", "1 2", "-"]) expect(() => scanGameVector(text)).toThrow("backing string");
    for (const offset of [-1, 0.5, 2, Infinity, NaN]) expect(() => scanGameFloat("1", offset)).toThrow("backing string");
    for (const parse of [gameAtof, gameAtoi, scanGameFloat, scanGameVector]) expect(() => parse("\u0100")).toThrow("byte characters");
  });

  test("leading-dot scanner uses the pinned/baseq3 initialization, stabilizing missionpack", () => {
    expect(scanGameFloat(".5")).toEqual({ value: 0, nextOffset: 0 });
    expect(scanGameVector(".5 2 3")).toEqual(vec3(0, 0, 0));
    expect(scanGameVector("1 .5 3")).toEqual(vec3(1, 0, 0));
    expect(scanGameFloat("-.5")).toEqual({ value: -0, nextOffset: 1 });
    // Extracted missionpack _atof has no c initialization. An actual VM probe
    // with its stale c stack slot seeded to '.' produced (0,5,2), cursor 5;
    // stale 0/'0' produced (0,0,0), cursor 0. We do not emulate that stack state.
  });
});

describe("instance-owned game rand", () => {
  test("source seed sequences match the actual VM and do not share state", () => {
    const sequences = [
      { seed: 0, values: [1, 3534, 1015, 14284, 2653, 1402] },
      { seed: 1, values: [3534, 1015, 14284, 2653, 1402, 5299] },
      { seed: 0x80000000, values: [1, 3534, 1015, 14284, 2653, 1402] },
      { seed: 0xffffffff, values: [29236, 6053, 20514, 25915, 3904, 30273] },
    ];
    const independent = new GameRandom();
    for (const sequence of sequences) {
      const random = new GameRandom(sequence.seed);
      expect(sequence.values.map(() => random.rand())).toEqual(sequence.values);
      random.reset(sequence.seed);
      expect(sequence.values.map(() => random.rand())).toEqual(sequence.values);
    }
    expect(independent.seed).toBe(0);
    expect(independent.rand()).toBe(1);
    expect(independent.seed).toBe(1);
  });

  test("game random and crandom include both endpoints and differ from Q_random", () => {
    const maximum = new GameRandom(12790);
    expect(maximum.rand()).toBe(32767);
    maximum.reset(12790); expect(maximum.random()).toBe(1);
    maximum.reset(12790); expect(maximum.crandom()).toBe(1);
    const zero = new GameRandom(22779);
    expect(zero.rand()).toBe(0);
    zero.reset(22779); expect(zero.random()).toBe(0);
    zero.reset(22779); expect(zero.crandom()).toBe(-1);
    expect(new GameRandom(0).random()).toBe(Math.fround(1 / 32767));
    expect(new GameRandom(0).random()).not.toBe(qRandom(0).value);
    for (const seed of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => new GameRandom(seed)).toThrow("safe integer");
  });
});

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
test.skipIf(!existsSync(`${dataPath}/missionpack/pak0.pk3`))("all 4940 retail scalar inputs match actual shipped-QVM output digest", async () => {
  const references = [
    { product: "baseq3", sha256: "57c52bf22e4f528c064f8af1553a7103723bab0a02276bb11eed944bf829b219", archive: "baseq3/pak8.pk3" },
    { product: "missionpack", sha256: "da041f17f296feeaf8269eabc9062cefdecddfd24ff4d84eb291902e527d1d8a", archive: "missionpack/pak0.pk3" },
  ] satisfies readonly { readonly product: "baseq3" | "missionpack"; readonly sha256: string; readonly archive: string }[];
  for (const reference of references) {
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: reference.product });
    const source = vfs.source("vm/qagame.qvm");
    expect(source?.kind).toBe("pk3");
    if (source?.kind !== "pk3") throw new Error("Retail numeric reference must come from a PK3");
    expect(source.archivePath.endsWith(reference.archive)).toBe(true);
    expect(createHash("sha256").update(await vfs.read("vm/qagame.qvm")).digest("hex")).toBe(reference.sha256);
  }
  const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "missionpack" });
  const maps = vfs.list("maps/").filter(path => path.endsWith(".bsp")), inputs = new Set<string>();
  for (const map of maps) {
    const parser = new SpawnParser(parseBsp(await vfs.read(map), map).entities, map);
    parser.next(); // Worldspawn does not use the ordinary entity field table.
    while (true) {
      const variables = parser.next();
      if (variables === null) break;
      for (const pair of variables.entries) {
        const field = pair.key.toLowerCase();
        if (["speed", "wait", "random", "angle"].includes(field)) inputs.add(pair.value);
        else if (field === "origin" || field === "angles") {
          for (const component of pair.value.trim().split(/\s+/)) inputs.add(component);
        }
      }
    }
  }
  expect(maps).toHaveLength(57);
  expect(inputs.size).toBe(4940);
  // Both shipped scalar functions were appended unchanged to a compiled test
  // QVM and executed by the original interpreter. Only internal branch targets,
  // fixture calls and image offsets were relocated; original data was untouched.
  // Each product matched all 4940 outputs. Digest covers sorted text<TAB>uint32bits<LF>.
  const rows = [...inputs].sort().map(text => `${text}\t${float32ToBits(gameAtof(text))}\n`).join("");
  expect(createHash("sha256").update(rows).digest("hex")).toBe("1b2818525c6aaa843ba4f0f78698066fc9c20f382df9537199bcaae02757c88b");
}, 60_000);
