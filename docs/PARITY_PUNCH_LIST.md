# Post-plan parity punch list

The dependency graph is complete. This is a separate list of discoveries and follow-up work after that completion. It does not reopen milestones.

The target is all functionality offered by the original game and Team Arena, including commands, cvars, formats and mod-facing behavior. Optimization follows the parity work. Undefined source memory access and hardware-dependent results are separate from omitted functionality.

The September 10 follow-up survey reconciled the existing source accounts with targeted current-code and original-source reads. It was not a new exhaustive reread of every function. The list below records its findings and remaining survey work. A candidate is not complete until lead review and combined verification pass. Published executables are a separate checkpoint.

## Confirmed corrections

- [ ] P01: Preserve raw PK3 filename bytes regardless of the ZIP UTF-8 flag, including high-byte listing and list-to-open identity. Candidate implemented. Original-source comparison passes seven reads over six authored archives; lead integration remains pending.
- [ ] P02: Preserve raw loose filename bytes in reads and both listing modes. Candidate implemented. Lead reproduced and fixed an extra-separator path-limit regression found in review. The joined four-file filesystem selection passes 105 cases.
- [ ] P03: Preserve raw download names and byte-exact canonical/descriptor containment. Candidate implemented; independent review passes. Non-UTF-8 canonical roots still require the P05 contract change.
- [ ] P04: Preserve raw writable names through create, append, rename, copy and descriptor operations. Candidate implemented; independent review passes. Raw game-directory integration remains P05.
- [ ] P05: Carry native byte paths through mod discovery, game-directory selection, archive basename startup, independent archive reopens, CD copying and download-root retention. Candidate implemented across the actual owners; combined integration review remains.
- [ ] P06: Preserve Unicode host roots through source-byte cvars and restart. Host characters above byte 255 currently fail registration. Keep host encoding separate from game filenames; do not relax all command-text validation.
- [ ] P07: Accept cached positive signed-int32 `pmove_msec` values above 200. Candidate implemented with both-product prediction cases; retain the original 200 ms inner simulation clamp.
- [ ] P08: Restore raw session team and spectator integers. Candidate implemented with actual spectator movement/end-frame checks. Session leader integers remain P09.
- [ ] P09: Preserve raw session `teamLeader` values through read/write. Current boolean storage changes a source value of 9 to 1. Shared state and consumer migration remain.
- [ ] P10: Remove the unsupported million-entry bot goal quotas. Candidate implemented; actual hunk/zone failure ordering above the old cap is checked without large successful allocations.
- [ ] P11: Apply source bot skill clamping and bounded-characteristic comparisons, including defined infinity/NaN cases. Candidate implemented and exercised through character traps.
- [ ] P12: Let missing empty/overlong character filenames reach source default fallback. Candidate implemented. Reject an actual reached overflowing destination copy, not an earlier failed open.
- [ ] P13: Apply the AAS nonpositive frame-time default before finite-value rejection. Candidate implemented; negative infinity now follows the source 0.1-second default.
- [ ] P14: Accept finite nonpositive `r_subdivisions`. Candidate implemented; actual settings-to-BSP integration still needs review.
- [ ] P15: Accept source-safe odd patch grids beyond the nominal 32-point authoring convention. Candidate implemented with the actual 65-per-axis scratch and 1,024-control bounds.
- [ ] P16: Remove the unsupported 64 MiB BMP output quota. Candidate implemented and one authored image above the old quota decoded successfully; source signed allocation bounds remain.
- [ ] P17: Preserve raw snapshot team and persistent-item fields until the reached pickup branch uses them. Shared item and prediction candidates use one common eligibility path; wire-to-prediction cases pass.
- [ ] P18: Accept empty cinematic audio chunks while preserving raw-stream bookkeeping. Mixer candidate implemented; actual decoder-to-engine join remains to check.
- [ ] P19: Drop recoverably with the registered sound name when a looping effect resamples to zero frames. Candidate implemented; common-frame recovery remains to check.
- [ ] P20: Preserve signed sound channel and listener identities. Candidate implemented; guard only a reached unsafe entity-position access.
- [ ] P21: Use common temporary hunk memory for cinematic downsampling, with source allocation/draw/dirty/free ordering. Candidate and required caller migration implemented. Real CPU draw fixtures cover exhaustion and retained allocation after a draw error.
- [ ] P22: Correct `BotPrintTeamGoal` name capacity from 32 to source `MAX_NETNAME` 36. Candidate implemented. This is diagnostic helper correctness, not a normal-match regression.
- [ ] P23: Exercise byte-preserving names through both arena/bot catalog consumers, then integrate the reviewed correction batch into the next executable. The published 21:47 executable predates this work.

## Additional source options

These are optional build/platform capabilities, not newly missing retail game modes. Their source conditions and dependencies must stay explicit.

- [ ] O01: Font rasterization, glyph atlases and `r_saveFontData` export when no prebuilt font DAT exists. Preserve the existing prebuilt path. The user permits needed system-library calls; implementation choice remains open.
- [ ] O02: `DEBUG_VM` instruction profiling and debug execution connected to `vmprofile`.
- [ ] O03: Botlib DEBUG test visualization/timing and game-AI DEBUG diagnostic call sites. Existing AAS drawing helpers and `BotPrintTeamGoal` are not missing bodies.
- [ ] O04: Optional zone/hunk/bot memory debug metadata and reports, with explicit managed-memory semantics rather than invented native addresses.
- [ ] O05: `FS_MISSING` file-miss logging and its source lifetime.
- [ ] O06: Prerelease demo filesystem/operator-command restrictions and Team Arena demo metadata selection during initialization, reload and `loadGameInfo`.
- [ ] O07: MIDI device/channel selection and note-to-key input behavior through an appropriate system boundary.
- [ ] O08: Source Windows joystick POV and six-axis trackball mappings through SDL events, without replacing the existing Linux mapping.
- [ ] O09: SOCKS5 UDP proxy association, authentication and packet envelopes. The original authenticated greeting contains an uninitialized-byte defect; preserve the valid protocol, not that undefined byte.
- [ ] O10: Clipboard paste through SDL and the actual text-field input path.
- [ ] O11: Source display selection, refresh constraints and window-position controls supported by SDL. Distinguish useful controls from obsolete desktop-wide capture/fade policies.
- [ ] O12: Original frontend/backend threaded renderer mode. CPU row workers are not an implementation of `r_smp`.
- [ ] O13: Remaining selectable legacy hardware behavior, including RagePro polygon color. Reconcile already implemented cinematic/image branches before adding work.
- [ ] O14: Selectable audio output width, channel count, rate and device with the corresponding source controls. U8/S16 and mono/stereo painter bodies already exist.
- [ ] O15: Reconcile platform developer graphics controls and every conditional diagnostic block against current owners. UI debug keys/drawing are already implemented. The original file-wide OBSTACLEDEBUG profile has an undeclared-variable build defect.

## External dependencies and separate source applications

These remain visible, but are not substitutes for runtime fixes or reasons to reopen the completed graph.

- [ ] Establish a usable IPX transport boundary. The selected IPv4 transport does not provide historical Windows IPX capability.
- [ ] Account for ranking service functionality. The pinned source lacks its SDK headers and working integration; a real service contract is needed before claiming a usable port.
- [ ] Account for A3D geometry hooks. The required external implementation/SDK is absent from the pinned source.
- [ ] Record the dormant spline camera library separately. Its runtime callers are commented out in the original; enabling it would add a reachable extension.
- [ ] Keep the separately excluded authoring applications explicit: BSPC, LCC, Q3ASM, Q3MAP and Q3Radiant. Their 450 examined inputs are not implemented by runtime asset readers. Any future authoring port needs its own worklist.
- [ ] Separate replaced native build scripts from useful SDK/archive/distribution commands that Bun's runtime build does not supply.

## Evidence corrections completed

- [x] Replace the obsolete QVM weapon-255 rejection expectation with source raw-byte retention. Production already matched the original server. Root reviewed the diff and reran all 12 server-bot cases, 77 assertions.
- [x] Correct stale command-registration and QVM adapter/enum statements in COMPATIBILITY.md. Root inspected actual source and original counterparts. Existing command checks pass 53 cases, 363 assertions.

## Survey still to consolidate

- [x] Reconcile the bounded core, gameplay, game-AI, botlib, client/network, asset/collision, audio/cinematic and UI/cgame surveys. Their confirmed findings appear above. Core and normal-retail UI reviews established no additional omission in their inspected paths.
- [x] Reconcile the excluded-options survey with the UI/audio findings. Its initial statement that Team Arena demo branches were absent was incorrect and is superseded by O06.
- [x] Correct stale menu compatibility statements: negative column counts and retained type-data reinterpretation already work. Lead inspected the parser and its existing regressions.
- [ ] Correct the obsolete capped-raw-ring expectations in `tests/sound-output.test.ts`; do not change production to satisfy the obsolete cap.
- [ ] Finish individual conditional diagnostic and legacy hardware accounting, plus systematic comparisons for uncommon team-AI decision combinations. Existing file examination is not a fresh per-branch proof.
- [ ] Review deliberate security/profile differences separately, including omitted rcon command logging, retail download protection and qport admission bounds. Do not silently remove protections in the name of parity.

The bounded renderer and QVM reviews found no new supported-profile implementation defect in their inspected qualifications. They do not establish universal driver or arbitrary-mod equivalence. Their stale evidence findings are recorded above.

## Initial Git checkpoint verification

The source checkpoint is not a v1.0.0 release. Combined type and strict-policy checks pass. The 20-file correction selection reports 475 passing tests, nine optional-reference skips, three failures and one error. The failures are in `tests/fs-server.test.ts`: credential-read expectations, reentrant restart error expectations, and the following ownerless-inspection case. Their source/baseline reconciliation remains open; this is not a green full-suite result.

The cinematic fixture `absent frame does not drain` also expects one renderer clock read but observes three. An exact before/current cinematic comparison reproduces the same failure in both versions. Do not change rendering timing merely to satisfy that expectation. The focused new downsample fixtures pass.

Release v1.0.0 follows review and integration of this batch. No GitHub release or executable asset has been published.
