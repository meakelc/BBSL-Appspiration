/**
 * PRD §10 example 25 — **The same full roster can still stash, until it
 * overflows** (AD-25).
 *
 * > Team R, still at Roster Count 12, has all three Minor League Slots free.
 * > It bids $9,000,000 on a Minor League Eligible player: `N+1 = 1 ≤ M = 3`,
 * > Overflow Count 0, Projected Active/Bench Additions 0, capacity
 * > `12 + 0 = 12 ≤ 12` — **permitted**, and Maximum Bid is unbounded. It goes
 * > on to lead all three eligible auctions within its three slots, all
 * > permitted. It then bids on a fourth eligible player: `N = 4` against
 * > `M = 3`, Overflow Count 1, so Projected Active/Bench Additions is 1 and
 * > capacity is `12 + 1 = 13 > 12`. **Refused on capacity**, naming the
 * > overflow — even though the money is there. There is no carve-out for
 * > automatic Slot Placement: an overflow with nowhere to land is refused at
 * > the bid, not resolved at the close.
 *
 * **This is example 24's Team, one story later, and the pair is the point.**
 * Example 24 refused Team R's non-eligible Bid on capacity at `12 + 1 = 13`.
 * The same Team, the same roster and the same money is permitted here,
 * because an eligible win a Free Minor League Slot absorbs adds nothing to
 * Active/Bench — and is refused again on the fourth, because the fourth has
 * nowhere to land.
 *
 * **`Overflow Count` is what makes that a rule rather than a carve-out.** The
 * capacity gate never learns what any of these Bids cost: it reaches the
 * overflow through `minorsCountsFor`, which returns three integers. FR-37's
 * "a Team can fail it with unlimited Cap Space and pass it with none" is
 * therefore still a property of the signature, and the last test here is that
 * property holding across the whole sequence.
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
import type { BidState, LeadingBidElsewhere, TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-08-27T09:00:00.000Z';

const STASH_AMOUNT = 9_000_000;

/** One eligible Auction Team R already leads, as the fold produced it. */
function stash(index: number): LeadingBidElsewhere {
	return {
		fantraxPlayerId: `p-${String(index)}`,
		playerName: `Prospect ${String(index)}`,
		amount: parseMoney(STASH_AMOUNT)
	};
}

/**
 * Team R after `led` accepted stashes: Roster Count 12, $40,000,000 of Cap
 * Space, all three Minor League Slots still FREE.
 *
 * The Slots are free throughout, and that is the example's own setup: the
 * Auctions are still open, so no Player has been placed in one yet. What
 * consumes them is `N`, the post-bid count of Eligible Leading Bids — not
 * occupancy.
 */
function teamR(led: number): TeamMoneyState {
	return {
		capSpace: parseMoney(40_000_000),
		rosterCount: 12,
		leading: [],
		eligibleLeading: Array.from({ length: led }, (_unused, index) => stash(index + 1)),
		minorLeagueOccupied: 0
	};
}

/** The next eligible Player, with no Bid on him yet. */
function stateAfter(led: number): BidState {
	return bidStateFor(null, teamR(led), true);
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

describe('§10 example 25 — the full roster can still stash', () => {
	it('permits the first stash at 12 + 0 = 12, unbounded, with N = 1 ≤ M = 3', () => {
		const gates = evaluate(stateAfter(0), bidOf(STASH_AMOUNT, 'p-1'), NOW);

		expect(gates.cap.freeMinorLeagueSlots).toBe(MINOR_LEAGUE_SLOTS);
		expect(gates.cap.eligibleLeadingBids).toBe(1);
		expect(gates.cap.overflowCount).toBe(0);
		expect(gates.cap.minorsExposure).toBe(0);
		expect(gates.cap.unbounded).toBe(true);
		// "Projected Active/Bench Additions 0" — the win goes to minors.
		expect(gates.slots.projectedAdditions).toBe(0);
		expect(gates.slots.rosterCount).toBe(ACTIVE_BENCH_SLOTS);
		expect(gates.slots.passed).toBe(true);
		expect(allGatesPassed(gates)).toBe(true);
	});

	it('permits all three, each within the three Slots', () => {
		// "It goes on to lead all three eligible auctions within its three
		// slots, all permitted." Asserted as the sequence it is: `N` climbing
		// to `M` and stopping there.
		for (const led of [0, 1, 2]) {
			const gates = evaluate(
				stateAfter(led),
				bidOf(STASH_AMOUNT, `p-${String(led + 1)}`),
				NOW
			);

			expect(gates.cap.eligibleLeadingBids, String(led)).toBe(led + 1);
			expect(gates.cap.overflowCount, String(led)).toBe(0);
			expect(gates.cap.unbounded, String(led)).toBe(true);
			expect(gates.slots.projectedAdditions, String(led)).toBe(0);
			expect(allGatesPassed(gates), String(led)).toBe(true);
			expect(decide(stateAfter(led), bidOf(STASH_AMOUNT, `p-${String(led + 1)}`), NOW, null).kind)
				.toBe('accepted');
		}
	});

	it('refuses the FOURTH on capacity: N = 4 against M = 3, Overflow 1, 13 > 12', () => {
		const gates = evaluate(stateAfter(3), bidOf(STASH_AMOUNT, 'p-4'), NOW);

		expect(gates.slots.eligibleLeadingBids).toBe(4);
		expect(gates.slots.freeMinorLeagueSlots).toBe(3);
		expect(gates.slots.overflowCount).toBe(1);
		// The overflow has nowhere in the minors to land, so it counts here.
		expect(gates.slots.projectedAdditions).toBe(1);
		expect(gates.slots.rosterCount).toBe(12);
		expect(gates.slots.passed).toBe(false);
		// "even though the money is there" — capacity is the SOLE ground.
		expect(failedGates(gates)).toEqual(['slots']);
		expect(gates.cap.passed).toBe(true);
	});

	it('names the overflow in COUNTS alone, with no cap figure anywhere in it', () => {
		const gates = evaluate(stateAfter(3), bidOf(STASH_AMOUNT, 'p-4'), NOW);
		const detail = bidRefusalDetail({ kind: 'gates', gates });

		expect(detail).toContain('no roster slot');
		expect(detail).toContain('Roster Capacity of 12');
		expect(detail).toContain('Overflow Count of 1');
		expect(detail).toContain('Eligible Leading Bids 4');
		expect(detail).toContain('Free Minor League Slots 3');
		// A capacity refusal that quoted a cap figure as its ground would be
		// the defect AD-7 names. There is no amount on the outcome to quote.
		expect(detail).not.toContain('Maximum Bid');
		expect(detail).not.toContain('Minors Exposure');
		expect(detail).not.toMatch(/\$\d/);
	});

	it('offers no Slot Placement carve-out — the overflow is refused at the Bid', () => {
		// There is no state in which a fourth eligible lead is permitted on
		// the promise that a close will sort it out. Money makes no difference
		// in either direction, which is FR-37's own property.
		for (const capSpace of [0, 40_000_000, 400_000_000]) {
			const state = bidStateFor(null, { ...teamR(3), capSpace: parseMoney(capSpace) }, true);
			const gates = evaluate(state, bidOf(STASH_AMOUNT, 'p-4'), NOW);

			expect(gates.slots.passed, String(capSpace)).toBe(false);
			expect(gates.slots.overflowCount, String(capSpace)).toBe(1);
			expect(decide(state, bidOf(STASH_AMOUNT, 'p-4'), NOW, null).kind, String(capSpace)).toBe(
				'rejected'
			);
		}
	});

	it('reports both gates, the money one passing with its own arithmetic', () => {
		const gates = evaluate(stateAfter(3), bidOf(STASH_AMOUNT, 'p-4'), NOW);
		const rows = bidGateReport(gates);
		const rowFor = (gate: string) => rows.find((row) => row.gate === gate);

		expect(rowFor('slots')?.chip).toBe('Slots · Refused');
		expect(rowFor('slots')?.figure).toBe('Roster Count would be 13 of 12, Overflow Count 1');
		expect(rowFor('cap')?.chip).toBe('Cap · Passed');
		// The Overflow Count rides the cap row even when the cap gate PASSED.
		// Asserted on the row's own text, not merely on the outcome behind it:
		// guarding the suffix behind `!outcome.passed` would otherwise strip a
		// Manager's only explanation of why $9.0M is committed on a Team with
		// $40.0M of room, and nothing would fail.
		expect(rowFor('cap')?.figure).toContain('Overflow Count 1');
		// One of the four $9.0M eligible Bids overflows, so exposure is $9.0M
		// — a real figure the money gate still clears at $40.0M of room.
		expect(gates.cap.minorsExposure).toBe(STASH_AMOUNT);
		expect(gates.cap.maximumBid).toBe(31_000_000);
		// Seven since Story 3.1 added `expiry` to `PLACE_BID_GATES`.
		expect(rows).toHaveLength(7);
	});

	it('breaks the tie on Player id, so the figure and the naming are deterministic', () => {
		// All four amounts are $9,000,000, so the sort's tiebreak is the only
		// thing deciding which Auction the overflow set holds. Ascending id
		// (AD-5), evaluated twice to state that it does not move.
		const gates = evaluate(stateAfter(3), bidOf(STASH_AMOUNT, 'p-4'), NOW);
		const again = evaluate(stateAfter(3), bidOf(STASH_AMOUNT, 'p-4'), NOW);

		expect(gates.cap.exposingBids).toEqual([
			{ fantraxPlayerId: 'p-1', playerName: 'Prospect 1', amount: STASH_AMOUNT }
		]);
		expect(again.cap.exposingBids).toEqual(gates.cap.exposingBids);
	});

	it('arrives on the board ENABLED — the mirror of example 24’s disabled control', () => {
		// Example 24's Team R renders every non-eligible Auction with its
		// control disabled and the reason stated. The SAME Team, at the same
		// Roster Count of 12, renders an eligible one with the control live —
		// and is refused again on the fourth, before anything is typed. Both
		// are standing conditions read on arrival, never discovered at
		// submission.
		const ask = (led: number, fantraxPlayerId: string) =>
			bidControlState({
				state: stateAfter(led),
				fantraxPlayerId,
				viewerTeamId: 't-r',
				amountText: '1500000',
				confirmed: true,
				now: ''
			});

		expect(ask(0, 'p-1').blocked).toBe(false);
		expect(ask(0, 'p-1').refusingGates).toEqual([]);

		expect(ask(3, 'p-4').blocked).toBe(true);
		expect(ask(3, 'p-4').refusingGates).toEqual(['slots']);
		expect(ask(3, 'p-4').detail).toContain('Overflow Count of 1');
	});

	it('shows "no cap limit" on the first stash and a number on the fourth', () => {
		const first = capBreakdown(evaluate(stateAfter(0), bidOf(STASH_AMOUNT, 'p-1'), NOW).cap);
		const fourth = capBreakdown(evaluate(stateAfter(3), bidOf(STASH_AMOUNT, 'p-4'), NOW).cap);
		const figureFor = (lines: typeof first, label: string) =>
			lines.find((line) => line.label === label)?.figure;

		expect(figureFor(first, 'Maximum Bid')).toBe('no cap limit');
		expect(figureFor(fourth, 'Maximum Bid')).toBe('$31.0M');
	});
});
