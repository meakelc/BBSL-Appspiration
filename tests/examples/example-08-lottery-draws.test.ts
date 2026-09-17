/**
 * PRD §10 example 8 — **Lottery draws** (AD-25).
 *
 * > At 09:00 Tuesday the Randomizer draws from [E, F, G, H]. Seed, ordered
 * > list, and selection are recorded and displayed. Winner holds a $1,000,000
 * > Auction Contract; the other three release their commitments. Team D's
 * > Nomination Slot releases.
 *
 * **The lottery is example 6 and example 7's, run forward.** Team D nominated
 * the Player, Team E opened at exactly $1,000,000 at 09:00 Monday, and F, G
 * and H joined without moving the clock. This file picks that log up at its
 * fixed 09:00 Tuesday close and draws.
 *
 * **Three of those four consequences are facts rather than code**, and the
 * point of this file is to prove that rather than to trust it. The other three
 * Contenders release because `teamMoneyStateFor` tests the contention STATE
 * and the Auction has left `auctions.byPlayer`; Team D's Slot frees because
 * `nominationsReducer` folds the same `AuctionClosed`; and the winner's
 * contract appears because `contractsReducer` folds it too. Story 3.6 wrote a
 * line for none of them.
 *
 * **The one thing it did write is the draw.** The winner is derived from the
 * revealed seed and the ordered Contender list — arithmetic a Manager
 * reproduces in a spreadsheet — and `decideClose` appends `ContentionDrawn`
 * before `AuctionClosed`, carrying the seed, the commitment it answers, the
 * list and the selection.
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
import { INITIAL_CONTRACTS, contractForPlayer, contractsReducer } from '../../src/lib/core/projection/contracts.ts';
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
import { bidStateFor, decide, teamMoneyStateFor } from '../../src/lib/core/rules/bidding.ts';
import type { ContentionSeed, TeamMoneyState } from '../../src/lib/core/rules/bidding.ts';
import { decideClose } from '../../src/lib/core/rules/close.ts';
import type {
	AuctionClosedPayload,
	CloseState,
	DrawnContentionPayload
} from '../../src/lib/core/rules/close.ts';
import { drawIndex, drawnWinnerFor } from '../../src/lib/core/rules/draw.ts';
import type { AppendedEvent, PlaceBid } from '../../src/lib/core/types.ts';

/** The lottery's own instants: opened 09:00 Monday, fixed close 09:00 Tuesday. */
const OPENED_AT = '2026-08-24T09:00:00.000Z';
const FIXED_CLOSE = '2026-08-25T09:00:00.000Z';

/**
 * The seed sealed when the lottery opened. The commitment beside it is
 * `hash(SEED)`, DERIVED rather than written out, so every verification in this
 * file succeeds for the real reason.
 */
const SEED = '4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e';

const FRESH: ContentionSeed = { kind: 'fresh', seed: SEED };
const SEALED: ContentionSeed = { kind: 'sealed', seed: SEED };

/** "draws from [E, F, G, H]" — in the order they joined (AD-14). */
const CONTENDERS: ReadonlyArray<readonly [teamId: string, teamName: string, at: string]> = [
	['t-e', 'Team E', OPENED_AT],
	['t-f', 'Team F', '2026-08-24T14:00:00.000Z'],
	['t-g', 'Team G', '2026-08-24T20:00:00.000Z'],
	['t-h', 'Team H', '2026-08-25T08:55:00.000Z']
];

/** A Team the money gate can never be the reason for anything here. */
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
 * The lottery as it stood at its 09:00 Tuesday close: Team D's nomination,
 * then E's opening and F, G and H's joins.
 *
 * Built by running each decision against the log as it stood at that moment,
 * so every payload — the published commitment, the fixed close instant — is
 * the one a real transaction would have written.
 */
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
			appended(index + 2, at, BID_PLACED_EVENT, decided.events[0]?.payload, {
				managerId: `m-${teamId}`,
				teamId
			})
		);
	}
	return log;
}

/** The draw and the close, decided against that log at the fixed expiry. */
function theDraw() {
	const log = theLottery();
	const auctions = fold(INITIAL_AUCTIONS, log, auctionsReducer);
	const nominations = fold(INITIAL_NOMINATIONS, log, nominationsReducer);
	const auction = auctionForPlayer(auctions, 'p-1');
	if (auction === null) throw new Error('example 8: the lottery did not fold');

	// The shell reads the sealed seed under the lock and hands it here; the
	// core generates nothing and reads no random source.
	const drawnWinner = drawnWinnerFor(auction, SEED);
	// Story 10.5 gave `ClosedWinner` an `undrawn` case for a lottery every
	// Contender was cancelled from. Four Teams are contending here, so this
	// example is stating "and it drew one" as part of its premise.
	if (drawnWinner.kind !== 'drawn') throw new Error('example 8: the lottery drew nobody');
	const state: CloseState = {
		auction,
		nomination: nominationForPlayer(nominations, 'p-1'),
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
	// The Auction's OWN nominal expiry as `now` — never a wall clock (AD-10).
	const decided = decideClose(state, FIXED_CLOSE, drawnWinner);
	return { log, auction, drawnWinner, decided };
}

/** The whole example, run: the lottery, the reveal, the close. */
function theWholeThing(): readonly AppendedEvent[] {
	const { log, decided } = theDraw();
	const actor = { managerId: 'm-t-g', teamId: 't-g' };
	return [
		...log,
		appended(6, FIXED_CLOSE, CONTENTION_DRAWN_EVENT, decided.events[0]?.payload, actor),
		appended(7, FIXED_CLOSE, AUCTION_CLOSED_EVENT, decided.events[1]?.payload, actor)
	];
}

describe('§10 example 8 — the lottery draws', () => {
	it('folds to a Minimum-Bid Contention of E, F, G and H, closing 09:00 Tuesday', () => {
		const auction = auctionForPlayer(fold(INITIAL_AUCTIONS, theLottery(), auctionsReducer), 'p-1');

		expect(auction?.contention).toBe('minimum_bid');
		expect(auction?.contenders.map((contender) => contender.teamId)).toEqual([
			't-e',
			't-f',
			't-g',
			't-h'
		]);
		// "clock unmoved": four joins, and the close is still the opening's.
		expect(auction?.closesAt).toBe(FIXED_CLOSE);
		expect(auction?.seedHash).toBe(hash(SEED));
	});

	it('draws from the ordered list by reducing the seed modulo four', () => {
		const { drawnWinner } = theDraw();

		// The whole derivation, restated: position `seed mod 4` in the join
		// order. A Manager reaches this with a spreadsheet column.
		expect(drawIndex(SEED, 4)).toBe(2);
		expect(drawnWinner.contenders).toEqual(['t-e', 't-f', 't-g', 't-h']);
		expect(drawnWinner.teamId).toBe('t-g');
		expect(drawnWinner.teamName).toBe('Team G');
	});

	it('emits TWO events — the draw, then the close', () => {
		const { decided } = theDraw();

		expect(decided.events).toHaveLength(2);
		// Cause then consequence: a log read in `seq` order states the draw
		// that selected the winner before the close that awarded the Player.
		expect(decided.events[0]?.type).toBe(CONTENTION_DRAWN_EVENT);
		expect(decided.events[1]?.type).toBe(AUCTION_CLOSED_EVENT);
	});

	it('records the seed, the ordered list and the selection', () => {
		// "Seed, ordered list, and selection are recorded and displayed."
		const { decided } = theDraw();
		const drawn = decided.events[0]?.payload as DrawnContentionPayload;

		expect(drawn.seed).toBe(SEED);
		// The commitment restated beside the reveal, so ONE row answers the
		// check rather than two joined by hand.
		expect(drawn.seedHash).toBe(hash(SEED));
		expect(drawn.contenders).toEqual(['t-e', 't-f', 't-g', 't-h']);
		expect(drawn.selectedIndex).toBe(2);
		expect(drawn.winningTeamId).toBe('t-g');
		expect(drawn.contenders[drawn.selectedIndex]).toBe(drawn.winningTeamId);
	});

	it('gives the winner a $1,000,000 Auction Contract', () => {
		// "Winner holds a $1,000,000 Auction Contract" — the FLAT join amount,
		// never the opener's leading Bid, which is the same figure here only by
		// coincidence of the join rule.
		const closed = theDraw().decided.events[1]?.payload as AuctionClosedPayload;

		expect(closed.teamId).toBe('t-g');
		expect(closed.winningAmount).toBe(MINIMUM_BID);
		expect(closed.contention).toBe('minimum_bid');

		const contracts = fold(INITIAL_CONTRACTS, theWholeThing(), contractsReducer);
		const contract = contractForPlayer(contracts, 'p-1');
		expect(contract?.teamId).toBe('t-g');
		expect(contract?.winningAmount).toBe(MINIMUM_BID);
	});

	it('releases the other three immediately — no sweep, no flag, no scheduled job', () => {
		// "the other three release their commitments." The commitments are
		// visible from a SECOND Auction, which is where `teamMoneyStateFor`
		// reads a Team's leads and contentions. Before the close each Contender
		// is committed $1,000,000 there; afterwards the Auction has left
		// `auctions.byPlayer` entirely and holds nobody.
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
					// Story 10.2: every Contender's $1,000,000 is a lottery entry.
					isContentionEntry: true
				}
			]);
			expect(committedOn(theWholeThing(), teamId), teamId).toEqual([]);
		}
	});

	it('frees the board seat but NOT Team D’s Nomination Slot — Team D did not win', () => {
		// The worked example used to read "Team D's Nomination Slot releases",
		// and FR-9's amendment is what changed it. `nominationsReducer` still
		// frees the board seat by folding the `AuctionClosed`, keyed on the
		// Player — Jalen Green leaves the board and is Team G's. The Slot is a
		// separate release keyed on the WINNER, and Team D nominated him and
		// lost the lottery, so Team D keeps a Slot spent on a Player they no
		// longer have any claim on, until they win someone.
		const before = fold(INITIAL_NOMINATIONS, theLottery(), nominationsReducer);
		const after = fold(INITIAL_NOMINATIONS, theWholeThing(), nominationsReducer);

		expect(nominationForTeam(before, 't-d')?.fantraxPlayerId).toBe('p-1');
		expect(nominationForTeam(after, 't-d')?.fantraxPlayerId).toBe('p-1');
		expect(nominationForPlayer(after, 'p-1')).toBeNull();
		// Team G won, and held no Slot to be freed — they nominated nobody in
		// this log. The release is a no-op rather than an error.
		expect(nominationForTeam(after, 't-g')).toBeNull();
	});

	it('keeps the three facts after the Auction itself is gone', () => {
		// The Auction leaves `auctions.byPlayer` on its close, and the draw
		// does not leave with it: AD-14's premise is that a losing Manager can
		// check the draw AFTERWARDS.
		const log = theWholeThing();

		expect(auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1')).toBeNull();

		const draw = drawForPlayer(fold(INITIAL_DRAWS, log, drawsReducer), 'p-1');
		expect(draw?.seed).toBe(SEED);
		expect(draw?.contenders).toEqual(['t-e', 't-f', 't-g', 't-h']);
		expect(draw?.kind === 'drawn' ? draw.winningTeamId : null).toBe('t-g');
	});

	it('selects the same Team however many times the log is folded', () => {
		// AD-5: replay converges. Two independent runs of the whole example,
		// and a double fold of one log, all name Team G.
		expect(theDraw().drawnWinner).toEqual(theDraw().drawnWinner);

		const log = theWholeThing();
		const twice = drawForPlayer(fold(INITIAL_DRAWS, [...log, ...log], drawsReducer), 'p-1');
		expect(twice?.kind === 'drawn' ? twice.winningTeamId : null).toBe('t-g');
	});

	it('is a LATE draw and never a wrong one (AD-10)', () => {
		// The close instant is the Auction's own persisted expiry, so a sweep
		// six hours late appends byte-identical payloads.
		const { auction, drawnWinner } = theDraw();
		const state: CloseState = {
			auction,
			nomination: null,
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

		expect(JSON.stringify(decideClose(state, '2026-08-25T15:00:00.000Z', drawnWinner))).toBe(
			JSON.stringify(decideClose(state, FIXED_CLOSE, drawnWinner))
		);
	});

	it('never puts the seed on the close, and never on any Bid', () => {
		// The reveal is its own event. Putting a seed on `AuctionClosed` would
		// publish half a commit-reveal, and no `BidPlaced` has ever carried
		// anything but `hash(seed)`.
		const { decided, log } = theDraw();
		const closed = decided.events[1]?.payload as AuctionClosedPayload;

		expect(Object.keys(closed)).not.toContain('seed');
		for (const event of log) {
			if (event.type !== BID_PLACED_EVENT) continue;
			expect(JSON.stringify(event.payload)).not.toContain(SEED);
		}
	});
});
