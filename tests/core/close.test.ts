/**
 * The close, as a pure rule (Story 3.4, FR-21, AD-11, AD-12, AD-23).
 *
 * Four things are pinned here and nowhere else:
 *
 *   1. **The placement table.** Eligibility first, occupancy second, and no
 *      choice by anybody in either.
 *   2. **The four throws.** A close has no gates, so every failure reachable
 *      is a bug and every one of them throws rather than returning a refusal
 *      a Manager would be shown (AD-1).
 *   3. **The winner and the amount by contention.** Standard awards the
 *      Leading Bidder at their own amount; a lottery awards the DRAWN
 *      Contender at exactly `$1,000,000`, never `leadingBid.amount`.
 *   4. **`now` is a guard, never an input.** Everything `decideClose` emits
 *      is invariant under it, which is what makes AD-10's "a late sweep
 *      produces exactly the outcome an on-time sweep would have" structural.
 *
 * State literals throughout: no database, no clock mocking, no fold beyond
 * the one that builds an `Auction` to hand in.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_BID, MINOR_LEAGUE_SLOTS } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import type { Auction, Bid } from '../../src/lib/core/projection/auctions.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import type { OpenNomination } from '../../src/lib/core/projection/nominations.ts';
import {
	capHitFor,
	closedWinnerFor,
	decideClose,
	slotPlacementFor
} from '../../src/lib/core/rules/close.ts';
import type { AuctionClosedPayload, CloseState, ClosedWinner } from '../../src/lib/core/rules/close.ts';

const CLOSES_AT = '2026-08-27T09:00:00.000Z';
/**
 * The close instant itself — the EARLIEST instant a close is legal, because
 * `hasExpired` is `now >= closesAt`. Not one millisecond later: Story 3.5
 * hands each Auction its own nominal expiry as `now`, so a close at exactly
 * `closesAt` has to succeed or the sweep would never close anything.
 */
const AT_EXPIRY = CLOSES_AT;
const LATE = '2026-08-27T15:00:00.000Z';
const EARLY = '2026-08-27T08:59:59.999Z';

function bid(overrides: Partial<Bid> = {}): Bid {
	return {
		seq: '2',
		teamId: 't-m',
		teamName: 'Team M',
		managerId: 'm-m',
		amount: parseMoney(4_000_000),
		occurredAt: '2026-08-26T09:00:00.000Z',
		closesAt: CLOSES_AT,
		seedHash: null,
		...overrides
	};
}

function auctionOf(overrides: Partial<Auction> = {}): Auction {
	const leadingBid = overrides.leadingBid ?? bid();
	return {
		fantraxPlayerId: 'p-stash',
		contention: 'standard',
		leadingBid,
		closesAt: leadingBid.closesAt,
		bids: [leadingBid],
		contenders: [],
		seedHash: null,
		seed: null,
		...overrides
	};
}

const NOMINATION: OpenNomination = {
	fantraxPlayerId: 'p-stash',
	playerName: 'Ausar Bright',
	teamId: 't-n',
	teamName: 'Team N',
	occurredAt: '2026-08-26T08:00:00.000Z'
};

function stateOf(overrides: Partial<CloseState> = {}): CloseState {
	return {
		auction: auctionOf(),
		nomination: NOMINATION,
		playerIsMinorLeagueEligible: false,
		minorLeagueOccupied: 0,
		...overrides
	};
}

const DRAWN: ClosedWinner = {
	kind: 'drawn',
	teamId: 't-f',
	teamName: 'Team F',
	managerId: 'm-f',
	seed: 'a-revealed-seed',
	contenders: ['t-e', 't-f']
};

function payloadOf(state: CloseState, now = AT_EXPIRY, winner: ClosedWinner | null = null) {
	const decided = decideClose(state, now, winner);
	expect(decided.kind).toBe('accepted');
	expect(decided.events).toHaveLength(1);
	const event = decided.events[0];
	if (event === undefined) throw new Error('no event');
	expect(event.type).toBe(AUCTION_CLOSED_EVENT);
	return { event, payload: event.payload as AuctionClosedPayload };
}

// --- Slot Placement ---------------------------------------------------------

describe('slotPlacementFor — eligibility first, occupancy second (FR-21, FR-35)', () => {
	it('sends a Player who is not eligible to Active/Bench however empty the minors are', () => {
		// Eligibility is the FIRST test, not occupancy. Three empty Minor
		// League Slots change nothing for an ineligible Player.
		expect(slotPlacementFor(false, 0)).toBe('active_bench');
		expect(slotPlacementFor(false, 2)).toBe('active_bench');
		expect(slotPlacementFor(false, MINOR_LEAGUE_SLOTS)).toBe('active_bench');
	});

	it('sends an eligible Player to a free Minor League Slot while one exists', () => {
		expect(slotPlacementFor(true, 0)).toBe('minor_league');
		expect(slotPlacementFor(true, 1)).toBe('minor_league');
		// §10 example 16: two occupied, the win takes the third.
		expect(slotPlacementFor(true, 2)).toBe('minor_league');
	});

	it('sends an eligible Player to Active/Bench once all three are occupied', () => {
		// §10 example 17's overflow.
		expect(slotPlacementFor(true, MINOR_LEAGUE_SLOTS)).toBe('active_bench');
	});

	it('clamps above three rather than reading a negative M as a free Slot', () => {
		// A Commissioner override can legitimately leave four occupied; an
		// unclamped `max(0, 3 − occupied)` would go negative and then read as
		// "a Slot is free", handing that Team a reward for the override.
		expect(slotPlacementFor(true, 4)).toBe('active_bench');
		expect(slotPlacementFor(true, 99)).toBe('active_bench');
	});
});

describe('capHitFor — the two money fields are distinct (AD-23)', () => {
	it('charges the winning amount on an Active/Bench placement', () => {
		expect(capHitFor('active_bench', parseMoney(8_500_000))).toBe(8_500_000);
	});

	it('charges $0 on a Minor League placement while the amount stands', () => {
		const winningAmount = parseMoney(30_000_000);
		expect(capHitFor('minor_league', winningAmount)).toBe(0);
		// The argument is untouched: nothing here rewrites the winning amount
		// to match the Cap Hit, which is the conflation AD-23 forbids.
		expect(winningAmount).toBe(30_000_000);
	});
});

// --- The winner -------------------------------------------------------------

describe('closedWinnerFor — who won, and for how much', () => {
	it('awards a Standard Contention to the Leading Bidder at their own amount', () => {
		const auction = auctionOf({
			leadingBid: bid({ teamId: 't-8', teamName: 'Team T', managerId: 'm-8', amount: parseMoney(8_500_000) })
		});

		expect(closedWinnerFor(auction, null)).toEqual({
			teamId: 't-8',
			teamName: 'Team T',
			managerId: 'm-8',
			winningAmount: 8_500_000,
			contention: 'standard'
		});
	});

	it('awards a Minimum-Bid Contention to the DRAWN Contender at exactly $1,000,000', () => {
		// The leading Bid in a lottery is whichever Team opened it. The winner
		// is the drawn Contender, and the amount is the flat join amount —
		// never `leadingBid.amount`, which agrees only by coincidence today.
		const auction = auctionOf({
			contention: 'minimum_bid',
			leadingBid: bid({ teamId: 't-e', teamName: 'Team E', managerId: 'm-e', amount: parseMoney(MINIMUM_BID) }),
			contenders: [
				{ seq: '2', teamId: 't-e', teamName: 'Team E' },
				{ seq: '3', teamId: 't-f', teamName: 'Team F' }
			]
		});

		expect(closedWinnerFor(auction, DRAWN)).toEqual({
			teamId: 't-f',
			teamName: 'Team F',
			managerId: 'm-f',
			winningAmount: MINIMUM_BID,
			contention: 'minimum_bid'
		});
	});

	it('is the SAME derivation the shell and the core both ask', () => {
		// `server/close.ts` asks `closedWinnerFor` inside `load`, because it
		// needs the winning Team before it can read that Team's roster;
		// `decideClose` asks it again inside `decide`. The property worth
		// pinning is that the shell's answer is the one that reaches the LOG —
		// so assert the shell's derivation against the payload the core emits,
		// rather than the function against itself.
		const auction = auctionOf();
		const shellAnswer = closedWinnerFor(auction, null);
		const { payload } = payloadOf(stateOf({ auction }));

		expect(payload.teamId).toBe(shellAnswer.teamId);
		expect(payload.teamName).toBe(shellAnswer.teamName);
		expect(payload.managerId).toBe(shellAnswer.managerId);
		expect(payload.winningAmount).toBe(shellAnswer.winningAmount);
		expect(payload.contention).toBe(shellAnswer.contention);
	});

	it('agrees with the core on a LOTTERY close too, where the amounts differ', () => {
		// The case the tautology could never have caught: the leading Bid is
		// $4,000,000 but a drawn Contender wins at the flat MINIMUM_BID, so a
		// shell reading the winner off `leadingBid` would disagree with the
		// payload here and nowhere else.
		const auction = auctionOf({ contention: 'minimum_bid' });
		const shellAnswer = closedWinnerFor(auction, DRAWN);
		const { payload } = payloadOf(stateOf({ auction }), AT_EXPIRY, DRAWN);

		expect(payload.teamId).toBe(shellAnswer.teamId);
		expect(payload.managerId).toBe(shellAnswer.managerId);
		expect(payload.winningAmount).toBe(shellAnswer.winningAmount);
		expect(payload.winningAmount).toBe(MINIMUM_BID);
		expect(auction.leadingBid.amount).not.toBe(shellAnswer.winningAmount);
	});
});

// --- The four throws --------------------------------------------------------

describe('decideClose — every failure is a THROW, because a close has no gates (AD-1)', () => {
	it('throws when there is no Auction to close', () => {
		// Nobody bid, or it already closed. There is no winner and no price,
		// and a terminated unbid nomination is Story 3.7's.
		expect(() => decideClose(stateOf({ auction: null }), AT_EXPIRY, null)).toThrow(TypeError);
		expect(() => decideClose(stateOf({ auction: null }), AT_EXPIRY, null)).toThrow(
			/no Auction to close/
		);
		expect(() => closedWinnerFor(null, null)).toThrow(/no Auction to close/);
	});

	it('throws on a live Minimum-Bid Contention with no drawn winner, naming Story 3.6', () => {
		const state = stateOf({
			auction: auctionOf({
				contention: 'minimum_bid',
				leadingBid: bid({ amount: parseMoney(MINIMUM_BID) })
			})
		});

		expect(() => decideClose(state, AT_EXPIRY, null)).toThrow(TypeError);
		expect(() => decideClose(state, AT_EXPIRY, null)).toThrow(/Story 3\.6/);
	});

	it('throws on a Standard close handed a drawn winner anyway', () => {
		// A drawn Contender for an Auction with a Leading Bidder is a shell
		// bug: overriding the leader silently, or ignoring the draw silently,
		// would both be wrong answers.
		expect(() => decideClose(stateOf(), AT_EXPIRY, DRAWN)).toThrow(TypeError);
		expect(() => decideClose(stateOf(), AT_EXPIRY, DRAWN)).toThrow(/takes no drawn winner/);
	});

	it('throws on an Auction whose clock has not run out', () => {
		expect(() => decideClose(stateOf(), EARLY, null)).toThrow(TypeError);
		expect(() => decideClose(stateOf(), EARLY, null)).toThrow(/has not reached it/);
	});

	it('closes AT the close instant — the same boundary the expiry gate refuses on', () => {
		// `hasExpired` is `now >= closesAt`, so Story 3.5 handing an Auction
		// its own nominal expiry as `now` closes it rather than finding it
		// live (AD-12).
		expect(() => decideClose(stateOf(), AT_EXPIRY, null)).not.toThrow();
	});
});

// --- The event --------------------------------------------------------------

describe('decideClose — exactly one AuctionClosed, carrying the whole outcome', () => {
	it('appends one event, acted by the WINNER', () => {
		const state = stateOf({
			auction: auctionOf({
				leadingBid: bid({ teamId: 't-8', teamName: 'Team T', managerId: 'm-8', amount: parseMoney(8_500_000) })
			})
		});
		const { event, payload } = payloadOf(state);

		// `auction_events.manager_id`/`team_id` are NOT NULL and reference real
		// rows; a close needs no synthetic actor, and the Team that now owns
		// the contract is the honest answer.
		expect(event.managerId).toBe('m-8');
		expect(event.teamId).toBe('t-8');
		expect(payload.managerId).toBe('m-8');
		expect(payload.teamId).toBe('t-8');
		// Not a user action, so no measurement class is invented for it.
		expect(event.deviceClass).toBeUndefined();
	});

	it('records a Minor League placement at a $0 Cap Hit with the amount intact (§10 ex 16)', () => {
		const state = stateOf({
			auction: auctionOf({ leadingBid: bid({ amount: parseMoney(4_000_000) }) }),
			playerIsMinorLeagueEligible: true,
			minorLeagueOccupied: 2
		});

		expect(payloadOf(state).payload).toEqual({
			fantraxPlayerId: 'p-stash',
			playerName: 'Ausar Bright',
			teamId: 't-m',
			teamName: 'Team M',
			managerId: 'm-m',
			winningAmount: 4_000_000,
			capHit: 0,
			placement: 'minor_league',
			contention: 'standard',
			contractYears: null,
			closedAt: CLOSES_AT
		});
	});

	it('records an Active/Bench placement at the full amount', () => {
		const state = stateOf({
			auction: auctionOf({ leadingBid: bid({ amount: parseMoney(3_000_000) }) }),
			playerIsMinorLeagueEligible: true,
			minorLeagueOccupied: MINOR_LEAGUE_SLOTS
		});
		const { payload } = payloadOf(state);

		expect(payload.placement).toBe('active_bench');
		expect(payload.winningAmount).toBe(3_000_000);
		expect(payload.capHit).toBe(3_000_000);
	});

	it('records contract length UNSET', () => {
		expect(payloadOf(stateOf()).payload.contractYears).toBeNull();
	});

	it('states the Auction’s NOMINAL expiry as closedAt, not the transaction clock', () => {
		expect(payloadOf(stateOf(), LATE).payload.closedAt).toBe(CLOSES_AT);
	});

	it('names the Player by id when no nomination is in hand', () => {
		// Unreachable through any log this codebase writes — a Bid needs a
		// nomination, and both drop together on a close — so the field falls
		// back rather than standing as a fifth failure mode.
		expect(payloadOf(stateOf({ nomination: null })).payload.playerName).toBe('p-stash');
	});

	it('awards the lottery to the drawn Contender at $1,000,000, and reveals nothing', () => {
		const state = stateOf({
			auction: auctionOf({
				contention: 'minimum_bid',
				leadingBid: bid({ teamId: 't-e', teamName: 'Team E', managerId: 'm-e', amount: parseMoney(MINIMUM_BID) }),
				contenders: [
					{ seq: '2', teamId: 't-e', teamName: 'Team E' },
					{ seq: '3', teamId: 't-f', teamName: 'Team F' }
				],
				seedHash: 'a-published-commitment'
			})
		});
		const { payload } = payloadOf(state, AT_EXPIRY, DRAWN);

		expect(payload.teamId).toBe('t-f');
		expect(payload.winningAmount).toBe(MINIMUM_BID);
		expect(payload.contention).toBe('minimum_bid');
		// The reveal is Story 3.6's whole event, not half a field on this one.
		expect(Object.keys(payload)).not.toContain('seed');
		expect(Object.keys(payload)).not.toContain('contenders');
	});
});

describe('decideClose — the outcome is invariant under `now` (AD-10)', () => {
	it('produces byte-identical events on time and six hours late', () => {
		const state = stateOf({
			playerIsMinorLeagueEligible: true,
			minorLeagueOccupied: 2
		});

		// The ONE expression that reads `now` is the expiry guard; nothing
		// emitted varies with it. So a stalled sweep records LATE closes, never
		// WRONG ones — the whole of the difference between an inconvenience
		// and an SM-1 failure.
		expect(JSON.stringify(decideClose(state, LATE, null))).toBe(
			JSON.stringify(decideClose(state, AT_EXPIRY, null))
		);
	});

	it('reads no clock of its own — two calls with one `now` agree exactly', () => {
		expect(decideClose(stateOf(), LATE, null)).toEqual(decideClose(stateOf(), LATE, null));
	});
});
