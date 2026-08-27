/**
 * PRD §10 example 26 — **Off-grid amounts are refused everywhere** (AD-25).
 *
 * > A player stands at $6,000,000 in Standard Contention. A bid of
 * > $6,750,000 is refused as off-grid, though it clears the increment. In a
 * > separate Minimum-Bid Contention, a bid of $1,000,001 is refused as
 * > off-grid, though it is neither a valid join nor a conversion either. The
 * > granularity check runs independently of contention state.
 *
 * This is the example that pays for the granularity gate being written
 * separately from the increment gate: the first half has increment PASSING
 * while granularity refuses, and the second half runs in a contention state
 * where the increment rule is not the point at all.
 *
 * **The Minimum-Bid Contention here is a state LITERAL, and that is
 * deliberate.** Story 2.5 creates no lottery — an Opening Bid of exactly
 * $1,000,000 is refused by the `opening` gate, because the Contender list,
 * seed table, fixed clock and draw are Stories 3.2/3.3. AD-25 asks for "a
 * state literal", and the fold is total over one, so the case is proven
 * against the state a lottery WOULD have without one being creatable here.
 *
 * Calls the core directly — no database, no HTTP, no clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_BID, MINIMUM_INCREMENT, SALARY_CAP } from '../../src/lib/core/constants.ts';
import type { Auction } from '../../src/lib/core/projection/auctions.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	bidRefusalDetail,
	bidStateFor,
	decide,
	evaluate,
	failedGates
} from '../../src/lib/core/rules/bidding.ts';
import type { BidState, TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

/**
 * A Team the money gate cannot be the reason for anything here.
 *
 * Story 2.6 added `cap` to `PLACE_BID_GATES`, and every state literal in this
 * file must now say something about money whether or not the example is about
 * money. This one says "not the constraint": the full Salary Cap, nothing
 * committed, and a roster with room — so a refusal in this file is always the
 * gate the example is actually about. §10 examples 3, 4, 5 and 23 are where
 * the money arithmetic is exercised on purpose.
 */
const RICH: TeamMoneyState = {
	capSpace: parseMoney(SALARY_CAP),
	rosterCount: 9,
	leading: []
};

const NOW = '2026-08-26T12:00:00.000Z';

/** An Auction whose leading Bid is `amount`, in whatever contention that implies. */
function auctionAt(amount: number, contention: 'standard' | 'minimum_bid'): Auction {
	return {
		fantraxPlayerId: 'p-1',
		contention,
		leadingBid: {
			seq: '2',
			teamId: 't-a',
			teamName: 'Team A',
			managerId: 'm-a',
			amount: parseMoney(amount),
			occurredAt: '2026-08-26T08:00:00.000Z',
			closesAt: '2026-08-27T08:00:00.000Z'
		},
		closesAt: '2026-08-27T08:00:00.000Z',
		bids: []
	};
}

function bidOf(amount: number): PlaceBid {
	return {
		kind: 'PlaceBid',
		fantraxPlayerId: 'p-1',
		teamId: 't-b',
		teamName: 'Team B',
		managerId: 'm-b',
		amount: parseMoney(amount)
	};
}

// --- 26a: Standard Contention, off-grid, and it CLEARS the increment -------

const STANDARD_AT_SIX: BidState = bidStateFor(auctionAt(6_000_000, 'standard'), RICH);

describe('§10 example 26a — $6,750,000 over a $6,000,000 high', () => {
	it('refuses on granularity', () => {
		const gates = evaluate(STANDARD_AT_SIX, bidOf(6_750_000), NOW);
		expect(gates.granularity).toEqual({
			passed: false,
			offered: 6_750_000,
			grid: MINIMUM_INCREMENT
		});
		expect(failedGates(gates)).toEqual(['granularity']);
	});

	it('reports the increment gate as PASSED, with the arithmetic that says why', () => {
		// "though it clears the increment" — this is the half of the example
		// that would be invisible if the two gates were one, or if `evaluate`
		// short-circuited on the first failure.
		const gates = evaluate(STANDARD_AT_SIX, bidOf(6_750_000), NOW);
		expect(gates.increment).toEqual({
			passed: true,
			offered: 6_750_000,
			currentHigh: 6_000_000,
			minimumLegal: 6_500_000
		});
	});

	it('refuses with the granularity sentence alone, and never renders the off-grid figure', () => {
		const gates = evaluate(STANDARD_AT_SIX, bidOf(6_750_000), NOW);
		const detail = bidRefusalDetail({ kind: 'gates', gates });
		expect(detail).toContain('whole multiple of $0.5M');
		expect(detail).not.toContain('current high');
		// `$14.5M` is lossless only on the grid (AD-8), so an off-grid figure
		// has no rendering and gets described rather than spelled.
		expect(detail).not.toContain('6750000');
		expect(detail).not.toContain('$6.75M');
	});

	it('returns Rejected rather than throwing, and emits no event', () => {
		const decided = decide(STANDARD_AT_SIX, bidOf(6_750_000), NOW, null);
		expect(decided.kind).toBe('rejected');
		expect(decided).not.toHaveProperty('events');
	});
});

// --- 26b: a Minimum-Bid Contention, off-grid by one dollar -----------------

const LOTTERY_AUCTION: Auction = auctionAt(MINIMUM_BID, 'minimum_bid');
const LOTTERY: BidState = bidStateFor(LOTTERY_AUCTION, RICH);

describe('§10 example 26b — $1,000,001 in a Minimum-Bid Contention', () => {
	it('is a Minimum-Bid Contention state literal, not one this story created', () => {
		expect(LOTTERY_AUCTION.contention).toBe('minimum_bid');
		expect(LOTTERY.leadingBid?.amount).toBe(MINIMUM_BID);
		// And the gate refuses to CREATE one: an Opening Bid of exactly
		// $1,000,000 is named and refused, so nothing here can produce this
		// state through the rules.
		const opening = evaluate(bidStateFor(null, RICH), bidOf(MINIMUM_BID), NOW);
		expect(opening.opening.passed).toBe(false);
		expect(opening.opening.opening).toBe('at_the_minimum');
	});

	it('refuses on granularity', () => {
		const gates = evaluate(LOTTERY, bidOf(1_000_001), NOW);
		expect(gates.granularity).toEqual({
			passed: false,
			offered: 1_000_001,
			grid: MINIMUM_INCREMENT
		});
	});

	it('refuses it regardless of what the increment gate reports (AC3)', () => {
		// "neither a valid join nor a conversion either" — the increment gate
		// has its own opinion here, and granularity does not depend on it.
		const gates = evaluate(LOTTERY, bidOf(1_000_001), NOW);
		expect(gates.granularity.passed).toBe(false);
		expect(bidRefusalDetail({ kind: 'gates', gates })).toContain('whole multiple of $0.5M');
	});

	it('runs the granularity check independently of contention state', () => {
		// The same off-grid amount, in every state this core can be handed:
		// no bids at all, Standard Contention, and the lottery above. The gate
		// reads the amount and nothing else, so all three agree exactly.
		const offGrid = 1_000_001;
		const states: BidState[] = [bidStateFor(null, RICH), STANDARD_AT_SIX, LOTTERY];
		for (const state of states) {
			expect(evaluate(state, bidOf(offGrid), NOW).granularity).toEqual({
				passed: false,
				offered: offGrid,
				grid: MINIMUM_INCREMENT
			});
		}
	});
});
