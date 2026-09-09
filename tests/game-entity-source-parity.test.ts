import { expect, test } from "bun:test";
import { vec3 } from "../src/core/math.ts";
import { EntityPool } from "../src/game/entities.ts";
import { debugLine, GameUtilityScratch } from "../src/game/utilities.ts";
import { BotDebugPolygons } from "../src/server/bot-debug.ts";
import { ENTITYNUM_WORLD } from "../src/shared/player-state.ts";

function fixture() {
  const messages: string[] = [];
  const pool = new EntityPool({ product: "baseq3", maxClients: 1, mapStartTime: 0,
    time: () => 100, link: () => {}, unlink: () => {}, print: message => { messages.push(message); } });
  return { pool, messages };
}

test("G_AddEvent reports zero without touching event fields or reading the clock", () => {
  const messages: string[] = [];
  let clockReads = 0;
  const pool = new EntityPool({ product: "baseq3", maxClients: 1, mapStartTime: 0,
    time: () => { clockReads++; return 100; }, link: () => {}, unlink: () => {},
    print: message => { messages.push(message); } });
  const entity = pool.spawn();
  entity.s.number = 97;
  entity.s.event = 17;
  entity.s.eventParm = 8;
  entity.eventTime = 42;
  const previousReads = clockReads;
  pool.addEvent(entity, 0, 9);
  expect(messages).toEqual(["G_AddEvent: zero event added for entity 97\n"]);
  expect([entity.s.event, entity.s.eventParm, entity.eventTime]).toEqual([17, 8, 42]);
  expect(clockReads).toBe(previousReads);
});

test("G_Spawn dumps every source slot before rejecting exhausted normal entities", () => {
  const { pool, messages } = fixture();
  while (pool.numEntities < ENTITYNUM_WORLD) pool.spawn();
  pool.at(0).classname = "player";
  pool.at(64).classname = "rocket";
  expect(() => pool.spawn()).toThrow("G_Spawn: no free entities");
  expect(messages).toHaveLength(1024);
  expect(messages[0]).toBe("   0: player\n");
  expect(messages[64]).toBe("  64: rocket\n");
  expect(messages[1022]).toBe("1022: (null)\n");
  expect(messages[1023]).toBe("1023: (null)\n");
  expect(pool.numEntities).toBe(ENTITYNUM_WORLD);
});

test("tv retains eight mutable binary32 vectors with independent game and string rings", () => {
  const { pool } = fixture();
  const scratch = pool.utilities;
  const first = scratch.tv(1 / 3, -0, 3);
  expect(first.x).toBe(Math.fround(1 / 3));
  expect(Object.is(first.y, -0)).toBe(true);
  first.z = 1 / 7;
  expect(first.z).toBe(Math.fround(1 / 7));
  for (let index = 0; index < 8; index++) scratch.vtos(vec3(index, 0, 0));
  for (let index = 0; index < 7; index++) expect(scratch.tv(index, 0, 0)).not.toBe(first);
  expect(first.x).toBe(Math.fround(1 / 3));
  expect(scratch.tv(19, 20, 21)).toBe(first);
  expect(first.x).toBe(19);
  const other = fixture().pool.utilities;
  expect(other.tv(1, 2, 3)).not.toBe(first);
  expect(first.x).toBe(19);
});

test("vtos preserves ring aliases, NUL termination, retained tails and overflow diagnostics", () => {
  const messages: string[] = [];
  const scratch = new GameUtilityScratch(message => { messages.push(message); });
  const first = scratch.vtos(vec3(12345.75, -23456.75, 34567.75));
  expect(first.readString()).toBe("(12345 -23456 34567)");
  const previousTail = first.bytes.slice(8);
  for (let index = 0; index < 7; index++) scratch.vtos(vec3(index, 0, 0));
  expect(scratch.vtos(vec3(1, 2, 3))).toBe(first);
  expect(first.readString()).toBe("(1 2 3)");
  expect(first.bytes[7]).toBe(0);
  expect(first.bytes.slice(8)).toEqual(previousTail);
  const wide = scratch.vtos(vec3(2_000_000_000, 2_000_000_000, 2_000_000_000));
  expect(messages).toEqual(["Com_sprintf: overflow of 34 in 32\n"]);
  expect(wide.readString()).toBe("(2000000000 2000000000 20000000");
  expect(wide.bytes[31]).toBe(0);
});

test("vtos reserves its ring slot before the overflow print callback and writes after it returns", () => {
  const messages: string[] = [];
  const aliases: ReturnType<GameUtilityScratch["vtos"]>[] = [];
  const scratch = new GameUtilityScratch(message => {
    messages.push(message);
    for (let index = 0; index < 8; index++) aliases.push(scratch.vtos(vec3(index, 1, 2)));
  });
  const wide = scratch.vtos(vec3(2_000_000_000, 2_000_000_000, 2_000_000_000));
  expect(messages).toEqual(["Com_sprintf: overflow of 34 in 32\n"]);
  expect(aliases[7]).toBe(wide);
  expect(aliases[7]?.readString()).toBe("(2000000000 2000000000 20000000");
  const firstAlias = aliases[0];
  if (firstAlias === undefined) throw new Error("Overflow callback did not reserve its first slot");
  expect(scratch.vtos(vec3(8, 9, 10))).toBe(firstAlias);
});

test("DebugLine uses the actual polygon owner and source horizontal, vertical and zero-length geometry", () => {
  const polygons = new BotDebugPolygons();
  expect(debugLine(vec3(0, 0, 0), vec3(4, 0, 0), 3, polygons)).toBe(0);
  polygons.initialize(4);
  const horizontal = debugLine(vec3(0, 0, 0), vec3(4, 0, 0), 3, polygons);
  expect(horizontal).toBe(1);
  expect(polygons.rows[horizontal]?.points.slice(0, 4)).toEqual([
    vec3(0, -2, 0), vec3(0, 2, 0), vec3(4, 2, 0), vec3(4, -2, 0),
  ]);
  const vertical = debugLine(vec3(1, 2, 3), vec3(1, 2, 13), 4, polygons);
  expect(polygons.rows[vertical]?.points.slice(0, 4)).toEqual([
    vec3(3, 2, 3), vec3(-1, 2, 3), vec3(-1, 2, 13), vec3(3, 2, 13),
  ]);
  const point = vec3(5, 6, 7), zero = debugLine(point, point, 5, polygons);
  expect(polygons.rows[zero]?.points.slice(0, 4)).toEqual([point, point, point, point]);
  expect(polygons.rows[zero]?.color).toBe(5);
  expect(polygons.rows[zero]?.numPoints).toBe(4);
  expect(debugLine(point, point, 6, polygons)).toBe(0);
});
