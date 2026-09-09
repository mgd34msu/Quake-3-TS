// Screen composition from id Software's code/client/cl_scrn.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { ClientLevel, ClientLevelFrame } from "../cgame/client-level.ts";
import { CommonError } from "../core/common-error.ts";
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { KeyCatcher } from "../core/key-codes.ts";
import type { SdlWindow } from "../platform/sdl.ts";
import type { SubmissionReceipt } from "../render/commands.ts";
import type { ConfiguredRenderer, RendererConfiguration } from "../render/configuration.ts";
import type { BaseUi } from "../ui/base/ui.ts";
import type { EngineSystemCinematics } from "./cinematics.ts";
import type { ClientKeys } from "./client-keys.ts";
import type { EngineClientSession } from "./client-session.ts";
import type { ClientConnectionState } from "./client-state.ts";
import type { EngineConsole } from "./console.ts";
import { screenColor, screenDrawString } from "./screen-draw.ts";
import type { EngineScreenDrawing } from "./screen-draw.ts";
import type { EngineSound } from "./sound.ts";

export interface EngineScreenPresentation {
  readonly drawing: EngineScreenDrawing;
  readonly configuration: RendererConfiguration;
  readonly renderer: ConfiguredRenderer;
  readonly window: SdlWindow;
  readonly cinematics: EngineSystemCinematics;
}

export interface EngineScreenOptions {
  readonly frameTimings: { frontEndMsec: number; backEndMsec: number };
  readonly cvars: CvarRegistry;
  readonly keys: ClientKeys;
  readonly console: EngineConsole;
  readonly sound: Pick<EngineSound, "stopAllSounds">;
  readPresentation(): EngineScreenPresentation | null;
  readUi(): (Pick<BaseUi, "setActiveMenu" | "refresh" | "drawConnectScreen"> & {
    isFullscreen(): boolean | Promise<boolean>;
  }) | null;
  readCgame(): Pick<ClientLevel, "drawActiveFrame"> | null;
  readSession(): EngineClientSession | null;
  readConnection(): ClientConnectionState;
  print(text: string): undefined;
  assertCurrentOperation(): undefined;
}

function nativeInt(value: number): number {
  if (!Number.isFinite(value) || value < -2147483648 || value >= 2147483648)
    throw new RangeError("Undefined native screen integer conversion");
  return Math.trunc(value) + 0;
}

/** The engine presents once, after cgame, product UI, console and debug drawing. */
export class EngineScreen {
  private initialized = false;
  private recursive = 0;
  private graphCurrent = 0;
  private readonly graphValues = new Float32Array(1024);
  private readonly graphColors = new Int32Array(1024);

  constructor(private readonly options: EngineScreenOptions) {}

  private checkPresentation(presentation: EngineScreenPresentation): void {
    const { drawing, renderer, window } = presentation;
    if (drawing.keys !== this.options.keys || drawing.commands.target.images !== renderer.backend.images
      || drawing.commands.target.width !== renderer.backend.width || drawing.commands.target.height !== renderer.backend.height
      || window.backend !== renderer.kind || (renderer.kind === "gl" && renderer.backend.window !== window))
      throw new Error("Screen presentation requires the engine's actual keys, renderer and window");
  }

  initialize(): void {
    this.options.assertCurrentOperation();
    for (const [name, value] of [["timegraph", "0"], ["debuggraph", "0"], ["graphheight", "32"],
      ["graphscale", "1"], ["graphshift", "0"]] satisfies readonly (readonly [string, string])[])
      this.options.cvars.register(name, value, CvarFlag.Cheat);
    this.initialized = true;
  }

  debugGraph(value: number, color: number): undefined {
    this.options.assertCurrentOperation();
    this.graphValues[this.graphCurrent & 1023] = value;
    this.graphColors[this.graphCurrent & 1023] = nativeInt(color);
    this.graphCurrent = (this.graphCurrent + 1) | 0;
  }

  private cvar(name: string): number {
    const value = this.options.cvars.get(name);
    if (value === undefined) throw new Error(`Screen requires registered cvar ${name}`);
    return value.integerValue;
  }

  private drawDebugGraph(drawing: EngineScreenDrawing): void {
    const width = drawing.pixels.width, height = drawing.pixels.height;
    const graphHeight = this.cvar("graphheight");
    if (graphHeight === 0) throw new RangeError("Undefined native debug graph division by zero");
    drawing.pixels.setColor(screenColor(0));
    drawing.pixels.stretchPixels({ x: 0, y: height - graphHeight, width, height: graphHeight },
      { s: 0, t: 0, s2: 0, t2: 0 }, drawing.pictures.white);
    drawing.pixels.setColor(null);
    for (let column = 0; column < width; column++) {
      const sample = this.graphValues[(this.graphCurrent - 1 - column + 1024) & 1023];
      if (sample === undefined) throw new RangeError("Missing screen graph sample");
      let value = Math.fround(Math.fround(sample * Math.fround(this.cvar("graphscale"))) + Math.fround(this.cvar("graphshift")));
      if (value < 0) value = Math.fround(value + Math.fround(Math.imul(graphHeight,
        (1 + nativeInt(Math.fround(-value / Math.fround(graphHeight)))) | 0)));
      const bar = nativeInt(value) % graphHeight;
      // The source stores each sample's color but does not use it for drawing.
      drawing.pixels.stretchPixels({ x: width - 1 - column, y: height - bar, width: 1, height: bar },
        { s: 0, t: 0, s2: 0, t2: 0 }, drawing.pictures.white);
    }
  }

  private drawDemoRecording(drawing: EngineScreenDrawing): void {
    const recording = this.options.readConnection().demoRecording?.screenInfo() ?? null;
    this.options.assertCurrentOperation();
    if (recording === null) return;
    const text = `RECORDING ${recording.name}: ${recording.kibibytes}k`;
    screenDrawString(drawing, 320 - text.length * 4, 20, 8, text, screenColor(7), true);
  }

  private async drawCgame(drawing: EngineScreenDrawing, stereo: ClientLevelFrame["stereo"], loadingDraw: (() => Promise<void>) | null): Promise<void> {
    if (loadingDraw !== null) await loadingDraw();
    else {
      const session = this.options.readSession(), cgame = this.options.readCgame();
      if (session === null || cgame === null) throw new Error("Screen requires the current initialized cgame");
      await cgame.drawActiveFrame({ serverTime: session.serverTime, stereo,
        demoPlayback: session.lifecycle.clientConnection.demoPlaying, engineFrameNumber: drawing.state.frameCount });
    }
    this.options.assertCurrentOperation();
  }

  private async drawScreenField(presentation: EngineScreenPresentation, stereo: ClientLevelFrame["stereo"], loadingDraw: (() => Promise<void>) | null): Promise<void> {
    const { drawing, configuration } = presentation, state = drawing.state, keys = this.options.keys;
    configuration.beginFrame(drawing.commands, stereo);
    const width = drawing.pixels.width, height = drawing.pixels.height;
    if (state.phase !== "active" && width * 480 > height * 640) {
      drawing.pixels.setColor(screenColor(0));
      drawing.pixels.stretchPixels({ x: 0, y: 0, width, height }, { s: 0, t: 0, s2: 0, t2: 0 }, drawing.pictures.white);
      drawing.pixels.setColor(null);
    }
    const ui = this.options.readUi();
    if (ui === null) {
      if (this.cvar("developer") !== 0) this.options.print("draw screen without UI loaded\n");
      return;
    }
    const fullscreen = await ui.isFullscreen(); this.options.assertCurrentOperation();
    if (!fullscreen) {
      switch (state.phase) {
        case "cinematic": presentation.cinematics.draw(drawing.virtual); break;
        case "disconnected":
          this.options.sound.stopAllSounds(); this.options.assertCurrentOperation();
          await ui.setActiveMenu("main"); this.options.assertCurrentOperation(); break;
        case "connecting": case "challenging": case "connected":
          await ui.refresh(state.realtime); this.options.assertCurrentOperation();
          await ui.drawConnectScreen(false, state, this.options.readConnection()); this.options.assertCurrentOperation(); break;
        case "loading": case "primed":
          await this.drawCgame(drawing, stereo, loadingDraw);
          await ui.refresh(state.realtime); this.options.assertCurrentOperation();
          await ui.drawConnectScreen(true, state, this.options.readConnection()); this.options.assertCurrentOperation(); break;
        case "active": await this.drawCgame(drawing, stereo, loadingDraw); this.drawDemoRecording(drawing); break;
        case "uninitialized": throw new CommonError("fatal", "SCR_DrawScreenField: bad cls.state");
        default: { const unreachable: never = state.phase; throw new Error(`Unknown screen phase ${unreachable}`); }
      }
    }
    const currentUi = this.options.readUi();
    if ((keys.getCatcher() & KeyCatcher.Ui) !== 0 && currentUi !== null) {
      await currentUi.refresh(state.realtime); this.options.assertCurrentOperation();
    }
    this.options.console.draw(drawing);
    if (this.cvar("debuggraph") !== 0 || this.cvar("timegraph") !== 0 || this.cvar("cl_debugMove") !== 0) this.drawDebugGraph(drawing);
  }

  /** CG_Init supplies its actual partial drawing operation for source loading-screen callbacks. */
  async update(loadingDraw: (() => Promise<void>) | null = null): Promise<SubmissionReceipt | null> {
    this.options.assertCurrentOperation();
    if (!this.initialized) return null;
    if (++this.recursive > 2) throw new CommonError("fatal", "SCR_UpdateScreen: recursively called");
    this.recursive = 1;
    const presentation = this.options.readPresentation();
    if (presentation === null) {
      // RE_BeginFrame/RE_EndFrame do no rendering before registration; UI is not loaded yet.
      if (this.cvar("developer") !== 0) this.options.print("draw screen without UI loaded\n");
      this.options.assertCurrentOperation(); this.recursive = 0; return null;
    }
    this.checkPresentation(presentation);
    const { renderer, window, drawing } = presentation;
    const stereo = renderer.kind === "gl" ? renderer.backend.stereoEnabled : renderer.backend.configuration.stereoEnabled;
    if (stereo) {
      await this.drawScreenField(presentation, "left", loadingDraw);
      await this.drawScreenField(presentation, "right", loadingDraw);
    } else await this.drawScreenField(presentation, "center", loadingDraw);
    this.options.assertCurrentOperation();
    const receipt = drawing.commands.submitFrame(() => {
      if (renderer.kind === "cpu") window.present(renderer.backend.pixels);
      else {
        const drawBuffer = this.options.cvars.get("r_drawBuffer");
        if (drawBuffer === undefined) throw new Error("Screen requires registered cvar r_drawBuffer");
        // linux_glimp.c:GLimp_EndFrame reads the current setting after rendering.
        if (drawBuffer.value.replace(/[a-z]/g, character => character.toUpperCase()) !== "GL_FRONT") window.swap();
        renderer.backend.endFrameLogging();
      }
    });
    if (receipt !== null) {
      drawing.resources.rolloverFrame();
      const timings = drawing.commands.frameTimings;
      this.options.frameTimings.frontEndMsec = timings.frontEndMsec;
      this.options.frameTimings.backEndMsec = timings.backEndMsec;
    }
    this.recursive = 0;
    return receipt;
  }
}
