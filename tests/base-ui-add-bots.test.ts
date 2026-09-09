import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { ServerMessageContext } from "../src/protocol/server-message.ts";
import { BaseAddBotsMenu } from "../src/ui/base/add-bots.ts";
import { BaseUiGameInfo } from "../src/ui/base/game-info.ts";
import { cacheMenu, drawProportional } from "../src/ui/base/draw.ts";
import { drawMenu, mouseEvent, refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { COLORS, itemAt, MenuEvent, MenuFlag } from "../src/ui/base/state.ts";
import type { MenuSpin } from "../src/ui/base/state.ts";
import { UI_INVERSE, UI_SMALLFONT } from "../src/render/font.ts";
import type { DrawBatch } from "../src/render/types.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

const art = ["menu/art/back_0", "menu/art/back_1", "menu/art/accept_0", "menu/art/accept_1", "menu/art/addbotframe",
  "menu/art/arrows_vert_0", "menu/art/arrows_vert_top", "menu/art/arrows_vert_bot"];
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(names: readonly string[] | null = null, width = 160, height = 120) {
  const ui = await baseFixture(width, height), directory = names === null ? null : mkdtempSync(join(tmpdir(), "quake3-add-bots-"));
  const root = directory ?? process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  const sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: root, homePath: root, cdPath: null, product: "baseq3" }, text => { ui.prints.push(text); }, sound, ui.cvars);
  const cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
  const session = new EngineClientSession({ product: "baseq3", cvars, lifecycle, mode: { kind: "network", challenge: 1, qport: 27961 } });
  let sequence = 0;
  async function load(server = "\\g_gametype\\3"): Promise<void> {
    sequence++;
    const context: ServerMessageContext = { product: "baseq3", messageNumber: sequence, reliableSequence: 0,
      serverCommandSequence: 0, parseEntitiesNumber: 0, baseline: () => null, history: () => null };
    await session.receiveServerMessage(sequence, encodeServerMessage(0, [{ kind: "gamestate", commandSequence: 0,
      clientNumber: 7, checksumFeed: 19, entries: [{ kind: "configstring", index: 0, value: server },
        { kind: "configstring", index: 1, value: "\\sv_serverid\\100\\sv_cheats\\1\\fs_game\\" }] }], context));
  }
  function close(): void {
    try { files.close(); } finally {
      sound.close();
      lifecycle.close(); ui.close(); ui.assets.files.close();
      if (directory !== null) rmSync(directory, { recursive: true, force: true });
    }
  }
  try {
    if (directory !== null && names !== null) {
      mkdirSync(join(directory, "baseq3", "scripts"), { recursive: true });
      writeFileSync(join(directory, "baseq3", "default.cfg"), "fixture\n");
      writeFileSync(join(directory, "baseq3", "scripts", "arenas.txt"), "");
      writeFileSync(join(directory, "baseq3", "scripts", "bots.txt"), names.map(name => `{ name "${name}" }`).join("\n"), "latin1");
    }
    await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
    const game = new BaseUiGameInfo(ui.state, files); game.initialize(); await load();
    return { ...ui, files, game, session, load, owner: new BaseAddBotsMenu(ui.state, game), close };
  } catch (error) { close(); throw error; }
}
function item(f: Fixture, id: number) {
  const found = f.owner.menu.items.find(value => value.common.id === id);
  if (found === undefined) throw new Error(`Missing Add Bots item ${id}`);
  return found;
}
function spinner(f: Fixture, id: number): MenuSpin {
  const found = item(f, id); if (found.kind !== "spin") throw new Error(`Missing spinner ${id}`); return found;
}
function rows(f: Fixture) { return f.owner.menu.items.filter(value => value.kind === "proportional"); }
function names(f: Fixture) { return rows(f).map(row => row.text); }
async function activate(f: Fixture, id: number, event = MenuEvent.Activated): Promise<void> {
  const selected = item(f, id), callback = selected.common.callback;
  if (callback === null) throw new Error(`Missing Add Bots callback ${id}`);
  await callback(selected, event);
}
async function press(f: Fixture, key: number): Promise<void> {
  await f.keys.keyEvent(key, true, 10); await f.keys.keyEvent(key, false, 11);
}

test("retail catalog supplies 32 sorted bots, exact menu layout and source reset/cache order", async () => {
  const f = await fixture(); try {
    f.cvars.set("g_spSkill", "2.9", true);
    const menu = f.owner.menu, trace: string[] = [], read = f.session.getGameState.bind(f.session);
    const register = f.resources.registerShaderNoMip.bind(f.resources);
    f.session.getGameState = () => { trace.push(`config:${menu.itemCount}`); return read(); };
    f.resources.registerShaderNoMip = async name => { if (name === null) throw new Error("Authored menu cache requires a shader name"); trace.push(name); expect(menu.itemCount).toBe(0); return await register(name); };
    await f.owner.show(f.session);
    expect(trace).toEqual(["config:0", ...art]); expect(f.game.getNumBots()).toBe(32);
    expect(names(f)).toEqual(["Anarki", "Angel", "Biker", "Bitterman", "Bones", "Cadavre", "Crash"]);
    expect(menu.items.map((value): (string | number)[] => [value.kind, value.common.id, value.common.x, value.common.y, value.common.flags])).toEqual([
      ["bitmap", 0, 200, 128, 0x4000], ["bitmap", 13, 200, 128, 0x104], ["bitmap", 14, 200, 192, 0x104],
      ...Array.from({ length: 7 }, (_, n) => ["proportional", 20 + n, 264, 120 + n * 20, 0x104]),
      ["spin", 15, 320, 272, 0x102], ["spin", 16, 320, 288, 0x102], ["bitmap", 11, 320, 320, 0x104], ["bitmap", 10, 192, 320, 0x104],
    ]);
    expect([menu.cursor, menu.cursorPrev, menu.fullscreen, menu.wrapAround, menu.showlogo, menu.key]).toEqual([1, 0, false, true, false, null]);
    expect(menu.items.every((value, n) => value.common.parent === menu && value.common.menuPosition === n)).toBe(true);
    expect(rows(f).map(row => row.color)).toEqual([COLORS.white, ...new Array<typeof COLORS.normal>(6).fill(COLORS.normal)]);
    expect([spinner(f, 15).curvalue, spinner(f, 15).numitems, spinner(f, 16).itemnames]).toEqual([1, 5, ["Red", "Blue"]]);
    expect(f.state.activeMenu).toBe(menu); expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui);
    const items = menu.items.slice(), commons = items.map(value => value.common); trace.length = 0;
    await f.owner.show(f.session); expect(trace).toEqual(["config:14", ...art]); expect(f.owner.menu).toBe(menu);
    for (const [n, value] of items.entries()) { expect(menu.items[n]).toBe(value); expect(value.common).toBe(itemAt(commons, n)); }
  } finally { f.close(); }
});

test("actual keys scroll, retain row selection, change skill/team and append exact command bytes and delays", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); f.cvars.set("g_spSkill", "2.9", true); await f.owner.show(f.session);
    await setCursorToItem(f.state, f.owner.menu, item(f, 22)); await press(f, KeyCode.Enter);
    expect(rows(f).map(row => row.color)).toEqual([COLORS.normal, COLORS.normal, COLORS.white, ...new Array<typeof COLORS.normal>(4).fill(COLORS.normal)]);
    const firstRows = rows(f), bounds = firstRows.map(row => [row.common.left, row.common.right]);
    await setCursorToItem(f.state, f.owner.menu, item(f, 14)); await press(f, KeyCode.Enter);
    expect(names(f)).toEqual(["Angel", "Biker", "Bitterman", "Bones", "Cadavre", "Crash", "Daemia"]);
    expect(rows(f)).toEqual(firstRows); expect(rows(f).map(row => [row.common.left, row.common.right])).toEqual(bounds);
    await setCursorToItem(f.state, f.owner.menu, item(f, 15)); await press(f, KeyCode.Right);
    await setCursorToItem(f.state, f.owner.menu, item(f, 16)); await press(f, KeyCode.KeypadRight);
    await setCursorToItem(f.state, f.owner.menu, item(f, 11)); await press(f, KeyCode.Enter); await press(f, KeyCode.Enter);
    expect(f.consoleCommands.pendingText).toBe("addbot Bitterman 3 Blue 1000\naddbot Bitterman 3 Blue 2500\n");
    expect(f.cvars.get("g_spSkill")?.value).toBe("2.9"); expect(f.state.menuDepth).toBe(1);
    for (let n = 0; n < 40; n++) await activate(f, 14);
    const bottom = names(f); await activate(f, 14); expect(names(f)).toEqual(bottom);
    expect(bottom).toEqual(["Sorlag", "Stripe", "TankJr", "Uriel", "Visor", "Wrack", "Xaero"]);
    for (let n = 0; n < 40; n++) await activate(f, 13);
    expect(names(f)).toEqual(["Anarki", "Angel", "Biker", "Bitterman", "Bones", "Cadavre", "Crash"]);
    expect(f.events).toContain("sound:sound/misc/menu2.wav:6");
    f.state.cursorX = 200; f.state.cursorY = 340; await mouseEvent(f.state, 0, 0); await press(f, KeyCode.Mouse1);
    expect(f.state.menuDepth).toBe(0); expect(f.keys.getCatcher()).toBe(0);
  } finally { f.close(); }
});

test("sparse and empty catalogs still perform all seven source name reads", async () => {
  for (const botNames of [[], ["Zulu", "Alpha"]]) {
    const f = await fixture(botNames); try {
      f.cvars.set("g_spSkill", "1", true);
      await f.load("\\g_gametype\\0"); const calls: number[] = [], get = f.game.getBotInfoByNumber.bind(f.game);
      f.game.getBotInfoByNumber = n => { calls.push(n); return get(n); };
      await f.owner.show(f.session);
      expect(calls.slice(-7)).toEqual(botNames.length === 0 ? [0, 0, 0, 0, 0, 0, 0] : [1, 0, 0, 0, 0, 0, 0]);
      expect(names(f)).toEqual(botNames.length === 0 ? [] : ["Alpha", "Zulu"]);
      expect(f.owner.menu.itemCount).toBe(7 + botNames.length);
      expect([spinner(f, 15).common.y, spinner(f, 16).common.y]).toEqual([132 + botNames.length * 20, 148 + botNames.length * 20]);
      expect(spinner(f, 16).common.flags).toBe(MenuFlag.Grayed); expect(spinner(f, 16).itemnames).toEqual(["Free"]);
      if (botNames.length === 0) expect(f.prints.filter(text => text === "^1Invalid bot number: 0\n")).toHaveLength(7);
      await activate(f, 11); expect(f.consoleCommands.pendingText).toBe(`addbot ${botNames.length === 0 ? "" : "Alpha"} 1 Free 1000\n`);
      const before = calls.length; await activate(f, 13); await activate(f, 14); expect(calls.length).toBe(before);
    } finally { f.close(); }
  }
});

test("source Q_stricmp folds ASCII to uppercase and bg_lib qsort preserves its unstable equal-key order", async () => {
  const cases = [
    { input: ["[", "alpha", "_", "Bravo", "A", "\u0080"], output: ["\u0080", "A", "alpha", "Bravo", "[", "_"] },
    { input: ["alpha", "Alpha", "aLpha", "ALpha", "alPha", "AlPha", "aLPha"],
      output: ["ALpha", "Alpha", "aLpha", "alpha", "alPha", "AlPha", "aLPha"] },
    { input: ["alpha", "Alpha", "aLpha", "ALpha", "alPha", "AlPha", "aLPha", "ALPha"],
      output: ["ALPha", "Alpha", "aLpha", "ALpha", "alPha", "AlPha", "aLPha", "alpha"] },
    { input: Array.from({ length: 45 }, (_, n) => `Bot${String(44 - n).padStart(2, "0")}`),
      output: Array.from({ length: 45 }, (_, n) => `Bot${String(n).padStart(2, "0")}`) },
  ];
  for (const c of cases) {
    const f = await fixture(c.input); try {
      await f.owner.show(f.session); const actual = names(f);
      for (let n = 7; n < c.input.length; n++) { await activate(f, 14); actual.push(itemAt(names(f), 6)); }
      expect(actual).toEqual(c.output);
    } finally { f.close(); }
  }
});

test("bounded bot names retain spaces and colors; skill follows binary32 QVM conversion and captured server info", async () => {
  const long = "^1Named Bot " + "z".repeat(40), f = await fixture([long]); try {
    const cases: readonly [string, number][] = [["2.9", 1], ["-2", 0], ["9", 4], ["2147483648", 4], ["-2147483648", 4]];
    for (const [value, expected] of cases) {
      f.cvars.set("g_spSkill", value, true); await f.owner.show(f.session); expect(spinner(f, 15).curvalue).toBe(expected);
    }
    f.cvars.set("g_spSkill", "5", true); await f.owner.show(f.session);
    expect(names(f)).toEqual([long.slice(0, 31)]);
    await f.load("\\g_gametype\\0"); await activate(f, 11); await activate(f, 11, MenuEvent.GotFocus);
    expect(f.consoleCommands.pendingText).toBe(`addbot ${long.slice(0, 31)} 5 Red 1000\n`);
    await f.owner.show(f.session); await activate(f, 11);
    expect(f.consoleCommands.pendingText).toBe(`addbot ${long.slice(0, 31)} 5 Red 1000\naddbot ${long.slice(0, 31)} 5 Free 1000\n`);
  } finally { f.close(); }
});

test("cache failure preserves reset before registration; reopen retains records and retirement prevents continuation", async () => {
  const f = await fixture(["Sarge"]); try {
    await f.owner.show(f.session); const menu = f.owner.menu, row = item(f, 20), register = f.resources.registerShaderNoMip.bind(f.resources);
    const failure = new Error("Add Bots shader failed"), calls: string[] = [];
    f.resources.registerShaderNoMip = async name => { if (name === null) throw new Error("Authored menu cache requires a shader name"); calls.push(name); if (name === art[3]) throw failure; return await register(name); };
    await expect(f.owner.show(f.session)).rejects.toBe(failure);
    expect(calls).toEqual(art.slice(0, 4)); expect(menu.itemCount).toBe(0); expect(menu.items).toEqual([]);
    expect(f.state.activeMenu).toBe(menu); expect(row.common.callback).toBeNull();
    f.resources.registerShaderNoMip = register; await f.owner.show(f.session); expect(item(f, 20)).toBe(row);
    const read = f.session.getGameState.bind(f.session);
    f.session.getGameState = () => { throw failure; };
    await expect(f.owner.show(f.session)).rejects.toBe(failure); expect(menu.itemCount).toBe(8);
    f.session.getGameState = read;
    const gate = deferred(), entered = deferred(); let registrations = 0;
    f.resources.registerShaderNoMip = async name => { registrations++; entered.resolve(); await gate.promise; return await register(name); };
    const pending = f.owner.show(f.session); await entered.promise; f.state.retire(); gate.resolve();
    await expect(pending).rejects.toThrow("retired"); expect(registrations).toBe(1); expect(menu.itemCount).toBe(0);
    await expect(f.owner.cache()).rejects.toThrow("retired");
  } finally { f.close(); }
});

test("protocol server info is copied to 1024-byte storage once and parses gametype with source atoi", async () => {
  const f = await fixture(["Sarge"]); try {
    for (const [server, team] of [
      [`\\padding\\${"x".repeat(1001)}\\g_gametype\\4`, "Red"],
      [`\\padding\\${"x".repeat(1002)}\\g_gametype\\4`, "Free"],
      ["\\g_gametype\\4294967299tail", "Red"],
    ]) {
      if (server === undefined || team === undefined) throw new Error("Missing source server-info fixture");
      await f.load(server); await f.owner.show(f.session); expect(spinner(f, 16).itemnames[0]).toBe(team);
    }
    const read = f.session.getGameState.bind(f.session), register = f.resources.registerShaderNoMip.bind(f.resources);
    let reads = 0, changed = false;
    f.session.getGameState = () => { reads++; return read(); };
    f.resources.registerShaderNoMip = async name => {
      if (!changed) { changed = true; await f.load("\\g_gametype\\0"); }
      return await register(name);
    };
    await f.owner.show(f.session); expect(reads).toBe(1); expect(spinner(f, 16).itemnames).toEqual(["Red", "Blue"]);
    await f.owner.show(f.session); expect(reads).toBe(2); expect(spinner(f, 16).itemnames).toEqual(["Free"]);
  } finally { f.close(); }
});

test("actual CPU queue draws the banner, background, seven proportional rows and source colors", async () => {
  const f = await fixture(null, 640, 480); try {
    const reference = await fixture(null, 640, 480); try {
      await cacheMenu(f.state); await f.owner.show(f.session); f.state.realtime = 1000;
      await cacheMenu(reference.state); reference.state.realtime = 1000;
      const rowItems = rows(f), otherItems = f.owner.menu.items.filter(value => value.kind !== "proportional");
      for (const value of otherItems) value.common.flags |= MenuFlag.Hidden;
      await drawMenu(f.state, f.owner.menu); expect(f.commands.submitFrame()?.batches).toBeGreaterThan(0);
      const actual = f.recorder.trace().flatMap(view => view.batches);
      for (const [n, row] of rowItems.entries()) drawProportional(reference.state, 264, 120 + n * 20, row.text, UI_SMALLFONT | UI_INVERSE, n === 0 ? COLORS.white : COLORS.normal);
      expect(reference.commands.submitFrame()).not.toBeNull(); const expected = reference.recorder.trace().flatMap(view => view.batches);
      const indexed = (batches: readonly DrawBatch[]) => batches.flatMap(batch => batch.indices.map(index => {
        if (batch.texture.kind !== "bind-image") throw new Error("Menu text must bind its registered image");
        return { vertex: itemAt(batch.vertices, index), state: batch.state, texture: batch.texture.image.name, texturing: batch.texturing, primitive: batch.primitive };
      }));
      expect(indexed(actual)).toEqual(indexed(expected));
      expect(f.cpu.pixels).toEqual(reference.cpu.pixels);
      for (const value of otherItems) value.common.flags &= ~MenuFlag.Hidden;
      await refresh(f.state, 1000); expect(f.commands.submit().batches).toBeGreaterThan(0);
      const textures = f.recorder.trace().flatMap(view => view.batches).flatMap(batch => batch.texture.kind === "bind-image" ? [batch.texture.image.name] : []);
      expect(textures).toContain("menu/art/addbotframe.tga"); expect(textures).toContain("menu/art/font2_prop.tga");
      expect(f.cpu.pixels.some(value => value !== 0)).toBe(true);
    } finally { reference.close(); }
  } finally { f.close(); }
});
