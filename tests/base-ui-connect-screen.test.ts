import { expect, test } from "bun:test";
import { KeyCode } from "../src/core/key-codes.ts";
import { ClientConnectionState, ClientStaticState } from "../src/engine/client-state.ts";
import type { ClientConnectionPhase } from "../src/engine/client-state.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import { UI_CENTER, UI_DROPSHADOW, UI_LEFT, UI_SMALLFONT } from "../src/render/font.ts";
import { BaseConnectScreen, connectionDownloadTime, readableDownloadSize } from "../src/ui/base/connect-screen.ts";
import { autoWrapped, cacheMenu, drawHandle, drawProportional, proportionalScale, stringWidth } from "../src/ui/base/draw.ts";
import { COLORS } from "../src/ui/base/state.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";
import { baseFixture } from "./base-ui-fixture.ts";

type Fixture = Awaited<ReturnType<typeof baseFixture>>;
const UI_BIGFONT = 0x20;
const center = UI_CENTER | UI_SMALLFONT | UI_DROPSHADOW;
function close(f: Fixture): void { f.close(); f.assets.files.close(); }
function heading(f: Fixture, overlay: boolean, server: string, motd: string): void {
  if (!overlay) { f.state.draw.setColor(COLORS.white); drawHandle(f.state, 0, 0, 640, 480, f.state.media.background); }
  drawProportional(f.state, 320, 64, `Connecting to ${server}`, center, COLORS.menuText);
  drawProportional(f.state, 320, 448, motd, center, COLORS.menuText);
}
function equalPixels(actual: Fixture, expected: Fixture): void {
  actual.commands.submit(); expected.commands.submit();
  expect(actual.cpu.pixels.some(byte => byte !== 0)).toBe(true);
  expect(Buffer.from(actual.cpu.pixels).equals(Buffer.from(expected.cpu.pixels))).toBe(true);
}

test("connection size and time formatting retains source strict thresholds and signed arithmetic", () => {
  const sizes: readonly (readonly [number, string])[] = [[0, "0 bytes"], [1024, "1024 bytes"], [1025, "1 KB"],
    [1048576, "1024 KB"], [1572864, "1.50 MB"], [1073741824, "1024.00 MB"], [1610612736, "1.-2 GB"], [-1, "-1 bytes"]];
  for (const [value, text] of sizes) expect(readableDownloadSize(value)).toBe(text);
  for (const [value, text] of [[0, "0 sec"], [60000, "60 sec"], [61000, "1 min 1 sec"], [3600000, "60 min 0 sec"], [3661000, "1 hr 1 min"], [-1999, "-1 sec"]] satisfies readonly (readonly [number, string])[]) {
    expect(connectionDownloadTime(value)).toBe(text);
  }
});

test("real retail CPU connection screen draws actual states, MOTD and pre-admission messages", async () => {
  const cases: readonly (readonly [ClientConnectionPhase, string | null, boolean])[] = [
    ["connecting", "Awaiting challenge...3", true], ["challenging", "Awaiting connection...3", true],
    ["connected", "Awaiting gamestate...", false], ["loading", null, false], ["primed", null, false],
  ];
  for (const [phase, status, rejection] of cases) {
    const f = await baseFixture(320, 240), expected = await baseFixture(320, 240);
    try {
      const cls = new ClientStaticState(), connection = new ClientConnectionState();
      cls.phase = phase; cls.servername = "local.example"; cls.updateInfoString = "\\motd\\Welcome to Quake";
      connection.connectPacketCount = 3; connection.serverMessage = "Server is full";
      await new BaseConnectScreen(f.state).draw(false, cls, connection, null);
      await cacheMenu(expected.state); heading(expected, false, "local.example", "Welcome to Quake");
      if (rejection) autoWrapped(expected.state, 320, 192, 630, 20, "Server is full", center, COLORS.menuText);
      if (status !== null) drawProportional(expected.state, 320, 128, status, center, COLORS.white);
      equalPixels(f, expected);
    } finally { close(f); close(expected); }
  }
});

test("overlay omits background and Escape appends the actual disconnect command", async () => {
  const f = await baseFixture(), expected = await baseFixture();
  try {
    const cls = new ClientStaticState(), connection = new ClientConnectionState(), screen = new BaseConnectScreen(f.state);
    cls.phase = "disconnected"; cls.servername = "localhost";
    f.cpu.pixels.fill(31); expected.cpu.pixels.fill(31);
    await screen.draw(true, cls, connection, null);
    await cacheMenu(expected.state); heading(expected, true, "localhost", ""); equalPixels(f, expected);
    expect(f.cpu.pixels[0]).toBe(31);
    screen.keyEvent(KeyCode.Enter); expect(f.consoleCommands.pendingText).toBe("");
    screen.keyEvent(KeyCode.Escape); expect(f.consoleCommands.pendingText).toBe("disconnect\n");
  } finally { close(f); close(expected); }
});

test("download screen consumes real cvars for estimating, measured rate and unknown total", async () => {
  const cases: readonly (readonly [number, number, number, string, string, string, string | null])[] = [
    [8192, 2048, 0, "pak.pk3 (25%)", "estimating", "(2 KB of 8 KB copied)", null],
    [65536, 8192, 1000, "pak.pk3 (12%)", "14 sec", "(8 KB of 64 KB copied)", "4 KB/Sec"],
    [0, 8192, 1000, "pak.pk3", "estimating", "(8 KB copied)", "4 KB/Sec"],
  ];
  for (const [size, count, time, title, eta, copied, rate] of cases) {
    const f = await baseFixture(320, 240), expected = await baseFixture(320, 240);
    try {
      const cls = new ClientStaticState(); cls.phase = "connected"; cls.servername = "localhost";
      f.state.realtime = 3000;
      for (const [name, value] of [["cl_downloadName", "pak.pk3"], ["cl_downloadSize", String(size)], ["cl_downloadCount", String(count)], ["cl_downloadTime", String(time)]] satisfies readonly (readonly [string, string])[]) f.cvars.set(name, value);
      await new BaseConnectScreen(f.state).draw(false, cls, new ClientConnectionState(), null);
      await cacheMenu(expected.state); heading(expected, false, "localhost", "");
      const style = UI_LEFT | UI_SMALLFONT | UI_DROPSHADOW;
      const left = Math.trunc(stringWidth("Estimated time left:") * proportionalScale(style)) + 16;
      for (const [x, y, text] of [[8, 128, "Downloading:"], [8, 160, "Estimated time left:"], [8, 224, "Transfer rate:"],
        [left, 128, title], [left, 160, eta], [left, 192, copied]] satisfies readonly (readonly [number, number, string])[]) drawProportional(expected.state, x, y, text, style, COLORS.white);
      if (rate !== null) drawProportional(expected.state, left, 224, rate, style, COLORS.white);
      equalPixels(f, expected);
    } finally { close(f); close(expected); }
  }
});

test.each(["q3dm1", ""])("connection screen reads real session gamestate, including explicit empty map %s", async map => {
  const f = await baseFixture(320, 240), expected = await baseFixture(320, 240), lifecycle = new ProtocolClientLifecycle(f.cvars);
  const client = new EngineClientSession({ product: "baseq3", cvars: f.cvars, lifecycle, mode: { kind: "network", challenge: 17, qport: 27961 } });
  try {
    await client.receiveServerMessage(1, encodeServerMessage(0, [{ kind: "gamestate", commandSequence: 0, clientNumber: 0, checksumFeed: 19,
      entries: [{ kind: "configstring", index: 0, value: map === "" ? "" : `\\mapname\\${map}` }, { kind: "configstring", index: 1, value: "\\sv_serverid\\100\\sv_cheats\\1" }] }],
    { product: "baseq3", messageNumber: 1, reliableSequence: 0, serverCommandSequence: 0, parseEntitiesNumber: 0, baseline: () => null, history: () => null }));
    lifecycle.clientStatic.servername = "localhost"; lifecycle.clientStatic.phase = "loading";
    const screen = new BaseConnectScreen(f.state);
    await screen.draw(true, lifecycle.clientStatic, lifecycle.clientConnection, client);
    await cacheMenu(expected.state);
    drawProportional(expected.state, 320, 16, `Loading ${map}`, UI_BIGFONT | UI_CENTER | UI_DROPSHADOW, COLORS.white);
    heading(expected, true, "localhost", ""); equalPixels(f, expected);
    expect(lifecycle.gamestates).toEqual([1]);
    await expect(screen.draw(true, lifecycle.clientStatic, new ClientConnectionState(), client)).rejects.toThrow("actual client states");
  } finally { lifecycle.close(); close(f); close(expected); }
});

test("cache precedes client-state reads and retirement stops drawing", async () => {
  const f = await baseFixture(), expected = await baseFixture(), cls = new ClientStaticState(), connection = new ClientConnectionState();
  try {
    cls.phase = "connecting";
    const register = f.resources.registerShaderNoMip.bind(f.resources);
    f.resources.registerShaderNoMip = async path => { const shader = await register(path); connection.connectPacketCount = 7; cls.servername = "after-cache"; return shader; };
    await new BaseConnectScreen(f.state).draw(false, cls, connection, null);
    expect(f.registrations.some(value => value === "shader:gfx/2d/bigchars")).toBe(true);
    await cacheMenu(expected.state); heading(expected, false, "after-cache", "");
    drawProportional(expected.state, 320, 128, "Awaiting challenge...7", center, COLORS.white);
    equalPixels(f, expected);
    f.state.retire(); await expect(new BaseConnectScreen(f.state).draw(false, cls, connection, null)).rejects.toThrow("retired");
  } finally { close(f); close(expected); }
});

test("download arithmetic exposes the source small-size division error instead of inventing an ETA", async () => {
  const f = await baseFixture(), cls = new ClientStaticState();
  try {
    cls.phase = "connected"; f.state.realtime = 2000;
    f.cvars.set("cl_downloadName", "bad.pk3"); f.cvars.set("cl_downloadSize", "1");
    f.cvars.set("cl_downloadCount", "4096"); f.cvars.set("cl_downloadTime", "1000");
    await expect(new BaseConnectScreen(f.state).draw(false, cls, new ClientConnectionState(), null)).rejects.toThrow("integer division");
  } finally { close(f); }
});
