/**
 * The League Clock's origin and its resets, folded from the log
 * (Stories 1.11, 2.1, 2.5).
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
 * 2.1 added the first of them, `NominationPlaced`; Story 2.5 adds the second
 * and last, `BidPlaced`, and the set is now complete. (An earlier revision of
 * this header attributed `BidPlaced` to Story 2.2 — that was stale: 2.2 built
 * nomination refusals and concurrency and appended no Bid.) The set is not
 * widened past those two, and a reset stays distinguishable from the origin
 * because a reset can be unwound by a compensating `BidVoided` while the
 * open can never be unwound.
 *
 * **Exactly two, and no more.** Every other event type — an Auction close, a
 * randomizer draw, a contention dissolution, a bid void, an override, a
 * pause or resume — reaches `default` and leaves the clock alone, which is
 * AD-22's "new event types default to not resetting it" holding by
 * construction rather than by review. §10 example 13 is the case: an Auction
 * closing at 12:00 Saturday does not reset the League Clock.
 *
 * **Two fields, not one.** AD-22's amended third bullet fixes expiry at
 * `LEAGUE_CLOCK` after the *later* of the origin and the latest surviving
 * reset. A single field would let a void recompute the clock back past the
 * open, which the AD forbids — so the origin and the resets are folded
 * separately and `leagueClockExpiry` takes the later of the two.
 *
 * **The word doing the work in that bullet is SURVIVING** (Story 3.7). A
 * `BidVoided` names an earlier `BidPlaced` and withdraws it, and AD-22 warns
 * in as many words that a compensating void must not leave the clock counting
 * from a reset the league has taken back. A state holding only the LATEST
 * reset instant cannot honour that: `fold()` is one forward pass in `seq`
 * order (AD-5), so by the time the void is folded the instant it would have to
 * fall back to is already gone. So the state keeps the resets it has seen —
 * each with the `seq` a void can name it by — and, separately, the `seq`s that
 * have been voided; `leagueClockExpiry` walks that list backwards and takes
 * the latest survivor. `resets` is empty until the auction's first nomination,
 * and `voidedSeqs` is empty for every log that carries no void, which is every
 * log this codebase can currently produce (Story 7.2 owns the void).
 *
 * **A void is a non-reset, never a deletion.** The `BidPlaced` it names is
 * still in the log and is still folded by every other reducer (AD-4): the
 * Auction still records the Bid, and only the CLOCK stops counting from it.
 * Membership rather than position is what makes that order-independent — a
 * void folded before the Bid it names behaves identically, and a double replay
 * converges either way.
 *
 * **Recomputation is prospective only.** The expiry is a derivation over the
 * log as it now stands, compared against `now` at the next evaluation.
 * Nothing already accepted is reconsidered because of it, and nothing here
 * knows what has been accepted.
 *
 * **The first open wins; the last surviving reset wins.** `AuctionOpened` can only be
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
import { BID_PLACED_EVENT } from './auctions.ts';
import type { Reducer } from './fold.ts';
import { NOMINATION_PLACED_EVENT } from './nominations.ts';
import { AUCTION_OPENED_EVENT } from './phase.ts';

/**
 * The event type that withdraws an accepted Bid (Epic 7, Story 7.2).
 *
 * Declared HERE, beside the reducer that gives it meaning, for
 * `NOMINATION_PLACED_EVENT`'s reason and `CONTENTION_DRAWN_EVENT`'s
 * precedent (`projection/draws.ts`). What a void MEANS in this codebase is
 * exactly "that reset no longer counts" — the League Clock is the one fold
 * that changes because of one — so the name and the case that reads it can
 * never become two literals free to drift apart.
 *
 * **Nothing in this codebase appends one.** Story 7.2 owns the Commissioner's
 * void; Story 3.7 taught the fold to survive one and proved it against a
 * state literal, because AD-22 names the compensating void as the reason a
 * reset is distinguishable from the origin at all. A fold that first met a
 * void on the day one was appended would be discovering this rule under
 * pressure.
 */
export const BID_VOIDED_EVENT = 'BidVoided';

/**
 * One reset, as the fold recorded it: which event it was, and when.
 *
 * `seq` is the string the log carries (see `AppendedEvent`), kept so a
 * `BidVoided` can name this reset and so two resets sharing an instant stay
 * distinct. It is never parsed to a number here and never compared as one:
 * position in this list IS `seq` order, because `fold()` sorts by `seq` via
 * `BigInt` before it reduces (AD-5).
 */
export type LeagueClockReset = {
	readonly seq: string;
	readonly occurredAt: string;
};

/**
 * Where the League Clock starts, which events have reset it, and which of
 * those resets have been withdrawn.
 *
 * `origin` is the ISO-8601 instant of the `AuctionOpened` event, or `null`
 * while the auction has not opened — which is a state, not a failure: there
 * is no League Clock during Setup.
 *
 * `resets` is every event in AD-22's two-member reset set that this fold has
 * seen, in fold order, which is `seq` order. It is a LIST rather than a
 * single instant because a `BidVoided` arrives after the Bid it names and the
 * expiry must then fall back to the previous survivor — a value a
 * last-write-wins field has already discarded. Empty when nothing has reset
 * the clock since the open, which is never conflated with `origin`: an
 * auction that has opened and seen no nomination has an origin and no resets,
 * and those are different facts.
 *
 * `voidedSeqs` is the set of reset `seq`s a `BidVoided` has withdrawn, held
 * as MEMBERSHIP rather than as a position or a count. That is what makes the
 * fold order-independent: a void folded before the `BidPlaced` it names
 * records the same `seq` and the derivation skips the same reset, so replay
 * converges without an ordering assumption. A `seq` no event in this log
 * carries is harmless — it matches no reset and changes no answer.
 *
 * Neither list is ever pruned. An insert-only log states what happened
 * (AD-4), and a fold that dropped a voided reset from `resets` would make the
 * two lists disagree about how many events it had actually seen.
 */
export type LeagueClock = {
	readonly origin: string | null;
	readonly resets: readonly LeagueClockReset[];
	readonly voidedSeqs: readonly string[];
};

/** With no `AuctionOpened` event, the League Clock has not started. */
export const INITIAL_LEAGUE_CLOCK: LeagueClock = Object.freeze({
	origin: null,
	resets: Object.freeze([]) as readonly LeagueClockReset[],
	voidedSeqs: Object.freeze([]) as readonly string[]
});

/**
 * The `seq` a `BidVoided` withdraws, or `null` when the payload does not name
 * one.
 *
 * `readPayload`'s idiom (`projection/nominations.ts`) for `readPayload`'s
 * reason: `AppendedEvent.payload` is `unknown` — whatever JSON the column
 * holds — and an insert-only log cannot be corrected in place, so a malformed
 * historical row must never crash the fold. A void naming nothing is SKIPPED
 * rather than folded to a nothing-shaped state, and the clock is left exactly
 * as it was: withdrawing an unidentified reset is not a thing a fold can do,
 * and guessing which one was meant would be worse than doing nothing.
 *
 * The `seq` is required to be a non-empty string because that is what
 * `AppendedEvent.seq` is (`core/types.ts`: `pg` returns `int8` as a JS
 * string). A numeric `voidedSeq` is refused rather than coerced — `7` and
 * `"7"` compare unequal against the recorded reset either way, and silently
 * accepting one shape while the log carries the other is how two spellings of
 * the same id come to disagree.
 */
export function readVoidedSeq(payload: unknown): string | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const record = payload as Record<string, unknown>;
	const voidedSeq = record['voidedSeq'];
	if (typeof voidedSeq !== 'string' || voidedSeq === '') return null;
	return voidedSeq;
}

/**
 * Fold one event onto the League Clock.
 *
 * The `default: return state` discipline is `phase.ts`'s, for the same
 * reason. Folding the same events twice converges: a second `AuctionOpened`
 * leaves the already-set origin alone, a re-folded `NominationPlaced` finds
 * its own `seq` already in `resets` and appends nothing, and a re-folded
 * `BidVoided` finds its `seq` already in `voidedSeqs`. Every case is
 * idempotent on the `seq` the event carries, which is what makes a double
 * replay produce the identical state rather than a list twice as long.
 *
 * A `NominationPlaced` or `BidPlaced` appended before any open — unreachable
 * through the gates, which run only inside the Auction Phase — still records
 * its reset. `leagueClockExpiry` returns `null` without an origin, so a stray
 * reset can never manufacture a clock that never started.
 */
export const leagueClockReducer: Reducer<LeagueClock> = (state, event) => {
	switch (event.type) {
		case AUCTION_OPENED_EVENT: {
			if (state.origin !== null) return state;
			return { ...state, origin: event.occurredAt };
		}
		case NOMINATION_PLACED_EVENT:
		case BID_PLACED_EVENT: {
			// Recorded WITH its `seq`, in fold order. `fold()` orders by `seq`
			// (AD-5), so "latest" is simply "the last one in this list" — never
			// a timestamp comparison, which would be wrong under the global
			// lock where a later commit can hold an earlier `occurred_at`.
			//
			// The `seq` is kept rather than only the instant because it is the
			// handle a compensating `BidVoided` names the reset by, and because
			// it is what makes this case idempotent: re-folding the same event
			// finds its own `seq` already here and appends nothing.
			//
			// The two cases share one body deliberately: AD-22 fixes the reset
			// set at exactly these two event types and says nothing that would
			// distinguish them, so writing two identical bodies would invite a
			// divergence the AD does not sanction.
			if (state.resets.some((reset) => reset.seq === event.seq)) return state;
			return {
				...state,
				resets: [...state.resets, { seq: event.seq, occurredAt: event.occurredAt }]
			};
		}
		case BID_VOIDED_EVENT: {
			// **A non-reset.** This case touches `resets` not at all — it
			// neither appends one nor removes one — and records only that a
			// `seq` has been withdrawn. The `BidPlaced` it names is still in the
			// log and is still folded by every other reducer (AD-4); what
			// changes is which reset `leagueClockExpiry` counts from.
			//
			// It does NOT check that the named `seq` is a reset this fold has
			// seen. It may not have been seen YET — a void folded at a lower
			// `seq` than the Bid it names is an order this reducer must survive
			// — and membership is tested at derivation time instead, where both
			// lists are complete.
			const voidedSeq = readVoidedSeq(event.payload);
			if (voidedSeq === null) return state;
			if (state.voidedSeqs.includes(voidedSeq)) return state;
			return { ...state, voidedSeqs: [...state.voidedSeqs, voidedSeq] };
		}
		default:
			return state;
	}
};

/**
 * When the League Clock expires, as an ISO-8601 instant, or `null` while the
 * auction has not opened.
 *
 * `LEAGUE_CLOCK` after the LATER of the origin and the latest SURVIVING
 * reset — AD-22's amended third bullet, stated once, here, so the sweep, the
 * surface and the tests cannot each compute a different expiry.
 *
 * Taking the later of the two rather than "the reset if there is one" is
 * what stops a compensating void from recomputing the clock back past the
 * open. That floor holds however many resets are voided: with every reset
 * withdrawn the derivation is exactly the derivation of a just-opened auction
 * that has seen nothing at all.
 *
 * **The walk is backwards, and it skips two kinds of reset.** `resets` is in
 * `seq` order, so the last entry is the latest; the walk stops at the first
 * entry that is neither voided nor unreadable. A VOIDED reset is skipped
 * because the league withdrew it. An UNREADABLE one is skipped and the walk
 * CONTINUES to the entry before it, which is the conservative direction: a
 * reset only ever moves the expiry later, so discarding one yields the
 * earlier, more cautious deadline — it can end the phase sooner than the log
 * intended, never later than it allowed.
 *
 * Total over any state the reducer can produce, but the origin and the resets
 * are NOT treated alike, and the asymmetry is deliberate. An unparseable
 * `origin` returns `null`: the origin is what establishes that a League Clock
 * exists at all, so without a readable one there is no expiry to state, and
 * inventing a start would be worse than admitting none. Neither case throws,
 * and nothing here asks what time it is now: every input is an instant the
 * log already carries.
 */
export function leagueClockExpiry(clock: LeagueClock): string | null {
	if (clock.origin === null) return null;
	const origin = parseInstant(clock.origin);
	if (origin === null) return null;

	let from = origin;
	for (let index = clock.resets.length - 1; index >= 0; index -= 1) {
		const reset = clock.resets[index];
		if (reset === undefined) continue;
		// Withdrawn by a `BidVoided`. The Bid is still in the log; this reset
		// is simply no longer one the clock counts from.
		if (clock.voidedSeqs.includes(reset.seq)) continue;
		const at = parseInstant(reset.occurredAt);
		// Unreadable — keep walking back rather than falling straight to the
		// origin, so one corrupt row does not discard every reset before it.
		if (at === null) continue;
		// The latest survivor, and the only one that can matter: the walk stops
		// here, and `later of` is what keeps a reset earlier than the open —
		// unreachable through the gates, reachable in a hand-written log — from
		// pulling the expiry back past the origin.
		if (at > from) from = at;
		break;
	}

	return formatInstant(from + LEAGUE_CLOCK);
}
