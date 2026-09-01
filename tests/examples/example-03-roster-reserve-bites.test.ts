/**
 * PRD §10 example 3 — **Roster reserve bites** (AD-25).
 *
 * > Team C: Cap Space $12,000,000, Roster Count 9, no leading bids. Maximum
 * > Bid = $12,000,000 − ($1,000,000 × (12 − 10)) = $10,000,000. A
 * > $10,500,000 bid is refused with the arithmetic shown.
 *
 * The example that fixes the POST-BID basis, and it is the whole reason this
 * one is worth a named test. `12 − 10` is not `12 − 9`: Projected Active/Bench
 * Additions is 1 because the bid being placed counts itself (PRD FR-12, §3
 * glossary, AD-7). Computing the reserve against the pre-bid Roster Count
 * would give `$1,000,000 × 3 = $3,000,000` and a Maximum Bid of $9,000,000 —
 * a figure that is wrong in the Team's favour by a whole roster hole, and
 * wrong in a direction no test that only checked "was it refused" would
 * catch, because the $10.5M bid is refused either way.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { parseMoney } from '../../src/lib/core/money.ts';
import {
	allGatesPassed,
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

/** Team C, exactly as the example states it. */
const TEAM_C: TeamMoneyState = {
	capSpace: parseMoney(12_000_000),
	rosterCount: 9,
	// "no leading bids" — so Committed Bids is $0 and Projected Active/Bench
	// Additions is the prospective bid alone.
	leading: [],
	// Story 2.8: no eligible leads and no occupied Minor League
	// Slots, so `N` is the bid alone and `M` is the full three.
	eligibleLeading: [],
	minorLeagueOccupied: 0
};

/**
 * A Player nobody has bid on yet, so the money gate is the only one in play.
 *
 * The example says nothing about contention because it is not about
 * contention: an opening above $1,000,000 clears `opening`, `selfBid` passes
 * with no leader, `increment` does not apply and every amount here is on the
 * grid. What is left is `cap`, which is the point.
 */
const STATE: BidState = bidStateFor(null, TEAM_C, false, 'Auction');

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

describe('§10 example 3 — Roster reserve bites', () => {
	it('computes Maximum Bid as $10.0M from Cap Space $12.0M and a $2.0M Roster Reserve', () => {
		const gates = evaluate(STATE, bidOf(10_500_000), NOW);

		expect(gates.cap.capSpace).toBe(12_000_000);
		expect(gates.cap.committedBids).toBe(0);
		expect(gates.cap.availableCapSpace).toBe(12_000_000);
		// The post-bid basis, stated as its own assertion because it is the
		// figure the example exists to pin: 9 held plus the 1 being bid.
		expect(gates.cap.rosterCount).toBe(9);
		expect(gates.cap.projectedAdditions).toBe(1);
		// $1,000,000 × (12 − 10).
		expect(gates.cap.rosterReserve).toBe(2_000_000);
		expect(gates.cap.maximumBid).toBe(10_000_000);
	});

	it('refuses the $10.5M bid on the money gate, and on that gate alone', () => {
		const gates = evaluate(STATE, bidOf(10_500_000), NOW);

		expect(gates.cap.passed).toBe(false);
		expect(failedGates(gates)).toEqual(['cap']);
		// Every other gate reports, and reports PASSED — the refusal names one
		// obstacle and proves the rest were checked.
		expect(gates.opening.passed).toBe(true);
		expect(gates.selfBid.passed).toBe(true);
		expect(gates.increment.passed).toBe(true);
		expect(gates.granularity.passed).toBe(true);
	});

	it('refuses through decide(), appending nothing', () => {
		const decided = decide(STATE, bidOf(10_500_000), NOW, null);

		expect(decided.kind).toBe('rejected');
		if (decided.kind !== 'rejected') return;
		expect(allGatesPassed(decided.gates)).toBe(false);
	});

	it('shows the arithmetic, and the arithmetic sums as displayed', () => {
		const gates = evaluate(STATE, bidOf(10_500_000), NOW);
		const detail = bidRefusalDetail({ kind: 'gates', gates });

		// "with the arithmetic shown" — the delta names both figures and the
		// gap between them, so nobody has to subtract at 4am.
		expect(detail).toContain('$10.5M exceeds your Maximum Bid of $10.0M by $0.5M');

		// And the breakdown a panel renders sums exactly as displayed, which
		// is the load-bearing property of the whole product. Read as a column:
		// $12.0M − $0.0M = $12.0M, then $12.0M − $2.0M = $10.0M.
		const lines = capBreakdown(gates.cap);
		const figureFor = (label: string): string | undefined =>
			lines.find((line) => line.label === label)?.figure;

		expect(figureFor('Cap Space')).toBe('$12.0M');
		expect(figureFor('Committed Bids')).toBe('$0.0M');
		expect(figureFor('Available Cap Space')).toBe('$12.0M');
		expect(figureFor('Roster Reserve')).toBe('$2.0M');
		expect(figureFor('Maximum Bid')).toBe('$10.0M');
		// Never a bare number: the components are all present (FR-12).
		expect(lines.length).toBeGreaterThan(4);
	});

	it('accepts $10.0M — the gate refuses only what EXCEEDS Maximum Bid', () => {
		const decided = decide(STATE, bidOf(10_000_000), NOW, null);

		expect(decided.kind).toBe('accepted');
	});
});
