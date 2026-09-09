import { expect, test } from "bun:test";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import { BaseCinematicsMenu } from "../src/ui/base/cinematics-menu.ts";
import { BaseCreditsMenu } from "../src/ui/base/credits.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { isFullscreen, refresh } from "../src/ui/base/framework.ts";
import { BaseServerInfoMenu } from "../src/ui/base/server-info.ts";
import { BaseSpecifyServerMenu } from "../src/ui/base/specify-server.ts";
import { BaseTeamMenu } from "../src/ui/base/team-menu.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";
import { baseFixture } from "./base-ui-fixture.ts";

test("Specify Server and Cinematics share actual input, stack and pending commands without aliasing queued drawing", async () => {
  const f = await baseFixture(320, 240);
  try {
    await cacheMenu(f.state);
    const specify = new BaseSpecifyServerMenu(f.state), movies = new BaseCinematicsMenu(f.state);
    f.consoleCommands.registerAsync("test_movies", context => movies.showFromCommand(context));
    async function press(key: number): Promise<void> {
      await f.keys.keyEvent(key, true, 100); await f.keys.keyEvent(key, false, 101);
    }
    await specify.show();
    const domain = specify.menu.items[3], port = specify.menu.items[4];
    if (domain === undefined || domain.kind !== "field" || port === undefined || port.kind !== "field")
      throw new Error("Missing actual Specify Server fields");
    for (const character of "server.example") await f.keys.charEvent(character.charCodeAt(0));
    expect(domain.field.text).toBe("server.example"); expect(port.field.text).toBe("27960");
    expect(specify.menu.cursor).toBe(3);
    await f.consoleCommands.executeNowAsync("test_movies 10");
    expect(movies.menu.cursor).toBe(13);
    expect(f.state.stack.slice(0, f.state.menuDepth)).toEqual([specify.menu, movies.menu]);
    await press(KeyCode.Enter);
    expect(f.state.activeMenu).toBe(specify.menu); expect(specify.menu.cursor).toBe(3);
    expect(domain.field.text).toBe("server.example"); expect(f.consoleCommands.pendingText).toBe("");
    await press(KeyCode.Tab); await press(KeyCode.Tab); expect(specify.menu.cursor).toBe(5);
    await press(KeyCode.Enter);
    const connect = "connect server.example:27960\n";
    expect(f.consoleCommands.pendingText).toBe(connect);
    expect(f.state.activeMenu).toBe(specify.menu); expect(f.state.menuDepth).toBe(1);
    f.cvars.set("g_spVideos", "\\tier8\\1", true);
    await f.consoleCommands.executeNowAsync("test_movies 9");
    expect(movies.menu.cursor).toBe(12); await press(KeyCode.Enter);
    const pending = connect + "disconnect; cinematic end.RoQ\n";
    expect(f.consoleCommands.pendingText).toBe(pending);
    expect(f.cvars.get("nextmap")?.value).toBe("ui_cinematics 9");
    expect(f.state.activeMenu).toBe(movies.menu); expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui);
    await refresh(f.state, 100); f.commands.submit(); const moviePixels = f.cpu.pixels.slice();
    await refresh(f.state, 100);
    await specify.show();
    expect(specify.menu.items[3]).toBe(domain); expect(specify.menu.items[4]).toBe(port);
    expect(domain.field.text).toBe(""); expect(port.field.text).toBe("27960");
    expect([specify.menu.cursor, specify.menu.cursorPrev, f.state.menuDepth]).toEqual([3, 0, 1]);
    expect(f.state.activeMenu).toBe(specify.menu);
    expect(f.state.stack).toEqual([specify.menu, movies.menu]);
    f.cpu.pixels.fill(17); expect(f.cpu.pixels).not.toEqual(moviePixels);
    expect(f.commands.submit().commands).toBeGreaterThan(0);
    expect(f.cpu.pixels).toEqual(moviePixels);
    await refresh(f.state, 100); f.commands.submit(); expect(f.cpu.pixels).not.toEqual(moviePixels);
    expect(f.consoleCommands.pendingText).toBe(pending);
    expect(f.cvars.get("nextmap")?.value).toBe("ui_cinematics 9"); expect(f.prints).toEqual([]);
  } finally { f.close(); }
});

// Direct menu entrypoints and command observers, not a product UI or a live network host.
test("joined menu owners restore Team after favorite pop, release held input after team append, and retain Credits on quit", async () => {
  const f = await baseFixture();
  try {
    await cacheMenu(f.state);
    const executed: string[] = [];
    for (const name of ["+forward", "-forward", "marker", "cmd", "quit"])
      f.consoleCommands.register(name, context => { executed.push(context.raw); });
    f.phase("active"); f.keys.setBinding(119, "+forward");
    await f.keys.keyEvent(119, true, 37); f.consoleCommands.execute();
    expect(executed).toEqual(["+forward 119 37"]);
    const readInfo = () => "\\g_gametype\\3\\mapname\\q3dm1";
    const team = new BaseTeamMenu(f.state, readInfo), info = new BaseServerInfoMenu(f.state, readInfo);
    const credits = new BaseCreditsMenu(f.state);
    f.cvars.set("cl_currentServerAddress", "127.0.0.1:27960", true);
    f.cvars.set("cl_paused", "1", true);
    await team.show(); expect(team.menu.cursor).toBe(1);
    await info.show(); expect(f.state.stack.slice(0, f.state.menuDepth)).toEqual([team.menu, info.menu]);
    expect(isFullscreen(f.state)).toBe(true);
    await f.keys.keyEvent(KeyCode.Enter, true, 100);
    await f.keys.keyEvent(KeyCode.Enter, false, 101);
    expect(f.cvars.get("server1")?.value).toBe("127.0.0.1:27960");
    expect(f.state.activeMenu).toBe(team.menu); expect(f.state.menuDepth).toBe(1);
    expect(team.menu.cursor).toBe(1); expect(isFullscreen(f.state)).toBe(false);
    expect(f.keys.isDown(119)).toBe(true); expect(f.cvars.get("cl_paused")?.value).toBe("1");
    expect(f.consoleCommands.pendingText).toBe("");
    f.consoleCommands.append("marker\n"); f.keys.setCatcher(KeyCatcher.Ui | KeyCatcher.Cgame);
    await f.keys.keyEvent(KeyCode.Enter, true, 110);
    expect(f.consoleCommands.pendingText).toBe("marker\ncmd team red\n-forward 119 0\n");
    expect(f.state.menuDepth).toBe(0); expect(f.state.activeMenu).toBeNull();
    expect(f.keys.isDown(119)).toBe(false); expect(f.keys.isDown(KeyCode.Enter)).toBe(false);
    expect(f.keys.getCatcher()).toBe(KeyCatcher.Cgame); expect(f.cvars.get("cl_paused")?.value).toBe("0");
    await credits.show(); expect(f.state.menuDepth).toBe(1); expect(f.state.activeMenu).toBe(credits.menu);
    expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui); expect(isFullscreen(f.state)).toBe(true);
    await f.keys.charEvent(113); await f.keys.keyEvent(KeyCode.Escape, true, 120);
    expect(f.consoleCommands.pendingText).toBe("marker\ncmd team red\n-forward 119 0\nquit\n");
    expect(executed).toEqual(["+forward 119 37"]);
    expect(f.state.activeMenu).toBe(credits.menu); expect(f.state.menuDepth).toBe(1);
    expect(await f.consoleCommands.executeAsync()).toBe(4);
    expect(executed).toEqual(["+forward 119 37", "marker", "cmd team red", "-forward 119 0", "quit"]);
    expect(f.state.activeMenu).toBe(credits.menu);
    expect(f.cvars.get("server1")?.value).toBe("127.0.0.1:27960");
  } finally { f.close(); }
});

test("joined menu snapshots use one actual session and reopening lower owners resets only source logical stack depth", async () => {
  const f = await baseFixture(320, 240), lifecycle = new ProtocolClientLifecycle(f.cvars);
  const client = new EngineClientSession({ product: "baseq3", cvars: f.cvars, lifecycle,
    mode: { kind: "network", challenge: 17, qport: 27961 } });
  try {
    async function receive(value: string): Promise<void> {
      const number = client.serverMessageSequence + 1;
      const bytes = encodeServerMessage(0, [{ kind: "gamestate", commandSequence: 0, clientNumber: 0, checksumFeed: 19,
        entries: [{ kind: "configstring", index: 1, value: "\\sv_serverid\\100\\sv_cheats\\1" },
          { kind: "configstring", index: 0, value }] }],
      { product: "baseq3", messageNumber: number, reliableSequence: 0, serverCommandSequence: 0,
        parseEntitiesNumber: 0, baseline: () => null, history: () => null });
      await client.receiveServerMessage(number, bytes);
    }
    let reads = 0;
    const readInfo = () => {
      reads++;
      const value = client.getGameState()[0];
      if (value === undefined) throw new Error("Missing protocol-owned CS_SERVERINFO");
      return value;
    };
    await cacheMenu(f.state);
    const team = new BaseTeamMenu(f.state, readInfo), info = new BaseServerInfoMenu(f.state, readInfo);
    const credits = new BaseCreditsMenu(f.state), menus = [team.menu, info.menu, credits.menu];
    await receive("\\g_gametype\\0\\hostname\\FIRST");
    await team.show(); expect(team.menu.cursor).toBe(3); await info.show();
    await refresh(f.state, 0); f.commands.submit(); const first = f.cpu.pixels.slice();
    expect(reads).toBe(2);
    await receive("\\g_gametype\\3\\hostname\\SECOND");
    await refresh(f.state, 0); f.commands.submit();
    expect(reads).toBe(2); expect(f.cpu.pixels).toEqual(first); expect(team.menu.cursor).toBe(3);
    await credits.show(); await refresh(f.state, 0); f.commands.submit();
    expect(f.state.stack.slice(0, f.state.menuDepth)).toEqual(menus);
    expect(reads).toBe(2); expect(f.cpu.pixels).not.toEqual(first);
    await team.show();
    expect(f.state.menuDepth).toBe(1); expect(f.state.activeMenu).toBe(team.menu); expect(team.menu.cursor).toBe(1);
    expect(f.state.stack).toEqual(menus); expect(reads).toBe(3);
    await info.show(); await refresh(f.state, 0); f.commands.submit();
    expect(reads).toBe(4); expect(f.state.menuDepth).toBe(2); expect(f.cpu.pixels).not.toEqual(first);
    await f.keys.keyEvent(KeyCode.Escape, true, 10); await f.keys.keyEvent(KeyCode.Escape, false, 11);
    expect(f.state.activeMenu).toBe(team.menu); expect(team.menu.cursor).toBe(1);
    await credits.show();
    expect([team.menu, info.menu, credits.menu]).toEqual(menus);
    expect(f.state.stack.slice(0, f.state.menuDepth)).toEqual([team.menu, credits.menu]);
    expect(f.state.menuDepth).toBe(2); expect(reads).toBe(4); expect(lifecycle.gamestates).toHaveLength(2);
    expect(f.consoleCommands.pendingText).toBe("");
  } finally { lifecycle.close(); f.close(); }
});
