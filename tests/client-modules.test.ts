import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PakReferenceFlag, ServerPakSet } from "../src/assets/pak-references.ts";
import { Pk3Archive } from "../src/assets/pk3.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { acquireClientModule, acquireGameModule } from "../src/engine/client-modules.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { BinaryError, BinaryWriter } from "../src/core/binary.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { QvmOpcode } from "../src/assets/qvm.ts";
import type { ClientModuleRole, EngineModuleRole } from "../src/engine/client-modules.ts";
import type { Product } from "../src/shared/definitions.ts";
import { QvmInterpreter } from "../src/vm/interpreter.ts";
import { VmRegistry } from "../src/vm/registry.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import type { HunkAccountingProfile } from "../src/render/hunk-accounting.ts";
import { sourceZip } from "./pk3-source-fixture.ts";

const retailData = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const baseAvailable = await Bun.file(join(retailData, "baseq3/pak8.pk3")).exists();
const missionpackAvailable = await Bun.file(join(retailData, "missionpack/pak0.pk3")).exists();
const temporaryDirectories: string[] = [];
const unaccounted: { readonly hunk: HunkAccountingProfile; readonly print: (text: string) => void } = {
  hunk: { kind: "unaccounted" }, print: () => undefined,
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "q3-client-modules-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "baseq3"));
  return root;
}

function purePaks(checksums: string): ServerPakSet {
  const paks = new ServerPakSet();
  paks.setChecksums(checksums);
  return paks;
}

function openRetail(product: Product, homePath = retailData, serverPaks = new ServerPakSet()) {
  return VirtualFileSystem.openTracked({
    dataPath: retailData, homePath, cdPath: null, product, serverPaks,
    references: { checksumFeed: 12_345, random: () => 0.5 },
  });
}

for (const initialProduct of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  test.skipIf(!baseAvailable || !missionpackAvailable)(`${initialProduct}: filesystem product switches before restart and acquires both retail UIs`, async () => {
    const cvars = new CvarRegistry();
    const files = new CommonFileState({ dataPath: retailData, homePath: temporaryRoot(), cdPath: null, product: initialProduct },
      () => undefined, new SoundOutput(), cvars);
    const registry = new VmRegistry();
    const otherProduct = initialProduct === "baseq3" ? "missionpack" : "baseq3";
    await files.initialize({ checksumFeed: 0, random: () => 0.5 }, () => {});
    try {
      const products: readonly Product[] = [initialProduct, otherProduct, initialProduct];
      for (const [index, product] of products.entries()) {
        const previous = files.current;
        cvars.set("fs_game", product === "missionpack" ? "missionpack" : "", true);
        expect(files.roots.product).toBe(product);
        expect(files.current).toBe(previous);
        const changed = await files.conditionalRestart(0, () => {});
        expect(changed).toBe(index !== 0);
        if (changed) expect(() => previous.readFileLength("vm/ui.qvm")).toThrow("retired");
        const selected = acquireClientModule({ ...unaccounted, files: files.current, product: files.roots.product, role: "ui", registry });
        expect(selected?.mode).toBe("retail-replacement");
        expect(selected?.product).toBe(product);
        expect(files.writable.rootPath).toBe(join(files.roots.homePath.sourceText, product));
        expect(cvars.get("fs_game")?.modified).toBe(false);
        selected?.registration.free();
      }
    } finally { files.close(); }
  });
}

test.skipIf(!baseAvailable || !missionpackAvailable)("filesystem product preserves the mounted Team Arena parent when fs_game names baseq3", async () => {
  const cvars = new CvarRegistry();
  const files = new CommonFileState({ dataPath: retailData, homePath: temporaryRoot(), cdPath: null, product: "baseq3",
    baseGameDirectory: "missionpack" }, () => undefined, new SoundOutput(), cvars);
  await files.initialize({ checksumFeed: 0, random: () => 0.5 }, () => {});
  try {
    for (const game of ["", "baseq3", "authored-mod"]) {
      cvars.set("fs_game", game, true);
      expect(files.roots.product).toBe("missionpack");
      await files.conditionalRestart(0, () => {});
      const selected = acquireClientModule({ ...unaccounted, files: files.current, product: files.roots.product,
        role: "ui", registry: new VmRegistry() });
      expect(selected?.mode).toBe("retail-replacement");
      expect(selected?.product).toBe("missionpack");
      selected?.registration.free();
    }
  } finally { files.close(); }
});

test("filesystem product retains custom mod defaults, compares source directory identity and rejects unsafe paths", () => {
  for (const initialProduct of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    const cvars = new CvarRegistry();
    const files = new CommonFileState({ dataPath: retailData, homePath: temporaryRoot(), cdPath: null, product: initialProduct,
      gameDirectory: "authored-mod" }, () => undefined, new SoundOutput(), cvars);
    try {
      expect(files.roots.product).toBe(initialProduct);
      cvars.set("fs_game", "another-mod", true);
      cvars.set("fs_basegame", "parent-mod", true);
      expect(files.roots.product).toBe(initialProduct);
      cvars.set("fs_basegame", "BaSeQ3", true);
      expect(files.roots.product).toBe("baseq3");
      cvars.set("fs_basegame", "MiSsIoNpAcK", true);
      expect(files.roots.product).toBe("missionpack");
      cvars.set("fs_game", "BaSeQ3", true);
      expect(files.roots.product).toBe("missionpack");
      cvars.set("fs_basegame", "baseq3", true);
      cvars.set("fs_game", "MiSsIoNpAcK", true);
      expect(files.roots.product).toBe("missionpack");
      for (const name of ["fs_game", "fs_basegame"]) {
        cvars.set(name, "../outside", true);
        expect(() => files.roots.product).toThrow("Unsafe game directory");
        cvars.set(name, "", true);
      }
    } finally { files.close(); }
  }
});

const recordedModules: readonly {
  readonly product: Product; readonly role: EngineModuleRole; readonly bytes: number;
  readonly checksum: number; readonly sha256: string;
}[] = [
  { product: "baseq3", role: "ui", bytes: 278_308, checksum: 977125798,
    sha256: "3a6fd12b889f5d35df20a09b51bf8eca46966d014be55ffad38ddc2ffb38c807" },
  { product: "baseq3", role: "cgame", bytes: 325_220, checksum: 977125798,
    sha256: "4ea18569bf56a282d26dc89eb9efcc5eedbe0b69c10182fc38446174c1e55b49" },
  { product: "missionpack", role: "ui", bytes: 272_040, checksum: -1864624895,
    sha256: "7b157f32acdb21a3904d078296672ed2d32195c5b7a206922f6f7d33c6c40e40" },
  { product: "missionpack", role: "cgame", bytes: 442_304, checksum: -1864624895,
    sha256: "09d0b6eb41ea623d67031d2d7a73058ccb3bc6556ec044ead529d48b58d15f4c" },
  { product: "baseq3", role: "qagame", bytes: 469_796, checksum: 977125798,
    sha256: "57c52bf22e4f528c064f8af1553a7103723bab0a02276bb11eed944bf829b219" },
  { product: "missionpack", role: "qagame", bytes: 547_700, checksum: -1864624895,
    sha256: "da041f17f296feeaf8269eabc9062cefdecddfd24ff4d84eb291902e527d1d8a" },
];

for (const recorded of recordedModules) {
  const available = recorded.product === "baseq3" ? baseAvailable : missionpackAvailable;
  test.skipIf(!available)(`acquires installed ${recorded.product} ${recorded.role} through its pure package`, async () => {
    const files = await openRetail(recorded.product, retailData, purePaks(String(recorded.checksum)));
    const registry = new VmRegistry();
    const messages: string[] = [];
    const hunk = { kind: "source-hunk", accounting: new SourceHunkAccounting(new HunkArena(4096, () => undefined)) } satisfies HunkAccountingProfile;
    const print = (text: string): void => { messages.push(text); };
    const reader = spyOn(files, "readFileRetainedSync");
    const acquire = () => recorded.role === "qagame"
      ? acquireGameModule({ hunk, print, files, product: recorded.product, registry })
      : acquireClientModule({ hunk, print, files, product: recorded.product, role: recorded.role, registry });
    try {
      expect(files.pakReferences.referencedPakPureChecksums()).toBe("@ 12345");
      const selected = acquire();
      expect(reader).toHaveBeenCalledTimes(1);
      expect(reader).toHaveBeenCalledWith(`vm/${recorded.role}.qvm`);
      expect(selected?.mode).toBe("retail-replacement");
      if (selected?.mode !== "retail-replacement") throw new Error("Retail artifact must select TypeScript");
      expect(selected.product).toBe(recorded.product);
      expect(selected.role).toBe(recorded.role);
      expect(selected.referencePackage).toBe(recorded.product === "baseq3" ? "baseq3/pak8" : "missionpack/pak0");
      expect(selected.relatedGameBuildDate).toBe(recorded.product === "baseq3" ? "2002-09-30" : "2000-12-04");
      expect(selected.byteLength).toBe(recorded.bytes);
      expect(selected.sha256).toBe(recorded.sha256);
      expect(Object.isFrozen(selected)).toBe(true);
      const flag = recorded.role === "ui" ? PakReferenceFlag.Ui
        : recorded.role === "cgame" ? PakReferenceFlag.Cgame : PakReferenceFlag.Qagame;
      const references = () => files.pakReferences.snapshot().filter(row => (row.flags & flag) !== 0)
        .map(row => ({ checksum: row.pack.checksum | 0, flags: row.flags }));
      expect(references()).toEqual([{ checksum: recorded.checksum, flags: PakReferenceFlag.General | flag }]);
      selected.registration.bindTypeScript();
      files.pakReferences.clear();
      const reused = acquire();
      expect(reused?.mode).toBe("registered");
      expect(reused?.registration).toBe(selected.registration);
      expect(reader).toHaveBeenCalledTimes(1);
      expect(messages).toEqual([`Loading vm file vm/${recorded.role}.qvm.\n`]);
      expect(hunk.accounting.memoryRemaining()).toBe(4096);
      expect(references()).toEqual([]);
      selected.registration.free();
      acquire();
      expect(reader).toHaveBeenCalledTimes(2);
      expect(references()).toEqual([{ checksum: recorded.checksum, flags: PakReferenceFlag.General | flag }]);
    } finally { reader.mockRestore(); files.close(); }
  });
}

test("rejects missing module bytes without returning a replacement", async () => {
  const root = temporaryRoot();
  const files = await VirtualFileSystem.openTracked({ dataPath: root, homePath: root, cdPath: null, product: "baseq3",
    references: { checksumFeed: 1, random: () => 0.5 } });
  try {
    for (const role of ["ui", "cgame"] satisfies readonly ClientModuleRole[]) {
      expect(acquireClientModule({ ...unaccounted, files, product: "baseq3", role, registry: new VmRegistry() })).toBeNull();
    }
    expect(acquireGameModule({ ...unaccounted, files, product: "baseq3", registry: new VmRegistry() })).toBeNull();
    expect(files.pakReferences.snapshot()).toEqual([]);
  } finally { files.close(); }
});

test("missing VM diagnostics run before the read and before freeing the reserved slot", async () => {
  const root = temporaryRoot();
  const files = await VirtualFileSystem.openTracked({ dataPath: root, homePath: root, cdPath: null, product: "baseq3",
    references: { checksumFeed: 1, random: () => 0.5 } });
  const events: string[] = [], registry = new VmRegistry(), registration = registry.reserve("ui");
  const read = files.readFileRetainedSync.bind(files), free = registration.free.bind(registration);
  const reader = spyOn(files, "readFileRetainedSync").mockImplementation(path => { events.push(`read ${path}`); return read(path); });
  const freer = spyOn(registration, "free").mockImplementation(() => { events.push("free VM"); free(); });
  try {
    expect(acquireClientModule({ ...unaccounted, files, product: "baseq3", role: "ui", registry,
      print: text => { events.push(text); expect(registration.binding.kind).toBe("initializing"); } })).toBeNull();
    expect(events).toEqual(["Loading vm file vm/ui.qvm.\n", "read vm/ui.qvm", "Failed.\n", "free VM"]);
    expect(registration.binding.kind).toBe("freed");
  } finally { reader.mockRestore(); freer.mockRestore(); files.close(); }
});

for (const failure of ["loading-print", "read", "failed-print"]) {
test(`VM acquisition preserves reached effects when ${failure} throws`, async () => {
  const root = temporaryRoot();
  const files = await VirtualFileSystem.openTracked({ dataPath: root, homePath: root, cdPath: null, product: "baseq3",
    references: { checksumFeed: 1, random: () => 0.5 } });
  const registry = new VmRegistry(), registration = registry.reserve("ui"), events: string[] = [];
  const interrupted = new Error(failure);
  const reader = spyOn(files, "readFileRetainedSync").mockImplementation(() => {
    events.push("read");
    if (failure === "read") throw interrupted;
    return undefined;
  });
  try {
    expect(() => acquireClientModule({ ...unaccounted, files, product: "baseq3", role: "ui", registry,
      print: text => {
        events.push(text);
        if ((text.startsWith("Loading") && failure === "loading-print") || (text === "Failed.\n" && failure === "failed-print")) throw interrupted;
      } })).toThrow(interrupted);
    expect(registration.binding.kind).toBe("initializing");
    expect(events).toEqual(failure === "loading-print" ? ["Loading vm file vm/ui.qvm.\n"]
      : failure === "read" ? ["Loading vm file vm/ui.qvm.\n", "read"] : ["Loading vm file vm/ui.qvm.\n", "read", "Failed.\n"]);
    expect(acquireClientModule({ ...unaccounted, files, product: "baseq3", role: "ui", registry })?.mode).toBe("registered");
  } finally { reader.mockRestore(); files.close(); }
});
}

test.skipIf(!baseAvailable)("rejects a known module from the wrong product", async () => {
  const files = await openRetail("baseq3");
  try {
    expect(() => acquireClientModule({ ...unaccounted, files, product: "missionpack", role: "cgame", registry: new VmRegistry() }))
      .toThrow("recorded baseq3 cgame, requested missionpack cgame");
    expect(() => acquireGameModule({ ...unaccounted, files, product: "missionpack", registry: new VmRegistry() }))
      .toThrow("recorded baseq3 qagame, requested missionpack qagame");
  } finally { files.close(); }
});

test.skipIf(!baseAvailable)("rejects known retail bytes exchanged between client and game roles", async () => {
  const files = await openRetail("baseq3");
  const read = files.readFileRetainedSync.bind(files);
  const reader = spyOn(files, "readFileRetainedSync").mockImplementation(path =>
    read(path === "vm/qagame.qvm" ? "vm/ui.qvm" : path === "vm/ui.qvm" ? "vm/qagame.qvm" : path));
  try {
    expect(() => acquireGameModule({ ...unaccounted, files, product: "baseq3", registry: new VmRegistry() }))
      .toThrow("recorded baseq3 ui, requested baseq3 qagame");
    expect(() => acquireClientModule({ ...unaccounted, files, product: "baseq3", role: "ui", registry: new VmRegistry() }))
      .toThrow("recorded baseq3 qagame, requested baseq3 ui");
    expect(reader).toHaveBeenCalledTimes(2);
  } finally { reader.mockRestore(); files.close(); }
});

test.skipIf(!baseAvailable)("rejects known cgame bytes when the UI role requested them", async () => {
  const files = await openRetail("baseq3");
  const read = files.readFileRetainedSync.bind(files);
  // Route a real retail read in memory, without copying its bytes into a fixture.
  const reader = spyOn(files, "readFileRetainedSync").mockImplementation(path => read(path === "vm/ui.qvm" ? "vm/cgame.qvm" : path));
  try {
    expect(() => acquireClientModule({ ...unaccounted, files, product: "baseq3", role: "ui", registry: new VmRegistry() }))
      .toThrow("recorded baseq3 cgame, requested baseq3 ui");
    expect(reader).toHaveBeenCalledWith("vm/ui.qvm");
  } finally { reader.mockRestore(); files.close(); }
});

for (const role of ["cgame", "qagame"] satisfies readonly EngineModuleRole[]) {
test.skipIf(!baseAvailable)(`respects ${role} pure selection and rejects malformed bytecode without retail fallback`, async () => {
  const homePath = temporaryRoot();
  const unknownPath = join(homePath, "baseq3/z-modules.pk3");
  writeFileSync(unknownPath, sourceZip([{ name: new TextEncoder().encode(`vm/${role}.qvm`),
    data: new TextEncoder().encode("unknown module"), method: 0, utf8: false }]));
  using archive = await Pk3Archive.open(unknownPath);
  const acquire = (files: Awaited<ReturnType<typeof openRetail>>) => role === "qagame"
    ? acquireGameModule({ ...unaccounted, files, product: "baseq3", registry: new VmRegistry() })
    : acquireClientModule({ ...unaccounted, files, product: "baseq3", role, registry: new VmRegistry() });
  const flag = role === "qagame" ? PakReferenceFlag.Qagame : PakReferenceFlag.Cgame;
  const unfiltered = await openRetail("baseq3", homePath);
  try {
    expect(() => acquire(unfiltered)).toThrow(BinaryError);
    expect(unfiltered.pakReferences.snapshot().filter(row => (row.flags & flag) !== 0)
      .map(row => row.pack.archivePath)).toEqual([unknownPath]);
  } finally { unfiltered.close(); }
  const filtered = await openRetail("baseq3", homePath, purePaks("977125798"));
  try {
    const selected = acquire(filtered);
    expect(selected?.mode).toBe("retail-replacement");
    if (selected?.mode !== "retail-replacement") throw new Error("Pure retail artifact must select TypeScript");
    expect(selected.sha256).toBe(role === "qagame"
      ? "57c52bf22e4f528c064f8af1553a7103723bab0a02276bb11eed944bf829b219"
      : "4ea18569bf56a282d26dc89eb9efcc5eedbe0b69c10182fc38446174c1e55b49");
    expect(filtered.pakReferences.snapshot().find(row => row.pack.archivePath === unknownPath)?.flags).toBe(0);
  } finally { filtered.close(); }
  const modOnly = await openRetail("baseq3", homePath, purePaks(String(archive.checksum | 0)));
  try {
    expect(() => acquire(modOnly)).toThrow(BinaryError);
    expect(acquireClientModule({ ...unaccounted, files: modOnly, product: "baseq3", role: "ui", registry: new VmRegistry() }))
      .toBeNull();
  } finally { modOnly.close(); }
});
}

for (const role of ["ui", "cgame", "qagame"] satisfies readonly EngineModuleRole[]) {
test(`acquires authored external ${role} bytecode from the actual package without executing it`, async () => {
  const root = temporaryRoot(), code = new BinaryWriter(15);
  code.u8(QvmOpcode.OP_ENTER); code.i32(8);
  code.u8(QvmOpcode.OP_CONST); code.i32(6);
  code.u8(QvmOpcode.OP_LEAVE); code.i32(8);
  const bytes = code.finish(), image = new BinaryWriter(32 + bytes.length);
  for (const word of [0x12721444, 3, 32, bytes.length, 32 + bytes.length, 0, 0, 512]) image.i32(word);
  image.bytes(bytes);
  writeFileSync(join(root, "baseq3/authored-mod.pk3"), sourceZip([
    { name: new TextEncoder().encode(`vm/${role}.qvm`), data: image.finish(), method: 0, utf8: false },
    { name: new TextEncoder().encode(`vm/${role}.map`), data: new TextEncoder().encode("0 0 vmMain\n0 1 next\n"), method: 0, utf8: false },
  ]));
  const files = await VirtualFileSystem.openTracked({ dataPath: root, homePath: root, cdPath: null, product: "baseq3",
    references: { checksumFeed: 1, random: () => 0.5 } });
  const registry = new VmRegistry();
  const infoAtRead: string[] = [], fileOperations: string[] = [];
  const accounting = new SourceHunkAccounting(new HunkArena(4096, () => undefined));
  const hunk = { kind: "source-hunk", accounting } satisfies HunkAccountingProfile;
  const print = (text: string): void => { fileOperations.push(text); };
  const acquire = () => role === "qagame" ? acquireGameModule({ hunk, print, files, product: "baseq3", registry })
    : acquireClientModule({ hunk, print, files, product: "baseq3", role, registry });
  const remaining = accounting.memoryRemaining.bind(accounting);
  const sample = spyOn(accounting, "memoryRemaining").mockImplementation(() => {
    fileOperations.push("remaining"); return remaining();
  });
  const read = files.readFileRetainedSync.bind(files), free = files.freeFile.bind(files);
  const reader = spyOn(files, "readFileRetainedSync").mockImplementation(path => {
    fileOperations.push(`read ${path}`);
    if (path.endsWith(".qvm")) {
      registry.printInfo(text => { infoAtRead.push(text); });
      expect(acquire()?.mode).toBe("registered");
    }
    return read(path);
  });
  const freer = spyOn(files, "freeFile").mockImplementation(file => { fileOperations.push("free"); free(file); });
  try {
    const selected = acquire();
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith(`vm/${role}.qvm`);
    expect(selected?.mode).toBe("bytecode");
    if (selected?.mode !== "bytecode") throw new Error("Authored mod must select its bytecode");
    expect(selected.image.source).toBe(`vm/${role}.qvm`);
    expect(selected.image.instructions.length).toBe(3);
    expect(infoAtRead.join("")).toBe(`Registered virtual machines:\n${role} : interpreted\n`
      + "    code length :       0\n    table length:       0\n    data length :       1\n");
    const interpreter = new QvmInterpreter(selected.image, () => 0, hunk, selected.registration);
    selected.releaseImage();
    interpreter.loadSymbols({ name: role, developer: 0, files, print });
    expect(fileOperations).toEqual(["remaining", `Loading vm file vm/${role}.qvm.\n`, `read vm/${role}.qvm`, "remaining", "free"]);
    interpreter.loadSymbols({ name: role, developer: 1, files, print });
    selected.completeLoading();
    expect(fileOperations).toEqual(["remaining", `Loading vm file vm/${role}.qvm.\n`, `read vm/${role}.qvm`, "remaining", "free",
      `read vm/${role}.map`, `2 symbols parsed from vm/${role}.map\n`, "free", "remaining", `${role} loaded in 672 bytes on the hunk\n`]);
    expect(interpreter.symbols.entries.map(symbol => [symbol.value, symbol.name])).toEqual([[0, "vmMain"], [5, "next"]]);
    const existing = acquire();
    expect(existing?.mode).toBe("registered");
    expect(existing?.registration).toBe(selected.registration);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(fileOperations.at(-1)).toBe("remaining");
    expect(sample).toHaveBeenCalledTimes(4);
    const flag = role === "qagame" ? PakReferenceFlag.Qagame : role === "cgame" ? PakReferenceFlag.Cgame : PakReferenceFlag.Ui;
    expect(files.pakReferences.snapshot().some(row => (row.flags & flag) !== 0)).toBe(true);
  } finally { reader.mockRestore(); freer.mockRestore(); sample.mockRestore(); files.close(); }
});
}
