---
title: 'Story 1.7: Import thirty Team roster files'
type: 'feature'
created: '2026-08-24'
status: 'done'
baseline_commit: 'ac6b646fd78d097897184e841ea276f2f2ed4dc2'
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `adapters/fantrax/` is empty and no staging schema, import route, or upload UI exists — the Commissioner has no way to get starting rosters into the app.

**Approach:** Build the Fantrax roster adapter (CSV parsing confined per AD-24), a pure core rules module for Cap Space/slot-ceiling validation, staging tables keyed by Team, and a Commissioner-only `/import` route accepting up to 30 files as one drop, staging each independently with per-file status. Promotion to live tables is 1.9's build.

## Boundaries & Constraints

**Always:** CSV knowledge lives only in `adapters/fantrax/` (AD-24), emitting domain types. Rows join on Fantrax player ID, never name. A file resolves to one Team by file name; every row's Fantrax Team ID must agree with every other row **in that same file** (internal consistency — `teams` carries no stored Fantrax Team ID for a row to be checked against; nothing in this story's scope establishes one). Two refusal altitudes: **file** (no match, or already supplied — nothing staged) vs **content** (bad column, a row's Team ID disagreeing with the file's own, negative Cap Space, slot ceiling breach — names the row/arithmetic). Cap Space = `SALARY_CAP − Σ(cap hits)`, Minor League rows = `$0`, vs `ACTIVE_BENCH_SLOTS`/`INJURY_RESERVE_SLOTS`/`MINOR_LEAGUE_SLOTS`. **A successful stage** replaces only that Team's rows (delete+insert, one transaction). **A refusal never deletes a Team's already-staged rows** — a Team already `staged` stays `staged`, rows untouched, when a later re-supply attempt for it fails; only a Team with no currently-staged rows records the refusal's status/detail. Status persists server-side (refresh/return-later resumes), outstanding Teams named not counted. Route: `requireCommissioner` + `requireLiveDestination(..., 'import')` at `/import`, service-role writes only.

**Never:** Promotion to live tables (1.9). Pool import (1.8). Minor League Eligibility (not a CSV column). `runTransactionalWrite`/global lock/`auction_events` (staging is independent per-Team Setup state, not the auction log). Real-export column confirmation (deferred to 1.9/AR-33) — columns are `addendum.md`'s documented placeholder shape, TODO-confirm.

## I/O & Edge-Case Matrix

| Scenario | Input | Behavior | Error |
|---|---|---|---|
| Happy path | 30 valid files | all stage; status lists each Team `staged` | N/A |
| Unmatched/duplicate file | no Team match, or already supplied | file-altitude refusal naming file/Team; nothing staged | `refused_file` |
| Bad column / row Team ID mismatch | row invalid | content refusal naming the row; file not staged | `refused_content` |
| Negative Cap Space / ceiling breach | Σ(hits,Minors=$0)>cap or ceiling exceeded | refusal states the arithmetic | `refused_content` |
| Re-supply after fix | corrected file, staged/refused Team | old rows replaced; other 29 untouched | N/A |
| Refused re-supply over a staged Team | already-`staged` Team, new file invalid | rows untouched, Team stays `staged`; refusal shown for this attempt only | N/A |
| Refresh mid-import | reload at 10/30 staged | shows 10 staged, 20 outstanding by name | N/A |

</frozen-after-approval>

## Code Map

- `supabase/migrations/<ts>_import_staging.sql` -- new: `import_team_sources` (team_id PK/FK, file_name, status: staged/refused_file/refused_content, refusal_detail, updated_at) + `import_staged_rosters` (id, team_id FK, fantrax_player_id, player_name, cap_hit, roster_slot_kind: active_bench/injury_reserve/minor_league, contract_years_remaining). RLS enabled+forced, no policies -- matches `teams.sql`.
- `src/lib/core/types.ts` -- extend: `RosterSlotKind`, `ParsedRosterRow`.
- `src/lib/core/rules/roster-import.ts` -- new, pure: `computeCapSpace`, `checkSlotCeilings` vs `core/constants.ts`.
- `src/lib/adapters/fantrax/roster-file.ts` -- new: column map (`addendum.md`), `parseRosterCsv` via one exactly-pinned CSV dep (e.g. `csv-parse`).
- `src/lib/server/team-registry.ts` -- new: `resolveTeamByFileName` only. **`listOutstandingTeams` removed at review-loop-iteration 1** — it duplicated `import-status.ts`'s outstanding logic against a separate query, two independently-drifting implementations of the same rule with no production caller; `import-status.ts` is the one source.
- `src/lib/server/roster-import.ts` -- new: `stageRosterFile(client, fileName, csvText)` -- checks, then writes; injectable client (mirrors `resolveLeaguePhase`). **`writeOutcome`, amended at review-loop-iteration 1:** on success, delete+insert+upsert `staged` as before. On a refusal, first read the Team's current `status`; if it is already `staged`, write nothing (rows and status untouched — see Boundaries); otherwise upsert `refused_content`/`refused_file`-appropriate status/detail (nothing to lose, since no rows are staged). **Also at iteration 1:** the per-file loop in `+page.server.ts`'s `upload` action wraps each `stageRosterFile` call so one file's thrown error becomes a `refused_content`-shaped result for that file rather than aborting the remaining files in the batch; a zero-byte `File` is no longer filtered out before staging (it now reaches `parseRosterCsv`, which already refuses an empty file, so every supplied file gets a status); `parseRosterCsv` also refuses a row whose Fantrax Player ID repeats one already seen in the file, and refuses a row whose Cap Hit parses as negative or whose Contract Years Remaining exceeds Postgres `integer`'s range; `capSpaceRefusalDetail`/`slotCeilingRefusalDetail` use the true minus sign (U+2212, matching `money.ts`'s `MINUS_SIGN`) rather than an ASCII hyphen.
- `src/lib/server/import-status.ts` -- new: `loadImportStatus(client)` -- joins `teams` × `import_team_sources`.
- `src/routes/import/+page.server.ts`, `+page.svelte` -- new: gated `load`; `actions.upload` runs `stageRosterFile` per file (idiom per `commissioner-recovery`); status UI, altitudes visibly distinct, 375px-operable.
- Tests: `tests/core/roster-import-rules`, `tests/adapters/fantrax-roster`, `tests/server/roster-import` (fake-client per `shell-write.test.ts`), `tests/routes/import` -- cover the matrix, including the iteration-1 amendments above. **`tests/server/roster-import.test.ts`, iteration 1:** build its CSV fixtures from `ROSTER_COLUMNS` (as `tests/adapters/fantrax-roster.test.ts` already does) rather than a hardcoded header string, so a future column-name change stays a one-file edit.
- `tests/structure.test.ts` -- drop `fantrax` from the empty-dir expectation. `package.json` -- pin the CSV dependency exactly.

## Tasks & Acceptance

**Execution:**
- [x] Staging migration -- AC1
- [x] Core types + pure rules (`computeCapSpace`, `checkSlotCeilings`) -- AC1
- [x] Fantrax adapter (`parseRosterCsv`) -- AC1
- [x] Server layer (`team-registry`, `roster-import`, `import-status`) -- AC1-AC5
- [x] `/import` route + UI -- AC2-AC5
- [x] Tests per Code Map, `structure.test.ts`, `package.json` -- covers matrix + housekeeping

**Acceptance Criteria:**
- Given the codebase, when inspected, then CSV knowledge exists only in `adapters/fantrax/`, rows join on Fantrax player ID, and `core/` sees only parsed domain types.
- Given 30 files as one batch, when parsed, then each resolves independently to one Team, stages keyed by Team, and Cap Space computes as specified.
- Given a file matching no/an already-supplied Team, when processed, then it's refused at file altitude, naming the file.
- Given invalid content, when processed, then it's refused at content altitude, naming the row/arithmetic, visibly distinct from a file refusal.
- Given an in-progress import, when refreshed or resumed later, then status has persisted and re-supply replaces only that Team's rows.
- Given a Team that is already `staged`, when a later re-supply attempt for it is refused, then its previously staged rows and `staged` status are untouched — only the batch's own result communicates the failed attempt.

## Spec Change Log

**review-loop-iteration 1 (2026-08-24).** Triggering findings, from four parallel review layers (Blind Hunter, Edge Case Hunter, Verification Gap, Acceptance Auditor) against the first implementation pass:

1. **Row Fantrax Team ID check read as stronger than achievable, independently caught by three of four layers.** The frozen Boundaries said each row's Team ID "must also match" the file's resolved Team, but `teams` stores no Fantrax Team ID for a row to be checked against — the implementation could only, and did, check that every row in a file agrees with every other row. Put to the human: confirmed as the intended, only-achievable reading (adding a stored Fantrax Team ID was declined as new, unplanned scope). Amended: Boundaries reworded to state the actual check precisely. **No code change** — the shipped behavior was already correct under this reading.
2. **A refused re-supply destroyed a Team's already-good staged rows** (Acceptance Auditor, independently noted by Blind Hunter). `writeOutcome` deleted a Team's `import_staged_rosters` unconditionally, including on a content-altitude refusal — so a Commissioner whose Team was already correctly staged could lose that data to an unrelated typo in a later re-upload. Put to the human: **refusals must never delete already-staged rows.** Amended: Boundaries and the I/O matrix now state that a `staged` Team's rows and status survive a failed re-supply attempt; only a Team with nothing currently staged records a refusal's status/detail. `writeOutcome` reads current status first and branches accordingly.
3. **`import_team_sources.status = 'refused_file'` was specified but written by nothing** (Blind Hunter, Acceptance Auditor) — a file-altitude refusal existed only in the upload action's transient return value, invisible after a refresh. Not amended as a defect: given finding 2's resolution, the only case where persisting it would matter (a Team with nothing staged) already persists the equivalent `refused_content`-shaped outcome where the refusal originates from content, and a pure file-name-match refusal has no `team_id` to key by in the no-match case. Logged to `deferred-work.md` rather than built now.
4. **One file's thrown error aborted the rest of the upload batch**, contradicting the Intent's "staging each independently" (Edge Case Hunter, Acceptance Auditor). Amended: the `upload` action's per-file loop now contains each call, converting a thrown error into that file's own refused result.
5. **A zero-byte file was filtered out before staging, receiving no status at all** (Edge Case Hunter, Acceptance Auditor). Amended: no size filter before staging; `parseRosterCsv`'s existing empty-file refusal now covers it.
6. **A duplicate Fantrax Player ID within one file, a negative per-row Cap Hit, and an out-of-`integer`-range Contract Years Remaining were all accepted** (Blind Hunter, Edge Case Hunter, Verification Gap's "Other findings"). Amended: `parseRosterCsv` refuses all three at content altitude.
7. **The Cap Space refusal used an ASCII hyphen for a negative amount**, at odds with `epic-1-context.md`'s "true minus sign for negatives" (Acceptance Auditor). Amended: the refusal formatters use U+2212, matching `money.ts`'s own `MINUS_SIGN`.
8. **`team-registry.ts`'s `listOutstandingTeams` and `import-status.ts`'s `outstandingTeamNames`/`loadImportStatus` independently computed the same "outstanding" rule against separate queries, with no production caller of the former and no test catching a divergence** (Blind Hunter, Verification Gap). Amended: `listOutstandingTeams` removed; `import-status.ts` is the one source, as the route already used.
9. **CSV header text was hardcoded in `tests/server/roster-import.test.ts` rather than derived from `ROSTER_COLUMNS`**, undermining the adapter's "one-file edit" claim for a future column-name confirmation (Acceptance Auditor). Amended: derive it the same way `tests/adapters/fantrax-roster.test.ts` already does.

Findings raised and NOT actioned, with reasons: no hard cap on batch file count (naturally bounded — only 30 real Teams exist to match against, and excess/mismatched files already refuse at file altitude); "already supplied" checked only within one upload batch, not against a Team already `staged` from an earlier batch (confirmed correct — re-supply of an already-`staged` Team is the explicitly intended path, not a duplicate); no DB-level uniqueness/non-negativity constraints on `import_staged_rosters` (redundant defense-in-depth once the app-level checks from finding 6 exist); row-by-row sequential inserts, no file-size guard, no cross-request concurrency lock on one Team, no audit trail for staging, only the first invalid row reported per attempt, no client-side file-count hint, phase not re-checked mid-batch — all logged to `deferred-work.md` as accepted tradeoffs or out of this story's scope (staging audit logging in particular arrives with promotion, per 1.9's AC, not here). One reviewer-reported concern was independently verified false and dropped: the `baseline_commit` hash is a valid 40-character SHA-1 (`git cat-file -t` resolves it to `commit`).

**KEEP — what worked and must survive re-derivation:** the overall shape (adapter/core-rules/server/route split, `stageRosterFile`'s single-transaction-per-file design, the two-refusal-altitude framing, the status-and-rows-in-lockstep schema) is sound; only the nine amendments above change behavior or wording.

## Design Notes

**Why staging skips `runTransactionalWrite`/the global lock.** That pipeline is for the append-only `auction_events` log under cross-Team contention; staging is independent per-Team Setup state, kept separate by AD-28. Promotion's all-or-nothing transaction is 1.9's job — a per-file local transaction suffices here since files never contend for the same Team's rows.

## Verification

**Commands:**
- `npm test`/`check`/`build` -- all pass; purity + pins gates pass.

**Manual checks (if no CLI):**
- As Commissioner, drop valid/misnamed/malformed files at `/import`; confirm refusals are distinguishable without colour, at 375px.

## Suggested Review Order

**A refused re-supply must not destroy a Team's good data (review-loop-iteration 1)**

- Entry point — resolves the Team, parses, validates, then writes; every write funnels through `writeOutcome` below.
  [`roster-import.ts:107`](../../src/lib/server/roster-import.ts#L107)

- Reads the Team's current status before writing a refusal; a `staged` Team's rows and status survive untouched.
  [`roster-import.ts:196`](../../src/lib/server/roster-import.ts#L196)

- The branch itself — the one line this whole amendment turns on.
  [`roster-import.ts:204`](../../src/lib/server/roster-import.ts#L204)

**Content-altitude validation — one CSV knowledge module (AD-24)**

- The parse loop: header/blank checks, then the two consistency checks added this round.
  [`roster-file.ts:98`](../../src/lib/adapters/fantrax/roster-file.ts#L98)

- Duplicate Fantrax Player ID within one file is unresolvable, not merely untidy — refused, not silently kept.
  [`roster-file.ts:163`](../../src/lib/adapters/fantrax/roster-file.ts#L163)

- `parseMoney` alone accepts a negative string; this closes the gap it leaves open for a per-row Cap Hit.
  [`roster-file.ts:180`](../../src/lib/adapters/fantrax/roster-file.ts#L180)

- Bounds Contract Years Remaining to Postgres `integer`, so a too-large value refuses here instead of throwing at the INSERT.
  [`roster-file.ts:52`](../../src/lib/adapters/fantrax/roster-file.ts#L52)

**Two refusal altitudes, and one file's failure no longer sinks the batch**

- Gated the same way on both `load` and `upload` — hiding the form is never the check.
  [`+page.server.ts:32`](../../src/routes/import/+page.server.ts#L32)

- A zero-byte file now reaches `parseRosterCsv` instead of being silently dropped before staging.
  [`+page.server.ts:55`](../../src/routes/import/+page.server.ts#L55)

- Per-file try/catch — a thrown error becomes that file's own result rather than aborting the rest of the drop.
  [`+page.server.ts:74`](../../src/routes/import/+page.server.ts#L74)

- The fourth, `error` branch this amendment added, rendered visibly distinct from a content refusal.
  [`+page.svelte:130`](../../src/routes/import/+page.svelte#L130)

**Team resolution and the staging schema**

- Matches a file to one Team by name — exact match first, substring fallback, refuses rather than guessing when ambiguous.
  [`team-registry.ts:61`](../../src/lib/server/team-registry.ts#L61)

- Per-Team status row — the PK is the Team FK, so re-supply is an upsert, not a query.
  [`import_staging.sql:49`](../../supabase/migrations/20260824000000_import_staging.sql#L49)

- Staged roster rows, replaced wholesale only on a successful stage (see the first concern above).
  [`import_staging.sql:88`](../../supabase/migrations/20260824000000_import_staging.sql#L88)

**Cap Space, slot ceilings, and the true minus sign**

- Minor League rows always contribute $0 to the sum, regardless of what the file states for them.
  [`roster-import.ts:40`](../../src/lib/core/rules/roster-import.ts#L40)

- Every roster slot kind checked against its league ceiling at once, not just the first breach found.
  [`roster-import.ts:71`](../../src/lib/core/rules/roster-import.ts#L71)

- U+2212, not a hyphen — added this round to match `money.ts`'s own convention for negative amounts.
  [`roster-import.ts:106`](../../src/lib/core/rules/roster-import.ts#L106)

**The status surface**

- The one place "staged vs. outstanding" is decided, joining `teams` × `import_team_sources`.
  [`import-status.ts:53`](../../src/lib/server/import-status.ts#L53)

- Outstanding Teams named, never counted — the source both the summary line and the status list read from.
  [`import-status.ts:82`](../../src/lib/server/import-status.ts#L82)

**Peripherals**

- The stateful fake gateway proving a refused re-supply leaves an already-`staged` Team's rows and status alone.
  [`roster-import.test.ts`](../../tests/server/roster-import.test.ts)

- Content-altitude coverage for the three checks added this round: duplicate ID, negative Cap Hit, oversized years.
  [`fantrax-roster.test.ts`](../../tests/adapters/fantrax-roster.test.ts)

- Proves both server-side gates actually refuse, independent of what any client renders.
  [`import.test.ts`](../../tests/routes/import.test.ts)

- `resolveTeamByFileName`'s pure matching cases; `listOutstandingTeams` and its fakes removed this round (duplicated `import-status.ts`).
  [`team-registry.test.ts`](../../tests/server/team-registry.test.ts)

- `loadImportStatus`/`outstandingTeamNames` against a fake Supabase client.
  [`import-status.test.ts`](../../tests/server/import-status.test.ts)

- Pure Cap Space/slot-ceiling arithmetic, and the refusal wording's true-minus-sign rendering.
  [`roster-import-rules.test.ts`](../../tests/core/roster-import-rules.test.ts)

- Drops `fantrax`/`rules` from the empty-directory expectation now that both hold real files.
  [`structure.test.ts`](../../tests/structure.test.ts)
