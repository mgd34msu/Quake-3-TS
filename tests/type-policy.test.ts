import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { auditProgram, auditProject } from "../tools/type-policy.ts";
import type { PolicyDiagnostic } from "../tools/type-policy.ts";

const root = resolve(import.meta.dir, "..");
const temporary = mkdtempSync(join(tmpdir(), "quake3-type-policy-"));
const fixtures: Readonly<Record<string, string>> = {
  "explicit-any": "export const value: any = 1;",
  "as-cast": "export const value = 1 as number;",
  "const-cast": "export const value = { count: 1 } as const;",
  "angle-cast": "export const value = <number>1;",
  "non-null": "export function value(x: string | undefined): string { return x!; }",
  "definite-property": "export class State { value!: number; }",
  "definite-variable": "export let value!: number;",
  "ignore": "// @ts-ignore\nexport const value: number = 'bad';",
  "expect-error": "// @ts-expect-error\nexport const value: number = 'bad';",
  "nocheck": "// @ts-nocheck\nexport const value: number = 'bad';",
  "ambient": "export declare const value: number;",
  "inferred": "export const value = JSON.parse('{}');",
  "parameter": "export function value(input) { return input; }",
  "typed-initializer": "export const value: number = JSON.parse('1');",
  "typed-assignment": "export let value = 1; value = JSON.parse('2');",
  "property": "export const value: unknown = JSON.parse('{}').property;",
  "nested-object": "export const value = { child: JSON.parse('{}') };",
  "promise": "export const value = Promise.resolve(JSON.parse('{}'));",
  "async-void-variable": "export const value: () => void = async () => {};",
  "async-void-argument": "function run(callback: () => void) { callback(); } run(async () => {});",
  "async-void-property": "export const host: { run(): void } = { run: async () => {} };",
  "async-void-method": "export const host: { run(): void } = { async run() {} };",
  "async-void-alias": "const asyncHost = { async run() {} }; export const host: { run(): void } = asyncHost;",
  "async-void-assignment": "let run: () => void = () => {}; run = async () => {}; export { run };",
  "async-void-return": "export function host(): { run(): void } { return { async run() {} }; }",
  "async-void-array": "const values = [async () => {}]; export const callbacks: readonly (() => void)[] = values;",
  "async-void-class": "interface Host { run(): void; } export class Service implements Host { async run() {} }",
  "async-void-extends": "class Base { run(): void {} } export class Service extends Base { async run() {} }",
  "async-void-thenable": "const run = (): PromiseLike<void> => Promise.resolve(); export const callback: () => void = run;",
  "async-void-union-result": "const run = (): void | Promise<void> => Promise.resolve(); export const callback: () => void = run;",
  "async-void-overload": "interface Callback { (): void; (mode: 'async'): Promise<void>; } export function adapt(callback: Callback): (mode: 'async') => void { return callback; }",
  "async-void-optional-overload": "interface Callback { (): void; (mode?: 'async'): Promise<void>; } export function adapt(callback: Callback): (mode?: 'async') => void { return callback; }",
  "async-void-rest-overload": "interface Callback { (): void; (...modes: 'async'[]): Promise<void>; } export function adapt(callback: Callback): (...modes: 'async'[]) => void { return callback; }",
  "external-assignment": "import { raw } from './external'; export const value: number = raw;",
  "external-argument": "import { raw } from './external'; function consume(x: number) { return x; } export const value = consume(raw);",
  "external-return": "import { raw } from './external'; export function value(): number { return raw; }",
  "external-array": "import { array } from './external'; export const value = array;",
  "external-call": "import { incoming } from './external'; export const value = incoming();",
  "external-promise": "import { promise } from './external'; export const value = promise;",
  "external-map": "import { map } from './external'; export const value = map;",
  "external-record": "import { record } from './external'; export const value = record;",
  "eval": "export const value = eval('1');",
  "function-constructor": "export const value = new Function('return 1');",
  "computed-function": "export const value = globalThis['Function']('return 1');",
  "wasm": "export const value = WebAssembly.compile(new Uint8Array());",
  "ffi-import": "import { dlopen } from 'bun:ffi'; export { dlopen };",
  "ffi-dynamic": "export const value = import('bun:ffi');",
  "ffi-cc": "import { cc as compileNative } from 'bun:ffi'; export { compileNative };",
  "ffi-namespace": "import * as ffi from 'bun:ffi'; export const value = ffi.cc;",
  "ffi-computed": "import * as ffi from 'bun:ffi'; export const value = ffi['cc'];",
  "safe": "export const value: unknown = JSON.parse('{}'); export function read(x: unknown): number { if (typeof x !== 'number') throw new Error('number required'); return x; }",
  "safe-parentheses": "export const value: unknown = (JSON.parse('{}'));",
  "safe-await": "import { promise } from './external'; export const value: unknown = await promise;",
  "safe-property": "export class Value { raw: unknown = JSON.parse('{}'); }",
  "safe-assignment": "export let value: unknown; value = JSON.parse('{}');",
  "safe-external": "import { raw } from './external'; export const value: unknown = raw;",
  "safe-array": "export const values: readonly unknown[] = [1, 'two']; export const value = values[0];",
  "safe-namespace": "import * as ts from 'typescript'; export const value = ts.SyntaxKind.AnyKeyword;",
  "safe-satisfies": "export const value = { count: 1 } satisfies { count: number };",
  "safe-async-contract": "export const host: { run(): Promise<void> } = { async run() {} };",
  "safe-async-union": "export const callback: (() => void) | (() => Promise<void>) = async () => {};",
  "safe-async-return-union": "export const callback: () => void | Promise<void> = async () => {};",
  "safe-sync-value": "export const callback: () => void = () => 1;",
  "safe-async-class": "interface Host { run(): Promise<void>; } export class Service implements Host { async run() {} }",
  "safe-recursive-host": "interface Host { next: Host | null; run(): void; } export const host: Host = { next: null, run() {} };",
  "safe-sync-overload": "interface Callback { (): void; (mode: 'async'): Promise<void>; } export function adapt(callback: Callback): () => void { return callback; }",
  "safe-sync-method-overload": "interface Host { run(): void; run(mode: 'async'): Promise<void>; } export function adapt(host: Host): { run(): void } { return host; }",
  "safe-sync-generic-overload": "interface Callback { <T>(value: T): void; <T>(value: T, mode: 'async'): Promise<void>; } export function adapt(callback: Callback): <T>(value: T) => void { return callback; }",
  "safe-sync-literal-overload": "interface Callback { (mode: 'sync'): void; (mode: 'async'): Promise<void>; } export function adapt(callback: Callback): (mode: 'sync') => void { return callback; }",
  "safe-sync-literal-method-overload": "interface Host { run(mode: 'sync'): void; run(mode: 'async'): Promise<void>; } export function adapt(host: Host): { run(mode: 'sync'): void } { return host; }",
  "safe-sync-primitive-overload": "interface Callback { (value: number): void; (value: string): Promise<void>; } export function adapt(callback: Callback): (value: number) => void { return callback; }",
  "safe-string": "export const value = '// @ts-ignore and x as const';",
  "safe-names": "export const value = { eval: 'label', Function: 'label', WebAssembly: 'label' }; export const label = value['Function'];",
  "src/native-addon": "export { value } from './engine.node';",
  "src/native-library": "export const value: unknown = await import('./engine.so.1');",
  "src/native-library-alias": "const path = '/tmp/engine.node'; export const value: unknown = await import(path);",
  "src/opaque-import": "export async function load(path: string): Promise<unknown> { const value: unknown = await import(path); return value; }",
  "src/create-require": "import { createRequire as loader } from 'node:module'; export const value: unknown = loader(import.meta.url)('./engine.node');",
  "src/commonjs": "export const value: unknown = require('./engine.node');",
  "src/process-dlopen": "process.dlopen({ exports: {} }, './engine.node');",
  "src/process-dlopen-alias": "const { dlopen: load } = process; load({ exports: {} }, './engine.node');",
  "src/process-dlopen-computed": "const key = 'dlopen'; process[key]({ exports: {} }, './engine.node');",
  "src/builtin-loader": "export const value: unknown = process.getBuiltinModule('child_process');",
  "src/child-process": "import { execFileSync } from 'node:child_process'; export const value = execFileSync('./native-engine');",
  "src/child-process-dynamic": "export const value = await import('child_process');",
  "src/child-process-reexport": "export { spawn } from 'node:child_process';",
  "src/bun-spawn": "Bun.spawn(['cc', 'engine.c', '-o', '/tmp/native-engine']);",
  "src/bun-spawn-computed": "const key = 'spawnSync'; Bun[key](['/tmp/native-engine']);",
  "src/bun-spawn-destructure": "const { spawn: run } = Bun; run(['/tmp/native-engine']);",
  "src/bun-spawn-alias": "import { spawn as run } from 'bun'; run(['/tmp/native-engine']);",
  "src/bun-shell": "import { $ } from 'bun'; await $`/tmp/native-engine`;",
  "src/execve": "process.execve?.('/tmp/native-engine', [], {});",
  "src/tool-bridge": "import '../tools/build.ts';",
  "src/helper-bridge": "import '../helper.ts';",
  "src/generated-bridge": "export const value: unknown = await import('../dist/native-engine');",
  "src/platform/native-ffi": "import { dlopen } from 'bun:ffi'; export const value = dlopen('libengine.so', { run: { args: [], returns: 'void' } });",
  "src/platform/native-symbol": "import { dlopen } from 'bun:ffi'; export const value = dlopen('libSDL2-2.0.so.0', { SDL_LoadObject: { args: ['cstring'], returns: 'ptr' } });",
  "src/platform/ffi-alias": "import { dlopen } from 'bun:ffi'; const load = dlopen; export const value = load('libengine.so', {});",
  "src/platform/ffi-opaque": "import { dlopen } from 'bun:ffi'; const symbols = {}; export const value = dlopen('libSDL2-2.0.so.0', symbols);",
  "src/platform/ffi-linked-native": "import { linkSymbols } from 'bun:ffi'; export const value = linkSymbols({ runEngine: { args: [], returns: 'void', ptr: null } });",
  "src/platform/ffi-reexport": "export * from 'bun:ffi';",
  "src/ffi-indirect": "import { dlopen } from './platform/ffi-reexport'; export const value = dlopen('libSDL2-2.0.so.0', { SDL_GetTicks: { args: [], returns: 'u32' } });",
  "src/platform/safe-sdl": "import { dlopen } from 'bun:ffi'; export const value = dlopen(process.env['QUAKE_SDL2_LIBRARY'] ?? 'libSDL2-2.0.so.0', { SDL_GetTicks: { args: [], returns: 'u32' } });",
  "src/platform/safe-gl": "import { dlopen } from 'bun:ffi'; export const value = dlopen('libGL.so.1', { glGetError: { args: [], returns: 'u32' } });",
  "src/platform/safe-unix-terminal": "import { dlopen } from 'bun:ffi'; export const value = dlopen('libc.so.6', { tcgetattr: { args: ['i32', 'buffer'], returns: 'i32' }, tcsetattr: { args: ['i32', 'i32', 'buffer'], returns: 'i32' }, sigaction: { args: ['i32', 'buffer', 'buffer'], returns: 'i32' } });",
  "src/platform/safe-unix-calendar": "import { dlopen } from 'bun:ffi'; export const value = dlopen('libc.so.6', { localtime_r: { args: ['buffer', 'buffer'], returns: 'ptr' }, tzset: { args: [], returns: 'void' } });",
  "src/platform/safe-unix-signal-exit": "import { dlopen } from 'bun:ffi'; export const value = dlopen('libc.so.6', { _exit: { args: ['i32'], returns: 'void' } });",
  "src/platform/unix-shell": "import { dlopen } from 'bun:ffi'; export const value = dlopen('libc.so.6', { system: { args: ['cstring'], returns: 'i32' } });",
  "src/platform/unix-gl-symbol": "import { dlopen } from 'bun:ffi'; export const value = dlopen('libc.so.6', { glGetError: { args: [], returns: 'u32' } });",
  "tools/safe-orchestration": "export const value = Bun.spawnSync(['bun', 'run', 'typecheck']);",
  "tests/safe-oracle": "import { execFileSync } from 'node:child_process'; export const value = execFileSync('/tmp/native-reference');",
  "tests/data-alias": "export const data = process.env['QUAKE_DATA_PATH'];",
  "tests/legacy-data-alias": "export const data = process.env['QUAKE3_DATA'];",
  "tests/gl-alias": "export const gl = process.env['Q3_GL_TEST'];",
  "tests/sdl-gl-alias": "export const gl = process.env['QUAKE_SDL_TEST_GL'];",
  "tests/safe-environment": "export const data = process.env['Q3_DATA']; export const gl = process.env['QUAKE_GL_TEST'];",
  "src/safe-domain-method": "export const state = { spawn: (name: string) => name, dlopen: 1 }; export const name = state.spawn('player');",
};
const results = new Map<string, readonly PolicyDiagnostic[]>();

beforeAll(async () => {
  const external = join(temporary, "external.d.ts");
  await Bun.write(external, "export declare const raw: any; export declare const array: any[]; export declare const promise: Promise<any>; export declare const map: Map<string, any>; export declare const record: Record<string, any>; export declare function incoming(): any;");
  const paths = await Promise.all(Object.entries(fixtures).map(async ([name, source]) => {
    const path = join(temporary, `${name}.ts`);
    await Bun.write(path, source);
    return path;
  }));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    moduleDetection: ts.ModuleDetectionKind.Force,
    strict: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    types: ["bun"],
    typeRoots: [join(root, "node_modules/@types")],
    paths: { typescript: [join(root, "node_modules/typescript/lib/typescript.d.ts")] },
    noEmit: true,
  };
  const program = ts.createProgram([...paths, external], options);
  const diagnostics = auditProgram(program, paths, temporary);
  for (const name of Object.keys(fixtures)) results.set(name, diagnostics.filter((diagnostic) => diagnostic.file === join(temporary, `${name}.ts`)));
}, 20_000);

afterAll(() => { rmSync(temporary, { recursive: true, force: true }); });

function diagnosticsFor(name: string): readonly PolicyDiagnostic[] {
  const found = results.get(name);
  if (found === undefined) throw new Error(`Missing policy fixture ${name}`);
  return found;
}

describe("TypeScript policy", () => {
  const rules: Readonly<Record<string, string>> = {
    "explicit-any": "explicit-any", "as-cast": "assertion", "const-cast": "assertion", "angle-cast": "assertion",
    "non-null": "non-null", "definite-property": "definite-assignment", "definite-variable": "definite-assignment",
    ignore: "suppression", "expect-error": "suppression", nocheck: "suppression", ambient: "ambient",
    inferred: "unsafe-any", parameter: "unsafe-any", "typed-initializer": "unsafe-assignment",
    "typed-assignment": "unsafe-assignment", property: "unsafe-any", "nested-object": "unsafe-any",
    promise: "unsafe-any", "external-assignment": "unsafe-assignment", "external-argument": "unsafe-argument",
    "async-void-variable": "async-void", "async-void-argument": "async-void", "async-void-property": "async-void",
    "async-void-method": "async-void", "async-void-alias": "async-void", "async-void-assignment": "async-void",
    "async-void-return": "async-void", "async-void-array": "async-void", "async-void-class": "async-void",
    "async-void-extends": "async-void", "async-void-thenable": "async-void", "async-void-union-result": "async-void",
    "async-void-overload": "async-void", "async-void-optional-overload": "async-void", "async-void-rest-overload": "async-void",
    "external-return": "unsafe-return", "external-array": "unsafe-any", "external-call": "unsafe-any",
    "external-promise": "unsafe-any", "external-map": "unsafe-any", "external-record": "unsafe-any", eval: "dynamic-implementation", "function-constructor": "dynamic-implementation",
    "computed-function": "dynamic-implementation", wasm: "dynamic-implementation", "ffi-import": "ffi-boundary",
    "ffi-dynamic": "ffi-boundary", "ffi-cc": "native-implementation", "ffi-namespace": "native-implementation",
    "ffi-computed": "native-implementation",
    "src/native-addon": "native-implementation", "src/native-library": "native-implementation",
    "src/native-library-alias": "native-implementation", "src/opaque-import": "runtime-boundary",
    "src/create-require": "native-loader", "src/commonjs": "native-loader", "src/process-dlopen": "native-loader",
    "src/process-dlopen-alias": "native-loader", "src/process-dlopen-computed": "native-loader", "src/builtin-loader": "native-loader",
    "src/child-process": "runtime-subprocess", "src/child-process-dynamic": "runtime-subprocess", "src/child-process-reexport": "runtime-subprocess",
    "src/bun-spawn": "runtime-subprocess", "src/bun-spawn-computed": "runtime-subprocess", "src/bun-spawn-destructure": "runtime-subprocess",
    "src/bun-spawn-alias": "runtime-subprocess", "src/bun-shell": "runtime-subprocess", "src/execve": "runtime-subprocess",
    "src/tool-bridge": "runtime-boundary", "src/helper-bridge": "runtime-boundary", "src/generated-bridge": "runtime-boundary",
    "src/platform/native-ffi": "ffi-library", "src/platform/native-symbol": "ffi-symbol", "src/platform/ffi-alias": "ffi-binding",
    "src/platform/ffi-opaque": "ffi-symbol", "src/platform/ffi-linked-native": "ffi-symbol",
    "src/platform/ffi-reexport": "ffi-binding", "src/ffi-indirect": "ffi-boundary",
    "src/platform/unix-shell": "ffi-symbol", "src/platform/unix-gl-symbol": "ffi-symbol",
    "tests/data-alias": "test-environment", "tests/legacy-data-alias": "test-environment",
    "tests/gl-alias": "test-environment", "tests/sdl-gl-alias": "test-environment",
  };
  for (const [name, rule] of Object.entries(rules)) {
    test(`rejects ${name}`, () => { expect(diagnosticsFor(name).some((diagnostic) => diagnostic.rule === rule)).toBe(true); });
  }
  for (const name of Object.keys(fixtures).filter((name) => name.startsWith("safe") || name.includes("/safe-"))) {
    test(`accepts ${name}`, () => { expect(diagnosticsFor(name)).toEqual([]); });
  }
  test("reports exact source location and rule", () => {
    expect(diagnosticsFor("explicit-any")).toContainEqual({
      file: join(temporary, "explicit-any.ts"), line: 1, column: 21, rule: "explicit-any",
      message: "Explicit any is forbidden; narrow unknown at the boundary.",
    });
  });
  test("audits ambient files only when they belong to the project", async () => {
    const declaration = join(temporary, "project.d.ts");
    await Bun.write(declaration, "export interface HiddenImplementation { run(): void; }");
    const program = ts.createProgram([declaration], { strict: true, types: [] });
    expect(auditProgram(program, [declaration]).some((diagnostic) => diagnostic.rule === "ambient")).toBe(true);
  });
  test("CLI checks source beyond tsconfig and rejects other implementation languages", async () => {
    const project = join(temporary, "cli-project");
    const source = join(project, "src/main.ts");
    await Bun.write(source, "export const value: unknown = JSON.parse('{}');");
    await Bun.write(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, types: [], target: "ES2022" }, include: ["src/main.ts"] }));
    const executable = join(root, "tools/type-policy.ts");
    const clean = Bun.spawnSync([process.execPath, executable, project]);
    expect(clean.exitCode).toBe(0);
    expect(clean.stdout.toString()).toBe("TypeScript policy passed.\n");
    await Bun.write(join(project, "tools/outside-config.ts"), "export const wrong = 1 as number;");
    await Bun.write(join(project, "src/native.c"), "int engine(void) { return 0; }");
    await Bun.write(join(project, "src/hidden.js"), "export const hidden = 1;");
    await Bun.write(join(project, "dist/allowed-output.js"), "export const built = 1;");
    await Bun.write(join(project, "node_modules/vendor/index.js"), "module.exports = 1;");
    const diagnostics = auditProject(project);
    expect(diagnostics.filter((diagnostic) => diagnostic.rule === "implementation-language")).toHaveLength(2);
    expect(diagnostics.some((diagnostic) => diagnostic.file === join(project, "tools/outside-config.ts") && diagnostic.rule === "assertion")).toBe(true);
    const dirty = Bun.spawnSync([process.execPath, executable, project]);
    expect(dirty.exitCode).toBe(1);
    expect(dirty.stderr.toString()).toContain("tools/outside-config.ts:1:22 [assertion]");
    expect(dirty.stderr.toString()).toContain("src/native.c:1:1 [implementation-language]");
  }, 20_000);
  test("rejects native artifacts, including disguised binaries and nested output directories", async () => {
    const project = join(temporary, "native-artifacts");
    await Bun.write(join(project, "src/main.ts"), "export const value = 1;");
    await Bun.write(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, types: [] }, include: ["src/**/*.ts"] }));
    const nativeFiles = ["src/engine.node", "src/engine.so", "src/engine.so.2", "src/engine.dll", "src/engine.dylib", "src/engine.o", "artifacts/engine.node", "src/dist/engine.node", "src/.artifacts/engine.node"];
    for (const file of nativeFiles) await Bun.write(join(project, file), "fixture");
    const headers: Readonly<Record<string, readonly number[]>> = {
      "src/engine": [0x7f, 0x45, 0x4c, 0x46],
      "src/library.dat": [0xcf, 0xfa, 0xed, 0xfe],
      "src/windows.dat": [0x4d, 0x5a, 0, 0],
      "src/wasm.dat": [0, 0x61, 0x73, 0x6d],
    };
    for (const [file, header] of Object.entries(headers)) await Bun.write(join(project, file), new Uint8Array(header));
    await Bun.write(join(project, "dist/quake3-ts"), new Uint8Array([0x7f, 0x45, 0x4c, 0x46]));
    await Bun.write(join(project, ".artifacts/reference"), new Uint8Array([0x7f, 0x45, 0x4c, 0x46]));
    const diagnostics = auditProject(project);
    expect(diagnostics).toHaveLength(nativeFiles.length + Object.keys(headers).length);
    for (const file of [...nativeFiles, ...Object.keys(headers)]) {
      expect(diagnostics).toContainEqual({
        file: join(project, file), line: 1, column: 1, rule: "implementation-language",
        message: "Project implementation must be .ts; native sources/binaries, JavaScript, shader and WASM artifacts are forbidden.",
      });
    }
  });
});
