// Engine-lifetime function-static state and logical svs redirect slot from id Software's sv_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ServerPacketAddress } from "./net-channel.ts";
import type { ServerAddress } from "./state.ts";

type OperationKind = "connectionless" | "rcon" | "heartbeat" | "ban";
interface Operation {
  readonly kind: OperationKind;
  readonly parent: Operation | undefined;
  closed: boolean;
}
interface OperationOwner {
  assertOpen(): void;
  assertChildrenReturned(): void;
}

/** Retain across handler, map and ServerStaticState replacement; never share between engines. */
export class ServerNetworkControlState {
  readonly masterAddresses: (ServerPacketAddress | null)[] = Array.from({ length: 5 }, () => null);
  rconLastTime = 0;
  redirectAddress: ServerAddress = { kind: "bot" };
  private readonly context = new AsyncLocalStorage<Operation>();
  private active: Operation | undefined;

  /** The logical svs memory slot survives JS object replacement; native memset resets this field. */
  resetServerSession(): void { this.redirectAddress = { kind: "bot" }; }

  get connectionlessBusy(): boolean { return this.active !== undefined; }
  get rconBusy(): boolean {
    for (let operation = this.active; operation !== undefined; operation = operation.parent) if (operation.kind === "rcon") return true;
    return false;
  }
  get inCurrentRconOperation(): boolean {
    const current = this.context.getStore();
    if (current === undefined || current !== this.active) return false;
    let rcon = false;
    for (let operation: Operation | undefined = current; operation !== undefined; operation = operation.parent) {
      if (operation.closed) return false;
      if (operation.kind === "rcon") rcon = true;
    }
    return rcon;
  }

  private requireOpen(operation: Operation | undefined): void {
    for (let current = operation; current !== undefined; current = current.parent) {
      if (current.closed) throw new Error("Cannot reuse a closed server network operation");
    }
  }

  /** Required after asynchronous imports and before publishing their effects. */
  assertCurrentOperation(): void {
    const current = this.context.getStore();
    this.requireOpen(current);
    if (current === undefined || current !== this.active) throw new Error("Nested server network operations must be awaited before their caller continues");
  }

  /** Global console output may originate outside the owner's asynchronous caller context. */
  captureCurrentOperation(): OperationOwner {
    const owner = this.context.getStore();
    this.requireOpen(owner);
    if (owner === undefined || owner !== this.active) throw new Error("Cannot capture an inactive server network operation");
    const assertOpen = (): void => {
      this.requireOpen(owner);
      for (let current = this.active; current !== undefined; current = current.parent) if (current === owner) return;
      throw new Error("Captured server network operation is no longer active");
    };
    return {
      assertOpen,
      assertChildrenReturned: () => {
        assertOpen();
        if (this.active !== owner) throw new Error("Nested server network operations must be awaited before their caller continues");
      },
    };
  }

  runConnectionless(operation: () => Promise<void>): Promise<void> { return this.run("connectionless", operation); }
  runRcon(operation: () => Promise<void>): Promise<void> { return this.run("rcon", operation); }
  runHeartbeat(operation: () => Promise<void>): Promise<void> { return this.run("heartbeat", operation); }
  runBan(operation: () => Promise<void>): Promise<void> { return this.run("ban", operation); }

  private async run(kind: OperationKind, execute: () => Promise<void>): Promise<void> {
    const parent = this.context.getStore();
    this.requireOpen(parent);
    if (parent !== this.active) throw new Error("Server network operations must be awaited in source order");
    if (parent !== undefined && !(parent.kind === "connectionless" && kind === "rcon")
      && !(parent.kind === "rcon" && (kind === "heartbeat" || kind === "ban"))) {
      throw new Error("Server network operations must be awaited in source order; invalid nested operation");
    }
    const operation: Operation = { kind, parent, closed: false };
    this.active = operation;
    await this.context.run(operation, async () => {
      try { await execute(); this.assertCurrentOperation(); }
      finally {
        operation.closed = true;
        if (this.active === operation) {
          this.active = parent;
          while (this.active?.closed) this.active = this.active.parent;
        }
      }
    });
  }
}
