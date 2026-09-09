// Ported from id Software's renderer/tr_font.c. GPL-2.0-or-later.
import type { SourceFileReader } from "../assets/reader.ts";
import type { RetainedFileReader } from "../assets/read-file-memory.ts";
import type { MaterialPicture } from "./draw2d.ts";
import { readFontData } from "./font.ts";
import type { RegisteredFont, RegisteredGlyph } from "./font.ts";

/** R_InitFreeType/R_DoneFreeType bound these slots to one renderer lifetime. */
export class RendererFontRegistry {
  private readonly fonts: { readonly font: RegisteredFont; readonly record: Uint8Array }[] = [];
  private registration: Promise<void> = Promise.resolve();

  constructor(
    private readonly reader: RetainedFileReader & Pick<SourceFileReader, "readFileLength">,
    private readonly registerPicture: (path: string) => Promise<MaterialPicture>,
    private readonly syncRenderThread: () => void,
  ) {}

  /** Null is RE_RegisterFont's no-write return; fontName is unused without FreeType. */
  async registerFont(
    _path: string | null, pointSize: number, print: (text: string) => void,
    destination?: () => Uint8Array,
  ): Promise<RegisteredFont | null> {
    if (!Number.isFinite(pointSize)) throw new RangeError("Invalid font point size");
    const integerSize = Math.trunc(pointSize), size = integerSize <= 0 ? 12 : integerSize;
    // Source registrations are synchronous. Await each complete call before
    // checking capacity, including cache hits and calls after a failed load.
    const result = this.registration.then(() => this.loadFont(`fonts/fontImage_${size}.dat`, print, destination));
    this.registration = result.then(() => undefined, () => undefined);
    return result;
  }

  private async loadFont(name: string, print: (text: string) => void, destination: (() => Uint8Array) | undefined): Promise<RegisteredFont | null> {
    this.syncRenderThread();
    if (this.fonts.length >= 6) {
      print("RE_RegisterFont: Too many fonts registered already.\n"); return null;
    }
    const cached = this.fonts.find(entry => entry.font.name.toLowerCase() === name.toLowerCase());
    if (cached !== undefined) {
      if (destination !== undefined) this.destinationRecord(destination).set(cached.record);
      return cached.font;
    }
    const file = this.reader.readFileLength(name) === 20548 ? await this.reader.readFileRetained(name) : undefined;
    if (file === undefined || file.length !== 20548) {
      print("RE_RegisterFont: FreeType code not available\n"); return null;
    }
    // The prebuilt DAT branch returns without FS_FreeFile, including after shaders.
    const bytes = file.bytes;
    const record = destination === undefined ? bytes.slice() : this.destinationRecord(destination);
    record.set(bytes);
    record.fill(0, 20484);
    for (let index = 0; index < name.length; index++) record[20484 + index] = name.charCodeAt(index);
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength), pictures: MaterialPicture[] = [];
    // RE_RegisterFont publishes the entire DAT before the first shader call.
    // Its exclusive GLYPH_END bound leaves glyph 255's serialized word intact.
    for (let index = 0; index < 255; index++) {
      const shaderBytes = record.subarray(index * 80 + 48), end = shaderBytes.indexOf(0);
      if (end < 0) throw new RangeError("Font shader name has no terminator inside fontInfo_t");
      let shaderName = "";
      for (const byte of shaderBytes.subarray(0, end)) shaderName += String.fromCharCode(byte);
      const picture = await this.registerPicture(shaderName);
      view.setInt32(index * 80 + 44, picture.material.order, true);
      pictures.push(picture);
    }
    const data = readFontData(record, name), glyphs: RegisteredGlyph[] = [];
    for (const [index, glyph] of data.glyphs.entries()) {
      const picture = index === 255 ? null : pictures[index];
      if (picture === undefined) throw new RangeError("Missing registered font glyph");
      glyphs.push({ ...glyph, picture });
    }
    const result: RegisteredFont = { name: data.name, glyphScale: data.glyphScale, glyphs };
    this.fonts.push({ font: result, record: record.slice() });
    return result;
  }

  private destinationRecord(destination: () => Uint8Array): Uint8Array {
    const record = destination();
    if (record.byteLength !== 20548) throw new RangeError("fontInfo_t destination must contain exactly 20548 bytes");
    return record;
  }
}
