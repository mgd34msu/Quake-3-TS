import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { CommonCdKeyState } from "../src/engine/cd-key.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { ClientStaticState } from "../src/engine/client-state.ts";
import { ServerBrowser } from "../src/engine/server-browser.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { GamestateEntry } from "../src/protocol/server-message.ts";
import { RendererConfiguration } from "../src/render/configuration.ts";
import { SourceRendererSettings } from "../src/render/settings.ts";
import { setCursorToItem } from "../src/ui/base/framework.ts";
import { BaseUiGameInfo } from "../src/ui/base/game-info.ts";
import type { BaseMenu } from "../src/ui/base/state.ts";
import { BaseUi } from "../src/ui/base/ui.ts";
import { UiMenuCommand } from "../src/ui/public.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";
import { baseFixture } from "./base-ui-fixture.ts";
import { VmRegistry } from "../src/vm/registry.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const f = await baseFixture(320, 240); cleanup.push(() => { f.close(); f.assets.files.close(); });
  f.cvars.set("s_volume", "0", true); f.cvars.set("s_musicvolume", "0", true);
  const output = new SoundOutput(); cleanup.push(() => output.close());
  const path = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  const files = new CommonFileState({ dataPath: path, homePath: path, cdPath: null, product: "baseq3" }, text => { f.prints.push(text); }, output, f.cvars);
  cleanup.push(() => files.close()); await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
  const stdin = new PassThrough(), io = new UnixIo(() => undefined, new UnixSystemClock(), { stdin, signals: "none" });
  cleanup.push(() => { io.close(); stdin.destroy(); });
  const browser = new ServerBrowser({ io, clientStatic: new ClientStaticState(), loopback: new LoopbackTransport(), cvars: f.cvars,
    print: text => { f.prints.push(text); }, assertCurrentOperation: () => f.state.assertActive() });
  const window = SdlWindow.open({ title: "Base UI controller", width: 320, height: 240, backend: "cpu", hidden: true });
  cleanup.push(() => window.close());
  const settings = f.resources.settings;
  if (!(settings instanceof SourceRendererSettings)) throw new Error("Actual renderer settings required");
  const configuration = RendererConfiguration.create({ window, renderer: { kind: "cpu", backend: f.cpu }, settings });
  cleanup.push(() => configuration.close());
  const gameInfo = new BaseUiGameInfo(f.state, files), cdKey = new CommonCdKeyState(f.cvars, "client");
  const registry = new VmRegistry(), registration = registry.reserve("ui");
  let vmCalls = 0;
  const called = registration.called;
  registration.called = () => { vmCalls++; called(); };
  let session: EngineClientSession | null = null;
  const trace: string[] = [], register = f.state.services.cvars.register.bind(f.state.services.cvars);
  const initialize = gameInfo.initialize.bind(gameInfo), copy = configuration.copy.bind(configuration);
  f.state.services.cvars.register = () => { trace.push("cvars"); register(); };
  gameInfo.initialize = () => { trace.push("gameinfo"); initialize(); };
  configuration.copy = () => { trace.push("configuration"); return copy(); };
  const ui = new BaseUi({ state: f.state, gameInfo, files, cdKey, commands: f.consoleCommands,
    hunk: new HunkArena(1024 * 1024, text => { f.prints.push(text); }), browser, configuration, readSession: () => session }, registration);
  cleanup.push(() => ui.retire());
  const publishedBeforeInit = BaseUi.registered(registration) === ui && trace.length === 0 && vmCalls === 0;
  const apiVersion = ui.apiVersion();
  await ui.initialize();
  async function connect(prefix: string): Promise<void> {
    const lifecycle = new ProtocolClientLifecycle(f.cvars); cleanup.push(() => lifecycle.close());
    session = new EngineClientSession({ product: "baseq3", cvars: f.cvars, lifecycle, mode: { kind: "network", challenge: 1, qport: 27961 } });
    const entries: GamestateEntry[] = [
      { kind: "configstring", index: 0, value: "\\sv_maxclients\\8\\g_gametype\\3\\mapname\\q3dm1" },
      { kind: "configstring", index: 1, value: "\\sv_serverid\\1\\sv_cheats\\1\\fs_game\\" },
      ...Array.from({ length: 8 }, (_, n) => ({ kind: "configstring", index: 544 + n, value: `\\n\\${prefix}${n}\\skill\\3\\t\\1` } satisfies GamestateEntry)),
    ];
    await session.receiveServerMessage(1, encodeServerMessage(0, [{ kind: "gamestate", commandSequence: 0, clientNumber: 0, checksumFeed: 0, entries }],
      { product: "baseq3", messageNumber: 1, reliableSequence: 0, serverCommandSequence: 0, parseEntitiesNumber: 0, baseline: () => null, history: () => null }));
    f.phase("active"); f.cvars.set("sv_running", "1", true); f.cvars.set("bot_enable", "1", true); f.cvars.set("g_gametype", "3", true);
  }
  const press = async (key: number): Promise<void> => { await ui.keyEvent(key, true); await ui.keyEvent(key, false); };
  const select = async (menu: BaseMenu, id: number): Promise<void> => {
    const item = menu.items.find(item => item.common.id === id);
    if (item === undefined) throw new Error(`Missing menu item ${id}`);
    await setCursorToItem(f.state, menu, item); await press(KeyCode.Enter);
  };
  return { ...f, ui, gameInfo, trace, connect, press, select, registry, registration, publishedBeforeInit, apiVersion,
    get vmCalls(): number { return vmCalls; } };
}

test("base controller initializes real owners and connects Main, Setup, system siblings and current-session In-Game", async () => {
  const f = await fixture(), { ui } = f;
  expect(f.publishedBeforeInit).toBe(true); expect(f.apiVersion).toBe(6); expect(f.vmCalls).toBe(2);
  expect(f.trace).toEqual(["cvars", "gameinfo", "configuration"]);
  expect(f.gameInfo.getNumArenas()).toBeGreaterThan(0); expect(f.gameInfo.getNumBots()).toBeGreaterThan(0);
  expect([f.state.activeMenu, f.state.menuDepth, ui.configuration.vidWidth]).toEqual([null, 0, 320]);
  await ui.setActiveMenu("main"); expect(f.state.activeMenu).toBe(ui.cdKey.menu);
  await ui.refresh(1); f.commands.submit();
  await ui.setActiveMenu("main"); expect(f.state.activeMenu).toBe(ui.main.menu); expect(ui.isFullscreen()).toBe(true);
  await f.select(ui.main.menu, 12); expect(f.state.activeMenu).toBe(ui.setup.menu);
  await f.select(ui.setup.menu, 12); expect(f.state.activeMenu).toBe(ui.graphics.menu);
  await f.select(ui.graphics.menu, 107); expect(f.state.activeMenu).toBe(ui.display.menu);
  await f.select(ui.display.menu, 12); expect(f.state.activeMenu).toBe(ui.sound.menu);
  await f.select(ui.sound.menu, 13); expect(f.state.activeMenu).toBe(ui.network.menu);
  await ui.refresh(1000); expect(f.commands.submit().batches).toBeGreaterThan(0);
  expect(f.cpu.pixels.some((byte, index) => index % 4 !== 3 && byte !== 0)).toBe(true);
  expect(f.events.some(event => event.startsWith("sound:"))).toBe(true);
  await ui.setActiveMenu(UiMenuCommand.None); expect(f.keys.getCatcher() & KeyCatcher.Ui).toBe(0);
  await f.connect("Before"); await ui.setActiveMenu("ingame"); expect(f.cvars.get("cl_paused")?.value).toBe("1");
  expect(ui.isFullscreen()).toBe(false); await f.select(ui.inGame.menu, 12);
  const rows = () => ui.removeBots.menu.items.filter(item => item.kind === "proportional").map(item => item.text);
  expect(rows()[0]).toBe("Before0");
  await f.connect("After"); await f.select(ui.removeBots.menu, 11); expect(rows()[0]).toBe("After1");
  await f.press(KeyCode.Escape); await f.select(ui.inGame.menu, 10); await f.select(ui.team.menu, 100);
  expect(f.consoleCommands.pendingText).toBe("cmd team red\n"); expect(f.state.menuDepth).toBe(0);
});

test("base UI registry retains source owner identity and marks only actual VM entries", async () => {
  const f = await fixture(), { ui, registration, registry } = f;
  expect(BaseUi.registered(registry.reserve("UI"))).toBe(ui);
  expect(registration.binding.kind).toBe("typescript");
  const before = f.vmCalls;
  expect(ui.state).toBe(f.state);
  expect(ui.configuration.vidWidth).toBe(320);
  await ui.confirm.cache();
  expect(f.vmCalls).toBe(before);
  expect(ui.usesUniqueKey()).toBe(1);
  expect(f.vmCalls).toBe(before + 1);
  await ui.cdKey.show();
  expect(f.vmCalls).toBe(before + 2);
  await ui.initialize();
  expect(BaseUi.registered(registration)).toBe(ui);
  expect(f.vmCalls).toBe(before + 3);
  ui.shutdown();
  expect(f.vmCalls).toBe(before + 4);
  ui.retire();
  expect(f.vmCalls).toBe(before + 4);
  expect(BaseUi.registered(registration)).toBeNull();
  expect(registration.binding.kind).toBe("freed");
});

test("base entry points share Confirm, preserve cache-only state and dispatch actual command contexts", async () => {
  const f = await fixture(), { ui } = f;
  await ui.setActiveMenu(UiMenuCommand.NeedCd); const items = [...ui.confirm.menu.items];
  f.registrations.length = 0; await ui.confirm.cache();
  expect(f.registrations).toEqual(["shader:menu/art/cut_frame"]); expect(ui.confirm.menu.items).toEqual(items);
  await f.press(110); expect(f.consoleCommands.pendingText).toBe("quit\n");
  await ui.setActiveMenu(UiMenuCommand.BadCdKey); await f.press(121); expect(f.consoleCommands.pendingText).toBe("quit\n");
  let handled = false;
  f.consoleCommands.registerAsync("UI_CINEMATICS", async context => { handled = await ui.consoleCommand(context); });
  await f.consoleCommands.executeNowAsync("UI_CINEMATICS 2");
  expect(handled).toBe(true); expect(f.state.activeMenu).toBe(ui.cinematics.menu);
  f.consoleCommands.registerAsync("unknown_ui", async context => { handled = await ui.consoleCommand(context); });
  f.registrations.length = 0; await f.consoleCommands.executeNowAsync("unknown_ui");
  expect(handled).toBe(false); expect(f.registrations.length).toBeGreaterThan(0);
  const active = f.state.activeMenu; await ui.cacheAll(); expect(f.state.activeMenu).toBe(active);
  ui.shutdown(); expect(f.state.activeMenu).toBe(active); await ui.setActiveMenu(UiMenuCommand.None);
  expect(ui.isFullscreen()).toBe(false);
});
