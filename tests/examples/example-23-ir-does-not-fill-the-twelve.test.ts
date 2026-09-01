/**
 * PRD §10 example 23 — **IR does not fill the twelve** (AD-25).
 *
 * > Team N holds 11 players in Active/Bench Slots and 1 in an Injury Reserve
 * > Slot. Roster Count is 11, not 12, so with no leading bids its Projected
 * > Active/Bench Additions on a new non-eligible bid is 1 and Roster Reserve
 * > is $1,000,000 × max(0, 12 − 12) = $0 — the bid itself fills the last
 * > hole. Adding a second IR player would not change that figure.
 *
 * **The asymmetry this example exists to pin is easy to get backwards.** An
 * Injury Reserve contract counts against the CAP in full and does not count
 * against the TWELVE; a Minor League contract counts against neither. Getting
 * it the other way round would give Team N a Roster Count of 12 and a Roster
 * Reserve computed against a roster that is already full — refusing a Team
 * that has a hole to fill, and doing it with a money figure.
 *
 * The two rules live in two places on purpose: `computeCapSpace` zeroes a
 * Minor League row and leaves an IR row alone, and `loadTeamRoster` counts
 * only `active_bench`. This file asserts them together, because the defect is
 * in the pairing rather than in either half.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { SALARY_CAP } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { computeCapSpace } from '../../src/lib/core/rules/roster-import.ts';
import type { CapHitRow } from '../../src/lib/core/rules/roster-import.ts';
import { bidStateFor, decide, evaluate } from '../../src/lib/core/rules/bidding.ts';
import type { BidState, TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-08-27T09:00:00.000Z';

/** Eleven Active/Bench contracts at $1.0M, plus one on Injury Reserve. */
const TEAM_N_ROWS: readonly CapHitRow[] = [
	...Array.from({ length: 11 }, () => ({
		capHit: parseMoney(1_000_000),
		rosterSlotKind: 'active_bench' as const
	})),
	{ capHit: parseMoney(1_000_000), rosterSlotKind: 'injury_reserve' as const }
];

/** Roster Count is the Active/Bench rows and nothing else (PRD §3). */
const rosterCountOf = (rows: readonly CapHitRow[]): number =>
	rows.filter((row) => row.rosterSlotKind === 'active_bench').length;

const TEAM_N: TeamMoneyState = {
	capSpace: computeCapSpace(TEAM_N_ROWS).capSpace,
	rosterCount: rosterCountOf(TEAM_N_ROWS),
	leading: [],
	// Story 2.8: no eligible leads and no occupied Minor League
	// Slots, so `N` is the bid alone and `M` is the full three.
	eligibleLeading: [],
	minorLeagueOccupied: 0
};

const STATE: BidState = bidStateFor(null, TEAM_N, false, 'Auction');

function bidOf(amount: number): PlaceBid {
	return {
		kind: 'PlaceBid',
		fantraxPlayerId: 'p-1',
		teamId: 't-n',
		teamName: 'Team N',
		managerId: 'm-n',
		amount: parseMoney(amount)
	};
}

describe('§10 example 23 — IR does not fill the twelve', () => {
	it('counts the IR player against the Cap but not against Roster Count', () => {
		// Twelve contracts at $1.0M all count against the Cap, IR included.
		expect(TEAM_N.capSpace).toBe(SALARY_CAP - 12_000_000);
		// But only eleven of them occupy an Active/Bench Slot.
		expect(TEAM_N.rosterCount).toBe(11);
	});

	it('leaves Roster Reserve at $0 — the bid itself fills the last hole', () => {
		const gates = evaluate(STATE, bidOf(1_500_000), NOW);

		expect(gates.cap.rosterCount).toBe(11);
		expect(gates.cap.projectedAdditions).toBe(1);
		// $1,000,000 × max(0, 12 − 12).
		expect(gates.cap.rosterReserve).toBe(0);
		expect(gates.cap.maximumBid).toBe(TEAM_N.capSpace);
	});

	it('is unchanged by a SECOND Injury Reserve player, as the example states', () => {
		const withTwoIr: readonly CapHitRow[] = [
			...TEAM_N_ROWS,
			{ capHit: parseMoney(1_000_000), rosterSlotKind: 'injury_reserve' as const }
		];
		const gates = evaluate(
			bidStateFor(null, {
				capSpace: computeCapSpace(withTwoIr).capSpace,
				rosterCount: rosterCountOf(withTwoIr),
				leading: [],
				// Story 2.8: no eligible leads and no occupied Minor League
				// Slots, so `N` is the bid alone and `M` is the full three.
				eligibleLeading: [],
				minorLeagueOccupied: 0
			}, false, 'Auction'),
			bidOf(1_500_000),
			NOW
		);

		// Roster Count and the reserve are untouched; only the Cap moved, by
		// the second contract's own hit.
		expect(gates.cap.rosterCount).toBe(11);
		expect(gates.cap.rosterReserve).toBe(0);
		expect(gates.cap.capSpace).toBe(SALARY_CAP - 13_000_000);
	});

	it('treats a Minor League contract as $0 against the Cap and 0 against the twelve', () => {
		// The other half of the asymmetry, asserted beside it so the two
		// cannot be conflated: a Minor League row counts against NEITHER.
		const withMinors: readonly CapHitRow[] = [
			...TEAM_N_ROWS,
			{ capHit: parseMoney(30_000_000), rosterSlotKind: 'minor_league' as const }
		];

		expect(computeCapSpace(withMinors).capSpace).toBe(TEAM_N.capSpace);
		expect(rosterCountOf(withMinors)).toBe(11);
	});

	it('lets Team N bid its whole remaining Cap Space, and refuses a dollar more', () => {
		expect(decide(STATE, bidOf(TEAM_N.capSpace), NOW, null).kind).toBe('accepted');

		const over = evaluate(STATE, bidOf(TEAM_N.capSpace + 500_000), NOW);
		expect(over.cap.passed).toBe(false);
	});

	it('is the capacity gate’s AT-THE-CEILING case: 11 + 1 = 12 passes (Story 2.7)', () => {
		// `evaluateSlots`'s own doc cites this example as the boundary where
		// the twelfth hole is filled and the Bid is still legal. That claim was
		// true here only by implication — the `decide()` above cannot accept
		// unless `slots` passed — so it is stated outright, and the file the
		// doc points at now verifies what the doc says about it.
		const gates = evaluate(STATE, bidOf(1_500_000), NOW);

		expect(gates.slots.rosterCount).toBe(11);
		expect(gates.slots.projectedAdditions).toBe(1);
		expect(gates.slots.ceiling).toBe(12);
		// `12 <= 12` — at the ceiling passes; only exceeding it is refused.
		expect(gates.slots.passed).toBe(true);
	});
});
