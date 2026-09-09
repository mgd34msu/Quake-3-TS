// Ported from id Software's code/qcommon/files.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { nativeAtoi } from "../core/native-numeric.ts";
import { tokenizeCommand } from "../core/text.ts";

const ALL_REFERENCE_FLAGS = 0x0f;
const BIG_INFO_PAYLOAD_LENGTH = 8_191;
const MAX_SEARCH_PATHS = 4_096;

export enum PakReferenceFlag {
  General = 0x01,
  Ui = 0x02,
  Cgame = 0x04,
  Qagame = 0x08,
}

export interface PakCatalogEntry {
  readonly game: string;
  readonly basename: string;
  readonly archivePath: string;
  readonly checksum: number;
  readonly pureChecksum: number;
}

export interface PakReferenceSnapshot {
  readonly pack: PakCatalogEntry;
  readonly flags: number;
}

export interface ServerPak {
  readonly checksum: number;
  readonly name: string | null;
}

/** FS_PureServerSetLoadedPaks/ReferencedPaks retain separate source checksum and name cells. */
export class ServerPakSet {
  private sums: readonly number[] = [];
  private readonly names: (string | null)[] = [];

  get checksums(): readonly number[] { return this.sums; }

  setChecksums(text: string): number {
    this.sums = Object.freeze(tokenizeCommand(text).slice(0, MAX_SEARCH_PATHS).map(nativeAtoi));
    return this.sums.length;
  }

  setNames(text: string, clearCount = this.sums.length): void {
    for (let index = 0; index < clearCount; index++) this.names[index] = null;
    const names = tokenizeCommand(text).slice(0, MAX_SEARCH_PATHS);
    for (const [index, name] of names.entries()) this.names[index] = name;
  }

  snapshot(): readonly ServerPak[] {
    return Object.freeze(this.sums.map((checksum, index) => Object.freeze({ checksum, name: this.names[index] ?? null })));
  }
}

export type PureSearchPath<T> = PureDirectorySearchPath<T> | PurePakSearchPath<T>;

export interface PureDirectorySearchPath<T> {
  readonly kind: "directory";
  readonly value: T;
}

export interface PurePakSearchPath<T> {
  readonly kind: "pak";
  readonly value: T;
  readonly checksum: number;
}

interface PakReferenceState {
  readonly pack: PakCatalogEntry;
  flags: number;
}

class BigInfoString {
  private value = "";

  append(text: string): void {
    const remaining = BIG_INFO_PAYLOAD_LENGTH - this.value.length;
    if (remaining > 0) this.value += text.slice(0, remaining);
  }

  get nonempty(): boolean {
    return this.value.length > 0;
  }

  result(): string {
    return this.value;
  }
}

function checksumPattern(value: number, label: string): number {
  if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0xffff_ffff) {
    throw new RangeError(`${label} must be a signed or unsigned 32-bit integer`);
  }
  return value >>> 0;
}

function signedChecksum(value: number): string {
  return String(value | 0);
}

function asciiLowerCode(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

function suffixEquals(path: string, suffix: string): boolean {
  if (path.length < suffix.length) return false;
  const offset = path.length - suffix.length;
  for (let index = 0; index < suffix.length; index++) {
    if (asciiLowerCode(path.charCodeAt(offset + index)) !== suffix.charCodeAt(index)) return false;
  }
  return true;
}

function excludesGeneralReference(path: string): boolean {
  return suffixEquals(path, ".shader")
    || suffixEquals(path, ".txt")
    || suffixEquals(path, ".cfg")
    || suffixEquals(path, ".config")
    || path.includes("levelshots")
    || suffixEquals(path, ".bot")
    || suffixEquals(path, ".arena")
    || suffixEquals(path, ".menu");
}

export function allowedPureLoosePath(path: string): boolean {
  return suffixEquals(path, ".cfg")
    || suffixEquals(path, ".menu")
    || suffixEquals(path, ".game")
    || suffixEquals(path, ".dm_68")
    || suffixEquals(path, ".dat");
}

function checkedReferenceFlags(flags: number): number {
  if (!Number.isInteger(flags) || flags < 0 || flags > ALL_REFERENCE_FLAGS) {
    throw new RangeError(`Pak reference flags must use only the mask ${ALL_REFERENCE_FLAGS}`);
  }
  return flags;
}

function includedInReferencedReport(state: PakReferenceState): boolean {
  return state.flags !== 0 || state.pack.game.slice(0, 6).toLowerCase() !== "baseq3";
}

export function isPakPure(checksum: number, serverChecksums: readonly number[]): boolean {
  const pattern = checksumPattern(checksum, "Pak checksum");
  if (serverChecksums.length === 0) return true;
  let matched = false;
  for (const serverChecksum of serverChecksums) {
    if (pattern === checksumPattern(serverChecksum, "Server pak checksum")) matched = true;
  }
  return matched;
}

export function reorderPurePaks<T>(
  searchPaths: readonly PureSearchPath<T>[],
  serverChecksums: readonly number[],
): readonly PureSearchPath<T>[] {
  const reordered = [...searchPaths];
  for (const searchPath of reordered) {
    if (searchPath.kind === "pak") checksumPattern(searchPath.checksum, "Pak checksum");
  }
  let insertionIndex = 0;
  for (const serverChecksum of serverChecksums) {
    const pattern = checksumPattern(serverChecksum, "Server pak checksum");
    for (let index = insertionIndex; index < reordered.length; index++) {
      const searchPath = reordered[index];
      if (searchPath === undefined) throw new Error("Pure search-path index is invalid");
      if (searchPath.kind !== "pak" || checksumPattern(searchPath.checksum, "Pak checksum") !== pattern) continue;
      reordered.splice(index, 1);
      reordered.splice(insertionIndex, 0, searchPath);
      insertionIndex++;
      break;
    }
  }
  return Object.freeze(reordered);
}

export class PakReferences {
  private states: PakReferenceState[];
  private readonly byPack = new Map<PakCatalogEntry, PakReferenceState>();
  readonly checksumFeed: number;
  private fakeChecksum = 0;

  constructor(options: {
    readonly packs: readonly PakCatalogEntry[];
    readonly checksumFeed: number;
    readonly random: () => number;
  }) {
    this.checksumFeed = checksumPattern(options.checksumFeed, "Checksum feed");
    this.random = options.random;
    this.states = options.packs.map(pack => this.addState(pack));
  }

  private readonly random: () => number;

  private addState(pack: PakCatalogEntry): PakReferenceState {
    checksumPattern(pack.checksum, `Checksum for ${JSON.stringify(pack.archivePath)}`);
    checksumPattern(pack.pureChecksum, `Pure checksum for ${JSON.stringify(pack.archivePath)}`);
    if (this.byPack.has(pack)) throw new RangeError("Pak catalog contains the same identity more than once");
    const state = { pack, flags: 0 } satisfies PakReferenceState;
    this.byPack.set(pack, state);
    return state;
  }

  prependPack(pack: PakCatalogEntry): void {
    this.states.unshift(this.addState(pack));
  }

  reorderPacks(packs: readonly PakCatalogEntry[]): void {
    if (packs.length !== this.states.length || new Set(packs).size !== packs.length) {
      throw new RangeError("Pak reorder must retain every catalog identity exactly once");
    }
    this.states = packs.map(pack => {
      const state = this.byPack.get(pack);
      if (state === undefined) throw new RangeError("Pak reorder contains an unmounted identity");
      return state;
    });
  }

  retainLooseReference(previous: PakReferences): void {
    this.fakeChecksum = previous.fakeChecksum;
  }

  recordPackedOpen(pack: PakCatalogEntry, requestedPath: string): void {
    const state = this.byPack.get(pack);
    if (state === undefined) throw new RangeError("Packed open does not belong to this pak catalog");
    if ((state.flags & PakReferenceFlag.General) === 0 && !excludesGeneralReference(requestedPath)) {
      state.flags |= PakReferenceFlag.General;
    }
    if ((state.flags & PakReferenceFlag.Qagame) === 0 && requestedPath.includes("qagame.qvm")) {
      state.flags |= PakReferenceFlag.Qagame;
    }
    if ((state.flags & PakReferenceFlag.Cgame) === 0 && requestedPath.includes("cgame.qvm")) {
      state.flags |= PakReferenceFlag.Cgame;
    }
    if ((state.flags & PakReferenceFlag.Ui) === 0 && requestedPath.includes("ui.qvm")) {
      state.flags |= PakReferenceFlag.Ui;
    }
  }

  recordLooseOpen(requestedPath: string): void {
    if (allowedPureLoosePath(requestedPath)) return;
    const random = this.random();
    if (!Number.isFinite(random) || random < 0 || random > 1) {
      throw new RangeError("Filesystem random source must return a finite value from 0 through 1");
    }
    this.fakeChecksum = Math.trunc(random);
  }

  clear(flags = 0): void {
    const mask = flags === 0 ? ALL_REFERENCE_FLAGS : checkedReferenceFlags(flags);
    for (const state of this.states) state.flags &= ~mask;
  }

  snapshot(): readonly PakReferenceSnapshot[] {
    return Object.freeze(this.states.map(state => Object.freeze({ pack: state.pack, flags: state.flags })));
  }

  loadedPakChecksums(): string {
    const info = new BigInfoString();
    for (const state of this.states) info.append(`${signedChecksum(state.pack.checksum)} `);
    return info.result();
  }

  loadedPakNames(): string {
    const info = new BigInfoString();
    for (const state of this.states) {
      if (info.nonempty) info.append(" ");
      info.append(state.pack.basename);
    }
    return info.result();
  }

  loadedPakPureChecksums(): string {
    const info = new BigInfoString();
    for (const state of this.states) info.append(`${signedChecksum(state.pack.pureChecksum)} `);
    return info.result();
  }

  referencedPakChecksums(): string {
    const info = new BigInfoString();
    for (const state of this.states) {
      if (includedInReferencedReport(state)) info.append(`${signedChecksum(state.pack.checksum)} `);
    }
    return info.result();
  }

  referencedPakNames(): string {
    const info = new BigInfoString();
    for (const state of this.states) {
      if (info.nonempty) info.append(" ");
      if (includedInReferencedReport(state)) info.append(`${state.pack.game}/${state.pack.basename}`);
    }
    return info.result();
  }

  referencedPakPureChecksums(): string {
    const info = new BigInfoString();
    let checksum = this.checksumFeed;
    let generalCount = 0;
    for (const flag of [PakReferenceFlag.Cgame, PakReferenceFlag.Ui, PakReferenceFlag.General]) {
      if (flag === PakReferenceFlag.General) info.append("@ ");
      for (const state of this.states) {
        if ((state.flags & flag) === 0) continue;
        info.append(`${signedChecksum(state.pack.pureChecksum)} `);
        if (flag === PakReferenceFlag.Cgame || flag === PakReferenceFlag.Ui) break;
        checksum = (checksum ^ state.pack.pureChecksum) >>> 0;
        generalCount++;
      }
      if (this.fakeChecksum !== 0) info.append(`${this.fakeChecksum} `);
    }
    checksum = (checksum ^ generalCount) >>> 0;
    info.append(signedChecksum(checksum));
    return info.result();
  }

  gamePureChecksum(): string {
    let info = "";
    for (const state of this.states) {
      if ((state.flags & PakReferenceFlag.Qagame) !== 0) info = signedChecksum(state.pack.checksum);
    }
    return info;
  }
}
