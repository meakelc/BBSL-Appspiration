# Sprint Change Proposal — Reverse an Auction Close

**Date:** 2026-09-23
**Author:** Meakel (with the Developer agent, `bmad-correct-course`)
**Mode:** Batch
**Change scope classification:** **Moderate** — one new story in Epic 7, a new FR-32 override with its PRD consequences, and one additive architecture decision. No completed story is reopened and nothing is rolled back.
**Status:** APPROVED 2026-09-23 by the Commissioner and applied the same day — PRD eleventh pass, spine AD-33, Story 7.13 in `epics.md` and `sprint-status.yaml`, deferred-work entry. The tenth-pass edits were committed first on their own (`27296ce`).

---

## 1. Issue Summary

**Trigger.** In the live 2026 auction, BKN won an Auction it could only have entered because **Ja Morant** was held in one of its Injury Reserve Slots. League rule: *during free agency an IR Slot may hold only a player not expected to start the season, whatever his Fantrax injury flag says.* Morant does not qualify. With him in Active/Bench, as the rule requires, BKN had no free Active/Bench Slot, so the capacity gate (FR-37) would have refused the Bid, and BKN should never have won.

**Classification.** A new requirement surfaced by stakeholders, meaning a league rule the app never encoded, meeting a **missing capability**: the app cannot undo an Auction Close. FR-32 lets the Commissioner void a Bid and terminate an Auction, but both apply only to a **live** Auction. Once an Auction closes, nothing in the product can take its Player back.

**Evidence.**
- `src/lib/core/projection/auctions.ts:1422` — `AuctionClosed` removes the Auction from the open-auctions fold entirely. A closed Auction has no live state left for a void to act on.
- `src/lib/core/projection/contracts.ts:909-916` — *"The FIRST close for a Player wins … In practice one cannot arrive."* The Contract is permanent by construction, and a later close for the same Player would be **silently ignored**.
- `src/lib/core/rules/nomination.ts:84-90` — the `under_contract` gate means the Player cannot be nominated again while that Contract stands.
- Story 7.2 (`epics.md:2128`) and Story 7.3 (`epics.md:2167`) both act on accepted Bids and live Auctions. Neither mentions a closed one.

**What is already in place.** Commit `370c026` (2026-09-21) made Injury Reserve a destination and a source for the **Commissioner's** Roster Move, so moving Morant from IR to Active/Bench needs no new code.

---

## 2. Impact Analysis

### Checklist record

| Item | Status | Finding |
| --- | --- | --- |
| 1.1 Trigger | [x] | Production incident, not a story. BKN's win, enabled by an IR placement the league rules forbid during free agency. |
| 1.2 Problem | [x] | New stakeholder rule plus a missing capability: no override reaches a closed Auction. |
| 1.3 Evidence | [x] | Above. |
| 2.1 Current epic | [x] | Epic 7 can still finish as planned. The change **adds** a story. |
| 2.2 Epic changes | [!] | Add Story 7.13. Put it at the front of Epic 7's build order. |
| 2.3 Remaining epics | [x] | No other epic changes. Epic 6 is touched only through the reason sheet's CAP-phase warning (below). |
| 2.4 Obsolete / new epics | [N/A] | None. |
| 2.5 Resequencing | [!] | 7.13 goes first. It depends only on 7.1, 7.5 and 7.11, all done, and **not** on 7.2, 7.3 or 7.4. |
| 3.1 PRD | [!] | FR-32 gains an act, FR-33 gains an entry type, and FR-44's IR clause is stale since `370c026`. |
| 3.2 Architecture | [!] | New **AD-33**. AD-4's binds and AD-5's idempotency sentence are touched. AD-20 bites at deploy (§5). |
| 3.3 UX | [!] | The control needs a place, and a closed Auction still has no page (deferred-work, spec-3-6). It goes on the won Contract's row instead (§4.4). |
| 3.4 Other artifacts | [!] | `sprint-status.yaml` and `deferred-work.md`. No migration: `auction_events.event_type` is generic `text`. |

### Epic impact
**Epic 7 only.** Story 7.13 is new, and the build-order table gains a row. Stories 7.2, 7.3 and 7.4 are **unchanged**. This story needs none of them, because termination involves no restoration and no clock.

### The rules decided by the Commissioner on 2026-09-23

1. **Outcome — terminate, back to the pool.** The reversed Auction ends with **no winner**, the Player returns to the Free Agent pool, and **every Bid on it is discarded**. No reopening, no restoration walk, no Auction Clock.
2. **FR-40 cancellations the Close caused stay standing.** Any of BKN's other leading Bids that the win cancelled stay cancelled, and whoever was restored stays restored. Those Auctions have moved on since, and BKN's true capacity (with Morant in Active/Bench) was lower anyway, so the cancellations match the corrected roster.
3. **BKN's Nomination Slot is re-held only if still free.** If the Close released a Slot BKN was holding (`releasedNominationSlot: true`) and BKN has not nominated since, the reversal takes the Slot back. If BKN has already used it, that Nomination stands and the reason sheet says so. FR-32: nothing accepted in the interim is invalidated.
4. **Morant leaves IR through the existing Commissioner Roster Move** (`370c026`). No new act is needed.

### Decisions this proposal makes by default — revise any of them before approving

5. **The League Clock is untouched.** A reversal is a termination, not a void. The Bids were accepted in good faith under the rules the app enforced, and removing their resets now could land the Phase's expiry in the past for the whole league. This matches FR-32's own line: *"a sooner phase end, never a rewritten history."*
6. **Order of operations: reverse first, then move Morant.** If BKN sits at Roster Count 12 including the illegal win, moving Morant into Active/Bench first would make 13, which the Move's own ceiling check refuses. The reason sheet for the reversal names the follow-up Move.
7. **A reversal is refused if the won Contract has since changed hands.** If it was traded (7.7) or dropped (7.8), the Commissioner must deal with that first. A Contract rearranged *within* the winning Team (7.11) does not block the reversal.
8. **The IR eligibility rule is not automated.** *"Not expected to start the season"* is a judgement, not something the app can derive from data, and Fantrax's flag is explicitly not the test. The Commissioner enforces it with the Roster Move that now exists. A deferred-work entry records this so a later reader doesn't take the missing check as an oversight.

### Artifact conflicts
- **PRD FR-32** — "terminate an Auction" is scoped to a live Auction, and nothing covers a closed one.
- **PRD FR-44 and §3 Roster Move** — *"Injury Reserve is not rearrangeable"* (`prd.md:506`, `:163`) has been false for the Commissioner since `370c026`. **Code led and the PRD fell behind**, the same pattern as the tenth pass.
- **ARCHITECTURE-SPINE AD-5** — *"replaying `AuctionClosed` must converge on the same contract rows"* was true under first-close-wins. A reversal can undo a Contract, so convergence has to be restated in terms of the reversal record, or a duplicated close replayed after its reversal brings the Contract back.
- **The code comment at `contracts.ts:909-916`** — *"In practice one cannot arrive"* stops being true once a reversed Player can be nominated and won again.

### Technical impact
- `core/rules/` — a new pure decision `decideCloseReversal` returning `Accepted | Rejected`, with refusal grounds: close not found, already reversed, Contract traded or dropped, archived.
- `core/projection/` — `contractsReducer`, `nominationsReducer` and the closed-Auction reads each learn one new case.
- `server/` — the command route (Commissioner guard, reason guard, AD-6 lock), plus re-inserting the Nomination Slot claim row in the same transaction when it is re-held (`20260914000000_nomination_slot_released_on_win.sql`).
- `adapters/discord/` — a broadcast case.
- The Audit Log (7.5) gains an entry type.
- **No migration.**

---

## 3. Recommended Approach

**Option 1 — Direct Adjustment. Selected.** Add one story inside Epic 7. Effort **Medium** (one event, one decision, three fold cases, one route, one sheet). Risk **Medium**: it touches `core/`, including the one fold, `contractsReducer`, whose invariants other folds rely on.

**Option 2 — Rollback. Not viable.** There is nothing to roll back. Every shipped story behaved as specified. The rule it ran into was never written down.

**Option 3 — MVP Review. Not needed.** Scope is unchanged, and this adds a Commissioner tool the league needs mid-auction.

**Rejected alternative: a general rewind to a point in history.** It is forbidden by AD-4 (insert-only) and by FR-32 (*"never a rewritten history"*). It would also undo every valid act by thirty other managers since that point. Reversing one Close with a compensating event is the smallest act that fixes BKN without touching anyone else.

**Rejected alternative: fixing it in the database.** AD-32's Deferred entry already records one such out-of-band repair holing every reconstruction. A second would make BKN's cap history unreproducible.

**Timeline.** It lands next, ahead of everything remaining in Epic 7. See §5 for the deployment problem this runs into.

---

## 4. Detailed Change Proposals

### 4.1 PRD — `prd.md`

**FR-32 opening sentence** (`prd.md:866`)

OLD:
> Commissioner can void a Bid, adjust a Team's Cap Space, terminate an Auction, release a Nomination Slot, extend or expire any Clock, and assign a contract length on a Team's behalf.

NEW:
> Commissioner can void a Bid, adjust a Team's Cap Space, terminate an Auction, **reverse an Auction Close**, release a Nomination Slot, extend or expire any Clock, and assign a contract length on a Team's behalf.

**FR-32 — new consequences**, inserted after the *"prospectively only"* bullet (`prd.md:873`):

> - **Reversing an Auction Close terminates the Auction after the fact.** *(Added 2026-09-23 — a Team won a Player it had room for only because a Contract sat in Injury Reserve against the league's free-agency rule.)* The winning Team's Auction Contract is removed, taking its Cap Hit and its Roster Count contribution with it, and the Player returns to the Free Agent pool, nominatable by anyone. The Auction ends with **no winner** and every Bid on it is discarded. It is shown as **Reversed**, with the Commissioner and the reason, never as a close that did not happen.
> - A reversal **undoes nothing else**. Bid Cancellations the Close caused under FR-40 stand, and so do their restorations. The League Clock is untouched, because the Bids earned their resets under the rules then enforced. A Nomination Slot the Close released is **re-held only if the Team has not used it since**; a Nomination made with it stands.
> - A reversal is **refused** when the won Contract has since been traded (FR-41) or dropped (FR-43), and names that act. A Contract moved within its own Team (FR-44) does not block it.
> - During the Contract Assignment Phase a reversal is still permitted, but the reason sheet states that the Team falls below twelve and cannot export (FR-30), and that the Player cannot be nominated again because the Auction Phase has ended. A length already assigned returns to the Year Allotment by arithmetic.

**FR-33 entries list** (`prd.md:883`)

OLD: `… Bid Cancellation and restoration (FR-40), Auction Close, Randomizer draw …`
NEW: `… Bid Cancellation and restoration (FR-40), Auction Close, **Close Reversal (FR-32)**, Randomizer draw …`

**FR-44 IR clause** (`prd.md:506`), a correction to code already shipped

OLD:
> - **Only an Active/Bench Slot and a Minor League Slot participate.** **Injury Reserve is not rearrangeable**: IR is a Fantrax fact about a player's health, not a placement this app assigns, and an app that moved a player out of it would be inventing a medical opinion. **Dead Money is not a Slot** and never participates (FR-43).

NEW:
> - **Active/Bench and Minor League Slots participate for a Manager; Injury Reserve participates for the Commissioner only.** *(Amended 2026-09-23 to match commit `370c026`.)* For a Manager, IR remains a Fantrax fact about health that this app does not reassign. The Commissioner is not inventing a medical opinion but **recording a designation the league has made**, including the league rule that during free agency an IR Slot may hold only a player not expected to start the season, whatever his Fantrax flag. That judgement is the Commissioner's and is never derived by the app. **Dead Money is not a Slot** and never participates (FR-43).

**§3 Roster Move glossary** (`prd.md:163`): `Injury Reserve is not rearrangeable` → `Injury Reserve is rearrangeable by the Commissioner only (FR-44, amended 2026-09-23)`.

**§0**: an eleventh-pass amendment block summarising the above. **§12**: one dated 2026-09-23 group recording decisions 5–8 as `[ASSUMPTION]`s confirmed by the Commissioner on approval of this proposal.

### 4.2 Epics — `epics.md`

**FR-32 inventory line** (`epics.md:106`): insert `reverse an Auction Close (the winner's Contract removed and the Player returned to the pool, nothing else undone),` after `terminate an Auction,`.

**Epic 7 summary** (`epics.md:2055`): after `terminate an Auction,` insert `reverse a Close that should not have stood,`.

**Build-order table** (`epics.md:2063`): new first row.

| Build | Story | Depends on | Note |
| --- | --- | --- | --- |
| **0 — urgent, live incident** | **7.13** Reverse an Auction Close | 7.1, 7.5, 7.11 (all done) | Added 2026-09-23. Needs none of 7.2 – 7.4. See the AD-20 note in the story |

**New story, appended after Story 7.12:**

```markdown
### Story 7.13: Reverse an Auction Close

*(New 2026-09-23, from `sprint-change-proposal-2026-09-23.md`. BKN won an Auction it had room for only because Ja Morant sat in an Injury Reserve Slot, against the league's rule that during free agency IR holds only a player not expected to start the season. Nothing in the product could take a closed Auction's Player back.)*

As the Commissioner,
I want to reverse a Close that should not have stood and return its Player to the pool,
So that a win the rules would have refused is undone in the open, without rewriting anything anybody else did.

**Acceptance Criteria:**

**Given** a closed Auction whose Auction Contract is still held by its winning Team
**When** the Commissioner reverses its Close
**Then** one `AuctionCloseReversed` compensating event is appended, naming the reversed `AuctionClosed` by `seq`, the Player, the Team, the winning amount, the Cap Hit, the Contract's current placement, whether a Nomination Slot is re-held, and the reason
**And** the original `AuctionClosed`, and every `BidPlaced` and `BidCancelled` before or after it, are **never** deleted or mutated (AD-4)
**And** the reason sheet is mandatory, per Story 7.1

**Given** a reversed Close
**When** the projections fold it
**Then** the winning Team no longer holds the Contract: its Cap Hit leaves Cap Space and, where it sat in Active/Bench, Roster Count falls by one
**And** the Player is nominatable again by any Team, because the `under_contract` gate no longer finds him
**And** the fold remembers **which close `seq`s are reversed**, so a re-folded duplicate of the reversed close never brings the Contract back, and a later, genuine close of the same Player produces a fresh Contract (AD-5, AD-33)

**Given** the Close had released the winning Team's Nomination Slot (`releasedNominationSlot: true`)
**When** the reversal commits
**Then** the Slot is re-held **only if the Team holds none now**, and its claim row is re-inserted in the same transaction
**And** if the Team has since nominated with it, that Nomination stands, nothing is re-held, and the reason sheet says so in words

**Given** Bid Cancellations the Close caused under FR-40
**When** the Close is reversed
**Then** they and their restorations stand unchanged, and the reason sheet lists each one as not undone
**And** the League Clock is not recomputed; no reset is removed

**Given** the won Contract has since been traded (Story 7.7) or dropped (Story 7.8)
**When** a reversal is attempted
**Then** it is refused as a machine-readable rejection naming the act, the date and the Team now holding the Player
**And** a Contract moved between Slots within its own Team (Story 7.11) does **not** block it: the reversal removes it from whichever Slot it now occupies

**Given** a Close already reversed, or an archived auction
**When** a reversal is attempted
**Then** it is refused

**Given** the reason sheet
**When** it renders
**Then** it names the act in Georgia, *Reverse this Close*
**And** it shows before → after for the Team's Cap Space, Available Cap Space, Maximum Bid, Roster Count and Nomination Slot
**And** an `attention` note states in words that the Player returns to the pool, that nothing else is undone, and, where the Team has a Contract in Injury Reserve, that a Roster Move is the separate next step
**And** during the Contract Assignment Phase it also states that the Team falls below twelve and cannot export until it is resolved

**Given** where the control lives
**When** it is placed
**Then** it sits **on the won Auction Contract's row** on the Team's roster, beside the Commissioner Roster Move, in the Commissioner control class
**And** not on a closed-Auction page, which does not exist yet (deferred-work, spec-3-6)

**Given** a reversal
**When** it is broadcast and logged
**Then** it is posted to Discord with the actor and reason, and the winning Team's Managers are mentioned
**And** the Audit Log shows it as a distinct **Close Reversal** entry, filterable by Team, Player and event type
**And** the closed Auction reads **Reversed** wherever its outcome is shown

**Given** the §10 suite
**When** it runs
**Then** a new example passes as a named test: Team R wins Player X at $4,000,000 into Active/Bench, reaching Roster Count 12; the Close cancels Team R's lead elsewhere and restores Team S; the Close is reversed → Team R's Roster Count is 11, its Cap Space is back up by $4,000,000, Player X is nominatable, Team S still leads the other Auction, and the League Clock's expiry is unchanged

**Deployment (AD-20).** This story touches `src/lib/core/` during a live Auction Phase. See the note in the sprint change proposal; the recorded reason is required.
```

### 4.3 Architecture — `ARCHITECTURE-SPINE.md`

**New AD-33**, after AD-32:

```markdown
### AD-33 — A Close is reversed by a compensating event, and a reversal undoes exactly one thing

- **Binds:** FR-32, FR-33; `core/projection/contracts.ts`, `core/projection/nominations.ts`, `core/rules/`; AD-4, AD-5, AD-6, AD-31, AD-32; Story 7.13
- **Prevents:** a Close undone by deleting or editing the log, a Contract that comes back when a reversed close is folded again, and a reversal that grows into cross-Auction surgery
- **Rule:** reversing a Close appends **one** `AuctionCloseReversed` naming the reversed close's `seq`. The Auction ends with no winner and the Player returns to the pool. That is **all** it does. It does **not** unwind the FR-40 cancellations the Close caused, does **not** touch the League Clock, and does **not** reopen the Auction. Each of those would be a second rule meeting reality, and the league chose termination precisely so that none of them is needed (2026-09-23).
- **Convergence is restated, not abandoned.** AD-5's *"replaying `AuctionClosed` must converge"* held under first-close-wins. `contractsReducer` now keeps the set of **reversed close `seq`s**: a close in that set yields no Contract whatever order or multiplicity it is folded in, and a close not in it yields one as before. A Player can therefore hold at most one live Auction Contract at a time without assuming he is only ever won once.
- **A reversal is a world change for the winning Team and refuses rather than cascades (AD-32).** It can only *free* capacity and cap, so it can trigger nothing. It is refused, never adapted, when the Contract has since moved to another Team or been dropped.
- **No migration.** `auction_events.event_type` is generic `text`. The Nomination Slot claim is re-inserted into its existing table, in the appending transaction, through the projection seam `server/nomination.ts` already uses.
```

**AD-4 Binds** (line 90): `…phase transitions, overrides; FR-32, FR-33` → `…phase transitions, overrides **including a Close Reversal (AD-33)**; FR-32, FR-33`.

**AD-5 last sentence** (line 98): append `*(Since 2026-09-23, "converge" means modulo the reversed-close set of AD-33: a reversed close yields no row however often it is replayed.)*`

### 4.4 UX — `EXPERIENCE.md`

No new pattern. The control follows Story 7.1's *"in place, on the object being acted on."* The object is the won Contract, and its row already carries the Commissioner Roster Move from `370c026`. **The one open UX fact:** a closed Auction has no page (deferred-work, spec-3-6), so *"reads Reversed wherever its outcome is shown"* today means the Board's closed card, the Audit Log and Discord. It will also cover the closed-Auction page when that is built.

### 4.5 Implementation artifacts

- **`sprint-status.yaml`**: after `7-12-…: done`, add `7-13-reverse-an-auction-close: backlog`.
- **`deferred-work.md`**: new entry. *"The free-agency IR eligibility rule — during free agency an IR Slot may hold only a player not expected to start the season, whatever his Fantrax flag — is enforced by the Commissioner's Roster Move, not by the app. Deliberately not automated: 'expected to start' is a judgement no data source carries, and Fantrax's flag is explicitly not the test. Evidence: the BKN / Ja Morant incident of 2026-09-23. Revisit only if the league adopts an objective test."*
- **Code comment** `src/lib/core/projection/contracts.ts:909-916`: rewritten as part of Story 7.13, not by this proposal.

---

## 5. Implementation Handoff

**Scope: Moderate.** Backlog change plus PRD and spine edits, then a Developer story.

| Role | Responsibility |
| --- | --- |
| **PM (`bmad-prd`, update intent)** | Apply §4.1 as the PRD's eleventh pass. Note that the tenth pass (2026-09-18) is **still uncommitted** in the working tree; commit it first so the two passes stay separable in history |
| **Architect (`bmad-architecture`)** | Add AD-33 and the AD-4 and AD-5 amendments in §4.3 |
| **PO / SM (`bmad-sprint-planning`)** | Add 7.13 to `sprint-status.yaml` and the build-order row. Apply §4.2 to `epics.md` |
| **Developer (`bmad-build`)** | Build Story 7.13 |
| **Commissioner (you)** | After 7.13 ships: reverse BKN's Close with the reason, then Roster Move Ja Morant from IR to Active/Bench |

**AD-20 cannot be satisfied as written, and you should decide how before the deploy.** A `core/` deploy during a live Auction Phase requires a **pause (AD-13)**, and pause is Story 7.4, which is **still backlog**. The options:

- **(a)** Deploy in a quiet window with the §10 suite green and a **recorded reason** stating that no pause exists. That is the same exposure every `core/` deploy since the auction opened has carried.
- **(b)** Build 7.4 first, which delays the BKN fix by a story.

**(a) is the honest choice for one incident. (b) is the right one for the next.** Either way, record it.

**Success criteria.**
1. The new §10 example passes, and the §10 suite, `npm test` and `npm run check` are all green.
2. In production: BKN's won Player shows as nominatable, BKN's Cap Space and Roster Count show the reversal, the Audit Log and Discord show a Close Reversal with the reason, and the League Clock expiry is unchanged.
3. The follow-up Roster Move puts Morant in Active/Bench, and BKN's Roster Count returns to 12.
4. A full projection rebuild (AD-5) reproduces the same state.
