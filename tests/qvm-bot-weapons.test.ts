// Authored cases for sv_game.c weapon traps and game/be_ai_weap.h records.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { describe, expect, test } from "bun:test";
import { WeaponAi, WeaponLoadResult } from "../src/botlib/weapons.ts";
import type { WeaponAiOptions } from "../src/botlib/weapons.ts";
import { WeightConfigStore } from "../src/botlib/weights.ts";
import type { WeightConfigStoreOptions } from "../src/botlib/weights.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { qvmBotWeaponSyscall } from "../src/vm/bot-weapon-syscalls.ts";
import { QVM_WEAPON_INFO_BYTES, writeQvmWeaponInfo } from "../src/vm/bot-weapon-record.ts";
import { MemoryBotScriptReader } from "./helpers/bot-script-reader.ts";

const CONFIG = `
projectileinfo {
 name "bolt" model "bolt.md3" flags -3 gravity 0.25 damage 75 radius 12.5
 visdamage 6 damagetype 3 healthinc -2 push 4.5 detonation 5.5
 bounce 0.75 bouncefric 0.125 bouncestop 0.0625
}
weaponinfo {
 number 1 name "Alpha" model "alpha.md3" level -2 weaponindex 9 flags -1
 projectile "bolt" numprojectiles 3 hspread 1.25 vspread 2.5 speed 900 acceleration 10
 recoil { 1, -2, 3 } offset { 4, 5, 6 } angleoffset { 7, 8, 9 }
 extrazvelocity 11 ammoamount 2 ammoindex 10 activate 0.2 reload 0.3 spinup 0.4 spindown 0.5
}
weaponinfo { number 2 name "Beta" projectile "bolt" }
`;
const WEIGHTS = `
weight "Alpha" { switch(0) {
 case 1: return 20;
 default: switch(999) { case 1: return 5; default: return 5; }
} }
weight "Beta" { return 10; }
`;

function words(...values: number[]): DataView {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return view;
}

function fixture(options: WeaponAiOptions = {}, weightOptions: WeightConfigStoreOptions = {}) {
  const reader = new MemoryBotScriptReader(new Map([
    ["weapons.c", CONFIG], ["weights.c", WEIGHTS],
    ["unmatched.c", 'weight "Absent" { return 50; }'],
    ["beta.c", 'weight "Beta" { return 50; }'],
  ]));
  const weights = new WeightConfigStore(reader, { reloadCharacters: true, ...weightOptions });
  const weapons = new WeaponAi({ resolver: reader, weights }, options);
  const memory = new QvmMemory(new Uint8Array(4096).fill(0xa5));
  memory.writeString(32, "weights.c", 16);
  memory.writeString(64, "unmatched.c", 16);
  memory.writeString(96, "beta.c", 16);
  const call = (args: DataView): number | null => qvmBotWeaponSyscall("game", args, memory, weapons);
  const setup = (): number => {
    expect(weapons.setup()).toBe(WeaponLoadResult.NoError);
    const handle = call(words(561));
    if (handle === null || handle <= 0) throw new Error("Expected weapon state handle");
    return handle;
  };
  return { reader, weapons, weights, memory, call, setup };
}

describe("QVM game bot weapon traps", () => {
  test("ignores other roles before words and unrelated traps before arguments", () => {
    const { weapons, memory, call } = fixture();
    const empty = new DataView(new ArrayBuffer(0));
    expect(qvmBotWeaponSyscall("ui", empty, memory, weapons)).toBeNull();
    expect(qvmBotWeaponSyscall("cgame", empty, memory, weapons)).toBeNull();
    for (const trap of [0, 557, 564, -1]) expect(call(words(trap))).toBeNull();
    expect(weapons.diagnostics).toEqual([]);
  });

  test("shares allocation, exhaustion, reset and retirement with the actual owner", () => {
    const { weapons, memory, call, setup } = fixture();
    const handle = setup();
    expect(handle).toBe(1);
    expect(weapons.allocateState()).toBe(2);
    expect(call(words(560, handle, 32))).toBe(0);
    memory.view(4092, 4).setInt32(0, -2147483648, true);
    expect(call(words(558, handle, 4092))).toBe(1);
    expect(call(words(563, handle))).toBe(0);
    expect(weapons.chooseBestFightWeapon(handle, [-1])).toBe(1);
    for (let expected = 3; expected <= 64; expected++) expect(call(words(561))).toBe(expected);
    expect(call(words(561))).toBe(0);
    expect(call(words(562, handle))).toBe(0);
    expect(weapons.allocateState()).toBe(handle);
    expect(call(words(558, handle, 0))).toBe(0);
    weapons.shutdown();
    expect(call(words(561))).toBe(1);
  });

  test("writes all weapon and embedded projectile fields at the source offsets", () => {
    const { memory, call, setup } = fixture();
    const handle = setup();
    expect(QVM_WEAPON_INFO_BYTES).toBe(552);
    expect(call(words(559, handle, 1, -3840))).toBe(0);
    const actual = memory.view(256, 552);
    const expected = new DataView(new ArrayBuffer(552));
    const integers: readonly (readonly [number, number])[] = [
      [0, 1], [4, 1], [168, -2], [172, 9], [176, -1], [260, 3],
      [320, 2], [324, 10], [504, -3], [512, 75], [520, 6], [524, 3], [528, -2],
    ];
    const floats: readonly (readonly [number, number])[] = [
      [264, 1.25], [268, 2.5], [272, 900], [276, 10], [280, 1], [284, -2], [288, 3],
      [292, 4], [296, 5], [300, 6], [304, 7], [308, 8], [312, 9], [316, 11],
      [328, 0.2], [332, 0.3], [336, 0.4], [340, 0.5], [508, 0.25], [516, 12.5],
      [532, 4.5], [536, 5.5], [540, 0.75], [544, 0.125], [548, 0.0625],
    ];
    const strings: readonly (readonly [number, string])[] = [
      [8, "Alpha"], [88, "alpha.md3"], [180, "bolt"], [344, "bolt"], [432, "bolt.md3"],
    ];
    for (const [offset, value] of integers) expected.setInt32(offset, value, true);
    for (const [offset, value] of floats) expected.setFloat32(offset, value, true);
    for (const [offset, value] of strings) {
      for (let index = 0; index < value.length; index++) expected.setUint8(offset + index, value.charCodeAt(index));
    }
    expect(new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength)).toEqual(new Uint8Array(expected.buffer));
    expect(memory.bytes[255]).toBe(0xa5);
    expect(memory.bytes[808]).toBe(0xa5);
    expect(call(words(559, handle, 3, 1024))).toBe(0);
    expect(memory.span(1024, 552)).toEqual(new Uint8Array(552));
  });

  test("skips invalid output pointers behind missing config, weapon and handle gates", () => {
    const { weapons, memory, call, setup } = fixture({ report: () => undefined });
    const before = memory.bytes.slice();
    expect(call(words(559, -1, 1, 0))).toBe(0);
    expect(weapons.diagnostics).toEqual([]);
    const handle = setup();
    const start = weapons.diagnostics.length;
    for (const pointer of [0, 4092]) {
      expect(call(words(559, -1, 0, pointer))).toBe(0);
      expect(call(words(559, handle, 33, pointer))).toBe(0);
      expect(call(words(559, -1, 1, pointer))).toBe(0);
      expect(call(words(559, 64, 1, pointer))).toBe(0);
    }
    expect(weapons.diagnostics.slice(start).map(issue => issue.message)).toEqual([
      "weapon number out of range", "weapon number out of range",
      "move state handle -1 out of range", "invalid move state 64",
      "weapon number out of range", "weapon number out of range",
      "move state handle -1 out of range", "invalid move state 64",
    ]);
    expect(memory.bytes).toEqual(before);
  });

  test("weapon equal to capacity copies retained projectile bytes and reaches output validation", () => {
    const { weapons, memory, call, setup } = fixture();
    const handle = setup(), bytes = weapons.weaponInfoBytes(handle, 32);
    if (bytes === undefined) throw new Error("Expected source capacity alias bytes");
    const expected = bytes.slice();
    expect(call(words(559, handle, 32, 1024))).toBe(0);
    expect(memory.bytes.slice(1024, 1024 + 552)).toEqual(expected);
    expect(() => call(words(559, handle, 32, 4092))).toThrow();
  });

  test("rejects null and short valid destinations without partial mutation", () => {
    const { weapons, memory, call, setup } = fixture();
    const handle = setup();
    const before = memory.bytes.slice();
    expect(() => call(words(559, handle, 1, 0))).toThrow(RangeError);
    expect(() => call(words(559, handle, 1, 4096 - 551))).toThrow(RangeError);
    const info = weapons.weaponInfoBytes(handle, 1);
    if (info === undefined) throw new Error("Expected authored weapon");
    expect(() => writeQvmWeaponInfo(memory.view(256, 551), info)).toThrow();
    expect(memory.bytes).toEqual(before);
  });

  test("copies retained bytes after string terminators and rejects short records before writing", () => {
    const { weapons, memory, setup } = fixture();
    const info = weapons.weaponInfoBytes(setup(), 1);
    if (info === undefined) throw new Error("Expected authored weapon");
    info.set([255, 0, 128], 8);
    writeQvmWeaponInfo(memory.view(256, 552), info);
    expect(Array.from(memory.span(264, 3))).toEqual([255, 0, 128]);
    expect(memory.span(256, 552)).toEqual(info);
    const before = memory.bytes.slice();
    expect(() => writeQvmWeaponInfo(memory.view(256, 552), info.subarray(0, 551))).toThrow();
    expect(memory.bytes).toEqual(before);
  });

  test("reads only reached inventory indexes, including signed and masked boundary words", () => {
    const { memory, weapons, call, setup } = fixture();
    const handle = setup();
    expect(call(words(560, handle, 32))).toBe(0);
    memory.view(4092, 4).setInt32(0, -1, true);
    expect(call(words(558, handle, -4))).toBe(1);
    expect(weapons.chooseBestFightWeapon(handle, index => {
      expect(index).toBe(0);
      return -1;
    })).toBe(1);
    memory.view(4092, 4).setInt32(0, 999998, true);
    expect(() => call(words(558, handle, 4092))).toThrow(RangeError);
    memory.view(100, 3996).setInt32(0, 999998, true);
    memory.view(100, 3996).setInt32(3992, 0, true);
    // The switch at inventory[999] needs 4,000 bytes, one word beyond this pointer.
    expect(() => call(words(558, handle, 100))).toThrow(RangeError);
    memory.view(4, 4000).setInt32(0, 999998, true);
    memory.view(4, 4000).setInt32(3996, 0, true);
    expect(call(words(558, handle, 4))).toBe(2);
  });

  test("does not read inventory for missing state, config, weights or matched weapons", () => {
    const { weapons, call, setup } = fixture({ report: () => undefined });
    expect(call(words(558, -1, 0))).toBe(0);
    const early = weapons.allocateState();
    expect(call(words(558, early, 0))).toBe(0);
    const handle = setup();
    expect(call(words(558, handle, 0))).toBe(0);
    expect(call(words(560, handle, 64))).toBe(0);
    expect(call(words(558, handle, 0))).toBe(0);
    expect(call(words(560, handle, 96))).toBe(0);
    expect(() => call(words(558, handle, 0))).toThrow(RangeError);
  });

  test("signed fuzzy indexes can read preceding inventory cells within the same VM allocation", () => {
    const { reader, memory, call, setup } = fixture();
    reader.files.set("weights.c", 'weight "Alpha" { switch(0xffffffff) { case 1: return 20; default: return 0; } }');
    const handle = setup();
    expect(call(words(560, handle, 32))).toBe(0);
    memory.view(252, 4).setInt32(0, 0, true);
    expect(call(words(558, handle, 256))).toBe(1);
    expect(call(words(558, handle, 4096 + 256))).toBe(1);
    expect(call(words(558, handle, 256 - 4096))).toBe(1);
    expect(() => call(words(558, handle, 4096))).toThrow("exceeds allocation");
    expect(() => call(words(558, handle, 0))).toThrow("nonnull");
  });

  test("fuzzy evaluation rereads live inventory after child and random callbacks", () => {
    const { reader, weights, memory } = fixture();
    reader.files.set("live.c", `weight "live" { switch(0) {
      case 0: return balance(10, 10, 10);
      case 10: return balance(30, 30, 30);
      default: return 50;
    } }`);
    const config = weights.load("live.c");
    memory.view(256, 4).setInt32(0, 5, true);
    const reads: number[] = [];
    let randomCalls = 0;
    const actual = config.evaluateUndecided(0, index => {
      reads.push(index);
      return memory.view(256, 4).getInt32(index * 4, true);
    }, {
      nextInt: () => {
        randomCalls++;
        memory.view(256, 4).setInt32(0, 10, true);
        return 0;
      },
    });
    // The two comparisons see 5. After the callbacks, scale uses 10 / 10 = 1.
    expect(actual).toBe(10);
    expect(randomCalls).toBe(2);
    expect(reads).toEqual([0, 0, 0]);
    let sourceReads = 0;
    expect(config.evaluate(0, () => ++sourceReads === 3 ? 10 : 5)).toBe(10);
    expect(sourceReads).toBe(3);
    expect(() => config.evaluate(0, () => 2147483648)).toThrow(RangeError);
  });

  test("defers filenames until after handle validation and existing weight release", () => {
    const { weapons, memory, call, setup } = fixture({ report: () => undefined });
    expect(call(words(560, -1, 0))).toBe(11);
    const handle = setup();
    expect(call(words(560, handle, 32))).toBe(0);
    expect(weapons.chooseBestFightWeapon(handle, [-1])).toBe(1);
    expect(() => call(words(560, handle, 0))).toThrow(RangeError);
    expect(call(words(558, handle, 0))).toBe(0);
    memory.bytes.fill(0x61, 4092);
    expect(() => call(words(560, handle, 4092))).toThrow(RangeError);
    memory.writeString(128, "missing.c", 16);
    expect(call(words(560, handle, 128))).toBe(11);
    weapons.shutdown();
    const noConfig = weapons.allocateState();
    expect(call(words(560, noConfig, 32))).toBe(12);
  });

  test("captures argument words before the release callback changes the live frame", () => {
    let active = words(560, 1, 32);
    let mutate = false;
    const { weapons, call, setup } = fixture({}, {
      reloadCharacters: () => {
        if (mutate) active.setInt32(8, 96, true);
        return true;
      },
    });
    const handle = setup();
    expect(call(active)).toBe(0);
    mutate = true;
    active = words(560, handle, 32);
    expect(call(active)).toBe(0);
    expect(active.getInt32(8, true)).toBe(96);
    expect(weapons.chooseBestFightWeapon(handle, [-1])).toBe(1);
  });

  test("truncated arguments reject before owner diagnostics or state mutation", () => {
    const { weapons, call, setup } = fixture({ report: () => undefined });
    const handle = setup();
    const start = weapons.diagnostics.length;
    for (const trap of [558, 559, 560, 562, 563]) {
      expect(() => call(words(trap))).toThrow(RangeError);
    }
    expect(() => call(words(560, handle))).toThrow(RangeError);
    expect(weapons.diagnostics.length).toBe(start);
    expect(weapons.allocateState()).toBe(2);
  });
});
