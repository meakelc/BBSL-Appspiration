/**
 * The League Clock's origin, folded from the log (Story 1.11).
 *
 * The League Clock is 48 hours long (`LEAGUE_CLOCK`, `core/constants.ts`) and
 * its expiry ends the Auction Phase (PRD §3). This reducer answers only where
 * it STARTED: the `AuctionOpened` event's own `occurredAt`, which is the
 * database's transaction-start clock as the shell read it once (AD-3). The
 * core never learns what time it is — the shell adds `LEAGUE_CLOCK` to this
 * origin when it needs an absolute expiry.
 *
 * **An origin is not a reset.** AD-22 names `AuctionOpened` as the League
 * Clock's origin and fixes the reset set at exactly two event types; this
 * reducer does not widen that set and deliberately has no case for either.
 * A reset can be unwound by a compensating `BidVoided`, whereas the open can
 * never be unwound, so the origin is folded separately rather than being
 * added as a third reset. Nomination and Bid resets are Epic 2's work and
 * their absence here is a decision, not an omission.
 *
 * **The first open wins.** `AuctionOpened` can only be appended once in
 * practice — the gate refuses when the phase has already folded to Auction —
 * but a reducer must be total over any log it is handed, and "the origin is
 * the first open" is the only answer that cannot move an already-running
 * clock forward.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import type { Reducer } from './fold.ts';
import { AUCTION_OPENED_EVENT } from './phase.ts';

/**
 * Where the League Clock starts.
 *
 * `origin` is the ISO-8601 instant of the `AuctionOpened` event, or `null`
 * while the auction has not opened — which is a state, not a failure: there
 * is no League Clock during Setup.
 */
export type LeagueClock = {
	readonly origin: string | null;
};

/** With no `AuctionOpened` event, the League Clock has not started. */
export const INITIAL_LEAGUE_CLOCK: LeagueClock = Object.freeze({ origin: null });

/**
 * Fold one event onto the League Clock.
 *
 * The `default: return state` discipline is `phase.ts`'s, for the same
 * reason. Folding the same events twice converges: a second `AuctionOpened`
 * leaves the already-set origin alone.
 */
export const leagueClockReducer: Reducer<LeagueClock> = (state, event) => {
	switch (event.type) {
		case AUCTION_OPENED_EVENT: {
			if (state.origin !== null) return state;
			return { origin: event.occurredAt };
		}
		default:
			return state;
	}
};
