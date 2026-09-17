/**
 * PRD §10 example 11 — **Single-contender lottery** (AD-25).
 *
 * > Only Team E ever bids $1,000,000. At expiry, E wins outright; the draw is
 * > recorded with a one-team list.
 *
 * **"Wins outright" is not a second rule, and that is the point of this
 * file.** `seed mod 1 = 0` for every seed there is, so the derivation selects
 * the only Contender with no branch, no special case and no second
 * `ClosedWinner` kind. Story 3.4 shaped `ClosedWinner` as a union of one
 * anticipating that this example might want its own; it does not, and a case
 * here would state something the arithmetic already states. (Story 10.5 did
 * add the second kind, for the opposite list: a lottery with NOBODY left in
 * it, which no arithmetic can state.)
 *
 * **"The draw is recorded with a one-team list" is the half that IS written.**
 * The reveal carries a `contenders` array of length one rather than omitting
 * the field, so a lottery nobody else joined is checked exactly the way a
 * four-Team lottery is: hash the seed, reduce it modulo the count, read off
 * the position.
 *
 * Calls the core directly against state literals — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_BID, SALARY_CAP } from '../../src/lib/core/constants.ts';
import { hash } from '../../src/lib/core/hash.ts';
import { parseMoney } from '../../src/lib/core/money.ts';
import {
	BID_PLACED_EVENT,
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer
} from '../../src/lib/core/projection/auctions.ts';
import {
	CONTENTION_DRAWN_EVENT,
	INITIAL_DRAWS,
	drawForPlayer,
	drawsReducer
} from '../../src/lib/core/projection/draws.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	AUCTION_CLOSED_EVENT,
	INITIAL_NOMINATIONS,
	NOMINATION_PLACED_EVENT,
	nominationForPlayer,
	nominationForTeam,
	nominationsReducer
} from '../../src/lib/core/projection/nominations.ts';
import { bidStateFor, decide } from '../../src/lib/core/rules/bidding.ts';
import type { ContentionSeed, TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import { decideClose } from '../../src/lib/core/rules/close.ts';
import type {
	AuctionClosedPayload,
	CloseState,
	ContentionDrawnPayload
} from '../../src/lib/core/rules/close.ts';
import { drawIndex, drawnWinnerFor } from '../../src/lib/core/rules/draw.ts';
import type { AppendedEvent, PlaceBid } from '../../src/lib/core/types.ts';

const OPENED_AT = '2026-08-24T09:00:00.000Z';
const FIXED_CLOSE = '2026-08-25T09:00:00.000Z';

/** The seed sealed when Team E opened the lottery. */
const SEED = '7b4e2a90c15d386f7b4e2a90c15d386f7b4e2a90c15d386f7b4e2a90c15d386f';

const FRESH: ContentionSeed = { kind: 'fresh', seed: SEED };

const RICH: TeamMoneyState = {
	capSpace: parseMoney(SALARY_CAP),
	rosterCount: 9,
	leading: [],
	eligibleLeading: [],
	minorLeagueOccupied: 0
};

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

const OPENING: PlaceBid = {
	kind: 'PlaceBid',
	fantraxPlayerId: 'p-1',
	teamId: 't-e',
	teamName: 'Team E',
	managerId: 'm-t-e',
	amount: parseMoney(MINIMUM_BID)
};

/** Team D's nomination, and Team E's $1,000,000. Nobody else ever bids. */
function theLottery(): readonly AppendedEvent[] {
	const log: AppendedEvent[] = [
		appended(
			1,
			'2026-08-24T08:30:00.000Z',
			NOMINATION_PLACED_EVENT,
			{
				fantraxPlayerId: 'p-1',
				playerName: 'Jalen Green',
				teamId: 't-d',
				teamName: 'Team D',
				managerId: 'm-t-d'
			},
			{ managerId: 'm-t-d', teamId: 't-d' }
		)
	];

	const decided = decide(bidStateFor(null, RICH, false, 'Auction'), OPENING, OPENED_AT, FRESH);
	if (decided.kind !== 'accepted') throw new Error('example 11: Team E was refused');
	log.push(
		appended(2, OPENED_AT, BID_PLACED_EVENT, decided.events[0]?.payload, {
			managerId: 'm-t-e',
			teamId: 't-e'
		})
	);
	return log;
}

function theDraw() {
	const log = theLottery();
	const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1');
	if (auction === null) throw new Error('example 11: the lottery did not fold');

	const drawnWinner = drawnWinnerFor(auction, SEED);
	// One Contender is still a Contender. Story 10.5's `undrawn` case is for a
	// list with NOBODY in it, which is a different example entirely.
	if (drawnWinner.kind !== 'drawn') throw new Error('example 11: the lottery drew nobody');
	const state: CloseState = {
		auction,
		nomination: nominationForPlayer(fold(INITIAL_NOMINATIONS, log, nominationsReducer), 'p-1'),
		winnerHoldsNominationSlot: false,
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
		drawnWinner,
		rosterFiguresFor: () => null
	};
	return { log, auction, drawnWinner, decided: decideClose(state, FIXED_CLOSE, drawnWinner) };
}

function theWholeThing(): readonly AppendedEvent[] {
	const { log, decided } = theDraw();
	const actor = { managerId: 'm-t-e', teamId: 't-e' };
	return [
		...log,
		appended(3, FIXED_CLOSE, CONTENTION_DRAWN_EVENT, decided.events[0]?.payload, actor),
		appended(4, FIXED_CLOSE, AUCTION_CLOSED_EVENT, decided.events[1]?.payload, actor)
	];
}

describe('§10 example 11 — the single-contender lottery', () => {
	it('folds to a Minimum-Bid Contention whose Contender list holds one Team', () => {
		const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, theLottery(), auctionsReducer), 'p-1');

		expect(auction?.contention).toBe('minimum_bid');
		expect(auction?.contenders.map((contender) => contender.teamId)).toEqual(['t-e']);
		expect(auction?.closesAt).toBe(FIXED_CLOSE);
	});

	it('wins outright with no special case — `seed mod 1` is 0 for every seed', () => {
		const { drawnWinner } = theDraw();

		expect(drawIndex(SEED, 1)).toBe(0);
		expect(drawnWinner.kind).toBe('drawn');
		expect(drawnWinner.teamId).toBe('t-e');
		expect(drawnWinner.managerId).toBe('m-t-e');
	});

	it('records the draw with a ONE-team list, rather than omitting it', () => {
		const drawn = theDraw().decided.events[0]?.payload as ContentionDrawnPayload;

		expect(drawn.contenders).toEqual(['t-e']);
		expect(drawn.contenders).toHaveLength(1);
		expect(drawn.selectedIndex).toBe(0);
		expect(drawn.winningTeamId).toBe('t-e');
		expect(drawn.seed).toBe(SEED);
		expect(drawn.seedHash).toBe(hash(SEED));
	});

	it('emits the same two events in the same order a four-Team lottery does', () => {
		const { decided } = theDraw();

		expect(decided.events).toHaveLength(2);
		expect(decided.events[0]?.type).toBe(CONTENTION_DRAWN_EVENT);
		expect(decided.events[1]?.type).toBe(AUCTION_CLOSED_EVENT);
	});

	it('awards the Player at exactly $1,000,000', () => {
		const closed = theDraw().decided.events[1]?.payload as AuctionClosedPayload;

		expect(closed.teamId).toBe('t-e');
		expect(closed.managerId).toBe('m-t-e');
		expect(closed.winningAmount).toBe(MINIMUM_BID);
		expect(closed.contention).toBe('minimum_bid');
	});

	it('frees the board seat on the close, and Team D’s Slot not at all', () => {
		// Team E was the only Contender and won. Team D nominated the Player
		// and did not, so since FR-9 was amended their Slot stays spent: the
		// close frees the seat, and only a win frees a Slot.
		const after = fold(INITIAL_NOMINATIONS, theWholeThing(), nominationsReducer);

		expect(nominationForPlayer(after, 'p-1')).toBeNull();
		expect(nominationForTeam(after, 't-d')?.fantraxPlayerId).toBe('p-1');
	});

	it('leaves the one-team draw readable after the Auction has gone', () => {
		const log = theWholeThing();

		expect(auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1')).toBeNull();

		const draw = drawForPlayer(fold(INITIAL_DRAWS, log, drawsReducer), 'p-1');
		expect(draw?.contenders).toEqual(['t-e']);
		expect(draw?.kind === 'drawn' ? draw.winningTeamId : null).toBe('t-e');
		expect(draw?.seed).toBe(SEED);
	});
});
