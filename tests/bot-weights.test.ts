import { BotScriptSources, type BotScriptReader } from "../src/botlib/script-sources.ts";
import { ScriptGlobalDefines } from "../src/script/preprocessor.ts";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { VirtualFileSystem } from "../src/assets/vfs.ts";
import type { Product } from "../src/shared/definitions.ts";
import {
  MAX_FUZZY_WEIGHTS,
  MAX_INVENTORY_VALUE,
  WeightConfigError,
  WeightConfigStore,
  type BotRandom,
  type WeightConfig,
} from "../src/botlib/weights.ts";
import type { IncludeRequest, ScriptSource } from "../src/script/preprocessor.ts";
import { allocateScriptSource, ScriptLanguageError } from "../src/script/lexer.ts";
import { BotMemory, type BotMemoryAllocation } from "../src/botlib/memory.ts";
import { ZoneArena, ZoneTag } from "../src/core/zone.ts";

class RecordingWeightMemory extends BotMemory {
  readonly allocated: { readonly size: number; readonly kind: "heap" | "hunk"; readonly clear: boolean; readonly allocation: BotMemoryAllocation }[] = [];
  readonly freed: number[] = [];

  override allocate(size: number, kind: "heap" | "hunk", clear: boolean): BotMemoryAllocation {
    const allocation = super.allocate(size, kind, clear);
    this.allocated.push({ size, kind, clear, allocation });
    return allocation;
  }

  override free(allocation: BotMemoryAllocation): void {
    this.freed.push(this.allocated.findIndex(record => record.allocation === allocation));
    super.free(allocation);
  }

  bytes(index: number): Uint8Array {
    const record = this.allocated[index];
    if (record === undefined) throw new Error(`missing weight allocation ${index}`);
    return record.allocation.bytes;
  }

  view(index: number): DataView {
    const bytes = this.bytes(index);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
}

class MemoryWeightResolver implements BotScriptReader {
  readonly globals = new ScriptGlobalDefines();
  private readonly sources: ReadonlyMap<string, string>;
  readonly rootRequests: string[] = [];

  constructor(entries: readonly (readonly [string, string])[], private readonly memory?: BotMemory) {
    this.sources = new Map(entries);
  }

  resolveRoot(path: string): ScriptSource | undefined {
    this.rootRequests.push(path);
    return this.source(path);
  }

  resolve(request: IncludeRequest): ScriptSource | undefined {
    return this.source(request.requestedPath);
  }

  private source(path: string): ScriptSource | undefined {
    const text = this.sources.get(path);
    if (text === undefined) return undefined;
    if (this.memory === undefined) return { path, text };
    const source = allocateScriptSource(text.length, path, this.memory);
    source.copyText(text);
    source.compress();
    return source;
  }
}

class SequenceRandom implements BotRandom {
  private readonly values: readonly number[];
  private index = 0;

  constructor(values: readonly number[]) {
    this.values = values;
  }

  get calls(): number {
    return this.index;
  }

  nextInt(): number {
    const value = this.values[this.index];
    if (value === undefined) {
      throw new Error("random fixture was exhausted");
    }
    this.index++;
    return value;
  }
}

function oneConfig(path: string, source: string, reloadCharacters = true): WeightConfig {
  return new WeightConfigStore(new MemoryWeightResolver([[path, source]]), { reloadCharacters }).load(path);
}

function floatBits(value: number): number {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

const NATIVE_RULES = [
  'weight "linear" {',
  "  switch(0) {",
  "    case 0: return 10;",
  "    case 10: return 20;",
  "    default: return 30;",
  "  }",
  "}",
  'weight "uncertain" {',
  "  switch(0) {",
  "    case 0: return balance(4, 2, 6);",
  "    case 10: { switch(1) { default: return 100; } }",
  "    default: return 20;",
  "  }",
  "}",
].join("\n");

describe("source fuzzy-weight parsing and evaluation", () => {
  test("parses recursive switches, optional braces, direct returns, and lookup order", async () => {
    const source = [
      '#include "value.c"',
      'weight "first" return INCLUDED;',
      'weight "first" { switch(2) { case 1: { return 3; } default: return balance(5, 4, 6); } }',
    ].join("\n");
    const store = new WeightConfigStore(new MemoryWeightResolver([
      ["rules.c", source],
      ["value.c", "#define INCLUDED 7"],
    ]));
    const config = await store.load("rules.c");

    expect(config.path).toBe("rules.c");
    expect(config.weightCount).toBe(2);
    expect(config.names).toEqual(["first", "first"]);
    expect(config.find("first")).toBe(0);
    expect(config.find("missing")).toBe(-1);
    expect(config.maxInventoryIndex).toBe(2);
    expect(config.evaluate(0, [0, 0, 0])).toBe(7);
  });

  test("matches native source traversal including integer-division interpolation", async () => {
    const config = await oneConfig("native.c", NATIVE_RULES);
    const linear = config.find("linear");

    // Built from pinned be_ai_weight.c: fuzzy_mid=0x1.4p+4, fuzzy_exact=0x1.ep+4.
    expect(config.evaluate(linear, [5, 0])).toBe(20);
    expect(config.evaluate(linear, [10, 0])).toBe(30);
    expect(config.evaluate(linear, [-1, 0])).toBe(10);
  });

  test("keeps the undecided second-child deterministic and uses the botlib rand mask", async () => {
    const config = await oneConfig("native.c", NATIVE_RULES);
    const uncertain = config.find("uncertain");
    const random = new SequenceRandom([1_804_289_383]);

    // Native oracle: undecided_child=0x1.9p+6. It consumes one random for w1,
    // but obtains the second child through FuzzyWeight_r rather than its undecided form.
    expect(config.evaluateUndecided(uncertain, [5, 0], random)).toBe(100);
    expect(random.calls).toBe(1);

    const maximum = await oneConfig("maximum.c", 'weight "range" return balance(4, 2, 6);');
    expect(maximum.evaluateUndecided(0, [0], new SequenceRandom([0x7fff]))).toBe(6);
    expect(maximum.evaluateUndecided(0, [0], new SequenceRandom([0]))).toBe(2);
  });

  test("returns the cleared branch weight beyond a terminal default", async () => {
    const config = await oneConfig("terminal.c", [
      'weight "terminal" switch(0) { default: {',
      "  switch(1) { default: return balance(44, 40, 48); }",
      "} }",
    ].join("\n"));
    const random = new SequenceRandom([0x7fff]);

    expect(config.evaluate(0, [MAX_INVENTORY_VALUE, 0])).toBe(0);
    expect(config.evaluateUndecided(0, [MAX_INVENTORY_VALUE, 0], random)).toBe(0);
    expect(random.calls).toBe(0);
  });

  test("warns for negative values but preserves the source magnitude bug", async () => {
    const config = await oneConfig("negative.c", 'weight "negative" return - 7;');
    expect(config.evaluate(0, [0])).toBe(7);
    expect(config.diagnostics).toEqual([{
      severity: "warning",
      message: "negative value set to zero\n",
      location: { path: "negative.c", line: 1, column: 26 },
    }]);
  });

  test("adds the source zero default and leaves source case order untouched", async () => {
    const config = await oneConfig("default.c", [
      'weight "missing-default" switch(0) { case 10: return 4; }',
      'weight "unsorted" switch(0) { case 10: return 1; case 5: return 2; default: return 3; }',
    ].join("\n"));

    expect(config.evaluate(0, [10])).toBe(0);
    expect(config.evaluate(1, [7])).toBe(1);
    expect(config.diagnostics.map((diagnostic) => diagnostic.message)).toContain("switch without default\n");
  });
});

describe("source fuzzy genetic operations", () => {
  test("clamps infinite scales and propagates NaN through balanced leaves", () => {
    const config = oneConfig("scales.c", 'weight "x" return balance(4, 2, 6);');
    config.scaleWeight("x", Infinity);
    expect(config.evaluate(0, [0])).toBe(6);
    config.scaleWeight("x", -Infinity);
    expect(config.evaluate(0, [0])).toBe(2);
    config.scaleWeight("x", NaN);
    expect(config.evaluate(0, [0])).toBeNaN();
    const range = oneConfig("range.c", 'weight "x" return balance(4, 2, 6);');
    range.scaleBalanceRange(Infinity);
    expect(range.evaluateUndecided(0, [0], new SequenceRandom([0]))).toBe(-196);
    range.scaleBalanceRange(-Infinity);
    expect(range.evaluateUndecided(0, [0], new SequenceRandom([0]))).toBe(4);
    range.scaleBalanceRange(NaN);
    expect(range.evaluateUndecided(0, [0], new SequenceRandom([0]))).toBeNaN();
  });
  test("matches native float32 evolve, scale, and range fixtures", async () => {
    const evolve = await oneConfig("evolve.c", 'weight "mutation" return balance(4, 2, 6);');
    evolve.evolve(new SequenceRandom([1_804_289_383, 846_930_886]));
    // Pinned native oracle: evolve_weight=0x1.8f191ep+1, bits=40478c8f.
    expect(floatBits(evolve.evaluate(0, [0]))).toBe(0x40478c8f);

    const narrow = await oneConfig("narrow.c", 'weight "mutation" return balance(4, 2, 6);');
    narrow.evolve(new SequenceRandom([0, 1]));
    // `crandom` contains double constants; native rounds only on assignment.
    expect(floatBits(narrow.evaluate(0, [0]))).toBe(0x39800100);

    const scale = await oneConfig("scale.c", 'weight "scaled" return balance(4, 2, 6);');
    scale.scaleWeight("scaled", 0.25);
    expect(scale.evaluate(0, [0])).toBe(2);
    scale.scaleBalanceRange(2);
    expect(scale.evaluateUndecided(0, [0], new SequenceRandom([0]))).toBe(0);
    expect(scale.evaluateUndecided(0, [0], new SequenceRandom([0x7fff]))).toBe(8);
  });

  test("preserves the child-parent and minimum-update interbreed quirks", async () => {
    const nested = (weight: number, minimum: number, maximum: number): string => [
      'weight "breed" switch(0) { default: {',
      `  switch(1) { default: return balance(${weight}, ${minimum}, ${maximum}); }`,
      "} }",
    ].join("\n");
    const parent1 = await oneConfig("p1.c", nested(2, 0, 4));
    const parent2 = await oneConfig("p2.c", nested(10, 8, 12));
    const output = await oneConfig("out.c", nested(0, 0, 100));

    expect(output.interbreedFrom(parent1, parent2)).toEqual([]);
    // Native oracle is 10 rather than 6 because child recursion passes parent2 twice.
    expect(output.evaluate(0, [0, 0])).toBe(10);
    // The source raises min to the average. A zero random therefore also returns 10.
    expect(output.evaluateUndecided(0, [0, 0], new SequenceRandom([0]))).toBe(10);
  });

  test("reports structural errors after retaining earlier source-ordered mutations", async () => {
    const parent1 = await oneConfig("partial-p1.c", [
      'weight "first" return balance(2, 0, 4);',
      'weight "second" switch(0) { default: { switch(1) { default: return 1; } } }',
    ].join("\n"));
    const parent2 = await oneConfig("partial-p2.c", [
      'weight "first" return balance(6, 4, 8);',
      'weight "second" return 1;',
    ].join("\n"));
    const output = await oneConfig("partial-out.c", [
      'weight "first" return balance(0, 0, 10);',
      'weight "second" switch(0) { default: { switch(1) { default: return 1; } } }',
    ].join("\n"));

    expect(output.interbreedFrom(parent1, parent2)).toEqual([
      "cannot interbreed weight configs, unequal child",
    ]);
    expect(output.evaluate(0, [0, 0])).toBe(4);
  });
});

describe("weight config ownership and malformed boundaries", () => {
  test("matches cached free behavior and reload-owned lifetime", async () => {
    const resolver = new MemoryWeightResolver([["one.c", 'weight "one" return 1;']]);
    const cachedStore = new WeightConfigStore(resolver);
    const first = await cachedStore.load("one.c");
    const retained = await cachedStore.load("one.c");
    expect(retained).toBe(first);
    cachedStore.free(first);
    expect(first.evaluate(0, [0])).toBe(1);
    cachedStore.shutdown();
    expect(() => first.evaluate(0, [0])).toThrow("has been freed");

    const reloadStore = new WeightConfigStore(resolver, { reloadCharacters: true });
    const reload1 = await reloadStore.load("one.c");
    const reload2 = await reloadStore.load("one.c");
    expect(reload2).not.toBe(reload1);
    reloadStore.free(reload1);
    expect(() => reload1.evaluate(0, [0])).toThrow("has been freed");
    expect(reload2.evaluate(0, [0])).toBe(1);
  });

  test("synchronous loads publish before shutdown and a new lifetime has independent identity", () => {
    for (const reloadCharacters of [false, true]) {
      const resolver = new MemoryWeightResolver([["same.c", 'weight "current" return 2;']]);
      const store = new WeightConfigStore(resolver, { reloadCharacters });
      const old = store.load("same.c");
      expect(old.evaluate(0, [0])).toBe(2);
      expect(resolver.rootRequests).toEqual(["same.c"]);
      store.shutdown();
      if (reloadCharacters) {
        expect(old.evaluate(0, [0])).toBe(2);
        store.free(old);
      }
      expect(() => old.evaluate(0, [0])).toThrow("has been freed");
      const current = store.load("same.c");
      expect(current).not.toBe(old);
      expect(current.evaluate(0, [0])).toBe(2);
      expect(resolver.rootRequests).toEqual(["same.c", "same.c"]);
      if (!reloadCharacters) {
        expect(store.load("same.c")).toBe(current);
        expect(resolver.rootRequests).toHaveLength(2);
      }
    }
  });

  test("a synchronous resolver cannot publish over its own replacement weight store lifetime", () => {
    for (const reloadCharacters of [false, true]) {
      const memory = new MemoryWeightResolver([["same.c", 'weight "current" return 2;']]);
      let replaced = false;
      let fresh: WeightConfig | undefined;
      const resolver: BotScriptReader = {
        globals: memory.globals,
        resolve: request => memory.resolve(request),
        resolveRoot(path) {
          const source = memory.resolveRoot(path);
          if (!replaced) {
            replaced = true;
            store.shutdown();
            fresh = store.load(path);
          }
          return source;
        },
      };
      const store = new WeightConfigStore(resolver, { reloadCharacters });
      expect(() => store.load("same.c")).toThrow("owner changed during synchronous source read: same.c");
      if (fresh === undefined) throw new Error("replacement source did not load");
      expect(fresh.evaluate(0, [0])).toBe(2);
      expect(memory.rootRequests).toEqual(["same.c", "same.c"]);
      if (!reloadCharacters) expect(store.load("same.c")).toBe(fresh);
      const retained = fresh;
      store.shutdown();
      if (reloadCharacters) {
        expect(retained.evaluate(0, [0])).toBe(2);
        store.free(retained);
      }
      expect(() => retained.evaluate(0, [0])).toThrow("has been freed");
    }
  });

  test("matches the source 63-byte cached filename and ordered alias lookup", async () => {
    const prefix = "a".repeat(63);
    const longA = `${prefix}aaa`;
    const longB = `${prefix}bbb`;
    const resolver = new MemoryWeightResolver([
      [longA, 'weight "first" return 1;'],
      [longB, 'weight "third" return 3;'],
    ]);
    const store = new WeightConfigStore(resolver, { maxCachedConfigs: 3 });

    const first = await store.load(longA);
    const second = await store.load(longA);
    expect(second).not.toBe(first);
    expect(first.evaluate(0, [0])).toBe(1);
    expect(second.evaluate(0, [0])).toBe(1);
    expect(await store.load(prefix)).toBe(first);

    const third = await store.load(longB);
    expect(third.evaluate(0, [0])).toBe(3);
    expect(() => store.load(longB)).toThrow("cache is full");
    expect(resolver.rootRequests).toEqual([longA, longA, longB]);

    const highBytes = "\xe9".repeat(32);
    const byteResolver = new MemoryWeightResolver([[highBytes, 'weight "bytes" return 4;']]);
    const byteStore = new WeightConfigStore(byteResolver);
    const byteFirst = await byteStore.load(highBytes);
    expect(await byteStore.load(highBytes)).toBe(byteFirst);
    expect(byteResolver.rootRequests).toEqual([highBytes]);
  });

  test("enforces cache, inventory and random bounds", async () => {
    const resolver = new MemoryWeightResolver([
      ["one.c", 'weight "one" return 1;'],
      ["two.c", 'weight "two" return 2;'],
    ]);
    const cache = new WeightConfigStore(resolver, { maxCachedConfigs: 1 });
    await cache.load("one.c");
    expect(() => cache.load("two.c")).toThrow("cache is full");

    const config = await new WeightConfigStore(resolver).load("one.c");
    expect(() => config.evaluate(0, [])).toThrow("inventory index 0");
    expect(() => config.evaluate(0, [0.5])).toThrow("must be an int32");
    expect(() => config.evaluateUndecided(0, [0], new SequenceRandom([0x1_0000_0000])))
      .toThrow("int32 or uint32");
    config.scaleWeight("one", Number.POSITIVE_INFINITY);
    expect(config.evaluate(0, [0])).toBe(1);
  });

  test("loads, evaluates, mutates and frees a depth-129 switch using its source allocations", () => {
    const depth = 129;
    const source = 'weight "deep" ' + "switch(0) { default: ".repeat(depth)
      + "return balance(2, 0, 4);" + "}".repeat(depth);
    const zoneBytes = 65_536;
    const zone = new ZoneArena(zoneBytes);
    const memory = new BotMemory(undefined, zone);
    const store = new WeightConfigStore(new MemoryWeightResolver([["deep.c", source]], memory), { memory });
    const config = store.load("deep.c");

    expect(config.weightCount).toBe(1);
    expect(config.diagnostics).toEqual([]);
    expect(config.evaluate(0, [0])).toBe(2);
    config.scaleWeight("deep", 0.75);
    expect(config.evaluate(0, [0])).toBe(3);
    expect(zone.memoryRemaining()).toBeLessThanOrEqual(zoneBytes - 1120 - 36 - depth * 60);
    store.shutdown();
    expect(zone.memoryRemaining()).toBe(zoneBytes);
    zone.dispose();
  });

  test("loads and frees 65,537 shallow separators when the actual zone has room", () => {
    const weightCount = 128;
    const source = Array.from({ length: weightCount }, (_, weightIndex) => {
      const caseCount = weightIndex === weightCount - 1 ? 512 : 511;
      const cases = Array.from({ length: caseCount }, (_, index) =>
        `case ${index + 1}: return ${weightIndex};`).join("\n");
      return `weight "weight-${weightIndex}" switch(0) { ${cases}\n default: return ${1000 + weightIndex}; }`;
    }).join("\n");
    const zoneBytes = 8 * 1024 * 1024;
    const zone = new ZoneArena(zoneBytes);
    const memory = new BotMemory(undefined, zone);
    const store = new WeightConfigStore(new MemoryWeightResolver([["wide.c", source]], memory), { memory });
    const config = store.load("wide.c");

    expect(config.weightCount).toBe(weightCount);
    expect(config.diagnostics).toEqual([]);
    expect(config.evaluate(0, [0])).toBe(0);
    expect(config.evaluate(127, [0])).toBe(127);
    expect(config.evaluate(127, [512])).toBe(1127);
    expect(config.maxInventoryIndex).toBe(0);
    // These are minimum block sizes; source-token reuse can leave unsplittable zone fragments.
    expect(zone.memoryRemaining()).toBeLessThanOrEqual(zoneBytes - 1120 - weightCount * 40 - 65_537 * 60);
    store.shutdown();
    expect(zone.memoryRemaining()).toBe(zoneBytes);
    zone.dispose();
  }, 30_000);

  test("rejects duplicate defaults, empty switches, and negative indexes", async () => {
    const malformed: readonly (readonly [string, string])[] = [
      ["duplicate.c", 'weight "bad" switch(0) { default: return 1; default: return 2; }'],
      ["empty.c", 'weight "bad" switch(0) { }'],
      ["negative-index.c", 'weight "bad" switch(-1) { default: return 1; }'],
    ];
    for (const [path, source] of malformed) {
      const store = new WeightConfigStore(new MemoryWeightResolver([[path, source]]));
      expect(() => store.load(path)).toThrow(WeightConfigError);
    }
  });

  test("returns a source-compatible partial config after the 128th weight", async () => {
    const source = Array.from({ length: MAX_FUZZY_WEIGHTS + 1 }, (_, index) => (
      `weight "weight-${index}" return ${index};`
    )).join("\n");
    const config = await oneConfig("many.c", source);

    expect(config.weightCount).toBe(MAX_FUZZY_WEIGHTS);
    expect(config.find("weight-127")).toBe(127);
    expect(config.find("weight-128")).toBe(-1);
    expect(config.diagnostics.map((diagnostic) => diagnostic.message)).toContain("too many fuzzy weights\n");
  });
});

describe("source fuzzy weight heap ownership", () => {
  test("converts unsigned token fields to signed source indexes and thresholds", () => {
    const memory = new RecordingWeightMemory();
    const store = new WeightConfigStore(new MemoryWeightResolver([["signed.c",
      'weight "signed" switch(0xffffffff) { case 0x80000000: return 1; default: return 2; }',
    ]]), { memory });
    const config = store.load("signed.c");
    expect(memory.view(2).getInt32(0, true)).toBe(-1);
    expect(memory.view(2).getInt32(4, true)).toBe(-2147483648);
    expect(memory.view(3).getInt32(0, true)).toBe(-1);
    expect(() => config.evaluate(0, [])).toThrow("inventory index -1");
    expect(config.evaluate(0, index => { expect(index).toBe(-1); return 999999; })).toBe(2);
    store.shutdown();
  });

  test("preserves defined parser messages, current source lines, and lookahead read failure", () => {
    const cases = [
      { text: "weight\nname", messages: ["expected a string, found name"], line: 2 },
      { text: 'weight "x" switch(\nname)', messages: ["expected a number, found name"], line: 2 },
      { text: 'weight "x" return - name;', messages: ["negative value set to zero\n", "expected a number, found name"], line: 1 },
      { text: 'weight "x" return balance(1,2,3\n', messages: ["couldn't find expected )"], line: 2 },
      { text: 'weight "x"\n', messages: ["couldn't read expected token"], line: 2 },
    ];
    for (const fixture of cases) {
      const diagnostics: string[] = [];
      const store = new WeightConfigStore(new MemoryWeightResolver([["rules.c", fixture.text]]), {
        print: (_severity, text) => { diagnostics.push(text); },
      });
      expect(() => store.load("rules.c")).toThrow(WeightConfigError);
      expect(diagnostics).toEqual(fixture.messages.map(message => `file rules.c, line ${fixture.line}: ${message}\n`));
    }
    const store = new WeightConfigStore(new MemoryWeightResolver([["lookahead.c",
      'weight "x" return\n#error stop\n4;',
    ]]));
    const config = store.load("lookahead.c");
    expect(config.evaluate(0, [0])).toBe(4);
    expect(config.diagnostics.map(diagnostic => diagnostic.message)).toEqual(["#error directive: stop"]);
    store.shutdown();
  });

  test("stores high-byte names and cached filenames without UTF-8 conversion", () => {
    const memory = new RecordingWeightMemory();
    const path = "\xff\x80.c";
    const resolver = new MemoryWeightResolver([[path, 'weight "\xff" return 4;']]);
    const store = new WeightConfigStore(resolver, { memory });
    const config = store.load(path);
    expect(memory.bytes(1)).toEqual(new Uint8Array([255, 0]));
    expect(memory.bytes(0).slice(1028, 1033)).toEqual(new Uint8Array([255, 128, 46, 99, 0]));
    expect(config.names).toEqual(["\xff"]);
    memory.bytes(1)[0] = 128;
    expect(config.names).toEqual(["\x80"]);
    expect(config.find("\x80")).toBe(0);
    expect(config.find("\x80\0suffix")).toBe(0);
    expect(store.load(path)).toBe(config);
    memory.bytes(0)[1028] = 129;
    expect(store.load("\x81\x80.c")).toBe(config);
    expect(resolver.rootRequests).toEqual([path]);
    store.shutdown();
  });
  test("frees included and root source storage before loaded callbacks and partial-config publication", () => {
    for (const failOuterToken of [false, true]) {
      const memory = new RecordingWeightMemory();
      const atLoaded: number[][] = [];
      const store = new WeightConfigStore(new MemoryWeightResolver([
        ["rules.c", '#include "inner.c"'],
        ["inner.c", `weight "one" return 1;${failOuterToken ? "\n#error stop" : ""}`],
      ], memory), {
        memory,
        print: severity => { if (severity === 1) atLoaded.push([...memory.freed]); },
      });
      const config = store.load("rules.c");
      expect(atLoaded).toEqual([[7, 6, 5, 1, 0, 3, 2]]);
      expect(memory.freed).toEqual([7, 6, 5, 1, 0, 3, 2]);
      expect(config.weightCount).toBe(1);
      expect(config.evaluate(0, [0])).toBe(1);
      expect(config.diagnostics.map(diagnostic => diagnostic.severity)).toEqual(failOuterToken ? ["error"] : []);
      expect(store.load("rules.c")).toBe(config);
      store.shutdown();
      expect(memory.freed).toEqual([7, 6, 5, 1, 0, 3, 2, 9, 8, 4]);
    }
  });

  test("frees failed weight records before source storage while preserving incomplete definitions", () => {
    for (const reloadCharacters of [false, true]) {
      const memory = new RecordingWeightMemory();
      const store = new WeightConfigStore(new MemoryWeightResolver([
        ["rules.c", '#include "inner.c"'],
        ["inner.c", 'weight "good" return 1; weight "bad" return invalid;'],
      ], memory), { memory, reloadCharacters });
      expect(() => store.load("rules.c")).toThrow("invalid return value invalid");
      const freed = reloadCharacters ? [7, 10, 12, 9, 8, 4, 6, 5, 1, 0, 3, 2] : [7, 10, 12, 6, 5, 1, 0, 3, 2];
      expect(memory.freed).toEqual(freed);
      expect(Array.from(memory.bytes(11))).toEqual([98, 97, 100, 0]);
      if (!reloadCharacters) {
        expect(memory.view(4).getInt32(0, true)).toBe(1);
        expect(memory.view(9).getFloat32(12, true)).toBe(1);
      }
      store.shutdown();
      expect(memory.freed).toEqual(freed);
    }
  });

  test("leaves sources and partial weights allocated when diagnostic or include callbacks throw", () => {
    const failures = [
      new Error("callback aborted"),
      new ScriptLanguageError({ severity: "error", message: "callback aborted",
        location: { path: "callback", line: 1, column: 1 } }, []),
    ];
    const fixtures = [
      { callback: "print", text: 'weight "bad" switch(0) { default: return invalid; }', allocationCount: 10 },
      { callback: "preprocessor", text: "#error stop", allocationCount: 7 },
      { callback: "include", text: '#include "abort.c"', allocationCount: 7 },
    ];
    for (const failure of failures) {
      for (const fixture of fixtures) {
        const memory = new RecordingWeightMemory();
        const resolver = new MemoryWeightResolver([
          ["rules.c", '#include "inner.c"'], ["inner.c", fixture.text],
        ], memory);
        const store = new WeightConfigStore({
          globals: resolver.globals,
          resolveRoot: path => resolver.resolveRoot(path),
          resolve: request => {
            if (request.requestedPath === "abort.c") throw failure;
            return resolver.resolve(request);
          },
        }, {
          memory, reloadCharacters: true,
          preprocessor: { report: () => { if (fixture.callback === "preprocessor") throw failure; } },
          print: () => { if (fixture.callback === "print") throw failure; },
        });
        let caught: unknown;
        try { store.load("rules.c"); }
        catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(memory.allocated).toHaveLength(fixture.allocationCount);
        const tokenFrees = fixture.callback === "print" ? [7] : [];
        expect(memory.freed).toEqual(tokenFrees);
        expect(memory.view(4).getInt32(0, true)).toBe(0);
        expect(memory.bytes(0).byteLength).toBeGreaterThan(2148);
        expect(memory.bytes(5).byteLength).toBeGreaterThan(2148);
        store.shutdown();
        expect(memory.freed).toEqual(tokenFrees);
      }
    }
  });

  test("uses actual zone bytes for names, counts, links, decisions, mutation and cache identity", () => {
    const zone = new ZoneArena(16_384);
    const memory = new RecordingWeightMemory(undefined, zone);
    const store = new WeightConfigStore(new MemoryWeightResolver([["rules.c", [
      'weight "one" switch(0) { case 1: return balance(4, 2, 6);',
      'default: switch(1) { default: return 9; } }',
      'weight "two" return 3;',
    ].join("\n")]]), { memory });
    const config = store.load("rules.c");
    expect(memory.allocated.map(record => [record.size, record.kind, record.clear])).toEqual([
      [1092, "heap", true], [4, "heap", true], [32, "heap", true], [32, "heap", true],
      [32, "heap", true], [4, "heap", true], [32, "heap", true],
    ]);
    expect(zone.memoryRemaining()).toBe(16_384 - 1424);
    const configBytes = memory.bytes(0);
    expect(new DataView(configBytes.buffer, configBytes.byteOffset - 24, 20).getInt32(4, true)).toBe(ZoneTag.Botlib);
    const header = memory.view(0);
    const first = memory.view(2);
    const branch = memory.view(3);
    expect(header.getInt32(0, true)).toBe(2);
    expect(header.getUint32(4, true)).toBe(1);
    expect(header.getUint32(8, true)).toBe(2);
    expect(first.getUint32(28, true)).toBe(3);
    expect(branch.getUint32(24, true)).toBe(4);
    expect(Array.from(memory.bytes(1))).toEqual([111, 110, 101, 0]);
    expect(config.evaluate(0, [0, 0])).toBe(4);
    expect(config.evaluate(0, [2, 0])).toBe(9);

    memory.bytes(1).set(new TextEncoder().encode("uno"));
    expect(config.names).toEqual(["uno", "two"]);
    expect(config.find("one")).toBe(-1);
    first.setFloat32(12, 5, true);
    expect(config.evaluate(0, [0, 0])).toBe(5);
    config.scaleWeight("uno", 0.75);
    expect(first.getFloat32(12, true)).toBe(6);
    config.scaleBalanceRange(2);
    expect(first.getFloat32(16, true)).toBe(0);
    expect(first.getFloat32(20, true)).toBe(8);
    expect(config.evaluateUndecided(0, [0, 0], new SequenceRandom([0x7fff]))).toBe(8);

    first.setUint32(28, 0, true);
    expect(config.evaluate(0, [2, 0])).toBe(6);
    first.setUint32(28, 3, true);
    branch.setUint32(24, 0, true);
    branch.setFloat32(12, 11, true);
    expect(config.evaluate(0, [2, 0])).toBe(11);
    branch.setUint32(24, 4, true);
    expect(config.evaluate(0, [2, 0])).toBe(9);
    header.setUint32(8, header.getUint32(16, true), true);
    expect(config.evaluate(0, [0, 0])).toBe(3);
    header.setUint32(8, 2, true);
    header.setInt32(0, 1, true);
    expect(config.names).toEqual(["uno"]);
    header.setInt32(0, 2, true);
    configBytes.fill(0, 1028);
    configBytes.set(new TextEncoder().encode("alias.c"), 1028);
    expect(store.load("alias.c")).toBe(config);
    store.free(config);
    expect(memory.freed).toEqual([]);
    store.shutdown();
    expect(memory.freed).toEqual([4, 3, 2, 1, 6, 5, 0]);
    expect(zone.memoryRemaining()).toBe(16_384);
    expect(() => config.evaluate(0, [0, 0])).toThrow("has been freed");
    zone.dispose();
  });

  test("allocates before lazy includes and returns the source partial config after an outer token error", () => {
    for (const reloadCharacters of [false, true]) {
      for (const completed of [false, true]) {
        const memory = new RecordingWeightMemory();
        const resolver = new MemoryWeightResolver([["rules.c", completed
          ? 'weight "good" return 2;\n#include "missing.c"'
          : '#include "missing.c"']]);
        const observations: number[][] = [];
        const store = new WeightConfigStore({
          globals: resolver.globals,
          resolveRoot: path => resolver.resolveRoot(path),
          resolve: request => {
            observations.push(memory.allocated.map(record => record.size));
            expect(memory.view(0).getInt32(0, true)).toBe(completed ? 1 : 0);
            return resolver.resolve(request);
          },
        }, { memory, reloadCharacters });
        const config = store.load("rules.c");
        expect(config.weightCount).toBe(completed ? 1 : 0);
        expect(config.diagnostics.map(diagnostic => diagnostic.severity)).toEqual(["error"]);
        expect(observations).toEqual(completed ? [[1092, 5, 32]] : [[1092]]);
        expect(memory.freed).toEqual([]);
        if (reloadCharacters) store.free(config);
        else store.shutdown();
        expect(memory.freed).toEqual(completed ? [2, 1, 0] : [0]);
      }
      const memory = new RecordingWeightMemory();
      const store = new WeightConfigStore(new MemoryWeightResolver([["inside.c",
        'weight "bad" return\n#include "missing.c"',
      ]]), { memory, reloadCharacters });
      expect(() => store.load("inside.c")).toThrow(WeightConfigError);
      expect(memory.allocated.map(record => record.size)).toEqual([1092, 4, 32]);
      expect(memory.freed).toEqual(reloadCharacters ? [2, 0] : [2]);
      expect(Array.from(memory.bytes(1))).toEqual([98, 97, 100, 0]);
    }
  });

  test("retains the current name and publishes partial fuzzy values before parser diagnostics", () => {
    for (const reloadCharacters of [false, true]) {
      const memory = new RecordingWeightMemory();
      const observations: number[][] = [];
      const store = new WeightConfigStore(new MemoryWeightResolver([["rules.c",
        'weight "good" return 1; weight "bad" return balance(4, 2, invalid);',
      ]]), {
        memory, reloadCharacters,
        print: severity => {
          if (severity === 3) {
            observations.push([
              memory.view(0).getInt32(0, true), memory.view(4).getInt32(8, true),
              memory.view(4).getFloat32(12, true), memory.view(4).getFloat32(16, true),
              memory.view(4).getFloat32(20, true),
            ]);
          }
        },
      });
      expect(() => store.load("rules.c")).toThrow("invalid return value invalid");
      expect(observations).toEqual([[1, 1, 4, 2, 0]]);
      expect(memory.freed).toEqual(reloadCharacters ? [4, 2, 1, 0] : [4]);
      expect(Array.from(memory.bytes(3))).toEqual([98, 97, 100, 0]);
      store.shutdown();
      expect(memory.freed).toEqual(reloadCharacters ? [4, 2, 1, 0] : [4]);
    }
  });

  test("keeps distinct source separator cleanup paths and diagnostic order", () => {
    const cases = [
      { body: "default: return 1; default: return 2;", sizes: [1092, 4, 32, 32], atError: [], freed: [3, 2, 0] },
      { body: "default: invalid;", sizes: [1092, 4, 32], atError: [], freed: [0] },
      { body: "default: return 1; invalid;", sizes: [1092, 4, 32], atError: [2], freed: [2, 0] },
    ];
    for (const fixture of cases) {
      const memory = new RecordingWeightMemory();
      const atError: number[][] = [];
      const store = new WeightConfigStore(new MemoryWeightResolver([["rules.c",
        `weight "bad" switch(0) { ${fixture.body} }`,
      ]]), {
        memory, reloadCharacters: true,
        print: severity => { if (severity === 3) atError.push([...memory.freed]); },
      });
      expect(() => store.load("rules.c")).toThrow(WeightConfigError);
      expect(memory.allocated.map(record => record.size)).toEqual(fixture.sizes);
      expect(atError).toEqual([fixture.atError]);
      expect(memory.freed).toEqual(fixture.freed);
      expect(Array.from(memory.bytes(1))).toEqual([98, 97, 100, 0]);
    }
  });

  test("preserves allocated residue on real zone exhaustion and callback aborts", () => {
    const sourceZone = new ZoneArena(4096);
    const sourceMemory = new RecordingWeightMemory(undefined, sourceZone);
    const sourceStore = new WeightConfigStore(new MemoryWeightResolver([
      ["rules.c", 'weight "one" return 1;'],
    ], sourceMemory), { memory: sourceMemory, reloadCharacters: true });
    expect(() => sourceStore.load("rules.c")).toThrow("Z_Malloc: failed on allocation of 3172 bytes");
    expect(sourceMemory.allocated).toHaveLength(2);
    expect(sourceMemory.bytes(0).byteLength).toBeGreaterThan(2148);
    expect(sourceMemory.bytes(1)).toHaveLength(1024);
    expect(sourceMemory.freed).toEqual([]);
    sourceZone.dispose();

    const zone = new ZoneArena(1232);
    const memory = new RecordingWeightMemory(undefined, zone);
    const store = new WeightConfigStore(new MemoryWeightResolver([["rules.c", 'weight "one" return 1;']]), {
      memory, reloadCharacters: true,
    });
    expect(() => store.load("rules.c")).toThrow("Z_Malloc: failed on allocation of 60 bytes");
    expect(memory.allocated.map(record => record.size)).toEqual([1092, 4]);
    expect(memory.view(0).getInt32(0, true)).toBe(0);
    expect(memory.freed).toEqual([]);
    expect(zone.memoryRemaining()).toBe(32);
    zone.dispose();
    expect(() => memory.bytes(0)).toThrow();

    const mutations = new RecordingWeightMemory();
    const mutable = new WeightConfigStore(new MemoryWeightResolver([["mutations.c",
      'weight "one" return balance(4, 2, 6); weight "two" return balance(4, 2, 6);',
    ]]), { memory: mutations, reloadCharacters: true });
    const config = mutable.load("mutations.c");
    const random = new SequenceRandom([1_804_289_383, 846_930_886]);
    expect(() => config.evolve(random)).toThrow("random fixture was exhausted");
    expect(random.calls).toBe(2);
    expect(mutations.view(2).getUint32(12, true)).toBe(0x40478c8f);
    expect(mutations.view(4).getFloat32(12, true)).toBe(4);
    mutable.free(config);
    expect(mutations.freed).toEqual([2, 1, 4, 3, 0]);
  });

  test("retains the selected cache slot across recursive loaded callbacks without freeing replaced configs", () => {
    const memory = new RecordingWeightMemory();
    let nested: WeightConfig | undefined;
    let entered = false;
    const store = new WeightConfigStore(new MemoryWeightResolver([
      ["outer.c", 'weight "outer" return 1;'], ["nested.c", 'weight "nested" return 2;'],
    ]), {
      memory,
      print: (severity, text) => {
        if (severity === 1 && text === "loaded outer.c\n" && !entered) {
          entered = true;
          nested = store.load("nested.c");
        }
      },
    });
    const outer = store.load("outer.c");
    if (nested === undefined) throw new Error("nested config did not load");
    expect(store.load("outer.c")).toBe(outer);
    const secondNested = store.load("nested.c");
    expect(secondNested).not.toBe(nested);
    expect(nested.evaluate(0, [0])).toBe(2);
    expect(memory.freed).toEqual([]);
    store.shutdown();
    expect(memory.freed).toEqual([2, 1, 0, 8, 7, 6]);
    expect(memory.view(3).getInt32(0, true)).toBe(1);
    expect(memory.view(5).getFloat32(12, true)).toBe(2);
    expect(nested.evaluate(0, [0])).toBe(2);
  });
});

const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retailAvailable = existsSync(join(retailRoot, "baseq3", "pak0.pk3"))
  && existsSync(join(retailRoot, "missionpack", "pak0.pk3"));

test.skipIf(!retailAvailable)("parses every retail item and weapon weight config in both products", async () => {
  const products: readonly Product[] = ["baseq3", "missionpack"];
  for (const product of products) {
    const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product });
    const resolver = new BotScriptSources(vfs, new ScriptGlobalDefines(), (_severity, text) => { throw new Error(text); }, (_text: string): undefined => undefined);
    const printed: { readonly severity: 1 | 2 | 3 | 4; readonly text: string }[] = [];
    const store = new WeightConfigStore(resolver, {
      reloadCharacters: true,
      print: (severity, text) => { printed.push({ severity, text }); },
    });
    const paths = vfs.list("botfiles/bots/").filter((path) => path.endsWith("_i.c") || path.endsWith("_w.c"));
    expect(paths).toHaveLength(86);
    let parsedWeights = 0;
    const rejected: string[] = [];
    for (const path of paths) {
      printed.length = 0;
      let config: WeightConfig;
      try {
        config = store.load(path.slice("botfiles/".length));
      } catch (error) {
        if (error instanceof WeightConfigError) {
          rejected.push(`${path}: ${error.message}`);
          expect(error.diagnostics).toEqual([
            {
              severity: "error", message: "can't evaluate FS_ARMOR, not defined",
              location: { path: "fw_items.c", line: 60, column: 32 },
            },
            {
              severity: "error", message: "couldn't read expected token",
              location: { path: "fw_items.c", line: 60, column: 1 },
            },
          ]);
          expect(error.diagnostics[1]).toEqual(error.diagnostic);
          expect(printed).toEqual([
            { severity: 3, text: "file fw_items.c, line 60: can't evaluate FS_ARMOR, not defined\n" },
            { severity: 3, text: "file fw_items.c, line 60: couldn't read expected token\n" },
          ]);
          continue;
        }
        throw error;
      }
      expect(config.weightCount).toBeGreaterThan(0);
      const inventory = new Array<number>(config.maxInventoryIndex + 1).fill(0);
      for (let index = 0; index < config.weightCount; index++) {
        expect(Number.isFinite(config.evaluate(index, inventory))).toBe(true);
      }
      parsedWeights += config.weightCount;
      store.free(config);
    }
    // PC_DollarEvaluate reports cadaver's undefined FS_ARMOR, then its false
    // return reaches ReadValue/PC_ExpectAnyToken, which emits the final error.
    expect(rejected).toEqual([
      "botfiles/bots/cadaver_i.c: fw_items.c:60:1: couldn't read expected token",
    ]);
    expect(parsedWeights).toBeGreaterThan(1_000);
  }
});
