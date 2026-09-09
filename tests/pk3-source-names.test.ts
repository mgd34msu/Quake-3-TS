import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Pk3Archive, Pk3Error } from "../src/assets/pk3.ts";
import { sourceNameFixtureEntries, sourceZip } from "./pk3-source-fixture.ts";
import type { SourceZipEntry } from "./pk3-source-fixture.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function archiveFrom(bytes: Uint8Array): Promise<Pk3Archive> {
  const directory = await mkdtemp(join(tmpdir(), "quake3-pk3-source-test-"));
  directories.push(directory);
  const path = join(directory, "fixture.pk3");
  await writeFile(path, bytes);
  return Pk3Archive.open(path);
}

function entry(name: Uint8Array, utf8 = false): SourceZipEntry {
  return { name, utf8, data: new Uint8Array([1, 3, 5]), method: 8 };
}

describe("PK3 source-name metadata", () => {
  test("keeps every central record in order with exact byte spelling and source lowercase", async () => {
    using archive = await archiveFrom(sourceZip(sourceNameFixtureEntries()));
    expect(archive.sourceNames).toEqual([
      { kind: "supported", rawName: "Zebra.TXT", name: "zebra.txt" },
      { kind: "supported", rawName: "Dir\\", name: "dir\\" },
      { kind: "supported", rawName: "dir/Alpha.TXT", name: "dir/alpha.txt" },
      { kind: "supported", rawName: "same.txt", name: "same.txt" },
      { kind: "supported", rawName: "SAME.TXT", name: "same.txt" },
      { kind: "supported", rawName: "dir\\Alpha.TXT", name: "dir\\alpha.txt" },
      { kind: "supported", rawName: "models/players/sarge/icon.tga", name: "models/players/sarge/icon.tga" },
      { kind: "supported", rawName: "payload/", name: "payload/" },
      { kind: "supported", rawName: "empty.txt", name: "empty.txt" },
      { kind: "supported", rawName: "folder/", name: "folder/" },
    ]);
    expect(Object.isFrozen(archive.sourceNames)).toBe(true);
    for (const name of archive.sourceNames) expect(Object.isFrozen(name)).toBe(true);
    expect(archive.entries).toHaveLength(7);
    expect(archive.list()).toEqual(["dir/alpha.txt", "empty.txt", "models/players/sarge/icon.tga", "same.txt", "zebra.txt"]);
    expect(new TextDecoder().decode(await archive.read("SAME.txt"))).toBe("second");
    expect(new TextDecoder().decode(archive.readSync("DIR\\alpha.txt"))).toBe("later");
    expect(() => archive.has("payload/")).toThrow("empty or relative component");
  });

  test("does not synthesize directory records and admits an empty archive", async () => {
    using archive = await archiveFrom(sourceZip([entry(new TextEncoder().encode("a/b/c.txt"))]));
    expect(archive.sourceNames).toEqual([{ kind: "supported", rawName: "a/b/c.txt", name: "a/b/c.txt" }]);
    using empty = await archiveFrom(sourceZip([]));
    expect(empty.sourceNames).toEqual([]);
    expect(Object.isFrozen(empty.sourceNames)).toBe(true);
    expect(empty.entries).toEqual([]);
    expect(empty.checksum).toBe(0xc6f640b7);
  });

  test("preserves raw filename bytes regardless of the UTF-8 flag", async () => {
    const name = new TextEncoder().encode("CAFÉ.TXT");
    for (const utf8 of [false, true]) {
      using archive = await archiveFrom(sourceZip([entry(name, utf8)]));
      expect(archive.sourceNames).toEqual([{ kind: "supported", rawName: "CAF\xc3\x89.TXT", name: "caf\xc3\x89.txt" }]);
      expect(Object.isFrozen(archive.sourceNames[0])).toBe(true);
      expect(archive.list()).toEqual(["caf\xc3\x89.txt"]);
      expect(archive.has("CAFÉ.TXT")).toBe(false);
      expect(Array.from(await archive.read("CAF\xc3\x89.TXT"))).toEqual([1, 3, 5]);
      expect(Array.from(archive.readSync("CAF\xc3\x89.TXT"))).toEqual([1, 3, 5]);
    }
  });

  test("does not reinterpret unflagged high bytes as UTF-8 or native lowercase", async () => {
    using archive = await archiveFrom(sourceZip([entry(new Uint8Array([0xc0, 65, 46, 84, 88, 84]))]));
    expect(archive.sourceNames).toEqual([{ kind: "supported", rawName: "\xc0A.TXT", name: "\xc0a.txt" }]);
    expect(archive.list()).toEqual(["Àa.txt"]);
    expect(Array.from(archive.readSync("ÀA.TXT"))).toEqual([1, 3, 5]);
  });

  test("includes ASCII DEL and byte128 in the C-locale glibc byte profile", async () => {
    using archive = await archiveFrom(sourceZip([
      entry(new Uint8Array([65, 127, 46, 84, 88, 84])), entry(new Uint8Array([65, 128, 46, 84, 88, 84])),
    ]));
    expect(archive.sourceNames).toEqual([
      { kind: "supported", rawName: "A\x7f.TXT", name: "a\x7f.txt" },
      { kind: "supported", rawName: "A\x80.TXT", name: "a\x80.txt" },
    ]);
    expect(Array.from(archive.readSync("a\x7f.txt"))).toEqual([1, 3, 5]);
    expect(Array.from(archive.readSync("a\x80.txt"))).toEqual([1, 3, 5]);
  });

  test("qualifies byte length 255 and 256 without rejecting diagnostic reads", async () => {
    const short = "A".repeat(251) + ".TXT";
    const long = "A".repeat(252) + ".TXT";
    const both = new Uint8Array(256).fill(65); both[0] = 0xc0;
    using archive = await archiveFrom(sourceZip([
      entry(new TextEncoder().encode(short)), entry(new TextEncoder().encode(long)), entry(both),
    ]));
    expect(archive.sourceNames).toEqual([
      { kind: "supported", rawName: short, name: short.toLowerCase() },
      { kind: "unsupported", rawName: long, reason: "name-too-long" },
      { kind: "unsupported", rawName: "\xc0" + "A".repeat(255), reason: "name-too-long" },
    ]);
    expect(archive.entries).toHaveLength(3);
    expect(Array.from(await archive.read(short))).toEqual([1, 3, 5]);
    expect(Array.from(archive.readSync(long))).toEqual([1, 3, 5]);
    expect(Array.from(archive.readSync("\xc0" + "A".repeat(255)))).toEqual([1, 3, 5]);
  });

  test("keeps directory payload CRC contributions and all duplicate CRC contributions", async () => {
    const entries = sourceNameFixtureEntries();
    using archive = await archiveFrom(sourceZip(entries));
    using withoutDirectoryPayload = await archiveFrom(sourceZip(entries.map(value =>
      new TextDecoder().decode(value.name) === "payload/" ? { ...value, data: new Uint8Array() } : value)));
    expect(archive.entries).toEqual(withoutDirectoryPayload.entries);
    expect(archive.sourceNames).toEqual(withoutDirectoryPayload.sourceNames);
    expect(archive.checksum).not.toBe(withoutDirectoryPayload.checksum);
    expect(archive.pureChecksum(0x12345678)).not.toBe(withoutDirectoryPayload.pureChecksum(0x12345678));
    // Unchanged 32-bit FS_LoadZipFile + minizip/md4 oracle, same generated ZIP.
    expect(archive.checksum).toBe(1558619990);
    expect(archive.pureChecksum(0x12345678)).toBe(3963017815);
    expect(withoutDirectoryPayload.checksum).toBe(2935006387);
    expect(withoutDirectoryPayload.pureChecksum(0x12345678)).toBe(119839191);
  });

  test("retains byte-valued and overlength directory records outside normalized read entries", async () => {
    using archive = await archiveFrom(sourceZip([
      { ...entry(new TextEncoder().encode("CAFÉ/"), true), data: new Uint8Array() },
      { ...entry(new TextEncoder().encode("A".repeat(255) + "\\")), data: new Uint8Array() },
    ]));
    expect(archive.sourceNames).toEqual([
      { kind: "supported", rawName: "CAF\xc3\x89/", name: "caf\xc3\x89/" },
      { kind: "unsupported", rawName: "A".repeat(255) + "\\", reason: "name-too-long" },
    ]);
    expect(archive.entries).toEqual([]);
    expect(archive.list()).toEqual([]);
    expect(archive.checksum).toBe(0xc6f640b7);
  });

  test("still rejects unsafe names but accepts invalid flagged UTF-8 as source bytes", async () => {
    for (const name of ["", "../escape", "../", "/absolute", "C:/drive", "a//b", "a\0b", "../bad/"]) {
      await expect(archiveFrom(sourceZip([entry(new TextEncoder().encode(name))]))).rejects.toThrow(Pk3Error);
    }
    using archive = await archiveFrom(sourceZip([entry(new Uint8Array([0xc3, 0x28]), true)]));
    expect(archive.sourceNames).toEqual([{ kind: "supported", rawName: "\xc3(", name: "\xc3(" }]);
    expect(Array.from(archive.readSync("\xc3("))).toEqual([1, 3, 5]);
  });

  test("metadata publication does not bypass deferred local-name and payload CRC validation", async () => {
    const corrupt = sourceZip([entry(new TextEncoder().encode("safe.txt"))]);
    corrupt[30] = 88;
    using archive = await archiveFrom(corrupt);
    expect(archive.sourceNames).toEqual([{ kind: "supported", rawName: "safe.txt", name: "safe.txt" }]);
    await expect(archive.read("safe.txt")).rejects.toThrow("local entry name disagrees");
    expect(() => archive.readSync("safe.txt")).toThrow("local entry name disagrees");
    const corruptPayload = sourceZip([{ ...entry(new TextEncoder().encode("stored.txt")), method: 0 }]);
    corruptPayload[40] = 99;
    using crcArchive = await archiveFrom(corruptPayload);
    expect(crcArchive.sourceNames).toEqual([{ kind: "supported", rawName: "stored.txt", name: "stored.txt" }]);
    await expect(crcArchive.read("stored.txt")).rejects.toThrow("CRC32");
    expect(() => crcArchive.readSync("stored.txt")).toThrow("CRC32");
  });
});
