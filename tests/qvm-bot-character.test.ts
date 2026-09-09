// Authored cases for sv_game.c character traps and be_ai_char.c getters.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { describe, expect, test } from "bun:test";
import { BotCharacterLibrary, CharacterError } from "../src/botlib/character.ts";
import type { BotCharacterLibraryOptions } from "../src/botlib/character.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { qvmBotCharacterSyscall } from "../src/vm/bot-character-syscalls.ts";
import { MemoryBotScriptReader } from "./helpers/bot-script-reader.ts";

function words(...values: number[]): DataView {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return view;
}

function fixture(options: BotCharacterLibraryOptions = {}) {
  const reader = new MemoryBotScriptReader(new Map([
    ["bots/default_c.c", 'skill 1 { 10 "default" } skill 4 { 10 "default" } skill 5 { 10 "default" }'],
    ["bots/authored.c", `
      skill 1 { NAME "Authored" 1 "" 2 0.25 3 9.75 4 4294967295 5 16777217 6 "\xff" }
      skill 4 { NAME "Authored" 1 "" 2 1.0 3 3.0 4 4294967295 5 16777217 6 "\xff" }
      skill 5 { NAME "Authored" 1 "" 2 0.5 3 1.0 4 4294967295 5 16777217 6 "\xff" }
    `],
  ]));
  reader.globals.add("NAME 0");
  const characters = new BotCharacterLibrary(reader, options);
  const memory = new QvmMemory(new Uint8Array(512).fill(0xa5));
  memory.writeString(32, "bots/authored.c", 16);
  const call = (argumentsView: DataView): number | null =>
    qvmBotCharacterSyscall("game", argumentsView, memory, characters);
  const load = (skillWord = 0x3f800000): number => {
    const handle = call(words(500, 32, skillWord));
    if (handle === null || handle <= 0) throw new Error("Expected authored character handle");
    return handle;
  };
  return { reader, characters, memory, call, load };
}

describe("QVM game bot character traps", () => {
  test("rejects other roles before reading words and unrelated traps before arguments", () => {
    const { characters, memory, call } = fixture();
    const empty = new DataView(new ArrayBuffer(0));
    expect(qvmBotCharacterSyscall("ui", empty, memory, characters)).toBeNull();
    expect(qvmBotCharacterSyscall("cgame", empty, memory, characters)).toBeNull();
    for (const trap of [0, 499, 507, -1]) expect(call(words(trap))).toBeNull();
    expect(characters.diagnostics).toEqual([]);
  });

  test("loads using float word bits, source globals and the actual owner's cached handles", () => {
    const { characters, call, load } = fixture();
    const handle = load(0x40200000);
    expect(characters.float(handle, 2)).toBe(0.625);
    expect(call(words(502, handle, 3))).toBe(0x40cc0000);
    expect(characters.string(handle, 0)).toBe("Authored");
    expect(characters.string(handle, 10)).toBe("default");
    expect(characters.load("bots/authored.c", 2.5)).toBe(handle);
    expect(load(0x40200000)).toBe(handle);
    expect(characters.float(load(0xc0000000), 2)).toBe(0.25);
    expect(characters.float(load(0x41100000), 2)).toBe(0.5);
    expect(characters.float(load(0xff800000), 2)).toBe(0.25);
    expect(characters.float(load(0x7f800000), 2)).toBe(0.5);
  });

  test("full character capacity precedes exact-skill filename reads but follows fractional lookup", () => {
    let reloadCalls = 0;
    const { characters, reader, call, load } = fixture({
      reloadCharacters: () => { reloadCalls++; return true; },
    });
    for (let index = 0; index < 63; index++) expect(load()).toBe(index + 2);
    const reads = reader.reads.slice();
    const diagnostics = characters.diagnostics.length;
    const reloadBefore = reloadCalls;
    const exactSkills = [0x3f800000, 0x40800000, 0x40a00000, 0xc0000000, 0x41100000];
    for (const skill of exactSkills) {
      expect(call(words(500, 0, skill))).toBe(0);
      expect(call(words(500, 511, skill))).toBe(0);
    }
    expect(reloadCalls - reloadBefore).toBe(exactSkills.length * 2);
    expect(reader.reads).toEqual(reads);
    expect(characters.diagnostics.length).toBe(diagnostics);
    expect(() => call(words(500, 0, 0x40200000))).toThrow(RangeError);
    expect(() => call(words(500, 511, 0x40900000))).toThrow(RangeError);
  });

  test("default loading may consume the final slot before resolving the requested filename", () => {
    let reloadCalls = 0;
    const { characters, reader, call, load } = fixture({
      reloadCharacters: () => { reloadCalls++; return true; },
    });
    for (let index = 0; index < 62; index++) expect(load()).toBe(index + 2);
    const reads = reader.reads.length;
    const reloadBefore = reloadCalls;
    expect(call(words(500, 0, 0x40800000))).toBe(0);
    expect(reader.reads.slice(reads)).toEqual(["bots/default_c.c"]);
    expect(characters.string(64, 10)).toBe("default");
    expect(reloadCalls - reloadBefore).toBe(1);
  });

  test("exact-skill default callbacks run before filename resolution with captured argument words", () => {
    const { characters, memory, reader, call } = fixture();
    const argumentsView = words(500, 32, 0x3f800000);
    memory.bytes.fill(0xa5, 32, 48);
    reader.beforeRead = path => {
      if (path === "bots/default_c.c") {
        memory.writeString(32, "bots/authored.c", 16);
        argumentsView.setInt32(4, 0, true);
        argumentsView.setInt32(8, 0x40a00000, true);
      }
    };
    const handle = call(argumentsView);
    if (handle === null || handle <= 0) throw new Error("Expected authored character handle");
    expect(characters.float(handle, 2)).toBe(0.25);
    expect(characters.string(handle, 0)).toBe("Authored");
  });

  test("an empty fractional cache leaves filename bytes live through the first default read", () => {
    const { characters, memory, reader, call } = fixture();
    reader.files.set("bots/revised.c", 'skill 1 { 0 "Revised" 2 2.0 } skill 4 { 0 "Revised" 2 4.0 }');
    const argumentsView = words(500, 32, 0x40200000);
    reader.beforeRead = path => {
      if (path === "bots/default_c.c") {
        memory.writeString(32, "bots/revised.c", 16);
        argumentsView.setInt32(4, 0, true);
        argumentsView.setInt32(8, 0x40a00000, true);
      }
    };
    const handle = call(argumentsView);
    if (handle === null || handle <= 0) throw new Error("Expected revised character handle");
    expect(characters.string(handle, 0)).toBe("Revised");
    expect(characters.float(handle, 2)).toBe(3);
    expect(reader.reads).toEqual([
      "bots/default_c.c", "bots/revised.c", "bots/default_c.c", "bots/revised.c",
    ]);
  });

  test("fractional cache misses do not snapshot filename bytes across later default reads", () => {
    const { characters, memory, reader, call, load } = fixture();
    load();
    reader.files.set("bots/revised.c", 'skill 4 { 0 "Revised" 2 4.0 } skill 5 { 0 "Revised" 2 6.0 }');
    const reads = reader.reads.length;
    reader.beforeRead = path => {
      if (path === "bots/default_c.c") memory.writeString(32, "bots/revised.c", 16);
    };
    const handle = call(words(500, 32, 0x40900000));
    if (handle === null || handle <= 0) throw new Error("Expected revised character handle");
    expect(characters.string(handle, 0)).toBe("Revised");
    expect(characters.float(handle, 2)).toBe(5);
    expect(reader.reads.slice(reads)).toEqual([
      "bots/default_c.c", "bots/revised.c", "bots/default_c.c", "bots/revised.c",
    ]);
  });

  test("an occupied fractional cache reads the filename before comparing a different skill", () => {
    const { reader, call, load } = fixture();
    load();
    const reads = reader.reads.slice();
    expect(() => call(words(500, 0, 0x40900000))).toThrow(RangeError);
    expect(reader.reads).toEqual(reads);
  });

  test("copies the cache name after the file read and publishes into the previously reserved slot", () => {
    for (const alreadyCached of [false, true]) {
      const { characters, memory, reader, call } = fixture();
      reader.files.set("bots/revised.c", 'skill 1 { 0 "Revised" 2 2.0 }');
      const earlier = alreadyCached ? characters.load("bots/revised.c", 1) : 0;
      reader.beforeRead = path => {
        if (path === "bots/authored.c") memory.writeString(32, "bots/revised.c", 16);
      };
      const handle = call(words(500, 32, 0x3f800000));
      if (handle === null || handle <= 0) throw new Error("Expected authored character handle");
      expect(handle).toBe(alreadyCached ? 3 : 2);
      expect(characters.string(handle, 0)).toBe("Authored");
      expect(characters.float(handle, 2)).toBe(0.25);
      expect(characters.load("bots/revised.c", 1)).toBe(alreadyCached ? earlier : handle);
      if (alreadyCached) expect(characters.string(earlier, 0)).toBe("Revised");
    }
  });

  test("owns the copied filename across parser callbacks while load diagnostics read current bytes", () => {
    const { characters, memory, reader, call } = fixture();
    reader.files.set("bots/authored.c", '#include "rename.h"\nskill 1 { 0 "Authored" 2 0.25 }');
    reader.files.set("rename.h", "");
    reader.beforeRead = path => {
      if (path === "bots/authored.c") memory.writeString(32, "bots/revised.c", 16);
      if (path === "rename.h") memory.writeString(32, "bots/current.c", 16);
    };
    const handle = call(words(500, 32, 0x3f800000));
    if (handle === null || handle <= 0) throw new Error("Expected authored character handle");
    expect(characters.diagnostics.at(-1)?.source).toBe("bots/current.c");
    expect(characters.load("bots/revised.c", 1)).toBe(handle);
    expect(characters.string(handle, 0)).toBe("Authored");
  });

  test("new exact and arbitrary default fallbacks publish before their single informational diagnostic", () => {
    for (const defaultSkill of [1, 3]) {
      const observed: number[] = [];
      const { characters, memory, reader, call } = fixture({
        reloadCharacters: () => true,
        report: issue => {
          if (issue.code === "fallback" && issue.source === "bots/missing.c"
            && issue.message.startsWith("loaded default skill")) {
            expect(issue.severity).toBe("info");
            observed.push(characters.integer(2, 2));
            memory.writeString(32, "bots/revised.c", 16);
          }
        },
      });
      reader.files.set("bots/default_c.c", `skill ${defaultSkill} { 2 99 }`);
      memory.writeString(32, "bots/missing.c", 16);
      expect(call(words(500, 32, 0x3f800000))).toBe(2);
      expect(observed).toEqual([99]);
      expect(characters.diagnostics.filter(issue => issue.code === "fallback"
        && issue.source !== "bots/default_c.c").map(issue => issue.source)).toEqual(["bots/missing.c"]);
    }
  });

  test("cached arbitrary skill fallback rereads filename after the missing-skill callback and prints once", () => {
    const { characters, memory, reader, call, load } = fixture({
      report: issue => {
        if (issue.code === "missing-skill" && issue.source === "bots/authored.c") {
          memory.writeString(32, "bots/revised.c", 16);
        }
      },
    });
    load();
    reader.files.set("bots/revised.c", 'skill 1 { 0 "Revised" 2 99 }');
    const revised = characters.load("bots/revised.c", 1);
    reader.files.set("bots/default_c.c", 'skill 1 { 10 "default" }');
    reader.files.set("bots/authored.c", 'skill 1 { 0 "Authored" 2 0.25 }');
    const start = characters.diagnostics.length;
    expect(call(words(500, 32, 0x40800000))).toBe(revised);
    const fallbacks = characters.diagnostics.slice(start).filter(issue => issue.code === "fallback"
      && issue.source !== "bots/default_c.c");
    expect(fallbacks.map(issue => [issue.severity, issue.source, issue.message])).toEqual([
      ["info", "bots/revised.c", "loaded cached skill 1.000000 from bots/revised.c"],
    ]);
  });

  test("cached arbitrary default fallback reads the current filename at its informational diagnostic", () => {
    let missingReads = 0;
    const { characters, memory, reader, call, load } = fixture({
      report: issue => {
        if (issue.code === "missing-source" && issue.source === "bots/missing.c") {
          missingReads++;
          if (missingReads === 2) memory.writeString(32, "bots/revised.c", 16);
        }
      },
    });
    load();
    reader.files.delete("bots/default_c.c");
    memory.writeString(32, "bots/missing.c", 16);
    const start = characters.diagnostics.length;
    expect(call(words(500, 32, 0x40800000))).toBe(1);
    expect(missingReads).toBe(2);
    const fallbacks = characters.diagnostics.slice(start).filter(issue => issue.code === "fallback"
      && issue.source !== "bots/default_c.c");
    expect(fallbacks.map(issue => [issue.severity, issue.source, issue.message])).toEqual([
      ["info", "bots/revised.c", "loaded cached default skill 1.000000 from bots/revised.c"],
    ]);
  });

  test("returns FloatAsInt words, signed integers and truncation through the owner", () => {
    const { call, load } = fixture();
    const handle = load();
    expect(call(words(502, handle, 2))).toBe(0x3e800000);
    expect(call(words(502, handle, 4))).toBe(-1082130432);
    expect(call(words(502, handle, 5))).toBe(0x4b800000);
    expect(call(words(504, handle, 3))).toBe(9);
    expect(call(words(504, handle, 4))).toBe(-1);
    expect(call(words(504, handle, 5))).toBe(16777217);
    expect(call(words(503, handle, 2, 0x3f000000, 0x3f800000))).toBe(0x3f000000);
    expect(call(words(503, handle, 2, 0xc0000000, 0xbf800000))).toBe(-1082130432);
    expect(call(words(505, handle, 3, -4, -2))).toBe(-2);
    expect(call(words(505, handle, 4, -8, 8))).toBe(-1);
  });

  test("preserves invalid handle, index, type and bounds diagnostics and result ordering", () => {
    const { characters, call, load } = fixture({ report: () => undefined });
    const handle = load();
    const start = characters.diagnostics.length;
    expect(call(words(502, -1, 0))).toBe(0);
    expect(call(words(504, handle, -1))).toBe(0);
    expect(call(words(502, handle, 79))).toBe(0);
    expect(call(words(503, handle, 0, 0x3f800000, 0x40000000))).toBe(0x3f800000);
    expect(call(words(505, handle, 0, 1, 2))).toBe(1);
    expect(call(words(503, handle, -1, 0x40000000, 0x3f800000))).toBe(0);
    expect(call(words(505, -1, -1, 2, 1))).toBe(0);
    expect(characters.diagnostics.slice(start).map(item => item.code)).toEqual([
      "invalid-handle", "invalid-index", "uninitialized", "wrong-type", "wrong-type",
      "invalid-bounds", "invalid-handle",
    ]);
  });

  test("writes bounded strings with padding, byte preservation and signed pointer masking", () => {
    const { memory, call, load } = fixture();
    const handle = load();
    expect(call(words(506, handle, 0, -384, 5))).toBe(0);
    expect(Array.from(memory.bytes.subarray(127, 134))).toEqual([165, 65, 117, 116, 104, 0, 165]);
    expect(call(words(506, handle, 6, 144, 4))).toBe(0);
    expect(Array.from(memory.bytes.subarray(143, 149))).toEqual([165, 255, 0, 0, 0, 165]);
    expect(call(words(506, handle, 0, 160, 1))).toBe(0);
    expect(Array.from(memory.bytes.subarray(159, 162))).toEqual([165, 0, 165]);
    expect(call(words(506, handle, 1, 176, 3))).toBe(0);
    expect(Array.from(memory.bytes.subarray(175, 180))).toEqual([165, 0, 0, 0, 165]);
  });

  test("invalid string getters never dereference or clear VM destinations", () => {
    const { characters, memory, call, load } = fixture({ report: () => undefined });
    const handle = load();
    const before = memory.bytes.slice();
    const start = characters.diagnostics.length;
    const invalid: readonly (readonly [number, number])[] = [
      [-1, 0], [handle, -1], [handle, 80], [handle, 79], [handle, 2],
    ];
    for (const [character, index] of invalid) {
      expect(call(words(506, character, index, 0, -1))).toBe(0);
      expect(call(words(506, character, index, 508, 12))).toBe(0);
    }
    expect(memory.bytes).toEqual(before);
    expect(characters.diagnostics.slice(start).map(item => item.code)).toEqual([
      "invalid-handle", "invalid-handle", "invalid-index", "invalid-index", "invalid-index",
      "invalid-index", "uninitialized", "uninitialized", "wrong-type", "wrong-type",
    ]);
  });

  test("valid strings reject invalid destination ranges before mutation", () => {
    const { memory, call, load } = fixture();
    const handle = load();
    const before = memory.bytes.slice();
    expect(() => call(words(506, handle, 0, 0, 8))).toThrow(RangeError);
    expect(() => call(words(506, handle, 1, 128, 0))).toThrow(RangeError);
    expect(() => call(words(506, handle, 1, 128, -1))).toThrow(RangeError);
    expect(() => call(words(506, handle, 0, 508, 8))).toThrow(RangeError);
    expect(memory.bytes).toEqual(before);
  });

  test("free follows the owner's reload gate and shares retirement with typed callers", () => {
    let reload = false;
    const { characters, call, load } = fixture({ reloadCharacters: () => reload, report: () => undefined });
    const handle = load();
    const start = characters.diagnostics.length;
    expect(call(words(501, -1))).toBe(0);
    expect(call(words(501, handle))).toBe(0);
    expect(characters.diagnostics.length).toBe(start);
    expect(characters.string(handle, 0)).toBe("Authored");
    reload = true;
    expect(call(words(501, handle))).toBe(0);
    expect(characters.integer(handle, 3)).toBe(0);
    expect(characters.diagnostics.at(-1)?.code).toBe("invalid-handle");
    characters.shutdown();
    expect(call(words(502, handle, 2))).toBe(0);
  });

  test("captures argument words before source and diagnostic callbacks can replace them", () => {
    let active = words(500, 32, 0x3f800000);
    const { reader, characters, call, load } = fixture({
      report: issue => {
        if (issue.code === "wrong-type") {
          active.setInt32(12, 0x41000000, true);
          active.setInt32(16, 0x41800000, true);
        }
      },
    });
    reader.beforeRead = () => { active.setInt32(8, 0x40a00000, true); };
    const handle = call(active);
    if (handle === null || handle <= 0) throw new Error("Expected authored character handle");
    expect(characters.float(handle, 2)).toBe(0.25);
    reader.beforeRead = () => {};
    expect(load()).toBe(handle);
    active = words(503, handle, 0, 0x3f800000, 0x40000000);
    expect(call(active)).toBe(0x3f800000);
    expect(active.getFloat32(12, true)).toBe(8);
  });

  test("short argument records fail before callbacks and NaN skill remains unsupported", () => {
    const { characters, call, load } = fixture();
    load();
    const start = characters.diagnostics.length;
    for (const trap of [500, 501, 502, 503, 504, 505, 506]) {
      expect(() => call(words(trap))).toThrow(RangeError);
    }
    expect(characters.diagnostics.length).toBe(start);
    expect(() => call(words(500, 32, 0x7fc00000))).toThrow(CharacterError);
  });

  test("bounded float traps preserve infinite and quiet NaN comparison operands", () => {
    const { characters, reader, call, load } = fixture();
    reader.files.set("bots/authored.c", "skill 1 { 2 7.0 }");
    const handle = load(), start = characters.diagnostics.length;
    for (const [minimum, maximum, expected] of [
      [0xff800000, 0x7f800000, 0x40e00000],
      [0, 0x7f800000, 0x40e00000],
      [0x7fc00000, 0x41200000, 0x40e00000],
      [0, 0x7fc00000, 0x40e00000],
      [0x7fc00000, 0x7fc00000, 0x40e00000],
      [0x7fc00000, 0x40a00000, 0x40a00000],
      [0x41100000, 0x7fc00000, 0x41100000],
      [0x7f800000, 0x7f800000, 0x7f800000],
      [0xff800000, 0xff800000, -8388608],
    ] satisfies readonly (readonly [number, number, number])[]) {
      expect(call(words(503, handle, 2, minimum, maximum))).toBe(expected);
    }
    expect(characters.diagnostics.length).toBe(start);
    expect(call(words(503, handle, 2, 0x7f800000, 0xff800000))).toBe(0);
    expect(characters.diagnostics.at(-1)?.code).toBe("invalid-bounds");
    characters.shutdown();
  });
});
