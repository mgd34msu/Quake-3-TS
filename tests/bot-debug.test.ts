import { describe, expect, test } from "bun:test";
import { BotLibrary } from "../src/botlib/library.ts";
import { BotLibVars } from "../src/botlib/libvars.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { BotDebugPolygons } from "../src/server/bot-debug.ts";
import type { BotDebugServices } from "../src/server/bot-debug.ts";
import { AasDebugLines } from "../src/botlib/aas-debug.ts";

function unexpectedDebugService(): never { throw new Error("Unexpected bot debug service call"); }

describe("BotDrawDebugPolygons", () => {
  test("unallocated storage returns before services; allocated empty storage gets only bot_debug", () => {
    const pool = new BotDebugPolygons();
    const services: BotDebugServices = {
      cvars: { register: unexpectedDebugService, get: unexpectedDebugService },
      library: { variables: new BotLibVars(), test: unexpectedDebugService },
      botEnabled: unexpectedDebugService, clientCommandButtons: unexpectedDebugService, clientEntity: unexpectedDebugService,
    };
    pool.draw(unexpectedDebugService, 9, services);
    const cvars = new CvarRegistry();
    pool.initialize(0);
    pool.draw(unexpectedDebugService, 9, { ...services, cvars, botEnabled: () => false });
    expect(cvars.get("bot_debug")?.value).toBe("0");
    expect(cvars.indexCount).toBe(1);
  });

  test("lazy cvars, live client inputs, Test and active rows retain source order", () => {
    const pool = new BotDebugPolygons(), cvars = new CvarRegistry(), variables = new BotLibVars();
    const events: string[] = [];
    const origin = vec3(12, 23, 34), angles = vec3(45, 56, 67);
    let buttons = 1, enable = true;
    const calls: { flags: number; text: string | null; origin: Vec3; angles: Vec3 }[] = [];
    cvars.set("bot_debug", "1");
    cvars.set("bot_reachability", "-1");
    cvars.set("bot_groundonly", "0");
    cvars.set("bot_highlightarea", "17");
    pool.initialize(3);
    pool.show(0, 7, 1, [vec3(1, 2, 3)]);
    pool.show(1, 8, 0, []);
    const services: BotDebugServices = {
      cvars: {
        register: (name, initial, flags) => { events.push(`get:${name}`); return cvars.register(name, initial, flags); },
        get: name => cvars.get(name),
      },
      library: { variables, test: (flags, text, point, direction) => {
        events.push("test"); calls.push({ flags, text, origin: point, angles: direction });
        pool.show(2, 9, 1, [vec3(4, 5, 6)]);
        return 0;
      } },
      botEnabled: () => { events.push("enable"); return enable; },
      clientCommandButtons: () => { events.push("buttons"); return buttons; },
      clientEntity: () => { events.push(`entity:${variables.getString("bot_highlightarea")}`); return { currentOrigin: origin, currentAngles: angles }; },
    };
    const drawn: { color: number; count: number; points: readonly Vec3[] }[] = [];
    pool.draw((color, count, points) => { events.push(`draw:${color}`); drawn.push({ color, count, points }); }, 99, services);
    expect(events).toEqual(["get:bot_debug", "enable", "get:bot_reachability", "get:bot_groundonly", "get:bot_highlightarea",
      "buttons", "entity:17", "test", "draw:7", "draw:8", "draw:9"]);
    expect(calls).toEqual([{ flags: 3, text: null, origin, angles }]);
    expect(calls[0]?.origin).toBe(origin);
    expect(calls[0]?.angles).toBe(angles);
    expect(drawn.map(row => [row.color, row.count])).toEqual([[7, 1], [8, 0], [9, 1]]);
    expect(drawn[0]?.points).toBe(pool.rows[0]?.points);
    expect(drawn[0]?.points).toHaveLength(128);
    cvars.set("bot_reachability", "0", true); cvars.set("bot_groundonly", "2", true);
    cvars.set("bot_highlightarea", "25", true); buttons = 2;
    events.length = 0;
    pool.draw(() => undefined, 0, services);
    expect(events).toEqual(["enable", "buttons", "entity:25", "test"]);
    expect(calls[1]?.flags).toBe(4);
    enable = false; events.length = 0;
    pool.draw(color => { events.push(`draw:${color}`); }, 0, services);
    expect(events).toEqual(["enable", "draw:7", "draw:8", "draw:9"]);
  });

  test("first-use registrations persist across allocation replacement without consuming later latches", () => {
    const pool = new BotDebugPolygons(), cvars = new CvarRegistry();
    const services: BotDebugServices = { cvars, library: { variables: new BotLibVars(), test: unexpectedDebugService },
      botEnabled: () => true, clientCommandButtons: unexpectedDebugService, clientEntity: unexpectedDebugService };
    pool.initialize(0);
    pool.draw(unexpectedDebugService, 0, services);
    cvars.register("bot_debug", "0", CvarFlag.Latch);
    cvars.set("bot_debug", "1");
    pool.initialize(1);
    pool.draw(unexpectedDebugService, 0, services);
    expect(cvars.get("bot_debug")?.value).toBe("0");
    expect(cvars.get("bot_debug")?.latchedValue).toBe("1");
    expect(cvars.get("bot_highlightarea")).toBeUndefined();
  });

  test("missing source client entity fails after the highlight write and before Test or drawing", () => {
    const pool = new BotDebugPolygons(), cvars = new CvarRegistry(), variables = new BotLibVars();
    const failure = new Error("Client 0 has no source gentity");
    cvars.set("bot_debug", "1"); cvars.set("bot_highlightarea", "42");
    pool.initialize(1); pool.show(0, 2, 0, []);
    expect(() => pool.draw(unexpectedDebugService, 0, { cvars, library: { variables, test: unexpectedDebugService },
      botEnabled: () => true, clientCommandButtons: () => 0, clientEntity: () => { throw failure; } })).toThrow(failure);
    expect(variables.getString("bot_highlightarea")).toBe("42");
  });
});

test("selected Unix BotExportTest returns zero before setup without reading arguments or requesting services", () => {
  const pool = new BotDebugPolygons();
  const lines = new AasDebugLines(pool, unexpectedDebugService);
  const library = new BotLibrary({ assets: unexpectedDebugService, random: new LinuxNativeRandom(1),
    print: unexpectedDebugService, commonPrint: unexpectedDebugService, openLog: unexpectedDebugService, openWrite: unexpectedDebugService,
    milliseconds: unexpectedDebugService, permanentLine: unexpectedDebugService,
    movementDebug: lines.movement, clientCommand: unexpectedDebugService });
  const unreadablePoint: Vec3 = { get x(): number { return unexpectedDebugService(); },
    get y(): number { return unexpectedDebugService(); }, get z(): number { return unexpectedDebugService(); } };
  try {
    expect(library.test(7, null, unreadablePoint, unreadablePoint)).toBe(0);
    expect(library.test(-1, "unused", unreadablePoint, unreadablePoint)).toBe(0);
    expect(library.isSetup).toBe(false);
  } finally { library.disposeResources(); }
  expect(() => library.test(0, null, vec3(0, 0, 0), vec3(0, 0, 0))).toThrow("disposed");
});

test("AAS movement lines retain source handles, colors and exhausted slot zero across clear", () => {
  const pool = new BotDebugPolygons();
  pool.initialize(2);
  const lines = new AasDebugLines(pool, () => { throw new Error("No diagnostic is expected"); });
  lines.movement.line(vec3(0, 0, 0), vec3(10, 0, 0), "red");
  lines.movement.line(vec3(0, 0, 0), vec3(0, 10, 0), "blue");
  expect(pool.rows[1]?.color).toBe(1);
  expect(pool.rows[0]?.color).toBe(3);
  expect(lines.numDebugLines).toBe(2);
  lines.movement.clearLines();
  expect(pool.rows[1]?.inuse).toBe(false);
  expect(pool.rows[0]?.inuse).toBe(true);
  lines.movement.line(vec3(0, 0, 0), vec3(0, 0, 10), "blue");
  expect(pool.rows[1]?.inuse).toBe(true);
  expect(pool.rows[1]?.color).toBe(3);
  expect(lines.numDebugLines).toBe(3);
});

describe("sv_bot debug polygons", () => {
  test("unallocated imports do not access polygon arguments", () => {
    const pool = new BotDebugPolygons();
    expect(pool.create(3, 129, [])).toBe(0);
    pool.show(-1, 3, 129, []);
    pool.delete(-1);
    pool.permanentLine(vec3(0, 0, 0), vec3(1, 0, 0), 2);
    expect(pool.rows).toEqual([]);
  });

  test("allocation skips zero and exhausted permanent lines replace zero", () => {
    const pool = new BotDebugPolygons();
    pool.initialize(2);
    expect(pool.rows).toHaveLength(2);
    expect(pool.rows[0]?.points).toHaveLength(128);
    expect(pool.rows[1]?.points[127]).toEqual(vec3(0, 0, 0));
    pool.permanentLine(vec3(0, 0, 0), vec3(10, 0, 0), 1);
    const first = pool.rows[1]?.points.slice(0, 4);
    pool.permanentLine(vec3(0, 0, 1), vec3(0, 0, 5), 2);
    pool.permanentLine(vec3(3, 0, 0), vec3(3, 4, 0), 3);
    expect(pool.rows[1]?.color).toBe(1);
    expect(pool.rows[1]?.points.slice(0, 4)).toEqual(first);
    expect(pool.rows[0]?.inuse).toBe(true);
    expect(pool.rows[0]?.color).toBe(3);
    expect(pool.rows[0]?.points.slice(0, 4)).toEqual([
      vec3(5, 0, 0), vec3(1, 0, 0), vec3(1, 4, 0), vec3(5, 4, 0),
    ]);
    expect(pool.lineCreate()).toBe(0);
  });

  test("line quads preserve horizontal, vertical and coincident source geometry", () => {
    const pool = new BotDebugPolygons();
    pool.initialize(2);
    const line = pool.lineCreate();
    pool.lineShow(line, vec3(0, 0, 0), vec3(10, 0, 0), 4);
    expect(pool.rows[line]?.points.slice(0, 4)).toEqual([
      vec3(0, -2, 0), vec3(0, 2, 0), vec3(10, 2, 0), vec3(10, -2, 0),
    ]);
    for (const height of [10, -10]) {
      pool.lineShow(line, vec3(0, 0, 0), vec3(0, 0, height), 5);
      expect(pool.rows[line]?.points.slice(0, 4)).toEqual([
        vec3(2, 0, 0), vec3(-2, 0, 0), vec3(-2, 0, height), vec3(2, 0, height),
      ]);
    }
    pool.lineShow(line, vec3(0, 0, 0), vec3(1, 0, 8), 5);
    expect(pool.rows[line]?.points.slice(0, 4)).toEqual([
      vec3(2, 0, 0), vec3(-2, 0, 0), vec3(-1, 0, 8), vec3(3, 0, 8),
    ]);
    pool.lineShow(line, vec3(0, 0, 0), vec3(1, 0, 7), 5);
    expect(pool.rows[line]?.points.slice(0, 4)).toEqual([
      vec3(0, -2, 0), vec3(0, 2, 0), vec3(1, 2, 7), vec3(1, -2, 7),
    ]);
    pool.lineShow(line, vec3(3, 4, 5), vec3(3, 4, 5), 6);
    expect(pool.rows[line]?.points.slice(0, 4)).toEqual(Array.from({ length: 4 }, () => vec3(3, 4, 5)));
  });

  test("copy rounds float cells, retains tails and reuses deleted storage", () => {
    const pool = new BotDebugPolygons();
    pool.initialize(3);
    const input = { x: 1.23456789, y: 2, z: 3 };
    const id = pool.create(7, 2, [input, vec3(8, 9, 10)]);
    const row = pool.rows[id];
    const point = row?.points[0];
    input.x = 99;
    expect(point?.x).toBe(Math.fround(1.23456789));
    pool.show(id, 8, 1, [vec3(4, 5, 6)]);
    expect(row?.points[0]).toBe(point);
    expect(point).toEqual(vec3(4, 5, 6));
    expect(row?.points[1]).toEqual(vec3(8, 9, 10));
    pool.lineDelete(id);
    expect(row?.inuse).toBe(false);
    expect(row?.color).toBe(8);
    expect(row?.numPoints).toBe(1);
    expect(pool.lineCreate()).toBe(id);
    expect(row?.numPoints).toBe(0);
    expect(row?.points[1]).toEqual(vec3(8, 9, 10));
    const points = Array.from({ length: 128 }, (_, index) => vec3(index, index + 1, index + 2));
    pool.show(id, 9, 128, points);
    expect(row?.numPoints).toBe(128);
    expect(row?.points[127]).toEqual(vec3(127, 128, 129));
  });

  test("reinitialization replaces and zeroes storage, including zero capacity", () => {
    const pool = new BotDebugPolygons();
    pool.initialize(2);
    pool.create(9, 1, [vec3(1, 2, 3)]);
    const oldRows = pool.rows;
    pool.initialize(2);
    expect(pool.rows).not.toBe(oldRows);
    expect(pool.rows[1]?.inuse).toBe(false);
    expect(pool.rows[1]?.color).toBe(0);
    expect(pool.rows[1]?.points[0]).toEqual(vec3(0, 0, 0));
    pool.initialize(0);
    expect(pool.lineCreate()).toBe(0);
    expect(() => pool.lineShow(0, vec3(0, 0, 0), vec3(1, 0, 0), 1)).toThrow(RangeError);
  });

  test("undefined source accesses reject after preceding metadata and copy writes", () => {
    const pool = new BotDebugPolygons();
    pool.initialize(2);
    expect(() => pool.show(2, 1, 0, [])).toThrow(RangeError);
    expect(() => pool.delete(-1)).toThrow(RangeError);
    expect(() => pool.create(9, 2, [vec3(1, 2, 3)])).toThrow(RangeError);
    expect(pool.rows[1]?.inuse).toBe(true);
    expect(pool.rows[1]?.color).toBe(9);
    expect(pool.rows[1]?.numPoints).toBe(2);
    expect(pool.rows[1]?.points[0]).toEqual(vec3(1, 2, 3));
    expect(pool.rows[1]?.points[1]).toEqual(vec3(0, 0, 0));
    expect(() => pool.show(0, 10, 129, [])).toThrow(RangeError);
    expect(pool.rows[0]?.numPoints).toBe(129);
    expect(pool.rows[0]?.inuse).toBe(true);
    expect(() => pool.initialize(-1)).toThrow(RangeError);
    expect(pool.rows).toEqual([]);
  });
});
