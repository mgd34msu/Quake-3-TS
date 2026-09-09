# Image creation and cinematic upload

## Work phases

- [x] Ground the original image, binding, cinematic and command-queue paths.
- [x] Compare independent designs and cross-review their source behavior.
- [x] Select the corrected resource and batch contracts below.
- [ ] Implement and migrate every production and diagnostic caller.
- [ ] Verify native traces, retail frames, the combined tree and executable.

This is the next dependency of shader-registration integration. It does not close a renderer milestone. The current production path still permits draw-time image creation and pixel refresh.

## Selection

The independent judgment scored candidate A 19/25 and candidate B 20/25. Use B's immutable registration catalog, nominal image identity, backend texture-object state and once-only target execution. Keep A's smaller caller interface: texture operations occupy the existing single or paired draw-batch slots. Do not add B's public general bind/run/draw program.

Neither original proposal is accepted unchanged. Both froze UI pixels before an observable synchronization boundary. B also cleared shader-video dirty state incorrectly and recorded a clock value too early. The selected design corrects these behaviors rather than treating the scores as implementation approval.

Local evidence:

- `/tmp/quake3-image-upload-candidate-a.md`
- `/tmp/quake3-image-upload-candidate-b.md`
- `/tmp/quake3-image-upload-cross-review.md`
- `/tmp/quake3-image-upload-judgment.md`, SHA-256 `9817df37daa0816a3ee320a1a16c6f9443b5f20ed6c75caee7e9d1bc118af4d2`

## Resource ownership

`RendererImage` has module-owned construction and records its catalog identity, ordinal, name and original source dimensions. Callers cannot fabricate a registered image from mutable bytes. Creation receives explicit source dimensions, upload dimensions, RGB8 or RGBA8 storage, sampling, border color and registration unit. These are direct level-zero operations, not a claim that the complete native `Upload32` pipeline exists.

The catalog copies pixels and metadata into an immutable creation journal. A normal bind carries only the registered image identity. It cannot allocate, compare pixels, upload or change sampling. The old lazy image path, synthetic white shorthand and per-bind sampler variants are deleted in the same migration wave.

A catalog has one active session. Fresh backend objects attach before dynamic execution begins. Attachment replays only immutable creations. Registration after execution begins broadcasts new creations immediately to the fixed backend set without issuing queued views. A clean session close permits a fresh session that resets dynamic state; it does not clone prior binds or cinematic uploads.

Partial creation or execution failure permanently poisons the catalog and session. There is no rollback, retry or continued draw after one mirrored backend has mutated and another has failed. Recovery requires new resources and a new catalog. A session cannot execute without a backend.

Built-ins are real registrations in native order: default, white, identity light, 32 distinct scratch images, dynamic light and fog. Repeated scratch names do not collapse their identities.

## Texture execution

Each backend owns separate named-object storage, source scratch dimensions, cached image identity per unit, actual bound object per unit and current unit. Texture object zero is one shared object within that backend, not one object per unit and not Quake's default image.

Creation performs cached binding, upload and parameters, then raw-binds object zero without repairing the cached identity. Unit-one creation restores the active unit to zero. A later bind of the cached image can therefore leave actual object zero bound.

Cinematic resize changes scratch metadata but writes RGB8 storage and linear/clamp parameters to the actual object. Equal-size dirty upload writes a subimage into that actual object's existing storage and keeps its format and parameters. Equal-size clean use only binds. None of these operations repairs a source cache mismatch.

A batch slot selects one of:

- Bind an existing image.
- Retain the current texture with no operation.
- Prepare and upload a shader cinematic at execution.

The target validates static geometry, executes unit zero, executes unit one for a paired batch, draws, and performs the paired cleanup. Unit numbers come from slot positions. A mirrored target prepares each cinematic call once, supplies the same immutable upload to both backends, and completes the source call once.

## Cinematic ownership and timing

Shader preparation reads the live engine cinematic clock at execution. A recorded frame-time scalar is not equivalent. Original decoder paths can sample the clock more than once within one run call.

Invalid handles and valid handles without a frame perform no bind, upload or completion. They do not bind a scratch white image. Shader upload uses the native fixed 256 by 256 dimensions. Its owner applies the original `playonwalls` changes before and after upload. A successful shader upload does not generically clear dirty state.

UI raw drawing has a separate completion boundary. Before entering the renderer, the owner captures the source-selected buffer reference, dimensions and dirty argument. Resampling, when required, creates its source private temporary buffer before the barrier. The renderer then:

1. Consumes and executes older queued commands.
2. Calls the finish barrier.
3. Performs the source power-of-two validation.
4. Copies bytes through the previously selected buffer reference into one immutable upload.
5. Binds and uploads on the current unit.
6. Enters the raw 2D state and draws immediately.
7. Invokes the UI owner's completion after every backend draw returns.

The original UI completion clears the handle's dirty state unconditionally. Do not add an epoch check that preserves a newer dirty value when the source clears it. The upload keeps the selected pointer; it does not follow a newer buffer pointer published during the barrier. No-frame UI returns before the raw trap and does not flush.

The native test in `/tmp/q3-image-cinematic-audit-ZF4F99/run.sh` executes the original queue and renderer functions. Its alias cases inject publication at the finish boundary to isolate pointer and dirty timing. That injection is not evidence of a complete queued-shader decoder scenario. Further real shared-cinematic lifecycle verification remains required.

## Migration and acceptance

First implement and test the immutable resource foundation. Then replace both backend texture state machines and migrate built-ins, world/lightmap/model/UI registration. Migrate batch texture slots and consuming command submission together with shader and UI cinematic owners. Every diagnostic must explicitly create its images. No compatibility overload may keep the lazy behavior alive.

Required evidence includes cached-name versus actual-zero queries, shared object-zero storage, RGB8 replacement versus RGBA subimage alpha, source clock reads, no-frame retention, raw synchronization, pointer alias timing, once-only mirrored execution and fatal partial failure. Run native comparisons before using CPU/GL agreement as evidence. Finish with both-product changing-RoQ retail frames, strict type/policy checks, the full combined test snapshot and raw/compiled executable comparisons.

Full mipmap/picmip/gamma processing, global texture-mode changes and complete shared 16-handle cinematic lifecycle remain tracked work. Explicit image operations must not conceal those gaps.
