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
 * **The second half is the win that ends them.** The draw that removes Team X
 * from the remaining Contender lists is Story 10.5's, and the lottery that
 * closes with no winner is 10.5's too; what is asserted here is the
 * cancellation itself — five entries, most recent first, $5,000,000 released,
 * and every one of them out of its Contender list before anything is drawn.
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
import { CONTENTION_DRAWN_EVENT } from '../../src/lib/core/projection/draws.ts';
import { AUCTION_CLOSED_EVENT } from '../../src/lib/core/projection/nominations.ts';
import { decideClose } from '../../src/lib/core/rules/close.ts';
import type {
	BidCancelledPayload,
	CloseState,
	ClosedWinner
} from '../../src/lib/core/rules/close.ts';
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
const DRAWN: ClosedWinner = {
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
