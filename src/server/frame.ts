// Port of id Software's server/sv_main.c frame, ping, pause and timeout rules.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CommandBuffer } from "../core/commands.ts";
import { runCalls } from "../core/call-steps.ts";
import type { CallSteps } from "../core/call-steps.ts";
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import type { ServerClientLifecycleRuntime } from "./client-lifecycle.ts";
import type { ServerSnapshotSendRuntime } from "./snapshot-send.ts";
import { ServerClientPhase } from "./state.ts";
import type { ServerClient } from "./state.ts";

export interface ServerFrameHost {
  readonly cvars: Pick<CvarRegistry, "get" | "set" | "modifiedFlags" | "infoString" | "clearModifiedFlags">;
  readonly lifecycle: ServerClientLifecycleRuntime;
  readonly commands: Pick<CommandBuffer, "append">;
  readonly profile: { timeGame: number };
  botFrame(time: number): CallSteps;
  heartbeat(): Promise<void>;
  shutdown(reason: string): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
  milliseconds(): number;
  debugPrint(text: string): void;
}

/** Map-scoped alongside the sender/lifecycle; server-static time survives their replacement. */
export class ServerFrameRuntime {
  constructor(readonly sender: ServerSnapshotSendRuntime, readonly host: ServerFrameHost) {
    if (host.lifecycle.world !== sender.snapshots.world || host.lifecycle.staticState !== sender.snapshots.staticState) {
      throw new Error("Server frame, lifecycle and sender must share server state");
    }
  }
  private integer(name: string): number {
    const cvar = this.host.cvars.get(name);
    if (cvar === undefined) throw new Error(`Server frame requires registered cvar ${name}`);
    return cvar.integerValue;
  }
  private client(index: number): ServerClient {
    const client = this.sender.snapshots.staticState.clients[index];
    if (client === undefined) throw new RangeError("sv_maxclients exceeds canonical server client storage");
    return client;
  }
  private connection(client: ServerClient) {
    if (client.connection.kind !== "initialized") throw new Error("Connected server frame client requires initialized channel");
    return client.connection;
  }
  calculatePings(): void {
    const world = this.sender.snapshots.world;
    for (let index = 0; index < this.integer("sv_maxclients"); index++) {
      const client = this.client(index);
      if (client.phase !== ServerClientPhase.Active) { client.ping = 999; continue; }
      const entity = world.gameEntity(client);
      if (entity === null) { client.ping = 999; continue; }
      if (entity.r.svFlags & ServerEntityFlags.BOT) { client.ping = 0; continue; }
      let total = 0, count = 0;
      for (const frame of client.frames) {
        if (frame.messageAcked <= 0) continue;
        const delta = (frame.messageAcked - frame.messageSent) | 0;
        count++; total = (total + delta) | 0;
      }
      client.ping = count === 0 ? 999 : Math.min(Math.trunc(total / count) | 0, 999);
      const game = world.game;
      if (game === null) throw new Error("Bound ping update requires current game runtime");
      game.data.setPlayerPing(index, client.ping);
    }
  }
  *checkTimeouts(): CallSteps {
    const statics = this.sender.snapshots.staticState;
    const dropPoint = (statics.time - Math.imul(1000, this.integer("sv_timeout"))) | 0;
    const zombiePoint = (statics.time - Math.imul(1000, this.integer("sv_zombietime"))) | 0;
    for (let index = 0; index < this.integer("sv_maxclients"); index++) {
      const client = this.client(index);
      if (client.lastPacketTime > statics.time) client.lastPacketTime = statics.time;
      if (client.phase === ServerClientPhase.Zombie && client.lastPacketTime < zombiePoint) {
        this.host.debugPrint(`Going from CS_ZOMBIE to CS_FREE for client ${index}\n`);
        client.connection.phase = ServerClientPhase.Free;
        continue;
      }
      if (client.phase >= ServerClientPhase.Connected && client.lastPacketTime < dropPoint) {
        client.timeoutCount = (client.timeoutCount + 1) | 0;
        if (client.timeoutCount > 5) { yield* this.host.lifecycle.dropClient(client, "timed out"); client.connection.phase = ServerClientPhase.Free; }
      } else client.timeoutCount = 0;
    }
  }
  checkPaused(): boolean {
    if (this.integer("cl_paused") === 0) return false;
    let count = 0;
    for (let index = 0; index < this.integer("sv_maxclients"); index++) {
      const client = this.client(index);
      if (client.phase >= ServerClientPhase.Connected && this.connection(client).address.kind !== "bot") count++;
    }
    if (count > 1) { if (this.integer("sv_paused") !== 0) this.host.cvars.set("sv_paused", "0", true); return false; }
    if (this.integer("sv_paused") === 0) this.host.cvars.set("sv_paused", "1", true);
    return true;
  }
  async frame(milliseconds: number): Promise<void> {
    if (!Number.isInteger(milliseconds) || milliseconds < -0x80000000 || milliseconds > 0x7fffffff) throw new RangeError("Server frame milliseconds require signed int32");
    const { host } = this, statics = this.sender.snapshots.staticState, world = this.sender.snapshots.world;
    if (this.integer("sv_killserver") !== 0) { await host.shutdown("Server was killed.\n"); host.cvars.set("sv_killserver", "0", true); return; }
    if (this.integer("sv_running") === 0 || this.checkPaused()) return;
    if (this.integer("sv_fps") < 1) host.cvars.set("sv_fps", "10", true);
    const frameMsec = Math.trunc(1000 / this.integer("sv_fps"));
    world.timeResidual = (world.timeResidual + milliseconds) | 0;
    if (this.integer("dedicated") === 0) await runCalls(host.botFrame((statics.time + world.timeResidual) | 0));
    if (this.integer("dedicated") !== 0 && world.timeResidual < frameMsec) { await host.sleep((frameMsec - world.timeResidual) | 0); return; }
    if (statics.time > 0x70000000) { await host.shutdown("Restarting server due to time wrapping"); host.commands.append("vstr nextmap\n"); return; }
    if (statics.nextSnapshotEntities >= 0x7ffffffe - statics.numSnapshotEntities) {
      await host.shutdown("Restarting server due to numSnapshotEntities wrapping"); host.commands.append("vstr nextmap\n"); return;
    }
    if (world.restartTime !== 0 && statics.time >= world.restartTime) { world.restartTime = 0; host.commands.append("map_restart 0\n"); return; }
    if (host.cvars.modifiedFlags & CvarFlag.ServerInfo) {
      await runCalls(world.configstrings.setCalls(0, host.cvars.infoString(CvarFlag.ServerInfo))); host.cvars.clearModifiedFlags(CvarFlag.ServerInfo);
    }
    if (host.cvars.modifiedFlags & CvarFlag.SystemInfo) {
      await runCalls(world.configstrings.setCalls(1, host.cvars.infoString(CvarFlag.SystemInfo, 8192))); host.cvars.clearModifiedFlags(CvarFlag.SystemInfo);
    }
    const startTime = this.integer("com_speeds") !== 0 ? host.milliseconds() : 0;
    this.calculatePings();
    if (this.integer("dedicated") !== 0) await runCalls(host.botFrame(statics.time));
    // Source fps > 1000 produces a zero-step infinite loop; reject that undefined operating mode.
    if (frameMsec === 0) throw new RangeError("sv_fps above 1000 produces a zero-length server frame");
    while (world.timeResidual >= frameMsec) {
      world.timeResidual = (world.timeResidual - frameMsec) | 0; statics.time = (statics.time + frameMsec) | 0;
      const game = world.game;
      if (game === null) throw new Error("Server frame requires the current game runtime");
      await runCalls(game.calls.runFrame(statics.time));
    }
    if (this.integer("com_speeds") !== 0) host.profile.timeGame = (host.milliseconds() - startTime) | 0;
    await runCalls(this.checkTimeouts());
    this.sender.sendClientMessages();
    await host.heartbeat();
  }
}
