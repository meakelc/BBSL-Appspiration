/**
 * PRD §10 example 1 — **Ordinary raise** (AD-25).
 *
 * > Player at $8,000,000 held by Team A. Team B bids $8,500,000 — valid
 * > (exactly +$500k). Clock resets to 24h. A's $8,000,000 commitment
 * > releases; B's $8,500,000 commits.
 *
 * The examples are the executable specification: this calls the core
 * DIRECTLY against a state literal — no database, no HTTP, no clock mocking,
 * no fixtures beyond the literal below.
 *
 * **The commitment half is deliberately not asserted here.** Committed Bids,
 * Available Cap Space and the release of Team A's capital are Story 2.6's
 * arithmetic; nothing in `core/rules/bidding.ts` can see money beyond the
 * amount offered, which is exactly why it cannot silently get them wrong.
 * When 2.6 lands, the release assertion belongs in this same file.
 */

import { describe, expect, it } from 'vitest';

import { AUCTION_CLOCK, SALARY_CAP } from '../../src/lib/core/constants.ts';
import {
	BID_PLACED_EVENT,
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer
} from '../../src/lib/core/projection/auctions.ts';
import type { Auction } from '../../src/lib/core/projection/auctions.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	INITIAL_LEAGUE_CLOCK,
	leagueClockExpiry,
	leagueClockReducer
} from '../../src/lib/core/projection/league-clock.ts';
import { AUCTION_OPENED_EVENT } from '../../src/lib/core/projection/phase.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import { allGatesPassed, bidStateFor, decide, evaluate } from '../../src/lib/core/rules/bidding.ts';
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

/** Team A's $8,000,000, already leading — as the fold produced it. */
const AUCTION: Auction = {
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

/** ...narrowed to what the gates decide from, through the core's own bridge. */
const STATE: BidState = bidStateFor(AUCTION, RICH, false, 'Auction');

/** Team B's raise, at exactly one Minimum Increment above the high. */
const RAISE: PlaceBid = {
	kind: 'PlaceBid',
	fantraxPlayerId: 'p-1',
	teamId: 't-b',
	teamName: 'Team B',
	managerId: 'm-b',
	amount: parseMoney(8_500_000)
};

const NOW = '2026-08-26T12:00:00.000Z';

describe('§10 example 1 — Ordinary raise', () => {
	it('accepts $8,500,000 over $8,000,000: exactly +$500k is valid', () => {
		const gates = evaluate(STATE, RAISE, NOW);
		expect(allGatesPassed(gates)).toBe(true);
		expect(gates.increment).toEqual({
			passed: true,
			offered: 8_500_000,
			currentHigh: 8_000_000,
			minimumLegal: 8_500_000
		});
		expect(gates.granularity.passed).toBe(true);
		expect(gates.selfBid.passed).toBe(true);
		expect(gates.opening.opening).toBe('not_an_opening');
	});

	it('appends exactly one BidPlaced naming Team B and its acting Manager', () => {
		const decided = decide(STATE, RAISE, NOW, null);
		expect(decided.kind).toBe('accepted');
		if (decided.kind !== 'accepted') return;
		expect(decided.events).toHaveLength(1);
		expect(decided.events[0]?.type).toBe(BID_PLACED_EVENT);
		expect(decided.events[0]?.teamId).toBe('t-b');
		expect(decided.events[0]?.managerId).toBe('m-b');
	});

	it('sets the Auction Clock to exactly 24 hours from that Bid’s own instant', () => {
		const decided = decide(STATE, RAISE, NOW, null);
		if (decided.kind !== 'accepted') throw new Error('the raise was refused');
		const payload = decided.events[0]?.payload as BidPlacedPayload;
		expect(payload.closesAt).toBe('2026-08-27T12:00:00.000Z');
		expect(Date.parse(payload.closesAt) - Date.parse(NOW)).toBe(AUCTION_CLOCK);
	});

	it('makes Team B the Leading Bidder at $8,500,000 once the event is folded', () => {
		const decided = decide(STATE, RAISE, NOW, null);
		if (decided.kind !== 'accepted') throw new Error('the raise was refused');
		const appended: AppendedEvent = {
			seq: '3',
			occurredAt: NOW,
			schemaVersion: 1,
			coreVersion: 1,
			type: BID_PLACED_EVENT,
			payload: decided.events[0]?.payload,
			managerId: 'm-b',
			teamId: 't-b',
			deviceClass: 'mobile',
			dispatchOutcome: null,
			deliveryOutcome: null
		};
		const auctions = fold({ byPlayer: { 'p-1': AUCTION } }, [appended], auctionsReducer);
		const folded = auctionForPlayer(auctions, 'p-1');
		expect(folded?.leadingBid?.teamId).toBe('t-b');
		expect(folded?.leadingBid?.amount).toBe(8_500_000);
		expect(folded?.closesAt).toBe('2026-08-27T12:00:00.000Z');
		expect(folded?.contention).toBe('standard');
	});

	it('resets the League Clock to 48 hours from the Bid (AD-22)', () => {
		const clock = fold(
			INITIAL_LEAGUE_CLOCK,
			[
				{
					seq: '1',
					occurredAt: '2026-08-25T19:00:00.000Z',
					schemaVersion: 1,
					coreVersion: 1,
					type: AUCTION_OPENED_EVENT,
					payload: {},
					managerId: 'm-c',
					teamId: 't-c',
					deviceClass: null,
					dispatchOutcome: null,
					deliveryOutcome: null
				},
				{
					seq: '3',
					occurredAt: NOW,
					schemaVersion: 1,
					coreVersion: 1,
					type: BID_PLACED_EVENT,
					payload: { fantraxPlayerId: 'p-1', teamId: 't-b', managerId: 'm-b', amount: 8_500_000 },
					managerId: 'm-b',
					teamId: 't-b',
					deviceClass: null,
					dispatchOutcome: null,
					deliveryOutcome: null
				}
			],
			leagueClockReducer
		);
		// The Bid is the ONE reset the fold recorded, and it carries the `seq`
		// a compensating `BidVoided` would name it by (Story 3.7).
		expect(clock.resets).toEqual([{ seq: '3', occurredAt: NOW }]);
		expect(clock.voidedSeqs).toEqual([]);
		expect(leagueClockExpiry(clock)).toBe('2026-08-28T12:00:00.000Z');
	});

	it('is not INITIAL_AUCTIONS — the fixture is a real state literal, not an empty one', () => {
		// Guards against the example quietly passing against an empty fold,
		// which would prove nothing about a raise over a standing high.
		expect(auctionForPlayer(INITIAL_AUCTIONS, 'p-1')).toBeNull();
		expect(STATE.leadingBid).toEqual({ teamId: 't-a', amount: 8_000_000 });
	});
});
