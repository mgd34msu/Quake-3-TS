import { expect, test } from "bun:test";
import { CvarFlag, CvarRegistry, CvarVmStringError, createVmCvarWords } from "../src/core/cvar.ts";
import type { VmCvarRead } from "../src/core/cvar.ts";
import ts from "typescript";
import { resolve } from "node:path";

function words(mirror: VmCvarRead): readonly [string, number, number, number] {
  return [mirror.value, mirror.numericValue, mirror.integerValue, mirror.modificationCount];
}

test("registerable VM allocation starts at zero and update follows source handle zero", () => {
  const prints: string[] = [], registry = new CvarRegistry(text => { prints.push(text); });
  const mirror = registry.createVm();
  expect(words(mirror)).toEqual(["", 0, 0, 0]);
  expect(registry.indexCount).toBe(0);
  expect(registry.modifiedFlags).toBe(0);
  expect(prints).toEqual([]);
  expect(() => mirror.update()).toThrow("Cvar_Update: handle out of range");
  expect(words(mirror)).toEqual(["", 0, 0, 0]);
  registry.register("slot-zero", "12.5");
  mirror.update();
  expect(words(mirror)).toEqual(["12.5", 12.5, 12, 1]);
  mirror.register("slot-one", "7");
  expect(words(mirror)).toEqual(["7", 7, 7, 1]);
  registry.set("slot-zero", "99", true);
  mirror.update();
  expect(words(mirror)).toEqual(["7", 7, 7, 1]);
  registry.set("slot-one", "8", true);
  mirror.update();
  expect(words(mirror)).toEqual(["8", 8, 8, 2]);
});

test("registration binds and writes minus one before updating the same retained VM words", () => {
  const registry = new CvarRegistry(), mirror = registry.createVm();
  mirror.register("first", "12.5");
  mirror.writeInteger(61);
  const seen: (readonly [string, number, number, number])[] = [];
  const update = mirror.update.bind(mirror);
  mirror.update = () => { seen.push(words(mirror)); update(); };
  mirror.register("first", "12.5");
  expect(seen).toEqual([["12.5", 12.5, 61, -1]]);
  expect(words(mirror)).toEqual(["12.5", 12.5, 12, 1]);
  mirror.writeInteger(62);
  expect(() => mirror.register("overflow", "x".repeat(256))).toThrow(CvarVmStringError);
  expect(seen.at(-1)).toEqual(["12.5", 12.5, 62, -1]);
  expect(words(mirror)).toEqual(["12.5", 12.5, 62, 1]);
  mirror.update();
  expect(words(mirror)).toEqual(["12.5", 12.5, 62, 1]);
  expect(() => mirror.register("overflow", "")).toThrow(CvarVmStringError);
  registry.set("overflow", "-7.25", true);
  mirror.update();
  expect(words(mirror)).toEqual(["-7.25", -7.25, -7, 2]);
  expect(registry.indexCount).toBe(2);
});

test("failed Cvar_Get keeps the previous binding and VM words, including full retired indexes", () => {
  const registry = new CvarRegistry(), mirror = registry.createVm();
  mirror.register("bound", "4");
  mirror.writeInteger(77);
  expect(() => mirror.register("invalid-byte", "\u0100")).toThrow("byte");
  expect(words(mirror)).toEqual(["4", 4, 77, 1]);
  for (let index = 1; index < 1024; index++) registry.set(`slot${index}`, "1");
  registry.resetAll();
  expect(registry.indexCount).toBe(1024);
  expect(() => mirror.register("full", "1")).toThrow("MAX_CVARS");
  expect(words(mirror)).toEqual(["4", 4, 77, 1]);
  registry.set("bound", "6", true);
  mirror.update();
  expect(words(mirror)).toEqual(["6", 6, 6, 2]);
});

test("retired slot zero stays empty and explicit registration rebinds the same VM cell", () => {
  const registry = new CvarRegistry(), mirror = registry.createVm();
  registry.set("server1", "9");
  mirror.update();
  mirror.writeInteger(70);
  registry.resetAll();
  mirror.update();
  expect(words(mirror)).toEqual(["9", 9, 70, 1]);
  const fresh = registry.createVm();
  fresh.update();
  expect(words(fresh)).toEqual(["", 0, 0, 0]);
  registry.set("server1", "4");
  fresh.update(); mirror.update();
  expect(words(fresh)).toEqual(["", 0, 0, 0]);
  expect(words(mirror)).toEqual(["9", 9, 70, 1]);
  mirror.register("server1", "", CvarFlag.Archive);
  expect(words(mirror)).toEqual(["4", 4, 4, 1]);
  registry.set("SERVER1", "5", true);
  mirror.update();
  expect(words(mirror)).toEqual(["5", 5, 5, 2]);
  expect(registry.indexCount).toBe(2);
});

test("canonical VM integer write changes only its same owned word and survives equal-count update", () => {
  const registry = new CvarRegistry();
  const mirror = registry.registerVm("word", "12.5", CvarFlag.Archive);
  registry.clearModifiedFlags(CvarFlag.Archive);
  registry.clearModified("word");
  const before = registry.get("word");
  mirror.writeInteger(19);
  expect(mirror.integerValue).toBe(19);
  expect(mirror.value).toBe("12.5");
  expect(mirror.numericValue).toBe(12.5);
  expect(mirror.modificationCount).toBe(1);
  expect(registry.get("word")).toEqual(before);
  expect(registry.modifiedFlags).toBe(0);
  mirror.update();
  expect(mirror.integerValue).toBe(19);
});

test("unregistered VM words start at source zero without allocating or gaining a handle", () => {
  const registry = new CvarRegistry();
  const first = createVmCvarWords(), second = createVmCvarWords();
  expect(words(first)).toEqual(["", 0, 0, 0]);
  expect(first).not.toBe(second);
  for (const name of ["update", "register", "handle"]) expect(name in first).toBe(false);
  first.writeInteger(6);
  expect(words(first)).toEqual(["", 0, 6, 0]);
  expect(words(second)).toEqual(["", 0, 0, 0]);
  expect(registry.indexCount).toBe(0);
  expect(registry.modifiedFlags).toBe(0);
  expect(registry.get("ui_serverFilterType")).toBeUndefined();
});

test("safe integer writes use the selected QVM DWORD profile and reject non-integer inputs before mutation", () => {
  const registry = new CvarRegistry();
  for (const mirror of [createVmCvarWords(), registry.registerVm("signed", "2.5", CvarFlag.Archive)]) {
    for (const [input, expected] of [
      [0, 0], [-0, 0], [2147483647, 2147483647], [2147483648, -2147483648],
      [-2147483648, -2147483648], [-2147483649, 2147483647],
      [4294967296, 0], [-4294967296, 0], [Number.MAX_SAFE_INTEGER, -1], [-Number.MAX_SAFE_INTEGER, 1],
    ] satisfies readonly (readonly [number, number])[]) {
      const before = words(mirror);
      mirror.writeInteger(input);
      expect(words(mirror)).toEqual([before[0], before[1], expected, before[3]]);
    }
    for (const invalid of [NaN, Infinity, -Infinity, .5, -1.25, Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER - 1]) {
      const before = words(mirror);
      expect(() => mirror.writeInteger(invalid)).toThrow(RangeError);
      expect(words(mirror)).toEqual(before);
    }
  }
  expect(registry.get("signed")?.value).toBe("2.5");
  expect(registry.get("signed")?.modificationCount).toBe(1);
  expect(registry.modifiedFlags).toBe(0);
  expect(registry.indexCount).toBe(1);
});

test("independent mirrors preserve local overrides until their own changed-count update", () => {
  const registry = new CvarRegistry();
  const first = registry.registerVm("word", "12.5", CvarFlag.Archive);
  const second = registry.registerVm("word", "0");
  first.writeInteger(19); second.writeInteger(-8);
  registry.set("word", "12.5", true);
  first.update(); second.update();
  expect(words(first)).toEqual(["12.5", 12.5, 19, 1]);
  expect(words(second)).toEqual(["12.5", 12.5, -8, 1]);
  registry.set("word", "7.25", true);
  first.update();
  expect(words(first)).toEqual(["7.25", 7.25, 7, 2]);
  expect(words(second)).toEqual(["12.5", 12.5, -8, 1]);
  second.update();
  expect(words(second)).toEqual(words(first));
  expect(registry.indexCount).toBe(1);
});

test("latch count refresh and registration latch application overwrite only on update", () => {
  const registry = new CvarRegistry();
  const first = registry.registerVm("latched", "1", CvarFlag.Archive | CvarFlag.Latch);
  first.writeInteger(9);
  registry.set("latched", "2");
  expect(words(first)).toEqual(["1", 1, 9, 1]);
  first.update();
  expect(words(first)).toEqual(["1", 1, 1, 2]);
  first.writeInteger(10);
  registry.clearModifiedFlags(CvarFlag.Archive);
  const second = registry.registerVm("latched", "1", CvarFlag.Archive | CvarFlag.Latch);
  expect(words(second)).toEqual(["2", 2, 2, 3]);
  expect(words(first)).toEqual(["1", 1, 10, 2]);
  expect(registry.modifiedFlags & CvarFlag.Archive).toBe(CvarFlag.Archive);
  first.update();
  expect(words(first)).toEqual(words(second));
});

test("cleared slots retain the exact old local word while protected slots retain their source", () => {
  const registry = new CvarRegistry();
  registry.set("server1", "12.5");
  const old = registry.registerVm("server1", "", CvarFlag.Archive);
  old.writeInteger(71);
  registry.resetAll(); old.update();
  expect(registry.get("server1")).toBeUndefined();
  registry.set("server1", "4");
  const replacement = registry.registerVm("server1", "", CvarFlag.Archive);
  old.update();
  expect(words(old)).toEqual(["12.5", 12.5, 71, 1]);
  expect(words(replacement)).toEqual(["4", 4, 4, 1]);
  expect(registry.indexCount).toBe(2);
  old.writeInteger(72); old.update();
  expect(old.integerValue).toBe(72);
  for (const flag of [CvarFlag.ReadOnly, CvarFlag.Init, CvarFlag.NoRestart]) {
    const name = `kept${flag}`, mirror = registry.registerVm(name, "3", flag);
    mirror.writeInteger(15); registry.resetAll(); mirror.update();
    expect(words(mirror)).toEqual(["3", 3, 15, 1]);
    registry.set(name, "8", true); mirror.update();
    expect(words(mirror)).toEqual(["8", 8, 8, 2]);
  }
});

test("overflow publishes count but retains local integer, including unchanged retry and byte boundaries", () => {
  const registry = new CvarRegistry(), mirror = registry.registerVm("word", "12.5");
  mirror.writeInteger(27);
  registry.set("word", "\xff".repeat(256), true);
  expect(() => mirror.update()).toThrow(CvarVmStringError);
  expect(words(mirror)).toEqual(["12.5", 12.5, 27, 2]);
  mirror.update();
  expect(words(mirror)).toEqual(["12.5", 12.5, 27, 2]);
  mirror.writeInteger(28); mirror.update();
  expect(words(mirror)).toEqual(["12.5", 12.5, 28, 2]);
  registry.set("word", "\xff".repeat(255) + "\0ignored", true); mirror.update();
  expect(words(mirror)).toEqual(["\xff".repeat(255), 0, 0, 3]);
  registry.set("word", "-7.25", true); mirror.update();
  expect(words(mirror)).toEqual(["-7.25", -7.25, -7, 4]);
});

test("read-only VM borrowers have no write or update capability under the actual project type settings", () => {
  const root = resolve(import.meta.dir, "..");
  const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const raw: unknown = config.config;
  const parsed = ts.parseJsonConfigFileContent(raw, ts.sys, root);
  expect(parsed.errors).toEqual([]);
  const filename = resolve(root, "tests/vm-word-capability-proof.ts");
  const valid = [
    'import { CvarRegistry, createVmCvarWords } from "../src/core/cvar.ts";',
    'import type { VmCvarRead } from "../src/core/cvar.ts";',
    'import { BaseUiCvars } from "../src/ui/base/cvars.ts";',
    'import { TeamArenaUiCvars } from "../src/ui/team-arena/cvars.ts";',
    'const registry = new CvarRegistry();',
    'const registered = registry.registerVm("word", "0");',
    'registered.writeInteger(1); registered.update();',
    'const allocated = registry.createVm(); allocated.register("word", "0"); allocated.update();',
    'const bare = createVmCvarWords(); bare.writeInteger(2);',
    'const read: VmCvarRead = registered;',
    'const base = new BaseUiCvars(registry, () => undefined);',
    'base.register();',
    'const team = new TeamArenaUiCvars(registry, () => undefined);',
    'team.writeInteger("ui_gameType", 5);',
    'export const result = [read.integerValue, base.get("g_spSkill").integerValue, team.get("ui_gameType").integerValue, bare.integerValue];',
  ].join("\n");
  const forbidden = [
    'read.writeInteger(3);', 'read.update();', 'read.integerValue = 3;',
    'base.get("g_spSkill").writeInteger(3);', 'team.get("ui_gameType").writeInteger(3);',
    'bare.update();', 'bare.handle;', 'bare.register("word", "0");',
    'read.register("word", "0");', 'base.get("g_spSkill").register("word", "0");',
    'allocated.handle;',
  ];
  const host = ts.createCompilerHost(parsed.options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  let source = valid;
  host.getSourceFile = (path, version, onError, shouldCreateNewSourceFile) => path === filename
    ? ts.createSourceFile(path, source, version, true)
    : originalGetSourceFile(path, version, onError, shouldCreateNewSourceFile);
  const diagnostics = () => ts.getPreEmitDiagnostics(ts.createProgram([filename], parsed.options, host));
  expect(diagnostics()).toEqual([]);
  source += "\n" + forbidden.join("\n");
  const failures = diagnostics();
  expect(failures.map(item => item.code)).toEqual([2339, 2339, 2540, 2339, 2339, 2339, 2339, 2339, 2339, 2339, 2339]);
  expect(failures.every(item => item.file?.fileName === filename)).toBe(true);
});
