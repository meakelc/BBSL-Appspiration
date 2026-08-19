# Review — Rules Correctness

**Artifact under review:** `ARCHITECTURE-SPINE.md` (BBSL Offseason Free Agent Auction, 2026-08-16)
**Lens:** rules correctness only — can this architecture *express* every rule the PRD states, and does it *force* the stated outcome rather than permit a divergent one?
**Sources:** `prd.md` §3, §4.4, §4.5, §5, §10; `addendum.md` §C, §D, §E
**Reviewer stance:** the PRD says *"rule correctness is the product"* and *"a rules bug is a worse failure than an outage."* Every finding below is judged by one test: **would two competent implementers, each reading only this spine plus the PRD, produce the same dollar figure?** Where the answer is no, and money moves, it is a defect of the spine — not a detail for the story.

---

## Verdict

**PASS WITH FINDINGS.**

The paradigm is the right one and it is the right one *for the stated reason*. Functional core + injected time + injected seed + append-only log + derived-never-stored money is precisely the shape that makes FR-35's exposure recomputation and FR-20's reproducible draw structural rather than aspirational. AD-7 in particular does real work: §10 example 20 ("overflow clears when a slot resolves") requires no code at all under AD-7, because there was never a cached figure to invalidate. That is a genuinely good architectural choice and it should survive this review intact.

But the spine stops one level above where the money is decided. It fixes *where* rules live and *how* they are made deterministic; it does not fix *which state they are evaluated against*, *in what order*, or *which events touch which clock*. Three of those gaps are money-bearing and implementation-defined as written. None requires a redesign — all are pin-downs, mostly a paragraph each — but they must land before epic/story breakdown, because each one is the kind of thing a story author will "obviously" resolve one way and a reviewer will "obviously" read the other.

**Blocking before story breakdown:** RC-1, RC-2, RC-3.
**Blocking before the auction opens:** RC-4 through RC-9.

---

## Findings

| ID | Sev | One line |
|---|---|---|
| RC-1 | **CRITICAL** | AD-10's batch close sweep pins neither the close *order* within a pass nor whether slot occupancy carries forward *between* closes in the same pass — so FR-35's slot-placement outcome is implementation-defined, and a $0 cap hit and a $30M cap hit are both "correct". |
| RC-2 | **CRITICAL** | Bid legality under FR-35 must be evaluated against the *hypothetical post-bid* state, but AD-6 ("validates against what it reads under that lock") and AD-7 ("computed from committed state") both point at the *pre-bid* state; the two readings give opposite answers on §10 example 19. |
| RC-3 | **CRITICAL** | AD-5's "a full rebuild must produce byte-identical projections" is falsifiable as written, because folds depend on **mutable** reference data (the Minor League Eligible flag, Existing Contract cap hits, FR-32 cap adjustments) — so the primary repair tool can silently convert a $0 cap hit into a $30M one. |
| RC-4 | **HIGH** | A Minimum-Bid Contention on a **Minor League Eligible** player — the modal lottery, since $1M fringe players are exactly the under-82-games population — is governed by two contradictory rules (Glossary/FR-14 say a flat $1M is committed; FR-35 says eligible bids commit only Minors Exposure), and the spine does not notice the collision. |
| RC-5 | **HIGH** | FR-22's *"reset by any Nomination or any valid Bid, and by nothing else"* appears nowhere in the spine; in an event-sourced fold the idiomatic implementation resets the League Clock on **every** event, and AD-18's example 13 only catches the `AuctionClosed` case, not draws, dissolutions, overrides, pause/resume or phase events. |
| RC-6 | **HIGH** | Clock expiry must be derived from injected `now` on *every* command rather than read from a projection status flag; otherwise a bid landing in the post-expiry / pre-sweep window is accepted, and if that window is the **League Clock's**, one late bid extends the entire Auction Phase by 48 hours. |
| RC-7 | **HIGH** | AD-10 (the sweep reads persisted absolute close times) and AD-11 (pause never shifts absolute close times) collide head-on: any sweep tick during a pause sees every stale `closeAt` in the past and closes the whole board. |
| RC-8 | **HIGH** | AD-12's commit-reveal is defeated by AD-4 + FR-33 if the pre-draw seed lives in the league-readable event log, and the **order** of the contender list — a direct input to who wins — is not pinned anywhere. |
| RC-9 | **HIGH** | Nothing pins the *load set* the shell hands to `decide()`; AD-7's "computed at validation time" is fully satisfiable by a core that was never shown the team's other open auctions, which is exactly the FR-35 bug class. |
| RC-10 | MEDIUM | §10 examples 18 → 19 → 20 do not compose (18 and 20 imply `M = 3`; 19 asserts `M = 1`), yet AD-18 declares all 21 examples the executable specification with no rule for a PRD example that contradicts itself. |
| RC-11 | MEDIUM | Refusals are rolled back and therefore leave no trace at all, which defeats NFR *Measurability* and makes "the app refused my legal bid" unadjudicable — the exact dispute SM-1 exists to prevent. |
| RC-12 | MEDIUM | Rejection-reason precedence is unspecified; on §10 example 15's own facts FR-11's self-outbid rule fires before the increment rule, so the literal expected message ("price moved") is not what a naive check order produces. |
| RC-13 | MEDIUM | No total-ordering discipline for collections entering the core, and no deterministic event identity — which breaks AD-13's idempotency keys and, again, AD-5's byte-identical rebuild. |
| RC-14 | MEDIUM | AD-3 does not say whether `now` in a sweep is the sweep instant or each auction's nominal expiry; events carry only `occurredAt`, so nominal ordering is unrecoverable from the log and FR-21's 60-second SLA is unmeasurable from the artifact that is supposed to be the truth. |
| RC-15 | LOW | Two-runtime hazards AD-2 creates are unaddressed: `bigint` columns arrive as strings from the Postgres driver (against the "never a string" convention), and any locale-sensitive comparison differs between Node and Deno. |
| RC-16 | LOW | AD-18's "no fixtures beyond a state literal" cannot express the 18→19→20 trajectory (a three-command sequence) or example 12 (which is partly a notification assertion). |
| RC-17 | LOW | AD-6's enumeration of mutating transactions omits FR-1 import and FR-28 contract assignment, and FR-32 overrides are permitted during the Contract Assignment Phase. |

---

## 1. §10 examples 18, 19, 20 traced through the architecture

### 1.1 Example 18 — "stashing beats the cap, on purpose"

Team P: Cap Space `$2,000,000`, three free Minor League Slots, Roster Count 12. Bids `$30,000,000` on a Minor League Eligible player.

Traced against the spine:

| Quantity | Source under this architecture | Derivable? |
|---|---|---|
| Cap Space | `$165M − Σ` Existing Contract cap hits (mutable reference tables) `− Σ` Auction Contract cap hits (folded from `AuctionClosed`) | Yes — but see RC-3 |
| Free Minor League Slots (M) | `3 −` occupied slots: imported occupancy + minors placements folded from `AuctionClosed` | Yes — but see RC-1 and RC-3 |
| N | leading amounts on open eligible auctions, folded from `BidPlaced` / `AuctionClosed` | Yes |
| Overflow Count | `max(0, N − M)` computed in-core, never stored (AD-7) | Yes ✓ |
| Minors Exposure | sum of the Overflow Count largest eligible leading bids, in-core | Yes ✓ |
| Roster Reserve | `$1M × max(0, 12 − (12 + 0)) = $0` | Yes ✓ |

`N+1 = 1 ≤ M = 3` → Overflow Count 0 → Minors Exposure `$0` → Available Cap Space `$2,000,000` → Roster Reserve `$0` → permitted, "no cap limit" shown rather than a figure. **The architecture produces the stated outcome.** AD-7 is doing exactly what it was written to do.

Two things the spine leaves an implementer to guess, both surfaced by this example:

- **The unbounded branch is not just "skip the cap check."** FR-13 says *"only the Roster Reserve check and the ordinary increment rules apply there"* — i.e. even in the unbounded case the core must verify `Cap Space − Committed Bids − Roster Reserve ≥ 0` independently of the bid amount. AD-7 lists Maximum Bid as one derived quantity and implies one formula. An implementer reading only the spine writes one branch and drops the reserve check on the unbounded path. Cheap to pin, easy to miss.
- **The eligible flag is load-bearing reference data.** OQ-2 says the flag may become a Commissioner-set toggle. Under AD-4 that toggle lives in a *mutable* table, and toggling it retroactively changes every past exposure computation — see RC-3.

### 1.2 Example 19 — the finding: which state is a bid validated against? *(RC-2)*

This is the sharpest hole in the document, and it is invisible unless you do the arithmetic both ways.

Team P holds the `$30M` eligible leading bid and bids `$1,000,000` on a second eligible player, with one free slot in prospect. The PRD's stated outcome: **refused**, naming the `$30M` auction.

**Reading A — recompute exposure counting the prospective bid, then require non-negative headroom.**
Post-bid: `N = 2`, `M = 1`, Overflow Count 1, Minors Exposure = largest 1 of `{$30M, $1M}` = `$30M`. Committed Bids `$30M`. Available Cap Space `$2M − $30M = −$28M`. Headroom negative → **refused**, and the exposure set names the `$30M` auction for free. ✓ Matches the PRD.

**Reading B — the literal Glossary formula: `Maximum Bid = Available Cap Space − Roster Reserve`, with Available Cap Space computed from *committed* state.**
Pre-bid: `N = 1`, `M = 1`, Overflow Count 0, Minors Exposure `$0`, Committed Bids `$0`, Available Cap Space `$2M`. Roster Reserve `$1M × max(0, 12 − (12+1)) = $0`. Maximum Bid `$2M`. Bid `$1M ≤ $2M` → **permitted**. ✗ Opposite outcome, same PRD, same spine.

Reading B is what the spine's own language leads to. **AD-6** says a transaction *"validates against what it reads under that lock"* — pre-bid committed state. **AD-7** says these quantities are *"computed by the core from committed state at validation time"* — pre-bid committed state again. Neither sentence contains the counterfactual. Yet FR-35 and Glossary *Projected Active/Bench Additions* both require it: *"each computed as though the prospective bid were already placed."*

The structural point, which the spine should state in one line because it is not obvious: **for a non-eligible player the two formulations coincide** (post-bid Committed Bids includes the bid at full face value, so `headroom ≥ 0` ⟺ `bid ≤ Available_pre − Reserve`), **and for an eligible player they do not**, because the bid's contribution to Committed Bids is not its face value — it is its marginal effect on Minors Exposure, which can be `$0` (absorbed), its own amount (it is itself the overflow), or *another auction's* amount (it displaces a cheaper bid out of the overflow set). An implementer who writes the single formula from the Glossary and reuses it for eligible players ships example 19 backwards, and the §0 status callout's warning ("read FR-35 before touching cap logic") does not save them, because the formula they wrote is copied verbatim from the Glossary.

There is a further degenerate case neither document resolves: **when the prospective bid is itself the largest member of the overflow set, the test is self-referential.** Team X, Cap Space `$60M`, `M = 1`, leading an eligible auction at `$30M`, now bids `$50M` on a second eligible player. Post-bid `N = 2`, Overflow Count 1, Minors Exposure = `$50M` — *the bid being validated*. Is the test `$60M − $50M ≥ 0` (exposure already includes the bid; permitted), or `bid ≤ Available_pre − Reserve` = `$50M ≤ $60M` (also permitted, by accident, for a different reason)? Drop Cap Space to `$40M` and both refuse. The two happen to agree on this shape but for unrelated reasons, which is worse than disagreeing — it means unit tests written against one reading pass under the other until the exact shape of example 19 appears.

**Required:** a new invariant stating that `decide()` evaluates a bid by constructing the **hypothetical post-command state** and asserting `postCapSpace − postCommittedBids − postRosterReserve ≥ 0`, with the bid's own contribution entering *through* Committed Bids (via Minors Exposure for eligible players, at face value otherwise) and never as a separate subtraction. That single sentence removes the whole class.

### 1.3 Example 20 — clean, and a credit to AD-7

The `$30M` auction closes, the player takes a Minor League Slot, `N` drops to 0, `M` becomes 2, exposure returns to `$0`, and the `$1M` bid is now permitted. Under AD-7 **there is no invalidation step** — no cached exposure to clear, no fan-out recompute, no ordering hazard. FR-21's *"Any Minors Exposure the Team was carrying for this Auction is released and recomputed across its remaining eligible bids"* is satisfied by doing nothing. This is the strongest single justification for the paradigm in the document, and it should be cited as such.

One behavioural point the spine should state because the UI will get it wrong: the refused `$1M` bid is **not** queued or retried. It never became an event (FR-13), so nothing replays it — the manager must re-place it, and in the interval another team may take the auction. Under FR-12's "recomputes within one second" the manager's controls will re-enable themselves silently. Worth an explicit "refusals are never retried" line, since an implementer who has just built an outbox will reach for one.

### 1.4 Example 19 does not compose with 18 or 20 *(RC-10)*

Example 18 gives Team P **three** free Minor League Slots. Example 20 says that after the `$30M` player is stashed Team P has **two** free slots — consistent with three. Example 19, between them, asserts **one** free slot (`M = 1`) and derives Overflow Count 1 from it.

Written as a literal continuation of 18, example 19 computes `N = 2 ≤ M = 3` → Overflow Count 0 → **permitted**, the exact opposite of its stated outcome. The `M = 1` appears to have been imported from FR-35's own worked example, which uses `M = 1` consistently.

This matters because **AD-18 makes the examples the executable specification** and requires that "a rule change that alters any example's outcome must change the PRD in the same commit." The spine has no rule for the inverse case: a PRD example that cannot be made to pass as written. An implementer will either (a) write 18/19/20 as three isolated state literals with contradictory `M` values, quietly losing the trajectory that is the *entire point* of the trio, or (b) "fix" example 19 to `M = 3` and hard-code an outcome the PRD does not state. Neither is safe. This needs a PRD erratum (make 18 open with one free slot, or have 19 restate its own preconditions) plus a spine line saying that an example the core cannot satisfy is a *blocking* PRD defect, never a test to be adjusted.

---

## 2. §10 example 15 — the co-manager race against AD-6

**Trace.** Both of Team L's managers POST a bid on the same auction within the same second. Two SvelteKit form actions, two transactions.

1. T1: `BEGIN` → `pg_advisory_xact_lock(k)` → acquired.
2. T2: `BEGIN` → `pg_advisory_xact_lock(k)` → **blocks**. Critically, AD-6 requires the lock *before any read*, so T2 has read nothing yet and holds no stale snapshot.
3. T1 reads state + server `now()`, calls `decide()`, appends `BidPlaced`, folds projections, enqueues outbox, `COMMIT` — releasing the xact lock.
4. T2 acquires, reads **post-T1** state (READ COMMITTED, fresh snapshot after the blocking lock acquisition), calls `decide()`, gets `Rejected`, `ROLLBACK`.

**Exactly one accepted bid, exactly one rejection. AD-6 delivers.** Being transaction-scoped it survives Supavisor transaction-mode pooling, as the spine notes; a session-scoped lock here would be a live bug and the spine is right to call it out. The supersession of the PRD's *"serialize per Auction"* is correct and correctly argued — the cross-auction cap breach genuinely is invisible to per-auction locking, and at 31 users global serialization costs nothing.

**But the rejection *reason* is not determined.** *(RC-12)* On these facts, after T1 commits, **Team L is the leading bidder**. FR-11 states two separate refusal rules: "a Bid at or below the current high Bid is refused" and "a Team already holding the leading Bid on an Auction cannot bid against itself; ... a direct submission is refused." Example 15 says the loser "is refused because the price moved." A core that checks self-outbid before increment returns `ALREADY_LEADING`; one that checks increment first returns `PRICE_MOVED`. AD-18 makes example 15 a named test with a stated expectation, and the spine's conventions table requires "a machine-readable reason" without ever fixing the taxonomy or its precedence.

No money moves — but the *message* is what a co-managed team uses to reconstruct what happened, and "you are already leading" reads as a bug to a manager who never bid. Pin a reason enum and an evaluation order in the conventions table.

Two smaller notes from the same trace:

- If the second manager's amount is *higher* (say `$9M` against his brother's `$8.5M`), FR-11 is unambiguous: refused, and Team L's better bid is lost. Correct per the rules; worth being a named test, because it is the case a co-manager will complain about.
- Advisory-lock wake order among waiters is not guaranteed FIFO in Postgres, so **which** manager wins is not deterministic. This is fine — the PRD only requires that the log name whichever did — but it is worth stating explicitly that determinism is a property of *replaying a recorded log*, not of concurrent admission. AD-3's "replayable against a synthetic clock" should say it replays a recorded auction, not that it reproduces a live one.

---

## 3. §10 example 13 — the League Clock *(RC-5)*

**FR-22 is a whitelist:** *"The League Clock is reset to 48 hours by any Nomination or any valid Bid, and by nothing else."* FR-21 restates the negative case: *"Auction Close does not reset the League Clock."* Example 13 makes the consequence concrete — a close at 12:00 Saturday does not push the 12:00 Sunday phase end.

**Is this pinned in the spine? No. The League Clock is not mentioned anywhere in the document.** It appears only as the bare token `48h` in the Config row of the conventions table. There is no event → clock-effect mapping.

**And the architecture makes the wrong answer the idiomatic one.** In an append-only log with projection folds, the natural expression of "a 48-hour inactivity clock" is a fold over the event stream:

```
leagueClockExpiresAt = lastEvent.occurredAt + 48h
```

That fold is correct for `NominationPlaced` and `BidPlaced` and **wrong for every other event in the log** — and by AD-4 the log contains all of them: `AuctionClosed`, `ContentionDissolved`, `RandomizerDrawn`, `BidVoided`, `AuctionPaused`, `AuctionResumed`, phase transitions, commissioner overrides. The rule is a whitelist; the log invites a blacklist-free fold. An implementer does not have to be careless to get this wrong — they have to be *idiomatic*.

AD-18 provides partial cover: example 13 is a named test, and it catches `AuctionClosed`. It catches nothing else. The uncovered cases:

| Event | Correct effect on League Clock | Covered by a §10 example? |
|---|---|---|
| `NominationPlaced` | reset to 48h (FR-7) | Partially (13) |
| `BidPlaced` — standard | reset (FR-11) | Yes (13) |
| `BidPlaced` — lottery join at exactly $1M | reset (FR-18 explicitly) | **No** |
| `BidPlaced` — dissolving bid ≥ $1.5M | reset (it is a valid Bid) | **No** |
| `AuctionClosed` | **no** reset (FR-21) | Yes (13) |
| `RandomizerDrawn` | **no** reset (it is a close) | **No** |
| `BidVoided` (FR-32) | unspecified in the PRD | **No** |
| `AuctionPaused` / `AuctionResumed` | must not reset; and AD-11 must preserve the League Clock's remaining duration too | **No** |

The `BidVoided` row is a genuine gap in **both** documents, and it moves money. The voided bid *did* reset the League Clock when it landed. Does voiding restore the prior League Clock value? FR-32 says voiding "restores the Auction to its state before that Bid, including the prior Leading Bidder and the prior Clock value" — the *Auction* Clock, singular, scoped to that auction. If the League Clock is not also rewound, a void leaves the phase end 48 hours later than the rules imply; if it is rewound, the phase can end *immediately* on the void. Either answer changes which auctions sitting in **Awaiting Opening Bid** die unclaimed under FR-22 — i.e. which players stay free agents. That is a money outcome decided by a coin flip between two implementers.

**Required:** an explicit event → clock-effect table in the spine, stated as a whitelist with a default of "no effect", covering both the League Clock and the Auction Clock, and an added §10-style example for the void case once the PRD resolves it.

---

## 4. §10 examples 9 and 10 — dissolution and the dead zone

**Example 9 (dissolution).** Team I bids `$1.5M` at 20:30 Monday into a lottery holding contenders E, F, G. Contenders release, I leads, state → Standard Contention, close resets to 20:30 Tuesday, next valid bid `$2.0M`.

The architecture expresses this cleanly. One `PlaceBid` command, `decide()` returns a multi-event result (`ContentionDissolved` + `BidPlaced`, or one event carrying both effects), the fold releases the three `$1M` commitments — which under AD-7 means *nothing is released*, because nothing was stored; the next computation of Committed Bids simply no longer finds an open contention with those teams in it. The clock reset derives from injected `now + 24h`, server-authoritative, exactly as AD-3 requires. `$1.5M + $500k = $2.0M` is integer arithmetic under AD-8. FR-19's "regardless of Contender count" and "a Contender may be the converting bidder" are both trivially true of a pure function over a contender set. The spine even names `ContentionDissolved` in its event-naming convention, which is a good sign that the shape was considered.

The one thing to pin: **the event decomposition.** Does a dissolving bid emit one event or two, and in what order? It does not affect the outcome, but it affects the Discord/email fan-out (FR-19 requires "every former Contender is notified that the lottery dissolved"), the outbox idempotency keys (AD-13), and the audit log's readability. The conventions table should state that a command's `Event[]` is ordered cause-before-effect and that notifications derive from event *type*, not from command type.

**Example 10 (the dead zone).** `$1,200,000` into a Minimum-Bid Contention is refused — too high to join, too low to convert. This is a pure predicate over `(auctionState, amount)` and the core expresses it without difficulty. ✓

One trap worth writing into the test rather than leaving to inference: **the dead zone exists only *inside* an existing Minimum-Bid Contention.** FR-16 says an auction enters Standard Contention when "its Opening Bid exceeds $1,000,000" — so a `$1.2M` **opening** bid on an *Awaiting Opening Bid* auction is perfectly legal and opens a standard ascending auction. A test author who writes example 10 as "a $1.2M bid is refused" without pinning the precondition will write a rule that also refuses a legal opener. The PRD is correct; the example's phrasing is lossy; AD-18 turns lossy phrasing into code.

**Examples 6, 7, 8, 11 (lottery lifecycle) — and RC-8.** These trace correctly through AD-12's commit-reveal, with two exceptions that the spine must close:

1. **Where does the seed live before the reveal?** AD-12 says the system "generates a seed, persists it, and publishes only `hash(seed)`." AD-4 says the audit log *is* a read of `auction_events`, and FR-33 says any Manager can read the complete Audit Log. AD-9 forbids client write privileges but says nothing about restricting `SELECT`. If the seed is persisted as an event payload on `MinimumBidContentionOpened`, **it is readable by every manager the moment the lottery opens**, and commit-reveal collapses. The consequence is not academic: the contender list is public and live (FR-24), so any contender can simulate the draw at any point and, on discovering they will lose, place a `$1.5M` dissolving bid and take the player outright under FR-19. A provably fair lottery becomes a determinate outcome favouring whoever reads the database. AD-12 needs a sentence: the seed is written to a store not exposed by the audit projection, and the audit projection redacts it until the corresponding `RandomizerDrawn` event exists.
2. **The contender list's *order* is an input to the winner and is not pinned.** FR-20 requires "the ordered Contender list" and AD-12 requires "a documented, deterministic procedure reproducible by hand." A procedure of the form `index = H(seed) mod n` over an *unspecified* ordering is not reproducible — two rebuilds, or two implementers, or a projection query without an explicit `ORDER BY`, produce different orders and therefore different winners from the same seed. The spine must pin: order by the sequence number of each team's joining `BidPlaced` event, ascending, with no other tiebreak needed (log sequence is a total order). And it must pin the derivation itself (hash function, encoding, modulo-bias handling) — "documented" is a promise, not a specification.

---

## 5. FR-21 slot placement under AD-10's batch sweep — the real hole *(RC-1)*

FR-35: *"Slot Placement is evaluated against the Team's slot occupancy at the moment of Auction Close, so two Auctions closing in sequence can place the first Player in minors and the second in Active/Bench."*

AD-10: the sweep *"read[s] expiry from persisted absolute close times and reconcil[es] every overdue auction it finds on each pass"*, via a single `CloseExpiredAuctions` command down the identical lock → decide → append path.

**Two questions the spine does not answer, both money-bearing.**

### 5.1 Does occupancy carry forward *within* a pass?

Team M leads two eligible auctions, both overdue in the same sweep pass, with **one** free Minor League Slot.

- **Sequential, state carried forward (correct):** first close takes the slot at `$0` cap hit, Roster Count unchanged; second close finds zero free slots, takes an Active/Bench Slot at full cap hit, Roster Count +1. This is precisely §10 examples 16 → 17, and precisely the worst case FR-35's Minors Exposure was *sized for*.
- **Batch, all placements computed against the pre-sweep snapshot (wrong, and natural):** both closes see one free slot, both place into minors. Team M now holds **four** players in three Minor League Slots. The invariant `M = 3 − occupied` goes negative, both cap hits are `$0`, and the team's post-auction salary is understated — which FR-30's export validation may or may not catch, since it checks total salary and Roster Count, not slot-count sanity.

An implementer told "close all overdue auctions in one pass" and handed a pure `decide(state, command, ...)` will very reasonably build `CloseExpiredAuctions` as a *fold over the overdue set against one loaded state*, because that is what the signature suggests. The spine must state that closes are applied **sequentially, each against the state produced by the previous**, and that a batch close is a sequence of unit closes sharing a transaction and a lock, not a set operation.

### 5.2 What determines close *order* within a pass?

The spine pins nothing. Candidates an implementer might pick: the order rows come back from an unordered `SELECT` (planner-dependent, and *unstable between runs*); auction id; nomination order; nominal close time.

The only order consistent with the PRD is **ascending nominal expiry** — the sweep is merely late, and the rules say each auction closes "at Auction Clock expiry", so a 10-second sweep must not reorder events that the rules ordered by seconds. Note that "later" is not a rounding detail here: two auctions can expire 3 seconds apart and be swept together, and under FR-35 those 3 seconds decide which player carries a `$30M` cap hit and which carries `$0`.

**Exact ties are real and need a pinned tiebreak.** Two lotteries opened by the same sweep-adjacent event, or two bids landing in the same second under the global lock, produce identical `closeAt` values. The natural tiebreak is the log sequence number of the event that set each auction's current close time — which is a total order by construction, requires no new data, and is reproducible on rebuild.

**Related, and also unpinned:** is a sweep pass **one transaction** or one transaction per auction? Under AD-6 either is safe from corruption, but they differ observably. One transaction per auction releases the global lock between closes, so a manager's bid can interleave *between* two closes — landing on an auction whose nominal expiry has already passed but which has not yet been swept (see RC-6), and changing the slot occupancy the second close sees. That is a different set of contracts than the atomic version produces, from the same inputs. One transaction per pass is the right answer here (it makes the pass a single point in the log's total order), and it should be stated.

**This is the finding the review was most worried about and it is real.** It is also the cheapest to close: three sentences in AD-10.

---

## 6. AD-3's `now` inside a sweep *(RC-6, RC-7, RC-14)*

AD-3: *"the current instant enters the core as a parameter, sourced from the database server's clock at transaction start."* In a sweep, that is **the sweep instant** — up to ~10 seconds after nominal expiry in the happy path, and arbitrarily later after a deploy, an outage, or a Supabase Cron hiccup.

### 6.1 Does it matter for the close outcome?

Mostly no, and that is a credit to the design. The winner, the price, and the placement of a single close are all functions of the auction's state at expiry, not of `now`. Nothing in FR-21 reads the clock except the act of noticing expiry.

**But three things do depend on it:**

**(a) `occurredAt` and the audit trail.** *(RC-14)* Events carry `occurredAt` only. If that is the sweep instant, then two auctions with nominal expiries 3 seconds apart are recorded as closing at the *same* instant, and the log — the thing AD-4 makes the sole truth and AD-15 makes the durability story — no longer contains the fact that decided the FR-35 placement dispute. A manager asking "why did my player get the Active/Bench slot?" is answered only by log *sequence*, which is an implementation artifact rather than a stated rule. Additionally, FR-21's **60-second close SLA** and SM-1 cannot be measured at all without both timestamps. Events should carry `occurredAt` (real, sweep instant) **and** `effectiveAt` (nominal expiry), with rules ordering on `effectiveAt`.

**(b) The post-expiry / pre-sweep admission window.** *(RC-6)* This is the serious one. Between nominal expiry and the sweep noticing, the auction's *projection row* still says open. A `PlaceBid` arriving in that window takes the lock, reads the projection, sees `status = 'open'`, and — unless the core independently derives expiry from injected `now` — **is accepted**. That bid resets the Auction Clock by 24 hours and hands the player to a different team. The PRD forbids it directly (NFR: *"A client with a skewed clock must not ... be able to bid after expiry"*), but the spine provides only the *mechanism* (AD-3's injected `now`) and never states the *obligation*. An implementer who guards on a projection status flag — the obvious thing to do when you have a projection — ships this.

The same shape applied to the **League Clock** is materially worse. If the League Clock expired at 12:00:00 and the sweep runs at 12:00:08, a bid at 12:00:04 read against a `phase = 'auction'` projection flag is accepted, and by FR-22 that bid **resets the League Clock to 48 hours** — one late bid, inside a window the architecture itself creates, extends the entire Auction Phase by two days and rescues every dead nomination that was about to expire unclaimed. After a deploy or a paused sweep the window is minutes, not seconds.

**Required invariant:** phase and auction expiry are **derived from injected `now` against persisted absolute close times on every command**, never read from a persisted status flag. The flag may exist as a projection convenience for rendering; it may never be the check that matters. This is AD-9's "client-side validation is never the check that matters" applied one layer deeper, to the server's own cache of its own clock.

**(c) Pause.** *(RC-7)* AD-10 says the sweep reads persisted absolute close times. AD-11 says pause stores remaining duration and *"absolute close times are never shifted in place."* Put together as written: **during a pause, every persisted `closeAt` still reads as its pre-pause value, and every sweep tick sees the entire board as overdue.** Pause at 23:59 on a 24-hour clock, resume two hours later, and the sweep has closed the auction — at the wrong price, to the wrong team, an hour and fifty-nine minutes early. The mechanism whose whole purpose is surviving a >15-minute outage (NFR *Availability*) fires the failure it exists to prevent.

Neither AD mentions the other. The fix is one clause — the sweep's overdue predicate must exclude any auction whose clock is paused, and pause must be visible to that predicate as committed state, not inferred — but the two ADs currently read as independently correct and jointly broken, which is the hardest kind of defect to spot in review.

---

## 7. Residual non-determinism in the core

Given AD-1 (no `Date.now()`, no `Math.random()`, no I/O, stdlib only), AD-3 (time injected), AD-8 (integer dollars) and AD-12 (seed injected), the obvious sources are closed. The residual ones are all *ordering* and *input-set* sources, and none is currently addressed.

**7.1 Mutable reference data under a fold *(RC-3, the biggest one).*** AD-4 draws the boundary correctly — *"the world is not event-sourced, only the auction is"* — but AD-5 then claims that a full rebuild *"must produce byte-identical projections"* and calls rebuild *"the primary repair tool for a solo operator."* Those two cannot both hold, because the fold reads mutable reference data:

- the **Minor League Eligible flag** (OQ-2 explicitly contemplates it becoming a Commissioner-set toggle) — flip it and every historical Overflow Count, Minors Exposure and Slot Placement recomputes differently;
- **Existing Contract cap hits**, which FR-36 states may be *"altered by a Commissioner override"* — change one and every historical Cap Space and therefore every historical Maximum Bid recomputes;
- **FR-32's "adjust a Team's Cap Space"**, which under AD-7 cannot be stored anywhere (Cap Space is derived), so it must land either as an event or as an edit to a reference row — and the spine does not say which.

The failure mode is concrete and severe: an operator uses AD-5's blessed repair tool after a commissioner corrected a mis-imported salary, and a player who was stashed at a `$0` cap hit under example 18 is re-derived into an Active/Bench Slot at `$30M` — silently, with the log unchanged, and with the "byte-identical" guarantee cited as reassurance that nothing moved.

Two ways to close it, and the spine should pick one: (i) **snapshot reference data at auction open** and make every rule read the snapshot, with any post-open change expressed as an event carrying a delta; or (ii) forbid all post-open mutation of arithmetic-bearing reference data outright and route every correction through a compensating event (`CapAdjusted`, `EligibilityCorrected`, `ContractCorrected`), so folds read only the log. Option (ii) is more consistent with AD-4's existing "correct by appending, never by mutating" stance and costs three event types.

**7.2 Unordered collections *(RC-13).*** Every rule that reduces over a *set* needs a total order or it is only accidentally deterministic:

- the **contender list** for the draw (§4 above) — order changes the winner;
- the **"Overflow Count largest" eligible bids** — the *sum* is order-independent, so money is safe, but FR-35 requires the refusal to *name the specific earlier eligible Bid creating the exposure*, and under ties (two eligible leading bids at the same amount) which auction gets named is arbitrary. AD-18 turns that into a flaky test;
- the **overdue set** in a sweep (§5 above) — order changes the cap hit.

Pin one convention: every collection entering a rule is sorted by an explicit total order terminating in an identifier, and the core never iterates a `Set` or object-key order.

**7.3 Event identity *(RC-13).*** AD-13's idempotency key is *"derived from the event identity."* AD-1 forbids the core from generating randomness, so event ids must come from the shell (a UUIDv4 — non-deterministic) or the database sequence. If ids are UUIDv4 and any projection stores them, AD-5's byte-identical rebuild fails on the ids alone; if the outbox key is derived from a UUID, a rebuild produces different keys and FR-26's "at most once per event" is not preserved across a replay. Derive identity from `(log sequence, event type)` or a deterministic hash of the event payload plus its position.

**7.4 The load set handed to `decide()` *(RC-9).*** This is the quiet one. The core is pure, which means it is deterministic *given its inputs* — and the spine never says what those inputs must contain. AD-7 requires exposure to be "computed by the core from committed state at validation time"; a shell that loads only the target auction plus the bidding team's row satisfies every sentence of AD-7 and produces catastrophically wrong exposure, because Minors Exposure is a function of the *set* of eligible auctions the team leads league-wide (addendum §D.4 flags this as "the hardest of the four" races). AD-6 protects the *concurrency* of the read; nothing protects its *completeness*. The spine needs a stated minimum load set for each command — for `PlaceBid`: the target auction, the team's roster and slot occupancy, **every open auction the team currently leads or contends in**, and league phase/clock state.

**7.5 Two-runtime hazards AD-2 creates *(RC-15).*** AD-2 is right that one core in two runtimes is the correct trade, but it introduces two divergence surfaces the spine does not name: any locale-sensitive comparison (`localeCompare`, `Intl.Collator`) can differ between Node 26 and the Deno edge runtime, and `bigint` columns arrive from the Postgres driver as **strings** by default — which collides with the conventions table's "never a string" for money. Neither breaks the *core's* purity, but both break the *system's* determinism at the shell boundary, and the shell is where the core's inputs are built. State that the core compares only numbers and ids, and that the shell parses money at the boundary with an explicit `bigint` → `number` conversion plus a range assertion.

---

## 8. What the architecture gets right

Recorded deliberately, because the findings above should not be read as a verdict on the paradigm:

- **AD-7 is the correct central bet.** Example 20 needs no code. FR-14's "released the instant the Team ceases to be Leading Bidder" needs no code. Addendum §D.4's stale-exposure warning is structurally impossible rather than merely tested against. This is the single best decision in the document.
- **AD-6's supersession of the PRD's per-auction serialization is correct and correctly argued.** It identifies a real class the PRD's NFR does not cover, justifies the cost honestly against the stated scale, and — importantly — specifies "before reading any state" and "transaction-scoped, never session-scoped", the two details that make it actually work under Supavisor.
- **AD-1 + AD-3 + AD-12 together make FR-20 reproducible by construction** rather than by an added audit feature. "Reproducing a draw is calling the same function again" is exactly right.
- **AD-4's boundary** — the auction is event-sourced, the world is not — is the right cut, and it is the reason RC-3 is a fixable seam rather than a redesign.
- **AD-18 is the correct enforcement mechanism** and the "change the PRD in the same commit" clause is what keeps the examples from rotting. It needs the amendments in RC-10 and RC-16, not replacement.
- **AD-9's "client-side validation is never the check that matters"** is the right posture, and RC-6 is essentially a request to apply that same posture to the server's own projection flags.

---

## 9. Recommended amendments, in priority order

1. **Amend AD-10** — closes are applied sequentially, each against the state the previous produced; a pass is one transaction under one lock acquisition; order is ascending nominal expiry with the log sequence of the clock-setting event as tiebreak. *(RC-1)*
2. **New AD — bid evaluation state.** `decide()` constructs the hypothetical post-command state and asserts `postCapSpace − postCommittedBids − postRosterReserve ≥ 0`; the command's own contribution enters through Committed Bids (via Minors Exposure for eligible players), never as a separate subtraction. *(RC-2)*
3. **Amend AD-4/AD-5** — no arithmetic-bearing reference datum may be mutated after auction open; corrections are compensating events. Restate AD-5's byte-identical guarantee as conditional on that. *(RC-3)*
4. **PRD erratum + spine rule** — resolve the Committed Bids treatment of a Minimum-Bid Contention on a Minor League Eligible player, and state that a §10 example the core cannot satisfy is a blocking PRD defect, never a test to be adjusted (fixes both RC-4 and RC-10).
5. **New AD or conventions row — an event → clock-effect table**, whitelist form, default "no effect", covering both clocks and every event type including `BidVoided`, pause and resume. *(RC-5)*
6. **New AD — expiry is derived, never flagged.** Phase and auction expiry are computed from injected `now` against persisted absolute close times on every command. *(RC-6)*
7. **Amend AD-10/AD-11** — the sweep's overdue predicate excludes paused clocks; pause state is committed state visible to that predicate. *(RC-7)*
8. **Amend AD-12** — the seed is not readable through the audit projection until `RandomizerDrawn` exists; pin the contender ordering (joining-event log sequence) and the seed → index derivation including modulo-bias handling. *(RC-8)*
9. **New conventions rows** — minimum load set per command *(RC-9)*; total-order discipline for every collection entering a rule *(RC-13)*; rejection reason enum with fixed evaluation order *(RC-12)*; deterministic event identity *(RC-13)*; `occurredAt` + `effectiveAt` on events *(RC-14)*.
10. **Amend AD-18** — examples may be command *sequences*, not only single state literals; add the named tests implied above (lottery join and dissolving bid do reset the League Clock; a draw does not; a bid after nominal expiry is refused; a paused clock is not swept). *(RC-16)*
11. **Decide and record** whether refusals are persisted (a `BidRefused` audit-only event kept out of the rules fold), against NFR *Measurability* and SM-1. *(RC-11)*
