// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { defaultOpenGlDriver, nativeLibraryCandidates, openNativeLibrary } from "../src/platform/native-libraries.ts";
import { SdlWindow } from "../src/platform/sdl.ts";

describe("portable native library loading", () => {
  test("the actual SDL loader rejects an invalid environment override", async () => {
    if (process.env["QUAKE_PORTABLE_SDL_OVERRIDE_CHILD"] === "1") {
      let failure: unknown;
      try { SdlWindow.open({ title: "invalid library", width: 2, height: 2, backend: "cpu", hidden: true }); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error("Expected the native library loader to reject the missing override");
      const errors: unknown = failure.errors;
      if (!Array.isArray(errors)) throw new Error("Expected an array of loader failures");
      expect(errors.length).toBe(1);
      expect(failure.message).toContain("quake3-missing-sdl-library-");
      return;
    }
    const child = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url), "--test-name-pattern", "actual SDL loader"], {
      env: { ...process.env, DISPLAY: undefined, WAYLAND_DISPLAY: undefined, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy",
        QUAKE_PORTABLE_SDL_OVERRIDE_CHILD: "1", QUAKE_SDL2_LIBRARY: `quake3-missing-sdl-library-${crypto.randomUUID()}` },
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(`Native override child failed (${exitCode})\n${stdout}${stderr}`);
    expect(exitCode).toBe(0);
  });

  test("Windows searches DLLs beside the executable before loader search paths", () => {
    const options = { platform: "win32", execPath: "C:\\Games\\Quake 3\\quake3-ts.exe", environment: {} };
    expect(nativeLibraryCandidates("sdl2", options)).toEqual(["C:\\Games\\Quake 3\\SDL2.dll", "SDL2.dll"]);
    expect(nativeLibraryCandidates("freetype", options)).toEqual([
      "C:\\Games\\Quake 3\\freetype.dll", "C:\\Games\\Quake 3\\libfreetype-6.dll", "C:\\Games\\Quake 3\\freetype6.dll",
      "freetype.dll", "libfreetype-6.dll", "freetype6.dll",
    ]);
  });

  test("Darwin resolves both Homebrew prefixes, SDL frameworks and executable siblings", () => {
    const options = { platform: "darwin", execPath: "/Applications/Quake 3/quake3-ts", homeDirectory: "/Users/player", environment: {} };
    const sdl = nativeLibraryCandidates("sdl2", options);
    expect(sdl[0]).toBe("/Applications/Quake 3/libSDL2-2.0.0.dylib");
    for (const path of ["/opt/homebrew/lib/libSDL2-2.0.0.dylib", "/usr/local/lib/libSDL2.dylib",
      "/Applications/Quake 3/SDL2.framework/SDL2", "/Users/player/Library/Frameworks/SDL2.framework/SDL2",
      "/Library/Frameworks/SDL2.framework/SDL2", "libSDL2.dylib"]) expect(sdl).toContain(path);
    const fonts = nativeLibraryCandidates("freetype", options);
    expect(fonts).toContain("/opt/homebrew/lib/libfreetype.6.dylib");
    expect(fonts).toContain("/usr/local/lib/libfreetype.6.dylib");
    expect(fonts.some(path => path.includes("SDL2"))).toBe(false);
  });

  test("both Linux architectures use architecture-neutral system sonames", () => {
    const options = { platform: "linux", execPath: "/games/quake3-ts", environment: {} };
    expect(nativeLibraryCandidates("sdl2", options)).toEqual([
      "/games/libSDL2-2.0.so.0", "/games/libSDL2.so", "libSDL2-2.0.so.0", "libSDL2.so",
    ]);
    expect(nativeLibraryCandidates("freetype", options)).toContain("libfreetype.so.6");
  });

  test("an explicit override is the only attempt and preserves its failure", () => {
    for (const kind of ["sdl2", "freetype"] satisfies readonly ("sdl2" | "freetype")[]) {
      const variable = kind === "sdl2" ? "QUAKE_SDL2_LIBRARY" : "QUAKE_FREETYPE_LIBRARY";
      const options = { environment: { [variable]: "/missing/explicit-library" } };
      const attempted: string[] = [];
      const failure = new Error("loader rejected the override");
      try {
        openNativeLibrary(kind, path => { attempted.push(path); throw failure; }, options);
        throw new Error("Expected library load rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(AggregateError);
        if (!(error instanceof AggregateError)) throw error;
        expect(error.message).toContain("/missing/explicit-library");
        const errors: unknown = error.errors;
        if (!Array.isArray(errors)) throw new Error("Expected an array of loader failures");
        const cause: unknown = errors[0];
        expect(cause).toBeInstanceOf(Error);
        if (!(cause instanceof Error)) throw new Error("Missing loader failure");
        expect(cause.cause).toBe(failure);
      }
      expect(attempted).toEqual(["/missing/explicit-library"]);
      for (const value of ["", "bad\0name"]) {
        expect(() => nativeLibraryCandidates(kind, { environment: { [variable]: value } })).toThrow(variable);
      }
    }
  });

  test("a library is selected only after its concrete loader succeeds", () => {
    const attempted: string[] = [];
    const result = { symbols: { version: 2 } };
    const loaded = openNativeLibrary("sdl2", path => {
      attempted.push(path);
      if (path !== "libSDL2-2.0.so.0") throw new Error("not installed here");
      return result;
    }, { platform: "linux", execPath: "/private/quake3-ts", environment: {} });
    expect(loaded).toBe(result);
    expect(attempted).toEqual(["/private/libSDL2-2.0.so.0", "/private/libSDL2.so", "libSDL2-2.0.so.0"]);
  });

  test("system OpenGL names match each target and unknown targets fail explicitly", () => {
    expect(defaultOpenGlDriver("linux")).toBe("libGL.so.1");
    expect(defaultOpenGlDriver("darwin")).toBe("/System/Library/Frameworks/OpenGL.framework/Libraries/libGL.dylib");
    expect(defaultOpenGlDriver("win32")).toBe("opengl32.dll");
    expect(() => defaultOpenGlDriver("unknown")).toThrow("unsupported");
    expect(() => nativeLibraryCandidates("sdl2", { platform: "unknown", environment: {} })).toThrow("unsupported");
  });
});
