# Adversarial Divergence Review — AD-32 and its citations

**Lens:** Construct pairs of units one level down that each obey every cited AD to the letter yet build incompatibly.
**Scope:** AD-32 ("The world changes by mutation plus record, and a world change refuses rather than cascades," added 2026-09-10) and its interaction with AD-4, AD-5, AD-6, AD-11, AD-23, AD-24, AD-26, AD-31.
**Document reviewed:** `ARCHITECTURE-SPINE.md` (updated 2026-09-10), full text (lines 1–563).
**Verdict:** Six divergence holes found, none closed by existing AD text. Two (Findings 2 and 4) are sharp enough that either builder's honest reading produces code that contradicts AD-32's own stated purpose. All six are closeable with a targeted addition to AD-32 (or, for Finding 2, AD-11/AD-6); none requires a new AD number.

---

## Finding 1 — team_rosters: is it "the world" (AD-4) or a projection (AD-5) for rebuild/replay purposes?

**AD each obeys:** AD-4 (`team_rosters` is NOT rebuilt from the log), AD-5 (a rebuild must be possible for every projection AD-5 binds), AD-32 (the event carries the whole delta "so a fold can reproduce the world as it stood").

**The two units:**
- **Unit A** (AD-21 restore-drill / AD-3 rehearsal implementer) reads AD-4 literally — "reference data stays in ordinary mutable tables… the world is not event-sourced, only the auction is" (line 91) — and AD-32's own restatement, "AD-4 already says the world is not event-sourced — `team_rosters` is the world and stays a mutable table" (line 312). Unit A therefore restores/replays `team_rosters` from the **current live table** (or an offsite snapshot of it), and treats `RosterMoved` purely as an audit trail, never folded to reconstruct a *past* roster state.
- **Unit B** (AD-5 rebuild implementer) reads AD-32's own claim that the event exists so "a fold can reproduce the world as it stood, not merely learn that it changed" (line 312), and AD-5's requirement that a rebuild be "deterministic given the same event log and the same **reference-data snapshot**" (line 97) — the exact category AD-24's eligibility precedent already folds as events (line 234). Unit B therefore folds `RosterMoved` forward from a baseline to reconstruct historical roster occupancy at any past `seq`, i.e., treats `team_rosters` as event-sourced for reconstruction purposes despite AD-4's flat denial.

**Incompatible outcome:** Under Unit A, an AD-5 rebuild or AD-21 restore run against an event log frozen at `seq N` computes cap/slot figures from **today's** `team_rosters` — exactly the bug AD-32 states it exists to prevent: "A Move that mutates the table without appearing in the log makes AD-5's rebuild, AD-21's restore and AD-3's synthetic-clock replay compute against today's rosters while folding yesterday's bids" (line 312). Under Unit B, the rebuild is correct, but nothing in the spine names *where* this historical-roster fold lives (no module, no table, unlike `core/projection/contracts.ts` named for Auction Contracts), whether it persists as a table (which would trigger AD-26's migration discipline the way Dead Money explicitly does, line 317) or exists only as an in-memory reconstruction during rebuild/replay. Two builders honoring the same AD text arrive at one broken rebuild and one working rebuild with an unspecified mechanism.

**AD text that closes it:** Add to AD-32: *"AD-5's rebuild, AD-21's restore and AD-3's synthetic-clock replay reconstruct `team_rosters` at a past `seq` by folding `RosterMoved` (and every other reference-data-mutation event) forward from the last full snapshot — never by reading the current live table. This reconstruction is `core/projection/roster-history.ts` [or equivalent named location]; it never persists back to `team_rosters` and produces no migration under AD-26. AD-4's 'not event-sourced' describes only the live write path — the reconstruction path is exactly the event-sourcing AD-4 otherwise forbids, scoped to rebuild/replay/restore."*

---

## Finding 2 — Is the close sweep one transaction or N, and can a Roster Move interleave with it?

**AD each obeys:** AD-6 (lock taken "before reading any state," transaction-scoped), AD-11 ("each close's effect… is committed to the state the next close is evaluated against"), AD-10 (restart-safe by construction).

**The two units:**
- **Unit A** implements the tick sweep as **one transaction**: acquire `LOCK_KEY` once, loop closes in-process without intermediate `COMMIT`s, `COMMIT` once at the end — licensed by the tick sequence diagram (lines 464–482), which shows one lock acquisition, a loop, then heartbeat and drain, with no `COMMIT` drawn inside the loop. Under Unit A the lock is held for the sweep's full duration, so no Roster Move transaction can interleave with any part of it.
- **Unit B** implements **each close as its own transaction** inside the sweep loop, licensed by AD-11's literal wording — "committed to the state the next close is evaluated against" (line 143) read as a real `COMMIT` — and by AD-10's restart-safety requirement, which is trivially satisfied if each close durably lands before the next begins. Under Unit B the transaction-scoped advisory lock (AD-6, line 103: "Transaction-scoped, never session-scoped") is released after each close's `COMMIT` and reacquired for the next, opening a window between any two closes in one sweep pass.

**Incompatible outcome:** Only under Unit B can a separately-submitted Roster Move acquire the lock and commit **between** two closes of the same sweep pass, mutating roster occupancy and cap space that the *next* close in that sweep will read. AD-11 fixes ordering only *among closes*; it says nothing about where a Move falls relative to them, and the spine gives no ruling on whether that interleaving is permitted, forbidden, or irrelevant. The two units produce genuinely different real-world orderings from the same AD text, and only Unit B's reading exposes the gap at all.

**AD text that closes it:** Tighten AD-6 or AD-11: *"The tick acquires `LOCK_KEY` once per sweep and holds it for the sweep's entire duration, including every close it contains and the projection folds that follow each. No other mutating transaction — including a Roster Move or Drop — may be granted the lock until the sweep started with a fixed overdue-set snapshot has finished. A sweep is therefore restart-safe at the level of the whole pass, not the individual close."* (If per-close commits are in fact required for restart-safety, the alternative closing text must instead state explicitly that a Roster Move landing mid-sweep is permitted and specify what "the state the next close is evaluated against" means when it includes an interleaved Move.)

---

## Finding 3 — No stated precondition ties a Roster Move's Player to an existing Contract, not an open Auction

**AD each obeys:** AD-32 ("The gates are the existing gates" — cap and slots only, line 315; "Two kinds of Contract, one event, two folding paths," line 313), the ER model (`PLAYER ||--o| AUCTION "contested in"`, line 396; `PLAYER ||--o| CONTRACT "is subject of"`, line 394).

**The two units:**
- **Unit A** (`core/rules/roster-import.ts` implementer) treats AD-32's gate-reuse text as the complete precondition set for a Move: cap and slots, nothing else. It builds the admin picker to accept any Player id known to the system, including one currently "contested in" an open Auction, since no gate rejects that case.
- **Unit B** (`core/projection/contracts.ts` implementer) reads AD-32's second bullet — a Move only ever "moves" a Contract, Existing or Auction (line 313) — as an implicit precondition, and independently builds its own guard rejecting a Move whose Player has no Contract fold entry yet.

**Incompatible outcome:** If Unit A ships without Unit B's guard existing anywhere else, the system accepts a `RosterMoved` event naming a Player still mid-Auction. `contractsReducer`'s "latest-transfer-wins" (line 313) then has no Contract row to apply the transfer to — the transfer is folded against a Contract that will not exist until a later `AuctionClosed` at a later `seq`, and whatever the Auction's own nomination/self-bid checks assumed about ownership is now stale. Neither AD-32 nor AD-31 names which module owns this precondition, or that it exists at all.

**AD text that closes it:** Add to AD-32: *"A Roster Move or Drop names only a Player currently the subject of a settled Contract (Existing or Auction, per the ER model). A Player 'contested in' an open Auction is not eligible, and `core/rules/roster-import.ts` returns a machine-readable refusal for that case rather than the caller being trusted to filter it upstream."*

---

## Finding 4 — Roster Move's gate call: a third command type, or a synthesized `PlaceBid`?

**AD each obeys:** AD-1 ("The gate set is fixed per command type, declared in `core/types.ts`," line 66), AD-2 ("restoration is the second command type," `RestoreLeadingBid` declares `{cap, slots}` and nothing else, line 79), AD-32 ("Re-evaluation calls the same pure money and slots gates `core/rules/bidding.ts` already exposes," line 315).

**The two units:**
- **Unit A**, following AD-2's precedent exactly, adds a **third command type** — declared in `core/types.ts` with its own fixed gate set — whose `evaluate()`/`decide()` entry receives "both directions, every Player" and "evaluates both Teams once against post-Move state" (AD-32, line 314), reusing `bidding.ts`'s internal money/slot arithmetic as pure helper functions but never invoking `PlaceBid`'s own evaluator.
- **Unit B** reads "calls the same pure money and slots gates `core/rules/bidding.ts` already exposes" (line 315) as license to literally construct a `PlaceBid`-shaped command per Team — bid amount set to the transferred Player's Cap Hit against a synthetic Auction — and call the **existing** `evaluate(state, PlaceBid, now)`, force-passing or discarding the bid-only gates (self-bid, increment, expiry) that don't apply.

**Incompatible outcome:** Unit B is exactly the failure mode AD-32 itself warns against one clause later: "A Roster Move must not carry its own affordability check: a second implementation would disagree with the first" (line 315). But `PlaceBid`'s cap gate is defined by AD-7 to evaluate "against the hypothetical state that would exist if the prospective bid were accepted" (line 111) — a single-Team, single-Auction, incremental concept never designed to receive two Teams' simultaneous opposing deltas in one call. Unit A avoids this, but AD-32 names no new command type, no gate set, and no `core/types.ts` entry the way AD-2 explicitly did for `RestoreLeadingBid` — so nothing in the text actually forbids Unit B, and a builder following AD-1's letter ("the gate set is fixed **per command type**") could reasonably conclude Roster Move must reuse `PlaceBid`'s already-fixed set rather than add a new one.

**AD text that closes it:** Add to AD-32: *"A Roster Move is a third command type — `EvaluateRosterMove` — declared in `core/types.ts` per AD-1's discipline, with its own gate set covering both Teams' post-Move state. `bidding.ts`'s money and slot arithmetic is reused as pure helper functions, never by constructing a `PlaceBid` literal; a Roster Move is never routed through `PlaceBid`'s evaluator."*

---

## Finding 5 — Dead Money as a fourth `RosterSlotKind`: no exhaustiveness rule for its other consumers

**AD each obeys:** AD-32's Dead Money bullet (line 317): "`chargedCapHit` already returns the right value for it by falling through, and `SLOT_CEILINGS` gains an entry with no bound."

**The two units:**
- **Unit A** (a second cap/roster-count consumer, e.g., the Roster Capacity ceiling check under AD-7/FR-37) takes AD-32's explicit sanction of fallthrough in `chargedCapHit` as a general pattern and writes its own occupancy tally with a `default:` branch lumping any unrecognized `RosterSlotKind` in with `active_bench`.
- **Unit B** (e.g., the `EXPERIENCE.md` state-rendering consumer, or the Fantrax export's slot-kind column) treats `RosterSlotKind` as a closed discriminated union and writes an exhaustive switch with no default, per general TypeScript strict-mode discipline (Stack section, line 348), forcing itself to handle `dead_money` explicitly the moment the type grows a fourth member.

**Incompatible outcome:** AD-32 states the correct answer only for `chargedCapHit` (falls through correctly) and `SLOT_CEILINGS` (needs an explicit unbounded entry) — it does not state a project-wide exhaustiveness rule. Unit A's fallthrough habit, sanctioned by the one worked example, silently miscounts Dead Money as occupying an Active/Bench slot in a sibling module, even though AD-32 says Dead Money "counts toward no ceiling" (line 317). Nothing forces Unit A's module to fail loudly instead.

**AD text that closes it:** Add to AD-32: *"`RosterSlotKind` is a closed union of exactly four members; every switch or match over it in `core/` and `adapters/` must be exhaustive with no default case, so a missing branch is a compile error, not a silent misclassification. AD-26's migration adds the fourth database check-constraint value in the same commit as this union's fourth member."*

---

## Finding 6 — The Fantrax reader's "writes nothing" is stated intent, not a mechanical control

**AD each obeys:** AD-32's reader bullet (line 318): "The Fantrax read is shell, adapter-confined, and writes nothing… Nothing downstream of the reader may be reachable from a code path that writes." Contrast AD-9 (line 129: "no client-facing database role holds any `INSERT`, `UPDATE` or `DELETE` privilege") and AD-16 (RLS policies), both of which enforce their "no write"/"no read" guarantees at the database-grant level.

**The two units:**
- **Unit A** implements the reader per the letter of AD-32: lives in `adapters/fantrax/` (AD-24), runs outside the write lock and outside the core, returns a "proposal" object — enforced only by not importing `shell/` from the reader module, i.e., a code-organization convention.
- **Unit B** implements the same reader but, since AD-9's mechanical enforcement is scoped to client-facing roles and every server-side adapter (including the Fantrax **importer**, which legitimately writes via `routes/admin/import`) already holds the service role (AD-9, line 129; AD-28), wires the reader through the *same* Supabase client the importer uses — because nothing in AD-32 says the reader needs a distinct, write-revoked credential.

**Incompatible outcome:** Both units satisfy AD-32's prose. Only Unit A satisfies its intent. Nothing distinguishes "Fantrax importer" (a legitimate writer) from "Fantrax reader" (meant to be read-only) at the database-grant or RLS level the way AD-9 and AD-16 distinguish browser role from server role — the two live in the same module, under the same service-role credential, and a future refactor sharing a helper between them would silently create the write path AD-32 forbids, with no grant, policy, or type system in place to catch it.

**AD text that closes it:** Add to AD-32: *"The Fantrax reader runs under a distinct, write-revoked database role, or — absent role separation on the free tier — is a pure function that never receives a database client as an argument; only the calling shell code writes the resulting proposal to a table. This is structural, not a naming convention: the reader function's own signature must make a write from inside it a type error, the same class of guarantee AD-9 gives the browser and AD-16 gives anonymous reads."*

---

## Summary table

| # | Units | AD(s) each obeys | Closed by existing text? |
| --- | --- | --- | --- |
| 1 | AD-5/AD-21/AD-3 rebuild vs. live-table restore | AD-4, AD-5, AD-32 | No |
| 2 | one-transaction sweep vs. per-close-transaction sweep | AD-6, AD-11 | No |
| 3 | any-Player Move vs. Contract-only Move | AD-32, ER model | No |
| 4 | new command type vs. synthesized `PlaceBid` | AD-1, AD-2, AD-32 | No |
| 5 | fallthrough consumer vs. exhaustive consumer of `RosterSlotKind` | AD-32 | No |
| 6 | module-boundary-only reader vs. shared-credential reader | AD-32, AD-9, AD-16 | No |

No concern investigated in this pass turned out to be already closed by existing AD text.
