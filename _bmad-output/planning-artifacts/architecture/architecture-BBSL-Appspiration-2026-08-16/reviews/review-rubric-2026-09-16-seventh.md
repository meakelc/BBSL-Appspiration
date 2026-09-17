# Rubric Review — ARCHITECTURE-SPINE.md (seventh pass, FR-15 bid retraction)

Reviewed against: good-spine checklist (7 items), with mandatory consistency checks (a) PRD §10 example count across four locations, (b) `tests/examples/` file count vs AD-25's stated arrears.

## Consistency check (a) — PRD §10 example count, four locations

| Location | Line | Text |
| --- | --- | --- |
| Frontmatter `binds` | 14 | `'Rule resolution examples 1–54 (PRD §10)'` |
| AD-25 Binds | 245 | `PRD §10 examples 1–54` |
| AD-25 Rule | 247 | `each of the 54 examples exists as a named test` |
| Source Tree code block | 532 | `# PRD §10 examples 1-54, one test each (AD-25)` |

**Result: PASS.** All four now read 54, consistently, for the first time in the recorded history of four prior passes each advancing only three of four. Cross-checked against the PRD itself: `_bmad-output/planning-artifacts/prds/prd-BBSL-Appspiration-2026-08-16/prd.md` §10 runs examples 1–54 inclusive (41 retired-but-numbered, 47–54 added 2026-09-16), so 54 is also the correct count against the source, not merely an internally-consistent wrong number.

## Consistency check (b) — AD-25's arrears claim vs `tests/examples/`

AD-25's last bullet (line 254) claims: *"tests/examples/ holds 45 files: examples 47–54 have none, and example 12 has none... nine tests in arrears."*

Counted `C:\Users\meake\Documents\Sites\BBSL-Appspiration\tests\examples\*.ts`: **45 files**, exactly. Cross-referencing filenames against example numbers 1–46 (examples 47–54 have no files by construction, not yet reached), the only number in 1–46 with no corresponding file is **12** (`example-12-*` absent) — every other number 1–46 (including the retired `example-41-retired-...test.ts`) has a file. That is 45 files covering {1–46} minus {12}, plus zero files for {47–54}: 9 examples with no test (12, 47, 48, 49, 50, 51, 52, 53, 54).

**Result: PASS.** The document's own account of the gap is accurate on both the file count (45) and the specific missing numbers (12 and 47–54, nine total).

## Findings

1. **[Medium] AD-13's "Prevents" line was not extended to cover the harm its own new Rule names.** AD-13's Prevents bullet (line 159) still reads only *"a resume after an indeterminate outage silently resolving auctions that should still be open, and a sweep closing auctions nobody could bid on."* The 2026-09-16 addition (line 161) introduces a materially different harm — a derived Retraction Window that "**drains across the pause** — expiring while the Manager is locked out of acting on it, which is this product taking a remedy away from someone for a reason wholly outside their control" — and writes a new Rule specifically to prevent it. Per rubric item 2, an AD's Rule should map to its own Prevents claim; here the Rule was added but the Prevents line was left describing only the pre-existing two harms, so a reader auditing "what does AD-13 protect against" from the Prevents line alone would miss this clause's entire purpose.

2. **[Medium] AD-22's "Prevents" line likewise does not name the failure mode its newest bullet exists to stop.** AD-22 Prevents (line 221) reads *"an event-fold that resets the phase clock on every event, extending the Auction Phase by up to 48 hours."* The 2026-09-16 bullet (line 225) is explicit that it is not that failure mode: it exists because otherwise "a Team [could hold] the Auction Phase open **indefinitely and for free**" via a retract/rejoin loop on a $1,000,000 lottery — an unbounded stall, not a bounded 48-hour extension. The bullet even flags the risk of this being mis-implemented as a rate limit precisely because reviewers reading only the Prevents line would categorize it wrong. The Prevents line should name the unbounded-stall class alongside the bounded-extension class it already names.

3. **[Low] AD-6's Binds line enumerates mutating-transaction types and was not updated for the new command.** AD-6 Binds (line 102) reads: *"every state-mutating transaction — bid, nomination, close, draw, override, phase change."* AD-31's new retraction bullet (line 313) states a retraction "appends its own event, in its own transaction **under the AD-6 lock**." The general Rule text ("every mutating transaction calls `pg_advisory_xact_lock`...") is broad enough to cover it, so this is not an enforceability gap, but the illustrative Binds list — which the amendment touched extensively elsewhere (AD-2, AD-12, AD-13, AD-22, AD-25, AD-31) — was not brought current here, leaving "retraction" (and, pre-existing, "cancellation"/"restoration") absent from the one place a story author might scan for "which transaction types take this lock."

4. **[Low] Frontmatter `scope` line was not amended for FR-15, unlike every other amendment surface.** Line 7's scope list — *"Fantrax CSV import, identity, nomination, bidding and cap enforcement, clocks and contention, the bid board, notifications, contract assignment, export, commissioner controls and audit"* — has no entry for bid retraction, even though the frontmatter `binds` line, the Source Tree, and the Capability map were all touched for this amendment. Retraction is arguably covered under "bidding," but every other prior rule-bearing FR (cancellation, trades, moves) is also not separately named in scope, so this may be house style rather than an omission — flagged for the author to confirm rather than asserted as a defect.

5. **[Low] No sequence diagram documents the RetractBid transaction shape.** The Structural Seed provides sequence diagrams for "Bid acceptance," "Import," and "The tick" (lines 429–504), but none for retraction, despite `RetractBid` being introduced as a fifth command type with its own transaction (AD-31: "a retraction... appends its own event, in its own transaction under the AD-6 lock," reading the recorded restoration rather than re-deriving it, distinct in shape from a cancellation). The shape is fully specified in AD-31's prose, so this is a completeness/discoverability gap for implementers rather than a missing decision.

## Items checked and clear

- AD-2's command-type ordering ("PlaceBid... first, RestoreLeadingBid... second, a Roster Trade... third and a Roster Move... fourth") is internally consistent with AD-32's own count ("a Trade is the third, declared in `core/types.ts`... and a Roster Move a fourth") and with AD-31's "one restorer, three callers" (void, cancellation, retraction).
- AD-31's "four figures" cut-short baseline (Cap Space, Committed Bids, Roster Count, Minor League occupancy) is consistent with the PRD §12 assumptions index's "four restoration figures" language and with AD-2's cross-reference to "the four figures against the baseline AD-31 records."
- AD-12's new retraction bullet's claim that the window is unreachable in Standard Contention "because a Bid resets the Clock to 24 hours" matches PRD §10 example 53's own final sentence verbatim in substance.
- The codebase has no `core/rules/retract.ts` yet (checked `src/lib/core/**/*.ts`), consistent with the PRD's own statement that "nothing had been built when this was written" — not a brownfield contradiction, since the feature is pre-implementation.
