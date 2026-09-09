/**
 * PRD §10 example 33 — **A restoration with nothing to restore**
 * (Story 10.4, FR-40, FR-9).
 *
 * > Same cancellation, but Team U's $2,000,000 on Carter was the **Opening
 * > Bid** and nobody else ever bid. There is no next-highest bid, so the
 * > auction returns to **Awaiting Opening Bid**, and its Auction Clock is
 * > **cleared** rather than left running — an auction with no bid has no
 * > clock, exactly as a nomination nobody has bid on has none. Carter stays on
 * > the Bid Board and the nominating Team's Nomination Slot stays held (§10
 * > example 12). Any team may open him again at $1,000,000 or more, starting a
 * > fresh 24 hours; if nobody does, he returns to the Free Agent pool
 * > unclaimed when the Auction Phase ends. Note what must **not** happen: the
 * > auction does not close at Team U's old expiry with no winner, and the
 * > nomination slot is not released early.
 *
 * **The negative is the assertion this file exists for.** A cleared clock is
 * not cosmetic: it is the ONE thing standing between a leaderless Auction and
 * a sweep that closes it at the old expiry with no winner and no price. So
 * `hasExpired` is asked directly, at an instant long past that expiry, and it
 * must answer `false`.
 *
 * Calls the core directly against state literals — no database, no HTTP, no
 * clock mocking.
 */

import { describe, expect, it } from 'vitest';

import { parseMoney } from '../../src/lib/core/money.ts';
import type { Money } from '../../src/lib/core/money.ts';
import {
	BID_CANCELLED_EVENT,
	auctionForPlayer,
	auctionsReducer,
	hasExpired,
	wasCancelled
} from '../../src/lib/core/projection/auctions.ts';
import type { Auction, Bid, OpenAuctions } from '../../src/lib/core/projection/auctions.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	AUCTION_CLOSED_EVENT,
	INITIAL_NOMINATIONS,
	nominationForPlayer,
	nominationsReducer
} from '../../src/lib/core/projection/nominations.ts';
import type { OpenNomination } from '../../src/lib/core/projection/nominations.ts';
import { decideClose } from '../../src/lib/core/rules/close.ts';
import type { BidCancelledPayload, CloseState } from '../../src/lib/core/rules/close.ts';
import { teamMoneyStateFor } from '../../src/lib/core/rules/bidding.ts';
import type { AppendedEvent, EventEnvelope } from '../../src/lib/core/types.ts';

const CAP_SPACE: Money = parseMoney(40_000_000);

const BROOKS_CLOSES = '2026-08-27T11:00:00.000Z';
const CARTER_CLOSES = '2026-08-28T06:00:00.000Z';
/** Long past Carter's old expiry. Nothing may close there. */
const LONG_AFTER = '2030-01-01T00:00:00.000Z';

function bidBy(seq: string, amount: number, closesAt: string): Bid {
	return {
		seq,
		teamId: 't-u',
		teamName: 'Team U',
		managerId: 'm-u',
		amount: parseMoney(amount),
		occurredAt: '2026-08-26T09:00:00.000Z',
		closesAt,
		seedHash: null
	};
}

const BROOKS_BID = bidBy('140', 3_000_000, BROOKS_CLOSES);
/** "the Opening Bid, and nobody else ever bid." One Bid, and it is cancelled. */
const CARTER_BID = bidBy('190', 2_000_000, CARTER_CLOSES);

function standardAuction(fantraxPlayerId: string, bids: readonly Bid[]): Auction {
	const leadingBid = bids[bids.length - 1];
	if (leadingBid === undefined) throw new Error('example 33: an Auction with no Bids');
	return {
		fantraxPlayerId,
		contention: 'standard',
		leadingBid,
		closesAt: leadingBid.closesAt,
		bids: [...bids],
		contenders: [],
		seedHash: null,
		seed: null
	};
}

const BROOKS = standardAuction('p-brooks', [BROOKS_BID]);
const CARTER = standardAuction('p-carter', [CARTER_BID]);

const PLAYER_NAMES: Readonly<Record<string, string>> = {
	'p-brooks': 'Dex Brooks',
	'p-carter': 'Ellis Carter'
};

/** Team N nominated both. Its Nomination Slot on Carter must stay held. */
function nominationOf(fantraxPlayerId: string): OpenNomination {
	return {
		fantraxPlayerId,
		playerName: PLAYER_NAMES[fantraxPlayerId] ?? fantraxPlayerId,
		teamId: 't-n',
		teamName: 'Team N',
		managerId: 'm-n',
		occurredAt: '2026-08-26T08:00:00.000Z'
	};
}

function auctionsOf(entries: readonly Auction[]): OpenAuctions {
	return {
		byPlayer: Object.fromEntries(entries.map((auction) => [auction.fantraxPlayerId, auction]))
	};
}

const CLOSE_STATE: CloseState = {
	auction: BROOKS,
	nomination: nominationOf('p-brooks'),
	playerIsMinorLeagueEligible: false,
	minorLeagueOccupied: 0,
	auctions: auctionsOf([BROOKS, CARTER]),
	capSpace: CAP_SPACE,
	rosterCount: 11,
	isMinorLeagueEligible: () => false,
	playerNameFor: (playerId: string) => PLAYER_NAMES[playerId] ?? playerId,
	drawnWinner: null,
	// Nobody else ever bid, so there is no candidate Team for the batched read
	// to cover — and no figure here could change the answer.
	rosterFiguresFor: () => null
};

function appended(seq: number, event: EventEnvelope, occurredAt: string): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt,
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

const decided = decideClose(CLOSE_STATE, BROOKS_CLOSES, null);
const cancellations = decided.events.filter((event) => event.type === BID_CANCELLED_EVENT);
const payload = cancellations[0]?.payload as BidCancelledPayload | undefined;
const appendedEvents = decided.events.map((event, index) =>
	appended(200 + index, event, BROOKS_CLOSES)
);
const folded = fold(auctionsOf([CARTER]), appendedEvents, auctionsReducer);
const carter = auctionForPlayer(folded, 'p-carter');

describe('§10 example 33 — a restoration with nothing to restore', () => {
	it('cancels Team U’s Opening Bid and records NO restoration', () => {
		expect(decided.events.map((event) => event.type)).toEqual([
			AUCTION_CLOSED_EVENT,
			BID_CANCELLED_EVENT
		]);
		expect(payload?.cancelledSeq).toBe('190');
		expect(payload?.fantraxPlayerId).toBe('p-carter');
		expect(payload?.causeFantraxPlayerId).toBe('p-brooks');
		// "There is no next-highest bid."
		expect(payload?.restoration).toBeNull();
	});

	it('returns the Auction to Awaiting Opening Bid, with no leader and no clock', () => {
		expect(carter?.leadingBid).toBeNull();
		expect(carter?.contention).toBe('awaiting_opening_bid');
		// "its Auction Clock is cleared rather than left running."
		expect(carter?.closesAt).toBeNull();
	});

	it('does NOT close at Team U’s old expiry with no winner', () => {
		// The negative the example calls out by name. A cleared clock is what
		// stops the sweep ever reaching this Auction: `hasExpired` is the same
		// derivation `auctionsOverdue` and the `expiry` gate both read.
		expect(hasExpired(carter?.closesAt ?? null, LONG_AFTER)).toBe(false);
		// ...and the instant it WOULD have closed at is emphatically in the
		// past, so the answer above is about the cleared clock and nothing else.
		expect(hasExpired(CARTER_CLOSES, LONG_AFTER)).toBe(true);
	});

	it('keeps Carter on the Board with his history intact, struck through', () => {
		// "Carter stays on the Bid Board." The Auction is still in `byPlayer`
		// with its one Bid in it — this is an unbid nomination, not a deletion.
		expect(carter).not.toBeNull();
		expect(carter?.bids.map((bid) => bid.seq)).toEqual(['190']);
		expect(wasCancelled(carter?.bids[0] as Bid)).toBe(true);
		expect(carter?.bids[0]?.cancellation?.causePlayerName).toBe('Dex Brooks');
		expect(carter?.bids[0]?.cancellation?.restoration).toBeNull();
	});

	it('holds the nominator’s Nomination Slot — the close released Brooks, not Carter', () => {
		// "the nominating Team's Nomination Slot stays held", and "the
		// nomination slot is not released early". `nominationsReducer` folds
		// the same events: `AuctionClosed` drops the Player it names, and
		// `BidCancelled` drops nobody.
		const nominations = fold(
			fold(
				INITIAL_NOMINATIONS,
				[
					appended(
						100,
						{
							type: 'NominationPlaced',
							payload: {
								fantraxPlayerId: 'p-carter',
								playerName: 'Ellis Carter',
								teamId: 't-n',
								teamName: 'Team N',
								managerId: 'm-n'
							},
							managerId: 'm-n',
							teamId: 't-n'
						},
						'2026-08-26T08:00:00.000Z'
					)
				],
				nominationsReducer
			),
			appendedEvents,
			nominationsReducer
		);

		const held = nominationForPlayer(nominations, 'p-carter');
		expect(held?.teamId).toBe('t-n');
		expect(held?.playerName).toBe('Ellis Carter');
	});

	it('releases Team U’s $2,000,000 with no release written', () => {
		const after = teamMoneyStateFor({
			teamId: 't-u',
			fantraxPlayerId: 'p-nothing',
			capSpace: CAP_SPACE,
			rosterCount: 12,
			minorLeagueOccupied: 0,
			auctions: folded,
			isMinorLeagueEligible: () => false,
			playerNameFor: (playerId: string) => PLAYER_NAMES[playerId] ?? playerId
		});

		expect(after.leading).toEqual([]);
		expect(after.eligibleLeading).toEqual([]);
	});
});
