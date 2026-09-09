/*
 * PC traps from id Software cl_cgame.c, cl_ui.c and sv_game.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { BotScriptSources } from "../botlib/script-sources.ts";
import type { QvmMemory } from "./memory.ts";
import { QVM_SCRIPT_TOKEN_BYTES, writeQvmScriptToken } from "./script-record.ts";

/** All three VM roles borrow the library's source handles and global definitions. */
export function qvmScriptSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, sources: BotScriptSources,
): number | null {
  const trap = words.getInt32(0, true);
  const define = role === "game" ? 204 : role === "cgame" ? 64 : 57;
  if (trap === define) return Number(sources.globals.add(memory.readString(words.getInt32(4, true))));
  const load = role === "game" ? 578 : role === "cgame" ? 65 : 58;
  switch (trap - load) {
    case 0: {
      const filenameWord = words.getInt32(4, true);
      return sources.loadSourceHandle(() => memory.readString(filenameWord));
    }
    case 1: return Number(sources.freeSourceHandle(words.getInt32(4, true)));
    case 2: {
      const handle = words.getInt32(4, true), outputWord = words.getInt32(8, true);
      const result = sources.readTokenHandleResult(handle);
      if (result === undefined) return 0;
      writeQvmScriptToken(memory.view(outputWord, QVM_SCRIPT_TOKEN_BYTES), result.token);
      return Number(result.read);
    }
    case 3: {
      const handle = words.getInt32(4, true), filenameWord = words.getInt32(8, true), lineWord = words.getInt32(12, true);
      const position = sources.sourceFileAndLine(handle);
      if (position === undefined) return 0;
      const terminator = position.filename.indexOf("\0");
      const length = terminator < 0 ? position.filename.length : terminator;
      memory.writeBoundedString(filenameWord, position.filename, length + 1);
      memory.view(lineWord, 4).setInt32(0, position.line, true);
      return 1;
    }
    default: return null;
  }
}
