import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { infoValueForKey } from "../src/core/info-string.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { BaseConfirmMenu } from "../src/ui/base/confirm.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { mouseEvent, popMenu, refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { BaseUiGameInfo } from "../src/ui/base/game-info.ts";
import { BasePlayerModelMenu } from "../src/ui/base/player-model.ts";
import { BasePlayerSettingsMenu } from "../src/ui/base/player-settings.ts";
import { BaseUiPlayers } from "../src/ui/base/players.ts";
import { BaseSpLevelMenu } from "../src/ui/base/sp-level.ts";
import { BaseSpSkillMenu } from "../src/ui/base/sp-skill.ts";
import { BaseStartServerMenu } from "../src/ui/base/start-server.ts";
import { itemAt, MenuEvent, MenuFlag } from "../src/ui/base/state.ts";
import type { BaseMenu, BaseMenuItem, MenuBitmap } from "../src/ui/base/state.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

interface Catalog { readonly arenas: string; readonly bots: string; }
async function fixture(catalog: Catalog | null = null) {
  const ui = await baseFixture(320, 240), directory = catalog === null ? null : mkdtempSync(join(tmpdir(), "quake3-sp-level-"));
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
    await files.initialize({ checksumFeed: 0, random: () => 0 }, () => { ui.state.assertActive(); });
    const game = new BaseUiGameInfo(ui.state, files); game.initialize();
    const players = new BaseUiPlayers(ui.state, files), hunk = new HunkArena(6 * 1024 * 1024, text => { ui.prints.push(text); });
    const models = new BasePlayerModelMenu(ui.state, players, hunk), settings = new BasePlayerSettingsMenu(ui.state, players, models);
    const skill = new BaseSpSkillMenu(ui.state, game), start = new BaseStartServerMenu(ui.state, game), confirm = new BaseConfirmMenu(ui.state);
    const level = new BaseSpLevelMenu(ui.state, game, skill, settings, start, confirm);
    ui.cvars.set("model", "sarge/default", true); ui.cvars.set("name", "^1Player", true);
    ui.cvars.set("handicap", "100", true); ui.cvars.set("color1", "7", true);
    await cacheMenu(ui.state);
    return { ...ui, files, game, players, models, settings, skill, start, confirm, level, close };
  } catch (error) { close(); throw error; }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function byId(menu: BaseMenu, id: number): BaseMenuItem {
  const found = menu.items.find(item => item.common.id === id); if (found === undefined) throw new Error(`Missing menu item ${id}`); return found;
}
function picture(menu: BaseMenu, id: number): MenuBitmap { const item = byId(menu, id); if (item.kind !== "bitmap") throw new Error("Expected bitmap"); return item; }
async function activate(item: BaseMenuItem, event = MenuEvent.Activated): Promise<void> {
  const callback = item.common.callback; if (callback === null) throw new Error("Missing source callback"); await callback(item, event);
}
async function press(f: Fixture, key: number): Promise<void> { await f.keys.keyEvent(key, true, 1); await f.keys.keyEvent(key, false, 2); }
async function keyOn(f: Fixture, menu: BaseMenu, id: number): Promise<void> { await setCursorToItem(f.state, menu, byId(menu, id)); await press(f, KeyCode.Enter); }
async function draw(f: Fixture): Promise<void> { await refresh(f.state, 150); f.commands.submit(); }
function number(info: string | null): number { if (info === null) throw new Error("Missing retail arena"); return Number(infoValueForKey(info, "num")); }
const four = Array.from({ length: 4 }, (_, n) => `{ map q3dm${n + 1} type single longname Level${n} }`).join("\n");

test("retail SP training opens source layout and Fight focus; real key path opens Skill and emits its arena", async () => {
  const f = await fixture(); try {
    await f.level.show(); const menu = f.level.menu;
    expect(f.state.activeMenu).toBe(menu); expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui);
    expect([menu.itemCount, menu.cursor, menu.cursorPrev, menu.fullscreen, menu.wrapAround]).toEqual([13, 11, 2, true, true]);
    expect(menu.items.map(item => item.common.id)).toEqual([0, 10, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 0]);
    expect(picture(menu, 11).common).toMatchObject({ name: "levelshots/q3dm0.tga", x: 256, y: 64, left: 256, right: 384, bottom: 192 });
    expect(picture(menu, 15).width).toBe(-16); expect(picture(menu, 15).common.right).toBe(622);
    expect(picture(menu, 10).common.flags & (MenuFlag.Hidden | MenuFlag.Inactive)).toBe(MenuFlag.Hidden | MenuFlag.Inactive);
    for (let id = 12; id <= 14; id++) expect(picture(menu, id).common).toMatchObject({ name: "", flags: MenuFlag.LeftJustify | MenuFlag.Inactive });
    expect(f.cvars.get("ui_spSelection")?.value).toBe("-4"); expect(f.consoleCommands.pendingText).toBe("");
    await draw(f); expect(f.cpu.pixels.some((v, i) => i % 4 !== 3 && v !== 0)).toBe(true);
    expect(picture(menu, 26).shader).not.toBeNull(); expect(picture(menu, 26).focusshader).not.toBeNull();
    await keyOn(f, menu, 26); expect(f.state.activeMenu).toBe(f.skill.menu); expect(f.state.menuDepth).toBe(2);
    await press(f, KeyCode.Enter); expect(f.consoleCommands.pendingText).toBe("spmap q3dm0\n");
  } finally { f.close(); }
});

test("locked tiers gray maps, preserve selection cvar, reject Fight and return to training", async () => {
  const f = await fixture(); try {
    await f.level.show(); const menu = f.level.menu;
    await keyOn(f, menu, 15); expect(f.cvars.get("ui_spSelection")?.value).toBe("-4");
    for (let id = 11; id <= 14; id++) expect(picture(menu, id).common.flags & MenuFlag.Grayed).toBe(MenuFlag.Grayed);
    expect(picture(menu, 11).common).toMatchObject({ x: 46, left: 46, right: 174, bottom: 178 });
    await keyOn(f, menu, 26); expect(f.state.activeMenu).toBe(menu); expect(f.consoleCommands.pendingText).toBe("");
    await draw(f); const denied = f.cpu.pixels.slice();
    await keyOn(f, menu, 10); await draw(f); expect(f.cpu.pixels).not.toEqual(denied);
    expect(f.cvars.get("ui_spSelection")?.value).toBe("-4");
    for (let i = 0; i < 7; i++) await activate(byId(menu, 15));
    expect(picture(menu, 15).common.flags & MenuFlag.Hidden).toBe(MenuFlag.Hidden);
    expect(f.cvars.get("ui_spSelection")?.value).toBe("24");
    expect(picture(menu, 11).common.name).toBe("levelshots/q3tourney6.tga");
    await keyOn(f, menu, 26); expect(f.state.activeMenu).toBe(menu);
  } finally { f.close(); }
});

test("progression refresh is deferred to draw, and map mouse activation selects a real arena", async () => {
  const f = await fixture(); try {
    await f.level.show(); const menu = f.level.menu, original = [...menu.items];
    f.game.setBestScore(number(f.game.getSpecialArenaInfo("training")), 1);
    f.level.reInit(); expect(f.state.activeMenu).toBe(menu); expect(f.state.menuDepth).toBe(1);
    await draw(f); expect(f.state.activeMenu).toBe(menu); expect(f.state.menuDepth).toBe(1);
    expect(f.cvars.get("ui_spSelection")?.value).toBe("-4");
    for (const [n, item] of original.entries()) expect(itemAt(menu.items, n)).toBe(item);
    await keyOn(f, menu, 15); expect(f.cvars.get("ui_spSelection")?.value).toBe("0");
    await mouseEvent(f.state, 400 - f.state.cursorX, 168 - f.state.cursorY); await press(f, KeyCode.Mouse1);
    expect(f.cvars.get("ui_spSelection")?.value).toBe("2");
    await keyOn(f, menu, 26); await press(f, KeyCode.Enter); expect(f.consoleCommands.pendingText).toBe("spmap q3dm3\n");
    await popMenu(f.state); await keyOn(f, menu, 15); expect(f.cvars.get("ui_spSelection")?.value).toBe("2");
    await keyOn(f, menu, 10); expect(f.cvars.get("ui_spSelection")?.value).toBe("0");
  } finally { f.close(); }
});

test("reset confirmation uses real No/Yes input, clears scores medals videos, pops and reopens", async () => {
  const f = await fixture(); try {
    f.game.unlockLevelScores(); f.game.logAwardData(0, 10); f.cvars.set("ui_spSelection", "9", true);
    await f.level.show(); const menu = f.level.menu;
    await keyOn(f, menu, 24); expect(f.state.activeMenu).toBe(f.confirm.menu); expect(f.confirm.menu.cursor).toBe(1);
    await draw(f); await press(f, 110); expect(f.state.activeMenu).toBe(menu); expect(f.cvars.get("ui_spSelection")?.value).toBe("9");
    await keyOn(f, menu, 24); await press(f, 121);
    expect(f.state.activeMenu).toBe(menu); expect(f.state.menuDepth).toBe(1); expect(f.cvars.get("ui_spSelection")?.value).toBe("-4");
    for (const name of ["g_spScores1", "g_spScores2", "g_spScores3", "g_spScores4", "g_spScores5", "g_spAwards", "g_spVideos"]) expect(f.cvars.get(name)?.value).toBe("");
    expect(menu.itemCount).toBe(13); expect(menu.cursor).toBe(11);
  } finally { f.close(); }
});

test("Custom and Player routes reach actual concrete menus, and player changes refresh the icon", async () => {
  const f = await fixture(); try {
    await f.level.show(); const menu = f.level.menu;
    await keyOn(f, menu, 25); expect(f.state.activeMenu).toBe(f.start.menu); expect(f.start.menu.itemCount).toBe(19);
    await press(f, KeyCode.Escape); expect(f.state.activeMenu).toBe(menu);
    await mouseEvent(f.state, 310 - f.state.cursorX, 370 - f.state.cursorY); await press(f, KeyCode.Mouse1);
    expect(f.state.activeMenu).toBe(f.settings.menu); expect(f.settings.menu.itemCount).toBe(10);
    await press(f, KeyCode.Escape); expect(f.state.activeMenu).toBe(menu);
    await draw(f); const old = picture(menu, 16).shader;
    f.cvars.set("model", "visor/default", true); await draw(f);
    expect(picture(menu, 16).common.name).toBe("models/players/visor/icon_default.tga"); expect(picture(menu, 16).shader).not.toBe(old);
    f.cvars.set("model", "visor/missingSkin", true); await draw(f); expect(picture(menu, 16).common.name).toBe("models/players/visor/icon_default.tga");
    expect(f.registrations).toContain("shader:models/players/visor/icon_missingSkin.tga");
  } finally { f.close(); }
});

test("medals retain source sparse order, frag hundreds and real announcer audio", async () => {
  const f = await fixture(); try {
    f.cvars.set("g_spAwards", "\\a0\\1\\a1\\1000\\a2\\1000000\\a3\\-1\\a4\\199\\a5\\2", true);
    await f.level.show(); const menu = f.level.menu;
    expect(menu.itemCount).toBe(19);
    expect(menu.items.filter(item => item.common.id >= 17 && item.common.id <= 22).map(item => [item.common.id, item.common.x, item.common.y])).toEqual([
      [17, 368, 340], [18, 224, 340], [19, 432, 340], [20, 160, 340], [21, 496, 340], [22, 96, 340],
    ]);
    for (const [id, sound] of [[17, "accuracy"], [18, "impressive_a"], [19, "excellent_a"], [20, "gauntlet"], [21, "frags"], [22, "perfect"]] satisfies [number, string][]) {
      f.events.length = 0; await activate(byId(menu, id)); expect(f.events).toEqual([`sound:sound/feedback/${sound}.wav:7`]);
    }
    expect(f.mixer.mix(1024).some(value => value !== 0)).toBe(true); await draw(f);
    f.cvars.set("g_spAwards", "\\a4\\99", true); await f.level.show(); expect(f.level.menu.itemCount).toBe(13);
    f.cvars.set("g_spAwards", "\\a4\\-199", true); await f.level.show(); expect(picture(menu, 21).common.x).toBe(368);
  } finally { f.close(); }
});

test("score overlay uses best winning skill, and completed retail campaign opens final tier", async () => {
  const f = await fixture(); try {
    f.game.unlockLevelScores(); f.cvars.set("ui_spSelection", "0", true); f.cvars.set("g_spSkill", "5", true); f.game.setBestScore(0, 1);
    await f.level.show(); await draw(f);
    const images = f.recorder.trace().flatMap(view => view.batches).flatMap(batch => batch.texture.kind === "bind-image" ? [batch.texture.image.name] : []);
    expect(images.some(name => name.includes("level_complete5"))).toBe(true);
    f.cvars.set("ui_spSelection", "", true); await f.level.show(); expect(f.cvars.get("ui_spSelection")?.value).toBe("24");
    expect(picture(f.level.menu, 11).common.name).toBe("levelshots/q3tourney6.tga");
    await press(f, KeyCode.Enter); await press(f, KeyCode.Enter); expect(f.consoleCommands.pendingText).toBe("spmap q3tourney6\n");
  } finally { f.close(); }
});

test("absent training/final, empty catalogs, negative selections and CVFI4 values follow source branches", async () => {
  const f = await fixture({ arenas: four, bots: "" }); try {
    for (const value of ["nan", "inf", "-inf", "2147483648", "0", "5.9"]) {
      f.cvars.set("g_spSkill", value, true); await f.level.show(); expect(f.cvars.get("g_spSkill")?.value).toBe(value === "5.9" ? "5.9" : "2");
    }
    expect(picture(f.level.menu, 10).common.flags & MenuFlag.Hidden).toBe(MenuFlag.Hidden);
    expect(picture(f.level.menu, 15).common.flags & MenuFlag.Hidden).toBe(MenuFlag.Hidden);
    f.cvars.set("ui_spSelection", "-2", true); await f.level.show(); await press(f, KeyCode.Enter); await press(f, KeyCode.Enter);
    expect(f.consoleCommands.pendingText).toBe("spmap \n");
    f.cvars.set("ui_spSelection", "2147483647", true); await f.level.show(); expect(f.cvars.get("ui_spSelection")?.value).toBe("2147483647");
    f.cvars.set("ui_spSelection", "-2147483647", true); await f.level.show(); expect(f.cvars.get("ui_spSelection")?.value).toBe("-2147483648");
    await keyOn(f, f.level.menu, 24); await press(f, 121);
    expect(f.cvars.get("ui_spSelection")?.value).toBe("-4"); expect(picture(f.level.menu, 11).common.name).toBe("menu/art/unknownmap");
    expect(picture(f.level.menu, 11).common.x).toBe(256);
  } finally { f.close(); }
  const empty = await fixture({ arenas: "", bots: "" }); try {
    await empty.level.show(); expect(empty.cvars.get("ui_spSelection")?.value).toBe("0");
    expect(picture(empty.level.menu, 11).common.name).toBe("menu/art/unknownmap"); await draw(empty);
    await keyOn(empty, empty.level.menu, 26); await press(empty, KeyCode.Enter); expect(empty.consoleCommands.pendingText).toBe("spmap \n");
  } finally { empty.close(); }
});

test("literal-space bot scan has seven slots and preserves trailing empty bot", async () => {
  const arenas = Array.from({ length: 4 }, (_, n) => `{ map q3dm${n + 1} type single bots "${n === 0 ? "Sarge   " : "Sarge Sarge Sarge Sarge Sarge Sarge Sarge Sarge"}" }`).join("\n");
  const f = await fixture({ arenas, bots: '{ name Sarge model sarge/default }' }); try {
    const lookedUp: string[] = [], lookup = f.game.getBotInfoByName.bind(f.game);
    f.game.getBotInfoByName = name => { lookedUp.push(name); return lookup(name); };
    await f.level.show(); expect(lookedUp).toEqual(["Sarge", ""]); await draw(f);
    lookedUp.length = 0; await keyOn(f, f.level.menu, 12); expect(lookedUp).toEqual(Array.from({ length: 7 }, () => "Sarge")); await draw(f);
    const reads = f.registrations.filter(name => name === "shader:models/players/sarge/icon_default.tga"); expect(reads.length).toBeGreaterThanOrEqual(17);
  } finally { f.close(); }
});

test("source cache order, stable reset records, partial cache failure and successful retry", async () => {
  const f = await fixture(); try {
    await f.level.show(); const menu = f.level.menu, items = [...menu.items], commons = items.map(item => item.common);
    const register = f.soundBank.registerSound.bind(f.soundBank), failure = new Error("third medal cache failed");
    f.registrations.length = 0;
    f.soundBank.registerSound = async (name, compressed) => {
      expect(menu.itemCount).toBe(0); expect(menu.fullscreen).toBe(true); expect(menu.draw).not.toBeNull();
      expect(items.every(item => item.common.name === null && item.common.parent === null)).toBe(true);
      if (name === "sound/feedback/excellent_a.wav") throw failure;
      return await register(name, compressed);
    };
    await expect(f.level.show()).rejects.toBe(failure); expect(f.state.activeMenu).toBe(menu); expect(f.state.menuDepth).toBe(1);
    expect(f.registrations.slice(0, 18)).toEqual(["maps_select", "maps_selected", "narrow_0", "narrow_1", "unknownmap", "level_complete1", "level_complete2", "level_complete3", "level_complete4", "level_complete5", "back_0", "back_1", "fight_0", "fight_1", "reset_0", "reset_1", "skirmish_0", "skirmish_1"].map(name => `shader:menu/art/${name}`));
    expect(f.registrations.slice(18)).toEqual(["shader:menu/medals/medal_accuracy", "sound:sound/feedback/accuracy.wav:false", "shader:menu/medals/medal_impressive", "sound:sound/feedback/impressive_a.wav:false", "shader:menu/medals/medal_excellent"]);
    f.soundBank.registerSound = register; await f.level.show();
    for (const [n, item] of menu.items.entries()) { expect(item).toBe(itemAt(items, n)); expect(item.common).toBe(itemAt(commons, n)); }
    const before = [...menu.items]; await f.level.cache(); expect(menu.items).toEqual(before); expect(menu.cursor).toBe(11);
  } finally { f.close(); }
});

test("map path overflow is qualified at source strcpy after catalog and cvar publication", async () => {
  const long = "m".repeat(50), arenas = `{ map ${long} type single }\n${four}`;
  const f = await fixture({ arenas, bots: "" }); try {
    await expect(f.level.show()).rejects.toThrow("strcpy exceeds source levelPicNames[64]");
    expect(f.level.menu.itemCount).toBe(13); expect(f.cvars.get("ui_spSelection")?.value).toBe("0");
    expect(f.state.menuDepth).toBe(0); expect(f.registrations).not.toContain(`shader:levelshots/${long}.tga`);
  } finally { f.close(); }
});

test("command entry resets depth before failure; awaited cache cannot publish after retirement", async () => {
  const f = await fixture(); try {
    await f.confirm.show("Parent", null, null); await f.level.show(); expect(f.state.menuDepth).toBe(2);
    await f.level.showFromCommand(); expect(f.state.menuDepth).toBe(1); await press(f, KeyCode.Escape); expect(f.state.activeMenu).toBeNull();
    const entered = deferred(), gate = deferred(), register = f.soundBank.registerSound.bind(f.soundBank);
    f.soundBank.registerSound = async (name, compressed) => { const result = await register(name, compressed); entered.resolve(); await gate.promise; return result; };
    const pending = f.level.showFromCommand(); await entered.promise; f.state.retire(); gate.resolve();
    await expect(pending).rejects.toThrow("retired"); expect(f.state.menuDepth).toBe(0); expect(f.level.menu.itemCount).toBe(0);
  } finally { f.close(); }
});

test("bot names truncate before Q_CleanStr and render the same bytes as the cleaned catalog name", async () => {
  const catalog = (name: string): Catalog => ({
    arenas: `{ map q3dm1 type single bots ${name} }\n{ map q3dm2 type single }\n{ map q3dm3 type single }\n{ map q3dm4 type single }`,
    bots: `{ name ${name} model sarge/default }`,
  });
  const decorated = await fixture(catalog("^1SargeZZZZZZ"));
  const plain = await fixture(catalog("SargeZZ"));
  try {
    await decorated.level.show(); await plain.level.show(); await draw(decorated); await draw(plain);
    expect(decorated.cpu.pixels).toEqual(plain.cpu.pixels);
  } finally { decorated.close(); plain.close(); }
});

test("failed map registration keeps the preceding arena pointer while publishing source tier and picture changes", async () => {
  const f = await fixture(); try {
    f.game.setBestScore(number(f.game.getSpecialArenaInfo("training")), 1);
    f.cvars.set("ui_spSelection", "-4", true); await f.level.show(); const menu = f.level.menu;
    const register = f.resources.registerShaderNoMip.bind(f.resources), failure = new Error("second tier map failed");
    f.resources.registerShaderNoMip = async name => { if (name === "levelshots/q3dm2.tga") throw failure; return await register(name); };
    await expect(keyOn(f, menu, 15)).rejects.toBe(failure);
    expect(f.state.activeMenu).toBe(menu); expect(f.cvars.get("ui_spSelection")?.value).toBe("0");
    expect(picture(menu, 11).common.name).toBe("levelshots/q3dm1.tga"); expect(picture(menu, 12).common.name).toBe("levelshots/q3dm2.tga");
    expect(picture(menu, 12).common.flags & MenuFlag.Inactive).toBe(MenuFlag.Inactive);
    f.resources.registerShaderNoMip = register;
    await keyOn(f, menu, 26); await press(f, KeyCode.Enter); expect(f.consoleCommands.pendingText).toBe("spmap q3dm0\n");
  } finally { f.close(); }
});

test("failed changed-player icon registration leaves the old shader until a later model change", async () => {
  const f = await fixture(); try {
    await f.level.show(); await draw(f); const player = picture(f.level.menu, 16), oldShader = player.shader;
    const register = f.resources.registerShaderNoMip.bind(f.resources), failure = new Error("changed model icon failed");
    f.cvars.set("model", "visor/default", true);
    f.resources.registerShaderNoMip = async name => { if (name === "models/players/visor/icon_default.tga") throw failure; return await register(name); };
    await expect(draw(f)).rejects.toBe(failure);
    expect(player.common.name).toBe("models/players/visor/icon_default.tga"); expect(player.shader).toBe(oldShader);
    f.resources.registerShaderNoMip = register; f.registrations.length = 0; await draw(f);
    expect(f.registrations).not.toContain("shader:models/players/visor/icon_default.tga"); expect(player.shader).toBe(oldShader);
    f.cvars.set("model", "visor/red", true); await draw(f); expect(player.shader).not.toBe(oldShader);
  } finally { f.close(); }
});

test("overflow print retirement stops changed-player icon publication and registration", async () => {
  const f = await fixture(); try {
    await f.level.show(); await draw(f);
    const player = picture(f.level.menu, 16), oldName = player.common.name, oldShader = player.shader;
    expect(oldShader).not.toBeNull();
    f.cvars.set("model", "m".repeat(40), true); f.registrations.length = 0;
    const print = f.state.services.print.bind(f.state.services), messages: string[] = [];
    f.state.services.print = text => {
      print(text); messages.push(text);
      if (text.startsWith("Com_sprintf: overflow")) f.state.retire();
    };
    await expect(draw(f)).rejects.toThrow("retired");
    expect(messages).toEqual(["Com_sprintf: overflow of 72 in 64\n"]);
    expect(player.common.name).toBe(oldName); expect(player.shader).toBe(oldShader);
    expect(f.registrations).toEqual([]);
  } finally { f.close(); }
});

test("partial award cache preserves completed sounds and zero handles across a failed reopen", async () => {
  const f = await fixture(); try {
    f.cvars.set("g_spAwards", "\\a0\\1\\a1\\1\\a2\\1", true); await f.level.show();
    const accuracy = byId(f.level.menu, 17), excellent = byId(f.level.menu, 19);
    const accuracyEvent = accuracy.common.callback, excellentEvent = excellent.common.callback;
    if (accuracyEvent === null || excellentEvent === null) throw new Error("Missing original award callback");
    const register = f.soundBank.registerSound.bind(f.soundBank), failure = new Error("excellent unavailable");
    f.soundBank.registerSound = async (name, compressed) => { if (name === "sound/feedback/excellent_a.wav") throw failure; return await register(name, compressed); };
    await expect(f.level.show()).rejects.toBe(failure);
    accuracy.common.id = 17; excellent.common.id = 19; f.events.length = 0;
    await accuracyEvent(accuracy, MenuEvent.Activated); await excellentEvent(excellent, MenuEvent.Activated);
    expect(f.events).toEqual(["sound:sound/feedback/accuracy.wav:7", "sound:sound/feedback/hit.wav:7"]);
    expect(f.level.menu.itemCount).toBe(0);
  } finally { f.close(); }
});

test("ReInit pops before failed reopen and command calls escaping execution cannot publish", async () => {
  const f = await fixture(); try {
    await f.level.show(); f.level.reInit();
    const register = f.resources.registerShaderNoMip.bind(f.resources), failure = new Error("reinit first art failed");
    f.resources.registerShaderNoMip = async name => { if (name === "menu/art/maps_select") throw failure; return await register(name); };
    await expect(draw(f)).rejects.toBe(failure); expect(f.state.menuDepth).toBe(0); expect(f.state.activeMenu).toBeNull();
    expect(f.level.menu.itemCount).toBe(0); f.resources.registerShaderNoMip = register;
    await f.level.show(); expect(f.state.menuDepth).toBe(1);
    const escaped: { promise: Promise<void> | null } = { promise: null };
    f.consoleCommands.register("escape-level", () => { escaped.promise = f.level.showFromCommand(); });
    f.consoleCommands.executeNow("escape-level"); if (escaped.promise === null) throw new Error("Missing escaped operation");
    await expect(escaped.promise).rejects.toThrow("closed"); expect(f.level.menu.itemCount).toBe(0); expect(f.state.menuDepth).toBe(0);
  } finally { f.close(); }
});
