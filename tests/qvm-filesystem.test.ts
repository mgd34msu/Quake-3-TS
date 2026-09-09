import { afterEach, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SourceFileHandles } from "../src/assets/file-handles.ts";
import { Pk3Archive } from "../src/assets/pk3.ts";
import { PakReferenceFlag } from "../src/assets/pak-references.ts";
import { WritableFileSystem } from "../src/assets/writable-files.ts";
import { QvmOpcode as Op, parseQvm } from "../src/assets/qvm.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { CommonError } from "../src/core/common-error.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { qvmFilesystemSyscall } from "../src/vm/filesystem-syscalls.ts";
import { QvmInterpreter } from "../src/vm/interpreter.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { sourceZip } from "./pk3-source-fixture.ts";

type Role = "game" | "cgame" | "ui";
type Operation = readonly [Op, number?];
const encoder = new TextEncoder(), decoder = new TextDecoder();
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

class CountedSound extends SoundOutput {
  clears = 0;
  override clearSoundBuffer(): void { this.clears++; super.clearSoundBuffer(); }
}

function authoredPak(path: string): void {
  writeFileSync(path, sourceZip([
    { name: encoder.encode("packed.bin"), data: encoder.encode("ABCDEFGHIJ"), method: 8, utf8: false },
    { name: encoder.encode("list/from-pak.txt"), data: encoder.encode("P"), method: 0, utf8: false },
    { name: encoder.encode("vm/ui.qvm"), data: encoder.encode("authored marker, never executed"), method: 0, utf8: false },
  ]));
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quake3-qvm-filesystem-"));
  cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
  const data = join(root, "data"), home = join(root, "home");
  mkdirSync(join(data, "baseq3"), { recursive: true });
  mkdirSync(join(home, "baseq3", "list"), { recursive: true });
  writeFileSync(join(home, "baseq3", "read.bin"), "0123456789");
  writeFileSync(join(home, "baseq3", "empty.dat"), "");
  writeFileSync(join(home, "baseq3", "list", "loose.txt"), "L");
  authoredPak(join(data, "baseq3", "pak0.pk3"));
  const memory = new QvmMemory(new Uint8Array(1024)), cvars = new CvarRegistry(), sound = new CountedSound();
  const printed: { readonly text: string; readonly handle: number; readonly clears: number }[] = [];
  let randomCalls = 0;
  const files = new CommonFileState({ dataPath: data, homePath: home, cdPath: null, product: "baseq3" },
    text => { printed.push({ text, handle: memory.view(128, 4).getInt32(0, true), clears: sound.clears }); }, sound, cvars);
  cleanup.push(() => { try { files.close(); } finally { sound.close(); } });
  await files.initialize({ checksumFeed: 0, random: () => { randomCalls++; return 0.25; } }, () => {});
  const call = (role: Role, trap: number, ...args: number[]): number | null => {
    const words = new DataView(new ArrayBuffer((args.length + 1) * 4));
    words.setInt32(0, trap, true);
    for (const [index, word] of args.entries()) words.setInt32((index + 1) * 4, word, true);
    return qvmFilesystemSyscall(role, words, memory, files);
  };
  const open = (path: string, mode = 0): { readonly result: number | null; readonly slot: number } => {
    memory.writeString(16, path, 96);
    const result = call("game", 10, 16, 128, mode);
    return { result, slot: memory.view(128, 4).getInt32(0, true) };
  };
  return { root, data, home, files, memory, cvars, sound, printed, call, open, randomCalls: () => randomCalls };
}

function commonFailure(operation: () => unknown, code: "drop" | "fatal", message: string): void {
  try { operation(); throw new Error("Expected CommonError"); }
  catch (error) {
    if (!(error instanceof CommonError)) throw error;
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
  }
}

test("exact game, cgame and UI filesystem IDs open real shared files and preserve short-read bytes", async () => {
  const f = await fixture();
  const roles: readonly (readonly [Role, number, number, number | null])[] = [
    ["game", 10, 45, 38], ["cgame", 10, 89, null], ["ui", 13, 86, 17],
  ];
  for (const [role, open, seek, list] of roles) {
    f.memory.writeString(16, "read.bin", 32);
    expect(f.call(role, open, 16, 128, 0)).toBe(10);
    const slot = f.memory.view(128, 4).getInt32(0, true);
    expect(slot).toBe(1);
    f.memory.span(256, 16).fill(0x7e);
    expect(f.call(role, open + 1, 256, 16, slot)).toBe(0);
    expect(decoder.decode(f.memory.span(256, 16))).toBe("0123456789~~~~~~");
    expect(f.call(role, seek, slot, 2, 2)).toBe(0);
    expect(f.call(role, open + 1, 256, 2, slot)).toBe(0);
    expect(decoder.decode(f.memory.span(256, 2))).toBe("23");
    expect(f.call(role, open + 3, slot)).toBe(0);
    if (list !== null) {
      f.memory.writeString(16, "list", 16); f.memory.writeString(48, ".txt", 16);
      f.memory.span(256, 64).fill(0x7e);
      expect(f.call(role, list, 16, 48, 256, 64)).toBe(2);
      expect(decoder.decode(f.memory.span(256, 24))).toBe("loose.txt\0from-pak.txt\0~");
      expect(f.memory.bytes[320]).toBe(0);
    }
    expect(f.call(role, 99)).toBeNull();
  }
  expect(f.call("cgame", 38)).toBeNull();
  expect(f.call("ui", 87)).toBeNull();
});

test("all four open modes use the actual writable owner and source origin mapping", async () => {
  const f = await fixture();
  let opened = f.open("created.dat", 1);
  expect(opened).toEqual({ result: 0, slot: 1 });
  f.memory.span(256, 5).set(encoder.encode("abcde"));
  expect(f.call("game", 12, 256, 5, opened.slot)).toBe(0);
  expect(f.files.seekFile(opened.slot, -2, 0)).toBe(0);
  f.memory.span(256, 2).set(encoder.encode("XY"));
  expect(f.files.writeFile(opened.slot, f.memory.span(256, 2))).toBe(2);
  expect(f.call("game", 45, opened.slot, -1, 1)).toBe(0);
  f.memory.bytes[256] = 90;
  expect(f.call("game", 12, 256, 1, opened.slot)).toBe(0);
  expect(f.call("game", 13, opened.slot)).toBe(0);
  expect(readFileSync(join(f.home, "baseq3", "created.dat"), "utf8")).toBe("abcXZ");
  for (const mode of [2, 3]) {
    opened = f.open("created.dat", mode);
    expect(opened.result).toBe(0);
    expect(f.call("game", 45, opened.slot, 0, 2)).toBe(0);
    f.memory.bytes[256] = mode === 2 ? 33 : 63;
    expect(f.call("game", 12, 256, 1, opened.slot)).toBe(0);
    f.call("game", 13, opened.slot);
  }
  expect(readFileSync(join(f.home, "baseq3", "created.dat"), "utf8")).toBe("abcXZ!?");
  expect(f.sound.clears).toBe(2);
  opened = f.open("created.dat", 1);
  expect(readFileSync(join(f.home, "baseq3", "created.dat"))).toHaveLength(0);
  expect(f.call("game", 45, opened.slot, -1, 2)).toBe(-1);
  commonFailure(() => f.call("game", 45, opened.slot, 0, 3), "fatal", "Bad origin in FS_Seek\n");
});

test("numeric and typed writers share slots, cursors, close state and partial-write logic", async () => {
  const f = await fixture(), writer = f.files.writable.openBinaryWrite("typed.dat");
  if (writer === null) throw new Error("Expected actual typed writer");
  expect(f.open("read.bin").slot).toBe(2);
  writer.writeBytes(encoder.encode("abcd"));
  f.files.seekFile(1, 1, 2);
  f.memory.span(256, 2).set(encoder.encode("XY"));
  expect(f.call("ui", 15, 256, 2, 1)).toBe(0);
  expect(writer.tell()).toBe(3);
  writer.writeBytes(encoder.encode("Z"));
  expect(readFileSync(join(f.home, "baseq3", "typed.dat"), "utf8")).toBe("aXYZ");
  f.call("cgame", 13, 1);
  expect(() => writer.writeBytes(encoder.encode("stale"))).toThrow("closed");
  const replacement = f.open("reused.dat", 1);
  expect(replacement.slot).toBe(1);
  writer.close();
  expect(f.files.writeFile(1, encoder.encode("new"))).toBe(3);
  expect(readFileSync(join(f.home, "baseq3", "reused.dat"), "utf8")).toBe("new");
});

test("source streamed relative seeks run twice on the same retained loose descriptor", async () => {
  const f = await fixture(), opened = f.files.current.openRead("read.bin");
  if (opened === undefined) throw new Error("Expected actual source read");
  const bytes = new Uint8Array(2);
  f.files.current.readInto(opened.file, bytes);
  renameSync(join(f.home, "baseq3", "read.bin"), join(f.home, "baseq3", "original.bin"));
  writeFileSync(join(f.home, "baseq3", "read.bin"), "replacement");
  expect(f.call("game", 45, opened.file.slot, 2, 0)).toBe(0);
  expect(f.files.current.readInto(opened.file, bytes)).toBe(2);
  expect(decoder.decode(bytes)).toBe("67");
  expect(f.files.seekFile(opened.file.slot, -2, 0)).toBe(0);
  expect(f.files.current.readInto(opened.file, bytes)).toBe(2);
  expect(decoder.decode(bytes)).toBe("45");
  expect(f.files.seekFile(opened.file.slot, -1, 1)).toBe(0);
  bytes.fill(0x7e);
  expect(f.files.current.readInto(opened.file, bytes)).toBe(1);
  expect(decoder.decode(bytes)).toBe("9~");
  expect(f.files.seekFile(opened.file.slot, 2, 2)).toBe(0);
  expect(f.files.seekFile(opened.file.slot, -2, 0)).toBe(-1);
  expect(f.files.current.readInto(opened.file, bytes)).toBe(2);
  expect(decoder.decode(bytes)).toBe("01");
});

test("packed seeks rewind the actual open archive, preserve source returns and reject its limit", async () => {
  const f = await fixture(), opened = f.open("packed.bin");
  expect(opened).toEqual({ result: 10, slot: 1 });
  f.call("game", 11, 256, 3, opened.slot);
  renameSync(join(f.data, "baseq3", "pak0.pk3"), join(f.data, "baseq3", "retained.pk3"));
  writeFileSync(join(f.data, "baseq3", "pak0.pk3"), "replacement path is not a zip");
  expect(f.call("game", 45, opened.slot, 2, 0)).toBe(2);
  f.call("game", 11, 256, 3, opened.slot);
  expect(decoder.decode(f.memory.span(256, 3))).toBe("CDE");
  expect(f.call("game", 45, opened.slot, 4, 99)).toBe(4);
  expect(f.call("game", 45, opened.slot, 99, 1)).toBe(10);
  f.memory.span(256, 2).fill(0x7e); f.call("game", 11, 256, 2, opened.slot);
  expect(decoder.decode(f.memory.span(256, 2))).toBe("~~");
  expect(f.call("game", 45, opened.slot, 0, 2)).toBe(0);
  f.call("game", 11, 256, 1, opened.slot);
  expect(f.memory.bytes[256]).toBe(65);
  commonFailure(() => f.call("game", 45, opened.slot, 65536, 2), "fatal", "ZIP FILE FSEEK NOT YET IMPLEMENTED\n");
  expect(() => f.call("game", 45, opened.slot, -1, 2)).toThrow(RangeError);
  commonFailure(() => f.call("game", 12, 256, 1, opened.slot), "drop", "FS_FileForHandle: can't get FILE on zip file");
});

test("shared PK3 rewind restores that handle's original entry on the same archive owner", async () => {
  const f = await fixture();
  using archive = await Pk3Archive.open(join(f.data, "baseq3", "pak0.pk3"));
  const first = archive.openSharedRead("packed.bin"), second = archive.openSharedRead("list/from-pak.txt");
  expect(first.rewind()).toBe(0);
  const bytes = new Uint8Array(2);
  expect(second.readInto(bytes)).toBe(2);
  expect(decoder.decode(bytes)).toBe("AB");
  expect(second.rewind()).toBe(0);
  expect(first.readInto(bytes)).toBe(1);
  expect(bytes[0]).toBe(80);
});

test("PK3 rewind revalidates its retained local header before reporting success", async () => {
  const f = await fixture(), opened = f.open("packed.bin");
  expect(f.call("game", 11, 256, 1, opened.slot)).toBe(0);
  const descriptor = openSync(join(f.data, "baseq3", "pak0.pk3"), "r+");
  try { writeSync(descriptor, new Uint8Array([0]), 0, 1, 0); }
  finally { closeSync(descriptor); }
  expect(() => f.call("game", 45, opened.slot, 0, 2)).toThrow("local file header signature");
  expect(() => f.call("game", 11, 256, 1, opened.slot)).toThrow("reader is closed");
});

test("existence probes allocate no slot, ignore purity and leave actual references untouched", async () => {
  const f = await fixture();
  f.memory.writeString(16, "packed.bin", 32);
  const before = f.files.current.pakReferences.snapshot();
  expect(f.call("game", 10, 16, 0, 0)).toBe(1);
  expect(f.randomCalls()).toBe(0);
  expect(f.files.current.pakReferences.snapshot()).toEqual(before);
  await f.files.setServerLoadedPaks("123456", "baseq3/not-installed", () => {});
  expect(f.call("ui", 13, 16, 0, 0)).toBe(1);
  expect(f.open("packed.bin")).toEqual({ result: -1, slot: 0 });
  expect(f.open("read.bin")).toEqual({ result: -1, slot: 0 });
  await f.files.setServerLoadedPaks("", "", () => {});
  const slots = Array.from({ length: 63 }, () => f.open("read.bin").slot);
  expect(slots).toEqual(Array.from({ length: 63 }, (_, index) => index + 1));
  f.memory.writeString(16, "read.bin", 32);
  expect(f.call("cgame", 10, 16, 0, 0)).toBe(1);
  f.memory.view(128, 4).setInt32(0, 91, true);
  commonFailure(() => f.call("game", 10, 16, 128, 0), "drop", "FS_HandleForFile: none free");
  expect(f.memory.view(128, 4).getInt32(0, true)).toBe(91);
  expect(() => f.open("not-created.dat", 1)).toThrow("none free");
  expect(existsSync(join(f.home, "baseq3", "not-created.dat"))).toBe(false);
  f.files.closeFile(17);
  expect(f.open("vm/ui.qvm").slot).toBe(17);
  const pack = f.files.current.pakReferences.snapshot()[0];
  if (pack === undefined) throw new Error("Expected fixture pack");
  expect(pack.flags & PakReferenceFlag.Ui).toBe(PakReferenceFlag.Ui);
});

test("read-open diagnostics observe published VM handles and append clears before debug output", async () => {
  const f = await fixture();
  f.cvars.set("fs_debug", "1", true); f.cvars.register("developer", "1");
  expect(f.open("read.bin").slot).toBe(1);
  expect(f.printed[0]).toEqual({ text: `FS_FOpenFileRead: read.bin (found in '${join(f.home, "baseq3")}')\n`, handle: 1, clears: 0 });
  f.files.closeFile(1);
  f.memory.view(128, 4).setInt32(0, 91, true);
  expect(f.open("new.dat", 2).slot).toBe(1);
  expect(f.printed[1]).toEqual({ text: `FS_FOpenFileAppend: ${join(f.home, "baseq3", "new.dat")}\n`, handle: 91, clears: 1 });
  expect(f.open("missing.dat")).toEqual({ result: -1, slot: 0 });
  expect(f.printed[2]).toEqual({ text: "Can't find missing.dat\n", handle: 2, clears: 1 });
});

test("zero handles, missing opens and invalid VM ranges preserve required source boundaries", async () => {
  const f = await fixture();
  expect(f.call("game", 11, 0, -1, 0)).toBe(0);
  expect(f.call("ui", 15, 0, 2147483647, 0)).toBe(0);
  expect(f.call("game", 13, 0)).toBe(0);
  commonFailure(() => f.call("game", 45, 0, 0, 2), "drop", "FS_FileForHandle: NULL");
  expect(f.open("missing.dat")).toEqual({ result: -1, slot: 0 });
  expect(f.open("../outside")).toEqual({ result: -1, slot: 0 });
  expect(f.open("Q3KEY")).toEqual({ result: -1, slot: 0 });
  for (const slot of [-1, 64, 2147483647]) {
    commonFailure(() => f.call("game", 13, slot), "drop", "FS_FileForHandle: out of reange");
  }
  commonFailure(() => f.call("game", 10, 0, 0, 99), "fatal", "FSH_FOpenFile: bad mode");
  f.memory.writeString(16, "uncreated.dat", 32);
  expect(() => f.call("game", 10, 16, 1022, 1)).toThrow(RangeError);
  expect(() => f.call("game", 10, 16, 0, 1)).toThrow(RangeError);
  expect(existsSync(join(f.home, "baseq3", "uncreated.dat"))).toBe(false);
  const opened = f.open("read.bin");
  f.memory.span(1018, 6).fill(0x7e);
  expect(() => f.call("game", 11, 1018, 7, opened.slot)).toThrow(RangeError);
  expect(() => f.call("game", 11, 256, -1, opened.slot)).toThrow(RangeError);
  expect(() => f.call("game", 11, 0, 1, opened.slot)).toThrow(RangeError);
  expect(f.call("game", 11, 0, 0, opened.slot)).toBe(0);
  expect(f.call("game", 11, 256, 1, opened.slot)).toBe(0);
  expect(f.memory.bytes[256]).toBe(48);
  f.memory.writeString(16, "", 16); f.memory.writeString(48, ".bin", 16);
  expect(() => f.call("game", 38, 16, 48, 256, 0)).toThrow(RangeError);
  f.files.close();
  commonFailure(() => f.call("game", 11, 0, 0, 0), "fatal", "Filesystem call made without initialization\n");
  expect(f.call("game", 99)).toBeNull();
});

test("VM pointers mask only their nonnull start, including unaligned and negative handle destinations", async () => {
  const f = await fixture();
  f.memory.writeString(16, "read.bin", 32);
  expect(f.call("game", 10, 1040, -895, 0)).toBe(10);
  const slot = f.memory.view(129, 4).getInt32(0, true);
  expect(slot).toBe(1);
  expect(f.call("game", 11, 1024, 2, slot)).toBe(0);
  expect([...f.memory.bytes.subarray(0, 2)]).toEqual([48, 49]);
  expect(f.call("game", 11, -1, 1, slot)).toBe(0);
  expect(f.memory.bytes[1023]).toBe(50);
  expect(() => f.call("game", 11, -1, 2, slot)).toThrow(RangeError);
});

test("restart retires sized VM reads while empty reads and writes retain the shared source slots", async () => {
  const f = await fixture(), positive = f.open("read.bin"), empty = f.open("empty.dat"), writer = f.open("surviving.dat", 1);
  expect([positive.slot, empty.slot, writer.slot]).toEqual([1, 2, 3]);
  f.files.writeFile(writer.slot, encoder.encode("before"));
  const previous = f.files.current;
  await f.files.restart({ checksumFeed: 9, random: () => 0.5 }, () => {});
  expect(() => previous.has("read.bin")).toThrow("retired");
  commonFailure(() => f.call("game", 11, 256, 1, positive.slot), "drop", "FS_FileForHandle: NULL");
  expect(f.call("game", 11, 256, 1, empty.slot)).toBe(0);
  expect(f.files.writeFile(writer.slot, encoder.encode("after"))).toBe(5);
  expect(readFileSync(join(f.home, "baseq3", "surviving.dat"), "utf8")).toBe("beforeafter");
  expect(f.open("read.bin").slot).toBe(1);
  f.files.close();
  commonFailure(() => f.files.writeFile(writer.slot, encoder.encode("closed")), "fatal", "Filesystem call made without initialization\n");
});

test("numeric seeks keep contained-download resource identity and stale borrower closure cannot close a reused slot", async () => {
  const f = await fixture();
  writeFileSync(join(f.home, "baseq3", "download.pk3"), "download");
  const download = f.files.server.openDownload("baseq3/download.pk3");
  if (download === null) throw new Error("Expected actual contained download");
  expect(f.open("read.bin").slot).toBe(2);
  expect(f.files.seekFile(1, 2, 2)).toBe(0);
  const bytes = new Uint8Array(3);
  expect(download.read(bytes)).toBe(3);
  expect(decoder.decode(bytes)).toBe("wnl");
  f.files.closeFile(1);
  expect(f.open("replacement.dat", 1).slot).toBe(1);
  download.close();
  expect(f.files.writeFile(1, encoder.encode("alive"))).toBe(5);
  expect(readFileSync(join(f.home, "baseq3", "replacement.dat"), "utf8")).toBe("alive");
});

test("wrong-direction loose I/O reaches actual descriptor failures and keeps source zero returns", async () => {
  const f = await fixture(), reader = f.open("read.bin");
  f.memory.bytes[256] = 88;
  expect(f.call("game", 12, 256, 1, reader.slot)).toBe(0);
  expect(f.printed.map(entry => entry.text)).toEqual(["FS_Write: 0 bytes written\n"]);
  expect(readFileSync(join(f.home, "baseq3", "read.bin"), "utf8")).toBe("0123456789");
  const writer = f.open("write-only.dat", 1);
  expect(f.call("game", 11, 256, 1, writer.slot)).toBe(0);
  expect(f.memory.bytes[256]).toBe(88);
});

test("factored numeric writes retain actual partial bytes, cursor publication and the one retry budget", async () => {
  const f = await fixture(), handles = new SourceFileHandles();
  cleanup.push(() => { handles.close(); });
  const diagnostics: { readonly text: string; readonly position: number }[] = [];
  const file = handles.selectFree();
  class PartialFiles extends WritableFileSystem {
    calls = 0;
    protected override writeChunk(descriptor: number, bytes: Uint8Array, offset: number, length: number, position: number | null): number {
      this.calls++;
      return this.calls === 1 ? super.writeChunk(descriptor, bytes, offset, Math.min(2, length), position) : 0;
    }
  }
  const writer = new PartialFiles({ homePath: f.home, product: "baseq3", handles,
    print: text => { diagnostics.push({ text, position: handles.tellWrite(file) }); } });
  cleanup.push(() => { writer.closeAll(); });
  expect(writer.openByMode("partial.dat", "write")).toBe(file);
  expect(handles.fromSlot(1)).toBe(file);
  expect(handles.seek(file, 3, 2)).toBe(0);
  expect(writer.writeBytes(file, encoder.encode("abcd"))).toBe(0);
  expect(writer.calls).toBe(3);
  expect(diagnostics).toEqual([{ text: "FS_Write: 0 bytes written\n", position: 5 }]);
  expect([...readFileSync(join(f.home, "baseq3", "partial.dat"))]).toEqual([0, 0, 0, 97, 98]);
  expect(() => handles.fromSlot(1.5)).toThrow(CommonError);
});

function syscall(operations: Operation[], trap: number, args: readonly (number | { readonly load: number })[], discard = true): void {
  for (const [index, value] of args.entries()) {
    if (typeof value === "number") operations.push([Op.OP_CONST, value]);
    else operations.push([Op.OP_CONST, value.load], [Op.OP_LOAD4]);
    operations.push([Op.OP_ARG, 8 + index * 4]);
  }
  operations.push([Op.OP_CONST, -trap - 1], [Op.OP_CALL]);
  if (discard) operations.push([Op.OP_POP]);
}

test("authored QVM bytecode roundtrips real file open, write, seek, close and short read", async () => {
  const f = await fixture(), operations: Operation[] = [[Op.OP_ENTER, 32]];
  syscall(operations, 10, [64, 128, 1]);
  syscall(operations, 12, [256, 5, { load: 128 }]);
  syscall(operations, 45, [{ load: 128 }, -2, 0]);
  syscall(operations, 12, [272, 2, { load: 128 }]);
  syscall(operations, 13, [{ load: 128 }]);
  syscall(operations, 10, [64, 132, 0]);
  syscall(operations, 11, [288, 8, { load: 132 }], false);
  operations.push([Op.OP_LEAVE, 32]);
  const code = new BinaryWriter(operations.length * 5);
  for (const [opcode, operand] of operations) {
    code.u8(opcode);
    if (operand !== undefined) {
      if (opcode === Op.OP_ARG) code.u8(operand);
      else code.i32(operand);
    }
  }
  const bytes = code.finish(), image = new BinaryWriter(32 + bytes.length);
  for (const value of [0x12721444, operations.length, 32, bytes.length, 32 + bytes.length, 0, 0, 512]) image.i32(value);
  image.bytes(bytes);
  const vm = new QvmInterpreter(parseQvm(image.finish(), "authored-filesystem.qvm"), call => {
    const result = qvmFilesystemSyscall("game", call.words, new QvmMemory(call.memory), f.files);
    if (result === null) throw new Error("Unexpected authored filesystem trap");
    return result;
  });
  const memory = new QvmMemory(vm.memory);
  memory.writeString(64, "vm-roundtrip.dat", 32);
  memory.span(256, 5).set(encoder.encode("abcde"));
  memory.span(272, 2).set(encoder.encode("XY"));
  memory.span(288, 8).fill(0x7e);
  expect(await vm.invoke([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(0);
  expect(decoder.decode(memory.span(288, 8))).toBe("abcXY~~~");
  expect(readFileSync(join(f.home, "baseq3", "vm-roundtrip.dat"), "utf8")).toBe("abcXY");
  expect(memory.view(128, 4).getInt32(0, true)).toBe(1);
  expect(memory.view(132, 4).getInt32(0, true)).toBe(1);
});
