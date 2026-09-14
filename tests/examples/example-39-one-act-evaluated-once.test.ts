/**
 * PRD §10 example 39 — **One act, evaluated once** (FR-41).
 *
 * > Team F is at Roster Count 12 and Team G at 10. They agree a trade: F
 * > sends three Active/Bench Players and receives two. F finishes at
 * > `12 − 3 + 2 = 11` and G at `10 − 2 + 3 = 11`; both are legal and neither
 * > breaches a ceiling. Applied as two acts in the unlucky order — F receives
 * > its two first — F stands transiently at **14** Active/Bench Players and
 * > the ceiling refuses a perfectly legal trade **on a state that never
 * > existed**. This is why FR-41 makes a Trade one act with one evaluation at
 * > the end, and it is not a convenience.
 *
 * **The counterfactual is the test.** The Trade is permitted, and the second
 * half of this file shows what the other implementation would have done: the
 * arrivals applied before the departures put Team F at Roster Count 14, and
 * that state is refused by the very gate the real evaluation passes. Both
 * halves are here because the example is about the DIFFERENCE between them.
 *
 * **The explicit ceiling test is what makes the counterfactual fail at all.**
 * `unfilledSlots` clamps at zero, so a Team standing at 14 and leading
 * nothing has `projectedAdditions === 0` and sails through FR-37's first
 * branch. Without `rosterCount <= ACTIVE_BENCH_SLOTS` the transient state
 * would be silently LEGAL, which is worse than refusing it.
 *
 * Calls the core directly against state literals — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { ACTIVE_BENCH_SLOTS } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { INITIAL_AUCTIONS } from '../../src/lib/core/projection/auctions.ts';
import { INITIAL_NOMINATIONS } from '../../src/lib/core/projection/nominations.ts';
import { evaluateTrade } from '../../src/lib/core/rules/roster-trade.ts';
import type { TradingPlayer, RosterTradeState } from '../../src/lib/core/rules/roster-trade.ts';
import type { RecordRosterTrade } from '../../src/lib/core/types.ts';

/** `count` Active/Bench Players at $1,000,000 each — the money is not the point. */
function roster(prefix: string, count: number): TradingPlayer[] {
	return Array.from({ length: count }, (_unused, index) => ({
		fantraxPlayerId: `${prefix}-${String(index)}`,
		playerName: `${prefix} ${String(index)}`,
		rosterSlotKind: 'active_bench' as const,
		value: parseMoney(1_000_000),
		won: false,
		contractYears: null
	}));
}

const TEAM_F_ROWS = roster('f', 12);
const TEAM_G_ROWS = roster('g', 10);

const STATE: RosterTradeState = {
	sending: { teamId: 't-f', teamName: 'Team F', rows: TEAM_F_ROWS },
	receiving: { teamId: 't-g', teamName: 'Team G', rows: TEAM_G_ROWS },
	// Neither Team leads anything: the example is entirely about capacity.
	auctions: INITIAL_AUCTIONS,
	nominations: INITIAL_NOMINATIONS,
	isMinorLeagueEligible: () => false,
	playerNameFor: (id) => id
};

/** Three out, two back — one act. */
const TRADE: RecordRosterTrade = {
	kind: 'RecordRosterTrade',
	sendingTeamId: 't-f',
	sendingTeamName: 'Team F',
	receivingTeamId: 't-g',
	receivingTeamName: 'Team G',
	sendingPlayerIds: ['f-0', 'f-1', 'f-2'],
	receivingPlayerIds: ['g-0', 'g-1'],
	reason: 'Three for two, agreed in the league channel.'
};

describe('§10 example 39 — one act, evaluated once', () => {
	it('permits the trade: F finishes at 11 and G at 11', () => {
		const outcome = evaluateTrade(STATE, TRADE);

		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;
		expect(outcome.delta.sendingBefore.rosterCount).toBe(12);
		expect(outcome.delta.receivingBefore.rosterCount).toBe(10);
		expect(outcome.delta.sendingAfter.rosterCount).toBe(11);
		expect(outcome.delta.receivingAfter.rosterCount).toBe(11);
	});

	it('moves all five Contracts in ONE act', () => {
		const outcome = evaluateTrade(STATE, TRADE);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		expect(outcome.delta.transfers).toHaveLength(5);
		// Sorted by `fantraxPlayerId` (AD-5): the same five Contracts land the
		// same way on every replay, whatever order the form ticked them in.
		expect(outcome.delta.transfers.map((transfer) => transfer.fantraxPlayerId)).toEqual([
			'f-0',
			'f-1',
			'f-2',
			'g-0',
			'g-1'
		]);
	});

	it('passes both capacity gates against the state the WHOLE act produced', () => {
		const outcome = evaluateTrade(STATE, TRADE);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		expect(outcome.gates.sendingSlots.passed).toBe(true);
		expect(outcome.gates.sendingSlots.rosterCount).toBe(11);
		expect(outcome.gates.receivingSlots.passed).toBe(true);
		expect(outcome.gates.receivingSlots.rosterCount).toBe(11);
		// The transient 14 is never a figure on any gate, because it is never a
		// state: departures apply to both Teams before any arrival is placed.
		expect(outcome.gates.sendingSlots.rosterCount).toBeLessThanOrEqual(ACTIVE_BENCH_SLOTS);
	});

	it('would have REFUSED the unlucky order — a state this evaluation never builds', () => {
		// The counterfactual, constructed directly: Team F having received its
		// two before sending its three. Roster Count 14 — the state the PRD says
		// a per-direction implementation would judge.
		const transient: RosterTradeState = {
			...STATE,
			sending: {
				teamId: 't-f',
				teamName: 'Team F',
				rows: [...TEAM_F_ROWS, ...roster('g', 2)]
			}
		};
		// Judged at that moment, even a Trade that sends one Player AWAY is
		// refused: 13 is still above the ceiling. A perfectly legal trade,
		// refused on a state that never existed.
		const judged = evaluateTrade(transient, {
			...TRADE,
			sendingPlayerIds: ['f-0'],
			receivingPlayerIds: []
		});

		expect(judged.kind).toBe('refused');
		if (judged.kind !== 'refused') return;
		expect(judged.gates?.sendingSlots.passed).toBe(false);
		expect(judged.gates?.sendingSlots.rosterCount).toBe(13);
		expect(judged.gates?.sendingSlots.breaches).toEqual(['active_bench']);

		// And the real evaluation of the real act never sees 14 or 13 at all.
		const real = evaluateTrade(STATE, TRADE);
		expect(real.kind).toBe('permitted');
		if (real.kind !== 'permitted') return;
		expect(real.gates.sendingSlots.rosterCount).toBe(11);
	});

	it('refuses a Trade that genuinely WOULD leave a Team above the ceiling', () => {
		// Team G at 10 receiving three while sending nothing finishes at 13.
		// `unfilledSlots` clamps at zero and `projectedAdditions` is 0, so
		// FR-37's first branch would admit it: the explicit ceiling test is the
		// only thing that refuses it.
		const overFull = evaluateTrade(STATE, { ...TRADE, receivingPlayerIds: [] });

		expect(overFull.kind).toBe('refused');
		if (overFull.kind !== 'refused') return;
		expect(overFull.gates?.receivingSlots.passed).toBe(false);
		expect(overFull.gates?.receivingSlots.rosterCount).toBe(13);
		expect(overFull.gates?.receivingSlots.breaches).toEqual(['active_bench']);
		// The figure that would have admitted it, stated: zero outstanding Bids.
		expect(overFull.gates?.receivingSlots.projectedAdditions).toBe(0);
		// And the sending Team is fine — the refusal names the right side.
		expect(overFull.gates?.sendingSlots.passed).toBe(true);
	});
});
