import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { KeyCode } from "../src/core/key-codes.ts";
import { encodePng } from "../src/core/png.ts";
import type { WorldFrame } from "../src/render/world.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { drawMenu, refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { BasePlayerModelMenu } from "../src/ui/base/player-model.ts";
import { BasePlayerSettingsMenu } from "../src/ui/base/player-settings.ts";
import { BaseUiPlayers } from "../src/ui/base/players.ts";
import { COLORS, MenuFlag, itemAt } from "../src/ui/base/state.ts";
import type { BaseMenu, MenuFieldItem, MenuSpin } from "../src/ui/base/state.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const base = await baseFixture(320, 240); cleanups.push(base.close);
  const home = await mkdtemp(join(tmpdir(), "q3-player-settings-")); cleanups.push(async () => { await rm(home, { recursive: true, force: true }); });
  const sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath: home, cdPath: null, product: "baseq3" }, text => { base.prints.push(text); }, sound, base.cvars);
  cleanups.push(() => { try { files.close(); } finally { sound.close(); } }); await files.initialize({ checksumFeed: 0, random: () => 0 }, () => { base.state.assertActive(); });
  const players = new BaseUiPlayers(base.state, files), hunk = new HunkArena(6 * 1024 * 1024, text => { base.prints.push(text); });
  const models = new BasePlayerModelMenu(base.state, players, hunk), settings = new BasePlayerSettingsMenu(base.state, players, models);
  const scenes: WorldFrame[] = [], loads: string[] = [], infos: Parameters<BaseUiPlayers["setModel"]>[0][] = [];
  const render = base.resources.renderScene.bind(base.resources), setModel = players.setModel.bind(players);
  base.resources.renderScene = refdef => { scenes.push({ refdef }); return render(refdef); };
  players.setModel = async (info, model) => { loads.push(model); infos.push(info); await setModel(info, model); };
  base.cvars.set("model", "sarge/default"); base.cvars.set("name", "^1Player"); base.cvars.set("handicap", "100"); base.cvars.set("color1", "7");
  await cacheMenu(base.state);
  return { ...base, files, players, models, settings, scenes, loads, infos };
}
function field(menu: BaseMenu): MenuFieldItem {
  const item = itemAt(menu.items, 3); if (item.kind !== "field") throw new Error("Missing player name field"); return item;
}
function spin(menu: BaseMenu, index: number): MenuSpin {
  const item = itemAt(menu.items, index); if (item.kind !== "spin") throw new Error("Missing player spin control"); return item;
}
async function press(p: Awaited<ReturnType<typeof fixture>>, index: number, key = KeyCode.Enter): Promise<void> {
  await setCursorToItem(p.state, p.settings.menu, itemAt(p.settings.menu.items, index));
  await p.keys.keyEvent(key, true, 1); await p.keys.keyEvent(key, false, 2);
}

test("source layout, callback placement, field capacity, numeric mappings and retained records", async () => {
  const p = await fixture(); p.cvars.set("name", "x".repeat(40)); p.cvars.set("color1", "3.99"); p.cvars.set("handicap", "94.99");
  await p.settings.show(); const menu = p.settings.menu, items = [...menu.items], name = field(menu), storage = name.field;
  expect(menu.itemCount).toBe(10); expect(menu.cursor).toBe(3); expect(menu.items.map(item => item.common.id)).toEqual([0, 0, 0, 0, 11, 12, 14, 13, 0, 0]);
  expect(menu.items.map(item => item.common.y)).toEqual([16, 78, 76, 144, 225, 306, 416, 416, -40, 0]);
  expect([name.field.maxchars, name.field.widthInChars, name.field.cursor, name.field.scroll, name.field.text.length]).toEqual([20, 20, 0, 0, 40]);
  expect(name.common).toMatchObject({ flags: MenuFlag.NoDefaultInit, left: 184, top: 136, right: 392, bottom: 198 });
  expect(spin(menu, 4).curvalue).toBe(2); expect(spin(menu, 5).curvalue).toBe(3);
  expect(spin(menu, 4).common.callback).toBeNull(); expect(spin(menu, 5).common.callback).toBeNull();
  const info = itemAt(p.infos, 0), legs = info.legs, animation = info.animations[0];
  p.cvars.set("color1", "99"); p.cvars.set("handicap", "0"); await p.settings.show();
  expect(spin(menu, 4).curvalue).toBe(19); expect(spin(menu, 5).curvalue).toBe(6);
  expect(menu.items).toEqual(items); expect(field(menu).field).toBe(storage); expect(p.infos.at(-1)).toBe(info);
  expect(info.legs).toBe(legs); expect(info.animations[0]).toBe(animation);
  for (const [game, ui] of [[1, 4], [2, 2], [3, 3], [4, 0], [5, 5], [6, 1], [7, 6]] satisfies [number, number][]) {
    p.cvars.set("color1", String(game)); await p.settings.show(); expect(spin(menu, 5).curvalue).toBe(ui);
  }
});

test("out-of-range and nonfinite color cvars use UI CVFI4 then select white", async () => {
  const p = await fixture();
  for (const value of ["2147483648", "nan", "inf", "-inf"]) {
    p.cvars.set("color1", value); await p.settings.show();
    expect(p.state.activeMenu).toBe(p.settings.menu); expect(spin(p.settings.menu, 5).curvalue).toBe(6);
    await drawMenu(p.state, p.settings.menu);
  }
  p.commands.submit();
  expect(p.recorder.trace().some(view => view.batches.some(batch => batch.texture.kind === "bind-image" && batch.texture.image.name.includes("fx_white")))).toBe(true);
});

test("NaN handicap stores the UI CVFI4 result and fails only when ownerdraw indexes the label", async () => {
  const p = await fixture(); p.cvars.set("handicap", "nan"); await p.settings.show();
  expect(Number.isNaN(p.cvars.get("handicap")?.numericValue)).toBe(true);
  expect(p.state.activeMenu).toBe(p.settings.menu); expect(spin(p.settings.menu, 4).curvalue).toBe(429496749);
  await expect(drawMenu(p.state, p.settings.menu)).rejects.toThrow("Undefined native base UI array index 429496749");
});

test("closing before drawing a NaN handicap passes its integer result through the float32 cvar trap", async () => {
  const p = await fixture(); p.cvars.set("handicap", "nan"); await p.settings.show();
  field(p.settings.menu).field.setText("Saved player");
  const writes: string[] = [], set = p.cvars.set.bind(p.cvars);
  p.cvars.set = (name, text, force) => { writes.push(`${name}:${text}`); return set(name, text, force); };
  await p.keys.keyEvent(KeyCode.Escape, true, 1);
  expect(writes.slice(0, 3)).toEqual(["name:Saved player", "handicap:-2147483648", "color1:7"]);
  expect(p.state.activeMenu).toBeNull();
});

test("actual key editing, deferred handicap/effect saves, model submenu save order and return reload", async () => {
  const p = await fixture(); p.cvars.set("name", "Player"); await p.settings.show(); const menu = p.settings.menu;
  // UI's source field inserts when the shared overstrike flag is true.
  p.keys.setOverstrike(true); await p.keys.charEvent("Q".charCodeAt(0)); expect(field(menu).field.text).toBe("QPlayer");
  await press(p, 4, KeyCode.Right); await press(p, 5, KeyCode.Left);
  expect(spin(menu, 4).curvalue).toBe(1); expect(spin(menu, 5).curvalue).toBe(5);
  expect(p.cvars.get("handicap")?.value).toBe("100"); expect(p.cvars.get("color1")?.value).toBe("7");
  await press(p, 6); expect(p.state.activeMenu).toBe(p.models.menu); expect(p.state.menuDepth).toBe(2);
  expect(p.cvars.get("name")?.value).toBe("QPlayer"); expect(p.cvars.get("handicap")?.value).toBe("95"); expect(p.cvars.get("color1")?.value).toBe("5");
  await setCursorToItem(p.state, p.models.menu, itemAt(p.models.menu.items, 10)); await p.keys.keyEvent(KeyCode.Enter, true, 3); await p.keys.keyEvent(KeyCode.Enter, false, 4);
  await p.keys.keyEvent(KeyCode.Escape, true, 5); await p.keys.keyEvent(KeyCode.Escape, false, 6);
  expect(p.state.activeMenu).toBe(menu); expect(p.state.menuDepth).toBe(1);
  const chosen = p.cvars.get("model")?.value; expect(chosen).not.toBe("sarge/default");
  await refresh(p.state, 203); expect(p.loads.at(-1)).toBe(chosen); expect(p.scenes.at(-1)?.refdef.time).toBe(101);
  field(menu).field.setText("Back saved"); await press(p, 7); expect(p.cvars.get("name")?.value).toBe("Back saved"); expect(p.state.activeMenu).toBeNull();
  await p.settings.show(); field(menu).field.setText("Escape saved"); await p.keys.keyEvent(KeyCode.Escape, true, 7);
  expect(p.cvars.get("name")?.value).toBe("Escape saved"); expect(p.state.activeMenu).toBeNull();
});

test("initial and first-draw reload are distinct, unchanged draws do not reload, case changes do", async () => {
  const p = await fixture(); await p.settings.show(); expect(p.loads).toEqual(["sarge/default"]);
  await refresh(p.state, 201); expect(p.loads).toEqual(["sarge/default", "sarge/default"]); expect(p.scenes.at(-1)?.refdef.time).toBe(100);
  const first = p.infos[0]; await refresh(p.state, 202); expect(p.loads).toHaveLength(2);
  p.cvars.set("model", "SARGE/default"); await refresh(p.state, 203); expect(p.loads.at(-1)).toBe("SARGE/default"); expect(p.infos.at(-1)).toBe(first);
  p.commands.submit(); expect(p.recorder.trace().some(view => view.batches.some(batch => batch.indices.length > 100))).toBe(true);
  const path = process.env["Q3_UI_SETTINGS_IMAGE"]; if (path !== undefined) await Bun.write(path, encodePng(320, 240, p.cpu.pixels));
});

test("name ownerdraw shows literal colors while editing, replaces black when unfocused, and draws insert/overstrike cursors", async () => {
  const p = await fixture(); await p.settings.show(); const menu = p.settings.menu;
  field(menu).field.setText("^0A^1B"); p.state.realtime = 0; p.keys.setOverstrike(false);
  await drawMenu(p.state, menu); p.commands.submit();
  let firstView = 0;
  function chars() { return p.recorder.trace().slice(firstView).flatMap(view => view.batches).filter(batch => batch.texture.kind === "bind-image" && batch.texture.image.name.startsWith("gfx/2d/bigchars")).flatMap(batch => batch.vertices); }
  const focused = chars(); expect(focused.length).toBe(7 * 4);
  expect(focused.slice(0, 24).every(vertex => vertex.color.x > .8 && vertex.color.x < 1 && vertex.color.x === vertex.color.y && vertex.color.y === vertex.color.z)).toBe(true);
  const insert = focused.slice(-4).map(vertex => vertex.texCoord);
  firstView = p.recorder.trace().length; p.keys.setOverstrike(true); await drawMenu(p.state, menu); p.commands.submit();
  const overstrike = chars().slice(-4).map(vertex => vertex.texCoord); expect(overstrike).not.toEqual(insert);
  firstView = p.recorder.trace().length; await setCursorToItem(p.state, menu, itemAt(menu.items, 4)); await drawMenu(p.state, menu); p.commands.submit();
  const unfocused = chars(); expect(unfocused).toHaveLength(8);
  expect(unfocused[0]?.color).toEqual(COLORS.white); expect(unfocused[4]?.color).toEqual(COLORS.red);
});

test("retired preview reload does not publish saved model or draw a scene after awaited reads", async () => {
  const p = await fixture(); await p.settings.show();
  p.cvars.set("model", "visor/blue"); const gate = deferred(), entered = deferred();
  p.assets.beforeRead = async path => { if (path === "models/players/visor/lower.md3") { entered.resolve(); await gate.promise; } };
  const render = refresh(p.state, 201); await entered.promise; p.state.retire(); gate.resolve();
  await expect(render).rejects.toThrow("retired"); expect(p.scenes).toHaveLength(0);
});

test("reopen zeros embedded field and player records before its first awaited cache registration", async () => {
  const p = await fixture(); await p.settings.show();
  const info = itemAt(p.infos, 0), legs = info.legs, animation = itemAt(info.animations, 0), name = field(p.settings.menu), fieldData = name.field;
  const gate = deferred(), entered = deferred(), register = p.resources.registerShaderNoMip.bind(p.resources);
  p.resources.registerShaderNoMip = async path => { const shader = await register(path); if (path === "menu/art/frame2_l") { entered.resolve(); await gate.promise; } return shader; };
  const show = p.settings.show(); await entered.promise;
  expect(p.settings.menu.itemCount).toBe(0); expect(name.common.parent).toBeNull(); expect(fieldData.text).toBe(""); expect(fieldData.maxchars).toBe(0);
  expect(info.legsModel.kind).toBe("default"); expect(info.legs).toBe(legs); expect(info.animations[0]).toBe(animation); expect(animation.firstFrame).toBe(0);
  gate.resolve(); await show; expect(field(p.settings.menu).field).toBe(fieldData); expect(p.infos.at(-1)).toBe(info);
});
