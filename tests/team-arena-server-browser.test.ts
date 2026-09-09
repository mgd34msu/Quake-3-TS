import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { CommonParseState } from "../src/core/common-parse.ts";
import { keynumToString } from "../src/engine/client-keys.ts";
import { ClientStaticState } from "../src/engine/client-state.ts";
import { ServerBrowser, ServerBrowserSource } from "../src/engine/server-browser.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { decodeConnectionless, encodeConnectionlessText } from "../src/protocol/connectionless.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { loadMenuDefinitions } from "../src/ui/menu.ts";
import { UiRuntime } from "../src/ui/runtime.ts";
import { TeamArenaUiCvars } from "../src/ui/team-arena/cvars.ts";
import { TeamArenaGameInfo, TeamArenaMenuBuffer, infoSlot } from "../src/ui/team-arena/game-info.ts";
import { TeamArenaUiMemory } from "../src/ui/team-arena/memory.ts";
import { TeamArenaServerBrowser } from "../src/ui/team-arena/server-browser.ts";
import { baseFixture } from "./base-ui-fixture.ts";

function unused(): never { throw new Error("Browser prerequisite fixture does not implement painting or product feeder callbacks"); }
function socket(io: UnixIo) { if (io.udp === null) throw new Error("Missing actual UDP socket"); return io.udp; }
async function packet(io: UnixIo) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    io.pollPacketEvent(); const event = io.takeQueuedEvent();
    if (event !== null) { if (event.kind !== "packet") throw new Error("Expected actual UDP event"); return event; }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for localhost browser packet");
}

async function fixture() {
  const graphics = await baseFixture(), root = mkdtempSync(join(tmpdir(), "q3-team-browser-"));
  const prints: string[] = [], sound = new SoundOutput(), ios: UnixIo[] = [], streams: PassThrough[] = [];
  const print = (text: string): undefined => { prints.push(text); };
  let active = true, runtime: UiRuntime | null = null;
  const assertActive = (): void => { if (!active) throw new Error("retired Team Arena browser"); };
  const calendar = new UnixSystemClock(() => new Date(2026, 0, 2, 3, 4).getTime());
  const files = new CommonFileState({ dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a",
    homePath: root, cdPath: null, product: "missionpack" }, print, sound, graphics.cvars);
  const close = (): void => {
    runtime?.dispose(); files.close(); sound.close();
    for (const io of ios) io.close(); for (const stream of streams) stream.destroy();
    graphics.close(); rmSync(root, { recursive: true, force: true });
  };
  try {
    mkdirSync(join(root, "missionpack/ui"), { recursive: true });
    writeFileSync(join(root, "missionpack/ui/browser-set.txt"), '{ loadMenu { "ui/browser-fixture.menu" } }');
    writeFileSync(join(root, "missionpack/ui/browser-fixture.menu"), 'menuDef { name browser rect 0 0 640 480 visible 0 itemDef { name servers type 6 feeder 2 rect 0 0 200 100 visible 1 } }');
    await files.initialize({ checksumFeed: 0, random: () => 0 }, assertActive);
    const cvars = graphics.cvars, ui = new TeamArenaUiCvars(cvars, () => { assertActive(); });
    cvars.register("net_ip", "127.0.0.1"); cvars.register("net_port", "0");
    cvars.register("protocol", "68"); cvars.register("cl_maxPing", "800");
    cvars.set("ui_netSource", "3", true); cvars.set("ui_joinGametype", "0", true); ui.update();
    const network = async (): Promise<UnixIo> => {
      const stdin = new PassThrough(), io = new UnixIo(print, new UnixSystemClock(), { stdin, signals: "none" });
      streams.push(stdin); ios.push(io); await io.initializeNetwork(cvars); return io;
    };
    const io = await network(), cls = new ClientStaticState(), loopback = new LoopbackTransport();
    const browser = new ServerBrowser({ io, cvars, clientStatic: cls, loopback, print, assertCurrentOperation: assertActive });
    const commands = graphics.consoleCommands;
    commands.register("localservers", () => { browser.localServers(); });
    commands.registerAsync("globalservers", context => browser.globalServersCommand(context));
    commands.registerAsync("ping", context => browser.pingCommand(context));
    const game = new TeamArenaGameInfo({ menuBuffer: new TeamArenaMenuBuffer(files, print, assertActive),
      sourceParser: new CommonParseState(), memory: new TeamArenaUiMemory("qvm32", print), resources: graphics.resources, print, assertActive });
    infoSlot(game.joinGameTypes, 0).gtEnum = -1;
    const source = (path: string) => files.current.has(path) ? { path, text: new TextDecoder().decode(files.current.readSync(path)) } : undefined;
    const definitions = await loadMenuDefinitions({ resolver: { resolveRoot: source, resolve: request => source(request.requestedPath) }, random: { nextInt: () => 0 } },
      { kind: "ui", setPaths: ["ui/browser-set.txt"] });
    const white = graphics.resources.picture(await graphics.resources.registerShaderNoMip("white")), selections: number[] = [];
    runtime = await UiRuntime.create({ definitions, cvars, commands,
      resources: { handles: { kind: "diagnostic" }, registerFont: unused, registerPicture: unused, registeredPicture: unused, registerSound: unused,
        registeredSound: unused, registerModel: unused, registeredModel: unused, prepareCinematic: unused },
      fonts: { get small() { return unused(); }, get normal() { return unused(); }, get big() { return unused(); }, profile: "ui", smallThreshold: .25, bigThreshold: .4 },
      widgetAssets: { whiteShader: white, gradientBar: white, scrollBar: white, scrollBarArrowDown: white, scrollBarArrowUp: white,
        scrollBarArrowLeft: white, scrollBarArrowRight: white, scrollBarThumb: white, sliderBar: white, sliderThumb: white }, zeroPicture: graphics.resources.picture(null),
      audio: { playLocal: unused, startBackground: unused, stopBackground: unused }, cinematics: { play: unused, run: unused, draw: unused, stop: unused }, paintModel: unused,
      context: { kind: "ui", bindings: { keyName: keynumToString, getBinding: key => graphics.keys.getBinding(key) ?? "",
        setBinding: (key, text) => { graphics.keys.setBinding(key, text); }, getOverstrike: () => graphics.keys.getOverstrike(),
        setOverstrike: enabled => { graphics.keys.setOverstrike(enabled); } }, pause: unused },
      feeder: { count: unused, item: unused, image: unused, select: (id, index) => { if (id !== 2) unused(); selections.push(index); } },
      ownerDraw: { visible: unused, width: unused, value: unused, handleKey: unused, paint: unused, closeCinematic: unused },
      externalScript: { run: unused }, getTeamColor: unused });
    await runtime.activate("browser");
    const display = new TeamArenaServerBrowser({ browser, cvars: ui, gameInfo: game, runtime, commands, calendar, print, assertActive });
    const receive = (event: Awaited<ReturnType<typeof packet>>): void => {
      const decoded = decodeConnectionless(event.payload, "client");
      browser.handleConnectionless(event.from, decoded, event.payload);
    };
    const add = async (name: string, clients: number, maximum: number, gameType: number, gameDir = "missionpack", source = ServerBrowserSource.Favorites) => {
      const peer = await network(), address = socket(peer).address, text = `${address.host.join(".")}:${address.port}`;
      await browser.addServer(source, name, text);
      cls.realtime += 100;
      await commands.executeNowAsync(`ping ${text}`);
      const request = await packet(peer);
      expect(decodeConnectionless(request.payload, "server").line).toBe("getinfo xxx");
      cls.realtime += 9;
      socket(peer).send(request.from, encodeConnectionlessText(`infoResponse\n\\protocol\\68\\hostname\\${name}\\mapname\\mpteam1\\clients\\${clients}\\sv_maxclients\\${maximum}\\gametype\\${gameType}\\game\\${gameDir}`));
      receive(await packet(io)); browser.clearPing(0);
      return peer;
    };
    return { graphics, root, files, prints, cvars, ui, calendar, io, cls, loopback, browser, commands, game, runtime, selections,
      display, network, receive, add, close, retire: () => { active = false; } };
  } catch (error) { close(); throw error; }
}

test("display builder filters real localhost ping results after counting players and resetting the actual feeder", async () => {
  const f = await fixture();
  try {
    await f.add("Zulu", 3, 8, 4); await f.add("Empty", 0, 8, 4); await f.add("Full", 8, 8, 4);
    await f.add("Wrong mode", 2, 8, 0); await f.add("Wrong mod", 1, 8, 4, "baseq3");
    f.cvars.set("ui_browserShowEmpty", "0", true); f.cvars.set("ui_browserShowFull", "0", true); f.ui.update();
    infoSlot(f.game.joinGameTypes, 0).gtEnum = 4; f.display.serverFilterType = 2;
    await f.runtime.setFeederSelection(2, 4); await f.display.buildDisplayList(1, 100);
    expect(f.selections).toEqual([4, 0]);
    expect(f.runtime.snapshot().menus[0]?.items[0]?.cursorPosition).toBe(0);
    expect(f.display.numDisplayServers).toBe(1); expect(f.display.displayServers[0]).toBe(0);
    expect(f.display.numPlayersOnServers).toBe(14);
    expect(Array.from({ length: 5 }, (_, index) => f.browser.serverIsVisible(ServerBrowserSource.Favorites, index))).toEqual([false, false, false, false, false]);
    expect(f.display.motd).toBe("Welcome to Team Arena!"); expect(f.display.motdWidth).toBe(-1);
    f.display.motdWidth = 50; f.cvars.set("cl_motdString", "x".repeat(f.display.motdLen), true);
    await f.display.buildDisplayList(2, 101); expect(f.display.motdWidth).toBe(50); expect(f.selections).toEqual([4, 0]);
    f.cvars.set("cl_motdString", "z".repeat(1100), true); await f.display.buildDisplayList(2, 102);
    expect(f.display.motdLen).toBe(1023); expect(f.display.motdWidth).toBe(-1);
    f.browser.resetPings(ServerBrowserSource.Favorites); f.browser.markServerVisible(ServerBrowserSource.Favorites, 0, true);
    await f.display.buildDisplayList(2, 103); await f.display.buildDisplayList(2, 104);
    expect(f.display.numDisplayServers).toBe(1); expect(f.display.numPlayersOnServers).toBe(20);
    expect(f.browser.serverIsVisible(ServerBrowserSource.Favorites, 0)).toBe(true);
  } finally { f.close(); }
});

test("unpinged favorites are replaced without duplication; QVM sort preserves its non-stable equal order", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 7; i++) await f.browser.addServer(ServerBrowserSource.Favorites, "Same", `127.0.0.1:${29000 + i}`);
    await f.display.buildDisplayList(1, 100);
    expect(f.display.numDisplayServers).toBe(7);
    const first = [...f.display.displayServers.slice(0, 7)];
    await f.display.buildDisplayList(2, 101); expect(f.display.numDisplayServers).toBe(7);
    expect(new Set(f.display.displayServers.slice(0, 7)).size).toBe(7);
    f.display.displayServers.set([0, 1, 2, 3, 4, 5, 6]);
    f.display.sort(0, false); expect([...f.display.displayServers.slice(0, 7)]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    f.display.sort(0, true); expect([...f.display.displayServers.slice(0, 7)]).toEqual([3, 1, 2, 0, 4, 5, 6]);
    expect(first).toEqual([1, 3, 5, 6, 4, 2, 0]);
    f.display.remove(0); expect(f.display.numDisplayServers).toBe(6);
    expect(f.display.displayServers[6]).toBe(6); // Removed row's final source slot remains intact.
    f.display.numDisplayServers = 2047;
    expect(() => f.display.insert(100, 0)).toThrow("write outside 2048-entry source array at 2048");
    expect(f.display.numDisplayServers).toBe(2048);
  } finally { f.close(); }
});

test("favorites refresh uses real visible pings and source final-build/stop timing", async () => {
  const f = await fixture();
  try {
    const peer = await f.add("Live", 3, 8, 4);
    const trace: string[] = [], set = f.cvars.set.bind(f.cvars), mark = f.browser.markServerVisible.bind(f.browser), reset = f.browser.resetPings.bind(f.browser);
    f.cvars.set = (name, value, force) => { trace.push(name); return set(name, value, force); };
    f.browser.markServerVisible = (source, index, visible) => { trace.push(`mark:${index}:${visible}`); mark(source, index, visible); };
    f.browser.resetPings = source => { trace.push("reset"); reset(source); };
    await f.display.startRefresh(true, 1000);
    expect(trace).toEqual(["ui_lastServerRefresh_3", "mark:-1:true", "reset"]);
    expect(f.cvars.get("ui_lastServerRefresh_3")?.value).toBe("Jan-2, 2026 at 3:4");
    expect([f.display.refreshtime, f.display.nextDisplayRefresh]).toEqual([6000, 2000]);
    f.cls.realtime = 1000; await f.display.doRefresh(1000);
    const request = await packet(peer);
    f.cls.realtime = 1012;
    socket(peer).send(request.from, encodeConnectionlessText("infoResponse\n\\protocol\\68\\hostname\\Live\\clients\\4\\sv_maxclients\\8\\gametype\\4"));
    f.receive(await packet(f.io)); await f.display.doRefresh(1012);
    expect(f.display.numDisplayServers).toBe(0); // nextDisplayRefresh still gates ordinary builds.
    await f.display.doRefresh(1013);
    expect(f.display.refreshActive).toBe(false); expect(f.display.numDisplayServers).toBe(1);
    expect(f.display.numPlayersOnServers).toBe(4); expect(f.display.refreshtime).toBe(1013);
    expect(f.prints).toContain("1 servers listed in browser with 4 players.\n");
    const before = f.display.nextDisplayRefresh;
    await f.display.startRefresh(false, 2147483640);
    expect(f.display.refreshtime).toBe(-2147482656); expect(f.display.nextDisplayRefresh).toBe(before);
    expect(f.browser.serverIsVisible(ServerBrowserSource.Favorites, 0)).toBe(false);
    expect(f.browser.getServerPing(ServerBrowserSource.Favorites, 0)).toBe(-1);
  } finally { f.close(); }
});

test("binary insertion and large QVM median partitions sort the actual engine host records", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 48; i++) {
      const rank = (i * 13) % 48;
      await f.browser.addServer(ServerBrowserSource.Favorites, `Host${String(rank).padStart(2, "0")}`, `127.0.0.1:${29000 + i}`);
    }
    await f.display.buildDisplayList(1, 1);
    const ascending = Array.from({ length: 48 }, (_, rank) => (rank * 37) % 48);
    expect([...f.display.displayServers.slice(0, 48)]).toEqual(ascending);
    f.display.sortDir = 1; f.display.sort(0, true);
    expect([...f.display.displayServers.slice(0, 48)]).toEqual(ascending.slice().reverse());
    f.display.sortDir = 0; f.display.sort(0, true);
    expect([...f.display.displayServers.slice(0, 48)]).toEqual(ascending);
  } finally { f.close(); }
});

test("global/Mplayer EXEC_NOW awaits the real command and directs all test traffic to localhost", async () => {
  const f = await fixture();
  try {
    const peer = await f.network(), destination = socket(peer).address;
    const resolve = f.io.resolveAddress.bind(f.io), udp = socket(f.io), send = udp.send.bind(udp);
    const requests: string[] = [];
    f.io.resolveAddress = async (host, port) => {
      expect(host).toBe("master.quake3arena.com"); expect(port).toBe(27950);
      await Promise.resolve(); return destination;
    };
    udp.send = (to, bytes) => { expect(to.port).toBe(27950); requests.push(decodeConnectionless(bytes, "server").line); return send(destination, bytes); };
    try {
      f.cvars.set("ui_netSource", "1", true); f.cvars.set("debug_protocol", "77", true); f.ui.update();
      await f.display.startRefresh(true, 50); await packet(peer);
      expect(f.browser.getServerCount(ServerBrowserSource.Mplayer)).toBe(-1);
      expect(f.browser.getServerCount(ServerBrowserSource.Global)).toBe(0);
      await f.display.doRefresh(5049); expect(f.display.refreshActive).toBe(true);
      await f.display.buildDisplayList(2, 100); expect(f.display.nextDisplayRefresh).toBe(600);
      f.cvars.set("ui_netSource", "2", true); f.cvars.set("debug_protocol", "", true); f.cvars.set("protocol", "68.9", true); f.ui.update();
      await f.display.startRefresh(true, 200); await packet(peer);
      expect(f.browser.getServerCount(ServerBrowserSource.Global)).toBe(-1);
      expect(requests).toEqual(["getservers 77 full empty", "getservers 68 full empty"]);
      expect(f.display.refreshtime).toBe(5200);
    } finally { f.io.resolveAddress = resolve; udp.send = send; }
  } finally { f.close(); }
});

test("local empty discovery waits and source stop reporting observes prefiltered counts and retirement", async () => {
  const f = await fixture();
  try {
    const peer = await f.network(), udp = socket(f.io), send = udp.send.bind(udp);
    let broadcasts = 0;
    udp.send = (_to, bytes) => { broadcasts++; return send(socket(peer).address, bytes); };
    f.cvars.set("ui_netSource", "0", true); f.ui.update();
    try { await f.display.startRefresh(true, 100); } finally { udp.send = send; }
    expect(broadcasts).toBe(8); for (let i = 0; i < 8; i++) await packet(peer);
    expect(f.display.refreshtime).toBe(1100);
    await f.display.doRefresh(1099); expect(f.display.refreshActive).toBe(true);
    await f.display.doRefresh(1100); expect(f.display.nextDisplayRefresh).toBe(0 + 1100); // Equal deadline gates ordinary build.
    await f.display.doRefresh(1101); expect(f.display.nextDisplayRefresh).toBe(1601); expect(f.display.refreshActive).toBe(true);
    f.cvars.set("ui_netSource", "3", true); f.ui.update();
    await f.browser.addServer(ServerBrowserSource.Favorites, "Pending", "127.0.0.1:29999");
    f.display.numPlayersOnServers = 9; f.cvars.set("cl_maxPing", "99.9", true);
    f.display.stopRefresh();
    expect(f.prints.slice(-2)).toEqual(["0 servers listed in browser with 9 players.\n", "1 servers not listed due to packet loss or pings higher than 99\n"]);
    f.display.refreshActive = true;
    const getCount = f.browser.getServerCount.bind(f.browser); let countReads = 0;
    f.browser.getServerCount = source => { countReads++; return getCount(source); };
    // A reached calendar callback can retire the owner before the first cvar publication.
    const calendar = f.calendar.localCalendar.bind(f.calendar);
    f.calendar.localCalendar = () => { const value = calendar(); f.retire(); return value; };
    await expect(f.display.startRefresh(false, 1)).rejects.toThrow("retired Team Arena browser");
    expect(countReads).toBe(0);
  } finally { f.close(); }
});
