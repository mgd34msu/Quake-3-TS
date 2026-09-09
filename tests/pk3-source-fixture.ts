import { deflateRawSync } from "node:zlib";

export interface SourceZipEntry {
  readonly name: Uint8Array;
  readonly data: Uint8Array;
  readonly method: 0 | 8;
  readonly utf8: boolean;
}

function checksum(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) === 0 ? value >>> 1 : 0xedb88320 ^ (value >>> 1);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let position = 0;
  for (const part of parts) { result.set(part, position); position += part.byteLength; }
  return result;
}

export function sourceZip(entries: readonly SourceZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const compressed = entry.method === 0 ? entry.data : deflateRawSync(entry.data);
    const crc = checksum(entry.data);
    const local = new Uint8Array(30 + entry.name.byteLength + compressed.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, entry.utf8 ? 0x800 : 0, true);
    localView.setUint16(8, entry.method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, compressed.byteLength, true);
    localView.setUint32(22, entry.data.byteLength, true);
    localView.setUint16(26, entry.name.byteLength, true);
    local.set(entry.name, 30);
    local.set(compressed, 30 + entry.name.byteLength);
    localParts.push(local);
    const central = new Uint8Array(46 + entry.name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, entry.utf8 ? 0x800 : 0, true);
    centralView.setUint16(10, entry.method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, compressed.byteLength, true);
    centralView.setUint32(24, entry.data.byteLength, true);
    centralView.setUint16(28, entry.name.byteLength, true);
    centralView.setUint32(42, localOffset, true);
    central.set(entry.name, 46);
    centralParts.push(central);
    localOffset += local.byteLength;
  }
  const locals = concatenate(localParts);
  const central = concatenate(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, central.byteLength, true);
  endView.setUint32(16, locals.byteLength, true);
  return concatenate([locals, central, end]);
}

export function sourceNameFixtureEntries(): readonly SourceZipEntry[] {
  const definitions: readonly (readonly [string, string, 0 | 8])[] = [
    ["Zebra.TXT", "z", 0], ["Dir\\", "", 0], ["dir/Alpha.TXT", "alpha", 8],
    ["same.txt", "first", 0], ["SAME.TXT", "second", 8], ["dir\\Alpha.TXT", "later", 0],
    ["models/players/sarge/icon.tga", "icon", 8], ["payload/", "directory payload", 8],
    ["empty.txt", "", 0], ["folder/", "", 0],
  ];
  return definitions.map(([name, data, method]) => ({ name: new TextEncoder().encode(name),
    data: new TextEncoder().encode(data), method, utf8: false }));
}
