/**
 * The League Clock fold: resets by `seq`, the `BidVoided` non-reset, and the
 * derivation that walks backwards without ever passing the origin (Story 3.7,
 * AD-22).
 *
 * **What is NOT here, and where it is instead.** The origin's own rules, the
 * two reset cases, the every-other-event-type default and the calendar
 * arithmetic are all proven in `tests/core/auction-open.test.ts`, where Stories
 * 1.11, 2.1, 2.5, 3.3 and 3.4 each added their own. This file is Story 3.7's
 * half: what the state shape now carries, what a void does to it, and how
 * `leagueClockExpiry` reads the pair.
 *
 * Calls the core directly against state literals and folded logs — no
 * database, no HTTP, no clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { LEAGUE_CLOCK } from '../../src/lib/core/constants.ts';
import { BID_PLACED_EVENT } from '../../src/lib/core/projection/auctions.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	BID_VOIDED_EVENT,
	INITIAL_LEAGUE_CLOCK,
	leagueClockExpiry,
	leagueClockReducer,
	readVoidedSeq
} from '../../src/lib/core/projection/league-clock.ts';
import type { LeagueClock } from '../../src/lib/core/projection/league-clock.ts';
import { NOMINATION_PLACED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { AUCTION_OPENED_EVENT } from '../../src/lib/core/projection/phase.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';

/** One event, as the shell would hand it to a fold. */
function event(seq: number, type: string, occurredAt: string, payload: unknown = {}): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt,
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload,
		managerId: 'm-1',
		teamId: 't-1',
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

/** The open, 09:00 Monday. */
const OPENED_AT = '2026-08-24T09:00:00.000Z';

// --- the state shape --------------------------------------------------------

describe('LeagueClock — the shape a void needs (Story 3.7)', () => {
	it('starts with no origin, no resets and nothing voided', () => {
		expect(INITIAL_LEAGUE_CLOCK).toEqual({ origin: null, resets: [], voidedSeqs: [] });
	});

	it('records each reset WITH the seq a void names it by, in fold order', () => {
		const clock = fold(
			INITIAL_LEAGUE_CLOCK,
			[
				event(1, AUCTION_OPENED_EVENT, OPENED_AT),
				event(4, NOMINATION_PLACED_EVENT, '2026-08-24T09:00:00.000Z'),
				event(7, BID_PLACED_EVENT, '2026-08-24T15:00:00.000Z')
			],
			leagueClockReducer
		);

		expect(clock.origin).toBe(OPENED_AT);
		expect(clock.resets).toEqual([
			{ seq: '4', occurredAt: '2026-08-24T09:00:00.000Z' },
			{ seq: '7', occurredAt: '2026-08-24T15:00:00.000Z' }
		]);
		expect(clock.voidedSeqs).toEqual([]);
	});

	it('keeps two resets that share an instant apart, because the seq differs', () => {
		// Under the global lock two events can carry the identical
		// `occurred_at`. A state keyed on the instant would collapse them and a
		// void naming one would silently withdraw both.
		const clock = fold(
			INITIAL_LEAGUE_CLOCK,
			[
				event(1, AUCTION_OPENED_EVENT, OPENED_AT),
				event(2, BID_PLACED_EVENT, '2026-08-24T15:00:00.000Z'),
				event(3, BID_PLACED_EVENT, '2026-08-24T15:00:00.000Z')
			],
			leagueClockReducer
		);

		expect(clock.resets.map((reset) => reset.seq)).toEqual(['2', '3']);
	});

	it('converges on a double replay — resets and voids alike', () => {
		const log = [
			event(1, AUCTION_OPENED_EVENT, OPENED_AT),
			event(2, NOMINATION_PLACED_EVENT, '2026-08-24T09:00:00.000Z'),
			event(3, BID_PLACED_EVENT, '2026-08-24T15:00:00.000Z'),
			event(4, BID_VOIDED_EVENT, '2026-08-24T18:00:00.000Z', { voidedSeq: '3' })
		];
		const once = fold(INITIAL_LEAGUE_CLOCK, log, leagueClockReducer);

		// The lists do not double, because every case is idempotent on the
		// `seq` its own event carries.
		expect(fold(once, log, leagueClockReducer)).toEqual(once);
		expect(once.resets).toHaveLength(2);
		expect(once.voidedSeqs).toEqual(['3']);
	});
});

// --- the BidVoided case -----------------------------------------------------

describe('leagueClockReducer — BidVoided is a NON-reset (AD-22)', () => {
	it('records the voided seq and touches no reset', () => {
		const before = fold(
			INITIAL_LEAGUE_CLOCK,
			[event(1, AUCTION_OPENED_EVENT, OPENED_AT), event(2, BID_PLACED_EVENT, '2026-08-24T15:00:00.000Z')],
			leagueClockReducer
		);
		const after = fold(
			before,
			[event(3, BID_VOIDED_EVENT, '2026-08-24T18:00:00.000Z', { voidedSeq: '2' })],
			leagueClockReducer
		);

		// The Bid is still folded. A void withdraws a reset; it does not delete
		// an event, and AD-4 forbids anything that would.
		expect(after.resets).toEqual(before.resets);
		expect(after.origin).toBe(before.origin);
		expect(after.voidedSeqs).toEqual(['2']);
	});

	it('never appends a reset of its own, even at a later instant', () => {
		const clock = fold(
			INITIAL_LEAGUE_CLOCK,
			[
				event(1, AUCTION_OPENED_EVENT, OPENED_AT),
				event(2, BID_PLACED_EVENT, '2026-08-24T15:00:00.000Z'),
				// Three hours after the Bid. If a void reset the clock, the
				// expiry would move FORWARD to 18:00 Wednesday — the opposite of
				// what a compensation means.
				event(3, BID_VOIDED_EVENT, '2026-08-24T18:00:00.000Z', { voidedSeq: '2' })
			],
			leagueClockReducer
		);

		expect(clock.resets).toHaveLength(1);
		expect(leagueClockExpiry(clock)).toBe('2026-08-26T09:00:00.000Z');
	});

	it('behaves identically when the void is folded BEFORE the Bid it names', () => {
		// Membership rather than position: `fold()` orders by `seq`, but the
		// reducer must be total over any log it is handed, and a hand-written
		// or repaired log can carry a void at a lower `seq` than its Bid.
		const voidFirst = fold(
			INITIAL_LEAGUE_CLOCK,
			[
				event(1, AUCTION_OPENED_EVENT, OPENED_AT),
				event(2, BID_VOIDED_EVENT, '2026-08-24T18:00:00.000Z', { voidedSeq: '4' }),
				event(3, NOMINATION_PLACED_EVENT, '2026-08-24T09:00:00.000Z'),
				event(4, BID_PLACED_EVENT, '2026-08-24T15:00:00.000Z')
			],
			leagueClockReducer
		);

		expect(voidFirst.voidedSeqs).toEqual(['4']);
		// Seq 4 is skipped, so the nomination at seq 3 is the latest survivor.
		expect(leagueClockExpiry(voidFirst)).toBe('2026-08-26T09:00:00.000Z');
	});

	it('is harmless when it names a seq no event in this log carries', () => {
		const clock = fold(
			INITIAL_LEAGUE_CLOCK,
			[
				event(1, AUCTION_OPENED_EVENT, OPENED_AT),
				event(2, BID_PLACED_EVENT, '2026-08-24T15:00:00.000Z'),
				event(3, BID_VOIDED_EVENT, '2026-08-24T18:00:00.000Z', { voidedSeq: '999' })
			],
			leagueClockReducer
		);

		expect(clock.voidedSeqs).toEqual(['999']);
		// It matches no reset, so it changes no answer.
		expect(leagueClockExpiry(clock)).toBe('2026-08-26T15:00:00.000Z');
	});

	it.each([
		['a payload that is not an object at all', 'nonsense'],
		['a null payload', null],
		['a payload with no voidedSeq', { fantraxPlayerId: 'p-1' }],
		['a voidedSeq that is a number rather than the log’s string', { voidedSeq: 2 }],
		['an empty voidedSeq', { voidedSeq: '' }]
	])('skips %s, leaving the clock untouched and throwing nothing', (_label, payload: unknown) => {
		const before = fold(
			INITIAL_LEAGUE_CLOCK,
			[event(1, AUCTION_OPENED_EVENT, OPENED_AT), event(2, BID_PLACED_EVENT, '2026-08-24T15:00:00.000Z')],
			leagueClockReducer
		);
		const after = fold(before, [event(3, BID_VOIDED_EVENT, '2026-08-24T18:00:00.000Z', payload)], leagueClockReducer);

		expect(after).toEqual(before);
		expect(leagueClockExpiry(after)).toBe('2026-08-26T15:00:00.000Z');
	});

	it('reads the seq through one exported reader, so the fold cannot diverge from it', () => {
		expect(readVoidedSeq({ voidedSeq: '7' })).toBe('7');
		expect(readVoidedSeq({ voidedSeq: 7 })).toBeNull();
		expect(readVoidedSeq(null)).toBeNull();
		expect(readVoidedSeq(undefined)).toBeNull();
	});
});

// --- the derivation ---------------------------------------------------------

describe('leagueClockExpiry — the latest SURVIVING reset, never past the origin', () => {
	/** A clock literal, so the walk can be driven past states no log produces. */
	function clockOf(
		origin: string | null,
		resets: ReadonlyArray<readonly [seq: string, at: string]>,
		voidedSeqs: readonly string[] = []
	): LeagueClock {
		return {
			origin,
			resets: resets.map(([seq, occurredAt]) => ({ seq, occurredAt })),
			voidedSeqs
		};
	}

	it('walks back past a voided reset to the previous survivor', () => {
		const clock = clockOf(
			OPENED_AT,
			[
				['4', '2026-08-24T09:00:00.000Z'],
				['7', '2026-08-24T15:00:00.000Z']
			],
			['7']
		);

		expect(leagueClockExpiry(clock)).toBe('2026-08-26T09:00:00.000Z');
	});

	it('walks back past SEVERAL voided resets in one derivation', () => {
		const clock = clockOf(
			OPENED_AT,
			[
				['4', '2026-08-24T10:00:00.000Z'],
				['7', '2026-08-24T15:00:00.000Z'],
				['9', '2026-08-24T20:00:00.000Z']
			],
			['7', '9']
		);

		expect(leagueClockExpiry(clock)).toBe('2026-08-26T10:00:00.000Z');
	});

	it('falls back to the ORIGIN when every reset is voided, never earlier', () => {
		// The AD's floor: a void can shorten the clock, and it can shorten it
		// all the way back to the open, and it can never shorten it past that.
		const clock = clockOf(OPENED_AT, [['4', '2026-08-24T15:00:00.000Z']], ['4']);

		expect(leagueClockExpiry(clock)).toBe('2026-08-26T09:00:00.000Z');
		// Which is exactly the answer for an auction that has seen nothing.
		expect(leagueClockExpiry(clockOf(OPENED_AT, []))).toBe('2026-08-26T09:00:00.000Z');
	});

	it('never falls below the origin even for a surviving reset that predates it', () => {
		// Unreachable through the gates, which run only inside the Auction
		// Phase — but a reducer is total over any log, and `later of` is what
		// makes the floor structural rather than incidental.
		const clock = clockOf('2026-08-24T19:00:00.000Z', [['4', '2026-08-24T08:00:00.000Z']]);

		expect(leagueClockExpiry(clock)).toBe('2026-08-26T19:00:00.000Z');
	});

	it('walks PAST an unreadable reset to the one before it, rather than to the origin', () => {
		// The conservative direction, and the difference is real: falling
		// straight to the origin would discard the 10:00 reset the log plainly
		// carries, ending the phase six hours early.
		const clock = clockOf(OPENED_AT, [
			['4', '2026-08-24T10:00:00.000Z'],
			['7', 'nonsense']
		]);

		expect(leagueClockExpiry(clock)).toBe('2026-08-26T10:00:00.000Z');
	});

	it('is null with no origin, however many resets there are', () => {
		expect(leagueClockExpiry(clockOf(null, [['4', '2026-08-24T15:00:00.000Z']]))).toBeNull();
	});

	it('is null for an origin that cannot be read, rather than inventing a start', () => {
		expect(leagueClockExpiry(clockOf('yesterday', [['4', '2026-08-24T15:00:00.000Z']]))).toBeNull();
	});

	it('is LEAGUE_CLOCK after the survivor, checked against Date the core may not use', () => {
		const survivor = '2026-08-24T15:00:00.000Z';
		const clock = clockOf(OPENED_AT, [
			['4', '2026-08-24T10:00:00.000Z'],
			['7', survivor]
		]);

		expect(leagueClockExpiry(clock)).toBe(
			new Date(Date.parse(survivor) + LEAGUE_CLOCK).toISOString()
		);
	});

	it('is a pure function of the state it is handed', () => {
		const clock = clockOf(OPENED_AT, [['4', '2026-08-24T15:00:00.000Z']], ['9']);
		expect(leagueClockExpiry(clock)).toBe(leagueClockExpiry(clock));
	});
});
