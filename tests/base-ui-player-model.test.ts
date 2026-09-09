import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { KeyCode } from "../src/core/key-codes.ts";
import { encodePng } from "../src/core/png.ts";
import type { WorldFrame } from "../src/render/world.ts";
import type { SourceRefEntity } from "../src/render/ref-entity.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { BasePlayerModelMenu } from "../src/ui/base/player-model.ts";
import { BaseUiPlayers } from "../src/ui/base/players.ts";
import { MenuFlag, itemAt } from "../src/ui/base/state.ts";
import type { BaseMenu, MenuBitmap } from "../src/ui/base/state.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

const cleanups: (() => void | Promise<void>)[] = [];
type CapturedFrame = Omit<WorldFrame, "entities"> & { readonly entities: readonly SourceRefEntity[] };
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const base = await baseFixture(320, 240); cleanups.push(base.close);
  const home = await mkdtemp(join(tmpdir(), "q3-player-model-")); cleanups.push(async () => { await rm(home, { recursive: true, force: true }); });
  const sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath: home, cdPath: null, product: "baseq3" }, text => { base.prints.push(text); }, sound, base.cvars);
  cleanups.push(() => { try { files.close(); } finally { sound.close(); } }); await files.initialize({ checksumFeed: 0, random: () => 0 }, () => { base.state.assertActive(); });
  const players = new BaseUiPlayers(base.state, files), hunk = new HunkArena(6 * 1024 * 1024, text => { base.prints.push(text); });
  const scenes: CapturedFrame[] = [], loads: string[] = [], infos: Parameters<BaseUiPlayers["setModel"]>[0][] = [];
  const render = base.resources.renderScene.bind(base.resources), setModel = players.setModel.bind(players);
  base.resources.renderScene = refdef => {
    scenes.push({ refdef, entities: base.resources.sceneEntities.sceneRange().copyRefEntities() });
    return render(refdef);
  };
  players.setModel = async (info, model) => { loads.push(model); infos.push(info); await setModel(info, model); };
  base.cvars.set("model", "sarge/default"); base.cvars.set("name", "^1Test Player");
  await cacheMenu(base.state);
  return { ...base, files, home, players, hunk, scenes, loads, infos, controller: new BasePlayerModelMenu(base.state, players, hunk) };
}
function bitmap(menu: BaseMenu, index: number): MenuBitmap {
  const item = itemAt(menu.items, index); if (item.kind !== "bitmap") throw new Error("Expected player model bitmap"); return item;
}
async function press(p: Awaited<ReturnType<typeof fixture>>, index: number, key = KeyCode.Enter): Promise<void> {
  await setCursorToItem(p.state, p.controller.menu, itemAt(p.controller.menu.items, index));
  await p.keys.keyEvent(key, true, 1); await p.keys.keyEvent(key, false, 2);
}
function label(menu: BaseMenu, index: number): string | null {
  const item = itemAt(menu.items, index); if (item.kind !== "proportional") throw new Error("Expected model label"); return item.text;
}

test("retail grid, source item order, retained identities, labels and arrow-key cursor quirk", async () => {
  const p = await fixture(); await p.controller.show(); const menu = p.controller.menu, items = [...menu.items], common = itemAt(items, 8).common;
  expect(menu.itemCount).toBe(44); expect(menu.cursor).toBe(8); expect(menu.wrapAround).toBe(true); expect(menu.fullscreen).toBe(true);
  expect(menu.items.slice(39).map(item => item.common.id)).toEqual([0, 0, 100, 101, 102]);
  expect(label(menu, 4)).toBe("Test Player"); expect(label(menu, 5)).toBe("SARGE"); expect(label(menu, 6)).toBe("DEFAULT");
  const selected = menu.items.slice(7, 39).filter(item => (item.common.flags & MenuFlag.Highlight) !== 0);
  expect(selected).toHaveLength(1); expect(selected[0]?.common.name).toBe("models/players/sarge/icon_default");
  expect(bitmap(menu, 8).common).toMatchObject({ x: 34, y: 43, left: 50, top: 59, right: 114, bottom: 123 });
  const cursor = menu.cursor; await p.keys.keyEvent(KeyCode.Right, true, 1);
  expect(menu.cursor).toBe(cursor); expect(p.events).toContain("sound:sound/misc/menu2.wav:6");
  expect(p.loads).toEqual(["sarge/default"]);
  await p.controller.show(); expect(menu.items).toEqual(items); expect(itemAt(menu.items, 8).common).toBe(common);
  p.cvars.set("model", "unknown/model"); await p.controller.show();
  expect(label(menu, 5)).toBe("SARGE"); expect(label(menu, 6)).toBe("DEFAULT");
});

test("selection, paging, back and escape save exactly all four model cvars", async () => {
  const p = await fixture(); await p.controller.show(); const menu = p.controller.menu;
  await press(p, 10); const selected = bitmap(menu, 9).common.name;
  if (selected === null) throw new Error("Retail grid needs a second selectable portrait");
  const expected = selected.slice(15).replace("icon_", "");
  expect(p.loads.at(-1)).toBe(expected); expect(p.cvars.get("model")?.value).toBe("sarge/default");
  expect(bitmap(menu, 9).common.flags & MenuFlag.Highlight).toBe(MenuFlag.Highlight);
  const firstPage = bitmap(menu, 7).common.name;
  await press(p, 42); expect(bitmap(menu, 7).common.name).not.toBe(firstPage);
  await press(p, 41); expect(bitmap(menu, 7).common.name).toBe(firstPage);
  await press(p, 43);
  expect(p.state.activeMenu).toBeNull();
  for (const name of ["model", "headmodel", "team_model", "team_headmodel"]) expect(p.cvars.get(name)?.value).toBe(expected);
  p.cvars.set("model", "visor/blue"); await p.controller.show(); await p.keys.keyEvent(KeyCode.Escape, true, 3);
  for (const name of ["model", "headmodel", "team_model", "team_headmodel"]) expect(p.cvars.get(name)?.value).toBe("visor/blue");
});

test("actual Hunk exact LOW_MEMORY threshold suppresses selected reload and draw but not initial load", async () => {
  const p = await fixture(); p.hunk.allocate(1024 * 1024, "low"); expect(p.hunk.memoryRemaining()).toBe(5 * 1024 * 1024);
  await p.controller.show(); expect(p.loads).toEqual(["sarge/default"]);
  await press(p, 10); expect(p.loads).toEqual(["sarge/default"]);
  await refresh(p.state, 201); p.commands.submit(); expect(p.scenes).toHaveLength(0);
  expect(p.recorder.trace().some(view => view.batches.some(batch => batch.texture.kind === "bind-image" && batch.texture.image.name.includes("font1_prop")))).toBe(true);
  await p.keys.keyEvent(KeyCode.Mouse2, true, 2);
  expect(p.cvars.get("model")?.value).not.toBe("sarge/default");
});

test("real preview, selected model and half realtime reach the CPU framebuffer", async () => {
  const p = await fixture(); p.hunk.allocate(1024 * 1024 - 32, "low"); expect(p.hunk.memoryRemaining()).toBe(5 * 1024 * 1024 + 32);
  await p.controller.show(); await press(p, 10); await refresh(p.state, 201);
  expect(p.scenes.at(-1)?.refdef).toMatchObject({ x: 200, y: -20, width: 160, height: 280, time: 100 });
  const entity = p.scenes.at(-1)?.entities?.[0]; if (entity?.kind !== "model") throw new Error("Missing actual model scene");
  if (typeof entity.model === "number") throw new Error("Typed player menu submitted a numeric model");
  expect(entity.model.kind).toBe("md3"); expect(entity.customSkin).not.toBeNull();
  p.commands.submit();
  expect(p.recorder.trace().some(view => view.batches.some(batch => batch.indices.length > 100))).toBe(true);
  expect(p.cpu.pixels.some(channel => channel > 0)).toBe(true);
  const path = process.env["Q3_UI_MODEL_IMAGE"]; if (path !== undefined) await Bun.write(path, encodePng(320, 240, p.cpu.pixels));
});

test("bounded actual directory listings, icon case, first dot and non-icon buildscript sound precache", async () => {
  const p = await fixture(), directory = join(p.home, "baseq3/models/players/testmenu"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "ICON_Upper.tga"), ""); await writeFile(join(directory, "icon_lab.extra.tga"), ""); await writeFile(join(directory, "texture.tga"), "");
  p.cvars.set("com_buildscript", "1"); p.registrations.length = 0; await p.controller.cache();
  expect(p.registrations).toContain("shader:models/players/testmenu/ICON_Upper");
  expect(p.registrations).toContain("shader:models/players/testmenu/icon_lab");
  expect(p.registrations).toContain("sound:sound/player/announce/texture_wins.wav:false");
  p.cvars.set("com_buildscript", "0");
  for (const name of ["aa", "bb", "cc"]) {
    const dir = join(p.home, `baseq3/models/players/${name}`); await mkdir(dir, { recursive: true });
    await Promise.all(Array.from({ length: 180 }, (_, index) => writeFile(join(dir, `icon_${String(index).padStart(3, "0")}.tga`), "")));
  }
  p.registrations.length = 0; await p.controller.cache();
  const icons = p.registrations.filter(name => name.startsWith("shader:models/players/"));
  expect(icons).toHaveLength(256);
  for (const name of ["aa", "bb", "cc"]) expect(icons.filter(path => path.includes(`/players/${name}/`)).length).toBeLessThan(180);
});

test("fractional buildscript values truncate through UI CVFI4 before the precache boolean", async () => {
  const p = await fixture();
  for (const value of ["0.5", "-0.5"]) {
    p.cvars.set("com_buildscript", value); p.registrations.length = 0; await p.controller.cache();
    expect(p.registrations.filter(name => name.startsWith("sound:"))).toHaveLength(0);
    expect(p.registrations.some(name => name.startsWith("shader:models/players/"))).toBe(true);
  }
  p.cvars.set("com_buildscript", "1"); p.registrations.length = 0; await p.controller.cache();
  expect(p.registrations.some(name => name.startsWith("sound:sound/player/announce/") && name.endsWith(":false"))).toBe(true);
});

test("retirement during awaited cache rejects before publishing subsequent menu work", async () => {
  const p = await fixture(), gate = deferred(), entered = deferred();
  p.assets.beforeRead = async path => { if (path.includes("player_models_ports")) { entered.resolve(); await gate.promise; } };
  const show = p.controller.show(); await entered.promise; p.state.retire(); gate.resolve();
  await expect(show).rejects.toThrow("retired"); expect(p.state.activeMenu).toBeNull(); expect(p.loads).toHaveLength(0);
});

test("reopen zeros stable player and item records before the first cache await, then restores static label backing", async () => {
  const p = await fixture(); await p.controller.show();
  const menu = p.controller.menu, info = itemAt(p.infos, 0), legs = info.legs, animation = itemAt(info.animations, 0), pic = bitmap(menu, 7), name = itemAt(menu.items, 5);
  if (name.kind !== "proportional") throw new Error("Missing model text");
  const gate = deferred(), entered = deferred(), register = p.resources.registerShaderNoMip.bind(p.resources);
  p.resources.registerShaderNoMip = async path => { const shader = await register(path); if (path === "menu/art/back_0") { entered.resolve(); await gate.promise; } return shader; };
  p.cvars.set("model", "unknown/model"); const show = p.controller.show(); await entered.promise;
  expect(menu.itemCount).toBe(0); expect(pic.common.parent).toBeNull(); expect(pic.common.name).toBeNull(); expect(name.text).toBeNull();
  expect(info.legsModel.kind).toBe("default"); expect(info.legs).toBe(legs); expect(info.animations[0]).toBe(animation); expect(animation.firstFrame).toBe(0);
  gate.resolve(); await show;
  expect(label(menu, 5)).toBe("SARGE"); expect(label(menu, 6)).toBe("DEFAULT"); expect(bitmap(menu, 7)).toBe(pic);
});

test("source bounded format warns and truncates while unsafe skin stack overflow is explicit", async () => {
  const p = await fixture(), long = "a".repeat(110), dir = join(p.home, `baseq3/models/players/${long}`);
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, "icon_test.tga"), "");
  p.registrations.length = 0; await p.controller.cache();
  const path = `models/players/${long}/icon_test`;
  expect(p.registrations).toContain(`shader:${path.slice(0, 127)}`); expect(p.prints).toContain(`Com_sprintf: overflow of ${path.length} in 128\n`);
  await writeFile(join(dir, `icon_${"x".repeat(60)}.tga`), "");
  await expect(p.controller.cache()).rejects.toThrow("COM_StripExtension storage");
});

test("icon prefix in a model directory only triggers the source zero label-size error when selected", async () => {
  const p = await fixture(), dir = join(p.home, "baseq3/models/players/icon_test");
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, "icon_default.tga"), "");
  await p.controller.show();
  // It participates in enumeration but does not match the selected retail sarge model.
  while ((bitmap(p.controller.menu, 41).common.flags & MenuFlag.Inactive) === 0) await press(p, 41);
  expect(bitmap(p.controller.menu, 7).common.name).toBe("models/players/icon_test/icon_default");
  await expect(press(p, 8)).rejects.toThrow("destsize < 1");
});
