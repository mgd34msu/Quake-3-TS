/*
 * UI_Alloc, UI_InitMemory, String_Alloc and String_Report from id Software's code/ui/ui_shared.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import { gameFormat } from "../../game/format.ts";
import type { UiItemDefinition, UiMenuDefinition, UiModelReference, UiScript, UiShaderReference, UiSoundReference } from "../menu.ts";

/** A char pointer into retained byte storage; String_Init does not invalidate or clear it. */
export class UiStringReference {
  constructor(private readonly bytes: Uint8Array, readonly offset: number, private readonly pointers?: ReadonlyMap<number, UiMemoryPointer>) {
    if (!Number.isInteger(offset) || offset < 0 || offset >= bytes.length) throw new RangeError("UI string pointer is outside its byte storage");
  }
  read(): string {
    let result = "";
    for (let index = this.offset; index < this.bytes.length; index++) {
      for (let word = index - 3; word <= index; word++) {
        const pointer = this.pointers?.get(word);
        if (pointer !== undefined && !(pointer.kind === "resource" && pointer.handle !== undefined)) {
          throw new RangeError("UI string byte read requires QVM pointer address bits");
        }
      }
      const byte = this.bytes[index];
      if (byte === 0) return result;
      if (byte === undefined) throw new RangeError("UI string byte is outside its storage");
      result += String.fromCharCode(byte);
    }
    throw new RangeError("UI string reads beyond its retained byte storage");
  }
  static literal(text: string): UiStringReference {
    const nul = text.indexOf("\0"), length = nul < 0 ? text.length : nul;
    const bytes = new Uint8Array(length + 1);
    for (let index = 0; index < length; index++) {
      const byte = text.charCodeAt(index);
      if (byte > 255) throw new RangeError("UI string requires source bytes");
      bytes[index] = byte;
    }
    return new UiStringReference(bytes, 0);
  }
}

type UiMemoryPointer =
  | { readonly kind: "string"; readonly value: UiStringReference }
  | { readonly kind: "allocation"; readonly value: UiMemoryAllocation }
  | { readonly kind: "script"; readonly value: UiScript }
  | { readonly kind: "item"; readonly value: UiItemDefinition }
  | { readonly kind: "menu"; readonly value: UiMenuDefinition }
  | { readonly kind: "resource"; readonly value: UiShaderReference | UiModelReference | UiSoundReference; readonly handle: number | undefined };

/** A physical UI_Alloc span. Typed pointers deliberately have no fabricated QVM address bits. */
export class UiMemoryAllocation {
  private readonly view: DataView;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly pointers: Map<number, UiMemoryPointer>,
    readonly offset: number,
    readonly size: number,
  ) {
    if (!Number.isInteger(offset) || !Number.isInteger(size) || offset < 0 || size < 0 || offset + size > bytes.length) {
      throw new RangeError("UI_Alloc borrow is outside the physical memory pool");
    }
    this.view = new DataView(bytes.buffer, bytes.byteOffset + offset, size);
  }

  static zeroed(size: number): UiMemoryAllocation {
    return new UiMemoryAllocation(new Uint8Array(size), new Map<number, UiMemoryPointer>(), 0, size);
  }

  subrecord(offset: number, size: number): UiMemoryAllocation {
    if (!Number.isInteger(offset) || !Number.isInteger(size) || offset < 0 || size < 0 || offset + size > this.size) {
      throw new RangeError("UI record view is outside its retained storage");
    }
    return new UiMemoryAllocation(this.bytes, this.pointers, this.offset + offset, size);
  }

  dereference(size: number): UiMemoryAllocation {
    return new UiMemoryAllocation(this.bytes, this.pointers, this.offset, size);
  }

  clear(): void {
    this.discardPointers(0, this.size);
    this.bytes.fill(0, this.offset, this.offset + this.size);
  }

  getInt32(offset: number): number { this.checkNumeric(offset); return this.view.getInt32(offset, true); }
  getFloat32(offset: number): number { this.checkNumeric(offset); return this.view.getFloat32(offset, true); }
  setInt32(offset: number, value: number): void {
    this.checkWord(offset); this.discardPointers(offset, 4); this.view.setInt32(offset, value, true);
  }
  setFloat32(offset: number, value: number): void {
    this.checkWord(offset); this.discardPointers(offset, 4); this.view.setFloat32(offset, value, true);
  }

  getString(offset: number): string | undefined {
    return this.getStringReference(offset)?.read();
  }

  getStringReference(offset: number): UiStringReference | undefined {
    const pointer = this.pointer(offset);
    if (pointer?.kind === "string") return pointer.value;
    if (pointer !== undefined) throw new Error("UI_Alloc string read aliases a non-string pointer");
    return undefined;
  }

  setString(offset: number, value: string | UiStringReference | undefined): void {
    this.setPointer(offset, value === undefined ? undefined : { kind: "string", value: typeof value === "string" ? UiStringReference.literal(value) : value });
  }

  stringReference(): UiStringReference { return new UiStringReference(this.bytes, this.offset, this.pointers); }

  stringArray(offset: number, count: number): (string | null)[] {
    const values: (string | null)[] = Array.from({ length: count }, () => null);
    for (let index = 0; index < count; index++) {
      this.checkWord(offset + index * 4);
      Object.defineProperty(values, index, {
        enumerable: true,
        get: (): string | null => this.getString(offset + index * 4) ?? null,
        set: (value: string | null): void => { this.setString(offset + index * 4, value ?? undefined); },
      });
    }
    return values;
  }

  writeString(text: string): void {
    const value = UiStringReference.literal(text).read();
    if (value.length >= this.size) throw new RangeError("UI string copy exceeds its allocation");
    this.discardPointers(0, value.length + 1);
    for (let index = 0; index < value.length; index++) this.bytes[this.offset + index] = value.charCodeAt(index);
    this.bytes[this.offset + value.length] = 0;
  }

  setAllocationPointer(offset: number, value: UiMemoryAllocation | undefined): void {
    this.setPointer(offset, value === undefined ? undefined : { kind: "allocation", value });
  }

  isNullPointer(offset: number): boolean {
    this.checkWord(offset);
    const pointer = this.pointers.get(this.offset + offset);
    if (pointer === undefined || pointer.kind === "resource" && pointer.handle !== undefined) {
      this.checkNumeric(offset);
      return this.view.getUint32(offset, true) === 0;
    }
    return false;
  }

  getAllocationPointer(offset: number): UiMemoryAllocation | undefined {
    const pointer = this.pointer(offset);
    if (pointer === undefined || pointer.kind === "allocation") return pointer?.value;
    throw new Error("UI allocation read aliases a different typed pointer");
  }

  getScript(offset: number): UiScript | undefined {
    const pointer = this.pointer(offset);
    if (pointer === undefined || pointer.kind === "script") return pointer?.value;
    throw new Error("UI script read aliases a different typed pointer");
  }

  setScript(offset: number, value: UiScript | undefined): void {
    this.setPointer(offset, value === undefined ? undefined : { kind: "script", value });
  }

  getItem(offset: number): UiItemDefinition | undefined {
    const pointer = this.pointer(offset);
    if (pointer === undefined || pointer.kind === "item") return pointer?.value;
    throw new Error("UI item read aliases a different typed pointer");
  }

  setItem(offset: number, value: UiItemDefinition | undefined): void {
    this.setPointer(offset, value === undefined ? undefined : { kind: "item", value });
  }

  getMenu(offset: number): UiMenuDefinition | undefined {
    const pointer = this.pointer(offset);
    if (pointer === undefined || pointer.kind === "menu") return pointer?.value;
    throw new Error("UI menu read aliases a different typed pointer");
  }

  setMenu(offset: number, value: UiMenuDefinition | undefined): void {
    this.setPointer(offset, value === undefined ? undefined : { kind: "menu", value });
  }

  getResource(offset: number): UiShaderReference | UiModelReference | UiSoundReference | undefined {
    this.checkWord(offset);
    const pointer = this.pointers.get(this.offset + offset);
    if (pointer?.kind === "resource") return pointer.value;
    if (pointer === undefined) { this.checkNumeric(offset); return undefined; }
    throw new Error("UI resource handle read aliases a different typed pointer");
  }

  getResourceHandle(offset: number): number | undefined {
    this.checkWord(offset);
    const pointer = this.pointers.get(this.offset + offset);
    if (pointer?.kind === "resource" && pointer.handle === undefined) return undefined;
    return this.getInt32(offset);
  }

  setResource(offset: number, value: UiShaderReference | UiModelReference | UiSoundReference, handle: number | undefined): void {
    this.setInt32(offset, handle === undefined ? 0 : handle);
    this.pointers.set(this.offset + offset, { kind: "resource", value, handle });
  }

  private pointer(offset: number): UiMemoryPointer | undefined {
    this.checkWord(offset);
    const pointer = this.pointers.get(this.offset + offset);
    if (pointer === undefined || pointer.kind === "resource" && pointer.handle !== undefined) {
      this.checkNumeric(offset);
      if (this.view.getUint32(offset, true) !== 0) throw new Error("UI pointer read contains non-pointer bytes");
      return undefined;
    }
    return pointer;
  }

  private setPointer(offset: number, pointer: UiMemoryPointer | undefined): void {
    this.setInt32(offset, 0);
    if (pointer !== undefined) this.pointers.set(this.offset + offset, pointer);
  }

  private checkWord(offset: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset + 4 > this.size) {
      throw new RangeError("UI_Alloc field is outside the borrowed record");
    }
  }

  private checkNumeric(offset: number): void {
    this.checkWord(offset);
    for (let index = this.offset + offset - 3; index < this.offset + offset + 4; index++) {
      const pointer = this.pointers.get(index);
      if (pointer !== undefined && !(pointer.kind === "resource" && pointer.handle !== undefined)) {
        throw new Error("UI_Alloc numeric read requires QVM pointer address bits");
      }
    }
  }

  private discardPointers(offset: number, size: number): void {
    if (size === 0) return;
    for (let pointer = this.offset + offset - 3; pointer < this.offset + offset + size; pointer++) this.pointers.delete(pointer);
  }
}

/** Source QVM layout: stringDef_t has two 32-bit pointers. Managed heap usage is separate. */
export class TeamArenaUiMemory {
  private readonly bytes: Uint8Array;
  private readonly pointers = new Map<number, UiMemoryPointer>();
  private readonly menus = UiMemoryAllocation.zeroed(64 * 644);
  private readonly buckets: (UiMemoryAllocation | null)[] = Array.from({ length: 2048 }, () => null);
  private readonly strings: Uint8Array;
  private readonly emptyString = UiStringReference.literal("");
  private stringPoint = 0;
  private allocationPoint = 0;
  private exhausted = false;

  constructor(readonly profile: "qvm32", private readonly print: (text: string) => void, readonly module: "ui" | "cgame" = "ui") {
    this.bytes = new Uint8Array(module === "cgame" ? 128 * 1024 : 1024 * 1024);
    this.strings = new Uint8Array(module === "cgame" ? 128 * 1024 : 384 * 1024);
  }

  get stringBytes(): number { return this.stringPoint; }
  get allocatedBytes(): number { return this.allocationPoint; }
  get outOfMemory(): boolean { return this.exhausted; }

  initializeMemory(): void { this.allocationPoint = 0; this.exhausted = false; }

  borrow(offset: number, size: number): UiMemoryAllocation {
    return new UiMemoryAllocation(this.bytes, this.pointers, offset, size);
  }

  menuRecord(index: number): UiMemoryAllocation {
    if (!Number.isInteger(index) || index < 0 || index >= 64) throw new RangeError("UI menu index exceeds the source static array");
    return this.menus.subrecord(index * 644, 644);
  }

  report(): void {
    this.print("Memory/String Pool Info\n");
    this.print("----------------\n");
    const stringPercent = Math.fround(Math.fround(Math.fround(this.stringPoint) / this.strings.length) * 100);
    this.print(gameFormat("String Pool is %.1f%% full, %i bytes out of %i used.\n", [stringPercent, this.stringPoint, this.strings.length]));
    const memoryPercent = Math.fround(Math.fround(Math.fround(this.allocationPoint) / this.bytes.length) * 100);
    this.print(gameFormat("Memory Pool is %.1f%% full, %i bytes out of %i used.\n", [memoryPercent, this.allocationPoint, this.bytes.length]));
  }

  /** Storage part of String_Init. The product controller owns menu and binding resets. */
  initializeStrings(): void {
    this.buckets.fill(null);
    this.stringPoint = 0;
    this.initializeMemory();
  }

  allocate(size: number): number | null {
    if (!Number.isInteger(size) || size < 0 || size > 0x7fffffff - 15) {
      throw new RangeError("UI_Alloc size is outside the source allocation range");
    }
    if (this.allocationPoint + size > this.bytes.length) {
      this.exhausted = true;
      this.print("UI_Alloc: Failure. Out of memory!\n");
      return null;
    }
    const offset = this.allocationPoint;
    this.allocationPoint += (size + 15) & ~15;
    return offset;
  }

  stringAlloc(input: string | null): string | null {
    return this.stringAllocReference(input)?.read() ?? null;
  }

  stringAllocReference(input: string | null): UiStringReference | null {
    if (input === null) return null;
    const nul = input.indexOf("\0");
    const text = nul < 0 ? input : input.slice(0, nul);
    if (text.length === 0) return this.emptyString;
    let hash = 0;
    for (let index = 0; index < text.length; index++) {
      let byte = text.charCodeAt(index);
      if (byte > 255) throw new RangeError("String_Alloc requires source byte strings");
      if (byte >= 65 && byte <= 90) byte += 32;
      if (byte >= 128) byte -= 256;
      hash = (hash + Math.imul(byte, index + 119)) | 0;
    }
    hash &= 2047;
    const first = this.buckets[hash];
    if (first === undefined) throw new RangeError("String_Alloc hash exceeds source table");
    let current = first;
    while (current !== null) {
      const reference = current.getStringReference(4);
      if (reference === undefined) throw new RangeError("String_Alloc compares a NULL stringDef_t string");
      if (reference.read() === text) return reference;
      current = current.getAllocationPointer(0) ?? null;
    }
    if (text.length + this.stringPoint + 1 >= this.strings.length) return null;
    const reference = new UiStringReference(this.strings, this.stringPoint);
    for (let index = 0; index < text.length; index++) this.strings[this.stringPoint + index] = text.charCodeAt(index);
    this.strings[this.stringPoint + text.length] = 0;
    this.stringPoint += text.length + 1;
    let last = first;
    current = first;
    while (current !== null && current.getAllocationPointer(0) !== undefined) {
      last = current;
      current = current.getAllocationPointer(0) ?? null;
    }
    const offset = this.allocate(8);
    if (offset === null) {
      throw new RangeError("String_Alloc dereferences a failed UI_Alloc stringDef_t");
    }
    const allocation = this.borrow(offset, 8);
    allocation.setAllocationPointer(0, undefined);
    allocation.setString(4, reference);
    // The source tracks the penultimate node here, replacing the previous tail.
    if (last !== null) {
      last.setAllocationPointer(0, allocation);
    }
    else this.buckets[hash] = allocation;
    return reference;
  }
}
