import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { vec3 } from "../src/core/math.ts";
import { float32ToBits } from "../src/core/numeric.ts";
import { EntityPool } from "../src/game/entities.ts";
import { GameMemory } from "../src/game/memory.ts";
import { GameEntity } from "../src/game/state.ts";
import { gameAtof } from "../src/game/numeric.ts";
import { MAX_SPAWN_VARS, MAX_SPAWN_VARS_CHARS, SpawnParser, SpawnVariables, newSpawnString, parseSpawnField, spawnEntity, spawnEntities, spawnWorld } from "../src/game/spawn.ts";
import type { SpawnContext, SpawnHandler, SpawnPair, WorldspawnContext } from "../src/game/spawn.ts";
import { GameType, Weapon } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import type { ItemDefinition } from "../src/shared/items.ts";
import { ENTITYNUM_WORLD } from "../src/shared/player-state.ts";

function variables(text: string): SpawnVariables {
  const parsed = new SpawnParser(text).next();
  if (parsed === null) throw new Error("Spawn fixture has no entity");
  return parsed;
}

function fixture(product: Product = "baseq3", gameType = GameType.GT_FFA) {
  const linked: number[] = [], unlinked: number[] = [], warnings: string[] = [];
  const itemCalls: { readonly entity: GameEntity; readonly item: ItemDefinition; readonly variables: SpawnVariables }[] = [];
  const handlers = new Map<string, SpawnHandler>();
  const pool = new EntityPool({ print: text => { warnings.push(text); }, product, maxClients: 4, mapStartTime: 0, time: () => 100,
    link: entity => { linked.push(entity.slot); }, unlink: entity => { unlinked.push(entity.slot); } });
  const context: SpawnContext = { pool, memory: new GameMemory(() => 0, text => { warnings.push(text); }), product, gameType, handlers,
    spawnItem: (entity, item, variables) => { itemCalls.push({ entity, item, variables }); entity.item = item; },
    warn: message => { warnings.push(message); } };
  return { pool, context, handlers, linked, unlinked, warnings, itemCalls };
}

describe("G_ParseSpawnVars", () => {
  test("preserves ordered duplicates, raw quoted bytes, comments, empty values and multiline pairs", () => {
    const parser = new SpawnParser('/* comment */ {\n "Message" "first\r\nsecond"\n "message"\n "last" "empty" ""\n}\n // end\n { "x" "\xff" }\0ignored');
    const first = parser.next();
    if (first === null) throw new Error("missing first entity");
    expect(first.entries).toEqual([{ key: "Message", value: "first\r\nsecond" }, { key: "message", value: "last" }, { key: "empty", value: "" }]);
    expect(first.string("MESSAGE", "default")).toEqual({ present: true, value: "first\r\nsecond" });
    expect(first.string("empty", "default")).toEqual({ present: true, value: "" });
    expect(first.string("missing", "default")).toEqual({ present: false, value: "default" });
    expect(parser.next()?.entries).toEqual([{ key: "x", value: "\xff" }]);
    expect(parser.next()).toBeNull();
    expect(parser.next()).toBeNull();
  });

  test("source checks only first token character for opening and closing braces", () => {
    expect(variables('"{ignored" "x" "v" "}ignored"').entries).toEqual([{ key: "x", value: "v" }]);
    expect(() => variables('{ "x" "}value" }')).toThrow("closing brace without data");
    expect(() => variables('{ "x"')).toThrow("EOF without closing brace");
    expect(() => variables('not-a-brace')).toThrow("when expecting {");
    expect(() => variables('{ "x" "unterminated')).toThrow("EOF without closing brace");
    expect(new SpawnParser(" /* unfinished comment").next()).toBeNull();
  });

  test("native x86 COM_Parse treats high bytes as whitespace only outside quotes", () => {
    const parsed = variables('\x80{\xff key\x80value "quoted" "a\x80b\xffc" \x80}\xff');
    expect(parsed.entries).toEqual([{ key: "key", value: "value" }, { key: "quoted", value: "a\x80b\xffc" }]);
    for (let code = 128; code <= 255; code++) {
      const byte = String.fromCharCode(code);
      expect(variables(`${byte}{ key${byte}value }`).entries).toEqual([{ key: "key", value: "value" }]);
      expect(variables(`{ "key" "${byte}" }`).string("key", "").value).toBe(byte);
    }
  });

  test("64 variables accepted, the 65th rejected, and capacity resets for each entity", () => {
    const body = Array.from({ length: MAX_SPAWN_VARS }, (_, i) => `"k${i}" "v"`).join(" ");
    const parser = new SpawnParser(`{ ${body} } { ${body} }`);
    expect(parser.next()?.entries).toHaveLength(64);
    expect(parser.next()?.entries).toHaveLength(64);
    expect(() => variables(`{ ${body} "extra" "v" }`)).toThrow("MAX_SPAWN_VARS");
  });

  test("4096-byte storage includes every terminating NUL and counts Latin-1 bytes", () => {
    const long = "\xff".repeat(1023);
    const body = `"${long}" "${long}" "${long}" "${long}"`;
    const exact = variables(`{ ${body} }`);
    expect(exact.characterCount).toBe(MAX_SPAWN_VARS_CHARS);
    expect(() => variables(`{ ${body} "" "" }`)).toThrow("MAX_SPAWN_CHARS");
    expect(() => variables(`{ "x" "${"a".repeat(1024)}" }`)).toThrow("MAX_TOKEN_CHARS");
    expect(() => new SpawnParser('{ "x" "\u0100" }')).toThrow("byte characters");
  });

  test("constructed variables validate the same boundaries and own immutable records", () => {
    const pair = { key: "x", value: "first" }, entries = [pair];
    const vars = new SpawnVariables(entries);
    pair.value = "changed"; entries.push({ key: "other", value: "value" });
    expect(vars.entries).toEqual([{ key: "x", value: "first" }]);
    expect(() => new SpawnVariables([{ key: "x", value: "\0" }])).toThrow();
    expect(() => new SpawnVariables(Array.from({ length: 65 }, () => ({ key: "", value: "" })))).toThrow("MAX_SPAWN_VARS");
  });
});

describe("spawn query and field conversions", () => {
  test("QVM numeric regression: per-op rounding, exponent prefix and long integer wrap", () => {
    const vars = variables('{ "round" ".9" "exponent" "1e2" "integer" "9007199254740993" }');
    expect(float32ToBits(vars.float("round", "0").value)).toBe(1063675495);
    expect(vars.float("exponent", "0").value).toBe(1);
    expect(vars.int("integer", "0").value).toBe(1);
  });
  test("integer and float queries preserve presence and QVM decimal prefixes", () => {
    const vars = variables('{ "int" " -12.9tail" "float" "1.25e2junk" "bad" "oops" "overflow" "2147483648" }');
    expect(vars.int("int", "7")).toEqual({ present: true, value: -12 });
    expect(vars.float("float", "7")).toEqual({ present: true, value: 1.25 });
    expect(vars.int("bad", "7")).toEqual({ present: true, value: 0 });
    expect(vars.float("bad", "7")).toEqual({ present: true, value: 0 });
    expect(vars.int("absent", "42")).toEqual({ present: false, value: 42 });
    expect(vars.float("absent", "0.1")).toEqual({ present: false, value: Math.fround(0.1) });
    expect(vars.int("overflow", "0").value).toBe(-2147483648);
    expect(vars.float("absent", "0x1p2").value).toBe(0);
    expect(vars.float("absent", "nan").value).toBe(0);
    expect(vars.vector("absent", "1 infinity 3").value).toEqual(vec3(1, 0, 0));
  });

  test("SpawnVector always writes three values using QVM delimiter consumption", () => {
    const vars = variables('{ "partial" "1 2junk 3" "full" ".5 -2 3e2 trailing" }');
    expect(vars.vector("partial", "0 0 0")).toEqual({ present: true, value: vec3(1, 2, 0) });
    expect(vars.vector("full", "0 0 0")).toEqual({ present: true, value: vec3(0, 0, 0) });
    expect(vars.vector("missing", "oops")).toEqual({ present: false, value: vec3(0, 0, 0) });
    expect(() => vars.vector("missing", "1 2")).toThrow("backing string");
  });

  test("G_NewString expands newline and consumes other escapes in the source pool", () => {
    const memory = new GameMemory(() => 0, () => {});
    expect(newSpawnString("first\\nsecond", memory)).toBe("first\nsecond");
    expect(newSpawnString("a\\tb\\qz\\\\c", memory)).toBe("a\\b\\z\\c");
    expect(newSpawnString("trailing\\", memory)).toBe("trailing\\");
  });

  test("all 20 source field names map to their exact GameEntity fields", () => {
    const entries: readonly SpawnPair[] = [
      { key: "classname", value: "test" }, { key: "origin", value: "1 2 3" },
      { key: "model", value: "*2" }, { key: "model2", value: "model.md3" },
      { key: "spawnflags", value: "17" }, { key: "speed", value: "1.1" },
      { key: "target", value: "target" }, { key: "targetname", value: "targetname" },
      { key: "message", value: "a\\nb" }, { key: "team", value: "movers" },
      { key: "wait", value: "2.2" }, { key: "random", value: "3.3" },
      { key: "count", value: "4" }, { key: "health", value: "500" },
      { key: "light", value: "600" }, { key: "dmg", value: "75" },
      { key: "angles", value: "10 20 30" }, { key: "angle", value: "90.5" },
      { key: "targetShaderName", value: "old" }, { key: "targetShaderNewName", value: "new" },
    ];
    const entity = new GameEntity(64);
    const memory = new GameMemory(() => 0, () => {});
    for (const pair of entries) expect(parseSpawnField(pair.key.toUpperCase(), pair.value, entity, memory)).toBe(true);
    expect(entity.classname).toBe("test"); expect(entity.s.origin).toEqual(vec3(1, 2, 3));
    expect(entity.model).toBe("*2"); expect(entity.model2).toBe("model.md3");
    expect(entity.spawnflags).toBe(17); expect(entity.speed).toBe(Math.fround(1.1));
    expect(entity.target).toBe("target"); expect(entity.targetname).toBe("targetname");
    expect(entity.message).toBe("a\nb"); expect(entity.team).toBe("movers");
    expect(entity.wait).toBe(Math.fround(2.2)); expect(entity.random).toBe(Math.fround(3.3));
    expect(entity.count).toBe(4); expect(entity.health).toBe(500); expect(entity.damage).toBe(75);
    expect(entity.s.angles).toEqual(vec3(0, 90.5, 0)); expect(entity.angle).toBe(0);
    expect(entity.targetShaderName).toBe("old"); expect(entity.targetShaderNewName).toBe("new");
    expect(entity.s.constantLight).toBe(0); expect(entity.r.currentOrigin).toEqual(vec3(0, 0, 0));
    expect(parseSpawnField("unsupported", "value", entity, memory)).toBe(false);
    expect(() => parseSpawnField("origin", "1 2", entity, memory)).toThrow("backing string");
  });
});

describe("G_SpawnGEntityFromSpawnVars and G_CallSpawn", () => {
  test("real handler sees final fields, original variables and copied editor origin", () => {
    const { context, pool, handlers, linked } = fixture();
    const calls: { readonly entity: GameEntity; readonly variables: SpawnVariables }[] = [];
    handlers.set("test_entity", (entity, vars) => { calls.push({ entity, variables: vars }); entity.health += 10; });
    const vars = variables('{ "classname" "test_entity" "origin" "1 2 3" "health" "5" "HEALTH" "7" }');
    const result = spawnEntity(vars, context);
    expect(result.kind).toBe("dispatched");
    if (result.kind !== "dispatched") throw new Error("handler did not dispatch");
    expect(result.route).toBe("handler"); expect(result.entity).toBe(pool.at(64));
    expect(result.entity.health).toBe(17); expect(vars.int("health", "0").value).toBe(5);
    expect(result.entity.s.pos.base).toEqual(vec3(1, 2, 3));
    expect(result.entity.r.currentOrigin).toEqual(vec3(1, 2, 3));
    expect(result.entity.s.pos.base).not.toBe(result.entity.s.origin);
    expect(calls).toEqual([{ entity: result.entity, variables: vars }]);
    expect(linked).toEqual([]);
  });

  test("items precede registry handlers and the item list is product-specific", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const { context, handlers, itemCalls, warnings, pool } = fixture(product);
      const wrongRoute: number[] = [];
      handlers.set("weapon_rocketlauncher", entity => { wrongRoute.push(entity.slot); });
      const result = spawnEntity(variables('{ "classname" "weapon_rocketlauncher" }'), context);
      expect(result.kind).toBe("dispatched");
      if (result.kind !== "dispatched") throw new Error("item did not dispatch");
      expect(result.route).toBe("item"); expect(itemCalls[0]?.item.tag).toBe(Weapon.WP_ROCKET_LAUNCHER);
      const firstItem = itemCalls[0];
      if (firstItem === undefined) throw new Error("item handler did not run");
      expect(result.entity.item).toBe(firstItem.item); expect(wrongRoute).toEqual([]);
      const extra = spawnEntity(variables('{ "classname" "weapon_nailgun" }'), context);
      expect(extra.kind).toBe(product === "missionpack" ? "dispatched" : "unknown");
      expect(pool.at(extra.slot).inuse).toBe(product === "missionpack");
      expect(warnings.length).toBe(product === "missionpack" ? 0 : 1);
    }
  });

  test("unknown or missing classnames warn and free real pool records", () => {
    const { context, pool, warnings, unlinked } = fixture();
    const unknown = spawnEntity(variables('{ "classname" "not_implemented" }'), context);
    expect(unknown).toEqual({ kind: "unknown", slot: 64, classname: "not_implemented" });
    expect(pool.at(64).inuse).toBe(false); expect(pool.at(64).classname).toBe("freed");
    const missing = spawnEntity(variables("{ }"), context);
    expect(missing).toEqual({ kind: "unknown", slot: 64, classname: "noclass" });
    expect(warnings).toEqual(["not_implemented doesn't have a spawn function\n", "noclass doesn't have a spawn function\n"]);
    expect(unlinked).toEqual([64, 64]);
  });

  test("successful dispatch may deliberately free itself", () => {
    const { context, pool, handlers } = fixture();
    handlers.set("editor_marker", entity => { pool.free(entity); });
    const outcome = spawnEntity(variables('{ "classname" "editor_marker" }'), context);
    expect(outcome.kind).toBe("dispatched");
    if (outcome.kind !== "dispatched") throw new Error("handler not invoked");
    expect(outcome.classname).toBe("editor_marker"); expect(outcome.entity.inuse).toBe(false);
  });

  test("source filter matrix covers every product, mode and exclusion key", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      for (let mode = GameType.GT_FFA; mode < GameType.GT_MAX_GAME_TYPE; mode++) {
        for (const key of ["notsingle", "notteam", "notfree", "notta", "notq3a"]) {
          const { context, pool, handlers, warnings } = fixture(product, mode);
          handlers.set("test", entity => { entity.count++; });
          const outcome = spawnEntity(variables(`{ "classname" "test" "${key}" "1" }`), context);
          const filtered = key === "notsingle" ? mode === GameType.GT_SINGLE_PLAYER :
            key === "notteam" ? mode >= GameType.GT_TEAM : key === "notfree" ? mode < GameType.GT_TEAM :
              key === "notta" ? product === "missionpack" : product === "baseq3";
          expect(outcome.kind).toBe(filtered ? "filtered" : "dispatched");
          expect(pool.at(outcome.slot).inuse).toBe(!filtered);
          expect(warnings).toEqual([]);
        }
      }
    }
  });

  test("gametype filtering is case-sensitive substring matching, not token matching", () => {
    const { context, handlers } = fixture("baseq3", GameType.GT_TEAM);
    handlers.set("test", entity => { entity.count++; });
    expect(spawnEntity(variables('{ "classname" "test" "gametype" "teamtournament" }'), context).kind).toBe("dispatched");
    expect(spawnEntity(variables('{ "classname" "test" "gametype" "TEAM" }'), context).kind).toBe("filtered");
    expect(spawnEntity(variables('{ "classname" "test" "gametype" "" }'), context).kind).toBe("filtered");
    expect(spawnEntity(variables('{ "classname" "TEST" }'), context).kind).toBe("unknown");
  });

  test("rejecting an undefined source vector value releases the allocated slot", () => {
    const { context, pool, unlinked } = fixture();
    expect(() => spawnEntity(variables('{ "classname" "test" "origin" "1 2" }'), context)).toThrow("backing string");
    expect(pool.at(64).inuse).toBe(false);
    expect(unlinked).toEqual([64]);
  });
});

function worldFixture(product: Product = "baseq3") {
  const fixtureData = fixture(product);
  const effects: (readonly [string, string | number, string])[] = [];
  const world: WorldspawnContext = { pool: fixtureData.pool, startTime: 12345, motd: "server motd", restarted: 0, doWarmup: 0, warmupTime: 23,
    setConfigstring: (index, value) => { effects.push(["configstring", index, value]); },
    setCvar: (name, value) => { effects.push(["cvar", name, value]); },
    log: message => { effects.push(["log", "", message]); } };
  return { ...fixtureData, effects, world };
}

describe("SP_worldspawn and G_SpawnEntitiesFromString", () => {
  test("worldspawn side effects have exact source ordering, raw strings and defaults", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const { world, effects, pool, linked } = worldFixture(product);
      spawnWorld(variables('{ "classname" "WORLDSPAWN" "music" "music/a.wav music/b.wav" "message" "raw\\ntext" }'), world);
      expect(effects).toEqual([
        ["configstring", 20, "baseq3-1"], ["configstring", 21, "12345"],
        ["configstring", 2, "music/a.wav music/b.wav"], ["configstring", 3, "raw\\ntext"], ["configstring", 4, "server motd"],
        ["cvar", "g_gravity", "800"], ["cvar", "g_enableDust", "0"], ["cvar", "g_enableBreath", "0"], ["configstring", 5, ""],
      ]);
      expect(world.warmupTime).toBe(23);
      expect(pool.at(ENTITYNUM_WORLD).s.number).toBe(ENTITYNUM_WORLD);
      expect(pool.at(ENTITYNUM_WORLD).classname).toBe("worldspawn");
      expect(pool.at(ENTITYNUM_WORLD).inuse).toBe(false);
      expect(pool.at(ENTITYNUM_WORLD).r.model).toEqual({ kind: "box" });
      expect(pool.numEntities).toBe(64); expect(linked).toEqual([]);
    }
  });

  test("restart suppresses warmup; enabled warmup logs and writes -1", () => {
    for (const restarted of [0, 1]) {
      const { world, effects } = worldFixture();
      const settings = { ...world, restarted, doWarmup: 1 };
      spawnWorld(variables('{ "classname" "worldspawn" "gravity" "450" "enableDust" "1" "enableBreath" "2" }'), settings);
      expect(effects.slice(5, 8)).toEqual([["cvar", "g_gravity", "450"], ["cvar", "g_enableDust", "1"], ["cvar", "g_enableBreath", "2"]]);
      expect(settings.warmupTime).toBe(restarted === 1 ? 0 : -1);
      expect(effects.slice(8)).toEqual(restarted === 1 ? [["configstring", 5, ""], ["cvar", "g_restarted", "0"]] :
        [["configstring", 5, ""], ["configstring", 5, "-1"], ["log", "", "Warmup:\n"]]);
    }
  });

  test("first world entity is mandatory and initializes before later dispatch", () => {
    const { context, world, handlers, effects, pool, warnings } = worldFixture();
    const combined = { ...context, world };
    expect(() => spawnEntities("", combined)).toThrow("no entities");
    expect(() => spawnEntities('{ "classname" "test" }', combined)).toThrow("first entity");
    expect(effects).toEqual([]); expect(pool.numEntities).toBe(64);
    handlers.set("test", entity => {
      expect(effects).toHaveLength(9);
      expect(pool.at(ENTITYNUM_WORLD).classname).toBe("worldspawn");
      entity.health = 44;
    });
    const report = spawnEntities('{ "classname" "worldspawn" } { "classname" "test" } { "classname" "worldspawn" }', combined);
    expect(report.outcomes.map(outcome => outcome.kind)).toEqual(["dispatched", "unknown"]);
    expect(pool.at(64).health).toBe(44);
    expect(warnings).toEqual(["worldspawn doesn't have a spawn function\n"]);
    expect(() => spawnEntities('{ "classname" "worldspawn" }', { ...context, world: worldFixture().world })).toThrow("share an entity pool");
  });
});

const retailPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
test.skipIf(!existsSync(`${retailPath}/missionpack/pak0.pk3`))("parse every merged retail map entity string and exact source fields without claiming spawn handlers", async () => {
  const vfs = await VirtualFileSystem.openInspection({ dataPath: retailPath, homePath: retailPath, cdPath: null, product: "missionpack" });
  const maps = vfs.list("maps/").filter(path => path.endsWith(".bsp"));
  expect(maps.length).toBeGreaterThanOrEqual(57);
  const numbers: { readonly map: string; readonly field: string; readonly text: string; readonly actual: number }[] = [];
  let parsed = 0;
  for (const path of maps) {
    const memory = new GameMemory(() => 0, () => {});
    const bsp = parseBsp(await vfs.read(path), path);
    const parser = new SpawnParser(bsp.entities, path);
    const world = parser.next();
    expect(world?.string("classname", "").value).toBe("worldspawn");
    let count = 1;
    while (true) {
      const vars = parser.next();
      if (vars === null) break;
      const entity = new GameEntity(64);
      for (const pair of vars.entries) {
        parseSpawnField(pair.key, pair.value, entity, memory);
        const field = pair.key.toLowerCase();
        if (field === "speed" || field === "random" || field === "wait" || field === "angle") {
          numbers.push({ map: path, field, text: pair.value, actual: field === "angle" ? entity.s.angles.y : entity[field] });
        } else if (field === "origin" || field === "angles") {
          const [x, y, z] = pair.value.trim().split(/\s+/);
          if (x === undefined || y === undefined || z === undefined) throw new Error("retail vector fixture requires three components");
          numbers.push({ map: path, field: `${field}.x`, text: x, actual: entity.s[field].x },
            { map: path, field: `${field}.y`, text: y, actual: entity.s[field].y },
            { map: path, field: `${field}.z`, text: z, actual: entity.s[field].z });
        }
      }
      expect(vars.characterCount).toBeLessThanOrEqual(MAX_SPAWN_VARS_CHARS);
      count++;
    }
    expect(count).toBe(bsp.entityRecords.length);
    parsed += count;
  }
  expect(parsed).toBeGreaterThan(10_000);
  expect(numbers).toHaveLength(75854);
  let nativeGameDifferences = 0;
  for (const number of numbers) {
    expect(float32ToBits(number.actual)).toBe(float32ToBits(gameAtof(number.text)));
    if (float32ToBits(number.actual) !== float32ToBits(Math.fround(Number.parseFloat(number.text)))) nativeGameDifferences++;
  }
  expect(nativeGameDifferences).toBe(29);
  expect(numbers.filter(value => /[eE][+-]?\d/.test(value.text))).toHaveLength(0);
  expect(numbers.filter(value => /[+-]?(?:0x|inf|nan)/i.test(value.text.trim()))).toHaveLength(0);
  const oracle = process.env["QUAKE3_SPAWN_NUMERIC_ORACLE"];
  if (oracle !== undefined) {
    const processResult = Bun.spawnSync([oracle], { stdin: new TextEncoder().encode(numbers.map(value => value.text).join("\n") + "\n"), stdout: "pipe", stderr: "pipe" });
    if (processResult.exitCode !== 0) throw new Error(`spawn numeric oracle failed: ${new TextDecoder().decode(processResult.stderr)}`);
    const lines = new TextDecoder().decode(processResult.stdout).trim().split("\n");
    expect(lines).toHaveLength(numbers.length);
    // This comparison uses host-compiled bg_lib.c with 64-bit double. It does
    // not establish lcc/QVM parity, whose double intermediates are 32-bit.
    const differences: { readonly map: string; readonly field: string; readonly text: string; readonly nativeBits: number; readonly nativeCompiledBgLibBits: number }[] = [];
    for (const [index, value] of numbers.entries()) {
      const line = lines[index];
      if (line === undefined) throw new Error("missing native numeric result");
      const [native, compiledBgLib] = line.split(" ");
      if (native === undefined || compiledBgLib === undefined) throw new Error("invalid native numeric result");
      const nativeBits = Number(native), nativeCompiledBgLibBits = Number(compiledBgLib);
      expect(Number.isInteger(nativeBits) && Number.isInteger(nativeCompiledBgLibBits)).toBe(true);
      expect(float32ToBits(Math.fround(Number.parseFloat(value.text)))).toBe(nativeBits);
      if (nativeBits !== nativeCompiledBgLibBits) differences.push({ map: value.map, field: value.field, text: value.text, nativeBits, nativeCompiledBgLibBits });
    }
    expect(differences).toHaveLength(21);
    process.stdout.write(JSON.stringify({ maps: maps.length, entities: parsed, numericComponents: numbers.length, nativeGameDifferences,
      exponents: numbers.filter(value => /[eE][+-]?\d/.test(value.text)).length,
      hexOrNonfinite: numbers.filter(value => /[+-]?(?:0x|inf|nan)/i.test(value.text.trim())).length,
      nativeCompiledBgLibDifferences: differences.length, examples: differences.slice(0, 10) }) + "\n");
  }
}, 60_000);
