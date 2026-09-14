/**
 * PRD §10 example 30 — **The allowance needs a slot to extend** (AD-25).
 *
 * > Team T has Roster Count 12, no free Minor League Slots, $40,000,000 of
 * > Cap Space, and leads nothing. It bids $5,000,000 on a non-eligible
 * > player. Projected Active/Bench Additions is 1, so the `P = 0` branch
 * > does not apply, and Free Active/Bench Slots is 0, so the precondition
 * > fails. **Refused on capacity.** Read the arithmetic that *would* have
 * > applied: `Free Active/Bench Slots + 1 = 0 + 1 = 1`, and `P = 1 ≤ 1` —
 * > the bid would have been admitted, Team T would have won a thirteenth
 * > player, and no other close would have existed to cancel it. This is
 * > example 24's lesson stated as arithmetic, and it is the reason the rule
 * > is not a flat ceiling of 13.
 *
 * **The counterfactual is the whole example, so this file asserts it.** The
 * gate reports `allowance` as the raw `F + 1` even here, where it permits
 * nothing — that is deliberate, because a figure clamped to 0 would hide
 * exactly the arithmetic a reader has to see to understand why the ordering
 * of the two conjuncts matters. `evaluateSlots` tests `F >= 1` BEFORE
 * `P <= A`, and if those two were ever swapped every test below would still
 * pass except the one that reads the verdict.
 *
 * **And the wording must not quote it.** Telling Team T that "1 bid is
 * permitted" while permitting none is precisely the confusion UX-DR32's two
 * separate refusal sentences exist to avoid. The precondition sentence names
 * the missing Slot; the allowance sentence — §10 example 29's — names the
 * count. They are never the same string.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import {
	ACTIVE_BENCH_SLOTS,
	MINOR_LEAGUE_SLOTS,
	OUTSTANDING_BID_ALLOWANCE
} from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	bidControlState,
	bidGateReport,
	bidRefusalDetail,
	bidStateFor,
	decide,
	evaluate,
	failedGates
} from '../../src/lib/core/rules/bidding.ts';
import type { BidState, TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-08-27T09:00:00.000Z';

/**
 * Team T: twelve Active/Bench Slots filled, all three Minor League Slots
 * occupied, $40,000,000 of Cap Space, leading nothing.
 *
 * "No free Minor League Slots" is what closes the last door: with `M = 0`
 * even an eligible Player would overflow into Active/Bench, so there is no
 * state in which this Team's next win lands anywhere but a Slot it does not
 * have.
 */
const TEAM_T: TeamMoneyState = {
	capSpace: parseMoney(40_000_000),
	rosterCount: 12,
	leading: [],
	eligibleLeading: [],
	minorLeagueOccupied: MINOR_LEAGUE_SLOTS
};

/** A nominated Player nobody has bid on, and not Minor League Eligible. */
const STATE: BidState = bidStateFor(null, TEAM_T, false, 'Auction');

function bidOf(amount: number): PlaceBid {
	return {
		kind: 'PlaceBid',
		fantraxPlayerId: 'p-1',
		teamId: 't-t',
		teamName: 'Team T',
		managerId: 'm-t',
		amount: parseMoney(amount)
	};
}

describe('§10 example 30 — the allowance needs a slot to extend', () => {
	it('refuses on capacity: P = 1 is not the zero branch, and F = 0 fails the precondition', () => {
		const gates = evaluate(STATE, bidOf(5_000_000), NOW);

		expect(gates.slots.rosterCount).toBe(12);
		// "Projected Active/Bench Additions is 1, so the `P = 0` branch does
		// not apply" — the Player is not eligible, so the win must land in
		// Active/Bench.
		expect(gates.slots.projectedAdditions).toBe(1);
		expect(gates.slots.freeMinorLeagueSlots).toBe(0);
		// "Free Active/Bench Slots is 0, so the precondition fails."
		expect(gates.slots.freeActiveBenchSlots).toBe(0);
		expect(gates.slots.passed).toBe(false);
		expect(failedGates(gates)).toEqual(['slots']);
		expect(decide(STATE, bidOf(5_000_000), NOW, null).kind).toBe('rejected');
	});

	it('reports the COUNTERFACTUAL arithmetic that would have admitted the bid', () => {
		// "Read the arithmetic that would have applied: `Free Active/Bench
		// Slots + 1 = 0 + 1 = 1`, and `P = 1 <= 1`." This is the assertion
		// the example exists for: the allowance is reported RAW, and on its
		// own it says yes.
		const gates = evaluate(STATE, bidOf(5_000_000), NOW);
		const free = gates.slots.freeActiveBenchSlots ?? -1;
		const allowance = gates.slots.allowance ?? -1;
		const projected = gates.slots.projectedAdditions ?? -1;

		expect(free).toBe(0);
		expect(allowance).toBe(free + OUTSTANDING_BID_ALLOWANCE);
		expect(allowance).toBe(1);
		// The allowance arithmetic ALONE admits it...
		expect(projected <= allowance).toBe(true);
		// ...and the precondition, tested first, is what refuses it anyway.
		expect(free >= 1).toBe(false);
		expect(gates.slots.passed).toBe(false);
	});

	it('is not a flat ceiling of 13 — the thirteenth win is what the precondition prevents', () => {
		// Had the gate been written as `rosterCount + projectedAdditions <=
		// 13`, this bid would pass at `12 + 1 = 13`. The ceiling reported on
		// the refusal is still 12, and that is the figure the rule defends.
		const gates = evaluate(STATE, bidOf(5_000_000), NOW);
		const wouldBe = (gates.slots.rosterCount ?? 0) + (gates.slots.projectedAdditions ?? 0);

		expect(wouldBe).toBe(13);
		expect(gates.slots.ceiling).toBe(ACTIVE_BENCH_SLOTS);
		expect(gates.slots.ceiling).toBe(12);
		expect(gates.slots.passed).toBe(false);
	});

	it('words it as the PRECONDITION, and never quotes the allowance it did not grant', () => {
		const detail = bidRefusalDetail({
			kind: 'gates',
			gates: evaluate(STATE, bidOf(5_000_000), NOW)
		});

		expect(detail).toContain('no free Active/Bench Slot');
		expect(detail).toContain('no bid on this Player is permitted');
		expect(detail).toContain('Roster Count is 12');
		expect(detail).toContain('Roster Capacity of 12');
		// "1 permitted" while permitting none is the failure the two
		// sentences exist to avoid.
		expect(detail).not.toContain('permits');
		expect(detail).not.toContain('outstanding bid');
		// Capacity, not money — Maximum Bid here is a healthy $40.0M (AD-7).
		expect(detail).not.toContain('Maximum Bid');
		expect(detail).not.toMatch(/\$\d/);
	});

	it('carries the same distinction onto the row and the board control', () => {
		const row = bidGateReport(evaluate(STATE, bidOf(5_000_000), NOW)).find(
			(entry) => entry.gate === 'slots'
		);
		expect(row?.chip).toBe('Slots · Refused');
		expect(row?.figure).toBe('no free Active/Bench Slot; Roster Count would be 13 of 12');
		expect(row?.figure).not.toContain('permitted');

		const control = bidControlState({
			state: STATE,
			fantraxPlayerId: 'p-1',
			viewerTeamId: 't-t',
			amountText: '5',
			confirmed: true,
			now: ''
		});
		expect(control.blocked).toBe(true);
		expect(control.refusingGates).toEqual(['slots']);
		expect(control.detail).toContain('no free Active/Bench Slot');
	});

	it('holds at every amount, and gains nothing from an override above the ceiling', () => {
		// The money makes no difference in either direction (FR-37), and a
		// Team a Commissioner put at Roster Count 13 is refused on the same
		// ground rather than rewarded: `unfilledSlots`' clamp keeps `F` at 0
		// instead of letting it go negative.
		for (const capSpace of [0, 40_000_000, 400_000_000]) {
			const state = bidStateFor(null, { ...TEAM_T, capSpace: parseMoney(capSpace) }, false, 'Auction');
			expect(evaluate(state, bidOf(5_000_000), NOW).slots.passed, String(capSpace)).toBe(false);
		}

		const overridden = evaluate(
			bidStateFor(null, { ...TEAM_T, rosterCount: 13 }, false, 'Auction'),
			bidOf(5_000_000),
			NOW
		);
		expect(overridden.slots.freeActiveBenchSlots).toBe(0);
		expect(overridden.slots.allowance).toBe(1);
		expect(overridden.slots.passed).toBe(false);
	});
});
