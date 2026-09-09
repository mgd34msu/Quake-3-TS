import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import { float32ToBits } from "../src/core/numeric.ts";
import { clientInactivityTimer, clientIntermissionThink, spectatorClientEndFrame, spectatorThink } from "../src/game/client-policy.ts";
import type { ClientPolicyContext } from "../src/game/client-policy.ts";
import { ClientThinkRuntime } from "../src/game/client-think.ts";
import type { ClientThinkHost } from "../src/game/client-think.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { EntityPool, initGameEntity } from "../src/game/entities.ts";
import { GameSessionManager } from "../src/game/session.ts";
import { ConnectionState, GameClient, SpectatorState } from "../src/game/state.ts";
import { ServerWorld } from "../src/server/world.ts";
import type { ServerTraceQuery } from "../src/server/world.ts";
import { EntityType, GameType, MoveType, PersistentIndex, Team, Weapon } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { MovementDiagnostics } from "../src/shared/movement.ts";
import { CommandButtons, ENTITYNUM_NONE, MoveFlags, PlayerStateSlots } from "../src/shared/player-state.ts";
import type { UserCommand } from "../src/shared/player-state.ts";

const products: readonly Product[] = ["baseq3", "missionpack"];

for (const product of products) test.skipIf(Bun.env["Q3_SPECTATOR_ORACLE"] === undefined)(`${product} live original spectator QVM capture retains exact movement and callback order`, () => {
  const script = Bun.env["Q3_SPECTATOR_ORACLE"]; if (script === undefined) throw new Error("Q3_SPECTATOR_ORACLE required");
  const result = Bun.spawnSync(["bash", script, product]); expect(result.exitCode).toBe(0);
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  expect(output).toContain("0 total errors");
  expect(output.split(/\r?\n/).filter(line => line.startsWith("SPEC "))).toEqual([
    "SPEC unlink 1067702028 1067702028 1",
    "SPEC move 1067702028 1115684865 20 2 400 65537",
    "SPEC unlink 1075553765 1075553765 0",
    "SPEC follow 1075553765 1075553765 0",
    "SPEC buttons 0 3 3",
    "SPEC touch 1067702028 1067702028 1",
    "SPEC unlink 1067702028 1128792064 1",
    "SPEC follow 1067702028 1128792064 0",
    "SPEC returned 1067702028 1128792064 0",
    "SPEC DONE",
  ]);
});

function mapFixture(wallContents: number | null): BspMap {
  const bounds = { min: vec3(-1024, -1024, -1024), max: vec3(1024, 1024, 1024) };
  const planes = wallContents === null ? [] : [
    { normal: vec3(1, 0, 0), distance: 51 }, { normal: vec3(-1, 0, 0), distance: -49 },
    { normal: vec3(0, 1, 0), distance: 100 }, { normal: vec3(0, -1, 0), distance: 100 },
    { normal: vec3(0, 0, 1), distance: 100 }, { normal: vec3(0, 0, -1), distance: 100 },
  ];
  const brushCount = wallContents === null ? 0 : 1;
  return {
    entities: "", entityRecords: [], shaders: wallContents === null ? [] : [{ name: "wall", surfaceFlags: 0, contentFlags: wallContents }],
    planes, nodes: [], leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount }],
    leafSurfaces: [], leafBrushes: wallContents === null ? [] : [0],
    models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount }],
    brushes: wallContents === null ? [] : [{ firstSide: 0, sideCount: 6, shader: 0 }],
    brushSides: planes.map((_plane, plane) => ({ plane, shader: 0 })),
    vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null,
  };
}

class ObservedWorld extends ServerWorld {
  readonly masks: number[] = [];
  override trace(query: ServerTraceQuery) {
    this.masks.push(query.mask);
    return super.trace(query);
  }
}

function command(serverTime: number, buttons = 0, forwardmove = 0): UserCommand {
  return { serverTime, buttons, forwardmove, rightmove: 0, upmove: 0, angles: vec3(0, 0, 0), weapon: Weapon.WP_NONE };
}

function setup(product: Product = "baseq3", wallContents: number | null = null) {
  const frame = { time: 1000, inactivitySeconds: 30, follow1: 1, follow2: -1 };
  const calls: string[] = [];
  const movementDiagnostics = new MovementDiagnostics(text => { calls.push(text); });
  const commands: { readonly number: number; readonly text: string }[] = [];
  const pool = new EntityPool({ product, maxClients: 2, mapStartTime: 0, time: () => frame.time,
    print: text => { calls.push(text); },
    link: entity => { world.link(entity); }, unlink: entity => { world.unlink(entity.slot); } });
  const collision = new CollisionWorld(mapFixture(wallContents), { kind: "unaccounted" }, { kind: "disabled" });
  const worldPrints: string[] = [];
  const world = new ObservedWorld(collision, collision.modelBounds(0), number => pool.get(number), {
    loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); },
  });
  const entity = pool.at(0), client = pool.clientAt(0), target = pool.clientAt(1);
  initGameEntity(entity);
  client.ps.health = 100;
  client.pers.connected = ConnectionState.CONNECTED;
  client.sess.sessionTeam = Team.TEAM_SPECTATOR;
  client.sess.spectatorState = SpectatorState.FREE;
  entity.r.mins = vec3(-15, -15, -24);
  entity.r.maxs = vec3(15, 15, 32);
  entity.r.contents = 0x2000000;
  entity.r.ownerNum = ENTITYNUM_NONE;
  world.link(entity);
  const context: ClientPolicyContext = {
    movementDiagnostics,
    pool, world, get time() { return frame.time; }, get inactivitySeconds() { return frame.inactivitySeconds; },
    get follow1() { return frame.follow1; }, get follow2() { return frame.follow2; },
    touchTriggers: self => { calls.push(`touch:${world.linkState(self.s.number)?.linked}`); runtime.touchTriggers(self); },
    followCycle: (self, direction) => { calls.push(`follow:${direction}:${world.linkState(self.s.number)?.linked}`); },
    clientBegin: number => { calls.push(`begin:${number}`); },
    dropClient: (number, reason) => { calls.push(`drop:${number}:${reason}`); },
    sendServerCommand: (number, text) => { commands.push({ number, text }); },
  };
  const unexpected = (): never => { throw new Error("Unexpected game service"); };
  const combatFields = { entities: pool, world, intermissionQueued: 0, gameType: GameType.GT_FFA,
    friendlyFire: false, knockback: 1000, debugDamage: null, checkHurtCarrier: unexpected, logAccuracyHit: unexpected };
  const combat: CombatContext = product === "baseq3" ? { ...combatFields, product, get time() { return frame.time; } }
    : { ...combatFields, product, get time() { return frame.time; }, checkObeliskAttack: unexpected, invulnerabilityEffect: unexpected };
  const host: ClientThinkHost = {
    pool, world, effects: { combat }, movementDiagnostics,
    frame: () => ({ time: frame.time, intermissionTime: 0, intermissionQueued: 0 }),
    settings: () => ({ synchronousClients: false, pmoveFixed: false, pmoveMsec: 8, gravity: 800, speed: 320, debugMove: 0,
      dmflags: 0, smoothClients: false, forceRespawnSeconds: 0, singlePlayer: false }),
    setPmoveMsec: unexpected, intermissionThink: clientIntermissionThink,
    spectatorThink: (self, cmd) => spectatorThink(context, self, cmd), checkInactivity: candidate => clientInactivityTimer(context, candidate),
    freeHook: unexpected, checkGauntletAttack: unexpected, clientEvents: unexpected,
    botTestAas: unexpected,
    respawn: unexpected, appendConsoleCommand: unexpected, isDoorTrigger: candidate => candidate.classname === "door_trigger",
  };
  const runtime = new ClientThinkRuntime(host);
  return { context, entity, client, target, pool, world, frame, calls, commands, runtime };
}

describe("spectator QVM movement and actual server collision", () => {
  for (const product of products) test(`${product} restored raw spectator state reaches free movement and end-frame policy`, () => {
    const { context, entity, client, pool, world, frame, calls, runtime } = setup(product);
    const values = new Map<string, string>([["session0", "3 0 99 -1 0 0 0 "]]);
    const sessions = new GameSessionManager({
      clients: pool.clients, maxClients: 2, teamScores: new PlayerStateSlots(Team.TEAM_NUM_TEAMS),
      gameType: GameType.GT_FFA, teamAutoJoin: false, maxGameClients: 0,
      time: 0, numNonSpectatorClients: 0, newSession: false,
    }, {
      cvars: {
        get(name): string { return values.get(name) ?? ""; },
        set(name, value): void { values.set(name, value); },
      },
      print(): void { throw new Error("Session restore must not print"); },
      broadcastTeamChange(): void { throw new Error("Session restore must not broadcast"); },
    });
    sessions.readClient(0);
    sessions.writeClient(0);
    expect(values.get("session0")).toBe("3 0 99 -1 0 0 0");
    client.sess.spectatorState = SpectatorState.FOLLOW;
    sessions.readClient(0);
    expect<number>(client.sess.spectatorState).toBe(99);

    frame.time = 20;
    runtime.clientThink(0, command(20, 0, 127));
    expect([float32ToBits(client.ps.origin.x), float32ToBits(client.ps.velocity.x)]).toEqual([1067702028, 1115684865]);
    expect([client.ps.commandTime, client.ps.pmType, client.ps.speed]).toEqual([20, MoveType.PM_SPECTATOR, 400]);
    expect(world.linkState(0)?.linked).toBe(false);
    expect(calls).toEqual(["touch:true"]);
    client.ps.pmFlags |= MoveFlags.SCOREBOARD;
    spectatorClientEndFrame(context, entity);
    expect(client.ps.pmFlags & (MoveFlags.SCOREBOARD | MoveFlags.FOLLOW)).toBe(0);
    expect<number>(client.sess.spectatorState).toBe(99);
    expect(calls).toEqual(["touch:true"]);
  });

  // Unchanged g_active/bg_pmove/bg_slidemove/bg_misc/q_math/q_shared/bg_lib,
  // commit dbe4ddb10315479fc00086f08e25d968b4b43c49, original q3lcc + vm_game=1.
  // Reproduce: bash /tmp/quake3-spectator-qvm-profile-QNFpKE/run.sh baseq3|missionpack.
  // GCC -O0 instead gives origin 1.2799999713897705 and velocity 64 in
  // /tmp/quake3-client-policy-reference-2ZjhyB/{base,missionpack}-reference.
  // Shipped qagame PmoveSingle uses float32 .001 (981668463), not GCC's double literal.
  for (const product of products) test(`${product} QVM 20ms movement bits and original command buttons`, () => {
    const { context, entity, client, world, calls } = setup(product);
    spectatorThink(context, entity, command(20, 0, 127));
    expect(context.movementDiagnostics.count).toBe(1);
    expect([float32ToBits(client.ps.origin.x), float32ToBits(client.ps.velocity.x)]).toEqual([1067702028, 1115684865]);
    expect([client.ps.commandTime, client.ps.pmType, client.ps.speed]).toEqual([20, 2, 400]);
    expect(world.masks.length).toBeGreaterThan(0);
    expect(world.masks.every(mask => mask === 65537)).toBe(true);
    expect(world.linkState(0)?.linked).toBe(false);
    expect(entity.s.origin).toEqual(client.ps.origin);
    expect(entity.s.origin).not.toBe(client.ps.origin);
    expect(entity.r.currentOrigin).toEqual(vec3(0, 0, 0));
    const cmd = command(40, CommandButtons.ATTACK | CommandButtons.TALK, 127);
    spectatorThink(context, entity, cmd);
    expect(context.movementDiagnostics.count).toBe(2);
    expect([client.oldButtons, client.buttons, cmd.buttons]).toEqual([0, 3, 3]);
    expect(calls).toEqual(["touch:true", "touch:false", "follow:1:false"]);
  });

  test("spectators pass through body hulls but collide with source solid/playerclip brushes", () => {
    for (const contents of [null, 1, 0x10000]) {
      const { context, entity, client, world, pool } = setup("baseq3", contents);
      const body = pool.at(1);
      initGameEntity(body);
      body.r.currentOrigin = vec3(25, 0, 0);
      body.r.mins = vec3(-10, -10, -10);
      body.r.maxs = vec3(10, 10, 10);
      body.r.contents = 0x2000000;
      body.r.ownerNum = ENTITYNUM_NONE;
      world.link(body);
      spectatorThink(context, entity, command(1000, 0, 127));
      if (contents === null) expect(client.ps.origin.x).toBeGreaterThan(300);
      else expect(client.ps.origin.x).toBeCloseTo(33.875, 4);
      expect(world.linkState(0)?.linked).toBe(false);
      expect(world.linkState(1)?.linked).toBe(true);
    }
  });

  for (const product of products) test(`${product} real trigger observes QVM copied origin before unlink and cycling`, () => {
    const { context, entity, client, world, pool, calls } = setup(product);
    const trigger = pool.spawn();
    trigger.s.eType = EntityType.ET_TELEPORT_TRIGGER;
    trigger.r.mins = vec3(-8, -8, -8);
    trigger.r.maxs = vec3(8, 8, 8);
    trigger.r.contents = 0x40000000;
    trigger.touch = (_self, other) => {
      expect(float32ToBits(other.s.origin.x)).toBe(1067702028);
      expect(float32ToBits(client.ps.origin.x)).toBe(1067702028);
      expect(world.linkState(other.s.number)?.linked).toBe(true);
      calls.push("teleport");
      client.ps.origin = vec3(200, 0, 0);
    };
    world.link(trigger);
    spectatorThink(context, entity, command(20, CommandButtons.ATTACK, 127));
    expect(calls).toEqual(["touch:true", "teleport", "follow:1:false"]);
    expect(client.ps.origin.x).toBe(200);
    expect(float32ToBits(entity.s.origin.x)).toBe(1067702028);
  });

  test("follow mode only advances button edges, and the runtime excludes scoreboard movement", () => {
    const { context, entity, client, world, calls, runtime, frame } = setup();
    client.sess.spectatorState = SpectatorState.FOLLOW;
    for (const buttons of [CommandButtons.ATTACK, CommandButtons.ATTACK, 0, CommandButtons.ATTACK]) {
      spectatorThink(context, entity, command(20, buttons, 127));
    }
    expect(calls).toEqual(["follow:1:true", "follow:1:true"]);
    expect(client.ps.commandTime).toBe(0);
    expect(client.ps.pmType).toBe(MoveType.PM_NORMAL);
    expect(world.linkState(0)?.linked).toBe(true);
    client.sess.spectatorState = SpectatorState.SCOREBOARD;
    frame.time = 100;
    runtime.clientThink(0, command(100, 0, 127));
    expect(client.ps.commandTime).toBe(0);
    expect(calls).toHaveLength(2);
  });
});

describe("spectator follow publication and owned state", () => {
  for (const product of products) test(`${product} native follow copies all slots and retains only spectator vote flags`, () => {
    const { context, entity, client, target } = setup(product);
    client.sess.spectatorState = SpectatorState.FOLLOW;
    client.sess.spectatorClient = -1;
    client.ps.eFlags = 0x80000 | 0x1000;
    client.ps.persistant.set(PersistentIndex.PERS_SCORE, 5);
    target.pers.connected = ConnectionState.CONNECTED;
    target.sess.sessionTeam = Team.TEAM_RED;
    target.ps.clientNum = 1;
    target.ps.eFlags = 0x4000 | 0x100 | 4;
    target.ps.pmFlags = MoveFlags.DUCKED;
    target.ps.persistant.set(PersistentIndex.PERS_SCORE, 99);
    target.ps.origin = vec3(1, 2, 3);
    target.ps.ping = 300;
    target.ps.eventSequence = 10;
    const stores = [target.ps.stats, target.ps.ammo, target.ps.powerups, target.ps.events, target.ps.eventParms];
    for (const [group, store] of stores.entries()) for (let index = 0; index < store.length; index++) store.set(index, group * 100 + index);
    spectatorClientEndFrame(context, entity);
    expect([client.ps.clientNum, client.ps.eFlags, client.ps.pmFlags, client.ps.persistant.get(PersistentIndex.PERS_SCORE), target.ps.pmFlags])
      .toEqual([1, 524548, 4097, 99, 1]);
    const expected = target.ps.copy();
    expected.eFlags = 524548;
    expected.pmFlags |= MoveFlags.FOLLOW;
    expect(client.ps).toEqual(expected);
    expect(client.ps).not.toBe(target.ps);
    expect(client.ps.origin).not.toBe(target.ps.origin);
    expect(client.ps.stats).not.toBe(target.ps.stats);
    expect(client.ps.ammo).not.toBe(target.ps.ammo);
    expect(client.ps.powerups).not.toBe(target.ps.powerups);
    expect(client.ps.persistant).not.toBe(target.ps.persistant);
    expect(client.ps.events).not.toBe(target.ps.events);
    expect(client.ps.eventParms).not.toBe(target.ps.eventParms);
    target.ps.origin = vec3(90, 91, 92);
    target.ps.ammo.set(15, 999);
    target.ps.persistant.set(PersistentIndex.PERS_SCORE, 150);
    expect(client.ps.origin).toEqual(vec3(1, 2, 3));
    expect(client.ps.ammo.get(15)).toBe(115);
    expect(client.ps.persistant.get(PersistentIndex.PERS_SCORE)).toBe(99);
    client.ps.events.set(0, 888);
    expect(target.ps.events.get(0)).toBe(300);
  });

  test("negative camera selectors resolve live targets and remain following when unavailable", () => {
    const { context, entity, client, target, frame, calls } = setup();
    client.sess.spectatorState = SpectatorState.FOLLOW;
    client.sess.spectatorClient = -2;
    client.ps.pmFlags = MoveFlags.FOLLOW | MoveFlags.SCOREBOARD;
    spectatorClientEndFrame(context, entity);
    expect(client.sess.spectatorState).toBe(SpectatorState.FOLLOW);
    expect(client.ps.pmFlags).toBe(MoveFlags.FOLLOW);
    frame.follow2 = 1;
    target.pers.connected = ConnectionState.CONNECTED;
    target.sess.sessionTeam = Team.TEAM_BLUE;
    target.ps.clientNum = 1;
    spectatorClientEndFrame(context, entity);
    expect(client.ps.clientNum).toBe(1);
    target.pers.connected = ConnectionState.DISCONNECTED;
    spectatorClientEndFrame(context, entity);
    expect(client.sess.spectatorState).toBe(SpectatorState.FOLLOW);
    expect(calls).toEqual([]);
  });

  test("invalid explicit target becomes free and begins by owned client index, not followed ps.clientNum", () => {
    const { context, entity, client, target, calls } = setup();
    client.sess.spectatorState = SpectatorState.FOLLOW;
    client.sess.spectatorClient = 1;
    client.ps.clientNum = 37;
    client.ps.pmFlags = MoveFlags.SCOREBOARD;
    target.pers.connected = ConnectionState.CONNECTED;
    target.sess.sessionTeam = Team.TEAM_SPECTATOR;
    spectatorClientEndFrame(context, entity);
    expect<SpectatorState>(client.sess.spectatorState).toBe(SpectatorState.FREE);
    expect(calls).toEqual(["begin:0"]);
    expect(client.ps.pmFlags & MoveFlags.SCOREBOARD).toBe(0);
    client.sess.spectatorState = SpectatorState.SCOREBOARD;
    spectatorClientEndFrame(context, entity);
    expect(client.ps.pmFlags & MoveFlags.SCOREBOARD).toBe(MoveFlags.SCOREBOARD);
  });

  test("successful follow returns before scoreboard bit handling and rejects invalid positive slots", () => {
    const { context, entity, client, target } = setup();
    client.sess.spectatorState = SpectatorState.FOLLOW;
    client.sess.spectatorClient = 1;
    target.pers.connected = ConnectionState.CONNECTED;
    target.sess.sessionTeam = Team.TEAM_RED;
    target.ps.pmFlags = MoveFlags.SCOREBOARD;
    spectatorClientEndFrame(context, entity);
    expect(client.ps.pmFlags).toBe(MoveFlags.SCOREBOARD | MoveFlags.FOLLOW);
    client.sess.spectatorClient = 64;
    expect(() => spectatorClientEndFrame(context, entity)).toThrow();
  });
});

describe("inactivity deadlines and intermission command edges", () => {
  for (const product of products) test(`${product} native inactivity boundary sequence and exact server command`, () => {
    const { context, client, frame, commands, calls } = setup(product);
    client.pers.cmd = command(1000, 0, 1);
    expect(clientInactivityTimer(context, client)).toBe(true);
    client.pers.cmd = command(1000);
    frame.time = 21000;
    expect(clientInactivityTimer(context, client)).toBe(true);
    expect([client.inactivityTime, commands.length, calls.length]).toEqual([31000, 0, 0]);
    frame.time = 21001;
    expect(clientInactivityTimer(context, client)).toBe(true);
    frame.time = 31000;
    expect(clientInactivityTimer(context, client)).toBe(true);
    expect([client.inactivityWarning, commands.length, calls.length]).toEqual([true, 1, 0]);
    expect(commands).toEqual([{ number: 0, text: "cp \"Ten seconds until inactivity drop!\n\"" }]);
    frame.time = 31001;
    expect(clientInactivityTimer(context, client)).toBe(false);
    expect(calls).toEqual(["drop:0:Dropped due to inactivity"]);
  });

  test("disabled inactivity grants sixty seconds; localhost stays exempt without resetting its deadline", () => {
    const { context, client, frame, calls, commands } = setup();
    frame.inactivitySeconds = 0;
    client.inactivityWarning = true;
    clientInactivityTimer(context, client);
    expect([client.inactivityTime, client.inactivityWarning]).toEqual([61000, false]);
    frame.time = 2000;
    clientInactivityTimer(context, client);
    expect(client.inactivityTime).toBe(62000);
    frame.inactivitySeconds = 10;
    frame.time = 70000;
    client.pers.localClient = true;
    expect(clientInactivityTimer(context, client)).toBe(true);
    expect(client.inactivityTime).toBe(62000);
    expect([calls.length, commands.length]).toEqual([0, 0]);
  });

  test("movement or attack refreshes warning state; angle changes and use-item do not", () => {
    const { context, client, frame, commands } = setup();
    const activeCommands = [command(0, CommandButtons.ATTACK), command(0, 0, -1),
      { ...command(0), rightmove: 1 }, { ...command(0), upmove: -1 }];
    for (const cmd of activeCommands) {
      client.inactivityWarning = true;
      client.pers.cmd = cmd;
      frame.time++;
      expect(clientInactivityTimer(context, client)).toBe(true);
      expect(client.inactivityTime).toBe(frame.time + 30000);
      expect(client.inactivityWarning).toBe(false);
    }
    client.inactivityTime = frame.time + 9999;
    client.pers.cmd = { ...command(0, CommandButtons.USE_HOLDABLE), angles: vec3(1000, 2000, 3000) };
    clientInactivityTimer(context, client);
    expect(commands).toHaveLength(1);
    const outside = new GameClient("baseq3");
    expect(() => clientInactivityTimer(context, outside)).toThrow("outside its entity pool");
  });

  for (const product of products) test(`${product} native intermission readiness is a rising edge that stays latched`, () => {
    const { client } = setup(product);
    client.ps.eFlags = 0x1000 | 0x100 | 0x4000;
    client.buttons = CommandButtons.ATTACK;
    client.pers.cmd = command(0, CommandButtons.ATTACK);
    clientIntermissionThink(client);
    expect([client.ps.eFlags, client.oldButtons, client.buttons, client.readyToExit]).toEqual([16384, 1, 1, false]);
    client.pers.cmd = command(0, CommandButtons.USE_HOLDABLE);
    clientIntermissionThink(client);
    expect([client.oldButtons, client.buttons, client.readyToExit]).toEqual([1, 4, true]);
    client.pers.cmd = command(0);
    clientIntermissionThink(client);
    expect(client.readyToExit).toBe(true);
  });
});
