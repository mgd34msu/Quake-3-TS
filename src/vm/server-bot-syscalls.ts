/*
 * Server bot traps from id Software's server/sv_game.c, server/sv_bot.c
 * and server/sv_client.c:SV_ClientThink.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { ServerBotAdapter } from "../server/bot-adapter.ts";
import { runCalls } from "../core/call-steps.ts";
import type { QvmMemory } from "./memory.ts";
import { QVM_USER_COMMAND_BYTES, readQvmUserCommand } from "./user-command.ts";

export type QvmServerBotServices = Pick<ServerBotAdapter, "getSnapshotEntity" | "getConsoleMessage" | "userCommand">;

/** Borrows canonical server clients, reliable rings and snapshot entity storage. */
export function qvmServerBotSyscall(
  role: "game" | "cgame" | "ui",
  words: DataView,
  memory: QvmMemory,
  services: QvmServerBotServices,
): number | Promise<number> | null {
  if (role !== "game") return null;
  switch (words.getInt32(0, true)) {
    case 209: {
      const client = words.getInt32(4, true), sequence = words.getInt32(8, true);
      return services.getSnapshotEntity(client, sequence);
    }
    case 210: {
      const client = words.getInt32(4, true), outputWord = words.getInt32(8, true), size = words.getInt32(12, true);
      // The real reliable ring stores at most 1023 text bytes. Consume its slot
      // before resolving the destination or validating Q_strncpyz's capacity.
      const text = services.getConsoleMessage(client);
      if (text === null) return 0;
      memory.writeString(outputWord, text, size);
      return 1;
    }
    case 211: {
      const client = words.getInt32(4, true), commandWord = words.getInt32(8, true);
      // Source copies the command even for inactive clients. The owner selects
      // its client before resolving and reading the command bytes.
      const result = runCalls(services.userCommand(client, () => readQvmUserCommand(memory.view(commandWord, QVM_USER_COMMAND_BYTES))));
      return result instanceof Promise ? result.then(() => 0) : 0;
    }
    default: return null;
  }
}
