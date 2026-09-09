import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { CvarFlag } from "../src/core/cvar.ts";
import { KeyCode } from "../src/core/key-codes.ts";
import { DEFAULT_MODEL } from "../src/render/ref-entity.ts";
import type { WorldFrame } from "../src/render/world.ts";
import { PlayerAnimation } from "../src/shared/player-state.ts";
import { BaseConfirmMenu } from "../src/ui/base/confirm.ts";
import { BaseControlsMenu } from "../src/ui/base/controls.ts";
import { cacheMenu, stringWidth } from "../src/ui/base/draw.ts";
import { keyEvent, mouseEvent, refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { BaseUiPlayers } from "../src/ui/base/players.ts";
import type { BasePlayerInfo } from "../src/ui/base/players.ts";
import { MenuEvent, MenuFlag, itemAt } from "../src/ui/base/state.ts";
import type { BaseMenu, BaseMenuItem } from "../src/ui/base/state.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function item(menu: BaseMenu, id: number): BaseMenuItem {
  const found = menu.items.find(item => item.common.id === id && (id !== 0 || item.kind === "action"));
  if (found === undefined) throw new Error(`Missing Controls item ${id}`);
  return found;
}
function value(menu: BaseMenu, id: number): number {
  const found = item(menu, id);
  if (found.kind !== "slider" && found.kind !== "radio") throw new Error(`Controls ${id} is not a value widget`);
  return found.curvalue;
}
async function controls() {
  const base = await baseFixture(320, 240); cleanups.push(base.close);
  const home = await mkdtemp(join(tmpdir(), "quake3-controls-"));
  cleanups.push(async () => { await rm(home, { recursive: true, force: true }); });
  const data = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  const sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: data, homePath: home, cdPath: null, product: "baseq3" }, text => { base.prints.push(text); }, sound, base.cvars);
  cleanups.push(() => { try { files.close(); } finally { sound.close(); } });
  await files.initialize({ checksumFeed: 0, random: () => 0 }, () => { base.state.assertActive(); });
  base.cvars.register("model", "sarge", CvarFlag.Archive);
  base.cvars.register("name", "^1Player^2Test\tXYZ", CvarFlag.Archive);
  for (const [name, initial] of [["cl_run", "1"], ["m_pitch", "0.022"], ["cg_autoswitch", "1"], ["sensitivity", "5"],
    ["in_joystick", "0"], ["joy_threshold", "0.15"], ["m_filter", "0"], ["cl_freelook", "1"]] satisfies [string, string][])
    base.cvars.register(name, initial, CvarFlag.Archive);
  const players = new BaseUiPlayers(base.state, files), confirm = new BaseConfirmMenu(base.state), menu = new BaseControlsMenu(base.state, players, confirm);
  const modelLoads: string[] = [], infos: BasePlayerInfo[] = [], scenes: WorldFrame[] = [];
  const setModel = players.setModel.bind(players), setInfo = players.setInfo.bind(players), render = base.resources.renderScene.bind(base.resources);
  players.setModel = async (info, name) => { modelLoads.push(name); await setModel(info, name); };
  players.setInfo = async (info, input) => { if (!infos.includes(info)) infos.push(info); await setInfo(info, input); };
  base.resources.renderScene = refdef => { scenes.push({ refdef }); return render(refdef); };
  async function press(key: number): Promise<void> { await base.keys.keyEvent(key, true, 100); await base.keys.keyEvent(key, false, 101); }
  async function focus(id: number): Promise<void> { await setCursorToItem(base.state, menu.menu, item(menu.menu, id)); }
  async function section(id: number): Promise<void> { await focus(id); await press(KeyCode.Enter); }
  async function capture(id: number, key: number): Promise<void> { await focus(id); await press(KeyCode.Enter); await press(key); }
  return { ...base, files, players, confirm, controls: menu, menu: menu.menu, modelLoads, infos, scenes, press, focus, section, capture };
}

test("Controls source item order, all four groups, mouse navigation and stable reopen", async () => {
  const p = await controls(), menu = p.menu;
  await p.controls.show();
  expect(menu.itemCount).toBe(52);
  expect(menu.items.slice(5).map(item => item.common.id)).toEqual([
    101, 100, 102, 103, 38, 41, 35, 12, 13, 14, 34, 15, 16, 39, 40,
    36, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 26, 28, 27, 37, 17, 18, 19, 20, 21, 22, 23, 24, 25,
    0, 1, 29, 30, 31, 32, 33, 105,
  ]);
  expect([menu.cursor, menu.wrapAround, menu.fullscreen]).toEqual([5, true, true]);
  expect(itemAt(menu.items, 4)).toMatchObject({ text: "PlayerTest", common: { x: 320, y: 440 } });
  for (const [sectionId, ids, top] of [[101, [38, 41, 35, 12, 13, 14, 34, 15, 16, 39, 40], 152],
    [100, [36, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 152], [102, [26, 28, 27, 37, 17, 18, 19, 20, 21, 22, 23, 24, 25], 136],
    [103, [0, 1, 29, 30, 31, 32, 33], 184]] satisfies [number, number[], number][]) {
    await p.section(sectionId);
    const visible = menu.items.filter(item => item.common.id < 42 && (item.kind === "action" || item.kind === "slider" || item.kind === "radio") && !(item.common.flags & MenuFlag.Hidden));
    expect(visible.map(item => item.common.id)).toEqual(ids);
    expect(visible.map(item => item.common.y)).toEqual(ids.map((_, index) => top + index * 16));
    for (const item of visible) expect([item.common.left, item.common.right, item.common.bottom - item.common.top]).toEqual([168, 488, 16]);
  }
  p.state.cursorX = 0; p.state.cursorY = 0;
  await mouseEvent(p.state, 140, 190); await p.press(KeyCode.Mouse1);
  expect(item(menu, 101).common.flags & MenuFlag.Highlight).not.toBe(0);
  const oldNameBounds = [itemAt(menu.items, 4).common.left, itemAt(menu.items, 4).common.right];
  await p.press(KeyCode.Escape);
  expect(p.consoleCommands.pendingText).toBe("");
  await p.controls.show(); expect(p.controls.menu).toBe(menu); expect(menu.itemCount).toBe(52);
  expect([itemAt(menu.items, 4).common.left, itemAt(menu.items, 4).common.right]).not.toEqual(oldNameBounds);
  expect(item(menu, 101).common.flags & MenuFlag.Highlight).not.toBe(0);
});

test("Controls cvar reset/restore effects, float formatting, clamps and save queue", async () => {
  const p = await controls(); await cacheMenu(p.state);
  for (const [name, text] of [["cl_run", "0.75"], ["m_pitch", "-0.0375"], ["sensitivity", "31.25"],
    ["joy_threshold", "0.001"], ["m_filter", "3"], ["in_joystick", "-1"]] satisfies [string, string][]) p.cvars.set(name, text, true);
  const effects: string[] = [], reset = p.cvars.reset.bind(p.cvars), set = p.cvars.set.bind(p.cvars);
  p.cvars.reset = name => {
    effects.push(`reset:${name}`);
    const result = reset(name);
    effects.push(`default:${name}:${p.cvars.get(name)?.value}`);
    return result;
  };
  p.cvars.set = (name, text, force) => { effects.push(`set:${name}:${text}:${String(force)}`); return set(name, text, force); };
  await p.controls.show();
  expect(effects.filter(effect => effect.startsWith("reset:"))).toEqual([
    "reset:cl_run", "reset:m_pitch", "reset:cg_autoswitch", "reset:sensitivity", "reset:in_joystick", "reset:joy_threshold", "reset:m_filter", "reset:cl_freelook",
  ]);
  expect(effects.slice(0, 3)).toEqual(["reset:cl_run", "default:cl_run:1", "set:cl_run:0.750000:true"]);
  expect(p.cvars.get("m_pitch")?.value).toBe("-0.037500");
  expect([value(p.menu, 36), value(p.menu, 35), value(p.menu, 38), value(p.menu, 40), value(p.menu, 41), value(p.menu, 39)])
    .toEqual([0, 1, 30, Math.fround(.05), 1, 0]);
  await p.focus(38); await p.press(KeyCode.Left);
  p.cvars.set("m_pitch", "0.0125", true);
  await p.press(KeyCode.Escape);
  expect(p.cvars.get("m_pitch")?.value).toBe("-0.012500");
  expect(p.cvars.get("sensitivity")?.value).toBe("29");
  expect(p.cvars.get("joy_threshold")?.value).toBe("0.050000");
  expect(p.consoleCommands.pendingText).toBe("in_restart\n");
});

test("Controls restores large finite cvars through Cvar_SetValue before clamping menu values", async () => {
  const p = await controls();
  p.cvars.set("m_pitch", "2147483648", true);
  p.cvars.set("sensitivity", "1267650600228229401496703205376", true);
  await p.controls.show();
  expect(p.cvars.get("m_pitch")?.value).toBe("2147483648.000000");
  // Cvar_SetValue's 32-byte buffer truncates 2^100 followed by six decimal places.
  expect(p.cvars.get("sensitivity")?.value).toBe("1267650600228229401496703205376");
  expect(p.prints).toContain("Com_sprintf: overflow of 38 in 32\n");
  expect([value(p.menu, 35), value(p.menu, 38)]).toEqual([0, 30]);
  await p.focus(35); await p.press(KeyCode.Right); await p.press(KeyCode.Escape);
  expect(p.cvars.get("m_pitch")?.value).toBe("-2147483648");
  expect(p.cvars.get("sensitivity")?.value).toBe("30");
  expect(p.consoleCommands.pendingText).toBe("in_restart\n");
  expect(p.state.activeMenu).toBeNull();
});

test("Controls captures only first two exact case-insensitive bindings, promotes collisions and preserves untracked thirds", async () => {
  const p = await controls();
  p.keys.setBinding(97, "+FORWARD"); p.keys.setBinding(98, "+forward"); p.keys.setBinding(99, "+forward");
  p.keys.setBinding(100, "+back"); p.keys.setBinding(101, "+back"); p.keys.setBinding(102, "+forward; say wrong");
  await p.controls.show(); await p.section(100);
  await p.capture(4, 97);
  // Filling back's occupied pair clears those two real bindings immediately.
  expect([p.keys.getBinding(100), p.keys.getBinding(101), p.keys.getBinding(97)]).toEqual(["", "", "+FORWARD"]);
  await p.focus(3); await p.press(KeyCode.Backspace);
  expect([p.keys.getBinding(97), p.keys.getBinding(98), p.keys.getBinding(99)]).toEqual(["+FORWARD", "", "+forward"]);
  await p.press(KeyCode.Escape);
  expect([p.keys.getBinding(97), p.keys.getBinding(99), p.keys.getBinding(102)]).toEqual(["+back", "+forward", "+forward; say wrong"]);
  expect(p.consoleCommands.pendingText).toBe("-FORWARD 97 101\nin_restart\n");
});

test("Controls capture grays the source items, Escape cancels, characters/backtick pass through and Mouse2 binds", async () => {
  const p = await controls(); await p.controls.show(); await p.focus(12); await p.press(KeyCode.Enter);
  expect(p.menu.items.filter(item => !(item.common.flags & MenuFlag.Grayed))).toEqual([itemAt(p.menu.items, 4), item(p.menu, 12)]);
  // The engine intercepts physical backtick for the console; test the source UI key branch directly.
  await keyEvent(p.state, 96, true);
  // Character events enter the UI through ClientKeys.charEvent rather than a physical key slot.
  await p.keys.charEvent(113);
  expect(item(p.menu, 101).common.flags & MenuFlag.Grayed).not.toBe(0);
  await p.press(KeyCode.Escape);
  expect(p.state.activeMenu).toBe(p.menu); expect(item(p.menu, 101).common.flags & MenuFlag.Grayed).toBe(0);
  await p.press(KeyCode.Escape); expect(p.consoleCommands.pendingText).toBe("");
  await p.controls.show(); await p.capture(12, KeyCode.Mouse2);
  expect(p.state.activeMenu).toBe(p.menu); expect(p.keys.getBinding(KeyCode.Mouse2)).toBeNull();
  await p.press(KeyCode.Mouse2);
  expect(p.keys.getBinding(KeyCode.Mouse2)).toBe("+lookup"); expect(p.state.activeMenu).toBeNull();
});

test("Controls same-key reassignment and all three delete keys preserve immediate clear semantics", async () => {
  const p = await controls(); p.keys.setBinding(97, "+lookup"); p.keys.setBinding(98, "+lookup");
  await p.controls.show(); await p.capture(12, 97); await p.press(KeyCode.Escape);
  expect([p.keys.getBinding(97), p.keys.getBinding(98)]).toEqual(["+lookup", "+lookup"]);
  for (const key of [KeyCode.Backspace, KeyCode.Delete, KeyCode.KeypadDelete]) {
    await p.controls.show(); await p.focus(12); await p.press(key);
    expect([p.keys.getBinding(97), p.keys.getBinding(98)]).toEqual(["", ""]);
    await p.press(KeyCode.Escape); p.keys.setBinding(97, "+lookup"); p.keys.setBinding(98, "+lookup");
  }
});

test("Controls source inactive defaults and exit handlers preserve actual confirmation and config behavior", async () => {
  const p = await controls(); p.keys.setBinding(120, "+attack"); p.cvars.set("sensitivity", "12.5", true);
  await p.controls.show();
  expect(p.menu.items.some(item => [104, 106, 107].includes(item.common.id))).toBe(false);
  const back = item(p.menu, 105), callback = back.common.callback;
  if (callback === null) throw new Error("Missing actual Controls callback");
  back.common.id = 104; await callback(back, MenuEvent.Activated); back.common.id = 105;
  expect(p.state.activeMenu).toBe(p.confirm.menu);
  await p.press(110); expect(value(p.menu, 38)).toBe(12.5);
  back.common.id = 104; await callback(back, MenuEvent.Activated); back.common.id = 105;
  await p.press(121);
  expect(value(p.menu, 38)).toBe(5); expect(p.keys.getBinding(120)).toBe("+attack");
  await p.press(KeyCode.Escape);
  expect(p.keys.getBinding(KeyCode.Control)).toBe("+attack"); expect(p.keys.getBinding(120)).toBe("+attack");
  expect(p.keys.getBinding(KeyCode.Up)).toBe("+forward"); expect(p.keys.getBinding(49)).toBe("weapon 1");
});

test("Controls actual focus poses, first draw reload, model changes and ordered CPU player scene", async () => {
  const p = await controls(); await cacheMenu(p.state);
  const registrations: string[] = [], register = p.resources.registerModel.bind(p.resources);
  p.resources.registerModel = async path => {
    if (path === null) throw new Error("Controls preview fixture requires a model path");
    registrations.push(path); return await register(path);
  };
  await p.controls.show();
  expect(registrations.slice(-10)).toEqual([
    "models/weapons2/gauntlet/gauntlet.md3", "models/weapons2/shotgun/shotgun.md3", "models/weapons2/machinegun/machinegun.md3",
    "models/weapons2/grenadel/grenadel.md3", "models/weapons2/rocketl/rocketl.md3", "models/weapons2/lightning/lightning.md3",
    "models/weapons2/railgun/railgun.md3", "models/weapons2/plasma/plasma.md3", "models/weapons2/bfg/bfg.md3", "models/weapons2/grapple/grapple.md3",
  ]);
  await p.focus(12);
  expect(itemAt(p.infos, 0).viewAngles.x).toBe(-45);
  p.time(100); await refresh(p.state, 100);
  expect(p.modelLoads).toEqual(["sarge", "sarge"]); expect(itemAt(p.infos, 0).viewAngles.x).toBe(0);
  expect(p.scenes[0]?.refdef).toMatchObject({ x: 200, y: -20, width: 160, height: 280, time: 50 });
  p.commands.submit();
  const modelView = p.recorder.trace().findIndex(view => view.state.viewport.x === 200);
  expect(modelView).toBeGreaterThan(0);
  expect(modelView).toBeLessThan(p.recorder.trace().length - 1);
  expect(p.recorder.trace().some(view => view.batches.some(batch => batch.indices.length > 100))).toBe(true);
  const colored = p.cpu.pixels.filter((value, index) => index % 4 !== 3 && value > 0).length;
  expect(colored).toBeGreaterThan(10000);
  await p.section(100);
  for (const [id, legs, yaw, moveYaw] of [[2, PlayerAnimation.LEGS_RUN, 150, 150], [3, PlayerAnimation.LEGS_WALK, 150, 150],
    [4, PlayerAnimation.LEGS_BACK, 150, 150], [5, PlayerAnimation.LEGS_WALK, 150, 240], [6, PlayerAnimation.LEGS_WALK, 150, 60],
    [9, PlayerAnimation.LEGS_IDLE, 240, 150], [10, PlayerAnimation.LEGS_IDLE, 60, 150]] satisfies [number, number, number, number][]) {
    await p.focus(id); const info = itemAt(p.infos, 0);
    expect(info.legsAnim & ~128).toBe(legs); expect([info.viewAngles.y, info.moveAngles.y]).toEqual([yaw, moveYaw]);
  }
  await p.section(102);
  for (let id = 17; id <= 25; id++) { await p.focus(id); expect(itemAt(p.infos, 0).pendingWeapon).toBe(id - 16); }
  await p.section(103); await p.focus(30); expect(itemAt(p.infos, 0).chat).toBe(true);
  p.cvars.set("model", "visor/blue", true);
  p.time(200); await refresh(p.state, 200);
  expect(p.modelLoads).toEqual(["sarge", "sarge", "visor/blue"]); expect(p.infos).toHaveLength(1);
  expect(itemAt(p.infos, 0).chat).toBe(false); expect(itemAt(p.infos, 0).legsModel.path).toBe("models/players/visor/lower.md3");
});

test("Controls retirement during real registration never pushes the menu", async () => {
  const p = await controls(), gate = deferred();
  p.assets.beforeRead = async path => { if (path === "models/players/sarge/lower.md3") await gate.promise; };
  const showing = p.controls.show();
  while (!p.assets.reads.includes("models/players/sarge/lower.md3")) await Bun.sleep(1);
  p.state.retire(); gate.resolve();
  await expect(showing).rejects.toThrow("retired"); expect(p.state.activeMenu).toBeNull(); expect(p.menu.itemCount).toBe(52);
});

test("Controls clears embedded state before cache failure and restores source ranges and retained name bounds on reopen", async () => {
  const p = await controls(); await p.controls.show();
  const info = itemAt(p.infos, 0), legs = info.legs, torso = info.torso, animations = info.animations, firstAnimation = itemAt(animations, 0);
  const sensitivity = item(p.menu, 38), threshold = item(p.menu, 40), name = itemAt(p.menu.items, 4);
  const textItems = p.menu.items.filter(item => item.kind === "banner" || item.kind === "proportional");
  expect(info.legsModel.path).toBe("models/players/sarge/lower.md3");
  await p.press(KeyCode.Escape);
  const register = p.resources.registerShaderNoMip.bind(p.resources), failure = new Error("Controls first shader registration failed");
  let observed = 0;
  p.resources.registerShaderNoMip = async path => {
    observed++;
    expect(path).toBe("menu/art/back_0");
    expect(p.menu.items).toHaveLength(0);
    expect([info.legsModel, info.torsoModel, info.headModel, info.weaponModel]).toEqual([DEFAULT_MODEL, DEFAULT_MODEL, DEFAULT_MODEL, DEFAULT_MODEL]);
    expect(info.legs).toBe(legs); expect(info.torso).toBe(torso);
    expect(info.animations).toBe(animations); expect(itemAt(info.animations, 0)).toBe(firstAnimation);
    expect([info.weapon, info.pendingWeapon, info.legsAnim, info.torsoAnim, info.weaponTimer]).toEqual([0, 0, 0, 0, 0]);
    expect(info.legs.currentAnimation).toBeNull();
    expect(firstAnimation).toMatchObject({ firstFrame: 0, numFrames: 0, loopFrames: 0, frameLerp: 0, initialLerp: 0 });
    for (const slider of [sensitivity, threshold]) expect(slider).toMatchObject({ minvalue: 0, maxvalue: 0, curvalue: 0, range: 0 });
    for (const text of textItems) expect(text).toMatchObject({ text: null, style: 0 });
    throw failure;
  };
  await expect(p.controls.show()).rejects.toBe(failure);
  expect(observed).toBe(1); expect(p.state.activeMenu).toBeNull();
  p.resources.registerShaderNoMip = register;
  p.cvars.set("name", "New", true);
  await p.controls.show();
  expect(sensitivity).toMatchObject({ minvalue: 2, maxvalue: 30, curvalue: 5 });
  expect(threshold).toMatchObject({ minvalue: Math.fround(.05), maxvalue: Math.fround(.75), curvalue: Math.fround(.15) });
  expect(name).toMatchObject({ text: "New" });
  const previousNameWidth = stringWidth("PlayerTest"), previousNameX = 320 - Math.trunc(previousNameWidth / 2);
  expect([name.common.left, name.common.right]).toEqual([previousNameX - 3, previousNameX + previousNameWidth + 3]);
  expect(itemAt(p.infos, 0)).toBe(info); expect(info.legs).toBe(legs); expect(info.torso).toBe(torso);
  expect(info.animations).toBe(animations); expect(itemAt(info.animations, 0)).toBe(firstAnimation);
  await p.press(KeyCode.Escape); await p.controls.show();
  expect(name.common.right - name.common.left).toBe(stringWidth("New") + 6);
});
