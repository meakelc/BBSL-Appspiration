---
title: 'Reinstate a cancelled Bid (Commissioner override)'
type: 'feature'
created: '2026-09-25'
status: 'done'
baseline_commit: '33446d43cde926465191bf1d48d3f19b041a9f80'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** An FR-40 `BidCancelled` can withdraw a Bid that should have stood — prod case: DET's $2,000,000 lead on Dalton Knecht (`*06mk9*`, BidPlaced seq 5218, closesAt 2026-09-25T15:15:01.801Z) was cancelled at seq 5479 by DET's own Cam Whitmore close because Jimmy Butler had not yet been moved to IR; NYK then opened a $1,000,000 Minimum-Bid Contention at seq 5534 that closes 2026-09-26T16:57Z. No path undoes a cancellation, and the log is insert-only (AD-4).

**Approach:** A general Commissioner override appends one compensating `BidCancellationReversed` event naming the `BidCancelled` seq. The fold re-seats the reinstated Bid as leader with its ORIGINAL `closesAt` and erases every Bid placed on that Auction after the cancellation (void treatment: out of `bids`, capital released, League Clock reset removed). If that clock has already passed, the next tick's ordinary close awards the Player — the override never appends `AuctionClosed` itself.

## Boundaries & Constraints

**Always:** mandatory reason via `requireOverrideReason` / payload `reason`; three guards (Commissioner → live destination → overridable phase) on load AND action; decision re-derived inside `runTransactionalWrite` under the advisory lock, never trusted from the preview; the reinstated Team re-passes the `RestoreLeadingBid` gate set as of now (refuse, never cancel); refusals are values (AD-1); core stays pure (AD-2); broadcast with actor and reason.

**Ask First:** changing `rules/close.ts` or the cascade; any new DB table/migration; reinstating Minimum-Bid Contention entries.

**Never:** UPDATE/DELETE on `auction_events`; appending `AuctionClosed`/`BidCancelled` from this override; a second restoration selector; building Story 7.2's standalone void route.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Clock passed (Knecht) | cancelled lead, closesAt past, later Bids of any amount | event appended; later Bids erased; Auction leads on reinstated Bid with expired clock; next tick closes it to that Team at that amount | N/A |
| Clock running | closesAt future, later Bids all ≤ amount | reinstated Bid leads with original closesAt; later Bids erased | N/A |
| Outbid fairly | closesAt future, a later Bid > amount | refused `outbid` | nothing written |
| Gates fail now | reinstated Team fails cap or slots re-test | refused `gates`, names the failing gate | nothing written |
| Lottery entry | `wasContentionEntry: true` | refused `contention_entry` | nothing written |
| Already reinstated | a `BidCancellationReversed` names this seq | refused `already_reinstated` | nothing written |
| Auction ended / lottery resolved | Player closed, terminated, drawn or dissolved after the cancellation | refused `auction_ended` | nothing written |
| Wrong phase | not Auction | refused `phase` | nothing written |
| Unknown seq | no `BidCancelled` at seq | refused `no_such_cancellation` | nothing written |

</frozen-after-approval>

## Code Map

- `src/lib/core/projection/auctions.ts` -- `withBidCancelled` L1147 (idiom to mirror), `auctionsReducer` L1255 (add case), `highestStandingBid`/`contendersFor` L797/821, `contentionForAmount` L777.
- `src/lib/core/projection/league-clock.ts` -- `leagueClockReducer` L208, `voidedSeqs` + `BID_VOIDED_EVENT` L236: new case adds each erased seq to `voidedSeqs`.
- `src/lib/core/rules/restore.ts` -- private `candidateStands` L239: export it (rename `bidStandsFor`) and reuse for the gate re-test; `RestorationBasis` L116.
- `src/lib/core/rules/close.ts` -- `BidCancelledPayload` L712 (read shape); `closedWinnerFor` L438 trusts the fold's leader (why the tick awards DET). Read-only.
- `src/lib/core/rules/close-reversal.ts` -- template: `closeReversalFactsFor` L223 (one pure scan), `decideCloseReversal` L442, refusal detail L561, act sentence L676.
- `src/lib/server/close-reversal.ts` -- template: `loadCloseReversalState` L82, `previewCloseReversal` L126, `affectedTeamsForReversal` L149, `recordCloseReversal` L166 (`runTransactionalWrite`, `enqueueBroadcastsAndMentions`).
- `src/routes/close-reversal/+page.server.ts`, `+page.svelte` -- route template: `guard` L47, seq from query L68, `actorFrom` L56.
- `src/lib/server/destinations.ts:165` -- register `destination('bid-reinstatement', 'Reinstate a Bid', '/bid-reinstatement', true, false)` in the Auction phase only.
- `src/lib/reason-sheet-view.ts:580-645` -- close-reversal rows/label pattern.
- `src/lib/core/audit-log.ts:1137-1213, 1276` -- `renderCloseReversal` + `RENDERERS` entry to mirror.
- `src/lib/adapters/discord/broadcast.ts:54-75, 404-429`; `mention.ts:146-158, 251-277, 342-360` -- AuctionCloseReversed additions to mirror.
- `src/routes/auction/[fantraxPlayerId]/+page.svelte:888-910` (+ its `+page.server.ts`) -- cancelled history row; add Commissioner-only "Reinstate" link carrying the `BidCancelled` seq.
- `tests/fixtures/close-reversal-log.ts` (`ev()` helper), `tests/{core,server,routes}/close-reversal.test.ts` -- test templates.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/projection/auctions.ts` -- export `BID_CANCELLATION_REVERSED_EVENT`, payload reader, `withBidReinstated`, reducer case -- the fold is the whole effect.
- [x] `src/lib/core/projection/league-clock.ts` -- case adding erased seqs to `voidedSeqs` -- AD-22 void treatment.
- [x] `src/lib/core/rules/restore.ts` -- export `bidStandsFor` -- one gate re-test, no second selector.
- [x] `src/lib/core/rules/bid-reinstatement.ts` (new) -- facts scan, `decideBidReinstatement(state, reason, now)`, payload type, refusal detail, act sentence, consequence notes (incl. League Clock before→after expiry) -- pure decision.
- [x] `src/lib/server/bid-reinstatement.ts` (new) + `src/routes/bid-reinstatement/+page.server.ts`, `+page.svelte` (new) + destinations entry + `reason-sheet-view.ts` rows -- the override surface.
- [x] `src/lib/core/audit-log.ts`, `broadcast.ts`, `mention.ts` -- label "Bid Reinstatement", headline, broadcast line naming actor, reason, reinstated Team and erased bidders; mention reinstated and erased Teams.
- [x] Auction page -- Commissioner-only link on a cancelled, non-entry history row.
- [x] `tests/core/bid-reinstatement.test.ts`, `tests/server/…`, `tests/routes/…` -- every matrix row, fold replay convergence, league-clock void, and a golden replay of the Knecht log shape ending in `overdueAuctions` offering the Auction led by DET at $2,000,000.

**Acceptance Criteria:**
- Given an accepted reinstatement, when the log is refolded twice, then state is identical and no `auction_events` row was updated or deleted.
- Given an erased later Bid, when its Team's money state is read, then that capital is no longer committed.
- Given a non-Commissioner or blank reason, when posting to `/bid-reinstatement`, then it is refused before any write.

## Design Notes

**Spine addendum (AD-31, to fold into the spine later via `bmad-architecture`):** a cancellation is still caused only by a Close; it may be *reversed* only by a Commissioner override appending `BidCancellationReversed`, which re-seats the cancelled Bid with its original Auction Clock and voids every Bid on that Auction placed after the cancellation (erase / League Clock reset removed). It never appends a close; an expired reinstated clock is closed by the ordinary sweep, so `close.ts` stays the sole close appender and the FR-40 cascade runs on that close.

An erased Minimum-Bid Contention opening leaves its sealed row in `auction_contention_seeds`; it is dead weight the next opening's upsert overwrites (`server/bidding.ts:392-415`), and its commitment is never revealed because the lottery is ruled never to have run — the Audit Log entry says so.

## Verification

**Commands:**
- `npm test` -- expected: all suites pass
- `npm run check` -- expected: 0 errors

## Suggested Review Order

**The fold — what a reinstatement does**

- Entry point: the whole effect — re-seat the cancelled Bid on its original clock, erase every later Bid.
  [`auctions.ts:1323`](../../src/lib/core/projection/auctions.ts#L1323)

- Reducer case reads only Player and cancellation seq; replay converges because the marker is gone.
  [`auctions.ts:1596`](../../src/lib/core/projection/auctions.ts#L1596)

- Erased Bids lose their League Clock reset — the void's treatment (AD-22).
  [`league-clock.ts:253`](../../src/lib/core/projection/league-clock.ts#L253)

**The decision — when it is allowed**

- Refusal order: phase, unknown, already reinstated, lottery entry, ended, outbid, figures, gates.
  [`bid-reinstatement.ts:423`](../../src/lib/core/rules/bid-reinstatement.ts#L423)

- One pure scan of the log feeding both the sheet and the locked transaction.
  [`bid-reinstatement.ts:190`](../../src/lib/core/rules/bid-reinstatement.ts#L190)

- The gate re-test reuses the restorer's evaluation; no second selector.
  [`restore.ts:262`](../../src/lib/core/rules/restore.ts#L262)

**The shell and the surface**

- Re-decides under the advisory lock with the lock's clock; appends one event, never a close.
  [`bid-reinstatement.ts:188`](../../src/lib/server/bid-reinstatement.ts#L188)

- Three guards on load and action; reason required before any transaction.
  [`+page.server.ts:53`](../../src/routes/bid-reinstatement/+page.server.ts#L53)

- Auction phase only, Commissioner-only, unlisted.
  [`destinations.ts:171`](../../src/lib/server/destinations.ts#L171)

- Link shown only for cancellations recorded as non-entries.
  [`auction-page.ts:701`](../../src/lib/server/auction-page.ts#L701)

**The record and the notice**

- Audit Log entry: reason, erased Bids, lottery ruling, League Clock.
  [`audit-log.ts:1229`](../../src/lib/core/audit-log.ts#L1229)

- League broadcast naming actor, reason, reinstated Team and erased bidders.
  [`broadcast.ts:463`](../../src/lib/adapters/discord/broadcast.ts#L463)

- Mentions fail closed; already-cancelled erased Bids are not addressed.
  [`mention.ts:392`](../../src/lib/adapters/discord/mention.ts#L392)

**Tests**

- The Knecht log, real seqs, ending with DET due to win at $2,000,000.
  [`bid-reinstatement-log.ts:1`](../../tests/fixtures/bid-reinstatement-log.ts#L1)

- Every matrix row, nested cancellation, replay convergence.
  [`bid-reinstatement.test.ts:1`](../../tests/core/bid-reinstatement.test.ts#L1)
