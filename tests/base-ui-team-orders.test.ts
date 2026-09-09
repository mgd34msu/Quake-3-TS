import { expect, test } from "bun:test";
import { CvarRegistry } from "../src/core/cvar.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { GamestateEntry, ServerMessageContext, ServerOperation } from "../src/protocol/server-message.ts";
import { PlayerState } from "../src/shared/player-state.ts";
import { cacheMenu, drawProportional } from "../src/ui/base/draw.ts";
import { mouseEvent, refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { BaseTeamOrdersMenu } from "../src/ui/base/team-orders.ts";
import { BaseSpecifyServerMenu } from "../src/ui/base/specify-server.ts";
import { COLORS, MenuEvent, MenuFlag } from "../src/ui/base/state.ts";
import type { BaseMenuItem, MenuScroll } from "../src/ui/base/state.ts";
import { UI_CENTER, UI_PULSE, UI_SMALLFONT } from "../src/render/font.ts";
import type { DrawBatch } from "../src/render/types.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Config = readonly [number, string];
const art: readonly [string, string, string] = ["menu/art/addbotframe", "menu/art/back_0", "menu/art/back_1"];
const teamLabels = ["I Am the Leader", "Follow Me", "Roam", "Camp Here", "Report", "I Relinquish Command"];
const ctfLabels = ["I Am the Leader", "Defend the Base", "Follow Me", "Get Enemy Flag", "Camp Here", "Report", "I Relinquish Command"];
const teamMessages = ["i am the leader", "Everyone follow me", "Everyone roam", "Everyone camp here", "Everyone report", "i stop being the leader"];
const ctfMessages = ["i am the leader", "Everyone defend the base", "Everyone follow me", "Everyone get enemy flag", "Everyone camp here", "Everyone report", "i stop being the leader"];
function info(maximum = "8", gametype = "3"): string { return `\\sv_maxclients\\${maximum}\\g_gametype\\${gametype}`; }
function bot(name: string, team = "\x03", skill = "1"): string { return `\\n\\${name}\\t\\${team}\\skill\\${skill}`; }
function roster(): Config[] { return Array.from({ length: 9 }, (_, index) => [544 + index, bot(`Bot${index}`)]); }
async function fixture(width = 160, height = 120) {
  const ui = await baseFixture(width, height), cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
  const session = new EngineClientSession({ product: "baseq3", cvars, lifecycle, mode: { kind: "network", challenge: 1, qport: 27961 } });
  let number = 0;
  async function send(operations: readonly ServerOperation[]): Promise<void> {
    number++;
    const context: ServerMessageContext = { product: "baseq3", messageNumber: number, reliableSequence: 0, serverCommandSequence: 0,
      parseEntitiesNumber: 0, baseline: () => null, history: () => null };
    await session.receiveServerMessage(number, encodeServerMessage(0, operations, context));
  }
  async function load(server = info(), players: readonly Config[] = [], snapshotClient: number | null = 0): Promise<void> {
    const entries: GamestateEntry[] = [{ kind: "configstring", index: 0, value: server },
      { kind: "configstring", index: 1, value: "\\sv_serverid\\100\\sv_cheats\\1\\fs_game\\" },
      ...players.map(([index, value]) => ({ kind: "configstring", index, value } satisfies GamestateEntry))];
    await send([{ kind: "gamestate", commandSequence: 0, clientNumber: 7, checksumFeed: 19, entries }]);
    if (snapshotClient !== null) {
      const playerState = new PlayerState("baseq3"); playerState.clientNum = snapshotClient;
      await send([{ kind: "snapshot", validity: { kind: "valid" }, snapshot: { messageNumber: number + 1, serverTime: (number + 1) * 50,
        deltaNumber: -1, flags: 0, serverCommandNumber: 0, parseEntitiesNumber: 0, areaMask: new Uint8Array(), playerState, entities: [] } }]);
    }
  }
  return { ...ui, session, lifecycle, load, owner: new BaseTeamOrdersMenu(ui.state), close: () => { lifecycle.close(); ui.close(); } };
}
function item(f: Fixture, index: number): BaseMenuItem {
  const value = f.owner.menu.items[index]; if (value === undefined) throw new Error(`Missing source item ${index}`); return value;
}
function list(f: Fixture): MenuScroll {
  const value = item(f, 2); if (value.kind !== "scroll") throw new Error("Missing actual Team Orders scroll list"); return value;
}
async function activate(f: Fixture, index = 2, event = MenuEvent.Activated): Promise<void> {
  const value = item(f, index); if (value.common.callback === null) throw new Error("Missing actual callback"); await value.common.callback(value, event);
}
async function press(f: Fixture, key: number): Promise<void> {
  await f.keys.keyEvent(key, true, 10); await f.keys.keyEvent(key, false, 11);
}
async function sourceKey(f: Fixture, key: number) {
  const callback = f.owner.menu.key; if (callback === null) throw new Error("Missing actual source key handler"); return await callback(key);
}

test("Team Orders literal four items, stable records, source bounds and cache-before-reset reads", async () => {
  const f = await fixture(); try {
    await f.load(); const menu = f.owner.menu, trace: string[] = [];
    const register = f.resources.registerShaderNoMip.bind(f.resources), read = f.session.getGameState.bind(f.session), identity = f.session.readSnapshotClientNumber.bind(f.session);
    f.resources.registerShaderNoMip = async name => { if (name === null) throw new Error("Authored menu cache requires a shader name"); trace.push(name); expect(menu.itemCount).toBe(0); return await register(name); };
    f.session.readSnapshotClientNumber = () => { trace.push("snapshot"); expect(menu.itemCount).toBe(0); return identity(); };
    f.session.getGameState = () => { trace.push("config"); expect(menu.itemCount).toBe(0); return read(); };
    await f.owner.show(f.session);
    expect(trace).toEqual([...art, "snapshot", ...new Array<string>(9).fill("config")]);
    expect(menu.items.map(value => [value.kind, value.common.id, value.common.x, value.common.y, value.common.flags,
      value.common.left, value.common.top, value.common.right, value.common.bottom])).toEqual([
      ["banner", 0, 320, 16, 0x4000, 0, 0, 0, 0], ["bitmap", 0, 87, 74, 0x4000, 87, 74, 553, 406],
      ["scroll", 10, 256, 120, 0x100, 220, 120, 420, 147], ["bitmap", 0, 0, 416, 0x104, 0, 416, 128, 480],
    ]);
    expect([menu.cursor, menu.cursorPrev, menu.fullscreen, menu.wrapAround, menu.showlogo, menu.draw]).toEqual([2, 0, false, false, false, null]);
    expect(menu.items.every((value, index) => value.common.parent === menu && value.common.menuPosition === index)).toBe(true);
    const banner = item(f, 0); if (banner.kind !== "banner") throw new Error("Missing banner");
    expect([banner.text, banner.style, banner.color]).toEqual(["TEAM ORDERS", 1, { x: 1, y: 1, z: 1, w: 1 }]);
    expect(menu.items.flatMap(value => value.kind === "bitmap" ? [[value.common.name, value.width, value.height, value.focuspic, value.shader, value.focusshader]] : [])).toEqual([
      [art[0], 466, 332, null, null, null], [art[1], 128, 64, art[2], null, null],
    ]);
    const scroll = list(f), names = scroll.itemnames, items = menu.items.slice();
    expect([scroll.width, scroll.height, scroll.columns, scroll.separation, scroll.curvalue, scroll.oldvalue, scroll.top]).toEqual([0, 0, 1, 0, 0, 0, 0]);
    expect(names).toEqual(["Everyone", "", "", "", "", "", "", "", ""]); expect(scroll.numitems).toBe(1);
    expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui); expect(f.state.activeMenu).toBe(menu);
    f.resources.registerShaderNoMip = async name => { expect(menu.itemCount).toBe(4); expect(scroll.itemnames).toBe(names); return await register(name); };
    await f.owner.show(f.session); expect(f.owner.menu).toBe(menu); expect(menu.items).toEqual(items);
    for (const [index, value] of items.entries()) expect(item(f, index)).toBe(value); expect(list(f).itemnames).toBe(names);
  } finally { f.close(); }
});

test("normal ASCII bots remain excluded; self uses snapshot identity rather than admission", async () => {
  const f = await fixture(); try {
    await f.load(info(), [[544, bot("Red", "1")], [545, bot("Blue", "2")], [546, bot("Spectator", "3")], [547, bot("Empty", "")]]);
    await f.owner.show(f.session); expect(list(f).numitems).toBe(1);
    await f.load(info(), [[544, bot("Zero")], [545, bot("NoSkill", "\x03", "0")], [546, bot("Self")], [547, bot("Negative", "\x03", "-2tail")], [551, bot("Admission")]], 2);
    expect([f.session.clientNumber, f.session.readSnapshotClientNumber()]).toEqual([7, 2]);
    await f.owner.show(f.session); expect(list(f).itemnames.slice(0, list(f).numitems)).toEqual(["Everyone", "Zero", "Negative", "Admission"]);
    await f.load(info(), [[544, bot("Zero")], [545, bot("One")]], null); await f.owner.show(f.session);
    expect(list(f).itemnames.slice(0, list(f).numitems)).toEqual(["Everyone", "One"]);
  } finally { f.close(); }
});

test("roster scanning preserves configstring bounds and repeats unchanged final scratch without a 64-client clamp", async () => {
  const f = await fixture(); try {
    await f.load(info("1000000000"), [[1023, bot("Last")]]);
    let calls = 0; const read = f.session.getGameState.bind(f.session); f.session.getGameState = () => { calls++; return read(); };
    await f.owner.show(f.session); expect(calls).toBe(481); expect(list(f).itemnames).toEqual(["Everyone", ...new Array<string>(8).fill("Last")]);
    for (const maximum of ["0", "-1", "nonsense", "4294967296"]) { await f.load(info(maximum), roster()); await f.owner.show(f.session); expect(list(f).numitems).toBe(1); }
  } finally { f.close(); }
});

test("name copies truncate before Q_CleanStr and retain source punctuation, empty and duplicate names", async () => {
  const f = await fixture(); try {
    const names = ["^1ABCDEFGHIJKLMNO", "ABCDEFGHIJKLMN^1Z", "A^^1B", "ABC^", "\x01^1\x7f", "Same", "Same", 'Q";$&$`'];
    await f.load(info("20"), names.map((name, index) => [545 + index, bot(name)])); await f.owner.show(f.session);
    expect(list(f).itemnames).toEqual(["Everyone", "ABCDEFGHIJKLM", "ABCDEFGHIJKLMN^", "A^B", "ABC^", "", "Same", "Same", 'Q";$&$`']);
    list(f).curvalue = 8; await activate(f); list(f).curvalue = 1; await activate(f);
    expect(f.consoleCommands.pendingText).toBe('say_team "Q";$&$` follow me"\n'); expect(f.state.menuDepth).toBe(0);
  } finally { f.close(); }
});

test("config copy limits, NUL, first duplicate keys, empty slots and encoded source byte replacement", async () => {
  const f = await fixture(); try {
    const prefix = "\\sv_maxclients\\1\\g_gametype\\";
    for (const [server, orders] of [[prefix + " ".repeat(1022 - prefix.length) + "4", 7], [prefix + " ".repeat(1023 - prefix.length) + "4", 6],
      ["\\SV_MAXCLIENTS\\2\\g_gametype\\4\\g_gametype\\3", 7], [info("2", "3") + "\0\\g_gametype\\4", 6]] satisfies readonly (readonly [string, number])[]) {
      await f.load(server, [[545, bot("High\x80\xff")]]); await f.owner.show(f.session); await activate(f); expect(list(f).numitems).toBe(orders);
    }
    await f.load(info("3"), [[545, bot("High\x80\xff")], [546, ""]]);
    expect(f.session.getGameState()[545]).toContain("High.."); await f.owner.show(f.session); expect(list(f).itemnames.slice(0, 3)).toEqual(["Everyone", "High..", ""]); expect(list(f).numitems).toBe(2);
  } finally { f.close(); }
});

test("labelled detached-copy boundary injection checks cleanup and byte rejection, not wire preservation", async () => {
  const f = await fixture(), read = f.session.getGameState.bind(f.session);
  try {
    await f.load(info("2"), [[545, bot("Real")]]);
    for (const [input, expected] of [["A\x80\xff\x01B", "AB"], ["^1\x80^", "^"], ["^^^2C", "^^C"]] satisfies readonly (readonly [string, string])[]) {
      f.session.getGameState = () => { const copy = read().slice(); copy[545] = bot(input); return copy; };
      await f.owner.show(f.session); expect(list(f).itemnames[1]).toBe(expected); expect(read()[545]).toBe(bot("Real"));
    }
    f.session.getGameState = () => { const copy = read().slice(); copy[545] = bot("\u0100"); return copy; };
    await expect(f.owner.show(f.session)).rejects.toThrow("source bytes");
    f.session.getGameState = () => { const copy = read().slice(); copy[545] = bot("Bounded") + " ".repeat(1024) + "\u0100"; return copy; };
    await f.owner.show(f.session); expect(list(f).itemnames[1]).toBe("Bounded");
    f.session.getGameState = () => { const copy = read().slice(); copy[545] = bot("Nul") + "\0\u0100"; return copy; };
    await f.owner.show(f.session); expect(list(f).itemnames[1]).toBe("Nul");
    f.session.getGameState = () => { const copy = read().slice(); copy.length = 545; return copy; };
    await expect(f.owner.show(f.session)).rejects.toThrow("array index 545");
  } finally { f.session.getGameState = read; f.close(); }
});

test("console gate uses serverinfo and snapshot team in source order, separately from plain show", async () => {
  const f = await fixture(); try {
    const read = f.session.getGameState.bind(f.session), identity = f.session.readSnapshotClientNumber.bind(f.session); const trace: string[] = [];
    f.session.getGameState = () => { trace.push("config"); return read(); }; f.session.readSnapshotClientNumber = () => { trace.push("snapshot"); return identity(); };
    for (const gametype of ["", "0", "2", "-1", "nonsense"]) {
      await f.load(info("1", gametype)); trace.length = 0; f.registrations.length = 0; await f.owner.showFromCommand(f.session);
      expect(trace).toEqual(["config"]); expect(f.registrations).toEqual([]); expect(f.owner.menu.itemCount).toBe(0);
    }
    await f.load(info("3", "4"), [[546, "\\t\\3"], [551, "\\t\\1"]], 2); trace.length = 0; await f.owner.showFromCommand(f.session);
    expect(trace).toEqual(["config", "snapshot", "config"]); expect(f.owner.menu.itemCount).toBe(0);
    for (const gametype of ["3", "4", "5", "6", "7"]) for (const team of ["", "nonsense", "-3", "1"]) {
      await f.load(info("1", gametype), [[544, `\\t\\${team}`]]); await f.owner.showFromCommand(f.session); await activate(f);
      expect(list(f).itemnames).toEqual(gametype === "4" ? ctfLabels : teamLabels);
    }
    await f.load(info("0", "0")); await f.owner.show(f.session); await activate(f); expect(list(f).itemnames).toEqual(teamLabels);
  } finally { f.close(); }
});

test("passed gate is reread after cache and failed gate gametype write remains on the old record", async () => {
  const f = await fixture(); try {
    await f.load(info("1", "4")); const register = f.resources.registerShaderNoMip.bind(f.resources); let change = true;
    f.resources.registerShaderNoMip = async name => { if (change) { change = false; await f.load(info("1", "3")); } return await register(name); };
    await f.owner.showFromCommand(f.session); await activate(f); expect(list(f).itemnames).toEqual(teamLabels);
    await f.load(info("1", "4")); await f.owner.show(f.session); const scroll = list(f);
    await f.load(info("1", "2")); await f.owner.showFromCommand(f.session); expect(list(f)).toBe(scroll); expect(scroll.common.id).toBe(10);
    await activate(f); expect(scroll.itemnames).toEqual(teamLabels);
  } finally { f.close(); }
});

test("cache failure preserves old records, while owner read failure exposes the source reset", async () => {
  const f = await fixture(); try {
    await f.load(); await f.owner.show(f.session); const items = f.owner.menu.items.slice(), scroll = list(f); scroll.curvalue = 4;
    const register = f.resources.registerShaderNoMip.bind(f.resources), failure = new Error("cache failure");
    f.resources.registerShaderNoMip = async name => { if (name === art[1]) throw failure; return await register(name); };
    await expect(f.owner.show(f.session)).rejects.toBe(failure); expect(f.owner.menu.items).toEqual(items); expect(scroll.curvalue).toBe(4);
    f.resources.registerShaderNoMip = register; f.lifecycle.close(); await expect(f.owner.show(f.session)).rejects.toThrow("no longer current");
    expect(f.owner.menu.itemCount).toBe(0); expect(scroll.curvalue).toBe(0); expect(scroll.itemnames).toEqual(new Array<string>(9).fill(""));
  } finally { f.close(); }
});

test("source gate write survives cache failure and later config failure leaves Everyone initialized before items", async () => {
  const f = await fixture(); try {
    await f.load(info("1", "4")); await f.owner.show(f.session); const scroll = list(f), names = scroll.itemnames;
    await f.load(info("1", "3")); const register = f.resources.registerShaderNoMip.bind(f.resources), failure = new Error("source cache abort");
    f.resources.registerShaderNoMip = async () => { throw failure; };
    await expect(f.owner.showFromCommand(f.session)).rejects.toBe(failure); expect(scroll.itemnames).toBe(names);
    await activate(f); expect(scroll.itemnames).toEqual(teamLabels);
    f.resources.registerShaderNoMip = register;
    const read = f.session.getGameState.bind(f.session); f.session.getGameState = () => { read(); throw failure; };
    try {
      await expect(f.owner.show(f.session)).rejects.toBe(failure); expect(f.owner.menu.itemCount).toBe(0);
      expect(scroll.itemnames).toBe(names); expect(names).toEqual(["Everyone", "", "", "", "", "", "", "", ""]);
    } finally { f.session.getGameState = read; }
  } finally { f.close(); }
});

test("retired asynchronous cache continuation cannot reset or publish the old record", async () => {
  const f = await fixture(); try {
    await f.load(); await f.owner.show(f.session); const items = f.owner.menu.items.slice(), gate = deferred(), entered = deferred();
    const register = f.resources.registerShaderNoMip.bind(f.resources); f.resources.registerShaderNoMip = async name => { entered.resolve(); await gate.promise; return await register(name); };
    const pending = f.owner.show(f.session); await entered.promise; f.state.retire(); gate.resolve();
    await expect(pending).rejects.toThrow("retired"); expect(f.owner.menu.items).toEqual(items);
  } finally { f.close(); }
});

test("reentrant cache uses one stable record and outer initialization rereads its own actual client", async () => {
  const f = await fixture(), other = await fixture(); try {
    await f.load(info("2"), [[545, bot("Outer")]]); await other.load(info("2", "4"), [[545, bot("Inner")]]);
    await f.owner.show(f.session); const scroll = list(f), menu = f.owner.menu, names = scroll.itemnames;
    const register = f.resources.registerShaderNoMip.bind(f.resources); let nested = false;
    f.resources.registerShaderNoMip = async name => { if (!nested) { nested = true; await f.owner.show(other.session); expect(list(f).itemnames[1]).toBe("Inner"); } return await register(name); };
    await f.owner.show(f.session); expect(f.owner.menu).toBe(menu); expect(list(f)).toBe(scroll); expect(list(f).itemnames).toBe(names);
    expect(list(f).itemnames[1]).toBe("Outer"); expect(f.state.menuDepth).toBe(1); await activate(f); expect(list(f).itemnames).toEqual(teamLabels);
  } finally { f.close(); other.close(); }
});

test("roster stays captured while open and reopen borrows a different actual session", async () => {
  const f = await fixture(), other = await fixture(); try {
    await f.load(info("2"), [[545, bot("First")]]); await f.owner.show(f.session);
    await f.load(info("2"), [[545, bot("Changed")]]); expect(list(f).itemnames[1]).toBe("First");
    await other.load(info("2"), [[545, bot("Second")]]); await f.owner.show(other.session); expect(list(f).itemnames[1]).toBe("Second");
    other.lifecycle.close(); await f.owner.show(f.session); expect(list(f).itemnames[1]).toBe("Changed");
  } finally { f.close(); other.close(); }
});

for (const gametype of [3, 4]) test(`all source order strings append only and pop, gametype=${gametype}`, async () => {
  const f = await fixture(); try {
    await f.load(info("2", String(gametype)), [[545, bot("Named")]]); const messages = gametype === 4 ? ctfMessages : teamMessages; let expected = "";
    for (const recipient of [0, 1]) for (const [selection, message] of messages.entries()) {
      await f.owner.show(f.session); list(f).curvalue = recipient; await activate(f); expect(list(f).itemnames).toEqual(gametype === 4 ? ctfLabels : teamLabels);
      list(f).curvalue = selection; await activate(f); expected += `say_team "${recipient === 0 ? message : message.replace("Everyone", "Named")}"\n`;
      expect(f.consoleCommands.pendingText).toBe(expected); expect(f.state.activeMenu).toBeNull(); expect(f.keys.getCatcher()).toBe(0);
    }
  } finally { f.close(); }
});

test("custom wrapped keys preserve zero dimensions and defer generic PageUp/PageDown/Home/End/search", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); await f.load(); await f.owner.show(f.session); const scroll = list(f);
    expect((await sourceKey(f, KeyCode.Up)).kind).toBe("sound"); expect([scroll.oldvalue, scroll.curvalue]).toEqual([0, 0]);
    await sourceKey(f, KeyCode.KeypadDown); expect([scroll.oldvalue, scroll.curvalue]).toEqual([0, 0]);
    await press(f, KeyCode.Enter); expect(scroll.common.id).toBe(12); expect(scroll.curvalue).toBe(0);
    await sourceKey(f, KeyCode.PageDown); expect([scroll.curvalue, scroll.top]).toEqual([-1, 0]);
    await expect(activate(f)).rejects.toThrow("message format -1"); expect(f.consoleCommands.pendingText).toBe("");
    await sourceKey(f, KeyCode.Home); await sourceKey(f, KeyCode.Down); await sourceKey(f, KeyCode.PageUp); expect([scroll.curvalue, scroll.top]).toEqual([2, 2]);
    await sourceKey(f, KeyCode.End); expect([scroll.curvalue, scroll.top]).toEqual([5, 6]);
    await sourceKey(f, KeyCode.KeypadDown); expect([scroll.oldvalue, scroll.curvalue, scroll.top]).toEqual([5, 0, 6]);
    await sourceKey(f, "R".charCodeAt(0)); expect(scroll.curvalue).toBe(2);
    await sourceKey(f, KeyCode.KeypadUp); expect(scroll.curvalue).toBe(1); await sourceKey(f, KeyCode.Tab); expect(f.owner.menu.cursor).toBe(3);
    await press(f, KeyCode.Enter); expect(f.state.menuDepth).toBe(0); expect(f.consoleCommands.pendingText).toBe("");
  } finally { f.close(); }
});

test("custom arrows emit only move sound while generic selection emits GotFocus without activation", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); await f.load(info("2"), [[545, bot("Bot")]]); await f.owner.show(f.session);
    const scroll = list(f), callback = scroll.common.callback; if (callback === null) throw new Error("Missing source list callback");
    const events: MenuEvent[] = []; scroll.common.callback = async (value, event) => { events.push(event); await callback(value, event); };
    f.events.length = 0; await press(f, KeyCode.Down); await press(f, KeyCode.KeypadUp);
    expect(events).toEqual([]); expect(f.events).toEqual(["sound:sound/misc/menu2.wav:6", "sound:sound/misc/menu2.wav:6"]);
    await sourceKey(f, KeyCode.End); expect(events).toEqual([MenuEvent.GotFocus]); expect(scroll.common.id).toBe(10);
  } finally { f.close(); }
});

test("mouse inclusive bottom selects a blank stored tail and does not require mouse-focus flag", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); await f.load(); await f.owner.show(f.session); const scroll = list(f);
    f.state.cursorX = 219; f.state.cursorY = 147; expect(await sourceKey(f, KeyCode.Mouse1)).toBe(f.state.media.nullSound); expect(scroll.common.id).toBe(10);
    f.state.cursorX = 420; f.state.cursorY = 147; expect(scroll.common.flags & MenuFlag.HasMouseFocus).toBe(0);
    expect((await sourceKey(f, KeyCode.Mouse1)).kind).toBe("sound"); expect([scroll.oldvalue, scroll.curvalue, scroll.common.id]).toEqual([0, 1, 12]);
    await press(f, KeyCode.Enter); expect(f.consoleCommands.pendingText).toBe('say_team " follow me"\n');
    await f.owner.show(f.session); f.state.cursorX = 40; f.state.cursorY = 430; await mouseEvent(f.state, 0, 0); expect(f.owner.menu.cursor).toBe(3);
    await press(f, KeyCode.Mouse1); expect(f.state.menuDepth).toBe(0);
  } finally { f.close(); }
});

for (const gametype of [3, 4]) test(`retained high selection and terminal NULL order slots fail only when activated, gametype=${gametype}`, async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); await f.load(info("9", String(gametype)), roster()); await f.owner.show(f.session);
    const scroll = list(f); expect(scroll.numitems).toBe(9); scroll.curvalue = 8; scroll.top = 4; await activate(f);
    expect([scroll.curvalue, scroll.top, scroll.numitems]).toEqual([8, 4, gametype === 4 ? 7 : 6]);
    const draw = scroll.common.ownerdraw; if (draw === null) throw new Error("Missing ownerdraw"); await draw(scroll);
    for (const value of [-1, scroll.numitems, 8, 20]) { scroll.curvalue = value; await expect(activate(f)).rejects.toBeInstanceOf(RangeError); }
    expect(f.consoleCommands.pendingText).toBe(""); expect(f.state.menuDepth).toBe(1);
  } finally { f.close(); }
});

test("full roster bottom index nine is not read by leader but targeted formatting rejects it", async () => {
  const f = await fixture(); try {
    await f.load(info("9"), roster());
    for (const targeted of [false, true]) {
      await f.owner.show(f.session); const scroll = list(f); f.state.cursorX = 320; f.state.cursorY = scroll.common.bottom;
      await sourceKey(f, KeyCode.Mouse1); expect(scroll.curvalue).toBe(9); await sourceKey(f, KeyCode.Home);
      if (targeted) { await sourceKey(f, KeyCode.Down); await expect(activate(f)).rejects.toThrow("array index 9"); expect(f.state.menuDepth).toBe(1); }
      else { await activate(f); expect(f.state.menuDepth).toBe(0); }
      expect(f.consoleCommands.pendingText).toBe('say_team "i am the leader"\n');
    }
  } finally { f.close(); }
});

test("non-activated callbacks are inert and source alternate activation/back keys use real dispatch", async () => {
  const f = await fixture(); try {
    await f.load(); await f.owner.show(f.session); await activate(f, 2, MenuEvent.GotFocus); await activate(f, 3, MenuEvent.LostFocus); expect(list(f).common.id).toBe(10);
    for (const key of [KeyCode.KeypadEnter, KeyCode.Joy1, KeyCode.Aux1]) { await f.owner.show(f.session); await press(f, key); expect(list(f).common.id).toBe(12); }
    for (const key of [KeyCode.Escape, KeyCode.Mouse2]) { await f.owner.show(f.session); await press(f, key); expect(f.state.menuDepth).toBe(0); }
    expect(f.consoleCommands.pendingText).toBe("");
  } finally { f.close(); }
});

test("append overflow still pops; later key-clear failure preserves already appended command", async () => {
  const f = await fixture(); try {
    await f.load(); await f.owner.show(f.session); await activate(f); f.consoleCommands.append("x".repeat(16380));
    const printedBefore = f.prints.length;
    await activate(f); expect(f.state.activeMenu).toBeNull(); expect(f.state.menuDepth).toBe(0);
    expect(f.prints.slice(printedBefore)).toEqual(["Cbuf_AddText: overflow\n"]);
    expect(f.consoleCommands.pendingText).toBe("x".repeat(16380));
  } finally { f.close(); }
  const g = await fixture(); try {
    await g.load(); await g.owner.show(g.session); await activate(g); const failure = new Error("source clear failed");
    g.keys.clearStates = async () => { throw failure; }; await expect(activate(g)).rejects.toBe(failure);
    expect(g.consoleCommands.pendingText).toBe('say_team "i am the leader"\n'); expect(g.state.menuDepth).toBe(0);
  } finally { g.close(); }
});

test("actual CPU ownerdraw renders every row despite top and matches source colors/focus pulse", async () => {
  const f = await fixture(640, 480); try {
    const reference = await fixture(640, 480); try {
      await cacheMenu(f.state); await f.load(info("1", "4")); await f.owner.show(f.session); await activate(f);
      await cacheMenu(reference.state); reference.state.realtime = 1000;
      const scroll = list(f); scroll.top = 100; scroll.curvalue = 2; f.state.realtime = 1000;
      const draw = scroll.common.ownerdraw; if (draw === null) throw new Error("Missing ownerdraw");
      await draw(scroll); const first = f.commands.submitFrame(); if (first === null) throw new Error("Frame-end command did not fit");
      expect(first.commands).toBeGreaterThan(0); expect(first.batches).toBeGreaterThan(0);
      const actual = f.recorder.trace().flatMap(view => view.batches);
      for (const [index, text] of ctfLabels.entries()) drawProportional(reference.state, 320, 120 + index * 27, text,
        UI_CENTER | UI_SMALLFONT | (index === 2 ? UI_PULSE : 0), index === 2 ? COLORS.highlight : COLORS.normal);
      const second = reference.commands.submitFrame(); if (second === null) throw new Error("Frame-end command did not fit");
      expect(second.commands).toBeGreaterThan(0); expect(second.batches).toBeGreaterThan(0);
      const expected = reference.recorder.trace().flatMap(view => view.batches);
      const indexed = (batches: readonly DrawBatch[]) => batches.flatMap(batch => batch.indices.map(index => {
        const vertex = batch.vertices[index]; if (vertex === undefined) throw new Error("Missing emitted indexed vertex");
        if (batch.texture.kind !== "bind-image") throw new Error("Menu text must bind its registered image");
        return { vertex, state: batch.state, texture: batch.texture.image.name, texturing: batch.texturing, primitive: batch.primitive };
      }));
      expect(indexed(actual)).toEqual(indexed(expected));
      expect(f.cpu.pixels).toEqual(reference.cpu.pixels);
      await setCursorToItem(f.state, f.owner.menu, item(f, 3)); await draw(scroll); expect(f.commands.submitFrame()?.batches).toBeGreaterThan(0);
      await refresh(f.state, 1000); expect(f.commands.submit().batches).toBeGreaterThan(0); expect(f.cpu.pixels.some(value => value !== 0)).toBe(true);
      expect(f.assets.reads).toContain("menu/art/addbotframe.tga"); expect(f.state.menuDepth).toBe(1);
    } finally { reference.close(); }
  } finally { f.close(); }
});

test("actual menu stack keeps Team Orders nonfullscreen and Back restores the existing lower menu", async () => {
  const f = await fixture(640, 480); try {
    await cacheMenu(f.state); await f.load(); const lower = new BaseSpecifyServerMenu(f.state); await lower.show(); await f.owner.show(f.session);
    expect(f.state.stack.slice(0, f.state.menuDepth)).toEqual([lower.menu, f.owner.menu]);
    await refresh(f.state, 1000); const submitted = f.commands.submit(); expect(submitted.commands).toBeGreaterThan(0); expect(submitted.batches).toBeGreaterThan(0);
    const textures = f.recorder.trace().flatMap(view => view.batches).flatMap(batch => batch.texture.kind === "bind-image" ? [batch.texture.image.name] : []);
    expect(textures).toContain("menu/art/addbotframe.tga"); expect(textures).not.toContain("gfx/colors/black.tga");
    await activate(f, 3); expect(f.state.activeMenu).toBe(lower.menu); expect(f.state.menuDepth).toBe(1); expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui);
    expect(f.consoleCommands.pendingText).toBe(""); await refresh(f.state, 1001); expect(f.commands.submit().commands).toBeGreaterThan(0);
  } finally { f.close(); }
});
