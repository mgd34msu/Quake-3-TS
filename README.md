# Quake III Arena in TypeScript

A TypeScript port of Quake III Arena and Team Arena, based on the Quake III Arena 1.32b source. The engine, gameplay, bots, menus, HUD, audio mixing, and cinematics run directly in TypeScript. Both games use the same runtime with product-specific rules and presentation.

The CPU renderer rasterizes in TypeScript and uses SDL2 to present its framebuffer. The OpenGL renderer submits geometry through SDL2 and the system OpenGL driver. Bun runs the source and builds the executable. Project code uses strict TypeScript without `any`, type assertions, ignored diagnostics, native addons, or a WASM engine.

Playable client and dedicated-server paths are integrated for both games. Source parity and performance work continue. The [current status](docs/STATUS.md), [compatibility profiles](docs/COMPATIBILITY.md), and [parity punch list](docs/PARITY_PUNCH_LIST.md) describe the verified scope and remaining differences. Completed plan gates and source examination do not establish complete original-engine equivalence.

## Requirements

- Linux x86-64 with glibc. Current platform code depends on Linux interfaces.
- Bun 1.3.14 or later for source runs and builds. Bun 1.3.14 is the verified version.
- SDL2, with `libSDL2-2.0.so.0` available to the loader, for the graphical client.
- A system OpenGL driver, normally available through `libGL.so.1`, for `--renderer gl`.
- Your own installed Quake III Arena retail data. Team Arena also requires its expansion data.

Select the installation root that contains the product directories, not `baseq3` itself:

```text
/path/to/Quake3/
├── baseq3/
│   ├── pak0.pk3
│   └── ...
└── missionpack/
    ├── pak0.pk3
    └── ...
```

Keep the original installation's patch packages alongside its `pak0.pk3` files. The port reads the installation directly. Retail assets are not included in this repository or bundled into the executable.

## Build

From the source checkout, install the locked dependencies, including development dependencies, and build:

```sh
bun install --frozen-lockfile
bun run build
```

Do not use `--production` for this install. The build needs the TypeScript compiler and Bun type definitions in `devDependencies`.

The result is `dist/quake3-ts`, with the Bun runtime included. It still needs the platform libraries and retail data described above. Rebuild after source changes to include them in the executable.

The build runs type and policy checks against a captured copy of its inputs, then verifies that the inputs have not changed before publishing the executable. It records source and binary hashes in `dist/build.json`. These build checks do not replace the full test run.

## Run

Create a writable home for configuration, screenshots, demos, and other runtime files. Keep it separate from the retail installation:

```sh
mkdir -p "$HOME/.local/share/quake3-ts"
```

Start Quake III Arena with OpenGL:

```sh
./dist/quake3-ts client --data /path/to/Quake3 --home "$HOME/.local/share/quake3-ts" --product baseq3 --renderer gl -- +map q3dm1
```

Start Team Arena:

```sh
./dist/quake3-ts client --data /path/to/Quake3 --home "$HOME/.local/share/quake3-ts" --product missionpack --renderer gl -- +map mpteam1
```

The `client` subcommand is required. Put engine `+commands` after `--`. Use `+map NAME` to start a match; `--map` is an asset-inspection and render-diagnostic option.

To open the menu without intro videos, replace the `+map` command with `+echo menu`. With both products installed, select **TEAM ARENA** in the base menu to switch games. In Team Arena, select **Quake3**, then **Yes**, to return. Both switch directions have recorded gameplay checks.

To use the TypeScript CPU renderer, replace `--renderer gl` with `--renderer cpu`. Start at `--width 320 --height 240`; CPU rendering remains slow. Current measurements and their limits are described below.

If you place the built executable beside `baseq3`, use `./quake3-ts client --data .` with the same home, product, renderer, and startup options.

To run the source directly, use the same arguments with Bun:

```sh
bun run src/main.ts client --data /path/to/Quake3 --home "$HOME/.local/share/quake3-ts" --product baseq3 --renderer gl -- +map q3dm1
bun run src/main.ts client --data /path/to/Quake3 --home "$HOME/.local/share/quake3-ts" --product missionpack --renderer cpu --width 320 --height 240 -- +map mpteam1
```

`bun start client` is an alias for `bun run src/main.ts client`. Run `bun run src/main.ts client --help` for all client options. You can also set `Q3_DATA` to the installation root instead of passing `--data`.

## Run a dedicated server

Dedicated mode uses retail data but does not initialize SDL video or audio. Give the server its own writable home:

```sh
mkdir -p "$HOME/.local/share/quake3-ts-server"
./dist/quake3-ts server --data /path/to/Quake3 --home "$HOME/.local/share/quake3-ts-server" --product baseq3 -- +set net_ip 127.0.0.1 +map q3dm1 +addbot Sarge 3
```

This example binds to localhost. For Team Arena, select `--product missionpack` and `+map mpteam1`. To run from source, replace `./dist/quake3-ts server` with `bun run src/main.ts server`.

Enter `status`, `map_restart 0`, or `quit` through the console. EOF leaves the server running. Run `bun run src/main.ts server --help` for server options.

## Inspect assets

The `inspect` command reports asset information. The `render` command opens a diagnostic map viewer without match entities, combat, or bots:

```sh
bun start inspect --data /path/to/Quake3 --product baseq3 --map q3dm1
bun start render --data /path/to/Quake3 --product missionpack --map mpteam1 --renderer gl --interactive
```

In the viewer, use WASD, space/C, and left-button mouse drag to move the camera. Escape exits. Add `--walk` to exercise player movement and BSP collision.

## Verify changes

Run the type and policy checks without retail data:

```sh
bun run typecheck
bun run policy
```

Full verification requires both retail products, SDL2, and a working OpenGL driver:

```sh
Q3_DATA=/path/to/Quake3 bun run check
```

The check uses dummy video and audio for its main tests, then SDL's `offscreen` video driver for its GL tests. If your SDL installation lacks `offscreen`, run the GL phase on a private Xvfb display:

```sh
env -u WAYLAND_DISPLAY xvfb-run -a env SDL_VIDEODRIVER=x11 SDL_AUDIODRIVER=dummy Q3_TEST_GL_DRIVER=x11 Q3_DATA=/path/to/Quake3 bun run check
```

`bun run check:portable` omits mandatory retail coverage and the GL phase. It reports incomplete coverage and does not certify a release. Check reports are written to `.artifacts/check.json` and `.artifacts/checks/`. Checks also reject captured-input changes or a final mismatch with the live workspace.

## Performance and compatibility

Use OpenGL for play. CPU rendering remains a known performance limitation. Recorded compiled timedemos at 640×480 measured roughly 9–10 FPS on CPU and 30–40 FPS on OpenGL across the two games. These are measurements from the tested host, with GL on an RTX 5060 Ti. They are short replay measurements that exclude live server, bot, and network work, not expected frame rates for every machine. See the [performance record](docs/RELEASE.md#performance) and [current measurements](docs/STATUS.md) for settings and qualifications.

The project has evidence for menus, product switching, bots, gameplay, protocol-68 networking, demos, and renderer restarts. Original-engine comparisons have declared numeric and platform limits. External-mod compatibility and physical-device behavior also have qualifications. Consult the [compatibility profiles](docs/COMPATIBILITY.md) and [parity punch list](docs/PARITY_PUNCH_LIST.md) before relying on a particular behavior.

The [port plan](PORT_PLAN.md), [architecture](docs/ARCHITECTURE.md), and [source examination](docs/SOURCE_EXAMINATION.md) explain the implementation and source accounting. The [release record](docs/RELEASE.md) identifies tested executable inputs; a built executable can predate later fixes in the source tree.

## License and attribution

Project code is licensed under [GPL-2.0-or-later](LICENSE). See [NOTICE.md](NOTICE.md) for source attribution and additional notices. Retail game assets remain separately licensed and must come from your own installation. This software is based in part on the work of the Independent JPEG Group.
