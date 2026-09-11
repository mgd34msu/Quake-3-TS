import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { auditProgram } from "../tools/type-policy.ts";
import type { PolicyDiagnostic } from "../tools/type-policy.ts";

interface Fixture {
  readonly name: string;
  readonly path: string;
  readonly code: string;
  readonly rule: string | null;
}

const root = resolve(import.meta.dir, "..");
const temporary = mkdtempSync(join(tmpdir(), "quake3-portable-ffi-policy-"));
const ffi = "import { dlopen, linkSymbols } from 'bun:ffi';\n";
const helper = "import { openNativeLibrary } from './native-libraries.ts';\n";
const sdl = "{ SDL_GetTicks: { args: [], returns: 'u32' } }";
const freetype = "{ FT_Init_FreeType: { args: ['buffer'], returns: 'i32' } }";
const darwin = "'/usr/lib/libSystem.B.dylib'";
const unixLibraries = `process.platform === 'darwin' ? ${darwin} : 'libc.so.6'`;
const exitLibraries = `process.platform === 'win32' ? 'ucrtbase.dll' : ${unixLibraries}`;
const memoryLibraries = `process.platform === 'win32' ? 'msvcrt.dll' : ${unixLibraries}`;
const sdlCall = `openNativeLibrary('sdl2', path => dlopen(path, ${sdl}))`;
const fixtures: Fixture[] = [];

function fixture(name: string, path: string, code: string, rule: string | null): void {
  fixtures.push({ name, path, code: ffi + code, rule });
}

for (const path of ["sdl.ts", "audio.ts", "sdl-render-context.ts"]) {
  fixture(`helper-${path}`, `src/platform/${path}`, `${helper}export const library = ${sdlCall};`, null);
}
fixture("helper-freetype", "src/platform/freetype.ts", `${helper}export const library = openNativeLibrary('freetype', path => dlopen(path, ${freetype}));`, null);
fixture("unix-terminal", "src/platform/unix-io.ts", `export const library = dlopen(${unixLibraries}, { tcgetattr: { args: ['i32', 'buffer'], returns: 'i32' }, tcsetattr: { args: ['i32', 'i32', 'buffer'], returns: 'i32' }, sigaction: { args: ['i32', 'buffer', 'buffer'], returns: 'i32' } });`, null);
fixture("all-platform-exit", "src/platform/unix-io.ts", `export const library = dlopen(${exitLibraries}, { _exit: { args: ['i32'], returns: 'void' } });`, null);
fixture("unix-calendar", "src/platform/local-time.ts", `export const library = dlopen(${unixLibraries}, { localtime_r: { args: ['buffer', 'buffer'], returns: 'ptr' }, tzset: { args: [], returns: 'void' } });`, null);
fixture("windows-calendar", "src/platform/local-time.ts", "export const library = dlopen('ucrtbase.dll', { _localtime64_s: { args: ['buffer', 'buffer'], returns: 'i32' }, _tzset: { args: [], returns: 'void' }, _putenv_s: { args: ['cstring', 'cstring'], returns: 'i32' } });", null);
fixture("all-platform-memory", "src/platform/freetype.ts", `export const library = dlopen(${memoryLibraries}, { memcpy: { args: ['buffer', 'u64', 'u64'], returns: 'ptr' } });`, null);

const services: readonly { readonly library: string; readonly path: string; readonly symbols: readonly string[] }[] = [
  { library: darwin, path: "src/platform/file-posix.ts", symbols: ["__openat_nocancel", "__fcntl_nocancel", "__error", "lseek", "mkdirat", "renameat", "linkat", "unlinkat", "fstatat", "fstatat$INODE64"] },
  { library: "'kernel32.dll'", path: "src/platform/file-windows.ts", symbols: ["GetModuleHandleW", "GetProcAddress", "GetFinalPathNameByHandleW", "GetLastError", "GetCurrentProcess", "DuplicateHandle"] },
  { library: "'ntdll.dll'", path: "src/platform/file-windows.ts", symbols: ["NtCreateFile", "NtQueryInformationFile", "NtSetInformationFile", "NtClose", "RtlNtStatusToDosError"] },
];
for (const service of services) {
  // These fixtures check the symbol policy; the adapter tests check actual ABI descriptors.
  const descriptors = service.symbols.map(symbol => `${symbol}: { args: [], returns: 'void' }`).join(", ");
  fixture(`files-${service.library}`, service.path, `export const library = dlopen(${service.library}, { ${descriptors} });`, null);
  fixture(`wrong-owner-${service.library}`, "src/platform/other.ts", `export const library = dlopen(${service.library}, { ${descriptors} });`, "ffi-library");
}
fixture("bun-file-handles", "src/platform/file-windows.ts", "export const library = linkSymbols({ uv_get_osfhandle: { args: ['i32'], returns: 'i64', ptr: 1 }, uv_open_osfhandle: { args: ['i64'], returns: 'i32', ptr: 1 }, uv_translate_sys_error: { args: ['i32'], returns: 'i32', ptr: 1 }, uv_err_name: { args: ['i32'], returns: 'cstring', ptr: 1 } });", null);

fixture("arbitrary-path", "src/platform/sdl.ts", `const path = 'libSDL2.so'; export const library = dlopen(path, ${sdl});`, "ffi-library");
fixture("local-helper", "src/platform/sdl.ts", `function openNativeLibrary<T>(_kind: string, open: (path: string) => T): T { return open('engine.so'); } export const library = ${sdlCall};`, "ffi-library");
fixture("other-helper-module", "src/platform/sdl.ts", `import { openNativeLibrary } from './other.ts'; export const library = ${sdlCall};`, "ffi-library");
fixture("renamed-helper-import", "src/platform/sdl.ts", `import { openNativeLibrary as load } from './native-libraries.ts'; export const library = load('sdl2', path => dlopen(path, ${sdl}));`, "ffi-library");
fixture("helper-call-alias", "src/platform/sdl.ts", `${helper}const load = openNativeLibrary; export const library = load('sdl2', path => dlopen(path, ${sdl}));`, "ffi-library");
fixture("helper-namespace", "src/platform/sdl.ts", `import * as native from './native-libraries.ts'; export const library = native.openNativeLibrary('sdl2', path => dlopen(path, ${sdl}));`, "ffi-library");
fixture("helper-wrong-owner", "src/platform/other.ts", `${helper}export const library = ${sdlCall};`, "ffi-library");
fixture("helper-wrong-kind", "src/platform/sdl.ts", `${helper}export const library = openNativeLibrary('freetype', path => dlopen(path, ${freetype}));`, "ffi-library");
fixture("helper-dynamic-kind", "src/platform/sdl.ts", `${helper}const kind = 'sdl2'; export const library = openNativeLibrary(kind, path => dlopen(path, ${sdl}));`, "ffi-library");
fixture("helper-options-override", "src/platform/sdl.ts", `${helper}export const library = openNativeLibrary('sdl2', path => dlopen(path, ${sdl}), { environment: { QUAKE_SDL2_LIBRARY: 'engine.so' } });`, "ffi-library");
fixture("helper-parameter-changed", "src/platform/sdl.ts", `${helper}export const library = openNativeLibrary('sdl2', path => { path = 'engine.so'; return dlopen(path, ${sdl}); });`, "ffi-library");
fixture("helper-wrong-parameter", "src/platform/sdl.ts", `${helper}const wrong = 'engine.so'; export const library = openNativeLibrary('sdl2', path => dlopen(wrong, ${sdl}));`, "ffi-library");
fixture("helper-shadowed-parameter", "src/platform/sdl.ts", `${helper}export const library = openNativeLibrary('sdl2', path => ((path: string) => dlopen(path, ${sdl}))('engine.so'));`, "ffi-library");
fixture("helper-path-expression", "src/platform/sdl.ts", `${helper}export const library = openNativeLibrary('sdl2', path => dlopen(path + '.so', ${sdl}));`, "ffi-library");
fixture("helper-stored-callback", "src/platform/sdl.ts", `${helper}const open = (path: string) => dlopen(path, ${sdl}); export const library = openNativeLibrary('sdl2', open);`, "ffi-library");
fixture("helper-ffi-alias", "src/platform/sdl.ts", `${helper}const load = dlopen; export const library = openNativeLibrary('sdl2', path => load(path, ${sdl}));`, "ffi-binding");
fixture("helper-opaque-descriptors", "src/platform/sdl.ts", `${helper}const descriptors = {}; export const library = openNativeLibrary('sdl2', path => dlopen(path, descriptors));`, "ffi-symbol");
fixture("helper-opaque-symbol", "src/platform/sdl.ts", `${helper}const descriptor = {}; export const library = openNativeLibrary('sdl2', path => dlopen(path, { SDL_GetTicks: descriptor }));`, "ffi-symbol");
fixture("helper-descriptor-spread", "src/platform/sdl.ts", `${helper}export const library = openNativeLibrary('sdl2', path => dlopen(path, { SDL_GetTicks: { ...{ args: [], returns: 'u32' } } }));`, "ffi-symbol");
fixture("helper-pointer-override", "src/platform/sdl.ts", `${helper}export const library = openNativeLibrary('sdl2', path => dlopen(path, { SDL_GetTicks: { args: [], returns: 'u32', ptr: 1 } }));`, "ffi-symbol");
fixture("helper-native-loader", "src/platform/sdl.ts", `${helper}export const library = openNativeLibrary('sdl2', path => dlopen(path, { SDL_LoadObject: { args: ['cstring'], returns: 'ptr' } }));`, "ffi-symbol");
fixture("helper-wrong-api", "src/platform/sdl.ts", `${helper}export const library = openNativeLibrary('sdl2', path => dlopen(path, ${freetype}));`, "ffi-symbol");
fixture("helper-outside-platform", "tests/sdl.ts", `import { openNativeLibrary } from '../src/platform/native-libraries.ts'; export const library = ${sdlCall};`, "ffi-boundary");
fixture("project-native-library", "src/platform/file-windows.ts", "export const library = dlopen('./engine.dll', { NtClose: { args: ['ptr'], returns: 'i32' } });", "ffi-library");
fixture("conditional-project-library", "src/platform/unix-io.ts", "export const library = dlopen(process.platform === 'linux' ? 'libc.so.6' : './engine.so', { _exit: { args: ['i32'], returns: 'void' } });", "ffi-library");
fixture("conditional-wrong-api", "src/platform/unix-io.ts", `export const library = dlopen(${exitLibraries}, { sigaction: { args: ['i32', 'buffer', 'buffer'], returns: 'i32' } });`, "ffi-symbol");
fixture("darwin-shell", "src/platform/unix-io.ts", `export const library = dlopen(${darwin}, { system: { args: ['cstring'], returns: 'i32' } });`, "ffi-symbol");
fixture("darwin-wrong-service", "src/platform/local-time.ts", `export const library = dlopen(${darwin}, { tcgetattr: { args: ['i32', 'buffer'], returns: 'i32' } });`, "ffi-symbol");
fixture("windows-shell", "src/platform/local-time.ts", "export const library = dlopen('ucrtbase.dll', { system: { args: ['cstring'], returns: 'i32' } });", "ffi-symbol");
fixture("windows-native-load", "src/platform/file-windows.ts", "export const library = dlopen('kernel32.dll', { LoadLibraryW: { args: ['ptr'], returns: 'ptr' } });", "ffi-symbol");
fixture("windows-mismatched-library", "src/platform/file-windows.ts", "export const library = dlopen('ntdll.dll', { GetProcAddress: { args: ['ptr', 'cstring'], returns: 'ptr' } });", "ffi-symbol");
fixture("bun-file-wrong-owner", "src/platform/sdl.ts", "export const library = linkSymbols({ uv_get_osfhandle: { args: ['i32'], returns: 'i64', ptr: 1 } });", "ffi-symbol");
fixture("bun-file-wrong-symbol", "src/platform/file-windows.ts", "export const library = linkSymbols({ uv_dlopen: { args: ['cstring', 'ptr'], returns: 'i32', ptr: 1 } });", "ffi-symbol");

const results = new Map<string, readonly PolicyDiagnostic[]>();
beforeAll(async () => {
  const helperSource = readFileSync(join(root, "src/platform/native-libraries.ts"), "utf8");
  const paths = await Promise.all(fixtures.map(async value => {
    const directory = join(temporary, value.name.replaceAll(/[^a-zA-Z0-9-]/g, "_"));
    const path = join(directory, value.path);
    await Bun.write(path, value.code);
    await Bun.write(join(directory, "src/platform/native-libraries.ts"), helperSource);
    await Bun.write(join(directory, "src/platform/other.ts"), value.path === "src/platform/other.ts" ? value.code : helperSource);
    return { directory, path, fixture: value };
  }));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, moduleDetection: ts.ModuleDetectionKind.Force,
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    skipLibCheck: true, allowImportingTsExtensions: true, noEmit: true,
    types: ["bun"], typeRoots: [join(root, "node_modules/@types")],
  };
  const program = ts.createProgram(paths.map(value => value.path), options);
  for (const value of paths) results.set(value.fixture.name, auditProgram(program, [value.path], value.directory));
}, 20_000);

afterAll(() => { rmSync(temporary, { recursive: true, force: true }); });

describe("portable FFI policy", () => {
  for (const value of fixtures) test(value.name, () => {
    const diagnostics = results.get(value.name);
    if (diagnostics === undefined) throw new Error(`Missing fixture ${value.name}`);
    if (value.rule === null) expect(diagnostics).toEqual([]);
    else expect(diagnostics.some(diagnostic => diagnostic.rule === value.rule)).toBe(true);
  });
});
