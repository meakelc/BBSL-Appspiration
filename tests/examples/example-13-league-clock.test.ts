/**
 * PRD §10 example 13 — **A close is not a League Clock reset** (AD-25).
 *
 * > An Auction closing at 12:00 Saturday does not reset a League Clock last
 * > reset at 12:00 Friday. The expiry stays 12:00 Sunday.
 *
 * **The whole example is what the reducer does NOT do**, which is why it is
 * worth a named test rather than a comment. AD-22 fixes the reset set at
 * exactly two event types — a Nomination and an accepted Bid — and says new
 * event types default to not resetting the clock. An `AuctionClosed` reaches
 * `default` and the clock is returned unchanged, so the 48 hours keep running
 * from the Bid on Friday and the phase ends on Sunday whatever closed in
 * between.
 *
 * The failure it forecloses is a real one and it is silent: a league whose
 * closes reset the League Clock would never end its Auction Phase at all,
 * because every close would push the deadline another 48 hours out.
 *
 * Calls the core directly against a folded log — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { AUCTION_CLOCK, LEAGUE_CLOCK } from '../../src/lib/core/constants.ts';
import { BID_PLACED_EVENT } from '../../src/lib/core/projection/auctions.ts';
import { CONTENTION_DISSOLVED_EVENT } from '../../src/lib/core/projection/auctions.ts';
import { CONTENTION_DRAWN_EVENT } from '../../src/lib/core/projection/draws.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	BID_VOIDED_EVENT,
	INITIAL_LEAGUE_CLOCK,
	leagueClockExpiry,
	leagueClockReducer
} from '../../src/lib/core/projection/league-clock.ts';
import {
	AUCTION_CLOSED_EVENT,
	AUCTION_TERMINATED_EVENT,
	NOMINATION_PLACED_EVENT
} from '../../src/lib/core/projection/nominations.ts';
import {
	AUCTION_OPENED_EVENT,
	CONTRACT_ASSIGNMENT_OPENED_EVENT
} from '../../src/lib/core/projection/phase.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';

/** The auction opened on Thursday — the origin, and not a reset. */
const OPENED_AT = '2026-08-27T09:00:00.000Z';

/** 09:00 Friday — the Nomination. */
const NOMINATED_AT = '2026-08-28T09:00:00.000Z';

/** 12:00 Friday — the Bid, and the clock's last reset. */
const BID_AT = '2026-08-28T12:00:00.000Z';

/** 12:00 Saturday — the close, which is `AUCTION_CLOCK` after the Bid. */
const CLOSED_AT = '2026-08-29T12:00:00.000Z';

/** 12:00 Sunday — `LEAGUE_CLOCK` after the Bid, and the answer. */
const EXPIRES_AT = '2026-08-30T12:00:00.000Z';

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

/** The example's log: open, nominate, bid, close. */
const LOG: readonly AppendedEvent[] = [
	event(1, AUCTION_OPENED_EVENT, OPENED_AT),
	event(2, NOMINATION_PLACED_EVENT, NOMINATED_AT, {
		fantraxPlayerId: 'p-1',
		playerName: 'Ausar Bright',
		teamId: 't-n',
		teamName: 'Team N',
		managerId: 'm-n'
	}),
	event(3, BID_PLACED_EVENT, BID_AT, {
		fantraxPlayerId: 'p-1',
		teamId: 't-1',
		teamName: 'Team One',
		managerId: 'm-1',
		amount: 8_000_000,
		closesAt: CLOSED_AT,
		contention: 'standard'
	}),
	event(4, AUCTION_CLOSED_EVENT, CLOSED_AT, {
		fantraxPlayerId: 'p-1',
		playerName: 'Ausar Bright',
		teamId: 't-1',
		teamName: 'Team One',
		managerId: 'm-1',
		winningAmount: 8_000_000,
		capHit: 8_000_000,
		placement: 'active_bench',
		contention: 'standard',
		contractYears: null,
		closedAt: CLOSED_AT
	})
];

describe('§10 example 13 — a close is not a League Clock reset', () => {
	it('leaves the expiry at 12:00 Sunday, 48 hours after the BID', () => {
		const clock = fold(INITIAL_LEAGUE_CLOCK, LOG, leagueClockReducer);

		expect(leagueClockExpiry(clock)).toBe(EXPIRES_AT);
		// Derived rather than written out: the answer is `LEAGUE_CLOCK` after
		// the Bid, and the constant is what says so.
		expect(EXPIRES_AT).toBe(new Date(Date.parse(BID_AT) + LEAGUE_CLOCK).toISOString());
		// And the close is `AUCTION_CLOCK` after the Bid, which is what puts it
		// inside the League Clock's window in the first place.
		expect(CLOSED_AT).toBe(new Date(Date.parse(BID_AT) + AUCTION_CLOCK).toISOString());
	});

	it('records exactly two resets — the Nomination and the Bid, and not the close', () => {
		const clock = fold(INITIAL_LEAGUE_CLOCK, LOG, leagueClockReducer);

		expect(clock.origin).toBe(OPENED_AT);
		expect(clock.resets).toEqual([
			{ seq: '2', occurredAt: NOMINATED_AT },
			{ seq: '3', occurredAt: BID_AT }
		]);
		expect(clock.voidedSeqs).toEqual([]);
	});

	it('gives the identical answer with the close removed, which is the claim', () => {
		// The strongest form of "the close changed nothing": fold the same log
		// without it and compare the states, not merely the expiries.
		const withoutTheClose = fold(INITIAL_LEAGUE_CLOCK, LOG.slice(0, 3), leagueClockReducer);
		const withTheClose = fold(INITIAL_LEAGUE_CLOCK, LOG, leagueClockReducer);

		expect(withTheClose).toEqual(withoutTheClose);
		expect(leagueClockExpiry(withTheClose)).toBe(EXPIRES_AT);
	});

	it('leaves the clock alone for every OTHER event type this codebase appends', () => {
		// AD-22's "new event types default to not resetting it", asserted
		// rather than trusted. Each is folded on top of the example's own state
		// at an instant AFTER the expiry, so a reset would move the answer
		// visibly rather than subtly.
		const base = fold(INITIAL_LEAGUE_CLOCK, LOG, leagueClockReducer);
		const later = '2026-08-31T12:00:00.000Z';

		for (const type of [
			AUCTION_CLOSED_EVENT,
			AUCTION_TERMINATED_EVENT,
			CONTENTION_DRAWN_EVENT,
			CONTENTION_DISSOLVED_EVENT,
			CONTRACT_ASSIGNMENT_OPENED_EVENT,
			'MinorLeagueEligibilitySet',
			'ImportPromoted',
			'SomeEventTypeNobodyHasWrittenYet'
		]) {
			const after = fold(base, [event(9, type, later)], leagueClockReducer);
			expect(leagueClockExpiry(after), type).toBe(EXPIRES_AT);
		}

		// `BidVoided` is the one non-reset that is not a no-op: it records a
		// withdrawal. It still appends no reset, so the expiry can only move
		// EARLIER — never to `later`. Example 27 is the case where it does.
		const voided = fold(
			base,
			[event(9, BID_VOIDED_EVENT, later, { voidedSeq: '3' })],
			leagueClockReducer
		);
		expect(voided.resets).toEqual(base.resets);
		expect(leagueClockExpiry(voided)).toBe('2026-08-30T09:00:00.000Z');
	});
});
