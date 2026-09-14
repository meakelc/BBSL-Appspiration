---
title: 'Story 7.7: Record a Roster Move'
type: 'feature'
created: '2026-09-10'
status: 'done'
review_loop_iteration: 1
baseline_commit: 'f609d285d1b421aa7e0c21839a70a15def4d2eb0'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Managers agree trades in Discord and execute them in Fantrax, and the app never hears. Both Teams' Cap Space, Roster Count and Slot occupancy then drift from reality for the rest of the auction, so every Maximum Bid either Team is shown is wrong. There is no command type that moves a Contract between Teams, and `contractsReducer` has no case that could fold one.

**Approach:** A third command type, `RecordRosterMove`, with its own fixed gate set evaluated **once over post-Move state** for both Teams; one `RosterMoveRecorded` event carrying the whole delta, appended under the global lock in the same transaction that `UPDATE`s the moved Existing Contracts' `team_id`; and a Commissioner destination whose two-Team reason sheet states both Teams' before → after side by side.

## Boundaries & Constraints

**Always:**
- **One act, one evaluation, at the end** (§10 example 39). Departures apply first, then arrivals; both Teams are judged against the resulting state. Never a direction at a time, never a Team at a time.
- **Refuse, never cancel.** A failing gate refuses the *whole* Move and writes nothing, naming the Team, the gate, the Auction and the arithmetic. No Bid is stood down: FR-40's cancellation trigger stays a Close and only a Close, and the sheet offers no control that would change that.
- **Reuse `bidding.ts`'s arithmetic as pure helpers.** Never synthesize a `PlaceBid` or a `RestoreLeadingBid` to force-pass gates that do not apply — AD-7 defines the cap gate as single-Team and incremental, and two Teams' opposing deltas may not be routed through it. This story writes **no** affordability check of its own (AR-42).
- **Existing Contracts move by `UPDATE` of `team_id`**, never delete-then-insert (`fantrax_player_id` is unique across every Team, AR-41). Auction Contracts have no row and move by the event alone, folded **latest-transfer-wins**.
- **Either direction may be empty** — a salary dump is a Roster Move (§10 example 36). A Move with *both* directions empty is refused as naming nothing.
- **A Player contested in an open Auction is refused by the rules core**, as a third ground checked **before** cap and slots, which are meaningless for a Player nobody holds.
- One transaction under the global write lock (AD-6): a Move that moved three Players of five is unreachable.
- The event carries the **whole delta** — every Player, both Teams, both Slot kinds, both Cap Hits — so a replay reproduces the world.

**Ask First:**
- Any rule that re-places an `injury_reserve` row on arrival, or that reads `free_agent_players.minor_league_eligible` for a rostered Player. See Design Notes for the placement rule this spec settles on.
- Widening `SlotPlacement` beyond its two members, or giving `RosterMoveRecorded` a case in any reducer other than `contractsReducer`.
- Any change to `evaluateCap`'s or `evaluateSlots`' returned shape or pass/fail expression while extracting the shared helper.

**Never:**
- Dead Money, the Drop command, or the 2RK release rule (Story 7.8). A Move never creates Dead Money.
- Divergence detection (7.9), the Audit Log surface (7.5), Bid voiding (7.2).
- **Discord.** A Roster Move is the one Commissioner act that is not broadcast.
- Proving the FR-30 export re-block — Story 6.3 has not shipped. Clear the length and return the year; assert at that altitude only.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Salary dump (§10 ex 36) | A: count 11, cap $3M, leads nothing; sends Curry (active_bench, hit $14M), receives none | Commits. A: count 10, cap $17M, Maximum Bid **$16M**. B: count 9, cap $16M | N/A |
| Sender pushed over (§10 ex 37) | C: count 11, cap $6.7M, leads one Auction at $6.5M; sends a $500k hit away | **Refused.** Names C, the cap gate, the Auction, and the **$300,000** shortfall | Rejection, not a throw |
| Stash becomes expensive (§10 ex 38) | D holds Ellis, minors, won $18M, hit $0; E holds 3 minors, count 9, cap $20M | Ellis lands **active_bench** on E, hit **$18M**, winning amount **$18M** unchanged. E: count 10, cap $2M. D's free minors 0→1, Minors Exposure recomputes across every eligible Auction D still leads | N/A |
| One evaluation (§10 ex 39) | F count 12 sends 3, receives 2; G count 10 sends 2, receives 3 | Commits: F 11, G 11. The transient F=14 state is never evaluated | N/A |
| Length cleared (§10 ex 42) | Contract Assignment Phase; J trades Powell, assigned 3 years, to K | `contractYears` **cleared**; J's 3-year returns to its Year Allotment; Powell arrives unassigned | N/A |
| Contested Player | A Move naming a Player leading or nominated in an open Auction | **Refused** by the core on the contested ground, before cap and slots run | Rejection naming the Player and the Auction |
| Both directions empty | A Move naming two Teams and no Players | Refused — the act names nothing | Rejection |
| Same Team both sides | `sendingTeamId === receivingTeamId` | Refused | Rejection |
| Blank reason | A submitted Move with an absent or whitespace reason | Refused **server-side**, nothing written | 400 via `requireOverrideReason` |
| Archived phase | A Move submitted once the auction is archived | Refused | 403 via `requireOverridablePhase` |
| Two minors arrive, one slot | E has 1 free Minor League Slot; two eligible minors rows arrive | Sorted by `fantraxPlayerId`: the first takes the Slot, the second takes Active/Bench and charges its hit | N/A |

</frozen-after-approval>

## Code Map

**The command and its gate set (the AD-1/AD-2 precedent is `RestoreLeadingBid`):**
- `src/lib/core/types.ts:863-941` -- the `RestoreLeadingBid` block: command type, `RESTORE_LEADING_BID_GATES` (frozen `as const`), gate name type, gate-results type. **Copy this shape exactly** for `RecordRosterMove`. `GateResults` (`:314`) is `Readonly<Record<string, GateOutcome>>` — so the gate set must stay **flat**; do not nest a per-Team object inside it.
- `src/lib/core/rules/restore.ts:150-200` -- `selectRestoration`: how a second command type composes `bidStateFor` + `teamMoneyStateFor` + the gate evaluator with no arithmetic of its own. `:234-278` `candidateStands` is the exact reuse pattern.
- `src/lib/core/rules/restore.ts:57-77` -- `CandidateRosterFigures`, the core's structural restatement of `TeamRosterFigures` (the core may not import the shell, AD-2). A Move needs the same three figures per Team.

**The arithmetic to reuse — currently module-private, and that is the work:**
- `src/lib/core/rules/bidding.ts:1554-1620` -- `evaluateCap`. Everything up to `maximumBid` is Team solvency; only the final `passed` expression is about a prospective amount. **Extract the figure computation** so the Move reads `maximumBid` without an amount. Note `:1604-1608`: the `unbounded` branch already tests `maximumBid >= 0`, which *is* the Move's cap question.
- `src/lib/core/rules/bidding.ts:1731-1795` -- `evaluateSlots`. The non-entry branch `projectedAdditions === 0 || (freeActiveBenchSlots >= 1 && projectedAdditions <= allowance)` is the Move's slots question. `unfilledSlots` (`:1092`) **clamps at 0**, so a roster of 14 leading nothing would pass — an explicit `rosterCount <= ACTIVE_BENCH_SLOTS` ceiling test is required for §10 example 39.
- `src/lib/core/rules/bidding.ts:1113,1162,1217,1274,1391` -- `boundStateFor`, `minorsCountsFor`, `activeBenchOverflowFor`, `minorsExposureFor`, `projectedAdditionsFor`. The shared internals; keep them one expression each.
- `src/lib/core/rules/bidding.ts:524,630` -- `bidStateFor`, `teamMoneyStateFor`, both exported. Minors Exposure is **derived on every evaluation, never stored** — so "recomputes across every eligible Auction" (§10 ex 38) happens by handing the post-Move `minorLeagueOccupied` in, not by writing anything.

**The fold:**
- `src/lib/core/projection/contracts.ts:396-432` -- `contractsReducer`. Two cases today; add `ROSTER_MOVE_RECORDED_EVENT` (**latest-transfer-wins**, unlike `AuctionClosed`'s first-wins at `:400`). The existing guard at `:421` (`contract.teamId !== assignment.teamId`) already stops a sending Team's later length landing on a moved contract.
- `src/lib/core/projection/contracts.ts:170-190` -- `AuctionContract`: `teamId`, `teamName`, `winningAmount`, `capHit`, `placement`, `contractYears`. A transfer rewrites the first two, applies the `placement` and `capHit` the EVENT carries, and **clears `contractYears`**. The re-derivation happens once, at evaluate time; see Design Notes.
- `src/lib/core/projection/contracts.ts:98,113` -- `CONTRACT_LENGTH_ASSIGNED_EVENT` and its payload: the convention for declaring an event type beside its reducer. Header `:43-50` states the Year Allotment is a **count over current folded lengths**, so clearing the field returns the year with no second ledger.
- `src/lib/core/rules/close.ts:466-472` -- `slotPlacementFor(eligible, minorLeagueOccupied)`; `:493` `capHitFor(placement, winningAmount)`. **Reuse the placement rule verbatim** on arrival. The cap-hit rule is reused through `roster-import.ts`'s `chargedCapHit`, NOT `capHitFor`: a moving row may be `injury_reserve` or `dead_money`, which the two-member `SlotPlacement` cannot express. Write no third statement of either rule.

**The write path:**
- `src/lib/shell/write.ts:235-241` -- `runTransactionalWrite({gateway, load, decide, projections?, enqueue?})`. Lock+clock at `:140,247`; `now` injected at `:248`; events inserted `:269-287`; `projections` run on the same client at `:290-292`; `COMMIT` at `:304`.
- `src/lib/server/import-promotion.ts:314-324` + `:357-436` -- **the only precedent** for mutating a live reference table in the same transaction as an event, through the `ProjectionUpdater` seam. Header `:15-25` states `team_rosters` is mutable reference data, never rebuilt from the log. Copy the seam; do **not** copy its delete-then-insert.
- `src/lib/server/nomination.ts:635-715` -- the full command shape: `load` → `decide` → typed `*Rejection` on `{kind:'rejected', reason}`.
- `src/lib/server/contract-assignment.ts:143-179` -- passes **no `enqueue`**, with the header (`:21-25`) stating why. This is how a Move stays off Discord.
- `src/lib/server/team-roster.ts:51,139,162` -- `TeamRosterFigures`, `TeamRosterDetail`, `loadTeamRosterDetail(client, teamId, contracts)`. Read both Teams through this; it is the one loop that produces all three figures.
- `src/lib/core/rules/roster-import.ts:69,88` -- `chargedCapHit` (`minor_league` → `$0`, everything else its hit) and `computeCapSpace`. **A re-placed Existing row needs no cap edit** — changing `roster_slot_kind` is what changes the charge.

**The Commissioner surface (all shipped by 7.1 — read, do not re-invent):**
- `src/lib/reason-sheet-view.ts:45-50` -- `ReasonSheetRow {label, before, after, attention}`; `:53-66` `ReasonSheetInput {act, commitLabel, rows, cancelHref}`; `:178` `reasonSheetView`. The two-Team variant is **rows, not a new component**: one row per figure per Team, labelled with the Team.
- `src/lib/components/ReasonSheet.svelte:39-47,85-97` -- props are `{view, action}`; plain `POST` form, required `<textarea>`, dashed `control-commissioner` submit. Sheet styles live in the component (`tests/commissioner.test.ts:385-389` forbids them in `commissioner.css`).
- `src/lib/core/rules/override.ts:40,140` -- `OVERRIDE_REASON_FIELD`, `buildOverrideRecord`. `src/lib/server/override-guard.ts:104,120` -- `requireOverrideReason(form)`, `requireOverridablePhase(phase)` (refuses `Archived`). Both have zero call sites today; **this story is their first**.
- `src/lib/server/commissioner-guard.ts:50-53` -- `requireCommissioner`. `src/lib/server/destinations.ts:79-87,93-132,170-178` -- `destination(id, label, href, commissionerOnly)`, `CATALOG` per phase, `requireLiveDestination`. Add one entry to the `Auction` and `Contract Assignment` arrays.
- `src/routes/minor-league-eligibility/+page.server.ts:60-138` + `+page.svelte:34-209` -- **the route template**: both guards in `load` *and* in the action, actor from `locals.session` never a form field, `fail(409, {notice})` on rejection, `role="status"` for the result.
- `src/routes/nominate/+page.svelte:112,261-299` -- the only player-picking mechanism in the app: search input + position checkboxes through the pure `filterPool`. A roster picker is a plain list per Team; there is no `<select>` anywhere in `src/routes`.

**Tests:**
- `tests/examples/example-NN-slug.test.ts`, header line 2 `PRD §10 example NN — **Title** (FR-NN).` then the PRD text as a blockquote. Calls the core directly against state literals; no shared fixture module exists — each file defines its own `teamHolding`/`gatesFor` builders (see `example-41-...test.ts:53-110`).
- `tests/structure.test.ts:88-197` -- `SECTION_10_EXAMPLES`, tuples of `['file.test.ts', 'NN — Title']`; `:239-244` asserts `tests/examples/` holds **exactly** the registered set. `:184-188` already comments that 36–39 are this story's. Every new file must be registered.
- `tests/server/team-roster.test.ts:75-98` -- the `TransactionalClient` fake: a hand-written `async query(sql, params)` that records statements, regex-matches the SQL and throws on anything unexpected. Use it to prove the `UPDATE` shape.
- `vite.config.ts:6-9` -- `environment: 'node'`; no `.svelte` renders. Markup claims are proven by **source-text assertion** (`tests/structure.test.ts:356-390`).

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/rules/bidding.ts` -- extract the Team-solvency figures out of `evaluateCap` and the capacity figures out of `evaluateSlots` into two exported pure helpers; both gates then call them and keep their own `passed` expression **textually unchanged in meaning** -- AR-42: the Move reuses this arithmetic and writes none.
- [x] `src/lib/core/types.ts` -- declare `RecordRosterMove`, `RECORD_ROSTER_MOVE_GATES` (frozen, flat, reading order `contested` → sending → receiving), `RecordRosterMoveGate`, `RecordRosterMoveGateResults` -- AD-1's fixed-gate-set-per-command-type, third instance.
- [x] `src/lib/core/rules/roster-move.ts` (new) -- `evaluateMove` and `allMoveGatesPassed`: build post-Move figures for both Teams, re-place arrivals, run the three grounds once. No arithmetic of its own -- `restore.ts` is the shape to follow.
- [x] `src/lib/core/projection/contracts.ts` -- declare `ROSTER_MOVE_RECORDED_EVENT` and its payload beside the reducer; add the fold case (latest-transfer-wins; rewrites team, applies the payload's `placement` and `capHit`, clears `contractYears`) -- Auction Contracts move by the event alone, and the fold must NOT re-derive placement; see Design Notes.
- [x] `src/lib/server/roster-move.ts` (new) -- `recordRosterMove`: `loadTeamRosterDetail` for both Teams, `decide` through the core, one `ProjectionUpdater` issuing the `UPDATE team_rosters set team_id, roster_slot_kind ... where fantrax_player_id = $1`, **no `enqueue`** -- one transaction under the lock; off Discord by construction.
- [x] `src/lib/server/destinations.ts` -- one `destination('roster-move', …, true)` entry in the `Auction` and `Contract Assignment` arrays -- Commissioner-only, and absent once Archived.
- [x] `src/routes/roster-move/+page.server.ts` (new) -- `load` and the action, both calling `requireCommissioner` + `requireLiveDestination` + `requireOverridablePhase`; `requireOverrideReason` before the write; `fail(409, {notice})` on rejection -- `minor-league-eligibility` is the template.
- [x] `src/routes/roster-move/+page.svelte` (new) -- pick two Teams, then Players from each roster; render the two-Team `ReasonSheet` before commit -- UX-DR39; operable at 375px.
- [x] `src/lib/reason-sheet-view.ts` -- the two-Team row builder: Cap Space, Roster Count and all three Slot occupancies for **both** Teams, the moved Players named between them, and an `attention` sentence in words on any Cap Hit changed by re-placement -- rows, not a second component.
- [x] `tests/examples/example-36-the-trade-that-clears-the-room.test.ts`, `example-37-the-team-pushed-over-by-giving-something-away.test.ts`, `example-38-the-stash-that-becomes-expensive-by-moving.test.ts`, `example-39-one-act-evaluated-once.test.ts`, `example-42-a-won-player-traded-after-the-auction-phase.test.ts` -- encode all five at pure-core altitude -- the executable specification.
- [x] `tests/structure.test.ts` -- register the five new files in `SECTION_10_EXAMPLES` -- the directory assertion fails on an unregistered file.
- [x] `tests/server/roster-move.test.ts` (new) -- prove the `UPDATE` (never `delete`+`insert`), the single transaction, and that **no** outbox row is written -- the `TransactionalClient` fake is the mechanism.
- [x] Unit-test the remaining I/O matrix rows -- contested, both-empty, same-Team, blank reason, archived, two-minors-one-slot.

**Acceptance Criteria:**
- Given a Move that fails any gate, when it is evaluated, then **nothing** is written — no event, no `UPDATE`, no outbox row — and the refusal names the Team, the gate, the Auction and the arithmetic.
- Given the refusal, when it is read, then it offers **no** control that would cancel a Bid, and `rules/close.ts`'s cancellation trigger is unchanged by this story's diff.
- Given `RECORD_ROSTER_MOVE_GATES` gains or loses a name, when `npm run check` runs, then every consumer is a compile error until it handles the change — the same one-edit property `PLACE_BID_GATES` has.
- Given `evaluateCap` and `evaluateSlots` after the extraction, when the suite runs, then every pre-existing bidding and example test is green **unchanged** — the refactor moves code and changes no gate's answer.
- Given a Move commits, when the log is folded from zero, then both Teams' figures and every moved Contract's team, placement and Cap Hit reproduce exactly — replay convergence over the whole delta.
- Given a committed Move, when `notification_outbox` is read, then it holds no row for it.
- Given §10 example 42, when the Move commits, then `contractYears` is `null` on the moved contract and the sending Team's 3-year is available again. **The FR-30 export re-block is deferred to Story 6.3** — asserted there, not here, at the human's direction.

## Spec Change Log

**2026-09-10 - the cap refusal had to name an off-grid shortfall (human-directed; nothing frozen changed).**

1. **The matrix row for §10 example 37 requires the refusal to name the
   $300,000 shortfall, and it could not.** `formatMoney` throws a `RangeError`
   on any amount off the $500,000 grid (AD-8, `money.ts:176`), and
   `describeAmount` hedges to the literal `'an amount that is not on the
   grid'`. The implementation shipped that hedge and flagged it.
2. **The hedge is reachable in production, which is what made it a defect
   rather than a test artifact.** Checked before deciding: the CSV roster
   importer asserts no money grid - only Story 7.9's unbuilt Fantrax API
   reader is specified to - so an imported Cap Hit carries whatever Fantrax
   held, Cap Space inherits it, and example 37's `$6,700,000` is an ordinary
   figure rather than an illustrative one. A Commissioner would have been
   refused by arithmetic the refusal declined to show.
3. **`formatExactDollars` added to `core/money.ts`** and used for the four
   figures in the cap-refusal sentence only. The human chose this over
   amending the matrix or deferring. It is documented as a **diagnostic**
   renderer: AD-8's one-rendering rule governs surface figures, which still go
   through `formatMoney`/`describeAmount`, and the auction amount in the same
   sentence deliberately still does.
4. **The two older private spellings were left alone** - `teams-index.ts`'s
   `exactDollars` (grouped, one constant; its docblock argues it is private
   *so it cannot become a second money format*) and the ungrouped off-grid
   branch of `import-preview.ts`'s `renderCapSpace`. Folding them in would
   change rendered output on two shipped surfaces. Logged in
   `deferred-work.md` instead.
   **KEEP on any re-derivation:** do not "unify" the three renderers as a
   drive-by - the consolidation changes shipped surfaces and needs its own
   story.
5. **`tests/money.test.ts`'s purity guard is a substring scan over the whole
   file, comments included**, so naming a forbidden formatter in a docblock
   disarms the check that forbids it. The docblock now says so and names none.
   (`check-core-purity.js` walks an AST and does not have this hazard.)

**2026-09-10 - review loop 1 (four layers; two spec-level findings, human-directed, no revert).**

6. **A Player named in BOTH directions had no stated answer, and the
   implementation invented one.** `evaluateMove` deduped him before departures
   were built, so he silently became a one-way send - and
   `tests/roster-move.test.ts:351` was titled "is refused rather than bounced"
   with a comment claiming `not_held` fires, while asserting `'permitted'`. A
   test that documents the opposite of what it verifies. **Human chose: refuse
   as incoherent**, as a fourth shape refusal beside `same_team` and
   `names_nothing`, checked before `contested`. The frozen matrix was left
   unamended at the human's choice; this entry is the record.
   **KEEP on any re-derivation:** the dedup for a Player named twice in the
   SAME direction is correct and must survive - only the both-directions case
   refuses.

7. **The Execution task and Design Notes contradicted the frozen "whole delta"
   constraint, and the implementation was right to ignore them.** Both said the
   fold should "re-derive `placement` and `capHit` via
   `slotPlacementFor`/`capHitFor`". Re-deriving at fold time would re-place
   against whatever occupancy the fold holds then rather than what was decided,
   breaking the frozen "a replay reproduces the world as it stood" - and
   `contractsReducer` has no `team_rosters` occupancy to re-derive from in any
   case. The spec text was corrected to match the code; the code was NOT
   reverted. **Human directed: amend spec + targeted fixes, no full loopback**,
   since a revert would have regenerated the same implementation from corrected
   text.
   **KEEP on any re-derivation:** the fold applies the payload verbatim. Do not
   "restore" re-derivation in `contractsReducer`.

8. **`capHitFor` was dead in `roster-move.ts`** - imported and re-exported under
   a docblock asserting the fold reaches it, which it never did. The cap-hit
   rule IS reused, through `chargedCapHit`, which is the correct choice because
   it covers all four `RosterSlotKind` values where `capHitFor` covers only the
   two-member `SlotPlacement`. The spec's Code Map and Design Notes were
   corrected to say so.

9. **Ten further findings triaged as patches** and applied without spec change:
   a `parseMoney` throw reachable inside the fold from a type-valid but
   unparseable string (it would poison every future replay, against this
   module's own skip-never-throw discipline); `winningAmount` falling back to
   `capHitAfter` (AD-23); latest-transfer-wins unpinned because the replay test
   folded identical events; the cleared Contract length never reaching the
   sheet; off-grid Cap Space hedging on the sheet (the same defect entry 1-3
   fixed for the refusal); `movingTeamFor`'s silent $0 fallback; the route's
   `load`/`actions` verified only by source-text regex though the module is
   importable; and FR-37's pass expression duplicated on the slots side.

10. **Four findings rejected as noise.** Three reviewers independently claimed
    an off-grid amount makes `describeAmount` throw `RangeError`, crashing the
    sheet; it does not - it guards with `isOnMoneyGrid` and returns the hedge
    string. One claimed the missing Audit Log rendering, which Story 7.5 owns
    and this spec's **Never** list excludes. A fifth, that
    `isContentionEntry: true` is suspect, was verified CORRECT - `false` would
    invent a phantom prospective Bid and wrongly refuse Moves - and reduced to
    a missing-comment patch.

## Design Notes

**Why the gate set is flat.** `GateResults` is `Readonly<Record<string, GateOutcome>>` and `RecordRosterMoveGateResults` must stay assignable to it, so a per-Team object cannot nest inside a gate. Five flat keys — `contested`, `sendingCap`, `sendingSlots`, `receivingCap`, `receivingSlots` — keep AD-1's fixed-gate-set property and make "one evaluation, both Teams" literally one returned record. `contested` is first because it is the frame the other four sit inside, exactly as `phase` leads `PLACE_BID_GATES`.

**Why the cap gate is `maximumBid >= 0` and not a comparison.** A Move offers no amount. What can fail is *solvency*: a Team whose freed Slot raised its Roster Reserve past what its Cap Space still covers (§10 example 37 — richer by $500,000 and now $300,000 short). `evaluateCap` already computes exactly that test in its `unbounded` branch; extracting the figures makes the Move read the same expression rather than restate it.

**The placement rule this spec settles on.** On arrival, a row **currently in a Minor League Slot** is re-placed by `slotPlacementFor(true, receivingOccupancy)` — sitting in that Slot is itself the eligibility statement, so no `free_agent_players` lookup is needed for a rostered Player. `active_bench` and `injury_reserve` rows arrive unchanged; IR is a Fantrax fact, not an app placement. This is uniform across both Contract kinds and is what makes §10 example 38 fall out. For an Existing Contract nothing but `roster_slot_kind` changes — `chargedCapHit` turns the $0 into a full charge on its own. For an Auction Contract the event carries the new `capHit` from `chargedCapHit` — `capHitFor` covers only the two-member `SlotPlacement`, and a moving row may be `injury_reserve` or `dead_money`.

**The fold applies the payload; it does not re-derive.** Placement is decided ONCE, at evaluate time, against the receiving Team's occupancy at that instant, and the event carries the answer. A fold that re-derived it would re-place against whatever occupancy it holds at fold time — and `contractsReducer` has no `team_rosters` occupancy to re-derive from at all. Carrying the whole delta is what makes "a replay reproduces the world as it stood" true; re-deriving would break it.

**Order inside one Move.** Departures apply to both Teams first, then arrivals are placed **sorted by `fantraxPlayerId`**, decrementing free Slots as each lands. Sorting is AD-5's sequence discipline: two eligible Players arriving at a Team with one free Minor League Slot must land the same way on every replay. The gates then run **once**, at the end, over the resulting state — which is the whole of §10 example 39.

## Verification

**Commands:**
- `npm run check` -- expected: zero errors.
- `npm test` -- expected: full suite green, including the five new example tests and every pre-existing bidding test unchanged.
- `npm run build` -- expected: passes, including `scripts/check-core-purity.js` (`core/rules/roster-move.ts` must import only relative `.ts` paths and touch no forbidden global).

**Manual checks:**
- Sign in as Commissioner in the Auction Phase, open the Move destination, and confirm the sheet shows both Teams' five figures side by side, the moved Players named between them, and a re-placed Cap Hit stated in words with an `attention` note.
- Confirm the destination is absent for a Manager and absent for everyone once Archived.
- Confirm the sheet is operable at 375px.
- Record a Move and confirm the league Discord channel says nothing.

## Suggested Review Order

**The command, and the one evaluation**

- Start here: the whole act, in order — shape, contested, departures, arrivals, gates.
  [`roster-move.ts:501`](../../src/lib/core/rules/roster-move.ts#L501)

- The third fixed gate set. Flat, so it stays assignable to `GateResults`.
  [`types.ts:1011`](../../src/lib/core/types.ts#L1011)

- The fourth shape refusal — review loop 1 replaced a silent one-way send here.
  [`roster-move.ts:539`](../../src/lib/core/rules/roster-move.ts#L539)

- Arrival placement: sitting in a Minor League Slot IS the eligibility statement.
  [`roster-move.ts:307`](../../src/lib/core/rules/roster-move.ts#L307)

**Reusing the bidding arithmetic rather than restating it (AR-42)**

- Highest-risk stop: solvency figures extracted so `evaluateCap`'s verdict is unmoved.
  [`bidding.ts:1633`](../../src/lib/core/rules/bidding.ts#L1633)

- The Move's cap question is `maximumBid >= 0` — no amount is offered.
  [`roster-move.ts:344`](../../src/lib/core/rules/roster-move.ts#L344)

- FR-37's expression, now one predicate both gates call so they cannot drift.
  [`bidding.ts:1894`](../../src/lib/core/rules/bidding.ts#L1894)

- Explicit ceiling test: `unfilledSlots` clamps at 0, so §10 ex 39 needs it.
  [`roster-move.ts:404`](../../src/lib/core/rules/roster-move.ts#L404)

**The fold — latest-transfer-wins, and why it re-derives nothing**

- Applies the payload verbatim; re-deriving here would break replay.
  [`contracts.ts:657`](../../src/lib/core/projection/contracts.ts#L657)

- Validates money by VALUE — a bad payload is skipped, never thrown over.
  [`contracts.ts:502`](../../src/lib/core/projection/contracts.ts#L502)

- Every money field required; no field is repaired from another (AD-23).
  [`contracts.ts:537`](../../src/lib/core/projection/contracts.ts#L537)

**The write path — one transaction, and off Discord**

- `UPDATE` of the team key, never delete-then-insert (AR-41).
  [`roster-move.ts:89`](../../src/lib/server/roster-move.ts#L89)

- One event, one `ProjectionUpdater`, and deliberately NO `enqueue`.
  [`roster-move.ts:337`](../../src/lib/server/roster-move.ts#L337)

- A won row with no folded contract now throws instead of substituting $0.
  [`roster-move.ts:149`](../../src/lib/server/roster-move.ts#L149)

**The surface — saying the consequence before commit**

- The two-Team variant: five figures per Team, Players named between them.
  [`reason-sheet-view.ts:305`](../../src/lib/reason-sheet-view.ts#L305)

- Both consequence sentences on one row — cleared length was missing until review.
  [`roster-move.ts:864`](../../src/lib/core/rules/roster-move.ts#L864)

- The cleared term, the returned Year Allotment, and the re-blocked export.
  [`roster-move.ts:844`](../../src/lib/core/rules/roster-move.ts#L844)

- No hedged money on a sheet the Commissioner commits from.
  [`roster-move.ts:102`](../../src/lib/core/rules/roster-move.ts#L102)

- The diagnostic renderer; AD-8 still governs every surface figure.
  [`money.ts:218`](../../src/lib/core/money.ts#L218)

- Commissioner-only, in two phases, and absent once Archived.
  [`destinations.ts:120`](../../src/lib/server/destinations.ts#L120)

**Peripherals**

- All three guards on both entry points, and the reason validated before the write.
  [`+page.server.ts:225`](../../src/routes/roster-move/+page.server.ts#L225)

- Route driven as a module, not by source-text regex.
  [`routes/roster-move.test.ts`](../../tests/routes/roster-move.test.ts)

- Latest-transfer-wins, pinned with two DIFFERENT Moves rather than a repeat.
  [`projection-contracts.test.ts:579`](../../tests/projection-contracts.test.ts#L579)

- §10 example 37: the refusal that now states its own arithmetic in full.
  [`example-37…test.ts:175`](../../tests/examples/example-37-the-team-pushed-over-by-giving-something-away.test.ts#L175)
