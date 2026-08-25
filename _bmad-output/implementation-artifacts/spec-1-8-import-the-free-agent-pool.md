---
title: 'Story 1.8: Import the Free Agent pool'
type: 'feature'
created: '2026-08-24'
status: 'done'
baseline_commit: '8cd9cc0cecab79996c61e5353aede2d1598777c3'
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-7-import-thirty-team-roster-files.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 1.7 stages thirty Team roster files, but the Free Agent pool — the set of Players available for Nomination — has no import path at all. `/import` refuses any file that does not resolve to a Team, so the thirty-first file of the drop is currently rejected by name.

**Approach:** Add the pool as a **single distinguished staging source keyed by pool** (AD-28) — its own adapter module for the pool CSV's four columns, its own staging tables, and pool-vs-Team file routing in the existing `/import` upload action — so one drop of thirty-one files stages every source independently. Add the cross-source conflict check: a Player in both the pool and a Team's roster refuses, naming the Player and the Team. Promotion of anything remains 1.9's build.

## Boundaries & Constraints

**Always:** Pool CSV knowledge lives only in `adapters/fantrax/pool-file.ts` (AD-24), emitting a domain type with no notion of a file; column names are a documented placeholder, TODO-confirm against a real export (same standing as 1.7's `ROSTER_COLUMNS`). A pool row carries Fantrax player ID, name, position(s) and NBA team (addendum.md B) — **and nothing else**; the adapter never derives, infers, or fails on Minor League Eligibility. Eligibility defaults to **not** eligible, set as a database column default on the staged pool row, never read from the file. Rows join on the Fantrax player ID, never on name; a Player ID repeating within the pool file refuses at content altitude. The pool is exactly one source: re-supplying it replaces the pool alone and leaves all thirty Team sources untouched, and staging it is one transaction (delete+insert+status upsert), mirroring `writeOutcome`. **The two refusal altitudes hold unchanged** — file altitude (the pool file supplied twice in one batch) versus content altitude (bad column, duplicate ID, pool/roster conflict). **A refusal never destroys an already-staged pool**, exactly as 1.7 amended for Teams: on a refusal, read the current status first and write nothing if it is already `staged`. **The pool/roster conflict is order-independent** — it is checked when staging the pool against already-staged rosters, *and* when staging a roster against an already-staged pool, because file order within one drop is arbitrary; either direction refuses naming the Player and the Team. Pool size is reported for explicit confirmation. Status persists server-side and the status surface names the pool alongside the thirty Teams. Route stays `requireCommissioner` + `requireLiveDestination(..., 'import')`, writes through `writeGateway()` only.

**Ask First:** Any change to `resolveTeamByFileName`'s matching rules, or any pool-file-name rule that could shadow a real Team name.

**Never:** Promotion to live tables, or the all-or-nothing thirty-one-source transaction (1.9). Setting or editing Minor League Eligibility (1.10) — this story only establishes the `false` default. Cap Space or slot-ceiling arithmetic for pool rows (a pool Player has no contract). `runTransactionalWrite`/the global lock/`auction_events` — staging is independent Setup state (AD-28), as 1.7 established. Real-export column confirmation (deferred to 1.9/AR-33). Any new destination or route.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Happy path | 31 files as one drop | 30 Teams stage; pool stages as its own source; pool size reported | N/A |
| Pool alone | pool file only | pool stages; all 30 Teams remain outstanding by name | N/A |
| Re-supply pool | corrected pool file | pool rows replaced wholesale; all 30 Team sources untouched | N/A |
| Pool twice in one batch | two pool files in one drop | second refused at file altitude, naming the file | `refused_file` |
| Bad pool content | missing column, blank cell, or duplicate Fantrax Player ID | content refusal naming the row; nothing staged | `refused_content` |
| Conflict, pool last | Player in staged roster, then pool supplied | pool refused, naming the Player and the Team | `refused_content` |
| Conflict, roster last | Player in staged pool, then that Team's roster supplied | roster refused, naming the Player and the Team | `refused_content` |
| Refused re-supply over a staged pool | pool already `staged`, new pool file invalid | pool rows and `staged` status untouched; refusal shown for this attempt only | N/A |
| Eligibility default | any staged pool row | `minor_league_eligible` is `false`, from the column default, never the file | N/A |
| Refresh mid-import | reload after pool staged | pool shows `staged` with its size; outstanding Teams still named | N/A |

</frozen-after-approval>

## Code Map

Everything below extends 1.7's shape; read `spec-1-7-...md`'s Code Map first — the module split, the `StageOutcome` union, and the `writeOutcome` refusal discipline are all reused verbatim rather than re-derived.

- `supabase/migrations/<ts>_pool_import_staging.sql` -- new. `import_pool_source`: a **singleton** status row (`id text primary key default 'pool' check (id = 'pool')` — one row by construction, the pool-keyed analogue of `import_team_sources`' team_id PK), `file_name`, `status` (`staged`/`refused_file`/`refused_content`), `refusal_detail`, `updated_at`. `import_staged_pool_players`: `id uuid pk`, `fantrax_player_id text not null` (unique — the pool is one source, so a duplicate is a defect not a re-supply), `player_name`, `positions text not null`, `nba_team text not null`, `minor_league_eligible boolean not null default false`. RLS enabled+forced, no policies, `revoke all` from `anon`/`authenticated` — copy `20260824000000_import_staging.sql` exactly, including its comment discipline.
- `src/lib/core/types.ts` -- extend: `ParsedPoolRow` (`fantraxPlayerId`, `playerName`, `positions`, `nbaTeam`). No `Money`, no slot kind, no eligibility — a pool row has no contract. Add a Story 1.8 note to the module header as 1.7 did.
- `src/lib/adapters/fantrax/pool-file.ts` -- new, modelled on `roster-file.ts:1-45`: `POOL_COLUMNS` (`Fantrax Player ID`, `Player Name`, `Positions`, `NBA Team` — placeholder, TODO-confirm), `parsePoolCsv(csvText): PoolParseResult` reusing that module's exact structure (same `csv-parse/sync` options, `rowNumber: 0` for file-wide refusals, first-failure-refuses-the-file, blank-cell and duplicate-player-ID checks). Do NOT extract a shared base from `roster-file.ts` — the two column maps must stay independently editable when a real export lands.
- `src/lib/server/pool-registry.ts` -- new: `isPoolFileName(fileName)`, pure. Placeholder rule, documented as TODO-confirm alongside `team-registry.ts`'s: the normalised stem contains `freeagent` or equals `pool`. `isPoolFileName` **must run before Team resolution** in the upload action, so the route can pick a staging function. **The refuse-not-guess check runs inside `stagePoolFile`, not the route** (amended at review-loop-iteration 1): the route holds no Team list and must not grow a second one, whereas `stagePoolFile` already reads `teams` on its own connection. `poolFileNameShadowsTeam` returns a three-way `PoolShadowResult` -- `shadowed` / `ambiguous` / `null` -- because `resolveTeamByFileName` distinguishes `ambiguous` from `unmatched` precisely so a caller can refuse; collapsing `ambiguous` into `null` stages as the pool the file whose Team is least certain.
- `src/lib/server/pool-import.ts` -- new: `stagePoolFile(gateway, fileName, csvText, poolClaimedInBatch)`, mirroring `roster-import.ts:107` (`stageRosterFile`) — connect, `begin`, batch-claim check, **read `teams` and run the shadow check, THEN take the batch claim** (order amended at review-loop-iteration 1), parse, conflict check, write, `commit`; catch/`rollback`/rethrow; `finally` release. Its `writeOutcome` analogue reproduces `roster-import.ts:196-215`'s "read current status first, write nothing if already `staged`" branch. Conflict query: `select p.player_name, t.name from import_staged_rosters p join teams t on t.id = p.team_id where p.fantrax_player_id = any($1)`.
- `src/lib/server/roster-import.ts` -- extend for the other conflict direction only: after `checkSlotCeilings` passes (`roster-import.ts:~168`) and before the successful `writeOutcome`, query the staged pool for any of this file's player IDs and refuse at content altitude if any hit. Nothing else in this file changes.
- `src/lib/core/rules/pool-import.ts` -- new, pure: `POOL_SOURCE_LABEL` (the pool's name on every surface -- it lives here, not in `server/pool-import.ts`, so reading it does not drag `csv-parse` into an unrelated module's graph; amended at review-loop-iteration 1) and `poolConflictRefusalDetail(conflicts)` — the one refusal sentence, naming Player and Team, shared verbatim by both directions so the two paths cannot word it differently. Product voice: state the fact, then the specifics.
- `src/lib/server/import-status.ts` -- extend: `loadPoolStatus(client)` returning `{ status, fileName, refusalDetail, updatedAt, playerCount }` **from ONE query against an `import_pool_status` view** (amended at review-loop-iteration 1 -- two independent reads can return a status and a size that never coexisted, and that size is the figure the Commissioner confirms); validate the status string against the known set rather than casting it, and fold the pool into `outstandingTeamNames`' sibling — add `outstandingSourceNames(statuses, poolStatus)` naming `Free Agent pool` when it is not `staged`, so 1.11's gate reads one list. Keep `outstandingTeamNames` as-is; do not duplicate the "staged vs outstanding" rule (1.7 change-log item 8).
- `src/routes/import/+page.server.ts` -- extend: `load` also returns `pool`; the `upload` loop routes each file — `isPoolFileName` → `stagePoolFile`, else `stageRosterFile` — inside the same per-file try/catch (`+page.server.ts:74`), sharing one batch-claim state. `StageOutcome` gains pool-shaped `staged`/`refused_content` members (a `source: 'pool'` discriminator is cleaner than a nullable `teamId`).
- `src/routes/import/+page.svelte` -- extend: the drop copy says thirty-one files; a pool row in the status list, visibly distinct from a Team row **without colour**; the batch results render a pool stage as `Staged — Free Agent pool ("file"): N players.` (the explicit size confirmation). Declare the pool types structurally, as this file already does for `TeamImportStatus`.
- Tests -- `tests/adapters/fantrax-pool.test.ts` (build fixtures from `POOL_COLUMNS`, never a hardcoded header — 1.7 change-log item 9), `tests/core/pool-import-rules.test.ts`, `tests/server/pool-import.test.ts` and additions to `tests/server/roster-import.test.ts` (stateful fake gateway per `tests/server/shell-write.test.ts`, covering both conflict directions and the refused-re-supply-preserves-staged case), `tests/server/pool-registry.test.ts`, `tests/server/import-status.test.ts`, `tests/routes/import.test.ts` (both gates still refuse). Cover every I/O matrix row.

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/<ts>_pool_import_staging.sql` -- pool staging tables -- AC1, AC3
- [x] `src/lib/core/types.ts` + `src/lib/core/rules/pool-import.ts` -- `ParsedPoolRow`, shared conflict wording -- AC4
- [x] `src/lib/adapters/fantrax/pool-file.ts` -- `parsePoolCsv`, pool columns in one module -- AC2
- [x] `src/lib/server/pool-registry.ts` + `pool-import.ts` -- routing and pool staging -- AC1, AC5
- [x] `src/lib/server/roster-import.ts` -- the roster-side conflict check -- AC4
- [x] `src/lib/server/import-status.ts` + `/import` route and UI -- pool status, size confirmation -- AC3, AC6
- [x] Tests per Code Map -- covers the I/O matrix, both conflict directions

**Acceptance Criteria:**
- Given the codebase, when inspected, then pool CSV column names appear only in `adapters/fantrax/pool-file.ts`, and `core/` sees only `ParsedPoolRow`.
- Given a staged pool row, when read, then it carries Fantrax player ID, name, positions and NBA team, and `minor_league_eligible` is `false` from the column default with nothing in the adapter touching it.
- Given a staged pool, when the Commissioner views `/import`, then the pool appears as its own source with its player count stated for confirmation, distinguishable from a Team row in greyscale.
- Given a Player present in both the pool and a Team's roster, when either file is staged second, then that file is refused at content altitude naming the Player and the Team, with the same sentence in both directions.
- Given a re-supplied pool file, when it stages, then only pool rows are replaced and every Team's staged rows and status are untouched.
- Given a drop of thirty-one files, when uploaded as one batch, then each source stages independently and one file's failure does not abort the rest.

## Spec Change Log

**review-loop-iteration 1 (2026-08-24).** Findings from four parallel review layers (Blind Hunter, Edge Case Hunter, Verification Gap, Acceptance Auditor) against the first implementation pass. The human elected to **patch in place** rather than take the workflow's `bad_spec` revert-and-re-derive loopback; the Code Map above has been amended to match the shipped code, so the spec and the tree agree.

1. **A shadowed file name spent the batch's pool claim on its way to being refused** (Acceptance Auditor and Edge Case Hunter, independently). `stagePoolFile` set `poolClaimedInBatch.claimed = true` *before* the refuse-not-guess shadow check, so in a drop containing an ambiguous name plus the real pool file, the real file was refused as "already supplied" and **the pool never staged at all** -- contradicting the Happy path and Pool-alone matrix rows. Amended: the claim is taken only after every file-altitude check passes. A file that names no single source has not supplied the pool. Regression test added.
2. **`poolFileNameShadowsTeam` collapsed `ambiguous` into "no shadow"** (Blind Hunter and Edge Case Hunter, independently). A pool-looking name matching two Teams returned `null` and staged as the pool -- precisely the guess the function exists to prevent, reached by the one branch that looked safe. Amended: it returns a three-way `PoolShadowResult`, and `stagePoolFile` refuses both `shadowed` and `ambiguous`, the latter naming every candidate Team via a new `poolShadowsTeamsDetail`. Tests added for both.
3. **Root cause of 1 and 2: this spec's own Code Map put refuse-not-guess "in the upload action", which holds no Team list.** The instruction was unimplementable as written; the implementer's relocation into `stagePoolFile` was correct in substance but went wrong twice in the details. Amended: the Code Map now specifies the check where the Team list actually lives, and states the claim ordering explicitly as load-bearing.
4. **`loadPoolStatus` read status and size as two independent queries** (Edge Case Hunter) -- a re-stage committing between them returned a pair that never coexisted, and the size is exactly the figure this story requires be confirmed. Amended: a new `import_pool_status` view (`security_invoker = on`, revoked from the client roles) collapses both into one statement, so Postgres' statement snapshot makes the pair consistent by construction. An unknown status string now falls back to `outstanding` -- under-claiming, so the pool stays named rather than silently passing a gate.
5. **Every `refused_content` test guarded with `if (...) return`, so a wrong `source` reported green** (Verification Gap). A copy/paste slip between the adjacent pool and roster modules would have rendered `"Content refusal -- undefined"` to the Commissioner with nothing failing. Amended: each such test asserts the discriminant before narrowing.
6. **`POOL_SOURCE_LABEL` was written as a literal in `pool-registry.ts`** while a constant existed (Blind Hunter, Verification Gap), and importing that constant dragged `csv-parse` into `import-status.ts`'s graph. Amended: the label moved to the pure core, read from there by every server caller. `+page.svelte` still spells it out -- no `.svelte` file may reach a server-only module, which is architectural, not drift.
7. **`ParsedPoolRow.nbaTeam` documented a three-letter-abbreviation guarantee the parser never enforced** (Blind Hunter). Amended the doc rather than the parser: the pool column shape is an unconfirmed placeholder until 1.9/AR-33, and refusing anything but three capitals would refuse the real export on the strength of a guess. The reasoning is now recorded at the type.
8. **The shared refusal sentence read `"Lakers's roster"`** (Acceptance Auditor, Blind Hunter). Most BBSL Team names are plural. Amended to `"on the Lakers roster"`, with a test asserting the possessive never appears.
9. **A dead `isPoolFileNameAmbiguous` reference in `pool-registry.ts`'s header** (Acceptance Auditor) -- no such function existed. Amended to name the real one.

Findings raised and NOT actioned, with reasons: the inner `join teams` in `findRosterConflicts` allegedly dropping orphan roster rows was **verified false and rejected** -- `import_staged_rosters.team_id` is `not null references public.teams(id)`, so an orphan is unreachable. Cross-request TOCTOU on the conflict check and the same Player on two Teams' rosters are both real but pre-existing in kind (1.7 logged the equivalent per-Team concurrency gap) -- logged to `deferred-work.md`. One test asserting that a *content*-refused pool file releases the batch claim was written and then removed: 1.7 deliberately claims a source on identification, not on success, so two files claiming one source in a drop is ambiguous regardless of content validity -- the pool must follow that precedent, and the shipped behaviour is correct. Rejected as noise: `refused_file` being currently unreachable for the pool (1.7 logged the same for Teams), double blank lines (lint is clean), `pool.updatedAt` loaded but unrendered (Team rows do not render it either), the client-side type redeclaration in `+page.svelte` (architecturally forced), the extra per-roster conflict query (negligible at thirty-one files), and refusal-precedence ordering being undocumented.

**KEEP -- what worked and must survive re-derivation:** the module split (adapter / pure rules / pool-registry / pool-import / status / route), the singleton-table decision over a nullable `team_id`, the order-independent both-directions conflict check through one shared sentence, `stagePoolFile` mirroring `stageRosterFile`'s transaction shape, the predicate-less pool delete that makes "touches no Team source" true by construction, and fixtures built from `POOL_COLUMNS`. Only the nine amendments above change behaviour or wording.

## Design Notes

**Why a singleton table rather than a nullable `team_id` on `import_team_sources`.** That table's PK *is* `team_id` — the constraint that makes "one status per Team" true by construction. Widening it to admit a null would trade that guarantee away for a shared table, and every read would then have to remember to filter. A separate singleton keeps both invariants exact and leaves 1.7's tables untouched.

**Why the conflict is checked in both directions.** AC says the conflict refuses; it does not say which file loses. In a thirty-one-file drop the browser's file order is arbitrary, so a one-directional check would make acceptance depend on ordering — the same two files passing or failing by luck. Checking both directions makes the rule a property of the staged set, and whichever file arrives second is the one refused.

## Verification

**Commands:**
- `npm test` -- all pass, including the purity and pins gates
- `npm run check` / `npm run build` -- clean

**Manual checks (if no CLI):**
- As Commissioner at `/import`, drop the pool file plus a Team file sharing one Player, in both orders; confirm the same refusal sentence names the Player and the Team, and that a greyscale screenshot still distinguishes the pool row from a Team row at 375px.

## Suggested Review Order

**The two file-altitude bugs this round fixed (review-loop-iteration 1)**

- Entry point — the whole pool staging path; read it before anything else.
  [`pool-import.ts:121`](../../src/lib/server/pool-import.ts#L121)

- The claim is taken only here, after every file-altitude check. The ordering is the bug.
  [`pool-import.ts:135`](../../src/lib/server/pool-import.ts#L135)

- `ambiguous` refuses instead of reading as "no shadow" — the line the second bug turned on.
  [`pool-registry.ts:105`](../../src/lib/server/pool-registry.ts#L105)

**One consistent snapshot for the confirmed pool size**

- One query against the view, replacing two reads that could disagree.
  [`import-status.ts:154`](../../src/lib/server/import-status.ts#L154)

- The view itself — Postgres' statement snapshot makes status and size consistent.
  [`import_pool_status`](../../supabase/migrations/20260824010000_pool_import_staging.sql#L157)

**The order-independent pool/roster conflict**

- Pool-last direction: staged rosters checked before the pool commits.
  [`pool-import.ts:145`](../../src/lib/server/pool-import.ts#L145)

- Roster-last direction, so acceptance never depends on file order.
  [`roster-import.ts:239`](../../src/lib/server/roster-import.ts#L239)

- The one shared sentence both directions use; no possessive form.
  [`pool-import.ts:54`](../../src/lib/core/rules/pool-import.ts#L54)

- The label both server callers read, kept in the pure core.
  [`pool-import.ts:35`](../../src/lib/core/rules/pool-import.ts#L35)

**The pool as a distinguished source**

- Eligibility is a column default — never read from the file.
  [`import_staging.sql:114`](../../supabase/migrations/20260824010000_pool_import_staging.sql#L114)

- Pool columns confined to one module, TODO-confirm against a real export.
  [`pool-file.ts:44`](../../src/lib/adapters/fantrax/pool-file.ts#L44)

- Pool routing runs before Team resolution, sharing one batch state.
  [`+page.server.ts:96`](../../src/routes/import/+page.server.ts#L96)

- The pool row, distinguished from a Team row without colour.
  [`+page.svelte:194`](../../src/routes/import/+page.svelte#L194)

**Peripherals**

- Regression test: a shadowed file must not spend the batch's pool claim.
  [`pool-import.test.ts`](../../tests/server/pool-import.test.ts)

- The `ambiguous` case and its multi-Team refusal sentence.
  [`pool-registry.test.ts`](../../tests/server/pool-registry.test.ts)

- Discriminants asserted before narrowing, so a wrong `source` fails.
  [`roster-import.test.ts`](../../tests/server/roster-import.test.ts)

- Single-row view fake; unknown status falls back to outstanding.
  [`import-status.test.ts`](../../tests/server/import-status.test.ts)
