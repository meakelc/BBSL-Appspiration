/**
 * PRD §10 example 2 — **Insufficient increment, and off-grid** (AD-25).
 *
 * > Same auction. Team B bids $8,400,000 — refused on **both** grounds: it
 * > is below `current high + $500,000` and it is not a whole multiple of
 * > $500,000. Board and clock unchanged. Note that under $500,000
 * > granularity these two grounds cannot be separated in Standard
 * > Contention — the next grid value above $8,000,000 is $8,500,000, which
 * > is exactly one increment — so no test can exercise a sub-increment bid
 * > that is on-grid. The granularity check earns its keep in Minimum-Bid
 * > Contention instead (example 10).
 *
 * The example's own note is why increment and granularity are two separately
 * written gates rather than one: they coincide here and diverge in example
 * 26, and AD-1 forbids reporting only the first of them.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_INCREMENT, SALARY_CAP } from '../../src/lib/core/constants.ts';
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
import { PLACE_BID_GATES } from '../../src/lib/core/types.ts';
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
	leading: [],
	// Story 2.8: no eligible leads and no occupied Minor League
	// Slots, so `N` is the bid alone and `M` is the full three.
	eligibleLeading: [],
	minorLeagueOccupied: 0
};

/** The same auction as example 1: Team A leading at $8,000,000. */
const AUCTION: Auction = {
	fantraxPlayerId: 'p-1',
	contention: 'standard',
	leadingBid: {
		seq: '2',
		teamId: 't-a',
		teamName: 'Team A',
		managerId: 'm-a',
		amount: parseMoney(8_000_000),
		occurredAt: '2026-08-26T08:00:00.000Z',
		closesAt: '2026-08-27T08:00:00.000Z',
		// Story 3.2: `hash(seed)`, present only on the Bid that opened a
		// Minimum-Bid Contention. This one opened nothing of the sort.
		seedHash: null
	},
	closesAt: '2026-08-27T08:00:00.000Z',
	bids: [],
	// Standard Contention has no Contenders, no published commitment and
	// nothing revealed: no lottery ever ran here.
	contenders: [],
	seedHash: null,
	seed: null
};

const STATE: BidState = bidStateFor(AUCTION, RICH, false, 'Auction');

const OFF_GRID_UNDER_INCREMENT: PlaceBid = {
	kind: 'PlaceBid',
	fantraxPlayerId: 'p-1',
	teamId: 't-b',
	teamName: 'Team B',
	managerId: 'm-b',
	amount: parseMoney(8_400_000)
};

const NOW = '2026-08-26T12:00:00.000Z';

describe('§10 example 2 — Insufficient increment, and off-grid', () => {
	it('refuses $8,400,000 on BOTH grounds, reported in one GateResults', () => {
		const gates = evaluate(STATE, OFF_GRID_UNDER_INCREMENT, NOW);

		expect(gates.increment).toEqual({
			passed: false,
			offered: 8_400_000,
			currentHigh: 8_000_000,
			minimumLegal: 8_500_000
		});
		expect(gates.granularity).toEqual({
			passed: false,
			offered: 8_400_000,
			grid: MINIMUM_INCREMENT
		});
		expect(failedGates(gates)).toEqual(['increment', 'granularity']);
	});

	it('still reports the gates that PASSED, in the same result', () => {
		// AD-1: a refusal reports every gate that ran, not only the first that
		// failed — `EXPERIENCE.md` prints the passing gate beside the failing
		// one, so short-circuiting would put that arithmetic outside the core.
		const gates = evaluate(STATE, OFF_GRID_UNDER_INCREMENT, NOW);
		expect(Object.keys(gates).sort()).toEqual([...PLACE_BID_GATES].sort());
		expect(gates.opening.passed).toBe(true);
		expect(gates.selfBid.passed).toBe(true);
	});

	it('returns a Rejected value carrying that same gate set — never a throw', () => {
		const decided = decide(STATE, OFF_GRID_UNDER_INCREMENT, NOW, null);
		expect(decided.kind).toBe('rejected');
		if (decided.kind !== 'rejected') return;
		expect(decided.gates).toEqual(evaluate(STATE, OFF_GRID_UNDER_INCREMENT, NOW));
	});

	it('states both grounds in the refusal sentence', () => {
		const gates = evaluate(STATE, OFF_GRID_UNDER_INCREMENT, NOW);
		const detail = bidRefusalDetail({ kind: 'gates', gates });
		expect(detail).toContain('$8.0M');
		expect(detail).toContain('$8.5M');
		expect(detail).toContain('whole multiple of $0.5M');
	});

	it('leaves the board and the clock untouched — no event is emitted at all', () => {
		const decided = decide(STATE, OFF_GRID_UNDER_INCREMENT, NOW, null);
		expect(decided).not.toHaveProperty('events');
		// The state literal is unchanged by the call: `decide` is pure. The
		// Auction it was narrowed from is untouched too.
		expect(STATE.leadingBid).toEqual({ teamId: 't-a', amount: 8_000_000 });
		expect(AUCTION.leadingBid?.amount).toBe(8_000_000);
		expect(AUCTION.closesAt).toBe('2026-08-27T08:00:00.000Z');
	});

	it('confirms the example’s own note: no on-grid sub-increment bid exists here', () => {
		// Between the $8,000,000 high and the $8,500,000 minimum legal raise
		// there is no whole multiple of $500,000, so the two grounds cannot be
		// separated in Standard Contention. Example 26 is where they diverge.
		const between: number[] = [];
		for (let amount = 8_000_001; amount < 8_500_000; amount += 1) {
			if (amount % MINIMUM_INCREMENT === 0) between.push(amount);
		}
		expect(between).toEqual([]);
	});
});
