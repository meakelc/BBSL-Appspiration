# Epic 7 Context: The referee's controls and the record

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Give the Commissioner a set of visibly distinct referee controls — void a Bid, adjust Cap Space, terminate an Auction, release a Nomination Slot, extend or expire any Clock, assign a contract length on a Team's behalf, and pause and resume the whole auction — each committing only through a mandatory free-text reason and a stated before/after, and each landing in an append-only Audit Log any Manager can read. The epic also carries the everyday half of the same machinery: recording what already happened in Fantrax — a trade, or a drop and the Dead Money it leaves behind — so both Teams' cap and slot positions stay true for the rest of the auction, plus a detector that says when Fantrax and the app have drifted apart. Rules meet reality, visibly: auditability over convenience is the standing tiebreaker, and the Audit Log is where it is demonstrated.

## Stories

- Story 7.1: The Commissioner control class and the reason sheet
- Story 7.2: Void a Bid and restore the Auction
- Story 7.3: The remaining overrides
- Story 7.4: Pause and resume the auction
- Story 7.5: The league-visible Audit Log
- Story 7.6: Dead Money and the rookie-scale designation
- Story 7.7: Record a Roster Move
- Story 7.8: Record a Drop
- Story 7.9: Detect a Roster Divergence from Fantrax

## Requirements & Constraints

- **No Commissioner act is ever a single tap.** Every override opens a reason sheet: before → after for every affected value including both Clocks, any non-obvious downstream consequence stated in words, and a reason field empty on open with no placeholder, default or skip. A reasonless submission must be refused server-side, proven by an automated test.
- **Every override appends an event** carrying actor, timestamp, before-state, after-state and reason; nothing is deleted or mutated. Overrides are permitted in the Auction and Contract Assignment Phases and refused once archived. All are broadcast to Discord **except a Roster Move**, which is audit-log-only by deliberate choice.
- **The Audit Log is a read of the insert-only event log**, never a parallel table. No role — Commissioner included — can edit or delete an entry, and the UI offers no affordance suggesting otherwise. It covers Nominations, Bids, Closes, Randomizer draws with the revealed seed and the ordered Contender list, overrides, pause/resume, imports and exports; filterable by Team, Player and event type; exportable; single-column and legible at 375px in every phase including Archived.
- **Pause is the universal escape hatch.** It persists each Clock's remaining duration and the pause instant rather than shifting absolute close times; the tick checks paused state under the same global lock and closes nothing; Bids and Nominations are refused with the pause stated as the reason, worded distinctly from every rules refusal; resume recomputes close times forward from the resume instant. A break-glass path independent of the web host must exist, be documented and be rehearsed.
- **Voiding is prospective only.** A void removes that Bid's League Clock reset and the Clock recomputes from surviving resets, which can end the Auction Phase sooner — but nothing accepted in the interim is invalidated.
- **A recorded world change refuses; it never cancels.** If either Team fails the money or slots gate, the whole Move or Drop is refused and nothing is written, naming the Team, the gate, the Auction and the arithmetic. No Bid is ever stood down by an administrative act.
- **The Dead Money rule, applied uniformly:** a Drop converts the Player's *charged* Cap Hit into Dead Money at the same amount — full from Active/Bench, full from Injury Reserve, nothing from a Minor League Slot. A dropped rookie-scale contract carrying a full unelapsed term is removed rather than reclassified. Dead Money is excluded from both Fantrax exports.
- **The divergence detector detects and proposes only** — never writes an event, row or projection, and never applies a Move or Drop itself. It reads at most hourly, takes membership as the only fact, excludes Players won in this auction, and renders as *stopped* rather than *no divergences* on failure. A plausibility guard (all 30 Teams present, no empty roster, no more than a tunable quarter of the League diverging in one pass) refuses to raise anything and must be acknowledged rather than self-clearing.
- Corrective override count is a success metric targeting fewer than five across the whole auction; Roster Moves and Drops are explicitly excluded from that count.

## Technical Decisions

- **The control class is separated by form, not colour:** never filled, dashed 1px `admin` border, recessed `admin-ground` behind a dashed rule, and a persistent "Commissioner · visible only to you" label — with the sheet's own commit control also dashed. Controls live in place on the object being acted on; genuinely global admin acts get their own admin destination. Visibility is cosmetic; the route refuses server-side regardless of what renders.
- **A void reuses the one pure restoration selector** (`core/rules/restore.ts`'s `selectRestoration`, shipped by the Bid Cancellation work) called with the void's own axes. This epic writes no second selector and performs no second walk of surviving history.
- **A Roster Move is a third command type** declared in `core/types.ts` with its own gate set over both Teams' post-Move state. It reuses `core/rules/bidding.ts`'s money and slot arithmetic as pure helper functions and must never synthesize a bid to force-pass gates that do not apply. One evaluation over the whole Move, at the end, against post-Move state — never a direction at a time.
- **Mutation plus record, in one transaction under the global write lock.** The reference tables are the world and stay mutable, but the record event carries the *whole* delta — every Player, both Teams, both Slot kinds, both Cap Hits — so rebuild, restore and synthetic-clock replay reconstruct rosters at a past instant by folding reference-data-mutation events forward from the last snapshot, in memory and read-only, never reading the live table for a past instant.
- **Existing Contracts move by `UPDATE` of the team key, never delete-then-insert** (the Fantrax player id is unique across every Team). Auction Contracts have no row and move by the event alone, folded latest-transfer-wins. One event covers both kinds.
- **A Player contested in an open Auction cannot be moved or dropped** — a third refusal ground returned by the rules core, checked *before* money and slots, not a filter the admin screen is trusted to apply.
- **Dead Money is a fourth roster slot kind:** it charges in full, counts toward no ceiling, and frees a roster-count slot. The charged-cap-hit rule stays one expression by falling through the minor-league check; that fallthrough is sanctioned there and nowhere else. Treat the kind as a **closed union of exactly four members** — every switch over it in the core and adapters exhaustive with no `default`, so a missing branch is a compile error. Admitting the fourth value is a schema change: a migration file applied dev-first, never a dashboard edit, landing in the same commit as the union member.
- A latent import defect blocks the rookie-scale exception: the contract-end-year pattern in the Fantrax roster adapter matches the rookie prefix in a **non-capturing** group and discards it, so the designation must survive import as structured data (round and full term) before the rule can be implemented. The fix stays confined to that adapter, and an unrecognised shape still refuses the row and names it.
- **Slot Placement is re-evaluated on arrival and Cap Hit follows placement** (the winning amount untouched); a freed Minor League Slot recomputes Minors Exposure across every eligible Auction the Team still leads.
- **The Fantrax reader is shell code, adapter-confined and structurally write-free** — it never receives a database client, runs outside the write lock and outside the core, and keeps every field name and response shape inside the Fantrax adapter. Salaries arrive as floats carrying representation error: round to the nearest dollar and assert the money grid, refusing off-grid rows; never truncate. Player ids must be normalised in both directions inside the adapter (the API returns bare ids, the importer stores an asterisk-wrapped form). Team mapping is explicit, never by name, and the API's underscored injured-reserve status does not match the CSV importer's alias.
- **A deploy touching the rules core during a live Auction Phase fail-stops**: each needs a pause, a green rules-example suite and a recorded reason.

## UX & Interaction Patterns

- The reason sheet grows a **two-Team variant** for a Roster Move: Cap Space, Roster Count and all three Slot occupancies for both Teams side by side, with the moved Players named between them, and any Cap Hit changed by re-placement stated in words with an `attention` note.
- **Say the counterintuitive direction out loud, before commit.** A Drop from Active/Bench *lowers* Maximum Bid — the freed hole costs roster reserve while the Cap Hit persists as Dead Money. Dead Money itself renders on the Team view and the Teams index labelled and separate from the roster.
- The **paused banner appears on every surface** — `attention` border on a warm ground — stating that Clocks are stopped, that Bids and Nominations are refused, and that each Clock resumes with exactly the time it held, plus who paused it, when, and why.
- Most surfaces in this epic have **no mock and are specified by table and rule only** (the Audit Log and the admin surfaces), so drift risk is high — raise a visual reference before building if one turns out to be needed. Commissioner surfaces may gain multi-column desktop layouts but must stay fully operable at 375px, because a pause happens wherever the Commissioner physically is.
- Divergences appear on the Commissioner's surface only, never a Manager's; a dismissed divergence stays suppressed until the underlying difference changes.

## Cross-Story Dependencies

**Story numbers are identity, not build order.** Build: 7.6 in parallel from the start (it depends on nothing), then 7.1 → 7.7 → 7.5 → 7.8 → 7.2 → 7.9 → 7.3/7.4.

- 7.7 depends on 7.1 only; 7.8 depends on 7.1 and 7.6; 7.9 depends on 7.7 and 7.8; 7.2, 7.3 and 7.4 depend on 7.1. 7.5 depends only on the Epic 1 event-log story.
- **7.5 is on the critical path** because a Roster Move is not broadcast to Discord: ship 7.7 without the Audit Log and every recorded trade is invisible to the league — figures move with no announcement and no surface to look them up on.
- **7.2 is the remedy for a refused trade**, not only a correction tool. Without it a refused Move stalls for up to 24 hours waiting on a Close.
- 7.2 reuses the restoration selector shipped by the Bid Cancellation epic; finish that epic's board-and-Discord story first, since it touches the same bidding gates 7.7 reuses rather than reimplements.
- 7.7's cleared-length criterion — a cleared length re-blocking the export — cannot be exercised until Epic 6 ships the export, so expect that acceptance criterion deferred rather than met.
- **Deployment:** 7.6, 7.7 and 7.8 all touch the rules core, so they should land before the go-live epic's prod setup day and ideally before the moderator pilot, or every later fix becomes a league-wide freeze.
