---
title: 'Story 3.4: Close an Auction and place the Player'
type: 'feature'
created: '2026-08-29'
status: 'in-review'
review_loop_iteration: 0
baseline_commit: '7cf0b1e7414373d01cb2e2295ac236b3d22a4857'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing in this codebase appends an `AuctionClosed`. Both folds that consume one ship proven against synthetic events (`projection/auctions.ts:790`, `projection/nominations.ts:260`), `server/nomination.ts:394` says outright that `releaseNomination` is "deliberately not registered" because "no `AuctionClosed` producer exists — Epic 3 owns closing", and `rules/nomination.ts:81-84` still states the falsified premise that no close event exists at all. So an Auction has no terminal state: a won Player stays in the pool, the winning Team's Cap Space and Roster Count never move, and the Manager's next Bid is computed against a roster they no longer have. FR-21's whole consequence list — the contract, the Slot Placement, the released Nomination Slot, the recomputed Minors Exposure — is unbuilt, and AD-23's two distinct fields exist nowhere.

**Approach:** An **Auction Contract is a fold, not a table.** `AuctionClosed` carries the winning amount and the Cap Hit as two persisted fields, and a new `contractsReducer` folds them into what each Team now owns; `team_rosters` stays exactly what its migration says it is — import-owned reference data — and the auction's own output stays event-sourced, which is AD-4's line drawn where AD-4 draws it. That gives Roster Count, Free Minor League Slots and Cap Space one derivation each, shared by the transaction and the read path, with **no migration**. The close itself is a pure rule taking the winner as an argument the way `decide()` takes a seed: 3.6 supplies a drawn Contender, 3.4 supplies the Leading Bidder, and the shell supplies neither judgement.

## Boundaries & Constraints

**Always:** **Slot Placement is a pure function of two facts** — the Player's eligibility and the Team's Minor League occupancy *at this close* — and it involves no choice by anybody. `capHitFor` and the winning amount are computed and persisted **separately**; no expression anywhere derives one from the other by assuming equality (AD-23), and the Minor League branch yields `$0` while the winning amount stands. **Roster Count increments only on an `active_bench` placement**, which falls out of the placement value rather than a second rule. **The outcome reads no clock.** `decideClose` takes `now` for one purpose only — refusing to close an Auction whose persisted `closesAt` has not passed, through the existing `hasExpired` (`projection/auctions.ts:906`) — and every other figure it computes is a function of the folded state alone, so a sweep that runs six hours late produces byte-identical events. The payload's `closedAt` is the Auction's **nominal expiry**, not the transaction clock. **`AuctionClosed`'s acting Manager and Team are the WINNER's**, because `auction_events.manager_id`/`team_id` are `not null` and reference real rows (`20260821020000_auction_events.sql:57-58`) and a close needs no synthetic actor. **A close appends exactly one event** and registers exactly one existing projection — `releaseNomination`, unchanged. **Three facts are asserted, not written**: the League Clock does not reset (`league-clock.ts:123`'s `default: return state`), the Nomination Slot releases (2.3's fold), and Minors Exposure recomputes (the won Auction leaves `auctions.byPlayer`, so `teamMoneyStateFor:595` stops counting it — §10 example 20 already proves this against a synthetic close). `core/` stays pure; `evaluate()` and `PLACE_BID_GATES` are untouched.

**Ask First:** Any migration, or any write to `team_rosters` or `free_agent_players` — the analysis below concludes none is needed, and needing one means something in this reading is wrong. Adding a gate to `PLACE_BID_GATES`. Any change to `runTransactionalWrite`'s pipeline. Any new design token or CSS sizing literal. Rendering a closed Auction anywhere.

**Never:** **No sweep, no cron, no Deno function, no sequential-close loop** (3.5) — `closeAuction` closes ONE Auction and 3.5 is what calls it in AD-11's order. **No draw** (3.6): `decideClose` takes a `ClosedWinner` union, the lottery branch is proven against state literals, and `closeAuction` **throws** on a live Minimum-Bid Contention because no drawer exists yet — the same AD-1 posture 3.3 took on a missing sealed seed. **No surface at all.** A closed Auction leaves both folds, so its page has nothing to render; "winner, price and placement permanently visible" belongs with 3.6's reveal and Epic 4's Your Positions. FR-21's "written to the Audit Log" IS the appended event — AD-4 makes the Audit Log a read of `auction_events`, not a second table. **No notification and no outbox** (Epic 5). **No contract length** beyond recording it unset (Epic 6). **No Bid Board** (Epic 4 — it does not exist). **No void, pause or resume** (Epic 7). No hand-edit of `planning-artifacts/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| §10 ex 16 — minors placement | Team M: 2 Minor League rows, wins an ELIGIBLE Player at `$4,000,000` | Placement `minor_league`, Cap Hit `$0`, winning amount `$4,000,000`. Roster Count **unchanged**; `minorLeagueOccupied` 2→3 | N/A |
| §10 ex 17 — minors overflow | Same Team M, all three minor slots now occupied, wins a second eligible Player at `$3,000,000` | Placement `active_bench`, Cap Hit `$3,000,000`. Roster Count **+1**. Proves the second close sees the first's effect | N/A |
| Not eligible, slots free | Free minor slot exists, Player is not eligible | `active_bench` at the full amount regardless — eligibility is the first test, not occupancy | N/A |
| Occupancy above three | Commissioner override left 4 minor rows, eligible Player | `active_bench`. `max(0, 3 − occupied)` clamps, `minorsCountsFor:1052`'s rule | N/A |
| Standard close | Leading Bidder T at `$8,500,000` | Winner T at `$8,500,000`. Event's `managerId`/`teamId` are the winning Bid's | N/A |
| Lottery close, winner supplied | `contention: 'minimum_bid'`, `ClosedWinner` names Contender F | F wins at exactly `$1,000,000` — the flat amount, never `leadingBid.amount` | N/A |
| Lottery close, no winner supplied | `minimum_bid`, winner argument `null` | **Throws** `TypeError` naming 3.6. No event reaches the log | throws |
| Standard close, winner supplied | `standard`, a `ClosedWinner` handed in anyway | **Throws.** A drawn winner on a Standard close is a shell bug, not a silent override | throws |
| Not yet expired | `hasExpired(closesAt, now)` is `false` | **Throws.** Closing a live Auction is the caller's bug (AD-1), and the guard is the same derivation `expiry` refuses Bids with | throws |
| Late close | `now` is six hours past `closesAt` | Byte-identical events to an on-time close. `closedAt` states the nominal expiry; the event's `occurredAt` states when it was recorded | N/A |
| No Auction to close | Player nominated, nobody bid, or no nomination at all | **Throws.** There is no winner and no price; a terminated unbid nomination is 3.7's, not a close | throws |
| Double close | `AuctionClosed` folded twice for one Player | Second fold is a no-op: the contract keeps the FIRST close seen, and both other reducers already converge (AD-5) | N/A |
| Won Player is nominated again | Closed Player named on the nomination page or submitted | Refused `under_contract`, naming the winning Team — the contracts fold answers alongside `team_rosters` | `fail(409)` |
| Winner bids again elsewhere | Team's next Bid after a close | Cap Space is down by the Cap Hit, Roster Count and minor occupancy reflect the placement, and the won Auction contributes no exposure | N/A |
| Malformed close payload | Missing winner, unparseable amount, or no Player | Contract fold **skips** it — `readPayload`'s idiom. Nothing throws; the other two reducers already skip it too | N/A |

</frozen-after-approval>

## Code Map

Two new core files, one new server file, no migration, no surface.

- `src/lib/core/projection/contracts.ts` -- **NEW, and the story's centre.** `AUCTION_CLOSED_EVENT` is imported from `projection/nominations.ts:73` — not re-declared, because three reducers must agree on one literal. Declares `SlotPlacement = 'active_bench' | 'minor_league'` (a narrowing of `RosterSlotKind`, `types.ts:130` — a close can never produce `injury_reserve`), `AuctionContract` (player, team id+name, `winningAmount`, `capHit`, `placement`, `contractYears: null`, `closedAt`), `AuctionContracts { byPlayer }`, `INITIAL_CONTRACTS`, `contractsReducer`, `contractForPlayer`, and `contractRowsFor(contracts, teamId): readonly CapHitRow[]`. Mirror `auctions.ts` exactly: `hasOwn` (`:252`), a defensive `readPayload` (`:552`) that skips a malformed row, first-close-wins for replay convergence (`:735`). `contractRowsFor` returns `roster-import.ts`'s existing `CapHitRow` shape so `computeCapSpace` (`roster-import.ts:60`) needs no change and the $0-for-minors rule stays written once.
- `src/lib/core/rules/close.ts` -- **NEW.** `CloseState` (the folded `Auction`, the Player's eligibility, the winning Team's `minorLeagueOccupied`, the nomination that names the Player); `ClosedWinner` union (`{ kind: 'drawn'; teamId; teamName; managerId; seed; contenders }`) declared for 3.6 and `null` here; `AuctionClosedPayload`; `slotPlacementFor(isEligible, minorLeagueOccupied)`; `capHitFor(placement, winningAmount)`; `decideClose(state, now, winner): Accepted<readonly EventEnvelope[]>`. Follow `bidding.ts`'s `seedFor` (`:2773`) for the throw idiom — a message naming what was required and what arrived. Reuses `hasExpired` and `MINOR_LEAGUE_SLOTS` (`constants.ts:71`); reads no clock and no randomness. **Separate from `bidding.ts`** (3012 lines) because a close is a different command with an empty gate set: it cannot be refused by a rule, only by a bug.
- `src/lib/core/types.ts` -- read-only if possible. `PLACE_BID_GATES` (`:577`) is untouched and no close gate set is added: a close has no gates. If `SlotPlacement` proves to want a home beside `RosterSlotKind` (`:130`), that is the one permitted edit — say so.
- `src/lib/core/rules/nomination.ts` -- correct `:81-84`, which states "No close event exists yet — `AuctionClosed` is Story 2.3's" and concludes there is no already-won refusal. `refuseNomination` (`:193`) and `NominationRefusal` (`:86`) need **no** change: `under_contract` (`:208`) is that refusal, and it now has a second source. Closes the open `deferred-work.md` entry that logged this.
- `src/lib/server/team-roster.ts` -- extend. `loadTeamRoster` (`:92`) gains a third parameter (the folded `AuctionContracts`) and concatenates `contractRowsFor(...)` into the SAME `rows` array before the ONE existing loop, so `capSpace`, `rosterCount` and `minorLeagueOccupied` all pick the contracts up with no second counter. Correct the header, which currently says these figures come from `team_rosters` alone.
- `src/lib/server/close.ts` -- **NEW.** `closeAuction(gateway, fantraxPlayerId)`: `runTransactionalWrite` with `load` folding nominations, auctions, eligibility and contracts over ONE `loadEventsViaClient` read (`server/bidding.ts:209-213`'s discipline) plus `loadTeamRoster` for the winning Team, `decide` calling `decideClose`, and `projections: [releaseNomination]` — the one-line registration `server/nomination.ts:394` was written for. The winning Team is known only after the winner is derived, so the roster read follows the fold. **No `deviceClass`**: a close is not a user action.
- `src/lib/server/bidding.ts` -- extend. `loadBidState` (`:209`) folds contracts as a fourth projection and passes them to `loadTeamRoster` (`:219`). Nothing else moves: `teamMoneyStateFor`'s inputs are already the three figures.
- `src/lib/server/auction-page.ts` -- extend. Same fold beside `:457-474`, same pass at `:507`'s `...(await loadTeamRoster(client, viewerTeamId))`. No new serialised field and no `AuctionPageState` change.
- `src/lib/server/nomination.ts` -- extend. `loadNominationState` (`:122`, whose contract read is `:149`) and `loadNominatablePool` (`:217`) fold contracts and resolve `contractHolderTeamName` as the `team_rosters` join's answer **or** the contract's own `teamName`, which the payload carries. The pool query at `:232-239` is otherwise unchanged.
- `tests/examples/example-16-minors-placement.test.ts`, `tests/examples/example-17-minors-overflow.test.ts` -- **new**, registered in `tests/structure.test.ts`'s `SECTION_10_EXAMPLES` (`:55-91`) with the story note (`:29-54`) extended. Follow `example-20`'s idiom, which already drives a synthetic `AuctionClosed`: PRD text verbatim, state literals, direct core calls, no database and no clock mocking. **17 must run against the state 16 produced**, which is AD-11's arithmetic in one file.
- `tests/projection-contracts.test.ts` -- **new.** The fold: placement and both money fields recorded, first close wins, a malformed payload skipped, an event naming no Player skipped, `contractRowsFor` producing `$0` minor rows.
- `tests/core/close.test.ts` -- **new.** The placement table, the four throws, the winner/amount by contention, and that `decideClose` output is invariant under `now`.
- `tests/server/close.test.ts` -- **new.** One event appended; the actor is the winner; `releaseNomination` firing in the same transaction; a lottery throwing.
- `tests/server/team-roster.test.ts`, `tests/server/bidding.test.ts`, `tests/server/auction-page.test.ts`, `tests/core/nomination.test.ts`, `tests/server/nomination.test.ts` -- extend: the three figures including contracts, a post-close Bid judged against them, and a won Player refused `under_contract`.
- `tests/core/auction-open.test.ts` -- the League Clock fold's own file: that `AuctionClosed` does not reset it (§10 example 13's first half).
- `supabase/migrations/`, `src/lib/shell/write.ts`, `src/lib/core/rules/bidding.ts`, `src/routes/**` -- **read-only.** Any edit here is a finding: say which and why.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/projection/contracts.ts` -- the event fold, `AuctionContract`, `contractRowsFor` -- AC2, AC4, AC6
- [x] `src/lib/core/rules/close.ts` -- `slotPlacementFor`, `capHitFor`, `ClosedWinner`, `decideClose` and its four throws -- AC1, AC2, AC3
- [x] `src/lib/server/team-roster.ts` -- contracts folded into the one loop; header corrected -- AC4
- [x] `src/lib/server/close.ts` -- the one-Auction transaction; `releaseNomination` registered -- AC3, AC5
- [x] `src/lib/server/bidding.ts`, `src/lib/server/auction-page.ts` -- fold contracts, pass to `loadTeamRoster` -- AC4
- [x] `src/lib/server/nomination.ts`, `src/lib/core/rules/nomination.ts` -- contract holder from either source; the stale comment corrected -- AC5
- [x] `tests/examples/example-16-*.test.ts`, `example-17-*.test.ts` + `tests/structure.test.ts` -- §10 examples 16 and 17, registered, 17 against 16's outcome -- AC2
- [x] `tests/core/close.test.ts`, `tests/projection-contracts.test.ts` -- the placement table, the throws, the fold -- AC1-AC3, AC6
- [x] `tests/server/close.test.ts`, `tests/server/team-roster.test.ts`, `tests/server/bidding.test.ts`, `tests/server/auction-page.test.ts` -- the transaction and the post-close figures -- AC3, AC4
- [x] `tests/core/nomination.test.ts`, `tests/server/nomination.test.ts`, `tests/core/auction-open.test.ts` -- the won Player refused, the League Clock unmoved -- AC5
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- mark the `rules/nomination.ts:81-84` stale-premise entry resolved -- AC7

**Acceptance Criteria:**
- Given an Auction reaching its close, when the winner is determined, then Standard Contention awards the Leading Bidder at their own amount and a Minimum-Bid Contention awards the supplied drawn Contender at exactly `$1,000,000`, and a close with the wrong winner argument for its contention state throws rather than guessing.
- Given Slot Placement, when it is applied, then a Minor League Eligible Player takes a free Minor League Slot if one exists and Active/Bench otherwise, every other Player takes Active/Bench, the Cap Hit is `$0` on a Minor League placement and the winning amount on an Active/Bench one, the winning amount is persisted unchanged either way, and §10 examples 16 and 17 both pass with 17 evaluated against 16's committed effect.
- Given a close, when it is recorded, then exactly one `AuctionClosed` is appended carrying winner, winning amount, Cap Hit, placement, contention and the nominal close instant; contract length is recorded unset; the acting Manager and Team are the winner's; and `releaseNomination` deletes the claim row in the same transaction.
- Given a Team that has won a Player, when its next Bid is evaluated, then Cap Space, Roster Count and Minor League occupancy all include that contract through one derivation shared by the transaction and the read path, Roster Count moved only for an Active/Bench placement, and the won Auction contributes no Minors Exposure.
- Given a closed Auction, when anything downstream is folded, then the nominating Team's Nomination Slot is free, the Player is refused for nomination as `under_contract` naming the winning Team, and the League Clock is not reset.
- Given the same log folded twice, when the contracts projection is rebuilt, then it converges on one contract per Player with the first close winning, and a malformed close is skipped rather than thrown over.
- Given the repository, when `npm test`, `npm run check` and `npm run check:purity` run, then all pass with no growth in the pre-existing `SUPABASE_DB_URL` integration failure, `supabase/migrations/` is unchanged, and `core/` still reads no clock and no randomness.

## Spec Change Log

## Design Notes

**An Auction Contract is a fold, and that is a conclusion rather than a shortcut.** `team_rosters`' own migration states it is written by exactly one path, `promoteImport`, and that "nothing rebuilds these from the log" — it is the world, and AD-4 says the world is not event-sourced. An Auction Contract is the auction's output, so it is. Folding it costs no migration, converges under replay by construction (which is the stronger form of AD-5's "replaying `AuctionClosed` must converge on the same contract rows rather than duplicating them"), and keeps AD-7 honest: Cap Space after a close is derived on every evaluation from imported rows plus folded contracts, never stored. `open_nominations` is a table because it needs a **uniqueness constraint** for a real race between two Managers; a close has no such race — it is one writer under the global lock — so a table would only have to be undone.

**`contractRowsFor` returns `CapHitRow`, and that is the whole integration.** `loadTeamRoster` already loops rows counting `active_bench` and `minor_league` and already hands the same rows to `computeCapSpace`, which already treats a Minor League row's cap hit as `$0`. Appending the contract rows to that array makes all three figures pick contracts up with no second counter and no second definition of any of them. If a later reading finds itself adding a `+ wonCount` anywhere, that is the wrong shape.

**Time is a guard, never an input.** `decideClose(state, now, winner)` reads `now` in exactly one expression — `hasExpired(state.auction.closesAt, now)` — and nothing it emits varies with it. That is what makes AD-10's "a late sweep must produce exactly the outcome an on-time sweep would have" structural rather than tested for, and it is why the payload's `closedAt` is the Auction's own persisted expiry while the event's `occurredAt` remains the transaction clock: the log states both when the Auction was due to close and when the system got round to it, and only the first is an input to anything.

**The lottery branch is built and unreachable, deliberately.** `ClosedWinner` exists now so 3.6 adds a drawer rather than a signature change, and so §10 examples 8 and 11 have a shape to land against. `closeAuction` throws on a live contention because the alternative — closing it as if the opener had won — is exactly the silently-wrong outcome AD-14 exists to prevent. Nothing calls `closeAuction` in production until 3.5 lands, so the throw is unreachable rather than merely unhandled.

```
AuctionClosed payload (§10 ex 16)
  fantraxPlayerId  'p-stash'      contention     'standard'
  teamId/teamName  Team M         winningAmount  4_000_000
  managerId        winning Bid's  capHit         0
  placement        'minor_league' contractYears  null
  closedAt         the Auction's own persisted closesAt
```

## Verification

**Commands:**
- `npm test` -- all pass. Baseline on `7cf0b1e` must be measured first and must not grow; the one expected failure is the pre-existing `SUPABASE_DB_URL is not set` integration case (`deferred-work.md`).
- `npm run check` -- 0 errors, 0 warnings.
- `npm run check:purity` -- clean.

**Manual checks (if no CLI):**
- `git status --short supabase/` and `git diff --stat supabase/migrations/` are both empty.
- No SQL statement of any kind appears in `src/lib/core/`, and `src/lib/server/close.ts` issues none of its own — the close writes no reference table. (An earlier form of this check grepped `core/` for the table NAMES; four core files named them in prose at `7cf0b1e`, so the name grep was never the right test.)
- `rg -n "capHit|winningAmount" src/lib/core/` shows no expression assigning one from the other (AD-23).
- `rg -c "AUCTION_CLOSED_EVENT = " src/lib/core/` is `1` — the literal is declared in `projection/nominations.ts` and imported everywhere else.
- `git diff --stat src/routes/ src/lib/components/ src/lib/shell/ src/lib/core/rules/bidding.ts` is empty. Anything more is a finding: say which and why.

## Review Findings
