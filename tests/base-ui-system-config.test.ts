import { expect, test } from "bun:test";
import type { ClientKeyPhase } from "../src/engine/client-keys.ts";
import { BaseSystemConfigMenu } from "../src/ui/base/system-config.ts";
import { itemAt, MenuEvent, MenuFlag } from "../src/ui/base/state.ts";
import { baseFixture } from "./base-ui-fixture.ts";

test("SystemConfig preserves source phase threshold, geometry, callbacks and reset-before-cache", async () => {
  const f = await baseFixture(), calls: string[] = [];
  try {
    const owner = new BaseSystemConfigMenu(f.state, {
      graphics: async () => { calls.push("graphics"); }, display: async () => { calls.push("display"); },
      sound: async () => { calls.push("sound"); }, network: async () => { calls.push("network"); },
    });
    f.registrations.length = 0; await owner.cache(); expect(owner.menu.items).toEqual([]);
    expect(f.registrations).toEqual(["frame2_l", "frame1_r", "back_0", "back_1"].map(name => `shader:menu/art/${name}`));
    const phases: readonly ClientKeyPhase[] = ["uninitialized", "disconnected", "connecting", "challenging", "connected", "loading", "primed", "active", "cinematic"];
    for (const [index, phase] of phases.entries()) {
      f.phase(phase); await owner.show(); expect(owner.menu.fullscreen).toBe(index < 4);
      expect(f.state.activeMenu).toBe(owner.menu); expect(f.state.menuDepth).toBe(1);
    }
    expect(owner.menu.wrapAround).toBe(true);
    const banner = itemAt(owner.menu.items, 0); if (banner.kind !== "banner") throw new Error("Expected source banner");
    expect([banner.text, banner.common.flags, banner.common.x, banner.common.y]).toEqual(["SYSTEM SETUP", MenuFlag.CenterJustify | MenuFlag.Inactive, 320, 16]);
    expect(owner.menu.items.slice(1, 3).map(item => [item.common.x, item.common.y, item.common.flags])).toEqual([[8, 76, MenuFlag.Inactive], [376, 76, MenuFlag.Inactive]]);
    expect(owner.menu.items.slice(3, 7).map(item => [item.common.id, item.common.x, item.common.y, item.common.flags])).toEqual([10, 11, 12, 13].map((id, index) => [id, 320, 168 + index * 34, MenuFlag.CenterJustify | MenuFlag.PulseIfFocus]));
    for (const item of owner.menu.items.slice(3, 7)) {
      if (item.common.callback === null) throw new Error("Expected source callback");
      await item.common.callback(item, MenuEvent.GotFocus); await item.common.callback(item, MenuEvent.Activated);
    }
    expect(calls).toEqual(["graphics", "display", "sound", "network"]);
    const back = itemAt(owner.menu.items, 7); if (back.kind !== "bitmap" || back.common.callback === null) throw new Error("Expected source Back");
    expect([back.common.id, back.common.x, back.common.y, back.width, back.height, back.focuspic]).toEqual([14, 0, 416, 128, 64, "menu/art/back_1"]);
    await back.common.callback(back, MenuEvent.Activated); expect(f.state.activeMenu).toBeNull();
    await owner.show(); const records = [...owner.menu.items], register = f.resources.registerShaderNoMip.bind(f.resources), failure = new Error("cache failed");
    f.resources.registerShaderNoMip = async () => { expect(owner.menu.items).toEqual([]); throw failure; };
    await expect(owner.show()).rejects.toBe(failure); expect(owner.menu.itemCount).toBe(0);
    f.resources.registerShaderNoMip = register; await owner.show();
    for (const [index, item] of records.entries()) expect(itemAt(owner.menu.items, index)).toBe(item);
  } finally { f.close(); }
});
