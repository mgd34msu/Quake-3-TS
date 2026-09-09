/*
 * Filesystem traps from Quake III Arena sv_game.c, cl_cgame.c and cl_ui.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import { CommonError } from "../core/common-error.ts";
import type { CommonFileState, FileOpenMode } from "../assets/filesystem-state.ts";
import type { QvmMemory } from "./memory.ts";

function openMode(word: number): FileOpenMode {
  switch (word) {
    case 0: return "read";
    case 1: return "write";
    case 2: return "append";
    case 3: return "append-sync";
    default: throw new CommonError("fatal", "FSH_FOpenFile: bad mode");
  }
}

function buffer(memory: QvmMemory, pointer: number, length: number): Uint8Array {
  // A zero-length source read/write does not dereference its buffer.
  return pointer === 0 && length === 0 ? new Uint8Array(0) : memory.span(pointer, length);
}

/** FS_READ/WRITE discard the byte count in all three source dispatchers. */
export function qvmFilesystemSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, files: CommonFileState,
): number | null {
  const trap = words.getInt32(0, true), open = role === "ui" ? 13 : 10;
  const seek = role === "ui" ? 86 : role === "cgame" ? 89 : 45;
  const list = role === "ui" ? 17 : role === "game" ? 38 : null;
  if (trap !== open && trap !== open + 1 && trap !== open + 2 && trap !== open + 3 && trap !== seek && trap !== list) return null;
  files.assertInitialized();
  if (trap === open) {
    const pathWord = words.getInt32(4, true), fileWord = words.getInt32(8, true), mode = openMode(words.getInt32(12, true));
    const destination = fileWord === 0 ? null : memory.view(fileWord, 4);
    if (destination === null && mode !== "read") throw new RangeError("Writable file open requires a nonnull handle pointer");
    if (pathWord === 0) throw new CommonError("fatal", "FS_FOpenFileRead: NULL 'filename' parameter passed\n");
    const path = memory.readString(pathWord);
    if (destination === null) return files.current.has(path) ? 1 : 0;
    const opened = files.openByMode(path, mode, file => { destination.setInt32(0, file === null ? 0 : file.slot, true); });
    return opened === undefined ? -1 : opened.length;
  }
  if (trap === open + 1 || trap === open + 2) {
    const pointer = words.getInt32(4, true), length = words.getInt32(8, true), file = words.getInt32(12, true);
    // FS_Read2/FS_Write return before inspecting the buffer when handle is zero.
    const bytes = file === 0 ? new Uint8Array(0) : buffer(memory, pointer, length);
    if (trap === open + 1) files.readFile(file, bytes);
    else files.writeFile(file, bytes);
    return 0;
  }
  if (trap === open + 3) { files.closeFile(words.getInt32(4, true)); return 0; }
  if (trap === seek) return files.seekFile(words.getInt32(4, true), words.getInt32(8, true), words.getInt32(12, true));
  const path = memory.readString(words.getInt32(4, true)), extension = memory.readString(words.getInt32(8, true));
  return files.current.getFileList(path, extension, memory.span(words.getInt32(12, true), words.getInt32(16, true)));
}
