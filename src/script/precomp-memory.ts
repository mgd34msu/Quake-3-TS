/*
 * Token and define ownership from Quake III Arena botlib/l_precomp.c/h.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { ScriptMemory, ScriptMemoryAllocation } from "./memory.ts";
import { SOURCE_TOKEN_BYTES, SourceTokenMemory, type SourceTokenContext } from "./token-memory.ts";

export const SOURCE_DEFINE_BYTES = 32;

export class PrecompToken {
  readonly token: SourceTokenMemory;
  context: SourceTokenContext = { path: "", column: 1, leadingWhitespace: "" };
  unsupported: string | undefined;

  constructor(readonly id: number, readonly allocation: ScriptMemoryAllocation) {
    this.token = new SourceTokenMemory(() => allocation.bytes);
  }

  copyFrom(other: PrecompToken): void {
    this.token.copyFrom(other.token);
    this.context = other.context;
    this.unsupported = other.unsupported;
  }

  clearWhitespace(): void {
    this.token.whitespaceStart = 0;
    this.token.whitespaceEnd = 0;
    this.token.linesCrossed = 0;
    this.context = { path: this.context.path, column: this.context.column, leadingWhitespace: "" };
  }
}

export function localToken(): PrecompToken {
  return new PrecompToken(0, { bytes: new Uint8Array(SOURCE_TOKEN_BYTES) });
}

export class PrecompDefine {
  private cachedView: DataView | null = null;

  constructor(readonly id: number, readonly allocation: ScriptMemoryAllocation, readonly owner: PrecompMemory) {}

  get name(): string {
    const bytes = this.allocation.bytes;
    const start = this.view.getUint32(0, true);
    if (start >= bytes.length) throw new RangeError("define name pointer is outside its allocation");
    let name = "";
    for (let index = start; index < bytes.length; index++) {
      const value = bytes[index];
      if (value === undefined) throw new RangeError("define name is outside its allocation");
      if (value === 0) return name;
      name += String.fromCharCode(value);
    }
    throw new RangeError("define name has no terminator in its allocation");
  }
  get flags(): number { return this.view.getInt32(4, true); }
  set flags(value: number) { this.view.setInt32(4, value, true); }
  get builtin(): number { return this.view.getInt32(8, true); }
  set builtin(value: number) { this.view.setInt32(8, value, true); }
  get numparms(): number { return this.view.getInt32(12, true); }
  set numparms(value: number) { this.view.setInt32(12, value, true); }
  get parms(): number { return this.view.getUint32(16, true); }
  set parms(value: number) { this.view.setUint32(16, value, true); }
  get tokens(): number { return this.view.getUint32(20, true); }
  set tokens(value: number) { this.view.setUint32(20, value, true); }
  get next(): number { return this.view.getUint32(24, true); }
  set next(value: number) { this.view.setUint32(24, value, true); }
  get hashnext(): number { return this.view.getUint32(28, true); }
  set hashnext(value: number) { this.view.setUint32(28, value, true); }
  get fixed(): boolean { return (this.flags & 1) !== 0; }

  parameterIndex(name: string): number {
    let index = 0;
    for (const parameter of this.owner.chain(this.parms)) {
      if (parameter.token.string === name) return index;
      index++;
    }
    return -1;
  }

  private get view(): DataView {
    const bytes = this.allocation.bytes;
    let view = this.cachedView;
    if (view === null || view.buffer !== bytes.buffer || view.byteOffset !== bytes.byteOffset || view.byteLength !== bytes.byteLength) {
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.cachedView = view;
    }
    return view;
  }
}

/** IDs resolve only within this owner. Every list consumer reads its next word
 * from the actual allocation; maps retain identities, not token/define values. */
export class PrecompMemory {
  private readonly tokens = new Map<number, PrecompToken>();
  private readonly defines = new Map<number, PrecompDefine>();
  private nextToken = 1;
  private nextDefine = 1;

  constructor(private readonly memory: ScriptMemory | undefined) {}

  copyToken(token: PrecompToken): PrecompToken {
    const copied = new PrecompToken(this.nextToken++, this.allocate(SOURCE_TOKEN_BYTES));
    copied.copyFrom(token);
    copied.token.next = 0;
    this.tokens.set(copied.id, copied);
    return copied;
  }

  token(id: number): PrecompToken {
    const token = this.tokens.get(id);
    if (token === undefined) throw new RangeError("source token pointer does not identify a live token");
    return token;
  }

  *chain(head: number): Generator<PrecompToken, undefined, undefined> {
    let remaining = this.tokens.size + 1;
    for (let id = head; id !== 0;) {
      if (--remaining === 0) throw new RangeError("source token chain contains a cycle");
      const token = this.token(id);
      yield token;
      id = token.token.next;
    }
  }

  freeToken(token: PrecompToken): void {
    this.memory?.free(token.allocation);
    this.tokens.delete(token.id);
  }

  freeTokens(head: number): void {
    for (let id = head; id !== 0;) {
      const token = this.token(id);
      id = token.token.next;
      this.freeToken(token);
    }
  }

  allocateDefine(name: string, clear: boolean): PrecompDefine {
    return this.createDefine(() => name, clear);
  }

  private createDefine(readName: () => string, clear: boolean): PrecompDefine {
    const allocation = this.allocate(SOURCE_DEFINE_BYTES + readName().length + 1);
    const bytes = allocation.bytes;
    if (clear) bytes.fill(0, 0, SOURCE_DEFINE_BYTES);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(0, SOURCE_DEFINE_BYTES, true);
    const name = readName();
    if (SOURCE_DEFINE_BYTES + name.length >= bytes.length) throw new RangeError("copied define name exceeds its reached allocation");
    for (let index = 0; index < name.length; index++) {
      const value = name.charCodeAt(index);
      if (value > 255) throw new RangeError("define name must contain source bytes");
      bytes[SOURCE_DEFINE_BYTES + index] = value;
    }
    bytes[SOURCE_DEFINE_BYTES + name.length] = 0;
    const define = new PrecompDefine(this.nextDefine++, allocation, this);
    this.defines.set(define.id, define);
    return define;
  }

  define(id: number): PrecompDefine {
    const define = this.defines.get(id);
    if (define === undefined) throw new RangeError("source define pointer does not identify a live definition");
    return define;
  }

  copyDefine(define: PrecompDefine): PrecompDefine {
    const copied = this.createDefine(() => define.name, false);
    copied.flags = define.flags;
    copied.builtin = define.builtin;
    copied.numparms = define.numparms;
    copied.next = 0;
    copied.hashnext = 0;
    copied.tokens = 0;
    let last: PrecompToken | undefined;
    for (const token of define.owner.chain(define.tokens)) {
      const next = this.copyToken(token);
      if (last === undefined) copied.tokens = next.id;
      else last.token.next = next.id;
      last = next;
    }
    copied.parms = 0;
    last = undefined;
    for (const token of define.owner.chain(define.parms)) {
      const next = this.copyToken(token);
      if (last === undefined) copied.parms = next.id;
      else last.token.next = next.id;
      last = next;
    }
    return copied;
  }

  freeDefine(define: PrecompDefine): void {
    this.freeTokens(define.parms);
    this.freeTokens(define.tokens);
    this.memory?.free(define.allocation);
    this.defines.delete(define.id);
  }

  private allocate(size: number): ScriptMemoryAllocation {
    return this.memory === undefined ? { bytes: new Uint8Array(size) } : this.memory.allocate(size, "heap", false);
  }
}
