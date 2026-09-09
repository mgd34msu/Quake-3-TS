import { expect, test } from "bun:test";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { KeyCode } from "../src/core/key-codes.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { BaseConfirmMenu } from "../src/ui/base/confirm.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { refresh } from "../src/ui/base/framework.ts";
import { BaseUiGameInfo } from "../src/ui/base/game-info.ts";
import { BasePlayerModelMenu } from "../src/ui/base/player-model.ts";
import { BasePlayerSettingsMenu } from "../src/ui/base/player-settings.ts";
import { BaseUiPlayers } from "../src/ui/base/players.ts";
import { BaseSpLevelMenu } from "../src/ui/base/sp-level.ts";
import { BaseSpResetMenu } from "../src/ui/base/sp-reset.ts";
import { BaseSpSkillMenu } from "../src/ui/base/sp-skill.ts";
import { BaseStartServerMenu } from "../src/ui/base/start-server.ts";
import { baseFixture } from "./base-ui-fixture.ts";

test("legacy reset uses real input, CPU warnings, and the source reset/reopen order", async () => {
  const f = await baseFixture(320, 240);
  const path = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  const sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: path, homePath: path, cdPath: null, product: "baseq3" }, text => { f.prints.push(text); }, sound, f.cvars);
  try {
    await files.initialize({ checksumFeed: 0, random: () => 0 }, () => f.state.assertActive());
    const game = new BaseUiGameInfo(f.state, files); game.initialize();
    const players = new BaseUiPlayers(f.state, files);
    const model = new BasePlayerModelMenu(f.state, players, new HunkArena(6 * 1024 * 1024, text => { f.prints.push(text); }));
    const settings = new BasePlayerSettingsMenu(f.state, players, model);
    const level = new BaseSpLevelMenu(f.state, game, new BaseSpSkillMenu(f.state, game), settings, new BaseStartServerMenu(f.state, game), new BaseConfirmMenu(f.state));
    const reset = new BaseSpResetMenu(f.state, game, level);
    const press = async (key: number): Promise<void> => {
      await f.keys.keyEvent(key, true, 1); await f.keys.keyEvent(key, false, 2);
    };
    await cacheMenu(f.state);
    f.cvars.set("model", "sarge/default", true);
    game.unlockLevelScores(); game.logAwardData(0, 10); f.cvars.set("ui_spSelection", "9", true);
    await level.show(); await reset.show();
    expect(f.state.menuDepth).toBe(2);
    expect(reset.menu.fullscreen).toBe(true);
    expect(reset.menu.cursor).toBe(1);
    expect(reset.menu.items.map(item => [item.common.id, item.common.x, item.common.y])).toEqual([[101, 263, 264], [100, 338, 264]]);
    await refresh(f.state, 150); f.commands.submit();
    for (const y of [178, 192, 205, 219]) {
      let yellow = 0;
      for (let row = y; row < y + 10; row++) for (let x = 60; x < 260; x++) {
        const offset = (row * 320 + x) * 4;
        const r = f.cpu.pixels[offset], g = f.cpu.pixels[offset + 1], b = f.cpu.pixels[offset + 2];
        if (r !== undefined && g !== undefined && b !== undefined && r > 100 && g > 100 && b < 80) yellow++;
      }
      expect(yellow).toBeGreaterThan(10);
    }
    for (const key of [KeyCode.Left, KeyCode.KeypadLeft, KeyCode.Right, KeyCode.KeypadRight]) {
      await press(key); expect(reset.menu.cursor).toBe(0);
      await press(KeyCode.Tab); expect(reset.menu.cursor).toBe(1);
    }
    await press(78); expect(f.state.activeMenu).toBe(level.menu);
    expect(f.cvars.get("ui_spSelection")?.value).toBe("9");
    expect(f.cvars.get("g_spAwards")?.value).not.toBe("");
    f.phase("connected"); await reset.show(); expect(reset.menu.fullscreen).toBe(false);
    await press(KeyCode.Enter); expect(f.state.activeMenu).toBe(level.menu);
    await reset.show();
    const order: string[] = [], newGame = game.newGame.bind(game), set = f.cvars.set.bind(f.cvars), show = level.show.bind(level);
    game.newGame = () => { order.push(`new:${f.state.menuDepth}`); newGame(); };
    f.cvars.set = (name, value, force) => { if (name === "ui_spSelection") order.push(`select:${value}:${f.state.menuDepth}`); return set(name, value, force); };
    level.show = async () => { order.push(`show:${f.state.menuDepth}`); await show(); };
    await press(89);
    expect(order.slice(0, 3)).toEqual(["new:1", "select:0:1", "show:0"]);
    expect(f.state.activeMenu).toBe(level.menu); expect(f.state.menuDepth).toBe(1);
    expect(f.cvars.get("ui_spSelection")?.value).toBe("0");
    for (const name of ["g_spScores1", "g_spScores2", "g_spScores3", "g_spScores4", "g_spScores5", "g_spAwards", "g_spVideos"]) expect(f.cvars.get(name)?.value).toBe("");
    expect(f.consoleCommands.pendingText).toBe("");
  } finally { files.close(); sound.close(); f.close(); }
});
