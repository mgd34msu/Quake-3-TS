/*
 * Client-state traps from id Software code/client/cl_cgame.c and cl_ui.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { ClientActiveState } from "../engine/client-active.ts";
import type { ClientConnectionState, ClientStaticState } from "../engine/client-state.ts";
import type { RendererConfigurationSnapshot } from "../render/configuration.ts";
import { QVM_GAME_STATE_BYTES, QVM_GL_CONFIG_BYTES, QVM_SNAPSHOT_BYTES, QVM_UI_CLIENT_STATE_BYTES,
  writeQvmGameState, writeQvmGlConfig, writeQvmSnapshot, writeQvmUiClientState } from "./client-record.ts";
import type { QvmMemory } from "./memory.ts";
import { QVM_USER_COMMAND_BYTES, writeQvmUserCommand } from "./user-command.ts";

export interface QvmClientStateServices {
  readonly clientStatic: ClientStaticState;
  readonly connection: ClientConnectionState;
  readonly active: ClientActiveState;
  getServerCommand(sequence: number): Promise<readonly string[] | null>;
  configuration(): RendererConfigurationSnapshot;
}

export function qvmClientStateSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, services: QvmClientStateServices,
): number | Promise<number> | null {
  if (role === "game") return null;
  const trap = words.getInt32(0, true);
  if (trap === (role === "ui" ? 43 : 49)) {
    const destination = words.getInt32(4, true);
    const configuration = services.configuration();
    writeQvmGlConfig(memory.view(destination, QVM_GL_CONFIG_BYTES), configuration);
    return 0;
  }
  if (role === "ui") {
    if (trap === 44) {
      const destination = words.getInt32(4, true), active = services.active;
      writeQvmUiClientState(memory.view(destination, QVM_UI_CLIENT_STATE_BYTES),
        services.clientStatic, services.connection, active);
      return 0;
    }
    if (trap === 45) {
      const index = words.getInt32(4, true), destination = words.getInt32(8, true), size = words.getInt32(12, true);
      if (index < 0 || index >= 1024) return 0;
      const value = services.active.getConfigString(index);
      if (value === null) {
        if (size !== 0) memory.view(destination, 1).setUint8(0, 0);
        return 0;
      }
      memory.writeString(destination, value, size);
      return 1;
    }
    return null;
  }
  if (trap < 50 || trap > 56) return null;
  // Scalar arguments belong to this invocation even if resolving the live owner reenters the VM.
  const first = trap === 54 ? 0 : words.getInt32(4, true);
  const second = trap === 51 || trap === 52 || trap === 55 ? words.getInt32(8, true) : 0;
  const sensitivity = trap === 56 ? words.getFloat32(8, true) : 0;
  const active = services.active;
  switch (trap) {
    case 50: {
      const gameState = active.getSourceGameState();
      writeQvmGameState(memory.view(first, QVM_GAME_STATE_BYTES), gameState);
      return 0;
    }
    case 51: {
      const current = active.snapshots.current();
      memory.view(first, 4).setInt32(0, current.number, true);
      memory.view(second, 4).setInt32(0, current.serverTime, true);
      return 0;
    }
    case 52: {
      const ping = active.snapshotPing(first);
      const snapshot = active.snapshots.read(first);
      if (snapshot === null) return 0;
      if (ping === null) throw new Error("Retained client snapshot has no ping record");
      writeQvmSnapshot(memory.view(second, QVM_SNAPSHOT_BYTES), snapshot, ping);
      return 1;
    }
    case 53:
      return services.getServerCommand(first).then(argv => Number(argv !== null));
    case 54: return active.commands.currentNumber;
    case 55: {
      const command = active.commands.read(first);
      if (command === null) return 0;
      writeQvmUserCommand(memory.view(second, QVM_USER_COMMAND_BYTES), command);
      return 1;
    }
    case 56: active.setUserCmdValue(first, sensitivity); return 0;
    default: return null;
  }
}
