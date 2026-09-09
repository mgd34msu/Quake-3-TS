import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import type { CommandContext } from "../src/core/commands.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { CommonCdKeyState } from "../src/engine/cd-key.ts";
import { ClientConnectionState, ClientStaticState } from "../src/engine/client-state.ts";
import { ServerBrowser } from "../src/engine/server-browser.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { RendererConfiguration } from "../src/render/configuration.ts";
import { SourceRendererSettings } from "../src/render/settings.ts";
import { BaseUiGameInfo } from "../src/ui/base/game-info.ts";
import { BaseUi } from "../src/ui/base/ui.ts";
import { UiMenuCommand } from "../src/ui/public.ts";
import { VmRegistry } from "../src/vm/registry.ts";
import { baseFixture } from "./base-ui-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

async function fixture() {
  const f = await baseFixture(320, 240); cleanup.push(f.close);
  const output = new SoundOutput(); cleanup.push(() => output.close());
  const path = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  const files = new CommonFileState({ dataPath: path, homePath: path, cdPath: null, product: "baseq3" },
    text => { f.prints.push(text); }, output, f.cvars);
  cleanup.push(() => files.close());
  await files.initialize({ checksumFeed: 0, random: () => 0 }, () => f.state.assertActive());
  const stdin = new PassThrough(), io = new UnixIo(() => undefined, new UnixSystemClock(), { stdin, signals: "none" });
  cleanup.push(() => { io.close(); stdin.destroy(); });
  const clientStatic = new ClientStaticState(), connection = new ClientConnectionState();
  const browser = new ServerBrowser({ io, clientStatic, loopback: new LoopbackTransport(), cvars: f.cvars,
    print: text => { f.prints.push(text); }, assertCurrentOperation: () => f.state.assertActive() });
  const window = SdlWindow.open({ title: "Base UI VM trace fixture", width: 320, height: 240, backend: "cpu", hidden: true });
  cleanup.push(() => window.close());
  const settings = f.resources.settings;
  if (!(settings instanceof SourceRendererSettings)) throw new Error("Actual renderer settings required");
  const configuration = RendererConfiguration.create({ window, renderer: { kind: "cpu", backend: f.cpu }, settings });
  cleanup.push(() => configuration.close());
  const trace: string[] = [];
  const observation: { print: (text: string) => void } = { print: () => undefined };
  const registry = new VmRegistry(text => { trace.push(text); observation.print(text); });
  const registration = registry.reserve("ui"), called = registration.called;
  registration.called = () => { called(); trace.push("called"); };
  const ui = new BaseUi({ state: f.state, gameInfo: new BaseUiGameInfo(f.state, files), files,
    cdKey: new CommonCdKeyState(f.cvars, "client"), commands: f.consoleCommands,
    hunk: new HunkArena(1024 * 1024, text => { f.prints.push(text); }), browser, configuration, readSession: () => null }, registration);
  cleanup.push(() => ui.retire());
  return { ...f, ui, registry, trace, observation, clientStatic, connection };
}

// These CPU checks require the SDL dummy driver so ordinary test runs cannot open a desktop window.
describe.skipIf(process.env["SDL_VIDEODRIVER"] !== "dummy")("base UI VM_Call tracing", () => {
  test("all eleven source exports print once after marking the real registered owner", async () => {
    const f = await fixture();
    f.registry.debug(1);
    const invoke = async (id: number, body: () => unknown): Promise<void> => {
      f.trace.length = 0;
      await body();
      expect(f.trace).toEqual(["called", `VM_Call( ${id} )\n`]);
    };
    await invoke(0, () => expect(f.ui.apiVersion()).toBe(6));
    await invoke(1, () => f.ui.initialize());
    await invoke(3, () => f.ui.keyEvent(27, false));
    await invoke(4, () => f.ui.mouseEvent(2, 3));
    await invoke(5, () => f.ui.refresh(123));
    expect(f.state.realtime).toBe(123);
    await invoke(6, () => expect(f.ui.isFullscreen()).toBe(false));
    await invoke(7, () => f.ui.setActiveMenu(UiMenuCommand.None));
    f.consoleCommands.registerAsync("unknown_ui_trace", async context => {
      expect(await f.ui.consoleCommand(context)).toBe(false);
    });
    await invoke(8, () => f.consoleCommands.executeNowAsync("unknown_ui_trace"));
    await invoke(9, () => f.ui.drawConnectScreen(true, f.clientStatic, f.connection));
    await invoke(10, () => expect(f.ui.usesUniqueKey()).toBe(1));
    await invoke(2, () => f.ui.shutdown());
    f.trace.length = 0;
    expect(f.ui.state).toBe(f.state);
    expect(f.ui.configuration.vidWidth).toBe(320);
    await f.ui.confirm.cache();
    expect(f.trace).toEqual([]);
    await invoke(10, () => f.ui.cdKey.show());
    f.trace.length = 0;
    f.ui.retire(); f.ui.retire();
    expect(f.trace).toEqual([]);
    expect(() => f.ui.apiVersion()).toThrow("VM registration has been freed");
    expect(f.trace).toEqual([]);
  });

  test("trace callbacks run before initialization and refresh side effects and can abort the body", async () => {
    const f = await fixture(); f.registry.debug(-1);
    let registrations = 0;
    const register = f.state.services.cvars.register.bind(f.state.services.cvars);
    f.state.services.cvars.register = () => { registrations++; register(); };
    f.observation.print = text => {
      expect(text).toBe("VM_Call( 1 )\n"); expect(registrations).toBe(0);
      throw new Error("stop at VM print");
    };
    await expect(f.ui.initialize()).rejects.toThrow("stop at VM print");
    expect(registrations).toBe(0);
    expect(f.trace).toEqual(["called", "VM_Call( 1 )\n"]);
    f.observation.print = () => undefined;
    await f.ui.initialize(); expect(registrations).toBe(1);
    f.observation.print = text => {
      expect(text).toBe("VM_Call( 5 )\n"); expect(f.state.realtime).toBe(0);
      throw new Error("stop at VM print");
    };
    expect(() => f.ui.refresh(321)).toThrow("stop at VM print");
    expect(f.state.realtime).toBe(0);
    f.registry.debug(0); f.trace.length = 0;
    await f.ui.refresh(321);
    expect(f.state.realtime).toBe(321);
    expect(f.trace).toEqual(["called"]);
  });

  test("a rejected console context never marks or prints a VM entry", async () => {
    const f = await fixture(); f.registry.debug(1);
    let retained: CommandContext | null = null;
    f.consoleCommands.registerAsync("retain_ui_context", async context => { retained = context; });
    await f.consoleCommands.executeNowAsync("retain_ui_context");
    if (retained === null) throw new Error("Missing executed command context");
    await expect(f.ui.consoleCommand(retained)).rejects.toThrow();
    expect(f.trace).toEqual([]);
  });
});
