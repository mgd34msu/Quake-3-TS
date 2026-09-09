import { expect, test } from "bun:test";
import { CvarFlag } from "../src/core/cvar.ts";
import { KeyCode } from "../src/core/key-codes.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { RendererConfiguration } from "../src/render/configuration.ts";
import { SourceRendererSettings } from "../src/render/settings.ts";
import { BaseDisplayOptionsMenu } from "../src/ui/base/display-options.ts";
import { BaseGraphicsOptionsMenu } from "../src/ui/base/graphics-options.ts";
import { BaseNetworkOptionsMenu } from "../src/ui/base/network-options.ts";
import { BaseSoundOptionsMenu } from "../src/ui/base/sound-options.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { MenuEvent, MenuFlag, itemAt } from "../src/ui/base/state.ts";
import type { BaseMenuItem, MenuSlider } from "../src/ui/base/state.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

async function fixture() {
  const f = await baseFixture(320, 240);
  try {
    const window = SdlWindow.open({ title: "UI retained configuration", width: 320, height: 240, backend: "cpu", hidden: true });
    const settings = f.resources.settings;
    if (!(settings instanceof SourceRendererSettings)) throw new Error("Fixture must retain actual renderer settings");
    let config: RendererConfiguration;
    try { config = RendererConfiguration.create({ window, renderer: { kind: "cpu", backend: f.cpu }, settings }); }
    catch (error) { window.close(); throw error; }
    const snapshot = config.copy(); config.close(); window.close();
    // Retain one actual detached copy. This fixture is not the absent complete UI_Init.
    const graphics: BaseGraphicsOptionsMenu = new BaseGraphicsOptionsMenu(f.state, snapshot, { display: () => display.show(), sound: () => sound.show(), network: () => network.show() });
    const display: BaseDisplayOptionsMenu = new BaseDisplayOptionsMenu(f.state, snapshot, { graphics: () => graphics.show(), sound: () => sound.show(), network: () => network.show() });
    const sound: BaseSoundOptionsMenu = new BaseSoundOptionsMenu(f.state, { graphics: () => graphics.show(), display: () => display.show(), network: () => network.show() });
    const network: BaseNetworkOptionsMenu = new BaseNetworkOptionsMenu(f.state, { graphics: () => graphics.show(), display: () => display.show(), sound: () => sound.show() });
    return { ...f, display, graphics, sound, network, snapshot };
  } catch (error) { f.close(); throw error; }
}
function item(menu: BaseDisplayOptionsMenu, id: number): BaseMenuItem {
  const value = menu.menu.items.find(value => value.common.id === id); if (value === undefined) throw new Error(`Missing display item ${id}`); return value;
}
function slider(menu: BaseDisplayOptionsMenu, id: number): MenuSlider {
  const value = item(menu, id); if (value.kind !== "slider") throw new Error("Expected display slider"); return value;
}
async function event(menu: BaseDisplayOptionsMenu, id: number, event = MenuEvent.Activated): Promise<void> {
  const value = item(menu, id), callback = value.common.callback; if (callback === null) throw new Error("Missing display callback"); await callback(value, event);
}

test("display retains actual detached configuration and creates ten source items after its four cache calls", async () => {
  const f = await fixture(); try {
    f.registrations.length = 0; await f.display.show(); const menu = f.display.menu;
    expect(f.registrations).toEqual(["menu/art/frame2_l", "menu/art/frame1_r", "menu/art/back_0", "menu/art/back_1"].map(name => `shader:${name}`));
    expect(menu.items.map(value => [value.kind, value.common.id, value.common.x, value.common.y, value.common.flags])).toEqual([
      ["banner", 0, 320, 16, 0x4008], ["bitmap", 0, 0, 78, 0x4000], ["bitmap", 0, 376, 76, 0x4000],
      ["proportional", 10, 216, 186, 0x110], ["proportional", 11, 216, 213, 0x10], ["proportional", 12, 216, 240, 0x110],
      ["proportional", 13, 216, 267, 0x110], ["slider", 14, 400, 222, 0x2102], ["slider", 15, 400, 240, 0x102], ["bitmap", 16, 0, 416, 0x104],
    ]);
    expect([menu.cursor, menu.cursorPrev, menu.itemCount, menu.wrapAround, menu.fullscreen]).toEqual([4, 3, 10, true, true]);
    expect(menu.items.every((value, index) => value.common.parent === menu && value.common.menuPosition === index)).toBe(true);
    expect([slider(f.display, 14).curvalue, slider(f.display, 14).minvalue, slider(f.display, 14).maxvalue]).toEqual([10, 5, 20]);
    expect([slider(f.display, 15).curvalue, slider(f.display, 15).minvalue, slider(f.display, 15).maxvalue]).toEqual([0, 3, 10]);
    expect(f.snapshot.deviceSupportsGamma).toBe(false); expect(f.cvars.get("cg_viewsize")).toBeUndefined();
  } finally { f.close(); }
});

test("display real keyboard cannot focus unavailable gamma and writes fractional screen size immediately", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); f.cvars.set("cg_viewsize", "75", true); await f.display.show();
    await setCursorToItem(f.state, f.display.menu, item(f.display, 13));
    await f.keys.keyEvent(KeyCode.Down, true, 1); await f.keys.keyEvent(KeyCode.Down, false, 2);
    expect(f.display.menu.cursor).toBe(8);
    await f.keys.keyEvent(KeyCode.Right, true, 3); await f.keys.keyEvent(KeyCode.Right, false, 4);
    expect(slider(f.display, 15).curvalue).toBe(8.5); expect(f.cvars.get("cg_viewsize")?.value).toBe("85");
    expect(f.cvars.get("r_gamma")?.value).toBe("1"); expect(f.consoleCommands.pendingText).toBe("");
  } finally { f.close(); }
});

test("display slider callbacks preserve source float32 and forced fixed-six Cvar_SetValue", async () => {
  const f = await fixture(); try {
    f.cvars.register("cg_viewsize", "75", CvarFlag.ReadOnly | CvarFlag.Archive);
    await f.display.show();
    // Callback arithmetic is tested directly; this does not claim an available gamma device.
    slider(f.display, 14).curvalue = Math.fround(10.25); await event(f.display, 14);
    expect(f.cvars.get("r_gamma")?.value).toBe("1.025000");
    slider(f.display, 15).curvalue = Math.fround(7.8125); await event(f.display, 15);
    expect(f.cvars.get("cg_viewsize")).toMatchObject({ value: "78.125000", flags: CvarFlag.ReadOnly | CvarFlag.Archive, resetValue: "75" });
    for (const [value, expected] of [[.078125, "0.007812"], [.234375, "0.023438"]] satisfies readonly (readonly [number, string])[]) {
      slider(f.display, 14).curvalue = value; await event(f.display, 14); expect(f.cvars.get("r_gamma")?.value).toBe(expected);
    }
    const before = f.cvars.get("r_gamma"); await event(f.display, 14, MenuEvent.GotFocus); expect(f.cvars.get("r_gamma")).toEqual(before);
  } finally { f.close(); }
});

test("display samples live cvars only after cache and preserves stable records across reopen", async () => {
  const f = await fixture(); try {
    await f.display.show(); const menu = f.display.menu, items = [...menu.items], commons = items.map(value => value.common), array = menu.items;
    const register = f.resources.registerShaderNoMip.bind(f.resources), gate = deferred(), entered = deferred();
    f.resources.registerShaderNoMip = async name => { const shader = await register(name); entered.resolve(); await gate.promise; return shader; };
    const pending = f.display.show(); await entered.promise;
    expect(menu.itemCount).toBe(0); expect(items.every(value => value.common.parent === null)).toBe(true);
    f.cvars.set("r_gamma", ".1234567", true); f.cvars.set("cg_viewsize", "-125", true); gate.resolve(); await pending;
    expect(slider(f.display, 14).curvalue).toBe(Math.fround(Math.fround(.1234567) * 10)); expect(slider(f.display, 15).curvalue).toBe(-12.5);
    expect(menu.items).toBe(array); for (const [i, value] of menu.items.entries()) { expect(value).toBe(itemAt(items, i)); expect(value.common).toBe(itemAt(commons, i)); }
    expect(slider(f.display, 14).common.flags & MenuFlag.Grayed).not.toBe(0);
    const prior = menu.cursor; await f.display.cache(); expect(menu.cursor).toBe(prior);
  } finally { f.close(); }
});

test("display tabs replace their own stack entry with actual graphics, sound and network owners", async () => {
  const f = await fixture(); try {
    await f.display.show(); await event(f.display, 11); expect(f.state.activeMenu).toBe(f.display.menu);
    for (const [id, target] of [[10, f.graphics], [12, f.sound], [13, f.network]] satisfies readonly (readonly [number, { readonly menu: typeof f.display.menu }])[]) {
      await f.display.show(); const depth = f.state.menuDepth;
      await event(f.display, id); expect(f.state.activeMenu).toBe(target.menu); expect(f.state.menuDepth).toBe(depth);
    }
    await f.display.show(); await event(f.display, 16); expect(f.state.activeMenu).toBe(f.network.menu);
  } finally { f.close(); }
});

test("display cache failure retains completed registrations; retirement stops late publication", async () => {
  for (const retire of [false, true]) {
    const f = await fixture(); try {
      const register = f.resources.registerShaderNoMip.bind(f.resources), failure = new Error("display cache failed");
      f.resources.registerShaderNoMip = async name => { const result = await register(name); if (name !== null && name.endsWith("back_0")) { if (retire) f.state.retire(); else throw failure; } return result; };
      await expect(f.display.show()).rejects.toThrow(retire ? "retired" : "display cache failed");
      expect(f.display.menu.itemCount).toBe(0); expect(f.state.activeMenu).toBeNull();
      if (!retire) { f.resources.registerShaderNoMip = register; await f.display.show(); expect(f.display.menu.itemCount).toBe(10); }
    } finally { f.close(); }
  }
});

test("display draws actual retail CPU sliders and changing screen-size pixels", async () => {
  const f = await fixture(); try {
    await cacheMenu(f.state); f.cvars.set("cg_viewsize", "30", true); await f.display.show(); await refresh(f.state, 75); f.commands.submit();
    const before = f.cpu.pixels.slice(); slider(f.display, 15).curvalue = 10; await refresh(f.state, 75); f.commands.submit();
    let changed = 0; for (let y = 120; y < 128; y++) for (let x = 204; x < 253; x++) for (let c = 0; c < 3; c++) {
      const i = (y * 320 + x) * 4 + c; if (before[i] !== f.cpu.pixels[i]) changed++;
    }
    expect(changed).toBeGreaterThan(0); expect(f.events).toContain("sound:sound/misc/menu1.wav:6");
  } finally { f.close(); }
});
