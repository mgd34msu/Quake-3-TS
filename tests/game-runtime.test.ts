// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, spyOn, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { finishCalls } from "../src/core/call-steps.ts";
import { CommonError } from "../src/core/common-error.ts";
import { vec3 } from "../src/core/math.ts";
import { damage } from "../src/game/combat.ts";
import { GameRuntime } from "../src/game/runtime.ts";
import type { GameEngineImports, GameRuntimeOwner } from "../src/game/runtime.ts";
import { ServerWorld } from "../src/server/world.ts";
import { ConnectionState, GameFlags } from "../src/game/state.ts";
import type { GameEntity } from "../src/game/state.ts";
import { EntityEvent, EntityType, GameType, PersistentIndex, Powerup, Team, Weapon } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ServerEntityFlags } from "../src/shared/entity-shared.ts";
import { CommandButtons, ENTITYNUM_WORLD, PlayerAnimation } from "../src/shared/player-state.ts";
import type { UserCommand } from "../src/shared/player-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";
import { VmRegistry } from "../src/vm/registry.ts";
import type { VmRegistration } from "../src/vm/registry.ts";

function fixtureMap(extra = ""): BspMap {
  const bounds = { min: vec3(-4096, -4096, -512), max: vec3(4096, 4096, 1024) };
  const planes = [{ normal: vec3(1, 0, 0), distance: 4096 }, { normal: vec3(-1, 0, 0), distance: 4096 },
    { normal: vec3(0, 1, 0), distance: 4096 }, { normal: vec3(0, -1, 0), distance: 4096 },
    { normal: vec3(0, 0, 1), distance: 0 }, { normal: vec3(0, 0, -1), distance: 512 }];
  return { entities: `{ "classname" "worldspawn" "message" "Runtime fixture" }
    { "classname" "info_player_deathmatch" "origin" "-300 0 24" "angle" "0" }
    { "classname" "info_player_deathmatch" "origin" "300 0 24" "angle" "180" }
    { "classname" "info_player_intermission" "origin" "0 0 300" }
    { "classname" "item_health" "origin" "0 100 24" "wait" "-1" }
    ${extra}`, entityRecords: [], shaders: [{ name: "floor", surfaceFlags: 0, contentFlags: 1 }], planes,
    nodes: [], leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    leafSurfaces: [], leafBrushes: [0], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_, plane) => ({ plane, shader: 0 })),
    vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}
function command(time: number, changes: Partial<UserCommand> = {}): UserCommand {
  return { serverTime: time, angles: vec3(0, 0, 0), buttons: 0, weapon: Weapon.WP_MACHINEGUN, forwardmove: 0, rightmove: 0, upmove: 0, ...changes };
}
function setup(product: Product = "baseq3", map = fixtureMap(), type: number = GameType.GT_FFA, cvars = new CvarRegistry(), registration: VmRegistration | null = null) {
  for (const [name, value] of [["sv_maxclients", "4"], ["g_gametype", String(type)], ["g_log", ""], ["bot_enable", "0"],
    ["sv_cheats", "1"], ["g_teamAutoJoin", "1"], ["fraglimit", "20"], ["g_doWarmup", "0"]]) {
    if (name === undefined || value === undefined) throw new Error("Fixture cvar tuple missing");
    cvars.set(name, value, true);
  }
  const strings = new Map<number, string>(), console: string[] = [], messages: { client: number; text: string }[] = [], prints: string[] = [];
  const users = new Map<number, string>(), commands = new Map<number, UserCommand>();
  for (let number = 0; number < 4; number++) {
    users.set(number, `\\name\\Player${number}\\ip\\localhost\\handicap\\100\\model\\sarge/default`);
    commands.set(number, command(1000));
  }
  const owner: GameRuntimeOwner = { game: null };
  const engine: GameEngineImports = {
    milliseconds: () => 0,
    print: text => { prints.push(text); }, sendServerCommand: (client, text) => { messages.push({ client, text }); },
    dropClient: (number, reason) => {
      prints.push(`drop:${number}:${reason}`);
      const current = owner.game;
      if (!(current instanceof GameRuntime)) throw new Error("No current fixture game");
      current.clientDisconnect(number);
    },
    getUserinfo: number => { const value = users.get(number); if (value === undefined) throw new Error("Missing engine userinfo"); return value; },
    setUserinfo: (number, value) => { users.set(number, value); },
    getUserCommand: number => { const value = commands.get(number); if (value === undefined) throw new Error("Missing engine command"); return value; },
    appendConsoleCommand: text => { console.push(text); }, insertConsoleCommand: text => { console.unshift(text); },
    executeConsoleNow: text => { console.push(`now:${text}`); },
    openLog: () => { throw new Error("Fixture disabled filesystem logging"); },
  };
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const world = new ServerWorld(collision, collision.modelBounds(0), number => owner.game?.data.entity(number), { loading: false, print: text => { engine.print(text); }, developerPrint: text => { engine.print(text); } });
  const runtime = GameRuntime.create({ product, map, collision, world, levelTime: 1000, randomSeed: 42, restart: false,
    buildDate: "Sep  5 2026", cvars, configstrings: { get: index => strings.get(index) ?? "", set: (index, value) => { strings.set(index, value); } },
    engine, botFactory: { kind: "unavailable", reason: "Game bot AI not implemented" } }, owner, registration);
  function join(number: number): GameEntity {
    expect(runtime.clientConnect(number, true, false)).toBeNull(); runtime.clientBegin(number); return runtime.pool.at(number);
  }
  function send(number: number, input: UserCommand): void { commands.set(number, input); runtime.clientThink(number, input); }
  return { runtime, owner, cvars, strings, console, messages, prints, users, commands, engine, join, send };
}
function find(runtime: GameRuntime, classname: string): GameEntity {
  for (let index = 0; index < runtime.pool.numEntities; index++) { const entity = runtime.pool.at(index); if (entity.inuse && entity.classname === classname) return entity; }
  throw new Error(`Missing runtime entity ${classname}`);
}
function state(runtime: GameRuntime) {
  return { time: runtime.level.time, previousTime: runtime.level.previousTime, frameNum: runtime.level.frameNum, random: runtime.random.seed,
    scores: Array.from({ length: 4 }, (_, index) => runtime.level.teamScores.get(index)),
    entities: Array.from({ length: runtime.pool.numEntities }, (_, index) => {
      const entity = runtime.pool.at(index);
      return { classname: entity.classname, inuse: entity.inuse, health: entity.health, state: entity.s,
        origin: entity.r.currentOrigin, ps: entity.client?.ps ?? null };
    }) };
}

describe("authoritative GameRuntime composition", () => {
  test("frame timing imports surround entity simulation and client end-frame processing", () => {
    const f = setup();
    f.join(0);
    f.runtime.pool.clientAt(0).damageBlood = 5;
    const calls: string[] = [];
    const clock = spyOn(f.runtime.options.engine, "milliseconds").mockImplementation(() => { calls.push("clock"); return 123; });
    const runClient = f.runtime.think.runClient.bind(f.runtime.think);
    const think = spyOn(f.runtime.think, "runClient").mockImplementation(entity => { calls.push("think"); runClient(entity); });
    const addEvent = f.runtime.pool.addEvent.bind(f.runtime.pool);
    const event = spyOn(f.runtime.pool, "addEvent").mockImplementation((entity, value, parameter) => {
      calls.push("endframe"); addEvent(entity, value, parameter);
    });
    try {
      f.runtime.runFrame(1100);
      expect(calls).toEqual(["clock", "think", "clock", "clock", "endframe", "clock"]);
      calls.length = 0;
      f.runtime.level.restarted = true;
      f.runtime.runFrame(1200);
      expect(calls).toEqual([]);
    } finally { clock.mockRestore(); think.mockRestore(); event.mockRestore(); f.runtime.shutdown(false); }
  });

  test("Team Arena shader remaps retain source binary32 timestamp arithmetic", () => {
    const f = setup("missionpack");
    try {
      f.cvars.set("g_redteam", "Changed");
      f.runtime.runFrame(123456789);
      expect(f.strings.get(24)).toContain("textures/ctf2/redteam01=team_icon/Changed_red:123456.79@");
    } finally { f.runtime.shutdown(false); }
  });

  test("startup publishes its owner and prints the game identity before registering cvars", () => {
    const f = setup();
    f.runtime.shutdown(false);
    const calls: string[] = [];
    const register = f.cvars.register.bind(f.cvars);
    const observed = spyOn(f.cvars, "register").mockImplementation((name, value, flags) => {
      calls.push(`register:${name}`);
      return register(name, value, flags);
    });
    try {
      const runtime = GameRuntime.create({ ...f.runtime.options, engine: { ...f.engine, print: text => {
        expect(f.owner.game).not.toBeNull();
        calls.push(text);
      } } }, f.owner);
      expect(calls.slice(0, 4)).toEqual(["------- Game Initialization -------\n", "gamename: baseq3\n",
        "gamedate: Sep  5 2026\n", "register:sv_cheats"]);
      expect(f.cvars.get("gamename")?.value).toBe("baseq3");
      expect(f.strings.get(20)).toBe("baseq3-1");
      runtime.shutdown(false);
    } finally { observed.mockRestore(); f.owner.game?.disposeResources(); }
  });

  test("speed and gravity consume rounded float cvars before conversion to player integers", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const f = setup(product);
      try {
        f.join(0);
        f.cvars.set("g_speed", "319.99999", true);
        f.cvars.set("g_gravity", "799.99999", true);
        f.runtime.runFrame(1100);
        f.send(0, command(1100));
        expect(f.runtime.pool.clientAt(0).ps.speed).toBe(320);
        expect(f.runtime.pool.clientAt(0).ps.gravity).toBe(800);
      } finally { f.runtime.shutdown(false); }
    }
  });

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: VM registration marks server entries and survives transfer past an old owner`, () => {
      const registration = new VmRegistry().reserve("qagame"), called = spyOn(registration, "called"), freed = spyOn(registration, "free");
      const f = setup(product, fixtureMap(), GameType.GT_FFA, new CvarRegistry(), registration);
      try {
        expect(registration.binding.kind).toBe("typescript"); expect(GameRuntime.registered(registration)).toBe(f.runtime);
        expect(called).toHaveBeenCalledTimes(1);
        f.join(0); f.send(0, command(1100)); f.runtime.runFrame(1100);
        expect(f.runtime.consoleCommand(["unknown_game_command"])).toBe(false);
        expect(called).toHaveBeenCalledTimes(1);
        const consoleCall = f.runtime.calls.consoleCommand(["unknown_game_command"]);
        expect(called).toHaveBeenCalledTimes(1);
        expect(finishCalls(consoleCall)).toBe(false);
        expect(finishCalls(f.runtime.calls.clientConnect(1, true, false))).toBeNull();
        finishCalls(f.runtime.calls.clientBegin(1));
        finishCalls(f.runtime.calls.clientUserinfoChanged(1));
        finishCalls(f.runtime.calls.clientCommand(1, ["score"]));
        finishCalls(f.runtime.calls.clientThink(1, command(1200)));
        finishCalls(f.runtime.calls.runFrame(1300));
        expect(() => finishCalls(f.runtime.calls.botFrame(1300))).toThrow("Game bot services unavailable");
        finishCalls(f.runtime.calls.clientDisconnect(1));
        finishCalls(f.runtime.calls.shutdown(true));
        expect(called).toHaveBeenCalledTimes(11); expect(freed).not.toHaveBeenCalled();
        const replacement = GameRuntime.create({ ...f.runtime.options, levelTime: 2000, restart: true }, f.owner, registration);
        expect(GameRuntime.registered(registration)).toBe(replacement); expect(called).toHaveBeenCalledTimes(12);
        f.runtime.disposeResources();
        expect(registration.binding.kind).toBe("typescript"); expect(GameRuntime.registered(registration)).toBe(replacement);
        expect(freed).not.toHaveBeenCalled();
        finishCalls(replacement.calls.shutdown(false)); replacement.disposeResources(); replacement.disposeResources();
        expect(called).toHaveBeenCalledTimes(13); expect(freed).toHaveBeenCalledTimes(1);
        expect(registration.binding.kind).toBe("freed"); expect(GameRuntime.registered(registration)).toBeNull();
        expect(() => finishCalls(replacement.calls.runFrame(2001))).toThrow("shut down");
        expect(called).toHaveBeenCalledTimes(13);
      } finally {
        f.owner.game?.disposeResources(); f.runtime.disposeResources(); called.mockRestore(); freed.mockRestore();
      }
    });

    test(`${product}: VM registration reinitializes an existing retail game with fresh state and no shutdown call`, () => {
      const registration = new VmRegistry().reserve("qagame"), called = spyOn(registration, "called"), freed = spyOn(registration, "free");
      const f = setup(product, fixtureMap(), GameType.GT_FFA, new CvarRegistry(), registration);
      try {
        f.join(0); f.runtime.runFrame(1800); f.runtime.pool.clientAt(0).ps.health = 1;
        const entity = f.runtime.pool.at(0), client = f.runtime.pool.clientAt(0);
        const { ps, pers, sess } = client, { s, r } = entity, level = f.runtime.level, scores = level.teamScores;
        f.runtime.consoleCommand(["addip", "1.2.3.4"]);
        f.cvars.set("g_needpass", "1", true);
        f.runtime.movementDiagnostics.count = 123;
        f.runtime.remaps.add("textures/retained", "textures/replacement", 1.25);
        const shaderStates: string[] = [];
        const replacement = GameRuntime.reinitialize({ ...f.runtime.options, levelTime: 3000, randomSeed: 123,
          configstrings: { get: index => f.strings.get(index) ?? "", set: (index, value) => {
            if (index === 24) shaderStates.push(value);
            f.strings.set(index, value);
          } } }, f.owner, registration);
        expect(replacement).not.toBe(f.runtime); expect(replacement.pool).toBe(f.runtime.pool);
        expect(replacement.level).toBe(level); expect(replacement.level.teamScores).toBe(scores);
        expect(replacement.pool.at(0)).toBe(entity); expect(replacement.pool.clientAt(0)).toBe(client);
        expect(entity.s).toBe(s); expect(entity.r).toBe(r);
        expect(client.ps).toBe(ps); expect(client.pers).toBe(pers); expect(client.sess).toBe(sess);
        expect(f.owner.game).toBe(replacement); expect(GameRuntime.registered(registration)).toBe(replacement);
        expect(replacement.level.time).toBe(3000); expect(replacement.level.startTime).toBe(3000); expect(replacement.level.frameNum).toBe(0);
        expect(replacement.pool.clientAt(0).pers.connected).toBe(ConnectionState.DISCONNECTED);
        expect(replacement.pool.clientAt(0).ps.health).toBe(0);
        expect(replacement.movementDiagnostics).toBe(f.runtime.movementDiagnostics);
        expect(replacement.movementDiagnostics.count).toBe(123);
        expect(replacement.remaps).toBe(f.runtime.remaps);
        expect(replacement.remaps.buildShaderStateConfig()).toContain("textures/retained=textures/replacement:    1.25@");
        if (product === "missionpack") expect(shaderStates[0]).toContain("team_icon/Stroggs_red:    1.80@");
        expect(f.cvars.get("g_banIPs")?.value).toBe("1.2.3.4 1.2.3.4 ");
        replacement.runFrame(3100);
        expect(f.cvars.get("g_needpass")?.value).toBe("1");
        expect(f.prints.filter(text => text === "------- Game Initialization -------\n")).toHaveLength(2);
        expect(f.prints.some(text => text === "==== ShutdownGame ====\n")).toBe(false);
        expect(called).toHaveBeenCalledTimes(2); expect(freed).not.toHaveBeenCalled();
        expect(() => f.runtime.runFrame(3001)).toThrow("shut down");
        f.runtime.disposeResources(); expect(registration.binding.kind).toBe("typescript");
        replacement.disposeResources(); expect(freed).toHaveBeenCalledTimes(1);
      } finally {
        f.owner.game?.disposeResources(); f.runtime.disposeResources(); called.mockRestore(); freed.mockRestore();
      }
    });
  }

  test("VM registration retains the successor when repeated retail INIT aborts with source control", () => {
    const registration = new VmRegistry().reserve("qagame"), freed = spyOn(registration, "free");
    const f = setup("baseq3", fixtureMap(), GameType.GT_FFA, new CvarRegistry(), registration);
    const failure = new CommonError("drop", "repeated retail INIT");
    try {
      expect(() => GameRuntime.reinitialize({ ...f.runtime.options, engine: { ...f.runtime.options.engine, print: text => {
        if (text === "------- Game Initialization -------\n") throw failure;
        f.runtime.options.engine.print(text);
      } } }, f.owner, registration)).toThrow(failure);
      const replacement = GameRuntime.registered(registration);
      expect(replacement).not.toBeNull(); expect(replacement).not.toBe(f.runtime); expect(f.owner.game).toBe(replacement);
      expect(registration.binding.kind).toBe("typescript"); expect(freed).not.toHaveBeenCalled();
      expect(() => f.runtime.runFrame(2000)).toThrow("shut down");
      replacement?.disposeResources(); expect(freed).toHaveBeenCalledTimes(1);
    } finally { f.owner.game?.disposeResources(); f.runtime.disposeResources(); freed.mockRestore(); }
  });

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    for (const point of ["first-print", "ip-bans", "after-level-clear"] satisfies readonly string[]) {
      test(`${product}: repeated INIT retains source records until their clear boundaries at ${point}`, () => {
        const registration = new VmRegistry().reserve("qagame");
        const f = setup(product, fixtureMap(), GameType.GT_FFA, new CvarRegistry(), registration);
        f.join(0); f.runtime.runFrame(1800);
        const entity = f.runtime.pool.at(0), client = f.runtime.pool.clientAt(0), level = f.runtime.level;
        client.sess.wins = 7;
        const allocation = f.runtime.memory.allocate(16); allocation.writeString("retained");
        const allocatedBytes = f.runtime.memory.allocatedBytes, oldCount = f.runtime.pool.numEntities;
        f.cvars.set("session0", "sentinel", true);
        if (point === "ip-bans") f.cvars.set("g_banIPs", "bad ", true);
        const failure = new CommonError("drop", `INIT ${point}`);
        let reached = false;
        try {
          expect(() => GameRuntime.reinitialize({ ...f.runtime.options, levelTime: 3000,
            engine: { ...f.runtime.options.engine, print: text => {
              const matches = point === "first-print" ? text === "------- Game Initialization -------\n"
                : point === "ip-bans" ? text.startsWith("Bad filter address:") : text === "Not logging to disk.\n";
              if (reached || !matches) return;
              reached = true;
              const current = f.owner.game;
              if (!(current instanceof GameRuntime)) throw new Error("Missing source INIT owner");
              expect(current.level).toBe(level); expect(current.pool.at(0)).toBe(entity);
              expect(current.pool.clientAt(0)).toBe(client); expect(entity.client).toBe(client);
              expect(client.pers.connected).toBe(ConnectionState.CONNECTED); expect(client.sess.wins).toBe(7);
              expect(entity.inuse).toBe(true); expect(current.memory).toBe(f.runtime.memory);
              expect(allocation.readString()).toBe("retained");
              const cleared = point === "after-level-clear";
              expect(current.level.time).toBe(cleared ? 3000 : 1800);
              expect(current.pool.maxClients).toBe(cleared ? 0 : 4);
              expect(current.pool.numEntities).toBe(cleared ? 0 : oldCount);
              expect(current.memory.allocatedBytes).toBe(cleared ? 0 : allocatedBytes);
              if (point === "first-print") expect(current.spawns.copyToBodyQueue(entity)?.slot).toBe(64);
              throw failure;
            } } }, f.owner, registration)).toThrow(failure);
          expect(reached).toBe(true);
          const current = f.owner.game;
          if (!(current instanceof GameRuntime)) throw new Error("Missing aborted INIT owner");
          current.shutdown(false);
          expect(f.cvars.get("session0")?.value).toBe(point === "after-level-clear" ? "sentinel" : "0 1000 1 0 7 0 0");
          current.disposeResources();
        } finally { f.owner.game?.disposeResources(); f.runtime.disposeResources(); }
      });
    }
  }

  test("repeated INIT transfers the source log and disposes handles abandoned by level clear", () => {
    const registration = new VmRegistry().reserve("qagame"), f = setup("baseq3", fixtureMap(), GameType.GT_FFA, new CvarRegistry(), registration);
    const logs: { writes: string[]; closes: number }[] = [];
    const options = { ...f.runtime.options, engine: { ...f.runtime.options.engine, openLog: () => {
      const log: { writes: string[]; closes: number } = { writes: [], closes: 0 }; logs.push(log);
      return { write: (text: string) => { log.writes.push(text); }, close: () => { log.closes++; } };
    } } };
    f.cvars.set("g_log", "games.log", true);
    try {
      GameRuntime.reinitialize(options, f.owner, registration);
      const first = logs[0]; if (first === undefined) throw new Error("Missing initial game log");
      const failure = new CommonError("drop", "log before level clear");
      let armed = true;
      expect(() => GameRuntime.reinitialize({ ...options, engine: { ...options.engine, print: () => {
        if (armed) { armed = false; throw failure; }
      } } }, f.owner, registration)).toThrow(failure);
      expect(first.closes).toBe(0); expect(logs).toHaveLength(1);
      const retained = f.owner.game;
      if (!(retained instanceof GameRuntime)) throw new Error("Missing retained game log owner");
      const replacement = GameRuntime.reinitialize(options, f.owner, registration);
      const second = logs[1]; if (second === undefined) throw new Error("Missing replacement game log");
      expect(first.closes).toBe(0); expect(second.closes).toBe(0);
      replacement.shutdown(false);
      expect(first.closes).toBe(0); expect(second.closes).toBe(1);
      expect(second.writes.some(text => text.includes("ShutdownGame:"))).toBe(true);
      replacement.disposeResources(); replacement.disposeResources();
      expect(first.closes).toBe(1); expect(second.closes).toBe(1);
    } finally { f.owner.game?.disposeResources(); f.runtime.disposeResources(); }
  });

  test("reserves source slots, spawns actual items, forms reverse team chains and steals master targets", () => {
    const f = setup("baseq3", fixtureMap(`
      { "classname" "info_notnull" "team" "pair" "targetname" "first" }
      { "classname" "info_notnull" "team" "pair" "targetname" "second" }
      { "classname" "info_notnull" "team" "pair" "targetname" "third" }`));
    expect(f.runtime.pool.at(64).classname).toBe("bodyque"); expect(f.runtime.pool.at(71).classname).toBe("bodyque");
    expect(f.runtime.pool.at(72).classname).toBe("info_player_deathmatch");
    const master = find(f.runtime, "info_notnull");
    expect(master.teammaster).toBe(master); expect(master.targetname).toBe("third");
    expect(master.teamchain?.slot).toBe(master.slot + 2); expect(master.teamchain?.teamchain?.slot).toBe(master.slot + 1);
    expect(master.teamchain?.flags).toBe(GameFlags.TEAMSLAVE); expect(master.teamchain?.targetname).toBeNull();
    const health = find(f.runtime, "item_health"); expect(health.nextthink).toBe(1200);
    f.runtime.runFrame(1100); expect(health.s.eType).toBe(EntityType.ET_GENERAL);
    f.runtime.runFrame(1200); expect(health.s.eType).toBe(EntityType.ET_ITEM); expect(f.runtime.world.linkState(health.slot)?.linked).toBe(true);
    expect(f.strings.get(20)).toBe("baseq3-1"); expect(f.strings.get(21)).toBe("1000"); expect(f.strings.get(27)?.includes("1")).toBe(true);
    f.runtime.shutdown(false);
  });

  test("runs real admission, asynchronous and synchronous movement, item pickup and source event expiry", () => {
    const f = setup(), entity = f.join(0), client = f.runtime.pool.clientAt(0);
    expect(client.pers.connected).toBe(ConnectionState.CONNECTED); expect(entity.health).toBe(125);
    expect(f.runtime.level.numPlayingClients).toBe(1); expect(f.strings.get(544)).toContain("Player0");
    f.runtime.runFrame(1200);
    const before = { ...client.ps.origin };
    f.send(0, command(1250, { forwardmove: 127 })); expect(client.ps.origin).not.toEqual(before);
    f.cvars.set("g_synchronousClients", "1", true); f.runtime.runFrame(1300);
    const delayed = { ...client.ps.origin };
    f.send(0, command(1350, { forwardmove: 127 })); expect(client.ps.origin).toEqual(delayed);
    f.runtime.runFrame(1400); expect(client.ps.origin).not.toEqual(delayed);
    damage(f.runtime.combat, entity, null, null, null, null, 50, 0, 0);
    const health = find(f.runtime, "item_health");
    if (health.touch === null) throw new Error("Actual item touch callback missing");
    health.touch(health, entity, f.runtime.world.trace({ start: entity.r.currentOrigin, end: entity.r.currentOrigin, shape: { kind: "point" }, mask: 1, passEntityNum: entity.slot }));
    expect(entity.health).toBe(100); expect(health.unlinkAfterEvent).toBe(true);
    const event = f.runtime.pool.tempEntity(client.ps.origin, EntityEvent.EV_GENERAL_SOUND);
    f.runtime.runFrame(1700); expect(event.inuse).toBe(true);
    f.runtime.runFrame(1701); expect(event.inuse).toBe(false); expect(f.runtime.world.linkState(health.slot)?.linked).toBe(false);
    f.runtime.shutdown(false);
  });

  test("uses cached integer weapon respawn cvars for actual pickups in both products and team modes", () => {
    const products: readonly Product[] = ["baseq3", "missionpack"];
    for (const product of products) for (const type of [GameType.GT_FFA, GameType.GT_TEAM]) {
      const cvars = new CvarRegistry();
      cvars.set("g_weaponrespawn", "0.75", true);
      cvars.set("g_weaponTeamRespawn", "-0.75", true);
      const f = setup(product, fixtureMap('{ "classname" "weapon_shotgun" "origin" "0 200 24" }'), type, cvars);
      try {
        const player = f.join(0), client = f.runtime.pool.clientAt(0);
        f.runtime.runFrame(1200);
        client.pers.predictItemPickup = true;
        const shotgun = find(f.runtime, "weapon_shotgun");
        const touch = shotgun.touch;
        if (touch === null) throw new Error("Actual weapon touch callback missing");
        const trace = f.runtime.world.trace({ start: player.r.currentOrigin, end: player.r.currentOrigin,
          shape: { kind: "point" }, mask: 1, passEntityNum: player.slot });
        const sequence = client.ps.eventSequence;
        touch(shotgun, player, trace);
        expect(client.ps.ammo.get(Weapon.WP_SHOTGUN)).toBe(10);
        expect(client.ps.eventSequence).toBe(sequence);
        expect(shotgun.r.contents).toBe(0x40000000);
        expect(shotgun.r.svFlags & ServerEntityFlags.NOCLIENT).toBe(0);
        expect(shotgun.nextthink).toBe(0);

        cvars.set("g_weaponrespawn", "2.75", true);
        cvars.set("g_weaponTeamRespawn", "6.25", true);
        touch(shotgun, player, trace);
        expect(client.ps.eventSequence).toBe(sequence);
        expect(shotgun.r.contents).toBe(0x40000000);
        expect(shotgun.nextthink).toBe(0);

        f.runtime.runFrame(1300);
        const updatedSequence = client.ps.eventSequence;
        touch(shotgun, player, trace);
        const respawnTime = type === GameType.GT_TEAM ? 7300 : 3300;
        expect(client.ps.eventSequence).toBe(updatedSequence + 1);
        expect(shotgun.r.contents).toBe(0);
        expect(shotgun.r.svFlags & ServerEntityFlags.NOCLIENT).toBe(ServerEntityFlags.NOCLIENT);
        expect(shotgun.nextthink).toBe(respawnTime);
        f.runtime.runFrame(respawnTime - 1);
        expect(shotgun.r.contents).toBe(0);
        f.runtime.runFrame(respawnTime);
        expect(shotgun.r.contents).toBe(0x40000000);
        expect(shotgun.r.svFlags & ServerEntityFlags.NOCLIENT).toBe(0);
        expect(shotgun.nextthink).toBe(0);
      } finally { f.runtime.shutdown(false); }
    }
  });

  test("uses source integer obelisk timers at spawn, regen and respawn", () => {
    for (const value of ["1e3", "0x10"]) {
      const delay = value === "1e3" ? 1000 : 0;
      const cvars = new CvarRegistry();
      cvars.set("g_obeliskRegenPeriod", value, true);
      cvars.set("g_obeliskRespawnDelay", value, true);
      const f = setup("missionpack", fixtureMap('{ "classname" "team_redobelisk" "origin" "0 200 24" "spawnflags" "1" }'), GameType.GT_OBELISK, cvars);
      try {
        const player = f.join(0), model = find(f.runtime, "team_redobelisk");
        const obelisk = f.runtime.pool.at(model.slot + 1);
        expect(obelisk.activator).toBe(model);
        expect(obelisk.nextthink).toBe(1000 + delay);
        damage(f.runtime.combat, obelisk, player, player, null, null, 100, 0, 6);
        expect(obelisk.health).toBe(2400);
        const regenTime = 1000 + Math.max(delay, 100);
        f.runtime.runFrame(regenTime);
        expect(obelisk.health).toBe(2415);
        expect(obelisk.nextthink).toBe(regenTime + delay);

        const updatedValue = value === "1e3" ? "0x10" : "1e3";
        const updatedDelay = value === "1e3" ? 0 : 1000;
        cvars.set("g_obeliskRegenPeriod", updatedValue, true);
        cvars.set("g_obeliskRespawnDelay", updatedValue, true);
        damage(f.runtime.combat, obelisk, player, player, null, null, 10000, 0, 6);
        expect(obelisk.takedamage).toBe(false);
        expect(obelisk.nextthink).toBe(regenTime + delay);
        const respawnTime = regenTime + Math.max(delay, 100);
        f.runtime.runFrame(respawnTime);
        expect(obelisk.takedamage).toBe(true);
        expect(obelisk.health).toBe(2500);
        expect(obelisk.nextthink).toBe(respawnTime + updatedDelay);
        damage(f.runtime.combat, obelisk, player, player, null, null, 10000, 0, 6);
        expect(obelisk.takedamage).toBe(false);
        expect(obelisk.nextthink).toBe(respawnTime + updatedDelay);
        f.runtime.runFrame(respawnTime + Math.max(updatedDelay, 100));
        expect(obelisk.takedamage).toBe(true);
        expect(obelisk.health).toBe(2500);
      } finally { f.runtime.shutdown(false); }
    }
  });

  test("dispatches timer-created missiles in the same frame and advances actual brush movers", () => {
    const source = fixtureMap(`
      { "classname" "shooter_rocket" "origin" "0 0 100" "targetname" "gun" }
      { "classname" "func_timer" "target" "gun" "wait" "1" "random" "0" "spawnflags" "1" }
      { "classname" "func_door" "model" "*1" "origin" "0 300 40" "speed" "100" }`);
    const bounds = { min: vec3(-8, -32, -32), max: vec3(8, 32, 32) };
    const planes = [{ normal: vec3(1, 0, 0), distance: 8 }, { normal: vec3(-1, 0, 0), distance: 8 },
      { normal: vec3(0, 1, 0), distance: 32 }, { normal: vec3(0, -1, 0), distance: 32 },
      { normal: vec3(0, 0, 1), distance: 32 }, { normal: vec3(0, 0, -1), distance: 32 }];
    const map: BspMap = { ...source, planes: [...source.planes, ...planes],
      models: [...source.models, { bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 1, brushCount: 1 }],
      brushes: [...source.brushes, { firstSide: 6, sideCount: 6, shader: 0 }],
      brushSides: [...source.brushSides, ...planes.map((_, index) => ({ plane: index + 6, shader: 0 }))] };
    const f = setup("baseq3", map), door = find(f.runtime, "func_door");
    f.runtime.runFrame(1100);
    const rocket = find(f.runtime, "rocket");
    expect(rocket.s.pos.time).toBe(1050); expect(rocket.r.currentOrigin.x).toBeGreaterThan(40);
    expect(f.runtime.world.linkState(rocket.slot)?.linked).toBe(true);
    const trigger = find(f.runtime, "door_trigger"), player = f.join(0);
    const client = f.runtime.pool.clientAt(0);
    client.sess.sessionTeam = Team.TEAM_SPECTATOR;
    client.ps.origin = vec3(0, 300, 40); player.s.origin = { ...client.ps.origin };
    trigger.classname = "renamed_real_door_trigger";
    f.runtime.think.touchTriggers(player);
    expect(client.ps.origin).toEqual(vec3(141, 300, 41));
    const impostor = f.runtime.pool.spawn();
    impostor.classname = "door_trigger"; impostor.r.contents = 0x40000000;
    impostor.r.mins = vec3(-20, -20, -20); impostor.r.maxs = vec3(20, 20, 20);
    impostor.r.currentOrigin = vec3(500, 300, 40);
    let impostorTouches = 0;
    impostor.touch = () => { impostorTouches++; };
    f.runtime.world.link(impostor);
    client.ps.origin = { ...impostor.r.currentOrigin }; player.s.origin = { ...client.ps.origin };
    f.runtime.think.touchTriggers(player);
    expect(impostorTouches).toBe(0);
    const unrelatedTouch = impostor.touch, realDoorTouch = trigger.touch;
    impostor.touch = realDoorTouch;
    expect(f.runtime.moverSpawns.isDoorTrigger(impostor)).toBe(true);
    trigger.touch = unrelatedTouch;
    expect(f.runtime.moverSpawns.isDoorTrigger(trigger)).toBe(false);
    impostor.touch = unrelatedTouch; trigger.touch = realDoorTouch;
    client.sess.sessionTeam = Team.TEAM_FREE;
    if (trigger.touch === null) throw new Error("Real door touch missing");
    trigger.touch(trigger, player, f.runtime.world.trace({ start: player.r.currentOrigin, end: player.r.currentOrigin, shape: { kind: "point" }, mask: 1, passEntityNum: 0 }));
    const before = { ...door.r.currentOrigin }; f.runtime.runFrame(1200);
    expect(door.r.currentOrigin.x).toBeGreaterThan(before.x);
    f.runtime.shutdown(false);
  });

  test("shares combat/death/ranks, respawns through commands, and completes a human intermission with bots disabled", () => {
    const f = setup(), attacker = f.join(0), victim = f.join(1);
    damage(f.runtime.combat, victim, attacker, attacker, null, victim.r.currentOrigin, 150, 0, 3);
    expect(victim.health).toBeLessThanOrEqual(0); expect(f.runtime.pool.clientAt(0).ps.persistant.get(PersistentIndex.PERS_SCORE)).toBe(1);
    expect(f.runtime.level.sortedClients[0]).toBe(0); expect(f.messages.some(message => message.text.startsWith("scores "))).toBe(true);
    f.runtime.runFrame(3000); f.send(1, command(3000, { buttons: CommandButtons.ATTACK }));
    expect(f.runtime.pool.at(1).health).toBeGreaterThan(0); expect(f.runtime.pool.at(64).timestamp).toBe(3000);
    f.cvars.set("fraglimit", "1", true); f.runtime.runFrame(3100); expect(f.runtime.level.intermissionQueued).toBe(3100);
    f.runtime.runFrame(4100); expect(f.runtime.level.intermissionTime).toBe(4100);
    f.runtime.pool.clientAt(0).readyToExit = true; f.runtime.pool.clientAt(1).readyToExit = true;
    f.runtime.runFrame(9200); expect(f.console).toContain("vstr nextmap\n");
    expect(f.runtime.pool.clientAt(0).pers.connected).toBe(ConnectionState.CONNECTING);
    expect(f.cvars.get("session0")?.value).toBeDefined();
    f.runtime.shutdown(false); expect(() => f.runtime.runFrame(9300)).toThrow("shut down");
  });

  test("uses the source integer timelimit for disabled fractions and the exact minute boundary", () => {
    const products: readonly Product[] = ["baseq3", "missionpack"];
    for (const product of products) {
      const f = setup(product);
      try {
        f.join(0);
        f.cvars.set("timelimit", "0.25", true);
        f.runtime.runFrame(3000);
        expect(f.runtime.level.intermissionQueued).toBe(0);
        expect(f.runtime.level.intermissionTime).toBe(0);
        f.cvars.set("timelimit", "1.75", true);
        f.runtime.runFrame(60999);
        expect(f.runtime.level.intermissionQueued).toBe(0);
        f.runtime.runFrame(61000);
        expect(f.runtime.level.intermissionQueued).toBe(61000);
        f.runtime.runFrame(62000);
        expect(f.runtime.level.intermissionTime).toBe(62000);
      } finally { f.runtime.shutdown(false); }
    }
  });

  test("replays isolated seeded runtimes identically and preserves restart sessions", () => {
    const a = setup(), b = setup(); a.join(0); b.join(0);
    for (let time = 1100; time <= 2000; time += 100) {
      a.send(0, command(time, { forwardmove: 100, rightmove: 40 })); a.runtime.runFrame(time);
      b.send(0, command(time, { forwardmove: 100, rightmove: 40 })); b.runtime.runFrame(time);
    }
    expect(state(a.runtime)).toEqual(state(b.runtime));
    a.runtime.pool.clientAt(0).sess.wins = 7; a.runtime.shutdown(true); b.runtime.shutdown(false);
    const restarted = setup("baseq3", fixtureMap(), GameType.GT_FFA, a.cvars);
    expect(restarted.runtime.clientConnect(0, false, false)).toBeNull(); restarted.runtime.clientBegin(0);
    expect(restarted.runtime.pool.clientAt(0).sess.wins).toBe(7);
    expect(() => restarted.runtime.clientConnect(1, true, true)).toThrow("Game bot services unavailable");
    restarted.runtime.shutdown(false);
  });

  test("makes unsupported bot startup visible and keeps the source cvar cache until a frame", () => {
    const f = setup(); f.join(0);
    f.cvars.set("g_speed", "500", true); expect(f.runtime.think.host.settings().speed).toBe(320);
    f.runtime.runFrame(1100); expect(f.runtime.think.host.settings().speed).toBe(500);
    expect(f.messages.some(message => message.text.includes("g_speed changed to 500"))).toBe(true);
    f.runtime.shutdown(false); f.cvars.set("bot_enable", "1", true);
    expect(() => GameRuntime.create(f.runtime.options, f.owner)).toThrow("Game bot services unavailable");
    f.cvars.set("bot_enable", "0", true);
  });

  test("retains engine method receivers, closes the source log once and writes sessions", () => {
    const f = setup(); f.runtime.shutdown(false); f.cvars.set("g_log", "memory.log", true);
    const records: string[] = [];
    const engine = { ...f.engine, records,
      print(text: string): void { this.records.push(`print:${text}`); },
      insertConsoleCommand(text: string): void { this.records.push(`insert:${text}`); },
      openLog(path: string, synchronous: boolean) {
        this.records.push(`open:${path}:${synchronous}`);
        const owner = this;
        return { write(text: string): void { owner.records.push(`write:${text}`); }, close(): void { owner.records.push("close"); } };
      } };
    const runtime = GameRuntime.create({ ...f.runtime.options, engine, levelTime: 60123000 }, f.owner);
    runtime.options.engine.insertConsoleCommand("echo queued\n");
    expect(records).toContain("insert:echo queued\n");
    expect(runtime.clientConnect(0, true, false)).toBeNull();
    expect(records).toContain("write:1002:03ClientConnect: 0\n");
    runtime.shutdown(false); runtime.shutdown(false);
    expect(records.filter(record => record === "close")).toHaveLength(1);
    expect(f.cvars.get("session")?.value).toBe("0");
  });

  test("uses invalid cached gametypes during startup and admission until the first ordinary cvar update", () => {
    const products: readonly Product[] = ["baseq3", "missionpack"];
    for (const product of products) for (const value of [-1, 8]) {
      const map = fixtureMap(`
        { "classname" "info_notnull" "targetname" "notfree" "notfree" "1" }
        { "classname" "info_notnull" "targetname" "notteam" "notteam" "1" }
        { "classname" "info_notnull" "targetname" "single" "notsingle" "1" }
        { "classname" "info_notnull" "targetname" "named-mode" "gametype" "ctf" }
        ${product === "missionpack" ? `
          { "classname" "team_redobelisk" "origin" "0 200 24" }
          { "classname" "team_blueobelisk" "origin" "0 -200 24" }
          { "classname" "team_neutralobelisk" "origin" "0 300 24" }` : ""}`);
      const f = setup(product, map, value);
      try {
        expect(f.cvars.get("g_gametype")?.value).toBe("0");
        expect(f.runtime.gameType).toBe(value);
        expect(f.prints).toContain(`g_gametype ${value} is out of range, defaulting to 0\n`);
        expect(f.runtime.level.newSession).toBe(true);
        expect(f.prints).toContain("Gametype changed, clearing session data.\n");
        const entities = Array.from({ length: f.runtime.pool.numEntities }, (_, index) => f.runtime.pool.at(index)).filter(entity => entity.inuse);
        const targets = entities.map(entity => entity.targetname).filter(target => target !== null);
        expect(targets).toEqual([value < 0 ? "notteam" : "notfree", "single", "named-mode"]);
        const filtered = f.runtime.spawnReport.outcomes.filter(outcome => outcome.kind === "filtered");
        expect(filtered).toHaveLength(1);
        expect(filtered[0]?.reason).toBe(value < 0 ? "notfree" : "notteam");
        expect(f.strings.has(23)).toBe(false);
        if (product === "missionpack") {
          const obelisks = entities.filter(entity => entity.classname?.endsWith("obelisk"));
          expect(obelisks.map(entity => entity.classname)).toEqual(value < 0 ? [] : ["team_redobelisk", "team_blueobelisk"]);
          for (const obelisk of obelisks) {
            expect(obelisk.s.eType).toBe(EntityType.ET_TEAM);
            expect(f.runtime.world.linkState(obelisk.slot)?.linked).toBe(true);
          }
        }
        f.users.set(0, "\\name\\Player0\\ip\\localhost\\model\\sarge/default\\team_model\\james/default");
        expect(f.runtime.clientConnect(0, true, false)).toBeNull();
        expect(f.runtime.pool.clientAt(0).sess.sessionTeam).toBe(value < 0 ? Team.TEAM_FREE : Team.TEAM_BLUE);
        expect(f.strings.get(544)).toContain(value < 0 ? "model\\sarge/default" : "model\\james/default");
        expect(f.runtime.gameType).toBe(value);
        f.runtime.runFrame(1100);
        expect(f.runtime.gameType).toBe(GameType.GT_FFA);
        f.runtime.clientUserinfoChanged(0);
        expect(f.strings.get(544)).toContain("model\\sarge/default");
        expect(f.messages.some(message => message.text.includes("g_gametype changed"))).toBe(false);
        expect(f.runtime.level.newSession).toBe(true);
      } finally { f.runtime.shutdown(false); }
      expect(f.cvars.get("session")?.value).toBe("0");
    }
  });

  test("compares and writes the cached session gametype when shutdown precedes the first frame", () => {
    const products: readonly Product[] = ["baseq3", "missionpack"];
    for (const product of products) for (const value of [-1, 8]) {
      const cvars = new CvarRegistry();
      cvars.set("session", String(value), true);
      const f = setup(product, fixtureMap(), value, cvars);
      try {
        expect(f.runtime.level.newSession).toBe(false);
        expect(f.prints).not.toContain("Gametype changed, clearing session data.\n");
        expect(f.runtime.gameType).toBe(value);
      } finally { f.runtime.shutdown(false); }
      expect(cvars.get("g_gametype")?.value).toBe("0");
      expect(cvars.get("session")?.value).toBe(String(value));
    }
  });
});

describe("source single-player arenas in the actual game runtime", () => {
  test("base intermission copies ranked models, moves real podiums and runs the winner's shared-client celebration", () => {
    const f = setup("baseq3", fixtureMap(), GameType.GT_SINGLE_PLAYER);
    try {
      f.join(0); const winner = f.join(1); f.join(2);
      const real = f.runtime.pool.clientAt(0), winnerClient = f.runtime.pool.clientAt(1);
      real.accuracyShots = 3; real.accuracyHits = 2;
      real.ps.persistant.set(PersistentIndex.PERS_IMPRESSIVE_COUNT, 2);
      real.ps.persistant.set(PersistentIndex.PERS_EXCELLENT_COUNT, 3);
      real.ps.persistant.set(PersistentIndex.PERS_GAUNTLET_FRAG_COUNT, 4);
      real.ps.persistant.set(PersistentIndex.PERS_SCORE, 20);
      winnerClient.ps.persistant.set(PersistentIndex.PERS_SCORE, 30);
      f.runtime.pool.clientAt(2).ps.persistant.set(PersistentIndex.PERS_SCORE, 10);
      winner.s.weapon = Weapon.WP_GAUNTLET;
      winner.s.eFlags = 0x204; winner.s.powerups = 7; winner.s.loopSound = 18; winner.s.event = 19;
      winner.s.modelindex = 77; winner.s.eventParm = 21; winner.s.time2 = 321;
      winner.s.apos = { type: TrajectoryType.TR_LINEAR, time: 42, duration: 50, base: vec3(15, 25, 35), delta: vec3(1, 2, 3) };
      winner.r.svFlags = ServerEntityFlags.BOT | ServerEntityFlags.BROADCAST;
      winner.r.model = { kind: "capsule" }; winner.r.ownerNum = 17;
      const firstSlot = f.runtime.pool.numEntities;
      f.runtime.match.beginIntermission();
      expect(f.console).toEqual(["postgame 3 0 66 2 3 4 20 0 1 0 30 0 1 20 2 2 10"]);
      const pad = f.runtime.pool.at(firstSlot), first = f.runtime.pool.at(firstSlot + 1);
      const second = f.runtime.pool.at(firstSlot + 2), third = f.runtime.pool.at(firstSlot + 3);
      expect(pad.classname).toBe("podium"); expect(pad.s.eType).toBe(EntityType.ET_GENERAL);
      expect(f.strings.get(32 + pad.s.modelindex)).toBe("models/mapobjects/podium/podium4.md3");
      expect(pad.clipmask).toBe(1); expect(pad.r.contents).toBe(1);
      expect(pad.r.currentOrigin).toEqual(vec3(80, 0, 230)); expect(pad.s.apos.base).toEqual(vec3(0, 180, 0));
      expect(first.client).toBe(winnerClient); expect(first.classname).toBe("Player1");
      expect(first.s).not.toBe(winner.s); expect(first.s.eType).toBe(EntityType.ET_PLAYER);
      expect(first.s.number).toBe(first.slot); expect(first.s.clientNum).toBe(1);
      expect(first.s.eFlags | first.s.powerups | first.s.loopSound | first.s.event).toBe(0);
      expect(first.s.modelindex).toBe(77); expect(first.s.eventParm).toBe(21); expect(first.s.time2).toBe(321);
      expect(first.s.apos).toEqual({ type: TrajectoryType.TR_LINEAR, time: 42, duration: 50, base: vec3(0, 180, 0), delta: vec3(1, 2, 3) });
      expect(first.r.svFlags).toBe(ServerEntityFlags.BOT | ServerEntityFlags.BROADCAST);
      expect(first.r.model).toEqual({ kind: "capsule" }); expect(first.r.ownerNum).toBe(17);
      expect(first.r.mins).toEqual(winner.r.mins); expect(first.r.mins).not.toBe(winner.r.mins);
      expect(first.r.maxs).toEqual(winner.r.maxs); expect(first.clipmask).toBe(0x10001); expect(first.r.contents).toBe(0x2000000);
      expect(first.timestamp).toBe(1000); expect(first.physicsObject).toBe(true); expect(first.physicsBounce).toBe(0); expect(first.takedamage).toBe(false);
      expect(first.s.groundEntityNum).toBe(ENTITYNUM_WORLD); expect(first.s.legsAnim).toBe(PlayerAnimation.LEGS_IDLE);
      expect(first.s.torsoAnim).toBe(PlayerAnimation.TORSO_STAND2); expect(first.s.pos.type).toBe(TrajectoryType.TR_STATIONARY);
      expect(first.r.currentOrigin).toEqual(vec3(80, 0, 304));
      expect(second.r.currentOrigin.x).toBeCloseTo(90, 4); expect(second.r.currentOrigin.y).toBe(60); expect(second.r.currentOrigin.z).toBe(284);
      expect(third.r.currentOrigin.x).toBeCloseTo(99, 4); expect(third.r.currentOrigin.y).toBe(-60); expect(third.r.currentOrigin.z).toBe(275);
      expect([first.count, second.count, third.count]).toEqual([0, 1, 2]);
      expect(first.nextthink).toBe(3000); expect(second.nextthink).toBe(0); expect(third.nextthink).toBe(0);
      const padLink = f.runtime.world.linkState(pad.slot), firstLink = f.runtime.world.linkState(first.slot);
      expect(padLink?.linked).toBe(true); expect(firstLink?.linked).toBe(true);
      f.cvars.set("g_podiumDist", "100", true); f.cvars.set("g_podiumDrop", "80", true);
      f.runtime.level.intermissionAngle = vec3(0, 90, 0);
      f.runtime.runFrame(1100);
      expect(pad.r.currentOrigin).toEqual(vec3(-0.000004371138857095502, 100, 220));
      expect(first.r.currentOrigin).toEqual(vec3(-0.000004371138857095502, 100, 294));
      expect(first.s.apos.base).toEqual(vec3(0, 270, 0)); expect(pad.s.apos.base).toEqual(vec3(0, 180, 0));
      expect(pad.nextthink).toBe(1200);
      expect(f.runtime.world.linkState(pad.slot)).toEqual(padLink); expect(f.runtime.world.linkState(first.slot)).toEqual(firstLink);
      f.runtime.runFrame(2999); expect(first.s.torsoAnim).toBe(PlayerAnimation.TORSO_STAND2);
      f.runtime.runFrame(3000); expect(first.s.torsoAnim).toBe(128 | PlayerAnimation.TORSO_GESTURE);
      expect(first.nextthink).toBe(5294); expect(first.eventTime).toBe(3000); expect(first.s.event).toBe(0);
      expect(winnerClient.ps.externalEvent & 255).toBe(EntityEvent.EV_TAUNT); expect(winnerClient.ps.externalEventTime).toBe(3000);
      f.runtime.runFrame(5293); expect(first.s.torsoAnim).toBe(128 | PlayerAnimation.TORSO_GESTURE);
      f.runtime.runFrame(5294); expect(first.s.torsoAnim).toBe(PlayerAnimation.TORSO_STAND2); expect(first.nextthink).toBe(0);
    } finally { f.runtime.shutdown(false); }
  });

  test("retains the unconditional second ranked cell and isolates abort_podium between game instances", () => {
    const a = setup("baseq3", fixtureMap(), GameType.GT_SINGLE_PLAYER), b = setup("baseq3", fixtureMap(), GameType.GT_SINGLE_PLAYER);
    try {
      b.cvars.set("g_podiumDist", "16777217", true); b.cvars.set("g_podiumDrop", "16777217", true);
      for (const f of [a, b]) { const player = f.join(0); player.s.weapon = Weapon.WP_NONE; f.runtime.match.beginIntermission(); }
      const aPad = find(a.runtime, "podium"), bPad = find(b.runtime, "podium");
      expect(bPad.r.currentOrigin).toEqual(vec3(16777216, 0, -16776916));
      const first = a.runtime.pool.at(aPad.slot + 1), second = a.runtime.pool.at(aPad.slot + 2);
      expect(a.console).toEqual(["postgame 1 0 0 0 0 0 0 0 0 16384 0"]);
      expect(first.client).toBe(a.runtime.pool.clientAt(0)); expect(second.client).toBe(first.client);
      expect(first.s.weapon).toBe(Weapon.WP_MACHINEGUN); expect(first.count).toBe(0); expect(second.count).toBe(0);
      expect(a.runtime.pool.numEntities).toBe(aPad.slot + 3);
      expect(a.runtime.consoleCommand(["abort_podium"])).toBe(true); expect(first.nextthink).toBe(1000);
      expect(b.runtime.pool.at(bPad.slot + 1).nextthink).toBe(3000);
      a.runtime.runFrame(1100); expect(first.nextthink).toBe(0); expect(first.s.torsoAnim).toBe(128 | PlayerAnimation.TORSO_STAND);
      a.runtime.runFrame(4000); expect(first.s.torsoAnim).toBe(128 | PlayerAnimation.TORSO_STAND); expect(first.client?.ps.externalEvent).toBe(0);
      b.runtime.runFrame(3000); expect(b.runtime.pool.at(bPad.slot + 1).s.torsoAnim).toBe(128 | PlayerAnimation.TORSO_GESTURE);
    } finally { a.runtime.shutdown(false); b.runtime.shutdown(false); }
  });

  test("podium classnames follow actual userinfo renames until reassigned or freed and reused", () => {
    const f = setup("baseq3", fixtureMap(), GameType.GT_SINGLE_PLAYER);
    try {
      f.join(0); f.runtime.match.beginIntermission();
      const pad = find(f.runtime, "podium"), first = f.runtime.pool.at(pad.slot + 1), second = f.runtime.pool.at(pad.slot + 2);
      function rename(name: string): void {
        f.users.set(0, `\\name\\${name}\\ip\\localhost\\handicap\\100\\model\\sarge/default`);
        f.runtime.clientUserinfoChanged(0);
      }
      rename("First rename");
      expect(first.classname).toBe("First rename"); expect(second.classname).toBe("First rename");
      first.classname = "assigned podium";
      rename("Second rename");
      expect(first.classname).toBe("assigned podium"); expect(second.classname).toBe("Second rename");
      expect(first.client).toBe(f.runtime.pool.clientAt(0)); expect(second.client).toBe(first.client);
      f.runtime.pool.free(second);
      rename("Third rename");
      expect(second.classname).toBe("freed"); expect(second.client).toBeNull();
      const reused = f.runtime.pool.spawn();
      expect(reused).toBe(second); expect(reused.classname).toBe("noclass");
      rename("Fourth rename");
      expect(reused.classname).toBe("noclass"); expect(reused.client).toBeNull();
    } finally { f.runtime.shutdown(false); }
  });

  test("Team Arena intermission emits its blue-player awards and red/blue scores through the real console owner", () => {
    const cvars = new CvarRegistry(); cvars.set("ui_singlePlayerActive", "1", true);
    const f = setup("missionpack", fixtureMap(), GameType.GT_CTF, cvars);
    try {
      const bot = f.join(0); f.join(1); bot.r.svFlags |= ServerEntityFlags.BOT;
      const red = f.runtime.pool.clientAt(0), blue = f.runtime.pool.clientAt(1);
      red.sess.sessionTeam = Team.TEAM_RED; blue.sess.sessionTeam = Team.TEAM_BLUE;
      red.ps.persistant.set(PersistentIndex.PERS_SCORE, 23); blue.ps.persistant.set(PersistentIndex.PERS_SCORE, 17);
      blue.accuracyShots = 7; blue.accuracyHits = 3;
      blue.ps.persistant.set(PersistentIndex.PERS_IMPRESSIVE_COUNT, 2); blue.ps.persistant.set(PersistentIndex.PERS_EXCELLENT_COUNT, 3);
      blue.ps.persistant.set(PersistentIndex.PERS_DEFEND_COUNT, 4); blue.ps.persistant.set(PersistentIndex.PERS_ASSIST_COUNT, 5);
      blue.ps.persistant.set(PersistentIndex.PERS_GAUNTLET_FRAG_COUNT, 6); blue.ps.persistant.set(PersistentIndex.PERS_CAPTURES, 7);
      f.runtime.level.teamScores.set(Team.TEAM_RED, 3); f.runtime.level.teamScores.set(Team.TEAM_BLUE, 5);
      const oldCount = f.runtime.pool.numEntities;
      f.runtime.match.beginIntermission();
      expect(cvars.get("ui_singlePlayerActive")?.value).toBe("0");
      expect(f.console).toEqual(["postgame 2 1 42 2 3 4 5 6 17 1 3 5 1000 7 0 1 23 1 1 17"]);
      expect(f.runtime.pool.numEntities).toBe(oldCount);
      expect(f.runtime.consoleCommand(["abort_podium"])).toBe(true);
    } finally { f.runtime.shutdown(false); }
  });

  test("Team Arena keeps source winner-pointer, runner-up and tied-score postgame rules", () => {
    const cases = [
      { scores: [30, 20, 10], header: "postgame 3 0 0 0 0 0 0 0 30 1 30 20 1000 0" },
      { scores: [10, 30, 20], header: "postgame 3 0 0 0 0 0 0 0 10 0 20 30 1000 0" },
      { scores: [30, 30, 10], header: "postgame 3 0 0 0 0 0 0 0 30 1 30 30 1000 0" },
    ];
    for (const example of cases) {
      const f = setup("missionpack");
      try {
        for (const [number, score] of example.scores.entries()) { f.join(number); f.runtime.pool.clientAt(number).ps.persistant.set(PersistentIndex.PERS_SCORE, score); }
        f.runtime.arenas.updateTournamentInfo();
        expect(f.console.filter(text => text.startsWith("postgame "))[0]?.startsWith(example.header + " ")).toBe(true);
      } finally { f.runtime.shutdown(false); }
    }
  });

  test("both products choose the first in-use human even when spectating, and leave ranks alone without one", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const f = setup(product);
      try {
        const bot = f.join(0), spectator = f.join(1), player = f.join(2); bot.r.svFlags |= ServerEntityFlags.BOT;
        f.runtime.pool.clientAt(1).sess.sessionTeam = Team.TEAM_SPECTATOR;
        f.runtime.pool.clientAt(2).ps.persistant.set(PersistentIndex.PERS_SCORE, 7);
        f.runtime.arenas.updateTournamentInfo();
        expect(f.console).toEqual([product === "baseq3" ? "postgame 2 1 0 0 0 0 0 0 2 0 7 0 1 0"
          : "postgame 2 1 0 0 0 0 0 0 0 0 0 0 0 2 0 7 0 1 0"]);
        spectator.r.svFlags |= ServerEntityFlags.BOT; player.r.svFlags |= ServerEntityFlags.BOT;
        f.runtime.level.follow1 = 37;
        f.runtime.arenas.updateTournamentInfo();
        expect(f.runtime.level.follow1).toBe(37); expect(f.console).toHaveLength(1);
      } finally { f.runtime.shutdown(false); }
    }
  });

  test("uses signed integer accuracy and exposes the source's unincremented message-length overflow", () => {
    const f = setup();
    try {
      f.join(0); const client = f.runtime.pool.clientAt(0);
      client.accuracyShots = 3; client.accuracyHits = 2147483647;
      f.runtime.arenas.updateTournamentInfo();
      expect(f.console).toEqual(["postgame 1 0 -33 0 0 0 0 1 0 0 0"]);
      f.runtime.shutdown(false); f.cvars.set("sv_maxclients", "64", true);
      const runtime = GameRuntime.create(f.runtime.options, f.owner);
      try {
        runtime.level.intermissionTime = 1000;
        for (let number = 0; number < 64; number++) {
          runtime.pool.at(number).inuse = true;
          const connected = runtime.pool.clientAt(number);
          connected.pers.connected = ConnectionState.CONNECTING;
          connected.ps.persistant.set(PersistentIndex.PERS_RANK, 2147483647);
          connected.ps.persistant.set(PersistentIndex.PERS_SCORE, 2147483647);
        }
        expect(() => runtime.arenas.updateTournamentInfo()).toThrow("source 1024-byte message buffer");
        expect(f.console).toHaveLength(1); expect(runtime.level.numNonSpectatorClients).toBe(64);
      } finally { runtime.shutdown(false); }
    } finally { f.runtime.shutdown(false); }
  });
});

describe.skipIf(process.env["Q3_DATA"] === undefined)("retail authoritative map composition", () => {
  test("spawns complete base and Team Arena map entities, runs clients and actual team flag rules", async () => {
    const dataPath = process.env["Q3_DATA"]; if (dataPath === undefined) throw new Error("Q3_DATA required");
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
      for (const [name, type] of [["q3dm1", GameType.GT_FFA], [product === "baseq3" ? "q3ctf1" : "mpteam1", GameType.GT_CTF]] satisfies readonly (readonly [string, GameType])[]) {
        const map = parseBsp(await assets.read(`maps/${name}.bsp`));
        const f = setup(product, map, type);
        expect(f.runtime.spawnReport.outcomes.filter(result => result.kind === "unknown")).toEqual([]);
        f.runtime.runFrame(1100); f.runtime.runFrame(1200); f.runtime.runFrame(1300);
        const player = f.join(0); f.join(1);
        for (let time = 1400; time <= 2000; time += 100) { f.send(0, command(time, { forwardmove: 50, buttons: time === 1800 ? CommandButtons.ATTACK : 0 })); f.runtime.runFrame(time); }
        expect(f.runtime.world.linkState(0)?.linked).toBe(true); expect(f.runtime.level.numPlayingClients).toBe(2);
        if (type === GameType.GT_CTF) {
          const client = f.runtime.pool.clientAt(0), ownTeam = client.sess.sessionTeam;
          const enemy = find(f.runtime, ownTeam === Team.TEAM_RED ? "team_CTF_blueflag" : "team_CTF_redflag");
          const own = find(f.runtime, ownTeam === Team.TEAM_RED ? "team_CTF_redflag" : "team_CTF_blueflag");
          expect(f.runtime.team.pickupTeam(enemy, player)).toBe(-1);
          expect(client.ps.powerups.get(ownTeam === Team.TEAM_RED ? Powerup.PW_BLUEFLAG : Powerup.PW_REDFLAG)).toBeGreaterThan(0);
          expect(f.runtime.team.pickupTeam(own, player)).toBe(0); expect(f.runtime.level.teamScores.get(ownTeam)).toBe(1);
        }
        f.runtime.shutdown(false);
      }
    }
  }, 30000);
});
