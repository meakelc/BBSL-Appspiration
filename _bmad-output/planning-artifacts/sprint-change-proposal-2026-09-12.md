# Sprint Change Proposal — 2026-09-12

**Project:** BBSL-Appspiration
**Raised by:** Meakel (Commissioner)
**Mode:** Batch
**Scope classification:** **Moderate** — backlog reorganisation plus two new stories, no replan
**Status:** Awaiting approval

---

## 1. Issue Summary

### The trigger

Story 7.7 — *Record a Roster Move* — shipped and is `done`. It works: `/roster-move` records a
mid-auction trade between two Teams, evaluates both once against post-Move state, and refuses rather
than cancels. Nothing about it is wrong.

Two things about it are **incomplete**, and both were discovered by using it:

1. **It is misnamed.** What it records is a **trade** — Contracts changing hands between two Teams.
   The league calls that a trade, the PRD's own §10 examples call it a trade (example 36 is literally
   *"The trade that clears the room"*), and the epic's implementation-order block is titled *"trade
   functions first"*. Only the requirement, the route and the code call it a *Roster Move*. The name
   is occupying vocabulary that a different, genuinely missing act needs.

2. **The act it displaced is missing.** After a trade lands, a Manager frequently needs to
   **rearrange which of their own eligible Contracts occupy the three Minor League Slots** — and
   there is no way to do it. Not by hand, not through the Commissioner, not at all. FR-21 places an
   arriving Contract automatically and nothing can ever move it again.

### Why the second half is not a nice-to-have

The app's own shipped behaviour creates the need. PRD §10 example 38 is the canonical case and it is
already implemented and tested
(`tests/examples/example-38-the-stash-that-becomes-expensive-by-moving.test.ts`):

> Team D trades Ellis — Minor League Eligible, won at $18,000,000, stashed at a **$0 Cap Hit** — to
> Team E, which already holds three Minor League Players. Slot Placement is re-evaluated on receipt,
> Ellis lands in an **Active/Bench Slot**, and his Cap Hit becomes **$18,000,000**.

Team E just took an $18,000,000 cap charge on a player it intends to stash, and the only reason he is
not stashed is that the three slots happened to be full of cheaper Contracts at the instant the trade
was recorded. Swapping Ellis with a $3,000,000 stash is legal under every league rule, breaches no
ceiling, and recovers $15,000,000 of Cap Space — and the app offers no act that can express it.

This is not an edge case the league will rarely reach. It is the **expected aftermath of the very
trade FR-41 exists to record**, on the one axis where the league's rules make placement worth
millions.

### Issue category

**New requirement emerged from use** (the rearrangement), compounded by a **misunderstanding of
original vocabulary** (the name). Neither is a defect in shipped code.

### Evidence

| Evidence | Source |
|---|---|
| The shipped act is a trade in everything but its name | `prd.md:1001` (§10 example 36, *"The trade that clears the room"*), `epics.md:2028` (*"Implementation order — trade functions first"*), `epics.md:2302` (*"I want to record a trade the managers agreed in Discord"*) |
| Placement is re-evaluated on arrival and Cap Hit follows it | `prd.md:1003` (§10 example 38); `arrivalPlacementFor` in `src/lib/core/rules/roster-move.ts` |
| Nothing can change a placement once set | `team_rosters.roster_slot_kind` is written by import, close, Trade and Drop — and by no Manager-reachable path |
| Placement is worth real money | `prd.md:1005–1007` (§10 examples 40 and 43): the same act moves Maximum Bid in **opposite directions** depending only on which Slot the Contract sat in |
| The app holds no eligibility fact for an imported Active/Bench Contract | `supabase/migrations/20260824020000_live_reference_tables.sql:31–66` — `team_rosters` has no eligibility column; `minor_league_eligible` exists only on `free_agent_players` (`:112`) |

---

## 2. Impact Analysis

### 2.1 Epic impact

**Epic 7 can be completed as planned.** Nothing in it is invalidated, nothing rolls back, and
Stories 7.1–7.8 stay `done`. Two stories are **appended**:

| Story | Title | Status | Depends on |
|---|---|---|---|
| **7.10** | Rename the Roster Move to a Roster Trade | backlog | 7.7, 7.8 (both `done`) |
| **7.11** | Rearrange a Roster's Slot Placements | backlog | **7.10** (hard), 7.1, 7.7 |

**Numbers are not reshuffled.** `epics.md:5` records the standing decision from 2026-09-10 —
renumbering would churn every `sprint-status.yaml` key and every by-name citation in the spine and
the traceability table. 7.10 and 7.11 append, exactly as 7.6–7.9 did.

**7.10 must precede 7.11, and this is not a preference.** Land them in the other order and the
codebase briefly contains two different things called a Move, one of which is about to be renamed.
Every import, test name and comment written during 7.11 would be written against vocabulary that
7.10 then changes.

**7.10 should also precede 7.9** (*Detect a Roster Divergence*, backlog). Story 7.9's acceptance
criteria say a paired difference *"proposes a Roster Move"* — which will mean a Trade. Writing 7.9
first means writing it twice.

#### Epic framing

Epic 7 is *"The referee's controls and the record"*, and Story 7.11 is the first story in it a
**Manager** may perform. The epic has already absorbed this stretch once and argued for it in its own
body (`epics.md:2032`, `epics.md:378`): Stories 7.6–7.9 are *"everyday operations, not
break-glass"*, and roster work belongs here *"because splitting it out would duplicate that
foundation."* That argument holds more strongly for a third act: Story 7.11 is the **third caller** of
`core/rules/roster-act.ts`, the shared evaluator Story 7.8 extracted precisely so a second act would
not re-implement the gates. Putting it in a new epic would separate it from the module it exists to
reuse.

Epic 7's goal statement gains one sentence. No new epic.

#### Epics not affected

Epics 1–6 and 8–10 are untouched in scope. Two **mechanical** touches only: Epic 8's replay stories
(8.1, 8.3) fold reference-data-mutation events and gain one more event kind to fold, whose shape
AD-32 already specifies; Epic 6's exports (6.3, 6.4) already read placement and need no change,
because a rearrangement leaves the export's *shape* identical.

#### Epic order and priority

Unchanged, with one **deployment constraint inherited verbatim** from the 7.6–7.8 block
(`epics.md:2049`): both new stories touch `src/lib/core/`, and **AD-20** fail-stops a `core/` deploy
during a live Auction Phase. Each therefore needs a pause (AD-13), a green §10 suite (AD-25) and a
recorded reason. Both should land **before Story 9.8** (prod setup day) and ideally before **Story
9.7** (the moderator pilot), so the pilot exercises both acts against real managers.

### 2.2 Story impact

**No shipped story changes behaviour.** Story 7.7's code is correct and its tests prove it; 7.10
changes what it is *called* and 7.11 adds a sibling. Three shipped stories carry wording that becomes
stale and is corrected by 7.10: 7.7 (title and body), 7.8 (cross-references to "the same terms as a
Move"), 7.1 (the reason sheet's two-Team variant). One backlog story's wording changes: **7.9**, as
above.

### 2.3 Artifact conflicts

| Artifact | Conflict | Severity |
|---|---|---|
| **PRD** | FR-41's name, FR-42/FR-43's cross-references, three §3 glossary entries, §4.10's framing, SM-2 and SM-7, §7.1's scope list, §10 examples 36–43's vocabulary. **New:** FR-44, §10 examples 44–46 | Moderate — mostly vocabulary, one new requirement |
| **Epics** | Epic 7 goal, Story 7.7 title and body, Story 7.9 wording, the FR traceability table, the implementation-order block, the changelog. **New:** FR-44/AR-44/UX-DR41 inventory rows, Stories 7.10 and 7.11 | Moderate |
| **Architecture spine** | AD-32's title and body speak of *"a Roster Move or Drop"* throughout and bind `FR-41 – FR-43`. Needs FR-44 bound and one new clause. **Pre-existing drift to fix in the same pass:** AD-32 calls the event `RosterMoved` while the code writes `RosterMoveRecorded` (`projection/contracts.ts:403`) | Moderate |
| **UX (DESIGN.md)** | The Commissioner-control table and the override-reason-sheet section need the Manager-facing confirmation sheet distinguished from them. **New:** UX-DR41 | Low |
| **UX (EXPERIENCE.md)** | The Auction destination list gains a row; `:133`'s *"No Commissioner act is ever a single tap"* needs its boundary stated, since the new act is sometimes not a Commissioner act at all | Low |
| **sprint-status.yaml** | Two story keys appended under `epic-7` | Trivial |
| **Code** | ~470 identifier occurrences across 12 files (inventory in §4.4) | Moderate, mechanical |
| **Migrations** | **None.** Decided: no schema change | — |

### 2.4 Technical impact

**The rename is wider than a directory.** Measured, not estimated:

- **12 files** carry `roster-move` in their *name*, including `tests/examples/example-36…39` (those
  four keep their example numbers — 36–39 are PRD examples about trades — only their imports change).
- **~470 identifier occurrences** across `src/` and `tests/`, led by `evaluateMove` (67),
  `RecordRosterMove` (41), `MovingPlayer` (34), `RosterMoveState` (26), `MoveTeamFigures` (26).
- **One destination id**, registered in two phase lists (`server/destinations.ts:126,139`) and
  asserted in `tests/destinations.test.ts:87,91`.
- **One persisted event type** — and this is the only part that is not free.

**The persisted event type stays `RosterMoveRecorded`.** AD-4 forbids deleting or mutating events, so
renaming a value already written to `auction_events.event_type` is a history rewrite, not a refactor.
The wire name therefore stays, with a comment at `src/lib/core/projection/contracts.ts:403` saying
why. Every *identifier*, module, route and type renames to Trade. The cost is one string in the log
that reads as the old vocabulary forever; the alternative was truncating the dev log and invalidating
every snapshot exported before today.

**Three shared type names are currently mis-scoped, and the rename is the moment to fix it.**
`MoveCapGateOutcome`, `MoveSlotsGateOutcome` and `MoveLeadingAuction` live in `core/types.ts` and are
read by **all three** acts through `roster-act.ts`; `RosterMoveTeamFigures` in
`projection/contracts.ts` is aliased by both `MoveTeamFigures` and `DropTeamFigures`. Renaming them
to Trade would be wrong, and leaving them named Move after Move means something else would be worse.
They become `ActCapGateOutcome`, `ActSlotsGateOutcome`, `ActLeadingAuction` and
`RosterActTeamFigures` — named for the shared abstraction `roster-act.ts` already is.

**No migration.** The chosen eligibility rule adds no column, and the new event type is a `text`
value in a generic column — the same reason `BidCancelled` needed none (AD-32).

---

## 3. A finding from the analysis that changed the design

Working Section 3 of the checklist surfaced a one-way door that the obvious implementation of FR-44
would have built, and it is worth stating before the proposals because it shaped them.

**The problem.** `core/rules/roster-move.ts` already says it, in the header of `arrivalPlacementFor`:

> *"Sitting in a Minor League Slot IS the eligibility statement. A rostered Player has no row in
> `free_agent_players` to consult."*

That is sound for a Trade, where occupancy is read and never cleared. It is **unsound for a
rearrangement**, because a rearrangement can *empty* the slot. Demote an imported stash to
Active/Bench and the app has just destroyed the only fact it held saying he may be stashed — so he
can never go back. A rearrangement tool whose every act is irreversible is not a rearrangement tool.
It would also make §10 example 44 below a trap: the swap works once and can never be undone.

**The resolution — eligibility is remembered, not inferred from the present.** The eligible set is

> every Contract the live pool flags eligible (so every auction-won Contract), **union** every
> Contract the app has **ever observed** in a Minor League Slot — from the initial import snapshot or
> from any recorded act since.

This needs no column and no migration: it is a fold over the log from the reference-data snapshot,
which is exactly the reconstruction AD-32 already specifies for rebuild, restore and replay. It makes
every Move reversible, and a demote-then-promote round trip returns the roster to identical state —
which becomes an acceptance criterion.

**What it does not fix.** An imported Active/Bench Contract the app has *never* seen in a Minor
League Slot and that was never in the pool still cannot be promoted, because the app genuinely does
not know he is eligible. That is the accepted limitation of the no-migration decision, it is stated in
the refusal wording, and §10 example 46 is written to pin it.

---

## 4. Recommended Approach

### 4.1 Path selected: **Direct Adjustment** (Option 1)

Two stories appended to Epic 7, amendments in place to PRD / epics / spine / UX, no renumbering, no
new epic, no migration.

### 4.2 Options considered and rejected

**Option 2 — Rollback.** Not viable, and nothing recommends it. Story 7.7's code is correct;
reverting working, tested trade recording in order to rename it would discard the §10 example 36–39
suite and re-earn it for no gain. **Effort: Medium. Risk: High. Verdict: rejected.**

**Option 3 — MVP review.** Not warranted. The MVP is unchanged in ambition, and FR-44 is a small act
reusing a shipped evaluator. It is worth recording *why* it belongs in v1 rather than v2: the need is
created by FR-41, which is already in v1, and shipping the trade recorder without the rearrangement
leaves managers holding cap charges the league's rules say they should not be paying. Deferring FR-44
would defer the second half of a feature whose first half is live. **Effort: High. Risk: High.
Verdict: rejected.**

**Option 1 — Direct Adjustment.** **Effort: Medium** — 7.10 is large but mechanical and
compiler-checked; 7.11 is a fourth command type over an evaluator that already exists and has three
callers' worth of proof. **Risk: Low–Medium** — the risk concentrates in 7.10's breadth, and
TypeScript plus the existing suite catch essentially all of it. **Verdict: recommended.**

### 4.3 Sequencing

```
7.10  Rename Move → Trade          (mechanical, compiler-checked, no behaviour change)
  └─ 7.11  Rearrange a Roster      (new command type, new event, two sheet forms)
       └─ [7.9  Detect a Divergence — already backlog, inherits the vocabulary]
```

Both before **Story 9.8**, ideally before **Story 9.7** (AD-20, AD-13, AD-25).

### 4.4 The rename inventory, for the record

Files renamed:

```
src/lib/core/rules/roster-move.ts  → src/lib/core/rules/roster-trade.ts
src/lib/server/roster-move.ts      → src/lib/server/roster-trade.ts
src/routes/roster-move/            → src/routes/roster-trade/        (2 files)
tests/roster-move.test.ts          → tests/roster-trade.test.ts
tests/server/roster-move.test.ts   → tests/server/roster-trade.test.ts
tests/routes/roster-move.test.ts   → tests/routes/roster-trade.test.ts

tests/examples/example-36…39.test.ts   names unchanged; imports only
spec-7-7-record-a-roster-move.md       left as-is; it is the shipped record
```

Identifiers, highest-traffic first: `evaluateMove`→`evaluateTrade` (67), `RecordRosterMove`→
`RecordRosterTrade` (41), `MovingPlayer`→`TradingPlayer` (34), `RosterMoveState`→`RosterTradeState`
(26), `MoveTeamFigures`→`TradeTeamFigures` (26), `describeMoveAmount`→`describeActAmount` at every
call site (21 — it is already a re-export of the `roster-act.ts` original, so the alias simply goes
away), `MoveTransfer`→`TradeTransfer` (20), `RosterMoveRecorded`/`ROSTER_MOVE_RECORDED_EVENT` (17/18
— **constant renames, string value does not**), `recordRosterMove`→`recordRosterTrade` (16),
`rosterMoveRefusalDetail`→`rosterTradeRefusalDetail` (15), `RECORD_ROSTER_MOVE_GATES`→
`RECORD_ROSTER_TRADE_GATES` (15), and the rest proportionally. The four shared names move to Act
scope, not Trade scope, as argued in §2.4.

---

## 5. Detailed Change Proposals

### 5.1 PRD — `_bmad-output/planning-artifacts/prds/prd-BBSL-Appspiration-2026-08-16/prd.md`

#### 5.1.1 §3 Glossary — split one term into two

**Section:** §3 Glossary, `prd.md:123`

**OLD**

> - **Roster Move** — the Commissioner recording that one or more Contracts have changed hands
>   between two Teams, as one act. …

**NEW** (two entries; the body of the existing one is unchanged apart from the name)

> - **Roster Trade** — the Commissioner recording that one or more Contracts have changed hands
>   between two Teams, as one act. *(Called a Roster Move before 2026-09-12.)* **Both Existing
>   Contracts and Auction Contracts may move.** The Contract itself travels unchanged — same value,
>   same years; what changes is which Team holds it and, possibly, which Roster Slot receives it.
>   **Slot Placement is re-evaluated against the receiving Team's occupancy at the moment of the
>   trade**, so a Minor League Eligible Player stashed at a $0 Cap Hit on the sending Team lands in an
>   Active/Bench Slot on a receiving Team with no Free Minor League Slot — and charges his full amount
>   there. Cap Hit follows placement, never the other way round. A Roster Trade never transfers
>   Committed Bids, a Minimum-Bid Contention entry, or Cap Space, and is **refused** outright if it
>   would leave either Team failing a gate it currently passes. See FR-41.
> - **Roster Move** — a Team moving its **own** Contracts between its **own** Roster Slots, with no
>   Contract changing hands and no counterparty. One act, one evaluation at the end. Only a Minor
>   League Eligible Contract may occupy a Minor League Slot; Injury Reserve is not rearrangeable and
>   Dead Money is not a Slot. **Cap Hit follows placement** exactly as it does in a Trade, so a Move is
>   a deliberate cap decision: a Contract promoted into a Minor League Slot charges $0, and one demoted
>   to Active/Bench charges its full amount. A Move is the **only** act by which a Manager changes
>   their own Team's cap position without bidding. See FR-44.

**Rationale:** The two acts are distinguished by whether a Contract changes hands — the one fact that
decides which gates apply and whether a counterparty exists. One name cannot carry both.

**Also amended for vocabulary only** (`prd.md:124`, `:125`): *Roster Divergence* raises "a proposed
Roster **Trade** or Drop"; *Drop* unchanged but its cross-reference to FR-41's gate terms keeps
reading correctly once FR-41 is renamed.

#### 5.1.2 FR-41 — rename in place

**Section:** §4.10, `prd.md:745`

**OLD**

> #### FR-41: Record a Roster Move
>
> *(Numbered after FR-40 because it was added on 2026-09-10, when the commissioner recorded that
> managers trade during the auction. …)*
>
> Commissioner can record that one or more Contracts have changed hands between two Teams, in one
> act, and the system recomputes both Teams' positions from it.

**NEW**

> #### FR-41: Record a Roster Trade
>
> *(Numbered after FR-40 because it was added on 2026-09-10, when the commissioner recorded that
> managers trade during the auction. **Renamed from "Record a Roster Move" on 2026-09-12**: what this
> requirement describes is a trade, and the name "Roster Move" was needed for the within-Team act
> FR-44 now defines. The requirement's substance is unchanged — no gate, figure or refusal in it
> moves — and the persisted event type remains `RosterMoveRecorded`, because AD-4 forbids mutating
> the log.)*
>
> Commissioner can record that one or more Contracts have changed hands between two Teams, in one
> act, and the system recomputes both Teams' positions from it.

**Rationale:** The rename must carry its own provenance, or the next reader finds a 2026-09-10
changelog entry naming a requirement that no longer exists under that name.

**Body changes:** every occurrence of "Roster Move" / "a Move" inside FR-41's consequence bullets
(`prd.md:754–786`) becomes "Roster Trade" / "a Trade". **No bullet's substance changes.** The one
bullet that gains a clause is the re-placement bullet:

> **ADDED to the Slot Placement bullet:** A receiving Team unhappy with where an arriving Contract
> landed has a remedy that did not exist before 2026-09-12: it may rearrange its own Slots under
> FR-44. The Trade's own placement rule is **unchanged** — it is still FR-21's automatic rule against
> the receiving Team's occupancy, and it is still applied without asking anybody.

#### 5.1.3 FR-42 and FR-43 — cross-reference updates only

- `prd.md:787–826` (FR-42): "proposed Roster Move" → "proposed Roster **Trade**" throughout;
  "Paired … raised as a **proposed Roster Move** (FR-41)" → "**proposed Roster Trade** (FR-41)".
- **ADDED to FR-42's scope bullets:** a sentence closing a gap FR-44 opens, see §5.1.6 below.
- `prd.md:828–865` (FR-43): "Unlike a Roster Move it has one direction" → "Unlike a Roster Trade";
  "refused on the same gate terms as FR-41" reads correctly unchanged.

#### 5.1.4 FR-44 — new requirement

**Section:** **§4.4 Bidding and Cap Enforcement**, appended after FR-37 — *not* §4.10.

**Rationale for the placement, which is a judgement call worth stating:** §4.10 is titled
*"Commissioner Controls and Audit"*, and a Manager-facing act filed there would never be found by a
reader scanning for what a Manager may do. FR-44's whole point is its effect on Maximum Bid, which is
§4.4's subject — Minors Exposure (FR-35) and the slots gate (FR-37) both live there. §4.10 gains a
one-line pointer.

**NEW**

> #### FR-44: Rearrange a Roster's Slot Placements
>
> *(New 2026-09-12. It exists because FR-41 creates the need: a Contract arriving from a Trade is
> placed by FR-21's automatic rule against whatever the receiving Team's occupancy happened to be at
> that instant, and before this requirement nothing could ever move it again. §10 example 44 is the
> case.)*
>
> A Manager can move their own Team's Contracts between an Active/Bench Slot and a Minor League Slot,
> as one act, and the system recomputes the Team's position from it. The Commissioner can do the same
> on any Team's behalf.
>
> **Consequences (testable):**
>
> *What moves*
> - A Roster Move names **one Team** and one or more of its own Contracts, each with the Slot it is to
>   occupy. **No Contract changes hands**, there is no counterparty, and no amount is edited.
> - It is **one act with one evaluation at the end**, for FR-41's reason and not as a convenience. A
>   swap applied one leg at a time transiently breaches a ceiling that the act itself never breaches —
>   §10 example 44 is that counterfactual, and it is §10 example 39's lesson reached by a different
>   act.
> - **Only an Active/Bench Slot and a Minor League Slot participate.** **Injury Reserve is not
>   rearrangeable**: IR is a Fantrax fact about a player's health, not a placement this app assigns,
>   and an app that moved a player out of it would be inventing a medical opinion. **Dead Money is not
>   a Slot** and never participates (FR-43).
> - **Only a Minor League Eligible Contract may occupy a Minor League Slot**, and eligibility is
>   **remembered rather than inferred from the present**: the eligible set is every Contract the live
>   pool flags eligible (so every auction-won Contract) **union every Contract the app has ever
>   observed in a Minor League Slot** — from the import snapshot or from any recorded act since.
>   Without the second half, demoting an imported stash would destroy the only fact the app held
>   saying he may be stashed, and the act would be irreversible. **Demotion to Active/Bench requires
>   no eligibility at all.**
> - An imported Active/Bench Contract the app has **never** seen in a Minor League Slot and that was
>   never in the pool **cannot be promoted**, and the refusal says exactly that — *the app has never
>   been told he is eligible* — rather than asserting he is ineligible, which is something the app
>   does not know. §10 example 46.
> - **Only a settled Contract moves.** A Player contested in an open Auction is on no roster, so he
>   cannot be named; the refusal comes from the rules core, checked before the money and slots gates,
>   exactly as FR-41 requires.
>
> *What it costs and what it buys*
> - **Cap Hit follows placement** (FR-21, AD-23). A Contract promoted into a Minor League Slot charges
>   **$0**; one demoted to Active/Bench charges its **full** amount. Its value never changes and no
>   expression reads one from the other.
> - **Minors Exposure recomputes** across every eligible Auction the Team leads, and **Roster Count
>   moves with Active/Bench occupancy.** A Move is therefore a Maximum Bid lever in **both
>   directions**, and at least one of them is counterintuitive: *demoting* a stash to Active/Bench
>   frees a Minor League Slot, which can **raise** Maximum Bid by reducing Minors Exposure, while
>   simultaneously **lowering** Cap Space by charging the full Cap Hit. §10 example 45 is that case and
>   it is the FR-44 analogue of §10 example 40.
> - **No assigned contract length is cleared.** The Contract does not change hands, so §10 example 42's
>   reasoning does not apply, and the Year Allotment is untouched.
>
> *Gates and refusal*
> - Both Teams' — here, the one Team's — **money and slots gates are evaluated once**, over post-Move
>   state, by the **same** pure derivations a Bid is judged by. This requirement writes no affordability
>   check of its own (AR-42, AR-44).
> - Where either gate fails, **the whole Move is refused and nothing is written**, naming the gate, the
>   Auction and the arithmetic.
> - **It never cancels a Bid.** FR-40's cancellation trigger is an Auction Close and only a Close, and
>   the sheet offers no control that would change that.
>
> *Who, when, and the record*
> - A **Manager** may act on **their own Team only** — the Team is resolved from the session, never
>   from a form field. The **Commissioner** may act on any Team, through the Story 7.1 reason sheet with
>   a mandatory free-text reason. A Manager's own act requires a **confirmation** sheet and **no
>   reason**: it is a Manager's ordinary strategic decision, not a referee intervention, and DESIGN.md's
>   control separation must hold (UX-DR41).
> - Permitted in the **Auction** and **Contract Assignment** Phases; refused in Setup and once Archived.
> - **Refused while the auction is paused** (AD-13). A Move changes Maximum Bids, and a paused auction
>   changes nothing. The refusal is worded as the pause, distinctly from every rules refusal.
> - **Unlimited.** A Move is reversible and costs nothing to undo, so no cap on frequency is imposed.
>   The accepted cost is Audit Log volume — see §9.
> - One transaction under the global write lock, mutating `team_rosters.roster_slot_kind` for Existing
>   Contracts and appending **one** record event carrying the **whole delta** — every Contract, both
>   placements, both Cap Hits, and the Team's figures before and after (AR-41). Auction Contracts have no
>   row and move by the event alone, folded latest-placement-wins.
> - Recorded in the league-visible Audit Log (FR-33) and **not broadcast to Discord**, consistent with
>   FR-41.
> - **The app becomes authoritative over placement.** Placement arrives from Fantrax at import (FR-1) and
>   from FR-21 at a close; from the first Move onward the app decides it and the export carries the
>   decision out (FR-30, FR-31). A placement difference between the app and Fantrax before that export
>   is therefore **expected and is not a divergence** — see FR-42.

#### 5.1.5 §4.10 — one pointer line

**ADDED** at the end of §4.10's FR-41 block:

> *A Manager's own within-Team rearrangement is **FR-44**, in §4.4. The Commissioner's on-behalf half
> of it is a control of this class and obeys every rule in this section, including the reason sheet.*

#### 5.1.6 FR-42 — one clause closing the gap FR-44 opens

**ADDED** to FR-42's scope bullets (`prd.md:~808`)

> - **A placement difference is not a divergence.** The detector takes **membership only**, and from
>   FR-44 onward that is a positive decision rather than a limitation: the app **decides** placement
>   and Fantrax **receives** it through the export, so a Contract the app holds in a Minor League Slot
>   and Fantrax holds in Active/Bench is the expected state between a Move and the next export — not
>   drift. Raising it would train the Commissioner to dismiss the detector. The live payload's `status`
>   field does distinguish all four Slot kinds, so this is a choice and not a data limitation; revisit
>   only if the export stops being the reconciliation point.

**Rationale:** Without this clause, Story 7.9 is built against an ambiguity that FR-44 introduces, and
the obvious reading ("we have the status field, use it") produces a detector that cries wolf after
every Move.

#### 5.1.7 §7.1 MVP scope — one line, and a pre-existing gap closed

**Finding:** the 2026-09-10 amendment added FR-41–FR-43 but **never updated §7.1**, so the In Scope
list today stops at FR-34 and omits three shipped requirements. Fixed in the same pass.

**ADDED** after `prd.md:906`

> - Recording what happened in Fantrax — a Roster Trade, a Drop and the Dead Money it leaves behind —
>   plus Manager-driven rearrangement of a Team's own Minor League Slots and the contingent divergence
>   detector (FR-41 – FR-44).

#### 5.1.8 Success metrics

- **SM-2** (`prd.md:923`) — **OLD:** *"**Roster Moves and Drops (FR-41, FR-43) are excluded from this
  count.**"* → **NEW:** *"**Roster Trades, Drops and Roster Moves (FR-41, FR-43, FR-44) are excluded
  from this count.**"* Same reasoning, extended: a Commissioner rearranging a Team's slots on its
  behalf is recording a Manager's decision, not correcting an app error, and a metric that could not
  tell those apart would pressure the Commissioner not to help.
- **SM-7** (`prd.md:930`) — "Validates FR-41 – FR-43" → "FR-41 – FR-44".

#### 5.1.9 §10 Rule Resolution Examples

**Vocabulary only** in examples 36–43: "Roster Move" → "Roster Trade", "the Move" → "the Trade". No
figure changes. The §10 preamble at `prd.md:999` gains `*and Roster Moves (FR-44) on 2026-09-12*`.

**Three new examples.** These are the acceptance tests for Story 7.11 (AD-25).

> 44. **The optimization after the trade.** Continues example 38. Team E has just received Ellis —
>     Minor League Eligible, won at $18,000,000 — who landed in an **Active/Bench Slot** because all
>     three Minor League Slots were full, and who therefore charges **$18,000,000**. Team E stands at
>     Roster Count 10, three Minor League Slots occupied, Cap Space **$2,000,000**. One of its three
>     stashes is Brooks, an imported Contract charging **$0** in a Minor League Slot against a full
>     value of $3,000,000. Team E records **one** Roster Move: Ellis **into** a Minor League Slot,
>     Brooks **out** to Active/Bench. Afterwards Ellis charges **$0** (+$18,000,000) and Brooks charges
>     **$3,000,000** (−$3,000,000), so **Cap Space is $17,000,000** — the Team recovered $15,000,000 by
>     changing nothing but which eligible Contract sits in the stash. **Roster Count is unchanged at
>     10** (one left Active/Bench, one entered) and **Minor League occupancy is unchanged at 3**.
>     Brooks needed no pool row to be demoted, and Ellis was eligible because the pool says so.
>     **Applied one leg at a time it is refused:** demote Ellis first and Minor League occupancy
>     transiently reads **4**, breaching the ceiling of 3 and refusing a legal rearrangement on a state
>     that never existed. This is example 39's lesson reached by a different act, and it is why FR-44
>     is one act with one evaluation at the end.
>
> 45. **The Move that buys bidding power by spending cap.** Team L holds two of its three Minor League
>     Slots (`M = 1`), has Roster Count 10 and Cap Space $20,000,000, and leads two **eligible**
>     Auctions at $12,000,000 and $4,000,000. Today: `N = 2, M = 1`, Overflow Count 1, **Minors
>     Exposure $12,000,000** (the larger), Available Cap Space $8,000,000; bidding once, Roster Reserve
>     is `$1,000,000 × max(0, 12 − 11) = $1,000,000`, so **Maximum Bid is $7,000,000**. It now
>     **demotes** one stash — full value $2,000,000 — to an Active/Bench Slot. Minor League occupancy
>     falls to 1, so `M = 2`; `N = 2 ≤ M = 2`, Overflow Count falls to **0** and **Minors Exposure
>     falls to $0**. But the demoted Contract now charges, so **Cap Space falls to $18,000,000** —
>     Available Cap Space is $18,000,000. Roster Count rises to 11, so Roster Reserve becomes
>     `$1,000,000 × max(0, 12 − 12) = $0`, and **Maximum Bid is $18,000,000**. The Team **spent
>     $2,000,000 of Cap Space and gained $11,000,000 of Maximum Bid.** Every intuition says putting a
>     player on the active roster costs you money; here it buys bidding power, because an empty Minor
>     League Slot is what Minors Exposure reserves against. **This is the mirror of example 40** and the
>     reason FR-44's sheet must state which way Maximum Bid actually moved, in words, before commit.
>
> 46. **The promotion the app must refuse, and the one it must allow.** Team M holds Vassell in an
>     Active/Bench Slot, imported from Fantrax at a Cap Hit of $4,000,000. He is in fact minor-league
>     eligible in the real league — but he was never in the Free Agent pool, so `free_agent_players`
>     holds no row for him, `team_rosters` holds no eligibility column, and the app has never observed
>     him in a Minor League Slot. The Move is **refused and he is named**, stating that *the app has
>     never been told he is eligible* rather than that he is ineligible: the second would assert
>     something the app does not know. **The converse must be allowed.** Team M also holds Thompson, an
>     imported Contract it demoted out of a Minor League Slot an hour ago under FR-44. Thompson has no
>     pool row either — but the app **has** observed him in a Minor League Slot, so he is eligible and
>     may be promoted back, returning the roster to exactly the state it held before. **These two
>     Contracts are indistinguishable in `team_rosters` and must be distinguished by the log**, which is
>     what makes "eligibility is remembered" a requirement rather than an implementation detail.

### 5.2 Epics — `_bmad-output/planning-artifacts/epics.md`

#### 5.2.1 Changelog entry (`epics.md:5`, appended to the same list)

> - '2026-09-12 — Stories 7.10 and 7.11 appended to Epic 7 after the approved Sprint Change Proposal
>   2026-09-12 (Roster Trade rename, and the within-Team Roster Move). Requirements inventory amended
>   in place: **FR-41 renamed** *Record a Roster Move* → *Record a Roster Trade* with no change of
>   substance, **FR-44 added**, **AR-44 added**, **UX-DR41 added**; FR-42's membership-only scope given
>   an explicit placement clause; SM-2 and SM-7 extended. Epics 1–6 and 8–10 untouched; Stories 7.1–7.9
>   are NOT renumbered. The persisted event type `RosterMoveRecorded` is deliberately **not** renamed —
>   AD-4 forbids mutating the log. Amend this file in place; `bmad-create-epics-and-stories` would
>   overwrite it.'

#### 5.2.2 Requirements inventory — amendments in place

- `epics.md:77` (FR-41): title and body "Roster Move" → "Roster Trade", plus the provenance note.
- `epics.md:78` (FR-42): "proposed Roster Move or Drop" → "proposed Roster **Trade** or Drop", and the
  placement clause from §5.1.6 appended.
- `epics.md:79` (FR-43): "Refused on the same gate terms as FR-41" — unchanged, reads correctly.
- **ADDED after `:79`:**

  > FR-44: A **Manager** can move their **own** Team's Contracts between an Active/Bench Slot and a
  > Minor League Slot as **one act with one evaluation at the end**, and the **Commissioner** can do the
  > same on any Team's behalf. Only a Minor League Eligible Contract may occupy a Minor League Slot, and
  > **eligibility is remembered** — the pool's flag **union** every Contract the app has ever observed in
  > a Minor League Slot — so a demotion is reversible. Injury Reserve is not rearrangeable and Dead Money
  > is not a Slot. **Cap Hit follows placement**, so a Move is a deliberate cap decision that moves
  > Maximum Bid in **both** directions: demoting a stash can *raise* it by reducing Minors Exposure while
  > *lowering* Cap Space. No length is cleared. Both gates once, over post-Move state, through the
  > existing derivations; either failing **refuses all of it**, and it **never cancels a Bid**. A
  > Manager's act needs a confirmation sheet and **no reason**; the Commissioner's needs the reason sheet.
  > Refused while paused, refused in Setup and Archived. One transaction under the global lock, one event
  > carrying the whole delta, in the Audit Log, **not broadcast to Discord**. *(New 2026-09-12.)*

- **ADDED after AR-43 (`epics.md:168`):**

  > - **AR-44 — A Roster Move is the fourth command type and the third caller of the shared evaluator
  >   (AD-32, AD-1).** `RearrangeRoster` is declared in `core/types.ts` with its own gate set, per AD-1's
  >   per-command-type discipline. It calls `core/rules/roster-act.ts` — the module Story 7.8 extracted
  >   for exactly this — and writes **no** arithmetic of its own: no affordability check, no second
  >   Roster Reserve, no second Minors Exposure (AR-42). One difference from a Trade's arrival must be
  >   explicit or the two will be confused: **placement is taken from the command, not derived by
  >   `slotPlacementFor`.** FR-21's automatic rule is what a *close* and a *Trade arrival* apply; a Move
  >   is the Manager deliberately overriding it. **Eligibility is a fold, not a column** — the pool flag
  >   union every Minor League occupancy the log has ever carried, reconstructed from the reference-data
  >   snapshot exactly as AD-32 already specifies for rebuild, restore and replay. This is what makes the
  >   act reversible and is why FR-44 needs **no migration**.

- **ADDED after UX-DR40 (`epics.md:227`):**

  > UX-DR41: **One sheet shape, two controls, and they must never be one control with a conditional
  > field.** A Move's sheet shows before → after for **one** Team — Cap Space, Roster Count and all three
  > Slot occupancies — with every moved Contract named between them, both placements, both Cap Hits, and
  > **the direction Maximum Bid actually moved stated in words** with an `attention` note (§10 example 45
  > is why: the Team spends cap and gains bidding power, and no pair of figures says that out loud). A
  > **Manager** acting on their own Team gets a solid Manager commit control and **no reason field**; the
  > **Commissioner** acting on any Team gets Story 7.1's sheet — dashed, recessed, *"Commissioner ·
  > visible only to you"*, mandatory free text. DESIGN.md's four independent differences exist so the
  > referee control and the player control are never confusable by muscle memory at 4am, and a single
  > component that grows a reason field when `isCommissioner` is true is precisely the collapse that rule
  > forbids.

- Traceability table (`epics.md:275`): FR-41's row renamed; **ADDED** after FR-43's row:

  > | FR-44 | Epic 7 | Rearrange a Roster's Slot Placements — one Team, one act, one evaluation; Cap Hit follows placement (Story 7.11) |

#### 5.2.3 Epic 7 body

- Goal / "FRs covered" (`epics.md:368–372`): `FR-41, FR-42, FR-43` → `FR-41 … FR-44`; the prose
  sentence at `:368` and `:2026` gains *"and a Manager can rearrange their own Team's Minor League
  Slots."*
- `epics.md:378` (*"Why the roster work belongs here"*): **ADDED** —

  > *2026-09-12 extends the same argument to a third act.* Story 7.11 is a **Manager** control, which
  > stretches this epic's framing further than 7.6–7.9 did — but it is the **third caller** of
  > `core/rules/roster-act.ts`, and separating a story from the shared evaluator it exists to reuse would
  > re-create the duplication that extraction removed. Story 7.10 is a pure rename and belongs wherever
  > 7.7 does.
- Implementation order block (`epics.md:2028–2051`): **ADDED** at the end —

  > **7.10 then 7.11, after everything else in this epic that touches the trade code.** 7.10 is a
  > rename across ~470 identifier occurrences in 12 files and is best landed when no other story is
  > mid-flight in `core/rules/roster-*.ts`. 7.11 **must** follow it: building a new Move beside an
  > old Move about to be renamed means writing every import twice. 7.10 should also precede **7.9**,
  > whose ACs say *"proposes a Roster Move"* and will mean a Trade. Both touch `src/lib/core/`, so
  > **AD-20** applies to each: a pause, a green §10 suite and a recorded reason if deployed during a
  > live Auction Phase — which is the same argument this block already makes for 7.6–7.8, and the same
  > conclusion: land them before **Story 9.8** and ideally before **Story 9.7**.

#### 5.2.4 Story 7.7 — retitled, body unchanged in substance

**OLD:** `### Story 7.7: Record a Roster Move`
**NEW:** `### Story 7.7: Record a Roster Trade` — with *"(Renamed 2026-09-12 by Story 7.10. Shipped
2026-09-10 as 'Record a Roster Move'; no acceptance criterion changed.)"* beneath it, and "Move" →
"Trade" throughout its ACs.

**Rationale:** the story is `done` and its spec file is the record of what was built, so the spec is
left untouched; the epic entry is the living document and is corrected.

#### 5.2.5 Story 7.9 — wording only

`epics.md:2433`, `:2458`: "proposes a Roster Move pre-filled with both Teams" → "proposes a Roster
**Trade**"; "it never applies a Roster Move or a Drop itself" → "a Roster **Trade** or a Drop".
**ADDED** as one AC, from §5.1.6:

> **Given** a Team whose Fantrax placement differs from the app's
> **When** the detector runs
> **Then** it raises **nothing** — membership is the only fact, and from FR-44 the app **decides**
> placement while Fantrax receives it through the export, so a placement difference before that export
> is the expected state and not drift

#### 5.2.6 Story 7.10 — NEW

> ### Story 7.10: Rename the Roster Move to a Roster Trade
>
> As the Commissioner,
> I want the act that records a trade to be called a trade,
> So that the name "Roster Move" is free for the within-Team act that actually needs it.
>
> **Depends on:** Stories 7.7 and 7.8, both `done`. **Blocks** Story 7.11 and should precede 7.9.
>
> **This story changes no behaviour.** Every existing test must pass unchanged in meaning; the only
> edits to a test body are identifiers and file paths.
>
> **Acceptance Criteria:**
>
> **Given** the shipped trade recorder
> **When** it is renamed
> **Then** `src/lib/core/rules/roster-move.ts`, `src/lib/server/roster-move.ts` and
> `src/routes/roster-move/` become `roster-trade`, and the three test files beside them follow
> **And** the destination id `roster-move` becomes `roster-trade` in **both** phase lists
> (`server/destinations.ts`), with `tests/destinations.test.ts` updated in both
> **And** `tests/examples/example-36…39` keep their **file names** — they are PRD example numbers, and
> those examples are about trades — and change only their imports
>
> **Given** the persisted event type
> **When** the rename runs
> **Then** the string `'RosterMoveRecorded'` in `core/projection/contracts.ts` is **unchanged**, and
> carries a comment saying why: AD-4 forbids mutating or deleting an event, so a value already written
> to `auction_events.event_type` cannot be renamed without rewriting history
> **And** the **constant** holding it renames to `ROSTER_TRADE_RECORDED_EVENT`, so the code reads in the
> new vocabulary while the wire does not
> **And** a test asserts the literal string value, so a later well-meaning rename of the constant cannot
> silently change it
>
> **Given** the four type names shared by all three roster acts
> **When** they are renamed
> **Then** `MoveCapGateOutcome`, `MoveSlotsGateOutcome` and `MoveLeadingAuction` in `core/types.ts`
> become `ActCapGateOutcome`, `ActSlotsGateOutcome` and `ActLeadingAuction`, and
> `RosterMoveTeamFigures` in `core/projection/contracts.ts` becomes `RosterActTeamFigures`
> **And** they are named for `roster-act.ts`, which is what they actually belong to — renaming them to
> Trade would be as wrong as leaving them named Move
> **And** `describeMoveAmount`'s alias in the trade module is **deleted** rather than renamed; its 21
> call sites reach `roster-act.ts`'s `describeActAmount` directly, which is what the alias's own comment
> already says it is
>
> **Given** AD-32 in the architecture spine
> **When** it is amended
> **Then** its pre-existing drift is fixed in the same pass: it names the event `RosterMoved` while the
> code writes `RosterMoveRecorded`, and the spine is the rulebook
>
> **Given** the whole rename
> **When** it is complete
> **Then** `npm test` and `npm run check` both pass with **no test's assertion changed in meaning**, and
> `git grep -i "roster.move"` over `src/` returns only the deliberate wire-name string, its comment and
> its test
> **And** nothing named Move exists in `src/` when the story ends, which is what makes Story 7.11's
> vocabulary unambiguous

#### 5.2.7 Story 7.11 — NEW

> ### Story 7.11: Rearrange a Roster's Slot Placements
>
> As a Manager,
> I want to choose which of my eligible players occupy my three Minor League Slots,
> So that a trade does not leave me paying full price for a player I meant to stash.
>
> **Depends on:** Story **7.10** (hard — the vocabulary), Story 7.1 (the sheet), Story 7.7 (the
> evaluator it shares). **Not** 7.6, 7.8 or 7.9.
>
> **Acceptance Criteria:**
>
> **Given** a Manager and their own Team
> **When** they record a Roster Move
> **Then** it names **one Team** and one or more of its own Contracts, each with the Slot it is to
> occupy, and **no Contract changes hands**
> **And** the Team is resolved **from the session**, never from a form field, and a Manager naming
> another Team is refused server-side whatever the page rendered
> **And** the **Commissioner** may name any Team, through the Story 7.1 reason sheet
>
> **Given** a swap that fills a Slot the same act empties (§10 example 44)
> **When** it is evaluated
> **Then** **departures from every Slot are applied before any arrival is placed**, so the transient
> Minor League occupancy of 4 is never constructed and cannot be judged — the identical discipline
> `evaluateTrade` applies, and §10 example 44's refusal-when-sequenced is the regression test
> **And** the Team's figures are derived **once**, at the end, from the rows it is left holding
>
> **Given** a Contract named for a Minor League Slot
> **When** eligibility is checked
> **Then** the eligible set is the live pool's flag **union every Contract the app has ever observed in
> a Minor League Slot**, folded from the reference-data snapshot forward (AR-44)
> **And** a Contract demoted by an earlier Move **can be promoted back**, returning the roster to the
> state it held before — the round trip is an explicit test (§10 example 46)
> **And** an imported Active/Bench Contract never seen in minors and never in the pool is **refused by
> name**, worded as *the app has never been told he is eligible* — never as *he is ineligible*
> **And** demotion to Active/Bench requires no eligibility at all
>
> **Given** Injury Reserve and Dead Money
> **When** a Move names either
> **Then** it is refused: **IR is a Fantrax fact about a player's health**, not a placement this app
> assigns, and **Dead Money is not a Slot** (FR-43)
> **And** neither is offered by the picker, and the refusal is the rules core's rather than the screen's
>
> **Given** a placement that changes what a Contract charges
> **When** the Move commits
> **Then** **Cap Hit follows placement** through `chargedCapHit` — the one expression — so a promotion
> charges **$0** and a demotion charges the **full** amount, with the Contract's value untouched
> (AD-23)
> **And** **Minors Exposure recomputes** across every eligible Auction the Team leads, and Roster Count
> moves with Active/Bench occupancy
> **And** no assigned contract length is cleared and the Year Allotment is untouched — the Contract did
> not change hands
>
> **Given** a Move leaving the Team failing the money or slots gate
> **When** it is evaluated
> **Then** **the whole Move is refused and nothing is written**, naming the gate, the Auction and the
> arithmetic
> **And** the gates are `evaluateActCap` and `evaluateActSlots` **called, not copied** — this story
> writes no affordability check of its own (AR-42, AR-44)
> **And** **no Bid is cancelled**: AD-31's trigger stays a Close, and the sheet offers no control that
> would change that
>
> **Given** re-evaluation
> **When** it runs
> **Then** `RearrangeRoster` is a **fourth command type** in `core/types.ts` with its own gate set
> (AD-1)
> **And** placement is taken **from the command**, not derived by `slotPlacementFor` — FR-21's automatic
> rule is what a close and a Trade arrival apply, and a Move is the Manager deliberately overriding it
> (AR-44)
>
> **Given** the sheet
> **When** it renders
> **Then** it shows before → after for the one Team — Cap Space, Roster Count, all three occupancies —
> every moved Contract named with both placements and both Cap Hits (UX-DR41)
> **And** **the direction Maximum Bid moved is stated in words** with an `attention` note, because §10
> example 45 spends Cap Space to gain bidding power and no pair of figures says that out loud
> **And** a Manager's sheet is a **solid** Manager control with **no reason field**; the Commissioner's
> is dashed, recessed, labelled *"Commissioner · visible only to you"* and demands free text
> **And** they are **two controls**, not one with a conditional field (UX-DR41)
> **And** the act still works, and is still refused, with JavaScript switched off — `ReasonSheet.svelte`'s
> own discipline
>
> **Given** the phase and the pause
> **When** a Move is attempted
> **Then** it is live in the **Auction** and **Contract Assignment** Phases and refused in Setup and
> Archived
> **And** it is **refused while paused** (AD-13), worded as the pause and distinctly from every rules
> refusal — a Move changes Maximum Bids and a paused auction changes nothing
> **And** every guard runs on `load` **and** on the action; hiding a form is never the check
>
> **Given** the Move commits
> **Then** it is **one transaction under the global write lock** (AD-6) — a Move that moved two
> Contracts of three is never reachable
> **And** it mutates `team_rosters.roster_slot_kind` for Existing Contracts and appends **one** event
> carrying the **whole delta** — every Contract, both placements, both Cap Hits, the Team's figures
> before and after — so a replay reproduces the world as it stood (AR-41)
> **And** Auction Contracts have no row and move by the event alone, folded latest-placement-wins
> **And** it needs **no migration**: `roster_slot_kind` already admits all four values and
> `auction_events.event_type` is generic `text`
> **And** it is in the league-visible Audit Log with actor, timestamp, before/after and — for the
> Commissioner's form — the reason, and is **not broadcast to Discord** (FR-41's precedent)
>
> **Given** PRD §10 examples 44, 45 and 46
> **When** they run
> **Then** they pass as `tests/examples/` files, and **45 is the one that stops this being built as a
> flat rule**: a demotion that *lowers* Cap Space and *raises* Maximum Bid by $11,000,000 is the case a
> naive implementation gets backwards

### 5.3 Architecture spine — `ARCHITECTURE-SPINE.md`

**AD-32**, `:308–322`. The AD is sound and its reasoning carries to the new act unchanged; it is
renamed at the vocabulary level and gains one clause.

- **Title:** unchanged — *"The world changes by mutation plus record, and a world change refuses rather
  than cascades"* is already act-agnostic.
- **Binds:** `FR-41 – FR-43` → `FR-41 – FR-44`.
- Throughout the body, *"a Roster Move or Drop"* → *"a Roster Trade, Drop or Move"*, and the bullet
  *"A Roster Move is a third command type"* → *"A Roster Trade is a third command type, and a Roster
  Move a fourth"* with `RearrangeRoster` named.
- **Drift fixed:** `:313`'s `RosterMoved` → `RosterMoveRecorded`, matching
  `projection/contracts.ts:403`, with the new `RosterRearranged` added to the same list of
  reference-data-mutation events a reconstruction folds forward.
- **ADDED clause:**

  > - **A within-Team Move is the same machinery with one fewer Team and one more decision.** FR-44
  >   changes no rule in this AD: mutation plus record, one transaction under the global lock, the whole
  >   delta in the event, the existing gates called rather than copied, refuse rather than cancel. Two
  >   things are genuinely new. **Placement comes from the command, not from `slotPlacementFor`** —
  >   FR-21's automatic rule is what a close and a Trade arrival apply, and a Move is a Manager
  >   deliberately overriding it; a Move that re-derived placement would silently undo itself. And
  >   **Minor League eligibility becomes a fold rather than a present-tense read.** "Sitting in a Minor
  >   League Slot is the eligibility statement" is sound while occupancy is only ever read, and unsound
  >   the moment an act can *empty* the slot: it would make every demotion irreversible. The eligible
  >   set is therefore the pool's flag **union every Minor League occupancy the log has ever carried**,
  >   reconstructed from the reference-data snapshot by the same forward fold this AD already specifies
  >   — which is why FR-44 needs no column and no migration, and is the third instance of this AD's own
  >   lesson that **the record is not merely for audit**.

- **Requirements map** (`:532`): the FR-41/FR-43 row's title becomes *"Roster Trades, Drops & Moves
  (FR-41, FR-43, FR-44; CAP-22)"*, adds `core/rules/roster-act` to its modules and `routes/` beside
  `routes/admin` (the Manager form is not an admin route), and drops *"one migration"* for the new work.

### 5.4 UX — `DESIGN.md` and `EXPERIENCE.md`

**DESIGN.md**, after the *Override reason sheet* section (`:238`), **ADDED**:

> ### Manager confirmation sheet
> The Manager-side counterpart, and the only sheet in the product that is **not** a Commissioner
> control. Introduced for the Roster Move (FR-44), which a Manager performs on their own Team. Shows
> **before → after** for that one Team — Cap Space, Roster Count and all three Slot occupancies — names
> every moved Contract with both placements and both Cap Hits, and states **the direction Maximum Bid
> moved in words** with an `{colors.attention}` note where it is counterintuitive, which for this act is
> most of the time. **No reason field**: a Manager's strategic decision is not a referee intervention,
> and demanding a justification for it would be the product asking a manager to explain himself to
> himself. The commit control is a **solid** Manager control.
>
> **The two sheets are two components.** A single sheet that grows a dashed border and a reason field
> when the actor is the Commissioner would collapse the four independent differences the table above
> exists to maintain — and it would do it at the exact moment those differences matter, when the
> Commissioner is acting on somebody else's Team.

**DESIGN.md** Commissioner-control table: the `Commit` row's *"**Always** a reason sheet"* gains
*"(the Manager confirmation sheet below is a different object, not a variant of this one)"*.

**EXPERIENCE.md**:
- `:31` Auction destination list — add *Rearrange roster* after *Nominate*.
- `:133` — **OLD:** *"No Commissioner act is ever a single tap."* Unchanged, but **ADDED** after it:
  *"The converse is not true: not every sheet is a Commissioner act. The Roster Move (FR-44) is a
  Manager act with a confirmation sheet of its own — see DESIGN.md — and conflating the two would put a
  dashed referee control in a Manager's ordinary flow."*
- Key Flows — **ADDED** a short flow after the trade flow: a Manager opens Your Positions after an
  overnight trade, sees the arrived Contract charging full price, rearranges, and reads the recovered
  Cap Space on the persistent strip within a second.

**Control placement** — one open choice, recommendation stated: the Manager's control lives on their
**own Team view** (FR-25), because EXPERIENCE.md's rule is that controls live in place on the object
being acted on, with the act itself on `/roster-move` as a destination listed for **all** roles
(`commissionerOnly: false`). The Commissioner reaches the same route and picks a Team. The alternative
— hanging it off `/positions` — was rejected because Your Positions is about Auctions, not rosters.

### 5.5 `sprint-status.yaml`

Under `epic-7`, after `7-9-detect-a-roster-divergence-from-fantrax`:

```yaml
  7-10-rename-the-roster-move-to-a-roster-trade: backlog
  7-11-rearrange-a-roster-s-slot-placements: backlog
```

`epic-7` stays `in-progress`. `last_updated` → `09-12-2026`.

---

## 6. Implementation Handoff

### Scope classification: **Moderate**

Backlog reorganisation plus two new stories, requiring PO/DEV coordination. Not Minor — it adds a
requirement, an AR, a UX-DR and an AD clause. Not Major — no goal, epic boundary or architectural
decision is overturned, and AD-32 absorbs the new act without amendment to its rules.

### Handoff

| Recipient | Deliverable | Responsibility |
|---|---|---|
| **PO / DEV** *(you, Meakel)* | This proposal, approved | Apply §5.1–§5.5 to the five artifacts. The PRD, epics, spine and UX edits are **hand amendments in place** — `bmad-create-epics-and-stories` has no update path and would overwrite `epics.md` (its own changelog says so at `:5`) |
| **DEV** (`bmad-build`) | Story 7.10 | The rename. Mechanical, compiler-checked, behaviour-preserving. Verify with `npm test` + `npm run check` and the `git grep` assertion in its ACs |
| **DEV** (`bmad-build`) | Story 7.11 | The new act, **after** 7.10. New command type, new event, two sheet forms, three new `tests/examples/` files |
| **Architect** *(optional)* | AD-32's new clause | A review pass on §5.3 would be reasonable before 7.11 starts, since the eligibility-as-a-fold decision is the one genuinely architectural call here. Not a blocker |

### Success criteria

1. Nothing in `src/` is called a Move except the within-Team act; the only surviving `RosterMove`
   string is the deliberate wire name, commented and asserted by a test.
2. `npm test` and `npm run check` pass after 7.10 with **no assertion changed in meaning**.
3. PRD §10 examples 44, 45 and 46 exist as `tests/examples/` files and pass — **45 in particular**,
   which is the example a flat-rule implementation gets backwards.
4. A demote-then-promote round trip on an imported Contract returns the roster to identical state.
5. A Manager cannot rearrange another Team's roster, proven by a server-side test against a forged
   team id.
6. Both stories land before Story 9.8, and the moderator pilot (9.7) exercises both.

---

## 7. Risks accepted

| Risk | Mitigation / acceptance |
|---|---|
| **Audit Log volume.** Thirty managers rearranging freely could crowd the league-visible log, which is FR-41's *only* channel for announcing a rival's cap change | Accepted. No frequency cap: a Move is reversible and a cap is a rule nobody asked for. The log is already filterable by Team, Player and event type (FR-33). Revisit at Story 9.7 if the pilot shows the log becoming unreadable — the cheap remedy is a filter default, not a rule |
| **A Manager write path is new ground.** Managers today only nominate and bid; neither touches `team_rosters` | The guard shape is shipped and proven (`requireCommissioner` / `requireLiveDestination` / `requireOverridablePhase`), and the Team comes from the session. Story 7.11 carries an explicit forged-team-id test |
| **The app becomes authoritative over placement**, diverging from Fantrax until the next export | Stated as a positive decision in FR-44 and FR-42 rather than left implicit, and it is what the FR-30/FR-31 exports exist to reconcile. The alternative — Fantrax authoritative — would mean a Manager's rearrangement could be silently reverted by the next read |
| **The eligibility limitation is real.** An imported Active/Bench Contract never seen in minors cannot be promoted | Accepted as the cost of no migration. The refusal names it honestly and §10 example 46 pins the wording. If the league hits it in practice, the escalation is already scoped: a `minor_league_eligible` column on `team_rosters` plus a rostered-players tab on `/minor-league-eligibility`, as a separate story |
| **7.10's breadth.** ~470 identifier occurrences | TypeScript catches essentially all of it, the suite catches the rest, and the story changes no behaviour so any test failure is a real finding. The one hand-checked item is the wire-name string, which has its own AC and its own test |

---

*Produced by `bmad-correct-course` on 2026-09-12. Artifacts are amended **in place** by hand — see §6.*
