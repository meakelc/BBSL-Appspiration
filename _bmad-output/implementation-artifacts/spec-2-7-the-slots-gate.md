---
title: 'Story 2.7: The slots gate — Roster Capacity, and both gates always reported'
type: 'feature'
created: '2026-08-27'
status: 'done'
review_loop_iteration: 0
baseline_commit: '0e982520fc56f968e8c090d1321d46ebae6d7841'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A Team with a full roster and money to burn can win a Player it has nowhere to put. `PLACE_BID_GATES` (`core/types.ts:339`) is fixed at five and none of them is capacity. `evaluateCap` (`rules/bidding.ts:547`) already derives Roster Count and Projected Active/Bench Additions — it just never compares them to the twelve, so PRD §10 example 24 (Roster Count 12, $40,000,000 of Cap Space, bidding $5,000,000 on a non-eligible Player) is **accepted** today. The module header says outright that it "carries no such comparison", `GATE_LABELS` has no `slots`, and no §10 example 24 exists.

**Approach:** Add `slots` as the sixth gate in the fixed set, derived from the same two figures the money gate already carries, through one shared expression — so the two can never disagree about the arithmetic while disagreeing about the outcome. The report machinery 2.6 built iterates `PLACE_BID_GATES`, so the chip, the row and the panel follow with no markup change, which is what makes "both gates always reported" structural rather than remembered.

## Boundaries & Constraints

**Always:** `slots` refuses when `Roster Count + Projected Active/Bench Additions > ACTIVE_BENCH_SLOTS`, on the **post-bid basis** Roster Reserve already uses — Projected Active/Bench Additions counts the bid being placed. It is a **second, independent ground**: it reads no amount and no Maximum Bid, so a Team can fail it with unlimited Cap Space and pass it with none; neither gate short-circuits, subsumes or gates the other, and `evaluate()` returns both outcomes with their own arithmetic whether or not the other passed. `SlotsGateOutcome` carries its **own copy** of `rosterCount`, `projectedAdditions` and the `ceiling` — reporting a capacity refusal as a cap refusal is a defect (AD-7), so the two gates share the derivation and never the outcome, and the two machine-readable reasons are the two distinct gate keys. Both figures are derived by the core from committed state on **every** evaluation, never persisted, memoised or cached client-side for validation. They are `null` together and only for an actor bound to no Team, and the gate then **passes** — exactly as `cap` does, because the real refusal is `unbound_actor`. `evaluate()` stays total, `decide()` reaches its outcome only by calling it, and `core/rules/bidding.ts` still reads no clock and no randomness. Every sentence, chip and figure is worded in the core: no route, component or test writes one. Roster Reserve's `max(0, …)` clamp is **kept** — a Commissioner override can still put a Team above 12, and that Team must be refused on capacity rather than rewarded with spending power.

**Ask First:** Any migration, projection table or new table read. Any new design token or colour. Adding a gate other than `slots`. Changing `ACTIVE_BENCH_SLOTS`. Persisting or memoising any derived figure. Widening `EventEnvelope`, or `TeamMoneyState` beyond what the gate needs. A new Svelte component. Changing the `/auction/[fantraxPlayerId]` URL shape.

**Never:** **No eligible-Player branch.** Projected Active/Bench Additions stays `leading.length + 1` unconditionally; that a Minor League Eligible win lands in a Minor League Slot and adds nothing to Active/Bench is **2.8's**, and it is the same boundary 2.6 already logged in `deferred-work.md`. So: no Free Minor League Slots, no Eligible Leading Bids, no Overflow Count, no Minors Exposure arithmetic, no unbounded "no cap limit" rendering, and no Slot Placement carve-out. **No Bid Board page** — Story 4.3 owns it; the surface this story announces on is the Auction page's existing bid control. No persistent Maximum-Bid/Roster strip (Epic 4). No Injury Reserve or Minor League ceiling as a bid-time gate — Story 1.7 enforces those on import and this story adds no second enforcement. **No red anywhere**; `attention` amber marks Outbid and refusal and nothing else. No expiry gate (3.1), no close, no sweep, no client write path. No hand-edit of `planning-artifacts/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Full roster, money to burn (§10 ex 24) | Roster Count 12, Cap Space $40.0M, leads nothing; bids $5.0M on a non-eligible Player | Rejected on `slots` alone; `cap` reports **passed** carrying Maximum Bid $40.0M; the refusal states 12, 1 and the ceiling of 12 — no cap figure | N/A |
| The bid itself fills the last hole | Roster Count 11, leads nothing | `12 ≤ 12` — passes; the figure reads "Roster Count would be 12 of 12" | N/A |
| Leads elsewhere push it over | Roster Count 10, leads two non-eligible Auctions | Projected Additions 3, `13 > 12` — refused, though no single Bid did it | N/A |
| Money fails, slots does not | Over Maximum Bid, roster has room | Rejected on `cap`; `slots` reports passed with its own count | N/A |
| Both fail | Over Maximum Bid **and** at Roster Count 12 | Both report refused, each with its own arithmetic and its own sentence, in `PLACE_BID_GATES` order | N/A |
| Commissioner override above the ceiling | Roster Count 14 | Roster Reserve still clamps to `$0`; `slots` refuses at `15 > 12` | N/A |
| Announced on the board, not at submission | Team at Roster Count 12 renders the Auction page | The control is disabled with the capacity reason stated before anything is typed — a state reachable straight from import | N/A |
| Refused on capacity under the lock | Roster read inside the transaction, after the lock | Refusal carries the transaction's gate set and its stamp; no `BidPlaced` appended | `fail(409)` |
| Viewer bound to no Team | Registered session, no Team | `slots` reports both figures absent rather than inventing zeroes, and passes; the control is refused as `unbound_actor` | `fail(400)` |
| Team with no roster rows | No `team_rosters` row for the Team | Roster Count 0, Projected Additions 1 — passes. A real post-import state, not an error | N/A |
| Refusal rendered | Any refused submit | Six rows on the panel, the refusing gates filled and the passing ones outlined, each carrying its own figure, none behind a disclosure | N/A |

</frozen-after-approval>

## Code Map

Story 2.6 built every seam this story fills and named it in five places. Nothing here adds a migration, a table read, a server change or a component.

- `src/lib/core/types.ts` -- extend. Add `'slots'` to `PLACE_BID_GATES` (`:339`) **after `'cap'`** — one edit, and every consumer is a compile error until it handles it (`:325-338`). Add `SlotsGateOutcome` beside `CapGateOutcome` (`:315`) carrying `rosterCount: number | null`, `projectedAdditions: number | null` and `ceiling: number`, plus the `slots` key on `PlaceBidGateResults` (`:360`). **No `offered` field** — a gate that cannot see the amount cannot come to depend on one, which is what makes "fails with unlimited cap space" structural. Correct `:308-313`, which promises this gate. Do not widen `EventEnvelope` (`:60-68`).
- `src/lib/core/rules/bidding.ts` -- extend, and this is the whole implementation. Extract `projectedAdditionsFor(team)` out of `evaluateCap` (`:576`) so both gates read ONE expression — the discipline `unfilledSlots` (`:495`) already sets. Add `evaluateSlots`, its `evaluate()` entry (`:613`), its `gateSentence` case (`:705`), its `gateFigure` case (`:931`) and `GATE_LABELS.slots = 'Slots'` (`:1037`). Correct the header's "carries no such comparison" (`:44-56`), `:37`, and `BidState`'s "the capacity gate is 2.7's" (`:160-167`) — the `slots` half is now true and the 2.8 half must survive verbatim. The figure follows `EXPERIENCE.md:89` in shape — `Roster Count would be N of 12` — one branch serving passed and refused alike. `describeAmount` (`:911`) is untouched: this gate renders no money.
- `src/lib/core/constants.ts` -- read-only. `ACTIVE_BENCH_SLOTS` (`:62`) is the ceiling and already cites FR-37. Add no second constant.
- `src/lib/server/bidding.ts`, `src/lib/server/team-roster.ts`, `src/lib/server/auction-page.ts` -- **read-only, and that is the finding.** `loadBidState` (`:145`) already reads `team_rosters` under the lock and `readBidControl` (`:527`) already builds `TeamMoneyState` for the viewer, so the gate needs no new data and the rejection already carries `gates` and `at`. Correct `auction-page.ts:35-43`, which says capacity "is still Story 2.7's".
- `src/lib/components/RefusalPanel.svelte`, `CapBreakdown.svelte`, `src/routes/auction/[fantraxPlayerId]/+page.svelte`, `+page.server.ts` -- **read-only.** `bidGateReport` (`:1086`) maps `PLACE_BID_GATES` and the panel `{#each}`es the rows (`RefusalPanel.svelte:116`), so the sixth chip appears unchanged; `control.available` (`+page.svelte:589`) already disables the field on a standing condition, which capacity is. **Prove this with tests rather than asserting it** — if any of these does need an edit, that is a finding worth stating plainly.
- `tests/examples/example-24-full-roster-ends-non-eligible-bidding.test.ts` -- new. §10 example 24, calling the core directly against a state literal (AD-25). `example-23` (`:26-80`) is the shape to follow.
- `tests/structure.test.ts` -- **required.** Register example 24 in `SECTION_10_EXAMPLES` (`:41-49`) and update the Story 2.6 note above it (`:31-38`), or a renamed file silently reduces the executable specification.
- `tests/core/bidding.test.ts` -- `:120` asserts the gate list **literally**, so a sixth gate is a deliberate edit here too. `:508` forbids `/roster capacity/i` and `/no roster slot/i` in every refusal sentence — this story earns exactly those two and must remove exactly those two, leaving 2.8's five. Watch `:911` (Roster Count 11 plus one lead) and `example-04:92` (Roster Count 14): both now fail `slots`, and both must stay assertions about `cap` alone.
- `tests/routes/auction-page.test.ts` (`:410`, `:453`), `tests/server/auction-page.test.ts` (`:742`) -- these forbid capacity vocabulary as unbuilt. The route and page still word nothing themselves, so the PAGE_CODE checks stand; retitle them, and narrow the server one to the **derived-money** figures, since a capacity-refused read path now legitimately carries "Roster Count" in its `detail`.
- `tests/server/bidding.test.ts` -- the transaction: refused on capacity under the lock, with the gates and the stamp on the `BidRejection`. Both fake gateways throw on unrecognised SQL; the `team_rosters` label already exists.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/types.ts` -- `'slots'` in `PLACE_BID_GATES`, `SlotsGateOutcome`, the `slots` key -- AC1
- [x] `src/lib/core/rules/bidding.ts` -- `projectedAdditionsFor`, `evaluateSlots`, its sentence, its figure, its label, the corrected header -- AC1, AC2, AC3
- [x] `tests/examples/example-24-full-roster-ends-non-eligible-bidding.test.ts` -- §10 example 24 -- AC2, AC3
- [x] `tests/structure.test.ts` -- register example 24 -- AC6
- [x] `tests/core/bidding.test.ts` -- the literal gate list, the freed vocabulary, the gate itself, both-report and no-short-circuit -- AC1-AC4
- [x] `tests/server/bidding.test.ts`, `tests/server/auction-page.test.ts`, `tests/routes/auction-page.test.ts` -- the transaction, the read path, the board announcement; retitle the now-stale 2.7 guards -- AC4, AC5

**Acceptance Criteria:**
- Given a `PlaceBid` in any state, when `evaluate()` runs, then it returns `slots` alongside the other five with its own `rosterCount`, `projectedAdditions` and `ceiling`, never throws, and an accepted result and a refused one carry the identical gate set — and `decide()` still reaches its outcome only by calling `evaluate()`.
- Given a prospective Bid, when Roster Capacity is evaluated, then it refuses exactly when `Roster Count + Projected Active/Bench Additions > 12` on the post-bid basis, reading no amount and no money figure, and §10 example 24 passes as a named test calling the core directly.
- Given a Bid that fails one gate, when it is evaluated, then the other still runs and reports its own arithmetic — neither short-circuits the other, the two carry distinct machine-readable reasons, and a capacity refusal never states a cap figure as its ground nor a cap refusal a roster one.
- Given a refusal on either ground, when the panel renders, then every gate in `PLACE_BID_GATES` has a row, the refusing ones filled `attention` and the passing ones outlined `border-interactive` carrying their own figure, none behind a disclosure and no red anywhere — and the row's wording comes from `core/rules/bidding.ts`, with no component or route changed to make it appear.
- Given a Team at Roster Count 12, when the Auction page renders for a non-eligible Player, then the bid control is already disabled with the capacity reason stated before anything is typed — and a submit that reaches the transaction is refused under the lock with no `BidPlaced` appended, against roster figures read after the lock.
- Given the repository, when `npm test`, `npm run check` and `npm run check:purity` run, then example 24 is registered by name in `tests/structure.test.ts`, and `core/rules/bidding.ts` still reads no clock and no randomness and imports nothing outside the core.

## Spec Change Log

- **2026-08-27, review iteration 0 — Acceptance Auditor: the Verification section contradicted the Code Map.**
  The Code Map *orders* a comment-only header correction in `src/lib/server/auction-page.ts` (its 2.6 text said capacity "is still Story 2.7's"), while the Verification manual check said the diff "touches no file under `src/lib/server/`". A correct implementation could not satisfy both, and the implementer rightly followed the Code Map.
  **Amended:** the Verification bullet now permits comment-only changes in `src/lib/server/` and `src/lib/components/` and forbids executable ones, naming both files the Code Map sanctions.
  **Known-bad state avoided:** treating this as a code defect and reverting a correct 648-line diff to re-derive identical code — the contradiction was one sentence in the spec, not a line in the source.
  **KEEP — must survive any re-derivation:**
  - `SlotsGateOutcome` has **no `offered` field**. FR-37's "fails with unlimited Cap Space, passes with none" is a property of the signature, not a claim to verify by reading.
  - `projectedAdditionsFor` is the **single** expression both gates read; `rg "leading.length \+ 1"` must return exactly one line.
  - The `+ 1` stays **unconditional**. The eligible-Player branch is 2.8's and is logged in `deferred-work.md`, not half-built.
  - No executable line under `src/lib/components/` or `src/routes/`: the sixth chip must continue to arrive from `PLACE_BID_GATES` alone, proven by `tests/routes/auction-page.test.ts`.
  - The composed refusal must state **both** grounds when both fail, in `PLACE_BID_GATES` order — added in review after the matrix audit found the "Both fail" row checked its numbers but never its sentences.

## Design Notes

**One derivation, two gates, two outcomes.** `evaluateCap` computes `projectedAdditions` at `bidding.ts:576` and `unfilledSlots` at `:495`. If `evaluateSlots` recomputed either, the two gates could disagree about the count while agreeing they describe the same roster — the failure "reporting a capacity refusal as a cap refusal is a defect" exists to prevent, arriving from the other direction. Extract the expression once; let each gate reach its own verdict from it. That is also why `SlotsGateOutcome` carries its own copy of the figures rather than a pointer at `cap`'s: two rows each stating their own arithmetic cannot be read as one.

**The gate reads no amount, deliberately.** `SlotsGateOutcome` has no `offered` field. FR-37's "a Team can fail it with unlimited cap space and pass it with none" is then a structural property — a gate that cannot see the money has no way to be quietly folded into the money one — rather than a claim a reviewer has to verify by reading.

**The eligible gap is 2.8's, and is the gap 2.6 already logged.** FR-37 says a Team at Roster Count 12 *can* bid on a Minor League Eligible Player a Free Minor League Slot would absorb, because that win adds nothing to Active/Bench. That needs Free Minor League Slots and the current Player's eligibility, neither of which `TeamMoneyState` carries. Until 2.8 supplies them the `+ 1` is unconditional and such a Bid is refused on capacity. Append the boundary to `deferred-work.md` beside the 2.6 entry rather than half-building it: it is unreachable in production before 2.8 lands, since both stories sit inside Epic 2 and the Auction does not open to Managers until the epic is complete.

```
Cap    · Passed     Maximum Bid $40.0M, offered $5.0M
Slots  · Refused    Roster Count would be 13 of 12
```

## Verification

**Commands:**
- `npm test` -- all pass. Baseline on `0e98252` is **1546 passed / 1 failed**, the failure being the pre-existing `SUPABASE_DB_URL is not set` integration case (`deferred-work.md`). It must not grow.
- `npm run check` -- 0 errors, 0 warnings.
- `npm run check:purity` -- clean.

**Manual checks (if no CLI):**
- `git diff --stat` touches no file under `src/routes/` or `supabase/migrations/`, and changes no executable line under `src/lib/server/` or `src/lib/components/` — the Code Map orders a comment-only header correction in `server/auction-page.ts`, and a stale forward reference in `RefusalPanel.svelte` may be corrected the same way. Any change beyond a comment in those two directories is a finding: say which and why.
- `rg -n "minorsExposure|Free Minor League|Overflow Count|Eligible Leading Bid|no cap limit|unbounded" src/lib/core/rules/bidding.ts` shows Minors Exposure only as the named zero term and none of the rest — those are 2.8.
- `rg -n "rosterCount|projectedAdditions" src/lib/server src/routes supabase` returns no assignment to a database column, no module-level cache, and no value the surface compares against instead of re-deriving.
- `rg -n "leading.length \+ 1" src/lib/core/rules/bidding.ts` returns exactly one line — the shared derivation, not one copy per gate.

## Suggested Review Order

**The gate, and what it may not see**

- Start here: one edit grew the fixed gate set from five to six.
  [`types.ts:381`](../../src/lib/core/types.ts#L381)

- Three fields and no `offered` — independence is the signature, not a claim.
  [`types.ts:355`](../../src/lib/core/types.ts#L355)

- The whole gate. It takes `BidState`, never the amount.
  [`bidding.ts:684`](../../src/lib/core/rules/bidding.ts#L684)

- One expression, two gates. Recomputing it is how they would drift apart.
  [`bidding.ts:545`](../../src/lib/core/rules/bidding.ts#L545)

- No amount passed, so neither gate can reach the other's ground.
  [`bidding.ts:730`](../../src/lib/core/rules/bidding.ts#L730)

**Wording a refusal that quotes no money**

- Counts, their sum, then the ceiling — and not one dollar figure.
  [`bidding.ts:874`](../../src/lib/core/rules/bidding.ts#L874)

- `EXPERIENCE.md`'s row verbatim; one branch serves passed and refused.
  [`bidding.ts:1107`](../../src/lib/core/rules/bidding.ts#L1107)

- The sixth label, which is all the panel needed to render a sixth chip.
  [`bidding.ts:1189`](../../src/lib/core/rules/bidding.ts#L1189)

**The claim that no surface changed**

- Proves the sixth row arrives from `PLACE_BID_GATES` alone, not asserts it.
  [`auction-page.test.ts:944`](../../tests/routes/auction-page.test.ts#L944)

- A full roster reaches the board already disabled, worded by the core.
  [`auction-page.test.ts:856`](../../tests/server/auction-page.test.ts#L856)

- Refused under the lock, roster read after it, nothing appended.
  [`bidding.test.ts:465`](../../tests/server/bidding.test.ts#L465)

**Supporting**

- §10 ex 24: refused on capacity alone, with `cap` reporting $40.0M passed.
  [`example-24:89`](../../tests/examples/example-24-full-roster-ends-non-eligible-bidding.test.ts#L89)

- Both gates on the panel, each carrying its own figure.
  [`example-24:132`](../../tests/examples/example-24-full-roster-ends-non-eligible-bidding.test.ts#L132)

- The boundary table, and the both-fail wording the review added.
  [`bidding.test.ts:1083`](../../tests/core/bidding.test.ts#L1083)

- The passing figure pinned as a string, not merely as non-empty.
  [`bidding.test.ts:1174`](../../tests/core/bidding.test.ts#L1174)

- §10 ex 23 now states outright that it is the at-the-ceiling case.
  [`example-23:129`](../../tests/examples/example-23-ir-does-not-fill-the-twelve.test.ts#L129)

- Example 24 registered by name, so a rename fails rather than skips.
  [`structure.test.ts:48`](../../tests/structure.test.ts#L48)
