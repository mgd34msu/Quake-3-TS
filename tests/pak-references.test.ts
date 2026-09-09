import { describe, expect, test } from "bun:test";
import {
  PakReferenceFlag,
  PakReferences,
  isPakPure,
  reorderPurePaks,
} from "../src/assets/pak-references.ts";
import type { PakCatalogEntry, PureSearchPath } from "../src/assets/pak-references.ts";

function pack(
  game: "baseq3" | "missionpack",
  basename: string,
  checksum: number,
  pureChecksum: number,
): PakCatalogEntry {
  return Object.freeze({
    game,
    basename,
    archivePath: `/${game}/${basename}.pk3`,
    checksum,
    pureChecksum,
  });
}

function fnv1a(text: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash;
}

describe("Quake pak references", () => {
  test("reports every loaded pack in source order with signed checksum formatting", () => {
    const packs = [
      pack("missionpack", "pak9", 0xffff_ffff, 0x8000_0000),
      pack("baseq3", "pak1", 7, 8),
      pack("baseq3", "pak0", 7, 9),
    ];
    const references = new PakReferences({ packs, checksumFeed: 0x1234_5678, random: () => 0 });

    expect(references.loadedPakChecksums()).toBe("-1 7 7 ");
    expect(references.loadedPakNames()).toBe("pak9 pak1 pak0");
    expect(references.loadedPakPureChecksums()).toBe("-2147483648 8 9 ");
    expect(references.snapshot().map(record => record.pack)).toEqual(packs);
  });

  test("marks raw-case source flags and emits first cgame, first ui, then all general references", () => {
    const mission = pack("missionpack", "mp", 10, 110);
    const skipped = pack("baseq3", "skip", 20, 120);
    const cgame = pack("baseq3", "cgame", 30, 130);
    const laterCgame = pack("baseq3", "later-cgame", 40, 140);
    const ui = pack("baseq3", "ui", 50, 150);
    const general = pack("baseq3", "general", 60, 160);
    const references = new PakReferences({
      packs: [mission, skipped, cgame, laterCgame, ui, general],
      checksumFeed: 0x1020_3040,
      random: () => 0,
    });

    references.recordPackedOpen(cgame, "VM/CGAME.QVM");
    references.recordPackedOpen(cgame, "vm/cgame.qvm");
    references.recordPackedOpen(laterCgame, "vm/cgame.qvm");
    references.recordPackedOpen(ui, "vm/ui.qvm");
    references.recordPackedOpen(general, "LEVELSHOTS/map.tga");
    references.recordPackedOpen(skipped, "levelshots/map.tga");
    references.recordPackedOpen(skipped, "scripts/ONLY.SHADER");

    expect(references.snapshot().map(record => record.flags)).toEqual([
      0,
      0,
      PakReferenceFlag.General | PakReferenceFlag.Cgame,
      PakReferenceFlag.General | PakReferenceFlag.Cgame,
      PakReferenceFlag.General | PakReferenceFlag.Ui,
      PakReferenceFlag.General,
    ]);
    expect(references.referencedPakChecksums()).toBe("10 30 40 50 60 ");
    expect(references.referencedPakNames()).toBe(
      "missionpack/mp  baseq3/cgame baseq3/later-cgame baseq3/ui baseq3/general",
    );
    const aggregate = (0x1020_3040 ^ 130 ^ 140 ^ 150 ^ 160 ^ 4) | 0;
    expect(references.referencedPakPureChecksums()).toBe(`130 150 @ 130 140 150 160 ${aggregate}`);
  });

  test("tracks qagame separately, clears selected bits, and treats zero clear flags as all", () => {
    const first = pack("baseq3", "first", 1, 11);
    const last = pack("baseq3", "last", 2, 22);
    const references = new PakReferences({ packs: [first, last], checksumFeed: 0, random: () => 0 });
    references.recordPackedOpen(first, "vm/qagame.qvm");
    references.recordPackedOpen(last, "maps/test.bsp");
    references.recordPackedOpen(last, "vm/qagame.qvm");
    expect(references.gamePureChecksum()).toBe("2");

    references.clear(PakReferenceFlag.General | PakReferenceFlag.Qagame);
    expect(references.snapshot().map(record => record.flags)).toEqual([0, 0]);
    references.recordPackedOpen(first, "vm/ui.qvm");
    expect(() => references.clear(0x1_0000_0000)).toThrow(RangeError);
    references.clear(0);
    expect(references.snapshot().map(record => record.flags)).toEqual([0, 0]);
  });

  test("uses the required source random float for loose non-pure opens and serializes nonzero fake values three times", () => {
    const calls: number[] = [];
    const values = [0.75, 1];
    const references = new PakReferences({
      packs: [],
      checksumFeed: 99,
      random: () => {
        calls.push(calls.length);
        const value = values[calls.length - 1];
        if (value === undefined) throw new Error("Unexpected random call");
        return value;
      },
    });

    references.recordLooseOpen("settings.CFG");
    references.recordLooseOpen("sound/first.wav");
    expect(references.referencedPakPureChecksums()).toBe("@ 99");
    references.recordLooseOpen("sound/second.wav");
    references.recordLooseOpen("settings.CFG");
    expect(calls).toHaveLength(2);
    expect(references.referencedPakPureChecksums()).toBe("1 1 @ 1 99");
    references.clear(0);
    expect(references.referencedPakPureChecksums()).toBe("1 1 @ 1 99");
    expect(() => new PakReferences({ packs: [], checksumFeed: 0, random: () => 2 }).recordLooseOpen("x.bin"))
      .toThrow(RangeError);
  });

  test("filters by checksum only and reproduces source full-search-path reordering", () => {
    const paths: readonly PureSearchPath<string>[] = [
      { kind: "directory", value: "mission-dir" },
      { kind: "pak", value: "pak-a", checksum: 11 },
      { kind: "directory", value: "base-dir" },
      { kind: "pak", value: "pak-b", checksum: 22 },
      { kind: "pak", value: "pak-c-duplicate", checksum: 11 },
    ];
    expect(isPakPure(0xffff_ffff, [-1])).toBe(true);
    expect(isPakPure(33, [])).toBe(true);
    expect(isPakPure(33, [11, 22])).toBe(false);
    expect(reorderPurePaks(paths, [22, 11, 11]).map(path => path.value)).toEqual([
      "pak-b",
      "pak-a",
      "pak-c-duplicate",
      "mission-dir",
      "base-dir",
    ]);
    expect(reorderPurePaks(paths, []).map(path => path.value)).toEqual(paths.map(path => path.value));
  });

  test("truncates every BIG_INFO_STRING report at the source 8191-character payload boundary", () => {
    const packs: PakCatalogEntry[] = [];
    for (let index = 0; index < 1_024; index++) {
      packs.push(pack("missionpack", `long-pack-${index.toString().padStart(4, "0")}`, -0x8000_0000, -0x8000_0000));
    }
    const references = new PakReferences({ packs, checksumFeed: 0x1234_5678, random: () => 0 });
    for (const entry of packs) references.recordPackedOpen(entry, "maps/fixture.bsp");
    const checksumToken = "-2147483648 ";
    const loadedNames = packs.map(entry => entry.basename).join(" ");
    const referencedNames = packs.map(entry => `${entry.game}/${entry.basename}`).join(" ");
    const finalChecksum = String((0x1234_5678 ^ 1_024) | 0);

    expect(references.loadedPakChecksums()).toBe(checksumToken.repeat(packs.length).slice(0, 8_191));
    expect(references.loadedPakPureChecksums()).toBe(checksumToken.repeat(packs.length).slice(0, 8_191));
    expect(references.referencedPakChecksums()).toBe(checksumToken.repeat(packs.length).slice(0, 8_191));
    expect(references.loadedPakNames()).toBe(loadedNames.slice(0, 8_191));
    expect(references.referencedPakNames()).toBe(referencedNames.slice(0, 8_191));
    expect(references.referencedPakPureChecksums()).toBe(
      (`@ ${checksumToken.repeat(packs.length)}${finalChecksum}`).slice(0, 8_191),
    );
    expect(references.loadedPakChecksums()).toHaveLength(8_191);
    expect(fnv1a(references.loadedPakChecksums())).toBe(0xc259_e9bc);
    expect(fnv1a(references.referencedPakPureChecksums())).toBe(0x99ea_ad38);
  });

  test("partially appends at 8190 characters and makes later appends no-ops at 8191", () => {
    const prefix = "x".repeat(8_189);
    const references = new PakReferences({
      packs: [
        pack("baseq3", prefix, 1, 1),
        pack("baseq3", "AB", 2, 2),
        pack("baseq3", "must-not-appear", 3, 3),
      ],
      checksumFeed: 0,
      random: () => 0,
    });

    expect(references.loadedPakNames()).toBe(`${prefix} A`);
    expect(references.loadedPakNames()).toHaveLength(8_191);
    expect(fnv1a(references.loadedPakNames())).toBe(0xecd5_4e9c);
  });
});
