import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { infoValueForKey } from "../src/core/info-string.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { BaseUiGameInfo } from "../src/ui/base/game-info.ts";
import { BaseStartServerMenu } from "../src/ui/base/start-server.ts";
import { cacheMenu, drawChar, drawString, fillRect } from "../src/ui/base/draw.ts";
import { drawMenu, mouseEvent, popMenu, setCursorToItem } from "../src/ui/base/framework.ts";
import { COLORS, itemAt, MenuEvent, MenuFlag } from "../src/ui/base/state.ts";
import type { BaseMenu, BaseMenuItem, MenuBitmap, MenuFieldItem, MenuSpin, MenuText } from "../src/ui/base/state.ts";
import { UI_BLINK, UI_CENTER, UI_LEFT, UI_PULSE, UI_RIGHT, UI_SMALLFONT } from "../src/render/font.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

const startArt = ["menu/art/back_0", "menu/art/back_1", "menu/art/next_0", "menu/art/next_1", "menu/art/frame2_l", "menu/art/frame1_r",
  "menu/art/maps_select", "menu/art/maps_selected", "menu/art/unknownmap", "menu/art/gs_arrows_0", "menu/art/gs_arrows_l", "menu/art/gs_arrows_r"];
const optionArt = ["menu/art/back_0", "menu/art/back_1", "menu/art/fight_0", "menu/art/fight_1", "menu/art/maps_select", "menu/art/unknownmap"];
const botArt = ["menu/art/back_0", "menu/art/back_1", "menu/art/accept_0", "menu/art/accept_1", "menu/art/opponents_select", "menu/art/opponents_selected",
  "menu/art/gs_arrows_0", "menu/art/gs_arrows_l", "menu/art/gs_arrows_r"];
interface Catalog { readonly arenas: string; readonly bots: string; }
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(catalog: Catalog | null = null, width = 160, height = 120) {
  const ui = await baseFixture(width, height), directory = catalog === null ? null : mkdtempSync(join(tmpdir(), "quake3-start-server-"));
  const root = directory ?? process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  const sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: root, homePath: root, cdPath: null, product: "baseq3" }, text => { ui.prints.push(text); }, sound, ui.cvars);
  function close(): void { try { files.close(); } finally { sound.close(); ui.close(); ui.assets.files.close(); if (directory !== null) rmSync(directory, { recursive: true, force: true }); } }
  try {
    if (directory !== null && catalog !== null) {
      mkdirSync(join(directory, "baseq3", "scripts"), { recursive: true });
      writeFileSync(join(directory, "baseq3", "default.cfg"), "fixture\n");
      writeFileSync(join(directory, "baseq3", "scripts", "arenas.txt"), catalog.arenas, "latin1");
      writeFileSync(join(directory, "baseq3", "scripts", "bots.txt"), catalog.bots, "latin1");
    }
    await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
    const game = new BaseUiGameInfo(ui.state, files); game.initialize();
    ui.cvars.set("name", "^1Local Player", true); ui.cvars.set("sv_hostname", "A local host", true); ui.cvars.set("sv_pure", "1", true);
    await cacheMenu(ui.state);
    return { ...ui, files, game, owner: new BaseStartServerMenu(ui.state, game), close };
  } catch (error) { close(); throw error; }
}
function active(f: Fixture): BaseMenu { const menu = f.state.activeMenu; if (menu === null) throw new Error("Expected actual active menu"); return menu; }
function find(menu: BaseMenu, predicate: (item: BaseMenuItem) => boolean): BaseMenuItem {
  const item = menu.items.find(predicate); if (item === undefined) throw new Error("Missing source menu item"); return item;
}
function byId(menu: BaseMenu, id: number): BaseMenuItem { return find(menu, item => item.common.id === id && item.common.callback !== null); }
function byName(menu: BaseMenu, name: string): BaseMenuItem { return find(menu, item => item.common.name === name); }
function spinner(item: BaseMenuItem): MenuSpin { if (item.kind !== "spin") throw new Error("Expected spin control"); return item; }
function field(item: BaseMenuItem): MenuFieldItem { if (item.kind !== "field") throw new Error("Expected field"); return item; }
function names(menu: BaseMenu): MenuText[] { return menu.items.filter(item => item.kind === "text").filter(item => item.common.x === 96); }
function types(menu: BaseMenu): MenuSpin[] { return menu.items.filter(item => item.kind === "spin").filter(item => item.common.id === 20); }
function teams(menu: BaseMenu): MenuSpin[] { return menu.items.filter(item => item.kind === "spin").filter(item => item.common.x === 240); }
function botNames(menu: BaseMenu): MenuText[] { return menu.items.filter(item => item.kind === "text"); }
function mapPictures(menu: BaseMenu): MenuBitmap[] { return menu.items.filter(item => item.kind === "bitmap").filter(item => item.common.ownerdraw !== null); }
function arrow(menu: BaseMenu, direction: "left" | "right"): BaseMenuItem { return find(menu, item => item.kind === "bitmap" && item.focuspic === `menu/art/gs_arrows_${direction === "left" ? "l" : "r"}`); }
async function activate(item: BaseMenuItem, event = MenuEvent.Activated): Promise<void> { const callback = item.common.callback; if (callback === null) throw new Error("Expected source callback"); await callback(item, event); }
async function press(f: Fixture, key: number): Promise<void> { await f.keys.keyEvent(key, true, 10); await f.keys.keyEvent(key, false, 11); }
async function keyOn(f: Fixture, item: BaseMenuItem, key = KeyCode.Enter): Promise<void> { await setCursorToItem(f.state, active(f), item); await press(f, key); }
async function openOptions(f: Fixture, multiplayer = false, gametype = 0): Promise<BaseMenu> {
  await f.owner.show(multiplayer); const type = spinner(byId(active(f), 10));
  for (let n = 0; n < gametype; n++) await keyOn(f, type, KeyCode.Right);
  await keyOn(f, byId(active(f), 18)); return active(f);
}

test("retail Start Server has the original four-map grid, cache order, default gametype and stable records", async () => {
  const f = await fixture(); try {
    f.cvars.set("g_gameType", "4", true); const menu = f.owner.menu, trace: string[] = [], register = f.resources.registerShaderNoMip.bind(f.resources);
    f.resources.registerShaderNoMip = async name => { if (name === null) throw new Error("Authored menu cache requires a shader name"); trace.push(name); expect(menu.itemCount).toBe(0); return await register(name); };
    await f.owner.show(true); expect(trace).toEqual(startArt); f.resources.registerShaderNoMip = register;
    expect(f.owner.menu).toBe(menu); expect(f.state.activeMenu).toBe(menu); expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui);
    expect([menu.itemCount, menu.cursor, menu.wrapAround, menu.fullscreen]).toEqual([19, 3, true, true]);
    expect(spinner(byId(menu, 10)).curvalue).toBe(0); expect(f.cvars.get("g_gameType")?.value).toBe("4");
    expect(mapPictures(menu).map(pic => [pic.common.x, pic.common.y, pic.width, pic.height, pic.common.id])).toEqual([
      [188, 96, 128, 96, 11], [324, 96, 128, 96, 12], [188, 232, 128, 96, 13], [324, 232, 128, 96, 14],
    ]);
    expect(mapPictures(menu)[0]?.common.name).toBe("levelshots/Q3DM1");
    const items = menu.items.slice(), mapname = find(menu, item => item.kind === "proportional");
    expect(mapname.common.right - mapname.common.left).toBe(3);
    await keyOn(f, byId(menu, 16)); expect(mapPictures(menu)[0]?.common.name).not.toBe("levelshots/Q3DM1");
    expect(mapPictures(menu).every(pic => (pic.common.flags & MenuFlag.Highlight) === 0)).toBe(true);
    await keyOn(f, byId(menu, 12)); expect(itemAt(mapPictures(menu), 1).common.flags & MenuFlag.Highlight).toBe(MenuFlag.Highlight);
    const selected = mapname.kind === "proportional" ? mapname.text : null; expect(selected).not.toBe("Q3DM1");
    await f.owner.show(false); expect(menu.items).toEqual(items); for (const [n, item] of items.entries()) expect(menu.items[n]).toBe(item);
    expect(mapname.common.right - mapname.common.left).toBeGreaterThan(6); expect(mapPictures(menu)[0]?.common.name).toBe("levelshots/Q3DM1");
  } finally { f.close(); }
});

test("shared COM_ParseExt filters all four gametypes, honors line/comment barriers, truncates map names and disables empty pages", async () => {
  const f = await fixture({ arenas: [
    '{ map abcdefghijklmnopqrstuvwxyz type "ffa team" }', '{ map solo type "single" special training }', '{ map tournament type "tourney" }',
    '{ map capture type "ctf" }', '{ map line type "ffa\nctf" }', '{ map comment type "team /* x\ny */ ctf" }', '{ map none type "unknown" }',
  ].join("\n"), bots: "" }); try {
    await f.owner.show(false); const menu = active(f), type = spinner(byId(menu, 10));
    expect(mapPictures(menu).map(pic => pic.common.name)).toEqual(["levelshots/SOLO", "levelshots/ABCDEFGHIJKLMNO", "levelshots/LINE", null]);
    expect(byId(menu, 14).common.flags & MenuFlag.Inactive).toBe(MenuFlag.Inactive);
    await keyOn(f, type, KeyCode.Right); expect(mapPictures(menu).map(pic => pic.common.name)).toEqual(["levelshots/ABCDEFGHIJKLMNO", "levelshots/COMMENT", null, null]);
    await keyOn(f, type, KeyCode.Right); expect(mapPictures(menu).map(pic => pic.common.name)).toEqual(["levelshots/TOURNAMENT", null, null, null]);
    await keyOn(f, type, KeyCode.Right); expect(mapPictures(menu).map(pic => pic.common.name)).toEqual(["levelshots/CAPTURE", "levelshots/COMMENT", null, null]);
    expect(f.state.sourceParser.token).toBe("");
  } finally { f.close(); }
  const empty = await fixture({ arenas: "", bots: "" }); try {
    await empty.owner.show(true); expect(mapPictures(active(empty)).every(pic => pic.common.name === null)).toBe(true);
    expect(byId(active(empty), 18).common.flags & MenuFlag.Inactive).toBe(MenuFlag.Inactive);
    expect(active(empty).items.some(item => item.kind === "proportional" && item.text === "NO MAPS FOUND")).toBe(true);
  } finally { empty.close(); }
});

test("cache honors source int precache conversion, 64-map capacity and reached overflow instead of a catalog stand-in", async () => {
  const catalog = (count: number): Catalog => ({ arenas: Array.from({ length: count }, (_, n) => `{ map m${n} type ffa }`).join("\n"), bots: "" });
  const f = await fixture(catalog(64)); try {
    const read = f.game.getArenaInfoByNumber.bind(f.game), indices: number[] = [];
    f.game.getArenaInfoByNumber = n => { indices.push(n); return read(n); };
    f.cvars.set("com_buildscript", "0.5", true); f.registrations.length = 0; await f.owner.cache();
    expect(f.registrations).toEqual(startArt.map(name => `shader:${name}`)); expect(indices).toHaveLength(64);
    f.cvars.set("com_buildscript", "1", true); f.registrations.length = 0; await f.owner.cache();
    expect(f.registrations).toEqual([...startArt.map(name => `shader:${name}`), ...Array.from({ length: 64 }, (_, n) => `shader:levelshots/M${n}`)]);
    await f.owner.show(false); for (let n = 0; n < 20; n++) await activate(byId(active(f), 16));
    expect(mapPictures(active(f))[3]?.common.name).toBe("levelshots/M63");
  } finally { f.close(); }
  const over = await fixture(catalog(65)); try {
    const read = over.game.getArenaInfoByNumber.bind(over.game), indices: number[] = [];
    over.game.getArenaInfoByNumber = n => { indices.push(n); return read(n); };
    await expect(over.owner.show(true)).rejects.toThrow("array index 64"); expect(indices).toEqual(Array.from({ length: 65 }, (_, n) => n));
    expect(over.owner.menu.itemCount).toBe(0); expect(over.state.menuDepth).toBe(0);
  } finally { over.close(); }
});

test("actual keys enter every local and multiplayer game mode with source limits, slot/team controls and menu order", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state);
    for (const multiplayer of [false, true]) for (const [index, game, limitName, limit, time, clientCount] of [
      [0, 0, "Frag Limit:", "20", "0", 8], [1, 3, "Frag Limit:", "0", "20", 8], [2, 1, "Frag Limit:", "0", "15", 8], [3, 4, "Capture Limit:", "8", "30", 6],
    ] satisfies [number, number, string, string, string, number][]) {
      const menu = await openOptions(f, multiplayer, index); expect(f.cvars.get("g_gameType")?.value).toBe(String(game));
      expect(field(byName(menu, limitName)).field.text).toBe(limit); expect(field(byName(menu, "Time Limit:")).field.text).toBe(time);
      expect(menu.items.some(item => item.common.name === "Dedicated:")).toBe(multiplayer); expect(menu.items.some(item => item.common.name === "Hostname:")).toBe(multiplayer);
      expect(menu.items.some(item => item.common.name === "Friendly Fire:")).toBe(game >= 3);
      expect(names(menu)).toHaveLength(12); expect(types(menu)).toHaveLength(11); expect(teams(menu)).toHaveLength(game >= 3 ? 12 : 0);
      expect(names(menu)[0]?.text).toBe("Local Player"); expect(itemAt(names(menu), 0).common.flags & MenuFlag.Inactive).toBe(MenuFlag.Inactive);
      expect(spinner(byName(menu, "Bot Skill:  ")).curvalue).toBe(1);
      const pb = spinner(byName(menu, "Punkbuster:")); expect(pb.itemnames).toEqual(["Disabled", "Enabled"]); expect(menu.items.at(-1)).toBe(pb);
      expect(itemAt(menu.items.filter(item => item.common.id === 18), 0).common.flags & MenuFlag.Hidden).toBe(MenuFlag.Hidden);
      if (game >= 3) {
        expect(teams(menu).map(team => team.curvalue)).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
        expect(types(menu).filter(type => type.curvalue !== 2).length + 1).toBe(clientCount);
        expect(names(menu)[1]?.text).toBe("grunt"); expect(names(menu)[6]?.text).toBe("sarge");
      }
      expect(menu.items.every((item, n) => item.common.parent === menu && item.common.menuPosition === n)).toBe(true);
      await keyOn(f, byId(menu, 24)); expect(active(f)).toBe(f.owner.menu); await press(f, KeyCode.Escape); expect(f.state.menuDepth).toBe(0);
    }
    expect(f.events).toContain("sound:sound/misc/menu2.wav:6");
  } finally { f.close(); }
});

test("CTF launch preserves source cvar names and exact wait/map/addbot/team command order", async () => {
  const f = await fixture(); try {
    const menu = await openOptions(f, false, 3), map = infoValueForKey(f.game.getArenaInfoByMap("q3ctf1") ?? "", "map"); expect(map).toBe("q3ctf1");
    field(byName(menu, "Capture Limit:")).field.setText("17"); field(byName(menu, "Time Limit:")).field.setText("-8");
    const friendly = byName(menu, "Friendly Fire:"); await keyOn(f, friendly, KeyCode.Right);
    await keyOn(f, byName(menu, "Punkbuster:"), KeyCode.Right);
    const trace: string[] = [], set = f.cvars.set.bind(f.cvars), append = f.consoleCommands.append.bind(f.consoleCommands);
    f.cvars.set = (name, value, force) => { trace.push(`${name}=${value}`); return set(name, value, force); };
    f.consoleCommands.append = value => { trace.push(value); append(value); };
    await keyOn(f, byId(menu, 23));
    expect(trace).toEqual([
      "ui_ctf_fraglimit=0", "ui_ctf_timelimit=-8", "ui_ctf_friendlt=1", "sv_maxclients=6", "dedicated=0", "timelimit=0", "fraglimit=0", "capturelimit=17",
      "g_friendlyfire=1", "sv_pure=1", "sv_hostname=A local host", "sv_punkbuster=1", "wait ; wait ; map Q3CTF1\n", "wait 3\n",
      "addbot grunt 2 Blue\n", "addbot major 2 Blue\n", "addbot sarge 2 Red\n", "addbot grunt 2 Red\n", "addbot major 2 Red\n", "wait 5; team Blue\n",
    ]);
    expect(f.cvars.get("ui_ctf_capturelimit")?.value).toBe("8"); expect(f.cvars.get("ui_ctf_friendly")?.value).toBe("0");
    expect(f.state.activeMenu).toBe(menu); expect(f.state.menuDepth).toBe(2);
  } finally { f.close(); }
});

test("slot types, dedicated changes on all source events, team selection and multiplayer bot commands use real controls", async () => {
  const f = await fixture(); try {
    const menu = await openOptions(f, true, 1), dedicated = spinner(byName(menu, "Dedicated:")), playerNames = names(menu);
    await keyOn(f, itemAt(types(menu), 0), KeyCode.Right); expect(itemAt(playerNames, 1).common.flags & MenuFlag.Hidden).toBe(0);
    await keyOn(f, itemAt(teams(menu), 1), KeyCode.Right);
    await keyOn(f, dedicated, KeyCode.Right); expect(itemAt(playerNames, 0).common.flags & MenuFlag.Hidden).toBe(MenuFlag.Hidden);
    dedicated.curvalue = 0; await activate(dedicated, MenuEvent.LostFocus); expect(itemAt(playerNames, 0).common.flags & MenuFlag.Hidden).toBe(0);
    dedicated.curvalue = 2; await activate(dedicated, MenuEvent.GotFocus); expect(itemAt(playerNames, 0).common.flags & MenuFlag.Hidden).toBe(MenuFlag.Hidden);
    await keyOn(f, byId(menu, 23)); expect(f.cvars.get("dedicated")?.value).toBe("2");
    expect(f.consoleCommands.pendingText).toBe("wait ; wait ; map Q3DM6\nwait 3\naddbot grunt 2 Red\n");
    expect(f.cvars.get("sv_maxclients")?.value).toBe("8");
  } finally { f.close(); }
});

test("real Bot Select pages icons, marks same-team duplicates, accepts on pop and assigns only during the options levelshot draw", async () => {
  const f = await fixture(null, 640, 480); try {
    await cacheMenu(f.state); const options = await openOptions(f, false, 1), row = itemAt(names(options), 1);
    f.registrations.length = 0; await keyOn(f, row); const bots = active(f); expect(f.state.menuDepth).toBe(3); expect(bots.itemCount).toBe(54);
    expect(f.registrations.slice(0, 9)).toEqual(botArt.map(name => `shader:${name}`));
    expect(botNames(bots).slice(0, 4).map(item => item.text)).toEqual(["Anarki", "Angel", "Biker", "Bitterman"]);
    expect(botNames(bots).find(item => item.text === "Grunt")?.color).toBe(COLORS.red);
    const icons = bots.items.filter(item => item.kind === "bitmap" && item.focuspic === "menu/art/opponents_selected");
    expect(icons.every(item => item.common.name?.startsWith("models/players/"))).toBe(true);
    expect(arrow(bots, "left").common.flags & MenuFlag.Inactive).toBe(MenuFlag.Inactive);
    await keyOn(f, arrow(bots, "right")); expect(botNames(bots).find(item => item.text === "Sarge")?.color).toEqual(COLORS.normal);
    expect(arrow(bots, "right").common.flags & MenuFlag.Inactive).toBe(MenuFlag.Inactive);
    await keyOn(f, arrow(bots, "left"));
    await keyOn(f, find(bots, item => item.kind === "bitmap" && item.common.id === 1 && item.common.callback !== null));
    const previous = row.text; await keyOn(f, byName(bots, "menu/art/accept_0")); expect(active(f)).toBe(options); expect(row.text).toBe(previous);
    await drawMenu(f.state, options); expect(row.text).toBe("Angel"); expect(f.commands.submit().batches).toBeGreaterThan(0); expect(f.cpu.pixels.some(value => value !== 0)).toBe(true);
    await keyOn(f, row); expect(active(f)).toBe(bots); await keyOn(f, byName(bots, "menu/art/back_0"));
    await drawMenu(f.state, options); expect(row.text).toBe("Angel"); f.commands.submit();
    await keyOn(f, byId(options, 23)); expect(f.consoleCommands.pendingText).toContain("addbot Angel 2 Blue\n");
  } finally { f.close(); }
});

test("source qsort equal-name order, bounded cleaned names, icon fallback, absent bots and page dead slots", async () => {
  const spellings = ["alpha", "Alpha", "aLpha", "ALpha", "alPha", "AlPha", "aLPha", "ALPha"];
  const f = await fixture({ arenas: '{ map one type ffa bots "alpha" }', bots: spellings.map(name => `{ name ${name} model sarge/missing }`).join("\n") }); try {
    const options = await openOptions(f), row = itemAt(names(options), 1); await keyOn(f, row); const menu = active(f);
    expect(botNames(menu).slice(0, 8).map(item => item.text)).toEqual(["ALPha", "Alpha", "aLpha", "ALpha", "alPha", "AlPha", "aLPha", "alpha"]);
    expect(botNames(menu).slice(8).every(item => item.text === "")).toBe(true);
    expect(menu.items.filter(item => item.kind === "bitmap" && item.focuspic === "menu/art/opponents_selected").slice(0, 8).map(item => item.common.name)).toEqual(new Array<string>(8).fill("models/players/sarge/icon_default.tga"));
    expect(menu.items.filter(item => item.kind === "bitmap" && item.focuspic === "menu/art/opponents_select").slice(8).every(item => (item.common.flags & MenuFlag.Inactive) !== 0)).toBe(true);
    expect(botNames(menu).slice(0, 8).every(item => item.color === COLORS.red)).toBe(true);
  } finally { f.close(); }
  const empty = await fixture({ arenas: '{ map one type ffa bots "absent  " }', bots: "" }); try {
    const menu = await openOptions(empty), row = itemAt(names(menu), 1); expect(row.text).toBe(""); expect(names(menu)[2]?.text).toBe("");
    await keyOn(empty, row); expect(botNames(active(empty)).every(item => item.text === "")).toBe(true);
    await keyOn(empty, byName(active(empty), "menu/art/accept_0")); await drawMenu(empty.state, menu);
    expect(row.text).toBe(""); await keyOn(empty, byId(menu, 23)); expect(empty.cvars.get("sv_maxclients")?.value).toBe("6");
    expect(empty.consoleCommands.pendingText).toBe("wait ; wait ; map ONE\nwait 3\n");
  } finally { empty.close(); }
});

test("bot input uses source space-only seeding and truncation before color cleanup", async () => {
  const f = await fixture({ arenas: '{ map one type ffa bots "^1LongNameWithMoreThan15 A\tB" }', bots:
    '{ name "^1LongNameWithMoreThan15" model sarge }\n{ name "A\tB" model major }' }); try {
    const menu = await openOptions(f); expect(names(menu)[1]?.text).toBe("^1LongNameWithM"); expect(names(menu)[2]?.text).toBe("A\tB");
    await keyOn(f, itemAt(names(menu), 1)); const bots = active(f);
    expect(botNames(bots).slice(0, 2).map(item => item.text)).toEqual(["AB", "LongNameWithM"]);
    await keyOn(f, find(bots, item => item.kind === "bitmap" && item.common.id === 1 && item.common.callback !== null));
    await keyOn(f, byName(bots, "menu/art/accept_0")); await drawMenu(f.state, menu);
    expect(names(menu)[1]?.text).toBe("LongNameWithM");
    await keyOn(f, byId(menu, 23)); expect(f.consoleCommands.pendingText).toBe("wait ; wait ; map ONE\nwait 3\naddbot LongNameWithM 2\naddbot A\tB 2\n");
  } finally { f.close(); }
});

test("menu cache failures preserve source resets and partial stores; retirement stops awaited continuation", async () => {
  const f = await fixture(); try {
    const menu = await openOptions(f), items = menu.items.slice(), register = f.resources.registerShaderNoMip.bind(f.resources), failure = new Error("source cache failed");
    await popMenu(f.state); const calls: string[] = [];
    f.resources.registerShaderNoMip = async name => { if (name === null) throw new Error("Authored menu cache requires a shader name"); calls.push(name); if (name === optionArt[3]) throw failure; return await register(name); };
    await expect(activate(byId(active(f), 18))).rejects.toBe(failure); expect(calls).toEqual(optionArt.slice(0, 4)); expect(menu.itemCount).toBe(0);
    expect(items.every(item => item.common.parent === null)).toBe(true); expect(f.state.menuDepth).toBe(1);
    f.resources.registerShaderNoMip = register; await activate(byId(active(f), 18)); expect(active(f)).toBe(menu);
    for (const [n, item] of items.entries()) expect(menu.items[n]).toBe(item);
    await popMenu(f.state); const entered = deferred(), gate = deferred(); let registrations = 0;
    f.resources.registerShaderNoMip = async name => { registrations++; entered.resolve(); await gate.promise; return await register(name); };
    const pending = activate(byId(active(f), 18)); await entered.promise; f.state.retire(); gate.resolve();
    await expect(pending).rejects.toThrow("retired"); expect(registrations).toBe(1); expect(menu.itemCount).toBe(0);
    await expect(f.owner.cacheBotSelect()).rejects.toThrow("retired");
  } finally { f.close(); }
});

test("actual CPU player-name ownerdraw matches source bounds, cursor, color and text draws", async () => {
  const f = await fixture(null, 640, 480); try {
    const reference = await fixture(null, 640, 480); try {
      await cacheMenu(f.state); const menu = await openOptions(f), row = itemAt(names(menu), 1); await setCursorToItem(f.state, menu, row); f.state.realtime = 1000;
      await cacheMenu(reference.state); reference.state.realtime = 1000;
      const draw = row.common.ownerdraw; if (draw === null) throw new Error("Missing source PlayerName_Draw");
      await draw(row); expect(f.commands.submitFrame()).not.toBeNull(); const actual = f.recorder.trace().flatMap(view => view.batches);
      const c = row.common;
      fillRect(reference.state, c.left, c.top, c.right - c.left + 1, c.bottom - c.top + 1, COLORS.listbar);
      drawChar(reference.state, 96, 132, 13, UI_CENTER | UI_BLINK | UI_SMALLFONT, COLORS.highlight);
      drawString(reference.state, 88, 132, null, UI_SMALLFONT | UI_PULSE | UI_RIGHT, COLORS.highlight);
      drawString(reference.state, 104, 132, row.text, UI_SMALLFONT | UI_PULSE | UI_LEFT, COLORS.highlight);
      expect(reference.commands.submitFrame()).not.toBeNull();
      const batches = (values: typeof actual) => values.map(batch => {
        if (batch.texture.kind !== "bind-image") throw new Error("Menu text must bind its registered image");
        return { ...batch, texture: batch.texture.image.name };
      });
      expect(batches(reference.recorder.trace().flatMap(view => view.batches))).toEqual(batches(actual));
      expect(f.cpu.pixels).toEqual(reference.cpu.pixels);
      expect(f.cpu.pixels.some(value => value !== 0)).toBe(true);
      f.state.cursorX = 10; f.state.cursorY = 430; await mouseEvent(f.state, 0, 0); await press(f, KeyCode.Mouse1); expect(active(f)).toBe(f.owner.menu);
    } finally { reference.close(); }
  } finally { f.close(); }
});

test("limit initialization stores binary32/clamped integers and real field keys retain the hidden hostname bytes", async () => {
  const f = await fixture(); try {
    f.cvars.set("ui_ffa_fraglimit", "10000", true); f.cvars.set("ui_ffa_timelimit", "9.9999999", true);
    f.cvars.set("sv_hostname", "z".repeat(300), true); f.cvars.set("sv_punkbuster", ".99", true);
    const menu = await openOptions(f, false), frag = field(byName(menu, "Frag Limit:")), time = field(byName(menu, "Time Limit:"));
    expect(frag.field.text).toBe("999"); expect(time.field.text).toBe("10"); expect(spinner(byName(menu, "Punkbuster:")).curvalue).toBe(0);
    await setCursorToItem(f.state, menu, frag); await f.keys.charEvent(3); await f.keys.charEvent(53); await f.keys.charEvent(50); await f.keys.charEvent(65);
    expect(frag.field.text).toBe("52"); await press(f, KeyCode.Enter); expect(active(f).items[active(f).cursor]).toBe(time);
    await keyOn(f, byId(menu, 23)); expect(f.cvars.get("fraglimit")?.value).toBe("52"); expect(f.cvars.get("sv_hostname")?.value).toBe("z".repeat(255));
    expect(f.cvars.get("ui_ffa_fraglimit")?.value).toBe("52"); expect(f.cvars.get("timelimit")?.value).toBe("10");
    expect(f.events).toContain("sound:sound/misc/menu4.wav:6");
  } finally { f.close(); }
});

test("bot grid failures retain reached icon writes, leave later rows unchanged and preserve all records on reopen", async () => {
  const f = await fixture(); try {
    const options = await openOptions(f, false, 1), row = itemAt(names(options), 1); await keyOn(f, row); const menu = active(f), items = menu.items.slice();
    const pictures = menu.items.filter(item => item.kind === "bitmap").filter(item => item.focuspic === "menu/art/opponents_selected");
    const previousNames = botNames(menu).map(item => item.text), oldIcon = itemAt(pictures, 1).common.name;
    const register = f.resources.registerShaderNoMip.bind(f.resources), failure = new Error("bot icon failed"); let calls = 0;
    f.resources.registerShaderNoMip = async name => { if (++calls === 2) throw failure; return await register(name); };
    await expect(activate(arrow(menu, "right"))).rejects.toBe(failure);
    expect(botNames(menu)[0]?.text).not.toBe(previousNames[0]); expect(botNames(menu).slice(1).map(item => item.text)).toEqual(previousNames.slice(1));
    expect(itemAt(pictures, 1).common.name).not.toBe(oldIcon); expect(f.state.activeMenu).toBe(menu);
    f.resources.registerShaderNoMip = register; await activate(byName(menu, "menu/art/back_0")); await keyOn(f, row);
    expect(active(f)).toBe(menu); for (const [n, item] of items.entries()) expect(menu.items[n]).toBe(item);
    expect(botNames(menu).map(item => item.text)).toEqual(previousNames);
  } finally { f.close(); }
});

test("real CPU renders all three complete menus from retail levelshots, bot icons and source widgets", async () => {
  const f = await fixture(null, 640, 480); try {
    await f.owner.show(false); await drawMenu(f.state, active(f)); expect(f.commands.submit().batches).toBeGreaterThan(0);
    const startPixels = f.cpu.pixels.slice(), pictures = mapPictures(active(f));
    expect(pictures.every(pic => pic.shader !== null && pic.focusshader !== null)).toBe(true);
    await keyOn(f, byId(active(f), 18)); await drawMenu(f.state, active(f)); expect(f.commands.submit().batches).toBeGreaterThan(0);
    const optionsPixels = f.cpu.pixels.slice(); expect(optionsPixels).not.toEqual(startPixels);
    await keyOn(f, itemAt(names(active(f)), 1)); await drawMenu(f.state, active(f)); expect(f.commands.submit().batches).toBeGreaterThan(0);
    expect(f.cpu.pixels).not.toEqual(optionsPixels);
    const icons = active(f).items.filter(item => item.kind === "bitmap").filter(item => item.focuspic === "menu/art/opponents_selected");
    expect(icons.every(pic => pic.shader !== null && pic.focusshader !== null)).toBe(true);
    expect(f.assets.reads.some(path => path.startsWith("levelshots/"))).toBe(true);
    expect(f.assets.reads.some(path => path.startsWith("models/players/") && path.includes("/icon_"))).toBe(true);
  } finally { f.close(); }
});

test("ServerPlayerIcon reports each Com_sprintf overflow before truncation and retains source fallback registration timing", async () => {
  for (const [model, skin, requestedLength, fallbackLength] of [["a".repeat(50), "default", 82, 0], ["b".repeat(40), "red", 68, 72]] satisfies [string, string, number, number][]) {
    const f = await fixture({ arenas: '{ map one type ffa bots "Overflow" }', bots: `{ name Overflow model "${model}/${skin}" }` }); try {
      const options = await openOptions(f), trace: string[] = [], print = f.state.services.print.bind(f.state.services), register = f.resources.registerShaderNoMip.bind(f.resources);
      f.state.services.print = message => { if (message.startsWith("Com_sprintf:")) trace.push(message); return print(message); };
      f.resources.registerShaderNoMip = async name => { if (name !== null && name.startsWith("models/players/")) trace.push(`register:${name}`); return await register(name); };
      await keyOn(f, itemAt(names(options), 1));
      const requested = `models/players/${model}/icon_${skin}.tga`.slice(0, 63), fallback = `models/players/${model}/icon_default.tga`.slice(0, 63);
      expect(trace).toEqual(fallbackLength === 0 ? [`Com_sprintf: overflow of ${requestedLength} in 64\n`, `register:${requested}`]
        : [`Com_sprintf: overflow of ${requestedLength} in 64\n`, `register:${requested}`, `Com_sprintf: overflow of ${fallbackLength} in 64\n`]);
      const picture = find(active(f), item => item.kind === "bitmap" && item.focuspic === "menu/art/opponents_selected");
      expect(picture.common.name).toBe(fallback); expect(picture.common.name?.length).toBe(63);
      trace.length = 0; await drawMenu(f.state, active(f));
      expect(trace).toEqual([`register:${fallback}`]);
    } finally { f.close(); }
  }
});
