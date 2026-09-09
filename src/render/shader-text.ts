// ScanAndLoadShaderFiles/FindShaderInShaderText, id Software renderer/tr_shader.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { AssetReader, SourceFileReader } from "../assets/reader.ts";
import type { RetainedFileReader } from "../assets/read-file-memory.ts";
import { CommonParseCursor, CommonParseState, compressCommonText } from "../core/common-parse.ts";
import { CommonError } from "../core/common-error.ts";
import { SOURCE_HUNK_RELEASE32 } from "./hunk-accounting.ts";
import type { HunkAccountingProfile } from "./hunk-accounting.ts";
import { SourceShaderRegistrationProgram, sameShaderName, shaderNameHash } from "./material.ts";
import type { ShaderRegistrationProgram } from "./material.ts";

const HASH_SIZE = 2048;
interface ShaderBytes { readonly bytes: Uint8Array }
interface ShaderFile {
  readonly path: string;
  readonly storage: ShaderBytes;
  readonly release: () => void;
  offset: number;
}
export type ShaderTextReader =
  | { readonly kind: "retained"; readonly source: Pick<AssetReader, "list"> & RetainedFileReader }
  | { readonly kind: "detached"; readonly source: Pick<AssetReader, "list"> & Pick<SourceFileReader, "readFileOptional"> };

function byteText(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += 8192) chunks.push(String.fromCharCode(...bytes.subarray(start, start + 8192)));
  return chunks.join("");
}

/** Holds the source text and its actual pointer-slot table. Stored pointers are
 * relative text offsets plus one, leaving zero as the source null terminator. */
export class ShaderTextPrograms {
  private text: ShaderBytes | null = null;
  private hash: ShaderBytes | null = null;
  private readonly buckets: number[] = [];
  private readonly files: ShaderFile[] = [];
  private lookupCursor: CommonParseCursor | null = null;
  private loaded = false;

  async load(reader: ShaderTextReader,
    memory: HunkAccountingProfile, print: (text: string) => undefined): Promise<void> {
    if (this.loaded) throw new Error("Shader text has already been scanned");
    this.loaded = true;
    const paths = reader.source.list("scripts/").filter(path => path.toLowerCase().endsWith(".shader")).slice(0, 4096);
    if (paths.length === 0) {
      print("WARNING: no shader files found\n");
      return;
    }
    let sum = 0;
    for (const listed of paths) {
      const path = listed.slice(0, 63);
      print(`...loading '${path}'\n`);
      if (reader.kind === "retained") {
        const buffer = await reader.source.readFileRetained(path);
        if (buffer === undefined) throw new CommonError("drop", `Couldn't load ${path}`);
        sum += buffer.length;
        this.files.push({ path, storage: { get bytes() { return buffer.terminatedBytes; } },
          release: () => reader.source.freeFile(buffer), offset: 0 });
      } else {
        const bytes = await reader.source.readFileOptional(path);
        if (bytes === undefined) throw new CommonError("drop", `Couldn't load ${path}`);
        sum += bytes.length;
        const temporary = memory.kind === "source-hunk" ? memory.accounting.beginFile(path, bytes) : null;
        this.files.push({ path, storage: temporary ?? { bytes },
          release: () => { if (memory.kind === "source-hunk" && temporary !== null) memory.accounting.endFile(path, temporary); }, offset: 0 });
      }
    }
    const capacity = sum + this.files.length * 2;
    const text = memory.kind === "source-hunk"
      ? memory.accounting.reserve("ScanAndLoadShaderFiles:shaderText", "scripts/*.shader", capacity, "low")
      : { bytes: new Uint8Array(capacity) };
    this.text = text;
    let length = 0;
    for (let index = this.files.length - 1; index >= 0; index--) {
      const file = this.files[index];
      if (file === undefined) throw new Error("Shader file list lost its source buffer");
      text.bytes[length++] = 10;
      file.offset = length;
      const bytes = file.storage.bytes, nul = bytes.indexOf(0);
      const content = nul === -1 ? bytes : bytes.subarray(0, nul);
      text.bytes.set(content, length);
      text.bytes[length + content.length] = 0;
      file.release();
      const compressed = compressCommonText(byteText(text.bytes.subarray(length, length + content.length)));
      for (let character = 0; character < compressed.length; character++) text.bytes[length + character] = compressed.charCodeAt(character);
      length += compressed.length;
      text.bytes[length] = 0;
    }

    const source = byteText(text.bytes.subarray(0, length));
    this.lookupCursor = new CommonParseCursor(source);
    const sizes = new Uint32Array(HASH_SIZE);
    let count = 0;
    this.scan(source, (_offset, token) => {
      const hash = shaderNameHash(token, HASH_SIZE), size = sizes[hash];
      if (size === undefined) throw new Error("Shader hash escaped its table");
      sizes[hash] = size + 1;
      count++;
    });
    const hashBytes = (count + HASH_SIZE) * SOURCE_HUNK_RELEASE32.pointer;
    this.hash = memory.kind === "source-hunk"
      ? memory.accounting.reserve("ScanAndLoadShaderFiles:hashMem", "scripts/*.shader", hashBytes, "low")
      : { bytes: new Uint8Array(hashBytes) };
    let offset = 0;
    for (const size of sizes) {
      this.buckets.push(offset);
      offset += (size + 1) * SOURCE_HUNK_RELEASE32.pointer;
    }
    const view = new DataView(this.hash.bytes.buffer, this.hash.bytes.byteOffset, this.hash.bytes.byteLength);
    sizes.fill(0);
    this.scan(source, (textOffset, token) => {
      const hash = shaderNameHash(token, HASH_SIZE), bucket = this.buckets[hash], size = sizes[hash];
      if (bucket === undefined || size === undefined) throw new Error("Shader hash escaped its table");
      view.setUint32(bucket + size * SOURCE_HUNK_RELEASE32.pointer, textOffset + 1, true);
      sizes[hash] = size + 1;
    });
  }

  private scan(text: string, visit: (offset: number, token: string) => void): void {
    const parser = new CommonParseState(), cursor = new CommonParseCursor(text);
    for (const [index, file] of this.files.entries()) {
      cursor.offset = file.offset;
      for (;;) {
        const offset = cursor.offset, token = parser.parse(cursor);
        if (token.length === 0 || offset === null) break;
        visit(offset, token);
        parser.skipBracedSection(cursor);
        const next = this.files[index + 1];
        if (next !== undefined && cursor.offset !== null && cursor.offset > next.offset) break;
      }
    }
  }

  find(name: string): ShaderRegistrationProgram | undefined {
    if (this.text === null) return undefined;
    const bytes = this.text.bytes;
    const cursor = this.lookupCursor ?? new CommonParseCursor(byteText(bytes));
    const parser = new CommonParseState();
    if (this.hash !== null) {
      const bytes = this.hash.bytes, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const bucket = this.buckets[shaderNameHash(name, HASH_SIZE)];
      if (bucket === undefined) throw new Error("Shader text hash has no bucket");
      for (let offset = bucket; ; offset += SOURCE_HUNK_RELEASE32.pointer) {
        const pointer = view.getUint32(offset, true);
        if (pointer === 0) break;
        cursor.offset = pointer - 1;
        if (sameShaderName(parser.parse(cursor), name)) return this.program(pointer - 1, cursor, name);
      }
    }
    cursor.offset = 0;
    for (;;) {
      const offset = cursor.offset, token = parser.parse(cursor);
      if (token.length === 0 || offset === null) return undefined;
      if (sameShaderName(token, name)) return this.program(offset, cursor, name);
      parser.skipBracedSection(cursor);
    }
  }

  private program(offset: number, cursor: CommonParseCursor, name: string): ShaderRegistrationProgram {
    const file = this.files.find(file => file.offset <= offset);
    const nul = name.indexOf("\0"), sourceName = (nul === -1 ? name : name.slice(0, nul)).slice(0, 63);
    return new SourceShaderRegistrationProgram(cursor, cursor.offset, file?.path ?? "<shader>", sourceName);
  }
}
