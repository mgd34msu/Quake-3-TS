# Shader registration order

## Work phases

- [x] Ground: trace `ParseShader`, `ParseStage`, `ParseSkyParms`, image-cache reuse and `FinishShader` against the pinned C source.
- [x] Sketch: compare public ordered instructions with an opaque registration program and a resumable parser alternative.
- [x] Agree: select the opaque program after cross-review; no user checkpoint is required.
- [x] Implement: replace eager registration and migrate its callers.
- [ ] Verify or redesign: replay original-source failures, duplicate directives and both retail shader corpora.

## Observed constraint

Parsing and resource registration are interleaved in the original renderer. A missing required image stops parsing immediately, but a failed video does not. A rejected shader can retain successfully parsed stages and image-cache side effects. Sky and sun declarations after the failure must not run. A list of final shader stages does not retain enough information to reproduce these effects.

The independent native runner is `/tmp/q3-registration-review-1pjleB/run.sh`. The TypeScript regressions in `tests/world-material-registration.test.ts` cover first-image aborts, failure-slot counts, cache retry and sky sampling. They do not yet cover the complete ordered-parser contract.

## Selection criteria

Each candidate will be checked for:

1. Exact source-order image, video, sky and sun effects, including overwritten directives.
2. Correct partial shader storage at text and resource failures.
3. One parser implementation, with no duplicate grammar or source-offset logic in the world renderer.
4. Strongly typed, instance-owned state and explicit resource failures.
5. A small caller interface with rerunnable native and retail tests.

## Selected design

Candidate B, the opaque registration program, won the independent review by GPT-5.6 Sol at maximum effort, 22/25 against 15/25. Root read both packages and the judgment. Candidate A contributed explicit animation-frequency changes and count increments after successful frame loads. The public instruction protocol, split accepted/rejected indexes and invalid-video draw rejection were rejected.

The public catalog stores one ordered `entries` list. Each entry owns a pure, replayable program with `register(host)`. Its instruction format and mutable execution state remain private. The result contains the exact accepted or partial definition, canonical finished-stage bindings and registered sky faces. The world renderer supplies actual image, cinematic, sun and sky-coordinate services; it does not interpret parser instructions. Registration failures stop required image operations at the source call site. Failed cinematic attempts do not stop parsing.

The canonical binding distinguishes a single image, an animation with its own retained frequency and frames, a live cinematic and `retain-current-texture`. Animation timing never comes from the last semantic map directive. A renderer-instance FIFO orders different names against their shared image cache, while preserving named-failure reuse across lighting modes.

Sky coordinates belong to one renderer instance, not individual shader definitions. Outer image registration uses source order `rt,bk,lf,ft,up,dn`, then initializes cloud coordinates, then registers inner images. Drawing applies the separate `sky_texorder` permutation. Sun effects run where parsed, including before a later failure.

No duplicate inspection projections, parallel registered-binding union or redundant stage-completed bit will remain. Parser, finisher, world and evaluator callers migrate together. CPU and GL own actual retained unit bindings. Native image creation's upload and raw-unbind effects are a separate required integration step; draw-only retention tests cannot close that behavior.

Local design evidence: `/tmp/quake3-shader-order-candidate-a.md`, `/tmp/quake3-shader-order-candidate-b.md`, `/tmp/quake3-shader-order-judgment.md`. The judgment SHA-256 is `da53c97898f17b5aae028427d454fc0458f776278d0ec224e1e4281121c70f45`. Combined acceptance remains open.

## Implementation evidence

The parser/program and canonical bindings are implemented. All catalog entries in both mounted retail products replay through a recording host. Focused parser/finisher/fog verification passes 53 tests with 25,788 assertions and one environment-dependent skip. Production resource tests cover rejected completed prefixes, real remapped CPU pixels, duplicate precedence, overwritten images, image failures and outer/inner sky registration. The FIFO regression set uses the actual finisher and verifies final-key changes, named-failure reuse, rejection recovery and independent renderer instances.

Independent FIFO review found that sharing an unfinished promise bypassed lookup after `FinishShader` changed a lightmap key. That shortcut and the early published-cache shortcut were removed. Every request now reaches its serialized lookup. The original reproduction changes from one preparation and shared record to two preparations and distinct records for concurrent positive-lightmap requests that finish as `LIGHTMAP_NONE`.

Explicit source image creation and cinematic upload/device integration remain a separate open design boundary. Both backends now expose direct registration and retained-binding behavior, but production resources still use the existing draw-time upload path. Those direct backend tests do not certify source registration effects in the complete application.
