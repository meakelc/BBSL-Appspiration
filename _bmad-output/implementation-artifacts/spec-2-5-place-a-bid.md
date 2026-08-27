---
title: 'Story 2.5: Place a Bid — increment, granularity, and the 24-hour clock'
type: 'feature'
created: '2026-08-26'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'f6f382a7b367ab0b913b7df3f57cc4d4b0edfc96'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Auction page says "No bids yet" because nothing can place one. `core/rules/bidding` does not exist, there is no `BidPlaced` event, and `core/types.ts:7-20` still states outright that `GateResults`, `Accepted`/`Rejected` and every domain command are Epic 2's to add. Every remaining story in Epics 2 and 3 hangs off that contract.

**Approach:** Establish the two core entry points for `PlaceBid` — a total `evaluate()` returning a fixed gate set, and a `decide()` that reaches its outcome only by calling it — implement the gates this story owns, fold the resulting `BidPlaced` into an Auction projection carrying the leading Bid and an absolute close instant, and complete the bid control, price, Leading Bidder and history that Story 2.4 deferred here.

## Boundaries & Constraints

**Always:** Two entry points and no others: `evaluate(state, command, now) → GateResults`, total and never refusing to answer, and `decide(state, command, now, seed) → Accepted<Event[]> | Rejected<GateResults>`, which obtains every gate outcome by **calling `evaluate()`** and never re-deriving one. `seed` is declared because AD-1 and the epic AC fix that signature; `PlaceBid` never reads it and Story 3.6's draw is its first consumer — the same ship-it-declared-and-unused discipline `releaseNomination` already follows. The gate set is **fixed per command type and declared in `core/types.ts`**, so a `PlaceBid` result carries every gate whether or not each passed; a violation is a returned `Rejected`, never a throw (AD-1). The **read path calls the same `evaluate()`**, so a disabled control and the refusal explaining it cannot disagree. Increment and granularity are two separately written gates even though they coincide in Standard Contention. An accepted Bid sets the Auction Clock to exactly `AUCTION_CLOCK` from that Bid's own `occurredAt`, persisted as an **absolute close instant** the client counts down from — never "seconds remaining" (AD-3). `BidPlaced` joins `NominationPlaced` as the second and last of AD-22's reset set. Money crosses every boundary through `parseMoney`, compares through `compareMoney`, renders only through `formatMoney` (AD-8). Folds order by `seq`, and any iteration affecting an outcome is over an explicitly sorted sequence (AD-5). The core reads no clock, no randomness, and imports nothing outside itself (AD-1, AD-2). The write runs the transactional shell — lock → load → decide → persist — with `now` from the database clock (AD-6). Bid history names the acting Manager, with **no anonymity at any point**.

**Ask First:** Any migration or projection table. Any new design token. Adding a gate this story does not own. Changing the `/auction/[fantraxPlayerId]` URL shape. Persisting any derived money figure. Widening `EventEnvelope`.

**Never:** **No money gate and no capacity gate** — `maximumBid`, `committedBids`, `minorsExposure`, `rosterReserve` and Roster Count are not computed, displayed or refused on here, and neither is the disabled wording that names them ("you have no money" / "you have no roster slot"). Those are 2.6 and 2.7, with the refusal panel. **No Minimum-Bid Contention is ever produced**: an Opening Bid of exactly $1,000,000 is refused by a named gate, and the Contender list, seed table, fixed clock and draw are 3.2/3.3 — the `minimum_bid` state exists in the type solely as a state literal for §10 example 26. No expiry-as-authority gate (3.1). No close, no sweep, no `AuctionClosed` producer. No outbid notification, and no marking the previous Leading Bidder (2.6/5.x). **No control to cancel, edit or lower an accepted Bid — absent, not disabled.** No suggested amount, no recommended bid, no urgency styling. No client write path. No hand-edit of `planning-artifacts/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ordinary raise (§10 ex 1) | Standard Contention, high $8.0M held by A; B bids $8.5M | Accepted; one `BidPlaced`; close = that Bid's instant + 24h; League Clock reset | N/A |
| Both grounds (§10 ex 2) | Same auction; B bids $8.4M | Rejected; increment **and** granularity both report failed in one `GateResults` | N/A |
| Off-grid, clears increment (§10 ex 26a) | High $6.0M; bid $6,750,000 | Rejected on granularity; increment passes and says so | N/A |
| Off-grid in a lottery (§10 ex 26b) | `minimum_bid` state literal; bid $1,000,001 | Rejected on granularity, independent of contention state | N/A |
| At or below the high | High $8.0M; bid $8.0M or less | Rejected on increment | N/A |
| Self-bid | Actor's Team is already Leading Bidder | Rejected; control disabled with its own distinct wording | N/A |
| Opening above $1M | No bids; bid $1,500,000 | Accepted; Standard Contention; 24h clock | N/A |
| Opening at exactly $1M | No bids; bid $1,000,000 | Rejected by the named lottery gate — no contention is created | N/A |
| Opening below $1M | No bids; bid $500,000 | Rejected — under the Opening Bid minimum | N/A |
| Co-manager race (§10 ex 15) | Both Managers of one Team, same second | Exactly one accepted; the other refused because the price moved; the log names the accepted Manager | N/A |
| Unusable amount | Field empty, non-numeric, negative, or carrying a decimal | Rejected before any transaction opens, worded by the core | `fail(400)` |
| Unbound actor | Registered session, no Team | Rejected, no transaction opened | `fail(400)` |
| Unconfirmed submit | Amount entered, confirmation absent | Rejected — bidding is a deliberate two-part act | `fail(400)` |
| No open Auction | Player never nominated, or closed | 404, unchanged from Story 2.4 | `error(404)` |
| Wrong phase | Phase is not the Auction Phase | 403 through the existing destination gate | `error(403)` |

</frozen-after-approval>

## Code Map

Story 2.1's transactional-command shape and 2.4's route idiom are the two things reused wholesale. Nothing here adds a migration.

- `src/lib/core/types.ts` -- extend. Declare `PlaceBid`, `GateOutcome`, `GateResults`, `Accepted`, `Rejected`, and **`PLACE_BID_GATES`** — the fixed gate list, in one place so a later story adds one with a single edit. `:7-20` already names this file as the declared home and states the shape; honour it rather than inventing a second location. Do **not** widen `EventEnvelope` (`:60-68`).
- `src/lib/core/rules/bidding.ts` -- new. `evaluate()`, `decide()`, and `bidRefusalDetail`. Reuse `rules/nomination.ts`'s **wording** discipline (one sentence per refusal, `:113-160`; no route ever words its own) but **not its shape** — `refuseNomination` (`:171-208`) returns the first refusal and stops, which is exactly what AD-1 forbids here.
- `src/lib/core/projection/auctions.ts` -- new. `auctionsReducer` folding `BidPlaced` into leading Team, amount, contention state, `closesAt` and the chronological Bid list; `AuctionClosed` (already named at `projection/nominations.ts:73`) removes the auction. Accessors and the `readPayload`/`default: return state` discipline mirror `nominations.ts:124-142,163-280`.
- `src/lib/core/projection/league-clock.ts` -- add `BidPlaced` to the reducer's reset set (`:93-107`). The header at `:15-16` attributes `BidPlaced` to Story 2.2 — that is stale; correct it while there.
- `src/lib/core/money.ts` / `constants.ts` / `instant.ts` -- read-only. `parseMoney:66`, `compareMoney:133`, `isOnMoneyGrid:155`, `formatMoney:169`; `MINIMUM_BID:23`, `MINIMUM_INCREMENT:35`, `AUCTION_CLOCK:49`; `parseInstant:88`/`formatInstant:133` are how a close instant is computed without `Date`, which the purity gate forbids in core, and `relativePhrase:173` renders "4h 12m left".
- `src/lib/server/bidding.ts` -- new. `placeBid(gateway, actor, fantraxPlayerId, amount, deviceClass)` through `runTransactionalWrite` (`shell/write.ts:186`), mirroring `server/nomination.ts:513-585` including its `NominationActor`/rejection shapes. Loads with `loadEventsViaClient` (`event-log.ts:123`). **No `projections` hook**: no claim row, nothing derived stored.
- `src/lib/server/auction-page.ts` -- extend `loadAuctionPage` (`:141-215`) to take the viewer's team id, fold the auction alongside the nomination, and call `evaluate()` on the read path for the control's state and its pre-filled minimum legal Bid. Keep the existing reference and Manager reads untouched.
- `src/routes/auction/[fantraxPlayerId]/+page.server.ts` -- add a `bid` action beside the existing `load` (`:30-46`). Actor resolved from the session only and device class from the header, exactly per `nominate/+page.server.ts:59-68,84-126`; `requireLiveDestination` runs on the action as well as the load.
- `src/routes/auction/[fantraxPlayerId]/+page.svelte` -- the bid control (`--control-height` 46px, `--color-surface-sunken`, bounded by `--color-border-interactive`, submit beside it at the same height, two-part confirm), populated price / Leading Bidder / chronological history, and the close time rendered twice reusing the SSR-safe `$effect` pattern at `:53-86`. Tokens only, from `src/lib/styles/tokens.css`; structurally re-declared types, never imported from the server (`:16-18`).
- `tests/examples/` -- **new, and the first real files in this AR-2 directory.** One named test per §10 example: 1, 2, 15, 26, each calling the core directly against a state literal (AD-25). Delete `tests/examples/.gitkeep`.
- `tests/structure.test.ts` -- **required.** Move `tests/examples` out of `wouldBeEmpty` (`:55-61`) and into the "deletes the .gitkeep" list (`:68-74`). AGENTS.md names this exact trap: leaving the marker fails one assertion, deleting it without moving the entry fails the other.
- `tests/core/bidding.test.ts`, `tests/projection-auctions.test.ts`, `tests/server/bidding.test.ts`, `tests/routes/auction-page.test.ts` -- the gate set, the fold, the transaction and the surface. The server test uses the stateful fake gateway at `tests/server/nomination.test.ts:45-175`, which throws on unrecognised SQL — add a label rather than loosening it.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/types.ts` -- the `PlaceBid` command, `GateResults`, and the fixed `PLACE_BID_GATES` list -- AC1
- [x] `src/lib/core/projection/auctions.ts` -- the bid fold: leading Bid, contention state, `closesAt`, history -- AC4, AC6
- [x] `src/lib/core/rules/bidding.ts` -- `evaluate()` and `decide()`, every gate always reported -- AC1, AC2, AC3
- [x] `src/lib/core/projection/league-clock.ts` -- add `BidPlaced` to the reset set; correct the stale header -- AC5
- [x] `src/lib/server/bidding.ts` -- the transaction: lock, load, decide, append one event -- AC4, AC5
- [x] `src/lib/server/auction-page.ts` -- fold the auction; call `evaluate()` on the read path -- AC6, AC7
- [x] `src/routes/auction/[fantraxPlayerId]/+page.server.ts` -- the gated `bid` action -- AC4, AC7
- [x] `src/routes/auction/[fantraxPlayerId]/+page.svelte` -- control, price, Leading Bidder, history, close time twice -- AC6, AC7
- [x] `tests/examples/` -- §10 examples 1, 2, 15 and 26 as named tests calling the core directly -- AC2, AC3
- [x] `tests/structure.test.ts` -- re-register `tests/examples` and delete its `.gitkeep` -- AC8
- [x] `tests/core/bidding.test.ts`, `tests/projection-auctions.test.ts`, `tests/server/bidding.test.ts`, `tests/routes/auction-page.test.ts` -- the I/O matrix -- AC1-AC7

**Acceptance Criteria:**
- Given a `PlaceBid` command in any state, when `evaluate()` runs, then it returns every gate in `PLACE_BID_GATES` with that gate's own outcome and arithmetic, never throws, and an accepted result and a refused one carry an identical gate set — and `decide()` reaches its outcome only by calling `evaluate()`.
- Given a Bid in Standard Contention, when it is validated, then increment and granularity are two independently failing gates, and a $8,400,000 bid over a $8,000,000 high reports **both** as failed in one result.
- Given an off-grid amount, when it is submitted in any contention state — including a `minimum_bid` state literal — then granularity refuses it regardless of what the increment gate reports.
- Given an accepted Bid, when the transaction commits, then exactly one `BidPlaced` event is appended carrying Team, acting Manager, amount and device class; its `occurredAt` is the database's transaction-start clock; and the persisted absolute close instant is exactly `AUCTION_CLOCK` after it.
- Given an accepted Bid, when the League Clock is folded, then `BidPlaced` resets it and the reset set is still exactly two event types.
- Given an Auction carrying bids, when its page renders, then current price, the Leading Bidder spelled out with its acting Manager, and every Bid in chronological order with amount and timestamp all render with no anonymity, and the close time appears twice — relative and absolute in the viewer's timezone — with the absolute never omitted.
- Given a Manager whose Team leads the Auction, or whose amount would be illegal, when the page renders, then the control is disabled with the reason stated in words beneath it and worded by the core, and a direct submission of that same amount is refused server-side with the same wording.
- Given the repository, when `npm test` and `npm run check:purity` run, then `tests/examples` holds real tests and no `.gitkeep`, and `core/rules/bidding.ts` reads no clock and no randomness and imports nothing outside the core.

## Spec Change Log

## Design Notes

**Why the close instant rides the payload.** AD-3 requires the server to persist absolute close timestamps and AD-12 requires validation to compare `now` against a *persisted* one, never a projection's open flag. A projection table is the wrong home — AD-5 makes projections disposable and rebuildable. Carrying `closesAt` on the `BidPlaced` payload persists it in the insert-only log, keeps it foldable, and leaves AD-13's pause (which recomputes forward and never shifts a close time in place) somewhere to stand.

**Why `evaluate()` cannot be shaped like `refuseNomination`.** That function returns the first refusal and stops — correct for nominations, and exactly what AD-1 forbids for a Bid: `EXPERIENCE.md` reports the passing gate beside the failing one, so short-circuiting would put a fragment of the passed gate's arithmetic outside `core/`.

**The gate set grows, and that is the point.** 2.6 adds `cap`, 2.7 adds `slots`, 3.1 adds `expiry`. "Fixed per command type" means fixed at any given commit, not frozen forever — which is why the list is declared once in `core/types.ts` rather than assembled at each call site.

```ts
evaluate(state, { kind: 'PlaceBid', amount, fantraxPlayerId, teamId }, now)
// -> { opening:     { passed: true },
//      selfBid:     { passed: true },
//      increment:   { passed: false, minimumLegal: 8_500_000, offered: 8_400_000 },
//      granularity: { passed: false, offered: 8_400_000, grid: 500_000 } }
```

## Verification

**Commands:**
- `npm test` -- all pass. Baseline on `f6f382a` is **1286 passed / 1 failed**, the failure being the pre-existing `SUPABASE_DB_URL is not set` integration case (`deferred-work.md:224-226`). It must not grow.
- `npm run check` -- 0 errors, 0 warnings.
- `npm run check:purity` -- clean.

**Manual checks (if no CLI):**
- `rg -n "maximumBid|committedBids|minorsExposure|rosterReserve|Roster Count|no money|roster slot" src/lib/core/rules/bidding.ts src/lib/server/bidding.ts src/lib/server/auction-page.ts src/routes/auction/` returns nothing — the money and capacity gates and their wording are 2.6/2.7. The scope spans the server reader and the route as well as the rules, because the forbidden vocabulary leaks into a rendered figure as easily as into a gate.
- `git diff` adds no file under `supabase/migrations/`, and `placeBid` passes no `projections` array.
- `ls tests/examples/` shows real test files and no `.gitkeep`.

## Suggested Review Order

**The contract itself**

- Start here: the fixed gate list every consumer compiles against.
  [`types.ts:291`](../../src/lib/core/types.ts#L291)

- `evaluate()` — total, returns all four gates, never short-circuits.
  [`bidding.ts:342`](../../src/lib/core/rules/bidding.ts#L342)

- `decide()` reaches its outcome only by calling `evaluate()`.
  [`bidding.ts:813`](../../src/lib/core/rules/bidding.ts#L813)

- The command shape; no gate reads `teamName` or `managerId`.
  [`types.ts:194`](../../src/lib/core/types.ts#L194)

**The seam this story deliberately does not cross**

- Exactly $1,000,000 is refused by name — no lottery is ever produced.
  [`bidding.ts:526`](../../src/lib/core/rules/bidding.ts#L526)

- Contention folds from the log; `minimum_bid` is reachable only by a state literal.
  [`auctions.ts:301`](../../src/lib/core/projection/auctions.ts#L301)

**The clock**

- The close instant is `AUCTION_CLOCK` after the Bid's own `occurredAt`.
  [`auctions.ts:425`](../../src/lib/core/projection/auctions.ts#L425)

- `BidPlaced` joins `NominationPlaced` — the reset set is now exactly two.
  [`league-clock.ts:111`](../../src/lib/core/projection/league-clock.ts#L111)

**The write path**

- Lock, load, decide, append one event; no `projections` hook, no migration.
  [`bidding.ts:149`](../../src/lib/server/bidding.ts#L149)

- Two folds over one log read, so they cannot disagree about the moment.
  [`bidding.ts:109`](../../src/lib/server/bidding.ts#L109)

- The gated `bid` action; actor from the session only, never a form field.
  [`+page.server.ts:99`](../../src/routes/auction/%5BfantraxPlayerId%5D/+page.server.ts#L99)

**One evaluator, two consumers**

- The read path calls the same `evaluate()` for the pre-fill and the standing condition.
  [`auction-page.ts:457`](../../src/lib/server/auction-page.ts#L457)

- The component re-evaluates the typed amount through the core on every keystroke.
  [`+page.svelte:148`](../../src/routes/auction/%5BfantraxPlayerId%5D/+page.svelte#L148)

- One sentence beneath the form: the standing condition, else the typed amount's.
  [`+page.svelte:176`](../../src/routes/auction/%5BfantraxPlayerId%5D/+page.svelte#L176)

**Supporting**

- §10 examples registered by name, so a rename fails rather than silently skipping.
  [`structure.test.ts:38`](../../tests/structure.test.ts#L38)
