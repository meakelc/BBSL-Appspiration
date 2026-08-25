---
title: 'Story 1.9: Per-Team preview and atomic promotion'
type: 'feature'
created: '2026-08-25'
status: 'done'
baseline_commit: '202c436bc4ac5750365c7c0e0720cb6655f9412f'
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-7-import-thirty-team-roster-files.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-8-import-the-free-agent-pool.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 1.7 and 1.8 stage all thirty-one sources, but nothing reads them back for confirmation and nothing promotes them. There are no live reference tables at all: the League's rosters and Free Agent pool exist only as staging rows, so 1.10 has no pool to flag and 1.11 has nothing to gate on.

**Approach:** Create the live mutable reference tables (AD "the world is not event-sourced, only the auction is"), add a per-Team preview on `/import` reporting Roster Count and Cap Space for all thirty Teams from staging, and a `promote` action that commits **all thirty-one sources in one transaction or none** — through `runTransactionalWrite`, so it takes the global lock, reads the phase from the log in that same transaction, appends one `ImportPromoted` event for the Audit Log, and writes the live tables through the projection seam 1.5 defined and left unregistered.

## Boundaries & Constraints

**Always:** Promotion is one transaction covering all thirty-one sources; a partial commit is unreachable by construction, not by cleanup. It refuses (a returned rejection, never a throw — AD-1) when any of the thirty-one sources is not `staged`, when any staged Team breaches a slot ceiling, or when the phase is not Setup — and every refusal **names** what is outstanding or offending and states the arithmetic, never a count. Phase is folded from the log **inside the promotion transaction**, through the same pure `phaseReducer`, so "re-import is refused once the auction has opened" cannot be raced past a page that loaded during Setup. Re-import during Setup replaces live state entirely (delete-then-insert inside the same transaction). The preview reads staging only and never live tables. Cap Space is computed by the existing pure `computeCapSpace`, never re-derived; Roster Count is the staged row count. Money renders through `formatMoney`; an amount off the $500,000 grid is rendered as exact integer dollars with a sentence naming the Team and the figure, and does **not** block commit. The Commissioner's own Team is subject to every rule. Route keeps `requireCommissioner` + `requireLiveDestination(..., 'import')` on `load` and on **both** actions; all writes go through `writeGateway()`. The confirm control is never the check — every gate re-derives server-side inside the transaction.

**Ask First:** Any change to `runTransactionalWrite`'s signature or to 1.7/1.8's staging tables, adapters or parse rules. Any new destination or route.

**Never:** Minor League Eligibility editing (1.10) — promotion only carries the staged `false` default across. The auction-open gate and `AuctionOpened` (1.11). A reason sheet or override path (7.1/7.3). A projection rebuild of live reference data from the log — it is mutable reference data by decision, not an event-sourced projection. Confirming the real Fantrax column mapping (AR-33): the `TODO-confirm` placeholders in `ROSTER_COLUMNS`/`POOL_COLUMNS` stand, and the outstanding human action is recorded in `deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Preview, all staged | 31 sources staged | Roster Count and Cap Space for all 30 Teams, money at one decimal; pool size stated | N/A |
| Preview, partial | some Teams outstanding | preview renders the staged Teams; outstanding sources named | N/A |
| Promote, happy path | 31 staged, Setup, confirmed | live tables replaced wholesale; one `ImportPromoted` event appended | N/A |
| Promote, a source missing | 29 Teams staged | refused, naming every outstanding source | rejection |
| Promote, slot breach | a staged Team over 12/2/3 | refused, naming the Team and stating the arithmetic | rejection |
| Promote after open | phase is Auction | refused, stating the phase | rejection |
| Re-import in Setup | already promoted, all staged again | live rows replaced entirely; a second event appended | N/A |
| Promote without confirm | no confirm field | refused; nothing written | 400 |
| Off-grid Cap Space | a staged cap hit off the $500k grid | exact dollars rendered, Team named; commit not blocked | N/A |
| Failure mid-promotion | insert throws partway | whole transaction rolls back; live tables unchanged | rethrow |

</frozen-after-approval>

## Code Map

Read 1.7's and 1.8's Code Maps first — the module split, the `StageOutcome` union and the refusal-wording discipline are reused, not re-derived.

- `supabase/migrations/20260824020000_live_reference_tables.sql` -- new. `team_rosters` (`id uuid pk`, `team_id uuid not null references teams(id)`, `fantrax_player_id text not null unique` — a Player sits on at most one roster, making the "same Player on two Teams" gap `deferred-work.md` logged structural, `player_name`, `cap_hit bigint not null`, `roster_slot_kind` with the same three-value check as `import_staged_rosters`, `contract_years_remaining integer not null >= 0`; index on `team_id`). `free_agent_players` (`id uuid pk`, `fantrax_player_id text not null unique`, `player_name`, `positions`, `nba_team`, `minor_league_eligible boolean not null default false`). Copy `20260824010000_pool_import_staging.sql`'s discipline exactly: header prose, `enable`+`force` RLS with no policies, `revoke all` from `anon`/`authenticated`, `comment on table`, `-- Applied dev-first (AD-26).`
- `src/lib/core/money.ts` -- extend: `isOnMoneyGrid(amount: Money): boolean`, the predicate `formatMoney` already throws on. Exported so a caller can ask before rendering instead of catching a `RangeError`.
- `src/lib/core/rules/import-preview.ts` -- new, pure. `TeamPreview` (`rosterCount`, `capSpace`, `capHitTotal`, `breaches`), `previewTeam(rows: readonly ParsedRosterRow[])` calling the existing `computeCapSpace`/`checkSlotCeilings` (`core/rules/roster-import.ts:40,71`) — never a second copy of either. `renderCapSpace(capSpace): { text, offGrid }` — `formatMoney` when `isOnMoneyGrid`, else exact integer dollars with the true minus sign. `promotionRefusalDetail(...)` for the three refusal sentences (outstanding sources, slot breach, wrong phase), so route, action and tests read one wording.
- `src/lib/server/import-preview.ts` -- new: `loadImportPreview(client = serviceRoleClient())` — reads `teams` + `import_staged_rosters` through PostgREST as `import-status.ts` does, maps rows via `server/staged-roster-row.ts`, and returns one `previewTeam` result per Team plus the pool size, sorted by Team name. **It also renders**: each row carries `capSpaceText`, `offGridDetail` and `breachDetail`, worded by the pure core, so the surface prints finished text and no money or refusal sentence has a second definition (amended at review-loop-iteration 1).
- `src/lib/server/staged-roster-row.ts` -- new: `KNOWN_SLOT_KINDS` and `toParsedRosterRow`, the one staged-row mapper both the preview and the promotion path import. Held two copies at first, down to the error string (amended at review-loop-iteration 1).
- `src/lib/server/event-log.ts` -- extend: `loadEventsViaClient(client: TransactionalClient)` — the same full-log read over the `pg` connection, reusing `toAppendedEvent` (`shell/write.ts:154`), so promotion folds the phase inside its own transaction rather than trusting `locals.phase`.
- `src/lib/server/import-promotion.ts` -- new: `promoteImport(gateway, actor)`. One `runTransactionalWrite` call (`shell/write.ts:179`): `load` reads the log (fold to phase via `INITIAL_PHASE`/`phaseReducer`), every `import_team_sources` row, the pool source row, and every staged roster/pool row; `decide` returns `rejected` with a named detail for the three refusal cases, else `accepted` with one `ImportPromoted` `EventEnvelope` (payload: per-Team roster counts and pool size); the live-table write is a `ProjectionUpdater` in `projections` — `delete from team_rosters` / `free_agent_players` then insert, inside the same transaction. **The first registered projection in the codebase**; see Design Notes.
- `src/routes/import/+page.server.ts` -- extend: `load` also returns `preview`; a new `promote` action, both guards re-run, refusing 400 without the explicit confirm field, mapping the `WriteOutcome` to a rendered notice.
- `src/routes/import/+page.svelte` -- extend: a preview section — a stacked `.status-row`-style list at 375px becoming a genuine `<table>` (with `scope` headers) at the first `min-width` media query in the codebase; `.money` for the figures (tabular numerals are already the body default); the off-grid sentence; a `.control-commissioner` promote button behind an explicit confirm checkbox, distinguished from `upload` without colour. Declare the preview types structurally, as this file already does.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- append AR-33 as an outstanding human action.
- Tests -- `tests/core/import-preview.test.ts` (grid and off-grid rendering, breach detection), `tests/money.test.ts` (extend for `isOnMoneyGrid`), `tests/server/import-preview.test.ts`, `tests/server/import-promotion.test.ts` (stateful fake `ConnectionGateway` per `tests/server/pool-import.test.ts`: every matrix refusal, the rollback case, and that no live write happens on a rejection), `tests/routes/import.test.ts` (both guards refuse `promote`; missing confirm refuses). Cover every I/O matrix row; assert a discriminant before narrowing (1.8 change-log item 5).

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/20260824020000_live_reference_tables.sql` -- the two live reference tables -- AC3
- [x] `src/lib/core/money.ts` + `src/lib/core/rules/import-preview.ts` -- grid predicate, per-Team preview, refusal wording -- AC1, AC2
- [x] `src/lib/server/import-preview.ts` -- read staging into the preview -- AC1
- [x] `src/lib/server/event-log.ts` -- in-transaction log read -- AC4
- [x] `src/lib/server/import-promotion.ts` -- the one all-or-nothing transaction and its event -- AC3, AC4
- [x] `src/routes/import/+page.server.ts` + `+page.svelte` -- preview surface and confirm-then-promote -- AC1, AC5
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- record AR-33 -- AC6
- [x] Tests per Code Map -- covers the I/O matrix

**Acceptance Criteria:**
- Given all thirty-one sources staged, when the Commissioner opens `/import`, then Roster Count and Cap Space are reported for all 30 Teams, money at exactly one decimal, with no lateral scrolling at 375px and a real table on desktop.
- Given a staged Team breaching a slot ceiling, when promotion is attempted, then it is refused, the Team is named, and the sentence states the counts against the ceilings.
- Given a confirmed preview, when promotion runs, then live rows for every Team and the pool are replaced in one transaction and exactly one `ImportPromoted` event carries actor, timestamp, `schemaVersion` and `coreVersion`.
- Given the phase has folded to Auction, when promotion is attempted, then it is refused server-side inside the transaction, regardless of what the page rendered.
- Given any refusal or any thrown failure during promotion, when it happens, then no live row was written and the staged sources are untouched.
- Given the codebase, when inspected, then `computeCapSpace`/`checkSlotCeilings` have exactly one definition each and AR-33 is recorded as an outstanding human action.

## Spec Change Log

**review-loop-iteration 1 (2026-08-25).** Findings from four parallel review layers (Blind Hunter, Edge Case Hunter, Verification Gap, Acceptance Auditor) against the first implementation pass. **No finding reached the spec** — none was an `intent_gap` or a `bad_spec`, so there was no revert and no re-derivation. Every item below was patched in the shipped code, and the Code Map is amended where the module split changed. Recorded so a later reader knows why these shapes exist.

1. **A duplicated money renderer in `+page.svelte`** (caught in the hand-off check, before the review). The implementer re-implemented `renderCapSpace` in the template, reasoning that no `.svelte` file may reach a server-only module. True, but `core/` is pure and the rule does not apply to it — and the right answer was neither: the server renders, the surface prints. `TeamPreviewRow` carries `capSpaceText` and `offGridDetail`.
2. **The same mistake again, for the slot-breach sentence** (Acceptance Auditor and Blind Hunter, independently). The template assembled its own breach text from raw fields and printed the database slug `active_bench` where the one `slotCeilingRefusalDetail` maps through `SLOT_LABELS` to `Active/Bench` — two copies of a sentence that must agree, already disagreeing. Amended: `TeamPreviewRow.breachDetail` is worded server-side by that one function. Tests assert the preview's wording is `slotCeilingRefusalDetail`'s output verbatim and that no slug reaches the Commissioner. **Root cause of both 1 and 2: the Code Map assigned "the off-grid sentence" to `+page.svelte` without saying who renders it.** It now says the server hands the surface finished text.
3. **The promote control was never disabled** (Acceptance Auditor, Blind Hunter and Verification Gap — all three). The page rendered "Promotion is unavailable while a source is outstanding" plus a comment invoking the accessibility floor, while the button and checkbox stayed live. Amended: both take `disabled` from `everySourceStaged`, and the reason element is always rendered with a stable id so a static `aria-describedby` can never dangle. The existing guard in `tests/signin-surface.test.ts` caught the first attempt, which used a dynamic binding the guard could not see — the guard was satisfied, not loosened. The server-side refusal is unchanged and remains the actual check.
4. **`KNOWN_SLOT_KINDS` and `toParsedRow` were duplicated** across `server/import-preview.ts` and `server/import-promotion.ts`, down to the error string (Blind Hunter) — and the promotion copy had no test (Verification Gap), so weakening it to silently coerce an unknown slot kind would have shipped green, understating a Cap Hit total and hiding a ceiling breach in a *committed* promotion. Amended: one `server/staged-roster-row.ts` both import, plus a promotion-level test asserting the throw, the rollback, and that no live row or event was written.
5. **The route worded its own refusal** for an actor bound to no Team (Acceptance Auditor, Blind Hunter), three lines below a comment saying it never does, and untested. Amended: `unbound_actor` joins the `PromotionRefusal` union so the sentence comes from the pure core; the decision stays in the route, because it is the one gate that cannot wait for the transaction to open (`auction_events.team_id` is NOT NULL). Route test added.
6. **Three comments described things the code does not do** (Acceptance Auditor, Blind Hunter, Verification Gap): a scroll container that does not exist, a 375px breakpoint that is actually 640px, and `pg` "streaming" a result set it in fact buffers. All corrected. `required` added to the confirm checkbox.

Findings raised and NOT actioned, with reasons: **a double-submit appending a second `ImportPromoted` event** (Blind Hunter, Edge Case Hunter) was verified and rejected — re-import during Setup is explicitly permitted by this spec's own I/O matrix, the live write is a wholesale replace, and two promotions honestly producing two audit entries is the correct record, not a defect. **Orphaned staged roster rows silently excluded** (Edge Case Hunter) is unreachable: `import_staged_rosters.team_id` is `not null references public.teams(id)` — the identical claim was raised and rejected in 1.8's review for the same reason. **`contract_years_remaining` unvalidated** (Edge Case Hunter) is guarded by the column's own `integer not null` and non-negative check, unlike `roster_slot_kind`, which is free text. Rejected as noise: `capHitTotal` reaching the client unrendered (1.8 rejected the equivalent for `pool.updatedAt`), the N+1 inserts inside one Setup-only transaction, `load`'s `Promise.all` coupling (a pre-existing shape), and the `outcome.reason` cast on data the same module produced. Three findings were logged to `deferred-work.md` rather than fixed: the unbounded log read, the pool/roster disjointness being neither re-derived at promotion nor enforced across the two live tables, and the absence of an end-to-end Auction-phase refusal test until 1.11 teaches `phaseReducer` `AuctionOpened`.

**KEEP — what worked and must survive re-derivation:** promotion through `runTransactionalWrite` with the live write registered as the first `ProjectionUpdater`; the phase folded inside the promotion transaction rather than trusted from `locals.phase`; `fantrax_player_id unique` on `team_rosters` making the cross-Team duplicate structural; the preview reading staging only; and the server-renders/surface-prints split items 1 and 2 established.

## Design Notes

**Why promotion goes through `runTransactionalWrite` while staging deliberately does not.** 1.7's header explains staging's local transactions: per-Team Setup state, no contention, no event. Promotion is the opposite on every count — it spans all thirty-one sources at once, it must be excluded from anything else writing the log, it must read the phase from the log to refuse after open, and FR-1 requires the outcome in the Audit Log, which is a read of `auction_events`. That is exactly `lock → load → decide → persist → enqueue`.

**The live-table write is the `projections` seam.** 1.5 defined `ProjectionUpdater` and registered nothing, noting "the story that first reads a projection is the first to pass one". This is the first registration. Live reference data is *not* an event-sourced projection and is never rebuilt from the log — the seam is used because it is the one hook that persists inside the appending transaction (AD-5), which is precisely what all-or-nothing requires. Say so at the call site so a later reader does not infer a rebuild contract that does not exist.

**Why `fantrax_player_id` is unique on `team_rosters`.** Staging cannot enforce it: thirty files are staged independently, so the same Player on two Teams is only detectable when they meet. They meet exactly once — at promotion — so the constraint belongs on the live table, where a violation aborts the one transaction and rolls everything back rather than half-importing the League.

## Verification

**Commands:**
- `npm test` -- all pass, including the purity and pins gates
- `npm run check` / `npm run build` -- clean

**Manual checks (if no CLI):**
- As Commissioner at `/import` with all thirty-one staged: confirm the preview is legible at 375px without lateral scrolling, becomes a table at width, and that a greyscale screenshot still distinguishes the promote control from the upload control.

## Suggested Review Order

**The all-or-nothing transaction**

- Entry point — the whole promotion path; read this before anything else.
  [`import-promotion.ts:222`](../../src/lib/server/import-promotion.ts#L222)

- The live write registered as the first `ProjectionUpdater` — the one hook that persists inside the appending transaction.
  [`import-promotion.ts:266`](../../src/lib/server/import-promotion.ts#L266)

- Every gate re-derived under the lock; a rejection is a returned value, never a throw.
  [`import-promotion.ts:162`](../../src/lib/server/import-promotion.ts#L162)

- The phase is folded here, inside the transaction, before any staging is read.
  [`import-promotion.ts:89`](../../src/lib/server/import-promotion.ts#L89)

- Delete-then-insert: re-import during Setup replaces live state entirely.
  [`import-promotion.ts:292`](../../src/lib/server/import-promotion.ts#L292)

- The in-transaction log read over `pg`; its comment states what it does and does not do.
  [`event-log.ts:110`](../../src/lib/server/event-log.ts#L110)

**The live reference tables**

- A Player sits on at most one roster — the cross-Team duplicate made structural.
  [`live_reference_tables.sql:46`](../../supabase/migrations/20260824020000_live_reference_tables.sql#L46)

- Eligibility carried across as the staged default; 1.10 owns setting it.
  [`live_reference_tables.sql:94`](../../supabase/migrations/20260824020000_live_reference_tables.sql#L94)

**One definition per rule (review-loop-iteration 1)**

- The grid predicate, so a caller asks instead of catching a `RangeError`.
  [`money.ts:155`](../../src/lib/core/money.ts#L155)

- On-grid renders `$14.5M`; off-grid renders exact dollars and never throws.
  [`import-preview.ts:89`](../../src/lib/core/rules/import-preview.ts#L89)

- The four refusal sentences, worded once for route, transaction and tests.
  [`import-preview.ts:156`](../../src/lib/core/rules/import-preview.ts#L156)

- Cap Space and ceilings come from the existing pure functions, not a second copy.
  [`import-preview.ts:59`](../../src/lib/core/rules/import-preview.ts#L59)

- The breach sentence worded server-side — the surface prints, never re-words.
  [`import-preview.ts:111`](../../src/lib/server/import-preview.ts#L111)

- The one staged-row mapper both read paths import; held two copies at first.
  [`staged-roster-row.ts:58`](../../src/lib/server/staged-roster-row.ts#L58)

**The surface**

- The `promote` action, both guards re-run; the confirm is never the check.
  [`+page.server.ts:145`](../../src/routes/import/+page.server.ts#L145)

- Disabled controls with an always-present reason, so `aria-describedby` cannot dangle.
  [`+page.svelte:373`](../../src/routes/import/+page.svelte#L373)

- Stacked list at 375px, a real table at 640px — the codebase's first breakpoint.
  [`+page.svelte:532`](../../src/routes/import/+page.svelte#L532)

**Peripherals**

- Every refusal, the rollback, and that a rejection writes no live row.
  [`import-promotion.test.ts`](../../tests/server/import-promotion.test.ts)

- Corrupted slot kind on the write path — a silent miscount would have been committed.
  [`import-promotion.test.ts`](../../tests/server/import-promotion.test.ts)

- Rendering pinned to the core's own output, so a second renderer cannot pass.
  [`import-preview.test.ts`](../../tests/server/import-preview.test.ts)

- Both guards refuse `promote`; missing confirm and an unbound actor refuse.
  [`import.test.ts`](../../tests/routes/import.test.ts)
