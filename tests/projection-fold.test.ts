import { describe, expect, it } from 'vitest';

import { fold } from '../src/lib/core/projection/fold.ts';
import type { AppendedEvent } from '../src/lib/core/types.ts';

/** Build a minimal, valid `AppendedEvent` — only `seq`/`type` usually matter. */
function event(seq: string, type: string, extra: Partial<AppendedEvent> = {}): AppendedEvent {
	return {
		seq,
		occurredAt: '2026-08-21T00:00:00.000Z',
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload: {},
		managerId: 'm-1',
		teamId: 't-1',
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null,
		...extra
	};
}

type CountState = { readonly count: number; readonly lastType: string | null };
const initial: CountState = { count: 0, lastType: null };
const reducer = (state: CountState, e: AppendedEvent): CountState => ({
	count: state.count + 1,
	lastType: e.type
});

describe('fold', () => {
	it('returns the initial state unchanged when there are no events', () => {
		expect(fold(initial, [], reducer)).toEqual(initial);
	});

	it('orders strictly by seq, never by occurredAt or array position', () => {
		const events = [
			event('3', 'C', { occurredAt: '2026-08-21T00:00:01.000Z' }),
			event('1', 'A', { occurredAt: '2026-08-21T00:00:03.000Z' }),
			event('2', 'B', { occurredAt: '2026-08-21T00:00:02.000Z' })
		];
		const seen: string[] = [];
		fold(initial, events, (state, e) => {
			seen.push(e.type);
			return state;
		});
		expect(seen).toEqual(['A', 'B', 'C']);
	});

	it('compares seq numerically via BigInt, not lexicographically', () => {
		// A string sort would put "10" before "9". seq crosses that boundary the
		// moment the log passes nine rows, which happens almost immediately.
		const events = [event('10', 'B'), event('9', 'A')];
		const seen: string[] = [];
		fold(initial, events, (state, e) => {
			seen.push(e.type);
			return state;
		});
		expect(seen).toEqual(['A', 'B']);
	});

	it('does not mutate the caller-supplied events array', () => {
		const events = [event('2', 'B'), event('1', 'A')];
		const originalOrder = events.map((e) => e.seq);
		fold(initial, events, reducer);
		expect(events.map((e) => e.seq)).toEqual(originalOrder);
	});

	it('a full rebuild from empty state converges on the same result as incremental in-transaction folding', () => {
		const all = [event('1', 'A'), event('2', 'B'), event('3', 'C')];

		const rebuilt = fold(initial, all, reducer);

		const afterFirstTwo = fold(initial, all.slice(0, 2), reducer);
		const incremental = fold(afterFirstTwo, all.slice(2), reducer);

		expect(incremental).toEqual(rebuilt);
		expect(rebuilt).toEqual({ count: 3, lastType: 'C' });
	});

	it('replay is idempotent: folding the same events from empty state twice converges identically', () => {
		const events = [event('1', 'A'), event('2', 'B')];
		const first = fold(initial, events, reducer);
		const second = fold(initial, events, reducer);
		expect(second).toEqual(first);
	});

	it('folds a single event onto a non-empty starting state', () => {
		const midway: CountState = { count: 5, lastType: 'X' };
		const result = fold(midway, [event('6', 'Y')], reducer);
		expect(result).toEqual({ count: 6, lastType: 'Y' });
	});
});
