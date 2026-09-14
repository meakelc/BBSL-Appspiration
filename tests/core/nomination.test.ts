/**
 * The nomination fold, the nomination gate's wording, and the device-class
 * classifier. All pure (Story 2.1).
 */

import { describe, expect, it } from 'vitest';

import { closedPayload } from '../fixtures/closed-event.ts';

import { DEVICE_CLASSES, classifyDeviceClass } from '../../src/lib/core/device-class.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	AUCTION_CLOSED_EVENT,
	AUCTION_TERMINATED_EVENT,
	INITIAL_NOMINATIONS,
	NOMINATION_PLACED_EVENT,
	nominationForPlayer,
	nominationForTeam,
	nominationsReducer,
	openNominations
} from '../../src/lib/core/projection/nominations.ts';
import {
	INITIAL_CONTRACTS,
	contractForPlayer,
	contractsReducer
} from '../../src/lib/core/projection/contracts.ts';
import { AUCTION_OPENED_EVENT } from '../../src/lib/core/projection/phase.ts';
import {
	COMMISSIONER_NOMINATION_CONSEQUENCE,
	COMMISSIONER_SLOT_STATUS,
	NOMINATION_CONSEQUENCE,
	commissionerConsequenceSentence,
	nominationConfirmPrompt,
	nominationConsequenceSentence,
	nominationPoolStatus,
	nominationRefusalDetail,
	nominationSlotStatus,
	refuseNomination
} from '../../src/lib/core/rules/nomination.ts';
import type { NominationRefusal, NominationState } from '../../src/lib/core/rules/nomination.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';

function event(
	seq: number,
	type: string,
	payload: unknown = {},
	occurredAt = '2026-08-25T12:00:00.000Z'
): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt,
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload,
		managerId: 'm-1',
		teamId: 't-1',
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

function nomination(
	seq: number,
	fantraxPlayerId: string,
	playerName: string,
	teamId: string,
	teamName: string,
	occurredAt = '2026-08-25T12:00:00.000Z'
): AppendedEvent {
	return event(
		seq,
		NOMINATION_PLACED_EVENT,
		{ fantraxPlayerId, playerName, teamId, teamName, managerId: 'm-1' },
		occurredAt
	);
}

/**
 * A COMMISSIONER's nomination: the same event with `holdsSlot: false` (Story
 * 9.8).
 *
 * Written as a separate builder rather than a flag on the one above so that
 * every existing test keeps asserting about the Manager rule, and the
 * exemption is visible at each call site that exercises it.
 */
function exemptNomination(
	seq: number,
	fantraxPlayerId: string,
	playerName: string,
	teamId: string,
	teamName: string,
	occurredAt = '2026-08-25T12:00:00.000Z'
): AppendedEvent {
	return event(
		seq,
		NOMINATION_PLACED_EVENT,
		{ fantraxPlayerId, playerName, teamId, teamName, managerId: 'm-1', holdsSlot: false },
		occurredAt
	);
}

/**
 * A SYNTHETIC `AuctionClosed`. Epic 3 owns appending the real one; this
 * story proves the fold releases on it, so the test builds it by hand.
 *
 * The extra keys are the point of the second parameter: a real close will
 * carry a winner, a price and more, and this fold must read `fantraxPlayerId`
 * and nothing else.
 */
function closed(
	seq: number,
	fantraxPlayerId: string,
	extra: Record<string, unknown> = {},
	occurredAt = '2026-08-25T18:00:00.000Z'
): AppendedEvent {
	return event(seq, AUCTION_CLOSED_EVENT, closedPayload({ fantraxPlayerId, ...extra }), occurredAt);
}

// --- The fold ---------------------------------------------------------------

describe('nominationsReducer', () => {
	it('starts with an empty board and an empty Slot register', () => {
		expect(openNominations(INITIAL_NOMINATIONS)).toEqual([]);
		expect(nominationForPlayer(INITIAL_NOMINATIONS, 'p-1')).toBeNull();
		expect(nominationForTeam(INITIAL_NOMINATIONS, 't-1')).toBeNull();
	});

	it('ignores every event type it has not been taught', () => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[event(1, AUCTION_OPENED_EVENT), event(2, 'ImportPromoted'), event(3, 'BidPlaced')],
			nominationsReducer
		);
		expect(state).toEqual(INITIAL_NOMINATIONS);
	});

	it('indexes one nomination by Player AND by Team, carrying both names', () => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers', '2026-08-25T19:00:00.000Z')],
			nominationsReducer
		);

		expect(nominationForPlayer(state, 'p-1')).toEqual({
			fantraxPlayerId: 'p-1',
			playerName: 'Jalen Green',
			teamId: 't-1',
			teamName: 'Lakers',
			// Story 3.7: the nominating Manager, carried so an `AuctionTerminated`
			// can name them on its envelope the way an `AuctionClosed` names the
			// winner's. No gate reads it and no refusal prints it.
			managerId: 'm-1',
			// Story 9.8: an ordinary Manager nomination spends the Slot, which is
			// what puts it in `byTeam` at all. The payload said nothing, and the
			// absent field reads as the rule.
			holdsSlot: true,
			occurredAt: '2026-08-25T19:00:00.000Z'
		});
		expect(nominationForTeam(state, 't-1')).toEqual(nominationForPlayer(state, 'p-1'));
	});

	it('folds several nominations by several Teams', () => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[
				nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'),
				nomination(2, 'p-2', 'Alperen Sengun', 't-2', 'Celtics'),
				nomination(3, 'p-3', 'Amen Thompson', 't-3', 'Bulls')
			],
			nominationsReducer
		);
		expect(openNominations(state)).toHaveLength(3);
		expect(nominationForTeam(state, 't-2')?.playerName).toBe('Alperen Sengun');
	});

	it('converges on a double replay — the whole of "replay is idempotent"', () => {
		const log = [
			nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'),
			nomination(2, 'p-2', 'Alperen Sengun', 't-2', 'Celtics')
		];
		const once = fold(INITIAL_NOMINATIONS, log, nominationsReducer);
		const twice = fold(once, log, nominationsReducer);
		expect(twice).toEqual(once);
		// And a full rebuild from empty state agrees with the incremental fold.
		expect(fold(INITIAL_NOMINATIONS, [...log].reverse(), nominationsReducer)).toEqual(once);
	});

	it('keeps the FIRST nomination of a Player, so a duplicate never rewrites the board', () => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[
				nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'),
				nomination(2, 'p-1', 'Jalen Green', 't-2', 'Celtics')
			],
			nominationsReducer
		);
		expect(nominationForPlayer(state, 'p-1')?.teamName).toBe('Lakers');
		// And the second Team's Slot was NOT spent by a nomination that never held.
		expect(nominationForTeam(state, 't-2')).toBeNull();
	});

	it('keeps a Team’s FIRST nomination, so a second never frees or moves the Slot', () => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[
				nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'),
				nomination(2, 'p-2', 'Alperen Sengun', 't-1', 'Lakers')
			],
			nominationsReducer
		);
		expect(nominationForTeam(state, 't-1')?.playerName).toBe('Jalen Green');
		expect(nominationForPlayer(state, 'p-2')).toBeNull();
	});

	it('folds in seq order, not in array order', () => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[
				nomination(9, 'p-1', 'Late', 't-1', 'Lakers'),
				nomination(2, 'p-1', 'Early', 't-2', 'Celtics')
			],
			nominationsReducer
		);
		expect(nominationForPlayer(state, 'p-1')?.playerName).toBe('Early');
	});

	it.each([
		['not an object', 'nonsense'],
		['null', null],
		['no fantraxPlayerId', { teamId: 't-1' }],
		['a blank fantraxPlayerId', { fantraxPlayerId: '', teamId: 't-1' }],
		['no teamId', { fantraxPlayerId: 'p-1' }],
		['a non-string teamId', { fantraxPlayerId: 'p-1', teamId: 7 }]
	])('skips a malformed payload rather than throwing: %s', (_label, payload) => {
		// An insert-only log cannot be corrected in place, so a malformed
		// historical row must never crash the fold — and must never hold a
		// real Team's Slot hostage.
		const state = fold(
			INITIAL_NOMINATIONS,
			[event(1, NOMINATION_PLACED_EVENT, payload)],
			nominationsReducer
		);
		expect(state).toEqual(INITIAL_NOMINATIONS);
	});

	it('falls back to the ids when the names are missing, rather than dropping the Slot', () => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[event(1, NOMINATION_PLACED_EVENT, { fantraxPlayerId: 'p-1', teamId: 't-1' })],
			nominationsReducer
		);
		expect(nominationForPlayer(state, 'p-1')?.playerName).toBe('p-1');
		expect(nominationForTeam(state, 't-1')?.teamName).toBe('t-1');
	});

	it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
		'treats %s as an ordinary id, not as an inherited property',
		(hostileId: string) => {
			// The keys of both indexes are data. Probed with `in` or with a bare
			// truthiness check, every Team would appear to hold a Slot.
			expect(nominationForPlayer(INITIAL_NOMINATIONS, hostileId)).toBeNull();
			expect(nominationForTeam(INITIAL_NOMINATIONS, hostileId)).toBeNull();

			const state = fold(
				INITIAL_NOMINATIONS,
				[nomination(1, hostileId, 'Odd Name', hostileId, 'Odd Team')],
				nominationsReducer
			);
			expect(nominationForPlayer(state, hostileId)?.playerName).toBe('Odd Name');
			expect(nominationForPlayer(state, 'p-other')).toBeNull();
		}
	);

	it('never mutates the state it was handed', () => {
		const first = fold(
			INITIAL_NOMINATIONS,
			[nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers')],
			nominationsReducer
		);
		const second = fold(first, [nomination(2, 'p-2', 'Sengun', 't-2', 'Celtics')], nominationsReducer);
		expect(openNominations(first)).toHaveLength(1);
		expect(openNominations(second)).toHaveLength(2);
	});
});

// --- The release, on a synthetic close (Story 2.3) --------------------------

describe('nominationsReducer — AuctionClosed releases the nomination', () => {
	it('frees the board seat AND the nominating Team’s Slot together — AC1', () => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'), closed(2, 'p-1')],
			nominationsReducer
		);
		expect(nominationForPlayer(state, 'p-1')).toBeNull();
		expect(nominationForTeam(state, 't-1')).toBeNull();
		expect(openNominations(state)).toEqual([]);
	});

	it.each([
		['names another Team as the winner', { winningTeamId: 't-2', winningTeamName: 'Celtics' }],
		['names the nominator as the winner', { winningTeamId: 't-1', winningTeamName: 'Lakers' }],
		['names no winner at all', { winningTeamId: null }],
		['carries a price and a Slot Placement', { price: 42, slotPlacement: 'active_bench' }],
		['carries a whole bid history', { bids: [{ teamId: 't-2', amount: 3 }] }]
	])('frees the Slot identically when the close %s — the fold reads only the Player', (
		_label,
		extra: Record<string, unknown>
	) => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'), closed(2, 'p-1', extra)],
			nominationsReducer
		);
		expect(nominationForTeam(state, 't-1')).toBeNull();
		expect(nominationForPlayer(state, 'p-1')).toBeNull();
	});

	it('frees the Slot of a nominator who never bid — the close names nobody it needs to', () => {
		// No bid event exists in this log at all, which is the strongest form
		// of "the nominator never bid": there is nothing for the reducer to
		// have consulted even if it wanted to.
		const state = fold(
			INITIAL_NOMINATIONS,
			[nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'), closed(2, 'p-1')],
			nominationsReducer
		);
		expect(nominationForTeam(state, 't-1')).toBeNull();
	});

	it('leaves the state untouched when the close precedes any nomination — the reducer is total', () => {
		expect(() =>
			fold(INITIAL_NOMINATIONS, [closed(1, 'p-1')], nominationsReducer)
		).not.toThrow();
		expect(fold(INITIAL_NOMINATIONS, [closed(1, 'p-1')], nominationsReducer)).toEqual(
			INITIAL_NOMINATIONS
		);
	});

	it('releases only the closed Player — another Team’s Slot stays held', () => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[
				nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'),
				nomination(2, 'p-2', 'Alperen Sengun', 't-2', 'Celtics'),
				closed(3, 'p-2')
			],
			nominationsReducer
		);
		expect(nominationForPlayer(state, 'p-1')?.teamName).toBe('Lakers');
		expect(nominationForTeam(state, 't-1')?.playerName).toBe('Jalen Green');
		expect(nominationForPlayer(state, 'p-2')).toBeNull();
		expect(nominationForTeam(state, 't-2')).toBeNull();
	});

	it('leaves a held nomination alone when a DIFFERENT Player closes', () => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'), closed(2, 'p-9')],
			nominationsReducer
		);
		expect(nominationForPlayer(state, 'p-1')?.teamName).toBe('Lakers');
		expect(nominationForTeam(state, 't-1')?.playerName).toBe('Jalen Green');
	});

	it('converges when the whole log is folded twice, and in scrambled order', () => {
		const log = [nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'), closed(2, 'p-1')];
		const once = fold(INITIAL_NOMINATIONS, log, nominationsReducer);
		const twice = fold(once, log, nominationsReducer);
		expect(twice).toEqual(once);
		// And a rebuild from empty, in scrambled array order, agrees: fold()
		// orders by seq, so the close can never be applied before the open.
		expect(fold(INITIAL_NOMINATIONS, [...log].reverse(), nominationsReducer)).toEqual(once);
	});

	it('lets the Team nominate again after its Player closes — the whole point of the Slot', () => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[
				nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'),
				closed(2, 'p-1'),
				nomination(3, 'p-2', 'Alperen Sengun', 't-1', 'Lakers')
			],
			nominationsReducer
		);
		expect(nominationForTeam(state, 't-1')?.playerName).toBe('Alperen Sengun');
		expect(nominationForPlayer(state, 'p-2')?.teamName).toBe('Lakers');
		// The closed Player's entry is GONE, not overwritten by the new one.
		expect(nominationForPlayer(state, 'p-1')).toBeNull();
		expect(openNominations(state)).toHaveLength(1);
	});

	it('makes the closed Player nominatable again, by another Team', () => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[
				nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'),
				closed(2, 'p-1'),
				nomination(3, 'p-1', 'Jalen Green', 't-2', 'Celtics')
			],
			nominationsReducer
		);
		expect(nominationForPlayer(state, 'p-1')?.teamName).toBe('Celtics');
		expect(nominationForTeam(state, 't-1')).toBeNull();
	});

	it.each([
		['not an object', 'nonsense'],
		['null', null],
		['a number', 7],
		['no fantraxPlayerId', { winningTeamId: 't-2' }],
		['a blank fantraxPlayerId', { fantraxPlayerId: '' }],
		['a non-string fantraxPlayerId', { fantraxPlayerId: 7 }]
	])('skips a malformed close rather than throwing: %s', (_label, payload) => {
		const before = fold(
			INITIAL_NOMINATIONS,
			[nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers')],
			nominationsReducer
		);
		const after = fold(before, [event(2, AUCTION_CLOSED_EVENT, payload)], nominationsReducer);
		// A close nobody can identify frees nothing, and above all does not
		// crash the fold: an insert-only log cannot be corrected in place.
		expect(after).toEqual(before);
		expect(nominationForTeam(after, 't-1')?.playerName).toBe('Jalen Green');
	});

	it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
		'releases a hostile id %s as an ordinary key, without touching a prototype',
		(hostileId: string) => {
			const state = fold(
				INITIAL_NOMINATIONS,
				[nomination(1, hostileId, 'Odd Name', hostileId, 'Odd Team'), closed(2, hostileId)],
				nominationsReducer
			);
			expect(nominationForPlayer(state, hostileId)).toBeNull();
			expect(nominationForTeam(state, hostileId)).toBeNull();
			expect(openNominations(state)).toEqual([]);
			// Nothing leaked onto Object.prototype along the way.
			expect(Object.getPrototypeOf(state.byPlayer)).toBe(Object.prototype);
			expect(({} as Record<string, unknown>)[hostileId]).not.toBe('Odd Name');
		}
	);

	it('never mutates the state it was handed', () => {
		const held = fold(
			INITIAL_NOMINATIONS,
			[nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers')],
			nominationsReducer
		);
		const released = fold(held, [closed(2, 'p-1')], nominationsReducer);
		expect(openNominations(held)).toHaveLength(1);
		expect(openNominations(released)).toHaveLength(0);
		expect(nominationForTeam(held, 't-1')?.playerName).toBe('Jalen Green');
	});

	it('is the ONE name the release case and any future producer share', () => {
		// Two independent literals is how these drift: a producer appending
		// 'AuctionClosed ' or 'auctionClosed' would leave every Slot held
		// forever, with a green suite on both sides.
		expect(AUCTION_CLOSED_EVENT).toBe('AuctionClosed');
		expect(AUCTION_CLOSED_EVENT).not.toBe(NOMINATION_PLACED_EVENT);
	});
});

// --- The gate ---------------------------------------------------------------

function boardOf(...events: AppendedEvent[]) {
	return fold(INITIAL_NOMINATIONS, events, nominationsReducer);
}

function readyState(overrides: Partial<NominationState> = {}): NominationState {
	return {
		phase: 'Auction',
		nominations: INITIAL_NOMINATIONS,
		poolPlayer: { fantraxPlayerId: 'p-1', playerName: 'Jalen Green' },
		contractHolderTeamName: null,
		...overrides
	};
}

describe('refuseNomination — the gates, in order', () => {
	it('allows a nomination when every gate holds', () => {
		expect(refuseNomination(readyState(), 't-1')).toBeNull();
	});

	it.each(['Setup', 'Contract Assignment', 'Archived'] as const)(
		'refuses in the %s phase, naming the folded phase',
		(phase) => {
			const refusal = refuseNomination(readyState({ phase }), 't-1');
			expect(refusal?.kind).toBe('phase');
			if (refusal?.kind !== 'phase') return;
			expect(refusal.phase).toBe(phase);
			expect(nominationRefusalDetail(refusal)).toContain(phase);
		}
	);

	it('refuses a Player the pool has never heard of', () => {
		const refusal = refuseNomination(readyState({ poolPlayer: null }), 't-1');
		expect(refusal?.kind).toBe('unknown_player');
	});

	it('refuses a Player under contract, NAMING the Team that holds them', () => {
		const refusal = refuseNomination(readyState({ contractHolderTeamName: 'Celtics' }), 't-1');
		expect(refusal?.kind).toBe('under_contract');
		if (refusal?.kind !== 'under_contract') return;
		expect(refusal.teamName).toBe('Celtics');
		expect(refusal.playerName).toBe('Jalen Green');
		const detail = nominationRefusalDetail(refusal);
		expect(detail).toContain('Celtics');
		expect(detail).toContain('Jalen Green');
	});

	it('refuses a Player already on the board, NAMING the nominating Team', () => {
		const refusal = refuseNomination(
			readyState({
				nominations: boardOf(nomination(1, 'p-1', 'Jalen Green', 't-9', 'Celtics'))
			}),
			't-1'
		);
		expect(refusal?.kind).toBe('already_nominated');
		if (refusal?.kind !== 'already_nominated') return;
		expect(refusal.teamName).toBe('Celtics');
		expect(nominationRefusalDetail(refusal)).toContain('Celtics');
	});

	it('refuses when the actor’s Slot is in use, NAMING the Player holding it', () => {
		const refusal = refuseNomination(
			readyState({
				nominations: boardOf(nomination(1, 'p-9', 'Amen Thompson', 't-1', 'Lakers'))
			}),
			't-1'
		);
		expect(refusal?.kind).toBe('slot_in_use');
		if (refusal?.kind !== 'slot_in_use') return;
		expect(refusal.playerName).toBe('Amen Thompson');
		const detail = nominationRefusalDetail(refusal);
		expect(detail).toContain('Amen Thompson');
		// Named, not counted.
		expect(detail).not.toMatch(/\b1 nomination\b/);
	});

	it('lets another Team nominate while this Team’s Slot is held', () => {
		const nominations = boardOf(nomination(1, 'p-9', 'Amen Thompson', 't-1', 'Lakers'));
		expect(refuseNomination(readyState({ nominations }), 't-2')).toBeNull();
	});

	it('names the Player’s problem before the actor’s own held Slot', () => {
		// A standing condition the Manager can already see loses to news.
		const refusal = refuseNomination(
			readyState({
				contractHolderTeamName: 'Celtics',
				nominations: boardOf(nomination(1, 'p-9', 'Amen Thompson', 't-1', 'Lakers'))
			}),
			't-1'
		);
		expect(refusal?.kind).toBe('under_contract');
	});

	it('names the phase before anything else', () => {
		const refusal = refuseNomination(
			readyState({ phase: 'Setup', poolPlayer: null, contractHolderTeamName: 'Celtics' }),
			't-1'
		);
		expect(refusal?.kind).toBe('phase');
	});

	it('names the unknown Player before their contract', () => {
		const refusal = refuseNomination(
			readyState({ poolPlayer: null, contractHolderTeamName: 'Celtics' }),
			't-1'
		);
		expect(refusal?.kind).toBe('unknown_player');
	});

	it('names the contract before the board', () => {
		const refusal = refuseNomination(
			readyState({
				contractHolderTeamName: 'Celtics',
				nominations: boardOf(nomination(1, 'p-1', 'Jalen Green', 't-9', 'Bulls'))
			}),
			't-1'
		);
		expect(refusal?.kind).toBe('under_contract');
	});

	it('reads no clock, no database and no random source — the state IS the argument', () => {
		// Called twice with the identical argument, it answers identically;
		// there is nothing else it could be reading.
		const state = readyState();
		expect(refuseNomination(state, 't-1')).toEqual(refuseNomination(state, 't-1'));
		expect(refuseNomination(state, 't-1')).toBeNull();
	});

	it('nominates normally for a Team with no cap space — nothing here is arithmetic', () => {
		// There is no Money anywhere in `NominationState`, which is the
		// structural version of "a nomination commits nothing".
		expect(Object.keys(readyState())).toEqual([
			'phase',
			'nominations',
			'poolPlayer',
			'contractHolderTeamName'
		]);
	});
});

// --- Every refusal has exactly one sentence ---------------------------------

describe('nominationRefusalDetail', () => {
	const EVERY_REFUSAL: readonly NominationRefusal[] = [
		{ kind: 'phase', phase: 'Setup' },
		{ kind: 'unknown_player' },
		{ kind: 'under_contract', playerName: 'Jalen Green', teamName: 'Celtics' },
		{ kind: 'already_nominated', playerName: 'Jalen Green', teamName: 'Celtics' },
		{ kind: 'slot_in_use', playerName: 'Amen Thompson' },
		{ kind: 'unconfirmed', playerName: 'Jalen Green' },
		{ kind: 'unbound_actor' },
		{ kind: 'unrecorded' }
	];

	it('words every refusal kind, exhaustively', () => {
		const kinds = EVERY_REFUSAL.map((refusal) => refusal.kind);
		expect(new Set(kinds).size).toBe(EVERY_REFUSAL.length);
	});

	it.each(EVERY_REFUSAL.map((refusal) => [refusal.kind, refusal] as const))(
		'%s closes by saying nothing was written',
		(_kind: string, refusal: NominationRefusal) => {
			const detail = nominationRefusalDetail(refusal);
			expect(detail.endsWith('Nothing was written.')).toBe(true);
		}
	);

	it.each(EVERY_REFUSAL.map((refusal) => [refusal.kind, refusal] as const))(
		'%s states the fact without apology or exclamation',
		(_kind: string, refusal: NominationRefusal) => {
			const detail = nominationRefusalDetail(refusal);
			expect(detail).not.toMatch(/!/);
			expect(detail.toLowerCase()).not.toMatch(/sorry|oops|whoops|unfortunately/);
			expect(detail.startsWith('No nomination was placed:')).toBe(true);
		}
	);

	it('gives each refusal a DISTINCT sentence — no two refusals read alike', () => {
		const sentences = EVERY_REFUSAL.map((refusal) => nominationRefusalDetail(refusal));
		expect(new Set(sentences).size).toBe(sentences.length);
	});

	it('never counts what it could name', () => {
		for (const refusal of EVERY_REFUSAL) {
			expect(nominationRefusalDetail(refusal)).not.toMatch(/\d+ (Player|Team|nomination)s?/);
		}
	});

	it('says nothing about an "already won" state, which is unreachable until Story 2.3', () => {
		const kinds = EVERY_REFUSAL.map((refusal) => refusal.kind);
		expect(kinds).not.toContain('already_won');
	});
});

describe('nominationSlotStatus', () => {
	it('says the Slot is open, in one line, when nothing holds it', () => {
		expect(nominationSlotStatus(null)).toBe('Open for nomination.');
		expect(nominationSlotStatus('')).toBe('Open for nomination.');
	});

	it('names the Player holding the Slot, and when it comes back', () => {
		// The name is the one fact a Manager cannot derive from `/nominate`:
		// "held" without it sends them to the Bid Board to find out by whom.
		const held = nominationSlotStatus('Alperen Sengun');
		expect(held).toContain('Alperen Sengun');
		expect(held).toContain('until that Auction closes');
	});

	it('is a STATUS and never a refusal', () => {
		// A refusal is a reply to an act, and ends by saying nothing was
		// written. Opening the page is not an act, so neither branch may
		// exculpate the app for a submit that never happened.
		for (const sentence of [nominationSlotStatus(null), nominationSlotStatus('Jalen Green')]) {
			expect(sentence).not.toContain('Nothing was written');
			expect(sentence).not.toContain('No nomination was placed');
		}
	});

	it('stays short enough to be the one line the panel prints', () => {
		// The panel it replaced ran to three lines of refusal and pushed the
		// filter, the list and the control off a 375px first screen.
		expect(nominationSlotStatus(null).length).toBeLessThan(40);
		expect(nominationSlotStatus('Alperen Sengun').length).toBeLessThan(90);
	});
});

describe('NOMINATION_CONSEQUENCE', () => {
	it('states the Slot, which is the only thing a nomination commits', () => {
		expect(NOMINATION_CONSEQUENCE).toContain('Nomination Slot');
		expect(NOMINATION_CONSEQUENCE).toContain('Auction closes');
	});

	it('states plainly that nothing else is committed', () => {
		expect(NOMINATION_CONSEQUENCE).toContain('No cap space is committed');
		expect(NOMINATION_CONSEQUENCE).toContain('Leading Bidder');
	});

	it('names the Player when there is one, and stays general when there is not', () => {
		expect(nominationConsequenceSentence('Jalen Green')).toContain('Nominating Jalen Green');
		expect(nominationConsequenceSentence(null)).toContain('A nomination');
		expect(nominationConsequenceSentence('')).toContain('A nomination');
	});

	it('is the ONE definition every sentence is built from', () => {
		expect(nominationConsequenceSentence('Jalen Green')).toContain(NOMINATION_CONSEQUENCE);
		expect(nominationConsequenceSentence(null)).toContain(NOMINATION_CONSEQUENCE);
	});
});

// --- The classifier ---------------------------------------------------------

describe('classifyDeviceClass', () => {
	it.each([
		[null, 'unknown'],
		[undefined, 'unknown'],
		['', 'unknown'],
		['   ', 'unknown'],
		['some-crawler/1.0', 'unknown']
	])('classifies %s as %s — never null, never a throw', (agent, expected) => {
		expect(classifyDeviceClass(agent as string | null)).toBe(expected);
	});

	it.each([
		[
			'iPhone Safari',
			'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
			'mobile'
		],
		[
			'Android phone Chrome',
			'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
			'mobile'
		],
		['Windows Phone', 'Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1) IEMobile/11.0', 'mobile'],
		['Opera Mini', 'Opera/9.80 (J2ME/MIDP; Opera Mini/9.80) Presto/2.5.25', 'mobile'],
		[
			'iPad',
			'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
			'tablet'
		],
		[
			'Android tablet — an Android string WITHOUT "Mobile"',
			'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			'tablet'
		],
		['Kindle', 'Mozilla/5.0 (Linux; U; Android 4.4.3; KFTHWI Build/KTU84M) Silk/3.68', 'tablet'],
		[
			'Windows desktop',
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			'desktop'
		],
		[
			'macOS desktop',
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			'desktop'
		],
		[
			'Linux desktop',
			'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			'desktop'
		],
		[
			'ChromeOS',
			'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			'desktop'
		]
	])('classifies %s as %s', (_label: string, agent: string, expected: string) => {
		expect(classifyDeviceClass(agent)).toBe(expected);
	});

	it('checks tablet BEFORE mobile — an iPad says "Mobile" and is not a phone', () => {
		const ipad =
			'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148';
		expect(ipad).toContain('Mobile');
		expect(classifyDeviceClass(ipad)).toBe('tablet');
	});

	it('is case-insensitive', () => {
		expect(classifyDeviceClass('IPHONE')).toBe('mobile');
		expect(classifyDeviceClass('iphone')).toBe('mobile');
	});

	it('always answers with one of the four classes, for any input', () => {
		const agents = [
			'',
			'x',
			'\u0000\u0001',
			'a'.repeat(10_000),
			'Mobile'.repeat(500),
			'iPad Android Mobile Windows NT Macintosh'
		];
		for (const agent of agents) {
			expect(DEVICE_CLASSES).toContain(classifyDeviceClass(agent));
		}
	});

	it('stays linear on a long hostile string — there is no pattern to backtrack', () => {
		// Not a timing assertion: the point is that it terminates and answers.
		expect(classifyDeviceClass(`${'('.repeat(50_000)}iphone`)).toBe('mobile');
	});

	it('is deterministic — no clock, no randomness', () => {
		const agent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148';
		expect(classifyDeviceClass(agent)).toBe(classifyDeviceClass(agent));
	});
});

/**
 * A Player won in this auction reaches the SAME refusal (Story 3.4, AC5).
 *
 * The gate reads one `contractHolderTeamName` and has no notion of where it
 * came from — which is why `NominationRefusal` needed no new case and this
 * file needed no new wording. What is new is the second source: an Auction
 * Contract, folded from `AuctionClosed`, naming the winning Team. The
 * composition is asserted here rather than only in `server/nomination.test.ts`
 * so the claim "under_contract IS the already-won refusal" is executable
 * without a database.
 */
describe('refuseNomination — a won Player is under contract (Story 3.4)', () => {
	const close = (fantraxPlayerId: string, teamName: string) =>
		event(9, AUCTION_CLOSED_EVENT, {
			fantraxPlayerId,
			playerName: 'Jalen Green',
			teamId: 't-w',
			teamName,
			managerId: 'm-w',
			winningAmount: 8_000_000,
			capHit: 8_000_000,
			placement: 'active_bench',
			contention: 'standard',
			contractYears: null,
			closedAt: '2026-08-26T09:00:00.000Z'
		});

	it('refuses under_contract, naming the winning Team, from the fold alone', () => {
		const contracts = fold(INITIAL_CONTRACTS, [close('p-1', 'Rockets')], contractsReducer);

		const refusal = refuseNomination(
			readyState({
				// Exactly what `server/nomination.ts` resolves when the roster
				// join finds nothing: the contract's own `teamName`.
				contractHolderTeamName: contractForPlayer(contracts, 'p-1')?.teamName ?? null
			}),
			't-1'
		);

		expect(refusal?.kind).toBe('under_contract');
		if (refusal?.kind !== 'under_contract') return;
		expect(refusal.teamName).toBe('Rockets');
		expect(nominationRefusalDetail(refusal)).toContain('Rockets');
	});

	it('leaves a Player nobody won nominatable', () => {
		const contracts = fold(INITIAL_CONTRACTS, [close('p-9', 'Rockets')], contractsReducer);

		expect(
			refuseNomination(
				readyState({
					contractHolderTeamName: contractForPlayer(contracts, 'p-1')?.teamName ?? null
				}),
				't-1'
			)
		).toBeNull();
	});

	it('names the Player before it names the Slot, when both would refuse', () => {
		// `under_contract` precedes `slot_in_use`: the Slot is a standing
		// condition a Manager can already see, and the Player's unavailability
		// is the news.
		const contracts = fold(INITIAL_CONTRACTS, [close('p-1', 'Rockets')], contractsReducer);

		const refusal = refuseNomination(
			readyState({
				contractHolderTeamName: contractForPlayer(contracts, 'p-1')?.teamName ?? null,
				nominations: boardOf(
					event(1, NOMINATION_PLACED_EVENT, {
						fantraxPlayerId: 'p-7',
						playerName: 'Someone Else',
						teamId: 't-1',
						teamName: 'Lakers'
					})
				)
			}),
			't-1'
		);

		expect(refusal?.kind).toBe('under_contract');
	});
});

describe('nominationPoolStatus — what a pool row says about itself', () => {
	it('says Available when nothing refuses the Player', () => {
		expect(nominationPoolStatus(null, false)).toBe('Available');
	});

	it('separates a nomination nobody has bid on from an Auction in progress', () => {
		const refusal: NominationRefusal = {
			kind: 'already_nominated',
			playerName: 'Jalen Green',
			teamName: 'Celtics'
		};
		expect(nominationPoolStatus(refusal, false)).toBe('Nominated');
		expect(nominationPoolStatus(refusal, true)).toBe('In-Auction');
	});

	it('names the Team holding a Player who is under contract', () => {
		expect(
			nominationPoolStatus(
				{ kind: 'under_contract', playerName: 'Jalen Green', teamName: 'Rockets' },
				false
			)
		).toBe('Closed to Rockets');
	});

	it('states the plain fact for a refusal that is not about the Player', () => {
		// The phase refuses every row at once. That is the panel above the
		// list’s sentence to tell, not a fact about this Player.
		expect(nominationPoolStatus({ kind: 'phase', phase: 'Setup' }, false)).toBe('Not available');
	});

	it('never ends a row state in a sentence — a refusal paragraph is a submit’s', () => {
		const states = [
			nominationPoolStatus(null, false),
			nominationPoolStatus(
				{ kind: 'already_nominated', playerName: 'Jalen Green', teamName: 'Celtics' },
				true
			),
			nominationPoolStatus(
				{ kind: 'under_contract', playerName: 'Jalen Green', teamName: 'Rockets' },
				false
			)
		];
		for (const state of states) {
			expect(state).not.toContain('.');
			expect(state).not.toContain('Nothing was written');
			expect(state.split(' ').length).toBeLessThanOrEqual(4);
		}
	});
});

// --- The Commissioner exemption (Story 9.8) ---------------------------------

describe('the Commissioner exemption — the fold', () => {
	it('puts an exempt nomination on the board but never in the Slot register', () => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[exemptNomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers')],
			nominationsReducer
		);

		expect(nominationForPlayer(state, 'p-1')?.playerName).toBe('Jalen Green');
		expect(nominationForPlayer(state, 'p-1')?.holdsSlot).toBe(false);
		// The whole exemption, in one assertion: the Team's Slot reads open
		// because it IS open.
		expect(nominationForTeam(state, 't-1')).toBeNull();
	});

	it('folds several exempt nominations by the SAME Team — the point of the story', () => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[
				exemptNomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'),
				exemptNomination(2, 'p-2', 'Alperen Sengun', 't-1', 'Lakers'),
				exemptNomination(3, 'p-3', 'Ausar Bright', 't-1', 'Lakers')
			],
			nominationsReducer
		);

		expect(openNominations(state)).toHaveLength(3);
		expect(nominationForTeam(state, 't-1')).toBeNull();
	});

	it('still refuses a second nomination of the SAME Player, exempt or not', () => {
		// Exemption is from the Team's one-Slot rule and from nothing else.
		const state = fold(
			INITIAL_NOMINATIONS,
			[
				exemptNomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'),
				exemptNomination(2, 'p-1', 'Jalen Green', 't-2', 'Celtics')
			],
			nominationsReducer
		);

		expect(openNominations(state)).toHaveLength(1);
		expect(nominationForPlayer(state, 'p-1')?.teamName).toBe('Lakers');
	});

	it('reads a payload with no holdsSlot as Slot-spending — every nomination before 9.8', () => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers')],
			nominationsReducer
		);
		expect(nominationForPlayer(state, 'p-1')?.holdsSlot).toBe(true);
		expect(nominationForTeam(state, 't-1')?.playerName).toBe('Jalen Green');
	});

	it.each([
		['a non-boolean', 'yes'],
		['null', null],
		['a number', 0]
	])('reads %s holdsSlot as Slot-spending — corruption fails STRICT', (_label, value) => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[
				event(1, NOMINATION_PLACED_EVENT, {
					fantraxPlayerId: 'p-1',
					playerName: 'Jalen Green',
					teamId: 't-1',
					teamName: 'Lakers',
					managerId: 'm-1',
					holdsSlot: value
				})
			],
			nominationsReducer
		);
		expect(nominationForTeam(state, 't-1')?.playerName).toBe('Jalen Green');
	});

	it('releases an exempt nomination on a close, leaving the others standing', () => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[
				exemptNomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'),
				exemptNomination(2, 'p-2', 'Alperen Sengun', 't-1', 'Lakers'),
				closed(3, 'p-1')
			],
			nominationsReducer
		);

		expect(nominationForPlayer(state, 'p-1')).toBeNull();
		expect(nominationForPlayer(state, 'p-2')?.playerName).toBe('Alperen Sengun');
	});

	it('does NOT free a real Slot when an exempt nomination of the same Team closes', () => {
		// The regression `releaseSeat`'s identity check exists for: a Team with
		// BOTH kinds of open nomination — a Manager promoted mid-auction — must
		// not have its genuinely spent Slot released by the exempt one's close.
		const state = fold(
			INITIAL_NOMINATIONS,
			[
				nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'),
				exemptNomination(2, 'p-2', 'Alperen Sengun', 't-1', 'Lakers'),
				closed(3, 'p-2')
			],
			nominationsReducer
		);

		expect(nominationForPlayer(state, 'p-2')).toBeNull();
		expect(nominationForTeam(state, 't-1')?.playerName).toBe('Jalen Green');
	});

	it('frees the Slot on the close of the nomination that actually held it', () => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[
				nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'),
				exemptNomination(2, 'p-2', 'Alperen Sengun', 't-1', 'Lakers'),
				closed(3, 'p-1')
			],
			nominationsReducer
		);

		expect(nominationForTeam(state, 't-1')).toBeNull();
		expect(nominationForPlayer(state, 'p-2')?.playerName).toBe('Alperen Sengun');
	});

	it('applies the same identity rule to a termination', () => {
		const state = fold(
			INITIAL_NOMINATIONS,
			[
				nomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'),
				exemptNomination(2, 'p-2', 'Alperen Sengun', 't-1', 'Lakers'),
				event(3, AUCTION_TERMINATED_EVENT, { fantraxPlayerId: 'p-2' })
			],
			nominationsReducer
		);

		expect(nominationForPlayer(state, 'p-2')).toBeNull();
		expect(nominationForTeam(state, 't-1')?.playerName).toBe('Jalen Green');
	});

	it('converges on a double replay, exempt nominations included', () => {
		const log = [
			exemptNomination(1, 'p-1', 'Jalen Green', 't-1', 'Lakers'),
			exemptNomination(2, 'p-2', 'Alperen Sengun', 't-1', 'Lakers'),
			closed(3, 'p-1')
		];
		const once = fold(INITIAL_NOMINATIONS, log, nominationsReducer);
		const twice = fold(once, log, nominationsReducer);
		expect(twice).toEqual(once);
	});
});

describe('the Commissioner exemption — the gate', () => {
	function heldBy(teamId: string) {
		return fold(
			INITIAL_NOMINATIONS,
			[nomination(1, 'p-9', 'Ausar Bright', teamId, 'Lakers')],
			nominationsReducer
		);
	}

	it('refuses a Manager whose Slot is held', () => {
		const refusal = refuseNomination(readyState({ nominations: heldBy('t-1') }), 't-1', true);
		expect(refusal?.kind).toBe('slot_in_use');
	});

	it('admits a Commissioner through the same held Slot', () => {
		expect(refuseNomination(readyState({ nominations: heldBy('t-1') }), 't-1', false)).toBeNull();
	});

	it('defaults to the Manager rule when the caller says nothing', () => {
		expect(refuseNomination(readyState({ nominations: heldBy('t-1') }), 't-1')?.kind).toBe(
			'slot_in_use'
		);
	});

	it.each(['Setup', 'Contract Assignment', 'Archived'] as const)(
		'still refuses a Commissioner in the %s phase',
		(phase) => {
			expect(refuseNomination(readyState({ phase }), 't-1', false)?.kind).toBe('phase');
		}
	);

	it('still refuses a Commissioner an unknown Player', () => {
		expect(refuseNomination(readyState({ poolPlayer: null }), 't-1', false)?.kind).toBe(
			'unknown_player'
		);
	});

	it('still refuses a Commissioner a Player under contract', () => {
		expect(
			refuseNomination(readyState({ contractHolderTeamName: 'Celtics' }), 't-1', false)?.kind
		).toBe('under_contract');
	});

	it('still refuses a Commissioner a Player already on the board', () => {
		const nominations = fold(
			INITIAL_NOMINATIONS,
			[nomination(1, 'p-1', 'Jalen Green', 't-2', 'Celtics')],
			nominationsReducer
		);
		expect(refuseNomination(readyState({ nominations }), 't-1', false)?.kind).toBe(
			'already_nominated'
		);
	});
});

describe('the Commissioner wordings (Story 9.8)', () => {
	it('states the absence of a Slot rather than an open one', () => {
		expect(COMMISSIONER_SLOT_STATUS).toContain('Unlimited');
		expect(COMMISSIONER_SLOT_STATUS).toContain('Nomination Slot');
		// It must NOT be the Manager's own "open" line, which would read as a
		// Slot that this nomination is about to spend.
		expect(COMMISSIONER_SLOT_STATUS).not.toBe(nominationSlotStatus(null));
	});

	it('promises no Slot is held, and denies money exactly as the Manager sentence does', () => {
		expect(COMMISSIONER_NOMINATION_CONSEQUENCE).toContain('no Nomination Slot');
		expect(COMMISSIONER_NOMINATION_CONSEQUENCE).toContain('No cap space is committed');
		expect(COMMISSIONER_NOMINATION_CONSEQUENCE).toContain('Leading Bidder');
	});

	it('never claims a Slot is held', () => {
		expect(COMMISSIONER_NOMINATION_CONSEQUENCE).not.toContain('Slot is held');
		expect(COMMISSIONER_NOMINATION_CONSEQUENCE).not.toContain('only Nomination Slot');
	});

	it('names the Player and keeps the irreversibility', () => {
		const sentence = commissionerConsequenceSentence('Jalen Green');
		expect(sentence).toContain('Nominating Jalen Green');
		expect(sentence).toContain('cannot be undone');
		expect(sentence).toContain(COMMISSIONER_NOMINATION_CONSEQUENCE);
	});

	it('falls back to the unnamed subject, as the Manager sentence does', () => {
		expect(commissionerConsequenceSentence(null)).toContain('A nomination cannot be undone');
		expect(commissionerConsequenceSentence('')).toContain('A nomination cannot be undone');
	});
});

describe('nominationConfirmPrompt (Story 9.8)', () => {
	it('names the Player and the Slot for a Manager', () => {
		const prompt = nominationConfirmPrompt('Jalen Green', true);
		expect(prompt).toContain('Jalen Green');
		expect(prompt).toContain('holds your Slot');
		expect(prompt).toContain('The confirmation has not been given.');
	});

	it('names the Player and denies the Slot for a Commissioner', () => {
		const prompt = nominationConfirmPrompt('Jalen Green', false);
		expect(prompt).toContain('Jalen Green');
		expect(prompt).toContain('holds no Slot');
		expect(prompt).not.toContain('holds your Slot');
	});

	it('tells both readers the same thing about how to proceed', () => {
		for (const spends of [true, false]) {
			expect(nominationConfirmPrompt('Jalen Green', spends)).toContain(
				'Tick it to enable the control'
			);
		}
	});
});

describe('the unconfirmed refusal states the Board, not the Slot (Story 9.8)', () => {
	const detail = nominationRefusalDetail({ kind: 'unconfirmed', playerName: 'Jalen Green' });

	it('is true for a Commissioner as well as a Manager', () => {
		expect(detail).not.toContain('Nomination Slot');
		expect(detail).toContain('Bid Board');
	});

	it('still names the Player, says what to do, and says nothing was written', () => {
		expect(detail).toContain('Jalen Green');
		expect(detail).toContain('Tick the confirmation');
		expect(detail).toContain('Nothing was written');
	});
});
