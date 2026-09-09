# Source examination

At reference commit `dbe4ddb10315479fc00086f08e25d968b4b43c49`, all 997 manifest inputs have examination accounts: 941 source files and 56 build scripts. The exact case-sensitive join has no missing or unmatched paths.

| Inventory category | Examined inputs |
| --- | ---: |
| Core runtime | 287 |
| Replaced platform code | 59 |
| Bundled libraries | 145 |
| Historical tools | 450 |
| Build and packaging scripts | 56 |

[source-examination.tsv](source-examination.tsv) records each reference-relative path and its examination accounts. It is separate from [source-inventory.json](source-inventory.json), whose target mappings and implementation statuses are unchanged by examination. Account paths point to local evidence outside the project, not shipping dependencies.

The examiners covered function bodies, declarations, globals and conditional branches. Byte-identical files reuse explicitly identified prior reads; differing counterparts include complete differing-hunk review. JPEG accounts disclose omitted block comments, and some Radiant accounts omit repeated license boilerplate and blank lines. The lead reconciled these accounts; this is not a claim that the lead independently reread every file.

The private reconciliation is `/tmp/q3-examination-reconcile-YhHrge/REPORT.md`, reproducible with `bun /tmp/q3-examination-reconcile-YhHrge/reconcile.ts`. The final missing accounts were macOS's 20 files, `code/ui/ui_players.c` and `code/game/g_bot.c`.

Examination does not establish functional parity. Defined omissions discovered during review remain implementation work. Current corrections and gameplay evidence are in [STATUS.md](STATUS.md). Historical compilers, map tools and the editor were examined but are not ported applications. SDL2/Bun replace obsolete native platform implementations. Unselected DEBUG, FreeType, prerelease-demo and legacy hardware branches remain explicitly qualified. No original executable, retail VM or supplied asset was copied into the project for this pass.

The September 10 mapping correction links Load Config, System Setup, three syscall ordinal tables and `ui/menudef.h` to their existing owners. Later entries connect the existing RoQ codebook owner and the completed AAS, sun and display-list work. The generator records 305 mapped files across all categories.

## Core implementation accounting

The final per-module reconciliation now classifies all 287 core inputs. No input was promoted to `verified`.

| Disposition | Files | Meaning |
| --- | ---: | --- |
| implemented | 273 | Selected-runtime bodies and declarations have TypeScript owners. Existing whole-file accounts, subsequent corrections and caller evidence support this status. |
| replaced | 5 | The three native VM compiler files use the TypeScript interpreter; `qgl.h` and `qgl_linked.h` use typed system-GL bindings. Native backends and every platform alias are not claimed translated. |
| not-applicable | 9 | Eight explicitly excluded legacy-ranking files and attribution-only `code/ui/ui_util.c` require no translation for the selected runtime. The ranking service is not ported. |

This reconciliation used the per-file accounts already linked in `source-examination.tsv`, then resolved their stale omission notes against current owners. It found and corrected real AAS offset/overlap/header-alias rejection and the dormant particle, sun and display-list bodies. Independent reviews and root's combined 99-case run cover those corrections. The dormant alternatives remain unselected by normal game callers. CPU display-list behavior covers the empty list namespace created by the original renderer, not native lists defined by external GL code.

These statuses retain the selected build, platform replacement and undefined-behavior qualifications in the accounts and `COMPATIBILITY.md`. They are not an overall code-completion percentage, a claim that historical tools were ported, or M9/M19 parity and release acceptance. Non-core categories are unchanged. The exact pre-promotion inventory and one-time reconciliation are in `/tmp/quake3-functional-join-qHlpx2/`; independent comparison confirms only the intended core status/evidence changes. The regular inventory generator preserves these dispositions.
