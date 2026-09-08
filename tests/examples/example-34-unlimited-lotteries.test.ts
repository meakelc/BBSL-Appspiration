/**
 * PRD §10 example 34 — **Unlimited lotteries, and the one win that ends
 * them** (AD-25), the bidding half.
 *
 * > Team X has Roster Count 11 (Free Active/Bench Slots 1), no free Minor
 * > League Slots, and $9,000,000 of Available Cap Space. It joins six
 * > Minimum-Bid Contentions on non-eligible players, committing $1,000,000
 * > to each. **Capacity is never consulted:** entries contribute nothing to
 * > Projected Active/Bench Additions and do not consume the allowance, so
 * > the only question asked of the sixth is whether $6,000,000 fits in
 * > $9,000,000. A seventh, eighth and ninth would also be permitted; a
 * > **tenth is refused on money** at $10,000,000 against $9,000,000 — cap
 * > space is the throttle, and the only one.
 *
 * **This file owns the first half of the example and says so.** The draw,
 * the cascade that cancels Team X's five surviving entries and the lottery
 * that closes with no winner are Stories 10.3–10.5; nothing here asserts
 * them. What it does assert is the property those stories exist to make
 * safe: that a Team with ONE free Slot may hold nine outstanding lottery
 * entries, that the capacity gate passes every one of them, and that the
 * tenth is refused by the money gate rather than by capacity. A revision
 * that refused the third on capacity would still leave the tenth refused —
 * so the passing cases are the load-bearing assertions, not the failing one.
 *
 * **The arithmetic is stated rather than approximated.** With `k` entries
 * held, Committed Bids is `k × $1,000,000`, Available Cap Space is
 * `$9,000,000 − k`, and Maximum Bid is that less a Roster Reserve of $0 —
 * because Projected Active/Bench Additions on the MONEY side is 1, the Bid
 * being placed, which takes `11 + 1` to exactly twelve. So the join is
 * permitted while `9 − k ≥ 1`, and the tenth (`k = 9`) meets a Maximum Bid
 * of $0.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_BID, MINOR_LEAGUE_SLOTS } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import type { Auction, Bid } from '../../src/lib/core/projection/auctions.ts';
import {
	allGatesPassed,
	bidRefusalDetail,
	bidStateFor,
	decide,
	evaluate,
	failedGates
} from '../../src/lib/core/rules/bidding.ts';
import type { BidState, LeadingBidElsewhere, TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-08-24T14:00:00.000Z';

/** One lottery Team X already contends in, as the fold produced it. */
function entry(index: number): LeadingBidElsewhere {
	return {
		fantraxPlayerId: `p-lot-${String(index)}`,
		playerName: `Lottery Player ${String(index)}`,
		amount: parseMoney(MINIMUM_BID),
		// The whole point of the example: a Contender's ticket, flagged as
		// one by `teamMoneyStateFor` from the contention state itself.
		isContentionEntry: true
	};
}

/**
 * Team X holding `held` lottery entries: Roster Count 11, no free Minor
 * League Slots, and $9,000,000 of Cap Space with nothing else committed —
 * so Cap Space and Available Cap Space start equal, which is the example's
 * "$9,000,000 of Available Cap Space".
 */
function teamX(held: number): TeamMoneyState {
	return {
		capSpace: parseMoney(9_000_000),
		rosterCount: 11,
		// Non-eligible players, so every ticket is a flat commitment in
		// `leading` rather than an Eligible Leading Bid.
		leading: Array.from({ length: held }, (_unused, index) => entry(index + 1)),
		eligibleLeading: [],
		// "no free Minor League Slots" — the pass has to come from the one
		// free Active/Bench Slot, never from the minors branch.
		minorLeagueOccupied: MINOR_LEAGUE_SLOTS
	};
}

const OPENING: Bid = {
	seq: '1',
	teamId: 't-other',
	teamName: 'Team Other',
	managerId: 'm-other',
	amount: parseMoney(MINIMUM_BID),
	occurredAt: '2026-08-24T09:00:00.000Z',
	closesAt: '2026-08-25T09:00:00.000Z',
	seedHash: 'f'.repeat(64)
};

/** The next lottery, opened by another Team and still live. */
const LOTTERY: Auction = {
	fantraxPlayerId: 'p-next',
	contention: 'minimum_bid',
	leadingBid: OPENING,
	closesAt: OPENING.closesAt,
	bids: [OPENING],
	contenders: [{ seq: '1', teamId: 't-other', teamName: 'Team Other', managerId: 'm-other' }],
	seedHash: OPENING.seedHash,
	seed: null
};

/** Team X joining the next lottery while it already holds `held` others. */
function joining(held: number): BidState {
	return bidStateFor(LOTTERY, teamX(held), false, 'Auction');
}

const JOIN: PlaceBid = {
	kind: 'PlaceBid',
	fantraxPlayerId: 'p-next',
	teamId: 't-x',
	teamName: 'Team X',
	managerId: 'm-x',
	amount: parseMoney(MINIMUM_BID)
};

describe('§10 example 34 — unlimited lotteries, ended by cap space alone', () => {
	it('never consults capacity: the sixth join passes with ONE free Slot', () => {
		const gates = evaluate(joining(5), JOIN, NOW);

		// "entries contribute nothing to Projected Active/Bench Additions".
		expect(gates.slots.projectedAdditions).toBe(0);
		expect(gates.slots.isContentionEntry).toBe(true);
		// "Free Active/Bench Slots 1", and FR-18's landing test is satisfied
		// by that alone.
		expect(gates.slots.freeActiveBenchSlots).toBe(1);
		expect(gates.slots.freeMinorLeagueSlots).toBe(0);
		expect(gates.slots.passed).toBe(true);
		// "and do not consume the allowance" — it is reported, and unspent.
		expect(gates.slots.allowance).toBe(2);
		expect(allGatesPassed(gates)).toBe(true);
		expect(decide(joining(5), JOIN, NOW, null).kind).toBe('accepted');
	});

	it('permits the seventh, eighth and NINTH — the allowance would have stopped at two', () => {
		// The pre-10.2 rule counted every entry toward `P`, so this Team's
		// `P = held + 1` met an allowance of 2 at the SECOND join and refused
		// everything after it. Stated as the whole run rather than as one
		// case, because "unlimited" is the claim.
		for (const held of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
			const gates = evaluate(joining(held), JOIN, NOW);

			expect(gates.slots.projectedAdditions, String(held)).toBe(0);
			expect(gates.slots.passed, String(held)).toBe(true);
			// ...and the money holds too, so every one of them is accepted.
			expect(gates.cap.passed, String(held)).toBe(true);
			expect(failedGates(gates), String(held)).toEqual([]);
		}
	});

	it('refuses the TENTH on money, at $1.0M against a Maximum Bid of $0', () => {
		// "$10,000,000 against $9,000,000 — cap space is the throttle, and
		// the only one."
		const gates = evaluate(joining(9), JOIN, NOW);

		expect(gates.cap.committedBids).toBe(9_000_000);
		expect(gates.cap.availableCapSpace).toBe(0);
		expect(gates.cap.rosterReserve).toBe(0);
		expect(gates.cap.maximumBid).toBe(0);
		expect(gates.cap.passed).toBe(false);

		// **Capacity is NOT a ground, and that is the assertion.** A gate set
		// that refused this on both would read as a roster problem to the
		// Manager, and the remedy for a roster problem is not the remedy for
		// a cap one.
		expect(gates.slots.passed).toBe(true);
		expect(failedGates(gates)).toEqual(['cap']);
		expect(decide(joining(9), JOIN, NOW, null).kind).toBe('rejected');

		const detail = bidRefusalDetail({ kind: 'gates', gates });
		expect(detail).toContain('Maximum Bid');
		expect(detail).not.toContain('Roster Capacity');
		expect(detail).not.toContain('roster slot');
		expect(detail).not.toContain('lottery entry needs somewhere');
	});

	it('keeps the money side counting the entries, which is why the tenth is refused at all', () => {
		// FR-18 exempts a Contention entry from Roster Capacity and from
		// nothing else. Committed Bids is the flat $1,000,000 per ticket of
		// FR-14, and it is what actually runs out.
		for (const held of [0, 3, 6, 9]) {
			const gates = evaluate(joining(held), JOIN, NOW);

			expect(gates.cap.committedBids, String(held)).toBe(held * 1_000_000);
			expect(gates.cap.availableCapSpace, String(held)).toBe(9_000_000 - held * 1_000_000);
			// The MONEY-side projection still counts the Bid being placed, so
			// `11 + 1` is exactly twelve and the reserve is $0 throughout.
			expect(gates.cap.projectedAdditions, String(held)).toBe(1);
			expect(gates.cap.rosterReserve, String(held)).toBe(0);
		}
	});

	it('refuses the same Team once its last Active/Bench Slot goes — the exemption is not a licence', () => {
		// The counterfactual that keeps "unlimited" honest: at Roster Count
		// 12 with no free Minor League Slot, an entry has nowhere for a win
		// to land and is refused on capacity, with the sentence saying so.
		// This is the state Stories 10.3–10.5 reach by CLOSING one of the
		// lotteries above; here it is stated directly.
		const full = bidStateFor(LOTTERY, { ...teamX(5), rosterCount: 12 }, false, 'Auction');
		const gates = evaluate(full, JOIN, NOW);

		expect(gates.slots.freeActiveBenchSlots).toBe(0);
		expect(gates.slots.passed).toBe(false);
		expect(bidRefusalDetail({ kind: 'gates', gates })).toContain(
			'A lottery entry needs somewhere for the win to land'
		);
	});
});
