/**
 * PRD §10 example 6 — **Lottery opens** (AD-25).
 *
 * > Player nominated by Team D, opened by Team E at exactly $1,000,000 at
 * > 09:00 Monday. State = Minimum-Bid Contention, close fixed at 09:00
 * > Tuesday. E commits $1,000,000.
 *
 * **This is the one rule the codebase could fold but not create.** Until
 * Story 3.2 the `opening` gate refused exactly `$1,000,000` by name, because
 * no Contender list, no seed and no fixed clock existed to run a lottery. All
 * three exist now, and this example is the proof that the amount opens one
 * rather than being promoted, rounded or quietly accepted as an ordinary
 * Standard Contention.
 *
 * **Four facts, and the fourth is the one AD-14 lives on.** The Bid is
 * accepted; the fold reads `minimum_bid`; the close is exactly 24 hours after
 * the Opening Bid; and the payload publishes `hash(seed)` while the seed
 * itself appears nowhere in the event at any depth. The seed reaches the
 * database through `server/bidding.ts`'s one projection, into a table that
 * grants no role anything — which is `tests/server/bidding.test.ts`'s and
 * `tests/integration/auction-events.test.ts`' half of the same story.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { AUCTION_CLOCK, MINIMUM_BID, SALARY_CAP } from '../../src/lib/core/constants.ts';
import { hash } from '../../src/lib/core/hash.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer,
	contentionOf,
	contentionSentence
} from '../../src/lib/core/projection/auctions.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	allGatesPassed,
	bidStateFor,
	decide,
	evaluate,
	failedGates,
	minimumLegalBid,
	teamMoneyStateFor
} from '../../src/lib/core/rules/bidding.ts';
import type {
	BidPlacedPayload,
	BidState,
	ContentionSeed,
	TeamMoneyState
} from '../../src/lib/core/rules/bidding.ts';
import type { AppendedEvent, PlaceBid } from '../../src/lib/core/types.ts';

/** 09:00 Monday — the instant Team E opens at. */
const OPENED_AT = '2026-08-24T09:00:00.000Z';

/** 09:00 Tuesday — `AUCTION_CLOCK` after it, and the close the lottery keeps. */
const CLOSES_AT = '2026-08-25T09:00:00.000Z';

/** The seed the shell generates. Its VALUE is never published; its hash is. */
const SEED = '9f2b7c14ad05e8613f9c2ad70b45e18c9f2b7c14ad05e8613f9c2ad70b45e18c';

/** ...as `decide()` receives it: the FRESH half of the commit-reveal (3.3). */
const FRESH: ContentionSeed = { kind: 'fresh', seed: SEED };

/** Team E: nothing about the money is marginal, so nothing but the rule decides. */
const TEAM_E: TeamMoneyState = {
	capSpace: parseMoney(SALARY_CAP),
	rosterCount: 9,
	leading: [],
	eligibleLeading: [],
	minorLeagueOccupied: 0
};

/** The Player is nominated by Team D and nobody has bid — no clock yet. */
const AWAITING: BidState = bidStateFor(null, TEAM_E, false);

const OPENING: PlaceBid = {
	kind: 'PlaceBid',
	fantraxPlayerId: 'p-1',
	teamId: 't-e',
	teamName: 'Team E',
	managerId: 'm-e',
	amount: parseMoney(MINIMUM_BID)
};

describe('§10 example 6 — the lottery opens', () => {
	it('accepts an Opening Bid of exactly $1,000,000 — every gate passes', () => {
		const gates = evaluate(AWAITING, OPENING, OPENED_AT);

		expect(allGatesPassed(gates)).toBe(true);
		expect(failedGates(gates)).toEqual([]);
		// The opening gate PASSES and still names the case, so the panel says
		// which of the four this was.
		expect(gates.opening.passed).toBe(true);
		expect(gates.opening.opening).toBe('at_the_minimum');
		// The contention gate has nothing to decide: the lottery does not
		// exist until this Bid lands.
		expect(gates.contention.entry).toBe('not_a_contention');
		expect(gates.contention.contenderCount).toBe(0);
	});

	it('is what the control pre-fills, so a Manager is handed the rule and not advice', () => {
		expect(minimumLegalBid(AWAITING, 't-e')).toBe(MINIMUM_BID);
	});

	it('fixes the close at 09:00 Tuesday — 24 hours from the Opening Bid', () => {
		const decided = decide(AWAITING, OPENING, OPENED_AT, FRESH);
		if (decided.kind !== 'accepted') throw new Error('the Opening Bid was refused');
		const payload = decided.events[0]?.payload as BidPlacedPayload;

		expect(payload.closesAt).toBe(CLOSES_AT);
		expect(Date.parse(payload.closesAt) - Date.parse(OPENED_AT)).toBe(AUCTION_CLOCK);
	});

	it('publishes hash(seed) on the payload, and the seed itself nowhere in the event', () => {
		const decided = decide(AWAITING, OPENING, OPENED_AT, FRESH);
		if (decided.kind !== 'accepted') throw new Error('the Opening Bid was refused');
		const payload = decided.events[0]?.payload as BidPlacedPayload;

		expect(payload.seedHash).toBe(hash(SEED));
		// **The assertion AD-14 lives or dies on.** The commit-reveal "fails
		// completely if the seed is readable before the draw", and this event
		// is what reaches the league-readable log.
		expect(JSON.stringify(decided.events)).not.toContain(SEED);
	});

	it('throws rather than refusing when the shell supplies no seed (AD-1)', () => {
		// A missing seed is a bug in the shell, not something a Manager did —
		// and a lottery whose commitment was never published is exactly the
		// state AD-14 cannot survive, so it must not be reachable by refusing
		// quietly and carrying on.
		expect(() => decide(AWAITING, OPENING, OPENED_AT, null)).toThrow(TypeError);
	});

	it('folds to a Minimum-Bid Contention with the opener as Contender #1', () => {
		const decided = decide(AWAITING, OPENING, OPENED_AT, FRESH);
		if (decided.kind !== 'accepted') throw new Error('the Opening Bid was refused');
		const payload = decided.events[0]?.payload as BidPlacedPayload;

		// The event as the shell would have appended it, folded by the same
		// reducer the read path and the lock use.
		const appended: AppendedEvent = {
			seq: '1',
			occurredAt: OPENED_AT,
			schemaVersion: 1,
			coreVersion: 1,
			type: decided.events[0]?.type ?? '',
			payload,
			managerId: 'm-e',
			teamId: 't-e',
			deviceClass: null,
			dispatchOutcome: null,
			deliveryOutcome: null
		};
		const auction = auctionForPlayer(
			fold(INITIAL_AUCTIONS, [appended], auctionsReducer),
			'p-1'
		);

		expect(contentionOf(auction)).toBe('minimum_bid');
		expect(contentionSentence(contentionOf(auction))).toBe('Minimum-Bid Contention.');
		expect(auction?.closesAt).toBe(CLOSES_AT);
		expect(auction?.contenders).toEqual([
			{ seq: '1', teamId: 't-e', teamName: 'Team E', managerId: 'm-e' }
		]);
		expect(auction?.seedHash).toBe(hash(SEED));
	});

	it('commits Team E’s $1,000,000, because the opener is a Contender', () => {
		// "E commits $1,000,000". The commitment is visible from a SECOND
		// Auction, which is where `teamMoneyStateFor` reads a Team's leads and
		// contentions — the money held on the Auction being bid on is
		// excluded, because the prospective Bid replaces it.
		const decided = decide(AWAITING, OPENING, OPENED_AT, FRESH);
		if (decided.kind !== 'accepted') throw new Error('the Opening Bid was refused');
		const payload = decided.events[0]?.payload as BidPlacedPayload;
		const appended: AppendedEvent = {
			seq: '1',
			occurredAt: OPENED_AT,
			schemaVersion: 1,
			coreVersion: 1,
			type: decided.events[0]?.type ?? '',
			payload,
			managerId: 'm-e',
			teamId: 't-e',
			deviceClass: null,
			dispatchOutcome: null,
			deliveryOutcome: null
		};
		const auctions = fold(INITIAL_AUCTIONS, [appended], auctionsReducer);

		const money = teamMoneyStateFor({
			teamId: 't-e',
			// A different Player, so the lottery counts as a lead elsewhere.
			fantraxPlayerId: 'p-2',
			capSpace: parseMoney(SALARY_CAP),
			rosterCount: 9,
			minorLeagueOccupied: 0,
			auctions,
			isMinorLeagueEligible: () => false,
			playerNameFor: () => 'The Lottery Player'
		});

		expect(money.leading).toEqual([
			{ fantraxPlayerId: 'p-1', playerName: 'The Lottery Player', amount: MINIMUM_BID }
		]);
	});
});
