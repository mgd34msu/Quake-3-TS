import { ClientLevel } from "../src/cgame/client-level.ts";
import type { ClientLevelOptions } from "../src/cgame/client-level.ts";
import { CvarFlag } from "../src/core/cvar.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import type { CvarRegistry } from "../src/core/cvar.ts";
import { ClientActiveState } from "../src/engine/client-active.ts";
import { ClientConnectionState, ClientStaticState, registerClientClockCvars } from "../src/engine/client-state.ts";
import type { ClientSessionEvent, ClientSessionLifecycle, DemoTimingReport } from "../src/engine/client-session.ts";
import type { DemoEnd } from "../src/protocol/demo.ts";
import type { Download } from "../src/protocol/server-message.ts";
import { infoValueForKey } from "../src/core/info-string.ts";
import { SourceMessageState } from "../src/protocol/message.ts";

/** Real ClientLevel loading/closing; not an implementation of the full engine host. */
export class ClientLevelClockFixture implements ClientSessionLifecycle {
  readonly consoleCommands = new CommandBuffer();
  readonly clientStatic = new ClientStaticState();
  readonly clientConnection = new ClientConnectionState();
  readonly debugMessages: string[] = [];
  readonly sourceState = new SourceMessageState(text => { this.print(text); });
  readonly clientActive = new ClientActiveState(text => { this.debugMessages.push(text); });
  readonly loadingEvents: ClientSessionEvent[] = [];
  private options: ClientLevelOptions | null = null;
  private currentLevel: ClientLevel | null = null;
  private readonly operation = { current: true };

  constructor(cvars: CvarRegistry, readonly milliseconds: () => number) {
    this.clientStatic.phase = "connected";
    registerClientClockCvars(cvars, "nudge"); registerClientClockCvars(cvars, "delta-and-freeze");
    registerClientClockCvars(cvars, "active-action"); registerClientClockCvars(cvars, "timedemo");
    cvars.register("sv_running", "0", CvarFlag.ReadOnly); cvars.register("sv_paused", "0", CvarFlag.ReadOnly);
    cvars.register("cl_paused", "0", CvarFlag.ReadOnly); cvars.register("timescale", "1", CvarFlag.SystemInfo | CvarFlag.Cheat);
    cvars.register("cl_shownet", "0", CvarFlag.Temporary);
  }
  configure(options: ClientLevelOptions): void {
    this.assertCurrentOperation();
    if (options.session.lifecycle !== this) throw new Error("Level fixture must share the session's actual lifecycle");
    this.options = options;
  }
  get level(): ClientLevel {
    if (this.currentLevel === null) throw new Error("No actual ClientLevel initialized");
    return this.currentLevel;
  }
  assertCurrentOperation(): void {
    if (!this.operation.current) throw new Error("ClientLevel fixture operation is no longer current");
  }
  print(text: string): undefined { this.assertCurrentOperation(); this.debugMessages.push(text); }
  async applyServerPackages(info: string): Promise<void> {
    this.assertCurrentOperation();
    if (infoValueForKey(info, "sv_paks") !== "") throw new Error("ClientLevel fixture has no pure filesystem owner");
  }
  downloadSizeReceived(_fileSize: number): number {
    this.assertCurrentOperation();
    throw new Error("ClientLevel fixture has no download filesystem owner");
  }
  async downloadReceived(_block: Download): Promise<void> {
    this.assertCurrentOperation();
    throw new Error("ClientLevel fixture has no download filesystem owner");
  }
  async gamestateReceived(generation: number): Promise<void> {
    this.assertCurrentOperation();
    const options = this.options;
    if (options === null || options.session.gamestateGeneration !== generation) throw new Error("Missing current level fixture configuration");
    this.loadingEvents.push(...options.session.takeEvents());
    if (this.currentLevel !== null) await this.currentLevel.close();
    this.assertCurrentOperation();
    this.currentLevel = new ClientLevel(options);
    await this.currentLevel.initialize();
    this.assertCurrentOperation();
  }
  async demoCompleted(_end: DemoEnd, _timing: DemoTimingReport | null): Promise<void> {
    this.assertCurrentOperation();
    if (this.currentLevel !== null) await this.currentLevel.close();
    this.assertCurrentOperation();
    this.currentLevel = null; this.clientStatic.phase = "disconnected";
  }
  async close(): Promise<void> {
    if (this.currentLevel !== null) await this.currentLevel.close();
    this.currentLevel = null; this.operation.current = false;
  }
}
