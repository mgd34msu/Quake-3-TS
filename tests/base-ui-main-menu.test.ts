import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { KeyCode } from "../src/core/key-codes.ts";
import { CommonCdKeyState } from "../src/engine/cd-key.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { BaseCdKeyMenu } from "../src/ui/base/cd-key.ts";
import { BaseConfirmMenu } from "../src/ui/base/confirm.ts";
import { BaseCreditsMenu } from "../src/ui/base/credits.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { BaseMainMenu } from "../src/ui/base/main-menu.ts";
import { baseFixture } from "./base-ui-fixture.ts";

test("real main menu prompts for a key, draws its banner, recovers the error screen and enters Credits", async () => {
  const ui = await baseFixture(), homePath = mkdtempSync(join(tmpdir(), "q3-main-menu-")), sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath, cdPath: null, product: "baseq3" },
    text => { ui.prints.push(text); }, sound, ui.cvars);
  try {
    await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
    await cacheMenu(ui.state);
    const calls: string[] = [], keys = new CommonCdKeyState(ui.cvars, "client");
    const cdKey = new BaseCdKeyMenu(ui.state, keys, () => { calls.push("cdkey"); return 1; });
    const confirm = new BaseConfirmMenu(ui.state), credits = new BaseCreditsMenu(ui.state);
    const outsideFlow = async (): Promise<never> => { throw new Error("Destination is outside this main-menu flow"); };
    const main = new BaseMainMenu(ui.state, files, keys, cdKey, confirm, {
      singlePlayer: outsideFlow, multiplayer: outsideFlow, setup: outsideFlow, demos: outsideFlow,
      cinematics: outsideFlow, mods: outsideFlow, credits: () => credits.show(),
    }, () => { expect(ui.cvars.get("sv_killserver")?.value).toBe("1"); calls.push("main"); return 1; });
    await main.show(); expect(ui.state.activeMenu).toBe(cdKey.menu); expect(ui.cvars.get("sv_killserver")?.value).toBe("1");
    expect(calls).toEqual(["main", "cdkey"]); calls.length = 0;
    ui.state.services.cvars.update(); await main.show();
    expect(calls).toEqual([]);
    expect(ui.state.activeMenu).toBe(main.menu); expect(ui.state.menuDepth).toBe(1);
    expect(main.menu.items.map(item => item.common.id)).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
    await refresh(ui.state, 100); ui.commands.submit();
    expect(ui.cpu.pixels.some(byte => byte !== 0)).toBe(true);
    expect(ui.recorder.trace().some(view => view.batches.length > 0)).toBe(true);
    ui.cvars.set("com_errorMessage", "A recoverable connection error", true); await main.show();
    expect(ui.state.activeMenu).not.toBe(main.menu); expect(ui.state.activeMenu?.itemCount).toBe(0);
    await refresh(ui.state, 101); ui.commands.submit();
    await ui.keys.keyEvent(KeyCode.Enter, true, 102); await ui.keys.keyEvent(KeyCode.Enter, false, 103);
    expect(ui.cvars.get("com_errorMessage")?.value).toBe(""); expect(ui.state.activeMenu).toBe(main.menu);
    const exit = main.menu.items.find(item => item.common.id === 17);
    if (exit === undefined) throw new Error("Main menu is missing Exit");
    await setCursorToItem(ui.state, main.menu, exit);
    await ui.keys.keyEvent(KeyCode.Enter, true, 104); await ui.keys.keyEvent(KeyCode.Enter, false, 105);
    expect(ui.state.activeMenu).toBe(confirm.menu);
    await ui.keys.keyEvent(121, true, 106); await ui.keys.keyEvent(121, false, 107);
    expect(ui.state.activeMenu).toBe(credits.menu); expect(ui.state.menuDepth).toBe(1);
  } finally { files.close(); sound.close(); ui.close(); ui.assets.files.close(); rmSync(homePath, { recursive: true }); }
});
