/*
 * UI_LoadMods, UI_LoadMovies and UI_LoadDemos from id Software's code/ui/ui_main.c.
 * Q_strupr from game/q_shared.c uses the QVM bg_lib.c ASCII toupper profile.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { CommonFileState } from "../../assets/filesystem-state.ts";
import type { CvarRegistry } from "../../core/cvar.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { gameFormat } from "../../game/format.ts";
import type { TeamArenaUiMemory } from "./memory.ts";
import { UiMemoryAllocation } from "./memory.ts";
import type { UiStringReference } from "./memory.ts";

export class TeamArenaMod {
  readonly strings = UiMemoryAllocation.zeroed(8);
  get modName(): string | null { return this.strings.getString(0) ?? null; }
  set modName(value: string | null) { this.strings.setString(0, value ?? undefined); }
  get modDescr(): string | null { return this.strings.getString(4) ?? null; }
  set modDescr(value: string | null) { this.strings.setString(4, value ?? undefined); }
}
export interface TeamArenaListServices {
  readonly files: CommonFileState;
  readonly cvars: CvarRegistry;
  readonly memory: TeamArenaUiMemory;
  readonly assertActive: () => void;
}

function byteAt(bytes: Uint8Array, index: number): number {
  const byte = bytes[index];
  if (byte === undefined) throw new RangeError(`Team Arena list read outside its ${bytes.length}-byte source buffer at ${index}`);
  return byte;
}

function stringAt(bytes: Uint8Array, offset: number): { readonly text: string; readonly end: number } {
  let end = offset;
  while (byteAt(bytes, end) !== 0) end++;
  return { text: String.fromCharCode(...bytes.subarray(offset, end)), end };
}

function upper(byte: number): number { return byte >= 97 && byte <= 122 ? byte - 32 : byte; }

/** Q_stricmp stops at the first unequal byte, including a previous filename's NUL. */
function suffixAt(bytes: Uint8Array, offset: number, suffix: string): boolean {
  for (let index = 0; ; index++) {
    const byte = byteAt(bytes, offset + index), expected = index < suffix.length ? suffix.charCodeAt(index) : 0;
    if (upper(byte) !== upper(expected)) return false;
    if (byte === 0) return true;
  }
}

function displayName(bytes: Uint8Array, offset: number, originalEnd: number, suffix: string): string {
  const suffixOffset = originalEnd - suffix.length;
  if (suffixAt(bytes, suffixOffset, suffix)) bytes[suffixOffset] = 0;
  for (let index = offset; byteAt(bytes, index) !== 0; index++) bytes[index] = upper(byteAt(bytes, index));
  return stringAt(bytes, offset).text;
}

/** Retained UI rows; callers run each loader within the current serialized UI operation. */
export class TeamArenaLists {
  readonly modList: readonly TeamArenaMod[] = Array.from({ length: 64 }, () => new TeamArenaMod());
  private readonly movieStrings = UiMemoryAllocation.zeroed(256 * 4);
  private readonly demoStrings = UiMemoryAllocation.zeroed(256 * 4);
  private readonly movies = this.movieStrings.stringArray(0, 256);
  private readonly demos = this.demoStrings.stringArray(0, 256);
  modCount = 0;
  movieCount = 0;
  demoCount = 0;

  constructor(private readonly services: TeamArenaListServices) {}

  get movieList(): readonly (string | null)[] { return this.movies; }
  get demoList(): readonly (string | null)[] { return this.demos; }

  private allocate(text: string): UiStringReference | undefined {
    this.services.assertActive();
    const allocated = this.services.memory.stringAllocReference(text);
    this.services.assertActive();
    return allocated ?? undefined;
  }

  loadMods(): void {
    const services = this.services, list = new Uint8Array(2048);
    services.assertActive();
    this.modCount = 0;
    const count = services.files.current.getFileList("$modlist", "", list);
    services.assertActive();
    let offset = 0;
    for (let index = 0; index < count; index++) {
      const directory = stringAt(list, offset), row = this.modList[this.modCount];
      if (row === undefined) throw new RangeError("UI_LoadMods write exceeds the source 64-entry mod array");
      row.strings.setString(0, this.allocate(directory.text));
      const description = stringAt(list, directory.end + 1);
      row.strings.setString(4, this.allocate(description.text));
      offset = description.end + 1;
      this.modCount++;
      if (this.modCount >= 64) break;
    }
  }

  loadMovies(): void {
    const services = this.services, list = new Uint8Array(4096);
    services.assertActive();
    const count = services.files.current.getFileList("video", "roq", list);
    services.assertActive();
    this.movieCount = count;
    if (this.movieCount > 256) this.movieCount = 256;
    let offset = 0;
    for (let index = 0; index < this.movieCount; index++) {
      const original = stringAt(list, offset);
      this.movieStrings.setString(index * 4, this.allocate(displayName(list, offset, original.end, ".roq")));
      offset = original.end + 1;
    }
  }

  private protocol(): number {
    const value = this.services.cvars.get("protocol")?.numericValue ?? 0;
    this.services.assertActive();
    return qvmFloatToInt(value);
  }

  loadDemos(): void {
    const services = this.services, list = new Uint8Array(4096);
    services.assertActive();
    const extension = gameFormat("dm_%d", [this.protocol()], 32);
    const count = services.files.current.getFileList("demos", extension, list);
    services.assertActive();
    this.demoCount = count;
    const suffix = gameFormat(".dm_%d", [this.protocol()], 32);
    if (this.demoCount > 256) this.demoCount = 256;
    let offset = 0;
    for (let index = 0; index < this.demoCount; index++) {
      const original = stringAt(list, offset);
      this.demoStrings.setString(index * 4, this.allocate(displayName(list, offset, original.end, suffix)));
      offset = original.end + 1;
    }
  }
}
