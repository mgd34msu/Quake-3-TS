import { expect, test } from "bun:test";
import type { CommandContext } from "../src/core/commands.ts";
import { CvarFlag } from "../src/core/cvar.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { BaseCinematicsMenu } from "../src/ui/base/cinematics-menu.ts";
import { BaseConfirmMenu } from "../src/ui/base/confirm.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { mouseEvent, refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { MenuCommon, MenuEvent, MenuFlag } from "../src/ui/base/state.ts";
import type { BaseMenuItem, MenuProportional } from "../src/ui/base/state.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

type Fixture = Awaited<ReturnType<typeof baseFixture>>;
const art: readonly [string, string, string, string] = ["menu/art/back_0", "menu/art/back_1", "menu/art/frame2_l", "menu/art/frame1_r"];
const unlocked = "\\tier1\\1\\tier2\\1\\tier3\\1\\tier4\\1\\tier5\\1\\tier6\\1\\tier7\\1\\tier8\\1";
function item(owner: BaseCinematicsMenu, index: number): BaseMenuItem {
  const result = owner.menu.items[index]; if (result === undefined) throw new Error(`Missing source cinematic item ${index}`); return result;
}
function movie(owner: BaseCinematicsMenu, index: number): MenuProportional {
  const result = item(owner, index + 3); if (result.kind !== "proportional") throw new Error("Expected source movie title"); return result;
}
async function event(owner: BaseCinematicsMenu, index: number, kind = MenuEvent.Activated): Promise<void> {
  const value = item(owner, index), callback = value.common.callback;
  if (callback === null) throw new Error("Missing source cinematic callback"); await callback(value, kind);
}
async function press(f: Fixture, key: number): Promise<void> {
  await f.keys.keyEvent(key, true, 10); await f.keys.keyEvent(key, false, 11);
}
function command(f: Fixture, owner: BaseCinematicsMenu): void {
  f.consoleCommands.registerAsync("test_cinematics", context => owner.showFromCommand(context));
}
function locked(owner: BaseCinematicsMenu): boolean[] {
  return owner.menu.items.filter(value => value.kind === "proportional").map(value => (value.common.flags & MenuFlag.Grayed) !== 0);
}

test("cinematics literal fourteen source items, bounds, art and initial focus", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseCinematicsMenu(f.state), menu = owner.menu; f.cvars.set("g_spVideos", unlocked, true);
    f.registrations.length = 0; await owner.show(); expect(owner.menu).toBe(menu); expect(menu.itemCount).toBe(14);
    expect(f.registrations).toEqual(art.map(name => `shader:${name}`));
    expect(menu.items.map(value => [value.kind, value.common.id, value.common.x, value.common.y, value.common.flags])).toEqual([
      ["banner", 0, 320, 16, 0x4000], ["bitmap", 0, 0, 78, 0x4000], ["bitmap", 0, 376, 76, 0x4000],
      ["proportional", 11, 320, 100, 0x108], ["proportional", 12, 320, 130, 0x108], ["proportional", 13, 320, 160, 0x108],
      ["proportional", 14, 320, 190, 0x108], ["proportional", 15, 320, 220, 0x108], ["proportional", 16, 320, 250, 0x108],
      ["proportional", 17, 320, 280, 0x108], ["proportional", 18, 320, 310, 0x108], ["proportional", 19, 320, 340, 0x108],
      ["proportional", 20, 320, 370, 0x108], ["bitmap", 10, 0, 416, 0x104],
    ]);
    expect(menu.items.every((value, index) => value.common.parent === menu && value.common.menuPosition === index && value.common.statusbar === null && value.common.ownerdraw === null)).toBe(true);
    expect(menu.items.slice(3, 13).map(value => [value.common.left, value.common.top, value.common.right, value.common.bottom])).toEqual([
      [259, 100, 382, 127], [274, 130, 367, 157], [274, 160, 367, 187], [271, 190, 369, 217], [271, 220, 370, 247],
      [270, 250, 370, 277], [271, 280, 370, 307], [271, 310, 370, 337], [272, 340, 369, 367], [290, 370, 350, 397],
    ]);
    expect(menu.items.flatMap(value => value.kind === "bitmap" ? [[value.common.name, value.width, value.height, value.focuspic, value.shader, value.focusshader, value.errorpic, value.focuscolor]] : [])).toEqual([
      ["menu/art/frame2_l", 256, 329, null, null, null, null, null], ["menu/art/frame1_r", 256, 334, null, null, null, null, null],
      ["menu/art/back_0", 128, 64, "menu/art/back_1", null, null, null, null],
    ]);
    expect(menu.items.filter(value => value.kind === "proportional").map(value => [value.text, value.style, value.color])).toEqual([
      ["ID LOGO", 1, { x: 1, y: 0, z: 0, w: 1 }], ["INTRO", 1, { x: 1, y: 0, z: 0, w: 1 }], ["Tier 1", 1, { x: 1, y: 0, z: 0, w: 1 }],
      ["Tier 2", 1, { x: 1, y: 0, z: 0, w: 1 }], ["Tier 3", 1, { x: 1, y: 0, z: 0, w: 1 }], ["Tier 4", 1, { x: 1, y: 0, z: 0, w: 1 }],
      ["Tier 5", 1, { x: 1, y: 0, z: 0, w: 1 }], ["Tier 6", 1, { x: 1, y: 0, z: 0, w: 1 }], ["Tier 7", 1, { x: 1, y: 0, z: 0, w: 1 }],
      ["END", 1, { x: 1, y: 0, z: 0, w: 1 }],
    ]);
    const banner = item(owner, 0); if (banner.kind !== "banner") throw new Error("Missing source banner");
    expect([banner.text, banner.style, banner.color]).toEqual(["CINEMATICS", 1, { x: 1, y: 1, z: 1, w: 1 }]);
    expect([menu.cursor, menu.cursorPrev, menu.fullscreen, menu.wrapAround, menu.showlogo, menu.draw, menu.key]).toEqual([3, 0, true, false, false, null, null]);
    expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui); expect(f.state.activeMenu).toBe(menu);
  } finally { f.close(); }
});

test("cinematics queries canonical registry eight times after cache, independently of stale VM mirrors", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseCinematicsMenu(f.state), get = f.cvars.get.bind(f.cvars), calls: string[] = [];
    f.cvars.set("g_spVideos", unlocked, true); expect(f.state.services.cvars.get("g_spVideos").value).toBe("");
    f.registrations.length = 0;
    f.cvars.get = name => { if (name === "g_spVideos") { calls.push(name); expect(f.registrations).toEqual(art.map(name => `shader:${name}`)); expect(owner.menu.itemCount).toBe(0); } return get(name); };
    await owner.show(); expect(calls).toEqual(Array.from({ length: 8 }, () => "g_spVideos")); expect(locked(owner)).toEqual(Array.from({ length: 10 }, () => false));
    expect(get("g_spVideos")?.value).toBe(unlocked); expect(f.state.services.cvars.get("g_spVideos").value).toBe("");
    calls.length = 0; f.state.demoVersion = true; f.registrations.length = 0; await owner.show();
    expect(calls).toEqual(["g_spVideos"]); expect(locked(owner)).toEqual([false, true, true, true, true, true, true, true, true, false]);
    f.cvars.get = name => name === "g_spVideos" ? undefined : get(name); await owner.show(); expect(movie(owner, 9).common.flags).toBe(0x2108);
  } finally { f.close(); }
});

test("cinematics source info first-match, signed byte atoi, NUL and 1023-byte copy boundaries", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseCinematicsMenu(f.state), prefix = "\\tier1\\";
    const cases: readonly (readonly [string, boolean])[] = [
      ["", false], ["\\tier1", false], ["\\tier1\\", false], ["\\tier1\\0", false], ["\\tier1\\1", true],
      ["\\TiEr1\\-2tail", true], ["tier1\\0\\tier1\\1", false], ["\\tier1\\1\\TIER1\\0", true],
      ["\\tier1\\ \t+5suffix", true], ["\\tier1\\\x80\xff+1", true], ["\\tier1\\\x7f1", false],
      ["\\tier1\\4294967296", false], ["\\tier1\\4294967297", true], ["\\tier1\\18446744073709551616", false],
      ["\\tier1\\18446744073709551617", true], ["\\tier1\\-4294967295", true], ["\\tier1\\nonsense", false],
      ["\\tier1\\1\0\\tier1\\0", true], ["\\tier1\\0\0\\tier1\\1", false],
      [prefix + " ".repeat(1022 - prefix.length) + "1", true], [prefix + " ".repeat(1023 - prefix.length) + "1", false],
    ];
    for (const [text, enabled] of cases) {
      f.cvars.set("g_spVideos", text, true); const before = f.cvars.get("g_spVideos"); await owner.show();
      expect(movie(owner, 2).common.flags).toBe(enabled ? 0x108 : 0x2108); expect(f.cvars.get("g_spVideos")).toEqual(before);
    }
  } finally { f.close(); }
});

test("cinematics live tier query values and demo changes affect only later source decisions", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseCinematicsMenu(f.state), get = f.cvars.get.bind(f.cvars); let reads = 0;
    f.cvars.get = name => { if (name === "g_spVideos") { reads++; f.cvars.set(name, `\\tier${reads}\\${reads % 2}`, true); } return get(name); };
    await owner.show(); expect(reads).toBe(8); expect(locked(owner)).toEqual([false, false, false, true, false, true, false, true, false, true]);
    reads = 0; f.cvars.set("g_spVideos", unlocked, true);
    f.cvars.get = name => { if (name === "g_spVideos") { reads++; if (reads === 1) f.state.demoVersion = true; } return get(name); };
    await owner.show(); expect(reads).toBe(2); expect(locked(owner)).toEqual([false, false, false, true, true, true, true, true, true, false]);
    reads = 0; f.cvars.get = name => { if (name === "g_spVideos") { reads++; f.state.demoVersion = false; } return get(name); };
    await owner.show(); expect(reads).toBe(1); expect(locked(owner)).toEqual([false, true, true, true, true, true, true, true, true, false]);
  } finally { f.close(); }
});

test("cinematics source query failure exposes reset and partially configured stable records", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseCinematicsMenu(f.state); await owner.show();
    const menu = owner.menu, titles = Array.from({ length: 10 }, (_, index) => movie(owner, index)), back = item(owner, 13), get = f.cvars.get.bind(f.cvars);
    let reads = 0; const failure = new Error("progression read failed");
    f.cvars.get = name => {
      if (name === "g_spVideos") {
        reads++; expect(menu.itemCount).toBe(0); expect(menu.items).toEqual([]);
        const current = titles[reads + 1]; if (current === undefined) throw new Error("Missing retained query item");
        expect(current.common.id).toBe(reads + 12); expect(current.text).toBe(`Tier ${reads}`); expect(current.common.flags).toBe(0x108);
        expect(back.common).toEqual(new MenuCommon()); if (reads === 3) throw failure;
      }
      return get(name);
    };
    await expect(owner.show()).rejects.toBe(failure); expect(reads).toBe(3); expect(f.state.activeMenu).toBe(menu); expect(f.state.menuDepth).toBe(1);
    expect(titles.map(value => value.text)).toEqual(["ID LOGO", "INTRO", "Tier 1", "Tier 2", "Tier 3", null, null, null, null, null]);
    expect(titles.map(value => value.common.flags)).toEqual([0x108, 0x108, 0x2108, 0x2108, 0x108, 0, 0, 0, 0, 0]);
    f.cvars.get = get; await owner.show(); for (let index = 0; index < 10; index++) { const prior = titles[index]; if (prior === undefined) throw new Error("Missing retained title"); expect(movie(owner, index)).toBe(prior); }
  } finally { f.close(); }
});

for (const failAt of [0, 1, 2, 3]) test(`cinematics cache failure ${failAt} preserves old record, then retry resets stable owners`, async () => {
  const f = await baseFixture(); try {
    const owner = new BaseCinematicsMenu(f.state); await owner.show();
    const menu = owner.menu, items = [...menu.items], commons = items.map(value => value.common), register = f.resources.registerShaderNoMip.bind(f.resources), calls: string[] = [];
    movie(owner, 0).text = "retained"; menu.showlogo = true; item(owner, 13).common.id = 99;
    const failure = new Error("cache stopped");
    f.resources.registerShaderNoMip = async name => { if (name === null) throw new Error("Authored menu cache requires a shader name");
      expect(menu.items).toEqual(items); expect(movie(owner, 0).text).toBe("retained"); expect(menu.showlogo).toBe(true);
      calls.push(name); if (name === art[failAt]) throw failure; return await register(name);
    };
    await expect(owner.show()).rejects.toBe(failure); expect(calls).toEqual(art.slice(0, failAt + 1));
    expect(f.state.activeMenu).toBe(menu); expect(menu.itemCount).toBe(14); expect(f.state.menuDepth).toBe(1);
    f.resources.registerShaderNoMip = register; f.registrations.length = 0; await owner.show();
    expect(f.registrations).toEqual(art.map(name => `shader:${name}`)); expect(movie(owner, 0).text).toBe("ID LOGO"); expect(menu.showlogo).toBe(false); expect(item(owner, 13).common.id).toBe(10);
    for (const [index, value] of menu.items.entries()) {
      const prior = items[index], common = commons[index]; if (prior === undefined || common === undefined) throw new Error("Missing retained record");
      expect(value).toBe(prior); expect(value.common).toBe(common);
    }
  } finally { f.close(); }
});

test("cinematics cache barrier preserves old records, standalone cache does not reset, and reopen removes higher stack menus", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseCinematicsMenu(f.state), parent = new BaseConfirmMenu(f.state); await owner.show(); await parent.show("Above movies", null, null);
    const retained = movie(owner, 0), callback = retained.common.callback; retained.text = "old";
    await owner.cache(); expect(retained.text).toBe("old"); expect(f.state.activeMenu).toBe(parent.menu);
    const register = f.resources.registerShaderNoMip.bind(f.resources), gate = deferred(), entered = deferred();
    f.resources.registerShaderNoMip = async name => { const result = await register(name); if (name === art[3]) { entered.resolve(); await gate.promise; } return result; };
    const pending = owner.show(); await entered.promise; expect(retained.text).toBe("old"); expect(f.state.activeMenu).toBe(parent.menu); expect(owner.menu.itemCount).toBe(14);
    gate.resolve(); await pending; expect(retained.text).toBe("ID LOGO"); expect(retained.common.callback).toBe(callback); expect(f.state.activeMenu).toBe(owner.menu); expect(f.state.menuDepth).toBe(1);
  } finally { f.close(); }
});

test("cinematics retirement after cache prevents reset, while retirement after a query prevents dependent locking", async () => {
  for (const phase of ["cache", "query"]) {
    const f = await baseFixture(); try {
      const owner = new BaseCinematicsMenu(f.state); await owner.show(); const retained = movie(owner, 2); retained.text = "old";
      if (phase === "cache") { const register = f.resources.registerShaderNoMip.bind(f.resources); f.resources.registerShaderNoMip = async name => { const result = await register(name); f.state.retire(); return result; }; }
      else { const get = f.cvars.get.bind(f.cvars); f.cvars.get = name => { if (name === "g_spVideos") f.state.retire(); return get(name); }; }
      await expect(owner.show()).rejects.toThrow("retired"); expect(retained.text).toBe(phase === "cache" ? "old" : "Tier 1");
      expect(owner.menu.itemCount).toBe(phase === "cache" ? 14 : 0); if (phase === "query") expect(retained.common.flags).toBe(0x108);
      await expect(owner.cache()).rejects.toThrow("retired"); await expect(owner.show()).rejects.toThrow("retired");
    } finally { f.close(); }
  }
});

test("cinematics all ten source movie commands force nextmap first, preserving metadata and append order", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseCinematicsMenu(f.state); await owner.show();
    f.cvars.register("nextmap", "original", CvarFlag.Archive | CvarFlag.Latch); f.cvars.set("nextmap", "latched");
    const set = f.cvars.set.bind(f.cvars), append = f.consoleCommands.append.bind(f.consoleCommands), calls: string[] = [];
    f.cvars.set = (name, value, force) => { calls.push(`set:${name}:${value}:${String(force)}`); return set(name, value, force); };
    f.consoleCommands.append = text => { calls.push(`append:${text}`); append(text); };
    let expected = "preceding\n"; append(expected);
    const names = ["idlogo", "intro", "tier1", "tier2", "tier3", "tier4", "tier5", "tier6", "tier7", "end"];
    for (const [index, name] of names.entries()) {
      calls.length = 0; await event(owner, index + 3); const text = `disconnect; cinematic ${name}.RoQ\n`; expected += text;
      expect(calls).toEqual([`set:nextmap:ui_cinematics ${index}:true`, `append:${text}`]); expect(f.consoleCommands.pendingText).toBe(expected);
      const variable = f.cvars.get("nextmap"); if (variable === undefined) throw new Error("Missing source nextmap");
      expect([variable.value, variable.resetValue, variable.flags, variable.latchedValue]).toEqual([`ui_cinematics ${index}`, "original", 33, undefined]);
    }
    expect(locked(owner).slice(2).every(Boolean)).toBe(true); expect(f.state.activeMenu).toBe(owner.menu); expect(f.state.menuDepth).toBe(1);
    expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui);
  } finally { f.close(); }
});

test("cinematics callback captures n before set and samples live demo and id after set", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseCinematicsMenu(f.state); await owner.show(); const set = f.cvars.set.bind(f.cvars), title = movie(owner, 0);
    f.cvars.set = (name, text, force) => { const result = set(name, text, force); if (name === "nextmap") { f.state.demoVersion = true; title.common.id = 20; } return result; };
    await event(owner, 3); expect(f.cvars.get("nextmap")?.value).toBe("ui_cinematics 0"); expect(f.consoleCommands.pendingText).toBe("disconnect; cinematic demoEnd.RoQ 1\n");
    f.cvars.set = (name, text, force) => { const result = set(name, text, force); if (name === "nextmap") { f.state.demoVersion = false; title.common.id = 11; } return result; };
    await event(owner, 3); expect(f.cvars.get("nextmap")?.value).toBe("ui_cinematics 9"); expect(f.consoleCommands.pendingText).toBe("disconnect; cinematic demoEnd.RoQ 1\ndisconnect; cinematic end.RoQ\n");
  } finally { f.close(); }
});

test("cinematics non-activated callbacks are inert and Back does not inspect its id", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseCinematicsMenu(f.state), parent = new BaseConfirmMenu(f.state); await parent.show("Parent", null, null); await owner.show();
    for (const kind of [MenuEvent.GotFocus, MenuEvent.LostFocus]) for (let index = 3; index < 14; index++) await event(owner, index, kind);
    expect(f.cvars.get("nextmap")).toBeUndefined(); expect(f.consoleCommands.pendingText).toBe(""); expect(f.state.menuDepth).toBe(2);
    item(owner, 13).common.id = -123; await event(owner, 13); expect(f.state.activeMenu).toBe(parent.menu); expect(f.state.menuDepth).toBe(1);
  } finally { f.close(); }
});

for (const outcome of ["set-throw", "retire", "capacity"]) test(`cinematics ${outcome} preserves reached source cvar, command and move-sound effects`, async () => {
  const f = await baseFixture(); try {
    await cacheMenu(f.state); const owner = new BaseCinematicsMenu(f.state); await owner.show();
    const set = f.cvars.set.bind(f.cvars), failure = new Error("nextmap failed");
    f.cvars.set = (name, text, force) => { if (name === "nextmap" && outcome === "set-throw") throw failure;
      const result = set(name, text, force); if (name === "nextmap" && outcome === "retire") f.state.retire(); return result; };
    if (outcome === "capacity") f.consoleCommands.append("x".repeat(16383)); f.events.length = 0;
    const printedBefore = f.prints.length;
    if (outcome === "set-throw") await expect(press(f, KeyCode.Enter)).rejects.toBe(failure);
    else if (outcome === "retire") await expect(press(f, KeyCode.Enter)).rejects.toThrow("retired");
    else await press(f, KeyCode.Enter);
    expect(f.prints.slice(printedBefore)).toEqual(outcome === "capacity" ? ["Cbuf_AddText: overflow\n"] : []);
    expect(f.cvars.get("nextmap")?.value).toBe(outcome === "set-throw" ? undefined : "ui_cinematics 0");
    expect(f.consoleCommands.pendingText).toBe(outcome === "capacity" ? "x".repeat(16383) : "");
    expect(f.events).toEqual(outcome === "capacity" ? ["sound:sound/misc/menu2.wav:6"] : []);
    expect(f.state.activeMenu).toBe(owner.menu); expect(f.state.menuDepth).toBe(1);
  } finally { f.close(); }
});

test("cinematics invalid movie IDs preserve reached cvar effects and signed32 subtraction", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseCinematicsMenu(f.state); await owner.show(); const title = movie(owner, 0);
    for (const [id, n] of [[10, -1], [21, 10], [-2147483648, 2147483637], [2147483647, 2147483636]] satisfies readonly (readonly [number, number])[]) {
      title.common.id = id; await expect(event(owner, 3)).rejects.toThrow("array index"); expect(f.cvars.get("nextmap")?.value).toBe(`ui_cinematics ${n}`); expect(f.consoleCommands.pendingText).toBe("");
    }
    const prior = f.cvars.get("nextmap"); for (const id of [NaN, Infinity, 2147483648, -2147483649]) {
      title.common.id = id; await expect(event(owner, 3)).rejects.toThrow("integer conversion"); expect(f.cvars.get("nextmap")).toEqual(prior);
    }
    title.common.id = 21; const set = f.cvars.set.bind(f.cvars);
    f.cvars.set = (name, text, force) => { const result = set(name, text, force); title.common.id = 20; f.state.demoVersion = true; return result; };
    await event(owner, 3); expect(f.cvars.get("nextmap")?.value).toBe("ui_cinematics 10"); expect(f.consoleCommands.pendingText).toBe("disconnect; cinematic demoEnd.RoQ 1\n");
  } finally { f.close(); }
});

test("cinematics real command contexts cover decorations, movies, Back and all zeroed source slots", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseCinematicsMenu(f.state); command(f, owner); f.cvars.set("g_spVideos", unlocked, true);
    for (let n = -3; n <= 60; n++) {
      await f.consoleCommands.executeNowAsync(`test_cinematics ${n}`);
      expect(owner.menu.cursor).toBe(n >= 0 && n <= 10 ? n + 3 : 3); expect(owner.menu.cursorPrev).toBe(n >= 0 && n <= 10 ? 3 : 0);
      expect(f.state.activeMenu).toBe(owner.menu); expect(f.state.menuDepth).toBe(1);
    }
    f.cvars.set("g_spVideos", "", true); await f.consoleCommands.executeNowAsync("test_cinematics 2"); expect([owner.menu.cursor, owner.menu.cursorPrev]).toEqual([3, 0]);
    await owner.show(); expect([owner.menu.cursor, owner.menu.cursorPrev]).toEqual([3, 0]);
    await f.consoleCommands.executeNowAsync("test_cinematics"); expect([owner.menu.cursor, owner.menu.cursorPrev]).toEqual([3, 3]);
  } finally { f.close(); }
});

test("cinematics actual command argv uses source atoi and truncates before selection", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseCinematicsMenu(f.state); command(f, owner); f.cvars.set("g_spVideos", unlocked, true);
    const cases: readonly (readonly [string, number])[] = [["", 3], [" ", 3], ["+2suffix", 5], ["-3tail", 3], ["nonsense", 3], ["\x80\xff\t+3tail", 6],
      ["4294967296", 3], ["18446744073709551625", 12], ["9\0ignored", 12], ["0".repeat(1022) + "9", 12], ["0".repeat(1023) + "9", 3], ["9".repeat(1023), 3]];
    for (const [argument, cursor] of cases) {
      await f.consoleCommands.executeNowAsync(`test_cinematics "${argument}"`); expect(owner.menu.cursor).toBe(cursor);
    }
    expect(f.consoleCommands.pendingText).toBe(""); expect(f.cvars.get("nextmap")).toBeUndefined();
  } finally { f.close(); }
});

test("cinematics invalid selection rejects only after source cache, reset and push", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseCinematicsMenu(f.state); command(f, owner);
    for (const argument of ["-4", "61", "2147483647", "-2147483648", "2147483645"]) {
      f.registrations.length = 0; await expect(f.consoleCommands.executeNowAsync(`test_cinematics ${argument}`)).rejects.toThrow("pointer slot");
      expect(f.registrations).toEqual(art.map(name => `shader:${name}`)); expect(owner.menu.itemCount).toBe(14);
      expect([owner.menu.cursor, owner.menu.cursorPrev]).toEqual([3, 0]); expect(f.state.activeMenu).toBe(owner.menu);
    }
  } finally { f.close(); }
});

test("cinematics captures real command argument before cache and rejects reused contexts before effects", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseCinematicsMenu(f.state); command(f, owner); f.cvars.set("g_spVideos", unlocked, true);
    const register = f.resources.registerShaderNoMip.bind(f.resources), gate = deferred(), entered = deferred(); let nested = false;
    f.consoleCommands.register("inner", context => { expect(context.argv).toEqual(["inner", "9"]); });
    f.resources.registerShaderNoMip = async name => { if (!nested) { nested = true; await f.consoleCommands.executeNowAsync("inner 9"); entered.resolve(); await gate.promise; } return await register(name); };
    const pending = f.consoleCommands.executeNowAsync("test_cinematics 2"); await entered.promise; expect(owner.menu.itemCount).toBe(0); gate.resolve(); await pending;
    expect(owner.menu.cursor).toBe(5);
    const retained: { context: CommandContext | null } = { context: null };
    f.consoleCommands.register("remember", context => { retained.context = context; expect(Object.isFrozen(context.argv)).toBe(true); });
    f.consoleCommands.executeNow("remember 9"); if (retained.context === null) throw new Error("Missing actual retained context");
    f.registrations.length = 0; await expect(owner.showFromCommand(retained.context)).rejects.toThrow("closed command execution context");
    expect(f.registrations).toEqual([]); expect(owner.menu.cursor).toBe(5);
  } finally { f.close(); }
});

test("cinematics escaped actual context cannot complete delayed cache or publish a movie", async () => {
  const f = await baseFixture(); try {
    const owner = new BaseCinematicsMenu(f.state); await owner.show(); const originalTitle = movie(owner, 0); originalTitle.text = "retained";
    const register = f.resources.registerShaderNoMip.bind(f.resources), gate = deferred(), entered = deferred();
    f.resources.registerShaderNoMip = async name => { const shader = await register(name); entered.resolve(); await gate.promise; return shader; };
    const holder: { pending: Promise<void> | null } = { pending: null };
    f.consoleCommands.register("escape", context => { holder.pending = owner.showFromCommand(context); });
    f.consoleCommands.executeNow("escape 9"); await entered.promise; gate.resolve(); if (holder.pending === null) throw new Error("Missing escaped show");
    await expect(holder.pending).rejects.toThrow("closed command execution context"); expect(originalTitle.text).toBe("retained"); expect(owner.menu.itemCount).toBe(14);
    const late = deferred(); f.consoleCommands.register("escape_event", () => { holder.pending = late.promise.then(() => event(owner, 3)); });
    f.consoleCommands.executeNow("escape_event"); late.resolve(); if (holder.pending === null) throw new Error("Missing escaped movie");
    await expect(holder.pending).rejects.toThrow("closed command execution context"); expect(f.cvars.get("nextmap")).toBeUndefined(); expect(f.consoleCommands.pendingText).toBe("");
  } finally { f.close(); }
});

test("cinematics actual key and mouse navigation skips gray titles and stops at endpoints", async () => {
  const f = await baseFixture(); try {
    await cacheMenu(f.state); const owner = new BaseCinematicsMenu(f.state), parent = new BaseConfirmMenu(f.state);
    await parent.show("Parent", null, null); f.state.demoVersion = true; f.cvars.set("g_spVideos", "\\tier8\\1", true); await owner.show();
    await press(f, KeyCode.Up); expect(owner.menu.cursor).toBe(3); await press(f, KeyCode.Down); expect(owner.menu.cursor).toBe(12);
    await press(f, KeyCode.KeypadDown); expect(owner.menu.cursor).toBe(13); await press(f, KeyCode.Tab); expect(owner.menu.cursor).toBe(13);
    await press(f, KeyCode.KeypadUp); expect(owner.menu.cursor).toBe(12); await press(f, KeyCode.KeypadEnter);
    expect(f.consoleCommands.pendingText).toBe("disconnect; cinematic demoEnd.RoQ 1\n"); expect(f.state.activeMenu).toBe(owner.menu);
    await mouseEvent(f.state, 320, 130); expect(owner.menu.cursor).toBe(12);
    await mouseEvent(f.state, 0, -30); expect(owner.menu.cursor).toBe(3); await press(f, KeyCode.Mouse1);
    expect(f.consoleCommands.pendingText).toBe("disconnect; cinematic demoEnd.RoQ 1\ndisconnect; cinematic idlogo.RoQ\n");
    await mouseEvent(f.state, -270, 350); expect(owner.menu.cursor).toBe(13); await press(f, KeyCode.Mouse1); expect(f.state.activeMenu).toBe(parent.menu);
    await owner.show(); await press(f, KeyCode.Escape); expect(f.state.activeMenu).toBe(parent.menu);
  } finally { f.close(); }
});

test("cinematics real retail CPU queue has source title geometry, gray colors, focus and bitmap order", async () => {
  const f = await baseFixture(320, 240); try {
    await cacheMenu(f.state); const owner = new BaseCinematicsMenu(f.state); await owner.show(); await refresh(f.state, 75); f.commands.submit();
    const batches = f.recorder.trace().flatMap(view => view.batches);
    const bitmaps = batches.filter(batch => batch.texture.kind === "bind-image" && ["frame2_l", "frame1_r", "back_0"].some(name => batch.texture.kind === "bind-image" && batch.texture.image.name.includes(name)));
    expect(bitmaps.map(batch => batch.texture.kind === "bind-image" ? batch.texture.image.name.replace(/\.[^.]+$/, "") : "")).toEqual([art[2], art[3], art[0]]);
    const expected: readonly (readonly [number, number, number, number])[] = [[0, 78, 256, 407], [376, 76, 632, 410], [0, 416, 128, 480]];
    for (const [index, batch] of bitmaps.entries()) {
      const bounds = expected[index]; if (bounds === undefined) throw new Error("Missing bitmap bounds");
      const vertices = [...new Set(batch.indices)].map(index => { const vertex = batch.vertices[index]; if (vertex === undefined) throw new Error("Missing actual queued corner"); return vertex; });
      const xs = vertices.map(vertex => (vertex.position.x + 1) * 320), ys = vertices.map(vertex => (1 - vertex.position.y) * 240);
      expect(Math.min(...xs)).toBeCloseTo(bounds[0], 3); expect(Math.min(...ys)).toBeCloseTo(bounds[1], 3);
      expect(Math.max(...xs)).toBeCloseTo(bounds[2], 3); expect(Math.max(...ys)).toBeCloseTo(bounds[3], 3);
    }
    const vertices = batches.filter(batch => batch.texture.kind === "bind-image" && batch.texture.image.name.includes("font1_prop") && !batch.texture.image.name.includes("glo")).flatMap(batch => batch.vertices);
    const at = (x: number, y: number) => vertices.filter(vertex => Math.abs((vertex.position.x + 1) * 320 - x) < .01 && Math.abs((1 - vertex.position.y) * 240 - y) < .01);
    expect(at(262, 100).some(vertex => vertex.color.x === 1 && vertex.color.y === 0)).toBe(true);
    expect(at(277, 160).some(vertex => Math.abs(vertex.color.x - .35) < .01 && Math.abs(vertex.color.y - .35) < .01)).toBe(true);
    const before = f.cpu.pixels.slice(); await setCursorToItem(f.state, owner.menu, item(owner, 4)); await refresh(f.state, 75); f.commands.submit();
    let changed = 0; for (let index = 0; index < before.length; index++) if (before[index] !== f.cpu.pixels[index]) changed++;
    expect(changed).toBeGreaterThan(0); expect(f.state.firstDraw).toBe(false); expect(f.events).toContain("sound:sound/misc/menu1.wav:6");
    expect(f.consoleCommands.pendingText).toBe(""); expect(f.cvars.get("nextmap")).toBeUndefined();
  } finally { f.close(); }
});
