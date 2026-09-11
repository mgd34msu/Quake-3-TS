// FreeType freetype.h FT_FaceRec/FT_GlyphSlotRec and ftimage.h FT_Bitmap.
// https://github.com/freetype/freetype/tree/VER-2-13-3/include/freetype
export interface FreeTypeLayout {
  readonly longBytes: 4 | 8;
  readonly signedLong: "i32" | "i64";
  readonly unsignedLong: "u32" | "u64";
  readonly faceGlyph: number;
  readonly slotFormat: number;
  readonly slotOutline: number;
}

const lp64: FreeTypeLayout = {
  longBytes: 8, signedLong: "i64", unsignedLong: "u64",
  faceGlyph: 152, slotFormat: 144, slotOutline: 200,
};
const llp64: FreeTypeLayout = {
  longBytes: 4, signedLong: "i32", unsignedLong: "u32",
  faceGlyph: 120, slotFormat: 96, slotOutline: 152,
};

export function freeTypeLayout(platform: string, arch: string, byteOrder: string): FreeTypeLayout | null {
  if (byteOrder !== "LE") return null;
  if (platform === "win32" && arch === "x64") return llp64;
  if ((platform === "linux" || platform === "darwin") && (arch === "x64" || arch === "arm64")) return lp64;
  return null;
}

export function freeTypeMetric(view: DataView, offset: number, layout: FreeTypeLayout): number {
  if (layout.longBytes === 4) return view.getInt32(offset, true);
  const value = view.getBigInt64(offset, true);
  if (value < -2147483648n || value > 2147483647n) throw new RangeError("FreeType metric exceeds source int32");
  return Number(value);
}
