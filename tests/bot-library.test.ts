import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import type { AasMapSpatialHost } from "../src/botlib/aas-runtime.ts";
import { BotLibrary } from "../src/botlib/library.ts";
import { AasDebugLines } from "../src/botlib/aas-debug.ts";
import { BotDebugPolygons } from "../src/server/bot-debug.ts";
import { TravelFlags } from "../src/botlib/routing.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { CommonError } from "../src/core/common-error.ts";
import { waitForCall } from "../src/core/call-steps.ts";
import { radiusFromBounds, vec3 } from "../src/core/math.ts";
import { blockChecksum } from "../src/core/md4.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { ZoneArena } from "../src/core/zone.ts";
import { EntityPool } from "../src/game/entities.ts";
import { ServerWorld } from "../src/server/world.ts";
import type { Product } from "../src/shared/definitions.ts";
import { qvmAasSyscall } from "../src/vm/aas-syscalls.ts";
import { qvmBotActionSyscall } from "../src/vm/bot-action-syscalls.ts";
import { QvmMemory } from "../src/vm/memory.ts";

test("pre-setup VM bot calls use lifetime globals and await actual command imports without input allocations", async () => {
  const events: string[] = [];
  const gate = Promise.withResolvers<undefined>();
  const debugLines = new AasDebugLines(new BotDebugPolygons(), text => { events.push(text); });
  const library = new BotLibrary({
    assets: () => { throw new Error("Pre-setup calls must not read files"); },
    random: new LinuxNativeRandom(1),
    print: (_severity, text) => { events.push(text); return undefined; },
    commonPrint: text => { events.push(text); return undefined; },
    openLog: () => { throw new Error("Pre-setup calls must not open logs"); },
    openWrite: () => { throw new Error("Pre-setup calls must not write files"); },
    milliseconds: () => 0, movementDebug: debugLines.movement,
    permanentLine: () => { throw new Error("Pre-setup calls must not draw"); },
    *clientCommand(client, command): ReturnType<BotLibrary["actions"]["commandCalls"]> {
      events.push(`enter ${client}:${command}`);
      yield* waitForCall(() => gate.promise);
      events.push(`leave ${client}:${command}`);
    },
  });
  const memory = new QvmMemory(new Uint8Array(256));
  const words = new DataView(new ArrayBuffer(16));
  const callAas = (trap: number): number | null => {
    words.setInt32(0, trap, true);
    return qvmAasSyscall("game", words, memory, library.aas, point => {
      events.push(`contents ${point.x},${point.y},${point.z}`);
      return 32;
    });
  };
  try {
    expect(library.setupStage).toBe("none");
    expect(library.actions.maxClients).toBe(0);
    expect(library.aas.maxEntities).toBe(0);
    expect(callAas(304)).toBe(0);
    expect(callAas(306)).toBe(0);
    words.setInt32(4, 2, true); words.setInt32(8, 32, true); words.setInt32(12, 48, true);
    expect(callAas(305)).toBe(0);
    expect(memory.view(32, 12).getFloat32(8, true)).toBe(-24);
    expect(memory.view(48, 12).getFloat32(8, true)).toBe(32);
    words.setInt32(4, 64, true);
    expect(callAas(309)).toBe(32);
    expect(callAas(317)).toBe(1);
    expect(events).toEqual(["contents 0,0,0", "contents 0,0,-2"]);
    expect(() => library.aas.entities).toThrow("allocation");
    words.setInt32(0, 406, true); words.setInt32(4, 0, true);
    expect(() => qvmBotActionSyscall("game", words, memory, library.actions)).toThrow("allocation");
    words.setInt32(0, 421, true); words.setInt32(4, -1, true); words.setFloat32(8, NaN, true);
    expect(qvmBotActionSyscall("game", words, memory, library.actions)).toBe(0);
    memory.writeString(96, "hello", 6);
    events.length = 0;
    for (const trap of [400, 401, 402]) {
      words.setInt32(0, trap, true); words.setInt32(4, 42, true); words.setInt32(8, 96, true);
      const pending = qvmBotActionSyscall("game", words, memory, library.actions);
      expect(pending).toBeInstanceOf(Promise);
      expect(events).toHaveLength((trap - 400) * 2 + 1);
      gate.resolve(undefined);
      expect(await pending).toBe(0);
    }
    expect(events).toEqual(["enter 42:say hello", "leave 42:say hello", "enter 42:say_team hello",
      "leave 42:say_team hello", "enter 42:hello", "leave 42:hello"]);
    expect(library.isSetup).toBe(false);
    expect(library.variables.get("maxclients")).toBeNull();
    expect(library.variables.get("maxentities")).toBeNull();
    expect(library.variables.get("saveroutingcache")).toBeNull();
    expect(() => library.actions.getInput(0, 0)).toThrow("allocation");
  } finally { library.disposeResources(); }
});

test("terminal bot disposal closes later owners after a failed libvar replacement", () => {
  const zone = new ZoneArena(65536), events: string[] = [];
  const closeFailure = new Error("bot log close failed");
  const unexpected = (): never => { throw new Error("Unexpected service during terminal bot disposal"); };
  const debug = new AasDebugLines(new BotDebugPolygons(), unexpected);
  const library = new BotLibrary({
    zone, assets: unexpected, random: new LinuxNativeRandom(1),
    print: (_severity, text) => { events.push(text); return undefined; },
    commonPrint: text => { events.push(text); return undefined; },
    openLog: () => ({ kind: "opened", stream: {
      write: unexpected, flush: unexpected,
      close: () => { events.push("close"); return { kind: "failed", error: closeFailure }; },
    } }),
    openWrite: unexpected, milliseconds: () => 0, movementDebug: debug.movement,
    permanentLine: unexpected, clientCommand: unexpected,
  });
  try {
    library.variables.set("log", "1");
    expect(library.log.open("botlib.log")).toEqual({ kind: "ok" });
    expect(library.globals.add("RETAINED 7")).toBe(true);
    library.variables.set("damaged", "17");
    expect(() => library.variables.set("damaged", "1".repeat(131072))).toThrow("Z_Malloc");
    events.length = 0;
    let failure: unknown = null;
    try { library.disposeResources(); } catch (error) { failure = error; }
    expect(events).toEqual(["close"]);
    expect(library.disposed).toBe(true);
    expect(library.log.filePointer()).toBeNull();
    expect(library.globals.snapshot().definitions).toEqual([]);
    expect(() => library.sources.freeSourceHandle(0)).toThrow("disposed");
    if (!(failure instanceof AggregateError)) throw new Error("Expected both cleanup failures");
    const cause: unknown = failure.cause, errors: unknown = failure.errors;
    expect(cause instanceof Error && cause.message.includes("freed")).toBe(true);
    expect(errors).toEqual([cause, closeFailure]);
    library.disposeResources();
    expect(events).toEqual(["close"]);
    zone.checkHeap();
  } finally {
    library.disposeResources();
    zone.dispose();
  }
});

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const cases: readonly { readonly product: Product; readonly mapName: string }[] = [
  { product: "baseq3", mapName: "q3dm1" }, { product: "missionpack", mapName: "mpteam1" },
];

for (const { product, mapName } of cases) {
  test.skipIf(!existsSync(join(dataPath, product, "pak0.pk3")))(`bot library loads and initializes installed ${product}/${mapName}`, async () => {
    const files = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    const output: string[] = [], commands: string[] = [];
    const random = new LinuxNativeRandom(1);
    const failure = new CommonError("drop", "interrupted bot item setup");
    let interruptItems = false;
    const polygons = new BotDebugPolygons();
    polygons.initialize(2);
    const debugLines = new AasDebugLines(polygons, text => { output.push(text); });
    const library = new BotLibrary({ assets: () => files, random,
      print: (_severity, text) => { output.push(text); if (interruptItems && text === "loaded items.c\n") throw failure; return undefined; },
      commonPrint: text => { output.push(text); return undefined; },
      openLog: () => { throw new Error("The disabled bot log must not open a file"); },
      openWrite: () => { throw new Error("Stored retail AAS must not request a file write"); },
      milliseconds: () => 0,
      movementDebug: debugLines.movement,
      permanentLine: () => { throw new Error("Stored retail AAS must not generate debug geometry"); },
      *clientCommand(client, command): ReturnType<BotLibrary["actions"]["commandCalls"]> { commands.push(`${client}:${command}`); } });
    try {
      if (product === "missionpack") expect(library.globals.add("MISSIONPACK")).toBe(true);
      library.variables.set("g_gametype", product === "missionpack" ? "4" : "0");
      expect(library.setup()).toBe(0);
      expect(library.isSetup).toBe(true);
      expect(library.setupStage).toBe("complete");
      expect(library.actions.maxClients).toBe(128);
      expect(library.variables.getString("max_messages")).toBe("1024");
      expect(library.weapons.config?.definedWeaponCount).toBeGreaterThan(0);
      expect(library.goals.itemConfig?.items.length).toBeGreaterThan(30);
      expect(random.next()).toBe(new LinuxNativeRandom(1).next());
      expect(commands).toEqual([]);

      const bytes = files.readSync(`maps/${mapName}.bsp`), bsp = parseBsp(bytes);
      const collision = new CollisionWorld(bsp, { kind: "unaccounted" }, { kind: "disabled" });
      const pool = new EntityPool({ print: text => { output.push(text); }, product, maxClients: 8, mapStartTime: 0, time: () => 0,
        link: entity => { server.link(entity); }, unlink: entity => server.unlink(entity.slot) });
      const server = new ServerWorld(collision, collision.modelBounds(0), number => pool.get(number),
        { loading: false, print: text => { output.push(text); return undefined; }, developerPrint: text => { output.push(text); return undefined; } });
      const spatialHost: AasMapSpatialHost = {
        print: text => { output.push(text); },
        trace: (start, end, bounds, passEntity, mask) => ({ ...server.trace({ start, end, passEntityNum: passEntity, mask,
          shape: bounds === null ? { kind: "point" } : { kind: "box", mins: bounds.min, maxs: bounds.max } }), contents: 0 }),
        entityTrace: (entity, start, end, bounds, mask) => ({ ...server.traceEntity(entity,
          { start, end, mask, shape: { kind: "box", mins: bounds.min, maxs: bounds.max } }), contents: 0 }),
        pointContents: point => server.pointContents(point, -1),
        modelBounds: (model, angles) => {
          let bounds = collision.modelBounds(model);
          if (angles.x !== 0 || angles.y !== 0 || angles.z !== 0) {
            const radius = radiusFromBounds(bounds);
            bounds = { min: vec3(-radius, -radius, -radius), max: vec3(radius, radius, radius) };
          }
          return { bounds, origin: vec3(0, 0, 0) };
        },
      };
      library.variables.set("sv_mapChecksum", String(blockChecksum(bytes) | 0));
      const input = { name: mapName, bsp, spatialHost };
      expect(library.loadMap(input)).toBe(0);
      expect(library.aasInitialized).toBe(false);
      const phase = library.aas.phase;
      if (phase.kind !== "loaded") throw new Error("Expected real AAS data awaiting ContinueInit");
      const map = phase.map, history = library.aas.entities, movement = library.movement;
      expect(movement.routing.spatial).toBe(map.spatial);
      expect(movement.routing.routing).toBe(map.routing);
      expect(library.startFrame(0.1)).toBe(0);
      expect(library.aasInitialized, output.join("")).toBe(true);
      expect(library.time()).toBe(Math.fround(0.1));
      const healthName = library.goals.itemConfig?.items.find(item => item.classname === "item_health")?.name;
      if (healthName === undefined) throw new Error("Retail item config has no item_health entry");
      const health = library.goals.getLevelItemGoal(-1, healthName);
      expect(health).not.toBeNull();
      if (health === null) throw new Error("Retail map has no registered Health goal");
      expect(health.area).toBeGreaterThan(0);
      expect(map.routing.areaTravelTimeToGoal({ area: health.area, origin: health.origin,
        goalArea: health.area, travelFlags: TravelFlags.DEFAULT })).toBe(1);
      const target = library.goals.itemConfig?.items.map(item => library.goals.getLevelItemGoal(-1, item.name))
        .find(goal => goal !== null && goal.area > 0 && goal.area !== health.area);
      if (target === undefined || target === null) throw new Error("Retail map has no goal in another AAS area");
      expect(map.routing.areaTravelTimeToGoal({ area: health.area, origin: health.origin,
        goalArea: target.area, travelFlags: TravelFlags.DEFAULT })).toBeGreaterThan(1);
      const classname = new Uint8Array(128), name = new Uint8Array(128);
      for (let entity = library.aas.bspEntities.nextEntity(0); entity !== 0; entity = library.aas.bspEntities.nextEntity(entity)) {
        if (!library.aas.bspEntities.value(entity, "classname", classname)
          || new TextDecoder().decode(classname).split("\0")[0] !== "target_location") continue;
        if (!library.aas.bspEntities.value(entity, "message", name)) continue;
        const locationName = new TextDecoder().decode(name).split("\0")[0];
        if (locationName === undefined) throw new Error("BSP location text is absent");
        expect(library.goals.getMapLocationGoal(locationName)).not.toBeNull();
        break;
      }
      expect(library.goals.getMapLocationGoal("not-a-map-location")).toBeNull();
      expect(library.loadMap({ ...input, name: null })).toBe(0);
      expect(library.aas.entities).toBe(history);
      expect(library.movement).toBe(movement);
      expect(library.aas.initialized).toBe(true);
      expect(library.goals.getLevelItemGoal(-1, healthName)).not.toBeNull();
      const actions = library.actions;
      expect(library.shutdown()).toBe(0);
      expect(library.isSetup).toBe(false);
      expect(library.variables.get("maxclients")).toBeNull();
      expect(library.aas.loaded).toBe(false);
      expect(() => actions.getInput(0, 0)).toThrow("shut down");
      interruptItems = true;
      let thrown: unknown = null;
      try { library.setup(); } catch (error) { thrown = error; }
      expect(thrown).toBe(failure);
      expect(library.setupStage).toBe("goals");
      expect(library.isSetup).toBe(false);
      expect(library.weapons.config).toBeDefined();
      expect(library.goals.itemConfig).toBeNull();
      const partialActions = library.actions, partialHistory = library.aas.entities;
      expect(library.shutdown()).toBe(1);
      expect(library.actions).toBe(partialActions);
      expect(library.aas.entities).toBe(partialHistory);
      const prints = output.length;
      library.disposeResources(); library.disposeResources();
      expect(output).toHaveLength(prints);
      expect(() => partialActions.getInput(0, 0)).toThrow("shut down");
      expect(() => library.sources.resolveRoot("weapons.c")).toThrow("disposed");
    } finally {
      library.disposeResources();
      files.close();
    }
  });
}
