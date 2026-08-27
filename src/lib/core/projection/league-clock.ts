/**
 * The League Clock's origin and its resets, folded from the log
 * (Stories 1.11, 2.1).
 *
 * The League Clock is 48 hours long (`LEAGUE_CLOCK`, `core/constants.ts`)
 * and its expiry ends the Auction Phase (PRD §3). This reducer answers where
 * it started — the `AuctionOpened` event's own `occurredAt`, which is the
 * database's transaction-start clock as the shell read it once (AD-3) — and
 * where it was last reset. The core never learns what time it *is*:
 * `leagueClockExpiry` below is arithmetic on instants the log already
 * carries, and comparing its answer to the present is the shell's job.
 *
 * **An origin is not a reset.** AD-22 names `AuctionOpened` as the League
 * Clock's origin and fixes the reset set at exactly two event types. Story
 * 2.1 adds the first of them, `NominationPlaced`; `BidPlaced` is Story 2.2's
 * and its absence here is a decision, not an omission. The set is not
 * widened past those two, and a reset stays distinguishable from the origin
 * because a reset can be unwound by a compensating `BidVoided` while the
 * open can never be unwound.
 *
 * **Two fields, not one.** AD-22's amended third bullet fixes expiry at
 * `LEAGUE_CLOCK` after the *later* of the origin and the latest surviving
 * reset. A single field would let a void recompute the clock back past the
 * open, which the AD forbids — so `origin` and `lastReset` are folded
 * separately and `leagueClockExpiry` takes the later of the two.
 * `lastReset` stays `null` until the auction's first nomination.
 *
 * **The first open wins; the last reset wins.** `AuctionOpened` can only be
 * appended once in practice — the gate refuses when the phase has already
 * folded to Auction — but a reducer must be total over any log it is handed,
 * and "the origin is the first open" is the only answer that cannot move an
 * already-running clock forward. A reset is the opposite: the whole point of
 * one is to move the clock forward, so the latest reset in `seq` order is
 * the one that holds. Both rules make a double replay converge.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2). That
 * is why the instant arithmetic this file needs is written out by hand
 * rather than handed to `Date`: `Date` is a forbidden reference in the core
 * (`scripts/check-core-purity.js`) precisely because `Date.now()` and
 * `new Date()` are indistinguishable from `Date.parse` to a static walk, and
 * a core that could reach one could reach the others.
 *
 * That arithmetic used to live at the bottom of this file. Story 2.4
 * extracted it to `core/instant.ts` — the extraction Story 2.3's deferred
 * note called for — and this module imports it from there. One
 * implementation, not two copies free to drift: a fix to the calendar math
 * now reaches the League Clock and the relative phrase alike.
 */

import { LEAGUE_CLOCK } from '../constants.ts';
import { formatInstant, parseInstant } from '../instant.ts';
import type { Reducer } from './fold.ts';
import { NOMINATION_PLACED_EVENT } from './nominations.ts';
import { AUCTION_OPENED_EVENT } from './phase.ts';

/**
 * Where the League Clock starts, and when it was last restarted.
 *
 * `origin` is the ISO-8601 instant of the `AuctionOpened` event, or `null`
 * while the auction has not opened — which is a state, not a failure: there
 * is no League Clock during Setup.
 *
 * `lastReset` is the ISO-8601 instant of the latest event in AD-22's reset
 * set, or `null` when nothing has reset it since the open. It is never
 * conflated with `origin`: an auction that has opened and seen no nomination
 * has an origin and no reset, and those are different facts.
 */
export type LeagueClock = {
	readonly origin: string | null;
	readonly lastReset: string | null;
};

/** With no `AuctionOpened` event, the League Clock has not started. */
export const INITIAL_LEAGUE_CLOCK: LeagueClock = Object.freeze({
	origin: null,
	lastReset: null
});

/**
 * Fold one event onto the League Clock.
 *
 * The `default: return state` discipline is `phase.ts`'s, for the same
 * reason. Folding the same events twice converges: a second `AuctionOpened`
 * leaves the already-set origin alone, and re-folding the same
 * `NominationPlaced` sets `lastReset` to the value it already held.
 *
 * A `NominationPlaced` appended before any open — unreachable through the
 * gate, which refuses outside the Auction Phase — still records its reset.
 * `leagueClockExpiry` returns `null` without an origin, so a stray reset can
 * never manufacture a clock that never started.
 */
export const leagueClockReducer: Reducer<LeagueClock> = (state, event) => {
	switch (event.type) {
		case AUCTION_OPENED_EVENT: {
			if (state.origin !== null) return state;
			return { ...state, origin: event.occurredAt };
		}
		case NOMINATION_PLACED_EVENT: {
			// The latest reset in `seq` order wins. `fold()` orders by `seq`
			// (AD-5), so "latest" is simply "the last one folded" — never a
			// timestamp comparison, which would be wrong under the global lock
			// where a later commit can hold an earlier `occurred_at`.
			return { ...state, lastReset: event.occurredAt };
		}
		default:
			return state;
	}
};

/**
 * When the League Clock expires, as an ISO-8601 instant, or `null` while the
 * auction has not opened.
 *
 * `LEAGUE_CLOCK` after the LATER of the origin and the latest surviving
 * reset — AD-22's amended third bullet, stated once, here, so the sweep, the
 * surface and the tests cannot each compute a different expiry.
 *
 * Taking the later of the two rather than "the reset if there is one" is
 * what stops a compensating void from recomputing the clock back past the
 * open.
 *
 * Total over any state the reducer can produce, but the two instants are
 * NOT treated alike, and the asymmetry is deliberate. An unparseable
 * `origin` returns `null`: the origin is what establishes that a League
 * Clock exists at all, so without a readable one there is no expiry to
 * state, and inventing a start would be worse than admitting none. An
 * unparseable `lastReset` is skipped and the expiry falls back to the
 * origin: a reset only ever moves the expiry LATER, so discarding an
 * unreadable one yields the earlier, more conservative deadline — it can
 * close an auction sooner than the log intended, never later than it
 * allowed. Neither case throws, and nothing here asks what time it is now:
 * every input is an instant the log already carries.
 */
export function leagueClockExpiry(clock: LeagueClock): string | null {
	if (clock.origin === null) return null;
	const origin = parseInstant(clock.origin);
	if (origin === null) return null;

	let from = origin;
	if (clock.lastReset !== null) {
		const reset = parseInstant(clock.lastReset);
		if (reset !== null && reset > from) from = reset;
	}

	return formatInstant(from + LEAGUE_CLOCK);
}
