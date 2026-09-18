/**
 * PRD §10 example 4 — **Reserve clears as commitments accumulate** (AD-25).
 *
 * > Same Team C, now leading two auctions at $3,000,000 and $2,000,000.
 * > Available Cap Space $7,000,000; reserve = $1,000,000 × max(0, 12 − (9 + 2
 * > + 1)) = $0. Maximum Bid $7,000,000.
 *
 * The example that shows the two halves of the arithmetic pulling in opposite
 * directions: leading two Auctions COSTS $5,000,000 of Available Cap Space
 * and simultaneously RELEASES the $2,000,000 of Roster Reserve that example 3
 * was holding back, because those two wins will fill two of the holes the
 * reserve exists to cover. A Team is never charged twice for the same roster
 * spot, and this is the test that says so.
 *
 * Note the example's own `(9 + 2 + 1)`: nine held, two led, one being placed.
 * That third term is the post-bid basis example 3 pins.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { parseMoney } from '../../src/lib/core/money.ts';
import {
	bidStateFor,
	capBreakdown,
	decide,
	evaluate,
	failedGates
} from '../../src/lib/core/rules/bidding.ts';
import type { BidState, TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-08-27T09:00:00.000Z';

/** Team C, now leading two Auctions on Players who are not Minor League Eligible. */
const TEAM_C: TeamMoneyState = {
	capSpace: parseMoney(12_000_000),
	rosterCount: 9,
	leading: [
		{ fantraxPlayerId: 'p-lead-a', playerName: 'Lead A', amount: parseMoney(3_000_000), isContentionEntry: false },
		{ fantraxPlayerId: 'p-lead-b', playerName: 'Lead B', amount: parseMoney(2_000_000), isContentionEntry: false }
	],
	// Story 2.8: neither lead is Minor League Eligible and no Minor League
	// Slot is occupied, so the exposure arithmetic is inert here — which is
	// what keeps this example about Roster Reserve alone.
	eligibleLeading: [],
	minorLeagueOccupied: 0
};

const STATE: BidState = bidStateFor(null, TEAM_C, 'Auction');

function bidOf(amount: number): PlaceBid {
	return {
		kind: 'PlaceBid',
		fantraxPlayerId: 'p-1',
		teamId: 't-c',
		teamName: 'Team C',
		managerId: 'm-c',
		amount: parseMoney(amount)
	};
}

describe('§10 example 4 — Reserve clears as commitments accumulate', () => {
	it('commits the two leading amounts and reduces Available Cap Space to $7.0M', () => {
		const gates = evaluate(STATE, bidOf(7_000_000), NOW);

		expect(gates.cap.capSpace).toBe(12_000_000);
		expect(gates.cap.committedBids).toBe(5_000_000);
		expect(gates.cap.availableCapSpace).toBe(7_000_000);
	});

	it('clears the Roster Reserve to $0, because those wins fill the holes it covered', () => {
		const gates = evaluate(STATE, bidOf(7_000_000), NOW);

		// 9 held + 2 led + 1 being placed = 12, so there is no unfilled
		// Active/Bench Slot left for the reserve to hold money against.
		expect(gates.cap.rosterCount).toBe(9);
		expect(gates.cap.projectedAdditions).toBe(3);
		expect(gates.cap.rosterReserve).toBe(0);
		expect(gates.cap.maximumBid).toBe(7_000_000);
	});

	it('accepts exactly $7.0M and refuses $7.5M', () => {
		expect(decide(STATE, bidOf(7_000_000), NOW, null).kind).toBe('accepted');

		const over = evaluate(STATE, bidOf(7_500_000), NOW);
		expect(failedGates(over)).toEqual(['cap']);
	});

	it('keeps the clamp from going negative when the projection reaches twelve', () => {
		// The clamp is unreachable in ordinary play because FR-37's ceiling
		// holds, but a Commissioner override can put a Team above 12 — and an
		// unclamped reserve would then go NEGATIVE and hand that Team extra
		// spending power as a reward for the override.
		const overridden: TeamMoneyState = { ...TEAM_C, rosterCount: 14 };
		const gates = evaluate(bidStateFor(null, overridden, 'Auction'), bidOf(1_500_000), NOW);

		expect(gates.cap.rosterReserve).toBe(0);
		expect(gates.cap.maximumBid).toBe(7_000_000);
	});

	it('renders a breakdown that still sums with a non-zero Committed Bids', () => {
		const lines = capBreakdown(evaluate(STATE, bidOf(7_000_000), NOW).cap);
		const line = (label: string) => lines.find((row) => row.label === label);

		expect(line('Cap Space')?.figure).toBe('$12.0M');
		expect(line('Committed Bids')?.figure).toBe('$5.0M');
		// Subtracted, and the column says so rather than leaving the reader to
		// infer which way each term goes.
		expect(line('Committed Bids')?.operator).toBe('−');
		expect(line('Available Cap Space')?.figure).toBe('$7.0M');
		expect(line('Roster Reserve')?.figure).toBe('$0.0M');
		expect(line('Maximum Bid')?.figure).toBe('$7.0M');
	});
});
