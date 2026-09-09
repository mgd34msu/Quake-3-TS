import { expect, test } from "bun:test";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";

test("BSP epairs retain source order, duplicate precedence, byte copies and numeric conversions", () => {
  const prints: string[] = [];
  const entities = new AasBspEntities((_severity, text) => { prints.push(text); });
  expect(entities.load('{ "key" "first" "key" "last" "origin" "1.25 -2.5 3" "partial" "4 bad 6" "number" "-12tail" } {}')).toBe(0);
  expect(entities.loaded).toBe(true);
  expect([entities.nextEntity(0), entities.nextEntity(1), entities.nextEntity(2)]).toEqual([1, 2, 0]);
  const output = new Uint8Array(8).fill(99);
  expect(entities.value(1, "key", output)).toBe(true);
  expect([...output]).toEqual([108, 97, 115, 116, 0, 0, 0, 0]);
  const short = new Uint8Array(3);
  expect(entities.value(1, "key", short)).toBe(true);
  expect([...short]).toEqual([108, 97, 0]);
  output.fill(99);
  expect(entities.value(1, "absent", output)).toBe(false);
  expect([...output]).toEqual([0, 99, 99, 99, 99, 99, 99, 99]);
  expect(entities.vector(1, "origin")).toEqual({ found: true, value: { x: 1.25, y: -2.5, z: 3 } });
  expect(entities.vector(1, "partial")).toEqual({ found: true, value: { x: 4, y: 0, z: 0 } });
  expect(entities.int(1, "number")).toEqual({ found: true, value: -12 });
  expect(entities.float(1, "number")).toEqual({ found: true, value: -12 });
  expect(entities.vector(1, "absent")).toEqual({ found: false, value: { x: 0, y: 0, z: 0 } });
  expect(prints).toEqual([]);
  entities.dump();
  expect(entities.loaded).toBe(false);
  expect(entities.nextEntity(0)).toBe(0);
  expect(entities.int(1, "number")).toEqual({ found: false, value: 0 });
  expect(prints).toEqual(["bsp entity out of range\n"]);
});

test("BSP malformed input clears epairs after reporting, and interrupted reporting retains partial state", () => {
  const prints: string[] = [];
  const entities = new AasBspEntities((_severity, text) => { prints.push(text); });
  expect(entities.load('{ "key" "value"')).toBe(0);
  expect(entities.loaded).toBe(true);
  expect(entities.nextEntity(0)).toBe(0);
  expect(prints).toEqual(["file entdata, line 1: missing }\n\n"]);
  entities.load('{}');
  expect(entities.nextEntity(0)).toBe(1);
  const stop = new Error("print interruption");
  const interrupted = new AasBspEntities(() => { throw stop; });
  expect(() => interrupted.load('{ "key" "value"')).toThrow(stop);
  expect(interrupted.loaded).toBe(false);
  expect(interrupted.nextEntity(0)).toBe(1);
  const output = new Uint8Array(6);
  expect(interrupted.value(1, "key", output)).toBe(true);
  expect([...output]).toEqual([118, 97, 108, 117, 101, 0]);
  interrupted.dump();
  expect(interrupted.nextEntity(0)).toBe(0);
});

test("BSP entity capacity reserves the source zero handle", () => {
  const prints: string[] = [];
  const entities = new AasBspEntities((_severity, text) => { prints.push(text); });
  entities.load("{}".repeat(2048));
  expect(entities.nextEntity(2046)).toBe(2047);
  expect(entities.nextEntity(2047)).toBe(0);
  expect(prints).toEqual(["too many entities in BSP file\n"]);
});
