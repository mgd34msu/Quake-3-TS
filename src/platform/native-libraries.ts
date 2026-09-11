// SPDX-License-Identifier: GPL-2.0-or-later
// SDL2 and FreeType replace the original platform/library bindings.
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

type NativeLibrary = "sdl2" | "freetype";

export interface NativeLibraryOptions {
  readonly platform?: string;
  readonly execPath?: string;
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** Ordered loader inputs, not evidence that a library exists or can be loaded. */
export function nativeLibraryCandidates(kind: NativeLibrary, options: NativeLibraryOptions = {}): readonly string[] {
  const environment = options.environment ?? process.env;
  const variable = kind === "sdl2" ? "QUAKE_SDL2_LIBRARY" : "QUAKE_FREETYPE_LIBRARY";
  const override = environment[variable];
  if (override !== undefined) {
    if (override.length === 0 || override.includes("\0")) throw new Error(`${variable} must be nonempty and contain no NUL`);
    return [override];
  }
  const platform = options.platform ?? process.platform;
  const paths = platform === "win32" ? win32 : posix;
  const executableDirectory = paths.dirname(options.execPath ?? process.execPath);
  let names: readonly string[];
  const installed: string[] = [];
  switch (platform) {
    case "linux":
      names = kind === "sdl2" ? ["libSDL2-2.0.so.0", "libSDL2.so"] : ["libfreetype.so.6", "libfreetype.so"];
      break;
    case "win32":
      names = kind === "sdl2" ? ["SDL2.dll"] : ["freetype.dll", "libfreetype-6.dll", "freetype6.dll"];
      break;
    case "darwin":
      names = kind === "sdl2" ? ["libSDL2-2.0.0.dylib", "libSDL2.dylib"] : ["libfreetype.6.dylib", "libfreetype.dylib"];
      for (const directory of ["/opt/homebrew/lib", "/usr/local/lib"]) {
        for (const name of names) installed.push(posix.join(directory, name));
      }
      if (kind === "sdl2") {
        for (const directory of [executableDirectory, posix.join(options.homeDirectory ?? homedir(), "Library/Frameworks"), "/Library/Frameworks"])
          installed.push(posix.join(directory, "SDL2.framework/SDL2"));
      }
      break;
    default: throw new Error(`Native ${kind} libraries are unsupported on ${platform}`);
  }
  return [...names.map(name => paths.join(executableDirectory, name)), ...installed, ...names];
}

/** Keep the concrete FFI descriptor at the caller so Bun retains its exact types. */
export function openNativeLibrary<T>(kind: NativeLibrary, open: (path: string) => T, options: NativeLibraryOptions = {}): T {
  const candidates = nativeLibraryCandidates(kind, options);
  const failures: unknown[] = [];
  for (const candidate of candidates) {
    try { return open(candidate); }
    catch (error) { failures.push(new Error(`${candidate}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
  }
  throw new AggregateError(failures, `Could not load ${kind}; attempted ${candidates.join(", ")}`);
}

export function defaultOpenGlDriver(platform: string = process.platform): string {
  switch (platform) {
    case "linux": return "libGL.so.1";
    case "darwin": return "/System/Library/Frameworks/OpenGL.framework/Libraries/libGL.dylib";
    case "win32": return "opengl32.dll";
    default: throw new Error(`OpenGL is unsupported on ${platform}`);
  }
}
