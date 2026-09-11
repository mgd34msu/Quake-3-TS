# Runtime releases

## Current correction build: September 11 01:57 UTC

The main post-plan correction batch is complete in `c608464`; `9e86b40` adds the final obstacle diagnostic, endpoint build overrides and standalone source algorithms. The current Bun 1.3.14 executable is 106,641,536 bytes, built at 01:57:48 UTC (September 10 8:57 PM Chicago); `dist/quake3-ts` and `/home/buzzkill/Projects/qfiles/q3a/quake3-ts` compare equal. Build typing, strict policy and input-consistency checks pass. The final obstacle diagnostic is included. The default master/auth endpoints are embedded and recorded in build metadata.

All four compiled product/backend cases pass with `r_smp=1`: worker startup without fallback, authoritative movement/fire, managed drop recovery, fresh admission, video restart, renewed gameplay and clean exit. Eight normally terminated recordings contain 216 active snapshots. Root inspected decoded results and post-restart screenshots; close-wall views limit scene coverage. Raw product-menu switching also passes in both renderers. These are functional checks, not new FPS or pixel-equivalence measurements.

The executable, build metadata, build log, unchanged runners, recordings, PNGs and decoded results are retained in `.artifacts/releases/2026-09-11-0157/`. The preceding 01:28 and 21:47 builds remain archived. The new ranking and IPX libraries do not provide service/transport integration and are not new playable modes. No retail assets, keys or user configuration were copied into the project. This is a local runtime build, not a GitHub release. Remaining source qualifications and the optional-source list are in [PARITY_PUNCH_LIST.md](PARITY_PUNCH_LIST.md).

## Historical September 10 21:47 build

The 21:47 executable passed the recorded milestone profiles, completing the dependency graph. Later filename discoveries were separate post-plan work, now included in the current build above. The historical 21:47 executable does not contain those corrections. Prior acceptance is not a claim of unrestricted source parity or satisfactory performance.

## Executable

The September 10, 2026, 21:47:20 UTC Bun 1.3.14 build is 104,454,272 bytes. Its dist and qfiles copies compared equal at that checkpoint; both destinations now contain the newer build above. Build typing, TypeScript policy and input-consistency checks passed. Root confirmed production source and tests matched `.artifacts/snapshots/build-FaTr3P/` after the gameplay checks, before subsequent optimization experiments.

`dist/build.json` retains source and executable hashes. `.artifacts/releases/2026-09-10-2147/` preserves this executable, metadata, build log, existing runner, eight gameplay recordings, eight PNGs and their decoded evidence. Previous releases, including 2039, remain intact. No retail assets, installed keys or user configuration were copied into the project.

The new build adds reached serial nearest-mip certification and one dlight UV-only capture call. Matched raw CPU medians improve 4.0–5.1% for Quake 3 and 3.3% for Team Arena, with exact fixed-scene color/depth and unchanged sampled/error behavior. These are raw-client measurements, not new compiled FPS numbers. All four new compiled product/backend cases pass movement/fire, managed drop, fresh admission, video restart, renewed gameplay and normal exit. Their eight recordings contain 216 active snapshots. Root inspected the actual results and post-restart screenshots. CPU captures have nearby obstructing walls and establish only limited scene visibility. Latest compiled timing remains the 20:39 release's measurement, identified in STATUS.md.

## Final runtime check

| Product | Raw CPU | Compiled CPU | Raw GL | Compiled GL |
| --- | --- | --- | --- | --- |
| Quake 3, q3dm1 | Pass | Pass | Pass | Pass |
| Team Arena, mpteam1 | Pass | Pass | Pass | Pass |

The table records the 12:12 release's complete raw/compiled matrix. Each run verifies authoritative movement/fire, normally terminated delta recordings, a deliberate managed drop, fresh admission, `vid_restart`, renewed gameplay and normal exit with empty stderr. Its sixteen recordings contain 432 active snapshots.

All four compiled product/backend cases were repeated successfully on the 20:39 build after the retained optimizations below. The eight new recordings contain 216 active snapshots. Root inspected current logs, decoded recordings and all four compiled post-restart images. Assigned reviewers inspected both images in their cases. CPU endpoints show close wall geometry, weapon/HUD and impacts after longer clock-driven movement, with limited wide-scene coverage. The Team Arena CPU post-restart image is mostly dark close geometry with a visible weapon and complete HUD, not broad scene coverage. Raw/compiled agreement is behavioral: different wall clocks do not establish identical views or framebuffers.

This refresh joins the retained M0–M18 evidence for all modes, source bots, menus/product switching, audio/cinematics, independent network peers, original traces and source examination. It is not a substitute for those earlier gates. All runtime checks used private offscreen displays, dummy audio and isolated PK3-only data/home roots.

The last runtime correction resolves a retired filesystem view captured by server pure verification. Pure checks now resolve the current mount at use time. The focused regression preserves rejection of retired views and invalid packages, while the actual reconnect-time restart now succeeds.

Core source accounting remains 273 implemented selected-profile inputs, five native replacements and nine inapplicable inputs. None is relabelled verified. All 941 source files and 56 build scripts have examination accounts. Historical native tools and platform-specific replacements remain explicitly classified rather than claimed as translated applications.

## Performance

Reviewed optimizations retain identical measured color/depth: CPU draw batching reduces q3dm1 render-pass medians by 13–15%; GL scalar packing reduces its matched medians by 6.70–8.45%. World preparation removes one duplicate Set allocation per view without a frame-speed claim. CPU batching uses more cores and increases user CPU work.

The 12:55 build adds lazy per-event-loop packet scratch, a private CPU schema-entry list, indexed validation of packed GL float arrays, and immediate scalar cvar reads for culling. GL validation improved two matched render-pass medians by 4.11% and 4.39% with identical pixels. The other three changes reduce allocations without isolated FPS claims. Record-traversal and tessellation-copy experiments did not improve frame time and were removed; no extra implementation or tests from them remain.

The 13:26 build shares the existing decoder body between strict public parsing and the fixed worker's native-cloned messages. Only the latter skips descriptor materialization. All value, bounds and storage checks remain. Root's focused run passes six cases and 119 assertions; independent review confirms the validation bodies and scheduling tail are unchanged. One matched q3dm1 render-pass pair improves median 66.418 to 63.384 ms, 4.57%, with identical color and depth bytes. Arbitrary injected worker preloads/listeners are outside this private transport contract; public parser accessor rejection remains unchanged.

The 13:48 build adds four optimizations:

- CPU workers receive only intersecting triangles, with original indices retained for final sampler selection. Empty bands retain their original full job. Independent review found no defect. Two matched pairs improve q3dm1 render-pass medians by 2.61% and 3.21%; transmitted triangle records fall 51.56%, with exact color/depth agreement and unchanged job count.
- GL source-stage validation captures scalar values in the original getter order, removing two temporary arrays per vertex. Both comparisons preserve exact pixels; median gains vary from 1.10% to 8.50%, so no stable effect size is claimed.
- Renderer runtime getters read immediate cvar scalars without allocating snapshots. All guards and live lookups remain. Existing checks pass 35 cases and 383 assertions.
- Exact canonical cvar names use the existing map directly. Other names retain source-byte/NUL/ASCII normalization. Snapshots, retained records and deletion behavior remain unchanged; existing checks pass 36 cases and 185 assertions.

Root reviewed the exact diffs and passed the combined actual CPU/GL selection: 21 cases, 304 assertions. The cvar changes have allocation/lookup evidence, not isolated FPS claims. CPU filtering uses rasterizer-owned plain packets; arbitrary injected nested-getter clone counts are outside that internal contract. It does not change pixel math, row copying or serial failure recovery. Before/candidate files and measurement records are retained under the current release's `optimizations/` directory.

The 14:37 build removes discarded vertex copies from index-only material reads, unused zero-light-mask world snapshots, and empty picture-deformation calls. Nonzero-mask capture timing and nonempty deformation effects remain unchanged. Independent review found no defects. Index-only snapshotting improves matched GL medians 3.53% and 4.36% with exact pixels; the other changes have allocation evidence but no isolated speed claim. Both measured CPU outputs retain exact color/depth. No new tests or project profiling code were added.

Existing index/material checks pass 63 cases/632 assertions with four optional skips; the empty-deformation selection passes 27/211 with three retail skips. The world selection reproduces the same cloud-observer failure before and after the change (10 pass, one fail, 154 assertions); no assertion was weakened. These limits remain separate from the passing compiled gameplay and release checks.

The 15:32 build removes a frozen cvar snapshot from each console poll and an unused viewport object from each CPU triangle packet. Actual viewport projection/clipping and all kernel arithmetic remain unchanged. These are allocation reductions without isolated FPS claims. Existing CPU/math checks pass 47 cases/324 assertions; console/cloud checks pass three/24. The cloud test now observes completed real sky-side draws, fixing the historical observer mismatch above without weakening its six-face or overflow assertions.

Two experiments were removed before this build. Sixteen interleaved CPU tiles improved q3dm1 by 1.96–2.99% but regressed Team Arena's first comparison by 3.06%. Scalar box/plane locals showed no benefit in their first GL comparison. Both preserved measured pixels; neither justified retaining the added code. Source and candidate-only tests were restored. Evidence is retained in this release's `optimizations/` directory.

The 17:00 build adds position/UV-only tessellation snapshots and a worker-only certified nearest-mip decision. Snapshotting improves opposite-order GL render-pass medians by 3.13% and 2.00%. Nearest selection improves base medians by 1.76% and 4.00% and lowers combined CPU work in both games; Team Arena wall-time is mixed. All measured color/depth bytes match. Uncertain numeric decisions retain old math; public/serial sampling is unchanged. Independent reviews are clear, and root's selected CPU checks pass 34 cases/1,248 assertions. COMPATIBILITY.md records the verified Bun/Linux numerical scope. Evidence is `.artifacts/optimizations/2026-09-10-post-1532/`. The GL column-capture and CPU norm-cache experiments were rejected and restored.

The 18:13 build adds a triangle-local nearest-mip cursor, its squared-bound refinement and a sorted-slot bitmap. The cursor improves opposite-order base CPU render-pass medians by 4.46% and 7.48%. Squared bounds avoid another square root on certified hits and improve those medians by a further 1.017% and 1.46%. Team Arena latency is effectively flat. The bitmap improves opposite-order GL medians by 3.74% and 1.29%, with mixed p95. All measured color/depth bytes and work counts match. Independent reviews pass. Root's restored combined selection passes 101 cases/1,843 assertions with four optional skips. Evidence is `.artifacts/optimizations/2026-09-10-post-1700/`. Rejected stage-component and numeric-packet experiments leave no source or test changes. The CLI help now describes integrated gameplay and points to the compatibility and optimization records.

The 19:39 build adds only the six-call-site GL position-validation array removal. The measured hot call's opposite-order medians improve 3.25% and 0.36%, with mixed p95. This is a small allocation reduction, not an isolated FPS claim. Five further equivalent call sites have allocation evidence only. The joined existing selection passes 137 cases and 2,225 assertions. The minimal CPU test repair retains shared buffers and checks parser acceptance before equality; no CPU production candidate remains. Evidence is `.artifacts/optimizations/2026-09-10-post-1813/`.

The preceding 18:13 timedemos ran serially with unchanged executable and runner. Settings are 640×480, picmip 1, no frame cap or swap interval, one warmup and three measured repetitions:

| Product | CPU median FPS | GL median FPS |
| --- | ---: | ---: |
| Quake 3 | 9.8 | 40.4 |
| Team Arena | 8.9 | 29.6 |

These short recorded-client replays include presentation but exclude live server, bots and networking. Both backends use identical per-product recordings. GL is NVIDIA RTX 5060 Ti, driver 610.57.04. Measured repetitions are base CPU 9.8/9.7/10.0, base GL 37.0/40.7/40.4, TA CPU 8.9/9.2/8.6 and TA GL 26.5/30.7/29.6. Logs and exact settings are retained in `.artifacts/releases/2026-09-10-1813/performance/`. Previous 17:00 medians were CPU/GL 9.6/37.9 for Quake 3 and 8.6/27.6 for Team Arena. These sequential measurements do not isolate individual changes. CPU remains too slow, and further optimization is active without reducing resolution or rendering quality.

The 19:39 executable's serial measurements are complete. Quake 3 CPU repetitions are 9.8/9.9/10.2 FPS, median 9.9; GL is 38.1/39.5/38.8, median 38.8. Team Arena CPU is 9.1/9.0/9.0, median 9.0; GL is 27.3/30.7/28.7, median 28.7. Settings, runner, per-product recordings and NVIDIA driver are unchanged from 18:13. All four processes exited zero with empty stderr. Evidence is `.artifacts/releases/2026-09-10-1939/performance/`. This comparison establishes no clear whole-game improvement, and CPU performance remains unfinished.

The 20:39 build adds immediate journal-mode lookup, canonical renderer lookup keys and detached position/UV-only material-stage capture. These reduce allocations/lookups without an isolated FPS claim. Its serial measured repetitions are Quake 3 CPU 9.8/10.0/9.8, GL 39.8/39.6/39.7, Team Arena CPU 9.0/9.3/9.1 and GL 28.6/32.4/30.1. Respective medians are 9.8, 39.7, 9.1 and 30.1 FPS. Settings, recordings, runner and driver are unchanged. All four processes exited zero with empty stderr. Results, logs and runner are in `.artifacts/releases/2026-09-10-2039/performance/`. CPU performance remains unfinished.

## Reproduce build and launch

From the checkout:

```sh
bun install --frozen-lockfile
bun run build
bun start client --data /path/to/Quake3 --home /path/to/private-home --renderer gl -- +map q3dm1
./dist/quake3-ts client --data /path/to/Quake3 --home /path/to/private-home --product missionpack --renderer cpu -- +map mpteam1
```

The `client` subcommand is required. Use a separate writable home; retail data is not shipped. [Compatibility](COMPATIBILITY.md) retains numeric, pointer, decoder and renderer-profile qualifications, including known failing stricter cross-driver diagnostics. Acceptance does not erase those limitations.
