/**
 * PRD §10 example 38 — **The stash that becomes expensive by moving**
 * (FR-41).
 *
 * > Team D holds Ellis, Minor League Eligible, won at $18,000,000 and placed
 * > in a Minor League Slot at a **$0 Cap Hit**. It trades him to Team E,
 * > which already holds three Minor League Players and has no Free Minor
 * > League Slot. Slot Placement is re-evaluated on receipt (FR-41): Ellis
 * > lands in an **Active/Bench Slot**, and his Cap Hit becomes
 * > **$18,000,000**. His winning amount never changed and no expression read
 * > one from the other (FR-21, AD-23). Team E, at Roster Count 9 with
 * > $20,000,000 of Cap Space, finishes at Roster Count 10 and $2,000,000 —
 * > and is refused outright if it leads anything it can no longer cover.
 * > **The knock-on runs the other way too:** Team D's Free Minor League Slots
 * > rises from 0 to 1, its Overflow Count falls, and its **Minors Exposure
 * > recomputes across every eligible Auction it still leads** — so a trade
 * > can raise a third Auction's Maximum Bid for a Team that was not party to
 * > it.
 *
 * **Placement is re-evaluated, and a $0 becomes $18,000,000 by the act of
 * moving.** Sitting in a Minor League Slot is itself the eligibility
 * statement — a rostered Player has no `free_agent_players` row to consult —
 * so `slotPlacementFor(true, receivingOccupancy)` decides, which is FR-21's
 * ordinary rule and not a rule this story wrote.
 *
 * **Minors Exposure is not stored and is not adjusted.** It is derived on
 * every evaluation, so Team D's exposure falling is what happens when the
 * post-Trade occupancy is handed to the same arithmetic — nothing writes it,
 * and the third Auction's Maximum Bid moves without anybody touching it.
 *
 * Calls the core directly against state literals — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { SALARY_CAP } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import type { Auction, OpenAuctions } from '../../src/lib/core/projection/auctions.ts';
import { INITIAL_NOMINATIONS } from '../../src/lib/core/projection/nominations.ts';
import { evaluateTrade } from '../../src/lib/core/rules/roster-trade.ts';
import type { TradingPlayer, RosterTradeState } from '../../src/lib/core/rules/roster-trade.ts';
import type { RecordRosterTrade } from '../../src/lib/core/types.ts';

const CLOSES_AT = '2026-09-11T09:00:00.000Z';

/**
 * Ellis — won at $18,000,000, stashed in a Minor League Slot at a $0 Cap Hit.
 *
 * `value` is the WINNING AMOUNT, never the charge. What he charges is
 * `chargedCapHit`'s answer about the Slot he is in, which is $0 here and
 * $18,000,000 the moment he lands in Active/Bench.
 */
const ELLIS: TradingPlayer = {
	fantraxPlayerId: 'p-ellis',
	playerName: 'Ellis',
	rosterSlotKind: 'minor_league',
	value: parseMoney(18_000_000),
	won: true,
	contractYears: null
};

function activeBench(prefix: string, count: number, total: number): TradingPlayer[] {
	const each = Math.floor(total / count);
	return Array.from({ length: count }, (_unused, index) => ({
		fantraxPlayerId: `${prefix}-${String(index)}`,
		playerName: `${prefix} ${String(index)}`,
		rosterSlotKind: 'active_bench' as const,
		value: parseMoney(index === count - 1 ? total - each * (count - 1) : each),
		won: false,
		contractYears: null
	}));
}

function minors(prefix: string, count: number): TradingPlayer[] {
	return Array.from({ length: count }, (_unused, index) => ({
		fantraxPlayerId: `${prefix}-m-${String(index)}`,
		playerName: `${prefix} minor ${String(index)}`,
		rosterSlotKind: 'minor_league' as const,
		// A Minor League row charges $0 whatever it is worth, so the figure
		// here changes nothing while Ellis is where he is.
		value: parseMoney(2_000_000),
		won: false,
		contractYears: null
	}));
}

// Team D: Ellis plus two more minors — three occupied Minor League Slots, so
// `M = 0` before the Trade and `M = 1` after it.
const TEAM_D_ROWS: readonly TradingPlayer[] = [
	ELLIS,
	...minors('d', 2),
	...activeBench('d', 6, 60_000_000)
];

// Team E: Roster Count 9, $20,000,000 of Cap Space, and all three Minor
// League Slots already full — so Ellis has nowhere to stash.
const TEAM_E_ROWS: readonly TradingPlayer[] = [
	...minors('e', 3),
	...activeBench('e', 9, SALARY_CAP - 20_000_000)
];

/** Two eligible Auctions Team D still leads, at $12,000,000 and $4,000,000. */
function eligibleAuction(playerId: string, amount: number): Auction {
	return {
		fantraxPlayerId: playerId,
		contention: 'standard',
		leadingBid: {
			seq: playerId,
			teamId: 't-d',
			teamName: 'Team D',
			managerId: 'm-d',
			amount: parseMoney(amount),
			occurredAt: '2026-09-10T09:00:00.000Z',
			closesAt: CLOSES_AT,
			seedHash: null
		},
		closesAt: CLOSES_AT,
		bids: [],
		contenders: [],
		seedHash: null,
		seed: null
	};
}

const AUCTIONS: OpenAuctions = {
	byPlayer: {
		'p-elig-1': eligibleAuction('p-elig-1', 12_000_000),
		'p-elig-2': eligibleAuction('p-elig-2', 4_000_000)
	}
};

const STATE: RosterTradeState = {
	sending: { teamId: 't-d', teamName: 'Team D', rows: TEAM_D_ROWS },
	receiving: { teamId: 't-e', teamName: 'Team E', rows: TEAM_E_ROWS },
	auctions: AUCTIONS,
	nominations: INITIAL_NOMINATIONS,
	// The two open Auctions Team D leads are on Minor League Eligible Players.
	// Ellis is not in the pool any more — he is under contract — and no gate
	// asks this function about him.
	isMinorLeagueEligible: (id) => id.startsWith('p-elig'),
	playerNameFor: (id) => id
};

const TRADE: RecordRosterTrade = {
	kind: 'RecordRosterTrade',
	sendingTeamId: 't-d',
	sendingTeamName: 'Team D',
	receivingTeamId: 't-e',
	receivingTeamName: 'Team E',
	sendingPlayerIds: ['p-ellis'],
	receivingPlayerIds: [],
	reason: 'E wanted the upside and had the room on the active roster.'
};

describe('§10 example 38 — the stash that becomes expensive by moving', () => {
	it('lands Ellis in ACTIVE/BENCH, because Team E has no Free Minor League Slot', () => {
		const outcome = evaluateTrade(STATE, TRADE);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		const transfer = outcome.delta.transfers[0];
		expect(transfer?.fromPlacement).toBe('minor_league');
		expect(transfer?.toPlacement).toBe('active_bench');
	});

	it('turns a $0 Cap Hit into $18,000,000, with the winning amount UNCHANGED', () => {
		const outcome = evaluateTrade(STATE, TRADE);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		const transfer = outcome.delta.transfers[0];
		expect(transfer?.capHitBefore).toBe(0);
		expect(transfer?.capHitAfter).toBe(18_000_000);
		// AD-23: two fields, and no expression reads one out of the other.
		expect(transfer?.winningAmount).toBe(18_000_000);
	});

	it('leaves Team E at Roster Count 10 and $2,000,000', () => {
		const outcome = evaluateTrade(STATE, TRADE);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		expect(outcome.delta.receivingBefore.rosterCount).toBe(9);
		expect(outcome.delta.receivingBefore.capSpace).toBe(20_000_000);
		expect(outcome.delta.receivingAfter.rosterCount).toBe(10);
		expect(outcome.delta.receivingAfter.capSpace).toBe(2_000_000);
		// The Slot occupancies: E's three minors are untouched, D loses one.
		expect(outcome.delta.receivingAfter.minorLeagueOccupied).toBe(3);
	});

	it("raises Team D's Free Minor League Slots from 0 to 1", () => {
		const outcome = evaluateTrade(STATE, TRADE);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		expect(outcome.delta.sendingBefore.minorLeagueOccupied).toBe(3);
		expect(outcome.delta.sendingAfter.minorLeagueOccupied).toBe(2);
		// `M = max(0, 3 − occupied)`, derived — never stored.
		expect(outcome.gates.sendingCap.rosterCount).toBe(6);
	});

	it('RECOMPUTES Minors Exposure across every eligible Auction Team D still leads', () => {
		const outcome = evaluateTrade(STATE, TRADE);
		expect(outcome.kind).toBe('permitted');
		if (outcome.kind !== 'permitted') return;

		// After the Trade: `N = 2` eligible leads against `M = 1`, so Overflow
		// Count is 1 and Minors Exposure is the LARGER of the two — $12,000,000.
		// Before it, `M = 0` and the exposure was both of them, $16,000,000.
		expect(outcome.gates.sendingCap.minorsExposure).toBe(12_000_000);
		expect(outcome.gates.sendingCap.committedBids).toBe(12_000_000);
		// Nothing wrote that: it is derived from the post-Trade occupancy handed
		// to the same arithmetic every Bid is judged by. A third Auction's
		// Maximum Bid moved for a Team that was not party to this trade.
	});

	it('refuses the same Trade outright when Team E can no longer cover what it leads', () => {
		// Team E leading $5,000,000 elsewhere: $2,000,000 of Cap Space after
		// the Trade cannot carry it, and the whole Trade is refused.
		const leadingE: Auction = {
			...eligibleAuction('p-e-lead', 5_000_000),
			leadingBid: {
				seq: 'p-e-lead',
				teamId: 't-e',
				teamName: 'Team E',
				managerId: 'm-e',
				amount: parseMoney(5_000_000),
				occurredAt: '2026-09-10T09:00:00.000Z',
				closesAt: CLOSES_AT,
				seedHash: null
			}
		};
		const outcome = evaluateTrade(
			{
				...STATE,
				auctions: { byPlayer: { ...AUCTIONS.byPlayer, 'p-e-lead': leadingE } },
				isMinorLeagueEligible: (id) => id.startsWith('p-elig')
			},
			TRADE
		);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.gates?.receivingCap.passed).toBe(false);
		// **The WHOLE Trade is refused**, not the arriving Player alone.
		expect(outcome.refusal.kind).toBe('gates');
	});
});
