# Epic 6 Context: Close the books — assignment, export, archive

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Turn a finished auction into a file the Commissioner can upload back into Fantrax, and then freeze the record. Every Manager assigns contract lengths to the Players they won against a fixed Year Allotment — one 4-year, one 3-year, two 2-year, unlimited 1-year — which is where the league's real dynasty tradeoff is made. The Commissioner watches completion fill in, nudges stragglers, reviews the whole outcome on screen, downloads two Fantrax-shaped CSVs, uploads them by hand, and marks the auction archived. This is the back half of the commissioner's closing journey and the last step before results leave the app. It carries a strong negative requirement: **nothing here decides on a Manager's behalf.** The deadline resolves nothing, no contract length is ever defaulted, and the export simply stays blocked until a human acts.

## Stories

- Story 6.1: Assign contract lengths against the Year Allotment
- Story 6.2: Track completion, and a deadline that resolves nothing
- Story 6.3: Review and export the Auction Contracts
- Story 6.4: Export full post-auction rosters
- Story 6.5: Archive the auction

## Requirements & Constraints

- **The allotment is per-Team, per-offseason, and expires unused.** It applies only to Auction Contracts; Existing Contracts cannot be extended or altered here. Remaining allotment is shown as the Manager assigns, and an over-spend is refused with what remains stated.
- **Assignments are freely changeable until submitted as final**, and both assignment and final submission are two-part acts. Nothing consequential happens on a single tap.
- **No default assignment, ever.** The deadline notifies the affected Teams and the Commissioner, logs an extension if one is granted, and does nothing else. The escape hatch — the Commissioner assigning on a Team's behalf with a recorded reason — is Epic 7 work, so this epic builds only the block and the notification.
- **Three export gates, all naming the offenders:** any Team's post-auction salary above $165,000,000; any Team's Roster Count other than exactly 12 (below leaves a hole, above breaches the ceiling); any Auction Contract still lacking a length.
- **Two separate downloads.** A contracts export (Auction Contracts only) and a full post-auction roster export (Existing plus Auction Contracts), because Fantrax's commissioner import may accept them by different paths. They must reconcile: every Auction Contract appears in both at the same amount and the same Slot Placement, asserted by an automated test over a full synthetic auction.
- **Free Agents not won get no export treatment at all** — they simply remain free agents in Fantrax. Do not build an unwon-players export.
- **Existing Contracts are reproduced exactly as imported**, unless a Commissioner override changed them, in which case the current value exports and the override stays traceable in the Audit Log.
- **Export is repeatable:** re-downloadable any number of times, written to the Audit Log each time. Exporting never writes to Fantrax; the screen must say so plainly, because upload is a manual Commissioner step.
- **Archived is genuinely read-only.** No Bids, Nominations, assignments or overrides are accepted — by UI and by direct request alike — while the Bid Board, Teams, Audit Log and re-downloadable export stay viewable indefinitely.
- **Archive reachability must be decided and recorded**, not assumed: the hosting free tier pauses a project after roughly a week idle and this app sleeps about eleven months. Pick a paid month, a static export of final state, or accepted manual resume, and document it beside the outage recovery procedure.
- **Success here is measurable:** the auction is meant to complete with no manual intervention — assignment finishes and the export succeeds first try with no cap or roster violations.

## Technical Decisions

- **Allotment rules are pure core; the assignment surface is shell.** Time enters as an injected `now` sourced from the database server clock, never a client clock.
- **Assignments, phase transitions and each export are appended events** on the insert-only log, carrying the standard envelope plus acting Manager and Team. Corrections append; nothing is updated or deleted. Archived is a fold of a phase-transition event, not a mutable flag.
- **Winning amount and Cap Hit are distinct persisted fields**, and both exports emit both. A Minor League placement resolves to a $0 Cap Hit while the winning amount stands. No code path may derive one from the other by assuming equality — conflating them breaks the cap arithmetic and the Fantrax round-trip together.
- **The app records amount and length only.** Multi-year cap escalation is explicitly out of scope and belongs to Fantrax; compute no future-year figures.
- **All Fantrax knowledge lives in one adapter module.** CSV column names, header shapes and format quirks appear there and nowhere else, so a between-offseason format change is a config edit rather than a rewrite. Rows join on the **stable Fantrax player and team IDs carried unchanged from import**, never on name; internal surrogate keys never reach a CSV cell.
- **Exports emit exact integer dollars.** The abbreviated `$14.5M` renderer is a view concern — correct in the UI and in Discord, forbidden in a CSV. Assert by automated test that it is structurally unreachable from the export path.
- **Phase and role resolve server-side per request into one destination list.** A destination not live in the current phase is not rendered *and* its route refuses server-side; hiding UI is never the check. That is how Archived read-onlyness is actually enforced.
- **Naming rule, absolute:** a three-letter capitalised abbreviation always means a player's real-life NBA team; a fantasy Team is always spelled out with its acting Manager (`Lakers — Meakel`). Holds in both exports as it does everywhere else.
- **League constants — the $165M cap, the allotment counts, the roster bounds — are named values in the core constants module.** No admin UI edits them.

## UX & Interaction Patterns

- **Voice: sincere, quietly institutional, never alarmed.** No exclamation marks anywhere, no urgency framing on a deadline, no suggested action. The app states facts.
- **Mobile-first at 375px.** Manager assignment is single-column and fully operable one-handed. Commissioner surfaces — assignment monitoring, export review — become genuinely multi-column tables on desktop but must stay operable at 375px; the Commissioner may be anywhere when he needs them.
- **The phase visibly changes the app.** On entering Contract Assignment the Bid Board freezes and stays readable, the Contract Assignment destination appears, and the persistent strip reports assignment progress rather than Maximum Bid. The transition is announced, not merely reflected by controls quietly ceasing to work.
- **The Teams index changes shape by phase.** In Contract Assignment, slot columns lose their information value (every Team reads 12 of 12 by definition) and are replaced by remaining Year Allotment — 4-year, 3-year and both 2-year shown used or unused — plus assignment completion. Cap columns stay and now describe settled contracts. Archived freezes exactly that state, read-only.
- **On-screen money is abbreviated everywhere**, the export review screen included, at exactly one decimal, with no long-form fallback and no "tap for exact figure."
- **Every surface in this epic is spec-only — no mockup exists** for Contract Assignment, assignment monitoring, export or archive, so drift risk is high. Say so if one turns out to need a visual reference before it is built.
- **Vocabulary is fixed.** Year Allotment, Auction Contract, Existing Contract, Roster Count, Cap Space and Slot Placement appear with exactly their defined meanings. A friendlier synonym in UI copy is a defect.

## Cross-Story Dependencies

- **Strictly sequential in spirit:** 6.1 produces the assignments that 6.2 monitors, 6.3 gates on, 6.4 reconciles against, and 6.5 freezes.
- **Depends on Epic 3** for the League Clock expiry that ends the Auction Phase and moves the league into Contract Assignment, and on its tick, which is where the assignment deadline and the Commissioner-configurable reminder interval are evaluated.
- **Depends on Epic 5's notification path.** Reminders to Managers with unassigned Players, deadline notices, and the Contract Assignment Phase opening notice all go through the existing outbox and Discord mention path — no new transport, no new schedule.
- **Depends on Epic 1** for the import that supplied the stable Fantrax IDs, the Existing Contracts that 6.4 reproduces, and the append-only write path; and on Epic 3's close, which set winning amount and Cap Hit as distinct fields.
- **Depends on Epic 4's Teams index and Bid Board**, which gain their Contract Assignment and Archived shapes here.
- **Hands off to Epic 7.** The Commissioner assigning lengths on an unresponsive Team's behalf is delivered there; until it exists, an unassigned Team simply blocks the export, which is correct behaviour on its own. Epic 7's overrides must also refuse once archived.
- **Epic 8's rehearsal and restore work** shares the archive-reachability decision recorded in 6.5.
