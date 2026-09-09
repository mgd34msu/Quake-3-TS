import { describe, expect, test } from "bun:test";
import { CvarFlag } from "../src/core/cvar.ts";
import { KeyCode } from "../src/core/key-codes.ts";
import { UI_CENTER } from "../src/render/font.ts";
import type { DrawBatch } from "../src/render/types.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { BasePreferencesMenu } from "../src/ui/base/preferences.ts";
import { MenuEvent, MenuFlag, itemAt } from "../src/ui/base/state.ts";
import type { BaseMenu, BaseMenuItem, MenuRadio, MenuSpin } from "../src/ui/base/state.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";
import type { RecordedView } from "./render-target-fixture.ts";

const f = Math.fround;

function itemWithId(menu: BaseMenu, id: number): BaseMenuItem {
  for (const item of menu.items)
    if (item.common.id === id)
      return item;
  throw new Error(`Missing preferences item ${id}`);
}

function radioWithId(menu: BaseMenu, id: number): MenuRadio {
  const item = itemWithId(menu, id);
  if (item.kind !== "radio")
    throw new Error(`Preferences item ${id} is not a radio button`);
  return item;
}

function spinWithId(menu: BaseMenu, id: number): MenuSpin {
  const item = itemWithId(menu, id);
  if (item.kind !== "spin")
    throw new Error(`Preferences item ${id} is not a spin control`);
  return item;
}

async function focusAndPress(menu: BaseMenu, state: Parameters<typeof setCursorToItem>[0], keys: { keyEvent(key: number, down: boolean, time: number): Promise<void> }, id: number, key: number, time: number): Promise<void> {
  await setCursorToItem(state, menu, itemWithId(menu, id));
  await keys.keyEvent(key, true, time);
}

function imageBatch(views: readonly RecordedView[], name: string): DrawBatch {
  for (const view of views)
    for (const batch of view.batches)
      if (batch.texture.kind === "bind-image" && batch.texture.image.name === name)
        return batch;
  throw new Error(`Missing recorded image batch ${name}`);
}

function hasImageBatch(views: readonly RecordedView[], name: string): boolean {
  return views.some(view => view.batches.some(batch => batch.texture.kind === "bind-image" && batch.texture.image.name === name));
}

function sourceQuad(targetWidth: number, targetHeight: number, x: number, y: number, width: number, height: number,
  color: { readonly x: number; readonly y: number; readonly z: number; readonly w: number }, textured = true) {
  const scaleX = f(targetHeight * (1 / 480)), scaleY = f(targetHeight / 480);
  const biasX = targetWidth * 480 > targetHeight * 640 ? f(.5 * (targetWidth - targetHeight * (640 / 480))) : 0;
  const left = f(f(f(x) * scaleX) + biasX), top = f(f(y) * scaleY);
  const right = f(left + f(f(width) * scaleX)), bottom = f(top + f(f(height) * scaleY));
  const vertex = (px: number, py: number, s: number, t: number) => ({
    position: { x: f(px * 2 / targetWidth - 1), y: f(1 - py * 2 / targetHeight), z: -1, w: 1 },
    texCoord: { x: f(s), y: f(t) }, color,
  });
  const edge = textured ? 1 : 0;
  return [vertex(left, top, 0, 0), vertex(right, top, edge, 0), vertex(right, bottom, edge, edge), vertex(left, bottom, 0, edge)];
}

describe("base game preferences menu", () => {
  test("cache and menu initialization preserve source order, item kinds, flags, coordinates, and bounds", async () => {
    const fixture = await baseFixture();
    try {
      fixture.registrations.length = 0;
      const preferences = new BasePreferencesMenu(fixture.state);
      await preferences.show();
      expect(fixture.registrations).toEqual([
        "shader:menu/art/frame2_l", "shader:menu/art/frame1_r", "shader:menu/art/back_0", "shader:menu/art/back_1",
        "shader:gfx/2d/crosshaira", "shader:gfx/2d/crosshairb", "shader:gfx/2d/crosshairc", "shader:gfx/2d/crosshaird",
        "shader:gfx/2d/crosshaire", "shader:gfx/2d/crosshairf", "shader:gfx/2d/crosshairg", "shader:gfx/2d/crosshairh",
        "shader:gfx/2d/crosshairi", "shader:gfx/2d/crosshairj",
      ]);
      const menu = preferences.menu;
      expect([menu.itemCount, menu.cursor, menu.wrapAround, menu.fullscreen, menu.showlogo]).toEqual([15, 3, true, true, false]);
      expect(menu.items.map(item => item.kind)).toEqual([
        "banner", "bitmap", "bitmap", "text", "radio", "radio", "radio", "radio", "radio", "radio", "radio", "radio", "spin", "radio", "bitmap",
      ]);
      expect(menu.items.map(item => item.common.id)).toEqual([0, 0, 0, 127, 128, 131, 130, 132, 133, 129, 134, 135, 136, 137, 138]);
      expect(menu.items.map(item => item.common.y)).toEqual([16, 78, 76, 144, 166, 182, 200, 218, 236, 254, 272, 290, 308, 326, 416]);
      expect(menu.items.map(item => item.common.flags)).toEqual([
        MenuFlag.Inactive, MenuFlag.Inactive, MenuFlag.Inactive,
        MenuFlag.PulseIfFocus | MenuFlag.SmallFont | MenuFlag.NoDefaultInit | MenuFlag.OwnerDraw,
        MenuFlag.PulseIfFocus | MenuFlag.SmallFont, MenuFlag.PulseIfFocus | MenuFlag.SmallFont,
        MenuFlag.PulseIfFocus | MenuFlag.SmallFont, MenuFlag.PulseIfFocus | MenuFlag.SmallFont,
        MenuFlag.PulseIfFocus | MenuFlag.SmallFont, MenuFlag.PulseIfFocus | MenuFlag.SmallFont,
        MenuFlag.PulseIfFocus | MenuFlag.SmallFont, MenuFlag.PulseIfFocus | MenuFlag.SmallFont,
        MenuFlag.PulseIfFocus | MenuFlag.SmallFont, MenuFlag.PulseIfFocus | MenuFlag.SmallFont,
        MenuFlag.LeftJustify | MenuFlag.PulseIfFocus,
      ]);
      expect(menu.items.map(item => [item.common.left, item.common.top, item.common.right, item.common.bottom])).toEqual([
        [0, 0, 0, 0], [0, 78, 256, 407], [376, 76, 632, 410], [272, 140, 408, 164],
        [248, 166, 408, 182], [232, 182, 408, 198], [232, 200, 408, 216], [232, 218, 408, 234],
        [224, 236, 408, 252], [216, 254, 408, 270], [216, 272, 408, 288], [192, 290, 408, 306],
        [208, 308, 456, 324], [176, 326, 408, 342], [0, 416, 128, 480],
      ]);
      const banner = itemAt(menu.items, 0);
      if (banner.kind !== "banner") throw new Error("Missing source preferences banner");
      expect([banner.text, banner.style, banner.color]).toEqual(["GAME OPTIONS", UI_CENTER, { x: 1, y: 1, z: 1, w: 1 }]);
      expect(spinWithId(menu, 136).itemnames).toEqual(["off", "upper right", "lower right", "lower left"]);
    } finally {
      fixture.close();
    }
  });

  test("menu values use binary32 registry reads, signed crosshair remainder, and distinct overlay truncation", async () => {
    const fixture = await baseFixture();
    try {
      fixture.cvars.set("cg_drawCrosshair", "-12.75");
      fixture.cvars.set("cg_simpleItems", "-0");
      fixture.cvars.set("cg_brassTime", ".25");
      fixture.cvars.set("cg_marks", "0");
      fixture.cvars.set("cg_drawCrosshairNames", "-2");
      fixture.cvars.set("r_dynamiclight", "0");
      fixture.cvars.set("r_fastsky", "-0");
      fixture.cvars.set("r_finish", ".00000001");
      fixture.cvars.set("cg_forcemodel", "0");
      fixture.cvars.set("cg_drawTeamOverlay", "2.9999999");
      const preferences = new BasePreferencesMenu(fixture.state);
      await preferences.show();
      expect([
        radioWithId(preferences.menu, 128).curvalue,
        radioWithId(preferences.menu, 130).curvalue,
        radioWithId(preferences.menu, 131).curvalue,
        radioWithId(preferences.menu, 133).curvalue,
        radioWithId(preferences.menu, 132).curvalue,
        radioWithId(preferences.menu, 129).curvalue,
        radioWithId(preferences.menu, 134).curvalue,
        radioWithId(preferences.menu, 135).curvalue,
        spinWithId(preferences.menu, 136).curvalue,
        radioWithId(preferences.menu, 137).curvalue,
      ]).toEqual([0, 1, 0, 1, 0, 1, 1, 0, 3, 0]);
      await focusAndPress(preferences.menu, fixture.state, fixture.keys, 127, KeyCode.Enter, 1);
      expect(fixture.cvars.get("cg_drawCrosshair")?.value).toBe("-1");
      fixture.cvars.set("cg_drawTeamOverlay", "99");
      await preferences.show();
      expect(spinWithId(preferences.menu, 136).curvalue).toBe(3);
      fixture.cvars.set("cg_drawTeamOverlay", "-99");
      await preferences.show();
      expect(spinWithId(preferences.menu, 136).curvalue).toBe(0);
    } finally {
      fixture.close();
    }
  });

  test("defined menu events update their exact cvars and back uses the real menu stack", async () => {
    const fixture = await baseFixture();
    try {
      await cacheMenu(fixture.state);
      fixture.cvars.set("cg_drawCrosshair", "9");
      fixture.cvars.set("cg_simpleItems", "0");
      fixture.cvars.set("cg_brassTime", "0");
      fixture.cvars.set("cg_marks", "0");
      fixture.cvars.set("cg_drawCrosshairNames", "0");
      fixture.cvars.set("r_dynamiclight", "0");
      fixture.cvars.set("r_fastsky", "1");
      fixture.cvars.set("r_finish", "0");
      fixture.cvars.set("cg_forcemodel", "0");
      fixture.cvars.set("cg_drawTeamOverlay", "0");
      fixture.cvars.set("cl_allowDownload", "0");
      fixture.cvars.set("sv_allowDownload", "0");
      const preferences = new BasePreferencesMenu(fixture.state);
      await preferences.show();

      const crosshair = itemWithId(preferences.menu, 127), callback = crosshair.common.callback;
      if (callback === null) throw new Error("Missing source preferences callback");
      await callback(crosshair, MenuEvent.GotFocus);
      expect(fixture.cvars.get("cg_drawCrosshair")?.value).toBe("9");

      let time = 1;
      for (const id of [127, 128, 129, 130, 131, 132, 133, 134, 135]) {
        await focusAndPress(preferences.menu, fixture.state, fixture.keys, id, KeyCode.Enter, time);
        if (id === 130)
          expect(fixture.cvars.get("cg_brassTime")?.value).toBe("2500");
        time++;
      }
      await focusAndPress(preferences.menu, fixture.state, fixture.keys, 130, KeyCode.Enter, time++);
      expect(fixture.cvars.get("cg_brassTime")?.value).toBe("0");
      await focusAndPress(preferences.menu, fixture.state, fixture.keys, 136, KeyCode.Right, time++);
      const writes: string[] = [];
      const set = fixture.cvars.set.bind(fixture.cvars);
      fixture.cvars.set = (name, value, force) => {
        writes.push(`${name}:${value}`);
        return force === undefined ? set(name, value) : set(name, value, force);
      };
      await focusAndPress(preferences.menu, fixture.state, fixture.keys, 137, KeyCode.Enter, time++);
      expect(writes).toEqual(["cl_allowDownload:1", "sv_allowDownload:1"]);
      expect([
        fixture.cvars.get("cg_drawCrosshair")?.value, fixture.cvars.get("cg_simpleItems")?.value,
        fixture.cvars.get("r_fastsky")?.value, fixture.cvars.get("cg_brassTime")?.value,
        fixture.cvars.get("cg_marks")?.value, fixture.cvars.get("r_dynamiclight")?.value,
        fixture.cvars.get("cg_drawCrosshairNames")?.value, fixture.cvars.get("r_finish")?.value,
        fixture.cvars.get("cg_forcemodel")?.value, fixture.cvars.get("cg_drawTeamOverlay")?.value,
        fixture.cvars.get("cl_allowDownload")?.value, fixture.cvars.get("sv_allowDownload")?.value,
      ]).toEqual(["0", "1", "0", "0", "1", "1", "1", "1", "1", "1", "1", "1"]);
      await focusAndPress(preferences.menu, fixture.state, fixture.keys, 138, KeyCode.Enter, time);
      expect(fixture.state.activeMenu).toBeNull();
      expect(fixture.state.menuDepth).toBe(0);
    } finally {
      fixture.close();
    }
  });

  test("crosshair owner drawing preserves source geometry, UVs, colors, and focused, grayed, and blink paths", async () => {
    const fixture = await baseFixture();
    try {
      await cacheMenu(fixture.state);
      fixture.cvars.set("cg_drawCrosshair", "1");
      const preferences = new BasePreferencesMenu(fixture.state);
      await preferences.show();
      const crosshair = itemWithId(preferences.menu, 127), ownerdraw = crosshair.common.ownerdraw;
      if (ownerdraw === null) throw new Error("Missing source crosshair owner draw");
      const draw = async (): Promise<readonly RecordedView[]> => {
        const before = fixture.recorder.trace().length;
        await ownerdraw(crosshair);
        fixture.commands.submitFrame();
        return fixture.recorder.trace().slice(before);
      };

      const focused = await draw();
      const image = imageBatch(focused, "gfx/2d/crosshairb.tga");
      expect([image.texturing, image.primitive, image.indices]).toEqual(["single", "triangles", [3, 0, 2, 2, 0, 1]]);
      expect(image.vertices).toEqual(sourceQuad(160, 120, 368, 140, 24, 24, { x: 1, y: 1, z: 1, w: 1 }));
      const listbar = imageBatch(focused, "*white");
      expect(listbar.vertices).toEqual(sourceQuad(160, 120, 272, 140, 137, 25,
        { x: 1, y: 109 / 255, z: 0, w: 76 / 255 }, false));
      const focusedText = imageBatch(focused, "gfx/2d/bigchars.tga");
      expect(focusedText.vertices.slice(0, 4).map(vertex => vertex.color)).toEqual(
        Array.from({ length: 4 }, () => ({ x: 1, y: 1, z: 0, w: 1 })));
      expect(focusedText.vertices.slice(4).map(vertex => vertex.color)).toEqual(
        Array.from({ length: 40 }, () => ({ x: 229 / 255, y: 229 / 255, z: 0, w: 229 / 255 })));

      preferences.menu.cursor = 4;
      const normal = await draw(), normalText = imageBatch(normal, "gfx/2d/bigchars.tga");
      expect(hasImageBatch(normal, "*white")).toBe(false);
      expect(normalText.vertices.map(vertex => vertex.color)).toEqual(
        Array.from({ length: 40 }, () => ({ x: 1, y: 109 / 255, z: 0, w: 1 })));

      crosshair.common.flags |= MenuFlag.Grayed;
      const grayed = await draw(), grayedText = imageBatch(grayed, "gfx/2d/bigchars.tga");
      expect(grayedText.vertices.map(vertex => vertex.color)).toEqual(
        Array.from({ length: 40 }, () => ({ x: 127 / 255, y: 127 / 255, z: 127 / 255, w: 1 })));

      crosshair.common.flags = crosshair.common.flags & ~MenuFlag.Grayed | MenuFlag.Blink;
      fixture.state.realtime = 200;
      const blinkOff = await draw();
      expect(hasImageBatch(blinkOff, "gfx/2d/bigchars.tga")).toBe(false);
      expect(hasImageBatch(blinkOff, "gfx/2d/crosshairb.tga")).toBe(true);

      fixture.cvars.set("cg_drawCrosshair", "1");
      await preferences.show();
      const refreshBefore = fixture.recorder.trace().length;
      await refresh(fixture.state, 400);
      fixture.commands.submitFrame();
      const refreshed = fixture.recorder.trace().slice(refreshBefore);
      const refreshedCrosshair = imageBatch(refreshed, "gfx/2d/crosshairb.tga");
      expect(refreshedCrosshair.vertices).toEqual(sourceQuad(160, 120, 368, 140, 24, 24, { x: 1, y: 1, z: 1, w: 1 }));
      expect(fixture.cpu.pixels.some(value => value !== 0)).toBe(true);

      fixture.cvars.set("cg_drawCrosshair", "0");
      await preferences.show();
      const zero = itemWithId(preferences.menu, 127), zeroDraw = zero.common.ownerdraw;
      if (zeroDraw === null) throw new Error("Missing reset crosshair owner draw");
      const before = fixture.recorder.trace().length;
      await zeroDraw(zero);
      fixture.commands.submitFrame();
      expect(hasImageBatch(fixture.recorder.trace().slice(before), "gfx/2d/crosshairb.tga")).toBe(false);
    } finally {
      fixture.close();
    }
  });

  test("numeric UI writes force absent, read-only, and latched cvars while brass reset remains ordinary", async () => {
    const fixture = await baseFixture();
    try {
      await cacheMenu(fixture.state);
      fixture.cvars.register("cg_simpleItems", "0", CvarFlag.Latch);
      fixture.cvars.set("cg_simpleItems", "9");
      fixture.cvars.register("r_finish", "0", CvarFlag.ReadOnly);
      fixture.cvars.register("cg_brassTime", "2500", CvarFlag.Latch);
      fixture.cvars.set("cg_brassTime", "0", true);
      fixture.cvars.set("cg_brassTime", "17");
      expect(fixture.cvars.get("cg_forcemodel")).toBeUndefined();
      expect([fixture.cvars.get("cg_simpleItems")?.value, fixture.cvars.get("cg_simpleItems")?.latchedValue]).toEqual(["0", "9"]);
      expect([fixture.cvars.get("cg_brassTime")?.value, fixture.cvars.get("cg_brassTime")?.latchedValue]).toEqual(["0", "17"]);
      const preferences = new BasePreferencesMenu(fixture.state);
      await preferences.show();
      await focusAndPress(preferences.menu, fixture.state, fixture.keys, 128, KeyCode.Enter, 1);
      await focusAndPress(preferences.menu, fixture.state, fixture.keys, 134, KeyCode.Enter, 2);
      await focusAndPress(preferences.menu, fixture.state, fixture.keys, 132, KeyCode.Enter, 3);
      await focusAndPress(preferences.menu, fixture.state, fixture.keys, 130, KeyCode.Enter, 4);
      await focusAndPress(preferences.menu, fixture.state, fixture.keys, 135, KeyCode.Enter, 5);
      expect([fixture.cvars.get("cg_simpleItems")?.value, fixture.cvars.get("cg_simpleItems")?.latchedValue,
        fixture.cvars.get("cg_simpleItems")?.flags]).toEqual(["1", undefined, CvarFlag.Latch]);
      expect([fixture.cvars.get("r_finish")?.value, fixture.cvars.get("r_finish")?.flags]).toEqual(["1", CvarFlag.ReadOnly | CvarFlag.Archive]);
      expect([fixture.cvars.get("r_dynamiclight")?.value, fixture.cvars.get("r_dynamiclight")?.flags]).toEqual(["0", CvarFlag.Archive]);
      expect([fixture.cvars.get("cg_forcemodel")?.value, fixture.cvars.get("cg_forcemodel")?.flags]).toEqual(["1", CvarFlag.None]);
      expect([fixture.cvars.get("cg_brassTime")?.value, fixture.cvars.get("cg_brassTime")?.latchedValue,
        fixture.cvars.get("cg_brassTime")?.flags]).toEqual(["0", "2500", CvarFlag.Archive | CvarFlag.Latch]);
    } finally {
      fixture.close();
    }
  });

  test("negative crosshair remainder is rejected only when drawing consumes the shader index", async () => {
    const fixture = await baseFixture();
    try {
      await cacheMenu(fixture.state);
      fixture.cvars.set("cg_drawCrosshair", "-1");
      const preferences = new BasePreferencesMenu(fixture.state);
      await preferences.show();
      expect(fixture.state.activeMenu).toBe(preferences.menu);
      await expect(refresh(fixture.state, 100)).rejects.toThrow("Undefined native base UI array index -1");
    } finally {
      fixture.close();
    }
  });

  test("reopening resets the stable source record and samples fresh cvars", async () => {
    const fixture = await baseFixture();
    try {
      fixture.registrations.length = 0;
      const preferences = new BasePreferencesMenu(fixture.state);
      fixture.cvars.set("cg_simpleItems", "0");
      await preferences.show();
      const menu = preferences.menu, crosshair = itemWithId(menu, 127), simple = radioWithId(menu, 128);
      expect(simple.curvalue).toBe(0);
      await focusAndPress(menu, fixture.state, fixture.keys, 128, KeyCode.Enter, 1);
      expect(simple.curvalue).toBe(1);
      fixture.cvars.set("cg_simpleItems", "0");
      await preferences.show();
      expect(preferences.menu).toBe(menu);
      expect(itemWithId(menu, 127)).toBe(crosshair);
      expect(radioWithId(menu, 128)).toBe(simple);
      expect(simple.curvalue).toBe(0);
      expect([menu.itemCount, menu.cursor, fixture.state.menuDepth]).toEqual([15, 3, 1]);
      expect(fixture.registrations).toHaveLength(28);
    } finally {
      fixture.close();
    }
  });

  test("invalid native cvar conversion rejects after source-order initialization and can be retried", async () => {
    const fixture = await baseFixture();
    try {
      fixture.cvars.set("cg_drawCrosshair", "nan");
      const preferences = new BasePreferencesMenu(fixture.state);
      await expect(preferences.show()).rejects.toThrow("Undefined native base UI integer conversion");
      expect([preferences.menu.itemCount, fixture.state.menuDepth, fixture.state.activeMenu]).toEqual([15, 0, null]);
      fixture.cvars.set("cg_drawCrosshair", "3");
      await preferences.show();
      expect(fixture.state.activeMenu).toBe(preferences.menu);
    } finally {
      fixture.close();
    }
  });

  test("a closed async operation cannot publish or push, while a later owned show can reuse the record", async () => {
    const fixture = await baseFixture();
    try {
      const preferences = new BasePreferencesMenu(fixture.state), entered = deferred(), gate = deferred();
      fixture.assets.beforeRead = async path => {
        if (path.includes("frame2_l")) {
          entered.resolve();
          await gate.promise;
        }
      };
      let escaped: Promise<void> | undefined;
      fixture.consoleCommands.register("escape-preferences", () => { escaped = preferences.show(); });
      fixture.consoleCommands.executeNow("escape-preferences");
      if (escaped === undefined) throw new Error("Missing escaped preferences operation");
      const settled: Promise<unknown> = escaped.catch((error: unknown): unknown => error);
      await entered.promise;
      gate.resolve();
      const failure = await settled;
      if (!(failure instanceof Error)) throw new Error("Escaped preferences operation rejected without an Error");
      expect(failure.message).toContain("closed command");
      expect([fixture.state.menuDepth, fixture.state.activeMenu, preferences.menu.itemCount]).toEqual([0, null, 0]);
      fixture.assets.beforeRead = null;
      await preferences.show();
      expect(fixture.state.activeMenu).toBe(preferences.menu);
      expect(preferences.menu.itemCount).toBe(15);
    } finally {
      fixture.close();
    }
  });
});
