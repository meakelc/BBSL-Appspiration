/**
 * PRD §10 example 29 — **The allowance, in the ordinary case** (AD-25).
 *
 * > Team S has Roster Count 11, $20,000,000 of Cap Space, no minor-league
 * > involvement, and already leads one non-eligible auction at $6,000,000.
 * > Free Active/Bench Slots is 1. It bids on a second non-eligible player:
 * > Projected Active/Bench Additions is `1 (the existing lead) + 1 (this
 * > bid) = 2`, and `2 ≤ 1 + 1`, so capacity **passes**. Roster Reserve is
 * > `$1,000,000 × max(0, 12 − (11 + 2)) = $0` — the clamp doing real work
 * > for the first time — Available Cap Space is $14,000,000, and Maximum Bid
 * > is $14,000,000. **Under the pre-2026-09-08 rule this bid was refused** at
 * > `11 + 2 = 13 > 12`; the allowance is exactly the difference. A *third*
 * > outstanding bid gives `P = 3 > 2` and is **refused on capacity**, with
 * > the message stating that the allowance is already spent rather than
 * > implying the Team is out of slots.
 *
 * **This is the example the whole of Epic 10 exists for.** Before it, a
 * Manager with one open Slot could hold exactly one outstanding Bid and then
 * idled for a day waiting on a close they could not influence. The file
 * asserts the pass, the figure the Team is shown while it holds two, and the
 * refusal of the third — and it asserts that the third's wording says the
 * ALLOWANCE is spent rather than that the roster is full, because those are
 * two different facts with two different remedies.
 *
 * **The clamp is the quiet half.** `max(0, 12 − 13)` is evaluated here with
 * no Commissioner override anywhere near it, which is new: until Story 10.1
 * both `unfilledSlots` and `evaluateCap` documented the clamp as an
 * override-only safeguard. A negative reserve would hand this Team extra
 * spending power for holding two bids, which is the opposite of the rule.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { ACTIVE_BENCH_SLOTS, OUTSTANDING_BID_ALLOWANCE } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	allGatesPassed,
	bidControlState,
	bidGateReport,
	bidRefusalDetail,
	bidStateFor,
	decide,
	evaluate,
	failedGates
} from '../../src/lib/core/rules/bidding.ts';
import type { BidState, LeadingBidElsewhere, TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-08-27T09:00:00.000Z';

/** One non-eligible Auction Team S already leads, as the fold produced it. */
function lead(index: number, amount: number): LeadingBidElsewhere {
	return {
		fantraxPlayerId: `p-${String(index)}`,
		playerName: `Player ${String(index)}`,
		amount: parseMoney(amount),
		isContentionEntry: false
	};
}

/**
 * Team S after `led` accepted non-eligible leads: Roster Count 11,
 * $20,000,000 of Cap Space, no minor-league involvement at all.
 *
 * The example names one lead at $6,000,000; a second and third are the same
 * shape at the same price, so the committed capital stays easy to read.
 */
function teamS(led: number): TeamMoneyState {
	return {
		capSpace: parseMoney(20_000_000),
		rosterCount: 11,
		leading: Array.from({ length: led }, (_unused, index) => lead(index + 1, 6_000_000)),
		// "no minor-league involvement" — `N` is 0 and `M` is the full three,
		// so nothing overflows and the Minors arithmetic is inert throughout.
		eligibleLeading: [],
		minorLeagueOccupied: 0
	};
}

/** The next non-eligible Player, with no Bid on him yet. */
function stateAfter(led: number): BidState {
	return bidStateFor(null, teamS(led), false, 'Auction');
}

function bidOf(amount: number, fantraxPlayerId: string): PlaceBid {
	return {
		kind: 'PlaceBid',
		fantraxPlayerId,
		teamId: 't-s',
		teamName: 'Team S',
		managerId: 'm-s',
		amount: parseMoney(amount)
	};
}

describe('§10 example 29 — the allowance, in the ordinary case', () => {
	it('passes the SECOND outstanding bid at P = 2 against F = 1 plus the allowance', () => {
		const gates = evaluate(stateAfter(1), bidOf(1_500_000, 'p-2'), NOW);

		expect(gates.slots.rosterCount).toBe(11);
		// "1 (the existing lead) + 1 (this bid) = 2".
		expect(gates.slots.projectedAdditions).toBe(2);
		// "Free Active/Bench Slots is 1", and the allowance is that plus one.
		expect(gates.slots.freeActiveBenchSlots).toBe(1);
		expect(gates.slots.allowance).toBe(1 + OUTSTANDING_BID_ALLOWANCE);
		// `2 <= 2`.
		expect(gates.slots.passed).toBe(true);
		// The ceiling is reported on the pass too, and is still 12: a Team
		// holding two outstanding bids may still only win twelve players.
		expect(gates.slots.ceiling).toBe(ACTIVE_BENCH_SLOTS);
		expect(allGatesPassed(gates)).toBe(true);
		expect(decide(stateAfter(1), bidOf(1_500_000, 'p-2'), NOW, null).kind).toBe('accepted');
	});

	it('is EXACTLY the difference the rule change made — 11 + 2 = 13 was the old refusal', () => {
		// The pre-2026-09-08 rule was `rosterCount + projectedAdditions <=
		// 12`, and this state fails it. Stated as arithmetic rather than as
		// prose so that a revert to the one-comparison gate cannot pass this
		// file quietly.
		const gates = evaluate(stateAfter(1), bidOf(1_500_000, 'p-2'), NOW);
		const projected = (gates.slots.rosterCount ?? 0) + (gates.slots.projectedAdditions ?? 0);

		expect(projected).toBe(13);
		expect(projected > ACTIVE_BENCH_SLOTS).toBe(true);
		expect(gates.slots.passed).toBe(true);
	});

	it('leaves Roster Reserve at $0 through the CLAMP, in ordinary play', () => {
		// `$1,000,000 × max(0, 12 − (11 + 2))`. No Commissioner override is
		// involved: the allowance alone takes the projection past twelve, so
		// the clamp is load-bearing in the ordinary case and not merely a
		// safeguard against an override that has not happened.
		const gates = evaluate(stateAfter(1), bidOf(1_500_000, 'p-2'), NOW);

		expect(gates.cap.rosterCount).toBe(11);
		expect(gates.cap.projectedAdditions).toBe(2);
		expect(gates.cap.rosterReserve).toBe(0);
		// "Available Cap Space is $14,000,000, and Maximum Bid is
		// $14,000,000" — $20.0M less the $6.0M already committed.
		expect(gates.cap.committedBids).toBe(6_000_000);
		expect(gates.cap.availableCapSpace).toBe(14_000_000);
		expect(gates.cap.maximumBid).toBe(14_000_000);
		expect(gates.cap.passed).toBe(true);
	});

	it('refuses the THIRD outstanding bid at P = 3 against an allowance of 2', () => {
		const gates = evaluate(stateAfter(2), bidOf(1_500_000, 'p-3'), NOW);

		expect(gates.slots.projectedAdditions).toBe(3);
		expect(gates.slots.freeActiveBenchSlots).toBe(1);
		expect(gates.slots.allowance).toBe(2);
		expect(gates.slots.passed).toBe(false);
		// Capacity is the sole ground: $20.0M against $12.0M committed leaves
		// the money comfortable, which is what isolates the allowance.
		expect(failedGates(gates)).toEqual(['slots']);
		expect(gates.cap.passed).toBe(true);
		expect(decide(stateAfter(2), bidOf(1_500_000, 'p-3'), NOW, null).kind).toBe('rejected');
	});

	it('says the ALLOWANCE is spent, not that the Team is out of slots', () => {
		// The example's own words: "with the message stating that the
		// allowance is already spent rather than implying the Team is out of
		// slots". Team S has a free Slot; a sentence saying otherwise would
		// be false, and would send this Manager looking for the wrong remedy.
		const detail = bidRefusalDetail({
			kind: 'gates',
			gates: evaluate(stateAfter(2), bidOf(1_500_000, 'p-3'), NOW)
		});

		expect(detail).toContain('your 3rd outstanding bid');
		expect(detail).toContain('1 free Active/Bench Slot permits 2');
		// The ceiling is still quoted: a refusal naming only the allowance
		// would imply thirteen players are legal.
		expect(detail).toContain('Roster Capacity of 12');
		// It must NOT claim there is no free Slot — that is the OTHER
		// refusal, and §10 example 30 is the Team it belongs to.
		expect(detail).not.toContain('no free Active/Bench Slot');
		// And no money figure, on either refusal (AD-7).
		expect(detail).not.toContain('Maximum Bid');
		expect(detail).not.toMatch(/\$\d/);
	});

	it('shows the permitted-bid count on the row, passing and refused alike', () => {
		const figureFor = (led: number, fantraxPlayerId: string) =>
			bidGateReport(evaluate(stateAfter(led), bidOf(1_500_000, fantraxPlayerId), NOW)).find(
				(row) => row.gate === 'slots'
			);

		const first = figureFor(0, 'p-1');
		expect(first?.chip).toBe('Slots · Passed');
		expect(first?.figure).toBe('your 1st of 2 permitted bids; Roster Count would be 12 of 12');

		// At the allowance the projection legitimately reads past the
		// ceiling, and the clause in front of it is what keeps `13 of 12`
		// beside a `Passed` chip from reading as a contradiction.
		const second = figureFor(1, 'p-2');
		expect(second?.chip).toBe('Slots · Passed');
		expect(second?.figure).toBe('your 2nd of 2 permitted bids; Roster Count would be 13 of 12');

		const third = figureFor(2, 'p-3');
		expect(third?.chip).toBe('Slots · Refused');
		expect(third?.figure).toBe(
			'your 3rd outstanding bid against 2 permitted; Roster Count would be 14 of 12'
		);
	});

	it('states both on the board, before anything is typed', () => {
		// The allowance is a standing condition like every other capacity
		// fact: the second Auction's control is live and the third's is
		// blocked, both known when the page renders.
		const ask = (led: number, fantraxPlayerId: string) =>
			bidControlState({
				state: stateAfter(led),
				fantraxPlayerId,
				viewerTeamId: 't-s',
				amountText: '1500000',
				confirmed: true,
				now: ''
			});

		expect(ask(1, 'p-2').blocked).toBe(false);
		expect(ask(1, 'p-2').refusingGates).toEqual([]);

		expect(ask(2, 'p-3').blocked).toBe(true);
		expect(ask(2, 'p-3').refusingGates).toEqual(['slots']);
		expect(ask(2, 'p-3').detail).toContain('your 3rd outstanding bid');
	});

	it('reads no amount to reach any of it — the verdict does not move with the money', () => {
		// FR-37's property, across the turnover rather than at one point:
		// capacity says the same thing at $0 of Cap Space as at $400.0M.
		for (const capSpace of [0, 20_000_000, 400_000_000]) {
			const second = evaluate(
				bidStateFor(null, { ...teamS(1), capSpace: parseMoney(capSpace) }, false, 'Auction'),
				bidOf(1_500_000, 'p-2'),
				NOW
			);
			const third = evaluate(
				bidStateFor(null, { ...teamS(2), capSpace: parseMoney(capSpace) }, false, 'Auction'),
				bidOf(1_500_000, 'p-3'),
				NOW
			);

			expect(second.slots.passed, String(capSpace)).toBe(true);
			expect(third.slots.passed, String(capSpace)).toBe(false);
		}
	});
});
