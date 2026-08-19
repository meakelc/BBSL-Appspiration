# Adversarial Review — ARCHITECTURE-SPINE.md (BBSL Offseason Free Agent Auction)

- **Reviewed:** `ARCHITECTURE-SPINE.md` (2026-08-16, draft), against `prd.md` and `addendum.md`
- **Lens:** adversarial. The question asked of every AD was not "is this good?" but **"can I build two units, each obeying every AD to the letter, that cannot work together?"**
- **Verdict: FAIL — do not cut stories from this spine as written.**

Eleven CRITICAL divergences were constructed, each with a worked scenario in which two AD-compliant implementations produce **different owners of a player, different cap ceilings, or different lottery winners**. Several of them are not gaps but *internal contradictions* between two ADs that a developer must resolve by guessing (F-2, F-4, F-11, F-19). One of them (F-5) is a contradiction between two things the spine simultaneously declares binding: the PRD glossary (`Consistency Conventions → Domain vocabulary`, "verbatim and everywhere") and PRD §10 example 19 (AD-18, "the executable specification").

This is a strong spine. Its paradigm choice is right, AD-6's supersession of the PRD's per-auction serialization is a genuinely excellent catch, and AD-12 and AD-15 show a builder who has thought about the failure modes that actually end leagues. The findings below are almost all of the form *"the right decision was made but its consequences were not carried all the way down."* Nine or ten new/tightened ADs close every CRITICAL.

---

## Method

For each AD, I asked three questions:

1. **Two-writer test.** Name two stories, one level down, that could each legitimately claim to write the same row. If both can cite an AD, it is a hole.
2. **Two-runtime test.** Node (Netlify/SvelteKit) and Deno (Supabase Edge) build the same thing independently. Where does the shared shape differ?
3. **Two-reader test.** Two developers read the same AD and implement opposite things. Show the state where they disagree.

Findings are ordered by severity, then by blast radius. Each carries a concrete **proposed AD delta**.

---

# CRITICAL

## F-1 — Event ordering is not pinned, and AD-3 actively makes `occurredAt` non-monotonic

**Severity: CRITICAL.** Two projections of the same log, two different owners of the player.

AD-4 makes `auction_events` insert-only. AD-5 says projections are "written only by folding events" and a rebuild "must produce byte-identical projections." **Nowhere is the fold's iteration order defined.** The `Events` convention mandates `occurredAt` on every event and AD-3 declares time the injected authority; the natural read is "fold in `occurredAt` order." An equally natural read is "fold in insertion order."

AD-3 then makes these two orders *provably different*: it requires `now` be "sourced from the database server's clock at transaction start." In Postgres, `now()` / `CURRENT_TIMESTAMP` is fixed at **transaction start**, before AD-6's advisory lock is acquired. A transaction that begins earlier but queues on the lock therefore commits **later** with an **earlier** `occurredAt`.

**The two components:**

| | `src/lib/core/projection/auctionFold.ts` (Node, written for the bid path) | `supabase/functions/sweep/rebuild.ts` (Deno, written for the close path) |
|---|---|---|
| Loads | `select * from auction_events where auction_id = $1 order by occurred_at asc` | `select * from auction_events where auction_id = $1 order by id asc` |
| Cites | Convention table: `occurredAt` is the universal event field; AD-3 makes server time authoritative | AD-4: the log is insert-only, so insertion order *is* history |

**Worked divergence.** Player X, currently at $8.0M held by Team A.

| t | Event |
|---|---|
| 10:00:00.000 | Bid tx for Team B ($9.5M) does `BEGIN`; `now()` freezes at `.000`; it queues on the advisory lock behind an unrelated nomination |
| 10:00:00.100 | Bid tx for Team C ($9.0M) does `BEGIN`; `now()` freezes at `.100`; acquires the lock at `.150`, reads high bid $8.0M, `decide` accepts, appends `BidPlaced{C, 9_000_000, occurredAt: .100}` → **id 101**, commits |
| 10:00:00.160 | Team B's tx acquires the lock, reads high bid $9.0M, `decide` accepts $9.5M, appends `BidPlaced{B, 9_500_000, occurredAt: .000}` → **id 102**, commits |

Now fold:

- **By `id`:** C@$9.0M then B@$9.5M → **B leads at $9.5M**, close = `.000 + 24h`.
- **By `occurredAt`:** B@$9.5M then C@$9.0M → the last event folded is a $9.0M bid. A blind last-writer fold yields **C leads at $9.0M**, close = `.100 + 24h`. A defensive fold that ignores non-increasing amounts yields B leading but with C's close time, or throws mid-rebuild.

Three outcomes from one log, all AD-compliant. AD-5's "byte-identical" guarantee is false as stated, and the live projection (written by the Node fold) can permanently disagree with the sweep's view of who leads — which is the view that **awards the player**.

Note the secondary damage: under `occurredAt` ordering the **clock goes backwards**, because B's winning bid carries a timestamp earlier than the bid it beat. FR-16 says the clock is set "24 hours from that Bid's timestamp."

**Proposed AD-19 — Order is a single monotonic sequence assigned under the lock.**
> `auction_events` carries a single global `bigserial seq`, assigned by Postgres inside the locked transaction, and **`seq` is the sole ordering key for every fold, every rebuild, every audit-log render and every wire response.** No fold may order by `occurredAt`. Furthermore `occurredAt` is read with `clock_timestamp()` **after** the AD-6 lock is acquired, never `now()`/`transaction_timestamp()`, so that `occurredAt` is monotonic with `seq`; the shell asserts this and refuses to append otherwise. Ties are impossible by construction: `seq` is total.

---

## F-2 — AD-4 and AD-5 draw the event-sourcing boundary in different places, and an auction close crosses it

**Severity: CRITICAL.** The rebuild — AD-5's "primary repair tool for a solo operator" — is undefined for the majority of the state it would need to repair.

AD-4: *"Imported reference data (teams, players, existing contracts, roster slots) stays in ordinary mutable tables; **the world is not event-sourced, only the auction is.**"*
AD-5: *"Nothing may exist in a projection that cannot be derived from the log plus imported reference data."*

But FR-21 (Auction Close) writes **into the world**: it creates an Auction Contract, applies Slot Placement, occupies a Minor League Slot, and increments Roster Count. The spine's own ER note concedes the collision: *"`CONTRACT` spans both Existing Contracts (imported) and Auction Contracts (produced by a close)."* One table; two writers; two different ADs authorising each.

**The two components:**

| | `ImportService` (story: FR-1) | `CloseProjector` (story: FR-21) |
|---|---|---|
| Writes | `contract`, `roster_slot`, `team` — mutably, `DELETE`+`INSERT` on re-import | `contract`, `roster_slot` rows for auction winners |
| Cites | AD-4: reference data lives in ordinary mutable tables | AD-5: projections are written by folding events |

**Worked divergence — the rebuild.** 45 auctions have closed. The board is visibly wrong (a bad deploy corrupted `auction.state`). The operator runs the AD-5 rebuild, exactly as AD-5 invites him to.

- **Impl A** treats auction-produced contracts as projection rows: rebuild does `delete from contract where origin = 'auction'; delete from roster_slot where origin='auction'; replay`. Correct — but it just deleted rows that AD-4 classifies as "the world," and if the commissioner had used FR-32 to hand-correct one of them, that correction is gone.
- **Impl B** treats `contract` as reference data, out of scope for a rebuild: it truncates only `auction`, `contender`, and the cap-facing views and replays. The fold's `AuctionClosed` handler still runs and still `INSERT`s the contract row → **primary key violation on all 45, or 90 contracts and every team double-charged.**

Both are literal readings. Neither developer is wrong. The repair tool is the thing that breaks the auction.

**Worked divergence — the commissioner override.** FR-32 lets the commissioner *"adjust a Team's Cap Space,"* and FR-36 says *"Existing Contracts are reproduced exactly as imported in FR-1, **unless altered by a Commissioner override**."* So an override — which AD-4 mandates be an **event** — must alter **reference data**. Team Q's imported contract for Player Z is $5.0M and should be $8.0M.

- **Impl A** appends `CapAdjusted{teamId, deltaDollars}` and mutates the `contract` row in the same transaction. A later rebuild does not touch `contract` (reference data), so the adjustment survives — but a re-import (blocked post-open, though FR-32 override paths exist) or an audit reconciliation now shows an event whose effect is invisible in the log's projections.
- **Impl B** appends `CapAdjusted` and folds it into a `team_cap_adjustment` projection column that the cap math adds in. The adjustment survives the rebuild — but **FR-36's roster export reads `contract` directly and exports $5.0M**, while FR-13's cap enforcement uses $8.0M. Export and enforcement disagree by $3M, and the export is the artefact that goes into the league of record.

**Sub-case F-2a — Nomination Slot state has the same disease.** AD-4 puts `teams` in "ordinary mutable tables." Nomination Slot status is auction-derived state hanging off a reference-data entity, with three release paths (FR-9 close, FR-32 override, FR-22 phase end). Impl A puts `nomination_slot_player_id` on `team` and writes it in the shell — compliant, because `team` is mutable and AD-5 only governs *projection* tables. Impl B derives it into a `team_auction_state` projection. Impl A's column is **never rebuilt**, so a slot that got out of sync stays out of sync forever, and AD-5's "corrupt projection cannot become unrecoverable state" guarantee simply does not apply to it. The same argument applies verbatim to Cap Space, Roster Count, and slot occupancy — i.e. to every input of Maximum Bid.

**Proposed AD-20 — The world is split into Imported Facts and Derived World, and the rebuild owns the latter.**
> Every table is classified in the migration that creates it as exactly one of: **(a) Imported Fact** — written only by `adapters/fantrax` import, never by a fold, never by the shell after auction open; **(b) Projection** — written only by folding `auction_events`, truncated and rebuilt wholesale by the rebuild; **(c) Outbox/operational** — neither. There is no fourth class and no table in two classes. Auction Contracts, Slot Placement, Roster Count, Cap Space, occupied Minor League Slots and Nomination Slot status are **Projections**, physically separate from the imported `contract`/`roster_slot` tables (a view unions them for reads and for FR-36's export). Commissioner adjustments to Imported Facts are events folded into a Projection *delta*, never an in-place mutation of an Imported Fact — so the FR-30/FR-36 exports and FR-13's cap enforcement read the same union view by construction. The rebuild truncates every Projection and replays; it touches no Imported Fact. AD-5's "byte-identical" is asserted by a test that rebuilds into a shadow schema and diffs.

---

## F-3 — The Contender list ordering is unpinned, so the randomizer is not reproducible

**Severity: CRITICAL.** This defeats AD-12 and FR-20 outright — the one property the spine says makes a commissioner-built app acceptable.

AD-12 requires the seed→winner derivation be "a documented, deterministic procedure reproducible by hand," and FR-20 requires the recorded seed and Contender list be "sufficient for any Manager to independently reproduce the result." The derivation is deterministic **given an ordered list**. The spine pins the seed, the hash, and the reveal. It does not pin **how the list is ordered**, and the list is built by the *shell's state loader*, which AD-2 does not single-source (AD-2 covers `core/`, not `shell/`).

**The two components:**

| | `supabase/functions/sweep/loadAuctionState.ts` (Deno) | `routes/auction/[id]/+page.server.ts` (Node, renders FR-24's "live Contender list") |
|---|---|---|
| Builds `state.contenders` | `select team_id from contender order by joined_at asc` | `select team_id, team_name from contender order by team_name asc` (it is a UI list) |
| Cites | Chronology is the natural history order | FR-24 says show the Contender list; alphabetical is the obvious render |

**Worked divergence.** PRD §10 examples 6–8, with real team names. Contenders join in this order: **Warriors** (09:00 Mon, opener), **Bulls** (14:00 Mon), **Jazz** (20:00 Mon), **Aces** (08:55 Tue). Draw at 09:00 Tue. Documented derivation: `index = uint64(sha256(seed)) mod n`, take `list[index]`. Suppose `index = 0`.

- Sweep's chronological list `[Warriors, Bulls, Jazz, Aces]` → **Warriors wins.**
- A manager re-running the check by hand off the auction page, which showed `[Aces, Bulls, Jazz, Warriors]` → **Aces wins.**

The manager's independent verification *fails*, on an auction the app resolved correctly, using the exact seed and the exact list the app published. AD-12 says commit-reveal "is what makes that acceptable" that the builder is also a competing manager. An unreproducible reveal is worse than no reveal — it manufactures the accusation it was built to prevent.

**Proposed AD-21 — The Contender list has one canonical order, and it is part of the core's input contract.**
> The ordered Contender list is `ORDER BY auction_events.seq ASC` over the `$1,000,000` `BidPlaced` events of that auction (AD-19's sequence). This order is constructed **once, in `core/projection`**, not in any loader or query — the shell passes raw events; the core produces the ordered list. The `ContentionDrawn` event persists the ordered list **as an explicit array of team IDs**, and every surface that displays it (auction page, Audit Log, Discord post) renders that array in that order, with any UI re-sorting visually marked as non-canonical. The published derivation document names the seq order explicitly.

---

## F-4 — The seed leaks before the draw, because AD-4 + FR-33 make the event log league-readable

**Severity: CRITICAL.** Kills commit-reveal and changes bidding behaviour.

AD-12: *"the system generates a seed, **persists it**, and publishes only `hash(seed)`."* AD-4: *"FR-33's audit log is a read of this table, not a second table."* FR-33: *"Any Manager can read the **complete** Audit Log."*

The obvious home for a persisted seed is the `MinimumBidContentionOpened` event payload — AD-4 says the log is the truth. The audit log is a read of that table. Therefore the seed is readable by every manager the moment the lottery opens.

**The two components:**

| | `core/rules/contention.ts` + shell (story: FR-17) | `routes/audit/+page.server.ts` (story: FR-33) |
|---|---|---|
| Choice | Seed lives in the `MinimumBidContentionOpened` event payload — AD-4, the log is the truth | `select * from auction_events order by seq` and render — FR-33 says *complete* |

**Worked exploit.** Lottery opens on Player X at 09:00 Mon. Manager M opens the audit log, reads `payload.seed`, and computes the winner for every hypothetical contender list. Currently there are 3 contenders; `index = hash(seed) mod 4 = 2`, so if he joins as the 4th he lands at index 3 and loses; he waits. At 08:50 Tue there are 5 contenders; joining as the 6th gives `mod 6 = 4` — his index — so he joins and wins. He has converted a `1/n` lottery into a deterministic win, using only data the app published to him, with two AD-compliant components and no bug in either.

This is worse than a non-verifiable lottery, because the audit trail will show a clean, correctly-reproducible draw.

Second exposure: AD-9 permits the browser's read-only key on projection tables for Realtime. If `auction_events` or an `auction` projection carrying `seed` is in the `supabase_realtime` publication, the seed is pushed to every browser.

**Proposed AD-22 — The seed is service-role-only until reveal, and the reveal is an event.**
> The seed is stored in a dedicated `contention_seed` table with **no** RLS `SELECT` policy for any client role, not in an event payload and not in any projection or Realtime publication. The event log carries only `seedCommitment = sha256(seed)`. The seed enters the log exactly once, at the draw, inside the `ContentionDrawn` event, together with the ordered Contender list and the selection; the fold asserts `sha256(revealedSeed) == seedCommitment` and refuses the append otherwise. FR-33's "complete" audit log is complete over `auction_events`; the pre-reveal seed is by construction not in it. A test asserts that no query reachable with the browser's anon key returns a seed for an open contention.

---

## F-5 — Overflow Count: PRD §10 example 19 contradicts the glossary, and the spine binds itself to both

**Severity: CRITICAL.** A direct, verifiable contradiction between two things the spine declares authoritative. Two developers will write opposite tests and both will be following the spine.

- `Consistency Conventions → Domain vocabulary`: *"PRD §3 glossary terms are the identifier names, verbatim and everywhere… `overflowCount`… Introducing a synonym is a defect."*
- AD-18: *"each of the 21 examples exists as a named test… A rule change that alters any example's outcome must change the PRD in the same commit."*

**Glossary (PRD §3):** `Free Minor League Slots (M) = 3 − the number of Minor League Slots the Team **currently occupies**`. `Overflow Count = max(0, N − M)`.

**PRD §10 example 18:** Team P, **all three Minor League Slots free**, Roster Count 12, bids $30M on an eligible player. States `N+1 = 1 ≤ M = 3`. Consistent with the glossary.

**PRD §10 example 19:** *"Team P, **still holding that $30,000,000 leading bid**, now has only one Free Minor League Slot left in prospect and bids $1,000,000 on a second eligible player. That makes `N = 2` against **`M = 1`**…"* — with **no slot having been occupied**. No auction has closed. By the glossary, M is still 3.

| | Glossary reading | Example-19 reading |
|---|---|---|
| M | 3 (no slot occupied — nothing has closed) | 1 (leading bids are netted out of M) |
| N | 2 | 2 |
| Overflow Count | `max(0, 2−3) = 0` | `max(0, 2−1) = 1` |
| Minors Exposure | **$0** | **$30,000,000** |
| The $1,000,000 bid | **PERMITTED** | **REFUSED** |

**PRD §10 example 20** then uses the *glossary* reading: *"The $30,000,000 auction closes and the player takes a Minor League Slot. Team P now has **2 free slots**"* — 3 minus 1 occupied. So example 19 is the outlier, and example 20 confirms the glossary. But AD-18 makes example 19 an executable test that must pass before any production deploy.

**The two components:** `core/rules/minorsExposure.ts` written by a developer following the vocabulary convention permits the $1M bid; `tests/examples/example-19.test.ts` written by a developer following AD-18 asserts it is refused. **The repository cannot be green.** Worse, if the test is written first (per AD-18) the implementation gets bent to match, and then example 20's arithmetic no longer follows.

Note also that the example-19 reading double-counts: netting leading bids out of `M` *and* counting them in `N` charges each eligible lead twice against the same slot.

**Proposed AD-23 — Glossary formulas are the specification; examples are tests of them, and a conflict is a PRD defect that blocks.**
> Where a PRD §10 example's arithmetic cannot be produced by the PRD §3 glossary formulas, the **glossary wins** and the example is a defect to be corrected in the PRD before the corresponding story is cut. `M`, `N`, `overflowCount` and `minorsExposure` are computed by exactly one exported function in `core/rules/minorsExposure.ts`, from the glossary formulas verbatim: `M = 3 − occupiedMinorLeagueSlots` where *occupied* means **placed by a closed auction or by import**, never in-prospect. Every one of the 21 example tests imports that function; no test may encode arithmetic the function does not produce. **Blocking action: PRD §10 example 19 must be corrected (and, if the league intends the in-prospect reading, PRD §3's definition of M changed instead) before any FR-35 story is estimated.**

---

## F-6 — Is an eligible player's Minimum-Bid Contention counted in `N`? The glossary answers both ways

**Severity: CRITICAL.** A $30M swing in Maximum Bid, both readings defensible, no AD disambiguating.

Three glossary clauses collide:

1. *"**Leading Bidder** — the Team holding the highest Bid on an Auction **in Standard Contention**."* → in a Minimum-Bid Contention there is, by definition, no Leading Bidder.
2. *"**Eligible Leading Bids (N)** — the Team's **leading amounts** on open Auctions for Minor League Eligible Players."* → if there is no Leading Bidder, there is no leading amount, so a lottery on an eligible player contributes nothing to N.
3. *"**Committed Bids** — … the sum of its leading amounts on all open Auctions for Players who are **not** Minor League Eligible, plus its Minors Exposure. **A Minimum-Bid Contention the Team is contending in counts as a leading amount of $1,000,000**, since any Contender may win."* → the $1M *does* count as a leading amount.

For an **eligible** player in a lottery, clause 3's $1M is in neither branch of clause 3's own formula: the non-eligible sum excludes it (the player is eligible), and Minors Exposure is computed from N, which clause 2 says excludes it.

**The two components:**

| | `CapCalcA` (`core/rules/committedBids.ts`, story FR-14) | `CapCalcB` (`core/rules/minorsExposure.ts`, story FR-35) |
|---|---|---|
| Reads | Clause 3 as authoritative: a contention is a leading amount of $1M, so for an eligible player it enters **N at $1,000,000** | Clause 1+2 as authoritative: no Leading Bidder in a contention, so **N counts Standard Contention leads only** |

**Worked divergence.** Team P: 1 free Minor League Slot (`M = 1`), Cap Space $4,000,000, Roster Count 12. It leads an eligible Standard auction at $30,000,000 (permitted per example 18 while it had slots). It is also a Contender in a $1,000,000 lottery on a second eligible player.

- **CapCalcA:** `N = 2` (the $30M lead + the $1M contention), `M = 1` → Overflow Count 1 → Minors Exposure = largest 1 = **$30,000,000**. Committed Bids $30M against $4M of Cap Space. Available Cap Space is **−$26,000,000**. Every further bid is refused, and — worse — the app is now telling a team it is $26M over the cap on money it may never spend.
- **CapCalcB:** `N = 1`, `M = 1` → Overflow Count 0 → Minors Exposure **$0**. And the lottery's $1,000,000 falls through *both* branches, so Committed Bids = **$0**. Team P has two eligible wins in flight, one slot, and zero dollars committed. If both land, one is a $30M cap hit against $4M of space — the exact over-cap outcome FR-13 exists to make impossible.

Both are compliant with AD-7 (neither stores anything) and with AD-1 (both are pure). AD-18 does not adjudicate: no §10 example puts an eligible player in a lottery. This is the single most likely silent cap breach in the system.

**Proposed AD-24 — One exhaustive classification of every open auction a team is exposed to.**
> `core/rules/exposure.ts` exports one function that partitions **every** open auction the team has money at risk in into exactly three disjoint buckets and asserts the partition is total (a runtime exhaustiveness check, not a comment): (i) non-eligible leads → face value into Committed Bids; (ii) eligible leads → into `N` for the Minors Exposure computation; (iii) Minimum-Bid Contentions → **for a non-eligible player, $1,000,000 into Committed Bids at face value; for an eligible player, $1,000,000 into `N` as an Eligible Leading Bid.** Rationale, recorded: a Contender may win, and if it wins an eligible player its slot consumption is real, so it must consume a slot in the worst-case model. **This requires a new PRD §10 example (22) and a corresponding glossary sentence.**

---

## F-7 — AD-6 does not pin the lock key, and Postgres has two disjoint advisory lock spaces

**Severity: CRITICAL.** The Node side and the Deno side can each "take the same single advisory lock" and not exclude each other.

AD-6: *"every mutating transaction acquires **the same single** `pg_advisory_xact_lock` before reading any state."* It names the function. It does not name the **key**, or the **arity**. Postgres documents the one-argument (`bigint`) and two-argument (`int, int`) forms as occupying **separate lock spaces**: `pg_advisory_xact_lock(1, 1)` and `pg_advisory_xact_lock(4294967297)` do not conflict.

**The two components:**

| | `src/lib/shell/withAuctionLock.ts` (Node) | `supabase/functions/sweep/index.ts` (Deno) |
|---|---|---|
| Acquires | `select pg_advisory_xact_lock(hashtext('bbsl_auction'))` — one arg, hashed name | `select pg_advisory_xact_lock(1, 1)` — two args, "namespace 1, lock 1" |

Both developers believe they took "the single global auction lock." Both are obeying AD-6 verbatim. **They do not exclude each other.**

**Worked divergence — precisely the failure AD-6 exists to prevent.** Auction on Player X closes at 10:00:00, high bid Team A $9.0M. At 10:00:00.020 the sweep begins closing it. At 10:00:00.030 Team B submits $9.5M. No mutual exclusion:

1. Sweep reads state: A leads $9.0M, expired. `decide` → `AuctionClosed{winner: A, 9_000_000}`.
2. Bid tx reads state (auction still open in the projection, it hasn't committed): `decide` → `BidPlaced{B, 9_500_000}`, clock reset to +24h.
3. Both commit. The log contains `AuctionClosed` then `BidPlaced` on a closed auction (or the reverse, per F-1).

Team A is awarded a player at $9.0M **and** Team B is the leading bidder on a 24h clock for a player that is already on A's roster, with $9.5M committed against B's cap forever. This is SM-1's "disputed outcome," reachable through two units that each obey every AD.

Related, unpinned: `hashtext` output is not a documented-stable value across major versions, so even a name-hashed key should be materialised as a constant.

**Proposed AD-25 — The lock key is a named constant with pinned arity, taken by one shared helper.**
> There is exactly one lock-acquisition helper, in the shared `core`-adjacent module `shell/lock`, exporting the literal `AUCTION_LOCK_KEY = 4_242_000_001n` and issuing **`select pg_advisory_xact_lock($1::bigint)`** — the one-argument form, always, no exceptions. Both runtimes import this constant from the same file (AD-2's single-source obligation extends to it). No other `pg_advisory_*` call appears anywhere in the repository; a CI grep enforces it. The helper also asserts `pg_backend_pid()`-scoped transaction state so a session-scoped variant cannot be introduced by accident.

---

## F-8 — FR-32 "void a bid" cannot reconstruct the prior clock under AD-11, and three legal answers exist

**Severity: CRITICAL.** FR-32 promises *"restores the Auction to its state before that Bid, including the prior Leading Bidder and the prior Clock value."* AD-4 says the mechanism is a compensating event. Neither pins what "restores" means, and AD-11's pause makes the prior absolute clock value **meaningless**.

### 8a — Voiding a non-latest bid

**The two components:**

| | `VoidBidFold` — subtractive (`core/projection`) | `VoidBidFold` — compensating (`core/rules/override`) |
|---|---|---|
| Model | `BidVoided{voidedSeq}` is a **filter**: the rebuild skips the voided event and re-folds everything after it. This is the literal reading of "restore the state before that Bid." | `BidVoided{voidedSeq, restoredLeaderTeamId, restoredAmountDollars, restoredClosesAt}` computed by the core at void time; the fold applies the recorded values. |

**Worked scenario.** Player X:

| seq | Event |
|---|---|
| 1 | Mon 10:00 — Team A bids $8.0M → close Tue 10:00 |
| 2 | Mon 14:00 — Team B bids $8.5M → close Tue 14:00 |
| 3 | Mon 18:00 — Team A bids $9.0M → close Tue 18:00 |
| 4 | Mon 20:00 — Commissioner voids **seq 2** (B's manager was signed in on a shared device; FR-32, reason recorded) |

- **Subtractive, blind fold:** skip seq 2, fold 1 then 3 → **A leads at $9.0M**, close Tue 18:00. But seq 3 was A raising *itself*, which FR-11 forbids ("A Team already holding the leading Bid cannot bid against itself"). The projection is now a state the rules say is impossible.
- **Subtractive, re-deciding fold:** skip seq 2, re-run `decide` per event → seq 3 is **rejected** (A bidding against itself) → **A leads at $8.0M**, close **Tue 10:00**. A bid that was accepted, announced to Discord, and emailed to the league has been retroactively erased — and the close time is now in the past relative to Mon 20:00? No, but it will be 14 hours earlier than every manager was told.
- **Compensating:** "state before that Bid" = A at $8.0M, close Tue 10:00, and seq 3 is discarded as collateral even though it was not voided. Or the implementer decides FR-32 only applies to the *current* leading bid and refuses the override entirely.

Three or four defensible outcomes, differing in **who owns the player** and in a **14-hour clock difference**. All AD-compliant.

### 8b — Void after a pause: the prior clock value no longer exists

AD-11: pausing persists remaining duration; resuming *"recomputes absolute close times forward from the resume instant. Absolute close times are never shifted in place."*

| seq | Event |
|---|---|
| 1 | Mon 10:00 — A bids $8.0M → close **Tue 10:00** |
| 2 | Mon 14:00 — B bids $8.5M → close **Tue 14:00** |
| 3 | Mon 15:00 — Commissioner pauses. Remaining for X = 23h. |
| 4 | Tue 09:00 — Commissioner resumes (18h outage). Close recomputed = **Wed 08:00**. |
| 5 | Tue 10:00 — Commissioner voids **seq 2**. |

What is "the prior Clock value"? The value the clock held before seq 2 was **absolute Tue 10:00** — which is *now*, and which no longer corresponds to any real remaining duration, because 18 hours of paused wall-clock passed in between.

- **Impl A** restores the recorded absolute `closesAt` of Tue 10:00 → the auction is instantly overdue → **the very next 10-second sweep pass closes it and awards Player X to Team A at $8.0M**, with no notice to anyone, as a side effect of an override intended to *undo* a bid.
- **Impl B** restores the *remaining duration* that stood before seq 2 (20h at that moment) forward from the void instant → close Wed 06:00.
- **Impl C** subtracts the paused interval from the restored absolute time → close Wed 04:00.

Impl A silently ends the auction. Nothing in AD-4, AD-11 or FR-32 forbids it — AD-11 governs pause/resume, not compensation, and the two ADs were written independently.

**Proposed AD-26 — Compensation is explicit and clock state is always a duration plus an anchor.**
> (i) `BidVoided` carries the **full restored auction state** computed by the core at void time — `restoredLeaderTeamId`, `restoredAmountDollars`, `restoredRemainingMs`, `restoredState` — and the fold applies exactly those values. Folds never re-run `decide`; events are facts. (ii) FR-32's void is only permitted on the **current** leading bid of an open auction; voiding an earlier bid is refused with "void the later bids first," because there is no rules-consistent restoration otherwise. (iii) Every clock is persisted as `(remainingMs, anchorInstant)` with `closesAt = anchor + remaining` materialised for the sweep's index; restoration and resumption both set `remainingMs` and re-anchor to the acting instant, never an absolute time from the past. (iv) A restored clock whose `remainingMs ≤ 0` is a rules error the core rejects, never a silent close. **New PRD §10 examples 23 (void the leading bid) and 24 (void after a pause) are required.**

---

## F-9 — The Manager↔Team binding (FR-5, FR-6) is pinned nowhere, and one compliant implementation is self-assignable

**Severity: CRITICAL (security).** AD-9's wording covers *tables*; Supabase's identity mutation path is not a table.

The spine's Capability map assigns §4.2 to *"Supabase Auth, `server/auth`, `routes/` guards"* governed by AD-9 and the Authorisation convention. That is the only mention. Consequences:

- AD-4's reference-data list is *"teams, players, existing contracts, roster slots"* — **Manager is absent**. Manager-team binding is also not in AD-4's auction-event list. It sits on neither side of the boundary.
- Every event carries `actingManagerId` and `teamId` (convention table), but **nothing says `teamId` must be derived server-side from `actingManagerId`** rather than supplied by the client. FR-5's "acts on behalf of exactly one Team" is a PRD statement with no architectural anchor.

**The two components:**

| | `server/auth/resolveManager.ts` (story: FR-4) | `routes/admin/managers/+page.server.ts` (story: FR-5 binding setup) |
|---|---|---|
| Choice | Reads `team_id` from the JWT: `session.user.user_metadata.team_id` — zero round-trips, works identically in Node and Deno, and the JWT is signed | Binds by writing `user_metadata` at invite time |

**The exploit.** `user_metadata` (`raw_user_meta_data`) is writable by the end user with the **anon key** via `supabase.auth.updateUser({ data: { team_id: '...' } })` — it goes through GoTrue's API, not through any table grant. AD-9 forbids the client role holding `INSERT/UPDATE/DELETE` **"on any table,"** which this path does not need. So:

1. Manager M (Team 7) opens devtools, calls `updateUser({ data: { team_id: 12, is_commissioner: true } })`.
2. Next magic-link refresh mints a JWT claiming Team 12 and commissioner.
3. `resolveManager` — fully AD-9-compliant, never touching a table with the client key — returns Team 12.
4. M bids Team 12's cap space away on a player Team 12 does not want, and the event is attributed to `teamId: 12` with M's `actingManagerId`. The Audit Log correctly records that M did it, three days later.

The alternative implementation — a `manager` reference table joined on `auth.users.id`, read with the service role — is immune. Both satisfy every written AD. This is the classic Supabase footgun and the spine's AD-9, which exists precisely to close Supabase's "default ergonomics," does not name it.

**Proposed AD-27 — Identity is server-resolved from a reference table; no claim from the token is trusted for authority.**
> `manager` is an **Imported Fact** table (`id`, `auth_user_id`, `team_id`, `is_commissioner`, `display_name`), written only by the commissioner setup path holding the service role, and it is the **sole** authority for team binding and the commissioner capability. Every server entry point resolves `(managerId, teamId, isCommissioner)` by querying that table with the service role using `auth_user_id` from the verified JWT; **no `user_metadata` or `app_metadata` claim is ever read for authorisation**, and a CI grep forbids the identifiers. `teamId` never arrives in a command payload from a client — the shell stamps it. The client role has no RLS policy granting it any read of `manager` beyond display names.

---

## F-10 — Batch close: a single `CloseExpiredAuctions` command breaks sequential Slot Placement (PRD examples 16→17)

**Severity: CRITICAL.** The spine's own sequence diagram invites the broken implementation.

AD-10: the sweep reconciles *"every overdue auction it finds on each pass."* The sequence diagram: *"The close sweep follows the identical path with a `CloseExpiredAuctions` command — same lock, same core, same append."* Singular command, one `decide` call, one state snapshot.

FR-35: *"Slot Placement is evaluated against the Team's slot occupancy **at the moment of Auction Close**, so two Auctions closing in sequence can place the first Player in minors and the second in Active/Bench."* PRD §10 examples 16 and 17 are exactly this.

**The two components:**

| | `SweepBatch` (Deno, story: FR-21 close SLA) | `SweepSerial` (Deno, story: FR-21 close SLA) |
|---|---|---|
| Shape | One lock, one `decide(state, CloseExpiredAuctions{ids:[...]}, now, seed)`, N `AuctionClosed` events appended, one fold at the end | One lock **per auction**, N transactions, state reloaded each time |

**Worked divergence.** Team M holds **two** occupied Minor League Slots (one free, `M = 1`). It leads two eligible auctions — Player Y at $4.0M and Player Z at $3.0M — both of which expire in the same 10-second sweep window (entirely ordinary: they were opened minutes apart a day earlier).

- **`SweepSerial`:** Y closes → Minor League Slot 3 occupied, $0 cap hit, Roster Count unchanged (example 16). Z closes → all three slots full → **Active/Bench, $3,000,000 cap hit, Roster Count +1** (example 17). Correct.
- **`SweepBatch`:** both closes are decided against the state loaded at the top of the transaction, in which Team M has one free slot. Both `decide` branches see `freeMinorSlots = 1` → **both players are placed in Minor League Slots.** Team M gets two $0 cap hits, three-and-a-half occupied slots out of three, $3,000,000 of cap it should be charged, and a Roster Count one lower than it should be — which flows straight into Roster Reserve and Maximum Bid for the rest of the auction, and into the FR-30 export that goes into Fantrax.

A batch implementation is only correct if the core folds its own emitted events back into the working state between each close — which is a real requirement that no AD states.

**Compounding: close order is not pinned.** Even in `SweepSerial`, when two of a team's eligible auctions expire in the same pass, **the order decides which player is $0 and which is $3,000,000.** Impl A orders `by closes_at asc`; Impl B `by auction_id asc`; Impl C by whatever the query returns. Exact ties are reachable — FR-32's "expire any Clock" on two auctions, or an AD-11 resume where two auctions held equal remaining durations. There is no tiebreak.

**Proposed AD-28 — Closes are decided one auction at a time, in a pinned total order, against state that includes prior closes.**
> The sweep closes overdue auctions **one per transaction**, each taking the AD-6 lock and reloading state, ordered by `(closesAt ASC, auctionOpenedSeq ASC)` — a total order, since AD-19's `seq` is unique. If a batch transaction is ever introduced for latency, the core must expose `foldOwnEvents` and the batch path must re-derive state after every emitted event, verified by a test that reproduces PRD §10 examples 16 and 17 **inside a single batch**. The 60-second FR-21 SLA is met by the 10-second cadence, not by batching. A test asserts that the close order of two simultaneously-expiring eligible auctions for one team is deterministic across runs.

---

## F-11 — AD-1's `seed` parameter and AD-12's commit-reveal are not reconciled, and the wrong reading silently destroys fairness

**Severity: CRITICAL.** The signature the spine mandates admits an implementation in which the seed is chosen *after* the contender list is known — the exact objection AD-12 exists to defeat.

AD-1 pins `decide(state, command, now, seed) → Accepted | Rejected` — **one** seed, supplied by the caller, on every call. AD-12 says the seed is generated **when the contention opens**, persisted, and revealed **at the draw**.

**The two components:**

| | `PlaceBidHandler` (Node, story: FR-17/FR-18) | `SweepDraw` (Deno, story: FR-20) |
|---|---|---|
| Reading of `seed` | "The shell supplies randomness the core cannot generate." Generates a fresh seed on **every** bid transaction and passes it; the core uses it only if this bid opens a contention. Persists it via the emitted `MinimumBidContentionOpened{seedCommitment}`. | "The shell supplies randomness the core cannot generate." At draw time, generates a seed and passes it to `decide` for the `CloseExpiredAuctions` command. |

`SweepDraw` is a *literal* reading of AD-1 and it is catastrophic: the seed is minted at 09:00 Tuesday by a process that has already read the contender list. Commit-reveal is reduced to theatre, the published `hash(seed)` from Monday matches nothing, and the audit trail looks impeccable.

A third divergence sits underneath: a batch `CloseExpiredAuctions` closing **three** simultaneously-expiring lotteries needs **three** seeds, and `decide` takes one. `SweepDraw` will reuse the single seed across all three draws, correlating the outcomes.

And `PlaceBidHandler` has its own smell: to avoid generating an unused seed on every bid, an implementer will "peek" at the auction state in the shell to decide whether this bid opens a contention — **putting a rule in the shell.** AD-1 constrains the *core's* purity; **no AD says the shell must be rule-free**, so this is compliant and will drift from the core's own predicate the first time the lottery entry condition is touched.

**Proposed AD-29 — Seeds are per-contention, minted at open, and reach the core through state, never through a parameter at draw time.**
> The core's signature becomes `decide(state, command, now, entropy)` where `entropy` is a **freshly generated 32-byte value supplied unconditionally on every command** and used by the core *only* to mint a new contention seed when the command's outcome opens a Minimum-Bid Contention. Existing contention seeds reach the core **through `state`**, loaded from the seed store (F-4), never through the entropy parameter. The core asserts at draw time that the state-supplied seed hashes to the committed `seedCommitment`, and returns `Rejected` if not. A draw path that mints entropy is a defect; a test asserts that `decide` on `CloseExpiredAuctions` produces identical output for two different `entropy` values.
>
> **Corollary AD-29b — the shell implements no rules.** The shell may only: acquire the lock, load state, read the clock, mint entropy, call `decide`, persist, enqueue. It may not branch on domain predicates. Any conditional in `shell/` or in a `+page.server.ts` that inspects amounts, states, slots or cap figures to decide *whether* to call the core is a defect. Client-side affordances (FR-24 pre-fill, quick chips, disabled controls) are computed by importing the same `core/` module and are rendered from a server-supplied state snapshot marked `advisory`; they are never the check that matters (AD-9).

---

# HIGH

## F-12 — AD-13's idempotency key is underspecified, and the natural choice silently breaks FR-27 for the co-managed team

**Severity: HIGH.** AD-13: *"an idempotency key **derived from the event identity**."* FR-26 wants **at most once per event** (Discord). FR-27 wants **every Team-affecting email to reach both Managers of a co-managed Team** — i.e. **N deliveries per event**. One phrase covers both, and they need different keys.

**The two components:**

| | `adapters/discord` + `functions/dispatch` (story: FR-26) | `adapters/email` (story: FR-27) |
|---|---|---|
| Key | `idempotency_key = event_id` — literally "derived from the event identity," and it is exactly right for Discord | `idempotency_key = sha256(event_id ‖ 'email' ‖ recipient_manager_id)` |

If the outbox table has `unique(idempotency_key)` (which it must, for AD-13's redelivery safety) and the *first* developer's convention is adopted repo-wide — the likely outcome, since Discord is the FR-26 story and gets built first — then **the second co-manager's outbid email is deduplicated away at insert time**. Priya's brother never learns he was outbid.

That directly fails **SM-3, a primary success metric with a target of 100%**, and it fails silently: the outbox shows one row, delivered, success.

Second divergence in the same AD: **what is "the event identity" for an event that fans out to multiple channels?** `event_id` alone collides Discord and email for the same event. A third implementer keys on `(event_id, channel)` and gets the co-manager bug back.

**Proposed AD-30 — The outbox key is `(eventSeq, channel, recipientRef)`, and fan-out happens at enqueue.**
> The outbox primary key is the triple `(event_seq, channel, recipient_ref)` with a unique constraint on it; `recipient_ref` is the manager id for email, the literal `'league'` for Discord. **Fan-out to recipients happens inside the appending transaction** (one row per intended delivery), never in the dispatcher, so the set of intended deliveries is itself durable and auditable. The dispatcher is a pure drain: it never decides *who* gets a message. A test asserts that an outbid event on the co-managed team enqueues exactly two email rows and one Discord row, and that replaying the dispatcher produces zero additional sends.

## F-13 — Money crosses the driver boundary as different TypeScript types in the two runtimes

**Severity: HIGH.** AD-8 pins `bigint` in Postgres and "integer arithmetic in TypeScript," and the conventions table says money is "never a float, **never a string**." It does not pin the **parse boundary**, and the two runtimes will not use the same driver.

**The two components:**

| | `src/lib/server/db.ts` (Node) | `supabase/functions/sweep/db.ts` (Deno) |
|---|---|---|
| Client | `postgres`/`pg` over a direct connection (needed for `pg_advisory_xact_lock` + explicit `BEGIN`) — **int8 is returned as a JavaScript `string` by default**, because it may exceed `Number.MAX_SAFE_INTEGER` | `supabase-js` over PostgREST — int8 is serialised into JSON and arrives as a **`number`** |

Both developers believe they are handing the core "integer dollars." TypeScript will not catch it if the row type is declared `{ amount_dollars: number }` and the driver hands back a string at runtime (`strict` does not check runtime shapes from an untyped driver).

**Worked divergence.** High bid $8,500,000. The Node bid path loads `currentHighBidDollars = "8500000"`. The core computes the minimum legal bid as `high + MINIMUM_INCREMENT` → `"8500000" + 500000` → **`"8500000500000"`**. Every comparison `bid >= minimum` is then a string/number comparison: `9000000 >= "8500000500000"` is `false` → **every bid on the board is refused**, with an FR-13 refusal message rendering `$8,500,000,500,000` as the arithmetic. Or, with the operands the other way round, every bid is *accepted*, including a $100,000 bid on an $8.5M player.

The Deno sweep, meanwhile, computes correctly, so the failure is asymmetric and looks like "bidding is broken but closes are fine."

**Proposed AD-31 — One parse boundary and one branded money type.**
> `core/money.ts` exports `type Dollars = number & { readonly __brand: 'Dollars' }` and the **only** two functions that may produce a `Dollars` from external data: `parseDollars(unknown): Dollars` (accepts `number | string`, rejects non-integers, rejects `> 2^53−1` and `< 0` unless explicitly signed) and `dollarsFromCsv`. Every row mapper in **both** runtimes passes every money column through `parseDollars`; a CI check forbids money-typed fields being assigned from a raw driver result. Both runtimes register the same int8 handling explicitly rather than relying on driver defaults. A cross-runtime test loads the same row through both clients and asserts identical `Dollars` values.

## F-14 — AD-2 mandates a shared core but pins no mechanism, and the obvious Node-idiomatic code will not load in Deno

**Severity: HIGH.** This one diverges *today*, in every core file written before the sweep exists.

AD-2 is emphatic that the core is single-sourced and "never copied." It names no import mechanism. SvelteKit's tsconfig (`moduleResolution: bundler`) permits extensionless relative imports and `$lib` aliases; **Deno permits neither.** Supabase's function bundler follows relative imports outside `supabase/functions/`, but only with explicit extensions and no aliases, and it has its own caveats about files outside the function root.

**The two components:**

| | `core/rules/bidding.ts` (written first, in the SvelteKit story) | `supabase/functions/sweep/index.ts` (written three stories later) |
|---|---|---|
| Imports | `import { addDollars } from './money'` and `import type { Dollars } from '$lib/core/money'` — idiomatic SvelteKit, type-checks, tests pass | `import { decide } from '../../src/lib/core/rules/bidding.ts'` — and it fails to resolve, at **deploy** time or worse at first invocation |

The sweep developer's cheapest fix is the one AD-2 forbids: copy `core/` into `supabase/functions/_shared/`, or add a build step that copies it at deploy. Both produce a **second, drifting core** — the divergence AD-2 calls "the most dangerous available in this design" — and both look like a build detail rather than an architectural violation in review.

**Proposed AD-32 — The core is Deno-loadable by construction, and this is enforced in CI.**
> Every import inside `src/lib/core/**` uses an **explicit relative path with a `.ts` extension** and no path alias (`$lib`, `@/`, `~/`) — enforced by an ESLint rule and a CI grep. `supabase/functions/*/deno.json` declares an import map pointing at `../../src/lib/core/`; the functions import the core by relative path and never copy it. **CI runs `deno check` over the Deno entry points and `vitest` over the same core files on every commit** — a core file that does not type-check in both runtimes fails the build. No deploy-time copy step exists.

## F-15 — A rejection rolls back, so nothing is recorded, contradicting the Measurability NFR

**Severity: HIGH.** The bid-acceptance sequence diagram shows `ROLLBACK` on the `Rejected` branch. Nothing about a refused bid is persisted anywhere.

PRD §5 Measurability: *"Every Bid, Nomination, Auction Close, and notification dispatch must be recorded with enough context to compute the §8 metrics without retrofitting instrumentation — including, for Bids, the device class the bid was placed from (SM-4)."* FR-13 says a refused bid *"never appears in the Bid Board or in the Audit Log **as a valid Bid**"* — the qualifier implies it appears as *something*.

**The two components:** `PlaceBidHandler` A rolls back and returns the rejection to the browser only. `PlaceBidHandler` B appends a `BidRejected{reason, arithmetic}` event and **commits** — which contradicts the spine's own diagram, and requires either committing on the rejection path or a second transaction outside the lock.

They diverge on what the Audit Log contains, on whether SM-1 can be investigated at all ("why was my bid refused at 3am?" has no answer under A), and on whether SM-4's device-class metric has any data. Under A, the single most trust-corrosive event in the system — *the app told me no* — leaves no trace whatsoever.

Related unpinned decision: **where does device class live?** The Events convention pins `occurredAt`, `actingManagerId`, `teamId` and nothing else. Impl A puts `deviceClass` in the event payload, which forces a UI concern into the domain command and into `decide`'s input; Impl B writes a side analytics table, which is a second write path outside the fold.

**Proposed AD-33 — Rejections are recorded, out of band, and events carry a defined envelope.**
> Every event row has a fixed **envelope** — `seq`, `eventType`, `eventVersion`, `occurredAt`, `actingManagerId`, `teamId?`, `auctionId?`, `payload` — and a separate **provenance** column for non-domain metadata (`deviceClass`, `userAgentClass`, `requestId`). Provenance is never passed to `decide` and never read by a fold. Rejections are appended to a distinct, insert-only `command_rejections` table by the shell **after** the rollback, in its own short transaction, carrying the command, the reason code and the full arithmetic; it is not part of the event log (it does not fold) but it **is** part of the FR-33 Audit Log's rendering, visibly marked as "refused."

## F-16 — No event schema version, so a post-hoc fold change can silently change who won a closed auction

**Severity: HIGH.** The spine has no versioning story at all. AD-5 says a rebuild must be possible "at any time" and the projections are "disposable"; AD-18 says a rule change altering an example must change the PRD in the same commit — but says nothing about **already-appended events**.

**The two components:**

| | `FoldV1` — events are facts, code is current | `FoldVersioned` — the fold branches on `eventVersion` |
|---|---|---|
| Behaviour | A mid-auction bug fix to `minorsExposure` changes the fold; a rebuild after the fix reproduces **different** projections from the same log | Historical events replay under the rules in force when they were appended |

**Worked scenario.** Day 9 of the auction, a genuine bug in the Overflow Count fold is found and fixed (F-5/F-6 make this likely). Day 12, the operator runs a rebuild to repair a corrupt board. Under `FoldV1`, auctions that closed on days 4–8 are re-derived under the new rule. If the fixed rule changes a Minors Exposure figure retroactively, a bid that was accepted on day 5 now folds as… what? The event says accepted; folds don't validate; so the projection keeps the winner but the cap figures shift — and a team's post-auction salary in the FR-30 export can now exceed $165,000,000, blocking the export with no explanation anyone can trace.

Under `FoldVersioned` the history is stable but the app now permanently runs two rulesets, and AD-18's 21 example tests only ever exercise one of them.

**Proposed AD-34 — Every event carries `eventVersion`; folds are additive and never retro-change an outcome.**
> Every event carries `eventType` and `eventVersion`. A fold change that would alter the projection produced from **already-appended** events is a **breaking change** and is forbidden during the Auction Phase; the remedy is a compensating event (AD-4), never a fold rewrite. Adding a field means a new `eventVersion` with an explicit upcast for prior versions. CI runs a **golden-log test**: a fixture log of ~200 events with a checksummed expected projection; any commit that changes that checksum must state why in the commit message and must not be deployed mid-auction. This is what makes AD-5's "byte-identical" a testable claim rather than a wish.

## F-17 — AD-14 mandates SMTP; AD-13 puts the dispatcher on Deno Edge. The adapter interface diverges now, while the vendor is deferred.

**Severity: HIGH.** The Deferred section says the vendor is "a build-time pick," implying nothing is blocked. But **the transport shape is not deferrable** — it determines the adapter interface, and both candidate adapters get written before the pick.

AD-14: *"custom SMTP is **mandatory**."* In context that sentence is about **Supabase Auth's** magic-link sending (the "2/hour built-in" and the "30/hour post-SMTP default"), but it is written as a blanket statement about "notification transport," and it will be read as governing the app's own FR-27 mail. AD-13/AD-10 put the dispatcher in `supabase/functions/dispatch/` — **Deno Edge**, where raw outbound TCP for SMTP is at best awkward and version-dependent, and where the ecosystem answer is an HTTP API.

**The two components:**

| | `adapters/email/smtp.ts` (developer reading AD-14 literally) | `adapters/email/http.ts` (developer reading AD-13's runtime constraint) |
|---|---|---|
| Interface | `send(envelope: SmtpEnvelope): Promise<void>`, connection pooling, per-message latency, needs a live TCP socket from the dispatcher | `send(batch: {from, to[], subject, html}[]): Promise<{id}[]>`, batched, per-request idempotency header |

These are not swappable: the second is **batched** (one HTTP call for the burst that AD-14 exists to survive) and carries a provider-side idempotency header that F-12's outbox key would naturally map onto; the first is per-message. The dispatcher's retry/backoff loop, its outbox drain batching, and its idempotency strategy all differ. Choosing late means rewriting the dispatcher, which is the component AD-13 makes load-bearing for FR-26/FR-27 and SM-3.

**Proposed AD-35 — Split the two mail paths and pin the app's transport as HTTP.**
> Two distinct concerns, stated separately: **(a) Supabase Auth email** (magic links) uses custom SMTP configured on the Supabase project, with the auth rate limit raised above 31/hour — this is what AD-14's "SMTP is mandatory" governs, and nothing else. **(b) Application notifications** (FR-26, FR-27) are dispatched from the Deno Edge dispatcher over **HTTPS to a provider's REST API**, never raw SMTP, because the dispatcher's runtime cannot be assumed to hold a TCP socket. `adapters/email` exposes `send(messages: OutboxMessage[]): Promise<DeliveryResult[]>` — batched, idempotency-key-carrying, provider-agnostic — and the vendor pick is a single module implementing it. **This unblocks the Deferred item without picking the vendor.**

## F-18 — AD-16 forbids dashboard configuration; several mandatory settings are dashboard-only

**Severity: HIGH.** An internal contradiction that produces exactly the dev/prod divergence AD-16 exists to prevent.

AD-16: *"every schema change is a migration file… **Nothing is typed into the Supabase dashboard.**"* But AD-14 requires custom SMTP configured on the project and the auth email rate limit raised above 30/hour; FR-4 requires a session lasting ≥30 days (JWT/refresh settings); AD-10 requires a `pg_cron` schedule; AD-9 requires the anon role's grants and RLS policies; AD-12/F-4 require the seed table to have no client policy. Of those, **grants, RLS and cron schedules are migrations; SMTP, rate limits and session lifetime are project settings** — reachable only via the dashboard or `supabase/config.toml` + CLI.

**The two components:** the developer of the FR-4 auth story sets session lifetime and SMTP by hand in the **dev** dashboard (AD-16's letter forbids it, so it goes unrecorded). The developer of the deploy story writes `supabase/config.toml` and pushes it. On setup day, prod has the CLI-managed subset and not the hand-typed subset. Thirty-one magic links go out at once against the **default 30/hour** limit — the exact failure AD-14 names — and the first four managers to click are the only ones who get in.

**Proposed AD-36 — Two config planes, both in the repository, both applied by CLI.**
> Configuration splits into **schema** (migrations) and **project settings** (`supabase/config.toml` — auth providers, SMTP, rate limits, session/JWT lifetimes, cron). Both live in the repository and both are applied to dev and prod by `supabase db push` / `supabase config push` in a scripted deploy; nothing is typed into the dashboard, including auth settings. A `scripts/verify-env.ts` reads the live settings of both projects via the Management API and **fails CI on any drift** between them, and is run as a pre-flight gate on setup day. The AD-14 rate limit and the FR-4 session lifetime are named constants in that file with the required values.

---

# MEDIUM

## F-19 — Expiry boundary semantics are undefined, and the sweep leaks a rule into SQL

AD-10 says the sweep reads *"expiry from persisted absolute close times."* Impl A filters in SQL (`where closes_at <= now()`); Impl B loads all open auctions and lets the core decide. AD-2 forbids re-implementing the core "in SQL/PL-pgSQL" but a `WHERE` clause does not read as re-implementing the core, so Impl A is compliant — and it puts the predicate *"an auction is overdue"* in two places.

They diverge at the boundary: a bid whose `occurredAt` is exactly `closesAt`. The SQL uses `<=` (closed); the core's guard is written `now < closesAt` (bid accepted). Under AD-6's single lock, whichever transaction runs first wins, and there is no defined answer to "was that bid in time?" — a question a manager sniping at the buzzer *will* ask. Same problem for FR-18: joining a lottery at the exact expiry instant.

**Proposed delta (fold into AD-3):** *Clock intervals are half-open: an auction is open for `t < closesAt` and overdue for `t >= closesAt`. The predicate `isOverdue(auction, now)` exists once, in `core/rules/clock.ts`. The sweep's SQL may pre-filter with a **wider** window (`closes_at <= now() + interval '1 minute'`) as an index optimisation only; the core makes the decision. A test asserts a bid at exactly `closesAt` is refused.*

## F-20 — A projection rebuild is a mutating transaction that AD-6 does not cover

AD-6 binds *"bid, nomination, close, draw, override, phase change."* A rebuild is none of those, and it rewrites every projection table. Impl A takes the lock; Impl B does not, and a bid lands mid-rebuild, appending an event the in-flight rebuild has already folded past — leaving the projection permanently missing one bid, with no error. Two secondary effects: a `TRUNCATE`+replay pushes a delete/insert storm to every Realtime subscriber (FR-23's board flickers empty for 30 managers), and AD-5's "byte-identical" has no defined comparison scope while projections carry surrogate keys or `updated_at` columns.

**Proposed delta (fold into AD-5/AD-6):** *A rebuild is a mutating transaction and takes the AD-6 lock. Rebuilds run into a shadow schema and swap atomically, so Realtime sees one change rather than a truncate storm. Projection tables carry no surrogate keys and no wall-clock columns; "byte-identical" means a checksum over every projection table ordered by its natural key, and there is a script that computes it.*

## F-21 — The outbox dispatcher's relationship to the global lock is undefined

AD-13 says delivery never runs inside the auction transaction. It says nothing about the transaction that **marks an outbox row delivered**, or that claims rows for a worker. Impl A wraps the claim-send-mark cycle in the AD-6 lock "because AD-6 says every mutating transaction takes it" — and now a Discord webhook retry with backoff holds the **global auction lock** for tens of seconds, blocking every bid in the league. Impl B takes no lock, and two concurrent dispatcher invocations (the cron fires every 10s; a slow batch overlaps) claim the same rows and double-post — which the F-12 idempotency key is supposed to absorb, but only if it is provider-side, not merely a local unique constraint.

**Proposed delta (fold into AD-13):** *The outbox is explicitly outside AD-6's lock domain. The dispatcher claims rows with `select … for update skip locked` in a short transaction, sends outside any transaction, and marks results in a second short transaction. It never acquires the auction lock. Overlapping invocations are safe by `skip locked` plus the provider idempotency header.*

## F-22 — An auction can outlive the Auction Phase after a commissioner clock extension

The 48h League Clock normally dominates the 24h Auction Clock, so no bid-carrying auction can be open at phase end — except that FR-32 lets the commissioner *"extend or expire any Clock."* Extend an auction clock to 72h, and FR-22 fires while it is open. FR-22 only says auctions in **Awaiting Opening Bid** are terminated; it is silent on open contested auctions. Impl A lets it close normally during the Contract Assignment Phase (so a team gains a player after assignment began, with no allotment left); Impl B terminates all open auctions at phase end (so a leading bidder loses a player it had won). Also unpinned: does the *same* sweep evaluate the League Clock and the Auction Clocks, and in which order?

**Proposed delta (fold into AD-10):** *One sweep evaluates, in a pinned order per pass: (1) overdue Auction Clocks, one transaction each; (2) the League Clock. Phase end never terminates an auction that has a bid; the core refuses a clock extension that would push an auction's close beyond the current League Clock expiry, stating the reason. Needs a PRD §10 example.*

## F-23 — Nothing forbids rules living in the shell or the client

Covered as a corollary in F-11 (AD-29b), but worth flagging on its own: AD-1 constrains `core/`; AD-9 explicitly *permits* client-side validation "to disable controls and pre-fill amounts"; FR-24 requires the bid control to pre-fill the minimum legal bid and never offer an amount above the viewer's Maximum Bid. So a client component **must** compute two rule outputs. Impl A imports `core/` into the browser bundle and computes from a possibly-stale snapshot; Impl B renders server-computed figures. Under Impl A the chip amounts and the server's answer can differ — the manager taps a chip the app itself offered and gets FR-13's refusal, which is the precise experience AD-9's "client-side validation is never the check that matters" was meant to make impossible to blame the app for.

**Proposed delta:** as AD-29b — client affordances import the same `core/` module, render from a server snapshot explicitly typed `Advisory<T>`, and every advisory figure carries the `seq` it was computed at so the server can say "the board moved" rather than "your bid was illegal."

---

# LOW

## F-24 — `AUCTION_EVENT ||--o{ OUTBOX_ENTRY` implies an FK the outbox should not have

The ER diagram makes outbox entries children of events. If that is a real foreign key, the outbox cannot carry deliveries that are not tied to a single event — e.g. FR-29's "reminded by email at a Commissioner-configured interval," FR-10's 24-hour dead-nomination warning (a *time-triggered* notice with no event behind it), or an FR-3 auction-open broadcast. Two implementers: one adds a synthetic event for every notification (polluting the auction log with `ReminderDue` events that folds must ignore); another drops the FK. Pin it: *the outbox references `event_seq` nullably; time-triggered notices carry a `trigger_ref` instead, and the F-12 key uses whichever is present.*

## F-25 — "Every event carries `teamId` where applicable" leaves `where applicable` to the reader

`AuctionPaused`, `AuctionOpened`, `ContentionDrawn` and `ImportCommitted` have no obvious `teamId`. Impl A uses `null`; Impl B uses the commissioner's own team (he is a manager too), which then makes commissioner administrative actions look like team actions in FR-33's team filter. Pin: *`teamId` is the team **on whose behalf** the action was taken and is `null` for every administrative or system action, including all commissioner actions taken in an administrative capacity; the Audit Log's team filter matches on it.*

## F-26 — OQ-1 (roster maximum) is deferred to the PRD but blocks a projection column

The Deferred section says OQ-1 "changes an export validation." It also determines whether `Roster Count` has an upper bound the core must enforce at Slot Placement — if a team can be forced past a maximum by an Active/Bench overflow placement (F-5's scenario), the close has no defined behaviour. Low, because the situation is rare, but it should be stated that *absent OQ-1, no roster maximum is enforced anywhere and the export validation is the only check* — so that two implementers do not invent different caps.

---

# Summary of proposed AD deltas

| # | New/tightened AD | Closes |
|---|---|---|
| AD-19 | Single `bigserial seq` is the only fold order; `occurredAt` read via `clock_timestamp()` after the lock | F-1 |
| AD-20 | Three-way table classification (Imported Fact / Projection / Operational); auction-produced world state is a Projection | F-2 |
| AD-21 | Canonical Contender order = `seq` asc, constructed in the core, persisted as an array in `ContentionDrawn` | F-3 |
| AD-22 | Seed in a service-role-only table; only the commitment is in the log; reveal is an event with a hash assertion | F-4 |
| AD-23 | Glossary formulas beat §10 examples on conflict; one `minorsExposure` function; **PRD example 19 must be corrected** | F-5 |
| AD-24 | Exhaustive three-bucket exposure partition; an eligible-player contention enters `N` at $1M; needs a new §10 example | F-6 |
| AD-25 | One lock helper, one `bigint` key constant, one-argument form only, CI-enforced | F-7 |
| AD-26 | `BidVoided` carries full restored state; void only the current leading bid; clocks are `(remaining, anchor)` | F-8 |
| AD-27 | `manager` reference table is the sole authority; no `user_metadata`/`app_metadata` read for authorisation | F-9 |
| AD-28 | One close per transaction, in `(closesAt, openedSeq)` order; batch path must fold its own events | F-10 |
| AD-29 (+29b) | `entropy` per command, seeds minted only at contention open and reaching the core via state; the shell implements no rules | F-11 |
| AD-30 | Outbox key `(eventSeq, channel, recipientRef)`; fan-out at enqueue | F-12 |
| AD-31 | Branded `Dollars` with a single `parseDollars` boundary in both runtimes | F-13 |
| AD-32 | Core is Deno-loadable by construction; `deno check` in CI; no copy step | F-14 |
| AD-33 | Fixed event envelope + provenance column; rejections recorded in `command_rejections` | F-15 |
| AD-34 | `eventVersion`; folds are additive; golden-log checksum test | F-16 |
| AD-35 | Split auth SMTP from application HTTP mail; batched provider-agnostic email interface | F-17 |
| AD-36 | Two config planes, both in repo, both CLI-applied; env-drift check in CI | F-18 |
| (AD-3) | Half-open clock intervals; `isOverdue` exists once | F-19 |
| (AD-5/6) | Rebuild takes the lock, runs into a shadow schema, checksum-comparable | F-20 |
| (AD-13) | Outbox is outside the lock domain; `for update skip locked` | F-21 |
| (AD-10) | Sweep order: auction clocks then league clock; no clock extension past League Clock expiry | F-22 |

---

# What the spine gets right (and should not be weakened while fixing the above)

- **AD-6's supersession of PRD §5.** Identifying that the *team* is raced, not the auction, and paying global serialization for it at this scale, is the single best decision in the document. Every fix above preserves it.
- **AD-1 + AD-2 + AD-18 as a triple.** Purity is what makes single-sourcing possible, and single-sourcing is what makes 21 executable examples meaningful. The triple is sound; F-11, F-14 and F-23 are about the *edges* of the core, not its centre.
- **AD-10's arithmetic.** The 181,000-vs-125,000 invocation calculation is the kind of forced decision that should be recorded, and it is recorded with its reasoning.
- **AD-15.** Naming the Discord channel as load-bearing durability rather than a convenience, on a tier with no backups, is exactly right and unusually honest.
- **AD-12's framing.** "The builder of this app is also the commissioner and a competing manager" is the sentence that justifies the whole design. F-3, F-4 and F-11 exist because that instinct was correct and needs to be carried three levels further down.

**Recommendation:** close F-1 through F-11 before any story is cut. F-5 additionally requires a PRD correction and F-6 and F-8 require new PRD §10 examples, so those three should go back to the PRD owner today; the rest are spine edits.
