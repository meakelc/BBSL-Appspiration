import { describe, expect, it } from 'vitest';

import { fold } from '../src/lib/core/projection/fold.ts';
import { INITIAL_PHASE, phaseReducer } from '../src/lib/core/projection/phase.ts';
import type { AppendedEvent } from '../src/lib/core/types.ts';

/** Build a minimal, valid `AppendedEvent` — only `seq`/`type` usually matter. */
function event(seq: string, type: string): AppendedEvent {
	return {
		seq,
		occurredAt: '2026-08-22T00:00:00.000Z',
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload: {},
		managerId: 'm-1',
		teamId: 't-1',
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

describe('INITIAL_PHASE', () => {
	it('is Setup — the correct answer with no events, not a placeholder', () => {
		expect(INITIAL_PHASE).toBe('Setup');
	});
});

describe('phaseReducer', () => {
	it('folds no events to Setup', () => {
		expect(fold(INITIAL_PHASE, [], phaseReducer)).toBe('Setup');
	});

	it('leaves the phase unchanged for an event type it does not recognise (the default case)', () => {
		// True today: no domain event type exists yet that transitions the
		// phase, so every type reaches `default` — this is the reducer's
		// correct behaviour, not an unfinished switch.
		const events = [event('1', 'SomeUnrelatedEvent'), event('2', 'AnotherOne')];
		expect(fold(INITIAL_PHASE, events, phaseReducer)).toBe('Setup');
	});

	it('leaves a non-initial starting state unchanged too, for the same reason', () => {
		// Exercises the reducer against a starting state other than
		// INITIAL_PHASE, so "unchanged" is proven rather than assumed to be
		// "always Setup" by coincidence.
		const events = [event('1', 'Whatever')];
		expect(fold('Auction', events, phaseReducer)).toBe('Auction');
	});

	it('a full rebuild from empty state converges on the same result as a genuinely incremental fold (AD-5)', () => {
		const all = [event('1', 'A'), event('2', 'B'), event('3', 'C')];

		const rebuilt = fold(INITIAL_PHASE, all, phaseReducer);

		const afterFirstTwo = fold(INITIAL_PHASE, all.slice(0, 2), phaseReducer);
		const incremental = fold(afterFirstTwo, all.slice(2), phaseReducer);

		expect(incremental).toBe(rebuilt);
		expect(rebuilt).toBe('Setup');
	});
});
