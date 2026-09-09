/*
 * Source and indent storage from Quake III Arena botlib/l_precomp.c/h.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { ScriptMemory, ScriptMemoryAllocation } from "./memory.ts";
import type { ScriptPunctuation } from "./lexer.ts";
import { localToken, PrecompToken } from "./precomp-memory.ts";

export const SOURCE_RECORD_BYTES = 3144;
export const SOURCE_DEFINE_HASH_BUCKETS = 1024;
const SOURCE_INDENT_BYTES = 16;
const SOURCE_PATH_BYTES = 64;
const SOURCE_FILENAME = 0;
const SOURCE_INCLUDE_PATH = 1024;
const SOURCE_PUNCTUATIONS = 2048;
const SOURCE_SCRIPT_STACK = 2052;
const SOURCE_TOKENS = 2056;
const SOURCE_DEFINE_HASH = 2064;
const SOURCE_INDENT_STACK = 2068;
const SOURCE_SKIP = 2072;

export enum SourceIndentType {
  If = 1,
  Else = 2,
  Elif = 4,
  Ifdef = 8,
  Ifndef = 16,
}

type SourceBacking =
  | { readonly kind: "heap"; readonly allocation: ScriptMemoryAllocation }
  | { readonly kind: "managed"; filename: string; includePath: string; script: number; tokens: number; indent: number; skip: number };
type HashBacking =
  | { readonly kind: "heap"; readonly memory: ScriptMemory; readonly allocation: ScriptMemoryAllocation }
  | { readonly kind: "managed"; readonly heads: Map<number, number> };
type IndentBacking =
  | { readonly kind: "heap"; readonly memory: ScriptMemory; readonly allocation: ScriptMemoryAllocation }
  | { readonly kind: "managed"; type: number; skip: number; script: number; next: number };

class SourceIndent {
  private cachedView: DataView | null = null;

  constructor(readonly id: number, private readonly backing: IndentBacking) {}

  get type(): SourceIndentType {
    const value = this.backing.kind === "heap" ? this.view.getInt32(0, true) : this.backing.type;
    switch (value) {
      case SourceIndentType.If: case SourceIndentType.Else: case SourceIndentType.Elif:
      case SourceIndentType.Ifdef: case SourceIndentType.Ifndef: return value;
      default: throw new RangeError("source indent has an unsupported directive type");
    }
  }
  set type(value: SourceIndentType) {
    if (this.backing.kind === "heap") this.view.setInt32(0, value, true);
    else this.backing.type = value;
  }
  get skip(): number { return this.backing.kind === "heap" ? this.view.getInt32(4, true) : this.backing.skip; }
  set skip(value: number) {
    if (this.backing.kind === "heap") this.view.setInt32(4, value, true);
    else this.backing.skip = value | 0;
  }
  get script(): number { return this.backing.kind === "heap" ? this.view.getUint32(8, true) : this.backing.script; }
  set script(value: number) {
    if (this.backing.kind === "heap") this.view.setUint32(8, value, true);
    else this.backing.script = value;
  }
  get next(): number { return this.backing.kind === "heap" ? this.view.getUint32(12, true) : this.backing.next; }
  set next(value: number) {
    if (this.backing.kind === "heap") this.view.setUint32(12, value, true);
    else this.backing.next = value;
  }
  free(): void { if (this.backing.kind === "heap") this.backing.memory.free(this.backing.allocation); }

  private get view(): DataView {
    if (this.backing.kind !== "heap") throw new Error("diagnostic indent has no source allocation");
    const bytes = this.backing.allocation.bytes;
    let view = this.cachedView;
    if (view === null || view.buffer !== bytes.buffer || view.byteOffset !== bytes.byteOffset || view.byteLength !== bytes.byteLength) {
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.cachedView = view;
    }
    return view;
  }
}

/** Pointer words resolve owner-local IDs. Hash heads, script/indent links and
 * skip are read from the source allocation at every reached consumer. */
export class SourceRecord {
  readonly token: PrecompToken;
  private readonly backing: SourceBacking;
  private readonly hash: HashBacking;
  private readonly indents = new Map<number, SourceIndent>();
  private nextIndent = 1;
  private cachedView: DataView | null = null;
  private cachedHashView: DataView | null = null;
  private borrowedPunctuations: readonly ScriptPunctuation[] | null = null;

  constructor(filename: string, script: number, private readonly memory: ScriptMemory | undefined, lifetime: "heap" | "stack") {
    if (memory !== undefined && lifetime === "heap") {
      const allocation = memory.allocate(SOURCE_RECORD_BYTES, "heap", false);
      allocation.bytes.fill(0);
      this.backing = { kind: "heap", allocation };
      this.token = new PrecompToken(0, { get bytes() { return allocation.bytes.subarray(2076, SOURCE_RECORD_BYTES); } });
      this.copyPath(SOURCE_FILENAME, filename);
      this.script = script;
    } else {
      this.backing = { kind: "managed", filename, includePath: "", script, tokens: 0, indent: 0, skip: 0 };
      this.token = localToken();
    }
    if (memory === undefined) {
      this.hash = { kind: "managed", heads: new Map<number, number>() };
    } else {
      this.hash = { kind: "heap", memory, allocation: memory.allocate(SOURCE_DEFINE_HASH_BUCKETS * 4, "heap", true) };
      if (this.backing.kind === "heap") this.view.setUint32(SOURCE_DEFINE_HASH, 1, true);
    }
  }

  get filename(): string { return this.backing.kind === "heap" ? this.readPath(SOURCE_FILENAME) : this.backing.filename; }
  setPunctuations(punctuations: readonly ScriptPunctuation[] | null): void {
    if (this.backing.kind === "heap") this.view.setUint32(SOURCE_PUNCTUATIONS, punctuations === null ? 0 : 1, true);
    this.borrowedPunctuations = punctuations;
  }
  get punctuations(): readonly ScriptPunctuation[] | null {
    if (this.backing.kind === "managed") return this.borrowedPunctuations;
    const pointer = this.view.getUint32(SOURCE_PUNCTUATIONS, true);
    if (pointer === 0) return null;
    if (pointer !== 1 || this.borrowedPunctuations === null) throw new RangeError("source punctuation pointer does not identify its borrowed table");
    return this.borrowedPunctuations;
  }
  get tokens(): number { return this.backing.kind === "heap" ? this.view.getUint32(SOURCE_TOKENS, true) : this.backing.tokens; }
  set tokens(value: number) {
    if (this.backing.kind === "heap") this.view.setUint32(SOURCE_TOKENS, value, true);
    else this.backing.tokens = value;
  }
  get includePath(): string { return this.backing.kind === "heap" ? this.readPath(SOURCE_INCLUDE_PATH) : this.backing.includePath; }
  setIncludePath(path: string): void {
    if (this.backing.kind === "managed") {
      const zero = path.indexOf("\0");
      const value = (zero < 0 ? path : path.slice(0, zero)).slice(0, SOURCE_PATH_BYTES);
      this.backing.includePath = value.endsWith("/") || value.endsWith("\\") ? value : value + "/";
      return;
    }
    this.copyPath(SOURCE_INCLUDE_PATH, path);
    const value = this.includePath;
    if (!value.endsWith("/") && !value.endsWith("\\")) {
      if (value.length + 1 >= 1024) throw new RangeError("source include path exceeds its allocation");
      const bytes = this.backing.allocation.bytes;
      bytes[SOURCE_INCLUDE_PATH + value.length] = 47;
      bytes[SOURCE_INCLUDE_PATH + value.length + 1] = 0;
    }
  }

  get script(): number { return this.backing.kind === "heap" ? this.view.getUint32(SOURCE_SCRIPT_STACK, true) : this.backing.script; }
  set script(value: number) {
    if (this.backing.kind === "heap") this.view.setUint32(SOURCE_SCRIPT_STACK, value, true);
    else this.backing.script = value;
  }
  get skip(): number { return this.backing.kind === "heap" ? this.view.getInt32(SOURCE_SKIP, true) : this.backing.skip; }
  set skip(value: number) {
    if (this.backing.kind === "heap") this.view.setInt32(SOURCE_SKIP, value, true);
    else this.backing.skip = value | 0;
  }

  hashHead(bucket: number): number {
    if (this.hash.kind === "managed") return this.hash.heads.get(bucket) ?? 0;
    return this.hashView.getUint32(bucket * 4, true);
  }
  setHashHead(bucket: number, id: number): void {
    if (this.hash.kind === "managed") {
      if (id === 0) this.hash.heads.delete(bucket);
      else this.hash.heads.set(bucket, id);
    } else this.hashView.setUint32(bucket * 4, id, true);
  }

  hasCurrentIndent(): boolean { return this.topIndent?.script === this.script; }

  pushIndent(type: SourceIndentType, skip: boolean): void {
    const backing: IndentBacking = this.memory === undefined
      ? { kind: "managed", type: 0, skip: 0, script: 0, next: 0 }
      : { kind: "heap", memory: this.memory, allocation: this.memory.allocate(SOURCE_INDENT_BYTES, "heap", false) };
    const indent = new SourceIndent(this.nextIndent++, backing);
    this.indents.set(indent.id, indent);
    indent.type = type;
    indent.script = this.script;
    indent.skip = skip ? 1 : 0;
    this.skip += indent.skip;
    indent.next = this.indent;
    this.indent = indent.id;
  }

  popIndent(): { readonly type: SourceIndentType; readonly skip: number } | undefined {
    const indent = this.topIndent;
    if (indent === undefined || indent.script !== this.script) return undefined;
    const result = { type: indent.type, skip: indent.skip };
    this.indent = indent.next;
    this.skip -= indent.skip;
    this.indents.delete(indent.id);
    indent.free();
    return result;
  }

  freeIndents(): void {
    let indent: SourceIndent | undefined;
    while ((indent = this.topIndent) !== undefined) {
      this.indent = indent.next;
      this.indents.delete(indent.id);
      indent.free();
    }
  }

  freeHash(): void {
    if (this.hash.kind !== "heap") return;
    if (this.backing.kind === "heap") {
      const pointer = this.view.getUint32(SOURCE_DEFINE_HASH, true);
      if (pointer === 0) return;
      if (pointer !== 1) throw new RangeError("source define hash pointer does not identify its allocation");
    }
    this.hash.memory.free(this.hash.allocation);
  }

  freeRecord(): void {
    if (this.backing.kind === "heap" && this.memory !== undefined) this.memory.free(this.backing.allocation);
  }

  private get indent(): number { return this.backing.kind === "heap" ? this.view.getUint32(SOURCE_INDENT_STACK, true) : this.backing.indent; }
  private set indent(value: number) {
    if (this.backing.kind === "heap") this.view.setUint32(SOURCE_INDENT_STACK, value, true);
    else this.backing.indent = value;
  }
  private get topIndent(): SourceIndent | undefined {
    const id = this.indent;
    if (id === 0) return undefined;
    const indent = this.indents.get(id);
    if (indent === undefined) throw new RangeError("source indent pointer does not identify a live allocation");
    return indent;
  }
  private get hashView(): DataView {
    if (this.hash.kind !== "heap") throw new Error("diagnostic source has no define hash allocation");
    if (this.backing.kind === "heap" && this.view.getUint32(SOURCE_DEFINE_HASH, true) !== 1) {
      throw new RangeError("source define hash pointer does not identify its allocation");
    }
    const bytes = this.hash.allocation.bytes;
    let view = this.cachedHashView;
    if (view === null || view.buffer !== bytes.buffer || view.byteOffset !== bytes.byteOffset || view.byteLength !== bytes.byteLength) {
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.cachedHashView = view;
    }
    return view;
  }
  private get view(): DataView {
    if (this.backing.kind !== "heap") throw new Error("stack source has no heap record");
    const bytes = this.backing.allocation.bytes;
    let view = this.cachedView;
    if (view === null || view.buffer !== bytes.buffer || view.byteOffset !== bytes.byteOffset || view.byteLength !== bytes.byteLength) {
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.cachedView = view;
    }
    return view;
  }
  private copyPath(offset: number, path: string): void {
    if (this.backing.kind !== "heap") throw new Error("stack source has no heap path");
    const bytes = this.backing.allocation.bytes;
    let ended = false;
    for (let index = 0; index < SOURCE_PATH_BYTES; index++) {
      const character = ended || index >= path.length ? 0 : path.charCodeAt(index);
      if (character > 255) throw new RangeError("source path requires source byte characters");
      bytes[offset + index] = character;
      if (character === 0) ended = true;
    }
  }
  private readPath(offset: number): string {
    if (this.backing.kind !== "heap") throw new Error("stack source has no heap path");
    const bytes = this.backing.allocation.bytes;
    let text = "";
    for (let index = 0; index < 1024; index++) {
      const character = bytes[offset + index];
      if (character === undefined) throw new RangeError("source path is outside its allocation");
      if (character === 0) return text;
      text += String.fromCharCode(character);
    }
    throw new RangeError("source path lacks its terminator");
  }
}
