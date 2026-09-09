// Ported from id Software's code/renderer/tr_image.c R_LoadImage and R_FindImageFile.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { BmpDropError, decodeBmp } from "../assets/bmp.ts";
import { decodeJpeg, JpegSourceError } from "../assets/jpeg.ts";
import { decodePcxIndexed, expandPcx } from "../assets/pcx.ts";
import type { RetainedFileReader } from "../assets/read-file-memory.ts";
import { decodeTga } from "../assets/tga.ts";
import type { ImageData } from "../assets/tga.ts";
import { CommonError } from "../core/common-error.ts";

function decodeRendererJpeg(bytes: Uint8Array, name: string, print: (text: string) => undefined): ImageData {
  let callbackFailed = false;
  try {
    return decodeJpeg(bytes, name, text => {
      try { return print(text); }
      catch (error) { callbackFailed = true; throw error; }
    });
  }
  catch (error) {
    if (!callbackFailed && error instanceof JpegSourceError) throw new CommonError("fatal", `${error.sourceMessage}\n`);
    throw error;
  }
}

async function loadImage(files: Pick<RetainedFileReader, "readFileRetained" | "freeFile">, name: string,
  print: (text: string) => undefined): Promise<ImageData | null> {
  if (name.length < 5) return null;
  const extension = name.slice(-4).toLowerCase();
  if (extension !== ".tga" && extension !== ".pcx" && extension !== ".bmp" && extension !== ".jpg") return null;
  const buffer = await files.readFileRetained(name);
  if (extension === ".tga") {
    if (buffer !== undefined) {
      const decoded = decodeTga(buffer.bytes, name, print);
      files.freeFile(buffer);
      return decoded;
    }
    if (name.length >= 64) throw new RangeError("R_LoadImage: TGA fallback exceeds source MAX_QPATH");
    const alternate = `${name.slice(0, -3)}jpg`;
    const jpeg = await files.readFileRetained(alternate);
    if (jpeg === undefined) return null;
    const decoded = decodeRendererJpeg(jpeg.bytes, alternate, print);
    files.freeFile(jpeg);
    return decoded;
  }
  if (buffer === undefined) return null;
  if (extension === ".pcx") {
    const decoded = decodePcxIndexed(buffer.bytes, name);
    if ("kind" in decoded) { print(decoded.message); return null; }
    files.freeFile(buffer);
    return expandPcx(decoded);
  }
  if (extension === ".bmp") {
    try {
      const decoded = decodeBmp(buffer.bytes, name);
      files.freeFile(buffer);
      return decoded;
    }
    catch (error) {
      if (error instanceof BmpDropError) throw new CommonError("drop", error.message);
      throw error;
    }
  }
  const decoded = decodeRendererJpeg(buffer.bytes, name, print);
  files.freeFile(buffer);
  return decoded;
}

/** R_FindImageFile's uncached load. The resource owner retains cache and creation. */
export async function loadRendererImage(files: Pick<RetainedFileReader, "readFileRetained" | "freeFile">, name: string,
  print: (text: string) => undefined): Promise<ImageData | null> {
  const end = name.indexOf("\0");
  if (end >= 0) name = name.slice(0, end);
  for (let index = 0; index < name.length; index++) {
    const byte = name.charCodeAt(index);
    if (byte > 255) throw new RangeError("R_LoadImage requires source byte names");
  }
  const image = await loadImage(files, name, print);
  if (image !== null) return image;
  // The source indexes len-3 and copies into altname[MAX_QPATH] without guards.
  if (name.length < 3 || name.length >= 64) throw new RangeError("R_FindImageFile: unsafe source retry name length");
  const alternate = name.slice(0, -3) + name.slice(-3).replace(/[a-z]/g, letter => String.fromCharCode(letter.charCodeAt(0) - 32));
  print(`trying ${alternate}...\n`);
  return loadImage(files, alternate, print);
}
