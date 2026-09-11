// DEBUG BotExportTest and map load fixtures from id Software's botlib/be_interface.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { expect, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { AasDebugGeometry } from "../src/botlib/aas-debug-geometry.ts";
import { AasDebugLines } from "../src/botlib/aas-debug.ts";
import type { AasWorld } from "../src/botlib/aas.ts";
import type { AasMapSpatialHost } from "../src/botlib/aas-runtime.ts";
import { BotLibrary } from "../src/botlib/library.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { vec3 } from "../src/core/math.ts";
import { blockChecksum } from "../src/core/md4.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { EntityPool } from "../src/game/entities.ts";
import { BotDebugPolygons } from "../src/server/bot-debug.ts";
import { ServerWorld } from "../src/server/world.ts";

test("explicit DEBUG profile reaches real Test drawing, goal, flood and load diagnostics", async () => {
  const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  const files = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "baseq3" });
  const bytes = files.readSync("maps/q3dm1.bsp"), bsp = parseBsp(bytes);
  const collision = new CollisionWorld(bsp, { kind: "unaccounted" }, { kind: "disabled" });
  const unused = (): never => { throw new Error("Unexpected DEBUG fixture service"); };
  const entities: EntityPool = new EntityPool({ print: () => undefined, product: "baseq3", maxClients: 4, mapStartTime: 0, time: () => 0,
    link: entity => { server.link(entity); }, unlink: entity => server.unlink(entity.slot) });
  const server: ServerWorld = new ServerWorld(collision, collision.modelBounds(0), number => entities.get(number),
    { loading: false, print: () => undefined, developerPrint: () => undefined });
  const spatialHost: AasMapSpatialHost = {
    print: () => undefined,
    trace: (start, end, bounds, passEntity, mask) => ({ ...server.trace({ start, end, passEntityNum: passEntity, mask,
      shape: bounds === null ? { kind: "point" } : { kind: "box", mins: bounds.min, maxs: bounds.max } }), contents: 0 }),
    entityTrace: (entity, start, end, bounds, mask) => ({ ...server.traceEntity(entity,
      { start, end, mask, shape: { kind: "box", mins: bounds.min, maxs: bounds.max } }), contents: 0 }),
    pointContents: point => server.pointContents(point, -1),
    modelBounds: model => ({ bounds: collision.modelBounds(model), origin: vec3(0, 0, 0) }),
  };
  try {
    for (const enabled of [false, true]) {
      const events: string[] = [], pool = new BotDebugPolygons();
      pool.initialize(2048);
      const lines = new AasDebugLines(pool, text => { events.push(text); });
      class ObservedGeometry extends AasDebugGeometry {
        override showAreaPolygons(world: AasWorld, area: number, color: number, ground: boolean): void {
          events.push(`area:${color}`);
          super.showAreaPolygons(world, area, color, ground);
        }
      }
      const geometry: AasDebugGeometry = new ObservedGeometry(lines, {
        polygonCreate: (color, count, points) => { events.push(`polygon:${color}`); return pool.create(color, count, points); },
        polygonDelete: handle => { events.push("delete"); pool.delete(handle); },
        print: (_severity, text) => { events.push(text); }, debugBuild: enabled, memory: () => library.memory,
      });
      let ticks = 0;
      const library: BotLibrary = new BotLibrary({ assets: () => files, random: new LinuxNativeRandom(1),
        print: (_severity, text) => { events.push(text); }, commonPrint: text => { events.push(text); },
        openLog: unused, openWrite: unused, milliseconds: () => { ticks += 7; return ticks; },
        movementDebug: lines.movement, permanentLine: unused, clientCommand: unused,
        ...(enabled ? { debugProfile: { kind: "source-debug", geometry,
          showLine: pool.lineShow.bind(pool), createLine: () => { events.push("line"); return pool.lineCreate(); } } } : {}),
      });
      try {
        expect(library.test()).toBe(0);
        expect(events).toEqual([]);
        const beforeFailedLoad = ticks;
        expect(library.loadMap(unused)).toBe(1);
        expect(ticks - beforeFailedLoad).toBe(enabled ? 7 : 0);
        expect(events).toEqual(["BotLoadMap: bot library used before being setup\n"]);
        events.length = 0;
        library.variables.set("maxclients", "4"); library.variables.set("maxentities", "16");
        expect(library.setup()).toBe(0);
        library.variables.set("sv_mapChecksum", String(blockChecksum(bytes) | 0));
        const beforeLoad = ticks;
        expect(library.loadMap({ name: "q3dm1", bsp, spatialHost })).toBe(0);
        expect(events.some(text => /^map loaded in \d+ msec\n$/.test(text))).toBe(enabled);
        if (enabled) expect(events.slice(-2)).toEqual(["-------------------------------------\n", `map loaded in ${ticks - beforeLoad - 7} msec\n`]);
        expect(library.startFrame(0.1)).toBe(0);
        const healthName = library.goals.itemConfig?.items.find(item => item.classname === "item_health")?.name;
        if (healthName === undefined) throw new Error("Expected retail health item definition");
        const health = library.goals.getLevelItemGoal(-1, healthName);
        if (health === null || health.area === 0) throw new Error("Expected loaded retail health goal");
        events.length = 0;
        const cvars = new CvarRegistry();
        cvars.set("bot_debug", "1"); cvars.set("bot_highlightarea", String(health.area));
        const draw = (buttons: number): void => {
          pool.draw(() => { events.push("draw"); }, 0, { cvars, library, botEnabled: () => true,
            clientCommandButtons: () => buttons,
            clientEntity: () => ({ currentOrigin: health.origin, currentAngles: vec3(0, 0, 0) }) });
        };
        draw(1);
        if (!enabled) {
          expect(events).toEqual([]);
          continue;
        }
        expect(events.slice(0, 2)).toEqual(["line", "line"]);
        expect(events[2]).toBe("\rtravel time to goal (0) = 0  ");
        expect(events.find(text => text.startsWith("new area "))).toStartWith(`new area ${health.area}, cluster `);
        const goalIndex = events.findIndex(text => text.startsWith("new goal "));
        const polygonIndex = events.findIndex(text => text.startsWith("area:"));
        expect(goalIndex).toBeGreaterThan(2);
        expect(polygonIndex).toBeGreaterThan(goalIndex);
        expect(events.lastIndexOf("draw")).toBeGreaterThan(polygonIndex);
        events.length = 0;
        draw(0);
        expect(events[0]).toBe(`\rtravel time to goal (${health.area}) = 1  `);
        expect(events.some(text => text.startsWith("new area "))).toBe(false);
        expect(events).not.toContain("line");
        library.variables.set("bot_flood", "1");
        geometry.showPolygon(7, 3, [vec3(0, 0, 0), vec3(10, 0, 0), vec3(0, 10, 0)]);
        events.length = 0;
        draw(0);
        expect(events.filter(text => text !== "draw")).toEqual([`\rtravel time to goal (${health.area}) = 1  `]);
        events.length = 0;
        draw(1);
        expect(events).toContain("delete");
        expect(events).toContain("area:1");
        expect(events.some(text => text.startsWith("new goal "))).toBe(false);
        library.variables.set("bot_flood", "0");
        const target = library.goals.itemConfig?.items.map(item => library.goals.getLevelItemGoal(-1, item.name))
          .find(goal => goal !== null && goal.area > 0 && goal.area !== health.area);
        if (target === null || target === undefined) throw new Error("Expected another retail item area");
        cvars.set("bot_highlightarea", String(target.area));
        events.length = 0;
        draw(0);
        expect(events).toContain("area:5");
        expect(lines.numDebugLines).toBeGreaterThan(0);
        cvars.set("bot_reachability", "1");
        library.startFrame(2);
        events.length = 0;
        draw(0);
        expect(events.some(text => text.startsWith("TRAVEL_"))).toBe(true);
        cvars.set("bot_reachability", "0");
        cvars.set("bot_highlightarea", "0");
        events.length = 0;
        draw(1);
        expect(events.some(text => text.startsWith("new goal "))).toBe(true);
        library.variables.set("bot_highlightarea", String(health.area));
        events.length = 0;
        library.test(1, null, vec3(1.25, -1.25, 0.75), vec3(0, 0, 0));
        expect(events).toContain(`new goal 1.2 -1.2 1.2 area ${health.area}\n`);
      } finally { library.disposeResources(); }
    }
  } finally { files.close(); }
});
