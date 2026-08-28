/**
 * PRD §10 example 19 — **Overflow refuses the cheap bid, not the expensive
 * one** (AD-25).
 *
 * > Team P, still holding that $30,000,000 leading bid, bids $1,000,000 on a
 * > second eligible player. That makes `N = 2` against `M = 1`, Overflow
 * > Count 1, and Minors Exposure $30,000,000 — the largest surplus bid, which
 * > Team P cannot cover. The **$1,000,000 bid is refused**, and the message
 * > names the $30,000,000 auction as the cause. The earlier bid stands
 * > untouched. Roster Capacity is *not* the reason: at `11 + 1 = 12 ≤ 12` it
 * > passes, which isolates Minors Exposure as the sole ground.
 *
 * **The lesson is that overflow refuses the LATER Bid, whatever its size.**
 * Nothing retroactively invalidates the $30,000,000 lead — an accepted Bid is
 * never reopened — so the cheap Bid is the one that cannot be afforded, which
 * is the opposite of the intuition a Manager arrives with.
 *
 * **One seam this story could not close, and it is Epic 3's.** The example's
 * $1,000,000 is an OPENING Bid at exactly `MINIMUM_BID`, which by PRD §3 opens
 * a Minimum-Bid Contention — and Story 2.5's `opening` gate refuses that
 * amount by name, because no Contender list, seed table, fixed clock or draw
 * exists to run one (Stories 3.2/3.3). So at the literal figure the gate set
 * carries TWO refusals, and only one of them is about exposure. Both halves
 * are asserted here rather than papered over: the exposure arithmetic at the
 * example's own $1,000,000, and the "isolates Minors Exposure as the sole
 * ground" claim at $1,500,000 — the smallest legal opening, where `cap` really
 * is the only gate that refuses. Every figure the example states is unchanged
 * at either amount, because the exposure is the OTHER Auction's.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { parseMoney } from '../../src/lib/core/money.ts';
import {
	bidGateReport,
	bidRefusalDetail,
	bidStateFor,
	capBreakdown,
	decide,
	evaluate,
	failedGates
} from '../../src/lib/core/rules/bidding.ts';
import type { BidState, TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-08-27T09:00:00.000Z';

/**
 * Team P, exactly as example 18 left it: the $30,000,000 Bid landed and now
 * leads an OPEN eligible Auction, so it is an Eligible Leading Bid.
 *
 * Still two Minor League Slots occupied — `M = 1` — and still Roster Count
 * 11. Nothing about the earlier Bid has been touched; it is simply visible in
 * the fold now.
 */
const TEAM_P: TeamMoneyState = {
	capSpace: parseMoney(2_000_000),
	rosterCount: 11,
	leading: [],
	eligibleLeading: [
		{ fantraxPlayerId: 'p-stash', playerName: 'Ausar Bright', amount: parseMoney(30_000_000) }
	],
	minorLeagueOccupied: 2
};

/** The second eligible Player, with no Bid on him yet. */
const STATE: BidState = bidStateFor(null, TEAM_P, true);

function bidOf(amount: number): PlaceBid {
	return {
		kind: 'PlaceBid',
		fantraxPlayerId: 'p-second',
		teamId: 't-p',
		teamName: 'Team P',
		managerId: 'm-p',
		amount: parseMoney(amount)
	};
}

describe('§10 example 19 — overflow refuses the cheap bid', () => {
	it('derives N = 2 against M = 1, Overflow 1, and Minors Exposure $30.0M', () => {
		const cap = evaluate(STATE, bidOf(1_000_000), NOW).cap;

		expect(cap.freeMinorLeagueSlots).toBe(1);
		// The post-bid count: the open eligible lead, plus this Bid.
		expect(cap.eligibleLeadingBids).toBe(2);
		expect(cap.overflowCount).toBe(1);
		// "the largest surplus bid" — one overflows, so the sum is over the
		// single LARGEST amount in the post-bid set, not over the cheapest and
		// not over both.
		expect(cap.minorsExposure).toBe(30_000_000);
	});

	it('refuses the $1,000,000 Bid on money, with the $30.0M inside Committed Bids', () => {
		const cap = evaluate(STATE, bidOf(1_000_000), NOW).cap;

		expect(cap.committedBids).toBe(30_000_000);
		expect(cap.availableCapSpace).toBe(-28_000_000);
		// Roster Count 11 plus the one overflowing addition reaches the
		// ceiling, so the reserve is $0 and Maximum Bid is the whole deficit.
		expect(cap.rosterReserve).toBe(0);
		expect(cap.maximumBid).toBe(-28_000_000);
		expect(cap.unbounded).toBe(false);
		expect(cap.passed).toBe(false);
	});

	it('names the $30,000,000 Auction as the cause, by Player and amount', () => {
		const gates = evaluate(STATE, bidOf(1_000_000), NOW);

		expect(gates.cap.exposingBids).toEqual([
			{ fantraxPlayerId: 'p-stash', playerName: 'Ausar Bright', amount: 30_000_000 }
		]);

		const detail = bidRefusalDetail({ kind: 'gates', gates });
		expect(detail).toContain('Ausar Bright');
		expect(detail).toContain('$30.0M');
		expect(detail).toContain('Overflow Count of 1');
		expect(detail).toContain('Eligible Leading Bids 2');
		expect(detail).toContain('Free Minor League Slots 1');
	});

	it('leaves Roster Capacity passing at 11 + 1 = 12, which isolates the money', () => {
		const slots = evaluate(STATE, bidOf(1_000_000), NOW).slots;

		// The overflow has to land somewhere, so it counts against
		// Active/Bench — and one addition still fits.
		expect(slots.projectedAdditions).toBe(1);
		expect(slots.overflowCount).toBe(1);
		expect(slots.rosterCount).toBe(11);
		expect(slots.passed).toBe(true);
	});

	it('makes Minors Exposure the SOLE ground at the smallest legal opening', () => {
		// The example's own $1,000,000 is an Opening Bid at exactly
		// `MINIMUM_BID`, which the `opening` gate refuses by name because it
		// would open a Minimum-Bid Contention nothing can yet draw (Stories
		// 3.2/3.3). At $1,500,000 — the smallest opening that clears both the
		// minimum and the grid — every other gate passes and `cap` is the only
		// refusal, which is the claim the example is actually making.
		const gates = evaluate(STATE, bidOf(1_500_000), NOW);

		expect(failedGates(gates)).toEqual(['cap']);
		expect(gates.slots.passed).toBe(true);
		expect(gates.opening.passed).toBe(true);
		expect(gates.granularity.passed).toBe(true);
		// Every figure the example states is unchanged: the exposure is the
		// OTHER Auction's amount, not this Bid's.
		expect(gates.cap.minorsExposure).toBe(30_000_000);
		expect(gates.cap.maximumBid).toBe(-28_000_000);

		// ...and at the literal $1,000,000 the exposure refusal is still there,
		// beside the one Epic 3 owns.
		expect(failedGates(evaluate(STATE, bidOf(1_000_000), NOW))).toEqual(['opening', 'cap']);
	});

	it('appends nothing, and the earlier Bid is untouched', () => {
		const decided = decide(STATE, bidOf(1_500_000), NOW, null);

		expect(decided.kind).toBe('rejected');
		if (decided.kind !== 'rejected') return;
		// The refusal is about the NEW Bid. Nothing reopens, invalidates or
		// re-prices the $30,000,000 lead — it is still exactly where it was,
		// and it is still what the arithmetic was computed from.
		expect(decided.gates.cap.exposingBids).toEqual([
			{ fantraxPlayerId: 'p-stash', playerName: 'Ausar Bright', amount: 30_000_000 }
		]);
		expect(TEAM_P.eligibleLeading).toHaveLength(1);
		expect(TEAM_P.eligibleLeading[0]?.amount).toBe(30_000_000);
	});

	it('prints a breakdown that still sums, with the exposure named inside Committed Bids', () => {
		const lines = capBreakdown(evaluate(STATE, bidOf(1_500_000), NOW).cap);
		const figureFor = (label: string) => lines.find((line) => line.label === label)?.figure;

		expect(figureFor('Cap Space')).toBe('$2.0M');
		expect(figureFor('Committed Bids')).toBe('$30.0M');
		expect(figureFor('of which Minors Exposure')).toBe('$30.0M');
		expect(figureFor('Available Cap Space')).toBe('−$28.0M');
		expect(figureFor('Roster Reserve')).toBe('$0.0M');
		expect(figureFor('Maximum Bid')).toBe('−$28.0M');
		// The counts row: `N`, `M` and the Overflow they produce.
		expect(figureFor('Eligible Leading Bids 2 of 1 Free Minor League Slots')).toBe(
			'Overflow Count 1'
		);
		// Exposure is commentary INSIDE Committed Bids, never a second
		// subtraction — the column would stop summing if it were.
		const exposure = lines.find((line) => line.label === 'of which Minors Exposure');
		expect(exposure?.kind).toBe('detail');
		expect(exposure?.operator).toBe('');
		// No cap limit applies here: this Bid overflows, so it is bounded.
		expect(lines.some((line) => line.label === 'Why there is no cap limit')).toBe(false);
	});

	it('reports both gates, each with its own figure', () => {
		const rows = bidGateReport(evaluate(STATE, bidOf(1_500_000), NOW));
		const rowFor = (gate: string) => rows.find((row) => row.gate === gate);

		expect(rowFor('cap')?.chip).toBe('Cap · Refused');
		expect(rowFor('cap')?.figure).toContain('Overflow Count 1');
		expect(rowFor('slots')?.chip).toBe('Slots · Passed');
		// Counts, and only counts: the capacity row names the overflow without
		// naming a dollar, because the outcome it renders carries none.
		expect(rowFor('slots')?.figure).toBe('Roster Count would be 12 of 12, Overflow Count 1');
		expect(rowFor('slots')?.figure).not.toMatch(/\$/);
		expect(rows).toHaveLength(6);
	});
});
