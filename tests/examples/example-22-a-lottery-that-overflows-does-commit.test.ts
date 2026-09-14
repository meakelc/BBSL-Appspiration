/**
 * PRD §10 example 22 — **A lottery that overflows does commit** (AD-25).
 *
 * > Same Team Q, now already leading three eligible auctions at $5,000,000,
 * > $4,000,000 and $3,000,000 against its three free slots. It tries to join
 * > a $1,000,000 contention on a fourth eligible player: `N = 4` against
 * > `M = 3`, Overflow Count 1, Minors Exposure $5,000,000 — the largest of
 * > the four. With $0 Available Cap Space the join is **refused**, and the
 * > message names the $5,000,000 auction.
 *
 * **The pair with example 21 is the point.** The same Team, the same $0 of
 * Available Cap Space, the same eligible Player and the same $1,000,000 join
 * — and the opposite outcome, because a fourth eligible win has no Free Minor
 * League Slot to land in. Neither example is about the lottery being cheap or
 * expensive; both are about `Overflow Count`, which is two integers.
 *
 * **Minors Exposure takes the LARGEST amounts, not this Bid's.** The overflow
 * is one, so exposure is the single largest of the four post-bid eligible
 * amounts: $5,000,000, an EARLIER Auction. That is the worst case, because
 * any one of those wins could be the one that lands in Active/Bench at full
 * price and Team Q must be able to cover whichever it is. It is also what
 * lets the refusal NAME the cause — a Manager refused on money they cannot
 * see spent has no way to check the figure without being told where it went.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_BID, MINOR_LEAGUE_SLOTS } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import type { Auction, Bid } from '../../src/lib/core/projection/auctions.ts';
import { INITIAL_AUCTIONS } from '../../src/lib/core/projection/auctions.ts';
import {
	bidRefusalDetail,
	bidStateFor,
	capBreakdown,
	evaluate,
	failedGates,
	teamMoneyStateFor
} from '../../src/lib/core/rules/bidding.ts';
import type { BidState, TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-08-24T14:00:00.000Z';

/**
 * Team Q, now leading three eligible Auctions.
 *
 * `capSpace` is $5,000,000 and Minors Exposure will be $5,000,000, so
 * Available Cap Space is exactly $0 — the example's own figure. Eleven
 * Active/Bench Slots are held, so the one overflowing win fills the twelfth
 * and Roster Reserve is $0: the capacity gate PASSES and the money gate is
 * the sole ground, which is what the example's "the join is refused, and the
 * message names the $5,000,000 auction" requires.
 */
const TEAM_Q: TeamMoneyState = {
	capSpace: parseMoney(5_000_000),
	rosterCount: 11,
	// "leading three eligible auctions" — nothing non-eligible.
	leading: [],
	eligibleLeading: [
		{ fantraxPlayerId: 'p-a', playerName: 'Ausar Thompson', amount: parseMoney(5_000_000), isContentionEntry: false },
		{ fantraxPlayerId: 'p-b', playerName: 'Bilal Coulibaly', amount: parseMoney(4_000_000), isContentionEntry: false },
		{ fantraxPlayerId: 'p-c', playerName: 'Cason Wallace', amount: parseMoney(3_000_000), isContentionEntry: false }
	],
	// "against its three free slots"
	minorLeagueOccupied: 0
};

/** The fourth eligible Player's lottery, opened by another Team. */
const OPENING: Bid = {
	seq: '1',
	teamId: 't-other',
	teamName: 'Team Other',
	managerId: 'm-other',
	amount: parseMoney(MINIMUM_BID),
	occurredAt: '2026-08-24T09:00:00.000Z',
	closesAt: '2026-08-25T09:00:00.000Z',
	seedHash: 'b'.repeat(64)
};

const LOTTERY: Auction = {
	fantraxPlayerId: 'p-d',
	contention: 'minimum_bid',
	leadingBid: OPENING,
	closesAt: OPENING.closesAt,
	bids: [OPENING],
	contenders: [{ seq: '1', teamId: 't-other', teamName: 'Team Other', managerId: 'm-other' }],
	seedHash: OPENING.seedHash,
	// The contention is LIVE: the seed is still sealed, so nothing is revealed.
	seed: null
};

const STATE: BidState = bidStateFor(LOTTERY, TEAM_Q, true, 'Auction');

const JOIN: PlaceBid = {
	kind: 'PlaceBid',
	fantraxPlayerId: 'p-d',
	teamId: 't-q',
	teamName: 'Team Q',
	managerId: 'm-q',
	amount: parseMoney(MINIMUM_BID)
};

describe('§10 example 22 — a lottery that overflows does commit', () => {
	it('states the counts the example states: N = 4, M = 3, Overflow 1', () => {
		const gates = evaluate(STATE, JOIN, NOW);

		expect(gates.cap.eligibleLeadingBids).toBe(4);
		expect(gates.cap.freeMinorLeagueSlots).toBe(MINOR_LEAGUE_SLOTS);
		expect(gates.cap.overflowCount).toBe(1);
	});

	it('makes Minors Exposure $5,000,000 — the LARGEST of the four, not this Bid', () => {
		const cap = evaluate(STATE, JOIN, NOW).cap;

		expect(cap.minorsExposure).toBe(5_000_000);
		expect(cap.committedBids).toBe(5_000_000);
		// "With $0 Available Cap Space"
		expect(cap.availableCapSpace).toBe(0);
		// The overflowing win fills the twelfth Active/Bench Slot, so there is
		// nothing left to reserve.
		expect(cap.rosterReserve).toBe(0);
		expect(cap.maximumBid).toBe(0);
		// The exposure is an EARLIER Auction's amount, so this Bid is not one
		// of the amounts the figure summed.
		expect(cap.exposureIncludesThisBid).toBe(false);
	});

	it('REFUSES the join on money, with capacity passing and its own counts', () => {
		const gates = evaluate(STATE, JOIN, NOW);

		expect(failedGates(gates)).toEqual(['cap']);
		expect(gates.cap.passed).toBe(false);
		// A fourth eligible win has nowhere in the minors to land, so it is
		// compared to a Maximum Bid again: `unbounded` is false.
		expect(gates.cap.unbounded).toBe(false);
		// **The capacity gate passes, and since Story 10.2 it passes for a
		// different reason and on different figures.** The example's
		// `Overflow Count 1` is the MONEY side and it stands: `N = 4` against
		// `M = 3`, Minors Exposure $5,000,000, which is what refuses the join.
		// The slots side removes the join from its own `N`, leaving `3 − 3`
		// and an Active/Bench Overflow of 0, so the entry projects nothing at
		// all. It is permitted by FR-18's landing test — Roster Count 11
		// leaves one free Active/Bench Slot — and not by the `P = 0` branch.
		expect(gates.slots.passed).toBe(true);
		expect(gates.slots.isContentionEntry).toBe(true);
		expect(gates.slots.freeActiveBenchSlots).toBe(1);
		expect(gates.slots.projectedAdditions).toBe(0);
		expect(gates.slots.eligibleLeadingBidsExcludingEntries).toBe(3);
		expect(gates.slots.activeBenchOverflow).toBe(0);
		// The two figures, side by side and disagreeing on purpose.
		expect(gates.cap.overflowCount).toBe(1);
		// And the contention gate is unmoved: it reads no Cap figure, so this
		// is still a join — refused on money, not misclassified.
		expect(gates.contention.entry).toBe('joins');
		expect(gates.contention.passed).toBe(true);
	});

	it('NAMES the $5,000,000 auction in the refusal', () => {
		const gates = evaluate(STATE, JOIN, NOW);
		const detail = bidRefusalDetail({ kind: 'gates', gates });

		expect(gates.cap.exposingBids).toEqual([
			{ fantraxPlayerId: 'p-a', playerName: 'Ausar Thompson', amount: 5_000_000 }
		]);
		expect(detail).toContain('Ausar Thompson at $5.0M');
		expect(detail).toContain('Minors Exposure of $5.0M');
		expect(detail).toContain('Eligible Leading Bids 4');
		expect(detail).toContain('Free Minor League Slots 3');
		expect(detail).toContain('Overflow Count of 1');
	});

	it('prints a breakdown that sums exactly as displayed', () => {
		const lines = capBreakdown(evaluate(STATE, JOIN, NOW).cap);
		const figureFor = (label: string) => lines.find((line) => line.label === label)?.figure;

		expect(figureFor('Cap Space')).toBe('$5.0M');
		expect(figureFor('Committed Bids')).toBe('$5.0M');
		expect(figureFor('of which Minors Exposure')).toBe('$5.0M');
		expect(figureFor('Available Cap Space')).toBe('$0.0M');
		expect(figureFor('Roster Reserve')).toBe('$0.0M');
		// Never "no cap limit": this eligible Bid overflows, so it IS bounded.
		expect(figureFor('Maximum Bid')).toBe('$0.0M');
		expect(lines.map((line) => line.label)).not.toContain('Why there is no cap limit');
	});

	it('holds the flat $1,000,000 against a CONTENDER, not only the leader', () => {
		// Story 3.2's one change to `teamMoneyStateFor`, stated directly.
		// Team Q joined the lottery on `p-d`; Team Other still leads it. The
		// commitment is Team Q's all the same, because any Contender may win.
		const joined: Auction = {
			...LOTTERY,
			contenders: [
				...LOTTERY.contenders,
				{ seq: '2', teamId: 't-q', teamName: 'Team Q', managerId: 'm-q' }
			]
		};
		const money = teamMoneyStateFor({
			teamId: 't-q',
			// A different Auction, so the lottery counts as a commitment
			// elsewhere rather than being excluded as the one being bid on.
			fantraxPlayerId: 'p-elsewhere',
			capSpace: parseMoney(5_000_000),
			rosterCount: 11,
			minorLeagueOccupied: 0,
			auctions: { ...INITIAL_AUCTIONS, byPlayer: { 'p-d': joined } },
			isMinorLeagueEligible: () => true,
			playerNameFor: () => 'The Fourth Player'
		});

		expect(joined.leadingBid?.teamId).toBe('t-other');
		expect(money.eligibleLeading).toEqual([
			{
				fantraxPlayerId: 'p-d',
				playerName: 'The Fourth Player',
				amount: MINIMUM_BID,
				// Story 10.2: the join, carried elsewhere as the entry it is.
				isContentionEntry: true
			}
		]);
		// Flat, never the leading amount — every Contender holds the same.
		expect(money.leading).toEqual([]);
	});

	it('holds NOTHING for a Team that neither leads nor contends', () => {
		// The other half of the widened filter: it widened to Contenders, and
		// to nobody else.
		const money = teamMoneyStateFor({
			teamId: 't-nobody',
			fantraxPlayerId: 'p-elsewhere',
			capSpace: parseMoney(5_000_000),
			rosterCount: 11,
			minorLeagueOccupied: 0,
			auctions: { ...INITIAL_AUCTIONS, byPlayer: { 'p-d': LOTTERY } },
			isMinorLeagueEligible: () => true,
			playerNameFor: () => 'The Fourth Player'
		});

		expect(money.leading).toEqual([]);
		expect(money.eligibleLeading).toEqual([]);
	});
});
