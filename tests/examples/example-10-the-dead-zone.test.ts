/**
 * PRD §10 example 10 — **The dead zone** (AD-25).
 *
 * > In a Minimum-Bid Contention, a bid of $1,200,000 is refused — too high to
 * > join the lottery, too low to convert it, and off-grid besides. Under
 * > $500,000 granularity the dead zone contains **no** legal amount at all:
 * > between $1,000,000 (join) and $1,500,000 (convert) there is no whole
 * > multiple of $500,000. The zone is therefore reachable only by an off-grid
 * > submission, which is exactly the case the granularity check exists to
 * > catch.
 *
 * **Two grounds, both reported, neither suppressed.** AD-1 forbids
 * short-circuiting, so `contention` states what the amount is not and
 * `granularity` states that it is off the grid, in `PLACE_BID_GATES` order.
 * A refusal that named only one would leave a Manager fixing the wrong thing:
 * rounding $1,200,000 to $1,500,000 clears the grid and lands on the
 * conversion, which is refused for an entirely different reason.
 *
 * **`increment` PASSES here, with both figures null**, and that is the third
 * fact worth its own assertion. There is no ascending raise in a lottery to
 * be short of — every Contender holds the identical $1,000,000 — so the
 * increment rule genuinely does not apply, exactly as it does not apply to an
 * Opening Bid. Reporting a "minimum legal raise" over a high that is not
 * functioning as one would be inventing arithmetic the panel would print.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_BID, MINIMUM_INCREMENT, SALARY_CAP } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import type { Auction, Bid } from '../../src/lib/core/projection/auctions.ts';
import {
	bidGateReport,
	bidRefusalDetail,
	bidStateFor,
	decide,
	evaluate,
	failedGates
} from '../../src/lib/core/rules/bidding.ts';
import type {
	BidState,
	ContentionSeed,
	TeamMoneyState
} from '../../src/lib/core/rules/bidding.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-08-24T14:00:00.000Z';

/** Nothing about the money is marginal, so nothing but the amount decides. */
const RICH: TeamMoneyState = {
	capSpace: parseMoney(SALARY_CAP),
	rosterCount: 9,
	leading: [],
	eligibleLeading: [],
	minorLeagueOccupied: 0
};

/** The lottery Team E opened at 09:00 Monday, as the fold holds it. */
const OPENING: Bid = {
	seq: '1',
	teamId: 't-e',
	teamName: 'Team E',
	managerId: 'm-e',
	amount: parseMoney(MINIMUM_BID),
	occurredAt: '2026-08-24T09:00:00.000Z',
	closesAt: '2026-08-25T09:00:00.000Z',
	seedHash: 'c'.repeat(64)
};

const LOTTERY: Auction = {
	fantraxPlayerId: 'p-1',
	contention: 'minimum_bid',
	leadingBid: OPENING,
	closesAt: OPENING.closesAt,
	bids: [OPENING],
	contenders: [{ seq: '1', teamId: 't-e', teamName: 'Team E', managerId: 'm-t-e' }],
	seedHash: OPENING.seedHash,
	// The contention is LIVE: the seed is still sealed, so nothing is revealed.
	seed: null
};

const STATE: BidState = bidStateFor(LOTTERY, RICH, false, 'Auction');

function bidOf(amount: number): PlaceBid {
	return {
		kind: 'PlaceBid',
		fantraxPlayerId: 'p-1',
		teamId: 't-f',
		teamName: 'Team F',
		managerId: 'm-f',
		amount: parseMoney(amount)
	};
}

describe('§10 example 10 — the dead zone', () => {
	it('refuses $1,200,000 on BOTH contention and granularity, in gate order', () => {
		const gates = evaluate(STATE, bidOf(1_200_000), NOW);

		expect(failedGates(gates)).toEqual(['contention', 'granularity']);
		// "too high to join the lottery, too low to convert it"
		expect(gates.contention.entry).toBe('neither');
		expect(gates.contention.joinAmount).toBe(MINIMUM_BID);
		expect(gates.contention.conversionAmount).toBe(MINIMUM_BID + MINIMUM_INCREMENT);
		// "and off-grid besides"
		expect(gates.granularity.passed).toBe(false);
		expect(gates.granularity.grid).toBe(MINIMUM_INCREMENT);
	});

	it('reports increment as PASSED with both figures null — no raise applies here', () => {
		const gates = evaluate(STATE, bidOf(1_200_000), NOW);

		expect(gates.increment).toEqual({
			passed: true,
			offered: 1_200_000,
			currentHigh: null,
			minimumLegal: null
		});
	});

	it('words both grounds in one refusal, and neither is suppressed', () => {
		const detail = bidRefusalDetail({
			kind: 'gates',
			gates: evaluate(STATE, bidOf(1_200_000), NOW)
		});

		expect(detail).toContain('neither a join nor a conversion');
		expect(detail).toContain('whole multiple of $0.5M');
		// In `PLACE_BID_GATES` order: the lottery's answer frames the grid's.
		expect(detail.indexOf('neither a join')).toBeLessThan(detail.indexOf('whole multiple'));
		// And no invented figure: the off-grid amount is DESCRIBED, never
		// rendered, because `formatMoney` has no lossless spelling for it.
		expect(detail).not.toContain('$1.2M');
		expect(detail).not.toContain('1200000');
	});

	it('contains NO legal amount at all — the zone is reachable only off-grid', () => {
		// The example's own claim, asserted over the whole open interval
		// rather than sampled: it is a fact about the two constants.
		for (let amount = MINIMUM_BID + 1; amount < MINIMUM_BID + MINIMUM_INCREMENT; amount += 1) {
			if (amount % MINIMUM_INCREMENT === 0) {
				throw new Error(`the dead zone contains an on-grid amount: ${String(amount)}`);
			}
		}
		// ...so every amount in it is refused on the same two grounds.
		for (const amount of [1_000_001, 1_200_000, 1_400_000, 1_499_999]) {
			expect(failedGates(evaluate(STATE, bidOf(amount), NOW)), String(amount)).toEqual([
				'contention',
				'granularity'
			]);
		}
	});

	it('refuses through decide(), appending nothing and moving no clock', () => {
		// The SEALED seed, which is what the shell hands `decide()` inside a
		// live contention (Story 3.3). This Bid is refused before anything is
		// done with it, which is the point: a refusal reveals nothing.
		const sealed: ContentionSeed = { kind: 'sealed', seed: 'd'.repeat(64) };
		const decided = decide(STATE, bidOf(1_200_000), NOW, sealed);

		expect(decided.kind).toBe('rejected');
		expect(decided).not.toHaveProperty('events');
		// The Auction is exactly where it was: the lead, the close and the
		// Contender list are all untouched, because a refusal writes nothing.
		expect(LOTTERY.closesAt).toBe('2026-08-25T09:00:00.000Z');
		expect(LOTTERY.contenders).toHaveLength(1);
	});

	it('reports all nine gates on the panel, each with its own figure', () => {
		const rows = bidGateReport(evaluate(STATE, bidOf(1_200_000), NOW));

		expect(rows).toHaveLength(9);
		for (const row of rows) {
			expect(row.figure.length, row.gate).toBeGreaterThan(0);
		}
		const figureFor = (gate: string) => rows.find((row) => row.gate === gate);
		expect(figureFor('contention')?.chip).toBe('Minimum-Bid Contention · Refused');
		expect(figureFor('granularity')?.chip).toBe('Granularity · Refused');
		// The increment row states the fact it was decided from, not a raise.
		expect(figureFor('increment')?.chip).toBe('Minimum Increment · Passed');
		// NOT "no current high to raise": a $1,000,000 Bid IS leading here.
		// Both figures are null because the rule does not apply, which is a
		// different fact, and the panel states that one.
		expect(figureFor('increment')?.figure).toBe(
			'no raise applies in a Minimum-Bid Contention'
		);
	});
});
