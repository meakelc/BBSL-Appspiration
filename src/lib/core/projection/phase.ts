/**
 * The pure League phase reducer (AD-5).
 *
 * `resolveLeaguePhase` (`server/phase.ts`) folds this over the entire
 * `auction_events` log via `fold()` — with no events, that fold never calls
 * the reducer at all and simply returns `INITIAL_PHASE` unchanged, which is
 * how "no events yet folds to Setup" holds without a special case anywhere.
 *
 * Its `switch` has exactly one case: `AuctionOpened`, added by Story 1.11,
 * which folds the phase to Auction. Every other event type falls through to
 * `default` and returns `state` unchanged. That is the extension point later
 * phase-transition events (`ContractAssignmentOpened`, `LeagueArchived`) fill
 * in — the reducer's shape does not change when they do, only the number of
 * `case`s in this `switch`.
 *
 * The transition is one-way and has no un-open: there is no case that returns
 * the phase to Setup, because AD-4 forbids deleting an event and no
 * compensating event for the open exists or is intended.
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
 * Fold one event onto the current phase.
 *
 * `AuctionOpened` folds to Auction unconditionally — including from Auction
 * itself, which is idempotent, so replaying the log twice converges. Every
 * other `type` reaches `default` and the phase is returned unchanged, which
 * is the correct behaviour for any event type this reducer has not been
 * taught to recognise, not merely a placeholder.
 */
export const phaseReducer: Reducer<LeaguePhase> = (state, event) => {
	switch (event.type) {
		case AUCTION_OPENED_EVENT:
			return 'Auction';
		default:
			return state;
	}
};
