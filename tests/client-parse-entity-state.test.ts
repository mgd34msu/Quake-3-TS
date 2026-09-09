import { expect, test } from "bun:test";
import { CommonError } from "../src/core/common-error.ts";
import { ClientActiveState } from "../src/engine/client-active.ts";

test("CL_GetParseEntityState rejects future cells, expires the exact ring boundary and copies retained cells", () => {
  const active = new ClientActiveState(() => undefined);
  expect(() => active.getParseEntityState(0)).toThrow(new CommonError("drop", "CL_GetParseEntityState: 0 >= 0"));
  active.parseEntitiesNumber = 2050;
  active.parseEntities.at(2049).number = 23;
  active.parseEntities.at(3).origin = { x: 4, y: 5, z: 6 };
  expect(active.getParseEntityState(2)).toBeNull();
  expect(active.getParseEntityState(1)).toBeNull();
  expect(active.getParseEntityState(2049)?.number).toBe(23);
  const oldest = active.getParseEntityState(3);
  expect(oldest?.origin).toEqual({ x: 4, y: 5, z: 6 });
  if (oldest === null) throw new Error("Expected retained oldest entity");
  expect(oldest.origin).not.toBe(active.parseEntities.at(3).origin);
  oldest.origin = { x: 100, y: 5, z: 6 };
  expect(active.parseEntities.at(3).origin.x).toBe(4);
  expect(() => active.getParseEntityState(2050)).toThrow("CL_GetParseEntityState: 2050 >= 2050");
});

test("CL_GetParseEntityState retains source masked negative indexes before the allocation fills", () => {
  const active = new ClientActiveState(() => undefined);
  active.parseEntities.at(-1).number = 31;
  expect(active.getParseEntityState(-1)?.number).toBe(31);
  expect(active.getParseEntityState(-2048)).toBeNull();
  active.clear();
  expect(active.getParseEntityState(-1)?.number).toBe(0);
});
