import { expect, test } from "bun:test";
import { KEY_CHAR_FLAG, KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { UI_CENTER, UI_SMALLFONT } from "../src/render/font.ts";
import type { DrawBatch, RenderVertex } from "../src/render/types.ts";
import type { Rect2D } from "../src/render/draw2d.ts";
import { BaseCreditsMenu } from "../src/ui/base/credits.ts";
import { cacheMenu, drawProportional, drawString } from "../src/ui/base/draw.ts";
import { isFullscreen, pushMenu, refresh } from "../src/ui/base/framework.ts";
import { BaseMenu, COLORS, MenuCommon, NO_SOUND } from "../src/ui/base/state.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

// Literal source rows, independent of the menu's increment algorithm.
const rows: readonly (readonly [number, string])[] = [
  [12, "id Software is:"], [40, "Programming"], [60, "John Carmack, Robert A. Duffy, Jim Dose'"],
  [88, "Art"], [108, "Adrian Carmack, Kevin Cloud,"], [128, "Kenneth Scott, Seneca Menard, Fred Nilsson"],
  [156, "Game Designer"], [176, "Graeme Devine"], [204, "Level Design"],
  [224, "Tim Willits, Christian Antkow, Paul Jaquays"], [252, "CEO"], [272, "Todd Hollenshead"],
  [300, "Director of Business Development"], [320, "Marty Stratton"], [348, "Biz Assist and id Mom"],
  [368, "Donna Jackson"], [396, "Development Assistance"], [416, "Eric Webb"],
];
const footers: readonly (readonly [number, string])[] = [
  [443, "To order: 1-800-idgames     www.quake3arena.com     www.idsoftware.com"],
  [459, "Quake III Arena(c) 1999-2000, Id Software, Inc.  All Rights Reserved"],
];
function callbacks(menu: BaseMenu) {
  const draw = menu.draw, key = menu.key;
  if (draw === null || key === null) throw new Error("Missing source credits callbacks");
  return { draw, key };
}
function vertices(batch: DrawBatch): readonly RenderVertex[] {
  return [...new Set(batch.indices)].sort((a, b) => a - b).map(index => {
    const vertex = batch.vertices[index];
    if (vertex === undefined) throw new Error("Missing actual credits vertex");
    return vertex;
  });
}
function geometry(f: Awaited<ReturnType<typeof baseFixture>>) {
  return f.recorder.trace().flatMap(view => view.batches).map(batch => {
    if (batch.texture.kind !== "bind-image") throw new Error("Credits fixture expects actual registered font images");
    return { name: batch.texture.image.name, texturing: batch.texturing, state: batch.state, vertices: vertices(batch), indices: batch.indices };
  });
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing expected credits fixture value");
  return value;
}

test("credits source show has no registration, no items, stable callbacks and in-place complete menu reset", async () => {
  const f = await baseFixture();
  try {
    const credits = new BaseCreditsMenu(f.state), menu = credits.menu, items = menu.items;
    const parent = new BaseMenu(); await pushMenu(f.state, parent);
    f.registrations.length = 0; const reads = f.assets.reads.length;
    await credits.show(); const original = callbacks(menu);
    expect(f.state.stack).toEqual([parent, menu]); expect(f.state.activeMenu).toBe(menu);
    expect(f.state.menuDepth).toBe(2); expect(isFullscreen(f.state)).toBe(true);
    expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui); expect(f.state.firstDraw).toBe(true); expect(f.state.enterSound).toBe(true);
    expect([menu.cursor, menu.cursorPrev, menu.itemCount, menu.wrapAround, menu.fullscreen, menu.showlogo]).toEqual([0, 0, 0, false, true, false]);
    menu.cursor = 77; menu.cursorPrev = 66; menu.itemCount = 1; menu.wrapAround = true; menu.showlogo = true; menu.fullscreen = false;
    menu.items.push({ kind: "action", common: new MenuCommon() }); menu.draw = null; menu.key = null;
    await credits.show();
    expect(credits.menu).toBe(menu); expect(menu.items).toBe(items); expect(menu.items).toEqual([]);
    expect(callbacks(menu).draw).toBe(original.draw); expect(callbacks(menu).key).toBe(original.key);
    expect([menu.cursor, menu.cursorPrev, menu.itemCount, menu.wrapAround, menu.fullscreen, menu.showlogo]).toEqual([0, 0, 0, false, true, false]);
    expect(f.state.stack).toEqual([parent, menu]); expect(f.state.menuDepth).toBe(2);
    expect(f.registrations).toEqual([]); expect(f.assets.reads.length).toBe(reads); expect(f.events).toEqual([]);
    expect(f.consoleCommands.pendingText).toBe("");
  } finally { f.close(); }
});

test("credits actual ClientKeys characters/keyups do nothing; repeats and Escape append without pop or execution", async () => {
  const f = await baseFixture();
  try {
    const credits = new BaseCreditsMenu(f.state), executed: string[] = [];
    for (const name of ["before", "quit", "after"]) f.consoleCommands.register(name, () => { executed.push(name); });
    await credits.show(); f.consoleCommands.append("before\n");
    for (let character = 0; character < 256; character++) await f.keys.charEvent(character);
    expect(f.consoleCommands.pendingText).toBe("before\n");
    for (const key of [KeyCode.Up, KeyCode.Up, KeyCode.Mouse1, KeyCode.Escape]) await f.keys.keyEvent(key, true, 10);
    for (const key of [KeyCode.Up, KeyCode.Mouse1, KeyCode.Escape]) await f.keys.keyEvent(key, false, 11);
    expect(f.consoleCommands.pendingText).toBe("before\nquit\nquit\nquit\nquit\n");
    expect(executed).toEqual([]); expect(f.state.activeMenu).toBe(credits.menu); expect(f.state.menuDepth).toBe(1);
    expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui); expect(f.events).toEqual([]);
    f.consoleCommands.append("after\n"); expect(await f.consoleCommands.executeAsync()).toBe(6);
    expect(executed).toEqual(["before", "quit", "quit", "quit", "quit", "after"]);
    expect(f.state.activeMenu).toBe(credits.menu);
  } finally { f.close(); }
});

test("credits UI instances own separate stable menus and borrowed command queues", async () => {
  const first = await baseFixture(), second = await baseFixture();
  try {
    const a = new BaseCreditsMenu(first.state), b = new BaseCreditsMenu(second.state);
    await a.show(); await b.show();
    expect(a.menu).not.toBe(b.menu); expect(callbacks(a.menu).key).not.toBe(callbacks(b.menu).key);
    await first.keys.keyEvent(KeyCode.Enter, true, 1);
    expect(first.consoleCommands.pendingText).toBe("quit\n"); expect(second.consoleCommands.pendingText).toBe("");
    expect(first.state.activeMenu).toBe(a.menu); expect(second.state.activeMenu).toBe(b.menu);
  } finally { second.close(); first.close(); }
});

test("credits source key callback covers all low bytes and ignores every character-flagged byte", async () => {
  const f = await baseFixture();
  try {
    const credits = new BaseCreditsMenu(f.state); await credits.show(); const { key } = callbacks(credits.menu);
    for (let value = 0; value < 256; value++) expect(await key(KEY_CHAR_FLAG | value)).toBe(NO_SOUND);
    expect(f.consoleCommands.pendingText).toBe("");
    for (let value = 0; value < 256; value++) expect(await key(value)).toBe(NO_SOUND);
    expect(f.consoleCommands.pendingText).toBe("quit\n".repeat(256));
  } finally { f.close(); }
});

test("credits real command overflow preserves the open menu and preceding queue", async () => {
  const f = await baseFixture();
  try {
    const credits = new BaseCreditsMenu(f.state); await credits.show(); const preceding = "x".repeat(16380);
    f.consoleCommands.append(preceding);
    const printedBefore = f.prints.length;
    await f.keys.keyEvent(KeyCode.Escape, true, 20);
    expect(f.prints.slice(printedBefore)).toEqual(["Cbuf_AddText: overflow\n"]);
    expect(f.consoleCommands.pendingText).toBe(preceding); expect(f.state.activeMenu).toBe(credits.menu);
    expect(f.state.menuDepth).toBe(1); expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui); expect(f.events).toEqual([]);
  } finally { f.close(); }
});

test("credits source push overflow resets its own record but preserves the prior stack", async () => {
  const f = await baseFixture();
  try {
    const credits = new BaseCreditsMenu(f.state), stack: BaseMenu[] = [];
    for (let index = 0; index < 8; index++) { const menu = new BaseMenu(); stack.push(menu); await pushMenu(f.state, menu); }
    credits.menu.cursor = 5; credits.menu.wrapAround = true;
    await expect(credits.show()).rejects.toThrow("menu stack overflow");
    expect(f.state.stack).toEqual(stack); expect(f.state.activeMenu).toBe(required(stack[7])); expect(f.state.menuDepth).toBe(8);
    expect(credits.menu.cursor).toBe(0); expect(credits.menu.wrapAround).toBe(false); expect(credits.menu.fullscreen).toBe(true);
    expect(credits.menu.itemCount).toBe(0); expect(callbacks(credits.menu).draw).toBeFunction(); expect(f.consoleCommands.pendingText).toBe("");
  } finally { f.close(); }
});

test("credits push callback failure preserves source partial publication; returned retirement is rejected", async () => {
  for (const retire of [false, true]) {
    const f = await baseFixture();
    try {
      const credits = new BaseCreditsMenu(f.state), failure = new Error("source catcher boundary"), set = f.keys.setCatcher.bind(f.keys);
      f.keys.setCatcher = value => { set(value); if (retire) f.state.retire(); else throw failure; };
      if (retire) await expect(credits.show()).rejects.toThrow("retired");
      else await expect(credits.show()).rejects.toBe(failure);
      expect(f.state.activeMenu).toBe(credits.menu); expect(f.state.menuDepth).toBe(1);
      expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui); expect(f.state.enterSound).toBe(true);
      expect(f.state.firstDraw).toBe(retire); expect(f.consoleCommands.pendingText).toBe("");
    } finally { f.close(); }
  }
});

test("credits append errors retain identity and retired return retains already appended source text", async () => {
  for (const retire of [false, true]) {
    const f = await baseFixture();
    try {
      const credits = new BaseCreditsMenu(f.state); await credits.show();
      const failure = new Error("source command boundary"), append = f.consoleCommands.append.bind(f.consoleCommands);
      f.consoleCommands.append = text => { if (!retire) throw failure; append(text); f.state.retire(); };
      const result = callbacks(credits.menu).key(KeyCode.Enter);
      if (retire) await expect(result).rejects.toThrow("retired"); else await expect(result).rejects.toBe(failure);
      expect(f.consoleCommands.pendingText).toBe(retire ? "quit\n" : ""); expect(f.state.activeMenu).toBe(credits.menu);
      expect(f.state.menuDepth).toBe(1);
    } finally { f.close(); }
  }
});

test("credits retired and escaped command callbacks cannot draw, push, or append", async () => {
  for (const mode of ["retired", "escaped"] satisfies readonly ("retired" | "escaped")[]) {
    const f = await baseFixture();
    try {
      const credits = new BaseCreditsMenu(f.state); await credits.show(); const original = callbacks(credits.menu);
      const actions: readonly (() => Promise<unknown>)[] = [() => credits.show(), original.draw, () => original.key(KeyCode.Escape)];
      if (mode === "retired") {
        f.state.retire(); for (const action of actions) await expect(action()).rejects.toThrow("retired");
      } else {
        const gate = deferred(), pending: Promise<unknown>[] = [];
        f.consoleCommands.register("escape-credits", () => { for (const action of actions) pending.push(gate.promise.then(action)); });
        f.consoleCommands.executeNow("escape-credits");
        const checked = Promise.allSettled(pending);
        gate.resolve();
        for (const outcome of await checked) {
          expect(outcome.status).toBe("rejected");
          if (outcome.status !== "rejected") throw new Error("Escaped credits callback unexpectedly returned");
          const error: unknown = outcome.reason;
          expect(error).toBeInstanceOf(Error);
          if (!(error instanceof Error)) throw new Error("Expected command guard error");
          expect(error.message).toContain("closed");
        }
      }
      expect(f.consoleCommands.pendingText).toBe(""); expect(f.state.activeMenu).toBe(credits.menu); expect(f.state.menuDepth).toBe(1);
      expect(f.commands.submit().commands).toBe(0); expect(f.recorder.trace()).toEqual([]);
    } finally { f.close(); }
  }
});

test("credits show rejects an escaped post-push continuation without undoing source publication", async () => {
  const f = await baseFixture();
  try {
    const credits = new BaseCreditsMenu(f.state), pending: { value: Promise<void> | null } = { value: null };
    f.consoleCommands.register("escape-credits-show", () => { pending.value = credits.show(); });
    f.consoleCommands.executeNow("escape-credits-show");
    if (pending.value === null) throw new Error("Missing source show continuation");
    await expect(pending.value).rejects.toThrow("closed");
    expect(f.state.activeMenu).toBe(credits.menu); expect(f.state.menuDepth).toBe(1);
    expect(f.state.firstDraw).toBe(true); expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui);
    expect(f.consoleCommands.pendingText).toBe("");
  } finally { f.close(); }
});

test("credits exact source rows reach the real CPU queue with matching geometry, UVs, color and pixels", async () => {
  const f = await baseFixture(640, 480), reference = await baseFixture(640, 480);
  try {
    await cacheMenu(f.state); await cacheMenu(reference.state);
    const credits = new BaseCreditsMenu(f.state); await credits.show();
    await callbacks(credits.menu).draw();
    for (const [y, text] of rows) drawProportional(reference.state, 320, y, text, UI_CENTER | UI_SMALLFONT, COLORS.white);
    for (const [y, text] of footers) drawString(reference.state, 320, y, text, UI_CENTER | UI_SMALLFONT, COLORS.red);
    f.commands.submit(); reference.commands.submit();
    const actual = geometry(f); expect(actual).toEqual(geometry(reference)); expect(f.cpu.pixels).toEqual(reference.cpu.pixels);
    const all = actual.flatMap(batch => batch.vertices), expectedY = [
      ...rows.flatMap(([y, text]) => Array.from({ length: text.replaceAll(" ", "").length }, () => y)),
      ...footers.flatMap(([y, text]) => Array.from({ length: text.replaceAll(" ", "").length }, () => y)),
    ];
    expect(all.length).toBe(expectedY.length * 4);
    for (const [index, y] of expectedY.entries()) {
      const top = required(all[index * 4]), bottom = required(all[index * 4 + 2]);
      expect(Math.round((1 - top.position.y) * 240)).toBe(y);
      expect((top.position.y - bottom.position.y) * 240).toBeCloseTo(y < 443 ? 20.25 : 16, 3);
      expect(top.color).toEqual(y < 443 ? { x: 1, y: 1, z: 1, w: 1 } : { x: 1, y: 0, z: 0, w: 1 });
    }
    let white = 0, red = 0;
    for (let offset = 0; offset < f.cpu.pixels.length; offset += 4) {
      const r = required(f.cpu.pixels[offset]), g = required(f.cpu.pixels[offset + 1]), b = required(f.cpu.pixels[offset + 2]);
      if (r > 0 && r === g && g === b) white++;
      if (r > 0 && g === 0 && b === 0) red++;
    }
    expect(white).toBeGreaterThan(1000); expect(red).toBeGreaterThan(100);
    expect(f.commands.submit().commands).toBe(0);
  } finally { reference.close(); f.close(); }
});

test("credits actual framework refresh draws the no-logo background and cursor without item navigation", async () => {
  const f = await baseFixture(320, 240);
  try {
    await cacheMenu(f.state); const credits = new BaseCreditsMenu(f.state); await credits.show();
    const rectangles: Rect2D[] = [], names: string[] = [], draw = f.state.draw.drawHandlePic.bind(f.state.draw);
    f.state.draw.drawHandlePic = (rect, picture) => { rectangles.push(rect); names.push(picture.name); draw(rect, picture); };
    f.state.cursorX = 100; f.state.cursorY = 200; f.registrations.length = 0;
    await refresh(f.state, 75); f.commands.submit();
    expect(rectangles).toEqual([{ x: 0, y: 0, width: 640, height: 480 }, { x: 84, y: 184, width: 32, height: 32 }]);
    expect(names).toEqual([f.resources.picture(f.state.media.backgroundNoLogo).name, f.resources.picture(f.state.media.cursor).name]);
    expect(f.state.firstDraw).toBe(false); expect(f.state.enterSound).toBe(false);
    expect([f.state.cursorX, f.state.cursorY, credits.menu.cursor, credits.menu.itemCount]).toEqual([100, 200, 0, 0]);
    expect(f.events).toEqual(["sound:sound/misc/menu1.wav:6"]); expect(f.registrations).toEqual([]);
    expect(f.recorder.trace().flatMap(view => view.batches).length).toBeGreaterThan(2);
  } finally { f.close(); }
});
