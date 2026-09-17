# Rubric Walk — Architecture Spine (2026-09-16 amendment)

Document: `ARCHITECTURE-SPINE.md` (updated 2026-09-16, sixth pass)
Scope: the FR-43 rookie-exception removal amendment, walked against the good-spine checklist.

## Verdict

The amendment itself (AD-25's new bullets, AD-32's new clause) lands cleanly, is enforceable, and is ratified by the shipped code (`src/lib/core/rules/roster-drop.ts`) and by the reconciled PRD. No survivor of the removed exception was found outside the two amended ADs. However the walk surfaced two internal-consistency failures the checklist explicitly asks about — one of them a direct contradiction of AD-25's own enforceable rule — that predate this pass but are still live in the document as it stands today.

## Findings

### 1. HIGH — AD-25's "each of the 46 examples exists as a named test" is false; example 12 has no test file

**Location:** AD-25 Rule, line 242: *"each of the 46 examples exists as a named test calling the core directly — no database, no HTTP, no clock mocking, no fixtures beyond a state literal."*

PRD §10 example 12 ("Nomination slot held by an unbid player," `prd.md:1025`) is a live, non-retired example. `tests/examples/` contains no `example-12-*.test.ts`, and no other test file asserts its scenario — it is only mentioned in passing inside example 33's comment (`tests/examples/example-33-a-restoration-with-nothing-to-restore.test.ts:11`, "the nominating Team's Nomination Slot stays held (§10 example 12)"), which is a citation, not a test of example 12's own claim. Confirmed via `Glob tests/examples/*12*` → no matches, and a content grep for the example's own wording ("Nomination slot held", "unbid player") across `tests/` → no matches.

This is a genuine gap under AD-25's own binding rule, not a documentation nit — the rule is stated as an invariant ("each of the 46... exists"), and it is currently not true. Not introduced by the 2026-09-16 pass, but the pass advanced this AD's counts and bullets without catching it.

### 2. MEDIUM — Source tree comment still says "examples 1-28," not 1-46

**Location:** Source Tree section, line 519: `tests/examples/    # PRD §10 examples 1-28, one test each (AD-25)`

The frontmatter (line 14) and AD-25 itself (lines 240, 242) bind and count 46 examples. This comment is stale from an earlier pass (before examples 29-46 were added) and was not touched by any of the three amendment passes that advanced the count (2026-09-08, 2026-09-10, 2026-09-12, 2026-09-16). This is exactly the class of internal range inconsistency the checklist calls out, just at "28" rather than "43."

### 3. LOW/INFORMATIONAL — AD-32's new Drop clause is enforceable and code-verified (no failure, noted per instructions)

**Location:** AD-32, line 325, "The Drop conversion reads the charge and nothing else."

Checked against `src/lib/core/rules/roster-drop.ts`: the conversion is exactly `deadMoneyFor(row) = chargeOf(row)` (lines 232-234), no branch on `rosterSlotKind`, `rookieScaleRound`, or `contractYearsRemaining`; `rookieScaleRound` is still carried into `DropRecorded` (lines 367-368). The AD's normative core — "nothing branches on X; the whole conversion is one expression; the field is retained but decides nothing" — is a real, falsifiable constraint a builder could violate (e.g., by reintroducing a `rosterSlotKind === 'active_bench' && rookieScaleRound...` check), and the shipped code already obeys it. This clause is not merely narrating history — it binds something checkable. No finding against it.

### 4. LOW/INFORMATIONAL — AD-25's "retired example" rule does not conflict with the 46-count rule, but the word "retired" undersells example 41's role

**Location:** AD-25, lines 242 and 247.

The general rule ("a retired example... is not deleted... it asserts whatever outcome the surviving rules now produce") is consistent with what example 41 actually became: per line 247 and the test file itself (`tests/examples/example-41-retired-the-three-characters-decide-nothing.test.ts`), it now asserts the *same* outcome as example 40 and is explicitly framed as "the regression a reintroduced exception fails against." That is an active regression guard, not an inert record — a stronger role than "retired" usually implies elsewhere in software usage, though the AD's own text anticipates and names this ("the first time this AD's lesson has run in the other direction"). Not a contradiction; flagged only because a future reader skimming "retired" alone could underestimate that this test is load-bearing.

## Survivor check (removed-exception assumptions outside AD-25/AD-32)

Grepped the full spine for `2RK`, `rookie`, `Dead Money`, `dead_money`, `FR-43`, `clears`, `released to`, `Cap Space`. No survivor found: every match outside AD-25/AD-32 is either unrelated (e.g., import-preview "Cap Space" at line 466, the Capability Map's "FR-43" binding at line 538) or is itself part of the amended text. The Capability Map's "one migration (FR-43 only)" (line 538) refers to the Dead Money `RosterSlotKind` migration, which is independent of the removed exception and still correct.

## Cross-artifact check

`prd.md:53-56` confirms the same rule change ("FR-43 has no exception, and never did... a Drop converts the Player's charged Cap Hit into Dead Money, at the same amount") and PRD example 41 (`prd.md:1061`) matches the spine's account figure-for-figure, including the retirement mechanics and the production incident. The spine ratifies rather than contradicts both the PRD and the shipped code.

## File

`C:/Users/meake/Documents/Sites/BBSL-Appspiration/_bmad-output/planning-artifacts/architecture/architecture-BBSL-Appspiration-2026-08-16/reviews/review-rubric-2026-09-16.md`
