import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateRawSync } from "node:zlib";
import { Pk3Archive, Pk3Error } from "../src/assets/pk3.ts";
import { sourceZip } from "./pk3-source-fixture.ts";

interface FixtureEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly method: 0 | 8;
}

const temporaryDirectories: string[] = [];
const retailDataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retailArchivePath = join(retailDataPath, "baseq3", "pak0.pk3");
const retailArchiveAvailable = await Bun.file(retailArchivePath).exists();
const retailMissionpackPath = join(retailDataPath, "missionpack", "pak0.pk3");
const retailMissionpackAvailable = await Bun.file(retailMissionpackPath).exists();

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function fixtureCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function makeZip(entries: readonly FixtureEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const compressed = entry.method === 0 ? entry.data : deflateRawSync(entry.data);
    const crc = fixtureCrc32(entry.data);
    const local = new Uint8Array(30 + name.byteLength + compressed.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, entry.method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, compressed.byteLength, true);
    localView.setUint32(22, entry.data.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(compressed, 30 + name.byteLength);
    localParts.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, entry.method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, compressed.byteLength, true);
    centralView.setUint32(24, entry.data.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
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

async function writeFixture(bytes: Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "quake3-pk3-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "fixture.pk3");
  await writeFile(path, bytes);
  return path;
}

function centralOffset(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.byteLength - 6, true);
}

describe("PK3 archives", () => {
  test("owns native archive bytes across initial open, independent reads and replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quake3-pk3-宿-é-"));
    temporaryDirectories.push(directory);
    const prefix = Buffer.from(`${directory}/`);
    const nativePath = Buffer.concat([prefix, Buffer.from([0xe9]), Buffer.from(".pk3")]);
    const originalPath = Buffer.from(nativePath);
    const otherPath = Buffer.concat([prefix, Buffer.from([0xea]), Buffer.from(".pk3")]);
    const displayPath = join(directory, "é.pk3");
    const fixture = (data: number[]): Uint8Array => makeZip([
      { name: "item.txt", data: new Uint8Array(data), method: 0 },
    ]);
    await writeFile(nativePath, fixture([1, 3, 5]));
    await writeFile(displayPath, fixture([2, 4, 6]));
    await writeFile(otherPath, fixture([8, 8, 8]));
    const opening = Pk3Archive.open(displayPath, nativePath);
    nativePath[prefix.byteLength] = 0xea;
    using archive = await opening;
    using unicodeArchive = await Pk3Archive.open(displayPath);
    expect(archive.path).toBe(displayPath);
    const retainedBytes = (selected: Pk3Archive, shared: boolean): number[] => {
      const reader = shared ? selected.openSharedRead("item.txt") : selected.openRead("item.txt");
      try {
        const bytes = new Uint8Array(3);
        expect(reader.readInto(bytes)).toBe(3);
        return Array.from(bytes);
      } finally { reader.close(); }
    };
    for (const selected of [archive, unicodeArchive]) {
      const expected = selected === archive ? [1, 3, 5] : [2, 4, 6];
      expect(Array.from(await selected.read("item.txt"))).toEqual(expected);
      expect(Array.from(selected.readSync("item.txt"))).toEqual(expected);
      expect(retainedBytes(selected, false)).toEqual(expected);
      expect(retainedBytes(selected, true)).toEqual(expected);
    }
    const replacement = fixture([1, 3, 5]);
    replacement.set([7, 9, 11], 30 + "item.txt".length);
    const replacementPath = join(directory, "replacement.pk3");
    await writeFile(replacementPath, replacement);
    await rename(replacementPath, originalPath);
    expect(retainedBytes(archive, true)).toEqual([1, 3, 5]);
    expect(retainedBytes(archive, false)).toEqual([7, 9, 11]);
    expect(() => archive.readSync("item.txt")).toThrow("CRC32");
    await expect(archive.read("item.txt")).rejects.toThrow("CRC32");
    expect(() => archive.readSync("missing.txt")).toThrow(`${displayPath}:0: entry not found`);
  });

  test("reads stored and deflated entries with Quake case and separator matching", async () => {
    const bytes = makeZip([
      { name: "scripts/Stored.CFG", data: new TextEncoder().encode("stored"), method: 0 },
      { name: "textures/wall.tga", data: new Uint8Array([0, 1, 2, 3, 4, 255]), method: 8 },
    ]);
    using archive = await Pk3Archive.open(await writeFixture(bytes));
    expect(archive.entries.map((entry) => entry.path)).toEqual(["scripts/stored.cfg", "textures/wall.tga"]);
    expect(archive.has("SCRIPTS\\STORED.cfg")).toBe(true);
    expect(new TextDecoder().decode(await archive.read("scripts/stored.cfg"))).toBe("stored");
    expect([...await archive.read("TEXTURES/WALL.TGA")]).toEqual([0, 1, 2, 3, 4, 255]);
    expect(new TextDecoder().decode(archive.readSync("SCRIPTS\\STORED.cfg"))).toBe("stored");
    expect([...archive.readSync("TEXTURES/WALL.TGA")]).toEqual([0, 1, 2, 3, 4, 255]);
    expect(() => archive.readSync("missing.cfg")).toThrow("entry not found");
    expect(archive.list("textures/")).toEqual(["textures/wall.tga"]);
  });

  test("uses the later central-directory entry for duplicate normalized names", async () => {
    const bytes = makeZip([
      { name: "same.txt", data: new TextEncoder().encode("first"), method: 0 },
      { name: "SAME.TXT", data: new TextEncoder().encode("second"), method: 8 },
    ]);
    using archive = await Pk3Archive.open(await writeFixture(bytes));
    expect(archive.entries).toHaveLength(2);
    expect(archive.list()).toEqual(["same.txt"]);
    expect(new TextDecoder().decode(await archive.read("same.txt"))).toBe("second");
  });

  test("preserves source EOF-valued filename bytes through case and duplicate matching", async () => {
    using archive = await Pk3Archive.open(await writeFixture(sourceZip([
      { name: new Uint8Array([65, 255, 46, 84, 88, 84]), data: new Uint8Array([1]), method: 0, utf8: false },
      { name: new Uint8Array([97, 255, 46, 116, 120, 116]), data: new Uint8Array([2, 3]), method: 8, utf8: false },
    ])));
    expect(archive.sourceNames).toEqual([
      { kind: "supported", rawName: "A\xff.TXT", name: "a\xff.txt" },
      { kind: "supported", rawName: "a\xff.txt", name: "a\xff.txt" },
    ]);
    expect(archive.has("A\xff.TXT")).toBe(true);
    expect(archive.list()).toEqual(["a\xff.txt"]);
    expect(await archive.read("A\xff.TXT")).toEqual(new Uint8Array([2, 3]));
    expect(archive.readSync("A\xff.TXT")).toEqual(new Uint8Array([2, 3]));
    const reader = archive.openRead("A\xff.TXT");
    try {
      const output = new Uint8Array(2);
      expect(reader.readInto(output)).toBe(2);
      expect(output).toEqual(new Uint8Array([2, 3]));
    } finally {
      reader.close();
    }
  });

  test("keeps source EOF-valued filenames within length boundaries regardless of UTF-8 flags", async () => {
    const short = new Uint8Array(255).fill(65); short[0] = 255;
    const long = new Uint8Array(256).fill(65); long[0] = 255;
    using archive = await Pk3Archive.open(await writeFixture(sourceZip([
      { name: short, data: new Uint8Array(), method: 0, utf8: false },
      { name: long, data: new Uint8Array(), method: 0, utf8: false },
      { name: new Uint8Array([255, 254, 65]), data: new Uint8Array(), method: 0, utf8: false },
    ])));
    expect(archive.sourceNames).toEqual([
      { kind: "supported", rawName: "\xff" + "A".repeat(254), name: "\xff" + "a".repeat(254) },
      { kind: "unsupported", rawName: "\xff" + "A".repeat(255), reason: "name-too-long" },
      { kind: "supported", rawName: "\xff\xfeA", name: "\xff\xfea" },
    ]);
    const invalidUtf8 = sourceZip([
      { name: new Uint8Array([255, 65]), data: new Uint8Array(), method: 0, utf8: true },
    ]);
    using flagged = await Pk3Archive.open(await writeFixture(invalidUtf8));
    expect(flagged.sourceNames).toEqual([{ kind: "supported", rawName: "\xffA", name: "\xffa" }]);
    expect(flagged.readSync("\xffA")).toEqual(new Uint8Array());
  });

  test("checksums nonempty entry CRCs in central order without deduplicating names", async () => {
    const bytes = makeZip([
      { name: "same.txt", data: new TextEncoder().encode("one"), method: 0 },
      { name: "empty.txt", data: new Uint8Array(), method: 0 },
      { name: "folder/", data: new Uint8Array(), method: 0 },
      { name: "SAME.TXT", data: new TextEncoder().encode("two"), method: 8 },
    ]);
    using archive = await Pk3Archive.open(await writeFixture(bytes));
    expect(archive.checksum).toBe(0xb2eb2670);
    expect(archive.pureChecksum(0)).toBe(0x18c85195);
    expect(archive.pureChecksum(0x12345678)).toBe(0x6ac248d6);
  });

  test("uses the MD4 empty-input checksum when no entry has payload bytes", async () => {
    using archive = await Pk3Archive.open(await writeFixture(makeZip([
      { name: "empty.txt", data: new Uint8Array(), method: 0 },
      { name: "folder/", data: new Uint8Array(), method: 0 },
    ])));
    expect(archive.checksum).toBe(0xc6f640b7);
    expect(archive.pureChecksum(0)).toBe(0x4ce6ac9d);
    expect(() => archive.pureChecksum(0x100000000)).toThrow(RangeError);
  });

  test("rejects malformed end records and central directories", async () => {
    await expect(Pk3Archive.open(await writeFixture(new Uint8Array(21)))).rejects.toThrow("shorter than");
    const wrongCount = makeZip([{ name: "a", data: new Uint8Array(), method: 0 }]);
    new DataView(wrongCount.buffer).setUint16(wrongCount.byteLength - 14, 2, true);
    new DataView(wrongCount.buffer).setUint16(wrongCount.byteLength - 12, 2, true);
    await expect(Pk3Archive.open(await writeFixture(wrongCount))).rejects.toThrow("range of 46 bytes");
    const wrongSignature = makeZip([{ name: "a", data: new Uint8Array(), method: 0 }]);
    new DataView(wrongSignature.buffer).setUint32(centralOffset(wrongSignature), 0, true);
    await expect(Pk3Archive.open(await writeFixture(wrongSignature))).rejects.toThrow("central directory signature");
  });

  test("reads a sparse central directory above 64 MiB as individual source records", async () => {
    const zip = makeZip([{ name: "a", data: new Uint8Array(), method: 0 }]);
    const central = centralOffset(zip), record = zip.slice(central, zip.length - 22);
    const count = 1024, stride = record.length + 0xffff;
    new DataView(record.buffer).setUint16(32, 0xffff, true);
    const end = zip.slice(-22), endView = new DataView(end.buffer);
    endView.setUint16(8, count, true); endView.setUint16(10, count, true);
    endView.setUint32(12, count * stride, true);
    const path = await writeFixture(zip.subarray(0, central));
    const file = await open(path, "r+");
    try {
      for (let index = 0; index < count; index++) {
        await file.write(record, 0, record.length, central + index * stride);
      }
      await file.write(end, 0, end.length, central + count * stride);
      {
        using archive = await Pk3Archive.open(path);
        expect(count * stride).toBeGreaterThan(64 * 1024 * 1024);
        expect(archive.globalInformation.entryCount).toBe(count);
        expect(archive.entries.length).toBe(count);
        expect(archive.readSync("a")).toEqual(new Uint8Array());
        archive.firstFile();
        expect(archive.getCurrentFileInformation().commentLength).toBe(0xffff);
      }
      await file.write(new Uint8Array(4), 0, 4, central);
      await expect(Pk3Archive.open(path)).rejects.toThrow("central directory signature");
    } finally { await file.close(); }
  });

  test("accepts all 65535 entries represented by the source unsigned-short count", async () => {
    const zip = makeZip([{ name: "a", data: new Uint8Array(), method: 0 }]);
    const central = centralOffset(zip), record = zip.subarray(central, zip.length - 22);
    const count = 0xffff, size = record.length * count;
    const bytes = new Uint8Array(central + size + 22);
    bytes.set(zip.subarray(0, central));
    for (let index = 0; index < count; index++) bytes.set(record, central + index * record.length);
    bytes.set(zip.subarray(-22), central + size);
    const view = new DataView(bytes.buffer);
    view.setUint16(bytes.length - 14, count, true); view.setUint16(bytes.length - 12, count, true);
    view.setUint32(bytes.length - 10, size, true);
    using archive = await Pk3Archive.open(await writeFixture(bytes));
    expect(archive.globalInformation.entryCount).toBe(count);
    expect(archive.entries.length).toBe(count);
    expect(archive.openSharedRead("a").length).toBe(0);
  });

  test("rejects unsafe names, encryption, unsupported methods, and inconsistent large entries", async () => {
    for (const name of ["../escape", "../", "/absolute", "C:/drive", "bad\0name", "a//b"] ) {
      const bytes = makeZip([{ name, data: new Uint8Array([1]), method: 0 }]);
      await expect(Pk3Archive.open(await writeFixture(bytes))).rejects.toThrow(Pk3Error);
    }
    const encrypted = makeZip([{ name: "safe", data: new Uint8Array([1]), method: 0 }]);
    new DataView(encrypted.buffer).setUint16(centralOffset(encrypted) + 8, 1, true);
    await expect(Pk3Archive.open(await writeFixture(encrypted))).rejects.toThrow("encrypted");
    const unsupported = makeZip([{ name: "safe", data: new Uint8Array([1]), method: 8 }]);
    new DataView(unsupported.buffer).setUint16(centralOffset(unsupported) + 10, 12, true);
    await expect(Pk3Archive.open(await writeFixture(unsupported))).rejects.toThrow("method 12");
    const oversized = makeZip([{ name: "safe", data: new Uint8Array([1]), method: 8 }]);
    new DataView(oversized.buffer).setUint32(centralOffset(oversized) + 24, 128 * 1024 * 1024 + 1, true);
    using archive = await Pk3Archive.open(await writeFixture(oversized));
    expect(() => archive.openRead("safe")).toThrow("local sizes or CRC disagree");
    expect(() => archive.readSync("safe")).toThrow("local sizes or CRC disagree");
  });

  test("keeps diagnostic allocation policy separate from source partial reads", async () => {
    const bytes = makeZip([{ name: "safe", data: new Uint8Array([1]), method: 8 }]);
    const view = new DataView(bytes.buffer), length = 128 * 1024 * 1024 + 1;
    view.setUint32(centralOffset(bytes) + 24, length, true);
    view.setUint32(22, length, true);
    using archive = await Pk3Archive.open(await writeFixture(bytes));
    const reader = archive.openRead("safe");
    try {
      expect(reader.length).toBe(length);
      const prefix = new Uint8Array(1);
      expect(reader.readInto(prefix)).toBe(1);
      expect(prefix[0]).toBe(1);
    } finally { reader.close(); }
    expect(() => archive.readSync("safe")).toThrow("diagnostic whole-entry read exceeds");
    await expect(archive.read("safe")).rejects.toThrow("diagnostic whole-entry read exceeds");
  });

  test("checks local headers, inflated size, and CRC before returning bytes", async () => {
    const corruptCrc = makeZip([{ name: "safe", data: new Uint8Array([1, 2, 3]), method: 0 }]);
    corruptCrc[34] = 9;
    using crcArchive = await Pk3Archive.open(await writeFixture(corruptCrc));
    await expect(crcArchive.read("safe")).rejects.toThrow("CRC32");
    expect(() => crcArchive.readSync("safe")).toThrow("CRC32");

    const badLocal = makeZip([{ name: "safe", data: new Uint8Array([1]), method: 0 }]);
    new DataView(badLocal.buffer).setUint32(0, 0, true);
    using localArchive = await Pk3Archive.open(await writeFixture(badLocal));
    await expect(localArchive.read("safe")).rejects.toThrow("local file header signature");
    expect(() => localArchive.readSync("safe")).toThrow("local file header signature");

    const wrongSize = makeZip([{ name: "safe", data: new Uint8Array([1, 2, 3]), method: 8 }]);
    const central = centralOffset(wrongSize);
    new DataView(wrongSize.buffer).setUint32(central + 24, 2, true);
    new DataView(wrongSize.buffer).setUint32(22, 2, true);
    using sizeArchive = await Pk3Archive.open(await writeFixture(wrongSize));
    await expect(sizeArchive.read("safe")).rejects.toThrow("deflate stream failed");
    expect(() => sizeArchive.readSync("safe")).toThrow("deflate stream failed");
  });

  test.skipIf(!retailArchiveAvailable)("mounts an installed retail archive without loading it as one buffer", async () => {
    using archive = await Pk3Archive.open(retailArchivePath);
    expect(archive.entries.length).toBeGreaterThan(3_000);
    expect(archive.checksum).toBe(1_566_731_103);
    expect(archive.pureChecksum(0)).toBe(1_615_543_659);
    expect(archive.pureChecksum(0x12345678)).toBe(3_017_657_714);
    expect(archive.has("default.cfg")).toBe(true);
    expect(new TextDecoder().decode(await archive.read("default.cfg"))).toContain("unbindall");
    expect(new TextDecoder().decode(archive.readSync("default.cfg"))).toContain("unbindall");
  });

  test.skipIf(!retailMissionpackAvailable)("matches the installed Team Arena pak0 checksums", async () => {
    using archive = await Pk3Archive.open(retailMissionpackPath);
    expect(archive.checksum).toBe(2_430_342_401);
    expect(archive.pureChecksum(0)).toBe(895_799_737);
    expect(archive.pureChecksum(0x12345678)).toBe(2_674_869_564);
  });

  const retailMaps = [
    { available: retailArchiveAvailable, archivePath: retailArchivePath, map: "maps/q3dm1.bsp" },
    { available: retailMissionpackAvailable, archivePath: retailMissionpackPath, map: "maps/mpteam1.bsp" },
  ];
  for (const fixture of retailMaps) {
    test.skipIf(!fixture.available)(`streams installed ${fixture.map} through retained and whole-file reads`, async () => {
      using archive = await Pk3Archive.open(fixture.archivePath);
      const expected = await archive.read(fixture.map);
      expect(expected.byteLength).toBeGreaterThan(65_536);
      expect(new TextDecoder().decode(expected.subarray(0, 4))).toBe("IBSP");
      expect(new DataView(expected.buffer, expected.byteOffset, expected.byteLength).getInt32(4, true)).toBe(46);
      expect(archive.readSync(fixture.map)).toEqual(expected);
      const reader = archive.openRead(fixture.map);
      try {
        expect(reader.length).toBe(expected.byteLength);
        const prefix: Uint8Array = new Uint8Array(1);
        expect(reader.readInto(prefix)).toBe(1);
        expect(prefix).toEqual(expected.subarray(0, 1));
        let position = 1;
        const destination: Uint8Array = new Uint8Array(8191);
        while (position < expected.byteLength) {
          destination.fill(0x7e);
          const count = Math.min(destination.byteLength, expected.byteLength - position);
          expect(reader.readInto(destination)).toBe(count);
          expect(destination.subarray(0, count)).toEqual(expected.subarray(position, position + count));
          expect(destination.subarray(count)).toEqual(new Uint8Array(destination.byteLength - count).fill(0x7e));
          position += count;
        }
        expect(reader.readInto(prefix)).toBe(0);
        expect(reader.rewind()).toBe(0);
        expect(reader.readInto(prefix)).toBe(1);
        expect(prefix).toEqual(expected.subarray(0, 1));
      } finally {
        reader.close();
      }
    });
  }
});
