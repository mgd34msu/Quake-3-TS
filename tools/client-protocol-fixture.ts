// Protocol verification lifecycle only. This is not a cgame initialization host.
import { CvarFlag } from "../src/core/cvar.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import type { CvarRegistry } from "../src/core/cvar.ts";
import { ClientActiveState } from "../src/engine/client-active.ts";
import { ClientConnectionState, ClientStaticState, registerClientClockCvars } from "../src/engine/client-state.ts";
import { EngineClientSession, ClientSessionError } from "../src/engine/client-session.ts";
import { infoValueForKey } from "../src/core/info-string.ts";
import type { Download } from "../src/protocol/server-message.ts";
import type { ClientSessionLifecycle, ClientSessionOptions, DemoTimingReport } from "../src/engine/client-session.ts";
import type { DemoEnd } from "../src/protocol/demo.ts";
import { SourceMessageState } from "../src/protocol/message.ts";

/** One test/verifier operation owns this fixture until close; no scheduler or VM. */
export class ProtocolClientLifecycle implements ClientSessionLifecycle {
  readonly consoleCommands = new CommandBuffer();
  readonly clientStatic = new ClientStaticState();
  readonly clientConnection = new ClientConnectionState();
  readonly debugMessages: string[] = [];
  readonly sourceState = new SourceMessageState(text => { this.print(text); });
  readonly clientActive = new ClientActiveState(text => { this.debugMessages.push(text); });
  readonly gamestates: number[] = [];
  readonly completions: { readonly end: DemoEnd; readonly timing: DemoTimingReport | null }[] = [];
  private readonly operation = { current: true };

  constructor(cvars: CvarRegistry) {
    this.clientStatic.phase = "connected";
    registerClientClockCvars(cvars, "nudge");
    registerClientClockCvars(cvars, "delta-and-freeze");
    registerClientClockCvars(cvars, "active-action");
    registerClientClockCvars(cvars, "timedemo");
    cvars.register("sv_running", "0", CvarFlag.ReadOnly);
    cvars.register("sv_paused", "0", CvarFlag.ReadOnly);
    cvars.register("cl_paused", "0", CvarFlag.ReadOnly);
    cvars.register("timescale", "1", CvarFlag.Cheat | CvarFlag.SystemInfo);
    cvars.register("cl_packetdup", "1", CvarFlag.Archive);
    cvars.register("cl_showSend", "0", CvarFlag.Temporary);
    cvars.register("cl_shownet", "0", CvarFlag.Temporary);
    cvars.register("cl_nodelta", "0", CvarFlag.None);
    cvars.register("net_qport", "0", CvarFlag.Init);
  }

  assertCurrentOperation(): void {
    if (!this.operation.current) throw new Error("Protocol fixture operation is no longer current");
  }
  close(): void { this.operation.current = false; }
  print(text: string): undefined { this.assertCurrentOperation(); this.debugMessages.push(text); }
  milliseconds(): number { this.assertCurrentOperation(); return this.clientStatic.realtime; }
  async applyServerPackages(info: string): Promise<void> {
    this.assertCurrentOperation();
    if (infoValueForKey(info, "sv_paks") !== "") throw new ClientSessionError("unsupported", "Protocol fixture has no pure filesystem");
  }
  downloadSizeReceived(_fileSize: number): number {
    this.assertCurrentOperation();
    throw new ClientSessionError("unsupported", "Protocol fixture has no download filesystem");
  }
  async downloadReceived(_block: Download): Promise<void | "retired"> {
    this.assertCurrentOperation();
    throw new ClientSessionError("unsupported", "Protocol fixture has no download filesystem");
  }
  async gamestateReceived(generation: number): Promise<void> {
    this.assertCurrentOperation();
    this.gamestates.push(generation);
    // No cgame was loaded. Tests/verifiers must explicitly exercise prime().
    this.clientStatic.phase = "connected";
  }
  async demoCompleted(end: DemoEnd, timing: DemoTimingReport | null): Promise<void> {
    this.assertCurrentOperation();
    this.completions.push({ end, timing });
    this.clientStatic.phase = "disconnected";
  }
}

/** Admitted protocol peer only; callers explicitly prime without claiming CG_Init. */
export function createProtocolClientSession(options: Omit<ClientSessionOptions, "lifecycle">): EngineClientSession {
  if (options.mode.kind === "network") options.cvars.register("net_qport", String(options.mode.qport), CvarFlag.Init);
  return new EngineClientSession({ ...options, lifecycle: new ProtocolClientLifecycle(options.cvars) });
}

/** Supplies a verifier's explicit frame timestamp to the sole client-static record. */
export function transmitProtocolClient(session: EngineClientSession, realtime: number, packetDup: number, noDelta: boolean): readonly Uint8Array[] {
  session.lifecycle.assertCurrentOperation();
  session.lifecycle.clientStatic.realtime = realtime;
  session.cvars.set("cl_packetdup", String(packetDup), true);
  session.cvars.set("cl_nodelta", noDelta ? "1" : "0", true);
  const packets: Uint8Array[] = [], traces: string[] = [], prints: string[] = [];
  session.transmit({ send: bytes => { packets.push(bytes); }, trace: text => { traces.push(text); }, print: text => { prints.push(text); } });
  return packets;
}
