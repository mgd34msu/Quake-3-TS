# Design task

Produce an independent architecture for a full Quake III Arena and Team Arena port. All implementation and tools are strict TypeScript executed and compiled by Bun. No explicit or inferred unsafe `any`, casts including `as const`, non-null assertions, suppression comments, native project code, embedded C, or WASM. Existing system SDL2 and OpenGL are permitted platform dependencies. CPU rendering must rasterize in TypeScript. Gameplay must be translated into TypeScript, not delegated to retail QVMs.

Read GROUNDING.md and inspect the relevant original source at `/home/buzzkill/Projects/qsrc/quake-iii-arena`. Original runtime modules total about 233,000 C/header lines. Shared game/cgame have MISSIONPACK branches; base q3_ui and Team Arena ui differ. MISSIONPACK shifts player-state stat indexes. Patch collision has its own subdivision/facet rules and cannot use render triangles. Protocol compatibility includes Huffman/delta packets, fragmentation, qport and XOR encoding. The common frame loop drains events/commands, advances the fixed server, drains loopback events, then updates client input/time/render/audio.

Use the architect runner prompt and rationale template under `/home/buzzkill/.codex/skills/architect/references/`. Output one concise complete Markdown design package to the assigned isolated path. Usage first, typed interfaces and module map, milestone dependency graph, source-to-target accounting, tests and acceptance gates, tradeoffs. Do not create runtime stubs or code yet. No subagents.

Rubric, each 0-4:

1. Full base/missionpack source coverage and explicit completion gates.
2. Type safety that works without casts at FFI, binary parsers, and product variants.
3. Deep modules with small interfaces and clear ownership; avoid shared mutable globals.
4. Shared scene/material semantics with genuine CPU and GL implementations.
5. Ordered, executable validation from assets through deterministic gameplay and networking.

At least two structurally distinct candidates are required before synthesis. Neither a viewer nor a simplified arena game establishes a full port.
