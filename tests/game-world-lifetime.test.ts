// Source ownership: sv_init.c:SV_SpawnServer, sv_ccmds.c:SV_MapRestart_f,
// sv_game.c:SV_InitGameVM and g_main.c:G_InitGame/G_ShutdownGame.
import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, readlinkSync, readdirSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { CommonError } from "../src/core/common-error.ts";
import { finishCalls } from "../src/core/call-steps.ts";
import { vec3 } from "../src/core/math.ts";
import { GameRuntime } from "../src/game/runtime.ts";
import type { GameBotFactory, GameBotServices, GameEngineImports, GameRuntimeOptions } from "../src/game/runtime.ts";
import { ServerStaticState, ServerWorldState } from "../src/server/state.ts";
import { ServerWorld } from "../src/server/world.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ENTITYNUM_NONE } from "../src/shared/player-state.ts";

const fixtures: { readonly owner: ServerWorldState; readonly directory: string }[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    try { const game = fixture.owner.game; if (game !== null) finishCalls(game.calls.shutdown(false)); }
    finally { rmSync(fixture.directory, { recursive: true }); }
  }
});

function mapFixture(): BspMap {
  const bounds = { min: vec3(-1024, -1024, -1024), max: vec3(1024, 1024, 1024) };
  return {
    entities: '{ "classname" "worldspawn" }\n{ "classname" "info_player_deathmatch" "origin" "200 0 64" }\n'
      + '{ "classname" "misc_portal_surface" "origin" "100 100 100" }',
    entityRecords: [], shaders: [], planes: [{ normal: vec3(1, 0, 0), distance: 0 }],
    nodes: [{ plane: 0, children: [-1, -2], bounds }],
    leaves: [0, 1].map(area => ({ cluster: area, area, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 })),
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null,
  };
}

function fixture(product: Product = "baseq3", map = mapFixture(), cvars = new CvarRegistry()) {
  const statics = new ServerStaticState({ product, maxClients: 2, dedicated: false });
  const prints: string[] = [], observed: GameRuntime[] = [], commands: string[] = [];
  const logs: { readonly descriptor: number; closes: number }[] = [];
  const owner = new ServerWorldState(statics, {
    print: text => { prints.push(text); },
    dropClient: (_client, reason) => { throw new Error(`Unexpected configstring drop: ${reason}`); },
  });
  const directory = mkdtempSync(join(tmpdir(), "q3-game-world-lifetime-"));
  fixtures.push({ owner, directory });
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const world = new ServerWorld(collision, collision.modelBounds(0), number => owner.game?.data.entity(number), { get loading() { return owner.state === "loading"; }, print: text => { prints.push(text); }, developerPrint: text => { const developer = cvars.get("developer"); if (developer !== undefined && developer.integerValue !== 0) prints.push(text); } });
  cvars.set("sv_maxclients", "2", true); cvars.set("bot_enable", "0", true);
  const engine: GameEngineImports = {
    milliseconds: () => 0,
    print(text) {
      prints.push(text);
      const game = owner.game;
      if (!(game instanceof GameRuntime)) throw new Error("Initialization callback has no published game");
      observed.push(game);
    },
    sendServerCommand: (slot, text) => { commands.push(`${slot}:${text}`); },
    dropClient(slot, reason) {
      const game = owner.game;
      if (!(game instanceof GameRuntime)) throw new Error(`No game for client drop: ${reason}`);
      game.clientDisconnect(slot);
    },
    getUserinfo(slot) {
      const client = statics.clients[slot];
      if (client === undefined) throw new Error("Unknown test client");
      return client.userinfo;
    },
    setUserinfo(slot, value) {
      const client = statics.clients[slot];
      if (client === undefined) throw new Error("Unknown test client");
      client.userinfo = value;
    },
    getUserCommand(slot) {
      const client = statics.clients[slot];
      if (client === undefined) throw new Error("Unknown test client");
      return client.lastUsercmd;
    },
    appendConsoleCommand: text => { commands.push(text); },
    insertConsoleCommand: text => { commands.push(`insert:${text}`); },
    executeConsoleNow: text => { commands.push(`now:${text}`); },
    openLog(path) {
      const log = { descriptor: openSync(join(directory, path), "a"), closes: 0 };
      logs.push(log);
      return { write: text => { writeSync(log.descriptor, text); }, close() { log.closes++; closeSync(log.descriptor); } };
    },
  };
  const options: GameRuntimeOptions = {
    product, map, collision, world, levelTime: 1000, randomSeed: 42, restart: false, buildDate: "source-lifetime-test",
    cvars, configstrings: owner.configstrings, engine,
    botFactory: { kind: "unavailable", reason: "This ownership fixture has no bot clients" },
  };
  return { options, owner, world, collision, cvars, engine, observed, prints, logs, directory };
}

function assertLogsClosed(f: ReturnType<typeof fixture>): void {
  expect(f.logs.length).toBeGreaterThan(0);
  for (const log of f.logs) {
    expect(log.closes).toBe(1);
    expect(() => fstatSync(log.descriptor)).toThrow();
  }
}

function gameDescriptors(directory: string): string[] {
  return readdirSync("/proc/self/fd").flatMap(entry => {
    try { const path = readlinkSync(`/proc/self/fd/${entry}`); return path.startsWith(`${directory}/`) ? [path] : []; }
    catch { return []; }
  });
}

function expectExactThrow(operation: () => void, expected: unknown): void {
  let result: { kind: "returned" } | { kind: "thrown"; value: unknown } = { kind: "returned" };
  try { operation(); } catch (value) { result = { kind: "thrown", value }; }
  expect(result.kind).toBe("thrown");
  if (result.kind === "thrown") expect(result.value).toBe(expected);
}

function botProbe(f: ReturnType<typeof fixture>, failure: "initialize" | "loadMap" | "none", events: string[]): Extract<GameBotServices, { kind: "available" }> {
  function observe(stage: string, value: boolean | number | string): void {
    events.push(`${stage}:${value}`);
    const game = f.owner.game;
    if (!(game instanceof GameRuntime)) throw new Error("Bot callback has no published game");
    expect(game.world).toBe(f.world);
    expect(game.pool.at(64).classname).toBe("bodyque");
    if (stage === failure) throw new Error(`bot ${stage} failed`);
  }
  return {
    kind: "available", initialize: restart => { observe("initialize", restart); },
    loadMap: restart => { observe("loadMap", restart); }, initializeBots: restart => { observe("initializeBots", restart); },
    shutdown: restart => { observe("shutdown", restart); },
    frame: time => { observe("frame", time); },
    testAas: origin => { observe("testAas", `${origin.x},${origin.y},${origin.z}`); },
    interbreedEndMatch: () => { throw new Error("No bot match in ownership fixture"); },
    consoleCommand: () => { throw new Error("No bot console command in ownership fixture"); },
    removeQueuedBegin: () => { throw new Error("No bot clients in ownership fixture"); },
    connect: () => { throw new Error("No bot clients in ownership fixture"); },
    shutdownClient: () => { throw new Error("No bot clients in ownership fixture"); },
  };
}

function botFactory(f: ReturnType<typeof fixture>, services: Extract<GameBotServices, { kind: "available" }>): GameBotFactory {
  return { kind: "source", attach(game) {
    expect(f.owner.game).toBe(game);
    expect(game.world).toBe(f.world);
    return services;
  } };
}

function restartWithRetainedSector() {
  const f = fixture(), old = GameRuntime.create(f.options, f.owner), entity = old.pool.spawn();
  entity.r.currentOrigin = vec3(100, 100, 100);
  entity.r.mins = vec3(-200, -200, -200); entity.r.maxs = vec3(200, 200, 200);
  entity.r.contents = 0x2000000;
  const previous = f.world.link(entity);
  old.shutdown(true);
  const game = GameRuntime.create({ ...f.options, restart: true }, f.owner);
  return { ...f, game, slot: entity.slot, previous };
}

describe("resource-only game disposal", () => {
  for (const value of [new CommonError("drop", "managed log release"), null, undefined]) {
    test(`resource-only disposal consumes a throwing log without source callbacks: ${String(value)}`, () => {
      const f = fixture(), events: string[] = [];
      let armed = true;
      f.cvars.set("bot_enable", "1", true);
      const game = GameRuntime.create({ ...f.options, botFactory: botFactory(f, botProbe(f, "none", events)), engine: {
        ...f.engine, openLog(path, synchronous) {
          const file = f.engine.openLog(path, synchronous);
          if (file === null) throw new Error("Expected actual game log");
          return { write: text => { file.write(text); }, close() {
            file.close();
            if (!armed) return;
            expect(() => game.runFrame(2000)).toThrow("shut down");
            game.disposeResources();
            throw value;
          } };
        },
      } }, f.owner);
      const before = [...f.prints], sessions = f.cvars.get("session")?.value;
      events.length = 0;
      try {
        expectExactThrow(() => game.disposeResources(), value);
        expect(f.owner.game).toBeNull(); expect(events).toEqual([]); expect(f.prints).toEqual(before);
        expect(f.cvars.get("session")?.value).toBe(sessions); assertLogsClosed(f);
        game.disposeResources(); game.shutdown(false); assertLogsClosed(f);
      } finally { armed = false; }
    });
  }

  test("resource-only disposal of an old game cannot detach its replacement or dispose borrowed bots", () => {
    const f = fixture(), events: string[] = [];
    f.cvars.set("bot_enable", "1", true);
    const options = { ...f.options, botFactory: botFactory(f, botProbe(f, "none", events)) };
    const old = GameRuntime.create(options, f.owner);
    old.shutdown(true);
    const game = GameRuntime.create({ ...options, restart: true }, f.owner);
    events.length = 0;
    old.disposeResources(); expect(f.owner.game).toBe(game); expect(events).toEqual([]);
    game.runFrame(2000); expect(events).toEqual([]);
    game.botFrame(2000); expect(events).toEqual(["frame:2000"]);
    events.length = 0;
    game.disposeResources(); expect(events).toEqual([]); assertLogsClosed(f);
  });

  for (const ordinaryFailure of [false, true]) {
    test(`resource-only game disposal leaves borrowed handles with their standalone provider: ${ordinaryFailure}`, () => {
      const f = fixture(), events: string[] = [], body = new Error("ordinary bot setup"), cleanup = new Error("ordinary bot shutdown");
      const borrowed = openSync(join(f.directory, "borrowed-bot-resource"), "w+");
      f.cvars.set("bot_enable", "1", true);
      const source = botProbe(f, "none", events);
      if (source.kind !== "available") throw new Error("Expected source bot services");
      const bots: GameBotServices = { ...source,
        loadMap(restart) { source.loadMap(restart); if (ordinaryFailure) throw body; },
        shutdown(restart) { source.shutdown(restart); if (ordinaryFailure) throw cleanup; },
      };
      try {
        if (ordinaryFailure) {
          let observed: unknown;
          try { GameRuntime.create({ ...f.options, botFactory: botFactory(f, bots) }, f.owner); } catch (error) { observed = error; }
          expect(observed).toBeInstanceOf(AggregateError);
          if (!(observed instanceof AggregateError)) throw new Error("Expected original ordinary cleanup aggregate");
          const errors: unknown = observed.errors;
          expect(errors).toEqual([body, cleanup]); expect(f.owner.game).toBeNull();
        } else {
          const game = GameRuntime.create({ ...f.options, botFactory: botFactory(f, bots) }, f.owner);
          events.length = 0; game.disposeResources(); expect(events).toEqual([]);
        }
        expect(fstatSync(borrowed).isFile()).toBe(true); assertLogsClosed(f);
      } finally { closeSync(borrowed); }
      expect(() => fstatSync(borrowed)).toThrow();
    });
  }
});

describe("game publication and map-owned world lifetime", () => {
  for (const point of ["print", "initialize", "loadMap", "initializeBots"]) {
    test(`game source control retains partial initialization at ${point}`, () => {
      const f = fixture(), events: string[] = [], failure = new CommonError("drop", `init ${point}`);
      f.cvars.set("bot_enable", "1", true);
      let armed = true;
      const step = (name: string): void => { events.push(name); if (armed && name === point) throw failure; };
      const base = botProbe(f, "none", []);
      if (base.kind !== "available") throw new Error("Expected available bot probe");
      const options: GameRuntimeOptions = { ...f.options, engine: { ...f.engine,
        print(text) { f.engine.print(text); if (text === "------- Game Initialization -------\n") step("print"); },
      }, botFactory: botFactory(f, { ...base, initialize: () => { step("initialize"); }, loadMap: () => { step("loadMap"); },
        initializeBots: () => { step("initializeBots"); }, shutdown: () => { step("shutdown"); } }) };
      try {
        expectExactThrow(() => { GameRuntime.create(options, f.owner); }, failure);
        const game = f.observed[0];
        if (game === undefined) throw new Error("Expected published runtime");
        expect(f.owner.game === game).toBe(true);
        expect(events).toEqual(["print", "initialize", "loadMap", "initializeBots"].slice(0,
          ["print", "initialize", "loadMap", "initializeBots"].indexOf(point) + 1));
        expect(f.logs.every(log => log.closes === 0)).toBe(true);
        armed = false; game.shutdown(false);
        expect(events.filter(event => event === "shutdown")).toHaveLength(point === "print" ? 0 : 1);
        expect(f.owner.game).toBeNull();
      } finally { armed = false; }
    });
  }

  for (const point of ["print", "write", "close", "session", "bots"]) {
    test(`game source control stops shutdown at ${point} and consumes callback ownership once`, () => {
      const trace: string[] = [], failure = new CommonError("drop", `shutdown ${point}`);
      let armed = false;
      const step = (name: string): void => { if (armed) { trace.push(name); if (name === point) throw failure; } };
      class SessionCvars extends CvarRegistry {
        override set(name: string, value: string, force = false) {
          if (name === "session") step("session");
          return super.set(name, value, force);
        }
      }
      const f = fixture("baseq3", mapFixture(), new SessionCvars());
      f.cvars.set("bot_enable", "1", true);
      const base = botProbe(f, "none", []);
      if (base.kind !== "available") throw new Error("Expected available bot probe");
      let botCloses = 0;
      const game = GameRuntime.create({ ...f.options, engine: { ...f.engine,
        print(text) { f.engine.print(text); if (text === "==== ShutdownGame ====\n") step("print"); },
        openLog(path, synchronous) {
          const file = f.engine.openLog(path, synchronous);
          if (file === null) throw new Error("Expected real log");
          return { write(text) { step("write"); file.write(text); }, close() { file.close(); step("close"); } };
        },
      }, botFactory: botFactory(f, { ...base, shutdown() { botCloses++; step("bots"); } }) }, f.owner);
      armed = true;
      try {
        expectExactThrow(() => { game.shutdown(false); }, failure);
        expect(f.owner.game === game).toBe(true);
        const order = ["print", "write", "write", "close", "session", "bots"];
        expect(trace).toEqual(order.slice(0, order.indexOf(point) + 1));
        expect(f.logs[0]?.closes).toBe(["close", "session", "bots"].includes(point) ? 1 : 0);
        armed = false;
        expect(() => game.consoleCommand(["unrecognized_ownership_probe"])).not.toThrow();
        game.shutdown(false); game.shutdown(false);
        expect(botCloses).toBe(1); expect(f.owner.game).toBeNull(); assertLogsClosed(f);
      } finally { armed = false; }
    });
  }

  for (const cleanup of ["close", "bots"]) {
    test(`game source control supersedes ordinary initialization failure in ${cleanup} cleanup`, () => {
      const f = fixture(), events: string[] = [], failure = new CommonError("drop", `cleanup ${cleanup}`);
      f.cvars.set("bot_enable", "1", true);
      let armed = true;
      const base = botProbe(f, "loadMap", events);
      if (base.kind !== "available") throw new Error("Expected available bot probe");
      const options: GameRuntimeOptions = { ...f.options, engine: { ...f.engine, openLog(path, synchronous) {
        const file = f.engine.openLog(path, synchronous);
        if (file === null) throw new Error("Expected real log");
        return { write: text => { file.write(text); }, close() { file.close(); if (armed && cleanup === "close") throw failure; } };
      } }, botFactory: botFactory(f, { ...base, shutdown(restart) { base.shutdown(restart); if (armed && cleanup === "bots") throw failure; } }) };
      try {
        expectExactThrow(() => { GameRuntime.create(options, f.owner); }, failure);
        const game = f.observed[0];
        if (game === undefined) throw new Error("Expected published runtime");
        expect(f.owner.game === game).toBe(true);
        expect(events).toEqual(cleanup === "close" ? ["initialize:false", "loadMap:false"]
          : ["initialize:false", "loadMap:false", "shutdown:false"]);
        armed = false; game.shutdown(false);
        expect(events.filter(event => event === "shutdown:false")).toHaveLength(1);
        assertLogsClosed(f);
      } finally { armed = false; }
    });
  }

  for (const value of [null, undefined, new Error("ordinary failure")]) {
    for (const point of ["body", "close", "bots"]) {
      test(`ordinary game shutdown preserves thrown ${String(value)} at ${point}`, () => {
        const f = fixture(), events: string[] = [];
        f.cvars.set("bot_enable", "1", true);
        let armed = false;
        const base = botProbe(f, "none", events);
        if (base.kind !== "available") throw new Error("Expected available bot probe");
        const game = GameRuntime.create({ ...f.options, engine: { ...f.engine,
          print(text) { f.engine.print(text); if (armed && text === "==== ShutdownGame ====\n" && point === "body") throw value; },
          openLog(path, synchronous) {
            const file = f.engine.openLog(path, synchronous);
            if (file === null) throw new Error("Expected real log");
            return { write: text => { file.write(text); }, close() { file.close(); if (armed && point === "close") throw value; } };
          },
        }, botFactory: botFactory(f, { ...base, shutdown(restart) { base.shutdown(restart); if (armed && point === "bots") throw value; } }) }, f.owner);
        armed = true;
        let observed: { kind: "returned" } | { kind: "thrown"; value: unknown } = { kind: "returned" };
        try { game.shutdown(false); } catch (error) { observed = { kind: "thrown", value: error }; }
        finally { armed = false; }
        expect(observed).toEqual({ kind: "thrown", value }); expect(f.owner.game).toBeNull();
        expect(events.at(-1)).toBe("shutdown:false"); assertLogsClosed(f);
        expect(() => game.runFrame(2000)).toThrow("shut down");
      });
    }
  }

  for (const cleanup of ["close", "bots"]) {
    test(`game source control supersedes ordinary shutdown body failure in ${cleanup} cleanup`, () => {
      const f = fixture(), events: string[] = [], failure = new CommonError("drop", `shutdown cleanup ${cleanup}`);
      f.cvars.set("bot_enable", "1", true);
      let armed = false;
      const base = botProbe(f, "none", events);
      if (base.kind !== "available") throw new Error("Expected available bot probe");
      const game = GameRuntime.create({ ...f.options, engine: { ...f.engine,
        print(text) { f.engine.print(text); if (armed && text === "==== ShutdownGame ====\n") throw undefined; },
        openLog(path, synchronous) {
          const file = f.engine.openLog(path, synchronous);
          if (file === null) throw new Error("Expected real log");
          return { write: text => { file.write(text); }, close() { file.close(); if (armed && cleanup === "close") throw failure; } };
        },
      }, botFactory: botFactory(f, { ...base, shutdown(restart) { base.shutdown(restart); if (armed && cleanup === "bots") throw failure; } }) }, f.owner);
      armed = true;
      try {
        expectExactThrow(() => { game.shutdown(false); }, failure);
        expect(f.owner.game === game).toBe(true);
        expect(events.filter(event => event === "shutdown:false")).toHaveLength(cleanup === "close" ? 0 : 1);
        armed = false; game.shutdown(false);
        expect(events.filter(event => event === "shutdown:false")).toHaveLength(1);
        assertLogsClosed(f);
      } finally { armed = false; }
    });
  }

  for (const value of [null, undefined]) {
    for (const cleanupFails of [false, true]) {
      test(`ordinary game initialization preserves thrown ${String(value)}, cleanup=${cleanupFails}`, () => {
        const f = fixture(), events: string[] = [], cleanupFailure = new Error("ordinary bot cleanup");
        f.cvars.set("bot_enable", "1", true);
        const base = botProbe(f, "none", events);
        if (base.kind !== "available") throw new Error("Expected available bot probe");
        let observed: { kind: "returned" } | { kind: "thrown"; value: unknown } = { kind: "returned" };
        try {
          GameRuntime.create({ ...f.options, botFactory: botFactory(f, { ...base,
            loadMap() { throw value; },
            shutdown(restart) { base.shutdown(restart); if (cleanupFails) throw cleanupFailure; },
          }) }, f.owner);
        } catch (error) { observed = { kind: "thrown", value: error }; }
        expect(observed.kind).toBe("thrown");
        if (observed.kind !== "thrown") throw new Error("Expected initialization failure");
        if (cleanupFails) {
          expect(observed.value).toBeInstanceOf(AggregateError);
          if (!(observed.value instanceof AggregateError)) throw new Error("Expected initialization aggregate");
          const errors: unknown = observed.value.errors;
          expect(errors).toEqual([value, cleanupFailure]);
        } else expect(observed.value).toBe(value);
        expect(f.owner.game).toBeNull(); assertLogsClosed(f);
      });
    }
  }


  test("ordinary game cleanup keeps nested finally replacement and initialization aggregation", () => {
    for (const operation of ["shutdown", "initialize"]) {
      const f = fixture(), events: string[] = [], body = new Error("body"), close = new Error("close"), bot = new Error("bot");
      f.cvars.set("bot_enable", "1", true);
      let armed = operation === "initialize";
      const base = botProbe(f, "none", events);
      if (base.kind !== "available") throw new Error("Expected available bot probe");
      const options: GameRuntimeOptions = { ...f.options, engine: { ...f.engine,
        print(text) { f.engine.print(text); if (armed && text === "==== ShutdownGame ====\n") throw body; },
        openLog(path, synchronous) {
          const file = f.engine.openLog(path, synchronous);
          if (file === null) throw new Error("Expected real log");
          return { write: text => { file.write(text); }, close() { file.close(); if (armed) throw close; } };
        },
      }, botFactory: botFactory(f, { ...base, loadMap(restart) { base.loadMap(restart); if (armed) throw body; },
        shutdown(restart) { base.shutdown(restart); if (armed) throw bot; } }) };
      let observed: unknown;
      try {
        if (operation === "initialize") GameRuntime.create(options, f.owner);
        else { const game = GameRuntime.create(options, f.owner); armed = true; game.shutdown(false); }
      } catch (error) { observed = error; } finally { armed = false; }
      if (operation === "initialize") {
        expect(observed).toBeInstanceOf(AggregateError);
        if (!(observed instanceof AggregateError)) throw new Error("Expected initialization aggregate");
        const errors: unknown = observed.errors;
        expect(errors).toEqual([body, bot]);
      } else expect(observed).toBe(bot);
      expect(f.owner.game).toBeNull(); assertLogsClosed(f);
    }
  });

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: constructor completes before callbacks and init links through the current pool`, () => {
      const f = fixture(product), game = GameRuntime.create(f.options, f.owner);
      expect(f.owner.game).toBe(game); expect(game.world).toBe(f.world);
      expect(f.observed.length).toBeGreaterThan(0);
      expect(f.observed.every(observed => observed === game)).toBe(true);
      const portal = game.pool.at(73);
      expect(portal.classname).toBe("misc_portal_surface");
      expect(f.world.linkState(portal.slot)?.linked).toBe(true);
      expect(f.world.areaEntities({ min: vec3(99, 99, 99), max: vec3(101, 101, 101) })).toContain(portal.slot);
      game.shutdown(false); game.shutdown(false);
      expect(f.owner.game).toBeNull(); assertLogsClosed(f);
      expect(readFileSync(join(f.directory, "games.log"), "utf8")).toContain("ShutdownGame:");
    });
  }

  test("fast restart retains spatial metadata and portals while resolving replacement entities", () => {
    const f = fixture(), old = GameRuntime.create(f.options, f.owner);
    const oldEntity = old.pool.spawn();
    oldEntity.r.mins = vec3(-8, -8, -8); oldEntity.r.maxs = vec3(8, 8, 8);
    oldEntity.r.currentOrigin = vec3(300, 300, 300); oldEntity.r.contents = 0x2000000;
    const before = f.world.link(oldEntity);
    f.collision.adjustAreaPortalState(0, 1, true);
    old.shutdown(true);
    expect(f.owner.game).toBeNull(); expect(f.world.linkState(oldEntity.slot)).toBeUndefined();
    expect(oldEntity.r.linked).toBe(before.linked); expect(oldEntity.r.linkcount).toBe(before.linkcount);
    expect(oldEntity.r.absmin).toEqual(before.absbounds.min); expect(oldEntity.r.absmax).toEqual(before.absbounds.max);
    const metadataDuringInit: ReturnType<ServerWorld["linkState"]>[] = [];
    const game = GameRuntime.create({ ...f.options, restart: true, levelTime: 2000, engine: {
      ...f.engine, print(text) { f.engine.print(text); metadataDuringInit.push(f.world.linkState(oldEntity.slot)); },
    } }, f.owner);
    expect(game.world).toBe(old.world); expect(game.options.collision).toBe(old.options.collision);
    expect(game.options.configstrings).toBe(old.options.configstrings);
    expect(f.collision.areasConnected(0, 1)).toBe(true);
    expect(metadataDuringInit[0]).toEqual({ ...before, linked: false, linkcount: 0,
      absbounds: { min: vec3(0, 0, 0), max: vec3(0, 0, 0) } });
    expect(f.world.linkState(oldEntity.slot)?.clusters).toEqual(before.clusters);
    const replacement = game.pool.spawn();
    expect(replacement.slot).toBe(oldEntity.slot); expect(replacement).not.toBe(oldEntity);
    replacement.r.currentOrigin = vec3(500, 500, 500);
    const linked = f.world.link(replacement);
    expect(linked.linkcount).toBe(1);
    expect(f.world.areaEntities({ min: vec3(299, 299, 299), max: vec3(301, 301, 301) })).not.toContain(oldEntity.slot);
    const relinkedOld = f.world.link(oldEntity);
    expect(relinkedOld).toEqual({ ...before, linkcount: before.linkcount + 1 });
    expect(game.data.entity(oldEntity.slot)).toBe(replacement);
    expect(oldEntity.r.linkcount).toBe(relinkedOld.linkcount); expect(replacement.r.linkcount).toBe(linked.linkcount);
    expect(replacement.r.absmin).toEqual(linked.absbounds.min); expect(replacement.r.absmax).toEqual(linked.absbounds.max);
    expect(f.world.linkState(oldEntity.slot)).toEqual(linked);
    expect(f.world.areaEntities(relinkedOld.absbounds)).not.toContain(oldEntity.slot);
    expect(f.world.areaEntities(linked.absbounds)).toContain(oldEntity.slot);
    old.shutdown(false); expect(f.owner.game).toBe(game);
    expect(() => old.runFrame(2100)).toThrow("shut down");
  });

  test("failed destructive restart detaches its new pool and closes the real log without clearing the map", () => {
    const f = fixture(), old = GameRuntime.create(f.options, f.owner);
    old.shutdown(true);
    const failure = new Error("After map entity spawn");
    const failedGames: GameRuntime[] = [];
    const metadataAtFailure: ReturnType<ServerWorld["linkState"]>[] = [];
    expect(() => GameRuntime.create({ ...f.options, restart: true, engine: {
      ...f.engine, print(text) {
        f.engine.print(text);
        const current = f.owner.game;
        if (!(current instanceof GameRuntime)) throw new Error("No newly attached game");
        failedGames.push(current);
        if (text === "-----------------------------------\n") {
          metadataAtFailure.push(f.world.linkState(73));
          throw failure;
        }
      },
    } }, f.owner)).toThrow(failure);
    expect(f.owner.game).toBeNull(); expect(f.world.linkState(73)).toBeUndefined();
    const failed = failedGames[0];
    if (failed === undefined) throw new Error("Initialization did not call its real engine");
    const retained = metadataAtFailure[0];
    if (retained === undefined) throw new Error("Map entity was not linked before initialization failed");
    const portal = failed.data.entity(73);
    expect(portal.r.linked).toBe(true); expect(portal.r.linkcount).toBe(retained.linkcount);
    expect(portal.r.absmin).toEqual(retained.absbounds.min); expect(portal.r.absmax).toEqual(retained.absbounds.max);
    expect(() => f.world.areaEntities(retained.absbounds)).toThrow("server entity 73 is unavailable");
    expect(failed).not.toBe(old); expect(failed.pool).not.toBe(old.pool);
    expect(() => failed.runFrame(2000)).toThrow("shut down");
    expect(() => old.runFrame(2000)).toThrow("shut down");
    failed.shutdown(false); assertLogsClosed(f);
    const metadataDuringReplacement: ReturnType<ServerWorld["linkState"]>[] = [];
    const replacement = GameRuntime.create({ ...f.options, restart: true, engine: {
      ...f.engine, print(text) { f.engine.print(text); metadataDuringReplacement.push(f.world.linkState(73)); },
    } }, f.owner);
    expect(metadataDuringReplacement[0]).toEqual({ ...retained, linked: false, linkcount: 0,
      absbounds: { min: vec3(0, 0, 0), max: vec3(0, 0, 0) } });
    expect(replacement.data.entity(73)).not.toBe(portal); expect(portal.r.linked).toBe(true);
    replacement.shutdown(false); assertLogsClosed(f);
  });

  test("retained sectors query zeroed current bounds before a restarted slot is relinked", () => {
    const f = restartWithRetainedSector();
    expect(f.game.pool.at(f.slot).s.number).toBe(0);
    expect(f.world.areaEntities({ min: vec3(99, 99, 99), max: vec3(101, 101, 101) })).not.toContain(f.slot);
    expect(f.world.areaEntities({ min: vec3(0, 0, 0), max: vec3(0, 0, 0) })).toContain(f.slot);
    expect(f.world.linkState(f.slot)?.clusters).toEqual(f.previous.clusters);
    expect(f.world.linkState(f.slot)?.linked).toBe(false);
  });

  test("trace and contents resolve retained source slots even when new s.number is zero", () => {
    const f = restartWithRetainedSector();
    const query = { start: vec3(0, 0, 0), end: vec3(1, 1, 1), shape: { kind: "point" }, mask: 0x2000000,
      passEntityNum: ENTITYNUM_NONE } satisfies Parameters<ServerWorld["trace"]>[0];
    expect(f.world.trace(query).fraction).toBe(1);
    expect(f.world.trace({ ...query, passEntityNum: f.slot }).entityNum).toBe(ENTITYNUM_NONE);
    expect(() => f.world.pointContents(vec3(0, 0, 0), ENTITYNUM_NONE)).not.toThrow();
  });

  for (const stage of ["initialize", "loadMap"] satisfies readonly ("initialize" | "loadMap")[]) {
    test(`failed bot ${stage} releases partial resources with the new game still attached during cleanup`, () => {
      const f = fixture(), events: string[] = [];
      f.cvars.set("bot_enable", "1", true);
      expect(() => GameRuntime.create({ ...f.options, restart: true, botFactory: botFactory(f, botProbe(f, stage, events)) }, f.owner))
        .toThrow(`bot ${stage} failed`);
      expect(events).toEqual(stage === "initialize" ? ["initialize:true", "shutdown:true"]
        : ["initialize:true", "loadMap:true", "shutdown:true"]);
      expect(f.owner.game).toBeNull(); assertLogsClosed(f);
    });
  }

  test("log close failure still shuts down bots, detaches the game and preserves the init error", () => {
    const f = fixture(), events: string[] = [], closeFailure = new Error("log close failed");
    f.cvars.set("bot_enable", "1", true);
    let failure: unknown;
    try {
      GameRuntime.create({ ...f.options, botFactory: botFactory(f, botProbe(f, "loadMap", events)), engine: { ...f.engine, openLog(path, synchronous) {
        const file = f.engine.openLog(path, synchronous);
        if (file === null) throw new Error("Fixture could not open its log");
        return { write: text => { file.write(text); }, close() { file.close(); throw closeFailure; } };
      } } }, f.owner);
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Missing combined initialization failure");
    const errors: unknown = failure.errors;
    expect(errors).toEqual([new Error("bot loadMap failed"), closeFailure]);
    expect(events.at(-1)).toBe("shutdown:false");
    expect(f.owner.game).toBeNull(); assertLogsClosed(f);
  });

  test("an occupied owner rejects replacement before any callbacks or resources", () => {
    const f = fixture(), game = GameRuntime.create(f.options, f.owner), count = f.prints.length;
    expect(() => GameRuntime.create(f.options, f.owner)).toThrow("Shut down the current game");
    expect(f.owner.game).toBe(game); expect(f.prints).toHaveLength(count); expect(f.logs).toHaveLength(1);
  });

  test("constructor failure never publishes an incomplete runtime", () => {
    const f = fixture(); f.cvars.set("sv_maxclients", "0", true);
    expect(() => GameRuntime.create(f.options, f.owner)).toThrow("Configured clients");
    expect(f.owner.game).toBeNull(); expect(f.prints).toEqual([]); expect(f.logs).toEqual([]);
  });

  test("independent server owners retain separate links, collision portals and current pools", () => {
    const a = fixture(), b = fixture();
    const gameA = GameRuntime.create(a.options, a.owner), gameB = GameRuntime.create(b.options, b.owner);
    a.collision.adjustAreaPortalState(0, 1, true);
    expect(b.collision.areasConnected(0, 1)).toBe(false);
    const entityA = gameA.pool.at(73), beforeB = b.world.linkState(73);
    if (beforeB === undefined) throw new Error("Second world's portal has no link metadata");
    const entityB = gameB.data.entity(73);
    entityA.r.currentOrigin = vec3(400, 400, 400); const beforeA = a.world.link(entityA);
    expect(b.world.linkState(73)).toEqual(beforeB);
    const linkedInB = b.world.link(entityA);
    expect(linkedInB).toEqual({ ...beforeA, linkcount: beforeA.linkcount + 1 });
    expect(gameA.data.entity(73)).toBe(entityA); expect(gameB.data.entity(73)).toBe(entityB);
    expect(entityB.r.linked).toBe(beforeB.linked); expect(entityB.r.linkcount).toBe(beforeB.linkcount);
    expect(entityB.r.absmin).toEqual(beforeB.absbounds.min); expect(entityB.r.absmax).toEqual(beforeB.absbounds.max);
    expect(a.world.linkState(73)).toEqual(linkedInB); expect(b.world.linkState(73)).toEqual(beforeB);
    expect(b.world.areaEntities(beforeB.absbounds)).toContain(73);
    expect(b.world.areaEntities(linkedInB.absbounds)).not.toContain(73);
    gameA.shutdown(true);
    const replacement = GameRuntime.create({ ...a.options, restart: true }, a.owner);
    expect(a.owner.game).toBe(replacement); expect(b.owner.game).toBe(gameB);
    expect(b.world.linkState(73)).toEqual(beforeB); expect(gameB.pool.at(73)).not.toBe(replacement.pool.at(73));
  });
});

describe.skipIf(process.env["Q3_DATA"] === undefined)("retail game world lifetime", () => {
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    for (const abort of [false, true]) {
      test(`${product}: resource-only disposal closes the real game log after ${abort ? "source abort" : "normal running"}`, async () => {
        const dataPath = process.env["Q3_DATA"];
        if (dataPath === undefined) throw new Error("Q3_DATA required");
        const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
        const map = parseBsp(await assets.read(`maps/${product === "baseq3" ? "q3dm1" : "mpteam1"}.bsp`));
        const f = fixture(product, map), failure = new CommonError("drop", "source shutdown abort");
        let armed = false;
        const game = GameRuntime.create({ ...f.options, engine: { ...f.engine, print(text) {
          if (armed) throw failure;
          f.engine.print(text);
        } } }, f.owner);
        game.runFrame(1400);
        if (abort) {
          armed = true; expectExactThrow(() => game.shutdown(false), failure);
          expect(f.owner.game).toBe(game); expect(fstatSync(f.logs[0]?.descriptor ?? -1).isFile()).toBe(true);
        }
        const before = [...f.prints], session = f.cvars.get("session")?.value;
        try {
          expect(gameDescriptors(f.directory)).toEqual([join(f.directory, "games.log")]);
          game.disposeResources(); game.disposeResources();
          expect(gameDescriptors(f.directory)).toEqual([]);
          expect(f.prints).toEqual(before); expect(f.cvars.get("session")?.value).toBe(session);
          expect(f.owner.game).toBeNull(); expect(() => game.runFrame(1500)).toThrow("shut down");
          assertLogsClosed(f); expect(readFileSync(join(f.directory, "games.log"), "utf8")).not.toContain("ShutdownGame:");
        } finally { armed = false; }
      });
    }
    test(`${product}: retail entities respawn in the identical map-owned world`, async () => {
      const dataPath = process.env["Q3_DATA"];
      if (dataPath === undefined) throw new Error("Q3_DATA required");
      const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
      const map = parseBsp(await assets.read(`maps/${product === "baseq3" ? "q3dm1" : "mpteam1"}.bsp`));
      const f = fixture(product, map), old = GameRuntime.create(f.options, f.owner);
      old.runFrame(1100); old.runFrame(1200); old.runFrame(1300);
      const priorPool = old.pool;
      old.shutdown(true);
      const game = GameRuntime.create({ ...f.options, restart: true, levelTime: 1400 }, f.owner);
      game.runFrame(1400); game.runFrame(1500); game.runFrame(1600);
      expect(game.pool).not.toBe(priorPool); expect(game.world).toBe(old.world);
      expect(game.options.collision).toBe(old.options.collision);
      expect(game.spawnReport.outcomes.filter(outcome => outcome.kind === "unknown")).toEqual([]);
      expect(game.pool.numEntities).toBeGreaterThan(72); expect(f.owner.game).toBe(game);
      game.shutdown(false); assertLogsClosed(f);
    });
  }
});
