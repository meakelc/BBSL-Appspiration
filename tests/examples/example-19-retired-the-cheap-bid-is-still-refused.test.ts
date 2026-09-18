/**
 * PRD §10 example 19 — **RETIRED on 2026-09-18**, and this file is the record
 * of that plus the regression that keeps it retired.
 *
 * Example 19 existed to state how Minors Exposure bit:
 *
 * > Team P, still holding that $30,000,000 leading bid, bids $1,000,000 on a
 * > second eligible player. That makes `N = 2` against `M = 1`, Overflow
 * > Count 1, and Minors Exposure $30,000,000 — the largest surplus bid, which
 * > Team P cannot cover. The **$1,000,000 bid is refused**, and the message
 * > names the $30,000,000 auction as the cause.
 *
 * **The LESSON survives; the MECHANISM does not.** A Team cannot win a Free
 * Agent straight into its minors, so the $30,000,000 lead commits its full
 * amount to Committed Bids from the moment it is placed — not conditionally,
 * through an overflow count, but the way every other lead always has. Team P
 * is $28,000,000 underwater before it types anything, so the cheap Bid is
 * refused for the plainest possible reason.
 *
 * That keeps the example's actual point, which was never really about minors:
 * **overflow refuses the LATER Bid, whatever its size.** Nothing retroactively
 * invalidates the $30,000,000 lead — an accepted Bid is never reopened — so
 * the cheap Bid is the one that cannot be afforded, which is the opposite of
 * the intuition a Manager arrives with. Every assertion below still makes that
 * claim; it just makes it against Committed Bids.
 *
 * **Roster Capacity still passes, and still isolates the money.** It now does
 * so through the Outstanding Bid Allowance rather than through an overflow
 * that had to land somewhere: two projected additions against one Free
 * Active/Bench Slot is exactly the allowance, so the slots gate passes while
 * reporting that Roster Count *would be* 13 of 12. FR-37 is explicit that the
 * allowance is not a thirteenth Slot and FR-40 cancels the surplus the moment
 * a win leaves it nowhere to land.
 *
 * **One thing was genuinely LOST, and it is recorded here rather than quietly
 * dropped.** The old refusal named the specific earlier Auction creating the
 * exposure — "Ausar Bright", "$30.0M" — because FR-35 required it and
 * `exposingBids` carried it. Committed Bids has no equivalent itemisation, so
 * the refusal now reads only "$1.5M exceeds your Maximum Bid of −$28.0M". The
 * `leading` list still holds every Player name, so naming them again is
 * possible and is filed as follow-up work; until it lands, the assertion below
 * pins what the Manager actually sees rather than what we would like them to.
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
	// An ORDINARY lead now. The Player is still Minor League Eligible; that
	// fact simply routes nowhere, because `teamMoneyStateFor` no longer
	// partitions and `eligibleLeading` is never written.
	leading: [
		{
			fantraxPlayerId: 'p-stash',
			playerName: 'Ausar Bright',
			amount: parseMoney(30_000_000),
			isContentionEntry: false
		}
	],
	eligibleLeading: [],
	minorLeagueOccupied: 2
};

/** The second eligible Player, with no Bid on him yet. */
const STATE: BidState = bidStateFor(null, TEAM_P, 'Auction');

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

describe('§10 example 19 — RETIRED: the cheap bid is still refused', () => {
	it('derives NO overflow and NO exposure — the mechanism is gone', () => {
		const cap = evaluate(STATE, bidOf(1_000_000), NOW).cap;

		// Minor League occupancy is still a real fact and `M` still derives; it
		// simply decides nothing about money now.
		expect(cap.freeMinorLeagueSlots).toBe(1);
		// Neither the open lead nor this Bid is counted as an eligible lead.
		expect(cap.eligibleLeadingBids).toBe(0);
		expect(cap.overflowCount).toBe(0);
		expect(cap.minorsExposure).toBe(0);
	});

	it('refuses the $1,000,000 Bid on money, with the $30.0M inside Committed Bids', () => {
		const cap = evaluate(STATE, bidOf(1_000_000), NOW).cap;

		// The identical figure the example asserted, reached by the ordinary
		// path: the lead commits its full amount, unconditionally.
		expect(cap.committedBids).toBe(30_000_000);
		expect(cap.availableCapSpace).toBe(-28_000_000);
		// Roster Count 11 plus two projected additions passes the ceiling, so
		// the reserve is $0 and Maximum Bid is the whole deficit.
		expect(cap.rosterReserve).toBe(0);
		expect(cap.maximumBid).toBe(-28_000_000);
		expect(cap.unbounded).toBe(false);
		expect(cap.passed).toBe(false);
	});

	it('no longer names the Auction holding the money — the one real loss', () => {
		const gates = evaluate(STATE, bidOf(1_000_000), NOW);
		// `exposingBids` is empty because nothing is exposed. The list that
		// named "Ausar Bright" was the exposure set, and there is no exposure.
		expect(gates.cap.exposingBids).toEqual([]);

		const detail = bidRefusalDetail({ kind: 'gates', gates });
		// What the Manager sees now: the ceiling and the offer, and no account
		// of WHERE the $30,000,000 went. `TEAM_P.leading` still carries the
		// name, so this is a gap to close rather than information the app lost.
		expect(detail).toContain('Maximum Bid');
		expect(detail).not.toContain('Ausar Bright');
		expect(detail).not.toContain('Overflow Count');
		expect(TEAM_P.leading[0]?.playerName).toBe('Ausar Bright');
	});

	it('leaves Roster Capacity passing on the ALLOWANCE, which isolates the money', () => {
		const slots = evaluate(STATE, bidOf(1_000_000), NOW).slots;

		// Two projected additions — the standing lead and this Bid — against
		// one Free Active/Bench Slot. That is exactly the allowance, so the gate
		// passes while reporting a Roster Count that WOULD be 13 of 12. FR-37
		// is explicit that the allowance is not a thirteenth Slot; FR-40 cancels
		// the surplus the moment a win leaves it nowhere to land.
		expect(slots.projectedAdditions).toBe(2);
		expect(slots.freeActiveBenchSlots).toBe(1);
		expect(slots.allowance).toBe(2);
		expect(slots.activeBenchOverflow).toBe(0);
		expect(slots.rosterCount).toBe(11);
		expect(slots.passed).toBe(true);
	});

	it('makes the money gate the SOLE ground at the smallest legal opening', () => {
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
		// Every figure the example states is unchanged in VALUE: the money held
		// is the OTHER Auction's amount, not this Bid's. Only the term it is
		// held under changed.
		expect(gates.cap.minorsExposure).toBe(0);
		expect(gates.cap.committedBids).toBe(30_000_000);
		expect(gates.cap.maximumBid).toBe(-28_000_000);

		// ...and at the literal $1,000,000 the exposure refusal is now the SOLE
		// ground. Story 3.2 made the opening gate pass that amount — it opens
		// a Minimum-Bid Contention rather than being refused for want of one —
		// so what used to be a second refusal beside `cap` is gone, and the
		// example's own claim reads more cleanly than before: the cheap bid is
		// refused on money, and on nothing else.
		expect(failedGates(evaluate(STATE, bidOf(1_000_000), NOW))).toEqual(['cap']);
	});

	it('appends nothing, and the earlier Bid is untouched', () => {
		const decided = decide(STATE, bidOf(1_500_000), NOW, null);

		expect(decided.kind).toBe('rejected');
		if (decided.kind !== 'rejected') return;
		// The refusal is about the NEW Bid. Nothing reopens, invalidates or
		// re-prices the $30,000,000 lead — it is still exactly where it was,
		// and it is still what the arithmetic was computed from.
		expect(decided.gates.cap.committedBids).toBe(30_000_000);
		expect(TEAM_P.leading).toHaveLength(1);
		expect(TEAM_P.leading[0]?.amount).toBe(30_000_000);
		expect(TEAM_P.eligibleLeading).toHaveLength(0);
	});

	it('prints a breakdown that still sums, with exposure a permanent $0', () => {
		const lines = capBreakdown(evaluate(STATE, bidOf(1_500_000), NOW).cap);
		const figureFor = (label: string) => lines.find((line) => line.label === label)?.figure;

		expect(figureFor('Cap Space')).toBe('$2.0M');
		expect(figureFor('Committed Bids')).toBe('$30.0M');
		// Still rendered, and now always zero. The term is vestigial — deleting
		// it from the breakdown is the follow-up sweep's job.
		expect(figureFor('of which Minors Exposure')).toBe('$0.0M');
		expect(figureFor('Available Cap Space')).toBe('−$28.0M');
		expect(figureFor('Roster Reserve')).toBe('$0.0M');
		expect(figureFor('Maximum Bid')).toBe('−$28.0M');
		// The counts row, now permanently at zero on both halves.
		expect(figureFor('Eligible Leading Bids 0 of 1 Free Minor League Slots')).toBe(
			'Overflow Count 0'
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
		expect(rowFor('cap')?.figure).toBe('Maximum Bid −$28.0M, offered $1.5M');
		expect(rowFor('slots')?.chip).toBe('Slots · Passed');
		// Counts, and only counts: the capacity row names the allowance without
		// naming a dollar, because the outcome it renders carries none.
		expect(rowFor('slots')?.figure).toBe(
			'your 2nd of 2 permitted bids; Roster Count would be 13 of 12'
		);
		expect(rowFor('slots')?.figure).not.toMatch(/\$/);
		// Eight since Story 3.2 added `contention`, and it reached this panel by
		// `PLACE_BID_GATES` growing — no markup change and no edit to the
		// example itself beyond the count.
		expect(rows).toHaveLength(9);
	});
});
