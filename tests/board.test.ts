/**
 * The Bid Board's pure core, driven directly (Story 4.3).
 *
 * Every row of the spec's I/O matrix that is decidable without a database is
 * decided here, through `src/lib/core/board.ts` and nothing else: the three
 * Auction states, the four viewer-relative states, each sort's tie-break, the
 * filtered notice, the empty board and the unbid phrase. The route's own
 * suite proves the guard and the load shape; this one proves the words and
 * the orderings.
 *
 * Nothing here mocks anything. The module takes two folds, a `Map` and an
 * instant, and returns data — which is the whole reason the wording and the
 * comparators live in the core rather than in a `.svelte` file no test in
 * this repository can render.
 */

import { describe, expect, it } from 'vitest';

import {
	ARCHIVED_EMPTY_BOARD_HEADING,
	ARCHIVED_EMPTY_BOARD_STATEMENT,
	AUCTION_STATE_ICONS,
	AUCTION_STATE_LABELS,
	DEFAULT_FILTER,
	DEFAULT_SORT,
	EMPTY_BOARD_ACTION,
	EMPTY_BOARD_HEADING,
	EMPTY_BOARD_STATEMENT,
	FILTER_KEYS,
	FILTER_LABELS,
	NO_LEADING_BIDDER,
	NO_OPENING_BID,
	SORT_KEYS,
	SORT_LABELS,
	VIEWER_STATE_ICONS,
	VIEWER_STATE_LABELS,
	boardCardsFor,
	boardCountSentence,
	filterBoard,
	filteredNoticeSentence,
	metadataLine,
	priceLabel,
	sortBoard,
	unbidPhrase,
	viewerStateFor
} from '../src/lib/core/board.ts';
import type { BoardCard, BoardMetadata } from '../src/lib/core/board.ts';
import { MINIMUM_BID } from '../src/lib/core/constants.ts';
import { parseMoney } from '../src/lib/core/money.ts';
import {
	BID_PLACED_EVENT,
	INITIAL_AUCTIONS,
	MINIMUM_LOTTERY_LABEL,
	auctionForPlayer,
	auctionsReducer
} from '../src/lib/core/projection/auctions.ts';
import type { Auction } from '../src/lib/core/projection/auctions.ts';
import { fold } from '../src/lib/core/projection/fold.ts';
import {
	INITIAL_NOMINATIONS,
	NOMINATION_PLACED_EVENT,
	nominationsReducer
} from '../src/lib/core/projection/nominations.ts';
import type { AppendedEvent } from '../src/lib/core/types.ts';

const NOW = '2026-08-27T12:00:00.000Z';

let nextSeq = 0;

function event(
	type: string,
	payload: Record<string, unknown>,
	occurredAt: string
): AppendedEvent {
	nextSeq += 1;
	return {
		seq: String(nextSeq),
		type,
		payload,
		occurredAt,
		managerId: String(payload['managerId'] ?? 'm-x'),
		teamId: String(payload['teamId'] ?? 't-x'),
		schemaVersion: 1,
		coreVersion: 'test',
		deviceClass: null
	} as unknown as AppendedEvent;
}

function nominated(
	fantraxPlayerId: string,
	playerName: string,
	teamId: string,
	teamName: string,
	occurredAt: string,
	managerId: string | null = 'm-nom'
): AppendedEvent {
	return event(
		NOMINATION_PLACED_EVENT,
		{ fantraxPlayerId, playerName, teamId, teamName, managerId },
		occurredAt
	);
}

function bid(
	fantraxPlayerId: string,
	teamId: string,
	teamName: string,
	amount: number,
	occurredAt: string,
	closesAt: string,
	managerId = 'm-bid'
): AppendedEvent {
	return event(
		BID_PLACED_EVENT,
		{ fantraxPlayerId, teamId, teamName, managerId, amount, closesAt },
		occurredAt
	);
}

/** Fold a log into the two projections the board is built from. */
function project(events: readonly AppendedEvent[]) {
	return {
		nominations: fold(INITIAL_NOMINATIONS, events, nominationsReducer),
		auctions: fold(INITIAL_AUCTIONS, events, auctionsReducer)
	};
}

function metadataFor(entries: Record<string, BoardMetadata>): Map<string, BoardMetadata> {
	return new Map(Object.entries(entries));
}

function cardFor(cards: readonly BoardCard[], fantraxPlayerId: string): BoardCard {
	const card = cards.find((entry) => entry.fantraxPlayerId === fantraxPlayerId);
	expect(card, `no card for ${fantraxPlayerId}`).toBeDefined();
	return card as BoardCard;
}

describe('the board is built from NOMINATIONS, not from Auctions', () => {
	it('carries a Player Awaiting an Opening Bid — the state iterating Auctions would omit', () => {
		// The whole reason the spine is `openNominations`: `OpenAuctions.byPlayer`
		// holds only Players who have received a Bid, so this card exists in one
		// projection and not the other.
		const { nominations, auctions } = project([
			nominated('p-1', 'Jalen Green', 't-1', 'Lakers', '2026-08-26T00:00:00.000Z')
		]);
		expect(auctionForPlayer(auctions, 'p-1')).toBeNull();

		const cards = boardCardsFor(nominations, auctions, new Map(), null);
		expect(cards).toHaveLength(1);
		const card = cardFor(cards, 'p-1');
		expect(card.contention).toBe('awaiting_opening_bid');
		// No clock at all — no Opening Bid has started one.
		expect(card.closesAt).toBeNull();
		expect(card.price).toBeNull();
		expect(card.leadingTeamName).toBeNull();
		// The nominating Team, which is what the card names in place of a leader.
		expect(card.nominatedByTeamName).toBe('Lakers');
		expect(card.nominatedAt).toBe('2026-08-26T00:00:00.000Z');
	});

	it('decorates the nominations that DO have Bids — an Open Auction', () => {
		const { nominations, auctions } = project([
			nominated('p-1', 'Jalen Green', 't-1', 'Lakers', '2026-08-26T00:00:00.000Z'),
			bid('p-1', 't-2', 'Rockets', 8_500_000, '2026-08-26T12:00:00.000Z', '2026-08-27T12:00:00.000Z')
		]);
		const card = cardFor(boardCardsFor(nominations, auctions, new Map(), null), 'p-1');
		expect(card.contention).toBe('standard');
		expect(card.price).toBe(8_500_000);
		expect(card.leadingTeamId).toBe('t-2');
		expect(card.leadingTeamName).toBe('Rockets');
		expect(card.closesAt).toBe('2026-08-27T12:00:00.000Z');
		expect(card.contenderCount).toBe(0);
	});

	it('carries a Minimum-Bid Contention with its Contender count', () => {
		const { nominations, auctions } = project([
			nominated('p-1', 'Jalen Green', 't-1', 'Lakers', '2026-08-26T00:00:00.000Z'),
			bid('p-1', 't-2', 'Rockets', MINIMUM_BID, '2026-08-26T12:00:00.000Z', '2026-08-27T12:00:00.000Z'),
			bid('p-1', 't-3', 'Heat', MINIMUM_BID, '2026-08-26T13:00:00.000Z', '2026-08-27T12:00:00.000Z')
		]);
		const card = cardFor(boardCardsFor(nominations, auctions, new Map(), null), 'p-1');
		expect(card.contention).toBe('minimum_bid');
		expect(card.contenderCount).toBe(2);
	});

	it('drops a card the moment its nomination is released', () => {
		// A close removes the Player from BOTH folds, so the board simply does
		// not carry it — which is why there is no Closed card to design.
		const { nominations, auctions } = project([
			nominated('p-1', 'Jalen Green', 't-1', 'Lakers', '2026-08-26T00:00:00.000Z'),
			event(
				'AuctionClosed',
				{
					fantraxPlayerId: 'p-1',
					teamId: 't-2',
					placement: 'active_bench',
					winningAmount: 8_500_000,
					capHit: 8_500_000
				},
				'2026-08-27T12:00:00.000Z'
			)
		]);
		expect(boardCardsFor(nominations, auctions, new Map(), null)).toEqual([]);
	});

	it('renders the reference row’s name and metadata, and omits the line when there is none', () => {
		const { nominations, auctions } = project([
			nominated('p-1', 'fold name', 't-1', 'Lakers', '2026-08-26T00:00:00.000Z'),
			nominated('p-2', 'Absent Player', 't-2', 'Heat', '2026-08-26T01:00:00.000Z')
		]);
		const cards = boardCardsFor(
			nominations,
			auctions,
			metadataFor({
				'p-1': { playerName: 'Jalen Green', nbaTeam: 'HOU', positions: 'SG' }
			}),
			null
		);
		const known = cardFor(cards, 'p-1');
		expect(known.playerName).toBe('Jalen Green');
		expect(metadataLine(known.nbaTeam, known.positions)).toBe('HOU · SG');

		// A Player absent from the pool table still renders by name from the
		// fold; the metadata line is omitted, never blanked or invented.
		const unknown = cardFor(cards, 'p-2');
		expect(unknown.playerName).toBe('Absent Player');
		expect(metadataLine(unknown.nbaTeam, unknown.positions)).toBeNull();
	});

	it('returns a deterministic order regardless of how the log folded', () => {
		const forwards = project([
			nominated('p-b', 'B', 't-1', 'Lakers', '2026-08-26T00:00:00.000Z'),
			nominated('p-a', 'A', 't-2', 'Heat', '2026-08-26T01:00:00.000Z')
		]);
		const backwards = project([
			nominated('p-a', 'A', 't-2', 'Heat', '2026-08-26T01:00:00.000Z'),
			nominated('p-b', 'B', 't-1', 'Lakers', '2026-08-26T00:00:00.000Z')
		]);
		const ids = (p: ReturnType<typeof project>) =>
			boardCardsFor(p.nominations, p.auctions, new Map(), null).map((c) => c.fantraxPlayerId);
		expect(ids(forwards)).toEqual(['p-a', 'p-b']);
		expect(ids(backwards)).toEqual(['p-a', 'p-b']);
	});
});

describe('the four viewer-relative states', () => {
	/** One Auction, folded, with whatever Bids the case needs. */
	function auctionWith(bids: readonly AppendedEvent[]): Auction {
		const { auctions } = project([
			nominated('p-1', 'Jalen Green', 't-1', 'Lakers', '2026-08-26T00:00:00.000Z'),
			...bids
		]);
		const auction = auctionForPlayer(auctions, 'p-1');
		expect(auction).not.toBeNull();
		return auction as Auction;
	}

	it('You lead — the viewer’s Team holds the leading Bid', () => {
		const auction = auctionWith([
			bid('p-1', 't-2', 'Rockets', 8_500_000, '2026-08-26T12:00:00.000Z', NOW)
		]);
		expect(viewerStateFor(auction, 't-2')).toBe('you_lead');
	});

	it('Outbid — the viewer has a Bid in the history and does not lead', () => {
		const auction = auctionWith([
			bid('p-1', 't-2', 'Rockets', 8_500_000, '2026-08-26T12:00:00.000Z', NOW),
			bid('p-1', 't-3', 'Heat', 9_000_000, '2026-08-26T13:00:00.000Z', NOW)
		]);
		expect(viewerStateFor(auction, 't-2')).toBe('outbid');
		expect(viewerStateFor(auction, 't-3')).toBe('you_lead');
	});

	it('Contender — a Team inside a contention is NOT reported as Outbid', () => {
		// The order of the tests inside `viewerStateFor` is the rule: a
		// Contender holds a non-leading Bid, so an outbid-first reading would
		// put the one attention colour in the product on a Team that has not
		// been outbid at all.
		const auction = auctionWith([
			bid('p-1', 't-2', 'Rockets', MINIMUM_BID, '2026-08-26T12:00:00.000Z', NOW),
			bid('p-1', 't-3', 'Heat', MINIMUM_BID, '2026-08-26T13:00:00.000Z', NOW)
		]);
		expect(auction.contention).toBe('minimum_bid');
		// The first joiner leads by "strictly higher"; the second is a Contender
		// and emphatically not Outbid.
		expect(viewerStateFor(auction, 't-3')).toBe('contender');
	});

	it('Contender — the EARLIEST joiner of a lottery does not lead it either', () => {
		// Nobody leads a lottery. Every Bid in a contention is the same amount,
		// so `leadingBid` names whoever joined first purely as the fold's `seq`
		// tiebreak — AD-14 decides the winner by a seeded draw over the ordered
		// Contender list, not by that field. A `you_lead` chip here would state
		// a standing the earliest joiner does not hold, and would invite them to
		// sit on an Auction they are no likelier to win than the Team beside
		// them. This is why `contender` is tested ahead of `you_lead` and not
		// merely ahead of `outbid`.
		const auction = auctionWith([
			bid('p-1', 't-2', 'Rockets', MINIMUM_BID, '2026-08-26T12:00:00.000Z', NOW),
			bid('p-1', 't-3', 'Heat', MINIMUM_BID, '2026-08-26T13:00:00.000Z', NOW)
		]);
		expect(auction.contention).toBe('minimum_bid');
		expect(auction.leadingBid?.teamId).toBe('t-2');
		expect(viewerStateFor(auction, 't-2')).toBe('contender');
		// And both Contenders read identically — the board states no ordering
		// between them, because the draw has not happened.
		expect(viewerStateFor(auction, 't-2')).toBe(viewerStateFor(auction, 't-3'));
	});

	it('You lead — is reachable ONLY outside a contention', () => {
		// The counterpart of the rule above: reordering the two tests would be
		// invisible on a standard Auction, which is exactly why the lottery case
		// is pinned separately.
		const auction = auctionWith([
			bid('p-1', 't-2', 'Rockets', 8_500_000, '2026-08-26T12:00:00.000Z', NOW)
		]);
		expect(auction.contention).toBe('standard');
		expect(auction.contenders).toEqual([]);
		expect(viewerStateFor(auction, 't-2')).toBe('you_lead');
	});

	it('a DISSOLVED contention returns both Teams to their real standing', () => {
		// `contendersFor` derives the Contender list from every historical Bid
		// at exactly `MINIMUM_BID`, and the reducer never clears it — so a
		// dissolved lottery is `standard` with the list still populated. A
		// contender test that read only the list would tell the Team whose
		// raise dissolved it, and who now genuinely leads, that they are a
		// Contender in a lottery that is no longer running; the `leading`
		// filter would then hide the very card they are winning.
		const auction = auctionWith([
			bid('p-1', 't-2', 'Rockets', MINIMUM_BID, '2026-08-26T12:00:00.000Z', NOW),
			bid('p-1', 't-3', 'Heat', MINIMUM_BID, '2026-08-26T13:00:00.000Z', NOW),
			// t-2 raises above the minimum, which converts the contention.
			bid('p-1', 't-2', 'Rockets', 2_000_000, '2026-08-26T14:00:00.000Z', NOW)
		]);
		// The state the guard turns on: converted, but the list survives.
		expect(auction.contention).toBe('standard');
		expect(auction.contenders.length).toBeGreaterThan(0);
		expect(auction.leadingBid?.teamId).toBe('t-2');
		// The Team that actually leads is told so.
		expect(viewerStateFor(auction, 't-2')).toBe('you_lead');
		// And the Team its raise genuinely outbid is told THAT — `attention`
		// belongs here now, because this Team really has been outbid.
		expect(viewerStateFor(auction, 't-3')).toBe('outbid');
	});

	it('Not involved — a Team with no Bid at all', () => {
		const auction = auctionWith([
			bid('p-1', 't-2', 'Rockets', 8_500_000, '2026-08-26T12:00:00.000Z', NOW)
		]);
		expect(viewerStateFor(auction, 't-9')).toBe('not_involved');
	});

	it('Not involved — a nomination nobody has bid on, for every viewer', () => {
		expect(viewerStateFor(null, 't-2')).toBe('not_involved');
		expect(viewerStateFor(null, null)).toBe('not_involved');
	});

	it('signed out or bound to no Team — the board renders in full, every card Not involved', () => {
		const { nominations, auctions } = project([
			nominated('p-1', 'Jalen Green', 't-1', 'Lakers', '2026-08-26T00:00:00.000Z'),
			bid('p-1', 't-1', 'Lakers', 8_500_000, '2026-08-26T12:00:00.000Z', NOW),
			nominated('p-2', 'Second', 't-2', 'Heat', '2026-08-26T01:00:00.000Z')
		]);
		const cards = boardCardsFor(nominations, auctions, new Map(), null);
		expect(cards).toHaveLength(2);
		for (const card of cards) expect(card.viewerState).toBe('not_involved');
		// The board is not narrowed for a signed-out viewer: the price and the
		// leader are still there, because everything is public.
		expect(cardFor(cards, 'p-1').price).toBe(8_500_000);
		expect(cardFor(cards, 'p-1').leadingTeamName).toBe('Lakers');
	});
});

describe('every state carries a word AND a shape', () => {
	it('words all three Auction states, and no fourth', () => {
		expect(Object.keys(AUCTION_STATE_LABELS).sort()).toEqual([
			'awaiting_opening_bid',
			'minimum_bid',
			'standard'
		]);
		expect(AUCTION_STATE_LABELS.awaiting_opening_bid).toBe('Awaiting Opening Bid');
		expect(AUCTION_STATE_LABELS.standard).toBe('Open');
		// The contention's CARD name from the fold that decides it, reused
		// rather than respelled. Not the glossary term: a board card's identity
		// row is scanned beside a Player's name and cannot carry the full term
		// at 375px. The term itself still stands on the Auction page.
		expect(AUCTION_STATE_LABELS.minimum_bid).toBe(MINIMUM_LOTTERY_LABEL);
	});

	it('words all four viewer-relative states, and no fifth', () => {
		expect(Object.keys(VIEWER_STATE_LABELS).sort()).toEqual([
			'contender',
			'not_involved',
			'outbid',
			'you_lead'
		]);
		expect(VIEWER_STATE_LABELS.you_lead).toBe('You lead');
		expect(VIEWER_STATE_LABELS.outbid).toBe('Outbid');
		expect(VIEWER_STATE_LABELS.contender).toBe('Contender');
		expect(VIEWER_STATE_LABELS.not_involved).toBe('Not involved');
	});

	it('gives every state its own non-empty shape, so greyscale still reads', () => {
		// A greyscale screenshot must remain fully readable, which requires the
		// icon set to be as distinguishing as the words: two states sharing one
		// glyph would collapse in exactly the rendering the rule protects.
		const auctionIcons = Object.values(AUCTION_STATE_ICONS);
		expect(new Set(auctionIcons).size).toBe(auctionIcons.length);
		const viewerIcons = Object.values(VIEWER_STATE_ICONS);
		expect(new Set(viewerIcons).size).toBe(viewerIcons.length);
		for (const icon of [...auctionIcons, ...viewerIcons]) expect(icon).not.toBe('');
		// And ACROSS the two records, not merely within each: both render on
		// the SAME card, side by side, so a glyph shared between them puts two
		// identical shapes on one card. Uniqueness inside each record alone
		// cannot see that — a lottery card carrying the contention's diamond
		// beside a Contender's diamond passes every per-record check and still
		// fails the greyscale test that is this story's acceptance criterion.
		const everyIcon = [...auctionIcons, ...viewerIcons];
		expect(new Set(everyIcon).size).toBe(everyIcon.length);
	});
});

describe('sorting — view state, total, and always tie-broken on the Player name', () => {
	type Row = {
		readonly fantraxPlayerId: string;
		readonly playerName: string;
		readonly closesAt: string | null;
		readonly price: number | null;
	};

	const rows: readonly Row[] = [
		{
			fantraxPlayerId: 'p-charlie',
			playerName: 'Charlie',
			closesAt: '2026-08-27T18:00:00.000Z',
			price: 9_000_000
		},
		{
			fantraxPlayerId: 'p-alice',
			playerName: 'Alice',
			closesAt: '2026-08-27T18:00:00.000Z',
			price: 9_000_000
		},
		{
			fantraxPlayerId: 'p-bob',
			playerName: 'Bob',
			closesAt: '2026-08-27T13:00:00.000Z',
			price: 1_000_000
		},
		{ fantraxPlayerId: 'p-dana', playerName: 'Dana', closesAt: null, price: null }
	];

	const names = (sorted: readonly Row[]) => sorted.map((row) => row.playerName);

	it('offers exactly three orderings, each with a word', () => {
		expect([...SORT_KEYS]).toEqual(['closing', 'price', 'name']);
		expect(DEFAULT_SORT).toBe('closing');
		for (const key of SORT_KEYS) expect(SORT_LABELS[key]).not.toBe('');
	});

	it('closing — soonest first, unclocked cards last, ties broken on the name', () => {
		expect(names(sortBoard(rows, 'closing', NOW))).toEqual(['Bob', 'Alice', 'Charlie', 'Dana']);
	});

	it('price — largest first, priceless cards last, ties broken on the name', () => {
		expect(names(sortBoard(rows, 'price', NOW))).toEqual(['Alice', 'Charlie', 'Bob', 'Dana']);
	});

	it('name — the tie-break standing alone', () => {
		expect(names(sortBoard(rows, 'name', NOW))).toEqual(['Alice', 'Bob', 'Charlie', 'Dana']);
	});

	it('is stable across the input order — the list cannot reshuffle between renders', () => {
		// The failure this forecloses: a comparator returning 0 on an equal key
		// leaves `Array.prototype.sort` free to reorder, so the same board
		// re-derived on a projection change visibly moves under the reader.
		const reversed = [...rows].reverse();
		for (const key of SORT_KEYS) {
			expect(names(sortBoard(rows, key, NOW))).toEqual(names(sortBoard(reversed, key, NOW)));
		}
	});

	it('is total even for two DIFFERENT Players who share a name', () => {
		// The name is not unique — the league has had two Players called the
		// same thing — so a chain ending at `playerName` still returns 0 for
		// the pair and hands them back to `Array.prototype.sort`. That is the
		// reshuffle this module exists to prevent, one level deeper, so every
		// chain ends at the Player id, which is unique by construction.
		const duplicates: readonly Row[] = [
			{ fantraxPlayerId: 'p-aaa', playerName: 'Jalen Johnson', closesAt: null, price: null },
			{ fantraxPlayerId: 'p-zzz', playerName: 'Jalen Johnson', closesAt: null, price: null }
		];
		const ids = (sorted: readonly Row[]) => sorted.map((row) => row.fantraxPlayerId);
		const reversed = [...duplicates].reverse();
		for (const key of SORT_KEYS) {
			expect(ids(sortBoard(duplicates, key, NOW))).toEqual(['p-aaa', 'p-zzz']);
			// The input order cannot change the output, which is what "total"
			// means and what a 0-returning comparator could not promise.
			expect(ids(sortBoard(reversed, key, NOW))).toEqual(ids(sortBoard(duplicates, key, NOW)));
		}
	});

	it('never sorts the caller’s array in place', () => {
		const original = [...rows];
		sortBoard(rows, 'name', NOW);
		expect(rows).toEqual(original);
	});

	it('changes no figure on any card', () => {
		// The acceptance criterion, stated as an assertion: sorting reorders and
		// nothing else. Every row that comes back is one that went in.
		for (const key of SORT_KEYS) {
			const sorted = sortBoard(rows, key, NOW);
			expect(sorted).toHaveLength(rows.length);
			for (const row of rows) expect(sorted).toContain(row);
		}
	});

	it('treats an unreadable instant as no clock rather than as the earliest', () => {
		const withGarbage: readonly Row[] = [
			{
				fantraxPlayerId: 'p-alice',
				playerName: 'Alice',
				closesAt: 'not-an-instant',
				price: null
			},
			{
				fantraxPlayerId: 'p-bob',
				playerName: 'Bob',
				closesAt: '2026-08-27T13:00:00.000Z',
				price: null
			}
		];
		expect(names(sortBoard(withGarbage, 'closing', NOW))).toEqual(['Bob', 'Alice']);
	});
});

describe('filtering — view state, visibly stated', () => {
	type Row = { readonly playerName: string; readonly viewerState: BoardCard['viewerState'] };
	const rows: readonly Row[] = [
		{ playerName: 'Alice', viewerState: 'you_lead' },
		{ playerName: 'Bob', viewerState: 'outbid' },
		{ playerName: 'Carla', viewerState: 'contender' },
		{ playerName: 'Dana', viewerState: 'not_involved' }
	];

	it('offers exactly three views, each with a word, defaulting to the whole board', () => {
		expect([...FILTER_KEYS]).toEqual(['all', 'leading', 'contending']);
		expect(DEFAULT_FILTER).toBe('all');
		for (const key of FILTER_KEYS) expect(FILTER_LABELS[key]).not.toBe('');
	});

	it('all hides nothing', () => {
		expect(filterBoard(rows, 'all')).toEqual(rows);
		expect(filteredNoticeSentence('all', rows.length, rows.length)).toBeNull();
	});

	it('leading and contending each name one viewer state, and Outbid is neither', () => {
		expect(filterBoard(rows, 'leading').map((r) => r.playerName)).toEqual(['Alice']);
		expect(filterBoard(rows, 'contending').map((r) => r.playerName)).toEqual(['Carla']);
	});

	it('states what a filtered view is hiding, with its own count', () => {
		const notice = filteredNoticeSentence('leading', 1, 4);
		expect(notice).not.toBeNull();
		expect(notice).toContain(FILTER_LABELS.leading);
		expect(notice).toContain('1 of 4');
		expect(notice).toContain('3 Auctions are hidden');
	});

	it('writes the singular out rather than printing “1 Auctions”', () => {
		expect(filteredNoticeSentence('contending', 1, 2)).toContain('one Auction is hidden');
	});

	it('says so plainly when a filter happens to hide nothing', () => {
		expect(filteredNoticeSentence('leading', 3, 3)).toContain('Nothing on the board is hidden');
	});
});

describe('the counts and phrases the board states', () => {
	it('counts the whole board, singular written out', () => {
		expect(boardCountSentence(0)).toBe('No Auctions are open.');
		expect(boardCountSentence(1)).toBe('One Auction is open.');
		expect(boardCountSentence(7)).toBe('7 Auctions are open.');
	});

	it('states hours unbid, in whole hours', () => {
		expect(unbidPhrase('2026-08-26T05:00:00.000Z', NOW)).toBe('31h unbid');
		expect(unbidPhrase('2026-08-27T11:30:00.000Z', NOW)).toBe('unbid for less than an hour');
	});

	it('never prints a negative count, and never throws on an unreadable instant', () => {
		// A device whose clock is behind the server that stamped the nomination.
		expect(unbidPhrase('2026-08-28T00:00:00.000Z', NOW)).toBe('unbid for less than an hour');
		expect(unbidPhrase('not-an-instant', NOW)).toBe('unbid for an unknown time');
		expect(unbidPhrase(NOW, 'not-an-instant')).toBe('unbid for an unknown time');
	});

	it('renders a price through the core’s one renderer, and says so when there is none', () => {
		expect(priceLabel(parseMoney(8_500_000))).toBe('$8.5M');
		expect(priceLabel(null)).toBe(NO_OPENING_BID);
		expect(NO_OPENING_BID).toBe('No opening bid');
		// An off-grid historical amount is described rather than crashed over.
		expect(priceLabel(parseMoney(8_400_000))).toBe('an amount that is not on the grid');
	});

	it('states the absent leader rather than leaving a blank', () => {
		expect(NO_LEADING_BIDDER).not.toBe('');
	});

	it('renders the metadata line as NBA · POS and nothing more', () => {
		// No salary and no contract years: `free_agent_players` carries neither
		// column, so a line naming one would be a figure this app does not have.
		expect(metadataLine('HOU', 'SG')).toBe('HOU · SG');
		expect(metadataLine('HOU', null)).toBe('HOU');
		expect(metadataLine(null, 'SG')).toBe('SG');
		expect(metadataLine(null, null)).toBeNull();
	});

	it('designs the empty board rather than treating it as an edge case', () => {
		expect(EMPTY_BOARD_HEADING).not.toBe('');
		// It explains the state AND points at the act that fills the board.
		expect(EMPTY_BOARD_STATEMENT).toContain('Nomination Slot');
		expect(EMPTY_BOARD_ACTION).toContain('Nominate');
	});

	it('gives the ARCHIVED empty board its own words, and no act', () => {
		// A frozen board with nothing on it is a different fact from a board
		// waiting to fill, and it must not offer the act that fills one —
		// `nominate` is not a live destination in Archived, so the Auction
		// Phase's action would resolve to a 403.
		expect(ARCHIVED_EMPTY_BOARD_HEADING).not.toBe('');
		expect(ARCHIVED_EMPTY_BOARD_HEADING).not.toBe(EMPTY_BOARD_HEADING);
		expect(ARCHIVED_EMPTY_BOARD_STATEMENT).not.toBe(EMPTY_BOARD_STATEMENT);
		// It states what happened rather than inviting an act that has closed.
		expect(ARCHIVED_EMPTY_BOARD_STATEMENT).not.toContain('Nominate a Free Agent');
		expect(ARCHIVED_EMPTY_BOARD_STATEMENT.toLowerCase()).toContain('auction phase is over');
		// Reassures about STATE, not feelings: no apology, no exclamation.
		expect(ARCHIVED_EMPTY_BOARD_STATEMENT).not.toMatch(/!|sorry|unfortunately/i);
	});
});

// --- The leaderless Auction, pinned (Story 10.6, FR-40) ---------------------

describe('a leaderless Auction renders as the unbid nomination the board already has', () => {
	it('carries no price, no leader and no clock — and no state of its own', () => {
		// Story 10.6 PINS this; it builds nothing. FR-40 leaves an Auction
		// behind with every Bid cancelled and nothing restored, and the board
		// gives it the treatment it already gives a Player Awaiting an Opening
		// Bid. A "restarted" state would be a fourth thing for a Manager to
		// learn about a card that has nothing new to say.
		const { nominations, auctions } = project([
			nominated('p-1', 'Jalen Green', 't-1', 'Lakers', '2026-08-26T00:00:00.000Z'),
			bid('p-1', 't-2', 'Rockets', 8_500_000, '2026-08-26T12:00:00.000Z', '2026-08-27T12:00:00.000Z')
		]);
		const open = auctionForPlayer(auctions, 'p-1');
		expect(open).not.toBeNull();
		// The state FR-40 leaves: the Bids are still in `bids`, and the lead
		// and the clock are gone.
		const leaderless = {
			byPlayer: {
				...auctions.byPlayer,
				'p-1': { ...(open as Auction), leadingBid: null, closesAt: null }
			}
		};

		const card = cardFor(boardCardsFor(nominations, leaderless, new Map(), null), 'p-1');
		const unbid = cardFor(
			boardCardsFor(
				project([nominated('p-2', 'Jalen Green', 't-1', 'Lakers', '2026-08-26T00:00:00.000Z')])
					.nominations,
				INITIAL_AUCTIONS,
				new Map(),
				null
			),
			'p-2'
		);

		expect(card.price).toBeNull();
		expect(card.leadingTeamId).toBeNull();
		expect(card.leadingTeamName).toBeNull();
		expect(card.closesAt).toBeNull();
		// The history is untouched — every Bid is still folded on the Auction.
		expect((open as Auction).bids.length).toBeGreaterThan(0);
		// And every field the card states about its state matches the unbid
		// one, which is what "the treatment the board already has" means.
		expect(card.viewerState).toBe(unbid.viewerState);
		expect(card.price).toBe(unbid.price);
		expect(card.closesAt).toBe(unbid.closesAt);
	});

	it('names no restarted state anywhere in the board vocabulary', () => {
		for (const label of Object.values(AUCTION_STATE_LABELS)) {
			expect(label.toLowerCase()).not.toContain('restart');
		}
		for (const label of Object.values(VIEWER_STATE_LABELS)) {
			expect(label.toLowerCase()).not.toContain('restart');
		}
	});
});
