---
title: 'Story 2.8: Minors Exposure — unbounded eligible bidding bounded by overflow'
type: 'feature'
created: '2026-08-27'
status: 'done'
review_loop_iteration: 0
baseline_commit: '85a4e78475addbda68ef00c429caad35c06ca0f0'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The set Minors Exposure sums over does not exist. `teamMoneyStateFor` (`rules/bidding.ts:287`) *skips* a Minor League Eligible lead rather than collecting it, `minorsExposure` is the frozen `NO_MONEY` constant (`:497`, `:618`), and `projectedAdditionsFor` (`:545`) adds `1` unconditionally. So a Team two million under the cap bidding thirty million on a stashable rookie is refused on money it should not be bounded by (2.6's logged gap), a full Team is refused on capacity for a win that never touches Active/Bench (2.7's logged gap), and §10 examples 18, 19, 20 and 25 do not exist. FR-35 — the rule the PRD itself calls "the one rule most likely to surprise a reader" — is entirely unbuilt.

**Approach:** Give the core the three facts it lacks — the eligible Auctions the Team leads, its Minor League occupancy, and whether *this* Player is eligible — then derive `M`, `N` and `Overflow Count` in ONE counts-only expression that both gates read, and `Minors Exposure` in one money expression that only `cap` reads. Overflow is therefore the single hinge: it feeds `committedBids` back into 2.6's formula and `projectedAdditions` back into 2.7's ceiling, so one derivation refuses the cheap bid on money and the fourth stash on capacity without either gate learning the other's ground.

## Boundaries & Constraints

**Always:** `Free Minor League Slots (M)` = `max(0, 3 − occupied)`; `Eligible Leading Bids (N)` is the **post-bid** count — the Team's eligible leads excluding this Auction, plus one when this Player is eligible; `Overflow Count` = `max(0, N − M)`; `Minors Exposure` = the sum of the `Overflow Count` **largest** amounts in that post-bid set, zero when `N ≤ M`. `Projected Active/Bench Additions` = non-eligible leads + `Overflow Count` + one **only when this Player is not eligible** (PRD §3). **Maximum Bid is unbounded exactly when this Player is eligible and `Overflow Count` is 0**, and unbounded means the offered amount is not compared to anything — but **Roster Reserve must still be coverable** (`Available Cap Space − Roster Reserve ≥ 0`), which is PRD §3's "provided Roster Reserve remains coverable" and FR-13's "only the Roster Reserve check and the ordinary increment rules apply there", both narrated by §10 example 18's "$1,000,000 … which its $2,000,000 covers". An unbounded Maximum Bid renders **in words — "no cap limit"** — never a number, and the breakdown states why: a Free Minor League Slot absorbs this Player at a $0 Cap Hit. A cap refusal driven by overflow **names the specific earlier eligible Auction** by Player name and amount; a capacity refusal driven by overflow names the overflow in **counts only**. `SlotsGateOutcome` still has **no `offered` field and no money field** — `Overflow Count` is a count, so the capacity gate reaches it without ever seeing an amount, and FR-37's "fails with unlimited Cap Space, passes with none" stays a property of the signature. Both gates read the ONE counts expression; only `cap` reads the amounts. Every figure is derived from committed state on every evaluation, never persisted, memoised or serialised as a derived figure. The overflow set is summed over an **explicitly sorted** sequence — amount descending, `fantraxPlayerId` ascending as tiebreak (AD-5). An accepted Bid is never retroactively invalidated: only the new Bid is refused. `evaluate()` stays total, `decide()` reaches its outcome only by calling it, `core/rules/bidding.ts` still reads no clock and no randomness, and every sentence, chip, label and figure is worded in the core.

**Ask First:** Any migration or new table. Any new design token or colour. Adding a gate beyond the six. Changing `MINOR_LEAGUE_SLOTS`, `ACTIVE_BENCH_SLOTS` or `MINIMUM_BID`. Persisting or memoising any derived figure. Serialising `maximumBid`, `committedBids`, `minorsExposure`, `overflowCount` or `rosterReserve` to the client. A new Svelte component. Changing the `/auction/[fantraxPlayerId]` URL shape. Making `minorsExposure` anything other than the largest-sized worst case.

**Never:** **No Minimum-Bid Contention is produced.** §10 examples 21 and 22 are Epic 3's and must not be written here — the eligible `$1,000,000` contribution is implemented in the one `teamMoneyStateFor` expression that already routes `minimum_bid`, exercised only against a state literal. **No Auction Close, no Slot Placement, no lottery draw, no expiry gate** (Epic 3): example 20's closed Auction is reached with a *synthetic* `AuctionClosed`, exactly as 2.3 proved its fold. **No activation modelling, warning or block** — Fantrax owns it. No Bid Board page (4.3), no persistent strip (Epic 4), no Teams index (4.6). No second enforcement of the Minor League or IR ceiling at bid time — Story 1.7 enforces those on import. No carve-out exempting an eligible Bid from Roster Capacity. **No red anywhere**; `attention` amber marks Outbid and refusal and nothing else. No hand-edit of `planning-artifacts/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Stashing beats the cap (§10 ex 18) | Cap Space $2.0M, Roster Count 11, 2 Minor Slots occupied, no eligible leads; bids $30.0M on an eligible Player | `M=1`, `N=1`, Overflow 0, Exposure $0 — **accepted**. `cap` reports unbounded; the breakdown prints "no cap limit" and the reason, no number. Capacity `11 + 0 = 11 ≤ 12` | N/A |
| Overflow refuses the cheap bid (§10 ex 19) | Same Team still leading that $30.0M eligible Auction; bids $1.0M on a second eligible Player | `N=2`, `M=1`, Overflow 1, Exposure $30.0M (the largest). Refused on `cap` alone, naming the $30.0M Auction by Player. `slots` **passes** at `11 + 1 = 12` | N/A |
| A resolved win stops being exposure (§10 ex 20) | The $30.0M Auction closed (synthetic `AuctionClosed`); 3 Minor Slots occupied; re-bids $1.0M on the second eligible Player | `M=0`, `N=1`, Overflow 1, Exposure $1.0M — the bid's own amount. Maximum Bid $1.0M, offered $1.0M — **accepted**. Not unbounded | N/A |
| The full roster can still stash (§10 ex 25) | Roster Count 12, Cap Space $40.0M, 3 Minor Slots free; bids $9.0M on an eligible Player | `N=1 ≤ M=3`, Overflow 0, Projected Additions 0, capacity `12 + 0 = 12 ≤ 12` — **accepted**, unbounded | N/A |
| …until it overflows | Same Team now leading three eligible Auctions; bids on a fourth eligible Player | `N=4`, `M=3`, Overflow 1, Projected Additions 1, `13 > 12` — **refused on `slots`**, naming the overflow in counts. No Slot Placement carve-out | N/A |
| Unbounded but the reserve is short | Eligible Player, Overflow 0, Cap Space $1.0M, Roster Count 5, no leads → Roster Reserve $7.0M | Refused on `cap`: unbounded does not waive the reserve. The sentence states the reserve shortfall and quotes **no** Maximum Bid | N/A |
| An eligible lead bounds a non-eligible bid | Team in Overflow by $30.0M bids on a **non-eligible** Player | Exposure $30.0M enters Committed Bids; Maximum Bid is an ordinary number; the breakdown's "of which Minors Exposure" row is non-zero and the column still sums | N/A |
| A minimum-bid contention on an eligible Player | `minimum_bid` state literal, Player eligible | Contributes an Eligible Leading Bid of **$1.0M** to `eligibleLeading`, not the flat $1.0M to `leading`. Commits nothing while a Free Minor League Slot absorbs it | N/A |
| Two exposing Auctions at the same amount | Overflow 2, two eligible leads both $5.0M | Summed over the sorted sequence — amount descending, `fantraxPlayerId` ascending — so the figure and the naming are deterministic | N/A |
| Occupancy above the ceiling | Commissioner override leaves 4 Minor Slots occupied | `M` clamps to 0; every eligible lead overflows. No negative `M`, no extra spending power | N/A |
| Viewer bound to no Team | Registered session, no Team | Every cap figure `null`, `unbounded` false, both gates pass; the control is refused as `unbound_actor` | `fail(400)` |
| Team with no roster rows | No `team_rosters` row | Occupancy 0, `M=3`, Roster Count 0 — a real post-import state | N/A |
| Announced on the board | Full Team renders an eligible Auction page | The control is **enabled** with "no cap limit" shown before anything is typed — the mirror of ex 24's disabled non-eligible control | N/A |
| Refused under the lock | Overflow read inside the transaction, after the lock | Refusal carries the transaction's gate set and stamp; no `BidPlaced` appended; the earlier Bid untouched | `fail(409)` |

</frozen-after-approval>

## Code Map

The exposure set is the only genuinely new data. Everything downstream of it — the sixth chip, the panel, the breakdown column — already iterates what the core hands it, so this story is four core files, two server files, one structural type on the page, and the tests.

- `src/lib/core/types.ts` -- extend. `CapGateOutcome` (`:316`) gains `unbounded: boolean`, `freeMinorLeagueSlots: number | null`, `eligibleLeadingBids: number | null`, `overflowCount: number | null` and `exposingBids: readonly ExposingBid[]` (the overflow set's *earlier* Auctions, so a refusal can name them; empty otherwise). `SlotsGateOutcome` (`:355`) gains `overflowCount`, `freeMinorLeagueSlots` and `eligibleLeadingBids` — **counts only, still no `offered` and still no money field**, which is what keeps FR-37's independence structural. The `null` figures stay null *together* for an unbound actor, exactly as `:348-353` and `:309-314` promise, and `unbounded` is `false` there. `PLACE_BID_GATES` (`:375`) is **unchanged** — this story adds no gate. Correct the header's "adding the `cap` or `slots` gate" note (`:25-32`) only if it now misleads.
- `src/lib/core/rules/bidding.ts` -- extend, and this is most of the implementation.
  - `BidState` (`:188`) gains `playerIsMinorLeagueEligible: boolean` — a fact about the **Auction**, not the Team, so it belongs here and not on `TeamMoneyState`. `bidStateFor` (`:248`) takes it as a third argument; every caller becomes a compile error, which is the point.
  - `LeadingBidElsewhere` (`:208`) gains `playerName` — §10 ex 19's refusal must name an Auction, and `:216-218` already says the id is carried "so a refusal can NAME the Auctions". One shape serves both lists; two shapes differing by one field would invite a second narrowing.
  - `TeamMoneyState` (`:231`) gains `eligibleLeading: readonly LeadingBidElsewhere[]` (sorted by id, AD-5) and `minorLeagueOccupied: number` — the **raw** occupancy, never `M`, because `:224-230` forbids a derived figure on this shape.
  - `teamMoneyStateFor` (`:287`) **partitions instead of skipping**: `:302` currently `continue`s on an eligible Player; it now routes that entry — including the `minimum_bid` → `MINIMUM_OPENING_BID` substitution already at `:306` — into `eligibleLeading`. New inputs `minorLeagueOccupied` and `playerNameFor`. Correct `:212-218` and `:274-282`, which say the eligible set is 2.8's.
  - **Two new derivations, and the split between them is load-bearing.** `minorsCountsFor(state)` → `{ freeMinorLeagueSlots, eligibleLeadingBids, overflowCount }`, **counts only**, read by `evaluateSlots`, `projectedAdditionsFor` *and* `evaluateCap`. `minorsExposureFor(state, amount)` → `{ minorsExposure, exposingBids }`, read by `evaluateCap` alone. `unfilledSlots` (`:514`) is the discipline; `projectedAdditionsFor` (`:545`) is the precedent.
  - `projectedAdditionsFor` (`:545`) takes `BidState` and becomes `team.leading.length + (state.playerIsMinorLeagueEligible ? 0 : 1) + overflowCount`. Its "the `+ 1` is unconditional, and that is Story 2.8's boundary" paragraph (`:530-543`) is now false and must be rewritten, not deleted.
  - `evaluateCap` (`:597`) replaces `NO_MONEY` (`:618`) with `minorsExposureFor`, and its `passed` becomes: unbounded → `availableCapSpace − rosterReserve ≥ 0`; otherwise the existing `offered ≤ maximumBid`. `NO_MONEY` (`:497`) survives only if still used — its comment is stale either way. `evaluateSlots` (`:684`) adds the overflow term through `minorsCountsFor` and reads no amount.
  - `gateSentence` (`:816`): the `cap` case (`:861`) gains the unbounded-reserve-short branch and the exposure-naming clause; the `slots` case (`:874`) gains the overflow branch. `gateFigure` (`:1064`): `cap` (`:1099`) says "no cap limit" in words when unbounded; `slots` (`:1107`) may name the overflow. `capBreakdown` (`:960`) renders the Maximum Bid row in words when unbounded, adds the "why" `detail` row (`EXPERIENCE.md:101`), and gives the existing "of which Minors Exposure" row (`:987`) its `N`/`M`/Overflow commentary. Labels must stay unique — `CapBreakdown.svelte:40` keys the `{#each}` on `label`.
  - Rewrite the module header's two now-false paragraphs: "What the two gates may see" (`:43-50`) and the `+ 1` boundary (`:63-70`).
- `src/lib/core/constants.ts` -- read-only. `MINOR_LEAGUE_SLOTS` (`:71`) is `M`'s ceiling and already cites PRD §11. Add no second constant.
- `src/lib/server/team-roster.ts` -- extend, minimally. `TeamRosterFigures` gains `minorLeagueOccupied`; the one loop (`:88`) already reads `roster_slot_kind` and needs a second counter, no SQL change. Correct the header's "two figures". Both callers spread this result, so the new fact flows to each without a third call site.
- `src/lib/server/bidding.ts` -- extend. `loadBidState` (`:145`) already folds nominations, auctions and eligibility over one read; pass `minorLeagueOccupied` through the existing spread, `playerNameFor` from `nominationForPlayer`, and `isEligible(eligibility, fantraxPlayerId)` into `bidStateFor`. Correct `:32-38`, which says `PLACE_BID_GATES` is fixed at four.
- `src/lib/server/auction-page.ts` -- extend. The same three at `:386-392`. `AuctionPageBidControl` (`:188`) gains `playerIsMinorLeagueEligible: boolean` so the surface can rebuild `BidState`; `team` (`:216`) widens with `TeamMoneyState` automatically. **Serialise no derived figure** — not `minorsExposure`, not `overflowCount`, not `maximumBid`; `tests/server/auction-page.test.ts:746` is the guard and must stay green unedited. Correct `:35-48`, which says the exposure branch is unbuilt.
- `src/routes/auction/[fantraxPlayerId]/+page.svelte` -- **the one surface edit, and it is data transport only.** The structural `TeamMoney` type (`:90`) gains `eligibleLeading` and `minorLeagueOccupied`, `BidControl` (`:96`) gains the eligibility flag, `teamMoney` (`:179`) re-brands the new amounts through `parseMoney` at the boundary (AD-8), and `gateState` (`:192`) passes the flag. **No rule, no wording, no figure.** `tests/routes/auction-page.test.ts:487` greps the raw text of both route files — comments included — for `Minor League Slot`, `Eligible Leading Bid`, `Overflow Count`, `unbounded` and `no cap limit`: word the new comments around those phrases and leave the guard at full strength. If that proves impossible, narrow it deliberately and say which phrase and why.
- `src/lib/components/CapBreakdown.svelte`, `RefusalPanel.svelte`, `+page.server.ts` -- **read-only, and prove it with tests rather than asserting it.** Every label and figure arrives finished from `capBreakdown()`; the panel `{#each}`es `bidGateReport`'s rows. If any needs an edit, that is a finding worth stating plainly.
- `tests/examples/example-18-*.test.ts`, `example-19-*.test.ts`, `example-20-*.test.ts`, `example-25-*.test.ts` -- new, one per §10 example, each a `PlaceBid` against a state literal calling the core directly (AD-25). `example-24-full-roster-ends-non-eligible-bidding.test.ts` is the shape; example 20 needs a synthetic `AuctionClosed` (`projection/auctions.ts:347`) and example 25 runs three accepted stashes before the refused fourth.
- `tests/structure.test.ts` -- **required.** Register all four in `SECTION_10_EXAMPLES` (`:39-53`) and update the story note above it (`:30-37`), or a rename silently reduces the executable specification.
- `tests/core/bidding.test.ts` -- the largest test edit. `:510` forbids `/free minor league/i`, `/eligible leading bid/i`, `/overflow/i`, `/no cap limit/i` and `/unbounded/i` in every refusal sentence — **this story earns all five and must remove all five**, leaving the guard empty or retired with a note rather than silently loosened. `:831`'s "excludes a Minor League Eligible Player" becomes a **partition** assertion. `:120`'s literal gate list is unchanged and must stay so. `:898`'s null-together block gains the new fields. Add the boundary table: `N ≤ M`, `N = M`, `N = M + 1`, occupancy above 3, ties in the overflow set, both gates failing together.
- `tests/server/team-roster.test.ts` -- occupancy counted from `minor_league` rows, alongside the existing Roster Count assertions.
- `tests/server/bidding.test.ts` -- the transaction: an overflow refusal under the lock carrying `gates` and `at`, with nothing appended and the earlier `BidPlaced` untouched. The fake gateway throws on unrecognised SQL; the `team_rosters` label already exists.
- `tests/server/auction-page.test.ts` (`:746`), `tests/routes/auction-page.test.ts` (`:419`, `:466`) -- these prove the read path serialises facts only and the page words nothing. They must pass **unedited** except for the deliberate narrowing named above.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/types.ts` -- the five `CapGateOutcome` fields, the three `SlotsGateOutcome` counts, `ExposingBid` -- AC1, AC2
- [x] `src/lib/core/rules/bidding.ts` -- `playerIsMinorLeagueEligible` on `BidState`, the partition in `teamMoneyStateFor`, `minorsCountsFor`, `minorsExposureFor`, the rewritten `projectedAdditionsFor`, the unbounded branch and reserve check in `evaluateCap`, the overflow term in `evaluateSlots`, both sentences, both figures, the breakdown rows, the corrected header -- AC1-AC5
- [x] `src/lib/server/team-roster.ts` -- `minorLeagueOccupied` from the existing loop -- AC6
- [x] `src/lib/server/bidding.ts`, `src/lib/server/auction-page.ts` -- the three facts through the existing folds and spread; no derived figure serialised -- AC6, AC7
- [x] `src/routes/auction/[fantraxPlayerId]/+page.svelte` -- the widened structural types and the re-branding, and nothing else -- AC7
- [x] `tests/examples/example-18|19|20|25-*.test.ts` -- §10 examples 18, 19, 20 and 25 -- AC2, AC3, AC4
- [x] `tests/structure.test.ts` -- register all four by name -- AC8
- [x] `tests/core/bidding.test.ts` -- retire the five-term guard, the partition, the boundary table, both-gates-report, the null-together block -- AC1-AC5
- [x] `tests/server/team-roster.test.ts`, `tests/server/bidding.test.ts` -- occupancy, and the overflow refusal under the lock -- AC6
- [x] `tests/server/auction-page.test.ts`, `tests/routes/auction-page.test.ts` -- the read path carries facts only and the page still words nothing -- AC7

**Acceptance Criteria:**
- Given any `PlaceBid`, when `evaluate()` runs, then `cap` carries `unbounded`, `M`, `N`, `Overflow Count`, `Minors Exposure` and its exposing Auctions, `slots` carries `Overflow Count`, `M` and `N` and **no money field and no `offered`**, the gate set is still exactly the six of `PLACE_BID_GATES`, `evaluate()` never throws, and `decide()` reaches its outcome only by calling it.
- Given a Minor League Eligible Player a Free Minor League Slot absorbs (`Overflow Count` 0), when the money gate is evaluated, then Maximum Bid is unbounded and the offered amount is compared to nothing — but the Bid is still refused when Available Cap Space does not cover Roster Reserve, and that refusal quotes no Maximum Bid.
- Given the exposure arithmetic, when it is derived, then `M = max(0, 3 − occupied)`, `N` is the post-bid count, `Overflow Count = max(0, N − M)`, `Minors Exposure` is the sum of the `Overflow Count` largest amounts over a sequence sorted by amount descending and id ascending, and zero when `N ≤ M` — computed on every evaluation from committed state, never persisted, memoised or serialised.
- Given a later cheap eligible Bid that pushes its Team into Overflow, when it is evaluated, then **that** Bid is refused, the earlier accepted Bid is untouched, and the refusal names the specific earlier eligible Auction by Player and amount.
- Given an eligible Bid that would overflow with nowhere to land, when Roster Capacity is evaluated, then it is refused on `slots` with no Slot Placement carve-out, the refusal names the overflow in counts alone, `cap` still reports its own arithmetic, and neither gate short-circuits the other.
- Given the transaction, when a Bid is refused on either ground under the lock, then the roster and the folds were read after `pg_advisory_xact_lock`, the refusal carries that transaction's gate set and stamp, and no `BidPlaced` is appended.
- Given the Auction page, when it renders for an eligible Player a Free Minor League Slot absorbs, then "no cap limit" and its reason appear from `capBreakdown()` with **no number**, the read path serialises facts only, and no route or component file words a rule of its own.
- Given the repository, when `npm test`, `npm run check` and `npm run check:purity` run, then examples 18, 19, 20 and 25 are registered by name in `tests/structure.test.ts`, and `core/rules/bidding.ts` still reads no clock and no randomness and imports nothing outside the core.

## Design Notes

**Overflow is a count, so the capacity gate never sees money.** This is the whole reason the story fits without weakening 2.7. `Overflow Count = max(0, N − M)` needs only two integers, and `Projected Active/Bench Additions` adds it to a count. So `evaluateSlots` still takes `BidState` and not the amount, `SlotsGateOutcome` still has no `offered` and no money field, and FR-37's "fails with unlimited Cap Space, passes with none" remains a property of the signature rather than a claim to verify by reading. Splitting the derivation in two — `minorsCountsFor` for the integers, `minorsExposureFor` for the dollars — is what buys that. A single function returning both would have handed the capacity gate a money figure it must be unable to reach.

**Unbounded is not a waiver.** PRD §3 qualifies it "provided Roster Reserve remains coverable" and FR-13 says "only the Roster Reserve check and the ordinary increment rules apply there"; §10 example 18 narrates the check out loud — reserve `$1,000,000`, "which its `$2,000,000` covers". So unbounded means the *offered amount* is compared to nothing, while `Available Cap Space − Roster Reserve ≥ 0` still decides. Getting this wrong is silent: every owned example passes either way except the reserve-short row in the matrix, which is why that row is there.

**`unbounded` is a boolean, not a discriminated `maximumBid`.** A `Money | 'unbounded'` union would make forgetting the branch a compile error, which is the stronger design — but the only two renderers of that figure are `capBreakdown` and `gateFigure`, both in the core, both covered by owned examples, and `tests/routes/auction-page.test.ts:426` already forbids the surface from naming `maximumBid` at all. The union's real cost is rewriting `expect(gates.cap.maximumBid).toBe(…)` in five example tests that *are* the executable specification. Keep the arithmetic and add the flag; if review disagrees, the union is the named alternative.

**The prospective bid is in the set it is judged against, and that is the PRD's arithmetic.** §10 example 20 is explicit: exposure is `$1,000,000` — "the bid's own amount" — so Maximum Bid is `$2.0M − $1.0M = $1.0M` and the `$1.0M` bid is permitted at exactly the ceiling. The effective bound on a sole overflowing eligible bid is therefore half the Team's room. That is conservative rather than wrong, it is what §10 states, and §10 is the executable specification (AD-25). Do not "fix" it.

```
Cap    · Refused    no cap limit does not apply; Overflow Count 1
Slots  · Passed     Roster Count would be 12 of 12

Cap Space                                        $2.0M
Committed Bids                                 − $30.0M
  of which Minors Exposure                       $30.0M
  Eligible Leading Bids 2, Free Minor League Slots 1, Overflow Count 1
Available Cap Space                            − $28.0M
Roster Reserve                                 −  $0.0M
Maximum Bid                                    − $28.0M
```

## Verification

**Commands:**
- `npm test` -- all pass. Baseline on `85a4e78` is **1568 passed / 1 failed**, the failure being the pre-existing `SUPABASE_DB_URL is not set` integration case (`deferred-work.md`). It must not grow.
- `npm run check` -- 0 errors, 0 warnings.
- `npm run check:purity` -- clean.

**Manual checks (if no CLI):**
- `git diff --stat` touches no file under `supabase/migrations/`, and changes no executable line in `src/lib/components/` or `src/routes/auction/[fantraxPlayerId]/+page.server.ts`. The only sanctioned executable change outside `src/lib/core/` and `src/lib/server/` is the structural type widening in `+page.svelte`. Anything more is a finding: say which and why.
- `rg -n "overflowCount|minorsExposure|freeMinorLeagueSlots|eligibleLeadingBids" src/lib/server src/routes supabase` returns no assignment to a database column, no module-level cache, and no value the surface compares against instead of re-deriving.
- `rg -n "MINOR_LEAGUE_SLOTS|ACTIVE_BENCH_SLOTS" src/lib/core/rules/bidding.ts` shows each reached through the one counts expression, not recomputed per gate — and `minorsCountsFor` is called by `evaluateCap`, `evaluateSlots` and `projectedAdditionsFor` alike.
- `rg -n "offered|Money" src/lib/core/types.ts` around `SlotsGateOutcome` shows neither on that shape.
- `rg -n "AuctionClosed" tests/examples/` shows the synthetic close only in example 20 — no close is implemented, only folded.
- `rg -n "sort" src/lib/core/rules/bidding.ts` shows the overflow set sorted before it is summed or sliced, with the id tiebreak.

## Suggested Review Order

**The counts/money split, which is what let 2.7's gate survive**

- Start here: three integers, no money — both gates read this one call.
  [`bidding.ts:687`](../../src/lib/core/rules/bidding.ts#L687)

- The money half, `evaluateCap`'s alone, sorted before it is summed or sliced.
  [`bidding.ts:737`](../../src/lib/core/rules/bidding.ts#L737)

- Overflow is a count, so capacity reaches it without seeing an amount.
  [`bidding.ts:830`](../../src/lib/core/rules/bidding.ts#L830)

- Still takes `BidState` and not the amount — independence by signature.
  [`bidding.ts:1034`](../../src/lib/core/rules/bidding.ts#L1034)

- Three counts and no `offered`, no money field. The invariant 2.7 bought.
  [`types.ts:448`](../../src/lib/core/types.ts#L448)

**Unbounded, and the reserve it does not waive**

- One line: eligible and nothing overflows. Everything else follows.
  [`bidding.ts:958`](../../src/lib/core/rules/bidding.ts#L958)

- The gate that replaced the frozen zero; unbounded still checks the reserve.
  [`bidding.ts:908`](../../src/lib/core/rules/bidding.ts#L908)

- In words, never a number — the subtraction ran but is not printed.
  [`bidding.ts:1494`](../../src/lib/core/rules/bidding.ts#L1494)

- And the breakdown says why, which is the half EXPERIENCE.md names.
  [`bidding.ts:1504`](../../src/lib/core/rules/bidding.ts#L1504)

**Naming the exposure without naming this Auction**

- Three shapes; the third stops the named amounts summing short of the figure.
  [`bidding.ts:1324`](../../src/lib/core/rules/bidding.ts#L1324)

- The bit that makes the third shape reachable, added in review.
  [`types.ts:397`](../../src/lib/core/types.ts#L397)

- Partitions instead of skipping — an eligible lead is routed, not dropped.
  [`bidding.ts:378`](../../src/lib/core/rules/bidding.ts#L378)

**The three facts, read once under the lock**

- Occupancy counted in the loop that already read the slot kind.
  [`team-roster.ts:109`](../../src/lib/server/team-roster.ts#L109)

- Player names for the refusal, off the nominations fold already in hand.
  [`bidding.ts:180`](../../src/lib/server/bidding.ts#L180)

- Facts to the client, never a derived figure — the read path's whole rule.
  [`auction-page.ts:598`](../../src/lib/server/auction-page.ts#L598)

**Supporting**

- §10 ex 18: $30.0M on $2.0M of room, permitted, and the reserve still checked.
  [`example-18:183`](../../tests/examples/example-18-stashing-beats-the-cap.test.ts#L183)

- §10 ex 19: the cheap Bid refused, the $30.0M Auction named by Player.
  [`example-19:110`](../../tests/examples/example-19-overflow-refuses-the-cheap-bid.test.ts#L110)

- §10 ex 20: a synthetic close, and the lead stops being exposure.
  [`example-20:145`](../../tests/examples/example-20-a-resolved-win-stops-being-exposure.test.ts#L145)

- §10 ex 25: refused on capacity with the money there, no Slot Placement carve-out.
  [`example-25:138`](../../tests/examples/example-25-the-full-roster-can-still-stash.test.ts#L138)

- The tiebreak decides which side of the cutoff this Bid lands on.
  [`bidding.test.ts:1483`](../../tests/core/bidding.test.ts#L1483)

- The both-in-slice sentence, added in review: $11.0M explained, not $5.0M.
  [`bidding.test.ts:1518`](../../tests/core/bidding.test.ts#L1518)
