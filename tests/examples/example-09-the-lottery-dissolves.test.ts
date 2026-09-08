/**
 * PRD §10 example 9 — **Lottery dissolves** (AD-25).
 *
 * > Same auction, but Team I bids $1,500,000 at 20:30 Monday. Contenders E,
 * > F, G release immediately; I becomes Leading Bidder; state = Standard
 * > Contention; close resets to 20:30 Tuesday. The next valid bid is
 * > $2,000,000.
 *
 * **Three of those four consequences are facts rather than code**, and the
 * point of this file is to prove that rather than to trust it. The
 * commitments release because `teamMoneyStateFor` tests the contention STATE
 * and the Auction folds to `standard`; the clock resets because a dissolution
 * is not a join, so `decide()` computes a fresh `closeInstantFor`; and Team I
 * leads because `$1,500,000` is strictly higher than the `$1,000,000` that
 * was. Story 3.3 wrote a line for none of them.
 *
 * **The fourth is the one thing it did write.** A contention that dissolved
 * with its seed still sealed is the outcome AD-14 cannot survive — the draw
 * that would have opened the envelope will never run — so `decide()` emits a
 * second event carrying the revealed seed, after verifying it against the
 * commitment the log already published.
 *
 * Calls the core directly against state literals — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { AUCTION_CLOCK, MINIMUM_BID, SALARY_CAP } from '../../src/lib/core/constants.ts';
import { hash } from '../../src/lib/core/hash.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	BID_PLACED_EVENT,
	CONTENTION_DISSOLVED_EVENT,
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer,
	wasDissolved
} from '../../src/lib/core/projection/auctions.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	INITIAL_LEAGUE_CLOCK,
	leagueClockReducer
} from '../../src/lib/core/projection/league-clock.ts';
import {
	allGatesPassed,
	bidGateReport,
	bidStateFor,
	decide,
	evaluate,
	minimumLegalBid,
	teamMoneyStateFor
} from '../../src/lib/core/rules/bidding.ts';
import type {
	BidPlacedPayload,
	ContentionDissolvedPayload,
	ContentionSeed,
	TeamMoneyState
} from '../../src/lib/core/rules/bidding.ts';
import type { AppendedEvent, PlaceBid } from '../../src/lib/core/types.ts';

/** 20:30 Monday — the instant Team I converts at. */
const CONVERTED_AT = '2026-08-24T20:30:00.000Z';

/** 20:30 Tuesday — `AUCTION_CLOCK` after it, the close the dissolution sets. */
const RESET_CLOSE = '2026-08-25T20:30:00.000Z';

/** The lottery's own instants: opened 09:00 Monday, fixed close 09:00 Tuesday. */
const OPENED_AT = '2026-08-24T09:00:00.000Z';
const FIXED_CLOSE = '2026-08-25T09:00:00.000Z';

/**
 * The seed sealed when the lottery opened, and the commitment published for
 * it — `hash(SEED)`, derived rather than written out beside it, so the
 * verification in `decide()` succeeds for the real reason.
 */
const SEED = '4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e';

/** ...as the shell hands it to `decide()` on a dissolution. */
const SEALED: ContentionSeed = { kind: 'sealed', seed: SEED };

/** ...and as it hands a FRESH one everywhere a contention is not running. */
const FRESH: ContentionSeed = { kind: 'fresh', seed: SEED };

/** Contenders E, F and G, in the order they joined. */
const CONTENDERS: ReadonlyArray<readonly [teamId: string, teamName: string, at: string]> = [
	['t-e', 'Team E', OPENED_AT],
	['t-f', 'Team F', '2026-08-24T14:00:00.000Z'],
	['t-g', 'Team G', '2026-08-24T20:00:00.000Z']
];

/** A Team the money gate can never be the reason for anything here. */
const RICH: TeamMoneyState = {
	capSpace: parseMoney(SALARY_CAP),
	rosterCount: 9,
	leading: [],
	eligibleLeading: [],
	minorLeagueOccupied: 0
};

/** One `BidPlaced` or `ContentionDissolved`, as the shell would append it. */
function appended(
	seq: number,
	occurredAt: string,
	type: string,
	payload: unknown,
	actor: { managerId: string; teamId: string }
): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt,
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload,
		managerId: actor.managerId,
		teamId: actor.teamId,
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

function bidCommand(teamId: string, teamName: string, amount: number): PlaceBid {
	return {
		kind: 'PlaceBid',
		fantraxPlayerId: 'p-1',
		teamId,
		teamName,
		managerId: `m-${teamId}`,
		amount: parseMoney(amount)
	};
}

/**
 * The lottery as it stood at 20:30 Monday: opened by E, joined by F and G.
 *
 * Built by running each decision against the log as it stood at that moment,
 * so every payload — the published commitment, the fixed close instant — is
 * the one a real transaction would have written.
 */
function theLottery(): readonly AppendedEvent[] {
	const log: AppendedEvent[] = [];
	for (const [index, [teamId, teamName, at]] of CONTENDERS.entries()) {
		const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1');
		const decided = decide(
			bidStateFor(auction, RICH, false, 'Auction'),
			bidCommand(teamId, teamName, MINIMUM_BID),
			at,
			// The opening commits to a fresh seed; each join is handed the
			// sealed one and publishes nothing from it.
			index === 0 ? FRESH : SEALED
		);
		if (decided.kind !== 'accepted') throw new Error(`${teamName} was refused`);
		log.push(
			appended(index + 1, at, BID_PLACED_EVENT, decided.events[0]?.payload, {
				managerId: `m-${teamId}`,
				teamId
			})
		);
	}
	return log;
}

/** Team I's $1,500,000, decided against that log. */
function theConversion(log: readonly AppendedEvent[]) {
	const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1');
	const state = bidStateFor(auction, RICH, false, 'Auction');
	const command = bidCommand('t-i', 'Team I', 1_500_000);
	const decided = decide(state, command, CONVERTED_AT, SEALED);
	if (decided.kind !== 'accepted') throw new Error('the conversion was refused');
	return { state, command, decided };
}

/** The whole example, run: the lottery, then the Bid that dissolves it. */
function theWholeThing(): readonly AppendedEvent[] {
	const log = [...theLottery()];
	const { decided } = theConversion(log);
	const actor = { managerId: 'm-t-i', teamId: 't-i' };
	log.push(appended(4, CONVERTED_AT, BID_PLACED_EVENT, decided.events[0]?.payload, actor));
	log.push(
		appended(5, CONVERTED_AT, CONTENTION_DISSOLVED_EVENT, decided.events[1]?.payload, actor)
	);
	return log;
}

describe('§10 example 9 — the lottery dissolves', () => {
	it('accepts Team I’s $1,500,000, with `contention` reporting a PASS', () => {
		const log = theLottery();
		const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1');
		const state = bidStateFor(auction, RICH, false, 'Auction');
		const gates = evaluate(state, bidCommand('t-i', 'Team I', 1_500_000), CONVERTED_AT);

		expect(allGatesPassed(gates)).toBe(true);
		expect(gates.contention.entry).toBe('converts');
		expect(gates.contention.passed).toBe(true);
		// Three Contenders — E, F and G — and the count is the one BEFORE
		// this Bid, which is exactly who is released.
		expect(gates.contention.contenderCount).toBe(3);
		// No raise applies inside the contention the Bid is dissolving, and
		// it still says so with both figures null rather than reporting the
		// $1,000,000 as an amount to beat.
		expect(gates.increment.currentHigh).toBeNull();
		expect(gates.increment.minimumLegal).toBeNull();
		// A lottery has no Leading Bidder, so there is nobody to bid against.
		expect(gates.selfBid.passed).toBe(true);
		expect(gates.selfBid.leadingTeamId).toBeNull();
	});

	it('emits TWO events — the converting Bid, then the dissolution', () => {
		const { decided } = theConversion(theLottery());

		expect(decided.events).toHaveLength(2);
		expect(decided.events[0]?.type).toBe(BID_PLACED_EVENT);
		expect(decided.events[1]?.type).toBe(CONTENTION_DISSOLVED_EVENT);

		const dissolved = decided.events[1]?.payload as ContentionDissolvedPayload;
		expect(dissolved.seed).toBe(SEED);
		expect(dissolved.seedHash).toBe(hash(SEED));
		// E, F and G, in the order they joined (AD-14).
		expect(dissolved.formerContenders).toEqual(['t-e', 't-f', 't-g']);
		expect(dissolved.convertingTeamId).toBe('t-i');
		expect(dissolved.amount).toBe(1_500_000);

		// The raw seed is in the dissolution and in NO `BidPlaced` payload.
		const bid = decided.events[0]?.payload as BidPlacedPayload;
		expect(JSON.stringify(bid)).not.toContain(SEED);
		expect(Object.keys(bid)).not.toContain('seedHash');
	});

	it('folds to Standard Contention with Team I leading at $1,500,000', () => {
		const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, theWholeThing(), auctionsReducer), 'p-1');

		expect(auction?.contention).toBe('standard');
		expect(auction?.leadingBid.teamId).toBe('t-i');
		expect(auction?.leadingBid.amount).toBe(1_500_000);
		// The reveal is on the Auction, and the commitment it answers is
		// still the one the opening published.
		expect(auction?.seed).toBe(SEED);
		expect(auction?.seedHash).toBe(hash(SEED));
		expect(auction === null ? false : wasDissolved(auction)).toBe(true);
	});

	it('resets the close to 20:30 Tuesday — 24 hours from the converting Bid', () => {
		const { decided } = theConversion(theLottery());
		const payload = decided.events[0]?.payload as BidPlacedPayload;

		expect(payload.closesAt).toBe(RESET_CLOSE);
		expect(Date.parse(payload.closesAt) - Date.parse(CONVERTED_AT)).toBe(AUCTION_CLOCK);
		// Emphatically not the contention's fixed close, which every join
		// stamped and which was only twelve and a half hours away.
		expect(payload.closesAt).not.toBe(FIXED_CLOSE);

		const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, theWholeThing(), auctionsReducer), 'p-1');
		expect(auction?.closesAt).toBe(RESET_CLOSE);
	});

	it('releases E, F and G immediately — no sweep, no flag, no scheduled job', () => {
		// The commitments are visible from a SECOND Auction, which is where
		// `teamMoneyStateFor` reads a Team's leads and contentions. Before
		// the conversion each Contender is committed $1,000,000 there;
		// afterwards the Auction is `standard` and holds nobody but Team I.
		const committedOn = (log: readonly AppendedEvent[], teamId: string) =>
			teamMoneyStateFor({
				teamId,
				fantraxPlayerId: 'p-other',
				capSpace: parseMoney(SALARY_CAP),
				rosterCount: 9,
				minorLeagueOccupied: 0,
				auctions: fold(INITIAL_AUCTIONS, log, auctionsReducer),
				isMinorLeagueEligible: () => false,
				playerNameFor: () => 'Jalen Green'
			}).leading;

		for (const [teamId] of CONTENDERS) {
			expect(committedOn(theLottery(), teamId), teamId).toEqual([
				{
					fantraxPlayerId: 'p-1',
					playerName: 'Jalen Green',
					amount: MINIMUM_BID,
					// An entry WHILE the contention stands. After it dissolves the
					// same Team holds nothing here at all, which is the next line.
					isContentionEntry: true
				}
			]);
			expect(committedOn(theWholeThing(), teamId), teamId).toEqual([]);
		}

		// ...and Team I is committed its $1,500,000, because it leads.
		expect(committedOn(theWholeThing(), 't-i')).toEqual([
			{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', amount: 1_500_000, isContentionEntry: false }
		]);
	});

	it('replaces a converting CONTENDER’s own $1,000,000 rather than adding to it', () => {
		// FR-19's "a Team that was a Contender may itself be the converting
		// bidder", followed through to the money. Contender F converts its
		// own lottery: the $1,000,000 ticket it held is not a second
		// commitment beside the $1,500,000 lead — there is one Auction, so
		// there is one amount. `teamMoneyStateFor` gets this right through
		// the line that has always skipped the Auction being bid on, and the
		// exact-array assertion is what proves "replaced" rather than
		// "added".
		const log = [...theLottery()];
		const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1');
		const decided = decide(
			bidStateFor(auction, RICH, false, 'Auction'),
			bidCommand('t-f', 'Team F', 1_500_000),
			CONVERTED_AT,
			SEALED
		);
		if (decided.kind !== 'accepted') throw new Error('Contender F was refused');

		const actor = { managerId: 'm-t-f', teamId: 't-f' };
		log.push(appended(4, CONVERTED_AT, BID_PLACED_EVENT, decided.events[0]?.payload, actor));
		log.push(
			appended(5, CONVERTED_AT, CONTENTION_DISSOLVED_EVENT, decided.events[1]?.payload, actor)
		);

		const folded = fold(INITIAL_AUCTIONS, log, auctionsReducer);
		expect(auctionForPlayer(folded, 'p-1')?.leadingBid.teamId).toBe('t-f');

		// Read from a SECOND Auction, which is where a Team's commitments are
		// visible at all. Exactly one entry, at the converting amount.
		expect(
			teamMoneyStateFor({
				teamId: 't-f',
				fantraxPlayerId: 'p-other',
				capSpace: parseMoney(SALARY_CAP),
				rosterCount: 9,
				minorLeagueOccupied: 0,
				auctions: folded,
				isMinorLeagueEligible: () => false,
				playerNameFor: () => 'Jalen Green'
			}).leading
		).toEqual([{ fantraxPlayerId: 'p-1', playerName: 'Jalen Green', amount: 1_500_000, isContentionEntry: false }]);

		// **The payload carries the WHOLE list, converter included, and does
		// not pretend that Team was released.** F is on its own dissolution's
		// `formerContenders` — it contended, which is the fact the field
		// records — and `convertingTeamId` beside it is how Epic 5's
		// dispatcher tells F apart from E and G, who genuinely were released.
		// Filtering F out would make this the list nobody can check the
		// commitment against, and would leave Story 3.6 short an entry.
		const dissolvedPayload = decided.events[1]?.payload as ContentionDissolvedPayload;
		expect(dissolvedPayload.formerContenders).toEqual(['t-e', 't-f', 't-g']);
		expect(dissolvedPayload.convertingTeamId).toBe('t-f');
		expect(dissolvedPayload.formerContenders).toContain(dissolvedPayload.convertingTeamId);
	});

	it('states no release on the panel when a CONTENDER is the one converting', () => {
		// The `contention` row sits beside a `Passed` chip, and its count —
		// the one BEFORE this Bid — includes Contender F itself. A figure
		// claiming "releasing 3 Contenders" would be false about one of the
		// three, on the one surface in the product that may never be. So the
		// row states the arithmetic it was judged from instead: the amount
		// offered, and the threshold it cleared.
		const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, theLottery(), auctionsReducer), 'p-1');
		const gates = evaluate(
			bidStateFor(auction, RICH, false, 'Auction'),
			bidCommand('t-f', 'Team F', 1_500_000),
			CONVERTED_AT
		);
		const row = bidGateReport(gates).find((line) => line.gate === 'contention');

		expect(row?.chip).toBe('Minimum-Bid Contention · Passed');
		expect(row?.figure).toBe(
			'$1.5M is at or above the $1.5M that dissolves this Minimum-Bid Contention'
		);
		expect(row?.figure).not.toMatch(/releas/i);
		// The count is not on this row at all, because it is not this row's
		// to explain — and stating it beside a release claim is what made it
		// wrong.
		expect(row?.figure).not.toContain('3');
	});

	it('makes the next valid bid $2,000,000, and refuses anything under it', () => {
		const log = theWholeThing();
		const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1');
		const state = bidStateFor(auction, RICH, false, 'Auction');

		// The pre-fill IS the rule: one Minimum Increment over the new high.
		expect(minimumLegalBid(state, 't-j')).toBe(2_000_000);
		expect(allGatesPassed(evaluate(state, bidCommand('t-j', 'Team J', 2_000_000), CONVERTED_AT))).toBe(
			true
		);

		// A $1,000,000 into the now-standard Auction is an ordinary low bid
		// and is never read as a join: `contention` reports that no lottery
		// is running at all.
		const late = evaluate(state, bidCommand('t-j', 'Team J', MINIMUM_BID), CONVERTED_AT);
		expect(late.contention.entry).toBe('not_a_contention');
		expect(late.contention.passed).toBe(true);
		expect(late.increment.passed).toBe(false);
		expect(late.increment.currentHigh).toBe(1_500_000);
		expect(late.increment.minimumLegal).toBe(2_000_000);
	});

	it('keeps the former Contenders in the fold, which is what the reveal is about', () => {
		// "The Contender list is discarded" is about commitment and the draw.
		// The list itself is history, and the page names the Teams that were
		// released beside the seed that will now never be drawn from.
		const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, theWholeThing(), auctionsReducer), 'p-1');
		expect(auction?.contenders.map((contender) => contender.teamName)).toEqual([
			'Team E',
			'Team F',
			'Team G'
		]);
		expect(auction?.bids).toHaveLength(4);
	});

	it('is byte-identical for one Contender and for twenty, but for the count', () => {
		// FR-19: "Conversion occurs regardless of Contender count — one
		// Contender or twenty, the result is identical."
		const runWith = (howMany: number) => {
			const log: AppendedEvent[] = [];
			for (let index = 0; index < howMany; index += 1) {
				const teamId = `t-${String(index)}`;
				const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1');
				const decided = decide(
					bidStateFor(auction, RICH, false, 'Auction'),
					bidCommand(teamId, `Team ${String(index)}`, MINIMUM_BID),
					OPENED_AT,
					index === 0 ? FRESH : SEALED
				);
				if (decided.kind !== 'accepted') throw new Error(`join ${String(index)} refused`);
				log.push(
					appended(index + 1, OPENED_AT, BID_PLACED_EVENT, decided.events[0]?.payload, {
						managerId: `m-${teamId}`,
						teamId
					})
				);
			}
			const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1');
			const state = bidStateFor(auction, RICH, false, 'Auction');
			const decided = decide(state, bidCommand('t-i', 'Team I', 1_500_000), CONVERTED_AT, SEALED);
			if (decided.kind !== 'accepted') throw new Error('the conversion was refused');
			return decided;
		};

		const one = runWith(1);
		const twenty = runWith(20);

		// The converting `BidPlaced` is identical, character for character.
		expect(one.events[0]?.payload).toEqual(twenty.events[0]?.payload);
		// The dissolution differs only in the list it carries.
		const onePayload = one.events[1]?.payload as ContentionDissolvedPayload;
		const twentyPayload = twenty.events[1]?.payload as ContentionDissolvedPayload;
		expect(onePayload.formerContenders).toHaveLength(1);
		expect(twentyPayload.formerContenders).toHaveLength(20);
		expect({ ...onePayload, formerContenders: [] }).toEqual({
			...twentyPayload,
			formerContenders: []
		});
	});

	it('resets the League Clock on the converting Bid and NOT on the dissolution', () => {
		// AD-22 fixes the reset set at `NominationPlaced` and `BidPlaced`, and
		// `league-clock.ts`'s `default: return state` is what keeps a new
		// event type out of it. The two events share an instant in production;
		// this test gives the dissolution a later one so the difference is
		// visible.
		const log = [...theLottery()];
		const { decided } = theConversion(log);
		const actor = { managerId: 'm-t-i', teamId: 't-i' };
		log.push(appended(4, CONVERTED_AT, BID_PLACED_EVENT, decided.events[0]?.payload, actor));
		log.push(
			appended(5, '2026-08-24T23:59:00.000Z', CONTENTION_DISSOLVED_EVENT, decided.events[1]?.payload, actor)
		);

		const clock = fold(INITIAL_LEAGUE_CLOCK, log, leagueClockReducer);
		// The conversion is the latest surviving reset; the `ContentionDissolved`
		// beside it reaches `default` and resets nothing (Story 3.7).
		expect(clock.voidedSeqs).toEqual([]);
		expect(clock.resets[clock.resets.length - 1]?.occurredAt).toBe(CONVERTED_AT);
	});
});
