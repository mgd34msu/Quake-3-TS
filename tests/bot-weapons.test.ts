import { BotScriptSources, type BotScriptReader } from "../src/botlib/script-sources.ts";
import { ScriptGlobalDefines } from "../src/script/preprocessor.ts";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";

import { VirtualFileSystem } from "../src/assets/vfs.ts";
import {
  MAX_WEAPON_STATES,
  WeaponAi,
  WeaponLoadResult,
} from "../src/botlib/weapons.ts";
import { WeightConfigStore } from "../src/botlib/weights.ts";
import type { IncludeRequest, ScriptSource } from "../src/script/preprocessor.ts";
import type { Product } from "../src/shared/definitions.ts";
import { BotMemory, type BotMemoryAllocation } from "../src/botlib/memory.ts";
import { ZoneArena } from "../src/core/zone.ts";
import { ScriptLanguageError } from "../src/script/lexer.ts";
import { CommonError } from "../src/core/common-error.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";

class WeaponMemory extends BotMemory {
  readonly recorded: { readonly size: number; readonly kind: "heap" | "hunk"; readonly clear: boolean; readonly allocation: BotMemoryAllocation }[] = [];
  readonly frees: number[] = [];
  readonly freed: BotMemoryAllocation[] = [];

  override allocate(size: number, kind: "heap" | "hunk", clear: boolean): BotMemoryAllocation {
    const allocation = super.allocate(size, kind, clear);
    this.recorded.push({ size, kind, clear, allocation });
    return allocation;
  }

  override free(allocation: BotMemoryAllocation): void {
    super.free(allocation);
    this.frees.push(this.recorded.findIndex(record => record.allocation === allocation));
    this.freed.push(allocation);
  }

  bytes(index: number): Uint8Array {
    const record = this.recorded[index];
    if (record === undefined) throw new Error(`missing weapon allocation ${index}`);
    return record.allocation.bytes;
  }

  view(index: number): DataView {
    const bytes = this.bytes(index);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
}

class MemoryResolver implements BotScriptReader {
  readonly globals = new ScriptGlobalDefines();
  readonly sources = new Map<string, string>();

  constructor(entries: readonly (readonly [string, string])[] = []) {
    for (const [path, source] of entries) {
      this.sources.set(path, source);
    }
  }

  resolveRoot(path: string): ScriptSource | undefined {
    return this.source(path);
  }

  resolve(request: IncludeRequest): ScriptSource | undefined {
    const relative = posix.join(posix.dirname(request.fromPath), request.requestedPath);
    return this.source(relative) ?? this.source(request.requestedPath);
  }

  private source(path: string): ScriptSource | undefined {
    const text = this.sources.get(path);
    return text === undefined ? undefined : { path, text };
  }
}

class ReentrantResolver extends MemoryResolver {
  beforeRead: (path: string) => void = () => {};
  override resolveRoot(path: string): ScriptSource | undefined {
    const source = super.resolveRoot(path);
    this.beforeRead(path);
    return source;
  }
}

const COMPLETE_CONFIG = [
  "#define WNUM 1",
  "projectileinfo {",
  ' name "bolt" model "models/ammo/bolt.md3" flags 1 gravity 0.25 damage 75',
  " radius 12.5 visdamage 6 damagetype 3 healthinc -2 push 4.5",
  " detonation 5.5 bounce 0.75 bouncefric 0.125 bouncestop 0.0625",
  "}",
  "weaponinfo {",
  ' number WNUM name "Alpha" level 2 model "models/weapons/alpha.md3"',
  ' weaponindex 9 flags 1 projectile "bolt" numprojectiles 3',
  " hspread 1.25 vspread 2.5 speed 900 acceleration 10",
  " recoil { 1, 2, 3 } recoil { 4 } offset { 5, 6 } angleoffset { 7, 8, 9 }",
  " extrazvelocity 11 ammoamount 2 ammoindex 10 activate 0.2 reload 0.3 spinup 0.4 spindown 0.5",
  "}",
].join("\n");

const SECOND_WEAPON = [
  'projectileinfo { name "second" damage 5 }',
  'weaponinfo { number 2 name "Beta" projectile "second" }',
].join("\n");

function library(
  resolver: BotScriptReader,
  options: ConstructorParameters<typeof WeaponAi>[1] = {},
): { readonly ai: WeaponAi; readonly weights: WeightConfigStore } {
  const weights = new WeightConfigStore(resolver, { reloadCharacters: true });
  return { ai: new WeaponAi({ resolver, weights }, options), weights };
}

describe("bot weapon configuration", () => {
  test("reads every projectile and weapon field with source repeats and float32 storage", async () => {
    const resolver = new MemoryResolver([["weapons.c", COMPLETE_CONFIG]]);
    const { ai } = library(resolver);

    expect(await ai.setup()).toBe(WeaponLoadResult.NoError);
    const handle = ai.allocateState();
    const weapon = ai.getWeaponInfo(handle, 1);
    expect(weapon).toEqual({
      valid: true,
      number: 1,
      name: "Alpha",
      model: "models/weapons/alpha.md3",
      level: 2,
      weaponInventoryIndex: 9,
      flags: 1,
      projectile: "bolt",
      projectileCount: 3,
      horizontalSpread: Math.fround(1.25),
      verticalSpread: Math.fround(2.5),
      speed: 900,
      acceleration: 10,
      recoil: { x: 4, y: 2, z: 3 },
      offset: { x: 5, y: 6, z: 0 },
      angleOffset: { x: 7, y: 8, z: 9 },
      extraZVelocity: 11,
      ammoAmount: 2,
      ammoInventoryIndex: 10,
      activate: Math.fround(0.2),
      reload: Math.fround(0.3),
      spinUp: Math.fround(0.4),
      spinDown: Math.fround(0.5),
      projectileInfo: {
        name: "bolt",
        model: "",
        flags: 1,
        gravity: Math.fround(0.25),
        damage: 75,
        radius: Math.fround(12.5),
        visibleDamage: 6,
        damageType: 3,
        healthIncrease: -2,
        push: Math.fround(4.5),
        detonation: Math.fround(5.5),
        bounce: Math.fround(0.75),
        bounceFriction: Math.fround(0.125),
        bounceStop: Math.fround(0.0625),
      },
    });
    expect(Object.isFrozen(weapon)).toBe(true);
    expect(Object.isFrozen(weapon?.projectileInfo)).toBe(true);
  });

  test("uses the source projectile model field offset while preserving the weapon model", async () => {
    const resolver = new MemoryResolver([["weapons.c", COMPLETE_CONFIG]]);
    const { ai } = library(resolver);
    await ai.setup();

    expect(ai.config?.projectiles[0]?.model).toBe("");
    expect(ai.config?.weapons[1]?.model).toBe("models/weapons/alpha.md3");
  });

  test("projectile model alias writes and fixup copies the actual source record bytes", () => {
    const memory = new WeaponMemory();
    const resolver = new MemoryResolver([["weapons.c", 'projectileinfo { name "p" flags 1234 gravity 1 model "x" } weaponinfo { number 1 name "w" projectile "p" }']]);
    const { ai } = library(resolver, { memory, maxWeaponInfo: 2, maxProjectileInfo: 1 });
    expect(ai.setup()).toBe(WeaponLoadResult.NoError);
    const bytes = memory.bytes(0), projectileOffset = 16 + 2 * 552, embeddedOffset = 16 + 552 + 344;
    expect(bytes[projectileOffset + 80]).toBe(0);
    expect(bytes[projectileOffset + 88]).toBe(120);
    expect(ai.config?.projectiles[0]?.flags).toBe(0);
    expect(ai.config?.projectiles[0]?.gravity).toBe(0);
    expect(Array.from(bytes.subarray(embeddedOffset, embeddedOffset + 208))).toEqual(Array.from(bytes.subarray(projectileOffset, projectileOffset + 208)));
  });

  test("retained weapon strings preserve high source bytes without UTF-8 conversion", () => {
    const { ai } = library(new MemoryResolver([["weapons.c", 'projectileinfo { name "p\xff" model "\xfe" } weaponinfo { number 1 name "w\xff" projectile "p\xff" }']]));
    expect(ai.setup()).toBe(WeaponLoadResult.NoError);
    const bytes = ai.weaponInfoBytes(ai.allocateState(), 1);
    if (bytes === undefined) throw new Error("missing weapon record");
    expect(Array.from(bytes.subarray(8, 11))).toEqual([119, 255, 0]);
    expect(bytes[432]).toBe(254);
    expect(ai.config?.weapons[1]?.name).toBe("w\xff");
  });

  test("weapon shutdown frees the still-published config before states", () => {
    const memory = new WeaponMemory(), { ai } = library(new MemoryResolver([["weapons.c", COMPLETE_CONFIG]]), { memory });
    expect(ai.setup()).toBe(WeaponLoadResult.NoError);
    const config = ai.config, configBytes = memory.recorded[0]?.allocation;
    ai.allocateState();
    const state = memory.recorded[1]?.allocation;
    if (config === undefined || configBytes === undefined || state === undefined) throw new Error("missing weapon shutdown fixture");
    const free = memory.free.bind(memory);
    memory.free = allocation => {
      if (allocation === configBytes) expect(ai.config).toBe(config);
      if (allocation === state) expect(ai.config).toBeUndefined();
      free(allocation);
    };
    ai.shutdown();
    expect(memory.freed).toEqual([configBytes, state]);
  });

  test("weapon diagnostics distinguish source parser errors from ordinary print calls", () => {
    const cases: readonly { readonly source: string; readonly origin: "source" | "print" }[] = [
      { source: "unknown {}", origin: "print" }, { source: 'weaponinfo { bad 1 }', origin: "source" },
    ];
    for (const item of cases) {
      const { ai } = library(new MemoryResolver([["weapons.c", item.source]]));
      expect(ai.setup()).toBe(WeaponLoadResult.CannotLoadWeaponConfig);
      expect(ai.diagnostics.map(issue => issue.origin)).toEqual([item.origin, "print"]);
    }
    const { ai } = library(new MemoryResolver([["weapons.c", ""]]), { maxWeaponInfo: 0 });
    expect(ai.setup()).toBe(WeaponLoadResult.NoError);
    expect(ai.diagnostics.map(issue => issue.origin)).toEqual(["print", "print"]);
  });

  test("top-level source read failure finalizes parsed weapons but required-field failure does not", () => {
    const { ai } = library(new MemoryResolver([["weapons.c", `${COMPLETE_CONFIG}\n#error stopped\nunknown {}`]]));
    expect(ai.setup()).toBe(WeaponLoadResult.NoError);
    expect(ai.config?.weapons[1]?.name).toBe("Alpha");
    expect(ai.diagnostics.map(issue => issue.message)).toEqual(["#error directive: stopped", "loaded weapons.c"]);
    const { ai: incomplete } = library(new MemoryResolver([["weapons.c", 'weaponinfo { name\n#error stopped\n"unused" }']]));
    expect(incomplete.setup()).toBe(WeaponLoadResult.CannotLoadWeaponConfig);
    expect(incomplete.diagnostics[0]?.message).toBe("#error directive: stopped");
    expect(incomplete.diagnostics.at(-1)?.message).toBe("couldn't load the weapon config");
  });

  test("matches weapon weights and projectile links through decoded C string prefixes", async () => {
    const resolver = new MemoryResolver([
      ["weapons.c", 'projectileinfo { name "bolt\\0unused" damage 75 } weaponinfo { number 1 name "Alpha\\0Suffix" projectile "bolt\\0other" }'],
      ["weight.c", 'weight "Alpha" { return 10; }'],
    ]);
    const { ai } = library(resolver);
    expect(await ai.setup()).toBe(WeaponLoadResult.NoError);
    const handle = ai.allocateState();
    expect(ai.getWeaponInfo(handle, 1)?.name).toBe("Alpha");
    expect(ai.getWeaponInfo(handle, 1)?.projectileInfo.damage).toBe(75);
    expect(await ai.loadWeights(handle, "weight.c")).toBe(WeaponLoadResult.NoError);
    expect(ai.chooseBestFightWeapon(handle, [0])).toBe(1);
  });

  test("overwrites duplicate weapon numbers and links the first matching projectile", async () => {
    const source = [
      'projectileinfo { name "same" damage 1 }',
      'projectileinfo { name "same" damage 2 }',
      'weaponinfo { number 1 name "old" projectile "same" }',
      'weaponinfo { number 1 name "new" projectile "same" }',
    ].join("\n");
    const resolver = new MemoryResolver([["weapons.c", source]]);
    const { ai } = library(resolver);
    expect(await ai.setup()).toBe(WeaponLoadResult.NoError);

    expect(ai.config?.definedWeaponCount).toBe(1);
    expect(ai.config?.weapons[1]?.name).toBe("new");
    expect(ai.config?.weapons[1]?.projectileInfo.damage).toBe(1);
  });

  test("rejects malformed structures, unsafe integer fields, missing links, and capacities", async () => {
    const malformed = [
      "unknown {}",
      'projectileinfo { name "p" bad 1 }',
      'projectileinfo { name "p" } weaponinfo { number 32768 name "a" projectile "p" }',
      'projectileinfo { name "p" } weaponinfo { number 1 name "a" projectile "missing" }',
      'projectileinfo { name "p" } weaponinfo { number 1 projectile "p" }',
      'projectileinfo { name "p" } weaponinfo { number 1 name "a" }',
    ];
    for (const source of malformed) {
      const resolver = new MemoryResolver([["bad.c", source]]);
      const { ai } = library(resolver);
      expect(await ai.setup("bad.c")).toBe(WeaponLoadResult.CannotLoadWeaponConfig);
      expect(ai.diagnostics.some((diagnostic) => diagnostic.severity === "fatal")).toBe(true);
    }

    const projectileResolver = new MemoryResolver([["bad.c", 'projectileinfo { name "p" }']]);
    const projectileLibrary = library(projectileResolver, { maxProjectileInfo: 0 });
    expect(await projectileLibrary.ai.setup("bad.c")).toBe(WeaponLoadResult.CannotLoadWeaponConfig);

    const weaponResolver = new MemoryResolver([["bad.c", COMPLETE_CONFIG]]);
    const weaponLibrary = library(weaponResolver, { maxWeaponInfo: 1 });
    expect(await weaponLibrary.ai.setup("bad.c")).toBe(WeaponLoadResult.CannotLoadWeaponConfig);
  });

  test("validates source capacity inputs and preserves the negative-libvar fallback", async () => {
    const resolver = new MemoryResolver([["empty.c", ""]]);
    const corrected = library(resolver, { maxWeaponInfo: -1, maxProjectileInfo: -2 });
    expect(corrected.ai.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "max_weaponinfo = -1",
      "max_projectileinfo = -2",
    ]);
    expect(await corrected.ai.setup("empty.c")).toBe(WeaponLoadResult.NoError);
    expect(corrected.ai.config?.weaponCapacity).toBe(32);

    const zero = library(resolver, { maxWeaponInfo: 0, maxProjectileInfo: 0 });
    expect(await zero.ai.setup("empty.c")).toBe(WeaponLoadResult.NoError);
    expect(zero.ai.diagnostics.some((diagnostic) => diagnostic.message === "no weapon info loaded")).toBe(true);

    expect(() => library(resolver, { maxWeaponInfo: 0x80000000 })).toThrow("source signed 32-bit integer");
    expect(() => library(resolver, { maxProjectileInfo: Number.POSITIVE_INFINITY })).toThrow("finite integer");
    expect(() => library(resolver, { maxWeaponInfo: 1.5 })).toThrow("finite integer");
  });

  test("allocates and parses capacities above 32768 in the actual source hunk", () => {
    const arena = new HunkArena(32 * 1024 * 1024, () => {});
    const accounting = new SourceHunkAccounting(arena);
    const memory = new WeaponMemory({ kind: "source-hunk", accounting });
    const resolver = new MemoryResolver([["weapons.c", 'projectileinfo { name "p" damage 75 } weaponinfo { number 32767 name "last parsed" projectile "p" }']]);
    const { ai } = library(resolver, { memory, maxWeaponInfo: () => 32_769, maxProjectileInfo: () => 32_769 });
    expect(ai.setup()).toBe(WeaponLoadResult.NoError);
    expect(ai.config?.weaponCapacity).toBe(32_769);
    expect(memory.bytes(0)).toHaveLength(24_904_456);
    expect(accounting.report().trace[0]?.bytes).toBe(24_904_460);
    expect(arena.memoryRemaining()).toBe(32 * 1024 * 1024 - 24_904_480);
    const handle = ai.allocateState();
    expect(ai.getWeaponInfo(handle, 32_767)?.projectileInfo.damage).toBe(75);
    expect(ai.weaponInfoBytes(handle, 32_768)).toEqual(new Uint8Array(552));
    expect(ai.config?.projectiles[0]?.name).toBe("p");
    ai.shutdown();
  });

  test("source opening precedes actual hunk capacity failure without losing the prior config", () => {
    const arena = new HunkArena(1024, () => {});
    const memory = new WeaponMemory({ kind: "source-hunk", accounting: new SourceHunkAccounting(arena) });
    let capacity = 0;
    const { ai } = library(new MemoryResolver([["weapons.c", ""]]), {
      memory, preprocessor: { memory }, maxWeaponInfo: () => capacity, maxProjectileInfo: 0,
    });
    expect(ai.setup()).toBe(WeaponLoadResult.NoError);
    const prior = ai.config;
    capacity = 32_769;
    const before = memory.recorded.length;
    const frees = memory.frees.length;
    expect(() => ai.setup()).toThrow("Hunk_Alloc failed on 18088512");
    expect(ai.config).toBe(prior);
    expect(memory.recorded.slice(before).map(record => record.kind)).toEqual(["heap", "heap", "heap", "heap"]);
    expect(memory.frees).toHaveLength(frees);
    expect(ai.setup("missing.c")).toBe(WeaponLoadResult.CannotLoadWeaponConfig);
    expect(ai.diagnostics.at(-2)?.message).toBe("counldn't load missing.c");
    expect(memory.recorded).toHaveLength(before + 4);
  });

  test("wraps source allocation arithmetic without allocating oversized host tables", () => {
    const memory = new WeaponMemory({ kind: "source-hunk", accounting: new SourceHunkAccounting(new HunkArena(1024, () => {})) });
    const resolver = new MemoryResolver([["weapons.c", ""]]);
    const unusedProjectiles = library(resolver, { memory, maxWeaponInfo: 0, maxProjectileInfo: 0x10000000 });
    expect(unusedProjectiles.ai.setup()).toBe(WeaponLoadResult.NoError);
    expect(memory.recorded[0]?.size).toBe(16);
    const overflowingWeapons = library(resolver, { memory, maxWeaponInfo: 0x20000000, maxProjectileInfo: 0 });
    expect(overflowingWeapons.ai.setup()).toBe(WeaponLoadResult.CannotLoadWeaponConfig);
    expect(memory.recorded[1]?.size).toBe(16);
    expect(overflowingWeapons.ai.diagnostics[0]?.message).toBe("weapon validation exceeds the source configuration allocation");
    const negativeSize = library(resolver, { memory, maxWeaponInfo: 0, maxProjectileInfo: 0x08000000 });
    expect(negativeSize.ai.setup()).toBe(WeaponLoadResult.CannotLoadWeaponConfig);
    expect(negativeSize.ai.diagnostics[0]?.message).toContain("nonnegative source signed size");
    expect(memory.recorded).toHaveLength(2);
    const partialUnusedWeapon = library(resolver, { memory, maxWeaponInfo: 1, maxProjectileInfo: 144_542_166 });
    expect(partialUnusedWeapon.ai.setup()).toBe(WeaponLoadResult.NoError);
    expect(memory.recorded[2]?.size).toBe(24);
    expect(partialUnusedWeapon.ai.config?.weaponCapacity).toBe(1);
  });

  test("checks the reached projectile clear before reading its structure in a wrapped allocation", () => {
    for (const source of ["projectileinfo {}", 'projectileinfo { name "p" }', "projectileinfo\n#error not reached"]) {
      const memory = new WeaponMemory({ kind: "source-hunk", accounting: new SourceHunkAccounting(new HunkArena(1024, () => {})) });
      const { ai } = library(new MemoryResolver([["weapons.c", source]]), {
        memory, preprocessor: { memory }, maxWeaponInfo: 0, maxProjectileInfo: 0x10000000,
      });
      expect(ai.setup()).toBe(WeaponLoadResult.CannotLoadWeaponConfig);
      expect(memory.recorded.at(-1)?.size).toBe(16);
      expect(ai.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
        "projectile clear exceeds the source configuration allocation", "couldn't load the weapon config",
      ]);
      expect(memory.frees).toEqual([]);
      expect(ai.config).toBeUndefined();
    }
  });

  test("capacity equality aliases projectile storage while unterminated paths stay explicit", async () => {
    const resolver = new MemoryResolver([["weapons.c", COMPLETE_CONFIG]]);
    const { ai } = library(resolver, { maxWeaponInfo: 2 });
    expect(await ai.setup()).toBe(WeaponLoadResult.NoError);
    const handle = ai.allocateState();

    expect(ai.getWeaponInfo(handle, 1)?.name).toBe("Alpha");
    const sourceBytes = ai.weaponInfoBytes(handle, 2);
    if (sourceBytes === undefined) throw new Error("Expected aliased projectile storage");
    expect(sourceBytes.length).toBe(552);
    expect(sourceBytes.slice(0, 5)).toEqual(new Uint8Array([98, 111, 108, 116, 0]));
    expect(ai.getWeaponInfo(handle, 2)?.valid).toBe(true);
    expect(ai.getWeaponInfo(handle, 3)).toBeUndefined();
    expect(ai.diagnostics.at(-1)?.message).toBe("weapon number out of range");

    const exactPath = "a".repeat(63);
    resolver.sources.set(exactPath, COMPLETE_CONFIG);
    expect(await ai.setup(exactPath)).toBe(WeaponLoadResult.NoError);
    const bytePath = "\xe9".repeat(32);
    resolver.sources.set(bytePath, COMPLETE_CONFIG);
    expect(ai.setup(bytePath)).toBe(WeaponLoadResult.NoError);
    expect(() => ai.setup("a".repeat(64))).toThrow("63 source bytes");
    const short = library(resolver, { maxWeaponInfo: 2, maxProjectileInfo: 1 });
    expect(short.ai.setup()).toBe(WeaponLoadResult.NoError);
    expect(() => short.ai.weaponInfoBytes(short.ai.allocateState(), 2)).toThrow("exceeds the source configuration allocation");
  });
});

describe("source weapon state heap ownership", () => {
  test("config frees include and root storage before loaded publication and projectile fixups", () => {
    const memory = new WeaponMemory();
    const resolver = new MemoryResolver([["weapons.c", '#include "projectiles"\nweaponinfo { number 1 name "Alpha" projectile "bolt" }'],
      ["projectiles", 'projectileinfo { name "bolt" damage 75 }']]);
    const { ai } = library(resolver, { memory, preprocessor: { memory }, report: diagnostic => {
      if (diagnostic.severity === "message") {
        const releaseOrder = [7, 6, 5, 8, 9, 1, 0, 3, 2];
        expect(memory.freed).toHaveLength(releaseOrder.length);
        for (const [index, block] of releaseOrder.entries()) expect(memory.freed[index]).toBe(memory.recorded[block]?.allocation);
      }
      return undefined;
    } });
    expect(ai.setup()).toBe(WeaponLoadResult.NoError);
    expect(ai.config?.weapons[1]?.projectileInfo.damage).toBe(75);
    const broken = new WeaponMemory();
    const { ai: invalid } = library(new MemoryResolver([["weapons.c", '#pragma ignored\nweaponinfo { number 1 name "Alpha" projectile "missing" }']]), {
      memory: broken, preprocessor: { memory: broken }, report: diagnostic => {
        if (diagnostic.severity === "warning") expect(broken.frees).toEqual([]);
        if (diagnostic.severity === "error") {
          const releaseOrder = [5, 6, 7, 1, 0, 3, 2];
          expect(broken.freed).toHaveLength(releaseOrder.length);
          for (const [index, block] of releaseOrder.entries()) expect(broken.freed[index]).toBe(broken.recorded[block]?.allocation);
        }
        return undefined;
      },
    });
    expect(invalid.setup()).toBe(WeaponLoadResult.CannotLoadWeaponConfig);
    expect(invalid.diagnostics.map(diagnostic => diagnostic.severity)).toEqual(["warning", "error", "fatal"]);
    expect(broken.freed).toHaveLength(8);
    expect(broken.freed[7]).toBe(broken.recorded[4]?.allocation);
  });

  test("config parse errors report before freeing config and source", () => {
    for (const source of ["unknown {}", 'weaponinfo { bad 1 }', 'projectileinfo { name "p" bad 1 }']) {
      const memory = new WeaponMemory();
      const tokenFrees = source.startsWith("projectileinfo") ? [5] : [];
      const { ai } = library(new MemoryResolver([["weapons.c", source]]), { memory, preprocessor: { memory }, report: diagnostic => {
        if (diagnostic.severity === "error") expect(memory.frees).toEqual(tokenFrees);
        return undefined;
      } });
      expect(ai.setup()).toBe(WeaponLoadResult.CannotLoadWeaponConfig);
      const releaseOrder = [...tokenFrees, 4, 1, 0, 3, 2];
      expect(memory.freed).toHaveLength(releaseOrder.length);
      for (const [index, block] of releaseOrder.entries()) expect(memory.freed[index]).toBe(memory.recorded[block]?.allocation);
    }
  });

  test("config diagnostic and allocation aborts preserve reached source ownership", () => {
    const diagnostic = { severity: "error", message: "callback abort", location: { path: "callback", line: 1, column: 1 } } satisfies ConstructorParameters<typeof ScriptLanguageError>[0];
    const aborted = new ScriptLanguageError(diagnostic, [diagnostic]);
    for (const duringPreprocessing of [false, true]) {
      const memory = new WeaponMemory();
      const { ai } = library(new MemoryResolver([["weapons.c", duringPreprocessing ? "#error stop\n" : "unknown {}"]]), {
        memory,
        preprocessor: { memory, report: () => { if (duringPreprocessing) throw aborted; } },
        report: () => { throw aborted; },
      });
      let thrown: unknown;
      try { ai.setup(); } catch (error) { thrown = error; }
      expect(thrown).toBe(aborted);
      expect(memory.frees).toEqual([]);
      expect(memory.bytes(0).length).toBeGreaterThan(2148);
    }
    const memory = new WeaponMemory();
    const allocate = memory.allocate.bind(memory), allocationAbort = new CommonError("drop", "hunk allocation abort");
    memory.allocate = (size, kind, clear) => {
      if (kind === "hunk") throw allocationAbort;
      return allocate(size, kind, clear);
    };
    const { ai } = library(new MemoryResolver([["weapons.c", ""]]), { memory, preprocessor: { memory } });
    expect(() => ai.setup()).toThrow(allocationAbort);
    expect(memory.recorded).toHaveLength(4);
    expect(memory.frees).toEqual([]);
  });

  test("uses cleared state and index bytes, retains reset and frees source dependencies first", () => {
    const zone = new ZoneArena(8192);
    const memory = new WeaponMemory(undefined, zone);
    const resolver = new MemoryResolver([
      ["weapons.c", `${COMPLETE_CONFIG}\n${SECOND_WEAPON}`],
      ["weight.c", 'weight "Alpha" return 10; weight "Beta" return 20;'],
    ]);
    const weights = new WeightConfigStore(resolver, { memory, reloadCharacters: true });
    const ai = new WeaponAi({ resolver, weights }, { memory, maxWeaponInfo: 3 });
    expect(ai.setup()).toBe(WeaponLoadResult.NoError);
    const handle = ai.allocateState();
    expect(memory.recorded[1]).toMatchObject({ size: 8, kind: "heap", clear: true });
    expect(Array.from(memory.bytes(1))).toEqual(new Array<number>(8).fill(0));
    expect(ai.loadWeights(handle, "weight.c")).toBe(WeaponLoadResult.NoError);
    expect(memory.recorded[7]).toMatchObject({ size: 12, kind: "heap", clear: true });
    const state = memory.view(1), indexes = memory.view(7);
    expect(state.getUint32(0, true)).toBeGreaterThan(0);
    expect(state.getUint32(4, true)).toBeGreaterThan(0);
    expect([0, 4, 8].map(offset => indexes.getInt32(offset, true))).toEqual([-1, 0, 1]);
    expect(ai.chooseBestFightWeapon(handle, [0])).toBe(2);
    indexes.setInt32(8, -1, true);
    expect(ai.chooseBestFightWeapon(handle, [0])).toBe(1);
    const beforeReset = memory.bytes(1).slice();
    ai.resetState(handle);
    expect(memory.bytes(1)).toEqual(beforeReset);
    const configPointer = state.getUint32(0, true);
    state.setUint32(0, 0, true);
    expect(ai.chooseBestFightWeapon(handle, [0])).toBe(0);
    state.setUint32(0, configPointer, true);
    ai.freeState(handle);
    expect(memory.frees).toEqual([4, 3, 6, 5, 2, 7, 1]);
    expect(() => memory.bytes(1)).toThrow();
    expect(() => memory.bytes(7)).toThrow();
    expect(zone.memoryRemaining()).toBe(8192);
    expect(ai.allocateState()).toBe(handle);
    ai.shutdown();
    expect(zone.memoryRemaining()).toBe(8192);
  });

  test("keeps cached configuration pointer identity across states and direct mutation", () => {
    const memory = new WeaponMemory(undefined, new ZoneArena(8192));
    const resolver = new MemoryResolver([["weapons.c", COMPLETE_CONFIG], ["weight.c", 'weight "Alpha" return balance(10, 0, 20);']]);
    const weights = new WeightConfigStore(resolver, { memory });
    const ai = new WeaponAi({ resolver, weights }, { memory, maxWeaponInfo: 2 });
    ai.setup();
    const first = ai.allocateState(), second = ai.allocateState();
    ai.loadWeights(first, "weight.c");
    ai.loadWeights(second, "weight.c");
    expect(memory.view(1).getUint32(0, true)).toBe(memory.view(2).getUint32(0, true));
    expect(ai.chooseBestFightWeapon(second, [0])).toBe(1);
    weights.load("weight.c").scaleWeight("Alpha", 0);
    expect(ai.chooseBestFightWeapon(first, [0])).toBe(0);
    expect(ai.chooseBestFightWeapon(second, [0])).toBe(0);
    ai.freeState(first);
    ai.freeState(second);
    weights.shutdown();
  });

  test("publishes loaded weights before missing config and real index allocation exhaustion", () => {
    const resolver = new MemoryResolver([["weapons.c", COMPLETE_CONFIG], ["weight.c", 'weight "Alpha" return 10;']]);
    const memory = new WeaponMemory(undefined, new ZoneArena(8192));
    const weights = new WeightConfigStore(resolver, { memory, reloadCharacters: true });
    const ai = new WeaponAi({ resolver, weights }, { memory });
    const handle = ai.allocateState();
    expect(ai.loadWeights(handle, "weight.c")).toBe(WeaponLoadResult.CannotLoadWeaponConfig);
    expect(memory.view(0).getUint32(0, true)).toBeGreaterThan(0);
    expect(memory.view(0).getUint32(4, true)).toBe(0);
    expect(memory.frees).toEqual([]);
    ai.freeState(handle);
    expect(memory.frees).toEqual([3, 2, 1, 0]);

    const zone = new ZoneArena(1292);
    const limited = new WeaponMemory(undefined, zone);
    const limitedWeights = new WeightConfigStore(resolver, { memory: limited, reloadCharacters: true });
    const limitedAi = new WeaponAi({ resolver, weights: limitedWeights }, { memory: limited });
    limitedAi.setup();
    const limitedHandle = limitedAi.allocateState();
    expect(() => limitedAi.loadWeights(limitedHandle, "weight.c")).toThrow("Z_Malloc: failed on allocation of 156 bytes");
    expect(limited.recorded.map(record => record.size)).toEqual([24336, 8, 1092, 6, 32]);
    expect(limited.view(1).getUint32(0, true)).toBeGreaterThan(0);
    expect(limited.view(1).getUint32(4, true)).toBe(0);
    expect(limited.frees).toEqual([]);
    expect(zone.memoryRemaining()).toBe(32);
    limitedAi.freeState(limitedHandle);
    expect(limited.frees).toEqual([4, 3, 2, 1]);
    expect(zone.memoryRemaining()).toBe(1292);
  });

  test("keeps the index and state owned when the reached zone free fails", () => {
    const zone = new ZoneArena(8192), memory = new WeaponMemory(undefined, zone);
    const resolver = new MemoryResolver([["weapons.c", COMPLETE_CONFIG], ["weight.c", 'weight "Alpha" return 10;']]);
    const weights = new WeightConfigStore(resolver, { memory, reloadCharacters: true });
    const ai = new WeaponAi({ resolver, weights }, { memory, maxWeaponInfo: 3 });
    ai.setup();
    const handle = ai.allocateState();
    ai.loadWeights(handle, "weight.c");
    const state = memory.view(1), indexPointer = state.getUint32(4, true);
    const bytes = memory.bytes(5);
    const trailer = new DataView(bytes.buffer, bytes.byteOffset + bytes.byteLength, 4);
    const sentinel = trailer.getInt32(0, true);
    trailer.setInt32(0, 0, true);
    expect(() => ai.freeState(handle)).toThrow("Z_Free: memory block wrote past end");
    expect(memory.frees).toEqual([4, 3, 2]);
    expect(state.getUint32(0, true)).toBe(0);
    expect(state.getUint32(4, true)).toBe(indexPointer);
    expect(memory.bytes(1).length).toBe(8);
    trailer.setInt32(0, sentinel, true);
    ai.freeState(handle);
    expect(memory.frees).toEqual([4, 3, 2, 5, 1]);
    expect(zone.memoryRemaining()).toBe(8192);
  });

  test("failed state allocation leaves handles reusable and live views reject retired zones", () => {
    const zone = new ZoneArena(128), memory = new WeaponMemory(undefined, zone);
    const { ai } = library(new MemoryResolver(), { memory });
    expect(ai.allocateState()).toBe(1);
    expect(() => ai.allocateState()).toThrow("Z_Malloc: failed on allocation of 36 bytes");
    ai.freeState(1);
    expect(ai.allocateState()).toBe(1);
    zone.dispose();
    expect(() => ai.freeState(1)).toThrow("Zone allocation is no longer valid");
  });
});

describe("bot weapon state and fuzzy choice", () => {
  test("allocates all source handles, reports exhaustion, frees, and reuses", () => {
    const { ai } = library(new MemoryResolver());
    const handles = Array.from({ length: MAX_WEAPON_STATES }, () => ai.allocateState());
    expect(handles).toEqual(Array.from({ length: MAX_WEAPON_STATES }, (_, index) => index + 1));
    expect(ai.allocateState()).toBe(0);
    ai.freeState(12);
    expect(ai.allocateState()).toBe(12);
    ai.freeState(0);
    expect(ai.diagnostics.at(-1)?.severity).toBe("fatal");
  });

  test("uses strict-greater source order and reset preserves loaded weights", async () => {
    const resolver = new MemoryResolver([
      ["weapons.c", `${COMPLETE_CONFIG}\n${SECOND_WEAPON}`],
      ["equal.c", 'weight "Alpha" { return 10; } weight "Beta" { return 10; }'],
      ["zero.c", 'weight "Alpha" { return 0; } weight "Beta" { return 0; }'],
    ]);
    const { ai } = library(resolver);
    await ai.setup();
    const handle = ai.allocateState();

    expect(await ai.loadWeights(handle, "equal.c")).toBe(WeaponLoadResult.NoError);
    expect(ai.chooseBestFightWeapon(handle, [0])).toBe(1);
    ai.resetState(handle);
    expect(ai.chooseBestFightWeapon(handle, [0])).toBe(1);
    ai.freeWeights(handle);
    expect(ai.chooseBestFightWeapon(handle, [0])).toBe(0);

    expect(await ai.loadWeights(handle, "zero.c")).toBe(WeaponLoadResult.NoError);
    expect(ai.chooseBestFightWeapon(handle, [0])).toBe(0);
  });

  test("returns source error codes for invalid states, failed weights, and setup ordering", async () => {
    const resolver = new MemoryResolver([
      ["weapons.c", COMPLETE_CONFIG],
      ["weight.c", 'weight "Alpha" { return 10; }'],
      ["malformed.c", 'weight "unterminated'],
    ]);
    const { ai } = library(resolver);
    const handle = ai.allocateState();

    expect(await ai.loadWeights(handle, "weight.c")).toBe(WeaponLoadResult.CannotLoadWeaponConfig);
    expect(await ai.loadWeights(0, "weight.c")).toBe(WeaponLoadResult.CannotLoadWeaponWeights);
    expect(await ai.loadWeights(handle, "missing.c")).toBe(WeaponLoadResult.CannotLoadWeaponWeights);
    expect(await ai.loadWeights(handle, "malformed.c")).toBe(WeaponLoadResult.CannotLoadWeaponWeights);
    expect(ai.diagnostics.at(-1)).toMatchObject({ severity: "fatal", message: "couldn't load weapon config malformed.c" });
    expect(ai.chooseBestFightWeapon(handle, [0])).toBe(0);
  });

  test("weight resolver and loaded-print aborts propagate after releasing prior weights", () => {
    const diagnostic = { severity: "error", message: "weight callback abort", location: { path: "callback", line: 1, column: 1 } } satisfies ConstructorParameters<typeof ScriptLanguageError>[0];
    for (const failure of [new Error("weight callback abort"), new ScriptLanguageError(diagnostic, [diagnostic])]) for (const boundary of ["resolver", "loaded-print"]) {
      const resolver = new ReentrantResolver([
        ["weapons.c", COMPLETE_CONFIG],
        ["old.c", 'weight "Alpha" return 10;'],
        ["new.c", 'weight "Alpha" return 20;'],
      ]);
      let abort = false;
      resolver.beforeRead = path => {
        if (abort && boundary === "resolver" && path === "new.c") throw failure;
      };
      const weights = new WeightConfigStore(resolver, {
        reloadCharacters: true,
        print: (_severity, text) => {
          if (abort && boundary === "loaded-print" && text === "loaded new.c\n") throw failure;
          return undefined;
        },
      });
      const ai = new WeaponAi({ resolver, weights });
      expect(ai.setup()).toBe(WeaponLoadResult.NoError);
      const handle = ai.allocateState();
      expect(ai.loadWeights(handle, "old.c")).toBe(WeaponLoadResult.NoError);
      expect(ai.chooseBestFightWeapon(handle, [0])).toBe(1);
      const diagnostics = ai.diagnostics;
      abort = true;
      let caught: unknown;
      try { ai.loadWeights(handle, "new.c"); } catch (error) { caught = error; }
      expect(caught).toBe(failure);
      expect(ai.diagnostics).toEqual(diagnostics);
      expect(ai.chooseBestFightWeapon(handle, [0])).toBe(0);
      abort = false;
      expect(ai.loadWeights(handle, "new.c")).toBe(WeaponLoadResult.NoError);
      expect(ai.chooseBestFightWeapon(handle, [0])).toBe(1);
      ai.shutdown();
      weights.shutdown();
    }
  });

  test("reentrant source setup cannot publish into a replacement lifecycle", () => {
    const resolver = new ReentrantResolver([["old.c", "unknown {}"], ["new.c", COMPLETE_CONFIG + "\n" + SECOND_WEAPON]]);
    const { ai } = library(resolver);
    resolver.beforeRead = path => {
      if (path !== "old.c") return;
      resolver.beforeRead = () => {};
      ai.shutdown();
      expect(ai.setup("new.c")).toBe(WeaponLoadResult.NoError);
    };
    expect(ai.setup("old.c")).toBe(WeaponLoadResult.CannotLoadWeaponConfig);
    expect(ai.diagnostics.some(diagnostic => diagnostic.location.path === "old.c"
      && (diagnostic.severity === "error" || diagnostic.severity === "fatal"))).toBe(false);
    expect(ai.config?.definedWeaponCount).toBe(2);
  });

  test("reentrant weight read cannot clear a reused state", () => {
    const resolver = new ReentrantResolver([["weapons.c", COMPLETE_CONFIG], ["old-weight.c", "invalid"], ["new-weight.c", 'weight "Alpha" { return 20; }']]);
    const { ai } = library(resolver);
    expect(ai.setup()).toBe(WeaponLoadResult.NoError);
    const old = ai.allocateState(); let fresh = 0;
    resolver.beforeRead = path => {
      if (path !== "old-weight.c") return;
      resolver.beforeRead = () => {};
      ai.shutdown(); ai.setup(); fresh = ai.allocateState();
      expect(ai.loadWeights(fresh, "new-weight.c")).toBe(WeaponLoadResult.NoError);
    };
    expect(ai.loadWeights(old, "old-weight.c")).toBe(WeaponLoadResult.CannotLoadWeaponWeights);
    expect(fresh).toBe(old);
    expect(ai.diagnostics.some(diagnostic => diagnostic.location.path === "old-weight.c" && diagnostic.severity === "fatal")).toBe(false);
    expect(ai.chooseBestFightWeapon(fresh, [0])).toBe(1);
  });

});

const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retailAvailable = existsSync(join(retailRoot, "baseq3", "pak0.pk3"))
  && existsSync(join(retailRoot, "missionpack", "pak0.pk3"));

test.skipIf(!retailAvailable)("loads both retail weapon configurations and makes source-derived exact choices", async () => {
  const products: readonly Product[] = ["baseq3", "missionpack"];
  for (const product of products) {
    const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product });
    const resolver = new BotScriptSources(vfs, new ScriptGlobalDefines(), (_severity, text) => { throw new Error(text); }, (_text: string): undefined => undefined);
    const { ai } = library(resolver);
    expect(await ai.setup()).toBe(WeaponLoadResult.NoError);

    expect(ai.config?.definedWeaponCount).toBe(12);
    expect(ai.config?.projectiles).toHaveLength(12);
    expect(ai.config?.weapons[1]?.name).toBe("Gauntlet");
    expect(ai.config?.weapons[1]?.projectileInfo.damage).toBe(50);
    expect(ai.config?.weapons[5]?.name).toBe("Rocket Launcher");
    expect(ai.config?.weapons[5]?.speed).toBe(900);
    expect(ai.config?.weapons[5]?.projectileInfo).toMatchObject({ damage: 100, radius: 120, damageType: 3 });
    if (product === "missionpack") {
      expect(ai.config?.weapons[13]?.name).toBe("Chaingun");
    }

    const handle = ai.allocateState();
    expect(ai.loadWeights(handle, "bots/anarki_w.c")).toBe(WeaponLoadResult.NoError);
    const inventory = new Array<number>(256).fill(1);
    expect(ai.chooseBestFightWeapon(handle, inventory)).toBe(5);
    inventory[8] = 0;
    expect(ai.chooseBestFightWeapon(handle, inventory)).toBe(7);
  }
});
