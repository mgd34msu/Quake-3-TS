// Actual client video lifecycle from cl_main.c and Linux GLW_SetMode.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ClientHost } from "../src/engine/client-host.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { vec3 } from "../src/core/math.ts";
import { ClientInput } from "../src/engine/client-input.ts";
import { ClientKeys } from "../src/engine/client-keys.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { EngineConsole } from "../src/engine/console.ts";
import { encodeDemo } from "../src/protocol/demo.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { Snapshot, SnapshotHistoryEntry } from "../src/protocol/server-message.ts";
import { RenderCommandBuffer } from "../src/render/commands.ts";
import { RendererConfiguration } from "../src/render/configuration.ts";
import { MoveType } from "../src/shared/definitions.ts";
import { EntityState } from "../src/shared/entity-state.ts";
import { PlayerStateRecord } from "../src/shared/player-state.ts";
import { BaseUi } from "../src/ui/base/ui.ts";
import { TeamArenaUi } from "../src/ui/team-arena/ui.ts";

const dataPath = process.env["Q3_DATA"];
const fullscreenProbe = process.env["QUAKE_VIDEO_FULLSCREEN_TEST"] === "1" && process.env["SDL_VIDEODRIVER"] === "x11";

async function open(renderer: "cpu" | "gl", startup: string, stdin: PassThrough, hidden = true, output: string[] = [],
  product: "baseq3" | "missionpack" = "baseq3"): Promise<ClientHost> {
  if (dataPath === undefined) throw new Error("Q3_DATA is required for the actual client video probe");
  return ClientHost.open({
    roots: { dataPath, homePath: await mkdtemp(join(tmpdir(), "quake3-client-video-")), cdPath: null, product },
    startupText: "+set net_ip 127.0.0.1 +set net_port 0 +set cl_motd 0 +set s_initsound 0 +set bot_enable 0 +set ui_cdkeychecked 1 "
      + startup + " +echo video-client-probe",
    buildDate: "video-client-probe", print: text => { output.push(text); if (process.env["QUAKE_VIDEO_TRACE"] === "1") process.stderr.write(text); return undefined; },
    bots: { kind: "unavailable", reason: "Video lifecycle probe does not use bots" },
    video: { renderer, width: 320, height: 240, hidden }, sound: { sampleRate: 48000 },
    input: { stdin, signals: "none" },
  });
}

async function frame(host: ClientHost): Promise<void> {
  const result = await host.frame();
  if (result.kind !== "frame") throw new Error(`Client frame failed: ${JSON.stringify(result)}`);
}

for (const renderer of ["cpu", "gl"] satisfies readonly ("cpu" | "gl")[]) {
  test.skipIf(dataPath === undefined)(`actual ${renderer} product menu switches both games after played matches`, async () => {
    if (dataPath === undefined) throw new Error("Q3_DATA is required");
    const current: { ui: BaseUi | TeamArenaUi | null } = { ui: null };
    const baseInitialize = BaseUi.prototype.initialize, teamInitialize = TeamArenaUi.prototype.initialize;
    const baseSpy = spyOn(BaseUi.prototype, "initialize").mockImplementation(async function(this: BaseUi) {
      current.ui = this; await baseInitialize.call(this);
    });
    const teamSpy = spyOn(TeamArenaUi.prototype, "initialize").mockImplementation(async function(this: TeamArenaUi) {
      current.ui = this; await teamInitialize.call(this);
    });
    const stdin = new PassThrough(), output: string[] = [];
    const homePath = await mkdtemp(join(tmpdir(), `quake3-product-${renderer}-`));
    let host: ClientHost | null = null;
    try {
      host = await ClientHost.open({
        roots: { dataPath, homePath, cdPath: dataPath, product: "baseq3" },
        startupText: "+set net_ip 127.0.0.1 +set net_port 0 +set cl_motd 0 +set s_initsound 0 +set bot_enable 0 "
          + "+set ui_cdkeychecked 1 +set in_mouse 0 +set in_joystick 0 +set r_ignorehwgamma 1 +set r_fullscreen 0 "
          + "+set r_mode 0 +set com_maxfps 0 +set fixedtime 50 +echo product-switch",
        buildDate: "product-switch", print: text => { output.push(text); }, bots: { kind: "source" },
        video: { renderer, width: 320, height: 240, hidden: true }, sound: { sampleRate: 48000 },
        input: { stdin, signals: "none" },
      });
      const owner = host;
      async function play(map: string, product: "baseq3" | "missionpack"): Promise<void> {
        owner.common.commands.append(`map ${map}\n`);
        for (let index = 0; index < 60; index++) {
          await frame(owner);
          if (owner.client.clientStatic.phase === "active") break;
        }
        expect(owner.client.clientStatic.phase).toBe("active");
        expect(owner.common.roots.product).toBe(product);
        expect(owner.client.clientActive.history.readCurrentPlayerState()?.product).toBe(product);
        const server = owner.server.state;
        expect(server.kind).toBe("running");
        if (server.kind !== "running") throw new Error("Switched product did not start its server");
        expect(server.world.product).toBe(product);
        owner.common.commands.append("+forward\n");
        for (let index = 0; index < 5; index++) await frame(owner);
        owner.common.commands.append("-forward\n");
        for (let index = 0; index < 15; index++) await frame(owner);
        owner.common.commands.append(`screenshot product-${product}\n`);
        await frame(owner);
      }
      async function leaveMatch(): Promise<void> {
        owner.common.commands.append("disconnect\n");
        const result = await owner.frame();
        expect(result.kind).toBe("aborted");
        if (result.kind !== "aborted") throw new Error("Disconnect did not reach common error recovery");
        expect(result.code).toBe("disconnect");
        await frame(owner);
      }
      await play("q3dm1", "baseq3");
      await leaveMatch();
      owner.common.commands.registerAsync("switch_to_ta", async () => {
        const ui = current.ui;
        if (!(ui instanceof BaseUi)) throw new Error("Base UI is not active");
        expect(ui.state.activeMenu).toBe(ui.main.menu);
        await ui.mouseEvent(320 - ui.state.cursorX, 317 - ui.state.cursorY);
        await ui.keyEvent(KeyCode.Mouse1, true); await ui.keyEvent(KeyCode.Mouse1, false);
      });
      owner.common.commands.append("switch_to_ta\n");
      await frame(owner);
      expect(current.ui instanceof TeamArenaUi).toBe(true);
      expect(owner.common.cvars.get("fs_game")?.value).toBe("missionpack");
      for (let index = 0; index < 20; index++) await frame(owner);
      owner.common.commands.append("screenshot team-arena-menu\n"); await frame(owner);
      await play("mpteam1", "missionpack");
      await leaveMatch();
      owner.common.commands.registerAsync("switch_to_base", async () => {
        const ui = current.ui;
        if (!(ui instanceof TeamArenaUi)) throw new Error("Team Arena UI is not active");
        await ui.mouseEvent(160 - ui.menus.cursorX, 55 - ui.menus.cursorY);
        await ui.mouseEvent(0, 0);
        await ui.keyEvent(KeyCode.Mouse1, true); await ui.keyEvent(KeyCode.Mouse1, false);
        expect(owner.common.cvars.get("fs_game")?.value).toBe("missionpack");
        await ui.mouseEvent(294 - ui.menus.cursorX, 255 - ui.menus.cursorY);
        await ui.keyEvent(KeyCode.Mouse1, true); await ui.keyEvent(KeyCode.Mouse1, false);
      });
      owner.common.commands.append("switch_to_base\n");
      await frame(owner);
      expect(current.ui instanceof BaseUi).toBe(true);
      expect(owner.common.cvars.get("fs_game")?.value).toBe("");
      owner.common.commands.append("screenshot quake3-menu\n"); await frame(owner);
      await play("q3dm1", "baseq3");
      process.stdout.write(`Product-switch screenshots: ${homePath}\n`);
    } catch (error) {
      process.stderr.write(output.join("")); throw error;
    } finally {
      await host?.close(); stdin.destroy(); baseSpy.mockRestore(); teamSpy.mockRestore();
    }
  }, 120000);
}

test.skipIf(dataPath === undefined)("actual client snapshot zero supplies centerview and notifications after entity history expires", async () => {
  const sessions: EngineClientSession[] = [], inputs: ClientInput[] = [], keyOwners: ClientKeys[] = [];
  const glyphs: string[] = [];
  let captureNotify = false, drawingConsole = false;
  const receive = EngineClientSession.prototype.receiveServerMessage;
  const receiveSpy = spyOn(EngineClientSession.prototype, "receiveServerMessage").mockImplementation(async function(this: EngineClientSession, ...args) {
    const result = await receive.apply(this, args);
    if (!sessions.includes(this)) sessions.push(this);
    return result;
  });
  const initializeInput = ClientInput.prototype.initializeCommands;
  const inputSpy = spyOn(ClientInput.prototype, "initializeCommands").mockImplementation(function(this: ClientInput) {
    inputs.push(this); return initializeInput.call(this);
  });
  const drawConsole = EngineConsole.prototype.draw;
  const consoleSpy = spyOn(EngineConsole.prototype, "draw").mockImplementation(function(this: EngineConsole, drawing) {
    if (!(drawing.keys instanceof ClientKeys)) throw new Error("Actual console did not borrow engine keys");
    if (!keyOwners.includes(drawing.keys)) keyOwners.push(drawing.keys);
    drawingConsole = true;
    try { return drawConsole.call(this, drawing); } finally { drawingConsole = false; }
  });
  const stretch = RenderCommandBuffer.prototype.stretchPixels;
  const stretchSpy = spyOn(RenderCommandBuffer.prototype, "stretchPixels").mockImplementation(function(this: RenderCommandBuffer, rect, uv, picture) {
    if (captureNotify && drawingConsole && uv.s === 10 / 16 && uv.t === 5 / 16) glyphs.push(`${rect.x},${rect.y},${rect.width},${rect.height}`);
    return stretch.call(this, rect, uv, picture);
  });
  const stdin = new PassThrough();
  let host: ClientHost | null = null;
  try {
    host = await open("cpu", "+set r_mode 0 +set r_fullscreen 0 +map q3dm1", stdin);
    for (let count = 0; count < 40 && host.client.clientStatic.phase !== "active"; count++) await frame(host);
    expect(host.client.clientStatic.phase).toBe("active");
    const network = sessions.at(-1), input = inputs.at(-1), keys = keyOwners.at(-1);
    if (network === undefined || input === undefined || keys === undefined) throw new Error("Actual engine owners were not reached");
    const current = host;
    current.common.commands.registerAsync("prepare_snapshot_zero_demo", async () => {
      const gamestate = network.copyGamestate(), latest = network.snapshots.current();
      const snapshot = network.snapshots.read(latest.number);
      if (snapshot === null) throw new Error("Actual source snapshot was not retained");
      const playerState = new PlayerStateRecord<number, number, number>(snapshot.playerState.product, 0, 0, 0);
      playerState.copyFrom(snapshot.playerState);
      playerState.deltaAngles = vec3(-8192, 0, 0); playerState.pmType = MoveType.PM_INTERMISSION;
      const context = (messageNumber: number) => ({ product: network.product, messageNumber, reliableSequence: 0,
        serverCommandSequence: gamestate.commandSequence, parseEntitiesNumber: 0, baseline: () => null, history: () => null });
      const demo = encodeDemo([
        { kind: "message", sequence: -1, payload: encodeServerMessage(0, [gamestate], context(-1)) },
        { kind: "message", sequence: 0, payload: encodeServerMessage(0, [{ kind: "snapshot", validity: { kind: "valid" },
          snapshot: { ...snapshot, messageNumber: 0, serverTime: 1000, deltaNumber: -1, parseEntitiesNumber: 0,
            playerState, entities: [] } }], context(0)) },
      ]);
      const directory = join(current.common.roots.homePath, "baseq3/demos");
      await mkdir(directory, { recursive: true }); await writeFile(join(directory, "snapshot-zero.dm_68"), demo);
      current.common.commands.append("set cl_freezeDemo 1\ndemo snapshot-zero.dm_68\n");
    });
    current.common.commands.append("prepare_snapshot_zero_demo\n");
    for (let count = 0; count < 8; count++) {
      await frame(host);
      const current = sessions.at(-1);
      if (current?.mode.kind === "demo" && current.snapshots.read(0) !== null && host.client.clientStatic.phase === "active") break;
    }
    const observedPlayback = sessions.at(-1);
    if (observedPlayback === undefined || observedPlayback.mode.kind !== "demo") throw new Error("Actual engine demo session was not created");
    const playback = observedPlayback;
    expect(playback.snapshots.current()).toEqual({ number: 0, serverTime: 1000 });
    expect(playback.snapshots.read(0)?.playerState.pmType).toBe(MoveType.PM_INTERMISSION);
    expect(playback.snapshots.read(0)?.playerState.deltaAngles.x).toBe(57344);
    const zero = playback.snapshots.read(0);
    if (zero === null) throw new Error("Actual zero snapshot did not publish");
    current.common.commands.register("snapshot_zero_notify", () => {
      keys.setCatcher(KeyCatcher.Ui);
      current.client.consolePrint("Z");
    });
    captureNotify = true;
    current.common.commands.append("clear\nsnapshot_zero_notify\ncenterview\n");
    await frame(current);
    expect({ pitch: input.viewAngles.x, glyphs }).toEqual({ pitch: -315, glyphs: ["8,0,8,16"] });
    for (const number of [0, 10]) {
      const name = `expire_snapshot_entities_${number}`;
      current.common.commands.registerAsync(name, async () => {
        async function receive(snapshot: Snapshot, old: SnapshotHistoryEntry | null): Promise<void> {
          const bytes = encodeServerMessage(0, [{ kind: "snapshot", validity: { kind: "valid" }, snapshot }], {
            product: playback.product, messageNumber: snapshot.messageNumber, reliableSequence: 0,
            serverCommandSequence: playback.serverCommandSequence, parseEntitiesNumber: 0, baseline: () => null, history: () => old,
          });
          await playback.receiveServerMessage(snapshot.messageNumber, bytes);
        }
        if (number !== 0) await receive({ ...zero, messageNumber: number }, null);
        const missing = { ...zero, messageNumber: number + 1, entities: [] };
        const entities = Array.from({ length: 512 }, (_, index) => { const entity = new EntityState(); entity.number = index + 1; return entity; });
        for (let offset = 2; offset < 6; offset++) {
          await receive({ ...zero, messageNumber: number + offset, deltaNumber: missing.messageNumber, entities },
            { status: "valid", snapshot: missing });
        }
        expect(playback.snapshots.read(number)).toBeNull();
      });
      captureNotify = false;
      current.common.commands.append(`${name}\n`);
      await frame(current);
      expect(playback.snapshots.current().number).toBe(number);
      expect(playback.snapshots.read(number)).toBeNull();
      glyphs.length = 0; captureNotify = true;
      current.common.commands.append("clear\nsnapshot_zero_notify\ncenterview\n");
      await frame(current);
      // Con_Clear_f leaves the preceding diagnostic rows' notify timestamps intact.
      expect({ pitch: input.viewAngles.x, glyphs }).toEqual({ pitch: -315, glyphs: ["8,48,8,16"] });
    }
  } finally {
    captureNotify = false;
    try { await host?.close(); }
    finally { stretchSpy.mockRestore(); consoleSpy.mockRestore(); inputSpy.mockRestore(); receiveSpy.mockRestore(); stdin.destroy(); }
  }
}, 120000);

for (const renderer of ["cpu", "gl"] satisfies readonly ("cpu" | "gl")[]) {
  for (const product of ["baseq3", "missionpack"] satisfies readonly ("baseq3" | "missionpack")[]) {
    test.skipIf(dataPath === undefined || (renderer === "gl" && process.env["QUAKE_GL_TEST"] !== "1"))(
      `actual ${product} ${renderer} final disposal closes a poisoned renderer without replaying queued work`, async () => {
        const created: Parameters<typeof RendererConfiguration.beginInitialization>[0][] = [], configurations: RendererConfiguration[] = [];
        const queues: RenderCommandBuffer[] = [], create = RendererConfiguration.beginInitialization, beginFrame = RendererConfiguration.prototype.beginFrame;
        const configSpy = spyOn(RendererConfiguration, "beginInitialization").mockImplementation(options => {
          const configuration = create(options); created.push(options); configurations.push(configuration); return configuration;
        });
        const beginSpy = spyOn(RendererConfiguration.prototype, "beginFrame").mockImplementation(function(this: RendererConfiguration, commands) {
          queues.push(commands); beginFrame.call(this, commands);
        });
        const stdin = new PassThrough();
        let host: ClientHost | null = null;
        try {
          host = await open(renderer, "+set r_mode 0 +set r_fullscreen 0 +set r_textureMode GL_NEAREST", stdin, true, [], product);
          const current = host;
          await frame(current);
          const first = created.at(-1);
          if (first === undefined) throw new Error("Missing initial renderer");
          expect(first.renderer.backend.images.textureFilter).toBe("nearest");
          current.common.commands.append("set r_textureMode invalid-restart-filter\nvid_restart\n");
          await frame(current);
          const second = created.at(-1), configuration = configurations.at(-1), commands = queues.at(-1);
          if (second === undefined || configuration === undefined || commands === undefined) throw new Error("Missing restarted renderer owners");
          expect(second.renderer.backend.images).not.toBe(first.renderer.backend.images);
          expect(first.window.closed).toBe(true);
          expect(second.renderer.backend.images.textureFilter).toBe("nearest");
          const backendClose = spyOn(second.renderer.backend, "close"), targetClose = spyOn(commands.target, "close");
          const configurationClose = spyOn(configuration, "close"), commandsClose = spyOn(commands, "close");
          try {
            const failure = new RangeError("Client presentation failed"), calls = { failed: 0, abandoned: 0 };
            commands.addPreparedViews(() => { calls.failed++; throw failure; });
            commands.addPreparedViews(() => { calls.abandoned++; return []; });
            const sourceFailure = await current.frame().catch((error: unknown) => error);
            if (!(sourceFailure instanceof AggregateError)) throw new Error("Expected the original frame error and source shutdown failure");
            expect(sourceFailure.cause).toBe(failure);
            expect(() => second.renderer.backend.images.textureFilter).toThrow("poisoned");
            await current.close();
            expect(calls).toEqual({ failed: 1, abandoned: 0 });
            expect(second.window.closed).toBe(true);
            expect(current.client.input).toBeNull();
            expect(() => second.renderer.backend.finish()).toThrow("renderer is closed");
            expect(() => configuration.copy()).toThrow("Renderer configuration is closed");
            await current.close();
            expect(backendClose).toHaveBeenCalledTimes(1);
            expect(targetClose).toHaveBeenCalledTimes(1);
            expect(configurationClose).toHaveBeenCalledTimes(1);
            expect(commandsClose).toHaveBeenCalledTimes(1);
            expect(commandsClose).toHaveBeenCalledWith("discard");
          } finally {
            commandsClose.mockRestore(); configurationClose.mockRestore(); targetClose.mockRestore(); backendClose.mockRestore();
          }
        } finally {
          try { await host?.close(); }
          finally { beginSpy.mockRestore(); configSpy.mockRestore(); stdin.destroy(); }
        }
      }, 120000);
  }

  test.skipIf(dataPath === undefined || (renderer === "gl" && process.env["QUAKE_GL_TEST"] !== "1"))(
    `actual ${renderer} resource commands use current owners across vid_restart and unregister on shutdown`, async () => {
      const created: Parameters<typeof RendererConfiguration.beginInitialization>[0][] = [], output: string[] = [];
      const create = RendererConfiguration.beginInitialization;
      const configSpy = spyOn(RendererConfiguration, "beginInitialization").mockImplementation(options => { created.push(options); return create(options); });
      const stdin = new PassThrough();
      let host: ClientHost | null = null;
      try {
        host = await open(renderer, "+set r_mode 0 +set r_fullscreen 0 +set r_picmip 0", stdin, true, output);
        await frame(host);
        const current = host, first = created.at(-1);
        if (first === undefined) throw new Error("Missing initial renderer");
        expect(output.some(text => text.startsWith("\nGL_VENDOR:"))).toBe(true);
        async function resourceLists(): Promise<void> {
          output.length = 0;
          current.common.commands.append("shaderlist\nshaderlist sorted\nskinlist\nmodellist\nmodelist\ngfxinfo\n");
          await frame(current);
          const text = output.join("");
          expect(text).toContain(": <default>\n");
          expect(text).toContain("  0:<default skin>\n");
          expect(text).toContain("        = <default>\n");
          expect(text).toContain(" : Total models\n");
          expect(text).toContain("Mode  0: 320x240\n");
          expect(text).toContain("Mode 11: 856x480 (wide)\n");
          expect(text).toContain("\nGL_VENDOR:");
          expect(text).toContain(renderer === "cpu" ? "CPU indexed triangles\n" : "single glDrawElements\n");
        }
        await resourceLists();
        async function listing(): Promise<string> {
          output.length = 0;
          current.common.commands.append("imagelist\n"); await frame(current);
          const start = output.indexOf("\n      -w-- -h-- -mm- -TMU- -if-- wrap --name-------\n");
          const end = output.findIndex((text, index) => index > start && text.endsWith(" total images\n\n"));
          expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
          return output.slice(start, end + 1).join("");
        }
        const before = await listing();
        expect(before).toContain("   0:   16   16  yes   0   ");
        expect(before).toContain(" *default\n");
        expect(before).toContain("   3:   16   16  no    0   ");
        current.common.commands.append("set r_picmip 2\nvid_restart\n"); await frame(current);
        const second = created.at(-1);
        if (second === undefined) throw new Error("Missing replacement renderer");
        expect(second.renderer.backend.images).not.toBe(first.renderer.backend.images);
        expect(first.window.closed).toBe(true);
        const after = await listing();
        expect(after).toContain("   0:   16   16  yes   0   ");
        expect(after).toContain("   3:    4    4  no    0   ");
        expect(after).not.toBe(before);
        await resourceLists();
        const commands = current.common.commands;
        const names = ["imagelist", "shaderlist", "skinlist", "modellist", "modelist", "gfxinfo"];
        for (const name of names) expect(commands.registeredNames().filter(registered => registered === name)).toHaveLength(1);
        await current.close();
        for (const name of names) expect(commands.registeredNames()).not.toContain(name);
        expect(second.window.closed).toBe(true);
      } finally {
        try { await host?.close(); }
        finally { configSpy.mockRestore(); stdin.destroy(); }
      }
    }, 60000);

  test.skipIf(dataPath === undefined || (renderer === "gl" && process.env["QUAKE_GL_TEST"] !== "1"))(
    `actual ${renderer} video cvars change drawable, backend and UI only when the SDL window restarts`, async () => {
      const created: Parameters<typeof RendererConfiguration.beginInitialization>[0][] = [], configurations: RendererConfiguration[] = [], uis: BaseUi[] = [];
      const create = RendererConfiguration.beginInitialization, createUi = BaseUi.create;
      const configSpy = spyOn(RendererConfiguration, "beginInitialization").mockImplementation(options => {
        const configuration = create(options); created.push(options); configurations.push(configuration); return configuration;
      });
      const uiSpy = spyOn(BaseUi, "create").mockImplementation(async options => {
        const ui = await createUi(options); uis.push(ui); return ui;
      });
      const stdin = new PassThrough();
      let host: ClientHost | null = null;
      try {
        host = await open(renderer, "+set r_mode -1.9 +set r_customwidth 321.8 +set r_customheight 241.2 +set r_customaspect 1.17 +set r_fullscreen 0", stdin);
        const current = host;
        function verify(width: number, height: number, windowAspect: number): void {
          const options = created.at(-1), configuration = configurations.at(-1), ui = uis.at(-1);
          if (options === undefined || configuration === undefined || ui === undefined) throw new Error("Missing actual initialized video owners");
          expect(options.window.drawableSize).toEqual({ width, height });
          expect([options.renderer.backend.width, options.renderer.backend.height]).toEqual([width, height]);
          expect(configuration.copy()).toMatchObject({ vidWidth: width, vidHeight: height, windowAspect, isFullscreen: false });
          expect(ui.configuration).toMatchObject({ vidWidth: width, vidHeight: height, windowAspect, isFullscreen: false });
          expect([ui.state.draw.width, ui.state.draw.height]).toEqual([width, height]);
          if (renderer === "cpu") {
            const pixels = options.window.readPixels();
            expect(pixels.byteLength).toBe(width * height * 4);
            expect(pixels.some((value, index) => index % 4 !== 3 && value !== 0)).toBe(true);
          }
        }
        await frame(current); verify(321, 241, Math.fround(1.17));
        const initialWindow = created[0]?.window;
        if (initialWindow === undefined) throw new Error("Missing initial SDL window");
        current.common.commands.registerAsync("video_flush", () => current.client.flushMemory());
        current.common.commands.append("set r_mode 1.9\nset r_customaspect 2\n"); await frame(current);
        expect(current.common.cvars.get("r_mode")?.latchedValue).toBe("1.9");
        expect(created).toHaveLength(1); verify(321, 241, Math.fround(1.17));
        current.common.commands.append("video_flush\n"); await frame(current);
        expect(created).toHaveLength(2); expect(created.at(-1)?.window).toBe(initialWindow);
        expect(current.common.cvars.get("r_mode")?.value).toBe("1.9");
        verify(321, 241, Math.fround(1.17));
        current.common.commands.append("vid_restart\n"); await frame(current);
        expect(initialWindow.closed).toBe(true); expect(created).toHaveLength(3);
        verify(400, 300, Math.fround(4 / 3));
        current.common.commands.append("set r_mode 99\nvid_restart\n"); await frame(current);
        expect(current.common.cvars.get("r_mode")?.value).toBe("99"); verify(640, 480, Math.fround(4 / 3));
        current.common.commands.append("set r_mode -1\nset r_customwidth 0\nvid_restart\n"); await frame(current);
        expect(current.common.cvars.get("r_customwidth")?.value).toBe("0"); verify(640, 480, Math.fround(4 / 3));
        // UI_MainMenu sets sv_killserver. Let its next server frame consume that request before starting a map.
        await frame(current);
        current.common.commands.append("set r_mode 0\nmap q3dm1\n");
        for (let count = 0; count < 40 && current.client.clientStatic.phase !== "active"; count++) await frame(current);
        expect(current.client.clientStatic.phase).toBe("active");
        // Map loading re-registers video cvars but retains the 640x480 native window.
        verify(640, 480, Math.fround(4 / 3));
        current.common.commands.append("vid_restart\n"); await frame(current);
        verify(320, 240, Math.fround(4 / 3));
        for (let count = 0; count < 20 && current.client.clientStatic.phase !== "active"; count++) await frame(current);
        expect(current.client.clientStatic.phase).toBe("active");
        expect(current.common.cvars.get("sv_pure")?.integerValue).toBe(1);
      } finally {
        try { await host?.close(); }
        finally { configSpy.mockRestore(); uiSpy.mockRestore(); stdin.destroy(); }
      }
    }, 120000);

  test.skipIf(dataPath === undefined || !fullscreenProbe || (renderer === "gl" && process.env["QUAKE_GL_TEST"] !== "1"))(
    `actual ${renderer} Alt-Enter replaces the SDL window and follows the virtual display fullscreen dimensions`, async () => {
      const created: Parameters<typeof RendererConfiguration.beginInitialization>[0][] = [], configurations: RendererConfiguration[] = [], uis: BaseUi[] = [];
      const create = RendererConfiguration.beginInitialization, createUi = BaseUi.create;
      const configSpy = spyOn(RendererConfiguration, "beginInitialization").mockImplementation(options => {
        const configuration = create(options); created.push(options); configurations.push(configuration); return configuration;
      });
      const uiSpy = spyOn(BaseUi, "create").mockImplementation(async options => { const ui = await createUi(options); uis.push(ui); return ui; });
      const stdin = new PassThrough();
      let host: ClientHost | null = null;
      try {
        // Run only on a separately started Xvfb with a window manager, never the user's display.
        host = await open(renderer, "+set r_mode 1 +set r_fullscreen 0", stdin, false);
        await frame(host);
        for (const fullscreen of [true, false]) {
          const before = created.at(-1);
          if (before === undefined) throw new Error("Missing native video owner");
          before.window.pushEvent({ kind: "key", timestamp: 1, down: true, repeat: false, scancode: 226, keycode: 1073742050, modifiers: 0x100 });
          before.window.pushEvent({ kind: "key", timestamp: 2, down: true, repeat: false, scancode: 40, keycode: 13, modifiers: 0x100 });
          await frame(host);
          const after = created.at(-1);
          if (after === undefined) throw new Error("Missing replacement video owner");
          expect(after.window).not.toBe(before.window); expect(before.window.closed).toBe(true);
          expect((after.window.flags & 1) !== 0).toBe(fullscreen);
          expect(host.common.cvars.get("r_fullscreen")?.integerValue).toBe(fullscreen ? 1 : 0);
          expect([after.renderer.backend.width, after.renderer.backend.height]).toEqual([after.window.drawableSize.width, after.window.drawableSize.height]);
          const expected = { vidWidth: after.window.drawableSize.width, vidHeight: after.window.drawableSize.height, isFullscreen: fullscreen };
          expect(configurations.at(-1)?.copy()).toMatchObject(expected); expect(uis.at(-1)?.configuration).toMatchObject(expected);
          if (!fullscreen) expect(after.window.drawableSize).toEqual({ width: 400, height: 300 });
          if (renderer === "cpu") expect(after.window.readPixels().byteLength).toBe(after.renderer.backend.width * after.renderer.backend.height * 4);
        }
      } finally {
        try { await host?.close(); }
        finally { configSpy.mockRestore(); uiSpy.mockRestore(); stdin.destroy(); }
      }
    }, 120000);
}

test.skipIf(dataPath === undefined)("initial host profile is retained and fractional in_nograb prevents fullscreen", async () => {
  const stdin = new PassThrough();
  let host: ClientHost | null = null;
  try {
    host = await open("cpu", "+set r_fullscreen 1 +set in_nograb 0.5", stdin);
    expect(host.common.cvars.get("r_mode")).toMatchObject({ value: "0", resetValue: "3" });
    expect(host.common.cvars.get("r_fullscreen")).toMatchObject({ value: "0", resetValue: "1", modified: false });
  } finally { try { await host?.close(); } finally { stdin.destroy(); } }
}, 60000);

test.skipIf(dataPath === undefined)("actual Graphics Apply rebuilds the renderer and UI after its pixel and texture setting writes", async () => {
  const uis: BaseUi[] = [], windows: Parameters<typeof RendererConfiguration.beginInitialization>[0]["window"][] = [];
  const createUi = BaseUi.create, createConfig = RendererConfiguration.beginInitialization;
  const uiSpy = spyOn(BaseUi, "create").mockImplementation(async options => { const ui = await createUi(options); uis.push(ui); return ui; });
  const configSpy = spyOn(RendererConfiguration, "beginInitialization").mockImplementation(options => { windows.push(options.window); return createConfig(options); });
  const stdin = new PassThrough();
  let host: ClientHost | null = null;
  try {
    host = await open("cpu", "+set r_mode 0 +set r_fullscreen 0", stdin);
    const current = host;
    await frame(current);
    current.common.commands.registerAsync("video_menu", async () => {
      const ui = uis.at(-1); if (ui === undefined) throw new Error("Missing actual base UI"); await ui.graphics.show();
    });
    current.common.commands.append("video_menu\n"); await frame(current);
    const ui = uis.at(-1), window = windows.at(-1);
    if (ui === undefined || window === undefined) throw new Error("Missing native menu owners");
    const key = (scancode: number, keycode: number): void => {
      for (const down of [true, false]) window.pushEvent({ kind: "key", timestamp: 10, down, repeat: false, scancode, keycode, modifiers: 0 });
    };
    const focused = () => ui.graphics.menu.items[ui.graphics.menu.cursor];
    for (let count = 0; count < 24 && focused()?.common.id !== 104; count++) { key(43, 9); await frame(current); }
    expect(focused()?.common.id).toBe(104);
    key(79, 1073741903); await frame(current);
    for (let count = 0; count < 24 && focused()?.common.name !== "menu/art/accept_0"; count++) { key(43, 9); await frame(current); }
    expect(focused()?.common.name).toBe("menu/art/accept_0");
    key(40, 13);
    await frame(current);
    expect(current.common.cvars.get("r_mode")?.integerValue).toBe(1);
    expect(windows).toHaveLength(2); expect(window.closed).toBe(true);
    expect(windows[1]?.drawableSize).toEqual({ width: 400, height: 300 });
    expect(uis).toHaveLength(2); expect(uis[1]).not.toBe(ui);
  } finally {
    try { await host?.close(); }
    finally { uiSpy.mockRestore(); configSpy.mockRestore(); stdin.destroy(); }
  }
}, 60000);
