---
title: 'Story 2.6: The money gate and the refusal panel'
type: 'feature'
created: '2026-08-27'
status: 'done'
review_loop_iteration: 0
baseline_commit: '1f807f23ffa1b138c16b27fbc262bee54b6dd46b'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A Manager can bid any amount their Team cannot afford. `PLACE_BID_GATES` (`core/types.ts:291`) is fixed at four and none of them is money: `BidState` (`rules/bidding.ts:127`) carries one field and says outright it "deliberately carries no cap figure and no roster figure". Nothing computes Cap Space, Committed Bids or Roster Reserve at validation time, `Maximum Bid` appears nowhere in `src/`, and a refusal is one sentence in a `<p>` — not the panel `EXPERIENCE.md:84-95` calls the most important screen in the product.

**Approach:** Add `cap` to the fixed gate set, derive its arithmetic in the pure core from committed state on every evaluation, and build the refusal panel that shows the arithmetic summing. The gate reads a Team money state narrowed once from the log and the roster table, so the transaction, the read path and the surface reach the same figure through the same `evaluate()`.

## Boundaries & Constraints

**Always:** Every derived figure — Cap Space, Committed Bids, Available Cap Space, Roster Reserve, Projected Active/Bench Additions, Maximum Bid — is computed by the core from committed state at validation time, on **every** evaluation, and is **never persisted on a Team row, never memoised across transactions, never cached client-side for validation** (AD-7). They are evaluated against the **hypothetical post-bid state**: Projected Active/Bench Additions counts the bid being placed. Committed Bids = Σ the Team's leading amounts on open Auctions for non-eligible Players (a `minimum_bid` contention counting `MINIMUM_BID`) + Minors Exposure; Available Cap Space = Cap Space − Committed Bids; Roster Reserve = `MINIMUM_BID × max(0, 12 − (Roster Count + Projected Active/Bench Additions))` — **the clamp is kept**, because a Commissioner override can put a Team above 12; Maximum Bid = Available Cap Space − Roster Reserve. Roster Count is Active/Bench rows only — IR and Minor League excluded (§10 ex 23). `cap` is a gate like any other: `evaluate()` stays total and reports it whether it passed or failed, `decide()` reaches it only by calling `evaluate()`, and no gate short-circuits another. Capital released the instant a Team ceases to lead falls out of the fold, not out of a sweep. Money crosses every boundary through `parseMoney`, compares through `compareMoney`, renders only through `formatMoney`/`describeAmount` (AD-8), and every figure sits on the $500,000 grid so the breakdown **sums exactly as displayed**. The refusal panel is `surface` with a 3px top accent bar in `attention` — the only top bar in the system — ordered headline, delta, reassurance, gate report, timestamped arithmetic, then the disabled control with its reason; the arithmetic is never behind a disclosure and the panel is **announced to assistive technology as it appears**. Every gate in `PLACE_BID_GATES` renders a row, the refusing one a filled `attention` chip, a passing one an outlined `border-interactive` chip carrying its own figure. No route, component or test words a refusal — every sentence comes from `core/rules/bidding.ts`.

**Ask First:** Any migration or projection table. Any new design token or colour. Adding a gate other than `cap`. Persisting or memoising any derived money figure. Changing the `/auction/[fantraxPlayerId]` URL shape. Widening `EventEnvelope`.

**Never:** **No capacity gate** — `Roster Count + Projected Active/Bench Additions > 12` is not refused on here, and no `slots` gate name, chip or sentence exists yet; that is 2.7, which also owns the two-row cap-beside-slots report. **No Minors Exposure arithmetic** — the term is named in the formula and is structurally `$0`, and Eligible Leading Bids, Free Minor League Slots, Overflow Count and the unbounded "no cap limit" rendering are 2.8. **No red anywhere**; `attention` amber marks Outbid and refusal and nothing else. No suggested amount, no recommended bid, no urgency styling, no countdown pressure. **No control to cancel, edit or lower an accepted Bid — absent, not disabled.** No outbid notification delivery (5.x). No expiry gate (3.1), no close, no sweep. No client write path. No hand-edit of `planning-artifacts/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Roster reserve bites (§10 ex 3) | Cap Space $12.0M, Roster Count 9, leads nothing; bids $10.5M on a non-eligible Player | Rejected on `cap`; reserve $2.0M, Maximum Bid $10.0M, arithmetic shown | N/A |
| Reserve clears (§10 ex 4) | Same Team now leading two Auctions at $3.0M and $2.0M | Available Cap Space $7.0M, additions 3, reserve $0, Maximum Bid $7.0M | N/A |
| Outbid frees capital (§10 ex 5) | The $3.0M lead passes to another Team | Available $10.0M, additions 2, reserve $1.0M, Maximum Bid $9.0M — from the fold, no sweep | N/A |
| IR does not fill the twelve (§10 ex 23) | 11 Active/Bench + 1 Injury Reserve, leads nothing | Roster Count 11, additions 1, reserve $0 | N/A |
| Exactly at Maximum Bid | Offered equals Maximum Bid | Accepted — the gate refuses only above it | N/A |
| Every other gate passes, money does not | Legal increment, on grid, not self | Rejected; `cap` alone reports failed, the other four report passed with their figures | N/A |
| Money passes, another gate does not | Affordable but off-grid | Rejected on `granularity`; `cap` reports **passed** and carries its figure | N/A |
| Eligible leading Bid elsewhere | Team leads an Auction on a `minorLeagueEligible` Player | That amount is excluded from Committed Bids and from Projected Additions | N/A |
| Valid when composed, invalid on arrival | Another Auction's price moved under the lock | Refused with the **current** figures, stamped at the transaction clock | `fail(409)` |
| Viewer bound to no Team | Registered session, no Team | `cap` reports its figures as absent rather than inventing zeroes; the control is refused as `unbound_actor` | `fail(400)` |
| Team with no roster rows | No `team_rosters` row for the Team | Cap Space is the full Salary Cap and Roster Count 0 — a real post-import state, not an error | N/A |
| Refusal rendered | Any refused submit | Panel announced to assistive technology, arithmetic visible, control disabled with its reason | N/A |

</frozen-after-approval>

## Code Map

Story 2.5 built the seam this story fills: it named `cap` as 2.6's in four places and left `BidState` minimal on purpose. Nothing here adds a migration.

- `src/lib/core/types.ts` -- extend. Add `'cap'` to `PLACE_BID_GATES` (`:291`) — **one edit, and every consumer becomes a compile error until it handles it**, which is the mechanism `:284-290` says the list exists for — plus `CapGateOutcome` and the `cap` key on `PlaceBidGateResults` (`:317`). Do not widen `EventEnvelope` (`:60-68`).
- `src/lib/core/rules/bidding.ts` -- extend. `TeamMoneyState`/`LeadingElsewhere`, a `team` field on `BidState` (`:127`), `evaluateCap`, its `gateSentence` case (`:432`) and its breakdown. Correct the header's "this module cannot see a Team's cap figures" (`:35-41`) — it can now, and the `slots` half of that paragraph must survive. `describeAmount` (`:502`) is the one renderer; add no second.
- `src/lib/core/rules/roster-import.ts` -- widen `computeCapSpace` (`:40`) to accept the structural `{ capHit, rosterSlotKind }` subset. `ParsedRosterRow[]` still satisfies it, so the import path is untouched and Cap Space keeps ONE definition — including its "a Minor League row's cap hit is $0" rule (`:33-39`).
- `src/lib/core/constants.ts` -- read-only. `MINIMUM_BID:24` already documents itself as "the per-hole figure Roster Reserve holds back"; **reuse it, add no `MINIMUM_SALARY`.** `SALARY_CAP:18`, `ACTIVE_BENCH_SLOTS:62` is the 12.
- `src/lib/core/projection/auctions.ts` -- read-only. `OpenAuctions.byPlayer` (`:127`) is every open Auction with its leading Bid and `contention` (`:83`) — the whole input to Committed Bids. Iterate its keys **sorted** (AD-5).
- `src/lib/core/projection/eligibility.ts` -- read-only. Fold `eligibilityReducer` over the same events array and ask `isEligible` (`:64`); do **not** re-read `free_agent_players.minor_league_eligible` for this, or two answers become possible in one transaction.
- `src/lib/server/bidding.ts` -- extend `loadBidState` (`:107`). Its header claims "no table read at all" (`:104-106`) — that ends here: one `select cap_hit, roster_slot_kind from team_rosters where team_id = $1` inside the transaction, after the lock. Carry the transaction `now` and the gate results on `BidRejection` (`:93`) so a refused submit renders the figures it was actually judged against.
- `src/lib/server/auction-page.ts` -- extend `loadAuctionPage` (`:301`) and `readBidControl` (`:457`). Same roster read for `viewerTeamId` (skipped when `null`), the auctions fold it already does (`:311`), and a `figuresAt` stamp for the arithmetic caption. `now: ''` stays correct — no gate reads a clock.
- `src/lib/components/RefusalPanel.svelte` -- new, beside `HeaderMenu.svelte`. The panel's anatomy and nothing else: tokens only from `src/lib/styles/tokens.css` (`--color-attention:47`, `--color-attention-ink:48`, `--font-display:62`), every sentence and figure passed in already worded.
- `src/routes/auction/[fantraxPlayerId]/+page.server.ts` -- return the gate results, the stamp and the refusal through the existing `fail(409)` (`:142-149`); word nothing new.
- `src/routes/auction/[fantraxPlayerId]/+page.svelte` -- render the panel on a refusal, and the Maximum Bid breakdown beside the control. Re-evaluate on keystroke through the existing `bidControlState` call (`:148`); types stay structurally re-declared, never imported from a server module (`:41-44`).
- `tests/examples/` -- add examples 3, 4, 5 and 23, each calling the core directly against a state literal (AD-25).
- `tests/structure.test.ts` -- **required.** Register all four in `SECTION_10_EXAMPLES` (`:37-42`) and update the Story 2.5 note above it, or a renamed file silently reduces the executable specification.
- `tests/core/bidding.test.ts`, `tests/server/bidding.test.ts`, `tests/server/auction-page.test.ts`, `tests/routes/auction-page.test.ts` -- the gate, the transaction, the read path, the surface. Both fake gateways throw on unrecognised SQL (`tests/server/bidding.test.ts:96`, `tests/server/auction-page.test.ts:187`) — add a `team_rosters` label rather than loosening either.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/types.ts` -- `'cap'` in `PLACE_BID_GATES`, `CapGateOutcome`, the `cap` key -- AC1
- [x] `src/lib/core/rules/roster-import.ts` -- widen `computeCapSpace` to the structural roster subset -- AC2
- [x] `src/lib/core/rules/bidding.ts` -- `TeamMoneyState`, the money half of `BidState`, `evaluateCap`, its sentence and breakdown -- AC1, AC2, AC3
- [x] `src/lib/server/bidding.ts` -- roster read under the lock; `now` and gates on the rejection -- AC4, AC5
- [x] `src/lib/server/auction-page.ts` -- viewer roster, money state, `figuresAt` -- AC5, AC6
- [x] `src/routes/auction/[fantraxPlayerId]/+page.server.ts` -- carry the refusal, gates and stamp to the surface -- AC5
- [x] `src/lib/components/RefusalPanel.svelte` -- the panel anatomy, announced on appearance -- AC7
- [x] `src/routes/auction/[fantraxPlayerId]/+page.svelte` -- the breakdown beside the control, the panel on refusal -- AC6, AC7
- [x] `tests/examples/` -- §10 examples 3, 4, 5 and 23 -- AC2
- [x] `tests/structure.test.ts` -- register the four new examples -- AC8
- [x] `tests/core/bidding.test.ts`, `tests/server/bidding.test.ts`, `tests/server/auction-page.test.ts`, `tests/routes/auction-page.test.ts` -- the I/O matrix -- AC1-AC7

**Acceptance Criteria:**
- Given a `PlaceBid` in any state, when `evaluate()` runs, then it returns `cap` alongside the existing four with that gate's own arithmetic, never throws, and an accepted result and a refused one carry the identical gate set — and `decide()` still reaches its outcome only by calling `evaluate()`.
- Given a Team's committed state, when its money figures are computed, then Committed Bids, Available Cap Space, Roster Reserve and Maximum Bid follow the stated formulas against the **post-bid** state with the `max(0, …)` clamp retained, and §10 examples 3, 4, 5 and 23 pass as named tests calling the core directly.
- Given any of those figures, when they are computed, then they are derived on every evaluation and appear on no database column, in no module-level cache, and in no client-held value used to authorise a Bid — the surface re-derives through `evaluate()` on every keystroke.
- Given a Bid above the bidding Team's Maximum Bid, when it is submitted, then it is refused inside the transaction against state loaded under the global lock, no `BidPlaced` is appended, and the refusal carries the figures as they stood at the transaction clock — not as the page rendered them.
- Given a Team that ceases to be Leading Bidder on another Auction, when its Maximum Bid is next computed, then that capital is already released, because the figure is a fold of the log and no sweep, flag or scheduled job is involved.
- Given a Manager viewing an Auction, when Maximum Bid is displayed, then Cap Space, Committed Bids, Minors Exposure and Roster Reserve are broken out, never a bare number, the displayed figures sum exactly as rendered, and they come from the read path calling the same `evaluate()` `decide()` calls.
- Given a refused Bid, when the panel renders, then it is a `surface` panel with a 3px `attention` top bar presenting headline, delta, reassurance, a row per gate in `PLACE_BID_GATES` with the refusing gate filled and a passing gate outlined and carrying its own figure, the timestamped arithmetic with no disclosure, and the disabled control with its reason — announced to assistive technology, with no red anywhere.
- Given the repository, when `npm test`, `npm run check` and `npm run check:purity` run, then §10 examples 3, 4, 5 and 23 are registered by name in `tests/structure.test.ts`, and `core/rules/bidding.ts` still reads no clock and no randomness and imports nothing outside the core.

## Spec Change Log

## Design Notes

**Why the gate takes raw inputs, not a derived figure.** `TeamMoneyState` carries Cap Space, Roster Count and the Team's leading Auctions — not Committed Bids or Maximum Bid. AD-7 forbids a derived figure being cached client-side for validation, and the surface is a client: shipping it `maximumBid` and letting it compare would make the transported number the check. Shipping the inputs means the same derivation runs in the browser, on the read path and inside the lock, and the only way for them to disagree is for the state to have genuinely moved — which is exactly the case the refusal reports.

**Why `cap` reports absence rather than zeroes.** With no Team there is no cap arithmetic, and stating `$0` would be an invented figure a panel would then print. The gate reports its figures as `null` together and passes, the way `increment` reports `minimumLegal: null` on an opening; the actual refusal a Manager sees is `unbound_actor`, which the route already raises before any transaction opens. `server/bidding.ts` always has a bound actor, so the null case is render-only.

**Minors Exposure is named and zero, deliberately.** FR-13 requires the refusal to show it, and a breakdown that omitted a term would not sum. It is a `$0` line computed from an empty set of Eligible Leading Bids, and the exclusion of eligible leading Bids from Committed Bids (FR-14) is implemented now — so 2.8 adds the exposure sum and the unbounded branch without rewriting this arithmetic. Until 2.8 lands, an eligible Player is judged by the ordinary formula; that gap is 2.8's to close and belongs in `deferred-work.md`.

```
Cap Space          $12.0M
Committed Bids     −$5.0M   (leading $3.0M + $2.0M, Minors Exposure $0.0M)
Available Cap Space $7.0M
Roster Reserve      −$0.0M   ($1.0M × max(0, 12 − (9 + 3)))
Maximum Bid         $7.0M
```

## Verification

**Commands:**
- `npm test` -- all pass. Baseline on `1f807f2` is **1462 passed / 1 failed**, the failure being the pre-existing `SUPABASE_DB_URL is not set` integration case (`deferred-work.md`). It must not grow.
- `npm run check` -- 0 errors, 0 warnings.
- `npm run check:purity` -- clean.

**Manual checks (if no CLI):**
- `rg -n "minorsExposure|Minors Exposure|slots|Roster Capacity|no cap limit" src/lib/core/rules/bidding.ts` shows Minors Exposure only as the named zero term and **no** `slots` gate, no capacity refusal and no unbounded rendering — those are 2.7 and 2.8.
- `rg -n "maximumBid|committedBids|rosterReserve" src/lib/server src/routes supabase` returns no assignment to a database column, no module-level cache, and no value the surface compares against instead of re-deriving.
- `git diff` adds no file under `supabase/migrations/`, and `placeBid` still passes no `projections` array.
- `rg -n "#[0-9a-fA-F]{3,6}|red" src/lib/components/RefusalPanel.svelte` returns nothing — tokens only, and no red.

## Suggested Review Order

**The gate, and what it may see**

- Start here: one edit grew the fixed gate set from four to five.
  [`types.ts:341`](../../src/lib/core/types.ts#L341)

- Nine figures, all `null` together only when the actor has no Team.
  [`types.ts:315`](../../src/lib/core/types.ts#L315)

- The whole arithmetic. The `+ 1` is the post-bid basis §10 ex 3 pins.
  [`bidding.ts:547`](../../src/lib/core/rules/bidding.ts#L547)

- Raw facts, never a derived figure — AD-7's reason for the shape.
  [`bidding.ts:212`](../../src/lib/core/rules/bidding.ts#L212)

- Three filters, each a rule: this Auction, another Team's, an eligible Player's.
  [`bidding.ts:268`](../../src/lib/core/rules/bidding.ts#L268)

- One derivation of the unfilled-slot count, so the renderer cannot drift.
  [`bidding.ts:495`](../../src/lib/core/rules/bidding.ts#L495)

**Rendering money that may not be on the grid**

- Every figure through `describeAmount`: an imported Cap Hit has no grid guarantee.
  [`bidding.ts:827`](../../src/lib/core/rules/bidding.ts#L827)

- One wording per refusal; the framed form is composed from the unframed one.
  [`bidding.ts:1124`](../../src/lib/core/rules/bidding.ts#L1124)

- Built from the declared list, so 2.7's `slots` row appears with no markup change.
  [`bidding.ts:1085`](../../src/lib/core/rules/bidding.ts#L1085)

**The two figures no fold can answer**

- Cap Space and Roster Count from `team_rosters` — one reader, two callers.
  [`team-roster.ts:72`](../../src/lib/server/team-roster.ts#L72)

- The parameter widening that let the money gate reuse Cap Space's one definition.
  [`roster-import.ts:42`](../../src/lib/core/rules/roster-import.ts#L42)

- Story 2.5's "no table read at all" ends here — and the read is after the lock.
  [`bidding.ts:145`](../../src/lib/server/bidding.ts#L145)

- The rejection carries the figures and the clock it was judged at (FR-13).
  [`bidding.ts:118`](../../src/lib/server/bidding.ts#L118)

**One evaluator, three consumers**

- Stamped beside the reads it describes, not at the end of the load.
  [`auction-page.ts:377`](../../src/lib/server/auction-page.ts#L377)

- Every refusal gets a delta, so the panel renders for all of them.
  [`+page.server.ts:119`](../../src/routes/auction/%5BfantraxPlayerId%5D/+page.server.ts#L119)

- The surface re-derives through the core on every keystroke; nothing is cached.
  [`+page.svelte:261`](../../src/routes/auction/%5BfantraxPlayerId%5D/+page.svelte#L261)

**The most important surface in the product**

- Focus on appearance, because `role="alert"` alone misses a full page load.
  [`RefusalPanel.svelte:58`](../../src/lib/components/RefusalPanel.svelte#L58)

- One column definition, shared by the standing figures and the refusal.
  [`CapBreakdown.svelte:40`](../../src/lib/components/CapBreakdown.svelte#L40)

- The panel keys on the delta alone — any refused submit, arithmetic or not.
  [`+page.svelte:526`](../../src/routes/auction/%5BfantraxPlayerId%5D/+page.svelte#L526)

**Supporting**

- §10 ex 3: the post-bid basis, and the breakdown summing as displayed.
  [`example-03:69`](../../tests/examples/example-03-roster-reserve-bites.test.ts#L69)

- §10 ex 5: capital released by folding one more event — no sweep.
  [`example-05:137`](../../tests/examples/example-05-outbid-frees-capital.test.ts#L137)

- §10 ex 23: IR counts against the Cap, not against the twelve.
  [`example-23:71`](../../tests/examples/example-23-ir-does-not-fill-the-twelve.test.ts#L71)

- The regression tests for the off-grid crash; reverting the fix fails three.
  [`bidding.test.ts:1051`](../../tests/core/bidding.test.ts#L1051)

- The four new examples registered by name, so a rename fails rather than skips.
  [`structure.test.ts:42`](../../tests/structure.test.ts#L42)

