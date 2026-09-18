/**
 * PRD §10 example 36 — **The trade that clears the room** (FR-41).
 *
 * > Team A has Roster Count 11, Cap Space $3,000,000, and leads nothing. It
 * > wants a $12,000,000 free agent and cannot come close. It sends Curry —
 * > Active/Bench, Cap Hit $14,000,000, 2 years — to Team B and receives
 * > nothing back. **An empty direction is legal:** a salary dump is a Roster
 * > Move with Contracts moving one way, and FR-41's bidirectionality permits
 * > a side to be empty, not merely to be balanced. Team A afterwards: Roster
 * > Count 10, Cap Space $17,000,000; bidding once, Projected Additions 1,
 * > Roster Reserve `$1,000,000 × max(0, 12 − 11) = $1,000,000`, **Maximum Bid
 * > $16,000,000**. Team B afterwards: Roster Count 9, Cap Space $16,000,000.
 * > Both pass both gates, so the Trade commits. This is the case the
 * > requirement exists for.
 *
 * **The motivating case, and the one that proves an empty direction legal.**
 * Team B sends nothing back, so `receivingPlayerIds` is empty — and the Trade
 * is permitted rather than refused as naming nothing, because the act names
 * one Player and one direction. The pair of refusals that DO fire on an empty
 * act (both directions empty, one Team on both sides) are asserted at the
 * foot, so "empty is legal" cannot quietly become "empty is ignored".
 *
 * Calls the core directly against state literals — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { SALARY_CAP } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { INITIAL_AUCTIONS } from '../../src/lib/core/projection/auctions.ts';
import { INITIAL_NOMINATIONS } from '../../src/lib/core/projection/nominations.ts';
import { bidStateFor, evaluate } from '../../src/lib/core/rules/bidding.ts';
import type { TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import { evaluateTrade } from '../../src/lib/core/rules/roster-trade.ts';
import type { TradingPlayer, RosterTradeState } from '../../src/lib/core/rules/roster-trade.ts';
import type { PlaceBid, RecordRosterTrade } from '../../src/lib/core/types.ts';

const NOW = '2026-09-10T09:00:00.000Z';

/** Curry — Active/Bench, Cap Hit $14,000,000, an imported Contract. */
const CURRY: TradingPlayer = {
	fantraxPlayerId: 'p-curry',
	playerName: 'Curry',
	rosterSlotKind: 'active_bench',
	value: parseMoney(14_000_000),
	won: false,
	contractYears: null
};

/** `count` identical Active/Bench rows sharing `total` between them. */
function filler(prefix: string, count: number, total: number): TradingPlayer[] {
	const each = Math.floor(total / count);
	return Array.from({ length: count }, (_unused, index) => ({
		fantraxPlayerId: `${prefix}-${String(index)}`,
		playerName: `${prefix} ${String(index)}`,
		rosterSlotKind: 'active_bench' as const,
		// The last row carries the remainder, so the total is exact.
		value: parseMoney(index === count - 1 ? total - each * (count - 1) : each),
		won: false,
		contractYears: null
	}));
}

// Team A: eleven Active/Bench Players, $3,000,000 of Cap Space — so the ten
// that are not Curry charge `165,000,000 − 3,000,000 − 14,000,000`.
const TEAM_A_ROWS: readonly TradingPlayer[] = [
	CURRY,
	...filler('a', 10, SALARY_CAP - 3_000_000 - 14_000_000)
];

// Team B: eight Active/Bench Players and $30,000,000 of Cap Space, which is
// $16,000,000 once Curry's $14,000,000 lands.
const TEAM_B_ROWS: readonly TradingPlayer[] = filler('b', 8, SALARY_CAP - 30_000_000);

const STATE: RosterTradeState = {
	sending: { teamId: 't-a', teamName: 'Team A', rows: TEAM_A_ROWS },
	receiving: { teamId: 't-b', teamName: 'Team B', rows: TEAM_B_ROWS },
	// Team A leads nothing, and neither does Team B.
	auctions: INITIAL_AUCTIONS,
	nominations: INITIAL_NOMINATIONS,
	isMinorLeagueEligible: () => false,
	playerNameFor: (id) => id
};

const SALARY_DUMP: RecordRosterTrade = {
	kind: 'RecordRosterTrade',
	sendingTeamId: 't-a',
	sendingTeamName: 'Team A',
	receivingTeamId: 't-b',
	receivingTeamName: 'Team B',
	sendingPlayerIds: ['p-curry'],
	// **The empty direction.** Team B sends nothing back.
	receivingPlayerIds: [],
	reason: 'Agreed in Discord; A needs the room.'
};

/** Team A's Maximum Bid after the Trade, asked of the ordinary bidding gates. */
function maximumBidFor(capSpace: number, rosterCount: number): number | null {
	const team: TeamMoneyState = {
		capSpace: parseMoney(capSpace),
		rosterCount,
		leading: [],
		eligibleLeading: [],
		minorLeagueOccupied: 0
	};
	const bid: PlaceBid = {
		kind: 'PlaceBid',
		fantraxPlayerId: 'p-target',
		teamId: 't-a',
		teamName: 'Team A',
		managerId: 'm-a',
		amount: parseMoney(1_000_000)
	};
	return evaluate(bidStateFor(null, team, 'Auction'), bid, NOW).cap.maximumBid;
}

describe('§10 example 36 — the trade that clears the room', () => {
	it('starts from Roster Count 11 and $3,000,000, unable to come close to $12,000,000', () => {
		const outcome = evaluateTrade(STATE, SALARY_DUMP);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		expect(outcome.delta.sendingBefore.rosterCount).toBe(11);
		expect(outcome.delta.sendingBefore.capSpace).toBe(3_000_000);
		// $12,000,000 was out of reach by $9,000,000. At Roster Count 11 the
		// twelfth Slot is the one this Bid would fill, so Roster Reserve is $0
		// and Maximum Bid is the whole of the Cap Space — which is still
		// $3,000,000.
		expect(maximumBidFor(3_000_000, 11)).toBe(3_000_000);
	});

	it('commits with an EMPTY return direction — a salary dump is a Roster Trade', () => {
		const outcome = evaluateTrade(STATE, SALARY_DUMP);

		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;
		expect(outcome.delta.transfers).toHaveLength(1);
		expect(outcome.delta.transfers[0]?.fantraxPlayerId).toBe('p-curry');
		expect(outcome.delta.transfers[0]?.toTeamId).toBe('t-b');
	});

	it('leaves Team A at Roster Count 10 and $17,000,000, and Maximum Bid $16,000,000', () => {
		const outcome = evaluateTrade(STATE, SALARY_DUMP);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		expect(outcome.delta.sendingAfter.rosterCount).toBe(10);
		expect(outcome.delta.sendingAfter.capSpace).toBe(17_000_000);
		// The PRD's own arithmetic, asked of the bidding gates rather than
		// restated here: Projected Additions 1, Roster Reserve $1,000,000.
		expect(maximumBidFor(17_000_000, 10)).toBe(16_000_000);
	});

	it('leaves Team B at Roster Count 9 and $16,000,000', () => {
		const outcome = evaluateTrade(STATE, SALARY_DUMP);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		expect(outcome.delta.receivingBefore.rosterCount).toBe(8);
		expect(outcome.delta.receivingAfter.rosterCount).toBe(9);
		expect(outcome.delta.receivingAfter.capSpace).toBe(16_000_000);
	});

	it('passes all five gates — both Teams, both grounds, and the contested one', () => {
		const outcome = evaluateTrade(STATE, SALARY_DUMP);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		expect(outcome.gates.contested.passed).toBe(true);
		expect(outcome.gates.sendingCap.passed).toBe(true);
		expect(outcome.gates.sendingSlots.passed).toBe(true);
		expect(outcome.gates.receivingCap.passed).toBe(true);
		expect(outcome.gates.receivingSlots.passed).toBe(true);
	});

	it('charges Curry the same $14,000,000 on Team B — no re-placement, no change', () => {
		const outcome = evaluateTrade(STATE, SALARY_DUMP);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		const transfer = outcome.delta.transfers[0];
		expect(transfer?.fromPlacement).toBe('active_bench');
		expect(transfer?.toPlacement).toBe('active_bench');
		expect(transfer?.capHitBefore).toBe(14_000_000);
		expect(transfer?.capHitAfter).toBe(14_000_000);
	});

	it('still refuses an act that names NOTHING, which is what makes "empty is legal" a rule', () => {
		const nothing = evaluateTrade(STATE, {
			...SALARY_DUMP,
			sendingPlayerIds: [],
			receivingPlayerIds: []
		});

		expect(nothing.kind).toBe('refused');
		if (nothing.kind !== 'refused') return;
		expect(nothing.refusal.kind).toBe('names_nothing');
		// No figures: the act's shape stopped the gates running at all.
		expect(nothing.gates).toBeNull();
	});

	it('still refuses one Team named on both sides', () => {
		const sameTeam = evaluateTrade(STATE, { ...SALARY_DUMP, receivingTeamId: 't-a' });

		expect(sameTeam.kind).toBe('refused');
		if (sameTeam.kind !== 'refused') return;
		expect(sameTeam.refusal.kind).toBe('same_team');
		expect(sameTeam.gates).toBeNull();
	});
});
