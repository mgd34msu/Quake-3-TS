import { expect, test } from "bun:test";
import { CvarFlag } from "../src/core/cvar.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import { BaseConfirmMenu } from "../src/ui/base/confirm.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { MenuEvent, MenuFlag } from "../src/ui/base/state.ts";
import type { BaseMenuItem } from "../src/ui/base/state.ts";
import { BaseTeamMenu } from "../src/ui/base/team-menu.ts";
import { createProtocolClientSession } from "../tools/client-protocol-fixture.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

const FRAME = "menu/art/cut_frame";
function item(team: BaseTeamMenu, id: number): BaseMenuItem {
  const found = team.menu.items.find(value => value.common.id === id);
  if (found === undefined) throw new Error(`Missing source Team menu item ${id}`);
  return found;
}
async function event(team: BaseTeamMenu, id: number, kind = MenuEvent.Activated): Promise<void> {
  const value = item(team, id), callback = value.common.callback;
  if (callback === null) throw new Error("Missing Team menu event callback");
  await callback(value, kind);
}

test("team exact source record, art, items, flags and real initial focus", async () => {
  const f = await baseFixture();
  try {
    let reads = 0;
    const team = new BaseTeamMenu(f.state, () => {
      reads++;
      expect(team.menu.itemCount).toBe(0);
      expect(f.registrations).toEqual([`shader:${FRAME}`]);
      return "\\g_gametype\\3";
    }), menu = team.menu;
    f.registrations.length = 0;
    await team.show();
    expect(reads).toBe(1); expect(team.menu).toBe(menu); expect(menu.itemCount).toBe(5);
    expect(menu.items.map(value => [value.kind, value.common.id, value.common.x, value.common.y, value.common.flags])).toEqual([
      ["bitmap", 0, 142, 118, 0x4000], ["proportional", 100, 320, 194, 0x108],
      ["proportional", 101, 320, 214, 0x108], ["proportional", 102, 320, 234, 0x2108],
      ["proportional", 103, 320, 254, 0x108],
    ]);
    expect(menu.items.every((value, index) => value.common.parent === menu && value.common.menuPosition === index)).toBe(true);
    const frame = item(team, 0);
    if (frame.kind !== "bitmap") throw new Error("Expected source frame bitmap");
    expect([frame.width, frame.height, frame.common.name, frame.focuspic, frame.shader]).toEqual([359, 256, FRAME, null, null]);
    expect(menu.items.flatMap(value => value.kind === "proportional" ? [[value.text, value.style, value.color]] : [])).toEqual([
      ["JOIN RED", 17, { x: 1, y: 0, z: 0, w: 1 }], ["JOIN BLUE", 17, { x: 1, y: 0, z: 0, w: 1 }],
      ["JOIN GAME", 17, { x: 1, y: 0, z: 0, w: 1 }], ["SPECTATE", 17, { x: 1, y: 0, z: 0, w: 1 }],
    ]);
    expect([menu.cursor, menu.cursorPrev, menu.wrapAround, menu.fullscreen, menu.showlogo, menu.draw, menu.key]).toEqual([1, 0, true, false, false, null, null]);
    expect(f.state.activeMenu).toBe(menu); expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui);
  } finally { f.close(); }
});

test("team gametype uses first source info value and QVM signed-byte atoi and digit wrapping", async () => {
  const f = await baseFixture();
  try {
    let info = "";
    const team = new BaseTeamMenu(f.state, () => info);
    const cases: readonly (readonly [string, boolean])[] = [
      ["", false], ["\\other\\4", false], ["\\g_gametype", false], ["\\g_gametype\\", false],
      ["\\g_gametype\\0", false], ["\\g_gametype\\1", false], ["\\g_gametype\\2", false],
      ["\\g_gametype\\3", true], ["\\g_gametype\\4", true], ["\\g_gametype\\5", true],
      ["\\g_gametype\\6", true], ["\\g_gametype\\7", true], ["\\g_gametype\\-1", true],
      ["\\g_gametype\\nonsense", false], ["\\G_GAMETYPE\\+3suffix", true],
      ["\\g_gametype\\0\\g_gametype\\4", false], ["g_gametype\\4\\g_gametype\\0", true],
      ["\\g_gametype\\\x80\xff\t+3tail", true], ["\\g_gametype\\\x7f3", false],
      ["\\g_gametype\\4294967296", false], ["\\g_gametype\\4294967298", false],
      ["\\g_gametype\\4294967299", true], ["\\g_gametype\\-4294967293", true],
      ["\\g_gametype\\18446744073709551619", true],
    ];
    for (const [text, isTeam] of cases) {
      info = text; await team.show();
      expect([100, 101, 102, 103].map(id => (item(team, id).common.flags & MenuFlag.Grayed) !== 0)).toEqual([!isTeam, !isTeam, isTeam, false]);
      expect(team.menu.cursor).toBe(isTeam ? 1 : 3);
    }
  } finally { f.close(); }
});

test("team info copy is bounded to 1023 source bytes and NUL before parsing", async () => {
  const f = await baseFixture();
  try {
    let info = "";
    const team = new BaseTeamMenu(f.state, () => info), prefix = "\\g_gametype\\";
    const cases: readonly (readonly [string, number])[] = [
      [prefix + "3\0\\g_gametype\\0\u0100", 1],
      [prefix + "0\0\\g_gametype\\3", 3],
      [prefix + " ".repeat(1022 - prefix.length) + "3", 1],
      [prefix + " ".repeat(1023 - prefix.length) + "3", 3],
      [prefix + " ".repeat(1023 - prefix.length) + "\u0100", 3],
    ];
    for (const [text, cursor] of cases) { info = text; await team.show(); expect(team.menu.cursor).toBe(cursor); }
    info = prefix + "\u0100";
    await expect(team.show()).rejects.toThrow("requires source bytes");
    expect(team.menu.itemCount).toBe(0);
  } finally { f.close(); }
});

test("team samples actual protocol-owned configstrings on show without retaining another gamestate", async () => {
  const f = await baseFixture();
  try {
    const client = createProtocolClientSession({ product: "baseq3", cvars: f.cvars, mode: { kind: "network", challenge: 1, qport: 27961 } });
    const team = new BaseTeamMenu(f.state, () => {
      const info = client.getGameState()[0];
      if (info === undefined) throw new Error("Missing actual CS_SERVERINFO slot");
      return info;
    });
    for (const [number, gameType, cursor] of [[1, 0, 3], [2, 4, 1]] satisfies readonly (readonly [number, number, number])[]) {
      await client.receiveServerMessage(number, encodeServerMessage(0, [{ kind: "gamestate", commandSequence: 0, clientNumber: 0, checksumFeed: 17, entries: [
        { kind: "configstring", index: 0, value: `\\g_gametype\\${gameType}` },
        { kind: "configstring", index: 1, value: "\\sv_serverid\\100\\sv_cheats\\1" },
      ] }], { product: "baseq3", messageNumber: number, reliableSequence: 0, serverCommandSequence: 0,
        parseEntitiesNumber: 0, baseline: () => null, history: () => null }));
      await team.show(); expect(team.menu.cursor).toBe(cursor); expect(client.gamestateGeneration).toBe(number);
    }
  } finally { f.close(); }
});

test("team real key navigation skips grayed choices and appends each exact command before actual force-off", async () => {
  const f = await baseFixture();
  try {
    await cacheMenu(f.state);
    let info = "\\g_gametype\\3", executions = 0;
    const team = new BaseTeamMenu(f.state, () => info), clear = f.keys.clearStates.bind(f.keys);
    f.consoleCommands.register("cmd", () => { executions++; });
    for (const [gameType, id, command] of [[3, 100, "red"], [4, 101, "blue"], [0, 102, "free"], [4, 103, "spectator"]] satisfies readonly (readonly [number, number, string])[]) {
      info = `\\g_gametype\\${gameType}`; await team.show(); f.cvars.set("cl_paused", "1", true);
      await setCursorToItem(f.state, team.menu, item(team, id));
      f.keys.clearStates = async () => {
        expect(f.consoleCommands.pendingText).toBe(`cmd team ${command}\n`);
        expect(f.state.menuDepth).toBe(0); expect(f.state.activeMenu).toBeNull();
        expect(f.keys.getCatcher() & KeyCatcher.Ui).toBe(0); expect(f.cvars.get("cl_paused")?.value).toBe("1");
        await clear();
      };
      const before = executions;
      await f.keys.keyEvent(KeyCode.Enter, true, 100); await f.keys.keyEvent(KeyCode.Enter, false, 101);
      expect(executions).toBe(before); expect(f.cvars.get("cl_paused")?.value).toBe("0");
      expect(f.consoleCommands.pendingText).toBe(`cmd team ${command}\n`);
      f.consoleCommands.execute(); expect(executions).toBe(before + 1);
    }
    f.keys.clearStates = clear;
    info = "\\g_gametype\\3"; await team.show();
    await f.keys.keyEvent(KeyCode.Down, true, 102); await f.keys.keyEvent(KeyCode.Down, false, 103);
    expect(team.menu.cursor).toBe(2);
    await f.keys.keyEvent(KeyCode.Down, true, 104); await f.keys.keyEvent(KeyCode.Down, false, 105);
    expect(team.menu.cursor).toBe(4);
    await f.keys.keyEvent(KeyCode.Down, true, 106); await f.keys.keyEvent(KeyCode.Down, false, 107);
    expect(team.menu.cursor).toBe(1); expect(f.consoleCommands.pendingText).toBe("");
  } finally { f.close(); }
});

test("team ignored events and unknown IDs are inert; command overflow still completes force-off", async () => {
  const f = await baseFixture();
  try {
    const team = new BaseTeamMenu(f.state, () => "\\g_gametype\\4"); await team.show();
    for (const kind of [MenuEvent.GotFocus, MenuEvent.LostFocus]) for (const id of [100, 101, 102, 103]) await event(team, id, kind);
    const red = item(team, 100), callback = red.common.callback;
    if (callback === null) throw new Error("Missing source callback");
    red.common.id = 999; await callback(red, MenuEvent.Activated); red.common.id = 100;
    expect(f.consoleCommands.pendingText).toBe(""); expect(f.state.activeMenu).toBe(team.menu);
    f.cvars.set("cl_paused", "1", true); f.consoleCommands.append("x".repeat(16380));
    const printedBefore = f.prints.length;
    await event(team, 100);
    expect(f.prints.slice(printedBefore)).toEqual(["Cbuf_AddText: overflow\n"]);
    expect(f.consoleCommands.pendingText).toBe("x".repeat(16380)); expect(f.state.activeMenu).toBeNull();
    expect(f.state.menuDepth).toBe(0); expect(f.keys.getCatcher()).toBe(0); expect(f.cvars.get("cl_paused")?.value).toBe("0");
    expect(f.events).toEqual([]);
  } finally { f.close(); }
});

test("team queued command survives interrupted force-off and source pending cvar state", async () => {
  for (const retire of [false, true]) {
    const f = await baseFixture();
    try {
      const team = new BaseTeamMenu(f.state, () => "\\g_gametype\\3"), failure = new Error("key clear failed");
      await team.show(); f.cvars.register("cl_paused", "1", CvarFlag.ReadOnly | CvarFlag.Latch); f.cvars.set("cl_paused", "1", true);
      const clear = f.keys.clearStates.bind(f.keys);
      f.keys.clearStates = async () => { await clear(); if (retire) f.state.retire(); else throw failure; };
      if (retire) await expect(event(team, 101)).rejects.toThrow("retired");
      else await expect(event(team, 101)).rejects.toBe(failure);
      expect(f.consoleCommands.pendingText).toBe("cmd team blue\n"); expect(f.state.activeMenu).toBeNull();
      expect(f.state.menuDepth).toBe(0); expect(f.cvars.get("cl_paused")?.value).toBe("1");
    } finally { f.close(); }
  }
});

test("team retains stable records, resets before cache, samples after cache and retries failures", async () => {
  const f = await baseFixture();
  try {
    let info = "\\g_gametype\\4", reads = 0;
    const team = new BaseTeamMenu(f.state, () => { reads++; return info; }), register = f.resources.registerShaderNoMip.bind(f.resources);
    await team.show(); const menu = team.menu, items = [...menu.items], commons = items.map(value => value.common);
    menu.showlogo = true; menu.fullscreen = true;
    const gate = deferred(), entered = deferred();
    f.resources.registerShaderNoMip = async name => { const result = await register(name); entered.resolve(); await gate.promise; return result; };
    const pending = team.show(); await entered.promise;
    expect(reads).toBe(1); expect(menu.itemCount).toBe(0); expect(menu.wrapAround).toBe(false);
    expect(items.every(value => value.common.parent === null && value.common.callback === null)).toBe(true);
    info = "\\g_gametype\\0"; gate.resolve(); await pending;
    expect(reads).toBe(2); expect(menu.cursor).toBe(3); expect(menu.showlogo).toBe(false); expect(menu.fullscreen).toBe(false);
    for (const [index, value] of menu.items.entries()) {
      const prior = items[index], common = commons[index];
      if (prior === undefined || common === undefined) throw new Error("Missing retained source item");
      expect(value).toBe(prior); expect(value.common).toBe(common);
    }
    const failure = new Error("team cache failed"); f.resources.registerShaderNoMip = async () => { throw failure; };
    await expect(team.show()).rejects.toBe(failure); expect(menu.itemCount).toBe(0); expect(reads).toBe(2);
    f.resources.registerShaderNoMip = register; await team.show(); expect(menu.cursor).toBe(3); expect(reads).toBe(3);
    const before = [...menu.items]; await team.cache(); expect(menu.items).toEqual(before); expect(reads).toBe(3);
  } finally { f.close(); }
});

test("team late retired or escaped cache continuation cannot publish items", async () => {
  for (const retire of [false, true]) {
    const f = await baseFixture();
    try {
      let reads = 0;
      const team = new BaseTeamMenu(f.state, () => { reads++; return ""; }), register = f.resources.registerShaderNoMip.bind(f.resources);
      const gate = deferred(), entered = deferred();
      f.resources.registerShaderNoMip = async name => { const result = await register(name); entered.resolve(); await gate.promise; return result; };
      const holder: { promise: Promise<void> | null } = { promise: null };
      if (retire) holder.promise = team.show();
      else { f.consoleCommands.register("escape-team", () => { holder.promise = team.show(); }); f.consoleCommands.executeNow("escape-team"); }
      await entered.promise; if (retire) f.state.retire(); gate.resolve();
      if (holder.promise === null) throw new Error("Missing pending Team menu");
      await expect(holder.promise).rejects.toThrow(retire ? "retired" : "closed");
      expect(reads).toBe(0); expect(team.menu.itemCount).toBe(0); expect(f.state.activeMenu).toBeNull();
    } finally { f.close(); }
  }
});

test("team actual CPU queue draws source frame geometry and gametype-specific disabled text", async () => {
  const f = await baseFixture(320, 240);
  try {
    await cacheMenu(f.state);
    let info = "\\g_gametype\\3";
    const parent = new BaseConfirmMenu(f.state), team = new BaseTeamMenu(f.state, () => info);
    await parent.show("Parent", null, null); await team.show(); await refresh(f.state, 75); f.commands.submit();
    const frames = f.recorder.trace().flatMap(view => view.batches).filter(batch => batch.texture.kind === "bind-image" && batch.texture.image.name.includes("cut_frame"));
    const vertices = frames.flatMap(batch => [...new Set(batch.indices)].sort((a, b) => a - b).map(index => {
      const vertex = batch.vertices[index]; if (vertex === undefined) throw new Error("Missing actual Team frame vertex"); return vertex;
    }));
    expect(vertices).toHaveLength(4);
    const expected = [[142, 118], [501, 118], [501, 374], [142, 374]];
    for (const [index, vertex] of vertices.entries()) {
      const corner = expected[index]; if (corner === undefined) throw new Error("Missing source frame corner");
      const x = corner[0], y = corner[1]; if (x === undefined || y === undefined) throw new Error("Missing source coordinate");
      expect((vertex.position.x + 1) * 320).toBeCloseTo(x, 3); expect((1 - vertex.position.y) * 240).toBeCloseTo(y, 3);
    }
    expect(vertices.map(vertex => vertex.texCoord)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
    const before = f.cpu.pixels.slice(); info = "\\g_gametype\\0";
    await team.show(); await refresh(f.state, 75); f.commands.submit();
    let changed = 0;
    for (let y = 96; y < 129; y++) for (let x = 115; x < 205; x++) for (let channel = 0; channel < 3; channel++) {
      const index = (y * 320 + x) * 4 + channel; if (before[index] !== f.cpu.pixels[index]) changed++;
    }
    expect(changed).toBeGreaterThan(0); expect(f.events).toContain("sound:sound/misc/menu1.wav:6");
    await f.keys.keyEvent(KeyCode.Escape, true, 200); await f.keys.keyEvent(KeyCode.Escape, false, 201);
    expect(f.state.activeMenu).toBe(parent.menu); expect(f.consoleCommands.pendingText).toBe("");
  } finally { f.close(); }
});
