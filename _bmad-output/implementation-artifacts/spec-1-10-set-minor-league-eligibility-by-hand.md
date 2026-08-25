---
title: 'Story 1.10: Set Minor League Eligibility by hand'
type: 'feature'
created: '2026-08-25'
status: 'done'
baseline_commit: 'fdc810980354339d26a7e781540070631b658805'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-9-per-team-preview-and-atomic-promotion.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 1.9 promoted the Free Agent pool with `minor_league_eligible` carrying the column's `false` default and nothing able to change it. The flag carrying the most economic weight in the product — a Player stashed at a $0 Cap Hit — has no path to being set, so 1.11 would open an auction in which nobody can be stashed.

**Approach:** A Commissioner-only `/minor-league-eligibility` surface listing every pooled Player, each row stating the Team-facing consequence in words, with individual and bulk set/unset. Every change appends one `MinorLeagueEligibilitySet` event through `runTransactionalWrite`, and the live column is written **only** as a registered `ProjectionUpdater` folding those events — so the flag is reproducible from the log at any point, not merely a column somebody updated.

## Boundaries & Constraints

**Always:** Eligibility is an **event**, and the live `free_agent_players.minor_league_eligible` column is the fold of those events — one pure reducer serves both the in-transaction fold and a full rebuild, exactly as `fold()` already requires. Default is *not* eligible, so omission fails safe. A set/unset that would not change a Player's current value appends **no** event and is reported as unchanged — "before and after values" must mean something. Every appended event names the actor, the Player and the before and after values. Phase is folded from the log **inside the same transaction** through `phaseReducer`, never trusted from `locals.phase`; outside Setup the change is refused server-side with the phase named, the FR-35 cap-arithmetic reason stated, and the fact that an override exists but is not built here. Refusals are returned values, never throws (AD-1), and every sentence is worded once in the pure core. A Player id not in the live pool is refused by name, never silently skipped. Route keeps `requireCommissioner` + `requireLiveDestination(..., 'minor-league-eligibility')` on `load` and on the action; all writes go through `writeGateway()`. Controls carry the Commissioner control class and their disabled state always states its reason. Legible at 375px with no lateral scrolling; a greyscale screenshot stays fully readable.

**Ask First:** Any change to `runTransactionalWrite`'s signature, to the staging tables, or to the `free_agent_players` schema beyond what this story needs. Any second write path to the eligibility column.

**Never:** The override path or its reason sheet (7.1/7.3) — this story states that an override is required and builds none, and depends on neither. `AuctionOpened` and the open gate (1.11). Editing any other column of `free_agent_players`, or eligibility on a `team_rosters` row — this flag is set on **pooled** Players. Reading eligibility from the Fantrax export: it is app-owned and absent from the file (settled, AR-33).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Screen renders, freshly promoted | pool live, no eligibility events | every Player listed as not eligible, each row stating the consequence in words | N/A |
| Nothing promoted yet | `free_agent_players` empty | a designed empty state naming Import as what is outstanding; no controls offered | N/A |
| Set one Player | Setup, currently not eligible | flag set; one event with before `false`, after `true` | N/A |
| Bulk set | Setup, 40 selected, 3 already eligible | 37 events appended, 3 reported unchanged; column matches the fold | N/A |
| No-op change | already eligible, set to eligible | no event appended; reported unchanged | N/A |
| Unknown Player id | id absent from the live pool | refused, naming the id; nothing written | rejection |
| Empty selection | no Player ids submitted | refused; nothing written | 400 |
| After the auction opens | phase folds to Auction | refused server-side inside the transaction, phase named, override reason stated | rejection |
| Rebuild from the log | whole log replayed | reproduces the flag as it stood at each point, idempotently | N/A |
| Re-import during Setup | eligibility set, then a promotion runs | the promoted pool carries the folded eligibility, not a bare `false` | N/A |
| Failure mid-write | an insert throws partway | whole transaction rolls back; no event, no column change | rethrow |

</frozen-after-approval>

## Code Map

Read 1.9's Code Map and Design Notes first — the `runTransactionalWrite` shape, the `ProjectionUpdater` registration, the "server renders, surface prints" split and the refusal-wording discipline are reused, not re-derived. No migration: `free_agent_players.minor_league_eligible` already exists (`20260824020000_live_reference_tables.sql:94`).

- `src/lib/core/projection/eligibility.ts` -- new, pure. `MINOR_LEAGUE_ELIGIBILITY_SET` event type, `EligibilitySet = ReadonlySet<string>` of eligible Fantrax player ids, `INITIAL_ELIGIBILITY`, and `eligibilityReducer: Reducer<EligibilitySet>` reading `{ fantraxPlayerId, before, after }` off `AppendedEvent.payload` and ignoring every other event type — the same `default: return state` discipline as `phase.ts:47`. Folded by the existing `fold()` (`projection/fold.ts:44`), so the in-transaction fold and the full rebuild are literally one function (AD-5).
- `src/lib/core/rules/eligibility.ts` -- new, pure. `EligibilityChange` (`fantraxPlayerId`, `playerName`, `before`, `after`), `planEligibilityChanges(pool, ids, target)` returning `{ changes, unchanged, unknownIds }` — the no-op skip and the unknown-id detection have one definition. `ELIGIBILITY_CONSEQUENCE` — the row sentence, *"this Player can be stashed at a $0 Cap Hit"*, stated once. `EligibilityRefusal` union (`phase` | `unknown_players` | `empty_selection` | `unbound_actor`) and `eligibilityRefusalDetail()`, mirroring `promotionRefusalDetail` (`rules/import-preview.ts:156`) — the phase sentence names the phase, states that the change alters cap arithmetic under FR-35 for every open Auction on that Player, and says a Commissioner override is required and is not available here.
- `src/lib/server/eligibility.ts` -- new, server-only. `loadEligibilityPool(client = serviceRoleClient())` reads `free_agent_players` sorted by name for the surface, each row carrying the finished consequence sentence (server renders, surface prints — 1.9 change-log items 1 and 2). `setEligibility(gateway, actor, ids, target)`: one `runTransactionalWrite` — `load` folds the phase via `loadEventsViaClient` (`server/event-log.ts:110`) and reads the live pool on the same client; `decide` returns `rejected` with a worded detail for each refusal, else `accepted` with one `EventEnvelope` per change; the column write is a registered `ProjectionUpdater` applying the fold of the just-appended events. Export `applyEligibilityProjection(client, eligible)` so promotion and this path share one writer.
- `src/lib/server/import-promotion.ts` -- extend `loadPromotionState`/`writeLiveTables`: fold `eligibilityReducer` over the log it already reads (`import-promotion.ts:89`) and insert each pool Player with the folded value instead of the staged `false`. Without this, a re-import silently reverts eligibility while the log still says otherwise — the one place 1.9's "carried across as staged" comment must change. Update the promotion test asserting the carried default.
- `src/routes/minor-league-eligibility/+page.server.ts` -- new. Both guards on `load` and on the single `set` action; `ids` (multi-valued) and `eligible` (`'yes'`/`'no'`) from the form; empty selection → `fail(400)`; the unbound-actor check before the transaction opens, worded by the core, exactly as `routes/import/+page.server.ts:145` does; a `WriteOutcome` mapped to a rendered notice.
- `src/routes/minor-league-eligibility/+page.svelte` -- new. `commissioner-block` + `control-commissioner` only (`styles/commissioner.css`); types declared structurally, never imported from `$lib/server`. Per-row checkbox with the consequence sentence beside it, a select-all for bulk, set and unset submits; a stacked list at 375px becoming a `<table>` with `scope` headers at the same 640px breakpoint `routes/import/+page.svelte:532` established. Disabled controls take their state from one flag with an always-present reason element carrying a stable id (1.9 change-log item 3 — `tests/signin-surface.test.ts:263` enforces this).
- Tests -- `tests/core/eligibility.test.ts` (reducer fold + idempotent rebuild, plan/no-op/unknown, every refusal sentence), `tests/server/eligibility.test.ts` (stateful fake `ConnectionGateway` per `tests/server/pool-import.test.ts`: every matrix row including the rollback and that a rejection writes no column), `tests/routes/minor-league-eligibility.test.ts` (both guards refuse the action; empty selection and unbound actor refuse), extend `tests/server/import-promotion.test.ts` for the folded-eligibility carry. Assert a discriminant before narrowing.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/projection/eligibility.ts` -- the event type and the pure reducer -- AC4
- [x] `src/lib/core/rules/eligibility.ts` -- change planning, the consequence sentence, the refusal wording -- AC1, AC3
- [x] `src/lib/server/eligibility.ts` -- the read, the one transaction, the projection writer -- AC2, AC3, AC4
- [x] `src/lib/server/import-promotion.ts` -- promote with the folded eligibility, not the staged default -- AC4
- [x] `src/routes/minor-league-eligibility/+page.server.ts` -- guards, form parsing, outcome mapping -- AC2, AC3
- [x] `src/routes/minor-league-eligibility/+page.svelte` -- the surface, individual and bulk -- AC1, AC5
- [x] Tests per Code Map -- covers the I/O matrix

**Acceptance Criteria:**
- Given a freshly promoted pool, when the screen renders, then every Player is not eligible and each row states the consequence in words rather than offering a bare checkbox.
- Given the League is in Setup, when the Commissioner sets the flag individually or in bulk, then the live column matches the fold of the log and each change is in the Audit Log with actor, Player, before and after.
- Given the phase has folded to Auction, when a change is attempted, then it is refused inside the transaction with the phase named and the FR-35 consequence and override requirement stated — regardless of what the page rendered.
- Given the whole log, when it is replayed from empty state, then the flag is reproduced as it stood at each point, and replaying twice converges on the same result.
- Given the surface, when inspected, then every control is a Commissioner control, every disabled control states its reason, and the consequence sentence and each refusal sentence have exactly one definition each in the pure core.

## Spec Change Log

## Design Notes

**Why this table gets a projection column when 1.9 said it is not a projection.** 1.9 is still right about the rest of `free_agent_players` — name, positions, NBA team are imported reference data and are never rebuilt from the log. `minor_league_eligible` is the one column that is *app-owned*, and this story's AC requires a rebuild to reproduce it at any point in the log. So the column is a projection and the other columns are not, in one table. Say this at both write sites so a later reader does not generalise either half.

**Why the write goes through the `projections` seam rather than a plain `update`.** Same reason as 1.9: it is the one hook that persists inside the appending transaction (AD-5). Here it is also literally what it says on the tin — the first genuine event-sourced projection in the codebase, unlike 1.9's use of the seam for mutable reference data.

**Why one event per changed Player rather than one event per submit.** "Before and after values" is per Player, and the reducer folds per Player. A bulk of forty is forty events in one transaction, which is correct for the Audit Log and is a Setup-only cost.

## Verification

**Commands:**
- `npm test` -- all pass, including the purity, pins and structure gates
- `npm run check` / `npm run build` -- clean

**Manual checks (if no CLI):**
- As Commissioner at `/minor-league-eligibility` with the pool promoted: confirm the list is legible at 375px without lateral scrolling, that a greyscale screenshot still distinguishes these controls from a Manager control, and that each row reads as a sentence rather than an unexplained checkbox.

## Suggested Review Order

**The flag becomes an event**

- Entry point — the pure reducer the whole story hangs on; read this first.
  [`eligibility.ts:115`](../../src/lib/core/projection/eligibility.ts#L115)

- Membership is decided by `after` alone; `before` is audit detail, which is what makes replay idempotent.
  [`eligibility.ts:91`](../../src/lib/core/projection/eligibility.ts#L91)

- Absence is the safe default: a `Set` of eligible ids, empty at the start of the log.
  [`eligibility.ts:46`](../../src/lib/core/projection/eligibility.ts#L46)

**The one transaction**

- The whole write path: lock, fold phase and eligibility from one log read, decide, append, project.
  [`eligibility.ts:257`](../../src/lib/server/eligibility.ts#L257)

- The column write registered as a projection — the one hook that persists inside the appending transaction.
  [`eligibility.ts:306`](../../src/lib/server/eligibility.ts#L306)

- The single writer of the column, shared with promotion so no second statement can touch it.
  [`eligibility.ts:153`](../../src/lib/server/eligibility.ts#L153)

- Gates re-derived under the lock; a refusal is a returned value, never a throw.
  [`eligibility.ts:211`](../../src/lib/server/eligibility.ts#L211)

- The current value comes from the fold of the log, never from the column it could disagree with.
  [`eligibility.ts:181`](../../src/lib/server/eligibility.ts#L181)

**One column is a projection, the rest of the table is not**

- Promotion folds eligibility from the log it already reads, so a re-import cannot revert it.
  [`import-promotion.ts:123`](../../src/lib/server/import-promotion.ts#L123)

- The pool insert no longer carries the column; the one writer sets it in the same transaction.
  [`import-promotion.ts:363`](../../src/lib/server/import-promotion.ts#L363)

**One definition per sentence**

- The consequence stated in words once, so no row invents its own phrasing.
  [`eligibility.ts:64`](../../src/lib/core/rules/eligibility.ts#L64)

- The five refusals, worded once for route, transaction and tests.
  [`eligibility.ts:176`](../../src/lib/core/rules/eligibility.ts#L176)

- No-op skip, unknown-id detection and duplicate collapse, each with one definition.
  [`eligibility.ts:101`](../../src/lib/core/rules/eligibility.ts#L101)

**The surface**

- Both guards on the action; the direction field takes two literal comparisons, never an object lookup.
  [`+page.server.ts:54`](../../src/routes/minor-league-eligibility/+page.server.ts#L54)

- Three route-level gates, each refused in the core's words before the transaction opens.
  [`+page.server.ts:75`](../../src/routes/minor-league-eligibility/+page.server.ts#L75)

- The designed empty state: nothing promoted, so no control is offered at all.
  [`+page.svelte:72`](../../src/routes/minor-league-eligibility/+page.svelte#L72)

- Stacked cards at 375px, a real table at 640px — the breakpoint `/import` established.
  [`+page.svelte:353`](../../src/routes/minor-league-eligibility/+page.svelte#L353)

- The outcome announced, because post-submit focus stays on the control that was pressed.
  [`+page.svelte:203`](../../src/routes/minor-league-eligibility/+page.svelte#L203)

**Peripherals**

- Fold order, per-point reproduction and double-replay convergence.
  [`eligibility.test.ts`](../../tests/core/eligibility.test.ts)

- Every matrix row: bulk split, no-op, unknown id, phase, rollback, and the empty-set write.
  [`eligibility.test.ts`](../../tests/server/eligibility.test.ts)

- Both guards through the real implementations; the inherited-key direction field refused.
  [`minor-league-eligibility.test.ts`](../../tests/routes/minor-league-eligibility.test.ts)

- Promotion takes eligibility from the fold, not the staged default.
  [`import-promotion.test.ts`](../../tests/server/import-promotion.test.ts)
