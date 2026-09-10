import { describe, expect, test } from "bun:test";
import { GameSessionManager, pickTeam, teamCount } from "../src/game/session.ts";
import type {
  SessionCvarService,
  SessionServices,
  SessionUserinfo,
  SessionWorldState,
} from "../src/game/session.ts";
import { ConnectionState, SpectatorState, createGameClient } from "../src/game/state.ts";
import { GameType, Team } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { PlayerStateSlots } from "../src/shared/player-state.ts";

class MemorySessionCvars implements SessionCvarService {
  readonly values = new Map<string, string>();

  constructor(private readonly effects: string[]) {}

  get(name: string): string {
    return this.values.get(name) ?? "";
  }

  set(name: string, value: string): void {
    this.values.set(name, value);
    this.effects.push(`cvar:${name}:${value}`);
  }
}

interface SessionFixture {
  readonly world: SessionWorldState;
  readonly cvars: MemorySessionCvars;
  readonly effects: string[];
  readonly manager: GameSessionManager;
}

function fixture(product: Product = "baseq3", gameType = GameType.GT_FFA): SessionFixture {
  const effects: string[] = [];
  const clients = Array.from({ length: 4 }, () => createGameClient(product));
  const world: SessionWorldState = {
    clients,
    maxClients: clients.length,
    teamScores: new PlayerStateSlots(Team.TEAM_NUM_TEAMS),
    gameType,
    teamAutoJoin: false,
    maxGameClients: 0,
    time: 0,
    numNonSpectatorClients: 0,
    newSession: false,
  };
  const cvars = new MemorySessionCvars(effects);
  const services: SessionServices = {
    cvars,
    print(message): void { effects.push(`print:${message}`); },
    broadcastTeamChange(clientNum, oldTeam): void {
      effects.push(`broadcast:${clientNum}:${oldTeam}`);
    },
  };
  return { world, cvars, effects, manager: new GameSessionManager(world, services) };
}

function userinfo(team: string): SessionUserinfo {
  return {
    valueForKey(key): string {
      return key === "team" ? team : "";
    },
  };
}

describe("game sessions", () => {
  test("writes and reads the exact seven-field session format for both products", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const setup = fixture(product);
      const session = setup.world.clients[1]?.sess;
      if (session === undefined) throw new Error("fixture client missing");
      session.sessionTeam = Team.TEAM_RED;
      session.spectatorTime = -2147483648;
      session.spectatorState = SpectatorState.FOLLOW;
      session.spectatorClient = -2;
      session.wins = 17;
      session.losses = 9;
      session.teamLeader = 1;
      setup.manager.writeClient(1);
      expect(setup.cvars.get("session1")).toBe("1 -./,),(-*,( 2 -2 17 9 1");

      setup.cvars.values.set("session1", "2, -5/3; -2|4294967300:6 -9");
      setup.manager.readClient(1);
      expect<Team>(session.sessionTeam).toBe(Team.TEAM_BLUE);
      expect(session.spectatorTime).toBe(-5);
      expect<SpectatorState>(session.spectatorState).toBe(SpectatorState.SCOREBOARD);
      expect(session.spectatorClient).toBe(-2);
      expect(session.wins).toBe(4);
      expect(session.losses).toBe(6);
      expect(session.teamLeader).toBe(-9);
    }
  });

  test("preserves QVM scan zeroes and source buffer boundaries", () => {
    const setup = fixture();
    const session = setup.world.clients[0]?.sess;
    if (session === undefined) throw new Error("fixture client missing");
    session.spectatorClient = 19;
    session.wins = 20;
    session.losses = 21;
    session.teamLeader = 1;
    setup.cvars.values.set("session0", "1 77 ");
    setup.manager.readClient(0);
    expect(session).toMatchObject({
      sessionTeam: Team.TEAM_RED,
      spectatorTime: 77,
      spectatorState: SpectatorState.NOT,
      spectatorClient: 0,
      wins: 0,
      losses: 0,
      teamLeader: 0,
    });

    setup.cvars.values.set("session0", "1");
    expect(() => setup.manager.readClient(0)).toThrow("terminating NUL");
    setup.cvars.values.set("session0", "\u0100");
    expect(() => setup.manager.readClient(0)).toThrow("byte characters");
  });

  test("restores and saves complete raw session team, spectator and leader integers for both products", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      for (const value of ["3 0 99 -1 0 0 0", "99 12 1 4 5 6 0", "-7 13 -99 7 8 9 1", "3 0 99 -1 0 0 9", "3 0 99 -1 0 0 -1"]) {
        const setup = fixture(product);
        setup.cvars.values.set("session0", value);
        setup.manager.readClient(0);
        setup.manager.writeClient(0);
        expect(setup.cvars.get("session0")).toBe(value);

        const restored = fixture(product);
        restored.cvars.values.set("session0", setup.cvars.get("session0"));
        restored.manager.readClient(0);
        expect(restored.world.clients[0]?.sess).toEqual(setup.world.clients[0]?.sess);
      }
    }
  });

  test("TeamCount and PickTeam include connecting clients, honor ignore, counts and scores", () => {
    const setup = fixture("missionpack", GameType.GT_HARVESTER);
    const first = setup.world.clients[0];
    const second = setup.world.clients[1];
    if (first === undefined || second === undefined) throw new Error("fixture clients missing");
    first.pers.connected = ConnectionState.CONNECTING;
    first.sess.sessionTeam = Team.TEAM_BLUE;
    second.pers.connected = ConnectionState.CONNECTED;
    second.sess.sessionTeam = Team.TEAM_RED;
    expect(teamCount(setup.world, -1, Team.TEAM_BLUE)).toBe(1);
    expect(teamCount(setup.world, 0, Team.TEAM_BLUE)).toBe(0);
    expect(pickTeam(setup.world, 1)).toBe(Team.TEAM_RED);
    expect(pickTeam(setup.world, 0)).toBe(Team.TEAM_BLUE);
    expect(pickTeam(setup.world, -1)).toBe(Team.TEAM_BLUE);

    setup.world.teamScores.set(Team.TEAM_BLUE, 4);
    setup.world.teamScores.set(Team.TEAM_RED, 3);
    expect(pickTeam(setup.world, -1)).toBe(Team.TEAM_RED);
    setup.world.teamScores.set(Team.TEAM_BLUE, 3);
    expect(pickTeam(setup.world, -1)).toBe(Team.TEAM_BLUE);
    second.pers.connected = ConnectionState.DISCONNECTED;
    expect(pickTeam(setup.world, -1)).toBe(Team.TEAM_RED);
  });

  test("initializes team clients through autojoin or forced spectator branches", () => {
    const auto = fixture("missionpack", GameType.GT_HARVESTER);
    auto.world.teamAutoJoin = true;
    auto.world.time = 1234;
    const blue = auto.world.clients[1];
    if (blue === undefined) throw new Error("fixture client missing");
    blue.pers.connected = ConnectionState.CONNECTING;
    blue.sess.sessionTeam = Team.TEAM_BLUE;
    auto.manager.initializeClient(0, userinfo("s"));
    const joined = auto.world.clients[0]?.sess;
    if (joined === undefined) throw new Error("fixture client missing");
    expect(joined.sessionTeam).toBe(Team.TEAM_RED);
    expect(joined.spectatorState).toBe(SpectatorState.FREE);
    expect(joined.spectatorTime).toBe(1234);
    expect(auto.effects).toEqual([
      "broadcast:0:-1",
      "cvar:session0:1 1234 1 0 0 0 0",
    ]);

    const forced = fixture("baseq3", GameType.GT_CTF);
    forced.manager.initializeClient(0, userinfo(""));
    expect(forced.world.clients[0]?.sess.sessionTeam).toBe(Team.TEAM_SPECTATOR);
    expect(forced.effects).toEqual(["cvar:session0:3 0 1 0 0 0 0"]);
  });

  test("initializes every non-team spectator, capacity and tournament branch", () => {
    const cases = [
      { product: "baseq3", gameType: GameType.GT_FFA, team: "spectator", max: 0, count: 0,
        expected: Team.TEAM_SPECTATOR },
      { product: "missionpack", gameType: GameType.GT_FFA, team: "Spectator", max: 0, count: 0,
        expected: Team.TEAM_FREE },
      { product: "baseq3", gameType: GameType.GT_FFA, team: "", max: 2, count: 2,
        expected: Team.TEAM_SPECTATOR },
      { product: "missionpack", gameType: GameType.GT_SINGLE_PLAYER, team: "", max: 2, count: 1,
        expected: Team.TEAM_FREE },
      { product: "baseq3", gameType: GameType.GT_TOURNAMENT, team: "", max: 0, count: 2,
        expected: Team.TEAM_SPECTATOR },
      { product: "missionpack", gameType: GameType.GT_TOURNAMENT, team: "", max: 1, count: 1,
        expected: Team.TEAM_FREE },
    ] satisfies readonly {
      product: Product;
      gameType: GameType;
      team: string;
      max: number;
      count: number;
      expected: Team;
    }[];
    for (const scenario of cases) {
      const setup = fixture(scenario.product, scenario.gameType);
      setup.world.maxGameClients = scenario.max;
      setup.world.numNonSpectatorClients = scenario.count;
      setup.world.time = -17;
      setup.manager.initializeClient(0, userinfo(scenario.team));
      expect(setup.world.clients[0]?.sess).toMatchObject({
        sessionTeam: scenario.expected,
        spectatorState: SpectatorState.FREE,
        spectatorTime: -17,
      });
    }
  });

  test("initializes world sessions with wrapped game integers and preserves an existing newSession", () => {
    const matching = fixture("baseq3", GameType.GT_TOURNAMENT);
    matching.world.newSession = true;
    matching.cvars.values.set("session", "4294967297tail");
    matching.manager.initializeWorld();
    expect(matching.world.newSession).toBe(true);
    expect(matching.effects).toEqual([]);

    const changed = fixture("missionpack", GameType.GT_OBELISK);
    changed.cvars.values.set("session", "4");
    changed.manager.initializeWorld();
    expect(changed.world.newSession).toBe(true);
    expect(changed.effects).toEqual(["print:Gametype changed, clearing session data.\n"]);
  });

  test("writes world gametype first and only persists fully connected clients in slot order", () => {
    const setup = fixture("missionpack", GameType.GT_1FCTF);
    const disconnected = setup.world.clients[0];
    const connected = setup.world.clients[1];
    const connecting = setup.world.clients[2];
    const last = setup.world.clients[3];
    if (disconnected === undefined || connected === undefined || connecting === undefined || last === undefined) {
      throw new Error("fixture clients missing");
    }
    disconnected.pers.connected = ConnectionState.DISCONNECTED;
    connected.pers.connected = ConnectionState.CONNECTED;
    connected.sess.wins = 2;
    connecting.pers.connected = ConnectionState.CONNECTING;
    last.pers.connected = ConnectionState.CONNECTED;
    last.sess.teamLeader = 1;
    setup.manager.writeWorld();
    expect(setup.effects).toEqual([
      "cvar:session:5",
      "cvar:session1:0 0 0 0 2 0 0",
      "cvar:session3:0 0 0 0 0 0 1",
    ]);
  });

  test("rejects world storage that cannot represent source client or team arrays", () => {
    const valid = fixture();
    const tooMany: SessionWorldState = { ...valid.world, maxClients: valid.world.clients.length + 1 };
    expect(() => new GameSessionManager(tooMany, {
      cvars: valid.cvars,
      print(): void {},
      broadcastTeamChange(): void {},
    })).toThrow(RangeError);
    const shortScores: SessionWorldState = { ...valid.world, teamScores: new PlayerStateSlots(3) };
    expect(() => new GameSessionManager(shortScores, {
      cvars: valid.cvars,
      print(): void {},
      broadcastTeamChange(): void {},
    })).toThrow(RangeError);
    expect(() => valid.manager.writeClient(-1)).toThrow(RangeError);
    expect(() => valid.manager.readClient(4)).toThrow(RangeError);
  });
});
