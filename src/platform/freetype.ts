// FreeType service used by id Software's renderer/tr_font.c. GPL-2.0-or-later.
// ABI: FreeType freetype.h/ftimage.h, 64-bit little-endian LP64 and Windows LLP64.
import { dlopen, ptr } from "bun:ffi";
import { endianness } from "node:os";
import { freeTypeLayout, freeTypeMetric } from "./freetype-layout.ts";
import type { FreeTypeLayout } from "./freetype-layout.ts";
import { openNativeLibrary } from "./native-libraries.ts";

function loadFreeType(layout: FreeTypeLayout) {
  return openNativeLibrary("freetype", path => dlopen(path, {
    FT_Init_FreeType: { args: ["buffer"], returns: "i32" },
    FT_Done_FreeType: { args: ["u64"], returns: "i32" },
    FT_New_Memory_Face: { args: ["u64", "buffer", layout.signedLong, layout.signedLong, "buffer"], returns: "i32" },
    FT_Done_Face: { args: ["u64"], returns: "i32" },
    FT_Set_Char_Size: { args: ["u64", layout.signedLong, layout.signedLong, "u32", "u32"], returns: "i32" },
    FT_Get_Char_Index: { args: ["u64", layout.unsignedLong], returns: "u32" },
    FT_Load_Glyph: { args: ["u64", "u32", "i32"], returns: "i32" },
    FT_Outline_Translate: { args: ["u64", layout.signedLong, layout.signedLong], returns: "void" },
    FT_Outline_Get_Bitmap: { args: ["u64", "u64", "buffer"], returns: "i32" },
  }));
}

function loadMemory() {
  // Native pointer out parameters are read as uint64, never cast to Bun Pointer.
  // All supported ABIs pass pointers and uint64 in the same integer registers.
  // Bun's read.ptr returns an unbranded number; its read/toArrayBuffer APIs
  // require Pointer. memcpy copies into owned storage without a pointer cast.
  return dlopen(process.platform === "win32" ? "msvcrt.dll"
    : process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
  { memcpy: { args: ["buffer", "u64", "u64"], returns: "ptr" } });
}

export interface FontGlyphBitmap {
  readonly height: number;
  readonly pitch: number;
  readonly top: number;
  readonly bottom: number;
  readonly xSkip: number;
  readonly pixels: Uint8Array;
}

export type FreeTypeInitialization = { readonly kind: "unavailable" | "failed" }
  | { readonly kind: "ready"; readonly library: FreeTypeFontLibrary };

/** Owns native parser/rasterizer resources; atlas construction is TypeScript. */
export class FreeTypeFontLibrary {
  private handle: bigint;
  private readonly faces = new Map<bigint, Uint8Array>();

  private constructor(private readonly library: ReturnType<typeof loadFreeType>,
    private readonly memory: ReturnType<typeof loadMemory>, private readonly layout: FreeTypeLayout,
    handle: bigint) { this.handle = handle; }

  static open(print: (text: string) => void): FreeTypeInitialization {
    const layout = freeTypeLayout(process.platform, process.arch, endianness());
    if (layout === null) return { kind: "unavailable" };
    let library: ReturnType<typeof loadFreeType>;
    try { library = loadFreeType(layout); } catch { return { kind: "unavailable" }; }
    let memory: ReturnType<typeof loadMemory>;
    try { memory = loadMemory(); } catch { library.close(); return { kind: "unavailable" }; }
    const result = new Uint8Array(8);
    if (library.symbols.FT_Init_FreeType(result) !== 0) {
      memory.close(); library.close(); print("R_InitFreeType: Unable to initialize FreeType.\n"); return { kind: "failed" };
    }
    const handle = new DataView(result.buffer).getBigUint64(0, true);
    if (handle === 0n) { memory.close(); library.close(); throw new Error("FreeType initialized a null library"); }
    return { kind: "ready", library: new FreeTypeFontLibrary(library, memory, layout, handle) };
  }

  createFace(bytes: Uint8Array, size: number, print: (text: string) => void): bigint | null {
    this.requireOpen();
    // FT_New_Memory_Face's length is signed long, including on Windows.
    if (bytes.length > 0x7fffffff) throw new RangeError("FreeType font exceeds source int32 length");
    if (bytes.length === 0) {
      print("RE_RegisterFont: FreeType2, unable to allocate new face.\n"); return null;
    }
    const result = new Uint8Array(8);
    if (this.library.symbols.FT_New_Memory_Face(this.handle, bytes, bytes.length, 0, result) !== 0) {
      print("RE_RegisterFont: FreeType2, unable to allocate new face.\n"); return null;
    }
    const face = new DataView(result.buffer).getBigUint64(0, true);
    if (face === 0n) throw new Error("FreeType created a null face");
    this.faces.set(face, bytes);
    if (this.library.symbols.FT_Set_Char_Size(face, size << 6, size << 6, 72, 72) !== 0) {
      print("RE_RegisterFont: FreeType2, Unable to set face char size.\n"); return null;
    }
    return face;
  }

  renderGlyph(face: bigint, code: number, print: (text: string) => void): FontGlyphBitmap | null {
    this.requireOpen();
    if (!this.faces.has(face)) throw new Error("FreeType face is not owned by this library");
    const api = this.library.symbols;
    // The source ignores FT_Load_Glyph's error and inspects the current slot.
    api.FT_Load_Glyph(face, api.FT_Get_Char_Index(face, code), 0);
    const faceRecord = this.read(face, this.layout.faceGlyph + 8), slot = faceRecord.getBigUint64(this.layout.faceGlyph, true);
    if (slot === 0n) throw new Error("FreeType face has no glyph slot");
    const glyph = this.read(slot, this.layout.slotFormat + 4);
    if (glyph.getUint32(this.layout.slotFormat, true) !== 0x6f75746c) {
      print("Non-outline fonts are not supported\n"); return null;
    }
    const width26 = this.metric(glyph, 0), height26 = this.metric(glyph, 1);
    const bearingX = this.metric(glyph, 2), bearingY = this.metric(glyph, 3);
    const left = bearingX & -64, right = (bearingX + width26 + 63) & -64;
    const top = (bearingY + 63) & -64, bottom = (bearingY - height26) & -64;
    const width = (right - left) >> 6, height = (top - bottom) >> 6, pitch = (width + 3) & -4;
    if (width < 0 || height < 0 || pitch < 0 || pitch * height > 0x7fffffff)
      throw new RangeError("FreeType glyph bitmap exceeds source allocation range");
    const pixels = new Uint8Array(Math.max(1, pitch * height));
    const bitmap = new Uint8Array(40), view = new DataView(bitmap.buffer);
    view.setUint32(0, height, true); view.setUint32(4, width, true); view.setInt32(8, pitch, true);
    view.setBigUint64(16, BigInt(ptr(pixels)), true); view.setUint16(24, 256, true); view.setUint8(26, 2);
    const outline = slot + BigInt(this.layout.slotOutline);
    api.FT_Outline_Translate(outline, -left, -bottom);
    api.FT_Outline_Get_Bitmap(this.handle, outline, bitmap);
    return { height, pitch, top: (bearingY >> 6) + 1, bottom,
      xSkip: (this.metric(glyph, 4) >> 6) + 1, pixels: pixels.subarray(0, pitch * height) };
  }

  releaseFace(face: bigint): void {
    this.requireOpen();
    if (!this.faces.has(face)) throw new Error("FreeType face is not owned by this library");
    this.library.symbols.FT_Done_Face(face); this.faces.delete(face);
  }

  close(): void {
    if (this.handle === 0n) return;
    this.library.symbols.FT_Done_FreeType(this.handle); this.handle = 0n;
    this.faces.clear(); this.library.close(); this.memory.close();
  }

  private requireOpen(): void { if (this.handle === 0n) throw new Error("FreeType library is closed"); }
  private read(address: bigint, length: number): DataView {
    const bytes = new Uint8Array(length);
    this.memory.symbols.memcpy(bytes, address, length);
    return new DataView(bytes.buffer);
  }
  private metric(view: DataView, index: number): number {
    return freeTypeMetric(view, 48 + index * this.layout.longBytes, this.layout);
  }
}
