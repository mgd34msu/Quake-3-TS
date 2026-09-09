import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pk3Archive } from "../src/assets/pk3.ts";
import { sourceZip } from "./pk3-source-fixture.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

for (const method of [0, 8] satisfies readonly (0 | 8)[]) {
  test(`prepended ZIP bytes preserve method ${method} reads and retained rewind`, async () => {
    const data = new TextEncoder().encode("prefix-independent archive contents");
    const zip = sourceZip([{ name: new TextEncoder().encode("entry.cfg"), data, method, utf8: false }]);
    const prefix = new Uint8Array(73).fill(0x5a);
    const bytes = new Uint8Array(prefix.length + zip.length);
    bytes.set(prefix);
    bytes.set(zip, prefix.length);
    const directory = await mkdtemp(join(tmpdir(), "quake3-pk3-prefix-"));
    directories.push(directory);
    const plainPath = join(directory, "plain.pk3"), prefixedPath = join(directory, "prefixed.pk3");
    await writeFile(plainPath, zip);
    await writeFile(prefixedPath, bytes);
    using plain = await Pk3Archive.open(plainPath);
    using archive = await Pk3Archive.open(prefixedPath);
    expect(archive.entries).toEqual(plain.entries);
    expect(archive.checksum).toBe(plain.checksum);
    expect(archive.pureChecksum(123)).toBe(plain.pureChecksum(123));
    expect(await archive.read("entry.cfg")).toEqual(data);
    expect(archive.readSync("entry.cfg")).toEqual(data);
    for (const ownership of ["shared", "independent"]) {
      const reader = ownership === "shared" ? archive.openSharedRead("entry.cfg") : archive.openRead("entry.cfg");
      try {
        const first = new Uint8Array(7);
        expect(reader.readInto(first)).toBe(first.length);
        expect(first).toEqual(data.subarray(0, first.length));
        expect(reader.rewind()).toBe(0);
        const whole = new Uint8Array(data.length);
        expect(reader.readInto(whole)).toBe(data.length);
        expect(whole).toEqual(data);
        expect(reader.readInto(first)).toBe(0);
      } finally { reader.close(); }
    }
  });
}
