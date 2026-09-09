import { afterEach, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareZipFileNames, Pk3Archive } from "../src/assets/pk3.ts";
import { sourceZip } from "./pk3-source-fixture.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

async function archiveFixture(bytes: Uint8Array) {
  const directory = mkdtempSync(join(tmpdir(), "quake3-zip-library-")); directories.push(directory);
  const path = join(directory, "fixture.pk3"); writeFileSync(path, bytes);
  return { archive: await Pk3Archive.open(path), path };
}

function metadataZip() {
  const name = encode("Record.bin"), data = Uint8Array.of(1, 2, 3);
  const plain = sourceZip([{ name, data, method: 0, utf8: false }]);
  const oldEnd = plain.length - 22, oldView = new DataView(plain.buffer);
  const oldCentral = oldView.getUint32(oldEnd + 16, true), oldCentralSize = oldEnd - oldCentral;
  const localExtra = Uint8Array.of(0xa1, 0xa2, 0xa3, 0xa4), extra = Uint8Array.of(9, 8, 7), comment = encode("abc"), global = encode("global");
  const localExtraOffset = 30 + name.length, centralOffset = oldCentral + localExtra.length;
  const centralSize = oldCentralSize + extra.length + comment.length, endOffset = centralOffset + centralSize;
  const bytes = new Uint8Array(endOffset + 22 + global.length), view = new DataView(bytes.buffer);
  bytes.set(plain.subarray(0, localExtraOffset)); bytes.set(localExtra, localExtraOffset);
  bytes.set(plain.subarray(localExtraOffset, oldCentral), localExtraOffset + localExtra.length);
  bytes.set(plain.subarray(oldCentral, oldEnd), centralOffset);
  bytes.set(extra, centralOffset + oldCentralSize); bytes.set(comment, centralOffset + oldCentralSize + extra.length);
  bytes.set(plain.subarray(oldEnd), endOffset); bytes.set(global, endOffset + 22);
  view.setUint16(28, localExtra.length, true);
  view.setUint16(centralOffset + 4, 0x0314, true);
  const dosDate = (((2024 - 1980) << 25) | (7 << 21) | (19 << 16) | (13 << 11) | (42 << 5) | 14) >>> 0;
  view.setUint32(10, dosDate, true); view.setUint32(centralOffset + 12, dosDate, true);
  view.setUint16(centralOffset + 30, extra.length, true); view.setUint16(centralOffset + 32, comment.length, true);
  view.setUint16(centralOffset + 36, 1, true); view.setUint32(centralOffset + 38, 0xaabbccdd, true);
  view.setUint32(endOffset + 12, centralSize, true); view.setUint32(endOffset + 16, centralOffset, true);
  view.setUint16(endOffset + 20, global.length, true);
  return { bytes, data, localExtra, localExtraOffset, extra, comment, global, dosDate, centralOffset, endOffset };
}

test("ZIP filename comparison retains Unix default, ASCII folding, byte signs and C termination", () => {
  expect(compareZipFileNames("a", "A")).toBe(32);
  expect(compareZipFileNames("a", "A", 1)).toBe(32);
  for (const sensitivity of [2, -1, 3]) expect(compareZipFileNames("a/FiLe", "A/fIlE", sensitivity)).toBe(0);
  expect(compareZipFileNames("a\\b", "a/b", 2)).not.toBe(0);
  expect(compareZipFileNames("\xff", "A", 2)).toBe(-1);
  expect(compareZipFileNames("\xff", "A", 1)).toBeGreaterThan(0);
  expect(compareZipFileNames("a\0ignored", "a\0other")).toBe(0);
  expect(() => compareZipFileNames("€", "e")).toThrow("source bytes");
});

test("locate uses the actual shared directory cursor, including source miss cache behavior", async () => {
  const entries: readonly (readonly [string, string])[] = [["Same.txt", "first"], ["same.txt", "second"], ["folder/", "DIR"]];
  const bytes = sourceZip(entries.map(([name, data]) => ({ name: encode(name), data: encode(data), method: 0, utf8: false })));
  const { archive } = await archiveFixture(bytes);
  try {
    expect(archive.globalInformation.entryCount).toBe(3);
    expect(archive.locateFile("same.txt")).toBe(true);
    const exact = archive.openCurrentRead(); expect(exact.length).toBe(6); exact.close();
    expect(archive.locateFile("SAME.TXT", 2)).toBe(true);
    const firstPosition = archive.currentFilePosition;
    expect(archive.getCurrentFileInformation().uncompressedSize).toBe(5);
    expect(archive.locateFile("missing")).toBe(false);
    expect(archive.currentFilePosition).toBe(firstPosition);
    expect(archive.getCurrentFileInformation().uncompressedSize).toBe(5);
    // unzGetCurrentFileInfo rereads restored position but unzOpenCurrentFile uses stale last metadata.
    const stale = archive.openCurrentRead(), data: Uint8Array<ArrayBufferLike> = new Uint8Array(3);
    expect(stale.readInto(data)).toBe(3); expect(data).toEqual(encode("DIR")); expect(stale.eof).toBe(true); stale.close();
    archive.firstFile(); expect(archive.nextFile()).toBe(true); expect(archive.nextFile()).toBe(true); expect(archive.nextFile()).toBe(false);
    expect(archive.locateFile("folder/")).toBe(true);
    archive.setCurrentFilePosition(firstPosition); expect(archive.getCurrentFileInformation().uncompressedSize).toBe(5);
    archive.setCurrentFilePosition(0); expect(archive.locateFile("Same.txt")).toBe(false);
    expect(() => archive.openCurrentRead()).toThrow("no valid current");
    archive.firstFile(); expect(archive.locateFile("Same.txt\0ignored")).toBe(true);
    expect(() => archive.locateFile("x".repeat(256))).toThrow("shorter than 256");
  } finally { archive.close(); }
});

test("live central metadata, DOS date, extra/comment buffers and global comments use source copy bounds", async () => {
  const fixture = metadataZip(), { archive, path } = await archiveFixture(fixture.bytes);
  try {
    const name = new Uint8Array(12).fill(0xee), extra = new Uint8Array(5).fill(0xee), comment = new Uint8Array(5).fill(0xee);
    const info = archive.getCurrentFileInformation({ name, extra, comment });
    expect(info).toMatchObject({ version: 0x0314, versionNeeded: 20, flags: 0, compressionMethod: 0, dosDate: fixture.dosDate,
      date: { second: 28, minute: 42, hour: 13, day: 19, month: 6, year: 2024 },
      compressedSize: 3, uncompressedSize: 3, nameLength: 10, extraLength: 3, commentLength: 3,
      diskStart: 0, internalAttributes: 1, externalAttributes: 0xaabbccdd });
    expect(name).toEqual(Uint8Array.of(...encode("Record.bin"), 0, 0xee));
    expect(extra).toEqual(Uint8Array.of(9, 8, 7, 0xee, 0xee)); expect(comment).toEqual(Uint8Array.of(97, 98, 99, 0, 0xee));
    const exactName: Uint8Array<ArrayBufferLike> = new Uint8Array(10).fill(0xee), shortComment: Uint8Array<ArrayBufferLike> = new Uint8Array(2).fill(0xee);
    archive.getCurrentFileInformation({ name: exactName, comment: shortComment });
    expect(exactName).toEqual(encode("Record.bin")); expect(shortComment).toEqual(encode("ab"));
    expect(archive.globalInformation).toEqual({ entryCount: 1, commentLength: 6 });
    for (const length of [0, 3, 6, 8]) {
      const destination: Uint8Array<ArrayBufferLike> = new Uint8Array(length).fill(0xee);
      expect(archive.readGlobalComment(destination)).toBe(Math.min(length, 6));
      expect(destination.subarray(0, Math.min(length, 6))).toEqual(fixture.global.subarray(0, Math.min(length, 6)));
      if (length > 6) expect(destination.subarray(6)).toEqual(Uint8Array.of(0, 0xee));
    }
    const descriptor = openSync(path, "r+");
    try {
      writeSync(descriptor, Uint8Array.of(0, 0, 0, 0), 0, 4, fixture.centralOffset + 12);
      writeSync(descriptor, encode("GLOBAL"), 0, 6, fixture.endOffset + 22);
    } finally { closeSync(descriptor); }
    expect(archive.getCurrentFileInformation().date).toEqual({ second: 0, minute: 0, hour: 0, day: 0, month: 0xffffffff, year: 1980 });
    const global: Uint8Array<ArrayBufferLike> = new Uint8Array(6); archive.readGlobalComment(global); expect(global).toEqual(encode("GLOBAL"));
  } finally { archive.close(); }
});

test("local extra reads retain source full-copy/nonadvancing semantics without changing payload cursor", async () => {
  const fixture = metadataZip(), { archive } = await archiveFixture(fixture.bytes);
  try {
    for (const shared of [false, true]) {
      const reader = shared ? archive.openSharedRead("Record.bin") : archive.openRead("Record.bin");
      try {
        expect(reader.readLocalExtraField(null)).toBe(4);
        const destination = new Uint8Array(6).fill(0xee);
        expect(reader.readLocalExtraField(destination, 2)).toBe(2);
        expect(destination).toEqual(Uint8Array.of(...fixture.localExtra, 0xee, 0xee));
        expect(reader.readLocalExtraField(null)).toBe(4); expect(reader.position).toBe(0);
        expect(() => reader.readLocalExtraField(new Uint8Array(2))).toThrow("overflow");
        expect(reader.readLocalExtraField(new Uint8Array(0), 0)).toBe(0);
        const data = new Uint8Array(3); expect(reader.readInto(data)).toBe(3); expect(data).toEqual(fixture.data);
        expect(reader.position).toBe(3); expect(reader.eof).toBe(true);
        reader.rewind(); expect(reader.eof).toBe(false); expect(reader.readLocalExtraField(destination)).toBe(4);
      } finally { reader.close(); }
    }
  } finally { archive.close(); }
});

test("prepended archives keep logical central positions and the source local-extra prefix omission", async () => {
  const fixture = metadataZip(), prefix = new Uint8Array(73).fill(0x5a), bytes = new Uint8Array(73 + fixture.bytes.length);
  bytes.set(prefix); bytes.set(fixture.bytes, prefix.length);
  const { archive } = await archiveFixture(bytes);
  try {
    archive.firstFile(); expect(archive.currentFilePosition).toBe(fixture.centralOffset);
    const reader = archive.openCurrentRead(), extra = new Uint8Array(4), data = new Uint8Array(3);
    try {
      expect(reader.readLocalExtraField(extra)).toBe(4);
      expect(extra).toEqual(bytes.subarray(fixture.localExtraOffset, fixture.localExtraOffset + 4));
      expect(extra).not.toEqual(fixture.localExtra);
      expect(reader.readInto(data)).toBe(3); expect(data).toEqual(fixture.data);
    } finally { reader.close(); }
  } finally { archive.close(); }
});
