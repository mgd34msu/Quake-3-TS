import { expect, test } from "bun:test";
import { KeyCode } from "../src/core/key-codes.ts";
import { CommonCdKeyState } from "../src/engine/cd-key.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import { BaseCdKeyMenu } from "../src/ui/base/cd-key.ts";
import { BaseConfirmMenu } from "../src/ui/base/confirm.ts";
import { BaseCreditsMenu } from "../src/ui/base/credits.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { BaseInGameMenu } from "../src/ui/base/ingame.ts";
import { BasePreferencesMenu } from "../src/ui/base/preferences.ts";
import { BaseSetupMenu } from "../src/ui/base/setup.ts";
import { MenuFlag } from "../src/ui/base/state.ts";
import type { BaseMenu } from "../src/ui/base/state.ts";
import { BaseTeamMenu } from "../src/ui/base/team-menu.ts";
import { BaseServerInfoMenu } from "../src/ui/base/server-info.ts";
import { BaseTeamOrdersMenu } from "../src/ui/base/team-orders.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";
import { baseFixture } from "./base-ui-fixture.ts";

type Fixture = Awaited<ReturnType<typeof baseFixture>>;
async function outsideFlow(): Promise<never> { throw new Error("This route is outside the focused menu flow"); }
function choice(menu: BaseMenu, id: number) {
  const item = menu.items.find(item => item.common.id === id);
  if (item === undefined) throw new Error(`Missing source menu item ${id}`);
  return item;
}
async function press(f: Fixture, key: number): Promise<void> { await f.keys.keyEvent(key, true, 10); await f.keys.keyEvent(key, false, 11); }
async function select(f: Fixture, menu: BaseMenu, id: number): Promise<void> {
  await setCursorToItem(f.state, menu, choice(menu, id)); await press(f, KeyCode.Enter);
}
function setup(f: Fixture, confirm: BaseConfirmMenu) {
  const preferences = new BasePreferencesMenu(f.state), cdKey = new BaseCdKeyMenu(f.state, new CommonCdKeyState(f.cvars, "client"), () => 1);
  const owner = new BaseSetupMenu(f.state, confirm, { playerSettings: outsideFlow, controls: outsideFlow, graphics: outsideFlow,
    preferences: () => preferences.show(), cdKey: () => cdKey.show() });
  return { owner, preferences, cdKey };
}

test("Setup uses real leaf menus and Defaults confirmation, then hides Defaults while paused", async () => {
  const f = await baseFixture(); try {
    await cacheMenu(f.state); const confirm = new BaseConfirmMenu(f.state), s = setup(f, confirm);
    await s.owner.show(); const menu = s.owner.menu, player = choice(menu, 10);
    expect(menu.itemCount).toBe(10);
    await select(f, menu, 13); expect(f.state.activeMenu).toBe(s.preferences.menu);
    await press(f, KeyCode.Escape); expect(f.state.activeMenu).toBe(menu);
    await select(f, menu, 14); expect(f.state.activeMenu).toBe(s.cdKey.menu);
    await press(f, KeyCode.Escape);
    await select(f, menu, 17); expect(f.state.activeMenu).toBe(confirm.menu);
    await refresh(f.state, 10); f.commands.submit(); expect(f.cpu.pixels.some(byte => byte !== 0)).toBe(true);
    await press(f, 121); expect(f.state.activeMenu).toBe(menu);
    expect(f.consoleCommands.pendingText).toBe("exec default.cfg\ncvar_restart\nvid_restart\n");
    f.cvars.set("cl_paused", "1", true); await s.owner.show();
    expect(choice(menu, 10)).toBe(player); expect(menu.itemCount).toBe(9);
    expect(menu.items.some(item => item.common.id === 17)).toBe(false);
    await select(f, menu, 18); expect(f.state.menuDepth).toBe(0);
  } finally { f.close(); }
});

test("In-Game reads actual session team state and performs Leave, confirmed Restart and Credits flows", async () => {
  const f = await baseFixture(), lifecycle = new ProtocolClientLifecycle(f.cvars);
  try {
    await cacheMenu(f.state); const confirm = new BaseConfirmMenu(f.state), s = setup(f, confirm);
    const client = new EngineClientSession({ product: "baseq3", cvars: f.cvars, lifecycle, mode: { kind: "network", challenge: 1, qport: 27961 } });
    const credits = new BaseCreditsMenu(f.state), team = new BaseTeamMenu(f.state, () => client.getConfigString(0) ?? "");
    const server = new BaseServerInfoMenu(f.state, () => client.getConfigString(0) ?? ""), orders = new BaseTeamOrdersMenu(f.state);
    const owner = new BaseInGameMenu(f.state, confirm, { team: () => team.show(), addBots: outsideFlow, removeBots: outsideFlow,
      teamOrders: () => orders.show(client), setup: () => s.owner.show(), serverInfo: () => server.show(), credits: () => credits.show() });
    async function load(number: number, team: string): Promise<void> {
      await client.receiveServerMessage(number, encodeServerMessage(0, [{ kind: "gamestate", commandSequence: 0, clientNumber: 7, checksumFeed: 0,
        entries: [{ kind: "configstring", index: 0, value: "\\g_gametype\\4\\sv_maxclients\\8" },
          { kind: "configstring", index: 1, value: "\\sv_serverid\\100\\sv_cheats\\1\\fs_game\\" },
          { kind: "configstring", index: 544, value: `\\t\\${team}` }] }],
      { product: "baseq3", messageNumber: number, reliableSequence: 0, serverCommandSequence: 0, parseEntitiesNumber: 0, baseline: () => null, history: () => null }));
    }
    await load(1, "3"); f.cvars.set("g_gametype", "4", true); await owner.show(client);
    expect([f.state.menuDepth, f.state.cursorX, f.state.cursorY, owner.menu.itemCount, owner.menu.fullscreen]).toEqual([1, 319, 80, 11, false]);
    for (const id of [11, 12, 16, 19]) expect(choice(owner.menu, id).common.flags & MenuFlag.Grayed).toBe(MenuFlag.Grayed);
    await load(2, "1"); f.cvars.set("sv_running", "1", true); f.cvars.set("bot_enable", "1", true); await owner.show(client);
    for (const id of [11, 12, 16, 19]) expect(choice(owner.menu, id).common.flags & MenuFlag.Grayed).toBe(0);
    await select(f, owner.menu, 13); expect(f.state.activeMenu).toBe(s.owner.menu); await press(f, KeyCode.Escape);
    await select(f, owner.menu, 19); expect(f.state.activeMenu).toBe(orders.menu); await press(f, KeyCode.Escape);
    await refresh(f.state, 20); f.commands.submit(); expect(f.cpu.pixels.some(byte => byte !== 0)).toBe(true);
    await select(f, owner.menu, 15); expect(f.state.activeMenu).toBe(owner.menu);
    await select(f, owner.menu, 16); await press(f, 121);
    expect(f.state.menuDepth).toBe(0); expect(f.consoleCommands.pendingText).toBe("disconnect\nmap_restart 0\n");
    await owner.show(client); await select(f, owner.menu, 17); await press(f, 121);
    expect(f.state.activeMenu).toBe(credits.menu); expect(f.state.menuDepth).toBe(1);
  } finally { lifecycle.close(); f.close(); }
});
