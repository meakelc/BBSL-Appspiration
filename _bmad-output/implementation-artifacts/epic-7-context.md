# Epic 7 Context: The referee's controls and the record

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

This epic makes the rules meet reality, visibly. The Commissioner gains a bounded set of referee controls — void a Bid, adjust Cap Space, terminate an Auction, release a Nomination Slot, extend or expire a Clock, assign a contract length on a Team's behalf, pause and resume the whole auction — each carrying a mandatory free-text reason and a stated before/after, and each appended rather than applied in place. Alongside those break-glass controls it carries the *everyday* roster operations: recording the trades and drops managers execute in Fantrax so both sides' cap and slot arithmetic stays true, letting a Manager rearrange their own Minor League placements, and being told when Fantrax and the app have drifted apart. Every one of these acts lands in an append-only Audit Log any Manager can read, because verifiable fairness should be something a manager can check rather than be asked to trust.

## Stories

- Story 7.1: The Commissioner control class and the reason sheet
- Story 7.2: Void a Bid and restore the Auction
- Story 7.3: The remaining overrides
- Story 7.4: Pause and resume the auction
- Story 7.5: The league-visible Audit Log
- Story 7.6: Dead Money and the rookie-scale designation
- Story 7.7: Record a Roster Trade
- Story 7.8: Record a Drop
- Story 7.9: Detect a Roster Divergence from Fantrax
- Story 7.10: Rename the Roster Move to a Roster Trade
- Story 7.11: Rearrange a Roster's Slot Placements

## Requirements & Constraints

- **No Commissioner act is ever a single tap.** Every override opens a reason sheet with an empty reason field — no placeholder, no default, no skip — showing before → after for every affected value including both Clocks, and stating any non-obvious downstream consequence in words. A reasonless submission must be refused **server-side**, with an automated test proving it.
- **The log is insert-only for every role, the Commissioner included.** Corrections append compensating events; nothing is ever deleted or mutated. Every override records actor, timestamp, before-state, after-state and the reason, and is refused once the auction is archived.
- **The Audit Log is a read of that event log, not a parallel table.** It covers nominations, bids, closes, randomizer draws (with revealed seed and the ordered contender list as it stood at expiry), overrides, pause/resume, imports and exports; filterable by Team, Player and event type; exportable; readable by any Manager in every phase including Archived; legible single-column at 375px.
- **Voiding is prospective.** A void restores the prior Leading Bidder and prior Auction Clock, removes that Bid's League Clock reset and recomputes the League Clock — which can end the Auction Phase *sooner* — but nothing accepted in the interim is invalidated.
- **Pause stores remaining duration; absolute close times are never shifted in place.** The tick checks paused state under the same global lock and closes nothing; bids and nominations are refused with the pause stated as the reason, worded distinctly from every rules refusal; resume recomputes close times forward from the resume instant so each clock keeps exactly the time it held. A break-glass pause path independent of the web host must exist, be documented and be rehearsed.
- **Roster acts evaluate once, over the whole act, at the end.** A Trade names both Teams and moves Contracts in both directions (either side may be empty); both Teams are evaluated once against post-act state, never a direction at a time. Any gate failure refuses the *whole* act and writes nothing, naming the Team, the gate, the Auction and the arithmetic. A refusal can be caused by the *sending* Team, since a freed Slot costs $1,000,000 of Roster Reserve.
- **A world change refuses; it never cancels a Bid.** Cancellation stays triggered by an Auction Close and by nothing else. The Commissioner's remedy for a refused trade is a void or waiting for the Close.
- **Cap Hit follows Slot Placement**, with the Contract's value untouched: a stashed Player arriving in Active/Bench charges his full amount; a Contract in minors charges $0. Freed or filled Minor League Slots force a Minors Exposure recompute across every eligible Auction the Team leads.
- **Dead Money** charges the cap in full, occupies no Slot, counts toward no ceiling, renders labelled and separate from the roster, is not importable in v1, and is excluded from both exports. A Drop converts the Player's *charged* Cap Hit into Dead Money at the same amount — so a minors drop carries none — as one uniform rule with no per-slot special cases.
- **A Manager's Move touches only their own Team**, resolved from the session and never from a form field; Injury Reserve is not rearrangeable and Dead Money is not a Slot; only a Minor League Eligible Contract may occupy a Minor League Slot, and eligibility is remembered so a demotion is reversible. No assigned length is cleared. The act is live in the Auction and Contract Assignment Phases, refused in Setup and Archived, and refused while paused.
- **The Fantrax divergence read takes membership only**, at most hourly, and never writes an event, row or projection — it proposes, and every write goes through the Trade or Drop path with its mandatory reason. It rounds salaries to the dollar and asserts the $500,000 grid rather than truncating, normalises player ids in both directions, maps Teams explicitly rather than by name, excludes Players won in this auction, raises nothing on a placement difference, reports an unknown arrival as a prominent error, and guards implausible payloads (all 30 Teams present, no empty roster; more than a tunable quarter of the League diverging in one pass is a fault, not news). A tripped guard never clears itself. Failure renders as *stopped*, never as *no divergences*, and blocks no auction action.

## Technical Decisions

- **The rules core is pure and gates are fixed per command type.** A Roster Trade is a third command type and a Roster Move a fourth, each declared with its own gate set. They reuse the existing money and slot gate arithmetic as pure helper functions and write **no affordability check of their own** — never by synthesizing a bid and force-passing inapplicable gates, which would route two Teams' opposing deltas through a gate defined as single-Team and incremental.
- **Departures before arrivals.** Every slot-changing act applies departures from all Slots before placing any arrival, so a transient over-occupancy is never constructed and never judged; the Team's figures are derived once, at the end, from the rows it is left holding.
- **One restorer, several callers.** A void reuses the shared pure restoration selector with the void's own axes; it writes no selector of its own and performs no second walk of surviving history.
- **Mutation plus record, in one transaction under the global write lock.** Rosters stay a mutable table — the world is not event-sourced, only the auction is — but the record event carries the *whole delta* (every Player, both Teams, both Slot kinds, both Cap Hits, figures before and after), so a rebuild, restore or synthetic-clock replay reproduces the world as it stood. A partially applied act must be unreachable.
- **Existing Contracts move by `UPDATE` of the team id**, never delete-then-insert, because the Fantrax player id is unique across every Team. Auction Contracts have no row and move by the event alone, folded latest-wins.
- **Dead Money is a fourth slot kind and needs a migration** applied dev-first, never a dashboard edit. The slot-kind union is closed at exactly four members: every switch over it in core and adapters is exhaustive with no `default`, so a missing branch is a compile error rather than a sibling module silently tallying Dead Money as an occupant. The charged-cap rule stays one expression.
- **Placement is taken from the command for a Manager's Move**, not re-derived by the automatic placement rule — the automatic rule is what a close and a Trade arrival apply; a Move is a deliberate override, and re-deriving it would silently undo itself.
- **Eligibility is a fold, not a column:** the live pool's flag union every Contract the app has ever observed in a Minor League Slot, reconstructed from the reference-data snapshot. That is what makes a demotion reversible, and why the Move needs no migration.
- **Persisted event-type strings are immutable.** Renaming vocabulary in code must leave already-written event-type values alone, with a test asserting the literal string; only the constant holding it is renamed.
- **All Fantrax knowledge stays in one adapter** — field names, response shapes, id formats, status vocabulary. The divergence reader runs in the shell, outside the write lock and outside the core, and is structurally unable to write (it never receives a database client).
- **Rules-core deploys are fail-stopped during a live Auction Phase:** a pause, a green rules-example suite and a recorded reason are required. The core-touching stories should therefore land before the auction opens.

## UX & Interaction Patterns

- The Commissioner control class is separated by **form, not colour** — four independent properties: never filled, dashed 1px admin border, recessed admin ground behind a dashed rule, and a persistent "Commissioner · visible only to you" label. No override control is a variant of a Manager control, and even the commit control on the sheet is dashed.
- Overrides live **in place, on the object being acted on**, so an act is performed with full context on screen; only genuinely global administrative acts get their own admin destination. Controls are invisible to non-Commissioners *and* refused server-side regardless of what rendered. Every guard runs on load **and** on the action; hiding a form is never the check.
- The Trade sheet is a **two-Team variant**: before → after side by side for Cap Space, Roster Count and all three Slot occupancies, with the moved Players named between them, and any Cap Hit changed by re-placement stated in words with an attention note.
- **Say the counterintuitive direction out loud, before commit.** A Drop from Active/Bench *lowers* Maximum Bid; a demotion to minors can *raise* it while lowering Cap Space. The sheet states the direction in words rather than leaving it inferred from two figures.
- The Manager and Commissioner Move sheets are **two controls, not one with a conditional field** — the Manager's is a solid Manager control with no reason field; the Commissioner's is the dashed, labelled, reason-demanding sheet. The act must still work, and still be refused, with JavaScript off.
- A pause shows an unmissable banner on **every** surface — attention border on a warm ground — stating that clocks are stopped, that bids and nominations are refused, that each clock resumes with exactly the time it held, and who paused it, when and why.
- Money renders at exactly one decimal in the UI and in Discord payloads, and never in an exported cell. Teams are spelled out with their Manager attached; a three-letter abbreviation means an NBA team and nothing else.
- The Commissioner's own Team gets no privilege: ordinary Manager controls behave on it exactly as they do for anyone else.

## Cross-Story Dependencies

**Build order is deliberately not story order** — the numbers are identity, not sequence, and were not reshuffled because renumbering would churn every sprint-status key and by-name citation. Build 7.6 in parallel from the start, then 7.1 → 7.7 → 7.5 → 7.8 → 7.2 → 7.9 → 7.3/7.4, with 7.10 then 7.11 after everything else that touches the trade code.

- **7.1** gates every other override story; **7.6** is the sole exception and depends on nothing.
- **7.5 is on the critical path** because a recorded Trade is *not* broadcast to Discord — the Audit Log is the only channel by which the league learns a rival's Cap Space moved. Shipping 7.7 without 7.5 makes every recorded trade invisible to all thirty managers.
- **7.2 is the remedy for a refused Trade**, not only a correction tool; without it a refusal stalls for up to 24 hours, and refusals are expected rather than rare.
- **7.8** depends on 7.1 and 7.6. **7.9** depends on 7.7 and 7.8, and is contingent and explicitly killable.
- **7.10** depends on 7.7 and 7.8 being done, changes no behaviour, **blocks 7.11**, and should also precede 7.9 (whose criteria say "Roster Move" and mean Trade).
- **7.11** depends hard on 7.10 for its vocabulary, plus 7.1 for the sheet and 7.7 for the shared evaluator — not on 7.6, 7.8 or 7.9.
- External: the shared restoration selector arrives with Epic 10's cancellation work, which should finish first since it touches the same bidding gates 7.7 reuses rather than reimplements. A Trade's cleared-length criterion cannot be fully exercised until Epic 6 ships the contract export, so expect that one deferred. The whole core-touching block should precede Epic 9's production setup and ideally its moderator pilot, so the pilot exercises trade recording and rearrangement against real managers.
