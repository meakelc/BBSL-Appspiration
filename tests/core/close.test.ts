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
import { hash } from '../../src/lib/core/hash.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	BID_CANCELLED_EVENT,
	auctionForPlayer,
	auctionsReducer,
	hasExpired,
	wasCancelled
} from '../../src/lib/core/projection/auctions.ts';
import type { Auction, Bid, OpenAuctions } from '../../src/lib/core/projection/auctions.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import { CONTENTION_DRAWN_EVENT } from '../../src/lib/core/projection/draws.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import type { OpenNomination } from '../../src/lib/core/projection/nominations.ts';
import {
	capHitFor,
	closedWinnerFor,
	decideClose,
	slotPlacementFor
} from '../../src/lib/core/rules/close.ts';
import type {
	AuctionClosedPayload,
	BidCancelledPayload,
	CloseState,
	ClosedWinner,
	ContentionDrawnPayload
} from '../../src/lib/core/rules/close.ts';
import type { CandidateRosterFigures } from '../../src/lib/core/rules/restore.ts';
import type { AppendedEvent, EventEnvelope } from '../../src/lib/core/types.ts';

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
	managerId: 'm-n',
	occurredAt: '2026-08-26T08:00:00.000Z'
};

function stateOf(overrides: Partial<CloseState> = {}): CloseState {
	return {
		auction: auctionOf(),
		nomination: NOMINATION,
		playerIsMinorLeagueEligible: false,
		minorLeagueOccupied: 0,
		// **Story 10.3's cascade inputs.** `auctions` is empty here, so the
		// winning Team holds no other commitment and FR-40's cascade has
		// nothing to cancel whichever way the figures beside it go — which is
		// what keeps this example about the thing it is about.
		auctions: { byPlayer: {} },
		capSpace: parseMoney(0),
		rosterCount: 0,
		isMinorLeagueEligible: () => false,
		playerNameFor: (playerId: string) => playerId,
		// The shell derives this through `rules/draw.ts` and passes it as
		// `decideClose`'s third argument; a Standard close has none.
		drawnWinner: null,
		rosterFiguresFor: () => null,
		...overrides
	};
}

/**
 * A real 64-hex-digit seed, so the commitment beside it can be `hash(SEED)`
 * — DERIVED rather than written out, which is what makes the verification in
 * `decideClose` succeed for the real reason rather than because two literals
 * happened to be typed to match.
 */
const SEED = '4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e';

const DRAWN: ClosedWinner = {
	kind: 'drawn',
	teamId: 't-f',
	teamName: 'Team F',
	managerId: 'm-f',
	seed: SEED,
	contenders: ['t-e', 't-f'],
	// The position the drawer would have carried. `decideClose` publishes this
	// number rather than looking `t-f` up, and cross-checks that the two agree
	// — it does NOT re-run the reduction, which is `drawnWinnerFor`'s job and
	// is proven against this same seed in `tests/core/draw.test.ts`.
	selectedIndex: 1
};

/**
 * Drive `decideClose` and hand back the `AuctionClosed` it emitted.
 *
 * A Standard close emits exactly one event. A lottery close emits TWO — the
 * `ContentionDrawn` reveal and then the close, in that order (Story 3.6) — so
 * the count is asserted against which kind of close this is, and the payload
 * comes off the LAST event either way.
 */
function payloadOf(state: CloseState, now = AT_EXPIRY, winner: ClosedWinner | null = null) {
	const decided = decideClose(state, now, winner);
	expect(decided.kind).toBe('accepted');
	expect(decided.events).toHaveLength(winner === null ? 1 : 2);
	const event = decided.events[decided.events.length - 1];
	if (event === undefined) throw new Error('no event');
	expect(event.type).toBe(AUCTION_CLOSED_EVENT);
	return { decided, event, payload: event.payload as AuctionClosedPayload };
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
				{ seq: '2', teamId: 't-e', teamName: 'Team E', managerId: 'm-e' },
				{ seq: '3', teamId: 't-f', teamName: 'Team F', managerId: 'm-f' }
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
		expect(auction.leadingBid?.amount).not.toBe(shellAnswer.winningAmount);
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

	it('throws on a live Minimum-Bid Contention with no drawn winner, naming the drawer', () => {
		const state = stateOf({
			auction: auctionOf({
				contention: 'minimum_bid',
				leadingBid: bid({ amount: parseMoney(MINIMUM_BID) })
			})
		});

		expect(() => decideClose(state, AT_EXPIRY, null)).toThrow(TypeError);
		// It names what the caller must DO — derive a winner — rather than a
		// story that has since shipped. A drawer exists; this guards a caller
		// that failed to use it.
		expect(() => decideClose(state, AT_EXPIRY, null)).toThrow(/drawnWinnerFor/);
		expect(() => decideClose(state, AT_EXPIRY, null)).not.toThrow(/no drawer exists yet/);
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
					{ seq: '2', teamId: 't-e', teamName: 'Team E', managerId: 'm-e' },
					{ seq: '3', teamId: 't-f', teamName: 'Team F', managerId: 'm-f' }
				],
				seedHash: hash(SEED)
			})
		});
		const { payload } = payloadOf(state, AT_EXPIRY, DRAWN);

		expect(payload.teamId).toBe('t-f');
		expect(payload.winningAmount).toBe(MINIMUM_BID);
		expect(payload.contention).toBe('minimum_bid');
		// The reveal is its own EVENT, not half a field on this one — which is
		// why Story 3.4 declined to put a seed here and Story 3.6 did not
		// change its mind.
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

// --- The reveal (Story 3.6) -------------------------------------------------

/** A live lottery whose commitment is `hash(SEED)` and whose Contenders are E and F. */
function lotteryState(overrides: Partial<Auction> = {}): CloseState {
	return stateOf({
		auction: auctionOf({
			contention: 'minimum_bid',
			leadingBid: bid({
				teamId: 't-e',
				teamName: 'Team E',
				managerId: 'm-e',
				amount: parseMoney(MINIMUM_BID)
			}),
			contenders: [
				{ seq: '2', teamId: 't-e', teamName: 'Team E', managerId: 'm-e' },
				{ seq: '3', teamId: 't-f', teamName: 'Team F', managerId: 'm-f' }
			],
			seedHash: hash(SEED),
			...overrides
		})
	});
}

describe('decideClose — ContentionDrawn, then AuctionClosed (Story 3.6, AD-14)', () => {
	it('emits TWO events and the reveal comes FIRST', () => {
		const decided = decideClose(lotteryState(), AT_EXPIRY, DRAWN);

		expect(decided.events).toHaveLength(2);
		// Cause then consequence: a log read in `seq` order states the draw
		// that selected the winner before the close that awarded the Player.
		expect(decided.events[0]?.type).toBe(CONTENTION_DRAWN_EVENT);
		expect(decided.events[1]?.type).toBe(AUCTION_CLOSED_EVENT);
	});

	it('carries the seed, the commitment, the ordered list and the selection', () => {
		const decided = decideClose(lotteryState(), AT_EXPIRY, DRAWN);
		const drawn = decided.events[0]?.payload as ContentionDrawnPayload;

		expect(drawn).toEqual({
			fantraxPlayerId: 'p-stash',
			seed: SEED,
			seedHash: hash(SEED),
			contenders: ['t-e', 't-f'],
			selectedIndex: 1,
			winningTeamId: 't-f',
			winningTeamName: 'Team F',
			winningManagerId: 'm-f',
			drawnAt: CLOSES_AT
		} satisfies ContentionDrawnPayload);
		// The recorded position and the recorded winner agree by construction,
		// which is what a Manager who ran the arithmetic checks against.
		expect(drawn.contenders[drawn.selectedIndex]).toBe(drawn.winningTeamId);
	});

	it('acts both events as the WINNER, never as whoever opened the lottery', () => {
		const decided = decideClose(lotteryState(), AT_EXPIRY, DRAWN);

		for (const event of decided.events) {
			expect(event.teamId).toBe('t-f');
			expect(event.managerId).toBe('m-f');
		}
		// The opener led the Auction and did not win it.
		expect(decided.events[0]?.teamId).not.toBe('t-e');
	});

	it('throws, appending nothing, when the seed does not answer the commitment', () => {
		const state = lotteryState({ seedHash: hash('a-different-seed') });

		expect(() => decideClose(state, AT_EXPIRY, DRAWN)).toThrow(TypeError);
		expect(() => decideClose(state, AT_EXPIRY, DRAWN)).toThrow(/does not match the published/);
	});

	it('draws anyway when the commitment folded to null, and states the null', () => {
		// Reachable only from a corrupt or hand-written log. Refusing would
		// strand the Auction in a contention forever with every Contender's
		// capital committed, so the draw runs and the reveal says outright
		// that there was nothing to check it against.
		const decided = decideClose(lotteryState({ seedHash: null }), AT_EXPIRY, DRAWN);
		const drawn = decided.events[0]?.payload as ContentionDrawnPayload;

		expect(decided.events).toHaveLength(2);
		expect(drawn.seedHash).toBeNull();
		expect(drawn.seed).toBe(SEED);
	});

	it('is invariant under `now` — the reveal is byte-identical late', () => {
		expect(JSON.stringify(decideClose(lotteryState(), LATE, DRAWN))).toBe(
			JSON.stringify(decideClose(lotteryState(), AT_EXPIRY, DRAWN))
		);
	});

	it('publishes the position the DRAWER carried, never a lookup of the winner', () => {
		// The list holds `t-f` twice. A `decideClose` that recovered the index
		// with `indexOf` would publish 1 — the first occurrence — while the
		// reduction that actually chose the winner produced 2. The number a
		// Manager checks their spreadsheet against must be the arithmetic's.
		const duplicated: ClosedWinner = {
			...DRAWN,
			contenders: ['t-e', 't-f', 't-f'],
			selectedIndex: 2
		};

		const decided = decideClose(lotteryState(), AT_EXPIRY, duplicated);
		const drawn = decided.events[0]?.payload as ContentionDrawnPayload;

		expect(drawn.selectedIndex).toBe(2);
		expect(drawn.contenders[drawn.selectedIndex]).toBe('t-f');
	});

	it('throws when the carried position is outside the list it was drawn from', () => {
		const offList: ClosedWinner = { ...DRAWN, selectedIndex: 2 };

		expect(() => decideClose(lotteryState(), AT_EXPIRY, offList)).toThrow(
			/not a place in the Contender list/
		);
	});

	it('throws when the carried position and the carried winner disagree', () => {
		// `t-f` is real and position 0 is real; they are just not each other.
		// Neither is silently preferred over the other.
		const mismatched: ClosedWinner = { ...DRAWN, selectedIndex: 0 };

		expect(() => decideClose(lotteryState(), AT_EXPIRY, mismatched)).toThrow(
			/is not at position 0/
		);
	});

	it('throws when the winner is not on the list it was drawn from at all', () => {
		const stranger: ClosedWinner = { ...DRAWN, teamId: 't-z', teamName: 'Team Z' };

		expect(() => decideClose(lotteryState(), AT_EXPIRY, stranger)).toThrow(/is not at position/);
	});

	it('throws on a revealed seed that is not 64 lowercase hex digits', () => {
		// The commitment check cannot stand in for this one: with `seedHash`
		// null it never runs, and an unshaped seed would reach the payload.
		const unshaped: ClosedWinner = { ...DRAWN, seed: 'not-a-seed' };
		const state = lotteryState({ seedHash: null });

		expect(() => decideClose(state, AT_EXPIRY, unshaped)).toThrow(/64 lowercase hex digits/);
	});
});

describe('closedWinnerFor — the winner it is handed is validated (Story 3.6)', () => {
	const lottery = () =>
		auctionOf({
			contention: 'minimum_bid',
			leadingBid: bid({ amount: parseMoney(MINIMUM_BID) })
		});

	it.each([['teamId'], ['teamName'], ['managerId']] as const)(
		'throws on an empty %s, at the rule that can name it rather than at the FK',
		(field: 'teamId' | 'teamName' | 'managerId') => {
			// `auction_events.manager_id`/`team_id` are `not null` and
			// reference real rows, so an empty identity would otherwise fail at
			// the insert with a driver's message, after the whole close had
			// been computed.
			const winner: ClosedWinner = { ...DRAWN, [field]: '' };

			expect(() => closedWinnerFor(lottery(), winner)).toThrow(TypeError);
			expect(() => closedWinnerFor(lottery(), winner)).toThrow(new RegExp(`empty "${field}"`));
		}
	);

	it('accepts a winner whose three identities are all present', () => {
		expect(closedWinnerFor(lottery(), DRAWN).teamId).toBe('t-f');
	});
});


// --- The cancellation cascade (Story 10.3, FR-40) -------------------------

/**
 * The I/O matrix of FR-40's cascade, row by row, against state literals.
 *
 * §10 examples 31, 34 and 35 own the worked cases in their own files; what is
 * pinned here is the RULE those examples are instances of — the trigger, the
 * ordering, the stop condition, the two negatives, and the one commitment the
 * cascade must walk past however recent it is.
 */

const OTHER_CLOSES = '2026-08-29T09:00:00.000Z';

/** One Bid by the winning Team on a DIFFERENT Auction. */
function commitment(seq: string, amount: number): Bid {
	return bid({ seq, amount: parseMoney(amount), closesAt: OTHER_CLOSES });
}

/** A Standard Auction the winning Team leads, and optionally an older rival. */
function leadOn(fantraxPlayerId: string, leader: Bid, beneath: readonly Bid[] = []): Auction {
	return {
		fantraxPlayerId,
		contention: 'standard',
		leadingBid: leader,
		closesAt: leader.closesAt,
		bids: [...beneath, leader],
		contenders: [],
		seedHash: null,
		seed: null
	};
}

function auctionsOf(entries: readonly Auction[]): OpenAuctions {
	return {
		byPlayer: Object.fromEntries(entries.map((auction) => [auction.fantraxPlayerId, auction]))
	};
}

/**
 * A close by the same Team M, with its roster BEFORE the close and whatever
 * else it is holding.
 *
 * `eligible` answers for the OTHER Auctions; `playerIsMinorLeagueEligible`
 * still answers for the one being closed, because those are two different
 * questions and the fixture must be able to make them disagree.
 */
function cascadeState(input: {
	readonly rosterCount: number;
	readonly minorLeagueOccupied?: number;
	readonly holding: readonly Auction[];
	readonly wonIsEligible?: boolean;
	readonly eligible?: (fantraxPlayerId: string) => boolean;
	/** Story 10.4: the candidate Teams the shell's batched read covered. */
	readonly candidates?: (teamId: string) => CandidateRosterFigures | null;
}): CloseState {
	const won = auctionOf();
	return stateOf({
		// **The default is PERMISSIVE, deliberately** (Story 10.4). Answering
		// `null` here would make every candidate fail on "the batched read did
		// not cover this Team" rather than on the rule, and a leaderless
		// assertion would then be true for a reason that has nothing to do
		// with FR-40. A roomy Team means any candidate these fixtures produce
		// is judged on the merits; a test that wants a candidate refused says
		// so through `candidates`.
		rosterFiguresFor:
			input.candidates ??
			(() => ({ capSpace: parseMoney(50_000_000), rosterCount: 4, minorLeagueOccupied: 0 })),
		auction: won,
		playerIsMinorLeagueEligible: input.wonIsEligible ?? false,
		minorLeagueOccupied: input.minorLeagueOccupied ?? 0,
		auctions: auctionsOf([won, ...input.holding]),
		capSpace: parseMoney(50_000_000),
		rosterCount: input.rosterCount,
		isMinorLeagueEligible: input.eligible ?? (() => false),
		playerNameFor: (playerId: string) => `Player ${playerId}`
	});
}

function cancellationsOf(events: readonly EventEnvelope[]): readonly BidCancelledPayload[] {
	return events
		.filter((event) => event.type === BID_CANCELLED_EVENT)
		.map((event) => event.payload as BidCancelledPayload);
}

function appendedAt(seq: number, event: EventEnvelope): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt: CLOSES_AT,
		schemaVersion: 1,
		coreVersion: 2,
		type: event.type,
		payload: event.payload,
		managerId: event.managerId,
		teamId: event.teamId,
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

describe('the cancellation cascade — FR-40 (Story 10.3)', () => {
	it('cancels nothing when the Team is still within capacity after the Close', () => {
		// Roster Count 10 → 11, so `F` falls 2 → 1 and the trigger DOES fire.
		// Two surviving commitments against an allowance of `1 + 1` is within
		// capacity, so the re-test stops it. The cascade is conditional.
		const decided = decideClose(
			cascadeState({
				rosterCount: 10,
				holding: [
					leadOn('p-a', commitment('100', 3_000_000)),
					leadOn('p-b', commitment('140', 2_000_000))
				]
			}),
			AT_EXPIRY,
			null
		);

		expect(decided.events.map((event) => event.type)).toEqual([AUCTION_CLOSED_EVENT]);
	});

	it('cancels nothing when the Close reduces no free Slot at all', () => {
		// A Team already at Roster Count 12 with three occupied Minor League
		// Slots: `F` is 0 and `M` is 0 on both sides of the close, so nothing
		// was reduced and no cascade runs — even though the commitment it
		// holds could not land. The trigger is a REDUCTION, not a shortage.
		const decided = decideClose(
			cascadeState({
				rosterCount: 12,
				minorLeagueOccupied: MINOR_LEAGUE_SLOTS,
				holding: [leadOn('p-a', commitment('100', 3_000_000))]
			}),
			AT_EXPIRY,
			null
		);

		expect(decided.events.map((event) => event.type)).toEqual([AUCTION_CLOSED_EVENT]);
	});

	it('cancels the MOST RECENT commitment and stops the instant the test passes', () => {
		// Roster Count 11 → 12, `F` 1 → 0. Three surviving commitments, and
		// every one of them now fails the precondition — so all three go, in
		// descending `seq`, and the cascade stops because there is nothing
		// left rather than because it ran out of patience.
		const decided = decideClose(
			cascadeState({
				rosterCount: 11,
				holding: [
					leadOn('p-a', commitment('100', 3_000_000)),
					leadOn('p-b', commitment('140', 2_000_000)),
					leadOn('p-c', commitment('190', 1_500_000))
				]
			}),
			AT_EXPIRY,
			null
		);

		expect(cancellationsOf(decided.events).map((payload) => payload.cancelledSeq)).toEqual([
			'190',
			'140',
			'100'
		]);
		// Every one of those Auctions holds the winner's Bid and nothing else,
		// so there is nobody to restore on any of them — stated rather than
		// left to be inferred from a `null` that could have several causes.
		expect(cancellationsOf(decided.events).map((payload) => payload.restoration)).toEqual([
			null,
			null,
			null
		]);
	});

	it('takes only the newest when the allowance still covers the rest', () => {
		// Roster Count 9 → 10, `F` 3 → 2, allowance 3, and FOUR commitments.
		// One over, one cancelled: the two older ones and the third are within
		// `P = 3 <= 3` once the fourth is gone, and nothing further is taken.
		const decided = decideClose(
			cascadeState({
				rosterCount: 9,
				holding: [
					leadOn('p-a', commitment('100', 3_000_000)),
					leadOn('p-b', commitment('140', 2_000_000)),
					leadOn('p-c', commitment('190', 1_500_000)),
					leadOn('p-d', commitment('230', 1_000_000))
				]
			}),
			AT_EXPIRY,
			null
		);

		expect(cancellationsOf(decided.events).map((payload) => payload.cancelledSeq)).toEqual([
			'230'
		]);
	});

	it('fires on a MINOR LEAGUE placement that leaves Roster Count untouched', () => {
		// The matrix row the trigger wording exists for, as a unit rather than
		// only as §10 example 35. The won Player is eligible and one Minor
		// League Slot is free, so the placement is `minor_league`: the Cap Hit
		// is `$0`, Roster Count is 12 before and 12 after, and `F` is 0 on both
		// sides. NOTHING on the Active/Bench side moved — the only figure that
		// fell is `M`, from 1 to 0 — and the cascade fires on that alone.
		const decided = decideClose(
			cascadeState({
				rosterCount: 12,
				minorLeagueOccupied: MINOR_LEAGUE_SLOTS - 1,
				wonIsEligible: true,
				holding: [leadOn('p-a', commitment('100', 3_000_000))]
			}),
			AT_EXPIRY,
			null
		);

		const closed = decided.events[0]?.payload as AuctionClosedPayload;
		expect(closed.placement).toBe('minor_league');
		expect(closed.capHit).toBe(0);
		expect(cancellationsOf(decided.events).map((payload) => payload.cancelledSeq)).toEqual([
			'100'
		]);
	});

	it('does NOT fire on a minors placement while a Minor League Slot is still free', () => {
		// The same close with two free minors Slots: `M` falls 2 → 1, which is
		// still a reduction and still fires — so the pair below is what
		// separates "a Slot was reduced" from "a Slot ran out". Here the
		// commitment the Team holds is itself eligible and the remaining Slot
		// absorbs it, so the cascade takes nothing. A trigger keyed on Roster
		// Count would have reached neither case.
		const decided = decideClose(
			cascadeState({
				rosterCount: 12,
				minorLeagueOccupied: MINOR_LEAGUE_SLOTS - 2,
				wonIsEligible: true,
				holding: [leadOn('p-a', commitment('100', 3_000_000))],
				eligible: () => true
			}),
			AT_EXPIRY,
			null
		);

		expect((decided.events[0]?.payload as AuctionClosedPayload).placement).toBe('minor_league');
		expect(decided.events.map((event) => event.type)).toEqual([AUCTION_CLOSED_EVENT]);
	});

	it('walks past an eligible commitment a free Minor League Slot can absorb', () => {
		// The carve-out that must not be restated as a second rule. `F` falls
		// 1 → 0 and `M` stays 1. The eligible lead is the MOST RECENT
		// commitment the Team holds, and it is left alone — an eligible win a
		// minors Slot absorbs adds nothing to Projected Active/Bench
		// Additions, so it passes the gate against its seniors. The older
		// non-eligible commitment is what is over, and what goes.
		const decided = decideClose(
			cascadeState({
				rosterCount: 11,
				minorLeagueOccupied: MINOR_LEAGUE_SLOTS - 1,
				holding: [
					leadOn('p-plain', commitment('100', 3_000_000)),
					leadOn('p-prospect', commitment('300', 2_000_000))
				],
				eligible: (playerId: string) => playerId === 'p-prospect'
			}),
			AT_EXPIRY,
			null
		);

		const cancelled = cancellationsOf(decided.events);
		expect(cancelled.map((payload) => payload.cancelledSeq)).toEqual(['100']);
		expect(cancelled[0]?.fantraxPlayerId).toBe('p-plain');
	});

	it('leaves an Auction leaderless — and clockless — when nothing survives on it', () => {
		// §10 example 33's state, minus the restoration 10.4 owns. The
		// cancelled Bid was the Opening Bid and nobody else bid, so the
		// Auction returns to Awaiting Opening Bid with its clock CLEARED —
		// which is what stops it closing at the old expiry with no winner.
		const solo = leadOn('p-solo', commitment('500', 2_000_000));
		const decided = decideClose(
			cascadeState({ rosterCount: 11, holding: [solo] }),
			AT_EXPIRY,
			null
		);
		expect(cancellationsOf(decided.events).map((payload) => payload.cancelledSeq)).toEqual([
			'500'
		]);
		// **No restoration, and the reason matters** (Story 10.4). `p-solo`
		// holds exactly ONE Bid — the cancelled one — so the selector has no
		// candidate to walk to. It is not that a candidate was refused, and it
		// is not that the fixture withheld a roster read: `cascadeState`'s
		// default covers every Team roomily. There is genuinely nobody below.
		expect(cancellationsOf(decided.events)[0]?.restoration).toBeNull();

		const folded = fold(
			auctionsOf([solo]),
			decided.events.map((event, index) => appendedAt(900 + index, event)),
			auctionsReducer
		);
		const after = auctionForPlayer(folded, 'p-solo');

		expect(after?.leadingBid).toBeNull();
		expect(after?.closesAt).toBeNull();
		expect(after?.contention).toBe('awaiting_opening_bid');
		// The Bid is still there — struck through, never deleted.
		expect(after?.bids).toHaveLength(1);
		expect(wasCancelled(after?.bids[0] as Bid)).toBe(true);
		// ...and no clock means no close at the old expiry, ever.
		expect(hasExpired(after?.closesAt ?? null, '2030-01-01T00:00:00.000Z')).toBe(false);
	});

	it('leaves the Auction Clock alone where a Bid is RESTORED (Story 10.4)', () => {
		// "A cancellation resets nothing and removes nothing" — and since
		// Story 10.4 the clock survives because a LEADER does, not merely
		// because a Bid does. Team Z has room and money, so its $1,000,000 is
		// re-validated, passes, and is seated: the price falls, the Auction
		// Clock does not move, and the Restored Leading Bidder inherits
		// whatever is left of it.
		const rival = bid({ seq: '400', teamId: 't-z', teamName: 'Team Z', managerId: 'm-z', amount: parseMoney(1_000_000), closesAt: OTHER_CLOSES });
		const contested = leadOn('p-contested', commitment('500', 2_000_000), [rival]);
		const decided = decideClose(
			cascadeState({
				rosterCount: 11,
				holding: [contested],
				candidates: (teamId) =>
					teamId === 't-z'
						? { capSpace: parseMoney(50_000_000), rosterCount: 4, minorLeagueOccupied: 0 }
						: null
			}),
			AT_EXPIRY,
			null
		);

		expect(cancellationsOf(decided.events)[0]?.restoration).toEqual({
			seq: '400',
			teamId: 't-z',
			teamName: 'Team Z',
			managerId: 'm-z',
			amount: 1_000_000
		});

		const folded = fold(
			auctionsOf([contested]),
			decided.events.map((event, index) => appendedAt(900 + index, event)),
			auctionsReducer
		);
		const after = auctionForPlayer(folded, 'p-contested');

		expect(after?.closesAt).toBe(OTHER_CLOSES);
		expect(after?.contention).toBe('standard');
		expect(after?.leadingBid?.seq).toBe('400');
		expect(after?.leadingBid?.amount).toBe(1_000_000);
		expect(after?.bids.map((entry) => entry.seq)).toEqual(['400', '500']);
	});

	it('clears the clock when the only survivor FAILS re-validation', () => {
		// The matrix row that separates 10.4 from 10.3: `highestStandingBid`
		// is non-null — Team Z's Bid is right there, un-cancelled, in the
		// history — and the Auction still goes leaderless, because the fold
		// reads the recorded decision instead of promoting the highest
		// survivor. Team Z is at the twelve here, so it is skipped.
		const rival = bid({ seq: '400', teamId: 't-z', teamName: 'Team Z', managerId: 'm-z', amount: parseMoney(1_000_000), closesAt: OTHER_CLOSES });
		const contested = leadOn('p-contested', commitment('500', 2_000_000), [rival]);
		const decided = decideClose(
			cascadeState({
				rosterCount: 11,
				holding: [contested],
				candidates: (teamId) =>
					teamId === 't-z'
						? { capSpace: parseMoney(50_000_000), rosterCount: 12, minorLeagueOccupied: 0 }
						: null
			}),
			AT_EXPIRY,
			null
		);

		expect(cancellationsOf(decided.events)[0]?.restoration).toBeNull();

		const folded = fold(
			auctionsOf([contested]),
			decided.events.map((event, index) => appendedAt(900 + index, event)),
			auctionsReducer
		);
		const after = auctionForPlayer(folded, 'p-contested');

		expect(after?.leadingBid).toBeNull();
		expect(after?.closesAt).toBeNull();
		expect(after?.contention).toBe('awaiting_opening_bid');
		// The skipped Bid is NOT cancelled: it stands, in the history, unmarked.
		expect(after?.bids.map((entry) => entry.seq)).toEqual(['400', '500']);
		expect(wasCancelled(after?.bids[0] as Bid)).toBe(false);
		// ...and no clock means no close at the old expiry, ever.
		expect(hasExpired(after?.closesAt ?? null, '2030-01-01T00:00:00.000Z')).toBe(false);
	});

	/**
	 * **"A candidate is never restored and then cancelled" (FR-40), as a
	 * cascade-level regression guard** (Story 10.4).
	 *
	 * The bound that terminates the cascade is that a restoration is not a
	 * cancellation trigger. What could still break it is the cascade's own
	 * loop: it re-derives `commitmentsFor` after every cancellation, and a
	 * Team just handed a lead is holding one more commitment than it was a
	 * moment ago. If that lead could then be selected as a victim, the cascade
	 * would restore and cancel the same Bid inside one close.
	 *
	 * **It cannot, and the reason is monotonicity rather than a guard.**
	 * `commitmentStands` judges a commitment against the SENIORITY PREFIX —
	 * the older commitments already kept, plus this one. `candidateStands`
	 * judges a restoration candidate against that Team's ENTIRE remaining
	 * commitment set. Projected Active/Bench Additions only grows as
	 * commitments are added, so the restoration test is strictly the stricter
	 * of the two: anything that passes it passes the prefix test the next
	 * iteration applies. The restoration test also requires `cap` where the
	 * cascade reads `slots` alone.
	 *
	 * The shape below is the hardest one available, because it is the one
	 * where the eligible carve-out could plausibly let a Team's own older Bid
	 * back in: the winner is at Roster Count 12 with NO free Active/Bench Slot
	 * and ONE free Minor League Slot after the close, and it holds older,
	 * outbid Bids of its own on the Minor-League-eligible Auctions whose
	 * leading Bids the cascade takes.
	 */
	describe('a restored Bid is never cancelled by the same cascade (FR-40)', () => {
		/** Team M's own older Bid, outbid on the same Auction it now leads. */
		const M_OLD_E1 = bid({ seq: '100', amount: parseMoney(2_000_000), closesAt: OTHER_CLOSES });
		const M_OLD_E2 = bid({ seq: '110', amount: parseMoney(1_500_000), closesAt: OTHER_CLOSES });
		const rival = (seq: string, teamId: string, amount: number) =>
			bid({
				seq,
				teamId,
				teamName: `Team ${teamId}`,
				managerId: `m-${teamId}`,
				amount: parseMoney(amount),
				closesAt: OTHER_CLOSES
			});

		/**
		 * Two eligible Auctions Team M leads over its own older Bids and a
		 * rival's, plus one plain Auction it leads alone.
		 *
		 * Roster Count 12 with ONE free Minor League Slot before the close and
		 * a Minor-League-eligible win: the placement is `minor_league`, Roster
		 * Count does not move, `M` falls 2 → 1, and the cascade fires on that
		 * alone. Afterwards `F` is 0 and one minors Slot is still free — so
		 * ONE eligible commitment is absorbed and the second overflows.
		 */
		const E1 = leadOn('p-e1', commitment('300', 3_000_000), [M_OLD_E1, rival('200', 't-r', 2_500_000)]);
		const E2 = leadOn('p-e2', commitment('400', 3_500_000), [M_OLD_E2, rival('210', 't-s', 3_000_000)]);
		const PLAIN = leadOn('p-plain', commitment('500', 1_000_000));

		function cascade(candidates: (teamId: string) => CandidateRosterFigures | null) {
			return decideClose(
				cascadeState({
					rosterCount: 12,
					minorLeagueOccupied: MINOR_LEAGUE_SLOTS - 2,
					wonIsEligible: true,
					holding: [E1, E2, PLAIN],
					eligible: (playerId: string) => playerId === 'p-e1' || playerId === 'p-e2',
					candidates
				}),
				AT_EXPIRY,
				null
			);
		}

		/** The invariant, asked of whatever the cascade actually produced. */
		function assertNoRestoredBidWasCancelled(payloads: readonly BidCancelledPayload[]) {
			const restored = new Set<string>();
			for (const payload of payloads) {
				expect(restored.has(payload.cancelledSeq)).toBe(false);
				const seq = payload.restoration?.seq ?? null;
				if (seq !== null) restored.add(seq);
			}
		}

		it('holds when a RIVAL is restored mid-cascade — the non-vacuous case', () => {
			// Team S has room, so the second cancellation genuinely restores
			// somebody and the invariant has something to be about.
			const decided = cascade((teamId) =>
				teamId === 't-s'
					? { capSpace: parseMoney(50_000_000), rosterCount: 5, minorLeagueOccupied: 0 }
					: null
			);
			const payloads = cancellationsOf(decided.events);

			// The placement fired the cascade on the minors side alone.
			expect((decided.events[0]?.payload as AuctionClosedPayload).placement).toBe(
				'minor_league'
			);
			// Most recent first: the plain lead, then the overflowing eligible
			// one. The absorbed eligible lead is walked past and never taken.
			expect(payloads.map((payload) => payload.cancelledSeq)).toEqual(['500', '400']);
			expect(payloads.map((payload) => payload.restoration?.seq ?? null)).toEqual([null, '210']);

			assertNoRestoredBidWasCancelled(payloads);
			// ...and the cascade stopped rather than coming back for the Bid it
			// had just handed to Team S.
			expect(payloads.map((payload) => payload.fantraxPlayerId)).toEqual(['p-plain', 'p-e2']);

			// Stated on the fold as well as on the events: Team S leads `p-e2`
			// when the dust settles, and its Bid carries no cancellation mark.
			const folded = fold(
				auctionsOf([E1, E2, PLAIN]),
				decided.events.map((event, index) => appendedAt(900 + index, event)),
				auctionsReducer
			);
			const e2 = auctionForPlayer(folded, 'p-e2');
			expect(e2?.leadingBid?.seq).toBe('210');
			expect(e2?.leadingBid?.teamId).toBe('t-s');
			expect(wasCancelled(e2?.bids.find((entry) => entry.seq === '210') as Bid)).toBe(false);
		});

		it('holds when the winner’s OWN older Bid is the last candidate standing', () => {
			// Nobody else is covered, so the walk reaches Team M's own outbid
			// $1,500,000 on `p-e2` — the case the eligible carve-out could
			// plausibly admit. It does not: the candidate is judged against
			// Team M's WHOLE remaining commitment set, where its surviving
			// eligible lead on `p-e1` already takes the one free Minor League
			// Slot, so the prospective win overflows into an Active/Bench Slot
			// that is not there.
			const decided = cascade(() => null);
			const payloads = cancellationsOf(decided.events);

			expect(payloads.map((payload) => payload.cancelledSeq)).toEqual(['500', '400']);
			expect(payloads.map((payload) => payload.restoration)).toEqual([null, null]);
			assertNoRestoredBidWasCancelled(payloads);
			// The winner's own older Bid was CONSIDERED and refused, not
			// excluded by name — it is still standing, uncancelled, in history.
			expect(payloads.some((payload) => payload.cancelledSeq === '110')).toBe(false);
		});
	});

	it('refuses to close a leaderless Auction rather than inventing a winner', () => {
		// The fourth throw. A leaderless Auction has no winner and no price;
		// its clock is cleared precisely so no close is attempted, and a
		// caller that reached one anyway is a bug (AD-1).
		const leaderless: Auction = {
			...auctionOf(),
			leadingBid: null,
			closesAt: null
		};
		expect(() => closedWinnerFor(leaderless, null)).toThrow(/no Leading Bidder/);
	});

	it('names the causing Close on every cancellation it appends', () => {
		const decided = decideClose(
			cascadeState({
				rosterCount: 11,
				holding: [leadOn('p-a', commitment('100', 3_000_000))]
			}),
			AT_EXPIRY,
			null
		);
		const cancelled = cancellationsOf(decided.events)[0];

		// The Auction being closed, by id and by name — the win a Manager is
		// told cost them this Bid.
		expect(cancelled?.causeFantraxPlayerId).toBe('p-stash');
		expect(cancelled?.causePlayerName).toBe('Ausar Bright');
		expect(cancelled?.causeTeamId).toBe('t-m');
		// ...and the commitment itself, named for the notice and the log.
		expect(cancelled?.fantraxPlayerId).toBe('p-a');
		expect(cancelled?.playerName).toBe('Player p-a');
		expect(cancelled?.amount).toBe(3_000_000);
		expect(cancelled?.restoration).toBeNull();
	});

	it('is invariant under `now`, exactly as the close it follows is', () => {
		// AD-10 again: a sweep six hours late must produce byte-identical
		// events, cancellations included.
		const state = cascadeState({
			rosterCount: 11,
			holding: [
				leadOn('p-a', commitment('100', 3_000_000)),
				leadOn('p-b', commitment('140', 2_000_000))
			]
		});
		expect(JSON.stringify(decideClose(state, AT_EXPIRY, null))).toBe(
			JSON.stringify(decideClose(state, LATE, null))
		);
	});
});
