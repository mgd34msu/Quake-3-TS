import { expect, test } from "bun:test";
import { CvarFlag } from "../src/core/cvar.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { CommonCdKeyState } from "../src/engine/cd-key.ts";
import { BaseCdKeyMenu } from "../src/ui/base/cd-key.ts";
import { BaseConfirmMenu } from "../src/ui/base/confirm.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { MenuField } from "../src/ui/base/field.ts";
import { mouseEvent, refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { COLORS, MenuEvent, MenuFlag } from "../src/ui/base/state.ts";
import type { BaseMenuItem, MenuFieldItem } from "../src/ui/base/state.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

const art: readonly [string, string, string, string, string] = ["menu/art/accept_0", "menu/art/accept_1", "menu/art/back_0", "menu/art/back_1", "menu/art/cut_frame"];
type Fixture = Awaited<ReturnType<typeof baseFixture>>;
function item(owner: BaseCdKeyMenu, index: number): BaseMenuItem {
  const value = owner.menu.items[index];
  if (value === undefined) throw new Error(`Missing source CD key item ${index}`);
  return value;
}
function field(owner: BaseCdKeyMenu): MenuFieldItem {
  const value = item(owner, 2);
  if (value.kind !== "field") throw new Error("Expected source CD key field");
  return value;
}
function read(keys: CommonCdKeyState): Uint8Array {
  const bytes = new Uint8Array(17); keys.readUiForCompiledModule(() => 1, () => bytes); return bytes;
}
async function event(owner: BaseCdKeyMenu, index = 3, kind = MenuEvent.Activated): Promise<void> {
  const value = item(owner, index), callback = value.common.callback;
  if (callback === null) throw new Error("Missing source CD key callback");
  await callback(value, kind);
}
async function press(f: Fixture, key: number): Promise<void> {
  await f.keys.keyEvent(key, true, 10); await f.keys.keyEvent(key, false, 11);
}

test("menu field raw copies preserve NUL tails and cursor state without exposing mutable storage", () => {
  const value = new MenuField();
  value.setText("synthetic tail"); value.cursor = 7; value.scroll = 4; value.widthInChars = 16; value.maxchars = 16;
  const bytes = new Uint8Array([65, 0, 200]); value.setBytes(bytes); bytes.fill(17);
  expect([...value.copyBytes(6)]).toEqual([65, 0, 200, 116, 104, 101]);
  expect(value.text).toBe("A");
  expect([value.cursor, value.scroll, value.widthInChars, value.maxchars]).toEqual([7, 4, 16, 16]);
  const copy = value.copyBytes(256); copy.fill(99);
  expect(value.text).toBe("A"); expect(value.copyBytes(3)[2]).toBe(200);
  value.setBytes(new Uint8Array()); expect(value.text).toBe("A");
  for (const length of [-1, 257, .5, NaN, Infinity]) expect(() => value.copyBytes(length)).toThrow("source buffer");
  expect(() => value.setBytes(new Uint8Array(257))).toThrow("source buffer");
  expect(value.text).toBe("A"); value.setText("");
  expect([...value.copyBytes(3)]).toEqual([0, 0, 200]);
  value.reset(); expect([...value.copyBytes(256)]).toEqual([...new Uint8Array(256)]);
});

test("CD key source cache and four initial menu items use exact field bounds and default zero-byte clearing", async () => {
  const f = await baseFixture(); try {
    const keys = new CommonCdKeyState(f.cvars, "client"), owner = new BaseCdKeyMenu(f.state, keys, () => 1), menu = owner.menu;
    expect(menu.itemCount).toBe(0); expect(f.cvars.get("ui_cdkeychecked")?.value).toBe("0");
    f.registrations.length = 0; await owner.show();
    expect(f.registrations).toEqual(art.map(name => `shader:${name}`));
    expect(f.cvars.get("ui_cdkeychecked")?.value).toBe("1");
    expect(f.cvars.get("ui_cdkeychecked")?.flags).toBe(CvarFlag.ReadOnly);
    expect(owner.menu).toBe(menu);
    expect(menu.items.map(value => [value.kind, value.common.name, value.common.id, value.common.x, value.common.y, value.common.flags])).toEqual([
      ["banner", null, 0, 320, 16, MenuFlag.Inactive], ["bitmap", art[4], 0, 142, 118, MenuFlag.Inactive],
      ["field", "CD Key:", 0, 280, 232, MenuFlag.Lowercase], ["bitmap", art[0], 11, 640, 416, MenuFlag.RightJustify | MenuFlag.PulseIfFocus],
    ]);
    expect(menu.items.map(value => [value.common.left, value.common.top, value.common.right, value.common.bottom])).toEqual([
      [0, 0, 0, 0], [142, 118, 501, 374], [152, 232, 552, 248], [512, 416, 640, 480],
    ]);
    expect(menu.items.every((value, index) => value.common.parent === menu && value.common.menuPosition === index)).toBe(true);
    expect(menu.items.map(value => value.common.callback !== null)).toEqual([false, false, false, true]);
    expect(menu.items.map(value => value.common.ownerdraw !== null)).toEqual([false, false, true, false]);
    const entry = field(owner).field;
    expect([entry.text, entry.widthInChars, entry.maxchars, entry.cursor, entry.scroll]).toEqual(["", 16, 16, 0, 0]);
    expect([...entry.copyBytes(18)]).toEqual([0, ...new Uint8Array(15).fill(32), 0, 0]);
    expect([menu.cursor, menu.cursorPrev, menu.itemCount, menu.fullscreen, menu.wrapAround, menu.showlogo, menu.draw, menu.key]).toEqual([2, 0, 4, true, true, false, null, null]);
    expect(f.state.menuDepth).toBe(1); expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui);
  } finally { f.close(); }
});

test("CD key source adds Back only at nonzero menu depth and reopens stable menu/item/field identities", async () => {
  const f = await baseFixture(); try {
    const parent = new BaseConfirmMenu(f.state); await parent.show("PARENT", null, async () => undefined);
    const keys = new CommonCdKeyState(f.cvars, "client"), owner = new BaseCdKeyMenu(f.state, keys, () => 1);
    keys.writeUiForCompiledModule(() => 1, () => new Uint8Array(16).fill(65)); await owner.show();
    expect(owner.menu.itemCount).toBe(5); const back = item(owner, 4);
    expect([back.common.id, back.common.name, back.common.x, back.common.y, back.common.flags]).toEqual([12, art[2], 0, 416, MenuFlag.LeftJustify | MenuFlag.PulseIfFocus]);
    expect(field(owner).field.text).toBe("A".repeat(16));
    const items = [...owner.menu.items], commons = items.map(value => value.common), entry = field(owner).field;
    entry.cursor = 14; entry.scroll = 9; owner.menu.showlogo = true;
    await owner.show();
    for (const [index, value] of owner.menu.items.entries()) { expect(items[index]).toBe(value); expect(commons[index]).toBe(value.common); }
    expect(field(owner).field).toBe(entry); expect([entry.cursor, entry.scroll, owner.menu.showlogo]).toEqual([0, 0, false]);
    expect(f.state.menuDepth).toBe(2);
    await event(owner, 4); expect(f.state.activeMenu).toBe(parent.menu); expect(f.state.menuDepth).toBe(1);
  } finally { f.close(); }
});

test("forced checked write precedes cache and failed recache retains the complete old source record", async () => {
  const f = await baseFixture(); try {
    const keys = new CommonCdKeyState(f.cvars, "client"), owner = new BaseCdKeyMenu(f.state, keys, () => 1);
    await owner.show(); const menu = owner.menu, items = [...menu.items], entry = field(owner).field;
    entry.setText("old"); entry.cursor = 2;
    f.cvars.set("ui_cdkeychecked", "0", true);
    const register = f.resources.registerShaderNoMip.bind(f.resources), failure = new Error("source cache failure"), seen: string[] = [];
    f.resources.registerShaderNoMip = async name => { if (name === null) throw new Error("Authored menu cache requires a shader name");
      expect(f.cvars.get("ui_cdkeychecked")?.value).toBe("1");
      expect(menu.items).toEqual(items); expect(entry.text).toBe("old");
      seen.push(name); if (seen.length === 3) throw failure; return await register(name);
    };
    await expect(owner.show()).rejects.toBe(failure);
    expect(seen).toEqual(art.slice(0, 3)); expect(menu.items).toEqual(items); expect(entry.cursor).toBe(2);
    expect(f.state.activeMenu).toBe(menu); expect(f.state.menuDepth).toBe(1);
    f.resources.registerShaderNoMip = register; await owner.show();
    expect(field(owner).field).toBe(entry); expect(entry.text).toBe(""); expect(entry.cursor).toBe(0);
    expect(owner.menu.itemCount).toBe(5);
  } finally { f.close(); }
});

test("empty Accept skips writes but pops, nonempty invalid Accept copies raw tails without validation", async () => {
  for (const nonempty of [false, true]) {
    const f = await baseFixture(); try {
      await cacheMenu(f.state);
      const keys = new CommonCdKeyState(f.cvars, "client"), owner = new BaseCdKeyMenu(f.state, keys, () => 1);
      await owner.show();
      const before = read(keys), raw = Uint8Array.from({ length: 17 }, (_, index) => index === 0 ? 33 : index === 1 || index === 16 ? 0 : 160 + index);
      if (nonempty) field(owner).field.setBytes(raw);
      f.cvars.takeModifiedFlags(); await setCursorToItem(f.state, owner.menu, item(owner, 3)); f.events.length = 0;
      await press(f, KeyCode.Enter);
      expect([...read(keys)]).toEqual(nonempty ? [...raw] : [...before]);
      expect(f.cvars.modifiedFlags & CvarFlag.Archive).toBe(nonempty ? CvarFlag.Archive : 0);
      expect(f.state.activeMenu).toBeNull(); expect(f.state.menuDepth).toBe(0);
      expect(f.events).toContain("sound:sound/misc/menu3.wav:6");
    } finally { f.close(); }
  }
});

test("actual character input lowercases letters and source field Enter selects Accept before committing", async () => {
  const f = await baseFixture(); try {
    await cacheMenu(f.state);
    const keys = new CommonCdKeyState(f.cvars, "client"), owner = new BaseCdKeyMenu(f.state, keys, () => 1);
    await owner.show();
    for (let index = 0; index < 16; index++) await f.keys.charEvent(65);
    expect(field(owner).field.text).toBe("a".repeat(16)); expect(field(owner).field.cursor).toBe(15);
    await press(f, KeyCode.Enter); expect(owner.menu.cursor).toBe(3);
    expect([...read(keys)]).toEqual([...new Uint8Array(16).fill(32), 0]);
    await press(f, KeyCode.Enter);
    expect([...read(keys)]).toEqual([...new Uint8Array(16).fill(97), 0]); expect(f.state.menuDepth).toBe(0);
  } finally { f.close(); }
});

test("Accept samples current fs_game and preserves raw invalid preload tail after source byte-zero clearing", async () => {
  const f = await baseFixture(); try {
    const keys = new CommonCdKeyState(f.cvars, "client"), owner = new BaseCdKeyMenu(f.state, keys, () => 1);
    const original = Uint8Array.from({ length: 16 }, (_, index) => index + 180);
    keys.writeUiForCompiledModule(() => 1, () => original); await owner.show();
    expect([...field(owner).field.copyBytes(16)]).toEqual([0, ...original.subarray(1)]);
    await f.keys.charEvent(65);
    expect(field(owner).field.text).toBe("a");
    f.cvars.set("fs_game", "missionpack", true);
    await event(owner);
    expect([...read(keys)]).toEqual([97, 0, ...original.subarray(2), 0]);
    f.cvars.set("fs_game", "", true); expect([...read(keys)]).toEqual([...original, 0]);
  } finally { f.close(); }
});

test("non-activated events do nothing, and actual mouse Back and Escape use the real parent", async () => {
  const f = await baseFixture(); try {
    await cacheMenu(f.state); const parent = new BaseConfirmMenu(f.state); await parent.show("PARENT", null, async () => undefined);
    const keys = new CommonCdKeyState(f.cvars, "client"), owner = new BaseCdKeyMenu(f.state, keys, () => 1);
    await owner.show(); field(owner).field.setText("invalid"); const before = read(keys);
    for (const kind of [MenuEvent.GotFocus, MenuEvent.LostFocus]) await event(owner, 3, kind);
    expect(f.state.activeMenu).toBe(owner.menu); expect([...read(keys)]).toEqual([...before]);
    await mouseEvent(f.state, 10 - f.state.cursorX, 430 - f.state.cursorY); expect(owner.menu.cursor).toBe(4);
    await press(f, KeyCode.Mouse1); expect(f.state.activeMenu).toBe(parent.menu);
    await owner.show(); await press(f, KeyCode.Escape); expect(f.state.activeMenu).toBe(parent.menu);
    expect([...read(keys)]).toEqual([...before]);
  } finally { f.close(); }
});

test("source key get failure retains configured items before push and later retry resets the same field", async () => {
  const f = await baseFixture(); try {
    const keys = new CommonCdKeyState(f.cvars, "client"), failure = new Error("source get callback failure");
    let fail = true;
    const owner = new BaseCdKeyMenu(f.state, keys, () => { if (fail) throw failure; return 1; });
    await expect(owner.show()).rejects.toBe(failure);
    expect(f.cvars.get("fs_game")?.flags).toBe(CvarFlag.Init | CvarFlag.SystemInfo);
    expect(owner.menu.itemCount).toBe(4); expect(f.state.menuDepth).toBe(0); expect(f.state.activeMenu).toBeNull();
    const entry = field(owner).field;
    expect(entry.text).toBe(""); expect([...entry.copyBytes(17)]).toEqual([...new Uint8Array(17)]);
    fail = false; await owner.show(); expect(field(owner).field).toBe(entry);
  } finally { f.close(); }
});

test("source write failure prevents pop while a later pop failure retains the completed key bytes", async () => {
  const f = await baseFixture(); try {
    const keys = new CommonCdKeyState(f.cvars, "client"), failure = new Error("source write callback failure");
    let fail = false;
    const owner = new BaseCdKeyMenu(f.state, keys, () => { if (fail) throw failure; return 1; });
    await owner.show(); field(owner).field.setText("invalid");
    fail = true;
    await expect(event(owner)).rejects.toBe(failure); expect(f.state.activeMenu).toBe(owner.menu); expect(f.state.menuDepth).toBe(1);
    expect(read(keys)).toEqual(new Uint8Array([...new Uint8Array(16).fill(32), 0]));
    fail = false;
    f.keys.clearStates = async () => { throw new Error("source clear failure"); };
    await expect(event(owner)).rejects.toThrow("source clear failure");
    expect([...read(keys)]).toEqual([...field(owner).field.copyBytes(16), 0]);
    expect(f.cvars.modifiedFlags & CvarFlag.Archive).toBe(CvarFlag.Archive);
  } finally { f.close(); }
});

test("Accept copies the field after the UI callback and skips the callback for an empty field", async () => {
  const f = await baseFixture(); try {
    const keys = new CommonCdKeyState(f.cvars, "client");
    let callback: () => number = () => 1;
    const owner = new BaseCdKeyMenu(f.state, keys, () => callback());
    await owner.show();
    callback = () => { throw new Error("Empty Accept reached UI_HASUNIQUECDKEY"); };
    await event(owner);
    expect(f.state.menuDepth).toBe(0);
    callback = () => 1; await owner.show();
    field(owner).field.setText("b".repeat(16));
    callback = () => { field(owner).field.setText("c".repeat(16)); f.cvars.set("fs_game", "missionpack", true); return 1; };
    await event(owner);
    expect(read(keys)).toEqual(new Uint8Array([...new Uint8Array(16).fill(99), 0]));
    f.cvars.set("fs_game", "", true);
    expect(read(keys)).toEqual(new Uint8Array([...new Uint8Array(16).fill(32), 0]));
  } finally { f.close(); }
});

test("late cache and escaped execution cannot reset or push the retained source menu", async () => {
  for (const retirement of [false, true]) {
    const f = await baseFixture(); try {
      const keys = new CommonCdKeyState(f.cvars, "client"), owner = new BaseCdKeyMenu(f.state, keys, () => 1);
      await owner.show(); const items = [...owner.menu.items], entry = field(owner).field; entry.setText("old");
      const gate = deferred(), entered = deferred(), register = f.resources.registerShaderNoMip.bind(f.resources);
      f.resources.registerShaderNoMip = async name => { entered.resolve(); await gate.promise; return await register(name); };
      let pending: Promise<void> = Promise.resolve();
      if (retirement) { pending = owner.show(); await entered.promise; f.state.retire(); }
      else { f.consoleCommands.register("escape_key", () => { pending = owner.show(); }); await f.consoleCommands.executeNowAsync("escape_key"); }
      gate.resolve(); await expect(pending).rejects.toThrow(retirement ? "retired" : "closed");
      expect(owner.menu.items).toEqual(items); expect(entry.text).toBe("old"); expect(f.state.menuDepth).toBe(1);
    } finally { f.close(); }
  }
});

test("CD key ownerdraw produces source field rectangle, cursor glyph and validity colors through actual CPU queue", async () => {
  const f = await baseFixture(640, 480); try {
    await cacheMenu(f.state);
    const keys = new CommonCdKeyState(f.cvars, "client"), owner = new BaseCdKeyMenu(f.state, keys, () => 1);
    await owner.show(); const entry = field(owner), draw = entry.common.ownerdraw;
    if (draw === null) throw new Error("Missing source key ownerdraw");
    const cases: readonly (readonly [string, typeof COLORS.white])[] = [["", COLORS.highlight], ["a".repeat(16), COLORS.white], ["A".repeat(16), COLORS.red]];
    for (const [text, color] of cases) {
      entry.field.setText(text); entry.field.cursor = 3; f.state.realtime = 0;
      const start = f.recorder.trace().flatMap(view => view.batches).flatMap(batch => batch.vertices).length;
      await draw(entry); f.commands.submitFrame();
      const vertices = f.recorder.trace().flatMap(view => view.batches).flatMap(batch => batch.vertices).slice(start);
      expect(vertices.slice(0, 4).map(vertex => [Math.round((vertex.position.x + 1) * 320), Math.round((1 - vertex.position.y) * 240)])).toEqual([[192, 232], [448, 232], [448, 248], [192, 248]]);
      expect(vertices.slice(0, 4).every(vertex => vertex.color.w === 76 / 255)).toBe(true);
      const status = vertices.filter(vertex => (1 - vertex.position.y) * 240 >= 375);
      expect(status.length).toBeGreaterThan(0);
      expect(status.every(vertex => vertex.color.x === color.x && vertex.color.y === color.y && vertex.color.z === color.z)).toBe(true);
    }
    entry.field.setText("a".repeat(16));
    const readCursor = async (overstrike: boolean, time: number, focus: boolean) => {
      f.keys.setOverstrike(overstrike); f.state.realtime = time; owner.menu.cursor = focus ? 2 : 3;
      const start = f.recorder.trace().flatMap(view => view.batches).flatMap(batch => batch.vertices).length;
      await draw(entry); f.commands.submitFrame();
      return f.recorder.trace().flatMap(view => view.batches).flatMap(batch => batch.vertices).slice(start)
        .filter(vertex => (1 - vertex.position.y) * 240 < 375 && vertex.color.x === 1 && vertex.color.y === 1 && vertex.color.z === 1);
    };
    const insert = await readCursor(false, 0, true), overstrike = await readCursor(true, 0, true);
    expect(insert.length).toBeGreaterThan(0); expect(overstrike.length).toBe(insert.length);
    expect(insert.map(vertex => vertex.texCoord)).not.toEqual(overstrike.map(vertex => vertex.texCoord));
    expect(await readCursor(false, 256, true)).toEqual([]);
    expect(await readCursor(false, 0, false)).toEqual([]);
    await refresh(f.state, 0); f.commands.submitFrame();
    expect(f.cpu.pixels.some(byte => byte !== 0)).toBe(true);
  } finally { f.close(); }
});
