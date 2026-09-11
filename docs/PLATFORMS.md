# Platform requirements

Release archives contain the Bun runtime and the TypeScript game. SDL2, OpenGL, optional FreeType, and retail game data remain external. Dedicated servers do not initialize SDL video or audio.

## Release targets

| Archive suffix | Operating system | CPU |
| --- | --- | --- |
| `linux-x64.zip` | Linux with glibc | x86-64 |
| `linux-arm64.zip` | Linux with glibc | ARM64 |
| `darwin-x64.zip` | macOS | Intel x86-64 |
| `darwin-arm64.zip` | macOS | Apple Silicon |
| `windows-x64.zip` | Windows | x86-64 |

The Linux builds do not target musl/Alpine. Windows ARM64 is not a release target. The x86-64 executables use Bun's baseline builds, which require SSE4.2 but not AVX2. Use libraries matching the executable's architecture; a 32-bit SDL2 DLL cannot load in the Windows x64 executable.

The release notes record which targets passed native service checks and which ran retail gameplay. A successful cross-compilation does not establish that an executable runs on its target. Linux x64 has retail gameplay evidence for both games and both renderers. Foreign-host service checks do not establish equivalent gameplay coverage.

## Linux

The graphical client loads `libSDL2-2.0.so.0`; OpenGL normally loads `libGL.so.1`. Font generation optionally uses `libfreetype.so.6`.

On Debian or Ubuntu:

```sh
sudo apt install libsdl2-2.0-0 libgl1 libfreetype6
```

On Arch Linux:

```sh
sudo pacman -S sdl2-compat freetype2
```

Your graphics driver supplies OpenGL. The TypeScript CPU renderer does not require OpenGL but still uses SDL2 to present frames.

## macOS

Install matching-architecture libraries with Homebrew:

```sh
brew install sdl2 freetype
```

The loader checks both `/opt/homebrew/lib` and `/usr/local/lib`, executable-adjacent dylibs, and system loader paths. SDL2 frameworks beside the executable, in `~/Library/Frameworks`, and in `/Library/Frameworks` are also recognized. OpenGL comes from the system framework.

Executables are unsigned and not notarized. After verifying a downloaded archive's checksum, use macOS's normal security controls to allow an application you trust. A Gatekeeper refusal is separate from an engine error.

OpenGL runs on the main thread. Requesting `r_smp 1` uses the existing serial fallback on macOS because Cocoa's worker-context updates require main-thread event dispatch. CPU rendering workers remain separate from that restriction.

## Windows

Download the x64 SDL2 runtime from [SDL2 releases](https://github.com/libsdl-org/SDL/releases). Place `SDL2.dll` beside `quake3-ts.exe`. SDL3 is not a substitute. Install your graphics vendor's driver for OpenGL support.

FreeType is optional. Matching `freetype.dll`, `libfreetype-6.dll`, or `freetype6.dll` files can be placed beside the executable. Their own dependencies must also be available. Retail prebuilt font files remain usable without FreeType.

Use the PowerShell commands in the [README](../README.md#download). Keep the writable `--home` directory outside your retail installation. Windows filenames use Unicode; source-byte filenames map to the corresponding Unicode characters rather than invalid UTF-8 filesystem names.

## Library overrides

`QUAKE_SDL2_LIBRARY` and `QUAKE_FREETYPE_LIBRARY` select explicit native-library paths. An SDL2 override replaces the search list; an invalid override reports a loading failure instead of silently selecting a different library. FreeType failure leaves font generation unavailable, while prebuilt fonts remain usable.

The graphical client searches beside its executable before standard installation locations. Raw source runs use the Bun executable's directory for this search. Use an override when your libraries are elsewhere.

## Current qualifications

CPU rendering remains slow; start at 320×240 and prefer OpenGL for play. Native MIDI input currently uses Linux ALSA and is disabled by default. Physical audio latency, controllers, display gamma, and every target's graphics driver are not certified by headless checks.

The [compatibility profiles](COMPATIBILITY.md) describe remaining source and rendering differences. Runtime platform support does not imply that historical editors, compilers, proprietary services, or every optional source build are included.
