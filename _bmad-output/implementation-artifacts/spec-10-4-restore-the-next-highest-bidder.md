---
title: 'Story 10.4 — Restore the next-highest bidder'
type: 'feature'
created: '2026-09-08'
status: 'done'
review_loop_iteration: 0
baseline_commit: '56a1e66c0bf24898857a6729c4fdacef9e67acad'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-10-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 10.3 cancels the winner's surplus commitments and leaves every Standard Auction it touched **leaderless** — `restoration: null` at every construction site, and `withBidCancelled` withdrawing the lead to `null` rather than handing it down. The auction then settles on who happened to fill a roster instead of on what Teams actually offered, and an Auction whose only Bid was cancelled still carries a clock nobody is in.

**Approach:** A new pure `core/rules/restore.ts` walks the cancelled Auction's surviving history downward, re-evaluates each candidate through a new `RestoreLeadingBid` command type whose fixed gate set is `{cap, slots}`, skips failures, and stops at the first pass. `close.ts`'s cascade calls it per cancellation against post-close state and records the answer on `BidCancelledPayload.restoration`; `withBidCancelled` **reads** that recorded decision to seat the restored leader — or to clear the clock and return the Auction to Awaiting Opening Bid when nothing survives re-validation.

## Boundaries & Constraints

**Always:**
- The selection algorithm is **one** pure function in `core/rules/restore.ts`, parameterised on the three axes that separate a cancellation from a Commissioner void: **retain-vs-erase** the withdrawn Bid in the fold, **leave-vs-restore** the Auction Clock, **keep-vs-remove** the League Clock reset. FR-40 passes retain/leave/keep. Story 7.2 will pass erase/restore/remove and write no selector of its own.
- Restoration is a **distinct command type** — `RestoreLeadingBid` in `core/types.ts`, with `RESTORE_LEADING_BID_GATES` frozen as `['cap', 'slots']` and its own `RestoreLeadingBidGateResults`. Never a synthetic `PlaceBid`: `increment` would be re-run against a price that has just fallen and would refuse every restoration that mattered.
- Evaluation reads **post-close** state: after the triggering Close's placement **and** after every cancellation *and every restoration* already decided in this cascade. A second restoration to the same Team must see the first.
- A failing candidate is **skipped**, and the next below is tried, down the history. A candidate is **never restored and then cancelled** — restoration is not a cascade trigger, and that bound is what terminates the cascade.
- A cancellation resets **nothing** and removes **nothing**. Where a Bid is restored the **Auction Clock is untouched** — a Restored Leading Bidder may inherit minutes. The League Clock keeps its reset; `league-clock.ts` must still have no `BidCancelled` case.
- Where **nothing** is restored the Auction returns to `awaiting_opening_bid` with `leadingBid` and `closesAt` **`null`**, however many un-cancelled Bids remain in `bids`. The Player stays on the Board and the nominator's Nomination Slot stays held (FR-9).
- The projection **reads** the recorded decision. `withBidCancelled` must not re-derive the leader from `highestStandingBid` in Standard Contention — a skipped candidate is a surviving Bid that must *not* lead.
- Re-committing the restored Team's capital is a **consequence, not a write**: once its Bid leads again, `teamMoneyStateFor` counts it. Verify this rather than coding it.
- Inside a **Minimum-Bid Contention** the lead is a fold artifact and moves with no re-validation — that is not restoration. `restoration` is `null` for a cancelled contention entry, and 10.3's artifact-successor behaviour is unchanged.
- No schema migration — `auction_events.event_type` is generic `text`.

**Ask First:**
- Any change to `evaluateCap`, `evaluateSlots`, `bidStateFor`, `teamMoneyStateFor` or `PLACE_BID_GATES` beyond *calling* them or adding the new gate-set declaration beside them.
- Adding a second database read to `loadCloseState` that is not a single batched `loadLeagueRosterDetail` over the bidding Teams.

**Never:**
- Do not bump `CORE_VERSION` — 10.1 already bumped it 1 → 2 for this epic.
- Do not append any event from `restore.ts`. It decides and appends nothing; `close.ts` stays the sole appender and the fixed order (`ContentionDrawn`, `AuctionClosed`, then each `BidCancelled`) is unchanged.
- Do not change the draw or the recorded Contender list at draw time — **Story 10.5**. Example 34's draw half stays as 10.3 left it.
- Do not write notice copy, board strings or strip/index figures — **Story 10.6**. This story adds the restored Team to the close's mention **targeting** only; the line falls back to `fallbackNotice`.
- Do not implement restoration as a new event type, a `BidVoided`, or an `UPDATE`/`DELETE` on `auction_events`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Clean restoration (ex. 31) | Team U's $2,000,000 lead on Carter cancelled; Team V's $1,500,000 survives and passes both gates | `restoration` names Team V, its Bid `seq` and $1,500,000. Fold seats V as `leadingBid`; **`closesAt` untouched**; contention stays `standard`. V's capital re-committed by consequence; V added to mention targeting | N/A |
| Skipped, not undone (ex. 32) | Below Team U: V at $1,500,000 (`seq` 150), W at $1,000,000 (`seq` 120). V has itself reached Roster Count 12 | V fails `slots`, is skipped and is **never cancelled**; W is tried, passes, and leads at $1,000,000. Price falls from $2,000,000 to $1,000,000 | N/A |
| Nothing to restore (ex. 33) | Team U's cancelled Bid was the Opening Bid; no other Bid exists | `restoration: null`. Auction → `awaiting_opening_bid`, `leadingBid` and `closesAt` **`null`**. Carter stays on the Board, Nomination Slot held. **Does not close at Team U's old expiry** | N/A |
| Every candidate fails | Two surviving un-cancelled Bids, both failing `cap` or `slots` | `restoration: null` and the same leaderless/cleared-clock outcome — even though `highestStandingBid` is non-`null` | N/A |
| Two cancellations, one candidate Team | Cascade cancels two of the winner's leads; Team Z is next-highest on both | Second candidacy is evaluated against a state that already seats Z on the first. If Z is then over its allowance it is skipped and the next below is tried | N/A |
| The winner is its own next-highest | Winner holds an older, outbid Bid on the same Auction | Skipped — it just failed the same `slots` gate. Falls out of re-validation; no special case | N/A |
| Cancelled contention entry | A Minimum-Bid Contention entry cancelled by the cascade | `restoration: null`; the fold artifact moves to the earliest surviving join exactly as in 10.3. Contention state and fixed clock unchanged | N/A |
| Malformed `restoration` on replay | A `BidCancelled` payload whose `restoration` is not a readable shape | Read defensively: degrade to `null` (leaderless) rather than throwing inside a fold, as `readCancelledPayload` already degrades the cause | Skip, do not throw |

</frozen-after-approval>

## Code Map

- `src/lib/core/types.ts:229-256` — `PlaceBid`. The shape `RestoreLeadingBid` is declared beside: `fantraxPlayerId`, `teamId`, `teamName`, `managerId`, `amount`, `kind: 'RestoreLeadingBid'`. `:747-802` `PLACE_BID_GATES` (frozen, order = reading order) and `:810-822` `PlaceBidGateResults` are the pattern `RESTORE_LEADING_BID_GATES` / `RestoreLeadingBidGateResults` follow. **`CapGateOutcome` and `SlotsGateOutcome` are reused verbatim** — same gates, same arithmetic, a narrower set.
- `src/lib/core/rules/bidding.ts:1819-1858` — `evaluate(state, command: PlaceBid, now)`. Restoration needs `cap` and `slots` only, but `evaluateSlots(state, contention.entry)` at `:1857` takes `evaluateContention`'s verdict, so the new evaluator must obtain that same classification rather than inventing one. `:1482` `evaluateCap`, `:1659` `evaluateSlots`, `:929` `evaluateContention` — all module-private today; export what the new gate set needs and nothing more.
- `src/lib/core/rules/bidding.ts:298-340` `BidState`, `:444` `TeamMoneyState`, `:522` `bidStateFor`, `:628` `teamMoneyStateFor` — **read-only**. Built per candidate Team exactly as `commitmentStands` builds them for the winner.
- `src/lib/core/rules/close.ts:538-562` — `BidCancelledPayload`. `restoration: null` at `:561` widens to `Restoration | null`; the docblock at `:531-536` naming this "Story 10.4's seam" is now spent and must be rewritten, not deleted.
- `src/lib/core/rules/close.ts:690-750` `commitmentStands` — the model for the candidate re-test: scope the Auctions, build the money state, build the `BidState`, read one gate's `passed`. Restoration differs in the Team it is about and in reading **two** gates.
- `src/lib/core/rules/close.ts:786-940` — `cascadeFor`. The insertion point: after `victim` is chosen and before the payload is built, decide the restoration; thread it into both the payload (`:886`) and the `withBidCancelled` call (`:909`) so the next iteration sees the restored leader. The `bound` at `:857` still holds — restoration cancels nothing.
- `src/lib/core/rules/close.ts:748` — `evaluate(...).slots.passed`, and `:151-200` `CloseState`. `CloseState` gains **one** member: a `rosterFiguresFor(teamId)` callback returning `TeamRosterFigures | null`, since the cascade only ever held the *winner's* three figures.
- `src/lib/core/projection/auctions.ts:900-967` — `withBidCancelled`. `BidCancellation` (`:199-207`) gains the restoration; `:961-966` is the return whose `leadingBid`/`closesAt`/`contention` must come from the recorded decision in Standard Contention. `:953` `highestStandingBid` stays the **lottery** artifact's successor and nothing more.
- `src/lib/core/projection/auctions.ts:851-897` — `readCancelledPayload`. Add the defensive read of `restoration`; the "fields this reducer does NOT read" note at `:862-865` is now half wrong.
- `src/lib/core/projection/auctions.ts:1131-1152` — the `BID_CANCELLED_EVENT` case. Passes the read restoration through; the `cancelled === existing` identity check that makes replay converge must survive.
- `src/lib/core/projection/auctions.ts:1043` — `existing.leadingBid ?? highestStandingBid(existing.bids)`, the incumbent a *new* Bid must beat. **Audit:** after a restoration `leadingBid` is set, so this is unaffected; after a failed restoration it falls back to a Bid that was skipped — decide deliberately and state which.
- `src/lib/server/close.ts:125-186` — `loadCloseState`. Add one batched `loadLeagueRosterDetail(client, <teams with a Bid in `auctions`>, contracts)` and expose it as `rosterFiguresFor`. `:187-244` `affectedTeamsForClose` — the `BID_CANCELLED_EVENT` branch at `:240` returns the cancelled Team off the row; the **restored** Team is on the payload and must be added there.
- `src/lib/server/team-roster.ts:273-300` `loadLeagueRosterDetail` (one query, many Teams), `:51-80` `TeamRosterFigures` — **read-only**, and the reason no per-candidate query is needed.
- **Read-only evidence.** `src/lib/core/projection/league-clock.ts:236-252` — the `BidVoided` case `BidCancelled` must still fall through past (AR-39). `src/lib/server/sweep.ts:439-457` — the one-at-a-time close loop (AD-11). `supabase/migrations/20260821020000_auction_events.sql:63` — `event_type text`, no migration.
- `tests/projection-auctions.test.ts:1117-1130` — existing `withBidCancelled` hand-folds; they pin the idempotence the restoration must not break.
- `tests/examples/example-31-the-cascade-fires-only-as-far-as-it-must.test.ts` — 10.3 left Team V's restoration explicitly to this story. `example-32-*.test.ts` and `example-33-*.test.ts` are **new**.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/types.ts` -- declare `RestoreLeadingBid`, frozen `RESTORE_LEADING_BID_GATES = ['cap','slots']` and `RestoreLeadingBidGateResults` reusing `CapGateOutcome`/`SlotsGateOutcome` -- AR-37's second fixed gate set; a synthetic `PlaceBid` would re-run `increment` against a fallen price and refuse every restoration that mattered.
- [x] `src/lib/core/rules/bidding.ts` -- add `evaluateRestore(state, command, now): RestoreLeadingBidGateResults` running only those two gates, and export the minimum needed -- `evaluateSlots` reads `evaluateContention`'s classification, so the new evaluator must obtain that verdict rather than invent one.
- [x] `src/lib/core/rules/restore.ts` (new) -- **one** pure selector: walk surviving Bids descending by amount, re-evaluate each, skip failures, stop at the first pass, return the candidate or `null`; parameterise on the retain/erase, leave/restore and keep/remove axes and name Story 7.2 as the consumer -- AR-36 requires one selector for both FR-40 and the void.
- [x] `src/lib/core/rules/close.ts` -- widen `BidCancelledPayload.restoration` to `Restoration | null`, widen `CloseState` with `rosterFiguresFor`, and call the selector inside `cascadeFor` per cancellation -- the decision must ride the event, because re-deriving it means re-running gates inside a fold.
- [x] `src/lib/core/rules/close.ts` -- thread each restoration into the same `withBidCancelled` the reducer will fold, before the next cascade iteration -- a second restoration to one Team must be judged against the first.
- [x] `src/lib/core/projection/auctions.ts` -- carry the restoration on `BidCancellation`, read it defensively in `readCancelledPayload`, and make `withBidCancelled` seat the recorded leader in Standard Contention (clearing `closesAt` and returning to `awaiting_opening_bid` only when it is `null`) -- a skipped candidate is a surviving Bid that must not lead, which is exactly what `highestStandingBid` would do.
- [x] `src/lib/server/close.ts` -- load the bidding Teams' roster figures in one batched read, pass `rosterFiguresFor` through, and add the restored Team to `affectedTeamsForClose` -- a Manager must not miss the notice telling them they are winning again.
- [x] `_bmad-output/planning-artifacts/epics.md` -- add one line to Story 7.2 citing `core/rules/restore.ts` as the selector it consumes -- the story's own AC requires 7.2's specification to cite it.
- [x] `tests/core/restore.test.ts` (new) -- cover every I/O Matrix row of the selector, the two-cancellations-one-Team accumulation and the winner-as-own-candidate case -- the matrix is the selector's contract.
- [x] `tests/projection-auctions.test.ts` -- pin the fold: restored leader seated from the record, skipped candidate not promoted, leaderless with surviving Bids, malformed `restoration` degrading to `null`, and idempotence preserved -- the fold reads a decision it must never re-make.
- [x] `tests/examples/example-31-*.test.ts` -- add Team V's restoration half, asserting the Auction Clock is untouched and the League Clock did not move -- 10.3 deferred exactly this.
- [x] `tests/examples/example-32-*.test.ts`, `example-33-*.test.ts` (new) -- name and work both examples, including 33's negative assertion that the Auction does not close at the old expiry with no winner -- these two are the story's stated acceptance.

**Acceptance Criteria:**
- Given a restoration, when the log is read, then one `BidCancelled` carries the cancelled `seq`, the cause **and** the restored Team, Bid `seq` and amount — with no second event appended by `restore.ts`.
- Given a restored Bid, when the restored Team's Committed Bids are next derived, then its amount is counted again — without any explicit re-commit being written.
- Given `grep -rn "BidCancelled" src/lib/core/projection/league-clock.ts`, when it runs, then there is no match.
- Given `npm run check`, when it runs, then it is clean and `RestoreLeadingBid` is evaluated through its own gate set with no `PlaceBid` construction in `restore.ts`.
- Given `npm test`, when the suite runs, then it is green and §10 examples 18–25 and 29–35 all pass.

## Design Notes

**The fold stops guessing.** 10.3 could derive the post-cancellation lead from `highestStandingBid` because the answer was always "nobody" outside a lottery. Restoration breaks that: example 32's Team V survives, is *higher* than the restored Team W, and must not lead. So Standard Contention now reads `cancellation.restoration` and nothing else, and the leaderless branch is `restoration === null` rather than `standing === null`. The lottery branch keeps `highestStandingBid` — there the lead is a fold artifact over identical flat amounts and no re-validation applies.

**Why the cascade threads restorations through `withBidCancelled`.** The cascade already re-derives its `auctions` through the same function the reducer will fold. Once restoration is part of that function's output, a candidate evaluated on iteration 2 automatically sees whatever iteration 1 restored — including a Team restored twice, which is the only way one cascade can push a *non-winning* Team over its allowance.

```
for each cancellation:
  victim   = max(seq) among commitments that no longer stand
  restored = selectRestoration(auction after victim withdrawn, post-close basis)
             # descending by amount; evaluateRestore; skip failures; first pass wins
  append BidCancelled{ victim, cause, restored | null }
  auctions = withBidCancelled(auctions, victim.seq, { cause, restoration: restored })
```

**Post-close, per candidate.** The Close changes the *winner's* roster and nobody else's, so a candidate's `TeamRosterFigures` are the pre-close read — correct as loaded. What does change under the candidate is its committed capital, and that is derived from `auctions`, which the cascade is already threading. Hence one batched roster read and no per-candidate query.

## Verification

**Commands:**
- `npm test` -- expected: green.
- `npx vitest run tests/examples` -- expected: 18–25 and 29–35 pass; 31, 32, 33 exercise restoration.
- `npm run check` -- expected: no errors.
- `grep -rn "BidCancelled" src/lib/core/projection/league-clock.ts` -- expected: **no** match (AR-39).
- `grep -n "PlaceBid" src/lib/core/rules/restore.ts` -- expected: **no** match. Restoration is its own command type.
- `git diff --stat -- supabase/migrations` -- expected: empty.

## Suggested Review Order

**The selector**

- The whole story in one walk: descend, re-evaluate, skip, stop at the first pass.
  [`restore.ts:174`](../../src/lib/core/rules/restore.ts#L174)

- The three axes that make one function serve FR-40 and Story 7.2's void alike.
  [`restore.ts:83`](../../src/lib/core/rules/restore.ts#L83)

- The gate the candidate is judged by — the whole commitment set, never new arithmetic.
  [`restore.ts:240`](../../src/lib/core/rules/restore.ts#L240)

- Highest first, earliest `seq` on a tie, through `BigInt` as `fold()` compares it.
  [`restore.ts:207`](../../src/lib/core/rules/restore.ts#L207)

**The command type**

- AR-37's second fixed gate set: two gates, because `increment` would refuse a fallen price.
  [`types.ts:882`](../../src/lib/core/types.ts#L882)

- The evaluator, obtaining the contention classification rather than inventing one.
  [`bidding.ts:1897`](../../src/lib/core/rules/bidding.ts#L1897)

**The cascade**

- Where the decision is made and threaded, so the next candidate sees this one.
  [`close.ts:980`](../../src/lib/core/rules/close.ts#L980)

- The winner's post-close figures — a fair test, not a guaranteed refusal.
  [`close.ts:909`](../../src/lib/core/rules/close.ts#L909)

- The seam 10.3 left, now carrying its own decision.
  [`close.ts:598`](../../src/lib/core/rules/close.ts#L598)

**The fold**

- Leadership seated from the record, because a skipped candidate must not lead.
  [`auctions.ts:1065`](../../src/lib/core/projection/auctions.ts#L1065)

- The Bid comes from history; the payload's amount never sets a price.
  [`auctions.ts:1126`](../../src/lib/core/projection/auctions.ts#L1126)

- Read defensively, down to Money's own domain — a fold may never throw.
  [`auctions.ts:996`](../../src/lib/core/projection/auctions.ts#L996)

- What the type does and does not guarantee about the restored Team's identity.
  [`auctions.ts:241`](../../src/lib/core/projection/auctions.ts#L241)

**The shell**

- One batched read over the bidding Teams — a superset of every candidate.
  [`close.ts:234`](../../src/lib/server/close.ts#L234)

- Two Teams, one event: the restored Manager is owed the notice too.
  [`close.ts:174`](../../src/lib/server/close.ts#L174)

**Tests**

- The invariant proved rather than argued: restored is never then cancelled.
  [`close.test.ts:1043`](../../tests/core/close.test.ts#L1043)

- The skipped candidate, and the price that correctly falls below a survivor.
  [`example-32`](../../tests/examples/example-32-a-restoration-that-is-skipped-not-undone.test.ts)

- Nothing to restore: no leader, no clock, and no close at the old expiry.
  [`example-33`](../../tests/examples/example-33-a-restoration-with-nothing-to-restore.test.ts)

- The selector's own matrix, including the two-cancellation accumulation.
  [`restore.test.ts`](../../tests/core/restore.test.ts)
