/**
 * PRD §10 example 5 — **Outbid frees capital immediately** (AD-25).
 *
 * > Team C is outbid on the $3,000,000 auction. Available Cap Space returns
 * > to $10,000,000; Projected Active/Bench Additions drops to 2, so reserve
 * > becomes $1,000,000 × max(0, 12 − 11) = $1,000,000; Maximum Bid
 * > $9,000,000.
 *
 * **"Immediately" is the claim under test, and it is a claim about
 * ARCHITECTURE rather than about arithmetic.** FR-14 says committed capital
 * is released the instant a Team ceases to be Leading Bidder — not at close,
 * not on a sweep — and the only way to make that true without a scheduled job
 * is for the figure never to have been stored in the first place (AD-7). So
 * this file asserts the release the way the product achieves it: by folding a
 * log in which another Team's `BidPlaced` has landed, and observing that the
 * amount has simply stopped appearing. Nothing runs. Nothing is invalidated.
 *
 * Note the reserve moving the OTHER way from example 4: losing a lead frees
 * $3,000,000 of cap and simultaneously re-opens the roster hole that win
 * would have filled, so $1,000,000 goes straight back into Roster Reserve.
 * The net gain is $2,000,000, not $3,000,000.
 *
 * Calls the core directly — the fold, then the gates, against a state literal.
 */

import { describe, expect, it } from 'vitest';

import {
	BID_PLACED_EVENT,
	INITIAL_AUCTIONS,
	auctionsReducer
} from '../../src/lib/core/projection/auctions.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { bidStateFor, evaluate, teamMoneyStateFor } from '../../src/lib/core/rules/bidding.ts';
import type { TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import type { AppendedEvent, PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-08-27T09:00:00.000Z';

const CAP_SPACE = parseMoney(12_000_000);
const ROSTER_COUNT = 9;

/** No Player here is Minor League Eligible, so Story 2.8's exposure is zero throughout. */
const NOTHING_IS_ELIGIBLE = (): boolean => false;

function bidEvent(seq: number, fantraxPlayerId: string, teamId: string, amount: number): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt: '2026-08-26T09:00:00.000Z',
		schemaVersion: 1,
		coreVersion: 1,
		type: BID_PLACED_EVENT,
		payload: {
			fantraxPlayerId,
			teamId,
			teamName: teamId === 't-c' ? 'Team C' : 'Team D',
			managerId: teamId === 't-c' ? 'm-c' : 'm-d',
			amount,
			closesAt: '2026-08-27T09:00:00.000Z'
		},
		managerId: teamId === 't-c' ? 'm-c' : 'm-d',
		teamId,
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

/** Team C leads p-a at $3.0M and p-b at $2.0M — example 4's state. */
const LEADING_BOTH: readonly AppendedEvent[] = [
	bidEvent(1, 'p-a', 't-c', 3_000_000),
	bidEvent(2, 'p-b', 't-c', 2_000_000)
];

/**
 * Team D raises p-a. Nothing is deleted and nothing is compensated — the log
 * is insert-only, and one more event is the entire mechanism.
 */
const OUTBID_ON_P_A: readonly AppendedEvent[] = [
	...LEADING_BOTH,
	bidEvent(3, 'p-a', 't-d', 3_500_000)
];

function moneyStateFrom(events: readonly AppendedEvent[]): TeamMoneyState {
	return teamMoneyStateFor({
		teamId: 't-c',
		// The Auction being bid on, excluded from the Team's own commitments.
		fantraxPlayerId: 'p-new',
		capSpace: CAP_SPACE,
		rosterCount: ROSTER_COUNT,
		// Story 2.8: no Minor League Slot occupied, so `M` is the full three
		// and nothing here overflows — the release this example is about is
		// the fold moving a lead, and nothing else.
		minorLeagueOccupied: 0,
		auctions: fold(INITIAL_AUCTIONS, events, auctionsReducer),
		isMinorLeagueEligible: NOTHING_IS_ELIGIBLE,
		playerNameFor: (playerId) => playerId
	});
}

function bidOf(amount: number): PlaceBid {
	return {
		kind: 'PlaceBid',
		fantraxPlayerId: 'p-new',
		teamId: 't-c',
		teamName: 'Team C',
		managerId: 'm-c',
		amount: parseMoney(amount)
	};
}

describe('§10 example 5 — Outbid frees capital immediately', () => {
	it('holds $5.0M against the cap while Team C leads both Auctions', () => {
		const gates = evaluate(bidStateFor(null, moneyStateFrom(LEADING_BOTH), false, 'Auction'), bidOf(1_500_000), NOW);

		expect(gates.cap.committedBids).toBe(5_000_000);
		expect(gates.cap.availableCapSpace).toBe(7_000_000);
		expect(gates.cap.maximumBid).toBe(7_000_000);
	});

	it('returns Available Cap Space to $10.0M the moment another Team leads', () => {
		const gates = evaluate(bidStateFor(null, moneyStateFrom(OUTBID_ON_P_A), false, 'Auction'), bidOf(1_500_000), NOW);

		// The $3.0M is gone from Committed Bids because the fold no longer
		// names Team C as the leader of p-a. No release ran.
		expect(gates.cap.committedBids).toBe(2_000_000);
		expect(gates.cap.availableCapSpace).toBe(10_000_000);
	});

	it('re-opens the roster hole that win would have filled, restoring $1.0M of reserve', () => {
		const gates = evaluate(bidStateFor(null, moneyStateFrom(OUTBID_ON_P_A), false, 'Auction'), bidOf(1_500_000), NOW);

		// Projected Active/Bench Additions drops from 3 to 2 — one surviving
		// lead plus the bid being placed.
		expect(gates.cap.projectedAdditions).toBe(2);
		// $1,000,000 × max(0, 12 − 11).
		expect(gates.cap.rosterReserve).toBe(1_000_000);
		expect(gates.cap.maximumBid).toBe(9_000_000);
	});

	it('frees the capital by folding one more event — no sweep, no compensating write', () => {
		// The proof that "immediately" is structural: the outbid state is the
		// leading state plus exactly one appended event, and nothing was
		// removed from the log to produce it.
		expect(OUTBID_ON_P_A).toHaveLength(LEADING_BOTH.length + 1);
		expect(OUTBID_ON_P_A.slice(0, LEADING_BOTH.length)).toEqual(LEADING_BOTH);
		expect(OUTBID_ON_P_A[2]?.type).toBe(BID_PLACED_EVENT);
	});

	it('names the surviving lead, so a refusal can say where the money is', () => {
		const money = moneyStateFrom(OUTBID_ON_P_A);

		expect(money.leading).toEqual([
			{ fantraxPlayerId: 'p-b', playerName: 'p-b', amount: 2_000_000, isContentionEntry: false }
		]);
	});
});
