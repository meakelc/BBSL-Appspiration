---
title: 'Story 7.6: Dead Money and the rookie-scale designation'
type: 'feature'
created: '2026-09-10'
status: 'done'
review_loop_iteration: 1
baseline_commit: '30a2824acba54fee912de445ed8c2eff8635662f'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A released contract must keep charging the Cap as Dead Money, but `RosterSlotKind` has no fourth member to carry it, and the database forbids one. Separately, `CONTRACT_END_YEAR` (`roster-file.ts:118`) matches the rookie-scale prefix in a **non-capturing** group and discards it, so `2RK31` and `2031` parse to byte-identical rows — the app cannot tell a second-round rookie deal from a plain contract, which is the single fact FR-43's exception turns on.

**Approach:** Admit `'dead_money'` as a fourth `RosterSlotKind` — charging in full by *falling through* the existing `minor_league` check, bounded by nothing, counted by nothing — behind a migration that widens `team_rosters` only. Capture the rookie round from the contract cell so the designation survives import as structured data. Render Dead Money labelled and separate on both team surfaces.

## Boundaries & Constraints

**Always:**
- `chargedCapHit` stays **one expression** (AR-43). `dead_money` gets the full Cap Hit by falling through the `minor_league` ternary — **no new branch, no added condition**.
- `RosterSlotKind` is a **closed union of exactly four members**. Every site that discriminates on it in `core/` and `adapters/` must be **exhaustive with no `default` and no catch-all `else`**, so a missing branch is a compile error.
- The fallthrough sanctioned for `chargedCapHit` is **not** copied as a general pattern to any other consumer.
- Roster Count keeps counting `active_bench` **alone** — that is what makes Dead Money free a Slot and keep the money in one change.
- Schema change is a **migration file applied dev-first** (AD-26). Nothing typed into the Supabase dashboard.
- All Fantrax knowledge stays inside `adapters/fantrax/` (AD-24).
- An unrecognised contract shape or roster status still **refuses the row and names it**, unchanged.

**Ask First:**
- Any change to `import_staged_rosters_roster_slot_kind_check`. It must stay at **three** kinds — see Design Notes. Widening it silently makes Dead Money importable and breaks the last AC.
- Any change to `chargedCapHit`'s shape beyond leaving it untouched.
- Adding a `contractYearsRemaining`-derived "is full term" flag to `core/` rather than the adapter.

**Never:**
- The Commissioner Drop command, its reason sheet, or the 2RK release rule — that is **Story 7.8**. This story delivers the slot kind and the parsed designation those depend on.
- Roster Move / trade recording (7.7), divergence detection (7.9), audit log (7.5).
- Making Dead Money importable, a placement destination, or an export row.
- Re-deriving the Minor League $0 rule anywhere outside `chargedCapHit`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Rookie deal parses distinctly | `Contract` cell `2RK31`, import year 2026 | Row carries `contractYearsRemaining: 5` **and** a rookie-scale designation of round `2` | N/A |
| Plain deal parses distinctly | `Contract` cell `2031` | `contractYearsRemaining: 5`, **no** rookie designation — distinguishable from the row above | N/A |
| Unrecognised contract shape | `Contract` cell `20X1` | File refused, row number and raw cell named | Returned refusal, not a throw |
| Dead Money charges full | Row `{capHit: $2M, rosterSlotKind: 'dead_money'}` | `chargedCapHit` → `$2,000,000` | N/A |
| Dead Money is unbounded | 9 `dead_money` rows on one Team | `checkSlotCeilings` returns **no** breach for it | N/A |
| Dead Money frees a slot | 11 `active_bench` + 1 `dead_money` | Roster Count is **11**, not 12 | N/A |
| Dead Money is not importable | Import file whose Status maps to Dead Money | Row refused and named at content altitude | Returned refusal; DB constraint is the backstop |
| Dead Money renders apart | Team holding Dead Money | Team view and Teams index show it labelled, separate from the roster | N/A |

</frozen-after-approval>

## Code Map

**The rule (change is smaller than it reads):**
- `src/lib/core/types.ts:144` -- `RosterSlotKind` union. Add `'dead_money'`. `SlotPlacement` (`:167`) is a deliberate **narrowing** and must **not** gain it — Dead Money is never a close destination.
- `src/lib/core/rules/roster-import.ts:69` -- `chargedCapHit`. `row.rosterSlotKind === 'minor_league' ? parseMoney(0) : row.capHit`. **Already correct — do not edit.** `dead_money` falls through to `row.capHit`. This is the AR-43 fallthrough.
- `src/lib/core/rules/roster-import.ts:96` -- `SLOT_CEILINGS: Record<RosterSlotKind, number>`. Typed-total → **compile error** until an unbounded entry is added.
- `src/lib/core/rules/roster-import.ts:110` -- `counts` literal inside `checkSlotCeilings`, also `Record<RosterSlotKind, number>` → **compile error**. Loop at `:120` iterates `Object.keys(SLOT_CEILINGS)`, so an entry whose count can never exceed its ceiling is never reported.
- `src/lib/core/rules/roster-import.ts:139` -- `SLOT_LABELS: Record<RosterSlotKind, string>` → **compile error**. Feeds the Team view grouping.

**The three sites that will NOT fail to compile — the AD-32 hazard:**
- `src/lib/core/team-view.ts:69` -- `ROSTER_GROUP_ORDER: readonly RosterSlotKind[]`. An **array**, not a Record. Consumed by `groupRoster` (`:534`) which maps *over the array*, so a `dead_money` row would be **silently dropped from the Team view** with no compiler complaint.
- `src/lib/server/staged-roster-row.ts:30` -- `KNOWN_SLOT_KINDS: readonly RosterSlotKind[]`; checked at `:60` via `.includes()`, throws at `:61-63`. Typechecks with 3 or 4 entries. **Leave at three** — this is a correct guard for import.
- `src/lib/server/team-roster.ts:232-233` -- two bare `if`s, no `else`: `active_bench` → `rosterCount`, `minor_league` → `minorLeagueOccupied`. `dead_money` correctly increments neither, but **by silence, not by design** — assert it with a test.
- `src/lib/server/team-roster.ts:190,224` -- `String(row['roster_slot_kind']) as RosterSlotKind` and `contract.placement as RosterSlotKind`, both **unchecked casts** from the DB. Read-only evidence: the type boundary here is nominal.

**The adapter:**
- `src/lib/adapters/fantrax/roster-file.ts:118` -- `/^(?:\d(?:RK|rk))?(\d{2}|\d{4})$/`. The prefix is a **digit + `RK`**, *not* the literal `NRK` that `AR-43` and `prd.md:854` claim.
- `src/lib/adapters/fantrax/roster-file.ts:127-134` -- `contractYearsRemainingFrom`, reads `match[1]` only. Returns `number | null`; `null` ⇒ refusal.
- `src/lib/adapters/fantrax/roster-file.ts:82` -- `CURRENT_CONTRACT_YEAR = 2026`.
- `src/lib/adapters/fantrax/roster-file.ts:104-111` -- `ROSTER_SLOT_ALIASES`, keyed by input string. Accepts `act`, `res`, `min`, `ir`, `injury reserve`, `injured reserve`. **Add nothing** — Dead Money is not importable.
- `src/lib/adapters/fantrax/roster-file.ts:331-333` -- `refuse(rowNumber, detail)`; refusal is a **returned value**. Message pattern at `:308`.
- `src/lib/core/types.ts:186-193` -- `ParsedRosterRow`, the shape the adapter emits. Gains the designation field.

**Schema:**
- `supabase/migrations/20260824020000_live_reference_tables.sql:61-62` -- `team_rosters_roster_slot_kind_check`, three values. **Widen to four.**
- `supabase/migrations/20260824000000_import_staging.sql:105-110` -- `import_staged_rosters_roster_slot_kind_check`, three values. **Leave at three.**
- Convention: `supabase/migrations/YYYYMMDDHHMMSS_snake_case.sql`, time always `000000`; new file `20260910000000_*.sql` sorts last. House style: prose header block, `if exists` guards, `comment on column`. **No repo precedent exists for altering a check constraint** — drop-and-recreate is the only option.

**Surfaces:**
- `src/lib/core/team-view.ts:534` (`groupRoster`), `:687` -- grouping built here, not in the route.
- `src/routes/teams/[teamId]/+page.svelte:285-300` -- renders `{#each team.roster as group}` with `group.label`. Adding the group order entry is what makes it appear.
- `src/lib/core/teams-index.ts:270` (`TeamsIndexRow`), `src/routes/teams/+page.svelte:180-240` -- slot and money figures.

**Tests:**
- `tests/examples/example-NN-kebab-title.test.ts`, vitest. Header line 1: `PRD §10 example NN — **Title** (FR-NN).` Highest implemented is **35**; 36–39 do not exist, so 40 and 41 will be non-contiguous. Pattern reference: `tests/examples/example-28-the-median-lands-between-two-grid-values.test.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/20260910000000_dead_money_roster_slot_kind.sql` -- drop and recreate `team_rosters_roster_slot_kind_check` with a fourth value `'dead_money'`; `comment on column` recording that Dead Money charges in full and occupies no Slot -- schema must admit the kind before any code can write it (AD-26), and the header explains why the staging table is deliberately untouched.
- [x] `src/lib/core/types.ts` -- add `'dead_money'` to `RosterSlotKind`; leave `SlotPlacement` at two members; add the rookie-scale designation field to `ParsedRosterRow` -- the union is the source of the compile errors that find every consumer.
- [x] `src/lib/core/rules/roster-import.ts` -- add the unbounded `SLOT_CEILINGS` entry and the `counts` entry and the `SLOT_LABELS` entry (`'Dead Money'`); **leave `chargedCapHit` untouched** -- three typed-total records fail to compile until updated; the fourth rule is already right by fallthrough.
- [x] `src/lib/core/team-view.ts` -- add `'dead_money'` to `ROSTER_GROUP_ORDER`, positioned last, outside the roster proper -- this array does **not** fail to compile, and omitting it silently hides Dead Money (UX-DR40).
- [x] `src/lib/adapters/fantrax/roster-file.ts` -- make the rookie prefix a **capturing** group and return the round alongside the years; keep the refusal path and its message shape unchanged -- confined to the adapter (AD-24).
- [x] `src/lib/server/team-roster.ts` -- no logic change; confirm `dead_money` increments neither counter -- covered by test, not by edit.
- [x] `src/routes/teams/[teamId]/+page.svelte` + `src/routes/teams/+page.svelte` -- render the Dead Money group labelled and visibly separate from the roster -- UX-DR40; Cap Space must reconcile against the players visibly on the Team.
- [x] `tests/examples/example-40-a-drop-lowers-the-maximum-bid.test.ts` -- encode example 40 at pure-core altitude -- see Design Notes on altitude.
- [x] `tests/examples/example-41-the-three-characters-worth-2000000.test.ts` -- encode example 41 -- **must yield a different Maximum Bid from example 40**; that difference is the regression.
- [x] `src/lib/adapters/fantrax/roster-file.test.ts` (or existing sibling) -- assert `2RK31` and `2031` produce **distinguishable** rows, and that an unrecognised shape still refuses and names the row -- the parse-level half of the regression.
- [x] Unit-test the I/O matrix rows not covered above -- ceilings, roster count, labels, non-importability.

**Acceptance Criteria:**
- Given `chargedCapHit`, when the story is complete, then the function body is **textually unchanged** and a `dead_money` row returns its full Cap Hit.
- Given a fourth member is added to `RosterSlotKind`, when `npm run check` runs against the pre-change `core/` and `adapters/`, then it reports errors at `SLOT_CEILINGS`, the `counts` literal, and `SLOT_LABELS` — proving those sites are exhaustive by type rather than by convention.
- Given `ROSTER_GROUP_ORDER`, `KNOWN_SLOT_KINDS` and `team-roster.ts:232-233` do **not** fail to compile, when the story is complete, then each has an explicit test asserting its Dead Money behaviour.
- Given a Team with Dead Money, when the Team view and Teams index render, then Dead Money appears labelled and separate from the roster.
- Given an import file carrying a Status this adapter does not recognise, when it is imported, then the row is refused and named — Dead Money is not importable in v1.
- Given examples 40 and 41, when both run, then they produce Maximum Bids of $3,000,000 and $5,000,000 respectively.
- Given the rookie-scale capture is reverted in `CONTRACT_END_YEAR` and nothing else, when the suite runs, then example 41's parse assertion goes **red** — `2RK31` yields a null round where 2 is required. That is the proof the regression bites, and it is the strongest proof available at this story's altitude: the two Maximum Bids are asserted over hand-built post-drop fixtures and do **not** converge under revert, because the rule that derives one state from the other is FR-43's release rule, which **Story 7.8 owns**. Amended 2026-09-10 at the human's direction after the original clause proved unsatisfiable within this story's approved scope.

## Spec Change Log

**2026-09-10 — implementation notes (nothing in the frozen sections changed).**

1. **`ParsedRosterRow.rookieScaleRound` is REQUIRED, not optional.** `number |
   null`, so every producer must state it. That forced one edit the Code Map
   did not anticipate: `src/lib/server/staged-roster-row.ts` now writes
   `rookieScaleRound: null` explicitly, because `import_staged_rosters` has no
   column for the designation and this story adds none. The loss is stated at
   the seam where it happens rather than left as an absence for 7.8 to notice.
2. **The Dead Money surface figure is MONEY, not a count.** The other three
   slot sentences state an occupancy against a ceiling; Dead Money has no
   ceiling, so `deadMoneySentence(charged)` renders `Dead Money $2.0M, charged
   and outside the 12`, and it is `null` for a Team carrying none
   (`contentionEntriesSentence`'s reasoning). It reaches the Teams index as
   `TeamsIndexRow.deadMoneyHalves`, read off the `TeamView` like every other
   field. The index card lists no rows, so this line is the only thing on it
   that can reconcile a Cap Space reduced by released Contracts.
3. **One unchecked cast removed in `core/team-view.ts`.** `entryFor` read
   `row.rosterSlotKind !== 'injury_reserve'` and then cast to `SlotPlacement`
   — true of a three-member union, false the moment `dead_money` joined it, and
   it would have handed a Dead Money row to `wonCardSentence` as a placement.
   The narrowing now comes FROM `SLOT_PLACEMENTS`, so no future slot kind is a
   placement by default. This is the "exhaustive with no catch-all" constraint
   applied to the one site that silently violated it.
4. **The empty Dead Money group is not rendered.** `ROSTER_GROUP_ORDER` carries
   it always (that is the AD-32 fix), and `groupRoster` still produces all four
   groups; only `/teams/[teamId]` declines to print a heading over zero rows,
   for the same reason the sentence is `null`. The other three still render
   when empty.
5. **`tests/structure.test.ts`'s `SECTION_10_EXAMPLES` registry** required the
   two new files to be added — it asserts `tests/examples/` holds exactly the
   registered set, so it fails on an unregistered example. Numbering is
   non-contiguous (36-39 are Epic 7's Roster Move examples, not implemented).

**2026-09-10 — review loop 1 (intent_gap resolved by the human; frozen AC amended).**

5. **The final acceptance criterion was unsatisfiable at this story's approved
   altitude, and the human amended it rather than expand scope.** As written it
   demanded that reverting the adapter capture make examples 40 and 41 *agree*.
   Verified by experiment: reverting only the capture turns example 41's parse
   assertion red (`expected null to be 2`) while both Maximum Bids hold at
   $5,000,000 and $3,000,000, because each post-drop state is a hand-built
   fixture and the rule that would derive one from the other is FR-43's release
   rule — which this spec's own **Never** list assigns to Story 7.8. Satisfying
   the clause literally would have required either pre-implementing 7.8's rule
   or spelling it a second time in test-only code. The clause was replaced with
   the parse-level proof, which is the strongest evidence available here.
   **KEEP on any re-derivation:** the two examples must continue to assert
   $3,000,000 and $5,000,000 over explicitly hand-built `AFTER` fixtures, with
   the fixture-not-derived limitation stated in their docstrings; do not
   "improve" them by importing a drop rule.
6. **Four review patches applied** (none touching the frozen sections): a
   `won: true` Dead Money case proving the `placementOf` narrowing rather than
   `row.won`; source-text assertions in `tests/structure.test.ts` pinning both
   new `.svelte` guards, which no test could otherwise reach; a corrected
   migration header comment (only the `drop` is guarded, not both statements);
   and an `id` on the Teams-index Dead Money figure to match the team page.

## Design Notes

**Two constraints, and the asymmetry is the feature.** `team_rosters` widens to four kinds; `import_staged_rosters` stays at three. That difference is what enforces "Dead Money is not importable in v1" *in the database*, underneath the adapter's content-altitude refusal. An implementer who "helpfully" widens both removes the backstop and breaks the last AC. Same reasoning keeps `KNOWN_SLOT_KINDS` at three.

**Why `chargedCapHit` needs no edit.** Dead Money is Injury Reserve without the ceiling: charged in full, occupying nothing. The existing expression already returns `row.capHit` for anything that is not `minor_league`, so the correct behaviour arrives by *not writing code*. Resist adding `|| row.rosterSlotKind === 'dead_money'` — it would be a second spelling of a rule that has exactly one.

**The unbounded ceiling.** `SLOT_CEILINGS` is `Record<RosterSlotKind, number>` and `checkSlotCeilings` reports when `count > ceiling`. `Number.POSITIVE_INFINITY` satisfies the type and can never be exceeded, so `checkSlotCeilings` never reports Dead Money without gaining a skip-branch. Prefer that to widening the type to `number | null`.

**Test altitude for examples 40 and 41 — stated assumption.** Both examples describe *a Drop*, and the Drop command is Story 7.8. This story encodes them as **pure-core tests over the post-drop roster state**, constructing the resulting rows directly in the fixture, exactly as the existing `tests/examples/` files do. What 7.6 proves is that the two inputs are now *distinguishable at all*: before this story `2RK31` and `2031` parse to identical rows, so no test could separate them. 7.8 later drives the same assertions through the Commissioner command.

**The prefix is a digit, not `NRK`.** `AR-43` and `prd.md:854` both say `CONTRACT_END_YEAR` "matches the `NRK` prefix". The actual regex is `(?:\d(?:RK|rk))?` — a *round digit* plus `RK`. The substance of both documents is right (non-capturing, discarded); the literal is wrong. Capture the digit, since FR-43's exception turns on the round being **2**.

## Verification

**Commands:**
- `npm run check` -- expected: zero errors. Run it once *before* updating the three typed-total records to confirm they do fail — that failure is AC evidence.
- `npm test` -- expected: full suite green, including the two new example tests.
- `npm run build` -- expected: passes, including `scripts/check-core-purity.js` (the adapter change must not leak Fantrax knowledge into `core/`).

**Manual checks:**
- Apply the migration to **dev** and confirm `team_rosters` accepts `'dead_money'` while `import_staged_rosters` still rejects it.
- Load a Team holding Dead Money: confirm it is labelled, visually separate from the roster, and that Cap Space reconciles against the players shown.

## Suggested Review Order

**The union, and what it forces**

- Start here: the one-word change every other stop reacts to.
  [`types.ts:162`](../../src/lib/core/types.ts#L162)

- The rule that needed NO edit — full charge arrives by falling through (AR-43).
  [`roster-import.ts:78`](../../src/lib/core/rules/roster-import.ts#L78)

- Unbounded ceiling: satisfies the total `Record`, can never be exceeded, never reported.
  [`roster-import.ts:118`](../../src/lib/core/rules/roster-import.ts#L118)

- The label the Team view groups by; a total `Record`, so it failed to compile.
  [`roster-import.ts:163`](../../src/lib/core/rules/roster-import.ts#L163)

**The three sites the compiler could not reach (AD-32)**

- An array, not a `Record` — omitting this would have silently hidden Dead Money.
  [`team-view.ts:86`](../../src/lib/core/team-view.ts#L86)

- Highest-risk stop: replaces an `as SlotPlacement` cast that became a lie.
  [`team-view.ts:549`](../../src/lib/core/team-view.ts#L549)

- The call site; under the old cast this rendered "Placed in undefined".
  [`team-view.ts:583`](../../src/lib/core/team-view.ts#L583)

- Deliberately left at three kinds — Dead Money is never staged for import.
  [`staged-roster-row.ts:39`](../../src/lib/server/staged-roster-row.ts#L39)

**The latent import defect**

- Capture-only change: same strings accepted, the round no longer discarded.
  [`roster-file.ts:133`](../../src/lib/adapters/fantrax/roster-file.ts#L133)

- Returns round beside years; the round, not a boolean, because FR-43 reads it.
  [`roster-file.ts:156`](../../src/lib/adapters/fantrax/roster-file.ts#L156)

- Where the designation now survives to; `null` for an ordinary contract.
  [`types.ts:229`](../../src/lib/core/types.ts#L229)

**Schema — the asymmetry is the enforcement**

- Widens `team_rosters` only; leaving staging at three kinds is the backstop.
  [`20260910000000_dead_money_roster_slot_kind.sql`](../../supabase/migrations/20260910000000_dead_money_roster_slot_kind.sql)

**Surfaces (UX-DR40)**

- Money, not an occupancy count — Dead Money answers to no ceiling.
  [`team-view.ts:515`](../../src/lib/core/team-view.ts#L515)

- Carried to the index off the same `TeamView` field as every other figure.
  [`teams-index.ts:486`](../../src/lib/core/teams-index.ts#L486)

- Suppresses only the EMPTY Dead Money group; the other three still render.
  [`[teamId]/+page.svelte:309`](../../src/routes/teams/[teamId]/+page.svelte#L309)

- The index card's only line that reconciles a Cap Space reduced by releases.
  [`teams/+page.svelte:233`](../../src/routes/teams/+page.svelte#L233)

**Tests**

- The pair, load-bearing as a pair: $3M and $5M asserted together.
  [`example-41…test.ts:145`](../../tests/examples/example-41-the-three-characters-worth-2000000.test.ts#L145)

- The regression that goes red if the capture is reverted.
  [`example-41…test.ts:159`](../../tests/examples/example-41-the-three-characters-worth-2000000.test.ts#L159)

- Proves the narrowing, not `row.won`, is what returns null.
  [`team-view.test.ts`](../../tests/team-view.test.ts)

- Pins both `.svelte` guards no other test altitude can reach.
  [`structure.test.ts`](../../tests/structure.test.ts)

- Turns `team-roster.ts`'s two bare `if`s from silence into a statement.
  [`team-roster.test.ts:161`](../../tests/server/team-roster.test.ts#L161)
