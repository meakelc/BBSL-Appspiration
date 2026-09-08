---
title: 'Story 10.1 — The Outstanding Bid Allowance in the slots gate'
type: 'feature'
created: '2026-09-08'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'e6c63e3593965a810cc689c39da5efdee4d464d2'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-10-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The slots gate refuses any Bid taking `rosterCount + projectedAdditions` past 12, so a Manager with one free Slot may hold exactly one outstanding Bid and then idles for a day waiting on a close they cannot influence. FR-37 was rewritten on 2026-09-08 to permit one Bid beyond the free Slots — the **Outstanding Bid Allowance** — and the gate does not yet implement it.

**Approach:** Replace the single ceiling comparison in `evaluateSlots` with FR-37's two-branch rule: pass when `projectedAdditions = 0`, **or** when the Team holds at least one Free Active/Bench Slot *and* `projectedAdditions ≤ freeActiveBenchSlots + 1`. Carry `freeActiveBenchSlots` and `allowance` on the outcome beside the existing counts, and split the gate's wording into the three distinct sentences UX-DR32 requires. Everything stays inside the core; no consumer outside `rules/bidding.ts` reads the outcome's fields.

## Boundaries & Constraints

**Always:**
- The gate keeps taking `BidState` and **never** the amount. No money field may appear on `SlotsGateOutcome` — FR-37's "fails with unlimited Cap Space, passes with none" stays a property of the signature.
- The `+ 1` is a named constant beside `ACTIVE_BENCH_SLOTS` in `core/constants.ts`, never an inline literal.
- The free-slot precondition is tested **before** the allowance arithmetic. A Team with zero Free Active/Bench Slots gets no allowance.
- `ceiling` stays 12 and is reported on every evaluation, pass and refusal alike, alongside `rosterCount`, `projectedAdditions`, `freeActiveBenchSlots` and `allowance`. A refusal quoting only the allowance would imply thirteen players are legal.
- The nullable count fields stay null **together**, only for an actor bound to no Team, and the gate still passes there. `ceiling` is never null.
- `projectedAdditionsFor` and `minorsCountsFor` remain the single shared derivations both gates call.

**Ask First:**
- Any change to `unfilledSlots`' clamp, to `projectedAdditionsFor`, to `teamMoneyStateFor`'s `leading` / `eligibleLeading` partition, to `CapGateOutcome`, or to a §10 example test numbered 1–22 or 26–28.

**Never:**
- Do not remove Minimum-Bid Contention entries from the slots-side count — that is Story 10.2, and AR-40's two-overflow split belongs there.
- Do not touch `rules/close.ts`, cancellation, restoration, or `projection/auctions.ts` — Stories 10.3–10.5.
- Do not add the pre-confirm allowance sentence (UX-DR34), the strip figure (UX-DR35) or the Teams-index column (UX-DR36) — Story 10.6.
- Do not collapse the two refusal sentences into one, and do not delete the `max(0, …)` clamp on `unfilledSlots`.

## I/O & Edge-Case Matrix

Free Active/Bench Slots `F = max(0, 12 − rosterCount)`; `P = projectedAdditions`; allowance `A = F + 1`.

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Allowance passes (ex. 29) | rc 11, leads 1 non-eligible, bids a 2nd. `F=1, P=2, A=2` | **Passes.** `2 ≤ 2`. Roster Reserve `$1M × max(0, 12−13) = $0` — the clamp doing real work in ordinary play | N/A |
| Allowance spent (ex. 29 tail) | same Team, a 3rd outstanding bid. `F=1, P=3, A=2` | **Refused**, sentence saying the allowance is spent — not that the Team is out of Slots | Refusal sentence |
| Precondition fails (ex. 24, 30) | rc 12, no free minors, $40M cap, non-eligible Player. `F=0, P=1` | **Refused on capacity** before the allowance arithmetic. Counts only, no money in the sentence | Refusal sentence |
| `P = 0` branch (ex. 25) | rc 12, 3 free Minor League Slots, eligible Player. `P=0` | **Passes** on the zero branch, which needs no free Slot. Carve-out unchanged | N/A |
| Eligible overflow (ex. 25 tail) | rc 12, 3 eligible leads, 4th eligible. `Overflow 1, P=1, F=0` | **Refused on capacity**, naming the overflow in counts | Refusal sentence |
| At the ceiling (ex. 23) | rc 11 (+1 IR), no leads, non-eligible. `F=1, P=1` | **Passes**; the Team could hold a second outstanding Bid | N/A |
| Overridden above the ceiling | rc 13 (Commissioner override), non-eligible. `F=0, P=1` | **Refused** — clamp yields `F=0`, precondition fails; never rewarded with an allowance | Refusal sentence |
| Unbound actor | `state.team === null` | Gate **passes**; `rosterCount`, `projectedAdditions`, `freeActiveBenchSlots`, `allowance` and the three Minors counts all `null`; `ceiling` 12 | Real refusal is `unbound_actor` |

</frozen-after-approval>

## Code Map

- `src/lib/core/constants.ts:98` — `ACTIVE_BENCH_SLOTS = 12`. The new allowance constant goes immediately beside it. `CORE_VERSION` at `:147` (AD-20).
- `src/lib/core/types.ts:547` — `SlotsGateOutcome`, plus its doc block at `:507-546` which states the current one-comparison rule and must be rewritten. `CapGateOutcome` at `:471` is **read-only** here.
- `src/lib/core/rules/bidding.ts:1429-1456` — `evaluateSlots`, with its doc block at `:1378-1428`. The only place the pass/refuse comparison lives.
- `src/lib/core/rules/bidding.ts:1022-1024` — `unfilledSlots(rosterCount, projectedAdditions)`. `unfilledSlots(rosterCount, 0)` **is** Free Active/Bench Slots; reuse it rather than writing a second clamped subtraction.
- `src/lib/core/rules/bidding.ts:1225-1231` — `projectedAdditionsFor`; `:1083-1090` — `minorsCountsFor`. Both **unchanged**, both called by each gate.
- `src/lib/core/rules/bidding.ts:1841-1871` — `gateSentence` `case 'slots'`: refusal sentence, `null` when passed; overflow clause `:1857-1863`. `:2291-2306` — `gateFigure` `case 'slots'`: the row figure, one branch serving pass and refusal today.
- `src/lib/core/rules/bidding.ts:2433-2445` — `bidGateReport`; `:2649-2700` — `bidControlState`. Both consume the two above and need **no edit**.
- **Read-only evidence — blast radius is the core.** No production code outside `rules/bidding.ts` reads a `SlotsGateOutcome` field. `src/lib/components/RefusalPanel.svelte:119-128`, `src/lib/core/positions.ts:322` and `src/routes/auction/[fantraxPlayerId]/+page.svelte:410-412,926,949` consume only the already-worded `chip`/`figure`/`detail` strings. `src/lib/core/board.ts` runs no gate at all (`viewerStateFor` at `:388-411` is fold data only).
- `tests/core/bidding.test.ts:1990-2241` — the `evaluateSlots` suite, with a block-local `team()` builder at `:1992-2016` feeding exported `bidStateFor`. Existing sentence assertions at `:2151-2152`.
- `tests/examples/example-{18..25}-*.test.ts` — one file per example, `describe('§10 example N — gist')`. 23/24/25 are `example-23-ir-does-not-fill-the-twelve`, `example-24-full-roster-ends-non-eligible-bidding`, `example-25-the-full-roster-can-still-stash`. Each file builds its own local fixture; there is no shared builder and no snapshot mechanism.
- `tests/server/auction-page.test.ts:1049` — asserts `'Roster Capacity of 12'`; the precondition wording must keep that substring true.
- PRD §10 examples 23–25 and 29–30 (`_bmad-output/planning-artifacts/prds/prd-BBSL-Appspiration-2026-08-16/prd.md:844-870`) are already amended and are the executable specification (AD-25).

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/constants.ts` -- add `OUTSTANDING_BID_ALLOWANCE = 1` beside `ACTIVE_BENCH_SLOTS`, documenting that it is the *one* extra Bid FR-37 permits and never a thirteenth Slot -- the AC forbids an inline literal.
- [x] `src/lib/core/constants.ts` -- bump `CORE_VERSION` 1 → 2 -- AD-20: this is the first Epic 10 change that alters a rule outcome, so events written after it must be distinguishable. Later Epic 10 stories must **not** bump it again.
- [x] `src/lib/core/types.ts` -- add `freeActiveBenchSlots: number | null` and `allowance: number | null` to `SlotsGateOutcome` and rewrite its doc block to state the two-branch rule, the precondition-before-arithmetic ordering, and why `ceiling` is still reported -- the shape is the contract the wording and the tests both read.
- [x] `src/lib/core/rules/bidding.ts` -- rewrite `evaluateSlots`' comparison and doc block: derive `freeActiveBenchSlots = unfilledSlots(team.rosterCount, 0)`, `allowance = freeActiveBenchSlots + OUTSTANDING_BID_ALLOWANCE`, and pass when `projectedAdditions === 0 || (freeActiveBenchSlots >= 1 && projectedAdditions <= allowance)`; null the two new fields with the existing ones on the no-Team branch -- one comparison, one place.
- [x] `src/lib/core/rules/bidding.ts` -- split `gateSentence`'s `slots` case into the two refusal sentences (precondition, allowance-spent), keeping the existing overflow clause and the `'Roster Capacity of 12'` phrasing in both -- UX-DR32 requires they never collapse.
- [x] `src/lib/core/rules/bidding.ts` -- give `gateFigure`'s `slots` case its three forms and document why the one-branch rule no longer holds -- the row now states one of three *different arithmetics*, not one arithmetic with two outcomes.
- [x] `tests/core/bidding.test.ts` -- extend the `evaluateSlots` suite to cover every I/O Matrix row, asserting the two new fields on a pass and both refusals, and the three distinct sentences -- the matrix is the gate's contract.
- [x] `tests/examples/example-29-*.test.ts`, `tests/examples/example-30-*.test.ts` -- add as new named `§10 example N — gist` files following the existing one-file-per-example convention; 30 must also assert the counterfactual arithmetic that would have admitted the Bid without the precondition.
- [x] `tests/examples/example-23|24|25-*.test.ts` -- rewrite 24 and 25 against the new wording and add 23's capacity clause (`F=1`, so `1 ≤ 1 + 1` and a second outstanding Bid is available) -- keep 24's negative assertions that no money appears in a capacity refusal.
- [x] `tests/examples/example-{18..22}-*.test.ts`, `tests/server/auction-page.test.ts` -- re-verify unchanged and repair only assertions the new wording genuinely invalidates -- AD-25 requires the block re-checked, not only the ceiling cases.

**Acceptance Criteria:**
- Given the slots gate's signature, when the implementation is complete, then `SlotsGateOutcome` still carries no money field and `evaluateSlots` still takes no amount.
- Given any bound Team, when the gate is evaluated, then the outcome carries `rosterCount`, `projectedAdditions`, `freeActiveBenchSlots`, `allowance` and `ceiling` of 12 — on a pass and a refusal alike.
- Given a refused Bid, when the refusal panel words it, then exactly one of the two refusal sentences appears, and the allowance sentence and the precondition sentence are never the same string.
- Given a Team at its allowance, when the Auction page renders its bid control, then `bidControlState` blocks it with the allowance sentence as its `detail`, distinct from the precondition sentence a Team with no free Slot receives — so both are known before submission rather than at it.
- Given the `+ 1`, when the source is searched, then it appears only as `OUTSTANDING_BID_ALLOWANCE` in `constants.ts`.
- Given `npm test`, when the suite runs, then it is green, §10 examples 29 and 30 exist as named tests, and 18–25 all pass.

## Design Notes

**Why `unfilledSlots(rosterCount, 0)` rather than a new function.** Free Active/Bench Slots is the same clamped subtraction Roster Reserve already does, evaluated with no additions. Reusing it keeps one expression, and keeps the clamp — which is what stops a Commissioner-overridden Team at Roster Count 13 from computing a negative `F`, an allowance of 0, and passing the precondition by arithmetic accident.

**The clamp is now reachable in ordinary play.** `unfilledSlots`' doc block currently says the `max(0, …)` is kept only because an override could exceed 12. Example 29 reaches `max(0, 12 − 13)` with no override at all. Both `unfilledSlots` and `evaluateCap` say the old thing in prose and must be corrected, or the next reader trusts a comment that is false.

**Three sentences, three arithmetics** (UX-DR32 wording; keep `Roster Capacity of 12` in both refusals):

```
passed      figure: your 2nd of 2 permitted bids; Roster Count would be 10 of 12
refused (A) this would be your 3rd outstanding bid; 1 free Active/Bench Slot permits 2
refused (P) no free Active/Bench Slot, so no bid on this Player is permitted
```

`allowance` stays the raw `F + 1` even when `F = 0`, because example 30's lesson *is* that counterfactual arithmetic. The precondition sentence must therefore never quote it — quoting "1 permitted" while permitting none is the failure that wording exists to avoid.

## Verification

**Commands:**
- `npm test` -- expected: green. Vitest, `package.json:21` (`vitest run`).
- `npx vitest run tests/examples` -- expected: examples 18–25 and 29–30 all pass.
- `npm run check` -- expected: no errors; the two new non-optional fields must be present on every `SlotsGateOutcome` literal.
- `grep -rn "+ 1" src/lib/core/rules/bidding.ts` -- expected: no occurrence expressing the allowance; only `OUTSTANDING_BID_ALLOWANCE`.

## Suggested Review Order

**The rule**

- The whole change in one expression: two branches, precondition before arithmetic.
  [`bidding.ts:1503`](../../src/lib/core/rules/bidding.ts#L1503)

- Free Slots reuse Roster Reserve's clamped subtraction rather than a second one.
  [`bidding.ts:1498`](../../src/lib/core/rules/bidding.ts#L1498)

- The `+ 1`, named once, with why the precondition makes it safe.
  [`constants.ts:121`](../../src/lib/core/constants.ts#L121)

**The contract**

- Why `allowance` stays raw at `F = 0`, and why the refusal must not quote it.
  [`types.ts:601`](../../src/lib/core/types.ts#L601)

- Counts filled slots only — the asymmetry that is example 29's mechanism.
  [`types.ts:589`](../../src/lib/core/types.ts#L589)

**The wording**

- Precondition refusal: no free Slot, so the allowance never applies.
  [`bidding.ts:1942`](../../src/lib/core/rules/bidding.ts#L1942)

- Allowance refusal: a different fact, a different remedy, never collapsed.
  [`bidding.ts:1960`](../../src/lib/core/rules/bidding.ts#L1960)

- The row's four forms, and why one branch no longer serves.
  [`bidding.ts:2452`](../../src/lib/core/rules/bidding.ts#L2452)

- Ordinals, with the caller invariant that makes `0th` unreachable.
  [`bidding.ts:1993`](../../src/lib/core/rules/bidding.ts#L1993)

**Operational**

- AD-20: the first Epic 10 change altering an outcome. Bumped once, here.
  [`constants.ts:181`](../../src/lib/core/constants.ts#L181)

**Tests**

- The allowance passing, and the precondition tested before the arithmetic.
  [`bidding.test.ts:2024`](../../tests/core/bidding.test.ts#L2024)

- Deliberate behaviour change: an overridden Team may still stash.
  [`bidding.test.ts:2586`](../../tests/core/bidding.test.ts#L2586)

- Guards the 11–13 branch; mutation-verified to fail without it.
  [`bidding.test.ts:2493`](../../tests/core/bidding.test.ts#L2493)

- The zero branch prints the bare figure, never `your 0th of 3`.
  [`bidding.test.ts:2565`](../../tests/core/bidding.test.ts#L2565)

- The allowance in ordinary play, and the third bid refused.
  [`example-29:98`](../../tests/examples/example-29-the-allowance-in-the-ordinary-case.test.ts#L98)

- The counterfactual arithmetic the precondition overrules.
  [`example-30:86`](../../tests/examples/example-30-the-allowance-needs-a-slot-to-extend.test.ts#L86)
