---
title: 'Story 10.2 — Lottery entries leave the slots gate'
type: 'feature'
created: '2026-09-08'
status: 'done'
review_loop_iteration: 0
baseline_commit: '4dd394d21bd32daf3b210008300a0cd958ba91b5'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-10-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A Minimum-Bid Contention entry currently reaches `projectedAdditionsFor` like any other lead, so a Team with one free Slot may hold at most two lotteries and then idles — rationing entries against an outcome it will probably lose. FR-18 and FR-37 were rewritten on 2026-09-08 to exempt entries from Roster Capacity entirely, gating them only on the win having somewhere to land, with cap space the sole quantitative limit.

**Approach:** Mark each `LeadingBidElsewhere` as a contention entry where `teamMoneyStateFor` already tests the contention state, then split the one overflow derivation into two named ones: `Overflow Count` (money side, entries included, unchanged) and `Active/Bench Overflow` (slots side, entries excluded). `projectedAdditionsFor` reads the slots-side figure and drops entries from its lead count. `evaluateSlots` gains an entry branch — FR-18's landing test — selected from the contention gate's own `entry` verdict rather than from an amount.

## Boundaries & Constraints

**Always:**
- The slots gate still takes no amount and `SlotsGateOutcome` still carries no money field. It learns "this Bid is an entry" only from `ContentionGateOutcome.entry`, a classification another gate already produced — never by comparing an amount itself.
- Both gates are still evaluated on every Bid and neither short-circuits the other (AD-7). The contention gate's verdict is an *input*, not a skip.
- The two overflow figures are **two separately named derivations**, each documenting which rule it serves. `evaluateCap` keeps `minorsCountsFor` exactly as it is.
- An entry is permitted iff `freeActiveBenchSlots >= 1` **or** (`playerIsMinorLeagueEligible` **and** `freeMinorLeagueSlots >= 1`). Roster Count, the allowance and `projectedAdditions` never bear on it.
- Every slots evaluation still reports `rosterCount`, `projectedAdditions`, `freeActiveBenchSlots`, `allowance` and `ceiling` of 12, on a pass and a refusal alike. The nullable fields stay null together for an unbound actor.
- The four refusal/pass wordings stay four distinct strings; both capacity refusals keep the substring `Roster Capacity of 12`.

**Ask First:**
- Any change to `evaluateCap`, `CapGateOutcome`, `minorsCountsFor`, `unfilledSlots`, `teamMoneyStateFor`'s eligible/non-eligible partition, or to a §10 example test numbered 1–22 or 26–33 beyond a mechanical fixture update.

**Never:**
- Do not bump `CORE_VERSION` — Story 10.1 already bumped it 1 → 2 for this epic (AD-20).
- Do not touch `rules/close.ts`, cancellation, restoration, or `projection/auctions.ts` — Stories 10.3–10.5.
- Do not add the strip figure (UX-DR35) or the Teams-index entry column (UX-DR36) — Story 10.6.
- Do not treat a bid on an `awaiting_opening_bid` Auction as an entry: the gate cannot see the amount there, and the ordinary allowance rule is the safe reading.

## I/O & Edge-Case Matrix

`F` = free Active/Bench Slots, `M` = free Minor League Slots, `P` = projected Active/Bench additions (slots side).

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Six entries on one Slot (ex. 34) | rc 11 (`F=1`), `M=0`, entries on five non-eligible lotteries, joining a sixth | **Passes.** Entry branch: `F>=1`. `P=0` — entries contribute nothing. The tenth is refused by the **cap** gate, never by slots | N/A |
| Entry with no landing place | rc 12 (`F=0`), `M=0`, joining a non-eligible lottery | **Refused on capacity**, entry sentence: the win has nowhere to land. Not the allowance sentence | Refusal sentence |
| Eligible entry at a full roster (ex. 35) | rc 12 (`F=0`), `M=1`, joining an eligible lottery; two eligible entries already held | **Passes** on the eligible branch. Money side still sees `N=3, M=1, Overflow Count 2`; slots side sees `Active/Bench Overflow 0` | N/A |
| Entries do not spend the allowance | rc 11 (`F=1`), one non-eligible lead **and** four entries, bidding a second non-eligible Player | **Passes.** `P = 1 + 1 = 2 <= 2`; the four entries are not counted | N/A |
| Conversion is not an entry | rc 11 (`F=1`), two non-eligible leads, bidding $5,000,000 into a live lottery (`entry: 'converts'`) | **Refused at the allowance** — a conversion takes an Active/Bench commitment. `P = 3 > 2` | Refusal sentence |
| Opening at the minimum | `contention: 'awaiting_opening_bid'`, amount $1,000,000 | Gated as an **ordinary bid** — the gate cannot see the amount. Documented boundary, not a defect | Existing sentences |
| Unbound actor | `state.team === null` | Gate **passes**; all count fields `null` together; `ceiling` 12 | Real refusal is `unbound_actor` |

</frozen-after-approval>

## Code Map

- `src/lib/core/rules/bidding.ts:402-406` — `LeadingBidElsewhere`. Gains `isContentionEntry: boolean`; its doc block at `:390-401` states why a name and an amount were not enough.
- `src/lib/core/rules/bidding.ts:611-645` — `teamMoneyStateFor`'s loop. `contends` at `:628-630` and `auction.contention === 'minimum_bid'` at `:635` are **already** the fact needed; set the flag from the same test, above the eligible/non-eligible partition at `:641-642`. That partition is unchanged.
- `src/lib/core/rules/bidding.ts:1059-1103` — `minorsCountsFor`, the **money** side. Unchanged; only its doc block gains the sentence naming what it is now *not*.
- `src/lib/core/rules/bidding.ts:1225-1245` — `projectedAdditionsFor` and the doc block at `:1199-1224`. Both edits land here: filter `leading` by `!isContentionEntry`, add `1` only when the Player is not eligible **and** this Bid is not an entry, and read the new slots-side overflow. The comment at `:1205-1212` claiming the two gates "cannot disagree about the count" is the one AC-3 requires replaced.
- `src/lib/core/rules/bidding.ts:1437` — the same claim restated in `evaluateSlots`' doc block. Must be corrected too, or one of the two lies.
- `src/lib/core/rules/bidding.ts:1475-1520` — `evaluateSlots`. Takes the contention verdict, adds the entry branch before FR-37's two branches, and reports the slots-side figures.
- `src/lib/core/rules/bidding.ts:1620-1640` — the gate literal. `contention` is built at `:1627`, `slots` at `:1638`; hoist the contention outcome into a `const` and pass its `entry` to `evaluateSlots`.
- `src/lib/core/rules/bidding.ts:873-903` — `evaluateContention`. **Read-only.** Its `entry` union (`not_a_contention | joins | already_contending | converts | neither`) is the classification; only `joins` and `already_contending` are entries.
- `src/lib/core/types.ts:570-609` — `SlotsGateOutcome`. `eligibleLeadingBids` and `overflowCount` become `eligibleLeadingBidsExcludingEntries` and `activeBenchOverflow`; a new `isContentionEntry: boolean` records which branch decided. `CapGateOutcome` at `:471` keeps its own `overflowCount` and is **read-only** here.
- `src/lib/core/rules/bidding.ts:1902-1963` — `gateSentence` `case 'slots'`: overflow clause at `:1921-1928`, precondition refusal at `:1941`, allowance refusal at `:1959`. Add the entry refusal and rename the overflow clause's figure.
- `src/lib/core/rules/bidding.ts:2423-2481` — `gateFigure` `case 'slots'`: four forms today, five after this. `ordinal`'s doc block at `:1985-1990` names Story 10.2 by name and its 11–13 justification must be rewritten.
- **Read-only evidence.** No production code outside `rules/bidding.ts` reads a `SlotsGateOutcome` field: `src/lib/components/RefusalPanel.svelte:119-128`, `src/lib/core/positions.ts:322` and `src/routes/auction/[fantraxPlayerId]/+page.svelte:410-412` consume the worded `chip`/`figure`/`detail` only. `bidGateReport` (`:2433`) and `bidControlState` (`:2649`) need no edit.
- `tests/core/bidding.test.ts:1993-2241` — the `evaluateSlots` suite and its block-local `team()` builder at `:1995-2019`, which must learn `isContentionEntry`. Further `TeamMoneyState` literals at `:80, :868, :1415, :1449, :1691, :2648, :3009`.
- `tests/examples/example-21-*.test.ts`, `example-22-*.test.ts` — the existing lottery examples; both build entries and now exercise the two-figure split directly.
- `tests/examples/example-25-*.test.ts:67`, `example-29-*.test.ts:55` — build `LeadingBidElsewhere` literals and need the new field.
- `tests/server/auction-page.test.ts:1049` — asserts `'Roster Capacity of 12'`.
- PRD §10 examples 34 and 35 and the glossary entries for **Active/Bench Overflow** and **Projected Active/Bench Additions** (`_bmad-output/planning-artifacts/prds/prd-BBSL-Appspiration-2026-08-16/prd.md:106,115,411-423`) are the executable specification (AD-25).

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/core/rules/bidding.ts` -- add `isContentionEntry` to `LeadingBidElsewhere` and set it in `teamMoneyStateFor` from the contention test already there -- the slots side cannot exclude what it cannot identify, and re-deriving it downstream would be a second answer to a question this loop already asked.
- [x] `src/lib/core/rules/bidding.ts` -- add the slots-side derivation (`Active/Bench Overflow`) beside `minorsCountsFor`, each doc block naming the rule it serves and why they must now differ -- AC-3; a single shared call is the defect.
- [x] `src/lib/core/rules/bidding.ts` -- rewrite `projectedAdditionsFor` and its doc block: entries excluded from the lead count, the `+ 1` suppressed for an entry, the slots-side overflow read, and the "cannot disagree about the count" comment replaced by one stating why the two figures now must -- AC-3 names that comment explicitly.
- [x] `src/lib/core/types.ts` -- rename `SlotsGateOutcome`'s two minors fields to their slots-side names, add `isContentionEntry`, and document that `CapGateOutcome` keeps the money-side pair -- the shape is what stops the wording quoting the wrong overflow.
- [x] `src/lib/core/rules/bidding.ts` -- give `evaluateSlots` the contention verdict and the FR-18 entry branch, ahead of FR-37's two branches, and correct the doc-block claim at `:1437` -- one branch, one place, and the entry never touches the allowance arithmetic.
- [x] `src/lib/core/rules/bidding.ts` -- hoist the contention outcome in the gate literal and pass its `entry` -- the classification is `evaluateContention`'s single judgement; deriving it twice is what the codebase's one-expression discipline forbids.
- [x] `src/lib/core/rules/bidding.ts` -- add the entry refusal to `gateSentence` and the entry forms to `gateFigure`, rename the overflow clause to `Active/Bench Overflow`, and rewrite `ordinal`'s 11–13 justification -- a refusal telling a Manager their entry spent an allowance would be false.
- [x] `tests/core/bidding.test.ts` -- extend the `evaluateSlots` suite over every I/O Matrix row, including the conversion and the opening-at-the-minimum boundary, and assert the four distinct sentences -- the matrix is the gate's contract.
- [x] `tests/examples/example-34-*.test.ts`, `tests/examples/example-35-*.test.ts` -- add as new named `§10 example N — gist` files; 34 asserts capacity is never the ground and the tenth is refused on money, 35 asserts the eligible branch at `F = 0` and the two overflow figures disagreeing.
- [x] `tests/examples/example-{18..25}-*.test.ts`, `tests/server/auction-page.test.ts` -- re-verify the block and repair only what the split genuinely invalidates -- AD-25 requires 18–25 re-checked together, because which overflow an example means is now a question.

**Acceptance Criteria:**
- Given a Team holding any number of Contention entries, when a Bid's Roster Capacity is evaluated, then `projectedAdditions` counts none of them and the allowance is unspent.
- Given a Contention entry, when it is gated, then it is permitted on a free Active/Bench Slot or an eligible Player with a free Minor League Slot, and refused only when neither holds — with a sentence naming the landing place, not the allowance.
- Given `Overflow Count` and `Active/Bench Overflow`, when the source is read, then they are two named derivations with two doc blocks, and `evaluateCap` still calls the money-side one unchanged.
- Given `evaluateSlots`, when its signature is read, then it takes no amount and `SlotsGateOutcome` carries no money field.
- Given `npm test`, when the suite runs, then it is green, §10 examples 34 and 35 exist as named tests, and 18–25 and 29–33 all pass.

## Spec Change Log

## Design Notes

**Why the contention gate's verdict and not the amount.** `evaluateContention` already answers "is this Bid a lottery entry" as `entry: 'joins' | 'converts' | …` — a classification, not a magnitude. Passing that verdict keeps FR-37's structural property intact (the gate still cannot read a price, still reports no money) while closing the leak a naive `state.contention === 'minimum_bid'` test would open: a $5,000,000 **conversion** into a live lottery is an ordinary Active/Bench commitment, and gating it as an entry would let a Team at its allowance take a third.

**The one boundary that cannot be closed.** An Opening Bid of exactly $1,000,000 opens a lottery, but at evaluation time the Auction is `awaiting_opening_bid` and the amount is invisible to this gate. Such a bid is therefore gated as an ordinary bid — the *stricter* reading, so nothing escapes the ceiling. Every §10 example that matters (34, 35) **joins** an existing lottery, which is the case the rule was written for.

**Two figures, one subtraction apart.**

```
N_money = eligibleLeading.length                 + (eligible ? 1 : 0)
N_slots = eligibleLeading.filter(!entry).length  + (eligible && !thisBidIsEntry ? 1 : 0)
Overflow Count        = max(0, N_money - M)   -> Minors Exposure, evaluateCap
Active/Bench Overflow = max(0, N_slots - M)   -> projectedAdditions, evaluateSlots
```

Example 35 is where they visibly disagree: `Overflow Count 2` against `Active/Bench Overflow 0`, same Team, same instant, both correct.

## Verification

**Commands:**
- `npm test` -- expected: green.
- `npx vitest run tests/examples` -- expected: 18–25 and 29–35 all pass.
- `npm run check` -- expected: no errors; every `SlotsGateOutcome` and `LeadingBidElsewhere` literal carries the new fields.
- `grep -n "overflowCount" src/lib/core/rules/bidding.ts` -- expected: occurrences only on the money path (`minorsCountsFor`, `evaluateCap`, `CapGateOutcome`'s wording), never inside `evaluateSlots` or the slots wording.

## Suggested Review Order

**The rule**

- The whole story in one branch: an entry is gated on landing, not capacity.
  [`bidding.ts:1674`](../../src/lib/core/rules/bidding.ts#L1674)

- The classification, taken from another gate's verdict and never from an amount.
  [`bidding.ts:1638`](../../src/lib/core/rules/bidding.ts#L1638)

- Entries dropped from the lead count and from the Bid being placed.
  [`bidding.ts:1372`](../../src/lib/core/rules/bidding.ts#L1372)

- The slots-side overflow, the half of the split that is new.
  [`bidding.ts:1185`](../../src/lib/core/rules/bidding.ts#L1185)

- The money side, untouched, now saying what it is not.
  [`bidding.ts:1094`](../../src/lib/core/rules/bidding.ts#L1094)

**The fact that makes it possible**

- Set where the loop already asked the contention question.
  [`bidding.ts:661`](../../src/lib/core/rules/bidding.ts#L661)

- Why a name and an amount could not answer it.
  [`bidding.ts:402`](../../src/lib/core/rules/bidding.ts#L402)

**The contract**

- Two named figures on the outcome, so the wording cannot quote the wrong one.
  [`types.ts:669`](../../src/lib/core/types.ts#L669)

- A classification, not a count — so it is not nulled with them.
  [`types.ts:691`](../../src/lib/core/types.ts#L691)

- The money-side pair, and why 10.2 deliberately left their names alone.
  [`types.ts:504`](../../src/lib/core/types.ts#L504)

**The wording**

- The fourth refusal: a landing place lacking, never an allowance spent.
  [`bidding.ts:2113`](../../src/lib/core/rules/bidding.ts#L2113)

- The row's fifth form, shared by the entry's pass and refusal.
  [`bidding.ts:2674`](../../src/lib/core/rules/bidding.ts#L2674)

**The surface**

- Beyond the Code Map, and required: the browser must not gate what the lock does not.
  [`+page.svelte:243`](../../src/routes/auction/[fantraxPlayerId]/+page.svelte#L243)

**Tests**

- The money-side reserve at a Roster Count where the exclusion actually moves it.
  [`bidding.test.ts:2002`](../../tests/core/bidding.test.ts#L2002)

- Entries held beside a real lead, spending none of the allowance.
  [`bidding.test.ts:2848`](../../tests/core/bidding.test.ts#L2848)

- The dead-zone amount, classified as an ordinary Bid rather than an entry.
  [`bidding.test.ts:2960`](../../tests/core/bidding.test.ts#L2960)

- Both gates refusing at once, neither short-circuiting the other.
  [`bidding.test.ts:2924`](../../tests/core/bidding.test.ts#L2924)

- Capacity never consulted; the tenth entry refused on money alone.
  [`example-34:124`](../../tests/examples/example-34-unlimited-lotteries.test.ts#L124)

- The two overflow figures disagreeing, same Team, same instant.
  [`example-35:125`](../../tests/examples/example-35-the-trigger-is-a-free-slot.test.ts#L125)
