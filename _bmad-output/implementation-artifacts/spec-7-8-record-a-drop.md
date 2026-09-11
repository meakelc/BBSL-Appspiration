---
title: 'Story 7.8: Record a Drop'
type: 'feature'
created: '2026-09-11'
status: 'done'
review_loop_iteration: 1
baseline_commit: 'f14b317705edeb10641261f34eff3f395a95a6b4'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A Team releases a Player in Fantrax and the app never hears: it keeps counting him against the twelve and keeps charging his Cap Hit under his name, so Roster Count and every Maximum Bid derived from it drift for the rest of the auction. There is no command that releases a Contract. Worse, FR-43's one exception is currently unreachable — Story 7.6 taught the adapter to parse the `2RK` round, but `staged-roster-row.ts:87` hardcodes `rookieScaleRound: null` because neither `import_staged_rosters` nor `team_rosters` has a column for it, so by the time a Drop could read the designation it is gone.

**Approach:** `RecordDrop`, a fourth command type with a flat three-name gate set evaluated **once over one Team's post-Drop state**; one uniform conversion — *the Dead Money carried is the Player's charged Cap Hit, released to nothing for a full-term second-round rookie deal, and the row is removed exactly when that amount is nothing* — so all three Slot kinds and the exception fall out of one expression; one `DropRecorded` event carrying the whole delta, appended under the global lock in the same transaction that `UPDATE`s or `DELETE`s each `team_rosters` row; the post-act evaluation shared with a Move extracted to `core/rules/roster-act.ts`; and `rookie_scale_round` persisted end to end so the exception has a fact to read.

## Boundaries & Constraints

**Always:**
- **One rule, and no Slot kind is a special case** (FR-43). `deadMoney = releases2RK ? $0 : chargedCapHit(row)`, and the row is **removed** if and only if that amount is `$0`. A Minor League row was charging `$0` and so leaves nothing behind; a full-term `2RK` releases to `$0` by the exception; everything else is reclassified `dead_money` at the amount it was already charging. Nothing branches on `rosterSlotKind` to decide the amount.
- **The exception needs BOTH facts:** `rookieScaleRound === 2` **and** a full unelapsed term, which is `contractYearsRemaining === 5` — the second-round term is 5 years and invariant, which is what makes the term test sound. Never the round alone, never the term alone.
- **Refuse, never cancel.** A failing gate refuses the **whole** Drop and writes nothing, naming the Team, the gate, the Auction and the arithmetic. No Bid is ever stood down: FR-40's cancellation trigger stays a Close.
- **No arithmetic of its own** (AR-42). Cap and capacity come from the helpers shared with a Move, which are `bidding.ts`'s. This story writes no third statement of solvency, capacity, Cap Space or the charged-Cap-Hit rule.
- **`contested` is checked first**, before cap and slots, which have nothing to say about a Player nobody holds. All gates are always returned; none short-circuits another (AD-7).
- **A Player held by an Auction Contract (`won: true`) is refused** as a shape refusal. He is not in Fantrax until the FR-30/31 export, so he cannot have been dropped there; FR-42's detector excludes won Players for the same reason, and Story 7.2's void is the remedy for a Player wrongly won. Human-decided 2026-09-11.
- **Dead Money is not droppable.** It is a charge and not a Player; `movable` already says so, in one place.
- One transaction under the global write lock (AD-6): a Drop that released two Players of three is unreachable. **No `enqueue`** — a Drop is audit-log-only, exactly as a Move is.
- The event carries the **whole delta** — every Player, the Team's five figures before and after, each carried Dead Money amount — so a replay reproduces the world as it stood.

**Ask First:**
- Widening `SlotPlacement` beyond its two members, or giving `AuctionContract` a Dead Money state.
- Any change to `chargedCapHit`'s body, or to `evaluateCap`'s or `evaluateSlots`' pass expressions while extracting the shared helpers to `roster-act.ts`.
- Backfilling `rookie_scale_round` for rosters already promoted, or any re-import. The column arrives `null` for existing rows, which makes every already-imported Contract ordinary — see Design Notes.

**Never:**
- Divergence detection (7.9), Bid voiding (7.2), pause/resume (7.4), the remaining overrides (7.3).
- **Discord.** A Drop is not broadcast.
- Making Dead Money importable, a Slot Placement destination, or a thing that counts toward a ceiling.
- Future-year cap projection. Dead Money carries the Contract's remaining years for the export only; **within this auction the term computes nothing**.
- Proving the FR-30/31 Dead Money export exclusion — no export route exists yet (Story 6.3). Deferred exactly as Story 7.7 deferred the FR-30 re-block.
- Re-deriving placement or Cap Hit inside the fold. The fold applies the payload verbatim.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Active/Bench drop (§10 ex 40) | H: Roster Count 10, Cap Space $5M, leads nothing; drops a $2M Active/Bench Contract | Commits. Roster Count **9**, Cap Space **still $5M**, Dead Money $2M carried, Roster Reserve $2M, **Maximum Bid falls $4M → $3M**. Row `UPDATE`d to `dead_money` | N/A |
| Full-term 2RK (§10 ex 41) | Identical, but the Contract carries round 2 and 5 years remaining | Commits. **No Dead Money**, row **removed**, Cap Space rises to **$7M**, **Maximum Bid $5M** | N/A |
| Minor League drop (§10 ex 43) | L: `M`=1, Roster Count 10, Cap Space $20M, leads two eligible Auctions at $12M and $4M (Minors Exposure $12M) | Commits. Nothing carried, row **removed**, Cap Space unchanged, Roster Count unchanged, `M`→2, Overflow 0, **Minors Exposure $0**, Available Cap Space $20M | N/A |
| Injury Reserve drop | An IR Contract charging $1.5M | Full $1.5M carried; Roster Count unchanged; Maximum Bid unchanged | N/A |
| `1RK`, full term | Round 1, 5 years remaining | Dead Money carried in full — the exception is second-round only | N/A |
| `2RK`, term partly elapsed | Round 2, 3 years remaining | Dead Money carried in full — not this draft class | N/A |
| Gate refusal | A Drop leaving the Team failing cap or slots | **Refused whole**; nothing written; names the Team, the gate, the Auction and the arithmetic | Rejection, not a throw |
| Contested Player | A Player leading or nominated in an open Auction | Refused on the contested ground, before cap and slots | Rejection naming the Player and the Auction |
| Won Player | A Player held by an Auction Contract | Refused as a shape refusal, naming him and the Auction he was won in | Rejection |
| Dead Money named | A `dead_money` row named in the Drop | Refused — it is a charge, not a Player | Rejection |
| Names nothing | A Drop naming a Team and no Players | Refused | Rejection |
| Not held | A Player the named Team does not hold | Refused, naming Player and Team | Rejection |
| Same Player twice | One id posted twice in one Drop | Deduplicated; the act is unchanged | N/A |
| Blank reason | Absent or whitespace reason | Refused **server-side**, nothing written | 400 via `requireOverrideReason` |
| Archived phase | A Drop submitted once archived | Refused | 403 via `requireOverridablePhase` |

</frozen-after-approval>

## Code Map

**The precedent to mirror — read it before writing anything.** Story 7.7's Move is the same act with one Team instead of two: `src/lib/core/rules/roster-move.ts`, `src/lib/server/roster-move.ts`, `src/routes/roster-move/`. Where this map says "as a Move does", that file is the statement.

**The shared evaluation to extract (`core/rules/roster-act.ts`, new):**
- `src/lib/core/rules/roster-move.ts:256-281` -- `figuresFor`: the five figures derived from rows, never carried. `:282` `chargeOf`. `:302-310` `arrivalPlacementFor` (Move-only; leave it behind). `:311` `minorsOccupiedIn`.
- `src/lib/core/rules/roster-move.ts:322-343` -- `postMoveMoneyStateFor`: `teamMoneyStateFor` with **no Auction excluded** and an empty `fantraxPlayerId`, built once per Team and handed to both that Team's gates.
- `src/lib/core/rules/roster-move.ts:344-403` -- `evaluateMoveCap`: `teamSolvencyFiguresFor(bidStateFor(null, money, false, 'Auction'), '', $0, true)`, `passed = maximumBid >= 0`, `shortfall` as a positive size, `leadingAuctions` re-sorted (AD-5). **Verbatim for a Drop** — a Drop offers no amount either.
- `src/lib/core/rules/roster-move.ts:404-462` -- `evaluateMoveSlots`: `slotCapacityFiguresFor(…, true)` plus the three explicit ceiling tests, because `unfilledSlots` clamps at 0. The `isContentionEntry: true` comment explains why `false` would invent a prospective Bid; it applies identically here.
- `src/lib/core/rules/roster-move.ts:463-499` -- `contestOf`; `:251` `movable` (already excludes `dead_money`); `:711-737` `inWords` / `auctionsInWords`; `:102` `describeMoveAmount`, the off-grid-safe renderer.
- **Constraint:** the extraction must leave `roster-move.ts`'s behaviour and every Move and bidding test green **unchanged**. It moves code; it changes no gate's answer.

**The Drop's own rule (`core/rules/roster-drop.ts`, new):**
- `src/lib/core/rules/roster-move.ts:501-705` -- `evaluateMove`, the shape to follow: shape refusals → contested → held → apply → gates once → `permitted | refused`. A Drop has one Team, no arrivals, and no sort.
- `src/lib/core/rules/roster-import.ts:69` -- `chargedCapHit({capHit, rosterSlotKind})`. **The Dead Money amount is this and nothing else.** Do not edit it (AR-43).
- `src/lib/core/rules/roster-import.ts:88` -- `computeCapSpace`, the one Cap Space expression, summing `chargedCapHit` over rows.
- `src/lib/core/types.ts:144` -- `RosterSlotKind`, four members since 7.6. `:167` `SlotPlacement` stays at two.
- `src/lib/core/types.ts:939-1021` -- the `RecordRosterMove` block: command type, frozen flat `RECORD_ROSTER_MOVE_GATES`, gate-name type, `RecordRosterMoveGateResults` (`:1136`). **Copy this shape exactly.** `GateResults` (`:314`) is `Readonly<Record<string, GateOutcome>>`, so the gate set must stay flat: `contested` → `cap` → `slots`.
- `src/lib/core/types.ts:1023-1128` -- `ContestedPlayer`, `ContestedGateOutcome`, `MoveLeadingAuction`, `MoveCapGateOutcome`, `MoveSlotsGateOutcome`. A Drop reuses these outcome shapes rather than declaring parallel ones.

**The fold:**
- `src/lib/core/projection/contracts.ts:403-480` -- `ROSTER_MOVE_RECORDED_EVENT`, `RosterMoveTransfer`, `RosterMoveTeamFigures`, `RosterMoveRecordedPayload`. The convention for declaring an event beside its reducer; `RosterMoveTeamFigures` is reused by a Drop unchanged.
- `src/lib/core/projection/contracts.ts:657-688` -- the `ROSTER_MOVE_RECORDED_EVENT` case: **applies the payload verbatim, re-derives nothing** (Story 7.7 review finding 7). `:537` `readTransfers` validates money **by value** and skips rather than throws — a bad payload must never poison a replay.
- A won Contract cannot be dropped, so **`contractsReducer` needs no `DropRecorded` case at all**. Confirm that conclusion before adding one.

**The write path:**
- `src/lib/server/roster-move.ts:87-88` -- `MOVE_ROSTER_ROW_SQL`. A Drop needs two statements: `update team_rosters set roster_slot_kind = 'dead_money' where fantrax_player_id = $1` and `delete from team_rosters where fantrax_player_id = $1`.
- `src/lib/server/roster-move.ts:135-192` -- `movingTeamFor`: the roster read joined to the contracts fold, recovering the **full** value (a won row's `capHit` is the charged figure). `:149-178` — a won row with no folded contract **throws**. A Drop reads the same join to identify won rows and refuse them.
- `src/lib/server/roster-move.ts:326-407` -- `recordRosterMove`: `runTransactionalWrite` with `load` → `decide` → `projections`, **no `enqueue`**, and the gates re-asserted inside `decide`. Copy this whole shape.
- `src/lib/server/team-roster.ts:162` -- `loadTeamRosterDetail(client, teamId, contracts)`; its select at `:165-170` reads four columns. **It must also read `contract_years_remaining` and `rookie_scale_round`**, which the Drop's exception turns on; `TeamRosterRow` (`core/team-view.ts`) gains them.
- `src/lib/shell/write.ts:235-241` -- `runTransactionalWrite`; `src/lib/server/import-promotion.ts:314-324` -- the `ProjectionUpdater` seam, the only precedent for mutating a live reference table beside an appended event.

**Persisting the rookie designation (the blocking defect):**
- `src/lib/server/staged-roster-row.ts:79-88` -- reads `contract_years_remaining`, hardcodes `rookieScaleRound: null` with a docblock naming this story as the one line to change.
- `src/lib/server/roster-import.ts:317-337` -- the 6-tuple `insert into import_staged_rosters`. `src/lib/server/import-promotion.ts:380-398` -- the 6-tuple `insert into team_rosters`. Both become 7-tuples; **the `at = i * 6` stride and the `$n` generation must move with them.**
- `src/lib/adapters/fantrax/roster-file.ts:145-166` -- `contractYearsRemaining` and `rookieScaleRound` already parsed and carried; `src/lib/core/types.ts:229` -- `ParsedRosterRow.rookieScaleRound`, required, `number | null`. **Nothing in the adapter changes.**
- `supabase/migrations/20260910000000_dead_money_roster_slot_kind.sql` -- house style: prose header, `if exists` guards, `comment on column`. Naming `YYYYMMDDHHMMSS_snake_case.sql`, time always `000000`; a new `20260911000000_*.sql` sorts last.
- `supabase/migrations/20260824000000_import_staging.sql:105-119` and `20260824020000_live_reference_tables.sql:59-71` -- where `contract_years_remaining` is declared on each table; the new column sits beside it, **nullable**.

**The surface (all shipped — read, do not re-invent):**
- `src/lib/reason-sheet-view.ts:57-66,190` -- `ReasonSheetRow {label, before, after, attention}`, `ReasonSheetInput`, `reasonSheetView`. `:242` `teamFigureRows`, `:290` `transferRow`, `:305` `rosterMoveReasonRows`, `:321` `rosterMoveActSentence`, `:343` `ROSTER_MOVE_COMMIT_LABEL`. A Drop is **one** Team's block plus one row per released Player — rows, not a new component.
- `src/lib/components/ReasonSheet.svelte:39-47,85-97` -- props `{view, action}`; plain `POST`, required `<textarea>`, dashed commit control.
- `src/lib/server/override-guard.ts:104,120` -- `requireOverrideReason`, `requireOverridablePhase`. `src/lib/server/commissioner-guard.ts:50` -- `requireCommissioner`.
- `src/lib/server/destinations.ts:104-131` -- the `Auction` and `Contract Assignment` arrays; `destination('roster-move', …, true)` at `:120` is the entry to copy. Absent from `Archived` by construction.
- `src/routes/roster-move/+page.server.ts` and `+page.svelte` -- **the template**: both guards in `load` *and* in the action, actor from `locals.session` never a form field, `fail(409, {notice})` on rejection, `role="status"` for the result, a plain roster list (there is no `<select>` in `src/routes`), operable at 375px.
- `src/lib/core/audit-log.ts:963` -- `RENDERERS`, `Readonly<Record<string, AuditEntry>>` — **open, so a missing entry is not a compile error**. `:998` the `ROSTER_MOVE_RECORDED_EVENT` entry, `renderRosterMove` above it, and `:153` `SLOT_KIND_WORDS` (already total over four kinds). Event-type filter options are derived from the log, so they need no edit.

**Tests:**
- `tests/examples/example-40-a-drop-lowers-the-maximum-bid.test.ts` and `example-41-the-three-characters-worth-2000000.test.ts` -- shipped by 7.6 over **hand-built post-drop fixtures**, asserting $3,000,000 and $5,000,000. Story 7.6's change-log KEEP forbids replacing those fixtures; this story **adds** a command-driven derivation beside them.
- `tests/structure.test.ts:88-244` -- `SECTION_10_EXAMPLES`; `tests/examples/` must hold **exactly** the registered set. The comment at `:184-188` already says 40 and 41 describe the Drop this story owns. Example 43 is new and must be registered.
- `tests/server/team-roster.test.ts:75-98` -- the `TransactionalClient` fake: records statements, regex-matches SQL, throws on anything unexpected. The mechanism for proving the `UPDATE`/`DELETE` shapes and the absent outbox row.
- `tests/adapters/fantrax-roster.test.ts:174-178` -- already asserts `2RK31` yields round 2 and 5 years. The new coverage is that the round **survives to `team_rosters`**.
- `vite.config.ts:6-9` -- `environment: 'node'`; markup claims are proven by source-text assertion.

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/20260911000000_rookie_scale_round.sql` (new) -- add a nullable `rookie_scale_round` integer to **both** `import_staged_rosters` and `team_rosters`, with `comment on column` stating it is the draft round of a rookie-scale Contract and that FR-43's release turns on round 2 plus a full term -- the exception is unimplementable until the designation is persisted.
- [x] `src/lib/server/roster-import.ts` + `src/lib/server/import-promotion.ts` + `src/lib/server/staged-roster-row.ts` -- carry `rookieScaleRound` through staging and promotion; both batch inserts become 7-tuples with the stride corrected; the hardcoded `null` is replaced by the parsed value -- the seam 7.6 left labelled for this story.
- [x] `src/lib/core/team-view.ts` + `src/lib/server/team-roster.ts` -- `TeamRosterRow` gains `contractYearsRemaining` and `rookieScaleRound`; `loadTeamRosterDetail`'s select reads both columns -- the Drop cannot ask its exception's question without them.
- [x] `src/lib/core/rules/roster-act.ts` (new) -- extract the post-act evaluation shared by a Move and a Drop: the five figures, the charge, the post-act money state, the cap and slots gate bodies, the contested lookup, and the wording helpers. `roster-move.ts` then imports them and keeps its own act -- AR-42, and the same extraction 7.7 made on `bidding.ts`.
- [x] `src/lib/core/types.ts` -- declare `RecordDrop`, `RECORD_DROP_GATES` (frozen, flat, reading order `contested` → `cap` → `slots`), `RecordDropGate`, `RecordDropGateResults` -- AD-1's fixed-gate-set-per-command-type, fourth instance.
- [x] `src/lib/core/rules/roster-drop.ts` (new) -- `evaluateDrop` and `allDropGatesPassed`: the shape refusals (names nothing, not held, dead money, **won**), contested, the one conversion expression, then the three gates once over post-Drop state; plus `dropRefusalDetail` and the consequence sentences -- one rule, no Slot kind special-cased.
- [x] `src/lib/core/projection/contracts.ts` -- declare `DROP_RECORDED_EVENT` and `DropRecordedPayload` (released Players with each carried amount, the Team's figures before and after, the reason) beside the reducer. **No reducer case** — a won Contract cannot be dropped -- the record is for replay and the Audit Log.
- [x] `src/lib/server/roster-drop.ts` (new) -- `recordDrop`: one `loadTeamRosterDetail`, `decide` through the core, one `ProjectionUpdater` issuing `UPDATE … set roster_slot_kind = 'dead_money'` or `DELETE` per released Player, **no `enqueue`** -- one transaction under the lock; off Discord by construction.
- [x] `src/lib/core/audit-log.ts` -- a `DROP_RECORDED_EVENT` entry and renderer: the reason first, each Player with the Slot he left and the Dead Money carried (or that it was released), then the Team's before → after -- `RENDERERS` is open, so a missing entry fails silently rather than at compile time.
- [x] `src/lib/server/destinations.ts` -- one `destination('roster-drop', 'Record a Drop', '/roster-drop', true)` in the `Auction` and `Contract Assignment` arrays -- Commissioner-only, absent once Archived.
- [x] `src/routes/roster-drop/+page.server.ts` + `+page.svelte` (new) -- `load` and the action, both calling `requireCommissioner` + `requireLiveDestination` + `requireOverridablePhase`; `requireOverrideReason` before the write; `fail(409, {notice})` on rejection; pick one Team, then Players from its roster -- `roster-move` is the template.
- [x] `src/lib/reason-sheet-view.ts` -- the Drop row builder: the Team's five figures before → after, one row per released Player naming the Slot and the Dead Money carried, and — for any Active/Bench release — an `attention` sentence saying **in words** what the freed hole does to the Team's Maximum Bid: the $1,000,000 reserve it now costs, and then the **net** direction for *that* release, which is a fall of $1,000,000 when the Cap Hit is carried and `charge − $1,000,000` when it is released to Cap Space. Cite FR-43's second-round rookie exception **only** when `releasesToNothing` is actually true -- UX-DR40; the counterintuitive direction is stated before commit, and stating it backwards is worse than not stating it.
- [x] `tests/examples/example-43-a-stashed-drop-moves-the-maximum-bid-the-other-way.test.ts` (new) + `tests/structure.test.ts` -- encode example 43 and register it -- it must move Maximum Bid in the **opposite** direction from example 40, which is the test that stops this being a flat rule.
- [x] `tests/examples/example-40-*.test.ts` + `example-41-*.test.ts` -- **add** an `evaluateDrop`-driven derivation producing the same $3,000,000 and $5,000,000, leaving 7.6's hand-built fixtures and their assertions untouched -- 7.6's KEEP instruction, now discharged by derivation rather than replaced.
- [x] `tests/server/roster-drop.test.ts` (new) -- prove the `UPDATE` for a carried release, the `DELETE` for a released-to-nothing one, the single transaction, and that **no** outbox row is written -- the `TransactionalClient` fake is the mechanism.
- [x] Unit-test the remaining I/O matrix rows, and assert `rookie_scale_round` survives import to `team_rosters` -- contested, won, dead money named, `1RK`, partly-elapsed `2RK`, IR, names nothing, not held, duplicate id, blank reason, archived.

**Acceptance Criteria:**
- Given a Drop that fails any gate, when it is evaluated, then **nothing** is written — no event, no `UPDATE`, no `DELETE`, no outbox row — and the refusal names the Team, the gate, the Auction and the arithmetic.
- Given the Dead Money conversion, when the source is read, then exactly **one** expression decides the amount and exactly one decides whether the row survives; no branch tests `rosterSlotKind` to choose either.
- Given `RECORD_DROP_GATES` gains or loses a name, when `npm run check` runs, then every consumer is a compile error until it handles the change — the one-edit property `PLACE_BID_GATES` has.
- Given `roster-act.ts` after the extraction, when the suite runs, then every pre-existing Move, bidding and example test is green **unchanged** — the refactor moves code and changes no gate's answer.
- Given a Drop commits, when the log is folded from zero and the reference rows are read, then the Team's five figures and each released Contract's fate reproduce exactly.
- Given a committed Drop, when `notification_outbox` is read, then it holds no row for it; and when the Audit Log is read, then the entry states the reason, each Player, and the before → after.
- Given a roster file carrying `2RK31` is imported and promoted, when `team_rosters` is read, then the row carries `rookie_scale_round = 2` and `contract_years_remaining = 5` — the fact the exception turns on survives the whole path.
- Given examples 40 and 43, when both run, then they move Maximum Bid in opposite directions from the same act.

## Spec Change Log

**2026-09-11 — implementation notes (nothing in the frozen sections changed).**

1. **The gate-refusal matrix row was only half covered, and the missing half
   was the interesting one.** The implementation tested a *slots* refusal,
   which cannot exercise the row's "names the Auction and the arithmetic"
   clause — only a *cap* refusal names an Auction and states a shortfall.
   Three tests added at verification time (`tests/roster-drop.test.ts`, "the
   cap gate — a Drop can refuse on the money it did not release"): §10 example
   37's shape with one Team, at Cap Space $7,000,000, Roster Count 11, leading
   one Auction at $6,500,000, where the freed hole costs $1,000,000 to reserve
   while the Cap Hit persists as Dead Money and leaves the Team $500,000
   short. It is example 40's arithmetic pushed one step past solvency.
   **KEEP on any re-derivation:** a Drop's cap gate must be exercised to
   FAILURE somewhere, not only to `passed: true` through the examples.

2. **§10 example 43's Maximum Bid gain is $11,000,000, not $12,000,000, and
   the PRD's prose is imprecise rather than the code being wrong.** The PRD
   reasons "Roster Count never moves … so Roster Reserve is untouched". That
   inference holds only if projected additions are also unchanged, and they
   are not: before the Drop one of the two eligible leads *overflowed* and so
   projected as an Active/Bench addition; afterwards both fit in Minor League
   Slots and neither does, so projected additions fall 1 → 0 and Roster
   Reserve **rises** $1,000,000. Every figure the matrix pins still holds —
   Minors Exposure $0, Available Cap Space $20,000,000, Cap Space and Roster
   Count unchanged — and the example's point (the mirror of example 40, moving
   the other way) is intact. The test states the arithmetic in terms rather
   than asserting a literal. **Flagged for the human; no code change made.**

3. **The payload's figures are `teamBefore`/`teamAfter`, not `before`/`after`.**
   `audit-log.ts`'s `mergeOverride` treats a top-level `before`/`after` pair as
   an `OverrideRecord` state map and rendered raw tokens (`teamId team-a →
   team-a`). `RosterMoveRecordedPayload` sidesteps the same collision by
   carrying per-side names; this follows it. Documented at both ends.

4. **Two wordings worth a human glance, neither changed.** The won-Player
   refusal says the Player was "won at auction" rather than naming the Auction
   he was won in — the Player identifies it, and there is no separate Auction
   name to give. And example 40's own Drop gate reports a Maximum Bid of
   $2,000,000 with `passed: true`, because the Drop offers no amount and so
   reserves all three free Slots; the narrated $3,000,000 is the Team's *next
   Bid's* Maximum Bid. The test asserts both and says which is which.

5. **The derivation now converges with Story 7.6's fixtures.** Examples 40 and
   41 keep their hand-built `AFTER` fixtures and assertions untouched, per
   7.6's KEEP, and gain an `evaluateDrop`-driven derivation beside them;
   `example-40…:326` asserts the derived state and the hand-built fixture
   agree. That is the proof 7.6 recorded as unavailable at its own altitude.

6. **No backfill of `rookie_scale_round`, deliberately** — it is on the Ask
   First list. Every already-promoted row reads `null` and its `2RK` deals
   will be treated as ordinary on a Drop. Raise before applying the migration
   anywhere holding real rosters; the remedy is a Commissioner re-import.

**2026-09-11 — review loop 1 (four layers; one bad_spec, human-directed amend-and-fix with no revert).**

7. **The reason sheet stated the direction BACKWARDS for the one case the
   league argues about, and the spec told it to.** The Execution task read "for
   **any** Active/Bench release — an `attention` sentence saying in words that
   this **lowers** the Maximum Bid", which contradicts the frozen matrix row
   two sections above it: §10 example 41 is an Active/Bench release and pins
   Maximum Bid **rising** $4,000,000 → $5,000,000. `dropAttention` emitted the
   "LOWERS" clause unconditionally and then appended the rookie clause, so the
   sheet's leading assertion was wrong for exactly the release whose direction
   is least obvious. The implementation followed its instruction; the
   instruction was wrong. Task text amended to require the **net** direction
   per release. **Human directed: amend spec + targeted fix, no full
   loopback** — Story 7.7's precedent, since a revert would regenerate the same
   implementation from corrected text.
   **KEEP on any re-derivation:** the sentence must state the $1,000,000
   reserve on the freed hole AND the net direction separately. Never assert a
   direction that holds for only one of the two release outcomes.

8. **`removed` was treated as synonymous with FR-43's exception.** A release is
   `removed` whenever the carried Dead Money is `$0`, which an ordinary
   Active/Bench Contract charging `$0` also satisfies — and such a release was
   told it cleared because of "a second-round rookie-scale Contract released
   with its full term unelapsed". The rookie clause must be gated on
   `releasesToNothing`, which is the question it claims to be answering.
   **KEEP:** `removed` stays the row-survival test. Do not narrow it to the
   rookie case — a $0-charged release genuinely leaves no Dead Money.

9. **Seven patches applied without spec change**, listed here so a
   re-derivation does not lose them: content assertions for the Audit Log Drop
   renderer (the only surface a Drop appears on, and inverting its
   carried/cleared ternary failed no test); `tests/routes/roster-drop.test.ts`
   driving the route as a module, which every other route in this codebase has
   and which Story 7.7's own review added for `roster-move`; a deterministic
   release order in the core rather than by the route's accident (AD-5);
   `typeof`-guarded numeric reads, since `Number('')` is `0` and `0` is not an
   absent designation; example 43's "Overflow 0" assertion; the won refusal
   naming the Auction explicitly; and a stray double blank line.

10. **Six findings rejected as noise.** The claimed `SLOT_RESERVE` drift is
    impossible — `bidding.ts`'s `MINIMUM_OPENING_BID` *is* `parseMoney(
    MINIMUM_BID)`, so both derive from one constant and the docblock is
    substantively right. The unused `teamId` on `not_held`, the first-bad-
    Player short-circuit, and discarding computed gates on a shape refusal all
    match `evaluateMove` exactly and are this codebase's settled shape. The
    Move-prefixed names on the shared outcome types are deliberate reuse. The
    migration hazard being "undiscoverable in-app" is already Ask First and
    recorded at item 6.

11. **The cap-gate tests were written twice.** Item 1's block already existed
    when the patch pass ran; the implementer read the change log, did not find
    it, and added a second `describe` under the same name. Both passed, so
    nothing failed — a duplicate `describe` is legal and the suite simply ran
    the coverage twice. The second block was kept (it adds a before-state test
    proving the Team is solvent until the act) and the first deleted.
    **KEEP:** the surviving block is the four-test one ending in "is solvent
    BEFORE the Drop — the act is what breaks it".

## Design Notes

**Why the exception is subtraction, not a branch.** Written as `deadMoney = releases2RK ? $0 : chargedCapHit(row)` with "remove the row iff `deadMoney` is `$0`", all four outcomes fall out of two lines: Active/Bench and IR carry their full charge and are reclassified; a Minor League row was charging `$0`, so nothing is carried and it is removed; a full-term `2RK` is released to `$0` and removed the same way, which is exactly "the Contract is removed rather than reclassified" and "its Cap Hit is released to Cap Space" — removing the row *is* the release. Any implementation that tests `rosterSlotKind === 'minor_league'` to decide the amount has re-spelled `chargedCapHit` and fails the second acceptance criterion.

**Why a Drop needs no reducer case.** Auction Contracts are the only thing `contractsReducer` folds, and a won Player cannot be dropped, so every released Contract is a `team_rosters` row that the same transaction mutates or removes. The event exists for replay and the Audit Log, not for a projection. If that reasoning ever stops holding — because the won refusal is lifted — the fold is where it breaks, so state the dependency in the payload's docblock.

**The already-imported-rosters hazard.** `rookie_scale_round` arrives `null` on every existing row, and `null` is indistinguishable from "ordinary Contract". A Team imported before this migration therefore has its `2RK` deals silently treated as Dead Money on a Drop. The migration cannot fix this — the round was discarded at parse time before 7.6 and never persisted after it — so the remedy is a **re-import** of the affected rosters, which is a Commissioner act and not this story's code. Raise it before the migration is applied to any environment holding real rosters; it is on the Ask First list for that reason.

**Minors Exposure recomputes by derivation, not by writing.** §10 example 43's "Minors Exposure falls to $0" happens because `teamMoneyStateFor` derives it on every evaluation from `minorLeagueOccupied`. Handing it the post-Drop occupancy is the whole of it; nothing is recalculated, stored or invalidated anywhere.

## Verification

**Commands:**
- `npm run check` -- expected: zero errors.
- `npm test` -- expected: full suite green, including example 43 and the two command-driven derivations added to 40 and 41, with every pre-existing bidding, Move and example test unchanged.
- `npm run build` -- expected: passes, including `scripts/check-core-purity.js` (`core/rules/roster-act.ts` and `core/rules/roster-drop.ts` must import only relative `.ts` paths and touch no forbidden global).

**Manual checks:**
- Apply the migration to **dev**, re-import a roster file containing a `2RK` Contract, and confirm `team_rosters.rookie_scale_round` is `2` for that row and `null` for an ordinary one.
- Sign in as Commissioner in the Auction Phase, open the Drop destination, and confirm the sheet states the Team's five figures before → after, each released Player with the Dead Money carried, and — for an Active/Bench release — the `attention` sentence saying the reserve on the freed hole, what returns to Cap Space, and the **net** direction. Check both ways round: a carried Cap Hit must read **LOWERS by $1,000,000**, and a full-term `2RK` of the same amount must read **RAISES by $1,000,000** (§10 examples 40 and 41, the same Slot and the same act).
- Confirm the destination is absent for a Manager and absent for everyone once Archived, and that the sheet is operable at 375px.
- Record a Drop and confirm the league Discord channel says nothing, while the Audit Log shows the entry.

## Suggested Review Order

**The one rule, and the exception that proves it**

- Start here: the whole act in order — shape, contested, release, gates once.
  [`roster-drop.ts:270`](../../src/lib/core/rules/roster-drop.ts#L270)

- The one expression that decides the amount. Everything else falls out of it.
  [`roster-drop.ts:246`](../../src/lib/core/rules/roster-drop.ts#L246)

- FR-43's exception, asked as one question: both facts or neither.
  [`roster-drop.ts:226`](../../src/lib/core/rules/roster-drop.ts#L226)

- Row survival is the amount being `$0` — never a test of the Slot kind.
  [`roster-drop.ts:358`](../../src/lib/core/rules/roster-drop.ts#L358)

**Saying the direction correctly — the review-loop fix**

- Highest-risk stop: the net direction is COMPUTED, so 40 falls and 41 rises.
  [`roster-drop.ts:545`](../../src/lib/core/rules/roster-drop.ts#L545)

- The rookie clause gated on the exception, not on row removal.
  [`roster-drop.ts:545`](../../src/lib/core/rules/roster-drop.ts#L545)

- One Team's block plus a row per release — rows, not a second component.
  [`reason-sheet-view.ts:391`](../../src/lib/reason-sheet-view.ts#L391)

**Reusing the bidding arithmetic rather than restating it (AR-42)**

- The extraction both commands now share; a Drop offers no amount either.
  [`roster-act.ts:225`](../../src/lib/core/rules/roster-act.ts#L225)

- The fourth fixed gate set. Flat, so it stays assignable to `GateResults`.
  [`types.ts:1208`](../../src/lib/core/types.ts#L1208)

**The write path — two statements, one transaction, off Discord**

- `UPDATE` to Dead Money, or `DELETE` when nothing is carried.
  [`roster-drop.ts:88`](../../src/lib/server/roster-drop.ts#L88)

- One event, one `ProjectionUpdater`, and deliberately no `enqueue`.
  [`roster-drop.ts:298`](../../src/lib/server/roster-drop.ts#L298)

- The event exists for replay and the Audit Log; no reducer case by design.
  [`contracts.ts:510`](../../src/lib/core/projection/contracts.ts#L510)

**The record — the only surface a Drop appears on**

- Reason first, then each release, then before → after.
  [`audit-log.ts:842`](../../src/lib/core/audit-log.ts#L842)

- Commissioner-only, in two phases, absent once Archived.
  [`destinations.ts:125`](../../src/lib/server/destinations.ts#L125)

- All three guards on `load` and on the action.
  [`+page.server.ts:57`](../../src/routes/roster-drop/+page.server.ts#L57)

**Unblocking the exception — the defect Story 7.6 left labelled**

- The column that had to exist before FR-43's exception could be read.
  [`20260911000000_rookie_scale_round.sql:40`](../../supabase/migrations/20260911000000_rookie_scale_round.sql#L40)

- The hardcoded `null` 7.6 named this story to replace, now `typeof`-guarded.
  [`staged-roster-row.ts:72`](../../src/lib/server/staged-roster-row.ts#L72)

**Peripherals**

- Content assertions that fail if the carried/cleared wording is inverted.
  [`audit-log.test.ts:570`](../../tests/core/audit-log.test.ts#L570)

- The route driven as a module, matching every other route in the repo.
  [`routes/roster-drop.test.ts`](../../tests/routes/roster-drop.test.ts)

- The cap gate exercised to FAILURE — §10 example 37's shape, one Team.
  [`roster-drop.test.ts:374`](../../tests/roster-drop.test.ts#L374)

- The mirror of example 40: the same act moving Maximum Bid the other way.
  [`example-43…test.ts`](../../tests/examples/example-43-a-stashed-drop-moves-the-maximum-bid-the-other-way.test.ts)
