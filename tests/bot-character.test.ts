import { BotScriptSources } from "../src/botlib/script-sources.ts";
import { MemoryBotScriptReader } from "./helpers/bot-script-reader.ts";
import { ScriptGlobalDefines } from "../src/script/preprocessor.ts";
import { allocateScriptSource, ScriptLanguageError } from "../src/script/lexer.ts";
import { SOURCE_TOKEN_BYTES } from "../src/script/token-memory.ts";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import {
  BotCharacterLibrary,
  CharacterError,
  Characteristic,
} from "../src/botlib/character.ts";
import { float32ToBits } from "../src/core/numeric.ts";
import { BotMemory, type BotMemoryAllocation } from "../src/botlib/memory.ts";
import { ZoneArena, ZoneTag } from "../src/core/zone.ts";

class CharacterMemory extends BotMemory {
  readonly allocated: { readonly size: number; readonly clear: boolean; readonly allocation: BotMemoryAllocation }[] = [];
  readonly freed: BotMemoryAllocation[] = [];

  constructor(zone: ZoneArena) { super(undefined, zone); }

  override allocate(size: number, kind: "heap" | "hunk", clear: boolean): BotMemoryAllocation {
    const allocation = super.allocate(size, kind, clear);
    this.allocated.push({ size, clear, allocation });
    return allocation;
  }

  override free(allocation: BotMemoryAllocation): void {
    super.free(allocation);
    this.freed.push(allocation);
  }

  at(index: number): BotMemoryAllocation {
    const record = this.allocated[index];
    if (record === undefined) throw new Error(`Missing character allocation ${index}`);
    return record.allocation;
  }
}

function allocationView(allocation: BotMemoryAllocation): DataView {
  const bytes = allocation.bytes;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const ORACLE_PROVENANCE = Object.freeze({
  sourceCommit: "dbe4ddb10315479fc00086f08e25d968b4b43c49",
  sourceFile: "code/botlib/be_ai_char.c",
  compiler: "gcc (GCC) 16.2.1 20260810",
  command: "gcc -std=c11 -O0 -fexcess-precision=standard -x c -o /tmp/quake3-character-oracle -",
  outputs: "2.125=0x40080000; 0.112499997=0x3de66666; 0.4=0x3ecccccd",
});

const CHARACTER_INDICES = `
#define CHARACTERISTIC_NAME 0
#define CHARACTERISTIC_GENDER 1
#define CHARACTERISTIC_ATTACK_SKILL 2
#define CHARACTERISTIC_VIEW_MAXCHANGE 5
#define CHARACTERISTIC_REACTIONTIME 6
#define CHARACTERISTIC_CHAT_CPM 23
#define CHARACTERISTIC_CHAT_REPLY 35
`;

const DEFAULT_CHARACTER = `
#include "chars.h"
skill 1 {
  CHARACTERISTIC_NAME "Default"
  CHARACTERISTIC_GENDER "it"
  CHARACTERISTIC_ATTACK_SKILL 0.25
  CHARACTERISTIC_VIEW_MAXCHANGE 90
  CHARACTERISTIC_REACTIONTIME 4.0
  CHARACTERISTIC_CHAT_CPM 300
  CHARACTERISTIC_CHAT_REPLY 0.5
}
skill 4 {
  CHARACTERISTIC_NAME "Default"
  CHARACTERISTIC_GENDER "it"
  CHARACTERISTIC_ATTACK_SKILL 0.75
  CHARACTERISTIC_VIEW_MAXCHANGE 240
  CHARACTERISTIC_REACTIONTIME 1.0
  CHARACTERISTIC_CHAT_CPM 300
  CHARACTERISTIC_CHAT_REPLY 0.25
}
skill 5 {
  CHARACTERISTIC_NAME "Default"
  CHARACTERISTIC_GENDER "it"
  CHARACTERISTIC_ATTACK_SKILL 1.0
  CHARACTERISTIC_VIEW_MAXCHANGE 300
  CHARACTERISTIC_REACTIONTIME 0.25
  CHARACTERISTIC_CHAT_CPM 300
  CHARACTERISTIC_CHAT_REPLY 0.125
}
`;

const TEST_CHARACTER = `
#include "chars.h"
skill 1 {
  CHARACTERISTIC_NAME "Test"
  CHARACTERISTIC_ATTACK_SKILL 0.5
  CHARACTERISTIC_VIEW_MAXCHANGE 180
  CHARACTERISTIC_REACTIONTIME 3.5
  CHARACTERISTIC_CHAT_CPM 400
  CHARACTERISTIC_CHAT_REPLY 0.3
}
skill 4 {
  CHARACTERISTIC_NAME "Test"
  CHARACTERISTIC_ATTACK_SKILL 1.0
  CHARACTERISTIC_VIEW_MAXCHANGE 280
  CHARACTERISTIC_REACTIONTIME 0.75
  CHARACTERISTIC_CHAT_CPM 500
  CHARACTERISTIC_CHAT_REPLY 0.125
}
skill 5 {
  CHARACTERISTIC_NAME "Test"
  CHARACTERISTIC_ATTACK_SKILL 1.0
  CHARACTERISTIC_VIEW_MAXCHANGE 320
  CHARACTERISTIC_REACTIONTIME 0.0
  CHARACTERISTIC_CHAT_CPM 600
  CHARACTERISTIC_CHAT_REPLY 0.1
}
`;

function assets(extra: ReadonlyMap<string, string> = new Map<string, string>()): MemoryBotScriptReader {
  return new MemoryBotScriptReader(new Map([
    ["chars.h", CHARACTER_INDICES],
    ["bots/default_c.c", DEFAULT_CHARACTER],
    ["bots/test_c.c", TEST_CHARACTER],
    ...extra,
  ]));
}

describe("bot character profiles", () => {
  test("characteristic strings allocate and retain source bytes without UTF-8 conversion", () => {
    const zone = new ZoneArena(16384), memory = new CharacterMemory(zone);
    const reader = new MemoryBotScriptReader(new Map([
      ["bots/default_c.c", "skill 1 {}"], ["bots/source.c", 'skill 1 { 0 "\xff" }'],
    ]));
    const library = new BotCharacterLibrary(reader, { memory });
    const handle = library.load("bots/source.c", 1);
    expect(library.string(handle, 0)).toBe("\xff");
    const string = memory.allocated.find(item => item.size === 2);
    if (string === undefined) throw new Error("missing two-byte source string allocation");
    expect(Array.from(string.allocation.bytes)).toEqual([255, 0]);
    string.allocation.bytes[0] = 128;
    expect(library.string(handle, 0)).toBe("\x80");
    library.shutdown(); zone.dispose();
  });

  for (const ending of ["}", "", "0 5", "#error rejected"]) {
    test(`frees loaded source before profile cleanup, including selected EOF: ${ending}`, () => {
      const zone = new ZoneArena(16384);
      const memory = new CharacterMemory(zone);
      const text = `skill 1 { 0 "kept" 2 0.5\n${ending}`;
      const library = new BotCharacterLibrary({
        globals: new ScriptGlobalDefines(),
        resolve: () => undefined,
        resolveRoot: path => {
          if (path === "bots/default_c.c") return { path, text: "skill 1 {}" };
          if (path !== "bots/source.c") return undefined;
          const source = allocateScriptSource(text.length, path, memory);
          source.copyText(text);
          return source;
        },
      }, { memory });
      const loaded = ending === "}" || ending === "" || ending === "#error rejected";
      expect(library.load("bots/source.c", 1)).toBe(loaded ? 2 : 1);
      expect(memory.allocated.map(item => item.size)).toEqual([716, 2148 + text.length + 1, 1024, 3144, 4096, 716, SOURCE_TOKEN_BYTES, 5]);
      const sourceFrees = [memory.at(6), memory.at(2), memory.at(1), memory.at(4), memory.at(3)];
      expect(memory.freed).toEqual(loaded ? sourceFrees : [...sourceFrees, memory.at(7), memory.at(5)]);
      expect(() => memory.at(1).bytes).toThrow();
      expect(() => memory.at(2).bytes).toThrow();
      if (loaded) expect(library.string(2, 0)).toBe("kept");
      library.shutdown();
      expect(zone.memoryRemaining()).toBe(16384);
      zone.dispose();
    });
  }

  test("releases a still-active include before its root and retains both when a diagnostic callback throws", () => {
    for (const abort of [false, true]) {
      const zone = new ZoneArena(32768);
      const memory = new CharacterMemory(zone);
      const rootText = 'skill 1 {\n#include "values.h"\n}';
      const includeText = abort ? '0 "kept" 0 5' : '0 "kept" }';
      const library = new BotCharacterLibrary({
        globals: new ScriptGlobalDefines(),
        resolveRoot: path => {
          if (path === "bots/default_c.c") return { path, text: "skill 1 {}" };
          if (path !== "bots/source.c") return undefined;
          const source = allocateScriptSource(rootText.length, path, memory);
          source.copyText(rootText);
          return source;
        },
        resolve: request => {
          if (request.requestedPath !== "values.h") return undefined;
          const source = allocateScriptSource(includeText.length, request.requestedPath, memory);
          source.copyText(includeText);
          return source;
        },
      }, { memory, report: issue => {
        if (abort && issue.code === "parse-error") throw new Error("diagnostic abort");
      } });
      if (abort) {
        expect(() => library.load("bots/source.c", 1)).toThrow("diagnostic abort");
        expect(memory.allocated.map(item => item.size)).toEqual([
          716, 2148 + rootText.length + 1, 1024, 3144, 4096, 716,
          2148 + includeText.length + 1, 1024, SOURCE_TOKEN_BYTES, 5,
        ]);
        expect(memory.freed).toEqual([memory.at(8)]);
        expect(memory.at(1).bytes).toHaveLength(2148 + rootText.length + 1);
        expect(memory.at(6).bytes).toHaveLength(2148 + includeText.length + 1);
        expect(memory.at(5).bytes).toHaveLength(716);
        expect(memory.at(9).bytes).toEqual(new Uint8Array([107, 101, 112, 116, 0]));
        library.shutdown();
        expect(memory.freed).toEqual([memory.at(8), memory.at(0)]);
      } else {
        expect(library.load("bots/source.c", 1)).toBe(2);
        expect(memory.allocated.map(item => item.size)).toEqual([
          716, 2148 + rootText.length + 1, 1024, 3144, 4096, 716,
          2148 + includeText.length + 1, 1024, SOURCE_TOKEN_BYTES, 5,
        ]);
        expect(memory.freed).toEqual([memory.at(8), memory.at(7), memory.at(6), memory.at(2), memory.at(1), memory.at(4), memory.at(3)]);
        expect(library.string(2, 0)).toBe("kept");
        library.shutdown();
        expect(zone.memoryRemaining()).toBe(32768);
      }
      zone.dispose();
    }
  });

  test("callback ScriptLanguageError preserves its identity and allocated source residue", () => {
    for (const boundary of ["character diagnostic", "lexer diagnostic", "include resolver"]) {
      const zone = new ZoneArena(32768);
      const memory = new CharacterMemory(zone);
      const rootText = 'skill 1 {\n#include "values.h"\n}';
      const includeText = boundary === "lexer diagnostic" ? '0 "kept" 2 0.5 "unterminated' : '0 "kept" 0 5';
      const failure = new ScriptLanguageError({
        severity: "error", message: "host callback aborted",
        location: { path: "<host>", line: 1, column: 1 },
      }, []);
      const library = new BotCharacterLibrary({
        globals: new ScriptGlobalDefines(),
        resolveRoot: path => {
          if (path === "bots/default_c.c") return { path, text: "skill 1 {}" };
          if (path !== "bots/source.c") return undefined;
          const source = allocateScriptSource(rootText.length, path, memory);
          source.copyText(rootText);
          return source;
        },
        resolve: request => {
          if (request.requestedPath !== "values.h") return undefined;
          const source = allocateScriptSource(includeText.length, request.requestedPath, memory);
          source.copyText(includeText);
          if (boundary === "include resolver") throw failure;
          return source;
        },
      }, { memory, report: issue => {
        if (issue.code === "parse-error") throw failure;
      } });
      let caught: unknown;
      try { library.load("bots/source.c", 1); }
      catch (error) { caught = error; }
      expect(caught).toBe(failure);
      const tokenFrees = boundary === "include resolver" ? [] : [memory.at(8)];
      expect(memory.allocated.map(item => item.size)).toEqual([
        716, 2148 + rootText.length + 1, 1024, 3144, 4096, 716,
        2148 + includeText.length + 1, 1024,
        ...(boundary === "include resolver" ? [] : [SOURCE_TOKEN_BYTES, 5]),
      ]);
      expect(memory.freed).toEqual(tokenFrees);
      expect(memory.at(1).bytes).toHaveLength(2148 + rootText.length + 1);
      expect(memory.at(2).bytes).toHaveLength(1024);
      expect(memory.at(3).bytes).toHaveLength(3144);
      expect(memory.at(4).bytes).toHaveLength(4096);
      expect(memory.at(5).bytes).toHaveLength(716);
      expect(memory.at(6).bytes).toHaveLength(2148 + includeText.length + 1);
      expect(memory.at(7).bytes).toHaveLength(1024);
      if (boundary !== "include resolver") {
        expect(memory.at(9).bytes).toEqual(new Uint8Array([107, 101, 112, 116, 0]));
      }
      library.shutdown();
      expect(memory.freed).toEqual([...tokenFrees, memory.at(0)]);
      zone.dispose();
    }
  });

  test("getters and cache consume the actual release32 profile and string bytes in the zone", () => {
    const zone = new ZoneArena(8192);
    const memory = new CharacterMemory(zone);
    const reader = new MemoryBotScriptReader(new Map([
      ["bots/default_c.c", "skill 1 {} skill 4 {}"],
      ["bots/raw.c", 'skill 1 { 0 "Low" 2 0.25 5 90 }'],
    ]));
    let reload = false;
    const library = new BotCharacterLibrary(reader, { memory, reloadCharacters: () => reload });
    const handle = library.load("bots/raw.c", 1);
    const profile = memory.at(1);
    const string = memory.at(2);
    const bytes = profile.bytes;
    const view = allocationView(profile);
    expect(memory.allocated.map(item => [item.size, item.clear])).toEqual([[716, true], [716, true], [4, false]]);
    const header = new DataView(bytes.buffer, bytes.byteOffset - 24, 24);
    expect(header.getInt32(0, true)).toBe(744);
    expect(header.getInt32(4, true)).toBe(ZoneTag.Botlib);
    expect(header.getUint32(20, true)).toBe(0x12345678);
    expect(zone.memoryRemaining()).toBe(8192 - 744 * 2 - 32);
    expect(view.getFloat32(64, true)).toBe(1);
    expect(view.getUint8(68)).toBe(3);
    expect(view.getUint32(72, true)).toBeGreaterThan(0);
    expect(view.getUint8(84)).toBe(2);
    expect(view.getFloat32(88, true)).toBe(0.25);
    expect(view.getUint8(108)).toBe(1);
    expect(view.getInt32(112, true)).toBe(90);
    expect(bytes.subarray(69, 72)).toEqual(new Uint8Array(3));
    expect(bytes.subarray(116)).toEqual(new Uint8Array(600));
    view.setFloat32(88, 0.625, true);
    view.setInt32(112, -37, true);
    string.bytes.set(new TextEncoder().encode("New"));
    expect(library.float(handle, 2)).toBe(0.625);
    expect(library.integer(handle, 5)).toBe(-37);
    expect(library.string(handle, 0)).toBe("New");
    expect(library.load("bots/raw.c", 1)).toBe(handle);
    expect(memory.allocated).toHaveLength(3);

    bytes.set(new TextEncoder().encode("bots/new.c\0"));
    view.setFloat32(64, 4, true);
    expect(library.load("bots/new.c", 4)).toBe(handle);
    expect(reader.reads).not.toContain("bots/new.c");
    reload = true;
    library.free(handle);
    expect(memory.freed).toEqual([string, profile]);
    expect(() => profile.bytes).toThrow();
    expect(() => string.bytes).toThrow();
    expect(bytes).toEqual(new Uint8Array(716).fill(0xaa));
    library.shutdown();
    expect(zone.memoryRemaining()).toBe(8192);
    const fresh = library.load("bots/raw.c", 1);
    const freshProfile = memory.at(5);
    expect(fresh).toBe(handle);
    expect(freshProfile.bytes.byteOffset).toBe(bytes.byteOffset);
    expect(freshProfile.bytes.buffer).toBe(bytes.buffer);
    expect(freshProfile.bytes.subarray(116)).toEqual(new Uint8Array(600));
    expect(library.integer(fresh, 5)).toBe(90);
    library.shutdown();
    zone.dispose();
  });

  test("default and interpolated strings have independent heap allocations", () => {
    const zone = new ZoneArena(16384);
    const memory = new CharacterMemory(zone);
    const library = new BotCharacterLibrary(new MemoryBotScriptReader(new Map([
      ["bots/default_c.c", 'skill 1 { 1 "Base" } skill 4 { 1 "Base" }'],
      ["bots/copy.c", 'skill 1 { 0 "Low" 2 0.25 5 90 } skill 4 { 0 "High" 2 0.75 5 180 }'],
    ])), { memory, reloadCharacters: () => true });
    const middle = library.load("bots/copy.c", 2.5);
    expect(memory.allocated.map(item => item.size)).toEqual([716, 5, 716, 4, 5, 716, 5, 716, 5, 5, 716, 4, 5]);
    const lower = 2;
    const upper = 4;
    memory.at(1).bytes[0] = "X".charCodeAt(0);
    memory.at(3).bytes.set(new TextEncoder().encode("New"));
    expect(library.string(lower, 0)).toBe("New");
    expect(library.string(lower, 1)).toBe("Base");
    expect(library.string(upper, 0)).toBe("High");
    expect(library.string(middle, 0)).toBe("Low");
    expect(library.string(middle, 1)).toBe("Base");
    expect(library.float(middle, 2)).toBe(0.5);
    expect(library.integer(middle, 5)).toBe(90);
    const lowerPointer = allocationView(memory.at(2)).getUint32(72, true);
    const outputPointer = allocationView(memory.at(10)).getUint32(72, true);
    expect(outputPointer).not.toBe(lowerPointer);
    library.free(middle);
    expect(memory.freed).toEqual([memory.at(11), memory.at(12), memory.at(10)]);
    expect(library.string(lower, 0)).toBe("New");
    library.shutdown();
    expect(zone.memoryRemaining()).toBe(16384);
    zone.dispose();
  });

  test("reached includes observe allocated fields before parse failure frees strings then profile", () => {
    const zone = new ZoneArena(8192);
    const memory = new CharacterMemory(zone);
    const reader = new MemoryBotScriptReader(new Map([
      ["bots/default_c.c", "skill 1 {}"],
      ["bots/broken.c", 'skill 1 { 0 "kept" 2 1.5\n#include "bad.h"\n}'],
      ["bad.h", "0 3"],
    ]));
    let observed = false;
    reader.beforeRead = path => {
      if (path !== "bad.h") return;
      observed = true;
      expect(memory.allocated.map(item => item.size)).toEqual([716, 716, 5]);
      expect(allocationView(memory.at(1)).getFloat32(88, true)).toBe(1.5);
      expect(memory.at(2).bytes).toEqual(new TextEncoder().encode("kept\0"));
      expect(memory.freed).toHaveLength(0);
    };
    const library = new BotCharacterLibrary(reader, { memory, report: issue => {
      if (issue.code !== "parse-error") return;
      expect(memory.freed).toHaveLength(0);
      expect(memory.at(2).bytes).toEqual(new TextEncoder().encode("kept\0"));
    } });
    expect(library.load("bots/broken.c", 1)).toBe(1);
    expect(observed).toBe(true);
    expect(memory.freed).toEqual([memory.at(2), memory.at(1)]);
    expect(zone.memoryRemaining()).toBe(8192 - 744);
    library.shutdown();
    expect(zone.memoryRemaining()).toBe(8192);
    zone.dispose();
  });

  test("stops reading after the selected block and preserves source index 80 string leak", () => {
    const zone = new ZoneArena(8192);
    const memory = new CharacterMemory(zone);
    const reader = new MemoryBotScriptReader(new Map([
      ["bots/default_c.c", "skill 1 {}"],
      ["bots/edge.c", 'skill 1 { 80 "tail" }\n#include "unreached.h"'],
    ]));
    const library = new BotCharacterLibrary(reader, { memory });
    expect(library.load("bots/edge.c", 1)).toBe(2);
    expect(reader.reads).not.toContain("unreached.h");
    expect(allocationView(memory.at(1)).getUint8(708)).toBe(3);
    expect(allocationView(memory.at(1)).getUint32(712, true)).toBeGreaterThan(0);
    library.shutdown();
    expect(memory.freed).toEqual([memory.at(0), memory.at(1)]);
    expect(memory.at(2).bytes).toEqual(new TextEncoder().encode("tail\0"));
    expect(zone.memoryRemaining()).toBe(8192 - 36);
    zone.dispose();
  });

  test("string allocation failure retains reached profile bytes without unwinding the source abort", () => {
    const zone = new ZoneArena(32 + 744 * 2);
    const memory = new CharacterMemory(zone);
    const library = new BotCharacterLibrary(new MemoryBotScriptReader(new Map([
      ["bots/default_c.c", "skill 1 {}"],
      ["bots/failure.c", 'skill 1 { 2 0.625 0 "no room" }'],
    ])), { memory });
    expect(() => library.load("bots/failure.c", 1)).toThrow("Z_Malloc: failed");
    expect(memory.allocated.map(item => item.size)).toEqual([716, 716]);
    expect(memory.freed).toHaveLength(0);
    expect(allocationView(memory.at(1)).getFloat32(88, true)).toBe(0.625);
    expect(allocationView(memory.at(1)).getUint8(68)).toBe(0);
    library.shutdown();
    expect(memory.freed).toEqual([memory.at(0)]);
    expect(memory.at(1).bytes).toHaveLength(716);
    zone.dispose();
  });

  test("include reentry frees the retired pending profile without freeing the replacement", () => {
    const zone = new ZoneArena(8192);
    const memory = new CharacterMemory(zone);
    const reader = new MemoryBotScriptReader(new Map([
      ["bots/default_c.c", "skill 1 {}"],
      ["bots/reentry.c", 'skill 1 { 0 "live" 2 0.5\n#include "value.h"\n}'],
      ["value.h", "5 90"],
    ]));
    const library = new BotCharacterLibrary(reader, { memory });
    let fresh = 0;
    reader.beforeRead = path => {
      if (path !== "value.h") return;
      reader.beforeRead = () => {};
      expect(memory.allocated.map(item => item.size)).toEqual([716, 716, 5]);
      library.shutdown();
      fresh = library.load("bots/reentry.c", 1);
    };
    expect(library.load("bots/reentry.c", 1)).toBe(0);
    expect(fresh).toBe(2);
    expect(memory.freed).toEqual([memory.at(0), memory.at(2), memory.at(1)]);
    expect(() => memory.at(1).bytes).toThrow();
    expect(() => memory.at(2).bytes).toThrow();
    expect(library.string(fresh, 0)).toBe("live");
    expect(library.float(fresh, 2)).toBe(0.5);
    expect(library.integer(fresh, 5)).toBe(90);
    expect(zone.memoryRemaining()).toBe(8192 - 744 * 2 - 36);
    library.shutdown();
    expect(zone.memoryRemaining()).toBe(8192);
    zone.dispose();
  });

  test("selected-block EOF reports an error but retains complete fields, while missing values free the profile", () => {
    const zone = new ZoneArena(8192);
    const memory = new CharacterMemory(zone);
    const library = new BotCharacterLibrary(new MemoryBotScriptReader(new Map([
      ["bots/default_c.c", "skill 1 {}"],
      ["bots/eof.c", 'skill 1 { 0 "kept" 2 0.625'],
      ["bots/missing-value.c", 'skill 1 { 0 "discard" 2'],
    ])), { memory });
    const handle = library.load("bots/eof.c", 1);
    expect(handle).toBe(2);
    expect(library.string(handle, 0)).toBe("kept");
    expect(library.float(handle, 2)).toBe(0.625);
    expect(library.diagnostics.filter(item => item.code === "parse-error").map(item => item.message))
      .toEqual(["couldn't read expected token"]);
    expect(memory.freed).toHaveLength(0);
    expect(library.load("bots/missing-value.c", 1)).toBe(1);
    expect(memory.freed).toEqual([memory.at(4), memory.at(3)]);
    expect(library.string(handle, 0)).toBe("kept");
    library.shutdown();
    expect(zone.memoryRemaining()).toBe(8192);
    zone.dispose();
  });

  test("filename callback replacement cannot dereference a freed cached profile", () => {
    const zone = new ZoneArena(8192);
    const memory = new CharacterMemory(zone);
    const library = new BotCharacterLibrary(new MemoryBotScriptReader(new Map([
      ["bots/default_c.c", "skill 1 {}"],
      ["bots/reentry.c", 'skill 1 { 0 "live" }'],
    ])), { memory });
    library.load("bots/reentry.c", 1);
    let replaced = false, fresh = 0;
    const retired = library.load(() => {
      if (!replaced) {
        replaced = true;
        library.shutdown();
        fresh = library.load("bots/reentry.c", 1);
      }
      return "bots/reentry.c";
    }, 1);
    expect(retired).toBe(0);
    expect(library.string(fresh, 0)).toBe("live");
    library.shutdown();
    expect(zone.memoryRemaining()).toBe(8192);
    zone.dispose();
  });

  test("loads skill 1, 4 and 5, fills defaults and caches exact profiles", async () => {
    const library = new BotCharacterLibrary(assets());
    const skill1 = await library.load("bots/test_c.c", 1);
    const skill4 = await library.load("bots/test_c.c", 4);
    const skill5 = await library.load("bots/test_c.c", 5);

    expect(Characteristic.Name).toBe(0);
    expect(Characteristic.ChatCpm).toBe(23);
    expect(Characteristic.Walker).toBe(48);
    expect(skill1).toBeGreaterThan(0);
    expect(skill4).toBeGreaterThan(0);
    expect(skill5).toBeGreaterThan(0);
    expect(library.string(skill1, Characteristic.Name)).toBe("Test");
    expect(library.string(skill1, Characteristic.Gender)).toBe("it");
    expect(library.float(skill1, Characteristic.AttackSkill)).toBe(0.5);
    expect(library.float(skill1, Characteristic.ViewMaxChange)).toBe(180);
    expect(library.integer(skill1, Characteristic.ReactionTime)).toBe(3);
    expect(library.integer(skill1, Characteristic.ChatCpm)).toBe(400);
    expect(await library.load("bots/test_c.c", 1)).toBe(skill1);
  });

  test("matches the native source oracle for interpolation, integer carry and clamps", async () => {
    const library = new BotCharacterLibrary(assets());
    const low = await library.load("bots/test_c.c", 2.5);
    const high = await library.load("bots/test_c.c", 4.5);

    expect(ORACLE_PROVENANCE.sourceCommit).toHaveLength(40);
    expect(float32ToBits(library.float(low, Characteristic.ReactionTime))).toBe(0x40080000);
    expect(float32ToBits(library.float(high, Characteristic.ChatReply))).toBe(0x3de66666);
    expect(library.integer(low, Characteristic.ViewMaxChange)).toBe(180);
    expect(library.integer(high, Characteristic.ViewMaxChange)).toBe(280);
    expect(float32ToBits(library.boundedFloat(await library.load("bots/test_c.c", 1), Characteristic.ChatReply, 0.4, 1)))
      .toBe(0x3ecccccd);
    expect(library.boundedInteger(low, Characteristic.ChatCpm, 1, 350)).toBe(350);
    expect(library.float(await library.load("bots/test_c.c", -2), Characteristic.AttackSkill)).toBe(0.5);
    expect(library.integer(await library.load("bots/test_c.c", 9), Characteristic.ChatCpm)).toBe(600);
  });

  test("leaves a lower float uninitialized when the upper interpolation type differs", async () => {
    const mismatched = `
      #include "chars.h"
      skill 1 {
        CHARACTERISTIC_NAME "Mismatch"
        CHARACTERISTIC_ATTACK_SKILL 0.2
      }
      skill 4 {
        CHARACTERISTIC_NAME "Mismatch"
        CHARACTERISTIC_ATTACK_SKILL "not a float"
      }
      skill 5 {
        CHARACTERISTIC_NAME "Mismatch"
        CHARACTERISTIC_ATTACK_SKILL 1.0
      }
    `;
    const library = new BotCharacterLibrary(assets(new Map([
      ["bots/mismatched_c.c", mismatched],
    ])));
    const handle = await library.load("bots/mismatched_c.c", 2.5);

    expect(library.float(handle, Characteristic.AttackSkill)).toBe(0);
    expect(library.diagnostics.some(item => item.code === "uninitialized"
      && item.message.includes(`characteristic ${Characteristic.AttackSkill}`))).toBe(true);
  });

  test("accepts source loader index 80 although public getters reject it", async () => {
    const index80 = `
      #include "chars.h"
      skill 1 {
        CHARACTERISTIC_NAME "Index Eighty"
        80 7
      }
    `;
    const library = new BotCharacterLibrary(assets(new Map([
      ["bots/index80_c.c", index80],
    ])));
    const handle = await library.load("bots/index80_c.c", 1);

    expect(library.string(handle, Characteristic.Name)).toBe("Index Eighty");
    expect(library.integer(handle, 80)).toBe(0);
    expect(library.diagnostics.some(item => item.code === "parse-error")).toBe(false);
    expect(library.diagnostics.some(item => item.code === "invalid-index" && item.message.includes("80"))).toBe(true);
  });

  test("preserves logged zero and empty-string behavior for invalid getter calls", async () => {
    const library = new BotCharacterLibrary(assets());
    const handle = await library.load("bots/test_c.c", 1);

    expect(library.float(handle, Characteristic.Name)).toBe(0);
    expect(library.string(handle, Characteristic.AttackSkill)).toBe("");
    expect(library.integer(handle, 79)).toBe(0);
    expect(library.float(0, Characteristic.AttackSkill)).toBe(0);
    expect(library.string(999, Characteristic.Name)).toBe("");
    expect(library.boundedFloat(handle, Characteristic.AttackSkill, 2, 1)).toBe(0);
    expect(library.boundedInteger(handle, Characteristic.ChatCpm, 500, 100)).toBe(0);
    expect(library.boundedFloat(handle, Characteristic.Name, 1, 2)).toBe(1);
    expect(library.boundedInteger(handle, Characteristic.Name, 1, 2)).toBe(1);
    const codes = library.diagnostics.map(item => item.code);
    expect(codes).toContain("wrong-type");
    expect(codes).toContain("uninitialized");
    expect(codes).toContain("invalid-handle");
    expect(codes).toContain("invalid-bounds");
    expect(library.diagnostics.some(item => item.code === "invalid-handle" && item.severity === "fatal")).toBe(true);
  });

  test("falls back for missing or rejected characters and reports structured causes", async () => {
    const duplicate = `
      #include "chars.h"
      skill 1 {
        CHARACTERISTIC_NAME "Broken"
        CHARACTERISTIC_NAME "Duplicate"
      }
    `;
    const library = new BotCharacterLibrary(assets(new Map([
      ["bots/duplicate_c.c", duplicate],
    ])));

    const duplicateHandle = await library.load("bots/duplicate_c.c", 1);
    expect(library.string(duplicateHandle, Characteristic.Name)).toBe("Default");
    const missingHandle = await library.load("bots/missing_c.c", 4);
    expect(library.string(missingHandle, Characteristic.Name)).toBe("Default");
    expect(library.diagnostics.some(item => item.code === "parse-error" && item.location !== null)).toBe(true);
    expect(library.diagnostics.some(item => item.code === "missing-source" && item.source === "bots/missing_c.c")).toBe(true);
    expect(library.diagnostics.some(item => item.code === "fallback")).toBe(true);

    const unavailable = new BotCharacterLibrary(new MemoryBotScriptReader(new Map<string, string>()));
    expect(await unavailable.load("bots/missing_c.c", 1)).toBe(0);
    expect(unavailable.diagnostics.some(item => item.code === "fallback")).toBe(true);
    expect(library.load("../unsafe.c", 1)).toBe(duplicateHandle);
    expect(() => library.load("bots/test_c.c", Number.NaN)).toThrow(CharacterError);
  });

  test("missing empty and overlong filenames reach source lookup and default fallback", () => {
    for (const filename of ["", "x".repeat(70)]) {
      const opened: string[] = [];
      const library = new BotCharacterLibrary({
        globals: new ScriptGlobalDefines(),
        resolve: () => undefined,
        resolveRoot: path => {
          opened.push(path);
          return path === "bots/default_c.c" ? { path, text: "skill 1 { 2 7 }" } : undefined;
        },
      });
      expect(library.load(filename, 1)).toBe(1);
      expect(opened).toEqual(["bots/default_c.c", filename]);
      expect(library.float(1, 2)).toBe(7);
      expect(library.diagnostics.map(issue => issue.code))
        .toEqual(["loaded", "missing-source", "missing-skill", "fallback"]);
      expect(library.diagnostics.slice(1).every(issue => issue.source === filename)).toBe(true);
      library.shutdown();
    }
  });

  test("successful source opens check filename capacity at the reached destination copy", () => {
    for (const length of [63, 64, 70]) {
      const filename = "x".repeat(length), opened: string[] = [];
      const library = new BotCharacterLibrary({
        globals: new ScriptGlobalDefines(),
        resolve: () => undefined,
        resolveRoot: path => {
          opened.push(path);
          return { path, text: "skill 1 { 2 7 }" };
        },
      });
      if (length < 64) {
        const handle = library.load(filename, 1);
        expect(handle).toBe(2);
        expect(library.float(handle, 2)).toBe(7);
        expect(library.load(filename, 1)).toBe(handle);
      } else {
        expect(() => library.load(filename, 1)).toThrow(CharacterError);
        expect(library.diagnostics.at(-1)?.code).toBe("invalid-input");
        expect(library.diagnostics.at(-1)?.message).toContain("destination");
      }
      expect(opened).toEqual(["bots/default_c.c", filename]);
      library.shutdown();
    }
  });

  test("free observes reload policy, reuses handles, and shutdown always clears", async () => {
    let reload = true;
    const library = new BotCharacterLibrary(assets(), { reloadCharacters: () => reload });
    const first = await library.load("bots/test_c.c", 1);
    library.free(first);
    const reused = await library.load("bots/test_c.c", 1);
    expect(reused).toBe(first);

    reload = false;
    library.free(reused);
    expect(await library.load("bots/test_c.c", 1)).toBe(reused);
    library.shutdown();
    expect(library.string(reused, Characteristic.Name)).toBe("");
    expect(await library.load("bots/test_c.c", 1)).toBe(first);
  });

  test("completes first-use reads before return and immediately shares cached profiles", () => {
    const reader = new MemoryBotScriptReader(new Map([
      ["chars.h", CHARACTER_INDICES],
      ["bots/default_c.c", DEFAULT_CHARACTER],
      ["bots/test_c.c", TEST_CHARACTER],
      ["bots/other_c.c", TEST_CHARACTER.replaceAll('"Test"', '"Other"')],
    ]));
    const library = new BotCharacterLibrary(reader);
    const first = library.load("bots/test_c.c", 1);
    expect(first).toBeGreaterThan(0);
    expect(reader.reads.filter(path => path === "bots/test_c.c").length).toBe(1);
    expect(library.load("bots/test_c.c", 1)).toBe(first);
    const other = library.load("bots/other_c.c", 1);
    expect(other).not.toBe(first);
    expect(library.string(first, Characteristic.Name)).toBe("Test");
    expect(library.string(other, Characteristic.Name)).toBe("Other");
    expect(reader.reads.filter(path => path === "bots/default_c.c").length).toBe(1);
    expect(reader.reads.filter(path => path === "bots/test_c.c").length).toBe(1);
    expect(reader.reads.filter(path => path === "bots/other_c.c").length).toBe(1);
  });

  for (const boundary of ["bots/default_c.c", "chars.h"]) {
    test("synchronous source reentry cannot publish into a replacement owner: " + boundary, () => {
      const reader = new MemoryBotScriptReader(new Map([
        ["chars.h", CHARACTER_INDICES],
        ["bots/default_c.c", DEFAULT_CHARACTER],
        ["bots/test_c.c", TEST_CHARACTER],
      ]));
      const library = new BotCharacterLibrary(reader);
      let fresh = 0;
      reader.beforeRead = path => {
        if (path !== boundary) return;
        reader.beforeRead = () => {};
        library.shutdown();
        fresh = library.load("bots/test_c.c", 1);
      };
      expect(library.load("bots/test_c.c", 1)).toBe(0);
      expect(fresh).toBeGreaterThan(0);
      expect(library.string(fresh, Characteristic.Name)).toBe("Test");
      expect(library.diagnostics.filter(issue => issue.code === "parse-error")).toEqual([]);
    });
  }

  for (const malformed of ["broken", '#include "missing-stale-include.h"\nskill 1 { 0 "stale" }']) {
    test("source replacement before parsing does not publish retired diagnostics: " + malformed, () => {
      const reader = new MemoryBotScriptReader(new Map([
        ["chars.h", CHARACTER_INDICES],
        ["bots/default_c.c", DEFAULT_CHARACTER],
        ["bots/test_c.c", TEST_CHARACTER],
      ]));
      const sources = reader;
      const library = new BotCharacterLibrary({ globals: sources.globals, resolve: request => sources.resolve(request), resolveRoot: path => {
        const source = sources.resolveRoot(path);
        if (path !== "bots/default_c.c" || replaced) return source;
        replaced = true;
        library.shutdown();
        fresh = library.load("bots/test_c.c", 1);
        return { path, text: malformed };
      } });
      let replaced = false, fresh = 0;
      expect(library.load("bots/test_c.c", 1)).toBe(0);
      expect(fresh).toBeGreaterThan(0);
      expect(library.string(fresh, Characteristic.Name)).toBe("Test");
      expect(library.diagnostics.filter(issue => issue.code === "parse-error")).toEqual([]);
      expect(library.diagnostics.filter(issue => issue.severity === "warning")).toEqual([]);
      expect(library.diagnostics.filter(issue => issue.code === "loaded")).toHaveLength(2);
    });
  }

});

const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retailAvailable = existsSync(join(retailRoot, "baseq3", "pak0.pk3"))
  && existsSync(join(retailRoot, "missionpack", "pak0.pk3"));

test.skipIf(!retailAvailable)("loads every retail character at source-required skills through both product VFS views", async () => {
  let count = 0;
  for (const product of ["baseq3", "missionpack"] satisfies readonly ("baseq3" | "missionpack")[]) {
    const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product });
    const paths = vfs.list("botfiles/bots/").filter(path => path.endsWith("_c.c"));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const library = new BotCharacterLibrary(new BotScriptSources(vfs, new ScriptGlobalDefines(), (_severity, text) => { throw new Error(text); }, (_text: string): undefined => undefined));
      const filename = path.slice("botfiles/".length);
      for (const skill of [1, 4, 5]) {
        const handle = await library.load(filename, skill);
        expect(handle).toBeGreaterThan(0);
        expect(library.string(handle, Characteristic.Name).length).toBeGreaterThan(0);
      }
      expect(library.diagnostics.some(item => item.severity === "error")).toBe(false);
      count++;
    }
  }
  expect(count).toBeGreaterThan(0);
}, 60_000);
