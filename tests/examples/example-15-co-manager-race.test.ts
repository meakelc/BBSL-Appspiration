/**
 * PRD §10 example 15 — **Co-manager race** (AD-25).
 *
 * > Both of Team L's Managers submit a bid on the same auction within the
 * > same second. Exactly one is accepted; the other is refused because the
 * > price moved, and the Audit Log names which Manager placed the accepted
 * > bid.
 *
 * Calls the core directly against a state literal. The RACE itself is a
 * property of the shell, not of the rules — both transactions queue on the
 * single global advisory lock (AD-6), so one commits and the other then
 * loads a log that already contains it. That serialisation is what this test
 * models: the same `now` for both (they landed "within the same second"),
 * the winner's event folded into the state the loser is evaluated against,
 * and no timestamp anywhere deciding the outcome.
 *
 * `tests/server/bidding.test.ts` drives the same sequence through
 * `runTransactionalWrite` against the stateful fake gateway; this file proves
 * the RULE, which is that the second Bid is refused because the price moved.
 */

import { describe, expect, it } from 'vitest';

import {
	BID_PLACED_EVENT,
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer
} from '../../src/lib/core/projection/auctions.ts';
import type { Auction } from '../../src/lib/core/projection/auctions.ts';
import { SALARY_CAP } from '../../src/lib/core/constants.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { bidRefusalDetail, bidStateFor, decide, evaluate } from '../../src/lib/core/rules/bidding.ts';
import type {
	BidPlacedPayload,
	BidState,
	TeamMoneyState
} from '../../src/lib/core/rules/bidding.ts';
import type { AppendedEvent, PlaceBid } from '../../src/lib/core/types.ts';

/**
 * A Team the money gate cannot be the reason for anything here.
 *
 * Story 2.6 added `cap` to `PLACE_BID_GATES`, and every state literal in this
 * file must now say something about money whether or not the example is about
 * money. This one says "not the constraint": the full Salary Cap, nothing
 * committed, and a roster with room — so a refusal in this file is always the
 * gate the example is actually about. §10 examples 3, 4, 5 and 23 are where
 * the money arithmetic is exercised on purpose.
 */
const RICH: TeamMoneyState = {
	capSpace: parseMoney(SALARY_CAP),
	rosterCount: 9,
	leading: [],
	// Story 2.8: no eligible leads and no occupied Minor League
	// Slots, so `N` is the bid alone and `M` is the full three.
	eligibleLeading: [],
	minorLeagueOccupied: 0
};

/** Team A leads at $8,000,000. Team L is about to raise — twice, at once. */
const OPENING_AUCTION: Auction = {
	fantraxPlayerId: 'p-1',
	contention: 'standard',
	leadingBid: {
		seq: '2',
		teamId: 't-a',
		teamName: 'Team A',
		managerId: 'm-a',
		amount: parseMoney(8_000_000),
		occurredAt: '2026-08-26T08:00:00.000Z',
		closesAt: '2026-08-27T08:00:00.000Z',
		// Story 3.2: `hash(seed)`, present only on the Bid that opened a
		// Minimum-Bid Contention. This one opened nothing of the sort.
		seedHash: null
	},
	closesAt: '2026-08-27T08:00:00.000Z',
	bids: [],
	// Standard Contention has no Contenders, no published commitment and
	// nothing revealed: no lottery ever ran here.
	contenders: [],
	seedHash: null,
	seed: null
};

/** The two Managers of Team L, bidding the same amount in the same second. */
function fromManager(managerId: string): PlaceBid {
	return {
		kind: 'PlaceBid',
		fantraxPlayerId: 'p-1',
		teamId: 't-l',
		teamName: 'Team L',
		managerId,
		amount: parseMoney(8_500_000)
	};
}

/** Both requests carry the identical transaction-start clock (AD-3). */
const SAME_SECOND = '2026-08-26T12:00:00.000Z';

/** The winner's event, as the shell would have appended it. */
function appendedFrom(payload: unknown, managerId: string): AppendedEvent {
	return {
		seq: '3',
		occurredAt: SAME_SECOND,
		schemaVersion: 1,
		coreVersion: 1,
		type: BID_PLACED_EVENT,
		payload,
		managerId,
		teamId: 't-l',
		deviceClass: 'mobile',
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

describe('§10 example 15 — Co-manager race', () => {
	it('accepts exactly one of the two, and refuses the other because the price moved', () => {
		const first = decide(bidStateFor(OPENING_AUCTION, RICH, false), fromManager('m-l1'), SAME_SECOND, null);
		expect(first.kind).toBe('accepted');
		if (first.kind !== 'accepted') return;

		// The second Manager's transaction queued on the global lock and now
		// loads a log that already contains the first Bid.
		const auctions = fold(
			{ byPlayer: { 'p-1': OPENING_AUCTION } },
			[appendedFrom(first.events[0]?.payload, 'm-l1')],
			auctionsReducer
		);
		const after: BidState = bidStateFor(auctionForPlayer(auctions, 'p-1'), RICH, false);

		const second = decide(after, fromManager('m-l2'), SAME_SECOND, null);
		expect(second.kind).toBe('rejected');
		if (second.kind !== 'rejected') return;

		// The price moved: $8,500,000 no longer clears the high plus the
		// Minimum Increment.
		expect(second.gates.increment).toEqual({
			passed: false,
			offered: 8_500_000,
			currentHigh: 8_500_000,
			minimumLegal: 9_000_000
		});
		expect(bidRefusalDetail({ kind: 'gates', gates: second.gates })).toContain(
			'the least you may offer is $9.0M'
		);
	});

	it('also refuses it as a self-bid, because a co-managed Team is ONE bidder', () => {
		// The gate matches on the Team, never on the Manager — so the second
		// Manager of the leading Team is refused exactly as the first would be
		// if they tried to raise their own Bid. Both grounds are reported, per
		// AD-1; the price moving is the example's stated one.
		const first = decide(bidStateFor(OPENING_AUCTION, RICH, false), fromManager('m-l1'), SAME_SECOND, null);
		if (first.kind !== 'accepted') throw new Error('the first Bid was refused');
		const auctions = fold(
			{ byPlayer: { 'p-1': OPENING_AUCTION } },
			[appendedFrom(first.events[0]?.payload, 'm-l1')],
			auctionsReducer
		);
		const gates = evaluate(
			bidStateFor(auctionForPlayer(auctions, 'p-1'), RICH, false),
			fromManager('m-l2'),
			SAME_SECOND
		);
		expect(gates.selfBid).toEqual({
			passed: false,
			actingTeamId: 't-l',
			leadingTeamId: 't-l'
		});
	});

	it('names the Manager who placed the accepted Bid, on the event and in the payload', () => {
		const first = decide(bidStateFor(OPENING_AUCTION, RICH, false), fromManager('m-l1'), SAME_SECOND, null);
		if (first.kind !== 'accepted') throw new Error('the first Bid was refused');
		// The envelope the shell stamps `manager_id` from...
		expect(first.events[0]?.managerId).toBe('m-l1');
		// ...and the payload the fold reads, which must agree with it.
		expect((first.events[0]?.payload as BidPlacedPayload).managerId).toBe('m-l1');
		expect((first.events[0]?.payload as BidPlacedPayload).teamId).toBe('t-l');
	});

	it('is decided by the order the lock imposed, not by either timestamp', () => {
		// Both requests carry the identical `now`, so nothing about the outcome
		// can have come from comparing them (AD-5: fold by `seq`, never by
		// `occurredAt`). Reversing which Manager goes first reverses only WHO
		// won — never that exactly one did.
		for (const [winner, loser] of [
			['m-l1', 'm-l2'],
			['m-l2', 'm-l1']
		]) {
			const first = decide(
				bidStateFor(OPENING_AUCTION, RICH, false),
				fromManager(winner ?? ''),
				SAME_SECOND,
				null
			);
			expect(first.kind).toBe('accepted');
			if (first.kind !== 'accepted') return;
			const auctions = fold(
				{ byPlayer: { 'p-1': OPENING_AUCTION } },
				[appendedFrom(first.events[0]?.payload, winner ?? '')],
				auctionsReducer
			);
			const second = decide(
				bidStateFor(auctionForPlayer(auctions, 'p-1'), RICH, false),
				fromManager(loser ?? ''),
				SAME_SECOND,
				null
			);
			expect(second.kind).toBe('rejected');
			expect(first.events[0]?.managerId).toBe(winner);
		}
	});

	it('starts from a real state literal, not an empty fold', () => {
		expect(auctionForPlayer(INITIAL_AUCTIONS, 'p-1')).toBeNull();
		expect(OPENING_AUCTION.leadingBid.amount).toBe(8_000_000);
	});
});
