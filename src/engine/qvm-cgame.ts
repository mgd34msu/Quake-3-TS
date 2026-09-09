/*
 * External cgame calls from id Software code/client/cl_cgame.c and cgame/cg_public.h.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { QvmImage } from "../assets/qvm.ts";
import type { ClientLevelFrame } from "../cgame/client-level.ts";
import type { HunkAccountingProfile } from "../render/hunk-accounting.ts";
import { QvmInterpreter } from "../vm/interpreter.ts";
import type { QvmArguments, QvmSyscall, QvmSystemCall } from "../vm/interpreter.ts";
import type { VmRegistration } from "../vm/registry.ts";
import type { QvmSymbolLoadOptions } from "../vm/symbols.ts";
import type { EngineClientSession } from "./client-session.ts";

type Phase = { readonly kind: "created" } | { readonly kind: "retired" }
  | { readonly kind: "initializing" | "initialized"; readonly generation: number };

export class QvmCgame {
  private static readonly registeredOwners = new WeakMap<VmRegistration, QvmCgame>();
  private readonly interpreter: QvmInterpreter;
  private readonly calls = new AsyncLocalStorage<QvmSyscall>();
  private phase: Phase = { kind: "created" };

  constructor(image: QvmImage, systemCall: QvmSystemCall,
    private readonly session: EngineClientSession, private readonly assertCurrentOperation: () => void,
    memoryProfile: HunkAccountingProfile = { kind: "unaccounted" },
    private readonly registration: VmRegistration | null = null,
  ) {
    this.interpreter = new QvmInterpreter(image, call => this.calls.run(call, () => systemCall(call)), memoryProfile, registration);
    if (registration !== null) QvmCgame.registeredOwners.set(registration, this);
  }

  static registered(registration: VmRegistration): QvmCgame | null {
    return registration.binding.kind === "interpreted" ? QvmCgame.registeredOwners.get(registration) ?? null : null;
  }

  loadSymbols(options: Omit<QvmSymbolLoadOptions, "name">): void {
    this.interpreter.loadSymbols({ ...options, name: this.registration?.name ?? "cgame" });
  }

  private current(command: number): void {
    this.assertCurrentOperation();
    const phase = this.phase;
    if (phase.kind === "retired") throw new Error("Cgame module has been retired");
    // CL_ShutdownCGame and CL_GameCommand require only the retained VM.
    if (command === 1 || command === 2) return;
    if (phase.kind === "created") throw new Error("Cgame module has not initialized");
    if (this.session.dropped !== null) throw this.session.dropped;
    if (this.session.gamestateGeneration !== phase.generation) throw new Error("Cgame module belongs to a stale engine gamestate");
  }

  private async invoke(command: number, first = 0, second = 0, third = 0): Promise<number> {
    this.current(command);
    this.registration?.called();
    const args: QvmArguments = [command, first, second, third, 0, 0, 0, 0, 0, 0];
    const scope = this.calls.getStore();
    const result = await (scope === undefined ? this.interpreter.invoke(args) : scope.invoke(args));
    this.current(command);
    return result;
  }

  async initialize(): Promise<void> {
    this.assertCurrentOperation();
    if (this.phase.kind === "retired") throw new Error("Cgame module has been retired");
    if (this.phase.kind === "initializing") throw new Error("Cgame module initialization already started");
    const generation = this.session.gamestateGeneration, message = this.session.serverMessageSequence;
    if (this.session.dropped !== null) throw this.session.dropped;
    if (generation === 0) throw new Error("CG_Init requires a live engine gamestate");
    this.phase = { kind: "initializing", generation };
    this.session.lifecycle.clientStatic.phase = "loading";
    await this.invoke(0, message, this.session.lastExecutedServerCommand, this.session.clientNumber);
    if (this.session.serverMessageSequence !== message) throw new Error("Engine server message parsing must serialize behind CG_Init");
    this.session.prime(generation);
    this.phase = { kind: "initialized", generation };
  }

  async close(): Promise<void> {
    if (this.phase.kind === "retired") return;
    await this.invoke(1);
    this.retire();
  }
  retire(): void { this.phase = { kind: "retired" }; this.registration?.free(); }
  async consoleCommand(_argv: readonly string[]): Promise<boolean> { return await this.invoke(2) !== 0; }
  async drawActiveFrame(input: ClientLevelFrame): Promise<void> {
    const stereo = input.stereo === "center" ? 0 : input.stereo === "left" ? 1 : 2;
    await this.invoke(3, input.serverTime, stereo, Number(input.demoPlayback));
  }
  crosshairPlayer(): Promise<number> { return this.invoke(4); }
  lastAttacker(): Promise<number> { return this.invoke(5); }
  async keyEvent(key: number, down: boolean): Promise<void> { await this.invoke(6, key, Number(down)); }
  async mouseEvent(dx: number, dy: number): Promise<void> { await this.invoke(7, dx, dy); }
  async eventHandling(type: number): Promise<void> { await this.invoke(8, type); }
}
