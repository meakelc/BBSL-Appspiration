/**
 * The pure League phase reducer (AD-5).
 *
 * `resolveLeaguePhase` (`server/phase.ts`) folds this over the entire
 * `auction_events` log via `fold()` — with no events, that fold never calls
 * the reducer at all and simply returns `INITIAL_PHASE` unchanged, which is
 * how "no events yet folds to Setup" holds without a special case anywhere.
 *
 * Its `switch` has no real case yet: every event type falls through to
 * `default` and returns `state` unchanged. This is the exact extension point
 * Story 1.11's `AuctionOpened` (and later phase-transition events) fill in —
 * the reducer's shape does not change when they do, only the number of
 * `case`s in this `switch`.
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
 * Fold one event onto the current phase.
 *
 * No domain event type exists yet that changes the phase, so every `type`
 * reaches `default` and the phase is returned unchanged — true today, and
 * the correct behaviour for any event type this reducer has not been taught
 * to recognise, not merely a placeholder.
 */
export const phaseReducer: Reducer<LeaguePhase> = (state, event) => {
	switch (event.type) {
		default:
			return state;
	}
};
