/**
 * PRD §10 example 7 — **Lottery grows, clock unmoved** (AD-25).
 *
 * > Teams F, G, H each bid exactly $1,000,000 at 14:00, 20:00, and 08:55
 * > Tuesday. All join; each commits $1,000,000; close time remains 09:00
 * > Tuesday.
 *
 * **The fixed clock is enforced twice, and only one of them is a rule.**
 * `auctionsReducer` keeps `closesAt` on a join because a join is never
 * strictly higher than the leading Bid, so it never becomes `leadingBid` —
 * true, and an accident of an unrelated invariant. So `decide()` stamps the
 * contention's EXISTING close instant onto each join's own payload, which
 * makes the persisted log honest on its own terms: every `BidPlaced` in a
 * contention states the same close, and Story 3.5's sweep — which reads
 * persisted instants and nothing else (AD-12) — cannot be handed a join
 * claiming to close 24 hours after itself.
 *
 * Both are asserted below, separately and by name. A test that only folded
 * the log would pass on the accident alone.
 *
 * **Team H's join at 08:55 Tuesday is five minutes before the close**, which
 * is the case that makes the difference visible: a fresh 24-hour clock there
 * would extend the lottery by nearly a day.
 *
 * Calls the core directly against a state literal — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_BID, SALARY_CAP } from '../../src/lib/core/constants.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer
} from '../../src/lib/core/projection/auctions.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import { INITIAL_LEAGUE_CLOCK, leagueClockReducer } from '../../src/lib/core/projection/league-clock.ts';
import {
	allGatesPassed,
	bidStateFor,
	decide,
	evaluate
} from '../../src/lib/core/rules/bidding.ts';
import type {
	BidPlacedPayload,
	ContentionSeed,
	TeamMoneyState
} from '../../src/lib/core/rules/bidding.ts';
import type { AppendedEvent, PlaceBid } from '../../src/lib/core/types.ts';

/** 09:00 Monday, and the close it fixes: 09:00 Tuesday. */
const OPENED_AT = '2026-08-24T09:00:00.000Z';
const CLOSES_AT = '2026-08-25T09:00:00.000Z';

/** The three joins, at the three instants the example names. */
const JOINS: ReadonlyArray<readonly [teamId: string, teamName: string, at: string]> = [
	['t-f', 'Team F', '2026-08-24T14:00:00.000Z'],
	['t-g', 'Team G', '2026-08-24T20:00:00.000Z'],
	// Five minutes before the close. A fresh clock here would extend the
	// lottery by nearly a whole day, which is exactly what must not happen.
	['t-h', 'Team H', '2026-08-25T08:55:00.000Z']
];

/**
 * The two seeds, as `decide()` receives them since Story 3.3: the FRESH
 * half of the commit-reveal, which only an opening at exactly $1,000,000
 * commits to. A join publishes nothing from either, which is half of what
 * this file proves.
 */
const OPENING_SEED: ContentionSeed = { kind: 'fresh', seed: '1'.repeat(64) };
const JOIN_SEED: ContentionSeed = { kind: 'fresh', seed: '2'.repeat(64) };

const RICH: TeamMoneyState = {
	capSpace: parseMoney(SALARY_CAP),
	rosterCount: 9,
	leading: [],
	eligibleLeading: [],
	minorLeagueOccupied: 0
};

/** One `BidPlaced` as the shell would have appended it. */
function appended(seq: number, occurredAt: string, payload: BidPlacedPayload): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt,
		schemaVersion: 1,
		coreVersion: 1,
		type: 'BidPlaced',
		payload,
		managerId: payload.managerId,
		teamId: payload.teamId,
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

function joinCommand(teamId: string, teamName: string): PlaceBid {
	return {
		kind: 'PlaceBid',
		fantraxPlayerId: 'p-1',
		teamId,
		teamName,
		managerId: `m-${teamId}`,
		amount: parseMoney(MINIMUM_BID)
	};
}

/**
 * The whole example, run: Team E opens, then F, G and H each join, each
 * decision taken against the log as it stood at that moment.
 *
 * The log is REBUILT between joins rather than assumed, so each `decide()`
 * sees exactly what the locked transaction would have seen — which is the
 * only way the Contender count and the close instant on each payload mean
 * anything.
 */
function runTheLottery(): {
	readonly log: readonly AppendedEvent[];
	readonly payloads: readonly BidPlacedPayload[];
} {
	const log: AppendedEvent[] = [];
	const payloads: BidPlacedPayload[] = [];

	const opening = decide(
		bidStateFor(null, RICH, false, 'Auction'),
		joinCommand('t-e', 'Team E'),
		OPENED_AT,
		OPENING_SEED
	);
	if (opening.kind !== 'accepted') throw new Error('the Opening Bid was refused');
	const openingPayload = opening.events[0]?.payload as BidPlacedPayload;
	payloads.push(openingPayload);
	log.push(appended(1, OPENED_AT, openingPayload));

	for (const [index, [teamId, teamName, at]] of JOINS.entries()) {
		const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1');
		const decided = decide(
			bidStateFor(auction, RICH, false, 'Auction'),
			joinCommand(teamId, teamName),
			at,
			// A seed is supplied on every call, exactly as the shell does. A
			// join publishes nothing from it, which is half of what this file
			// proves.
			JOIN_SEED
		);
		if (decided.kind !== 'accepted') throw new Error(`${teamName}'s join was refused`);
		const payload = decided.events[0]?.payload as BidPlacedPayload;
		payloads.push(payload);
		log.push(appended(index + 2, at, payload));
	}

	return { log, payloads };
}

describe('§10 example 7 — the lottery grows and the clock does not move', () => {
	it('accepts all three joins, each as a join rather than a raise', () => {
		const log: AppendedEvent[] = [];
		const opening = decide(
			bidStateFor(null, RICH, false, 'Auction'),
			joinCommand('t-e', 'Team E'),
			OPENED_AT,
			OPENING_SEED
		);
		if (opening.kind !== 'accepted') throw new Error('the Opening Bid was refused');
		log.push(appended(1, OPENED_AT, opening.events[0]?.payload as BidPlacedPayload));

		for (const [index, [teamId, teamName, at]] of JOINS.entries()) {
			const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1');
			const state = bidStateFor(auction, RICH, false, 'Auction');
			const gates = evaluate(state, joinCommand(teamId, teamName), at);

			expect(allGatesPassed(gates), teamName).toBe(true);
			expect(gates.contention.entry, teamName).toBe('joins');
			// The count BEFORE this Bid: the opener, plus whoever joined first.
			expect(gates.contention.contenderCount, teamName).toBe(index + 1);
			// No raise applies, and it says so with both figures null.
			expect(gates.increment.currentHigh, teamName).toBeNull();
			expect(gates.increment.minimumLegal, teamName).toBeNull();

			const decided = decide(state, joinCommand(teamId, teamName), at, JOIN_SEED);
			if (decided.kind !== 'accepted') throw new Error(`${teamName}'s join was refused`);
			log.push(appended(index + 2, at, decided.events[0]?.payload as BidPlacedPayload));
		}
	});

	it('states the SAME close instant on every persisted payload — the rule, not the accident', () => {
		// The first of the two enforcements. `decide()` stamps the
		// contention's existing `closesAt` onto each join, so a sweep reading
		// persisted instants alone (AD-12) sees one close per contention.
		const { payloads } = runTheLottery();

		expect(payloads).toHaveLength(4);
		for (const payload of payloads) {
			expect(payload.closesAt).toBe(CLOSES_AT);
		}
		// And no join claims 24 hours from itself. Team H's would have been
		// 08:55 WEDNESDAY, nearly a day past the real close.
		expect(payloads[3]?.closesAt).not.toBe('2026-08-26T08:55:00.000Z');
	});

	it('leaves the fold’s close at 09:00 Tuesday after all three — the second guarantee', () => {
		const { log } = runTheLottery();
		const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1');

		expect(auction?.closesAt).toBe(CLOSES_AT);
		// The lead never moved either: a join is never strictly higher.
		expect(auction?.leadingBid?.teamId).toBe('t-e');
		expect(auction?.contention).toBe('minimum_bid');
	});

	it('lists Contenders E, F, G, H in ascending join seq (AD-14)', () => {
		const { log } = runTheLottery();
		const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1');

		expect(auction?.contenders.map((contender) => contender.teamName)).toEqual([
			'Team E',
			'Team F',
			'Team G',
			'Team H'
		]);
		expect(auction?.contenders.map((contender) => contender.seq)).toEqual(['1', '2', '3', '4']);
	});

	it('publishes no second commitment — only the opening Bid carries a seedHash', () => {
		const { payloads, log } = runTheLottery();

		expect(payloads[0]?.seedHash).toMatch(/^[0-9a-f]{64}$/);
		for (const payload of payloads.slice(1)) {
			expect(Object.keys(payload)).not.toContain('seedHash');
		}
		// The fold keeps the FIRST, so a Manager who recorded the commitment
		// when the lottery opened is still checking the same one.
		const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1');
		expect(auction?.seedHash).toBe(payloads[0]?.seedHash);
	});

	it('DOES reset the League Clock on every join — that is a fact to test, not code to write', () => {
		// `league-clock.ts` already folds every accepted `BidPlaced`, so a join
		// resets the League Clock without Story 3.2 writing a line for it.
		// Story 3.7 owns League Clock work; this is what that story inherits.
		const { log } = runTheLottery();
		const clock = fold(INITIAL_LEAGUE_CLOCK, log, leagueClockReducer);

		// The LAST Bid in the log is Team H's, five minutes before the close —
		// and it is the reset that stands, because `fold()` orders by `seq`
		// and the latest SURVIVING reset in that order wins. Nothing here is
		// voided, so the latest survivor is simply the last entry (Story 3.7).
		expect(clock.voidedSeqs).toEqual([]);
		expect(clock.resets[clock.resets.length - 1]?.occurredAt).toBe('2026-08-25T08:55:00.000Z');
	});
});
