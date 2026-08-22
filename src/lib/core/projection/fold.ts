/**
 * The generic fold/rebuild reducer (AD-5).
 *
 * One function serves two jobs: folding the events a transaction just
 * appended onto an already-loaded projection state, and rebuilding a
 * projection from empty state by replaying the whole log. Both call sites
 * pass the same three arguments; only the volume of `events` differs, and
 * AD-5's "in-transaction fold and full rebuild are the same function" is
 * exactly that — one function, not two that are merely kept in sync.
 *
 * Ordering: always by `seq`, never by `occurredAt`. Under the single global
 * write lock (AD-6) a transaction queued on the lock can commit later while
 * holding an earlier `occurred_at`, so `seq` — assigned by the database in
 * commit order — is the only order that actually matches history. `seq`
 * arrives at this boundary as a string (see `AppendedEvent`), so the sort
 * compares via `BigInt` rather than `Number` or `<`, which would misorder
 * once `seq` exceeds `Number.MAX_SAFE_INTEGER`.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import type { AppendedEvent } from '../types.ts';

/** One event folded onto the state accumulated so far. */
export type Reducer<State> = (state: State, event: AppendedEvent) => State;

/**
 * Fold `events` onto `state`, in `seq` order.
 *
 * Deterministic and side-effect free: the same `state`, `events` and
 * `reducer` always produce the same result, whether `events` is the handful
 * a transaction just appended or the entire log replayed from empty state.
 * Folding the same `events` onto the same starting `state` twice converges
 * on the identical result — the whole of "replay is idempotent" for a pure
 * reduction with no side effects to duplicate.
 *
 * `events` is sorted on a copy; the caller's array is never mutated.
 */
export function fold<State>(
	state: State,
	events: readonly AppendedEvent[],
	reducer: Reducer<State>
): State {
	const ordered = [...events].sort((a, b) => {
		const left = BigInt(a.seq);
		const right = BigInt(b.seq);
		if (left < right) return -1;
		if (left > right) return 1;
		return 0;
	});
	return ordered.reduce(reducer, state);
}
