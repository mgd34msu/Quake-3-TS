/*
 * External game calls from id Software code/server/sv_game.c, sv_client.c,
 * qcommon/vm.c and game/g_public.h.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { QvmDataImage, QvmImage } from "../assets/qvm.ts";
import { waitForCall } from "../core/call-steps.ts";
import type { CallSteps } from "../core/call-steps.ts";
import type { HunkAccountingProfile } from "../render/hunk-accounting.ts";
import type { ServerGame, ServerGameCalls, ServerGameDenial } from "../server/game.ts";
import type { Product } from "../shared/definitions.ts";
import { QvmGameData } from "../vm/game-data.ts";
import { QvmInterpreter } from "../vm/interpreter.ts";
import type { QvmArguments, QvmSyscall, QvmSystemCall } from "../vm/interpreter.ts";
import { QvmMemory } from "../vm/memory.ts";
import type { VmRegistration } from "../vm/registry.ts";
import type { QvmSymbolLoadOptions } from "../vm/symbols.ts";

/** ServerEngine publishes this owner before invoking GAME_INIT. */
export class QvmGame implements ServerGame {
  private static readonly registeredOwners = new WeakMap<VmRegistration, QvmGame>();
  readonly data: QvmGameData;
  readonly calls: ServerGameCalls;
  private readonly interpreter: QvmInterpreter;
  private readonly memory: QvmMemory;
  private readonly syscalls = new AsyncLocalStorage<QvmSyscall>();
  private retired = false;

  constructor(image: QvmImage, readonly product: Product, systemCall: QvmSystemCall,
    private readonly assertCurrentOperation: () => void,
    memoryProfile: HunkAccountingProfile = { kind: "unaccounted" },
    private readonly registration: VmRegistration | null = null,
  ) {
    this.interpreter = new QvmInterpreter(image, call => this.syscalls.run(call, () => systemCall(call)), memoryProfile, registration);
    this.memory = new QvmMemory(this.interpreter.memory);
    this.data = new QvmGameData(this.memory, product);
    const game = this;
    this.calls = {
      *clientConnect(client, firstTime, isBot): CallSteps<ServerGameDenial | null> {
        const denied = yield* waitForCall(() => game.invoke(2, client, Number(firstTime), Number(isBot)));
        return denied === 0 ? null : () => game.memory.readString(denied);
      },
      *clientBegin(client): CallSteps { yield* waitForCall(() => game.invoke(3, client)); },
      *clientUserinfoChanged(client): CallSteps { yield* waitForCall(() => game.invoke(4, client)); },
      *clientDisconnect(client): CallSteps { yield* waitForCall(() => game.invoke(5, client)); },
      *clientCommand(client, _argv): CallSteps { yield* waitForCall(() => game.invoke(6, client)); },
      *clientThink(client, _command): CallSteps { yield* waitForCall(() => game.invoke(7, client)); },
      *runFrame(time): CallSteps { yield* waitForCall(() => game.invoke(8, time)); },
      *consoleCommand(_argv): CallSteps<boolean> { return (yield* waitForCall(() => game.invoke(9))) !== 0; },
      *botFrame(time): CallSteps { yield* waitForCall(() => game.invoke(10, time)); },
      *shutdown(restart): CallSteps { yield* waitForCall(() => game.invoke(1, Number(restart))); },
    };
    if (registration !== null) QvmGame.registeredOwners.set(registration, this);
  }

  static registered(registration: VmRegistration): QvmGame | null {
    return registration.binding.kind === "interpreted" ? QvmGame.registeredOwners.get(registration) ?? null : null;
  }

  loadSymbols(options: Omit<QvmSymbolLoadOptions, "name">): void {
    this.interpreter.loadSymbols({ ...options, name: this.registration?.name ?? "qagame" });
  }

  private current(): void {
    this.assertCurrentOperation();
    if (this.retired) throw new Error("Game module has been retired");
  }

  private async invoke(command: number, first = 0, second = 0, third = 0): Promise<number> {
    this.current();
    this.registration?.called();
    const args: QvmArguments = [command, first, second, third, 0, 0, 0, 0, 0, 0];
    const scope = this.syscalls.getStore();
    // VM_Call may return after a nested server shutdown. New entry checks the owner;
    // completion of an already-entered call does not require it to remain published.
    return scope === undefined ? this.interpreter.invoke(args) : scope.invoke(args);
  }

  async initialize(levelTime: number, randomSeed: number, restart = false): Promise<void> {
    await this.invoke(0, levelTime, randomSeed, Number(restart));
  }

  /** SV_RestartGameProgs calls GAME_SHUTDOWN first, then reloads data and initializes. */
  restart(image: QvmDataImage): void {
    this.current();
    this.interpreter.restart(image);
  }

  disposeResources(): void { this.retired = true; this.registration?.free(); }
}
