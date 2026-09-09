import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { FileHandleExhaustionError } from "../src/assets/file-handles.ts";
import { ServerPakSet } from "../src/assets/pak-references.ts";
import type { PakCatalogEntry } from "../src/assets/pak-references.ts";
import { CommonError } from "../src/core/common-error.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { sourceZip } from "./pk3-source-fixture.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";

const cleanup: (() => void)[] = [];
const encoder = new TextEncoder(), decoder = new TextDecoder();
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function write(path: string, data: string | Uint8Array): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, data);
}

function pak(root: string, game: string, basename: string, entries: readonly (readonly [string, string])[]): void {
  write(join(root, game, `${basename}.pk3`), sourceZip(entries.map(([name, data]) => ({
    name: encoder.encode(name), data: encoder.encode(data), method: 0, utf8: false,
  }))));
}

async function fixture(commonOwned = false, startupText = "") {
  const directory = mkdtempSync(join(tmpdir(), "quake3-pure-files-"));
  cleanup.push(() => { rmSync(directory, { recursive: true, force: true }); });
  const home = join(directory, "home"), base = join(directory, "base");
  write(join(base, "baseq3", "default.cfg"), "set fixture 1\n");
  for (const extension of ["cfg", "menu", "game", "dm_68", "dat", "wav", "dm_67", "arena"]) {
    write(join(home, "baseq3", `loose.${extension}`), extension);
  }
  pak(base, "baseq3", "pak-a", [["shared.txt", "a"], ["a-only.txt", "A"], ["vm/cgame.qvm", "A cgame"]]);
  pak(home, "baseq3", "pak-b", [["shared.txt", "b"], ["b-only.txt", "B"], ["vm/cgame.qvm", "B cgame"]]);
  pak(home, "baseq3", "pak-c", [["shared.txt", "c"], ["c-only.txt", "C"]]);
  const roots = { dataPath: base, homePath: home, cdPath: null, product: "baseq3" } satisfies ConstructorParameters<typeof CommonFileState>[0];
  if (commonOwned) {
    write(join(base, "baseq3", "productid.txt"), SOURCE_PRODUCT_ID);
    const common = await CommonConsole.open({ roots, startup: new StartupCommands(startupText), random: new LinuxNativeRandom(1),
      build: { kind: "dedicated" }, platformPrint: () => {}, resolveCommand: () => undefined,
      assertCommandEntry: () => {}, assertOwnerEntry: () => {} }, () => {});
    cleanup.push(() => { common.close(); });
    return { directory, home, base, files: common.files, cvars: common.cvars, common };
  }
  const cvars = new CvarRegistry(), sound = new SoundOutput();
  const files = new CommonFileState(roots, () => {}, sound, cvars);
  cleanup.push(() => { try { files.close(); } finally { sound.close(); } });
  await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
  return { directory, home, base, files, cvars, common: null };
}

function named(files: CommonFileState, basename: string): PakCatalogEntry {
  const pack = files.current.pakReferences.snapshot().find(record => record.pack.basename === basename)?.pack;
  if (pack === undefined) throw new Error(`Missing actual fixture pak ${basename}`);
  return pack;
}

function listed(files: CommonFileState, extension: string): readonly string[] {
  const destination = new Uint8Array(1024);
  const count = files.current.getFileList("", extension, destination);
  return decoder.decode(destination).split("\0").slice(0, count);
}

test("server pak strings preserve source tokenization, signed atoi, missing names and the command token cap", () => {
  const set = new ServerPakSet();
  set.setChecksums('"-1" +12suffix garbage /* comment */ 2147483648 4\0 99');
  set.setNames('"mod/name with space" first // trailing names');
  expect(set.snapshot()).toEqual([
    { checksum: -1, name: "mod/name with space" }, { checksum: 12, name: "first" },
    { checksum: 0, name: null }, { checksum: 2147483647, name: null }, { checksum: 4, name: null },
  ]);
  set.setChecksums("1 2"); set.setNames("mod/one mod/two extra/name");
  expect(set.snapshot()).toEqual([{ checksum: 1, name: "mod/one" }, { checksum: 2, name: "mod/two" }]);
  set.setChecksums("3 4 5"); set.setNames("");
  expect(set.snapshot()).toEqual([{ checksum: 3, name: null }, { checksum: 4, name: null }, { checksum: 5, name: null }]);
  set.setChecksums("1 ".repeat(4100));
  expect(set.checksums).toHaveLength(1024);
});

test("loaded sets restrict actual opens and packed lists immediately, while source null-handle existence ignores purity", async () => {
  const f = await fixture(), before = f.files.current, a = named(f.files, "pak-a");
  expect(decoder.decode(before.readSync("shared.txt"))).toBe("c");
  await f.files.setServerLoadedPaks(String(a.checksum | 0), "pak-a", () => {});
  expect(f.files.current).toBe(before);
  expect(decoder.decode(before.readSync("shared.txt"))).toBe("a");
  expect(before.has("c-only.txt")).toBe(true);
  expect(before.fileLength("c-only.txt")).toBe(-1);
  expect(before.openUniqueRead("b-only.txt")).toBeUndefined();
  expect(before.pakPureChecksum("vm/cgame.qvm")).toBe(a.pureChecksum);
  expect(listed(f.files, ".txt")).toEqual(["shared.txt", "a-only.txt"]);
  expect(before.list()).toEqual(["a-only.txt", "shared.txt", "vm/cgame.qvm"]);
  for (const extension of ["cfg", "menu", "game", "dm_68", "dat"]) {
    expect(decoder.decode(before.readSync(`loose.${extension}`))).toBe(extension);
    expect(listed(f.files, `.${extension}`)).toEqual([]);
  }
  for (const extension of ["wav", "dm_67", "arena"]) {
    expect(before.has(`loose.${extension}`)).toBe(true);
    expect(before.fileLength(`loose.${extension}`)).toBe(-1);
  }
  await f.files.setServerLoadedPaks("", "", () => {});
  expect(f.files.current).toBe(before);
  expect(decoder.decode(before.readSync("shared.txt"))).toBe("c");
  expect(decoder.decode(before.readSync("loose.wav"))).toBe("wav");
});

test("real conditional restart applies source server order, retains both server sets and restores normal order on clear", async () => {
  const f = await fixture(), a = named(f.files, "pak-a"), b = named(f.files, "pak-b");
  const sums = `${a.checksum | 0} ${b.checksum | 0}`;
  f.files.setServerReferencedPaks(`${b.checksum | 0} ${a.checksum | 0} -1`, "baseq3/pak-b baseq3/pak-a mod/missing");
  const referenced = f.files.serverReferencedPaks;
  await f.files.setServerLoadedPaks(sums, "pak-a pak-b", () => {});
  expect(decoder.decode(f.files.current.readSync("shared.txt"))).toBe("b");
  const before = f.files.current;
  expect(await f.files.conditionalRestart(0, () => {})).toBe(false);
  expect(f.files.current).toBe(before);
  expect(await f.files.conditionalRestart(73, () => {})).toBe(true);
  expect(f.files.current.pakReferences.snapshot().map(record => record.pack.basename)).toEqual(["pak-a", "pak-b", "pak-c"]);
  expect(decoder.decode(f.files.current.readSync("shared.txt"))).toBe("a");
  expect(f.files.current.pakReferences.checksumFeed).toBe(73);
  expect(f.files.serverReferencedPaks).toEqual(referenced);
  expect(f.files.serverLoadedPaks).toEqual([{ checksum: a.checksum | 0, name: "pak-a" }, { checksum: b.checksum | 0, name: "pak-b" }]);
  const unique = f.files.current.openUniqueRead("a-only.txt");
  if (unique === undefined) throw new Error("Missing unique read");
  await f.files.setServerLoadedPaks("", "", () => {});
  expect(f.files.current.pakReferences.snapshot().map(record => record.pack.basename)).toEqual(["pak-c", "pak-b", "pak-a"]);
  expect(decoder.decode(f.files.current.readSync("shared.txt"))).toBe("c");
  expect(f.files.current.pakReferences.checksumFeed).toBe(73);
  expect(f.files.serverReferencedPaks).toEqual(referenced);
  const byte = new Uint8Array(1);
  expect(f.files.current.readInto(unique.file, byte)).toBe(1); expect(decoder.decode(byte)).toBe("A");
  f.files.current.closeFile(unique.file);
  const normal = f.files.current;
  await f.files.setServerLoadedPaks("", "", () => {});
  expect(f.files.current).not.toBe(normal); // FS_ReorderPurePaks returns before clearing fs_reordered for an empty set.
});

test("matching already-first and duplicate-checksum paks count as reordered while an unmatched list does not", async () => {
  const f = await fixture(), c = named(f.files, "pak-c");
  await f.files.setServerLoadedPaks(String(c.checksum | 0), "pak-c", () => {});
  await f.files.conditionalRestart(1, () => {});
  const matched = f.files.current;
  await f.files.setServerLoadedPaks("", "", () => {});
  expect(f.files.current).not.toBe(matched);
  await f.files.setServerLoadedPaks("123456789", "missing", () => {});
  await f.files.conditionalRestart(2, () => {});
  const unmatched = f.files.current;
  await f.files.setServerLoadedPaks("", "", () => {});
  expect(f.files.current).toBe(unmatched);
  write(join(f.home, "baseq3", "pak-c-copy.pk3"), new Uint8Array(readFileSync(c.archivePath)));
  await f.files.setServerLoadedPaks(`${c.checksum | 0} ${c.checksum | 0}`, "copy original", () => {});
  await f.files.conditionalRestart(3, () => {});
  expect(f.files.current.pakReferences.snapshot().map(record => record.pack.basename)).toEqual(["pak-c", "pak-c-copy", "pak-b", "pak-a"]);
});

test("fs_game and fs_basegame own real mod search and writable roots while the compiled Product stays unchanged", async () => {
  const f = await fixture();
  pak(f.base, "foundation", "core", [["parent.txt", "parent"], ["shared.txt", "parent"]]);
  pak(f.home, "custom", "mod", [["shared.txt", "custom"]]);
  const priorWriter = f.files.writable.openWrite("old.log", false);
  if (priorWriter === null) throw new Error("Missing prior writer");
  priorWriter.write("before");
  f.cvars.set("fs_basegame", "foundation", true); f.cvars.set("fs_game", "custom", true);
  expect(await f.files.conditionalRestart(0, () => {})).toBe(true);
  expect(f.cvars.get("fs_game")?.modified).toBe(false);
  expect(f.files.roots.product).toBe("baseq3");
  expect(decoder.decode(f.files.current.readSync("shared.txt"))).toBe("custom");
  expect(decoder.decode(f.files.current.readSync("parent.txt"))).toBe("parent");
  expect(f.files.current.pakReferences.referencedPakNames()).toContain("custom/mod");
  expect(f.files.writable.rootPath).toBe(join(f.home, "custom"));
  const writer = f.files.writable.openWrite("new.log", false);
  if (writer === null) throw new Error("Missing mod writer");
  writer.write("mod"); writer.close(); priorWriter.write("after"); priorWriter.close();
  expect(readFileSync(join(f.home, "custom", "new.log"), "utf8")).toBe("mod");
  expect(readFileSync(join(f.home, "baseq3", "old.log"), "utf8")).toBe("beforeafter");
  f.cvars.set("fs_game", "FOUNDATION", true); await f.files.conditionalRestart(0, () => {});
  expect(f.files.writable.rootPath).toBe(join(f.home, "foundation"));
  expect(f.files.current.pakReferences.snapshot().filter(row => row.pack.basename === "core")).toHaveLength(1);
  symlinkSync(join(f.home, "custom"), join(f.home, "linked"));
  f.cvars.set("fs_game", "linked", true); await f.files.conditionalRestart(0, () => {});
  expect(f.files.current.pakReferences.snapshot().some(row => row.pack.game === "linked")).toBe(false);
  expect(() => f.files.writable.openWrite("escaped.log", false)).toThrow("symbolic link");
  pak(f.home, "BASEQ3custom", "extra", [["only.txt", "prefix-name"]]);
  f.cvars.set("fs_basegame", "", true); f.cvars.set("fs_game", "BASEQ3custom", true);
  await f.files.conditionalRestart(0, () => {});
  expect(f.files.current.pakReferences.referencedPakChecksums()).toBe("");
  expect(f.files.current.pakReferences.referencedPakNames()).toBe("");
});

test("the actual common owner queues changed-game config and honors safe mode for mounted mods", async () => {
  for (const safe of [false, true]) {
    const f = await fixture(true, safe ? "+safe" : "");
    const common = f.common;
    if (common === null) throw new Error("Expected actual common owner");
    write(join(f.home, "custom", "q3config.cfg"), "set from_mod 1\n");
    f.cvars.set("fs_game", "custom", true);
    expect(() => common.assertCapabilities()).not.toThrow();
    expect(await f.files.conditionalRestart(12, () => {})).toBe(true);
    expect(() => common.validateGameDirectory()).not.toThrow();
    expect(common.files.writable.rootPath).toBe(join(f.home, "custom"));
    expect(f.cvars.get("from_mod")).toBeUndefined();
    await common.commands.executeAsync();
    expect(f.cvars.get("from_mod")?.value).toBe(safe ? undefined : "1");
    expect(await f.files.conditionalRestart(12, () => {})).toBe(false);
  }
});

test("common restart clears an incompatible pure set, restores mounts and then reports the source drop", async () => {
  const f = await fixture(true);
  rmSync(join(f.base, "baseq3", "default.cfg"));
  pak(f.base, "baseq3", "defaults", [["default.cfg", "set default_restored 1\n"]]);
  await f.files.conditionalRestart(1, () => {});
  await f.files.setServerLoadedPaks("123456789", "missing", () => {});
  let failure: unknown = null;
  try { await f.files.conditionalRestart(2, () => {}); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(CommonError);
  if (!(failure instanceof CommonError)) throw new Error("Expected source common error");
  expect(failure.code).toBe("drop"); expect(failure.message).toBe("Invalid game folder\n");
  expect(f.files.serverLoadedPaks).toEqual([]);
  expect(decoder.decode(f.files.current.readSync("default.cfg"))).toBe("set default_restored 1\n");
  expect(f.cvars.get("fs_gamedirvar")?.value).toBe("");
  expect(f.cvars.get("fs_restrict")?.value).toBe("0");
});

test("download writes use the actual common handle table and no-replace finalization preserves existing files", async () => {
  const f = await fixture(), file = f.files.server.openWriteExclusive("baseq3/download.pk3.tmp");
  if (file === null) throw new Error("Missing exclusive writer");
  expect(file.writeBytes(new Uint8Array([1, 2, 3]))).toBe(3);
  expect(file.tell()).toBe(3);
  expect(f.files.server.openWriteExclusive("baseq3/download.pk3.tmp")).toBeNull();
  expect(new Uint8Array(readFileSync(join(f.home, "baseq3", "download.pk3.tmp")))).toEqual(new Uint8Array([1, 2, 3]));
  expect(f.files.server.exists("baseq3/download.pk3.tmp")).toBe(true);
  expect(f.files.server.exists("baseq3/default.cfg")).toBe(false);
  await f.files.conditionalRestart(1, () => {});
  expect(file.writeBytes(new Uint8Array([4]))).toBe(1); file.close();
  write(join(f.home, "baseq3", "download.pk3"), "existing");
  expect(() => f.files.server.renameNoReplace("baseq3/download.pk3.tmp", "baseq3/download.pk3")).toThrow();
  expect(readFileSync(join(f.home, "baseq3", "download.pk3"), "utf8")).toBe("existing");
  expect(f.files.server.exists("baseq3/download.pk3.tmp")).toBe(true);
  f.files.server.renameNoReplace("baseq3/download.pk3.tmp", "baseq3/download.checksum.pk3");
  expect(f.files.server.exists("baseq3/download.pk3.tmp")).toBe(false);
  expect(new Uint8Array(readFileSync(join(f.home, "baseq3", "download.checksum.pk3")))).toEqual(new Uint8Array([1, 2, 3, 4]));
  const retained = Array.from({ length: 63 }, () => {
    const opened = f.files.current.openUniqueRead("default.cfg");
    if (opened === undefined) throw new Error("Missing retained handle fixture");
    return opened;
  });
  expect(() => f.files.server.openWriteExclusive("new/deeper/file.tmp")).toThrow(FileHandleExhaustionError);
  expect(f.files.server.exists("new/deeper/file.tmp")).toBe(false);
  for (const opened of retained) f.files.current.closeFile(opened.file);
});

test("download finalization refuses symlink ancestors, symlink sources and traversal before moving data", async () => {
  const f = await fixture();
  write(join(f.directory, "outside", "original"), "preserved");
  write(join(f.home, "baseq3", "download.tmp"), "download");
  symlinkSync(join(f.directory, "outside"), join(f.home, "linked"));
  symlinkSync(join(f.directory, "outside", "original"), join(f.home, "baseq3", "source-link.tmp"));
  expect(() => f.files.server.openWriteExclusive("linked/new.tmp")).toThrow("symbolic link");
  expect(() => f.files.server.renameNoReplace("baseq3/download.tmp", "linked/payload.pk3")).toThrow();
  expect(() => f.files.server.renameNoReplace("baseq3/source-link.tmp", "baseq3/source.pk3")).toThrow("symbolic link");
  expect(() => f.files.server.renameNoReplace("../outside/original", "baseq3/escaped.pk3")).toThrow(RangeError);
  expect(() => f.files.server.renameNoReplace("baseq3/download.tmp", "../outside/original")).toThrow(RangeError);
  expect(f.files.server.exists("baseq3/download.tmp")).toBe(true);
  expect(f.files.server.exists("baseq3/source.pk3")).toBe(false);
  expect(readFileSync(join(f.directory, "outside", "original"), "utf8")).toBe("preserved");
});

test("restart clears packed references but retains the common loose fake checksum", async () => {
  const f = await fixture();
  await f.files.restart({ checksumFeed: 3, random: () => 1 }, () => {});
  f.files.current.readSync("loose.wav");
  f.files.current.readSync("vm/cgame.qvm");
  expect(f.files.current.pakReferences.snapshot().some(row => row.flags !== 0)).toBe(true);
  await f.files.conditionalRestart(4, () => {});
  expect(f.files.current.pakReferences.snapshot().every(row => row.flags === 0)).toBe(true);
  expect(f.files.current.pakReferences.referencedPakPureChecksums()).toBe("1 1 @ 1 4");
});

test("a common restart without a surviving default reports fatal after its attempted restoration", async () => {
  const f = await fixture(true);
  rmSync(join(f.base, "baseq3", "default.cfg"));
  let failure: unknown = null;
  try { await f.files.conditionalRestart(5, () => {}); } catch (error) { failure = error; }
  if (!(failure instanceof CommonError)) throw new Error("Expected actual common error");
  expect(failure.code).toBe("fatal"); expect(failure.message).toBe("Couldn't load default.cfg");
  expect(f.files.current.pakReferences.checksumFeed).toBe(5);
  expect(f.files.current.fileLength("default.cfg")).toBe(-1);
  expect(f.cvars.get("fs_gamedirvar")?.value).toBe("");
});
