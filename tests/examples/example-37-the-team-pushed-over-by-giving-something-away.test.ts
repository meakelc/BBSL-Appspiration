/**
 * PRD §10 example 37 — **The Team pushed over by giving something away**
 * (FR-41).
 *
 * > Team C has Roster Count 11, Cap Space $6,700,000, and leads one Auction
 * > at $6,500,000. Today: Projected Additions 1, Roster Reserve
 * > `$1,000,000 × max(0, 12 − 12) = $0`, and it covers its own leading Bid
 * > with $200,000 to spare. It now sends away a Player whose Cap Hit is
 * > $500,000. Afterwards Cap Space is $7,200,000 — but Roster Count is 10, so
 * > Roster Reserve becomes `$1,000,000 × max(0, 12 − 11) = $1,000,000`, and
 * > `$7,200,000 − $6,500,000 − $1,000,000 = −$300,000`. **The Move is
 * > refused**, naming the Auction Team C leads and the $300,000 shortfall.
 * > Read what happened: Team C got $500,000 *richer* and became unable to
 * > afford a Bid it was already winning, because the freed Slot costs
 * > $1,000,000 to reserve. **A Roster Trade can be refused because of the Team
 * > giving players up.** Team C's remedies are to wait for that Auction to
 * > close or to void the Bid under FR-32 — never for the Trade to cancel it,
 * > since cancellation is triggered only by a Close (FR-40).
 *
 * **The refusal caused by the SENDING Team, and the one this story exists to
 * make unmissable.** Nothing about the receiving Team is wrong; nothing about
 * the money is wrong in the obvious direction. What fails is solvency, and it
 * fails because a Slot that has nobody in it still costs $1,000,000 to
 * reserve.
 *
 * **The refusal offers no way to cancel a Bid**, which is asserted here in
 * words rather than left to a reviewer to notice: FR-40's cancellation trigger
 * is a Close and only a Close, and a Trade must not extend that list.
 *
 * Calls the core directly against state literals — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { SALARY_CAP } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import type { Auction, OpenAuctions } from '../../src/lib/core/projection/auctions.ts';
import { INITIAL_NOMINATIONS } from '../../src/lib/core/projection/nominations.ts';
import { evaluateTrade, rosterTradeRefusalDetail } from '../../src/lib/core/rules/roster-trade.ts';
import type { TradingPlayer, RosterTradeState } from '../../src/lib/core/rules/roster-trade.ts';
import type { RecordRosterTrade } from '../../src/lib/core/types.ts';

const CLOSES_AT = '2026-09-11T09:00:00.000Z';

/** The Player Team C sends away — Active/Bench, Cap Hit $500,000. */
const CHEAP: TradingPlayer = {
	fantraxPlayerId: 'p-cheap',
	playerName: 'Vassell',
	rosterSlotKind: 'active_bench',
	value: parseMoney(500_000),
	won: false,
	contractYears: null
};

function filler(prefix: string, count: number, total: number): TradingPlayer[] {
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

// Team C: eleven Active/Bench Players and $6,700,000 of Cap Space.
const TEAM_C_ROWS: readonly TradingPlayer[] = [
	CHEAP,
	...filler('c', 10, SALARY_CAP - 6_700_000 - 500_000)
];

// Team D: somewhere for the Player to land. Nothing about it is at issue.
const TEAM_D_ROWS: readonly TradingPlayer[] = filler('d', 5, 10_000_000);

/** The one Auction Team C leads, at $6,500,000. */
const LED_AUCTION: Auction = {
	fantraxPlayerId: 'p-contested',
	contention: 'standard',
	leadingBid: {
		seq: '7',
		teamId: 't-c',
		teamName: 'Team C',
		managerId: 'm-c',
		amount: parseMoney(6_500_000),
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

const AUCTIONS: OpenAuctions = { byPlayer: { 'p-contested': LED_AUCTION } };

const STATE: RosterTradeState = {
	sending: { teamId: 't-c', teamName: 'Team C', rows: TEAM_C_ROWS },
	receiving: { teamId: 't-d', teamName: 'Team D', rows: TEAM_D_ROWS },
	auctions: AUCTIONS,
	nominations: INITIAL_NOMINATIONS,
	isMinorLeagueEligible: () => false,
	playerNameFor: (id) => (id === 'p-contested' ? 'Sharpe' : id)
};

const TRADE: RecordRosterTrade = {
	kind: 'RecordRosterTrade',
	sendingTeamId: 't-c',
	sendingTeamName: 'Team C',
	receivingTeamId: 't-d',
	receivingTeamName: 'Team D',
	sendingPlayerIds: ['p-cheap'],
	receivingPlayerIds: [],
	reason: 'C is clearing a roster spot.'
};

describe('§10 example 37 — the Team pushed over by giving something away', () => {
	it('refuses the Trade, on the SENDING Team and on the money', () => {
		const outcome = evaluateTrade(STATE, TRADE);

		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.kind).toBe('gates');
		expect(outcome.gates?.sendingCap.passed).toBe(false);
		// Nothing is wrong with the receiving Team, and nothing is wrong with
		// either Team's capacity. Reporting this as anything but a sending-side
		// money refusal would send the Commissioner looking in the wrong place.
		expect(outcome.gates?.receivingCap.passed).toBe(true);
		expect(outcome.gates?.sendingSlots.passed).toBe(true);
		expect(outcome.gates?.receivingSlots.passed).toBe(true);
		expect(outcome.gates?.contested.passed).toBe(true);
	});

	it('states the arithmetic the PRD states, figure for figure', () => {
		const outcome = evaluateTrade(STATE, TRADE);
		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;

		const gate = outcome.gates?.sendingCap;
		// $500,000 RICHER — which is the whole point of the example.
		expect(gate?.capSpace).toBe(7_200_000);
		expect(gate?.committedBids).toBe(6_500_000);
		expect(gate?.rosterCount).toBe(10);
		// The freed Slot: `$1,000,000 × max(0, 12 − 11)`.
		expect(gate?.projectedAdditions).toBe(1);
		expect(gate?.rosterReserve).toBe(1_000_000);
		expect(gate?.maximumBid).toBe(-300_000);
		// Stated as a positive size, so nothing downstream has to negate it.
		expect(gate?.shortfall).toBe(300_000);
	});

	it('names the Auction Team C leads', () => {
		const outcome = evaluateTrade(STATE, TRADE);
		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;

		expect(outcome.gates?.sendingCap.leadingAuctions).toEqual([
			{ fantraxPlayerId: 'p-contested', playerName: 'Sharpe', amount: 6_500_000 }
		]);
	});

	it('says the Team, the gate, the Auction and the arithmetic out loud', () => {
		const outcome = evaluateTrade(STATE, TRADE);
		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;

		const detail = rosterTradeRefusalDetail(outcome.refusal, outcome.gates);

		// The Team, the gate's own words, the Auction and the amount it is led
		// at. The gate is named by what the sentence says it could not do —
		// cover what it is already committed to — rather than by a gate id no
		// Commissioner reads.
		expect(detail).toContain('Team C');
		expect(detail).toContain('cannot cover what it is already committed to');
		expect(detail).toContain('Sharpe');
		// **The refusal states its own arithmetic, in full.** $300,000 is off
		// the $500,000 grid, so `formatMoney` refuses it and `describeAmount`
		// would hedge — "an amount that is not on the grid" — which leaves the
		// Commissioner unable to check the sum that refused their Trade. The
		// figure is real: the CSV roster importer asserts no grid, so an
		// imported Cap Hit carries whatever Fantrax held, and this Team's
		// $6,700,000 Cap Space is exactly such a figure. `formatExactDollars`
		// is the diagnostic renderer for that case (AD-8 governs the SURFACE
		// figures, which still go through `formatMoney`).
		expect(outcome.gates?.sendingCap.shortfall).toBe(300_000);
		expect(detail).toContain('a shortfall of $300,000');
		// The whole sum, visibly adding up: 7,200,000 − 6,500,000 − 1,000,000.
		expect(detail).toContain('Cap Space $7,200,000');
		expect(detail).toContain('Committed Bids $6,500,000');
		expect(detail).toContain('Roster Reserve $1,000,000');
	});

	it('offers NO control that would cancel a Bid — only waiting or a void', () => {
		const outcome = evaluateTrade(STATE, TRADE);
		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;

		const detail = rosterTradeRefusalDetail(outcome.refusal, outcome.gates);

		// The two remedies FR-41 allows, named.
		expect(detail).toContain('Wait for it to close or void the Bid');
		// And the promise the sentence makes about what a Trade will not do.
		expect(detail).toContain('the Trade will not cancel it');
	});

	it('would have passed with the Player kept — the SENDING is what refuses it', () => {
		const kept = evaluateTrade(STATE, { ...TRADE, sendingPlayerIds: ['c-0'] });

		// `c-0` carries the bulk of the roster, so sending him instead frees far
		// more than $1,000,000 of reserve. The contrast is the example's lesson:
		// what refuses the Trade is the SIZE of what left, not the act of trading.
		expect(kept.kind).toBe('permitted');
	});
});
