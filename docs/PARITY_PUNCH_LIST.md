# Post-plan parity punch list

The dependency graph is complete. This is a separate list of discoveries and follow-up work after that completion. It does not reopen milestones.

The target is all functionality offered by the original game and Team Arena, including commands, cvars, formats and mod-facing behavior. Optimization follows the parity work. Undefined source memory access and hardware-dependent results are separate from omitted functionality.

The September 10 follow-up survey reconciled the existing source accounts with targeted current-code and original-source reads. It was not a new exhaustive reread of every function. The list below records its findings and remaining survey work. A candidate is not complete until lead review and combined verification pass. Published executables are a separate checkpoint.

## Confirmed corrections

- [x] P01: Preserve raw PK3 filename bytes regardless of the ZIP UTF-8 flag, including high-byte listing and list-to-open identity. Original-source comparison and independent filesystem review pass.
- [x] P02: Preserve raw loose filename bytes in reads and both listing modes. Lead fixed the extra-separator path-limit regression found during review.
- [x] P03: Preserve raw download names and byte-exact canonical/descriptor containment, including retained non-UTF-8 roots.
- [x] P04: Preserve raw writable names through create, append, rename, copy and descriptor operations, including raw game directories.
- [x] P05: Carry native byte paths through mod discovery, game-directory selection, archive startup/reopens, CD copying and download-root retention.
- [x] P06: Preserve Unicode host roots through source-byte cvars and restart. `NativeRoot` owns native bytes and separates host UTF-8 encoding from game filename bytes. Actual Unicode cwd, raw roots, canonical aliases and restart checks pass.
- [x] P07: Accept cached positive signed-int32 `pmove_msec` values above 200 while retaining the original 200 ms inner simulation clamp. Both-product prediction checks pass.
- [x] P08: Retain raw session team and spectator integers through movement and end-frame consumers.
- [x] P09: Retain raw session `teamLeader` values through read/write and migrated consumers. Committed in `ce78de0`.
- [x] P10: Remove the unsupported million-entry bot goal quotas. Reached hunk/zone failure ordering above the old cap is checked without large successful allocations.
- [x] P11: Apply source bot skill clamping and bounded-characteristic comparisons, including defined infinity/NaN cases through actual traps.
- [x] P12: Let missing empty/overlong character filenames reach source default fallback; reject only a reached overflowing destination copy.
- [x] P13: Apply the AAS nonpositive frame-time default before finite-value rejection, including negative infinity.
- [x] P14: Accept finite nonpositive `r_subdivisions`. Actual cvar-to-world-loading checks retain 0 and -1.
- [x] P15: Accept source-safe odd patch grids with the actual 65-per-axis scratch and 1,024-control bounds. Authored BSP loading checks include 33/65 axes and 1,023 controls.
- [x] P16: Remove the unsupported 64 MiB BMP output quota. A 67,125,248-byte output fixture passes; source signed allocation bounds remain.
- [x] P17: Retain raw snapshot team and persistent-item fields until the reached pickup branch uses them. Wire-to-prediction checks pass.
- [x] P18: Accept empty cinematic audio chunks while preserving raw-stream bookkeeping. Independent review traced the decoder/engine join and verified actual audio admission.
- [x] P19: Raise the named recoverable common drop when a looping effect resamples to zero frames. The existing common recovery path is retained; audio fixtures verify the named error and side-effect ordering.
- [x] P20: Preserve signed sound channel and listener identities. Review also fixed local-listener entity 1024 admission; only reached entity-position access requires a real array element.
- [x] P21: Use common temporary hunk memory for cinematic downsampling in source allocate/draw/dirty/free order. Actual CPU fixtures cover exhaustion and retained allocation after draw failure.
- [x] P22: Correct diagnostic `BotPrintTeamGoal` name capacity from 32 to source `MAX_NETNAME` 36.
- [ ] P23: Both arena/bot catalog consumers now pass byte-preserving filename checks. Fresh compiled integration remains; the published 21:47 executable predates this work.

The main batch is 22/23 checked off. Independent filesystem, audio and numeric/gameplay reviews pass. Lead's 11-file correction selection passes 176 cases; the authored settings-to-BSP probe passes ten cases. These are bounded correction checks, not an unrestricted parity claim.

## Additional source options

These are optional build/platform capabilities, not newly missing retail game modes. Their source conditions and dependencies must stay explicit.

All 15 groups now have implementations in the working tree; 12 are checked off for their stated profiles. Font export and conditional accounting need final review. The threaded renderer passes actual CPU and GL recovery checks and awaits compiled-worker integration.

- [ ] O01: Implemented font rasterization, glyph atlases and real filesystem `r_saveFontData` export through optional system FreeType. Prebuilt DAT path retained. Independent ABI/lifetime review and actual system-font rasterization pass; historical FreeType pixel identity is not claimed.
- [x] O02: `com_vmDebug` selects interpreted-QVM instruction profiling/debug execution for `vmprofile`; `com_vmBreakFunction` selects the source breakpoint. Independent source review and actual CommonConsole counters pass. Direct TS modules have no interpreted instruction profile.
- [x] O03: `com_botDebug` connects botlib visualization/timing and game-AI DEBUG call sites to actual source owners. Independent initialization, lifetime and shutdown review passes.
- [x] O04: Zone/hunk/bot debug metadata, reports and gated `zonelog`, `hunklog`, `hunksmalllog` commands work. Automatic allocation attribution reports actual TS file/line and semantic labels in raw and compiled runs. Capture is debug-only; native debug-header budgets, addresses and C expression labels are not fabricated.
- [x] O05: `--missing-files PATH` owns append-only file-miss logging across filesystem restarts and final shutdown. Actual filesystem-owner checks pass.
- [x] O06: `com_prereleaseDemo` and `com_prereleaseTeamArenaDemo` select the independent source restrictions and metadata branches. Actual server registration and Team Arena init/reload/script checks pass for all four combinations. Historical demo asset playthroughs are not claimed.
- [x] O07: `in_midi`, `in_mididevice`, `in_midichannel` and `midiinfo` connect Linux raw MIDI to source note/key behavior and actual engine polling. Injected bytes reach UnixIo's event queue; physical MIDI hardware is unverified.
- [x] O08: `in_joystickProfile windows` selects cardinal POV and six-axis trackball mappings; Linux remains the default. `in_debugjoystick` now prints the sampled controls. Mapping/queue checks pass; physical controller qualification remains separate.
- [x] O09: SOCKS5 UDP association, authentication, envelopes and actual host `net_restart` work over owned localhost sockets. Review fixed received port-zero admission. The undefined greeting byte is repaired; bounded negotiation and malformed-response validation remain explicit differences.
- [x] O10: SDL clipboard paste reaches actual text fields. Lead's private-Xvfb check verifies copy/free, 512 replacements, delimiters and Ctrl-V; no desktop clipboard was used.
- [x] O11: SDL display selection, refresh constraints and window positions are wired through `vid_screen`, `r_minDisplayRefresh`, `r_maxDisplayRefresh`, `vid_xpos` and `vid_ypos`. Selection checks pass; desktop-wide capture/fade policies and physical multi-monitor qualification are not claimed.
- [ ] O12: Actual `r_smp` frontend/backend workers, double command buffers, retained scene/resource transfer, CPU presentation and GL context transfer implemented. Actual CPU and GL game/restart/fallback and recoverable worker-error checks pass. Independent lifecycle review passes; compiled worker startup remains to check.
- [x] O13: `r_hardwareProfile` and `r_driverProfile` select source RagePro/Riva128/Permedia2/3dfx/Voodoo behavior through renderer, UI/cgame and VM configuration. Actual resource/pixel and retained-byte checks pass; physical legacy GPU equivalence is not claimed.
- [x] O14: `sndbits`, `sndchannels`, `sndspeed` and `snddevice` select actual SDL output and mixer behavior. Review fixed unsupported-rate cleanup/fallback; real dummy-device U8/S16, mono/stereo and queue-count checks pass.
- [ ] O15: Diagnostic and platform-control implementations are joined, including AAS sample/reach, parser/content/movement diagnostics, predictable events, failed-model warnings, debug fast-sky, server debug drops, GL error checks, context gating and Apple transform hints. A 269-block account covers 40 core files. Final accounting consolidation remains; unavailable Apple-driver/OmniTimer behavior and source-dead/broken blocks stay qualified.

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
- [x] Correct the obsolete capped-raw-ring expectations in `tests/sound-output.test.ts`; production retains source raw-ring behavior.
- [ ] Finish individual conditional diagnostic and legacy hardware accounting, plus systematic comparisons for uncommon team-AI decision combinations. Existing file examination is not a fresh per-branch proof.
- [ ] Review deliberate security/profile differences separately, including omitted rcon command logging, retail download protection and qport admission bounds. Do not silently remove protections in the name of parity.

The bounded renderer and QVM reviews found no new supported-profile implementation defect in their inspected qualifications. They do not establish universal driver or arbitrary-mod equivalence. Their stale evidence findings are recorded above.

## Integration and Git checkpoints

The initial source commit is `a1e09e1`; `ce78de0` adds the raw session-leader correction and both catalog filename fixtures. Neither is a v1.0.0 release. The combined working tree passes type and strict-policy checks. Current raw CPU/GL product-menu switching checks pass after played matches in both games, including return to Quake 3. Native clipboard copy/free and paste pass on a private Xvfb display.

Initial checkpoint filesystem failures and the cinematic clock-read failure were reconciled against source/baseline and their stale expectations corrected. Renderer configuration fixtures now account for the new toggle command and existing source overdraw/draw-buffer ordering. This is not a green full-suite claim.

Release v1.0.0 follows review and integration of this batch. No GitHub release or executable asset has been published.
