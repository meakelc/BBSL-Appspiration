/**
 * The Minor League occupancy fold (Story 7.11, FR-44, PRD §10 example 46).
 *
 * **The one property this projection has that no other does is that it only
 * ever GROWS.** `eligibilityReducer` deletes on `after: false` because the
 * pool flag is a current state; this set is a history, and an observation
 * cannot be un-observed. A fold that removed an id would make demoting an
 * imported stash destroy the only fact the app held saying he may be stashed,
 * and the act would be irreversible — which FR-44 forbids in as many words.
 *
 * The seed is asserted separately from the fold, because the seed is the half
 * the log cannot reconstruct: `ImportPromoted` carries per-Team counts and no
 * per-Player slot detail.
 */

import { describe, expect, it } from 'vitest';

import {
	DROP_RECORDED_EVENT,
	ROSTER_REARRANGED_EVENT,
	ROSTER_TRADE_RECORDED_EVENT
} from '../../src/lib/core/projection/contracts.ts';
import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	INITIAL_MINORS_HISTORY,
	hasEverOccupiedMinorLeague,
	minorsHistoryReducer,
	seedMinorsHistory
} from '../../src/lib/core/projection/minors-history.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';

let nextSeq = 0;

function event(type: string, payload: unknown): AppendedEvent {
	nextSeq += 1;
	return {
		seq: String(nextSeq),
		occurredAt: '2026-09-12T09:00:00.000Z',
		schemaVersion: 1,
		coreVersion: 1,
		managerId: 'm-1',
		teamId: 't-1',
		type,
		payload,
		deviceClass: 'desktop',
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

/** Fold from empty state — the rebuild-from-the-log half. */
function observed(events: readonly AppendedEvent[]) {
	return fold(INITIAL_MINORS_HISTORY, events, minorsHistoryReducer);
}

describe('the seed — what the log cannot reconstruct', () => {
	it('holds exactly the rows sitting in a Minor League Slot right now', () => {
		const seeded = seedMinorsHistory([
			{ fantraxPlayerId: 'p-stash', rosterSlotKind: 'minor_league' },
			{ fantraxPlayerId: 'p-active', rosterSlotKind: 'active_bench' },
			{ fantraxPlayerId: 'p-ir', rosterSlotKind: 'injury_reserve' },
			{ fantraxPlayerId: 'p-dead', rosterSlotKind: 'dead_money' }
		]);

		expect(hasEverOccupiedMinorLeague(seeded, 'p-stash')).toBe(true);
		expect(hasEverOccupiedMinorLeague(seeded, 'p-active')).toBe(false);
		expect(hasEverOccupiedMinorLeague(seeded, 'p-ir')).toBe(false);
		expect(hasEverOccupiedMinorLeague(seeded, 'p-dead')).toBe(false);
	});

	it('starts empty when nothing is held', () => {
		expect(seedMinorsHistory([]).size).toBe(0);
		expect(INITIAL_MINORS_HISTORY.size).toBe(0);
	});

	it('absence is “never observed”, which is the honest default', () => {
		// The refusal §10 example 46 requires is worded off exactly this: the
		// app has never been TOLD, which is not the same as ineligible.
		expect(hasEverOccupiedMinorLeague(INITIAL_MINORS_HISTORY, 'p-anybody')).toBe(false);
	});
});

describe('the fold — the three acts that can move a Contract out of minors', () => {
	it('observes both ends of a Roster Trade transfer', () => {
		const state = observed([
			event(ROSTER_TRADE_RECORDED_EVENT, {
				transfers: [
					{ fantraxPlayerId: 'p-out', fromPlacement: 'minor_league', toPlacement: 'active_bench' },
					{ fantraxPlayerId: 'p-in', fromPlacement: 'active_bench', toPlacement: 'minor_league' },
					{ fantraxPlayerId: 'p-neither', fromPlacement: 'active_bench', toPlacement: 'active_bench' }
				]
			})
		]);

		expect(hasEverOccupiedMinorLeague(state, 'p-out')).toBe(true);
		expect(hasEverOccupiedMinorLeague(state, 'p-in')).toBe(true);
		expect(hasEverOccupiedMinorLeague(state, 'p-neither')).toBe(false);
	});

	it('observes both ends of a Roster Move', () => {
		const state = observed([
			event(ROSTER_REARRANGED_EVENT, {
				moves: [
					{ fantraxPlayerId: 'p-demoted', fromPlacement: 'minor_league', toPlacement: 'active_bench' },
					{ fantraxPlayerId: 'p-promoted', fromPlacement: 'active_bench', toPlacement: 'minor_league' }
				]
			})
		]);

		// **The demotion is the one that matters**, and it is §10 example 46's
		// Thompson: without it, moving a stash out would destroy the only fact
		// the app held saying he may be stashed.
		expect(hasEverOccupiedMinorLeague(state, 'p-demoted')).toBe(true);
		expect(hasEverOccupiedMinorLeague(state, 'p-promoted')).toBe(true);
	});

	it('observes only the Slot a Drop LEFT', () => {
		const state = observed([
			event(DROP_RECORDED_EVENT, {
				released: [
					{ fantraxPlayerId: 'p-stash', fromPlacement: 'minor_league' },
					{ fantraxPlayerId: 'p-plain', fromPlacement: 'active_bench' }
				]
			})
		]);

		// Where a release WENT is not a Slot at all — Dead Money, or removed.
		expect(hasEverOccupiedMinorLeague(state, 'p-stash')).toBe(true);
		expect(hasEverOccupiedMinorLeague(state, 'p-plain')).toBe(false);
	});

	it('ignores every other event type', () => {
		const state = observed([
			event('AuctionClosed', { fantraxPlayerId: 'p-won', placement: 'minor_league' }),
			event('MinorLeagueEligibilitySet', { fantraxPlayerId: 'p-flag', after: true }),
			event('Unworded', { moves: [{ fantraxPlayerId: 'p-x', toPlacement: 'minor_league' }] })
		]);

		// A Close needs no entry: it can only place in minors because the POOL
		// FLAG said so, and that flag is folded independently.
		expect(state.size).toBe(0);
	});
});

describe('the fold — union, never replace', () => {
	it('never removes an id, whatever a later event says', () => {
		const state = observed([
			event(ROSTER_REARRANGED_EVENT, {
				moves: [
					{ fantraxPlayerId: 'p-1', fromPlacement: 'active_bench', toPlacement: 'minor_league' }
				]
			}),
			event(ROSTER_REARRANGED_EVENT, {
				moves: [
					{ fantraxPlayerId: 'p-1', fromPlacement: 'minor_league', toPlacement: 'active_bench' }
				]
			}),
			event(DROP_RECORDED_EVENT, {
				released: [{ fantraxPlayerId: 'p-1', fromPlacement: 'active_bench' }]
			})
		]);

		// Demoted, then dropped from Active/Bench. The observation stands.
		expect(hasEverOccupiedMinorLeague(state, 'p-1')).toBe(true);
	});

	it('unions the seed with the log rather than replacing either', () => {
		const seeded = seedMinorsHistory([
			{ fantraxPlayerId: 'p-current', rosterSlotKind: 'minor_league' }
		]);
		const state = fold(
			seeded,
			[
				event(ROSTER_REARRANGED_EVENT, {
					moves: [
						{ fantraxPlayerId: 'p-past', fromPlacement: 'minor_league', toPlacement: 'active_bench' }
					]
				})
			],
			minorsHistoryReducer
		);

		expect(hasEverOccupiedMinorLeague(state, 'p-current')).toBe(true);
		expect(hasEverOccupiedMinorLeague(state, 'p-past')).toBe(true);
		// And the seed itself was not mutated — the caller's state is never
		// touched, which is what makes a second fold converge.
		expect(hasEverOccupiedMinorLeague(seeded, 'p-past')).toBe(false);
	});

	it('converges when the same log is folded twice (AD-5)', () => {
		const events = [
			event(ROSTER_TRADE_RECORDED_EVENT, {
				transfers: [
					{ fantraxPlayerId: 'p-a', fromPlacement: 'minor_league', toPlacement: 'active_bench' }
				]
			}),
			event(DROP_RECORDED_EVENT, {
				released: [{ fantraxPlayerId: 'p-b', fromPlacement: 'minor_league' }]
			})
		];
		const once = observed(events);
		const twice = fold(once, events, minorsHistoryReducer);

		expect([...twice].sort()).toEqual([...once].sort());
		// Nothing new was observed, so the reducer returned the caller's own
		// state rather than allocating a set per event.
		expect(twice).toBe(once);
	});
});

describe('the fold — a malformed historical row is skipped, never thrown over', () => {
	it('survives payloads that are not objects and lists that are not lists', () => {
		for (const payload of [null, 'a string', 42, [1, 2, 3], undefined, { moves: 'nope' }]) {
			expect(() => observed([event(ROSTER_REARRANGED_EVENT, payload)])).not.toThrow();
			expect(observed([event(ROSTER_REARRANGED_EVENT, payload)]).size).toBe(0);
		}
	});

	it('skips an entry with no id, or a placement that is not a Slot', () => {
		const state = observed([
			event(ROSTER_REARRANGED_EVENT, {
				moves: [
					{ fromPlacement: 'minor_league', toPlacement: 'active_bench' },
					{ fantraxPlayerId: '', toPlacement: 'minor_league' },
					{ fantraxPlayerId: 'p-ok', toPlacement: 'minor_league' },
					{ fantraxPlayerId: 'p-bad', toPlacement: 'somewhere_else' },
					'not an object'
				]
			})
		]);

		expect([...state]).toEqual(['p-ok']);
	});
});
