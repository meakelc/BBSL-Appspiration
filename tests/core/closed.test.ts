/**
 * The Closed state of an Auction — the ONE composition every closed surface
 * reads (`src/lib/core/projection/closed.ts`).
 *
 * **The property this module exists for**: a close DELETES the Player from
 * `auctionsReducer` and `nominationsReducer`, and both `contractsReducer` and
 * `drawsReducer` survive it. So the whole of a Closed Auction is reachable
 * after the fact, which is exactly when a losing Manager wants to check the
 * draw — and until this module existed there was nowhere for the three
 * surfaces that render it to agree on what "it" was.
 *
 * What is asserted here is the composition and its refusals: a contract is
 * what makes an Auction closed, a draw alone is not one, both draw kinds reach
 * a reader, and the winning Manager is taken from the draw or from nowhere.
 */

import { describe, expect, it } from 'vitest';

import { parseMoney } from '../../src/lib/core/money.ts';
import {
	CLOSED_LABEL,
	CLOSED_LABEL_NARROW,
	EMPTIED_LOTTERY_STATEMENT,
	PLACEMENT_LABELS,
	SEED_COMMITMENT_LABEL,
	SEED_REVEALED_LABEL,
	SELECTED_CONTENDER_ICON,
	SELECTED_CONTENDER_LABEL,
	VERIFY_INVITATION,
	VERIFY_PATH,
	closedAuctionFor,
	closedAuctions,
	selectedPositionSentence,
	wonCardSentence
} from '../../src/lib/core/projection/closed.ts';
import { AUCTION_STATE_ICONS, VIEWER_STATE_ICONS } from '../../src/lib/core/board.ts';
import { INITIAL_CONTRACTS, contractsReducer } from '../../src/lib/core/projection/contracts.ts';
import {
	CONTENTION_DRAWN_EVENT,
	INITIAL_DRAWS,
	drawsReducer
} from '../../src/lib/core/projection/draws.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	AUCTION_CLOSED_EVENT,
	INITIAL_NOMINATIONS,
	NOMINATION_PLACED_EVENT,
	nominationForPlayer,
	nominationsReducer
} from '../../src/lib/core/projection/nominations.ts';
import {
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer
} from '../../src/lib/core/projection/auctions.ts';
import { closedPayload } from '../fixtures/closed-event.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';

const SEED = '4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e';
const SEED_HASH = '0f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a6978';

let nextSeq = 0;

function event(type: string, payload: unknown): AppendedEvent {
	nextSeq += 1;
	return {
		seq: String(nextSeq),
		occurredAt: '2026-08-27T09:00:00.000Z',
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload,
		managerId: 'm-x',
		teamId: 't-x',
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	} as unknown as AppendedEvent;
}

function nominated(fantraxPlayerId: string, playerName: string): AppendedEvent {
	return event(NOMINATION_PLACED_EVENT, {
		fantraxPlayerId,
		playerName,
		teamId: 't-nom',
		teamName: 'Nominators',
		managerId: 'm-nom'
	});
}

function closed(overrides: Record<string, unknown> = {}): AppendedEvent {
	return event(AUCTION_CLOSED_EVENT, closedPayload(overrides));
}

function drawn(overrides: Record<string, unknown> = {}): AppendedEvent {
	return event(CONTENTION_DRAWN_EVENT, {
		fantraxPlayerId: 'p-1',
		seed: SEED,
		seedHash: SEED_HASH,
		contenders: ['t-a', 't-b', 't-c'],
		selectedIndex: 1,
		winningTeamId: 't-b',
		winningTeamName: 'Rockets',
		winningManagerId: 'm-b',
		...overrides
	});
}

/** Every fold a closed Auction touches, over one log. */
function project(events: readonly AppendedEvent[]) {
	return {
		nominations: fold(INITIAL_NOMINATIONS, events, nominationsReducer),
		auctions: fold(INITIAL_AUCTIONS, events, auctionsReducer),
		contracts: fold(INITIAL_CONTRACTS, events, contractsReducer),
		draws: fold(INITIAL_DRAWS, events, drawsReducer)
	};
}

describe('closedAuctionFor — the contract is what makes an Auction closed', () => {
	it('composes the two folds that SURVIVE the close that deletes the other two', () => {
		const log = [nominated('p-1', 'Jalen Green'), drawn(), closed({ teamId: 't-b', teamName: 'Rockets' })];
		const { nominations, auctions, contracts, draws } = project(log);

		// The premise, stated rather than assumed: both live folds have dropped
		// this Player entirely, so nothing but this composition can answer for
		// the Auction any more.
		expect(nominationForPlayer(nominations, 'p-1')).toBeNull();
		expect(auctionForPlayer(auctions, 'p-1')).toBeNull();

		const one = closedAuctionFor(contracts, draws, 'p-1');
		expect(one).not.toBeNull();
		expect(one?.fantraxPlayerId).toBe('p-1');
		expect(one?.contract.teamName).toBe('Rockets');
		expect(one?.contract.winningAmount).toBe(parseMoney(1_000_000));
		expect(one?.contract.placement).toBe('active_bench');
		expect(one?.contract.closedAt).toBe('2026-08-27T09:00:00.000Z');
		expect(one?.draw?.kind).toBe('drawn');
	});

	it('is null for a Player never nominated and for one still open', () => {
		const empty = project([]);
		expect(closedAuctionFor(empty.contracts, empty.draws, 'p-1')).toBeNull();

		const open = project([nominated('p-1', 'Jalen Green')]);
		expect(closedAuctionFor(open.contracts, open.draws, 'p-1')).toBeNull();
	});

	it('is null for a DRAW with no close behind it — a draw alone is not closed', () => {
		// The refusal this composition exists to make. A `ContentionDrawn` with
		// no `AuctionClosed` says a lottery selected somebody and the close was
		// never recorded, which is a corrupt or half-written log; naming a
		// winner from it would put a Player on a roster nothing says they are
		// on. The draw is still THERE — it just does not make a Closed Auction.
		const { contracts, draws } = project([nominated('p-1', 'Jalen Green'), drawn()]);
		expect(draws.byPlayer['p-1']).toBeDefined();
		expect(closedAuctionFor(contracts, draws, 'p-1')).toBeNull();
	});

	it('carries no draw at all for an ordinary Standard close', () => {
		const { contracts, draws } = project([nominated('p-1', 'Jalen Green'), closed()]);
		const one = closedAuctionFor(contracts, draws, 'p-1');
		expect(one).not.toBeNull();
		expect(one?.draw).toBeNull();
		// And no Manager: a Standard close records the winning TEAM and none,
		// so this is the absence it is rather than an id borrowed from
		// somewhere else, which would name a person who was not there.
		expect(one?.winningManagerId).toBeNull();
	});

	it('takes the winning Manager from the DRAW, and from nowhere else', () => {
		const { contracts, draws } = project([
			nominated('p-1', 'Jalen Green'),
			drawn(),
			closed({ teamId: 't-b', teamName: 'Rockets' })
		]);
		expect(closedAuctionFor(contracts, draws, 'p-1')?.winningManagerId).toBe('m-b');
	});

	it('drops the Manager when the draw and the close name DIFFERENT Teams', () => {
		// Two folds, two payloads, one claim about a person. `decideClose` writes
		// both events in one transaction, so a divergence is reachable only from
		// a corrupt or hand-written log — but the consequence of trusting it is
		// naming the WRONG MANAGER as the winner of a Player, on the page a
		// losing Manager opened specifically to check who won. The Team still
		// won and `teamName` still says so; only the Manager is dropped, which
		// is the same fallback an ordinary Standard close already takes.
		const { contracts, draws } = project([
			nominated('p-1', 'Jalen Green'),
			drawn(),
			closed({ teamId: 't-z', teamName: 'Suns' })
		]);
		const one = closedAuctionFor(contracts, draws, 'p-1');
		expect(one?.contract.teamId).toBe('t-z');
		expect(one?.contract.teamName).toBe('Suns');
		expect(one?.winningManagerId).toBeNull();
		// The draw itself is still carried in full — it is the record a Manager
		// verifies against, and dropping it would hide the divergence rather
		// than refuse to compose across it.
		expect(one?.draw?.seed).not.toBe('');
	});

	it('reaches an EMPTIED lottery, which is a record and not a rejected row', () => {
		// Story 10.5: FR-40's cascade cancelled every Contender before the draw
		// ran. The commitment is discharged whatever the list came out as, so
		// the seed is here and a reader that dropped this would leave a Manager
		// holding a published hash with nothing to check it against.
		const { contracts, draws } = project([
			nominated('p-1', 'Jalen Green'),
			drawn({ contenders: [], selectedIndex: undefined, winningTeamId: undefined, winningTeamName: undefined, winningManagerId: undefined }),
			closed()
		]);
		const one = closedAuctionFor(contracts, draws, 'p-1');
		expect(one?.draw?.kind).toBe('undrawn');
		expect(one?.draw?.seed).toBe(SEED);
		expect(one?.draw?.seedHash).toBe(SEED_HASH);
		expect(one?.draw?.contenders).toEqual([]);
		// No winner was recorded, so none is named.
		expect(one?.winningManagerId).toBeNull();
	});
});

describe('closedAuctions — every closed Auction, in a stated order', () => {
	it('is the CONTRACTS and never the draws, in ascending fantraxPlayerId', () => {
		const { contracts, draws } = project([
			nominated('p-2', 'Alperen Sengun'),
			nominated('p-1', 'Jalen Green'),
			// A draw with no close: present in `draws`, absent from this list.
			drawn({ fantraxPlayerId: 'p-9' }),
			closed({ fantraxPlayerId: 'p-2', playerName: 'Alperen Sengun' }),
			closed({ fantraxPlayerId: 'p-1', playerName: 'Jalen Green' })
		]);
		expect(closedAuctions(contracts, draws).map((one) => one.fantraxPlayerId)).toEqual([
			'p-1',
			'p-2'
		]);
	});

	it('is empty for a log with no close in it', () => {
		const { contracts, draws } = project([nominated('p-1', 'Jalen Green')]);
		expect(closedAuctions(contracts, draws)).toEqual([]);
	});
});

describe('the words — one spelling, reachable from every surface', () => {
	it('states the placement AND the Cap Hit, because they are independent (AD-23)', () => {
		// Relocated from `positions.ts` unchanged, so `board.ts` can reach it
		// without the import cycle that module would close. A minors placement
		// carries a $0 Cap Hit while the winning amount stands unchanged.
		expect(wonCardSentence('active_bench', parseMoney(11_000_000))).toBe(
			'Placed in an Active/Bench Slot at a $11.0M Cap Hit.'
		);
		expect(wonCardSentence('minor_league', parseMoney(0))).toBe(
			'Placed in a Minor League Slot at a $0.0M Cap Hit.'
		);
		// **Three, and the third is not reachable from a close** (FR-44). A won
		// Contract lands in one of two Slots; a Roster Move recorded afterwards
		// can put it on Injury Reserve, and the Team view prints this sentence
		// for that row. `dead_money` is still absent — it is a charge and not a
		// Slot, and nothing was ever placed there.
		expect(wonCardSentence('injury_reserve', parseMoney(4_000_000))).toBe(
			'Placed in an Injury Reserve Slot at a $4.0M Cap Hit.'
		);
		expect(Object.keys(PLACEMENT_LABELS).sort()).toEqual([
			'active_bench',
			'injury_reserve',
			'minor_league'
		]);
	});

	it('never congratulates — the Closed state is stated', () => {
		for (const word of [CLOSED_LABEL, CLOSED_LABEL_NARROW, EMPTIED_LOTTERY_STATEMENT]) {
			expect(word).not.toMatch(/[!]/);
			expect(word.toLowerCase()).not.toMatch(/congratulat|well done|nice/);
		}
		// `Closed` is already as short as it goes, so the narrow spelling is
		// the same string rather than a second name nobody asked for.
		expect(CLOSED_LABEL_NARROW).toBe(CLOSED_LABEL);
	});

	it('states the emptied lottery as an outcome, and keeps the seed with it', () => {
		expect(EMPTIED_LOTTERY_STATEMENT).toContain('no Team was selected');
		// The reason the seed is printed anyway, said out loud on the page.
		expect(EMPTIED_LOTTERY_STATEMENT).toContain('commitment stands');
	});

	it('names the selected position ONE-based, over a stated total', () => {
		// `/verify` produces an index and the record must be an index too,
		// rather than a lookup a Manager has to perform correctly first. The
		// list beside it is read by eye, and nobody counts from zero.
		expect(selectedPositionSentence(0, 4)).toBe('The draw selected position 1 of 4.');
		expect(selectedPositionSentence(3, 4)).toBe('The draw selected position 4 of 4.');
	});

	it('points at the procedure page by the path the route actually serves', () => {
		expect(VERIFY_PATH).toBe('/verify');
		expect(VERIFY_INVITATION).not.toBe('');
	});

	it('labels the two hex values for what they ARE, not for where they came from', () => {
		expect(SEED_COMMITMENT_LABEL).toBe('Published commitment');
		expect(SEED_REVEALED_LABEL).toBe('Revealed seed');
		expect(SELECTED_CONTENDER_LABEL).toBe('Selected');
	});

	it('marks the selected Contender with a shape that is NOT the won glyph', () => {
		// `VIEWER_STATE_ICONS.won` means "settled, and it is YOURS" — a claim
		// about the READER. This mark means "the reduction landed here", a fact
		// about the LIST. The two are one tap apart, because a closed lottery is
		// reached from a board card carrying the won glyph, and the Manager most
		// likely to make that journey is the one who LOST. Sharing a glyph would
		// print `✓` against another Team's row and tell a losing Manager they
		// won a Player they did not — the exact reader AD-14 exists to serve.
		expect(SELECTED_CONTENDER_ICON).not.toBe(VIEWER_STATE_ICONS.won);
	});

	it('keeps that shape disjoint from every glyph it can appear near', () => {
		// The greyscale rule: a card and a list carry these side by side, so a
		// repeated shape costs exactly the distinction the icon+word pairing
		// exists to guarantee.
		const neighbours = [
			...Object.values(AUCTION_STATE_ICONS),
			...Object.values(VIEWER_STATE_ICONS)
		];
		expect(neighbours).not.toContain(SELECTED_CONTENDER_ICON);
		expect(SELECTED_CONTENDER_ICON).not.toBe('');
	});
});
