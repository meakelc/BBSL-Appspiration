---
title: 'Story 7.13: Reverse an Auction Close'
type: 'feature'
created: '2026-09-23'
status: 'done'
baseline_commit: '106175b8af5d4ce041ffc35166737043ed9839c7'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** BKN won an Auction it had room for only because Ja Morant sat in Injury Reserve against the league's free-agency rule, and nothing in the product can take a closed Auction's Player back (FR-32, AD-33, §10 example 58).

**Approach:** A Commissioner override that appends one compensating `AuctionCloseReversed` event naming the reversed close by `seq`. It is decided by a new pure `decideCloseReversal` and folded by `contractsReducer` (which removes the Contract and remembers the reversed close) and `nominationsReducer` (which re-holds a released Slot). It is reached from the won Contract's row on the Team page, confirmed on the reason sheet, broadcast to Discord and rendered in the Audit Log.

## Boundaries & Constraints

**Always:**
- The reversal undoes exactly one thing (AD-33): the Contract leaves the winning Team and the Player returns to the pool. FR-40 cancellations and their restorations stand, no League Clock reset is removed or recomputed, and the Auction is not reopened.
- AD-4: nothing in `auction_events` is updated or deleted. AD-5: a close whose `seq` is in the reversed set yields no Contract whatever order or multiplicity it is folded in, and a later genuine close of the same Player yields a fresh one.
- Slot re-hold: only when the close's payload says `releasedNominationSlot: true` **and** `nominationForTeam(nominations, teamId) === null` now. The `nomination_slots` claim row is re-inserted in the same transaction. The re-held nomination is **carried on the payload**, so the fold replays what the record says (AD-32).
- Refusals are values from the core (AD-1): `phase` (not Auction or Contract Assignment), `no_such_close`, `already_reversed`, `traded` (act, date, current holder) and `dropped` (act, date). A within-Team Move does **not** block: the Contract is removed from whatever `placement` it holds now.
- Reason is mandatory and validated server-side (`requireOverrideReason`). Every guard runs on `load` and on the action. Commissioner only.
- Money figures come from existing expressions only: `figuresFor`, `teamSolvencyFiguresFor` (as `managerMaximumBidFor` calls it) and `chargedCapHit`. No new affordability arithmetic.
- `core/**` stays pure, with `.ts` imports and no `$lib`. Cite AD-33, AD-32, AD-4 and AD-5 in comments the way existing code does.

**Ask First:**
- Any migration. None is expected: `event_type` is text, and `nomination_slots` already exists.
- Changing `readClosedFacts`, `decideClose`, the `AuctionClosed` payload, or any `BidCancelled` semantics.
- Adding a new `NotificationCategory` (the plan reuses `led_at_close`) or an Available Cap Space row to any sheet other than this one.

**Never:**
- Deleting or editing any event, or removing the `BidCancelled` events the close caused.
- Touching the League Clock, `restore.ts`'s selector, or reopening the Auction.
- Adding a Roster Move control to the roster row, adding a closed-Auction page, building Story 7.4's pause, or automating the IR free-agency rule.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| §10 ex 58 | Team R: 11 A/B + 1 IR; won X $4M into A/B (Count 12); close cancelled R's lead on Y and restored S | Count 11; Cap Space +$4M; X nominatable; S still leads Y; League Clock expiry unchanged; the IR→A/B Move then passes (12). Done before the reversal, the Move is refused (13) | N/A |
| Slot re-held | close had `releasedNominationSlot: true`; R holds no Slot now | payload `slotReheld: true` + `reheldNomination`; claim row inserted; `nominationForTeam(R)` is that nomination | N/A |
| Slot not re-held | R has nominated since | that Nomination stands; `slotReheld: false`; sheet says so in words | N/A |
| Moved within Team | Contract Moved to IR since close | reversal removes it from IR; IR occupancy −1, Count unchanged | N/A |
| Traded | Contract now held by Team T | refused: `traded`, trade date, T | nothing written |
| Dropped | a `DropRecorded` names X after the close (unreachable today — Drop refuses won rows) | refused: `dropped`, date | nothing written |
| Twice | close already reversed | refused: `already_reversed` | nothing written |
| Archived | phase Archived | 403 from `requireOverridablePhase` and core `phase` refusal | nothing written |
| Replay | full log re-folded, close event duplicated | no Contract for X unless a later, un-reversed close exists | N/A |
| Re-won | X re-nominated and won after reversal | fresh Contract with the new `closeSeq`; board shows it as Closed, not Reversed | N/A |
| Contract Assignment | reversal in that phase | permitted; sheet warns the Team falls below twelve and cannot export, and X cannot be re-nominated there | N/A |

</frozen-after-approval>

## Code Map

**Core fold (`src/lib/core/projection/contracts.ts`):**
- `AuctionContract` (`:171`) gains `closeSeq: string`, set from `event.seq` in `readPayload` (`:341`).
- `AuctionContracts` (`:203`) gains `reversed: Readonly<Record<string /*closeSeq*/, ReversedClose>>`. `ReversedClose` holds the contract as it stood, plus `reversalSeq`, `reversedAt` and `reason`. Update `INITIAL_CONTRACTS` (`:209`) and every `{ byPlayer }` literal inside the reducer (`:917–1047`) so it carries `reversed` through.
- Declare `AUCTION_CLOSE_REVERSED_EVENT = 'AuctionCloseReversed'` and `AuctionCloseReversedPayload` here, as `ROSTER_TRADE_RECORDED_EVENT` is declared beside its reducer. Name the payload's figure blocks `teamBefore`/`teamAfter`, never `before`/`after`: `audit-log.ts`'s `mergeOverride` collides with those (spec-7-11 Change Log).
- In the `AUCTION_CLOSED_EVENT` case (`:919`), skip if `event.seq` is in `reversed`. The new case adds the reversed entry and deletes `byPlayer[X]` **only when its `closeSeq` matches**. Rewrite the "first close wins" docblocks (`:36`, `:93`, `:909`) per AD-33.

**Nominations (`src/lib/core/projection/nominations.ts:588`):** add a case. If `slotReheld` is true, `reheldNomination` is present and `byTeam[teamId]` is absent, set `byTeam[teamId]` to it, rebuilt as `OpenNomination` with `holdsSlot: true`. `byPlayer` is untouched.

**Closed read (`src/lib/core/projection/closed.ts`):** `ClosedAuction` (`:65`) gains `reversal: ReversedClose | null`. `closedAuctionFor` and `closedAuctions` (`:101`, `:150`) return the live contract, or else the **latest** reversed close for a Player with no live contract, so there is one closed card per Player and the Svelte `#each` key (`board/+page.svelte:692`) stays unique. Add `REVERSED_LABEL = 'Reversed'`.
- `auctions.ts:470` `auctionAtClose` takes the `closeSeq` to cut at instead of the first close. Its one caller is `server/auction-page.ts:800`.

**New pure rule (`src/lib/core/rules/close-reversal.ts`):**
- `closeReversalFactsFor(events, closeSeq)` is a pure scan returning:
  - the close's payload and its `teamId`;
  - whether a later `AuctionCloseReversed` names it;
  - the later `RosterMoveRecorded` transfers and `DropRecorded` releases naming X, with dates;
  - the `BidCancelled` events it caused: `causeFantraxPlayerId === X`, with `seq` after the close and before X's next close;
  - the nomination that held the Slot, found as `nominationForTeam(fold(INITIAL_NOMINATIONS, events < closeSeq, nominationsReducer), teamId)`, the pattern `auctionAtClose` uses.
- `decideCloseReversal(state)` returns Accepted (payload) or Rejected (refusal).
- Also add `closeReversalRefusalDetail`, `closeReversalAttention` and `closeReversalActSentence` ("Reverse this Close — …"). Model them on `rules/roster-drop.ts:270` `evaluateDrop`, `:438` and `:545`.
- Figures: `figuresFor` (`roster-act.ts:152`) over the rows with and without the Contract. Get Available Cap Space and Maximum Bid by calling `teamSolvencyFiguresFor` (`bidding.ts:1859–1919`) before and after, exactly as `managerMaximumBidFor` (`roster-rearrange.ts:290`) does. `BidCancelledPayload` is at `rules/close.ts:712`.

**Shell (`src/lib/server/close-reversal.ts`):** mirror `server/roster-drop.ts`: `loadRosterDropState` `:184`, `previewRosterDrop` `:247` and `recordDrop` `:298–368` through `runTransactionalWrite` (`shell/write.ts:235`).
- The projection re-inserts the claim row: `insert into nomination_slots (team_id, fantrax_player_id, seq, occurred_at)`, with the re-held nomination's own `seq` and instant. Schema: `20260914000000_…sql:41–93`; delete seam: `server/nomination.ts:614–636`.
- `enqueue: enqueueBroadcastsAndMentions(…)` (`server/outbox.ts:421`), with affected Teams equal to the payload's `teamId` (`close.ts:335` pattern).

**Surface:**
- `src/lib/server/destinations.ts:155,185`: add `destination('close-reversal','Reverse a Close','/close-reversal', true, false)` to both the Auction and Contract Assignment lists. `listed=false`, but it must be registered or `requireLiveDestination` refuses.
- New route `src/routes/close-reversal/+page.server.ts` and `+page.svelte`, modelled on `routes/roster-drop/` (Commissioner-only guard at `:56–63`, action at `:226`). Query `?close=<seq>`.
- `src/lib/reason-sheet-view.ts`: add `closeReversalReasonRows`. `teamFigureRows` (`:318`) has no Available Cap Space, Maximum Bid or Nomination Slot row, so build them here. Per-act wording goes in `act` (Georgia, `ReasonSheet.svelte:137`). The shared title stays.
- Team page: `core/team-view.ts:377,607` carries `closeSeq` on won rows. `routes/teams/[teamId]/+page.server.ts:50` passes `isCommissioner`. `+page.svelte:346–353` renders a dashed `commissioner-block` link on won rows only. **No Roster Move control exists on the row today**, so this is the first Commissioner control there.
- Board: `core/board.ts:846` closed cards gain `reversed: boolean`. The label reads `REVERSED_LABEL`, the won glyph is suppressed, and `board/+page.svelte:690–797` renders it.
- Audit: `core/audit-log.ts:1102` `RENDERERS` gains `renderCloseReversal`, labelled `'Close Reversal'`. It harvests `teams`/`players` from the payload (see `renderRosterTrade` `:764`). `AuditReferences` (`:288`) gains `reversedCloses: ReadonlyMap<closeSeq, reversalSeq>`, built by the audit loader. `renderAuditEvent` (`:1408`) appends an Outcome · Reversed row to a reversed `AuctionClosed`. Update `NO_REFERENCES`.
- Discord: add the type to `adapters/discord/broadcast.ts:54` `BROADCAST_EVENT_TYPES` and a `composed()` case (`:332`), naming the actor and reason. `mention.ts:241` `categoryFor` maps it to `led_at_close` for the payload's `teamId`, with a new clause (`:80–113`). Extend `withoutMistargeted` (`:332`) to the new type. `tests/adapters/discord-broadcast.test.ts:88` pins the list.

**Read-only evidence:** `rules/nomination.ts:273` `under_contract` reads the contract fold, so X becomes nominatable by removal alone. `rules/roster-drop.ts:316` refuses won rows, which is why `dropped` is unreachable today.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/projection/contracts.ts` -- `closeSeq`, the `reversed` map, the event and payload, the reducer case, the seq-skip on close, docblocks -- AD-33 convergence
- [x] `src/lib/core/projection/nominations.ts` -- the re-hold case -- Slot re-held from the record
- [x] `src/lib/core/projection/closed.ts`, `auctions.ts`, `server/auction-page.ts` -- reversed closed read, `auctionAtClose` by `closeSeq` -- "Reversed" wherever shown
- [x] `src/lib/core/rules/close-reversal.ts` -- facts scan, `decideCloseReversal`, wording -- the pure decision
- [x] `src/lib/server/close-reversal.ts` -- load, preview, `recordCloseReversal` with claim-row projection and enqueue -- the write path
- [x] `src/lib/server/destinations.ts`, `src/routes/close-reversal/*`, `src/lib/reason-sheet-view.ts` -- route, guards, sheet rows and notes -- the act
- [x] `src/lib/core/team-view.ts`, `server/team-view.ts`, `routes/teams/[teamId]/*` -- Commissioner control on won rows -- placement AC
- [x] `src/lib/core/board.ts`, `routes/board/+page.svelte` -- Reversed card -- visibility
- [x] `src/lib/core/audit-log.ts` (+ its server loader) -- `Close Reversal` renderer, reversed-close marking -- FR-33
- [x] `src/lib/adapters/discord/broadcast.ts`, `mention.ts` -- broadcast and mention -- Discord AC
- [x] `tests/examples/example-58-a-close-reversed-and-what-it-leaves-alone.test.ts` and `tests/structure.test.ts:88` -- §10 example 58, registered
- [x] `tests/**` -- one test per matrix row. Add fold replay/duplicate/re-won tests; a server fake-gateway test (`tests/server/roster-drop.test.ts:60` pattern) proving one event, one claim-row insert, and a rollback on refusal; a reasonless-POST refusal; and audit, board, broadcast and mention tests

**Acceptance Criteria:**
- Given the finished story, when `npm test`, `npm run check` and `npm run build` run, then all pass, including `scripts/check-core-purity.js`.
- Given `git status -- supabase/`, then it is clean.
- Given a reversal, when the transaction is inspected, then exactly one `AuctionCloseReversed` was appended, and nothing was updated or deleted in `auction_events`.
- Given the reason sheet, when it renders, then it shows before → after for Cap Space, Available Cap Space, Maximum Bid, Roster Count and Nomination Slot, and lists each standing cancellation as not undone. Its `attention` notes cover: the Player returns to the pool; nothing else is undone; where the Team holds an IR Contract, the Roster Move comes after the reversal; and, in Contract Assignment, the Team falls below twelve and cannot export.
- Given a non-Commissioner, when they request `/close-reversal` or POST to it, then both are refused whatever rendered.

## Design Notes

**Why the reversed set is a map, not a set.** The Board, the Auction page and the Audit Log must read **Reversed**, and all three compose off `contractsReducer`. Deleting the Contract alone would make the Auction vanish, which is the "close that did not happen" the PRD forbids. Keying on `closeSeq` rather than the Player keeps a later genuine close of the same Player separate.

**Why the re-held nomination rides on the payload.** Once a close has released the Slot, the fold no longer knows which nomination held it. The shell recovers it by folding the prefix before the close, and records it, so replay reads the record and never re-derives it (AD-32).

**Deploy (AD-20).** This story touches `core/` while the Auction Phase is live, and no pause exists yet (7.4 is backlog). Deploy in a quiet window with the §10 suite green and a recorded reason that states no pause was available.

## Verification

**Commands:**
- `npm test` -- expected: green, including example 58 and the structure test
- `npm run check` -- expected: 0 errors
- `npm run build` -- expected: success
- `node scripts/check-core-purity.js` -- expected: clean over `close-reversal.ts`

## Suggested Review Order

**The decision**

- Entry point: the pure decision, refusals as values, figures before and after.
  [`close-reversal.ts:442`](../../src/lib/core/rules/close-reversal.ts#L442)

- One scan of the log: the close, later reversals, trades and drops, cancellations, and the Slot nomination.
  [`close-reversal.ts:223`](../../src/lib/core/rules/close-reversal.ts#L223)

- Attention wording, which only makes claims the figures support (review patches 1–3).
  [`close-reversal.ts:612`](../../src/lib/core/rules/close-reversal.ts#L612)

**Fold convergence (AD-33, AD-5)**

- A close in the reversed map yields no Contract, however often it is folded.
  [`contracts.ts:1186`](../../src/lib/core/projection/contracts.ts#L1186)

- Reversal removes the live Contract only when its `closeSeq` matches.
  [`contracts.ts:1204`](../../src/lib/core/projection/contracts.ts#L1204)

- The reversed record keeps the contract plus actor and reason, so surfaces can read "Reversed".
  [`contracts.ts:236`](../../src/lib/core/projection/contracts.ts#L236)

- Slot re-hold replays the payload's nomination, never re-derives it (AD-32).
  [`nominations.ts:678`](../../src/lib/core/projection/nominations.ts#L678)

**The write path**

- One event, claim-row projection, broadcast and mention enqueue, under the global lock.
  [`close-reversal.ts:166`](../../src/lib/server/close-reversal.ts#L166)

- Claim-row re-insert kept in the one module that owns `nomination_slots`.
  [`nomination.ts:682`](../../src/lib/server/nomination.ts#L682)

- Guards on load and on the action, Commissioner only.
  [`+page.server.ts:47`](../../src/routes/close-reversal/+page.server.ts#L47)

- Reason is validated on the server before any transaction opens.
  [`+page.server.ts:128`](../../src/routes/close-reversal/+page.server.ts#L128)

**Where it shows**

- Latest reversal stands in when no live Contract exists, so there is one card per Player.
  [`closed.ts:117`](../../src/lib/core/projection/closed.ts#L117)

- Bid history cuts at the named close, not the first close.
  [`auctions.ts:471`](../../src/lib/core/projection/auctions.ts#L471)

- Board card names the Commissioner and the reason.
  [`board.ts:474`](../../src/lib/core/board.ts#L474)

- New Close Reversal entry in the Audit Log.
  [`audit-log.ts:1137`](../../src/lib/core/audit-log.ts#L1137)

- Discord broadcast with actor and reason.
  [`broadcast.ts:404`](../../src/lib/adapters/discord/broadcast.ts#L404)

- Mention to the winning Team's Managers, reusing the `led_at_close` category.
  [`mention.ts:157`](../../src/lib/adapters/discord/mention.ts#L157)

- The five-figure reason-sheet rows, including Available Cap Space and Nomination Slot.
  [`reason-sheet-view.ts:580`](../../src/lib/reason-sheet-view.ts#L580)

- Commissioner-only link on won rows.
  [`+page.svelte:365`](../../src/routes/teams/[teamId]/+page.svelte#L365)

- Registered but unlisted destination, in the Auction and Contract Assignment phases.
  [`destinations.ts:165`](../../src/lib/server/destinations.ts#L165)

**Tests**

- §10 example 58, the executable specification.
  [`example-58-….test.ts:93`](../../tests/examples/example-58-a-close-reversed-and-what-it-leaves-alone.test.ts#L93)

- Replay, duplicate and re-won convergence.
  [`close-reversal.test.ts:303`](../../tests/core/close-reversal.test.ts#L303)

- Fake-gateway transaction: one event, one claim row, rollback on refusal.
  [`close-reversal.test.ts:169`](../../tests/server/close-reversal.test.ts#L169)
