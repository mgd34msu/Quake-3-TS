import { finishCalls, runCalls } from "../src/core/call-steps.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { BinaryError } from "../src/core/binary.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { vec3 } from "../src/core/math.ts";
import { infoParse } from "../src/core/text.ts";
import { GameRuntime } from "../src/game/runtime.ts";
import { ServerWorld } from "../src/server/world.ts";
import { GameFlags } from "../src/game/state.ts";
import { ClientMessageReader, ClientOpcode, commandHash, encodeClientMessage } from "../src/protocol/client-message.ts";
import type { ClientHeader, ClientMovement } from "../src/protocol/client-message.ts";
import { MessageWriter, writeDeltaUserCommand } from "../src/protocol/message.ts";
import type { WireUserCommand } from "../src/protocol/message.ts";
import { Netchannel } from "../src/protocol/netchan.ts";
import type { ReliableCommand } from "../src/protocol/reliable.ts";
import { ServerClientCommandRuntime } from "../src/server/client-commands.ts";
import type { ServerClientCommandHost } from "../src/server/client-commands.ts";
import { addServerCommand } from "../src/server/configstrings.ts";
import { ServerClient, ServerClientPhase, ServerStaticState, ServerWorldState } from "../src/server/state.ts";
import { Weapon } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";

// Exact selected sv_client.c functions at dbe4ddb, native i386 GCC -O2 -DNDEBUG,
// both products: /tmp/quake3-server-client-commands-oracle-Pt6Mtk/run.sh.
// Independent read/game-service tape verifies ordering; tests below use real codecs and GameRuntime.
// Source traces: prefix reads2; stale-ack reads3/no opcode; primed BEGIN1000,THINK1050,THINK1100;
// backdated THINK1050 only; disconnect reliable1; badCP BEGIN then DROP; flood COMMANDgod,VDR.
function map(): BspMap {
  const bounds = { min: vec3(-4096, -4096, -512), max: vec3(4096, 4096, 1024) };
  const planes = [{ normal: vec3(1, 0, 0), distance: 4096 }, { normal: vec3(-1, 0, 0), distance: 4096 },
    { normal: vec3(0, 1, 0), distance: 4096 }, { normal: vec3(0, -1, 0), distance: 4096 },
    { normal: vec3(0, 0, 1), distance: 0 }, { normal: vec3(0, 0, -1), distance: 512 }];
  return { entities: '{ "classname" "worldspawn" } { "classname" "info_player_deathmatch" "origin" "100 0 24" }', entityRecords: [],
    shaders: [{ name: "floor", surfaceFlags: 0, contentFlags: 1 }], planes, nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    leafSurfaces: [], leafBrushes: [0], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_, plane) => ({ plane, shader: 0 })),
    vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}
function wire(serverTime: number, changes: Partial<WireUserCommand> = {}): WireUserCommand {
  return { serverTime, angles: [0, 0, 0], buttons: 0, forwardmove: 0, rightmove: 0, upmove: 0, weapon: Weapon.WP_MACHINEGUN, ...changes };
}
function fixture(product: Product = "baseq3") {
  const statics = new ServerStaticState({ product, maxClients: 2, dedicated: false });
  const prints: string[] = [], debug: string[] = [], effects: string[] = [], commands: string[] = [], trace: string[] = [];
  const settings = { debugBuild: false, pure: false, clientRunning: false, floodProtect: false };
  const commandBuffer = new CommandBuffer();
  function client(slot = 0): ServerClient {
    const value = statics.clients[slot]; if (value === undefined) throw new Error("Missing canonical fixture client"); return value;
  }
  const host: ServerClientCommandHost = {
    get debugBuild() { return settings.debugBuild; }, get pure() { return settings.pure; },
    get clientRunning() { return settings.clientRunning; }, get floodProtect() { return settings.floodProtect; },
    print: text => { prints.push(text); }, debugPrint: text => { debug.push(text); },
    tokenize: text => commandBuffer.tokenize(text),
    *dropClient(value, reason): CallSteps {
      effects.push(`drop:${reason}`);
      if (value.connection.kind !== "initialized") throw new Error("Fixture drop without connection");
      value.connection.phase = ServerClientPhase.Zombie;
      game.clientDisconnect(value.slot);
    },
    sendClientGameState: () => { throw new Error("Gamestate service not configured for this test"); },
    userinfoChanged: value => { trace.push(`userinfo:${value.userinfo}`); value.name = infoParse(value.userinfo).get("name") ?? ""; },
    verifyPaks: () => { throw new Error("Pure verification not configured for this test"); },
    beginDownload: () => { throw new Error("Download begin not configured for this test"); },
    nextDownload: () => { throw new Error("Download next not configured for this test"); },
    stopDownload: () => { throw new Error("Download stop not configured for this test"); },
    doneDownload: () => { throw new Error("Download done not configured for this test"); },
  };
  const world = new ServerWorldState(statics, host), cvars = new CvarRegistry(), bsp = map();
  for (const [name, value] of [["sv_maxclients", "2"], ["g_log", ""], ["bot_enable", "0"], ["sv_cheats", "1"], ["g_doWarmup", "0"]] satisfies readonly (readonly [string, string])[]) cvars.set(name, value, true);
  for (const value of statics.clients) {
    value.userinfo = `\\name\\Client${value.slot}\\ip\\localhost\\handicap\\100\\model\\sarge/default`;
    value.name = `Client${value.slot}`;
    value.connection = { kind: "initialized", phase: ServerClientPhase.Connected, address: { kind: "loopback" }, netchan: new Netchannel("server", 700 + value.slot) };
  }
  world.state = "loading"; statics.time = 1000;
  const collision = new CollisionWorld(bsp, { kind: "unaccounted" }, { kind: "disabled" });
  const spatial = new ServerWorld(collision, collision.modelBounds(0), number => world.game?.data.entity(number), {
    get loading() { return world.state === "loading"; },
    print: text => { prints.push(text); },
    developerPrint: text => { if (cvars.get("developer")?.integerValue) prints.push(text); },
  });
  const game = GameRuntime.create({ product, map: bsp, collision, world: spatial, levelTime: 1000,
    randomSeed: 17, restart: false, buildDate: "fixture", cvars, configstrings: world.configstrings,
    engine: { milliseconds: () => statics.time, print: text => { prints.push(text); }, sendServerCommand: (slot, text) => {
      if (slot === -1) { for (const value of statics.clients) if (value.phase >= ServerClientPhase.Primed) finishCalls(addServerCommand(value, text, host)); }
      else finishCalls(addServerCommand(client(slot), text, host));
    }, dropClient: (slot, reason) => { finishCalls(host.dropClient(client(slot), reason)); },
    getUserinfo: slot => client(slot).userinfo, setUserinfo: (slot, text) => { client(slot).userinfo = text; },
    getUserCommand: slot => client(slot).lastUsercmd,
    appendConsoleCommand: text => { commands.push(text); }, insertConsoleCommand: text => { commands.unshift(text); },
    executeConsoleNow: text => { commands.push(`now:${text}`); },
    openLog: () => { throw new Error("Fixture logging disabled"); } },
    botFactory: { kind: "unavailable", reason: "Packet fixture excludes bots" } }, world);
  world.state = "game"; world.serverId = 100; world.restartedServerId = 100; world.checksumFeed = 0x12345678;
  const runtime = new ServerClientCommandRuntime(world, statics, host);
  const begin = game.clientBegin.bind(game), think = game.clientThink.bind(game);
  game.clientBegin = slot => { trace.push(`begin:${slot}:${client(slot).lastUsercmd.serverTime}:${client(slot).phase}:${client(slot).deltaMessage}`); begin(slot); };
  game.clientThink = (slot, command) => { trace.push(`think:${slot}:${command.serverTime}`); think(slot, command); };
  function admit(): void { expect(game.clientConnect(0, true, false)).toBeNull(); }
  function prime(): void { admit(); const value = client(); if (value.connection.kind !== "initialized") throw new Error("Missing connection"); value.connection.phase = ServerClientPhase.Primed; }
  function active(): void { prime(); finishCalls(runtime.clientEnterWorld(client(), { ...wire(1000), angles: vec3(0, 0, 0) })); trace.length = 0; }
  function packet(movement: ClientMovement | null, reliable: readonly ReliableCommand[] = [], changes: Partial<ClientHeader> = {}): ClientMessageReader {
    const header = { serverId: world.serverId, messageAcknowledge: 1, reliableAcknowledge: 0, ...changes };
    return new ClientMessageReader(encodeClientMessage({ header, commands: reliable, movement },
      { checksumFeed: world.checksumFeed, serverCommand: sequence => client().reliable.lookupMasked(sequence) }));
  }
  return { statics, world, game, cvars, runtime, host, settings, prints, debug, effects, commands, commandBuffer, trace, client, admit, prime, active, packet };
}

function headerOnly(messageAcknowledge: number, reliableAcknowledge: number | null, serverId = 100,
  body: (writer: MessageWriter) => void = () => {}): ClientMessageReader {
  const writer = new MessageWriter(); writer.writeLong(serverId); writer.writeLong(messageAcknowledge);
  if (reliableAcknowledge !== null) writer.writeLong(reliableAcknowledge);
  body(writer); return new ClientMessageReader(writer.toBytes());
}

describe("ordered source server client packet execution", () => {
  test("suspended GAME begin publishes the actual entity and seed before movement resumes", async () => {
    const f = fixture(); f.prime();
    const begin = f.game.calls.clientBegin.bind(f.game.calls);
    f.game.calls.clientBegin = function* (slot): CallSteps {
      yield async () => {
        expect(f.client().gameEntity).toBe(f.game.pool.at(slot));
        expect(f.client().phase).toBe(ServerClientPhase.Active);
        expect(f.client().lastUsercmd.serverTime).toBe(1000);
        expect(f.trace).toEqual([]);
      };
      yield* begin(slot);
    };
    const completion = runCalls(f.runtime.executeClientMessage(f.client(), f.packet({ kind: "move", commands: [wire(1000), wire(1100)] })));
    expect(completion).toBeInstanceOf(Promise);
    expect(f.trace).toEqual([]);
    await completion;
    expect(f.trace).toEqual(["begin:0:1000:4:-1", "think:0:1100"]);
  });

  test("nested commands retain common tokens while reliable publication waits for GAME completion", async () => {
    const f = fixture(); f.active();
    const execute = f.game.calls.clientCommand.bind(f.game.calls);
    f.game.calls.clientCommand = function* (slot, argv): CallSteps {
      expect(f.commandBuffer.tokenizedArguments).toEqual(["god"]);
      yield async () => {
        expect(f.client().lastClientCommand).toBe(0);
        expect(f.client().lastClientCommandString).toBe("");
        await runCalls(f.runtime.executeClientCommand(f.client(), "vdr nested", true));
      };
      expect(f.commandBuffer.tokenizedArguments).toEqual(["vdr", "nested"]);
      yield* execute(slot, argv);
    };
    const completion = runCalls(f.runtime.executeClientMessage(f.client(), f.packet(null, [{ sequence: 1, text: "god" }])));
    expect(f.client().lastClientCommand).toBe(0);
    await completion;
    expect(f.game.pool.at(0).flags & GameFlags.GODMODE).toBe(GameFlags.GODMODE);
    expect(f.commandBuffer.tokenizedArguments).toEqual(["vdr", "nested"]);
    expect(f.client().lastClientCommand).toBe(1);
    expect(f.client().lastClientCommandString).toBe("god");
  });

  test("suspended GAME failure preserves prior reliable writes and does not publish the failed command", async () => {
    const f = fixture(); f.active();
    const failure = new Error("GAME command failure");
    f.game.calls.clientCommand = function* (): CallSteps { yield async () => { throw failure; }; };
    try {
      await runCalls(f.runtime.executeClientMessage(f.client(), f.packet(null,
        [{ sequence: 1, text: "vdr" }, { sequence: 2, text: "god" }])));
      throw new Error("Failed GAME command returned");
    } catch (error) { expect(error).toBe(failure); }
    expect(f.client().lastClientCommand).toBe(1);
    expect(f.client().lastClientCommandString).toBe("vdr");
  });

  test("a suspended kick preserves sequential later user-command storage", async () => {
    const f = fixture(); f.active();
    const think = f.game.calls.clientThink.bind(f.game.calls);
    f.game.calls.clientThink = function* (slot, command): CallSteps {
      yield async () => { expect(f.client().lastUsercmd.serverTime).toBe(1050); };
      yield* think(slot, command);
      yield* f.host.dropClient(f.client(slot), "during suspended think");
    };
    await runCalls(f.runtime.executeClientMessage(f.client(), f.packet({ kind: "move", commands: [wire(1050), wire(1100), wire(1150)] })));
    expect(f.trace).toEqual(["think:0:1050"]);
    expect(f.client().lastUsercmd.serverTime).toBe(1150);
    expect(f.game.pool.clientAt(0).ps.commandTime).toBe(1050);
  });

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: primed first-command seeding precedes real game begin and backup filtering`, () => {
      const f = fixture(product); f.prime();
      const reader = f.packet({ kind: "move", commands: [wire(1000), wire(1050, { forwardmove: 127 }), wire(1100, { forwardmove: 127 })] });
      finishCalls(f.runtime.executeClientMessage(f.client(), reader));
      expect(f.trace).toEqual(["begin:0:1000:4:-1", "think:0:1050", "think:0:1100"]);
      expect(f.client().phase).toBe(ServerClientPhase.Active); expect(f.client().gameEntity).toBe(f.game.pool.at(0));
      expect(f.client().nextSnapshotTime).toBe(1000); expect(f.client().frames[1]?.messageAcked).toBe(1000);
      expect(f.client().lastUsercmd.serverTime).toBe(1100); expect(f.game.pool.clientAt(0).ps.commandTime).toBe(1100);
      expect(f.game.pool.clientAt(0).ps.origin.x).toBeGreaterThan(100);
      expect(f.game.world.linkState(0)?.linked).toBe(true);
      // Production deliberately leaves the final byte unread, but the strict codec can still validate it.
      reader.validateTerminal();
    });

    test(`${product}: duplicate/backdated movement and no-delta preserve source ordering`, () => {
      const f = fixture(product); f.active();
      const writer = new MessageWriter(); writer.writeLong(100); writer.writeLong(1); writer.writeLong(0);
      writer.writeByte(ClientOpcode.MoveNoDelta); writer.writeByte(4);
      // Explicit full-time wire fields: source writer encodes a negative short delta modulo256.
      for (const time of [950, 1000, 1100, 1050]) { writer.writeBits(0, 1); writer.writeLong(time); writer.writeBits(0, 1); }
      finishCalls(f.runtime.executeClientMessage(f.client(), new ClientMessageReader(writer.toBytes())));
      expect(f.trace).toEqual(["think:0:1050"]); expect(f.client().deltaMessage).toBe(-1);
      finishCalls(f.runtime.executeClientMessage(f.client(), f.packet({ kind: "move", commands: [wire(1050), wire(1100)] })));
      expect(f.trace).toEqual(["think:0:1050", "think:0:1100"]); expect(f.client().deltaMessage).toBe(1);
      expect(f.game.pool.clientAt(0).ps.commandTime).toBe(1100);
    });

    test(`${product}: real game command flood suppression does not suppress engine commands or movement`, () => {
      const f = fixture(product); f.active(); f.settings.floodProtect = true;
      f.client().gotCP = true; f.client().pureAuthentic = true;
      finishCalls(f.runtime.executeClientMessage(f.client(), f.packet({ kind: "move", commands: [wire(1100)] },
        [{ sequence: 1, text: "god" }, { sequence: 2, text: "god" }, { sequence: 3, text: "vdr" }])));
      expect(f.game.pool.at(0).flags & GameFlags.GODMODE).toBe(GameFlags.GODMODE);
      expect(f.debug).toContain("client text ignored for Client0: god\n");
      expect(f.client().gotCP).toBe(false); expect(f.client().pureAuthentic).toBe(false);
      expect(f.client().lastClientCommand).toBe(3); expect(f.client().lastClientCommandString).toBe("vdr");
      expect(f.client().nextReliableTime).toBe(2000); expect(f.trace).toContain("think:0:1100");
    });

    test(`${product}: ignored command diagnostics use the first parsed token`, () => {
      const f = fixture(product);
      for (const [text, name] of [
        ['  say "ignored message"', "say"],
        ['"quoted command" ignored', "quoted command"],
        ["/* prefix */ say ignored // suffix", "say"],
        ["say\0 ignored", "say"],
        ["// only a comment", ""],
        [" \t", ""],
        ["", ""],
      ] satisfies readonly (readonly [string, string])[]) {
        finishCalls(f.runtime.executeClientCommand(f.client(), text, false));
        expect(f.debug.pop()).toBe(`client text ignored for Client0: ${name}\n`);
      }
      expect(f.debug).toEqual([]);
    });

    test(`${product}: userinfo normalization precedes actual game userinfo publication`, () => {
      const f = fixture(product); f.active();
      finishCalls(f.runtime.executeClientMessage(f.client(), f.packet(null, [{ sequence: 1, text: 'userinfo "\\name\\Renamed\\ip\\localhost\\handicap\\100"' }])));
      expect(f.trace[0]).toBe("userinfo:\\name\\Renamed\\ip\\localhost\\handicap\\100");
      expect(f.game.pool.clientAt(0).pers.netname).toBe("Renamed");
      expect(f.world.configstrings.get(544)).toContain("Renamed");
    });
  }

  test("negative message acknowledge returns before reading a missing reliable acknowledge", () => {
    const f = fixture(), reader = headerOnly(-1, null); f.client().reliable.assignAcknowledgement(9);
    const count = reader.readCount; finishCalls(f.runtime.executeClientMessage(f.client(), reader));
    expect(reader.readCount).toBe(count); expect(f.client().messageAcknowledge).toBe(-1);
    expect(f.client().reliable.acknowledge).toBe(9); expect(f.effects).toEqual([]);
    f.settings.debugBuild = true;
    finishCalls(f.runtime.executeClientMessage(f.client(), headerOnly(-2, null)));
    expect(f.effects).toEqual(["drop:DEBUG: illegible client message"]);
  });

  test("stale reliable acknowledgement is visible to debug drop, then clamps to live appended sequence", () => {
    const f = fixture(); f.settings.debugBuild = true;
    for (let i = 0; i < 64; i++) f.client().reliable.add("old");
    let observed = 0;
    f.host.dropClient = function* (value): CallSteps { observed = value.reliable.acknowledge; value.reliable.add("disconnect"); };
    const reader = headerOnly(0, -1); finishCalls(f.runtime.executeClientMessage(f.client(), reader));
    expect(observed).toBe(-1); expect(f.client().reliable.sequence).toBe(65); expect(f.client().reliable.acknowledge).toBe(65);
    expect(f.client().lastClientCommand).toBe(0);
  });

  test("future and negative acknowledgements within the source window use masked ring slots", () => {
    for (const acknowledge of [-64, -1, 999]) {
      const f = fixture(); f.active();
      // The exact negative boundary is relative to commands generated by real game admission.
      const rawAck = acknowledge < 0 ? f.client().reliable.sequence + acknowledge : acknowledge;
      const writer = new MessageWriter(); writer.writeLong(100); writer.writeLong(35); writer.writeLong(rawAck);
      writer.writeByte(ClientOpcode.Move); writer.writeByte(1);
      const key = f.world.checksumFeed ^ 35 ^ commandHash(f.client().reliable.lookupMasked(rawAck));
      writeDeltaUserCommand(writer, wire(0, { weapon: 0 }), wire(1100, { forwardmove: 40 }), key);
      // No EOF byte: source SV_UserMove returns immediately after its commands.
      const reader = new ClientMessageReader(writer.toBytes());
      finishCalls(f.runtime.executeClientMessage(f.client(), reader));
      expect(f.client().reliable.acknowledge).toBe(rawAck); expect(f.client().frames[3]?.messageAcked).toBe(1000);
      expect(f.client().lastUsercmd.serverTime).toBe(1100); expect(f.trace).toEqual(["think:0:1100"]);
    }
  });

  test("old map_restart IDs return without touching an invalid opcode or resending", () => {
    const f = fixture(); f.world.serverId = 120; f.world.restartedServerId = 100;
    const reader = headerOnly(50, 0, 110, writer => { writer.writeByte(99); });
    finishCalls(f.runtime.executeClientMessage(f.client(), reader));
    expect(f.debug).toContain("Client0 : ignoring pre map_restart / outdated client message\n");
    expect(f.prints.some(text => text.includes("bad command byte"))).toBe(false);
  });

  test("dropped gamestate resends only after its message number and before reading absent body", () => {
    const f = fixture(); f.client().gamestateMessageNum = 10;
    f.host.sendClientGameState = value => { f.effects.push(`gamestate:${value.messageAcknowledge}`); };
    finishCalls(f.runtime.executeClientMessage(f.client(), headerOnly(10, 0, 99)));
    finishCalls(f.runtime.executeClientMessage(f.client(), headerOnly(11, 0, 99)));
    expect(f.effects).toEqual(["gamestate:11"]);
  });

  test("active downloads and the case-sensitive nextdl substring exempt stale server IDs", () => {
    const f = fixture(); f.client().download.name = "mod/file.pk3";
    finishCalls(f.runtime.executeClientMessage(f.client(), f.packet(null, [{ sequence: 1, text: "vdr" }], { serverId: 1 })));
    expect(f.client().lastClientCommand).toBe(1);
    f.client().download.name = ""; f.client().lastClientCommandString = "prefix-nextdl-suffix";
    finishCalls(f.runtime.executeClientMessage(f.client(), f.packet(null, [{ sequence: 2, text: "vdr" }], { serverId: 1 })));
    expect(f.client().lastClientCommand).toBe(2);
    f.client().lastClientCommandString = "NEXTDL"; f.client().gamestateMessageNum = 1;
    finishCalls(f.runtime.executeClientMessage(f.client(), headerOnly(1, 0, 1)));
    expect(f.client().lastClientCommand).toBe(2);
  });

  test("disconnect and lost reliable sequences stop before unread malformed payloads", () => {
    for (const sequence of [1, 3]) {
      const f = fixture();
      const reader = headerOnly(1, 0, 100, writer => { writer.writeByte(ClientOpcode.Command); writer.writeLong(sequence);
        writer.writeString("disconnect"); writer.writeByte(ClientOpcode.Move); writer.writeByte(0); });
      finishCalls(f.runtime.executeClientMessage(f.client(), reader));
      expect(f.effects).toEqual([sequence === 1 ? "drop:disconnected" : "drop:Lost reliable commands"]);
      expect(f.client().lastClientCommand).toBe(sequence === 1 ? 1 : 0);
      expect(f.prints).not.toContain("cmdCount < 1\n");
      if (sequence === 3) expect(f.prints).toContain("Client Client0 lost 4 clientCommands\n");
    }
  });

  test("duplicate reliable commands execute once and preserve the flood deadline", () => {
    const f = fixture(); f.client().lastClientCommand = 3; f.client().lastClientCommandString = "old"; f.client().nextReliableTime = 777;
    finishCalls(f.runtime.executeClientMessage(f.client(), f.packet(null, [{ sequence: 2, text: "disconnect" }, { sequence: 3, text: "download bad" }])));
    expect(f.effects).toEqual([]); expect(f.client().nextReliableTime).toBe(777); expect(f.client().lastClientCommandString).toBe("old");
  });

  test("invalid opcode/count produce only their source diagnostics and preserve the read boundary", () => {
    const f = fixture();
    const opcode = headerOnly(1, 0, 100, writer => { writer.writeByte(99); });
    finishCalls(f.runtime.executeClientMessage(f.client(), opcode));
    expect(f.prints).toContain("WARNING: bad command byte for client 0\n");
    for (const count of [0, 33]) {
      const reader = headerOnly(1, 0, 100, writer => { writer.writeByte(ClientOpcode.Move); writer.writeByte(count); });
      finishCalls(f.runtime.executeClientMessage(f.client(), reader));
      expect(f.client().deltaMessage).toBe(1); expect(f.client().frames[1]?.messageAcked).toBe(0);
    }
    expect(f.prints).toContain("cmdCount < 1\n"); expect(f.prints).toContain("cmdCount > MAX_PACKET_USERCMDS\n");
  });

  test("pure no-CP handling records ping first, resends only active clients and never enters primed clients", () => {
    const f = fixture(); f.prime(); f.settings.pure = true;
    f.host.sendClientGameState = value => { f.effects.push(`gamestate:${value.frames[1]?.messageAcked}`); };
    finishCalls(f.runtime.executeClientMessage(f.client(), f.packet({ kind: "move", commands: [wire(1000), wire(1100)] })));
    expect(f.trace).toEqual([]); expect(f.effects).toEqual([]); expect(f.client().phase).toBe(ServerClientPhase.Primed);
    const connection = f.client().connection;
    if (connection.kind !== "initialized") throw new Error("Missing connection");
    connection.phase = ServerClientPhase.Active;
    finishCalls(f.runtime.executeClientMessage(f.client(), f.packet({ kind: "move", commands: [wire(1100)] })));
    expect(f.effects).toEqual(["gamestate:1000"]); expect(f.trace).toEqual([]);
  });

  test("bad CP with a primed client begins the actual game before pure rejection", () => {
    const f = fixture(); f.prime(); f.settings.pure = true; f.client().gotCP = true;
    finishCalls(f.runtime.executeClientMessage(f.client(), f.packet({ kind: "move", commands: [wire(1000), wire(1100)] })));
    expect(f.trace).toEqual(["begin:0:1000:4:-1"]);
    expect(f.effects).toEqual(["drop:Cannot validate pure client!"]);
    expect(f.client().lastUsercmd.serverTime).toBe(1000);
  });

  test("built-in callbacks and live settings changes are observed between reliable commands", () => {
    const f = fixture(); f.active(); f.settings.floodProtect = true;
    f.host.verifyPaks = function* (value, argv): CallSteps { f.effects.push(argv.join(" ")); value.gotCP = true; value.pureAuthentic = true; f.settings.clientRunning = true; };
    f.host.beginDownload = (_value, argv) => { f.effects.push(argv.join(" ")); };
    f.host.nextDownload = function* (_value, argv): CallSteps { f.effects.push(argv.join(" ")); };
    f.host.stopDownload = () => { f.effects.push("stopdl"); };
    f.host.doneDownload = () => { f.effects.push("donedl"); };
    finishCalls(f.runtime.executeClientMessage(f.client(), f.packet(null, ["cp 100 1 2 @ 3", "god", "download mod/file.pk3", "nextdl 4", "stopdl", "donedl"]
      .map((text, index) => ({ sequence: index + 1, text })))));
    expect(f.effects).toEqual(["cp 100 1 2 @ 3", "download mod/file.pk3", "nextdl 4", "stopdl", "donedl"]);
    expect(f.game.pool.at(0).flags & GameFlags.GODMODE).toBe(GameFlags.GODMODE);
    expect(f.client().lastClientCommand).toBe(6);
  });

  test("pure setting is read again after GAME_CLIENT_BEGIN side effects", () => {
    const f = fixture(); f.prime(); const begin = f.game.clientBegin.bind(f.game);
    f.game.clientBegin = slot => { begin(slot); f.settings.pure = true; };
    finishCalls(f.runtime.executeClientMessage(f.client(), f.packet({ kind: "move", commands: [wire(1000), wire(1100)] })));
    expect(f.effects).toEqual(["drop:Cannot validate pure client!"]);
    expect(f.trace).toEqual(["begin:0:1000:4:-1"]);
  });

  test("a kick during movement suppresses later game calls but still stores later accepted commands", () => {
    const f = fixture(); f.active(); const think = f.game.clientThink.bind(f.game);
    f.game.clientThink = (slot, command) => { think(slot, command); finishCalls(f.host.dropClient(f.client(slot), "during think")); };
    finishCalls(f.runtime.executeClientMessage(f.client(), f.packet({ kind: "move", commands: [wire(1050), wire(1100), wire(1150)] })));
    expect(f.trace).toEqual(["think:0:1050"]); expect(f.client().lastUsercmd.serverTime).toBe(1150);
    expect(f.game.pool.clientAt(0).ps.commandTime).toBe(1050);
  });

  test("unrelated clients and uninitialized network slots reject at the public boundary", () => {
    const f = fixture(), foreign = new ServerClient("baseq3", 0);
    expect(() => finishCalls(f.runtime.executeClientMessage(foreign, headerOnly(-1, null)))).toThrow("does not belong");
    f.client().connection = { kind: "uninitialized", phase: ServerClientPhase.Free, address: { kind: "bot" } };
    expect(() => finishCalls(f.runtime.executeClientMessage(f.client(), headerOnly(-1, null)))).toThrow("initialized connection");
  });

  test("truncation retains the strict decoder boundary and does not roll back earlier source writes", () => {
    const f = fixture(); f.client().reliable.assignAcknowledgement(9);
    expect(() => new ClientMessageReader(new Uint8Array())).toThrow(BinaryError);
    expect(() => finishCalls(f.runtime.executeClientMessage(f.client(), headerOnly(7, null)))).toThrow(BinaryError);
    expect(f.client().messageAcknowledge).toBe(7); expect(f.client().reliable.acknowledge).toBe(9);
    f.client().pureAuthentic = true; f.client().gotCP = true;
    const reader = headerOnly(8, 0, 100, writer => {
      writer.writeByte(ClientOpcode.Command); writer.writeLong(1); writer.writeString("vdr");
      writer.writeByte(ClientOpcode.Command);
    });
    expect(() => finishCalls(f.runtime.executeClientMessage(f.client(), reader))).toThrow(BinaryError);
    expect(f.client().lastClientCommand).toBe(1); expect(f.client().lastClientCommandString).toBe("vdr");
    expect(f.client().pureAuthentic).toBe(false); expect(f.client().gotCP).toBe(false);
    expect(f.effects).toEqual([]);
  });
});
