/*
 * External UI module calls from id Software code/client/cl_ui.c and ui/ui_public.h.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { QvmImage } from "../assets/qvm.ts";
import type { CommandContext } from "../core/commands.ts";
import { CommonError } from "../core/common-error.ts";
import type { HunkAccountingProfile } from "../render/hunk-accounting.ts";
import { UiMenuCommand } from "../ui/public.ts";
import { QvmInterpreter } from "../vm/interpreter.ts";
import type { QvmArguments, QvmSyscall, QvmSystemCall } from "../vm/interpreter.ts";
import type { VmRegistration } from "../vm/registry.ts";
import type { QvmSymbolLoadOptions } from "../vm/symbols.ts";
import type { ClientConnectionState, ClientStaticState } from "./client-state.ts";

/** Owns one external UI's memory and scoped reentry, not engine resources. */
export class QvmUi {
  private static readonly registeredOwners = new WeakMap<VmRegistration, QvmUi>();
  private readonly interpreter: QvmInterpreter;
  private readonly calls = new AsyncLocalStorage<QvmSyscall>();
  private retired = false;

  constructor(image: QvmImage, systemCall: QvmSystemCall,
    private readonly client: ClientStaticState, private readonly assertCurrentOperation: () => void,
    memoryProfile: HunkAccountingProfile = { kind: "unaccounted" },
    private readonly registration: VmRegistration | null = null,
  ) {
    this.interpreter = new QvmInterpreter(image, call => this.calls.run(call, () => systemCall(call)), memoryProfile, registration);
    if (registration !== null) QvmUi.registeredOwners.set(registration, this);
  }

  static registered(registration: VmRegistration): QvmUi | null {
    return registration.binding.kind === "interpreted" ? QvmUi.registeredOwners.get(registration) ?? null : null;
  }

  loadSymbols(options: Omit<QvmSymbolLoadOptions, "name">): void {
    this.interpreter.loadSymbols({ ...options, name: this.registration?.name ?? "ui" });
  }

  private async invoke(command: number, first = 0, second = 0): Promise<number> {
    this.assertCurrentOperation();
    if (this.retired) throw new Error("UI module has been retired");
    this.registration?.called();
    const args: QvmArguments = [command, first, second, 0, 0, 0, 0, 0, 0, 0];
    const scope = this.calls.getStore();
    const result = await (scope === undefined ? this.interpreter.invoke(args) : scope.invoke(args));
    this.assertCurrentOperation();
    if (this.retired) throw new Error("UI module retired during its call");
    return result;
  }

  async initialize(): Promise<void> {
    const version = await this.invoke(0);
    if (version !== 4 && version !== 6) throw new CommonError("drop", `User Interface is version ${version}, expected 6`);
    const phase = this.client.phase;
    await this.invoke(1, Number(phase === "connecting" || phase === "challenging" || phase === "connected"
      || phase === "loading" || phase === "primed"));
  }

  async shutdown(): Promise<void> { await this.invoke(2); }
  retire(): void { this.retired = true; this.registration?.free(); }
  async keyEvent(key: number, down: boolean): Promise<void> { await this.invoke(3, key, Number(down)); }
  async mouseEvent(dx: number, dy: number): Promise<void> { await this.invoke(4, dx, dy); }
  async refresh(realtime: number): Promise<void> { await this.invoke(5, realtime); }
  async isFullscreen(): Promise<boolean> { return await this.invoke(6) !== 0; }
  async setActiveMenu(menu: number | "main" | "ingame"): Promise<void> {
    await this.invoke(7, menu === "main" ? UiMenuCommand.Main : menu === "ingame" ? UiMenuCommand.InGame : menu);
  }
  async consoleCommand(context: CommandContext): Promise<boolean> {
    context.assertActive();
    const result = await this.invoke(8, this.client.realtime);
    context.assertActive();
    return result !== 0;
  }
  async drawConnectScreen(overlay: boolean, _client: ClientStaticState, _connection: ClientConnectionState): Promise<void> {
    await this.invoke(9, Number(overlay));
  }
  usesUniqueKey(): Promise<number> { return this.invoke(10); }
}
