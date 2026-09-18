/**
 * PRD §10 example 25 — **RETIRED on 2026-09-18**, and this file is the record
 * of that plus the regression that keeps it retired.
 *
 * Example 25 existed to state that a full roster could still acquire players:
 *
 * > Team R, still at Roster Count 12, has all three Minor League Slots free.
 * > It bids $9,000,000 on a Minor League Eligible player: […] Projected
 * > Active/Bench Additions **0** — the `P = 0` branch, which needs no free
 * > Active/Bench Slot […] **Permitted**, and Maximum Bid is unbounded. It
 * > goes on to lead all three eligible auctions within its three slots, all
 * > permitted. It then bids on a fourth eligible player: […] **Refused on
 * > capacity**.
 *
 * **A Team at Roster Capacity can now bid on nobody at all.** It cannot win a
 * Free Agent straight into its minors: it has to fit him on its active roster
 * first, and Team R has no room to fit anyone. The three Free Minor League
 * Slots are real and they are useless — they can only ever receive a Player
 * the Team already holds, moved down under FR-44.
 *
 * So the FIRST bid is refused now, not the fourth, and the "until it
 * overflows" half of the example has nothing left to describe. `P = 0` is
 * unreachable for an ordinary Bid: the win projects an Active/Bench addition
 * like any other, so the branch that needed no free Slot is never taken.
 *
 * **This is example 24's Team reaching example 24's outcome, and the pair is
 * now a single case.** Example 24 refused Team R's NON-eligible Bid on
 * capacity at `12 + 1 = 13`. The eligible Bid is refused on the same ground,
 * with the same figures — and the assertion below runs both through the same
 * gates to show they are indistinguishable, which is what fails if eligibility
 * ever re-enters the capacity rule.
 *
 * **FR-37's own property survives untouched**: money makes no difference in
 * either direction. A capacity refusal quotes counts and never a dollar, and
 * Team R is refused at $0, $40,000,000 and $400,000,000 of Cap Space alike.
 * That is asserted here exactly as the example asserted it.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { ACTIVE_BENCH_SLOTS, MINOR_LEAGUE_SLOTS } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	allGatesPassed,
	bidControlState,
	bidGateReport,
	bidRefusalDetail,
	bidStateFor,
	capBreakdown,
	decide,
	evaluate,
	failedGates
} from '../../src/lib/core/rules/bidding.ts';
import type {
	BidState,
	LeadingBidElsewhere,
	TeamMoneyState
} from '../../src/lib/core/rules/bidding.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-08-27T09:00:00.000Z';

const STASH_AMOUNT = 9_000_000;

/** One eligible Auction Team R already leads, as the fold produced it. */
function stash(index: number): LeadingBidElsewhere {
	return {
		fantraxPlayerId: `p-${String(index)}`,
		playerName: `Prospect ${String(index)}`,
		amount: parseMoney(STASH_AMOUNT),
		isContentionEntry: false
	};
}

/**
 * Team R holding `led` leads: Roster Count 12, $40,000,000 of Cap Space, all
 * three Minor League Slots still FREE.
 *
 * The Slots are free throughout, and they stay free: nothing a Team wins
 * lands in one. They are the example's setup kept verbatim so the retirement
 * can state that they no longer buy Team R anything.
 *
 * The leads are ORDINARY commitments now — `teamMoneyStateFor` never writes
 * `eligibleLeading`, so a fixture that filled it would be asserting against a
 * state the core cannot produce.
 */
function teamR(led: number): TeamMoneyState {
	return {
		capSpace: parseMoney(40_000_000),
		rosterCount: 12,
		leading: Array.from({ length: led }, (_unused, index) => stash(index + 1)),
		eligibleLeading: [],
		minorLeagueOccupied: 0
	};
}

/** The next eligible Player, with no Bid on him yet. */
function stateAfter(led: number): BidState {
	return bidStateFor(null, teamR(led), 'Auction');
}

function bidOf(amount: number, fantraxPlayerId: string): PlaceBid {
	return {
		kind: 'PlaceBid',
		fantraxPlayerId,
		teamId: 't-r',
		teamName: 'Team R',
		managerId: 'm-r',
		amount: parseMoney(amount)
	};
}

describe('§10 example 25 — RETIRED: the full roster cannot stash', () => {
	it('REFUSES the first stash — 12 + 1 = 13, with no free Active/Bench Slot', () => {
		const gates = evaluate(stateAfter(0), bidOf(STASH_AMOUNT, 'p-1'), NOW);

		// The three Minor League Slots are still free, and they buy nothing:
		// a win cannot land in one.
		expect(gates.cap.freeMinorLeagueSlots).toBe(MINOR_LEAGUE_SLOTS);
		expect(gates.cap.eligibleLeadingBids).toBe(0);
		expect(gates.cap.overflowCount).toBe(0);
		expect(gates.cap.minorsExposure).toBe(0);
		expect(gates.cap.unbounded).toBe(false);

		// `P = 0` is unreachable: the win projects an Active/Bench addition
		// like any other, so the branch that needed no free Slot is not taken.
		expect(gates.slots.projectedAdditions).toBe(1);
		expect(gates.slots.rosterCount).toBe(ACTIVE_BENCH_SLOTS);
		expect(gates.slots.freeActiveBenchSlots).toBe(0);
		expect(gates.slots.passed).toBe(false);
		expect(allGatesPassed(gates)).toBe(false);

		// "even though the money is there" — capacity is the SOLE ground, and
		// that much is unchanged from the example.
		expect(failedGates(gates)).toEqual(['slots']);
		expect(gates.cap.passed).toBe(true);
	});

	it("refuses all four identically — there is no 'until it overflows'", () => {
		// The example's sequence was three permitted and a fourth refused.
		// Every one of them is refused now, on the same ground and with the
		// same figures, because the ground was never really about minors.
		for (const led of [0, 1, 2, 3]) {
			const command = bidOf(STASH_AMOUNT, `p-${String(led + 1)}`);
			const gates = evaluate(stateAfter(led), command, NOW);

			expect(gates.slots.projectedAdditions, String(led)).toBe(led + 1);
			expect(gates.slots.freeActiveBenchSlots, String(led)).toBe(0);
			expect(gates.slots.activeBenchOverflow, String(led)).toBe(0);
			expect(gates.slots.passed, String(led)).toBe(false);
			expect(failedGates(gates), String(led)).toEqual(['slots']);
			expect(decide(stateAfter(led), command, NOW, null).kind, String(led)).toBe('rejected');
		}
	});

	it("is EXAMPLE 24's case — eligible and non-eligible refuse identically", () => {
		// Example 24 refused Team R's non-eligible Bid at `12 + 1 = 13`. The
		// states are built the same way because they cannot be built
		// differently: `bidStateFor` takes no eligibility. If it ever does
		// again, these two stop matching.
		const eligible = evaluate(stateAfter(0), bidOf(STASH_AMOUNT, 'p-1'), NOW);
		const notEligible = evaluate(
			bidStateFor(null, teamR(0), 'Auction'),
			bidOf(STASH_AMOUNT, 'p-1'),
			NOW
		);

		expect(eligible).toEqual(notEligible);
		expect(failedGates(notEligible)).toEqual(['slots']);
	});

	it('names the refusal in COUNTS alone, with no cap figure anywhere in it', () => {
		const gates = evaluate(stateAfter(0), bidOf(STASH_AMOUNT, 'p-1'), NOW);
		const detail = bidRefusalDetail({ kind: 'gates', gates });

		expect(detail).toContain('no roster slot');
		expect(detail).toContain('no free Active/Bench Slot');
		expect(detail).toContain('Roster Capacity of 12');
		// A capacity refusal that quoted a cap figure as its ground would be
		// the defect AD-7 names. There is no amount on the outcome to quote.
		expect(detail).not.toContain('Maximum Bid');
		expect(detail).not.toContain('Minors Exposure');
		expect(detail).not.toMatch(/\$\d/);
	});

	it('offers no Slot Placement carve-out — and money makes no difference', () => {
		// FR-37's own property, kept verbatim from the example: there is no
		// state in which this Bid is permitted on the promise that a close
		// will sort it out, and Cap Space moves nothing in either direction.
		for (const capSpace of [0, 40_000_000, 400_000_000]) {
			const state = bidStateFor(null, { ...teamR(0), capSpace: parseMoney(capSpace) }, 'Auction');
			const gates = evaluate(state, bidOf(STASH_AMOUNT, 'p-1'), NOW);

			expect(gates.slots.passed, String(capSpace)).toBe(false);
			expect(gates.slots.freeActiveBenchSlots, String(capSpace)).toBe(0);
			expect(decide(state, bidOf(STASH_AMOUNT, 'p-1'), NOW, null).kind, String(capSpace)).toBe(
				'rejected'
			);
		}
	});

	it('reports both gates, the money one passing with its own arithmetic', () => {
		const gates = evaluate(stateAfter(3), bidOf(STASH_AMOUNT, 'p-4'), NOW);
		const rows = bidGateReport(gates);
		const rowFor = (gate: string) => rows.find((row) => row.gate === gate);

		expect(rowFor('slots')?.chip).toBe('Slots · Refused');
		expect(rowFor('slots')?.figure).toBe(
			'no free Active/Bench Slot; Roster Count would be 16 of 12'
		);
		expect(rowFor('cap')?.chip).toBe('Cap · Passed');
		// Three $9,000,000 leads are committed in full, so $27,000,000 is held
		// against $40,000,000 of room and the money gate clears at $13,000,000.
		expect(gates.cap.committedBids).toBe(27_000_000);
		expect(gates.cap.minorsExposure).toBe(0);
		expect(gates.cap.maximumBid).toBe(13_000_000);
		// Eight since Story 3.2 added `contention` to `PLACE_BID_GATES`,
		// and it reached this panel by the list growing and nothing else.
		expect(rows).toHaveLength(9);
	});

	it('exposes nothing, so there is no tie left to break', () => {
		// The example broke a four-way $9,000,000 tie on Player id to decide
		// which Auction the overflow set held. There is no overflow set.
		const gates = evaluate(stateAfter(3), bidOf(STASH_AMOUNT, 'p-4'), NOW);

		expect(gates.cap.exposingBids).toEqual([]);
		expect(gates.cap.overflowCount).toBe(0);
	});

	it("arrives on the board BLOCKED — example 24's control, not its mirror", () => {
		// Example 24's Team R rendered every non-eligible Auction with its
		// control disabled and the reason stated, and this file used to render
		// an eligible one live. The same Team now arrives blocked on both,
		// before anything is typed: a standing condition read on arrival,
		// never discovered at submission.
		const ask = (led: number, fantraxPlayerId: string) =>
			bidControlState({
				state: stateAfter(led),
				fantraxPlayerId,
				viewerTeamId: 't-r',
				amountText: '1.5',
				confirmed: true,
				now: ''
			});

		expect(ask(0, 'p-1').blocked).toBe(true);
		expect(ask(0, 'p-1').refusingGates).toEqual(['slots']);

		expect(ask(3, 'p-4').blocked).toBe(true);
		expect(ask(3, 'p-4').refusingGates).toEqual(['slots']);
	});

	it('shows a NUMBER on every bid, and "no cap limit" on none', () => {
		const first = capBreakdown(evaluate(stateAfter(0), bidOf(STASH_AMOUNT, 'p-1'), NOW).cap);
		const fourth = capBreakdown(evaluate(stateAfter(3), bidOf(STASH_AMOUNT, 'p-4'), NOW).cap);
		const figureFor = (lines: typeof first, label: string) =>
			lines.find((line) => line.label === label)?.figure;

		// The words are unreachable: nothing is unbounded any more.
		expect(figureFor(first, 'Maximum Bid')).toBe('$40.0M');
		expect(figureFor(fourth, 'Maximum Bid')).toBe('$13.0M');
	});
});
