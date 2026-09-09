import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import { CommonError } from "../src/core/common-error.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { KeyCode } from "../src/core/key-codes.ts";
import { ClientAdmission } from "../src/engine/client-admission.ts";
import { ClientAuthorization } from "../src/engine/client-authorization.ts";
import { CommonCdKeyState } from "../src/engine/cd-key.ts";
import { ClientStaticState, ClientConnectionState } from "../src/engine/client-state.ts";
import type { ClientPacketAddress } from "../src/engine/client-state.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { ServerBrowser, ServerBrowserSource } from "../src/engine/server-browser.ts";
import { ServerEngine } from "../src/engine/server-engine.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { encodeConnectionlessText, decodeConnectionless } from "../src/protocol/connectionless.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { BaseArenaServersMenu } from "../src/ui/base/arena-servers.ts";
import { BaseConfirmMenu } from "../src/ui/base/confirm.ts";
import { BaseUiGameInfo } from "../src/ui/base/game-info.ts";
import { BaseStartServerMenu } from "../src/ui/base/start-server.ts";
import { BaseSpecifyServerMenu } from "../src/ui/base/specify-server.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { popMenu, setCursorToItem } from "../src/ui/base/framework.ts";
import { itemAt, MenuEvent, MenuFlag } from "../src/ui/base/state.ts";
import type { BaseMenu, BaseMenuItem, MenuScroll, MenuSpin } from "../src/ui/base/state.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { const failures: unknown[] = []; for (const close of cleanup.splice(0).reverse()) try { await close(); } catch (error) { failures.push(error); } if (failures.length) throw new AggregateError(failures); });
const art = ["back_0", "back_1", "create_0", "create_1", "specify_0", "specify_1", "refresh_0", "refresh_1", "fight_0", "fight_1", "arrows_vert_0", "arrows_vert_top", "arrows_vert_bot", "unknownmap", "pblogo"].map(name => `menu/art/${name}`);
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(networkProfile: "udp" | "inert" = "udp") {
  const ui = await baseFixture(); cleanup.push(() => { ui.close(); ui.assets.files.close(); });
  const sound = new SoundOutput(); cleanup.push(() => sound.close());
  const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  const files = new CommonFileState({ dataPath, homePath: dataPath, cdPath: null, product: "baseq3" }, text => { ui.prints.push(text); }, sound, ui.cvars);
  cleanup.push(() => files.close()); await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
  const game = new BaseUiGameInfo(ui.state, files); game.initialize();
  const io = await network(ui, networkProfile), cls = new ClientStaticState(), clc = new ClientConnectionState(), loopback = new LoopbackTransport();
  const options = { io, clientStatic: cls, clientConnection: clc, loopback, cvars: ui.cvars, print: (text: string) => { ui.prints.push(text); }, assertCurrentOperation: () => ui.state.assertActive() };
  const authorization = new ClientAuthorization({ ...options, cdKey: new CommonCdKeyState(ui.cvars, "client") });
  const browser = new ServerBrowser(options), admission = new ClientAdmission({ ...options, authorization }), start = new BaseStartServerMenu(ui.state, game);
  ui.cvars.register("cl_maxPing", "800"); ui.cvars.register("protocol", "68"); ui.cvars.register("developer", "0"); ui.cvars.register("showpackets", "0");
  ui.consoleCommands.register("localservers", () => { browser.localServers(); });
  ui.consoleCommands.registerAsync("globalservers", context => browser.globalServersCommand(context));
  ui.consoleCommands.registerAsync("ping", context => browser.pingCommand(context));
  const appended: string[] = [], append = ui.consoleCommands.append.bind(ui.consoleCommands);
  ui.consoleCommands.append = text => { appended.push(text); append(text); };
  const receive = (from: ClientPacketAddress, bytes: Uint8Array): boolean => {
    const result = admission.packetEvent(from, bytes); if (result.kind !== "connectionless") throw new Error("Expected actual unhandled connectionless packet");
    return browser.handleConnectionless(from, result.packet, bytes);
  };
  await cacheMenu(ui.state);
  const specify = new BaseSpecifyServerMenu(ui.state), confirm = new BaseConfirmMenu(ui.state);
  return { ...ui, files, start, specify, confirm, io, cls, loopback, browser, receive, appended, owner: new BaseArenaServersMenu(ui.state, browser, ui.consoleCommands, start, specify, confirm) };
}
async function network(f: Awaited<ReturnType<typeof baseFixture>>, profile: "udp" | "inert" = "udp"): Promise<UnixIo> {
  const stdin = new PassThrough(), io = new UnixIo(() => undefined, new UnixSystemClock(), { stdin, signals: "none" });
  cleanup.push(() => { try { io.close(); } finally { stdin.destroy(); } });
  if (profile === "udp") {
    f.cvars.set("net_ip", "127.0.0.1", true); f.cvars.set("net_port", "0", true); await io.initializeNetwork(f.cvars);
  }
  return io;
}
function socket(io: UnixIo) { const udp = io.udp; if (udp === null) throw new Error("Expected actual localhost UDP socket"); return udp; }
function address(io: UnixIo): string { const value = socket(io).address; return `${value.host.join(".")}:${value.port}`; }
async function packet(io: UnixIo) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) { io.pollPacketEvent(); const event = io.takeQueuedEvent(); if (event !== null) { if (event.kind !== "packet") throw new Error("Expected packet event"); return event; } await Bun.sleep(1); }
  throw new Error("Localhost UDP packet did not arrive");
}
function item(menu: BaseMenu, id: number): BaseMenuItem { const found = menu.items.find(value => value.common.id === id); if (found === undefined) throw new Error(`Missing item ${id}`); return found; }
function spin(menu: BaseMenu, id: number): MenuSpin { const value = item(menu, id); if (value.kind !== "spin") throw new Error("Expected spin"); return value; }
function list(f: Fixture): MenuScroll { const value = item(f.owner.menu, 15); if (value.kind !== "scroll") throw new Error("Expected server list"); return value; }
function status(f: Fixture): string | null { const value = f.owner.menu.items.find(value => value.kind === "text" && value.common.y === 376); if (value === undefined || value.kind !== "text") throw new Error("Expected status"); return value.text; }
async function activate(value: BaseMenuItem, event = MenuEvent.Activated): Promise<void> { const callback = value.common.callback; if (callback === null) throw new Error("Expected actual callback"); await callback(value, event); }
async function press(f: Fixture, key: number): Promise<void> { await f.keys.keyEvent(key, true, 10); await f.keys.keyEvent(key, false, 11); }
async function draw(f: Fixture, time: number): Promise<void> {
  f.cls.realtime = time; f.state.realtime = time; const callback = f.owner.menu.draw; if (callback === null) throw new Error("Expected owner draw");
  await callback(); f.commands.submit();
}
function favorites(f: Fixture, addresses: readonly string[]): void {
  f.cvars.set("ui_browserMaster", "3", true); for (const [index, value] of addresses.entries()) f.cvars.set(`server${index + 1}`, value, true); f.state.services.cvars.update();
}
function info(text: string): Uint8Array { return new Uint8Array([...encodeConnectionlessText("infoResponse\n"), ...Buffer.from(`\\protocol\\68${text}`, "latin1"), 0]); }
async function reply(f: Fixture, peer: UnixIo, text: string, time: number): Promise<void> {
  f.cls.realtime = time; socket(peer).send(socket(f.io).address, info(text)); const event = await packet(f.io); expect(f.receive(event.from, event.payload)).toBe(true);
}

test("Arena Servers initializes source cache, real controls and append-only local discovery in source order", async () => {
  const f = await fixture("inert"), menu = f.owner.menu, calls: string[] = [], register = f.resources.registerShaderNoMip.bind(f.resources);
  f.resources.registerShaderNoMip = async name => { if (name === null) throw new Error("Authored menu cache requires a shader name"); calls.push(name); expect(menu.itemCount).toBe(0); expect(f.cvars.get("debug_protocol")).toBeUndefined(); return await register(name); };
  await f.owner.show(); f.resources.registerShaderNoMip = register;
  expect(calls).toEqual(art); expect(f.state.activeMenu).toBe(menu); expect(menu.itemCount).toBe(21); expect(menu.wrapAround && menu.fullscreen).toBe(true);
  expect(f.appended).toEqual(["localservers\n"]); expect(f.browser.getPingQueueCount()).toBe(0);
  expect(status(f)).toBe("hit refresh to update"); expect(spin(menu, 10).itemnames).toEqual(["Local", "Internet", "Favorites"]);
  expect([list(f).width, list(f).height, list(f).common.x, list(f).common.y]).toEqual([68, 11, 72, 192]);
  expect(item(menu, 23).common.flags & (MenuFlag.Hidden | MenuFlag.Inactive)).toBe(MenuFlag.Hidden | MenuFlag.Inactive);
  expect(item(menu, 22).common.flags & MenuFlag.Grayed).toBe(MenuFlag.Grayed);
  const records = menu.items.slice(); await press(f, KeyCode.Space); expect(status(f)).toBe("No Servers Found.");
  await f.owner.show(); expect(f.owner.menu).toBe(menu); for (const [i, record] of records.entries()) expect(menu.items[i]).toBe(record);
});

test("Favorites owner draw sends EXEC_NOW ping, receives real UDP through admission, formats and connects", async () => {
  const f = await fixture(), peer = await network(f); favorites(f, [address(peer)]); await f.owner.show();
  expect(f.appended).toEqual([]); await draw(f, 1000);
  expect(decodeConnectionless((await packet(peer)).payload, "server").line).toBe("getinfo xxx");
  expect(f.appended).toEqual([]); expect(status(f)).toBe("1 of 1 Arena Servers.");
  await reply(f, peer, "\\hostname\\^1Alpha\\mapname\\q3dm1\\clients\\2\\sv_maxclients\\8\\gametype\\4\\punkbuster\\1", 1012);
  await draw(f, 1012); expect(f.browser.getPingQueueCount()).toBe(0); expect(list(f).numitems).toBe(1);
  expect(list(f).itemnames[0]).toBe("ALPHA                Q3DM1         2/ 8 CTF      UDP ^2 13 ^3Yes");
  const picture = f.owner.menu.items.find(value => value.kind === "bitmap" && value.common.x === 72);
  expect(picture?.common.name).toBe("levelshots/Q3DM1.tga");
  await activate(item(f.owner.menu, 22)); expect(f.appended).toEqual([`connect ${address(peer)}\n`]);
  await popMenu(f.state); await f.owner.show(); expect(list(f).numitems).toBe(1); expect(f.browser.getPingQueueCount()).toBe(0); expect(status(f)).toBe("hit refresh to update");
});

test("source filters, sort keys, selection resets, protocol game labels and ping colors use actual replies", async () => {
  const f = await fixture(), peers = [await network(f), await network(f), await network(f)]; favorites(f, peers.map(address)); await f.owner.show(); await draw(f, 100);
  for (const peer of peers) await packet(peer);
  await reply(f, itemAt(peers, 0), "\\hostname\\Zulu\\mapname\\q3dm9\\clients\\0\\sv_maxclients\\8\\gametype\\0\\minPing\\90", 120);
  await reply(f, itemAt(peers, 1), "\\hostname\\Alpha\\mapname\\q3dm7\\clients\\4\\sv_maxclients\\4\\gametype\\3\\game\\Custom Game", 320);
  await reply(f, itemAt(peers, 2), "\\hostname\\Beta\\mapname\\q3dm1\\clients\\2\\sv_maxclients\\5\\gametype\\1", 520);
  await draw(f, 530); expect(list(f).numitems).toBe(3);
  expect(itemAt(list(f).itemnames, 0)).toContain("^4 21"); expect(itemAt(list(f).itemnames, 1)).toContain("^3221"); expect(itemAt(list(f).itemnames, 2)).toContain("^1421");
  for (const [sort, order] of [[0, ["ALPHA", "BETA", "ZULU"]], [1, ["BETA", "ALPHA", "ZULU"]], [2, ["ZULU", "BETA", "ALPHA"]], [3, ["ZULU", "BETA", "ALPHA"]]] satisfies readonly (readonly [number, readonly string[]])[]) {
    list(f).curvalue = 2; list(f).top = 1; spin(f.owner.menu, 12).curvalue = sort; await activate(item(f.owner.menu, 12));
    expect(list(f).itemnames.slice(0, 3).map(value => value.split(" ")[0])).toEqual(order); expect([list(f).curvalue, list(f).top]).toEqual([0, 0]);
  }
  const empty = item(f.owner.menu, 14), full = item(f.owner.menu, 13); if (empty.kind !== "radio" || full.kind !== "radio") throw new Error("Expected radio controls");
  empty.curvalue = 0; await activate(empty); expect(list(f).numitems).toBe(2); full.curvalue = 0; await activate(full); expect(list(f).numitems).toBe(1);
  spin(f.owner.menu, 11).curvalue = 4; await activate(item(f.owner.menu, 11)); expect(list(f).numitems).toBe(0); expect(item(f.owner.menu, 22).common.flags & MenuFlag.Grayed).toBe(0);
});

test("favorite timeout floor, early SPACE stop and source four-byte removal preserve cvar address book", async () => {
  const f = await fixture(), addresses = ["127.1.1.1:30001", "127.2.2.2:30002", "127.3.3.3:30003"];
  favorites(f, ["localhost", ...addresses]); f.cvars.set("cl_maxPing", "1", true); await f.owner.show();
  await press(f, KeyCode.Space); expect(list(f).numitems).toBe(3); expect(list(f).itemnames.slice(0, 3).every(value => value.startsWith("NO RESPONSE") && value.includes("^2100"))).toBe(true);
  await setCursorToItem(f.state, f.owner.menu, list(f)); await press(f, KeyCode.Delete); expect(list(f).numitems).toBe(2);
  await press(f, KeyCode.Escape); expect(f.cvars.get("server1")?.value).toBe("127.2.2.1:30001"); expect(f.cvars.get("server2")?.value).toBe(addresses[1]); expect(f.cvars.get("server3")?.value).toBe("");
  const g = await fixture(), peer = await network(g); favorites(g, [address(peer)]); g.cvars.set("cl_maxPing", "100", true); await g.owner.show(); await draw(g, 1000); await packet(peer);
  await draw(g, 1099); expect(g.browser.getPingQueueCount()).toBe(1); await draw(g, 1100); expect(list(g).numitems).toBe(0);
  await draw(g, 1109); expect(list(g).numitems).toBe(1); expect(g.browser.getPingQueueCount()).toBe(0);
  expect(itemAt(list(g).itemnames, 0)).toContain("^2100");
});

test("refresh uses the source short memset and persistent row pointers, not a repaired whole-list clear", async () => {
  const f = await fixture("inert"), addresses = Array.from({ length: 16 }, (_, index) => `127.0.0.1:${30000 + index}`);
  favorites(f, addresses); await f.owner.show(); await press(f, KeyCode.Space); list(f).curvalue = 8;
  await activate(item(f.owner.menu, 19)); expect(list(f).numitems).toBe(0);
  await activate(item(f.owner.menu, 22)); expect(f.appended.at(-1)).toBe("connect \n");
  // UpdateMenu resets curvalue to zero; the retained ninth table pointer still sees its uncleared node.
  list(f).curvalue = 8; await activate(item(f.owner.menu, 22)); expect(f.appended.at(-1)).toBe(`connect ${addresses[8]}\n`);
});

test("Arena source qsort moves equal-key server contents while retaining list row addresses", async () => {
  for (const count of [6, 7, 8, 16]) {
    const f = await fixture("inert"), addresses = Array.from({ length: count }, (_, index) => `127.0.0.1:${30000 + index}`);
    expect(f.io.udp).toBeNull(); favorites(f, addresses); await f.owner.show();
    const key = f.owner.menu.key; if (key === null) throw new Error("Expected Arena menu key handler");
    await key(KeyCode.Space);
    expect(list(f).numitems).toBe(count);
    const expected = addresses.slice(), pivot = count < 7 ? 0 : count === 7 ? 3 : count - 1;
    expected[0] = itemAt(addresses, pivot); expected[pivot] = itemAt(addresses, 0);
    for (let index = 0; index < count; index++) {
      list(f).curvalue = index; await activate(item(f.owner.menu, 22));
      expect(f.appended.at(-1)).toBe(`connect ${itemAt(expected, index)}\n`);
    }
    spin(f.owner.menu, 12).curvalue = 3; await activate(item(f.owner.menu, 12));
    expect([list(f).curvalue, list(f).top]).toEqual([0, 0]);
    for (let index = 0; index < count; index++) {
      list(f).curvalue = index; await activate(item(f.owner.menu, 22));
      expect(f.appended.at(-1)).toBe(`connect ${itemAt(addresses, index)}\n`);
    }
    await activate(item(f.owner.menu, 19)); await activate(item(f.owner.menu, 22));
    expect(f.appended.at(-1)).toBe("connect \n");
  }
});

test("Arena source qsort partitions 48 authored replies through every actual sort control", async () => {
  const f = await fixture("inert"), addresses: ClientPacketAddress[] = Array.from({ length: 48 }, (_, index) =>
    ({ kind: "ipv4", host: [127, 0, 0, 1], port: 30000 + index }));
  const names = addresses.map((_, index) => `127.0.0.1:${30000 + index}`);
  const openSlots = (index: number): number => (index * 7) % 13;
  expect(f.io.udp).toBeNull(); await f.owner.show();
  for (const name of names) await f.browser.addServer(ServerBrowserSource.Local, "pending", name);
  await draw(f, 100); expect(f.browser.getPingQueueCount()).toBe(32);
  const receive = (start: number, end: number, time: number): void => {
    f.cls.realtime = time;
    for (let index = start; index < end; index++) {
      const hostname = String((index * 17) % 48).padStart(2, "0"), map = String(47 - index).padStart(2, "0");
      const clients = index % 9, maximum = clients + openSlots(index);
      expect(f.receive(itemAt(addresses, index), info(`\\hostname\\${hostname}\\mapname\\map${map}\\clients\\${clients}\\sv_maxclients\\${maximum}\\gametype\\${index % 5}`))).toBe(true);
    }
  };
  receive(0, 32, 120); await draw(f, 120); expect(f.browser.getPingQueueCount()).toBe(16);
  receive(32, 48, 140); await draw(f, 140); expect(f.browser.getPingQueueCount()).toBe(0); expect(list(f).numitems).toBe(48);
  const selection = async (sort: number): Promise<number[]> => {
    list(f).curvalue = 24; list(f).top = 20; spin(f.owner.menu, 12).curvalue = sort;
    await activate(item(f.owner.menu, 12)); expect([list(f).curvalue, list(f).top]).toEqual([0, 0]);
    const result: number[] = [];
    for (let index = 0; index < 48; index++) {
      list(f).curvalue = index; await activate(item(f.owner.menu, 22));
      const command = f.appended.at(-1), address = command?.slice(8, -1);
      if (address === undefined) throw new Error("Expected source connect command");
      const original = names.indexOf(address); expect(original).toBeGreaterThanOrEqual(0); result.push(original);
    }
    expect(new Set(result).size).toBe(48); return result;
  };
  const hostOrder = Array.from({ length: 48 }, (_, rank) => (rank * 17) % 48);
  expect(await selection(0)).toEqual(hostOrder);
  expect(await selection(1)).toEqual(Array.from({ length: 48 }, (_, index) => 47 - index));
  expect((await selection(2)).map(openSlots)).toEqual(Array.from({ length: 48 }, (_, index) => openSlots(index)).sort((a, b) => b - a));
  expect((await selection(3)).map(index => index % 5)).toEqual(Array.from({ length: 48 }, (_, index) => index % 5).sort((a, b) => a - b));
  expect(await selection(4)).toEqual(hostOrder);
});

test("global/master selection preserves query append order, protocol override, hidden Mplayer mapping and five-second wait", async () => {
  const f = await fixture(); f.cvars.set("ui_browserMaster", "2", true); f.cvars.set("ui_browserGameType", "2", true); f.cvars.set("debug_protocol", "71", true); f.state.services.cvars.update();
  await f.owner.show(); expect(f.appended).toEqual(["globalservers 0 71 team empty full\n"]);
  const peer = await network(f), resolve = f.io.resolveAddress.bind(f.io), udp = socket(f.io), send = udp.send.bind(udp);
  f.io.resolveAddress = async (host, port) => { expect(host).toBe("master.quake3arena.com"); expect(port).toBe(27950); return socket(peer).address; };
  udp.send = (to, bytes) => { expect(to.port).toBe(27950); return send(socket(peer).address, bytes); };
  try { await f.consoleCommands.executeAsync(); } finally { f.io.resolveAddress = resolve; udp.send = send; }
  expect(decodeConnectionless((await packet(peer)).payload, "server").line).toBe("getservers 71 team empty full");
  await draw(f, 4999); expect(status(f)).toBe("hit refresh to update"); await draw(f, 5000); expect(status(f)).toBe("No Response From Master Server.");
  spin(f.owner.menu, 10).curvalue = 2; await activate(item(f.owner.menu, 10)); expect(f.cvars.get("ui_browserMaster")?.value).toBe("3"); expect(item(f.owner.menu, 23).common.flags & MenuFlag.Hidden).toBe(0);
  await press(f, KeyCode.Space); f.cvars.set("ui_browserMaster", "1", true); f.state.services.cvars.update(); await f.owner.show();
  expect(spin(f.owner.menu, 10).curvalue).toBe(0); expect(f.appended.at(-1)).toBe("globalservers 1 71 team empty full\n");
});

test("source local discovery broadcast destinations are observed but every datagram stays on localhost", async () => {
  const f = await fixture(), peer = await network(f); await f.owner.show(); const udp = socket(f.io), send = udp.send.bind(udp), destinations: number[] = [];
  udp.send = (to, bytes) => { expect(to.host).toEqual([255, 255, 255, 255]); destinations.push(to.port); return send(socket(peer).address, bytes); };
  try { await f.consoleCommands.executeAsync(); } finally { udp.send = send; }
  expect(destinations).toEqual([27960, 27961, 27962, 27963, 27960, 27961, 27962, 27963]);
  for (let i = 0; i < 8; i++) expect(decodeConnectionless((await packet(peer)).payload, "server").line).toBe("getinfo xxx");
  await reply(f, peer, "\\hostname\\Local\\mapname\\q3dm1", 2); expect(f.browser.getServerCount(ServerBrowserSource.Local)).toBe(1);
  await draw(f, 10); await packet(peer); await reply(f, peer, "\\hostname\\Local\\mapname\\q3dm1\\clients\\1\\sv_maxclients\\8", 20);
  await draw(f, 20); expect(list(f).numitems).toBe(1); expect(itemAt(list(f).itemnames, 0)).toContain("LOCAL");
});

test("real Specify, Start Server, and Punkbuster confirmations preserve menu stack and source no-op", async () => {
  const f = await fixture(); favorites(f, []); await f.owner.show(); await press(f, KeyCode.Space);
  await activate(item(f.owner.menu, 20)); expect(f.state.activeMenu).toBe(f.specify.menu); expect(f.state.activeMenu?.items.some(value => value.kind === "banner" && value.text === "SPECIFY SERVER")).toBe(true); await press(f, KeyCode.Escape);
  await activate(item(f.owner.menu, 21)); expect(f.state.activeMenu).toBe(f.start.menu); await press(f, KeyCode.Escape); expect(f.state.activeMenu).toBe(f.owner.menu);
  const pb = spin(f.owner.menu, 24); pb.curvalue = 1; await activate(pb); expect(f.state.activeMenu).toBe(f.confirm.menu); expect(f.state.menuDepth).toBe(2); await press(f, 121);
  expect(pb.curvalue).toBe(0); expect(f.cvars.get("cl_punkbuster")).toBeUndefined(); expect(f.state.activeMenu).toBe(f.owner.menu);
  f.cvars.set("cl_punkbuster", "1", true); pb.curvalue = 0; await activate(pb); await press(f, 110); expect(pb.curvalue).toBe(1); expect(f.state.activeMenu).toBe(f.owner.menu);
  pb.curvalue = 0; await activate(pb); await press(f, 121); expect(f.state.activeMenu).not.toBe(f.owner.menu); expect(f.state.menuDepth).toBe(2); expect(pb.curvalue).toBe(1); expect(f.cvars.get("cl_punkbuster")?.value).toBe("1");
});

test("cache failure, retirement and actual EXEC_NOW failure retain only reached source state", async () => {
  const f = await fixture(), failure = new CommonError("drop", "Arena cache interrupted"), register = f.resources.registerShaderNoMip.bind(f.resources);
  f.resources.registerShaderNoMip = async name => { if (name === art[2]) throw failure; return await register(name); };
  await expect(f.owner.show()).rejects.toBe(failure); expect(f.owner.menu.itemCount).toBe(0); expect(f.appended).toEqual([]); expect(f.cvars.get("debug_protocol")).toBeUndefined();
  const g = await fixture(), peer = await network(g); favorites(g, [address(peer)]); await g.owner.show(); const udp = socket(g.io), send = udp.send.bind(udp);
  udp.send = () => { throw failure; }; try { await expect(draw(g, 10)).rejects.toBe(failure); } finally { udp.send = send; }
  expect(g.browser.getPingQueueCount()).toBe(1); expect(status(g)).toBe("hit refresh to update"); await press(g, KeyCode.Space); expect(list(g).numitems).toBe(1);
  const h = await fixture(), entered = deferred(), gate = deferred(), actualRegister = h.resources.registerShaderNoMip.bind(h.resources);
  h.resources.registerShaderNoMip = async name => { entered.resolve(); await gate.promise; return await actualRegister(name); };
  const opening = h.owner.show(); await entered.promise; h.state.retire(); gate.resolve(); await expect(opening).rejects.toThrow("retired"); expect(h.owner.menu.itemCount).toBe(0);
  expect(() => new BaseArenaServersMenu(f.state, f.browser, new CommandBuffer(), f.start, f.specify, f.confirm)).toThrow("shared command buffer");
});

async function realServer(f: Fixture) {
  const io = await network(f), homePath = mkdtempSync(join(tmpdir(), "q3-arena-servers-")); cleanup.push(() => rmSync(homePath, { recursive: true }));
  const random = new LinuxNativeRandom(1); let owner: ServerEngine | null = null;
  const common = await CommonConsole.open({ roots: { product: "baseq3", dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath, cdPath: null },
    random, startup: new StartupCommands(""), build: { kind: "dedicated" }, platformPrint: () => undefined,
    resolveCommand: () => ({ kind: "sync", handler: context => { owner?.gameConsoleCommand(context); } }), assertCommandEntry: () => { owner?.assertCommandEntry(); }, assertOwnerEntry: () => { void owner?.options.common.roots; },
  }, value => { cleanup.push(() => value.close()); return undefined; });
  common.cvars.register("showpackets", "0"); common.cvars.set("sv_pure", "0", true); common.cvars.set("sv_maxclients", "2", true); common.cvars.set("dedicated", "1", true); common.cvars.set("bot_enable", "0", true);
  common.commands.append("exec default.cfg\nexec q3config.cfg\nexec autoexec.cfg\n"); await common.commands.executeAsync(); common.registerRuntimeCvars("arena-servers-test", async () => undefined);
  const clock = { comFrameTime: 1000, wallTime: 2000, milliseconds(): number { return ++this.wallTime; } };
  const server = ServerEngine.create({ common, clock, random, buildDate: "arena-servers-test", network: { loopback: f.loopback, udp: io.udp, lan: io.lan,
    resolveAddress: async () => { throw new Error("Arena menu fixture never resolves external DNS"); }, sleep: async milliseconds => { await Bun.sleep(milliseconds); } },
    bots: { kind: "unavailable", reason: "Human browser fixture" }, clientLifecycle: { kind: "absent" } });
  owner = server; cleanup.push(async () => { await server.disposeResources(); }); common.cvars.clearModified("dedicated"); common.cvars.set("r_uiFullScreen", "1", true); common.cvars.set("ui_singlePlayerActive", "0", true);
  common.markInitialized(); server.commands.append("map q3dm1\n"); await server.commands.executeAsync(); return { io, server };
}
test("actual q3dm1 server answers menu refresh through UDP, admission, browser and rendered list", async () => {
  const f = await fixture(), host = await realServer(f); favorites(f, [address(host.io)]); await f.owner.show(); await draw(f, 1000);
  const request = await packet(host.io); await host.server.packetEvent(request.from, request.payload); f.cls.realtime = 1012;
  const response = await packet(f.io); expect(f.receive(response.from, response.payload)).toBe(true); await draw(f, 1012);
  expect(list(f).numitems).toBe(1); expect(itemAt(list(f).itemnames, 0)).toContain("Q3DM1"); expect(itemAt(list(f).itemnames, 0)).toContain("0/ 2"); expect(itemAt(list(f).itemnames, 0)).toContain("^2 13");
  expect(f.browser.getPingQueueCount()).toBe(0); await activate(item(f.owner.menu, 22)); expect(f.appended.at(-1)).toBe(`connect ${address(host.io)}\n`);
}, 20000);
