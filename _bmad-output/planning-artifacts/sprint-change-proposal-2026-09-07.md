# Sprint Change Proposal — The Outstanding Bid Allowance

**Date:** 2026-09-07
**Author:** Correct Course workflow, with Meakel
**Change scope classification:** **Major** — a core rule change (FR-37) plus a new domain mechanism, reopening settled clauses in four completed epics and invalidating part of the executable §10 suite.
**Status:** **APPROVED by Meakel, 2026-09-08.** Approved as written, including the `F ≥ 1` precondition assumption recorded at §1.5 — that precondition is now a settled requirement, not an open question.

---

## 1. Issue Summary

### 1.1 The problem

A league rule was never recorded in the PRD and never reached the build. It is not a refinement of what shipped — it contradicts it in two places.

**The rule, as stated by the commissioner:**

> Managers are actually allowed to have +1 outstanding bid over their available roster spots (in order to speed up the auction). If they win the players that fill out their remaining roster spots, their last remaining outstanding bid is canceled, and the next highest bid becomes the leader again. Outstanding bids are still restricted by total cap space however. Managers can also participate in unlimited minimum contention lotteries if they have at least one roster spot open (as the most likely outcome for most managers in a lottery is losing).

### 1.2 Why it matters

The rule exists to make the auction **finish**. Under the shipped rule a team with two open slots may lead at most two auctions; every manager is therefore serialised behind their own wins, and a 30-team auction with a 24-hour clock crawls. The allowance lets each manager keep one more iron in the fire than they have slots for, at the price of a bid that may be taken away from them.

The lottery clause is the same argument at higher volume: a contender's expected outcome is losing, so restricting lottery entries to open slots throttles the mechanism designed to clear cheap players quickly.

### 1.3 How it was discovered

Reported directly by the commissioner during Epic 9 setup preparation, on 2026-09-07 — as an omission from the requirements, not as a defect found in testing. This is the **third** instance of the pattern already recorded twice in `ARCHITECTURE-SPINE.md` §"Conflicts to Resolve Upstream": a rule invisible through every requirements review and obvious the moment someone described what they actually do. The first two were the thirty-one-file import and the Teams index.

### 1.4 What it contradicts, precisely

| Shipped artifact | Current statement | Status under the new rule |
|---|---|---|
| PRD FR-37 | A Bid is refused when `Roster Count + Projected Active/Bench Additions > 12` | **Superseded** — the ceiling rises by one, with a precondition |
| PRD FR-37 | "A Team at Roster Count 12 cannot bid on any Player who is not Minor League Eligible" | **Still true**, but now for a different reason (see §1.5) |
| PRD FR-15 | "A Bid, once accepted, cannot be withdrawn… Only a Commissioner override (FR-32) can void an accepted Bid" | **Superseded** — the system now cancels bids on its own |
| PRD FR-14 | "Committed capital is released the instant the Team ceases to be Leading Bidder" | **Widened** — a Team can now cease to be Leading Bidder without being outbid |
| PRD FR-18 | A contention entry adds $1,000,000 to Committed Bids | **Unchanged on money**, but the entry leaves the slots gate entirely |
| PRD FR-20 | The draw records "the ordered Contender list as it stood at expiry" | **Sharpened** — the list at expiry may now exclude cancelled contenders, and may be empty |
| PRD FR-21 | Close awards the Player and increases Roster Count | **Widened** — a close can now also cancel bids on *other* auctions |
| `src/lib/core/rules/bidding.ts:1429` `evaluateSlots` | `team.rosterCount + projectedAdditions <= ACTIVE_BENCH_SLOTS` | **Superseded** |

### 1.5 The finding that changed the rule's shape

**A flat ceiling of 13 breaks the invariant FR-37 exists to protect.**

If the gate becomes simply `Roster Count + Projected Active/Bench Additions ≤ 13`, then a Team at Roster Count 12 may hold one outstanding bid. The cancellation cascade cannot save it: cancellation fires when a *close* fills the roster, and if that bid is the only one the Team holds, no other close ever occurs. The Team wins it and lands on **Roster Count 13** — a state FR-30 will then refuse to export, discovered on export day.

The allowance is only safe when a win is guaranteed to trigger the cancellation before a second win can land. That requires a floor: **at least one open Active/Bench Slot is a precondition for holding any Active/Bench-bound commitment at all.** This is the same shape as the lottery clause the commissioner stated in the same sentence — "if they have at least one roster spot open" — so the two halves of the rule are one rule.

`[CONFIRMED by the commissioner, 2026-09-08 — the +1 allowance carries a "≥ 1 free Active/Bench Slot" precondition, and this is now a settled rule rather than an inference. Original reasoning retained: This is the only reading under which the hard 12-ceiling survives, and it matches the precondition the commissioner stated explicitly for lotteries. If the commissioner intends a Team at Roster Count 12 to be able to hold a bid it could win, then FR-30's export requirement of exactly 12 must change instead, and that is a larger conversation.]`

---

## 2. The Rule, Formally

Notation follows the PRD §3 glossary verbatim, per AD-2's domain-vocabulary convention.

Let, for a Team at the moment a prospective Bid is evaluated:

- `R` = **Roster Count**
- `F` = **Free Active/Bench Slots** = `12 − R`
- `M` = **Free Minor League Slots**
- `P` = **Projected Active/Bench Additions** — post-bid, counting the Bid being placed: leading amounts on open non-eligible Auctions, plus **Overflow Count**, **excluding Minimum-Bid Contention entries**
- `A` = **Outstanding Bid Allowance** = `1`

### 2.1 The slots gate

```
passes  ⟺  P = 0  ∨  ( F ≥ 1  ∧  P ≤ F + A )
```

Equivalently: `P = 0 ∨ (R ≤ 11 ∧ R + P ≤ 13)`.

- The `P = 0` branch is the **existing** FR-37 carve-out, preserved unchanged: an eligible Bid a Free Minor League Slot absorbs adds nothing to Active/Bench, so a Team at Roster Count 12 with `M ≥ 1` may still stash.
- The `F ≥ 1` precondition is §1.5.
- `A` is a named league constant beside `ACTIVE_BENCH_SLOTS`, not an inline `+ 1`.

### 2.2 The contention gate

A Team may enter or join a Minimum-Bid Contention when the win it would create has somewhere to land:

```
passes  ⟺  F ≥ 1  ∨  ( Player is Minor League Eligible  ∧  M ≥ 1 )
```

Unlimited in number. Contention entries **never** contribute to `P`.

Money is untouched: FR-14's $1,000,000 per non-eligible contention still reaches Committed Bids, and an eligible contention still contributes an Eligible Leading Bid of $1,000,000 feeding Minors Exposure. **Cap space remains the only quantitative limit on lottery participation**, exactly as the commissioner stated.

### 2.3 The cancellation cascade

Triggered by an **Auction Close that reduces the winning Team's free slots** — Active/Bench *or* Minor League. Not by any other event; never by a restoration.

```
while the Team's surviving commitments violate §2.1 or §2.2:
    cancel the most recent surviving commitment, by descending log `seq`
    append BidCancelled, carrying its restoration decision
```

Runs **inside** AD-11's sequential close loop, each cancellation committed to the state the next close is evaluated against. That ordering is what makes unlimited lottery participation safe: a Team in ten simultaneously-expiring lotteries that wins the first has its remaining nine entries cancelled *before* they are drawn.

`[NOTE: the trigger includes Minor League placements deliberately. A Team at Roster Count 12 with M=1 may hold eligible contentions under §2.2; when it wins one, M drops to 0 and the remainder have nowhere to land. A trigger reading only "Active/Bench" would miss this and produce a Roster Count of 13.]`

### 2.4 Restoration

For each cancelled commitment on an Auction in Standard Contention:

1. Take the next-highest surviving Bid in the Auction's history.
2. Re-evaluate the **cap** and **slots** gates for that Team against current committed state.
3. If it passes, that Team becomes Leading Bidder and its capital is re-committed.
4. If it fails, cascade to the next-highest surviving Bid and repeat.
5. If no Bid survives, the Auction returns to **Awaiting Opening Bid**, and terminates unclaimed at expiry under FR-22's existing rule.

The **Auction Clock is not altered** — a cancellation is not a Bid, and AD-22 admits only a Nomination or a valid Bid as a reset.

The **League Clock is not altered either**, and this is where a cancellation differs sharply from Story 7.2's void: a voided Bid loses its League Clock reset because it should never have stood; a cancelled Bid keeps its reset because it was entirely valid when placed. Nothing is being rewritten — a legitimate bid is being stood down.

For a cancelled contention entry, there is no restoration: the Team is removed from the Contender list, its $1,000,000 released, and the lottery proceeds among the remainder — or terminates unclaimed if none remain.

### 2.5 Worked consequence — the price of the rule

A Team at Roster Count 11 holding two leading bids and nine lottery entries wins one lottery. Roster Count reaches 12, `F` reaches 0, and the cascade cancels **both leading bids and all eight remaining entries** — ten cancellations from one win, each with its own restoration. This is correct and it is the accepted cost of unlimited lottery participation. Section 5's UX work exists because a manager must not meet this for the first time as a surprise.

---

## 3. Impact Analysis

### 3.1 Epic impact

| Epic | Status | Impact |
|---|---|---|
| Epic 1 — Foundations | done | **None.** Import ceilings (FR-1) are starting-state checks against 12/2/3 and are unaffected; the allowance governs bids, never rosters. |
| Epic 2 — Nomination and bidding | done | **Clauses superseded** in 2.7 (the ceiling), 2.6 (refusal panel wording, the now-reachable Roster Reserve clamp), 2.8 (`Overflow Count` is consumed by two gates that must now disagree — see 5.5.1). |
| Epic 3 — Clock, contention, closing | done | **Clauses superseded** in 3.2 (entry leaves the slots gate), 3.4 (close acquires the cascade), 3.6 (contender list at expiry, empty-lottery case). |
| Epic 4 — The board | done | **Additive.** Every surface publishing `Free Active/Bench Slots` must now also publish outstanding commitments against the allowance, or a manager cannot tell whether they may bid. |
| Epic 5 — Notifications | done | **Additive.** Cancellation and restoration need a broadcast and a mention; must map onto spec 5-4's three categories without adding a fourth. |
| Epic 6 — Contract assignment | in-progress (6.3–6.5 backlog) | **None.** The allowance is resolved before the Auction Phase ends. |
| Epic 7 — Commissioner controls | backlog | **Beneficial.** Story 7.2 "Void a Bid and restore the Auction" already specifies restoration; it should consume this change's machinery rather than build its own. See 5.5.2. |
| Epic 8 — Recovery | backlog | **Minor.** 8.1's synthetic-clock replay must cover a cancellation cascade; 8.3's outside-Supabase reconstruction must fold `BidCancelled`. |
| Epic 9 — Go-live | in-progress (9.7, 9.8 backlog) | **Sequencing.** See 3.5. |

No epic is invalidated. No epic becomes obsolete. One new epic is proposed (§4.2).

### 3.2 Artifact conflicts

**PRD** — the largest surface. Glossary (four terms amended, three added), FR-11, FR-14, FR-15, FR-17, FR-18, FR-20, FR-21, FR-37, FR-39, §9 risk register, and §10 examples 23–25 revised with 29–35 added. Detailed in §5.1.

**Architecture spine** — AD-11 and AD-22 amended, one new AD, AD-2's gate-set list extended, AD-25's example suite grown. Detailed in §5.2. **AD-4 needs no change**: `auction_events.event_type` is a generic `text` envelope, so `BidCancelled` requires **no migration**.

**UX** — `EXPERIENCE.md` lines 89, 127, 137, 280 and 294 all quote "of 12" or the two-gate refusal wording; `DESIGN.md`'s refusal panel and the `Roster N of 12` line both need a second figure. Detailed in §5.3.

**Code** — `src/lib/core/rules/bidding.ts` (`evaluateSlots`, `projectedAdditionsFor`, `minorsCountsFor`, the refusal renderers, `SlotsGateOutcome`), `src/lib/core/rules/close.ts` (`decideClose`), `src/lib/core/projection/auctions.ts` (the reducer's leading-bid selection), `src/lib/core/constants.ts`, `src/lib/core/team-view.ts` and `teams-index.ts` (the display figures), plus the outbox dispatch. No schema migration.

### 3.3 Technical impact

Confirmed favourable:

- **The event envelope is generic.** `event_type` is `text` with a not-blank constraint (`supabase/migrations/20260821020000_auction_events.sql:63`). No migration.
- **Full bid history is already retained.** `projection/auctions.ts` keeps every `BidPlaced` — *"the highest Bid leads, and history keeps everything"* — so "the next highest bid becomes the leader again" is reconstructible from the existing fold. Nothing new must be stored to make restoration possible.
- **AD-11's sequential close loop already exists** and is precisely the ordering the cascade needs.
- **The gate set is a declared list** in `core/types.ts`, designed so that adding a gate or a command type "edits ONE list and every consumer becomes a compile error". The restoration re-validation is that edit.

Confirmed unfavourable:

- **The two gates must stop sharing `minorsCountsFor`.** See 5.5.1 — the sharpest risk in this change.
- **The `evaluate()` entry point takes a `PlaceBid` command.** Restoration re-validation needs a second command type with its own declared gate set.
- **The §10 suite is executable** (AD-25). Examples 18–25 must all be re-verified, not merely 23–25.

### 3.4 The cascade terminates

Worth stating because it is the first place a reviewer will look for a loop:

- Cancellation is triggered **only** by a close that reduces free slots — never by a restoration. A restoration cannot cause a cancellation.
- Each cancellation strictly reduces the Team's surviving commitment count.
- A restoration is validated *before* acceptance; a restored Team that would breach its own capacity is skipped, not cancelled.
- Re-committing capital never invalidates an already-accepted Bid, per FR-35's standing rule that the app refuses the new bid and never retroactively invalidates an accepted one.

Each auction is therefore visited a bounded number of times and the history is finite.

### 3.5 Timing — this must land before the auction opens

**AD-20** fail-stops rule changes during a live Auction Phase: any deploy touching `core/` while an auction runs requires a pause (AD-13), a green §10 suite (AD-25), and a recorded reason — because AD-4 forbids deleting events, so a bad rules deploy cannot be rolled back by reverting code.

Story 9.7 (the moderator pilot) and 9.8 (prod setup day) are both `backlog`. **No auction is live.** The cost of this change is at its floor right now and rises steeply the moment 9.8 completes.

Stronger still: the pilot's purpose is to exercise the real rules with real managers, and this rule is specifically about auction *speed* — the property a pilot is best placed to measure. Landing it after the pilot means piloting rules the league will not play under.

**Recommended sequence: Epic 10, then 9.7, then 9.8.**

---

## 4. Recommended Approach

### 4.1 Path selection

| Option | Assessment |
|---|---|
| **1 — Direct adjustment** | **Viable and recommended.** No shipped work needs reverting; the change supersedes clauses and adds a mechanism. Effort **High**, risk **Medium**. |
| **2 — Rollback** | **Not viable, and not needed.** Stories 2.7 and 3.4 are correct implementations of the rule as recorded; they are not defective, they are incomplete. Reverting them would discard working cap, exposure and close logic to rebuild it identically around one changed comparison. |
| **3 — MVP review** | **Not viable.** The rule *is* MVP: it exists to make the auction terminate in reasonable time, which is Success Metric territory. Deferring it ships an auction the league will not run. |

**Selected: Option 1, Direct Adjustment**, structured as a new epic rather than as edits to completed ones.

**Why a new epic and not amendments to Epics 2 and 3.** The specs under `_bmad-output/implementation-artifacts/` are the record of what was built and verified, and `sprint-status.yaml` has no "reopened" state. Setting seven `done` stories back to `backlog` destroys that audit trail and misrepresents the history — those stories were completed correctly against the rule as it was written. A new epic whose stories explicitly **supersede named clauses** in 2.6, 2.7, 2.8, 3.2, 3.4 and 3.6 keeps both records intact and gives the change a retrospective of its own.

### 4.2 Proposed Epic 10 — The Outstanding Bid Allowance

Six stories, sequenced by dependency.

| Story | Title | Supersedes | Difficulty |
|---|---|---|---|
| **10.1** | The outstanding bid allowance in the slots gate | 2.7 | Medium |
| **10.2** | Lottery entries leave the slots gate | 3.2, 2.8 | Medium |
| **10.3** | Cancel the surplus commitment at close | 3.4 | High |
| **10.4** | Restore the next-highest bidder | 3.4, 3.6 | **Highest** |
| **10.5** | A lottery whose contenders were cancelled | 3.6 | Medium |
| **10.6** | Say it on the board and in Discord | 4.2–4.6, 5.2, 5.3 | Medium |

**Overall effort: comparable to Epic 3.** Story 10.4 alone carries most of the risk — it is the only genuinely new domain mechanism in the change.

---

## 5. Detailed Change Proposals

### 5.1 PRD

#### 5.1.1 Glossary (§3)

**AMEND — Roster Capacity**

> OLD: the constraint `Roster Count + Projected Active/Bench Additions ≤ 12`.
>
> NEW: the constraint `Projected Active/Bench Additions = 0`, **or** the Team has at least one Free Active/Bench Slot and `Projected Active/Bench Additions ≤ Free Active/Bench Slots + Outstanding Bid Allowance`. A Bid that would breach it is refused regardless of the Team's cap position. Independent of Maximum Bid. See FR-37.

**AMEND — Projected Active/Bench Additions**

> Add: **Minimum-Bid Contention entries are excluded.** A contention entry is governed by the separate rule in FR-18 and contributes nothing to this count, however many the Team holds.

**AMEND — Free Active/Bench Slots**

> Replace *"A display figure only… never authorises a Bid"* with: a display figure and **the base of the Outstanding Bid Allowance**. It still never authorises a Bid on its own — Roster Capacity is the gate — but it is now the figure the allowance is measured against, and every surface publishing it must publish the Team's outstanding commitments beside it.

**AMEND — Committed Bids** — add: capital is released when a Team ceases to be Leading Bidder **for any reason, including a Bid Cancellation**, not only on being outbid.

**ADD — Outstanding Bid Allowance** — the one Bid a Team may hold beyond its Free Active/Bench Slots, so that it need not wait for one auction to close before entering the next. Requires at least one Free Active/Bench Slot; a Team with none may hold no Active/Bench-bound commitment at all. Constrained by cap space like any other Bid.

**ADD — Bid Cancellation** — the system standing down a Team's Bid, without that Team's consent and without a Commissioner acting, because an Auction Close has left the Bid with no Roster Slot to land in. Distinct from a Commissioner void (FR-32): the cancelled Bid was valid when placed, remains in the Auction's history, and keeps its League Clock reset.

**ADD — Restored Leading Bidder** — the Team whose earlier Bid becomes the leading Bid again after a Bid Cancellation.

#### 5.1.2 FR-37 — Enforce Roster Capacity

> **REPLACE** the first three consequence bullets with:
>
> - A Bid is refused unless **either** `Projected Active/Bench Additions = 0`, **or** the Team holds at least one Free Active/Bench Slot and `Projected Active/Bench Additions ≤ Free Active/Bench Slots + 1` — computed as though the prospective Bid were already placed, the same post-bid basis Roster Reserve uses.
> - The `+ 1` is the **Outstanding Bid Allowance**, and it exists to speed the auction: a Manager may pursue one more Player than they have room for rather than idling until a close.
> - The allowance is **not a thirteenth Roster Slot.** A Team may never hold more than 12 Active/Bench players; the extra Bid is cancelled under FR-40 the moment a win leaves it nowhere to land.
> - **At least one Free Active/Bench Slot is a precondition.** A Team at Roster Count 12 holds no Active/Bench-bound commitment at all, because a Bid it could win would breach the ceiling with nothing available to cancel it first.
> - This remains a **second, independent refusal ground alongside Maximum Bid**. Both are evaluated on every Bid; neither subsumes the other. `[unchanged]`
> - A Team at Roster Count 12 still **can** bid on a Minor League Eligible Player a Free Minor League Slot would absorb, because that win adds nothing to Active/Bench. `[unchanged]`
>
> **AMEND** the refusal-message bullet: the message states Roster Count, Projected Active/Bench Additions, Free Active/Bench Slots **and the allowance** — a manager refused at two outstanding bids with one slot must be able to see that the second was the allowance and the third is not available.
>
> **AMEND** the Roster Reserve clamp bullet: the `max(0, …)` clamp is **now reachable in ordinary play**, whenever a Team uses its allowance. It is no longer a commissioner-override-only safeguard, and `Roster Reserve` correctly falls to $0 for a Team bidding at its allowance.

#### 5.1.3 FR-40 (new) — Cancel a surplus commitment and restore the Auction

A new functional requirement under §4.5, numbered after FR-39.

> When an Auction Close leaves a Team holding commitments with no Roster Slot to receive them, the system cancels them, most recent first, and restores each affected Auction to its next-highest bidder.
>
> **Consequences (testable):**
> - Cancellation is triggered **only** by an Auction Close that reduces the winning Team's free slots — Active/Bench or Minor League — and by nothing else.
> - Commitments are cancelled **one at a time, most recent first by log sequence**, re-testing Roster Capacity after each, until the Team is within it.
> - A cancellation appends a `BidCancelled` event. The original Bid is **never** deleted or mutated and remains in the Auction's visible history; it keeps its League Clock reset, because it was valid when placed.
> - The cancelled Team's committed capital is released, and the Team is notified with the reason and the Auction named.
> - On an Auction in Standard Contention, the **next-highest surviving Bid becomes the leading Bid**, and that Team's capital is re-committed. The restored Team is re-evaluated against the **cap and slots gates at that instant**; if it fails, the next-highest Bid below is tried, and so on.
> - If no surviving Bid passes, the Auction returns to **Awaiting Opening Bid** and terminates unclaimed at expiry under FR-22.
> - The **Auction Clock is not reset, extended or otherwise altered.** A cancellation is not a Bid.
> - The **League Clock is not reset.** Nor is any prior reset removed — this is the distinction from a Commissioner void (FR-32), where the reset *is* removed.
> - Cancelling a Minimum-Bid Contention entry removes the Team from the Contender list and releases its $1,000,000; the lottery proceeds among the remainder.
> - Cancellations, restorations and the resulting terminations are written to the Audit Log and broadcast per §4.7.
> - A restoration never itself triggers a cancellation.

#### 5.1.4 FR-15 — No bid retraction

> **AMEND.** Retitle to *No **voluntary** bid retraction*, and add: a Bid may additionally be cancelled by the **system** under FR-40 when an Auction Close leaves it with no Roster Slot. That is not a retraction — no Manager chose it, and the cancelled Team is notified rather than being permitted to act. No user-facing control to cancel, edit or lower a Bid exists. `[the existing bullets are otherwise unchanged]`

#### 5.1.5 FR-18 — Join a Minimum-Bid Contention

> **ADD:**
> - A Team may be a Contender in **any number** of open Minimum-Bid Contentions simultaneously, provided it holds at least one Free Active/Bench Slot — or, for a Minor League Eligible Player, at least one Free Minor League Slot.
> - Contention entries **do not count toward Projected Active/Bench Additions** and are not subject to Roster Capacity or the Outstanding Bid Allowance. The expected outcome of a lottery is losing, and a rule sized for winning them all would throttle the mechanism.
> - They remain fully subject to **cap space**: FR-14's $1,000,000 per non-eligible contention still reaches Committed Bids, and an eligible contention still feeds Minors Exposure. Cap space is the only quantitative limit on how many lotteries a Team may enter.
> - A Team whose slots fill has its remaining entries cancelled under FR-40 **before those lotteries are drawn**, which the sequential close ordering of FR-21 guarantees.

#### 5.1.6 FR-20 — Draw a Minimum-Bid Contention winner

> **AMEND** the recording bullet: the draw records the seed and the ordered Contender list **as it stands at expiry, after any cancellations under FR-40 have been applied**. A cancelled Contender does not appear in the recorded list and cannot be drawn.
>
> **ADD:** a Contention whose Contender list is **empty at expiry** — every Contender having been cancelled — terminates with no winner, and the Player returns to the Free Agent pool, as an Auction still Awaiting an Opening Bid does under FR-22.

#### 5.1.7 FR-21, FR-14, FR-11, FR-39

- **FR-21** — add: a Close additionally evaluates the winning Team's remaining commitments against Roster Capacity and applies FR-40. This happens inside the sequential ordering, committed before the next Close is evaluated.
- **FR-14** — amend the release bullet to *"the instant the Team ceases to be Leading Bidder, whether by being outbid or by cancellation under FR-40"*; add that a Restored Leading Bidder's capital is re-committed at restoration.
- **FR-11** — add to the consequences: a Team may hold one more leading Bid than it has Free Active/Bench Slots, and the bid control states this rather than leaving it to be inferred.
- **FR-39 (Teams index)** — the row must publish **outstanding commitments against the allowance** beside `Free Active/Bench Slots`. `Roster 9 of 12` alone no longer answers "can they bid on this".

#### 5.1.8 §9 Risks

> **AMEND** the risk *"A team arrives from import with a full roster and cannot bid at all."* The condition survives — a Team at Roster Count 12 still cannot bid on non-eligible Players, and now for a sharper reason (§1.5) — but **add** a new risk:
>
> **A manager loses a bid they were winning, through no act of their own.** The allowance means a Bid can be cancelled by an unrelated close, and the manager will experience it as the app taking something away. *Mitigation:* the allowance must be visible **before** the bid is placed, not explained after it is cancelled — the board states which bid is the allowance bid and that it is the one at risk; the cancellation notice names the win that caused it. §10 example 31 is the case.

#### 5.1.9 §10 Rule Resolution Examples — the executable specification

Per AD-25 these are tests, not illustrations. **Examples 23, 24 and 25 must be revised** — each asserts the ceiling of 12 — and seven added:

| # | Case |
|---|---|
| 29 | The allowance in the ordinary case: `R=11`, one leading bid, a second permitted at `P=2, F=1`. |
| 30 | The precondition: `R=12`, `M=0`, $40M cap space, refused on capacity with the allowance stated as unavailable. |
| 31 | The cascade: `R=11` with two leading bids; one closes, `R=12`, the more recent bid cancelled, next-highest restored, clock untouched. |
| 32 | Restoration that fails re-validation: the next-highest bidder is now at its own capacity, and the third-highest is restored instead. |
| 33 | Restoration with nothing surviving: the cancelled bid was the opening bid; the Auction returns to Awaiting Opening Bid and terminates unclaimed. |
| 34 | Unlimited lotteries: `R=11` in six contentions; a win in one cancels the other five before they are drawn; one of the five is left with zero Contenders and terminates unclaimed. |
| 35 | The Minor League trigger: `R=12`, `M=1`, three eligible contentions; the win takes the minor slot, `M` falls to 0, and the other two are cancelled — the case a trigger reading only "Active/Bench" would miss. |

### 5.2 Architecture Spine

#### 5.2.1 AD-11 — Closes are sequential and deterministically ordered

> **AMEND the Rule.** Append: each close's committed effect now includes **any Bid Cancellations and restorations it causes (FR-40)**, not only its effect on slot occupancy, Roster Count, Cap Hit and Minors Exposure. This is what makes unlimited lottery participation safe: a Team in several simultaneously-expiring lotteries that wins the first has its remaining entries cancelled before the next is drawn. Folding an overdue set against one loaded snapshot was already a defect; it is now also a route to a Roster Count of 13.
>
> **AMEND Prevents:** add *"a Team winning a thirteenth player because two lotteries were drawn against the same snapshot"*.

#### 5.2.2 AD-22 — The League Clock resets on nomination and valid bid, and nothing else

> **ADD a clarification.** A Bid Cancellation and a restoration reset **neither** clock, and remove **no** prior reset. A cancelled Bid was valid when placed and its League Clock reset stands — which is precisely the distinction from a Commissioner void (Story 7.2), where the reset is removed because the Bid should never have counted. Two mechanisms that both change who leads an Auction, with opposite clock semantics; conflating them is a defect.

#### 5.2.3 AD-31 (new) — A cancellation is compensating, and records its own restoration

> - **Binds:** AD-4, AD-5, AD-11, AD-14, AD-23; FR-40
> - **Prevents:** a fold that must re-run the gate suite over candidate bidders to know who leads an Auction — an O(history × teams) replay whose result could drift from the decision the close actually made
> - **Rule:** a cancellation appends **one** `BidCancelled` event carrying the decision it made: the cancelled Bid's sequence, the reason, and either the restored Team, Bid sequence and amount, or `null` for an Auction returning to Awaiting Opening Bid. The original `BidPlaced` is never deleted or mutated and remains a history line. The projection **reads the recorded restoration** rather than re-deriving it, exactly as `ContentionDrawnPayload` records a draw's result rather than re-running the randomizer, and as AD-23 records winning amount and Cap Hit as distinct fields rather than recomputing one from the other. The **decision** is made once, in a pure function over committed state; the **fold** is then a read.
>
> `event_type` is a generic `text` column, so this event needs no migration (AD-26 still governs any future column).

#### 5.2.4 AD-2 — One rules core

> **AMEND** the gate-set note. The fixed-per-command-type gate list in `core/types.ts` gains a second command type — the **restoration re-validation**, whose declared set is `{cap, slots}` and nothing else. Increment, granularity, self-bid and contention were satisfied when the Bid was originally placed and are not re-litigated; expiry and phase belong to the close that triggered the cancellation. Declaring the narrower set is what stops a restoration from being quietly implemented as a synthetic `PlaceBid`.

#### 5.2.5 AD-25 — The §10 examples are the executable specification

> **AMEND:** the suite grows to 35 examples. Examples 18–25 must all be re-verified against the amended gate, not only the three that state the ceiling directly.

### 5.3 UX

| File | Line | Change |
|---|---|---|
| `EXPERIENCE.md` | 89 | The two-gate refusal sample `Slots · Passed — Roster Count would be 10 of 12` must show the allowance: e.g. *"Slots · Passed — 2 of 2 outstanding bids, 1 slot free"*. |
| `EXPERIENCE.md` | 127 | The Teams index row gains an outstanding-commitments figure beside `Roster 9 of 12`. |
| `EXPERIENCE.md` | 280 | The persistent strip sample `Maximum Bid $14.0M, Roster 9 of 12` gains the allowance state. |
| `EXPERIENCE.md` | 294 | Same as line 89. |
| `EXPERIENCE.md` | new | A section for the cancellation notice — what the cancelled manager sees, what the restored manager sees, and what the league sees. |
| `DESIGN.md` | refusal panel | The slots chip's figure now carries two numbers, not one. |

**New UX requirement, and the one most likely to be underestimated.** A manager must be able to tell, *before* bidding, that the bid they are about to place is the allowance bid and is therefore the one that will be cancelled if their other auction closes first. Discovering this at cancellation is the failure mode §5.1.8's new risk names. Recommend marking the allowance bid explicitly wherever a manager's own positions are listed — the persistent strip and the landing page.

### 5.4 Epic 10 — Story sketches

**Story 10.1 — The outstanding bid allowance in the slots gate**
> As a Manager with one slot and two players I want, I want to chase both, so that I am not idling for a day waiting on a close.

Supersedes 2.7's ceiling clauses. `OUTSTANDING_BID_ALLOWANCE` joins `ACTIVE_BENCH_SLOTS` in `core/constants.ts`. `evaluateSlots` implements §2.1. `SlotsGateOutcome` gains `freeActiveBenchSlots` and `allowance`, keeping `ceiling: 12` — both numbers are reported because a refusal quoting only one misleads. Refusal and pass wording updated. Board disable rules updated. §10 examples 23–25 revised, 29–30 added.

**Story 10.2 — Lottery entries leave the slots gate**
> As a Manager with one open slot, I want to enter every minimum lottery on the board, because I will probably lose all of them.

Supersedes 3.2's slot clauses. Implements §2.2. **Splits the contention term out of `projectedAdditionsFor` while leaving Minors Exposure untouched** — see 5.5.1. §10 example 34's entry half.

**Story 10.3 — Cancel the surplus commitment at close**
> As a Manager whose roster just filled, I want my surplus bid stood down automatically, so that I cannot win a thirteenth player.

Implements §2.3 inside `decideClose` and AD-11's loop. Appends `BidCancelled`. Releases capital. Most-recent-first by `seq`. Triggers on Minor League placements too. §10 examples 31 (cancel half) and 35.

**Story 10.4 — Restore the next-highest bidder** — *the hard one*
> As a Manager who was outbid and then outbid again, I want my bid to lead again when the leader's bid is cancelled, so that the auction reflects what teams actually offered.

Implements §2.4. New command type with the `{cap, slots}` gate set (AD-2). Cascade-down on re-validation failure. Fall through to Awaiting Opening Bid. Clock untouched. `BidCancelled` carries the decision (AD-31). §10 examples 31, 32, 33.

**Story 10.5 — A lottery whose contenders were cancelled**
> As a Manager reading a closed lottery, I want the recorded contender list to be exactly who was eligible to win, so that I can still reproduce the draw myself.

Supersedes 3.6's list-at-expiry clause. Cancelled contenders excluded from the recorded list; the seed-plus-list reproducibility contract of FR-20 preserved; empty-list lottery terminates unclaimed. §10 example 34's draw half.

**Story 10.6 — Say it on the board and in Discord**
> As a Manager, I want to know which of my bids is the one at risk before I place it, not after it disappears.

The allowance state on the persistent strip, the landing, the team view and the Teams index. Cancellation and restoration broadcast to the league channel and mentioned to both affected managers — **mapped onto spec 5-4's existing three notification categories, without adding a fourth.**

### 5.5 Implementation risks

#### 5.5.1 The two gates must stop sharing `minorsCountsFor` — the sharpest risk

`evaluateSlots` currently calls `minorsCountsFor(bound)` and its documentation makes a point of it being *"the IDENTICAL call `evaluateCap` makes, so the two gates cannot disagree about the count while agreeing they describe the same roster."* That shared call is deliberate, documented, and load-bearing.

Story 10.2 breaks it. `Overflow Count` derives from `Eligible Leading Bids (N)`, which **includes** eligible contention entries. After 10.2:

- **Minors Exposure (money)** must keep counting eligible contentions in `N` — FR-14 and FR-35 are unchanged, and the exposure is real.
- **Projected Active/Bench Additions (slots)** must stop counting them.

So the two gates must now legitimately disagree about the overflow, and the single shared call becomes wrong. This must be an **explicit, documented split** — two derivations with two names, each stating which rule it serves — and not a quiet extra parameter. A reviewer reading the existing comment will otherwise conclude the split is the bug.

#### 5.5.2 Story 7.2 should consume this machinery, not rebuild it

Story 7.2 (`backlog`) already specifies: *"restored to its state before that Bid, including the prior Leading Bidder… the voided Team's committed capital is released and the restored Leading Bidder's is re-committed."* That is this change's restoration, arrived at from the other direction.

They are **not** identical, and the differences are exactly the ones that get built wrong:

| | 7.2 `BidVoided` | 10.4 `BidCancelled` |
|---|---|---|
| The bid in the fold | Erased — never should have stood | Retained as a history line, stripped of leadership |
| Auction Clock | Restored to its prior value | **Unchanged** |
| League Clock | That bid's reset is **removed** | Reset **stands** |
| Re-validation of the restored team | Not specified | **Required**, with cascade |
| Actor | Commissioner, with a mandatory reason sheet | The system, with a recorded cause |

Recommendation: the restoration decision lives in **one pure function** — a new `core/rules/restore.ts` — parameterised by clock handling, consumed by both. Story 7.2's spec should be amended to cite it before 7.2 is built. Building 10.4 first makes 7.2 substantially cheaper; building them independently guarantees two subtly different restorations.

#### 5.5.3 Other risks

- **The §10 suite is executable.** Examples 18–25 must all be re-run; the eligible/overflow examples are the ones most likely to shift unexpectedly.
- **Epic 8's replay (8.1) and reconstruction (8.3)** must fold `BidCancelled`. Both are `backlog`, so this is a scope note, not rework.
- **AD-20 timing.** See §3.5.
- **Manager comprehension** is the product risk, not the technical one. "You may bid on two things with one slot, and one of those bids may be taken from you" is the hardest sentence in this product. Story 10.6 is not decoration.

---

## 6. Implementation Handoff

**Scope classification: Major.** A core rule change plus a new domain mechanism, requiring a PRD revision, an architecture decision, and a new epic before any code is written.

### 6.1 Sequence

| # | Owner | Work | Output |
|---|---|---|---|
| 1 | **PM** — `bmad-prd` (update) | §5.1 in full: glossary, FR-11/14/15/18/20/21/37/39, new FR-40, §9 risk, §10 examples 23–25 revised and 29–35 added | Revised `prd.md` |
| 2 | **Architect** — `bmad-architecture` (update) | §5.2: AD-11, AD-22, AD-2, AD-25 amended; AD-31 added | Revised `ARCHITECTURE-SPINE.md` |
| 3 | **UX** — `bmad-ux` (update) | §5.3: `EXPERIENCE.md` wording, `DESIGN.md` refusal panel, the cancellation-notice section | Revised UX artifacts |
| 4 | **PO/PM** — `bmad-create-epics-and-stories` | §5.4: Epic 10 and its six stories with full acceptance criteria | Revised `epics.md` |
| 5 | **PO** — `bmad-sprint-planning` | Epic 10 entries; resequence 9.7/9.8 to follow | Updated `sprint-status.yaml` |
| 6 | **Dev** — `bmad-build` ×6 | Stories 10.1 → 10.6 in order | Code, migrations (none expected), tests |
| 7 | **Reviewer** — `bmad-code-review` | 10.3 and 10.4 at minimum; both touch `src/lib/core/` and are Tier A under `BMAD-EFFORT-TRIAGE.md` | Review reports |

Steps 1–3 may run in parallel; step 4 depends on all three.

### 6.2 Success criteria

- The §10 suite is green at 35 examples, including all seven new ones.
- `npm test` and `npm run check` pass — CI runs both, and `npm run build` proves nothing about either.
- No migration was required (the generic `event_type` envelope holds).
- A Team can be demonstrated to reach Roster Count 12 and **never** 13, across the leading-bid path, the lottery path, and the Minor League path.
- The cascade is shown to terminate on a Team holding ten simultaneous commitments.
- A manager can see, before bidding, which of their bids is the allowance bid.
- Story 7.2's spec cites the shared restoration function.

### 6.3 Sprint status changes on approval

**Deliberately not applied by this workflow.** Two reasons, and both point the same way:

1. `AGENTS.md` policy forbids hand-editing `_bmad-output/` — the `bmad-*` skills own that tree, and `sprint-status.yaml` belongs to `bmad-sprint-planning`.
2. More importantly, it would be **out of order**. `bmad-sprint-planning` generates the tracking file *from* `epics.md`. Writing Epic 10's stories into the status file before step 4 creates them in `epics.md` would leave the tracker naming stories that do not exist, which is precisely the inconsistency that skill's validate/repair mode exists to catch.

The block below is therefore the **expected output of step 5**, recorded here so the result can be checked against intent:

```yaml
  epic-10: backlog
  10-1-the-outstanding-bid-allowance-in-the-slots-gate: backlog
  10-2-lottery-entries-leave-the-slots-gate: backlog
  10-3-cancel-the-surplus-commitment-at-close: backlog
  10-4-restore-the-next-highest-bidder: backlog
  10-5-a-lottery-whose-contenders-were-cancelled: backlog
  10-6-say-it-on-the-board-and-in-discord: backlog
  epic-10-retrospective: optional
```

Epics 2 and 3 remain `done`. Stories 9.7 and 9.8 remain `backlog`, now sequenced after Epic 10.

---

## Appendix A — Change Navigation Checklist

| Item | Status | Finding |
|---|---|---|
| 1.1 Triggering story | [x] | No story — reported directly by the commissioner, 2026-09-07, during Epic 9 setup preparation. |
| 1.2 Core problem | [x] | **Misunderstanding of original requirements** — a league rule never recorded in the PRD. Not a technical limitation, not a pivot. |
| 1.3 Impact and evidence | [x] | Eight shipped artifacts contradicted; enumerated in §1.4 with file and line references. |
| 2.1 Current epic completable? | [x] | Epics 2 and 3 are `done` and remain so; their specs correctly implement the rule as it was recorded. |
| 2.2 Epic-level changes | [x] | One new epic. No epic modified in place, removed, or redefined. |
| 2.3 Remaining epics reviewed | [x] | 6 unaffected; 7 benefits (7.2 shares machinery); 8 gains two scope notes; 9 resequenced. |
| 2.4 Epics invalidated or needed? | [x] | None invalidated. One new epic needed. |
| 2.5 Order or priority change? | [!] | **Yes** — Epic 10 must precede 9.7 and 9.8 per AD-20 (§3.5). |
| 3.1 PRD conflicts | [!] | Extensive: glossary, nine FRs, one new FR, §9, §10. |
| 3.2 Architecture conflicts | [!] | AD-11, AD-22, AD-2, AD-25 amended; AD-31 new. Data model unaffected — no migration. |
| 3.3 UI/UX conflicts | [!] | Five wording sites, one new section, one new pre-bid affordance. |
| 3.4 Other artifacts | [x] | No CI, IaC, deploy or monitoring impact. `AGENTS.md` unaffected. `deferred-work.md` gains nothing. |
| 4.1 Direct adjustment | [x] Viable | **Selected.** Effort High, risk Medium. |
| 4.2 Rollback | [x] Not viable | Shipped work is correct-but-incomplete; reverting discards working logic to rebuild it identically. |
| 4.3 MVP review | [x] Not viable | The rule is MVP — it governs whether the auction terminates. |
| 4.4 Path selected | [x] | Option 1, structured as a new epic to preserve the completed-story audit trail. |
| 5.1–5.5 Proposal components | [x] | §1–§6 above. |
| 6.1 Checklist complete | [x] | Four `[!]` items, all carried into §5. |
| 6.2 Proposal accuracy | [x] | Every claim about shipped behaviour verified against source; file and line cited. |
| 6.3 User approval | [x] | **Approved by Meakel, 2026-09-08**, as written and including the §1.5 precondition assumption. |
| 6.4 `sprint-status.yaml` updated | [N/A] | **Deferred to step 5 by design, not skipped** — see §6.3. Editing it here would breach `AGENTS.md` tree ownership and would put the tracker ahead of the `epics.md` it is generated from. |
| 6.5 Handoff confirmed | [x] | Routed to PM / Architect / UX per §6.1. Step 1 (`bmad-prd`) is the next action. |
