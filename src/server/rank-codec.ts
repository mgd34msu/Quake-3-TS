// Port of id Software's server/sv_rankings.c ASCII and 64-bit ID codecs.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

const asciiEncoding = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ[]";

/** SV_RankAsciiEncode. Returns text length; also writes the terminating NUL. */
export function rankAsciiEncode(destination: Uint8Array, source: Uint8Array): number {
  const input = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const output = new DataView(destination.buffer, destination.byteOffset, destination.byteLength);
  let length = 0;
  for (let index = 0; index < source.length; index += 3) {
    const first = input.getUint8(index);
    const second = index + 1 < source.length ? input.getUint8(index + 1) : 0;
    const third = index + 2 < source.length ? input.getUint8(index + 2) : 0;
    const text = [first >> 2, ((first << 4) | (second >> 4)) & 63,
      ((second << 2) | (third >> 6)) & 63, third & 63];
    const count = index + 2 < source.length ? 4 : Math.floor((source.length - index) * 4 / 3) + 1;
    for (const value of text.slice(0, count)) output.setUint8(length++, asciiEncoding.charCodeAt(value));
  }
  output.setUint8(length, 0);
  return length;
}

/** SV_RankAsciiDecode. Invalid text returns zero, retaining earlier group writes. */
export function rankAsciiDecode(destination: Uint8Array, source: string): number {
  const result = decodeAscii(destination, source);
  return result.valid ? result.written : 0;
}

function decodeAscii(destination: Uint8Array, source: string): { readonly valid: boolean; readonly written: number } {
  const output = new DataView(destination.buffer, destination.byteOffset, destination.byteLength);
  let length = 0;
  const decode = (index: number): number => {
    if (index >= source.length) return 0;
    const code = source.charCodeAt(index);
    if (code > 255) throw new RangeError(`Ranking text at ${index} is not a C byte`);
    // code/unix/Makefile selects -fsigned-char: high bytes index before the inverse table.
    if (code >= 128) throw new RangeError(`Ranking text at ${index} has an undefined signed-char index`);
    return asciiEncoding.indexOf(source.charAt(index));
  };
  for (let index = 0; index < source.length; index += 4) {
    const text: [number, number, number, number] = [0, 0, 0, 0];
    for (let character = 0; character < 4; character++) {
      const value = decode(index + character);
      if (value < 0) return { valid: false, written: length };
      text[character] = value;
    }
    const [first, second, third, fourth] = text;
    const bytes = [(first << 2) | (second >> 4), (second << 4) | (third >> 2), (third << 6) | fourth];
    const count = index + 3 < source.length ? 3 : Math.floor((source.length - index) * 3 / 4);
    // Checked writes reject the native overflow at the reached byte, after prior writes.
    for (const value of bytes.slice(0, count)) output.setUint8(length++, value);
  }
  return { valid: true, written: length };
}

/** SV_RankEncodeGameID. A short destination receives only a leading NUL. */
export function rankEncodeGameId(gameId: bigint, destination: Uint8Array, debugPrint: (text: string) => void): void {
  if (destination.length < 12) {
    debugPrint("SV_RankEncodeGameID: result buffer too small\n");
    new DataView(destination.buffer, destination.byteOffset, destination.byteLength).setUint8(0, 0);
    return;
  }
  if (gameId < 0n || gameId > 0xffffffffffffffffn) throw new RangeError("Ranking game ID exceeds uint64 range");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, gameId, true);
  rankAsciiEncode(destination, bytes);
}

/** SV_RankDecodePlayerID, rejecting native uninitialized or out-of-bounds reads. */
export function rankDecodePlayerId(source: string, debugPrint: (text: string) => void): bigint {
  const end = source.indexOf("\0");
  const text = end < 0 ? source : source.slice(0, end);
  debugPrint(`SV_RankDecodePlayerID: string length ${text.length}\n`);
  const buffer = new Uint8Array(9);
  const result = decodeAscii(buffer, text);
  // The source ignores decode failure and consumes any eight bytes already written.
  if (result.written < 8) throw new RangeError("Ranking player ID does not contain eight initialized bytes");
  return new DataView(buffer.buffer).getBigUint64(0, true);
}
