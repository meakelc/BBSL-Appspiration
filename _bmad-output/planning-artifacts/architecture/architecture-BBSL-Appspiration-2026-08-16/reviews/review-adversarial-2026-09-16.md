# Adversarial Divergence Review — ARCHITECTURE-SPINE.md (2026-09-16 amendment)

**Lens:** construct two units, one level down, each obeying every cited AD to
the letter, that still build incompatibly.

**Scope actually attacked:** AD-32's new Drop-conversion clause and its
reconstruction-fold bullet, AD-25's retired-example rule, and the boundary
between them. Grounded against `src/lib/core/rules/roster-drop.ts`,
`src/lib/server/roster-drop.ts`, `src/lib/core/projection/contracts.ts`,
`src/lib/core/rules/roster-act.ts`, `src/lib/core/rules/roster-import.ts`, and
`tests/examples/example-41-retired-*.test.ts`.

---

## Finding 1 (CRITICAL) — The reconstruction fold has no stated answer for a
## historical `DropRecorded` event, and a real one already exists in the log

**The spine's own words.** AD-32's new clause:

> "The Drop conversion reads the charge and nothing else... Nothing in the
> conversion branches on `RosterSlotKind`, on the rookie-scale round, or on
> the remaining term; **row removal is *derived* — the charge was `$0` —
> never decided.**"

AD-32's second bullet, unchanged by the amendment, is what actually consumes
`DropRecorded` after the fact:

> "AD-5's rebuild, AD-21's restore and AD-3's synthetic-clock replay... **They
> reconstruct roster state at a given `seq`** by taking the last full
> reference-data snapshot... and **folding every reference-data-mutation
> event forward from it in `seq` order: `RosterMoveRecorded`,
> `RosterRearranged`, `DropRecorded`, the FR-38 eligibility events, and the
> FR-32 Cap Space adjustments.**"

Neither bullet says what "folding a `DropRecorded` event forward" *means*:
whether the fold trusts the payload's own `removed`/`deadMoney`/
`chargedCapHit` fields verbatim (the posture AD-31 states elsewhere — "the
decision is made once... the fold is then a read" — and the posture
`contractsReducer` actually uses for `RosterMoveRecorded`'s `capHitAfter`),
or whether it **re-derives** `removed`/`deadMoney` by re-running today's
conversion (`chargeOf(row)`) against the row the event names, because
AD-32's own new sentence says the amount is "derived... never decided" and
doesn't scope that sentence to the live write path only.

**This is not hypothetical.** AD-32 itself records that the pre-amendment
rookie-scale exception "fired once in production... (Washington,
2026-09-16)", and `roster-drop.ts`'s header and the retired example's test
file both name the same incident (`Malique Lewis`, $1,000,000). That means
`auction_events` already holds (or will already hold, once this Drop is
committed) a `DropRecorded` payload with `removed: true, deadMoney: $0` for a
row whose `chargedCapHit` under **today's** rule is $1,000,000, not $0.

**Unit A — "the restore rehearsal" (AD-21).** Built to obey AD-21's
"rehearsed restore" requirement and AD-32's second bullet literally: it reads
`DroppedContract.removed` and `.deadMoney` off the `DropRecorded` payload and
applies them as-is, because that is what AD-31 already established as this
architecture's convention for "decide once, fold reads," and because
`contractsReducer`'s own `RosterMoveRecorded` case already does exactly this
(`capHit: transfer.capHitAfter`, never recomputed). For the Washington event,
Unit A's reconstruction removes the row and reproduces Cap Space +$1,000,000
at that historical instant.

**Unit B — "the AD-5 rebuild-and-verify job."** Built to obey AD-32's Drop
clause literally, on the reading that "row removal is derived — the charge
was $0 — never decided" is a general invariant of how this system computes a
Drop's outcome, not a clause scoped to `evaluateDrop`'s call site — nothing
in AD-32 says otherwise. Unit B recomputes `deadMoneyFor`/`removed` at fold
time by calling today's `chargeOf(row)` against the row the event names. For
the same Washington event, Unit B's reconstruction **keeps** the row as
Dead Money charging $1,000,000, because current rules produce a non-zero
charge for that Contract.

**Incompatible outcome.** The same `seq`, the same event log, the same
reference-data snapshot — AD-5's own determinism bar — produce two different
worlds depending on which team built the shared reconstruction fold: one
Team's historical Cap Space is $1,000,000 higher than the other's for every
instant after that Drop. AD-19 treats exactly this class of disagreement as
alarm-worthy ("a projection-integrity check disagrees with a rebuild"); if
Unit A is the live-adjacent path and Unit B is the nightly integrity check
(or vice versa), the two halves of this architecture's own monitoring
disagree with each other about a real, already-recorded event, which either
pages the operator on a phantom corruption or — worse — trains them to
ignore a page that means something else next time.

**Close it with:** an explicit sentence on AD-32's second bullet (or a new
AD-32 clause) stating the reconstruction fold reads `DropRecorded`'s
`removed`/`deadMoney`/`chargedCapHit` fields **verbatim**, exactly as it
already must for `RosterMoveRecorded`'s `capHitAfter` — and never re-runs
`chargeOf` against a historical row under current rules. That single
sentence would have made Unit B's reading non-compliant instead of merely
one of two equally-literal readings.

---

## Finding 2 (HIGH) — AD-25's retired-example rule doesn't mandate the one
## assertion AD-32 says it's relying on

AD-25's general rule for a retired example:

> "A **retired** example keeps its number, its file and its place in the
> suite... it asserts whatever outcome the surviving rules now produce, and
> says in its own header what it used to assert and why that stopped being
> true."

That's the whole rule: number, file, place, current-outcome assertion,
header narration. Nothing in it requires the retired test to still exercise
the *original* distinguishing input.

AD-32, amended the same day, leans on a much narrower claim about the
concrete file that resulted:

> "**The `2RK` designation still survives the import and now decides
> nothing**, so **example 41's parse assertion is the only thing pinning**
> that `2RK31` and `2031` stay distinguishable end to end..."

**Unit A — the example actually built**
(`tests/examples/example-41-retired-the-three-characters-decide-nothing.test.ts`)
keeps a `2RK31`-shaped fixture and adds a dedicated `it(...)` block
(lines 151–175) that round-trips `parseRosterCsv` on a `2RK` cell and a
plain-year cell and asserts `rookieScaleRound` still parses to `2` versus
`null`. This is the assertion AD-32 is referring to.

**Unit B — an equally AD-25-compliant retirement.** A second builder,
reading only AD-25 (the rule that actually governs "what makes a retirement
valid"), retires example 41 by keeping its number and file and rewriting its
body to assert today's Drop outcome using a *generic* Active/Bench fixture —
structurally identical to example 40's, with no `2RK` cell anywhere, because
nothing in AD-25 says the retired example must still touch the CSV parser at
all; the "outcome the surviving rules now produce" is a Cap/Maximum-Bid
figure, not a parse result. This file satisfies AD-25 to the letter and
contains no parse assertion.

**Incompatible outcome.** Under Unit B, AD-32's claim ("example 41's parse
assertion is the only thing pinning that `2RK31` and `2031` stay
distinguishable end to end") is simply false — there is no parse assertion,
and nothing in the suite fails if a later change to
`adapters/fantrax/roster-file.ts` silently collapses `rookieScaleRound`
parsing. AD-32 depends on content that AD-25 does not require, so two
builders each fully honoring the AD that governs retirement can produce a
retired example 41 that is compliant and a retired example 41 that leaves
AD-32's stated regression guard unpinned — the exact failure mode AD-25's
own three-strikes history (§ "the two contradictions," the 18–17 pass, the
29–35 pass) says this AD exists to prevent, now reproduced one level down
from the AD itself.

**Close it with:** either fold the parse-survival requirement into AD-32's
own text as a binding test obligation on `roster-file.ts` (independent of
AD-25's retirement wording), or add a clause to AD-25 that a retirement
carrying a load-bearing claim in another AD must preserve whatever assertion
that AD names, not merely "the outcome the surviving rules now produce."

---

## Finding 3 (HIGH) — `core/projection/contracts.ts` already documents the
## rule AD-32 just deleted, and is a plausible source for Finding 1's Unit B

Two docblocks in `src/lib/core/projection/contracts.ts`, both un-amended by
the 2026-09-16 pass, still state the retired rule as current:

`DroppedContract`'s docblock (lines 523–530):

> "**`deadMoney` and `removed` are ONE decision stated twice, not two.**
> `rules/roster-drop.ts` computes `deadMoney = releases2RK ? $0 :
> chargedCapHit(row)` and removes the row if and only if that amount is
> `$0`... a full-term second-round rookie deal is released to `$0` by
> FR-43's exception..."

and `DropRecordedPayload`'s docblock (lines 537–541) repeats "the two facts
FR-43's exception turned on."

`roster-drop.ts` itself (the module these docblocks describe) now says the
opposite in its own header: "**There is no rookie-scale exception, and its
absence is the rule.**" `contractsReducer` has no `DropRecorded` case at
all — nothing currently *executes* against the stale text — but it is the
first and most natural place a future builder would read to learn "how is
`DroppedContract.deadMoney` decided," because it is where the type is
declared and documented, and it is exactly the module a builder implementing
Finding 1's reconstruction fold would open.

**Incompatible outcome, concretely.** A builder implementing the AD-32
reconstruction fold (Finding 1) who reads `contracts.ts`'s own docblock
rather than `roster-drop.ts`'s would copy the `releases2RK ? $0 :
chargedCapHit(row)` formula into the fold in good faith — reproducing
Finding 1's Unit B divergence for a mundane documentation reason rather than
a subtle architectural one. This is evidence the divergence in Finding 1 is
not a remote edge case: the codebase already contains a written, plausible,
wrong instruction for how to build it.

AD-25 requires a rule change to "change the PRD in the same commit" for the
§10 examples; nothing analogous binds sibling-module doc comments to an AD
amendment, which is exactly how this drifted one commit at a time.

**Close it with:** correct the two stale docblocks in the same pass as any
future AD-32 amendment (or now), and consider a spine convention requiring
"AD amendment" commits to grep for restatements of the retired rule in
`core/` docblocks, not only in PRD §10.

---

## Finding 4 (MEDIUM) — "removed" vs "reclassified" is only distinguishable
## today because exactly one consumer reads the payload

AD-32 states Dead Money "charges in full and counts toward no ceiling," and
`chargedCapHit` "already returns the right value for it by falling through"
(`roster-import.ts:78-80`). The live write path (`server/roster-drop.ts`)
applies `release.removed` to choose `DELETE` vs `UPDATE` against the same
`released[]` array that built the event payload, in the same transaction —
so *today*, payload and table cannot disagree, and this is good engineering,
not a hole.

But that guarantee is structural only because `contractsReducer` explicitly
declines to fold `DropRecorded` at all (its docblock: "there is deliberately
NO `contractsReducer` case for it"), and the only other reader is Finding 1's
not-yet-built reconstruction fold. AD-32 never states a canonical in-memory
representation for "a release" independent of `team_rosters`' own shape
(present-with-dead_money vs absent). The moment a second consumer of
`DropRecorded` is added — the FR-42 divergence detector reading historical
Drops, for instance, which AD-32's own text says is a real, if contingent,
capability — that consumer inherits Finding 1's ambiguity fresh, because
nothing in AD-32 says whether "removed" is a fact about a row's *existence*
or a fact that must be re-derived from `chargedCapHit` at read time.

**Close it with:** the same sentence recommended for Finding 1 also
discharges this — pin the payload as authoritative for any consumer, present
or future.

---

## Not found to be a hole (checked, cleared)

- **Dead Money dropped/traded/re-placed twice.** `movable()` in
  `roster-act.ts` (`row.rosterSlotKind !== 'dead_money'`) is the single
  shared gate `roster-drop.ts`, `roster-trade.ts` (line 349) and
  `roster-rearrange.ts` (line 399) all call before acting on a row. All
  three refuse a `dead_money` row outright. No path was found by which a
  Dead Money row is dropped, traded or moved a second time.
- **Event payload vs mutated table disagreeing on the live write path.**
  `recordDrop` in `server/roster-drop.ts` builds both the event payload and
  the `DELETE`/`UPDATE` statements from the identical `released[]` array
  inside one transaction (lines 328–364). No divergence is reachable there.

---

## Summary of holes to close

1. Pin whether the AD-32 reconstruction fold trusts `DropRecorded`'s
   recorded fields or re-derives them — CRITICAL, and there is already a
   real production event (Washington / Malique Lewis, $1,000,000) that
   makes the two readings produce different historical Cap Space.
2. Either move the "`2RK` still parses" obligation into AD-32's own binding
   text or extend AD-25 to require a retirement preserve any assertion
   another AD names as load-bearing — HIGH.
3. Correct `contracts.ts`'s two stale docblocks (lines 523–530, 537–541),
   which currently document the retired rookie-scale exception as live —
   HIGH, and a plausible real-world route to Finding 1's divergence.
4. State a canonical, payload-independent meaning for "removed" before a
   second consumer of `DropRecorded` is built — MEDIUM.
