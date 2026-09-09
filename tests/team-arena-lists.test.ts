import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { TeamArenaLists } from "../src/ui/team-arena/lists.ts";
import { TeamArenaUiMemory } from "../src/ui/team-arena/memory.ts";
import { sourceZip } from "./pk3-source-fixture.ts";

async function fixture(names: readonly string[] | null = [], mods: readonly (readonly [string, string | null])[] = [], packed = true) {
  const root = mkdtempSync(join(tmpdir(), "quake3-team-lists-")), home = join(root, "home");
  mkdirSync(join(home, "missionpack"), { recursive: true });
  if (names !== null) {
    mkdirSync(join(root, "baseq3")); mkdirSync(join(root, "missionpack"));
    writeFileSync(join(root, "baseq3", "default.cfg"), "fixture\n");
    if (packed && names.length > 0) {
      writeFileSync(join(root, "missionpack", "pak0.pk3"), sourceZip(names.map(name => ({
        name: Uint8Array.from(name, byte => byte.charCodeAt(0)), data: new Uint8Array([1]), method: 8, utf8: false,
      }))));
    } else for (const name of names) {
      const path = join(root, "missionpack", name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "fixture\n");
    }
  }
  for (const [name, description] of mods) {
    mkdirSync(join(root, name));
    // FS_GetModList checks unmounted archive-name presence without opening the pack.
    writeFileSync(join(root, name, "presence.pk3"), "generated presence fixture");
    if (description !== null) writeFileSync(join(root, name, "description.txt"), description, "latin1");
  }
  const prints: string[] = [], cvars = new CvarRegistry(), sound = new SoundOutput();
  const print = (text: string): undefined => { prints.push(text); };
  const files = new CommonFileState({ dataPath: names === null ? process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a" : root,
    homePath: home, cdPath: null, product: "missionpack" }, print, sound, cvars);
  let active = true;
  const assertActive = (): void => { if (!active) throw new Error("retired list owner"); };
  try {
    await files.initialize({ checksumFeed: 0, random: () => 0 }, assertActive);
    cvars.register("protocol", "68");
    const memory = new TeamArenaUiMemory("qvm32", print), lists = new TeamArenaLists({ files, memory, cvars, assertActive });
    return { root, files, memory, cvars, lists, prints, retire: () => { active = false; },
      close: () => { files.close(); sound.close(); rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { files.close(); sound.close(); rmSync(root, { recursive: true, force: true }); throw error; }
}

test("Team Arena lists actual retail movies, demos and mod descriptions through common filesystem owners", async () => {
  const f = await fixture(null);
  try {
    const calls: string[] = [], get = f.files.current.getFileList.bind(f.files.current);
    f.files.current.getFileList = (path, extension, destination) => {
      calls.push(`${path}:${extension}:${destination.length}`); return get(path, extension, destination);
    };
    f.lists.loadMovies(); f.lists.loadDemos(); f.lists.loadMods();
    expect([f.lists.movieCount, f.lists.demoCount]).toEqual([44, 1]);
    expect(f.lists.movieList.slice(0, 3)).toEqual(["AMMO_REGEN", "CRUSADERS", "CTF"]);
    expect(f.lists.movieList[43]).toBe("TIER7");
    expect(f.lists.demoList[0]).toBe("FOUR");
    expect(f.lists.modList.slice(0, f.lists.modCount).some(row => row.modName === "missionpack")).toBe(true);
    expect(calls).toEqual(["video:roq:4096", "demos:dm_68:4096", "$modlist::2048"]);
  } finally { f.close(); }
});

test("movie and demo pointer arrays observe String_Init reuse without replacing their arrays", async () => {
  const f = await fixture(["video/one.roq", "demos/second.dm_68"]);
  try {
    f.lists.loadMovies(); f.lists.loadDemos();
    const movies = f.lists.movieList, demos = f.lists.demoList;
    expect([movies[0], demos[0]]).toEqual(["ONE", "SECOND"]);
    f.memory.initializeStrings();
    f.memory.stringAllocReference("ABCDEFGHIJ");
    expect(f.lists.movieList).toBe(movies);
    expect(f.lists.demoList).toBe(demos);
    expect([movies[0], demos[0]]).toEqual(["ABCDEFGHIJ", "EFGHIJ"]);
  } finally { f.close(); }
});

test("mod rows keep complete descriptor pairs, cap at 64 and retain old slots after an empty reload", async () => {
  const mods: (readonly [string, string | null])[] = [["LongDirectoryBeyond15", "D".repeat(60)], ["bare", null], ["lines", "One\nTwo\n"]];
  const f = await fixture([], mods);
  try {
    f.lists.loadMods();
    expect(f.lists.modCount).toBe(3);
    expect(f.lists.modList.find(row => row.modName === "LongDirectoryBeyond15")?.modDescr).toBe("D".repeat(48));
    expect(f.lists.modList.find(row => row.modName === "bare")?.modDescr).toBe("bare");
    expect(f.lists.modList.find(row => row.modName === "lines")?.modDescr).toBe("One\nTwo\n");
    const old = f.lists.modList.slice(0, 3).map(row => ({ modName: row.modName, modDescr: row.modDescr }));
    for (const [name] of mods) renameSync(join(f.root, name), join(f.root, `.retired-${name}`));
    f.lists.loadMods();
    expect(f.lists.modCount).toBe(0);
    expect(f.lists.modList.slice(0, 3).map(row => ({ modName: row.modName, modDescr: row.modDescr }))).toEqual(old);
    for (let index = 0; index < 65; index++) {
      mkdirSync(join(f.root, `m${index}`)); writeFileSync(join(f.root, `m${index}`, "presence.pk3"), "presence");
    }
    f.lists.loadMods();
    expect(f.lists.modCount).toBe(64);
    expect(new Set(f.lists.modList.map(row => row.modName)).size).toBe(64);
  } finally { f.close(); }
});

test("movie suffixes use source offsets and ASCII uppercase while preserving listing order", async () => {
  const f = await fixture(["video/Mixed.RoQ", "video/cafe.roq", "video/weirdroq", "video/roq", "video/ignore.txt"]);
  try {
    f.lists.loadMovies();
    expect(f.lists.movieCount).toBe(4);
    expect(f.lists.movieList.slice(0, 4)).toEqual(["MIXED", "CAFE", "WEIRDROQ", "ROQ"]);
  } finally { f.close(); }
  const first = await fixture(["video/roq", "video/normal.roq"]);
  try {
    expect(() => first.lists.loadMovies()).toThrow("source buffer at -1");
    expect(first.lists.movieCount).toBe(2);
    expect(first.lists.movieList[0]).toBeNull();
  } finally { first.close(); }
  const unsupported = await fixture(["video/caféß.roq"]);
  try {
    expect(() => unsupported.lists.loadMovies()).toThrow("non-ascii");
    expect(unsupported.lists.movieCount).toBe(0);
  } finally { unsupported.close(); }
});

test("demo protocol is sampled before and after actual listing, including empty results", async () => {
  const f = await fixture(["demos/Mixed.dm_68", "demos/dm_68", "demos/Other.dm_69"]);
  try {
    let reads = 0;
    const getCvar = f.cvars.get.bind(f.cvars), getList = f.files.current.getFileList.bind(f.files.current);
    f.cvars.get = name => { if (name === "protocol") reads++; return getCvar(name); };
    f.files.current.getFileList = (path, extension, bytes) => {
      const count = getList(path, extension, bytes); f.cvars.set("protocol", "69.9", true); return count;
    };
    f.lists.loadDemos();
    expect(reads).toBe(2);
    expect(f.lists.demoList.slice(0, f.lists.demoCount)).toEqual(["MIXED.DM_68", "DM_68"]);
    f.files.current.getFileList = getList; f.cvars.set("protocol", "68", true); reads = 0;
    f.lists.loadDemos();
    expect(reads).toBe(2);
    expect(f.lists.demoList.slice(0, 2)).toEqual(["MIXED", "DM_68"]);
    f.cvars.set("protocol", "67", true); reads = 0;
    f.lists.loadDemos(); expect(reads).toBe(2); expect(f.lists.demoCount).toBe(0);
    expect(f.lists.demoList[0]).toBe("MIXED");
  } finally { f.close(); }
});

test("fixed list caps and source byte-buffer truncation precede string allocation", async () => {
  const f = await fixture([...Array.from({ length: 300 }, (_, i) => `video/m${i}.roq`),
    ...Array.from({ length: 300 }, (_, i) => `demos/d${i}.dm_68`)]);
  try {
    const allocate = f.memory.stringAllocReference.bind(f.memory), counts: number[] = [];
    f.memory.stringAllocReference = text => { counts.push(f.lists.movieCount); return allocate(text); };
    f.lists.loadMovies(); expect(f.lists.movieCount).toBe(256); expect(counts[0]).toBe(256);
    expect(f.lists.movieList[255]).toBe("M255");
    let reads = 0, observed = 0;
    const get = f.cvars.get.bind(f.cvars);
    f.cvars.get = name => { if (name === "protocol" && ++reads === 2) observed = f.lists.demoCount; return get(name); };
    f.lists.loadDemos(); expect(observed).toBe(300); expect(f.lists.demoCount).toBe(256); expect(f.lists.demoList[255]).toBe("D255");
  } finally { f.close(); }
  const long = await fixture(Array.from({ length: 50 }, (_, i) => `video/${"x".repeat(120)}${i}.roq`));
  try { long.lists.loadMovies(); expect(long.lists.movieCount).toBe(32); }
  finally { long.close(); }
});

test("pool exhaustion and retirement retain source counts without publishing unallocated rows", async () => {
  const f = await fixture(["video/a.roq", "video/b.roq"]);
  try {
    f.memory.stringAlloc("x".repeat(384 * 1024 - 2));
    f.lists.loadMovies(); expect(f.lists.movieCount).toBe(2); expect(f.lists.movieList.slice(0, 2)).toEqual([null, null]);
    f.memory.initializeStrings(); f.memory.allocate(1024 * 1024);
    expect(() => f.lists.loadMovies()).toThrow("failed UI_Alloc"); expect(f.lists.movieCount).toBe(2);
  } finally { f.close(); }
  const retired = await fixture(["video/a.roq"]);
  try {
    const allocate = retired.memory.stringAllocReference.bind(retired.memory);
    retired.memory.stringAllocReference = text => { const result = allocate(text); retired.retire(); return result; };
    expect(() => retired.lists.loadMovies()).toThrow("retired list owner");
    expect(retired.lists.movieCount).toBe(1); expect(retired.lists.movieList[0]).toBeNull();
  } finally { retired.close(); }
});
