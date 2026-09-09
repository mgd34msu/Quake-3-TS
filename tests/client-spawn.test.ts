import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import { ClientSpawnRuntime, BODY_QUEUE_SIZE, setClientViewAngle, spawnDeathmatchPoint, spawnPlayerStart } from "../src/game/client-spawn.ts";
import type { ClientSpawnHost } from "../src/game/client-spawn.ts";
import { spectatorClientEndFrame, spectatorThink } from "../src/game/client-policy.ts";
import type { ClientPolicyContext } from "../src/game/client-policy.ts";
import { ClientThinkRuntime } from "../src/game/client-think.ts";
import { MovementDiagnostics } from "../src/shared/movement.ts";
import type { ClientThinkHost } from "../src/game/client-think.ts";
import type { ClientEffectsContext } from "../src/game/client-effects.ts";
import type { CombatContext } from "../src/game/combat.ts";
import { EntityPool, initGameEntity, runThink } from "../src/game/entities.ts";
import { killBox } from "../src/game/misc.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { SpawnParser, SpawnVariables, parseSpawnField } from "../src/game/spawn.ts";
import { GameMemory } from "../src/game/memory.ts";
import { ConnectionState, GameFlags, SpectatorState, TeamState } from "../src/game/state.ts";
import type { GameEntity } from "../src/game/state.ts";
import { ServerWorld } from "../src/server/world.ts";
import { EntityEvent, EntityType, GameType, PersistentIndex, Team, Weapon, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ServerEntityFlags } from "../src/shared/entity-shared.ts";
import { ENTITYNUM_NONE, MoveFlags, PlayerAnimation } from "../src/shared/player-state.ts";
import type { UserCommand } from "../src/shared/player-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";

function emptyMap(): BspMap {
  const bounds = { min: vec3(-10000, -10000, -10000), max: vec3(10000, 10000, 10000) };
  return { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}

function noDropMap(): BspMap {
  const map = emptyMap(), leaf = map.leaves[0], model = map.models[0];
  if (leaf === undefined || model === undefined) throw new Error("Fixture needs world model and leaf");
  const planes = [
    { normal: vec3(1, 0, 0), distance: 50 }, { normal: vec3(-1, 0, 0), distance: -30 },
    { normal: vec3(0, 1, 0), distance: 100 }, { normal: vec3(0, -1, 0), distance: 100 },
    { normal: vec3(0, 0, 1), distance: 1000 }, { normal: vec3(0, 0, -1), distance: 1000 },
  ];
  return { ...map, planes, shaders: [{ name: "nodrop", surfaceFlags: 0, contentFlags: 0x80000000 }],
    leaves: [{ ...leaf, brushCount: 1 }], leafBrushes: [0], models: [{ ...model, brushCount: 1 }],
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_, plane) => ({ plane, shader: 0 })) };
}

function fixture(product: Product = "baseq3", map = emptyMap()) {
  const frame = { time: 1000, gameType: GameType.GT_FFA, inactivitySeconds: 60, intermissionTime: 0, intermissionQueued: 0 };
  const settings = { synchronousClients: false, pmoveFixed: false, pmoveMsec: 8, debugMove: 0, gravity: 800,
    speed: 320, dmflags: 0, smoothClients: false, forceRespawnSeconds: 0, singlePlayer: false };
  const calls: string[] = [], state = { handicap: "80", commandReads: 0 };
  const incoming: UserCommand = { serverTime: 1000, angles: vec3(0, 0, 0), buttons: 0,
    weapon: Weapon.WP_MACHINEGUN, forwardmove: 0, rightmove: 0, upmove: 0 };
  const pool = new EntityPool({ print: text => { worldPrints.push(text); }, product, maxClients: 2, mapStartTime: 0, time: () => frame.time,
    link: entity => { world.link(entity); }, unlink: entity => { world.unlink(entity.slot); } });
  const worldPrints: string[] = [];
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" }), world = new ServerWorld(collision, collision.modelBounds(0), number => pool.get(number), { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
  const services = { time: frame.time, intermissionQueued: 0, gameType: frame.gameType, friendlyFire: false,
    knockback: 1000, entities: pool, world, debugDamage: null,
    checkHurtCarrier: () => { throw new Error("Unexpected carrier combat"); },
    logAccuracyHit: () => { throw new Error("Unexpected accuracy combat"); } };
  const combat: CombatContext = product === "baseq3" ? { ...services, product } : { ...services, product,
    checkObeliskAttack: () => { throw new Error("Unexpected obelisk combat"); },
    invulnerabilityEffect: () => { throw new Error("Unexpected invulnerability combat"); } };
  Object.defineProperty(combat, "time", { get: () => frame.time });
  const movementDiagnostics = new MovementDiagnostics(text => { calls.push(text); });
  const thinkHost: ClientThinkHost = { pool, world, movementDiagnostics, effects: { combat }, frame: () => frame, settings: () => settings,
    setPmoveMsec: value => { settings.pmoveMsec = value; },
    intermissionThink: () => { calls.push("intermissionThink"); },
    spectatorThink: entity => { calls.push(`spectatorThink:${entity.slot}`); },
    checkInactivity: () => true,
    freeHook: () => { throw new Error("Unexpected hook"); }, checkGauntletAttack: () => false,
    clientEvents: () => { calls.push("clientEvents"); }, respawn: () => { throw new Error("Unexpected think respawn"); },
    botTestAas: origin => { calls.push(`testAas:${origin.x},${origin.y},${origin.z}`); },
    appendConsoleCommand: () => { throw new Error("Unexpected console command"); }, isDoorTrigger: () => false };
  const think = new ClientThinkRuntime(thinkHost), random = new GameRandom();
  const effects: ClientEffectsContext = { combat, intermissionTime: 0, smoothClients: false, frySound: 0,
    randomInt: () => random.rand(), soundIndex: () => { throw new Error("Unexpected sound index"); },
    sound: () => { throw new Error("Unexpected sound"); }, spectatorEndFrame: entity => { calls.push(`spectatorEndFrame:${entity.slot}`); } };
  Object.defineProperty(effects, "intermissionTime", { get: () => frame.intermissionTime });
  const host: ClientSpawnHost = { pool, world, think, random, frame: () => frame,
    userCommand: number => { calls.push(`command:${number}`); state.commandReads++; return incoming; },
    handicap: number => { calls.push(`handicap:${number}`); return state.handicap; },
    findIntermissionPoint: () => { calls.push("findIntermission"); return { origin: vec3(9, 8, 7), angles: vec3(0, 90, 0) }; },
    moveToIntermission: entity => { calls.push(`moveIntermission:${entity.slot}`); },
    killBox: entity => { calls.push(`killBox:${entity.slot}`); },
    playerDie: entity => { calls.push(`playerDie:${entity.slot}`); }, bodyDie: entity => { calls.push(`bodyDie:${entity.slot}`); },
    effects: () => effects, targets: () => ({ pool, time: frame.time, warn: message => { calls.push(message); },
      remapShader: () => { throw new Error("Unexpected shader remap"); } }) };
  const runtime = new ClientSpawnRuntime(host);
  runtime.initBodyQueue();
  const entity = pool.at(0), client = pool.clientAt(0);
  initGameEntity(entity);
  client.pers.connected = ConnectionState.CONNECTED;
  function point(x: number, y = 0, z = 100, classname = "info_player_deathmatch"): GameEntity {
    const spot = pool.spawn(); spot.classname = classname;
    spot.s.origin = vec3(x, y, z); spot.s.angles = vec3(0, 90, 0); return spot;
  }
  return { frame, settings, calls, state, incoming, pool, world, random, think, thinkHost, effects, host, runtime, entity, client, point };
}

describe("source spawn selection", () => {
  test("spawn handlers apply byte-prefix flags and player-start alias only", () => {
    const f = fixture(), point = f.point(0);
    spawnDeathmatchPoint(point, new SpawnVariables([{ key: "nobots", value: "1e2" }]));
    expect(point.flags).toBe(GameFlags.NO_BOTS);
    spawnPlayerStart(point, new SpawnVariables([{ key: "nohumans", value: "-1" }]));
    expect(point.classname).toBe("info_player_deathmatch");
    expect(point.flags).toBe(GameFlags.NO_BOTS | GameFlags.NO_HUMANS);
    expect(f.world.linkState(point.slot)).toBeUndefined();
  });

  test("farthest ranking is stable, capped at 64 and uses integer half plus inclusive RNG endpoint", () => {
    const f = fixture(), points = Array.from({ length: 70 }, (_, index) => f.point(index * 10));
    const farthest = points[69], midpoint = points[37], nearest = points[0];
    if (farthest === undefined || midpoint === undefined || nearest === undefined) throw new Error("Expected 70 points");
    f.random.reset(0); expect(f.runtime.selectSpawnPoint(vec3(0, 0, 0)).entity).toBe(farthest);
    f.random.reset(12790); expect(f.runtime.selectSpawnPoint(vec3(0, 0, 0)).entity).toBe(midpoint);
    expect(f.runtime.selectNearestDeathmatchSpawnPoint(vec3(0, 0, 100))).toBe(nearest);
    const single = fixture(); single.point(10); single.random.reset(12790);
    expect(single.runtime.selectSpawnPoint(vec3(0, 0, 0)).origin).toEqual(vec3(10, 0, 109));
    const ties = fixture(), first = ties.point(10), second = ties.point(-10), third = ties.point(0, 10);
    ties.random.reset(0); expect(ties.runtime.selectSpawnPoint(vec3(0, 0, 100)).entity).toBe(first);
    ties.random.reset(12790); expect(ties.runtime.selectSpawnPoint(vec3(0, 0, 100)).entity).toBe(second);
    expect(third.inuse).toBe(true);
  });

  test("telefrag checks any linked client, including dead clients; fallback and initial flag preserve source order", () => {
    const f = fixture(), first = f.point(0), initial = f.point(100);
    initial.spawnflags = 1;
    expect(f.runtime.selectInitialSpawnPoint().entity).toBe(initial);
    const blocker = f.pool.at(1); initGameEntity(blocker); blocker.health = -100;
    blocker.r.currentOrigin = vec3(100, 0, 100); blocker.r.mins = vec3(-15, -15, -24); blocker.r.maxs = vec3(15, 15, 32);
    blocker.r.contents = 0; f.world.link(blocker);
    expect(f.runtime.spotWouldTelefrag(initial)).toBe(true);
    expect(f.runtime.selectInitialSpawnPoint().entity).toBe(first);
    blocker.r.mins = vec3(-1000, -1000, -1000); blocker.r.maxs = vec3(1000, 1000, 1000); f.world.link(blocker);
    const seed = f.random.seed;
    expect(f.runtime.selectSpawnPoint(vec3(0, 0, 0)).entity).toBe(first);
    expect(f.random.seed).toBe(seed);
    expect(f.runtime.selectRandomDeathmatchSpawnPoint()).toBe(first);
    expect(() => fixture().runtime.selectSpawnPoint(vec3(0, 0, 0))).toThrow("Couldn't find");
  });

  test("team begin/active selectors cap 32 candidates and use deathmatch fallback", () => {
    const f = fixture("missionpack"), dm = f.point(10), red = f.point(20, 0, 100, "team_CTF_redplayer");
    const blue = f.point(30, 0, 100, "team_CTF_bluespawn");
    expect(f.runtime.selectTeamSpawnPoint(Team.TEAM_RED, TeamState.BEGIN).entity).toBe(red);
    expect(f.runtime.selectTeamSpawnPoint(Team.TEAM_BLUE, TeamState.ACTIVE).entity).toBe(blue);
    expect(f.runtime.selectTeamSpawnPoint(Team.TEAM_RED, TeamState.ACTIVE).entity).toBe(dm);
    const candidates = Array.from({ length: 40 }, (_, index) => f.point(index, 0, 100, "team_CTF_redspawn"));
    const last = candidates[31]; if (last === undefined) throw new Error("Expected 40 points");
    f.random.reset(12790); expect(f.runtime.selectTeamSpawnPoint(Team.TEAM_RED, TeamState.ACTIVE).entity).toBe(last);
  });

  test("unsupported source overrun and impossible restriction cycles fail explicitly", () => {
    const f = fixture(); for (let i = 0; i < 129; i++) f.point(i);
    expect(() => f.runtime.selectRandomDeathmatchSpawnPoint()).toThrow("128-entry");
    const blocked = fixture(), point = blocked.point(0); point.flags = GameFlags.NO_HUMANS;
    expect(() => blocked.runtime.clientSpawn(blocked.entity)).toThrow("complete game RNG cycle");
    expect(blocked.random.seed & 32767).toBe(0);
  });

  test("local initial restriction retries preserve initialSpawn and bot/human selection", () => {
    for (const bot of [false, true]) {
      const f = fixture(), initial = f.point(10), permitted = f.point(100);
      initial.spawnflags = 1; initial.flags = bot ? GameFlags.NO_BOTS : GameFlags.NO_HUMANS;
      permitted.flags = bot ? GameFlags.NO_HUMANS : GameFlags.NO_BOTS;
      f.client.pers.localClient = true; f.settings.synchronousClients = true;
      if (bot) f.entity.r.svFlags |= ServerEntityFlags.BOT;
      f.runtime.clientSpawn(f.entity);
      expect(f.client.ps.origin).toEqual(vec3(100, 0, 109));
      expect(f.client.pers.initialSpawn).toBe(true); expect(f.random.seed).toBe(1);
    }
    const f = fixture(), only = f.point(0); only.flags = GameFlags.NO_HUMANS;
    const blocker = f.pool.at(1); initGameEntity(blocker);
    blocker.r.mins = vec3(-1000, -1000, -1000); blocker.r.maxs = vec3(1000, 1000, 1000); f.world.link(blocker);
    expect(() => f.runtime.clientSpawn(f.entity)).toThrow("complete game RNG cycle");
    expect(f.random.seed).toBe(0); // All-telefrag fallback consumes no draw; repeated state is immediate.
  });
});

describe("ClientSpawn and respawn", () => {
  test("fallback spawn uses real killBox damage before linking the new player", () => {
    for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
      const f = fixture(product); f.point(100); f.settings.synchronousClients = true;
      const victim = f.pool.at(1); initGameEntity(victim);
      victim.health = 100; victim.takedamage = true;
      victim.r.currentOrigin = vec3(100, 0, 100); victim.r.mins = vec3(-15, -15, -24); victim.r.maxs = vec3(15, 15, 32);
      f.world.link(victim);
      const deaths: number[] = [];
      victim.die = (self, source, attacker, amount, method) => {
        expect(self).toBe(victim); expect(source).toBe(f.entity); expect(attacker).toBe(f.entity);
        expect(amount).toBe(80000); expect(method).toBe(18); // G_Damage applies the attacker's 80 handicap.
        expect(f.world.linkState(f.entity.slot)?.linked).not.toBe(true);
        expect(f.client.ps.origin).toEqual(vec3(100, 0, 109)); deaths.push(self.slot);
      };
      f.host.killBox = entity => { killBox(f.effects.combat, entity); };
      f.runtime.clientSpawn(f.entity);
      expect(deaths).toEqual([1]); expect(victim.health).toBe(-999); expect(f.world.linkState(0)?.linked).toBe(true);
    }
  });

  test("QVM integer handicap and product team respawns preserve source loadout", () => {
    for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
      for (const [handicap, expected] of [["0", 100], ["101", 100], ["-1", 100], ["1e2", 1], ["4294967297", 1]] satisfies [string, number][]) {
        const f = fixture(product); f.point(10, 0, 100, "team_CTF_redplayer"); f.point(20, 0, 100, "team_CTF_redspawn");
        f.frame.gameType = GameType.GT_CTF; f.client.sess.sessionTeam = Team.TEAM_RED;
        f.settings.synchronousClients = true; f.state.handicap = handicap;
        f.runtime.clientSpawn(f.entity);
        expect(f.client.ps.origin.x).toBe(10); expect(f.client.ps.health).toBe(expected + 25);
        expect(f.client.ps.ammo.get(Weapon.WP_MACHINEGUN)).toBe(100);
        expect(f.client.ps.persistant.get(PersistentIndex.PERS_TEAM)).toBe(Team.TEAM_RED);
        f.runtime.respawn(f.entity);
        expect(f.client.ps.origin.x).toBe(20); expect(f.client.ps.persistant.get(PersistentIndex.PERS_SPAWN_COUNT)).toBe(2);
      }
    }
  });

  test("native untouched ClientSpawn + ClientThink/Pmove goldens match both products", () => {
    // /tmp/quake3-clientspawn-reference-xxTjTp/reference.c; pinned dbe4ddb source,
    // g_client/g_team/g_active/bg_pmove/bg_slidemove/bg_misc/q_math/q_shared,
    // cc -O0 -fwrapv. Empty trace world and recording external services.
    // Ordinary numeric inputs here have matching native/QVM representations.
    for (const product of ["baseq3", "missionpack"] satisfies Product[]) for (const mode of ["ffa", "team", "bot", "stale", "sync"]) {
      const f = fixture(product); f.point(100);
      const ps = f.client.ps, pers = f.client.pers, sess = f.client.sess;
      ps.ping = 77; ps.eFlags = 0x4000 | 0x80000 | 0x200; ps.persistant.set(PersistentIndex.PERS_SCORE, 13);
      f.client.accuracyHits = 4; f.client.accuracyShots = 9; f.client.damageBlood = 99; f.client.noclip = true;
      f.client.ammoTimes.set(0, 50); f.entity.damage = 91;
      if (mode === "team") f.frame.gameType = GameType.GT_TEAM;
      if (mode === "bot") f.entity.r.svFlags |= ServerEntityFlags.BOT;
      if (mode === "sync") f.settings.synchronousClients = true;
      if (mode === "stale") f.incoming.serverTime = 800;
      f.runtime.clientSpawn(f.entity);
      const moved = mode === "ffa" || mode === "team";
      expect(f.pool.at(0)).toBe(f.entity); expect(f.pool.clientAt(0)).toBe(f.client);
      expect(f.client.ps).toBe(ps); expect(f.client.pers).toBe(pers); expect(f.client.sess).toBe(sess);
      expect(ps.origin).toEqual(vec3(100, 0, moved ? 104.993202 : 109));
      expect(ps.velocity).toEqual(vec3(0, 0, moved ? -80 : 0));
      expect([f.entity.health, ps.health, pers.maxHealth]).toEqual([105, 105, 80]);
      expect(ps.ammo.get(Weapon.WP_MACHINEGUN)).toBe(mode === "team" ? 50 : 100);
      expect(ps.ammo.get(Weapon.WP_GAUNTLET)).toBe(-1); expect(ps.ammo.get(Weapon.WP_GRAPPLING_HOOK)).toBe(-1);
      expect(ps.commandTime).toBe(moved ? 1000 : 900); expect(ps.pmTime).toBe(moved ? 0 : 100);
      expect(ps.pmFlags).toBe(moved ? 0 : 0x240); expect(ps.eFlags).toBe(0x84004);
      expect(ps.torsoAnim).toBe(11); expect(ps.legsAnim).toBe(moved ? 146 : 22);
      expect([ps.ping, f.client.accuracyHits, f.client.accuracyShots, ps.persistant.get(PersistentIndex.PERS_SCORE)]).toEqual([77, 4, 9, 13]);
      expect(ps.persistant.get(PersistentIndex.PERS_SPAWN_COUNT)).toBe(1);
      expect([f.client.airOutTime, f.client.inactivityTime, f.client.lastKilledClient]).toEqual([13000, 61000, -1]);
      expect(f.client.damageBlood).toBe(0); expect(f.client.noclip).toBe(false); expect(f.client.ammoTimes.get(0)).toBe(0);
      expect(f.entity.damage).toBe(2); // Actual ClientEndFrame worldEffects updates this source field.
      expect(f.world.linkState(0)?.linkcount).toBe(moved ? 3 : 2); expect(f.state.commandReads).toBe(2);
      expect(f.client.pers.teamState.state).toBe(TeamState.ACTIVE);
    }
  });

  test("command is read twice and view deltas use the first command", () => {
    const f = fixture(); f.point(100); f.settings.synchronousClients = true;
    f.host.userCommand = () => { f.state.commandReads++; return { ...f.incoming,
      serverTime: f.state.commandReads === 1 ? 1000 : 700, angles: vec3(0, f.state.commandReads === 1 ? 100 : 200, 0) }; };
    f.runtime.clientSpawn(f.entity);
    expect(f.client.ps.deltaAngles.y).toBe(16384 - 100);
    expect(f.client.pers.cmd.angles.y).toBe(200); expect(f.client.pers.cmd.serverTime).toBe(700);
    expect(f.client.ps.commandTime).toBe(900); expect(f.client.lastCmdTime).toBe(1000);
    setClientViewAngle(f.entity, vec3(-90, 450, 0));
    expect(f.client.ps.deltaAngles).toEqual({ x: 49152, y: 16384 - 200, z: 0 });
  });

  test("unchanged SetClientViewAngle executed in actual QVM preserves CVFI overflow and float bits", () => {
    // /tmp/quake3-clientspawn-qvm-RjJBZJ/run-qvm.sh: pinned q3lcc/q3asm,
    // verbatim g_client.c function, original 32-bit engine vm_game=1 interpreter.
    const inputs = [vec3(-90, 450, -0), vec3(359.99, -123456.78, 0.1),
      vec3(12345678, -12345678, 1e20), vec3(0.00001, -0.00001, 180.00001)];
    const deltas = [vec3(49140, 16418, -56), vec3(65522, 4260, -38), vec3(-12, 34, -56), vec3(-12, 34, 32712)];
    const words = [[49844, 0, 17377, 0, 32768, 0], [17331, 65208, 51185, 8292, 15820, 52429],
      [19260, 24910, 52028, 24910, 24749, 30956], [14119, 50604, 46887, 50604, 17204, 1]];
    const f = fixture(); f.client.pers.cmd.angles = vec3(12, -34, 56);
    for (const [index, input] of inputs.entries()) {
      const expected = deltas[index], expectedWords = words[index];
      if (expected === undefined || expectedWords === undefined) throw new Error("Missing QVM angle fixture");
      setClientViewAngle(f.entity, input);
      expect(f.client.ps.deltaAngles).toEqual(expected); expect(f.entity.s.angles).toEqual(input);
      const view = f.client.ps.viewangles, bits = new DataView(new ArrayBuffer(4)), actual: number[] = [];
      for (const value of [view.x, view.y, view.z]) { bits.setFloat32(0, value); const word = bits.getUint32(0); actual.push(word >>> 16, word & 65535); }
      expect(actual).toEqual(expectedWords);
    }
    // Same VM fixture evaluates random()*(numSpots/2) for every supported count.
    for (let count = 1; count <= 64; count++) {
      const choices = fixture(); for (let index = 0; index < count; index++) choices.point(index, 0, 0);
      choices.random.reset(12790);
      expect(choices.runtime.selectSpawnPoint(vec3(0, 0, 0)).origin.x).toBe(count - 1 - Math.trunc(count / 2));
    }
  });

  test("targets grant highest weapon before initial think; intermission/spectator use required services", () => {
    const f = fixture("missionpack"), point = f.point(100), target = f.pool.spawn();
    point.target = "grant"; target.targetname = "grant";
    target.use = (_self, other, activator) => {
      expect(other).toBe(point); expect(activator).toBe(f.entity);
      f.client.ps.stats.set(statSchema("missionpack").weapons, 1 << Weapon.WP_CHAINGUN);
    };
    f.settings.synchronousClients = true; f.runtime.clientSpawn(f.entity);
    expect(f.client.ps.weapon).toBe(Weapon.WP_CHAINGUN);
    const spectator = fixture(); spectator.client.sess.sessionTeam = Team.TEAM_SPECTATOR;
    spectator.client.sess.spectatorState = SpectatorState.FOLLOW;
    spectator.runtime.clientSpawn(spectator.entity);
    expect(spectator.client.ps.origin).toEqual(vec3(9, 8, 7));
    expect(spectator.calls).toContain("spectatorThink:0"); expect(spectator.calls).toContain("spectatorEndFrame:0");
    expect(spectator.world.linkState(0)).toBeUndefined(); expect(spectator.calls).not.toContain("killBox:0");
    const intermission = fixture(); intermission.point(100); intermission.frame.intermissionTime = 10;
    intermission.runtime.clientSpawn(intermission.entity);
    expect(intermission.calls).toContain("moveIntermission:0"); expect(intermission.calls).toContain("intermissionThink");
  });

  for (const product of ["baseq3", "missionpack"] satisfies Product[]) test(`${product} follow session spawn publishes the reached spectator end-frame state`, () => {
    const f = fixture(product), followed = f.pool.clientAt(1), ps = f.client.ps;
    f.client.sess.sessionTeam = Team.TEAM_SPECTATOR;
    f.client.sess.spectatorState = SpectatorState.FOLLOW;
    f.client.sess.spectatorClient = 1;
    f.client.ps.eFlags = 0x80000;
    followed.pers.connected = ConnectionState.CONNECTED;
    followed.sess.sessionTeam = Team.TEAM_FREE;
    followed.ps.clientNum = 1;
    followed.ps.health = 100;
    followed.ps.origin = vec3(301, 202, 103);
    followed.ps.velocity = vec3(-5, 6, 7);
    followed.ps.weapon = Weapon.WP_RAILGUN;
    followed.ps.eFlags = 0x4000 | 0x100;
    followed.ps.addEvent(EntityEvent.EV_JUMP, 7);
    const unexpected = (): never => { throw new Error("Unexpected spectator spawn service"); };
    const policy: ClientPolicyContext = {
      pool: f.pool, world: f.world, movementDiagnostics: f.thinkHost.movementDiagnostics, time: f.frame.time, inactivitySeconds: f.frame.inactivitySeconds,
      follow1: 1, follow2: -1, touchTriggers: entity => { f.think.touchTriggers(entity); },
      followCycle: unexpected, clientBegin: unexpected, dropClient: unexpected, sendServerCommand: unexpected,
    };
    f.thinkHost.spectatorThink = (entity, command) => { spectatorThink(policy, entity, command); };
    f.effects.spectatorEndFrame = entity => { spectatorClientEndFrame(policy, entity); };

    f.runtime.clientSpawn(f.entity);

    expect(f.entity.s.pos.base).toEqual(vec3(301, 202, 103));
    expect(f.entity.s.pos.delta).toEqual(vec3(-5, 6, 7));
    expect([f.entity.s.clientNum, f.entity.s.weapon, f.entity.s.eFlags, f.entity.s.event, f.entity.s.eventParm])
      .toEqual([1, Weapon.WP_RAILGUN, 0x80000 | 0x100, EntityEvent.EV_JUMP, 7]);
    expect(f.client.ps).toBe(ps);
    expect(f.client.ps.pmFlags & MoveFlags.FOLLOW).toBe(MoveFlags.FOLLOW);
    expect(f.client.ps.entityEventSequence).toBe(1);
    expect(followed.ps.entityEventSequence).toBe(0);
    expect(f.world.linkState(f.entity.slot)?.linked).not.toBe(true);
  });

  test("respawn cycles corpse storage and publishes teleport event", () => {
    const f = fixture(); f.point(100); f.runtime.clientSpawn(f.entity);
    f.client.ps.eventSequence = 15; f.entity.health = -39; f.entity.s.legsAnim = PlayerAnimation.BOTH_DEATH2 | 128;
    f.runtime.respawn(f.entity);
    const body = f.pool.at(64);
    expect(body.s.legsAnim).toBe(PlayerAnimation.BOTH_DEAD2); expect(body.health).toBe(0);
    expect(body.s.pos.type).toBe(TrajectoryType.TR_GRAVITY); expect(body.s.pos.delta).toEqual(vec3(0, 0, -80));
    expect(body.takedamage).toBe(true); expect(body.r.ownerNum).toBe(0); expect(body.s.powerups).toBe(0);
    expect(body.s.eFlags).toBe(1); expect(body.nextthink).toBe(6000); expect(body.die).toBe(f.host.bodyDie);
    expect(f.client.ps.eventSequence).toBe(15); expect(f.client.ps.persistant.get(PersistentIndex.PERS_SPAWN_COUNT)).toBe(2);
    expect(f.client.ps.eFlags & 4).toBe(0);
    const event = Array.from({ length: f.pool.numEntities }, (_, index) => f.pool.at(index))
      .find(entity => entity.s.eType === EntityType.ET_EVENTS + EntityEvent.EV_PLAYER_TELEPORT_IN);
    expect(event?.s.clientNum).toBe(0);
  });
});

describe("corpse queue", () => {
  test("NODROP checks s.origin, unlinks first and does not advance the corpse queue", () => {
    const f = fixture("baseq3", noDropMap());
    f.entity.s.origin = vec3(40, 0, 0); f.entity.r.currentOrigin = vec3(0, 0, 0);
    f.world.link(f.entity);
    expect(f.runtime.copyToBodyQueue(f.entity)).toBeNull();
    expect(f.world.linkState(0)?.linked).toBe(false);
    f.entity.s.origin = vec3(0, 0, 0); f.entity.r.currentOrigin = vec3(40, 0, 0);
    f.entity.s.groundEntityNum = 0; f.entity.s.eFlags = 0x200;
    f.client.ps.velocity = vec3(10, 20, 30);
    const body = f.runtime.copyToBodyQueue(f.entity);
    expect(body?.slot).toBe(64); expect(body?.s.pos.type).toBe(TrajectoryType.TR_STATIONARY);
    expect(body?.s.eFlags).toBe(1); expect(body?.s.pos.delta).toEqual(vec3(0, 0, 0));
  });
  test("queue owns eight never-free records, copies values and recycles without aliasing", () => {
    const f = fixture("missionpack"), timer = f.pool.spawn(); timer.classname = "kamikaze timer"; timer.activator = f.entity;
    f.entity.s.eFlags = 0x200; f.entity.s.pos = { ...f.entity.s.pos, base: vec3(1, 2, 3) };
    f.entity.s.groundEntityNum = ENTITYNUM_NONE; f.client.ps.velocity = vec3(4, 5, 6);
    f.entity.r.mins = vec3(-15, -15, -24); f.entity.r.maxs = vec3(15, 15, -8); f.entity.health = -40;
    const body = f.runtime.copyToBodyQueue(f.entity);
    if (body === null) throw new Error("Expected body");
    expect(body.slot).toBe(64); expect(body.s.eFlags).toBe(0x201); expect(timer.activator).toBe(body);
    expect(body.takedamage).toBe(false); expect(body.physicsBounce).toBe(0);
    expect(body.s).not.toBe(f.entity.s); expect(body.s.pos.base).not.toBe(f.entity.s.pos.base);
    f.client.ps.velocity = vec3(9, 9, 9); expect(body.s.pos.delta).toEqual(vec3(4, 5, 6));
    for (let index = 1; index < BODY_QUEUE_SIZE; index++) expect(f.runtime.copyToBodyQueue(f.entity)?.slot).toBe(64 + index);
    expect(f.runtime.copyToBodyQueue(f.entity)).toBe(body);
    f.pool.free(body); expect(body.inuse).toBe(true); expect(body.neverFree).toBe(true);
    expect(() => f.runtime.initBodyQueue()).toThrow("already initialized");
  });

  test("sink uses strict 6500ms cutoff, reschedules 100ms and does not directly move collision origin", () => {
    const f = fixture(); f.entity.r.mins = vec3(-1, -1, -1); f.entity.r.maxs = vec3(1, 1, 1);
    const body = f.runtime.copyToBodyQueue(f.entity); if (body === null) throw new Error("Expected body");
    f.frame.time = 6000; runThink(body, f.frame.time);
    expect(body.s.pos.base.z).toBe(-1); expect(body.r.currentOrigin.z).toBe(0); expect(body.nextthink).toBe(6100);
    f.frame.time = 7500; runThink(body, f.frame.time); expect(body.physicsObject).toBe(true);
    f.frame.time = 7600; runThink(body, f.frame.time);
    expect(body.physicsObject).toBe(false); expect(body.inuse).toBe(true); expect(f.world.linkState(body.slot)?.linked).toBe(false);
  });
});

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
  test.skipIf(!existsSync(`${dataPath}/${product}/pak0.pk3`))(`${product} retail BSP spawn origin runs through actual ClientThink and collision`, async () => {
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    const map = parseBsp(await vfs.read("maps/q3dm1.bsp"));
    const f = fixture(product, map), parser = new SpawnParser(map.entities);
    const memory = new GameMemory(() => 0, () => {});
    while (true) {
      const variables = parser.next(); if (variables === null) break;
      if (variables.string("classname", "").value !== "info_player_deathmatch") continue;
      const point = f.point(0);
      for (const pair of variables.entries) parseSpawnField(pair.key, pair.value, point, memory);
    }
    f.client.pers.localClient = true;
    const chosen = f.runtime.selectInitialSpawnPoint();
    f.runtime.clientSpawn(f.entity);
    expect(f.client.ps.origin.z).toBeLessThanOrEqual(chosen.origin.z);
    expect(f.client.ps.commandTime).toBe(1000);
    expect(f.world.linkState(0)?.linked).toBe(true);
    expect(f.world.trace({ start: f.client.ps.origin, end: f.client.ps.origin,
      shape: { kind: "box", mins: f.entity.r.mins, maxs: f.entity.r.maxs }, mask: 1, passEntityNum: 0 }).solidity).not.toBe("all-solid");
  });
}
