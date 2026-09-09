import { expect, test } from "bun:test";
import { BotCharacterLibrary, Characteristic } from "../src/botlib/character.ts";
import { BotChatLibrary } from "../src/botlib/chat.ts";
import { WeightConfigStore, type WeightConfig } from "../src/botlib/weights.ts";
import type { BotScriptReader } from "../src/botlib/script-sources.ts";
import { ScriptGlobalDefines, type IncludeRequest, type ScriptSource } from "../src/script/preprocessor.ts";

type Boundary = "root" | "include";
class ReentrantScripts implements BotScriptReader {
  readonly globals = new ScriptGlobalDefines();
  readonly files = new Map<string, string>();
  beforeReturn: (path: string) => void = () => {};
  resolveRoot(path: string): ScriptSource | undefined {
    const text = this.files.get(path);
    this.beforeReturn(path);
    return text === undefined ? undefined : { path, text };
  }
  resolve(request: IncludeRequest): ScriptSource | undefined { return this.resolveRoot(request.requestedPath); }
  outer(boundary: Boundary, text: string): string {
    this.files.set("outer.c", boundary === "root" ? text : '#include "outer.inc"');
    this.files.set("outer.inc", text);
    return boundary === "root" ? "outer.c" : "outer.inc";
  }
  once(path: string, enter: () => void): void {
    this.beforeReturn = actual => {
      if (actual !== path) return;
      this.beforeReturn = () => {};
      enter();
    };
  }
}
const chatHost = { time: () => 0, random: { nextInt: () => 0 }, *clientCommand(): ReturnType<BotChatLibrary["enterChatCalls"]> {} };
const chatText = 'chat "bot" { type "hello" { "first"; "last"; } }';
const weightText = 'weight "w" return 1;';

for (const boundary of ["root", "include"] satisfies readonly Boundary[]) {
  for (const reload of [false, true]) {
    test(`chat ${boundary} reentry publishes separate cooldown lists with reload=${reload}`, () => {
      const scripts = new ReentrantScripts(), target = scripts.outer(boundary, chatText);
      const chat = new BotChatLibrary(scripts, chatHost, { reloadCharacters: () => reload });
      const first = chat.allocate(), second = chat.allocate();
      scripts.once(target, () => { expect(chat.loadChatFile(second, "outer.c", "bot")).toBe(true); });
      expect(chat.loadChatFile(first, "outer.c", "bot")).toBe(true);
      chat.initialChat(second, "hello", 0); chat.initialChat(first, "hello", 0);
      expect(chat.getChatMessage(second)).toBe("last");
      expect(chat.getChatMessage(first)).toBe("last");
    });

    test(`chat ${boundary} reentry respects capacity with reload=${reload}`, () => {
      const scripts = new ReentrantScripts(), target = scripts.outer(boundary, chatText);
      const chat = new BotChatLibrary(scripts, chatHost, { reloadCharacters: () => reload });
      const first = chat.allocate(), second = chat.allocate();
      scripts.once(target, () => {
        for (let index = 0; index < 64; index++) {
          const path = `fill${index}.c`; scripts.files.set(path, chatText);
          expect(chat.loadChatFile(second, path, "bot")).toBe(true);
        }
      });
      // BotLoadChatFile retains avail across BotLoadInitialChat and overwrites nested slot zero.
      expect(chat.loadChatFile(first, "outer.c", "bot")).toBe(true);
      expect(chat.numInitialChats(first, "hello")).toBe(2);
      expect(chat.numInitialChats(second, "hello")).toBe(2);
      if (!reload) {
        scripts.files.clear();
        expect(chat.loadChatFile(second, "fill0.c", "bot")).toBe(false);
        for (let index = 1; index < 64; index++) {
          // Cached entries can retain freed source pointers. Probe the lookup only;
          // BotFreeChatState with reload=false does not dereference/free that chat.
          const probe = chat.allocate();
          expect(chat.loadChatFile(probe, `fill${index}.c`, "bot")).toBe(true);
          chat.free(probe);
        }
        expect(chat.loadChatFile(second, "outer.c", "bot")).toBe(true);
        expect(chat.diagnostics.filter(issue => issue.code === "cache-full")).toHaveLength(1);
      }
    });

    test(`weight ${boundary} reentry publishes distinct allocations with reload=${reload}`, () => {
      const scripts = new ReentrantScripts(), target = scripts.outer(boundary, weightText);
      const weights = new WeightConfigStore(scripts, { reloadCharacters: reload, maxCachedConfigs: 1 });
      let inner: WeightConfig | undefined;
      scripts.once(target, () => { inner = weights.load("outer.c"); });
      const outer = weights.load("outer.c");
      if (inner === undefined) throw new Error("nested weights did not load");
      expect(outer).not.toBe(inner);
      if (!reload) expect(weights.load("outer.c")).toBe(outer);
      expect(inner.evaluate(0, [0])).toBe(1);
      weights.free(outer);
      expect(inner.evaluate(0, [0])).toBe(1);
      const retained = inner;
      weights.shutdown();
      expect(retained.evaluate(0, [0])).toBe(1);
      if (reload) weights.free(retained);
      expect(() => outer.evaluate(0, [0])).toThrow("has been freed");
    });

    test(`weight ${boundary} reentry respects capacity with reload=${reload}`, () => {
      const scripts = new ReentrantScripts(), target = scripts.outer(boundary, weightText);
      scripts.files.set("inner.c", weightText);
      const weights = new WeightConfigStore(scripts, { reloadCharacters: reload, maxCachedConfigs: 1 });
      let inner: WeightConfig | undefined;
      scripts.once(target, () => { inner = weights.load("inner.c"); });
      // ReadWeightConfig also chooses avail before opening the source.
      const outer = weights.load("outer.c");
      expect(outer).not.toBe(inner);
      weights.free(outer);
      if (inner === undefined) throw new Error("nested weights did not load");
      expect(inner.evaluate(0, [0])).toBe(1);
      if (!reload) expect(() => weights.load("inner.c")).toThrow("cache is full");
      const retained = inner;
      weights.shutdown();
      expect(retained.evaluate(0, [0])).toBe(1);
      if (reload) weights.free(retained);
      expect(() => outer.evaluate(0, [0])).toThrow("has been freed");
    });

    for (const same of [false, true]) {
      test(`character ${boundary} reentry preserves ${same ? "same" : "different"} profile with reload=${reload}`, () => {
        const scripts = new ReentrantScripts(), target = scripts.outer(boundary, 'skill 1 { 0 "Outer" }');
        scripts.files.set("inner.c", 'skill 1 { 0 "Inner" }');
        scripts.files.set("bots/default_c.c", 'skill 1 { 0 "Default" }');
        const characters = new BotCharacterLibrary(scripts, { reloadCharacters: () => reload });
        let inner = 0;
        scripts.once(target, () => { inner = characters.load(same ? "outer.c" : "inner.c", 1); });
        const outer = characters.load("outer.c", 1);
        expect(outer).toBeGreaterThan(0); expect(inner).toBeGreaterThan(0);
        // BotLoadCachedCharacter selects handle before parsing; the outer assignment wins.
        expect(characters.string(inner, Characteristic.Name)).toBe("Outer");
        expect(characters.string(outer, Characteristic.Name)).toBe("Outer");
        expect(outer).toBe(inner);
        if (reload) {
          characters.free(outer);
          expect(characters.string(inner, Characteristic.Name)).toBe("");
        }
      });
    }

    test(`character ${boundary} reentry overwrites its previously selected slot with reload=${reload}`, () => {
      const scripts = new ReentrantScripts(), target = scripts.outer(boundary, 'skill 1 { 0 "Outer" }');
      scripts.files.set("bots/default_c.c", 'skill 1 { 0 "Default" }');
      const characters = new BotCharacterLibrary(scripts, { reloadCharacters: () => reload });
      const nested: number[] = [];
      scripts.once(target, () => {
        for (let index = 0; index < 63; index++) {
          const path = `fill${index}.c`; scripts.files.set(path, `skill 1 { 0 "${path}" }`);
          const handle = characters.load(path, 1); expect(handle).toBeGreaterThan(0); nested.push(handle);
        }
      });
      const outer = characters.load("outer.c", 1), first = nested[0];
      if (first === undefined) throw new Error("Nested character load did not publish a handle");
      expect(outer).toBe(first);
      for (const [index, handle] of nested.entries()) expect(characters.string(handle, Characteristic.Name)).toBe(index === 0 ? "Outer" : `fill${index}.c`);
    });
  }

  test(`character ${boundary} arbitrary-skill parse publishes after its earlier wildcard check`, () => {
    const scripts = new ReentrantScripts(), target = scripts.outer(boundary, 'skill 4 { 0 "OuterFour" }');
    const characters = new BotCharacterLibrary(scripts);
    let reads = 0, inner = 0;
    scripts.beforeReturn = path => {
      if (path !== target || ++reads !== 2) return;
      scripts.beforeReturn = () => {};
      scripts.outer(boundary, 'skill 5 { 0 "NestedFive" }');
      inner = characters.load("outer.c", 5);
    };
    const outer = characters.load("outer.c", 1);
    expect(inner).toBeGreaterThan(0);
    expect(outer).toBe(inner);
    expect(characters.string(inner, Characteristic.Name)).toBe("OuterFour");
  });

  test(`character ${boundary} exact-default fallback rechecks its parsed source filename`, () => {
    const scripts = new ReentrantScripts(), target = scripts.outer(boundary, 'skill 1 { 0 "OuterOne" }');
    scripts.files.set("bots/default_c.c", 'skill 1 { 0 "DefaultOne" }');
    const characters = new BotCharacterLibrary(scripts);
    let inner = 0;
    scripts.once(target, () => {
      scripts.files.set("bots/default_c.c", 'skill 4 { 0 "DefaultFour" }');
      scripts.once("bots/default_c.c", () => { inner = characters.load("bots/default_c.c", 4); });
    });
    const outer = characters.load("outer.c", 4);
    expect(inner).toBeGreaterThan(0);
    expect(outer).toBe(inner);
    expect(characters.string(inner, Characteristic.Name)).toBe("DefaultFour");
  });

  test(`weight ${boundary} reentry does not equate a long requested key with its retained prefix`, () => {
    const scripts = new ReentrantScripts();
    const prefix = "a".repeat(63), path = `${prefix}long`;
    scripts.files.set(path, boundary === "root" ? weightText : '#include "long.inc"');
    scripts.files.set("long.inc", weightText);
    const weights = new WeightConfigStore(scripts, { maxCachedConfigs: 2 });
    let inner: WeightConfig | undefined;
    scripts.once(boundary === "root" ? path : "long.inc", () => { inner = weights.load(path); });
    const outer = weights.load(path);
    if (inner === undefined) throw new Error("nested long-key weights did not load");
    expect(outer).not.toBe(inner);
    expect(weights.load(prefix)).toBe(outer);
    expect(weights.load(path)).not.toBe(outer);
    expect(() => weights.load(path)).toThrow("cache is full");
    weights.shutdown();
  });
}
