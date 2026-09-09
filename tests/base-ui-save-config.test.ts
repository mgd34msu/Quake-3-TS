import { expect, test } from "bun:test";
import type { FieldClipboard } from "../src/core/edit-field.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import type { Vec4 } from "../src/core/math.ts";
import type { Rect2D, TextureRect } from "../src/render/draw2d.ts";
import { BaseConfirmMenu } from "../src/ui/base/confirm.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { mouseEvent, refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { BaseSaveConfigMenu } from "../src/ui/base/save-config.ts";
import { COLORS, MenuCommon, MenuEvent } from "../src/ui/base/state.ts";
import type { BaseMenuItem, MenuFieldItem } from "../src/ui/base/state.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

const art: readonly [string, string, string, string, string] = ["menu/art/back_0", "menu/art/back_1", "menu/art/save_0", "menu/art/save_1", "menu/art/cut_frame"];
type Fixture = Awaited<ReturnType<typeof baseFixture>>;
function item(owner: BaseSaveConfigMenu, index: number): BaseMenuItem {
  const result = owner.menu.items[index];
  if (result === undefined) throw new Error(`Missing save config item ${index}`);
  return result;
}
function filename(owner: BaseSaveConfigMenu): MenuFieldItem {
  const result = item(owner, 2);
  if (result.kind !== "field") throw new Error("Expected source filename field");
  return result;
}
async function event(owner: BaseSaveConfigMenu, index = 4, kind = MenuEvent.Activated): Promise<void> {
  const value = item(owner, index), callback = value.common.callback;
  if (callback === null) throw new Error("Missing save config callback");
  await callback(value, kind);
}
async function press(f: Fixture, key: number): Promise<void> {
  await f.keys.keyEvent(key, true, 10); await f.keys.keyEvent(key, false, 11);
}
async function type(f: Fixture, text: string): Promise<void> {
  for (const character of text) await f.keys.charEvent(character.charCodeAt(0));
}

test("save config exact five records, source custom field bounds and cache-only behavior", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseSaveConfigMenu(f.state), menu = owner.menu;
    f.registrations.length = 0; await owner.cache();
    expect(f.registrations).toEqual(art.map(name => `shader:${name}`));
    expect(menu.items).toEqual([]); expect(f.state.menuDepth).toBe(0);
    f.registrations.length = 0; await owner.show();
    expect(owner.menu).toBe(menu); expect(menu.itemCount).toBe(5);
    expect(f.registrations).toEqual(art.map(name => `shader:${name}`));
    expect(menu.items.map(value => [value.kind, value.common.name, value.common.id, value.common.x, value.common.y, value.common.flags])).toEqual([
      ["banner", null, 0, 320, 16, 0x4000], ["bitmap", art[4], 0, 142, 118, 0x4000],
      ["field", null, 0, 240, 227, 0x88000], ["bitmap", art[0], 11, 0, 416, 0x104], ["bitmap", art[2], 12, 640, 416, 0x110],
    ]);
    expect(menu.items.map(value => [value.common.left, value.common.top, value.common.right, value.common.bottom])).toEqual([
      [0, 0, 0, 0], [142, 118, 501, 374], [240, 227, 393, 245], [0, 416, 128, 480], [512, 416, 640, 480],
    ]);
    expect(menu.items.every((value, index) => value.common.parent === menu && value.common.menuPosition === index && value.common.statusbar === null)).toBe(true);
    expect(menu.items.map(value => [value.common.callback !== null, value.common.ownerdraw !== null])).toEqual([
      [false, false], [false, false], [false, true], [true, false], [true, false],
    ]);
    expect(menu.items.flatMap(value => value.kind === "bitmap" ? [[value.width, value.height, value.focuspic, value.shader, value.focusshader, value.errorpic, value.focuscolor]] : [])).toEqual([
      [359, 256, null, null, null, null, null], [128, 64, art[1], null, null, null, null], [128, 64, art[3], null, null, null, null],
    ]);
    const banner = item(owner, 0); if (banner.kind !== "banner") throw new Error("Expected source banner");
    expect([banner.text, banner.color, banner.style]).toEqual(["SAVE CONFIG", COLORS.white, 1]);
    expect([menu.cursor, menu.cursorPrev, menu.fullscreen, menu.wrapAround, menu.showlogo, menu.draw, menu.key]).toEqual([2, 0, true, true, false, null, null]);
    const field = filename(owner).field;
    expect([field.text, field.cursor, field.scroll, field.widthInChars, field.maxchars]).toEqual(["", 0, 0, 20, 20]);
    field.setText("keep"); const items = [...menu.items]; await owner.cache();
    expect(field.text).toBe("keep"); expect(menu.items).toEqual(items); expect(f.state.menuDepth).toBe(1);
    expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui);
  } finally { f.close(); }
});

test("save config resets stable records before the first cache await and reopens its existing stack identity", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseSaveConfigMenu(f.state); await owner.show();
    const menu = owner.menu, items = [...menu.items], commons = items.map(value => value.common), field = filename(owner).field;
    field.setText("z".repeat(200)); field.cursor = 80; field.scroll = 60;
    menu.showlogo = true; menu.draw = async () => undefined; menu.key = async () => ({ kind: "none" });
    for (const value of items) { value.common.id = 999; value.common.flags = 999; value.common.statusbar = async () => undefined; }
    const gate = deferred(), entered = deferred(), register = f.resources.registerShaderNoMip.bind(f.resources);
    f.resources.registerShaderNoMip = async name => { entered.resolve(); await gate.promise; return await register(name); };
    const pending = owner.show(); await entered.promise;
    expect([menu.itemCount, menu.items.length, menu.cursor, menu.cursorPrev, menu.fullscreen, menu.wrapAround, menu.showlogo]).toEqual([0, 0, 0, 0, false, false, false]);
    expect(menu.draw).toBeNull(); expect(menu.key).toBeNull();
    expect([field.text, field.cursor, field.scroll, field.widthInChars, field.maxchars]).toEqual(["", 0, 0, 0, 0]);
    for (const value of items) {
      expect(value.common).toEqual(new MenuCommon());
      if (value.kind === "bitmap") expect([value.width, value.height, value.focuspic, value.errorpic, value.shader, value.focusshader, value.focuscolor]).toEqual([0, 0, null, null, null, null, null]);
    }
    gate.resolve(); await pending;
    for (const [index, value] of menu.items.entries()) {
      const original = items[index], common = commons[index];
      if (original === undefined || common === undefined) throw new Error("Missing retained source item");
      expect(value).toBe(original); expect(value.common).toBe(common);
    }
    expect(filename(owner).field).toBe(field); expect(f.state.menuDepth).toBe(1); expect(menu.cursor).toBe(2);
    await type(f, "abcdefghijklmnopqrstuv"); expect(field.text).toBe("ABCDEFGHIJKLMNOPQRSV"); expect(field.cursor).toBe(19);
    await owner.show(); await type(f, "abc"); expect(field.text).toBe("ABC");
  } finally { f.close(); }
});

test("save config cache failure preserves cleared state and retry repeats five registrations", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseSaveConfigMenu(f.state); await owner.show(); const field = filename(owner).field; field.setText("old");
    const register = f.resources.registerShaderNoMip.bind(f.resources), calls: string[] = [], failure = new Error("cache failure");
    f.registrations.length = 0;
    f.resources.registerShaderNoMip = async name => { if (name === null) throw new Error("Authored menu cache requires a shader name"); calls.push(name); if (name === art[3]) throw failure; return await register(name); };
    await expect(owner.show()).rejects.toBe(failure);
    expect(calls).toEqual(art.slice(0, 4)); expect(f.registrations).toEqual(art.slice(0, 3).map(name => `shader:${name}`));
    expect(field.text).toBe(""); expect(owner.menu.items).toEqual([]); expect(owner.menu.fullscreen).toBe(false);
    f.resources.registerShaderNoMip = register; f.registrations.length = 0; await owner.show();
    expect(f.registrations).toEqual(art.map(name => `shader:${name}`)); expect(f.state.menuDepth).toBe(1);
  } finally { f.close(); }
});

test("save config real key navigation maps Enter keypad and four joystick keys to Tab, never Save", async () => {
  const f = await baseFixture(); try {
    await cacheMenu(f.state); const owner = new BaseSaveConfigMenu(f.state);
    for (const key of [KeyCode.Enter, KeyCode.KeypadEnter, KeyCode.Joy1, KeyCode.Joy2, KeyCode.Joy3, KeyCode.Joy4]) {
      await owner.show(); await type(f, "name"); await press(f, key);
      expect(owner.menu.cursor).toBe(3); expect(f.consoleCommands.pendingText).toBe(""); expect(f.state.menuDepth).toBe(1);
    }
    for (const [key, cursor] of [[KeyCode.Tab, 4], [KeyCode.Down, 2], [KeyCode.Up, 4], [KeyCode.KeypadUp, 3], [KeyCode.KeypadDown, 4]] satisfies readonly (readonly [number, number])[]) {
      await press(f, key); expect(owner.menu.cursor).toBe(cursor);
    }
    await press(f, KeyCode.Enter); expect(f.consoleCommands.pendingText).toBe("writeconfig NAME.cfg\n"); expect(f.state.menuDepth).toBe(0);
  } finally { f.close(); }
});

test("save config actual field editing preserves source overstrike, cursor cap, residual tails and byte errors", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseSaveConfigMenu(f.state); await owner.show(); const field = filename(owner).field;
    await type(f, "abcdefghijklmnopqrstuv"); expect([field.text, field.cursor, field.scroll]).toEqual(["ABCDEFGHIJKLMNOPQRSV", 19, 0]);
    await press(f, KeyCode.End); expect([field.cursor, field.scroll]).toEqual([20, 1]);
    await type(f, "x"); expect(field.text).toBe("ABCDEFGHIJKLMNOPQRSV");
    await press(f, KeyCode.Home); await press(f, KeyCode.Insert); expect(f.keys.getOverstrike()).toBe(true);
    await type(f, "z"); expect(field.text).toBe("ABCDEFGHIJKLMNOPQRSV");
    await press(f, KeyCode.Delete); await type(f, "z"); expect(field.text).toBe("ZBCDEFGHIJKLMNOPQRSV");
    await f.keys.charEvent(8); expect(field.text).toBe("BCDEFGHIJKLMNOPQRSV");
    await press(f, KeyCode.Insert); expect(f.keys.getOverstrike()).toBe(false);
    field.setText("z".repeat(30)); await f.keys.charEvent(3); await type(f, "abcdefghijklmnopqrst");
    expect(field.text).toBe("ABCDEFGHIJKLMNOPQRST" + "z".repeat(10));
    await owner.show(); await type(f, "abcdefghijklmnopqrst"); expect(field.text).toBe("ABCDEFGHIJKLMNOPQRST");
    expect(() => field.setText("\u0100")).toThrow(); expect(() => field.setText("x".repeat(256))).toThrow("source buffer");
    field.cursor = 256; field.maxchars = 0; await expect(type(f, "x")).rejects.toThrow("buffer index");
  } finally { f.close(); }
});

test("save config real ClientKeys dispatch preserves lowercase paste, signed bytes, NUL, clipboard limit and unavailable clipboard", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseSaveConfigMenu(f.state); await owner.show(); const field = filename(owner).field;
    await f.keys.charEvent(22); expect(field.text).toBe("");
    let bytes: Uint8Array | null = new Uint8Array([97, 255, 128, 98, 0, 99]);
    const clipboard: FieldClipboard = { kind: "available", read: () => bytes };
    Object.assign(f.state.services, { clipboard });
    await f.keys.charEvent(22); expect(field.text).toBe("ab"); await type(f, "c"); expect(field.text).toBe("abC");
    for (const key of [KeyCode.Insert, KeyCode.KeypadInsert]) {
      await owner.show(); await f.keys.keyEvent(KeyCode.Shift, true, 20); await press(f, key); await f.keys.keyEvent(KeyCode.Shift, false, 21);
      expect(field.text).toBe("ab"); expect(f.keys.getOverstrike()).toBe(false);
    }
    bytes = null; await f.keys.charEvent(22); expect(field.text).toBe("ab");
    await owner.show(); bytes = new Uint8Array(100).fill(97); await f.keys.charEvent(22); expect(field.text).toBe("a".repeat(20)); expect(field.cursor).toBe(19);
    await owner.show(); field.maxchars = 0; field.widthInChars = 100; await f.keys.charEvent(22); expect(field.text).toBe("a".repeat(63));
    await owner.show(); expect([field.maxchars, field.widthInChars]).toEqual([20, 20]);
  } finally { f.close(); }
});

test("save config exact pending byte matrix strips the first dot and pops only for original nonempty input", async () => {
  const f = await baseFixture(); try {
    const printedBefore = f.prints.length;
    const owner = new BaseSaveConfigMenu(f.state), parent = new BaseConfirmMenu(f.state); await parent.show("Parent", null, null);
    let expected = "preceding\n", executions = 0; f.consoleCommands.append(expected); f.consoleCommands.register("writeconfig", () => { executions++; });
    const cases: readonly (readonly [string, string])[] = [
      ["", ""], ["\0ignored", ""], ["CONFIG", "writeconfig CONFIG.cfg\n"], ["A.B.C", "writeconfig A.cfg\n"],
      ["DIR.V1/FILE", "writeconfig DIR.cfg\n"], [".hidden", "writeconfig .cfg\n"], ["mixed Name", "writeconfig mixed Name.cfg\n"],
      [' a/b;"c" ', 'writeconfig  a/b;"c" .cfg\n'], ["before\0after", "writeconfig before.cfg\n"],
      ["caf\u00e9\u00ff\u0080", "writeconfig caf\u00e9\u00ff\u0080.cfg\n"],
    ];
    for (const [text, command] of cases) {
      await owner.show(); filename(owner).field.setText(text); await event(owner); expected += command;
      expect(f.consoleCommands.pendingText).toBe(expected);
      expect(Array.from(f.consoleCommands.pendingText, character => character.charCodeAt(0))).toEqual(Array.from(expected, character => character.charCodeAt(0)));
      expect(f.state.activeMenu).toBe(command === "" ? owner.menu : parent.menu); expect(f.state.menuDepth).toBe(command === "" ? 2 : 1);
    }
    expect(executions).toBe(0); expect(f.prints.slice(printedBefore)).toEqual([]);
  } finally { f.close(); }
});

test("save config reached 64-byte stem errors but long suffix after an earlier dot does not overflow", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseSaveConfigMenu(f.state);
    for (const text of ["a".repeat(64), "a".repeat(64) + ".cfg", "a".repeat(255)]) {
      await owner.show(); filename(owner).field.setText(text); await expect(event(owner)).rejects.toThrow("filename write");
      expect(f.consoleCommands.pendingText).toBe(""); expect(f.state.activeMenu).toBe(owner.menu);
    }
    let expected = "";
    for (const [text, stem] of [["a".repeat(63), "a".repeat(63)], ["a".repeat(63) + "." + "z".repeat(191), "a".repeat(63)], ["." + "z".repeat(254), ""]]) {
      if (text === undefined || stem === undefined) throw new Error("Missing source stem case");
      await owner.show(); filename(owner).field.setText(text); await event(owner); expected += `writeconfig ${stem}.cfg\n`;
      expect(f.consoleCommands.pendingText).toBe(expected); expect(f.state.menuDepth).toBe(0);
    }
  } finally { f.close(); }
});

test("save config Back, Escape and actual mouse preserve pending bytes and custom hit bounds", async () => {
  const f = await baseFixture(); try {
    await cacheMenu(f.state); const owner = new BaseSaveConfigMenu(f.state), parent = new BaseConfirmMenu(f.state); await parent.show("Parent", null, null);
    f.consoleCommands.append("prefix\n");
    for (const kind of [MenuEvent.GotFocus, MenuEvent.LostFocus]) {
      await owner.show(); filename(owner).field.setText("name"); await event(owner, 3, kind); await event(owner, 4, kind); expect(f.state.activeMenu).toBe(owner.menu);
    }
    await press(f, KeyCode.Escape); expect(f.state.activeMenu).toBe(parent.menu);
    await owner.show(); await event(owner, 3); expect(f.state.activeMenu).toBe(parent.menu);
    await owner.show(); await setCursorToItem(f.state, owner.menu, item(owner, 4));
    f.state.cursorX = 0; f.state.cursorY = 0; await mouseEvent(f.state, 394, 230); expect(owner.menu.cursor).toBe(4);
    await mouseEvent(f.state, -1, 0); expect(owner.menu.cursor).toBe(2);
    await mouseEvent(f.state, -343, 220); expect(owner.menu.cursor).toBe(3); await press(f, KeyCode.Mouse1); expect(f.state.activeMenu).toBe(parent.menu);
    expect(f.consoleCommands.pendingText).toBe("prefix\n");
    await owner.show(); filename(owner).field.setText("mouse"); await mouseEvent(f.state, 500, 0); expect(owner.menu.cursor).toBe(4);
    await press(f, KeyCode.Mouse1); expect(f.consoleCommands.pendingText).toBe("prefix\nwriteconfig mouse.cfg\n"); expect(f.state.activeMenu).toBe(parent.menu);
  } finally { f.close(); }
});

test("save config real append overflow still pops and successful append survives later pop failure", async () => {
  const f = await baseFixture(); try {
    await cacheMenu(f.state); const owner = new BaseSaveConfigMenu(f.state); await owner.show(); filename(owner).field.setText("name");
    f.cvars.set("cl_paused", "1", true); f.consoleCommands.append("x".repeat(16383)); f.events.length = 0;
    const printedBefore = f.prints.length;
    await event(owner);
    expect(f.prints.slice(printedBefore)).toEqual(["Cbuf_AddText: overflow\n"]);
    expect(f.state.menuDepth).toBe(0); expect(f.state.activeMenu).toBeNull(); expect(f.keys.getCatcher()).toBe(0);
    expect(f.cvars.get("cl_paused")?.value).toBe("0"); expect(f.events).toEqual(["sound:sound/misc/menu3.wav:6"]);
    expect(f.consoleCommands.pendingText).toBe("x".repeat(16383));
  } finally { f.close(); }
  const g = await baseFixture(); try {
    await cacheMenu(g.state); const owner = new BaseSaveConfigMenu(g.state); await owner.show(); filename(owner).field.setText("kept");
    const failure = new Error("pop clear failure"); g.keys.clearStates = async () => { throw failure; };
    await expect(event(owner)).rejects.toBe(failure); expect(g.consoleCommands.pendingText).toBe("writeconfig kept.cfg\n");
    expect(g.state.menuDepth).toBe(0); expect(g.state.activeMenu).toBeNull(); expect(g.events).toContain("sound:sound/misc/menu3.wav:6");
  } finally { g.close(); }
});

test("save config retirement after cache await prevents initialization and all later entry effects", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseSaveConfigMenu(f.state); await owner.show();
    const save = item(owner, 4), back = item(owner, 3), field = filename(owner), saveCallback = save.common.callback, backCallback = back.common.callback, draw = field.common.ownerdraw;
    if (saveCallback === null || backCallback === null || draw === null) throw new Error("Missing source callbacks");
    const register = f.resources.registerShaderNoMip.bind(f.resources), calls: string[] = [];
    f.resources.registerShaderNoMip = async name => { if (name === null) throw new Error("Authored menu cache requires a shader name"); calls.push(name); const result = await register(name); f.state.retire(); return result; };
    await expect(owner.show()).rejects.toThrow("retired"); expect(calls).toEqual([art[0]]); expect(owner.menu.items).toEqual([]);
    await expect(owner.cache()).rejects.toThrow("retired"); await expect(owner.show()).rejects.toThrow("retired");
    await expect(saveCallback(save, MenuEvent.Activated)).rejects.toThrow("retired"); await expect(backCallback(back, MenuEvent.Activated)).rejects.toThrow("retired");
    await expect(draw(field)).rejects.toThrow("retired"); expect(f.consoleCommands.pendingText).toBe(""); expect(calls).toEqual([art[0]]);
  } finally { f.close(); }
});

test("save config append-triggered retirement preserves bytes and suppresses pop", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseSaveConfigMenu(f.state); await owner.show(); filename(owner).field.setText("keep");
    const append = f.consoleCommands.append.bind(f.consoleCommands);
    f.consoleCommands.append = text => { append(text); f.state.retire(); };
    await expect(event(owner)).rejects.toThrow("retired"); expect(f.consoleCommands.pendingText).toBe("writeconfig keep.cfg\n");
    expect(f.state.menuDepth).toBe(1); expect(f.state.activeMenu).toBe(owner.menu);
  } finally { f.close(); }
});

test("save config checks retirement after awaited pop with source partial clearing retained", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseSaveConfigMenu(f.state); await owner.show(); filename(owner).field.setText("keep"); f.cvars.set("cl_paused", "1", true);
    const gate = deferred(), entered = deferred(), clear = f.keys.clearStates.bind(f.keys);
    f.keys.clearStates = async () => { entered.resolve(); await gate.promise; await clear(); };
    const pending = event(owner); await entered.promise; expect(f.consoleCommands.pendingText).toBe("writeconfig keep.cfg\n");
    expect(f.state.activeMenu).toBeNull(); f.state.retire(); gate.resolve(); await expect(pending).rejects.toThrow("retired");
    expect(f.cvars.get("cl_paused")?.value).toBe("1");
  } finally { f.close(); }
});

test("save config escaped real command execution cannot resume a suspended cache", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseSaveConfigMenu(f.state), gate = deferred(), register = f.resources.registerShaderNoMip.bind(f.resources);
    let escaped: Promise<void> | null = null;
    f.resources.registerShaderNoMip = async name => { await gate.promise; return await register(name); };
    f.consoleCommands.register("escape", () => { escaped = owner.show(); });
    await f.consoleCommands.executeNowAsync("escape"); gate.resolve();
    if (escaped === null) throw new Error("Missing escaped operation");
    await expect(escaped).rejects.toThrow("closed command execution context"); expect(owner.menu.items).toEqual([]); expect(f.state.activeMenu).toBeNull();
  } finally { f.close(); }
});

test("save config retail CPU ownerdraw uses centered orange prompt, raw coordinates, black box and real field glyphs", async () => {
  const f = await baseFixture(640, 480); try {
    await cacheMenu(f.state); const owner = new BaseSaveConfigMenu(f.state); await owner.show(); const field = filename(owner);
    field.field.setText("abc"); field.field.cursor = 3;
    const glyphs: { readonly rect: Rect2D; readonly uv: TextureRect; readonly color: Vec4 | null; readonly byte: number }[] = [];
    const prompt: { readonly rect: Rect2D; readonly uv: TextureRect; readonly color: Vec4 | null }[] = [];
    const proportional = f.resources.picture(f.state.media.proportional);
    const picture = f.resources.picture(f.state.media.charset), stretch = f.state.draw.stretchPixels.bind(f.state.draw), setColor = f.state.draw.setColor.bind(f.state.draw);
    let color: Vec4 | null = null;
    f.state.draw.setColor = value => { color = value === null ? null : { ...value }; setColor(value); };
    f.state.draw.stretchPixels = (rect, uv, actual) => {
      if (actual === picture) glyphs.push({ rect: { ...rect }, uv: { ...uv }, color, byte: (uv.t * 256 + uv.s * 16) & 255 });
      if (actual === proportional) prompt.push({ rect: { ...rect }, uv: { ...uv }, color });
      stretch(rect, uv, actual);
    };
    await refresh(f.state, 75); f.commands.submit();
    expect(prompt.map(glyph => [glyph.uv.s * 256, glyph.uv.t * 256])).toEqual([
      [90, 4], [6, 34], [130, 34], [90, 4], [90, 34], [106, 4], [164, 4], [216, 4],
      [90, 4], [6, 34], [5, 4], [230, 4], [90, 4], [59, 181],
    ]);
    expect(prompt.every(glyph => glyph.rect.y === 192 && glyph.rect.height === 20.25)).toBe(true);
    expect(prompt.map(glyph => glyph.color)).toEqual(Array.from({ length: 14 }, () => COLORS.normal));
    const firstPrompt = prompt[0], lastPrompt = prompt.at(-1);
    if (firstPrompt === undefined || lastPrompt === undefined) throw new Error("Missing actual proportional prompt");
    expect(firstPrompt.rect.x).toBe(227); expect(lastPrompt.rect.x + lastPrompt.rect.width).toBe(414.5);
    const letters = glyphs.filter(glyph => glyph.rect.y === 227);
    expect(letters.map(glyph => [glyph.rect.x, glyph.rect.y, glyph.rect.width, glyph.rect.height, glyph.byte])).toEqual([
      [240, 227, 8, 16, 97], [248, 227, 8, 16, 98], [256, 227, 8, 16, 99], [264, 227, 8, 16, 10],
    ]);
    expect(letters.every(glyph => glyph.color !== null && glyph.color.x > 0 && glyph.color.x === glyph.color.y && glyph.color.z === 0)).toBe(true);
    const batches = f.recorder.trace().flatMap(view => view.batches);
    expect(batches.some(batch => batch.vertices.some(vertex => vertex.color.x === 1 && Math.round(vertex.color.y * 255) === 109 && vertex.color.z === 0))).toBe(true);
    const blackVertices = batches.flatMap(batch => batch.vertices).filter(vertex => vertex.color.x === 0 && vertex.color.y === 0 && vertex.color.z === 0);
    const blackXs = blackVertices.map(vertex => (vertex.position.x + 1) * 320), blackYs = blackVertices.map(vertex => (1 - vertex.position.y) * 240);
    expect(Math.min(...blackXs)).toBeCloseTo(240, 3); expect(Math.max(...blackXs)).toBeCloseTo(400, 3);
    expect(Math.min(...blackYs)).toBeCloseTo(227, 3); expect(Math.max(...blackYs)).toBeCloseTo(243, 3);
    const artNames = batches.flatMap(batch => batch.texture.kind === "bind-image" ? [batch.texture.image.name] : []);
    for (const name of ["cut_frame", "back_0", "save_0"]) expect(artNames.some(value => value.includes(name))).toBe(true);
    const before = f.cpu.pixels.slice(); glyphs.length = 0; await setCursorToItem(f.state, owner.menu, item(owner, 3)); await refresh(f.state, 75); f.commands.submit();
    expect(glyphs.filter(glyph => glyph.rect.y === 227).map(glyph => [glyph.byte, glyph.color])).toEqual([[97, COLORS.red], [98, COLORS.red], [99, COLORS.red]]);
    expect(f.cpu.pixels.some((byte, index) => byte !== before[index])).toBe(true);
    glyphs.length = 0; await setCursorToItem(f.state, owner.menu, field); f.keys.setOverstrike(true);
    field.field.setText("abcdefghijklmnopqrstuvwx"); field.field.cursor = 24; field.field.scroll = 20;
    await refresh(f.state, 75); f.commands.submit(); expect(field.field.scroll).toBe(5);
    expect(glyphs.filter(glyph => glyph.rect.y === 227).map(glyph => glyph.byte)).toEqual([...Array.from("fghijklmnopqrstuvwx", character => character.charCodeAt(0)), 11]);
    glyphs.length = 0; await refresh(f.state, 256); f.commands.submit(); expect(glyphs.filter(glyph => glyph.rect.y === 227).some(glyph => glyph.byte === 11)).toBe(false);
  } finally { f.close(); }
});
