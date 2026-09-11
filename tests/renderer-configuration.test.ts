// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { CommonError } from "../src/core/common-error.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { EngineClient } from "../src/engine/client.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { ServerEngine } from "../src/engine/server-engine.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { loadGl } from "../src/platform/gl.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { decodeConnectionless, encodeConnectionlessText } from "../src/protocol/connectionless.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { ClientReliableCommands } from "../src/protocol/reliable.ts";
import { emptyRendererConfiguration, printRendererGfxInfo, RendererConfiguration } from "../src/render/configuration.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SOURCE_COMMAND_RELEASE32, SOURCE_RENDER_COMMAND } from "../src/render/command-memory.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer, sourceGlCapabilities } from "../src/render/gl/renderer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import type { CvarSnapshot } from "../src/core/cvar.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";

async function preSdlClientFixture(onPrint: (text: string) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "q3-pre-sdl-registration-"));
  const dataPath = join(root, "data"), homePath = join(root, "home");
  mkdirSync(join(dataPath, "baseq3"), { recursive: true });
  writeFileSync(join(dataPath, "baseq3", "default.cfg"), "set registration_fixture 1\n");
  writeFileSync(join(dataPath, "baseq3", "productid.txt"), SOURCE_PRODUCT_ID);
  const printed: string[] = [], clock = { milliseconds: () => 0 }, stdin = new PassThrough();
  const print = (text: string): undefined => { printed.push(text); onPrint(text); };
  const client = new EngineClient({ renderer: "cpu", width: 320, height: 240, hidden: true,
    sound: { sampleRate: 48000 }, buildDate: "pre-sdl-registration", systemClock: clock });
  const adopted: CommonConsole[] = [], random = new LinuxNativeRandom(1), loopback = new LoopbackTransport();
  const io = new UnixIo(print, clock, { stdin, signals: "none" });
  let server: ServerEngine | null = null;
  const close = async (): Promise<void> => {
    try { await client.disposeResources(); }
    finally {
      try { await server?.disposeResources(); }
      finally {
        io.close(); stdin.destroy();
        for (const common of adopted) common.close();
        rmSync(root, { recursive: true });
      }
    }
  };
  try {
    const common = await CommonConsole.open({ roots: { dataPath, homePath, cdPath: null, product: "baseq3" },
      startup: new StartupCommands(""), random, build: { kind: "client", client }, platformPrint: print,
      resolveCommand: () => undefined, assertCommandEntry: () => {}, assertOwnerEntry: () => {},
    }, owner => { adopted.push(owner); });
    common.registerRuntimeCvars("pre-sdl-registration", async () => {});
    const events = new CommonEvents({ getEvent: () => { throw new Error("Pre-SDL fixture must not poll system input"); } }, print);
    server = ServerEngine.create({ common, buildDate: "pre-sdl-registration", clock: events, random,
      bots: { kind: "unavailable", reason: "Pre-SDL renderer registration" }, clientLifecycle: { kind: "absent" },
      network: { loopback, udp: null, lan: io.lan,
        resolveAddress: async () => { throw new Error("Pre-SDL fixture must not resolve network addresses"); },
        sleep: async () => { throw new Error("Pre-SDL fixture must not wait on network input"); } },
    });
    client.bind({ common, events, loopback, io, server, assertCurrentOperation: () => {},
      runRendererCallback: callback => callback(),
      pumpForDownloadsComplete: async () => { throw new Error("Pre-SDL fixture must not download"); } });
    await client.initialize();
    common.markInitialized();
    printed.length = 0;
    return { client, common, printed, loopback, close };
  } catch (error) { await close(); throw error; }
}

test("selected Unix extension names use source case-insensitive substrings, not core or ARB env-add promotion", () => {
  expect(sourceGlCapabilities("GL_ARB_texture_env_add", 8)).toEqual({ textureUnits: 1, textureEnvAdd: false });
  expect(sourceGlCapabilities("gl_arb_MULTITEXTURE_suffix GL_EXT_texture_env_add", 8)).toEqual({ textureUnits: 8, textureEnvAdd: true });
  expect(sourceGlCapabilities("", 8)).toEqual({ textureUnits: 1, textureEnvAdd: false });
});

describe("pre-SDL client lifecycle", () => {
  test("initialization clears the retained active allocation before client commands execute", async () => {
    const f = await preSdlClientFixture();
    try {
      await f.client.shutdown();
      const active = f.client.clientActive;
      active.gameState.modify(0, "previous map");
      active.setUserCmdValue(7, 2); active.serverId = 123; active.time = 456;
      let commandCalls = 0;
      f.common.commands.register("inspect_client_init", () => {
        commandCalls++;
        expect(f.client.clientActive).toBe(active);
        expect(active.getConfigString(0)).toBeNull();
        expect(active.getSourceGameState().dataCount).toBe(0);
        expect([active.userCmdValue, active.sensitivity, active.serverId, active.time]).toEqual([0, 0, 0, 0]);
        expect(f.client.clientStatic.phase).toBe("disconnected");
      });
      f.common.commands.append("inspect_client_init\n");
      await f.client.initialize();
      expect(commandCalls).toBe(1);
    } finally { await f.close(); }
  });

  test("disconnect command clears single-player mode before its phase-dependent error", async () => {
    const f = await preSdlClientFixture();
    try {
      f.common.cvars.set("ui_singlePlayerActive", "1", true);
      f.common.commands.executeNow("disconnect");
      expect(f.common.cvars.get("ui_singlePlayerActive")?.value).toBe("0");
      expect(f.client.clientStatic.phase).toBe("disconnected");
      f.client.clientStatic.phase = "active";
      f.common.cvars.set("ui_singlePlayerActive", "1", true);
      expect(() => f.common.commands.executeNow("disconnect")).toThrow(new CommonError("disconnect", "Disconnected from server"));
      expect(f.common.cvars.get("ui_singlePlayerActive")?.value).toBe("0");
      expect(f.client.clientStatic.phase).toBe("active");
    } finally { await f.close(); }
  });

  test("local map loading preserves the connect cvar and sends one in-memory admission request", async () => {
    const f = await preSdlClientFixture();
    try {
      f.common.cvars.set("cl_currentServerAddress", "previous.example:27961", true);
      f.common.cvars.set("nextmap", "cinematic intro.RoQ", true);
      await f.client.mapLoading();
      expect(f.client.clientStatic.phase).toBe("challenging");
      expect(f.client.clientStatic.servername).toBe("localhost");
      expect(f.common.cvars.get("cl_currentServerAddress")?.value).toBe("previous.example:27961");
      expect(f.common.cvars.get("nextmap")?.value).toBe("");
      expect(f.printed.some(text => text.includes("resolved to"))).toBe(false);
      const connect = f.loopback.poll("server");
      if (connect === null) throw new Error("Local map loading did not send its admission request");
      expect(decodeConnectionless(connect.payload, "server").command).toBe("connect");
      expect(f.loopback.poll("server")).toBeNull();
      await f.client.packetEvent({ kind: "loopback" }, encodeConnectionlessText("connectResponse"));
      f.client.clientActive.gameState.modify(0, "previous map");
      f.client.clientActive.time = 456;
      f.client.clientStatic.updateInfoString = "previous update";
      await f.client.mapLoading();
      expect(f.client.clientStatic.phase).toBe("connected");
      expect(f.client.clientStatic.updateInfoString).toBe("");
      expect(f.client.clientActive.getConfigString(0)).toBeNull();
      expect(f.client.clientActive.time).toBe(456);
      expect(f.loopback.poll("server")).toBeNull();
    } finally { await f.close(); }
  });

  test("the retained localhost name clears gameState during cinematic map loading without a session", async () => {
    const f = await preSdlClientFixture();
    try {
      f.client.clientStatic.servername = "LOCALHOST";
      f.client.clientStatic.phase = "cinematic";
      f.client.clientActive.gameState.modify(0, "previous map");
      f.client.clientActive.time = 456;
      await f.client.mapLoading();
      expect(f.client.clientStatic).toMatchObject({ phase: "connected" });
      expect(f.client.clientActive.getSourceGameState().dataCount).toBe(0);
      expect(f.client.clientActive.time).toBe(456);
      expect(f.loopback.poll("server")).toBeNull();
    } finally { await f.close(); }
  });

  test("video restart uses the disconnected reliable ring and reports its overflow as a source drop", async () => {
    const f = await preSdlClientFixture();
    const rings: ClientReliableCommands[] = [], add = ClientReliableCommands.prototype.add;
    const reliable = spyOn(ClientReliableCommands.prototype, "add").mockImplementation(function (this: ClientReliableCommands, text) {
      rings.push(this); return add.call(this, text);
    });
    const open = spyOn(SdlWindow, "open").mockImplementation(() => { throw new Error("Pre-SDL lifecycle test unexpectedly reached SDL"); });
    try {
      f.common.cvars.set("r_maxpolys", "10000000");
      await expect(f.common.commands.executeNowAsync("vid_restart")).rejects.toThrow("Hunk_Alloc failed");
      expect(reliable.mock.calls).toEqual([["vdr"]]);
      expect(reliable.mock.results[0]).toEqual({ type: "return", value: { sequence: 1, text: "vdr" } });
      expect(f.client.clientStatic.phase).toBe("disconnected");
      const ring = rings[0];
      if (ring === undefined) throw new Error("Video restart did not reach the client reliable ring");
      for (let command = 0; command < 64; command++) ring.add("pending");
      expect(ring.sequence).toBe(65);
      await expect(f.common.commands.executeNowAsync("vid_restart")).rejects.toMatchObject({
        name: "CommonError", code: "drop", message: "Client command overflow",
      });
      expect(ring.sequence).toBe(65);
      expect(open).not.toHaveBeenCalled();
    } finally { open.mockRestore(); reliable.mockRestore(); await f.close(); }
  });
});

describe("pre-SDL demo commands", () => {
  test("usage returns before a kill request, and valid playback publishes the request before disconnect", async () => {
    const f = await preSdlClientFixture();
    const disconnected: (number | undefined)[] = [];
    const disconnect = f.client.disconnect.bind(f.client);
    const disconnectSpy = spyOn(f.client, "disconnect").mockImplementation(async showMainMenu => {
      disconnected.push(f.common.cvars.get("sv_killserver")?.integerValue);
      await disconnect(showMainMenu);
    });
    const shutdown = spyOn(ServerEngine.prototype, "shutdownFromCommand");
    try {
      await f.common.commands.executeNowAsync("demo");
      expect(f.printed).toEqual(["playdemo <demoname>\n"]);
      expect(f.common.cvars.get("sv_killserver")?.integerValue).toBe(0);
      expect(disconnected).toEqual([]);
      await expect(f.common.commands.executeNowAsync("demo missing.dm_68")).rejects.toThrow("couldn't open demos/missing.dm_68");
      expect(disconnected).toEqual([1]);
      expect(shutdown).not.toHaveBeenCalled();
      expect(f.client.clientStatic.phase).toBe("disconnected");
    } finally { shutdown.mockRestore(); disconnectSpy.mockRestore(); await f.close(); }
  });

  test("completion reports timedemo and runs the next command without a renderer memory flush", async () => {
    const f = await preSdlClientFixture();
    const milliseconds = spyOn(CommonEvents.prototype, "milliseconds").mockReturnValue(1250);
    const flush = spyOn(f.client, "flushMemory").mockImplementation(async () => {
      throw new Error("Demo completion must not flush renderer memory");
    });
    try {
      const file = f.common.files.writable.openBinaryWrite("demos/complete.dm_68");
      if (file === null) throw new Error("Could not write the empty demo fixture");
      file.writeBytes(new Uint8Array(8).fill(255)); file.close();
      let nextCommands = 0;
      f.common.commands.register("demo_next", () => {
        expect(f.common.cvars.get("nextdemo")?.value).toBe("");
        expect(f.client.clientStatic.phase).toBe("disconnected");
        nextCommands++;
      });
      f.common.cvars.set("timedemo", "1", true);
      f.common.cvars.set("developer", "0.5", true);
      f.common.cvars.set("nextdemo", "demo_next", true);
      await f.common.commands.executeNowAsync("demo complete.dm_68");
      expect(f.printed).toContain("0 frames, 1.2 seconds: 0.0 fps\n");
      expect(f.printed.some(text => text.startsWith("CL_NextDemo:"))).toBe(false);
      expect(nextCommands).toBe(1);
      expect(flush).not.toHaveBeenCalled();
      f.common.cvars.set("timedemo", "0", true);
      f.common.cvars.set("developer", "1", true);
      f.printed.length = 0;
      await f.common.commands.executeNowAsync("demo complete.dm_68");
      expect(f.printed).toContain("CL_NextDemo: \n");
      expect(nextCommands).toBe(1);
      expect(flush).not.toHaveBeenCalled();
    } finally { flush.mockRestore(); milliseconds.mockRestore(); await f.close(); }
  });

  test("nextdemo keeps its accepted text when the separate newline append overflows", async () => {
    const f = await preSdlClientFixture();
    const flush = spyOn(f.client, "flushMemory").mockImplementation(async () => {
      throw new Error("Demo completion must not flush renderer memory");
    });
    try {
      const file = f.common.files.writable.openBinaryWrite("demos/complete.dm_68");
      if (file === null) throw new Error("Could not write the empty demo fixture");
      file.writeBytes(new Uint8Array(8).fill(255)); file.close();
      const next = "demo_next", wait = "wait 1\n";
      const remainder = "x".repeat(16383 - next.length - wait.length);
      f.common.commands.append(wait + remainder);
      f.common.cvars.set("nextdemo", next, true);
      await f.common.commands.executeNowAsync("demo complete.dm_68");
      expect(f.common.commands.pendingText).toBe(remainder + next);
      expect(f.common.cvars.get("nextdemo")?.value).toBe("");
      expect(f.printed).toContain("Cbuf_AddText: overflow\n");
      expect(flush).not.toHaveBeenCalled();
    } finally { flush.mockRestore(); await f.close(); }
  });
});

describe("pre-SDL renderer registration", () => {
  test("real hunk exhaustion preserves registered commands, source-zero lists and shutdown ordering", async () => {
    let rejectShutdown = false;
    const failure = new Error("shutdown prefix failed");
    const f = await preSdlClientFixture(text => { if (rejectShutdown && text === "RE_Shutdown( 0 )\n") throw failure; });
    const open = spyOn(SdlWindow, "open").mockImplementation(() => { throw new Error("Pre-SDL test unexpectedly reached SDL"); });
    const fileExists = spyOn(f.common.files.writable, "fileExists");
    try {
      f.common.cvars.set("r_maxpolys", "10000000");
      await expect(f.client.startHunkUsers()).rejects.toThrow("Hunk_Alloc failed");
      const names = ["imagelist", "shaderlist", "skinlist", "modellist", "modelist", "screenshot", "screenshotJPEG", "gfxinfo"];
      expect(f.common.commands.registeredNames().slice(0, 8)).toEqual([...names].reverse());
      expect(f.printed[0]).toBe("----- R_Init -----\n");
      f.printed.length = 0;
      f.common.commands.executeNow("shaderlist");
      f.common.commands.executeNow("skinlist");
      f.common.commands.executeNow("modellist");
      expect(f.printed).toEqual(["-----------------------\n", "0 total shaders\n", "------------------\n",
        "------------------\n", "------------------\n", "       0 : Total models\n"]);
      f.printed.length = 0;
      f.common.commands.executeNow("gfxinfo");
      expect(f.printed).toContain("\nGL_VENDOR: \n");
      expect(f.printed).toContain("MODE: 0, 0 x 0 windowed hz:");
      expect(f.printed).toContain("GAMMA: software w/ 0 overbright bits\n");
      f.common.commands.executeNow("modelist");
      f.common.commands.executeNow("imagelist");
      expect(() => f.common.commands.executeNow("screenshot levelshot")).toThrow("requires a loaded renderer world");
      expect(fileExists).not.toHaveBeenCalled();
      expect(() => f.common.commands.executeNow("screenshot")).toThrow("R_GetCommandBuffer requires allocated backEndData");
      expect(() => f.common.commands.executeNow("screenshotJPEG")).toThrow("R_GetCommandBuffer requires allocated backEndData");
      expect(fileExists.mock.calls).toEqual([["screenshots/shot0000.tga"], ["screenshots/shot0000.jpg"]]);
      f.common.commands.register("shaderstate", () => {});
      rejectShutdown = true;
      await expect(f.client.shutdownAllForServerMap()).rejects.toThrow(failure);
      for (const name of [...names, "shaderstate"]) expect(f.common.commands.registeredNames()).toContain(name);
      rejectShutdown = false;
      await f.client.shutdownAllForServerMap();
      for (const name of [...names, "shaderstate"]) expect(f.common.commands.registeredNames()).not.toContain(name);
      await expect(f.client.startHunkUsers()).rejects.toThrow("Hunk_Alloc failed");
      for (const name of names) expect(f.common.commands.registeredNames()).toContain(name);
      expect(() => f.common.commands.executeNow("screenshot")).toThrow("R_GetCommandBuffer requires allocated backEndData");
      expect(fileExists.mock.calls.at(-1)).toEqual(["screenshots/shot0001.tga"]);
      await f.client.shutdown();
      expect(f.printed).toContain("RE_Shutdown( 1 )\n");
      f.printed.length = 0;
      await f.client.shutdown();
      expect(f.printed.some(text => text.startsWith("RE_Shutdown("))).toBe(false);
      expect(open).not.toHaveBeenCalled();
    } finally { fileExists.mockRestore(); open.mockRestore(); await f.close(); }
  });

  test("screenshots publish into allocated command bytes before SDL and discard partial startup on restart", async () => {
    const f = await preSdlClientFixture();
    const failure = new Error("stop before SDL opens");
    const open = spyOn(SdlWindow, "open").mockImplementation(() => { throw failure; });
    try {
      f.common.cvars.set("r_mode", "3");
      await expect(f.client.startHunkUsers()).rejects.toThrow(failure);
      const backend = f.common.hunk.accounting.rendererBackend(0);
      if (backend === null) throw new Error("R_Init did not allocate its actual backend storage");
      f.printed.length = 0;
      f.common.commands.executeNow("screenshot");
      f.common.commands.executeNow("screenshotJPEG early-jpeg");
      const bytes = backend.commandsData();
      expect(bytes.getInt32(SOURCE_COMMAND_RELEASE32.capacity, true)).toBe(56);
      for (const offset of [0, 28]) {
        expect(bytes.getInt32(offset, true)).toBe(SOURCE_RENDER_COMMAND.screenshot);
        expect(bytes.getInt32(offset + 12, true)).toBe(640);
        expect(bytes.getInt32(offset + 16, true)).toBe(480);
      }
      expect(bytes.getInt32(24, true)).toBe(0);
      expect(bytes.getInt32(52, true)).toBe(1);
      expect(f.printed).toEqual(["Wrote screenshots/shot0000.tga\n", "Wrote screenshots/early-jpeg.jpg\n"]);
      await f.client.shutdownAllForServerMap();
      expect(f.common.files.writable.fileExists("screenshots/shot0000.tga")).toBe(false);
      expect(f.common.files.writable.fileExists("screenshots/early-jpeg.jpg")).toBe(false);
      expect(bytes.getInt32(SOURCE_COMMAND_RELEASE32.capacity, true)).toBe(56);
      f.common.commands.append("vid_restart\n");
      await expect(f.common.commands.executeAsync()).rejects.toThrow(failure);
      const restarted = f.common.hunk.accounting.rendererBackend(0);
      if (restarted === null) throw new Error("Restart did not allocate its actual backend storage");
      expect(restarted).not.toBe(backend);
      expect(restarted.commandsData().getInt32(SOURCE_COMMAND_RELEASE32.capacity, true)).toBe(0);
      f.printed.length = 0;
      f.common.commands.executeNow("screenshot");
      expect(f.printed).toEqual(["Wrote screenshots/shot0001.tga\n"]);
    } finally { open.mockRestore(); await f.close(); }
  });

  test("registration failure preserves only the reached command prefix until source shutdown", async () => {
    const failure = new Error("registration diagnostic failed");
    const f = await preSdlClientFixture(text => { if (text === "Cmd_AddCommand: skinlist already defined\n") throw failure; });
    const open = spyOn(SdlWindow, "open").mockImplementation(() => { throw new Error("Pre-SDL test unexpectedly reached SDL"); });
    try {
      f.common.commands.register("skinlist", () => {});
      await expect(f.client.startHunkUsers()).rejects.toThrow(failure);
      expect(f.common.commands.registeredNames().slice(0, 4)).toEqual(["shaderlist", "imagelist", "toggle_renderer", "skinlist"]);
      for (const name of ["modellist", "modelist", "screenshot", "screenshotJPEG", "gfxinfo"])
        expect(f.common.commands.registeredNames()).not.toContain(name);
      expect(f.common.hunk.accounting.rendererBackend(0)).toBeNull();
      await f.client.shutdownAllForServerMap();
      for (const name of ["shaderlist", "imagelist", "toggle_renderer", "skinlist"]) expect(f.common.commands.registeredNames()).not.toContain(name);
      expect(open).not.toHaveBeenCalled();
    } finally { open.mockRestore(); await f.close(); }
  });

  test("duplicate command registration diagnoses at its source row and preserves the existing handler", async () => {
    const f = await preSdlClientFixture();
    const open = spyOn(SdlWindow, "open").mockImplementation(() => { throw new Error("Pre-SDL test unexpectedly reached SDL"); });
    try {
      let oldCalls = 0;
      f.common.commands.register("skinlist", () => { oldCalls++; });
      f.common.cvars.set("r_maxpolys", "10000000");
      await expect(f.client.startHunkUsers()).rejects.toThrow("Hunk_Alloc failed");
      expect(f.printed).toContain("Cmd_AddCommand: skinlist already defined\n");
      for (const name of ["imagelist", "shaderlist", "skinlist", "modellist", "modelist", "screenshot", "screenshotJPEG", "gfxinfo"])
        expect(f.common.commands.registeredNames()).toContain(name);
      f.common.commands.executeNow("skinlist");
      expect(oldCalls).toBe(1);
      expect(open).not.toHaveBeenCalled();
    } finally { open.mockRestore(); await f.close(); }
  });

  test("gfxinfo before image initialization reads live cvars without applying color mappings", () => {
    const cvars = new CvarRegistry();
    cvars.set("r_gamma", "0.1"); cvars.set("r_intensity", "0.5"); cvars.set("r_textureMode", "INVALID");
    new RegisteredRendererCvars(cvars, "linux");
    const chunks: string[] = [];
    printRendererGfxInfo(cvars, { configuration: () => emptyRendererConfiguration("gl"), overbrightBits: () => 0,
      assertCurrent: () => {} }, text => {
      chunks.push(text);
      if (text === "rendering primitives: ") cvars.set("r_primitives", "2");
    });
    expect(chunks).toEqual(["\nGL_VENDOR: \n", "GL_RENDERER: \n", "GL_VERSION: \n", "GL_EXTENSIONS: \n",
      "GL_MAX_TEXTURE_SIZE: 0\n", "GL_MAX_ACTIVE_TEXTURES_ARB: 0\n", "\nPIXELFORMAT: color(0-bits) Z(0-bit) stencil(0-bits)\n",
      "MODE: 3, 0 x 0 fullscreen hz:", "N/A\n", "GAMMA: software w/ 0 overbright bits\n", "CPU: \n",
      "rendering primitives: ", "single glDrawElements\n", "texturemode: INVALID\n", "picmip: 1\n", "texture bits: 0\n",
      "multitexture: disabled\n", "compiled vertex arrays: disabled\n", "texenv add: disabled\n", "compressed textures: disabled\n"]);
    expect(cvars.get("r_gamma")?.value).toBe("0.1");
    expect(cvars.get("r_intensity")?.value).toBe("0.5");
    expect(cvars.get("r_textureMode")?.value).toBe("INVALID");
  });

  test("gfxinfo keeps reached output and sys_cpustring registration on every callback failure", () => {
    for (let boundary = 1; boundary <= 20; boundary++) {
      const cvars = new CvarRegistry(); new RegisteredRendererCvars(cvars, "linux");
      let printed = 0, active = true;
      const failure = new Error(`retired at print ${boundary}`);
      expect(() => printRendererGfxInfo(cvars, { configuration: () => emptyRendererConfiguration("cpu"), overbrightBits: () => 0,
        assertCurrent: () => { if (!active) throw failure; } }, () => { if (++printed === boundary) active = false; })).toThrow(failure);
      expect(printed).toBe(boundary);
      expect(cvars.get("sys_cpustring")).toMatchObject({ value: "", flags: CvarFlag.None });
    }
  });
});

function cpuFixture(cvars = new CvarRegistry(), print: (text: string) => void = text => { process.stdout.write(text); }) {
  const registered = new RegisteredRendererCvars(cvars, "linux", null, print);
  const window = SdlWindow.open({ title: "Q3 configuration", width: 48, height: 32, backend: "cpu", hidden: true });
  const renderer = new SoftwareRenderer(48, 32, new RendererImageCatalog());
  const settings = new SourceRendererSettings(registered, renderer.capabilities);
  const target = new RenderTarget(renderer.images, [renderer]);
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
    tess: new SourceTessState(), runtime: settings.runtime });
  return { window, renderer, settings, cvars, target, commands,
    create: (): RendererConfiguration => RendererConfiguration.create({ window, renderer: { kind: "cpu", backend: renderer }, settings }),
    close: (): void => { target.close(); window.close(); },
  };
}

function glFixture() {
  const cvars = new CvarRegistry(), registered = new RegisteredRendererCvars(cvars, "linux");
  const window = SdlWindow.open({ title: "Q3 GL frame errors", width: 8, height: 8, backend: "gl", hidden: true });
  const renderer = new GlRenderer(window, new RendererImageCatalog()), native = loadGl(window);
  const target = new RenderTarget(renderer.images, [renderer]);
  const settings = new SourceRendererSettings(registered, renderer.capabilities);
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
    tess: new SourceTessState(), runtime: settings.runtime });
  const config = RendererConfiguration.create({ window, renderer: { kind: "gl", backend: renderer }, settings });
  config.beginFrame(commands);
  return { cvars, window, renderer, commands, config, gl: native.symbols,
    close: (): void => { config.close(); native.close(); target.close(); window.close(); },
  };
}

describe("actual renderer configuration", () => {
  test("gfxinfo prints source call boundaries with actual CPU configuration and current cvars", () => {
    const f = cpuFixture();
    try {
      const config = f.create(), output: string[] = [];
      f.cvars.set("r_mode", "-42", true); f.cvars.set("r_fullscreen", "2", true);
      f.cvars.set("r_picmip", "4", true); f.cvars.set("r_texturebits", "16", true);
      f.cvars.set("r_overBrightBits", "2", true);
      f.cvars.set("r_vertexLight", "-1", true); f.cvars.set("r_finish", "-2", true);
      f.cvars.set("r_textureMode", "GL_NEAREST");
      config.printGfxInfo(f.cvars, text => {
        output.push(text);
        expect(f.cvars.get("sys_cpustring")).toMatchObject({ value: "", flags: CvarFlag.None });
      });
      const frequency = f.window.display.refreshRate;
      expect(output).toEqual([
        "\nGL_VENDOR: Quake III TypeScript port\n", "GL_RENDERER: Quake III TypeScript CPU rasterizer\n",
        "GL_VERSION: CPU implementation\n", "GL_EXTENSIONS: \n", "GL_MAX_TEXTURE_SIZE: N/A (CPU renderer)\n",
        "GL_MAX_ACTIVE_TEXTURES_ARB: 2\n", "\nPIXELFORMAT: color(24-bits) Z(64-bit) stencil(0-bits)\n",
        "MODE: -42, 48 x 32 windowed hz:", frequency !== 0 ? `${frequency}\n` : "N/A\n",
        "GAMMA: software w/ 0 overbright bits\n", "CPU: \n", "rendering primitives: ", "CPU array-element triangle strips\n",
        "texturemode: GL_NEAREST\n", "picmip: 4\n", "texture bits: 16\n", "multitexture: enabled\n",
        "compiled vertex arrays: disabled\n", "texenv add: disabled\n", "compressed textures: disabled\n",
        "HACK: using vertex lightmap approximation\n", "Forcing glFinish\n",
      ]);
      expect(f.renderer.images.textureFilter).toBe("linear-mipmap-nearest");
      expect(f.cvars.get("r_primitives")?.integerValue).toBe(0);
      config.close();
    } finally { f.close(); }
  });

  test("gfxinfo samples primitive selection after its prefix and preserves invalid-value print boundaries", () => {
    const f = cpuFixture();
    try {
      const config = f.create();
      const cases: readonly (readonly [number, string | null])[] = [[0, "CPU array-element triangle strips\n"],
        [1, "CPU array-element triangle strips\n"], [2, "CPU indexed triangles\n"], [3, "CPU discrete-element triangle strips\n"], [-1, "none\n"], [7, null]];
      for (const [value, expected] of cases) {
        const output: string[] = [];
        f.cvars.set("r_primitives", "2");
        config.printGfxInfo(f.cvars, text => { output.push(text); if (text === "rendering primitives: ") f.cvars.set("r_primitives", String(value)); });
        const index = output.indexOf("rendering primitives: ");
        expect(index).toBe(11);
        expect(output[index + 1]).toBe(expected ?? "texturemode: GL_LINEAR_MIPMAP_NEAREST\n");
      }
      config.close();
    } finally { f.close(); }
  });

  test("gfxinfo registers the CPU string before printing, consumes its latch, and reads later values after callbacks", () => {
    const f = cpuFixture();
    try {
      f.cvars.register("sys_cpustring", "old CPU", CvarFlag.Latch);
      f.cvars.set("sys_cpustring", "pending CPU");
      const config = f.create(), output: string[] = [];
      config.printGfxInfo(f.cvars, text => {
        output.push(text);
        if (text.startsWith("\nGL_VENDOR:")) {
          expect(f.cvars.get("sys_cpustring")).toMatchObject({ value: "pending CPU", latchedValue: undefined });
          f.cvars.set("sys_cpustring", "current CPU", true);
          f.cvars.set("r_mode", "99", true); f.cvars.set("r_fullscreen", "1", true);
          f.cvars.set("r_allowExtensions", "0", true);
        }
        if (text === "rendering primitives: ") f.cvars.set("r_textureMode", "invalid current filter");
        if (text.startsWith("texturemode:")) f.cvars.set("r_picmip", "6", true);
        if (text.startsWith("picmip:")) f.cvars.set("r_texturebits", "32", true);
        if (text === "compressed textures: disabled\n") f.cvars.set("r_vertexLight", "2", true);
        if (text === "HACK: using vertex lightmap approximation\n") f.cvars.set("r_finish", "1");
      });
      expect(output).toContain("MODE: 99, 48 x 32 fullscreen hz:");
      expect(config.copy().isFullscreen).toBe(false);
      expect(output).toContain("CPU: current CPU\n");
      expect(output.slice(13)).toEqual(["texturemode: invalid current filter\n", "picmip: 6\n", "texture bits: 32\n",
        "multitexture: enabled\n", "compiled vertex arrays: disabled\n", "texenv add: disabled\n",
        "compressed textures: disabled\n", "HACK: using vertex lightmap approximation\n", "Forcing glFinish\n"]);
      config.close();
    } finally { f.close(); }
  });

  test("gfxinfo uses current integer mode fields without applying latched requests", () => {
    const f = cpuFixture();
    try {
      const config = f.create();
      for (const fullscreen of ["-1", "0", "0.5", "1", "1.5", "2", "invalid"]) {
        f.cvars.set("r_fullscreen", fullscreen, true);
        f.cvars.set("r_mode", "invalid", true); f.cvars.set("r_mode", "11");
        f.cvars.set("r_vertexLight", "0.5", true); f.cvars.set("r_finish", "0.5");
        const output: string[] = [];
        config.printGfxInfo(f.cvars, text => { output.push(text); });
        expect(output[7]).toBe(`MODE: 0, 48 x 32 ${fullscreen === "1" || fullscreen === "1.5" ? "fullscreen" : "windowed"} hz:`);
        expect(f.cvars.get("r_mode")).toMatchObject({ value: "invalid", latchedValue: "11" });
        expect(output).toHaveLength(20);
      }
      config.close();
    } finally { f.close(); }
  });

  test("gfxinfo rejects closed owners and stops at every print callback that retires its configuration", () => {
    const f = cpuFixture();
    try {
      f.cvars.set("r_vertexLight", "1", true); f.cvars.set("r_finish", "1");
      for (let boundary = 1; boundary <= 22; boundary++) {
        const config = f.create();
        let printed = 0;
        expect(() => config.printGfxInfo(f.cvars, () => {
          printed++;
          if (printed === boundary) config.close();
        })).toThrow("Renderer configuration is closed");
        expect(printed).toBe(boundary);
        expect(() => config.printGfxInfo(f.cvars, () => { throw new Error("must not print"); })).toThrow("Renderer configuration is closed");
      }
    } finally { f.close(); }
  });

  test("gfxinfo propagates print failures and detects an SDL window retired by a callback", () => {
    const f = cpuFixture();
    try {
      const config = f.create(), failure = new Error("print failed");
      expect(() => config.printGfxInfo(f.cvars, () => { throw failure; })).toThrow(failure);
      expect(config.copy().backend).toBe("cpu");
      let printed = 0;
      expect(() => config.printGfxInfo(f.cvars, () => { printed++; f.window.close(); })).toThrow("Renderer configuration is closed");
      expect(printed).toBe(1);
      config.close();
    } finally { f.close(); }
  });

  test("lends the live GL error setting while standalone catalogs retain the source default", () => {
    const cvars = new CvarRegistry(); cvars.set("r_ignoreGLErrors", "0");
    const f = cpuFixture(cvars);
    try {
      expect(f.renderer.images.ignoreGLErrors).toBe(true);
      const config = f.create();
      expect(f.renderer.images.ignoreGLErrors).toBe(false);
      cvars.set("r_ignoreGLErrors", "-1"); expect(f.renderer.images.ignoreGLErrors).toBe(true);
      cvars.set("r_ignoreGLErrors", "0.5"); expect(f.renderer.images.ignoreGLErrors).toBe(false);
      expect(new RendererImageCatalog().ignoreGLErrors).toBe(true);
      config.close();
    } finally { f.close(); }
  });

  test("lends the live binding cvar before initialization texture work", () => {
    const cvars = new CvarRegistry(), observed: boolean[] = [];
    cvars.set("r_nobind", "1"); cvars.set("r_textureMode", "invalid");
    const f = cpuFixture(cvars, () => {
      observed.push(f.renderer.images.noBind);
      cvars.set("r_nobind", "0");
    });
    try {
      expect(f.renderer.images.noBind).toBe(false);
      const config = f.create();
      expect(observed).toEqual([true, false]);
      cvars.set("r_nobind", "-1"); expect(f.renderer.images.noBind).toBe(true);
      cvars.set("r_nobind", "0.5"); expect(f.renderer.images.noBind).toBe(false);
      expect(new RendererImageCatalog().noBind).toBe(false);
      config.close();
    } finally { f.close(); }
  });

  test("startup visits both enabled texture units and rereads mode after warning callbacks", () => {
    for (const multitexture of [false, true]) {
      for (const fixFromWarning of [false, true]) {
        const cvars = new CvarRegistry();
        cvars.set("r_ext_multitexture", multitexture ? "1" : "0"); cvars.set("r_textureMode", "invalid");
        cvars.set("r_intensity", "0.5");
        const warnings: string[] = [];
        const f = cpuFixture(cvars, text => {
            warnings.push(text);
            expect(cvars.get("r_intensity")?.numericValue).toBe(0.5);
            if (fixFromWarning) cvars.set("r_textureMode", "GL_NEAREST");
        });
        try {
          const settings = f.settings;
          const config = RendererConfiguration.create({ window: f.window, renderer: { kind: "cpu", backend: f.renderer }, settings });
          expect(warnings).toEqual(multitexture && !fixFromWarning ? ["bad filter name\n", "bad filter name\n"] : ["bad filter name\n"]);
          expect(f.renderer.images.textureFilter).toBe(multitexture && fixFromWarning ? "nearest" : "linear-mipmap-nearest");
          expect(cvars.get("r_intensity")?.numericValue).toBe(1);
          expect(cvars.get("r_textureMode")?.modified).toBe(true);
          config.close();
        } finally { f.close(); }
      }
    }
  });

  test("drains queued drawing before mode mutation, then clears gamma before rebuilding retained tables", () => {
    const events: string[] = [];
    class TraceCvars extends CvarRegistry {
      observe: () => string = () => "initializing";
      override clearModified(name: string): void {
        events.push(`clear ${name}: ${this.observe()}`); super.clearModified(name);
      }
      override set(name: string, value: string, force = false): CvarSnapshot {
        if (name === "r_intensity") events.push(`intensity: ${this.observe()}`);
        return super.set(name, value, force);
      }
    }
    const cvars = new TraceCvars(), f = cpuFixture(cvars);
    try {
      const config = f.create(); config.beginFrame(f.commands);
      const before = config.imageUploadProfile();
      expect(before).toMatchObject({ picmip: 1, roundImagesDown: true, simpleMipMaps: true, colorMipLevels: false,
        textureBits: 0, textureCompression: "none", maxTextureSize: null,
        colorMappings: { deviceSupportsGamma: false, overbrightBits: 0, identityLight: 1, identityLightByte: 255 } });
      cvars.observe = () => `${f.renderer.pixels[0]} ${f.renderer.images.textureFilter} ${cvars.get("r_textureMode")?.modified} ${cvars.get("r_gamma")?.modified}`;
      f.commands.addView({ viewport: { x: 0, y: 0, width: 48, height: 32 },
        clear: { color: { x: 1, y: 0, z: 0, w: 1 }, depth: 1, stencil: false }, operations: [] });
      cvars.set("r_textureMode", "gl_nearest"); cvars.set("r_gamma", "2"); events.length = 0;
      expect(f.renderer.pixels[0]).toBe(0);
      config.beginFrame(f.commands);
      expect(events).toEqual(["clear r_measureOverdraw: 0 linear-mipmap-nearest true true",
        "clear r_textureMode: 255 nearest true true", "clear r_gamma: 255 nearest false true", "intensity: 255 nearest false false"]);
      const after = config.imageUploadProfile();
      expect(after.colorMappings).not.toBe(before.colorMappings);
      expect(before.colorMappings.gammaTable[64]).toBe(64);
      expect(after.colorMappings.gammaTable[64]).toBe(128);
      expect(f.commands.submit()).toEqual({ commands: 1, views: 0, batches: 0 });
      config.beginFrame(f.commands);
      expect(config.imageUploadProfile().colorMappings).toBe(after.colorMappings);
      config.close(); expect(() => config.imageUploadProfile()).toThrow("closed");
    } finally { f.close(); }
  });

  test("bad texture mode warns after the real drain and clears its flag before gamma", () => {
    const warnings: string[] = [];
    const f = cpuFixture(undefined, text => {
        warnings.push(text);
        expect(f.renderer.pixels[1]).toBe(255);
        expect(f.cvars.get("r_textureMode")?.modified).toBe(true);
        expect(f.cvars.get("r_gamma")?.modified).toBe(true);
    });
    try {
      const settings = f.settings;
      const config = RendererConfiguration.create({ window: f.window, renderer: { kind: "cpu", backend: f.renderer }, settings });
      config.beginFrame(f.commands);
      f.commands.addView({ viewport: { x: 0, y: 0, width: 48, height: 32 },
        clear: { color: { x: 0, y: 1, z: 0, w: 1 }, depth: 1, stencil: false }, operations: [] });
      f.cvars.set("r_textureMode", "invalid"); f.cvars.set("r_gamma", "1.5");
      config.beginFrame(f.commands);
      expect(warnings).toEqual(["bad filter name\n"]);
      expect(f.renderer.images.textureFilter).toBe("linear-mipmap-nearest");
      expect(f.cvars.get("r_textureMode")?.modified).toBe(false);
      expect(f.cvars.get("r_gamma")?.modified).toBe(false);
      config.close();
    } finally { f.close(); }
  });

  test("startup mode uses the real catalog and foreign command targets are rejected", () => {
    const cvars = new CvarRegistry(); cvars.set("r_textureMode", "GL_LINEAR_MIPMAP_LINEAR");
    const f = cpuFixture(cvars), other = cpuFixture();
    try {
      const config = f.create();
      expect(f.renderer.images.textureFilter).toBe("linear-mipmap-linear");
      expect(cvars.get("r_textureMode")?.modified).toBe(true);
      expect(() => config.beginFrame(other.commands)).toThrow("own image command target");
      config.close();
    } finally { f.close(); other.close(); }
  });

  test("retains the selected custom aspect independently of the drawable ratio", () => {
    const f = cpuFixture();
    try {
      const config = RendererConfiguration.create({ window: f.window, renderer: { kind: "cpu", backend: f.renderer },
        settings: f.settings, windowAspect: Math.fround(1.17) });
      expect(config.copy()).toMatchObject({ vidWidth: 48, vidHeight: 32, windowAspect: Math.fround(1.17) });
      config.close();
    } finally { f.close(); }
  });
  test("copies CPU facts without inventing a GL texture limit or hardware gamma", () => {
    const f = cpuFixture();
    try {
      const config = f.create(), first = config.copy(), second = config.copy();
      expect(first).toMatchObject({ backend: "cpu", driverType: "cpu", maxTextureSize: null, depthStorage: "binary64",
        colorBits: 24, depthBits: 64, stencilBits: 0, stereoEnabled: false, smpActive: false,
        maxActiveTextures: 2, textureEnvAddAvailable: false, textureCompression: "none",
        vidWidth: 48, vidHeight: 32, windowAspect: Math.fround(1.5), isFullscreen: false,
        deviceSupportsGamma: false, gamma: { kind: "unavailable" },
      });
      expect(first.displayFrequency).toBe(f.window.display.refreshRate);
      expect(first.rendererString).toBe("Quake III TypeScript CPU rasterizer");
      expect(first.extensionsString).toBe("");
      expect(second).toEqual(first); expect(second).not.toBe(first); expect(second.gamma).not.toBe(first.gamma);
      config.close();
      expect(first.vidWidth).toBe(48);
      expect(() => config.copy()).toThrow("closed");
      config.close();
    } finally { f.close(); }
  });

  test("published extension decisions use initialized source cvars, not raw hardware support", () => {
    const cvars = new CvarRegistry(); cvars.set("r_allowExtensions", "0", true);
    const f = cpuFixture(cvars);
    try {
      const config = f.create();
      expect(f.renderer.capabilities.textureUnits).toBe(2);
      expect(config.copy()).toMatchObject({ maxActiveTextures: 0, textureEnvAddAvailable: false });
      cvars.set("r_allowExtensions", "1", true);
      expect(config.copy().maxActiveTextures).toBe(0);
      config.close();
    } finally { f.close(); }
  });

  test("rejects mismatched actual dimensions and capabilities before acquiring gamma", () => {
    const f = cpuFixture(), wrong = new SoftwareRenderer(12, 12, new RendererImageCatalog());
    try {
      expect(() => RendererConfiguration.create({ window: f.window, renderer: { kind: "cpu", backend: wrong }, settings: f.settings })).toThrow("dimensions");
      const settings = new SourceRendererSettings(new RegisteredRendererCvars(new CvarRegistry(), "linux"), { textureUnits: 8, textureEnvAdd: true });
      expect(() => RendererConfiguration.create({ window: f.window, renderer: { kind: "cpu", backend: f.renderer }, settings })).toThrow("capabilities");
      f.create().close();
    } finally { wrong.close(); f.close(); }
  });

  test("concrete gamma lease excludes other owners and stale close cannot close a replacement", () => {
    const f = cpuFixture(), other = cpuFixture();
    try {
      const first = f.window.beginGamma();
      expect(first.capability.kind).toBe("unavailable");
      expect(() => other.window.beginGamma()).toThrow("already has an owner");
      expect(() => first.apply(1)).toThrow("unavailable");
      for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 0.49, 3.01]) expect(() => first.apply(invalid)).toThrow(RangeError);
      first.close();
      const second = other.window.beginGamma();
      first.close(); f.close();
      expect(second.closed).toBe(false);
      expect(() => first.apply(1)).toThrow("closed");
      second.close();
    } finally { other.close(); f.close(); }
  });

  test("window destruction invalidates borrowed configuration and releases the concrete owner", () => {
    const f = cpuFixture(), other = cpuFixture();
    try {
      const config = f.create(); f.window.close();
      expect(() => config.copy()).toThrow("closed"); expect(() => config.beginFrame(f.commands)).toThrow("closed");
      const replacement = other.create(); config.close();
      expect(replacement.copy().backend).toBe("cpu"); replacement.close();
    } finally { other.close(); f.close(); }
  });

  test("source gamma registration, forced clamp, and modified consumption also run without device support", () => {
    const cvars = new CvarRegistry(); cvars.register("r_gamma", "5", CvarFlag.ReadOnly);
    const f = cpuFixture(cvars);
    try {
      const config = f.create();
      expect(cvars.get("r_gamma")).toMatchObject({ value: "3.0", numericValue: 3, flags: CvarFlag.ReadOnly | CvarFlag.Archive, modified: true });
      config.beginFrame(f.commands); expect(cvars.get("r_gamma")?.modified).toBe(false);
      cvars.set("r_gamma", "0.25", true); config.beginFrame(f.commands);
      expect(cvars.get("r_gamma")).toMatchObject({ value: "0.5", numericValue: 0.5, modified: true });
      config.beginFrame(f.commands); expect(cvars.get("r_gamma")?.modified).toBe(false);
      cvars.set("r_gamma", "1.25", true); config.beginFrame(f.commands);
      expect(cvars.get("r_gamma")).toMatchObject({ numericValue: 1.25, modified: false });
      cvars.set("r_gamma", "inf", true); config.beginFrame(f.commands);
      expect(cvars.get("r_gamma")?.value).toBe("3.0");
      cvars.set("r_gamma", "-inf", true); config.beginFrame(f.commands);
      expect(cvars.get("r_gamma")?.value).toBe("0.5");
      config.close();
    } finally { f.close(); }
  });

  test("source clears modified before actual renderer synchronization", () => {
    const f = cpuFixture();
    try {
      const config = f.create(); config.beginFrame(f.commands); f.renderer.close();
      config.beginFrame(f.commands);
      f.commands.addView({ viewport: { x: 0, y: 0, width: 48, height: 32 }, clear: { color: null, depth: 1, stencil: false }, operations: [] });
      f.cvars.set("r_gamma", "1.2");
      expect(() => config.beginFrame(f.commands)).toThrow("CPU renderer is closed");
      expect(f.cvars.get("r_gamma")?.modified).toBe(false);
      config.close();
    } finally { f.close(); }
  });

  test("failed scalar initialization releases the lease for a corrected actual cvar", () => {
    const cvars = new CvarRegistry(); cvars.set("r_gamma", "nan");
    const f = cpuFixture(cvars);
    try {
      expect(() => f.create()).toThrow("NaN gamma");
      cvars.set("r_gamma", "1"); f.create().close();
    } finally { f.close(); }
  });
});

describe.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("native GL configuration", () => {
  test("gfxinfo prints actual GL driver limits and retained extension decisions", () => {
    const f = glFixture();
    try {
      const output: string[] = [];
      f.cvars.set("r_allowExtensions", "0", true);
      f.cvars.set("r_primitives", "-1");
      f.config.printGfxInfo(f.cvars, text => { output.push(text); });
      expect(output.slice(0, 7)).toEqual([
        `\nGL_VENDOR: ${f.renderer.driver.vendor}\n`, `GL_RENDERER: ${f.renderer.driver.renderer.replace(/\n$/, "")}\n`,
        `GL_VERSION: ${f.renderer.driver.version}\n`, `GL_EXTENSIONS: ${f.renderer.extensions.slice(0, 8191)}\n`,
        `GL_MAX_TEXTURE_SIZE: ${f.renderer.maxTextureSize}\n`, `GL_MAX_ACTIVE_TEXTURES_ARB: ${f.renderer.capabilities.textureUnits}\n`,
        `\nPIXELFORMAT: color(${f.renderer.colorBits}-bits) Z(${f.renderer.depthBits}-bit) stencil(${f.renderer.stencilBits}-bits)\n`,
      ]);
      expect(output.slice(11, 13)).toEqual(["rendering primitives: ", "none\n"]);
      expect(output).toContain(`compiled vertex arrays: ${f.renderer.compiledVertexArrays ? "enabled" : "disabled"}\n`);
      expect(output).toContain("multitexture: enabled\n");
      expect(output).toContain("texenv add: disabled\n");
      expect(output).toHaveLength(20);
    } finally { f.close(); }
  });

  test("default and nonzero error settings retain native errors and do not drain queued commands", () => {
    const f = glFixture();
    try {
      let drains = 0;
      for (const ignored of ["1", "-2"]) {
        f.cvars.set("r_ignoreGLErrors", ignored);
        f.gl.glEnable(0xffffffff);
        f.commands.submitFrame(); f.window.swap();
        f.commands.addPreparedViews(() => { drains++; return []; });
        const before = drains;
        f.config.beginFrame(f.commands);
        expect(drains).toBe(before);
        expect(f.gl.glGetError()).toBe(0x500);
        expect(f.commands.submit().commands).toBe(1);
        expect(drains).toBe(before + 1);
      }
    } finally { f.close(); }
  });

  test("enabled checking drains older drawing before one fatal source error, even if that drain changes the cvar", () => {
    const f = glFixture();
    try {
      f.cvars.set("r_ignoreGLErrors", "0.5");
      f.commands.addPreparedViews(() => {
        f.cvars.set("r_ignoreGLErrors", "1");
        f.gl.glEnable(0xffffffff);
        return [{ viewport: { x: 0, y: 0, width: 8, height: 8 },
          clear: { color: { x: 1, y: 0, z: 0, w: 1 }, depth: 1, stencil: false }, operations: [] }];
      });
      expect(() => f.config.beginFrame(f.commands)).toThrow(new CommonError("fatal", "RE_BeginFrame() - glGetError() failed (0x500)!\n"));
      expect(Array.from(f.renderer.readPixels().slice(0, 4))).toEqual([255, 0, 0, 255]);
      expect(f.cvars.get("r_ignoreGLErrors")?.value).toBe("1");
      expect(f.commands.submit().commands).toBe(0);
      expect(f.gl.glGetError()).toBe(0);
      f.cvars.set("r_ignoreGLErrors", "0");
      expect(() => f.config.beginFrame(f.commands)).not.toThrow();
    } finally { f.close(); }
  });

  test("samples the live error gate after texture mode and gamma work", () => {
    const f = glFixture();
    try {
      const before = f.config.imageUploadProfile().colorMappings;
      f.commands.addPreparedViews(() => {
        expect(f.cvars.get("r_textureMode")?.modified).toBe(true);
        expect(f.cvars.get("r_gamma")?.modified).toBe(true);
        f.cvars.set("r_ignoreGLErrors", "0");
        f.gl.glEnable(0xffffffff);
        return [];
      });
      f.cvars.set("r_textureMode", "GL_NEAREST"); f.cvars.set("r_gamma", "2");
      let failure: unknown;
      try { f.config.beginFrame(f.commands); } catch (error: unknown) { failure = error; }
      expect(failure).toBeInstanceOf(CommonError);
      if (!(failure instanceof CommonError)) throw new Error("Missing native renderer failure");
      expect(failure.code).toBe("fatal");
      expect(failure.message).toBe("RE_BeginFrame() - glGetError() failed (0x500)!\n");
      expect(f.cvars.get("r_textureMode")?.modified).toBe(false);
      expect(f.cvars.get("r_gamma")?.modified).toBe(false);
      expect(f.renderer.images.textureFilter).toBe("nearest");
      const after = f.config.imageUploadProfile().colorMappings;
      expect(after).not.toBe(before); expect(after.gammaTable[64]).toBe(128);
      expect(f.gl.glGetError()).toBe(0);
    } finally { f.close(); }
  });

  test("copies this context's driver and framebuffer facts, with hidden gamma unavailable", () => {
    const registered = new RegisteredRendererCvars(new CvarRegistry(), "other");
    const window = SdlWindow.open({ title: "Q3 GL configuration", width: 48, height: 32, backend: "gl", hidden: true });
    const renderer = new GlRenderer(window, new RendererImageCatalog());
    try {
      const settings = new SourceRendererSettings(registered, renderer.capabilities);
      const config = RendererConfiguration.create({ window, renderer: { kind: "gl", backend: renderer }, settings });
      expect(config.imageUploadProfile().maxTextureSize).toBe(renderer.maxTextureSize);
      expect(config.imageUploadProfile().colorMappings.deviceSupportsGamma).toBe(false);
      expect(config.copy()).toMatchObject({ backend: "gl", driverType: "icd", maxTextureSize: renderer.maxTextureSize, depthStorage: "driver",
        rendererString: renderer.driver.renderer.replace(/\n$/, ""), vendorString: renderer.driver.vendor, versionString: renderer.driver.version,
        extensionsString: renderer.extensions.slice(0, 8191), colorBits: renderer.colorBits, depthBits: renderer.depthBits,
        stencilBits: renderer.stencilBits, stereoEnabled: renderer.stereoEnabled, maxActiveTextures: renderer.capabilities.textureUnits,
        textureEnvAddAvailable: renderer.capabilities.textureEnvAdd, deviceSupportsGamma: false, gamma: { kind: "unavailable" },
      });
      expect(renderer.colorBits).toBeGreaterThan(0); expect(renderer.depthBits).toBeGreaterThan(0);
      config.close();
    } finally { renderer.close(); window.close(); }
  });
});

// This opt-in may issue display gamma calls. Run only under a newly isolated Xvfb,
// never against the user's desktop. API acceptance is not physical readback proof.
describe.skipIf(process.env["QUAKE_ISOLATED_GAMMA_TEST"] !== "1")("isolated focused gamma API", () => {
  for (const kind of ["cpu", "gl"] satisfies readonly ("cpu" | "gl")[]) {
    test(`${kind} measures actual focused SDL capability and owns initialization/frame/close`, async () => {
      const cvars = new CvarRegistry(), registered = new RegisteredRendererCvars(cvars, "linux");
      const window = SdlWindow.open({ title: "Q3 isolated gamma", width: 48, height: 32, backend: kind });
      const images = new RendererImageCatalog();
      const renderer = kind === "cpu"
        ? { kind, backend: new SoftwareRenderer(48, 32, images) }
        : { kind, backend: new GlRenderer(window, images) };
      const target = new RenderTarget(images, [renderer.backend]);
      try {
        for (let attempt = 0; attempt < 100 && (window.flags & 0x200) === 0; attempt++) { window.pollEvents(); await Bun.sleep(10); }
        expect(window.flags & 0x200).not.toBe(0); expect(window.display.count).toBe(1);
        const settings = new SourceRendererSettings(registered, renderer.backend.capabilities);
        const config = RendererConfiguration.create({ window, renderer, settings }), capability = config.gammaCapability;
        expect(["unsupported", "api-accepted"]).toContain(capability.kind);
        if (capability.kind === "unsupported") expect(capability.reason).toMatch(/SDL_(Get|Set)WindowGammaRamp:/);
        expect(config.copy().deviceSupportsGamma).toBe(capability.kind === "api-accepted");
        console.info(`${kind} isolated gamma: ${JSON.stringify(capability)}`);
        const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
          tess: new SourceTessState(), runtime: settings.runtime });
        cvars.set("r_gamma", "1.2"); config.beginFrame(commands); expect(cvars.get("r_gamma")?.modified).toBe(false);
        config.close();
        const replacement = RendererConfiguration.create({ window, renderer, settings }); replacement.close();
      } finally { target.close(); window.close(); }
    });
  }
});
