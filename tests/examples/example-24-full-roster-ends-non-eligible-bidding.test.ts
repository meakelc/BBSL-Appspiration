/**
 * PRD §10 example 24 — **A full roster ends non-eligible bidding, money or
 * not** (AD-25).
 *
 * > Team R holds 12 players in Active/Bench Slots, has $40,000,000 of Cap
 * > Space, and leads nothing. It bids $5,000,000 on a player who is not
 * > Minor League Eligible. Projected Active/Bench Additions is 1, so Roster
 * > Capacity is `12 + 1 = 13 > 12` and the bid is **refused** — with the
 * > capacity arithmetic, not a cap figure, since Maximum Bid here is a
 * > healthy $40,000,000. Team R's controls are disabled on every
 * > non-eligible auction on the board with the reason shown, not only at
 * > submission. This state is reachable straight from import.
 *
 * **The half of it that is easy to get wrong is the SECOND gate reporting.**
 * A capacity refusal that quoted a cap figure as its ground would be a defect
 * (AD-7), and so would one that suppressed the cap gate's outcome because
 * capacity had already decided the matter. The bid here is refused on `slots`
 * ALONE, and `cap` reports PASSED carrying a Maximum Bid of $40.0M — which is
 * the only way a Manager can tell "you cannot afford this" apart from "you
 * have nowhere to put it".
 *
 * It is also why the money is stated so generously in the example: at $40.0M
 * of Cap Space against a $5.0M Bid, nothing about the money is marginal, so a
 * refusal here can only be about the roster.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { ACTIVE_BENCH_SLOTS } from '../../src/lib/core/constants.ts';
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
import type { BidState, TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-08-27T09:00:00.000Z';

/**
 * Team R: twelve Active/Bench Slots filled, $40.0M of Cap Space, leading
 * nothing.
 *
 * `leading: []` is the example's "leads nothing", and it is what makes
 * Projected Active/Bench Additions exactly 1 — the Bid being placed, and
 * nothing else.
 */
const TEAM_R: TeamMoneyState = {
	capSpace: parseMoney(40_000_000),
	rosterCount: 12,
	leading: [],
	// Story 2.8: no eligible leads and no occupied Minor League
	// Slots, so `N` is the bid alone and `M` is the full three.
	eligibleLeading: [],
	minorLeagueOccupied: 0
};

/** A nominated Player nobody has bid on, so `opening` is the live gate. */
const STATE: BidState = bidStateFor(null, TEAM_R, false);

function bidOf(amount: number): PlaceBid {
	return {
		kind: 'PlaceBid',
		fantraxPlayerId: 'p-1',
		teamId: 't-r',
		teamName: 'Team R',
		managerId: 'm-r',
		amount: parseMoney(amount)
	};
}

describe('§10 example 24 — a full roster ends non-eligible bidding', () => {
	it('states the capacity arithmetic: 12 held, 1 projected, against a ceiling of 12', () => {
		const gates = evaluate(STATE, bidOf(5_000_000), NOW);

		expect(gates.slots.rosterCount).toBe(12);
		// The post-bid basis: the Bid being placed, and Team R leads nothing.
		expect(gates.slots.projectedAdditions).toBe(1);
		expect(gates.slots.ceiling).toBe(ACTIVE_BENCH_SLOTS);
		// 12 + 1 = 13 > 12.
		expect(gates.slots.passed).toBe(false);
	});

	it('refuses on capacity ALONE, with the money gate reporting passed', () => {
		const gates = evaluate(STATE, bidOf(5_000_000), NOW);

		expect(failedGates(gates)).toEqual(['slots']);
		// "Maximum Bid here is a healthy $40,000,000" — the example says so
		// outright, and the panel must print it beside the refusal rather than
		// leave a Manager to wonder whether the money was the problem.
		expect(gates.cap.passed).toBe(true);
		expect(gates.cap.maximumBid).toBe(40_000_000);
		// Roster Reserve is $0 because the projection reaches the ceiling; the
		// clamp is what keeps it from going negative and REWARDING a full
		// roster with extra spending power.
		expect(gates.cap.rosterReserve).toBe(0);
		expect(gates.opening.passed).toBe(true);
		expect(gates.selfBid.passed).toBe(true);
		expect(gates.increment.passed).toBe(true);
		expect(gates.granularity.passed).toBe(true);
	});

	it('refuses through decide(), appending nothing', () => {
		const decided = decide(STATE, bidOf(5_000_000), NOW, null);

		expect(decided.kind).toBe('rejected');
		if (decided.kind !== 'rejected') return;
		expect(allGatesPassed(decided.gates)).toBe(false);
		// The SAME gate set `evaluate()` returned, not a re-derivation.
		expect(decided.gates).toEqual(evaluate(STATE, bidOf(5_000_000), NOW));
	});

	it('words the refusal with the capacity arithmetic and no cap figure', () => {
		const gates = evaluate(STATE, bidOf(5_000_000), NOW);
		const detail = bidRefusalDetail({ kind: 'gates', gates });

		expect(detail).toContain('no roster slot');
		expect(detail).toContain('Roster Count is 12');
		expect(detail).toContain('Projected Active/Bench Additions is 1');
		expect(detail).toContain('Roster Capacity of 12');
		// "with the capacity arithmetic, not a cap figure" — the example's own
		// words, and the defect AD-7 names if this assertion ever flips.
		expect(detail).not.toContain('Maximum Bid');
		expect(detail).not.toMatch(/\$\d/);
	});

	it('reports BOTH gates on the panel, each with its own figure', () => {
		const rows = bidGateReport(evaluate(STATE, bidOf(5_000_000), NOW));
		const figureFor = (gate: string) => rows.find((row) => row.gate === gate);

		expect(figureFor('slots')?.chip).toBe('Slots · Refused');
		expect(figureFor('slots')?.figure).toBe('Roster Count would be 13 of 12');
		expect(figureFor('cap')?.chip).toBe('Cap · Passed');
		expect(figureFor('cap')?.figure).toContain('Maximum Bid $40.0M');
		// Every gate has a row, none behind a disclosure.
		// Seven since Story 3.1 added `expiry` to `PLACE_BID_GATES`.
		expect(rows).toHaveLength(7);
		for (const row of rows) {
			expect(row.figure.length, row.gate).toBeGreaterThan(0);
		}
	});

	it('disables the control on the board, before anything is typed', () => {
		// "not only at submission" — the control is refused on a standing
		// condition, so the reason is stated when the page renders. The amount
		// asked about is the pre-fill, and `confirmed` is true, so nothing but
		// the roster can be the reason.
		const control = bidControlState({
			state: STATE,
			fantraxPlayerId: 'p-1',
			viewerTeamId: 't-r',
			amountText: '1500000',
			confirmed: true,
			now: ''
		});

		expect(control.blocked).toBe(true);
		expect(control.refusingGates).toEqual(['slots']);
		expect(control.detail).toContain('no roster slot');
	});

	it('is unmoved by how much money Team R has — the gate reads no amount', () => {
		// FR-37: "a Team can fail it with unlimited Cap Space and pass it with
		// none". The example picks $40.0M; the verdict is the same at any
		// figure, which is what makes capacity a genuinely separate ground.
		for (const capSpace of [0, 40_000_000, 400_000_000]) {
			const state = bidStateFor(null, { ...TEAM_R, capSpace: parseMoney(capSpace) }, false);
			const slots = evaluate(state, bidOf(5_000_000), NOW).slots;
			expect(slots.passed, String(capSpace)).toBe(false);
			expect(slots.rosterCount, String(capSpace)).toBe(12);
		}
	});
});
