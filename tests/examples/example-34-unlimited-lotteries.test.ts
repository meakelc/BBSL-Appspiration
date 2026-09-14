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
 * > Three of the six expire in the same sweep. The first is drawn and **Team
 * > X wins**: Roster Count 12, Free Active/Bench Slots 0. Before the second is
 * > drawn, the cascade cancels Team X's five remaining entries
 * > most-recent-first, releasing $5,000,000.
 *
 * **This file owns the entry half and, since Story 10.3, the cascade.** What
 * the first half asserts is the property the cascade exists to make safe:
 * that a Team with ONE free Slot may hold nine outstanding lottery entries,
 * that the capacity gate passes every one of them, and that the tenth is
 * refused by the money gate rather than by capacity. A revision that refused
 * the third on capacity would still leave the tenth refused — so the passing
 * cases are the load-bearing assertions, not the failing one.
 *
 * **The second half is the win that ends them**, and since Story 10.5 this
 * file owns all of it. Story 10.3 wrote the cascade — five entries, most
 * recent first, $5,000,000 released, and every one of them out of its
 * Contender list before anything is drawn. Story 10.5 wrote the two draws
 * that follow: the second lottery drawn from a list that no longer holds Team
 * X, and the lottery Team X was the ONLY Contender in, which reaches its own
 * expiry with nobody in it, reveals its seed over an empty list and
 * terminates with no winner — the Player back in the pool and the nominator's
 * Slot with them.
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
import { hash } from '../../src/lib/core/hash.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	BID_CANCELLED_EVENT,
	auctionForPlayer,
	auctionsReducer,
	wasCancelled
} from '../../src/lib/core/projection/auctions.ts';
import type {
	Auction,
	Bid,
	Contender,
	OpenAuctions
} from '../../src/lib/core/projection/auctions.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	CONTENTION_DRAWN_EVENT,
	INITIAL_DRAWS,
	drawForPlayer,
	drawsReducer
} from '../../src/lib/core/projection/draws.ts';
import {
	AUCTION_CLOSED_EVENT,
	AUCTION_TERMINATED_EVENT,
	INITIAL_NOMINATIONS,
	NOMINATION_PLACED_EVENT,
	nominationForPlayer,
	nominationForTeam,
	nominationsReducer
} from '../../src/lib/core/projection/nominations.ts';
import { decideClose } from '../../src/lib/core/rules/close.ts';
import type {
	BidCancelledPayload,
	CloseState,
	DrawnContentionPayload,
	DrawnWinner,
	UndrawnContentionPayload
} from '../../src/lib/core/rules/close.ts';
import { drawIndex, drawnWinnerFor } from '../../src/lib/core/rules/draw.ts';
import type { AppendedEvent, EventEnvelope } from '../../src/lib/core/types.ts';
import {
	allGatesPassed,
	bidRefusalDetail,
	bidStateFor,
	decide,
	evaluate,
	failedGates,
	teamMoneyStateFor
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


// --- The close half: the one win that ends them ---------------------------

/**
 * A real 64-hex seed and the commitment published against it — DERIVED, so
 * `decideClose`'s verification succeeds for the real reason rather than
 * because two literals happened to be typed to match.
 */
const SEED = '9c2ab1704e6f8d539c2ab1704e6f8d539c2ab1704e6f8d539c2ab1704e6f8d53';
const SEED_HASH = hash(SEED);

/** The fixed instant every one of these lotteries closes at. */
const LOTTERY_CLOSES = '2026-08-25T09:00:00.000Z';

function joinBid(seq: string, teamId: string, teamName: string, managerId: string): Bid {
	return {
		seq,
		teamId,
		teamName,
		managerId,
		// Every Contender holds the identical flat join amount (FR-14).
		amount: parseMoney(MINIMUM_BID),
		occurredAt: '2026-08-24T09:00:00.000Z',
		closesAt: LOTTERY_CLOSES,
		seedHash: null
	};
}

function contenderOf(bid: Bid): Contender {
	return { seq: bid.seq, teamId: bid.teamId, teamName: bid.teamName, managerId: bid.managerId };
}

/**
 * One of Team X's six lotteries: opened by another Team, joined by Team X.
 *
 * `openingSeq` and `joinSeq` are what the cascade orders on, and the joins
 * ascend across the six so "most recent first" has something to be about.
 */
function lotteryOf(index: number): Auction {
	const opening = joinBid(String(100 + index * 10), 't-other', 'Team Other', 'm-other');
	const join = joinBid(String(105 + index * 10), 't-x', 'Team X', 'm-x');
	return {
		fantraxPlayerId: `p-lot-${String(index)}`,
		contention: 'minimum_bid',
		// The fold's own artifact: a join is never strictly higher than the
		// $1,000,000 already leading, so the opener leads.
		leadingBid: opening,
		closesAt: LOTTERY_CLOSES,
		bids: [opening, join],
		contenders: [contenderOf(opening), contenderOf(join)],
		seedHash: SEED_HASH,
		seed: null
	};
}

/** The six: index 0 is drawn and won; 1–5 survive into the cascade. */
const LOTTERIES: readonly Auction[] = [0, 1, 2, 3, 4, 5].map(lotteryOf);

function auctionsOf(entries: readonly Auction[]): OpenAuctions {
	return {
		byPlayer: Object.fromEntries(entries.map((auction) => [auction.fantraxPlayerId, auction]))
	};
}

const WON = LOTTERIES[0] as Auction;

/** Team X, drawn out of the first lottery's two-Team list. */
const DRAWN: DrawnWinner = {
	kind: 'drawn',
	teamId: 't-x',
	teamName: 'Team X',
	managerId: 'm-x',
	seed: SEED,
	contenders: WON.contenders.map((contender) => contender.teamId),
	selectedIndex: 1
};

/**
 * The close of the first lottery, with Team X's roster as it stands BEFORE
 * it: Roster Count 11, no free Minor League Slot, and the other five entries
 * still held.
 */
const CLOSE_STATE: CloseState = {
	auction: WON,
	nomination: {
		fantraxPlayerId: WON.fantraxPlayerId,
		playerName: 'Lottery Player 0',
		teamId: 't-n',
		teamName: 'Team N',
		managerId: 'm-n',
		holdsSlot: true,
		occurredAt: '2026-08-24T08:00:00.000Z'
	},
	// "non-eligible players" throughout — the minors branch never applies.
	playerIsMinorLeagueEligible: false,
	minorLeagueOccupied: MINOR_LEAGUE_SLOTS,
	auctions: auctionsOf(LOTTERIES),
	capSpace: parseMoney(9_000_000),
	// "Roster Count 11 (Free Active/Bench Slots 1)" — before this win.
	rosterCount: 11,
	isMinorLeagueEligible: () => false,
	playerNameFor: (playerId: string) => `Lottery Player ${playerId.replace('p-lot-', '')}`,
	drawnWinner: DRAWN,
	rosterFiguresFor: () => null
};

const DECIDED = decideClose(CLOSE_STATE, LOTTERY_CLOSES, DRAWN);
const CANCELLATIONS = DECIDED.events.filter((event) => event.type === BID_CANCELLED_EVENT);

function appended(seq: number, event: EventEnvelope): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt: LOTTERY_CLOSES,
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

describe('§10 example 34 — the one win that ends them', () => {
	it('appends the draw, then the close, then five cancellations, in that order', () => {
		// The fixed order inside the one transaction (AD-31): cause before
		// consequence, twice over — the draw selected the winner, the close
		// awarded the Player, and the cancellations are what that cost.
		expect(DECIDED.events.map((event) => event.type)).toEqual([
			CONTENTION_DRAWN_EVENT,
			AUCTION_CLOSED_EVENT,
			BID_CANCELLED_EVENT,
			BID_CANCELLED_EVENT,
			BID_CANCELLED_EVENT,
			BID_CANCELLED_EVENT,
			BID_CANCELLED_EVENT
		]);
	});

	it('cancels the five remaining entries MOST RECENT FIRST', () => {
		// "the cascade cancels Team X's five remaining entries
		// most-recent-first". The joins ascend with the lottery index, so
		// descending `seq` is descending index.
		const cancelled = CANCELLATIONS.map((event) => event.payload as BidCancelledPayload);
		expect(cancelled.map((payload) => payload.fantraxPlayerId)).toEqual([
			'p-lot-5',
			'p-lot-4',
			'p-lot-3',
			'p-lot-2',
			'p-lot-1'
		]);
		expect(cancelled.map((payload) => payload.cancelledSeq)).toEqual([
			'155',
			'145',
			'135',
			'125',
			'115'
		]);
		// Each is a lottery ENTRY, and each names the win that caused it.
		for (const payload of cancelled) {
			expect(payload.wasContentionEntry).toBe(true);
			expect(payload.teamId).toBe('t-x');
			expect(payload.causeFantraxPlayerId).toBe('p-lot-0');
			expect(payload.restoration).toBeNull();
		}
	});

	it('releases $5,000,000 — five flat tickets, and no release written', () => {
		const released = CANCELLATIONS.map(
			(event) => (event.payload as BidCancelledPayload).amount
		).reduce((total, amount) => total + amount, 0);
		expect(released).toBe(5_000_000);

		// ...and the release itself is a consequence. Fold the decided events
		// and ask the money narrowing again: nothing says "release", and the
		// entries simply stop being counted.
		const survivors = auctionsOf(LOTTERIES.slice(1));
		const before = teamMoneyStateFor({
			teamId: 't-x',
			fantraxPlayerId: 'p-none',
			capSpace: parseMoney(9_000_000),
			rosterCount: 12,
			minorLeagueOccupied: MINOR_LEAGUE_SLOTS,
			auctions: survivors,
			isMinorLeagueEligible: () => false,
			playerNameFor: (playerId: string) => playerId
		});
		expect(before.leading).toHaveLength(5);

		const folded = fold(
			survivors,
			DECIDED.events.map((event, index) => appended(300 + index, event)),
			auctionsReducer
		);
		const after = teamMoneyStateFor({
			teamId: 't-x',
			fantraxPlayerId: 'p-none',
			capSpace: parseMoney(9_000_000),
			rosterCount: 12,
			minorLeagueOccupied: MINOR_LEAGUE_SLOTS,
			auctions: folded,
			isMinorLeagueEligible: () => false,
			playerNameFor: (playerId: string) => playerId
		});
		expect(after.leading).toEqual([]);
	});

	it('takes Team X out of every remaining Contender list, keeping the history', () => {
		// "The second lottery is therefore drawn from a Contender list that
		// does not include Team X." The draw itself is Story 10.5's; the list
		// it will run over is this story's, and it is `contendersFor`
		// recomputed from Bids that are still all there.
		const folded = fold(
			auctionsOf(LOTTERIES.slice(1)),
			DECIDED.events.map((event, index) => appended(300 + index, event)),
			auctionsReducer
		);
		for (const index of [1, 2, 3, 4, 5]) {
			const auction = auctionForPlayer(folded, `p-lot-${String(index)}`);
			expect(auction?.contenders.map((contender) => contender.teamId), String(index)).toEqual([
				't-other'
			]);
			// The joining Bid is still in the history, marked cancelled.
			expect(auction?.bids, String(index)).toHaveLength(2);
			expect(wasCancelled(auction?.bids[1] as Bid), String(index)).toBe(true);
			// The lottery is still running and its fixed clock is untouched —
			// a Contender leaving does not end a contention.
			expect(auction?.contention, String(index)).toBe('minimum_bid');
			expect(auction?.closesAt, String(index)).toBe(LOTTERY_CLOSES);
		}
	});

	it('cancels nothing when the same win leaves a free Slot behind', () => {
		// The negative that keeps the trigger honest. At Roster Count 10 the
		// win takes Free Active/Bench Slots from 2 to 1 — a reduction, so the
		// cascade fires — and every surviving entry passes FR-18's landing
		// test on that one remaining Slot, so nothing is cancelled.
		const roomy = decideClose({ ...CLOSE_STATE, rosterCount: 10 }, LOTTERY_CLOSES, DRAWN);
		expect(roomy.events.map((event) => event.type)).toEqual([
			CONTENTION_DRAWN_EVENT,
			AUCTION_CLOSED_EVENT
		]);
	});
});

// --- The draw half: what the shorter lists draw (Story 10.5, FR-40) -------

/**
 * A SEVENTH lottery, and the one the second half of example 34 turns on:
 *
 * > one of the five had Team X as its only Contender: it closes with no
 * > winner and that player returns to the pool.
 *
 * Team X opened it and nobody else joined, so the cascade that cancels Team
 * X's surplus entries empties it outright.
 */
const SOLO_JOIN = joinBid('160', 't-x', 'Team X', 'm-x');
const SOLO: Auction = {
	fantraxPlayerId: 'p-lot-solo',
	contention: 'minimum_bid',
	leadingBid: SOLO_JOIN,
	closesAt: LOTTERY_CLOSES,
	bids: [SOLO_JOIN],
	contenders: [contenderOf(SOLO_JOIN)],
	seedHash: SEED_HASH,
	seed: null
};

/**
 * An EIGHTH lottery, and the one that keeps the reproduction honest.
 *
 * Every other lottery here is joined by exactly two Teams, so cancelling Team
 * X always leaves a list of one — and `seed mod 1` is `0` for every seed,
 * which makes "the recorded selection is reproducible" a sentence that cannot
 * fail. This one is joined by THREE, so the post-cancellation list still has
 * two Teams in it and `drawIndex` has a real choice to make over the shorter
 * list (the spec's I/O matrix row: X, P and Q, with X cancelled, leaves
 * `[P, Q]`).
 */
const TRIO_OPENING = joinBid('170', 't-other', 'Team Other', 'm-other');
const TRIO_X = joinBid('175', 't-x', 'Team X', 'm-x');
const TRIO_THIRD = joinBid('180', 't-third', 'Team Third', 'm-third');
const TRIO: Auction = {
	fantraxPlayerId: 'p-lot-trio',
	contention: 'minimum_bid',
	leadingBid: TRIO_OPENING,
	closesAt: LOTTERY_CLOSES,
	bids: [TRIO_OPENING, TRIO_X, TRIO_THIRD],
	contenders: [contenderOf(TRIO_OPENING), contenderOf(TRIO_X), contenderOf(TRIO_THIRD)],
	seedHash: SEED_HASH,
	seed: null
};

/** The same close, with the solo and three-Team lotteries among Team X's commitments. */
const WITH_SOLO: CloseState = {
	...CLOSE_STATE,
	auctions: auctionsOf([...LOTTERIES, SOLO, TRIO])
};

/**
 * Every Auction as it stands AFTER the first close and its cascade — the
 * state AD-11 guarantees the next close in the sweep is evaluated against,
 * because each close commits before the next is loaded.
 */
const AFTER_THE_CASCADE = (() => {
	const decided = decideClose(WITH_SOLO, LOTTERY_CLOSES, DRAWN);
	return fold(
		auctionsOf([...LOTTERIES.slice(1), SOLO, TRIO]),
		decided.events.map((event, index) => appended(400 + index, event)),
		auctionsReducer
	);
})();

/** A close state for one of the surviving lotteries, as the sweep refolds it. */
function nextCloseState(fantraxPlayerId: string): CloseState {
	const auction = auctionForPlayer(AFTER_THE_CASCADE, fantraxPlayerId);
	if (auction === null) throw new Error(`example 34: ${fantraxPlayerId} did not survive the fold`);
	return {
		...CLOSE_STATE,
		auction,
		nomination: {
			fantraxPlayerId,
			playerName: `Lottery Player ${fantraxPlayerId.replace('p-lot-', '')}`,
			teamId: 't-n2',
			teamName: 'Team N2',
			managerId: 'm-n2',
			holdsSlot: true,
			occurredAt: '2026-08-24T08:00:00.000Z'
		},
		auctions: AFTER_THE_CASCADE,
		// This close is about Team Other, not Team X, and Team Other has room
		// to spare — so the cascade has nothing to take back from the winner
		// and the events here are the draw and the close alone. Team X's own
		// cascade already ran, in the close above.
		rosterCount: 0,
		rosterFiguresFor: () => ({
			capSpace: parseMoney(9_000_000),
			rosterCount: 0,
			minorLeagueOccupied: MINOR_LEAGUE_SLOTS
		}),
		drawnWinner: null
	};
}

describe('§10 example 34 — the second lottery draws from the shorter list', () => {
	it('draws Team X’s replacement from a list that no longer holds Team X', () => {
		const state = nextCloseState('p-lot-1');
		const auction = state.auction as Auction;
		const winner = drawnWinnerFor(auction, SEED);
		if (winner.kind !== 'drawn') throw new Error('example 34: the second lottery drew nobody');

		// One Contender left, and it is not Team X.
		expect(winner.contenders).toEqual(['t-other']);
		expect(winner.teamId).toBe('t-other');
		// The recorded seed and the recorded list reproduce the recorded
		// selection by hand — `seed mod 1` is 0 for every seed.
		expect(winner.selectedIndex).toBe(drawIndex(SEED, winner.contenders.length));

		const decided = decideClose(state, LOTTERY_CLOSES, winner);
		expect(decided.events.map((event) => event.type)).toEqual([
			CONTENTION_DRAWN_EVENT,
			AUCTION_CLOSED_EVENT
		]);
		const drawn = decided.events[0]?.payload as DrawnContentionPayload;
		expect(drawn.contenders).toEqual(['t-other']);
		expect(drawn.winningTeamId).toBe('t-other');
		expect(drawn.contenders[drawn.selectedIndex]).toBe(drawn.winningTeamId);
		// Team X is out of the draw and still in the history — one skip, in
		// `contendersFor`, and nothing was deleted to achieve it.
		expect(auction.bids.map((bid) => bid.teamId)).toEqual(['t-other', 't-x']);
		expect(wasCancelled(auction.bids[1] as Bid)).toBe(true);
	});

	it('reproduces the selection by hand over a list that still has TWO Teams in it', () => {
		// The reproduction claim with something to prove. Everywhere else the
		// cascade leaves one Contender, and `seed mod 1` is 0 for every seed —
		// so the assertion holds whatever the arithmetic does. Here the
		// shorter list is still two long, the position is `seed mod 2`, and
		// the recorded winner has to be the Team standing at it.
		const state = nextCloseState('p-lot-trio');
		const auction = state.auction as Auction;
		const winner = drawnWinnerFor(auction, SEED);
		if (winner.kind !== 'drawn') throw new Error('example 34: the three-Team lottery drew nobody');

		// Team X is gone; the other two survive, in ascending join `seq`.
		expect(winner.contenders).toEqual(['t-other', 't-third']);
		expect(winner.contenders).toHaveLength(2);

		// The recorded position is the arithmetic's own answer over the
		// POST-cancellation length, and the recorded winner is the Team at it.
		const byHand = drawIndex(SEED, 2);
		expect(winner.selectedIndex).toBe(byHand);
		expect(winner.contenders[byHand]).toBe(winner.teamId);

		// ...and the same three facts survive into the record a Manager reads.
		const decided = decideClose(state, LOTTERY_CLOSES, winner);
		const drawn = decided.events[0]?.payload as DrawnContentionPayload;
		expect(drawn.contenders).toEqual(['t-other', 't-third']);
		expect(drawn.selectedIndex).toBe(byHand);
		expect(drawn.contenders[drawn.selectedIndex]).toBe(drawn.winningTeamId);

		// The draw ran over the SHORTER list and not the list as it stood
		// before the cascade: over three Teams the position could differ, and
		// Team X could have been selected at all.
		expect(drawn.contenders).not.toContain('t-x');
		expect(auction.bids.map((bid) => bid.teamId)).toEqual(['t-other', 't-x', 't-third']);
		expect(wasCancelled(auction.bids[1] as Bid)).toBe(true);
	});

	it('gives every survivor 1/n over the POST-cancellation list', () => {
		// Two Teams joined each lottery and one was cancelled, so the
		// survivor's probability is 1/1 rather than the 1/2 the pre-cascade
		// list would have implied. Stated across all five.
		for (const index of [1, 2, 3, 4, 5]) {
			const auction = auctionForPlayer(AFTER_THE_CASCADE, `p-lot-${String(index)}`) as Auction;
			expect(auction.contenders, String(index)).toHaveLength(1);
			expect(drawIndex(SEED, auction.contenders.length), String(index)).toBe(0);
		}
	});
});

describe('§10 example 34 — the lottery Team X was the ONLY Contender in', () => {
	const emptied = auctionForPlayer(AFTER_THE_CASCADE, 'p-lot-solo') as Auction;

	it('is emptied by the cascade and keeps its contention and its clock', () => {
		// The seam this story exists for. A cancellation resets nothing and
		// removes nothing — including the lottery's own fixed clock — so the
		// sweep still offers this Auction to a close and the outcome gets
		// recorded instead of stranding a sealed seed forever.
		expect(emptied.contenders).toEqual([]);
		expect(emptied.contention).toBe('minimum_bid');
		expect(emptied.closesAt).toBe(LOTTERY_CLOSES);
		expect(emptied.leadingBid).toBeNull();
		// The entry is still in the history, marked.
		expect(emptied.bids).toHaveLength(1);
		expect(wasCancelled(emptied.bids[0] as Bid)).toBe(true);
	});

	it('closes with NO winner: the empty reveal, then a termination', () => {
		const winner = drawnWinnerFor(emptied, SEED);
		expect(winner).toEqual({ kind: 'undrawn', seed: SEED, contenders: [] });

		const decided = decideClose(nextCloseState('p-lot-solo'), LOTTERY_CLOSES, winner);

		expect(decided.events.map((event) => event.type)).toEqual([
			CONTENTION_DRAWN_EVENT,
			AUCTION_TERMINATED_EVENT
		]);
		// No award, no contract, and no second cascade — nobody won, so no
		// Team's free Slots fell.
		expect(decided.events.map((event) => event.type)).not.toContain(AUCTION_CLOSED_EVENT);
		expect(decided.events.map((event) => event.type)).not.toContain(BID_CANCELLED_EVENT);

		// The seed is revealed anyway: a published commitment that never
		// opens is the one outcome AD-14 cannot survive.
		const drawn = decided.events[0]?.payload as UndrawnContentionPayload;
		expect(drawn.seed).toBe(SEED);
		expect(drawn.seedHash).toBe(SEED_HASH);
		expect(drawn.contenders).toEqual([]);
		expect(drawn.selectedIndex).toBeUndefined();
		expect(drawn.winningTeamId).toBeUndefined();
	});

	it('returns the Player to the pool, and leaves the nominator’s Slot spent', () => {
		// "it closes with no winner and that player returns to the pool."
		// Read through the folds rather than asserted about the payload: the
		// board seat comes back because `nominationsReducer` drops the entry,
		// and the Auction goes because `auctionsReducer` learned this event in
		// Story 10.5.
		//
		// The Nomination Slot does NOT come back, and that is FR-9's amendment
		// showing up in the worst case for the nominator: only a win frees a
		// Slot, and this Auction was terminated with no winner at all. Team N2
		// spent theirs on a Player nobody would bid for and holds it still.
		const winner = drawnWinnerFor(emptied, SEED);
		const decided = decideClose(nextCloseState('p-lot-solo'), LOTTERY_CLOSES, winner);
		const nomination = appended(500, {
			type: NOMINATION_PLACED_EVENT,
			payload: {
				fantraxPlayerId: 'p-lot-solo',
				playerName: 'Lottery Player solo',
				teamId: 't-n2',
				teamName: 'Team N2',
				managerId: 'm-n2'
			},
			managerId: 'm-n2',
			teamId: 't-n2'
		});
		const log = [nomination, ...decided.events.map((event, index) => appended(501 + index, event))];

		const nominations = fold(INITIAL_NOMINATIONS, log, nominationsReducer);
		expect(nominationForPlayer(nominations, 'p-lot-solo')).toBeNull();
		expect(nominationForTeam(nominations, 't-n2')?.fantraxPlayerId).toBe('p-lot-solo');

		// ...and the Auction is gone from `OpenAuctions`, so no later sweep
		// finds it overdue and closes it a second time.
		const auctions = fold(AFTER_THE_CASCADE, log, auctionsReducer);
		expect(auctionForPlayer(auctions, 'p-lot-solo')).toBeNull();

		// The draw record outlives both, which is where a Manager who held
		// the published commitment goes to check it.
		const draws = fold(INITIAL_DRAWS, log, drawsReducer);
		expect(drawForPlayer(draws, 'p-lot-solo')).toEqual({
			kind: 'undrawn',
			fantraxPlayerId: 'p-lot-solo',
			seed: SEED,
			seedHash: SEED_HASH,
			contenders: []
		});
	});
});
