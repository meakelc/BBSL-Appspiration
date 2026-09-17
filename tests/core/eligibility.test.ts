import { describe, expect, it } from 'vitest';

import { fold } from '../../src/lib/core/projection/fold.ts';
import {
	INITIAL_ELIGIBILITY,
	MINOR_LEAGUE_ELIGIBILITY_SET,
	eligibilityReducer,
	isEligible
} from '../../src/lib/core/projection/eligibility.ts';
import {
	ELIGIBILITY_CONSEQUENCE,
	eligibilityOutcomeDetail,
	eligibilityRefusalDetail,
	eligibilityRowSentence,
	planEligibilityChanges
} from '../../src/lib/core/rules/eligibility.ts';
import type { EligibilityCandidate } from '../../src/lib/core/rules/eligibility.ts';
import type { AppendedEvent } from '../../src/lib/core/types.ts';

/** One appended event, as the log hands it back. */
function event(seq: number, type: string, payload: unknown): AppendedEvent {
	return {
		seq: String(seq),
		occurredAt: '2026-08-25T09:00:00.000Z',
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

function setEvent(seq: number, id: string, before: boolean, after: boolean): AppendedEvent {
	return event(seq, MINOR_LEAGUE_ELIGIBILITY_SET, {
		fantraxPlayerId: id,
		playerName: `Player ${id}`,
		before,
		after
	});
}

// Alice and Bob are pooled Players; Carla is a rostered Contract. The mix is
// deliberate: `planEligibilityChanges` must stay indifferent to which is which,
// and `pooledAmong` must tell them apart.
const POOL: readonly EligibilityCandidate[] = [
	{ fantraxPlayerId: 'p-1', playerName: 'Alice', eligible: false, pooled: true },
	{ fantraxPlayerId: 'p-2', playerName: 'Bob', eligible: true, pooled: true },
	{ fantraxPlayerId: 'p-3', playerName: 'Carla', eligible: false, pooled: false }
];

describe('the eligibility reducer', () => {
	it('folds to no eligible Player when the log is empty — omission fails safe', () => {
		expect([...fold(INITIAL_ELIGIBILITY, [], eligibilityReducer)]).toEqual([]);
		expect(isEligible(INITIAL_ELIGIBILITY, 'p-1')).toBe(false);
	});

	it('adds on after=true and removes on after=false', () => {
		const state = fold(
			INITIAL_ELIGIBILITY,
			[setEvent(1, 'p-1', false, true), setEvent(2, 'p-2', false, true), setEvent(3, 'p-1', true, false)],
			eligibilityReducer
		);
		expect([...state].sort()).toEqual(['p-2']);
	});

	it('ignores every other event type, exactly as the phase reducer does', () => {
		const state = fold(
			INITIAL_ELIGIBILITY,
			[event(1, 'ImportPromoted', { teams: [] }), setEvent(2, 'p-1', false, true), event(3, 'AuctionOpened', {})],
			eligibilityReducer
		);
		expect([...state]).toEqual(['p-1']);
	});

	it('folds by seq, not by the order the events arrived in', () => {
		// The later event unsets. Handed to `fold` in reverse, the answer must
		// still be "not eligible" — a transaction queued on the lock commits
		// later while holding an earlier timestamp, so `seq` is the only order
		// that matches history.
		const state = fold(
			INITIAL_ELIGIBILITY,
			[setEvent(2, 'p-1', true, false), setEvent(1, 'p-1', false, true)],
			eligibilityReducer
		);
		expect([...state]).toEqual([]);
	});

	it('reproduces the flag as it stood at each point in the log', () => {
		const log = [
			setEvent(1, 'p-1', false, true),
			setEvent(2, 'p-2', false, true),
			setEvent(3, 'p-1', true, false),
			setEvent(4, 'p-3', false, true)
		];
		const at = (upTo: number): string[] =>
			[...fold(INITIAL_ELIGIBILITY, log.slice(0, upTo), eligibilityReducer)].sort();

		expect(at(0)).toEqual([]);
		expect(at(1)).toEqual(['p-1']);
		expect(at(2)).toEqual(['p-1', 'p-2']);
		expect(at(3)).toEqual(['p-2']);
		expect(at(4)).toEqual(['p-2', 'p-3']);
	});

	it('rebuilds idempotently — replaying the whole log twice converges', () => {
		const log = [setEvent(1, 'p-1', false, true), setEvent(2, 'p-2', false, true)];
		const once = fold(INITIAL_ELIGIBILITY, log, eligibilityReducer);
		const twice = fold(once, log, eligibilityReducer);
		const rebuilt = fold(INITIAL_ELIGIBILITY, log, eligibilityReducer);
		expect([...twice].sort()).toEqual([...once].sort());
		expect([...rebuilt].sort()).toEqual([...once].sort());
	});

	it('never mutates the state it is handed', () => {
		const start = fold(INITIAL_ELIGIBILITY, [setEvent(1, 'p-1', false, true)], eligibilityReducer);
		fold(start, [setEvent(2, 'p-2', false, true)], eligibilityReducer);
		expect([...start]).toEqual(['p-1']);
		// And the shared initial state is not a live object a fold can grow.
		expect([...INITIAL_ELIGIBILITY]).toEqual([]);
	});

	it('ignores a malformed payload rather than making the projection unrebuildable', () => {
		// An insert-only log cannot be corrected in place, so one bad historical
		// row must never stop the whole projection from being rebuilt.
		const state = fold(
			INITIAL_ELIGIBILITY,
			[
				event(1, MINOR_LEAGUE_ELIGIBILITY_SET, null),
				event(2, MINOR_LEAGUE_ELIGIBILITY_SET, { fantraxPlayerId: 'p-1' }),
				event(3, MINOR_LEAGUE_ELIGIBILITY_SET, { after: true }),
				setEvent(4, 'p-9', false, true)
			],
			eligibilityReducer
		);
		expect([...state]).toEqual(['p-9']);
	});
});

describe('planEligibilityChanges', () => {
	it('plans one change per Player whose value actually moves', () => {
		const plan = planEligibilityChanges(POOL, ['p-1', 'p-3'], true);
		expect(plan.changes).toEqual([
			{ fantraxPlayerId: 'p-1', playerName: 'Alice', before: false, after: true },
			{ fantraxPlayerId: 'p-3', playerName: 'Carla', before: false, after: true }
		]);
		expect(plan.unchanged).toEqual([]);
		expect(plan.unknownIds).toEqual([]);
	});

	it('reports a no-op as unchanged and plans no change for it', () => {
		const plan = planEligibilityChanges(POOL, ['p-2'], true);
		expect(plan.changes).toEqual([]);
		expect(plan.unchanged).toEqual([
			{ fantraxPlayerId: 'p-2', playerName: 'Bob', eligible: true }
		]);
	});

	it('splits a bulk set into changes and no-ops', () => {
		const plan = planEligibilityChanges(POOL, ['p-1', 'p-2', 'p-3'], true);
		expect(plan.changes.map((change) => change.fantraxPlayerId)).toEqual(['p-1', 'p-3']);
		expect(plan.unchanged.map((player) => player.fantraxPlayerId)).toEqual(['p-2']);
	});

	it('unsets the eligible and leaves the already-ineligible unchanged', () => {
		const plan = planEligibilityChanges(POOL, ['p-1', 'p-2'], false);
		expect(plan.changes).toEqual([
			{ fantraxPlayerId: 'p-2', playerName: 'Bob', before: true, after: false }
		]);
		expect(plan.unchanged.map((player) => player.fantraxPlayerId)).toEqual(['p-1']);
	});

	it('names an id that is not in the pool, and never silently skips it', () => {
		const plan = planEligibilityChanges(POOL, ['p-1', 'ghost', 'p-2'], true);
		expect(plan.unknownIds).toEqual(['ghost']);
		expect(plan.changes.map((change) => change.fantraxPlayerId)).toEqual(['p-1']);
	});

	it('collapses a duplicate id to one entry', () => {
		const plan = planEligibilityChanges(POOL, ['p-1', 'p-1'], true);
		expect(plan.changes).toHaveLength(1);
	});

	it('orders changes by the pool, not by the order the form serialised them', () => {
		const plan = planEligibilityChanges(POOL, ['p-3', 'p-1'], true);
		expect(plan.changes.map((change) => change.playerName)).toEqual(['Alice', 'Carla']);
	});

	it('plans nothing at all for an empty selection', () => {
		const plan = planEligibilityChanges(POOL, [], true);
		expect(plan).toEqual({ changes: [], unchanged: [], unknownIds: [] });
	});
});

describe('the sentences, each with exactly one definition', () => {
	it('states the consequence in words in both directions, from one constant', () => {
		expect(eligibilityRowSentence('Alice', true)).toContain(ELIGIBILITY_CONSEQUENCE);
		expect(eligibilityRowSentence('Alice', false)).toContain(ELIGIBILITY_CONSEQUENCE);
		expect(ELIGIBILITY_CONSEQUENCE).toContain('$0 Cap Hit');
		// The two states are told apart by their words, not by a tick mark.
		expect(eligibilityRowSentence('Alice', true)).not.toBe(eligibilityRowSentence('Alice', false));
		expect(eligibilityRowSentence('Alice', false)).toContain('full Cap Hit');
		expect(eligibilityRowSentence('Alice', true)).toContain('Alice');
	});

	it('names the phase, the pooled Players, FR-35 and the rostered exception', () => {
		const detail = eligibilityRefusalDetail({
			kind: 'phase',
			phase: 'Auction',
			fantraxPlayerIds: ['p-1', 'p-2']
		});
		expect(detail).toContain('Auction');
		expect(detail).toContain('FR-35');
		// The refusal names WHICH Players caused it, never just a count.
		expect(detail).toContain('p-1');
		expect(detail).toContain('p-2');
		expect(detail).toContain('Free Agent pool');
		// And states the half that WOULD be accepted, so the gate is not a dead end.
		expect(detail).toContain('rostered Contract');
	});

	it('names every unknown id in the unknown-players refusal', () => {
		const detail = eligibilityRefusalDetail({
			kind: 'unknown_players',
			fantraxPlayerIds: ['ghost-1', 'ghost-2']
		});
		expect(detail).toContain('ghost-1');
		expect(detail).toContain('ghost-2');
		expect(detail).toContain('Nothing was written');
	});

	it('states the empty selection and the unbound actor', () => {
		expect(eligibilityRefusalDetail({ kind: 'empty_selection' })).toContain('no Player was selected');
		expect(eligibilityRefusalDetail({ kind: 'unbound_actor' })).toContain('not bound to a Team');
	});

	it('never apologises, exclaims or advises', () => {
		const every = [
			eligibilityRefusalDetail({ kind: 'phase', phase: 'Auction', fantraxPlayerIds: ['x'] }),
			eligibilityRefusalDetail({ kind: 'unknown_players', fantraxPlayerIds: ['x'] }),
			eligibilityRefusalDetail({ kind: 'empty_selection' }),
			eligibilityRefusalDetail({ kind: 'unbound_actor' }),
			eligibilityRowSentence('Alice', true),
			eligibilityRowSentence('Alice', false)
		];
		for (const sentence of every) {
			expect(sentence).not.toMatch(/!|sorry|please|unfortunately/i);
		}
	});

	it('names the Players a completed change moved and the ones it did not', () => {
		const plan = planEligibilityChanges(POOL, ['p-1', 'p-2', 'p-3'], true);
		const detail = eligibilityOutcomeDetail(plan, true);
		expect(detail).toContain('Alice');
		expect(detail).toContain('Carla');
		expect(detail).toContain('Bob');
		expect(detail).toContain('Unchanged');
		// Named, never counted.
		expect(detail).not.toMatch(/\b3 Players\b/);
	});

	it('states plainly when nothing changed at all', () => {
		const plan = planEligibilityChanges(POOL, ['p-2'], true);
		expect(eligibilityOutcomeDetail(plan, true)).toContain('No Player was set');
	});
});
