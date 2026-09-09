import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { CommonError } from "../src/core/common-error.ts";
import { finishCalls, runCalls } from "../src/core/call-steps.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import { vec3 } from "../src/core/math.ts";
import { tokenizeCommand } from "../src/core/text.ts";
import { GameRuntime } from "../src/game/runtime.ts";
import { ServerWorld } from "../src/server/world.ts";
import { Netchannel } from "../src/protocol/netchan.ts";
import { decodeServerMessage, encodeServerMessage } from "../src/protocol/server-message.ts";
import type { ServerMessageContext, ServerOperation } from "../src/protocol/server-message.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ServerEntityFlags } from "../src/shared/entity-shared.ts";
import { addServerCommand } from "../src/server/configstrings.ts";
import type { ServerConfigStringHost } from "../src/server/configstrings.ts";
import { ServerClient, ServerClientPhase, ServerStaticState, ServerWorldState } from "../src/server/state.ts";

// Chunk fixtures confirmed against untouched dbe4ddb sv_init.c, native base and MISSIONPACK.
// External oracle: /tmp/quake3-server-records-oracle-Y0g5jH/fixture.c.
function fixture(product: Product = "baseq3", maxClients = 5) {
  const state = new ServerStaticState({ product, maxClients, dedicated: false });
  const prints: string[] = [], drops: string[] = [];
  const host: ServerConfigStringHost = { print: text => { prints.push(text); }, *dropClient(client, reason): CallSteps {
    drops.push(`${client.slot}:${reason}`);
    if (client.connection.kind !== "initialized") throw new Error("Dropped uninitialized fixture client");
    client.connection.phase = ServerClientPhase.Zombie;
  } };
  const world = new ServerWorldState(state, host);
  function client(slot: number): ServerClient {
    const result = state.clients[slot];
    if (result === undefined) throw new Error("Missing fixture client");
    return result;
  }
  function phase(slot: number, value: ServerClientPhase): void {
    client(slot).connection = { kind: "initialized", phase: value, address: { kind: "loopback" }, netchan: new Netchannel("server", 100 + slot) };
  }
  return { state, world, host, prints, drops, client, phase };
}

describe("SV_SetConfigstring source broadcasts", () => {
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: loading, restart and phase filtering use live records`, () => {
      const f = fixture(product);
      f.phase(1, ServerClientPhase.Zombie); f.phase(2, ServerClientPhase.Connected);
      f.phase(3, ServerClientPhase.Primed); f.phase(4, ServerClientPhase.Active);
      f.world.configstrings.set(5, "dead"); f.world.state = "loading"; f.world.configstrings.set(5, "loading");
      expect(f.client(3).reliable.sequence).toBe(0);
      f.world.restarting = true; f.world.configstrings.set(5, "restart");
      f.world.restarting = false; f.world.state = "game"; f.world.configstrings.set(5, "game");
      f.world.configstrings.set(5, "game");
      for (const slot of [0, 1, 2]) expect(f.client(slot).reliable.sequence).toBe(0);
      for (const slot of [3, 4]) expect(f.client(slot).reliable.pending().map(command => command.text))
        .toEqual(['cs 5 "restart"\n', 'cs 5 "game"\n']);
      f.phase(4, ServerClientPhase.Connected); f.world.configstrings.set(5, null);
      expect(f.client(3).reliable.lookup(3)).toBe('cs 5 ""\n');
      expect(f.client(4).reliable.sequence).toBe(2);
    });

    for (const length of [999, 1000, 1998, 1999]) {
      test(`${product}: source chunk boundary ${length} reconstructs through protocol68`, () => {
        const f = fixture(product, 1); f.phase(0, ServerClientPhase.Active); f.world.state = "game";
        const value = "x".repeat(length); f.world.configstrings.set(1023, value);
        const pending = f.client(0).reliable.pending();
        const expected = length === 999 ? [['cs', 999]] : length === 1000 ? [['bcs0', 999], ['bcs2', 1]]
          : length === 1998 ? [['bcs0', 999], ['bcs2', 999]] : [['bcs0', 999], ['bcs1', 999], ['bcs2', 1]];
        expect(pending.map(command => { const args = tokenizeCommand(command.text); return [args[0], args[2]?.length]; })).toEqual(expected);
        const context: ServerMessageContext = { product, messageNumber: 1, reliableSequence: 0, serverCommandSequence: 0,
          parseEntitiesNumber: 0, baseline: () => null, history: () => null };
        const operations: ServerOperation[] = pending.map(command => ({ kind: "command", ...command }));
        const bytes = encodeServerMessage(0, operations, context);
        const decoded = decodeServerMessage(bytes, context);
        let reconstructed = "";
        for (const operation of decoded.operations) {
          if (operation.kind !== "command") throw new Error("Unexpected server operation");
          const args = tokenizeCommand(operation.text);
          const part = args[2];
          if (part === undefined) throw new Error("Missing configstring payload");
          expect(args[1]).toBe("1023"); reconstructed += part;
        }
        expect(reconstructed).toBe(value); expect(f.world.configstrings.get(1023)).toBe(value);
      });
    }
  }

  test("C strings, byte characters, bounded trap reads and validation order", () => {
    const f = fixture(); f.phase(3, ServerClientPhase.Primed); f.world.state = "game";
    f.world.configstrings.set(1023, "a\xffb\0ignored");
    expect(f.world.configstrings.get(1023)).toBe("a\xffb");
    expect(f.world.configstrings.getBuffer(1023, 1)).toBe("");
    expect(f.world.configstrings.getBuffer(1023, 3)).toBe("a\xff");
    f.world.configstrings.set(1023, "a\xffb\0different"); expect(f.client(3).reliable.sequence).toBe(1);
    expect(() => f.world.configstrings.getBuffer(-1, 0)).toThrow("bufferSize");
    expect(() => f.world.configstrings.set(-1, "\u0100")).toThrow("bad index");
    for (const index of [-1, 1024, 0.5, NaN]) {
      expect(() => f.world.configstrings.get(index)).toThrow(new CommonError("drop", `SV_GetConfigstring: bad index ${index}\n`));
      expect(() => f.world.configstrings.set(index, "a")).toThrow(new CommonError("drop", `SV_SetConfigstring: bad index ${index}\n`));
    }
    let failure: unknown;
    try { f.world.configstrings.getBuffer(-1, 0); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "drop", message: "SV_GetConfigstring: bufferSize == 0" });
    expect(() => f.world.configstrings.set(7, "\u0100")).toThrow("byte characters");
    expect(f.world.configstrings.get(7)).toBe("");
  });

  test("source does not escape embedded quotes or coalesce pending updates", () => {
    const f = fixture(); f.world.state = "game"; f.phase(3, ServerClientPhase.Primed);
    f.world.configstrings.set(7, 'a"b'); f.world.configstrings.set(7, "second");
    expect(f.client(3).reliable.pending().map(command => command.text)).toEqual(['cs 7 "a"b"\n', 'cs 7 "second"\n']);
  });

  test("overflow diagnostics read masked slots for source-accepted negative acknowledgements", () => {
    const f = fixture("baseq3", 1); f.phase(0, ServerClientPhase.Active);
    f.client(0).reliable.assignAcknowledgement(-64);
    finishCalls(addServerCommand(f.client(0), "new", f.host));
    expect(f.drops).toEqual(["0:Server command overflow"]);
    expect(f.prints[1]).toBe("cmd   -63: \n");
    expect(f.prints[66]).toBe("cmd     2: new\n");
  });

  test("overflow stores first, reports overwritten slot, drops once, then continues the source chunk loop", () => {
    const f = fixture("baseq3", 2); f.world.state = "game";
    f.phase(0, ServerClientPhase.Active); f.phase(1, ServerClientPhase.Active);
    for (let index = 1; index <= 64; index++) f.client(0).reliable.add(`old${index}`);
    const order: string[] = [];
    f.host.dropClient = function* (client, reason): CallSteps {
      order.push(`${client.slot}:${reason}:${f.world.configstrings.get(7).length}:${f.client(1).reliable.sequence}`);
      if (client.connection.kind !== "initialized") throw new Error("Missing connection");
      client.connection.phase = ServerClientPhase.Zombie;
      yield* addServerCommand(client, 'disconnect "overflow"', f.host);
    };
    f.world.configstrings.set(7, "x".repeat(1999));
    expect(order).toEqual(["0:Server command overflow:1999:0"]);
    expect(f.prints).toHaveLength(67);
    expect(f.prints[0]).toBe("===== pending server commands =====\n");
    expect(f.prints[65]).toBe("cmd    65: old1\n");
    expect(f.prints[66]).toBe(`cmd    66: bcs0 7 "${"x".repeat(999)}"\n\n`);
    expect(f.client(0).reliable.sequence).toBe(68);
    expect(f.client(0).reliable.lookup(66)).toBe('disconnect "overflow"');
    expect(f.client(0).reliable.lookup(67)).toBe(`bcs1 7 "${"x".repeat(999)}"\n`);
    expect(f.client(0).reliable.lookup(68)).toBe('bcs2 7 "x"\n');
    expect(f.client(1).reliable.sequence).toBe(3);
  });

  test("a drop side effect changing the next client's phase is observed by ordered broadcast", () => {
    const f = fixture("baseq3", 2); f.world.state = "game";
    f.phase(0, ServerClientPhase.Active); f.phase(1, ServerClientPhase.Active);
    for (let index = 0; index < 64; index++) f.client(0).reliable.add("old");
    f.host.dropClient = function* (): CallSteps { f.phase(1, ServerClientPhase.Connected); };
    f.world.configstrings.set(7, "next");
    expect(f.client(1).reliable.sequence).toBe(0);
  });

  test("suspended overflow publishes storage before waiting and resumes chunks before later clients", async () => {
    const f = fixture("baseq3", 2); f.world.state = "game";
    f.phase(0, ServerClientPhase.Active); f.phase(1, ServerClientPhase.Active);
    for (let index = 0; index < 64; index++) f.client(0).reliable.add("old");
    const pause = Promise.withResolvers<undefined>();
    f.host.dropClient = function* (client): CallSteps {
      yield () => pause.promise;
      f.phase(0, ServerClientPhase.Zombie);
      f.phase(1, ServerClientPhase.Connected);
      yield* addServerCommand(client, 'disconnect "overflow"', f.host);
      yield* f.world.configstrings.setCalls(7, "reentrant");
    };
    const completion = runCalls(f.world.configstrings.setCalls(7, "x".repeat(1999)));
    expect(f.world.configstrings.get(7)).toBe("x".repeat(1999));
    expect(f.client(0).phase).toBe(ServerClientPhase.Active);
    expect(f.client(0).reliable.sequence).toBe(65);
    expect(f.client(1).reliable.sequence).toBe(0);
    pause.resolve(undefined);
    await completion;
    expect(f.world.configstrings.get(7)).toBe("reentrant");
    expect(f.client(0).reliable.sequence).toBe(68);
    expect(f.client(0).reliable.lookup(67)).toBe(`bcs1 7 "${"x".repeat(999)}"\n`);
    expect(f.client(0).reliable.lookup(68)).toBe('bcs2 7 "x"\n');
    expect(f.client(1).reliable.sequence).toBe(0);
  });

  test("direct configstring owner rejects suspension without starting its asynchronous work", () => {
    const f = fixture("baseq3", 1); f.world.state = "game"; f.phase(0, ServerClientPhase.Active);
    for (let index = 0; index < 64; index++) f.client(0).reliable.add("old");
    let started = false;
    f.host.dropClient = function* (): CallSteps { yield async () => { started = true; }; };
    expect(() => f.world.configstrings.set(7, "published")).toThrow("Cannot synchronously finish an asynchronous call");
    expect(started).toBe(false);
    expect(f.world.configstrings.get(7)).toBe("published");
    expect(f.client(0).reliable.sequence).toBe(65);
  });
});

function emptyMap(): BspMap {
  const bounds = { min: vec3(-4096, -4096, -4096), max: vec3(4096, 4096, 4096) };
  return { entities: '{ "classname" "worldspawn" } { "classname" "info_player_deathmatch" }', entityRecords: [],
    shaders: [], planes: [], nodes: [], leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}

test("NOSERVERINFO resolves the current actual GameRuntime entity without duplicated game records", () => {
  const f = fixture("baseq3", 2), map = emptyMap(), cvars = new CvarRegistry();
  cvars.set("sv_maxclients", "2", true); cvars.set("g_log", "", true); cvars.set("bot_enable", "0", true);
  const commandLog: string[] = [];
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const spatial = new ServerWorld(collision, collision.modelBounds(0), number => f.world.game?.data.entity(number), { get loading() { return f.world.state === "loading"; }, print: text => { f.host.print(text); }, developerPrint: text => { const developer = cvars.get("developer"); if (developer !== undefined && developer.integerValue !== 0) f.host.print(text); } });
  const game = GameRuntime.create({ product: "baseq3", map, collision, world: spatial, levelTime: 0, randomSeed: 1,
    restart: false, buildDate: "fixture", cvars, configstrings: f.world.configstrings,
    engine: { milliseconds: () => f.state.time, print: text => { f.prints.push(text); }, sendServerCommand: (slot, text) => { commandLog.push(`${slot}:${text}`); },
      dropClient: (slot, reason) => { finishCalls(f.host.dropClient(f.client(slot), reason)); },
      getUserinfo: slot => f.client(slot).userinfo, setUserinfo: (slot, text) => { f.client(slot).userinfo = text; },
      getUserCommand: slot => f.client(slot).lastUsercmd,
      appendConsoleCommand: text => { commandLog.push(text); }, insertConsoleCommand: text => { commandLog.push(`insert:${text}`); },
      executeConsoleNow: text => { commandLog.push(`now:${text}`); },
      openLog: () => { throw new Error("Logging disabled in fixture"); } },
    botFactory: { kind: "unavailable", reason: "Not part of configstring fixture" },
    }, f.world);
  try {
    f.world.state = "game";
    f.phase(0, ServerClientPhase.Primed); f.phase(1, ServerClientPhase.Active);
    f.client(0).gameEntity = game.pool.at(0);
    game.pool.at(0).r.svFlags |= ServerEntityFlags.NOSERVERINFO;
    expect(f.world.gameEntity(f.client(0))).toBe(game.pool.at(0));
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const foreign = fixture(product, 1).client(0);
      foreign.gameEntity = game.pool.at(0);
      expect(() => f.world.gameEntity(foreign)).toThrow("does not belong to this server");
    }
    f.world.configstrings.set(0, "serverinfo"); f.world.configstrings.set(1, "systeminfo");
    expect(f.client(0).reliable.pending().map(command => command.text)).toEqual(['cs 1 "systeminfo"\n']);
    expect(f.client(1).reliable.pending().map(command => command.text)).toEqual(['cs 0 "serverinfo"\n', 'cs 1 "systeminfo"\n']);
    game.pool.at(0).r.svFlags &= ~ServerEntityFlags.NOSERVERINFO;
    f.world.configstrings.set(0, "new");
    expect(f.client(0).reliable.lookup(2)).toBe('cs 0 "new"\n');
  } finally { game.shutdown(false); }
});
