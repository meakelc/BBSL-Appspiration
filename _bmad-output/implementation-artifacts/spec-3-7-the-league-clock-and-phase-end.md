---
title: 'Story 3.7: The League Clock and the end of the Auction Phase'
type: 'feature'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 1
baseline_commit: '642d1d760eff65b9cf82ca231c403cab7a28fa35'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The League Clock folds but nobody reads it. `leagueClockReducer` and `leagueClockExpiry` (`core/projection/league-clock.ts`) are imported by tests and by nothing in `src/lib/server` or `src/routes` — the two deferred-work entries logged at Stories 1.11 and 2.5 say so in as many words, and both name Epic 3's sweep as the first genuine reader. So the Auction Phase never ends: `phaseReducer` (`projection/phase.ts:60`) has exactly one case and no way out of `Auction`, `sweep.ts:74` names the clock evaluation as 3.7's by name, and a nominated Player nobody ever bid on stays on the board forever holding their Team's Nomination Slot. The fold is also incomplete in the one way AD-22 explicitly warns about: it has no `BidVoided` case, so a compensating void would leave the clock counting from a reset the league has withdrawn.

**Approach:** **The clock is evaluated where the closes already happen, and the phase ends by falling out of the log.** `leagueClockReducer` learns to track resets by `seq` rather than collapsing them to one instant, so a `BidVoided` naming an earlier `BidPlaced` removes that reset and the expiry recomputes to the previous surviving one — never past the origin. A new pure `core/rules/phase-end.ts` decides, from the folded clock, nominations and the injected `now`, whether the phase is over and what that costs: one `AuctionTerminated` per Auction still in Awaiting Opening Bid, then one `ContractAssignmentOpened`. `phaseReducer` gains its second case and `nominationsReducer` its third, so the phase and the freed Slots are both folds and nobody sets a flag. The tick calls the evaluation after the sweep. Bidding is disabled by a ninth `phase` gate in `PLACE_BID_GATES` — the extension `core/types.ts` was shaped for — so "disabled league-wide" is a rule the core states rather than a route catalog's side effect.

## Boundaries & Constraints

**Always:** **The reset set stays at exactly two event types.** `NominationPlaced` and `BidPlaced`, per AD-22; `AuctionOpened` is the origin and not a third; `AuctionClosed`, `ContentionDrawn`, `ContentionDissolved`, `BidVoided`, `AuctionTerminated` and `ContractAssignmentOpened` all reach `default` and leave the clock alone. **`BidVoided` is a non-reset, never a deletion** — the `BidPlaced` still exists and is still folded (AD-4), so the fold records the voided `seq` and the derivation skips it. **Recomputation is prospective only**: the expiry is compared against `now` at the next evaluation and nothing already accepted is reconsidered. **Expiry is `LEAGUE_CLOCK` after the LATER of the origin and the latest surviving reset** — `leagueClockExpiry` stays the one derivation, and no void can recompute past the origin. **Latest means highest `seq`, never latest timestamp** — the existing reducer's stated reason, unchanged under the global lock. **The phase-end transaction appends terminations FIRST and `ContractAssignmentOpened` LAST**, so no prefix of the log ever reads as Contract Assignment with a nomination still open. **An `AuctionTerminated` carries the NOMINATING Team and Manager**, off `OpenNomination`, exactly as `AuctionClosed` carries the winner's. **`ContractAssignmentOpened` carries a null actor** — it is the first genuinely system-originated event, the decision `spec-1-5:86` deferred to whichever story emitted one, and the migration makes the pair nullable together. **Termination appends no contract**, so the Player returns to the pool by the fold's own arithmetic and nothing writes `free_agent_players`. **The evaluation runs inside the tick, after the sweep**, in its own `runTransactionalWrite`, and its failure is recorded on the heartbeat without undoing a close. **The phase gate reads the folded phase and nothing else** — never a route, never a destination list.

**Ask First:** Any migration beyond the actor-nullability one this story is authorised for. Bumping `CORE_VERSION` or `EVENT_SCHEMA_VERSION`. Adding a `destinations.ts` catalog entry. Any change to `runTransactionalWrite`'s pipeline, to `decideClose`, or to `AuctionClosedPayload`. Any new design token or CSS sizing literal. Any new npm or Deno dependency.

**Never:** **Nothing appends a `BidVoided`** — Story 7.2 owns the void; this story proves the fold handles one, against a state literal. **No Commissioner override, pause or resume** (Epic 7). **No notification and no outbox** (Epic 5) — `enqueue` and the drain stay the no-op seams they are; log the notification obligation to `deferred-work.md` as 5.3's, following Story 1.11's identical deferral. **No Bid Board** — `/board` does not exist (4.3), and EXPERIENCE.md:32 puts the frozen readable board in **Archived**, not Contract Assignment, which contradicts :320; log the conflict rather than resolving it here. **No Contract Assignment surface** (Epic 6) — this story hands the phase over and builds none of what follows it. **No stored countdown, no `league_clock` column, no phase flag.** **No retroactive invalidation** of anything accepted before an evaluation. **No second phase-end path** — the tick is the only evaluator. No hand-edit of `planning-artifacts/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| §10 ex 13 — a close is not a reset | Nomination 09:00 Fri, Bid 12:00 Fri, `AuctionClosed` 12:00 Sat | Expiry stays 12:00 **Sun**. The close reaches `default` | N/A |
| §10 ex 27 — a void shortens it | Nomination 09:00 Mon, Bid 15:00 Mon, `BidVoided` naming that Bid's `seq` at 18:00 Mon | Expiry moves 15:00 Wed → **09:00 Wed**. Both events remain in the log | N/A |
| A void cannot pass the origin | Auction opens 09:00 Mon; its only Bid voided | Expiry falls back to the origin, never earlier | N/A |
| Void folded before its Bid | `BidVoided` at a lower `seq` than the `BidPlaced` it names | Still a non-reset — membership is order-independent, and a double replay converges | N/A |
| Void names nothing | Payload with no `voidedSeq`, or a `seq` no event carries | Skipped, `readPayload`'s idiom. The clock is unchanged and nothing throws | N/A |
| Expiry not reached | `now` before the computed expiry | No event appended, phase stays `Auction`, the tick reports it evaluated and did nothing | N/A |
| No origin | The auction has not opened | `leagueClockExpiry` is `null`; the evaluation is a no-op, not a phase end | N/A |
| Phase end, with unbid nominations | Expiry passed, three Players in Awaiting Opening Bid | Three `AuctionTerminated` then one `ContractAssignmentOpened`, one transaction. Each nominating Team's Slot frees; all three Players nominatable again | N/A |
| Phase end, nothing unbid | Expiry passed, no open nomination | `ContractAssignmentOpened` alone. Zero terminations is not a failure | N/A |
| Already ended | Expiry long past, phase already `Contract Assignment` | No second event. Evaluating twice is a no-op — this is what makes a restart-safe tick safe | N/A |
| Replay convergence | The same log folded twice | Same phase, same freed Slots, same expiry. `AuctionTerminated` for an absent nomination is a no-op | N/A |
| Bidding after the end | `PlaceBid` evaluated with `phase: 'Contract Assignment'` | `phase` gate fails; every other gate still reports its own arithmetic, none short-circuited | rejected |
| Nominating after the end | `refuseNomination` with the folded phase | Already refused by `rules/nomination.ts:211`, unchanged and now reachable for the first time | rejected |
| Evaluation throws | The phase-end transaction fails mid-pass | Named on the heartbeat, closes already committed stand, retried next pass | caught, recorded |
| Actor pair half-null | An event with a manager and no team | Refused by the migration's check constraint | db error |

</frozen-after-approval>

## Code Map

One migration, two new files, and the ninth gate. `main` is at `642d1d7`.

- `supabase/migrations/20260901000000_system_actor.sql` — **NEW.** `alter column manager_id drop not null`, same for `team_id`, plus `check ((manager_id is null) = (team_id is null))`. Relaxing a constraint on an insert-only table needs no backfill (AD-4). `20260821020000_auction_events.sql:53-58` is the comment that names this decision as deferred — update it in place is **not** allowed (applied migrations are immutable); state the change in the new file. Applied dev-first (AD-26).
- `src/lib/core/types.ts:81` — `EventEnvelope.managerId`/`teamId` widen to `string | null`; `:107` `AppendedEvent` likewise. Every existing construction site still compiles (`string` is assignable). `:606` `PLACE_BID_GATES` gains `'phase'` — **first in the list, before `expiry`**, because outside the Auction Phase which amount was offered is beside the point, exactly the ordering `rules/nomination.ts:182` argues for. `:628` `PlaceBidGateResults` gains the key; add `PhaseGateOutcome` beside `ExpiryGateOutcome` (`:568`) carrying `phase: LeaguePhase`.
- `src/lib/shell/write.ts:182` `toAppendedEvent` — `String(row['manager_id'])` turns `null` into `"null"`. Both must map through a null-preserving read. `:247` binds them unchanged. **The pipeline itself is otherwise read-only.**
- `src/lib/core/projection/league-clock.ts` — **the story's centre.** `LeagueClock` keeps `origin` and replaces `lastReset` with the two fields the derivation needs: the resets in fold order as `{ seq, occurredAt }`, and the voided `seq`s. `leagueClockReducer` (`:104`) gains a `BID_VOIDED_EVENT` case that records only the voided `seq` and touches no reset. `leagueClockExpiry` (`:152`) walks the resets last-to-first, skipping voided ones, and still takes the later of that and the origin — its unparseable-instant asymmetry at `:140` is deliberate and stays. `:13-28` the header's AD-22 argument stands; extend it rather than rewriting it.
- `src/lib/core/projection/phase.ts:49,60` — `CONTRACT_ASSIGNMENT_OPENED_EVENT` and the second `case`, which `:12` already names as the anticipated extension. `BID_VOIDED_EVENT` is declared beside the reducer that gives it meaning — `league-clock.ts` — per `CONTENTION_DRAWN_EVENT`'s precedent at `projection/draws.ts:60`.
- `src/lib/core/projection/nominations.ts:86,331` — `AUCTION_TERMINATED_EVENT` and its release case. The `AUCTION_CLOSED_EVENT` case at `:344` is the exact template, including the both-indexes-drop-together comment; `readClosedPlayerId` (`:297`) is the defensive reader to mirror. A termination for an absent nomination is a no-op, which is what makes replay converge.
- `src/lib/core/rules/phase-end.ts` — **NEW.** `PhaseEndState` carries the folded clock, nominations, phase **and the folded `OpenAuctions`**, `hasLeagueClockExpired(state, now)` and `decidePhaseEnd(state, now): Accepted<EventEnvelope[]> | null`. Pure, `now` injected. `rules/close.ts:361` `decideClose` is the shape for emitting several ordered envelopes from one decision; `rules/close.ts:529` shows the envelope construction idiom.
  **The auctions fold is load-bearing and is what makes "Awaiting Opening Bid" checkable rather than assumed.** `openNominations()` answers which Players hold a board seat, never which of them took a Bid, so a nomination whose Auction is *contested but stuck* — a close that keeps throwing, which `sweep.ts` models and retries forever — is indistinguishable from an unbid one in the nominations fold alone. `decidePhaseEnd` therefore terminates a nomination only when `auctionForPlayer(state.auctions, id) === null`, which IS the definition of Awaiting Opening Bid (`projection/auctions.ts:278` `contentionOf` says so). A nomination with a live Auction is **left open and untouched**: the phase still ends — one broken Auction must never hold it open — the sweep keeps retrying that close on later passes, and a close is not phase-gated, so the rightful winner can still be awarded afterwards. Terminating it would discard an accepted winning Bid, which is the one outcome this story must not produce.
- `src/lib/core/rules/bidding.ts:474` `bidStateFor` — a fourth parameter, `phase`, onto `BidState` (`:294`). `:1484` `evaluate` gains `phase: evaluatePhase(state)` first in the record, matching the list order. `:2265` `GATE_LABELS` gains `phase: 'Auction Phase'`. The refusal-sentence machinery around `:2268` needs its one new row; **no existing gate's arithmetic changes and none short-circuits another** (2.7's invariant).
  **The refusal sentence may state only what the gate itself decided.** The gate is `state.phase === 'Auction'`, so it knows the phase is not Auction and nothing more — it must NOT assert that the League Clock ran out, because `Setup` and `Archived` fail it too and in neither case did any clock expire. Word it from the phase alone ("Bidding is open only during the Auction Phase; the league is in `{phase}`"), the same discipline `rules/nomination.ts:129` already uses for its own phase refusal. A sentence naming a cause the gate cannot see is the "a gate that cannot see a figure cannot quote one" rule (AD-7) broken in words instead of numbers.
- `src/lib/server/phase-end.ts` — **NEW.** `evaluateLeagueClock(gateway)`: one `runTransactionalWrite`, folding clock + nominations + phase + **auctions** off a single `loadEventsViaClient` read, then `decidePhaseEnd`. `server/close.ts:103` `loadCloseState` is the four-folds-one-read discipline; `:186` `closeAuction` is the `runTransactionalWrite` shape. **Relative `.ts` imports only and no `node:` builtin** — Deno loads this through `sweep.ts` (`supabase/functions/tick/index.ts:52`), which is what `server/contention-seed.ts` was extracted to protect.
  **It MUST register `releaseNomination` in `projections`, exactly as `closeAuction` does** (`server/close.ts:191`). `open_nominations` is a real claim table with `open_nominations_pkey` on the Player and `open_nominations_team_id_key` on the Team (`20260825000000_open_nominations.sql`), written at `server/nomination.ts:388`; `releaseNomination` (`server/nomination.ts:442`) currently deletes only on `AUCTION_CLOSED_EVENT`, so **widen that one condition to release on `AUCTION_TERMINATED_EVENT` too**. A termination frees the same kind of Slot as a close, and leaving the claim row behind makes the table and the log disagree about a Slot permanently — an insert-only log can never be replayed to clear it, which is precisely what AD-5 makes the fold the authority to prevent. This is the one permitted edit to `server/nomination.ts`.
- `src/lib/server/sweep.ts:261` — after the close loop and **before** the drain, call the evaluation; a throw is recorded like a failed close and never undoes one. `TickSummary` (`:110`) gains a field naming what the evaluation did; `detailFor` (`:389`) states it. `:72` the header's "no League Clock evaluation (3.7)" is now false — rewrite it, and `supabase/functions/tick/index.ts:47`'s matching line.
- `src/lib/server/bidding.ts:221` `loadBidState` and `src/lib/server/auction-page.ts:691` — the two `bidStateFor` callers; both already fold the same event array, so each folds `phaseReducer` over it. `auction-page.ts:717` serialises the gate results the surface rebuilds from.
- `src/routes/+layout.svelte:13` — `HeaderMenu` already prints `data.phase.sentence` on every page, and `server/phase.ts:30` `PHASE_SENTENCES` already words Contract Assignment. The **announcement** is the addition: a distinct, role-neutral banner stating the phase has ended, not the ambient sentence that was always there. `src/routes/verify/+page.svelte` (152 lines) is the prose-page shape; tokens come from `src/lib/styles/tokens.css`.
  **It may NOT borrow the accent-bar device.** `DESIGN.md:162` reserves the 3px bar for exactly two markers — the Minimum-Bid Contention's left bar and the refusal panel's top bar — and says "no other element may borrow the device"; `:191` reserves `attention` for Outbid "and nothing else in the entire system". Use an ordinary panel border, no `--color-attention` and no `--accent-bar-width`. **And it is a standing statement, not a live one:** `role="status"` would re-announce the same sentence to a screen reader on every navigation for the weeks Contract Assignment lasts. Render it as a plain landmark with a heading.
- `src/lib/server/destinations.ts:85` — the Contract Assignment catalog is already correct and matches EXPERIENCE.md:32. **Read-only.**
- `tests/structure.test.ts:70` — the Story 3.6 note says outright that "13 and 27 are Story 3.7's"; `:72` `SECTION_10_EXAMPLES` is where they register. `tests/examples/example-09-the-lottery-dissolves.test.ts` is the state-literal idiom.
- `tests/core/auction-open.test.ts`, `tests/examples/example-01`, `-07`, `-09` — the four existing `LeagueClock` consumers; each asserts the shape that changes.
- `src/lib/core/constants.ts`, `src/lib/core/hash.ts`, `src/lib/core/instant.ts`, `src/lib/core/rules/close.ts`, `src/lib/core/rules/draw.ts`, `src/lib/server/close.ts` — **read-only.** Any edit is a finding: say which and why.

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/20260901000000_system_actor.sql` — nullable actor pair with the paired check constraint — AC5
- [x] `src/lib/core/types.ts` + `src/lib/shell/write.ts` — widen the envelope's actor to `string | null`, null-preserving row mapping; add `'phase'` to `PLACE_BID_GATES` and `PhaseGateOutcome` — AC5, AC4
- [x] `src/lib/core/projection/league-clock.ts` — resets by `seq`, the `BidVoided` non-reset case, the derivation that skips voided resets and never passes the origin — AC1, AC2
- [x] `src/lib/core/projection/phase.ts` — `CONTRACT_ASSIGNMENT_OPENED_EVENT` and the second case — AC3
- [x] `src/lib/core/projection/nominations.ts` — `AUCTION_TERMINATED_EVENT` and the release case, mirroring `AuctionClosed`'s — AC3
- [x] `src/lib/core/rules/phase-end.ts` — `decidePhaseEnd`: terminate ONLY nominations with no Auction row, terminations first, `ContractAssignmentOpened` last, null actor on the latter — AC3, AC7
- [x] `src/lib/core/rules/bidding.ts` — the `phase` gate first in `evaluate`, its label and its refusal row; no other gate's arithmetic touched — AC4
- [x] `src/lib/server/phase-end.ts` + `src/lib/server/nomination.ts` — the evaluation transaction, Deno-loadable, one log read, with `releaseNomination` registered and widened to release on `AUCTION_TERMINATED_EVENT` — AC3
- [x] `tests/server/phase-end.test.ts` — **NEW.** Drive `loadPhaseEndState` and `evaluateLeagueClock` through the real pipeline against a fake gateway, asserting the events actually appended and the claim rows actually deleted. `tests/server/close.test.ts:43`'s `fakeGateway` is the shape — AC3, AC7
- [x] `src/lib/server/sweep.ts` + `supabase/functions/tick/index.ts` — call it after the sweep, report it on the heartbeat, correct both headers — AC3
- [x] `src/lib/server/bidding.ts`, `src/lib/server/auction-page.ts` — fold the phase onto `BidState` at both `bidStateFor` callers — AC4
- [x] `src/routes/+layout.svelte` — the phase-end announcement, stated in words on every surface; no accent bar, no `attention`, not a live region — AC6
- [x] `tests/examples/example-13-league-clock.test.ts`, `example-27-a-voided-bid-shortens-the-clock.test.ts` + `tests/structure.test.ts` — §10 examples 13 and 27 registered, the story note extended — AC1, AC2
- [x] `tests/core/league-clock.test.ts` — the fold: every non-reset event type, void-before-bid, malformed void, the origin floor, replay convergence — AC1, AC2
- [x] `tests/core/phase-end.test.ts`, `tests/phase-projection.test.ts` — every remaining I/O Matrix row: event order, zero terminations, the idempotent second evaluation — AC3
- [x] `tests/core/bidding.test.ts`, `tests/server/auction-page.test.ts` — the ninth gate refuses and no other gate short-circuits — AC4
- [x] `tests/server/sweep.test.ts`, `tests/core/auction-open.test.ts`, `tests/examples/example-01`, `-07`, `-09` — the evaluation in the pass, a throwing evaluation not undoing a close, and the four existing `LeagueClock` assertions updated — AC3
- [x] Three small ones, each named by review: `readTerminatedPlayerId` is declared ONCE in `projection/nominations.ts` and imported by the server rather than reimplemented there with a different fallback; `sweep.ts`'s `detailFor` states the phase-end status on the version-refusal and could-not-run branches too, not only on a completed pass; and the `toAppendedEvent` docblock in `shell/write.ts` stays attached to `toAppendedEvent` rather than being orphaned by a function inserted above it — AC5
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` — close the two League-Clock-has-no-consumer entries; append the Manager notification (5.3), the EXPERIENCE.md:32-vs-:320 Bid Board conflict (4.3), and that the Audit Log (7.5) must render a null actor as the system rather than blank — AC6

**Acceptance Criteria:**
- Given a log carrying an `AuctionOpened`, a Nomination, a Bid and an `AuctionClosed`, when the League Clock is folded, then the expiry is 48 hours after the Bid and every event type outside the two-member reset set left it alone.
- Given a `BidVoided` naming an earlier `BidPlaced`'s `seq`, when the clock is folded, then that reset is skipped, the expiry recomputes to the previous surviving reset, both events are still in the log, and the result never falls earlier than the origin.
- Given the League Clock's expiry has passed and two Players sit in Awaiting Opening Bid, when the tick evaluates, then one transaction appends two `AuctionTerminated` and then one `ContractAssignmentOpened`, the phase folds to Contract Assignment, both Nomination Slots free, both Players are nominatable again, and a second evaluation appends nothing.
- Given the phase has folded to Contract Assignment, when a `PlaceBid` is evaluated, then the `phase` gate refuses it, every other gate still reports its own arithmetic, and `refuseNomination` refuses a nomination for the same reason.
- Given `npm run check`, `npm test` and `npm run check:purity`, when they run, then all pass, and `npx deno check --config supabase/functions/tick/deno.json supabase/functions/tick/index.ts` still resolves the whole chain.
- Given a Manager opening the app after the transition, when any page renders, then it states in words that the Auction Phase has ended and Contract Assignment has begun, from the same folded phase every other surface reads.
- Given the League Clock expires while one nominated Player's Auction holds a live leading Bid whose close keeps throwing, and another nominated Player has taken no Bid at all, when the tick evaluates, then only the unbid Player is terminated, the contested nomination is left open with its Bid intact, the phase still ends, and the nominating Team's claim row is deleted for the terminated Player and kept for the contested one.

## Spec Change Log

- **2026-09-01, review loop 1.** Triggered by four independent findings on one defect: `decidePhaseEnd` terminated **every** open nomination, so a contested Auction whose close kept throwing would be terminated as though unbid, discarding an accepted winning Bid. Root cause was in this spec, not the implementation — the Code Map defined `PhaseEndState` as "(folded clock, nominations, phase)", and the nominations fold cannot distinguish Awaiting Opening Bid from contested-but-stuck. **Amended:** `PhaseEndState` now carries the folded `OpenAuctions` and terminates only where `auctionForPlayer(...) === null`; `server/phase-end.ts` must register `releaseNomination` and that function widens to `AUCTION_TERMINATED_EVENT`, closing a permanent log-vs-claim-table divergence; a `tests/server/phase-end.test.ts` task was added because every sweep test stubbed `endPhase` and the real transaction was never driven past its no-op path; AC7 was added for the stuck-Auction case. Two review patches folded in: the `phase` gate's refusal sentence may not claim the League Clock ran out (false in Setup and Archived), and the announcement banner may not borrow the reserved accent-bar device (`DESIGN.md:162`) or be a live region.
  **Known-bad state avoided:** a phase end that silently converts a contested Auction into "returned to the pool", with no test that would catch it.
  **KEEP — these were verified correct and must survive re-derivation:** the `LeagueClock` rewrite to `origin` + resets-by-`seq` + `voidedSeqs`, with `leagueClockExpiry` walking backward past voided and unreadable resets and never falling below the origin; the four-shape malformed-`voidedSeq` table test; §10 examples 13 and 27 and their registration; terminations-first-then-`ContractAssignmentOpened` with the null-and-null-together actor; the migration's paired check constraint; the ninth gate placed first in `PLACE_BID_GATES` with no other gate's arithmetic touched; and the sweep's refusal to evaluate on a version mismatch or a pass that could not run.

## Design Notes

**Why the fold has to carry every reset.** `fold()` is one forward pass in `seq` order, and a `BidVoided` arrives *after* the `BidPlaced` it names. A reducer holding only `lastReset` cannot undo one: by the time the void is folded, the instant it must fall back to is already gone. So the state carries the resets it has seen and the `seq`s that have been voided, and `leagueClockExpiry` derives the latest survivor:

```
resets:  [{seq:'4', at:'Mon 09:00'}, {seq:'7', at:'Mon 15:00'}]
voided:  ['7']
         -> walk last-to-first, skip '7', take seq 4 -> Mon 09:00
         -> expiry = later(origin, Mon 09:00) + 48h = Wed 09:00
```

That is §10 example 27 exactly. Membership rather than position also makes a void folded before its bid behave identically, which is why replay converges without an ordering assumption.

**Why a stuck Auction is left open rather than terminated or blocking.** Three answers were possible for a nomination whose Auction has Bids but will not close. Terminating it discards a Bid the rules already accepted — a money outcome, and the worst failure class NFR1 names. Refusing to end the phase until it closes lets one corrupt Auction hold the entire league open indefinitely, which is what the sweep's per-Auction `catch` exists to prevent. So the phase ends, that one nomination stays open, and the sweep keeps retrying its close on every later pass — a close is not phase-gated, so the rightful winner can still be awarded afterwards. That is AD-10's "late, not wrong" applied to the phase boundary rather than to a single Auction, and it is why the terminated set is derived from the auctions fold instead of assumed from the calendar.

**Why terminations precede the phase end.** Both land in one transaction, so no reader sees a partial state — but the log is read by prefix forever afterward, and a prefix ending between them would say the Auction Phase is over while a Player is still on the board holding a Slot. The other order says the opposite: Slots freed inside a phase that has not yet ended, which is merely early rather than contradictory. `ContentionDrawn`-before-`AuctionClosed` chose its order on the same ground.

**Why the phase gate rather than the destination list.** `auction` is already absent from the Contract Assignment catalog, so the route would 403 on its own — but that puts "bidding is disabled league-wide" in a navigation table, and the core would still accept a bid handed to it directly. AD-1 fixes the gate set per command type in `core/types.ts` precisely so a rule like this is one edit that makes every consumer a compile error; this is the fifth time that has been spent and the mechanism is the reason the story can state the invariant where a Tier A story needs it.

**Why the actor is null and not the Commissioner.** The alternative attributes the phase end to the one person the whole epic exists to keep out of it. The Audit Log would then read as though a rival adjudicated the close of the books — the exact perception AD-14's commit-reveal was built to foreclose. `spec-1-5:86` left this open for the first story to emit a system event; a null pair, constrained to be null together, records honestly that nobody acted.

## Verification

**Commands:**
- `npm test` — expected: green, including the two new §10 examples and the clock, phase-end, gate and sweep suites.
- `npm run check` — expected: no type errors. The widened actor type and the ninth gate both surface here first.
- `npm run check:purity` — expected: green; `core/` gained `rules/phase-end.ts`, which reads no clock and no random source.
- `npx deno check --config supabase/functions/tick/deno.json supabase/functions/tick/index.ts` — expected: resolves. **Not optional**: `sweep.ts` gained an import of `server/phase-end.ts`, and a `node:` builtin anywhere in that chain breaks the tick at the runtime boundary rather than at the type check. `--config` is load-bearing.
- `npm run check:pins` — expected: green, unchanged.
- `git diff --stat -- src/lib/core/constants.ts src/lib/core/hash.ts src/lib/core/instant.ts src/lib/core/rules/close.ts src/lib/core/rules/draw.ts src/lib/server/close.ts src/lib/server/destinations.ts` — expected: empty.

**Manual checks (if no CLI):**
- Apply the migration to the dev project first (AD-26) and confirm an insert with one of the two actor columns null is refused, while both-null and both-set are accepted.

## Suggested Review Order

**The fold — a void withdraws a reset without deleting anything**

- The whole design in one type: an origin, resets kept by `seq`, and the voided ones.
  [`league-clock.ts:152`](../../src/lib/core/projection/league-clock.ts#L152)

- Records the voided `seq` and touches no reset — a void is never a deletion (AD-4).
  [`league-clock.ts:236`](../../src/lib/core/projection/league-clock.ts#L236)

- Walks resets last-to-first past voided ones, then floors at the origin.
  [`league-clock.ts:289`](../../src/lib/core/projection/league-clock.ts#L289)

- Order-independent by construction, so a void folded before its Bid converges.
  [`league-clock.ts:184`](../../src/lib/core/projection/league-clock.ts#L184)

**The rule — what the phase end costs, and what it must not take**

- Terminates only where no Auction row exists — the definition of Awaiting Opening Bid.
  [`phase-end.ts:226`](../../src/lib/core/rules/phase-end.ts#L226)

- Terminations first, the phase end last: no prefix reads as ended with a seat still held.
  [`phase-end.ts:258`](../../src/lib/core/rules/phase-end.ts#L258)

- The auctions fold is on the state precisely so the filter above is checkable.
  [`phase-end.ts:89`](../../src/lib/core/rules/phase-end.ts#L89)

- One derivation of "the clock ran out", called rather than restated.
  [`phase-end.ts:203`](../../src/lib/core/rules/phase-end.ts#L203)

**The runtime — one transaction, and the claim table kept honest**

- Four folds off one log read, with `releaseNomination` registered.
  [`phase-end.ts:158`](../../src/lib/server/phase-end.ts#L158)

- The claim delete now answers a termination as well as a close.
  [`nomination.ts:465`](../../src/lib/server/nomination.ts#L465)

- Both instants on the heartbeat, so a late pass is distinguishable from an on-time one.
  [`sweep.ts:580`](../../src/lib/server/sweep.ts#L580)

- A null actor survives the row mapping as `null`, never the string `"null"`.
  [`write.ts:186`](../../src/lib/shell/write.ts#L186)

**The gates and the phase — disabled league-wide, stated once**

- The ninth gate, reading the folded phase and nothing else.
  [`bidding.ts:1480`](../../src/lib/core/rules/bidding.ts#L1480)

- The second case, and the only way out of Auction.
  [`phase.ts:103`](../../src/lib/core/projection/phase.ts#L103)

- The release case, keyed on the Player exactly as a close is.
  [`nominations.ts:432`](../../src/lib/core/projection/nominations.ts#L432)

- The paired constraint: an actor is recorded whole or not at all.
  [`20260901000000_system_actor.sql:43`](../../supabase/migrations/20260901000000_system_actor.sql#L43)

**The surface**

- A standing statement, not a live region, and it borrows no reserved device.
  [`+layout.svelte:41`](../../src/routes/+layout.svelte#L41)

**Supporting — the claims the tests actually pin**

- AC7 through the real transaction: the contested claim row is kept, the unbid one deleted.
  [`phase-end.test.ts:389`](../../tests/server/phase-end.test.ts#L389)

- The same rule pure: terminate the unbid, leave the contested Bid standing.
  [`phase-end.test.ts:308`](../../tests/core/phase-end.test.ts#L308)

- §10 examples 13 and 27, registered so they cannot silently not run.
  [`structure.test.ts:97`](../../tests/structure.test.ts#L97)

- The ninth gate refuses without claiming a clock expired.
  [`bidding.test.ts:3082`](../../tests/core/bidding.test.ts#L3082)
