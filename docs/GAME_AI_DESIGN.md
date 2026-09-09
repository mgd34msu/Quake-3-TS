# Source-synchronous game AI design

Accepted architecture; production implementation and match acceptance remain open. The source baseline is `dbe4ddb10315479fc00086f08e25d968b4b43c49`. Source-grounded unit corrections below supersede the frozen comparison sketch where noted.

## Usage (caller's view)

The server owns the bot library. Application callers enable source bots, then use ordinary commands:

```ts
const server = ServerEngine.create({ ...host, bots: { kind: "source" } });
await server.commands.executeNowAsync("map q3dm1; addbot sarge 4");
```

Inside the existing server map operation, complete actual map services precede game creation:

```ts
const factory = sourceBots.forMap(mapServices);
const game = GameRuntime.create({ ...gameOptions, botFactory: factory }, map.world);
const denied = game.clientConnect(slot, false, true);
game.botFrame(serverTime);
```

Fast restart follows the existing source sequence:

```ts
game.shutdown(true);
const replacement = GameRuntime.create({ ...restartOptions, botFactory: factory }, map.world);
```

The replacement gets fresh game AI statics and scheduler. Botlib/map survive; server settling remains game-only on fast restart. These are proposed signatures, not current executable examples.

## Problem

Full source game AI needs actual game/server ownership, synchronous first-use resource loads, separate engine/botlib/map/VM lifetimes and immediate command effects. Existing bot libraries already contain the canonical algorithms, but their asynchronous loading and detached capability injection do not provide that composition. The selected design migrates those boundaries and preserves source responsibilities.

## Shape

### Construction and failure ownership

Replace `GameRuntimeOptions.bots` with `botFactory`. Remove the constructor's eager `admission`, `commands` and `serverCommands` construction and every capture of `options.bots`. One private phase union owns construction and attachment:

```text
core-constructing → core-complete → published → attached
  → dependencies-ready → initializing → running
  → releasing → closed
```

Construct all existing core owners first, including combat, missiles, movement, session and match. Their callbacks can capture the runtime, but constructors must not invoke callbacks that need admission/commands. Publish the exact runtime into `owner.game`. Invoke the IO-free factory with that runtime and its already captured actual map. Record the attached capability immediately. Construct admission with that capability, commands with that admission, and serverCommands with that capability and commands. Their mutually referring callbacks resolve the private completed graph only when invoked. Publish the whole dependency graph once, then execute existing `initialize()` in source order.

Existing public admission/command properties become getters over the completed private graph; core callbacks use the same guarded access. There is no missing-map getter, fabricated bot capability, throwaway dependency owner or application setter. The factory constructor performs no source setup, callbacks or IO. `BotAISetup`, map loading and catalog initialization stay after map spawning/item registration in `G_InitGame`.

A constructor failure before publication leaves `owner.game` untouched. Attachment or dependency-construction failure clears only that exact publication; those stages own no source resources. Initialization records bot startup before its first lifecycle call. Normal shutdown retains source session/log/bot ordering and the completed graph needed by legitimate nested source commands.

The September 6 common-control review supersedes this design's earlier unconditional-finally cleanup rule. A direct `CommonError` abandons the source path immediately and preserves ownership at that source position. Cleanup must not erase that control in an aggregate or detach the game before common handles it. Ordinary JavaScript failures retain each owner's documented managed-error ordering. Root integrated the joined GameRuntime/common correction after independent review and staged verification of quit, initialization and terminal disposal. Checkpoint fifteen and its matching executable now qualify that bounded integration; this does not compose the actual BotLibrary or full client. Evidence: `.artifacts/common-game-control-focused-root.log`, `.artifacts/common-combined-staged-root.log`, `.artifacts/checks/2026-09-06T10-29-42.898Z.json` and `/tmp/quake3-common-combined-review-YDKces/REVIEW.md`.

Explicit managed disposal is a separate terminal operation. It releases actual owned resources without replaying game shutdown, session writes or network messages. A source startup/shutdown flag alone cannot prove that those resources were released after an interrupted callback. The server retains the shared bot capability across fast restart, including replacement failures before bot setup. Its exact disposal contract is still under review; no temporary per-game botlib owner or successful bot disposal is implied here.

Migrate `ServerEngine.initializeGame/botFrame/releaseSession`, `GameRuntime.createAdmission/createCommands/requireBots`, server-command construction, every direct game-construction test, `tools/game-verification-harness.ts` and `tools/verify-game.ts` together. Server session cleanup also releases retained botlib when failed game creation already cleared `owner.game`; shared ownership prevents duplicate shutdown. Keep admission, game commands and bot frames synchronous. Add `insertConsoleCommand` to actual game imports.

### Loaders and shared owners

Migrate the single `ScriptPreprocessor`, `IncludeResolver`, all five bot libraries and their private loading helpers to synchronous mounted `readSync`. Replace character/chat's narrow reader with the common source reader and parser-global owner. Each source opening snapshots current defines; install `MISSIONPACK` before library setup. Preserve include search, first-use errors, cache keys/identity, truncation, fallback order and partial publication. Chat setup publishes each successful configuration separately; failed weight loads preserve source clears/frees; character interpolation retains its lower-skill success.

Remove loader-only promise queues, in-flight de-duplication and late-read cancellation with their migrated callers. Keep checks around reentrant diagnostic callbacks. Migrate the other preprocessor consumer, `ui/menu.ts`, and `cgame/mission-hud.ts` text/include reads. `MissionHudHost.assets` gains the existing synchronous capability already present in production `SoundAssetReader`. Media/font/model registration remains awaited, with its current lifecycle and failure checks. Server mounting, remounting, transport and sleeping retain current asynchronous operation ownership.

Use the approved `BotLibVars` owner and readonly `BotLibVar` records directly. The implementation in `src/botlib/libvars.ts` is covered by checkpoint nine; actual botlib lifecycle composition remains separate. Stable live variables, source custom parsing and checksum-string conversion remain distinct from engine cvars and AAS settings snapshots.

`BotLibrary` owns shared caches, parser globals, EA and handle stores. AAS entity history follows the library's AAS setup allocation lifetime and survives map replacement. Each map owns canonical spatial/movement/routing objects and crossed-reachability metadata; only entity links are reset on map loading. `GameAi` borrows those identities and `game.random`; botlib borrows the existing native engine RNG. AAS loaded/initializing/ready phases follow real ContinueInit work. Parsed data alone never establishes readiness.

### Stable bot state and immediate effects

Graft the awaited candidate's setup progress/residue model into a stable per-slot cell. Progress tags identify completed setup stages and source failure residue. Numeric handle words have one stable owner, including freed words left untouched by C. The source `inuse` word remains independent because nested teardown can clear it while an outer call continues. Reset the decision record and handle words in place; never replace the cell or infer renewed activity from a completed setup tag.

Immediate EA text enters actual `executeClientCommand`. Disconnect completes ordinary game teardown and resets the stable bot record, then returns normally. Preserve subsequent defined source continuation, including weapon/delta-angle work. There is no global turn-abort token. For native use-after-free paths, the approved managed-lifetime rule retains an already acquired movement object until the current call returns while `free(handle)` immediately removes future lookup. Never republish that object or reuse it for another allocation. This is an explicit compatibility adaptation, not native memory parity. Null-node and other undefined branches remain separately accounted.

### World, scheduling and routing

Server adapters use actual first-free slots, ClientThink, reliable-ring acknowledgment and outgoing-sequence snapshot storage. Source-zero netchannel storage must differ from human `Netchan_Setup`; retain canonical channel state through slot reuse. No second snapshot, queue, RNG or movement controller exists.

Add `ServerWorld.traceEntity` through its actual transformed collision path, preserving source mask/rotation/shape behavior and botimport field conversion. Give `MissileRuntime` one owner-bound proximity touch callback and compare actual `entity.touch` identity in `isProximityTrigger`; changed callbacks and reused entities cannot retain a stale classification. Historical botlib observations separately retain validity, incoming old origin, last-visible origin, timestamps and relink state.

The trace and proximity prerequisites were integrated on September 6 by 13:58 UTC, after independent component review and root's 915-test combined run. Checkpoint twenty at 14:10 UTC, its matching executable and runtime probes now cover both changes. The trace test exercises the represented botimport conversion through actual inline geometry, but no production BotLibrary registration is implied. Proximity identity has no duplicate eligibility gates or historical tags. See [current integration evidence](STATUS.md#checkpoint-twenty).

Frames retain delayed spawning before pause, residual service at most once, botlib StartFrame before all 1,024 observations, item maintenance using previous floattime, then decision cadence and every-frame input. Keep dedicated/listen positions, all separate clocks, QVM game arithmetic and the declared native botlib profile.

Keep prediction and alternative routes on the canonical routing owner. Prediction includes `stopArea`, C success and every defined output; the source never writes `numareas`. Full-export caller storage therefore retains that field; no invented traversed-area count is exposed. Crossed-area metadata follows source preprocessing.

Use the approved same-owner `areaTravelTimeToGoal` with nullable origin; keep non-null `route()` unchanged. Preserve cache traversal, staged wrapping and the zero-best replacement rule. Omitted-origin portal search publishes its selected candidate time or zero without a candidate. This explicitly repairs an undefined source success decision, as documented in [COMPATIBILITY.md](COMPATIBILITY.md); it is not arbitrary-wrapper parity. No spatial origin or next reachability is fabricated. The assigned routing worker owns implementation. MP alternative-goal calls retain exact objective guards.

### Implementation and acceptance

| Source ownership | Selected modules/work |
| --- | --- |
| `g_bot.c` | `game/bots.ts`: catalogs, add/min-player commands, admission and delayed starts |
| `ai_main.c/.h` | `game/ai-main.ts`, `ai-state.ts`: full state, scheduler, lifecycle, input and interbreeding |
| `ai_dmq3.c`, `ai_dmnet.c` | Corresponding game modules: complete perception/combat/objectives, all 11 nodes and 50-switch diagnostics |
| `ai_team`, `ai_cmd`, `ai_vcmd`, `ai_chat` | Corresponding modules: every team/text/voice/chat behavior |
| `be_interface`, `l_libvar`, AAS lifecycle/entity/routing | Canonical botlib owners plus missing lifecycle, history and algorithms |

Sequence independently verifiable units: synchronous parser/loaders and callers; LibVars/library/AAS/history; routing algorithms; actual server attachment/adapters; game lifecycle/state/input/scheduler; complete decision modules; retail matches for every mode/product/backend; sustained CPU/memory acceptance. Native botlib and original-QVM game traces must cover first-use failures, partial cleanup, RNG order, initialization failure at each phase, fast restart identity, reliable empty slots, snapshots, self-disconnect through configurable grapple commands, acquired movement lifetime and reentrant diagnostics. Offline generation/clustering, cache persistence, PC exports and debugging remain named full-port work; active initialization requirements precede match acceptance.

## Synthesis decision

The synchronous candidate is the base: root 17–12, independent judge 18–13. Graft partial setup/residue tracking from the awaited candidate. Apply the corrected construction, routing and managed-lifetime contracts above. Reject awaited admission propagation, lease plumbing, split route owners and turn abort. Strict semantic and actual policy verification are recorded separately; neither constitutes gameplay acceptance.

## Tradeoffs accepted

Blocking first-use script reads preserve source ordering with a smaller game contract. The shared parser/UI migration removes duplicate API obligations. Explicit partial state preserves source failure behavior.

## Alternatives considered

Fully awaited admission hides waiting but extends cancellation through the authoritative game/server graph. Synchronous VFS already supplies the needed behavior. Preloading changes first-use errors and cache publication.

## Open questions and risks

Which remaining source-undefined null-node, setup or out-of-bounds behaviors need separately approved repairs? Which missing AAS generation branches occur on supported retail maps? Actual implementations and native evidence must resolve these before acceptance.

## Next implementation step

The canonical parser and bot/UI text-reader migration already passed checkpoint ten. Combined trace/proximity verification and checkpoint twenty are complete. Canonical AAS/BotLibrary load composition still requires the stopped bot BSP-entity owner: original `AAS_LoadFiles` unconditionally loads BSP entities before AAS data, and `Export_BotLibLoadMap` then initializes level items and brush-model types. Root verified these decisive calls against the bounded caller map at `/tmp/quake3-bot-path-contract-SS5fPU/CONTRACT.md`. No standalone factory, inspection-parser reuse or fabricated ready flag is approved as a substitute. After that prerequisite is accepted, compose actual BotLibrary ownership, server attachment and game lifecycle in the dependency order above. Existing refusal boundaries remain excluded from retries. No full game AI implementation or bot match is accepted yet.

## Source-grounded implementation adjustments

- Global definitions are parsed immediately by the one preprocessor, then copied as immutable macro snapshots when a source opens. Preserve duplicate global names, source chain reversal and one-at-a-time shadow removal; do not replay a string list or collapse duplicates in a map. Ordinary source opening does not call `PC_AddBuiltinDefines`. Builtins require explicit installation; normal bot/UI reads leave them absent.
- Bot source paths use the actual base-folder prefix and `MAX_QPATH` truncation. Do not search the including file's directory first or silently remove an explicit `botfiles/` prefix. Keep requested source names distinct from resolved VFS names. Generic UI text sources retain their separate source boundary; media registration remains awaited.
- Entity history borrows the real AAS phase, time and frame counter. The AAS owner assigns time, unlinks previously invalid entities, invalidates records, performs ContinueInit and then increments its frame counter. The history owner does not advance a second clock. `AAS_LoadMap` resets outgoing links but retains records; `AAS_Setup` allocates fresh records. Flat copied infos include source entity number, incoming old origin, last-visible origin, last-update time and update interval.
- Route prediction uses real crossed-area preprocessing through the canonical spatial owner. Its source-defined equal-area and no-hop results are preserved even for equal out-of-range integer area values; it must not add an unconditional valid-positive-area gate before those paths. Source-undefined indexing or arithmetic rejects only at the actual unsafe operation. Metadata is retired before a real rebuild; failed rebuilds cannot preserve old crossings.

These adjustments have source-grounded contracts. Their staged implementations still require independent review and combined verification. The accepted architecture is not evidence that game bot AI can play a match.
