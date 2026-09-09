import { expect, test } from "bun:test";
import { CvarFlag } from "../src/core/cvar.ts";
import { KeyCode } from "../src/core/key-codes.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { RendererConfiguration } from "../src/render/configuration.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { SourceRendererSettings } from "../src/render/settings.ts";
import { BaseDisplayOptionsMenu } from "../src/ui/base/display-options.ts";
import { BaseGraphicsOptionsMenu } from "../src/ui/base/graphics-options.ts";
import { BaseNetworkOptionsMenu } from "../src/ui/base/network-options.ts";
import { BaseSoundOptionsMenu } from "../src/ui/base/sound-options.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { MenuEvent, MenuFlag, itemAt } from "../src/ui/base/state.ts";
import type { BaseMenuItem, MenuSlider, MenuSpin } from "../src/ui/base/state.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

async function fixture(kind: "cpu" | "gl" = "cpu") {
  const f = await baseFixture(320, 240);
  try {
    const window = SdlWindow.open({ title: "Actual graphics configuration", width: 320, height: 240, backend: kind, hidden: true });
    const gl = kind === "gl" ? new GlRenderer(window, new RendererImageCatalog()) : null;
    const settings = gl === null ? f.resources.settings : new SourceRendererSettings(f.registered, gl.capabilities);
    if (!(settings instanceof SourceRendererSettings)) throw new Error("Actual renderer settings required");
    let config: RendererConfiguration;
    try { config = RendererConfiguration.create({ window, renderer: gl === null ? { kind: "cpu", backend: f.cpu } : { kind: "gl", backend: gl }, settings }); }
    catch (error) { gl?.close(); window.close(); throw error; }
    const snapshot = config.copy(); config.close(); gl?.close(); window.close();
    // One actual producer copy remains usable after producer teardown; no UI_Init claim.
    const graphics: BaseGraphicsOptionsMenu = new BaseGraphicsOptionsMenu(f.state, snapshot, { display: () => display.show(), sound: () => sound.show(), network: () => network.show() });
    const display: BaseDisplayOptionsMenu = new BaseDisplayOptionsMenu(f.state, snapshot, { graphics: () => graphics.show(), sound: () => sound.show(), network: () => network.show() });
    const sound: BaseSoundOptionsMenu = new BaseSoundOptionsMenu(f.state, { graphics: () => graphics.show(), display: () => display.show(), network: () => network.show() });
    const network: BaseNetworkOptionsMenu = new BaseNetworkOptionsMenu(f.state, { graphics: () => graphics.show(), display: () => display.show(), sound: () => sound.show() });
    return { ...f, graphics, display, sound, network, snapshot };
  } catch (error) { f.close(); throw error; }
}
function item(menu: BaseGraphicsOptionsMenu, key: string | number): BaseMenuItem {
  const value = menu.menu.items.find(value => typeof key === "number" ? value.common.id === key : value.common.name === key);
  if (value === undefined) throw new Error(`Missing graphics item ${key}`); return value;
}
function spin(menu: BaseGraphicsOptionsMenu, name: string): MenuSpin {
  const value = item(menu, name); if (value.kind !== "spin") throw new Error("Expected graphics spin"); return value;
}
function tq(menu: BaseGraphicsOptionsMenu): MenuSlider {
  const value = item(menu, "Texture Detail:"); if (value.kind !== "slider") throw new Error("Expected graphics slider"); return value;
}
async function event(menu: BaseGraphicsOptionsMenu, key: string | number, event = MenuEvent.Activated): Promise<void> {
  const value = item(menu, key), callback = value.common.callback; if (callback === null) throw new Error("Missing graphics callback"); await callback(value, event);
}
async function draw(menu: BaseGraphicsOptionsMenu): Promise<void> {
  const callback = menu.menu.draw; if (callback === null) throw new Error("Missing graphics draw"); await callback();
}
function normal(f: Awaited<ReturnType<typeof fixture>>): void {
  for (const [name, value] of [["r_mode", "3"], ["r_fullscreen", "1"], ["r_allowExtensions", "1"], ["r_picmip", "1"], ["r_vertexLight", "0"],
    ["r_colorbits", "0"], ["r_texturebits", "0"], ["r_lodBias", "1"], ["r_subdivisions", "12"], ["r_textureMode", "GL_LINEAR_MIPMAP_NEAREST"]]) {
    if (name === undefined || value === undefined) throw new Error("Malformed initial video option"); f.cvars.set(name, value, true);
  }
}

test("graphics creates exact source layout and an honest nonselectable CPU renderer row", async () => {
  const f = await fixture(); try {
    normal(f); f.registrations.length = 0; await f.graphics.show(); const menu = f.graphics.menu;
    expect(f.registrations).toEqual(["frame2_l", "frame1_r", "back_0", "back_1", "accept_0", "accept_1"].map(name => `shader:menu/art/${name}`));
    expect(menu.items.map(value => [value.kind, value.common.id, value.common.x, value.common.y])).toEqual([
      ["banner", 0, 320, 16], ["bitmap", 0, 0, 78], ["bitmap", 0, 376, 76], ["proportional", 106, 216, 186],
      ["proportional", 107, 216, 213], ["proportional", 108, 216, 240], ["proportional", 109, 216, 267],
      ["spin", 103, 400, 132], ["spin", 0, 400, 168], ["spin", 0, 400, 186], ["spin", 104, 400, 204],
      ["spin", 0, 400, 222], ["spin", 0, 400, 240], ["spin", 0, 400, 258], ["spin", 0, 400, 276],
      ["slider", 0, 400, 294], ["spin", 0, 400, 312], ["spin", 0, 400, 330], ["proportional", 105, 320, 362],
      ["bitmap", 101, 0, 416], ["bitmap", 0, 640, 416],
    ]);
    expect([menu.cursor, menu.cursorPrev, menu.itemCount, menu.wrapAround, menu.fullscreen]).toEqual([3, 3, 21, true, true]);
    expect(menu.items.every((value, index) => value.common.parent === menu && value.common.menuPosition === index)).toBe(true);
    expect(spin(f.graphics, "Renderer:").itemnames).toEqual(["CPU"]);
    expect(spin(f.graphics, "Renderer:").common.flags & MenuFlag.Grayed).not.toBe(0);
    expect(f.snapshot).toMatchObject({ backend: "cpu", driverType: "cpu", maxTextureSize: null, depthStorage: "binary64" });
    expect(spin(f.graphics, "Graphics Settings:").curvalue).toBe(0); await draw(f.graphics);
    expect(spin(f.graphics, "Graphics Settings:").curvalue).toBe(1);
    expect(item(f.graphics, "menu/art/accept_0").common.flags & (MenuFlag.Hidden | MenuFlag.Inactive)).toBe(0x5000);
  } finally { f.close(); }
});

test("graphics presets preserve source template values without changing driver or extension choice", async () => {
  const f = await fixture(); try {
    normal(f); await f.graphics.show();
    const expected = [[4, 2, 0, 2, 2, 1, 1], [3, 2, 0, 0, 0, 1, 0], [2, 1, 0, 1, 0, 0, 0], [2, 1, 1, 1, 0, 0, 0], [3, 1, 0, 0, 0, 1, 0]];
    spin(f.graphics, "GL Extensions:").curvalue = 0;
    for (let index = 0; index < expected.length; index++) {
      spin(f.graphics, "Graphics Settings:").curvalue = index; await event(f.graphics, 103);
      expect([spin(f.graphics, "Video Mode:").curvalue, tq(f.graphics).curvalue, spin(f.graphics, "Lighting:").curvalue,
        spin(f.graphics, "Color Depth:").curvalue, spin(f.graphics, "Texture Quality:").curvalue, spin(f.graphics, "Geometric Detail:").curvalue,
        spin(f.graphics, "Texture Filter:").curvalue]).toEqual(itemAt(expected, index));
      expect(spin(f.graphics, "GL Extensions:").curvalue).toBe(0); expect(spin(f.graphics, "Renderer:").curvalue).toBe(0);
      expect(spin(f.graphics, "Fullscreen:").curvalue).toBe(1);
    }
    spin(f.graphics, "Graphics Settings:").curvalue = 1; await event(f.graphics, 103); await draw(f.graphics);
    expect(spin(f.graphics, "Texture Quality:").curvalue).toBe(1); expect(spin(f.graphics, "Graphics Settings:").curvalue).toBe(1);
    expect(item(f.graphics, "menu/art/accept_0").common.flags & MenuFlag.Hidden).toBe(0);
    expect(f.consoleCommands.pendingText).toBe("");
  } finally { f.close(); }
});

test("graphics deferred draw detects all applicable changes and grays windowed color depth", async () => {
  const f = await fixture(); try {
    normal(f);
    for (const name of ["Video Mode:", "Fullscreen:", "GL Extensions:", "Lighting:", "Color Depth:", "Texture Quality:", "Geometric Detail:", "Texture Filter:", "Texture Detail:"]) {
      await f.graphics.show(); const value = item(f.graphics, name); if (value.kind !== "spin" && value.kind !== "slider") throw new Error("Expected editable video value");
      value.curvalue = value.curvalue === 0 ? 1 : 0;
      expect(item(f.graphics, "menu/art/accept_0").common.flags & MenuFlag.Hidden).not.toBe(0); await draw(f.graphics);
      expect(item(f.graphics, "menu/art/accept_0").common.flags & MenuFlag.Hidden).toBe(0);
    }
    spin(f.graphics, "Fullscreen:").curvalue = 0; spin(f.graphics, "Color Depth:").curvalue = 2; await draw(f.graphics);
    expect(spin(f.graphics, "Color Depth:").curvalue).toBe(0); expect(spin(f.graphics, "Color Depth:").common.flags & MenuFlag.Grayed).not.toBe(0);
    spin(f.graphics, "Fullscreen:").curvalue = 1; await draw(f.graphics); expect(spin(f.graphics, "Color Depth:").common.flags & MenuFlag.Grayed).toBe(0);
  } finally { f.close(); }
});

for (const bits of [0, 1, 2]) test(`graphics Apply color/texture choice ${bits} preserves exact CPU cvar order and only appends restart`, async () => {
  const f = await fixture(); try {
    normal(f); f.cvars.register("r_stencilbits", "7", CvarFlag.ReadOnly); f.cvars.set("r_stencilbits", "7", true); f.cvars.set("r_glDriver", "dormant-driver", true);
    await f.graphics.show(); spin(f.graphics, "Texture Quality:").curvalue = bits; spin(f.graphics, "Color Depth:").curvalue = bits;
    spin(f.graphics, "Geometric Detail:").curvalue = bits; spin(f.graphics, "Texture Filter:").curvalue = bits === 0 ? 0 : 1;
    const calls: string[] = [], set = f.cvars.set.bind(f.cvars), append = f.consoleCommands.append.bind(f.consoleCommands); let executions = 0;
    f.consoleCommands.register("vid_restart", () => { executions++; }); f.consoleCommands.append("echo preceding\n");
    f.cvars.set = (name, value, force) => { calls.push(`${name}=${value}:${String(force)}`); return set(name, value, force); };
    f.consoleCommands.append = text => { calls.push(`append:${text}`); append(text); };
    await event(f.graphics, "menu/art/accept_0");
    expect(calls).toEqual([
      `r_texturebits=${bits === 0 ? 0 : bits === 1 ? 16 : 32}:true`, "r_picmip=1:true", "r_allowExtensions=1:true", "r_mode=3:true", "r_fullscreen=1:true",
      `r_colorbits=${bits === 0 ? 0 : bits === 1 ? 16 : 32}:true`, `r_depthbits=${bits === 0 ? 0 : bits === 1 ? 16 : 24}:true`,
      ...(bits === 2 ? [] : ["r_stencilbits=0:true"]), "r_vertexLight=0:true", `r_lodBias=${bits === 2 ? 0 : 1}:true`,
      `r_subdivisions=${bits === 2 ? 4 : bits === 1 ? 12 : 20}:true`, `r_textureMode=${bits === 0 ? "GL_LINEAR_MIPMAP_NEAREST" : "GL_LINEAR_MIPMAP_LINEAR"}:true`, "append:vid_restart\n",
    ]);
    expect(f.cvars.get("r_glDriver")?.value).toBe("dormant-driver"); expect(f.cvars.get("r_stencilbits")?.value).toBe(bits === 2 ? "7" : "0");
    expect(f.consoleCommands.pendingText).toBe("echo preceding\nvid_restart\n"); expect(executions).toBe(0); expect(f.state.activeMenu).toBe(f.graphics.menu);
  } finally { f.close(); }
});

test("graphics reads cvars after cache, source negative custom mode fallback and fractional initial texture truncation", async () => {
  const f = await fixture(); try {
    const register = f.resources.registerShaderNoMip.bind(f.resources), gate = deferred(), entered = deferred();
    f.resources.registerShaderNoMip = async name => { const shader = await register(name); entered.resolve(); await gate.promise; return shader; };
    const pending = f.graphics.show(); await entered.promise; normal(f);
    f.cvars.set("r_mode", "-1", true); f.cvars.set("r_picmip", "1.75", true); f.cvars.set("r_textureMode", "gl_linear_mipmap_nearest", true);
    gate.resolve(); await pending;
    expect(spin(f.graphics, "Video Mode:").curvalue).toBe(3); expect(tq(f.graphics).curvalue).toBe(1.25);
    await draw(f.graphics); expect(item(f.graphics, "menu/art/accept_0").common.flags & MenuFlag.Hidden).toBe(0);
    expect(spin(f.graphics, "Texture Filter:").curvalue).toBe(0);
    for (const [value, expected] of [[1.49, 1], [1.5, 2], [2.5, 3]] satisfies readonly (readonly [number, number])[]) {
      tq(f.graphics).curvalue = Math.fround(value); await event(f.graphics, "Texture Detail:"); expect(tq(f.graphics).curvalue).toBe(expected);
    }
  } finally { f.close(); }
});

test("graphics real key navigation skips CPU driver and Apply edits the command buffer", async () => {
  const f = await fixture(); try {
    normal(f); await cacheMenu(f.state); await f.graphics.show();
    await setCursorToItem(f.state, f.graphics.menu, item(f.graphics, 103));
    await f.keys.keyEvent(KeyCode.Down, true, 1); await f.keys.keyEvent(KeyCode.Down, false, 2);
    expect(f.graphics.menu.cursor).toBe(9);
    await f.keys.keyEvent(KeyCode.Left, true, 3); await f.keys.keyEvent(KeyCode.Left, false, 4); await refresh(f.state, 10);
    expect(spin(f.graphics, "GL Extensions:").curvalue).toBe(0);
    await setCursorToItem(f.state, f.graphics.menu, item(f.graphics, "menu/art/accept_0"));
    await f.keys.keyEvent(KeyCode.Enter, true, 11); await f.keys.keyEvent(KeyCode.Enter, false, 12);
    expect(f.consoleCommands.pendingText).toBe("vid_restart\n"); expect(f.cvars.get("r_allowExtensions")?.value).toBe("0");
  } finally { f.close(); }
});

test("graphics Driver Info retains private fixed items, draws real CPU facts and returns to its parent", async () => {
  const f = await fixture(); try {
    normal(f); await cacheMenu(f.state); await f.graphics.show(); await refresh(f.state, 50); f.commands.submit(); const before = f.cpu.pixels.slice();
    f.registrations.length = 0; await event(f.graphics, 105); const driver = f.state.activeMenu;
    if (driver === null) throw new Error("Missing actual Driver Info menu");
    expect(driver.items.map(value => [value.kind, value.common.id])).toEqual([["banner", 0], ["bitmap", 0], ["bitmap", 0], ["bitmap", 100]]);
    expect([driver.cursor, driver.itemCount, driver.wrapAround, driver.fullscreen, f.state.menuDepth]).toEqual([3, 4, false, true, 2]);
    expect(f.registrations).toEqual(["frame2_l", "frame1_r", "back_0", "back_1"].map(name => `shader:menu/art/${name}`));
    await refresh(f.state, 50); f.commands.submit(); expect(f.cpu.pixels).not.toEqual(before);
    await f.keys.keyEvent(KeyCode.Escape, true, 51); await f.keys.keyEvent(KeyCode.Escape, false, 52); expect(f.state.activeMenu).toBe(f.graphics.menu);
    const items = [...driver.items]; await event(f.graphics, 105); expect(f.state.activeMenu).toBe(driver);
    for (const [i, value] of driver.items.entries()) expect(value).toBe(itemAt(items, i));
  } finally { f.close(); }
});

test("Driver Info preserves the source fortieth extension tail and last-character marker", async () => {
  const f = await fixture(); try {
    const tail = "TAIL MORE_EXTENSIONS_0123456789 EXTRA";
    const graphics = new BaseGraphicsOptionsMenu(f.state, { ...f.snapshot, extensionsString: `${"A ".repeat(39)}${tail}` }, {
      display: async () => {}, sound: async () => {}, network: async () => {},
    });
    await cacheMenu(f.state); await graphics.show();
    expect(item(graphics, 105).common.y).toBe(362);
    await event(graphics, 105);
    const driver = f.state.activeMenu; if (driver?.draw === null || driver === null) throw new Error("Missing actual Driver Info draw");
    const glyphs: string[] = [], stretch = f.state.draw.stretchPixels.bind(f.state.draw);
    f.state.draw.stretchPixels = (rect, uv, picture) => {
      if (rect.y === 256 && rect.x >= 162 && rect.width === 4 && rect.height === 8)
        glyphs.push(String.fromCharCode(Math.round(uv.t * 16) * 16 + Math.round(uv.s * 16)));
      stretch(rect, uv, picture);
    };
    await driver.draw();
    expect(glyphs.join("")).toBe(`${tail.slice(0, -1)}>`.replaceAll(" ", ""));
  } finally { f.close(); }
});

test("graphics tabs use actual sibling owners and ignored focus notifications do not write", async () => {
  const f = await fixture(); try {
    await f.graphics.show(); await event(f.graphics, 106); expect(f.state.activeMenu).toBe(f.graphics.menu);
    const before = f.cvars.get("r_mode"); await event(f.graphics, "menu/art/accept_0", MenuEvent.LostFocus); expect(f.cvars.get("r_mode")).toEqual(before);
    for (const [id, target] of [[107, f.display], [108, f.sound], [109, f.network]] satisfies readonly (readonly [number, { readonly menu: typeof f.graphics.menu }])[]) {
      await f.graphics.show(); const depth = f.state.menuDepth; await event(f.graphics, id); expect(f.state.activeMenu).toBe(target.menu); expect(f.state.menuDepth).toBe(depth);
    }
  } finally { f.close(); }
});

test("graphics stable reset, retained partial cache and retirement respect actual menu lifetime", async () => {
  const f = await fixture(); try {
    await f.graphics.show(); const menu = f.graphics.menu, items = [...menu.items], array = menu.items;
    const register = f.resources.registerShaderNoMip.bind(f.resources), failure = new Error("graphics cache failed");
    f.resources.registerShaderNoMip = async name => { if (name !== null && name.endsWith("back_0")) throw failure; return await register(name); };
    await expect(f.graphics.show()).rejects.toBe(failure); expect(menu.itemCount).toBe(0); expect(items.every(value => value.common.parent === null)).toBe(true);
    f.resources.registerShaderNoMip = register; await f.graphics.show(); expect(menu.items).toBe(array);
    for (const [i, value] of menu.items.entries()) expect(value).toBe(itemAt(items, i));
    f.resources.registerShaderNoMip = async name => { const result = await register(name); f.state.retire(); return result; };
    await expect(f.graphics.show()).rejects.toThrow("retired"); expect(menu.itemCount).toBe(0);
  } finally { f.close(); }
});

test("graphics command overflow preserves completed source writes and does not pop the menu", async () => {
  const f = await fixture(); try {
    normal(f); await f.graphics.show(); tq(f.graphics).curvalue = 0; f.consoleCommands.append("x".repeat(16380));
    await event(f.graphics, "menu/art/accept_0");
    expect(f.cvars.get("r_picmip")?.value).toBe("3"); expect(f.state.activeMenu).toBe(f.graphics.menu); expect(f.consoleCommands.pendingText).toHaveLength(16380);
  } finally { f.close(); }
});

test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("graphics actual GL snapshot displays system renderer and preserves source driver write order", async () => {
  const f = await fixture("gl"); try {
    normal(f); await cacheMenu(f.state); await f.graphics.show(); expect(spin(f.graphics, "Renderer:").itemnames).toEqual(["System OpenGL"]);
    const calls: string[] = [], set = f.cvars.set.bind(f.cvars);
    f.cvars.set = (name, value, force) => { calls.push(`${name}=${value}`); return set(name, value, force); };
    await event(f.graphics, "menu/art/accept_0");
    expect(calls.slice(4, 7)).toEqual(["r_fullscreen=1", "r_glDriver=libGL.so.1", "r_colorbits=0"]);
    expect(f.snapshot.backend).toBe("gl"); expect(f.snapshot.rendererString.length).toBeGreaterThan(0); expect(f.snapshot.extensionsString.length).toBeGreaterThan(0);
    await event(f.graphics, 105); await refresh(f.state, 50); f.commands.submit();
    expect(f.state.activeMenu?.itemCount).toBe(4); expect(f.cpu.pixels.some(value => value !== 0)).toBe(true);
  } finally { f.close(); }
});
