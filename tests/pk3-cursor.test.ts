import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, openSync, readdirSync, readlinkSync, truncateSync, writeSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pk3Archive, Pk3Error, Pk3OpenError } from "../src/assets/pk3.ts";
import type { Pk3FileReader } from "../src/assets/pk3.ts";
import { sourceZip } from "./pk3-source-fixture.ts";

const directories: string[] = [];
const readers: Pk3FileReader[] = [];
const archives: Pk3Archive[] = [];
const methods: readonly (0 | 8)[] = [0, 8];
const ownerships: readonly ("independent" | "shared")[] = ["independent", "shared"];
const name = new TextEncoder().encode("scripts/Entry.cfg");
const qpath = "SCRIPTS\\ENTRY.CFG";

afterEach(async () => {
  for (const reader of readers.splice(0)) reader.close();
  for (const archive of archives.splice(0)) archive.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function zip(data: Uint8Array, method: 0 | 8): Uint8Array {
  return sourceZip([{ name, data, method, utf8: false }]);
}

async function fixture(bytes: Uint8Array): Promise<{ readonly archive: Pk3Archive; readonly path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "quake3-pk3-cursor-"));
  directories.push(directory);
  const path = join(directory, "fixture.pk3");
  await writeFile(path, bytes);
  const archive = await Pk3Archive.open(path);
  archives.push(archive);
  return { archive, path };
}

function open(archive: Pk3Archive): Pk3FileReader {
  const reader = archive.openRead(qpath);
  readers.push(reader);
  return reader;
}

function centralOffset(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.byteLength - 6, true);
}

function descriptorCount(path: string): number {
  let count = 0;
  for (const descriptor of readdirSync("/proc/self/fd")) {
    try {
      if (readlinkSync(`/proc/self/fd/${descriptor}`) === path) count++;
    } catch (error) {
      // The directory enumeration's own descriptor may already have closed.
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return count;
}

describe("retained PK3 entry readers", () => {
  for (const method of methods) {
    test(`method ${method}: shared opens replace one current entry and retirement preserves independent readers`, async () => {
      const bytes = sourceZip([
        { name, data: new TextEncoder().encode("0123456"), method, utf8: false },
        { name: new TextEncoder().encode("other.cfg"), data: new TextEncoder().encode("abcd"), method, utf8: false },
      ]);
      const { archive, path } = await fixture(bytes);
      const before = descriptorCount(path);
      const independent = open(archive);
      const first = archive.openSharedRead(qpath);
      expect(descriptorCount(path)).toBe(before + 1);
      const prefix = new Uint8Array(2);
      expect(first.readInto(prefix)).toBe(2);
      expect(new TextDecoder().decode(prefix)).toBe("01");
      const second = archive.openSharedRead("other.cfg");
      expect(descriptorCount(path)).toBe(before + 1);
      expect(first.length).toBe(4);
      expect(second.length).toBe(4);
      expect(independent.length).toBe(7);
      expect(first.readInto(prefix)).toBe(2);
      expect(new TextDecoder().decode(prefix)).toBe("ab");
      const tail = new Uint8Array(4).fill(0x7e);
      expect(second.readInto(tail)).toBe(2);
      expect(new TextDecoder().decode(tail)).toBe("cd~~");
      first.close();
      first.close();
      expect(first.length).toBe(4);
      expect(() => second.readInto(prefix)).toThrow("reader is closed");
      expect(descriptorCount(path)).toBe(before + 1);
      const reopened = archive.openSharedRead(qpath);
      expect(reopened.readInto(prefix)).toBe(2);
      expect(new TextDecoder().decode(prefix)).toBe("01");
      const uniqueOther = archive.openRead("other.cfg");
      expect(reopened.length).toBe(4);
      expect(independent.length).toBe(7);
      uniqueOther.close();
      archive.close();
      archive.close();
      expect(() => reopened.readInto(prefix)).toThrow("reader is closed");
      expect(descriptorCount(path)).toBe(before);
      expect(independent.readInto(prefix)).toBe(2);
      expect(new TextDecoder().decode(prefix)).toBe("01");
      independent.close();
      expect(descriptorCount(path)).toBe(before - 1);
      expect(() => archive.openSharedRead("other.cfg")).toThrow("archive is closed");
      expect(() => archive.openRead(qpath)).toThrow("archive is closed");
      expect(() => archive.readSync(qpath)).toThrow("archive is closed");
      await expect(archive.read(qpath)).rejects.toThrow("archive is closed");
    });

    test(`method ${method}: shared close keeps the actual archive descriptor for the next entry`, async () => {
      const { archive, path } = await fixture(zip(new TextEncoder().encode("original"), method));
      const first = archive.openSharedRead(qpath);
      first.close();
      await rename(path, `${path}.original`);
      await writeFile(path, zip(new TextEncoder().encode("replaced"), method));
      const second = archive.openSharedRead(qpath);
      const destination = new Uint8Array(8);
      expect(second.readInto(destination)).toBe(8);
      expect(new TextDecoder().decode(destination)).toBe("original");
      second.close();
      archive.close();
      expect(descriptorCount(`${path}.original`)).toBe(0);
    });

    test(`method ${method}: independent offsets, short reads, untouched tails and close`, async () => {
      const { archive, path } = await fixture(zip(new TextEncoder().encode("0123456"), method));
      const before = descriptorCount(path);
      const first = open(archive);
      const second = open(archive);
      expect(descriptorCount(path)).toBe(before + 2);
      expect(first.length).toBe(7);
      expect(second.length).toBe(7);
      expect(first.readInto(new Uint8Array())).toBe(0);
      const prefix = new Uint8Array(4);
      expect(first.readInto(prefix)).toBe(4);
      expect(new TextDecoder().decode(prefix)).toBe("0123");
      const independent = new Uint8Array(2);
      expect(second.readInto(independent)).toBe(2);
      expect(new TextDecoder().decode(independent)).toBe("01");
      const remainder = new Uint8Array(8).fill(0x7e);
      expect(first.readInto(remainder)).toBe(3);
      expect(new TextDecoder().decode(remainder)).toBe("456~~~~~");
      expect(first.readInto(remainder)).toBe(0);
      expect(new TextDecoder().decode(remainder)).toBe("456~~~~~");
      first.close();
      first.close();
      expect(descriptorCount(path)).toBe(before + 1);
      expect(() => first.readInto(new Uint8Array())).toThrow("reader is closed");
      expect(() => first.readInto(prefix)).toThrow(Pk3Error);
      expect(first.length).toBe(7);
      remainder.fill(0x7e);
      expect(second.readInto(remainder)).toBe(5);
      expect(new TextDecoder().decode(remainder)).toBe("23456~~~");
      second.close();
      expect(descriptorCount(path)).toBe(before);
    });

    test(`method ${method}: payload CRC mismatch does not fail retained reads or close`, async () => {
      const bytes = zip(new Uint8Array(65_537).fill(42), method);
      const view = new DataView(bytes.buffer);
      const badCrc = view.getUint32(14, true) ^ 0xffffffff;
      view.setUint32(14, badCrc, true);
      view.setUint32(centralOffset(bytes) + 16, badCrc, true);
      const { archive, path } = await fixture(bytes);
      const checksum = archive.checksum;
      const pureChecksum = archive.pureChecksum(0x12345678);
      const before = descriptorCount(path);
      const sizeOnly = open(archive);
      expect(sizeOnly.length).toBe(65_537);
      expect(descriptorCount(path)).toBe(before + 1);
      expect(sizeOnly.readInto(new Uint8Array())).toBe(0);
      sizeOnly.close();
      expect(descriptorCount(path)).toBe(before);
      const partial = open(archive);
      const destination = new Uint8Array(1).fill(0x7e);
      expect(partial.readInto(destination)).toBe(1);
      expect(destination).toEqual(new Uint8Array([42]));
      partial.close();
      expect(descriptorCount(path)).toBe(before);
      const actualRead = open(archive);
      expect(actualRead.readInto(destination)).toBe(1);
      expect(actualRead.readInto(new Uint8Array())).toBe(0);
      const remainder = new Uint8Array(65_540).fill(0x7e);
      expect(actualRead.readInto(remainder)).toBe(65_536);
      expect(remainder.subarray(0, 65_536)).toEqual(new Uint8Array(65_536).fill(42));
      expect(remainder.subarray(65_536)).toEqual(new Uint8Array(4).fill(0x7e));
      destination.fill(0x7e);
      expect(actualRead.readInto(destination)).toBe(0);
      expect(destination).toEqual(new Uint8Array([0x7e]));
      expect(descriptorCount(path)).toBe(before + 1);
      expect(actualRead.rewind()).toBe(0);
      expect(actualRead.readInto(destination)).toBe(1);
      expect(destination).toEqual(new Uint8Array([42]));
      actualRead.close();
      expect(descriptorCount(path)).toBe(before);
      const shared = archive.openSharedRead(qpath);
      expect(shared.readInto(new Uint8Array(65_538))).toBe(65_537);
      expect(shared.readInto(destination)).toBe(0);
      shared.close();
      expect(archive.entries[0]?.crc32).toBe(badCrc >>> 0);
      expect(archive.checksum).toBe(checksum);
      expect(archive.pureChecksum(0x12345678)).toBe(pureChecksum);
      expect(() => archive.readSync(qpath)).toThrow("CRC32");
      await expect(archive.read(qpath)).rejects.toThrow("CRC32");
      archive.close();
      expect(descriptorCount(path)).toBe(before - 1);
    });

    test(`method ${method}: empty entries and zero requests leave destinations untouched`, async () => {
      const { archive, path } = await fixture(zip(new Uint8Array(), method));
      const before = descriptorCount(path);
      const reader = open(archive);
      const destination = new Uint8Array(3).fill(0x7e);
      expect(reader.length).toBe(0);
      expect(reader.readInto(new Uint8Array())).toBe(0);
      expect(reader.readInto(destination)).toBe(0);
      expect(reader.readInto(destination)).toBe(0);
      expect(destination).toEqual(new Uint8Array([0x7e, 0x7e, 0x7e]));
      reader.close();
      expect(descriptorCount(path)).toBe(before);
    });

    test(`method ${method}: reader retains the acquired file after path replacement`, async () => {
      const { archive, path } = await fixture(zip(new TextEncoder().encode("original"), method));
      const reader = open(archive);
      await rename(path, `${path}.original`);
      await writeFile(path, zip(new TextEncoder().encode("replaced"), method));
      const destination = new Uint8Array(8);
      expect(reader.readInto(destination)).toBe(8);
      expect(new TextDecoder().decode(destination)).toBe("original");
    });

    test(`method ${method}: buffered bytes survive payload changes after the first read`, async () => {
      const bytes = zip(new TextEncoder().encode("0123456"), method);
      const { archive, path } = await fixture(bytes);
      const reader = open(archive);
      expect(reader.readInto(new Uint8Array(1))).toBe(1);
      truncateSync(path, 0);
      const destination = new Uint8Array(8).fill(0x7e);
      expect(reader.readInto(destination)).toBe(6);
      expect(new TextDecoder().decode(destination)).toBe("123456~~");
    });

    test(`method ${method}: later reads refill the bounded compressed buffer`, async () => {
      const data = new Uint8Array(196_608);
      let random = 0x12345678;
      for (let index = 0; index < data.byteLength; index++) {
        random ^= random << 13;
        random ^= random >>> 17;
        random ^= random << 5;
        data[index] = random & 255;
      }
      const bytes = zip(data, method);
      expect(new DataView(bytes.buffer).getUint32(18, true)).toBeGreaterThan(65_536);
      const { archive, path } = await fixture(bytes);
      const before = descriptorCount(path);
      const reader = open(archive);
      const prefix = new Uint8Array(32);
      expect(reader.readInto(prefix)).toBe(32);
      expect(prefix).toEqual(data.subarray(0, 32));
      truncateSync(path, 30 + name.byteLength + 65_536);
      const buffered = new Uint8Array(32_768);
      expect(reader.readInto(buffered)).toBe(32_768);
      expect(buffered).toEqual(data.subarray(32, 32_800));
      const remainder = new Uint8Array(65_536).fill(0x7e);
      expect(() => reader.readInto(remainder)).toThrow("short read");
      expect(remainder.subarray(0, 1024)).toEqual(data.subarray(32_800, 33_824));
      expect(remainder.subarray(32_736)).toEqual(new Uint8Array(32_800).fill(0x7e));
      expect(descriptorCount(path)).toBe(before);
    });

    test(`method ${method}: rewind resets output history on the captured descriptor`, async () => {
      const data = new Uint8Array(98_317);
      for (let index = 0; index < data.byteLength; index++) data[index] = index % 251;
      const { archive, path } = await fixture(zip(data, method));
      const reader = open(archive);
      const prefix = new Uint8Array(32_769);
      expect(reader.readInto(prefix)).toBe(prefix.byteLength);
      expect(prefix).toEqual(data.subarray(0, prefix.byteLength));
      await rename(path, `${path}.original`);
      await writeFile(path, zip(new Uint8Array(data.byteLength).fill(42), method));
      expect(reader.rewind()).toBe(0);
      const sizes = [1, 257, 32_768, 65_536];
      let position = 0;
      for (const size of sizes) {
        const destination = new Uint8Array(size).fill(0x7e);
        const count = Math.min(size, data.byteLength - position);
        expect(reader.readInto(destination)).toBe(count);
        expect(destination.subarray(0, count)).toEqual(data.subarray(position, position + count));
        expect(destination.subarray(count)).toEqual(new Uint8Array(size - count).fill(0x7e));
        position += count;
      }
      expect(position).toBe(data.byteLength);
      expect(reader.readInto(new Uint8Array(1))).toBe(0);
    });

    for (const ownership of ownerships) {
      test(`method ${method}: ${ownership} initial open reads mounted metadata and the selected payload descriptor`, async () => {
        const otherName = new TextEncoder().encode("scripts/Other.cfg");
        const originalData = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
        const mountedData = new Uint8Array([9, 8, 7]);
        const replacementData = new Uint8Array([21, 22, 23]);
        const otherMethod = method === 0 ? 8 : 0;
        const bytes = sourceZip([
          { name, data: originalData, method, utf8: false },
          { name: otherName, data: mountedData, method: otherMethod, utf8: false },
        ]);
        const { archive, path } = await fixture(bytes);
        const entries = archive.entries;
        const checksum = archive.checksum;
        const pureChecksum = archive.pureChecksum(0x12345678);
        expect(descriptorCount(path)).toBe(1);
        await rename(path, `${path}.original`);
        const recordOffset = centralOffset(bytes);
        const recordLength = 46 + name.byteLength;
        const otherRecord = bytes.subarray(recordOffset + recordLength, recordOffset + recordLength * 2);
        const writer = openSync(`${path}.original`, "r+");
        try {
          expect(writeSync(writer, otherRecord, 0, otherRecord.byteLength, recordOffset)).toBe(recordLength);
        } finally {
          closeSync(writer);
        }
        const replacement = sourceZip([
          { name, data: originalData, method, utf8: false },
          { name: otherName, data: replacementData, method: otherMethod, utf8: false },
        ]);
        const replacementView = new DataView(replacement.buffer);
        const otherLocalOffset = replacementView.getUint32(centralOffset(replacement) + recordLength + 42, true);
        const mountedCrc = new DataView(otherRecord.buffer, otherRecord.byteOffset, otherRecord.byteLength).getUint32(16, true);
        replacementView.setUint32(otherLocalOffset + 14, mountedCrc, true);
        await writeFile(path, replacement);
        const reader = ownership === "independent" ? open(archive) : archive.openSharedRead(qpath);
        const expected = ownership === "independent" ? replacementData : mountedData;
        expect(reader.length).toBe(3);
        const destination = new Uint8Array(8).fill(0x7e);
        expect(reader.readInto(destination)).toBe(3);
        expect(destination.subarray(0, 3)).toEqual(expected);
        expect(destination.subarray(3)).toEqual(new Uint8Array(5).fill(0x7e));
        expect(descriptorCount(`${path}.original`)).toBe(1);
        expect(descriptorCount(path)).toBe(ownership === "independent" ? 1 : 0);
        expect(reader.rewind()).toBe(0);
        const rewound = ownership === "independent" ? originalData : mountedData;
        expect(reader.length).toBe(rewound.byteLength);
        destination.fill(0x7e);
        expect(reader.readInto(destination)).toBe(rewound.byteLength);
        expect(destination.subarray(0, rewound.byteLength)).toEqual(rewound);
        expect(archive.entries).toBe(entries);
        expect(archive.entries[0]?.uncompressedSize).toBe(7);
        expect(archive.checksum).toBe(checksum);
        expect(archive.pureChecksum(0x12345678)).toBe(pureChecksum);
        reader.close();
        expect(descriptorCount(path)).toBe(0);
        archive.close();
        expect(descriptorCount(`${path}.original`)).toBe(0);
      });

      test(`method ${method}: ${ownership} rewind rereads the saved central record from its retained descriptor`, async () => {
        const otherName = new TextEncoder().encode("scripts/Other.cfg");
        const originalData = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
        const redirectedData = new Uint8Array([9, 8, 7]);
        const bytes = sourceZip([
          { name, data: originalData, method, utf8: false },
          { name: otherName, data: redirectedData, method: method === 0 ? 8 : 0, utf8: false },
        ]);
        const { archive, path } = await fixture(bytes);
        const entries = archive.entries;
        const checksum = archive.checksum;
        const pureChecksum = archive.pureChecksum(0x12345678);
        const reader = ownership === "independent" ? open(archive) : archive.openSharedRead(qpath);
        const prefix = new Uint8Array(2);
        expect(reader.readInto(prefix)).toBe(2);
        expect(prefix).toEqual(originalData.subarray(0, 2));
        await rename(path, `${path}.original`);
        await writeFile(path, zip(new Uint8Array([42, 42, 42]), method));
        const recordOffset = centralOffset(bytes);
        const recordLength = 46 + name.byteLength;
        expect(otherName.byteLength).toBe(name.byteLength);
        const changedRecord = bytes.subarray(recordOffset + recordLength, recordOffset + recordLength * 2);
        const writer = openSync(`${path}.original`, "r+");
        try {
          expect(writeSync(writer, changedRecord, 0, changedRecord.byteLength, recordOffset)).toBe(recordLength);
        } finally {
          closeSync(writer);
        }
        expect(reader.length).toBe(7);
        expect(reader.rewind()).toBe(0);
        expect(reader.length).toBe(3);
        const destination = new Uint8Array(5).fill(0x7e);
        expect(reader.readInto(destination)).toBe(3);
        expect(destination).toEqual(new Uint8Array([9, 8, 7, 0x7e, 0x7e]));
        expect(reader.readInto(destination)).toBe(0);
        expect(descriptorCount(`${path}.original`)).toBe(ownership === "independent" ? 2 : 1);
        expect(descriptorCount(path)).toBe(0);
        expect(archive.entries).toBe(entries);
        expect(archive.entries[0]?.uncompressedSize).toBe(7);
        expect(archive.checksum).toBe(checksum);
        expect(archive.pureChecksum(0x12345678)).toBe(pureChecksum);
        reader.close();
        archive.close();
        expect(descriptorCount(`${path}.original`)).toBe(0);
      });
    }
  }

  test("independent open publishes mounted metadata after pathname acquisition and before local validation", async () => {
    const bytes = zip(new Uint8Array([1, 2, 3, 4, 5, 6, 7]), 0);
    const { archive, path } = await fixture(bytes);
    const shared = archive.openSharedRead(qpath);
    expect(shared.readInto(new Uint8Array(1))).toBe(1);
    await rename(path, `${path}.original`);
    const changed = bytes.slice();
    const changedView = new DataView(changed.buffer);
    changedView.setUint32(centralOffset(changed) + 20, 3, true);
    changedView.setUint32(centralOffset(changed) + 24, 3, true);
    await writeFile(`${path}.original`, changed);
    expect(() => archive.openRead(qpath)).toThrow("ENOENT");
    expect(shared.length).toBe(7);
    expect(descriptorCount(`${path}.original`)).toBe(1);
    const replacement = bytes.slice();
    replacement[0] = 0;
    await writeFile(path, replacement);
    expect(() => archive.openRead(qpath)).toThrow("local file header signature");
    expect(shared.length).toBe(3);
    expect(descriptorCount(path)).toBe(0);
    expect(descriptorCount(`${path}.original`)).toBe(1);
    const remaining = new Uint8Array(8).fill(0x7e);
    expect(shared.readInto(remaining)).toBe(6);
    expect(remaining).toEqual(new Uint8Array([2, 3, 4, 5, 6, 7, 0x7e, 0x7e]));
    archive.close();
    expect(descriptorCount(`${path}.original`)).toBe(0);
  });

  test("diagnostic archive disposal and rejected index acquisition release the mounted descriptor", async () => {
    const bytes = zip(new Uint8Array([1, 2, 3]), 0);
    const { archive, path } = await fixture(bytes);
    expect(descriptorCount(path)).toBe(1);
    archive.close();
    expect(descriptorCount(path)).toBe(0);
    {
      using diagnostic = await Pk3Archive.open(path);
      expect(descriptorCount(path)).toBe(1);
      expect(diagnostic.readSync(qpath)).toEqual(new Uint8Array([1, 2, 3]));
    }
    expect(descriptorCount(path)).toBe(0);
    new DataView(bytes.buffer).setUint32(centralOffset(bytes), 0, true);
    await writeFile(path, bytes);
    await expect(Pk3Archive.open(path)).rejects.toThrow("central directory signature");
    expect(descriptorCount(path)).toBe(0);
  });

  test("unopened short archives retain diagnostic errors and release their temporary descriptors", async () => {
    const { archive, path } = await fixture(zip(new Uint8Array([1, 2, 3]), 0));
    archive.close();
    for (const length of [0, 1, 21]) {
      await writeFile(path, new Uint8Array(length));
      await expect(Pk3Archive.open(path)).rejects.toBeInstanceOf(Pk3OpenError);
      expect(descriptorCount(path)).toBe(0);
    }
    await rename(path, `${path}.moved`);
    await expect(Pk3Archive.open(path)).rejects.toBeInstanceOf(Pk3OpenError);
    expect(descriptorCount(`${path}.moved`)).toBe(0);
  });

  test("retained deflate clips at the declared size without probing the trailing stream", async () => {
    const data = new Uint8Array([1, 2, 3]);
    const bytes = zip(data, 8);
    const prefix = zip(data.subarray(0, 2), 0);
    const crc = new DataView(prefix.buffer).getUint32(14, true);
    const view = new DataView(bytes.buffer);
    view.setUint32(14, crc, true);
    view.setUint32(22, 2, true);
    view.setUint32(centralOffset(bytes) + 16, crc, true);
    view.setUint32(centralOffset(bytes) + 24, 2, true);
    const { archive } = await fixture(bytes);
    const reader = open(archive);
    const destination = new Uint8Array(4).fill(0x7e);
    expect(reader.readInto(destination)).toBe(2);
    expect(destination).toEqual(new Uint8Array([1, 2, 0x7e, 0x7e]));
    expect(reader.readInto(destination)).toBe(0);
    expect(destination).toEqual(new Uint8Array([1, 2, 0x7e, 0x7e]));
    expect(() => archive.readSync(qpath)).toThrow("deflate stream failed");
    await expect(archive.read(qpath)).rejects.toThrow("deflate stream failed");
  });

  test("early deflate end returns short retained reads while whole-file reads reject the size", async () => {
    const bytes = zip(new Uint8Array([1, 2, 3]), 8);
    const view = new DataView(bytes.buffer);
    view.setUint32(22, 4, true);
    view.setUint32(centralOffset(bytes) + 24, 4, true);
    const { archive } = await fixture(bytes);
    const reader = open(archive);
    const destination = new Uint8Array(4).fill(0x7e);
    expect(reader.length).toBe(4);
    expect(reader.readInto(destination)).toBe(3);
    expect(destination).toEqual(new Uint8Array([1, 2, 3, 0x7e]));
    expect(reader.readInto(destination)).toBe(0);
    reader.close();
    expect(() => archive.readSync(qpath)).toThrow("inflated size 3 does not match 4");
    await expect(archive.read(qpath)).rejects.toThrow("inflated size 3 does not match 4");
  });

  test("invalid deflate payload with a large declared length fails only on a nonzero read", async () => {
    const bytes = zip(new Uint8Array([1, 2, 3]), 8);
    const view = new DataView(bytes.buffer);
    view.setUint32(22, 1024 * 1024, true);
    view.setUint32(centralOffset(bytes) + 24, 1024 * 1024, true);
    bytes[30 + name.byteLength] = 7;
    const { archive, path } = await fixture(bytes);
    const before = descriptorCount(path);
    const sizeOnly = open(archive);
    expect(sizeOnly.length).toBe(1024 * 1024);
    expect(sizeOnly.readInto(new Uint8Array())).toBe(0);
    sizeOnly.close();
    const reader = open(archive);
    expect(() => reader.readInto(new Uint8Array(1))).toThrow("deflate stream failed");
    expect(descriptorCount(path)).toBe(before);
  });

  test("invalid local headers, raw names and payload ranges reject at open and release the descriptor", async () => {
    const mutations: readonly ((bytes: Uint8Array) => void)[] = [
      (bytes) => { new DataView(bytes.buffer).setUint32(0, 0, true); },
      (bytes) => { new DataView(bytes.buffer).setUint16(8, 8, true); },
      (bytes) => { new DataView(bytes.buffer).setUint32(22, 99, true); },
      (bytes) => { bytes[30] = 88; },
      (bytes) => { new DataView(bytes.buffer).setUint16(28, 1, true); },
    ];
    for (const mutate of mutations) {
      const bytes = zip(new Uint8Array([1, 2, 3]), 0);
      mutate(bytes);
      const { archive, path } = await fixture(bytes);
      const before = descriptorCount(path);
      expect(() => archive.openRead(qpath)).toThrow(Pk3Error);
      expect(descriptorCount(path)).toBe(before);
    }
  });

  test("truncation before open rejects the central read without retaining an independent fd", async () => {
    const { archive, path } = await fixture(zip(new Uint8Array([1, 2, 3]), 0));
    const before = descriptorCount(path);
    truncateSync(path, 30 + name.byteLength + 2);
    expect(() => archive.openRead(qpath)).toThrow("range of 46 bytes");
    expect(descriptorCount(path)).toBe(before);
  });

  test("truncation after open fails first read, preserves the tail and releases the descriptor", async () => {
    const { archive, path } = await fixture(zip(new Uint8Array([1, 2, 3]), 0));
    const before = descriptorCount(path);
    const reader = open(archive);
    truncateSync(path, 30 + name.byteLength + 2);
    expect(reader.length).toBe(3);
    const destination = new Uint8Array(4).fill(0x7e);
    expect(() => reader.readInto(destination)).toThrow("short read");
    expect(destination).toEqual(new Uint8Array([0x7e, 0x7e, 0x7e, 0x7e]));
    expect(descriptorCount(path)).toBe(before);
    reader.close();
  });

  for (const ownership of ownerships) {
    test(`${ownership} rewind rejects a truncated central record and retires its reader`, async () => {
      const bytes = zip(new Uint8Array([1, 2, 3]), 0);
      const { archive, path } = await fixture(bytes);
      const before = descriptorCount(path);
      const reader = ownership === "independent" ? open(archive) : archive.openSharedRead(qpath);
      expect(reader.readInto(new Uint8Array(1))).toBe(1);
      truncateSync(path, centralOffset(bytes) + 45);
      expect(() => reader.rewind()).toThrow("range of 46 bytes");
      expect(descriptorCount(path)).toBe(before);
      expect(() => reader.readInto(new Uint8Array(1))).toThrow("reader is closed");
    });

    test(`${ownership} rewind validates current central metadata before the local header`, async () => {
      const bytes = zip(new Uint8Array([1, 2, 3]), 0);
      const { archive, path } = await fixture(bytes);
      const before = descriptorCount(path);
      const reader = ownership === "independent" ? open(archive) : archive.openSharedRead(qpath);
      const view = new DataView(bytes.buffer);
      view.setUint32(centralOffset(bytes), 0, true);
      view.setUint32(0, 0, true);
      await writeFile(path, bytes);
      expect(() => reader.rewind()).toThrow("invalid central directory signature");
      expect(descriptorCount(path)).toBe(before);
      expect(() => reader.readInto(new Uint8Array(1))).toThrow("reader is closed");
    });

    test(`${ownership} rewind keeps the payload boundary when refreshed sizes overlap the directory`, async () => {
      const bytes = zip(new Uint8Array([1, 2, 3]), 0);
      const { archive, path } = await fixture(bytes);
      const before = descriptorCount(path);
      const reader = ownership === "independent" ? open(archive) : archive.openSharedRead(qpath);
      const view = new DataView(bytes.buffer);
      view.setUint32(18, 4, true);
      view.setUint32(22, 4, true);
      view.setUint32(centralOffset(bytes) + 20, 4, true);
      view.setUint32(centralOffset(bytes) + 24, 4, true);
      await writeFile(path, bytes);
      expect(() => reader.rewind()).toThrow("entry data overlaps central directory");
      expect(descriptorCount(path)).toBe(before);
      expect(() => reader.readInto(new Uint8Array(1))).toThrow("reader is closed");
    });
  }

  test("missing entries retain the existing error and do not acquire a descriptor", async () => {
    const { archive, path } = await fixture(zip(new Uint8Array([1]), 0));
    const before = descriptorCount(path);
    expect(() => archive.openRead("missing.cfg")).toThrow("entry not found");
    expect(() => archive.openRead("../escape")).toThrow(RangeError);
    expect(descriptorCount(path)).toBe(before);
  });

  test("shared failed open and read retain the mounted descriptor for the next entry", async () => {
    const goodBytes = zip(new Uint8Array([1, 2, 3]), 8);
    const { archive, path } = await fixture(goodBytes);
    const before = descriptorCount(path);
    const invalidHeader = goodBytes.slice();
    invalidHeader[0] = 0;
    await writeFile(path, invalidHeader);
    expect(() => archive.openSharedRead(qpath)).toThrow("local file header signature");
    expect(descriptorCount(path)).toBe(before);
    const corruptPayload = goodBytes.slice();
    corruptPayload[30 + name.byteLength] = 7;
    await writeFile(path, corruptPayload);
    const invalidRead = archive.openSharedRead(qpath);
    expect(invalidRead.readInto(new Uint8Array())).toBe(0);
    expect(descriptorCount(path)).toBe(before);
    const remainder = new Uint8Array(3).fill(0x7e);
    expect(() => invalidRead.readInto(remainder)).toThrow("deflate stream failed");
    expect(remainder).toEqual(new Uint8Array([0x7e, 0x7e, 0x7e]));
    expect(descriptorCount(path)).toBe(before);
    invalidRead.close();
    await writeFile(path, goodBytes);
    const fresh = archive.openSharedRead(qpath);
    const destination = new Uint8Array(3);
    expect(fresh.readInto(destination)).toBe(3);
    expect(destination).toEqual(new Uint8Array([1, 2, 3]));
    archive.close();
    expect(descriptorCount(path)).toBe(before - 1);
  });
});
