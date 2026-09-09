---
title: 'Story 10.5 — A lottery whose contenders were cancelled'
type: 'feature'
created: '2026-09-09'
status: 'done'
review_loop_iteration: 0
baseline_commit: '36e2f11a01075b6ba93afe7659279f4b480ab6ee'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-10-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 10.3 already drops a cancelled Contender from `contendersFor`, so the *first* half of this story is done — but the case where the cascade cancels the **last** Contender is not. `withBidCancelled` collapses that lottery to `awaiting_opening_bid` with `closesAt: null`, so `overdueAuctions` never offers it, no draw is recorded, the sealed seed never opens, and the nominating Team's Nomination Slot is held forever — `awaitingOpeningBid` skips any Player with an Auction row. §10 example 34's "one of the five had Team X as its only Contender: it closes with no winner and that player returns to the pool" cannot happen.

**Approach:** A cancellation stops removing the lottery's clock. Inside a Minimum-Bid Contention the Auction keeps `contention: 'minimum_bid'` and its fixed `closesAt` even when every join is cancelled, so it expires and is swept like any other. `ClosedWinner` gains the second case its own docblock has been reserving since Story 3.4 — `kind: 'undrawn'` — which `drawnWinnerFor` returns for an empty list instead of throwing. `decideClose` records that outcome as a `ContentionDrawn` with an empty list and no winner, then an **`AuctionTerminated`** rather than an `AuctionClosed`: nobody won, so nothing is awarded, the Slot comes back and the Player is in the pool by arithmetic. `auctionsReducer` learns to drop the Auction on that event.

## Boundaries & Constraints

**Always:**
- The recorded Contender list is `auction.contenders` — the post-cancellation fold, unfiltered and unsorted at the point of use. This story writes **no new filter**: `contendersFor` skipping `wasCancelled` is 10.3's and stays the one place a cancelled Contender leaves the draw.
- The seed is **still revealed** on the empty close, and `hash(seed)` is still verified against `seedHash` before anything is published. A published commitment that never opens is the one outcome AD-14 cannot survive, and an empty list does not excuse it.
- `drawIndex` keeps refusing a count below 1. The empty case never reaches it — it is decided one level up, in `drawnWinnerFor`, which returns rather than throws.
- An empty lottery ends with **`AuctionTerminated`**, naming the **nominating** Team and Manager off the nominations fold. No `AuctionClosed`, no winner, no `winningAmount`, no `capHit`, no contract, no placement.
- A cancellation still **resets nothing and removes nothing**. Keeping the lottery's fixed clock is that rule applied where 10.3 broke it; the Standard-contention leaderless branch (clock cleared, `awaiting_opening_bid`) is 10.4's and is **unchanged**.
- The cancelled join stays in `bids` with its marker, visible in history. The record must show the Team entered **and** that its entry was cancelled.
- No cascade runs on an empty close. Nobody won, so no Team's free Slots fell, so `cascadeFor` is not consulted at all.
- Every remaining Contender keeps probability `1/n` over the post-cancellation list, and the recorded seed plus recorded list still reproduce the recorded selection by hand.
- No schema migration — `auction_events.event_type` is generic `text` and `AuctionTerminated` already flows through it.

**Ask First:**
- Any change to `contendersFor`, `drawIndex`, or the `restoration`/leaderless branch `withBidCancelled` takes **outside** a Minimum-Bid Contention.
- Introducing a new event type instead of reusing `AuctionTerminated`, or moving `AuctionTerminatedPayload` out of `rules/phase-end.ts`.

**Never:**
- Do not bump `CORE_VERSION` — 10.1 already bumped it 1 → 2 for this epic.
- Do not invent a winner, a placeholder Team, or a `selectedIndex` for an empty draw, and do not let `readDrawnFacts` fall back to one.
- Do not write notice copy, board strings or strip/index figures — **Story 10.6**. This story adds the nominating Team to the terminate event's mention **targeting** only.
- Do not touch `league-clock.ts`. `AuctionTerminated` has no case there today and gains none.
- Do not make `phase-end.ts` terminate leaderless Standard Auctions. That hole is real, deliberate in 10.4 (the Player stays on the Board, the Slot stays held) and out of scope here.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| One Contender cancelled, others remain (ex. 34) | Lottery with Teams X, P, Q; X's join cancelled by an earlier close in the same sweep | `contenders` is `[P, Q]`; the draw runs over two; the recorded list omits X. X's join still in `bids`, marked cancelled | N/A |
| The cancelled Team held the fold's lead | X opened the lottery and is cancelled; P, Q survive | Artifact lead moves to the earliest surviving join; `contention` stays `minimum_bid`, `closesAt` **untouched**; nobody's price or commitment moves | N/A |
| Every Contender cancelled (ex. 34) | Lottery whose only Contender was X, cancelled by the first close of the sweep | `contenders: []`, `leadingBid: null`, **`contention` stays `minimum_bid`**, `closesAt` **kept**. At expiry: `ContentionDrawn` with empty list, no winner, seed revealed; then `AuctionTerminated` naming the nominator. Player back in the pool, Nomination Slot released | N/A |
| Sequential removal across one sweep (ex. 34) | Three lotteries overdue in one pass, Team X contending in each | X wins the first; its cascade cancels the other two entries in that same transaction; each later `loadCloseState` refolds and sees the shorter list before drawing (AD-11) | Per-Auction failures stay isolated in `runTick` |
| Empty lottery folded twice | The `AuctionTerminated` replayed | `auctionsReducer` drops the Auction; a second fold finds nothing to drop and returns state unchanged | Idempotent, no throw |
| Empty draw read back | A `ContentionDrawn` with `contenders: []` and no `winningTeamId` | `readDrawnFacts` returns a `Draw` recording the empty list, no `selectedIndex` and no winner — a real record, not a rejected row | N/A |
| Malformed empty-draw row | `contenders: []` but a `winningTeamId` present, or a non-empty list with no winner | Rejected as unreadable (`null`), as any self-contradicting payload is | Skip, do not throw |
| A new Bid on an emptied lottery before expiry | Contenders all cancelled, clock still running, a Team bids `MINIMUM_BID` | It joins and becomes a Contender again; the Auction draws normally at expiry. **Audit** `bidding.ts`'s `leadingBid === null && contention === 'minimum_bid'` paths and state the verdict | N/A |
| Lottery with no sealed seed | Empty contenders and `readContentionSeed` answers `null` | Still throws, as `drawnWinnerFor` already does — an empty list is not the missing-seed case | Throw, isolated per Auction |

</frozen-after-approval>

## Code Map

- `src/lib/core/projection/auctions.ts:1083-1112` — `withBidCancelled`. `:1083` `artifactSuccessor`, `:1098` the lead ternary, `:1101-1108` the return where `contention` and `closesAt` are decided. **The one behavioural edit in the fold:** inside `minimum_bid`, a `null` successor must no longer imply `awaiting_opening_bid` or a cleared clock. The docblock at `:1050-1061` states the current rule in prose and must be rewritten, not deleted. The **Standard** branch (`restored`, `:1091`) is 10.4's and is untouched.
- `src/lib/core/projection/auctions.ts:752-777` — `contendersFor`. **Read-only, and the point:** `:769` `if (wasCancelled(bid)) continue;` is already the whole of "a cancelled Contender cannot be drawn". The comment there naming Story 10.3 is correct; do not restate it.
- `src/lib/core/projection/auctions.ts:1163,1342` — `auctionsReducer` and its `AUCTION_CLOSED_EVENT` case, the only removal today. Add an `AUCTION_TERMINATED_EVENT` case beside it, reading the player id through `readTerminatedPlayerId` — without it an emptied lottery survives its own termination and is re-closed every sweep.
- `src/lib/core/projection/auctions.ts:1276-1310` — the `CONTENTION_DISSOLVED_EVENT` case. `:1303` `if (existing.contenders.length === 0) return state;` already refuses to dissolve an empty list. **Read-only evidence** that an empty `contenders` is a state the fold tolerates.
- `src/lib/core/rules/draw.ts:133` `drawIndex` (**read-only** — keeps refusing a count below 1); `:193-263` `drawnWinnerFor`. `:222-228` is the empty-list throw that becomes a returned `undrawn` result. The seed-shape and `hash(seed)` checks at `:200-220` run **before** it and stay before it.
- `src/lib/core/rules/close.ts:78-129` — `ClosedWinner`. Its docblock says outright it is "a discriminated union of one so 3.6 could add a case… it did not need one". **This story adds it**, so that paragraph is now spent and must be rewritten. The `undrawn` case carries `seed` and an empty `contenders` and nothing else.
- `src/lib/core/rules/close.ts:290-388` — `closedWinnerFor`. `:302-311` is the "lottery with no drawn winner" throw and `:371-379` the 10.4 leaderless throw. An `undrawn` winner is a **fourth outcome, not a throw**, and needs a return that is not `ClosedParty` — there is no team, amount or contention to name.
- `src/lib/core/rules/close.ts:466-540` — `AuctionClosedPayload` and `ContentionDrawnPayload`. `:518` `contenders`, `:523-531` `selectedIndex` and `:532-534` the three `winning*` fields widen to admit the empty record. The comment at `:507-511` ("unfiltered, exactly as the draw ran over them") stays true and is the reason nothing here re-sorts.
- `src/lib/core/rules/close.ts:1155-1320` — `decideClose`. `:1185-1193` `cascadeFor` (skipped entirely on an empty close), `:1195-1205` the Standard return, `:1276-1290` the `ContentionDrawn` build, `:1296-1318` the two-event return. The empty case is a third return: drawn-record then `AuctionTerminated`, **no cascade**.
- `src/lib/core/rules/phase-end.ts:123-135` — `AuctionTerminatedPayload`, and `:287-300` the one place it is built today. **Reuse the type**; `close.ts` already imports `AUCTION_CLOSED_EVENT` from `projection/nominations.ts` and `AUCTION_TERMINATED_EVENT` sits beside it there, so no cycle. `expiredAt` becomes the **Auction's own** `closesAt` and `evaluatedAt` the injected `now` — the docblock's "League Clock's own expiry" wording must widen.
- `src/lib/core/projection/nominations.ts:100-121` — `AUCTION_TERMINATED_EVENT` and its docblock, which says "with no Bid ever placed on it". Now also "with no Bid that still stands". `:432-453` the reducer case — **read-only**, it already releases both indexes.
- `src/lib/core/projection/draws.ts:38-63` `Draw`, `:151-224` `readDrawnFacts`, `:236-251` `drawsReducer`. `:171` `if (contenders.length === 0) return null;` and `:161-163` the `winningTeamId` requirement are what reject the empty record today. Widen to a discriminated record; keep `:185-186`'s cross-field check (a winner must be on its own list) for the drawn case.
- `src/lib/server/close.ts:127-200` — `loadCloseState`. `:143-146` derives `drawnWinner`; `:152` `closedWinnerFor`; `:153` `loadTeamRoster(client, winner.teamId, …)`. An `undrawn` outcome has no winning Team, so the roster read and `loadLeagueRosterDetail` must be skipped rather than issued against nothing.
- `src/lib/server/close.ts:291-360` — `affectedTeamsForClose`, and `:390` `projections: [releaseNomination]`. **Read-only evidence:** `src/lib/server/nomination.ts:495-518` `releaseNomination` already handles **both** `AuctionClosed` and `AuctionTerminated` through the core's own readers, so the claim-row delete needs no change. Targeting must name the nominating Team on a terminate event.
- `src/lib/server/sweep.ts:428-457` — `overdue` is computed **once** from one fold, then each `closeOne` commits before the next (AD-11) and re-folds inside its own transaction. **Read-only evidence** that a lottery emptied by close #1 is seen empty by close #2 — and that the fixed overdue list is what still offers the emptied lottery to a close at all.
- `src/lib/core/rules/bidding.ts:774,944,1028,3564` — the `contention === 'minimum_bid'` branches, `:3564` being `leadingBid === null && contentionForAmount(…) === 'minimum_bid'`. **Audit only:** an emptied lottery is a new `(minimum_bid, leadingBid: null)` pairing; confirm a join still evaluates sanely and state the verdict rather than editing blind.
- `src/lib/core/board.ts:400-430` — the contender-list surface, gated on `contention === 'minimum_bid'`. **Read-only** — an empty list renders as an empty list; copy is 10.6's.
- `tests/examples/example-34-unlimited-lotteries.test.ts:373-493` — the cascade half, already green. `:457-481` explicitly defers the draw itself to this story, and the header at `:28-32` names both halves. This is where the story lands.
- `tests/core/phase-end.test.ts`, `tests/examples/example-13-league-clock.test.ts` — existing `AuctionTerminated` coverage; they pin the semantics the empty close is borrowing and must stay green.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/projection/auctions.ts` -- inside a Minimum-Bid Contention, keep `contention` and `closesAt` when the last join is cancelled, and rewrite the docblock clause saying a cleared clock follows from no leader -- a cancellation removes nothing, and clearing a lottery's fixed clock is what stops the empty close from ever happening.
- [x] `src/lib/core/projection/auctions.ts` -- add the `AUCTION_TERMINATED_EVENT` case to `auctionsReducer`, dropping the Auction exactly as the close case does -- otherwise the emptied lottery outlives its own termination and is re-closed every sweep.
- [x] `src/lib/core/rules/close.ts` -- add the `undrawn` case to `ClosedWinner`, carrying the seed and the empty list, and rewrite the "union of one" paragraph -- the shape 3.4 reserved is what keeps the empty outcome from becoming a nullable winner nobody can distinguish from a Standard close.
- [x] `src/lib/core/rules/draw.ts` -- return an `undrawn` result for an empty Contender list instead of throwing, after the seed-shape and commitment checks and never before them -- an empty list is now an ordinary outcome, but a sealed seed that never opens is still the one thing AD-14 cannot survive.
- [x] `src/lib/core/rules/close.ts` -- give `closedWinnerFor` a no-party outcome for an `undrawn` winner, and make `decideClose` emit the empty `ContentionDrawn` then an `AuctionTerminated` built from the nomination, with **no** cascade -- nobody won, so nothing is awarded and no Team's Slots fell.
- [x] `src/lib/core/rules/close.ts` -- widen `ContentionDrawnPayload` so the winner fields and `selectedIndex` are absent on an empty draw -- the record must state the empty list and the reason without inventing a selection.
- [x] `src/lib/core/projection/draws.ts` -- widen `Draw` and `readDrawnFacts` to read the empty record, rejecting the self-contradicting shapes (empty list with a winner, non-empty list with none) -- a verification surface must show the undrawn lottery, not silently drop the row.
- [x] `src/lib/server/close.ts` -- skip the winner-keyed roster reads on an `undrawn` outcome and name the nominating Team in `affectedTeamsForClose` for the terminate event -- there is no winning Team to key a read on, and the Manager whose Slot came back is the one party to the event.
- [x] `src/lib/core/rules/phase-end.ts` -- widen `AuctionTerminatedPayload`'s docblock for its second producer -- `expiredAt` is now the League Clock's expiry **or** the Auction's own, and a reader must not be told it is always the former.
- [x] `tests/core/draw.test.ts`, `tests/core/close.test.ts` -- cover the `undrawn` result, the empty close's exact two-event output and the absence of a cascade, and pin that `drawIndex` still refuses a count below 1 -- the empty path must be proved not to reach the arithmetic.
- [x] `tests/projection-auctions.test.ts`, `tests/core/draws.test.ts` -- pin the emptied lottery keeping `minimum_bid` and its clock, the terminate case dropping the Auction idempotently, and the empty draw record surviving `readDrawnFacts` -- these three are the story's whole seam through the fold.
- [x] `tests/examples/example-34-unlimited-lotteries.test.ts` -- add the draw half: the second lottery drawn from a list without Team X, and the lottery left with zero Contenders closing with no winner and returning the Player to the pool -- the file already defers exactly this.

**Acceptance Criteria:**
- Given a lottery whose Contender list is non-empty after cancellations, when it is drawn, then the recorded list is the post-cancellation one and re-running `drawIndex` over the recorded seed and list reproduces the recorded `selectedIndex`.
- Given a lottery every Contender was cancelled from, when the sweep reaches its expiry, then exactly two events are appended — a `ContentionDrawn` with an empty list, no winner and the revealed seed, then an `AuctionTerminated` — and no `AuctionClosed`, no `BidCancelled` and no contract row.
- Given that termination, when the nominations and auctions folds are read, then the Player holds no board seat, the nominating Team's Nomination Slot is free, and the Auction is absent from `OpenAuctions`.
- Given `grep -rn "AuctionTerminated" src/lib/core/projection/league-clock.ts`, when it runs, then there is no match.
- Given `npm run check`, when it runs, then it is clean.
- Given `npm test`, when the suite runs, then it is green and §10 examples 18–25 and 29–35 all pass.

## Spec Change Log

- 2026-09-09 — Review patches (no intent change; no loopback). Step-04 ran four
  layers over the diff and returned no `intent_gap` and no `bad_spec`. Six patch
  findings were applied, two of them substantive:
  - **AC 1 was vacuously green.** Every post-cancellation draw in example 34
    left a list of exactly one Contender, and `drawIndex(seed, 1)` is `0` for
    every seed, so "reproduces the recorded `selectedIndex`" could not fail.
    The I/O matrix's first row specifies three Teams with one cancelled,
    leaving two. Added a three-Team lottery (`p-lot-trio`) whose shorter list
    is still two long: `drawIndex(SEED, 2)` is `1` where the pre-cancellation
    three-Team list would give `0`, so the assertion now discriminates a wrong
    list rather than restating the arithmetic.
  - **The server layer shipped untested.** `tests/server/close.test.ts` was
    untouched, so nothing drove the `undrawn` branch through `closeAuction`.
    Added a block covering the appended pair, the absence of any roster read,
    the revealed seed and empty record, and the mention addressed to the
    nominating Team alone. Both production lines were reverted in turn to
    confirm the new tests fail without them.
  - Four smaller fixes: `ContractAssignmentOpenedPayload.expiredAt`'s docblock
    was widened by copy-paste to describe a second producer that type does not
    have (it has exactly one, and always will) — reverted and given a note
    saying why it differs from its sibling; the `undrawn`-carrying-Contenders
    guard cited AD-1 in its comment and AD-14 in its throw, reconciled to
    AD-14 to match the sibling draw-integrity guards; the narrowing throw at
    the end of `decideClose` gained its missing `(AD-1)` tag; and a typo and a
    doubled blank line in example 34.
  - **KEEP.** The fold seam is right and must survive any re-derivation: the
    cleared clock narrowed to non-`minimum_bid` only, `contendersFor` and
    `drawIndex` untouched, the seed revealed and hash-verified before the
    empty record is built, and `AuctionTerminated` reused rather than a new
    event type. The `opensContention` audit finding and its fix are load-
    bearing — without them a join into an emptied lottery throws or double-
    writes a sealed seed.
  - **Rejected, deliberately.** `affectedTeamsForClose` returning the
    nominating Team while the envelope records a null actor pair is correct,
    not a divergence: `enqueueMentions` resolves recipients from `managers` by
    `teamId` and never from the event's actor, so "who was affected" and "who
    acted" are separate questions. The stale empty-list comment in
    `adapters/discord/broadcast.ts` is logged as deferred work for Story 10.6,
    which rewrites that renderer.

- 2026-09-09 — Implementation note (no intent change). Two items outside the
  task list, both consequences of the fold change rather than additions to it:
  - `src/lib/core/rules/bidding.ts` `opensContention` gained a
    `state.contention !== 'minimum_bid'` clause. This is the audit the I/O
    matrix asked for, and its verdict was a defect: before this story an
    Auction with no leader was never in a Minimum-Bid Contention, so
    `leadingBid === null && amount === MINIMUM_BID` meant "opening". Keeping
    the lottery's contention through an emptying cancellation created the
    pairing, and a join into the emptied lottery would have demanded a FRESH
    seed the shell correctly does not supply inside a live contention —
    throwing — and, had it not thrown, published a second `seedHash` firing
    `recordContentionSeed` against a primary key that already holds a row.
    Everything else in the matrix row (`joins`, the fixed clock, the
    increment gate standing aside, the pre-fill) was already correct.
  - The task list names `tests/core/draws.test.ts`; the draws fold's tests
    live in `tests/projection-draws.test.ts` and that is where they landed.

## Design Notes

**Why the lottery's clock stops being cleared.** 10.3 wrote one rule for both contention states: no leader means no clock. Outside a lottery that is right — a leaderless Standard Auction has no offer to close on, and the cleared clock is precisely what stops a close at the old expiry with no winner (10.4). Inside a lottery it is wrong, and for the reason 10.4 stated as a general principle without applying it here: **a cancellation resets nothing and removes nothing.** A lottery's `closesAt` is the fixed contention clock, not any bidder's; no Team's departure earns it. And an emptied lottery has a definite outcome that must be *recorded* — the empty list, the revealed seed, the Player to the pool — which a cleared clock makes unreachable.

**Why `AuctionTerminated` rather than a no-winner `AuctionClosed`.** `AuctionClosedPayload` requires `teamId`, `managerId`, `winningAmount` and a `placement`, and the columns behind the first two are `not null` and reference real rows. There is no winner to put there. `AuctionTerminated` already means exactly this — no winner, no contract, Slot back, Player in the pool by arithmetic — and `releaseNomination` already reads both event types. What it gains is a second producer and one fold case.

```
close an overdue Minimum-Bid Contention:
  winner = drawnWinnerFor(auction, seed)      # verifies hash(seed) first, always
  if winner.kind == 'undrawn':                # contenders == []
      append ContentionDrawn{ seed, seedHash, contenders: [], no winner }
      append AuctionTerminated{ nominator, expiredAt: auction.closesAt, evaluatedAt: now }
      # no cascade: nobody won, so no Team's free Slots fell
  else:
      append ContentionDrawn{ …selection… }, AuctionClosed, …cancellations
```

**The first AC is already satisfied and still needs pinning.** `contendersFor` skips `wasCancelled` and is recomputed from `bids` on every fold, so the draw, the committed capital and the page already agree on the post-cancellation list. This story writes no second filter; it writes the tests that prove the one there is.

## Verification

**Commands:**
- `npm test` -- expected: green.
- `npx vitest run tests/examples` -- expected: 18–25 and 29–35 pass; 34 exercises both halves.
- `npm run check` -- expected: no errors.
- `grep -rn "AuctionTerminated" src/lib/core/projection/league-clock.ts` -- expected: **no** match.
- `grep -n "wasCancelled" src/lib/core/projection/auctions.ts` -- expected: unchanged from baseline; this story adds no second cancellation filter.
- `git diff --stat -- supabase/migrations` -- expected: empty.

## Suggested Review Order

**The fold seam — one line, and the whole story turns on it**

- The clock a cancellation must stop removing: leaderless now excludes lotteries.
  [`auctions.ts:1127`](../../src/lib/core/projection/auctions.ts#L1127)

- Where a cancelled Contender leaves the draw — untouched, and deliberately so.
  [`auctions.ts:769`](../../src/lib/core/projection/auctions.ts#L769)

- The emptied lottery must not outlive its own termination.
  [`auctions.ts:1380`](../../src/lib/core/projection/auctions.ts#L1380)

**The outcome that was previously a throw**

- An empty list returns instead of throwing — after the commitment check, never before.
  [`draw.ts:253`](../../src/lib/core/rules/draw.ts#L253)

- The second case the union reserved since Story 3.4.
  [`close.ts:116`](../../src/lib/core/rules/close.ts#L116)

- A fourth outcome, not a fourth throw: no team, no amount, no party.
  [`close.ts:338`](../../src/lib/core/rules/close.ts#L338)

**The empty close**

- Taken before the placement, the Cap Hit and the cascade a winner would be needed for.
  [`close.ts:1394`](../../src/lib/core/rules/close.ts#L1394)

- The seed revealed anyway, then a termination — never an `AuctionClosed`.
  [`close.ts:1189`](../../src/lib/core/rules/close.ts#L1189)

**The record a Manager checks**

- The empty draw is a record, not a rejected row.
  [`draws.ts:188`](../../src/lib/core/projection/draws.ts#L188)

- What `AuctionTerminated` means now it has two producers.
  [`phase-end.ts:97`](../../src/lib/core/rules/phase-end.ts#L97)

**The shell**

- No winning Team, so no winner-keyed roster read to issue.
  [`close.ts:182`](../../src/lib/server/close.ts#L182)

- The Manager whose Slot came back is the one party to this event.
  [`close.ts:359`](../../src/lib/server/close.ts#L359)

**The audit that found a defect**

- A leaderless Auction was never a lottery until this story; joining is not opening.
  [`bidding.ts:3577`](../../src/lib/core/rules/bidding.ts#L3577)

**Tests**

- §10 example 34's own sentence: no winner, Player to the pool.
  [`example-34:690`](../../tests/examples/example-34-unlimited-lotteries.test.ts#L690)

- The reproduction with something to prove — two survivors, not one.
  [`example-34:642`](../../tests/examples/example-34-unlimited-lotteries.test.ts#L642)

- The clock kept, down to the last join cancelled.
  [`projection-auctions:983`](../../tests/projection-auctions.test.ts#L983)

- The whole path through a real transaction and a real outbox.
  [`server/close:904`](../../tests/server/close.test.ts#L904)
