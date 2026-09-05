---
title: 'Assign contract lengths against the Year Allotment'
type: 'feature'
created: '2026-09-04'
status: 'in-review'
baseline_commit: '8494e0eec29ca5a6982ff22769a14a7fe40c94bd'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Auction Phase now ends and the league folds to Contract Assignment, but nothing happens there. `/contract-assignment` is named in the destination catalog with no route behind it, `YEAR_ALLOTMENT` is a constant no code reads, and every Auction Contract carries `contractYears: null` forever — so the dynasty tradeoff the league exists to make cannot be made, and Story 6.3's export can never unblock.

**Approach:** Give a Manager a surface listing the Players their Team won with no length yet, and let them spend one 4-year, one 3-year, two 2-year and unlimited 1-year deals across them, with the remaining allotment in front of them and an over-spend refused in words. Assignment is an appended event folded back into the contracts projection — no contracts table, no stored length column — and a separate two-part act submits the Team as final.

## Boundaries & Constraints

**Always:**
- The allotment arithmetic is pure core, reading only folded state. Counting the remaining allotment, deciding which lengths are still offerable, and refusing an over-spend all live in `src/lib/core/rules/` and are reachable with no database.
- Latest assignment per Player wins. Re-assigning frees the length it previously held, so the allotment a refusal is computed against must exclude the Player being re-assigned. Corrections append; nothing is updated or deleted.
- The 1-year deal is always offerable. It has no count and can never be exhausted.
- Both acts are two-part: choosing a length and confirming it, and submitting the Team as final. The server refuses an unconfirmed post independently of the UI, as `nominate` already does.
- Once a Team has submitted as final, further assignment is refused server-side. Before that, assignment is freely changeable.
- Every accepted act appends an event carrying the acting Manager and Team.
- The allotment governs Auction Contracts only. `team_rosters` is never written.

**Ask First:**
- Any change to `src/lib/core/rules/close.ts` — its own `contractYears: null` is a close's UNSET record and is a Tier A surface belonging to Story 3.4.
- Adding any table or column to hold a contract length.

**Never:**
- No `contract_length` / `contract_years` column and no contracts table. An Auction Contract is a fold of `auction_events`; a stored length would be derived state in a table. The three deferred-work entries that predicted a column (`:460`, `:517`, `:556`) predicted it wrongly.
- No default assignment on any code path, and no deadline handling — the deadline, the reminders and the completion roster are Story 6.2, and the Commissioner assigning on a Team's behalf is Story 7.3.
- No export, no export gate, no `/assignment-monitoring` or `/export-gate` route.
- No future-year escalation. Amount and length are recorded; nothing computes a later year's figure.
- No change to Existing Contracts.
- No Year Allotment column swap on the persistent strip, `/teams` or `/teams/[teamId]`, despite `deferred-work.md:460`, `:517` and `:556` naming this story as owner. `teams-index.ts` has no `LeaguePhase` import and no phase branch, and `TeamView` carries no phase field, so the swap threads phase through two deliberately phase-agnostic core modules — a separate deliverable, buildable only once this story's fold exists. Ratified at the step-02 checkpoint and re-logged.
- The abbreviated `formatMoney` form stays the only on-screen money rendering; no exact-figure fallback.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First assignment | Team won 5, allotment untouched, assigns 4yr to P1, confirmed | Accepted; event appended; 4-year now shown used | N/A |
| Allotment exhaustion (§10 ex. 14) | 4yr, 3yr and both 2yr spent; assigns 3yr to P5 | Refused, stating what remains; only 1-year offerable | Refusal names the exhausted length |
| Free re-assignment | P1 holds 4yr, Team not final, re-assigns P1 to 2yr | Accepted; the 4-year returns to the allotment | N/A |
| Re-assign to same length | P1 holds 4yr, Team not final, re-assigns P1 to 4yr | Accepted, not refused as exhausted — P1's own 4-year is excluded from the count | N/A |
| Unconfirmed post | Length chosen, confirm absent | Refused | `fail(400, { notice })` |
| Assignment after final | Team submitted as final, assigns any length | Refused, stating the Team is final | `fail(409, { notice })` |
| Submit with lengths unset | Team has Players still unset, submits as final | Refused, naming how many remain unset | `fail(409, { notice })` |
| Non-Manager / unbound actor | Session carries no Team | Refused | `fail(403, { notice })` |
| Wrong phase | Phase is Auction or Archived | Route refuses server-side before any read | `requireLiveDestination` 403 |

</frozen-after-approval>

## Code Map

- `src/lib/core/projection/contracts.ts` -- `AuctionContract.contractYears` is `readonly contractYears: null` at `:100` (comment `:72-77`); `contractsReducer` at `:285-296` folds `AUCTION_CLOSED_EVENT` only; `readPayload` hardcodes `contractYears: null` at `:265`. `contractsWonBy(contracts, teamId)` at `:198` already returns one Team's contracts, newest close first. Widen the field to `ContractYears | null` and fold the new event here.
- `src/lib/core/rules/close.ts` -- `:384` declares its OWN `contractYears: null` on the close outcome and `:536` sets it. READ-ONLY: a close still records UNSET. Do not widen this one.
- `src/lib/core/constants.ts` -- `YEAR_ALLOTMENT = Object.freeze({ fourYear: 1, threeYear: 1, twoYear: 2 })` at `:133-137`, with `:128-132` noting one-year deals are unlimited and therefore uncounted. Currently read by nothing.
- `src/lib/core/projection/nominations.ts:98` -- `AUCTION_CLOSED_EVENT`, the house pattern for declaring an event-type constant beside the reducer that owns it. Follow it for the new constants.
- `src/lib/core/types.ts:91-133` -- `EventEnvelope` and `AppendedEvent` shapes for the new payloads.
- `src/lib/shell/write.ts` -- `runTransactionalWrite` (lock -> load -> decide -> persist -> enqueue, `:4`); `Decision` `:73-75`, `DecideFn` `:78-81`, optional `projections` `:239`. This story registers NO projection updater.
- `src/lib/server/close.ts:240-319` -- the worked example of a server command: one `loadEventsViaClient` read folded into state (`:123-168`), then `decide` returning the core's outcome (`:316`).
- `src/lib/core/rules/nomination.ts:96-112, :207` -- `NominationRefusal` discriminated union and `refuseNomination`; copy this refusal shape and its `*RefusalDetail` wording split.
- `src/routes/nominate/+page.server.ts:85-156` and `+page.svelte:73-97, :231-242, :259-269` -- the ONLY existing two-part act: separate selection and `confirmed` checkbox, submit disabled until both, server independently refusing `confirm !== 'yes'` (`+page.server.ts:103-110`), refusal rendered as prose in a `role="status"` div. Build both acts to this pattern.
- `src/lib/server/destinations.ts:85-91` -- the Contract Assignment catalog ALREADY carries `destination('contract-assignment', 'Contract Assignment', '/contract-assignment', false)`. READ-ONLY: no catalog change; `assignment-monitoring` and `export-gate` stay unbuilt.
- `src/routes/notifications/+page.server.ts:65-87` -- `requireLiveDestination` called in `load` AND re-called in every action.
- `tests/routes/nominate.test.ts:34-58` -- route tests real-import `+page.server.ts` and mock only the server module and `$lib/shell/db.ts`, leaving `requireLiveDestination` real so the guard genuinely fires.
- `tests/structure.test.ts:88-144` -- `SECTION_10_EXAMPLES` is the manifest a new `tests/examples/` file must be registered in.
- `tests/examples/example-13-league-clock.test.ts` -- structure for a §10 example test: PRD text in the header block, a literal `LOG` of `AppendedEvent`s, `fold(INITIAL_*, LOG, reducer)`, no DB.
- `src/lib/core/money.ts:169-187` -- `formatMoney` for the on-screen `$14.5M` form.
- `_bmad-output/planning-artifacts/prds/.../prd.md:765` -- §10 example 14 verbatim.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/projection/contracts.ts` -- declare `CONTRACT_LENGTH_ASSIGNED_EVENT`, export a `ContractYears = 1|2|3|4` type, widen `contractYears` to `ContractYears | null`, and fold the new event so the latest assignment per Player wins -- the length must live on the contract the export and every read surface already reach.
- [x] `src/lib/core/projection/assignments.ts` -- new: declare `ASSIGNMENTS_SUBMITTED_EVENT` and fold the set of Teams that have submitted as final -- submission is per-Team state, not per-contract, and Story 6.2 monitors it.
- [x] `src/lib/core/rules/contract-assignment.ts` -- new: remaining allotment from a Team's contracts, which lengths are still offerable, and a refusal union covering exhausted length, already-final, unset-on-submit, unconfirmed and unbound actor -- excluding the Player being re-assigned from the count is the whole subtlety.
- [x] `src/lib/server/contract-assignment.ts` -- new: load a Team's won contracts plus submission state from one event read; `assignContractLength` and `submitAssignmentsFinal` through `runTransactionalWrite`, re-deriving every gate inside the transaction.
- [x] `src/routes/contract-assignment/+page.server.ts` -- new: `requireLiveDestination(..., 'contract-assignment')` in `load` and re-called in both actions; `load` lists won Players with their current length and the remaining allotment.
- [x] `src/routes/contract-assignment/+page.svelte` -- new: single-column at 375px, remaining allotment stated as the Manager assigns, exhausted lengths not offerable, both acts two-part, refusals as prose in a `role="status"` div.
- [x] `tests/core/contract-assignment.test.ts` -- new: the allotment rules and every I/O Matrix row, with no database.
- [x] `tests/examples/example-14-allotment-exhaustion.test.ts` + `tests/structure.test.ts` -- new example test and its manifest registration -- the AC names §10 example 14 as a named test.
- [x] `tests/projection-contracts.test.ts` -- extend: the fold's latest-wins behaviour and the widened field.
- [x] `tests/server/contract-assignment.test.ts` and `tests/routes/contract-assignment.test.ts` -- new: the command's gates inside the transaction, and the route's guard, load and both actions.

**Acceptance Criteria:**
- Given a Team that won Players, when a Manager opens `/contract-assignment`, then every won Player with an unset length is listed and 1, 2, 3 and 4 years are offerable subject to the allotment.
- Given the phase is not Contract Assignment, when the route is requested directly, then it refuses server-side before any read.
- Given a Team has spent its 4-year, 3-year and both 2-year deals, when a Manager assigns any remaining Player, then only the 1-year is offerable and a longer choice is refused stating what remains.
- Given a Team that has not submitted as final, when a Manager changes an existing assignment, then it is accepted and the previously held length returns to the allotment.
- Given a Team that has submitted as final, when any further assignment is posted, then it is refused server-side.
- Given an accepted act, when it is recorded, then an event is appended carrying the acting Manager and Team, and no code path writes a length without one.

## Design Notes

**Latest-wins is the whole fold.** `contractsReducer` keys contracts by `fantraxPlayerId`, so `ContractLengthAssigned` sets `contractYears` on that Player's contract and a later event for the same Player overwrites it. The allotment is then simply a count over the current folded lengths — no separate ledger, and a correction needs no compensating event.

**The re-assignment trap.** Refusing an over-spend must count the Team's lengths *excluding the Player being assigned*. Counting inclusively would refuse re-assigning P1 from 4-year to 4-year, and would also refuse moving P1 from 4-year to 2-year whenever both 2-year deals were already spent elsewhere — even though the move frees a 4-year. Compute the remainder against `contractsWonBy(...)` filtered to `contract.fantraxPlayerId !== command.fantraxPlayerId`.

**Why no persisted column.** `contracts.ts:1-45` states there is no contracts table: an Auction Contract is a fold. The three deferred-work entries each predicted "an event, a fold and a persisted column"; the column half was a guess made from the read surfaces, and adding one would put derived state in a table.

## Verification

**Commands:**
- `npm test` -- expected: all suites green, including the new `example-14` file and `tests/structure.test.ts`'s manifest check.
- `npm run check` -- expected: clean. Widening `contractYears` is the type change most likely to surface consumers; `src/lib/core/rules/close.ts` must NOT be among them.
- `git diff --stat` -- expected: nothing under `supabase/migrations/`, nothing in `src/lib/core/rules/close.ts`, nothing in `src/lib/server/destinations.ts`.
