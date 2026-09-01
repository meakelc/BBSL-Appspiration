/**
 * The pure League phase reducer (AD-5).
 *
 * `resolveLeaguePhase` (`server/phase.ts`) folds this over the entire
 * `auction_events` log via `fold()` — with no events, that fold never calls
 * the reducer at all and simply returns `INITIAL_PHASE` unchanged, which is
 * how "no events yet folds to Setup" holds without a special case anywhere.
 *
 * Its `switch` has exactly two cases. `AuctionOpened`, added by Story 1.11,
 * folds the phase to Auction; `ContractAssignmentOpened`, added by Story 3.7,
 * folds it to Contract Assignment when the League Clock has run out. Every
 * other event type falls through to `default` and returns `state` unchanged.
 * The second case is the extension this file's own header anticipated, and it
 * arrived exactly as predicted: the reducer's shape did not change, only the
 * number of `case`s. `LeagueArchived` is the one still outstanding.
 *
 * **The phase ends by falling out of the log, and nothing sets a flag.** No
 * column records the phase, nothing toggles, and the tick appends an event
 * rather than performing a transition — which is why evaluating the League
 * Clock twice is a no-op, and why a restart-safe tick is safe by construction
 * rather than by a guard.
 *
 * Every transition is one-way and none has an inverse: there is no case that
 * returns the phase to Setup, and none that returns it to Auction, because
 * AD-4 forbids deleting an event and no compensating event for either
 * transition exists or is intended. That is the whole of why bidding stops
 * league-wide the moment `ContractAssignmentOpened` is folded — the ninth
 * `PLACE_BID_GATES` gate reads this value and nothing else.
 *
 * `LeaguePhase` is declared again here, structurally identical to
 * `server/phase.ts`'s type of the same name, rather than imported from it.
 * The core takes no import from outside itself (AD-2: relative `.ts` imports
 * only, nothing that would fail to resolve under Deno) — the same reason a
 * `.svelte` file duplicates `Destination` rather than importing a
 * server-only module. TypeScript treats the two declarations as the same
 * type as long as their literal sets agree.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import type { Reducer } from './fold.ts';

/** The four phases, verbatim from the glossary. A synonym is a defect. */
export type LeaguePhase = 'Setup' | 'Auction' | 'Contract Assignment' | 'Archived';

/** With no events appended, the League is in Setup. */
export const INITIAL_PHASE: LeaguePhase = 'Setup';

/**
 * The event type that opens the auction. Appended exactly once, by the
 * Commissioner-only gate at `/auction-open` (Story 1.11), and the only thing
 * in the codebase that moves the League out of Setup.
 *
 * Declared here rather than beside the transaction that appends it because
 * this is the reducer that gives it meaning: the phase IS the fold, and no
 * flag is stored anywhere.
 */
export const AUCTION_OPENED_EVENT = 'AuctionOpened';

/**
 * The event type that ends the Auction Phase and opens Contract Assignment
 * (Story 3.7, FR-22, AD-22).
 *
 * Declared here rather than beside the transaction that appends it, for
 * `AUCTION_OPENED_EVENT`'s reason: this is the reducer that gives it meaning.
 * The phase IS this fold, and no flag is stored anywhere.
 *
 * **Appended by the tick, and by nothing else.** `core/rules/phase-end.ts`
 * decides it from the folded League Clock and the injected `now`;
 * `server/phase-end.ts` appends it inside one transaction, LAST, after one
 * `AuctionTerminated` for every nomination still Awaiting an Opening Bid — so
 * no prefix of the log ever reads as Contract Assignment with a Player still
 * on the board holding a Slot.
 *
 * **It is the first genuinely system-originated event in this product**, and
 * its envelope carries a null Manager and a null Team together
 * (`20260901000000_system_actor.sql`). Nobody acted: a clock ran out.
 */
export const CONTRACT_ASSIGNMENT_OPENED_EVENT = 'ContractAssignmentOpened';

/**
 * Fold one event onto the current phase.
 *
 * Both cases fold UNCONDITIONALLY — including onto the phase they already
 * produce, which is idempotent, so replaying the log twice converges. Every
 * other `type` reaches `default` and the phase is returned unchanged, which
 * is the correct behaviour for any event type this reducer has not been
 * taught to recognise, not merely a placeholder.
 *
 * Neither case guards on the state it is folding onto, and that is deliberate
 * rather than an omission. A reducer must be total over any log it is handed,
 * and the ORDER of the log decides the answer: a `ContractAssignmentOpened`
 * after an `AuctionOpened` folds to Contract Assignment because it is later in
 * `seq`, not because a guard said it could. The gates are what make the
 * impossible orders unappendable; this fold only has to state what a log
 * means.
 */
export const phaseReducer: Reducer<LeaguePhase> = (state, event) => {
	switch (event.type) {
		case AUCTION_OPENED_EVENT:
			return 'Auction';
		case CONTRACT_ASSIGNMENT_OPENED_EVENT:
			return 'Contract Assignment';
		default:
			return state;
	}
};
