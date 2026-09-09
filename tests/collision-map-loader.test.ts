import { expect, test } from "bun:test";
import { ReadFileMemory } from "../src/assets/read-file-memory.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import { CollisionMapLoader } from "../src/collision/map-loader.ts";
import { CollisionCounters } from "../src/collision/counters.ts";
import { vec3 } from "../src/core/math.ts";
import { CollisionDebugSurface } from "../src/collision/patch.ts";
import { CollisionMapSettings } from "../src/collision/world.ts";
import { CommonError } from "../src/core/common-error.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { blockChecksum } from "../src/core/md4.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";

function fixture() {
  const bytes = renderBspFixture([{ shader: "test/wall", lightmap: -1 }, { shader: "test/wall", lightmap: -1 }], []);
  const contents = new Map([["maps/fixture.bsp", bytes]]);
  const arena = new HunkArena(1024 * 1024, () => undefined);
  const memory = new ReadFileMemory(() => arena);
  const accounting = new SourceHunkAccounting(arena);
  const cvars = new CvarRegistry(), events: string[] = [];
  const counters = new CollisionCounters();
  const debug = new CollisionDebugSurface({ cvars, print: () => undefined, developerPrint: () => undefined });
  const clearPatches = debug.clearLevelPatches.bind(debug);
  debug.clearLevelPatches = () => { events.push("clear"); return clearPatches(); };
  const files: RetainedFileReader = {
    readFileRetainedSync: name => {
      events.push(`read:${name}`);
      const source = contents.get(name);
      return source === undefined ? undefined : memory.read(source.length, output => output.set(source));
    },
    readFileRetained: async () => { throw new Error("CM_LoadMap must use its synchronous source read"); },
    freeFile: file => {
      events.push("free");
      expect(memory.loadStack).toBe(1);
      expect(file.bytes.length).toBeGreaterThan(0);
      memory.freeFile(file);
    },
  };
  const loader = new CollisionMapLoader({ files: () => files, memory: () => ({ kind: "source-hunk", accounting }),
    counters,
    debug: { kind: "shared", owner: debug, settings: new CollisionMapSettings(cvars) },
    developerPrint: text => {
      expect(cvars.get("cm_noAreas")).toBeDefined();
      expect(cvars.get("cm_noCurves")).toBeDefined();
      expect(cvars.get("cm_playerCurveClip")).toBeDefined();
      events.push(text);
    } });
  return { bytes, contents, arena, memory, accounting, cvars, events, loader, counters };
}

test("collision statistics share common lifetime across client reuse, map clear and replacement", () => {
  const f = fixture(), name = "maps/fixture.bsp";
  const server = f.loader.load(name, false);
  const query = { start: vec3(0, 0, 0), end: vec3(1, 0, 0), shape: { kind: "point" }, mask: 1 } satisfies Parameters<typeof server.world.trace>[0];
  server.world.trace(query);
  server.world.pointLeafnum(query.start);
  const client = f.loader.load(name, true);
  client.world.trace(query);
  expect(client.world.counters).toBe(f.counters);
  expect(f.counters.c_traces).toBe(2);
  expect(f.counters.c_brush_traces).toBe(0);
  f.loader.clear();
  expect(f.counters.c_traces).toBe(2);
  const replacement = f.loader.load(name, false);
  expect(replacement.world.counters).toBe(f.counters);
  replacement.world.trace(query);
  expect(f.counters.c_traces).toBe(3);
  expect(f.counters.c_pointcontents).toBe(1);
  f.counters.reset();
  expect(f.counters).toEqual(new CollisionCounters());
});

test("client reuses the actual server collision world before retained read or allocation", () => {
  const f = fixture(), name = "maps/fixture.bsp";
  const server = f.loader.load(name, false), before = f.accounting.report();
  expect(server.checksum).toBe(blockChecksum(f.bytes) | 0);
  expect(server.world.areaCount).toBe(2);
  expect(f.memory.loadStack).toBe(0);
  expect(f.memory.loadCount).toBe(1);
  expect(before.trace.some(row => row.preference === "temporary")).toBe(false);
  const client = f.loader.load(name, true);
  expect(client).toBe(server);
  expect(client.world).toBe(server.world);
  expect(f.memory.loadCount).toBe(1);
  expect(f.accounting.report()).toEqual(before);
  expect(f.events).toEqual([`CM_LoadMap( ${name}, 0 )\n`, "clear", `read:${name}`, "free", `CM_LoadMap( ${name}, 1 )\n`]);
});

test("server reloads and client-only loads do not establish a new client cache", () => {
  const f = fixture(), name = "maps/fixture.bsp";
  const first = f.loader.load(name, false), second = f.loader.load(name, false);
  expect(second.world).not.toBe(first.world);
  f.loader.clear();
  const client = f.loader.load(name, true), afterClient = f.accounting.report().trace.length;
  expect(client.world).not.toBe(second.world);
  expect(f.loader.load(name, true).world).not.toBe(client.world);
  expect(f.accounting.report().trace.length).toBeGreaterThan(afterClient);
  expect(f.memory.loadCount).toBe(4);
  expect(f.memory.loadStack).toBe(0);
});

test("failed case-sensitive loads invalidate the prior server map before attempting the read", () => {
  const f = fixture(), name = "maps/fixture.bsp";
  const server = f.loader.load(name, false);
  expect(() => f.loader.load("maps/Fixture.bsp", true)).toThrow(new CommonError("drop", "Couldn't load maps/Fixture.bsp"));
  expect(f.events.slice(-3)).toEqual(["CM_LoadMap( maps/Fixture.bsp, 1 )\n", "clear", "read:maps/Fixture.bsp"]);
  expect(f.loader.load(name, true).world).not.toBe(server.world);
  expect(f.memory.loadCount).toBe(2);
});

test("empty names reject before registration and malformed BSP retains its actual file allocation", () => {
  const f = fixture();
  expect(() => f.loader.load("", false)).toThrow(new CommonError("drop", "CM_LoadMap: NULL name"));
  expect(f.cvars.get("cm_noAreas")).toBeUndefined();
  expect(f.events).toEqual([]);
  f.contents.set("maps/bad.bsp", new Uint8Array([73, 66, 83, 80]));
  expect(() => f.loader.load("maps/bad.bsp", false)).toThrow();
  expect(f.memory.loadStack).toBe(1);
  expect(f.arena.snapshot().high.temp).toBeGreaterThan(0);
  f.loader.clear();
  expect(f.memory.loadStack).toBe(1);
  expect(f.events).not.toContain("free");
  f.memory.disposeResources();
});

test("server cache names retain the source MAX_QPATH truncation", () => {
  const f = fixture(), name = `maps/${"x".repeat(60)}.bsp`;
  f.contents.set(name, f.bytes);
  const server = f.loader.load(name, false);
  expect(f.loader.load(name.slice(0, 63), true)).toBe(server);
  expect(f.memory.loadCount).toBe(1);
  expect(f.loader.load(name, true).world).not.toBe(server.world);
  expect(f.memory.loadCount).toBe(2);
});
