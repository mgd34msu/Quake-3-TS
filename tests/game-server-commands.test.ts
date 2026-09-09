import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import type { CvarSnapshot } from "../src/core/cvar.ts";
import { vec3 } from "../src/core/math.ts";
import { parseEntities, tokenizeCommand } from "../src/core/text.ts";
import { EntityType, GameType, MoveType, Team, Weapon } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { EntityPool } from "../src/game/entities.ts";
import { GameRuntime } from "../src/game/runtime.ts";
import type { GameRuntimeOwner } from "../src/game/runtime.ts";
import { ServerWorld } from "../src/server/world.ts";
import { GameServerCommandRuntime } from "../src/game/server-commands.ts";
import type { GameServerCommandHost, ServerCommandCapability, ServerCommandCvar } from "../src/game/server-commands.ts";
import { ConnectionState } from "../src/game/state.ts";
import type { GameEntity } from "../src/game/state.ts";

function fixture(product: Product = "baseq3") {
  const cvars = new CvarRegistry();
  cvars.register("g_banIPs", "", CvarFlag.Archive);
  cvars.register("g_filterBan", "1", CvarFlag.Archive);
  cvars.register("dedicated", "0");
  cvars.register("g_gametype", "0");
  const snapshots = new Map<ServerCommandCvar, CvarSnapshot>();
  const names: ServerCommandCvar[] = ["g_banIPs", "g_filterBan", "g_gametype", "dedicated"];
  const refreshVm = () => {
    for (const name of names) {
      const value = cvars.get(name);
      if (value === undefined) throw new Error(`Missing cvar ${name}`);
      snapshots.set(name, value);
    }
  };
  const setCvar = (name: ServerCommandCvar, value: string) => { cvars.set(name, value); refreshVm(); };
  const pool = new EntityPool({ print: text => { printed.push(text); }, product, maxClients: 4, mapStartTime: 0, time: () => 1000, link() {}, unlink() {} });
  const printed: string[] = []; const sent: { clientNumber: number; command: string }[] = [];
  const forced: { entity: GameEntity; team: string }[] = []; const listed: string[] = [];
  const commands = new CommandBuffer();
  commands.register("g_banIPs", () => {
    const value = cvars.get("g_banIPs");
    if (value === undefined) throw new Error("Missing ban cvar");
    listed.push(value.value);
  });
  const unavailable: ServerCommandCapability = { kind: "unavailable", reason: "test host has no bot/arena/podium service" };
  const host: GameServerCommandHost = { print: text => printed.push(text), sendServerCommand: (clientNumber, command) => sent.push({ clientNumber, command }),
    setTeam: (entity, team) => forced.push({ entity, team }), executeConsoleNow: text => { commands.insert(text); commands.execute(); },
    readVmCvar: name => {
      const value = snapshots.get(name);
      if (value === undefined) throw new Error(`Missing VM snapshot ${name}`);
      return value;
    }, bots: unavailable, memory: unavailable, podium: unavailable };
  const runtime = new GameServerCommandRuntime(pool, cvars, host);
  refreshVm();
  return { runtime, cvars, setCvar, refreshVm, pool, printed, sent, forced, listed, host, console: (text: string) => runtime.consoleCommand(tokenizeCommand(text)) };
}

describe("native g_svcmds IP filter fixtures", () => {
  // Untouched g_svcmds.c at dbe4ddb10315479fc00086f08e25d968b4b43c49,
  // original StringToFilter/UpdateIPBans/G_FilterPacket emitted these values.
  const cases: [string, string, string, string][] = [
    ["192.168", "192.168.*.* ", "192.168.50.200", "192.169.50.200"],
    ["10.*.0.*", "10.*.0.* ", "10.255.0.99", "10.255.1.99"],
    ["256.511.999.65536", "0.255.231.0 ", "0.255.231.0", "0.255.0.231"],
    ["1a2b3c4junk", "1.2.3.4 ", "1.2.3.4", "4.3.2.1"],
    ["*123", "*.23.*.* ", "1.23.3.4", "1.1.23.4"],
    ["*.2.*.4", "*.2.*.4 ", "99.2.88.4", "99.2.4.88"],
  ];
  for (const [input, serialized, match, miss] of cases) test(`source mask/byte order for ${input}`, () => {
    const f = fixture();
    expect(f.console(`addip ${input}`)).toBe(true);
    expect(f.cvars.get("g_banIPs")?.value).toBe(serialized);
    expect(f.runtime.filterPacket(match)).toBe(true);
    expect(f.runtime.filterPacket(miss)).toBe(false);
  });

  test("packet bytes wrap individually, delimiters need not be dots, and ports stop parsing", () => {
    const f = fixture(); f.console("addip 1.2.3.4");
    for (const address of ["1.2.3.4:27960", "257.258.259.260", "1a2b3c4", "1.2.3.4.99"]) expect(f.runtime.filterPacket(address)).toBe(true);
    expect(f.runtime.filterPacket("localhost")).toBe(false);
    f.console("addip 0.0.0.0");
    expect(f.runtime.filterPacket("localhost")).toBe(true);
    expect(f.runtime.filterPacket("abcd")).toBe(true);
  });

  test("broadcast compare collides with the free sentinel and retains a removed full mask", () => {
    const f = fixture();
    f.console("addip 255.255.255.255");
    expect(f.cvars.get("g_banIPs")?.value).toBe("");
    expect(f.runtime.filterPacket("255.255.255.255")).toBe(true);
    f.console("addip 10");
    expect(f.cvars.get("g_banIPs")?.value).toBe("10.*.*.* ");
    expect(f.runtime.filterPacket("255.255.255.255")).toBe(false);
    f.console("addip 1.2.3.4"); f.console("removeip 1.2.3.4");
    expect(f.runtime.filterPacket("1.2.3.4")).toBe(false);
    expect(f.runtime.filterPacket("255.255.255.255")).toBe(true);
    f.console("addip bad");
    expect(f.runtime.filterPacket("255.255.255.255")).toBe(true);
    expect(f.printed).toContain("Bad filter address: bad\n");
  });

  test("g_filterBan inverts matching and nonmatching results, including empty lists", () => {
    const f = fixture();
    expect(f.runtime.filterPacket("1.2.3.4")).toBe(false);
    expect(f.runtime.filterPacket("")).toBe(false);
    f.setCvar("g_filterBan", "0");
    expect(f.runtime.filterPacket("1.2.3.4")).toBe(true);
    expect(f.runtime.filterPacket("")).toBe(true);
    f.console("addip 1.2");
    expect(f.runtime.filterPacket("1.2.3.4")).toBe(false);
    expect(f.runtime.filterPacket("1.3.3.4")).toBe(true);
    f.setCvar("g_filterBan", "-2");
    expect(f.runtime.filterPacket("1.2.3.4")).toBe(true);
  });

  test("process uses its original spaced buffer and ignores the final unspaced token", () => {
    const f = fixture();
    f.setCvar("g_banIPs", "  1.2  3.4 "); f.runtime.processIPBans();
    expect(f.cvars.get("g_banIPs")?.value).toBe("1.2.*.* 3.4.*.* ");
    expect(f.runtime.filterPacket("3.4.5.6")).toBe(true);
    const g = fixture();
    g.setCvar("g_banIPs", "1.2 3.4"); g.runtime.processIPBans();
    expect(g.cvars.get("g_banIPs")?.value).toBe("1.2.*.* ");
    expect(g.runtime.filterPacket("3.4.5.6")).toBe(false);
    g.setCvar("g_banIPs", "5.6 "); g.runtime.processIPBans();
    expect(g.runtime.filterPacket("1.2.3.4")).toBe(true);
    expect(g.runtime.filterPacket("5.6.7.8")).toBe(true);
    const h = fixture(); h.setCvar("g_banIPs", "1.2"); h.runtime.processIPBans();
    expect(h.cvars.get("g_banIPs")?.value).toBe("1.2");
    expect(h.runtime.filterPacket("1.2.3.4")).toBe(false);
  });

  test("256-byte persistence cap does not remove live filters that could not fit", () => {
    const f = fixture();
    for (let i = 0; i < 15; i++) f.console("addip 255.255.255.254");
    f.console("addip 255.255.255.253");
    expect(f.cvars.get("g_banIPs")?.value.length).toBe(240);
    expect(f.runtime.filterPacket("255.255.255.253")).toBe(true);
    expect(f.printed).toContain("g_banIPs overflowed at MAX_CVAR_VALUE_STRING\n");
  });

  test("1024 allocated filters reach the source cap, and a removed slot is reused", () => {
    const f = fixture();
    for (let i = 0; i < 1024; i++) f.console("addip 1");
    f.console("addip 2");
    expect(f.printed.at(-1)).toBe("IP filter list is full\n");
    expect(f.runtime.filterPacket("2.3.4.5")).toBe(false);
    f.console("removeip 1"); f.console("addip 2");
    expect(f.runtime.filterPacket("2.3.4.5")).toBe(true);
  });

  test("undefined address octets reject only when a matching filter consumes them", () => {
    const f = fixture();
    expect(() => f.console(`addip ${"9".repeat(128)}`)).toThrow("127-digit");
    expect(f.runtime.filterPacket("1.2.3.4")).toBe(false);
    for (const input of ["", "1", "1.2", "1.2.3", "bot", ":27960"]) expect(f.runtime.filterPacket(input)).toBe(false);
    f.console("addip *.*.*.4");
    for (const input of ["", "1", "1.2", "1.2.3", "bot", ":27960"]) expect(() => f.runtime.filterPacket(input)).toThrow("uninitialized");
    expect(() => f.runtime.filterPacket("1".repeat(1024))).toThrow("userinfo bound");
    f.setCvar("g_banIPs", " ".repeat(256));
    expect(() => f.runtime.processIPBans()).toThrow("vmCvar buffer");
    expect(() => f.console("addip \u0100")).toThrow("source bytes");
  });
});

describe("source server-console dispatch", () => {
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) test(`${product} console composes with real admission, team change, death and client spawn`, () => {
    const entities = '{ "classname" "worldspawn" }\n{ "classname" "info_player_deathmatch" "origin" "0 0 64" }';
    const bounds = { min: vec3(-10000, -10000, -10000), max: vec3(10000, 10000, 10000) };
    const map: BspMap = { entities, entityRecords: parseEntities(entities), shaders: [], planes: [], nodes: [],
      leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
      leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
      brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
    const cvars = new CvarRegistry(); cvars.set("sv_maxclients", "2"); cvars.set("bot_enable", "0"); cvars.set("g_log", "");
    const userinfo = new Map([[0, "\\ip\\localhost\\name\\Console Player\\handicap\\100\\model\\sarge"], [1, "\\ip\\10.1.2.3\\name\\Rejected"]]);
    const configs = new Map<number, string>(); const printed: string[] = []; const sent: string[] = []; const listed: string[] = [];
    const commands = new CommandBuffer();
    commands.register("g_banIPs", () => {
      const value = cvars.get("g_banIPs"); if (value === undefined) throw new Error("Missing engine ban cvar"); listed.push(value.value);
    });
    const owner: GameRuntimeOwner = { game: null };
    const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
    const world = new ServerWorld(collision, collision.modelBounds(0), number => owner.game?.data.entity(number), { loading: false, print: text => { printed.push(text); }, developerPrint: text => { printed.push(text); } });
    const runtime = GameRuntime.create({ product, map, collision, world, levelTime: 1000, randomSeed: 1, restart: false,
      buildDate: "source-test", cvars, configstrings: { get: index => configs.get(index) ?? "", set: (index, value) => { configs.set(index, value); } },
      engine: { milliseconds: () => 0, print: text => printed.push(text), sendServerCommand: (_slot, text) => sent.push(text),
        dropClient: (_slot, reason) => { throw new Error(`Unexpected drop: ${reason}`); },
        getUserinfo: slot => { const value = userinfo.get(slot); if (value === undefined) throw new Error("Missing test userinfo"); return value; },
        setUserinfo: (slot, value) => { userinfo.set(slot, value); },
        getUserCommand: () => ({ serverTime: 1000, angles: vec3(0, 0, 0), buttons: 0, weapon: Weapon.WP_MACHINEGUN, forwardmove: 0, rightmove: 0, upmove: 0 }),
        appendConsoleCommand: text => commands.append(text), insertConsoleCommand: text => commands.insert(text),
        executeConsoleNow: text => { commands.insert(text); commands.execute(); },
        openLog: () => { throw new Error("Logging disabled for this test"); } },
      botFactory: { kind: "unavailable", reason: "Bot AI not enabled" } }, owner);
    try {
      expect(runtime.clientConnect(0, true, false)).toBeNull(); runtime.clientBegin(0);
      const client = runtime.pool.clientAt(0);
      expect(client.pers.connected).toBe(ConnectionState.CONNECTED);
      expect(client.sess.sessionTeam).toBe(Team.TEAM_FREE);
      expect(client.ps.pmType).toBe(MoveType.PM_NORMAL);
      expect(runtime.consoleCommand(tokenizeCommand('forceteam "Console Player" spectator'))).toBe(true);
      expect(client.sess.sessionTeam).toBe(Team.TEAM_SPECTATOR);
      expect(client.ps.pmType).toBe(MoveType.PM_SPECTATOR);
      expect(runtime.level.numNonSpectatorClients).toBe(0);
      expect(sent.some(text => text.includes("joined the spectators"))).toBe(true);
      expect(configs.get(544)).toContain("\\t\\3");
      runtime.consoleCommand(["addip", "10"]); runtime.consoleCommand(["listip"]);
      expect(listed).toEqual(["10.*.*.* "]);
      expect(runtime.clientConnect(1, true, false)).toBe("You are banned from this server.");
      cvars.set("g_filterBan", "0");
      expect(runtime.serverCommands.filterPacket("10.1.2.3")).toBe(true);
      runtime.runFrame(1050);
      expect(runtime.serverCommands.filterPacket("10.1.2.3")).toBe(false);
      expect(runtime.clientConnect(1, true, false)).toBeNull();
    } finally { runtime.shutdown(false); }
  });

  test("VM cvars change only on update while listip reads the engine immediately", () => {
    const f = fixture();
    f.cvars.set("g_filterBan", "0"); f.cvars.set("dedicated", "1"); f.cvars.set("g_gametype", "2");
    expect(f.runtime.filterPacket("1.2.3.4")).toBe(false);
    expect(f.console("say cached")).toBe(false);
    expect(f.console("abort_podium")).toBe(true);
    f.cvars.set("g_banIPs", "1.2 "); f.runtime.processIPBans();
    f.console("listip"); expect(f.listed).toEqual(["1.2 "]);
    f.refreshVm();
    expect(f.runtime.filterPacket("1.2.3.4")).toBe(true);
    expect(f.console("say updated")).toBe(true);
    expect(() => f.console("abort_podium")).toThrow("unavailable");
    f.runtime.processIPBans();
    expect(f.runtime.filterPacket("1.2.3.4")).toBe(false);
    expect(f.cvars.get("g_banIPs")?.value).toBe("1.2.*.* ");
    f.runtime.processIPBans();
    expect(f.cvars.get("g_banIPs")?.value).toBe("1.2.*.* ");
    f.refreshVm(); f.runtime.processIPBans();
    expect(f.cvars.get("g_banIPs")?.value).toBe("1.2.*.* 1.2.*.* ");
  });

  test("unchanged VM modification count does not restore the source-mutated ban string", () => {
    const f = fixture(); f.setCvar("g_banIPs", "1.2.*.* ");
    f.runtime.processIPBans(); f.refreshVm(); f.runtime.processIPBans();
    expect(f.cvars.get("g_banIPs")?.value).toBe("1.2.*.* ");
  });

  test("add/remove usage, exact mask removal, malformed suffixes and engine listip execution", () => {
    const f = fixture();
    f.console("addip"); f.console("removeip"); f.console("addip 1..2"); f.console("addip 1.");
    expect(f.printed).toEqual(["Usage:  addip <ip-mask>\n", "Usage:  sv removeip <ip-mask>\n", "Bad filter address: .2\n", "Bad filter address: \n"]);
    f.console("addip 192.168"); f.console("removeip 192.168.0.1");
    expect(f.printed.at(-1)).toBe("Didn't find 192.168.0.1.\n");
    expect(f.console("LiStIp")).toBe(true);
    expect(f.listed).toEqual(["192.168.*.* "]);
    f.console("removeip 192.168.*.*");
    expect(f.printed.at(-1)).toBe("Removed.\n");
    expect(f.runtime.filterPacket("192.168.1.1")).toBe(false);
    const banCvar = f.cvars.get("g_banIPs");
    if (banCvar === undefined) throw new Error("Missing registered ban cvar");
    expect(banCvar.flags & CvarFlag.Archive).toBe(CvarFlag.Archive);
  });

  test("ClientForString uses first-digit atoi or uncleaned ASCII-insensitive names", () => {
    const f = fixture();
    const first = f.pool.clientAt(0); first.pers.connected = ConnectionState.CONNECTING; first.pers.netname = "^1Player One";
    const second = f.pool.clientAt(1); second.pers.connected = ConnectionState.CONNECTED; second.pers.netname = "\xc4Name";
    expect(f.runtime.clientForString("00trailing")).toBe(first);
    expect(f.runtime.clientForString("^1PLAYER ONE")).toBe(first);
    expect(f.runtime.clientForString("Player One")).toBeNull();
    expect(f.runtime.clientForString("\xe4Name")).toBeNull();
    expect(f.runtime.clientForString("\xc4NAME")).toBe(second);
    expect(f.runtime.clientForString("2")).toBeNull();
    expect(f.runtime.clientForString("4")).toBeNull();
    expect(f.runtime.clientForString("2147483648")).toBeNull();
    expect(f.runtime.clientForString("-1")).toBeNull();
    expect(f.printed).toContain("Client 2 is not connected\n");
    expect(f.printed).toContain("Bad client slot: 4\n");
    expect(f.printed).toContain("Bad client slot: -./,),(-*,(\n");
    expect(f.printed).toContain("User -1 is not on the server\n");
    f.console('forceteam "^1PLAYER ONE" blue');
    expect(f.forced).toEqual([{ entity: f.pool.at(0), team: "blue" }]);
    f.console("forceteam 1");
    expect(f.forced.at(-1)).toEqual({ entity: f.pool.at(1), team: "" });
  });

  test("entitylist skips slot0/unused slots and prints source type labels or numeric fallback", () => {
    const f = fixture();
    f.pool.at(0).inuse = true;
    const player = f.pool.at(1); player.inuse = true; player.s.eType = EntityType.ET_PLAYER; player.classname = "player";
    const item = f.pool.spawn(); item.s.eType = EntityType.ET_ITEM; item.classname = "item_health";
    const event = f.pool.spawn(); event.s.eType = 123; event.classname = null;
    f.console("ENTITYLIST");
    expect(f.printed.join("")).toBe("  1:ET_PLAYER           player\n 64:ET_ITEM             item_health\n 65:123                 \n");
  });

  test("dedicated say and unknown commands broadcast exact unescaped ConcatArgs", () => {
    const f = fixture();
    expect(f.console("unknown a b")).toBe(false);
    expect(f.console("say hello")).toBe(false);
    f.setCvar("dedicated", "1");
    expect(f.console('SAY "hello world"')).toBe(true);
    expect(f.console("unknown a b")).toBe(true);
    expect(f.runtime.consoleCommand(["say", 'quote"inside'])).toBe(true);
    expect(f.sent).toEqual([{ clientNumber: -1, command: 'print "server: hello world"' }, { clientNumber: -1, command: 'print "server: unknown a b"' }, { clientNumber: -1, command: 'print "server: quote"inside"' }]);
    f.runtime.consoleCommand(["say", "a".repeat(1021), "bb"]);
    expect(f.sent.at(-1)?.command).toBe(`print "server: ${"a".repeat(1021)} "`);
  });

  test("external service commands reject unavailable capabilities and call available ones", () => {
    const f = fixture();
    for (const command of ["game_memory", "addbot sarge", "botlist"]) expect(() => f.console(command)).toThrow("unavailable");
    expect(f.console("abort_podium")).toBe(true);
    f.setCvar("g_gametype", String(GameType.GT_SINGLE_PLAYER));
    expect(() => f.console("abort_podium")).toThrow("unavailable");
    const mutableCalls: string[][] = [];
    const capability: ServerCommandCapability = { kind: "available", run: argv => mutableCalls.push([...argv]) };
    const available = new GameServerCommandRuntime(f.pool, f.cvars, { ...f.host, bots: capability, memory: capability, podium: capability });
    for (const command of ["game_memory", "addbot sarge", "botlist", "abort_podium"]) expect(available.consoleCommand(tokenizeCommand(command))).toBe(true);
    expect(mutableCalls).toEqual([["game_memory"], ["addbot", "sarge"], ["botlist"], ["abort_podium"]]);
  });

  test("instances and product variants retain separate filters and shared supplied clients", () => {
    const first = fixture("baseq3"); const second = fixture("missionpack");
    first.console("addip 10");
    expect(first.runtime.filterPacket("10.1.2.3")).toBe(true);
    expect(second.runtime.filterPacket("10.1.2.3")).toBe(false);
    expect(second.pool.clientAt(0).ps.product).toBe("missionpack");
  });
});
