import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { CommonParseState } from "../src/core/common-parse.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
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
import { TeamArenaGameInfo, TeamArenaMenuBuffer } from "../src/ui/team-arena/game-info.ts";
import { TeamArenaUiMemory } from "../src/ui/team-arena/memory.ts";
import { TeamArenaServerBrowser } from "../src/ui/team-arena/server-browser.ts";
import { TeamArenaServerStatus, TeamArenaServerStatusInfo } from "../src/ui/team-arena/server-status.ts";
import { baseFixture } from "./base-ui-fixture.ts";

function unused(): never { throw new Error("Status fixture does not exercise media, painting or product feeder data"); }
function socket(io: UnixIo) { if (io.udp === null) throw new Error("Missing actual UDP socket"); return io.udp; }
async function packet(io: UnixIo) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    io.pollPacketEvent(); const event = io.takeQueuedEvent();
    if (event !== null) { if (event.kind !== "packet") throw new Error("Expected actual UDP event"); return event; }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for localhost status packet");
}

async function fixture() {
  const graphics = await baseFixture(), root = mkdtempSync(join(tmpdir(), "q3-team-status-"));
  const prints: string[] = [], sound = new SoundOutput(), ios: UnixIo[] = [], streams: PassThrough[] = [];
  const print = (text: string): undefined => { prints.push(text); };
  let active = true, runtime: UiRuntime | null = null, time = 100, clockReads = 0;
  const assertActive = (): void => { if (!active) throw new Error("retired Team Arena status"); };
  const clock = new CommonEvents({ getEvent: () => { clockReads++; return { kind: "none", time }; } }, print);
  const files = new CommonFileState({ dataPath: root, homePath: join(root, "home"), cdPath: null, product: "missionpack" }, print, sound, graphics.cvars);
  const close = (): void => {
    runtime?.dispose(); files.close(); sound.close();
    for (const io of ios) io.close(); for (const stream of streams) stream.destroy();
    graphics.close(); rmSync(root, { recursive: true, force: true });
  };
  try {
    mkdirSync(join(root, "baseq3")); mkdirSync(join(root, "missionpack"));
    writeFileSync(join(root, "baseq3/default.cfg"), "fixture\n");
    await files.initialize({ checksumFeed: 0, random: () => 0 }, assertActive);
    const cvars = graphics.cvars, ui = new TeamArenaUiCvars(cvars, () => { assertActive(); });
    cvars.register("cl_serverStatusResendTime", "750"); cvars.set("ui_netSource", "3", true); ui.update();
    const network = async (): Promise<UnixIo> => {
      const settings = new CvarRegistry(); settings.register("net_ip", "127.0.0.1"); settings.register("net_port", "0");
      const stdin = new PassThrough(), io = new UnixIo(print, new UnixSystemClock(), { stdin, signals: "none" });
      streams.push(stdin); ios.push(io); await io.initializeNetwork(settings); return io;
    };
    const io = await network(), loopback = new LoopbackTransport(), cls = new ClientStaticState();
    const browser = new ServerBrowser({ io, cvars, clientStatic: cls, loopback, print, assertCurrentOperation: assertActive });
    const source = { path: "ui/status-fixture.menu", text: 'menuDef { name status rect 0 0 640 480 visible 0 itemDef { name rows type 6 feeder 13 rect 0 0 200 100 visible 1 } }' };
    const set = { path: "ui/set.txt", text: '{ loadMenu { "ui/status-fixture.menu" } }' };
    const resolve = (path: string) => path === set.path ? set : path === source.path ? source : undefined;
    const definitions = await loadMenuDefinitions({ resolver: { resolveRoot: resolve, resolve: request => resolve(request.requestedPath) }, random: { nextInt: () => 0 } },
      { kind: "ui", setPaths: [set.path] });
    const white = graphics.resources.picture(await graphics.resources.registerShaderNoMip("white")), selections: number[] = [];
    runtime = await UiRuntime.create({ definitions, cvars, commands: graphics.consoleCommands,
      resources: { handles: { kind: "diagnostic" }, registerFont: unused, registerPicture: unused, registeredPicture: unused, registerSound: unused,
        registeredSound: unused, registerModel: unused, registeredModel: unused, prepareCinematic: unused },
      fonts: { get small() { return unused(); }, get normal() { return unused(); }, get big() { return unused(); }, profile: "ui", smallThreshold: .25, bigThreshold: .4 },
      widgetAssets: { whiteShader: white, gradientBar: white, scrollBar: white, scrollBarArrowDown: white, scrollBarArrowUp: white,
        scrollBarArrowLeft: white, scrollBarArrowRight: white, scrollBarThumb: white, sliderBar: white, sliderThumb: white }, zeroPicture: graphics.resources.picture(null),
      audio: { playLocal: unused, startBackground: unused, stopBackground: unused }, cinematics: { play: unused, run: unused, draw: unused, stop: unused }, paintModel: unused,
      context: { kind: "ui", bindings: { keyName: keynumToString, getBinding: key => graphics.keys.getBinding(key) ?? "",
        setBinding: (key, text) => { graphics.keys.setBinding(key, text); }, getOverstrike: () => graphics.keys.getOverstrike(),
        setOverstrike: enabled => { graphics.keys.setOverstrike(enabled); } }, pause: unused },
      feeder: { count: unused, item: unused, image: unused, select: (id, index) => { if (id !== 13) unused(); selections.push(index); } },
      ownerDraw: { visible: unused, width: unused, value: unused, handleKey: unused, paint: unused, closeCinematic: unused }, externalScript: { run: unused }, getTeamColor: unused });
    await runtime.activate("status");
    const game = new TeamArenaGameInfo({ menuBuffer: new TeamArenaMenuBuffer(files, print, assertActive), sourceParser: new CommonParseState(),
      memory: new TeamArenaUiMemory("qvm32", print), resources: graphics.resources, print, assertActive });
    const display = new TeamArenaServerBrowser({ browser, cvars: ui, gameInfo: game, runtime, commands: graphics.consoleCommands,
      calendar: new UnixSystemClock(), print, assertActive });
    const status = new TeamArenaServerStatus({ browser, cvars: ui, display, runtime, clock, print, assertActive });
    const peer = async (name = "Server") => {
      const remote = await network(), address = socket(remote).address, text = `${address.host.join(".")}:${address.port}`;
      await browser.addServer(ServerBrowserSource.Favorites, name, text);
      display.displayServers[display.numDisplayServers] = display.numDisplayServers; display.numDisplayServers++;
      return { io: remote, address: text };
    };
    const reply = async (remote: UnixIo, text: string): Promise<void> => {
      const request = await packet(remote); expect(decodeConnectionless(request.payload, "server").line).toBe("getstatus");
      socket(remote).send(request.from, encodeConnectionlessText(`statusResponse\n${text}`));
      const response = await packet(io), decoded = decodeConnectionless(response.payload, "client");
      browser.serverStatusResponse(response.from, decoded.payload, clock);
    };
    const localReply = (text: string): void => {
      const request = loopback.poll("server"); if (request === null) throw new Error("Expected real loopback status request");
      expect(decodeConnectionless(request.payload, "server").line).toBe("getstatus");
      loopback.send("server", encodeConnectionlessText(`statusResponse\n${text}`));
      const response = loopback.poll("client"); if (response === null) throw new Error("Expected real loopback status response");
      browser.serverStatusResponse(response.from, decodeConnectionless(response.payload, "client").payload, clock);
    };
    return { graphics, cvars, ui, runtime, browser, display, status, clock, loopback, io, prints, selections, peer, reply, localReply,
      setTime: (value: number) => { time = value; }, clockReads: () => clockReads, retire: () => { active = false; }, close };
  } catch (error) { close(); throw error; }
}

function rows(info: TeamArenaServerStatusInfo) {
  return Array.from({ length: info.numLines }, (_, row) => [0, 1, 2, 3].map(column => info.column(row, column)));
}

test("server status parses actual loopback replies, sorts cvars and retains source player columns", async () => {
  const f = await fixture();
  try {
    f.display.numDisplayServers = 1; f.display.currentServer = 1; // Source allows equality here.
    f.status.serverStatusAddress = "localhost";
    await f.runtime.setFeederSelection(13, 5);
    await f.status.buildServerStatus(true, 100);
    expect(f.selections).toEqual([5, 0]); expect(f.status.nextServerStatusRefresh).toBe(600);
    expect(f.status.serverStatusInfo.numLines).toBe(0);
    f.localReply('\\mapname\\mpteam1\\sv_hostname\\Example\\g_gametype\\4\\gamename\\missionpack\\other\\value\n5 12 "^1Alice"\n-2 99 Bob\n');
    await f.status.buildServerStatus(false, 599); expect(f.status.serverStatusInfo.numLines).toBe(0);
    await f.status.buildServerStatus(false, 600);
    expect(rows(f.status.serverStatusInfo)).toEqual([
      ["Name", "", "", "Example"], ["Address", "", "", "localhost"], ["Game name", "", "", "missionpack"],
      ["Game type", "", "", "4"], ["Map", "", "", "mpteam1"], ["other", "", "", "value"],
      ["", "", "", ""], ["num", "score", "ping", "name"], ["0", "5", "12", '"^1Alice"'], ["1", "-2", "99", "Bob"],
    ]);
    expect(f.status.nextServerStatusRefresh).toBe(0);
    expect(f.status.serverStatusInfo.pings.slice(0, 4)).toEqual(new Uint8Array([48, 0, 49, 0]));
    expect(f.loopback.poll("server")).toBeNull();
    f.status.nextFindPlayerRefresh = 1;
    await f.status.buildServerStatus(true, 700); expect(f.selections).toEqual([5, 0]);
    f.status.nextFindPlayerRefresh = 0;
    f.status.serverStatusAddress = (await f.peer()).address;
    await f.status.buildServerStatus(true, 2147483640);
    expect(f.status.nextServerStatusRefresh).toBe(-2147483156);
  } finally { f.close(); }
});

test("status partial parsing and the 192-byte player-number buffer retain reached mutations", async () => {
  const f = await fixture();
  try {
    await f.status.getServerStatusInfo(null, null);
    const partial = new TeamArenaServerStatusInfo();
    expect(await f.status.getServerStatusInfo("localhost", partial)).toBe(false);
    f.localReply('\\dangling\n');
    expect(await f.status.getServerStatusInfo("localhost", partial)).toBe(true);
    expect(rows(partial)).toEqual([["Address", "", "", "localhost"], ["dangling", "", "", ""], ["", "", "", ""], ["num", "score", "ping", "name"]]);
    const remote = await f.peer();
    await f.status.getServerStatusInfo(remote.address, partial);
    await f.reply(remote.io, `\\x\\y\n${Array.from({ length: 70 }, () => "0 0 a").join("\n")}\n`);
    await expect(f.status.getServerStatusInfo(remote.address, partial)).rejects.toThrow("Q_strncpyz: destsize < 1");
    expect(f.prints.slice(-2)).toEqual(["Com_sprintf: overflow of 2 in 1\n", "Com_sprintf: overflow of 2 in 0\n"]);
    expect(partial.numLines).toBe(72); // Address + cvar + blank + header + 68 completed players.
    expect(partial.column(71, 0)).toBe(""); expect(partial.column(71, 3)).toBe("a");
  } finally { f.close(); }
});

test("status text truncation and the 128-line limit preserve unterminated value aliases", async () => {
  const f = await fixture();
  try {
    const info = new TeamArenaServerStatusInfo();
    await f.status.getServerStatusInfo(null, null);
    await f.status.getServerStatusInfo("localhost", info);
    f.localReply(`${"\\k\\v".repeat(127)}\n`);
    expect(await f.status.getServerStatusInfo("localhost", info)).toBe(true);
    expect(info.numLines).toBe(128); expect(info.column(126, 3)).toBe("v");
    expect(info.column(127, 3)).toBe("v\\\\"); // The limit is checked before terminating this value.
    const remote = await f.peer();
    await f.status.getServerStatusInfo(remote.address, info);
    await f.reply(remote.io, `\\x\\${"v".repeat(1200)}\n`);
    expect(await f.status.getServerStatusInfo(remote.address, info)).toBe(true);
    expect(info.numLines).toBe(4); expect(info.column(1, 3)).toBe("v".repeat(1020));
    expect(info.text[1023]).toBe(0);
  } finally { f.close(); }
});

test("find-player polling keeps duplicate hits, cleans names and builds selected status through actual owners", async () => {
  const f = await fixture();
  try {
    const remote = await f.peer("The server");
    f.cvars.set("ui_findPlayer", "^2aLiCe\x19", true); f.ui.writeInteger("ui_serverStatusTimeOut", 100);
    await f.status.buildFindPlayerList(true, 100);
    expect(f.status.findPlayerName).toBe("aLiCe"); expect(f.cvars.get("cl_serverStatusResendTime")?.value).toBe("50");
    expect(f.status.pendingServerStatus.num).toBe(1); expect(f.status.nextFindPlayerRefresh).toBe(125);
    expect(f.status.foundPlayerServerNames[0]).toBe("searching 1/0..."); expect(f.clockReads()).toBe(0);
    await f.status.buildFindPlayerList(false, 124); expect(f.clockReads()).toBe(0);
    f.setTime(125); await f.status.buildFindPlayerList(false, 125);
    await f.reply(remote.io, '\\sv_hostname\\The server\n1 2 "^1Alice"\n3 4 MALICE\n');
    f.setTime(150); await f.status.buildFindPlayerList(false, 150);
    expect(f.status.numFoundPlayerServers).toBe(3);
    expect(f.status.foundPlayerServerAddresses.slice(0, 2)).toEqual([remote.address, remote.address]);
    expect(f.status.foundPlayerServerNames.slice(0, 3)).toEqual(["The server", "The server", "2 servers found with player aLiCe"]);
    expect(f.status.nextFindPlayerRefresh).toBe(0); expect(f.status.serverStatusAddress).toBe(remote.address);
    expect(f.selections).toEqual([0, 0]); // Completion selection and forced status build each reset the real feeder.
    expect(f.status.nextServerStatusRefresh).toBe(650);
    await f.reply(remote.io, '\\sv_hostname\\Selected\n1 2 Alice\n');
    f.setTime(650); await f.status.buildServerStatus(false, 650);
    expect(f.status.serverStatusInfo.column(0, 3)).toBe("Selected");
    expect(f.status.nextServerStatusRefresh).toBe(0);
  } finally { f.close(); }
});

test("find-player header matching and source cap retain fourteen hits plus the summary", async () => {
  const f = await fixture();
  try {
    const remote = await f.peer("Header server"); f.cvars.set("ui_findPlayer", "name", true);
    await f.status.buildFindPlayerList(true, 100); f.setTime(125); await f.status.buildFindPlayerList(false, 125);
    await f.reply(remote.io, `\\sv_hostname\\Header server\n${Array.from({ length: 20 }, () => "0 1 name").join("\n")}\n`);
    f.setTime(150); await f.status.buildFindPlayerList(false, 150);
    expect(f.status.numFoundPlayerServers).toBe(15);
    expect(f.status.foundPlayerServerNames[14]).toBe("14 servers found with player name");
    expect(f.status.foundPlayerServerAddresses.slice(0, 14)).toEqual(Array.from({ length: 14 }, () => remote.address));
    expect(f.status.pendingServerStatus.num).toBe(1);
    await f.reply(remote.io, '\\sv_hostname\\Header only\n');
    await f.status.buildServerStatus(false, 650);
    // A response with no players still has a header with nonempty ping and name columns.
    f.status.nextServerStatusRefresh = 0;
    await f.status.buildFindPlayerList(true, 700); f.setTime(725); await f.status.buildFindPlayerList(false, 725);
    await f.reply(remote.io, '\\sv_hostname\\Header only\n');
    f.setTime(750); await f.status.buildFindPlayerList(false, 750);
    expect(f.status.numFoundPlayerServers).toBe(2);
    expect(f.status.foundPlayerServerNames[1]).toBe("1 server found with player name");
  } finally { f.close(); }
});

test("find-player uses sixteen pending slots, strict timeout and retained rows after an empty search", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 17; i++) await f.peer(`Server ${i}`);
    f.cvars.set("ui_findPlayer", "Nobody", true); f.ui.writeInteger("ui_serverStatusTimeOut", 100);
    await f.status.buildFindPlayerList(true, 100);
    expect(f.status.pendingServerStatus.num).toBe(16); expect(f.status.pendingServerStatus.server.every(row => row.valid)).toBe(true);
    f.setTime(200); await f.status.buildFindPlayerList(false, 200);
    expect(f.status.pendingServerStatus.num).toBe(16); // Equality is not timed out.
    f.setTime(225); await f.status.buildFindPlayerList(false, 225);
    expect(f.status.pendingServerStatus.num).toBe(17);
    expect(f.status.pendingServerStatus.server.filter(row => row.valid)).toHaveLength(1);
    expect(f.status.pendingServerStatus.server[0]?.startTime).toBe(225);
    f.setTime(350); await f.status.buildFindPlayerList(false, 350);
    expect(f.status.nextFindPlayerRefresh).toBe(0); expect(f.status.foundPlayerServerNames[0]).toBe("0 servers found with player Nobody");
    const reads = f.clockReads(); f.cvars.set("ui_findPlayer", "^1\x19", true);
    await f.status.buildFindPlayerList(true, 400);
    expect(f.status.numFoundPlayerServers).toBe(0); expect(f.status.findPlayerName).toBe("");
    expect(f.status.foundPlayerServerNames[0]).toBe("0 servers found with player Nobody"); expect(f.clockReads()).toBe(reads);
    expect(f.status.pendingServerStatus.server.every(row => !row.valid && row.adrstr === "")).toBe(true);
  } finally { f.close(); }
});

test("status force resets before invalid selection checks and retirement stops async publication", async () => {
  const f = await fixture();
  try {
    f.display.currentServer = -1; f.status.serverStatusInfo.numLines = 5;
    await f.status.buildServerStatus(true, 100);
    expect(f.selections).toEqual([0]); expect(f.status.serverStatusInfo.numLines).toBe(0); expect(f.status.nextServerStatusRefresh).toBe(0);
    const remote = await f.peer(); f.display.currentServer = 0; f.status.serverStatusAddress = remote.address;
    const read = f.browser.serverStatus.bind(f.browser);
    f.browser.serverStatus = async (address, size, clock) => { const result = await read(address, size, clock); if (size !== null) f.retire(); return result; };
    await expect(f.status.buildServerStatus(true, 2147483640)).rejects.toThrow("retired Team Arena status");
    expect(f.status.nextServerStatusRefresh).toBe(0); expect(f.status.serverStatusInfo.numLines).toBe(0);
  } finally { f.close(); }
});
