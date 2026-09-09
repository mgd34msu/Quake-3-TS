# Quake 3 TypeScript port

Read PORT_PLAN.md, docs/ARCHITECTURE.md, and .agents/skills/port-unit/SKILL.md before implementation.

All project code is TypeScript. No any, casts including const assertions, non-null or definite-assignment assertions, ignored diagnostics, JavaScript implementation, native project code, embedded C, or WASM. Bun runs and compiles the project. SDL2 and system OpenGL provide platform services. CPU rasterization and all gameplay are TypeScript.

Preserve source behavior and attribution. The source references and installed retail assets are recorded in docs/GROUNDING.md. Do not modify reference trees, supplied archives, or retail data. Do not copy retail assets into the project.

Use a soft cap of 25 active agents excluding the lead. Immediately before each individual launch or reactivation, announce the agent's name, model, effort, and exact task. A grouped future-work announcement does not replace that per-agent announcement. Tailor smaller-model or lower-effort assignments with narrow scope, exact contracts and concrete validation cases. Workers have exclusive files, do not weaken shared settings, and do not commit. The lead owns integration and final verification.

While implementation is active, fill available agent capacity whenever independent, unblocked work exists. Start those workers immediately instead of leaving runnable work queued below the soft cap. Refill capacity when workers finish. Split file ownership to enable parallel work without overlapping writes. Do not invent unnecessary work merely to fill slots.

Until the user changes this instruction, use GPT-6 Astra only for agents. Choose effort to match the task and announce it. Astra Low replaces the former Luna Max option; give lower-effort tasks narrow scope, exact inputs and concrete validation cases, and review their output.

Do not use the user's physical output or input devices for verification without explicit permission. Run graphical checks on a private virtual display, never the user's desktop. For Xvfb checks, explicitly set SDL_VIDEODRIVER=x11, set DISPLAY to the exact owned virtual display, and clear WAYLAND_DISPLAY in the child environment. DISPLAY alone does not isolate SDL from the user's Wayland desktop. Disable game sound and use SDL dummy audio for device-boundary checks. Do not open desktop windows, change display modes, capture input, or change system volume. Close only processes and virtual displays that you know you started. Run long commands in nonblocking background tool sessions, not foreground terminals.

Implementation continues through user feedback unless the user explicitly stops or replaces the task. Do not report a partial milestone as a full port. Keep source accounting and the worklist honest.
