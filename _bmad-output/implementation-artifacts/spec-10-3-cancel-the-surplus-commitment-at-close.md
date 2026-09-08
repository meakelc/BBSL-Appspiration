---
title: 'Story 10.3 — Cancel the surplus commitment at Close'
type: 'feature'
created: '2026-09-08'
status: 'done'
review_loop_iteration: 0
baseline_commit: '7cfe34e6ec7ef3163bba6965bde7bed85ad07bf1'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-10-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Stories 10.1 and 10.2 widened what a Team may hold — one Bid beyond its Free Active/Bench Slots, and unlimited lottery entries — but nothing takes the surplus back. A Team can currently win a thirteenth Player, which is the exact invariant the roster ceiling exists to protect. FR-40 requires that an Auction Close reducing the winning Team's free Slots cancels its now-unlandable commitments.

**Approach:** `decideClose` derives the winner's **post-close** capacity picture and runs a cascade that cancels surviving commitments most-recent-first by `seq`, re-testing FR-37/FR-18 through the existing `evaluateSlots` after each, stopping the moment the Team is within capacity. Each cancellation appends one `BidCancelled` compensating event carrying the cancelled `seq`, the cause, and a `restoration` field. `auctionsReducer` reads that recorded decision, strips leadership from the cancelled Bid while retaining it as history, and drops a cancelled Contender.

## Boundaries & Constraints

**Always:**
- The trigger is **a Close that reduces the winning Team's free Slots — Active/Bench or Minor League**. Never a Bid, a Nomination, a clock, or a restoration. A Minor-League win at $0 Cap Hit leaving Roster Count unchanged still fires it.
- The cascade evaluates **post-close** state: after this Close's placement (Roster Count, Cap Space, Minor League occupancy) and with the won Auction removed from `byPlayer`. A pre-close snapshot is the subtle version of this bug.
- Cancel **one at a time, most recent first by `seq`**, re-testing after each, stopping as soon as the Team is within both FR-37 and FR-18. A Team already within capacity has **nothing** cancelled.
- An eligible leading Bid a free Minor League Slot can still absorb is **left untouched however recent** — this falls out of `evaluateSlots`' eligible branch and must not be re-stated as a second rule.
- `close.ts` is the **sole appender**. Event order within the one transaction is fixed: `ContentionDrawn` (lottery only), then `AuctionClosed`, then each `BidCancelled` in cascade order.
- The original `BidPlaced` is **never** deleted or mutated. It stays a history line; `seq` ordering is unchanged.
- A cancellation resets **nothing** and removes **nothing**: the Auction Clock is untouched where a Bid survives, and the League Clock keeps its reset. `leagueClockReducer` must **not** treat `BidCancelled` as it treats `BidVoided`.
- Committed capital release is a **consequence, not a write**: once the cancelled Bid no longer leads, `teamMoneyStateFor` stops counting it. Verify this rather than coding it.
- No schema migration — `auction_events.event_type` is generic `text`.

**Ask First:**
- Any change to `evaluateSlots`, `evaluateCap`, `projectedAdditionsFor`, `teamMoneyStateFor` or the two overflow derivations beyond *calling* them. This story consumes 10.1/10.2's rule; it does not amend it.
- Any change to `closedWinnerFor`, `slotPlacementFor` or `capHitFor`.

**Never:**
- Do not bump `CORE_VERSION` — 10.1 already bumped it 1 → 2 for this epic.
- Do not create `core/rules/restore.ts`, and do not populate `restoration` with anything but `null`. **Story 10.4** owns the restorer, the `RestoreLeadingBid` gate set, and §10 examples 31 (second half), 32 and 33.
- Do not change the draw or the recorded Contender list at draw time — **Story 10.5**.
- Do not write notice copy, board or strip figures — **Story 10.6**. This story adds cancelled Teams to the close's mention targeting only; the league line falls back to `fallbackNotice` until 10.6.
- Do not implement cancellation as a synthetic bid, a `BidVoided`, or an `UPDATE`/`DELETE` on `auction_events`.

## I/O & Edge-Case Matrix

`F` = free Active/Bench Slots, `M` = free Minor League Slots, all **post-close**.

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Within capacity after the Close (ex. 31, first close) | Team wins Anderson → rc 11, `F=1`; two surviving non-eligible leads | **Nothing cancelled.** One `AuctionClosed`, no `BidCancelled`. The cascade is conditional, not a reflex | N/A |
| The cascade fires once (ex. 31, second close) | Team wins Brooks → rc 12, `F=0`; one surviving lead on Carter at `seq` 190 | **One** `BidCancelled` for `seq` 190, cause = the Brooks close, `restoration: null`. $2,000,000 released. Carter's history keeps the Bid; its Auction Clock is untouched | N/A |
| Minor-League trigger at unchanged Roster Count (ex. 35) | rc 12 `F=0`, wins an eligible lottery into the last Minor League Slot at $0 Cap Hit → `M` 1→0; two eligible entries survive | **Cascade still fires** — a free Slot was reduced. Both entries cancelled, both removed from their Contender lists | N/A |
| Most-recent-first, and it stops (ex. 34) | rc 12 `F=0` after a lottery win; five surviving entries | Cancelled in descending `seq` until within capacity — here all five, releasing $5,000,000. Stops the instant the test passes | N/A |
| Eligible commitment a minors Slot absorbs | `F=0`, `M=1`, surviving eligible lead placed most recently | **Not cancelled**, however recent. An older non-eligible commitment is cancelled instead if one is over | N/A |
| Cancelling the leader leaves no survivor | Carter's cancelled Bid was the Opening Bid, nobody else bid | Auction goes **leaderless**: `leadingBid`/`closesAt` `null`, `contention` back to `awaiting_opening_bid`. Player stays on the Board, nominator's Slot stays held, no close at the old expiry | N/A |
| A Close that reduces no free Slot | Winner already at `F=0`, `M=0` before and after (overflow into a filled roster is impossible here) | **No cascade.** Trigger is a *reduction*, tested against pre- vs post-close figures | N/A |

</frozen-after-approval>

## Code Map

- `src/lib/core/rules/close.ts:151-177` — `CloseState`. Gains what the cascade needs and the loader already holds: `auctions: OpenAuctions`, the winner's `capSpace` and `rosterCount` beside the existing `minorLeagueOccupied:159`, and `isMinorLeagueEligible` / `playerNameFor` (`teamMoneyStateFor`'s two callbacks).
- `src/lib/core/rules/close.ts:480-484` — `decideClose(state, now, winner): Accepted<readonly EventEnvelope[]>`. Already returns a **list** (`[drawn, closed]` at `:649-663`, `[closed]` at `:554`); the cascade appends onto it. This is where the fixed event order lives.
- `src/lib/core/rules/close.ts:311-318` `slotPlacementFor` and `:338-340` `capHitFor` (`NO_CAP_HIT` on `minor_league`), consumed at `:517`. **Read-only** — they give the post-close deltas: `rosterCount + 1`, `capSpace − capHit`, `minorLeagueOccupied + 1` on a minors placement.
- `src/lib/core/rules/bidding.ts:522-556` — `bidStateFor(auction, team, eligible, phase)`. The reuse point for re-testing a survivor; note its `auction === null` branch already yields `awaiting_opening_bid`, and it dereferences `auction.leadingBid` at `:543` — which becomes nullable.
- `src/lib/core/rules/bidding.ts:616-628` — `teamMoneyStateFor`. Called once per cascade iteration over the **post-close** `OpenAuctions`; `:1629` `evaluateSlots(state, entry)` and `:899-903` `evaluateContention` are the re-test. All three **read-only**.
- `src/lib/core/projection/auctions.ts:154-180` — `Bid` (`seq:156`). Gains a nullable cancellation marker so the history line can be rendered struck-through later.
- `src/lib/core/projection/auctions.ts:194-243` — `Auction`. `leadingBid:198` and `closesAt:200` become **nullable**; the `:182-192` doc block asserting non-nullability is the invariant FR-40 breaks and must be rewritten, not deleted.
- `src/lib/core/projection/auctions.ts:709-836` — `auctionsReducer`. Add a `BID_CANCELLED_EVENT` case beside `BID_PLACED_EVENT:711-782`; `AUCTION_CLOSED_EVENT:825-834` still `omitKey`s the whole entry, unchanged.
- `src/lib/core/projection/auctions.ts:547-564` — `contendersFor`, recomputed from `bids` each fold at `:769`. Must skip cancelled Bids — this is how a cancelled Contender leaves the list.
- `src/lib/core/projection/league-clock.ts:108,236-252` — `BID_VOIDED_EVENT` and its `voidedSeqs` case. **Read-only, and the trap**: `BidCancelled` must fall through to the default. A reducer treating them alike ends the Auction Phase early every time a roster fills.
- `src/lib/server/close.ts:123-165` — `loadCloseState`. Already folds `auctions` (`:129`) and reads the winner's `TeamRosterFigures` (`:150`, all three figures, two currently discarded). Pass them through; no new query.
- `src/lib/server/close.ts:187-232` — `affectedTeamsForClose`. Gains the cancelled Teams for `BidCancelled`, off the decided events rather than the payload.
- `src/lib/server/team-roster.ts:51-80,303-314` — `TeamRosterFigures` `{capSpace, rosterCount, minorLeagueOccupied}`. **Read-only.**
- **Read-only evidence.** `src/lib/shell/write.ts:270-286` — one insert per event, `seq` database-assigned, so the core orders only on already-folded `seq`s. `src/lib/server/sweep.ts:439-457` — the one-at-a-time close loop (AD-11), already correct. `supabase/migrations/20260821020000_auction_events.sql:63` — `event_type text`, no migration.
- **Consumers of `Auction.leadingBid` the nullability change reaches** — audit and repair, do not redesign: `src/lib/core/rules/close.ts:280-291`, `src/lib/server/close.ts:216-219`, and every `auctionForPlayer` caller.
- `tests/examples/example-31-*.test.ts` (new), `example-34-unlimited-lotteries.test.ts:124`, `example-35-the-trigger-is-a-free-slot.test.ts:125` — 34 and 35 exist from 10.2 with their entry halves; this story adds their close halves.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/rules/close.ts` -- widen `CloseState` with the winner's post-close inputs (`auctions`, `capSpace`, `rosterCount`, the two callbacks) -- the cascade cannot re-test capacity against a state that does not carry it, and the loader already holds every one of these.
- [x] `src/lib/core/rules/close.ts` -- derive the post-close figures from `slotPlacementFor`/`capHitFor` and compute the **free-Slot reduction** trigger over both Slot kinds -- a trigger phrased as "increases Roster Count" misses example 35 entirely.
- [x] `src/lib/core/rules/close.ts` -- implement the cascade: most-recent-`seq`-first over surviving commitments, re-testing through `evaluateSlots`/`evaluateContention` after each, stopping at the first pass -- one rule, evaluated by the function that already owns it.
- [x] `src/lib/core/rules/close.ts` -- emit `BidCancelled` events after `AuctionClosed`, each carrying the cancelled `seq`, the causing Close, and `restoration: null` -- AD-31's one fact, one event, one writer; the null is Story 10.4's seam and nothing else.
- [x] `src/lib/core/projection/auctions.ts` -- add the `BidCancelled` case: mark the Bid cancelled, recompute `leadingBid`/`closesAt`/`contention` from surviving Bids per the **recorded** decision, and skip cancelled Bids in `contendersFor` -- re-deriving the decision would mean re-running the gate suite inside a fold.
- [x] `src/lib/core/projection/auctions.ts` -- make `leadingBid` and `closesAt` nullable and rewrite the `:182-192` invariant doc block -- FR-40 creates a leaderless Auction that still has history, which the old invariant denied.
- [x] `src/lib/core/rules/bidding.ts`, and every other `Auction.leadingBid` consumer -- repair for nullability without changing behaviour -- a leaderless Auction must read as `awaiting_opening_bid`, the state `bidStateFor` already models.
- [x] `src/lib/server/close.ts` -- pass the widened state through `loadCloseState` and add cancelled Teams to `affectedTeamsForClose` -- the roster read already returns all three figures; who a cancellation affects is on no payload.
- [x] `tests/core/close.test.ts` -- cover every I/O Matrix row, including the two negatives (within capacity, no free-Slot reduction) and the eligible commitment left untouched -- the matrix is the cascade's contract.
- [x] `tests/examples/example-31-*.test.ts` -- add as a named `§10 example 31` file covering the first close cancelling nothing and the second cancelling Carter's Bid; assert the Auction Clock is untouched and the League Clock did not move. Leave Team V's restoration to Story 10.4.
- [x] `tests/examples/example-34-*.test.ts`, `example-35-*.test.ts` -- extend with their close halves: 34's win cancelling five entries most-recent-first, 35's Minor-League trigger at unchanged Roster Count -- these are the two examples the trigger wording is tested by.
- [x] `tests/server/close.test.ts`, `tests/server/sweep-sequential.test.ts` -- assert the appended event order within one transaction and that a cancellation commits before the next Close is evaluated -- AD-11 is now load-bearing rather than merely correct.

**Acceptance Criteria:**
- Given any event that is not an Auction Close, when it is processed, then no cancellation cascade runs.
- Given a cancellation, when the log is read, then the original `BidPlaced` is present and unmodified, a `BidCancelled` names its `seq` and the causing Close, and the Audit Log shows both.
- Given a cancelled Bid, when the Team's Committed Bids are next derived, then its amount is no longer counted — without any explicit release being written.
- Given `npm run check`, when it runs, then every `Auction.leadingBid` consumer compiles against the nullable field with no non-null assertions.
- Given `npm test`, when the suite runs, then it is green and §10 examples 18–25 and 29–35 all pass.

## Design Notes

**Post-close state, assembled in the core.** `loadCloseState` reads the winner's roster *before* this close, and folds `auctions` *including* the Auction being closed. The cascade therefore cannot use them raw. `decideClose` already knows the placement and the Cap Hit, so it derives the post-close figures itself and drops the won Player from `byPlayer` — the same basis AD-11 hands the next Close. Handing the cascade the loaded snapshot restores the Team the Close just disqualified.

**Why the re-test is `evaluateSlots` and not new arithmetic.** "Within capacity" is the same question 10.1 and 10.2 answered: build a `BidState` for each surviving commitment against the *other* survivors and ask the gate. The allowance, the `F ≥ 1` precondition, the entry exemption and the eligible-absorbs-it carve-out all come along for free. Example 31's first close is within capacity precisely because the allowance is `1 + 1 = 2` and it holds 2 — a hand-rolled `holdings ≤ F` test would cancel a Bid the rule permits.

```
loop:
  over = commitments failing evaluateSlots against the rest
  if over is empty: stop
  cancel max(seq) among over        # eligible-absorbable ones never appear in `over`
  recompute post-close state; repeat
```

**The nullable leader is not scope creep.** `Auction.leadingBid` is non-nullable today on a stated invariant — "any non-empty set of Bids has a highest one." FR-40 falsifies it: a non-empty set of Bids can have no *surviving* highest one. Removing the Auction entry instead would clear the clock correctly but erase the history FR-40 requires kept visible.

## Verification

**Commands:**
- `npm test` -- expected: green.
- `npx vitest run tests/examples` -- expected: 18–25 and 29–35 all pass; 31, 34, 35 exercise the cascade.
- `npm run check` -- expected: no errors, no `!` assertions introduced on `leadingBid`.
- `grep -rn "BidCancelled" src/lib/core/projection/league-clock.ts` -- expected: **no** match. The League Clock must not see it.
- `git diff --stat -- supabase/migrations` -- expected: empty. No migration.

## Suggested Review Order

**The rule**

- The whole story in one function: the trigger, the loop, the stop condition.
  [`close.ts:813`](../../src/lib/core/rules/close.ts#L813)

- Most recent first, read from the other end — a seniority walk, and why.
  [`close.ts:772`](../../src/lib/core/rules/close.ts#L772)

- The re-test is 10.1/10.2's own gate, never new arithmetic.
  [`close.ts:711`](../../src/lib/core/rules/close.ts#L711)

- The winner's surviving commitments, with the `seq` the cascade orders on.
  [`close.ts:601`](../../src/lib/core/rules/close.ts#L601)

**The record**

- One event carrying its own decision; `restoration` typed `null` as 10.4's seam.
  [`close.ts:538`](../../src/lib/core/rules/close.ts#L538)

- The compensating event name — no migration, `event_type` is generic text.
  [`auctions.ts:121`](../../src/lib/core/projection/auctions.ts#L121)

**The fold**

- Leadership withdrawn, history retained, a cancelled Contender dropped.
  [`auctions.ts:921`](../../src/lib/core/projection/auctions.ts#L921)

- Leaderless is not bidless: the fix that stops a lower Bid taking the lead.
  [`auctions.ts:650`](../../src/lib/core/projection/auctions.ts#L650)

- Read defensively; a malformed cause degrades to words, never a blank.
  [`auctions.ts:847`](../../src/lib/core/projection/auctions.ts#L847)

**The surface**

- The canonical statement of how a leaderless Auction reads, cited by the others.
  [`board.ts:405`](../../src/lib/core/board.ts#L405)

- Who a cancellation is owed to, taken off the decided event itself.
  [`close.ts:232`](../../src/lib/server/close.ts#L232)

**Tests**

- The cascade's contract: every I/O matrix row, both negatives included.
  [`close.test.ts`](../../tests/core/close.test.ts)

- The cascade fires, and only as far as it must.
  [`example-31`](../../tests/examples/example-31-the-cascade-fires-only-as-far-as-it-must.test.ts)

- The trigger is a free Slot, at a Roster Count that never moved.
  [`example-35`](../../tests/examples/example-35-the-trigger-is-a-free-slot.test.ts)

- One win ends five lotteries, most recent first.
  [`example-34`](../../tests/examples/example-34-unlimited-lotteries.test.ts)

- The leaderless window pinned on both surfaces, for both Teams.
  [`positions.test.ts`](../../tests/positions.test.ts)
