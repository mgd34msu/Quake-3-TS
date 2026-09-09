import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CommandBuffer } from "../src/core/commands.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { infoValueForKey } from "../src/core/info-string.ts";
import { ClientStaticState } from "../src/engine/client-state.ts";
import { ServerBrowser, ServerBrowserSource } from "../src/engine/server-browser.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { decodeConnectionless, encodeConnectionlessText } from "../src/protocol/connectionless.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";

test("CL_UpdateServerInfo applies a retained ping to later browser rows and ignores cleared ping slots", async () => {
  const stdin = new PassThrough(), cvars = new CvarRegistry(), state = new ClientStaticState();
  const io = new UnixIo(() => undefined, new UnixSystemClock(), { stdin, signals: "none" });
  try {
    cvars.register("net_ip", "127.0.0.1"); cvars.register("net_port", "0");
    await io.initializeNetwork(cvars);
    const udp = io.udp;
    if (udp === null) throw new Error("Missing owned localhost UDP socket");
    const address = `${udp.address.host.join(".")}:${udp.address.port}`;
    const browser = new ServerBrowser({ io, cvars, clientStatic: state, loopback: new LoopbackTransport(),
      print: () => undefined, assertCurrentOperation: () => undefined });
    browser.updateServerInfo(0);
    const commands = new CommandBuffer();
    commands.registerAsync("ping", context => browser.pingCommand(context));
    state.realtime = 10;
    commands.append(`ping ${address}\n`); await commands.executeAsync();
    state.realtime = 34;
    const bytes = encodeConnectionlessText("infoResponse\n\\protocol\\68\\hostname\\Retained server\\mapname\\q3dm1\\clients\\3");
    browser.handleConnectionless(udp.address, decodeConnectionless(bytes, "client"), bytes);
    await browser.addServer(ServerBrowserSource.Favorites, "Added afterward", address);
    expect(infoValueForKey(browser.getServerInfo(ServerBrowserSource.Favorites, 0, 1024), "hostname")).toBe("Added afterward");
    browser.updateServerInfo(0);
    const info = browser.getServerInfo(ServerBrowserSource.Favorites, 0, 1024);
    expect(infoValueForKey(info, "hostname")).toBe("Retained server");
    expect(infoValueForKey(info, "mapname")).toBe("q3dm1");
    expect(infoValueForKey(info, "clients")).toBe("3");
    expect(infoValueForKey(info, "ping")).toBe("25");
    browser.resetPings(ServerBrowserSource.Favorites);
    browser.clearPing(0);
    browser.updateServerInfo(0);
    expect(browser.getServerPing(ServerBrowserSource.Favorites, 0)).toBe(-1);
  } finally { io.close(); stdin.destroy(); }
});
