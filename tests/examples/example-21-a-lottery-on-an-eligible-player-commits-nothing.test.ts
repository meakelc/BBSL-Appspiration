/**
 * PRD §10 example 21 — **A lottery on an eligible player commits nothing**
 * (AD-25).
 *
 * > Team Q is capped out with $0 of Available Cap Space but has all three
 * > Minor League Slots free and no other eligible leading bids. A Minor
 * > League Eligible fringe player is opened at exactly $1,000,000; Team Q
 * > joins the contention. That $1,000,000 is an Eligible Leading Bid, so
 * > `N = 1` against `M = 3`, Overflow Count 0, Minors Exposure $0 — the join
 * > is **permitted despite Team Q having no cap space at all**. Had the same
 * > lottery been on a player who is *not* Minor League Eligible, the flat
 * > $1,000,000 of FR-14 would apply and Team Q could not join.
 *
 * **This example and example 22 are the whole of what Story 3.2 changed in
 * `teamMoneyStateFor`.** Until 3.2 a Team's capital was held only where it
 * held `leadingBid`, which in a lottery is whichever Team opened it — so a
 * Team that JOINED showed no commitment at all. Any Contender may win, so
 * every Contender commits; the amount is the same flat `MINIMUM_BID` the
 * substitution already produced, and the partition by eligibility is
 * untouched. That is what makes a join here commit nothing while a Free Minor
 * League Slot can absorb the win, and what makes example 22's join commit
 * $5,000,000.
 *
 * **The last sentence of the example is its own test.** The non-eligible
 * counterpart is not a footnote: it is the case that proves the eligibility
 * partition is doing the work, rather than lotteries simply being free.
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
	allGatesPassed,
	bidStateFor,
	evaluate,
	failedGates,
	teamMoneyStateFor
} from '../../src/lib/core/rules/bidding.ts';
import type { BidState, TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import type { PlaceBid } from '../../src/lib/core/types.ts';

const NOW = '2026-08-24T14:00:00.000Z';

/**
 * Team Q: literally $0 of Available Cap Space, all three Minor League Slots
 * free, leading nothing anywhere — and a FULL Active/Bench roster.
 *
 * **The roster is full because the example's own two claims force it.** "$0
 * of Available Cap Space" and "the join is permitted" can only both hold when
 * Roster Reserve is $0, since PRD §3 qualifies the unbounded case "provided
 * Roster Reserve remains coverable" and `Available − Reserve ≥ 0` still
 * decides. Roster Reserve is $1,000,000 per UNFILLED Active/Bench Slot, so it
 * is $0 exactly when the twelve are held — which is also §10 example 25's
 * Team, and FR-37's "a Team at Roster Capacity may still bid on a Minor
 * League Eligible Player". The example does not state the roster because the
 * roster is not what it is about; it is stated here because a fixture that
 * left it at nine would be asserting a Team that is not capped out.
 */
const TEAM_Q: TeamMoneyState = {
	// "capped out with $0 of Available Cap Space", and nothing committed, so
	// Cap Space is $0 outright.
	capSpace: parseMoney(0),
	// Twelve Active/Bench Slots held, so Roster Reserve is $0 — see above.
	rosterCount: 12,
	leading: [],
	// "no other eligible leading bids"
	eligibleLeading: [],
	// "all three Minor League Slots free"
	minorLeagueOccupied: 0
};

/** The fringe Player's lottery, opened by another Team at exactly $1,000,000. */
const OPENING: Bid = {
	seq: '1',
	teamId: 't-other',
	teamName: 'Team Other',
	managerId: 'm-other',
	amount: parseMoney(MINIMUM_BID),
	occurredAt: '2026-08-24T09:00:00.000Z',
	closesAt: '2026-08-25T09:00:00.000Z',
	seedHash: 'e'.repeat(64)
};

const LOTTERY: Auction = {
	fantraxPlayerId: 'p-fringe',
	contention: 'minimum_bid',
	leadingBid: OPENING,
	closesAt: OPENING.closesAt,
	bids: [OPENING],
	contenders: [{ seq: '1', teamId: 't-other', teamName: 'Team Other', managerId: 'm-other' }],
	seedHash: OPENING.seedHash,
	// The contention is LIVE: the seed is still sealed, so nothing is revealed.
	seed: null
};

/** Team Q's join, on a Minor League Eligible Player. */
const ELIGIBLE: BidState = bidStateFor(LOTTERY, TEAM_Q, true, 'Auction');

/** ...and the same lottery on a Player who is not. */
const NOT_ELIGIBLE: BidState = bidStateFor(LOTTERY, TEAM_Q, false, 'Auction');

const JOIN: PlaceBid = {
	kind: 'PlaceBid',
	fantraxPlayerId: 'p-fringe',
	teamId: 't-q',
	teamName: 'Team Q',
	managerId: 'm-q',
	amount: parseMoney(MINIMUM_BID)
};

describe('§10 example 21 — a lottery on an eligible player commits nothing', () => {
	it('states the counts the example states: N = 1, M = 3, Overflow 0', () => {
		const gates = evaluate(ELIGIBLE, JOIN, NOW);

		expect(gates.cap.eligibleLeadingBids).toBe(1);
		expect(gates.cap.freeMinorLeagueSlots).toBe(MINOR_LEAGUE_SLOTS);
		expect(gates.cap.overflowCount).toBe(0);
		// The same three counts on the capacity gate, in counts alone.
		expect(gates.slots.eligibleLeadingBids).toBe(1);
		expect(gates.slots.freeMinorLeagueSlots).toBe(MINOR_LEAGUE_SLOTS);
		expect(gates.slots.overflowCount).toBe(0);
	});

	it('holds Minors Exposure at $0 and Available Cap Space at $0', () => {
		const cap = evaluate(ELIGIBLE, JOIN, NOW).cap;

		// "Minors Exposure $0" — one eligible lead against three free Slots
		// overflows nothing, so there is no amount to sum.
		expect(cap.minorsExposure).toBe(0);
		expect(cap.committedBids).toBe(0);
		// "capped out with $0 of Available Cap Space", literally.
		expect(cap.availableCapSpace).toBe(0);
		// And the reserve is coverable because there is nothing left to
		// reserve: the twelve Active/Bench Slots are held.
		expect(cap.rosterReserve).toBe(0);
		expect(cap.maximumBid).toBe(0);
	});

	it('PERMITS the join despite that, because a Free Minor League Slot absorbs the win', () => {
		const gates = evaluate(ELIGIBLE, JOIN, NOW);

		expect(allGatesPassed(gates)).toBe(true);
		expect(failedGates(gates)).toEqual([]);
		// The money gate compared the amount to NOTHING — the reserve is still
		// coverable, which is what `unbounded` does and does not waive.
		expect(gates.cap.unbounded).toBe(true);
		expect(gates.cap.passed).toBe(true);
		// ...and the join is a join.
		expect(gates.contention.entry).toBe('joins');
		expect(gates.contention.contenderCount).toBe(1);
	});

	it('refuses the SAME join on a non-eligible Player — the flat $1,000,000 of FR-14 applies', () => {
		// The example's last sentence, which is what proves the eligibility
		// partition is doing the work rather than lotteries being free.
		const gates = evaluate(NOT_ELIGIBLE, JOIN, NOW);

		// No Free Minor League Slot can absorb a non-eligible win, so the
		// amount is compared to a Maximum Bid again — and Team Q has $0.
		expect(gates.cap.unbounded).toBe(false);
		expect(gates.cap.maximumBid).toBe(0);
		expect(gates.cap.passed).toBe(false);
		// ...and the win would have to land in an Active/Bench Slot Team Q
		// does not have, which is FR-37's second, independent ground. Both are
		// reported, neither suppressed.
		expect(gates.slots.passed).toBe(false);
		expect(failedGates(gates)).toEqual(['cap', 'slots']);
		// And the contention gate is unmoved by any of it: it reads no Cap
		// figure and no roster, so the join is still a join even where the
		// money and the roster refuse it.
		expect(gates.contention.entry).toBe('joins');
	});

	it('carries the join into every OTHER Auction as an Eligible Leading Bid of $1.0M', () => {
		// Story 3.2's one change to `teamMoneyStateFor`, seen from the other
		// side: once Team Q is a Contender, that lottery is a commitment it
		// carries wherever it bids next — even though Team Other still leads
		// it, because any Contender may win.
		const joined: Auction = {
			...LOTTERY,
			contenders: [
				...LOTTERY.contenders,
				{ seq: '2', teamId: 't-q', teamName: 'Team Q', managerId: 'm-q' }
			]
		};
		expect(joined.leadingBid.teamId).toBe('t-other');

		const money = teamMoneyStateFor({
			teamId: 't-q',
			// A different Auction, so the lottery counts as a commitment
			// elsewhere rather than being excluded as the one being bid on.
			fantraxPlayerId: 'p-elsewhere',
			capSpace: parseMoney(0),
			rosterCount: 12,
			minorLeagueOccupied: 0,
			auctions: { ...INITIAL_AUCTIONS, byPlayer: { 'p-fringe': joined } },
			isMinorLeagueEligible: () => true,
			playerNameFor: () => 'The Fringe Player'
		});

		// The flat $1,000,000 of FR-14, routed by ELIGIBILITY into the list
		// Minors Exposure sums over — so it still commits nothing while a Free
		// Minor League Slot can absorb it. That is what makes this example and
		// example 22 one rule rather than two.
		expect(money.eligibleLeading).toEqual([
			{ fantraxPlayerId: 'p-fringe', playerName: 'The Fringe Player', amount: MINIMUM_BID }
		]);
		expect(money.leading).toEqual([]);
	});
});
