/**
 * The draws fold — the three facts that outlive the Auction (Story 3.6,
 * FR-19, AD-5, AD-14).
 *
 * **The property this whole projection exists for**: `auctionsReducer` drops a
 * Player from `auctions.byPlayer` the instant their `AuctionClosed` is folded,
 * so the seed, the ordered Contender list and the selection would leave with
 * it — and "afterwards" is exactly when a losing Manager wants to check the
 * draw. So the last test here folds a close over a recorded draw and asserts
 * that the Auction is gone and the draw is not.
 *
 * The rest is the discipline every reducer in this core shares: first-write-
 * wins so replay converges, a malformed payload skipped rather than thrown
 * over, and a `default: return state` that leaves every other event alone.
 */

import { describe, expect, it } from 'vitest';

import {
	INITIAL_AUCTIONS,
	auctionForPlayer,
	auctionsReducer
} from '../src/lib/core/projection/auctions.ts';
import {
	CONTENTION_DRAWN_EVENT,
	INITIAL_DRAWS,
	drawForPlayer,
	drawsReducer,
	readDrawnFacts
} from '../src/lib/core/projection/draws.ts';
import type { Draw, DrawnDraw } from '../src/lib/core/projection/draws.ts';
import { fold } from '../src/lib/core/projection/fold.ts';
import { BID_PLACED_EVENT } from '../src/lib/core/projection/auctions.ts';
import {
	AUCTION_CLOSED_EVENT,
	AUCTION_TERMINATED_EVENT
} from '../src/lib/core/projection/nominations.ts';
import type { AppendedEvent } from '../src/lib/core/types.ts';

const SEED = '4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e';
const SEED_HASH = '0f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a6978';
const CLOSES_AT = '2026-08-27T09:00:00.000Z';

/**
 * The drawn half of the record, asserted rather than cast (Story 10.5). `Draw`
 * gained an `undrawn` case for a lottery FR-40's cascade emptied, so a test
 * reading a winner is stating "and this row recorded one".
 */
function drawnRecord(draw: Draw | null | undefined): DrawnDraw {
	if (draw === undefined || draw === null) throw new Error('expected a recorded draw');
	if (draw.kind !== 'drawn') throw new Error(`expected a drawn record, received "${draw.kind}"`);
	return draw;
}

let nextSeq = 0;

function event(type: string, payload: unknown, occurredAt = CLOSES_AT): AppendedEvent {
	nextSeq += 1;
	return {
		seq: String(nextSeq),
		occurredAt,
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload,
		managerId: 'm-g',
		teamId: 't-g',
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

/** A well-formed `ContentionDrawn` payload, with anything overridden. */
function drawnPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		fantraxPlayerId: 'p-1',
		seed: SEED,
		seedHash: SEED_HASH,
		contenders: ['t-e', 't-f', 't-g', 't-h'],
		selectedIndex: 2,
		winningTeamId: 't-g',
		winningTeamName: 'Team G',
		winningManagerId: 'm-g',
		drawnAt: CLOSES_AT,
		...overrides
	};
}

const drawn = (overrides: Record<string, unknown> = {}) =>
	event(CONTENTION_DRAWN_EVENT, drawnPayload(overrides));

const closed = (fantraxPlayerId = 'p-1') =>
	event(AUCTION_CLOSED_EVENT, {
		fantraxPlayerId,
		playerName: 'Ausar Bright',
		teamId: 't-g',
		teamName: 'Team G',
		managerId: 'm-g',
		winningAmount: 1_000_000,
		capHit: 1_000_000,
		placement: 'active_bench',
		contention: 'minimum_bid',
		contractYears: null,
		closedAt: CLOSES_AT
	});

const foldDraws = (events: readonly AppendedEvent[]) => fold(INITIAL_DRAWS, events, drawsReducer);

describe('drawsReducer — the draw is recorded', () => {
	it('records the seed, the commitment, the ordered list and the selection', () => {
		const draws = foldDraws([drawn()]);

		expect(drawForPlayer(draws, 'p-1')).toEqual({
			kind: 'drawn',
			fantraxPlayerId: 'p-1',
			seed: SEED,
			seedHash: SEED_HASH,
			contenders: ['t-e', 't-f', 't-g', 't-h'],
			selectedIndex: 2,
			winningTeamId: 't-g',
			winningTeamName: 'Team G',
			winningManagerId: 'm-g'
		} satisfies Draw);
	});

	it('answers null for a Player no lottery ever drew for', () => {
		expect(drawForPlayer(foldDraws([drawn()]), 'p-other')).toBeNull();
		expect(drawForPlayer(INITIAL_DRAWS, 'p-1')).toBeNull();
	});

	it('reads a key that is a Player id and never an inherited property', () => {
		// The keys are Fantrax player ids, which are DATA: a key of
		// `constructor` must not read back as an inherited function and be
		// mistaken for a draw.
		expect(drawForPlayer(INITIAL_DRAWS, 'constructor')).toBeNull();
		expect(drawForPlayer(INITIAL_DRAWS, '__proto__')).toBeNull();
	});
});

describe('drawsReducer — replay converges (AD-5)', () => {
	it('keeps the FIRST draw seen and ignores a second for the same Player', () => {
		const draws = foldDraws([
			drawn(),
			drawn({ winningTeamId: 't-h', winningTeamName: 'Team H', selectedIndex: 3 })
		]);

		expect(drawnRecord(drawForPlayer(draws, 'p-1')).winningTeamId).toBe('t-g');
	});

	it('folds the same log twice onto the same state', () => {
		const log = [drawn(), closed()];
		expect(foldDraws([...log, ...log])).toEqual(foldDraws(log));
	});

	it('leaves every other event alone', () => {
		const log = [
			event(BID_PLACED_EVENT, {
				fantraxPlayerId: 'p-1',
				teamId: 't-e',
				teamName: 'Team E',
				managerId: 'm-e',
				amount: 1_000_000,
				closesAt: CLOSES_AT
			}),
			event('SomethingThisReducerHasNeverHeardOf', { fantraxPlayerId: 'p-1' })
		];

		expect(foldDraws(log)).toEqual(INITIAL_DRAWS);
	});
});

describe('drawsReducer — nothing removes an entry (the AC’s permanence)', () => {
	it('still answers with all three facts after the Auction has closed and gone', () => {
		// The Auction leaves `auctions.byPlayer` on its close — that is what
		// makes the sweep re-derivable and a won Player stop being exposure —
		// and "afterwards" is exactly when a losing Manager checks the draw.
		const log = [drawn(), closed()];

		expect(auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1')).toBeNull();

		const draw = drawnRecord(drawForPlayer(foldDraws(log), 'p-1'));
		expect(draw.seed).toBe(SEED);
		expect(draw.contenders).toEqual(['t-e', 't-f', 't-g', 't-h']);
		expect(draw.winningTeamId).toBe('t-g');
	});

	it('is unmoved by a close naming a DIFFERENT Player, too', () => {
		expect(foldDraws([drawn(), closed('p-other')])).toEqual(foldDraws([drawn()]));
	});
});

describe('readDrawnFacts — a malformed payload is SKIPPED, never thrown over', () => {
	it.each([
		['not an object', 'a string'],
		['null', null],
		['no Player', drawnPayload({ fantraxPlayerId: undefined })],
		['an empty Player', drawnPayload({ fantraxPlayerId: '' })],
		['no seed', drawnPayload({ seed: undefined })],
		['an empty seed', drawnPayload({ seed: '' })],
		['no winner', drawnPayload({ winningTeamId: undefined })],
		['an empty winner', drawnPayload({ winningTeamId: '' })],
		['no Contender list', drawnPayload({ contenders: undefined })],
		['a Contender list that is not an array', drawnPayload({ contenders: 't-e' })],
		// An empty list is a REAL record since Story 10.5 — but not beside a
		// named winner, which is a row stating two things that cannot both be
		// true of one lottery. `drawnPayload` names `t-g`.
		['an EMPTY Contender list that still names a winner', drawnPayload({ contenders: [] })],
		['a hole in the Contender list', drawnPayload({ contenders: ['t-e', '', 't-g'] })],
		['a non-string in the Contender list', drawnPayload({ contenders: ['t-e', 7] })]
	])('skips %s', (_label: string, payload: unknown) => {
		expect(readDrawnFacts(payload)).toBeNull();
		expect(foldDraws([event(CONTENTION_DRAWN_EVENT, payload)])).toEqual(INITIAL_DRAWS);
	});

	it('records a null commitment as the absence it is, rather than skipping', () => {
		// Reachable from a corrupt or hand-written log. The draw still ran and
		// is still the record; what is missing is only the thing to check it
		// against, and that is stated rather than dropped.
		const draw = drawForPlayer(foldDraws([drawn({ seedHash: null })]), 'p-1');

		expect(draw).not.toBeNull();
		expect(draw?.seedHash).toBeNull();
		expect(drawForPlayer(foldDraws([drawn({ seedHash: '' })]), 'p-1')?.seedHash).toBeNull();
	});

	it('falls back on the NAME rather than dropping a real draw', () => {
		const draw = drawnRecord(drawForPlayer(foldDraws([drawn({ winningTeamName: undefined })]), 'p-1'));

		// A name standing in for its own id still points at the same Team.
		expect(draw.winningTeamName).toBe('t-g');
	});

	it('records a missing winningManagerId as null, and NEVER as the Team id', () => {
		const draw = drawnRecord(drawForPlayer(foldDraws([drawn({ winningManagerId: undefined })]), 'p-1'));

		// A Manager id filled in from the Team id would be a value from another
		// namespace wearing this field's label — a surface printing it would
		// attribute the draw to a Manager who does not exist.
		expect(draw.winningManagerId).toBeNull();
		expect(draw.winningManagerId).not.toBe('t-g');
		// The draw itself still stands; the absence is recorded, not fatal.
		expect(draw.winningTeamId).toBe('t-g');
	});

	it('recovers a missing selectedIndex from the list it was recorded with', () => {
		expect(
			drawnRecord(drawForPlayer(foldDraws([drawn({ selectedIndex: undefined })]), 'p-1'))
				.selectedIndex
		).toBe(2);
		expect(
			drawnRecord(drawForPlayer(foldDraws([drawn({ selectedIndex: 'two' })]), 'p-1')).selectedIndex
		).toBe(2);
	});

	it('recovers a selectedIndex that is an integer but not a POSITION', () => {
		// An integer alone is not a place in the list: both of these would put
		// the recorded selection outside the very list it indexes.
		// The list holds four, so 0..3 are real positions and these are not.
		for (const outOfRange of [-1, 4, 99]) {
			expect(
				drawnRecord(drawForPlayer(foldDraws([drawn({ selectedIndex: outOfRange })]), 'p-1'))
					.selectedIndex
			).toBe(2);
		}
	});

	it('SKIPS a payload whose winner is absent from its own Contender list', () => {
		// Not a draw with a bad field — a record inviting a Manager to
		// reproduce a derivation that could not have produced it.
		expect(
			drawForPlayer(foldDraws([drawn({ winningTeamId: 't-nobody' })]), 'p-1')
		).toBeNull();
	});
});

describe('readDrawnFacts — the empty record is a DRAW, not a rejection (Story 10.5)', () => {
	/** The reveal `decideClose` writes for a lottery every Contender left. */
	const undrawnPayload = (overrides: Record<string, unknown> = {}) => ({
		fantraxPlayerId: 'p-1',
		seed: SEED,
		seedHash: SEED_HASH,
		contenders: [],
		drawnAt: CLOSES_AT,
		...overrides
	});

	it('records the empty list and the revealed seed, with no winner and no position', () => {
		// A published commitment that never opens is the one outcome AD-14
		// cannot survive, so the seed is here — and this projection is where a
		// Manager who recorded the hash goes to check it. Rejecting the row
		// would leave the one lottery whose fairness is hardest to take on
		// trust as the one lottery with no record.
		const draws = foldDraws([event(CONTENTION_DRAWN_EVENT, undrawnPayload())]);

		expect(drawForPlayer(draws, 'p-1')).toEqual({
			kind: 'undrawn',
			fantraxPlayerId: 'p-1',
			seed: SEED,
			seedHash: SEED_HASH,
			contenders: []
		} satisfies Draw);
	});

	it('records a null commitment on the empty record too', () => {
		const draw = drawForPlayer(
			foldDraws([event(CONTENTION_DRAWN_EVENT, undrawnPayload({ seedHash: undefined }))]),
			'p-1'
		);

		expect(draw?.kind).toBe('undrawn');
		expect(draw?.seedHash).toBeNull();
	});

	it('never falls back to a selectedIndex for an empty list', () => {
		// `drawIndex` never ran, so there is no position to recover. A `0`
		// beside an empty list would name a place that does not exist.
		const draw = drawForPlayer(
			foldDraws([event(CONTENTION_DRAWN_EVENT, undrawnPayload({ selectedIndex: 0 }))]),
			'p-1'
		);

		expect(draw).not.toBeNull();
		expect(Object.hasOwn(draw as object, 'selectedIndex')).toBe(false);
		expect(Object.hasOwn(draw as object, 'winningTeamId')).toBe(false);
	});

	it('SKIPS the two self-contradicting shapes', () => {
		// An empty list naming a winner: there is no list for that Team to
		// have been on. A non-empty list naming nobody: a draw over Teams
		// selected one of them. Each states two things that cannot both be
		// true of one lottery.
		expect(readDrawnFacts(undrawnPayload({ winningTeamId: 't-g' }))).toBeNull();
		expect(
			readDrawnFacts(drawnPayload({ winningTeamId: undefined, selectedIndex: undefined }))
		).toBeNull();
		expect(readDrawnFacts(drawnPayload({ winningTeamId: '' }))).toBeNull();
	});

	it('still requires the Player and the seed on the empty record', () => {
		expect(readDrawnFacts(undrawnPayload({ fantraxPlayerId: '' }))).toBeNull();
		expect(readDrawnFacts(undrawnPayload({ seed: undefined }))).toBeNull();
	});

	it('outlives the AuctionTerminated that ended the lottery', () => {
		// The permanence property, for the outcome that has no `AuctionClosed`
		// at all: the Auction is dropped by the termination and the record of
		// the empty draw is not.
		const log = [
			event(CONTENTION_DRAWN_EVENT, undrawnPayload()),
			event(AUCTION_TERMINATED_EVENT, {
				fantraxPlayerId: 'p-1',
				playerName: 'Ausar Bright',
				teamId: 't-n',
				teamName: 'Team N',
				managerId: 'm-n',
				expiredAt: CLOSES_AT,
				evaluatedAt: CLOSES_AT
			})
		];

		expect(auctionForPlayer(fold(INITIAL_AUCTIONS, log, auctionsReducer), 'p-1')).toBeNull();
		expect(drawForPlayer(foldDraws(log), 'p-1')?.seed).toBe(SEED);
	});
});
