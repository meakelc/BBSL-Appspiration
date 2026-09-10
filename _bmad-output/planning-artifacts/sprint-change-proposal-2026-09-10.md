# Sprint Change Proposal — Roster Moves, Drops, and Dead Money

**Date:** 2026-09-10
**Author:** Correct Course workflow, with Meakel
**Change scope classification:** **Moderate** — three new requirements and four stories in an epic that has not started, plus one enabling correction to shipped Epic 1 code (a discarded contract designation and a missing roster slot kind). No shipped rule is superseded and no §10 example is invalidated; the suite is added to, not rewritten.
**Status:** **APPROVED by Meakel, 2026-09-10**, after the three open league-rule items were answered and folded in (§3.2). Three of the five open items in §5.3 are closed; the two remaining are a `curl` and a next-offseason concern, neither blocking.

---

## 1. Issue Summary

### 1.1 The problem

Managers trade during the auction. The product says they do not.

**The trigger, as stated by the commissioner:**

> Managers are generally fond of making trades during the auction to clear up cap space or go after secondary targets after their first choice has been taken or the landscape changes. As there's no Fantrax API to make these roster changes automatically, we may need manual commissioner tools to process these trades as they happen (unless you have a better solution).

### 1.2 Why it matters

A trade changes both Teams' **Cap Space** *and* their **Roster Count** and slot occupancy. Those are the inputs to Maximum Bid (FR-12), Roster Reserve, the slots gate (FR-37), Free Minor League Slots, and therefore Minors Exposure (FR-35).

If the app is not told, its arithmetic is silently wrong for both Teams for the rest of the auction, every figure it publishes about them is wrong, and FR-31's roster export ships stale rosters back into Fantrax at the end. FR-1 already names this class of failure — *"a silently wrong cap figure discovered mid-auction is unrecoverable"* — and NFR §5 ranks it above an outage: *"A rules bug is a worse failure than an outage."*

### 1.3 How it was discovered

Reported directly by the commissioner on 2026-09-10, as an omission from the requirements rather than a defect found in testing. This is the **fourth** instance of the pattern recorded in `ARCHITECTURE-SPINE.md` §"Conflicts to Resolve Upstream" — a league practice invisible through every requirements review and obvious the moment someone described what they actually do. The prior three were the thirty-one-file import, the Teams index, and the Outstanding Bid Allowance.

### 1.4 What it contradicts, precisely

| Artifact | Current statement | Status |
|---|---|---|
| PRD §6 | "**Not a trade machine.** No trades during the auction; committed capital and won players cannot be exchanged." | **Half superseded** — the *won players* half goes; *committed capital* survives absolutely |
| PRD §2.2 | "Waivers, trades, lineups, and scoring all stay in Fantrax." | **Narrowed** — execution stays in Fantrax, effect is recorded here |
| PRD §6 | "**Not writing to Fantrax.** v1 never mutates Fantrax state." | **Still true, and now a finding rather than a choice** — see §1.6 |
| SPEC.md non-goals | Both of the above, verbatim | Same |
| PRD FR-32 | Commissioner may "adjust a Team's Cap Space" | **Insufficient** — money-only; leaves Roster Count wrong, so the slots gate stays wrong |
| PRD §8 SM-2 | "fewer than 5 overrides across the whole auction" | **Superseded** — would penalise the app for correctly recording a busy trade market |
| SPEC.md success signal | Same metric | Same |
| `adapters/fantrax/roster-file.ts:118` | `CONTRACT_END_YEAR` matches the rookie prefix in a **non-capturing** group | **Defective for this purpose** — see §1.7 |
| `core/types.ts:144` `RosterSlotKind` | Three kinds | **Insufficient** — see §1.7 |

### 1.5 What is *not* affected, and why that matters

**Epic 7 is entirely `backlog`.** Nothing of the commissioner-control surface is built. This change lands in unwritten work.

**`team_rosters` is already mutable reference data, not event-sourced.** AD-4: *"the world is not event-sourced, only the auction is."* A trade is the world.

**The cap arithmetic already flows from one derivation.** `core/projection/contracts.ts` states that Cap Space, Roster Count and Minor League occupancy all pick contracts up through `contractRowsFor` with *"no second counter and no second definition of any of the three."* Consequently **moving a `team_rosters` row makes every downstream figure correct for both Teams automatically.** The engine already does the arithmetic; the only thing missing is a way to move the row.

That is why a change touching six documents is a Moderate rather than a Major.

### 1.6 The Fantrax API — investigated, and the August assessment corrected

The commissioner asked whether `fantrax.com/developer`'s listed roster API could do this work. Investigated 2026-09-10.

**On writes, the original premise holds exactly.** `fantrax.com/developer` still returns **403**. Every method exposed by either community wrapper — Go and Python — is a **GET**. There is no write endpoint to reverse-engineer, not merely no documented one. Trades will continue to be executed in Fantrax by hand.

**On reads, the August assessment was aimed at the wrong job.** `getTeamRosters` returns three fields per player:

```
RosterItem { ID, Position, Status }
```

No salary, no contract value, no contract years. Addendum §A concluded from this that the read surface was useless, because salary is *"the single most load-bearing data the app needs."* That is correct **for setup**, and FR-1 remains a CSV import.

It does not hold for **reconciliation**. A trade does not change a Contract — it changes who holds it. The app already holds every Contract's Cap Hit, years and Slot kind from the FR-1 import, and under FR-41 those travel with the Player unchanged. **The only missing fact is which Team holds whom, and that is precisely what `getTeamRosters` returns.**

The endpoint is worthless for establishing state and sufficient for detecting that state has drifted. Those are different jobs.

**This reframes the deliverable.** The commissioner asked for manual tools. The manual tool is still the write path — but the failure mode actually worth defending against is not that recording a trade is laborious, it is that **a trade happens and nobody tells the app**. Hand-entry cannot catch that. A detector can. Hence FR-42, deliberately shaped so the dependency can never do harm: it proposes and never writes, runs hourly, and its failure degrades to FR-41 alone.

### 1.7 A second finding, surfaced by the drop rule

Asked about unpaired departures, the commissioner supplied a league rule not previously recorded anywhere:

> Managers can drop players in Fantrax BUT this does not clear their cap space mid-auction (you clear a roster spot, but you keep the cap hit for dropped players for their contract length), with the one exception being second round rookies drafted this year (which would have the contract designation "2RK31", which designates 2nd round rookie, ending in 2031).

Two gaps follow, both **latent rather than live** — the commissioner confirms no Team currently carries dead money, so no shipped figure is wrong today.

**Gap 1 — dead money is not modelled.** `computeCapSpace` (`core/rules/roster-import.ts:79`) sums `chargedCapHit` over roster rows. A dropped player has no row, so his cap hit leaves the app's arithmetic entirely while persisting in Fantrax. The first mid-auction drop produces a Cap Space figure that is wrong and stays wrong.

**Gap 2 — the `2RK` designation is parsed and discarded.**

```ts
const CONTRACT_END_YEAR = /^(?:\d(?:RK|rk))?(\d{2}|\d{4})$/;
```

The rookie prefix is matched by a **non-capturing** group; only the year reaches the capture. `2RK31` and `2031` are indistinguishable downstream. The one attribute deciding whether a drop clears cap is thrown away at the boundary.

**And a consequence that inverts the usual intuition:** a Drop *lowers* a Team's Maximum Bid. Roster Count falls, so Roster Reserve rises by $1,000,000 for the new hole, while Cap Space is unchanged. Only the 2RK case can go the other way, and only when the cleared Cap Hit exceeds $1,000,000.

**The shape already exists.** The two axes — *does it charge* and *does it count toward 12* — are already independent in the core:

| kind | charges cap | counts toward 12 | ceiling |
|---|---|---|---|
| `active_bench` | yes | yes | 12 |
| `injury_reserve` | yes | no | 2 |
| `minor_league` | no | no | 3 |
| **`dead_money`** | **yes** | **no** | **none** |

Dead Money is Injury Reserve without the ceiling. `chargedCapHit` already returns the right value for it by falling through. One enum member, one ceiling entry, one migration, one regex capture group.

---

## 2. Impact Analysis

### 2.1 Epic impact

| Epic | Status | Impact |
|---|---|---|
| 1 — Setup day | `done` | **Enabling correction only.** `RosterSlotKind`, `chargedCapHit`/`SLOT_CEILINGS`, the adapter regex, one migration. Adds a kind; supersedes no rule. |
| 2 — Nominate and bid | `done` | **None.** The gates are reused unchanged, by design (AD-32). |
| 3 — Auction resolves itself | `done` | **None.** AD-31's cancellation trigger is explicitly unextended. |
| 4 — The screens | `done` | Dead Money must render on FR-25 and FR-39, labelled and separate from the roster. |
| 5 — Notifications | `done` | **None.** Roster Moves are not broadcast. |
| 6 — Close the books | `in-progress` | A moved Auction Contract clears its length, re-blocking the export until reassigned. Self-healing; no story change. |
| 7 — Referee's controls | `backlog` | **Four new stories, 7.6 – 7.9.** |
| 8 — Ready to open | `backlog` | 8.1's replay must apply Roster Moves in sequence (AD-32). |
| 9 — Stand it up | `in-progress` | 9.7's pilot is the natural place to exercise the reason sheets. |
| 10 — Chase two players | `review` | **None.** `restore.ts` is reused by no path in this change. |

No epic is invalidated, none obsolete, no resequencing — Epic 7 was already after 6.

### 2.2 Artifact conflicts

| Artifact | Change |
|---|---|
| `prd.md` §2.2, §6 | Three non-goals rewritten |
| `prd.md` §3 | Five glossary terms added |
| `prd.md` §4.10 | **FR-41, FR-42, FR-43** added |
| `prd.md` §8 | SM-2 corrected; SM-7 and SM-C4 added |
| `prd.md` §10 | **Examples 36 – 43** added |
| `prd.md` §12 | **One** live assumption indexed (the Discord silence of FR-41). Three others were raised and answered the same day, and are recorded as *confirmed by the league, retained for provenance*, per the section's existing convention |
| `addendum.md` §A | Re-verification, the corrected assessment, two table rows |
| `SPEC.md` | **CAP-22, CAP-23** added; three non-goals; success signal |
| `ARCHITECTURE-SPINE.md` | **AD-32** added |
| `epics.md` | Epic 7 header; **Stories 7.6 – 7.9** |
| `sprint-status.yaml` | Four entries |
| UX `DESIGN.md` / `EXPERIENCE.md` | Story 7.1's reason sheet needs a two-Team before/after variant. Minor; no new destination. |

### 2.3 Technical impact

- **One migration** — `team_rosters_roster_slot_kind_check` admits a fourth kind (AD-26, dev-first).
- **No migration for the events** — `auction_events.event_type` is generic `text`.
- **No new gate implementation** — re-evaluation calls the existing pure gates (AD-32).
- **No client write path** — unchanged (AD-9).
- **One new outbound dependency**, read-only, adapter-confined, hourly, non-blocking, and killable.

---

## 3. Recommended Approach

**Direct Adjustment.** Effort **Low–Medium**, risk **Low**, timeline impact confined to Epic 7, which has not started.

Rollback is not applicable — nothing shipped conflicts. An MVP review is not applicable — this adds rules rather than cutting scope.

### 3.1 The shape of the solution

**The app records the move and never the reason.** The product gains one concept — a **Roster Move** — not a trade system. A trade is merely the usual *reason* for a move; a waiver claim, a commissioner correction and a release all produce the same state change. Had the app known about *trades* specifically it would owe two-sided validation: did each side give and get, is it balanced, is it legal. It owes none of that. It records that a Player is now on another Team, checks that Team can hold him, and stops.

**Refuse, never cascade.** Where a Move or Drop would leave either Team failing a gate, the whole act is refused and nothing is written. AD-31's rule that cancellation is triggered by an Auction Close *and nothing else* is thereby preserved word for word.

**Detector in front, override behind.** The Fantrax read proposes; the Commissioner disposes. Nothing that mutates state ever trusts an undocumented endpoint.

### 3.2 Decisions taken by the commissioner, 2026-09-10

| Decision | Answer |
|---|---|
| What may move | Existing Contracts **and** Auction Contracts. **Not** cap dollars, **not** leading Bids or contention entries |
| Over-commitment | **Refuse** the Move, naming what must clear first |
| Visibility | **Audit log only** — no Discord broadcast |
| Fantrax API | **Detector now**, behind the override |
| Dead money | No Team carries any today — latent gap; folded into this proposal as a second part |
| `2RK` identification | `2RK` prefix **and** current draft class (full unelapsed term) |
| Second-round rookie term | **5 years, invariant.** All 2RK deals are the same length, so "full term unelapsed" is a sound test for "drafted this year" and no per-offseason constant is needed |
| Dropping a stashed Player | **Permitted, and yields no Dead Money.** He was charging $0 by placement, so there is nothing to carry |
| Unknown arrivals | **Cannot legitimately occur** — every acquisition in the window goes through the auction. Reported as an **error**, loudly, rather than as a state needing a remedy |

### 3.3 Alternatives considered and rejected

| Option | Why rejected |
|---|---|
| **Post-open per-team Fantrax CSV re-import** | FR-1 already supports re-supplying one Team's file, and unlocking it post-open sounds elegant. It fails on one detail: a mid-auction Fantrax team export **does not contain the Players that Team won in this auction**, so a wholesale replace either wipes the Auction Contracts or needs a diff-and-relayer larger than the thing it replaces. |
| **Cascade-cancel on over-commitment** | Faithful to real league flow and reuses `restore.ts` — but requires amending AD-31's trigger rule and reopening the re-entrancy argument the spine deliberately closed. It would also let an administrative act strip a Player from a Team that did nothing. |
| **Record trades silently, no gates** | Produces a Committed Bids figure the app knows to be unaffordable. |
| **Full API sync** | No write endpoint exists to sync to. Confirmed 2026-09-10. |
| **Scraping the Fantrax UI** | Rejected in August on fragility and ToS grounds; nothing has changed. Story 7.9's first AC forecloses it explicitly. |

---

## 4. Detailed Change Proposals

All eleven edits were reviewed and approved individually in incremental mode on 2026-09-10, in the order below.

### 4.1 PRD — non-goals (§2.2, §6)

**§2.2** — remove `trades` from the Fantrax list; add: *"as does the execution of a trade. The app records a trade's effect on rosters (FR-41) because that effect changes what both Teams may bid, and detects one it was not told about (FR-42). It brokers none."*

**§6 "Not a trade machine"** → **"Not a trade broker."** No proposal, negotiation or acceptance flow. Committed capital never exchanged; FR-15 unaltered. Cap dollars are not a tradeable asset — FR-32's adjustment exists to correct a wrong imported figure, and settling a trade through it would record the act as something it is not.

**§6 "Not writing to Fantrax"** — restate as a property of the integration, not a preference, citing the 2026-09-10 verification; note that v1 now reads one endpoint for reconciliation only, and a read can never change app state.

### 4.2 PRD §3 — glossary

Five terms. **Roster Move** and **Roster Divergence** after *Slot Placement*; **Drop**, **Dead Money** and **Rookie-Scale Contract** immediately after those.

Key content: a Contract travels unchanged in value and years; **Slot Placement is re-evaluated against the receiving Team's occupancy and Cap Hit follows placement**; a Move never transfers Committed Bids, contention entries or Cap Space, and is refused if either Team would fail a gate. A Drop frees the Slot but carries the Cap Hit as **Dead Money**, and therefore *lowers* Maximum Bid. Dead Money charges in full, occupies no Slot, counts toward no ceiling. A second-round rookie Contract of the current draft class is the one Contract whose Cap Hit clears on a Drop.

### 4.3 PRD §4.10 — FR-41, Record a Roster Move

Structure: *What moves* · *Placement and Cap Hit* · *The refusal* · *Phase and the Year Allotment* · *The record* · *Atomicity*.

Load-bearing clauses:

- A Move names two Teams and moves Contracts **in both directions in one act**; a side may be empty. Applying halves in sequence refuses legal trades on states that never existed.
- Slot Placement re-evaluated on receipt; **Cap Hit follows placement**; the reason sheet states this in words wherever a Cap Hit changes.
- Both Teams re-evaluated against both gates after the **whole** Move; either failing refuses **all** of it. **A refusal can be caused by the sending Team.** The refusal names what must clear first and **never offers to cancel a Bid**.
- Moving an assigned Auction Contract clears the length, returns the year to the sender's allotment, re-blocks the export under FR-30.
- Mandatory reason; one Audit Log entry with before/after for both Teams; **not broadcast to Discord** (`[ASSUMPTION]`, indexed).
- One transaction under the global write lock.

### 4.4 PRD §4.10 — FR-42, Detect a Roster Divergence

Marked **contingent**: if the endpoint does not answer usably, FR-42 is dropped and FR-41 stands alone.

- Read at most **hourly**, not per tick.
- **Membership is the only fact taken from Fantrax.** Slot kind, where present, is advisory.
- Comparison **excludes Players won in this auction**.
- Three classifications: **paired** → proposes a Roster Move · **unpaired departure** → proposes a Drop · **unknown arrival** → **reported as an error, prominently**. Every acquisition during the window goes through the auction (confirmed 2026-09-10), so a Player on a Fantrax roster the app did not put there cannot legitimately occur. It is not a state needing a remedy; it is a signal that something is wrong — a mis-set league id, a wrong period, or a genuine out-of-band change — and it is surfaced as such rather than quietly listed.
- **A read never writes.** Dismissal suppresses until the difference changes. Commissioner surface only.
- Failure never blocks an auction action; **repeated failure renders as stopped, never as "no divergences."**

### 4.5 PRD §4.10 — FR-43, Record a Drop, and carry Dead Money

- One Team, one direction. The Slot is freed; **the Cap Hit does not clear**.
- **The governing rule is one sentence: a Drop converts the Player's *charged* Cap Hit into Dead Money, at the same amount** — not the amount his Contract states. All three Slot kinds fall out of it, and no case is special:

  | dropped from | was charging | Dead Money carried | Roster Count | net effect on Maximum Bid |
  |---|---|---|---|---|
  | Active/Bench | full | full | **falls** | **lower** by the $1,000,000 reserve on the freed hole |
  | Injury Reserve | full | full | unchanged | unchanged |
  | Minor League | **$0** | **none — the row is removed** | unchanged | **higher**, via Minors Exposure |

- **A Drop from Active/Bench lowers Maximum Bid.** Roster Reserve rises $1,000,000 for the freed hole with no offsetting release. The reason sheet says so before commit, because every manager's intuition says the opposite (§10 example 40).
- **A Drop from a Minor League Slot moves it the other way.** He was charging $0, so nothing is carried and Cap Space is unchanged — but the freed Slot raises **M**, which lowers Overflow Count, which recomputes **Minors Exposure** across every eligible Auction the Team still leads, releasing committed capital (§10 example 43). Roster Count is untouched, because Minor League Players never counted toward the 12.
- **Exception:** a second-round rookie Contract of the current draft class is **removed**, not reclassified, and its Cap Hit released to Cap Space. Identified by `2RK` **and** a full unelapsed term. **The term is 5 years and invariant across all 2RK deals** (confirmed 2026-09-10), so the term test is sound and no per-offseason constant is required. First-round (`1RK`) and every other Contract become Dead Money like any other.
- **The designation must survive the import to be usable, and does not today.**
- Dead Money shown labelled and separate on FR-25 and FR-39.
- **Dead Money is not importable in v1** and is **excluded from both exports**.

### 4.6 PRD §10 — examples 36 – 42

Executable per AD-25.

| # | Lesson |
|---|---|
| 36 | The motivating trade; **an empty direction is legal** — a salary dump is a Roster Move |
| 37 | **A Team pushed over by giving something away** — $500k richer, $300k short, refused |
| 38 | **The stash that becomes expensive by moving** — $0 → $18,000,000 by placement; and the sender's Minors Exposure recomputes across auctions it still leads |
| 39 | **One act, evaluated once** — sequenced halves refuse a legal trade at a transient 14 |
| 40 | **A Drop lowers Maximum Bid** — $4,000,000 → $3,000,000, no money released |
| 41 | **The three characters worth $2,000,000** — identical to 40 but `2RK31`; $5,000,000 |
| 42 | **A won Player traded after the Auction Phase** — length cleared, year returned, export self-heals |
| 43 | **A stashed Drop moves Maximum Bid the other way** — Team L, `M=1`, leading eligible auctions at $12,000,000 and $4,000,000, carries Minors Exposure of $12,000,000 against $20,000,000 of Cap Space. It drops a stashed Player: Cap Space unchanged and no Dead Money, but `M` rises to 2, Overflow Count falls to 0, **Minors Exposure falls to $0**, and Available Cap Space rises from $8,000,000 to $20,000,000. Roster Count never moves. The mirror of example 40 |

Examples 40 and 41 are the regression test for the discarded prefix: **until it is captured they compute the same answer and one of them is wrong.** Examples 40 and 43 are the pair that stops "a Drop lowers Maximum Bid" being implemented as an unconditional rule.

### 4.7 `addendum.md` §A

Re-verification note dated 2026-09-10 carrying the `getTeamRosters` struct and the GET-only finding. New subsection **"What the August assessment got wrong"** — the read surface is worthless for establishing state and sufficient for detecting drift, and the August note evaluated it against only the first job. Rejected-alternatives row for *API read + CSV write* marked **partly adopted, for a different reason than that row assessed**. v2 trigger notes the write half may not exist to be granted.

### 4.8 `SPEC.md`

**CAP-22 — Record a Roster Move or a Drop**, carrying the charged-Cap-Hit rule and both directions a Drop can move Maximum Bid. **CAP-23 — Detect a Roster Divergence from Fantrax**, carrying an explicit `contingent:` line and the unknown-arrival-is-an-error rule. Three non-goals restated. Success signal counts **corrective** overrides only, **excluding Roster Moves and Drops**.

### 4.9 PRD §8 — metrics

- **SM-2** counts **corrective** overrides only; Moves and Drops excluded. A metric that cannot tell them apart would pressure the Commissioner not to record them.
- **SM-7** — no Manager discovers a wrong figure caused by an unrecorded trade or drop. Target zero.
- **SM-C4** — divergence count driven to zero by not looking. SM-7's zero is meaningful only beside a *live* FR-42.

### 4.10 `ARCHITECTURE-SPINE.md` — AD-32

**AD-32 — The world changes by mutation plus record, and a world change refuses rather than cascades.**

- Mutation **and** record event, one transaction, under the global lock. The record is not merely for audit: **every cap and slot figure is a function of the rosters at a given instant**, so a Move absent from the log makes AD-5's rebuild, AD-21's restore and AD-3's replay fold yesterday's bids against today's rosters. The event carries the **whole delta**.
- Two kinds of Contract, one event, two folding paths. Existing → `UPDATE` of `team_id`, never delete-then-insert (`fantrax_player_id` is `unique`). Auction → folded latest-transfer-wins.
- One evaluation, over the whole Move, at the end.
- **The gates are the existing gates** — no second affordability check (AD-31's "one restorer, two callers" applied to the gates).
- **A world change refuses; it never cancels.** AD-31's trigger stays a Close and only a Close.
- Dead Money is a fourth `RosterSlotKind` and **needs a migration**.
- The Fantrax read is shell, adapter-confined, and writes nothing.
- The detector's failure mode is stated, not silent (cf. AD-19).

### 4.11 `epics.md` and `sprint-status.yaml`

Epic 7 header extended. Four stories appended, all `backlog`:

| Story | Depends on | Notes |
|---|---|---|
| **7.6 Dead Money and the rookie-scale designation** | — | **Independently valuable.** Should ship even if the rest is abandoned |
| **7.7 Record a Roster Move** | 7.1 | **Does not depend on 7.6.** A complete increment on its own |
| **7.8 Record a Drop** | 7.1, **7.6** | Carries the charged-Cap-Hit rule across all three Slot kinds, and both directions a Drop can move Maximum Bid (§10 examples 40, 43). The earlier "refuse a minor-league drop" AC is **withdrawn** — the rule replaces it |
| **7.9 Detect a Roster Divergence** | 7.7, 7.8 | **Contingent and explicitly killable** — its first AC closes the story as not-viable if the endpoint does not answer. No scraping, no undocumented alternative |

### 4.12 Adversarial review of AD-32, and the five clauses it added

Run during the `bmad-architecture` gate on 2026-09-10, after the eleven edits above were applied. `lint_spine.py` returned 0 findings; the adversarial divergence lens returned six. **Five were closed; one was rejected as out of scope.** The two sharpest each produced code that would contradict AD-32's own stated purpose under an honest reading.

| # | Hole | Closure |
|---|---|---|
| 1 | **Reconstruction vs. the live table.** AD-32 said the event exists "so a fold can reproduce the world as it stood" but never named who folds, from what baseline, or where it lives — while AD-4 flatly denies `team_rosters` is event-sourced. A builder obeying AD-4 literally restores from the **live table** and reproduces the exact bug AD-32 claims to prevent | AD-4 governs the **live write path only**; rebuild, restore and replay reconstruct from the last reference-data snapshot plus a forward fold of the mutation events. In-memory, read-only, no migration |
| 2 | **Only a settled Contract moves.** A Player contested in an open Auction is neither an Existing nor an Auction Contract, so `contractsReducer` has nothing to apply a transfer to | A **third refusal ground**, checked *before* the money and slots gates. **Also amended PRD FR-41**, which carried the same gap |
| 3 | **The gate-call shape.** "Calls the same gates" invited synthesizing a `PlaceBid` and force-passing the inapplicable ones — which *is* the second implementation the next clause forbids, and routes two Teams' opposing deltas through a cap gate AD-7 defines as single-Team and incremental | A Move is a **third command type** per AD-1/AD-2's precedent, reusing `bidding.ts` arithmetic as pure helpers only |
| 4 | **Slot-kind exhaustiveness.** AD-32 sanctioned fallthrough for `chargedCapHit`, setting a pattern a sibling module could copy and silently tally Dead Money as Active/Bench | `RosterSlotKind` is a **closed four-member union**; exhaustive matches, no `default`, so a missing branch is a compile error |
| 5 | **The reader's "writes nothing" was intent, not control** | The reader **never receives a database client as an argument**, making a write from inside it a type error. Role separation is unavailable — importer and reader share the one service role |

**Rejected — real, but not this change's to close.** The lens flagged that the tick sweep's transaction granularity is unpinned (AD-11 reads either as one transaction or one per close), so a Roster Move could interleave mid-sweep. The framing is wrong: **if the sweep commits per close, an ordinary manager's bid can already interleave**, and bids are orders of magnitude more frequent than commissioner trades. The ambiguity is entirely pre-existing; AD-32 neither widens nor depends on it. Pinning it means deciding the tick's transaction granularity against AD-10's restart-safety requirement — a real decision about AD-6/AD-11 that should not ride in on a roster-recording amendment. Logged as an open question with a revisit condition: **before Story 3.5's tick is exercised under the Story 9.7 moderator pilot.**

Stories 7.6 and 7.7 gained acceptance criteria for closures 2, 3 and 4, so the build inherits them rather than relying on someone reading the spine.

---

## 5. Implementation Handoff

**Scope: Moderate.** Requirements and backlog change plus one enabling code correction. No fundamental replan; no architecture rewrite beyond one additive AD.

### 5.1 Routing

| Recipient | Deliverable |
|---|---|
| **`bmad-prd` (update)** | §2.2, §3, §4.10, §6, §8, §10, §12 and the addendum |
| **`bmad-spec` (update)** | CAP-22, CAP-23, non-goals, success signal |
| **`bmad-architecture` (update)** | AD-32 |
| **`bmad-create-epics-and-stories`** | Epic 7 header and Stories 7.6 – 7.9 |
| **`bmad-sprint-planning`** | Four `sprint-status.yaml` entries |
| **`bmad-build`** | Stories 7.6 – 7.9, in that order, after Story 7.1 |

Per `AGENTS.md`, `_bmad-output/` is not hand-edited — each owning skill applies its own section.

### 5.2 Success criteria

1. §10 examples 36 – 43 pass as automated tests (AD-25).
2. Examples 40 and 41 produce **different** Maximum Bids — the regression proof that the `2RK` prefix survives the import.
3. Examples 40 and 43 move Maximum Bid in **opposite directions** — the proof that a Drop's effect is derived from the charged Cap Hit rather than applied as a flat rule.
4. A Roster Move leaving either Team over-committed is refused with nothing written, and **no `BidCancelled` event exists on any path reachable from a Move or Drop**.
5. A replay of an auction containing a Roster Move reproduces the same Maximum Bids it produced live (AD-3, AD-32).
6. `npm test` and `npm run check` green.

### 5.3 Open items carried, not closed

| # | Item | Needed from | Blocks |
|---|---|---|---|
| ~~1~~ | ~~Second-round rookie term~~ | **CLOSED 2026-09-10** — 5 years, invariant across all 2RK deals. The term test is sound; no per-offseason constant | — |
| ~~2~~ | ~~Dropping a Minor League Slot player~~ | **CLOSED 2026-09-10** — permitted, no Dead Money, and it *raises* Maximum Bid via Minors Exposure. The v1 refusal is withdrawn and replaced by the rule | — |
| ~~3~~ | ~~Unknown arrivals~~ | **CLOSED 2026-09-10** — cannot legitimately occur; every acquisition goes through the auction. Reported as an error, not remedied | — |
| 4 | **The endpoint has never been called** — auth, and whether `Status` distinguishes slot kinds | One `curl` against the real league | Story 7.9 only |
| 5 | **Dead Money on import** — the shape Fantrax exports it in has never been seen; refused loudly in v1 | A future setup day | Next offseason, not this one |

Item 4 is one command:

    curl -s "https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=<BBSL_ID>&period=1" | head -c 2000

### 5.4 The risk worth restating

**A detector that has silently stopped reports no divergences, which is indistinguishable from a league that had none — and is the more dangerous state**, because it displaces the manual check it exists to support. FR-42, AD-32 and SM-C4 each carry a clause against this, deliberately and redundantly.

If exactly one sequencing decision survives review, it should be that **Story 7.7 ships before Story 7.9** — the override without the detector is safe; the detector without the override is not.
