import { expect, test } from "bun:test";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { CommonCdKeyState, validateCdKey } from "../src/engine/cd-key.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import type { CommonBuildProfile } from "../src/engine/common-console.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { SourceFileHandles } from "../src/assets/file-handles.ts";

function read(owner: CommonCdKeyState): Uint8Array {
  const bytes = new Uint8Array(17); owner.readUiForCompiledModule(() => 1, () => bytes); return bytes;
}

function syntheticKeyReader(input: Uint8Array | null, trace: string[], onClose: () => void = () => {}) {
  const handles = new SourceFileHandles(), file = handles.selectFree();
  return {
    server: { openRead: (path: string) => {
      trace.push(`open ${path}`);
      return input === null ? null : { file, length: input.length };
    } },
    readFile: (slot: number, destination: Uint8Array): number => {
      expect(slot).toBe(file.slot); expect(destination).toEqual(new Uint8Array(16));
      expect(destination.buffer.byteLength).toBe(33);
      trace.push(`read ${destination.length}`);
      if (input === null) throw new Error("Unexpected missing-file read");
      const bytes = input.subarray(0, destination.length); destination.set(bytes); return bytes.length;
    },
    closeFile: (slot: number): void => { expect(slot).toBe(file.slot); trace.push("close"); onClose(); },
  };
}

test("key file reads close before publishing, read only sixteen bytes and do not mark archive", () => {
  const cvars = new CvarRegistry(), owner = new CommonCdKeyState(cvars, "client"), trace: string[] = [];
  const input = new TextEncoder().encode("a".repeat(16) + "ignored suffix");
  const files = syntheticKeyReader(input, trace, () => {
    const old = new Uint8Array(33); owner.readAuthorization(old);
    expect(old.subarray(0, 32)).toEqual(new Uint8Array(32).fill(32));
    input.fill(90);
  });
  owner.readFile("baseq3", files);
  const out = new Uint8Array(33); owner.readAuthorization(out);
  expect(out).toEqual(new Uint8Array([...new Uint8Array(16).fill(97), 0, ...new Uint8Array(15).fill(32), 0]));
  expect(trace).toEqual(["open baseq3/q3key", "read 16", "close"]);
  expect(cvars.modifiedFlags).toBe(0); expect(cvars.indexCount).toBe(0);
});

test("missing, empty, short, embedded-NUL and invalid key files blank only the selected source range", () => {
  const encoder = new TextEncoder();
  for (const input of [null, new Uint8Array(), encoder.encode("A".repeat(15)), encoder.encode("A".repeat(8) + "\0" + "A".repeat(7)), encoder.encode("Z".repeat(16))]) {
    for (const append of [false, true]) {
      const cvars = new CvarRegistry(), owner = new CommonCdKeyState(cvars, "client"), trace: string[] = [];
      const before = new Uint8Array(33); owner.readAuthorization(before);
      const files = syntheticKeyReader(input, trace);
      if (append) owner.appendFile("missionpack", files); else owner.readFile("baseq3", files);
      const expected = before.slice(), offset = append ? 16 : 0;
      expected.fill(32, offset, offset + 16); expected[offset + 16] = 0;
      const out = new Uint8Array(33); owner.readAuthorization(out); expect(out).toEqual(expected);
      expect(trace).toEqual(input === null ? [`open ${append ? "missionpack" : "baseq3"}/q3key`]
        : [`open ${append ? "missionpack" : "baseq3"}/q3key`, "read 16", "close"]);
      expect(cvars.modifiedFlags).toBe(0);
    }
  }
});

test("append finds the live first NUL after close and explicitly rejects repeated strcat overflow", () => {
  const cvars = new CvarRegistry(), owner = new CommonCdKeyState(cvars, "client"), trace: string[] = [];
  owner.readFile("baseq3", syntheticKeyReader(new Uint8Array(16).fill(65), trace));
  owner.appendFile("missionpack", syntheticKeyReader(new Uint8Array(16).fill(66), trace));
  const before = new Uint8Array(33); owner.readAuthorization(before);
  expect(before).toEqual(new Uint8Array([...new Uint8Array(16).fill(65), ...new Uint8Array(16).fill(66), 0]));
  trace.length = 0;
  expect(() => owner.appendFile("missionpack", syntheticKeyReader(new Uint8Array(16).fill(67), trace))).toThrow("strcat allocation overflow");
  const after = new Uint8Array(33); owner.readAuthorization(after); expect(after).toEqual(before);
  expect(trace).toEqual(["open missionpack/q3key", "read 16", "close"]);
  const prefix = new Uint8Array(16); prefix[0] = 87;
  owner.appendFile("missionpack", syntheticKeyReader(new Uint8Array(16).fill(67), trace, () => {
    cvars.register("fs_game", "missionpack"); owner.writeUiForCompiledModule(() => 1, () => prefix);
    cvars.takeModifiedFlags();
  }));
  owner.readAuthorization(after);
  expect(after.subarray(16, 32)).toEqual(new Uint8Array([87, ...new Uint8Array(15).fill(67)]));
  expect(cvars.modifiedFlags).toBe(0);
  expect(() => owner.appendFile("missionpack", syntheticKeyReader(new Uint8Array(16).fill(65), []))).toThrow("strcat allocation overflow");
});

test("key file write snapshots before open and emits the exact four source writes before close", () => {
  const cvars = new CvarRegistry(), owner = new CommonCdKeyState(cvars, "client"), trace: string[] = [], writes: Uint8Array[] = [];
  owner.readFile("baseq3", syntheticKeyReader(new Uint8Array(16).fill(65), []));
  owner.appendFile("missionpack", syntheticKeyReader(new Uint8Array(16).fill(98), []));
  const files = { server: { openWrite: (path: string) => {
    trace.push(`open ${path}`);
    owner.readFile("baseq3", syntheticKeyReader(null, []));
    owner.appendFile("missionpack", syntheticKeyReader(null, []));
    return {
      writeBytes: (bytes: Uint8Array): number => { trace.push("write"); writes.push(bytes.slice()); return 0; },
      tell: (): number => 0, seek: (): number => 0, close: (): void => { trace.push("close"); },
    };
  } } };
  owner.writeFile("missionpack", 16, files, () => { throw new Error("Unexpected write failure"); });
  expect(trace).toEqual(["open missionpack/q3key", "write", "write", "write", "write", "close"]);
  expect(writes.map(bytes => new TextDecoder().decode(bytes))).toEqual([
    "b".repeat(16), "\n// generated by quake, do not modify\r\n", "// Do not give this file to ANYONE.\r\n",
    "// id Software and Activision will NOT ask you to send this file to them.\r\n",
  ]);
  expect(cvars.modifiedFlags).toBe(0);
});

test("invalid write keys never open and failed valid opens print only the source directory", () => {
  const cvars = new CvarRegistry(), owner = new CommonCdKeyState(cvars, "client"), trace: string[] = [], prints: string[] = [];
  const files = { server: { openWrite: (path: string): null => { trace.push(path); return null; } } };
  owner.writeFile("baseq3", 0, files, text => { prints.push(text); });
  expect(trace).toEqual([]); expect(prints).toEqual([]);
  owner.readFile("baseq3", syntheticKeyReader(new Uint8Array(16).fill(65), []));
  owner.writeFile("baseq3\0ignored", 0, files, text => { prints.push(text); });
  expect(trace).toEqual(["baseq3/q3key"]); expect(prints).toEqual(["Couldn't write baseq3.\n"]);
  owner.writeUiForCompiledModule(() => 0, () => new Uint8Array([...new Uint8Array(8).fill(65), 0, ...new Uint8Array(7).fill(65)]));
  cvars.takeModifiedFlags(); trace.length = 0; prints.length = 0;
  owner.writeFile("baseq3", 0, files, text => { prints.push(text); });
  expect(trace).toEqual([]); expect(prints).toEqual([]); expect(cvars.modifiedFlags).toBe(0);
});

test("key file formatting preserves C-string input and rejects undefined Unix path overflow before IO", () => {
  const owner = new CommonCdKeyState(new CvarRegistry(), "client"), trace: string[] = [];
  const files = syntheticKeyReader(null, trace);
  owner.readFile("baseq3\0ignored", files); expect(trace).toEqual(["open baseq3/q3key"]);
  owner.readFile("x".repeat(4089), files); expect(trace[1]?.length).toBe(4100);
  trace.length = 0;
  expect(() => owner.readFile("x".repeat(4090), files)).toThrow("MAX_OSPATH");
  expect(() => owner.appendFile("x".repeat(4090), files)).toThrow("MAX_OSPATH");
  expect(() => owner.writeFile("x".repeat(4090), 0, { server: { openWrite: (): null => { throw new Error("Unexpected open"); } } }, () => undefined)).toThrow("MAX_OSPATH");
  expect(trace).toEqual([]);
});

test("authorization borrows both raw source slots without UI selection or registry mutation", () => {
  const cvars = new CvarRegistry(), owner = new CommonCdKeyState(cvars, "client");
  const out = new Uint8Array(35).fill(211);
  expect(() => owner.readAuthorization(new Uint8Array(32))).toThrow("33 bytes");
  owner.readAuthorization(out);
  expect([...out]).toEqual([...new Uint8Array(32).fill(32), 0, 211, 211]);
  expect(cvars.indexCount).toBe(0);
  const base = Uint8Array.from({ length: 16 }, (_, index) => index), mod = new Uint8Array(16).fill(250);
  owner.writeUiForCompiledModule(() => 1, () => base); cvars.set("fs_game", "missionpack", true); owner.writeUiForCompiledModule(() => 1, () => mod);
  cvars.takeModifiedFlags(); owner.readAuthorization(out);
  expect([...out]).toEqual([...base, ...mod, 0, 211, 211]);
  expect(cvars.modifiedFlags).toBe(0);
  out.fill(17); owner.readAuthorization(out);
  expect([...out.subarray(0, 32)]).toEqual([...base, ...mod]);
});

test("local key validation preserves source alphabet, case, length and checksum byte wrap", () => {
  for (const character of "237ABCDGHJLPRSTWabcdghjlprstw") expect(validateCdKey(character.repeat(16), null)).toBe(true);
  for (const [character, checksum] of [["A", "10"], ["2", "20"], ["W", "70"]] satisfies readonly (readonly [string, string])[]) {
    expect(validateCdKey(character.repeat(16), checksum)).toBe(true);
    expect(validateCdKey(character.toLowerCase().repeat(16), checksum)).toBe(true);
    expect(validateCdKey(character.repeat(16), "00")).toBe(false);
  }
  expect(validateCdKey("237ABCDGHJLPRSTW", "6b")).toBe(true);
  expect(validateCdKey("237abcdghjlprstw", "6B")).toBe(true);
  for (const length of [0, 1, 15, 17, 256]) expect(validateCdKey("A".repeat(length), null)).toBe(false);
  for (let byte = 0; byte < 256; byte++) {
    const character = String.fromCharCode(byte);
    expect(validateCdKey("A".repeat(15) + character, null)).toBe("237ABCDGHJLPRSTWabcdghjlprstw".includes(character));
  }
  for (const checksum of ["", "1", "010", "gg", " 0", "0 "]) expect(validateCdKey("A".repeat(16), checksum)).toBe(false);
  expect(validateCdKey("A".repeat(16) + "\0ignored", "10\0ignored")).toBe(true);
  expect(validateCdKey("A".repeat(8) + "\0" + "A".repeat(8), null)).toBe(false);
  expect(() => validateCdKey("\u0100".repeat(16), null)).toThrow("byte");
  expect(() => validateCdKey("A".repeat(16), "\u0100")).toThrow("byte");
});

test("common key allocation has source client and dedicated defaults without registering or printing", () => {
  for (const profile of ["client", "dedicated"] satisfies readonly ("client" | "dedicated")[]) {
    const prints: string[] = [], cvars = new CvarRegistry(text => { prints.push(text); });
    const keys = new CommonCdKeyState(cvars, profile);
    expect(cvars.indexCount).toBe(0); expect(cvars.modifiedFlags).toBe(0); expect(prints).toEqual([]);
    const base = read(keys);
    expect([...base]).toEqual(profile === "client" ? [...new Uint8Array(16).fill(32), 0] : [49, 50, 51, 52, 53, 54, 55, 56, 57, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(cvars.get("fs_game")?.flags).toBe(CvarFlag.Init | CvarFlag.SystemInfo);
    expect(cvars.modifiedFlags).toBe(0);
    cvars.set("fs_game", "missionpack", true);
    expect([...read(keys)]).toEqual(profile === "client" ? [...new Uint8Array(16).fill(32), 0] : [...new Uint8Array(17)]);
  }
});

test("compiled UI slot selection copies sixteen raw bytes and preserves caller suffix and independent slots", () => {
  const cvars = new CvarRegistry(), owner = new CommonCdKeyState(cvars, "client");
  const base = Uint8Array.from({ length: 20 }, (_, index) => index), mod = new Uint8Array(16).fill(250);
  owner.writeUiForCompiledModule(() => 1, () => base);
  base.fill(99);
  const out = new Uint8Array(23).fill(211); owner.readUiForCompiledModule(() => 1, () => out);
  expect([...out]).toEqual([...Uint8Array.from({ length: 16 }, (_, index) => index), 0, 211, 211, 211, 211, 211, 211]);
  out.fill(13);
  expect(read(owner)[1]).toBe(1);
  cvars.set("fs_game", "baseq3", true); owner.writeUiForCompiledModule(() => 1, () => mod);
  expect([...read(owner)]).toEqual([...mod, 0]);
  cvars.set("fs_game", "missionpack", true);
  expect([...read(owner)]).toEqual([...mod, 0]);
  cvars.set("fs_game", "", true);
  expect([...read(owner)]).toEqual([...Uint8Array.from({ length: 16 }, (_, index) => index), 0]);
});

test("UI key writes mark archive on equal data and source-register fs_game before selecting its latched value", () => {
  const cvars = new CvarRegistry(), owner = new CommonCdKeyState(cvars, "client"), bytes = new Uint8Array(16).fill(66);
  cvars.register("fs_game", "", CvarFlag.Latch | CvarFlag.UserCreated);
  cvars.set("fs_game", "missionpack");
  cvars.takeModifiedFlags(); owner.writeUiForCompiledModule(() => 1, () => bytes);
  expect(cvars.get("fs_game")?.value).toBe("missionpack");
  expect(cvars.get("fs_game")?.latchedValue).toBeUndefined();
  expect(cvars.get("fs_game")?.flags).toBe(CvarFlag.Latch | CvarFlag.UserCreated | CvarFlag.Init | CvarFlag.SystemInfo);
  expect([...read(owner)]).toEqual([...bytes, 0]);
  cvars.takeModifiedFlags(); owner.writeUiForCompiledModule(() => 1, () => bytes);
  expect(cvars.modifiedFlags).toBe(CvarFlag.Archive);
  cvars.takeModifiedFlags(); owner.readUiForCompiledModule(() => 1, () => new Uint8Array(17));
  expect(cvars.modifiedFlags).toBe(0);
  cvars.set("fs_game", "", true);
  expect([...read(owner)]).toEqual([...new Uint8Array(16).fill(32), 0]);
});

test("managed storage bounds follow the UI callback while registration failures precede it", () => {
  const cvars = new CvarRegistry(), owner = new CommonCdKeyState(cvars, "client");
  let callbacks = 0;
  const usesUniqueKey = (): number => { callbacks++; return 1; };
  expect(() => owner.writeUiForCompiledModule(usesUniqueKey, () => new Uint8Array(15))).toThrow("16 bytes");
  expect(() => owner.readUiForCompiledModule(usesUniqueKey, () => new Uint8Array(16))).toThrow("17 bytes");
  expect(callbacks).toBe(2); expect(cvars.indexCount).toBe(1); expect(cvars.modifiedFlags).toBe(0);
  const register = cvars.bindVm.bind(cvars), failure = new Error("source register failure");
  cvars.bindVm = () => { throw failure; };
  const unexpected = (): never => { throw new Error("Buffer was resolved before registration completed"); };
  expect(() => owner.readUiForCompiledModule(usesUniqueKey, unexpected)).toThrow(failure);
  expect(() => owner.writeUiForCompiledModule(usesUniqueKey, unexpected)).toThrow(failure);
  expect(callbacks).toBe(2); expect(cvars.modifiedFlags).toBe(0);
  cvars.bindVm = register;
  expect([...read(owner)]).toEqual([...new Uint8Array(16).fill(32), 0]);
});

test("compiled key selection calls UI for empty fs_game and reads its live value only after qtrue", () => {
  const cvars = new CvarRegistry(), owner = new CommonCdKeyState(cvars, "client"), out = new Uint8Array(18).fill(211);
  owner.writeUiForCompiledModule(() => 0, () => new Uint8Array(16).fill(65));
  cvars.set("fs_game", "missionpack", true);
  owner.writeUiForCompiledModule(() => 1, () => new Uint8Array(16).fill(66));
  const trace: string[] = [], register = cvars.bindVm.bind(cvars), readValue = cvars.readVm.bind(cvars);
  cvars.bindVm = (name, value, flags) => { trace.push("register"); return register(name, value, flags); };
  cvars.readVm = handle => { trace.push("read fs_game"); return readValue(handle); };
  for (const result of [0, 1, 2, -1]) {
    cvars.set("fs_game", "", true); trace.length = 0;
    owner.readUiForCompiledModule(() => {
      trace.push("UI_HASUNIQUECDKEY");
      expect(cvars.get("fs_game")?.flags).toBe(CvarFlag.Init | CvarFlag.SystemInfo);
      cvars.set("fs_game", "missionpack", true);
      return result;
    }, () => { trace.push("destination"); return out; });
    expect(trace).toEqual(result === 1 ? ["register", "UI_HASUNIQUECDKEY", "read fs_game", "destination"]
      : ["register", "UI_HASUNIQUECDKEY", "destination"]);
    expect([...out]).toEqual([...new Uint8Array(16).fill(result === 1 ? 66 : 65), 0, 211]);
  }
  owner.readUiForCompiledModule(() => { cvars.set("fs_game", "", true); return 1; }, () => out);
  expect(out[0]).toBe(65);
});

test("compiled key callback sees applied fs_game latch before changing the selected value", () => {
  const cvars = new CvarRegistry(), owner = new CommonCdKeyState(cvars, "client"), out = new Uint8Array(17);
  cvars.register("fs_game", "", CvarFlag.Latch | CvarFlag.UserCreated);
  cvars.set("fs_game", "missionpack");
  owner.writeUiForCompiledModule(() => {
    expect(cvars.get("fs_game")?.value).toBe("missionpack");
    expect(cvars.get("fs_game")?.latchedValue).toBeUndefined();
    cvars.set("fs_game", "", true);
    return 1;
  }, () => new Uint8Array(16).fill(67));
  owner.readUiForCompiledModule(() => 0, () => out);
  expect(out).toEqual(new Uint8Array([...new Uint8Array(16).fill(67), 0]));
  cvars.set("fs_game", "missionpack", true);
  expect(read(owner)).toEqual(new Uint8Array([...new Uint8Array(16).fill(32), 0]));
});

test("nested compiled callbacks finish before caller bytes and retain completed writes after failure", () => {
  const cvars = new CvarRegistry(), owner = new CommonCdKeyState(cvars, "client"), incoming = new Uint8Array(16).fill(65);
  const trace: string[] = [];
  owner.writeUiForCompiledModule(() => {
    trace.push("outer callback");
    owner.writeUiForCompiledModule(() => { trace.push("inner callback"); return 0; }, () => {
      trace.push("inner source"); return new Uint8Array(16).fill(66);
    });
    incoming.fill(67); cvars.set("fs_game", "missionpack", true);
    return 1;
  }, () => { trace.push("outer source"); return incoming; });
  expect(trace).toEqual(["outer callback", "inner callback", "inner source", "outer source"]);
  expect(read(owner)).toEqual(new Uint8Array([...new Uint8Array(16).fill(67), 0]));
  const base = new Uint8Array(17); owner.readUiForCompiledModule(() => 0, () => base);
  expect(base).toEqual(new Uint8Array([...new Uint8Array(16).fill(66), 0]));
  cvars.takeModifiedFlags();
  const failure = new Error("outer UI callback failed");
  expect(() => owner.writeUiForCompiledModule(() => {
    owner.writeUiForCompiledModule(() => 0, () => new Uint8Array(16).fill(68));
    throw failure;
  }, () => { throw new Error("Unreached outer source"); })).toThrow(failure);
  expect(cvars.modifiedFlags).toBe(CvarFlag.Archive);
  expect(read(owner)).toEqual(new Uint8Array([...new Uint8Array(16).fill(67), 0]));
  owner.readUiForCompiledModule(() => 0, () => base);
  expect(base).toEqual(new Uint8Array([...new Uint8Array(16).fill(68), 0]));
});

test("actual CommonConsole owns its inert key state before adoption and filesystem startup", async () => {
  const builds: readonly CommonBuildProfile[] = [{ kind: "dedicated" }, { kind: "client", client: {
    initializeKeyCommands: () => { throw new Error("Unexpected bootstrap"); }, writeBindings: () => {}, consolePrint: () => {}, usesUniqueKey: () => 0,
  } }];
  for (const build of builds) {
    const stop = new Error("Stop at inert adoption before filesystem startup");
    await expect(CommonConsole.open({ roots: { dataPath: "/unused-cd-key-test", homePath: "/unused-cd-key-test", cdPath: null, product: "baseq3" },
      startup: new StartupCommands(""), random: new LinuxNativeRandom(1), build,
      platformPrint: () => { throw new Error("Unexpected allocation print"); }, resolveCommand: () => undefined,
      assertCommandEntry: () => undefined, assertOwnerEntry: () => undefined,
    }, common => {
      try {
        expect(common.cvars.snapshots()).toEqual([]);
        expect(common.cdKey).toBe(common.cdKey);
        expect(() => common.files).toThrow("not configured");
        expect([...read(common.cdKey)]).toEqual(build.kind === "client" ? [...new Uint8Array(16).fill(32), 0] : [49, 50, 51, 52, 53, 54, 55, 56, 57, 0, 0, 0, 0, 0, 0, 0, 0]);
        expect(common.cvars.get("fs_game")?.flags).toBe(CvarFlag.Init | CvarFlag.SystemInfo);
      } finally { common.close(); }
      throw stop;
    })).rejects.toBe(stop);
  }
});
