# Reference inventory

The destination began with `Quake-III-Arena.bundle` and `quake3-1.32b-source.zip`, with no Git repository or implementation.

The reference checkout at `/home/buzzkill/Projects/qsrc/quake-iii-arena` is at `dbe4ddb10315479fc00086f08e25d968b4b43c49`, matching the bundle's master and HEAD. Read reference code there. Preserve the supplied archives. The zip is the 1.32b source release.

Retail data roots verified on this machine:

- `/home/buzzkill/Projects/qfiles/q3a`, containing `baseq3/pak0.pk3` through `pak8.pk3` and `missionpack/pak0.pk3`.
- `/home/buzzkill/.local/share/Steam/steamapps/common/Quake 3 Arena`, containing the same archive names. Their content equality has not yet been checked.

No retail assets belong in source control or compiled executables. Runtime reads a selected local installation.

The runtime is Bun 1.3.14 on Linux. `libSDL2-2.0.so.0` and `libGL.so.1`, their development headers, Xvfb, and an active display are installed. Native libraries provide platform and GL services. All project implementation and tooling must be TypeScript, including CPU rasterization. No C bridge, engine library, WebAssembly engine, or QVM game code may substitute for the TypeScript port.

The original renderer uses OpenGL. CPU rendering is a new implementation of the same scene and material behavior. BSP is version 46 with 17 lumps; MD3 is version 15. Source declarations live in `code/qcommon/qfiles.h`.

The core source modules include qcommon, client, server, renderer, game, cgame, botlib, the base game's q3_ui, and Team Arena's ui. The original tools, compiler sources, and obsolete platform backends are separate from runtime behavior.

The inventory's `buildMembership` records literal build-file references, not the selected preprocessor configuration or reachable calls. Empty target lists must not be mapped to unrelated implementations to improve a coverage ratio. The pinned Unix UI source has these explicit inactive or empty units:

| Source under `code/` | Selected-source disposition |
| --- | --- |
| `q3_ui/ui_loadconfig.c` | Linked at Unix Makefile:1338, but both setup and cache callers are commented out at ui_setup.c:130–132 and ui_atoms.c:989 |
| `q3_ui/ui_options.c` | Linked at Makefile:1344, but UI_SystemConfigMenu has no caller. Active setup invokes UI_GraphicsOptionsMenu directly |
| `q3_ui/ui_login.c`, `ui_rankings.c`, `ui_rankstatus.c`, `ui_signup.c`, `ui_specifyleague.c` | Ranking-service menu cluster omitted from the selected Unix UI build. The only outside ranking entry is commented out at ui_atoms.c:830–834 |
| `q3_ui/ui_spreset.c` | Omitted from the selected build and has no caller. Active single-player reset uses ui_splevel.c:359–379, translated in src/ui/base/sp-level.ts |
| `ui/ui_util.c` | Included at Makefile:1432 but contains only comments and whitespace |
| `game/g_rankings.c`, `game/g_rankings.h`, `server/sv_rankings.c` | Omitted from the selected game/server build with no external ranking callers. Server code requires the absent `rankings/1.0/gr` SDK; this inactive external service is not a runtime port dependency |
| `qcommon/vm_x86.c`, `vm_ppc.c`, `vm_ppc_new.c` | Native machine-code execution is replaced by `src/vm/interpreter.ts`, not translated. Unix Makefile:543–551 selects architecture-specific objects; the Mac project also contains `vm_ppc_new.c` build membership. VM interpreter selection is at vm.c:544–551 |

The base object list starts at Unix Makefile:1324. Base vmMain and UI_ConsoleCommand contain no alternate entry to these inactive menus. Their empty target lists are intentional source accounting, not missing active menu implementations.

Header mappings identify existing implementation owners, not full per-declaration completion. Inlined helpers count at their actual callers; uncalled declarations, DEBUG-only bot diagnostics, inactive utility functions and unused GL aliases do not imply missing shipped behavior. Their coverage stays partial until individually accounted. `ui_util.c` has no runtime body. Native JIT target mappings identify the interpreter replacement, not native compiler implementation.

Platform documentation checked during planning:

- [Bun FFI](https://bun.com/docs/runtime/ffi). It remains experimental. Prove the exact installed runtime with SDL lifecycle and memory tests; newer documentation alone cannot establish compatibility.
- [Bun executables](https://bun.com/docs/bundler/executables). Compilation embeds the runtime; SDL2 and the system GL driver remain external runtime dependencies.
- [SDL2 GL procedure lookup](https://wiki.libsdl.org/SDL2/SDL_GL_GetProcAddress). Resolve GL entry points after creating a context.

Preserve upstream attribution and applicable license notices for translated code. The source release's README lists exceptions in addition to its GPL license; inventory these alongside each translated subsystem.

## Traced runtime flow

`Com_Init`, `code/qcommon/common.c:2351`, creates commands/cvars/filesystem/configuration before server and optional client initialization. `Com_Frame`, `common.c:2635`, drains platform and loopback events, executes commands, advances `SV_Frame`, drains again, then calls `CL_Frame`. `SV_Frame`, `code/server/sv_main.c:751`, preserves a residual accumulator and runs game frames at `sv_fps` intervals. Human movement is command-driven through `SV_ClientThink` and `ClientThink_real`, while bots and synchronous clients use game frames.

`G_InitGame`, `code/game/g_main.c:408`, initializes shared entity/client state, parses entity text and initializes bots. `ClientThink_real`, `g_active.c:756`, passes collision callbacks and state to shared `Pmove`. `Pmove`, `bg_pmove.c:2025`, bounds command backlog and divides it into fixed steps or intervals of at most 66 ms. `G_RunFrame`, `g_main.c:1713`, runs entity behavior, end-frame clients, ranks and match transitions.

Server snapshots use game state plus world visibility. `SV_BuildClientSnapshot`, `code/server/sv_snapshot.c`, builds bounded entity history. Client parsing reconstructs deltas before cgame snapshot transitions. `CG_DrawActiveFrame`, `code/cgame/cg_view.c:761`, consumes snapshots, replays movement for prediction, builds the camera/scene/effects/weapon/HUD and submits audio positions. Associated reliable commands execute before snapshot entity transitions.

`RE_LoadWorldMap`, `code/renderer/tr_bsp.c:1789`, loads shared BSP data into world surfaces, lighting and visibility. `RE_RenderScene`, `tr_scene.c:288`, calls view preparation and surface collection. `RB_StageIteratorGeneric`, `tr_shade.c:1011`, evaluates shader geometry/color/UV stages, then dynamic light/fog passes. A material is indexed by name plus lightmap index. Software rendering must implement equivalent clipping, sampling, depth and blending. `cm_patch.c` builds collision facets independently with a 16-unit curve-error threshold.

Team Arena shares game/cgame through `MISSIONPACK`, and compiles `ui_shared.c` into cgame as well as its menu module. Base menus instead use `q3_ui`. The stat schema in `bg_public.h:205` inserts a persistent-powerup slot only for Team Arena. Item-table indexes are also transmitted and must retain their product-specific order.

Protocol constants in `code/qcommon/qcommon.h` include version 68, a 16,384-byte message bound and 64 reliable-command slots. Compatibility also requires exact Huffman/delta field schemas, float32 bit representations, qport/NAT identity, same-sequence fragment assembly and directional XOR encoding. Packet roundtrip tests alone cannot establish this compatibility.

Original source also exposes MD4 skeletal models, PCX/BMP compatibility, and compressed sound-memory paths beyond the most common retail formats. Inventory those explicitly. `.tga` references fall back to `.jpg`; base pak0 contains more JPEGs than TGAs. RoQ is used both for cinematics and shader videoMap textures.
